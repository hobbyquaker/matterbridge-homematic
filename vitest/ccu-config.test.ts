/**
 * Unit tests for CCU config parsing edge cases — string-valued inputs.
 *
 * @file vitest/ccu-config.test.ts
 */

import { PlatformConfig } from 'matterbridge';
import { describe, expect, test } from 'vitest';

import { parseCcuConnectionConfig } from '../src/ccu/config.js';

describe('parseCcuConnectionConfig — string-valued inputs', () => {
  test('should parse string "true"/"false" into booleans', () => {
    const config = {
      name: 'matterbridge-homematic',
      type: 'DynamicPlatform',
      version: '0.0.1',
      bcrfEnabled: 'true',
      iprfEnabled: 'false',
      virtEnabled: 'true',
      cuxdEnabled: 'false',
    } as unknown as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    expect(parsed.bcrfEnabled).toBe(true);
    expect(parsed.iprfEnabled).toBe(false);
    expect(parsed.virtEnabled).toBe(true);
    expect(parsed.cuxdEnabled).toBe(false);
  });

  test('should parse string numeric values into numbers', () => {
    const config = {
      name: 'matterbridge-homematic',
      type: 'DynamicPlatform',
      version: '0.0.1',
      rpcBinPort: '9001',
      rpcXmlPort: '9002',
      queueTimeout: '8000',
      queuePause: '500',
    } as unknown as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    expect(parsed.rpcBinPort).toBe(9001);
    expect(parsed.rpcXmlPort).toBe(9002);
    expect(parsed.queueTimeout).toBe(8000);
    expect(parsed.queuePause).toBe(500);
  });

  test('should fall back to defaults when string number values are not finite', () => {
    const config = {
      name: 'matterbridge-homematic',
      type: 'DynamicPlatform',
      version: '0.0.1',
      rpcBinPort: 'notanumber',
      rpcXmlPort: 'NaN',
    } as unknown as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    expect(parsed.rpcBinPort).toBe(2048);
    expect(parsed.rpcXmlPort).toBe(2049);
  });

  test('should fall back to the boolean default when the string is unrecognized', () => {
    const config = {
      name: 'matterbridge-homematic',
      type: 'DynamicPlatform',
      version: '0.0.1',
      bcrfEnabled: 'yes',
      iprfEnabled: 'no',
    } as unknown as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    // 'yes' / 'no' are not valid boolean strings — fall back to the defaults (true and true)
    expect(parsed.bcrfEnabled).toBe(true);
    expect(parsed.iprfEnabled).toBe(true);
  });

  test('should handle native boolean and number values without string conversion', () => {
    const config = {
      name: 'matterbridge-homematic',
      type: 'DynamicPlatform',
      version: '0.0.1',
      bcrfEnabled: true,
      iprfEnabled: false,
      rpcBinPort: 9001,
      rpcXmlPort: 9002,
      host: 'ccu.local',
    } as unknown as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    expect(parsed.bcrfEnabled).toBe(true);
    expect(parsed.iprfEnabled).toBe(false);
    expect(parsed.rpcBinPort).toBe(9001);
    expect(parsed.rpcXmlPort).toBe(9002);
    expect(parsed.host).toBe('ccu.local');
  });
});
