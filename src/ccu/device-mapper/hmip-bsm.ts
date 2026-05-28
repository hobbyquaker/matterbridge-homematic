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
 * This device mapper receives **raw** CCU channel types and performs the pairing itself:
 *
 * ```
 * SWITCH_TRANSMITTER         — physical relay state (NONE)
 * SWITCH_VIRTUAL_RECEIVER    — control endpoint (RECEIVER) ← used, first VR after the transmitter
 * ENERGIE_METER_TRANSMITTER  — energy/power metering channel (SENDER)
 * ```
 *
 * The first `SWITCH_VIRTUAL_RECEIVER` following the `SWITCH_TRANSMITTER` is used as the control
 * channel. Its type is normalized to `SWITCH` before being passed to `mapSwitchChannel`.
 * The `ENERGIE_METER_TRANSMITTER` address is attached to the channel as `powerMeterChannelAddress`
 * so the standard switch mapper adds an `ElectricalPowerMeasurement` cluster.
 *
 * @file device-mapper/hmip-bsm.ts
 */

import { mapChannel as mapSwitchChannel } from '../channel-mapper/switch.js';
import { CcuChannelInfo, DeviceMapper } from '../types.js';

/**
 * Device mapper for HmIP-BSM.
 *
 * Pairs the `SWITCH_TRANSMITTER` with the first `SWITCH_VIRTUAL_RECEIVER` that follows it,
 * links the `ENERGIE_METER_TRANSMITTER` for power measurement, and creates one endpoint with
 * forced mains-powered classification.
 *
 * @type {DeviceMapper}
 */
export const mapDevice: DeviceMapper = (channels, vendorId, options) => {
  const tx = channels.find((c) => c.type === 'SWITCH_TRANSMITTER');
  if (!tx) return [];
  const rx = channels.find((c) => c.type === 'SWITCH_VIRTUAL_RECEIVER' && c.channelIndex > tx.channelIndex);
  if (!rx) return [];

  // Link the co-located power meter so mapSwitchChannel adds an ElectricalPowerMeasurement cluster.
  const powerMeter = channels.find((c) => c.type === 'ENERGIE_METER_TRANSMITTER');
  // Normalize to the canonical SWITCH type expected by wireChannelEndpoint and mapSwitchChannel.
  const switchChannel: CcuChannelInfo = {
    ...rx,
    type: 'SWITCH',
    powerMeterChannelAddress: powerMeter?.address ?? rx.powerMeterChannelAddress,
  };

  // HmIP-BSM is always mains-powered — override any battery hint from the discovery layer.
  const endpoint = mapSwitchChannel(switchChannel, vendorId, { ...options, batteryPowered: false });
  return [{ endpoint, channels: [switchChannel] }];
};
