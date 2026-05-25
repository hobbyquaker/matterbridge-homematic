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
});
