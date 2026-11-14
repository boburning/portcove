# mstan SNES recompilations brought forward — 2026-11-14

Owners: canonical port issues [#147](https://github.com/boburning/portcove/issues/147)
(Super Mario World), [#151](https://github.com/boburning/portcove/issues/151)
(A Link to the Past) and [#164](https://github.com/boburning/portcove/issues/164)
(Super Metroid). This dated record is a static review of each route's newest
published Windows package and tagged source against its reviewed route. It
appends one exact applicability row and one `upstream_support` evidence record
per route. Historical rows, evidence and qualifications keep their exact scope.
Nothing was installed, launched or played, and no Supported or gameplay claim
is made.

## Result

| Port / issue                                                | Reviewed → appended | Definition change                                                                     |
| ----------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| `super-mario-world-recomp` / #147                           | v0.12.0 → v0.15.9   | Persist `mods/preloaded/state.toml` and its `.tmp` companion beside the retained pair |
| `the-legend-of-zelda-a-link-to-the-past-snes-recomp` / #151 | v0.6.1 → v0.6.6     | The same two paths; the license note names the reviewed v0.6.6 package                |
| `super-metroid-recomp` / #164                               | v0.4.2 → v0.4.5     | None                                                                                  |

## Exact artifacts

Each package was downloaded with `python3 -I` from its `releases/download` URL
into its own new empty directory. Its SHA-256 and size were computed from the
bytes. It was compared with the publisher's checksum file where one exists, then
read only through Python's `zipfile` and a PE import-table reader, and the
directory was deleted afterwards. The bound packages were downloaded again and
still match their catalog digests.

| Package                                         |      Bytes | SHA-256                                                            | Publisher checksum                                                  | Tag commit                                 |
| ----------------------------------------------- | ---------: | ------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------ |
| `SuperMarioWorldRecomp-windows-x64-v0.15.9.zip` | 26,746,609 | `8603cc1097348284215f09c1de644026dafb96ea4da7533bbdf5d3f02fc0ef82` | None at `SHA256SUMS`, `SHA256SUMS.txt`, `sha256sums.txt`, `.sha256` | `8c280aac7ea08456372cd2b42603bb2ad7ab51eb` |
| `ZeldaALttPSNESRecomp-windows-x64-v0.6.6.zip`   | 12,990,200 | `53b613b86e87bfacc8462f485047c7fd22f82886dac69087aa0f0ef15eca7be2` | Matches `SHA256SUMS.txt`                                            | `961724bb5e09227207df5cf62f4b79b21e7c4452` |
| `supermetroid-0.4.5-windows-x64.zip`            | 15,522,852 | `337c1daa92bc74b6f7dcd881366d9791b8d7bb0710b1c945f5b88ee07d20a314` | Matches `SHA256SUMS`                                                | `113951fc32f9783c1be0a947ea17c9aabfba9066` |

The Super Mario World digest is computed only; it does not authenticate the
download. Re-downloaded bound packages: SMW v0.12.0 `1609aa46…19fd` (9,490,376
bytes), ALttP v0.6.1 `b53f5ab7…4632` (11,388,312 bytes) and Super Metroid
v0.4.2 `72b7c179…d531` (14,907,383 bytes, also matching its `SHA256SUMS`).

## Method

Tags came from `git ls-remote --tags`. Each game repository was fetched at its
tag, and the pinned `snesrecomp`, `recomp-ui` and `recomp-net` commits from its
submodules or `framework_pins.txt` were fetched by commit. Sources were read
with `git show` and `git grep` only; no upstream build, script or binary ran.
The writer inventory compared, between the reviewed and new pins, every
write-mode `fopen`, `ofstream`, directory creation and rename in the game
sources, and every path-like string literal in the game, framework runtime and
launcher sources. Each new literal was traced to its caller and gate.

| Route              | Game tag | `snesrecomp` reviewed → new | `recomp-ui` reviewed → new | `recomp-net` reviewed → new |
| ------------------ | -------- | --------------------------- | -------------------------- | --------------------------- |
| Super Mario World  | v0.15.9  | `266804e8…` → `3d73fa26…`   | `a767bd06…` → `2816a54e…`  | `30772f6e…` → `7a4d330e…`   |
| A Link to the Past | v0.6.6   | `ad7860b7…` → `68896b6f…`   | `58e9d727…` → `eaf99cac…`  | `79f84323…` → `8c76fb64…`   |
| Super Metroid      | v0.4.5   | `6ca2dbbe…` (unchanged)     | `7fdd3a87…` (unchanged)    | `445eed76…` (unchanged)     |

## Super Mario World v0.15.9

Original identity is unchanged: tagged `src/main.c` keeps CRC `B19ED489` and
SHA-256 `0838e531…7f5b`, and still accepts the positional `smw.sfc` argument.
`SuperMarioWorldSNESRecomp.exe` keeps its root path.

Package changes against v0.12.0:

- The mod root moved from `mods` to `mods/preloaded`
  (`SNES_MOD_CATALOG_ROOT` in the pinned framework). The five packaged manifests
  now sit under `mods/preloaded/packages/` and remain immutable package files.
- Added programs: `smw-falcon-cache.exe`, `smw-controller-report.exe`,
  `Collect-Controller-Diagnostics.cmd` and `.ps1`. Added `falcon-cache-licenses/`,
  `CONTROLLER_DIAGNOSTICS.md`, `assets/shaders/`, `assets/img/flags.png` and
  `libiconv-2.dll`. The MinGW runtime DLLs are gone. `config.ini` is still
  shipped with new defaults.
- The player adds `BCRYPT.DLL`, `IPHLPAPI.DLL`, `D2D1.DLL` and `DWRITE.DLL`
  imports. v0.12.0 already imported `WS2_32.DLL`.

Writers reachable from the managed launch (`smw.sfc` positional argument with
`SNESRECOMP_NO_LAUNCHER=1`):

- The mod runtime commits the selection at every start to
  `mods/preloaded/state.toml` through `mods/preloaded/state.toml.tmp`. **Decision:**
  declare both as persistent. The retained `mods/state.toml` pair stays declared
  so installations created from v0.12.0 keep that data. v0.15.9 does not read
  or migrate the old file, so a player's earlier mod selection starts from the
  package defaults after the update. The old file is preserved, not deleted.
- Native co-op writes `saves/native-coop-v1/` (including `last-mode.txt`) and
  `saves/native-coop-menu`, and content variants use `saves/variants/`. All are
  already covered by `saves`.
- `config.ini`, `keybinds.ini`, `rom.cfg`, `last_run_report.json`, the write
  probe and crash reports keep their existing declarations.
- Optional Falcon setup spawns the bundled `smw-falcon-cache.exe`, whose cache and
  result file live under `%LOCALAPPDATA%`. The existing setup text already says
  that cache is outside Portcove backups.

Writers that the managed launch does not reach:

- Netplay, account sign-in (a `netplay_secret` credential beside the
  executable), `moderation.ini`, `saves/netplay/` and peer mod transfer, which
  can install or replace packages under `mods/preloaded/packages/`. These are
  offered only by the pre-boot launcher or the `SNES_NETPLAY` and
  `SMW_NET_AUTO_ROLE` environment variables. The positional ROM argument and
  `SNESRECOMP_NO_LAUNCHER` skip that launcher, and the game has no other path
  back to it outside a lobby-started match. `netplay_lan_lobby.txt` already
  existed in v0.12.0's lobby code.
- Diagnostic replay recording under `logs/` belongs to the
  `super-mario-world.developer.diagnostics` package, whose feature has
  `default_enabled = false`; with no launcher its selection does not change.
  Its fallback is `%TEMP%`.
- The controller diagnostics script writes `diagnostics/` (or
  `%LOCALAPPDATA%\SuperMarioWorldRecomp\diagnostics`) only when the player runs it.
- Tier-2 coverage now writes under `%LOCALAPPDATA%\snesrecomp-coverage`, only
  when enabled; this game does not enable it.

If a player runs one of these outside Portcove, the files are undeclared. Under
the portable-install rules from #5487, regular data files there are harmless
unknown files: they do not block maintenance, are not carried across updates
and are only backed up in the separate unknown-file area. A peer-replaced
packaged manifest is a changed package file and holds maintenance.

## A Link to the Past v0.6.6

Original identity is unchanged: `rom_identity.txt` and `src/main.c` keep CRC
`777AAC2F` and SHA-256 `66871d66…9cfb`. v0.6.1 accepted a second hash, which is
gone; the route only ever admitted the stock original. The positional `zelda.sfc`
argument is unchanged. `ZeldaALttPSNESRecomp.exe` stays the only program.

Package changes against v0.6.1: `config.ini` is no longer shipped. The packaged
widescreen manifest moved to `mods/preloaded/packages/` and an MSU-1 manifest
was added. `LICENSE` (PolyForm Noncommercial 1.0.0), `docs/` and
`assets/img/flags.png` were added. The MinGW runtime DLLs are gone, and
`D2D1.DLL` and `DWRITE.DLL` imports were added. No `IPHLPAPI.DLL` import appears.

Writers: the game's own `src/main.c` and `src/config.c` write the same
`config.ini`, `rom.cfg` and copied-ROM paths as v0.6.1. `config.ini` remains
persistent and is now created by the player on first run. The pinned framework
moved the mod root to `mods/preloaded`. **Decision:** persist
`mods/preloaded/state.toml` and `.tmp` beside the retained `mods/state.toml`
pair, as for Super Mario World. The `tier2_coverage.json` writer beside the
executable is gone; tier-2 coverage now uses `%LOCALAPPDATA%` and is off. The
runtime-mutable declaration stays so that v0.6.1 installations keep their
verification allowance. The recomp-ui `moderation.ini`, sign-in and netplay
writers are only in the pre-boot launcher, which the positional launch skips,
and this game has no netplay environment entry point.

The setup text's license note now names the reviewed v0.6.6 package, which
contains the PolyForm Noncommercial 1.0.0 `LICENSE` file.

## Super Metroid v0.4.5

Original identity is unchanged: `rom_identity.txt` is byte-identical to v0.4.2.
`framework_pins.txt` names the same `snesrecomp`, `recomp-ui`, `recomp-net` and
`rbengine` commits as v0.4.2. The game sources add no new path literal or
write call. Against v0.4.2 the wrapper-prefixed file list adds only
`mods/preloaded/packages/super-metroid.run-by-default/1.0.0/manifest.toml`,
`mods/preloaded/packages/super-metroid.single-missile-doors/1.0.0/manifest.toml`
and `PERMISSIONS.md`. `SuperMetroidSNESRecomp.exe` keeps its path.

The behavior change is that the release workflow now builds with
`-DSNESRECOMP_ENABLE_NET=ON`, adding `IPHLPAPI.DLL` and `BCRYPT.DLL` imports.

**Network ownership decision.** The pinned desktop host offers netplay, account
sign-in, `moderation.ini`, `saves/netplay/` and peer mod transfer in two places
only. The first is the pre-boot launcher, and only outside a running session.
The second is the `SNES_NETPLAY` environment. The managed route passes
`--rom game.sfc` with `SNESRECOMP_NO_LAUNCHER=1`, which skips the pre-boot launcher
whatever the arguments say. The in-game launcher is opened with
`in_session = 1` and does not offer netplay, and its setting restarts relaunch
with `--no-launcher` and an inherited environment. No owner decision is needed
to keep these features unavailable through the managed launch, so no
environment variable is added. Adding one would also change the retained
launch contract, and existing installations would then refuse the update.

The declared persistence and `archive_data_compatibility_v1` are unchanged.
Core holds any added persistent path on a partitioned route as a contract
migration, so a change here would not be an additive grant. The two new
manifests are immutable package files.

The release notes describe migrating the old Widescreen choice into separate
Widescreen and Continuous Rooms switches. `sm-video.ini` is a shared path, and
the mod selection is bound to its producing archive. Whether the migrated
choices read correctly after a rollback to v0.4.2 was not observed.

## Existing installations

The Super Mario World and A Link to the Past changes only add persistent paths.
Every earlier persistent and runtime-mutable path stays declared. Statically,
from `service/native_portable.rs` and `installed_mutability.rs`:

- An installation from the reviewed release can use the current definition's
  added paths for verification only where they overlap no recorded package file.
  Neither old package ships anything under `mods/preloaded`.
- Update from v0.12.0 or v0.6.1 runs the existing empty-expansion check. The
  added paths must be absent from the active runtime, canonical data and the
  staged target, must not overlap another declared path, and must not cover a
  package file. Old runtimes never write `mods/preloaded`, so this passes, and
  the existing data, including `mods/state.toml`, is carried forward.
- Rollback from the new release to the old one uses the same proof in reverse.
  It is held once the new runtime has written `mods/preloaded/state.toml`, with
  both copies and all data preserved. This is the documented behavior of the
  current contract.

No definition-format fence or transition guard is added. The changed fields
are persistent paths of an embedded definition, which require no new reader
capability. Super Metroid's update path is unchanged.

## Newer release seen during review

Super Metroid v0.4.6 (`9a765fdc4ce80ac9cf6147f776f98220b7013ed36210e71f4053463496ec8429`,
15,528,551 bytes, matching its `SHA256SUMS`; tag `af6c5efebdd86ef0e1933b5f6910a457f1c52b9c`)
was published after the November 13 survey. Its framework pin `8d60b2b8…`
changes four files. It adds a pause-menu **Quit to launcher** item that ends the
game and relaunches the executable with `--launcher`. With the managed route's
inherited `SNESRECOMP_NO_LAUNCHER=1`, that relaunch starts the game again in a
successor process instead of opening the launcher. Its package file list equals
v0.4.5's. This record does not bind v0.4.6. The source contract's
`integration-contract-v1` policy already admits it for fresh acquisition without
a reviewed binding. Its successor-process behavior needs its own review on #164.

## Not observed

- Publisher release metadata: draft and prerelease flags, asset IDs and provider
  digests. The GitHub API and release pages were unavailable to this session.
  Publication rests on stable tag names and resolving asset URLs.
- Any runtime behavior: launch, first-run file creation, actual write locations,
  network traffic or its absence, settings migration, save compatibility and
  gameplay. Reachability above is static source reading.
- Linux and macOS Super Metroid v0.4.5 packages. Their `SHA256SUMS` entries
  were read but not bound.
- Intermediate tags between each reviewed and newest release.
- Core lifecycle execution: the update, empty-expansion and rollback outcomes
  above come from reading the code, not from an isolated library run.
