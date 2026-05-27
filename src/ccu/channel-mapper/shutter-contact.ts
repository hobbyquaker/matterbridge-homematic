/**
 * Channel mapper for Homematic SHUTTER_CONTACT channels → Matter contactSensor.
 *
 * @file channel-mapper/shutter-contact.ts
 */

import { contactSensor, MatterbridgeEndpoint } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic SHUTTER_CONTACT channel to a Matter contactSensor endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'SHUTTER_CONTACT');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(contactSensor, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Default: closed (STATE=false → stateValue=true). Updated from RPC events on startup.
      .createDefaultBooleanStateClusterServer(true),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
