/**
 * Device mapper for HmIP-WTH / WTH-2 / WTH-B wall thermostats.
 *
 * The HEATING_CLIMATECONTROL_TRANSCEIVER channel on these devices carries both temperature /
 * setpoint data and a HUMIDITY datapoint. This device mapper combines both into a single Matter
 * thermostat endpoint, optionally adding the RelativeHumidityMeasurement cluster.
 *
 * Declaring `thermostat` before `humiditySensor` in the device type array ensures the
 * device is always displayed as a thermostat in Matter controllers such as Apple Home.
 *
 * @file device-mapper/hmip-wth.ts
 */

import { humiditySensor, MatterbridgeEndpoint, thermostat } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { DeviceMapper, MapperOptionDescriptor } from '../types.js';

/**
 * User-configurable options declared by this mapper (shared by all WTH / STHD / STH / BWTH variants).
 * `exposeHumidity` adds RelativeHumidityMeasurement to the thermostat endpoint.
 */
export const OPTIONS: readonly MapperOptionDescriptor[] = [{ key: 'exposeHumidity', type: 'boolean' }];

/**
 * Device mapper for HmIP-WTH, HmIP-WTH-2, HmIP-WTH-B, HmIP-STHD, HmIP-STH, and related variants.
 * Returns a single thermostat endpoint. When `options.exposeHumidity` is not explicitly
 * `false`, both the `humiditySensor` device type and the RelativeHumidityMeasurement cluster are
 * added. Declaring `thermostat` first ensures Matter controllers (e.g. Apple Home) always
 * render the accessory as a thermostat rather than a humidity sensor.
 *
 * @type {DeviceMapper}
 */
export const mapDevice: DeviceMapper = (channels, vendorId, options) => {
  const heatingChannel = channels.find((c) => c.type === 'HEATING_CLIMATECONTROL_TRANSCEIVER');
  if (!heatingChannel) return [];

  const id = buildEndpointId(heatingChannel);
  const displayName = buildDisplayName(heatingChannel);
  const serialNumber = buildSerialNumber(heatingChannel, 'HEATING_CLIMATECONTROL_TRANSCEIVER');
  const model = buildModel(heatingChannel);

  const exposeHumidity = options.exposeHumidity !== false;

  const ep = new MatterbridgeEndpoint(exposeHumidity ? [thermostat, humiditySensor] : thermostat, { id })
    .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
    .createDefaultHeatingThermostatClusterServer(23, 21);

  if (exposeHumidity) {
    ep.createDefaultRelativeHumidityMeasurementClusterServer();
  }

  return [
    {
      endpoint: finalizeEndpoint(ep, { ...options, batteryPowered: heatingChannel.batteryPowered }),
      channels: [heatingChannel],
    },
  ];
};
