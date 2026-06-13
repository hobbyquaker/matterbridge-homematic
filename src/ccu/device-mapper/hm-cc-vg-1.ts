/**
 * Device mapper for HM-CC-VG-1 (Homematic Virtual Group thermostat).
 *
 * The HM-CC-VG-1 is a virtual device on the VirtualDevices interface that groups one or more
 * HM-CC-RT-DN radiator thermostats. It exposes two channels:
 *
 * ```
 * ch1  CLIMATECONTROL_RT_TRANSCEIVER  — thermostat control
 *        ACTUAL_TEMPERATURE  float  read+event   measured temperature
 *        SET_TEMPERATURE     float  read+write+event  current setpoint
 *        MANU_MODE           float  write-only   write to switch to manual mode + set setpoint
 *        CONTROL_MODE        enum   read+event   0=auto 1=manu 2=party 3=boost
 * ch2  SHUTTER_CONTACT                — window-open sensor (open contact suppresses heating)
 *        STATE               bool   read+event
 * ```
 *
 * This mapper creates two **independent** Matter endpoints — a thermostat and a contact sensor —
 * rather than a composed device. Both are registered separately in Matterbridge.
 *
 * Wiring note: `wireChannelEndpoint` detects `CLIMATECONTROL_RT_TRANSCEIVER` and uses
 * `MANU_MODE` for outgoing setpoint writes (which simultaneously switches the device into manual
 * mode). Incoming `SET_TEMPERATURE` events are handled as setpoint updates in
 * `handleRpcEventThermostat`.
 *
 * @file device-mapper/hm-cc-vg-1.ts
 */

import { MatterbridgeEndpoint, humiditySensor, thermostatDevice } from 'matterbridge';

import { mapChannel as mapShutterContactChannel } from '../channel-mapper/shutter-contact.js';
import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { DeviceMapper, MappedDeviceEndpoint, MapperOptionDescriptor } from '../types.js';

/**
 * User-configurable options declared by this mapper.
 * `exposeHumidity` adds RelativeHumidityMeasurement to the thermostat endpoint
 * (the HM-CC-VG-1 aggregates humidity from the wall thermostats in the group).
 */
export const OPTIONS: readonly MapperOptionDescriptor[] = [{ key: 'exposeHumidity', type: 'boolean', channelTypes: ['CLIMATECONTROL_RT_TRANSCEIVER'] }];

/**
 * Device mapper for HM-CC-VG-1 virtual group thermostats.
 *
 * Returns up to two endpoints:
 * - A `thermostatDevice` endpoint wired to the `CLIMATECONTROL_RT_TRANSCEIVER` channel.
 * - A `contactSensor` endpoint wired to the `SHUTTER_CONTACT` channel (if present).
 *
 * Returns `[]` when no `CLIMATECONTROL_RT_TRANSCEIVER` channel is found (device suppressed).
 *
 * @type {DeviceMapper}
 */
export const mapDevice: DeviceMapper = (channels, vendorId, options) => {
  const thermostatChannel = channels.find((c) => c.type === 'CLIMATECONTROL_RT_TRANSCEIVER');
  if (!thermostatChannel) return [];

  const contactChannel = channels.find((c) => c.type === 'SHUTTER_CONTACT');

  const results: MappedDeviceEndpoint[] = [];

  // ── Thermostat endpoint ──────────────────────────────────────────────────────────────────────
  const deviceTypes = options.exposeHumidity === true ? [thermostatDevice, humiditySensor] : thermostatDevice;
  const ep = new MatterbridgeEndpoint(deviceTypes, { id: buildEndpointId(thermostatChannel) })
    .createDefaultBridgedDeviceBasicInformationClusterServer(
      buildDisplayName(thermostatChannel),
      buildSerialNumber(thermostatChannel, 'CLIMATECONTROL_RT_TRANSCEIVER'),
      vendorId,
      'Homematic',
      buildModel(thermostatChannel),
    )
    .createDefaultHeatingThermostatClusterServer(23, 21);

  if (options.exposeHumidity === true) {
    ep.createDefaultRelativeHumidityMeasurementClusterServer();
  }

  results.push({
    endpoint: finalizeEndpoint(ep, { ...options, batteryPowered: thermostatChannel.batteryPowered }),
    channels: [thermostatChannel],
  });

  // ── Contact sensor endpoint (window-open) ────────────────────────────────────────────────────
  if (contactChannel) {
    results.push({
      endpoint: mapShutterContactChannel(contactChannel, vendorId, { ...options, batteryPowered: contactChannel.batteryPowered }),
      channels: [contactChannel],
    });
  }

  return results;
};
