/**
 * Channel mapper for Homematic KEY channels → Matter genericSwitch (momentary).
 *
 * @file channel-mapper/key.ts
 */

import { genericSwitch, MatterbridgeEndpoint } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic KEY channel to a Matter genericSwitch (momentary) endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'KEY');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(genericSwitch, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Momentary switch: fires initialPress/shortRelease/longPress/longRelease events.
      .createDefaultMomentarySwitchClusterServer(),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
