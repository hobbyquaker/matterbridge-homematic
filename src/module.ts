/**
 * This file contains the plugin template.
 *
 * @file module.ts
 * @author Luca Liguori
 * @created 2025-06-15
 * @version 1.3.0
 * @license Apache-2.0
 *
 * Copyright 2025, 2026, 2027 Luca Liguori.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { promises as fs } from 'node:fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { parseCcuConnectionConfig } from './ccu/config.js';
import { CcuConnectionLayer } from './ccu/connection-layer.js';
import { createEndpointForChannel, isSupportedChannelType } from './ccu/device-mapper.js';
import { CcuChannelInfo, CcuChannelOverride, SwitchMatterType } from './ccu/types.js';

/**
 * This is the standard interface for Matterbridge plugins.
 * Each plugin should export a default function that follows this signature.
 *
 * @param {PlatformMatterbridge} matterbridge - An instance of MatterBridge.
 * @param {AnsiLogger} log - An instance of AnsiLogger. This is used for logging messages in a format that can be displayed with ANSI color codes and in the frontend.
 * @param {PlatformConfig} config - The platform configuration.
 * @returns {TemplatePlatform} - An instance of the MatterbridgeAccessory or MatterbridgeDynamicPlatform class. This is the main interface for interacting with the Matterbridge system.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): TemplatePlatform {
  return new TemplatePlatform(matterbridge, log, config);
}

interface HomematicPlatformConfig extends PlatformConfig {
  channelOverrides?: CcuChannelOverride[];
  deviceEditorEnabled?: boolean;
  deviceEditorPort?: number;
  deviceEditorExternalUrl?: string;
}

interface ChannelEditorPayload {
  channelAddress: string;
  enabled: boolean;
  switchMatterType?: SwitchMatterType;
}

// Here we define the TemplatePlatform class, which extends the MatterbridgeDynamicPlatform.
// If you want to create an Accessory platform plugin, you should extend the MatterbridgeAccessoryPlatform class instead.
export class TemplatePlatform extends MatterbridgeDynamicPlatform {
  private ccuConnection?: CcuConnectionLayer;

  private editorServer?: Server;

  private editorPort = 0;

  private externalHost = '';

  private discoveredChannels: CcuChannelInfo[] = [];

  private deviceAddressToDevice = new Map<string, MatterbridgeEndpoint>();

  private readonly deviceBatteryHints = new Map<string, boolean>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    // Always call super(matterbridge, log, config)
    super(matterbridge, log, config);

    // Verify that Matterbridge is the correct version
    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info(`Initializing Platform...`);
    // You can initialize your platform here, like setting up initial state or loading configurations.
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    // Wait for the platform to fully load the select if you use them.
    await this.ready;

    // Clean the selectDevice and selectEntity maps, if you want to reset the select. This is useful when you have an API that sends all the devices and you want to rediscover all of them.
    await this.clearSelect();

    const ccuConfig = parseCcuConnectionConfig(this.config);
    const cacheDir = path.join(os.homedir(), '.matterbridge');
    this.ccuConnection = new CcuConnectionLayer(ccuConfig, this.log, cacheDir);
    await this.ccuConnection.start();

    // Listen for channel updates and refresh device names when ReGa names arrive
    this.ccuConnection.on('channelsUpdated', (updatedChannels: CcuChannelInfo[]) => {
      this.log.debug(`Channels updated event received with ${updatedChannels.length} channels`);
      this.refreshDeviceNames(updatedChannels);
    });

    // Listen for RPC events to track device availability via UNREACH datapoint
    this.ccuConnection.on('rpcEvent', (event: { iface?: string; idInit?: string; channel?: number; datapoint?: string; value?: unknown }) => {
      void this.handleRpcEventAvailability(event);
    });

    this.ccuConnection.on('deviceBatteryHint', (hint: { deviceAddress?: string; batteryPowered?: boolean }) => {
      if (typeof hint.deviceAddress !== 'string' || typeof hint.batteryPowered !== 'boolean') return;
      this.deviceBatteryHints.set(hint.deviceAddress, hint.batteryPowered);
      this.log.debug(`Device battery hint updated: ${hint.deviceAddress} batteryPowered=${hint.batteryPowered}`);
    });

    await this.startChannelEditorServer();

    const status = this.ccuConnection.getStatusSnapshot();
    this.log.info(`CCU status host=${status.host || 'not-configured'} connected=${status.connected} interfaces=${status.connectedInterfaces.join(',') || 'none'}`);

    // Implements your own logic there
    await this.discoverDevices();
  }

  override async onConfigure(): Promise<void> {
    // Always call super.onConfigure()
    await super.onConfigure();

    this.log.info('onConfigure called');

    // Configure all your devices. The persisted attributes need to be updated.
    for (const device of this.getDevices()) {
      this.log.info(`Configuring device ${device.deviceName} with id ${device.originalId}`);
      // You can update the device configuration here, for example:
      // device.updateConfiguration({ key: 'value' });
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
    // Change here the logger level of the api you use or of your devices
  }

  override async onShutdown(reason?: string): Promise<void> {
    // Always call super.onShutdown(reason)
    await super.onShutdown(reason);

    if (this.editorServer) {
      await new Promise<void>((resolve) => this.editorServer?.close(() => resolve()));
      this.editorServer = undefined;
      this.log.info('Channel editor server stopped');
    }

    if (this.ccuConnection) {
      await this.ccuConnection.stop();
      this.ccuConnection = undefined;
    }

    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Return the initialized CCU connection layer for device mappers.
   *
   * @returns {CcuConnectionLayer | undefined} CCU connection layer instance.
   */
  getCcuConnectionLayer(): CcuConnectionLayer | undefined {
    return this.ccuConnection;
  }

  private async discoverDevices(): Promise<void> {
    this.log.info('Discovering devices...');

    if (!this.ccuConnection) {
      this.log.warn('CCU connection not available. No devices will be discovered.');
      return;
    }

    const channels = await this.ccuConnection.discoverChannels();
    this.discoveredChannels = channels;
    const channelsWithNames = channels.filter((c) => c.name).length;
    this.log.info(`Discovered ${channels.length} channels from CCU (${channelsWithNames} have ReGa names).`);

    for (const channel of channels) {
      if (!isSupportedChannelType(channel.type)) continue;

      const displayName = this.getChannelDisplayName(channel);
      const override = this.getChannelOverride(channel.address);
      this.setSelectDevice(channel.address, displayName, undefined, 'switch');

      if (!this.isChannelEnabled(channel, displayName, override)) {
        this.log.debug(`Skipping disabled channel ${channel.address}`);
        continue;
      }

      const endpoint = createEndpointForChannel(channel as Parameters<typeof createEndpointForChannel>[0], this.matterbridge.aggregatorVendorId, {
        switchMatterType: override?.switchMatterType,
        batteryPowered: this.deviceBatteryHints.get(channel.deviceAddress) ?? channel.batteryPowered,
      });

      endpoint.configUrl = this.buildChannelConfigUrl(channel.address);
      await this.registerDevice(endpoint);

      // Track device for availability monitoring
      this.deviceAddressToDevice.set(channel.deviceAddress, endpoint);
    }
  }

  private async handleRpcEventAvailability(event: { iface?: string; idInit?: string; channel?: number; datapoint?: string; value?: unknown }): Promise<void> {
    // We only care about UNREACH on channel 0 (device level)
    if (event.channel !== 0 || event.datapoint !== 'UNREACH') return;

    const unreachValue = event.value === true;
    this.log.debug(`UNREACH event: iface=${String(event.iface ?? 'unknown')} unreachable=${unreachValue}`);

    // Update all devices on the affected interface
    for (const [deviceAddress, device] of this.deviceAddressToDevice) {
      try {
        // The reachable attribute is the inverse of UNREACH
        const reachable = !unreachValue;
        const currentReachable = await device.getAttribute('BridgedDeviceBasicInformation', 'reachable');

        if (currentReachable !== reachable) {
          this.log.info(`Device reachability changed: ${deviceAddress} reachable=${reachable}`);
          await device.updateAttribute('BridgedDeviceBasicInformation', 'reachable', reachable);
        }
      } catch (err) {
        this.log.debug(`Failed to update reachability for ${deviceAddress}: ${String(err)}`);
      }
    }
  }

  private refreshDeviceNames(updatedChannels: CcuChannelInfo[]): void {
    const channelMap = new Map<string, CcuChannelInfo>(updatedChannels.map((c) => [c.address, c]));

    for (const device of this.getDevices()) {
      const channelAddress = device.originalId;
      if (typeof channelAddress !== 'string') continue;

      const updatedChannel = channelMap.get(channelAddress);

      if (!updatedChannel) continue;

      const newName = this.getChannelDisplayName(updatedChannel);
      const oldName = device.deviceName;

      if (newName && newName !== oldName && newName !== channelAddress) {
        this.log.info(`Updating device name for ${channelAddress}: "${oldName}" -> "${newName}"`);
        device.deviceName = newName;
        this.setSelectDevice(channelAddress, newName, undefined, 'switch');
      }
    }
  }

  private getPlatformConfig(): HomematicPlatformConfig {
    return this.config as HomematicPlatformConfig;
  }

  private getChannelOverrides(): CcuChannelOverride[] {
    const overrides = this.getPlatformConfig().channelOverrides;
    return Array.isArray(overrides) ? overrides : [];
  }

  private getChannelOverride(channelAddress: string): CcuChannelOverride | undefined {
    return this.getChannelOverrides().find((item) => item.address === channelAddress);
  }

  private isChannelEnabled(channel: CcuChannelInfo, displayName: string, override?: CcuChannelOverride): boolean {
    if (override && typeof override.enabled === 'boolean') {
      return override.enabled;
    }
    // New default: channels are opt-in and stay disabled until explicitly enabled.
    return false;
  }

  private getChannelDisplayName(channel: CcuChannelInfo): string {
    const regaName = channel.name?.trim();
    this.log.debug(`getChannelDisplayName <- address=${channel.address} regaName=${regaName ? `"${regaName}"` : 'empty'} fallbacks=${channel.address}`);
    if (regaName && regaName.length > 0) return regaName;
    return channel.address;
  }

  private buildChannelConfigUrl(channelAddress: string): string {
    const pluginName = encodeURIComponent(String(this.config.name ?? 'matterbridge-homematic'));
    const encodedAddress = encodeURIComponent(channelAddress);
    const query = `?plugin=${pluginName}&channel=${encodedAddress}`;
    const configuredUrl = String(this.getPlatformConfig().deviceEditorExternalUrl ?? '').trim();

    if (configuredUrl) {
      const baseUrl = configuredUrl.replace('{port}', String(this.editorPort));
      return `${baseUrl}/homematic-config${query}`;
    }
    if (this.externalHost && this.editorPort > 0) {
      return `${this.externalHost}:${this.editorPort}/homematic-config${query}`;
    }
    return `/homematic-config${query}`;
  }

  private async startChannelEditorServer(): Promise<void> {
    if (this.editorServer) {
      return;
    }

    const enabled = this.getPlatformConfig().deviceEditorEnabled !== false;
    if (!enabled) {
      this.log.info('Channel editor server disabled by config');
      return;
    }

    const configuredPort = Number(this.getPlatformConfig().deviceEditorPort ?? 0);
    const listenPort = Number.isFinite(configuredPort) && configuredPort >= 0 ? configuredPort : 0;

    this.editorServer = createServer((req, res) => {
      void this.handleChannelEditorRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.editorServer?.once('error', reject);
      this.editorServer?.listen(listenPort, '0.0.0.0', () => resolve());
    });

    const address = this.editorServer.address();
    if (address && typeof address === 'object') {
      this.editorPort = address.port;
      this.log.info(`Channel editor server listening on 0.0.0.0:${this.editorPort}`);
    }
  }

  private async handleChannelEditorRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.externalHost && req.headers.host) {
      const proto = req.headers['x-forwarded-proto'] ?? 'http';
      const host = req.headers['x-forwarded-host'] ?? req.headers.host;
      this.externalHost = `${proto}://${host}`;
    }

    if (!req.url) {
      this.sendTextResponse(res, 400, 'Bad Request');
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/homematic-config') {
      const channelAddress = String(url.searchParams.get('channel') ?? '');
      const html = this.renderChannelEditorHtml(channelAddress);
      if (!html) {
        this.sendTextResponse(res, 404, `Unknown channel: ${channelAddress}`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/homematic-config') {
      const payload: ChannelEditorPayload = {
        channelAddress: String(url.searchParams.get('channelAddress') ?? ''),
        enabled: String(url.searchParams.get('enabled') ?? '').toLowerCase() === 'true',
        switchMatterType: this.toSwitchMatterType(url.searchParams.get('switchMatterType')),
      };

      const ok = await this.saveChannelEditorPayload(payload);
      if (!ok) {
        this.sendJsonResponse(res, 404, { ok: false, error: `Unknown channel: ${payload.channelAddress}` });
        return;
      }

      this.sendJsonResponse(res, 200, { ok: true });
      return;
    }

    this.sendTextResponse(res, 404, 'Not Found');
  }

  private renderChannelEditorHtml(channelAddress: string): string | null {
    const channel = this.discoveredChannels.find((item) => item.address === channelAddress);
    if (!channel) return null;

    const override = this.getChannelOverride(channel.address);
    const displayName = this.getChannelDisplayName(channel);
    const switchMatterType = override?.switchMatterType ?? 'light';
    const enabled = override?.enabled ?? false;
    const showSwitchTypeSelect = channel.type === 'SWITCH';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Homematic Channel Config</title>
  <style>
    body { font-family: Segoe UI, sans-serif; margin: 0; background: #f5f7fb; color: #1a2233; }
    .wrap { max-width: 720px; margin: 24px auto; background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); }
    h1 { margin: 0 0 6px 0; font-size: 24px; }
    p { margin: 0 0 16px 0; color: #4a5a78; }
    .field { margin-bottom: 12px; display: flex; flex-direction: column; gap: 6px; }
    label { font-size: 13px; color: #4a5a78; }
    select { border: 1px solid #cfd6e4; border-radius: 8px; padding: 8px 10px; font-size: 14px; }
    .row { display: flex; align-items: center; gap: 8px; }
    button { border: 0; border-radius: 8px; background: #1f6feb; color: #fff; padding: 10px 14px; font-weight: 600; cursor: pointer; }
    .status { font-size: 13px; color: #4a5a78; margin-left: 10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${this.escapeHtml(displayName)}</h1>
    <p>Channel ${this.escapeHtml(channel.address)} (${this.escapeHtml(channel.type)})</p>

    <div class="field">
      <label class="row"><input id="enabled" type="checkbox" ${enabled ? 'checked' : ''} /> Enabled</label>
    </div>

    ${
      showSwitchTypeSelect
        ? `<div class="field">
      <label for="switchMatterType">Matter type for SWITCH channel</label>
      <select id="switchMatterType">
        <option value="light" ${switchMatterType === 'light' ? 'selected' : ''}>Light</option>
        <option value="outlet" ${switchMatterType === 'outlet' ? 'selected' : ''}>Outlet</option>
        <option value="switch" ${switchMatterType === 'switch' ? 'selected' : ''}>Switch / Relay</option>
      </select>
    </div>`
        : ''
    }

    <button id="saveBtn" type="button">Save</button>
    <span class="status" id="status">Ready</span>
  </div>

  <script>
    const channelAddress = ${JSON.stringify(channel.address)};
    const saveBtn = document.getElementById('saveBtn');
    const status = document.getElementById('status');

    saveBtn.addEventListener('click', async () => {
      status.textContent = 'Saving...';
      const params = new URLSearchParams();
      params.set('channelAddress', channelAddress);
      params.set('enabled', document.getElementById('enabled').checked ? 'true' : 'false');
      const switchSelect = document.getElementById('switchMatterType');
      if (switchSelect) params.set('switchMatterType', switchSelect.value);

      try {
        const resp = await fetch('/api/homematic-config?' + params.toString(), { method: 'GET' });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          status.textContent = 'Save failed: ' + (data.error || 'unknown error');
          return;
        }
        status.textContent = 'Saved. Restart plugin to apply changes.';
      } catch (error) {
        status.textContent = 'Save failed: ' + error;
      }
    });
  </script>
</body>
</html>`;
  }

  private async saveChannelEditorPayload(payload: ChannelEditorPayload): Promise<boolean> {
    const channel = this.discoveredChannels.find((item) => item.address === payload.channelAddress);
    if (!channel) return false;

    const config = this.getPlatformConfig();
    const overrides = this.getChannelOverrides();
    const existing = overrides.find((item) => item.address === payload.channelAddress);
    if (existing) {
      existing.enabled = payload.enabled;
      if (channel.type === 'SWITCH') {
        existing.switchMatterType = payload.switchMatterType ?? 'light';
      } else {
        delete existing.switchMatterType;
      }
    } else {
      const newOverride: CcuChannelOverride = {
        address: payload.channelAddress,
        enabled: payload.enabled,
      };
      if (channel.type === 'SWITCH') newOverride.switchMatterType = payload.switchMatterType ?? 'light';
      overrides.push(newOverride);
    }
    config.channelOverrides = overrides;

    await this.persistCurrentConfig(config);
    return true;
  }

  private async persistCurrentConfig(config: HomematicPlatformConfig): Promise<void> {
    const configPath = this.getConfigFilePath();
    const existingText = await fs.readFile(configPath, 'utf8');
    const existingConfig = JSON.parse(existingText) as Record<string, unknown>;
    existingConfig.channelOverrides = config.channelOverrides ?? [];
    await fs.writeFile(configPath, `${JSON.stringify(existingConfig, null, 2)}\n`, 'utf8');
    this.log.info(`Saved channel override config to ${configPath}`);
  }

  private getConfigFilePath(): string {
    const pluginName = String(this.config.name ?? 'matterbridge-homematic');
    return path.join(os.homedir(), '.matterbridge', `${pluginName}.config.json`);
  }

  private toSwitchMatterType(value: string | null): SwitchMatterType | undefined {
    if (value === 'light' || value === 'outlet' || value === 'switch') return value;
    return undefined;
  }

  private escapeHtml(input: string): string {
    return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  private sendTextResponse(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  }

  private sendJsonResponse(res: ServerResponse, status: number, data: Record<string, unknown>): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
}
