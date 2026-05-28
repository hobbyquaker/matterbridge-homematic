import path from 'node:path';

import { MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';
import { describe, expect, test, vi } from 'vitest';

import type { CcuChannelInfo } from '../src/ccu/types.js';
import { TemplatePlatform } from '../src/module.js';

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

function makeLogger(): AnsiLogger {
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

function makeConfig(): PlatformConfig {
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

function makePlatform(config: PlatformConfig = makeConfig()): TemplatePlatform {
  return new TemplatePlatform(makeMatterbridge(), makeLogger(), config);
}

describe('TemplatePlatform config selection migration', () => {
  test('should remove disabled-interface channels from select devices and blacklist', async () => {
    const config = makeConfig();
    config.blackList = ['BidCos-RF:SWITCH:LEQ1234567:1', 'BidCos-RF:SHUTTER_CONTACT:OLD9999999:1', 'LEQ1234567:1', 'Legacy Switch'];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});
    const logInfoSpy = vi.spyOn(instance.log, 'info');

    instance.setSelectDevice('BidCos-RF:SWITCH:LEQ1234567:1', 'Legacy Switch', undefined, 'switch');
    instance.setSelectDevice('SWITCH:LEQ1234567:1', 'Legacy Switch', undefined, 'switch');
    instance.setSelectDevice('BidCos-RF:SHUTTER_CONTACT:OLD9999999:1', 'Stale Legacy Contact', undefined, 'switch');

    const channels: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'name' | 'type'>[] = [
      { address: 'LEQ1234567:1', interfaceName: 'BidCos-RF', name: 'Legacy Switch', type: 'SWITCH' },
    ];

    // @ts-expect-error Accessing private method for testing purposes
    await instance.cleanupDisabledInterfaceChannels(channels, ['HmIP-RF']);

    expect(config.blackList).toEqual([]);
    expect(instance.getSelectDevices()).toEqual([]);
    expect(saveConfigSpy).toHaveBeenCalledExactlyOnceWith(config);
    expect(logInfoSpy).toHaveBeenCalledWith('Disabled interface cleanup summary: removedSelectDevices=3 removedBlacklistEntries=4');
  });

  test('should migrate address-based whitelist and blacklist entries to ReGa names when discovered', () => {
    const config = makeConfig();
    config.whiteList = ['001558A99EFDBA:1'];
    config.blackList = ['00391F29B5C076:1'];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});
    const logInfoSpy = vi.spyOn(instance.log, 'info');

    const channels: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'name'>[] = [
      { address: '001558A99EFDBA:1', interfaceName: 'HmIP-RF', name: 'TFK Bad:1' },
      { address: '00391F29B5C076:1', interfaceName: 'HmIP-RF', name: 'Thermostat Wohnzimmer:1' },
    ];

    // @ts-expect-error Accessing private method for testing purposes
    instance.syncChannelListEntriesWithRegaNames(channels, ['HmIP-RF']);

    expect(config.whiteList).toEqual(['TFK Bad:1']);
    expect(config.blackList).toEqual(['Thermostat Wohnzimmer:1']);
    expect(saveConfigSpy).toHaveBeenCalledExactlyOnceWith(config);
    expect(logInfoSpy).toHaveBeenCalledWith('ReGa list sync summary: migrated=2 skippedNoName=0 skippedDisabledInterface=0');
  });

  test('should avoid duplicate ReGa names when migrating address-based entries', () => {
    const config = makeConfig();
    config.blackList = ['00391F29B5C076:1', 'Thermostat Wohnzimmer:1'];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});

    const channels: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'name'>[] = [{ address: '00391F29B5C076:1', interfaceName: 'HmIP-RF', name: 'Thermostat Wohnzimmer:1' }];

    // @ts-expect-error Accessing private method for testing purposes
    instance.syncChannelListEntriesWithRegaNames(channels, ['HmIP-RF']);

    expect(config.blackList).toEqual(['Thermostat Wohnzimmer:1']);
    expect(saveConfigSpy).toHaveBeenCalledOnce();
  });

  test('should report skipped entries for missing ReGa names and disabled interfaces', () => {
    const config = makeConfig();
    config.blackList = ['001558A99EFDBA:1', '00391F29B5C076:1'];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});
    const logInfoSpy = vi.spyOn(instance.log, 'info');

    const channels: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'name'>[] = [
      { address: '001558A99EFDBA:1', interfaceName: 'HmIP-RF', name: '' },
      { address: '00391F29B5C076:1', interfaceName: 'BidCos-RF', name: 'Thermostat Wohnzimmer:1' },
    ];

    // @ts-expect-error Accessing private method for testing purposes
    instance.syncChannelListEntriesWithRegaNames(channels, ['HmIP-RF']);

    expect(config.blackList).toEqual(['001558A99EFDBA:1', '00391F29B5C076:1']);
    expect(saveConfigSpy).not.toHaveBeenCalled();
    expect(logInfoSpy).toHaveBeenCalledWith('ReGa list sync summary: migrated=0 skippedNoName=1 skippedDisabledInterface=1');
  });
});
