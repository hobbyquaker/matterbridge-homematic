/**
 * Maps Homematic channel types to Matterbridge endpoint instances.
 *
 * @file device-mapper.ts
 */

import { contactSensor, dimmableLight, MatterbridgeEndpoint, onOffLight, onOffOutlet, onOffSwitch } from 'matterbridge';

import { CcuChannelInfo, SwitchMatterType } from './types.js';

/** Homematic channel types that are mapped to Matter devices by this plugin. */
export const SUPPORTED_CHANNEL_TYPES = ['DIMMER', 'SWITCH', 'SHUTTER_CONTACT'] as const;

/** Union of the Homematic channel type strings that this plugin supports. */
export type SupportedChannelType = (typeof SUPPORTED_CHANNEL_TYPES)[number];

export interface ChannelMappingOptions {
  switchMatterType?: SwitchMatterType;
  batteryPowered?: boolean;
}

/**
 * Example function to map a device endpoint with options.
 *
 * @param {MatterbridgeEndpoint} endpoint The Matterbridge endpoint instance to map.
 * @param {object} options Options for mapping the endpoint.
 * @returns {void} Returns nothing.
 */
function finalizeEndpoint(endpoint: MatterbridgeEndpoint, options: ChannelMappingOptions): MatterbridgeEndpoint {
  if (options.batteryPowered) {
    endpoint.createDefaultPowerSourceReplaceableBatteryClusterServer(100);
  } else {
    endpoint.createDefaultPowerSourceWiredClusterServer();
  }
  return endpoint.addRequiredClusterServers();
}

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
 * @param {ChannelMappingOptions} [options] Optional mapping overrides.
 * @returns {MatterbridgeEndpoint} Fully initialized endpoint ready to register.
 */
export function createEndpointForChannel(channel: CcuChannelInfo & { type: SupportedChannelType }, vendorId: number, options: ChannelMappingOptions = {}): MatterbridgeEndpoint {
  const displayName = channel.name ?? channel.address;
  const serialNumber = channel.address;
  // Keep endpoint id stable and filesystem-safe independent of serial format.
  const id = `hm-${channel.address.replace(':', '-')}`;

  switch (channel.type) {
    case 'DIMMER':
      return finalizeEndpoint(
        new MatterbridgeEndpoint(dimmableLight, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
          displayName,
          serialNumber,
          vendorId,
          'Homematic',
          'Homematic Dimmer',
        ),
        { ...options, batteryPowered: channel.batteryPowered },
      );

    case 'SWITCH':
      switch (options.switchMatterType ?? 'light') {
        case 'outlet':
          return finalizeEndpoint(
            new MatterbridgeEndpoint(onOffOutlet, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
              displayName,
              serialNumber,
              vendorId,
              'Homematic',
              'Homematic Switch Outlet',
            ),
            { ...options, batteryPowered: channel.batteryPowered },
          );
        case 'switch':
          return finalizeEndpoint(
            new MatterbridgeEndpoint(onOffSwitch, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
              displayName,
              serialNumber,
              vendorId,
              'Homematic',
              'Homematic Switch Relay',
            ),
            { ...options, batteryPowered: channel.batteryPowered },
          );
        case 'light':
        default:
          return finalizeEndpoint(
            new MatterbridgeEndpoint(onOffLight, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
              displayName,
              serialNumber,
              vendorId,
              'Homematic',
              'Homematic Switch Light',
            ),
            { ...options, batteryPowered: channel.batteryPowered },
          );
      }

    case 'SHUTTER_CONTACT':
      return finalizeEndpoint(
        new MatterbridgeEndpoint(contactSensor, { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Shutter Contact')
          .createDefaultBooleanStateClusterServer(false),
        { ...options, batteryPowered: channel.batteryPowered },
      );
  }
}
