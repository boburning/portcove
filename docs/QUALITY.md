# Daily quality contract

## Required hosted baseline

Meet the acceptance criteria in the issue. Complete the applicable review.
Make sure that all five required checks pass on the exact pull request commit.
GitHub requires `catalog`, `dependency-review`, `frontend`, `rust`, and
`rust-quality`. Follow the guarded merge procedure and read back the result
from GitHub. See [Contribution conventions](CONTRIBUTION-CONVENTIONS.md#review-and-merge).
Supplementary tests and diagnostics remain optional unless an existing rule
requires them.

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

For a pull-request test merge, the planner binds the checked-out commit to the
workflow and its second parent to the exact PR source. The first parent must
share the event base's ancestry. The planner records that tested target and
compares its tree with the tested checkout, including changes made by the
composition. A source-only checkout keeps the complete merge-base comparison.
Unbound parents, unrelated targets and ambiguous merge bases block discovery.

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

For a single catalog title, the Rust impact selector can focus a guide reference
wording edit when the authored record and all three generated projections contain
the same instruction changes. The comparison uses both Git revisions and the
Rust producer verifies the generated plan against the actual checkout bytes.
Catalog generation, catalog invariants, prepared guide lifecycle and CLI
presentation checks still apply. Changes to route facts, guide structure,
enrollment or other inputs use ordinary affected-input selection.

The Rust impact selector can focus upstream-only discovery platform additions
when each authored listing and the generated directory agree on the added
platforms and asset hints, and the operational catalog is byte-identical.
The producer checks the actual checkout against the proof. Core directory
and package tests and both executable adapter suites still run, along with
catalog validation and workspace compilation. Mixed, unproven and
qualification changes retain ordinary coverage.

Ordinary catalog changes are meant to be data-only. On pull requests, the CI plan
job runs `scripts/catalog-rust-edit-report.mts` over the plan's complete changed-file
list and, when port data under `crates/portcove-core/catalog/ports/` or `catalog.json`
changes together with Rust sources under `crates/`, emits an advisory notice and step
summary naming the production and test files. Test files are recognized by path, so an
inline test module in a production file counts as production. The report is a
heuristic: it never fails the job, selects no validation and is not a merge
prerequisite. A new route shape or contract legitimately needs Rust; otherwise the
named files show a test or code path that still keys on a specific port.

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
security, data-loss, compatibility or acceptance defect. Cosmetic preference,
speculative generalization and unrelated cleanup are nonblocking unless acceptance requires them.
Repair review can examine the delta and affected interactions; harmless amendments
do not require a new reviewer or a repeated complete investigation.

### Review and repair loop

Where independent review is required, the implementation owner runs one loop:
implementation, independent review, evidence-based repair, then reassessment.
It adds no approval stage and does not replace required CI, explicit acceptance,
guarded merge, readback or targeted reconciliation.

**Reviewer.** Use a fresh reviewer that did not help design or implement the
candidate and does not write to it. Choose its capability by consequence. An
independent reviewer covers substantive behavior. A critical reviewer is used
from the start only for signing keys or authority, update/catalog trust, credentials,
irreversible user-data loss, and changes to required checks or merge authority.
It is not used for every PR that merely touches such a subsystem.
[Agent model selection](DEVELOPMENT-TOOLS.md#agent-model-selection) lists the
default models and efforts and distinguishes an instructed non-writing reviewer
from a technically restricted one. A delegated reviewer returns its findings and
ends; it does not wait for CI or repairs. The owner confirms the reviewed head
and worktree are unchanged afterward.

**Packet.** Give the reviewer the owning issue and acceptance criteria, the exact
candidate head (and target when composed), the change context and known
consequential decisions, the verification actually executed with its results,
and known limitations or skipped checks. The reviewer may inspect further source,
tests and contracts when the packet is insufficient, reports findings in the
classes below, and says what it did not examine.

**Findings.** Each finding is one of:

- _Confirmed defect_: a concrete failure mechanism or acceptance gap with
  supporting evidence such as a cited path, a focused reproduction or a probe.
  These block under the [review scope](#review-scope) criteria.
- _Refuted claim_: a suspected problem the evidence shows does not occur.
- _Unresolved question_: something the reviewer could not settle. It names the
  evidence that would settle it. It does not block as a defect, but the owner
  obtains that evidence or treats the affected acceptance as not yet met.
- _Advisory suggestion_: nonblocking improvement.

Missing evidence is not a pass: an absent result, a skipped check, a timeout or an
empty review leaves the affected claim unknown.

**Repair and reassessment.** The owner repairs confirmed defects, or records
evidence that refutes them, and returns the delta and affected interactions to
the same reviewer where practical. A new substantive finding still blocks.

**Escalation.** When repeated attempts at the same failure make no progress,
change approach: narrow it with a discriminating reproduction, investigate the
underlying contract, or delegate a bounded specialist assignment. An attempt
limit prompts that change; it never converts an unresolved blocker into approval.
Record the blocker and resume condition under
[blocked-work preservation](PROJECT-GOVERNANCE.md#pickup-consumption-and-execution-upkeep)
when it cannot be resolved in the session.

Use the existing issue and PR description for evidence: the PR states the
reviewer responsibility, the model and effort requested (and the served model
where the client reports it), the reviewed head and the result. No separate receipt or report is required for ordinary work.

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

`just check-rust`, `just check-ui`, `just check`, `just audit` and Fallow
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

Release reusable qualification accepts the closed repository-owned
`initial-beta-windows-x86_64-v1` profile only from an explicitly forced release
caller. Its source, digest and exact profile must match the consuming release.
It requires every shared protected group, the Windows Core/workspace, Clippy and
storage producers, and Windows Rustdoc. Non-Windows native and Intel producers
must be skipped; missing, failed or refused Windows/shared evidence cannot pass.
The historical `initial-beta-win-linux` profile retains its Linux obligations;
`full` remains the default four-platform nightly and manual qualification.
Audit 01's genuine repaired-source scheduled acceptance remains unchanged.

Ordinary validation continues to select work by affected inputs, independently
of the application release profile. Shared correctness and tooling checks may
execute on Linux, macOS or WSL for Windows delivery. A Windows application
profile does not disable those checks or change the five required contexts.

`node scripts/roadmap.mts readiness --release "Public beta" --release-profile
initial-beta-windows-x86_64-v1` explicitly selects the corresponding planning
assessment. It omits only the canonical Linux #49/#706 special automatic
promotion, reports their retained planned scope, and preserves every explicit
Required root and genuine blocking dependency. It refuses `--linux-beta-706`;
Windows scope cannot consume a Linux risk disposition. Default/full readiness
and `doctor` keep the broader assessment. Selection alone establishes no native,
package, publication or live readiness acceptance.

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
The ordinary Windows Rust test jobs can reuse the artifact ID and attempt
recorded by their successful build producer when rerunning a test job alone;
the producer retains that archive for five days.
If the artifact has expired or its provenance is unavailable, rerun the
Windows build job and its dependent jobs. Qualification archives retain their
same-attempt requirement and also need the producer and dependent jobs rerun.
Rerun the dependent chain when an upstream artifact/input changes. The watcher
keeps a fixed absolute observation deadline and never retries automatically.

## Test latency and reliability

Native Desktop scenario records retain monotonic `duration_ms` for the scenario
action (`duration_scope: scenario-action`). This excludes the observer's
post-action diagnostics and terminal screenshot; captures inside the action
remain included.
An unmet prerequisite records `not-run` with a null duration. These observations
retain the existing execution and acceptance boundaries.
Failed actions, setup and cleanup observations emit a bounded `DESKTOP_FAILURE` record before
diagnostics or final artifact publication, retaining the original failure when
later publication fails. Untimed harness failures have a null duration and
`harness` scope. Its declared harness revision does not replace the
final packet's captured executable and input identities.

Runner inventories describe different units. Keep their native identities and
unknown states when comparing results; source files, routes and lines are static
inventory metrics, never executed test totals.

| Maintained runner             | Case and count interpretation                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                          | Expanded native test events and file observations; parameterized/subtest outcomes remain distinct from test-bearing files and declared command routes.                                                                                                                                       |
| Vite+/Vitest unit and browser | Native case results retain full test names, status and timing; browser replay remains separate from native application execution.                                                                                                                                                            |
| Nextest                       | Native discovery/selection lists and terminal case events distinguish executed, ignored and failed cases; explicit diagnostic overrides remain nonqualifying.                                                                                                                                |
| Rustdoc                       | Document-qualified native cases and observed suites; incomplete Cargo recipes leave whole-recipe discovery/selection unknown. Compilation phases are separate from case durations.                                                                                                           |
| Standalone libtest            | One unfiltered binary-bound suite; discovered/selected, executed, ignored and failed counts come from native protocol events. Empty selection cannot qualify.                                                                                                                                |
| Python unittest               | Expanded selected test IDs and inner outcomes, including skip/error reasons; the timed child and original aggregate status remain separate from reporting success.                                                                                                                           |
| C# contract runner            | Ordered discovered/selected scenarios for the active mode, executed actions, skips, native failures and reported records. Assertion `checks` are separate; complete case records can still describe failure or skip-only execution.                                                          |
| Native Desktop                | Registry discovery and selected/setup/excluded/known-gap IDs remain distinct from observations. `checks` can contain diagnostics as well as scenarios; its length is not a test count. Missing actions remain unobserved or `not-run`, with unknown duration rather than invented execution. |

These inventories do not confer native, package, installed-client or release
acceptance. The owning receipt and acceptance contracts still decide that scope.

Rust qualification records ignored-case routes from `ignored_routes` in the
existing `.config/rust-test-impact.json`. Each declaration retains its original
reason, source, intended platforms and supervised parent cases or explicit
acceptance route. The complete current-platform listing detects unregistered
ignored cases, missing or ambiguous cases and parents, and platform drift.
The workspace-other recipe excludes Core explicitly; absent feature-gated
qualification fixtures remain `not_evaluated_feature`, not executed evidence.
The packet retains and hashes `skip-routes.json`. Observed route inconsistencies are reported after native execution without
replacing a nonzero native exit. Invalid declarations or pre-execution IO can
leave the command unexecuted, with no inferred native outcome.
These declarations never execute ignored cases or grant their prerequisites.

Frontend case observations also declare the Windows-only lifecycle timeout unit
case's platform prerequisite and maintained Windows frontend-unit route. Its skip
is expected only off Windows; a skip on Windows remains unexpected, and a missing
case remains a missing route. These case declarations do not widen whole-file UI
skip permissions or execute the route. A non-Windows skip is not a Windows process
observation or native application acceptance.

Windows archive consumers retain the same compiled skip-route observations under
`work/test-results/windows-rust-skip-routes/`, including the complete native listing,
its hash, the source/run binding, report and report hash. Both ordinary and Core
worker artifacts retain that directory after failure. Route errors are reported
after native execution; an original native failure remains primary.

The stdlib Python reporter classifies the existing owned-suite platform guards and
names their maintained Node parents. Owned unknown skips, missing declarations and
contradictory observations make reporting incomplete while preserving unittest's
original status, reasons and errors. The reader reconciles route counts and reasons
against original cases. Copied and controlled reporting fixtures remain framework
evidence. The C# runner similarly names the compiled CLI scenario's explicit
`check.ps1 -Cli -Library` parent; an undeclared skip refuses reporting without
rewriting the original skipped outcome or preventing later independent scenarios.

The browser trace probe is an explicit diagnostic that deliberately fails when
enabled. Its exact case, prerequisite and intended artifact-custody producer are
recorded separately from original Vitest outcomes. Focused UI selection refuses
undeclared skipped cases, including a skip beside a surviving pass. The bounded
default frontend observer remains passive: it reports `unexpected_skips` and
`missing_skip_routes` without replacing the public runner's native authority.
These fields never establish installed, native or release acceptance.

The extra Linux diagnostics replay stays broad for diagnostics, Core, CLI,
Desktop, shared, dependency and uncertain inputs. Only ordinary added or modified
regular Rust files within the independent release-tool crate may omit it;
manifests, build scripts, fixtures, renames, deletions and permission changes keep
the replay. The maintained Cargo consumer-boundary contract must fail if another
workspace package starts depending on release tools. Required Windows Rust
selection and full qualification coverage remain separate obligations. The
replay uses the strict default nextest profile; its serial test groups, not a
single global slot, keep contending CLI lifecycle cases apart. It and the
Windows partitions record one shared source manifest from
`scripts/runtime-diagnostics-source.mts`.

Cheap source-consumer contracts run before selected compilation/runtime work.
The maintained native compatibility source inventory selects its declaration
contract locally and in hosted ordinary coverage; those source bytes also
invalidate its reusable local result. Pure CLI argument/help tests have higher
nextest priority and, with the CLI presentation unit tests, run outside the serial
CLI lifecycle group; all selected tests still run. This changes feedback order,
not coverage or merge requirements.
Use the existing complete-diff plan to identify these consumers when choosing
focused feedback; a hand-written feature filter may omit them.

Ordinary Windows Rust coverage uses one workspace build and a same-attempt
nextest archive distributed across balanced workers. The current complete and
selected inventories determine coverage; historical duration hints determine
only scheduling. The required Rust result includes the archive producer, every
selected partition and the parallel live transport check. Hosted workers use
four test slots while local runs retain two. Exact cases that conflict with any
concurrent disk or process work reserve the active profile's entire slot count;
contending lifecycle families (CLI lifecycle, Core output relocation, catalog
update, definition repository, activity diagnostics, database and cancellation)
each run one case at a time in a serial nextest test group beside unrelated
tests. See [CI timing diagnostics](DEVELOPMENT-TOOLS.md#ci-timing-diagnostics)
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

Ordinary frontend coverage splits the browser projects across jobs only when the
complete frontend suite is selected. The classifier sets `frontend_browser_shards`;
`fast_frontend` then runs content, static checks, the production build and the unit
project, and the `fast-frontend-browser` matrix runs the `browser`, `browser-locale`
and `browser-forced-colors` projects with Vitest `--shard`. The shard count is the
matrix length, so the shards cover the suite. Import-related selections, reused
postmerge results and qualification run unsharded. The required `frontend` result
waits for every shard and requires success exactly when the flag is true; with the
flag false, `fast_frontend` owns every project and the shards must be skipped. A
wrong flag therefore cannot omit coverage. Sharding changes where the same tests run,
not what is required, and it adds runner jobs per full run, so queue time still
counts toward latency.

In the hosted shard jobs, which set `PORTCOVE_BROWSER_SHARD`, the root Vitest
sequencer in `scripts/browser-shard-balance.mts` assigns shards by recorded file
duration instead of path hash: longest file first, onto the lightest shard, with
ties broken by the hash of project and path. Every current spec still lands in
exactly one shard. Other runs, including the seeded `shuffled` diagnostic, keep
Vitest's default sequencer. `.config/browser-test-weights.json` holds scheduling estimates only. A file
without a weight gets the median weight, and a missing or malformed weights file
fails the shard run instead of falling back. Regenerate the weights from a Vitest
JSON report of the three browser projects with
`node scripts/browser-shard-balance.mts --report <report.json> --source <description>`.
Stale weights can only make the shards uneven; they cannot drop a file.

A draft pull request defers the eight Windows Rust test partitions. When a fast plan
selects Rust that the run would execute itself, the classifier reads the pull
request's current draft state from the API and sets `windows_tests_deferred`; an
unreadable state keeps the partitions. The draft run still builds the Windows
workspace and runs the live transport comparison, and the required `rust` result
then fails with "Deferred by draft policy, not a test failure", so a head never
carries a passing `rust` result without its partitions. Marking the pull request
ready does not start a second CI run on the same head, which would duplicate every
required context: the supersede workflow instead re-runs that head's run only when it
actually deferred (cancelling it first if it is still active), and the new attempt
reads the ready state and executes the partitions. The classifier records the
decision as its "Defer Windows test partitions for draft" step, so an active run is
decided as soon as it is classified, even before its Windows build finishes; a run
that has not classified yet reads the ready state itself, and a run that did not
defer is left to finish. The re-run is best effort; if it does not happen, use "Re-run
all jobs" on the head's CI run; re-running only failed jobs keeps the draft
classification. Push, qualification, release and reused plans never defer.

The ready transition has a finite 25-minute API budget inside a 30-minute job,
polling once per minute while classification or cancelled-run gate jobs wait
for runners. The 64-request cap and terminal-state check remain enforced;
ordinary supersede events retain their four-minute API and five-minute job
budgets. Expiry preserves the run and the same all-jobs recovery instruction.

A superseded pull request run stops taking runners before its cancellation arrives.
The supersede workflow needs a runner of its own to cancel older runs, and under
queue pressure that can take as long as any other job. The classifier and the fast
Rust, frontend and catalog producers therefore run
`.github/actions/stop-if-superseded` right after checkout: on a pull request event it
reads `refs/pull/<number>/head` from the remote and fails the job with a "Superseded"
error when that head differs from the head the run validates. The job has done no
work for that head, so nothing is lost; the failure lands on a commit that is no
longer that pull request's head and cannot satisfy a required context. CI health
excludes such an attempt from the first-attempt pass rate, as it does a cancelled one.

An unreadable or missing head keeps the job running. Push, qualification and release
callers have no pull request and never stop. `windows-helper-contracts` keeps its
fixed admitted step list and is left to the supersede workflow.

A push run on `main` is not cancelled by a later merge. Shared Rust build caches are
saved only from `main`, and a cancelled run validates nothing; while merges arrived
faster than a run could finish, most `main` runs were cancelled and no Rust partition
completed there. One later merge waits as the pending run and replaces any older
pending one. Each `main` run still plans only its own push range, so a replaced
pending run's changes are not planned on `main`, as when such runs were cancelled.
Pull request runs keep their own per-run groups.

Retain failures, diagnose the smallest useful reproduction, and repeat only
invalidated obligations. Preserve assertions, coverage, cleanup and finite
termination; an unchanged later pass does not establish a causal repair.
Separate queueing, cold builds, warm execution, parallel work and postmerge cost.
The warm focused five-minute target is a measurement goal, never an acceptance
gate or permission to omit checks. Fixtures prove decisions, not minutes saved.

## Autonomous test-timeout calibration

Agents may diagnose, increase and persist proportionate finite test-harness,
fixture, command, supervisor and CI execution budgets without another approval.
Retain original failures, assertions, cleanup, the retry policy below,
heavyweight reservations and finite hang detection. Coordinate nested budgets
so inner failure and cleanup finish before the outer limit. Record the old/new
limits, rationale and result. More execution time alone is not a permission question.
This authority does not change application cancellation, shutdown, locking,
network, security or other behavioral deadlines, acceptance or release authority.
A pass under a larger budget proves completion under that budget.

The November 18 Native27 Windows run at `eaae775d` (output
`2026-11-18T12-56-04-004Z-K6Cg8V`, preparation live by 13:05 UTC) retained a
15-second timeout waiting for the backup review's “Review again” control after
the harness deliberately changed saved data. The host refused the stale review;
the failure capture still showed the apply awaiting settlement. Its trace records
consecutive workspace readbacks of 11,032 and 11,063 milliseconds. The same run's
discovery Activity row lookup expired while updated history was pending: its
workspace reads took 20,687 and 9,169 milliseconds. The existing-install copy entry
also expired on “Add games” while the refreshed Library still loaded; its reload
reads took 14,075 and 14,212 milliseconds. Exact attribution of these reads to the
frontend promises is unproven. Those two specific row/settlement lookups now have
60 seconds, matching the existing confirmed-restore wait; copy entry separately
waits up to 60 seconds for the exact visible enabled “Add games” control before its
ordinary click. Activity identity, accessible name and focus assertions, consent,
stale-review refusal, saved-data and backup assertions, retry policy, cleanup and
application/IPC/safety deadlines remain unchanged. The original failures remain
evidence; these calibrations alone do not establish successful native workflows.

The November 18 hosted Windows review-continuation run at `6c01ccf6`
(`44395050884/1`, job `135122626956`) positively recorded the owned native
**Cancel** response in `backup-native-restore-cancelled.json`. The subsequent
DOM-dialog-disappearance wait expired after 15.163 seconds, and its failure image
still showed **Restoring backup…**. Only that cancel-settlement lookup increases
from 15 to 60 seconds, matching the existing confirmed-restore and refused-apply
settlement waits. The raw logs do not establish backend latency or which read
kept the review busy. Native confirmation ownership, the unchanged-saved-data
assertion after settlement, ordinary 15-second clicks, focus, cleanup and product
deadlines remain unchanged. The original failure and positive cleanup remain
retained; a later native run must establish completion under the revised budget.

The same source's saved-folder job `135122626905` passed its first library
handoff, stale-generation refusal and source-inventory checks, then captured
**Loading your port library** after waiting only for navigation. Its single
restoration call received `target_busy` for the outgoing alternate library.
Before that one restoration call, the harness now reads the current owned
bootstrap and generation-bound workspace, waits up to the existing 60-second
presentation budget for navigation, the matching renderer generation and no
loading state, then confirms the same bootstrap root and generation. A lost
handoff response can leave either owned root current; one ordinary reload makes
an old renderer follow that current generation. IPC reads retain their existing
budgets. Readiness failure remains a restoration failure with its stage recorded;
there is no mutation retry. The exact lock holder is unproven. Core's two-second
outgoing-library drain, `target_busy` protection and all data assertions remain
unchanged. A refusal after this precondition still fails the scenario and needs
bounded read-only timing evidence, not a longer product deadline.

Two semantic review assertions also follow the actual structural-check result:
**Basic file checks passed** explicitly does not identify an edition. Their
typed NotRun, structural admission and not-evaluated edition assertions remain
unchanged. The install-refresh job `135122626818` recorded one `install_port`
overall but rejected the legitimate generation-bound `get_artwork` read after
refresh. Its exact read-only allowlist gains only that command; the one-install
and other mutation exclusions remain. The existing failure PNG now uses the
shared owned-target scroll and settled-capture contract for the complete
workspace feedback region, retaining its filename and focus. These are harness
repairs; original failures remain retained and require later native verification.

The same campaign's library-switch-recovery job `135122626538` retained its
future-schema refusal and original bootstrap/library identity, then a workspace
read received Core's explicit `conflict` with string details
`workspace_snapshot_stale: "true"` and `retryable: "true"`. Native metadata
observation may repeat only that read, at most three times, with the original
root and generation checked before and after each read. One 60-second acceptance
budget covers the attempts; it is not reset per retry. Already-started IPC is
awaited under its existing timeout even if that crosses the acceptance budget,
then fails without a detached read or late continuation. Every returned refusal
is retained in readbacks and the job log. Other conflicts, nonretryable results,
changed scope and mutations are never retried. Library recovery and the intake
restoration precondition share this policy; Core's consistency checks and
two-second outgoing-library drain are unchanged. The concurrent writer is unknown.

The minimized-preparation job `135122626750` completed the owned preparation and
native restore, then its positive Play-only lookup rejected the fixture's enabled
**Try launch** control. That restored-ready lookup now accepts either exact
caption in the detail's primary actions, still requiring launchable typed state,
no pending setup, visibility and enabled state with the existing 15-second waits.
Strict confirmed and negative launch checks elsewhere remain unchanged.

The closed-preparation job `135122626664` reported a scenario pass, but its
33,060,552-byte preservation report exceeded the unchanged 12 MiB evidence bound;
the codec retained no recoverable captures. Recovery still decodes and validates
the full workspace and checks the exact port status and operation activity before
reporting. Windows ordinary-close and Linux recovery reports now label
`recovered_workspace` as an asserted preparation projection: bootstrap/root and
generation, the asserted status/activity and a SHA-256 plus UTF-8 byte count of
the full validated snapshot's JSON serialization. This digest is not raw-wire
evidence. Unrelated catalog payloads are omitted only after the assertions;
codec bounds and all data/save/operation checks remain unchanged. The earlier
scenario summary does not establish retained-artifact or rendered acceptance.

The secondary-panel job `135122626691` completed owned DAT cancellation and focus
return, then the helper refused the implemented **Choose a DAT file** Open dialog
before input. The finite same-scenario audit also identified its existing recipe
and saves Open titles and metadata/saves Save titles missing from that guard.
Only these exact title/action pairs are added. Save defaults to denied unless
the trusted scenario explicitly supplies its owned output root; the wrapper binds
it to the existing fixture scope, and PowerShell requires an absent literal JSON
leaf directly under that existing non-reparse parent. Missing/unowned parents,
traversal, existing targets, device/wildcard names, unrelated titles and wrong
actions fail before field input. The path is rechecked before Save; the helper
never confirms overwrite or invokes Yes as part of Save. Process/creation/window
identity, exact owned fields/buttons, single-action readback/dismissal and existing
timeouts remain in force. Linux contracts verify fixture validation and producer
titles; the existing Windows-only AST/input witness covers the actual guarded
PowerShell blocks. Those Windows checks and native flows require later execution.

CI `44422479100/1` exposed an owned Save refusal in that Windows witness. The
exact witness reproduces it with an 8.3 spelling of the same owned directory:
the resolved parent and full target had different path spellings. Both now use
the existing full-path normalizer before comparison. Explicit short-root and
mixed-spelling cases retain existing-target and foreign-parent refusals before
input. The witness preserves unexpected refusal details; traversal, non-reparse
parent, absent direct JSON leaf and single-action checks remain unchanged.

The same run's install/Steam/artwork row `135122626818` took 749.558 seconds
across five executed cases while staged-update composition remained unrun; its
600-second aggregate watchdog expired before the final artwork result. Only that
exact six-case combination now receives a finite 1,800-second harness allowance,
shared by planning and execution. Standalone cases, smaller and unrelated larger
combinations, product deadlines and cleanup guards retain their existing limits.
The temporary follow-up controller gives this row 150 minutes rather than 90:
the observed cold setup/build envelope, 20-minute exact-driver wait, 30-minute
harness and cleanup must fit inside the job. This calibration is not a claim
that the original late result passed within its deadline or that latency is fixed.
The same source's local ordinary scenario suite passed 265 cases and failed its
existing catalog-backed history import child at its 10-second safeguard. That
inert child receives 30 seconds inside an explicit 60-second limit for this case
(the maintained suite default remains 30 seconds for other cases);
assertions, optional-package refusal and child completion remain required. The
original local failure is retained separately from subsequent focused feedback.

The November 17 Linux Heavy Rust calibration raises the parent's adopting-reaper
exit wait from 5 to 30 seconds. A guarded desktop build at `95f11af1` returned
payload status 0 and eventually published a positive quiescence receipt, but its
wrapper retained the lock after the former five-second wait expired. The receipt's
write and final inode-change timestamps were 5.784 seconds apart, consistent with
delayed durable publication. The finite 30-second parent wait leaves room for the
reaper's unchanged five-second descendant drain, receipt flush/publication and
scheduling. Explicit wait overrides, non-Linux five-second waits, receipt checks,
successful reaper exit and lock retention on unproved cleanup remain unchanged.
Controlled-clock runner tests cover delayed success, failure and the finite
deadline; they do not turn the retained original wrapper failure into a pass or
establish a new native build observation.

The private virtual-X11 wrapper derives its harness wait from the existing
selected-scenario deadline plus its 60-second startup/retention margin, then
allows the existing 30-second outer cleanup margin. Its former fixed 240/270-second
waits could preempt the selected-setup journey's maintained 600-second deadline;
that selection now receives finite 660/690-second wrapper waits. Ordinary
180-second selections and GTK-only readiness keep their 240/270-second waits.
Selection validation, scenario assertions, namespace joins, failure evidence and
native/resource lock retention remain unchanged. Contract checks establish budget
coordination, not a completed native selected-setup observation.

The November 18 private-X11 input calibration separates input custody from those
operation waits. An ordinary `98f988ed` application with `6c2d3ab4` tooling failed
before namespace launch: the shared 60-second capture limit expired after copying
the 150,319,296-byte pinned Node executable, during its remaining verification or
publication. The eight inputs totalled 152,779,458 bytes; capture copies, hashes
and durably verifies them repeatedly. Prelaunch capture and verification now have
300 seconds; the independent postjoin live-input scan has 120 seconds. The Linux
command guard includes both phases, the unchanged namespace outer wait and a
60-second command margin: 750 seconds for ordinary/GTK selections and 1,170 for
the standalone 600-second selected-setup journeys. Callers supplying an outer
execution guard must use that derived command budget. Content and identity checks,
partial failure evidence, namespace joins and native/resource lock retention remain
unchanged. Controlled-clock tests exercise completion beyond the former minute
and finite capture/postjoin failure; they are not a native application observation.

The strict default nextest profile, used by local runs and qualification,
allows zero automatic test retries. By explicit owner decision (November 2026),
the ordinary hosted Windows partition profile `hosted-windows` allows one
automatic retry. A case that fails both attempts fails the partition with its
original failure; a case that passes only on retry is reported as flaky in the
nextest summary, the retained JUnit report and the shared Rust outcome records
(`nextest_attempt` and the inventory's `flaky` list). A flaky pass is evidence
of nondeterminism to diagnose, not a causal repair. Cases whose exact budget is
at least 300 seconds keep zero retries so a hang cannot double a long cutoff
inside the job limit. Other runners, watchers and
qualification routes retain zero automatic retries.

The November 2026 nextest calibration raised the default whole-case harness
cutoff from 30 seconds (5s × 6) to 120 seconds (15s × 8), still with no grace
period. It removed the 146 per-case and per-family overrides whose budgets
were at or below 120 seconds, since each now receives at least its former
limit; the 15 exact overrides above 120 seconds keep their budgets and order.
Product deadlines, assertions and cleanup are unchanged; a pass under the
larger budget proves completion under that budget.

Automatic saved-data snapshots before update, activation and rollback (#4879)
added one verified snapshot to each version change in the generated managed
native-route lifecycles. Hosted Windows run 42840655073 timed out
`managed_native_declared_toy_story_2_*` on both attempts at the 120-second
default after reaching staged activation at 111 seconds, while its sibling
`doom_3` passed at 82 seconds. The family
`service::native_portable::tests::managed_native_declared_` therefore has one
exact Windows override of 240 seconds (5s × 48, below the 300-second no-retry
line). Every phase, assertion and snapshot is unchanged; a pass under the larger
budget proves completion under that budget.
The same run timed out `reviewed_archive_transition_sonic_populated_install` at its
360-second exact budget in a 862-second partition. That case has taken from
149 to 300+ seconds on hosted Windows runners, so its exact override is now the
600 seconds its family already has; its MMX2 and Super Metroid siblings stay at 420.
Run 43244946189 attempt 1 then terminated
`reviewed_archive_transition_mmx2_populated_install` at its 420-second exact
budget (421.091 seconds, no failed assertion) in an 898-second Windows partition
6, so MMX2 now also has 600 seconds (5s × 120) with zero retries; Super Metroid
stays at 420. Every phase and assertion is unchanged.

`service::native_portable::tests::ready_staged_archive_observed_lifecycle_cases`
has an exact Windows override that went from 270 seconds (5s × 54) to
420 seconds (5s × 84) with zero retries, in `6e3e7688`. Under the 270-second
budget, hosted partition 3 terminated it on both nextest tries in seven job
attempts between 2026-11-10T23:58Z and 2026-11-11T01:18Z (runs 42926560343
attempts 1 and 2, 42926658303, 42926762535, 42926803942 attempts 1 and 2, and
42936437670 attempt 1). Each try stopped at about 270.6 seconds; no assertion
failed. Since the change it has passed in 214 to 300 seconds in runs 42956417507, 43043569577, 43044023613, 43053534370 and
43053961839. A budget of 300 seconds or more keeps zero retries, so a hang uses
the cutoff once. The case's phases and assertions are unchanged.

Qualification run 43090604192 attempt 1 (source `0e743fbc`) calibrated four
macOS fixture waits; product deadlines and assertions are unchanged. Intel job
130795135036 terminated
`service::tests::authenticated_admission_survives_staging_rollback_activation_and_refresh`
at the 120-second default on its single zero-retry attempt, while the ARM job passed it in 55.9
seconds; Intel now has the same exact 180-second override (5s × 36) as Windows.
The curated-cache setup latch in `definition_publisher_policy_tests.rs` went
from 10 to 15 seconds for the three Intel restore variants (first copy 10.03
seconds after installer start), from 15 to 30 seconds for Intel withdrawal
retention (first copy at 15.33 seconds), and from 5 to 15 seconds for ARM
cancellation restore (expired at 5.32 seconds before any copy). Each latch still
requires a real partial copy, then the intervention, refusal and worker-drain checks.
Scheduled Qualification run 43230875182 attempt 1 (source `bdc3a4d5`) then
passed all of those cases on both Macs, but Intel job 131243259441 cut two
other cases on their single attempt.
`catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts`
stopped at its 180-second Intel override after passing in 164.8 seconds in the
earlier run; its Intel override is now 240 seconds (5s × 48), below the
300-second no-retry line.
`curated_rollback_withdrawal_permits_exact_retained_target` stopped at the
120-second default after passing in 119.4 seconds earlier; Intel now has the
same exact 180-second override as Windows.

The Playnite reference-client lifecycle check runs its first `definition-state`
Cargo action (`select`) against a cold fixture-enabled Core test build on
Windows. Scheduled Qualification 43715629646 (job 132822315937) was the first
run to reach that phase and stopped `select` at its 20-minute child budget; the
check buffered Cargo's output and discarded it on timeout, so it now keeps the
output tail in the timeout error. The same run's cold Core-inclusive
`qualification-core-archive` test build took about 34 minutes, so `select` now
has 40 minutes. `install` and `revoke` reuse that build and keep 20 minutes,
which keeps the phase inside the job's 120-minute limit; other Playnite Cargo
children keep ten minutes.

The October 2026 test audit calibrated the three maintained Node suites that
contain fixed Linux Python child wrappers from a 30-second default to
60 seconds. Their child limits remain 30 seconds. The dynamic ordinary and
bootstrap contract runners also allow 60 seconds so those same wrappers can
report and clean up. Other registered suite defaults, explicit per-test limits
and product deadlines remain in force. The controlled timeout contract retains
the child's readiness stderr and verifies process exit before the outer runner
completes. Other nested subprocess families require their own calibration.
The Windows suspended-storage preflight fixture allows 60 seconds for its
PowerShell child and 90 seconds for the enclosing case. Its hosted 20-second
spawn timeout failure is preserved; all 26 inert cases and assertions remain unchanged.
This calibrates the test harness, not storage access or application deadlines.
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
45 minutes, and exhaustive producers at 120 minutes. The Windows Rust build has
60 minutes: with the optimized test profile a cold build took up to 37 minutes
(run 43352622836) and a root-manifest edit forces one until `main` saves the cache. Windows helpers have
15 minutes: run 43296962076 attempt 1 reached the earlier 10-minute limit in its last
step on a slow runner and passed its one re-run in 8 minutes. The macOS no-global frontend route allows
35 minutes for its full verification command inside a 45-minute job, leaving room
for cold provider setup and diagnostic retention. Run `44490420055/2` reached its
previous 25-minute job limit while cases were still completing. Two earlier
adaptive-shell bounds failures remain separate from that timeout; additional time
alone does not repair them. The route keeps every assertion and per-case deadline,
and requests diagnostics after failure or cancellation. Adaptive-shell fixture
changes select this existing macOS route. Whole-job termination still
does not establish successful cleanup or guaranteed evidence retention. Other
portability probes retain 15 minutes. These generous outer
envelopes include cold setup and evidence upload above the audit's sampled
ordinary jobs and failed qualification producers. They are hang
limits, not latency targets or evidence that cleanup can survive a whole-job kill.

## Dependency policy

Keep scanner scope, findings and original exit status truthful. Development
policy and Linux release risk authorization remain separate under
[dependency security](releases/2026-10-14-linux-beta-risk-706.md). A raw failed scan is
never passing security evidence or publication permission. Preserve no additional
spending: resource limits produce a limitation, not paid services or new hardware.

Use compatible ranges for dependencies whose supported APIs and feature contracts
allow routine compatible updates. Use exact versions when review binds parser
limits, a transport or signing contract, a patch's source context, or a
coordinated toolchain to a particular release. Commit the Cargo and pnpm
lockfiles and use locked or frozen installs in validation. Check the resolved
source, effective features, and supported targets when a dependency changes.
Review native source bundled by a package when it supplies the relevant fix.

Keep intentional exact pins eligible for update proposals in
[Renovate](../renovate.json). Its weekly maintenance retains release-age
safeguards and the existing coordinated groups. Applicable advisory fixes can
go through the ordinary reviewed delivery path as soon as a suitable version
qualifies. Review [dependency patches](DEVELOPMENT-TOOLS.md#dependency-patches)
with their consumers and remove the patch and its policy entries together once
the upstream behavior passes their regressions.

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
Pull request CI already validates the pull request merged with the target tip at run
start, so merging `main` into a candidate only because `main` advanced adds a full
hosted run on a new head without new evidence. Merge `main` for a conflict, a relevant
interaction or changed composition.

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

The maintained Linux `rustc --test` environment route separately uses
`standalone-rust-tests.mts`. It preserves compilation, unfiltered selection and
native concurrency, then captures libtest JSON through the same bounded stream
collector. Each packet binds the exact ordinary binary's SHA256 and size before
and after execution. This is compiled-binary provenance; a checkout or target
that produced it is not inferred. The observed host and CI run/attempt/job are
separate fields. Runtime formatting sets only the child bootstrap to `-1` and
refuses inherited overrides.

Packets under `work/standalone-rust-tests` retain raw streams, ordered command,
case identities, native durations, ignore reasons and original failure details.
Discovery/selection counts come from the complete unfiltered native suite, not
source attributes; executed, skipped and failed counts remain separate. Empty,
contradictory, partial or over-limit output cannot establish completion. Original
nonzero native status remains primary over reporting refusal. The CI artifact
is retained after failure as well as success. These unit-binary observations are
separate from native GUI, package or release acceptance.

### Declared skip routes

The existing Node ownership record declares `platform_skips` with stable case names,
an optional single parent test or `suite`, intended platforms, prerequisites, reasons
and a maintained producer. Declarations cover registrations through their owning
entry file, including explicitly named imported cases; raw Node observations retain
the defining source separately. Other nested deferrals fail closed.
Legacy single-object declarations retain their reviewed, exclusive unfiltered
qualification owners. Complementary route arrays add platform, prerequisite,
supervised-parent and explicit-acceptance observations without granting file-level
ownership or any prerequisite. Original native reasons and outcomes remain separate.

Every registered file is checked for new skips/todos. Selected declared cases must
appear exactly once and execute on their intended platform when known prerequisites
are present. Ordinary Linux ownership and explicit environment prerequisites are
checked independently; unavailable capabilities retain only their specific original
skip reason. Unknown tool availability remains unassessed and cannot qualify acceptance.

A complementary selector may prove its explicitly named cases, including selection
through their declared parent suite, never full-family discovery. Unsupported
stateful filters remain unevaluated. A missing
case, removed producer or selector excluding its declared route fails; legacy
unfiltered owners remain required. Metadata failures preserve original native
failures. These inventories never execute ignored cases, appoint tools, grant
credentials, or establish native, installed-client or release acceptance.

### Default nextest outcome reporting

The guarded default `run-rust-tests.mts` route lists its native selection before execution and reuses the bounded nextest outcome reporter. Raw listing stdout/stderr is retained under `work/nextest-default-outcomes`; missing, malformed and empty inventories cannot establish qualifying success. Original native failure status and human diagnostics remain primary.

Explicit compile-only/help, native-format, no-capture and ignored-run overrides keep their original raw diagnostic behavior and emit a nonqualifying inventory annotation. They do not substitute for the maintained qualification routes. Guarded arbitrary commands keep their existing execution contract.
