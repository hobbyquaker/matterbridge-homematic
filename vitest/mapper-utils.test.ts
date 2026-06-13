/**
 * Unit tests for shared channel/device mapper utility helpers.
 *
 * Covers every exported function in `src/ccu/mapper-utils.ts`:
 * - `channelTypeLabel`
 * - `buildEndpointId`
 * - `buildSerialNumber`
 * - `buildDisplayName`
 * - `buildModel`
 * - `finalizeEndpoint`
 *
 * @file vitest/mapper-utils.test.ts
 */

import { MatterbridgeEndpoint, onOffLight } from 'matterbridge';
import { describe, expect, test } from 'vitest';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, channelTypeLabel, finalizeEndpoint } from '../src/ccu/mapper-utils.js';
import type { CcuChannelInfo, SupportedChannelType } from '../src/ccu/types.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeChannel(overrides: Pick<CcuChannelInfo, 'address' | 'interfaceName'> & Partial<CcuChannelInfo>): CcuChannelInfo {
  return {
    deviceAddress: overrides.address.split(':')[0],
    channelIndex: 0,
    type: 'SWITCH',
    ...overrides,
  } as CcuChannelInfo;
}

const VENDOR_ID = 0xfff1;

// ---------------------------------------------------------------------------
// channelTypeLabel
// ---------------------------------------------------------------------------

describe('channelTypeLabel', () => {
  test.each([
    ['HEATING_CLIMATECONTROL_TRANSCEIVER', 'HEATING'],
    ['KEY_TRANSCEIVER', 'KEY'],
    ['MOTION_DETECTOR', 'MOTION'],
    ['ROTARY_HANDLE_SENSOR', 'ROTARY'],
    ['ROTARY_HANDLE_TRANSCEIVER', 'ROTARY'],
    ['SHUTTER_CONTACT', 'CONTACT'],
    ['SMOKE_DETECTOR', 'SMOKE'],
    ['THERMALCONTROL_TRANSMIT', 'THERMALCONTROL'],
  ])('should abbreviate %s → %s', (type, expected) => {
    expect(channelTypeLabel(type as SupportedChannelType)).toBe(expected);
  });

  test.each([['SWITCH'], ['BLIND'], ['DIMMER'], ['WEATHER'], ['KEYMATIC'], ['ALARMSTATE'], ['KEY'], ['TEMPERATURE_HUMIDITY_TRANSMITTER']])(
    'should return type unchanged for %s (no abbreviation defined)',
    (type) => {
      expect(channelTypeLabel(type as SupportedChannelType)).toBe(type);
    },
  );
});

// ---------------------------------------------------------------------------
// buildEndpointId
// ---------------------------------------------------------------------------

describe('buildEndpointId', () => {
  test('should prefix with "hm-" and replace ":" with "-"', () => {
    const ch = makeChannel({ address: 'OEQ001:3', interfaceName: 'BidCos-RF' });
    expect(buildEndpointId(ch)).toBe('hm-OEQ001-3');
  });

  test('should work for channel index 0', () => {
    const ch = makeChannel({ address: 'OEQ001:0', interfaceName: 'BidCos-RF' });
    expect(buildEndpointId(ch)).toBe('hm-OEQ001-0');
  });

  test('should work for HmIP long addresses', () => {
    const ch = makeChannel({ address: '000A18A9A84E4A:6', interfaceName: 'HmIP-RF' });
    expect(buildEndpointId(ch)).toBe('hm-000A18A9A84E4A-6');
  });
});

// ---------------------------------------------------------------------------
// buildSerialNumber
// ---------------------------------------------------------------------------

describe('buildSerialNumber', () => {
  test('should format as "interfaceName:label:address" using abbreviated label', () => {
    const ch = makeChannel({ address: 'OEQ001:3', interfaceName: 'BidCos-RF' });
    expect(buildSerialNumber(ch, 'SHUTTER_CONTACT')).toBe('BidCos-RF:CONTACT:OEQ001:3');
  });

  test('should use the raw type string when no abbreviation is defined', () => {
    const ch = makeChannel({ address: 'OEQ001:1', interfaceName: 'BidCos-RF' });
    expect(buildSerialNumber(ch, 'SWITCH')).toBe('BidCos-RF:SWITCH:OEQ001:1');
  });

  test('should use MOTION abbreviation for MOTION_DETECTOR', () => {
    const ch = makeChannel({ address: 'HmIP001:1', interfaceName: 'HmIP-RF' });
    expect(buildSerialNumber(ch, 'MOTION_DETECTOR')).toBe('HmIP-RF:MOTION:HmIP001:1');
  });

  test('should use KEY abbreviation for KEY_TRANSCEIVER', () => {
    const ch = makeChannel({ address: 'OEQ002:1', interfaceName: 'BidCos-RF' });
    expect(buildSerialNumber(ch, 'KEY_TRANSCEIVER')).toBe('BidCos-RF:KEY:OEQ002:1');
  });

  test('should use SMOKE abbreviation for SMOKE_DETECTOR', () => {
    const ch = makeChannel({ address: 'OEQ003:1', interfaceName: 'HmIP-RF' });
    expect(buildSerialNumber(ch, 'SMOKE_DETECTOR')).toBe('HmIP-RF:SMOKE:OEQ003:1');
  });
});

// ---------------------------------------------------------------------------
// buildDisplayName
// ---------------------------------------------------------------------------

describe('buildDisplayName', () => {
  test('should return channel.name when it is set', () => {
    const ch = makeChannel({ address: 'OEQ001:1', interfaceName: 'BidCos-RF', name: 'Wohnzimmer Licht' });
    expect(buildDisplayName(ch)).toBe('Wohnzimmer Licht');
  });

  test('should fall back to channel.address when name is undefined', () => {
    const ch = makeChannel({ address: 'OEQ001:1', interfaceName: 'BidCos-RF' });
    expect(buildDisplayName(ch)).toBe('OEQ001:1');
  });
});

// ---------------------------------------------------------------------------
// buildModel
// ---------------------------------------------------------------------------

describe('buildModel', () => {
  test('should return deviceType when it is set', () => {
    const ch = makeChannel({ address: 'OEQ001:1', interfaceName: 'BidCos-RF', deviceType: 'HM-LC-Sw1-Pl' });
    expect(buildModel(ch)).toBe('HM-LC-Sw1-Pl');
  });

  test('should fall back to channel.type when deviceType is undefined', () => {
    const ch = makeChannel({ address: 'OEQ001:1', interfaceName: 'BidCos-RF', type: 'SWITCH' });
    expect(buildModel(ch)).toBe('SWITCH');
  });
});

// ---------------------------------------------------------------------------
// finalizeEndpoint
// ---------------------------------------------------------------------------

function makeBaseEndpoint(id = 'test-ep'): MatterbridgeEndpoint {
  return new MatterbridgeEndpoint(onOffLight, { id }).createDefaultBridgedDeviceBasicInformationClusterServer('Test', `SN-${id}`, VENDOR_ID, 'Homematic', 'TEST');
}

describe('finalizeEndpoint', () => {
  test('should return the same endpoint instance', () => {
    const ep = makeBaseEndpoint();
    const result = finalizeEndpoint(ep, { batteryPowered: false });
    expect(result).toBe(ep);
  });

  test('should add PowerSource cluster for wired device (batteryPowered=false)', () => {
    const ep = makeBaseEndpoint('wired-ep');
    finalizeEndpoint(ep, { batteryPowered: false });
    expect(ep.hasClusterServer('PowerSource')).toBe(true);
  });

  test('should add PowerSource cluster for battery device (batteryPowered=true)', () => {
    const ep = makeBaseEndpoint('battery-ep');
    finalizeEndpoint(ep, { batteryPowered: true });
    expect(ep.hasClusterServer('PowerSource')).toBe(true);
  });

  test('should add PowerSource cluster when batteryPowered is omitted', () => {
    const ep = makeBaseEndpoint('default-ep');
    finalizeEndpoint(ep, {});
    expect(ep.hasClusterServer('PowerSource')).toBe(true);
  });
});
