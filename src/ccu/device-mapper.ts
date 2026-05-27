/**
 * Maps Homematic channel types to Matterbridge endpoint instances.
 * Dispatches to per-channel-type mappers in `./channel-mapper/` and per-device-type mappers
 * in `./device-mapper/`. All public exports are preserved for backwards compatibility.
 *
 * @file device-mapper.ts
 */

import { MatterbridgeEndpoint } from 'matterbridge';

import { CHANNEL_MAPPERS, channelTypeToKey } from './channel-mapper/index.js';
import { DEVICE_MAPPERS, deviceTypeToKey } from './device-mapper/index.js';
import { CcuChannelInfo, ChannelMappingOptions, SUPPORTED_CHANNEL_TYPES, SupportedChannelType, SwitchMatterType } from './types.js';

export { channelTypeLabel } from './mapper-utils.js';
export { SUPPORTED_CHANNEL_TYPES } from './types.js';
export type { ChannelMappingOptions, SupportedChannelType, SwitchMatterType } from './types.js';

/**
 * HmIP transmitter/virtual-receiver channel type pairs.
 * For each TRANSMITTER channel found on a device, the first matching VIRTUAL_RECEIVER channel
 * with a higher channel index is selected and remapped to the canonical Matter-ready type.
 */
const HMIP_CHANNEL_PAIRS: Array<{ transmitter: string; receivers: string[]; matterType: SupportedChannelType }> = [
  { transmitter: 'SWITCH_TRANSMITTER', receivers: ['SWITCH_VIRTUAL_RECEIVER'], matterType: 'SWITCH' },
  { transmitter: 'DIMMER_TRANSMITTER', receivers: ['DIMMER_VIRTUAL_RECEIVER'], matterType: 'DIMMER' },
  {
    transmitter: 'BLIND_TRANSMITTER',
    // HmIP uses BLIND_VIRTUAL_RECEIVER (venetian) or SHUTTER_VIRTUAL_RECEIVER (simple shutter).
    // Some CCU firmware variants report BLIND_VIRTUAL_TRANSCEIVER instead.
    receivers: ['BLIND_VIRTUAL_RECEIVER', 'BLIND_VIRTUAL_TRANSCEIVER', 'SHUTTER_VIRTUAL_RECEIVER'],
    matterType: 'BLIND',
  },
];

/** HmIP virtual-receiver channel types that should be exposed as BLIND even without a BLIND_TRANSMITTER companion. */
const STANDALONE_BLIND_VIRTUAL_TYPES = ['BLIND_VIRTUAL_RECEIVER', 'BLIND_VIRTUAL_TRANSCEIVER', 'SHUTTER_VIRTUAL_RECEIVER'] as const;

/**
 * Select the channels that should be exposed as Matter devices from the full CCU channel list.
 *
 * For HmIP devices that use virtual-receiver channels (e.g. HmIP-BSM, HmIP-BDT), each
 * `SWITCH_TRANSMITTER` / `DIMMER_TRANSMITTER` channel is paired with the first
 * `SWITCH_VIRTUAL_RECEIVER` / `DIMMER_VIRTUAL_RECEIVER` channel that follows it (by
 * channel index).  The returned channel has its `type` remapped to `'SWITCH'` or
 * `'DIMMER'` so downstream handling is identical to classic BidCos devices.
 *
 * Classic BidCos channels (`SWITCH`, `DIMMER`, `SHUTTER_CONTACT`, …) pass through unchanged.
 *
 * @param {CcuChannelInfo[]} allChannels All channels as returned by CCU discovery.
 * @returns {CcuChannelInfo[]} Channels ready for Matter endpoint creation.
 */
export function resolveChannelsForMatter(allChannels: CcuChannelInfo[]): CcuChannelInfo[] {
  // Group by device address, sorted by channel index ascending.
  const byDevice = new Map<string, CcuChannelInfo[]>();
  for (const ch of allChannels) {
    const group = byDevice.get(ch.deviceAddress) ?? [];
    group.push(ch);
    byDevice.set(ch.deviceAddress, group);
  }
  for (const group of byDevice.values()) {
    group.sort((a, b) => a.channelIndex - b.channelIndex);
  }

  const result: CcuChannelInfo[] = [];

  for (const deviceChannels of byDevice.values()) {
    // Collect all channel addresses handled by HmIP pairing so they are not passed through as-is.
    const hmipHandled = new Set<string>();
    const hmipSelected: CcuChannelInfo[] = [];

    for (const pair of HMIP_CHANNEL_PAIRS) {
      const transmitters = deviceChannels.filter((c) => c.type === pair.transmitter);
      if (transmitters.length === 0) continue;

      // Mark all transmitter and receiver channels as handled.
      for (const ch of deviceChannels) {
        if (ch.type === pair.transmitter || pair.receivers.includes(ch.type)) {
          hmipHandled.add(ch.address);
        }
      }

      for (const tx of transmitters) {
        // The first receiver channel whose type is in the accepted list and index > transmitter.
        const rx = deviceChannels.find((c) => pair.receivers.includes(c.type) && c.channelIndex > tx.channelIndex);
        if (!rx) continue;
        // BLIND_VIRTUAL_RECEIVER indicates venetian blind with tilt (LEVEL_2) support.
        const tiltSupported = pair.matterType === 'BLIND' && rx.type === 'BLIND_VIRTUAL_RECEIVER';
        hmipSelected.push({ ...rx, type: pair.matterType, tiltSupported });
      }
    }

    // Handle standalone HmIP blind virtual channels (devices with no BLIND_TRANSMITTER).
    // HmIP exposes 3 virtual channels per physical output; take the first of each block of 3.
    const unhandledBlinds = deviceChannels
      .filter((c) => (STANDALONE_BLIND_VIRTUAL_TYPES as readonly string[]).includes(c.type) && !hmipHandled.has(c.address))
      .sort((a, b) => a.channelIndex - b.channelIndex);

    let blindSlot = 0;
    for (const ch of unhandledBlinds) {
      hmipHandled.add(ch.address);
      if (blindSlot === 0) {
        const tiltSupported = ch.type === 'BLIND_VIRTUAL_RECEIVER';
        hmipSelected.push({ ...ch, type: 'BLIND' as SupportedChannelType, tiltSupported });
      }
      blindSlot = (blindSlot + 1) % 3;
    }

    // Pass through all non-HmIP-handled channels, separating power meter channels out for merging.
    const passthroughChannels: CcuChannelInfo[] = [];
    const powerMeterCandidates: CcuChannelInfo[] = [];
    for (const ch of deviceChannels) {
      if (hmipHandled.has(ch.address)) continue;
      // KEY_TRANSCEIVER channels on VirtualDevices are virtual echoes of physical key presses.
      if (ch.type === 'KEY_TRANSCEIVER' && ch.interfaceName === 'VirtualDevices') continue;
      // HmIP-HEATING channel 5 on VirtualDevices is an internal control channel, not a real device.
      if (ch.deviceType === 'HmIP-HEATING' && ch.channelIndex === 5 && ch.interfaceName === 'VirtualDevices') continue;
      if (ch.type === 'POWERMETER' || ch.type === 'ENERGIE_METER_TRANSMITTER') {
        powerMeterCandidates.push(ch);
      } else {
        passthroughChannels.push(ch);
      }
    }

    // Merge a power meter channel into the co-located SWITCH endpoint when exactly one switch exists.
    // The channel address is stored on the SWITCH channel so module.ts can register event routing.
    if (powerMeterCandidates.length > 0) {
      const switchChannels = [...passthroughChannels, ...hmipSelected].filter((c) => c.type === 'SWITCH');
      if (switchChannels.length === 1) {
        const pmCh = powerMeterCandidates[0];
        switchChannels[0].powerMeterChannelAddress = pmCh.address;
        switchChannels[0].powerMeterIsHmIP = pmCh.type === 'ENERGIE_METER_TRANSMITTER';
      }
    }

    result.push(...passthroughChannels);

    // Append the selected HmIP virtual-receiver channels (remapped type).
    result.push(...hmipSelected);
  }

  return result;
}

/**
 * Infer the best Matter device type for a SWITCH channel from the ReGa channel name.
 * Returns `undefined` when no keyword matches so the caller can fall back to the default ('light').
 *
 * @param {string | undefined} name ReGa display name of the channel.
 * @returns {SwitchMatterType | undefined} Inferred type, or `undefined` when name gives no signal.
 */
export function inferSwitchMatterTypeFromName(name: string | undefined): SwitchMatterType | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  if (['standby', 'plug', 'steckdose', 'buchse'].some((kw) => lower.includes(kw))) return 'outlet';
  if (['licht', 'light', 'lampe', 'lamp', 'leuchte'].some((kw) => lower.includes(kw))) return 'light';
  return undefined;
}

/**
 * Return whether a channel type string is handled by this plugin.
 *
 * @param {string} type Raw Homematic channel type.
 * @returns {boolean} `true` when the type has a Matter mapping.
 */
export function isSupportedChannelType(type: string): type is SupportedChannelType {
  return (SUPPORTED_CHANNEL_TYPES as readonly string[]).includes(type);
}

/**
 * Return the device mapper registered for the given Homematic device type, if any.
 * The lookup is case-insensitive and sanitizes the device type the same way as file names.
 *
 * @param {string} deviceType Raw Homematic device type, e.g. `'HmIP-BSM'`.
 * @returns {import('./types.js').DeviceMapper | undefined} Registered device mapper or undefined.
 */
export function getDeviceMapper(deviceType: string): import('./types.js').DeviceMapper | undefined {
  return DEVICE_MAPPERS[deviceTypeToKey(deviceType)];
}

/**
 * Create a configured `MatterbridgeEndpoint` for a supported Homematic channel.
 * Dispatches to the registered `ChannelMapper` for `channel.type`.
 *
 * @param {CcuChannelInfo & { type: SupportedChannelType }} channel Channel with a supported type.
 * @param {number} vendorId Matter vendor ID from the Matterbridge aggregator.
 * @param {ChannelMappingOptions} [options] Optional mapping overrides.
 * @returns {MatterbridgeEndpoint} Fully initialized endpoint ready to register.
 */
export function createEndpointForChannel(channel: CcuChannelInfo & { type: SupportedChannelType }, vendorId: number, options: ChannelMappingOptions = {}): MatterbridgeEndpoint {
  const key = channelTypeToKey(channel.type);
  const mapper = CHANNEL_MAPPERS[key];
  if (!mapper) {
    throw new Error(`No channel mapper registered for type: ${channel.type}`);
  }
  return mapper(channel, vendorId, options);
}
