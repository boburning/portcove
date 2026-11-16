# Shantae Recomp (vibecodekun) managed Windows route with tracked handoff

This candidate gives Shantae Recomp by vibecodekun a managed Windows x86-64
route that declares `windows_tracked_handoff: true`. Linux keeps the
upstream-owned listing. [Canonical title #1881](https://github.com/boburning/portcove/issues/1881).

## Exact inputs

Observed 2026-11-16. Tag `v0.2.0` is commit
`06765fc2a44b43cab036ff323169813feb2b372e`, built on gbrecompiled `314fce08`
and recomp-ui `9b851c46`. The release asset
`shantae-recomp-0.2.0-windows-x64.zip` has SHA-256
`d85e17f17b2f25415ae5be237c29a3eba7b48b96d53a591b84aa1e84fa76a3e3`, computed
from a fresh download and equal to the digest in
`prepared-native-registration-batch-2026-11-01.json`.
`portcove catalog inspect-package-layout` with that hash reported directories
`assets` and `shaders` and the program `shantae.exe` below one unwrapped
`shantae-recomp-0.2.0-windows-x64/` folder, which is the declared reviewed
layout. Nothing from the package or source was executed.

## Process lifetime

- Return to Launcher: gbrecompiled `runtime/src/gb_host_paths.c` (around
  236-264) schedules, from an `atexit` hook in `platform_sdl.cpp`, a
  `CreateProcessW` of the same executable with the same command line, creation
  flags `0`, no job breakaway and no shell, after setting `GBRECOMP_LAUNCHER=1`.
  The successor is the managed executable, so the tracked handoff keeps the
  session until it exits. On Linux the same path uses `fork` and `execv` and
  the parent exits, which Core cannot track; Linux stays a listing.
- Shader preset check: `librashader_chain.cpp` (around 760-927) starts a hidden,
  below-normal-priority copy of `shantae.exe` with `GBRECOMP_SHADER_PROBE` to
  test-compile a chosen preset. The game polls it without blocking, kills it
  after 300 seconds (around 908-917), and cancels it on shutdown through
  `gb_lrs_shutdown`, waiting up to five seconds (`platform_sdl.cpp` around 6709),
  before the Return to Launcher hook runs. It is the same in-install program in
  the same process tree. If the game crashes while a check is running, the hidden
  helper can keep the tracked session open until it finishes; that is a tracked
  in-install child, not an escape.
- No updater, toolchain download or rebuild path is reachable. recomp-ui's
  RetComM and "Generate & rebuild" flows run only when the host sets
  `setup_wizard_supported`, which neither gbrecompiled nor this title sets; the
  build has no libcurl (`GBRT_NETPLAY` is off), and the executable imports no
  WinHTTP or WinINet.

## Writes and data

The state directory is the executable's folder unless `GBRECOMP_STATE_DIR` is
set (`gb_host_paths.c` around 161-180). The save id is the recompiler's output
prefix, here `shantae` (`c_emitter.cpp` around 3898 and 4450, `main.cpp`
around 2154, with `shantae.toml` setting no prefix). The game writes
`rom.cfg`, `runtime_prefs.ini`, `imgui.ini`, `keybinds.ini`, `shantae.ini`,
`librashader_probe.txt`, `shantae.sav`, `shantae.state1` to `shantae.state10`,
`shader_presets/` and `shader_cache/` there; `shantae.rtc` is declared although
this MBC5 cartridge has no clock. `borders/` and `cheats/` are read when the
player adds them, and Game Boy printer output goes to `prints/`. All of these are
persistent paths with `portcove-managed` saves and settings. The default-on
interpreter fallback log `interp_fallbacks.log` (`gbrt.c` around 58,
`interpreter.c` around 203) is written to the working directory and stays an
undeclared diagnostic.

The route uses `printable-ascii-max-path`. gbrecompiled finds its state and asset
folders with the narrow `GetModuleFileNameA` (`gb_host_paths.c` around 78, and
recomp-ui `launcher_model.c` around 1999). Saves, settings and save states then
open those bytes with narrow `fopen`, while shader presets, the probe cache and
`imgui.ini` read the same bytes as UTF-8. An install folder outside the system
code page or outside ASCII would therefore break saving or shader paths. The
longest package member path is 128 characters after unwrapping.

## Rights

The title is PolyForm Noncommercial; the package includes recompiled game code
without a licence grant (`THIRD-PARTY-LICENSES.md`), an unlicensed gbrecompiled
engine fork, shaders under their own licences, and the Lato and Noto Sans
Symbols 2 (OFL) and OpenMoji (CC BY-SA 4.0) fonts. Under the rights
basis these are recorded listing warnings, not holds.

## Limits

This evidence is bound to `v0.2.0` / `06765fc2`. Debug-only outputs enabled by
environment variables, and files a player creates by adding a `.bps` patch, are
not declared. No real install, relaunch or gameplay under Portcove has been
observed.
