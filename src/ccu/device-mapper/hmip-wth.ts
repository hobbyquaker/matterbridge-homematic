/**
 * Device mapper for HmIP-WTH / WTH-2 / WTH-B wall thermostats.
 *
 * The HEATING_CLIMATECONTROL_TRANSCEIVER channel on these devices carries both temperature /
 * setpoint data and a HUMIDITY datapoint. This device mapper combines both into a single Matter
 * endpoint with the thermostatDevice + humiditySensor device types, so that Home.app shows them
 * as one device — matching the HomeKit experience.
 *
 * @file device-mapper/hmip-wth.ts
 */

import { humiditySensor, MatterbridgeEndpoint, thermostatDevice } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { DeviceMapper } from '../types.js';

/**
 * Device mapper for HmIP-WTH, HmIP-WTH-2, HmIP-WTH-B, HmIP-STHD, HmIP-STH, and related variants.
 * Returns a single endpoint combining thermostatDevice and humiditySensor device types so that
 * temperature control and humidity measurement appear as one accessory in the Matter home.
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

  return [
    finalizeEndpoint(
      new MatterbridgeEndpoint([thermostatDevice, humiditySensor], { id })
        .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
        // localTemperature=23°C, occupiedHeatingSetpoint=21°C as defaults; updated from RPC on startup.
        .createDefaultHeatingThermostatClusterServer(23, 21)
        .createDefaultRelativeHumidityMeasurementClusterServer(),
      { ...options, batteryPowered: heatingChannel.batteryPowered },
    ),
  ];
};
