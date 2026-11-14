# N64 recompilation source applicability: four managed routes

Dated evidence from November 14, 2026. A backlog survey found four managed
`n64-recomp-portable` routes whose game-source contract still applied only to
an older release than the newest upstream tag. Three routes now also apply to
their newest release: Castlevania: Legacy of Darkness Recompiled, Golden
Balloon and Road Rash 64 Recompiled. Snap64 Recomp stays on v1.0.5 because its
newer player adds a writer outside the reviewed data contract (below).

This is static evidence. No upstream program, script or build was executed.
Archives were read with Python `zipfile` and `tarfile`. Text members, tagged
source files and program string tables were read as data.

## Method

The release API and release pages are blocked by this session's proxy. Newest
tags come from `git ls-remote`. Asset names were derived from each route's
selector and the naming of its bound asset, then confirmed to resolve at the
release download URL. Each artifact was downloaded alone into an empty folder
and deleted after inspection.

For each route, the newest managed package of every managed platform was
compared with the bound package for:

- **Integrity:** the SHA-256 of the downloaded bytes against the publisher's
  `.sha256` file or `SHA256SUMS.txt`. The provider release digest was not read.
- **Layout:** the top-level folders, every program path, the executable name
  and location, links, unsafe or case-colliding paths. One version-named wrapper
  folder is looked through, as Core does.
- **Data:** the tagged source files that choose the data folder and write
  settings and saves, read from raw.githubusercontent.com at both tags, and the
  data filenames, environment variables and URLs in the player's string table.
- **Original game file:** the tagged files that declare or check its identity.

Each route selects its newest stable release. The tags between the bound and
newest release were not examined individually, except where noted.

## Results

| Route                              | Tags              | Platform          | Bytes      | SHA-256                         | Result      |
| ---------------------------------- | ----------------- | ----------------- | ---------- | ------------------------------- | ----------- |
| `cvlod-recomp`                     | v0.2.26 → v0.2.29 | Windows x64       | 29,763,505 | `68a2ae45bff297583a2e12d0…2b23` | requalified |
|                                    |                   | Linux x64         | 55,162,656 | `0d9e54387efa82fa74ceaa58…3aad` | requalified |
|                                    |                   | macOS arm64       | 21,232,725 | `fdedea70286fff585ec67160…e1f8` | requalified |
| `diddy-kong-racing-golden-balloon` | v1.7.0 → v1.8.0   | Windows x64       | 31,898,069 | `98ab31dd7108e478cc1469b3…b0e1` | requalified |
| `road-rash-64-recompiled`          | v1.4.3 → v1.4.9   | Windows x64       | 47,342,604 | `74948ebc0dbfd37c95ce5468…1594` | requalified |
| `snap64-recomp`                    | v1.0.5 → v1.1.7   | Windows x64       | 18,834,158 | `fcf7950f200c3006557aa4c5…0c95` | deferred    |
|                                    |                   | Linux x86-64      | 9,821,880  | `d2ab64531be1b680c4bc995b…233d` | deferred    |
|                                    |                   | macOS (universal) | 12,752,773 | `ad8c54692afbdc8b09d5860a…9f50` | deferred    |

Every listed digest matched the publisher's checksum file. Every bound package
was downloaded again, and its SHA-256 matched the existing applicability.

Each requalified contract keeps its existing applicability first and appends
the exact newest artifact digests. Each requalified route has one new
`upstream_support` evidence record. Source profiles, other source-contract fields, admission,
definitions, platforms, support tiers and qualification records are unchanged.

### Castlevania: Legacy of Darkness Recompiled

The v0.2.29 tag resolves to `2be8acde176c21aecf05a35f1748a587be2e8381`.

- **Original game file:** `castlevania2.yaml` and `include/lod/target_rom.hpp`
  are byte-identical to v0.2.26. They keep the North American SHA-1
  `879ead98f197fd05edda867655da5b1ce25aa5b8`.
- **Layout:** on Windows and Linux, the wrapper folder is now
  `LodRecomp-ab942ba9-<platform>` instead of `LodRecomp-v0.2.26-<platform>`.
  Inside it, the 53 Windows and 59 Linux entries have the same paths and
  modes as v0.2.26. The macOS `LodRecomp.app` list is identical. `LodRecomp`
  (`LodRecomp.exe` on Windows) is still the only program, at the same place.
  Only the player, `assets/lod_config.rml`, and on Windows seven bundled DLLs
  changed by content. On macOS `Info.plist` and the code signature also changed.
- **Data:** `src/main/main.cpp` keeps the same `portable.txt` lookup and
  `rom.z64` default. It writes `graphics.json`, `audio.json`, `controls.json`,
  `rom_path.txt`, `cheats.cfg` and `LodRecomp.log` in the data folder, all of
  them already declared. `cheats.cfg` was added in v0.2.27 and is already
  persistent. The player's strings add `cheats.cfg` and six opt-in
  `LOD_CHEAT_*` variables, which Portcove does not set. No URL was added.
- **Provenance:** the wrapper names commit `ab942ba9`, not the tag commit. At
  `ab942ba9`, the five files read (`castlevania2.yaml`, `target_rom.hpp`,
  `main.cpp`, `CMakeLists.txt` and `README.md`) are byte-identical to the tag.
  Whether `ab942ba9` is the tag commit's ancestor was not established.

The [known v0.2.26 Windows normal-close failure](cvlod-shutdown-and-maintenance-2026-10-19.md)
is not resolved by this evidence, and its hold stays as recorded on #320.

### Golden Balloon

The v1.8.0 tag resolves to `2b69e748ec04f87a4dc6f032c598726de1b0e813`. This
is the source commit and archive that the route's game settings already
reviewed.

- **Original game file:** `platform/rom_validation.c` is byte-identical to
  v1.7.0, so the US Rev 1 and European Rev 1 checks are unchanged.
- **Layout:** the 38-entry `GoldenBalloon/` folder lists the same paths as in
  v1.7.0. `GoldenBalloon.exe` and the three `tools/` programs keep their
  paths. Only `GoldenBalloon.exe`, `tools/mdkr-character-lod.exe`, `README.md`
  and `NativePhoneParty-NOTICES.txt` changed by content.
- **Data:** `platform/config_ini.c`, `platform/app/app_config.cpp` and
  `platform/app/arg_triage.h` are byte-identical. `platform/user_paths.c` adds
  only an `MDKR_MODS_DIR` override, which Portcove does not set. The player's
  strings add no data filename except `desktop.ini`; `pack.ini` already
  appears in the v1.7.0 player's strings, and the v1.7.0 README describes `pack.ini`, a file inside a player's texture
  or music pack. The added variables are opt-in overrides and test,
  trace and online-test switches, none of which Portcove sets. No URL was
  added.

### Road Rash 64 Recompiled

The v1.4.9 tag resolves to `37e33d4f832857a60a34f1369b83b32afe00d25d`. The
package's `docs/BUILD_INFO.json` names the same source commit.

- **Original game file:** `docs/PROJECT_DETAILS.md` now carries the README's
  former SHA-1 line, `87727a298f583ec8325f5655088ff21e37b335b2` for the USA
  v1.0 32 MiB original. `native/src/rr64_experimental_course.cpp` is
  byte-identical to v1.4.3 and requires SHA-256
  `74e49e863484b5d17dcbe3891b99f2cafe3cf7511aa1dc5427022f699301db73`.
- **Layout:** the package keeps the 312 paths of v1.4.8, the release the
  current executable-parent definition was authored for (#3654). Against
  v1.4.3 it adds only six `docs/` files. `RoadRash64Recompiled.exe`,
  `RoadRash64DirectStart.exe` and the three `tools/mk64-importer` programs
  keep their paths.
- **Data:** the published v1.4.8 and v1.4.9 source ZIPs were compared. Their
  sources contain the same data filename, environment variable and network
  literals. Against v1.4.3, the player's strings add only the data
  file `cpu-weapon-options.cfg`, which the current definition already declares,
  and the opt-in `RR64_POPULATION_TRACE` and `RR64_PREPARATION_TRACE` trace
  variables, which Portcove does not set.

The difference from the bound v1.4.3 artifact is the data coordinates:
wrapper-prefixed then, beside the executable now. The current definition
already carries that difference. Historical v1.4.3 installations keep their
wrapper-prefixed definition, and their held transition is unchanged. The new
binding applies only to the exact v1.4.9 package.

## Deferred: Snap64 Recomp

The v1.1.7 tag resolves to `0525610a89fd3c960b5a3555fad63e20f0d97f64`. The
original game file, layout and data folder are unchanged:

- **Original game file:** the README still names SHA-1
  `edc7c49cc568c045fe48be0d18011c30f393cbaf` for the US cartridge.
- **Layout:** `Snap64Recomp.exe` is still the only Windows program, at the same
  place. Windows adds the top-level `steam_art/` folder with four pictures and
  three more data files, against v1.0.5. Against v1.1.6, Linux adds only
  `steam_art/` and the Mac app list is identical.
- **Data folder:** `src/paths.cpp` still reads `SNAP_DATA_DIR` first, on
  every platform.

The player adds new writers that the route's data contract does not cover:

- **Steam artwork:** `src/steam_art.cpp`, which v1.0.5 does not have, runs at
  every start on Windows and desktop Linux. When a Steam shortcut in
  `userdata/<account>/config/shortcuts.vdf` names this game or its executable,
  it copies the package's `steam_art/` pictures into that account's
  `config/grid` folder. It never replaces an existing file. This writes
  outside Portcove's data folder, into Steam's.
- **Steam marker:** after writing a picture, it appends to
  `steam_art_done.txt` in the data folder. The marker remembers pictures the
  player deleted. The file is not among the route's persistent paths.
- **Shader cache:** on Linux, when Steam's `MESA_SHADER_CACHE_DIR` cannot be
  written, the player moves the shader cache to `XDG_CACHE_HOME` or a `cache`
  folder in the data folder. That folder is also not declared.
- **Mac:** the Mac player's strings have no `steam_art_done.txt`; its Steam
  code is documented as Windows and Linux only.

`SNAP_NO_STEAM_ART=1` switches the Steam writer off. The Windows
`CreateProcessW` restart was already in v1.0.5, so it is not a new difference;
its handoff gap stays tracked on #281 and #2510.

No generic Core rule lets this through. A rule that treats the whole
`user_data_environment` folder as player data would cover the marker and cache
folder. Nothing in Core can own writes into Steam's folder. Resuming needs a
reviewed definition decision: set `SNAP_NO_STEAM_ART=1` through
`launch_environment` (declaring the marker alone would leave the Steam-folder
write) plus a decision on the Linux `cache` folder that
`snap_mesa_shader_cache_dir()` creates, or an explicit acceptance of the
external Steam write. That is a player-visible
change for #281. The managed routes keep resolving v1.1.x as before. Only the
source contract's applicability stays at v1.0.5.

## Not observed

- **Execution:** native launch, gameplay, audio, input and saves on any
  platform, including the CVLoD normal-close failure.
- **Provider data:** the release API's digests, asset IDs and prerelease flags.
- **Provenance:** whether CVLoD's `ab942ba9` descends from the tag commit, and
  Snap64's full source tree; only the named files were read.
- **Intermediate tags:** CVLoD v0.2.27 and v0.2.28, Golden Balloon releases
  between v1.7.0 and v1.8.0, Road Rash v1.4.4 to v1.4.7, and Snap64 v1.0.6 to
  v1.1.5. Road Rash v1.4.8 and the Snap64 v1.1.6 Linux and Mac packages were
  read for comparison only. None of them was added to any applicability.
- **Lifecycle:** update, rollback, backup and restore with real player data.
- **Portcove inspection:** `portcove catalog inspect-package-layout` was not
  run on these packages.
