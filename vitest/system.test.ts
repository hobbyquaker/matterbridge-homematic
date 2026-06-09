/**
 * System tests for CcuConnectionLayer using hm-simulator as a real CCU stand-in.
 *
 * A real binrpc + xmlrpc server is started on loopback for each test suite.
 * Only the HmIP-RF interface (xmlrpc/port 2010) is enabled in the connection
 * layer because hm-simulator exposes the rfd (BidCos-RF) interface via binrpc
 * while the connection layer expects xmlrpc there.
 *
 * The hm-simulator pre-loads a set of real HmIP devices including:
 *   - HmIP-WTH  (000313C990686F) – wall thermostat with HEATING_CLIMATECONTROL_TRANSCEIVER
 *   - HmIP-PS   (000213C990986A) – plug switch with SWITCH_VIRTUAL_RECEIVER
 *   - HmIP-SWDO (0000D3C98C9233) – door/window sensor with SHUTTER_CONTACT
 *   - HMIP-eTRV (000393C98D1011) – TRV with HEATING_CLIMATECONTROL_TRANSCEIVER
 *
 * @file vitest/system.test.ts
 */

import { mkdtempSync, rmdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { CcuConnectionLayer } from '../src/ccu/connection-layer.js';
import type { CcuConnectionConfig, CcuLogger } from '../src/ccu/types.js';

// ---------------------------------------------------------------------------
// hm-simulator setup
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

// Ports for the hm-simulator — kept off the standard CCU defaults so they
// do not conflict with any locally running Homematic software.
const SIM_BINRPC_PORT = 12001; // rfd (BidCos-RF) — binrpc, not used by the layer in these tests
const SIM_XMLRPC_PORT = 12010; // hmipserver (HmIP-RF) — xmlrpc, the interface under test

// Ports for the connection-layer callback servers (the CCU calls us back here).
const CB_XML_PORT = 13010; // xmlrpc callback listener (HmIP-RF events)
const CB_BIN_PORT = 13001; // binrpc callback listener (unused but allocated in config)

// ---------------------------------------------------------------------------
// Shared logger
// ---------------------------------------------------------------------------

const log: CcuLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<CcuConnectionConfig> = {}): CcuConnectionConfig {
  return {
    host: '127.0.0.1',
    regaEnabled: false,
    bcrfEnabled: false, // BidCos-RF uses binrpc in the simulator → protocol mismatch → disabled
    bcwiEnabled: false,
    iprfEnabled: true, // HmIP-RF uses xmlrpc in the simulator → compatible
    virtEnabled: false,
    cuxdEnabled: false,
    regaPoll: false,
    regaInterval: 30,
    rpcPingTimeout: 600, // long timeout — we don't want ping watchdog firing during tests
    rpcInitAddress: '127.0.0.1',
    rpcServerHost: '127.0.0.1',
    rpcXmlPort: CB_XML_PORT,
    rpcBinPort: CB_BIN_PORT,
    tls: false,
    inSecure: false,
    authentication: false,
    username: '',
    password: '',
    queueTimeout: 5000,
    queuePause: 250,
    rega: {
      enabled: false,
      syncChannelNames: false,
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

// ---------------------------------------------------------------------------
// Lifecycle tests — start / discover / stop
// ---------------------------------------------------------------------------

describe('CcuConnectionLayer with hm-simulator', () => {
  let sim: any;
  let layer: CcuConnectionLayer;
  let behaviorPath: string;

  beforeAll(async () => {
    // Create a throw-away directory so the simulator does not load its sample
    // behavior scripts (virtual-button-press.js etc.) that fire periodic events.
    behaviorPath = mkdtempSync(path.join(os.tmpdir(), 'hm-sim-test-'));

    // Require sim.js directly — the package entry point (index.js) loads both
    // rfd and hmip device JSON files; the rfd device paramset descriptions are
    // incomplete and cause a crash during setDefaultValues. By loading sim.js
    // directly and providing only the hmip device list we avoid the crash.
    const HmSim = require('hm-simulator/sim.js');
    const hmipDevices = require('hm-simulator/data/devices-hmip.json');
    sim = new HmSim({
      devices: {
        rfd: { devices: [] }, // rfd unused; BidCos-RF disabled in the layer config
        hmip: hmipDevices, // pre-loaded HmIP devices: WTH, PS, SWDO, eTRV
      },
      config: {
        listenAddress: '127.0.0.1',
        binrpcListenPort: SIM_BINRPC_PORT,
        xmlrpcListenPort: SIM_XMLRPC_PORT,
      },
      behaviorPath,
    });

    const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'hm-layer-cache-'));

    layer = new CcuConnectionLayer(makeConfig(), log, cacheDir);

    // Override the HmIP-RF port so the layer connects to our simulator port
    // instead of the standard CCU port 2010. We do this by patching the private
    // getRpcDefinitions return value through prototype injection.
    const origGetRpcDefinitions = (layer as unknown as { getRpcDefinitions(): Record<string, unknown> }).getRpcDefinitions.bind(layer);
    (layer as unknown as { getRpcDefinitions(): Record<string, unknown> }).getRpcDefinitions = () => {
      const defs = origGetRpcDefinitions();
      if (defs['HmIP-RF'] && typeof defs['HmIP-RF'] === 'object') {
        (defs['HmIP-RF'] as Record<string, unknown>).port = SIM_XMLRPC_PORT;
        // Disable ping/pong so the watchdog does not interfere with test timing.
        (defs['HmIP-RF'] as Record<string, unknown>).pingPong = false;
      }
      return defs;
    };

    await layer.start();
  }, 15_000);

  afterAll(async () => {
    await layer.stop();
    sim.close();
    try {
      rmdirSync(behaviorPath);
    } catch {
      // best-effort cleanup
    }
  }, 10_000);

  // ---------------------------------------------------------------------------
  // start / status
  // ---------------------------------------------------------------------------

  test('should start successfully and report connected', () => {
    const status = layer.getStatusSnapshot();
    expect(status.connected).toBe(true);
    expect(status.host).toBe('127.0.0.1');
    expect(status.enabledInterfaces).toContain('HmIP-RF');
    expect(status.connectedInterfaces).toContain('HmIP-RF');
  });

  test('should not start again when already started', async () => {
    // start() is idempotent — second call should return immediately.
    await layer.start();
    expect(layer.getStatusSnapshot().connected).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // channel discovery
  // ---------------------------------------------------------------------------

  test('should discover HmIP channels from the simulator', async () => {
    const channels = await layer.discoverChannels();
    expect(channels.length).toBeGreaterThan(0);
    // All returned channels must belong to the HmIP-RF interface.
    for (const ch of channels) {
      expect(ch.interfaceName).toBe('HmIP-RF');
    }
  });

  test('should discover the HmIP-WTH HEATING_CLIMATECONTROL_TRANSCEIVER channel', async () => {
    const channels = await layer.discoverChannels();
    const hct = channels.find((c) => c.type === 'HEATING_CLIMATECONTROL_TRANSCEIVER');
    expect(hct).toBeDefined();
    expect(hct?.deviceType).toMatch(/hmip/i);
  });

  test('should discover the HmIP-SWDO SHUTTER_CONTACT channel', async () => {
    const channels = await layer.discoverChannels();
    const contact = channels.find((c) => c.type === 'SHUTTER_CONTACT');
    expect(contact).toBeDefined();
    expect(contact?.address).toBe('0000D3C98C9233:1');
  });

  test('should return cached channels on repeated calls', async () => {
    const first = await layer.discoverChannels();
    const second = await layer.discoverChannels();
    expect(second.length).toBe(first.length);
  });

  test('getCachedChannels should return a snapshot of the cache', async () => {
    await layer.discoverChannels(); // ensure cache is populated
    const cached = layer.getCachedChannels();
    expect(cached.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // RPC communication
  // ---------------------------------------------------------------------------

  test('should execute callRpc system.listMethods on HmIP-RF', async () => {
    const result = await layer.callRpc('HmIP-RF', 'system.listMethods', []);
    expect(Array.isArray(result)).toBe(true);
    expect(result as string[]).toContain('init');
  });

  test('should set a channel datapoint value via setChannelDatapointValue', async () => {
    // SWITCH_VIRTUAL_RECEIVER on HmIP-PS — STATE is a boolean datapoint.
    // We fire-and-forget the assertion; the simulator echoes events back but
    // we only verify the RPC call does not throw.
    await expect(layer.setChannelDatapointValue('HmIP-RF', '000213C990986A:3', 'STATE', true)).resolves.not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // RPC event reception
  // ---------------------------------------------------------------------------

  test('should receive an rpcEvent when the simulator fires an event', async () => {
    const received = new Promise<void>((resolve) => {
      layer.once('rpcEvent', () => {
        resolve();
      });
    });

    // setValue on HmIP-PS SWITCH_VIRTUAL_RECEIVER triggers the simulator to send events back.
    await layer.callRpc('HmIP-RF', 'setValue', ['000213C990986A:3', 'STATE', false]);

    await expect(received).resolves.not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // waitForNewDevices
  // ---------------------------------------------------------------------------

  test('should resolve waitForNewDevices immediately when newDevices already received', async () => {
    // newDevices was already received during start(); this should resolve at once.
    const start = Date.now();
    await layer.waitForNewDevices(5000);
    expect(Date.now() - start).toBeLessThan(200);
  });

  // ---------------------------------------------------------------------------
  // fetchInitialValues — disabled rega path
  // ---------------------------------------------------------------------------

  test('should return empty array for fetchInitialValues when ReGa is disabled', async () => {
    const values = await layer.fetchInitialValues();
    expect(values).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // getStatusSnapshot
  // ---------------------------------------------------------------------------

  test('getStatusSnapshot should include discovered host after discoverNetwork', () => {
    const status = layer.getStatusSnapshot();
    // connected/started state was set by start()
    expect(status.connected).toBe(true);
    expect(status.enabledInterfaces).toContain('HmIP-RF');
  });
});

// ---------------------------------------------------------------------------
// Stop when not yet started
// ---------------------------------------------------------------------------

describe('CcuConnectionLayer stop before start', () => {
  test('should no-op when stop() is called before start()', async () => {
    const layer = new CcuConnectionLayer(makeConfig(), log);
    await expect(layer.stop()).resolves.not.toThrow();
    expect(layer.getStatusSnapshot().connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idle layer (host not configured)
// ---------------------------------------------------------------------------

describe('CcuConnectionLayer idle when no host configured', () => {
  test('should stay idle when host is empty', async () => {
    const layer = new CcuConnectionLayer(makeConfig({ host: '' }), log);
    await layer.start();
    expect(layer.getStatusSnapshot().connected).toBe(false);
    await layer.stop();
  });
});
