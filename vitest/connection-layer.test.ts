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

describe('CcuConnectionLayer.createRpcCallbackServer binrpc close shim', () => {
  test('should shim close() on a binrpc server that lacks it', () => {
    const innerClose = vi.fn();
    const fakeServer = {
      on: vi.fn(),
      server: { close: innerClose },
      // intentionally no close() — mirrors real binrpc Server
    };
    const mockFactory = {
      createClient: vi.fn(),
      createServer: vi.fn().mockReturnValue(fakeServer),
    };

    const layer = new CcuConnectionLayer(makeConfig(), makeLogger());
    const result = (layer as any).createRpcCallbackServer('binrpc', mockFactory, '0.0.0.0', 2048);

    expect(typeof result.close).toBe('function');
    const cb = vi.fn();
    result.close(cb);
    expect(innerClose).toHaveBeenCalledWith(cb);
  });

  test('should not overwrite close() when the server already has one', () => {
    const directClose = vi.fn();
    const fakeServer = {
      on: vi.fn(),
      close: directClose,
    };
    const mockFactory = {
      createClient: vi.fn(),
      createServer: vi.fn().mockReturnValue(fakeServer),
    };

    const layer = new CcuConnectionLayer(makeConfig(), makeLogger());
    const result = (layer as any).createRpcCallbackServer('xmlrpc', mockFactory, '0.0.0.0', 2049);

    const cb = vi.fn();
    result.close(cb);
    expect(directClose).toHaveBeenCalledWith(cb);
  });
});

describe('CcuConnectionLayer discovery diagnostics logging', () => {
  test('should log per-interface device and channel counts when a newDevices callback arrives', () => {
    const log = makeLogger();
    const layer = new CcuConnectionLayer(makeConfig(), log);
    (layer as any).initIdToInterface.set('mb_CUxD', 'CUxD');

    (layer as any).handleRpcCallback('newDevices', [
      'mb_CUxD',
      [
        { ADDRESS: 'CUX1234567', TYPE: 'HM-LC-Sw1-Pl' },
        { ADDRESS: 'CUX1234567:1', TYPE: 'SWITCH' },
        { ADDRESS: 'CUX1234567:2', TYPE: 'SWITCH' },
      ],
    ]);

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('newDevices <- iface=CUxD devices=1 channels=2 entries=3'));
  });

  test('should log the interface when answering an inbound listDevices callback', () => {
    const log = makeLogger();
    const layer = new CcuConnectionLayer(makeConfig(), log);
    (layer as any).initIdToInterface.set('mb_BidCos_RF', 'BidCos-RF');

    const result = (layer as any).handleRpcCallback('listDevices', ['mb_BidCos_RF']);

    expect(result).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('listDevices callback <- iface=BidCos-RF'));
  });

  test('should warn with the missing interfaces when waitForNewDevices times out', async () => {
    const log = makeLogger();
    const layer = new CcuConnectionLayer(makeConfig(), log);
    (layer as any).clients.set('BidCos-RF', {});
    (layer as any).clients.set('CUxD', {});
    (layer as any).newDevicesReceivedByIface.add('BidCos-RF');

    await layer.waitForNewDevices(10);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no newDevices callback received from: CUxD'));
  });

  test('should log a per-interface channel summary after a cache refresh', async () => {
    const log = makeLogger();
    const layer = new CcuConnectionLayer(makeConfig(), log);
    (layer as any).clients.set('BidCos-RF', {});
    (layer as any).clients.set('CUxD', {});
    (layer as any).waitForNewDevices = vi.fn().mockResolvedValue(undefined);
    (layer as any).getRegaChannelNameMap = vi.fn().mockResolvedValue(new Map());
    (layer as any).saveCache = vi.fn().mockResolvedValue(undefined);
    (layer as any).newDevicesPayloadByIface.set('BidCos-RF', [
      { ADDRESS: 'LEQ1234567', TYPE: 'HM-LC-Sw1-FM' },
      { ADDRESS: 'LEQ1234567:1', TYPE: 'SWITCH' },
    ]);
    (layer as any).newDevicesReceivedByIface.add('BidCos-RF');

    await (layer as any).refreshChannelsCache();

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Discovery channels per interface: BidCos-RF=1 CUxD=0(cached)'));
  });

  test('should ingest a device list via the active listDevices pull', async () => {
    const log = makeLogger();
    const layer = new CcuConnectionLayer(makeConfig(), log);
    (layer as any).clients.set('CUxD', {});
    (layer as any).callRpc = vi.fn().mockResolvedValue([
      { ADDRESS: 'CUX1234567', TYPE: 'HM-LC-Sw1-Pl' },
      { ADDRESS: 'CUX1234567:1', TYPE: 'SWITCH' },
    ]);

    await (layer as any).pullDeviceList('CUxD');

    expect((layer as any).callRpc).toHaveBeenCalledWith('CUxD', 'listDevices', []);
    expect((layer as any).newDevicesPayloadByIface.get('CUxD')).toHaveLength(2);
    expect((layer as any).newDevicesReceivedByIface.has('CUxD')).toBe(true);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('listDevices result <- iface=CUxD devices=1 channels=1 entries=2'));
  });

  test('should not overwrite a non-empty device list with an empty one', async () => {
    const log = makeLogger();
    const layer = new CcuConnectionLayer(makeConfig(), log);
    (layer as any).initIdToInterface.set('mb_CUxD', 'CUxD');
    (layer as any).handleRpcCallback('newDevices', ['mb_CUxD', [{ ADDRESS: 'CUX1234567', TYPE: 'HM-LC-Sw1-Pl' }]]);

    (layer as any).callRpc = vi.fn().mockResolvedValue([]);
    await (layer as any).pullDeviceList('CUxD');

    expect((layer as any).newDevicesPayloadByIface.get('CUxD')).toHaveLength(1);
  });

  test('should keep cached channels for interfaces that delivered no device list this session', async () => {
    const log = makeLogger();
    const layer = new CcuConnectionLayer(makeConfig(), log);
    (layer as any).clients.set('BidCos-RF', {});
    (layer as any).clients.set('CUxD', {});
    (layer as any).waitForNewDevices = vi.fn().mockResolvedValue(undefined);
    (layer as any).getRegaChannelNameMap = vi.fn().mockResolvedValue(new Map());
    (layer as any).saveCache = vi.fn().mockResolvedValue(undefined);
    (layer as any).cache = {
      channels: [makeChannel('CUxD', 'CUX1234567:1'), makeChannel('CUxD', 'CUX1234567:2'), makeChannel('BidCos-RF', 'LEQ1234567:1')],
      nameMap: {},
      timestamp: Date.now(),
    };
    // BidCos-RF delivered a fresh (single-channel) list this session; CUxD stayed silent.
    (layer as any).newDevicesPayloadByIface.set('BidCos-RF', [
      { ADDRESS: 'LEQ1234567', TYPE: 'HM-LC-Sw1-FM' },
      { ADDRESS: 'LEQ1234567:1', TYPE: 'SWITCH' },
    ]);
    (layer as any).newDevicesReceivedByIface.add('BidCos-RF');

    await (layer as any).refreshChannelsCache();

    const cuxdChannels = (layer as any).cache.channels.filter((c: CcuChannelInfo) => c.interfaceName === 'CUxD');
    expect(cuxdChannels).toHaveLength(2);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('keeping 2 cached channel(s) for iface=CUxD'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Discovery channels per interface: BidCos-RF=1 CUxD=2(cached)'));
  });
});
