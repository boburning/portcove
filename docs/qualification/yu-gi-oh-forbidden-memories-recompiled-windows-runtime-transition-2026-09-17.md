# Yu-Gi-Oh! Forbidden Memories Recompiled Windows runtime transition qualification — 2026-09-17

This record closes two bounded gaps left by the 2026-09-15 cross-version
qualification: native v0.5.7 launch success and actual runtime-state
collection, projection, backup, and restore across the retained v0.5.7 to
v0.6.1 transition. It uses the actual Portcove CLI consumer and managed game
executables. It does not claim gameplay, controller, audio, in-game save/load,
physical-device, non-Windows, signing, feed, publication, or production
behavior.

## Scope and preserved baseline

| Identity                      | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| Portcove checkout             | `f5db8e772998952af8bdd96611dd6501f52ca3ed`                         |
| Portcove version              | `0.1.0-alpha.2`                                                    |
| CLI SHA-256                   | `4483d90e05fb19e5c1d3c742a7b40e3a745605e6efc5cc1390c61bbd4a183c00` |
| Platform                      | `windows-x86-64`                                                   |
| Historical artifact           | `ygofm-0.5.7-win-x64.zip`, 32,200,494 bytes                        |
| Historical SHA-256            | `6a75a0da4e3a2cf51debe0d88bb441693afebde8ffcf4b6b4b07864fa3c115b8` |
| Historical install            | `cc513a2e-1806-4c31-a14b-d917ee3aef53`                             |
| Historical manifest           | `73c1b03235793a437a374f891c34928b8cc21498a9ab5698d898b982f31c5b8e` |
| Historical executable SHA-256 | `5005e43d73554690e71672b702209e0422c0c55940b50cdb14c82f2865daf54b` |
| Current artifact              | `ygofm-0.6.1-win-x64.zip`, 34,799,128 bytes                        |
| Current SHA-256               | `4eed315000952dee7a751a05de4413a88777cf49609d29ab77ee3765a44d0f53` |
| Current install               | `897d0084-c3db-4663-9be0-629008fc9c91`                             |
| Current manifest              | `be9fcf3d1354d8d706c7b0a217b5505975312b97486c78503d8fa1fcb7b22898` |
| Current executable SHA-256    | `86071b9a244638478c84dc0e43e4594d7b165286a9541ff4f46454100edf4828` |

The exact retained library from the earlier qualification remained under
`H:\Portcove-Worktrees\ygofm-v0.5.7-to-v0.6.1-20260915\library-main-6bf60b6`.
Before mutation, all 20,664 files and 1,278,658,169 bytes were copied to a new
recovery snapshot under
`H:\Portcove-Worktrees\ygofm-runtime-transition-20260917\library`. Source and
copy had the same database SHA-256,
`18547bd397845f3ea9ea7a9d6ebe5c39dd2d08a57eadae28965ac8003771f71b`.

Opening that byte copy demonstrated the expected fail-closed ownership
boundary: its database still named the original absolute installation roots,
so current core reported `invalid_installation` and refused rollback and
verification with `registered install path is outside an owned output root`.
The copy was retained as a recovery snapshot, not relabeled as a runnable
library. The already isolated original library remained the controlled mutable
session after its exact pre-session state had been preserved.

The source contract and proprietary input identity did not change from the
earlier record: normalized Track 01 SHA-1
`d5785a41900a10968d4a28a390666c4b9879b796` and SHA-256
`6e22494a45bf50fa2d239cd3819a57163a5f9b91e0365babc3e101509b5c3a7c`.

## Native v0.5.7 launch and collection

Rollback reactivated the exact retained v0.5.7 installation, and independent
verification checked all 2,436 immutable files without a failure. A bounded
Windows observer required the exact executable path and hash, a responsive
named main window, an accepted normal close, CLI success, and a durable
Portcove launch result. It did not inject input into the game.

The first observer attempt exposed a harness-only limitation: a reacquired
Windows process handle did not expose an exit code after normal close. The
observer stopped rather than treating that missing value as success. Portcove's
durable request `0436445a-3298-4aff-be09-0f72921d8752` independently recorded
the exact v0.5.7 child, outcome `succeeded`, and exit code 0. The harness was
repaired to require that durable result whenever the reacquired handle lacks an
exit code, then the same scenario was repeated as a positive control.

Positive-control request `5596c3e9-a43f-461f-bd94-d3bd7c4b6367` launched the
exact v0.5.7 executable. Windows observed the responsive title
`Yu-Gi-Oh! Forbidden Memories - Launcher`; the window accepted normal close,
the CLI exited 0, and Portcove recorded the same exact child with outcome
`succeeded` and exit code 0. Successful launch count reached two.

The first successful launch collected actual runtime output into the canonical
user tree. The prior tree had only the retained
`saves/cross-version-probe.ini`. The clean positive control began with six
files: `input.ini`, `keybinds.ini`, three exact mod manifests, and the retained
probe. Their hashes stayed unchanged through the second launch. Backup
`ff8620c8-a57c-4820-9489-d90c26078aaa` bound that collected six-file,
9,523-byte tree with SHA-256
`8a7276a4ca6baa64a8003429ff9b2c3ae93bef9299635e50d0f4ce7f4caf0236`.

## v0.6.1 projection, collection, and cross-version restore

The ordinary update path reactivated the exact retained v0.6.1 installation,
then verification checked all 2,516 immutable files. Before the v0.6.1 process
started, the observer found the six-file v0.5.7 backup state already projected
into the active v0.6.1 runtime with the same paths and SHA-256 values.

Request `1db62835-70f7-44f6-99bd-3a64483d310f` launched the exact v0.6.1
executable. The same named launcher reached a responsive window, accepted
normal close, and produced CLI exit 0 plus a durable successful zero-exit
record. Collection then produced v0.6.1's eight-file canonical layout: it kept
the same configuration, key-binding, mod-manifest, and retained-probe bytes,
while representing the three manifests under `mods/installed` and adding the
same `input.ini` and `keybinds.ini` bytes under `saves`.

Restoring the v0.5.7-collected backup succeeded while v0.6.1 remained active.
Portcove first published safety backup
`5ddd0b0e-9341-49cd-b549-84b6222439d7`, binding the displaced eight-file,
12,716-byte v0.6.1-collected tree with SHA-256
`7daf68e081dd197f3a3f7aad50ce9f3839a33dd401e85ca7e346f3bc6c0e13f6`.
It then restored the exact six-file backup and projected that state back into
the active v0.6.1 runtime.

Post-restore positive-control request
`5e59fe97-479c-4f44-9112-b6ee3eb2634b` observed the six restored canonical
files and the corresponding active-runtime files before process creation. The
exact v0.6.1 executable again reached the responsive named launcher, accepted
normal close, exited 0 in the durable Portcove record, and completed collection.
Final immutable verification again checked all 2,516 active files without a
failure. Successful launch count reached four, and all three backups remained
healthy.

## Retained evidence

The private evidence root is
`H:\Portcove-Worktrees\ygofm-runtime-transition-20260917`. Reports contain
local source references and remain outside Git. The one-off observer script had
SHA-256 `963c3e333109039c53be972cde5ee2e187ab1d346bfb62f2faa6c09b281a0b21`.

| Evidence                          | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| Initial harness-stop record       | `15b52b0372539dde2be0b3624d96da5cf533ccc3c4c4781bf282b68eb5776dd3` |
| v0.5.7 positive-control launch    | `24a408b91f4e58bd4f2ca614235f803f8091ed502743fe67fcf5a43fc4a7fe1f` |
| Post-v0.5.7 qualification report  | `8eba2adc1b6419f255d6216ca182df56ac20d9998b7d55c1d42bff7a443c2772` |
| First v0.6.1 transition launch    | `5456282b3544f64dc88e68a7f84410c50529b03f97f316c12f7628c1686ddd43` |
| Post-restore qualification report | `20356fd807b35bd517933e73945a4ef19d44446332cf75ca78c6cba5f346bbf5` |
| Post-restore v0.6.1 launch        | `65c83c3e7692c7bb1f41e05393b95fea2e6ac5f5db734353297d6215de09c85d` |
| Final qualification report        | `1b1e86d9abecd78281b7dbbdb18ffe2ec6b632c7c278cc16d84b4d84fabfd6c6` |

## Result and limits

This controlled Windows session passed native v0.5.7 launch, actual v0.5.7
runtime collection and backup, projection into retained v0.6.1, v0.6.1
collection, cross-version restore with an automatic safety backup, and a
post-restore v0.6.1 launch positive control. It extends the earlier exact
artifact lifecycle evidence; it does not replace or broaden that record.

No gameplay was started. Controller input, audio, an in-game memory-card
save/load cycle, human usability, physical-device behavior, Linux, macOS,
signed upstream provenance, production signing, feed behavior, and publication
remain explicitly unassessed. No support-tier or platform badge change follows.
