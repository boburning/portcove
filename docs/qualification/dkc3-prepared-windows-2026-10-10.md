# DKC3 prepared Windows route — October 10, 2026

This records actual Windows x86-64 execution of the already admitted non-owning
v0.0.6 route for [#723](https://github.com/boburning/portcove/issues/723).
Separate review accepted its current integration minimum: exact package/source
registration, positional launch, responsive owned window, ordinary close and
file-preserving registration removal. Guest correctness is not qualified: a real
upstream execution gap remains recorded below. This is not Supported status,
gameplay, visual, controller, audio, save/load or macOS evidence.

## Exact identities

| Input                                              | Identity                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Executed Core/CLI source                           | `33f553d0d069e9cb9fa13f43bf7a4e30ad4b05bf`                                                  |
| CLI SHA-256                                        | `228de07c5b97e56a18bc23288b50762dd14120df63669d688ff5e570cb268471`                          |
| Upstream source                                    | `3a033f19801a2bd3abf784d4b29c4462495d19de`, tag `v0.0.6`                                    |
| Fresh official release / Windows asset             | `387790480` / `560544858`                                                                   |
| Windows archive                                    | `DKC3Recomp-v0.0.6-windows-x64.zip`, 6,009,000 bytes                                        |
| Publisher archive SHA-256, freshly matched locally | `b4965c2cb6d13ce972bc72796e15840d1c1c50e9cb28c748ff213ae145f75e11`                          |
| EXE SHA-256                                        | `259c2acbac636f298c502b2ef562fd427332c7d0c657c0c5bfb20eac6c54fe48`                          |
| Core accepted immutable tree SHA-256               | `3b8e1a483ada9a544a084717eba4eeb5c8f4b7168cda85b3697776f1a0dacdee`                          |
| Original authorized NAS ZIP SHA-256                | `dd55fee77073ac6fe44bac4c7614d7931f179d9b27bed9f40df10c22065a8955`                          |
| Exact headerless North American En/Fr `.sfc`       | 4,194,304 bytes, SHA-256 `2277a2d8dddb01fe5cb0ae9a0fa225d42b3a11adccaeafa18e3c339b3794a32b` |
| Native harness SHA-256                             | `2bada126dba557b4eaeeb5bb9a8c9045260302e75d7ba1f1db4b8fec7ae7f6c0`                          |

The original NAS ZIP remained untouched. Bounded preparation made a private
external test copy and extracted the authenticated package into a fresh short
ASCII coordinate. Raw ZIP bytes and the central index were bounded before the
semantic parser, then members, decoded bytes, paths, links and fresh writes were
checked. All 21 package file sizes/hashes matched the retained audit. No ROM,
runtime or asset redistribution is offered. Existing notices and noncommercial
conditions remain intact; the
[October 5 source/write/rights audit](../archive/2026-10-05-dkc3-prepared-runtime.md)
retains its font-notice and platform limits.

## Observed Portcove operations

The [single admitted packet](https://github.com/boburning/portcove/issues/723#issuecomment-6103483623)
used a new isolated library, private host preferences/runtime lock/temporary
paths, canonical shared native lease, no autoreclaim and no player library.
Fresh boot was `2026-10-10T22:50:10.500Z`; competing runtime/build writers and the
lease were absent immediately before dispatch. The total cap remained 180 seconds,
with 45-second game, 30-second responsive-window and 15-second helper caps and
bounded/drained 256 KiB per-stream receipts. No cap or process-proof rule changed.

All 16 phases completed in 14.191 seconds without timeout or truncation:

- Core preview matched the exact accepted archive/tree; source registration
  matched the original headerless member, and consent-bound prepared registration
  succeeded without acquiring ownership of the package or source.
- Core launch revalidated and passed that external original positionally, with
  the declared launcher-suppression switch. Actual game PID 3812 descended from
  CLI PID 17260. Its responsive owned window was `DKC3Recomp (FPS: 31)`; retained
  host output identified SDL2/OpenGL initialization and package-local config/save
  anchoring. There is no screenshot or visual-correctness claim.
- Maintained helpers captured the identity-bound process, requested ordinary
  close and positively waited. Host output reported clean exit and the CLI
  exited 0. This proves the captured process scope, not exhaustive historical
  descendant lifetime coverage.
- Only after positive completion did the packet add its private save sentinel.
  Registration removal preserved all 26 inventoried external files byte for byte,
  including generated files and the sentinel. The original ZIP, source copy,
  executable and CLI hashes remained unchanged. The native lease was released.

Full local receipts remain under
`E:\Portcove-Development\outputs\723-prepared-native-20261010`; the
[canonical observation](https://github.com/boburning/portcove/issues/723#issuecomment-6103491661)
records those exact scopes. Prior inert source/package/containment/removal
controls from delivered PR #1529 retain their separate compiled-fixture scope.
Later target advances are reviewed composition, not a newly executed binary.

## Known guest execution gap and remaining limits

The actual stderr reported an interpreter step cap and an unresolved-abandon
at `$808CAD`, frame 58, with skipped handler side effects. Independent pinned
source review confirmed that the bridge returns unresolved after its finite cap,
then balances the stack while omitting those effects. Upstream's pinned bring-up
record documents the same boot warning. It does not establish failure of the
observed Portcove registration/launch/close/removal operations, but guest semantics
and gameplay must not be claimed correct. The diagnostic's dispatch-authorization
wording grants no authority; no dispatch rule, cap or environment override changed.

Resume that limitation only with a separately reviewed upstream correction and
bounded evidence for the exact replacement artifact/source. Do not raise caps or
replay the unchanged packet automatically. No controller was detected; reported
audio initialization is not audible/audio-quality evidence. Save/load and visual
correctness remain unqualified.

Maintenance remains user-managed: external package, original ROM, settings,
saves and unknown files remain player-owned. Managed acquisition, update,
replacement, backup, rollback, relocation and external deletion are unavailable.
The older macOS build receives no Windows claim. The full frozen
317-record/316-identity cohort and Linux GLib security hold remain unchanged.
