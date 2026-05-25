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
import { createEndpointForChannel, inferSwitchMatterTypeFromName, isSupportedChannelType, resolveChannelsForMatter } from './ccu/device-mapper.js';
import { getBatteryVoltageRange, getMatchingMainsPoweredPrefix, isAlwaysMainsPoweredDeviceType, MAINS_POWERED_DEVICE_TYPE_PREFIXES } from './ccu/device-power.js';
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

  /**
   * Maps ROTARY_HANDLE_SENSOR channel addresses to their Matter endpoints.
   * Kept separate from channelAddressToDevice to avoid STATE datapoint conflicts with SHUTTER_CONTACT.
   */
  private rotaryHandleChannels = new Map<string, MatterbridgeEndpoint>();

  /**
   * Tracks the last value written to a Matter attribute from an incoming RPC event.
   * Used to suppress the echo setValue that the subscribeAttribute callback would otherwise send back.
   */
  private readonly rpcEchoSuppress = new Map<string, boolean | number>();

  /** Tracks DIMMER channels that are currently moving (WORKING=true). */
  private readonly dimmerWorking = new Map<string, boolean>();

  /** Records the last received Homematic LEVEL value and its timestamp for each DIMMER channel. */
  private readonly dimmerLastLevel = new Map<string, { level: number; time: number }>();

  /** Records the last received Homematic LEVEL_2 (tilt) value for each venetian blind channel. */
  private readonly blindLastTilt = new Map<string, number>();

  /**
   * Set of DIMMER channels waiting for the next LEVEL event after WORKING=false fired with a stale
   * last-known value (older than 500 ms). The next arriving LEVEL will be applied immediately.
   */
  private readonly dimmerAwaitingFinalLevel = new Set<string>();

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
      void this.handleRpcEventOperatingVoltage(event);
      void this.handleRpcEventSwitchState(event);
      void this.handleRpcEventContactState(event);
      void this.handleRpcEventDimmerWorking(event);
      void this.handleRpcEventDimmerLevel(event);
      void this.handleRpcEventBlindLevel(event);
      void this.handleRpcEventBlindTilt(event);
      void this.handleRpcEventBlindActivity(event);
      void this.handleRpcEventMotion(event);
      void this.handleRpcEventIlluminance(event);
      void this.handleRpcEventTemperatureHumidity(event);
      void this.handleRpcEventSmoke(event);
      void this.handleRpcEventAlarmState(event);
      void this.handleRpcEventRotaryHandle(event);
      void this.handleRpcEventPowerMeter(event);
      void this.handleRpcEventThermostat(event);
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
    this.rotaryHandleChannels.clear();

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
        switchMatterType: override?.switchMatterType ?? inferSwitchMatterTypeFromName(channel.name),
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
            // Suppress setValue when this change was triggered by an incoming RPC event.
            const suppress = this.rpcEchoSuppress.get(address);
            if (suppress !== undefined && suppress === value) {
              this.rpcEchoSuppress.delete(address);
              return;
            }
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
            // Suppress setValue when this change was triggered by an incoming RPC event.
            const suppress = this.rpcEchoSuppress.get(address);
            if (suppress !== undefined && suppress === level) {
              this.rpcEchoSuppress.delete(address);
              return;
            }
            this.log.debug(`Matter currentLevel -> Homematic setValue: iface=${iface} channel=${address} level=${level}`);
            ccuConn.setChannelDatapointValue(iface, address, 'LEVEL', String(level)).catch((err: unknown) => {
              this.log.warn(`Failed to set Homematic LEVEL for ${address}: ${String(err)}`);
            });
          });
        } catch (err) {
          this.log.warn(`Failed to subscribe LevelControl for ${channel.address}: ${String(err)}`);
        }
        // Wire OnOff for DIMMER: on -> LEVEL 1.005 (restore last level), off -> LEVEL 0.0.
        try {
          await endpoint.subscribeAttribute('OnOff', 'onOff', (value: boolean) => {
            const iface = channel.interfaceName;
            const address = channel.address;
            // Suppress setValue when this change was triggered by an incoming RPC event.
            const suppress = this.rpcEchoSuppress.get(address + ':onoff');
            if (suppress !== undefined && suppress === value) {
              this.rpcEchoSuppress.delete(address + ':onoff');
              return;
            }
            // 1.005 is the Homematic special LEVEL value that restores the last active level.
            const level = value ? 1.005 : 0;
            this.log.debug(`Matter OnOff -> Homematic LEVEL: iface=${iface} channel=${address} onOff=${value} level=${level}`);
            ccuConn.setChannelDatapointValue(iface, address, 'LEVEL', String(level)).catch((err: unknown) => {
              this.log.warn(`Failed to set Homematic LEVEL for ${address}: ${String(err)}`);
            });
          });
        } catch (err) {
          this.log.warn(`Failed to subscribe OnOff (dimmer) for ${channel.address}: ${String(err)}`);
        }
      }

      // Track SHUTTER_CONTACT channel address for inbound STATE events.
      if (channel.type === 'SHUTTER_CONTACT') {
        this.channelAddressToDevice.set(channel.address, endpoint);
      }

      // Track MOTION_DETECTOR channel address for inbound MOTION events.
      if (channel.type === 'MOTION_DETECTOR') {
        this.channelAddressToDevice.set(channel.address, endpoint);
      }

      // Track TEMPERATURE_HUMIDITY_TRANSMITTER channel address for inbound sensor events.
      if (channel.type === 'TEMPERATURE_HUMIDITY_TRANSMITTER') {
        this.channelAddressToDevice.set(channel.address, endpoint);
      }

      // Track WEATHER channel address for inbound sensor events.
      if (channel.type === 'WEATHER') {
        this.channelAddressToDevice.set(channel.address, endpoint);
      }

      // Track SMOKE_DETECTOR channel address for inbound alarm events.
      if (channel.type === 'SMOKE_DETECTOR') {
        this.channelAddressToDevice.set(channel.address, endpoint);
      }

      // Track ALARMSTATE channel address for inbound water-leak alarm events.
      if (channel.type === 'ALARMSTATE') {
        this.channelAddressToDevice.set(channel.address, endpoint);
      }

      // Track ROTARY_HANDLE_SENSOR channel address in its own map to avoid STATE conflicts with SHUTTER_CONTACT.
      if (channel.type === 'ROTARY_HANDLE_SENSOR') {
        this.rotaryHandleChannels.set(channel.address, endpoint);
      }

      // Track POWERMETER channel address for inbound POWER/CURRENT/VOLTAGE events.
      if (channel.type === 'POWERMETER') {
        this.channelAddressToDevice.set(channel.address, endpoint);
      }

      // Wire Thermostat setpoint and mode for HEATING_CLIMATECONTROL_TRANSCEIVER/THERMALCONTROL_TRANSMIT channels.
      if ((channel.type === 'HEATING_CLIMATECONTROL_TRANSCEIVER' || channel.type === 'THERMALCONTROL_TRANSMIT') && this.ccuConnection) {
        const ccuConn = this.ccuConnection;
        this.channelAddressToDevice.set(channel.address, endpoint);
        // Subscribe to setpoint — write Homematic SET_POINT_TEMPERATURE on change.
        try {
          await endpoint.subscribeAttribute('Thermostat', 'occupiedHeatingSetpoint', (value: number) => {
            const address = channel.address;
            // Matter sends 0.01°C (hundredths); Homematic wants plain °C.
            const setpointDegC = value / 100;
            const suppress = this.rpcEchoSuppress.get(address + ':heatingSetpoint');
            if (suppress !== undefined && suppress === value) {
              this.rpcEchoSuppress.delete(address + ':heatingSetpoint');
              return;
            }
            this.log.debug(`Matter Thermostat setpoint -> Homematic: channel=${address} setpoint=${setpointDegC}`);
            ccuConn.setChannelDatapointValue(channel.interfaceName, address, 'SET_POINT_TEMPERATURE', String(setpointDegC)).catch((err: unknown) => {
              this.log.warn(`Failed to set Homematic SET_POINT_TEMPERATURE for ${address}: ${String(err)}`);
            });
          });
        } catch (err) {
          this.log.warn(`Failed to subscribe Thermostat setpoint for ${channel.address}: ${String(err)}`);
        }
        // Subscribe to systemMode — Matter 0=Off maps to frost-protection setpoint (4.5°C) on the device.
        try {
          await endpoint.subscribeAttribute('Thermostat', 'systemMode', (value: number) => {
            const address = channel.address;
            const suppress = this.rpcEchoSuppress.get(address + ':thermMode');
            if (suppress !== undefined && suppress === value) {
              this.rpcEchoSuppress.delete(address + ':thermMode');
              return;
            }
            if (value === 0) {
              // systemMode=Off: write frost-protection temperature to suppress heating.
              ccuConn.setChannelDatapointValue(channel.interfaceName, address, 'SET_POINT_TEMPERATURE', '4.5').catch((err: unknown) => {
                this.log.warn(`Failed to set frost protection for ${address}: ${String(err)}`);
              });
            }
          });
        } catch (err) {
          this.log.warn(`Failed to subscribe Thermostat mode for ${channel.address}: ${String(err)}`);
        }
      }

      // Wire WindowCovering position for BLIND channels.
      // Matter Percent100ths: 0 = fully open, 10000 = fully closed.
      // Homematic LEVEL: 0.0 = fully closed, 1.0 = fully open.
      if (channel.type === 'BLIND' && this.ccuConnection) {
        const ccuConn = this.ccuConnection;
        const isTiltSupported = channel.tiltSupported === true;
        this.channelAddressToDevice.set(channel.address, endpoint);
        try {
          await endpoint.subscribeAttribute('WindowCovering', 'targetPositionLiftPercent100ths', (value: number | null) => {
            const iface = channel.interfaceName;
            const address = channel.address;
            const hmLevel = value != null ? Math.round((1 - value / 10000) * 100) / 100 : 0;
            const suppress = this.rpcEchoSuppress.get(address + ':blindTarget');
            if (suppress !== undefined && suppress === value) {
              this.rpcEchoSuppress.delete(address + ':blindTarget');
              return;
            }
            this.log.debug(`Matter WindowCovering target -> Homematic LEVEL: iface=${iface} channel=${address} target=${value?.toString() ?? 'null'} hmLevel=${hmLevel}`);
            if (isTiltSupported) {
              const tilt = this.blindLastTilt.get(address) ?? 0.5;
              ccuConn.putChannelParamsetValues(iface, address, { LEVEL: hmLevel, LEVEL_2: tilt }).catch((err: unknown) => {
                this.log.warn(`Failed to putParamset LEVEL for ${address}: ${String(err)}`);
              });
            } else {
              ccuConn.setChannelDatapointValue(iface, address, 'LEVEL', String(hmLevel)).catch((err: unknown) => {
                this.log.warn(`Failed to set Homematic LEVEL for ${address}: ${String(err)}`);
              });
            }
          });
        } catch (err) {
          this.log.warn(`Failed to subscribe WindowCovering lift for ${channel.address}: ${String(err)}`);
        }
        if (isTiltSupported) {
          try {
            await endpoint.subscribeAttribute('WindowCovering', 'targetPositionTiltPercent100ths', (value: number | null) => {
              const iface = channel.interfaceName;
              const address = channel.address;
              // Matter 0 = open tilt, 10000 = closed tilt → Homematic LEVEL_2: 0=closed, 1=open.
              const hmTilt = value != null ? Math.round((1 - value / 10000) * 100) / 100 : 0.5;
              const suppress = this.rpcEchoSuppress.get(address + ':blindTilt');
              if (suppress !== undefined && suppress === value) {
                this.rpcEchoSuppress.delete(address + ':blindTilt');
                return;
              }
              this.log.debug(`Matter WindowCovering tilt -> Homematic LEVEL_2: iface=${iface} channel=${address} tilt=${value?.toString() ?? 'null'} hmTilt=${hmTilt}`);
              const lastLevel = this.dimmerLastLevel.get(address)?.level ?? 0;
              ccuConn.putChannelParamsetValues(iface, address, { LEVEL: lastLevel, LEVEL_2: hmTilt }).catch((err: unknown) => {
                this.log.warn(`Failed to putParamset LEVEL_2 for ${address}: ${String(err)}`);
              });
            });
          } catch (err) {
            this.log.warn(`Failed to subscribe WindowCovering tilt for ${channel.address}: ${String(err)}`);
          }
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
   * Handle incoming RPC event for OPERATING_VOLTAGE datapoint and update Matter batPercentRemaining.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] Interface name (e.g. 'HmIP-RF').
   * @param {string} [event.idInit] Init ID of the interface.
   * @param {unknown} [event.channel] Channel address string (always device channel 0).
   * @param {string} [event.datapoint] Datapoint name (e.g. 'OPERATING_VOLTAGE').
   * @param {unknown} [event.value] Voltage value in volts.
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventOperatingVoltage(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'OPERATING_VOLTAGE') return;

    const deviceAddress = this.extractDeviceAddressFromRpcChannel(event.channel);
    if (!deviceAddress) return;
    if (this.mainsPoweredDevices.has(deviceAddress)) {
      this.log.debug(`OPERATING_VOLTAGE event ignored for mains-powered device=${deviceAddress}`);
      return;
    }

    const endpoint = this.deviceAddressToDevice.get(deviceAddress);
    if (!endpoint?.hasClusterServer('PowerSource')) return;

    const voltage = typeof event.value === 'number' ? event.value : 0;
    const ch0 = this.discoveredChannels.find((ch) => ch.deviceAddress === deviceAddress && ch.channelIndex === 0);
    const range = getBatteryVoltageRange(ch0?.deviceType);
    const pct = Math.max(0, Math.min(100, Math.round(((voltage - range.min) / (range.max - range.min)) * 100)));
    const batPercentRemaining = pct * 2;

    try {
      const current = await endpoint.getAttribute('PowerSource', 'batPercentRemaining');
      if (current !== batPercentRemaining) {
        await endpoint.updateAttribute('PowerSource', 'batPercentRemaining', batPercentRemaining);
        this.log.info(`Battery voltage updated: ${deviceAddress} voltage=${voltage}V pct=${pct}% batPercentRemaining=${batPercentRemaining}`);
      }
    } catch (err) {
      this.log.debug(`Failed to update batPercentRemaining for ${deviceAddress}: ${String(err)}`);
    }
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
        // Suppress the echo setValue that subscribeAttribute would send back.
        this.rpcEchoSuppress.set(channelAddress, newValue);
        await endpoint.updateAttribute('OnOff', 'onOff', newValue);
        this.log.info(`SWITCH STATE event: updated Matter OnOff for ${channelAddress} to ${newValue}`);
      }
    } catch (err) {
      this.rpcEchoSuppress.delete(channelAddress);
      this.log.warn(`Failed to update Matter OnOff for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for SHUTTER_CONTACT channel STATE and update Matter BooleanState.
   * Homematic STATE: true = closed/contact, false = open/no-contact.
   * Matter BooleanState stateValue: true = contact (closed).
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] Interface name.
   * @param {string} [event.idInit] Init ID of the interface.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name (e.g. 'STATE').
   * @param {unknown} [event.value] Datapoint value (boolean).
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventContactState(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'STATE') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;

    if (!endpoint.hasClusterServer('BooleanState')) return;

    // Homematic STATE: true = open (reed triggered), false = closed. Matter stateValue: true = contact (closed).
    const closed = !(event.value === true || event.value === 1 || event.value === '1');
    try {
      const current = await endpoint.getAttribute('BooleanState', 'stateValue');
      if (current !== closed) {
        await endpoint.updateAttribute('BooleanState', 'stateValue', closed);
        this.log.info(`SHUTTER_CONTACT STATE event: updated Matter stateValue for ${channelAddress} to ${closed}`);
      }
    } catch (err) {
      this.log.warn(`Failed to update Matter BooleanState for ${channelAddress}: ${String(err)}`);
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

    // Always record the latest level with a timestamp so WORKING=false can pick it up.
    this.dimmerLastLevel.set(channelAddress, { level: hmLevel, time: Date.now() });

    // Suppress Matter update while the device is moving.
    if (this.dimmerWorking.get(channelAddress) === true) {
      this.log.debug(`DIMMER LEVEL event suppressed (WORKING=true): channel=${channelAddress} level=${hmLevel}`);
      return;
    }

    // If we're waiting for the final level after a stale WORKING=false, apply this one.
    const wasAwaiting = this.dimmerAwaitingFinalLevel.delete(channelAddress);
    if (wasAwaiting) {
      this.log.debug(`DIMMER LEVEL event applied (awaited after WORKING=false): channel=${channelAddress} level=${hmLevel}`);
    }

    await this.applyDimmerLevel(channelAddress, endpoint, hmLevel);
  }

  /**
   * Handle incoming RPC event for the DIMMER WORKING datapoint.
   * Defers Matter updates while the device is moving; applies the last pending level when WORKING=false.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] Interface name.
   * @param {string} [event.idInit] Init ID of the interface.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name (e.g. 'WORKING').
   * @param {unknown} [event.value] Datapoint value (boolean).
   * @returns {Promise<void>} Resolves when any pending update has been applied.
   */
  private async handleRpcEventDimmerWorking(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'WORKING') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    // Only relevant for DIMMER channels.
    if (!this.channelAddressToDevice.has(channelAddress)) return;

    const isWorking = event.value === true || event.value === 1 || event.value === '1';
    if (isWorking) {
      this.dimmerWorking.set(channelAddress, true);
      this.log.debug(`DIMMER WORKING=true: channel=${channelAddress}`);
      return;
    }

    this.dimmerWorking.delete(channelAddress);
    this.log.debug(`DIMMER WORKING=false: channel=${channelAddress}`);

    const last = this.dimmerLastLevel.get(channelAddress);
    const age = last !== undefined ? Date.now() - last.time : Infinity;

    if (last !== undefined && age < 500) {
      // Last known level is fresh — apply it immediately.
      this.log.debug(`DIMMER WORKING=false: applying last known level=${last.level} age=${age}ms channel=${channelAddress}`);
      const endpoint = this.channelAddressToDevice.get(channelAddress);
      if (endpoint) {
        if (endpoint.hasClusterServer('WindowCovering')) {
          await this.applyBlindLevel(channelAddress, endpoint, last.level);
        } else {
          await this.applyDimmerLevel(channelAddress, endpoint, last.level);
        }
      }
    } else {
      // Last known level is stale or absent — wait for the next LEVEL event.
      this.log.debug(`DIMMER WORKING=false: awaiting next LEVEL (last age=${age === Infinity ? 'none' : `${age}ms`}) channel=${channelAddress}`);
      this.dimmerAwaitingFinalLevel.add(channelAddress);
    }
  }

  /**
   * Apply a Homematic LEVEL value to the corresponding Matter LevelControl and OnOff attributes.
   *
   * @param {string} channelAddress Full channel address (e.g. 'DEVICE:3').
   * @param {MatterbridgeEndpoint} endpoint The Matter endpoint to update.
   * @param {number} hmLevel Homematic LEVEL value in the range 0.0–1.0.
   * @returns {Promise<void>} Resolves when the attributes have been updated.
   */
  private async applyDimmerLevel(channelAddress: string, endpoint: MatterbridgeEndpoint, hmLevel: number): Promise<void> {
    const matterLevel = hmLevel > 0 ? Math.max(1, Math.round(hmLevel * 254)) : 0;
    const onOff = matterLevel > 0;
    // The level value the subscribeAttribute callback will see (round-tripped back from matterLevel).
    const suppressLevel = matterLevel > 0 ? Math.round((matterLevel / 254) * 100) / 100 : 0;

    try {
      // Suppress the echo setValue that subscribeAttribute would send back.
      this.rpcEchoSuppress.set(channelAddress, suppressLevel);
      await endpoint.updateAttribute('LevelControl', 'currentLevel', matterLevel > 0 ? matterLevel : 1);
      if (endpoint.hasClusterServer('OnOff')) {
        const currentOnOff = await endpoint.getAttribute('OnOff', 'onOff');
        if (currentOnOff !== onOff) {
          this.rpcEchoSuppress.set(channelAddress + ':onoff', onOff);
          await endpoint.updateAttribute('OnOff', 'onOff', onOff);
        }
      }
      this.log.info(`DIMMER LEVEL event: updated Matter level for ${channelAddress} to ${matterLevel} (onOff=${onOff})`);
    } catch (err) {
      this.rpcEchoSuppress.delete(channelAddress);
      this.rpcEchoSuppress.delete(channelAddress + ':onoff');
      this.log.warn(`Failed to update Matter LevelControl for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for MOTION_DETECTOR channel MOTION datapoint.
   * Maps to the Matter OccupancySensing cluster.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name (e.g. 'MOTION').
   * @param {unknown} [event.value] Datapoint value (boolean; true = motion detected).
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventMotion(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'MOTION') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('OccupancySensing')) return;

    const occupied = event.value === true || event.value === 1 || event.value === '1';
    try {
      const current = await endpoint.getAttribute('OccupancySensing', 'occupancy');
      const currentOccupied = typeof current === 'object' && current !== null && 'occupied' in current ? (current as { occupied: boolean }).occupied : false;
      if (currentOccupied !== occupied) {
        await endpoint.updateAttribute('OccupancySensing', 'occupancy', { occupied });
        this.log.info(`MOTION_DETECTOR MOTION event: updated occupancy for ${channelAddress} to ${occupied}`);
      }
    } catch (err) {
      this.log.warn(`Failed to update Matter OccupancySensing for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for MOTION_DETECTOR channel ILLUMINATION datapoint.
   * Maps to the Matter IlluminanceMeasurement cluster (measuredValue = 10000 * log10(lux) + 1).
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name (e.g. 'ILLUMINATION').
   * @param {unknown} [event.value] Illuminance value in lux.
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventIlluminance(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'ILLUMINATION') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('IlluminanceMeasurement')) return;

    const lux = typeof event.value === 'number' ? event.value : 0;
    // Matter IlluminanceMeasurement.measuredValue = 10000 * log10(lux) + 1 for lux > 0; 0 otherwise.
    const measuredValue = lux > 0 ? Math.round(10000 * Math.log10(lux) + 1) : 0;
    try {
      const current = await endpoint.getAttribute('IlluminanceMeasurement', 'measuredValue');
      if (current !== measuredValue) {
        await endpoint.updateAttribute('IlluminanceMeasurement', 'measuredValue', measuredValue);
        this.log.info(`MOTION_DETECTOR ILLUMINATION event: updated illuminance for ${channelAddress} to ${measuredValue} (${lux} lux)`);
      }
    } catch (err) {
      this.log.warn(`Failed to update IlluminanceMeasurement for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for TEMPERATURE_HUMIDITY_TRANSMITTER channel datapoints.
   * Maps ACTUAL_TEMPERATURE to TemperatureMeasurement and HUMIDITY to RelativeHumidityMeasurement.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name ('ACTUAL_TEMPERATURE', 'TEMPERATURE', 'HUMIDITY', or 'BRIGHTNESS').
   * @param {unknown} [event.value] Datapoint value (float; temperature in °C, humidity in %, brightness in lux).
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventTemperatureHumidity(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'ACTUAL_TEMPERATURE' && datapoint !== 'TEMPERATURE' && datapoint !== 'HUMIDITY' && datapoint !== 'BRIGHTNESS') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;

    if (datapoint === 'ACTUAL_TEMPERATURE' || datapoint === 'TEMPERATURE') {
      if (!endpoint.hasClusterServer('TemperatureMeasurement')) return;
      // Matter TemperatureMeasurement.measuredValue is in units of 0.01°C.
      const measuredValue = Math.round((typeof event.value === 'number' ? event.value : 0) * 100);
      try {
        const current = await endpoint.getAttribute('TemperatureMeasurement', 'measuredValue');
        if (current !== measuredValue) {
          await endpoint.updateAttribute('TemperatureMeasurement', 'measuredValue', measuredValue);
          this.log.info(`TEMPERATURE event: updated TemperatureMeasurement for ${channelAddress} to ${measuredValue} (${measuredValue / 100}°C)`);
        }
      } catch (err) {
        this.log.warn(`Failed to update TemperatureMeasurement for ${channelAddress}: ${String(err)}`);
      }
      return;
    }

    if (datapoint === 'BRIGHTNESS') {
      if (!endpoint.hasClusterServer('IlluminanceMeasurement')) return;
      // Matter IlluminanceMeasurement.measuredValue = 10000 * log10(lux) + 1 for lux > 0; 0 otherwise.
      const lux = typeof event.value === 'number' ? event.value : 0;
      const measuredValue = lux > 0 ? Math.round(10000 * Math.log10(lux) + 1) : 0;
      try {
        const current = await endpoint.getAttribute('IlluminanceMeasurement', 'measuredValue');
        if (current !== measuredValue) {
          await endpoint.updateAttribute('IlluminanceMeasurement', 'measuredValue', measuredValue);
          this.log.info(`BRIGHTNESS event: updated illuminance for ${channelAddress} to ${measuredValue} (${lux} lux)`);
        }
      } catch (err) {
        this.log.warn(`Failed to update IlluminanceMeasurement for ${channelAddress}: ${String(err)}`);
      }
      return;
    }

    // HUMIDITY
    if (!endpoint.hasClusterServer('RelativeHumidityMeasurement')) return;
    // Matter RelativeHumidityMeasurement.measuredValue is in units of 0.01%.
    const measuredValue = Math.round((typeof event.value === 'number' ? event.value : 0) * 100);
    try {
      const current = await endpoint.getAttribute('RelativeHumidityMeasurement', 'measuredValue');
      if (current !== measuredValue) {
        await endpoint.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', measuredValue);
        this.log.info(`HUMIDITY event: updated RelativeHumidityMeasurement for ${channelAddress} to ${measuredValue} (${measuredValue / 100}%)`);
      }
    } catch (err) {
      this.log.warn(`Failed to update RelativeHumidityMeasurement for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for SMOKE_DETECTOR channel alarm datapoints.
   * Maps SMOKE_DETECTOR_ALARM_STATUS (numeric) or STATE (boolean) to the Matter SmokeCoAlarm cluster.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name ('SMOKE_DETECTOR_ALARM_STATUS' or 'STATE').
   * @param {unknown} [event.value] Datapoint value (numeric alarm code or boolean).
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventSmoke(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'SMOKE_DETECTOR_ALARM_STATUS' && datapoint !== 'STATE') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('SmokeCoAlarm')) return;

    // SMOKE_DETECTOR_ALARM_STATUS: 0 = normal, >0 = alarm.  STATE (boolean): true = alarm.
    const alarmActive = datapoint === 'STATE' ? event.value === true || event.value === 1 || event.value === '1' : typeof event.value === 'number' ? event.value > 0 : false;

    // Matter SmokeCoAlarm.smokeState: 0=Normal, 1=Warning, 2=Critical.
    const smokeState = alarmActive ? 2 : 0;
    try {
      const current = await endpoint.getAttribute('SmokeCoAlarm', 'smokeState');
      if (current !== smokeState) {
        await endpoint.updateAttribute('SmokeCoAlarm', 'smokeState', smokeState);
        this.log.info(`SMOKE_DETECTOR alarm event: updated smokeState for ${channelAddress} to ${smokeState} (alarm=${alarmActive})`);
      }
    } catch (err) {
      this.log.warn(`Failed to update SmokeCoAlarm for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for ALARMSTATE channel water-leak alarm datapoint.
   * Maps ALARMSTATE (numeric/boolean) to the Matter BooleanState cluster on a waterLeakDetector endpoint.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name (e.g. 'ALARMSTATE').
   * @param {unknown} [event.value] Alarm state value (numeric >0 = alarm, 0 = normal; or boolean).
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventAlarmState(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'ALARMSTATE') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('BooleanState')) return;

    // ALARMSTATE: 0 = no alarm, >0 = alarm active. Boolean true = alarm.
    const leakDetected = typeof event.value === 'number' ? event.value > 0 : event.value === true || event.value === 1 || event.value === '1';

    try {
      const current = await endpoint.getAttribute('BooleanState', 'stateValue');
      if (current !== leakDetected) {
        await endpoint.updateAttribute('BooleanState', 'stateValue', leakDetected);
        this.log.info(`ALARMSTATE event: updated water-leak stateValue for ${channelAddress} to ${leakDetected}`);
      }
    } catch (err) {
      this.log.warn(`Failed to update BooleanState for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for ROTARY_HANDLE_SENSOR channel STATE datapoint.
   * Maps the 3-state Homematic value to the Matter BooleanState cluster on a contactSensor endpoint.
   * STATE 0 = closed (stateValue=true), STATE 1 (tilted) or 2 (open) = not closed (stateValue=false).
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name (e.g. 'STATE').
   * @param {unknown} [event.value] Integer state value: 0=closed, 1=tilted, 2=open.
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventRotaryHandle(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'STATE') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.rotaryHandleChannels.get(channelAddress);
    if (!endpoint) return;
    // Guard: only act on rotary handle endpoints (bridged info model suffix distinguishes from SHUTTER_CONTACT).
    if (!endpoint.hasClusterServer('BooleanState')) return;

    // STATE 0 = fully closed → contact detected (stateValue=true).
    // STATE 1 = tilted, STATE 2 = open → no contact (stateValue=false).
    const closed = event.value === 0 || event.value === '0' || event.value === false;
    try {
      const current = await endpoint.getAttribute('BooleanState', 'stateValue');
      if (current !== closed) {
        await endpoint.updateAttribute('BooleanState', 'stateValue', closed);
        this.log.info(`ROTARY_HANDLE_SENSOR STATE event: updated stateValue for ${channelAddress} to ${closed} (raw=${String(event.value)})`);
      }
    } catch (err) {
      this.log.warn(`Failed to update BooleanState for rotary handle ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for POWERMETER channel datapoints.
   * Maps POWER (W), CURRENT (A), and VOLTAGE (V) to Matter ElectricalPowerMeasurement cluster attributes.
   * Values are converted to milliwatts/milliamps/millivolts as required by the cluster.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name ('POWER', 'CURRENT', or 'VOLTAGE').
   * @param {unknown} [event.value] Datapoint value (float).
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventPowerMeter(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'POWER' && datapoint !== 'CURRENT' && datapoint !== 'VOLTAGE') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('ElectricalPowerMeasurement')) return;

    const raw = typeof event.value === 'number' ? event.value : 0;

    // ElectricalPowerMeasurement uses milliwatts/milliamps/millivolts.
    const attrMap: Record<string, string> = { POWER: 'activePower', CURRENT: 'activeCurrent', VOLTAGE: 'voltage' };
    const attr = attrMap[datapoint];
    if (!attr) return;

    const milliValue = Math.round(raw * 1000);
    try {
      const current = await endpoint.getAttribute('ElectricalPowerMeasurement', attr);
      if (current !== milliValue) {
        await endpoint.updateAttribute('ElectricalPowerMeasurement', attr, milliValue);
        this.log.info(`POWERMETER ${datapoint} event: updated ${attr} for ${channelAddress} to ${milliValue} (${raw} raw)`);
      }
    } catch (err) {
      this.log.warn(`Failed to update ElectricalPowerMeasurement.${attr} for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for THERMOSTAT channels (HEATING_CLIMATECONTROL_TRANSCEIVER / THERMALCONTROL_TRANSMIT).
   * Maps ACTUAL_TEMPERATURE to Thermostat.localTemperature and SET_POINT_TEMPERATURE/SETPOINT to
   * Thermostat.occupiedHeatingSetpoint. Derives systemMode from the setpoint level (≤4.5°C = Off).
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name ('ACTUAL_TEMPERATURE', 'SET_POINT_TEMPERATURE', or 'SETPOINT').
   * @param {unknown} [event.value] Datapoint value (float, °C).
   * @returns {Promise<void>} Resolves when the Matter attribute(s) have been updated.
   */
  private async handleRpcEventThermostat(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'ACTUAL_TEMPERATURE' && datapoint !== 'SET_POINT_TEMPERATURE' && datapoint !== 'SETPOINT') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('Thermostat')) return;

    if (datapoint === 'ACTUAL_TEMPERATURE') {
      // Matter Thermostat.localTemperature is in units of 0.01°C.
      const measuredValue = Math.round((typeof event.value === 'number' ? event.value : 0) * 100);
      try {
        const current = await endpoint.getAttribute('Thermostat', 'localTemperature');
        if (current !== measuredValue) {
          await endpoint.updateAttribute('Thermostat', 'localTemperature', measuredValue);
          this.log.info(`THERMOSTAT ACTUAL_TEMPERATURE event: updated localTemperature for ${channelAddress} to ${measuredValue} (${measuredValue / 100}°C)`);
        }
      } catch (err) {
        this.log.warn(`Failed to update Thermostat localTemperature for ${channelAddress}: ${String(err)}`);
      }
      return;
    }

    // SET_POINT_TEMPERATURE or SETPOINT.
    const setpointDegC = typeof event.value === 'number' ? event.value : 0;
    // Matter Thermostat.occupiedHeatingSetpoint is in units of 0.01°C.
    const setpointValue = Math.round(setpointDegC * 100);
    // Derive systemMode: frost-protection level (≤4.5°C) → Off (0); otherwise → Heat (4).
    const matterMode = setpointDegC <= 4.5 ? 0 : 4;
    try {
      const current = await endpoint.getAttribute('Thermostat', 'occupiedHeatingSetpoint');
      if (current !== setpointValue) {
        this.rpcEchoSuppress.set(channelAddress + ':heatingSetpoint', setpointValue);
        await endpoint.updateAttribute('Thermostat', 'occupiedHeatingSetpoint', setpointValue);
        this.rpcEchoSuppress.set(channelAddress + ':thermMode', matterMode);
        await endpoint.updateAttribute('Thermostat', 'systemMode', matterMode);
        this.log.info(`THERMOSTAT SET_POINT_TEMPERATURE event: updated setpoint for ${channelAddress} to ${setpointValue} (${setpointDegC}°C) mode=${matterMode}`);
      }
    } catch (err) {
      this.rpcEchoSuppress.delete(channelAddress + ':heatingSetpoint');
      this.rpcEchoSuppress.delete(channelAddress + ':thermMode');
      this.log.warn(`Failed to update Thermostat setpoint for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for the BLIND channel LEVEL_2 (slat tilt) datapoint.
   * Only applies to venetian blind channels that support tilt (BLIND_VIRTUAL_RECEIVER).
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name (e.g. 'LEVEL_2').
   * @param {unknown} [event.value] Datapoint value (0.0–1.0 float; 0=closed tilt, 1=open tilt).
   * @returns {Promise<void>} Resolves when the Matter tilt attribute has been updated.
   */
  private async handleRpcEventBlindTilt(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'LEVEL_2') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('WindowCovering')) return;

    const hmTilt = typeof event.value === 'number' ? event.value : 0.5;
    this.blindLastTilt.set(channelAddress, hmTilt);

    // Matter tilt Percent100ths: 0 = fully open, 10000 = fully closed.
    // Homematic LEVEL_2: 0.0 = closed, 1.0 = open → same inversion as lift LEVEL.
    const matterTilt = Math.round((1 - hmTilt) * 10000);

    try {
      const suppress = this.rpcEchoSuppress.get(channelAddress + ':blindTilt');
      if (suppress !== undefined && suppress === matterTilt) {
        this.rpcEchoSuppress.delete(channelAddress + ':blindTilt');
        return;
      }
      this.rpcEchoSuppress.set(channelAddress + ':blindTilt', matterTilt);
      await endpoint.updateAttribute('WindowCovering', 'currentPositionTiltPercent100ths', matterTilt);
      await endpoint.updateAttribute('WindowCovering', 'targetPositionTiltPercent100ths', matterTilt);
      this.log.info(`BLIND LEVEL_2 event: updated tilt for ${channelAddress} to ${matterTilt}/10000 (hmTilt=${hmTilt})`);
    } catch (err) {
      this.rpcEchoSuppress.delete(channelAddress + ':blindTilt');
      this.log.warn(`Failed to update Matter WindowCovering tilt for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for BLIND channel LEVEL and update Matter WindowCovering endpoint.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] Interface name.
   * @param {string} [event.idInit] Init ID of the interface.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name (e.g. 'LEVEL').
   * @param {unknown} [event.value] Datapoint value (0.0–1.0 float; 0=closed, 1=open).
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventBlindLevel(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'LEVEL') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;

    if (!endpoint.hasClusterServer('WindowCovering')) return;

    const hmLevel = typeof event.value === 'number' ? event.value : 0;

    // Always record the latest level with a timestamp so WORKING=false can pick it up.
    this.dimmerLastLevel.set(channelAddress, { level: hmLevel, time: Date.now() });

    // Suppress Matter update while the device is moving.
    if (this.dimmerWorking.get(channelAddress) === true) {
      this.log.debug(`BLIND LEVEL event suppressed (WORKING=true): channel=${channelAddress} level=${hmLevel}`);
      return;
    }

    const wasAwaiting = this.dimmerAwaitingFinalLevel.delete(channelAddress);
    if (wasAwaiting) {
      this.log.debug(`BLIND LEVEL event applied (awaited after WORKING=false): channel=${channelAddress} level=${hmLevel}`);
    }

    await this.applyBlindLevel(channelAddress, endpoint, hmLevel);
  }

  /**
   * Handle incoming RPC event for the BLIND channel ACTIVITY_STATE or DIRECTION datapoint.
   * Maps the movement direction to the Matter WindowCovering operationalStatus.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name ('ACTIVITY_STATE' or 'DIRECTION').
   * @param {unknown} [event.value] Datapoint value (integer: 0=stopped, 1=opening, 2=closing).
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventBlindActivity(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'ACTIVITY_STATE' && datapoint !== 'DIRECTION') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('WindowCovering')) return;

    // Homematic: 0=stopped, 1=opening (INCREASING), 2=closing (DECREASING).
    const value = typeof event.value === 'number' ? event.value : 0;
    const status = value === 1 ? 1 : value === 2 ? 2 : 0;

    try {
      await endpoint.setWindowCoveringStatus(status);
      this.log.debug(`BLIND ACTIVITY_STATE event: operationalStatus=${status} for ${channelAddress}`);
    } catch (err) {
      this.log.warn(`Failed to update WindowCovering operationalStatus for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Apply a Homematic LEVEL value to the corresponding Matter WindowCovering attributes.
   *
   * @param {string} channelAddress Full channel address (e.g. 'DEVICE:1').
   * @param {MatterbridgeEndpoint} endpoint The Matter endpoint to update.
   * @param {number} hmLevel Homematic LEVEL value in the range 0.0 (closed) – 1.0 (open).
   * @returns {Promise<void>} Resolves when the attributes have been updated.
   */
  private async applyBlindLevel(channelAddress: string, endpoint: MatterbridgeEndpoint, hmLevel: number): Promise<void> {
    // Matter Percent100ths: 0 = fully open, 10000 = fully closed.
    const position = Math.round((1 - hmLevel) * 10000);
    try {
      // Suppress the echo that subscribeAttribute on targetPositionLiftPercent100ths would send back.
      this.rpcEchoSuppress.set(channelAddress + ':blindTarget', position);
      await endpoint.setWindowCoveringTargetAndCurrentPosition(position);
      this.log.info(`BLIND LEVEL event: updated WindowCovering for ${channelAddress} to ${position}/10000 (hmLevel=${hmLevel})`);
    } catch (err) {
      this.rpcEchoSuppress.delete(channelAddress + ':blindTarget');
      this.log.warn(`Failed to update Matter WindowCovering for ${channelAddress}: ${String(err)}`);
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
