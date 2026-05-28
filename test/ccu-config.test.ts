import { PlatformConfig } from 'matterbridge';

import { parseCcuConnectionConfig } from '../src/ccu/config.js';

describe('CCU config parser', () => {
  test('should return default ccu values when config is minimal', () => {
    const config = {
      name: 'matterbridge-homematic',
      type: 'DynamicPlatform',
      version: '0.0.1',
    } as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    expect(parsed.host).toBe('');
    expect(parsed.regaEnabled).toBe(true);
    expect(parsed.bcrfEnabled).toBe(true);
    expect(parsed.bcwiEnabled).toBe(false);
    expect(parsed.iprfEnabled).toBe(true);
    expect(parsed.virtEnabled).toBe(true);
    expect(parsed.cuxdEnabled).toBe(false);
    expect(parsed.rpcBinPort).toBe(2048);
    expect(parsed.rpcXmlPort).toBe(2049);
    expect(parsed.queueTimeout).toBe(5000);
    expect(parsed.queuePause).toBe(250);
  });

  test('should map explicit ccu values when config contains overrides', () => {
    const config = {
      name: 'matterbridge-homematic',
      type: 'DynamicPlatform',
      version: '0.0.1',
      host: 'ccu.local',
      regaEnabled: false,
      bcrfEnabled: false,
      bcwiEnabled: true,
      iprfEnabled: true,
      virtEnabled: false,
      cuxdEnabled: true,
      regaPoll: false,
      regaInterval: 15,
      rpcPingTimeout: 45,
      rpcInitAddress: '192.168.0.20',
      rpcServerHost: '192.168.0.10',
      rpcBinPort: 3048,
      rpcXmlPort: 3049,
      tls: true,
      inSecure: true,
      authentication: true,
      username: 'user',
      password: 'pass',
      queueTimeout: 7000,
      queuePause: 300,
    } as unknown as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    expect(parsed.host).toBe('ccu.local');
    expect(parsed.regaEnabled).toBe(false);
    expect(parsed.bcrfEnabled).toBe(false);
    expect(parsed.bcwiEnabled).toBe(true);
    expect(parsed.virtEnabled).toBe(false);
    expect(parsed.cuxdEnabled).toBe(true);
    expect(parsed.regaPoll).toBe(false);
    expect(parsed.regaInterval).toBe(15);
    expect(parsed.rpcPingTimeout).toBe(45);
    expect(parsed.rpcInitAddress).toBe('192.168.0.20');
    expect(parsed.rpcServerHost).toBe('192.168.0.10');
    expect(parsed.rpcBinPort).toBe(3048);
    expect(parsed.rpcXmlPort).toBe(3049);
    expect(parsed.tls).toBe(true);
    expect(parsed.inSecure).toBe(true);
    expect(parsed.authentication).toBe(true);
    expect(parsed.username).toBe('user');
    expect(parsed.password).toBe('pass');
    expect(parsed.queueTimeout).toBe(7000);
    expect(parsed.queuePause).toBe(300);
  });

  test('should populate rega sub-object with defaults when no rega fields are set', () => {
    const config = { name: 'matterbridge-homematic', type: 'DynamicPlatform', version: '0.0.1' } as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    expect(parsed.rega.enabled).toBe(true);
    expect(parsed.rega.syncChannelNames).toBe(true);
    expect(parsed.rega.createMatterDevicesForVariables).toBe(false);
    expect(parsed.rega.createMatterDevicesForPrograms).toBe(false);
    expect(parsed.rega.variablesPollingInterval).toBe(0);
    expect(parsed.rega.virtualKeyForPseudoPush).toBe('');
    expect(parsed.rega.legacyPollEnabled).toBe(true);
    expect(parsed.rega.legacyPollInterval).toBe(30);
  });

  test('should populate rega sub-object from legacy and new fields when overrides are provided', () => {
    const config = {
      name: 'matterbridge-homematic',
      type: 'DynamicPlatform',
      version: '0.0.1',
      regaEnabled: false,
      regaPoll: false,
      regaInterval: 15,
      syncChannelNames: false,
      createMatterDevicesForVariables: true,
      createMatterDevicesForPrograms: true,
      regaVariablesPollingInterval: 60,
      virtualKeyForRegaPseudoPush: 'CUxD.CUX2801001:1.PRESS_SHORT',
    } as unknown as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    expect(parsed.rega.enabled).toBe(false);
    expect(parsed.rega.syncChannelNames).toBe(false);
    expect(parsed.rega.createMatterDevicesForVariables).toBe(true);
    expect(parsed.rega.createMatterDevicesForPrograms).toBe(true);
    expect(parsed.rega.variablesPollingInterval).toBe(60);
    expect(parsed.rega.virtualKeyForPseudoPush).toBe('CUxD.CUX2801001:1.PRESS_SHORT');
    expect(parsed.rega.legacyPollEnabled).toBe(false);
    expect(parsed.rega.legacyPollInterval).toBe(15);
  });

  test('should populate logging sub-object with defaults when no logging fields are set', () => {
    const config = { name: 'matterbridge-homematic', type: 'DynamicPlatform', version: '0.0.1' } as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    expect(parsed.logging.logRpcEvents).toBe(false);
    expect(parsed.logging.truncatePayloadsToSingleLine).toBe(false);
  });

  test('should populate logging sub-object from explicit fields when overrides are provided', () => {
    const config = {
      name: 'matterbridge-homematic',
      type: 'DynamicPlatform',
      version: '0.0.1',
      logRpcEvents: true,
      truncatePayloadsToSingleLine: true,
    } as unknown as PlatformConfig;

    const parsed = parseCcuConnectionConfig(config);

    expect(parsed.logging.logRpcEvents).toBe(true);
    expect(parsed.logging.truncatePayloadsToSingleLine).toBe(true);
  });
});
