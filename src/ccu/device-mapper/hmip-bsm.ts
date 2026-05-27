/**
 * Device mapper for HmIP-BSM (Brand Switch and Meter) → Matter onOffLight/Outlet/Switch + ElectricalPowerMeasurement.
 *
 * NOTE: This file exists as a proof-of-concept / reference example for writing device mappers.
 * It is not strictly necessary: the HmIP-BSM is a mains-powered device that does not expose a
 * LOW_BAT datapoint, so the connection layer already sets `batteryPowered = false` without any
 * device mapper. The standard SWITCH channel mapper combined with `resolveChannelsForMatter` power-
 * meter merging would produce the correct endpoint on its own. This mapper can be kept as a
 * concrete example or removed once a more meaningful device mapper exists.
 *
 * The `resolveChannelsForMatter` step already pairs the SWITCH_VIRTUAL_RECEIVER channel with the
 * ENERGIE_METER_TRANSMITTER and sets `powerMeterChannelAddress` on the SWITCH channel, so this
 * device mapper delegates to the standard SWITCH channel mapper with the mains-powered flag forced.
 *
 * @file device-mapper/hmip-bsm.ts
 */

import { mapChannel as mapSwitchChannel } from '../channel-mapper/switch.js';
import { DeviceMapper } from '../types.js';

/**
 * Device mapper for HmIP-BSM.
 * Finds the resolved SWITCH channel and creates one endpoint with forced mains-powered classification.
 *
 * @type {DeviceMapper}
 */
export const mapDevice: DeviceMapper = (channels, vendorId, options) => {
  const switchChannel = channels.find((c) => c.type === 'SWITCH');
  if (!switchChannel) return [];

  // HmIP-BSM is always mains-powered — override any battery hint from the discovery layer.
  const endpoint = mapSwitchChannel(switchChannel, vendorId, { ...options, batteryPowered: false });
  return [endpoint];
};
