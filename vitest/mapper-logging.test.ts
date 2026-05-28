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

function makePlatform(): TemplatePlatform {
  return new TemplatePlatform(makeMatterbridge(), makeLogger(), makeConfig());
}

describe('TemplatePlatform mapper logging', () => {
  test('should log the selected channel mapper on info level with the ReGa name', () => {
    const instance = makePlatform();
    const logInfoSpy = vi.spyOn(instance.log, 'info');

    const channel: Pick<CcuChannelInfo, 'address' | 'name' | 'type'> = {
      address: '00391F29B5C076:1',
      name: 'Thermostat Wohnzimmer:1',
      type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
    };

    // @ts-expect-error Accessing private method for testing purposes
    instance.logChannelMapperSelection(channel, 'Thermostat Wohnzimmer:1');

    expect(logInfoSpy).toHaveBeenCalledWith(
      'Channel mapper: channel=00391F29B5C076:1 name="Thermostat Wohnzimmer:1" type=HEATING_CLIMATECONTROL_TRANSCEIVER mapper=heating-climatecontrol-transceiver',
    );
  });

  test('should log the selected device mapper on info level with ReGa names', () => {
    const instance = makePlatform();
    const logInfoSpy = vi.spyOn(instance.log, 'info');

    const deviceChannels: Pick<CcuChannelInfo, 'name'>[] = [{ name: 'Thermostat Wohnzimmer:1' }, { name: 'Humidity Wohnzimmer:1' }, { name: 'Thermostat Wohnzimmer:1' }];

    // @ts-expect-error Accessing private method for testing purposes
    instance.logDeviceMapperSelection('00391F29B5C076', 'HmIP-WTH', deviceChannels);

    expect(logInfoSpy).toHaveBeenCalledWith('Device mapper: device=00391F29B5C076 names="Thermostat Wohnzimmer:1 | Humidity Wohnzimmer:1" deviceType=HmIP-WTH mapper=hmip-wth');
  });
});
