/**
 * Shared helpers for channel and device endpoint mappers.
 *
 * @file mapper-utils.ts
 */

import { MatterbridgeEndpoint } from 'matterbridge';

import { ChannelMappingOptions, CcuChannelInfo, SupportedChannelType } from './types.js';

/** Short display labels for verbose channel type names used in the serial number column. */
const CHANNEL_TYPE_LABEL: Partial<Record<SupportedChannelType, string>> = {
  HEATING_CLIMATECONTROL_TRANSCEIVER: 'HEATING',
  KEY_TRANSCEIVER: 'KEY',
  MOTION_DETECTOR: 'MOTION',
  SHUTTER_CONTACT: 'CONTACT',
  SMOKE_DETECTOR: 'SMOKE',
  THERMALCONTROL_TRANSMIT: 'THERMALCONTROL',
};

/**
 * Return a short human-readable label for a supported channel type.
 * Falls back to the type string itself when no abbreviation is defined.
 *
 * @param {SupportedChannelType} type Canonical channel type.
 * @returns {string} Display label.
 */
export function channelTypeLabel(type: SupportedChannelType): string {
  return CHANNEL_TYPE_LABEL[type] ?? type;
}

/**
 * Build the stable Matter endpoint id for a channel.
 *
 * @param {CcuChannelInfo} channel Channel info.
 * @returns {string} Endpoint id string of the form `hm-<address-with-dash>`.
 */
export function buildEndpointId(channel: CcuChannelInfo): string {
  return `hm-${channel.address.replace(':', '-')}`;
}

/**
 * Build the Matter serial number for a channel.
 * Format: `<interfaceName>:<shortType>:<channelAddress>`.
 *
 * @param {CcuChannelInfo} channel Channel info.
 * @param {SupportedChannelType} type Canonical channel type (post-remapping).
 * @returns {string} Serial number string.
 */
export function buildSerialNumber(channel: CcuChannelInfo, type: SupportedChannelType): string {
  return `${channel.interfaceName}:${channelTypeLabel(type)}:${channel.address}`;
}

/**
 * Build the display name for a channel, falling back to the raw address when no ReGa name exists.
 *
 * @param {CcuChannelInfo} channel Channel info.
 * @returns {string} Human-readable display name.
 */
export function buildDisplayName(channel: CcuChannelInfo): string {
  return channel.name ?? channel.address;
}

/**
 * Build the Matter model string for a channel.
 * Uses the Homematic device type (e.g. `HmIP-BSM`) when available, falling back to the channel type.
 *
 * @param {CcuChannelInfo} channel Channel info.
 * @returns {string} Model string shown in the Home app.
 */
export function buildModel(channel: CcuChannelInfo): string {
  return channel.deviceType ?? channel.type;
}

/**
 * Add the appropriate power source cluster to an endpoint and call `addRequiredClusterServers`.
 * Battery-powered devices get a replaceable-battery cluster; all others get a wired cluster.
 *
 * @param {MatterbridgeEndpoint} endpoint The endpoint to finalize.
 * @param {ChannelMappingOptions} options Mapping options; `batteryPowered` selects the cluster.
 * @returns {MatterbridgeEndpoint} The same endpoint, fully finalized.
 */
export function finalizeEndpoint(endpoint: MatterbridgeEndpoint, options: ChannelMappingOptions): MatterbridgeEndpoint {
  if (options.batteryPowered) {
    endpoint.createDefaultPowerSourceReplaceableBatteryClusterServer(100);
  } else {
    endpoint.createDefaultPowerSourceWiredClusterServer();
  }
  return endpoint.addRequiredClusterServers();
}
