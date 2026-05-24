/**
 * Parse and normalize CCU configuration from Matterbridge platform config.
 *
 * @file config.ts
 */

import { PlatformConfig } from 'matterbridge';

import { CcuConnectionConfig } from './types.js';

type ConfigValue = string | number | boolean | null | undefined;

/**
 * Read a boolean value from platform config with fallback.
 *
 * @param {ConfigValue} value Raw config value.
 * @param {boolean} fallback Fallback when value cannot be parsed.
 * @returns {boolean} Parsed boolean value.
 */
function readBoolean(value: ConfigValue, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

/**
 * Read a number value from platform config with fallback.
 *
 * @param {ConfigValue} value Raw config value.
 * @param {number} fallback Fallback when value cannot be parsed.
 * @returns {number} Parsed number value.
 */
function readNumber(value: ConfigValue, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Read a string value from platform config with fallback.
 *
 * @param {ConfigValue} value Raw config value.
 * @param {string} fallback Fallback when value cannot be parsed.
 * @returns {string} Parsed string value.
 */
function readString(value: ConfigValue, fallback: string): string {
  if (typeof value === 'string') return value;
  return fallback;
}

/**
 * Normalize platform config to a typed CCU connection config.
 *
 * @param {PlatformConfig} config Matterbridge platform config.
 * @returns {CcuConnectionConfig} Parsed CCU connection config.
 */
export function parseCcuConnectionConfig(config: PlatformConfig): CcuConnectionConfig {
  const cfg = config as Record<string, ConfigValue>;

  return {
    host: readString(cfg.host, ''),
    regaEnabled: readBoolean(cfg.regaEnabled, true),
    bcrfEnabled: readBoolean(cfg.bcrfEnabled, true),
    bcwiEnabled: readBoolean(cfg.bcwiEnabled, false),
    iprfEnabled: readBoolean(cfg.iprfEnabled, true),
    virtEnabled: readBoolean(cfg.virtEnabled, true),
    cuxdEnabled: readBoolean(cfg.cuxdEnabled, false),
    regaPoll: readBoolean(cfg.regaPoll, true),
    regaInterval: readNumber(cfg.regaInterval, 30),
    rpcPingTimeout: readNumber(cfg.rpcPingTimeout, 60),
    rpcInitAddress: readString(cfg.rpcInitAddress, ''),
    rpcServerHost: readString(cfg.rpcServerHost, '0.0.0.0'),
    rpcBinPort: readNumber(cfg.rpcBinPort, 2048),
    rpcXmlPort: readNumber(cfg.rpcXmlPort, 2049),
    tls: readBoolean(cfg.tls, false),
    inSecure: readBoolean(cfg.inSecure, false),
    authentication: readBoolean(cfg.authentication, false),
    username: readString(cfg.username, ''),
    password: readString(cfg.password, ''),
    queueTimeout: readNumber(cfg.queueTimeout, 5000),
    queuePause: readNumber(cfg.queuePause, 250),
  };
}
