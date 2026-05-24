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

import { MatterbridgeDynamicPlatform, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { parseCcuConnectionConfig } from './ccu/config.js';
import { CcuConnectionLayer } from './ccu/connection-layer.js';
import { createEndpointForChannel, isSupportedChannelType } from './ccu/device-mapper.js';

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

// Here we define the TemplatePlatform class, which extends the MatterbridgeDynamicPlatform.
// If you want to create an Accessory platform plugin, you should extend the MatterbridgeAccessoryPlatform class instead.
export class TemplatePlatform extends MatterbridgeDynamicPlatform {
  private ccuConnection?: CcuConnectionLayer;

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
    this.ccuConnection = new CcuConnectionLayer(ccuConfig, this.log);
    await this.ccuConnection.start();

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
    this.log.info(`Discovered ${channels.length} channels from CCU.`);

    for (const channel of channels) {
      if (!isSupportedChannelType(channel.type)) continue;

      const displayName = channel.name ?? channel.address;
      const endpoint = createEndpointForChannel(
        channel as Parameters<typeof createEndpointForChannel>[0],
        this.matterbridge.aggregatorVendorId,
      );

      this.setSelectDevice(channel.address, displayName);
      const selected = this.validateDevice([displayName, channel.address]);
      if (selected) await this.registerDevice(endpoint);
    }
  }
}
