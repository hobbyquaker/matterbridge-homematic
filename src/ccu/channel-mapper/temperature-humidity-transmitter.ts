/**
 * Channel mapper for Homematic TEMPERATURE_HUMIDITY_TRANSMITTER channels
 * → Matter temperatureSensor + humiditySensor.
 *
 * @file channel-mapper/temperature-humidity-transmitter.ts
 */

import { humiditySensor, MatterbridgeEndpoint, temperatureSensor } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic TEMPERATURE_HUMIDITY_TRANSMITTER channel to a combined
 * Matter temperatureSensor + humiditySensor endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'TEMPERATURE_HUMIDITY_TRANSMITTER');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint([temperatureSensor, humiditySensor], { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // null defaults: values are updated from RPC events on startup.
      .createDefaultTemperatureMeasurementClusterServer()
      .createDefaultRelativeHumidityMeasurementClusterServer(),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
