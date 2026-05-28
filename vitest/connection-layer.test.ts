/**
 * Unit tests for CCU connection-layer channel discovery.
 *
 * @file vitest/connection-layer.test.ts
 */

import { describe, expect, test, vi } from 'vitest';

import { CcuConnectionLayer } from '../src/ccu/connection-layer.js';
import type { CcuChannelInfo, CcuConnectionConfig, CcuLogger } from '../src/ccu/types.js';

function makeConfig(overrides: Partial<CcuConnectionConfig> = {}): CcuConnectionConfig {
  return {
    host: 'ccu.local',
    regaEnabled: false,
    bcrfEnabled: true,
    bcwiEnabled: false,
    iprfEnabled: true,
    virtEnabled: false,
    cuxdEnabled: false,
    regaPoll: false,
    regaInterval: 30,
    rpcPingTimeout: 60,
    rpcInitAddress: '',
    rpcServerHost: '0.0.0.0',
    rpcBinPort: 2048,
    rpcXmlPort: 2049,
    tls: false,
    inSecure: false,
    authentication: false,
    username: '',
    password: '',
    queueTimeout: 5000,
    queuePause: 250,
    rega: {
      enabled: false,
      syncChannelNames: true,
      createMatterDevicesForVariables: false,
      createMatterDevicesForPrograms: false,
      variablesPollingInterval: 0,
      virtualKeyForPseudoPush: '',
      legacyPollEnabled: false,
      legacyPollInterval: 30,
    },
    logging: { logRpcEvents: false, truncatePayloadsToSingleLine: false },
    ...overrides,
  };
}

function makeLogger(): CcuLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeChannel(interfaceName: CcuChannelInfo['interfaceName'], address: string): CcuChannelInfo {
  return {
    address,
    deviceAddress: address.split(':')[0],
    channelIndex: Number(address.split(':')[1]),
    type: 'SWITCH',
    deviceType: interfaceName === 'HmIP-RF' ? 'HmIP-BSM' : 'HM-LC-Sw1-FM',
    interfaceName,
    name: address,
    batteryPowered: false,
  };
}

describe('CcuConnectionLayer.discoverChannels', () => {
  test('should filter cached channels from disabled interfaces before returning discovery results', async () => {
    const layer = new CcuConnectionLayer(makeConfig({ bcrfEnabled: false, iprfEnabled: true }), makeLogger());

    const refreshChannelsCache = vi.fn().mockResolvedValue(undefined);
    (layer as any).refreshChannelsCache = refreshChannelsCache;
    (layer as any).cache = {
      channels: [makeChannel('BidCos-RF', 'LEQ1234567:1'), makeChannel('HmIP-RF', '000A1B2C3D:1')],
      nameMap: {},
      timestamp: Date.now(),
    };

    const channels = await layer.discoverChannels();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.interfaceName).toBe('HmIP-RF');
    expect(channels[0]?.address).toBe('000A1B2C3D:1');
    expect(refreshChannelsCache).toHaveBeenCalledOnce();
  });

  test('should await an initial refresh when the cache is empty', async () => {
    const layer = new CcuConnectionLayer(makeConfig({ iprfEnabled: true }), makeLogger());

    const refreshChannelsCache = vi.fn(async () => {
      (layer as any).cache = {
        channels: [makeChannel('HmIP-RF', '000A1B2C3D:1')],
        nameMap: {},
        timestamp: Date.now(),
      };
    });

    (layer as any).loadCache = vi.fn().mockResolvedValue(undefined);
    (layer as any).refreshChannelsCache = refreshChannelsCache;
    (layer as any).cache = {
      channels: [],
      nameMap: {},
      timestamp: 0,
    };

    const channels = await layer.discoverChannels();

    expect(refreshChannelsCache).toHaveBeenCalledOnce();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.interfaceName).toBe('HmIP-RF');
    expect(channels[0]?.address).toBe('000A1B2C3D:1');
  });
});
