/**
 * Parse and normalize CCU configuration from Matterbridge platform config.
 *
 * @file config.ts
 */

import { PlatformConfig } from 'matterbridge';

import { CcuConnectionConfig, CcuLoggingConfig, CcuRegaFeatureConfig } from './types.js';

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
/**
 * Build the normalized ReGa feature sub-config from raw platform config.
 * New fields take precedence; legacy `regaEnabled`, `regaPoll`, and `regaInterval` are
 * preserved alongside for callers that have not yet been migrated to the new shape.
 *
 * @param {Record<string, ConfigValue>} cfg Raw config map.
 * @returns {CcuRegaFeatureConfig} Normalized ReGa feature config.
 */
function parseRegaFeatureConfig(cfg: Record<string, ConfigValue>): CcuRegaFeatureConfig {
  const legacyEnabled = readBoolean(cfg.regaEnabled, true);
  const legacyPollEnabled = readBoolean(cfg.regaPoll, true);
  const legacyPollInterval = readNumber(cfg.regaInterval, 30);
  return {
    enabled: legacyEnabled,
    syncChannelNames: readBoolean(cfg.syncChannelNames, true),
    createMatterDevicesForVariables: readBoolean(cfg.createMatterDevicesForVariables, false),
    createMatterDevicesForPrograms: readBoolean(cfg.createMatterDevicesForPrograms, false),
    variablesPollingInterval: readNumber(cfg.regaVariablesPollingInterval, 0),
    virtualKeyForPseudoPush: readString(cfg.virtualKeyForRegaPseudoPush, ''),
    legacyPollEnabled,
    legacyPollInterval,
  };
}

/**
 * Build the normalized logging sub-config from raw platform config.
 *
 * @param {Record<string, ConfigValue>} cfg Raw config map.
 * @returns {CcuLoggingConfig} Normalized logging config.
 */
function parseLoggingConfig(cfg: Record<string, ConfigValue>): CcuLoggingConfig {
  return {
    logRpcEvents: readBoolean(cfg.logRpcEvents, false),
    truncatePayloadsToSingleLine: readBoolean(cfg.truncatePayloadsToSingleLine, false),
  };
}

/**
 * Parses the platform configuration object into a validated {@link CcuConnectionConfig}.
 *
 * @param {PlatformConfig} config - The raw platform configuration from Matterbridge.
 * @returns {CcuConnectionConfig} The parsed and validated CCU connection configuration.
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
    rega: parseRegaFeatureConfig(cfg),
    logging: parseLoggingConfig(cfg),
  };
}
