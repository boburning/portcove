# Fable II Pub Games (MGRayd) managed Windows route through its launcher

This candidate gives Fable II Pub Games (MGRayd Recomp) a managed native-portable
Windows route that starts the upstream .NET launcher.
[Canonical title #3995](https://github.com/boburning/portcove/issues/3995).

## Exact inputs

Observed 2026-11-16. Tag `v0.1.0` is commit
`92cedf65ebfd43369c24f81b1e54e1aa12eea18c`. The release asset
`Fable2PubGames-Recomp-v0.1.0-win-x64.zip` is 78,055,345 bytes with SHA-256
`5a3b56e239b97e5dea724b1f94b7f3e3f34d4a6bb20129ce940215c57c774a43`, equal to
the digest recorded on #3995 and in `upstream-rights-review-batch-1-2026-11-13.md`.
`portcove catalog inspect-package-layout` reported directories `licenses` and
`tools` and programs `fable2pubgames.exe`, `fable2pubgameslauncher.exe` and
`tools/extract-stfs.ps1`, the declared reviewed layout. Nothing was executed.

## Process lifetime

`launcher/Fable2PubGames.Launcher/MainForm.cs`:

- Install Game Files (around 148-194) starts the system `powershell.exe` with
  `-NoProfile -ExecutionPolicy Bypass -File tools/Extract-STFS.ps1` on the
  player's chosen container, waits for it, extracts into `data.extracting` and
  renames it to `data`, keeping a previous `data` as `data.backup-<date>`. This
  mirrors the first-run extractor of the SDOJ route.
- Play Pub Games (around 196-245) starts `Fable2PubGames.exe` with
  `UseShellExecute=true`, the working directory set to the install root,
  `--game_data_root=<install>/data` and `--license_mask=1`, and waits for it.
- The route does not declare `windows_tracked_handoff`, so the launcher process is
  the whole Portcove session. The launcher has no guard against being closed while
  the game runs; the guide tells players to keep it open until the game closes.
  Whether a ShellExecute-started game stays in the session job is not established.

## Writes and data

`src/Fable2PubGames_app.h` `OnConfigurePaths` pins user data to `saves` and the
cache to `cache` beside the program. The ReXGlue SDK at `bd833a2` writes logs to
`logs` and its F4 "Save to config" rewrites the shipped `Fable2PubGames.toml`.
The SDK resolves the game data folder from the `game_data_root` value before it
loads that file, and command-line values outrank file values, so a saved absolute
path does not redirect a later version. The launcher writes
`launcher-settings.json` beside itself. The route declares `data`, `saves`,
`cache`, `logs`, `Fable2PubGames.toml` and `launcher-settings.json` persistent.
Core excludes persistent paths from the immutable manifest and restores the
player's copy over a shipped default (`install.rs` `manifest_files`,
`service.rs` `restore_user_data_with_contract`), as for Ape Escape's shipped
`input.ini`. `data.backup-*` folders are unknown player-side files that move with
the game and enter backups. The optional Fable II save sync copies the other
game's saves into `saves` and writes bridge records into its profile.

## Rights

The package includes recompiled game code that the project license does not
cover, a recorded listing warning. The launcher always passes `--license_mask=1`;
the guide uses the purchased-full-package wording of the other XBLA routes.

## Limits

Bound to `v0.1.0` / `92cedf65`. The .NET single-file launcher may extract bundled
native libraries under the user's temporary folder, outside the verified install;
that behaviour was not assessed. No native install, import or play has been
observed.
