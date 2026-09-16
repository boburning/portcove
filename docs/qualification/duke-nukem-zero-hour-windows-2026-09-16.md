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

The candidate definition was exercised with the locally built CLI in two new,
isolated libraries. No production credentials, publication path, or pre-existing
player library was used.

- A 33,554,432-byte mutation with SHA-256
  `feb4c11dafdaeab339071274e98a73e2b76a5cfd19dce4ada91f3639fad07b67`
  was refused as `source_invalid` with admission reason `known_mismatch`; the
  source list remained empty. The authorized ZIP was then admitted by extracting
  its single member, normalizing it to big-endian N64 bytes, and matching the
  canonical SHA-1 and SHA-256 above.
- The unchanged definition resolved GitLab release `0.0.3` and selected
  `DNZHRecompiled-0.0.3-Windows-RelWithDebInfo.zip` with the independently
  advertised 24,044,294-byte size and
  `ece88320327ffc58ec73e084c23aca274a016e45dd3558a684d59c37f88bdbc3`
  SHA-256. No direct-manifest version or digest pin was used.
- Fresh installation produced install
  `8cfaddf6-fd76-4079-84f7-511435f0d2aa`; all 47 immutable files verified.
  Portcove materialized `dnzh.us.z64`, created the portable marker, and launched
  the same responsive, source-accepted native window. A normal close exited 0,
  and immutable verification still passed.
- Backup `a3c72622-5779-4976-a641-357153f4e532` captured six persistent files,
  including a runtime-created sentinel with SHA-256
  `f389f13a4e2ee048317f19b9cea7e05982bacee094ffab093844770107146a73`.
  After the sentinel was changed, a restore correctly refused stale destructive
  authorization. Reissuing the reviewed restore created safety backup
  `70a2b9f2-bad5-49ff-bbcd-f93fb1ebdea2` and restored that exact sentinel hash
  in both the active install and canonical user-data root.
- A second clean copy of the 47-file upstream payload was adopted as install
  `7fc02f29-1f12-418d-98ea-68f8012205f0`, verified, and launched. The normal
  update resolver then downloaded and activated GitLab release `0.0.3` as
  install `4a6f6caa-b934-4484-92cf-f64ae2b24357`; verification and responsive
  launch passed. Rollback restored the adopted install, which again verified and
  launched, and a subsequent update reused the retained verified release. A
  live-runtime sentinel retained SHA-256
  `8fae44af2a7772f8939cf66d5e4d8fc1d2ab594a3e26bf229ad32c4a0e8cd980`
  through rollback and the retained-release update.
- Removing the first library's installation left its canonical persistent data
  intact. A fresh dynamic reinstall produced install
  `e529f55f-b40a-41d5-94ff-3364dbc62d82`, verified all 47 immutable files,
  launched responsively, and restored the original
  `f389f13a4e2ee048317f19b9cea7e05982bacee094ffab093844770107146a73`
  sentinel into the active `mods` directory.

These observations cover exact source admission, provider resolution, install,
immutable verification, native launcher start and normal close, backup/restore,
adopt/update/rollback/retained reuse, and remove/reinstall persistence. They do
not convert launcher reachability into gameplay qualification.

## Remaining evidence and limits

- The supported Rust test runner was blocked before execution by an existing
  legacy Win32 heavy-test lock owned by the Delivery validation workspace. A
  locked CLI build and the isolated lifecycle above passed; exact-head required
  CI remains mandatory before merge.
- Windows gameplay, controller input, audio, and an in-game controller-pak
  save/load cycle are unassessed.
- Linux x86-64/ARM64, Flatpak, and macOS packages are outside this Windows-only
  admission slice.
- The upstream README still links obsolete GitHub release URLs even though the
  attributable project and release now reside on GitLab. Portcove must use the
  GitLab provider and package metadata rather than those stale links.
