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
