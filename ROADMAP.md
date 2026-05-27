# Device Mapper Roadmap

> Last reviewed: May 2026  
> Reference prior-art: https://github.com/rdmtc/RedMatic-HomeKit/tree/master/homematic-devices

---

## What already works without device mappers

The channel-mapper registry and `resolveChannelsForMatter` handle all of the following correctly out of the box:

| Device family | Reason |
|---|---|
| HmIP-DRSI1/4, MOD-OC8 | `SWITCH_TRANSMITTER → SWITCH_VIRTUAL_RECEIVER` pairing |
| HmIP-BBL, BROLL, FROLL, DRBLI4 | `BLIND_TRANSMITTER → BLIND_VIRTUAL_RECEIVER` pairing |
| HmIP-BDT | `DIMMER_TRANSMITTER → DIMMER_VIRTUAL_RECEIVER` pairing |
| HmIP-FSM, FSM16, PS, PSM, BSM | No LOW_BAT marker → `batteryPowered = false` automatically; power-meter merging works |
| HmIP-BWTH | BLIND + THERMALCONTROL_TRANSMIT → two independent endpoints |
| HmIP-STE2-PCB, STE2+  | Each TEMPERATURE_HUMIDITY_TRANSMITTER channel maps independently |
| HmIP-HEATING (VirtualDevices) | Uses HEATING_CLIMATECONTROL_TRANSCEIVER; channel 5 is already skipped |
| HmIP-eTRV, HmIP-eTRV-2/B/C | HEATING_CLIMATECONTROL_TRANSCEIVER channel mapper |
| HM-CC-RT-DN | THERMALCONTROL_TRANSMIT channel mapper (basic thermostat) |
| HmIP-BSL | KEY + SWITCH channels map independently |
| HmW-Sen-SC-12, HmW-IO-12-SW7-DR | Each channel maps independently |
| hb-lc-bl1pbu-fm | Alias for HM-LC-Bl1PBU-FM → BLIND channel mapper |
| hb-lc-sw1pbu-fm, hb-lc-sw2-fm, hb-lc-sw2pbu-fm | All SWITCH channels → SWITCH channel mapper |
| hb-uni-senact-4-4-rc/sc and 8-8 variants | SWITCH + SHUTTER_CONTACT channels → standard mappers |
| hb-uni-sen-press-sc | SHUTTER_CONTACT on ch2 → contactSensor |
| hb-uni-sen-temp-ds18b20, hb-uni-sen-temp-ir | Multi-probe TEMPERATURE channels; each maps independently |
| hb-uni-dmx-master | ch1 SWITCH + ch2-3 KEY-like; standard channel types |
| hb-uni-sen-wea | WEATHER channel mapper (minor: uses LUX instead of BRIGHTNESS for light sensor) |

---

## Planned device mappers

### Priority: High

#### 1 — Wall thermostat humidity endpoint (HmIP-WTH / STH / STHD family)

**Effort: Low** (~40 LOC + tests)

The `HEATING_CLIMATECONTROL_TRANSCEIVER` channel on HmIP-WTH, WTH-2, WTH-B, STHD, STH also carries a `HUMIDITY` datapoint. The current channel mapper creates only a thermostat endpoint. A device mapper should additionally return a `humiditySensor` endpoint built from the same channel address.

RedMatic prior art: `hmip-wth.js`, `hmip-sthd.js` — both offer an optional `HumiditySensor` service. In Matter we always include it (no reason not to).

**Implementation notes:**
- Device mapper calls `mapHeatingClimateControlTransceiverChannel(switchChannel, vendorId, options)` for the thermostat endpoint
- Builds a second `MatterbridgeEndpoint([humiditySensor])` from the same channel address, with `HumidityMeasurement` cluster
- Returns both endpoints from `mapDevice`
- Device mapper files: `src/ccu/device-mapper/hmip-wth.ts` (covers WTH, WTH-2, WTH-B)  
  and `src/ccu/device-mapper/hmip-sthd.ts` (covers STHD, STH) — or one shared helper

---

#### 3 — HM-CC-VG-1 virtual thermostat group

**Effort: Low–Medium** (endpoint creation is easy; event routing needs research)

The CCU exposes thermostat groups via `VirtualDevices` as `HM-CC-VG-1` with a `THERMALCONTROL_TRANSMIT` channel. The channel mapper creates the thermostat endpoint correctly. The open question is whether SET commands sent to the group channel address are routed correctly by the CCU (they likely are, since it is a virtual device group address). Needs a real device to verify.

RedMatic prior art: `hm-cc-vg-1.js` — uses the group device address directly for all get/set operations.

**Implementation notes:**
- May require no device mapper at all if the VirtualDevices interface routes SET correctly
- If routing needs a different target address, add `groupTargetAddress` to `CcuChannelInfo` or handle in `module.ts`
- Worth testing on real hardware before building

---

#### 6 — HM-SEC-SIR-WM security alarm panel

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

#### 5 — HM-LC-RGBW-WM / hb-uni-rgb-led-ctrl color light

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

### Priority: Low

#### 4 — HmIP-SWDO optional garage door mode

**Effort: Low–Medium**

HmIP-SWDO (motorized window/door opener) uses a boolean `STATE` on its channel (likely `SHUTTER_CONTACT` type). The standard `contactSensor` mapping is correct by default. Optionally, the user could expose it as a garage door / motorized door with toggle control.

RedMatic prior art: `hmip-swdo.js` — defaults to ContactSensor, can be configured as GarageDoorOpener, Door, or Window.

**In Matter:** No native garage door device type. Options: `doorLockDevice` (binary lock/unlock semantic), or `coverDevice` (0%/100% only). Neither is perfect. Low priority until there is user demand.

---

#### 7 — HmIP-MOD-HO / MOD-TM garage door / gate motor

**Effort: Medium**

Motorized garage door or gate. Accesses `DOOR_STATE` and `DOOR_COMMAND` datapoints on channel 1. The actual Homematic channel type for this channel is unknown — needs checking in paramsets.json or on real hardware. In Matter, closest mapping is `coverDevice` (open=100%, closed=0%) with toggle control.

RedMatic prior art: `hmip-mod-ho.js` and `hmip-mod-tm.js` (alias for MOD-HO).

**Research needed first:** Confirm the channel type string that appears in `listDevices` for this device before deciding whether this needs a new channel type in `SUPPORTED_CHANNEL_TYPES` or is handled entirely within a device mapper.

---

## Homebrew (hb-) device summary

Analyzed all `hb-` prefix devices from RedMatic-HomeKit. No new device mapper categories are needed specifically for homebrew devices.

| Device | Verdict |
|---|---|
| hb-lc-bl1pbu-fm | Alias for HM-LC-Bl1PBU-FM → BLIND channel mapper handles it |
| hb-lc-sw1pbu-fm, hb-lc-sw2-fm, hb-lc-sw2pbu-fm | SWITCH channel mapper handles all |
| hb-uni-rgb-led-ctrl | Alias for hm-lc-rgbw-wm → covered by roadmap item #5 |
| hb-uni-sen-press-sc | SHUTTER_CONTACT → contactSensor, already works |
| hb-uni-sen-temp-ds18b20, hb-uni-sen-temp-ir | Temperature-only probes; if channel type is TEMPERATURE_HUMIDITY_TRANSMITTER a humidity endpoint is created with no data — minor cosmetic issue, no device mapper needed |
| hb-uni-sen-wea | Uses `LUX` datapoint; WEATHER channel mapper uses `BRIGHTNESS`. May need a small fix to the WEATHER mapper to fall back to LUX, but no device mapper |
| hb-uni-dmx-master | ch1 SWITCH (STATE) + ch2-3 KEY-like (PRESS_SHORT) → standard channel types |
| hb-uni-senact-4-4-rc/sc and 8-8 variants | SWITCH + SHUTTER_CONTACT — all standard mappers |

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
