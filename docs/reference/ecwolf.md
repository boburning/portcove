# ECWolf upstream-owned routes

The `ecwolf-wolfenstein3d` definition registers an installation the player
maintains on Windows x64 or Linux x64. It supervises the selected native
executable after explicit Play. Registration removal preserves the external
runtime, originals, saves, settings and mods. Runtime replacement belongs to the
player or system package manager. Managed installation, update, rollback,
backup/restore and deletion are not offered.

The canonical owner is [#6767](https://github.com/boburning/portcove/issues/6767).
[Official downloads](https://maniacsvault.net/ecwolf/download.php) and
[tagged source](https://github.com/ECWolfEngine/ECWolf/tree/ca1143ef008869f05c9db112289f561a3c9aa1c3)
are separate evidence from Portcove execution. This title is Wolfenstein 3D;
ECWolf's other supported games require their own original-file and launch
analysis.

## Package and platform observations

Inert inspection on November 18, 2026 covered these exact upstream 1.4.2
packages. The SHA-256 values below identify observed bytes. They are not an
independent publisher digest authority and cannot authorize managed acquisition.

| Platform                  | Official artifact and observed shape                                                                                | Offered route and evidence limit                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64               | `ecwolf-1.4.2_x64.zip`, 2,200,699 bytes; AMD64 `ecwolf.exe`, console helper, `ecwolf.pk3` and licenses              | User-selected `ecwolf.exe`, executable-parent working directory, `--data` and `WL1` as separate arguments. The console helper is not the selected player.           |
| Linux x64                 | `ecwolf-1.4.2_amd64.deb`, 1,126,722 bytes; AMD64 ELF `/usr/games/ecwolf`, system PK3 and dependency metadata        | Install through the system package manager, then register the native player and its parent. Do not treat extracting the DEB as installing its dependencies.         |
| Intel Mac / Apple Silicon | `ecwolf-1.4.2.dmg`, 7,429,565 bytes; bounded UDIF container metadata inspected; upstream advertises a universal app | Upstream app/setup route. Mach-O members and Mac execution were not inspected or established by this observation.                                                   |
| Android                   | `ecwolf-1.4.2_arm64-v8a.apk`, 6,808,053 bytes; AArch64 `libecwolf.so` and touch controls                            | Upstream APK/setup route. The upstream page reports buggy Android support and system-version limitations. No Portcove Android host or device acceptance is claimed. |

The same official page links Windows ARM64 and additional Linux/Android
processor packages. Those are upstream-owned alternatives, outside the two
operational host declarations above.

Observed package SHA-256 values:

- Windows: `61bd6bf62d2e44975e46f86ca57fdabd8a3937da04750a842a970d7a8b56a58a`.
- Linux DEB: `210a00a92567eb9d1c669acd1999d78d0667c455c566b2e8ec08d568f42c08a4`.
- Mac DMG: `9261a1105c48669ff27bde975a82c95605e8d36503505e3e3bee39de76baca95`.
- Android ARM64: `fef7f04fb035c0bc0b3ec91c7b8c1c376366660b02442a11a8c0e4377c6d66b0`.

The Windows archive retains GPL/LGPL, BSD, gdtoa, SDL, FLAC, libxmp and
Ogg/Opus notices. Original Wolfenstein data is a separate input. Portcove's
record distributes neither that data nor a repackaged runtime.

## Original files and launch

The official `wolf3d14.zip` public-shareware download is 676,348 bytes, observed
SHA-256 `23efc1839b9bd91de43fbd036e55aca94271293dd46d176dafd40378b2f94108`.
Its `wolf3d14` folder contains eight `.WL1` data files: `AUDIOHED`, `AUDIOT`,
`GAMEMAPS`, `MAPHEAD`, `VGADICT`, `VGAGRAPH`, `VGAHEAD` and `VSWAP`. The archive also contains documentation and original DOS
executables. Only those matching data files are needed beside the Windows
ECWolf player, or in the Linux data search location. No DOS executable was run
or selected as a native player.

`--data WL1` selects the prepared data set. It is not Core authentication of an
edition, entitlement or arbitrary selected package. Preserve the names and
case, especially on Linux. [Parameter handling](https://github.com/ECWolfEngine/ECWolf/blob/ca1143ef008869f05c9db112289f561a3c9aa1c3/src/wl_main.cpp)
and [data selection](https://github.com/ECWolfEngine/ECWolf/blob/ca1143ef008869f05c9db112289f561a3c9aa1c3/src/wl_iwad.cpp)
retain upstream ownership of original-file compatibility. Registered editions
and other engines' saves do not inherit shareware observations.

## Player data and replacement ownership

[Directory selection](https://github.com/ECWolfEngine/ECWolf/blob/ca1143ef008869f05c9db112289f561a3c9aa1c3/src/filesys.cpp)
and [Mac directory selection](https://github.com/ECWolfEngine/ECWolf/blob/ca1143ef008869f05c9db112289f561a3c9aa1c3/src/macosx/filesys.mm)
separate configuration, progress and game-data locations:

- Windows normally uses Roaming AppData/ECWolf for `ecwolf.cfg`, and the Windows
  Saved Games Known Folder under ECWolf for saves. Upstream can fall back to its
  configuration directory.
- Linux uses `$XDG_CONFIG_HOME/ecwolf` or `~/.config/ecwolf` for configuration,
  and `$XDG_DATA_HOME/ecwolf/savegames` or `~/.local/share/ecwolf/savegames` for
  saves, with configuration-directory fallback.
- Mac uses `~/Library/Preferences/ecwolf.cfg`,
  `~/Documents/ECWolf/Savegames`, and
  `~/Library/Application Support/ECWolf` for original game data.
- Explicit `--config` and `--savedir` paths remain external. Upstream initializes
  default directories before processing these overrides; an override is not a
  promise of zero other directory creation.

Back up the actual locations, original inputs and mods with ECWolf closed.
Retain the creating runtime before changing versions. Registration does not
migrate data or certify cross-version or cross-engine save compatibility.
Relink changed executable bytes only after reviewing the new selection.

These dated artifact/source observations establish no native title, physical
controller, audio, retail, Mac or Android acceptance. Matching execution receipts
and subsequent delivery remain on the canonical issue.
