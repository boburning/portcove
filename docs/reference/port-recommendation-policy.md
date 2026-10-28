# Port recommendation assessment foundation

This reference describes the proposed Core assessment primitive for #251. It is
not a shipped game-comparison feature. The primitive has no collector, catalog
schema, service entry point, CLI command, Desktop IPC or UI caller yet. Those
integration and acceptance obligations remain open on #251; the existing listing
and operation paths are unchanged.

## Ownership and inputs

`assess_port_recommendations` is a read-only function over an explicitly supplied
snapshot. It makes no network requests, opens no Library and changes no installed
or selected identity, source, channel, pin, save or preference. Inputs are accepted
Core facts, not arbitrary upstream text. The eventual existing observation owner
must normalize claims, preserve their actual authority and retain snapshots and
corrections. Merely constructing a `GameplayObserved` record does not prove that
any gameplay occurred.

An assessment binds game, edition, independent port, offered release, accepted
artifact, platform, relevant environment, source profile and route. Observation
applicability requires equality across that complete identity. Historical records
remain inspectable but supply no current-artifact confidence. Context joins use
explicit IDs, never names, repository sharing or guessed source interchangeability.
Only catalog profile IDs are needed for selected-source applicability. The engine
has no original-file bytes, hashes or filesystem-path input and performs no upload.

The caller supplies the evidence snapshot identity and evaluation time. The
`balanced-v1` policy is explicit and unsupported versions refuse assessment. The
caller must treat malformed optional inputs as unavailable recommendations and
retain ordinary listings and otherwise permitted operations. This primitive does
not yet implement that fallback in the real listing adapters.

## Balanced policy and rubrics

Weights sum to 100 and never change because a dimension is unknown or genuinely
not applicable. Ratings below are scoped assertions supported by attributable
facts, not per-port numeric catalog fields. The collector-to-rubric interpretation
is not implemented by this foundation and remains part of #251 integration.

| Dimension | Weight | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| Gameplay | 30% | Cannot perform the assessed gameplay | Major required content unavailable | Material progression/mechanics defects | Main assessed loop works with stated limitations | Assessed progression works with minor defects | Complete assessed scope works without a known material defect |
| Stability/save reliability | 20% | Confirmed destructive or unusable behavior | Frequent assessed crashes/save failures | Material reliability gaps | Repeatable assessed play and save/load with stated limitations | Repeated reliable sessions and recovery | Repeated assessed lifecycle and recovery without a known material failure |
| Performance | 15% | Unusable in the assessed environment | Severe sustained interruption | Material pacing/resource problems | Playable within stated measured limits | Consistent measured performance | Consistent measured performance meeting the stated target throughout the assessed scope |
| Controls/capabilities | 15% | Required interaction unusable | Major interaction gaps | Material control limitations | Assessed interaction works with stated limitations | Useful assessed controls/accessibility work | Relevant assessed interaction/capability goals all work |
| Setup/update | 15% | Assessed route cannot complete | Major unrecoverable setup problems | Significant manual/recovery limitations | Repeatable assessed setup with stated limitations | Repeatable setup, verification and updates | Assessed setup/update/recovery goals all work |
| Maintenance outlook | 5% | Explicit abandonment of required continuity | Known unresolved continuity failure | Material stated continuity limits | Attributable continuity with stated limitations | Demonstrated relevant regression handling | Demonstrated relevant continuity and succession handling |

These are bounded rubrics, not claims of universal completeness. A rating of five
covers only its recorded scope. An old, quiet but working project receives no
blanket activity or age penalty. Stars, download totals, commit counts, repository
size, language and recompilation technique are not inputs.

## Evidence strength

Strength is a reproducible coefficient, not probability of successful play:

| Evidence kind | Applicable dimensions | Strength |
| --- | --- | ---: |
| Upstream declared | Any, as an attributable claim only | 250/1000 |
| Artifact inspected | Controls and setup | 500/1000 |
| Setup observed | Setup | 1000/1000 |
| Launch observed | Setup only; not gameplay or save reliability | 750/1000 |
| Gameplay observed | Gameplay, stability and controls | 1000/1000 |
| Performance observed | Performance | 1000/1000 |
| Maintenance observed | Maintenance | 1000/1000 |

Unsupported observation-kind/dimension combinations supply no strength. Future
observations supply no present strength. Unchanged exact-artifact observations do
not decay merely with age. Exact duplicate records are deduplicated; corroborating
ratings use the strongest applicable evidence, never a report-count bonus.
Contradictory ratings, or a rating versus not-applicable, remain conflicting and
cannot support a default. Duplicate IDs carrying different facts are invalid.

A correction must explicitly name the superseded IDs, match their exact scope and
dimension, be strictly later, and have at least their evidence strength. Strict
time ordering rules out cycles. A new timestamp alone does not resolve a conflict;
a release-note claim cannot supersede an observed gameplay failure.

## Scores and recommendation gates

The implementation uses exact integer arithmetic. `ranking_score_basis_points`
ranges from 0 to 10000; `evidence_coverage_permille` ranges from 0 to 1000. For each
dimension, the internal estimate is `c * (rating / 5) + (1 - c) * 0.5`, multiplied
by its unchanged weight. Unknown, conflicting and not-applicable dimensions keep
their neutral contribution with zero strength. An entirely unknown result exposes
no score, rather than displaying the neutral internal 50/100.

A default additionally requires allowed existing Core operation eligibility,
matching context/source, every explicit capability requirement satisfied, no
invalid/conflicting current evidence, no unresolved accepted critical regression,
at least 650/1000 weighted coverage, and exact-scope observed gameplay and stability
each rated at least three. Unknown requirements remain different from unsupported
ones. Quality never overrides an integrity, permission, source or operation hold.

Among otherwise eligible options, a two-level gameplay or stability advantage
with no disadvantage in the other playing dimension excludes the materially worse
option from a default. Its listing remains visible. Thus setup and feature polish
cannot compensate for materially worse play.

The initial comparable margin is 500 score basis points (five points out of 100).
A winner also needs that advantage in jointly known dimensions, using the weaker
of the two evidence strengths. Neutral unknowns cannot manufacture an advantage
over another candidate's observed low rating. Close or insufficiently distinguished
options remain comparable; stable scope ordering resolves presentation order, not
an invented quality winner. No hysteresis is implemented.

A lone in-game candidate is assessed without a best-port claim. A justified
starting point among alternatives is distinct from a player selection or installed
port. No suitable candidate and insufficient evidence have distinct outcomes.
Numeric fields are diagnostics, not a public universal ranking.

## Accepted critical regressions

The input separates retained failures from newly observed accepted failures. The
result returns their deterministic union, preserving originals even after a fix.
The existing observation owner must carry that union into the next refresh; the
engine creates no second store. A failure persists across omission from the latest
collection, elapsed time and a new release/artifact for the same game, edition,
implementation, platform, environment, source profile and route. This means an
unresolved regression prevents a default; it does not assert that every later
artifact is proven broken or create an executable hold.

Only an explicitly accepted, later, exact-artifact gameplay correction can resolve
it for that candidate. A future fix, release note, closed issue, launch-only pass,
new tag or fix on another artifact cannot. Conflicting retained regression IDs
cannot be cleared by one ambiguous correction. The existing observation owner
must retain accepted correction records too; automatic collection and persistence
integration are not part of this primitive.

## Evidence and remaining delivery

The adjacent tests are synthetic policy fixtures. They are not observations of
SymphonyRecomp, Nocturne, Golden Balloon, DKR-R or any other real game, nor measured
performance or installed-application evidence. Execution and review results belong
on the PR, not in this document as assumed passes.

Remaining #251 work includes mapping existing accepted observations to these
inputs, real pinned comparison calibration, incremental refresh and failed-check
freshness, optional metadata/old-reader fallback, shared service/CLI/Tauri adapters,
game-centered UI and opt-in followed-project updates, accessible interaction,
independent review and exact-head validation. No catalog support, protected
publication authority, public machine API version or Library schema changes here.
