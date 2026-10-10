# DKR-R numbered beta selection and bounded progression proposal

Canonical owner: [#54](https://github.com/boburning/portcove/issues/54).
Proposal preparation: [#254](https://github.com/boburning/portcove/issues/254).
Protected definition acceptance/delivery: [#246](https://github.com/boburning/portcove/issues/246).

## Observed selection defect and correction

The complete direct-upstream release inventory read October 10, 2026 contains
eight records. `Version1.0.5beta12` (release ID 399053184) is published with
`prerelease=false`. The old Core classifier recognized `-beta` but not its
numbered `5beta12` suffix, allowing Stable to select this beta ahead of
`Version1.0.4`. The latter is the retained qualified useful route.

Core now additionally recognizes `beta` immediately between ASCII digits,
case-insensitively. Existing provider flags and hyphenated markers remain
effective. Unrelated words containing `beta` remain stable under this addition.
Stable selects the retained stable release or reports no available stable
release; Beta can observe the beta candidate. Channel classification does not
accept compatibility, change the catalog's declared channels, or authorize an
installation. Fixtures exercise the actual GitHub provider for both cataloged
platforms with the unchanged DKR-R definition. Their bytes/digests are synthetic.

## Exact beta12 proposal inputs

Direct upstream: <https://github.com/ThatGuyMcd/DKR-R>.
Selected tag: `Version1.0.5beta12`, published September 29, 2026.
Both asset identities below are October 10 API declarations; no download,
independent byte verification, unpacking or execution was performed for this
proposal.

| Platform       | Asset ID / name                                         |    Bytes | API SHA-256                                                        |
| -------------- | ------------------------------------------------------- | -------: | ------------------------------------------------------------------ |
| Windows x86-64 | 597977195 / `DKR-R-1.0.5-beta.12-Windows-x64.zip`       | 23636673 | `456ae813bddf2bb34e5be1e63ce00b95bf2b09ca4280d5655d8cea6612358f0b` |
| Linux x86-64   | 597977048 / `DKR-R-1.0.5-beta.12-Linux-x86_64.AppImage` | 28281336 | `525ef84d7382d017de43d3c2dfdc29f608052f88a16ecffac41154d1f720b3ae` |

The complete captured inventory is retained in
`work/54-upstream-release-inventory-20261010.jsonl`. Selection uses version-independent
asset hints. Executable hints use exact case-insensitive relative-path/basename
matching, not globbing or substring matching. The accepted Linux hint remains
`DKR-R-1.0.4-Linux-x86_64.AppImage`; it cannot resolve beta12's filename.

## Proposed compatibility disposition and execution packet

Keep the accepted catalog unchanged. The Stable route should retain 1.0.4 after
the classification repair. If a separately reviewed beta route is admitted,
prepare its explicit channel declaration and exact Linux executable hint
`DKR-R-1.0.5-beta.12-Linux-x86_64.AppImage` using the existing unsigned catalog
proposal tooling. Preserve the 1.0.4 mapping when both releases are offered;
neither a wildcard hint nor a renamed file establishes compatible progression.
Windows `DKR-R.exe` is an expected mapping pending exact archive inspection.

Before accepting that proposal:

1. Verify the exact selected artifacts against authoritative expected digests;
   inspect the Windows archive and Linux executable without running them. Bind
   every immutable file and the actual adapter working coordinates. Reject
   extra executables, ambiguous layouts, unsafe paths and digest mismatches.
2. Preserve accepted US v1.0 SHA-1
   `0cb115d8716dbbc2922fda38e533b9fe63bb9670` and US RevA/v1.1 SHA-1
   `6d96743d46f8c0cd0edb0ec5600b003c89b93755`. Verify the materialized
   `dkr-us-v80.z64` after setup and each offered persistence transition. Bind
   beta12 to its own source validation; old qualification is not inherited.
3. Check upstream storage/source resolution for the exact release. Retain
   `--rom dkr-us-v80.z64 --config dkr-runtime-data` and owned
   `dkr-runtime-data`, `imgui.ini`, and ROM persistence only after confirming
   their actual runtime coordinates and write ownership. Unknown external saves
   receive no destructive operation.
4. In a newly admitted isolated session, record an application-coordinate
   persistence witness and normal close before update. Exercise the offered
   update/rollback/removal operations and verify active/canonical persistence,
   immutable identity, source drift refusal and recovery without weakening
   locks, cancellation, containment or publication guards. Credit matching
   retained 1.0.4 observations; repeat only facts invalidated by the candidate.
5. Submit exact declaration/evidence hashes through #246's existing protected
   acceptance and authenticated unchanged-client path. Proposal generation and
   green source CI alone cannot authorize a signed definition or production
   publication. #534's production authority remains separate.

## Evidence reuse and limits

Retained 1.0.4 Windows lifecycle and #500 Linux install/update/rollback/persistence
remain credited on #54. The Linux WSLg 0x0 launch failure, prior path failures,
recovery failure and retained data remain preserved. A healthy native display
and its own exact session would be needed for a new Linux launch success claim;
this proposal does not retry or replace the accepted truthful limitation.
Optional gameplay/audio/controller/in-game save/load remain unassessed.

The numeric beta repair resolves the observed Stable selection defect. Actual
beta12 executable/source/config/save compatibility, protected acceptance and
unchanged-client delivery remain pending. No support promotion, platform claim,
catalog mutation, native reservation reclamation or release authority is granted.
