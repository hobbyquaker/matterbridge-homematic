/**
 * Channel mapper for Homematic ROTARY_HANDLE_TRANSCEIVER channels (HmIP-SRH) → Matter contactSensor.
 * STATE enum: "CLOSED" → stateValue=true, "TILTED" or "OPEN" → stateValue=false.
 *
 * @file channel-mapper/rotary-handle-transceiver.ts
 */

import { contactSensor, MatterbridgeEndpoint } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic ROTARY_HANDLE_TRANSCEIVER channel to a Matter contactSensor endpoint.
 * The HmIP-SRH rotary handle sensor reports STATE as an enum string: "CLOSED", "TILTED", "OPEN".
 * Only "CLOSED" maps to contact detected (stateValue=true); both "TILTED" and "OPEN" map to no
 * contact (stateValue=false).
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'ROTARY_HANDLE_TRANSCEIVER');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(contactSensor, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // Default: closed. STATE="CLOSED" → stateValue=true; "TILTED" or "OPEN" → stateValue=false.
      .createDefaultBooleanStateClusterServer(true),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
