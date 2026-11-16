# Mercenaries 2 native beta managed Windows route with tracked handoff

This candidate gives the Mercenaries 2: World in Flames native beta by
bstoney-yt a managed Windows x86-64 route that declares
`windows_tracked_handoff: true`. [Canonical title #6099](https://github.com/boburning/portcove/issues/6099).

## Exact inputs

Observed 2026-11-15. Tag `beta-20261021` is commit
`0c11ef493e7d7b9b20c563c93bd543001aa70d22`, read with `git ls-remote`. The
release asset `m2-beta-windows.zip` is 12,478,343 bytes with SHA-256
`1afc8826f67b1dddd4e7d51a1897d33ebae6211ca96b38e4011dfba9cb367719`, computed
from a fresh download. The listing intake on #6099 recorded that the archive
matched its provider digest; the digest string itself could not be read from
this session, and a managed install fails closed without one. No checksum
sidecar is published.

The archive has no wrapper folder and holds `m2-beta.exe` (PE32 x86) and
`README.txt`. `portcove catalog inspect-package-layout` with that hash reported
no directories and the program `m2-beta.exe`, which is the declared reviewed
layout. Nothing from the package or source was executed.

## Process lifetime

Source at the tag, `crates/m2-alpha/src/main.rs`:

- `relaunch_front_end` (pause-menu Quit) and `relaunch` (loading a save, with
  `--load <save>`) both run `std::process::Command::new(current_exe())` with
  the original arguments plus their own, then `spawn()`. The window event
  handler then exits the event loop, so the original process ends. Rust's
  `Command` uses `CreateProcessW` without job breakaway and without the shell,
  and the working directory is inherited. The successor is the managed
  executable, so the tracked handoff keeps the session until it exits.
- `crates/m2-alpha/src/movie.rs` decodes the game's Bink movies with an
  `ffmpeg` child process found through `M2_FFMPEG`, beside the executable, or
  on `PATH`, and kills it when the movie is dropped. A copy on `PATH` sits
  outside the installation. An `ffmpeg.exe` placed in the managed folder would
  be an unmanaged program inside the installation that update replaces, so the
  managed copy points players to `PATH` or `M2_FFMPEG` instead.
- No updater or download code was found. Networking is the co-op invite path;
  a plain launch joins an invite found on the clipboard, which the listing
  warns about.

## Writes and data

`crates/m2-alpha/src/config.rs`: `default_path` uses `m2-alpha.toml` in the
working directory, then beside the executable; `file_beside` places every other
file beside that settings file, or beside the executable. Under Portcove both
are the game folder. Those files are `m2-alpha-save.toml`, the slot files
`m2-alpha-<slot>.toml` (autosave and numbered saves), `m2-alpha-catalogue.toml`
and the `m2-alpha-*.log` logs, including the crash log. The route keeps
`m2-alpha.toml` as a persistent path and `m2-alpha-*.toml` and `m2-alpha-*.log`
as persistent file patterns, with `portcove-managed` saves and settings. The
original game is read in place from the EA app, Origin or registry location, or
from an `install` key in `m2-alpha.toml`; nothing is written there.

## Rights

The repository publishes no licence and the package has no licence notices.
Its README says it ships none of the game's files. Under the 2026-11-13 rights
basis this is a recorded listing warning, not a hold.

## Limits

This evidence is bound to `beta-20261021` / `0c11ef49`. A later release that
adds job breakaway, a shell-started helper or an updater falls outside it. No
real install, relaunch or gameplay under Portcove has been observed.
