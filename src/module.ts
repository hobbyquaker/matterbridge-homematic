/**
 * This file contains the Homematic CCU plugin for Matterbridge.
 *
 * @file module.ts
 * @author hobbyquaker (https://github.com/hobbyquaker)
 * @created 2025-06-15
 * @version 0.10.0
 * @license Apache-2.0
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

import os from 'node:os';
import path from 'node:path';

import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { parseCcuConnectionConfig } from './ccu/config.js';
import { CcuConnectionLayer } from './ccu/connection-layer.js';
import {
  channelTypeLabel,
  createEndpointForChannel,
  getDeviceMapper,
  inferSwitchMatterTypeFromName,
  isSupportedChannelType,
  resolveChannelsForMatter,
} from './ccu/device-mapper.js';
import { getBatteryVoltageRange, getMatchingMainsPoweredPrefix, isAlwaysMainsPoweredDeviceType, MAINS_POWERED_DEVICE_TYPE_PREFIXES } from './ccu/device-power.js';
import { buildParamsetKey, ParamsetCache } from './ccu/paramset-cache.js';
import { CcuChannelInfo, CcuChannelOverride, CcuInterfaceName } from './ccu/types.js';

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
  /** When true, fetch current datapoint values from ReGa on startup to seed initial Matter state. Default false. */
  initialValuesFromRega?: boolean;
}

// Here we define the TemplatePlatform class, which extends the MatterbridgeDynamicPlatform.
// If you want to create an Accessory platform plugin, you should extend the MatterbridgeAccessoryPlatform class instead.
export class TemplatePlatform extends MatterbridgeDynamicPlatform {
  private ccuConnection?: CcuConnectionLayer;

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
   * Maps ENERGIE_METER_TRANSMITTER (HmIP) channel addresses to their Matter endpoints.
   * Kept separate from channelAddressToDevice because HmIP reports CURRENT in milliamps (mA)
   * while BidCos POWERMETER reports it in amps (A), requiring different unit conversion.
   */
  private readonly energieMeterChannels = new Map<string, MatterbridgeEndpoint>();

  /**
   * Maps HEATING_CLIMATECONTROL_TRANSCEIVER channel addresses to their dedicated humiditySensor
   * endpoints for devices that expose HUMIDITY on the same channel (HmIP-WTH, STHD, STH family).
   * Kept separate from channelAddressToDevice so that HUMIDITY events can be routed to the
   * humiditySensor endpoint without interfering with the thermostat endpoint stored there.
   */
  private readonly wthHumidityChannels = new Map<string, MatterbridgeEndpoint>();

  /**
   * Tracks the last value written to a Matter attribute from an incoming RPC event.
   * Used to suppress the echo setValue that the subscribeAttribute callback would otherwise send back.
   */
  private readonly rpcEchoSuppress = new Map<string, boolean | number>();

  /** Tracks DIMMER channels that are currently moving (WORKING=true). */
  private readonly dimmerWorking = new Map<string, boolean>();

  /**
   * Tracks the Matter-commanded target position (Percent100ths) for BLIND channels.
   * Set when the subscription fires (command sent to CCU); cleared when movement stops.
   * While set, early LEVEL echos from the CCU only update currentPositionLiftPercent100ths,
   * preserving the commanded target so the Home app shows the correct destination.
   */
  private readonly blindCommandedTarget = new Map<string, number>();

  /** Records the last received Homematic LEVEL value and its timestamp for each DIMMER channel. */
  private readonly dimmerLastLevel = new Map<string, { level: number; time: number }>();

  /** Records the last received Homematic LEVEL_2 (tilt) value for each venetian blind channel. */
  private readonly blindLastTilt = new Map<string, number>();

  /**
   * Remembers the last non-frost-protection setpoint (>4.5°C) per thermostat channel address.
   * Used to restore the previous setpoint when switching from Off back to Heat mode.
   */
  private readonly thermostatLastSetpoint = new Map<string, number>();

  /**
   * Tracks the combined lock state (STATE, STATE_UNCERTAIN, ERROR) per KEYMATIC channel address.
   * Used to derive the Matter DoorLock.lockState from multiple Homematic datapoints.
   */
  private readonly keymaticState = new Map<string, { state: boolean; uncertain: boolean; error: boolean; direction: number }>();

  /**
   * Set of DIMMER channels waiting for the next LEVEL event after WORKING=false fired with a stale
   * last-known value (older than 500 ms). The next arriving LEVEL will be applied immediately.
   */
  private readonly dimmerAwaitingFinalLevel = new Set<string>();

  private readonly deviceBatteryHints = new Map<string, boolean>();

  private readonly deviceBatteryLowState = new Map<string, boolean>();

  private readonly mainsPoweredDevices = new Set<string>();

  private batteryRediscoveryTimer?: NodeJS.Timeout;

  private paramsetCache?: ParamsetCache;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    // Always call super(matterbridge, log, config)
    super(matterbridge, log, config);

    // Override the log name so the log prefix stays 'Homematic' regardless of the npm package description.
    this.log.logName = 'Homematic';

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

    this.paramsetCache = new ParamsetCache(this.log, cacheDir);
    await this.paramsetCache.load();

    await this.ccuConnection.start();

    // Listen for channel updates and refresh device names when ReGa names arrive
    this.ccuConnection.on('channelsUpdated', (updatedChannels: CcuChannelInfo[]) => {
      this.log.debug(`Channels updated event received with ${updatedChannels.length} channels`);
      this.syncChannelListEntriesWithRegaNames(updatedChannels);
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
      void this.handleRpcEventEnergieMeter(event);
      void this.handleRpcEventThermostat(event);
      void this.handleRpcEventKeymatic(event);
      void this.handleRpcEventKey(event);
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

    const status = this.ccuConnection.getStatusSnapshot();
    this.log.info(`CCU status host=${status.host || 'not-configured'} connected=${status.connected} interfaces=${status.connectedInterfaces.join(',') || 'none'}`);

    // Implements your own logic there
    await this.discoverDevices();
    await this.applyInitialValuesFromRega();
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
    // Wait for the CCU's newDevices callback to patch device VERSION into the channel objects.
    // This ensures primeBatteryHintsFromRpc uses the correct VERSION for paramset cache keys
    // even when the discovery cache was populated before the newDevices payload arrived.
    await this.ccuConnection.waitForNewDevices(5000);
    const cachedChannels = this.ccuConnection.getCachedChannels();
    const enabledInterfaces = this.ccuConnection.getStatusSnapshot().enabledInterfaces;
    this.updateMainsPoweredDeviceSet(rawChannels);
    await this.primeBatteryHintsFromRpc(rawChannels);
    await this.cleanupDisabledInterfaceChannels(cachedChannels, enabledInterfaces);
    this.syncChannelListEntriesWithRegaNames(cachedChannels, enabledInterfaces);
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
    this.energieMeterChannels.clear();
    this.wthHumidityChannels.clear();

    let enabledCount = 0;
    let registeredCount = 0;

    // Group resolved channels by device address (used by the channel loop and select/enabled logic).
    const channelsByDevice = new Map<string, CcuChannelInfo[]>();
    for (const ch of channels) {
      const list = channelsByDevice.get(ch.deviceAddress);
      if (list) {
        list.push(ch);
      } else {
        channelsByDevice.set(ch.deviceAddress, [ch]);
      }
    }

    // Group raw channels by device address for the device mapper pre-pass.
    // Device mappers receive raw channels so they can reference real Homematic channel types
    // (e.g. SWITCH_TRANSMITTER, SWITCH_VIRTUAL_RECEIVER) rather than pre-processed types.
    const rawChannelsByDevice = new Map<string, CcuChannelInfo[]>();
    for (const ch of rawChannels) {
      const list = rawChannelsByDevice.get(ch.deviceAddress);
      if (list) {
        list.push(ch);
      } else {
        rawChannelsByDevice.set(ch.deviceAddress, [ch]);
      }
    }

    // Device mapper pre-pass: handle devices with registered device mappers before the channel loop.
    // Device mappers take full priority over channel mappers — all channels of a mapped device are
    // handled exclusively by the device mapper. The channel loop below skips these devices entirely.
    const deviceMapperHandled = new Set<string>();
    for (const [deviceAddress, rawDeviceChannels] of rawChannelsByDevice) {
      // Look up device mapper by device type (shared across all channels in the group).
      const deviceType = rawDeviceChannels.find((c) => c.deviceType)?.deviceType;
      if (!deviceType) continue;
      const mapper = getDeviceMapper(deviceType);
      if (!mapper) continue;

      const resolvedDeviceChannels = channelsByDevice.get(deviceAddress) ?? [];

      // Derive device-level mapping options from the first resolved supported channel.
      // These options (switchMatterType, batteryPowered) apply to all endpoints produced
      // by this device mapper. Per-endpoint overrides are not yet supported.
      const primaryChannel = resolvedDeviceChannels.find((c) => isSupportedChannelType(c.type));
      const deviceOverride = primaryChannel ? this.getChannelOverride(primaryChannel.address) : undefined;
      const mappingOptions = {
        switchMatterType: deviceOverride?.switchMatterType ?? (primaryChannel ? inferSwitchMatterTypeFromName(primaryChannel.name) : undefined),
        batteryPowered: this.deviceBatteryHints.get(deviceAddress) ?? primaryChannel?.batteryPowered ?? false,
      };

      // Pre-check: if every resolved supported channel for this device is disabled, skip the mapper
      // call entirely so MatterbridgeEndpoints are not created and immediately discarded.
      // Still register selectDevice entries so the channels appear in the Matterbridge UI.
      const resolvedSupportedChannels = resolvedDeviceChannels.filter((ch) => isSupportedChannelType(ch.type));
      if (
        resolvedSupportedChannels.length > 0 &&
        resolvedSupportedChannels.every((ch) => !this.isChannelEnabled(ch, this.getChannelOverride(ch.address), this.getChannelDisplayName(ch)))
      ) {
        deviceMapperHandled.add(deviceAddress);
        for (const ch of resolvedSupportedChannels) {
          const displayName = this.getChannelDisplayName(ch);
          const selectSerial = this.getChannelSelectSerial(ch);
          for (const oldKey of this.getLegacyChannelSelectKeys(ch)) {
            if (this.getSelectDevice(oldKey) !== undefined) {
              await this.clearDeviceSelect(oldKey);
            }
          }
          this.setSelectDevice(selectSerial, displayName, undefined, 'switch');
        }
        continue;
      }

      // Pass raw channels — device mappers see real Homematic channel types.
      const results = mapper(rawDeviceChannels, this.matterbridge.aggregatorVendorId, mappingOptions);
      if (results.length === 0) continue;

      // Mark the device handled so the channel loop skips its channels entirely, regardless of
      // which individual endpoints are enabled below.
      deviceMapperHandled.add(deviceAddress);

      // Per-endpoint select and enabled checks: each endpoint produced by the mapper maps to a
      // single Homematic channel (channels[0]). Look up its resolved counterpart for display name
      // and enabled state so that individual outputs can be enabled/disabled independently.
      for (const { endpoint, channels: mappedChannels } of results) {
        const primaryMappedAddress = mappedChannels[0]?.address;
        const resolvedChannel = (primaryMappedAddress ? resolvedDeviceChannels.find((c) => c.address === primaryMappedAddress) : undefined) ?? primaryChannel;
        if (!resolvedChannel) continue;

        const displayName = this.getChannelDisplayName(resolvedChannel);
        const override = this.getChannelOverride(resolvedChannel.address);
        const selectSerial = this.getChannelSelectSerial(resolvedChannel);
        for (const oldKey of this.getLegacyChannelSelectKeys(resolvedChannel)) {
          if (this.getSelectDevice(oldKey) !== undefined) {
            await this.clearDeviceSelect(oldKey);
          }
        }
        this.setSelectDevice(selectSerial, displayName, undefined, 'switch');

        if (!this.isChannelEnabled(resolvedChannel, override, displayName)) {
          continue;
        }

        enabledCount++;
        await this.registerDevice(endpoint);
        registeredCount++;
        this.log.info(`Device mapper: channel=${resolvedChannel.address} name="${displayName}" deviceType=${deviceType} mapper=${this.getDeviceMapperKey(deviceType)}`);
        this.deviceAddressToDevice.set(deviceAddress, endpoint);
        for (const ch of mappedChannels) {
          await this.wireChannelEndpoint(endpoint, ch);
        }
      }
    }

    // Channel mapper loop: handles all channels not claimed by a device mapper.
    for (const channel of channels) {
      if (!isSupportedChannelType(channel.type)) continue;
      // Skip channels whose device was handled by the device mapper pre-pass.
      if (deviceMapperHandled.has(channel.deviceAddress)) continue;

      const displayName = this.getChannelDisplayName(channel);
      const override = this.getChannelOverride(channel.address);
      // Serial format: <interface>:<short-type>:<device>:<channel> — matches serialNumber in createEndpointForChannel.
      const selectSerial = this.getChannelSelectSerial(channel);
      for (const oldKey of this.getLegacyChannelSelectKeys(channel)) {
        if (this.getSelectDevice(oldKey) !== undefined) {
          await this.clearDeviceSelect(oldKey);
        }
      }

      this.setSelectDevice(selectSerial, displayName, undefined, 'switch');

      if (!this.isChannelEnabled(channel, override, displayName)) {
        continue;
      }

      enabledCount++;
      this.logChannelMapperSelection(channel, displayName);

      const endpoint = createEndpointForChannel(channel as Parameters<typeof createEndpointForChannel>[0], this.matterbridge.aggregatorVendorId, {
        switchMatterType: override?.switchMatterType ?? inferSwitchMatterTypeFromName(channel.name),
        batteryPowered: this.deviceBatteryHints.get(channel.deviceAddress) ?? channel.batteryPowered,
      });

      await this.registerDevice(endpoint);
      registeredCount++;
      this.deviceAddressToDevice.set(channel.deviceAddress, endpoint);
      await this.wireChannelEndpoint(endpoint, channel);
    }

    this.log.info(
      `Channel registration summary: enabled=${enabledCount} registered=${registeredCount} totalSupported=${channels.filter((c) => isSupportedChannelType(c.type)).length}`,
    );
  }

  /**
   * Wire Matter attribute subscriptions and RPC event routing for a single channel endpoint.
   *
   * Called once per channel in both the device mapper pre-pass and the channel mapper loop so that
   * all endpoints (regardless of how they were created) receive consistent wiring.
   *
   * @param {MatterbridgeEndpoint} endpoint The registered endpoint to wire.
   * @param {CcuChannelInfo} channel The Homematic channel this endpoint handles.
   */
  private async wireChannelEndpoint(endpoint: MatterbridgeEndpoint, channel: CcuChannelInfo): Promise<void> {
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
      // If a power meter channel was merged onto this SWITCH endpoint, register its address
      // in the appropriate event map so incoming RPC events update the merged endpoint.
      if (channel.powerMeterChannelAddress) {
        if (channel.powerMeterIsHmIP) {
          // ENERGIE_METER_TRANSMITTER: CURRENT reported in mA, handled by handleRpcEventEnergieMeter.
          this.energieMeterChannels.set(channel.powerMeterChannelAddress, endpoint);
        } else {
          // BidCos POWERMETER: CURRENT reported in A, handled by handleRpcEventPowerMeter.
          this.channelAddressToDevice.set(channel.powerMeterChannelAddress, endpoint);
        }
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

    // Wire Thermostat setpoint and mode for HEATING_CLIMATECONTROL_TRANSCEIVER/THERMALCONTROL_TRANSMIT channels.
    if ((channel.type === 'HEATING_CLIMATECONTROL_TRANSCEIVER' || channel.type === 'THERMALCONTROL_TRANSMIT') && this.ccuConnection) {
      const ccuConn = this.ccuConnection;
      this.channelAddressToDevice.set(channel.address, endpoint);
      // Track combined thermostat+humidity endpoint for humidity RPC event routing.
      if (channel.type === 'HEATING_CLIMATECONTROL_TRANSCEIVER' && endpoint.hasClusterServer('RelativeHumidityMeasurement')) {
        this.wthHumidityChannels.set(channel.address, endpoint);
        this.log.debug(`Registered combined thermostat+humidity endpoint for ${channel.address} (${channel.deviceType ?? 'unknown'})`);
      }
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
          // Remember last non-frost setpoint so mode switches can restore it.
          if (setpointDegC > 4.5) {
            this.thermostatLastSetpoint.set(address, setpointDegC);
          }
          this.log.debug(`Matter Thermostat setpoint -> Homematic: channel=${address} setpoint=${setpointDegC}`);
          ccuConn.setChannelDatapointValue(channel.interfaceName, address, 'SET_POINT_TEMPERATURE', setpointDegC).catch((err: unknown) => {
            this.log.warn(`Failed to set Homematic SET_POINT_TEMPERATURE for ${address}: ${String(err)}`);
          });
        });
      } catch (err) {
        this.log.warn(`Failed to subscribe Thermostat setpoint for ${channel.address}: ${String(err)}`);
      }
      // Subscribe to systemMode — Matter 0=Off maps to frost-protection setpoint (4.5°C) on the device;
      // Matter 4=Heat syncs the current occupiedHeatingSetpoint back to Homematic.
      // Both use putParamset with CONTROL_MODE=1 (manual) + SET_POINT_TEMPERATURE, which is the
      // only reliable way to change the setpoint on HmIP-eTRV-style devices.
      try {
        await endpoint.subscribeAttribute('Thermostat', 'systemMode', (value: number) => {
          const address = channel.address;
          const suppress = this.rpcEchoSuppress.get(address + ':thermMode');
          if (suppress !== undefined && suppress === value) {
            this.rpcEchoSuppress.delete(address + ':thermMode');
            return;
          }
          if (value === 0) {
            // systemMode=Off: switch to manual mode with frost-protection temperature.
            this.log.debug(`Matter Thermostat systemMode=Off -> Homematic: channel=${address} CONTROL_MODE=1 SET_POINT_TEMPERATURE=4.5`);
            ccuConn.putChannelParamsetValues(channel.interfaceName, address, { CONTROL_MODE: 1, SET_POINT_TEMPERATURE: 4.5 }).catch((err: unknown) => {
              this.log.warn(`Failed to set frost protection for ${address}: ${String(err)}`);
            });
          } else if (value === 4) {
            // systemMode=Heat: switch to manual mode and restore the last non-frost setpoint.
            const setpointDegC = this.thermostatLastSetpoint.get(address) ?? 21;
            this.log.debug(`Matter Thermostat systemMode=Heat -> Homematic: channel=${address} CONTROL_MODE=1 SET_POINT_TEMPERATURE=${setpointDegC}`);
            ccuConn.putChannelParamsetValues(channel.interfaceName, address, { CONTROL_MODE: 1, SET_POINT_TEMPERATURE: setpointDegC }).catch((err: unknown) => {
              this.log.warn(`Failed to set Homematic SET_POINT_TEMPERATURE on heat mode for ${address}: ${String(err)}`);
            });
          }
        });
      } catch (err) {
        this.log.warn(`Failed to subscribe Thermostat mode for ${channel.address}: ${String(err)}`);
      }
    }

    // Wire DoorLock commands for KEYMATIC channels.
    // Matter lockDoor → Homematic STATE=false (locked); unlockDoor → STATE=true (unlocked).
    if (channel.type === 'KEYMATIC' && this.ccuConnection) {
      const ccuConn = this.ccuConnection;
      this.channelAddressToDevice.set(channel.address, endpoint);
      this.keymaticState.set(channel.address, { state: false, uncertain: false, error: false, direction: 0 });
      endpoint.addCommandHandler('lockDoor', () => {
        this.log.debug(`Matter lockDoor -> Homematic STATE=false: channel=${channel.address}`);
        // Optimistically set direction=2 (closing) so that incoming STATE events (which still carry
        // the old value) cannot set lockState back to Unlocked before the real DIRECTION RPC event arrives.
        const flags = this.keymaticState.get(channel.address);
        if (flags) flags.direction = 2;
        // Signal NotFullyLocked immediately after the command transaction closes so the Home app
        // shows the "closing" animation without waiting for the first CCU RPC event (~800ms delay).
        setImmediate(() => {
          endpoint.updateAttribute('DoorLock', 'lockState', 0).catch((err: unknown) => {
            this.log.warn(`Failed to set NotFullyLocked on lockDoor for ${channel.address}: ${String(err)}`);
          });
        });
        ccuConn.setChannelDatapointValue(channel.interfaceName, channel.address, 'STATE', false).catch((err: unknown) => {
          this.log.warn(`Failed to set Homematic STATE for ${channel.address}: ${String(err)}`);
        });
      });
      endpoint.addCommandHandler('unlockDoor', () => {
        this.log.debug(`Matter unlockDoor -> Homematic STATE=true: channel=${channel.address}`);
        // Optimistically set direction=1 (opening) so that incoming STATE events (which still carry
        // the old value) cannot set lockState back to Locked before the real DIRECTION RPC event arrives.
        const flags = this.keymaticState.get(channel.address);
        if (flags) flags.direction = 1;
        // Signal NotFullyLocked immediately after the command transaction closes so the Home app
        // shows the "opening" animation without waiting for the first CCU RPC event (~800ms delay).
        setImmediate(() => {
          endpoint.updateAttribute('DoorLock', 'lockState', 0).catch((err: unknown) => {
            this.log.warn(`Failed to set NotFullyLocked on unlockDoor for ${channel.address}: ${String(err)}`);
          });
        });
        ccuConn.setChannelDatapointValue(channel.interfaceName, channel.address, 'STATE', true).catch((err: unknown) => {
          this.log.warn(`Failed to set Homematic STATE for ${channel.address}: ${String(err)}`);
        });
      });
    }

    // Track KEY / KEY_TRANSCEIVER channel address for inbound PRESS_SHORT / PRESS_LONG events.
    // These channels are receive-only: HM fires events, we forward them to Matter as switch events.
    if ((channel.type === 'KEY' || channel.type === 'KEY_TRANSCEIVER') && this.ccuConnection) {
      this.channelAddressToDevice.set(channel.address, endpoint);
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
          // Record the commanded target so that early LEVEL echos from the CCU (before DIRECTION/WORKING
          // arrives) only update currentPositionLiftPercent100ths and don't overwrite this target.
          this.blindCommandedTarget.set(address, value ?? 0);
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

  private async primeBatteryHintsFromRpc(channels: CcuChannelInfo[]): Promise<void> {
    if (!this.ccuConnection || channels.length === 0) return;

    const candidates = new Map<string, Exclude<CcuChannelInfo['interfaceName'], 'ReGaHSS'>>();
    for (const channel of channels) {
      if (channel.channelIndex !== 0) continue;
      const classifierType = channel.deviceType ?? channel.type;
      if (isAlwaysMainsPoweredDeviceType(classifierType)) {
        this.deviceBatteryHints.set(channel.deviceAddress, false);
        continue;
      }
      if (this.deviceBatteryHints.get(channel.deviceAddress) === true) continue;
      if (channel.interfaceName !== 'BidCos-RF' && channel.interfaceName !== 'HmIP-RF') continue;
      candidates.set(channel.deviceAddress, channel.interfaceName);
    }

    if (candidates.size === 0) return;

    let detectedCount = 0;
    let cacheHits = 0;
    await Promise.all(
      [...candidates.entries()].map(async ([deviceAddress, iface]) => {
        const address = `${deviceAddress}:0`;
        const rootChannel = channels.find((c) => c.deviceAddress === deviceAddress && c.channelIndex === 0);

        // Consult the paramset cache before making live RPC calls.
        const description = await this.getParamsetDescriptionCached(iface, address, rootChannel, (hit) => {
          if (hit) cacheHits++;
        });

        if (!description || !this.hasLowBatKey(description)) return;

        this.deviceBatteryHints.set(deviceAddress, true);
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
    if (cacheHits > 0) {
      this.log.debug(`Paramset cache: ${cacheHits}/${candidates.size} paramset descriptions served from cache`);
    }

    // Persist any newly learned overlay entries.
    await this.paramsetCache?.save();
  }

  /**
   * Retrieve a paramset description, consulting the cache first and falling back to live RPC.
   * Successful RPC results are written through to the cache overlay.
   *
   * @param {string} iface RPC interface name.
   * @param {string} address Full channel address (e.g. `'DEVICE:0'`).
   * @param {CcuChannelInfo | undefined} channelInfo Channel info used to build the cache key (optional).
   * @param {(hit: boolean) => void} [onCacheResult] Callback invoked with `true` on cache hit, `false` on miss.
   * @returns {Promise<Record<string, unknown> | undefined>} Paramset description, or `undefined` if unavailable.
   */
  private async getParamsetDescriptionCached(
    iface: 'BidCos-RF' | 'BidCos-Wired' | 'HmIP-RF' | 'VirtualDevices' | 'CUxD',
    address: string,
    channelInfo: CcuChannelInfo | undefined,
    onCacheResult?: (hit: boolean) => void,
  ): Promise<Record<string, unknown> | undefined> {
    for (const paramsetKey of ['VALUES', 'MASTER'] as const) {
      const cacheKey = buildParamsetKey(iface, channelInfo?.deviceType, channelInfo?.deviceFirmware, channelInfo?.deviceVersion, channelInfo?.type ?? '', paramsetKey);

      // 1. Try cache.
      if (this.paramsetCache && channelInfo?.deviceType) {
        const cached = this.paramsetCache.lookup(iface, channelInfo.deviceType, channelInfo.deviceFirmware, channelInfo.deviceVersion, channelInfo.type, paramsetKey);
        if (cached) {
          onCacheResult?.(true);
          return cached;
        }
      }

      // 2. Live RPC.
      this.log.info(`getParamsetDescription <- address=${address} key=${cacheKey ?? 'n/a'} MISS (live RPC)`);
      const result = await this.getParamsetDescriptionSafe(iface, address, paramsetKey);
      onCacheResult?.(false);

      if (!result) continue;

      // 3. Write-through: store successful RPC result in overlay.
      if (this.paramsetCache && channelInfo?.deviceType) {
        this.paramsetCache.store(iface, channelInfo.deviceType, channelInfo.deviceFirmware, channelInfo.deviceVersion, channelInfo.type, paramsetKey, result);
      }

      return result;
    }

    return undefined;
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

  private async handleRpcEventAvailability(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    if (event.datapoint !== 'UNREACH') return;

    const deviceAddress = this.extractDeviceAddressFromRpcChannel(event.channel);
    const isDeviceLevelEvent = deviceAddress !== undefined || event.channel === 0;
    if (!isDeviceLevelEvent) return;

    const unreachValue = event.value === true;
    const reachable = !unreachValue;

    if (deviceAddress) {
      const device = this.deviceAddressToDevice.get(deviceAddress);
      if (!device) return;
      this.log.debug(`UNREACH event: iface=${String(event.iface ?? 'unknown')} device=${deviceAddress} reachable=${reachable}`);
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
          // Movement is done: clear the commanded target so applyBlindLevel updates both current and target.
          this.blindCommandedTarget.delete(channelAddress);
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
    // For WTH/STHD devices the HUMIDITY datapoint arrives on a HEATING_CLIMATECONTROL_TRANSCEIVER
    // channel address; route it to the dedicated humiditySensor endpoint when available.
    const humidityEndpoint = this.wthHumidityChannels.get(channelAddress) ?? endpoint;
    if (!humidityEndpoint.hasClusterServer('RelativeHumidityMeasurement')) return;
    // Matter RelativeHumidityMeasurement.measuredValue is in units of 0.01%.
    const measuredValue = Math.round((typeof event.value === 'number' ? event.value : 0) * 100);
    try {
      const current = await humidityEndpoint.getAttribute('RelativeHumidityMeasurement', 'measuredValue');
      if (current !== measuredValue) {
        await humidityEndpoint.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', measuredValue);
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
   * Handle incoming RPC event for ENERGIE_METER_TRANSMITTER (HmIP) channel datapoints.
   * Maps POWER (W), CURRENT (mA), and VOLTAGE (V) to Matter ElectricalPowerMeasurement cluster attributes.
   * Unlike BidCos POWERMETER, HmIP reports CURRENT already in milliamps — no ×1000 conversion for that field.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name ('POWER', 'CURRENT', or 'VOLTAGE').
   * @param {unknown} [event.value] Datapoint value (float).
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventEnergieMeter(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'POWER' && datapoint !== 'CURRENT' && datapoint !== 'VOLTAGE') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.energieMeterChannels.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('ElectricalPowerMeasurement')) return;

    const raw = typeof event.value === 'number' ? event.value : 0;

    // ElectricalPowerMeasurement uses milliwatts/milliamps/millivolts.
    // POWER (W) → milliwatts: raw * 1000
    // CURRENT (mA) → milliamps: raw * 1 (HmIP already reports in mA, unlike BidCos which uses A)
    // VOLTAGE (V) → millivolts: raw * 1000
    const attrMap: Record<string, string> = { POWER: 'activePower', CURRENT: 'activeCurrent', VOLTAGE: 'voltage' };
    const attr = attrMap[datapoint];
    if (!attr) return;

    const milliValue = datapoint === 'CURRENT' ? Math.round(raw) : Math.round(raw * 1000);
    try {
      const current = await endpoint.getAttribute('ElectricalPowerMeasurement', attr);
      if (current !== milliValue) {
        await endpoint.updateAttribute('ElectricalPowerMeasurement', attr, milliValue);
        this.log.info(`ENERGIE_METER_TRANSMITTER ${datapoint} event: updated ${attr} for ${channelAddress} to ${milliValue} (${raw} raw)`);
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
   * Handle incoming RPC event for KEYMATIC channel datapoints.
   * Maps STATE, STATE_UNCERTAIN, ERROR, and DIRECTION to Matter DoorLock.lockState.
   * NotFullyLocked=0 while motor is running (DIRECTION≠0) or on error/uncertainty; Unlocked=2 (STATE=true, stopped); Locked=1 (STATE=false, stopped).
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name ('STATE', 'STATE_UNCERTAIN', or 'ERROR').
   * @param {unknown} [event.value] Datapoint value.
   * @returns {Promise<void>} Resolves when the Matter attribute has been updated.
   */
  private async handleRpcEventKeymatic(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'STATE' && datapoint !== 'STATE_UNCERTAIN' && datapoint !== 'ERROR' && datapoint !== 'DIRECTION') return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('DoorLock')) return;

    const flags = this.keymaticState.get(channelAddress) ?? { state: false, uncertain: false, error: false, direction: 0 };

    if (datapoint === 'STATE') flags.state = event.value === true || event.value === 1 || event.value === '1';
    if (datapoint === 'STATE_UNCERTAIN') flags.uncertain = event.value === true || event.value === 1 || event.value === '1';
    if (datapoint === 'ERROR') flags.error = typeof event.value === 'number' ? event.value !== 0 : Boolean(event.value);
    // DIRECTION: 0=stopped, 1=opening/unlocking, 2=closing/locking.
    if (datapoint === 'DIRECTION') flags.direction = typeof event.value === 'number' ? event.value : 0;

    this.keymaticState.set(channelAddress, flags);

    // Motor moving (DIRECTION≠0), uncertain, or error → NotFullyLocked=0; else Unlocked=2 or Locked=1.
    const lockState = flags.error || flags.uncertain || flags.direction !== 0 ? 0 : flags.state ? 2 : 1;

    try {
      const current = await endpoint.getAttribute('DoorLock', 'lockState');
      if (current !== lockState) {
        await endpoint.updateAttribute('DoorLock', 'lockState', lockState);
        this.log.info(
          `KEYMATIC ${datapoint} event: updated lockState for ${channelAddress} to ${lockState} (state=${flags.state} uncertain=${flags.uncertain} error=${flags.error} direction=${flags.direction})`,
        );
      }
    } catch (err) {
      this.log.warn(`Failed to update DoorLock lockState for ${channelAddress}: ${String(err)}`);
    }
  }

  /**
   * Handle incoming RPC event for KEY / KEY_TRANSCEIVER channel datapoints.
   * Forwards PRESS_SHORT as a Matter 'Single' switch event and PRESS_LONG as a 'Long' switch event.
   * The channel emits only events; no persistent state is stored.
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name ('PRESS_SHORT', 'PRESS_LONG').
   * @param {unknown} [event.value] Datapoint value (boolean true = press fired).
   * @returns {Promise<void>} Resolves when the Matter switch event has been triggered.
   */
  private async handleRpcEventKey(event: { iface?: string; idInit?: string; channel?: unknown; datapoint?: string; value?: unknown }): Promise<void> {
    const datapoint = typeof event.datapoint === 'string' ? event.datapoint.trim().toUpperCase() : '';
    if (datapoint !== 'PRESS_SHORT' && datapoint !== 'PRESS_LONG') return;

    // Homematic fires PRESS_SHORT/PRESS_LONG with value=true on press; ignore value=false echoes.
    if (!(event.value === true || event.value === 1 || event.value === '1')) return;

    const channelAddress = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelAddress) return;

    const endpoint = this.channelAddressToDevice.get(channelAddress);
    if (!endpoint) return;
    if (!endpoint.hasClusterServer('Switch')) return;

    const switchEvent = datapoint === 'PRESS_SHORT' ? 'Single' : 'Long';
    try {
      await endpoint.triggerSwitchEvent(switchEvent, this.log);
      this.log.info(`KEY ${datapoint} event: triggered Matter switch '${switchEvent}' for ${channelAddress}`);
    } catch (err) {
      this.log.warn(`Failed to trigger switch event for ${channelAddress}: ${String(err)}`);
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
   * Handle incoming RPC event for the BLIND channel ACTIVITY_STATE (HmIP) or DIRECTION (BidCos) datapoint.
   * Drives the dimmerWorking flag to suppress intermediate LEVEL events during movement
   * (same role as WORKING for dimmer/BidCos-blind channels).
   * When movement stops, applies the last known LEVEL using the same logic as handleRpcEventDimmerWorking.
   *
   * ACTIVITY_STATE: 0=inactive, 1=opening, 2=closing, 3=idle/stopped (common HmIP stopped signal).
   * DIRECTION:      0=stopped, 1=UP/opening, 2=DOWN/closing, 3=UNDEFINED (direction unknown, motor may still run).
   *
   * @param {object} event RPC event payload.
   * @param {string} [event.iface] RPC interface name.
   * @param {string} [event.idInit] Device init ID.
   * @param {unknown} [event.channel] Channel address string.
   * @param {string} [event.datapoint] Datapoint name ('ACTIVITY_STATE' or 'DIRECTION').
   * @param {unknown} [event.value] Datapoint value (integer).
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

    // ACTIVITY_STATE: 0=inactive, 1=opening, 2=closing, 3=idle/stopped (common HmIP "stopped" signal).
    // DIRECTION:      0=stopped, 1=UP, 2=DOWN, 3=UNDEFINED (direction unknown, motor may still run).
    // For ACTIVITY_STATE, value=3 means the motor is idle and should be treated as stopped.
    // For DIRECTION, value=3 means the direction is unknown but the motor may still run — leave dimmerWorking.
    const value = typeof event.value === 'number' ? event.value : 0;
    const isMoving = value === 1 || value === 2;
    const isStopped = value === 0 || (value === 3 && datapoint === 'ACTIVITY_STATE');
    const status = value === 1 ? 1 : value === 2 ? 2 : 0;

    if (isMoving) {
      // Mark channel as moving so that intermediate LEVEL events are suppressed (same as WORKING=true).
      this.dimmerWorking.set(channelAddress, true);
      this.log.debug(`BLIND ${datapoint}=${value} (moving): suppressing LEVEL updates for ${channelAddress}`);
    } else if (isStopped) {
      // Motor has stopped: clear the movement flag and apply the final position.
      // Only trigger level application if we were the ones who set the moving flag
      // (i.e. the flag is still set — WORKING=false may have already cleared it for BidCos).
      const wasMoving = this.dimmerWorking.get(channelAddress) === true;
      this.dimmerWorking.delete(channelAddress);
      this.log.debug(`BLIND ${datapoint}=0 (stopped): wasMoving=${wasMoving} for ${channelAddress}`);

      if (wasMoving) {
        // Movement is done: clear the commanded target so applyBlindLevel updates both current and target.
        this.blindCommandedTarget.delete(channelAddress);
        const last = this.dimmerLastLevel.get(channelAddress);
        const age = last !== undefined ? Date.now() - last.time : Infinity;
        if (last !== undefined && age < 500) {
          this.log.debug(`BLIND ${datapoint}=0: applying last known level=${last.level} age=${age}ms for ${channelAddress}`);
          await this.applyBlindLevel(channelAddress, endpoint, last.level);
        } else {
          this.log.debug(`BLIND ${datapoint}=0: awaiting next LEVEL (last age=${age === Infinity ? 'none' : `${age}ms`}) for ${channelAddress}`);
          this.dimmerAwaitingFinalLevel.add(channelAddress);
        }
      }
    }
    // value === 3 (DIRECTION=UNDEFINED): update UI status only, do not touch dimmerWorking.

    try {
      await endpoint.setWindowCoveringStatus(status);
      this.log.debug(`BLIND ${datapoint} event: operationalStatus=${status} for ${channelAddress}`);
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
      if (this.blindCommandedTarget.has(channelAddress)) {
        // A Matter command is in flight (DIRECTION/WORKING not yet received). Only update the current
        // position so the Home app sees the blind starting to move; preserve the commanded target.
        await endpoint.updateAttribute('WindowCovering', 'currentPositionLiftPercent100ths', position);
        this.log.info(`BLIND LEVEL event: updated currentPosition for ${channelAddress} to ${position}/10000 (hmLevel=${hmLevel}, target preserved)`);
      } else {
        // No command in flight: update both current and target (normal status update or final position).
        // Suppress the echo that subscribeAttribute on targetPositionLiftPercent100ths would send back.
        this.rpcEchoSuppress.set(channelAddress + ':blindTarget', position);
        await endpoint.setWindowCoveringTargetAndCurrentPosition(position);
        this.log.info(`BLIND LEVEL event: updated WindowCovering for ${channelAddress} to ${position}/10000 (hmLevel=${hmLevel})`);
      }
    } catch (err) {
      this.rpcEchoSuppress.delete(channelAddress + ':blindTarget');
      this.log.warn(`Failed to update Matter WindowCovering for ${channelAddress}: ${String(err)}`);
    }
  }

  private async applyInitialValuesFromRega(): Promise<void> {
    if (!this.getPlatformConfig().initialValuesFromRega) return;
    if (!this.ccuConnection) return;

    this.log.info('Fetching initial device state from ReGa...');

    const datapoints = await this.ccuConnection.fetchInitialValues();
    if (datapoints.length === 0) {
      this.log.info('ReGa initial values: no datapoints returned (ReGa may be disabled or not connected).');
      return;
    }

    let applied = 0;

    for (const { iface, channel, datapoint, value, uncertain } of datapoints) {
      if (uncertain) continue;

      const event = { iface, channel, datapoint, value };

      await this.handleRpcEventSwitchState(event);
      await this.handleRpcEventContactState(event);
      await this.handleRpcEventDimmerLevel(event);
      await this.handleRpcEventBlindLevel(event);
      await this.handleRpcEventBlindTilt(event);
      await this.handleRpcEventMotion(event);
      await this.handleRpcEventIlluminance(event);
      await this.handleRpcEventTemperatureHumidity(event);
      await this.handleRpcEventSmoke(event);
      await this.handleRpcEventAlarmState(event);
      await this.handleRpcEventRotaryHandle(event);
      await this.handleRpcEventPowerMeter(event);
      await this.handleRpcEventThermostat(event);
      await this.handleRpcEventKeymatic(event);

      applied++;
    }

    this.log.info(`ReGa initial values applied: ${applied} datapoints processed (${datapoints.length} total, ${datapoints.length - applied} uncertain/skipped).`);
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
        this.setSelectDevice(
          `${updatedChannel.interfaceName}:${isSupportedChannelType(updatedChannel.type) ? channelTypeLabel(updatedChannel.type) : updatedChannel.type}:${channelAddress}`,
          newName,
          undefined,
          'switch',
        );
      }
    }
  }

  private async cleanupDisabledInterfaceChannels(
    channels: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'name' | 'type'>[],
    enabledInterfaces: readonly CcuInterfaceName[],
  ): Promise<void> {
    const enabledInterfaceSet = new Set(enabledInterfaces);
    const disabledInterfacePrefixes = this.getDisabledInterfacePrefixes(enabledInterfaceSet);
    const blacklistEntriesToRemove = new Set<string>();
    let removedSelectDevices = 0;

    for (const selectDevice of this.getSelectDevices()) {
      if (!disabledInterfacePrefixes.some((prefix) => selectDevice.serial.startsWith(prefix))) continue;
      await this.clearDeviceSelect(selectDevice.serial);
      removedSelectDevices++;
    }

    const config = this.getPlatformConfig();
    const currentBlackList = Array.isArray(config.blackList) ? config.blackList : [];
    for (const entry of currentBlackList) {
      if (typeof entry !== 'string') continue;
      if (disabledInterfacePrefixes.some((prefix) => entry.startsWith(prefix))) {
        blacklistEntriesToRemove.add(entry);
      }
    }

    for (const channel of channels) {
      if (enabledInterfaceSet.has(channel.interfaceName)) continue;

      const removalKeys = [this.getChannelSelectSerial(channel), ...this.getLegacyChannelSelectKeys(channel)];
      for (const key of removalKeys) {
        if (this.getSelectDevice(key) === undefined) continue;
        await this.clearDeviceSelect(key);
        removedSelectDevices++;
      }

      blacklistEntriesToRemove.add(this.getChannelSelectSerial(channel));
      blacklistEntriesToRemove.add(channel.address);
      const regaName = channel.name?.trim();
      if (regaName) {
        blacklistEntriesToRemove.add(regaName);
      }
      for (const legacyKey of this.getLegacyChannelSelectKeys(channel)) {
        blacklistEntriesToRemove.add(legacyKey);
      }
    }

    const nextBlackList = currentBlackList.filter((entry): entry is string => typeof entry === 'string' && !blacklistEntriesToRemove.has(entry));
    const removedBlacklistEntries = currentBlackList.length - nextBlackList.length;

    if (removedBlacklistEntries > 0) {
      config.blackList = nextBlackList;
      this.saveConfig(config);
    }

    if (removedSelectDevices > 0 || removedBlacklistEntries > 0) {
      this.log.info(`Disabled interface cleanup summary: removedSelectDevices=${removedSelectDevices} removedBlacklistEntries=${removedBlacklistEntries}`);
    }
  }

  private syncChannelListEntriesWithRegaNames(channels: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'name'>[], enabledInterfaces?: readonly CcuInterfaceName[]): void {
    const enabledInterfaceSet = enabledInterfaces ? new Set(enabledInterfaces) : undefined;
    const channelMap = new Map<string, Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'name'>>();
    for (const channel of channels) {
      channelMap.set(channel.address, channel);
    }

    let changed = false;
    let migrated = 0;
    let skippedNoName = 0;
    let skippedDisabledInterface = 0;

    for (const listKey of ['whiteList', 'blackList'] as const) {
      const entries = this.getPlatformConfig()[listKey];
      if (!Array.isArray(entries)) continue;

      for (const entry of entries) {
        if (typeof entry !== 'string' || !entry.includes(':')) continue;

        const channel = channelMap.get(entry);
        if (!channel) continue;

        if (enabledInterfaceSet && !enabledInterfaceSet.has(channel.interfaceName)) {
          skippedDisabledInterface++;
          continue;
        }

        const regaName = channel.name?.trim();
        if (!regaName || regaName === channel.address) {
          skippedNoName++;
          continue;
        }

        if (this.migrateChannelListEntry(listKey, channel.address, regaName)) {
          changed = true;
          migrated++;
        }
      }
    }

    if (migrated > 0 || skippedNoName > 0 || skippedDisabledInterface > 0) {
      this.log.info(`ReGa list sync summary: migrated=${migrated} skippedNoName=${skippedNoName} skippedDisabledInterface=${skippedDisabledInterface}`);
    }

    if (changed) {
      this.saveConfig(this.getPlatformConfig());
    }
  }

  private migrateChannelListEntry(listKey: 'whiteList' | 'blackList', channelAddress: string, regaName: string): boolean {
    const config = this.getPlatformConfig();
    const currentEntries = config[listKey];

    if (!Array.isArray(currentEntries) || !currentEntries.includes(channelAddress)) {
      return false;
    }

    const nextEntries = currentEntries.filter((entry): entry is string => typeof entry === 'string' && entry !== channelAddress);
    if (!nextEntries.includes(regaName)) {
      nextEntries.push(regaName);
    }

    config[listKey] = nextEntries;
    this.log.info(`Migrated ${listKey} entry from ${channelAddress} to ${regaName}`);
    return true;
  }

  private getChannelSelectSerial(channel: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'type'>): string {
    const typeLabel = isSupportedChannelType(channel.type) ? channelTypeLabel(channel.type) : channel.type;
    return `${channel.interfaceName}:${typeLabel}:${channel.address}`;
  }

  private getLegacyChannelSelectKeys(channel: Pick<CcuChannelInfo, 'address' | 'interfaceName' | 'type'>): string[] {
    const selectSerial = this.getChannelSelectSerial(channel);
    const typeLabel = isSupportedChannelType(channel.type) ? channelTypeLabel(channel.type) : channel.type;
    return [
      channel.address.replace(':', '-'),
      channel.address,
      `${channel.type}:${channel.address}`,
      `${typeLabel}:${channel.address}`,
      `${channel.interfaceName}:${channel.type}:${channel.address}`,
    ].filter((key) => key !== selectSerial);
  }

  private getDisabledInterfacePrefixes(enabledInterfaceSet: ReadonlySet<CcuInterfaceName>): string[] {
    const interfaces: Exclude<CcuInterfaceName, 'ReGaHSS'>[] = ['BidCos-RF', 'BidCos-Wired', 'HmIP-RF', 'VirtualDevices', 'CUxD'];
    return interfaces.filter((iface) => !enabledInterfaceSet.has(iface)).map((iface) => `${iface}:`);
  }

  private logChannelMapperSelection(channel: Pick<CcuChannelInfo, 'address' | 'name' | 'type'>, displayName: string): void {
    this.log.info(`Channel mapper: channel=${channel.address} name="${displayName}" type=${channel.type} mapper=${this.getChannelMapperKey(channel.type)}`);
  }

  private getChannelMapperKey(channelType: string): string {
    return channelType.toLowerCase().replace(/_/g, '-');
  }

  private getDeviceMapperKey(deviceType: string): string {
    return deviceType
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
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
    const candidates = [this.getChannelSelectSerial(channel), channel.address, channel.name?.trim(), displayName].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return this.validateDevice(candidates, false);
  }

  private getChannelDisplayName(channel: CcuChannelInfo): string {
    const regaName = channel.name?.trim();
    if (regaName && regaName.length > 0) return regaName;
    return channel.address;
  }
}
