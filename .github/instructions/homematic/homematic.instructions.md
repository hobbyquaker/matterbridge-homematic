---
name: 'Homematic CCU Integration Guide'
description: 'Domain knowledge for working with Homematic CCU channel types, RPC/ReGa communication, device mapping to Matter, and power classification in this plugin.'
applyTo: 'src/ccu/**, test/**, vitest/**'
---

# Homematic CCU Integration Guide

Use this guide when adding support for new Homematic channel types, modifying device mapping logic, or working with the CCU connection layer.

## Reference sources

- **RPC/ReGa communication patterns and Node.js module usage**: https://github.com/rdmtc/node-red-contrib-ccu
- **Device type → Homekit mapping prior art** (channel types, datapoint names, value conversions, tilt support, battery handling): https://github.com/rdmtc/RedMatic-HomeKit/tree/master/homematic-devices
- **Paramset definitions** (datapoint names, ranges, types per channel type — machine-readable): https://raw.githubusercontent.com/rdmtc/node-red-contrib-ccu/refs/heads/master/paramsets.json
- **Official HmIP Device Documentation** (device types, channel types, datapoints): https://www.homematic-ip.com/downloads/DeviceDocumentation_HmIP.pdf
- **ReGa scripting documentation** (channel name lookup, scripting patterns):
  - Official PDF — Teil 1 Sprachbeschreibung: https://www.eq-3.com/Downloads/eq3/download%20bereich/hm_web_ui_doku/HM-Skript_Teil_1_Sprachbeschreibung_V2.2.pdf
- **Community ReGa scripting reference** (covers object model, methods, examples, datapoints — equivalent to parts 2–4): http://www.wikimatic.de/wiki/Script_Dokumentation
- **Curated community resource list** https://github.com/homematic-community/awesome-homematic

Consult these sources first when adding support for a new channel type or datapoint.

**Device mapper roadmap**: see [ROADMAP.md](../../../ROADMAP.md) for the planned list of device-level mappers (humidity endpoint for WTH family, HM-CC-VG-1 group thermostat, HM-SEC-SIR-WM alarm panel, RGBW color light, garage door variants) including effort estimates, implementation notes, and a confirmed list of devices that already work without device mappers.

## CCU interfaces

The plugin connects to the CCU via multiple interfaces. Each is represented by `CcuInterfaceName`:

| Interface name   | Protocol                         | Purpose                                                                                  |
| ---------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| `ReGaHSS`        | HTTP                             | ReGa scripting: channel names, program logic                                             |
| `BidCos-RF`      | XML-RPC (loopback only: BIN-RPC) | Classic HM radio devices                                                                 |
| `BidCos-Wired`   | XML-RPC (loopback only: BIN-RPC) | Classic HM wired devices                                                                 |
| `HmIP-RF`        | XML-RPC                          | HmIP radio and wired devices                                                             |
| `VirtualDevices` | XML-RPC                          | CCU-internal virtual channels and groups, mainly used for groups of thermostats and TRVs |
| `CUxD`           | BIN-RPC                          | CUxD daemon (USB stick / extra hardware)                                                 |

- RPC interfaces use `homematic-xmlrpc` (XML-RPC) or `binrpc` (BIN-RPC) clients.
- ReGa uses the `homematic-rega` client for scripting and channel name lookup.
- Device discovery uses `hm-discover` to find CCU hosts on the network.

## Channel discovery flow

1. RPC `listDevices` is called on each enabled interface to enumerate all device and channel addresses.
2. ReGa `getChannels` is called to retrieve display names and map them onto the discovered addresses.
3. `resolveChannelsForMatter` in `device-mapper.ts` filters and remaps channels to the set that will be exposed as Matter endpoints.

## Supported channel types and their Matter mapping

Defined in `SUPPORTED_CHANNEL_TYPES` in `src/ccu/device-mapper.ts`:

| Homematic channel type               | Matter device type(s)                                  | Key datapoints                                |
| ------------------------------------ | ------------------------------------------------------ | --------------------------------------------- |
| `ALARMSTATE`                         | `waterLeakDetector`                                    | `STATE` → BooleanState                        |
| `BLIND`                              | `coverDevice` (lift only)                              | `LEVEL` → CurrentPositionLiftPercent          |
| `BLIND` with tilt                    | `coverDevice` (lift + tilt)                            | `LEVEL` + `LEVEL_2`                           |
| `DIMMER`                             | `dimmableLight`                                        | `LEVEL` → CurrentLevel                        |
| `HEATING_CLIMATECONTROL_TRANSCEIVER` | `thermostatDevice`                                     | `ACTUAL_TEMPERATURE`, `SET_POINT_TEMPERATURE` |
| `KEY`                                | `genericSwitch` (momentary)                            | `PRESS_SHORT`, `PRESS_LONG`                   |
| `KEYMATIC`                           | `doorLockDevice`                                       | `STATE` → LockState                           |
| `KEY_TRANSCEIVER`                    | `genericSwitch` (momentary)                            | `PRESS_SHORT`, `PRESS_LONG`                   |
| `MOTION_DETECTOR`                    | `occupancySensor` + `lightSensor`                      | `MOTION` + `ILLUMINATION`                     |
| `ROTARY_HANDLE_SENSOR`               | `contactSensor`                                        | `STATE` (0=closed, 1=tilted, 2=open)          |
| `SHUTTER_CONTACT`                    | `contactSensor`                                        | `STATE` → BooleanState                        |
| `SMOKE_DETECTOR`                     | `smokeCoAlarm`                                         | `SMOKE_DETECTOR_ALARM_STATUS`                 |
| `SWITCH`                             | `onOffLight` / `onOffOutlet` / `onOffSwitch`           | `STATE` → OnOff                               |
| `TEMPERATURE_HUMIDITY_TRANSMITTER`   | `temperatureSensor` + `humiditySensor`                 | `TEMPERATURE`, `HUMIDITY`                     |
| `THERMALCONTROL_TRANSMIT`            | `thermostatDevice`                                     | `ACTUAL_TEMPERATURE`, `SET_POINT_TEMPERATURE` |
| `WEATHER`                            | `temperatureSensor` + `humiditySensor` + `lightSensor` | `TEMPERATURE`, `HUMIDITY`, `BRIGHTNESS`       |

### SWITCH → Matter type selection

`SWITCH` channels are configurable via `switchMatterType` in the per-channel user override (`CcuChannelOverride`):

- `'light'` (default) → `onOffLight`
- `'outlet'` → `onOffOutlet`
- `'switch'` → `onOffSwitch`

### SWITCH + power meter merging

When a `POWERMETER` (BidCos) or `ENERGIE_METER_TRANSMITTER` (HmIP) channel is found on the same device as a single `SWITCH` channel, it is merged onto the SWITCH endpoint:

- `powerMeterChannelAddress` on `CcuChannelInfo` holds the power meter channel address.
- `powerMeterIsHmIP` indicates whether CURRENT is in milliamps (HmIP) or amps (BidCos).
- The endpoint gets `createDefaultElectricalPowerMeasurementClusterServer()`.

## HmIP virtual-receiver channel pairing

HmIP devices expose transmitter channels alongside virtual-receiver channels. The plugin pairs them:

| Transmitter channel type | Accepted receiver types                                                           | Canonical type |
| ------------------------ | --------------------------------------------------------------------------------- | -------------- |
| `SWITCH_TRANSMITTER`     | `SWITCH_VIRTUAL_RECEIVER`                                                         | `SWITCH`       |
| `DIMMER_TRANSMITTER`     | `DIMMER_VIRTUAL_RECEIVER`                                                         | `DIMMER`       |
| `BLIND_TRANSMITTER`      | `BLIND_VIRTUAL_RECEIVER`, `BLIND_VIRTUAL_TRANSCEIVER`, `SHUTTER_VIRTUAL_RECEIVER` | `BLIND`        |

Rules:

- For each transmitter, the **first** receiver channel with a higher channel index is selected.
- `BLIND_VIRTUAL_RECEIVER` indicates venetian-blind tilt support (`tiltSupported = true`).
- Standalone blind virtual channels (no transmitter) are also handled: groups of 3 are collapsed to the first of each block.
- `KEY_TRANSCEIVER` channels on the `VirtualDevices` interface are skipped (virtual echoes of physical presses).
- `HmIP-HEATING` channel 5 on `VirtualDevices` is an internal control channel and is skipped.

## Endpoint ID and serial number conventions

| Field          | Format                                                      | Example                          |
| -------------- | ----------------------------------------------------------- | -------------------------------- |
| `id`           | `hm-<address-with-colon-as-dash>`                           | `hm-OEQ0854602-1`                |
| `serialNumber` | `<interfaceName>:<shortType>:<channelAddress>`              | `BidCos-RF:CONTACT:OEQ0854602:1` |
| `model`        | `channel.deviceType` if available, otherwise `channel.type` | `HmIP-BSM`                       |

Short type labels are defined in `CHANNEL_TYPE_LABEL` in `mapper-utils.ts` (e.g. `SHUTTER_CONTACT` → `CONTACT`).
The endpoint id must remain stable across restarts. Never change the id format for an existing channel type.

## Power source classification

Logic lives in `src/ccu/device-power.ts`.

### Mains-powered detection

`MAINS_POWERED_DEVICE_TYPE_PREFIXES` contains known mains-only prefixes: `['HM-LC', 'HM-ES']`.

- Match by `deviceType.startsWith(prefix)`.
- Endpoints for mains-powered devices get `createDefaultPowerSourceWiredClusterServer()`.
- All other devices (battery or unknown) get `createDefaultPowerSourceReplaceableBatteryClusterServer(100)`.
- When adding a new mains-only device family, add its prefix to `MAINS_POWERED_DEVICE_TYPE_PREFIXES` — keep the list minimal and add only verified prefixes.

### Battery voltage ranges

Default range: 2.0 – 3.0 V (2×AA/LR6, covers most HmIP sensors).

Overrides in `BATTERY_VOLTAGE_RANGES` (longest-prefix-first, first match wins):

| Device type prefix | Min (V) | Max (V) | Notes                 |
| ------------------ | ------- | ------- | --------------------- |
| `HmIP-SRH`         | 1.0     | 1.5     | Window handle, 1×AA   |
| `HmIP-SWD`         | 1.0     | 1.5     | Water detector, 1×AAA |

Add a new entry when a device uses a battery chemistry that deviates from the 2×AA default.

## Source file structure for device mapping

The mapping layer is split across several directories:

| Path                               | Purpose                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ccu/device-mapper.ts`         | Public dispatcher. Exports `createEndpointForChannel`, `getDeviceMapper`, `resolveChannelsForMatter`, `inferSwitchMatterTypeFromName`, `isSupportedChannelType`, `channelTypeLabel`, and `SUPPORTED_CHANNEL_TYPES`. |
| `src/ccu/mapper-utils.ts`          | Shared endpoint-building helpers: `buildEndpointId`, `buildSerialNumber`, `buildDisplayName`, `buildModel`, `finalizeEndpoint`, `channelTypeLabel`.                                                                 |
| `src/ccu/types.ts`                 | All shared CCU types including `CcuChannelInfo`, `ChannelMappingOptions`, `ChannelMapper`, `DeviceMapper`, `SUPPORTED_CHANNEL_TYPES`.                                                                               |
| `src/ccu/channel-mapper/<type>.ts` | One file per channel type (e.g. `shutter-contact.ts`). Each exports a `mapChannel: ChannelMapper` function.                                                                                                         |
| `src/ccu/channel-mapper/index.ts`  | Registry `CHANNEL_MAPPERS` keyed by sanitized channel type + `channelTypeToKey` helper.                                                                                                                             |
| `src/ccu/device-mapper/<model>.ts` | One file per device model (e.g. `hmip-bsm.ts`). Each exports a `mapDevice: DeviceMapper` function.                                                                                                                  |
| `src/ccu/device-mapper/index.ts`   | Registry `DEVICE_MAPPERS` keyed by sanitized device type + `deviceTypeToKey` helper.                                                                                                                                |

### Key naming rules

- **Channel type key**: `channelType.toLowerCase().replace(/_/g, '-')` — e.g. `SHUTTER_CONTACT` → `shutter-contact`
- **Device type key**: `deviceType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')` — e.g. `HmIP-BSM` → `hmip-bsm`, `HmIP-STE2+` → `hmip-ste2`

## Adding support for a new channel type

1. Add the channel type string to `SUPPORTED_CHANNEL_TYPES` in `src/ccu/types.ts`.
2. Create `src/ccu/channel-mapper/<sanitized-key>.ts` exporting `mapChannel: ChannelMapper`:
   - Call `buildEndpointId`, `buildDisplayName`, `buildSerialNumber`, `buildModel` from `mapper-utils.ts`.
   - Create a `MatterbridgeEndpoint` with the correct Matter device type(s).
   - Call `.createDefaultBridgedDeviceBasicInformationClusterServer(...)`.
   - Add the relevant cluster server(s).
   - Return `finalizeEndpoint(ep, { ...options, batteryPowered: channel.batteryPowered })`.
   - If the type name abbreviates well, add an entry to `CHANNEL_TYPE_LABEL` in `mapper-utils.ts`.
3. Register the new mapper in `src/ccu/channel-mapper/index.ts` under the sanitized key.
4. Update the supported channel types table in this file and in `README.md`.
5. Add unit tests in `vitest/` covering the new channel mapper (at minimum: produces a `MatterbridgeEndpoint`).

## Adding support for a new device model (device-level mapper)

Device mappers override the generic per-channel dispatch for specific device models. Use them when a device needs cross-channel logic or must always have a particular power source regardless of heuristics.

1. Create `src/ccu/device-mapper/<sanitized-key>.ts` exporting `mapDevice: DeviceMapper`:
   - Receives the full array of resolved channels for the device.
   - Returns `MatterbridgeEndpoint[]` (may be empty, one, or many).
   - Call the relevant channel mapper(s) from `src/ccu/channel-mapper/` or build endpoints directly.
2. Register the mapper in `src/ccu/device-mapper/index.ts` under the sanitized device type key.
3. Add unit tests in `vitest/` verifying `getDeviceMapper('<model>')` returns the mapper and it produces the expected endpoints.

## RPC event handling conventions

- Datapoint events arrive via the RPC callback server as `{ address, datapoint, value }`.
- The full channel address is reconstructed from the device address and channel index suffix.
- Values from the CCU are typed (boolean, number, string) but should be validated before use.
- Uncertain datapoints (timestamp = 1970-01-01) are flagged via `CcuReGaDatapoint.uncertain` — treat them as uninitialized and do not push them to Matter attributes.

## ReGa communication

- ReGa is used for channel name lookup only (not for live datapoint values).
- `regaEnabled` in the connection config controls whether ReGa is consulted at all.
- Fallback when ReGa is unavailable: use the raw channel address as the display name.
