/**
 * Registry of device-level mappers.
 *
 * Keys are the sanitized (lowercase, non-alphanumeric→hyphens, collapsed) Homematic device type
 * strings. For example `'HmIP-WTH'` → `'hmip-wth'`.
 *
 * When a device type is found in this registry, `createEndpointsForDevice` delegates to it instead
 * of falling through to the generic channel-type mapper. Device mappers receive all resolved
 * channels for the physical device and may return any number of endpoints.
 *
 * @file device-mapper/index.ts
 */

import { DeviceMapper, MapperOptionDescriptor } from '../types.js';
import { mapDevice as hmCcVg1 } from './hm-cc-vg-1.js';
import { mapDevice as hmipDrsi4 } from './hmip-drsi4.js';
import { mapDevice as hmipWth } from './hmip-wth.js';

/**
 * Map from sanitized device type key to its `DeviceMapper` function.
 *
 * Sanitization: `deviceType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')`.
 * For example `'HmIP-WTH'` → `'hmip-wth'`, `'HmIP-STE2+'` → `'hmip-ste2'`.
 */
export const DEVICE_MAPPERS: Record<string, DeviceMapper> = {
  // HM-CC-VG-1 — virtual group thermostat with CLIMATECONTROL_RT_TRANSCEIVER + SHUTTER_CONTACT.
  'hm-cc-vg-1': hmCcVg1,
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
  'hmip-sthd': hmipWth,
  'hmip-sthd-a': hmipWth,
  'hmip-sth': hmipWth,
  'hmip-sth-a': hmipWth,
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

/**
 * Declares the user-configurable options for each device mapper.
 * Only mappers with at least one configurable option need an entry here;
 * all others default to an empty array via `getDeviceMapperOptions`.
 *
 * Keys must match all device type keys in `DEVICE_MAPPERS` that share the same mapper function.
 */
export const DEVICE_MAPPER_OPTIONS: Readonly<Record<string, readonly MapperOptionDescriptor[]>> = {
  // HmIP-WTH / STHD / STH / BWTH family — exposeHumidity controls the RelativeHumidityMeasurement cluster.
  'hmip-wth': [{ key: 'exposeHumidity', type: 'boolean' }],
  'hmip-wth-1': [{ key: 'exposeHumidity', type: 'boolean' }],
  'hmip-wth-2': [{ key: 'exposeHumidity', type: 'boolean' }],
  'hmip-wth-b': [{ key: 'exposeHumidity', type: 'boolean' }],
  'hmip-bwth': [{ key: 'exposeHumidity', type: 'boolean' }],
  'hmip-bwth-a': [{ key: 'exposeHumidity', type: 'boolean' }],
  'hmip-bwth24': [{ key: 'exposeHumidity', type: 'boolean' }],
  'hmip-sthd': [{ key: 'exposeHumidity', type: 'boolean' }],
  'hmip-sthd-a': [{ key: 'exposeHumidity', type: 'boolean' }],
  'hmip-sth': [{ key: 'exposeHumidity', type: 'boolean' }],
  'hmip-sth-a': [{ key: 'exposeHumidity', type: 'boolean' }],
};

/**
 * Return the configurable option descriptors for a Homematic device type.
 *
 * @param {string} deviceType Raw device type string, e.g. `'HmIP-WTH'`.
 * @returns {readonly MapperOptionDescriptor[]} Option descriptors (empty when the device mapper has none).
 */
export function getDeviceMapperOptions(deviceType: string): readonly MapperOptionDescriptor[] {
  return DEVICE_MAPPER_OPTIONS[deviceTypeToKey(deviceType)] ?? [];
}
