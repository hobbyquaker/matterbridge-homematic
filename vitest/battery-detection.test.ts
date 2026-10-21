/**
 * Unit tests for battery detection hints.
 *
 * @file vitest/battery-detection.test.ts
 */

import path from 'node:path';

import { MatterbridgeEndpoint, onOffLight, type PlatformConfig, type PlatformMatterbridge, windowCovering } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';
import { describe, expect, test, vi } from 'vitest';

import { CcuConnectionLayer } from '../src/ccu/connection-layer.js';
import { finalizeEndpoint } from '../src/ccu/mapper-utils.js';
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

/**
 * Build a finalized endpoint the way the mappers do and register it for its device address.
 *
 * @param {TemplatePlatform} platform The platform under test.
 * @param {string} deviceAddress The Homematic device address.
 * @param {boolean} batteryPowered Whether the device has LOW_BAT (selects the PowerSource cluster).
 * @returns {MatterbridgeEndpoint} The registered endpoint, with getAttribute/updateAttribute mocked.
 */
function registerDeviceEndpoint(platform: TemplatePlatform, deviceAddress: string, batteryPowered: boolean): MatterbridgeEndpoint {
  const deviceType = batteryPowered ? onOffLight : windowCovering;
  const endpoint = new MatterbridgeEndpoint(deviceType, { id: `hm-${deviceAddress}-1` }).createDefaultBridgedDeviceBasicInformationClusterServer(
    'Test',
    `SN-${deviceAddress}`,
    0xfff1,
    'Homematic',
    'TEST',
  );
  finalizeEndpoint(endpoint, { batteryPowered });
  vi.spyOn(endpoint, 'getAttribute').mockReturnValue(undefined);
  vi.spyOn(endpoint, 'updateAttribute').mockResolvedValue(true);
  (platform as any).deviceAddressToDevice.set(deviceAddress, endpoint);
  return endpoint;
}

describe('battery attributes follow the PowerSource cluster (#6)', () => {
  test('should not write battery attributes for a mains-powered HmIP-FBL (wired PowerSource)', async () => {
    const platform = new TemplatePlatform(makeMatterbridge(), makePlatformLog(), makePlatformConfig());
    // HmIP-FBL: MAINTENANCE has OPERATING_VOLTAGE but no LOW_BAT, so paramset probing leaves it mains-powered.
    const callRpc = vi.fn().mockResolvedValue({ OPERATING_VOLTAGE: { TYPE: 'FLOAT' }, UNREACH: { TYPE: 'BOOL' } });
    (platform as any).ccuConnection = { callRpc };
    const channels: CcuChannelInfo[] = [
      {
        address: '0013A409A39865:0',
        deviceAddress: '0013A409A39865',
        channelIndex: 0,
        type: 'MAINTENANCE',
        deviceType: 'HmIP-FBL',
        interfaceName: 'HmIP-RF',
        name: 'HmIP-FBL:0',
      },
    ];
    await (platform as any).primeBatteryHintsFromRpc(channels);
    expect((platform as any).deviceBatteryHints.get('0013A409A39865')).toBeUndefined();
    expect(channels[0]?.batteryPowered).toBeUndefined();

    const endpoint = registerDeviceEndpoint(platform, '0013A409A39865', false);
    expect(endpoint.hasClusterServer('PowerSource')).toBe(true);
    expect(endpoint.hasAttributeServer('PowerSource', 'batChargeLevel')).toBe(false);

    await (platform as any).handleRpcEventOperatingVoltage({ iface: 'HmIP-RF', channel: '0013A409A39865:0', datapoint: 'OPERATING_VOLTAGE', value: 230.4 });
    await (platform as any).setDeviceBatteryLowState('0013A409A39865', false, 'startup service message');
    await (platform as any).setDeviceBatteryLowState('0013A409A39865', true, 'RPC event');

    expect(endpoint.updateAttribute).not.toHaveBeenCalled();
    expect((platform as any).log.debug).toHaveBeenCalledWith(expect.stringContaining('with a wired PowerSource cluster'));
  });

  test('should write battery attributes for a battery-powered HmIP-SWDO (battery PowerSource)', async () => {
    const platform = new TemplatePlatform(makeMatterbridge(), makePlatformLog(), makePlatformConfig());
    const callRpc = vi.fn().mockResolvedValue({ LOW_BAT: { TYPE: 'BOOL' }, OPERATING_VOLTAGE: { TYPE: 'FLOAT' } });
    (platform as any).ccuConnection = { callRpc };
    const channels: CcuChannelInfo[] = [
      {
        address: '000A1B2C3D4E5F:0',
        deviceAddress: '000A1B2C3D4E5F',
        channelIndex: 0,
        type: 'MAINTENANCE',
        deviceType: 'HMIP-SWDO',
        interfaceName: 'HmIP-RF',
        name: 'HMIP-SWDO:0',
      },
    ];
    await (platform as any).primeBatteryHintsFromRpc(channels);
    expect((platform as any).deviceBatteryHints.get('000A1B2C3D4E5F')).toBe(true);

    const endpoint = registerDeviceEndpoint(platform, '000A1B2C3D4E5F', true);
    expect(endpoint.hasAttributeServer('PowerSource', 'batChargeLevel')).toBe(true);
    (platform as any).discoveredChannels = channels;

    await (platform as any).handleRpcEventOperatingVoltage({ iface: 'HmIP-RF', channel: '000A1B2C3D4E5F:0', datapoint: 'OPERATING_VOLTAGE', value: 2.5 });
    await (platform as any).setDeviceBatteryLowState('000A1B2C3D4E5F', true, 'RPC event');

    expect(endpoint.updateAttribute).toHaveBeenCalledWith('PowerSource', 'batPercentRemaining', 100);
    expect(endpoint.updateAttribute).toHaveBeenCalledWith('PowerSource', 'batChargeLevel', 1);
  });
});
