/**
 * Device mapper for HmIP-DRSI4 (DIN Rail Switch Interface, 4 channels) and related
 * multi-channel switch actuators (HmIP-DRSI1, MOD-OC8).
 *
 * **Multi-endpoint pattern** — this mapper is the canonical example for producing more than
 * one `MappedDeviceEndpoint` from a single physical device. The HmIP-DRSI4 exposes four
 * independent output channels, each of which must become its own Matter on/off device:
 *
 * ```
 * HmIP-DRSI4 (one CCU device)
 *   SWITCH ch 1  →  MappedDeviceEndpoint { endpoint, channels: [ch1] }
 *   SWITCH ch 2  →  MappedDeviceEndpoint { endpoint, channels: [ch2] }
 *   SWITCH ch 3  →  MappedDeviceEndpoint { endpoint, channels: [ch3] }
 *   SWITCH ch 4  →  MappedDeviceEndpoint { endpoint, channels: [ch4] }
 * ```
 *
 * `resolveChannelsForMatter` already pairs the `SWITCH_TRANSMITTER` channels with their
 * `SWITCH_VIRTUAL_RECEIVER` counterparts and renames them to type `SWITCH`, so by the time
 * this mapper is called, each output is already a canonical `SWITCH` channel.
 *
 * The device is always mains-powered; `batteryPowered` is forced to `false` regardless of
 * what the discovery layer inferred.
 *
 * The per-channel `switchMatterType` option (from user overrides) is respected so that
 * individual outputs can still be exposed as `'light'`, `'outlet'`, or `'switch'`.
 *
 * @file device-mapper/hmip-drsi4.ts
 */

import { mapChannel as mapSwitchChannel } from '../channel-mapper/switch.js';
import { DeviceMapper } from '../types.js';

/**
 * Device mapper for multi-channel DIN rail switch actuators (HmIP-DRSI4 family).
 *
 * Returns one {@link MappedDeviceEndpoint} per resolved SWITCH channel — one per output.
 * Returns an empty array when no SWITCH channels are present, suppressing the device.
 *
 * @type {DeviceMapper}
 */
export const mapDevice: DeviceMapper = (channels, vendorId, options) => {
  const switchChannels = channels.filter((c) => c.type === 'SWITCH');
  if (switchChannels.length === 0) return [];

  // Each switch output becomes an independent Matter endpoint.
  // batteryPowered is forced to false: DIN rail switch actuators are always mains-powered.
  return switchChannels.map((channel) => ({
    endpoint: mapSwitchChannel(channel, vendorId, { ...options, batteryPowered: false }),
    channels: [channel],
  }));
};
