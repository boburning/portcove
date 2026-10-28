# Ordinary Linux updater observation — October 28, 2026

Owners: [#225](https://github.com/boburning/portcove/issues/225) and
[#52](https://github.com/boburning/portcove/issues/52). This dated component
receipt advances the [existing acceptance matrix](application-updater-beta-acceptance-2026-10-28.md).
Both issues remain open; live planning remains in the Project.

## Actual run and retained identities

[Run 40687436191, attempt 1](https://github.com/boburning/portcove/actions/runs/40687436191),
job `122813315430`, passed the maintained `legacy-adjacent` rehearsal on
Ubuntu 24.04.5 x86-64. Executed source
`75d762a0cbacd1d0ea45f91f439c520e20e5c7e9`, tree
`d831111966335660a582d29c788227d067ce0a1a`, includes the root-account guard from
[#3848](https://github.com/boburning/portcove/pull/3848). All five required CI
contexts passed on that source in run `40686248479/1`; independent source and
target review, guarded merge and remote readback are retained by that PR.
Later changes do not inherit this native result automatically.

The original artifact `12818380097` is 624,001,587 compressed bytes, SHA-256
`fda557cdf799461ef7c094aace85a1d52cdfcc81b940dd887db157b53d134c40`.
Download and inert inspection matched the provider digest. A bounded central
directory preflight preceded library parsing; all 507 file hashes and
832,978,311 expanded bytes were inventoried. The original archive and file
manifest are retained under `E:/Codex-Evidence/beta-updater-20261028/`; the
retained archive copy was rehashed. No archived application was executed by
the collector.

The [structured receipt](linux-updater-rootless-observation-2026-10-28.json)
records original report identities, exact package/signature/public-key bytes,
metadata role signatures/key IDs/versions/digests, fixture feed locations,
preserved-file hashes and explicit limits.

| Item                                       |      Bytes | SHA-256                                                            |
| ------------------------------------------ | ---------: | ------------------------------------------------------------------ |
| Updater-enabled qualified `0.1.0` AppImage | 98,425,336 | `9bb86e232293cae9c4e82ce855b734340494a1b93a9e7975f7b5433e5aa96f92` |
| Candidate/staged/stable `0.2.0` AppImage   | 98,183,672 | `a41626f5f749498bb332daf0d881b51966ea3e6d800f7fa5adb9729c97b267b0` |
| Separate ordinary default-feature AppImage | 98,212,344 | `0b1562a1ba99a3847df0779968c480eb52a2070dfd5fd8b67217ccdc6970196d` |

The maintained Rust release verifier additionally verified both exact retained
endpoint payloads and their Tauri signatures offline on Windows. Its executable
SHA-256 is `009bd98d4ed037be16c948c67c94d2f3927349dc9727986592983e3ce692e5c2`;
both results bind decoded Tauri/Minisign public-key text SHA-256
`7be944f06f4ee8588fb73b2cfe31d31ba4c8b95baca9f5da1056eedc65787921`.
The encoded `.pub` file's raw-byte digest is recorded separately in the JSON.
That is signature-component verification, not another installed Linux journey.
An initial auxiliary invocation failed without a verification result or retained
native exit code. A subsequent invocation with the standard Windows command
environment passed on unchanged inputs; no cryptographic cause is assigned to
the first failure.

## Credited observations

The actual caller UID/GID and stable-file owner UID are all `1001`; the final
stable AppImage mode is `755`. Host baseline: kernel `7.0.0-1017-azure`, glibc
`2.39`, WebKitGTK `2.52.6`, FUSE `2.9.9-8.1build1`. Noninteractive sudo sets up
the bounded tmpfs capacity fixtures; application execution remains under the
ordinary caller. Capabilities are not separately recorded.

The installed lifecycle reports authenticated selection/staging, owner-write
refusal, one-byte truncation refusal, interrupted-copy/displayless repair,
incompatible apply-journal refusal, actual read-only/full-state/full-AppImage
filesystem controls, runtime peer contention, post-exchange interruption,
backup/reconciliation, stable-target preservation, desktop-entry preservation
and data-preserving rootless uninstall. Missing/wrong payload signature controls
remain the separate compiled consumer observations recorded by the harness.
They are not all renderer-driven negative cases.

A separate isolated renderer instance saved Preview/Manual, checked the signed
candidate, downloaded/verified the exact staged bytes, selected Restart and
observed the candidate's Tauri setup/reconciliation. It records helper and
candidate disappearance plus an empty post-driver process inventory. These are
not independent helper/relaunch OS exit codes. Screenshot bytes are retained;
this receipt makes no new visual assertion from them.

The subsequent separate ordinary default-feature package passed the selected
`native-error-recovery` startup/IPC scenario. It was rebuilt from the same
current source after fixture configuration was removed. It is not a historical
published Alpha package, an ordinary-package updater transition or every
native scenario.

## Remaining acceptance and authority

Both transition endpoints use qualification instrumentation; the predecessor
embeds disposable public trust and a local `file:` feed. Exact metadata and
payload identities are now retained, but no production feed, HTTPS transport,
production custody or public publication is established. The versions were
rebuilt from current source, not historical releases or historical schemas.
Apply-journal incompatibility is not library-schema migration proof.

Library/game/save/backup/log preservation here is exact synthetic-marker
preservation. It does not establish real installed game/save continuity.
Historical updater-less manual bootstrap, actual OS reboot, required waiting
and missing remote/offline/redirect observations, real-data continuity and
remaining declared environment/mount/noexec/path rows still belong to #225.
Reuse the previously accepted skipped and Preview-to-final cohorts at their
recorded scopes; this run does not invalidate or repeat them.

[#534](https://github.com/boburning/portcove/issues/534) retains actual production
signing/feed authority. [#706](https://github.com/boburning/portcove/issues/706)
and [#49](https://github.com/boburning/portcove/issues/49) retain the separate
non-remediating GLib risk disposition. Its November 14, 2026 expiry or earlier
second relevant beta publication is unchanged; exact candidate, publication
count and policy must be reconfirmed at actual release. This disposable local
cohort consumes no public exposure and grants no renewal.

Later full 1.0 qualification remains #46, macOS #226 and Steam Deck #535 remain
independent owners, and this ordinary Linux result establishes no Deck claim.
