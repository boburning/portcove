# Declared executable grant consumers

## Publisher package observations

Both Linux x86-64 archives were downloaded on 2026-11-10 and matched their
publisher's sizes and SHA-256 digests. Header and metadata inspection executed
neither game.

| Consumer     | Release and asset                                            |      Bytes | SHA-256                                                            |
| ------------ | ------------------------------------------------------------ | ---------: | ------------------------------------------------------------------ |
| Paperboat    | 1.0.3, `Paperboat-Mulberry-Delta-Linux.zip`, asset 631379018 | 21,437,464 | `f6c72564e8c1485df6022aed24e33c5122815c9c6c90589411f3fbd23e56ffa2` |
| Perfect Dark | `ci-dev-build`, `pd-x86_64-linux.tar.gz`, asset 512564020    | 22,213,594 | `0f28fd59b488e0a919aae4350083059faebd462fce52df7bfdc9a4aec26f92ae` |

Paperboat has one `Paperboat.AppImage`, mode 0644, ELF64 little-endian AMD64
type 3 with the type-2 AppImage marker. Core's inspector observes that single
executable and no archive directories. Its embedded SquashFS has 313 inodes.
`AppRun` links directly to the AMD64 `usr/bin/Paperboat` with bundled libraries
under `usr/lib`. No adjacent `.home` or `.config` directory is supplied.

The embedded runtime identifies commit
`dd6cebedcbddde9c82f89b011e8e1d40b6e43868`. Its mounted route execs AppRun in
the supervised process after FUSE setup. Extract-and-run waits for the player
before cleanup. Its portable sidecars change HOME/XDG_CONFIG_HOME only for
existing writable directories and preserve explicit SHIP_HOME. Native FUSE
setup remains a host dependency. A FUSE mount was not run.
[Publisher release](https://github.com/HarbourMasters/PaperBoat/releases/tag/1.0.3),
[identified runtime](https://github.com/AppImage/type2-runtime/blob/dd6cebedcbddde9c82f89b011e8e1d40b6e43868/src/runtime/runtime.c).

Perfect Dark has `pd.x86_64`, `pd.pal.x86_64` and `pd.jpn.x86_64` inside
`pd-x86_64-linux`, all mode 0644, ELF64 little-endian AMD64 type 3. Only
`pd.x86_64` matches the declared US Rev 1 source. Other regional players remain
archive-owned and receive no grant. Core's earlier extraction reached the
missing-executable-bit refusal for this same verified archive. The layout-only
inspector refuses a reviewed declaration because its executable set is empty.
Its observer uses executable bits or known executable suffixes, while these
unmarked players end in `.x86_64`. The refusal comes from that shape contract.
This contribution makes no reviewed-layout claim or decoder change.
[Publisher inventory](https://github.com/perfect-dark-pc-port/perfect_dark/releases/tag/ci-dev-build),
[retained extraction finding](linux-packages-without-executable-bits-2026-11-10.md).

## Source, preparation and persistent writes

Paperboat 1.0.3 resolves to `7f038b8552b1bf5c297a5fd06738d8f245851833`.
Its pinned Libultraship `7f1bd60e9442d83acd3bee00c9d8a07270d0777e` returns
SHIP_HOME as the Linux application directory before default profile resolution.
The same declared AppImage serves private setup and Play. GameExtractor sends
output there. Core supplies private SHIP_HOME during graphical preparation and
canonical user data during Play. `pm64.o2r` and optional `torch.hash.yml` remain
version-owned generated outputs. Setup-only configuration and logs remain
private. Player-owned `mods`, `saves`, `default.sav`, `paperboat.cfg.json`,
`imgui.ini` and `cvars.cfg` retain their paths. Current SaveManager writes
`saves/globals.json` and save-slot JSON there. Windows permission probes skip
on Linux. Source normalization still requires canonical SHA-1
`3837f44cda784b466c9a2d99df70d77c322b97a0`.
[Extractor](https://github.com/HarbourMasters/PaperBoat/blob/7f038b8552b1bf5c297a5fd06738d8f245851833/src/port/extractor/GameExtractor.cpp),
[application roots](https://github.com/JeodC/libultraship/blob/7f1bd60e9442d83acd3bee00c9d8a07270d0777e/src/ship/Context.cpp),
[SaveManager](https://github.com/HarbourMasters/PaperBoat/blob/7f038b8552b1bf5c297a5fd06738d8f245851833/src/port/save/SaveManager.cpp).

Perfect Dark's observed rolling tag resolves to
`32a1cb9f268dd3ac73016801025c6bbbfa20130f`. Existing `--portable` pins
base data to the executable's `data` directory and defaults saves/config to
its executable directory. Core stages `data/pd.ntsc-final.z64` there from
the exact source profile. The unchanged seven persistent paths cover `pd.ini`,
`eeprom.bin`, `pd.log`, `pd.crash.log`, `mods`, `modconfig.txt` and that
materialized source. EEPROM uses the save directory. Controller-pak functions
return NOPACK. Custom command-line root overrides remain outside this default
managed contract. The grant adds no generated-cache data ownership.
[Filesystem](https://github.com/perfect-dark-pc-port/perfect_dark/blob/32a1cb9f268dd3ac73016801025c6bbbfa20130f/port/src/fs.c),
[EEPROM and controller paks](https://github.com/perfect-dark-pc-port/perfect_dark/blob/32a1cb9f268dd3ac73016801025c6bbbfa20130f/port/src/libultra.c).

## Reader and operation boundary

The existing installer stages the archive, resolves the single declared player,
verifies its platform header and grants a missing bit before creating the normal
manifest under the captured definition. The manifest records executable intent.
Libultraship4 and GeneratedCache2 provide independent lower bounds. Native22
retains OpenJazz. Fresh and retained entry checks refuse a grant with an older
floor, unsupported adapter or Windows-only route. Flag-free entries remain
readable. Windows operations, original identities and persistence paths retain
their contracts.

Shared independent release-selection inputs cover observed Paperboat releases
1.0.0 and 1.0.3 and a controlled Perfect Dark republish with changed asset
identities/digests under the same rolling tag. The republish is synthetic.
Selection uses an unchanged definition and preserves Mac, Switch, x86 and
Flatpak exclusions. Existing binary-header, executable-intent, installer,
private-preparation and generated-cache tests retain their roles.

## Sibling routes and evidence limits

Paperboat's Mac ZIP requires nested DMG materialization. Perfect Dark's Intel
and ARM64 Mac packages use TAR.XZ, while the existing opt-in declaration is
restricted to native Linux routes. Those archive/capability contracts need
separate implementation before admission. The two verified Linux routes can
proceed independently. Upstream listing/setup guidance and qualified
managed/native operations retain separate meanings.

No proprietary source or game was run. Native Linux/FUSE execution, real-save
interoperability, Mac execution, protected publication and stronger qualification
remain separate. Exact validation, independent review, CI and guarded delivery
receipts belong to the implementing PR.
