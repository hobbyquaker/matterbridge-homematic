/**
 * Channel mapper for Homematic KEYMATIC channels → Matter doorLockDevice.
 *
 * @file channel-mapper/keymatic.ts
 */

import { doorLockDevice, MatterbridgeEndpoint } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic KEYMATIC channel to a Matter doorLockDevice endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'KEYMATIC');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(doorLockDevice, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Default: locked. lockState is updated from RPC events on startup.
      .createDefaultDoorLockClusterServer(),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
