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
import { createEndpointForChannel, isSupportedChannelType, resolveChannelsForMatter } from './ccu/device-mapper.js';
import { getMatchingMainsPoweredPrefix, isAlwaysMainsPoweredDeviceType, MAINS_POWERED_DEVICE_TYPE_PREFIXES } from './ccu/device-power.js';
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

  /** Maps full channel address (e.g. 'DEVICE:3') to its Matter endpoint for SWITCH/DIMMER channels. */
  private channelAddressToDevice = new Map<string, MatterbridgeEndpoint>();

  private readonly deviceBatteryHints = new Map<string, boolean>();

  private readonly deviceBatteryLowState = new Map<string, boolean>();

  private readonly mainsPoweredDevices = new Set<string>();

  private batteryRediscoveryTimer?: NodeJS.Timeout;

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
    this.log.debug(`Mains-powered type prefixes: ${MAINS_POWERED_DEVICE_TYPE_PREFIXES.join(', ')}`);

    // Wait for the platform to fully load the select if you use them.
    await this.ready;

    const ccuConfig = parseCcuConnectionConfig(this.config);
    const cacheDir = path.join(os.homedir(), '.matterbridge');
    this.ccuConnection = new CcuConnectionLayer(ccuConfig, this.log, cacheDir);
    await this.ccuConnection.start();
    await this.loadPersistedChannelOverrides();

    // Listen for channel updates and refresh device names when ReGa names arrive
    this.ccuConnection.on('channelsUpdated', (updatedChannels: CcuChannelInfo[]) => {
      this.log.debug(`Channels updated event received with ${updatedChannels.length} channels`);
      this.refreshDeviceNames(updatedChannels);
    });

    // Listen for RPC events to track device availability via UNREACH datapoint

    this.ccuConnection.on('rpcEvent', (event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }) => {
      void this.handleRpcEventAvailability(event);
      void this.handleRpcEventBattery(event);
      void this.handleRpcEventSwitchState(event);
      void this.handleRpcEventDimmerLevel(event);
    });

    this.ccuConnection.on('deviceBatteryHint', (hint: { deviceAddress?: string; batteryPowered?: boolean }) => {
      if (typeof hint.deviceAddress !== 'string' || typeof hint.batteryPowered !== 'boolean') return;
      this.deviceBatteryHints.set(hint.deviceAddress, hint.batteryPowered);
      this.log.debug(`Device battery hint updated: ${hint.deviceAddress} batteryPowered=${hint.batteryPowered}`);

      const endpoint = this.deviceAddressToDevice.get(hint.deviceAddress);
      if (hint.batteryPowered && endpoint && !endpoint.hasClusterServer('PowerSource')) {
        this.scheduleBatteryRediscovery(`battery hint for ${hint.deviceAddress}`);
      }
    });

    await this.startChannelEditorServer();

    const status = this.ccuConnection.getStatusSnapshot();
    this.log.info(`CCU status host=${status.host || 'not-configured'} connected=${status.connected} interfaces=${status.connectedInterfaces.join(',') || 'none'}`);

    // Implements your own logic there
    await this.discoverDevices();
    await this.applyStartupServiceMessages();
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

    const rawChannels = await this.ccuConnection.discoverChannels();
    this.updateMainsPoweredDeviceSet(rawChannels);
    await this.primeBatteryHintsFromRpc(rawChannels);
    const channels = resolveChannelsForMatter(rawChannels);
    this.discoveredChannels = channels;
    const channelsWithNames = channels.filter((c) => c.name).length;
    this.log.info(`Discovered ${rawChannels.length} raw channels, ${channels.length} resolved for Matter (${channelsWithNames} have ReGa names).`);

    // Reconcile exposed devices with current enabled selections.
    const existingDevices = this.getDevices();
    if (existingDevices.length > 0) {
      this.log.info(`Unregistering ${existingDevices.length} previously exposed devices before re-discovery`);
      await this.unregisterAllDevices();
    }
    this.deviceAddressToDevice.clear();
    this.channelAddressToDevice.clear();

    let enabledCount = 0;
    let registeredCount = 0;

    for (const channel of channels) {
      if (!isSupportedChannelType(channel.type)) continue;

      const displayName = this.getChannelDisplayName(channel);
      const override = this.getChannelOverride(channel.address);
      const selectSerial = this.getChannelSelectSerial(channel.address);
      const legacyDashSerial = channel.address.replace(':', '-');

      // Remove legacy select rows keyed with '-' to avoid duplicate UI entries.
      if (legacyDashSerial !== selectSerial && this.getSelectDevice(legacyDashSerial) !== undefined) {
        await this.clearDeviceSelect(legacyDashSerial);
      }

      this.setSelectDevice(selectSerial, displayName, undefined, 'switch');

      if (!this.isChannelEnabled(channel, override, displayName)) {
        this.log.debug(`Skipping disabled channel ${channel.address}`);
        continue;
      }

      enabledCount++;

      const endpoint = createEndpointForChannel(channel as Parameters<typeof createEndpointForChannel>[0], this.matterbridge.aggregatorVendorId, {
        switchMatterType: override?.switchMatterType,
        batteryPowered: this.deviceBatteryHints.get(channel.deviceAddress) ?? channel.batteryPowered,
      });

      endpoint.configUrl = this.buildChannelConfigUrl(channel.address);
      await this.registerDevice(endpoint);
      registeredCount++;

      // Track device for availability monitoring (keyed by root device address).
      this.deviceAddressToDevice.set(channel.deviceAddress, endpoint);

      // Wire OnOff attribute for SWITCH channels
      if (channel.type === 'SWITCH' && this.ccuConnection) {
        const ccuConn = this.ccuConnection;
        // Track channel address for precise inbound event matching.
        this.channelAddressToDevice.set(channel.address, endpoint);
        try {
          await endpoint.subscribeAttribute('OnOff', 'onOff', (value: boolean) => {
            const iface = channel.interfaceName;
            const address = channel.address;
            this.log.debug(`Matter OnOff -> Homematic setValue: iface=${iface} channel=${address} value=${value}`);
            ccuConn.setChannelDatapointValue(iface, address, 'STATE', value).catch((err: unknown) => {
              this.log.warn(`Failed to set Homematic STATE for ${address}: ${String(err)}`);
            });
          });
        } catch (err) {
          this.log.warn(`Failed to subscribe OnOff for ${channel.address}: ${String(err)}`);
        }
      }

      // Wire LevelControl attribute for DIMMER channels.
      // Matter currentLevel is 0-254; Homematic LEVEL is 0.0-1.0.
      if (channel.type === 'DIMMER' && this.ccuConnection) {
        const ccuConn = this.ccuConnection;
        // Track channel address for precise inbound event matching.
        this.channelAddressToDevice.set(channel.address, endpoint);
        try {
          await endpoint.subscribeAttribute('LevelControl', 'currentLevel', (value: number | null) => {
            const iface = channel.interfaceName;
            const address = channel.address;
            const level = value != null ? Math.round((value / 254) * 100) / 100 : 0;
            this.log.debug(`Matter currentLevel -> Homematic setValue: iface=${iface} channel=${address} level=${level}`);
            ccuConn.setChannelDatapointValue(iface, address, 'LEVEL', level).catch((err: unknown) => {
              this.log.warn(`Failed to set Homematic LEVEL for ${address}: ${String(err)}`);
            });
          });
        } catch (err) {
          this.log.warn(`Failed to subscribe LevelControl for ${channel.address}: ${String(err)}`);
        }
      }
    }

    this.log.info(
      `Channel registration summary: enabled=${enabledCount} registered=${registeredCount} totalSupported=${channels.filter((c) => isSupportedChannelType(c.type)).length}`,
    );
  }

  private async primeBatteryHintsFromRpc(channels: CcuChannelInfo[]): Promise<void> {
    if (!this.ccuConnection || channels.length === 0) return;

    const candidates = new Map<string, Exclude<CcuChannelInfo['interfaceName'], 'ReGaHSS'>>();
    for (const channel of channels) {
      if (channel.channelIndex !== 0) continue;
      const classifierType = channel.deviceType ?? channel.type;
      if (isAlwaysMainsPoweredDeviceType(classifierType)) {
        const prefix = getMatchingMainsPoweredPrefix(classifierType);
        this.log.debug(
          `Battery classify startup <- device=${channel.deviceAddress} channelType=${channel.type} deviceType=${channel.deviceType ?? 'unknown'} classifierType=${classifierType} mainsPrefix=${prefix ?? 'none'} batteryHint=false (forced mains)`,
        );
        this.deviceBatteryHints.set(channel.deviceAddress, false);
        continue;
      }
      if (this.deviceBatteryHints.has(channel.deviceAddress)) continue;
      if (channel.interfaceName !== 'BidCos-RF' && channel.interfaceName !== 'HmIP-RF') continue;
      candidates.set(channel.deviceAddress, channel.interfaceName);
    }

    if (candidates.size === 0) return;

    let detectedCount = 0;
    await Promise.all(
      [...candidates.entries()].map(async ([deviceAddress, iface]) => {
        const address = `${deviceAddress}:0`;
        const valuesDescription = await this.getParamsetDescriptionSafe(iface, address, 'VALUES');
        const masterDescription = valuesDescription ? undefined : await this.getParamsetDescriptionSafe(iface, address, 'MASTER');
        const description = valuesDescription ?? masterDescription;

        if (!description || !this.hasLowBatKey(description)) return;

        this.deviceBatteryHints.set(deviceAddress, true);
        const rootChannel = channels.find((c) => c.deviceAddress === deviceAddress && c.channelIndex === 0);
        this.log.debug(
          `Battery classify startup <- device=${deviceAddress} channelType=${rootChannel?.type ?? 'unknown'} deviceType=${rootChannel?.deviceType ?? 'unknown'} classifierType=${rootChannel?.deviceType ?? rootChannel?.type ?? 'unknown'} mainsPrefix=none batteryHint=true source=getParamsetDescription`,
        );
        detectedCount++;

        for (const channel of channels) {
          if (channel.deviceAddress === deviceAddress) {
            channel.batteryPowered = true;
          }
        }
      }),
    );

    if (detectedCount > 0) {
      this.log.info(`Detected ${detectedCount} battery-powered devices from RPC paramset descriptions`);
    }
  }

  private updateMainsPoweredDeviceSet(channels: CcuChannelInfo[]): void {
    this.mainsPoweredDevices.clear();

    for (const channel of channels) {
      if (channel.channelIndex !== 0) continue;
      const classifierType = channel.deviceType ?? channel.type;
      if (!isAlwaysMainsPoweredDeviceType(classifierType)) continue;

      const prefix = getMatchingMainsPoweredPrefix(classifierType);
      this.log.debug(
        `Mains classification <- device=${channel.deviceAddress} channelType=${channel.type} deviceType=${channel.deviceType ?? 'unknown'} classifierType=${classifierType} matchedPrefix=${prefix ?? 'none'}`,
      );
      this.mainsPoweredDevices.add(channel.deviceAddress);
      this.deviceBatteryHints.set(channel.deviceAddress, false);
    }

    this.log.debug(`Mains classification summary <- mainsDevices=${this.mainsPoweredDevices.size}`);
  }

  private async getParamsetDescriptionSafe(
    iface: 'BidCos-RF' | 'BidCos-Wired' | 'HmIP-RF' | 'VirtualDevices' | 'CUxD',
    address: string,
    paramsetKey: 'VALUES' | 'MASTER',
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.ccuConnection) return undefined;

    try {
      const response = await this.ccuConnection.callRpc(iface, 'getParamsetDescription', [address, paramsetKey]);
      return response && typeof response === 'object' ? (response as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  private hasLowBatKey(description: Record<string, unknown>): boolean {
    for (const key of Object.keys(description)) {
      const marker = key.trim().toUpperCase();
      if (marker === 'LOWBAT' || marker === 'LOW_BAT') {
        return true;
      }
    }
    return false;
  }

  private async loadPersistedChannelOverrides(): Promise<void> {
    try {
      const configPath = this.getConfigFilePath();
      const content = await fs.readFile(configPath, 'utf8');
      const persisted = JSON.parse(content) as HomematicPlatformConfig;
      const persistedOverrides = Array.isArray(persisted.channelOverrides) ? persisted.channelOverrides : [];

      if (persistedOverrides.length > 0) {
        this.getPlatformConfig().channelOverrides = persistedOverrides;
      }

      this.log.info(`Loaded persisted channel overrides: ${persistedOverrides.length}`);
    } catch (err) {
      this.log.debug(`No persisted channel overrides loaded: ${String(err)}`);
    }
  }

  private async handleRpcEventAvailability(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    if (event.datapoint !== 'UNREACH') return;

    const deviceAddress = this.extractDeviceAddressFromRpcChannel(event.channel);
    const isDeviceLevelEvent = deviceAddress !== undefined || event.channel === 0;
    if (!isDeviceLevelEvent) return;

    const unreachValue = event.value === true;
    const reachable = !unreachValue;
    this.log.debug(`UNREACH event: iface=${String(event.iface ?? 'unknown')} device=${deviceAddress ?? 'unknown'} reachable=${reachable}`);

    if (deviceAddress) {
      const device = this.deviceAddressToDevice.get(deviceAddress);
      if (!device) return;
      await this.updateDeviceReachable(deviceAddress, device, reachable);
      return;
    }

    // Backward-compatible fallback when only channel index is provided.
    for (const [address, device] of this.deviceAddressToDevice) {
      await this.updateDeviceReachable(address, device, reachable);
    }
  }

  private async handleRpcEventBattery(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'LOWBAT' && datapoint !== 'LOW_BAT') return;

    const deviceAddress = this.extractDeviceAddressFromRpcChannel(event.channel);
    if (!deviceAddress) return;
    if (this.mainsPoweredDevices.has(deviceAddress)) {
      this.log.debug(`LOWBAT event ignored for mains-powered device=${deviceAddress}`);
      return;
    }

    const batteryLow = event.value === true || event.value === 1 || event.value === '1';
    await this.setDeviceBatteryLowState(deviceAddress, batteryLow, 'RPC event');
  }

  /**
   * Handle incoming RPC event for SWITCH channel STATE and update Matter endpoint.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] Interface name (e.g. 'BidCos-RF').
   * @param {string} [event.idInit] Init ID of the interface.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name (e.g. 'STATE').
   * @param {unknown} [event.value] Datapoint value.
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventSwitchState(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'STATE') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    // Direct lookup by channel address — works for both single-gang and multi-gang HmIP devices.
    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;

    if (!endpoint.hasClusterServer('OnOff')) return;

    const newValue = event.value === true || event.value === 1 || event.value === '1';
    try {
      const current = await endpoint.getAttribute('OnOff', 'onOff');
      if (current !== newValue) {
        await endpoint.updateAttribute('OnOff', 'onOff', newValue);
        this.log.info(`SWITCH STATE event: updated Matter OnOff for ${channelAddress} to ${newValue}`);
      }
    } catch (err) {
      this.log.warn(`Failed to update Matter OnOff for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for DIMMER channel LEVEL and update Matter endpoint.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] Interface name.
   * @param {string} [event.idInit] Init ID of the interface.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name (e.g. 'LEVEL').
   * @param {unknown} [event.value] Datapoint value (0.0–1.0 float).
   * @returns {Promise<void>} Resolves when Matter attributes have been updated.
   */
  private async handleRpcEventDimmerLevel(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'LEVEL') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;

    if (!endpoint.hasClusterServer('LevelControl')) return;

    // Homematic LEVEL is 0.0–1.0; Matter currentLevel is 1–254 (0 means off).
    const hmLevel = typeof event.value === 'number' ? event.value : 0;
    const matterLevel = hmLevel > 0 ? Math.max(1, Math.round(hmLevel * 254)) : 0;
    const onOff = matterLevel > 0;

    try {
      await endpoint.updateAttribute('LevelControl', 'currentLevel', matterLevel > 0 ? matterLevel : 1);
      if (endpoint.hasClusterServer('OnOff')) {
        const currentOnOff = await endpoint.getAttribute('OnOff', 'onOff');
        if (currentOnOff !== onOff) {
          await endpoint.updateAttribute('OnOff', 'onOff', onOff);
        }
      }
      this.log.info(`DIMMER LEVEL event: updated Matter level for ${channelAddress} to ${matterLevel} (onOff=${onOff})`);
    } catch (err) {
      this.log.warn(`Failed to update Matter LevelControl for ${channelAddress}: ${String(err)}`);
    }
  }

  private async applyStartupServiceMessages(): Promise<void> {
    if (!this.ccuConnection || this.deviceAddressToDevice.size === 0) return;

    const unreachableDevices = new Set<string>();
    const lowBatteryDevices = new Set<string>();
    const rpcIfaces = ['BidCos-RF', 'HmIP-RF'] as const;
    let hasSuccess = false;
    let hasFailure = false;

    for (const iface of rpcIfaces) {
      try {
        const result = await this.ccuConnection.callRpc(iface, 'getServiceMessages', []);
        hasSuccess = true;
        this.collectServiceMessages(result, unreachableDevices, lowBatteryDevices);
        this.log.debug(`Startup getServiceMessages <- iface=${iface} unreachable=${unreachableDevices.size} lowBattery=${lowBatteryDevices.size}`);
      } catch (err) {
        hasFailure = true;
        this.log.debug(`Startup getServiceMessages failed for ${iface}: ${String(err)}`);
      }
    }

    if (!hasSuccess) return;

    for (const [deviceAddress, endpoint] of this.deviceAddressToDevice) {
      if (unreachableDevices.has(deviceAddress)) {
        await this.updateDeviceReachable(deviceAddress, endpoint, false);
      } else if (!hasFailure) {
        // Only clear UNREACH when all startup calls succeeded.
        await this.updateDeviceReachable(deviceAddress, endpoint, true);
      }

      if (lowBatteryDevices.has(deviceAddress)) {
        await this.setDeviceBatteryLowState(deviceAddress, true, 'startup service message');
      } else if (!hasFailure && endpoint.hasClusterServer('PowerSource')) {
        // Only clear LOWBAT when all startup calls succeeded.
        await this.setDeviceBatteryLowState(deviceAddress, false, 'startup service message');
      }
    }
  }

  private collectServiceMessages(payload: unknown, unreachableDevices: Set<string>, lowBatteryDevices: Set<string>): void {
    const entries = Array.isArray(payload) ? payload : [payload];

    for (const entry of entries) {
      const parsed = this.parseServiceMessageEntry(entry);
      const deviceAddress = parsed?.deviceAddress;
      if (!deviceAddress) continue;
      if (parsed.hasUnreach) unreachableDevices.add(deviceAddress);
      if (parsed.hasLowBat) lowBatteryDevices.add(deviceAddress);
    }
  }

  private parseServiceMessageEntry(entry: unknown): { deviceAddress?: string; hasUnreach: boolean; hasLowBat: boolean } | undefined {
    let addressCandidate: string | undefined;
    const datapoints = new Set<string>();

    const tryConsumeString = (value: unknown): void => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (trimmed.length === 0) return;

      const normalized = trimmed.toUpperCase();
      if (normalized === 'UNREACH' || normalized === 'LOWBAT' || normalized === 'LOW_BAT') {
        datapoints.add(normalized);
        return;
      }

      const parsedAddress = this.extractDeviceAddressFromServiceMessageValue(trimmed);
      if (parsedAddress) {
        addressCandidate = parsedAddress;
      }
    };

    if (Array.isArray(entry)) {
      for (const item of entry) {
        tryConsumeString(item);
      }
    } else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        const keyName = key.trim().toUpperCase();
        if (keyName === 'ADDRESS' || keyName === 'CHANNEL' || keyName === 'ID') {
          tryConsumeString(value);
          continue;
        }
        if (keyName === 'DATAPOINT' || keyName === 'NAME' || keyName === 'MESSAGE' || keyName === 'VALUE') {
          tryConsumeString(value);
        }
      }
    } else {
      tryConsumeString(entry);
    }

    if (!addressCandidate) return undefined;

    return {
      deviceAddress: addressCandidate,
      hasUnreach: datapoints.has('UNREACH'),
      hasLowBat: datapoints.has('LOWBAT') || datapoints.has('LOW_BAT'),
    };
  }

  private extractDeviceAddressFromServiceMessageValue(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed.length === 0 || /\s/.test(trimmed)) return undefined;

    if (trimmed.includes(':')) {
      return trimmed.split(':', 1)[0];
    }

    const looksLikeAddress = /^[A-Za-z0-9_-]{6,}$/.test(trimmed);
    return looksLikeAddress ? trimmed : undefined;
  }

  private async setDeviceBatteryLowState(deviceAddress: string, batteryLow: boolean, source: string): Promise<void> {
    if (this.mainsPoweredDevices.has(deviceAddress)) {
      this.log.debug(`Battery state update ignored for mains-powered device=${deviceAddress} source=${source}`);
      return;
    }

    const previous = this.deviceBatteryLowState.get(deviceAddress);
    if (previous === batteryLow) return;

    this.deviceBatteryLowState.set(deviceAddress, batteryLow);
    if (batteryLow) {
      this.deviceBatteryHints.set(deviceAddress, true);
    }

    const endpoint = this.deviceAddressToDevice.get(deviceAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('PowerSource')) {
      this.log.debug(`Battery state from ${source} for ${deviceAddress} without PowerSource cluster`);
      if (batteryLow) {
        this.scheduleBatteryRediscovery(`${source} for ${deviceAddress}`);
      }
      return;
    }

    // Matter PowerSource.batChargeLevel: 0=ok, 1=warning, 2=critical.
    const chargeLevel = batteryLow ? 1 : 0;

    try {
      const currentChargeLevel = await endpoint.getAttribute('PowerSource', 'batChargeLevel');
      if (currentChargeLevel !== chargeLevel) {
        await endpoint.updateAttribute('PowerSource', 'batChargeLevel', chargeLevel);
        this.log.info(`Battery state changed from ${source}: ${deviceAddress} low=${batteryLow} batChargeLevel=${chargeLevel}`);
      }
    } catch (err) {
      this.log.debug(`Failed to update battery charge level for ${deviceAddress}: ${String(err)}`);
    }
  }

  private async updateDeviceReachable(deviceAddress: string, device: MatterbridgeEndpoint, reachable: boolean): Promise<void> {
    try {
      const currentReachable = await device.getAttribute('BridgedDeviceBasicInformation', 'reachable');
      if (currentReachable !== reachable) {
        this.log.info(`Device reachability changed: ${deviceAddress} reachable=${reachable}`);
        await device.updateAttribute('BridgedDeviceBasicInformation', 'reachable', reachable);
      }
    } catch (err) {
      this.log.debug(`Failed to update reachability for ${deviceAddress}: ${String(err)}`);
    }
  }

  private extractDeviceAddressFromRpcChannel(channel: unknown): string | undefined {
    if (typeof channel !== 'string' || channel.length === 0) return undefined;
    const separatorIndex = channel.indexOf(':');
    if (separatorIndex <= 0) return undefined;
    const suffix = channel.slice(separatorIndex + 1);
    if (suffix !== '0') return undefined;
    return channel.slice(0, separatorIndex);
  }

  private scheduleBatteryRediscovery(reason: string): void {
    if (this.batteryRediscoveryTimer) return;

    this.log.info(`Scheduling device rediscovery to apply battery metadata (${reason})`);
    this.batteryRediscoveryTimer = setTimeout(() => {
      this.batteryRediscoveryTimer = undefined;
      void this.discoverDevices().catch((err) => this.log.warn(`Battery rediscovery failed: ${String(err)}`));
    }, 1000);
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
        this.setSelectDevice(this.getChannelSelectSerial(channelAddress), newName, undefined, 'switch');
      }
    }
  }

  private getChannelSelectSerial(channelAddress: string): string {
    return channelAddress;
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

  private isChannelEnabled(channel: CcuChannelInfo, override: CcuChannelOverride | undefined, displayName: string): boolean {
    if (override && typeof override.enabled === 'boolean') {
      return override.enabled;
    }
    // Fall back to Matterbridge whitelist/blacklist validation used by Home checkbox selections.
    const candidates = [this.getChannelSelectSerial(channel.address), channel.address, channel.name?.trim(), displayName].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return this.validateDevice(candidates, false);
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
