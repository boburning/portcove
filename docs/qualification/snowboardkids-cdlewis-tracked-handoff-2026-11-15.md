# Snowboard Kids (cdlewis) managed Windows route with tracked handoff

This candidate gives Snowboard Kids: Recompiled by cdlewis a managed Windows
x86-64 route that declares `windows_tracked_handoff: true`. Linux and macOS keep
the upstream-owned listing. [Canonical title #1886](https://github.com/boburning/portcove/issues/1886).

The [2026-11-10 fit investigation](https://github.com/boburning/portcove/issues/1886#issuecomment-6768555699)
held a managed route for two reasons. First, the player can start a second game
process and quit. Second, a source profile would need region ROM identities.
The reviewed Windows tracked handoff now covers the first. The second does not
apply to this route: it has no source requirements, and the game selects,
checks and stores its own original, as other managed native-portable recompilation players do.

## Exact inputs

Observed 2026-11-15. Tag `v1.0.9` is commit
`d771b19cc935200f2b68a4d5277380e6f0592c02`, read with `git ls-remote`. The
release asset `SnowboardKidsRecompiled-Windows.zip` is 23,737,808 bytes with
SHA-256 `bbe02ea0f6388323a7387289ef6c92d4db145d3d1f3bd47e4e4622273a4b18a6`, the
same value recorded in the
[2026-11-13 rights review](upstream-rights-review-batch-2-2026-11-13.md). The
GitHub provider digest could not be read from the qualification session; a
managed install fails closed without one.

The archive has no wrapper folder. Its root holds `SnowboardKidsRecompiled.exe`,
`crashpad_handler.exe`, `SDL2.dll`, `dxil.dll`, `dxcompiler.dll`,
`recompcontrollerdb.txt`, `assets/` and `licenses/`, with no `portable.txt`.
`portcove catalog inspect-package-layout` with the published size and hash
reported directories `assets` and `licenses` and programs `crashpad_handler.exe`
and `snowboardkidsrecompiled.exe`. That is the declared reviewed layout. Nothing
from the package or source was executed.

## Process lifetime

Source at the tag commit, with submodules cdlewis/N64ModernRuntime `c6f29fb3`
and cdlewis/RecompFrontend `3f7965b4`:

- `src/main/game_regions.cpp` `relaunch_game` runs `CreateProcessW` on the
  module's own executable path with the original command line plus
  `--resume-game=<id>`, no inherited handles and creation flags `0`, then quits
  through `ultramodern::quit()`. The successor is the managed executable, starts
  from the game's own process tree without job breakaway and is not started
  through the shell, so the tracked handoff keeps the session until it exits.
- The relaunch is rare. `start_game` uses it only when a different region was
  already registered in the same process, and the launcher only returns before
  a game has started. It therefore needs a failed start followed by choosing the
  other region's ROM. Choosing a ROM before the first start, or between sessions,
  does not relaunch.
- `src/main/crash_reports.cpp` starts crashpad on Windows with
  `<install>/crashpad_handler.exe`, a database in the profile's `crash-reports`
  folder, no upload URL, uploads disabled and `--no-periodic-tasks`. Crashpad's
  Windows client creates the handler with `CreateProcess` and no breakaway, so
  it is an in-install member of the session job. Without `--pipe-name` the
  handler is not persistent and leaves its loop once its last client process
  ends, so it holds the session only while the game runs or a crash dump is
  being written. Its image is therefore not mapped during an update or rollback.
  On Windows, `restartable` is accepted but unused.
- On Linux the same relaunch uses `posix_spawn` and quits, which Core cannot
  track there. Linux and macOS therefore stay non-owning listings.

## Writes and data

The profile comes from RecompFrontend's `get_app_folder_path`: `portable.txt`
in the working folder, otherwise `%LOCALAPPDATA%\SnowboardKidsRecompiled`.
Core refuses to launch a managed copy that contains `portable.txt`. The stored
ROM copy (librecomp `select_rom`, after byte-order normalization and the hash
check), `game_region.txt`, saves, settings, mods and crashpad's database all go
under that profile. No write beside the executable was found in the game,
RecompFrontend, librecomp or crashpad paths; RT64 was not inspected. The route
therefore declares no persistent paths and `external-user-owned` saves and
settings. Both the North American and the Japanese game entries are enabled.

## Rights

The package links a modified cdlewis RecompFrontend fork that its project
license does not cover. Under the 2026-11-13 rights basis that is a recorded
listing warning, not a hold, and the rights review above already re-offered
v1.0.9 with it noted.

## Limits

This evidence is bound to v1.0.9 / `d771b19c`. A later release that adds job
breakaway or a shell-started helper without changing the reviewed layout would
fall outside it. No real install, region relaunch or gameplay under Portcove has
been observed.
