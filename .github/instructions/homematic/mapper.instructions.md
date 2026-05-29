---
name: 'Homematic Mapper Development Guide'
description: 'How to write channel mappers and device mappers for the matterbridge-homematic plugin. Architecture reference for humans and coding agents.'
applyTo: 'src/ccu/channel-mapper/**, src/ccu/device-mapper/**, src/ccu/types.ts, src/ccu/device-mapper.ts, vitest/mapper.test.ts'
---

# Homematic Mapper Development Guide

This guide explains the two-level mapper system used by the plugin and tells you how to extend it — whether you need to add support for a new channel type, a new device type, or a complex multi-endpoint device.

---

## Architecture overview

The plugin converts Homematic channels to Matter endpoints through two distinct layers:

```text
Homematic CCU channels
    ↓ resolveChannelsForMatter()   (device-mapper.ts)
Resolved channels (HmIP virtual-receiver pairing, power meter merging)
    ↓
Device mapper pre-pass             (module.ts · discoverDevices)
  → handles devices with registered device mappers
  → those devices are entirely skipped by the channel loop
    ↓
Channel mapper loop                (module.ts · discoverDevices)
  → handles every remaining channel
    ↓
wireChannelEndpoint()              (module.ts)
  → subscribes Matter attributes → writes Homematic datapoints
  → maps channel addresses for inbound RPC event routing
    ↓
Matter endpoints registered in Matterbridge
```

### Channel mappers

A **channel mapper** converts one resolved Homematic channel to one `MatterbridgeEndpoint`. It lives in `src/ccu/channel-mapper/<type>.ts` and is registered in `src/ccu/channel-mapper/index.ts`.

```text
SWITCH channel → one onOffLight / outlet / switch endpoint
BLIND channel  → one windowCovering endpoint
DIMMER channel → one dimmableLight endpoint
```

### Device mappers

A **device mapper** receives ALL resolved channels for one physical Homematic device and returns zero or more `MappedDeviceEndpoint` instances — each pairing a `MatterbridgeEndpoint` with the channels it handles.

Device mappers **always run before** the channel loop. A device whose type is registered in `DEVICE_MAPPERS` is never touched by the channel loop.

Use a device mapper when:

- The default channel-type mapping is wrong for a specific device model.
- You want to combine multiple channels into one endpoint (e.g. thermostat + humidity).
- You want to split a multi-channel device into separate endpoints per zone/output.
- You need to force a device-level property (e.g. override `batteryPowered`).
- A device mapper may call channel mapper functions internally to reuse standard endpoint creation.

---

## Channel mapper contract

### Signature

```ts
// src/ccu/types.ts
export type ChannelMapper = (
  channel: CcuChannelInfo,
  vendorId: number,
  options: ChannelMappingOptions,
) => MatterbridgeEndpoint;
```

### File layout

```text
src/ccu/channel-mapper/<type-key>.ts   e.g. switch.ts, blind.ts
```

The file exports `mapChannel: ChannelMapper`.

### Registration

Add the type key to `CHANNEL_MAPPERS` in `src/ccu/channel-mapper/index.ts` **and** add the channel type string to `SUPPORTED_CHANNEL_TYPES` in `src/ccu/types.ts`.

`channelTypeToKey` converts `SHUTTER_CONTACT` → `shutter-contact`. Use that as the key.

### Example: minimal channel mapper

```ts
// src/ccu/channel-mapper/my-sensor.ts
import { contactSensor, powerSource } from 'matterbridge';
import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { ChannelMapper } from '../types.js';

export const mapChannel: ChannelMapper = (channel, vendorId, options) => {
  const id = buildEndpointId(channel);
  return finalizeEndpoint(
    new MatterbridgeEndpoint([contactSensor, powerSource], { id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        buildDisplayName(channel),
        buildSerialNumber(channel, 'MY_SENSOR'),
        vendorId,
        'Homematic',
        buildModel(channel),
      )
      .createDefaultBooleanStateClusterServer(false)
      .addRequiredClusterServers(),
    options,
  );
};
```

`finalizeEndpoint` adds the correct `PowerSource` cluster based on `options.batteryPowered`.

---

## Device mapper contract

### Signature

```ts
// src/ccu/types.ts
export type DeviceMapper = (
  channels: CcuChannelInfo[],
  vendorId: number,
  options: ChannelMappingOptions,
) => MappedDeviceEndpoint[];

export interface MappedDeviceEndpoint {
  endpoint: MatterbridgeEndpoint;
  channels: CcuChannelInfo[]; // channels this endpoint handles for wiring
}
```

### Return value rules

| Scenario                                                | Return value                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Required channel absent                                 | `[]` (suppresses the device entirely)                              |
| Single combined endpoint (e.g. WTH thermostat+humidity) | `[{ endpoint, channels: [heatingChannel] }]`                       |
| Multiple endpoints (e.g. multi-zone floor heating)      | one entry per zone, each with its channel                          |
| Device mapper delegates fully to channel mapper         | `[{ endpoint: mapSwitchChannel(...), channels: [switchChannel] }]` |

### File layout

```text
src/ccu/device-mapper/<device-key>.ts   e.g. hmip-wth.ts, hmip-drsi4.ts
```

The file exports `mapDevice: DeviceMapper`.

### Registration

Add entries to `DEVICE_MAPPERS` in `src/ccu/device-mapper/index.ts`. The key is derived from the device type via `deviceTypeToKey` (lowercased, punctuation → hyphens, e.g. `HmIP-WTH` → `hmip-wth`).

One `DeviceMapper` function can be registered under multiple keys (aliases) using re-exports or direct references.

### Wiring

`module.ts` calls `wireChannelEndpoint(endpoint, ch)` once for **each channel listed in `MappedDeviceEndpoint.channels`**. This sets up:

- Matter→Homematic attribute subscriptions (OnOff, LevelControl, Thermostat, WindowCovering…)
- Inbound RPC event routing maps (`channelAddressToDevice`, `wthHumidityChannels`, …)

Declare only the channels that actually need wiring. You do not need to list every channel of the device — only the ones the endpoint handles.

---

## Example: single combined endpoint (WTH thermostat + humidity)

```ts
// src/ccu/device-mapper/hmip-wth.ts
import { humiditySensor, MatterbridgeEndpoint, thermostatDevice } from 'matterbridge';
import { buildDisplayName, buildEndpointId, buildModel, buildSerialNumber, finalizeEndpoint } from '../mapper-utils.js';
import { DeviceMapper } from '../types.js';

export const mapDevice: DeviceMapper = (channels, vendorId, options) => {
  const heatingChannel = channels.find((c) => c.type === 'HEATING_CLIMATECONTROL_TRANSCEIVER');
  if (!heatingChannel) return [];

  return [
    {
      endpoint: finalizeEndpoint(
        new MatterbridgeEndpoint([thermostatDevice, humiditySensor], { id: buildEndpointId(heatingChannel) })
          .createDefaultBridgedDeviceBasicInformationClusterServer(
            buildDisplayName(heatingChannel),
            buildSerialNumber(heatingChannel, 'HEATING_CLIMATECONTROL_TRANSCEIVER'),
            vendorId,
            'Homematic',
            buildModel(heatingChannel),
          )
          .createDefaultHeatingThermostatClusterServer(23, 21)
          .createDefaultRelativeHumidityMeasurementClusterServer(),
        { ...options, batteryPowered: heatingChannel.batteryPowered },
      ),
      channels: [heatingChannel],
    },
  ];
};
```

---

## Example: multiple endpoints (multi-zone device — future pattern)

For a multi-zone floor heating controller (e.g. HmIP-FALMOT-C12) with 12 zone channels, each producing a separate thermostat endpoint:

```ts
export const mapDevice: DeviceMapper = (channels, vendorId, options) => {
  const zoneChannels = channels.filter((c) => c.type === 'HEATING_CLIMATECONTROL_TRANSCEIVER');
  return zoneChannels.map((ch) => ({
    endpoint: createZoneThermostatEndpoint(ch, vendorId, options),
    channels: [ch],
  }));
};
```

Each zone endpoint gets its own `wireChannelEndpoint` call from `module.ts`, establishing independent Thermostat attribute subscriptions and RPC event routing per zone.

---

## Architecture flow in `module.ts`

```text
discoverDevices():

  1. resolveChannelsForMatter(rawChannels)
       HmIP virtual-receiver pairing, power meter merging

  2. Device mapper PRE-PASS
       for each unique device (by deviceAddress):
         primaryChannel = first supported channel of device
         mapper = getDeviceMapper(primaryChannel.deviceType)
         if !mapper → skip (device goes to channel loop)
         if channel disabled → skip
         call mapper(allChannelsForDevice, vendorId, options) → MappedDeviceEndpoint[]
         for each { endpoint, channels }:
           registerDevice(endpoint)
           for each ch in channels: wireChannelEndpoint(endpoint, ch)
         mark deviceAddress as handled

  3. Channel mapper LOOP
       for each channel:
         if device was handled by pre-pass → skip entirely
         createEndpointForChannel(channel)   ← dispatches to channel mapper
         registerDevice(endpoint)
         wireChannelEndpoint(endpoint, channel)

  wireChannelEndpoint(endpoint, channel):
       sets up Matter attribute subscriptions and CCU event routing
       based on channel.type (SWITCH, DIMMER, BLIND, HEATING_CLIMATECONTROL_TRANSCEIVER, …)
```

---

## Registration checklist

### New channel type

1. Add the type string to `SUPPORTED_CHANNEL_TYPES` in `src/ccu/types.ts`.
2. Create `src/ccu/channel-mapper/<type-key>.ts` exporting `mapChannel: ChannelMapper`.
3. Register in `CHANNEL_MAPPERS` in `src/ccu/channel-mapper/index.ts`.
4. Add wiring to `wireChannelEndpoint` in `src/module.ts` (if inbound or outbound events are needed).
5. Add tests in `vitest/mapper.test.ts`.

### New device mapper

1. Create `src/ccu/device-mapper/<device-key>.ts` exporting `mapDevice: DeviceMapper`.
2. Register in `DEVICE_MAPPERS` in `src/ccu/device-mapper/index.ts` (all model aliases).
3. Add tests in `vitest/mapper.test.ts` verifying the `MappedDeviceEndpoint[]` structure.
4. Update `device-support.md` to document the supported device models.

---

## Testing device mappers

Device mapper tests should verify the full `MappedDeviceEndpoint[]` structure:

```ts
const mapper = getDeviceMapper('HmIP-WTH')!;
const results = mapper(channels, VENDOR_ID, {});

// Check array length
expect(results).toHaveLength(1);

// Check endpoint type
const [{ endpoint: ep, channels: mappedChannels }] = results;
expect(ep).toBeInstanceOf(MatterbridgeEndpoint);

// Check clusters
expect(ep.hasClusterServer('Thermostat')).toBe(true);
expect(ep.hasClusterServer('RelativeHumidityMeasurement')).toBe(true);

// Check channel association (important for wiring!)
expect(mappedChannels).toHaveLength(1);
expect(mappedChannels[0].type).toBe('HEATING_CLIMATECONTROL_TRANSCEIVER');
```

Always test: empty channel array returns `[]`, required cluster is present, channel association is correct.
