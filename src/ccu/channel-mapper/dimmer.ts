/**
 * Channel mapper for Homematic DIMMER channels → Matter dimmableLight.
 *
 * @file channel-mapper/dimmer.ts
 */

import { dimmableLight, MatterbridgeEndpoint } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic DIMMER channel to a Matter dimmableLight endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'DIMMER');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(dimmableLight, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
