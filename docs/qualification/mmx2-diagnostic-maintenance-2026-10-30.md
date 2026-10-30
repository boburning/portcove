# Mega Man X2 diagnostic maintenance — October 30, 2026

This is one fresh managed maintenance row under [#165](https://github.com/boburning/portcove/issues/165), [#2510](https://github.com/boburning/portcove/issues/2510), [#2926](https://github.com/boburning/portcove/issues/2926) and the overlapping historical [#1422](https://github.com/boburning/portcove/issues/1422). It updates an existing definition, adding no listing or frozen identity. It does not retire the retained v0.1.4 compatibility decision or the remaining installed-client/protected acceptance.

## Exact runtime and source coordinates

| Coordinate        | Retained fresh definition                                          | New fresh definition                                               |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Release           | v0.1.5                                                             | v0.2.1                                                             |
| Windows ZIP bytes | 13,128,270                                                         | 13,139,404                                                         |
| Expected SHA-256  | `dcfc7bee4e817cff7fd95c315800732ab4cc877df1c5225afd314585eac9494d` | `334474edf3c575062eeabc0f8f2ac9e74d9bed304c18a521e0709294fdfcfc09` |
| Title source      | `9c3b374c4a0cf0a93748a52a74375d2b4af731a3`                         | `68caca6fe6d96ff423fd26266aedae2132ffb680`                         |
| Framework source  | `05786e50bca11dff1f09f76c0e7ac9d48072c440`                         | unchanged                                                          |

The new [official release](https://github.com/mstan/MegaManX2Recomp/releases/tag/v0.2.1) asset 690890018 has a published SHA-256 matching the actual downloaded ZIP. Static inspection found 25 entries, 37,666,001 expanded bytes, an AMD64 root `MegaManX2SNESRecomp.exe` (28,583,896 bytes), and no packaged `logs` member. This is artifact inspection, not executable execution or a source-to-binary attestation. The title comparison and both recursive source trees were complete; inspected source blobs were bound to their Git identities.

Executable-parent working directory, `--no-launcher game.sfc`, `SNESRECOMP_NO_LAUNCHER=1`, exact USA headerless original profile and SHA-256 `f3246755f608a1e1dc9c848b61da3b824c7853b29b3be40df6fc7f2793a887ed` remain unchanged. Original size is 1,572,864 bytes, CRC32 `947B0355`. The printable-ASCII/MAX_PATH restriction remains. Original data is private, separately supplied and included in managed backups. Preserve upstream PolyForm Noncommercial and dependency notices, immutable packaged mods and assets; extra mods/donor assets need separate qualification.

## Writers and maintenance contract

All eight existing persistent roots remain in order: `game.sfc`, `config.ini`, `keybinds.ini`, `rom.cfg`, `saves`, `screenshots`, `mods/preloaded/state.toml`, `mods/preloaded/state.toml.tmp`. The only addition is the complete `logs` directory.

The [tagged diagnostic contract](https://github.com/mstan/MegaManX2Recomp/blob/68caca6fe6d96ff423fd26266aedae2132ffb680/docs/DIAGNOSTICS.md), [replay writer](https://github.com/mstan/MegaManX2Recomp/blob/68caca6fe6d96ff423fd26266aedae2132ffb680/src/mmx_replay.c) and [Windows startup](https://github.com/mstan/MegaManX2Recomp/blob/68caca6fe6d96ff423fd26266aedae2132ffb680/src/mmx_startup.c) establish these default executable-parent outputs:

- `logs/mmx2-<timestamp>-<PID>.log` session output when stdout/stderr are not already redirected;
- `logs/mmx2-replay-<timestamp>-<PID>-NNNNNN.replay`, with `.sav`, `.config.ini`, `.mods.toml` and `.mods.txt` sidecars;
- the temporary `logs/.mmx2-replay-<PID>` writable-directory probe.

Default capture stays enabled. Each launch retains at most 360 ten-second segments and 256 MiB of checkpoint bytes; this is not a total-directory limit. Older sessions accumulate until manually removed. Recordings contain game memory, input, build/original identities and settings/mods that may expose local paths. There is no automatic upload. Share only with consent; keep sidecars together. Queue/storage failure stops capture while gameplay continues; run-ahead suspends it. Replay correctness and game save/load have not been independently qualified here.

`MMX_REPLAY_RECORD=0` remains an optional user opt-out. Keep custom `MMX_REPLAY_DIR`, config.local.ini, oracle and separate developer trace/path modes outside this default contract. No Core environment remapping is introduced. A read-only installation can fall back to `%TEMP%/MegaManX2SNESRecomp/logs`, outside managed backup/removal scope. Packaged logging.ini controls Windows session output; do not infer Windows behavior from the POSIX-only console environment control. The shared replay worker is joined before process return. This title does not enable the shared in-game launcher relaunch path.

Existing runtime diagnostic declarations remain `.snesrecomp_write_probe`, `last_run_report.json`, `crash_report_*.json` and `crash_minidump_*.dmp`. No broader executable, persistence-pattern or source authority is added.

## Offered operations and acceptance boundary

| Operation                                                                  | Contract after this batch                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh creation and direct Play preparation                                 | Pinned official Windows package with the exact separately supplied original; no gameplay claim                                                                                                                |
| v0.1.5 to v0.2.1 scope expansion                                           | Existing generic empty-only checks apply to active, canonical and actual reused target roots. Only the exact verified regular original is exempt from the empty-player-data check. Added logs must be absent. |
| Populated common data or pre-existing added logs                           | Refused without mutation; retained runtime and data remain available                                                                                                                                          |
| Managed backup/restore, export/import and preserving removal               | Existing owned-data contracts include logs for the new creating definition; prior installations retain their exact creating contracts                                                                         |
| Ordinary scope shrinking                                                   | Refused. Retained rollback remains subject to its existing empty proof; populated logs prevent shrinking. No new downgrade or migration authority.                                                            |
| v0.1.4 state/SRAM compatibility, populated adoption                        | Still held; exact creating runtime/state/config evidence and applicable authority are required                                                                                                                |
| Actual native gameplay and installed Desktop/protected definition delivery | Not evaluated by this maintenance batch; #246/#534 ownership remains                                                                                                                                          |

The independently retained v0.1.5 fixture prevents the new catalog from silently redefining the old scope. The named lifecycle regression uses actual old/new port contracts with inert first-party original and package bytes. It checks empty expansion, retained original/manifest/receipt identity, active saves, canonical config, pre-existing logs, and populated shrinking/rollback refusal. Existing generic scope-expansion tests cover actual reused targets, rechecking after staging, missing authority and interrupted activation/recovery. These are Core fixture observations, not retail-original or actual-game evidence.

Selected denominator: one fresh maintenance operation row. Qualification, independent review, exact-head CI, guarded merge and remote readback must all complete before marking it delivered. The six retained Direct/legacy transitions remain 0/6 retired, six open. This dated record supersedes only the v0.1.5 fresh package/default-writer coordinates in [the earlier fresh-consumer record](direct-fresh-consumers-2026-10-29.md); it preserves that record's historical evidence and acceptance limits.
