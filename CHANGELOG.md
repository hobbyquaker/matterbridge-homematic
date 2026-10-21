<!-- eslint-disable markdown/no-missing-label-refs -->

## [Unreleased]

### Added

- Auto-disable newly discovered channels from interfaces with `newDevicesDefaultEnabled: false` (UX-2).
- Per-interface summary of enabled device type models logged after discovery.
- `migrateSelectListEntriesToSerial` — migrates legacy channel-name-keyed select list entries to stable serial keys on startup (RN-0).

### Changed

- `newDevicesDefaultEnabled` now defaults to `false`: newly discovered channels (including on first install and after re-enabling an interface) start disabled and must be enabled individually. Set it to `true` to restore the old behavior.
- Schema uses `selectFrom: "serial"` for `whiteList` and `blackList`; the Matterbridge UI now writes the stable `selectSerial` key on every checkbox toggle, making the lists immune to CCU ReGa renames (RN-0).
- `refreshDeviceNames` is now `async` and propagates the updated name to the Matter `nodeLabel` attribute via `updateAttribute` (RN-0).

### Removed

- `syncChannelListEntriesWithRegaNames` and `migrateChannelListEntry` (superseded by `migrateSelectListEntriesToSerial`).
- Proof-of-concept device mapper `hmip-bsm.ts`; HmIP-BSM is fully handled by the standard channel mappers.

## [1.0.6] - 2026-10-21

### Fixed

- Mains-powered devices no longer get battery attributes written to their wired PowerSource cluster. HmIP actuators such as the HmIP-FBL report `OPERATING_VOLTAGE` without `LOW_BAT`; the plugin wrote `batPercentRemaining` (and, from the startup service messages, `batChargeLevel`) to them and Matter rejected it with `Conformance "BAT": Matter does not allow you to set this attribute`. Battery attributes are now only written when the endpoint's PowerSource cluster has the Battery feature (#6, @matthiasnhoffmann-design).

## [1.0.5] - 2026-10-21

### Fixed

- The plugin starts again with Matterbridge 3.10.14: its `getSelectDevices()` now returns `serialNumber` instead of `serial`, so the disabled-interface cleanup read `undefined` and failed with `Cannot read properties of undefined (reading 'startsWith')`. Both shapes are read, and select devices or list entries without a string serial are skipped with a debug line (#6, @matthiasnhoffmann-design).
