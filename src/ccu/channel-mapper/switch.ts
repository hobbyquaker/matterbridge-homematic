/**
 * Channel mapper for Homematic SWITCH channels → Matter onOffLight / onOffOutlet / onOffSwitch.
 * The Matter device type is selected via `options.switchMatterType`; defaults to `'light'`.
 *
 * @file channel-mapper/switch.ts
 */

import { MatterbridgeEndpoint, onOffLight, onOffOutlet, onOffSwitch } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic SWITCH channel to a Matter on/off endpoint.
 * Also adds an ElectricalPowerMeasurement cluster when a co-located power meter channel exists.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'SWITCH');
  const model = buildModel(channel);

  let ep: MatterbridgeEndpoint;
  switch (options.switchMatterType ?? 'light') {
    case 'outlet':
      ep = new MatterbridgeEndpoint(onOffOutlet, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model);
      break;
    case 'switch':
      ep = new MatterbridgeEndpoint(onOffSwitch, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model);
      break;
    case 'light':
    default:
      ep = new MatterbridgeEndpoint(onOffLight, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model);
      break;
  }

  if (channel.powerMeterChannelAddress) {
    // A co-located power meter channel is merged onto this endpoint.
    ep.createDefaultElectricalPowerMeasurementClusterServer();
  }

  if (channel.temperatureChannelAddress) {
    // A MAINTENANCE channel temperature is exposed on this endpoint (e.g. HmIP-DRSI4 ch0).
    ep.createDefaultTemperatureMeasurementClusterServer();
  }

  return finalizeEndpoint(ep, { ...options, batteryPowered: channel.batteryPowered });
};
