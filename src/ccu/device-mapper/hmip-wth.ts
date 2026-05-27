/**
 * Device mapper for HmIP-WTH / WTH-2 / WTH-B wall thermostats.
 *
 * The HEATING_CLIMATECONTROL_TRANSCEIVER channel on these devices carries both temperature /
 * setpoint data and a HUMIDITY datapoint. The standard channel mapper creates only a
 * thermostatDevice endpoint. This device mapper additionally returns a dedicated
 * humiditySensor endpoint sourced from the same channel address.
 *
 * @file device-mapper/hmip-wth.ts
 */

import { humiditySensor, MatterbridgeEndpoint } from 'matterbridge';

import { mapChannel as mapHeatingChannel } from '../channel-mapper/heating-climatecontrol-transceiver.js';
import { buildDisplayName, buildEndpointId, buildModel, finalizeEndpoint } from '../mapper-utils.js';
import { DeviceMapper } from '../types.js';

/**
 * Device mapper for HmIP-WTH, HmIP-WTH-2, and HmIP-WTH-B.
 * Returns a thermostatDevice endpoint and a humiditySensor endpoint, both sourced from the
 * HEATING_CLIMATECONTROL_TRANSCEIVER channel.
 *
 * @type {DeviceMapper}
 */
export const mapDevice: DeviceMapper = (channels, vendorId, options) => {
  const heatingChannel = channels.find((c) => c.type === 'HEATING_CLIMATECONTROL_TRANSCEIVER');
  if (!heatingChannel) return [];

  const thermostatEndpoint = mapHeatingChannel(heatingChannel, vendorId, options);

  // Build a dedicated humiditySensor endpoint from the same channel address.
  // The endpoint id gets a '-humidity' suffix so it is stable and distinct from the thermostat.
  const humidityId = `${buildEndpointId(heatingChannel)}-humidity`;
  const displayName = `${buildDisplayName(heatingChannel)} Humidity`;
  const model = buildModel(heatingChannel);
  const serialNumber = `${heatingChannel.interfaceName}:HUMIDITY:${heatingChannel.address}`;

  const humidityEndpoint = finalizeEndpoint(
    new MatterbridgeEndpoint([humiditySensor], { id: humidityId })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      .createDefaultRelativeHumidityMeasurementClusterServer(),
    { ...options, batteryPowered: heatingChannel.batteryPowered },
  );

  return [thermostatEndpoint, humidityEndpoint];
};
