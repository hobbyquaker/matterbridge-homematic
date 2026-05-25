/**
 * Device power-source classification helpers.
 *
 * @file device-power.ts
 */

/**
 * Homematic device model prefixes that are always mains powered.
 *
 * Keep this list small and explicit. Add new prefixes only when verified.
 */
export const MAINS_POWERED_DEVICE_TYPE_PREFIXES = ['HM-LC', 'HM-ES'] as const;

/**
 * Return whether a Homematic device model/type is always mains powered.
 *
 * @param {string | undefined} deviceType Homematic model/type string.
 * @returns {boolean} `true` when the type matches a known mains-powered prefix.
 */
export function isAlwaysMainsPoweredDeviceType(deviceType: string | undefined): boolean {
  if (typeof deviceType !== 'string') return false;
  return MAINS_POWERED_DEVICE_TYPE_PREFIXES.some((prefix) => deviceType.startsWith(prefix));
}

/**
 * Return the matching mains-powered prefix for a given device type.
 *
 * @param {string | undefined} deviceType Homematic model/type string.
 * @returns {string | undefined} Matching prefix when classified as mains powered.
 */
export function getMatchingMainsPoweredPrefix(deviceType: string | undefined): string | undefined {
  if (typeof deviceType !== 'string') return undefined;
  return MAINS_POWERED_DEVICE_TYPE_PREFIXES.find((prefix) => deviceType.startsWith(prefix));
}

/**
 * Battery voltage range (min/max in volts) for a Homematic battery-powered device.
 */
export interface BatteryVoltageRange {
  /** Minimum (depleted) voltage in volts. */
  min: number;
  /** Maximum (fully charged) voltage in volts. */
  max: number;
}

/**
 * Default voltage range: 2×AA/LR6 pack (2.0 – 3.0 V).
 * Covers most HmIP sensors (SMI, STH, STHD, STHO, SCTH230, DBB, SAM, SLO, etc.).
 */
const DEFAULT_BATTERY_VOLTAGE_RANGE: BatteryVoltageRange = { min: 2.0, max: 3.0 };

/**
 * Per-prefix voltage overrides for devices that deviate from the 2×AA default.
 * Ordered longest-prefix-first so the most-specific match wins.
 */
const BATTERY_VOLTAGE_RANGES: Array<{ prefix: string; range: BatteryVoltageRange }> = [
  { prefix: 'HmIP-SRH', range: { min: 1.0, max: 1.5 } }, // window handle sensor, 1×AA
  { prefix: 'HmIP-SWD', range: { min: 1.0, max: 1.5 } }, // water detector, 1×AAA
];

/**
 * Return the battery voltage range for a given Homematic device type.
 *
 * @param {string | undefined} deviceType Homematic model/type string.
 * @returns {BatteryVoltageRange} Min/max voltage in volts.
 */
export function getBatteryVoltageRange(deviceType: string | undefined): BatteryVoltageRange {
  if (typeof deviceType !== 'string') return DEFAULT_BATTERY_VOLTAGE_RANGE;
  return BATTERY_VOLTAGE_RANGES.find((entry) => deviceType.startsWith(entry.prefix))?.range ?? DEFAULT_BATTERY_VOLTAGE_RANGE;
}
