/**
 * Channel mapper for Homematic KEY_TRANSCEIVER channels → Matter genericSwitch (momentary).
 * KEY_TRANSCEIVER and KEY share identical Matter mapping; this file re-exports the KEY mapper
 * so the serial number is built from the actual channel type (`KEY_TRANSCEIVER`).
 *
 * @file channel-mapper/key-transceiver.ts
 */

import { genericSwitch, MatterbridgeEndpoint } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic KEY_TRANSCEIVER channel to a Matter genericSwitch (momentary) endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'KEY_TRANSCEIVER');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(genericSwitch, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Momentary switch: fires initialPress/shortRelease/longPress/longRelease events.
      .createDefaultMomentarySwitchClusterServer(),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
