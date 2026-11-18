# ECWolf upstream-owned routes

The `ecwolf-wolfenstein3d` definition registers an installation the player
maintains on Windows x64, Linux x64, Intel Mac or Apple Silicon Mac. It supervises the selected native
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

| Platform                  | Official artifact and observed shape                                                                         | Offered route and evidence limit                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64               | `ecwolf-1.4.2_x64.zip`, 2,200,699 bytes; AMD64 `ecwolf.exe`, console helper, `ecwolf.pk3` and licenses       | User-selected `ecwolf.exe`, executable-parent working directory, `--data` and `WL1` as separate arguments. The console helper is not the selected player.           |
| Linux x64                 | `ecwolf-1.4.2_amd64.deb`, 1,126,722 bytes; AMD64 ELF `/usr/games/ecwolf`, system PK3 and dependency metadata | Install through the system package manager, then register the native player and its parent. Do not treat extracting the DEB as installing its dependencies.         |
| Intel Mac / Apple Silicon | `ecwolf-1.4.2.dmg`, 7,429,565 bytes; actual FAT32 native executable and bundle companions inspected          | User-selected `ECWolf.app/Contents/MacOS/ecwolf`, its containing folder, and `--data WL1`. Native Mac execution and minimum-host qualification remain unobserved.   |
| Android                   | `ecwolf-1.4.2_arm64-v8a.apk`, 6,808,053 bytes; AArch64 `libecwolf.so` and touch controls                     | Upstream APK/setup route. The upstream page reports buggy Android support and system-version limitations. No Portcove Android host or device acceptance is claimed. |

The same official page links Windows ARM64 and additional Linux/Android
processor packages. Those are upstream-owned alternatives, outside the four
operational host declarations above. Legacy i386 and PowerPC slices in the Mac
bundle do not establish additional Portcove hosts.

Observed package SHA-256 values:

- Windows: `61bd6bf62d2e44975e46f86ca57fdabd8a3937da04750a842a970d7a8b56a58a`.
- Linux DEB: `210a00a92567eb9d1c669acd1999d78d0667c455c566b2e8ec08d568f42c08a4`.
- Mac DMG: `9261a1105c48669ff27bde975a82c95605e8d36503505e3e3bee39de76baca95`.
- Android ARM64: `fef7f04fb035c0bc0b3ec91c7b8c1c376366660b02442a11a8c0e4377c6d66b0`.

The Windows archive retains GPL/LGPL, BSD, gdtoa, SDL, FLAC, libxmp and
Ogg/Opus notices. Original Wolfenstein data is a separate input. Portcove's
record distributes neither that data nor a repackaged runtime.

## Mac bundle and process boundary

The selected Mac program is the native `ecwolf` file inside the installed app,
not the `.app` directory or a script. Keep the complete app together, including
`Contents/MacOS/ecwolf.pk3`, and open the app normally once through the upstream
setup before registering its native file. The start folder is the executable's
parent; the shareware arguments are `--data` and `WL1` separately.

The observed universal executable is 16,950,848 bytes, SHA-256
`a272edbf51c0bc8bc3feb53fad3a3c17eebbed651b73b568e5e557acf8e27a21`.
Bounded Mach-O inspection found Intel x64 and ARM64 slices alongside legacy
Intel 32-bit and PowerPC slices. The modern slices declare minimum target load
commands 10.9 and 11.0 respectively. These are static target observations,
not minimum-host execution or a change to Portcove's own system requirements.
The inspected modern slices load system libraries/frameworks; no separately
bundled dynamic library replacement is introduced by this route.

The [tagged Mac entry point](https://github.com/ECWolfEngine/ECWolf/blob/ca1143ef008869f05c9db112289f561a3c9aa1c3/src/macosx/i_main.mm)
passes the original arguments into `WL_Main` within the same process. Its normal
Cocoa termination callback sends SDL_QUIT rather than spawning a detached game.
Existing Core Mach-O user selection and supervision therefore fit this native
entry point without a new launcher, shell wrapper or runtime owner. This source
fit remains separate from a native Mac launch observation.

## Original files and launch

The official `wolf3d14.zip` public-shareware download is 676,348 bytes, observed
SHA-256 `23efc1839b9bd91de43fbd036e55aca94271293dd46d176dafd40378b2f94108`.
Its `wolf3d14` folder contains eight `.WL1` data files: `AUDIOHED`, `AUDIOT`,
`GAMEMAPS`, `MAPHEAD`, `VGADICT`, `VGAGRAPH`, `VGAHEAD` and `VSWAP`. The archive also contains documentation and original DOS
executables. Only those matching data files are needed beside the Windows
ECWolf player, in the Linux data search location, or in the Mac application-support
data directory. No DOS executable was run
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

These dated artifact/source observations do not establish native Mac, minimum-host,
physical controller, audio, retail or Android acceptance. The separate Windows
public-shareware Core/CLI receipt and its exact executed binary/input/scenario
remain on [#6767](https://github.com/boburning/portcove/issues/6767). Additional Mac
registration delivery is owned by [#8136](https://github.com/boburning/portcove/issues/8136);
its static evidence does not borrow Windows execution.
