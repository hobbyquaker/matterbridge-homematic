/**
 * Device mapper for HmIP-DRSI4 (DIN Rail Switch Interface, 4 channels) and related
 * multi-channel switch actuators (HmIP-DRSI1, MOD-OC8).
 *
 * **Multi-endpoint pattern** — this mapper is the canonical example for producing more than
 * one `MappedDeviceEndpoint` from a single physical device. The HmIP-DRSI4 exposes four
 * independent output channels, each of which becomes its own Matter on/off device.
 *
 * ## Real HmIP-DRSI4 channel structure
 *
 * ```
 * ch0   MAINTENANCE                        — housekeeping; exposes ACTUAL_TEMPERATURE datapoint
 * ch1   MULTI_MODE_INPUT_TRANSMITTER       — input button 1 (SENDER)
 * ch2   MULTI_MODE_INPUT_TRANSMITTER       — input button 2 (SENDER)
 * ch3   MULTI_MODE_INPUT_TRANSMITTER       — input button 3 (SENDER)
 * ch4   MULTI_MODE_INPUT_TRANSMITTER       — input button 4 (SENDER)
 * ch5   SWITCH_TRANSMITTER                 — output 1 physical relay state (NONE)
 * ch6   SWITCH_VIRTUAL_RECEIVER            — output 1 control ch, 1st VR (RECEIVER) ← used
 * ch7   SWITCH_VIRTUAL_RECEIVER            — output 1 control ch, 2nd VR (RECEIVER)
 * ch8   SWITCH_VIRTUAL_RECEIVER            — output 1 control ch, 3rd VR (RECEIVER)
 * ch9   SWITCH_TRANSMITTER                 — output 2 physical relay state (NONE)
 * ch10  SWITCH_VIRTUAL_RECEIVER            — output 2 control ch, 1st VR (RECEIVER) ← used
 * ch11  SWITCH_VIRTUAL_RECEIVER            — output 2 control ch, 2nd VR (RECEIVER)
 * ch12  SWITCH_VIRTUAL_RECEIVER            — output 2 control ch, 3rd VR (RECEIVER)
 * ch13  SWITCH_TRANSMITTER                 — output 3 physical relay state (NONE)
 * ch14  SWITCH_VIRTUAL_RECEIVER            — output 3 control ch, 1st VR (RECEIVER) ← used
 * ch15  SWITCH_VIRTUAL_RECEIVER            — output 3 control ch, 2nd VR (RECEIVER)
 * ch16  SWITCH_VIRTUAL_RECEIVER            — output 3 control ch, 3rd VR (RECEIVER)
 * ch17  SWITCH_TRANSMITTER                 — output 4 physical relay state (NONE)
 * ch18  SWITCH_VIRTUAL_RECEIVER            — output 4 control ch, 1st VR (RECEIVER) ← used
 * ch19  SWITCH_VIRTUAL_RECEIVER            — output 4 control ch, 2nd VR (RECEIVER)
 * ch20  SWITCH_VIRTUAL_RECEIVER            — output 4 control ch, 3rd VR (RECEIVER)
 * ch21  SWITCH_WEEK_PROFILE                — weekly timer profile (not exposed)
 * ```
 *
 * Each output has exactly one `SWITCH_TRANSMITTER` (reports the physical relay state) followed
 * by three `SWITCH_VIRTUAL_RECEIVER` channels (the addressable control endpoints). We pair each
 * transmitter with the first virtual receiver that follows it — that channel carries the
 * user-assigned name (e.g. "Lichterkette Garten") and is what CCU programs and automations
 * typically address.
 *
 * The paired `SWITCH_VIRTUAL_RECEIVER` is re-typed to `SWITCH` before being returned so that
 * `wireChannelEndpoint` and `mapSwitchChannel` can process it with the standard switch logic.
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
import { CcuChannelInfo, DeviceMapper, MappedDeviceEndpoint } from '../types.js';

/**
 * Device mapper for multi-channel DIN rail switch actuators (HmIP-DRSI4 family).
 *
 * Pairs each `SWITCH_TRANSMITTER` with the first `SWITCH_VIRTUAL_RECEIVER` that follows it
 * (by channel index) and returns one {@link MappedDeviceEndpoint} per output.
 * Returns an empty array when no `SWITCH_TRANSMITTER` channels are present, suppressing
 * the device entirely.
 *
 * @type {DeviceMapper}
 */
export const mapDevice: DeviceMapper = (channels, vendorId, options) => {
  // Each output consists of one SWITCH_TRANSMITTER (physical relay state) followed by three
  // SWITCH_VIRTUAL_RECEIVER channels. We use the first virtual receiver after each transmitter
  // — it carries the user-assigned name and is the canonical control endpoint.

  // Collect the state channels (one per output), in ascending channel index order.
  const transmitters = channels.filter((c) => c.type === 'SWITCH_TRANSMITTER').sort((a, b) => a.channelIndex - b.channelIndex);

  if (transmitters.length === 0) return [];

  // The MAINTENANCE channel (ch0) carries an ACTUAL_TEMPERATURE datapoint for the device’s
  // internal temperature. Attach its address to every switch endpoint so the switch mapper
  // adds a TemperatureMeasurement cluster and wireChannelEndpoint routes events to all outputs.
  const maintenanceChannel = channels.find((c) => c.type === 'MAINTENANCE');

  const results: MappedDeviceEndpoint[] = [];

  for (const tx of transmitters) {
    // Find the first SWITCH_VIRTUAL_RECEIVER that comes after this transmitter.
    const rx = channels.find((c) => c.type === 'SWITCH_VIRTUAL_RECEIVER' && c.channelIndex > tx.channelIndex);
    if (!rx) continue;

    // Normalize to the canonical SWITCH type expected by wireChannelEndpoint and mapSwitchChannel.
    // Carry the MAINTENANCE channel address so switch.ts adds a TemperatureMeasurement cluster
    // and wireChannelEndpoint registers the ch0 address → this endpoint for ACTUAL_TEMPERATURE events.
    const switchChannel: CcuChannelInfo = { ...rx, type: 'SWITCH', temperatureChannelAddress: maintenanceChannel?.address };
    // One MappedDeviceEndpoint per output: the endpoint is the Matter on/off device,
    // and channels contains the single switch channel that wireChannelEndpoint will wire up.
    results.push({
      endpoint: mapSwitchChannel(switchChannel, vendorId, { ...options, batteryPowered: false }),
      channels: [switchChannel],
    });
  }

  return results;
};
