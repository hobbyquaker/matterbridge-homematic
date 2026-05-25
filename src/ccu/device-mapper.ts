/**
 * Maps Homematic channel types to Matterbridge endpoint instances.
 *
 * @file device-mapper.ts
 */

import {
  contactSensor,
  coverDevice,
  dimmableLight,
  humiditySensor,
  lightSensor,
  MatterbridgeEndpoint,
  occupancySensor,
  onOffLight,
  onOffOutlet,
  onOffSwitch,
  smokeCoAlarm,
  temperatureSensor,
  thermostatDevice,
  waterLeakDetector,
} from 'matterbridge';

import { CcuChannelInfo, SwitchMatterType } from './types.js';

/** Homematic channel types that are mapped to Matter devices by this plugin. */
export const SUPPORTED_CHANNEL_TYPES = [
  'ALARMSTATE',
  'BLIND',
  'DIMMER',
  'HEATING_CLIMATECONTROL_TRANSCEIVER',
  'MOTION_DETECTOR',
  'ROTARY_HANDLE_SENSOR',
  'SHUTTER_CONTACT',
  'SMOKE_DETECTOR',
  'SWITCH',
  'TEMPERATURE_HUMIDITY_TRANSMITTER',
  'THERMALCONTROL_TRANSMIT',
] as const;

/** Union of the Homematic channel type strings that this plugin supports. */
export type SupportedChannelType = (typeof SUPPORTED_CHANNEL_TYPES)[number];

/**
 * HmIP transmitter/virtual-receiver channel type pairs.
 * For each TRANSMITTER channel found on a device, the first matching VIRTUAL_RECEIVER channel
 * with a higher channel index is selected and remapped to the canonical Matter-ready type.
 */
const HMIP_CHANNEL_PAIRS: Array<{ transmitter: string; receivers: string[]; matterType: SupportedChannelType }> = [
  { transmitter: 'SWITCH_TRANSMITTER', receivers: ['SWITCH_VIRTUAL_RECEIVER'], matterType: 'SWITCH' },
  { transmitter: 'DIMMER_TRANSMITTER', receivers: ['DIMMER_VIRTUAL_RECEIVER'], matterType: 'DIMMER' },
  {
    transmitter: 'BLIND_TRANSMITTER',
    // HmIP uses BLIND_VIRTUAL_RECEIVER (venetian) or SHUTTER_VIRTUAL_RECEIVER (simple shutter).
    // Some CCU firmware variants report BLIND_VIRTUAL_TRANSCEIVER instead.
    receivers: ['BLIND_VIRTUAL_RECEIVER', 'BLIND_VIRTUAL_TRANSCEIVER', 'SHUTTER_VIRTUAL_RECEIVER'],
    matterType: 'BLIND',
  },
];

/** HmIP virtual-receiver channel types that should be exposed as BLIND even without a BLIND_TRANSMITTER companion. */
const STANDALONE_BLIND_VIRTUAL_TYPES = ['BLIND_VIRTUAL_RECEIVER', 'BLIND_VIRTUAL_TRANSCEIVER', 'SHUTTER_VIRTUAL_RECEIVER'] as const;

/**
 * Select the channels that should be exposed as Matter devices from the full CCU channel list.
 *
 * For HmIP devices that use virtual-receiver channels (e.g. HmIP-BSM, HmIP-BDT), each
 * `SWITCH_TRANSMITTER` / `DIMMER_TRANSMITTER` channel is paired with the first
 * `SWITCH_VIRTUAL_RECEIVER` / `DIMMER_VIRTUAL_RECEIVER` channel that follows it (by
 * channel index).  The returned channel has its `type` remapped to `'SWITCH'` or
 * `'DIMMER'` so downstream handling is identical to classic BidCos devices.
 *
 * Classic BidCos channels (`SWITCH`, `DIMMER`, `SHUTTER_CONTACT`, …) pass through unchanged.
 *
 * @param {CcuChannelInfo[]} allChannels All channels as returned by CCU discovery.
 * @returns {CcuChannelInfo[]} Channels ready for Matter endpoint creation.
 */
export function resolveChannelsForMatter(allChannels: CcuChannelInfo[]): CcuChannelInfo[] {
  // Group by device address, sorted by channel index ascending.
  const byDevice = new Map<string, CcuChannelInfo[]>();
  for (const ch of allChannels) {
    const group = byDevice.get(ch.deviceAddress) ?? [];
    group.push(ch);
    byDevice.set(ch.deviceAddress, group);
  }
  for (const group of byDevice.values()) {
    group.sort((a, b) => a.channelIndex - b.channelIndex);
  }

  const result: CcuChannelInfo[] = [];

  for (const deviceChannels of byDevice.values()) {
    // Collect all channel addresses handled by HmIP pairing so they are not passed through as-is.
    const hmipHandled = new Set<string>();
    const hmipSelected: CcuChannelInfo[] = [];

    for (const pair of HMIP_CHANNEL_PAIRS) {
      const transmitters = deviceChannels.filter((c) => c.type === pair.transmitter);
      if (transmitters.length === 0) continue;

      // Mark all transmitter and receiver channels as handled.
      for (const ch of deviceChannels) {
        if (ch.type === pair.transmitter || pair.receivers.includes(ch.type)) {
          hmipHandled.add(ch.address);
        }
      }

      for (const tx of transmitters) {
        // The first receiver channel whose type is in the accepted list and index > transmitter.
        const rx = deviceChannels.find((c) => pair.receivers.includes(c.type) && c.channelIndex > tx.channelIndex);
        if (!rx) continue;
        // BLIND_VIRTUAL_RECEIVER indicates venetian blind with tilt (LEVEL_2) support.
        const tiltSupported = pair.matterType === 'BLIND' && rx.type === 'BLIND_VIRTUAL_RECEIVER';
        hmipSelected.push({ ...rx, type: pair.matterType, tiltSupported });
      }
    }

    // Handle standalone HmIP blind virtual channels (devices with no BLIND_TRANSMITTER).
    // HmIP exposes 3 virtual channels per physical output; take the first of each block of 3.
    const unhandledBlinds = deviceChannels
      .filter((c) => (STANDALONE_BLIND_VIRTUAL_TYPES as readonly string[]).includes(c.type) && !hmipHandled.has(c.address))
      .sort((a, b) => a.channelIndex - b.channelIndex);

    let blindSlot = 0;
    for (const ch of unhandledBlinds) {
      hmipHandled.add(ch.address);
      if (blindSlot === 0) {
        const tiltSupported = ch.type === 'BLIND_VIRTUAL_RECEIVER';
        hmipSelected.push({ ...ch, type: 'BLIND' as SupportedChannelType, tiltSupported });
      }
      blindSlot = (blindSlot + 1) % 3;
    }

    // Pass through all non-HmIP-handled channels unchanged.
    for (const ch of deviceChannels) {
      if (!hmipHandled.has(ch.address)) {
        result.push(ch);
      }
    }

    // Append the selected HmIP virtual-receiver channels (remapped type).
    result.push(...hmipSelected);
  }

  return result;
}

export interface ChannelMappingOptions {
  switchMatterType?: SwitchMatterType;
  batteryPowered?: boolean;
}

/**
 * Infer the best Matter device type for a SWITCH channel from the ReGa channel name.
 * Returns `undefined` when no keyword matches so the caller can fall back to the default ('light').
 *
 * @param {string | undefined} name ReGa display name of the channel.
 * @returns {SwitchMatterType | undefined} Inferred type, or `undefined` when name gives no signal.
 */
export function inferSwitchMatterTypeFromName(name: string | undefined): SwitchMatterType | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  if (['standby', 'plug', 'steckdose', 'buchse'].some((kw) => lower.includes(kw))) return 'outlet';
  if (['licht', 'light', 'lampe', 'lamp', 'leuchte'].some((kw) => lower.includes(kw))) return 'light';
  return undefined;
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
    case 'ALARMSTATE':
      return finalizeEndpoint(
        new MatterbridgeEndpoint(waterLeakDetector, { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Water Leak Detector')
          // Default: no leak. stateValue=false=no leak, stateValue=true=leak detected.
          .createDefaultBooleanStateClusterServer(false),
        { ...options, batteryPowered: channel.batteryPowered },
      );

    case 'BLIND':
      if (channel.tiltSupported) {
        return finalizeEndpoint(
          new MatterbridgeEndpoint(coverDevice, { id })
            .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Venetian Blind')
            // Default: fully closed position (10000), neutral tilt (5000). Updated from RPC on startup.
            .createDefaultLiftTiltWindowCoveringClusterServer(10000, 5000),
          { ...options, batteryPowered: channel.batteryPowered },
        );
      }
      return finalizeEndpoint(
        new MatterbridgeEndpoint(coverDevice, { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Blind')
          // Default: fully closed (10000 = 100.00%). Position is updated from RPC events on startup.
          .createDefaultWindowCoveringClusterServer(10000),
        { ...options, batteryPowered: channel.batteryPowered },
      );

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
          .createDefaultBooleanStateClusterServer(true),
        { ...options, batteryPowered: channel.batteryPowered },
      );

    case 'ROTARY_HANDLE_SENSOR':
      return finalizeEndpoint(
        new MatterbridgeEndpoint(contactSensor, { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Rotary Handle Sensor')
          // Default: closed (0). STATE 0=closed→stateValue=true, 1=tilted or 2=open→stateValue=false.
          .createDefaultBooleanStateClusterServer(true),
        { ...options, batteryPowered: channel.batteryPowered },
      );

    case 'MOTION_DETECTOR':
      return finalizeEndpoint(
        new MatterbridgeEndpoint([occupancySensor, lightSensor], { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Motion Detector')
          // Default: unoccupied. Updated from RPC events.
          .createDefaultOccupancySensingClusterServer(false)
          // Default: null illuminance. Updated from ILLUMINATION RPC events.
          .createDefaultIlluminanceMeasurementClusterServer(),
        { ...options, batteryPowered: channel.batteryPowered },
      );

    case 'TEMPERATURE_HUMIDITY_TRANSMITTER':
      return finalizeEndpoint(
        new MatterbridgeEndpoint([temperatureSensor, humiditySensor], { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Temperature/Humidity Sensor')
          // null defaults: values are updated from RPC events on startup.
          .createDefaultTemperatureMeasurementClusterServer()
          .createDefaultRelativeHumidityMeasurementClusterServer(),
        { ...options, batteryPowered: channel.batteryPowered },
      );

    case 'SMOKE_DETECTOR':
      return finalizeEndpoint(
        new MatterbridgeEndpoint(smokeCoAlarm, { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Smoke Detector')
          // Default: no alarm. Updated from SMOKE_DETECTOR_ALARM_STATUS RPC events.
          .createSmokeOnlySmokeCOAlarmClusterServer(),
        { ...options, batteryPowered: channel.batteryPowered },
      );

    case 'HEATING_CLIMATECONTROL_TRANSCEIVER':
    case 'THERMALCONTROL_TRANSMIT':
      return finalizeEndpoint(
        new MatterbridgeEndpoint(thermostatDevice, { id })
          .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', 'Homematic Thermostat')
          // localTemperature=23°C, occupiedHeatingSetpoint=21°C as defaults; updated from RPC on startup.
          .createDefaultHeatingThermostatClusterServer(23, 21),
        { ...options, batteryPowered: channel.batteryPowered },
      );
  }
}
