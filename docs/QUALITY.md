# Daily quality contract

## Required hosted baseline

An ordinary change finishes when its owning acceptance is met, applicable review
is complete, the five required exact-head contexts pass, and guarded merge and
remote readback succeed. The contexts remain `catalog`, `dependency-review`,
`frontend`, `rust`, and `rust-quality`; GitHub protections remain enforced.
[Contribution conventions](CONTRIBUTION-CONVENTIONS.md#review-and-merge) owns
the delivery operations. Supplementary runs, diagnostics and personal preferences
do not become merge prerequisites merely because somebody invoked them.

Local commands are optional feedback. Bare `just`, `just local-check`, focused
tests and analyzers may help development; omitted local checks need no explanation.
Native, installed-app, physical-device or human observations are required only by
explicit owning-issue acceptance or a release contract. Fixtures establish their
tested contracts and cannot establish those observations.

Ordinary policy and workflow edits use the ordinary affected baseline, with
independent review for validation or merge authority. The completed October 9
#1682 transition is historical. It does not require another fresh audit,
all-platform qualification or distinct Windows qualification for policy work.

The shared ordinary ownership decision in `scripts/validation-plan.mts` drives
hosted producers and optional local commands. Selection uses the complete Git
diff and both rename sides, including regular executable additions, deletions
and permission changes. An executable bit alone adds no platform qualification.
Unsafe paths, nonregular inputs and incomplete discovery block visibly. Safe
unknown impact selects a broad useful ordinary baseline. Missing historical push
bases use that broad baseline. Audit cache fingerprints retain their separate,
conservative purpose.

| Selected work                    | Required ordinary coverage                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust                             | Windows workspace target compilation and maintained affected test families, broad package/workspace fallback for shared or unknown inputs               |
| Frontend                         | Relevant static checks, content contracts, production build and import-related unit/browser runtime tests; full fallback for shared or uncertain inputs |
| Repository tooling               | Relevant script contracts, syntax/lint and formatting; shared frontend impact also selects frontend execution                                           |
| Informational prose/inert assets | Formatting, links and relevant cheap documentation/asset contracts                                                                                      |
| Dependencies                     | Relevant dependency review and affected consumer checks                                                                                                 |

Machine-consumed documents, executable examples and normative policy retain the
contracts they affect. File extensions and topic words do not prove inertness.
Root/shared Vite and compiler inputs select frontend coverage. Effective nextest
configuration is compared with a TOML parser: a proven comment/format-only change
retains cheap contracts; changed semantics, missing parser, parse failure or
incomplete inputs retain normal workspace validation.

### Review scope

Independent non-writing review is required for substantive behavior and higher
consequence boundaries. Clearly inert prose corrections, mechanical formatting
and isolated presentation changes without material behavior or trust consequence
may use delivering-agent review plus applicable CI. Assess consequences, not line
count, labels or extensions. Normative safety/policy text, consent/confirmation
copy, destructive controls, accessibility behavior, persistence, credentials,
trust, process ownership, native integration and validation/merge authority are
not automatically low risk. This policy refactor itself requires independent review.

State the review performed briefly in the PR description. No certificate, score
or exception form is needed. Blocking findings identify a concrete correctness,
security, data-loss, compatibility or acceptance defect. Cosmetic preference and
speculative unrelated cleanup are nonblocking unless acceptance requires them.
Repair review can examine the delta and affected interactions; harmless amendments
do not require a new reviewer or a repeated complete investigation.

## Canonical commands

Use repository-pinned package scripts or `pnpm exec vp`. Global Vite+ is the
recommended Node/pnpm provider; installed checks use the local toolchain and do
not require a global CLI.
[Development tools](DEVELOPMENT-TOOLS.md#frontend-workflow) describes setup and
focused commands. `just local-check --plan` shows selected work without execution.
Its UI selection can run real browser tests, including import-related browser
projects, and shared input fallback runs the full unit/browser suites and build.
Tooling lint uses integrated repository lint/type checks; CSS and browser-package
checks follow real frontend impact.

`just check-rust`, `just check-ui`, `just check`, `just audit`, Fallow and rscheck
are explicit exhaustive/investigative operations. Fallow is not an ordinary
merge gate. Their full execution recipes live in
[quality operations](reference/quality-operations.md). A command name in that
runbook describes how to execute it, not when it becomes mandatory.

When whole-Desktop Fallow qualification is selected, its validated report blocks
on check findings (including warnings), established boundary violations and
critical complexity. Aggregate duplication percentage is advisory under #1105;
duplicate groups remain review evidence. The repository-tooling, changed-code
review and dedicated CSS routes are advisory and do not expand that gate.
Malformed, incompatible or incomplete analyzer evidence cannot establish a pass.
See [Fallow operations](reference/quality-operations.md#fallow-scopes-and-policy)
for commands, scope and retained reports.

## Setup

Provision tools required by selected commands. Formatting prose does not require
Rust or browsers; script contracts provision a compiler only when they actually
execute compiler controls. Full frontend work needs the pinned frontend packages
and browser runtime. Bootstrap and no-download prerequisite inspection are in
[Development tools](DEVELOPMENT-TOOLS.md).

## Local feedback and hosted authority

Hosted current-source results establish required CI. Local feedback and cached
receipts do not replace it. Multiple local workers/models may proceed with one
owner per coherent candidate and verified overlapping writers. A worktree grants
no shared-resource ownership. Retain heavyweight admission, process identity and
cleanup, finite hang detection, storage guards and resource-status tools.

## Staged audit receipts

Explicit exhaustive qualification runs nightly, manually or for releases through
`force_qualification`. Fresh deep audit is explicit/release work; nightly full
CI does not itself require one. Release qualification remains exact-source and
plan-bound before assembly, signing, attestation or publication.

Existing deterministic receipts can reuse complete unchanged input, recipe,
tool/runtime and environment identities. Trusted main hosted bundles may supply
independently passed stages even when another stage failed. Preserve the entire
failed report and import only verified successful reusable stages. Cancelled,
incomplete, corrupt, foreign or contradictory bundles confer no reuse. Mutable
advisory policy and installed/stateful observations stay fresh. `--fresh` still
executes every applicable stage. See [receipt operations](reference/quality-operations.md#staged-audit-receipts).

Selective GitHub retries can retain independent successful jobs from the same
unchanged source/run when no newer authoritative execution supersedes them.
Missing coverage, newer failure/pending results and wrong identities refuse
success. Attempt-bound artifact chains retain strict producer/consumer lineage.
Rerun the dependent chain when an upstream artifact/input changes. The watcher
keeps a fixed absolute observation deadline and never retries automatically.

## Test latency and reliability

The extra Linux diagnostics replay stays broad for diagnostics, Core, CLI,
Desktop, shared, dependency and uncertain inputs. Only ordinary added or modified
regular Rust files within the independent release-tool crate may omit it;
manifests, build scripts, fixtures, renames, deletions and permission changes keep
the replay. The maintained Cargo consumer-boundary contract must fail if another
workspace package starts depending on release tools. Required Windows Rust
selection and full qualification coverage remain separate obligations.

Cheap source-consumer contracts run before selected compilation/runtime work.
The maintained native compatibility source inventory selects its declaration
contract locally and in hosted ordinary coverage; those source bytes also
invalidate its reusable local result. Pure CLI argument/help tests have higher
nextest priority while retaining the existing CLI resource reservation and all
selected tests. This changes feedback order, not coverage or merge requirements.
Use the existing complete-diff plan to identify these consumers when choosing
focused feedback; a hand-written feature filter may omit them.

Ordinary Windows Rust coverage uses one workspace build and a same-attempt
nextest archive distributed across balanced workers. The current complete and
selected inventories determine coverage; historical duration hints determine
only scheduling. The required Rust result includes the archive producer, every
selected partition and the parallel live transport check. Hosted workers use
four test slots while local runs retain two; exclusive tests reserve the active
profile's entire slot count. See [CI timing diagnostics](DEVELOPMENT-TOOLS.md#ci-timing-diagnostics)
for provenance checks and measurement boundaries. This changes ordinary test
scheduling without replacing qualification coverage.

Windows qualification shares one Core-only test archive across its five existing
Core workers. It retains the default nextest profile, two test slots, zero retries,
the original hash partitions and the recovery worker's four ordered invocations.
The producer compares every original command's selected identities with reused
metadata; each consumer verifies its extracted complete inventory and exact phase
selection before execution. Source, plan, compiler/target, run/attempt and archive
digests bind the transfer. The workspace-other worker retains its independent
build and public CLI/Playnite consumer, and Clippy remains independent. Archive
sharing removes per-worker Core test builds; it does not establish an elapsed-time
improvement or replace full qualification evidence.

Retain failures, diagnose the smallest useful reproduction, and repeat only
invalidated obligations. Preserve assertions, coverage, cleanup and finite
termination; an unchanged later pass does not establish a causal repair.
Separate queueing, cold builds, warm execution, parallel work and postmerge cost.
The warm focused five-minute target is a measurement goal, never an acceptance
gate or permission to omit checks. Fixtures prove decisions, not minutes saved.

## Autonomous test-timeout calibration

Agents may diagnose, increase and persist proportionate finite test-harness,
fixture, command, supervisor and CI execution budgets without another approval.
Retain original failures, assertions, cleanup, zero automatic test retries,
heavyweight reservations and finite hang detection. Coordinate nested budgets
so inner failure and cleanup finish before the outer limit. Record the old/new
limits, rationale and result. More execution time alone is not a permission question.
This authority does not change application cancellation, shutdown, locking,
network, security or other behavioral deadlines, acceptance or release authority.
A pass under a larger budget proves completion under that budget.

The October 2026 test audit calibrated the three maintained Node suites that
contain fixed Linux Python child wrappers from a 30-second default to
60 seconds. Their child limits remain 30 seconds. The dynamic ordinary and
bootstrap contract runners also allow 60 seconds so those same wrappers can
report and clean up. Other registered suite defaults, explicit per-test limits
and product deadlines remain in force. The controlled timeout contract retains
the child's readiness stderr and verifies process exit before the outer runner
completes. Other nested subprocess families require their own calibration.
The Python reporter also exercises its actual timed-out Python child with
5/10/15/20-second child, Node case, command supervisor and enclosing-case budgets.
The control requires readiness stderr, an incomplete-report failure and direct
child exit in both the inner runner and its parent; it cannot establish cleanup
of arbitrary descendant trees or survival after a whole-job kill. Zero,
non-finite and fractional Python harness deadlines are refused before launch.

The manual `Job timeout rehearsal` uses a controlled Linux job with a five-minute
outer limit and the maintained process supervisor. Its producer deliberately
times out; a separate always-run verifier checks the original timeout, retained
partial output and exact owned-process exit observations. Acceptance of that
control remains distinct from a passing workflow, full suite or product run.
The payload replaces its shell with `exec` so runner cancellation reaches the
supervised controller. GitHub may report the deadline as `cancelled`; the verifier
requires its exact timeout annotation as well as the owned-process drain receipt.
Main CI bounds metadata/aggregate jobs at 15 minutes, ordinary producers at
45 minutes, and exhaustive producers at 120 minutes; the existing 10-minute
Windows helpers and 15-minute portability limits remain. These generous outer
envelopes include cold setup and evidence upload above the audit's sampled
ordinary jobs and failed qualification producers. They are hang
limits, not latency targets or evidence that cleanup can survive a whole-job kill.

## Dependency policy

Keep scanner scope, findings and original exit status truthful. Development
policy and Linux release risk authorization remain separate under
[dependency security](releases/2026-10-14-linux-beta-risk-706.md). A raw failed scan is
never passing security evidence or publication permission. Preserve no additional
spending: resource limits produce a limitation, not paid services or new hardware.

### Bounded dependency delivery

The verified Renovate exception remains in
[the dependency delivery operation](reference/quality-operations.md#bounded-dependency-delivery).
It does not grant blanket automerge or relax exact-head checks, review eligibility,
release-age safeguards or current-target interaction assessment.

## Routine merge freshness

Review the actual source and relevant target interactions. An unrelated target
advance does not automatically require a rebase or full repeat. Changed composition
or uncertain provenance requires normal validation. CSS and inert raster/font asset postmerge reuse requires a trusted merged PR, complete
tested-tree equality and existing workflow provenance. Executable frontend source/tests, dependency, native, release,
workflow and uncertain inputs retain fresh work in this bounded implementation.
Proven equivalent postmerge work must report original evidence separately from freshly executed obligations;
release/stateful requirements stay fresh. Guard the merge by exact source SHA.

## Formatting contract

Use `just fmt` or `just fmt-check`; ownership and exclusions live in
[formatting operations](reference/quality-operations.md#formatting-contract).

## Tool and Rust version authority

Repository pins own versions; see [Development tools](DEVELOPMENT-TOOLS.md).

## Architecture gate

Preserve Cargo-metadata ownership and dependency boundaries; see
[Architecture](ARCHITECTURE.md).

## Initial structural baseline

Dated measurements live in [validation history](reference/validation-history.md).

## Ratcheting

Review new warnings and complexity changes in touched code; avoid speculative cleanup.

## Upstream health checks

Live upstream monitoring stays separate from ordinary deterministic contracts;
see [upstream observations](UPSTREAM-OBSERVATIONS.md).

## Consumed Intel test transfers

Retain compiler/target/manifest and binary identities for transferred test execution;
see [transfer operations](reference/quality-operations.md#consumed-intel-test-transfers).

## Structured documentation test results

Qualification and `just rust-test` retain `work/test-results/rustdoc-*` packets:
source and checkout context, the original Cargo arguments, compiler identity,
bounded raw streams and per-case outcomes. Document-path-qualified identities
remain distinct across merged and standalone doctest harnesses. Native case
durations and rustdoc compilation/total phases have different scopes. An explicit
native zero-test suite means zero executions; successful compilation or empty
output alone cannot establish that result. Unknown ignore reasons remain null.
Completed observed suites do not prove that a failing or signalled Cargo invocation
reached every crate. Those packets retain observed cases/counts while whole-recipe
discovery and selection remain unknown.

The reporter uses the repository-pinned compiler's experimental libtest JSON
interface. Its Cargo child receives `RUSTC_BOOTSTRAP=-1`, which
[forces stable compiler behavior](https://doc.rust-lang.org/unstable-book/compiler-environment-variables/RUSTC_BOOTSTRAP.html)
while the pinned [libtest runtime](https://doc.rust-lang.org/src/test/cli.rs.html)
currently admits the reporting flags. This environment also reaches build scripts
and doctest compilation; it is not limited to formatting. Other inherited
bootstrap values are refused. Native acceptance provenance guards remain unchanged.
Protocol changes, missing or duplicate outcomes, invalid UTF-8 and output beyond
32MiB per stream leave reporting incomplete. Raw streams are written during
execution; an original nonzero native status remains primary if reporting fails.
The CI jobs retain their finite outer budgets. Local callers retain Rust admission
through `just rust-test` or `scripts/run-rust-tests.mts --guard-command`.

This adapter supports doctests only. Ordinary Cargo test binaries can reuse the
same case name without carrying a binary identity in this JSON dialect; their
formatted console output is not used to invent an identity.

### Declared platform skips

The existing Node ownership record may declare `platform_skips`: intended platform,
prerequisite, reason, complete qualification owner and stable top-level case names.
The declaration remains distinct from the runner's original skip reason. Its
qualification owner must be an actual, enabled, unfiltered producer on the stated
platform; missing, unsupported or wrong-platform runner labels cannot qualify it.

For unfiltered invocations, the required reporter refuses missing or ambiguous
cases, unregistered skips/todos in declared families, and outcomes inconsistent
with the intended platform. A registered case cannot become TODO on its owner.
Filtered runs explicitly report that full-family evaluation was not performed;
they cannot replace the complete qualification owner. Metadata read failures are
reported after consuming original runner failures. This opt-in platform contract
does not classify undeclared families, other skip categories or native acceptance.
