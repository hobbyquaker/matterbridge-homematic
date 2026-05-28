/**
 * Device mapper for HmIP-STHD and HmIP-STH wall thermostats / temperature sensors.
 *
 * Same logic as HmIP-WTH: the HEATING_CLIMATECONTROL_TRANSCEIVER channel carries HUMIDITY
 * in addition to temperature and setpoint data, so we expose a dedicated humiditySensor
 * endpoint alongside the standard thermostatDevice endpoint.
 *
 * @file device-mapper/hmip-sthd.ts
 */

export { mapDevice } from './hmip-wth.js';
