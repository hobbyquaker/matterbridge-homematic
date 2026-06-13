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
  test('should remove disabled-interface channels from select list, clean whiteList, and pre-blacklist them', async () => {
    const config = makeConfig();
    // One channel was previously enabled (in whiteList), one was already blacklisted.
    config.whiteList = ['BidCos-RF:SWITCH:LEQ1234567:1'];
    config.blackList = ['BidCos-RF:SHUTTER_CONTACT:OLD9999999:1'];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});
    const logInfoSpy = vi.spyOn(instance.log, 'info');

    instance.setSelectDevice('BidCos-RF:SWITCH:LEQ1234567:1', 'Legacy Switch', undefined, 'switch');
    instance.setSelectDevice('BidCos-RF:SHUTTER_CONTACT:OLD9999999:1', 'Old Contact', undefined, 'switch');

    // @ts-expect-error Accessing private method for testing purposes
    await instance.cleanupDisabledInterfaceChannels(['HmIP-RF']);

    // Both select entries removed.
    expect(instance.getSelectDevices()).toEqual([]);
    // WhiteList entry for the disabled interface cleaned.
    expect(config.whiteList).toEqual([]);
    // Both channels pre-disabled: the blacklisted one remains, the whitelisted one is added.
    expect(config.blackList).toEqual(expect.arrayContaining(['BidCos-RF:SWITCH:LEQ1234567:1', 'BidCos-RF:SHUTTER_CONTACT:OLD9999999:1']));
    expect((config.blackList as string[]).length).toBe(2);
    expect(saveConfigSpy).toHaveBeenCalledExactlyOnceWith(config);
    expect(logInfoSpy).toHaveBeenCalledWith(expect.stringContaining('removedSelectDevices=2'));
  });

  test('should pre-disable channels from all disabled interfaces, not just one', async () => {
    const config = makeConfig();
    config.blackList = [];
    config.whiteList = [];

    const instance = makePlatform(config);
    vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});

    instance.setSelectDevice('BidCos-RF:SWITCH:LEQ0000001:1', 'BidCos Switch', undefined, 'switch');
    instance.setSelectDevice('HmIP-RF:SWITCH:000111222333:1', 'HmIP Switch', undefined, 'switch');
    instance.setSelectDevice('VirtualDevices:SWITCH:V0000001:1', 'Virtual Switch', undefined, 'switch');

    // Only HmIP-RF is enabled; BidCos-RF and VirtualDevices are disabled.
    // @ts-expect-error Accessing private method for testing purposes
    await instance.cleanupDisabledInterfaceChannels(['HmIP-RF']);

    const remaining = instance.getSelectDevices().map((d) => d.serial);
    expect(remaining).toEqual(['HmIP-RF:SWITCH:000111222333:1']);
    expect(config.blackList as string[]).toEqual(expect.arrayContaining(['BidCos-RF:SWITCH:LEQ0000001:1', 'VirtualDevices:SWITCH:V0000001:1']));
    expect((config.blackList as string[]).length).toBe(2);
  });

  test('re-enable scenario: pre-blacklisted channels come back disabled on next discovery', async () => {
    // Simulate the state left by a cleanup run: the channel's serial is in the blackList
    // (placed there by the previous cleanup), no select entry exists yet.
    const config = makeConfig();
    config.blackList = ['BidCos-RF:SWITCH:LEQ1234567:1'];

    const instance = makePlatform(config);
    vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});
    // No select entry — as if clearDeviceSelect removed it in the previous session.
    instance.getSelectDevice = vi.fn(() => undefined);

    // autoBlacklistIfNew must not modify the blackList (channel is already there).
    // @ts-expect-error Accessing private method for testing purposes
    const added = instance.autoBlacklistIfNew('BidCos-RF:SWITCH:LEQ1234567:1', {
      address: 'LEQ1234567:1',
      interfaceName: 'BidCos-RF',
      type: 'SWITCH',
    });

    expect(added).toBe(false);
    // BlackList unchanged — channel stays disabled.
    expect(config.blackList as string[]).toEqual(['BidCos-RF:SWITCH:LEQ1234567:1']);
  });

  test('should not touch channels from enabled interfaces', async () => {
    const config = makeConfig();
    // HmIP-RF channel is whitelisted (enabled); BidCos-RF channel is whitelisted (enabled) and should be moved to blackList.
    config.whiteList = ['HmIP-RF:SWITCH:AAABBB:1', 'BidCos-RF:SWITCH:LEQ0000001:1'];
    config.blackList = [];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});

    instance.setSelectDevice('HmIP-RF:SWITCH:AAABBB:1', 'HmIP enabled', undefined, 'switch');
    instance.setSelectDevice('BidCos-RF:SWITCH:LEQ0000001:1', 'BidCos disabled', undefined, 'switch');

    // BidCos-RF disabled, HmIP-RF enabled.
    // @ts-expect-error Accessing private method for testing purposes
    await instance.cleanupDisabledInterfaceChannels(['HmIP-RF']);

    // HmIP-RF entry untouched in select list.
    expect(instance.getSelectDevices().map((d) => d.serial)).toContain('HmIP-RF:SWITCH:AAABBB:1');
    // HmIP-RF whiteList entry untouched.
    expect(config.whiteList as string[]).toContain('HmIP-RF:SWITCH:AAABBB:1');
    // BidCos-RF whiteList entry removed, moved to blackList.
    expect(config.whiteList as string[]).not.toContain('BidCos-RF:SWITCH:LEQ0000001:1');
    expect(config.blackList as string[]).toContain('BidCos-RF:SWITCH:LEQ0000001:1');
    // Config saved because whiteList changed.
    expect(saveConfigSpy).toHaveBeenCalled();
  });

  test('should not save config when no disabled interfaces have registered channels', async () => {
    const config = makeConfig();

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});

    // No select devices registered for any interface.

    // @ts-expect-error Accessing private method for testing purposes
    await instance.cleanupDisabledInterfaceChannels(['HmIP-RF']);

    expect(saveConfigSpy).not.toHaveBeenCalled();
  });

  test('should migrate address-based entries to selectSerial in both white and blacklist', () => {
    const config = makeConfig();
    config.whiteList = ['001558A99EFDBA:1'];
    config.blackList = ['00391F29B5C076:1'];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});

    const channels: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'type' | 'name'>[] = [
      { address: '001558A99EFDBA:1', interfaceName: 'HmIP-RF', type: 'SHUTTER_CONTACT', name: 'TFK Bad' },
      { address: '00391F29B5C076:1', interfaceName: 'HmIP-RF', type: 'SWITCH', name: 'Thermostat Wohnzimmer' },
    ];

    // @ts-expect-error Accessing private method for testing purposes
    instance.migrateSelectListEntriesToSerial(channels);

    expect(config.whiteList).toEqual(['HmIP-RF:CONTACT:001558A99EFDBA:1']);
    expect(config.blackList).toEqual(['HmIP-RF:SWITCH:00391F29B5C076:1']);
    expect(saveConfigSpy).toHaveBeenCalledExactlyOnceWith(config);
  });

  test('should migrate name-based entries to selectSerial', () => {
    const config = makeConfig();
    config.blackList = ['Küchenlicht'];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});

    const channels: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'type' | 'name'>[] = [
      { address: 'OEQ0854602:1', interfaceName: 'BidCos-RF', type: 'SWITCH', name: 'Küchenlicht' },
    ];

    // @ts-expect-error Accessing private method for testing purposes
    instance.migrateSelectListEntriesToSerial(channels);

    expect(config.blackList).toEqual(['BidCos-RF:SWITCH:OEQ0854602:1']);
    expect(saveConfigSpy).toHaveBeenCalledExactlyOnceWith(config);
  });

  test('should not migrate a name shared by multiple channels (ambiguous)', () => {
    const config = makeConfig();
    config.blackList = ['Licht'];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});

    const channels: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'type' | 'name'>[] = [
      { address: 'OEQ0854602:1', interfaceName: 'HmIP-RF', type: 'SWITCH', name: 'Licht' },
      { address: 'OEQ9999999:1', interfaceName: 'HmIP-RF', type: 'SWITCH', name: 'Licht' },
    ];

    // @ts-expect-error Accessing private method for testing purposes
    instance.migrateSelectListEntriesToSerial(channels);

    expect(config.blackList).toEqual(['Licht']);
    expect(saveConfigSpy).not.toHaveBeenCalled();
  });

  test('should pass through already-selectSerial entries unchanged', () => {
    const config = makeConfig();
    config.blackList = ['HmIP-RF:SWITCH:OEQ0854602:1'];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});

    const channels: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'type' | 'name'>[] = [
      { address: 'OEQ0854602:1', interfaceName: 'HmIP-RF', type: 'SWITCH', name: 'Kitchen Light' },
    ];

    // @ts-expect-error Accessing private method for testing purposes
    instance.migrateSelectListEntriesToSerial(channels);

    expect(config.blackList).toEqual(['HmIP-RF:SWITCH:OEQ0854602:1']);
    expect(saveConfigSpy).not.toHaveBeenCalled();
  });

  test('should pass through entries with no matching channel unchanged', () => {
    const config = makeConfig();
    config.blackList = ['some-unknown-entry'];

    const instance = makePlatform(config);
    const saveConfigSpy = vi.spyOn(instance, 'saveConfig').mockImplementation(() => {});

    // @ts-expect-error Accessing private method for testing purposes
    instance.migrateSelectListEntriesToSerial([]);

    expect(config.blackList).toEqual(['some-unknown-entry']);
    expect(saveConfigSpy).not.toHaveBeenCalled();
  });
});
