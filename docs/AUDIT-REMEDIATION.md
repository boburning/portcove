# Independent audit remediation ledger

This ledger tracks the remediation of `PCV-AUD-001` through `PCV-AUD-039` from the corrected independent audit pinned to `02654c757c24a8eabc0c518a1aea305264944070`. The remediation branch began at that exact clean commit. A row marked **In progress** is not a final disposition; it records the next dependency-safe phase while implementation continues. Final dispositions are limited to Resolved, Already resolved, Superseded, Deferred with an external blocker, or Rejected with evidence.

## Baseline

- Branch: `codex/portcove-audit-remediation`
- Audited/current starting commit: `02654c757c24a8eabc0c518a1aea305264944070`
- `just check`: passed before edits (137 Rust tests, 64 frontend tests, architecture, Fallow, theme, release tooling).
- `just audit`: passed before edits with zero blocking findings. The documented cargo-modules inherent-item cycle, GTK3/`proc-macro-error`/`unic-*` advisories, and rscheck shape findings remained advisory.
- Optional baseline: `just mutants` not run before implementation; `just deep` was not repeated because the audit and `docs/QUALITY.md` already record the exact hosted baseline and the current Windows semdup linker blocker.

## Findings

| ID | Current disposition | Verified evidence / implementation | Files or modules | Proof | Dependencies / external follow-up | Commit |
|---|---|---|---|---|---|---|
| PCV-AUD-001 | Resolved | Direct `Command::new` callers inherited the parent environment. Added one core-owned typed policy with a reviewed session allowlist and centralized removal of GitHub and credential-shaped variables; all production child sites now route through it. | `process.rs`, CLI, Tauri, `adapter.rs`, `psx.rs`, architecture/security/CLI docs | Helper-process environment test, five-class credential-boundary test, policy bypass gate, `just check-rust`, `just check`, and `just audit` pass. | Foundational boundary is complete; 003 and 019 build on it. | Phase 0A commit |
| PCV-AUD-002 | In progress — Phase 0B queued | Install/adopt/remove publication and durable journal boundaries require source revalidation after the Phase 0A gate. | `install.rs`, `service.rs`, `library.rs` | Pending fault-injection/restart suite. | After 007 and 019. | pending |
| PCV-AUD-003 | In progress — Phase 0D queued | Desktop launch remains owned by an in-process wait thread at the starting commit. | Tauri, CLI, core launch/session modules | Pending supervisor/crash/signal tests. | After 001, 002, 019. | pending |
| PCV-AUD-004 | In progress — Phase 0D queued | Reconcile state/lock ordering requires focused revalidation. | `service.rs` | Pending blocking-provider race tests. | Before concurrent mutations. | pending |
| PCV-AUD-005 | In progress — Phase 0C queued | Release/toolchain archive policies require unified quota/collision revalidation. | `install.rs`, `psx.rs`, archive policy module | Pending hostile ZIP/TAR corpus. | After 002. | pending |
| PCV-AUD-006 | In progress — Phase 0C queued | Persisted verification and transition/launch checks require byte-bound identity work. | `install.rs`, `service.rs`, `adapter.rs`, `psx.rs` | Pending tamper suite. | With 011 and 002. | pending |
| PCV-AUD-007 | In progress — Phase 0B queued | Migration ordering/serialization requires source revalidation and historical-schema fixtures. | `library.rs`, migration module | Pending concurrent/fault migration tests. | Foundation for 002 and 017. | pending |
| PCV-AUD-008 | In progress — Phase 1 queued | Status/doctor hidden-write behavior requires read-only snapshot tests. | `library.rs`, `service.rs`, CLI | Pending read-only filesystem/SQLite proof. | With 022. | pending |
| PCV-AUD-009 | In progress — Phase 1 queued | Policy initialization requires catalog-default verification. | `library.rs`, `service.rs` | Pending beta/rolling-only tests. | With 008. | pending |
| PCV-AUD-010 | In progress — Phase 1 queued | Capability adapter completeness requires enum/catalog contract proof. | `types.rs`, CLI contract tests | Pending focused contract test. | Before 012. | pending |
| PCV-AUD-011 | In progress — Phase 0C queued | Stable/beta install identity requires immutable artifact digest persistence. | `release.rs`, `types.rs`, `service.rs`, migrations | Pending republished-tag tests. | Before 006/032. | pending |
| PCV-AUD-012 | In progress — Phase 1 queued | Rust/TypeScript transport ownership requires generated or checked bindings. | schemas, desktop types/build | Pending drift fixture and frontend compile. | After 010 and operation DTO changes. | pending |
| PCV-AUD-013 | In progress — Phase 1 queued | Source verify/use boundary requires snapshot or final identity check. | `service.rs`, `adapter.rs` | Pending deterministic source-swap tests. | Reuses 002/process foundations. | pending |
| PCV-AUD-014 | In progress — Phase 1 queued | Lossy persisted paths require explicit V1 rejection policy. | path-bearing core/library APIs and docs | Pending Unix non-UTF-8 tests. | Before import/export. | pending |
| PCV-AUD-015 | In progress — Phase 2 queued | Adoption preview/copy plan and skipped-entry reporting require two-step workflow. | core service/types, Tauri, React | Pending plan-token and component flow tests. | After 002 and 016. | pending |
| PCV-AUD-016 | In progress — Phase 2 queued | Destructive commands still rely on renderer confirmation at the starting commit. | Tauri authorization, React confirmation | Pending expiry/replay/state-change tests. | Shared with 015/028. | pending |
| PCV-AUD-017 | In progress — Phase 1 queued | Desktop bootstrap still uses recoverable `expect` paths at the starting commit. | Tauri bootstrap, recovery UI | Pending invalid-library fixtures. | After 007/002 diagnostics. | pending |
| PCV-AUD-018 | In progress — Phase 2 queued | Refresh generations and per-operation state require operation identity first. | React hooks/types | Pending reverse-completion/overlap tests. | After 019. | pending |
| PCV-AUD-019 | In progress — Phase 0B queued | Events lack stable ID/sequence/parent/result at the starting commit. | core operation model, Tauri, React | Pending ordering/correlation tests. | Foundation for 003/018/039. | pending |
| PCV-AUD-020 | In progress — Phase 2 queued | Modal gamepad scope and one Back stack require interaction revalidation. | gamepad/dialog/overlay hooks | Pending modal focus/back tests. | Coordinate with 018. | pending |
| PCV-AUD-021 | In progress — Phase 2 queued | No top-level render boundary at the starting commit. | React entry/shell | Pending injected-render-failure tests. | Integrate with diagnostics. | pending |
| PCV-AUD-022 | In progress — Phase 3 queued | Status/bootstrap query counts require bulk read-model instrumentation. | `library.rs`, `service.rs`, Tauri | Pending 250/500/1,000-record measurements. | With 008/012. | pending |
| PCV-AUD-023 | In progress — Phase 3 queued | CLI/Tauri bulk checks require bounded provider concurrency. | core/CLI/Tauri check paths | Pending bound/order/rate-limit tests. | After blocking/operation boundaries. | pending |
| PCV-AUD-024 | In progress — Phase 3 queued | Blocking filesystem/hash/process phases require explicit worker boundaries. | core service/install, Tauri | Pending responsiveness/cancellation-boundary tests. | After 002/019. | pending |
| PCV-AUD-025 | In progress — Phase 4 queued | Host audit found unprotected `main`; repository artifact and admin command required. | ruleset JSON/script/docs | Pending exact settings artifact/API validation. | Admin application may be external. | pending |
| PCV-AUD-026 | In progress — Phase 4 queued | Matrix jobs currently mutate one draft without aggregate reconciliation. | release workflow/scripts/tests | Pending missing/duplicate/hash/rerun tests. | With 025/038. | pending |
| PCV-AUD-027 | In progress — Phase 4 queued | Normal Rust toolchain floats while MSRV is 1.88. | toolchain, CI, metadata docs/tests | Pending pinned and MSRV checks. | Dependency MSRV review. | pending |
| PCV-AUD-028 | In progress — Phase 1 queued | Source removal lacks installed-dependent preview/authorization. | core service/library, CLI/Tauri | Pending shared-source impact tests. | With 016/022. | pending |
| PCV-AUD-029 | In progress — Phase 1 queued | Provider beta-to-stable fallback requires explicit shared semantics. | release providers, catalog/CLI docs | Pending provider parity tests. | Coordinate with 011. | pending |
| PCV-AUD-030 | In progress — final sweep queued | Human output is transport JSON; safe read-command renderers will be assessed after contract changes. | CLI rendering/docs | Pending snapshots; machine contract must remain stable. | Optional polish after higher-priority contracts. | pending |
| PCV-AUD-031 | In progress — Phase 1 queued | Device login uses blocking sleep and weak cancellation feedback. | CLI auth loop | Pending pending/slowdown/expiry/cancel tests. | No blocking dependency. | pending |
| PCV-AUD-032 | In progress — Phase 0C queued | Sanitized display versions collide; immutable storage identity will own directory keys. | install/release identity | Pending property tests. | Resolved through 011 design. | pending |
| PCV-AUD-033 | In progress — final sweep queued | Backup publication wording must distinguish process atomicity from power-loss durability. | architecture/CLI/service | Pending documentation reconciliation and supported directory-sync proof. | No blocker. | pending |
| PCV-AUD-034 | In progress — Phase 2 queued | Command-palette accessible name requires exact DOM test. | `CommandPalette.tsx` | Pending role/name test. | With 020/021 accessibility pass. | pending |
| PCV-AUD-035 | In progress — Phase 4 queued | Security policy lacks a concrete private GitHub reporting route. | `SECURITY.md`, repository setting docs | Pending checked-in guidance; enabling setting may need admin. | External host-setting validation possible. | pending |
| PCV-AUD-036 | In progress — Phase 4 queued | Quality pins are duplicated across scripts/workflows/prose. | machine pin manifest/bootstrap/workflows/docs | Pending stale-consumer tests. | Tooling pass after correctness work. | pending |
| PCV-AUD-037 | Resolved | `.bat`/`.cmd` is now an explicit launch kind. Caller arguments are rejected; fixed catalog arguments reject shell metacharacters; non-game process classes require native executables. | `process.rs`, adapter/CLI/Tauri, CLI/security/architecture docs | Hostile argument matrix and real Windows batch execution tests pass; policy bypass gate, `just check-rust`, `just check`, and `just audit` pass. | Shares the completed 001 policy. | Phase 0A commit |
| PCV-AUD-038 | In progress — Phase 4 queued | Release workflow write permission must move to one final publisher. | release workflow/tests | Pending effective-permission/rehearsal tests. | With 026. | pending |
| PCV-AUD-039 | In progress — Phase 2 queued | Desktop lacks durable redacted tracing at the starting commit. | Tauri logging, support bundle | Pending rotation/redaction/restart tests. | With 019 IDs. | pending |

## Phase evidence log

### Phase 0A — child-process and credential boundary

- Baseline search found direct production process creation in CLI game launch, Tauri game launch and folder integration, upstream setup, managed PS1 building, `chdman`, and DolphinTool.
- `ChildProcessPolicy` now owns environment construction for all of them. `LaunchKind` makes native and Windows batch launches explicit.
- `scripts/check-child-process-policy.mjs` is part of `just check-rust` and rejects future direct production `Command::new` bypasses.
- Proof: `cargo test -p portcove-core process::tests -- --nocapture`, `cargo check --workspace --all-targets`, `just check-rust`, `just check`, and `just audit` passed. The final audit ran 143 Rust tests and 64 frontend tests, reported zero blocking cargo-deny or rscheck findings, and retained only the documented cargo-modules advisory cycle and dependency/shape advisories.
