/**
 * Unit tests for device power-source classification helpers.
 *
 * Covers every exported function in `src/ccu/device-power.ts`:
 * - `isAlwaysMainsPoweredDeviceType`
 * - `getMatchingMainsPoweredPrefix`
 * - `getBatteryVoltageRange`
 *
 * @file vitest/device-power.test.ts
 */

import { describe, expect, test } from 'vitest';

import { getBatteryVoltageRange, getMatchingMainsPoweredPrefix, isAlwaysMainsPoweredDeviceType } from '../src/ccu/device-power.js';

// ---------------------------------------------------------------------------
// isAlwaysMainsPoweredDeviceType
// ---------------------------------------------------------------------------

describe('isAlwaysMainsPoweredDeviceType', () => {
  test.each([
    ['HM-LC-Sw1-Pl'],
    ['HM-LC-Sw2-FM'],
    ['HM-LC-Dim1L-Pl3'],
    ['HM-ES-TX-WM'],
    ['HM-ES-PMSw1-Pl'],
  ])('should return true for mains-powered prefix: %s', (deviceType) => {
    expect(isAlwaysMainsPoweredDeviceType(deviceType)).toBe(true);
  });

  test.each([
    ['HmIP-BSM'],
    ['HmIP-STH'],
    ['HmIP-STHD'],
    ['HM-CC-RT-DN'],
    ['HMIP-WRC2'],
    [''],
  ])('should return false for non-mains-powered type: %s', (deviceType) => {
    expect(isAlwaysMainsPoweredDeviceType(deviceType)).toBe(false);
  });

  test('should return false for undefined', () => {
    expect(isAlwaysMainsPoweredDeviceType(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getMatchingMainsPoweredPrefix
// ---------------------------------------------------------------------------

describe('getMatchingMainsPoweredPrefix', () => {
  test('should return "HM-LC" for HM-LC-* devices', () => {
    expect(getMatchingMainsPoweredPrefix('HM-LC-Sw1-Pl')).toBe('HM-LC');
  });

  test('should return "HM-ES" for HM-ES-* devices', () => {
    expect(getMatchingMainsPoweredPrefix('HM-ES-TX-WM')).toBe('HM-ES');
  });

  test('should return undefined for HmIP devices', () => {
    expect(getMatchingMainsPoweredPrefix('HmIP-BSM')).toBeUndefined();
  });

  test('should return undefined for battery-powered BidCos devices', () => {
    expect(getMatchingMainsPoweredPrefix('HM-CC-RT-DN')).toBeUndefined();
  });

  test('should return undefined for undefined input', () => {
    expect(getMatchingMainsPoweredPrefix(undefined)).toBeUndefined();
  });

  test('should return undefined for empty string', () => {
    expect(getMatchingMainsPoweredPrefix('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getBatteryVoltageRange
// ---------------------------------------------------------------------------

describe('getBatteryVoltageRange', () => {
  test('should return default range { min: 2.0, max: 3.0 } for HmIP-STH', () => {
    expect(getBatteryVoltageRange('HmIP-STH')).toEqual({ min: 2.0, max: 3.0 });
  });

  test('should return default range for HmIP-STHD', () => {
    expect(getBatteryVoltageRange('HmIP-STHD')).toEqual({ min: 2.0, max: 3.0 });
  });

  test('should return default range for HmIP-SAM (generic 2×AA device)', () => {
    expect(getBatteryVoltageRange('HmIP-SAM')).toEqual({ min: 2.0, max: 3.0 });
  });

  test('should return { min: 1.0, max: 1.5 } for HmIP-SRH (window handle, 1×AA)', () => {
    expect(getBatteryVoltageRange('HmIP-SRH')).toEqual({ min: 1.0, max: 1.5 });
  });

  test('should return { min: 1.0, max: 1.5 } for HmIP-SRH-I variant', () => {
    expect(getBatteryVoltageRange('HmIP-SRH-I')).toEqual({ min: 1.0, max: 1.5 });
  });

  test('should return { min: 1.0, max: 1.5 } for HmIP-SWD (water detector, 1×AAA)', () => {
    expect(getBatteryVoltageRange('HmIP-SWD')).toEqual({ min: 1.0, max: 1.5 });
  });

  test('should return { min: 1.0, max: 1.5 } for HmIP-SWD-PL variant', () => {
    expect(getBatteryVoltageRange('HmIP-SWD-PL')).toEqual({ min: 1.0, max: 1.5 });
  });

  test('should return default range for undefined', () => {
    expect(getBatteryVoltageRange(undefined)).toEqual({ min: 2.0, max: 3.0 });
  });

  test('should return default range for empty string', () => {
    expect(getBatteryVoltageRange('')).toEqual({ min: 2.0, max: 3.0 });
  });

  test('should return default range for mains-powered device type', () => {
    expect(getBatteryVoltageRange('HM-LC-Sw1-Pl')).toEqual({ min: 2.0, max: 3.0 });
  });
});
