/**
 * Channel mapper for Homematic THERMALCONTROL_TRANSMIT channels → Matter thermostatDevice.
 * Shares the same Matter mapping as HEATING_CLIMATECONTROL_TRANSCEIVER.
 *
 * @file channel-mapper/thermalcontrol-transmit.ts
 */

import { MatterbridgeEndpoint, thermostatDevice } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic THERMALCONTROL_TRANSMIT channel to a Matter thermostatDevice endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'THERMALCONTROL_TRANSMIT');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(thermostatDevice, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // localTemperature=23°C, occupiedHeatingSetpoint=21°C as defaults; updated from RPC on startup.
      .createDefaultHeatingThermostatClusterServer(23, 21),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
