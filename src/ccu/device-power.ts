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
