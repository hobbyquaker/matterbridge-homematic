/**
 * Channel mapper for Homematic HEATING_CLIMATECONTROL_TRANSCEIVER channels → Matter thermostatDevice.
 *
 * @file channel-mapper/heating-climatecontrol-transceiver.ts
 */

import { humiditySensor, MatterbridgeEndpoint, thermostatDevice } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic HEATING_CLIMATECONTROL_TRANSCEIVER channel to a Matter thermostatDevice endpoint.
 * When `options.exposeHumidity` is `true`, the humiditySensor device type and
 * RelativeHumidityMeasurement cluster are added (for devices that report a HUMIDITY datapoint).
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'HEATING_CLIMATECONTROL_TRANSCEIVER');
  const model = buildModel(channel);

  const ep =
    options.exposeHumidity === true
      ? new MatterbridgeEndpoint([thermostatDevice, humiditySensor], { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
          .createDefaultHeatingThermostatClusterServer(23, 21)
          .createDefaultRelativeHumidityMeasurementClusterServer()
      : new MatterbridgeEndpoint(thermostatDevice, { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
          .createDefaultHeatingThermostatClusterServer(23, 21);

  return finalizeEndpoint(ep, { ...options, batteryPowered: channel.batteryPowered });
};
