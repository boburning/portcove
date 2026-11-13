# Wave Race 64: Recompiled managed acquisition

Date: 2026-11-13. Owner: [#553](https://github.com/boburning/portcove/issues/553).
Policy: [rights basis for upstream-hosted packages](../CATALOG.md#rights-basis-for-upstream-hosted-packages).
Previous state: [batch 1 rights review](upstream-rights-review-batch-1-2026-11-13.md), where this
listing was deferred because lifting its hold would offer a Windows download beside the
Windows prepared-player route.

## Decision

On November 13, 2026 the repository owner lifted the Wave Race 64 hold and asked
for one install action per platform:

- **Windows:** Portcove downloads, verifies and installs the official v1.0.2
  package through the managed `n64-recomp-portable` route. A copy the player
  prepared remains usable through the existing installation route.
- **Linux:** the integration does not cover Linux, so the listing offers the
  upstream package as an ordinary download that the player maintains.

## Package evidence

Both assets were downloaded from the upstream release location, hashed and
listed. Nothing was extracted into a runtime or executed.

| Platform | Asset                                        | Bytes      | SHA-256                                                            |
| -------- | -------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| Windows  | `WaveRace64Recomp-1.0.2-windows-x64.zip`     | 17,397,538 | `8603e582e7a549f1f3a02c108d1453ad61e7f5df03b2f3232f9939323b044583` |
| Linux    | `WaveRace64Recomp-1.0.2-linux-x86_64.tar.gz` | 6,296,691  | `5ea07206731b1afde10f52909443a50b64b6ebd113634d383a5538f86437e60f` |

Both digests match the batch 1 record and the retained user-prepared pin. The
Windows ZIP holds `WaveRace64Recomp.exe` at its root with `SDL2.dll`, the DXC
libraries, frontend fonts, icons and stylesheet, water profiles, `licenses/` and
notices. The Linux archive holds the same content under one top folder with
`WaveRace64Recomp`, `WaveRace64Recomp.sh` and `README-LINUX.txt`. Neither
contains a ROM, `portable.txt` or other game data. `v1.0.2` (tag commit
`ac2a296530f957f128388a6fc18028529c7f2b40`) is the latest tag on November 13.

## Upstream behavior read from source

From `src/main.cpp` and `tools/package_release.py` at the tag commit:

- `settings_directory()` uses the working directory when `portable.txt` exists
  there; otherwise `%LOCALAPPDATA%`, `XDG_DATA_HOME` or Application Support.
- `main()` changes to the executable directory before reading it.
- Without arguments the RecompFrontend launcher opens and offers Load ROM or
  Start Game for game ID `wr64.us.rev1` (`include/wr64/rom.h`). librecomp keeps
  the accepted original as `<game ID>.z64` in the settings directory; issue
  #553's earlier Windows run observed `wr64.us.rev1.z64` there. Materializing
  that file follows the same pattern as the managed Banjo and Zelda routes; it
  has not yet been observed under Portcove for this title.
- Release archives are named `WaveRace64Recomp-<version>-<target>`, with an
  optional `-debug-symbols` companion that the selectors do not match.

## Catalog changes

- The Windows integration moves from `user-prepared` to the GitHub provider with
  the selector `WaveRace64Recomp-` + `-windows-x64.zip`. The existing source
  contract `wave-race-64-recomp-game-source` already binds its applicability to
  `v1.0.2` and the archive SHA-256 above.
- Core materializes the checked USA Rev A original as big-endian
  `wr64.us.rev1.z64` (SHA-256 `f35d2423…3fc3999`) beside the executable, so the
  launcher opens with Start Game. No launch argument is passed, so the launcher's
  settings and Mods tab stay available.
- Core already writes an empty `portable.txt` in the working directory for every
  `n64-recomp-portable` route before launch and exempts it from the immutable
  inventory (`crates/portcove-core/src/adapter.rs`, the `N64RecompPortable`
  branches of launch preparation and runtime mutable paths). No Core change was needed.
- Settings, `.bak` files, `hud.json`, `water.json`, saves, mods, `mod_config`,
  `texture_packs` and the stored original are persistent; `wr64.log` is a
  disposable runtime file.
- The listing's `download_block_reason` is removed and a Linux selector added.
  The listing still declares only Linux.

## Existing registrations

Accepted-package user-prepared registrations retain the complete catalog
document captured at registration (`crates/portcove-core/src/library.rs`,
external catalog retention and `external_runtime_with_port`). Status, readiness,
relinking and launch read that retained contract, so a v1.0.2 folder registered
before this change keeps launching in place. The external-to-managed route
change is limited to `native-portable`, so a registered player removes the
registration (external files stay untouched) before choosing Install.

## Known limits

- Core now refuses the listing download where managed Install is offered and
  on hosts the listing does not name (see the listing-download rule in
  [CATALOG](../CATALOG.md#rights-basis-for-upstream-hosted-packages)). Windows
  therefore shows only Install, Linux only the upstream download, and macOS
  neither; registering an existing copy stays available on each.
- No Portcove install, launch, clean-exit or gameplay run of the managed route
  was performed. Windows and Linux remain without tested-platform claims.
- The Linux program needs glibc 2.43 and libstdc++ with `GLIBCXX_3.4.32`, as
  recorded earlier.
- The recorded component notes in the batch 1 review still apply.
