/**
 * Unit tests for the channel-mapper and device-mapper registry infrastructure.
 *
 * Covers:
 * - `channelTypeToKey` and `deviceTypeToKey` sanitization helpers
 * - `CHANNEL_MAPPERS` registry completeness
 * - `DEVICE_MAPPERS` registry
 * - `createEndpointForChannel` dispatch
 * - `getDeviceMapper` lookup
 * - Individual channel mappers produce correctly typed endpoints
 *
 * @file vitest/mapper.test.ts
 */

import { MatterbridgeEndpoint } from 'matterbridge';

import { CHANNEL_MAPPERS, channelTypeToKey } from '../src/ccu/channel-mapper/index.js';
import { createEndpointForChannel, getDeviceMapper } from '../src/ccu/device-mapper.js';
import { DEVICE_MAPPERS, deviceTypeToKey } from '../src/ccu/device-mapper/index.js';
import type { CcuChannelInfo, SupportedChannelType } from '../src/ccu/types.js';
import { SUPPORTED_CHANNEL_TYPES } from '../src/ccu/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<CcuChannelInfo> & { type: SupportedChannelType }): CcuChannelInfo & { type: SupportedChannelType } {
  return {
    address: 'ABC123456:1',
    deviceAddress: 'ABC123456',
    deviceType: 'HmIP-TEST',
    channelIndex: 1,
    interfaceName: 'HmIP-RF',
    batteryPowered: false,
    name: 'Test Channel',
    ...overrides,
  } as CcuChannelInfo & { type: SupportedChannelType };
}

const VENDOR_ID = 0xfff1;

// ---------------------------------------------------------------------------
// channelTypeToKey
// ---------------------------------------------------------------------------

describe('channelTypeToKey', () => {
  test('should lowercase the channel type', () => {
    expect(channelTypeToKey('SWITCH')).toBe('switch');
  });

  test('should replace underscores with hyphens', () => {
    expect(channelTypeToKey('SHUTTER_CONTACT')).toBe('shutter-contact');
  });

  test('should handle multi-underscore types', () => {
    expect(channelTypeToKey('HEATING_CLIMATECONTROL_TRANSCEIVER')).toBe('heating-climatecontrol-transceiver');
  });

  test('should handle types without underscores', () => {
    expect(channelTypeToKey('BLIND')).toBe('blind');
    expect(channelTypeToKey('WEATHER')).toBe('weather');
    expect(channelTypeToKey('KEYMATIC')).toBe('keymatic');
  });
});

// ---------------------------------------------------------------------------
// deviceTypeToKey
// ---------------------------------------------------------------------------

describe('deviceTypeToKey', () => {
  test('should lowercase and convert hyphens', () => {
    expect(deviceTypeToKey('HmIP-BSM')).toBe('hmip-bsm');
  });

  test('should strip leading and trailing hyphens', () => {
    expect(deviceTypeToKey('-FOO-')).toBe('foo');
  });

  test('should collapse multiple non-alphanumeric chars into single hyphen', () => {
    expect(deviceTypeToKey('HmIP--TEST')).toBe('hmip-test');
  });

  test('should remove trailing special characters (e.g. plus sign)', () => {
    expect(deviceTypeToKey('HmIP-STE2+')).toBe('hmip-ste2');
  });
});

// ---------------------------------------------------------------------------
// CHANNEL_MAPPERS registry completeness
// ---------------------------------------------------------------------------

describe('CHANNEL_MAPPERS', () => {
  test('should have an entry for every supported channel type', () => {
    for (const channelType of SUPPORTED_CHANNEL_TYPES) {
      const key = channelTypeToKey(channelType);
      expect(CHANNEL_MAPPERS).toHaveProperty(key);
    }
  });

  test('should have exactly the same number of entries as SUPPORTED_CHANNEL_TYPES', () => {
    expect(Object.keys(CHANNEL_MAPPERS).length).toBe(SUPPORTED_CHANNEL_TYPES.length);
  });

  test('each mapper should be a function', () => {
    for (const mapper of Object.values(CHANNEL_MAPPERS)) {
      expect(typeof mapper).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// DEVICE_MAPPERS registry
// ---------------------------------------------------------------------------

describe('DEVICE_MAPPERS', () => {
  test('should contain the HmIP-BSM device mapper', () => {
    expect(DEVICE_MAPPERS).toHaveProperty('hmip-bsm');
    expect(typeof DEVICE_MAPPERS['hmip-bsm']).toBe('function');
  });

  test('should contain device mappers for HmIP-WTH family', () => {
    expect(DEVICE_MAPPERS).toHaveProperty('hmip-wth');
    expect(DEVICE_MAPPERS).toHaveProperty('hmip-wth-2');
    expect(DEVICE_MAPPERS).toHaveProperty('hmip-wth-b');
    expect(typeof DEVICE_MAPPERS['hmip-wth']).toBe('function');
  });

  test('should contain device mappers for HmIP-STHD / STH family', () => {
    expect(DEVICE_MAPPERS).toHaveProperty('hmip-sthd');
    expect(DEVICE_MAPPERS).toHaveProperty('hmip-sth');
    expect(typeof DEVICE_MAPPERS['hmip-sthd']).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// getDeviceMapper
// ---------------------------------------------------------------------------

describe('getDeviceMapper', () => {
  test('should return the HmIP-BSM mapper for "HmIP-BSM"', () => {
    const mapper = getDeviceMapper('HmIP-BSM');
    expect(mapper).toBeDefined();
    expect(typeof mapper).toBe('function');
  });

  test('should be case-insensitive (returns same mapper for lowercase)', () => {
    expect(getDeviceMapper('hmip-bsm')).toBeDefined();
  });

  test('should return undefined for an unknown device type', () => {
    expect(getDeviceMapper('HmIP-UNKNOWN-DEVICE-TYPE')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createEndpointForChannel dispatch
// ---------------------------------------------------------------------------

describe('createEndpointForChannel', () => {
  test('should return a MatterbridgeEndpoint for SHUTTER_CONTACT', () => {
    const channel = makeChannel({ type: 'SHUTTER_CONTACT' });
    const ep = createEndpointForChannel(channel, VENDOR_ID);
    expect(ep).toBeInstanceOf(MatterbridgeEndpoint);
  });

  test('should return a MatterbridgeEndpoint for SWITCH', () => {
    const channel = makeChannel({ type: 'SWITCH' });
    const ep = createEndpointForChannel(channel, VENDOR_ID);
    expect(ep).toBeInstanceOf(MatterbridgeEndpoint);
  });

  test('should return a MatterbridgeEndpoint for DIMMER', () => {
    const channel = makeChannel({ type: 'DIMMER' });
    const ep = createEndpointForChannel(channel, VENDOR_ID);
    expect(ep).toBeInstanceOf(MatterbridgeEndpoint);
  });

  test('should return a MatterbridgeEndpoint for WEATHER', () => {
    const channel = makeChannel({ type: 'WEATHER' });
    const ep = createEndpointForChannel(channel, VENDOR_ID);
    expect(ep).toBeInstanceOf(MatterbridgeEndpoint);
  });

  test('should respect switchMatterType option for SWITCH', () => {
    const channel = makeChannel({ type: 'SWITCH' });
    const epLight = createEndpointForChannel(channel, VENDOR_ID, { switchMatterType: 'light' });
    const epOutlet = createEndpointForChannel(channel, VENDOR_ID, { switchMatterType: 'outlet' });
    const epSwitch = createEndpointForChannel(channel, VENDOR_ID, { switchMatterType: 'switch' });
    // All should produce valid endpoints (different device type codes internally)
    expect(epLight).toBeInstanceOf(MatterbridgeEndpoint);
    expect(epOutlet).toBeInstanceOf(MatterbridgeEndpoint);
    expect(epSwitch).toBeInstanceOf(MatterbridgeEndpoint);
  });
});

// ---------------------------------------------------------------------------
// Individual channel mapper spot checks
// ---------------------------------------------------------------------------

describe('channel mapper: BLIND', () => {
  test('should produce a MatterbridgeEndpoint', () => {
    const channel = makeChannel({ type: 'BLIND', tiltSupported: false });
    const ep = createEndpointForChannel(channel, VENDOR_ID);
    expect(ep).toBeInstanceOf(MatterbridgeEndpoint);
  });

  test('should produce a MatterbridgeEndpoint when tilt is supported', () => {
    const channel = makeChannel({ type: 'BLIND', tiltSupported: true });
    const ep = createEndpointForChannel(channel, VENDOR_ID);
    expect(ep).toBeInstanceOf(MatterbridgeEndpoint);
  });
});

describe('channel mapper: MOTION_DETECTOR', () => {
  test('should produce a MatterbridgeEndpoint', () => {
    const channel = makeChannel({ type: 'MOTION_DETECTOR' });
    const ep = createEndpointForChannel(channel, VENDOR_ID);
    expect(ep).toBeInstanceOf(MatterbridgeEndpoint);
  });
});

describe('channel mapper: KEYMATIC', () => {
  test('should produce a MatterbridgeEndpoint', () => {
    const channel = makeChannel({ type: 'KEYMATIC' });
    const ep = createEndpointForChannel(channel, VENDOR_ID);
    expect(ep).toBeInstanceOf(MatterbridgeEndpoint);
  });
});

// ---------------------------------------------------------------------------
// Device mapper: HmIP-WTH / WTH-2 / WTH-B
// ---------------------------------------------------------------------------

describe('device mapper: HmIP-WTH', () => {
  function makeWthChannels(deviceType: string) {
    return [
      makeChannel({
        type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
        deviceType,
        address: 'WTH123456:1',
        deviceAddress: 'WTH123456',
        channelIndex: 1,
      }),
    ];
  }

  for (const deviceType of ['HmIP-WTH', 'HmIP-WTH-2', 'HmIP-WTH-B']) {
    test(`should be registered for ${deviceType}`, () => {
      expect(getDeviceMapper(deviceType)).toBeDefined();
    });

    test(`should return one combined endpoint for ${deviceType}`, () => {
      const mapper = getDeviceMapper(deviceType)!;
      const channels = makeWthChannels(deviceType);
      const results = mapper(channels, VENDOR_ID, {});
      expect(results).toHaveLength(1);
      expect(results[0].endpoint).toBeInstanceOf(MatterbridgeEndpoint);
    });

    test(`the endpoint for ${deviceType} should have Thermostat cluster`, () => {
      const mapper = getDeviceMapper(deviceType)!;
      const channels = makeWthChannels(deviceType);
      const [{ endpoint: ep }] = mapper(channels, VENDOR_ID, {});
      expect(ep.hasClusterServer('Thermostat')).toBe(true);
    });

    test(`the endpoint for ${deviceType} should have RelativeHumidityMeasurement cluster`, () => {
      const mapper = getDeviceMapper(deviceType)!;
      const channels = makeWthChannels(deviceType);
      const [{ endpoint: ep }] = mapper(channels, VENDOR_ID, {});
      expect(ep.hasClusterServer('RelativeHumidityMeasurement')).toBe(true);
    });

    test(`the combined endpoint id for ${deviceType} should use the standard channel id`, () => {
      const mapper = getDeviceMapper(deviceType)!;
      const channels = makeWthChannels(deviceType);
      const [{ endpoint: ep }] = mapper(channels, VENDOR_ID, {});
      expect(ep.id).not.toMatch(/-humidity$/);
    });

    test(`the result for ${deviceType} should associate the endpoint with the heating channel`, () => {
      const mapper = getDeviceMapper(deviceType)!;
      const channels = makeWthChannels(deviceType);
      const [{ channels: mappedChannels }] = mapper(channels, VENDOR_ID, {});
      expect(mappedChannels).toHaveLength(1);
      expect(mappedChannels[0].type).toBe('HEATING_CLIMATECONTROL_TRANSCEIVER');
    });
  }

  test('should return empty array when no HEATING_CLIMATECONTROL_TRANSCEIVER channel present', () => {
    const mapper = getDeviceMapper('HmIP-WTH')!;
    const results = mapper([], VENDOR_ID, {});
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Device mapper: HmIP-STHD / STH
// ---------------------------------------------------------------------------

describe('device mapper: HmIP-STHD', () => {
  function makeSthdChannels(deviceType: string) {
    return [
      makeChannel({
        type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
        deviceType,
        address: 'STHD123456:1',
        deviceAddress: 'STHD123456',
        channelIndex: 1,
      }),
    ];
  }

  for (const deviceType of ['HmIP-STHD', 'HmIP-STH']) {
    test(`should be registered for ${deviceType}`, () => {
      expect(getDeviceMapper(deviceType)).toBeDefined();
    });

    test(`should return one combined endpoint for ${deviceType}`, () => {
      const mapper = getDeviceMapper(deviceType)!;
      const channels = makeSthdChannels(deviceType);
      const results = mapper(channels, VENDOR_ID, {});
      expect(results).toHaveLength(1);
    });

    test(`the endpoint for ${deviceType} should have RelativeHumidityMeasurement cluster`, () => {
      const mapper = getDeviceMapper(deviceType)!;
      const channels = makeSthdChannels(deviceType);
      const [{ endpoint: ep }] = mapper(channels, VENDOR_ID, {});
      expect(ep.hasClusterServer('RelativeHumidityMeasurement')).toBe(true);
    });
  }
});
