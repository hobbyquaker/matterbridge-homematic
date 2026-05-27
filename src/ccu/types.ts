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
 * Function signature for a device-level mapper.
 * Receives all resolved channels for one Homematic device and returns zero or more endpoints.
 * Use this when a specific device type requires a mapping that differs from the generic channel-type fallback.
 */
export type DeviceMapper = (channels: CcuChannelInfo[], vendorId: number, options: ChannelMappingOptions) => MatterbridgeEndpoint[];
