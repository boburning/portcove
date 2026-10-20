# F-Zero managed Windows route — October 19, 2026

Candidate for [#1114](https://github.com/boburning/portcove/issues/1114) and
the managed-setup portion of [#2177](https://github.com/boburning/portcove/issues/2177).
This records actual isolated Core/CLI operations and native title-screen starts.
It does not establish gameplay, input/controller operation, audio, in-game
save/load, minimum Windows version, Linux, or Supported status.

## Exact execution scope

| Input                    | Identity                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Executed Core/CLI source | `67550c6c7b3cafc63914d6ec59a37863ed842458`                                                                               |
| Source tree              | `7a06f5f751adedfe573f737fdaa4ad8a1ec59296`                                                                               |
| Retained CLI             | 46,960,128 bytes; SHA-256 `713c09a5cff7d94d62dba2293ddcb20f5c9c7155832567ae5253463cf91ef45c`; API71                      |
| Upstream tag/commit      | [v1.8.3](https://github.com/mstan/FZeroSNESRecomp/releases/tag/v1.8.3), `1686df46d4fc7c22b5dc8fdfaa5282ca4bd78562`       |
| Official Windows asset   | `580473673`, `FZeroSNESRecomp-1.8.3-windows-x64.zip`, 8,247,843 bytes                                                    |
| Archive SHA-256          | `4a97edf9478501ad15d5f66403298e5c983d69558b1839017acbba5c58efe658`                                                       |
| Selected executable      | `FZeroSNESRecomp-1.8.3-windows-x64/FZeroSNESRecomp.exe`                                                                  |
| Executable identity      | 9,310,178 bytes; SHA-256 `b2875639509787278193299a283545b23b2808c8e2608a7ad6858132d2605d96`                              |
| Original source          | F-Zero USA, headerless `.sfc`, 524,288 bytes; SHA-256 `bf16c3c867c58e2ab061c70de9295b6930d63f29f81cc986f5ecae03e0ad18d2` |
| Source contract/identity | `f-zero-snes-recomp-game-source`; `f-zero-snes-usa` / `usa` / `headerless-sfc`                                           |

The official API asset digest matched downloaded bytes. Pinned upstream source,
framework dependencies, package inventory and executable identity were retained.
Original game files are privately supplied, not redistributed. License/dependency
notices and packaged patches/assets remain unchanged. This package enables its
BS Deluxe changes by default; stderr confirms that module and separate 32 KiB
save initialization. Imported mods, MSU music, tracing and capture are outside
this route. Static source/package checks are not a network-listener observation.

## Observed operations

The agent operated a new disposable library with private preferences and runtime
lock, authorized source copies and maintained host-resource admission. Native
launches acquired the exclusive desktop lease and identity-bound process helpers.
No player installation or save folder was adopted.

1. Source validation rejected a 1,024-byte invalid file. A valid source with a
   Unicode filename registered with the exact identity above.
2. An installation review followed by a changed disposable original was refused;
   no managed install became active. Restored bytes required a fresh review.
3. Reviewed acquisition installed the exact official package. Immutable
   verification reported `valid: true`, 70 files and no failures; readiness
   reported launchable with current original files.
4. Native request `65b4e608-8931-4150-9ffb-b67b2b7562b3` launched the selected
   executable with `fzero.sfc`, bypassing manual launcher setup. Maintained helpers
   bound CLI PID15512 and game PID26208. The captured owned window visibly showed
   the F-Zero title screen with Grand Prix and Practice. No gameplay input was sent.
5. A synthetic persistence probe was written through the active runtime's
   `saves` directory. Ordinary close settled the supervisor with exit0 and durable
   outcome `succeeded`. Positive process-exit checks and 70-file verification
   passed; the canonical per-port directory retained the exact probe bytes.
6. Supported backup creation captured owned persistent data. After changing the
   active synthetic probe and collecting it through a second backup, restoring
   the first backup restored its original canonical bytes. This checks byte
   preservation, not the game's ability to load a gameplay save.
7. Reviewed managed removal preserved that probe and retained healthy backup
   inventory. Fresh reviewed reinstall of v1.8.3 passed immutable verification
   and preserved the original source and canonical probe. New installation ID:
   `dee58fc1-b492-4bca-92f1-9177a4d24ad8`.
8. After reinstall, a second session deliberately corrupted only the private
   active and canonical `fzero.sfc` copies while retaining the exact matching
   source sidecar. Runtime assertions bound every sidecar field to the actual
   registered original. Request `c694b08d-e1b4-44d3-982c-8ca445cee1cd` recreated
   the exact game-file bytes, reached the same visible title screen, and closed
   normally. The protected original, registered original and older persistence
   probe remained unchanged. The new probe and exact runtime source were
   collected into canonical ownership. Both captured processes were absent at cleanup.

The source and runtime mapping, persistent declarations and offered artifact were
unchanged by later target integration. Later catalog wording changes do not
relabel the earlier executable. API72's separate external-ownership refusal was
delivered by PR2203; the API71 execution above does not prove native relinking.

## Ownership and maintenance

The staged-source portable adapter owns only its newly installed copy. Runtime
source materialization is an exact checked copy. Persistent ownership is limited
to `fzero.sfc`, `config.ini`, `fzero-video.ini`, `fzero-video.ini.tmp`, `keybinds.ini`,
`rom.cfg` and `saves` relative to the discovered package working directory.
Diagnostics, the write probe and bounded crash-report/minidump patterns are
disposable integrity exclusions. Existing external registrations remain
non-owning; they require explicit separate handling and are not converted.

The maintenance target is **managed-compatible-release**: each accepted release
retains immutable version/artifact identity and needs its applicable compatibility
evidence. The current direct manifest offers only v1.8.3. This is not a permanent
pinned-release exception. No second version was offered or tested here, so
version-to-version update and rollback remain Not run; there is no usable older
managed version in this library. Newer-artifact compatibility, export/import and
gameplay save/load are not inferred from reinstall or probe preservation.

## Retained failures and custody

- The initial capability probe omitted its private library environment and was
  refused by the default library's migration-history guard. No manual migration
  repair or reset was attempted. Opening a library may acquire locks/configure
  WAL; no zero-write claim is made. The corrected isolated probe passed without
  rebuilding the retained executable. Its receipt records reconstructed custody.
- The first native helper did not match a Windows extended-path spelling. Owned
  supervisor-tree cleanup succeeded; that run remains failed. The second attempt
  timed out while recovering the earlier interrupted request before game spawn.
  The passing third attempt used a finite120-second CLI harness budget, retaining
  the existing finite game/close/helper deadlines. This does not establish a
  causal product repair or production performance.
- The first restore experiment changed only canonical probe bytes. Core's fresh
  review collected the active copy and correctly refused stale authorization.
  The repaired experiment changed the active copy and used supported collection;
  no authorization protection was weakened.

Detailed private evidence is retained under
`E:/Codex-Evidence/ui-ux-implementation-20261019/managed-fzero-a1/`:
`lifecycle-a1/receipt.json`, `lifecycle-a1/native-a3/receipt.json`,
`lifecycle-a1/maintenance-a2/receipt.json`,
`lifecycle-a1/native-cache-a1/receipt.json`, owned-window screenshots and
`qualification-snapshot-a1/evidence.json`. The maintained report is a snapshot
and explicitly unassessed checklist, not qualification authority. Failed
attempts remain beside these receipts. Future GUI first-play observations must
be recorded separately; these operations used the real Core/CLI and game window.
