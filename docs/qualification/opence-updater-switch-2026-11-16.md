# OpenCE managed Windows route with its updater switched off

This candidate gives OpenCE (OpenCommunityEdition) a managed Windows route under
the updater-switch rule in [CATALOG](../CATALOG.md). Linux keeps the
upstream-owned listing. [Canonical title #1849](https://github.com/boburning/portcove/issues/1849).
The owner accepted on 2026-11-16 that invite links start the managed program
outside Portcove, with guidance to close such a session before updating.

## Exact inputs

Observed 2026-11-16. Release `build-374` (source `95b4a165`) is the newest
build tag. `halo-windows-release.zip` has SHA-256
`ba2efc9985236996eaac7185dc973e84448ca6630cadc7deaca25769585f6a77`, computed
from a fresh download and equal to the entry in upstream's own `SHA256SUMS`
for that release. The archive has no wrapper folder; it holds the 32-bit
`halo.exe`, `SDL3.dll`, `gametypes/`, `brokers.txt`, `masters.txt`,
`init.txt.example` and licence files. `portcove catalog inspect-package-layout`
with that hash reported the declared reviewed layout. Nothing from the package
or source was executed.

## Updater switch

The 2026-11-15 source review on #1849 established:

- `updater_start` is the only desktop update check and returns early when
  `update.auto` is false (`updater.c:721-725`); the install path is reachable
  only from a check that ran. `HALO_UPDATE_AUTO=false` is applied after the
  config file and stays pinned through a mid-run reload
  (`port_config.c:2495-2512, 2838-2843`), so the in-game setting cannot turn the
  check back on during a Portcove session.
- The dedicated-server updater is not gated by `update.auto` and can be reached
  through `server.enabled=true`; `HALO_SERVER_AUTO_UPDATE=off` closes it
  (`server_director.c:1365-1366`).

The route passes both values through `launch_environment`.

## Launches outside Portcove

Internet play registers `HKCU\Software\Classes\halo` and a Discord protocol
handler pointing at the managed `halo.exe` (`win32_p2p.c:59-81`,
`p2p_discord.c:330-334`). An invite clicked while the game is closed starts that
program through the shell without the environment switch. If the player accepts
an update there, Core's immutable verification holds the changed installation
until it is repaired. Turning off CHECK FOR UPDATES in the game writes
`update.auto = false` to the kept `config.toml`, which also protects those
launches; the guide says so.

## Process lifetime

The crash reporter runs the same `halo.exe --crash-report` inside the session
job and can keep a consent dialog open for up to ten minutes, writing
`config.toml` and `crashes\` (`win32_crash.c:620-787`). The route declares
`windows_tracked_handoff: true` so Portcove keeps tracking it.

## Writes and data

Beside the program: `config.toml`, the extracted Xbox `maps`, `custom_maps`,
`mcc_maps`, `mods`, `load_order.toml`, `screenshots`, `logs`, `captures`,
`crashes`, `init.txt`, `menus`, `bans.txt`, `player.key` and `pass-*.bin`, all
declared persistent. Profiles, saves and the shader cache stay in
`%APPDATA%\halo` (`external-user-owned`).

## Rights

OpenCE is a port of a Halo: Combat Evolved decompilation under the AGPL; the
licence does not cover the original game code. Under the rights basis this is a
recorded listing warning. No game data ships in the package.

## Limits

The switch evidence is bound to `build-374`. OpenCE publishes frequent builds;
re-check the switch whenever a new release is reviewed. No real install, update
refusal, crash report or gameplay under Portcove has been observed. Path-API
behaviour for non-ASCII install folders was not assessed.
