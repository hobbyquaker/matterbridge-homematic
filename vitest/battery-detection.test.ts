/**
 * Unit tests for battery detection hints.
 *
 * @file vitest/battery-detection.test.ts
 */

import path from 'node:path';

import { MatterbridgeEndpoint, type PlatformConfig, type PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';
import { describe, expect, test, vi } from 'vitest';

import { CcuConnectionLayer } from '../src/ccu/connection-layer.js';
import type { CcuChannelInfo, CcuConnectionConfig, CcuLogger } from '../src/ccu/types.js';
import { TemplatePlatform } from '../src/module.js';

function makeConnectionConfig(overrides: Partial<CcuConnectionConfig> = {}): CcuConnectionConfig {
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
    ...overrides,
  };
}

function makeConnectionLogger(): CcuLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeMatterbridge(): PlatformMatterbridge {
  return {
    systemInformation: {
      ipv4Address: '192.168.1.1',
      ipv6Address: 'fd78:cbf8:4939:746:a96:8277:346f:416e',
      osRelease: 'x.y.z',
      nodeVersion: '22.10.0',
    },
    rootDirectory: path.join('.cache', 'vitest', 'TemplatePlugin'),
    homeDirectory: path.join('.cache', 'vitest', 'TemplatePlugin'),
    matterbridgeDirectory: path.join('.cache', 'vitest', 'TemplatePlugin', '.matterbridge'),
    matterbridgePluginDirectory: path.join('.cache', 'vitest', 'TemplatePlugin', 'Matterbridge'),
    matterbridgeCertDirectory: path.join('.cache', 'vitest', 'TemplatePlugin', '.mattercert'),
    globalModulesDirectory: path.join('.cache', 'vitest', 'TemplatePlugin', 'node_modules'),
    matterbridgeVersion: '3.5.0',
    matterbridgeLatestVersion: '3.5.0',
    matterbridgeDevVersion: '3.5.0',
    bridgeMode: 'bridge',
    restartMode: '',
    aggregatorVendorId: VendorId(0xfff1),
    aggregatorVendorName: 'Matterbridge',
    aggregatorProductId: 0x8000,
    aggregatorProductName: 'Matterbridge aggregator',
    registerVirtualDevice: vi.fn(async (_name: string, _type: 'light' | 'outlet' | 'switch' | 'mounted_switch', _callback: () => Promise<void>) => {}),
    addBridgedEndpoint: vi.fn(async (_pluginName: string, _device: MatterbridgeEndpoint) => {}),
    removeBridgedEndpoint: vi.fn(async (_pluginName: string, _device: MatterbridgeEndpoint) => {}),
    removeAllBridgedEndpoints: vi.fn(async (_pluginName: string) => {}),
  } as unknown as PlatformMatterbridge;
}

function makePlatformConfig(): PlatformConfig {
  return {
    name: 'matterbridge-homematic',
    type: 'DynamicPlatform',
    version: '0.0.1',
    whiteList: [],
    blackList: [],
    debug: false,
    unregisterOnShutdown: false,
  };
}

function makePlatformLog(): AnsiLogger {
  return {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    notice: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    logName: 'Homematic',
  } as unknown as AnsiLogger;
}

describe('battery detection hints', () => {
  test('should not persist a false battery hint from newDevices when LOWBAT marker is absent', () => {
    const layer = new CcuConnectionLayer(makeConnectionConfig(), makeConnectionLogger());

    (layer as any).initIdToInterface.set('mb_HmIP_RF', 'HmIP-RF');
    (layer as any).processNewDevicesCallback([
      'mb_HmIP_RF',
      [
        { ADDRESS: '000197098D9306', TYPE: 'HMIP-WRC2' },
        { ADDRESS: '000197098D9306:0', TYPE: 'MAINTENANCE' },
      ],
    ]);

    expect((layer as any).deviceBatteryHints.get('000197098D9306')).toBeUndefined();
  });

  test('should allow paramset probing to override an earlier false battery hint', async () => {
    const platform = new TemplatePlatform(makeMatterbridge(), makePlatformLog(), makePlatformConfig());
    const callRpc = vi.fn().mockResolvedValue({ LOW_BAT: { TYPE: 'BOOL' } });
    const channels: CcuChannelInfo[] = [
      {
        address: '000197098D9306:0',
        deviceAddress: '000197098D9306',
        channelIndex: 0,
        type: 'MAINTENANCE',
        deviceType: 'HMIP-WRC2',
        interfaceName: 'HmIP-RF',
        name: 'HmIP-WRC2:0',
        batteryPowered: false,
      },
    ];

    (platform as any).ccuConnection = { callRpc };
    (platform as any).deviceBatteryHints.set('000197098D9306', false);

    await (platform as any).primeBatteryHintsFromRpc(channels);

    expect(callRpc).toHaveBeenCalledWith('HmIP-RF', 'getParamsetDescription', ['000197098D9306:0', 'VALUES']);
    expect((platform as any).deviceBatteryHints.get('000197098D9306')).toBe(true);
    expect(channels[0]?.batteryPowered).toBe(true);
  });
});
