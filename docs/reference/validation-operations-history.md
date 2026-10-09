# Validation operation history — before October 9, 2026

Dated prior workflow notes. Current validation is owned by
[QUALITY](../QUALITY.md#required-hosted-baseline) and delivery by
[Contribution conventions](../CONTRIBUTION-CONVENTIONS.md#review-and-merge).

## Validation tiers and resumable audits

Use focused `just test-*` commands while editing and `just local-check` before a
coherent push. Bare `just` invokes that same focused selector; exhaustive
investigation remains explicit through `just check` or its narrower aggregate
recipes. The local selector reads the complete branch and working-tree diff;
unknown paths fail until a tested routing rule exists. Tooling-only edits do not
pull in native desktop or packaged Windows qualification. Oxc configuration edits
retain formatting, typed lint, UI build/tests, rejection fixtures, and hosted
workflow contracts.

The local planner executes one warnings-denied Clippy command, rather than an
equivalent Cargo check immediately followed by Clippy, for each selected package
or workspace target set. It coalesces the same Oxlint invocation selected by both
tooling and UI only because both declare the same semantic obligation; command
text alone cannot merge distinct evidence roles. Complete UI tests own their
included theme and copy checks, while related-test plans retain the standalone
checks. The printed reason lists every coalesced selector so reduced process count
does not hide why an obligation ran.

`just check` is exhaustive for Rust, UI, script lint and their tool-fixture
contracts, generic repository tooling, Roadmap, and development-tool contracts,
but deliberately excludes release and packaged qualification. Use
`just release-check` for deterministic release units and
`just windows-qualification-check` for the stateful packaged Windows session.
Required CI executes the complete selected hosted plan on every exact pull-request
head. Focused and prose plans do not imply that the aggregate, release, or
packaged Windows contracts ran; qualification executes its documented hosted
coverage, while packaged acceptance remains a separate obligation when required.

`just audit --plan` explains which named formatting, Rust, UI, script-lint,
repository-tooling, Roadmap, development-tool, dependency-policy, rscheck,
release-unit, and applicable Windows-qualification stages would execute or reuse prior
success. A normal `just audit` reuses only integrity-checked deterministic receipts
whose complete content, tool, platform, and environment fingerprint still matches.
Receipts are stored under ignored `work/validation-receipts`; they are disposable
execution evidence and never release or merge authority. Dependency/advisory and
Windows qualification stages always execute. Use `just audit --fresh` for release
preflight, validation-contract changes, and acceptance that explicitly requires a
single no-reuse run.

Before normal non-fresh execution, the audit automatically looks for compatible
successful merged-main evidence from the existing Deep audit workflow. Discovery
examines the newest twenty completed main runs, downloads at most three artifacts
and spends at most sixty seconds collecting evidence. Every attempt verifies the
repository, run attempt, successful audit job, workflow contract, main ancestry,
artifact digest and bounded ZIP inventory before recomputing original and current
production fingerprints. Matching original audit-stage receipts are published
atomically alongside retained inputs and provider provenance. Existing local
receipts are preserved. Audit receipts never become local-check receipts.

The workflow's explicit `audit-reuse` operation uses this same path. Its default
`audit` operation remains fresh. `--plan`, `--fresh`, transition qualification,
required exact-head CI and stateful Windows/native observations do not import
evidence. Missing, expired, unavailable or incompatible evidence is a named cache
miss followed by normal execution. Different platforms or tool/runtime inputs
normally produce fingerprint misses. Discovery uses the existing signed-in `gh`
credentials locally; the explicit hosted operation uses its existing job token.

### Warm single-session workflow

Start or resume one cohesive outcome in the existing healthy, owned checkout.
A new task context does not require a new worktree, reinstall, Cargo cleanup,
bootstrap or exhaustive validation. Keep installed dependencies and incremental
artifacts. A new isolated checkout is justified by actual concurrent ownership,
an unsafe preserved checkout, or a measured isolation requirement; follow
[Development storage](../DEVELOPMENT-STORAGE.md) only for that case.

1. Read the canonical issue's unmet acceptance, current PR and latest relevant
   live requirements and actual writer/handoff evidence. Resolve `git rev-parse --show-toplevel`, then inspect
   `git status --short --branch --untracked-files=all`, `git rev-parse HEAD` and
   `git worktree list --porcelain`. Reconcile them with the recorded owner,
   branch and evidence; process absence alone is not an ownership transfer.
2. Resume the current branch and failed obligation before selecting another
   task when locally actionable; preserve blockers and select independent work
   when waiting. Before any branch transition, require a clean checkout, known ownership,
   terminal owned build/native operations, and preserved relevant ignored evidence.
   If any condition is unknown or false, refuse the transition. Do not stash,
   reset, delete or overwrite work to make it possible. After a confirmed merge,
   fetch the target, inspect relevant drift and create the next branch in this
   same checkout only when those conditions hold.
3. Keep a compact task contract in the owning issue/PR: **outcome and
   acceptance; checkout, branch and head; reserved files and owning references;
   boundaries/non-goals; narrow edit-test command; coherent pre-push plan;
   resources; completed/failed evidence; exact next action**. Link existing
   evidence instead of copying the initiative or creating a local status ledger.
   Include the consumed requirements revision, actual delta disposition, capable
   execution/validation route and discovery/update handoff. Use the derived
   `roadmap-context` pickup and owning issue/PR evidence path described in
   [Project governance](../PROJECT-GOVERNANCE.md#pickup-consumption-and-execution-upkeep).
   Context does not grant or dispatch work; no coordinator acknowledgment is required.
4. Run the smallest relevant `just test-rust`, `just test-ui-related` or
   `just test-node` loop, then `just local-check` before the coherent push and
   after substantive repair. Integrity-matched deterministic stages may be reused;
   `just local-check --plan` explains selection and `just local-check --fresh`
   disables reuse only when acceptance requires it. Use `just doctor` when prerequisite health is unknown or changed;
   install/bootstrap only the reported missing or mismatched prerequisite.
   [Quality](../QUALITY.md) still governs protected changes and exhaustive acceptance.
5. Review one coherent candidate before expensive final qualification. An exact
   local commit/diff may be reviewed before a PR exists; use a draft PR when a
   transition contract requires one. Follow [Contribution conventions](../CONTRIBUTION-CONVENTIONS.md) for review,
   required exact-head CI, target interaction checks and guarded merge. The
   helper may inspect retained evidence and run discriminating tests; it must not
   bootstrap a second full environment or duplicate a complete suite without an
   identified need. Respect each machine's existing heavyweight-work admission
   and resource window; separate authorized hosts retain their own guards.

One local runner owns implementation and delivery, with one actively edited
candidate at a time. Clean candidates waiting for CI, review or external
prerequisites permit independent work. Preserve existing writers, candidates,
evidence and host resource guards. Actual writer overlap blocks conflicting
work; Dot grants and old coordination paperwork do not gate unrelated delivery.
Independent non-writing review remains required. Do not create a replacement
coordinator, persistent cloud implementers or a new dispatch/reporting service.

The reviewer brief supplies **PR when available and owning issue; source head, target tip and
merge-base; complete changed-file list and relevant surrounding code; acceptance
and boundaries; exact commands/results and retained evidence paths; unrun coverage
and target interactions**. Record the actual task identifier, reviewed revisions,
findings and limitations. The implementer batches coherent repairs and returns the
delta plus affected interactions to the same reviewer where practical. Widen review
only when a repair changes architecture, assumptions, or risk. Implementer
self-review is not independent review. A completed PR is a
checkpoint, not permission to close broader unmet acceptance.

#### Resume and diagnosis decisions

| Observed case             | Next safe action                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New task                  | Verify issue, checkout and ownership; reuse healthy dependencies and run the narrow loop.                                                                                                                               |
| Resumed task              | Read the compact contract, preserve failed evidence, and resume the exact next action before picking new work.                                                                                                          |
| Dirty or unowned checkout | Refuse branch transition; preserve all changes and resolve ownership without stash, reset or overwrite.                                                                                                                 |
| Active editor/compiler    | Inspect the reported PID, creation time, parent chain and command; an editor check is not the guarded test runner. Wait, or stop only your proven-owned operation through its originating editor/terminal if safe.      |
| Duplicate owned server    | Identify each Vite/native server's workspace, parent and listening port; reuse the correct healthy server or stop only a proven-owned duplicate through its originating terminal. Unknown ownership blocks that action. |
| Shared guard queue        | Retain owner and elapsed diagnostics; wait or cancel only your queued command. Never delete a lock or bypass admission with direct Cargo/nextest.                                                                       |
| Repeated bootstrap        | Compare the doctor result and pinned tool/dependency identity; repair the reported mismatch instead of reinstalling healthy dependencies.                                                                               |
| Changed source head       | Freeze the new candidate and obtain applicable current-head checks and independent re-review.                                                                                                                           |
| Target-only advance       | Fetch and inspect target-only changes for relevant interactions; an unchanged source does not automatically require rebase or full rerun.                                                                               |
| Reviewer finding          | Preserve the finding, repair it, and return the changed candidate to that reviewer for applicable re-review.                                                                                                            |
| Unavailable delegation    | Record REVIEW READY with PR/head and the concrete limitation; pause that merge and continue authorized nonconflicting work.                                                                                             |

For a named Windows PID, `Get-CimInstance Win32_Process -Filter "ProcessId = 1234"`
reports `ProcessId`, `ParentProcessId`, `CreationDate`, `ExecutablePath` and
`CommandLine`; replace 1234 with the observed PID and inspect its parent identities.
For a suspected server, `Get-NetTCPConnection -State Listen -OwningProcess 1234`
can identify its ports. These are read-only clues, not ownership proof by name or
PID alone. Missing paths, stale identities or unreadable ancestry mean unknown.
Retain only relevant sanitized diagnostics, not full environment or command dumps.
Never kill unrelated processes or change global editor, antivirus or storage settings
automatically. Existing [Rust admission](#rust-test-runner) and native-session guards
remain authoritative; separate worktrees keep separate mutable Cargo targets.

The single-local-runner pickup contract uses owning issue/PR evidence and live
Project requirements. Historical handoff planners are retired; no coordinator
ACK is needed. Verify actual source-owner release before overlapping work, then
complete remaining validation, repairs, independent review and guarded merge.
See [Project governance](../PROJECT-GOVERNANCE.md#pickup-consumption-and-execution-upkeep).

At a handoff, record current head and dirty state, active owned process/session
identities or confirmed terminal state, evidence locations, unresolved findings or
external boundaries, and the exact resume command/condition. Put it on the current
issue/PR. Report material changes and genuine owner actions. No second ledger, scheduler or daemon is
needed. Choose a cohesive independently verifiable outcome, not setup-heavy trivial
fragments or an unrelated mega-refactor.

### Single-session validation consolidation

The active local planner uses warnings-denied Clippy as the one compile-and-lint
owner for the same package or workspace target set. Commands coalesce only when
their complete invocation and semantic obligation match, and every selection
reason remains visible. Different packages, targets, features, profiles,
environments, generated contracts, isolation, or evidence roles remain distinct.

Compatible Rust impact groups now run through one guarded union. Nextest lists
each selected group under the same locked package, profile and environment and
must report runnable tests for each. A separate union inventory must equal the
set of test identities from those groups before the union executes once. Every
group reason and count is reported. Single-group plans retain their direct run.
Rust impact uncertainty retains broader package/workspace consumers. Inert
unknown inputs use the conservative fallback above; unknown executable or
configuration ownership and incomplete discovery remain blocked.
A protected selector change qualifies under the pre-change
policy, adversarial tests, an eligible fresh transition audit, exhaustive hosted
checks, and separate review. For a clean committed change confined to the existing
local planner, Rust impact map, resource preflight, maintained hosted selector and
CI workflow, and their tests or owning development docs,
and whose actual hosted plan requires exhaustive qualification,
`just audit --profile transition --fresh` runs fresh formatting, script lint,
repository/development contracts, dependency policy and release-unit checks.
It requires complete Git diff/file inventories and the existing exhaustive
hosted plan. Full Rust/UI test and platform coverage remains an exact-head CI
obligation, not a local receipt claim. Mixed, dirty, unknown, added, removed,
renamed or non-regular inputs retain the complete audit. Standalone resource,
impact-map or storage-document changes with fast/prose hosted coverage also
retain the complete local audit; the profile never manufactures exhaustive CI
authority. Audit selection itself, result gates, qualification/release workflows,
recipes and dependency inputs are excluded from this profile and cannot narrow
their own transition. Maintained hosted routing is eligible only while its actual
exact-head plan still requires every qualification group and platform from the
preserved `.github/qualification-coverage.json` and its excluded validator. A
candidate's reduced coverage constants cannot authorize its own shorter gate.
Existing release and deep audit
stage selection remains unchanged. Partial-profile reports use separate filenames and never
replace a complete audit report. Missing or incomplete discovery blocks execution.

Git-clean text may retain CRLF worktree bytes when explicit Git attributes select
LF text. Inventory permits only UTF-8 CRLF-to-LF equivalence with no clean filter
or alternate encoding; binary, unknown attributes and other changed bytes retain
complete fallback. Raw bytes remain in stage fingerprints, so this comparison
does not reuse a different worktree's successful receipt.

Unchanged host-tool fixtures and containment supervisors may reuse only their
compiled product after complete input/toolchain/target/flag/environment identity,
trusted atomic publication, corruption/interruption rejection, provenance and
bounded retention are proven. Every invocation still creates fresh mutable fixture
data, gates, receipts, temporary paths, process supervision, cleanup and test
evidence. Optional compiler cache, storage, editor, or concurrency experiments
still require measured justification. Completed measurements and transition
evidence remain on [#922](https://github.com/boburning/portcove/issues/922); they
are evidence, not ordinary startup instructions.

Linux Rust containment uses a source-bound first-party adopting reaper. It becomes
a subreaper before spawning the gated Node supervisor, stays outside that Node
process group, and reaps direct and adopted children after closing the anchored
group. The wrapper observes the reaper's termination separately from the exact
Node identity registered with the shared lock. Success requires both completed
reaping and actual group absence; zombies do not count as absent. Initialization,
identity, control-channel, signal, wait, and receipt failures cannot supply cleanup
acceptance. A withheld lock release preserves the fresh invocation's evidence
directory, including original failed receipts and space for a missing or late
receipt. The five-second cleanup bound, command/test deadlines, inherited
containment, Windows Job Object and other Unix behavior remain separate and
unchanged. These observations do not reconcile an older held incident or establish
its timing cause. If the entire wrapper is killed, the outer reaper can itself
become PID1's child; a non-reaping PID1 may retain its eventual zombie even after
the managed payload has been positively reaped. Payload closure is not proof that
every host process disappeared.

The exhaustive Rust runner retains two test slots and a thirty-second default
per-test execution budget. Cohesive filesystem, database, diagnostics, cancellation, catalog and
native-process lifecycle families reserve both slots instead of competing with an
unrelated case. Diagnostics are deferred until the initial process-start burst has
cleared, and the real-process CLI contracts run last. These are ordering and
isolation boundaries only: failures are not retried. Evidence-backed calibration
of a narrowly matched heavyweight test's finite harness budget follows the
procedure below; scheduling changes do not authorize budget changes.
