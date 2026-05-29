/**
 * CCU connection layer shared types.
 *
 * @file types.ts
 */

import type { MatterbridgeEndpoint } from 'matterbridge';

export type CcuInterfaceName = 'ReGaHSS' | 'BidCos-RF' | 'BidCos-Wired' | 'HmIP-RF' | 'VirtualDevices' | 'CUxD';

/** Homematic channel types that are mapped to Matter devices by this plugin. */
export const SUPPORTED_CHANNEL_TYPES = [
  'ALARMSTATE',
  'BLIND',
  'DIMMER',
  'HEATING_CLIMATECONTROL_TRANSCEIVER',
  'KEY',
  'KEYMATIC',
  'KEY_TRANSCEIVER',
  'MOTION_DETECTOR',
  'ROTARY_HANDLE_SENSOR',
  'SHUTTER_CONTACT',
  'SMOKE_DETECTOR',
  'SWITCH',
  'TEMPERATURE_HUMIDITY_TRANSMITTER',
  'THERMALCONTROL_TRANSMIT',
  'WEATHER',
] as const;

/** Union of the Homematic channel type strings that this plugin supports. */
export type SupportedChannelType = (typeof SUPPORTED_CHANNEL_TYPES)[number];

/** Matter device type selection for Homematic SWITCH channels. */
export type SwitchMatterType = 'light' | 'outlet' | 'switch';

export interface CcuRegaFeatureConfig {
  enabled: boolean;
  createMatterDevicesForVariables: boolean;
  createMatterDevicesForPrograms: boolean;
  syncChannelNames: boolean;
  variablesPollingInterval: number;
  virtualKeyForPseudoPush: string;
  legacyPollEnabled: boolean;
  legacyPollInterval: number;
}

export interface CcuLoggingConfig {
  logRpcEvents: boolean;
  truncatePayloadsToSingleLine: boolean;
}

export interface CcuConnectionConfig {
  host: string;
  regaEnabled: boolean;
  bcrfEnabled: boolean;
  bcwiEnabled: boolean;
  iprfEnabled: boolean;
  virtEnabled: boolean;
  cuxdEnabled: boolean;
  regaPoll: boolean;
  regaInterval: number;
  rpcPingTimeout: number;
  rpcInitAddress: string;
  rpcServerHost: string;
  rpcBinPort: number;
  rpcXmlPort: number;
  tls: boolean;
  inSecure: boolean;
  authentication: boolean;
  username: string;
  password: string;
  queueTimeout: number;
  queuePause: number;
  rega: CcuRegaFeatureConfig;
  logging: CcuLoggingConfig;
}

export interface CcuLogger {
  debug(message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
}

export interface CcuDiscoveredDevice {
  address: string;
  serial?: string;
  interfaces?: Record<string, boolean>;
}

export interface RpcClient {
  methodCall(method: string, parameters: unknown[], callback: (error: Error | null, result?: unknown) => void): void;
}

export interface RpcClientFactory {
  createClient(options: Record<string, unknown>): RpcClient;
  createSecureClient?: (options: Record<string, unknown>) => RpcClient;
  createServer?: (options: Record<string, unknown>, onListening?: () => void) => RpcServer;
}

export interface RpcServer {
  on(event: string, listener: (...parameters: unknown[]) => void): void;
  close(callback?: () => void): void;
}

export interface RegaClient {
  exec(script: string, callback: (error: Error | null, response?: string, objects?: Record<string, unknown>) => void): void;
  getChannels(callback: (error: Error | null, channels?: RegaChannel[]) => void): void;
  getValues(callback: (error: Error | null, result?: Array<{ name: string; value: unknown; ts: string }>) => void): void;
}

/** A single datapoint returned by ReGa {@link RegaClient.getValues}. */
export interface CcuReGaDatapoint {
  /** RPC interface name, e.g. `'BidCos-RF'`. */
  iface: string;
  /** Full channel address, e.g. `'OEQ0854602:1'`. */
  channel: string;
  /** Datapoint name, e.g. `'LEVEL'`. */
  datapoint: string;
  /** Current value as stored in ReGa. */
  value: unknown;
  /** True when the CCU has never received a reliable value for this datapoint (ts = 1970-01-01). */
  uncertain: boolean;
}

export interface RegaChannel {
  id: number;
  address: string;
  name: string;
}

export interface CcuStatusSnapshot {
  host: string;
  connected: boolean;
  enabledInterfaces: CcuInterfaceName[];
  connectedInterfaces: CcuInterfaceName[];
  discoveredHosts: string[];
}

/** Metadata for a single Homematic channel discovered via RPC + ReGa. */
export interface CcuChannelInfo {
  /** Full channel address, e.g. `'OEQ0854602:1'`. */
  address: string;
  /** Root device address, e.g. `'OEQ0854602'`. */
  deviceAddress: string;
  /** Zero-based channel index parsed from the address suffix. */
  channelIndex: number;
  /** Homematic channel type string, e.g. `'DIMMER'`. */
  type: string;
  /** Homematic root device model/type string, e.g. `'HM-LC-Sw1-Pl-2'`. */
  deviceType?: string;
  /** Firmware version of the root device as reported by `listDevices`, e.g. `'1.4.2'`. Used for paramset cache key construction. */
  deviceFirmware?: string;
  /** VERSION integer of the root device as reported by `listDevices`. Used as the 4th segment of the paramset cache key (matches node-red-contrib-ccu's `paramsetName` format). */
  deviceVersion?: number;
  /** RPC interface on which this channel was discovered. */
  interfaceName: Exclude<CcuInterfaceName, 'ReGaHSS'>;
  /** ReGa display name for the channel, if available. */
  name?: string;
  /** Whether the parent device is battery powered, inferred from channel 0 datapoints. */
  batteryPowered?: boolean;
  /** Whether this BLIND channel supports slat tilt control via the LEVEL_2 datapoint (venetian blinds). */
  tiltSupported?: boolean;
  /**
   * Address of a co-located power meter channel merged onto this SWITCH endpoint.
   * Set by resolveChannelsForMatter when a POWERMETER or ENERGIE_METER_TRANSMITTER channel is
   * found on the same device as a single SWITCH channel.
   */
  powerMeterChannelAddress?: string;
  /**
   * True when powerMeterChannelAddress refers to an ENERGIE_METER_TRANSMITTER channel (HmIP),
   * which reports CURRENT in milliamps. False (or absent) for BidCos POWERMETER (CURRENT in amps).
   */
  powerMeterIsHmIP?: boolean;
}

/** Per-channel user override stored in plugin config. */
export interface CcuChannelOverride {
  address: string;
  enabled?: boolean;
  switchMatterType?: SwitchMatterType;
}

/** Cache for discovered channels and ReGa names to avoid repeated RPC/ReGa calls. */
export interface CcuDiscoveryCache {
  channels: CcuChannelInfo[];
  nameMap: Record<string, string>;
  timestamp: number;
}

/** Options forwarded to channel and device mappers. */
export interface ChannelMappingOptions {
  /** Override the Matter device type for a SWITCH channel. Defaults to `'light'`. */
  switchMatterType?: SwitchMatterType;
  /** Whether the parent device is battery powered; controls which PowerSource cluster is added. */
  batteryPowered?: boolean;
}

/**
 * Function signature for a channel-type mapper.
 * Receives a single resolved channel and returns one Matterbridge endpoint.
 */
export type ChannelMapper = (channel: CcuChannelInfo, vendorId: number, options: ChannelMappingOptions) => MatterbridgeEndpoint;

/**
 * A single Matter endpoint produced by a device mapper, paired with the Homematic channels it handles.
 *
 * The `channels` array drives the wiring step: `module.ts` calls `wireChannelEndpoint` once for each
 * entry so that the correct Matter→Homematic attribute subscriptions and RPC event routing are
 * established for every channel the endpoint is responsible for.
 *
 * - Single-function devices (e.g. wall thermostat with combined humidity): one entry with one channel.
 * - Multi-endpoint devices (e.g. multi-zone floor heating): one entry per zone, each with its own channel.
 * - Devices where one endpoint aggregates several channels: one entry with multiple channels.
 */
export interface MappedDeviceEndpoint {
  /** The Matter endpoint to register with Matterbridge. */
  endpoint: MatterbridgeEndpoint;
  /**
   * The Homematic channels this endpoint handles.
   * Determines which Matter attribute subscriptions and RPC event routing wires are established.
   */
  channels: CcuChannelInfo[];
}

/**
 * Function signature for a device-level mapper.
 *
 * Receives all resolved channels for one Homematic device and returns zero or more
 * `MappedDeviceEndpoint` instances. Each entry pairs a Matter endpoint with the Homematic channels
 * it handles for wiring (attribute subscriptions, RPC event routing).
 *
 * **Priority**: Device mappers always run before the channel mapper loop. When a device mapper is
 * registered for a device type, ALL channels of that device are handled exclusively by the device
 * mapper — the channel mapper is never invoked for any of those channels.
 *
 * **Channel mapper reuse**: A device mapper may call channel mapper functions internally
 * (e.g. `mapChannel as mapSwitchChannel`) to delegate endpoint creation for individual channels
 * while still controlling the overall device presentation.
 *
 * @returns {MappedDeviceEndpoint[]} Zero or more endpoint-channel associations.
 *   Return an empty array to suppress the device entirely (e.g. when a required channel is absent).
 */
export type DeviceMapper = (channels: CcuChannelInfo[], vendorId: number, options: ChannelMappingOptions) => MappedDeviceEndpoint[];
