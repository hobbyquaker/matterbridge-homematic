/**
 * Device mapper for HmIP-BSM (Brand Switch and Meter) → Matter onOffLight/Outlet/Switch + ElectricalPowerMeasurement.
 *
 * HmIP-BSM is always mains-powered and always has a co-located energy meter channel.
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
