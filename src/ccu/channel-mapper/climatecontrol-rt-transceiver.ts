/**
 * Channel mapper for Homematic CLIMATECONTROL_RT_TRANSCEIVER channels → Matter thermostatDevice.
 *
 * Used by HM-CC-RT-DN (BidCos-RF radiator thermostat) and HM-CC-VG-1 (virtual group thermostat)
 * when processed via the channel mapper loop (i.e. when no device mapper owns the device).
 * The HM-CC-VG-1 is normally handled by the dedicated device mapper; this mapper serves as a
 * fallback for any CLIMATECONTROL_RT_TRANSCEIVER channel not claimed by a device mapper.
 *
 * Datapoints of interest on this channel type:
 * - ACTUAL_TEMPERATURE  float  read+event  — measured temperature (°C)
 * - SET_TEMPERATURE     float  read+write+event — current setpoint (°C)
 * - MANU_MODE           float  write-only — write to switch to manual mode and set setpoint (°C)
 *
 * Wiring: `wireChannelEndpoint` detects CLIMATECONTROL_RT_TRANSCEIVER and uses MANU_MODE for
 * outgoing setpoint writes. Incoming SET_TEMPERATURE events are accepted by handleRpcEventThermostat.
 *
 * @file channel-mapper/climatecontrol-rt-transceiver.ts
 */

import { MatterbridgeEndpoint, thermostatDevice } from 'matterbridge';

import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

/**
 * Map a Homematic CLIMATECONTROL_RT_TRANSCEIVER channel to a Matter thermostatDevice endpoint.
 *
 * @type {ChannelMapper}
 */
export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  const displayName = buildDisplayName(channel);
  const serialNumber = buildSerialNumber(channel, 'CLIMATECONTROL_RT_TRANSCEIVER');
  const model = buildModel(channel);

  return finalizeEndpoint(
    new MatterbridgeEndpoint(thermostatDevice, { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(displayName, serialNumber, vendorId, 'Homematic', model)
      // localTemperature=23°C, occupiedHeatingSetpoint=21°C as defaults; updated from RPC on startup.
      .createDefaultHeatingThermostatClusterServer(23, 21),
    { ...options, batteryPowered: channel.batteryPowered },
  );
};
