/**
 * Unit tests for `resolveChannelsForMatter`.
 *
 * Covers all branching logic:
 * - Classic BidCos passthrough
 * - HmIP SWITCH / DIMMER / BLIND transmitter→receiver pairing
 * - Standalone blind virtual channels (blocks of 3)
 * - POWERMETER / ENERGIE_METER_TRANSMITTER power-meter merging
 * - KEY_TRANSCEIVER + HmIP-HEATING channel-5 filtering on VirtualDevices
 * - Multi-device isolation
 *
 * @file vitest/resolve-channels.test.ts
 */

import { describe, expect, test } from 'vitest';

import { resolveChannelsForMatter } from '../src/ccu/device-mapper.js';
import type { CcuChannelInfo } from '../src/ccu/types.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeChannel(overrides: Pick<CcuChannelInfo, 'address' | 'deviceAddress' | 'channelIndex' | 'type' | 'interfaceName'> & Partial<CcuChannelInfo>): CcuChannelInfo {
  return { ...overrides } as CcuChannelInfo;
}

// ---------------------------------------------------------------------------
// Empty / trivial input
// ---------------------------------------------------------------------------

describe('resolveChannelsForMatter – empty input', () => {
  test('should return empty array for empty input', () => {
    expect(resolveChannelsForMatter([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Classic BidCos channel passthrough
// ---------------------------------------------------------------------------

describe('resolveChannelsForMatter – classic passthrough', () => {
  test('should pass through a SWITCH channel unchanged', () => {
    const ch = makeChannel({ address: 'OEQ001:1', deviceAddress: 'OEQ001', channelIndex: 1, type: 'SWITCH', interfaceName: 'BidCos-RF' });
    const result = resolveChannelsForMatter([ch]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('SWITCH');
    expect(result[0].address).toBe('OEQ001:1');
  });

  test('should pass through a SHUTTER_CONTACT channel unchanged', () => {
    const ch = makeChannel({ address: 'OEQ001:1', deviceAddress: 'OEQ001', channelIndex: 1, type: 'SHUTTER_CONTACT', interfaceName: 'BidCos-RF' });
    const result = resolveChannelsForMatter([ch]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('SHUTTER_CONTACT');
  });

  test('should pass through a DIMMER channel unchanged', () => {
    const ch = makeChannel({ address: 'OEQ001:1', deviceAddress: 'OEQ001', channelIndex: 1, type: 'DIMMER', interfaceName: 'BidCos-RF' });
    const result = resolveChannelsForMatter([ch]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('DIMMER');
  });

  test('should preserve optional fields on classic channels', () => {
    const ch = makeChannel({
      address: 'OEQ001:1',
      deviceAddress: 'OEQ001',
      channelIndex: 1,
      type: 'SWITCH',
      interfaceName: 'BidCos-RF',
      name: 'Küchen Licht',
      batteryPowered: false,
    });
    const result = resolveChannelsForMatter([ch]);
    expect(result[0].name).toBe('Küchen Licht');
    expect(result[0].batteryPowered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HmIP SWITCH pairing
// ---------------------------------------------------------------------------

describe('resolveChannelsForMatter – HmIP SWITCH_TRANSMITTER pairing', () => {
  function makeHmipSwitch(deviceAddress: string): CcuChannelInfo[] {
    return [
      makeChannel({ address: `${deviceAddress}:1`, deviceAddress, channelIndex: 1, type: 'SWITCH_TRANSMITTER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: `${deviceAddress}:2`, deviceAddress, channelIndex: 2, type: 'SWITCH_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF', name: 'Named Switch' }),
      makeChannel({ address: `${deviceAddress}:3`, deviceAddress, channelIndex: 3, type: 'SWITCH_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: `${deviceAddress}:4`, deviceAddress, channelIndex: 4, type: 'SWITCH_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    ];
  }

  test('should select the first SWITCH_VIRTUAL_RECEIVER and retype it to SWITCH', () => {
    const result = resolveChannelsForMatter(makeHmipSwitch('BSM001'));
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('SWITCH');
    expect(result[0].address).toBe('BSM001:2');
  });

  test('should preserve the name from the virtual receiver', () => {
    const result = resolveChannelsForMatter(makeHmipSwitch('BSM001'));
    expect(result[0].name).toBe('Named Switch');
  });

  test('should suppress SWITCH_TRANSMITTER and all SWITCH_VIRTUAL_RECEIVER channels', () => {
    const result = resolveChannelsForMatter(makeHmipSwitch('BSM001'));
    const types = result.map((c) => c.type);
    expect(types).not.toContain('SWITCH_TRANSMITTER');
    expect(types).not.toContain('SWITCH_VIRTUAL_RECEIVER');
  });

  test('should return no output when no SWITCH_VIRTUAL_RECEIVER follows the transmitter', () => {
    const channels = [makeChannel({ address: 'BSM001:5', deviceAddress: 'BSM001', channelIndex: 5, type: 'SWITCH_TRANSMITTER', interfaceName: 'HmIP-RF' })];
    expect(resolveChannelsForMatter(channels)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HmIP DIMMER pairing
// ---------------------------------------------------------------------------

describe('resolveChannelsForMatter – HmIP DIMMER_TRANSMITTER pairing', () => {
  test('should select first DIMMER_VIRTUAL_RECEIVER and retype it to DIMMER', () => {
    const channels = [
      makeChannel({ address: 'BDT001:1', deviceAddress: 'BDT001', channelIndex: 1, type: 'DIMMER_TRANSMITTER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BDT001:2', deviceAddress: 'BDT001', channelIndex: 2, type: 'DIMMER_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BDT001:3', deviceAddress: 'BDT001', channelIndex: 3, type: 'DIMMER_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('DIMMER');
    expect(result[0].address).toBe('BDT001:2');
  });

  test('should suppress DIMMER_VIRTUAL_RECEIVER channels from passthrough', () => {
    const channels = [
      makeChannel({ address: 'BDT001:1', deviceAddress: 'BDT001', channelIndex: 1, type: 'DIMMER_TRANSMITTER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BDT001:2', deviceAddress: 'BDT001', channelIndex: 2, type: 'DIMMER_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    expect(result.map((c) => c.type)).not.toContain('DIMMER_VIRTUAL_RECEIVER');
  });
});

// ---------------------------------------------------------------------------
// HmIP BLIND pairing – tilt variants
// ---------------------------------------------------------------------------

describe('resolveChannelsForMatter – HmIP BLIND_TRANSMITTER pairing', () => {
  test('should set tiltSupported=true when paired with BLIND_VIRTUAL_RECEIVER', () => {
    const channels = [
      makeChannel({ address: 'BLC001:1', deviceAddress: 'BLC001', channelIndex: 1, type: 'BLIND_TRANSMITTER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BLC001:2', deviceAddress: 'BLC001', channelIndex: 2, type: 'BLIND_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BLC001:3', deviceAddress: 'BLC001', channelIndex: 3, type: 'BLIND_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('BLIND');
    expect(result[0].tiltSupported).toBe(true);
  });

  test('should set tiltSupported=false when paired with SHUTTER_VIRTUAL_RECEIVER', () => {
    const channels = [
      makeChannel({ address: 'SHU001:1', deviceAddress: 'SHU001', channelIndex: 1, type: 'BLIND_TRANSMITTER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'SHU001:2', deviceAddress: 'SHU001', channelIndex: 2, type: 'SHUTTER_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'SHU001:3', deviceAddress: 'SHU001', channelIndex: 3, type: 'SHUTTER_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('BLIND');
    expect(result[0].tiltSupported).toBe(false);
  });

  test('should set tiltSupported=false when paired with BLIND_VIRTUAL_TRANSCEIVER', () => {
    const channels = [
      makeChannel({ address: 'BLC001:1', deviceAddress: 'BLC001', channelIndex: 1, type: 'BLIND_TRANSMITTER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BLC001:2', deviceAddress: 'BLC001', channelIndex: 2, type: 'BLIND_VIRTUAL_TRANSCEIVER', interfaceName: 'HmIP-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('BLIND');
    expect(result[0].tiltSupported).toBe(false);
  });

  test('should select first matching receiver (lowest index > transmitter)', () => {
    const channels = [
      makeChannel({ address: 'BLC001:3', deviceAddress: 'BLC001', channelIndex: 3, type: 'BLIND_TRANSMITTER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BLC001:1', deviceAddress: 'BLC001', channelIndex: 1, type: 'BLIND_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BLC001:4', deviceAddress: 'BLC001', channelIndex: 4, type: 'BLIND_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BLC001:5', deviceAddress: 'BLC001', channelIndex: 5, type: 'BLIND_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(1);
    // ch1 is before the transmitter at ch3, so ch4 should be selected.
    expect(result[0].address).toBe('BLC001:4');
  });
});

// ---------------------------------------------------------------------------
// Standalone blind virtual channels (no BLIND_TRANSMITTER)
// ---------------------------------------------------------------------------

describe('resolveChannelsForMatter – standalone blind virtual channels', () => {
  test('should take only the first of each block of 3 BLIND_VIRTUAL_RECEIVER channels', () => {
    const channels = Array.from({ length: 3 }, (_, i) =>
      makeChannel({ address: `SBL001:${i + 1}`, deviceAddress: 'SBL001', channelIndex: i + 1, type: 'BLIND_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    );
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe('SBL001:1');
    expect(result[0].type).toBe('BLIND');
    expect(result[0].tiltSupported).toBe(true);
  });

  test('should produce two endpoints for 6 standalone BLIND_VIRTUAL_RECEIVER channels', () => {
    const channels = Array.from({ length: 6 }, (_, i) =>
      makeChannel({ address: `SBL001:${i + 1}`, deviceAddress: 'SBL001', channelIndex: i + 1, type: 'BLIND_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    );
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(2);
    expect(result[0].address).toBe('SBL001:1');
    expect(result[1].address).toBe('SBL001:4');
  });

  test('should set tiltSupported=false for standalone SHUTTER_VIRTUAL_RECEIVER', () => {
    const channels = Array.from({ length: 3 }, (_, i) =>
      makeChannel({ address: `SBL001:${i + 1}`, deviceAddress: 'SBL001', channelIndex: i + 1, type: 'SHUTTER_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    );
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(1);
    expect(result[0].tiltSupported).toBe(false);
  });

  test('should set tiltSupported=false for standalone BLIND_VIRTUAL_TRANSCEIVER', () => {
    const channels = Array.from({ length: 3 }, (_, i) =>
      makeChannel({ address: `SBL001:${i + 1}`, deviceAddress: 'SBL001', channelIndex: i + 1, type: 'BLIND_VIRTUAL_TRANSCEIVER', interfaceName: 'HmIP-RF' }),
    );
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(1);
    expect(result[0].tiltSupported).toBe(false);
  });

  test('should not expose slot-2 and slot-3 channels of each blind block', () => {
    const channels = Array.from({ length: 6 }, (_, i) =>
      makeChannel({ address: `SBL001:${i + 1}`, deviceAddress: 'SBL001', channelIndex: i + 1, type: 'BLIND_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    );
    const result = resolveChannelsForMatter(channels);
    const addresses = result.map((c) => c.address);
    expect(addresses).not.toContain('SBL001:2');
    expect(addresses).not.toContain('SBL001:3');
    expect(addresses).not.toContain('SBL001:5');
    expect(addresses).not.toContain('SBL001:6');
  });
});

// ---------------------------------------------------------------------------
// Power-meter channel merging
// ---------------------------------------------------------------------------

describe('resolveChannelsForMatter – power-meter merging', () => {
  test('should set powerMeterChannelAddress on SWITCH when exactly one SWITCH and one POWERMETER exist', () => {
    const channels = [
      makeChannel({ address: 'BSM001:3', deviceAddress: 'BSM001', channelIndex: 3, type: 'SWITCH', interfaceName: 'BidCos-RF' }),
      makeChannel({ address: 'BSM001:4', deviceAddress: 'BSM001', channelIndex: 4, type: 'POWERMETER', interfaceName: 'BidCos-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    const switchCh = result.find((c) => c.type === 'SWITCH');
    expect(switchCh?.powerMeterChannelAddress).toBe('BSM001:4');
    expect(switchCh?.powerMeterIsHmIP).toBe(false);
  });

  test('should set powerMeterIsHmIP=true for ENERGIE_METER_TRANSMITTER', () => {
    const channels = [
      makeChannel({ address: 'BSM001:3', deviceAddress: 'BSM001', channelIndex: 3, type: 'SWITCH', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BSM001:4', deviceAddress: 'BSM001', channelIndex: 4, type: 'ENERGIE_METER_TRANSMITTER', interfaceName: 'HmIP-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    const switchCh = result.find((c) => c.type === 'SWITCH');
    expect(switchCh?.powerMeterChannelAddress).toBe('BSM001:4');
    expect(switchCh?.powerMeterIsHmIP).toBe(true);
  });

  test('should NOT merge when multiple SWITCH channels exist on the same device', () => {
    const channels = [
      makeChannel({ address: 'DEV001:1', deviceAddress: 'DEV001', channelIndex: 1, type: 'SWITCH', interfaceName: 'BidCos-RF' }),
      makeChannel({ address: 'DEV001:2', deviceAddress: 'DEV001', channelIndex: 2, type: 'SWITCH', interfaceName: 'BidCos-RF' }),
      makeChannel({ address: 'DEV001:3', deviceAddress: 'DEV001', channelIndex: 3, type: 'POWERMETER', interfaceName: 'BidCos-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    const switchChannels = result.filter((c) => c.type === 'SWITCH');
    expect(switchChannels.every((c) => c.powerMeterChannelAddress === undefined)).toBe(true);
  });

  test('should not include POWERMETER in the result', () => {
    const channels = [
      makeChannel({ address: 'BSM001:3', deviceAddress: 'BSM001', channelIndex: 3, type: 'SWITCH', interfaceName: 'BidCos-RF' }),
      makeChannel({ address: 'BSM001:4', deviceAddress: 'BSM001', channelIndex: 4, type: 'POWERMETER', interfaceName: 'BidCos-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    expect(result.every((c) => c.type !== 'POWERMETER')).toBe(true);
  });

  test('should not include ENERGIE_METER_TRANSMITTER in the result', () => {
    const channels = [
      makeChannel({ address: 'BSM001:3', deviceAddress: 'BSM001', channelIndex: 3, type: 'SWITCH', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BSM001:4', deviceAddress: 'BSM001', channelIndex: 4, type: 'ENERGIE_METER_TRANSMITTER', interfaceName: 'HmIP-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    expect(result.every((c) => c.type !== 'ENERGIE_METER_TRANSMITTER')).toBe(true);
  });

  test('should merge power meter with a remapped HmIP SWITCH virtual channel', () => {
    const channels = [
      makeChannel({ address: 'BSM001:1', deviceAddress: 'BSM001', channelIndex: 1, type: 'SWITCH_TRANSMITTER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BSM001:2', deviceAddress: 'BSM001', channelIndex: 2, type: 'SWITCH_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BSM001:3', deviceAddress: 'BSM001', channelIndex: 3, type: 'SWITCH_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BSM001:4', deviceAddress: 'BSM001', channelIndex: 4, type: 'SWITCH_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'BSM001:5', deviceAddress: 'BSM001', channelIndex: 5, type: 'ENERGIE_METER_TRANSMITTER', interfaceName: 'HmIP-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('SWITCH');
    expect(result[0].powerMeterChannelAddress).toBe('BSM001:5');
    expect(result[0].powerMeterIsHmIP).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Filtering: KEY_TRANSCEIVER on VirtualDevices
// ---------------------------------------------------------------------------

describe('resolveChannelsForMatter – KEY_TRANSCEIVER filtering', () => {
  test('should filter out KEY_TRANSCEIVER on VirtualDevices', () => {
    const channels = [makeChannel({ address: 'DEV001:1', deviceAddress: 'DEV001', channelIndex: 1, type: 'KEY_TRANSCEIVER', interfaceName: 'VirtualDevices' })];
    expect(resolveChannelsForMatter(channels)).toHaveLength(0);
  });

  test('should NOT filter KEY_TRANSCEIVER on BidCos-RF', () => {
    const channels = [makeChannel({ address: 'DEV001:1', deviceAddress: 'DEV001', channelIndex: 1, type: 'KEY_TRANSCEIVER', interfaceName: 'BidCos-RF' })];
    expect(resolveChannelsForMatter(channels)).toHaveLength(1);
  });

  test('should NOT filter KEY_TRANSCEIVER on HmIP-RF', () => {
    const channels = [makeChannel({ address: 'DEV001:1', deviceAddress: 'DEV001', channelIndex: 1, type: 'KEY_TRANSCEIVER', interfaceName: 'HmIP-RF' })];
    expect(resolveChannelsForMatter(channels)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Filtering: HmIP-HEATING channel 5 on VirtualDevices
// ---------------------------------------------------------------------------

describe('resolveChannelsForMatter – HmIP-HEATING ch5/VirtualDevices filtering', () => {
  test('should filter out HmIP-HEATING channel 5 on VirtualDevices', () => {
    const channels = [makeChannel({ address: 'HTG001:5', deviceAddress: 'HTG001', channelIndex: 5, type: 'SWITCH', deviceType: 'HmIP-HEATING', interfaceName: 'VirtualDevices' })];
    expect(resolveChannelsForMatter(channels)).toHaveLength(0);
  });

  test('should NOT filter HmIP-HEATING channel 5 on HmIP-RF', () => {
    const channels = [makeChannel({ address: 'HTG001:5', deviceAddress: 'HTG001', channelIndex: 5, type: 'SWITCH', deviceType: 'HmIP-HEATING', interfaceName: 'HmIP-RF' })];
    expect(resolveChannelsForMatter(channels)).toHaveLength(1);
  });

  test('should NOT filter HmIP-HEATING channel 4 on VirtualDevices', () => {
    const channels = [makeChannel({ address: 'HTG001:4', deviceAddress: 'HTG001', channelIndex: 4, type: 'SWITCH', deviceType: 'HmIP-HEATING', interfaceName: 'VirtualDevices' })];
    expect(resolveChannelsForMatter(channels)).toHaveLength(1);
  });

  test('should NOT filter channel 5 from a different deviceType on VirtualDevices', () => {
    const channels = [makeChannel({ address: 'DEV001:5', deviceAddress: 'DEV001', channelIndex: 5, type: 'SWITCH', deviceType: 'HmIP-OTHER', interfaceName: 'VirtualDevices' })];
    expect(resolveChannelsForMatter(channels)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-device isolation
// ---------------------------------------------------------------------------

describe('resolveChannelsForMatter – multi-device isolation', () => {
  test('should process channels from two different devices independently', () => {
    const channels = [
      makeChannel({ address: 'DEV001:1', deviceAddress: 'DEV001', channelIndex: 1, type: 'SWITCH', interfaceName: 'BidCos-RF' }),
      makeChannel({ address: 'DEV002:1', deviceAddress: 'DEV002', channelIndex: 1, type: 'SHUTTER_CONTACT', interfaceName: 'BidCos-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.address)).toEqual(expect.arrayContaining(['DEV001:1', 'DEV002:1']));
  });

  test('should not merge power meter from a different device into the switch', () => {
    const channels = [
      makeChannel({ address: 'DEV001:1', deviceAddress: 'DEV001', channelIndex: 1, type: 'SWITCH', interfaceName: 'BidCos-RF' }),
      makeChannel({ address: 'DEV002:1', deviceAddress: 'DEV002', channelIndex: 1, type: 'POWERMETER', interfaceName: 'BidCos-RF' }),
    ];
    const result = resolveChannelsForMatter(channels);
    const switchCh = result.find((c) => c.type === 'SWITCH');
    expect(switchCh?.powerMeterChannelAddress).toBeUndefined();
  });

  test('should produce the correct total count of channels across multiple devices', () => {
    const channels = [
      makeChannel({ address: 'DEV001:1', deviceAddress: 'DEV001', channelIndex: 1, type: 'SWITCH', interfaceName: 'BidCos-RF' }),
      makeChannel({ address: 'DEV001:2', deviceAddress: 'DEV001', channelIndex: 2, type: 'SWITCH', interfaceName: 'BidCos-RF' }),
      makeChannel({ address: 'DEV002:1', deviceAddress: 'DEV002', channelIndex: 1, type: 'SWITCH_TRANSMITTER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'DEV002:2', deviceAddress: 'DEV002', channelIndex: 2, type: 'SWITCH_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'DEV002:3', deviceAddress: 'DEV002', channelIndex: 3, type: 'SWITCH_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
      makeChannel({ address: 'DEV002:4', deviceAddress: 'DEV002', channelIndex: 4, type: 'SWITCH_VIRTUAL_RECEIVER', interfaceName: 'HmIP-RF' }),
    ];
    // DEV001: 2 classic SWITCH channels; DEV002: 1 remapped SWITCH from HmIP pair.
    const result = resolveChannelsForMatter(channels);
    expect(result).toHaveLength(3);
  });
});
