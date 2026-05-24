/**
 * CCU connection layer shared types.
 *
 * @file types.ts
 */

export type CcuInterfaceName = 'ReGaHSS' | 'BidCos-RF' | 'BidCos-Wired' | 'HmIP-RF' | 'VirtualDevices' | 'CUxD';

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
}

export interface RegaClient {
  exec(script: string, callback: (error: Error | null, response?: string, objects?: Record<string, unknown>) => void): void;
}

export interface CcuStatusSnapshot {
  host: string;
  connected: boolean;
  enabledInterfaces: CcuInterfaceName[];
  connectedInterfaces: CcuInterfaceName[];
  discoveredHosts: string[];
}
