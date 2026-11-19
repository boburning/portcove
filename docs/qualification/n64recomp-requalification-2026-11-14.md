# N64 recompilation source applicability: four managed routes

Dated evidence from November 14, 2026. A backlog survey found four managed
`n64-recomp-portable` routes whose game-source contract still applied only to
an older release than the newest upstream tag. All four now also apply to
their newest release: Castlevania: Legacy of Darkness Recompiled, Golden
Balloon, Road Rash 64 Recompiled and Snap64 Recomp. Snap64 Recomp first
needed an owner decision, because its newer player writes into Steam's folder
(below).

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
| `snap64-recomp`                    | v1.0.5 → v1.1.7   | Windows x64       | 18,834,158 | `fcf7950f200c3006557aa4c5…0c95` | requalified |
|                                    |                   | Linux x86-64      | 9,821,880  | `d2ab64531be1b680c4bc995b…233d` | requalified |
|                                    |                   | macOS (universal) | 12,752,773 | `ad8c54692afbdc8b09d5860a…9f50` | requalified |

Every listed digest matched the publisher's checksum file. Every bound package
was downloaded again, and its SHA-256 matched the existing applicability.

Each requalified contract keeps its existing applicability first and appends
the exact newest artifact digests. Each requalified route has one new
`upstream_support` evidence record. Source profiles, other source-contract fields, admission,
platforms, support tiers and qualification records are unchanged. Only the
Snap64 Recomp definition changed, as described in its section.

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

## Snap64 Recomp

The v1.1.7 tag resolves to `0525610a89fd3c960b5a3555fad63e20f0d97f64`. The
original game file, layout and data folder are unchanged:

- **Original game file:** the README still names SHA-1
  `edc7c49cc568c045fe48be0d18011c30f393cbaf` for the US cartridge.
- **Layout:** `Snap64Recomp.exe` is still the only Windows program, at the same
  place. Windows adds the top-level `steam_art/` folder with four pictures and
  three more data files, against v1.0.5. Against v1.1.6, Linux adds only
  `steam_art/` and the Mac app list is identical. The Windows and Linux
  packages still ship `cache/rt64-seen-shaders.bin`.
- **Data folder:** `src/paths.cpp` still uses an absolute `SNAP_DATA_DIR` first,
  on every platform. Portcove sets it to the port's Portcove user folder, so
  every file below that the player writes "in the data folder" lands there,
  not in the installed package.

The player adds writers that v1.0.5 does not have:

- **Steam artwork:** `src/steam_art.cpp` runs at every start on Windows and
  desktop Linux. When a Steam shortcut in
  `userdata/<account>/config/shortcuts.vdf` names this game or its executable,
  it copies the package's `steam_art/` pictures into that account's
  `config/grid` folder, which is in Steam's folder, not Portcove's. It never
  replaces an existing file. Its match (`src/steam_art.cpp` 246–247) also
  picks Portcove's own Steam shortcut for this game, whose name and launch
  options contain `snap64`, so it would fill the same grid slots that
  Portcove's Steam artwork fills.
- **Steam marker:** after writing a picture, it appends to
  `steam_art_done.txt` in the data folder.
- **Session mark:** `src/mod_installer.cpp` keeps `snap64.running` in the data
  folder from start to a normal end. If it is there at start, the player asks
  whether to start with mods switched off.
- **Graphics failure mark:** `src/rt64_render_context.cpp` writes
  `snap64.gpu_failed` in the data folder when a graphics setting fails, so the
  same card is not offered that setting again.
- **Shader cache:** on Linux, `snap_mesa_shader_cache_dir()` (`src/main.cpp`
  1652–1681, called at 1715) runs only when `MESA_SHADER_CACHE_DIR` is set and
  cannot be written. It then points Mesa at `XDG_CACHE_HOME` when that can be
  written, else at `cache` in the data folder. v1.0.5 already keeps RT64's
  seen-shader list in that same `cache` folder.
- **Mac:** the Mac player's strings have no `steam_art_done.txt`; its Steam
  code is built only for Windows and desktop Linux.

The Windows `CreateProcessW` restart was already in v1.0.5, so it is not a new
difference; its handoff gap stays tracked on #281 and #2510.

### Owner decision and definition change

On November 14, 2026 the owner decided that Portcove owns every remaining
write. The definition now sets `SNAP_NO_STEAM_ART=1` through
`launch_environment`. It declares no `runtime_mutable_paths`.

- **Steam writer off:** at the tag, `read_launch()` (`src/steam_art.cpp`
  102–106) treats any value that is not empty and not `0` as off.
  `do_the_art()` (431–436) then logs one line and returns. That is before
  Steam's folder is looked up, before any `config/grid` write, and before
  `steam_art_done.txt` is read or appended (504). The only caller is
  `steam_art_start()` from `src/main.cpp` 1779.
- **Data folder:** `cache/`, `snap64.running` and `snap64.gpu_failed` stay in
  the Portcove user folder. For this route, backups copy that folder whole and
  a restore replaces it whole, so these files are kept with the player's data.
  `runtime_mutable_paths` applies to the installed package, so it could not
  cover them. Declaring `cache` there would only have stopped Portcove checking
  the shipped `cache/rt64-seen-shaders.bin`. It stays checked.
- **Restore:** a backup taken after a crash can bring back `snap64.running`.
  The only effect is the player's start-up question about mods.
- **Outside Portcove:** the Linux shader-cache fallback can use
  `XDG_CACHE_HOME`. That is a disposable Mesa shader cache that Portcove does
  not own. Before testing it, the fallback also tries to create the folder
  that `MESA_SHADER_CACHE_DIR` names (`src/main.cpp` 1636–1640 and 1658),
  usually Steam's shader cache, which Mesa would create anyway.
- **Portcove's Steam artwork:** with the switch, new installs no longer put
  upstream pictures into the grid slots of Portcove's own Steam shortcut.
  Copies that already ran v1.1.x without the switch may have left upstream
  pictures there. Portcove did not write them, so it treats them as the
  player's art and leaves them alone.

Updating an installed v1.0.5 copy to v1.1.7 records today's definition, with
the switch, only when the update installs a fresh v1.1.7 copy. If Portcove
finds an older v1.1.7 copy by its checksum and reuses or stages it (for
example after a rollback to v1.0.5), that copy keeps the definition it was
installed with, without the switch. The installed v1.0.5 copy keeps the
definition it was installed with. A v1.1.x copy installed before this change
keeps that earlier definition, without the switch, until a newer version
replaces it or it is removed and installed again.

The source contract keeps its v1.0.5 binding first and appends the three exact
v1.1.7 package digests. The new `snap64-recomp-1-1-7-source-contract` evidence
record cites the tag commit. Player-facing setup text is unchanged: it covers
upstream-managed packages, which keep upstream's Steam behavior.

## Not observed

- **Execution:** native launch, gameplay, audio, input and saves on any
  platform, including the CVLoD normal-close failure.
- **Provider data:** the release API's digests, asset IDs and prerelease flags.
- **Provenance:** whether CVLoD's `ab942ba9` descends from the tag commit. For
  Snap64 the `src/` folder at v1.0.5 and v1.1.7 was compared for data-folder,
  home-folder and network writers; its `lib/` submodules were not read.
- **Steam switch in use:** that the v1.1.7 log shows the switched-off Steam
  line, and that no picture reaches a real Steam `config/grid` folder.
- **Intermediate tags:** CVLoD v0.2.27 and v0.2.28, Golden Balloon releases
  between v1.7.0 and v1.8.0, Road Rash v1.4.4 to v1.4.7, and Snap64 v1.0.6 to
  v1.1.5. Road Rash v1.4.8 and the Snap64 v1.1.6 Linux and Mac packages were
  read for comparison only. None of them was added to any applicability.
- **Lifecycle:** update, rollback, backup and restore with real player data.
- **Portcove inspection:** `portcove catalog inspect-package-layout` was not
  run on these packages.
