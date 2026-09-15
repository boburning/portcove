# Dr. Mario 64 Recompiled Windows qualification — 2026-09-15

This record captures exact Windows x86-64 structural and bounded automated
lifecycle evidence for Dr. Mario 64 Recompiled Plus 1.0.0. It records the
successor decision and retained legacy boundary without promoting the port to
Supported or manufacturing hands-on gameplay evidence.

## Scope

| Identity              | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Portcove commit       | `48a46e6a97d7fd6f1ca5e5dfe089bba60dc7ff85`                         |
| Portcove version      | `0.1.0-alpha.2`                                                    |
| Platform              | `windows-x86-64`                                                   |
| Upstream repository   | `theboy181/drmario64_recomp_plus`                                  |
| Upstream ref          | `1.0.0`                                                            |
| Upstream commit       | `45a10adc25c02e1679be305640f18d24d9c61c75`                         |
| Release asset         | `Dr.Mario.64.Recompiled-v1.0.0-Windows.zip`                        |
| Artifact size         | `24,225,142` bytes                                                 |
| Artifact SHA-256      | `ba749f48725e23636845c9a79a89e17859172ac80fa7b98bf4523d12c1f0d2cf` |
| Source contract       | `dr-mario-64-recomp-game-source`                                   |
| Source variant        | `usa-rev0`                                                         |
| Source representation | `canonical-rom`                                                    |
| Check contract        | `dr-mario-windows-qualification-v1`                                |
| Isolated evidence     | `H:\Portcove-Worktrees\dr-mario-64-successor-2026-09-15`           |

The `1.0.0` tag points directly to the commit above. The tag commit and the
11,843,072-byte Windows executable are unsigned. GitHub's published asset
digest and the independently downloaded bytes agreed. Portcove's admission
authority is the checksum-qualified release, not a signature claim.

## Successor and legacy boundary

The retained catalog entry pointed at `AngheloAlf/drmario64_recomp`, whose
public repository has no release. Recomp Plus is a GPL-3.0 fork of that exact
project. Its 1.0.0 tag is twelve commits ahead of merge base
`7892264252fd662c140625ad35cab62825ab473b`; the changes include the build,
assets, input, configuration, renderer, UI, support code, and pinned runtime
dependencies needed by the published Windows package.

The successor keeps the existing game, source, catalog, and durable issue
identity: `dr-mario-64-recomp`, `dr-mario-64`, and #97. It replaces release
resolution for new operations but does not rewrite existing installation rows,
artifact hashes, manifests, user data, or issue history. There is no published
artifact from the former repository with which to claim a managed cross-version
update or rollback. Shared successor/alternative policy remains owned by #139;
this record is only the concrete port decision and compatibility evidence.

## Source identity and rejection

The authorized BoburNAS source remained untouched. Its ZIP container was copied
read-only into the isolated evidence root; Portcove used the extracted read-only
ROM as its registered input. Proprietary bytes remain outside Git.

| Observation        | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Source ZIP size    | `3,042,418` bytes                                                  |
| Source ZIP SHA-256 | `d524818c97abb4b4ca28c55a3a715ab7abd85bb9eed329d2f052afd957163e81` |
| ROM size           | `4,194,304` bytes                                                  |
| ROM SHA-1          | `a130d3622ce40e0158db2da4247101f6e92206fc`                         |
| ROM SHA-256        | `bb2c0dec0a8287ad256929563d0509801c2f239df883c1cf52cab05b23bd77b6` |

The exact-contract CLI reported `recognized_exact` for normalized and canonical
N64 big-endian content and admitted `usa-rev0`. A same-size fixture with only
its final byte changed had SHA-256
`12b486fb1a01e409b9a5ae13a4af43deea041c20127dae47dd74034f2a816b7f`.
`source add` rejected it as `source_invalid`/`known_mismatch`, exited 5, and left
the fresh rejection library with zero registered sources.

## Install, executable, and runtime-root repair

The temporary catalog projection installed the official artifact as operation
`12c5507f-5a8f-4bf0-804c-f3b12ec7ce88`, selected
`Dr. Mario 64 Recompiled x64-Release/drmario64_recomp.exe`, and verified all 83
immutable release files. The selected executable's SHA-256 was
`9448a88d4b004c223eb99686dae48d85f413cd40cb97ec1cb3d6c5d7157e4c9a`.

The first projection retained the generic N64 adapter's install-root working
directory even though this archive places its executable and assets in a
wrapper directory. Launch request `8dbf5cbd-59d3-4f4f-86b4-9c20bbf75a78`
failed with Windows status `0xc0000409`. A bounded repeat attached ProcDump to
the exact owned child. WinDbg found an unhandled `std::length_error` in the
unsigned upstream executable followed by `abort` and
`FAST_FAIL_FATAL_APP_EXIT`; upstream symbols were unavailable. The 3,801,639
byte dump has SHA-256
`5a4b553109091b0445bbf8e4332e664f1e5483bb56bd7dba3a47aab0191dcd0b`.

Declaring runtime subdirectory `Dr. Mario 64 Recompiled x64-Release` aligned the
working directory, executable, packaged assets, portable marker, source copy,
and settings. That single catalog repair removed the fail-fast reproduction.
The exact CLI used for the final source-contract run had SHA-256
`5070f94959117de7a2d138fe544ef10c3b52757bc30bfea48616423afeb944f8`.

## Native launch and renderer boundary

The qualification host used AMD Radeon RX 9070 XT driver
`32.0.31041.1004`. Earlier #97 evidence on the same driver recorded automatic
and explicit Vulkan crashes in `amdxc64.dll`. Those failures were not relabeled
as passing evidence or repeated after the driver identity proved unchanged.

For the distinct route, portable `graphics.json` explicitly selected `D3D12`.
Requests `a829dbfb-166c-4ac0-91ad-d9fc5829c1b4`,
`4d19ca1c-1afe-407d-b1df-e063210b478f`, and
`90543af0-d291-47cc-9ae0-625009380a89` each reached an exact owned
`drmario64_recomp.exe` child. Windows reported the responsive title
`Dr. Mario 64: Recompiled`, the process rendered native game/menu content, and
SDL reported the `windows` video driver. Each exact window accepted a normal
`WM_CLOSE`; every child exited 0 and every durable request finished
`succeeded`. The last request ran after exact source enforcement.

The retained 1296 by 999 window capture is 257,070 bytes with SHA-256
`e1a8828da36961ccd03dfeb2bd335b6f64a25ada18c9687421951429de2f2796`.
It proves the recorded presentation observation only. It does not prove player
input, gameplay correctness, controller mappings, audio quality, or save/load.
Every run also printed `Failed to load controller mappings: Invalid RWops`;
controller behavior therefore remains explicitly unqualified.

## Persistence, update, rollback, removal, and reinstall

The portable runtime created or retained the exact source copy, `general.json`,
`graphics.json`, `controls.json`, `sound.json`, `mods`, and `mod_config` under
the wrapper directory. The declared ownership also covers `mods.json`, `saves`,
and the four configuration backup names when upstream creates them. The D3D12
configuration remained byte-identical at SHA-256
`a3d79ec6cf26dabdf51043520bb69537b7c2f256c1adaaca9f1912bc3d3154ab`.

A same-version update returned the existing 1.0.0 installation and recorded
`update_available: false`. With no older retained release, `rollback` failed
closed as `not_found` and did not mutate active state. This is an explicit
absence boundary, not cross-version rollback evidence.

Managed removal deleted only the installed version. The exact hashes of all
five collected files—including the source copy and four settings files—remained
unchanged. Clean reinstall operation `570c240f-c25b-4ac1-98b6-e388d5ece50e`
selected the same artifact and executable. Before its child ran, Portcove
restored the exact D3D12 settings and ROM into the wrapper directory. The
post-reinstall request exited 0; final immutable verification again checked all
83 release files with no failures. The library finished with three successful
launches and no owned processes left running.

## Result and limits

The `dr-mario-windows-qualification-v1` structural and automated lifecycle
checks pass only for the exact artifact/source/variant/platform identities
above. They cover successor/release binding, exact source admission, one-byte
near-match rejection, archive-root repair, fresh install, immutable
verification, responsive native D3D12 presentation, normal close, persistent
collection, no-op update, absent-rollback refusal, removal preservation, clean
reinstall, and restored-state relaunch.

The following remain explicitly not run or unclaimed:

- hands-on gameplay, controls, audio, and in-game save/load;
- controller mapping correctness, including the observed mapping-load warning;
- automatic or Vulkan renderer success on the current AMD driver;
- physical-device behavior and non-Windows installation or execution;
- signed upstream provenance;
- cross-version successor update, rollback, or retained-version reactivation;
- interruption recovery beyond the generic prebuilt portable installer
  guarantees already covered by repository tests;
- backup and restore of this exact configuration.
