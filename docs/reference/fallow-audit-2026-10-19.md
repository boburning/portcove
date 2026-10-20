# Fallow audit, October 19, 2026

Owner and delivery evidence: [#2186](https://github.com/boburning/portcove/issues/2186).
The [finding ledger](fallow-audit-2026-10-19.json) records original identities,
source review and dispositions. A disposition is not a passing analyzer gate.

## Source and coverage

The original clean source was `e9f41686b5ff06fb197ee8ca577c3425775aafac`.
All three original JSON reports used repository-pinned Fallow 3.34.0, two
threads, JSON output, explanations and a disabled analysis cache. Their SHA-256
digests are in the ledger. Original reports, stderr, traces, failed controls and
subsequent checks are retained at
`E:/Codex-Evidence/fallow-audit-20261019` on the audit host.

| Original scope                                   | Findings reviewed |
| ------------------------------------------------ | ----------------: |
| Desktop dead code/dependencies                   |                10 |
| Tooling dead code/dependencies                   |                52 |
| Tooling complexity                               |               761 |
| Additional Desktop complexity identities         |                 3 |
| Unique duplicate fingerprints across both scopes |               151 |
| Individually reported arbitrary CSS classes      |               226 |

The 761 tooling complexity identities comprise 171 critical, 342 noncritical
root-tooling and 248 noncritical outside-root-tooling findings. The Desktop
report has 243 complexity findings; three do not occur in tooling. Coverage
estimates in these reports are not measured test coverage.

## Corrections

- Repair the confirmed stale-lock race: a delayed stale-owner observer could
  replace a live successor. Retained per-owner recovery claims, canonical owner
  rechecks and idempotent release preserve successor ownership. A controlled
  two-process test fails before the repair and passes afterward.
- Remove unused export/type surfaces and stale suppression text. Correct actual
  command/test/support roots and narrowly credit dynamic or external consumers.
  Controls still detect orphan exports, production dependency misuse and forbidden
  shared-to-feature dependencies.
- Share 37 assertion helpers across 18 native scenarios. Keep scenario contracts,
  differing diagnostics and the history fixture's dependency-free local helpers.
- Share identical container failure rendering, lexical release containment,
  recursive JSON object ordering, validation path normalization and catalog
  membership/scope accumulation. Preserve each caller's validation, serialization,
  ownership, symlink, acquisition and publication rules.
- Separate the reusable audit contract from execution, and consume the existing
  ordinary classifier directly from CI planning. Extract retained Fallow report
  reuse checks and frontend build argument validators into named responsibilities.
- Simplify game-file status presentation, remove two unused theme aliases and
  replace two undefined warning-surface branches with their existing fallback.

## Retained findings and limits

Explicit trust/schema conjunctions, ordered state machines and independent test
witnesses remain visible. Structural refactor opportunities in the ledger are
retained recommendations, not fixed defects or suppressed analyzer results.
Generated transport declaration duplicates belong to their generators; manually
editing generated definitions would not repair their source contract. Arbitrary
CSS classes include runtime values and component recipes; their presence alone
does not justify deleting or restyling them.

The CSS report's aggregate of 90 unreferenced custom properties does not name
the properties. Individual deletion safety is **Unknown**. No deletion or
complete-property-coverage claim follows from that aggregate.

Optional Git churn traversal stalled during the original combined analyses.
Static reports completed after stopping only their exact owned history-reader
children. History-derived rankings are incomplete. Two optional review-guide
requests timed out; the Fallow graph judgment loop is not claimed complete.
Separate source review and ordinary hosted validation remain distinct evidence.

Focused tests exposed stale live upstream-monitoring contract bindings; the
identical failure reproduces on the unchanged parent. Nineteen rules across
13 ports had changed only their `presentation` field. Each approved old hash was
reproduced from `93259eb`, and every other contract field was verified identical
before rebinding the full hash. Pin and condition fields, metadata requirements
and authority remain unchanged. The ledger retains each old/new binding and its
approved source; all 87 shared-contract controls pass after this repair.

This report does not claim a full Fallow quality-gate pass, native acceptance,
release qualification or measured coverage. Current exact-head CI, separate
review, guarded delivery and remote readback are recorded on the owning issue.

## Follow-up: complete the Desktop gate

The owner subsequently requested a passing full Fallow gate. Dispositioning the
remaining critical findings had completed triage, but had not completed that
intended outcome. Issue #2186 was reopened with full gate acceptance.

Fresh analysis of `2cd81f287a0e4b1661e2f9ddd6e005b0dfb605eb` found 18 critical
Desktop functions, including intervening UI changes. The follow-up separates
request state from rendering, settings sections from navigation, setup and backup
assessment presentation from detail assembly, and native listener routing from
its response and restoration oracles. Existing condition priority, request
generations, callback identities, cleanup and fail-closed decisions are retained.

The candidate's maintained `node scripts/run-fallow.mts desktop` passes with zero
check findings and zero critical complexity findings. Its complete combined
report includes Git-derived rankings. No threshold, exclusion, suppression,
coverage estimate or gate policy was changed. Lower-severity complexity and
duplicate groups remain visible under the existing policy. This supersedes the
earlier retained-critical disposition for Desktop gate completion; the original
audit ledger remains a dated historical snapshot.

Validation includes all 415 tests in 11 affected UI test files, five native fixture
source controls, formatting, lint and type checks, plus independent non-writing
review. Fixture source checks establish the tested cleanup and transport
contracts, not native acceptance. Exact final source, hosted CI, guarded merge
and remote readback are recorded on the owning issue and follow-up PR. Retained
reports and failures are under `E:/Codex-Evidence/fallow-main-gate-20261019`.

## Follow-up: trustworthy reports and bounded capability trials (#2211)

This work starts at current main `05da1abb3b448700bfc9ff08918a4e94ff47f395`,
with pinned Fallow 3.34.1 and Node 24.22.0. It preserves the completed cleanup
and passing whole-Desktop gate above. Historical finding totals are not a new
cleanup backlog.

### Confirmed findings and corrections

The native malformed-source control reproduces exit 0 and no check failures
without opt-in parser enforcement. Whole-Desktop now requests and requires the
native parse-error gate, and separately refuses source-read failures (including
invalid UTF-8) and an unexpectedly empty required scope. Optional missing churn,
ownership and ranking information stays advisory and is disclosed beside results.

The dirty discovery-input and inherited production-option reuse holes also
still applied. Reuse now inventories every Git-visible regular input, fixes the
maintained routes' effective scope, and binds supported coverage/baseline contents
and retained streams. Old metadata needs fresh analysis. The existing saved-report
renderer, four route distinctions, caches, resource admission, two-thread default
and selected hosted complete-history checkout already worked and were preserved;
no general history fetch or new mandatory scan was added. Expanded custom review
summaries retain native and display omissions, consumer samples, optional states,
effort-adjusted priority and coverage provenance.

### Advisory trials and adoption decisions

[Hosted trial run](https://github.com/boburning/portcove/actions/runs/39330689787)
uses an unmerged disposable experiment branch `c29164d`, with unchanged Desktop
source from the starting main. Reports, arguments, streams, hashes, copied-source
integrity and timings are retained in its artifact. Approximately 30 seconds of
native/test command time excludes provisioning and artifact upload. No trial
configuration, runner, dependency, threshold or workflow change is adopted into
main merely to run these experiments.

| Capability                     | Observed value, limitation and decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Command cost                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Inspect and guard              | `concurrency-state.ts`: 13 importers, eight exports and private `drain` complexity 12; guard confirms shared is restricted to shared while a selected feature caller is unrestricted. Adopt selectively before consequential refactors; declared policy does not cover every caller.                                                                                                                                                                                                                                                                                                         | 1.04 s / 0.11 s                            |
| Exact semantic consumers       | Matching companion is available. Explicit Desktop tsconfig gives 12 direct consumers, 60 affected files and 46 static test identities for `LatestRequestGeneration`. Both best-effort and complete results are partial with 104 evidence-limit omissions; complete exits 1. Adopt positive consumer evidence selectively; defer absence/deletion conclusions until complete.                                                                                                                                                                                                                 | 12 s each                                  |
| Dependency trace               | Tauri API trace locates 18 importers, 137 invoke call sites and 184 use sites; ten displayed with a continuation cursor. Adopt selectively for upgrades, then read wrappers, constructors and unresolved uses manually. Native wrappers are empty despite `desktopApi`; Channel has zero call sites but real constructor references. Static reach is not runtime compatibility.                                                                                                                                                                                                              | 0.20 s                                     |
| Four React structure/API rules | Warn-only absent-component-props, prop-drilling, thin-wrapper and duplicate-prop-shape report no candidates in nine representative files. Defer permanent enablement: recurring value was not demonstrated; missing findings are not complete dynamic/external consumer proof. Intentional dialog primitive wrappers remain.                                                                                                                                                                                                                                                                 | 0.22 s combined                            |
| Semantic and near duplication  | Fourteen groups, 12 displayed, two omitted; 555 groups below three occurrences filtered. Clipboard request guards in ActivityDiagnostic, FailureDetails and SourceIdentity add useful semantic visibility, but reset/lifetime ownership differs. Adopt semantic investigation selectively and retain those implementations. Less-than-exact near-miss benefit was not demonstrated; defer model-based similar-code.                                                                                                                                                                          | 0.25 s                                     |
| CSS token consumers            | All 37 recognized theme tokens have consumers. One-use heading, loading and progress aliases have real dialog/progress callers; muted-foreground has 103 source consumers but only 20 native locations sampled. Adopt the compact view selectively for token-change impact. These are lower bounds including tests, separate from ordinary custom properties; zero is insufficient deletion evidence.                                                                                                                                                                                        | 1.03 s                                     |
| Measured test coverage         | Nine maintained baseline evaluator Node tests, copied with four exact source files, produce V8 evidence matching 38/38 functions. Validator estimated CRAP 462 becomes about 21 with 97.06% measured coverage; unexecuted helpers stay zero-covered. Adopt selectively for a concrete risk investigation, without a coverage program or score gate. This is baseline function execution, not current whole-repository, renderer, native or Rust coverage; target-effort rankings were not captured.                                                                                          | 0.13 s capture; 0.11 s per health report   |
| Mutation testing               | The actual Vite+ test import works through native Vitest on a disposable coalescing-helper copy: two mutants, one killed and one surviving, partial by limit (122 total). Source review finds the surviving private drain guard apparently equivalent under reachable scheduling; preserve the guard, not a new test-gap claim. Adopt selectively with inspected plans, tiny counts and concurrency one. A Node helper plan has all 19 mutants without test-role coverage, so defer that plan; this does not establish Node or `.mts` incompatibility. Browser/native routes remain untried. | 0.12 s plan / 1.31 s run; 0.18 s Node plan |

No new architecture invariant was needed beyond the existing shared-to-feature
rule. Entry-weight and broader security scans had no concrete startup or product
trust question in this adapter work, so were omitted; source reach is not bundle
size or startup time, and Fallow does not analyze Rust or replace runtime,
transport, provenance or native checks.

### Completed walkthrough and evidence scope

The hosted guide completed in 3.4 seconds on `c29164d`, graph
`graph:b05afabfdb0f49bc`. The independent reviewer read both emitted contract
questions and their outside-diff consumers: container/resource admission already
requests `includeAll: true`; report-summary consumes a bounded string without
parsing its lines. The reviewer submitted both judgments on the unchanged graph.
[Native validation](https://github.com/boburning/portcove/actions/runs/39331160226)
returned `stale: false`, two accepted signal anchors, zero rejected and zero
unanchored judgments. Their reasoning remains `deterministic: false`: validation
establishes emitted anchors and snapshot identity, not reasoning or behavior.
Adopt selectively for substantive contract review; ordinary independent source
review and exact-head CI remain separate.

Original local trial admission failures are preserved: a foreign checkout's child
resource record became NUL-filled. It was neither modified nor bypassed. Hosted
execution used the established CI resource route independently. The initial native
parser fixture also timed out after inheriting parent repository history; giving
that disposable fixture its own Git boundary repaired it without raising budgets.
Detailed trial outputs and failed evidence remain under
`E:/Codex-Evidence/fallow-evidence-workflow-20261019` and the linked hosted artifacts.
