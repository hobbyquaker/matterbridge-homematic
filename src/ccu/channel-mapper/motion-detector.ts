/**
 * Channel mapper for Homematic MOTION_DETECTOR channels → Matter occupancySensor + lightSensor.
 *
 * @file channel-mapper/motion-detector.ts
 */

import { lightSensor, MatterbridgeEndpoint, occupancySensor } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic MOTION_DETECTOR channel to a combined Matter occupancySensor + lightSensor endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'MOTION_DETECTOR');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint([occupancySensor, lightSensor], { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Default: unoccupied. Updated from RPC events.
      .createDefaultOccupancySensingClusterServer(false)
      // Default: null illuminance. Updated from ILLUMINATION RPC events.
      .createDefaultIlluminanceMeasurementClusterServer(),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
