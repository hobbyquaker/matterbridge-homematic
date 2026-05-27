/**
 * Channel mapper for Homematic BLIND channels → Matter coverDevice.
 * Handles both plain shutter (lift only) and venetian blind (lift + tilt) variants.
 *
 * @file channel-mapper/blind.ts
 */

import { coverDevice, MatterbridgeEndpoint } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic BLIND channel to a Matter coverDevice endpoint.
 * When `channel.tiltSupported` is true a lift-and-tilt cluster is added instead of lift-only.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'BLIND');
  const model = buildModel(channel);

  if (channel.tiltSupported) {
    return finalizeEndpoint(
      new MatterbridgeEndpoint(coverDevice, { id })
        .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
        // Default: fully closed position (10000), neutral tilt (5000). Updated from RPC on startup.
        .createDefaultLiftTiltWindowCoveringClusterServer(10000, 5000),
      { ...options, batteryPowered: channel.batteryPowered },
    );
  }

  return finalizeEndpoint(
    new MatterbridgeEndpoint(coverDevice, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Default: fully closed (10000 = 100.00%). Position is updated from RPC events on startup.
      .createDefaultWindowCoveringClusterServer(10000),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
