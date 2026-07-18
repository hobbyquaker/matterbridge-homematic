/**
 * Channel mapper for Homematic SWITCH channels → Matter onOffLight / onOffPlugInUnit / onOffLightSwitch.
 * The Matter device type is selected via `options.switchMatterType`; defaults to `'light'`.
 *
 * @file channel-mapper/switch.ts
 */

import { fan, MatterbridgeEndpoint, onOffLight, onOffLightSwitch, onOffPlugInUnit } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper, MapperOptionDescriptor } from '../types.js';

/**
 * User-configurable options declared by this mapper.
 * `switchMatterType` selects the Matter device type the SWITCH channel is exposed as.
 */
export const OPTIONS: readonly MapperOptionDescriptor[] = [{ key: 'switchMatterType', type: 'enum', values: ['light', 'outlet', 'switch', 'fan'] }];

/**
 * Map a Homematic SWITCH channel to a Matter on/off endpoint.
 * Also adds an ElectricalPowerMeasurement cluster when a co-located power meter channel exists.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'SWITCH');
  const model = buildModel(channel);

  let ep: MatterbridgeEndpoint;
  switch (options.switchMatterType ?? 'light') {
    case 'outlet':
      ep = new MatterbridgeEndpoint(onOffPlugInUnit, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model);
      break;
    case 'switch':
      ep = new MatterbridgeEndpoint(onOffLightSwitch, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model);
      break;
    case 'fan':
      ep = new MatterbridgeEndpoint(fan, { id })
        .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
        .createOnOffFanControlClusterServer();
      break;
    case 'light':
    default:
      ep = new MatterbridgeEndpoint(onOffLight, { id }).createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model);
      break;
  }

  if (channel.powerMeterChannelAddress && options.exposePowerMeter === true) {
    // A co-located power meter channel is merged onto this endpoint.
    ep.createDefaultElectricalPowerMeasurementClusterServer();
  }

  return finalizeEndpoint(ep, { ...options, batteryPowered: channel.batteryPowered });
};
