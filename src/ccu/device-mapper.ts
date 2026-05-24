/**
 * Maps Homematic channel types to Matterbridge endpoint instances.
 *
 * @file device-mapper.ts
 */

import { contactSensor, dimmableLight, MatterbridgeEndpoint, onOffLight } from 'matterbridge';

import { CcuChannelInfo } from './types.js';

/** Homematic channel types that are mapped to Matter devices by this plugin. */
export const SUPPORTED_CHANNEL_TYPES = ['DIMMER', 'SWITCH', 'SHUTTER_CONTACT'] as const;

/** Union of the Homematic channel type strings that this plugin supports. */
export type SupportedChannelType = (typeof SUPPORTED_CHANNEL_TYPES)[number];

/**
 * Return whether a channel type string is handled by this plugin.
 *
 * @param {string} type Raw Homematic channel type.
 * @returns {boolean} `true` when the type has a Matter mapping.
 */
export function isSupportedChannelType(type: string): type is SupportedChannelType {
  return (SUPPORTED_CHANNEL_TYPES as readonly string[]).includes(type);
}

/**
 * Create a configured `MatterbridgeEndpoint` for a supported Homematic channel.
 *
 * @param {CcuChannelInfo & { type: SupportedChannelType }} channel Channel with a supported type.
 * @param {number} vendorId Matter vendor ID from the Matterbridge aggregator.
 * @returns {MatterbridgeEndpoint} Fully initialized endpoint ready to register.
 */
export function createEndpointForChannel(channel: CcuChannelInfo & { type: SupportedChannelType }, vendorId: number): MatterbridgeEndpoint {
  const displayName = channel.name ?? channel.address;
  const serialNumber = channel.address.replace(':', '-');
  const id = `hm-${serialNumber}`;

  switch (channel.type) {
    case 'DIMMER':
      return new MatterbridgeEndpoint(dimmableLight, { id })
        .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Dimmer')
        .addRequiredClusterServers();

    case 'SWITCH':
      return new MatterbridgeEndpoint(onOffLight, { id })
        .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Switch')
        .addRequiredClusterServers();

    case 'SHUTTER_CONTACT':
      return new MatterbridgeEndpoint(contactSensor, { id })
        .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Shutter Contact')
        .createDefaultBooleanStateClusterServer(false)
        .addRequiredClusterServers();
  }
}
