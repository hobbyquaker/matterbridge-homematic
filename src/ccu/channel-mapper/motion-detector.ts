/**
 * Channel mapper for Homematic MOTION_DETECTOR channels → Matter occupancySensor + lightSensor.
 *
 * @file channel-mapper/motion-detector.ts
 */

import { lightSensor, MatterbridgeEndpoint, occupancySensor } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper, MapperOptionDescriptor } from '../types.js';

/**
 * User-configurable options declared by this mapper.
 * `exposeBrightness` adds a `lightSensor` device type and `IlluminanceMeasurement` cluster
 * to the endpoint (supported by most MOTION_DETECTOR devices via ILLUMINATION or BRIGHTNESS).
 */
export const OPTIONS: readonly MapperOptionDescriptor[] = [{ key: 'exposeBrightness', type: 'boolean' }];

/**
 * Map a Homematic MOTION_DETECTOR channel to a Matter occupancySensor endpoint.
 * When `options.exposeBrightness` is `true`, the `lightSensor` device type and
 * `IlluminanceMeasurement` cluster are also added.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'MOTION_DETECTOR');
  const model = buildModel(channel);

  const ep =
    options.exposeBrightness === true
      ? new MatterbridgeEndpoint([occupancySensor, lightSensor], { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
          .createDefaultOccupancySensingClusterServer(false)
          .createDefaultIlluminanceMeasurementClusterServer()
      : new MatterbridgeEndpoint(occupancySensor, { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
          .createDefaultOccupancySensingClusterServer(false);

  return finalizeEndpoint(ep, { ...options, batteryPowered: channel.batteryPowered });
};
