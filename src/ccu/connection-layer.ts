/**
 * CCU connection layer based on node-red-contrib-ccu communication patterns.
 *
 * @file connection-layer.ts
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { getMatchingMainsPoweredPrefix, isAlwaysMainsPoweredDeviceType } from './device-power.js';
import {
  CcuChannelInfo,
  CcuConnectionConfig,
  CcuDiscoveredDevice,
  CcuDiscoveryCache,
  CcuInterfaceName,
  CcuLogger,
  CcuReGaDatapoint,
  CcuStatusSnapshot,
  RegaChannel,
  RegaClient,
  RpcClient,
  RpcClientFactory,
  RpcServer,
} from './types.js';

const require = createRequire(import.meta.url);

const hmDiscover = require('hm-discover') as (callback: (devices: CcuDiscoveredDevice[]) => void) => void;
const RegaConstructor = require('homematic-rega') as new (options: Record<string, unknown>) => RegaClient;
const xmlrpc = require('homematic-xmlrpc') as RpcClientFactory;
const binrpc = require('binrpc') as RpcClientFactory;

type RpcInterfaceName = Exclude<CcuInterfaceName, 'ReGaHSS'>;

interface RpcDeviceDescription {
  ADDRESS: string;
  TYPE: string;
}

interface RpcInterfaceDefinition {
  enabled: boolean;
  module: RpcClientFactory;
  protocol: 'xmlrpc' | 'binrpc';
  port: number;
  path?: string;
  /** Whether this interface supports the ping/pong watchdog mechanism. */
  pingPong: boolean;
}

export class CcuConnectionLayer extends EventEmitter {
  /**
   * Set a datapoint value on a Homematic channel via RPC.
   *
   * @param {RpcInterfaceName} iface Interface name (e.g. 'BidCos-RF', 'HmIP-RF').
   * @param {string} channelAddress Full channel address (e.g. 'OEQ0854602:1').
   * @param {string} datapoint Datapoint name (e.g. 'STATE').
   * @param {boolean|number} value Value to set (boolean or number).
   * @param {number} [timeoutMs] Optional timeout in milliseconds for the RPC call.
   */
  private readonly clients = new Map<RpcInterfaceName, RpcClient>();

  private readonly callbackServers = new Map<'xmlrpc' | 'binrpc', RpcServer>();

  private readonly initIdToInterface = new Map<string, RpcInterfaceName>();

  private readonly connectedInterfaces = new Set<CcuInterfaceName>();

  /** Timestamp of the last received RPC event (including PONG) per interface. */
  private readonly lastRpcEventTime = new Map<RpcInterfaceName, number>();

  /** Active ping/pong watchdog timers per interface. */
  private readonly pingTimers = new Map<RpcInterfaceName, ReturnType<typeof setTimeout>>();

  private readonly discoveredHosts = new Set<string>();

  private readonly deviceBatteryHints = new Map<string, boolean>();

  private readonly cacheFilePath: string;

  private cache: CcuDiscoveryCache = { channels: [], nameMap: {}, timestamp: 0 };

  private regaClient?: RegaClient;

  private started = false;

  /**
   * Create a CCU connection layer.
   *
   * @param {CcuConnectionConfig} config Parsed CCU connection config.
   * @param {CcuLogger} log Logger from the platform.
   * @param {string} cacheDir Directory to store cache files (optional).
   */
  constructor(
    private readonly config: CcuConnectionConfig,
    private readonly log: CcuLogger,
    cacheDir?: string,
  ) {
    super();
    this.cacheFilePath = path.join(cacheDir ?? process.cwd(), 'matterbridge-homematic-discovery.cache.json');
  }

  /**
   * Set a datapoint value on a Homematic channel via setValue RPC.
   *
   * @param {RpcInterfaceName} iface Interface name (e.g. 'BidCos-RF', 'HmIP-RF').
   * @param {string} channelAddress Full channel address (e.g. 'OEQ0854602:1').
   * @param {string} datapoint Datapoint name (e.g. 'STATE').
   * @param {boolean|number|string} value Value to set (boolean, number, or string).
   * @param {number} [timeoutMs] Optional timeout in milliseconds for the RPC call.
   */
  public async setChannelDatapointValue(
    iface: RpcInterfaceName,
    channelAddress: string,
    datapoint: string,
    value: boolean | number | string,
    timeoutMs = this.getRequestTimeoutMs(),
  ): Promise<void> {
    await this.callRpc(iface, 'setValue', [channelAddress, datapoint, value], timeoutMs);
    this.log.debug(`setChannelDatapointValue -> iface=${iface} channel=${channelAddress} datapoint=${datapoint} value=${value}`);
  }

  /**
   * Set multiple VALUES paramset entries on a Homematic channel atomically via putParamset.
   * Used for blind actuators that require LEVEL and LEVEL_2 to be written together.
   *
   * @param {RpcInterfaceName} iface Interface name.
   * @param {string} channelAddress Full channel address (e.g. 'OEQ0854602:1').
   * @param {Record<string, unknown>} values Key/value pairs to write into the VALUES paramset.
   * @param {number} [timeoutMs] Optional timeout in milliseconds.
   */
  public async putChannelParamsetValues(iface: RpcInterfaceName, channelAddress: string, values: Record<string, unknown>, timeoutMs = this.getRequestTimeoutMs()): Promise<void> {
    await this.callRpc(iface, 'putParamset', [channelAddress, 'VALUES', values], timeoutMs);
    this.log.debug(`putChannelParamsetValues -> iface=${iface} channel=${channelAddress} values=${this.formatPayload(values)}`);
  }

  /**
   * Start discovery and initialize configured CCU interfaces.
   *
   * @returns {Promise<void>} Promise that resolves when initialization is complete.
   */
  async start(): Promise<void> {
    if (this.started) return;

    if (this.config.host.length === 0) {
      this.log.warn('CCU host is not configured. Connection layer will stay idle.');
      return;
    }

    await this.loadCache();

    await this.discoverNetwork();

    this.initRegaClient();
    this.initRpcClients();
    await this.initRpcCallbackServersAndSubscribe();

    this.log.debug(`RPC event listener setup complete: xmlrpc=${this.callbackServers.has('xmlrpc')} binrpc=${this.callbackServers.has('binrpc')}`);

    this.started = true;
    this.log.info(`CCU connection layer started for ${this.config.host}.`);
    this.emit('started', this.getStatusSnapshot());
  }

  /**
   * Stop and clear all connections.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    await this.deinitRpcCallbacksAndCloseServers();

    this.clients.clear();
    this.initIdToInterface.clear();
    this.connectedInterfaces.clear();
    this.deviceBatteryHints.clear();
    this.regaClient = undefined;
    this.started = false;
    this.log.info('CCU connection layer stopped.');
    this.emit('stopped');
  }

  /**
   * Return the current status snapshot for consumers.
   *
   * @returns {CcuStatusSnapshot} Current status details.
   */
  getStatusSnapshot(): CcuStatusSnapshot {
    return {
      host: this.config.host,
      connected: this.started,
      enabledInterfaces: this.getEnabledInterfaces(),
      connectedInterfaces: [...this.connectedInterfaces],
      discoveredHosts: [...this.discoveredHosts],
    };
  }

  /**
   * Execute a method call on a configured RPC interface.
   *
   * @param {RpcInterfaceName} iface Interface name.
   * @param {string} method RPC method name.
   * @param {unknown[]} parameters RPC method parameters.
   * @param {number} timeoutMs Request timeout in milliseconds.
   * @returns {Promise<unknown>} Method response.
   */
  async callRpc(iface: RpcInterfaceName, method: string, parameters: unknown[] = [], timeoutMs = this.getRequestTimeoutMs()): Promise<unknown> {
    const client = this.clients.get(iface);
    if (!client) {
      throw new Error(`RPC interface ${iface} is not connected.`);
    }

    const started = Date.now();
    this.log.debug(`RPC call -> iface=${iface} method=${method} timeoutMs=${timeoutMs} params=${this.formatPayload(parameters)}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const duration = Date.now() - started;
        const error = new Error(`RPC ${iface}.${method} timed out after ${timeoutMs} ms`);
        this.log.warn(`RPC timeout <- iface=${iface} method=${method} durationMs=${duration}`);
        reject(error);
      }, timeoutMs);

      client.methodCall(method, parameters, (error, result) => {
        clearTimeout(timer);
        const duration = Date.now() - started;
        if (error) {
          this.log.warn(`RPC error <- iface=${iface} method=${method} durationMs=${duration} error=${String(error)}`);
          this.emit('rpcError', iface, error);
          reject(error);
          return;
        }
        this.log.debug(`RPC result <- iface=${iface} method=${method} durationMs=${duration} result=${this.formatPayload(result)}`);
        resolve(result);
      });
    });
  }

  /**
   * Discover all channels from every connected RPC interface and enrich them with ReGa display names.
   *
   * @returns {Promise<CcuChannelInfo[]>} List of all discovered channels.
   */
  async discoverChannels(): Promise<CcuChannelInfo[]> {
    let performedInitialRefresh = false;

    // Return cached data immediately when available.
    if (this.cache.channels.length > 0) {
      this.log.debug(`discoverChannels: returning cached ${this.cache.channels.length} channels`);
    } else {
      // Ensure cache is loaded on first call
      await this.loadCache();

      // On first startup with an empty cache, wait for a real refresh so the platform can
      // register devices immediately instead of exposing zero devices until the next restart.
      if (this.cache.channels.length === 0) {
        await this.refreshChannelsCache();
        performedInitialRefresh = true;
      }
    }

    if (this.cache.channels.length > 0 && !performedInitialRefresh) {
      // Spawn background refresh without awaiting when we already have cached data.
      this.refreshChannelsCache().catch((err) => {
        this.log.warn(`Failed to refresh channel cache: ${String(err)}`);
      });
    }

    const enabledInterfaces = new Set(this.getEnabledInterfaces());
    const filteredChannels = this.cache.channels.filter((channel) => enabledInterfaces.has(channel.interfaceName));

    if (filteredChannels.length !== this.cache.channels.length) {
      this.log.debug(
        `discoverChannels: filtered cached channels from ${this.cache.channels.length} to ${filteredChannels.length} using enabled interfaces ${[...enabledInterfaces].join(',')}`,
      );
    }

    return filteredChannels;
  }

  /**
   * Return the current cached discovery channels, including channels from disabled interfaces.
   *
   * @returns {CcuChannelInfo[]} Snapshot of the discovery cache.
   */
  getCachedChannels(): CcuChannelInfo[] {
    return [...this.cache.channels];
  }

  /**
   * Refresh the channel cache from RPC and ReGa (runs in background).
   *
   * @returns {Promise<void>} Promise that resolves when refresh is complete.
   */
  private async refreshChannelsCache(): Promise<void> {
    this.log.debug('refreshChannelsCache: started');
    const nameMap = await this.getRegaChannelNameMap();
    const channelLists = await Promise.all(
      [...this.clients.keys()].map(async (iface): Promise<CcuChannelInfo[]> => {
        try {
          const devices = (await this.callRpc(iface, 'listDevices', [])) as RpcDeviceDescription[];
          const deviceTypeByAddress = new Map<string, string>();

          for (const dev of devices) {
            if (typeof dev.ADDRESS !== 'string' || dev.ADDRESS.includes(':')) continue;
            if (typeof dev.TYPE !== 'string') continue;
            deviceTypeByAddress.set(dev.ADDRESS, dev.TYPE);
          }

          const channels: CcuChannelInfo[] = [];

          for (const dev of devices) {
            if (!dev.ADDRESS.includes(':')) continue;

            const colonIndex = dev.ADDRESS.indexOf(':');
            const deviceAddress = dev.ADDRESS.slice(0, colonIndex);
            const channelIndex = parseInt(dev.ADDRESS.slice(colonIndex + 1), 10);

            channels.push({
              address: dev.ADDRESS,
              deviceAddress,
              channelIndex,
              type: dev.TYPE,
              deviceType: deviceTypeByAddress.get(deviceAddress),
              interfaceName: iface,
              name: nameMap.get(dev.ADDRESS),
              batteryPowered: this.deviceBatteryHints.get(deviceAddress),
            });
          }

          return channels;
        } catch (err) {
          this.log.warn(`RPC listDevices failed on ${iface}: ${String(err)}`);
          return [];
        }
      }),
    );

    const channels = channelLists.flat();

    // Update cache and persistence
    this.cache = {
      channels,
      nameMap: Object.fromEntries(nameMap),
      timestamp: Date.now(),
    };

    await this.saveCache();
    this.log.debug(`discoverChannels cache: refreshed ${channels.length} channels and saved to disk`);
    this.emit('channelsUpdated', channels);
  }

  private async getRegaChannelNameMap(): Promise<Map<string, string>> {
    const nameMap = new Map<string, string>();

    this.log.debug(`getRegaChannelNameMap check <- regaClient=${this.regaClient ? 'initialized' : 'null'} syncChannelNames=${this.config.rega.syncChannelNames}`);

    if (!this.regaClient || !this.config.rega.syncChannelNames) {
      this.log.debug(`getRegaChannelNameMap early return <- reason=${!this.regaClient ? 'regaClient not initialized' : 'syncChannelNames is false'}`);
      return nameMap;
    }

    try {
      const started = Date.now();
      this.log.debug('ReGa call -> method=getChannels');
      const channels = await new Promise<RegaChannel[]>((resolve, reject) => {
        const timeoutMs = this.getRequestTimeoutMs();
        const timer = setTimeout(() => {
          this.log.warn(`ReGa timeout <- method=getChannels timeoutMs=${timeoutMs}`);
          reject(new Error(`ReGa getChannels timed out after ${timeoutMs} ms`));
        }, timeoutMs);

        this.regaClient?.getChannels((error, result) => {
          clearTimeout(timer);
          if (error) {
            this.log.warn(`ReGa error <- method=getChannels error=${String(error)}`);
            reject(error);
            return;
          }
          const resultArray = Array.isArray(result) ? result : [];
          this.log.debug(`ReGa raw result <- method=getChannels type=${typeof result} isArray=${Array.isArray(result)} length=${resultArray.length}`);
          resolve(resultArray);
        });
      });
      this.log.debug(`ReGa result <- method=getChannels durationMs=${Date.now() - started} channels=${channels.length}`);

      for (const channel of channels) {
        const hasValidAddress = typeof channel.address === 'string' && channel.address.includes(':');

        if (!hasValidAddress) {
          this.log.debug(`ReGa channel skipped <- invalid address: ${JSON.stringify(channel)}`);
          continue;
        }

        const trimmedName = typeof channel.name === 'string' ? channel.name.trim() : '';

        if (trimmedName) {
          nameMap.set(channel.address, trimmedName);
          this.log.debug(`ReGa channel name added <- address=${channel.address} name=${trimmedName}`);
        } else {
          this.log.debug(`ReGa channel has no name <- address=${channel.address} rawName=${JSON.stringify(channel.name)}`);
        }
      }

      this.log.debug(`ReGa channel names summary <- total=${nameMap.size} entries=${this.formatPayload(Object.fromEntries(nameMap))}`);
    } catch (err) {
      this.log.warn(`ReGa channel name fetch via getChannels failed: ${String(err)}`);
    }

    return nameMap;
  }

  private getRequestTimeoutMs(): number {
    const timeout = Number(this.config.queueTimeout);
    if (Number.isFinite(timeout) && timeout > 0) return timeout;
    return 5000;
  }

  private getInitAddress(): string {
    const configured = this.config.rpcInitAddress?.trim();
    if (configured && configured.length > 0) return configured;
    return this.config.rpcServerHost;
  }

  private getCallbackUrl(protocol: 'xmlrpc' | 'binrpc'): string {
    const host = this.getInitAddress();
    if (protocol === 'binrpc') {
      return `xmlrpc_bin://${host}:${this.config.rpcBinPort}`;
    }
    const scheme = this.config.tls ? 'https' : 'http';
    return `${scheme}://${host}:${this.config.rpcXmlPort}`;
  }

  private getInterfaceInitId(iface: RpcInterfaceName): string {
    return `mb_${iface.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }

  private getIfaceFromInitId(idInit: unknown): RpcInterfaceName | undefined {
    if (typeof idInit !== 'string') return undefined;
    return this.initIdToInterface.get(idInit);
  }

  private getRpcCallbackMethodNames(): string[] {
    return [
      'system.listMethods',
      'system.methodHelp',
      'event',
      'system.multicall',
      'newDevices',
      'deleteDevices',
      'updateDevice',
      'replaceDevice',
      'readdedDevice',
      'setReadyConfig',
      'listDevices',
      'init',
    ];
  }

  private toJsonSafe(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private formatPayload(value: unknown): string {
    const raw = this.toJsonSafe(value);
    if (!this.config.logging.truncatePayloadsToSingleLine) return raw;
    const compact = raw.replace(/[\r\n\s]+/g, ' ').trim();
    return compact.length > 200 ? `${compact.slice(0, 200)}\u2026` : compact;
  }

  private handleRpcCallback(method: string, parameters: unknown[]): unknown {
    if (this.config.logging.logRpcEvents) {
      this.log.debug(`RPC callback <- method=${method} params=${this.formatPayload(parameters)}`);
    }
    this.emit('rpcCallback', method, parameters);

    if (method === 'newDevices') {
      this.processNewDevicesCallback(parameters);
      return '';
    }

    if (method === 'event') {
      const [idInit, channel, datapoint, value] = parameters;
      const iface = this.getIfaceFromInitId(idInit);
      // Update watchdog timestamp for every event, including PONG.
      if (iface) {
        this.lastRpcEventTime.set(iface, Date.now());
      }
      // PONG events only serve the watchdog — do not forward to subscribers.
      if (typeof channel === 'string' && channel.includes('CENTRAL') && datapoint === 'PONG') {
        if (this.config.logging.logRpcEvents) this.log.debug(`RPC PONG <- iface=${iface ?? 'unknown'}`);
        return '';
      }
      if (this.config.logging.logRpcEvents) {
        this.log.debug(`RPC event <- iface=${iface ?? 'unknown'} channel=${String(channel ?? '')} datapoint=${String(datapoint ?? '')} value=${this.formatPayload(value)}`);
      }
      this.emit('rpcEvent', {
        iface,
        idInit,
        channel,
        datapoint,
        value,
      });
      return '';
    }

    if (method === 'system.multicall') {
      const calls = Array.isArray(parameters[0]) ? (parameters[0] as Array<{ methodName?: string; params?: unknown[] }>) : [];
      return calls.map((call) => {
        const callMethod = typeof call?.methodName === 'string' ? call.methodName : '';
        const callParams = Array.isArray(call?.params) ? call.params : [];
        // For system.multicall we need to update the watchdog timestamp for PONG entries
        // even before delegating, so the watchdog recognises multicall-wrapped PONGs.
        if (callMethod === 'event' && Array.isArray(callParams) && callParams.length >= 3) {
          const [idInit, channel, datapoint] = callParams;
          const iface = this.getIfaceFromInitId(idInit);
          if (iface) {
            this.lastRpcEventTime.set(iface, Date.now());
          }
          if (typeof channel === 'string' && channel.includes('CENTRAL') && datapoint === 'PONG') {
            return '';
          }
        }
        this.handleRpcCallback(callMethod, callParams);
        return '';
      });
    }

    if (method === 'system.listMethods') {
      return this.getRpcCallbackMethodNames();
    }

    if (method === 'listDevices') {
      return [];
    }

    return '';
  }

  private processNewDevicesCallback(parameters: unknown[]): void {
    const iface = this.getIfaceFromInitId(parameters[0]);
    const payload = Array.isArray(parameters[1]) ? parameters[1] : [];
    const deviceTypeByAddress = new Map<string, string>();

    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      const addressValue = (entry as Record<string, unknown>).ADDRESS;
      const typeValue = (entry as Record<string, unknown>).TYPE;
      if (typeof addressValue !== 'string' || addressValue.includes(':')) continue;
      if (typeof typeValue !== 'string') continue;
      deviceTypeByAddress.set(addressValue, typeValue);
    }

    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      const addressValue = (entry as Record<string, unknown>).ADDRESS;
      if (typeof addressValue !== 'string' || !addressValue.endsWith(':0')) continue;

      const deviceAddress = addressValue.slice(0, addressValue.indexOf(':'));
      const typeValue = (entry as Record<string, unknown>).TYPE;
      const channelType = typeof typeValue === 'string' ? typeValue : undefined;
      const deviceType = deviceTypeByAddress.get(deviceAddress) ?? channelType;
      const mainsMatchPrefix = getMatchingMainsPoweredPrefix(deviceType);
      const hasLowBatMarker = this.containsLowBatMarker(entry);
      const batteryHint = isAlwaysMainsPoweredDeviceType(deviceType) ? false : hasLowBatMarker ? true : undefined;
      const previous = this.deviceBatteryHints.get(deviceAddress);

      this.log.debug(
        `RPC newDevices classify <- iface=${iface ?? 'unknown'} device=${deviceAddress} channelType=${channelType ?? 'unknown'} deviceType=${deviceType ?? 'unknown'} mainsPrefix=${mainsMatchPrefix ?? 'none'} hasLowBatMarker=${hasLowBatMarker} batteryHint=${batteryHint === undefined ? 'unknown' : String(batteryHint)} previous=${String(previous)}`,
      );

      // Absence of a LOWBAT marker in newDevices is not reliable evidence that a device is mains-powered.
      // Many battery devices (for example HmIP-WRC2) do not expose the marker in this callback payload.
      // Only persist a positive hint or a forced mains classification here; let startup paramset probing
      // decide ambiguous cases.
      if (batteryHint === undefined) continue;

      if (previous !== batteryHint) {
        this.deviceBatteryHints.set(deviceAddress, batteryHint);
        this.log.debug(`RPC newDevices battery hint <- iface=${iface ?? 'unknown'} device=${deviceAddress} batteryPowered=${batteryHint}`);
        this.emit('deviceBatteryHint', {
          iface,
          deviceAddress,
          batteryPowered: batteryHint,
        });
      }
    }
  }

  private containsLowBatMarker(value: unknown, depth = 0): boolean {
    if (depth > 6) return false;

    if (typeof value === 'string') {
      const marker = value.trim().toUpperCase();
      return marker === 'LOWBAT' || marker === 'LOW_BAT';
    }

    if (Array.isArray(value)) {
      return value.some((item) => this.containsLowBatMarker(item, depth + 1));
    }

    if (value && typeof value === 'object') {
      for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        const marker = key.trim().toUpperCase();
        if (marker === 'LOWBAT' || marker === 'LOW_BAT') {
          return true;
        }
        if (this.containsLowBatMarker(nestedValue, depth + 1)) {
          return true;
        }
      }
    }

    return false;
  }

  private createRpcCallbackServer(protocol: 'xmlrpc' | 'binrpc', moduleFactory: RpcClientFactory, host: string, port: number): RpcServer | undefined {
    if (typeof moduleFactory.createServer !== 'function') {
      this.log.warn(`RPC callback server create failed protocol=${protocol} host=${host} port=${port} reason=createServer unavailable`);
      return undefined;
    }

    this.log.info(`RPC callback server create -> protocol=${protocol} host=${host} port=${port}`);

    const server = moduleFactory.createServer({ host, port }, () => {
      this.log.info(`RPC callback server listening protocol=${protocol} host=${host} port=${port}`);
    });

    server.on('NotFound', (method: unknown, params: unknown) => {
      this.log.debug(`RPC callback <- protocol=${protocol} method=NotFound originalMethod=${String(method)} params=${this.toJsonSafe(params)}`);
    });

    for (const method of this.getRpcCallbackMethodNames()) {
      server.on(method, (...args: unknown[]) => {
        const parameters = args[1];
        const callback = args[2];
        const list = Array.isArray(parameters) ? parameters : [];
        try {
          const result = this.handleRpcCallback(method, list);
          if (typeof callback === 'function') {
            (callback as (error: unknown, result?: unknown) => void)(null, result);
          }
        } catch (error) {
          this.log.warn(`RPC callback handler failed method=${method} error=${String(error)}`);
          if (typeof callback === 'function') {
            (callback as (error: unknown, result?: unknown) => void)(error, '');
          }
        }
      });
    }

    return server;
  }

  private async initRpcCallbackServersAndSubscribe(): Promise<void> {
    const xmlIfaces = [...this.clients.keys()].filter((iface) => this.getRpcDefinitions()[iface].protocol === 'xmlrpc');
    const binIfaces = [...this.clients.keys()].filter((iface) => this.getRpcDefinitions()[iface].protocol === 'binrpc');

    if (xmlIfaces.length > 0 && !this.callbackServers.has('xmlrpc')) {
      const server = this.createRpcCallbackServer('xmlrpc', xmlrpc, this.config.rpcServerHost, this.config.rpcXmlPort);
      if (server) {
        this.callbackServers.set('xmlrpc', server);
      } else {
        this.log.warn(`RPC callback server not created protocol=xmlrpc host=${this.config.rpcServerHost} port=${this.config.rpcXmlPort}`);
      }
    }
    if (binIfaces.length > 0 && !this.callbackServers.has('binrpc')) {
      const server = this.createRpcCallbackServer('binrpc', binrpc, this.config.rpcServerHost, this.config.rpcBinPort);
      if (server) {
        this.callbackServers.set('binrpc', server);
      } else {
        this.log.warn(`RPC callback server not created protocol=binrpc host=${this.config.rpcServerHost} port=${this.config.rpcBinPort}`);
      }
    }

    await Promise.all(
      [...this.clients.keys()].map(async (iface) => {
        const definition = this.getRpcDefinitions()[iface];
        const callbackUrl = this.getCallbackUrl(definition.protocol);
        const initId = this.getInterfaceInitId(iface);
        this.initIdToInterface.set(initId, iface);
        this.log.info(`RPC init -> iface=${iface} callbackUrl=${callbackUrl} initId=${initId}`);
        try {
          await this.callRpc(iface, 'init', [callbackUrl, initId]);
          this.log.info(`RPC init done <- iface=${iface}`);
          this.lastRpcEventTime.set(iface, Date.now());
          if (definition.pingPong) {
            this.startPingWatchdog(iface);
          }
        } catch (error) {
          this.log.warn(`RPC init failed <- iface=${iface} error=${String(error)}`);
        }
      }),
    );
  }

  /**
   * Start the ping/pong watchdog for a given interface.
   * Schedules recurring checks at pingTimeout/4 intervals.
   *
   * @param {RpcInterfaceName} iface Interface name.
   */
  private startPingWatchdog(iface: RpcInterfaceName): void {
    this.stopPingWatchdog(iface);
    const pingTimeout = this.getPingTimeoutMs();
    this.log.debug(`Ping watchdog start -> iface=${iface} timeoutMs=${pingTimeout}`);
    const schedule = (): void => {
      this.pingTimers.set(
        iface,
        setTimeout(
          () => {
            void this.rpcCheckIface(iface, schedule);
          },
          Math.floor(pingTimeout / 4),
        ),
      );
    };
    schedule();
  }

  /**
   * Stop the ping/pong watchdog for a given interface.
   *
   * @param {RpcInterfaceName} iface Interface name.
   */
  private stopPingWatchdog(iface: RpcInterfaceName): void {
    const timer = this.pingTimers.get(iface);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pingTimers.delete(iface);
    }
  }

  /**
   * Perform one watchdog tick: send a ping if half the timeout has elapsed, or
   * re-subscribe if the full timeout has elapsed without any events.
   *
   * @param {RpcInterfaceName} iface Interface name.
   * @param {() => void} reschedule Callback to reschedule the next check.
   */
  private async rpcCheckIface(iface: RpcInterfaceName, reschedule: () => void): Promise<void> {
    const pingTimeout = this.getPingTimeoutMs();
    const last = this.lastRpcEventTime.get(iface) ?? Date.now();
    const elapsed = Date.now() - last;
    this.log.debug(`Ping watchdog check -> iface=${iface} elapsedMs=${elapsed} pingTimeoutMs=${pingTimeout}`);

    if (elapsed >= pingTimeout) {
      // Full timeout exceeded — re-subscribe.
      this.log.warn(`Ping timeout -> iface=${iface} elapsedMs=${elapsed} — re-initialising RPC subscription`);
      this.stopPingWatchdog(iface);
      const definition = this.getRpcDefinitions()[iface];
      const callbackUrl = this.getCallbackUrl(definition.protocol);
      const initId = this.getInterfaceInitId(iface);
      try {
        await this.callRpc(iface, 'init', [callbackUrl, initId]);
        this.log.info(`Ping re-init done <- iface=${iface}`);
        this.lastRpcEventTime.set(iface, Date.now());
      } catch (error) {
        this.log.warn(`Ping re-init failed <- iface=${iface} error=${String(error)}`);
      }
      this.startPingWatchdog(iface);
      return;
    }

    if (elapsed >= pingTimeout / 2) {
      // Half the timeout elapsed — send a ping to keep the subscription alive.
      this.log.debug(`Ping send -> iface=${iface}`);
      this.callRpc(iface, 'ping', ['mb']).catch((err: unknown) => {
        this.log.warn(`Ping failed <- iface=${iface} error=${String(err)}`);
      });
    }

    reschedule();
  }

  private getPingTimeoutMs(): number {
    const timeout = Number(this.config.rpcPingTimeout);
    if (Number.isFinite(timeout) && timeout > 0) return timeout * 1000;
    return 60_000;
  }

  private async deinitRpcCallbacksAndCloseServers(): Promise<void> {
    // Stop all watchdog timers before de-initialising.
    for (const iface of this.clients.keys()) {
      this.stopPingWatchdog(iface);
    }
    this.lastRpcEventTime.clear();

    await Promise.all(
      [...this.clients.keys()].map(async (iface) => {
        const definition = this.getRpcDefinitions()[iface];
        const callbackUrl = this.getCallbackUrl(definition.protocol);
        this.log.info(`RPC de-init -> iface=${iface} callbackUrl=${callbackUrl}`);
        try {
          await this.callRpc(iface, 'init', [callbackUrl, '']);
          this.log.info(`RPC de-init done <- iface=${iface}`);
        } catch (error) {
          this.log.warn(`RPC de-init failed <- iface=${iface} error=${String(error)}`);
        }
      }),
    );

    await Promise.all(
      [...this.callbackServers.entries()].map(
        async ([protocol, server]) =>
          new Promise<void>((resolve) => {
            try {
              server.close(() => {
                this.log.info(`RPC callback server closed protocol=${protocol}`);
                resolve();
              });
            } catch (error) {
              this.log.warn(`RPC callback server close failed protocol=${protocol} error=${String(error)}`);
              resolve();
            }
          }),
      ),
    );

    this.callbackServers.clear();
  }

  /**
   * Execute a ReGa script and return the raw response.
   *
   * @param {string} script ReGa script source.
   * @returns {Promise<{ response: string | undefined; objects: Record<string, unknown> | undefined }>} ReGa result payload.
   */
  async executeRegaScript(script: string): Promise<{ response: string | undefined; objects: Record<string, unknown> | undefined }> {
    if (!this.regaClient) {
      throw new Error('ReGa interface is not connected.');
    }

    const started = Date.now();
    const preview = script.replace(/\s+/g, ' ').slice(0, 180);
    this.log.debug(`ReGa call -> method=exec scriptPreview="${preview}"`);

    return new Promise((resolve, reject) => {
      this.regaClient?.exec(script, (error, response, objects) => {
        if (error) {
          this.log.warn(`ReGa error <- method=exec durationMs=${Date.now() - started} error=${String(error)}`);
          this.emit('regaError', error);
          reject(error);
          return;
        }
        this.log.debug(
          `ReGa result <- method=exec durationMs=${Date.now() - started} responseLength=${response?.length ?? 0} objectKeys=${objects ? Object.keys(objects).length : 0}`,
        );
        resolve({ response, objects });
      });
    });
  }

  /**
   * Fetch the current value of every datapoint known to ReGa.
   * Used to seed initial Matter attribute state on startup instead of waiting for the first RPC event.
   * Returns an empty array when ReGa is not enabled or not connected.
   *
   * The returned datapoints cover all interfaces the CCU knows about.
   * The caller is responsible for filtering to relevant channels and interfaces.
   *
   * @returns {Promise<CcuReGaDatapoint[]>} Array of current datapoint values.
   */
  async fetchInitialValues(): Promise<CcuReGaDatapoint[]> {
    if (!this.regaClient || !this.config.rega.enabled) {
      this.log.debug(`fetchInitialValues early return <- reason=${!this.regaClient ? 'regaClient not initialized' : 'rega.enabled is false'}`);
      return [];
    }

    const started = Date.now();
    this.log.debug('ReGa call -> method=getValues');

    try {
      const raw = await new Promise<Array<{ name: string; value: unknown; ts: string }>>((resolve, reject) => {
        const timeoutMs = this.getRequestTimeoutMs();
        const timer = setTimeout(() => {
          this.log.warn(`ReGa timeout <- method=getValues timeoutMs=${timeoutMs}`);
          reject(new Error(`ReGa getValues timed out after ${timeoutMs} ms`));
        }, timeoutMs);

        this.regaClient?.getValues((error, result) => {
          clearTimeout(timer);
          if (error) {
            this.log.warn(`ReGa error <- method=getValues error=${String(error)}`);
            reject(error);
            return;
          }
          resolve(Array.isArray(result) ? result : []);
        });
      });

      const datapoints: CcuReGaDatapoint[] = [];

      for (const dp of raw) {
        if (typeof dp.name !== 'string') continue;

        // Name format: "BidCos-RF.OEQ0854602:1.LEVEL"
        // Channel address may contain ":" so split at first and last "." only.
        const firstDot = dp.name.indexOf('.');
        const lastDot = dp.name.lastIndexOf('.');
        if (firstDot < 0 || lastDot <= firstDot) continue;

        const iface = dp.name.slice(0, firstDot);
        const channel = dp.name.slice(firstDot + 1, lastDot);
        const datapoint = dp.name.slice(lastDot + 1);

        if (!channel.includes(':') || datapoint.length === 0) continue;

        const uncertain = dp.ts === '1970-01-01 01:00:00';
        datapoints.push({ iface, channel, datapoint, value: dp.value, uncertain });
      }

      this.log.debug(`ReGa result <- method=getValues durationMs=${Date.now() - started} total=${raw.length} parsed=${datapoints.length}`);
      return datapoints;
    } catch (err) {
      this.log.warn(`fetchInitialValues failed: ${String(err)}`);
      return [];
    }
  }

  private async discoverNetwork(): Promise<void> {
    this.log.debug('Network discovery -> hm-discover start');
    await new Promise<void>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.log.debug('Network discovery <- hm-discover timeout after 1000ms');
          resolve();
        }
      }, 1000);

      hmDiscover((devices) => {
        if (resolved) return;

        for (const device of devices) {
          if (typeof device.address === 'string' && device.address.length > 0) {
            this.discoveredHosts.add(device.address);
          }
        }

        resolved = true;
        clearTimeout(timeout);
        this.log.debug(`Network discovery <- hm-discover found=${devices.length}`);
        resolve();
      });
    });
  }

  private initRegaClient(): void {
    if (!this.config.rega.enabled && !this.config.rega.syncChannelNames) return;

    this.log.debug(`ReGa client init -> host=${this.config.host} port=${this.config.tls ? 48181 : 8181} tls=${this.config.tls} auth=${this.config.authentication}`);

    this.regaClient = new RegaConstructor({
      host: this.config.host,
      port: this.config.tls ? 48181 : 8181,
      tls: this.config.tls,
      inSecure: this.config.inSecure,
      auth: this.config.authentication,
      user: this.config.username,
      pass: this.config.password,
    });

    if (this.config.rega.enabled) this.connectedInterfaces.add('ReGaHSS');
  }

  private initRpcClients(): void {
    const definitions = this.getRpcDefinitions();

    for (const [iface, definition] of Object.entries(definitions) as [RpcInterfaceName, RpcInterfaceDefinition][]) {
      if (!definition.enabled) continue;

      const options: Record<string, unknown> = {
        rejectUnauthorized: !this.config.inSecure,
      };

      if (definition.path) {
        const protocol = this.config.tls ? 'https' : 'http';
        options.url = `${protocol}://${this.config.host}:${definition.port}/${definition.path}`;
      } else {
        options.host = this.config.host;
        options.port = definition.port;
      }

      if (this.config.authentication) {
        options.basic_auth = {
          user: this.config.username,
          pass: this.config.password,
        };
      }

      const useSecureFactory = this.config.tls && typeof definition.module.createSecureClient === 'function';
      this.log.debug(
        `RPC client init -> iface=${iface} secure=${useSecureFactory} host=${String(options.host ?? this.config.host)} port=${String(options.port ?? '')} url=${String(options.url ?? '')}`,
      );
      const client = useSecureFactory ? definition.module.createSecureClient?.(options) : definition.module.createClient(options);

      if (client) {
        this.clients.set(iface, client);
        this.connectedInterfaces.add(iface);
        this.log.debug(`RPC client ready <- iface=${iface}`);
      }
    }
  }

  private getEnabledInterfaces(): CcuInterfaceName[] {
    const enabled: CcuInterfaceName[] = [];

    if (this.config.rega.enabled) enabled.push('ReGaHSS');
    if (this.config.bcrfEnabled) enabled.push('BidCos-RF');
    if (this.config.bcwiEnabled) enabled.push('BidCos-Wired');
    if (this.config.iprfEnabled) enabled.push('HmIP-RF');
    if (this.config.virtEnabled) enabled.push('VirtualDevices');
    if (this.config.cuxdEnabled) enabled.push('CUxD');

    return enabled;
  }

  /**
   * Load cache from disk.
   *
   * @returns {Promise<void>} Promise that resolves when cache is loaded.
   */
  private async loadCache(): Promise<void> {
    try {
      const content = await fs.readFile(this.cacheFilePath, 'utf-8');
      const parsed = JSON.parse(content) as CcuDiscoveryCache;

      if (parsed.channels && Array.isArray(parsed.channels) && typeof parsed.nameMap === 'object') {
        this.cache = parsed;
        this.log.debug(`Discovery cache loaded: ${parsed.channels.length} channels, timestamp ${new Date(parsed.timestamp).toISOString()}`);
      }
    } catch {
      // Cache file does not exist or is invalid; start with empty cache
      this.log.debug('Discovery cache not found or invalid; starting with empty cache');
    }
  }

  /**
   * Save cache to disk.
   *
   * @returns {Promise<void>} Promise that resolves when cache is saved.
   */
  private async saveCache(): Promise<void> {
    try {
      const content = JSON.stringify(this.cache, null, 2);
      await fs.writeFile(this.cacheFilePath, content, 'utf-8');
    } catch (err) {
      this.log.warn(`Failed to save discovery cache: ${String(err)}`);
    }
  }

  private getRpcDefinitions(): Record<RpcInterfaceName, RpcInterfaceDefinition> {
    return {
      'BidCos-RF': {
        enabled: this.config.bcrfEnabled,
        module: xmlrpc,
        protocol: 'xmlrpc',
        port: this.config.tls ? 42001 : 2001,
        pingPong: true,
      },
      'BidCos-Wired': {
        enabled: this.config.bcwiEnabled,
        module: xmlrpc,
        protocol: 'xmlrpc',
        port: this.config.tls ? 42000 : 2000,
        pingPong: true,
      },
      'HmIP-RF': {
        enabled: this.config.iprfEnabled,
        module: xmlrpc,
        protocol: 'xmlrpc',
        port: this.config.tls ? 42010 : 2010,
        pingPong: true,
      },
      'VirtualDevices': {
        enabled: this.config.virtEnabled,
        module: xmlrpc,
        protocol: 'xmlrpc',
        port: this.config.tls ? 49292 : 9292,
        path: 'groups',
        pingPong: false, // VirtualDevices does not support the ping/pong mechanism.
      },
      'CUxD': {
        enabled: this.config.cuxdEnabled,
        module: binrpc,
        protocol: 'binrpc',
        port: 8701,
        pingPong: true,
      },
    };
  }
}
