/**
 * Channel mapper for Homematic WEATHER channels
 * → Matter temperatureSensor + humiditySensor + lightSensor.
 *
 * @file channel-mapper/weather.ts
 */

import { humiditySensor, lightSensor, MatterbridgeEndpoint, temperatureSensor } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic WEATHER channel to a combined
 * Matter temperatureSensor + humiditySensor + lightSensor endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'WEATHER');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint([temperatureSensor, humiditySensor, lightSensor], { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Defaults null: values are updated from TEMPERATURE/HUMIDITY/BRIGHTNESS RPC events.
      .createDefaultTemperatureMeasurementClusterServer()
      .createDefaultRelativeHumidityMeasurementClusterServer()
      .createDefaultIlluminanceMeasurementClusterServer(),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
