# Duke Nukem: Zero Hour Recompiled Windows qualification, 2026-09-16

This is a dated evidence snapshot for the candidate Portcove catalog admission
of Duke Nukem: Zero Hour Recompiled. It distinguishes exact source and release
preflight, an isolated upstream-package launch, and the Portcove lifecycle
evidence recorded below. It is not a full-playthrough, controller, audio,
in-game save/load, signing, publication, or non-Windows attestation.

## Scope

- Candidate port: `duke-nukem-zero-hour-recompiled`
- Platform: `windows-x86-64`
- Upstream: `sonicdcer/DNZHRecomp` on GitLab
- Upstream ref: `0.0.3` (`54e61d02f236687fbc93760afce6bff4aa8df24f`)
- Windows artifact:
  `DNZHRecompiled-0.0.3-Windows-RelWithDebInfo.zip`
- Artifact size: 24,044,294 bytes
- Artifact SHA-256:
  `ece88320327ffc58ec73e084c23aca274a016e45dd3558a684d59c37f88bdbc3`
- Source identity: `Duke Nukem - Zero Hour (USA).z64`, canonical big-endian
- Canonical source size: 33,554,432 bytes
- Canonical source SHA-1: `de4db292cc6cf5dd1dd1d3c9700cf8e5c3078410`
- Canonical source SHA-256:
  `5ba016567c53b0d111eb175347c6eee603c31783cd2bb3fea97f31b5ff74190f`
- Portcove base revision: `523c440ae0b2a52ff4582d0392004910ace8aed8`

The authorized source was copied from the BoburNAS RomM library as
`Duke Nukem - Zero Hour (USA).zip`. The ZIP has SHA-256
`2a74e7cfec76f418e7d413dbbdf231dabb954c84e8e5910ac5b77e2213113591`
and contains only the 33,554,432-byte canonical source above. Proprietary bytes
remain outside the repository.

## Release and source preflight

- GitLab's package-file API independently advertises the exact artifact size
  and SHA-256 above. The downloaded bytes matched both values.
- The release archive contains 47 files, totals 53,461,994 extracted bytes,
  and has no rooted or parent-traversal entries. It contains no game ROM.
- `DNZHRecompiled.exe` is unsigned and has SHA-256
  `2cb0599356d3a9c9c3e32ec9f0d302bac3cac9ff7ff2036139506c3d53d4ede7`.
- Tagged source registers the retail ROM hash `0xafc33da7101fec88` and documents
  the single supported North American source. With the authorized source named
  `dnzh.us.z64`, the exact packaged executable reached its source-accepted
  launcher with **Start game** enabled.
- Tagged source checks for executable-adjacent `portable.txt` before consulting
  Windows Local AppData. In portable mode it creates `general.json`,
  `graphics.json`, `controls.json`, and `sound.json` beside the executable;
  upstream also assigns saves, mods, and mod configuration to that same owned
  data root.
- The isolated 1,616 by 999 native window remained responsive, displayed
  `Duke Nukem Zero Hour: Recompiled`, accepted a normal close request, and
  exited with code 0. This confirms bounded source acceptance and launchability,
  not gameplay.

## Portcove lifecycle observations

Pending the candidate catalog definition and an isolated Portcove library run.
This section will record source admission and rejection, live GitLab release
resolution, install, immutable verification, launch, backup/restore,
update/rollback, removal/reinstall, and exact state-preservation evidence before
the candidate is presented for review.

## Remaining evidence and limits

- Portcove lifecycle and failure-path observations are not yet recorded in this
  initial preflight checkpoint.
- Windows gameplay, controller input, audio, and an in-game controller-pak
  save/load cycle are unassessed.
- Linux x86-64/ARM64, Flatpak, and macOS packages are outside this Windows-only
  admission slice.
- The upstream README still links obsolete GitHub release URLs even though the
  attributable project and release now reside on GitLab. Portcove must use the
  GitLab provider and package metadata rather than those stale links.
