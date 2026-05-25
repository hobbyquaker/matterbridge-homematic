/**
 * Maps Homematic channel types to Matterbridge endpoint instances.
 *
 * @file device-mapper.ts
 */

import { contactSensor, dimmableLight, MatterbridgeEndpoint, onOffLight, onOffOutlet, onOffSwitch } from 'matterbridge';

import { CcuChannelInfo, SwitchMatterType } from './types.js';

/** Homematic channel types that are mapped to Matter devices by this plugin. */
export const SUPPORTED_CHANNEL_TYPES = ['DIMMER', 'SWITCH', 'SHUTTER_CONTACT'] as const;

/** Union of the Homematic channel type strings that this plugin supports. */
export type SupportedChannelType = (typeof SUPPORTED_CHANNEL_TYPES)[number];

/**
 * HmIP transmitter/virtual-receiver channel type pairs.
 * For each TRANSMITTER channel found on a device, the first VIRTUAL_RECEIVER channel
 * with a higher channel index is selected and remapped to the canonical Matter-ready type.
 */
const HMIP_CHANNEL_PAIRS: Array<{ transmitter: string; receiver: string; matterType: SupportedChannelType }> = [
  { transmitter: 'SWITCH_TRANSMITTER', receiver: 'SWITCH_VIRTUAL_RECEIVER', matterType: 'SWITCH' },
  { transmitter: 'DIMMER_TRANSMITTER', receiver: 'DIMMER_VIRTUAL_RECEIVER', matterType: 'DIMMER' },
];

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
        if (ch.type === pair.transmitter || ch.type === pair.receiver) {
          hmipHandled.add(ch.address);
        }
      }

      for (const tx of transmitters) {
        // The first receiver channel whose index is greater than the transmitter's.
        const rx = deviceChannels.find((c) => c.type === pair.receiver && c.channelIndex > tx.channelIndex);
        if (!rx) continue;
        // Return a copy with the type remapped to the canonical Matter-ready type.
        hmipSelected.push({ ...rx, type: pair.matterType });
      }
    }

    // Pass through all non-HmIP-handled channels unchanged.
    for (const ch of deviceChannels) {
      if (!hmipHandled.has(ch.address)) {
        result.push(ch);
      }
    }

    // Append the selected HmIP virtual-receiver channels (remapped type).
    result.push(...hmipSelected);
  }

  return result;
}

export interface ChannelMappingOptions {
  switchMatterType?: SwitchMatterType;
  batteryPowered?: boolean;
}

/**
 * Example function to map a device endpoint with options.
 *
 * @param {MatterbridgeEndpoint} endpoint The Matterbridge endpoint instance to map.
 * @param {object} options Options for mapping the endpoint.
 * @returns {void} Returns nothing.
 */
function finalizeEndpoint(endpoint: MatterbridgeEndpoint, options: ChannelMappingOptions): MatterbridgeEndpoint {
  if (options.batteryPowered) {
    endpoint.createDefaultPowerSourceReplaceableBatteryClusterServer(100);
  } else {
    endpoint.createDefaultPowerSourceWiredClusterServer();
  }
  return endpoint.addRequiredClusterServers();
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
 * Create a configured `MatterbridgeEndpoint` for a supported Homematic channel.
 *
 * @param {CcuChannelInfo & { type: SupportedChannelType }} channel Channel with a supported type.
 * @param {number} vendorId Matter vendor ID from the Matterbridge aggregator.
 * @param {ChannelMappingOptions} [options] Optional mapping overrides.
 * @returns {MatterbridgeEndpoint} Fully initialized endpoint ready to register.
 */
export function createEndpointForChannel(channel: CcuChannelInfo & { type: SupportedChannelType }, vendorId: number, options: ChannelMappingOptions = {}): MatterbridgeEndpoint {
  const displayName = channel.name ?? channel.address;
  const serialNumber = channel.address;
  // Keep endpoint id stable and filesystem-safe independent of serial format.
  const id = `hm-${channel.address.replace(':', '-')}`;

  switch (channel.type) {
    case 'DIMMER':
      return finalizeEndpoint(
        new MatterbridgeEndpoint(dimmableLight, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
          displayName,
          serialNumber,
          vendorId,
          'Homematic',
          'Homematic Dimmer',
        ),
        { ...options, batteryPowered: channel.batteryPowered },
      );

    case 'SWITCH':
      switch (options.switchMatterType ?? 'light') {
        case 'outlet':
          return finalizeEndpoint(
            new MatterbridgeEndpoint(onOffOutlet, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
              displayName,
              serialNumber,
              vendorId,
              'Homematic',
              'Homematic Switch Outlet',
            ),
            { ...options, batteryPowered: channel.batteryPowered },
          );
        case 'switch':
          return finalizeEndpoint(
            new MatterbridgeEndpoint(onOffSwitch, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
              displayName,
              serialNumber,
              vendorId,
              'Homematic',
              'Homematic Switch Relay',
            ),
            { ...options, batteryPowered: channel.batteryPowered },
          );
        case 'light':
        default:
          return finalizeEndpoint(
            new MatterbridgeEndpoint(onOffLight, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
              displayName,
              serialNumber,
              vendorId,
              'Homematic',
              'Homematic Switch Light',
            ),
            { ...options, batteryPowered: channel.batteryPowered },
          );
      }

    case 'SHUTTER_CONTACT':
      return finalizeEndpoint(
        new MatterbridgeEndpoint(contactSensor, { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Shutter Contact')
          .createDefaultBooleanStateClusterServer(false),
        { ...options, batteryPowered: channel.batteryPowered },
      );
  }
}
