/**
 * Unit and integration tests for UX-2: auto-disable newly discovered channels when
 * `newDevicesDefaultEnabled` is set to false in the plugin configuration.
 *
 * The feature centres on two collaborating mechanisms:
 *   1. `autoBlacklistIfNew(selectSerial, channel)` — private helper that adds a selectSerial
 *      to the in-memory blacklist when the channel has never been registered before.
 *   2. `discoverDevices()` — calls the helper during channel discovery and persists the
 *      updated blacklist via `saveConfig` at the end.
 */

import path from 'node:path';

import { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

import type { CcuChannelInfo } from '../src/ccu/types.js';
import { TemplatePlatform } from '../src/module.js';

const mockLog = {
  fatal: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  notice: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as AnsiLogger;

const mockMatterbridge: PlatformMatterbridge = {
  systemInformation: {
    ipv4Address: '192.168.1.1',
    ipv6Address: 'fd78:cbf8:4939:746:a96:8277:346f:416e',
    osRelease: 'x.y.z',
    nodeVersion: '22.10.0',
  },
  rootDirectory: path.join('.cache', 'vitest', 'AutoDisable'),
  homeDirectory: path.join('.cache', 'vitest', 'AutoDisable'),
  matterbridgeDirectory: path.join('.cache', 'vitest', 'AutoDisable', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'vitest', 'AutoDisable', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('.cache', 'vitest', 'AutoDisable', '.mattercert'),
  globalModulesDirectory: path.join('.cache', 'vitest', 'AutoDisable', 'node_modules'),
  matterbridgeVersion: '3.5.0',
  matterbridgeLatestVersion: '3.5.0',
  matterbridgeDevVersion: '3.5.0',
  bridgeMode: 'bridge',
  restartMode: '',
  aggregatorVendorId: VendorId(0xfff1),
  aggregatorVendorName: 'Matterbridge',
  aggregatorProductId: 0x8000,
  aggregatorProductName: 'Matterbridge aggregator',
  registerVirtualDevice: vi.fn(),
  addBridgedEndpoint: vi.fn(),
  removeBridgedEndpoint: vi.fn(),
  removeAllBridgedEndpoints: vi.fn(),
} as unknown as PlatformMatterbridge;

vi.spyOn(AnsiLogger.prototype, 'log').mockImplementation(() => {});

/** Build a fresh platform instance for each test. */
function createInstance(extraConfig: Partial<PlatformConfig> = {}): TemplatePlatform {
  const config: PlatformConfig = {
    name: 'matterbridge-homematic',
    type: 'DynamicPlatform',
    version: '0.0.1',
    whiteList: [],
    blackList: [],
    debug: false,
    unregisterOnShutdown: false,
    ...extraConfig,
  };
  return new TemplatePlatform(mockMatterbridge, mockLog, config);
}

/** A minimal channel descriptor used across multiple tests. */
const switchChannel: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'type'> = {
  address: 'ABC12345:1',
  interfaceName: 'HmIP-RF',
  type: 'SWITCH',
};

const SWITCH_SELECT_SERIAL = 'HmIP-RF:SWITCH:ABC12345:1';

// ---------------------------------------------------------------------------
// Unit tests: autoBlacklistIfNew helper
// ---------------------------------------------------------------------------

describe('autoBlacklistIfNew', () => {
  let instance: TemplatePlatform;

  beforeEach(() => {
    vi.clearAllMocks();
    instance = createInstance();
  });

  it('should add an unknown channel to the blacklist and return true', () => {
    // @ts-expect-error Accessing private method for testing purposes
    instance.getSelectDevice = vi.fn(() => undefined);

    // @ts-expect-error Accessing private method for testing purposes
    const added = instance.autoBlacklistIfNew(SWITCH_SELECT_SERIAL, switchChannel);

    expect(added).toBe(true);
    expect(instance.config.blackList as string[]).toContain(SWITCH_SELECT_SERIAL);
  });

  it('should return false and not modify the blacklist when the canonical selectSerial is already registered', () => {
    // @ts-expect-error Accessing private method for testing purposes
    instance.getSelectDevice = vi.fn((key: string) => (key === SWITCH_SELECT_SERIAL ? { name: 'existing' } : undefined));

    // @ts-expect-error Accessing private method for testing purposes
    const added = instance.autoBlacklistIfNew(SWITCH_SELECT_SERIAL, switchChannel);

    expect(added).toBe(false);
    expect((instance.config.blackList as string[]).length).toBe(0);
  });

  it('should return false when channel is known under a legacy key', () => {
    // The legacy keys include the plain address 'ABC12345:1'.
    // @ts-expect-error Accessing private method for testing purposes
    instance.getSelectDevice = vi.fn((key: string) => (key === 'ABC12345:1' ? { name: 'legacy-entry' } : undefined));

    // @ts-expect-error Accessing private method for testing purposes
    const added = instance.autoBlacklistIfNew(SWITCH_SELECT_SERIAL, switchChannel);

    expect(added).toBe(false);
    expect((instance.config.blackList as string[]).length).toBe(0);
  });

  it('should return false without duplicating when selectSerial is already in the blacklist', () => {
    instance.config.blackList = [SWITCH_SELECT_SERIAL];
    // @ts-expect-error Accessing private method for testing purposes
    instance.getSelectDevice = vi.fn(() => undefined);

    // @ts-expect-error Accessing private method for testing purposes
    const added = instance.autoBlacklistIfNew(SWITCH_SELECT_SERIAL, switchChannel);

    expect(added).toBe(false);
    expect((instance.config.blackList as string[]).length).toBe(1); // no duplicate
  });
});

// ---------------------------------------------------------------------------
// Integration tests: discoverDevices with newDevicesDefaultEnabled=false
// ---------------------------------------------------------------------------

describe('discoverDevices auto-disable', () => {
  let instance: TemplatePlatform;

  const fakeRawChannel: CcuChannelInfo = {
    address: 'XYZ99999:1',
    deviceAddress: 'XYZ99999',
    channelIndex: 1,
    type: 'SWITCH',
    deviceType: 'HmIP-BSM',
    interfaceName: 'HmIP-RF',
    batteryPowered: false,
  };

  const NEW_SERIAL = 'HmIP-RF:SWITCH:XYZ99999:1';

  function injectFakeCcuConnection(inst: TemplatePlatform): void {
    // @ts-expect-error Accessing private field for testing purposes
    inst.ccuConnection = {
      discoverChannels: vi.fn(async () => [fakeRawChannel]),
      waitForNewDevices: vi.fn(async () => {}),
      getCachedChannels: vi.fn(() => [fakeRawChannel]),
      getStatusSnapshot: vi.fn(() => ({ enabledInterfaces: new Set<string>(['HmIP-RF']) })),
    };
    // Stub heavy private helpers that depend on real CCU/RPC state.
    // @ts-expect-error Accessing private method for testing purposes
    inst.updateMainsPoweredDeviceSet = vi.fn();
    // @ts-expect-error Accessing private method for testing purposes
    inst.primeBatteryHintsFromRpc = vi.fn(async () => {});
    // @ts-expect-error Accessing private method for testing purposes
    inst.cleanupDisabledInterfaceChannels = vi.fn(async () => {});
    // @ts-expect-error Accessing private method for testing purposes
    inst.syncChannelListEntriesWithRegaNames = vi.fn();
    // @ts-expect-error Accessing private method for testing purposes
    inst.setSelectDevice = vi.fn();
    // @ts-expect-error Accessing private method for testing purposes
    inst.clearDeviceSelect = vi.fn();
    // @ts-expect-error Accessing private method for testing purposes
    inst.saveConfig = vi.fn();
    // Channel is not yet known (no prior select entry).
    // @ts-expect-error Accessing private method for testing purposes
    inst.getSelectDevice = vi.fn(() => undefined);
    // Always report channels as disabled to prevent registerDevice/wireChannelEndpoint
    // from being invoked — those paths require a real Matterbridge Matter node.
    // @ts-expect-error Accessing private method for testing purposes
    inst.validateDevice = vi.fn(() => false);
    // Prevent any Matter node interaction in case a channel is somehow passed isChannelEnabled.
    vi.spyOn(inst, 'registerDevice').mockResolvedValue(undefined as unknown as void);
    // @ts-expect-error Accessing private method for testing purposes
    inst.wireChannelEndpoint = vi.fn(async () => {});
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not auto-blacklist on the first install even when newDevicesDefaultEnabled is false', async () => {
    instance = createInstance({ newDevicesDefaultEnabled: false } as Partial<PlatformConfig>);
    injectFakeCcuConnection(instance);
    // First install: no select devices registered yet.
    // @ts-expect-error Accessing private method for testing purposes
    instance.getSelectDevices = vi.fn(() => []);

    // @ts-expect-error Accessing private method for testing purposes
    await instance.discoverDevices();

    expect((instance.config.blackList as string[]).length).toBe(0);
    // @ts-expect-error Accessing private method for testing purposes
    expect(instance.saveConfig).not.toHaveBeenCalled();
  });

  it('should auto-blacklist a new channel and call saveConfig when newDevicesDefaultEnabled is false', async () => {
    instance = createInstance({ newDevicesDefaultEnabled: false } as Partial<PlatformConfig>);
    injectFakeCcuConnection(instance);
    // Subsequent run: at least one select device exists (not first install).
    // @ts-expect-error Accessing private method for testing purposes
    instance.getSelectDevices = vi.fn(() => [{ name: 'some-existing-device' }]);

    // @ts-expect-error Accessing private method for testing purposes
    await instance.discoverDevices();

    expect(instance.config.blackList as string[]).toContain(NEW_SERIAL);
    // @ts-expect-error Accessing private method for testing purposes
    expect(instance.saveConfig).toHaveBeenCalled();
  });

  it('should not auto-blacklist when newDevicesDefaultEnabled is true (default behavior)', async () => {
    instance = createInstance({ newDevicesDefaultEnabled: true } as Partial<PlatformConfig>);
    injectFakeCcuConnection(instance);
    // @ts-expect-error Accessing private method for testing purposes
    instance.getSelectDevices = vi.fn(() => [{ name: 'some-existing-device' }]);

    // @ts-expect-error Accessing private method for testing purposes
    await instance.discoverDevices();

    expect((instance.config.blackList as string[]).length).toBe(0);
    // @ts-expect-error Accessing private method for testing purposes
    expect(instance.saveConfig).not.toHaveBeenCalled();
  });

  it('should not auto-blacklist a channel that is already known from a previous run', async () => {
    instance = createInstance({ newDevicesDefaultEnabled: false } as Partial<PlatformConfig>);
    injectFakeCcuConnection(instance);
    // @ts-expect-error Accessing private method for testing purposes
    instance.getSelectDevices = vi.fn(() => [{ name: 'some-existing-device' }]);
    // Channel is already known under its canonical selectSerial.
    // @ts-expect-error Accessing private method for testing purposes
    instance.getSelectDevice = vi.fn((key: string) => (key === NEW_SERIAL ? { name: NEW_SERIAL } : undefined));

    // @ts-expect-error Accessing private method for testing purposes
    await instance.discoverDevices();

    expect((instance.config.blackList as string[]).length).toBe(0);
    // @ts-expect-error Accessing private method for testing purposes
    expect(instance.saveConfig).not.toHaveBeenCalled();
  });
});
