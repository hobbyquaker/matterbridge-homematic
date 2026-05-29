<!-- eslint-disable markdown/no-missing-label-refs -->

# <img src="https://matterbridge.io/assets/matterbridge.svg" alt="Matterbridge Logo" width="64px" height="64px">&nbsp;&nbsp;&nbsp;matterbridge-homematic changelog

All notable changes to this project will be documented in this file.

If you like this project and find it useful, please consider giving it a star on GitHub at https://github.com/hobbyquaker/matterbridge-homematic and sponsoring it.

<a href="https://www.buymeacoffee.com/luligugithub"><img src="https://matterbridge.io/assets/bmc-button.svg" alt="Buy me a coffee" width="120"></a>

> ## Periodical Updates
>
> Keeping your plugin repository aligned with the latest template is important for security, CI reliability, and developer experience. See the Periodical Updates section in the [README](README.md#periodical-updates) for guidance on what to periodically copy/update (e.g., `.devcontainer`, workflows, and tooling configs).

## [Unreleased]

### Added

- Auto-disable newly discovered channels from interfaces with `newDevicesDefaultEnabled: false` (UX-2).
- Per-interface summary of enabled device type models logged after discovery.
- `migrateSelectListEntriesToSerial` — migrates legacy channel-name-keyed select list entries to stable serial keys on startup (RN-0).

### Changed

- Schema uses `selectFrom: "serial"` for `whiteList` and `blackList`; the Matterbridge UI now writes the stable `selectSerial` key on every checkbox toggle, making the lists immune to CCU ReGa renames (RN-0).
- `refreshDeviceNames` is now `async` and propagates the updated name to the Matter `nodeLabel` attribute via `updateAttribute` (RN-0).

### Removed

- `syncChannelListEntriesWithRegaNames` and `migrateChannelListEntry` (superseded by `migrateSelectListEntriesToSerial`).
- Proof-of-concept device mapper `hmip-bsm.ts`; HmIP-BSM is fully handled by the standard channel mappers.