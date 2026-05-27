/**
 * Channel mapper for Homematic ROTARY_HANDLE_SENSOR channels → Matter contactSensor.
 * STATE: 0=closed → stateValue=true, 1=tilted or 2=open → stateValue=false.
 *
 * @file channel-mapper/rotary-handle-sensor.ts
 */

import { contactSensor, MatterbridgeEndpoint } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic ROTARY_HANDLE_SENSOR channel to a Matter contactSensor endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'ROTARY_HANDLE_SENSOR');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(contactSensor, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Default: closed (STATE=0 → stateValue=true). STATE 1=tilted or 2=open → stateValue=false.
      .createDefaultBooleanStateClusterServer(true),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
