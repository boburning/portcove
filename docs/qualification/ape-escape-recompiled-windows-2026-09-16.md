# Ape Escape Recompiled Windows qualification, 2026-09-16

This is a dated evidence snapshot for the candidate Portcove catalog admission
of Ape Escape Recompiled. It records exact source and release identity plus a
bounded Windows lifecycle. It is not a full-playthrough, controller, audio,
in-game save/load, signing, publication, or non-Windows attestation.

## Scope

- Candidate port: `ape-escape-recompiled`
- Platform: `windows-x86-64`
- Upstream: `mstan/ApeEscapeRecomp`
- Upstream ref: `v0.3.0` (`831a478c355433de1021fb28cf7f7a03c895ab77`)
- Annotated tag object: `194f440cea4b1e6c0f27c6cf148ca60defa522be`
- Windows artifact: `ApeEscapeRecomp-v0.3.0-windows-x64.zip`
- Artifact size: 37,806,136 bytes
- Artifact SHA-256:
  `91e2cde5f16408ff51b4b822ebba8b811c4e591263170cb49f33a486606c58e9`
- Source identity: Ape Escape USA Rev 0, `SCUS-94423`, one MODE2/2352 track
- Normalized source size: 432,238,800 bytes
- Normalized source SHA-1: `466cce4bcd6992f57227abd270323bcdad2fb7fc`
- Normalized source SHA-256:
  `1ae17e78ebb8c782c7c1785b0a0bd7b0ee28235b8a0c83c8df887129899a852a`
- Portcove base revision: `fdd23625240b2cbb4ab9583a248c7381d4a6c09b`

The owner-authorized source was copied read-only from the BoburNAS RomM
library into the isolated qualification root. Its CHD container is 116,074,173
bytes with SHA-256
`ce05016644dc37caedbb7b87054fdd8f36094494fb75456d95fff34d80250373`.
Proprietary source, generated BIN/CUE bytes, cache products, and private overlay
captures remained outside Git.

## Release and source preflight

- The direct GitHub release API selected release ID `387443374`, published
  2026-09-12T03:40:33Z. GitHub's digest and the publisher sidecar both matched
  the exact Windows artifact identity above.
- The ZIP contains 415 entries and no rooted, parent-traversal, or symlink
  paths. It includes `ApeEscapeRecomp.exe`, immutable `game.toml`, OpenBIOS,
  launcher assets, and a package-local PSXRecomp data layout; it does not
  include the game disc.
- Tagged `DISC.md` publishes the same `SCUS-94423` one-track source size and
  SHA-1/SHA-256 above. Portcove normalized the authorized CHD and matched both
  exact content digests.
- A different valid PSX CHD from the read-only BoburNAS library was refused as
  `source_invalid` with admission reason `known_mismatch`; it was not
  registered. This proves normalized digest rejection rather than extension or
  filename rejection.
- `ApeEscapeRecomp.exe` has SHA-256
  `9d3e909197639746b93bf7ee93c0e676678c1ad8ed78aafb368c2352bca367ce`
  and is unsigned. That limitation is retained rather than presented as
  signed-provenance evidence.

## Runtime ownership repair

The first post-capability prototype correctly ignored the two bounded
`psx_freeze_dump_psx-runtime_<epoch>_<sequence>.json` diagnostics, but immutable
verification rejected Portcove's own newly materialized `disc/disc.cue` and
`disc/disc1.bin` as unexpected. That failed library is preserved at
`H:\Portcove-Worktrees\ape-escape-qualification-20260916\library-post-pattern`.

The final declaration classifies the generated `disc/` source, JIT `cache/`,
private `overlay_captures.json` and `.d` history, heartbeat, run report, and the
bounded freeze-dump filename family as nonpersistent runtime output. Saves,
settings, input preferences, disc/BIOS preferences, and mod state remain
persistent. Generated disc and cache bytes are neither trusted as immutable
package content nor copied into player backups.

## Portcove lifecycle observations

The final candidate was exercised with a locally built CLI in new isolated
libraries. No production credentials, publication path, or existing player
library was used.

- Dynamic resolution selected `v0.3.0` and the exact 37,806,136-byte Windows
  ZIP and SHA-256 above. Fresh installation
  `b28a6ba0-199a-4f44-bb55-c009408fae06` produced manifest
  `1aa65dccbb2811e897c34c3ec1df836027ffae092dfd363b13b9630ab5bb70a4`;
  all 287 immutable files verified.
- Portcove materialized the normalized source as `disc/disc.cue` plus one BIN,
  then launched a responsive `ApeEscapeRecomp` window. The process loaded
  OpenBIOS, identified `SCUS-94423`, created an OpenGL 3.3 context, accepted a
  normal window-close request, and exited 0. Durable request
  `b7a6dc90-3dc6-47f1-b37c-13aab125e514` recorded `succeeded`.
- The bounded run reached 1,011 frames with no fatal report. It emitted two
  automatic freeze dumps and reported zero failed dumps. Post-launch immutable
  verification still passed all 287 files, establishing the new filename
  pattern and exact runtime-path exclusions without widening them to a glob or
  persistent backup rule.
- Backup `e725d706-35a4-4830-ba02-5207fe82ab08` captured 19 persistent files,
  279,825 bytes, with tree SHA-256
  `5c79374af0883bd0885e41cc79d4034665be59e9e5e3d264d23ed2788438abff`.
  It included a synthetic save sentinel with SHA-256
  `0c2915f6ff51c5788aed2e3eca49e30e8dfdf6029017948866f61584468f1b9c`
  and excluded `disc/`, `cache/`, overlays, freeze dumps, heartbeat, and the run
  report. Restore first required explicit destructive confirmation, then
  refused changed authorization state. Reissuing the reviewed restore created
  safety backup `48c1e861-64fd-47ee-8407-326e4024043c` and restored the exact
  sentinel hash.
- A clean upstream payload was adopted as install
  `c97cd510-7084-46dc-9156-030ec040ae74`, then dynamic update downloaded and
  activated `v0.3.0` as install `7d7fde56-027d-4900-a78b-d96c34d35617`.
  Rollback restored the adopted install; the next update reused the retained
  verified release rather than redownloading it. A launch-collected persistence
  sentinel with SHA-256
  `c3a961d848a5a2d3002625d4d60424bf5e0ad17f42e9d5db24038ef7492498cf`
  remained exact through rollback and two retained-release activations. Both
  versions continued to verify all 287 immutable files.
- Managed removal deleted the active version but retained canonical user data.
  A new dynamic install `e960bf40-a1c3-41d5-aae8-9561101c4b55` with manifest
  `0259f8630c6edecfbc69eb6e8b9b0cc743cafd1e3b9bfa430ec5ff9aa67ad77f`
  restored the exact save sentinel at the next launch boundary. The responsive
  relaunch exited 0, durable request
  `b3f67bd5-bd44-4fe2-90d7-c768defe8220` recorded `succeeded`, and post-launch
  verification again passed all 287 immutable files.

These observations cover exact source refusal and admission, dynamic provider
resolution, install, executable discovery, immutable verification, responsive
native launch and normal close, persistent-only backup/restore, adopted-to-
downloaded update, rollback, retained reuse, managed removal, and clean
reinstallation. They do not convert process reachability into gameplay
qualification.

## Remaining evidence and limits

- Windows gameplay, dual-analog controller behavior, audio, and an in-game
  memory-card save/load cycle are unassessed.
- Runtime-created memory-card files establish managed-path creation and
  preservation only; they are not evidence of a completed in-game save/load.
- Linux installation and native execution are outside this Windows-only
  admission slice and are not claimed by the catalog entry.
- The upstream artifact and executable are unsigned.
- Exact-head required CI and an independent delegated review remain mandatory
  before merge. This record does not authorize signing or publication.
