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
