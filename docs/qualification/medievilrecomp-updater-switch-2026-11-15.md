# MediEvilRecomp managed Windows route with its updater switched off

This candidate gives MediEvilRecomp a managed Windows x86-64 route that starts
the game with upstream's `--disable-updated` switch. It is the first route under
the [updater-switch rule](../CATALOG.md#managed-native-portable-packages): an upstream player
with its own updater may take a managed route only when upstream provides a
switch that removes every update path. Linux and macOS keep the upstream-owned
listing. [Canonical title #1844](https://github.com/boburning/portcove/issues/1844).

Until now the in-game updater kept this port on the non-owning route, because a
managed copy cannot have two runtime-replacement owners. Upstream added the
switch for exactly this case: its source comment reads "for launcher, launch the
game with this if the launcher already managed updates".

## Exact inputs

Observed 2026-11-15. Tag `v1.0.4` is commit
`2125f7090e3bbb8ea74000ff972ecbebdb09b7ed`, read with `git ls-remote`, and pins
the RecompOne submodule at `f7449e65c05cbe2957a724ca4f9066934133bc8c`. The release
asset `MediEvilRecomp-v1.0.4-windows-x64.zip` is 48,933,609 bytes with SHA-256
`dc351a0b3131cc2efaee2817f67796a34ca647a6e13d72ede7b7062545ac7520`, computed
locally. The GitHub provider digest could not be read from the qualification
session; a managed install fails closed without one.

The archive holds 46 files at its root and no directories. `portcove catalog
inspect-package-layout` reported the single program `medievil.exe`, which is the
reviewed layout. `medievil.runtimeconfig.json` requires `Microsoft.NETCore.App`
10.0.0, and OpenAL ships as `soft_oal.dll`. The shipped `RecompOne.Runtime.dll`
contains the strings `--disable-updated` and "disabled, updates are managed by
the launcher", so the package matches the reviewed source. Nothing from the
package or source was executed.

## Every update path is closed

In RecompOne `RecompOne.Runtime/Updates/AutoUpdater.cs`:

- `Program.cs` calls `HandleRelaunch(args)` and then `ConsumeArguments(args)`
  before anything else. `ConsumeArguments` sets `Enabled = false` when
  `--disable-updated` is present, and nothing sets it back.
- `Configure` returns before recording the repository, cleaning files or starting
  a check when `Enabled` is false, so `Configured` (`Enabled && repository set`)
  stays false whatever order the interface is built in.
- The only manual check, `CheckNow`, is reached from the Updates menu, which
  `RecompOne.UI/Menu/MainMenuBar.cs` registers only when `Configured`. The only
  installer entry, `StartUpdate`, is reached from the update popup, which
  `ImGuiInterface.cs` registers only when `Configured`, and `PromptVisible` also
  requires `Enabled`. `CheckAsync` and `UpdateAsync` are private to those entries.
  The BigPicture interface only names the menu's icon.
- `HandleRelaunch` acts only when the first argument is `--apply-update`. Portcove
  passes `launch_arguments` first and verbatim on every launch, so the first
  argument is always `--disable-updated`, and update files left by an earlier
  unmanaged run are never applied.
- The game never relaunches itself. Its other `Process.Start` calls open a URL or
  folder through the shell, or run `git` for the mod hub.

Installed mods are C# source that the game compiles and runs with full trust,
so a mod could call the public updater itself. The rule covers upstream's own
update paths, not code the player chooses to install.

## Writes and data

Every data file is relative to the working folder, which is the managed copy:
`settings.json`, `interface.ini`, the `carda.sav` and `cardb.sav` memory cards,
`mods` (including its compiled `.cache`), `shaders`, `packs`, `dump` and the mod
hub cache `.modhub`. The route keeps all of them and declares
`portcove-managed` saves. Crash logs (`<timestamp>.log`) and the transient
`settings.json.tmp` are unknown player-side files. The disc stays where the player
keeps it; `settings.json` stores its path.

## Limits

This evidence is bound to v1.0.4 and RecompOne `f7449e65`. The route follows
later releases by its asset hints and reviewed layout, which do not check the
switch. If a later release dropped or renamed it, the updater would return and
Core's immutable verification would hold the changed installation, so each new
release needs the switch re-checked. Starting `medievil.exe` directly from the
managed folder runs without the switch. No real install or gameplay under
Portcove has been observed.
