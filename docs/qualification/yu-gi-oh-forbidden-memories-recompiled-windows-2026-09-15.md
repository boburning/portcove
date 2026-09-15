# Yu-Gi-Oh! Forbidden Memories Recompiled Windows qualification — 2026-09-15

This record captures exact Windows x86-64 structural and bounded automated
lifecycle evidence for Yu-Gi-Oh! Forbidden Memories Recompiled v0.6.1. It does
not promote the port to Supported or manufacture hands-on evidence.

## Scope

| Identity | Value |
|---|---|
| Portcove commit | `327626b154a45f2af52de77ab06fae54c4794ef2` |
| Portcove version | `0.1.0-alpha.2` |
| Platform | `windows-x86-64` |
| Upstream ref | `v0.6.1` |
| Upstream commit | `6b3579c6032fc59479a127824a27fc1f810e4f14` |
| Release asset | `ygofm-0.6.1-win-x64.zip` |
| Artifact size | `34,799,128` bytes |
| Artifact SHA-256 | `4eed315000952dee7a751a05de4413a88777cf49609d29ab77ee3765a44d0f53` |
| Source contract | `yu-gi-oh-forbidden-memories-recompiled-game-source` |
| Source variant | `legacy-accepted` |
| Source representation | `normalized-track-set` |
| Check contract | `ygofm-windows-qualification-v1` |
| Isolated library | `H:\Portcove-Worktrees\ygofm-v0.6.1-20260915\library` |

The annotated upstream tag is unsigned and resolves to the commit above. The
GitHub provider digest and the downloaded release bytes matched. The signature
limit is recorded rather than treated as a failed integrity check: Portcove's
admission authority for this artifact is the checksum-qualified release.

## Source identity and rejection

The authorized BoburNAS copy was read-only source input. Proprietary source and
generated game data remained outside Git.

| Observation | Value |
|---|---|
| CHD size | `151,881,565` bytes |
| CHD SHA-256 | `3447677c2313417e285abed0b18bd9c24c0a2efb095ede61b9b0b1edecdc8ff4` |
| Normalized Track 01 size | `517,872,768` bytes |
| Normalized SHA-1 | `d5785a41900a10968d4a28a390666c4b9879b796` |
| Normalized SHA-256 | `6e22494a45bf50fa2d239cd3819a57163a5f9b91e0365babc3e101509b5c3a7c` |

`source add` and a later independent `source verify` both reported
`recognized_exact` and `current`. Portcove rechecked both normalized and storage
identities around managed preparation. An eight-byte malformed file with the
reviewed `.chd` extension failed through `chdman` as `source_invalid` with exit
code 5. That proves the exercised malformed-container rejection path; it does
not broaden or exhaustively characterize every near-miss disc revision.

## Install and immutable verification

`plan` selected the exact v0.6.1 Windows asset and provider digest with the
registered source. The containing volume reported about 58 GB available.

Fresh install operation `10a08fb5-ce4f-4358-8319-4d08ffa7142b` completed the
checksum-pinned 209,497,009-byte PSX toolchain acquisition, asset download and
verification, source-bound generation, compilation, publication, and activation.
It selected
`build-portcove/Yu_Gi_Oh_Forbidden_Memories_Recompiled.exe`. The initial
manifest SHA-256 was
`351937ace5be95380d23e170e1df99776deca0c16b6c2fb4d9cf631b75597158`, and
post-install verification checked 2,516 immutable files with no failures.

## Native launch and collection

Launch requests `d1f45b1a-2b34-4b7c-97b6-320bfb3d5b08` and
`b9a77e08-8b25-4c68-9b6a-9361ef19d361` each reached a distinct child at the
exact managed executable. Windows reported the responsive title
`Yu-Gi-Oh! Forbidden Memories - Launcher`. Both accepted a normal main-window
close, exited 0, completed collection, and produced terminal `succeeded`
records.

Collection produced seven canonical user files: five bundled-mod manifests plus
`saves/input.ini` and `saves/keybinds.ini`. Their initial configuration hashes
were:

- `input.ini`: `a03b43075302081d3c13f513e7d415ac3dc57a35513d36df402a6de7570d52bc`
- `keybinds.ini`: `4d2ab845d3f99a7625d303e926e1a886f9a021e3cae82559132faa7d4fc73c55`

## Backup, restore, removal, and reinstall

Managed backup `9ee278c7-305d-4149-a0db-195921dc26e9` was healthy: seven files,
10,315 bytes, and tree SHA-256
`0765b38a69bc9231618b1dbd9375c3f4bdc7aba223c6198da5f9a44f84035c5f`.

An isolated runtime-only `input.ini` probe was collected and snapshotted as
backup `20fdc660-42bc-406a-accf-efa63f0e8fd4`, with tree SHA-256
`b51aadaa799004daef380b9fa824f90c65f777a171c302e28b8ef97ef32c75ec`.
Restoring the original backup recreated the exact original hash in canonical and
active data. Portcove automatically published safety backup
`5d8f4a8b-8393-4253-9c50-0bfddd3fd511` for the displaced state with the same
changed-state tree hash.

A separate deliberately divergent canonical-user-only probe was rejected with
`conflict`: the locked recheck collected different active runtime state before
consuming authorization. The operation did not overwrite ambiguous state. This
is retained as a fail-closed observation and is not counted as restore success.

Managed removal deleted only the version directory. All seven user-file hashes
and all three verified backups remained unchanged. Fresh reinstall operation
`168bf2c6-7680-4a1d-9f83-178e928567a1` rebuilt the exact release/source,
selected the expected executable, and again verified 2,516 immutable files. The
new build initially had no runtime `saves/input.ini`.

Post-reinstall launch request `5dca1227-4514-443e-9ea1-c5e5ebfca384` restored
the exact original `input.ini` into the new runtime before the child ran. One
early Windows sample was temporarily nonresponsive; the next sample was
responsive at the expected title and path. Normal close exited 0, collection
succeeded, the isolated library reached three successful launches, and final
2,516-file verification remained clean.

## Result and limits

The `ygofm-windows-qualification-v1` structural and automated lifecycle checks
passed for the exact identities above. The check contract covers release/source
binding, malformed-container rejection, fresh managed build/install, immutable
verification, responsive native launcher supervision, persistent collection,
backup/restore with safety backup, remove preservation, clean reinstall, and
post-reinstall persistent restoration.

The following remain explicitly not run or unclaimed:

- hands-on gameplay, controls, audio, and in-game save/load;
- physical-device behavior;
- Linux and macOS installation or native execution;
- signed upstream provenance;
- v0.5.7-to-v0.6.1 update, rollback, and retained-version reactivation.

Earlier v0.5.3-to-v0.5.7 evidence retains only its recorded artifact and source
identities. Neither it nor this record can be generalized to the missing scope.
