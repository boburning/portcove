# Mega Man X5 Recompiled Windows qualification, 2026-09-16

This is a dated evidence snapshot for the candidate Portcove catalog admission
of Mega Man X5 Recompiled. It records exact source and release identity plus a
bounded Windows lifecycle. It is not a full-playthrough, controller,
audio, in-game save/load, signing, publication, or non-Windows attestation.

## Scope

- Candidate port: `mega-man-x5-recompiled`
- Platform: `windows-x86-64`
- Upstream: `mstan/MegaManX5Recomp`
- Upstream ref: `v0.1.0-alpha`
  (`c8fde08b77b8c8daae8d0955b6529de79c82d85b`)
- Annotated tag object: `64a01650a7fc872e8c8641b02284b78f7580e9bd`
- Windows artifact: `MegaManX5Recomp-v0.1.0-alpha-windows-x64.zip`
- Artifact size: 38,083,528 bytes
- Artifact SHA-256:
  `3e5dfea86184cb2ff05372e012cef8d94e89119105f7a0268a14f9e24b47e590`
- Source identity: Mega Man X5 USA Original, `SLUS-01334`, one MODE2/2352
  track
- Normalized source size: 582,954,960 bytes
- Normalized source SHA-1: `10709231f857636b5ccd3cd9acebc91458dcb5fd`
- Normalized source SHA-256:
  `be731bc4b9d3211b9267a34b8a68c769199a15479b14004ff25b67cdfebe8af4`
- Portcove base revision: `ad6da94d9678b4990c7427784d3afc65353f2823`

The owner-authorized source remained read-only in the BoburNAS RomM library.
Its CHD container is 343,936,290 bytes with SHA-256
`2f270847844cbc09b6e9b1ee1949f25d7744096b0739b533869cae16bcdf06cd`.
Proprietary source, generated BIN/CUE bytes, cache products, and private overlay
captures remained outside Git.

## Release and source preflight

- The direct GitHub release API selected release ID `387454474`, published
  2026-09-12T04:32:35Z. GitHub's digest matched the exact Windows artifact
  identity above.
- The ZIP contains 507 entries and no rooted, parent-traversal, or symlink
  paths. It includes `MegaManX5Recomp.exe`, immutable `game.toml`, OpenBIOS,
  launcher assets, and a package-local PSXRecomp data layout; it does not
  include the game disc.
- Tagged `DISC.md` publishes the same `SLUS-01334` one-track source size and
  SHA-1 above. `chdman verify` accepted both the raw and overall CHD checksums,
  and normalized extraction matched the exact content SHA-1 and SHA-256 above.
- `MegaManX5Recomp.exe` has SHA-256
  `7fc040aa114cf9995aa8db94d0486449b9be5530d5a4a9e482a093a7fe891349`
  and is unsigned. That limitation is retained rather than presented as
  signed-provenance evidence.

## Runtime ownership

Static inspection of the exact tagged runtime and an isolated native preflight
confirmed that saves, settings, input and key bindings, disc/BIOS preferences,
and mod state live beside the executable. Portcove therefore retains those
paths as persistent player data. Generated `disc/`, JIT `cache/`, private
overlay captures, heartbeat and run-report sidecars, and the bounded
`psx_freeze_dump_psx-runtime_<epoch>_<sequence>.json` filename family are
classified as disposable runtime output. Generated disc and cache bytes are
neither trusted as immutable package content nor copied into player backups.

The exact upstream payload was exercised under the repository's exclusive
native-session lock with the normalized source and catalog launch arguments.
The process opened a responsive `Mega Man X5 Recompiled` window, loaded
OpenBIOS, identified NTSC-U `SLUS-01334`, created an OpenGL 3.3 context,
accepted a normal window-close request, and exited 0. The bounded run reached
601 frames with no fatal report or failed freeze dump. Created sidecars matched
the declared persistent and runtime-output ownership above. This is startup and
managed-path evidence, not gameplay qualification.

## Portcove lifecycle observations

The candidate was exercised with a locally built CLI in a new isolated
library. No production credentials, publication path, or existing player
library was used.

- A different valid PS1 CHD from the read-only BoburNAS library was refused as
  `source_invalid` with admission reason `known_mismatch`; it was not
  registered. The exact Mega Man X5 CHD then registered with normalized SHA-1,
  normalized SHA-256, storage SHA-256, one-track, size, and `MEGAMAN_X5` volume
  identity matching the recorded contract.
- Dynamic resolution selected `v0.1.0-alpha` and the exact 38,083,528-byte
  Windows ZIP and SHA-256 above. Fresh installation
  `322c8e2d-1722-49df-a0ff-a5f8bf47d684` produced manifest
  `1a608988916afe5d09618cdc5f0139ac0e4a178875d388f4beb97f87089c3978`;
  all 287 immutable files verified.
- Portcove materialized the normalized source as `disc/disc.cue` plus one BIN,
  then launched a responsive `Mega Man X5 Recompiled` window. The process
  loaded OpenBIOS, identified NTSC-U `SLUS-01334`, created an OpenGL 3.3
  context, accepted a normal window-close request, and exited 0. Durable
  request `b7a1e85c-6cb9-4f60-9d2f-860e5dc0f145` recorded `succeeded`.
- The bounded managed run reached 1,883 frames with no fatal report. It emitted
  one automatic freeze dump and reported zero failed dumps. Post-launch
  immutable verification still passed all 287 files, establishing the bounded
  filename pattern and exact runtime-path exclusions without widening them to
  a glob or persistent backup rule.
- Backup `a6207114-a974-40b3-8619-00e4fd3ccc25` captured 16 persistent files,
  276,322 bytes, with tree SHA-256
  `3771dc1f8651303a2f803d0aadafe161945e8313c9810e2627a5f43362ba279a`.
  It included a synthetic save sentinel with SHA-256
  `d6c3899d69627c4b2de8e7c653e51e399bd2e1f91071795516e332446a880bcd`
  and excluded generated `disc/`, `cache/`, overlays, freeze dumps, heartbeat,
  and the run report. Restore first required explicit destructive confirmation,
  then refused changed authorization state in durable activity
  `d29a7919-f83e-4e8e-89b5-4c6d8f5347a5`; that failed attempt was preserved.
  Reissuing the reviewed restore created safety backup
  `6f8a7dc6-f2bb-4c6a-b697-241c088db1be` and restored the exact sentinel hash.
- A clean upstream payload was adopted as install
  `99bb7594-a443-40c0-9f2c-618f7f4f38ec`, manifest
  `52c35202cfc97b991be2774204c67568838365f54a21cc7c12d45d83370a5748`.
  Dynamic update then activated the already-retained downloaded release.
  Rollback restored the adopted install, and the next update reused the same
  retained verified release rather than redownloading it. Both versions
  verified all 287 immutable files, and the persistent sentinel remained exact
  through both transitions.
- Managed removal deleted both the downloaded and adopted versions but retained
  canonical user data. A clean dynamic install
  `421d458c-40fe-48e8-9d9f-fe64e6e5ca9c` produced manifest
  `3be5f749b2918653aef06518dee4e3e08ad0c995fd6e8d690f792c73103b4c57`.
  The next launch restored the exact sentinel into the fresh active runtime,
  opened a responsive window, accepted a normal close, and exited 0. Durable
  request `dfe0a7cf-661a-4cc5-9a94-b885c796e145` recorded `succeeded`; final
  verification again passed all 287 immutable files.

These observations cover exact source refusal and admission, dynamic provider
resolution, install, executable discovery, immutable verification, responsive
native launch and normal close, persistent-only backup/restore, adopted-to-
downloaded update, rollback, retained reuse, managed removal, and clean
reinstallation. They do not convert process reachability into gameplay
qualification.

## Remaining evidence and limits

- Windows gameplay, controller behavior, audio, and an in-game memory-card
  save/load cycle are unassessed.
- Runtime-created memory-card files establish managed-path creation and
  preservation only; they are not evidence of a completed in-game save/load.
- Linux installation and native execution are outside this Windows-only
  admission slice and are not claimed by the catalog entry.
- The upstream artifact and executable are unsigned.
- Exact-head required CI and an independent delegated review remain mandatory
  before merge. This record does not authorize signing or publication.
