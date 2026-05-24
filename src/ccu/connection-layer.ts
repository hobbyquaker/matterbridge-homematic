/**
 * CCU connection layer based on node-red-contrib-ccu communication patterns.
 *
 * @file connection-layer.ts
 */

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { CcuChannelInfo, CcuConnectionConfig, CcuDiscoveredDevice, CcuInterfaceName, CcuLogger, CcuStatusSnapshot, RegaClient, RpcClient, RpcClientFactory } from './types.js';

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
  port: number;
  path?: string;
}

/**
 * High-level CCU connection layer for the platform lifecycle.
 */
export class CcuConnectionLayer extends EventEmitter {
  private readonly clients = new Map<RpcInterfaceName, RpcClient>();

  private readonly connectedInterfaces = new Set<CcuInterfaceName>();

  private readonly discoveredHosts = new Set<string>();

  private regaClient?: RegaClient;

  private started = false;

  /**
   * Create a CCU connection layer.
   *
   * @param {CcuConnectionConfig} config Parsed CCU connection config.
   * @param {CcuLogger} log Logger from the platform.
   */
  constructor(
    private readonly config: CcuConnectionConfig,
    private readonly log: CcuLogger,
  ) {
    super();
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

    await this.discoverNetwork();

    this.initRegaClient();
    this.initRpcClients();

    this.started = true;
    this.log.info(`CCU connection layer started for ${this.config.host}.`);
    this.emit('started', this.getStatusSnapshot());
  }

  /**
   * Stop and clear all connections.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    this.clients.clear();
    this.connectedInterfaces.clear();
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
   * @returns {Promise<unknown>} Method response.
   */
  async callRpc(iface: RpcInterfaceName, method: string, parameters: unknown[] = []): Promise<unknown> {
    const client = this.clients.get(iface);
    if (!client) {
      throw new Error(`RPC interface ${iface} is not connected.`);
    }

    return new Promise((resolve, reject) => {
      client.methodCall(method, parameters, (error, result) => {
        if (error) {
          this.emit('rpcError', iface, error);
          reject(error);
          return;
        }
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
    const nameMap = new Map<string, string>();

    if (this.regaClient && this.config.regaEnabled) {
      try {
        const script = `string id;foreach(id,dom.GetObject(ID_CHANNELS)){var c=dom.GetObject(id);Write(c.Address()#"\t"#c.Name()#"\n");}`;
        const { response } = await this.executeRegaScript(script);

        if (response) {
          for (const line of response.split('\n')) {
            const tabIndex = line.indexOf('\t');
            if (tabIndex > 0) {
              const address = line.slice(0, tabIndex).trim();
              const name = line.slice(tabIndex + 1).trim();
              if (address) nameMap.set(address, name);
            }
          }
        }
      } catch (err) {
        this.log.warn(`ReGa channel name fetch failed: ${String(err)}`);
      }
    }

    const channels: CcuChannelInfo[] = [];

    for (const [iface] of this.clients) {
      try {
        const devices = (await this.callRpc(iface, 'listDevices', [])) as RpcDeviceDescription[];

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
            interfaceName: iface,
            name: nameMap.get(dev.ADDRESS),
          });
        }
      } catch (err) {
        this.log.warn(`RPC listDevices failed on ${iface}: ${String(err)}`);
      }
    }

    this.log.debug(`discoverChannels: found ${channels.length} channels across ${this.clients.size} interface(s).`);
    return channels;
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

    return new Promise((resolve, reject) => {
      this.regaClient?.exec(script, (error, response, objects) => {
        if (error) {
          this.emit('regaError', error);
          reject(error);
          return;
        }
        resolve({ response, objects });
      });
    });
  }

  private async discoverNetwork(): Promise<void> {
    await new Promise<void>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
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
        resolve();
      });
    });
  }

  private initRegaClient(): void {
    if (!this.config.regaEnabled) return;

    this.regaClient = new RegaConstructor({
      host: this.config.host,
      port: this.config.tls ? 48181 : 8181,
      tls: this.config.tls,
      inSecure: this.config.inSecure,
      auth: this.config.authentication,
      user: this.config.username,
      pass: this.config.password,
    });

    this.connectedInterfaces.add('ReGaHSS');
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
      const client = useSecureFactory ? definition.module.createSecureClient?.(options) : definition.module.createClient(options);

      if (client) {
        this.clients.set(iface, client);
        this.connectedInterfaces.add(iface);
      }
    }
  }

  private getEnabledInterfaces(): CcuInterfaceName[] {
    const enabled: CcuInterfaceName[] = [];

    if (this.config.regaEnabled) enabled.push('ReGaHSS');
    if (this.config.bcrfEnabled) enabled.push('BidCos-RF');
    if (this.config.bcwiEnabled) enabled.push('BidCos-Wired');
    if (this.config.iprfEnabled) enabled.push('HmIP-RF');
    if (this.config.virtEnabled) enabled.push('VirtualDevices');
    if (this.config.cuxdEnabled) enabled.push('CUxD');

    return enabled;
  }

  private getRpcDefinitions(): Record<RpcInterfaceName, RpcInterfaceDefinition> {
    return {
      'BidCos-RF': {
        enabled: this.config.bcrfEnabled,
        module: xmlrpc,
        port: this.config.tls ? 42001 : 2001,
      },
      'BidCos-Wired': {
        enabled: this.config.bcwiEnabled,
        module: xmlrpc,
        port: this.config.tls ? 42000 : 2000,
      },
      'HmIP-RF': {
        enabled: this.config.iprfEnabled,
        module: xmlrpc,
        port: this.config.tls ? 42010 : 2010,
      },
      'VirtualDevices': {
        enabled: this.config.virtEnabled,
        module: xmlrpc,
        port: this.config.tls ? 49292 : 9292,
        path: 'groups',
      },
      'CUxD': {
        enabled: this.config.cuxdEnabled,
        module: binrpc,
        port: 8701,
      },
    };
  }
}
