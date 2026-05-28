/**
 * Registry of device-level mappers.
 *
 * Keys are the sanitized (lowercase, non-alphanumeric→hyphens, collapsed) Homematic device type
 * strings. For example `'HmIP-BSM'` → `'hmip-bsm'`.
 *
 * When a device type is found in this registry, `createEndpointsForDevice` delegates to it instead
 * of falling through to the generic channel-type mapper. Device mappers receive all resolved
 * channels for the physical device and may return any number of endpoints.
 *
 * @file device-mapper/index.ts
 */

import { DeviceMapper } from '../types.js';
import { mapDevice as hmipBsm } from './hmip-bsm.js';
import { mapDevice as hmipDrsi4 } from './hmip-drsi4.js';
import { mapDevice as hmipSthd } from './hmip-sthd.js';
import { mapDevice as hmipWth } from './hmip-wth.js';

/**
 * Map from sanitized device type key to its `DeviceMapper` function.
 *
 * Sanitization: `deviceType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')`.
 * For example `'HmIP-BSM'` → `'hmip-bsm'`, `'HmIP-STE2+'` → `'hmip-ste2'`.
 */
export const DEVICE_MAPPERS: Record<string, DeviceMapper> = {
  'hmip-bsm': hmipBsm,
  // HmIP-DRSI family — multi-channel DIN rail switch actuators (mains-powered, one endpoint per output).
  'hmip-drsi1': hmipDrsi4,
  'hmip-drsi4': hmipDrsi4,
  // HmIP-WTH family — battery powered wall thermostats with HUMIDITY on the HEATING_CLIMATECONTROL_TRANSCEIVER channel.
  'hmip-wth': hmipWth,
  'hmip-wth-1': hmipWth,
  'hmip-wth-2': hmipWth,
  'hmip-wth-b': hmipWth,
  // HmIP-BWTH family — brand-switch-form-factor mains or 24V powered wall thermostats, same channel layout as WTH.
  'hmip-bwth': hmipWth,
  'hmip-bwth-a': hmipWth,
  'hmip-bwth24': hmipWth,
  // HmIP-STHD / STH — same channel layout as WTH.
  'hmip-sthd': hmipSthd,
  'hmip-sthd-a': hmipSthd,
  'hmip-sth': hmipSthd,
  'hmip-sth-a': hmipSthd,
};

/**
 * Compute the registry lookup key for a raw Homematic device type string.
 *
 * @param {string} deviceType Raw device type, e.g. `'HmIP-BSM'`.
 * @returns {string} Sanitized key, e.g. `'hmip-bsm'`.
 */
export function deviceTypeToKey(deviceType: string): string {
  return deviceType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
