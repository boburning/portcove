# Yakumo managed Windows route with tracked handoff

This candidate adds a separate managed Windows x86-64 runtime for Monster
Hunter Portable 3rd HD Ver. through Yakumo. It is the first route to declare
`windows_tracked_handoff: true`. Existing prepared copies keep their
non-owning registration. Linux, Mac and Android keep the upstream setup guide.
[Canonical title #1120](https://github.com/boburning/portcove/issues/1120),
[hold assessment](https://github.com/boburning/portcove/issues/1120#issuecomment-6817333091).

The earlier assessment found the package a clean fit but held it, because
menu restarts end the supervised process. The tracked handoff now covers that
restart pattern on Windows, which meets the stated resume condition.

## Exact inputs

Observed 2026-11-12. Tag `v0.7.5` is the lightweight tag for commit
`03e7ca2d5ebd1fe4e7958235f4041716e3637cb6`, read with `git ls-remote`.
GitHub release `411105161`, asset `635475842`, supplies
`yakumo-0.7.5-windows-x86_64-portable.zip` at 220,399,914 bytes.
The independently computed SHA-256
`7927e3f1e30afcd6f908038ced4a9c99ca58c92510920ec9f36a7b2b1d2ed69c`
matches the provider digest and the release's `SHA256SUMS-windows.txt`.
[Release](https://github.com/TeamGDB/Yakumo/releases/tag/v0.7.5).

The ZIP has 377 entries: 374 files and three directory entries, with no links.
Everything sits in one `yakumo-0.7.5-windows-x86_64-portable/` wrapper folder.
It holds `Yakumo.exe` (76,452,864 bytes, PE machine `0x8664`, SHA-256
`ca8898e46323f4cb855ebc771c38537acdb07c09b5cbcc63fd7a24bc01217634`), FFmpeg,
SDL3 and MSVC runtime DLLs, `licenses/`, 355 overlay DLLs in `overlays/`,
`README.txt`, `BUILDINFO.txt` and `portable.txt`. There is no `data` member.
`BUILDINFO.txt` names v0.7.5, the commit above, MSVC 19.44 and 355 overlay DLLs.
The listing was read from the archive directory without extracting or running
anything.

`portcove --json catalog inspect-package-layout` with the published size and
digest reported directories `licenses` and `overlays` and the single program
`yakumo.exe`. That is the declared reviewed layout. The same release also
publishes `yakumo-0.7.5-windows-x86_64.zip` without the marker. The selector
`yakumo-` plus `windows-x86_64-portable.zip` excludes it.

## Data location

The pinned source decides where data goes. Upstream file links:
[user_data.cpp](https://github.com/TeamGDB/Yakumo/blob/03e7ca2d5ebd1fe4e7958235f4041716e3637cb6/profiles/mhp3rd/host/install/user_data.cpp),
[installer.cpp](https://github.com/TeamGDB/Yakumo/blob/03e7ca2d5ebd1fe4e7958235f4041716e3637cb6/profiles/mhp3rd/host/install/installer.cpp),
[main.cpp](https://github.com/TeamGDB/Yakumo/blob/03e7ca2d5ebd1fe4e7958235f4041716e3637cb6/profiles/mhp3rd/host/main.cpp),
[user_data.hpp](https://github.com/TeamGDB/Yakumo/blob/03e7ca2d5ebd1fe4e7958235f4041716e3637cb6/profiles/mhp3rd/host/install/user_data.hpp).

- `data_directory()` (user_data.cpp L91-121) takes `--data-dir` first, then
  `MHP3RD_DATA_DIR`. Otherwise `portable_data_directory()` (L72-81) selects
  `<executable folder>\data` when `portable.txt` or a `data` folder exists
  there, unless `MHP3RD_PORTABLE=0`. The fallback is `%APPDATA%\Yakumo\MHP3rd`.
  The shipped marker and the managed persistent `data` folder both select the
  managed folder. The launch uses no arguments.
- The data folder holds `settings.ini`, the prepared `EBOOT.ELF`, the copied
  `disc.iso` when the player chooses a copy, `ms0` saves, save backups and the
  setup marker. Settings and the write check (`.yakumo-write-check`) write
  there too.
- `install_checked()` (installer.cpp L199-255) either copies the disc image
  into the data folder or records an absolute path for an in-place image. An
  in-place image is an external, read-only input. A copy becomes managed data
  and is included in backups.
- `prepare_data_directory()` (main.cpp L313-340) can offer to copy an
  existing `%APPDATA%\Yakumo\MHP3rd` profile into an empty portable folder.
  `copy_user_data()` copies and keeps existing targets. It does not remove
  the source.
- Shipped fonts, translations and overlays are read beside the executable
  (app_paths.cpp). Nothing in the files reviewed writes beside the executable
  outside `data`.

The declared persistent path is `data`. `portable.txt` stays an immutable
package member, so Portcove adds no marker. The managed warnings ask players
to leave `MHP3RD_DATA_DIR` and `MHP3RD_PORTABLE` unset. Portcove does not
clear those variables.

## Restarts and the tracked handoff

Restart Now after a save import and Set Up Game Data Again set flags. After
the runtime stops, `main()` (main.cpp L503-505) calls
`restart_for_setup(argv[0])` or `restart(argv)`. On Windows both call
`exec_wide()` (installer.cpp L435-445), which uses `_wexecv` with
`executable_path()`, the running `Yakumo.exe`. The MSVC `_wexecv` starts the
successor as a new process and ends the caller. The successor is the same
program inside the installation and is created from the game's own process,
so the session job tracks it.

`restart_for_setup()` falls back to `_execlp(program, ...)` with `argv[0]`
only when the executable path cannot be read. A program found that way
through `PATH` could lie outside the installation and would not hold the
session. Linux and macOS use `execv`, which keeps the process identity, but
this route offers Windows only.

## Definition delivery

The integration declares `windows_tracked_handoff: true` beside the
native-portable adapter. Core's catalog check accepts it because Windows uses
the native `Yakumo.exe`. Delivered definitions must require native-portable 28. Core's indexed-definition reader refuses an entry below that, whatever the
adapter. No repository script emits indexed definition entries; the Core test
fixture helper does. That helper now raises a native-portable entry to 28 and
adds a native-portable 28 requirement for another adapter. Format-1 signed
catalogs cannot carry the field. The format-1 test payload now drops it like
Shipwright persistence, and verification keeps the compiled value.

## Validation

All Portcove checks used inert fixtures. No upstream program was run.

- `node scripts/generate-catalog.mts --check` passed.
- `portcove --json catalog inspect-proposal --repository-authoring` passed
  for the generated catalog, including the summary and original-title rules.
- Core tests passed on Linux x86-64:
  - catalog;
  - definition entry and projection;
  - test fixtures;
  - the tracked-handoff gates and legacy signed-catalog refusal;
  - the generated prepared-route entry and the updated Yakumo registration test;
  - the shared release-selection corpus.
- That corpus has observed v0.7.5 and a controlled v0.7.6 successor with
  example.invalid URLs and a placeholder digest. It is not a real release.
  The successor also carries a competing non-portable Windows ZIP.
- The managed native lifecycle entrypoint and the tracked-handoff session tests
  only compile on Windows. Hosted Windows CI runs them. The entrypoint uses the
  374 observed members and inert probes under `data`.

## Not observed

- No native Windows run, installer, first-Play preparation or disc
  verification was performed.
- Neither the tracked handoff with the actual program nor gameplay, saves,
  save import, backup or restore of real data was observed.
- No original disc, EBOOT or save file was used.
- The source review covers the files linked above, not the whole repository.
  Other writers beside the executable are not excluded.
- Rendering, multiplayer, controller and save compatibility claims remain
  upstream claims.
- Supported status, admission and protected delivery are not claimed.
