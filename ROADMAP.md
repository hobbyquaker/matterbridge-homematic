# Device Mapper Roadmap

> Last reviewed: May 2026  
> Reference prior-art: https://github.com/rdmtc/RedMatic-HomeKit/tree/master/homematic-devices

---

## What already works without device mappers

The channel-mapper registry and `resolveChannelsForMatter` handle all of the following correctly out of the box:

| Device family                                  | Reason                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| HmIP-DRSI1/4, MOD-OC8                          | `SWITCH_TRANSMITTER → SWITCH_VIRTUAL_RECEIVER` pairing                                |
| HmIP-BBL, BROLL, FROLL, DRBLI4                 | `BLIND_TRANSMITTER → BLIND_VIRTUAL_RECEIVER` pairing                                  |
| HmIP-BDT                                       | `DIMMER_TRANSMITTER → DIMMER_VIRTUAL_RECEIVER` pairing                                |
| HmIP-FSM, FSM16, PS, PSM, BSM                  | No LOW_BAT marker → `batteryPowered = false` automatically; power-meter merging works |
| HmIP-BWTH                                      | BLIND + THERMALCONTROL_TRANSMIT → two independent endpoints                           |
| HmIP-STE2-PCB, STE2+                           | Each TEMPERATURE_HUMIDITY_TRANSMITTER channel maps independently                      |
| HmIP-HEATING (VirtualDevices)                  | Uses HEATING_CLIMATECONTROL_TRANSCEIVER; channel 5 is already skipped                 |
| HmIP-eTRV, HmIP-eTRV-2/B/C                     | HEATING_CLIMATECONTROL_TRANSCEIVER channel mapper                                     |
| HM-CC-RT-DN                                    | THERMALCONTROL_TRANSMIT channel mapper (basic thermostat)                             |
| HmIP-BSL                                       | KEY + SWITCH channels map independently                                               |
| HmW-Sen-SC-12, HmW-IO-12-SW7-DR                | Each channel maps independently                                                       |
| hb-lc-bl1pbu-fm                                | Alias for HM-LC-Bl1PBU-FM → BLIND channel mapper                                      |
| hb-lc-sw1pbu-fm, hb-lc-sw2-fm, hb-lc-sw2pbu-fm | All SWITCH channels → SWITCH channel mapper                                           |
| hb-uni-senact-4-4-rc/sc and 8-8 variants       | SWITCH + SHUTTER_CONTACT channels → standard mappers                                  |
| hb-uni-sen-press-sc                            | SHUTTER_CONTACT on ch2 → contactSensor                                                |
| hb-uni-sen-temp-ds18b20, hb-uni-sen-temp-ir    | Multi-probe TEMPERATURE channels; each maps independently                             |
| hb-uni-dmx-master                              | ch1 SWITCH + ch2-3 KEY-like; standard channel types                                   |
| hb-uni-sen-wea                                 | WEATHER channel mapper (minor: uses LUX instead of BRIGHTNESS for light sensor)       |

---

## Planned features

### Priority: High

#### UI-0 — Per-device / per-channel configuration web UI

**Effort: Medium** (frontend + backend, depends on upstream API)  
**Status: BLOCKED** — waiting on [Luligu/matterbridge#561](https://github.com/Luligu/matterbridge/issues/561)

Users currently configure per-channel overrides (e.g. `switchMatterType`, `enabled`) by hand-editing the JSON config file. A web UI inside the Matterbridge frontend would make this accessible without touching raw JSON.

**What is needed from Matterbridge (issue #561):**

- A route registration API so plugins can attach REST handlers to Matterbridge's HTTP server (`this.matterbridge.registerRoute(method, path, handler)` or equivalent)
- Optionally: an embedded config panel inside the SPA (iframe or side panel) so the UI does not open in a new tab

Luligu's response on the issue is positive — he was already considering a similar route for the Home Assistant plugin and will follow up after his holiday. Monitor the issue for API shape before starting implementation.

**What the plugin-side implementation would look like once unblocked:**

1. **REST API** — register routes (e.g. `GET /plugins/matterbridge-homematic/devices`, `PUT /plugins/matterbridge-homematic/devices/:address/config`) to read and write per-device/per-channel overrides in the config JSON
2. **Frontend** — a small SPA page (or embedded panel) that lists all discovered channels with their current overrides and lets the user change `switchMatterType`, `enabled`, display name, etc. without restarting
3. **Config schema** — the existing `matterbridge-homematic.schema.json` already describes the per-channel shape; the UI can be generated from it or built hand-coded

**Design notes:**

- Per-channel config is keyed by channel address (`CcuChannelInfo.address`) in `CcuConfig.channelOverrides`
- After a config write the plugin needs to re-run `resolveChannelsForMatter` and re-register changed endpoints; Matterbridge's `unregisterDevice` / `registerDevice` cycle supports this
- The REST layer should validate incoming JSON against the existing schema to avoid corrupt config
- Future-facing mapper API note: once the UI supports richer per-device configuration, some device mappers will need read access to plugin config during endpoint creation. The current `DeviceMapper` signature only receives `channels`, `vendorId`, and `options`, so plan for a small mapper context object rather than reaching back into `module.ts` globals. Likely contents: resolved device/channel overrides, logger, and possibly a narrow config read API. Keep this read-only at mapping time; config writes should stay in the platform/UI layer.
- Device-type-specific options should be owned by the device mapper layer, not by a flat global schema section. In practice that means each `src/ccu/device-mapper/*.ts` file should be able to declare the extra options it understands plus UI metadata for those options, and the config UI should show them only for matching Homematic device types.
- Example: `HmIP-WTH` currently always exposes a humidity endpoint. A future config UI should be able to offer a mapper-defined option like `exposeHumidityEndpoint` (default `true`) only for the WTH / STH / STHD family.
- This should be designed together with the mapper-context item above: if mappers define device-specific config options, they also need a typed way to read the resolved config values at mapping time without introducing direct platform coupling.

#### PERF-0 — Device description / paramset cache

**Effort: Medium**  
**Goal:** reduce startup RPC load by avoiding repeated `getParamsetDescription` / device-description lookups for device types and firmware versions that are already known.

The plugin currently calls `getParamsetDescription` during startup in `primeBatteryHintsFromRpc()` to detect `LOWBAT` / `LOW_BAT` markers for battery classification. On installations with many devices this creates a burst of RPC calls on every startup even though the paramset description for a given Homematic interface + device type + firmware version is effectively static.

`node-red-contrib-ccu` already solves this by shipping a `paramsets.json` file keyed in a flat, compatibility-friendly format like:

- `HmIP-RF/HmIP-SMI/1.0.3/1/MOTIONDETECTOR_TRANSCEIVER/VALUES`
- `BidCos-RF/HM-RCV-50/2.31.25/6/VIRTUAL_KEY/MASTER`

Each key maps to the raw paramset description object returned by the CCU. We should stay compatible with that format so upstream data can be imported directly and future updates can be merged without conversion.

**Planned approach:**

1. **Bundle a seed database** — vendor the latest upstream `paramsets.json` from `node-red-contrib-ccu` into this plugin unchanged (or as unchanged as practical) and include it in the npm package
2. **Add a writable runtime overlay** — keep a second writable cache file for newly learned paramsets discovered from live RPC calls
3. **Lookup before RPC** — when startup code needs a paramset/device description, first resolve the compatibility key and consult the bundled seed + runtime overlay before falling back to `getParamsetDescription`
4. **Write-through learning** — when a live RPC call is still needed, persist the result into the runtime overlay using the same key format so the next startup is cheaper

**Open design points:**

- **Key material:** the cache should be keyed by at least interface name, Homematic device type, firmware version, channel index, channel type, and paramset key (`MASTER` / `VALUES` / `LINK` / `SERVICE`) to stay compatible with `node-red-contrib-ccu`
- **Firmware availability:** confirm which firmware/version field is available from `listDevices` / `getDeviceDescription` and carry it through discovery so the cache can distinguish incompatible firmware revisions
- **Storage location:** do not treat the npm-installed package directory as writable runtime storage. Best option is a writable file under the same Matterbridge runtime area already used for discovery cache (for example a plugin-specific file under `~/.matterbridge`). If Matterbridge exposes the plugin-config directory as a supported writable location, colocating the runtime overlay there is also reasonable
- **Package distribution:** the bundled seed file should ship read-only with the npm package via the `files` list. No first-start copy is required for the seed file if the plugin can read it directly from its installed package path; only the writable overlay needs to be created on first write
- **Update strategy:** keep the vendored file compatible with upstream `node-red-contrib-ccu` so future refreshes can be done by replacing it with a newer upstream snapshot instead of maintaining a forked schema

**Why this matters beyond battery detection:**

- Future device mappers and a config UI may need richer paramset metadata to decide which datapoints, features, or device-specific config options are available
- A shared paramset cache creates one authoritative source for these capabilities instead of scattering ad-hoc RPC probes across startup and mapper code

#### OPS-0 — More granular logging controls

**Done:** [`9bb5aa4`](https://github.com/hobbyquaker/matterbridge-homematic/commit/9bb5aa4)

**Effort: Low-Medium**  
**Goal:** keep useful diagnostic logging available without flooding the log with high-volume RPC transport noise.

The current plugin config only exposes a single coarse `debug` boolean. In practice the noisiest log lines come from the CCU transport layer, especially:

- incoming `RPC callback` / `RPC event` lines for every event
- large `RPC result` payloads for calls such as `getParamsetDescription`
- verbose `newDevices` payload/classification logging during startup or interface re-init

These are useful when debugging RPC protocol problems, but they drown out higher-value mapping and state-sync logs during normal troubleshooting.

**Planned approach:**

1. Keep the existing `debug` switch as the master coarse switch for backward compatibility
2. Add a small number of narrower plugin config options for high-volume transport logging:

- `logRpcEvents` (`boolean`) — gate per-event `RPC callback` / `RPC event` logging
- one payload-format option that indicates RPC and ReGa payloads are truncated so they fit in one line, instead of introducing separate `logRpcPayloads` / `logRegaPayloads` toggles

3. Route noisy transport logs through small helper methods in the connection layer so they can be turned on/off consistently without scattering conditionals across every log call
4. Keep summaries, warnings, and state-change logs visible under normal debug mode even when payload output is truncated

**Design guidance:**

- Prefer category toggles over inventing a second custom log-level system unless Matterbridge already provides a natural extension point. The real problem is log category volume, not lack of numeric severity levels
- Prefer one shared payload-format/truncation option for both RPC and ReGa payloads rather than separate payload toggles per source
- Heavy payload logs should be summarized/truncated into a single line so calls like `getParamsetDescription`, `listDevices`, `newDevices`, and ReGa script results do not dominate the frontend log view
- The future config UI should surface these options under an "advanced diagnostics" section, not alongside normal end-user device settings

#### CFG-0 — Split ReGa features into explicit config flags

**Done:** [`9bb5aa4`](https://github.com/hobbyquaker/matterbridge-homematic/commit/9bb5aa4)

**Effort: Medium**  
**Goal:** replace the current coarse ReGa toggle with feature-specific options so users can independently enable channel-name sync, program endpoints, variable endpoints, polling, and pseudo-push behavior.

The current `regaEnabled` shape is too coarse. It mixes at least three separate concerns: channel-name lookup, program/script execution, and future ReGa-backed virtual entities. The roadmap should move toward explicit switches for each user-visible ReGa feature.

**Target config surface:**

1. `createMatterDevicesForVariables` (`boolean`, default false)
2. `createMatterDevicesForPrograms` (`boolean`, default false)
3. `syncChannelNames` (`boolean`, default true)
4. `regaVariablesPollingInterval` (`number`, with `0` meaning no polling, default 0)
5. `virtualKeyForRegaPseudoPush` (`string` or structured key reference, default empty string)

**Planned approach:**

1. Keep compatibility for existing installs by mapping the current `regaEnabled` behavior onto sensible defaults for the new flags during migration
2. Treat `syncChannelNames` as the switch for channel-name lookup and blacklist/whitelist migration, independent from program and variable exposure
3. Allow `syncChannelNames` to work even when the broader historical `regaEnabled` path is disabled
4. Gate program endpoint creation behind `createMatterDevicesForPrograms`
5. Gate ReGa boolean-variable endpoint creation behind `createMatterDevicesForVariables`
6. Use `regaVariablesPollingInterval` only for ReGa variable state refresh; `0` should disable polling entirely
7. Use `virtualKeyForRegaPseudoPush` to support a pseudo-push mechanism for faster refresh without requiring aggressive polling

**Design notes:**

- `syncChannelNames` should only enable the minimal ReGa calls required to fetch channel names and migrate config entries; it should not implicitly enable program support or variable polling
- Variable and program support should be modeled as separate endpoint families so users can enable one without the other
- `virtualKeyForRegaPseudoPush` should be documented as an optimization path for ReGa-backed state refresh, not as a mandatory dependency for variables/programs
- The connection layer will likely need smaller ReGa capability slices instead of a single all-or-nothing initialization path
- Schema and README documentation should describe the five options explicitly and explain how they interact with the legacy `regaEnabled` setting during the transition period

---

## Planned device mappers

### Priority: High

#### HM-1 — Wall thermostat humidity endpoint (HmIP-WTH / STH / STHD family)

**Effort: Low** (~40 LOC + tests)

The `HEATING_CLIMATECONTROL_TRANSCEIVER` channel on HmIP-WTH, WTH-2, WTH-B, STHD, STH also carries a `HUMIDITY` datapoint. The current channel mapper creates only a thermostat endpoint. A device mapper should additionally return a `humiditySensor` endpoint built from the same channel address.

RedMatic prior art: `hmip-wth.js`, `hmip-sthd.js` — both offer an optional `HumiditySensor` service. Today we always include it. In a future config UI, this is a good candidate for a device-type-specific mapper option (`exposeHumidityEndpoint: true|false`).

**Implementation notes:**

- Device mapper calls `mapHeatingClimateControlTransceiverChannel(switchChannel, vendorId, options)` for the thermostat endpoint
- Builds a second `MatterbridgeEndpoint([humiditySensor])` from the same channel address, with `HumidityMeasurement` cluster
- Returns both endpoints from `mapDevice`
- Device mapper files: `src/ccu/device-mapper/hmip-wth.ts` (covers WTH, WTH-2, WTH-B)  
  and `src/ccu/device-mapper/hmip-sthd.ts` (covers STHD, STH) — or one shared helper

---

#### HM-3 — HM-CC-VG-1 virtual thermostat group

**Effort: Low–Medium** (endpoint creation is easy; event routing needs research)

The CCU exposes thermostat groups via `VirtualDevices` as `HM-CC-VG-1` with a `THERMALCONTROL_TRANSMIT` channel. The channel mapper creates the thermostat endpoint correctly. The open question is whether SET commands sent to the group channel address are routed correctly by the CCU (they likely are, since it is a virtual device group address). Needs a real device to verify.

RedMatic prior art: `hm-cc-vg-1.js` — uses the group device address directly for all get/set operations.

**Implementation notes:**

- May require no device mapper at all if the VirtualDevices interface routes SET correctly
- If routing needs a different target address, add `groupTargetAddress` to `CcuChannelInfo` or handle in `module.ts`
- Worth testing on real hardware before building

---

#### HM-6 — HM-SEC-SIR-WM security alarm panel

**Effort: High**

The siren/alarm panel exposes `ARMSTATE` on channel 4 (arm/disarm/alarm state) and trigger inputs on channels 1–3 (ALARMSTATE). Our current `ALARMSTATE` channel mapper creates `waterLeakDetector` endpoints for channels 1–3, which is wrong for this device. The device needs a cross-channel device mapper that:

- Reads `ARMSTATE` from channel 4 (0=disarmed, 1=EXTSENS_ARMED, 2=ALLSENS_ARMED, 3=ALARM_BLOCKED)
- Reads `STATE` from channels 1–3 as zone triggers
- Maps all of this to a Matter `alarmSensor` or custom security state representation

RedMatic prior art: `hm-sec-sir-wm.js` maps to a HomeKit `SecuritySystem` with `STAY_ARM / AWAY_ARM / DISARMED / ALARM_TRIGGERED` states.

**Open questions before implementing:**

- What is the actual Homematic channel type for the ARMSTATE channel? Probably `ALARM_SWITCH_VIRTUAL` or `SECURITY_SYSTEM` — needs checking in paramsets.json
- Does Matter have a SecuritySystem device type? The `alarmSensor` device type is the closest standard one; a full SecuritySystem cluster may be needed
- How to handle channels 1–3 in this device mapper without double-registering them as waterLeakDetector endpoints

**Implementation approach:**

1. Add the ARMSTATE channel type to `SUPPORTED_CHANNEL_TYPES` (or handle it only inside the device mapper)
2. The device mapper intercepts all channels for this device and returns a single endpoint representing the security system state
3. `module.ts` event handling needs to aggregate zone states and ARMSTATE into the cluster attribute

---

### Priority: Medium

#### HM-5 — HM-LC-RGBW-WM / hb-uni-rgb-led-ctrl color light

**Effort: High**

RGBW LED controller (also used by the homebrew `hb-uni-rgb-led-ctrl`). Two functional channels:

- `:1.LEVEL` — brightness (0.0–1.0)
- `:2.COLOR` — hue index (0–199 = full color range, 200 = white/desaturated)

Maps to `extendedColorLight` device type + `ColorControl` cluster.

RedMatic prior art: `hm-lc-rgbw-wm.js` (and `hb-uni-rgb-led-ctrl.js` which is an alias).

**Value conversion:**

- Hue: `hueMatter = Math.round((colorIndex / 199) * 254)` (Matter uses 0–254 for 0°–360°)
- Saturation: when `colorIndex === 200` → saturation = 0 (white mode)
- The reverse conversion for SET also needs the 200=white special case

**Implementation notes:**

- The device has two channels (DIMMER-type for LEVEL, COLOR-type for hue)
- A device mapper is the right place since the two channels are tightly coupled
- No existing channel type handles the COLOR datapoint → add `COLOR` (or similar) as an internal type recognized only within the device mapper

---

### Priority: Medium

#### HM-9 — Garage door with combined contact sensor(s)

**Effort: Medium–High**  
**Status: Partially blocked** — Matter 1.5 has no native garage door device type; workaround via `doorLockDevice` is viable now and can be upgraded later when Matter adds a dedicated type.

A complete garage door integration that combines the actuator channel (trigger/motor) with one or two contact sensor channels that prove the actual open/closed state. This supersedes and replaces the simpler HM-4 and HM-7 entries once implemented.

**Typical hardware setup:**

- Actuator: a SWITCH or SHUTTER_CONTACT channel that toggles the door (HmIP-SWDO, HmIP-MOD-HO/TM, or any relay output wired to the door motor)
- Contact sensor(s): one or two SHUTTER_CONTACT channels reporting verified open / closed state (e.g. HmIP-SCI or HmIP-SWDO-I mounted at top and bottom of the door travel)

**Garage door control patterns:**

The device mapper must account for two common motor wiring patterns:

1. **Dedicated open/close outputs** — separate relay channels for OPEN and CLOSE commands; straightforward mapping to `currentPosition`/`targetPosition`
2. **Up-stop-down (toggle) pattern** — a single relay channel that cycles through open → stop → close → stop on each press. The controller must track current door state via the contact sensors and issue the correct number of pulses to reach the target state without overshooting

**Config options to expose in `matterbridge-homematic.schema.json`:**

| Option                | Type      | Purpose                                                                      |
| --------------------- | --------- | ---------------------------------------------------------------------------- |
| `openContactAddress`  | `string`  | Channel address of the "fully open" contact sensor                           |
| `closeContactAddress` | `string`  | Channel address of the "fully closed" contact sensor                         |
| `openingTimeMs`       | `number`  | Estimated full travel time open→close (ms); used for timeout detection       |
| `closingTimeMs`       | `number`  | Estimated full travel time close→open (ms); used for timeout detection       |
| `togglePattern`       | `boolean` | Set `true` for up-stop-down motors; `false` for dedicated open/close outputs |

**Matter mapping (workaround, Matter ≤ 1.5):**

Use `doorLockDevice` as the interim device type:

- `LockState.LOCKED` = door fully closed (confirmed by close contact)
- `LockState.UNLOCKED` = door fully open (confirmed by open contact)
- `LockState.NOT_FULLY_LOCKED` = door in motion or in an intermediate position

Timeout detection: if neither contact fires within `openingTimeMs` / `closingTimeMs` after a command, set `LockState.NOT_FULLY_LOCKED` and raise a fault attribute so the controller knows the door is stuck.

**Future upgrade path:** When Matter introduces a native garage door device type, the Matter mapping layer can be swapped out without changing the Homematic-side logic.

**Relationship to other items:**

- Replaces HM-4 (HmIP-SWDO simple mode) and HM-7 (HmIP-MOD-HO raw channel) once implemented
- HM-4 / HM-7 can remain as lightweight fallbacks for setups without contact sensors

---

### Priority: Low

#### HM-4 — HmIP-SWDO optional garage door mode

**Effort: Low–Medium**

HmIP-SWDO (motorized window/door opener) uses a boolean `STATE` on its channel (likely `SHUTTER_CONTACT` type). The standard `contactSensor` mapping is correct by default. Optionally, the user could expose it as a garage door / motorized door with toggle control.

RedMatic prior art: `hmip-swdo.js` — defaults to ContactSensor, can be configured as GarageDoorOpener, Door, or Window.

**In Matter:** No native garage door device type. Options: `doorLockDevice` (binary lock/unlock semantic), or `coverDevice` (0%/100% only). Neither is perfect. Low priority until there is user demand.

---

#### HM-7 — HmIP-MOD-HO / MOD-TM garage door / gate motor

**Effort: Medium**

Motorized garage door or gate. Accesses `DOOR_STATE` and `DOOR_COMMAND` datapoints on channel 1. The actual Homematic channel type for this channel is unknown — needs checking in paramsets.json or on real hardware. In Matter, closest mapping is `coverDevice` (open=100%, closed=0%) with toggle control.

RedMatic prior art: `hmip-mod-ho.js` and `hmip-mod-tm.js` (alias for MOD-HO).

**Research needed first:** Confirm the channel type string that appears in `listDevices` for this device before deciding whether this needs a new channel type in `SUPPORTED_CHANNEL_TYPES` or is handled entirely within a device mapper.

---

#### HM-8 — ReGa programs and boolean variables as Matter devices

**Effort: Medium**

The CCU supports both user-defined programs and ReGa system variables. Expose selected programs as Matter trigger devices and selected boolean variables as stateful Matter devices so Matter controllers can both fire CCU automations and observe/control simple ReGa state.

**How CCU programs work:**

- Programs are listed via ReGa script: `dom.GetObject(ID_PROGRAMS).EnumUsedIDs()` returns all program IDs with name and active state
- A program is executed via: `dom.GetObject(<id>).ProgramExecute()`
- The `homematic-rega` client (already used by the connection layer for channel name lookup) supports arbitrary script execution

**How boolean ReGa variables work:**

- Boolean variables are listed via ReGa script by enumerating system variables and filtering for the boolean type
- Variable state is read via ReGa object access and written via the corresponding `State()` setter
- Unlike programs, variables have persistent state and therefore need either polling or pseudo-push-assisted refresh

**Matter mapping:**

- Each program → one `onOffSwitch` endpoint (or `genericSwitch` for momentary semantics)
- Program endpoint behavior: turning ON executes the program; the attribute auto-resets to OFF after execution
- Each boolean variable → one stateful boolean Matter device, most likely `onOffSwitch` / `onOffLight`-style semantics or another simple boolean endpoint depending on controller compatibility
- Variable endpoint behavior: Matter writes should update the ReGa variable, and ReGa state changes should sync back into Matter via polling or pseudo-push refresh

**Implementation notes:**

1. Add the five ReGa-related config options described in CFG-0 to `CcuConfig` / `matterbridge-homematic.schema.json`
2. In `onStart`, if `createMatterDevicesForPrograms` is enabled, query ReGa for the program list and create one endpoint per configured program; endpoint ID should be stable and based on the program ID, not the name
3. In `onStart`, if `createMatterDevicesForVariables` is enabled, query ReGa for boolean variables and create one endpoint per configured variable; endpoint ID should be stable and based on the variable ID, not the name
4. In `module.ts`, handle program endpoint `on` commands by executing `ProgramExecute()` and immediately resetting the Matter state to OFF
5. In `module.ts`, handle boolean-variable endpoint writes by setting the ReGa variable value and syncing the updated state back into Matter
6. Use `regaVariablesPollingInterval` to periodically refresh boolean-variable state when polling is enabled
7. Investigate `virtualKeyForRegaPseudoPush` as an alternative or supplement to polling so variable changes can be reflected with lower latency and lower ReGa load
8. Power source for all ReGa-backed virtual endpoints: `createDefaultPowerSourceWiredClusterServer()`

**Open questions:**

- Should inactive/disabled programs be filtered out or exposed as disabled endpoints?
- Which Matter boolean device type gives the best controller compatibility for ReGa variables while still behaving like a virtual state object rather than a lamp?
- How should variable writes and external ReGa-side changes be arbitrated if polling lags behind a Matter write?
- Should `virtualKeyForRegaPseudoPush` be optional acceleration on top of polling, or a fully supported alternative when polling is set to `0`?
- Should program execution errors and variable write/read failures surface as a Matter fault state?

---

### Priority: Medium (post-2021 additions)

#### HM-12 — Door Lock Drive – pro (HmIP-DLD-pro)

**Effort: Medium** (channel type research + LOCK cluster wiring)  
**Status: Device available** (released April 2026)

The second-generation smart door lock replaces the original HmIP-DLD. It adds vibration and position sensors, auto-relock, whisper mode, and tamper detection, and is designed to integrate with the new alarm system. This is a natural Matter `doorLockDevice` mapping.

The original HmIP-DLD likely uses `KEYMATIC` or a similar lock channel type (there is already a `keymatic.ts` channel mapper in the registry). The DLD-pro may reuse the same channel type or introduce a new one — needs verification on real hardware.

**Matter mapping:**

- `LockState.LOCKED` → door locked
- `LockState.UNLOCKED` → door unlocked (latch retracted)
- `LockControl` cluster `LockDoor` / `UnlockDoor` commands → send corresponding CCU SET

**Implementation notes:**

1. Check whether `KEYMATIC` channel type already produces a usable endpoint for DLD-pro on real hardware
2. If the existing channel mapper is sufficient, only a device mapper for battery/mains classification override may be needed (DLD-pro is mains-powered via the door contact)
3. If a different channel type is introduced, add a new `doorlock.ts` channel mapper

---

#### HM-9 and HM-12 relationship

HM-12 (Door Lock Drive pro) and HM-9 (Garage door) both use `doorLockDevice` as their Matter device type but represent semantically different things. Implement them independently. HM-9 uses `doorLockDevice` as a workaround for the missing garage door type; HM-12 uses it as the canonical mapping for an actual door lock.

---

### Priority: Low (post-2021 additions)

#### HM-10 — HmIP-WSM Watering Actuator

**Effort: Low–Medium**  
**Status: Device available** (released July 2025)

Battery-powered garden watering actuator (IP44) that screws onto a standard outdoor tap. On/off valve control + integrated flow measurement (2–45 l/min). Technical data lists the function type as "Switch actuator", so the valve likely already maps via the standard SWITCH channel mapper. The new capability is the flow measurement datapoint.

**Matter mapping:**

- On/off valve → `onOffPlugin` endpoint (likely already works via SWITCH channel mapper)
- Flow measurement → second endpoint: `flowSensor` device type + `FlowMeasurement` cluster  
  (`measuredValue` in 0.1 ml/s units = `flowLitersPerMin × 100 / 6`)

**Implementation notes:**

- Verify that the valve channel appears as `SWITCH_TRANSMITTER / SWITCH_VIRTUAL_RECEIVER` on the CCU — if so, no device mapper is needed for basic on/off
- The flow datapoint name is unknown — check CCU channel listing or paramsets.json for the datapoint key (likely something like `FLOW_VALUE` or `METER_VALUE`)
- A device mapper is only needed if the flow measurement endpoint cannot be derived automatically from the channel type

---

#### HM-11 — Glass Wall Thermostat with CO2 Sensor

**Effort: Low–Medium**  
**Status: Device available** (released June 2025)

Part of the new Homematic IP glass series. Combines thermostat, humidity, and CO2 measurement in one device. The thermostat and humidity parts are covered by HM-1 (same `HEATING_CLIMATECONTROL_TRANSCEIVER` channel type). The CO2 sensor adds a new datapoint that currently has no endpoint mapping.

**Matter mapping:**

- Thermostat endpoint → same as HM-1 (HEATING_CLIMATECONTROL_TRANSCEIVER)
- Humidity endpoint → same as HM-1
- CO2 endpoint → `airQualitySensor` device type + `CarbonDioxideConcentrationMeasurement` cluster  
  (datapoint name likely `CO2_CONCENTRATION` or `CO2` — verify on real hardware)

**Implementation notes:**

- Implement HM-1 first; then this item is a small additive step on top
- The device type string for the glass thermostat CO2 variant needs to be confirmed on real hardware to register the correct device mapper key

---

#### HM-13 — RGBWW Smart Bulbs (E27 / GU10)

**Effort: Medium** (depends on channel type)  
**Status: Not yet available** (planned Q3 2026)

First-party Homematic IP RGBWW LED bulbs for E27 and GU10 sockets. Announced at Light + Building 2026. Will introduce a new RF device with color + brightness control.

**Matter mapping:** `extendedColorLight` + `ColorControl` cluster (hue, saturation, color temperature, brightness)

**Implementation notes:**

- Channel type is unknown until devices ship — likely a new type or the same COLOR type as HM-LC-RGBW-WM
- If the channel type matches HM-LC-RGBW-WM, the device mapper from HM-5 may cover these bulbs with no extra work
- Revisit when the device ships and the CCU firmware adds support

---

#### HM-14 — New eTRV generation compatibility check

**Effort: Very Low** (verification only, likely no code change)

Several new eTRV form factors were released 2024–2025:

| Model                  | Name                                                    |
| ---------------------- | ------------------------------------------------------- |
| HmIP-eTRV-E            | Radiator Thermostat – Evo (white / silver / anthracite) |
| HmIP-eTRV-pure         | Radiator Thermostat – pure                              |
| HmIP-eTRV-basic        | Radiator Thermostat – basic                             |
| HmIP-eTRV-compact-2    | Radiator Thermostat – compact 2                         |
| HmIP-eTRV-compact-plus | Radiator Thermostat – compact plus                      |

All use the same M30×1.5 valve thread and are expected to expose `HEATING_CLIMATECONTROL_TRANSCEIVER` on their functional channel — the same type already handled by the existing channel mapper. If confirmed on real hardware, no code changes are needed.

**Also in scope:** Wired variants of already-handled RF types — HmIPW-DRBL4 (blind actuator), HmIPW-DRD3 (dimmer), HmIPW-WTH-A (wall thermostat with humidity), HmIPW-SCTHD (temperature + humidity sensor), HmIPW-SMI55 (motion + illuminance sensor), HmIPW-FALMOT-C12 (floor heating actuator). These are all expected to use the same channel types as their RF counterparts and require no new mappers — verify on real hardware when available.

---

## Homebrew (hb-) device summary

Analyzed all `hb-` prefix devices from RedMatic-HomeKit. No new device mapper categories are needed specifically for homebrew devices.

| Device                                         | Verdict                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| hb-lc-bl1pbu-fm                                | Alias for HM-LC-Bl1PBU-FM → BLIND channel mapper handles it                                                                                                              |
| hb-lc-sw1pbu-fm, hb-lc-sw2-fm, hb-lc-sw2pbu-fm | SWITCH channel mapper handles all                                                                                                                                        |
| hb-uni-rgb-led-ctrl                            | Alias for hm-lc-rgbw-wm → covered by roadmap item HM-5                                                                                                                   |
| hb-uni-sen-press-sc                            | SHUTTER_CONTACT → contactSensor, already works                                                                                                                           |
| hb-uni-sen-temp-ds18b20, hb-uni-sen-temp-ir    | Temperature-only probes; if channel type is TEMPERATURE_HUMIDITY_TRANSMITTER a humidity endpoint is created with no data — minor cosmetic issue, no device mapper needed |
| hb-uni-sen-wea                                 | Uses `LUX` datapoint; WEATHER channel mapper uses `BRIGHTNESS`. May need a small fix to the WEATHER mapper to fall back to LUX, but no device mapper                     |
| hb-uni-dmx-master                              | ch1 SWITCH (STATE) + ch2-3 KEY-like (PRESS_SHORT) → standard channel types                                                                                               |
| hb-uni-senact-4-4-rc/sc and 8-8 variants       | SWITCH + SHUTTER_CONTACT — all standard mappers                                                                                                                          |

---

## Notes for future agent sessions

- Channel mapper registry: `src/ccu/channel-mapper/index.ts`
- Device mapper registry: `src/ccu/device-mapper/index.ts`
- Shared helpers: `src/ccu/mapper-utils.ts`
- Existing device mapper example: `src/ccu/device-mapper/hmip-bsm.ts`
- All types: `src/ccu/types.ts`
- Conventions (key sanitization, endpoint ID format, serial number format): see `homematic.instructions.md`
- Tests go in `vitest/` as `.test.ts` files; follow patterns in `vitest/mapper.test.ts`
- When implementing a device mapper: always check if the channel type it intercepts would otherwise produce duplicate endpoints via the generic dispatcher, and make sure `resolveChannelsForMatter` still feeds the right channels to it
