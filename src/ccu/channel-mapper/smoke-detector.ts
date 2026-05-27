/**
 * Channel mapper for Homematic SMOKE_DETECTOR channels → Matter smokeCoAlarm.
 *
 * @file channel-mapper/smoke-detector.ts
 */

import { MatterbridgeEndpoint, smokeCoAlarm } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic SMOKE_DETECTOR channel to a Matter smokeCoAlarm endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'SMOKE_DETECTOR');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(smokeCoAlarm, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Default: no alarm. Updated from SMOKE_DETECTOR_ALARM_STATUS RPC events.
      .createSmokeOnlySmokeCOAlarmClusterServer(),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
