/**
 * Registry of channel-type mappers.
 *
 * Keys are the sanitized (lowercase, underscores→hyphens) Homematic channel type names so lookup
 * is case-insensitive and consistent with the file names in this directory.
 *
 * @file channel-mapper/index.ts
 */

import { ChannelMapper, MapperOptionDescriptor, SupportedChannelType } from '../types.js';
import { mapChannel as alarmstate } from './alarmstate.js';
import { mapChannel as blind } from './blind.js';
import { mapChannel as climatecontrolRtTransceiver, OPTIONS as climatecontrolRtTransceiverOptions } from './climatecontrol-rt-transceiver.js';
import { mapChannel as dimmer } from './dimmer.js';
import { mapChannel as heatingClimatecontrolTransceiver, OPTIONS as heatingClimatecontrolTransceiverOptions } from './heating-climatecontrol-transceiver.js';
import { mapChannel as key } from './key.js';
import { mapChannel as keyTransceiver } from './key-transceiver.js';
import { mapChannel as keymatic } from './keymatic.js';
import { mapChannel as motionDetector, OPTIONS as motionDetectorOptions } from './motion-detector.js';
import { mapChannel as rotaryHandleSensor } from './rotary-handle-sensor.js';
import { mapChannel as rotaryHandleTransceiver } from './rotary-handle-transceiver.js';
import { mapChannel as shutterContact } from './shutter-contact.js';
import { mapChannel as smokeDetector } from './smoke-detector.js';
import { mapChannel as switchMapper, OPTIONS as switchOptions } from './switch.js';
import { mapChannel as temperatureHumidityTransmitter } from './temperature-humidity-transmitter.js';
import { mapChannel as thermalcontrolTransmit } from './thermalcontrol-transmit.js';
import { mapChannel as weather } from './weather.js';

/**
 * Map from sanitized channel type key to its `ChannelMapper` function.
 *
 * Sanitization: `channelType.toLowerCase().replace(/_/g, '-')`.
 * For example `'SHUTTER_CONTACT'` → `'shutter-contact'`.
 */
export const CHANNEL_MAPPERS: Record<string, ChannelMapper> = {
  alarmstate,
  blind,
  'climatecontrol-rt-transceiver': climatecontrolRtTransceiver,
  dimmer,
  'heating-climatecontrol-transceiver': heatingClimatecontrolTransceiver,
  key,
  'key-transceiver': keyTransceiver,
  keymatic,
  'motion-detector': motionDetector,
  'rotary-handle-sensor': rotaryHandleSensor,
  'rotary-handle-transceiver': rotaryHandleTransceiver,
  'shutter-contact': shutterContact,
  'smoke-detector': smokeDetector,
  'switch': switchMapper,
  'temperature-humidity-transmitter': temperatureHumidityTransmitter,
  'thermalcontrol-transmit': thermalcontrolTransmit,
  weather,
};

/**
 * Compute the registry lookup key for a raw Homematic channel type string.
 *
 * @param {string} channelType Raw channel type, e.g. `'SHUTTER_CONTACT'`.
 * @returns {string} Sanitized key, e.g. `'shutter-contact'`.
 */
export function channelTypeToKey(channelType: string): string {
  return channelType.toLowerCase().replace(/_/g, '-');
}

/**
 * Aggregated option descriptors per channel type key, sourced from each mapper file.
 * Only mappers that export `OPTIONS` need an entry here.
 */
export const CHANNEL_MAPPER_OPTIONS: Readonly<Record<string, readonly MapperOptionDescriptor[]>> = {
  'motion-detector': motionDetectorOptions,
  'switch': switchOptions,
  'heating-climatecontrol-transceiver': heatingClimatecontrolTransceiverOptions,
  'climatecontrol-rt-transceiver': climatecontrolRtTransceiverOptions,
};

/**
 * Return the configurable option descriptors for a supported channel type.
 *
 * @param {SupportedChannelType} type Supported channel type.
 * @returns {readonly MapperOptionDescriptor[]} Option descriptors (empty when the mapper has none).
 */
export function getChannelMapperOptions(type: SupportedChannelType): readonly MapperOptionDescriptor[] {
  return CHANNEL_MAPPER_OPTIONS[channelTypeToKey(type)] ?? [];
}
