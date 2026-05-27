/**
 * Channel mapper for Homematic ALARMSTATE channels → Matter waterLeakDetector.
 *
 * @file channel-mapper/alarmstate.ts
 */

import { MatterbridgeEndpoint, waterLeakDetector } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic ALARMSTATE channel to a Matter waterLeakDetector endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'ALARMSTATE');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(waterLeakDetector, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Default: no leak. stateValue=false=no leak, stateValue=true=leak detected.
      .createDefaultBooleanStateClusterServer(false),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
