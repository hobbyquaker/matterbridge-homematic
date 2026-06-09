import path from 'node:path';

import { MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

import type { CcuChannelInfo } from '../src/ccu/types.js';
import { TemplatePlatform } from '../src/module.js';

const mockLog = {
  fatal: vi.fn((message: string, ...parameters: any[]) => {}),
  error: vi.fn((message: string, ...parameters: any[]) => {}),
  warn: vi.fn((message: string, ...parameters: any[]) => {}),
  notice: vi.fn((message: string, ...parameters: any[]) => {}),
  info: vi.fn((message: string, ...parameters: any[]) => {}),
  debug: vi.fn((message: string, ...parameters: any[]) => {}),
} as unknown as AnsiLogger;

const mockMatterbridge: PlatformMatterbridge = {
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
  // Mocked methods
  registerVirtualDevice: vi.fn(async (name: string, type: 'light' | 'outlet' | 'switch' | 'mounted_switch', callback: () => Promise<void>) => {}),
  addBridgedEndpoint: vi.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeBridgedEndpoint: vi.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeAllBridgedEndpoints: vi.fn(async (pluginName: string) => {}),
} as unknown as PlatformMatterbridge;

const mockConfig: PlatformConfig = {
  name: 'matterbridge-homematic',
  type: 'DynamicPlatform',
  version: '0.0.1',
  whiteList: [],
  blackList: [],
  debug: false,
  unregisterOnShutdown: false,
};

const loggerLogSpy = vi.spyOn(AnsiLogger.prototype, 'log').mockImplementation((level: string, message: string, ...parameters: any[]) => {});

describe('Matterbridge Plugin Template', () => {
  let instance: TemplatePlatform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('should throw an error if matterbridge is not the required version', async () => {
    // @ts-expect-error Ignore readonly for testing purposes
    mockMatterbridge.matterbridgeVersion = '2.0.0'; // Simulate an older version
    expect(() => new TemplatePlatform(mockMatterbridge, mockLog, mockConfig)).toThrow(
      'This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from 2.0.0 to the latest version in the frontend.',
    );
    // @ts-expect-error Ignore readonly for testing purposes
    mockMatterbridge.matterbridgeVersion = '3.4.0';
  });

  it('should create an instance of the platform', async () => {
    instance = (await import('../src/module.js')).default(mockMatterbridge, mockLog, mockConfig) as TemplatePlatform;
    // @ts-expect-error Accessing private method for testing purposes
    instance.setMatterNode(
      // @ts-expect-error Accessing private method for testing purposes
      mockMatterbridge.addBridgedEndpoint,
      // @ts-expect-error Accessing private method for testing purposes
      mockMatterbridge.removeBridgedEndpoint,
      // @ts-expect-error Accessing private method for testing purposes
      mockMatterbridge.removeAllBridgedEndpoints,
      // @ts-expect-error Accessing private method for testing purposes
      mockMatterbridge.registerVirtualDevice,
    );
    expect(instance).toBeInstanceOf(TemplatePlatform);
    expect(instance.matterbridge).toBe(mockMatterbridge);
    expect(instance.log).toBe(mockLog);
    expect(instance.config).toBe(mockConfig);
    expect(instance.matterbridge.matterbridgeVersion).toBe('3.4.0');
    expect(mockLog.info).toHaveBeenCalledWith('Initializing Platform...');
  });

  it('should start with node devices selected', async () => {
    mockConfig.whiteList = ['No devices'];
    await instance.onStart('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: Jest');
    await instance.onStart();
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: none');
  });

  it('should start', async () => {
    mockConfig.whiteList = [];
    await instance.onStart('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: Jest');
    await instance.onStart();
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: none');
  });

  it('should call the command handlers', async () => {
    for (const device of instance.getDevices()) {
      if (device.hasClusterServer('onOff')) {
        await device.executeCommandHandler('on', {}, 'onOff', {} as any, device);
        await device.executeCommandHandler('off', {}, 'onOff', {} as any, device);
      }
    }
    // No real CCU in unit tests — no devices are registered, so no handlers are invoked.
    expect(instance.getDevices()).toHaveLength(0);
  });

  it('should configure', async () => {
    await instance.onConfigure();
    expect(mockLog.info).toHaveBeenCalledWith('onConfigure called');
    // No real CCU in unit tests — no devices are registered, so no 'Configuring device' logs.
  });

  it('should change logger level', async () => {
    await instance.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(mockLog.info).toHaveBeenCalledWith('onChangeLoggerLevel called with: debug');
  });

  it('should shutdown', async () => {
    await instance.onShutdown('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: Jest');

    // Mock the unregisterOnShutdown behavior
    mockConfig.unregisterOnShutdown = true;
    await instance.onShutdown();
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: none');
    // @ts-expect-error Accessing private method for testing purposes
    expect(mockMatterbridge.removeAllBridgedEndpoints).toHaveBeenCalled();
    mockConfig.unregisterOnShutdown = false;
  });

  it('should validate enabled channels using the current select serial format', async () => {
    const channel: CcuChannelInfo = {
      address: '000A1B2C3D:1',
      deviceAddress: '000A1B2C3D',
      channelIndex: 1,
      type: 'SWITCH',
      deviceType: 'HmIP-BSM',
      interfaceName: 'HmIP-RF',
      name: 'Kitchen Light',
      batteryPowered: false,
    };

    const validateDevice = vi.fn((candidates: string[]) => candidates.includes('HmIP-RF:SWITCH:000A1B2C3D:1'));
    instance.validateDevice = validateDevice;

    // @ts-expect-error Accessing private method for testing purposes
    const enabled = instance.isChannelEnabled(channel, undefined, 'Kitchen Light');

    expect(enabled).toBe(true);
    expect(validateDevice).toHaveBeenCalledWith(expect.arrayContaining(['HmIP-RF:SWITCH:000A1B2C3D:1']), false);
  });
});

// ---------------------------------------------------------------------------
// Private method coverage — accesses internals via (inst as any) casts
// ---------------------------------------------------------------------------

describe('TemplatePlatform private method coverage', () => {
  let inst: TemplatePlatform;

  /**
   * Build a minimal mock endpoint with only the specified clusters available.
   *
   * @param {string[]} clusters Cluster names to mark as present on the endpoint.
   * @param {Record<string, unknown>} attrValues Pre-seeded attribute values keyed as `"Cluster.attr"`.
   */
  const makeEndpoint = (clusters: string[], attrValues: Record<string, unknown> = {}) =>
    ({
      deviceName: 'MockDevice',
      id: 'mock-id',
      number: 1,
      hasClusterServer: (name: string) => clusters.includes(name),
      getAttribute: vi.fn(async (cluster: string, attr: string) => attrValues[`${cluster}.${attr}`] ?? null),
      updateAttribute: vi.fn(async () => {}),
      triggerSwitchEvent: vi.fn(async () => {}),
      setWindowCoveringStatus: vi.fn(async () => {}),
      setWindowCoveringTargetAndCurrentPosition: vi.fn(async () => {}),
    }) as unknown as MatterbridgeEndpoint;

  beforeAll(() => {
    vi.spyOn(AnsiLogger.prototype, 'log').mockImplementation(() => {});
    inst = new TemplatePlatform(mockMatterbridge, mockLog, mockConfig);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // === Pure helper methods ===

  test('extractDeviceAddressFromRpcChannel returns device address for :0 channel', () => {
    expect((inst as any).extractDeviceAddressFromRpcChannel('AABB001122:0')).toBe('AABB001122');
  });

  test('extractDeviceAddressFromRpcChannel returns undefined for non-zero channel index', () => {
    expect((inst as any).extractDeviceAddressFromRpcChannel('AABB001122:1')).toBeUndefined();
  });

  test('extractDeviceAddressFromRpcChannel returns undefined for non-string input', () => {
    expect((inst as any).extractDeviceAddressFromRpcChannel(null)).toBeUndefined();
    expect((inst as any).extractDeviceAddressFromRpcChannel(0)).toBeUndefined();
  });

  test('extractDeviceAddressFromServiceMessageValue returns device address for address:channel', () => {
    expect((inst as any).extractDeviceAddressFromServiceMessageValue('AABB001122:1')).toBe('AABB001122');
  });

  test('extractDeviceAddressFromServiceMessageValue returns value when no colon and long enough', () => {
    expect((inst as any).extractDeviceAddressFromServiceMessageValue('AABB001122')).toBe('AABB001122');
  });

  test('extractDeviceAddressFromServiceMessageValue returns undefined for short string without colon', () => {
    expect((inst as any).extractDeviceAddressFromServiceMessageValue('ABC')).toBeUndefined();
  });

  test('extractDeviceAddressFromServiceMessageValue returns undefined for string with spaces', () => {
    expect((inst as any).extractDeviceAddressFromServiceMessageValue('ABC DEF')).toBeUndefined();
  });

  test('hasLowBatKey detects LOWBAT key', () => {
    expect((inst as any).hasLowBatKey({ LOWBAT: {} })).toBe(true);
  });

  test('hasLowBatKey detects LOW_BAT key', () => {
    expect((inst as any).hasLowBatKey({ LOW_BAT: {} })).toBe(true);
  });

  test('hasLowBatKey returns false when no LOWBAT or LOW_BAT key present', () => {
    expect((inst as any).hasLowBatKey({ STATE: {}, VOLTAGE: {} })).toBe(false);
  });

  test('getChannelMapperKey transforms channel type to lowercase key', () => {
    expect((inst as any).getChannelMapperKey('SWITCH_VIRTUAL_RECEIVER')).toBe('switch-virtual-receiver');
    expect((inst as any).getChannelMapperKey('DIMMER')).toBe('dimmer');
  });

  test('getDeviceMapperKey transforms device type to lowercase kebab key', () => {
    expect((inst as any).getDeviceMapperKey('HmIP-WTH')).toBe('hmip-wth');
    expect((inst as any).getDeviceMapperKey('HmIP-DRSI4')).toBe('hmip-drsi4');
  });

  test('getChannelSelectSerial builds correct serial key for SWITCH channel', () => {
    const ch = { address: 'AABB:1', interfaceName: 'HmIP-RF', type: 'SWITCH' };
    expect((inst as any).getChannelSelectSerial(ch)).toBe('HmIP-RF:SWITCH:AABB:1');
  });

  test('getChannelSelectSerial uses short label for SHUTTER_CONTACT channel', () => {
    const ch = { address: 'CCDD:1', interfaceName: 'HmIP-RF', type: 'SHUTTER_CONTACT' };
    expect((inst as any).getChannelSelectSerial(ch)).toBe('HmIP-RF:CONTACT:CCDD:1');
  });

  test('getChannelDisplayName returns channel name when present', () => {
    const ch = { address: 'AABB:1', name: 'Kitchen Light', type: 'SWITCH' };
    expect((inst as any).getChannelDisplayName(ch)).toBe('Kitchen Light');
  });

  test('getChannelDisplayName falls back to address when name is absent', () => {
    const ch = { address: 'AABB:1', name: undefined, type: 'SWITCH' };
    expect((inst as any).getChannelDisplayName(ch)).toBe('AABB:1');
  });

  test('getLegacyChannelSelectKeys returns legacy keys excluding the canonical serial', () => {
    const ch = { address: 'AABB:1', interfaceName: 'HmIP-RF', type: 'SWITCH' };
    const keys: string[] = (inst as any).getLegacyChannelSelectKeys(ch);
    expect(keys).toContain('AABB-1');
    expect(keys).toContain('AABB:1');
    expect(keys).toContain('SWITCH:AABB:1');
    // The canonical serial must not appear in the legacy list
    expect(keys).not.toContain('HmIP-RF:SWITCH:AABB:1');
  });

  test('getDisabledInterfacePrefixes returns prefixes for all non-enabled interfaces', () => {
    const enabled = new Set<any>(['HmIP-RF']);
    const prefixes: string[] = (inst as any).getDisabledInterfacePrefixes(enabled);
    expect(prefixes).toContain('BidCos-RF:');
    expect(prefixes).not.toContain('HmIP-RF:');
  });

  test('getCcuConnectionLayer returns undefined before start', () => {
    expect(inst.getCcuConnectionLayer()).toBeUndefined();
  });

  // === Service message parsing ===

  test('parseServiceMessageEntry parses array format with UNREACH', () => {
    const result = (inst as any).parseServiceMessageEntry(['AABB001122:0', 'UNREACH']);
    expect(result).toMatchObject({ deviceAddress: 'AABB001122', hasUnreach: true, hasLowBat: false });
  });

  test('parseServiceMessageEntry parses array format with LOWBAT', () => {
    const result = (inst as any).parseServiceMessageEntry(['CCDD001122:0', 'LOWBAT']);
    expect(result).toMatchObject({ deviceAddress: 'CCDD001122', hasUnreach: false, hasLowBat: true });
  });

  test('parseServiceMessageEntry parses object format with ADDRESS field', () => {
    const result = (inst as any).parseServiceMessageEntry({ ADDRESS: 'EEFF001122:0', DATAPOINT: 'UNREACH' });
    expect(result).toMatchObject({ deviceAddress: 'EEFF001122', hasUnreach: true, hasLowBat: false });
  });

  test('parseServiceMessageEntry returns undefined when no address can be extracted', () => {
    expect((inst as any).parseServiceMessageEntry(['UNREACH'])).toBeUndefined();
    expect((inst as any).parseServiceMessageEntry({ DATAPOINT: 'UNREACH' })).toBeUndefined();
  });

  test('parseServiceMessageEntry parses plain string format with address and datapoint', () => {
    const result = (inst as any).parseServiceMessageEntry('AABB001122:0');
    expect(result).toMatchObject({ deviceAddress: 'AABB001122', hasUnreach: false, hasLowBat: false });
  });

  test('parseServiceMessageEntry returns undefined for plain string with no extractable address', () => {
    expect((inst as any).parseServiceMessageEntry('UNREACH')).toBeUndefined();
  });

  test('collectServiceMessages collects unreachable and low-battery devices from array payload', () => {
    const unreachable = new Set<string>();
    const lowBattery = new Set<string>();
    (inst as any).collectServiceMessages(
      [
        ['AABB001122:0', 'UNREACH'],
        ['CCDD001122:0', 'LOWBAT'],
      ],
      unreachable,
      lowBattery,
    );
    expect(unreachable.has('AABB001122')).toBe(true);
    expect(lowBattery.has('CCDD001122')).toBe(true);
  });

  // === isChannelEnabled / autoBlacklistIfNew ===

  test('isChannelEnabled respects override.enabled=false regardless of validateDevice', () => {
    const channel = { address: 'OVR:1', deviceAddress: 'OVR', channelIndex: 1, type: 'SWITCH', interfaceName: 'HmIP-RF', batteryPowered: false } as CcuChannelInfo;
    inst.validateDevice = vi.fn(() => true);
    expect((inst as any).isChannelEnabled(channel, { enabled: false }, 'Test')).toBe(false);
  });

  test('isChannelEnabled respects override.enabled=true regardless of validateDevice', () => {
    const channel = { address: 'OVR2:1', deviceAddress: 'OVR2', channelIndex: 1, type: 'SWITCH', interfaceName: 'HmIP-RF', batteryPowered: false } as CcuChannelInfo;
    inst.validateDevice = vi.fn(() => false);
    expect((inst as any).isChannelEnabled(channel, { enabled: true }, 'Test')).toBe(true);
  });

  test('autoBlacklistIfNew adds serial to blackList when channel is brand new', () => {
    const ch = { address: 'NEW001:1', interfaceName: 'HmIP-RF', type: 'SWITCH' };
    const serial = 'HmIP-RF:SWITCH:NEW001:1';
    const result = (inst as any).autoBlacklistIfNew(serial, ch);
    expect(result).toBe(true);
    const config = (inst as any).getPlatformConfig();
    expect((config.blackList as string[]).includes(serial)).toBe(true);
    config.blackList = (config.blackList as string[]).filter((e: string) => e !== serial);
  });

  test('autoBlacklistIfNew returns false when serial already in blackList', () => {
    const ch = { address: 'KNOWN001:1', interfaceName: 'HmIP-RF', type: 'SWITCH' };
    const serial = 'HmIP-RF:SWITCH:KNOWN001:1';
    const config = (inst as any).getPlatformConfig();
    (config.blackList as string[]).push(serial);
    expect((inst as any).autoBlacklistIfNew(serial, ch)).toBe(false);
    config.blackList = (config.blackList as string[]).filter((e: string) => e !== serial);
  });

  // === RPC event handler — switch state ===

  test('handleRpcEventSwitchState updates OnOff when value changes', async () => {
    const ep = makeEndpoint(['OnOff'], { 'OnOff.onOff': false });
    (inst as any).channelAddressToDevice.set('SW001:1', ep);
    await (inst as any).handleRpcEventSwitchState({ channel: 'SW001:1', datapoint: 'STATE', value: true });
    expect(ep.updateAttribute).toHaveBeenCalledWith('OnOff', 'onOff', true);
    (inst as any).channelAddressToDevice.delete('SW001:1');
    (inst as any).rpcEchoSuppress.delete('SW001:1');
  });

  test('handleRpcEventSwitchState ignores non-STATE datapoints', async () => {
    const ep = makeEndpoint(['OnOff']);
    (inst as any).channelAddressToDevice.set('SW002:1', ep);
    await (inst as any).handleRpcEventSwitchState({ channel: 'SW002:1', datapoint: 'LEVEL', value: true });
    expect(ep.updateAttribute).not.toHaveBeenCalled();
    (inst as any).channelAddressToDevice.delete('SW002:1');
  });

  test('handleRpcEventSwitchState does nothing for unknown channel address', async () => {
    const ep = makeEndpoint(['OnOff']);
    await (inst as any).handleRpcEventSwitchState({ channel: 'UNKNOWN:1', datapoint: 'STATE', value: true });
    expect(ep.updateAttribute).not.toHaveBeenCalled();
  });

  // === RPC event handler — contact state ===

  test('handleRpcEventContactState maps Homematic open (true) to Matter closed=false', async () => {
    const ep = makeEndpoint(['BooleanState'], { 'BooleanState.stateValue': true });
    (inst as any).channelAddressToDevice.set('SC001:1', ep);
    await (inst as any).handleRpcEventContactState({ channel: 'SC001:1', datapoint: 'STATE', value: true });
    expect(ep.updateAttribute).toHaveBeenCalledWith('BooleanState', 'stateValue', false);
    (inst as any).channelAddressToDevice.delete('SC001:1');
  });

  test('handleRpcEventContactState maps Homematic closed (false) to Matter closed=true', async () => {
    const ep = makeEndpoint(['BooleanState'], { 'BooleanState.stateValue': false });
    (inst as any).channelAddressToDevice.set('SC002:1', ep);
    await (inst as any).handleRpcEventContactState({ channel: 'SC002:1', datapoint: 'STATE', value: false });
    expect(ep.updateAttribute).toHaveBeenCalledWith('BooleanState', 'stateValue', true);
    (inst as any).channelAddressToDevice.delete('SC002:1');
  });

  // === RPC event handler — motion detector ===

  test('handleRpcEventMotion updates OccupancySensing occupancy on motion detected', async () => {
    const ep = makeEndpoint(['OccupancySensing'], { 'OccupancySensing.occupancy': { occupied: false } });
    (inst as any).channelAddressToDevice.set('MOT001:1', ep);
    await (inst as any).handleRpcEventMotion({ channel: 'MOT001:1', datapoint: 'MOTION', value: true });
    expect(ep.updateAttribute).toHaveBeenCalledWith('OccupancySensing', 'occupancy', { occupied: true });
    (inst as any).channelAddressToDevice.delete('MOT001:1');
  });

  test('handleRpcEventMotion ignores non-MOTION datapoints', async () => {
    const ep = makeEndpoint(['OccupancySensing']);
    (inst as any).channelAddressToDevice.set('MOT002:1', ep);
    await (inst as any).handleRpcEventMotion({ channel: 'MOT002:1', datapoint: 'STATE', value: true });
    expect(ep.updateAttribute).not.toHaveBeenCalled();
    (inst as any).channelAddressToDevice.delete('MOT002:1');
  });

  // === RPC event handler — illuminance ===

  test('handleRpcEventIlluminance converts lux to Matter measuredValue', async () => {
    const ep = makeEndpoint(['IlluminanceMeasurement'], { 'IlluminanceMeasurement.measuredValue': 0 });
    (inst as any).channelAddressToDevice.set('LUX001:1', ep);
    await (inst as any).handleRpcEventIlluminance({ channel: 'LUX001:1', datapoint: 'ILLUMINATION', value: 100 });
    const expected = Math.round(10000 * Math.log10(100) + 1);
    expect(ep.updateAttribute).toHaveBeenCalledWith('IlluminanceMeasurement', 'measuredValue', expected);
    (inst as any).channelAddressToDevice.delete('LUX001:1');
  });

  test('handleRpcEventIlluminance sets measuredValue=0 for zero lux', async () => {
    const ep = makeEndpoint(['IlluminanceMeasurement'], { 'IlluminanceMeasurement.measuredValue': 1000 });
    (inst as any).channelAddressToDevice.set('LUX002:1', ep);
    await (inst as any).handleRpcEventIlluminance({ channel: 'LUX002:1', datapoint: 'ILLUMINATION', value: 0 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('IlluminanceMeasurement', 'measuredValue', 0);
    (inst as any).channelAddressToDevice.delete('LUX002:1');
  });

  // === RPC event handler — smoke detector ===

  test('handleRpcEventSmoke sets smokeState=2 when SMOKE_DETECTOR_ALARM_STATUS > 0', async () => {
    const ep = makeEndpoint(['SmokeCoAlarm'], { 'SmokeCoAlarm.smokeState': 0 });
    (inst as any).channelAddressToDevice.set('SMK001:1', ep);
    await (inst as any).handleRpcEventSmoke({ channel: 'SMK001:1', datapoint: 'SMOKE_DETECTOR_ALARM_STATUS', value: 1 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('SmokeCoAlarm', 'smokeState', 2);
    (inst as any).channelAddressToDevice.delete('SMK001:1');
  });

  test('handleRpcEventSmoke clears smokeState when STATE=false', async () => {
    const ep = makeEndpoint(['SmokeCoAlarm'], { 'SmokeCoAlarm.smokeState': 2 });
    (inst as any).channelAddressToDevice.set('SMK002:1', ep);
    await (inst as any).handleRpcEventSmoke({ channel: 'SMK002:1', datapoint: 'STATE', value: false });
    expect(ep.updateAttribute).toHaveBeenCalledWith('SmokeCoAlarm', 'smokeState', 0);
    (inst as any).channelAddressToDevice.delete('SMK002:1');
  });

  // === RPC event handler — alarm state (water leak) ===

  test('handleRpcEventAlarmState sets stateValue=true when ALARMSTATE > 0', async () => {
    const ep = makeEndpoint(['BooleanState'], { 'BooleanState.stateValue': false });
    (inst as any).channelAddressToDevice.set('ALM001:1', ep);
    await (inst as any).handleRpcEventAlarmState({ channel: 'ALM001:1', datapoint: 'ALARMSTATE', value: 1 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('BooleanState', 'stateValue', true);
    (inst as any).channelAddressToDevice.delete('ALM001:1');
  });

  test('handleRpcEventAlarmState clears stateValue when ALARMSTATE = 0', async () => {
    const ep = makeEndpoint(['BooleanState'], { 'BooleanState.stateValue': true });
    (inst as any).channelAddressToDevice.set('ALM002:1', ep);
    await (inst as any).handleRpcEventAlarmState({ channel: 'ALM002:1', datapoint: 'ALARMSTATE', value: 0 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('BooleanState', 'stateValue', false);
    (inst as any).channelAddressToDevice.delete('ALM002:1');
  });

  // === RPC event handler — rotary handle ===

  test('handleRpcEventRotaryHandle sets stateValue=true for STATE=0 (fully closed)', async () => {
    const ep = makeEndpoint(['BooleanState'], { 'BooleanState.stateValue': false });
    (inst as any).rotaryHandleChannels.set('ROT001:1', ep);
    await (inst as any).handleRpcEventRotaryHandle({ channel: 'ROT001:1', datapoint: 'STATE', value: 0 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('BooleanState', 'stateValue', true);
    (inst as any).rotaryHandleChannels.delete('ROT001:1');
  });

  test('handleRpcEventRotaryHandle sets stateValue=false for STATE=1 (tilted)', async () => {
    const ep = makeEndpoint(['BooleanState'], { 'BooleanState.stateValue': true });
    (inst as any).rotaryHandleChannels.set('ROT002:1', ep);
    await (inst as any).handleRpcEventRotaryHandle({ channel: 'ROT002:1', datapoint: 'STATE', value: 1 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('BooleanState', 'stateValue', false);
    (inst as any).rotaryHandleChannels.delete('ROT002:1');
  });

  // === RPC event handler — temperature / humidity ===

  test('handleRpcEventTemperatureHumidity updates TemperatureMeasurement for ACTUAL_TEMPERATURE', async () => {
    const ep = makeEndpoint(['TemperatureMeasurement'], { 'TemperatureMeasurement.measuredValue': 0 });
    (inst as any).channelAddressToDevice.set('TEMP001:1', ep);
    await (inst as any).handleRpcEventTemperatureHumidity({ channel: 'TEMP001:1', datapoint: 'ACTUAL_TEMPERATURE', value: 21.5 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('TemperatureMeasurement', 'measuredValue', 2150);
    (inst as any).channelAddressToDevice.delete('TEMP001:1');
  });

  test('handleRpcEventTemperatureHumidity updates RelativeHumidityMeasurement for HUMIDITY', async () => {
    const ep = makeEndpoint(['RelativeHumidityMeasurement'], { 'RelativeHumidityMeasurement.measuredValue': 0 });
    (inst as any).channelAddressToDevice.set('HUM001:1', ep);
    await (inst as any).handleRpcEventTemperatureHumidity({ channel: 'HUM001:1', datapoint: 'HUMIDITY', value: 65 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('RelativeHumidityMeasurement', 'measuredValue', 6500);
    (inst as any).channelAddressToDevice.delete('HUM001:1');
  });

  test('handleRpcEventTemperatureHumidity converts BRIGHTNESS to IlluminanceMeasurement', async () => {
    const ep = makeEndpoint(['IlluminanceMeasurement'], { 'IlluminanceMeasurement.measuredValue': 0 });
    (inst as any).channelAddressToDevice.set('BRIGHT001:1', ep);
    await (inst as any).handleRpcEventTemperatureHumidity({ channel: 'BRIGHT001:1', datapoint: 'BRIGHTNESS', value: 100 });
    const expected = Math.round(10000 * Math.log10(100) + 1);
    expect(ep.updateAttribute).toHaveBeenCalledWith('IlluminanceMeasurement', 'measuredValue', expected);
    (inst as any).channelAddressToDevice.delete('BRIGHT001:1');
  });

  // === RPC event handler — thermostat ===

  test('handleRpcEventThermostat updates localTemperature for ACTUAL_TEMPERATURE', async () => {
    const ep = makeEndpoint(['Thermostat'], { 'Thermostat.localTemperature': 0 });
    (inst as any).channelAddressToDevice.set('THERM001:1', ep);
    await (inst as any).handleRpcEventThermostat({ channel: 'THERM001:1', datapoint: 'ACTUAL_TEMPERATURE', value: 20 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('Thermostat', 'localTemperature', 2000);
    (inst as any).channelAddressToDevice.delete('THERM001:1');
  });

  test('handleRpcEventThermostat updates setpoint and sets systemMode=Heat for SET_POINT_TEMPERATURE > 4.5°C', async () => {
    const ep = makeEndpoint(['Thermostat'], { 'Thermostat.occupiedHeatingSetpoint': 0 });
    (inst as any).channelAddressToDevice.set('THERM002:1', ep);
    await (inst as any).handleRpcEventThermostat({ channel: 'THERM002:1', datapoint: 'SET_POINT_TEMPERATURE', value: 21 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('Thermostat', 'occupiedHeatingSetpoint', 2100);
    expect(ep.updateAttribute).toHaveBeenCalledWith('Thermostat', 'systemMode', 4);
    (inst as any).channelAddressToDevice.delete('THERM002:1');
    (inst as any).rpcEchoSuppress.delete('THERM002:1:heatingSetpoint');
    (inst as any).rpcEchoSuppress.delete('THERM002:1:thermMode');
  });

  test('handleRpcEventThermostat sets systemMode=Off for frost-protection setpoint (≤4.5°C)', async () => {
    const ep = makeEndpoint(['Thermostat'], { 'Thermostat.occupiedHeatingSetpoint': 2100 });
    (inst as any).channelAddressToDevice.set('THERM003:1', ep);
    await (inst as any).handleRpcEventThermostat({ channel: 'THERM003:1', datapoint: 'SET_POINT_TEMPERATURE', value: 4.5 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('Thermostat', 'systemMode', 0);
    (inst as any).channelAddressToDevice.delete('THERM003:1');
    (inst as any).rpcEchoSuppress.delete('THERM003:1:heatingSetpoint');
    (inst as any).rpcEchoSuppress.delete('THERM003:1:thermMode');
  });

  // === RPC event handler — keymatic ===

  test('handleRpcEventKeymatic sets lockState=Unlocked (2) when STATE=true with no error/movement', async () => {
    const ep = makeEndpoint(['DoorLock'], { 'DoorLock.lockState': 1 });
    (inst as any).channelAddressToDevice.set('KEY001:1', ep);
    (inst as any).keymaticState.set('KEY001:1', { state: false, uncertain: false, error: false, direction: 0 });
    await (inst as any).handleRpcEventKeymatic({ channel: 'KEY001:1', datapoint: 'STATE', value: true });
    expect(ep.updateAttribute).toHaveBeenCalledWith('DoorLock', 'lockState', 2);
    (inst as any).channelAddressToDevice.delete('KEY001:1');
    (inst as any).keymaticState.delete('KEY001:1');
  });

  test('handleRpcEventKeymatic sets lockState=NotFullyLocked (0) when motor is moving (DIRECTION≠0)', async () => {
    const ep = makeEndpoint(['DoorLock'], { 'DoorLock.lockState': 1 });
    (inst as any).channelAddressToDevice.set('KEY002:1', ep);
    (inst as any).keymaticState.set('KEY002:1', { state: false, uncertain: false, error: false, direction: 0 });
    await (inst as any).handleRpcEventKeymatic({ channel: 'KEY002:1', datapoint: 'DIRECTION', value: 2 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('DoorLock', 'lockState', 0);
    (inst as any).channelAddressToDevice.delete('KEY002:1');
    (inst as any).keymaticState.delete('KEY002:1');
  });

  // === RPC event handler — key press ===

  test('handleRpcEventKey triggers Single switch event for PRESS_SHORT', async () => {
    const ep = makeEndpoint(['Switch']);
    (inst as any).channelAddressToDevice.set('BTN001:1', ep);
    await (inst as any).handleRpcEventKey({ channel: 'BTN001:1', datapoint: 'PRESS_SHORT', value: true });
    expect(ep.triggerSwitchEvent).toHaveBeenCalledWith('Single', expect.anything());
    (inst as any).channelAddressToDevice.delete('BTN001:1');
  });

  test('handleRpcEventKey triggers Long switch event for PRESS_LONG', async () => {
    const ep = makeEndpoint(['Switch']);
    (inst as any).channelAddressToDevice.set('BTN002:1', ep);
    await (inst as any).handleRpcEventKey({ channel: 'BTN002:1', datapoint: 'PRESS_LONG', value: true });
    expect(ep.triggerSwitchEvent).toHaveBeenCalledWith('Long', expect.anything());
    (inst as any).channelAddressToDevice.delete('BTN002:1');
  });

  test('handleRpcEventKey ignores value=false echoes', async () => {
    const ep = makeEndpoint(['Switch']);
    (inst as any).channelAddressToDevice.set('BTN003:1', ep);
    await (inst as any).handleRpcEventKey({ channel: 'BTN003:1', datapoint: 'PRESS_SHORT', value: false });
    expect(ep.triggerSwitchEvent).not.toHaveBeenCalled();
    (inst as any).channelAddressToDevice.delete('BTN003:1');
  });

  // === RPC event handler — power meter (BidCos) ===

  test('handleRpcEventPowerMeter updates activePower (POWER in W → mW)', async () => {
    const ep = makeEndpoint(['ElectricalPowerMeasurement'], { 'ElectricalPowerMeasurement.activePower': 0 });
    (inst as any).channelAddressToDevice.set('PWR001:6', ep);
    await (inst as any).handleRpcEventPowerMeter({ channel: 'PWR001:6', datapoint: 'POWER', value: 100.5 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('ElectricalPowerMeasurement', 'activePower', 100500);
    (inst as any).channelAddressToDevice.delete('PWR001:6');
  });

  test('handleRpcEventPowerMeter updates voltage (V → mV)', async () => {
    const ep = makeEndpoint(['ElectricalPowerMeasurement'], { 'ElectricalPowerMeasurement.voltage': 0 });
    (inst as any).channelAddressToDevice.set('PWR002:6', ep);
    await (inst as any).handleRpcEventPowerMeter({ channel: 'PWR002:6', datapoint: 'VOLTAGE', value: 230 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('ElectricalPowerMeasurement', 'voltage', 230000);
    (inst as any).channelAddressToDevice.delete('PWR002:6');
  });

  // === RPC event handler — HmIP energie meter ===

  test('handleRpcEventEnergieMeter updates activeCurrent without ×1000 conversion (already mA)', async () => {
    const ep = makeEndpoint(['ElectricalPowerMeasurement'], { 'ElectricalPowerMeasurement.activeCurrent': 0 });
    (inst as any).energieMeterChannels.set('EPWR001:6', ep);
    await (inst as any).handleRpcEventEnergieMeter({ channel: 'EPWR001:6', datapoint: 'CURRENT', value: 250 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('ElectricalPowerMeasurement', 'activeCurrent', 250);
    (inst as any).energieMeterChannels.delete('EPWR001:6');
  });

  test('handleRpcEventEnergieMeter updates activePower (W → mW)', async () => {
    const ep = makeEndpoint(['ElectricalPowerMeasurement'], { 'ElectricalPowerMeasurement.activePower': 0 });
    (inst as any).energieMeterChannels.set('EPWR002:6', ep);
    await (inst as any).handleRpcEventEnergieMeter({ channel: 'EPWR002:6', datapoint: 'POWER', value: 50 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('ElectricalPowerMeasurement', 'activePower', 50000);
    (inst as any).energieMeterChannels.delete('EPWR002:6');
  });

  // === RPC event handler — dimmer level ===

  test('handleRpcEventDimmerLevel updates LevelControl currentLevel', async () => {
    const ep = makeEndpoint(['LevelControl']);
    (inst as any).channelAddressToDevice.set('DIM001:1', ep);
    await (inst as any).handleRpcEventDimmerLevel({ channel: 'DIM001:1', datapoint: 'LEVEL', value: 0.5 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('LevelControl', 'currentLevel', expect.any(Number));
    (inst as any).channelAddressToDevice.delete('DIM001:1');
    (inst as any).dimmerLastLevel.delete('DIM001:1');
    (inst as any).rpcEchoSuppress.delete('DIM001:1');
  });

  test('handleRpcEventDimmerLevel suppresses Matter update while WORKING=true', async () => {
    const ep = makeEndpoint(['LevelControl']);
    (inst as any).channelAddressToDevice.set('DIM002:1', ep);
    (inst as any).dimmerWorking.set('DIM002:1', true);
    await (inst as any).handleRpcEventDimmerLevel({ channel: 'DIM002:1', datapoint: 'LEVEL', value: 0.8 });
    expect(ep.updateAttribute).not.toHaveBeenCalled();
    (inst as any).channelAddressToDevice.delete('DIM002:1');
    (inst as any).dimmerWorking.delete('DIM002:1');
    (inst as any).dimmerLastLevel.delete('DIM002:1');
  });

  // === RPC event handler — dimmer working ===

  test('handleRpcEventDimmerWorking sets working flag on WORKING=true', async () => {
    const ep = makeEndpoint(['LevelControl']);
    (inst as any).channelAddressToDevice.set('DIM003:1', ep);
    await (inst as any).handleRpcEventDimmerWorking({ channel: 'DIM003:1', datapoint: 'WORKING', value: true });
    expect((inst as any).dimmerWorking.get('DIM003:1')).toBe(true);
    (inst as any).channelAddressToDevice.delete('DIM003:1');
    (inst as any).dimmerWorking.delete('DIM003:1');
  });

  test('handleRpcEventDimmerWorking clears flag and applies final level on WORKING=false with fresh level', async () => {
    const ep = makeEndpoint(['LevelControl']);
    (inst as any).channelAddressToDevice.set('DIM004:1', ep);
    (inst as any).dimmerWorking.set('DIM004:1', true);
    (inst as any).dimmerLastLevel.set('DIM004:1', { level: 0.7, time: Date.now() });
    await (inst as any).handleRpcEventDimmerWorking({ channel: 'DIM004:1', datapoint: 'WORKING', value: false });
    expect((inst as any).dimmerWorking.get('DIM004:1')).toBeUndefined();
    expect(ep.updateAttribute).toHaveBeenCalled();
    (inst as any).channelAddressToDevice.delete('DIM004:1');
    (inst as any).dimmerLastLevel.delete('DIM004:1');
    (inst as any).rpcEchoSuppress.delete('DIM004:1');
    (inst as any).rpcEchoSuppress.delete('DIM004:1:onoff');
  });

  test('handleRpcEventDimmerWorking marks channel for awaited level when last level is stale', async () => {
    const ep = makeEndpoint(['LevelControl']);
    (inst as any).channelAddressToDevice.set('DIM005:1', ep);
    (inst as any).dimmerWorking.set('DIM005:1', true);
    // Stale last level (> 500ms ago)
    (inst as any).dimmerLastLevel.set('DIM005:1', { level: 0.5, time: Date.now() - 1000 });
    await (inst as any).handleRpcEventDimmerWorking({ channel: 'DIM005:1', datapoint: 'WORKING', value: false });
    expect((inst as any).dimmerAwaitingFinalLevel.has('DIM005:1')).toBe(true);
    (inst as any).channelAddressToDevice.delete('DIM005:1');
    (inst as any).dimmerLastLevel.delete('DIM005:1');
    (inst as any).dimmerAwaitingFinalLevel.delete('DIM005:1');
  });

  // === RPC event handler — blind level ===

  test('handleRpcEventBlindLevel updates WindowCovering target and current position', async () => {
    const ep = makeEndpoint(['WindowCovering']);
    (inst as any).channelAddressToDevice.set('BLD001:1', ep);
    await (inst as any).handleRpcEventBlindLevel({ channel: 'BLD001:1', datapoint: 'LEVEL', value: 0.5 });
    expect(ep.setWindowCoveringTargetAndCurrentPosition).toHaveBeenCalledWith(5000);
    (inst as any).channelAddressToDevice.delete('BLD001:1');
    (inst as any).dimmerLastLevel.delete('BLD001:1');
    (inst as any).rpcEchoSuppress.delete('BLD001:1:blindTarget');
  });

  test('handleRpcEventBlindLevel suppresses update while WORKING=true', async () => {
    const ep = makeEndpoint(['WindowCovering']);
    (inst as any).channelAddressToDevice.set('BLD002:1', ep);
    (inst as any).dimmerWorking.set('BLD002:1', true);
    await (inst as any).handleRpcEventBlindLevel({ channel: 'BLD002:1', datapoint: 'LEVEL', value: 0.3 });
    expect(ep.setWindowCoveringTargetAndCurrentPosition).not.toHaveBeenCalled();
    (inst as any).channelAddressToDevice.delete('BLD002:1');
    (inst as any).dimmerWorking.delete('BLD002:1');
    (inst as any).dimmerLastLevel.delete('BLD002:1');
  });

  // === RPC event handler — blind tilt ===

  test('handleRpcEventBlindTilt updates both current and target tilt attributes', async () => {
    const ep = makeEndpoint(['WindowCovering']);
    (inst as any).channelAddressToDevice.set('BLD003:1', ep);
    await (inst as any).handleRpcEventBlindTilt({ channel: 'BLD003:1', datapoint: 'LEVEL_2', value: 0.5 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('WindowCovering', 'currentPositionTiltPercent100ths', 5000);
    expect(ep.updateAttribute).toHaveBeenCalledWith('WindowCovering', 'targetPositionTiltPercent100ths', 5000);
    (inst as any).channelAddressToDevice.delete('BLD003:1');
    (inst as any).blindLastTilt.delete('BLD003:1');
    (inst as any).rpcEchoSuppress.delete('BLD003:1:blindTilt');
  });

  // === RPC event handler — blind activity ===

  test('handleRpcEventBlindActivity sets working flag when ACTIVITY_STATE=1 (opening)', async () => {
    const ep = makeEndpoint(['WindowCovering']);
    (inst as any).channelAddressToDevice.set('BLD004:1', ep);
    await (inst as any).handleRpcEventBlindActivity({ channel: 'BLD004:1', datapoint: 'ACTIVITY_STATE', value: 1 });
    expect((inst as any).dimmerWorking.get('BLD004:1')).toBe(true);
    (inst as any).channelAddressToDevice.delete('BLD004:1');
    (inst as any).dimmerWorking.delete('BLD004:1');
  });

  test('handleRpcEventBlindActivity clears working flag and applies level on ACTIVITY_STATE=0 (stopped)', async () => {
    const ep = makeEndpoint(['WindowCovering']);
    (inst as any).channelAddressToDevice.set('BLD005:1', ep);
    (inst as any).dimmerWorking.set('BLD005:1', true);
    (inst as any).dimmerLastLevel.set('BLD005:1', { level: 0.3, time: Date.now() });
    await (inst as any).handleRpcEventBlindActivity({ channel: 'BLD005:1', datapoint: 'ACTIVITY_STATE', value: 0 });
    expect((inst as any).dimmerWorking.get('BLD005:1')).toBeUndefined();
    expect(ep.setWindowCoveringTargetAndCurrentPosition).toHaveBeenCalled();
    (inst as any).channelAddressToDevice.delete('BLD005:1');
    (inst as any).dimmerLastLevel.delete('BLD005:1');
    (inst as any).rpcEchoSuppress.delete('BLD005:1:blindTarget');
  });

  test('handleRpcEventBlindActivity calls setWindowCoveringStatus with the mapped status', async () => {
    const ep = makeEndpoint(['WindowCovering']);
    (inst as any).channelAddressToDevice.set('BLD006:1', ep);
    await (inst as any).handleRpcEventBlindActivity({ channel: 'BLD006:1', datapoint: 'ACTIVITY_STATE', value: 2 });
    expect(ep.setWindowCoveringStatus).toHaveBeenCalledWith(2);
    (inst as any).channelAddressToDevice.delete('BLD006:1');
    (inst as any).dimmerWorking.delete('BLD006:1');
  });

  // === applyDimmerLevel ===

  test('applyDimmerLevel converts Homematic 0.5 level to Matter level 127', async () => {
    const ep = makeEndpoint(['LevelControl', 'OnOff'], { 'OnOff.onOff': false });
    await (inst as any).applyDimmerLevel('DIM999:1', ep, 0.5);
    expect(ep.updateAttribute).toHaveBeenCalledWith('LevelControl', 'currentLevel', 127);
    (inst as any).rpcEchoSuppress.delete('DIM999:1');
    (inst as any).rpcEchoSuppress.delete('DIM999:1:onoff');
  });

  test('applyDimmerLevel turns off OnOff when level is 0', async () => {
    const ep = makeEndpoint(['LevelControl', 'OnOff'], { 'OnOff.onOff': true });
    await (inst as any).applyDimmerLevel('DIM998:1', ep, 0);
    expect(ep.updateAttribute).toHaveBeenCalledWith('OnOff', 'onOff', false);
    (inst as any).rpcEchoSuppress.delete('DIM998:1');
    (inst as any).rpcEchoSuppress.delete('DIM998:1:onoff');
  });

  // === applyBlindLevel ===

  test('applyBlindLevel converts Homematic 0.7 (70% open) to Matter 3000/10000 (30% from top)', async () => {
    const ep = makeEndpoint(['WindowCovering']);
    await (inst as any).applyBlindLevel('BLD999:1', ep, 0.7);
    expect(ep.setWindowCoveringTargetAndCurrentPosition).toHaveBeenCalledWith(3000);
    (inst as any).rpcEchoSuppress.delete('BLD999:1:blindTarget');
  });

  test('applyBlindLevel only updates currentPosition when blindCommandedTarget is set', async () => {
    const ep = makeEndpoint(['WindowCovering']);
    (inst as any).blindCommandedTarget.set('BLD998:1', 2000);
    await (inst as any).applyBlindLevel('BLD998:1', ep, 0.5);
    expect(ep.updateAttribute).toHaveBeenCalledWith('WindowCovering', 'currentPositionLiftPercent100ths', 5000);
    expect(ep.setWindowCoveringTargetAndCurrentPosition).not.toHaveBeenCalled();
    (inst as any).blindCommandedTarget.delete('BLD998:1');
  });

  // === Availability and battery ===

  test('handleRpcEventAvailability marks device unreachable when UNREACH=true', async () => {
    const ep = makeEndpoint(['BridgedDeviceBasicInformation'], { 'BridgedDeviceBasicInformation.reachable': true });
    (inst as any).deviceAddressToDevice.set('REACH001', ep);
    await (inst as any).handleRpcEventAvailability({ channel: 'REACH001:0', datapoint: 'UNREACH', value: true });
    expect(ep.updateAttribute).toHaveBeenCalledWith('BridgedDeviceBasicInformation', 'reachable', false);
    (inst as any).deviceAddressToDevice.delete('REACH001');
  });

  test('handleRpcEventAvailability ignores non-UNREACH datapoints', async () => {
    const ep = makeEndpoint(['BridgedDeviceBasicInformation']);
    (inst as any).deviceAddressToDevice.set('REACH002', ep);
    await (inst as any).handleRpcEventAvailability({ channel: 'REACH002:0', datapoint: 'LOWBAT', value: true });
    expect(ep.updateAttribute).not.toHaveBeenCalled();
    (inst as any).deviceAddressToDevice.delete('REACH002');
  });

  test('handleRpcEventBattery sets batChargeLevel=1 (warning) on LOWBAT=true', async () => {
    const ep = makeEndpoint(['PowerSource'], { 'PowerSource.batChargeLevel': 0 });
    (inst as any).deviceAddressToDevice.set('BATT001', ep);
    await (inst as any).handleRpcEventBattery({ channel: 'BATT001:0', datapoint: 'LOWBAT', value: true });
    expect(ep.updateAttribute).toHaveBeenCalledWith('PowerSource', 'batChargeLevel', 1);
    (inst as any).deviceAddressToDevice.delete('BATT001');
    (inst as any).deviceBatteryLowState.delete('BATT001');
    (inst as any).deviceBatteryHints.delete('BATT001');
  });

  test('handleRpcEventBattery ignores mains-powered devices', async () => {
    const ep = makeEndpoint(['PowerSource']);
    (inst as any).deviceAddressToDevice.set('MAINS001', ep);
    (inst as any).mainsPoweredDevices.add('MAINS001');
    await (inst as any).handleRpcEventBattery({ channel: 'MAINS001:0', datapoint: 'LOWBAT', value: true });
    expect(ep.updateAttribute).not.toHaveBeenCalled();
    (inst as any).deviceAddressToDevice.delete('MAINS001');
    (inst as any).mainsPoweredDevices.delete('MAINS001');
  });

  test('handleRpcEventBattery also handles LOW_BAT datapoint name', async () => {
    const ep = makeEndpoint(['PowerSource'], { 'PowerSource.batChargeLevel': 0 });
    (inst as any).deviceAddressToDevice.set('BATT002', ep);
    await (inst as any).handleRpcEventBattery({ channel: 'BATT002:0', datapoint: 'LOW_BAT', value: true });
    expect(ep.updateAttribute).toHaveBeenCalledWith('PowerSource', 'batChargeLevel', 1);
    (inst as any).deviceAddressToDevice.delete('BATT002');
    (inst as any).deviceBatteryLowState.delete('BATT002');
    (inst as any).deviceBatteryHints.delete('BATT002');
  });

  test('handleRpcEventOperatingVoltage updates batPercentRemaining from voltage', async () => {
    const ep = makeEndpoint(['PowerSource'], { 'PowerSource.batPercentRemaining': 0 });
    (inst as any).deviceAddressToDevice.set('VOLT001', ep);
    // Default range is 2.0–3.0V; 3.0V → 100% → batPercentRemaining=200
    await (inst as any).handleRpcEventOperatingVoltage({ channel: 'VOLT001:0', datapoint: 'OPERATING_VOLTAGE', value: 3.0 });
    expect(ep.updateAttribute).toHaveBeenCalledWith('PowerSource', 'batPercentRemaining', 200);
    (inst as any).deviceAddressToDevice.delete('VOLT001');
  });

  // === setDeviceBatteryLowState / updateDeviceReachable ===

  test('setDeviceBatteryLowState updates batChargeLevel on endpoint with PowerSource cluster', async () => {
    const ep = makeEndpoint(['PowerSource'], { 'PowerSource.batChargeLevel': 0 });
    (inst as any).deviceAddressToDevice.set('BATT003', ep);
    await (inst as any).setDeviceBatteryLowState('BATT003', true, 'test');
    expect(ep.updateAttribute).toHaveBeenCalledWith('PowerSource', 'batChargeLevel', 1);
    (inst as any).deviceAddressToDevice.delete('BATT003');
    (inst as any).deviceBatteryLowState.delete('BATT003');
    (inst as any).deviceBatteryHints.delete('BATT003');
  });

  test('setDeviceBatteryLowState skips mains-powered devices', async () => {
    const ep = makeEndpoint(['PowerSource']);
    (inst as any).deviceAddressToDevice.set('MAINS002', ep);
    (inst as any).mainsPoweredDevices.add('MAINS002');
    await (inst as any).setDeviceBatteryLowState('MAINS002', true, 'test');
    expect(ep.updateAttribute).not.toHaveBeenCalled();
    (inst as any).deviceAddressToDevice.delete('MAINS002');
    (inst as any).mainsPoweredDevices.delete('MAINS002');
  });

  test('updateDeviceReachable updates reachable attribute when value changes', async () => {
    const ep = makeEndpoint(['BridgedDeviceBasicInformation'], { 'BridgedDeviceBasicInformation.reachable': true });
    await (inst as any).updateDeviceReachable('REACH003', ep, false);
    expect(ep.updateAttribute).toHaveBeenCalledWith('BridgedDeviceBasicInformation', 'reachable', false);
  });

  test('updateDeviceReachable does not update when reachable already matches', async () => {
    const ep = makeEndpoint(['BridgedDeviceBasicInformation'], { 'BridgedDeviceBasicInformation.reachable': true });
    await (inst as any).updateDeviceReachable('REACH004', ep, true);
    expect(ep.updateAttribute).not.toHaveBeenCalled();
  });

  // === updateMainsPoweredDeviceSet ===

  test('updateMainsPoweredDeviceSet classifies HM-LC prefix devices and skips non-mains and non-zero-index channels', () => {
    const channels: CcuChannelInfo[] = [
      // channelIndex 0 + HM-LC prefix → mains-powered
      {
        address: 'HM123456:0',
        deviceAddress: 'HM123456',
        channelIndex: 0,
        type: 'SWITCH_TRANSMITTER',
        deviceType: 'HM-LC-Sw1-FM',
        interfaceName: 'BidCos-RF',
        batteryPowered: false,
      },
      // channelIndex 1 + HM-LC prefix → skipped (non-zero index)
      { address: 'HM123456:1', deviceAddress: 'HM123456', channelIndex: 1, type: 'SWITCH', deviceType: 'HM-LC-Sw1-FM', interfaceName: 'BidCos-RF', batteryPowered: false },
      // channelIndex 0 + HmIP prefix → not mains
      { address: 'HMIP001:0', deviceAddress: 'HMIP001', channelIndex: 0, type: 'MAINTENANCE', deviceType: 'HmIP-BSM', interfaceName: 'HmIP-RF', batteryPowered: false },
    ];

    (inst as any).updateMainsPoweredDeviceSet(channels);

    expect((inst as any).mainsPoweredDevices.has('HM123456')).toBe(true);
    expect((inst as any).mainsPoweredDevices.has('HMIP001')).toBe(false);
    expect((inst as any).mainsPoweredDevices.size).toBe(1);
    expect((inst as any).deviceBatteryHints.get('HM123456')).toBe(false);

    (inst as any).mainsPoweredDevices.clear();
    (inst as any).deviceBatteryHints.delete('HM123456');
  });

  test('updateMainsPoweredDeviceSet clears stale entries before reclassifying', () => {
    (inst as any).mainsPoweredDevices.add('STALE_MAINS');
    (inst as any).updateMainsPoweredDeviceSet([]);
    expect((inst as any).mainsPoweredDevices.has('STALE_MAINS')).toBe(false);
    expect((inst as any).mainsPoweredDevices.size).toBe(0);
  });
});
