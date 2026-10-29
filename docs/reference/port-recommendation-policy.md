# Game-centered port recommendations

`PortcoveService::compare_game_ports` supplies the same Core-owned result to
`catalog compare` and Desktop's game comparison / **Why this port?** surface.
The pure `assess_port_recommendations` policy remains independently replayable.
Recommendations never install, launch, switch an implementation, change a channel
or pin, register original files, or move saves. Ordinary project pages and permitted
operations remain available when optional recommendation information is unusable.

## Ownership and inputs

Existing catalog `original_game` IDs relate independently catalogable projects.
Names, repository sharing and artwork IDs do not establish that relationship.
An unambiguous source edition is required for a quality recommendation; missing
or contradictory edition identity does not merge editions or hide alternatives.

A request selects a project, optional edition/platform/environment, explicit
capability requirements and optional catalog source-profile IDs. Without an
explicit source context, Core uses this library's registrations. A supplied source
context is labelled hypothetical, not newly verified. Source matching, current
library readiness, operation eligibility and gameplay evidence remain separate.
The default `unqualified-host` environment cannot inherit another device's
observations. Selecting an environment explicitly is not hardware qualification.

Optional `presentation.recommendation` format 1 holds attributable observations,
not a per-port numeric ranking. Each record binds game, edition, independent port,
offered release, exact artifact, platform, environment, source profile and route.
Named outcomes map to the six rubrics below; the same accepted facts generate
scores and explanations. Unknown/not-applicable are explicit outcomes. Provenance
must use bounded public HTTPS URLs without credentials or query strings. No
original-file bytes, private paths or private library inventory are uploaded.

The public `recommendation_metadata` schema describes record fields, named outcomes,
evidence kinds, supersession and explicit fixes. Metadata is limited to 128 KiB
and 64 observation/capability records. Missing, malformed or future optional
versions supply no quality evidence, rather than rejecting the ordinary catalog.
Existing authored-catalog review and delivery remain the acceptance boundary:
a typed `gameplay-observed` assertion alone is not proof that gameplay occurred.
Provider text cannot authorize new observations, restrictions or corrections.

Assessment time is an explicit replay input. Unsupported policy versions refuse
pure assessment; the integrated optional query falls back without changing ordinary
operation eligibility. API schema 83 exposes the comparison and context contracts;
old catalog readers can ignore the additive inert presentation field.

## Balanced policy and rubrics

Weights sum to 100 and never change because a dimension is unknown or genuinely
not applicable. Ratings below are scoped assertions supported by attributable
facts, not per-port numeric catalog fields. The metadata normalizer maps the named outcome enums to these levels. No AI
percentage, popularity metric or automatic gameplay inference is involved.

| Dimension                  | Weight | 0                                           | 1                                       | 2                                       | 3                                                              | 4                                             | 5                                                                                       |
| -------------------------- | -----: | ------------------------------------------- | --------------------------------------- | --------------------------------------- | -------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Gameplay                   |    30% | Cannot perform the assessed gameplay        | Major required content unavailable      | Material progression/mechanics defects  | Main assessed loop works with stated limitations               | Assessed progression works with minor defects | Complete assessed scope works without a known material defect                           |
| Stability/save reliability |    20% | Confirmed destructive or unusable behavior  | Frequent assessed crashes/save failures | Material reliability gaps               | Repeatable assessed play and save/load with stated limitations | Repeated reliable sessions and recovery       | Repeated assessed lifecycle and recovery without a known material failure               |
| Performance                |    15% | Unusable in the assessed environment        | Severe sustained interruption           | Material pacing/resource problems       | Playable within stated measured limits                         | Consistent measured performance               | Consistent measured performance meeting the stated target throughout the assessed scope |
| Controls/capabilities      |    15% | Required interaction unusable               | Major interaction gaps                  | Material control limitations            | Assessed interaction works with stated limitations             | Useful assessed controls/accessibility work   | Relevant assessed interaction/capability goals all work                                 |
| Setup/update               |    15% | Assessed route cannot complete              | Major unrecoverable setup problems      | Significant manual/recovery limitations | Repeatable assessed setup with stated limitations              | Repeatable setup, verification and updates    | Assessed setup/update/recovery goals all work                                           |
| Maintenance outlook        |     5% | Explicit abandonment of required continuity | Known unresolved continuity failure     | Material stated continuity limits       | Attributable continuity with stated limitations                | Demonstrated relevant regression handling     | Demonstrated relevant continuity and succession handling                                |

These are bounded rubrics, not claims of universal completeness. A rating of five
covers only its recorded scope. An old, quiet but working project receives no
blanket activity or age penalty. Stars, download totals, commit counts, repository
size, language and recompilation technique are not inputs.

## Evidence strength

Strength is a reproducible coefficient, not probability of successful play:

| Evidence kind        | Applicable dimensions                        |  Strength |
| -------------------- | -------------------------------------------- | --------: |
| Upstream declared    | Any, as an attributable claim only           |  250/1000 |
| Artifact inspected   | Controls and setup                           |  500/1000 |
| Setup observed       | Setup                                        | 1000/1000 |
| Launch observed      | Setup only; not gameplay or save reliability |  750/1000 |
| Gameplay observed    | Gameplay, stability and controls             | 1000/1000 |
| Performance observed | Performance                                  | 1000/1000 |
| Maintenance observed | Maintenance                                  | 1000/1000 |

Unsupported observation-kind/dimension combinations supply no strength. Future
observations remain inspectable but supply no present strength, duplicate-ID
ambiguity or supersession targets. Unchanged exact-artifact observations do not
decay merely with age. Exact duplicate records are deduplicated; corroborating
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
Future failures remain in that union but affect eligibility only from their
observation time. Correction ambiguity uses the same evaluation-time cutoff.
The shared query retains that union in a bounded extension of the existing host
preference store; the pure engine performs no IO. A failure persists across omission from the latest
collection, elapsed time and a new release/artifact for the same game, edition,
implementation, platform, environment, source profile and route. This means an
unresolved regression prevents a default; it does not assert that every later
artifact is proven broken or create an executable hold.

Only an explicitly accepted, later, exact-artifact gameplay correction can resolve
it for that candidate. A future fix, release note, closed issue, launch-only pass,
new tag or fix on another artifact cannot. Conflicting retained regression IDs
cannot be cleared by one ambiguous correction. Accepted corrections are retained with the original failures. A fix record must
also survive current evidence validation and conflict checks before it can clear
a recommendation exclusion.

## Refresh, failure and unchanged-input behavior

The query consumes current catalog metadata and existing release/update inputs.
Exact direct-manifest and accepted prepared-package identities can be inspected
offline. Other providers are resolved only on explicit refresh or a changed saved
update observation. A saved update is an invalidation signal, not artifact proof;
the existing scoped provider still selects and verifies the release identity.
Its conditional-request, cache, rate and network limits remain in force. Refresh
does not promise an unconditional new network fetch.

Changing quality metadata does not repeat release research. Unchanged release
inputs reuse retained observations; an eight-entry in-memory memo reuses the pure
assessment for identical policy, evidence, context and evaluation time. There is
no new crawler, scheduler, feed, hosted service or persisted derived-score store.
A new artifact receives a distinct identity, so old-artifact evidence stays
inspectable but cannot become current-build gameplay qualification.

Last successful provider resolution, last attempt, upstream publication time and
locally observed offered-identity change time are distinct. Collection failures
retain prior release information with an explicit failed-check state and withhold
a new default. Changed definitions invalidate incompatible release observations.
Historical queries cannot overwrite newer release memory. Compare-and-swap slot
updates and committed readback prevent concurrent refreshes from replacing an
unseen newer observation.

The existing atomic host-preference writer retains at most 64 release slots and
128 accepted failures/corrections per library, within its existing aggregate size
limit. Capacity, unknown versions or corrupt history withhold recommendations;
they never evict critical failures into apparent success or block game operations.
Old host-preference readers preserve unknown extension fields. This changes no
Library database, installed contract or executable-trust authority.

## Followed projects and comparison interaction

Following a project is explicit and local, independent of Saved and installed
choices. The current offered identity is acknowledged when following from the
comparison, so an existing release is not announced as new. An observed changed
identity can produce a notice; acknowledged identities remain deduplicated even
if another release is acknowledged between two observations of the same artifact.
Pause and skip-release choices reuse the existing organization controls. Unfollowing
removes that project's follow state. No background scheduler or notification
service is implied; notices update when the comparison consumes refreshed inputs.
The Discover **Followed** filter selects exact independent project IDs.

Desktop presents the Core status, unknowns, freshness, explicit context and
attributable evidence alongside visible alternatives. Numeric aggregate scores
remain in developer/CLI diagnostics, not universal best-port badges. Existing
keyboard, focus and controller-navigation behavior remains the interaction path.
Late responses from another project/context/library cannot replace the current
comparison. Unsupported optional responses retain the ordinary comparison.

## Bounded calibration and evidence scope

The retained catalog at main `6886393c69588a744789253878ce6962a2a6ea02`
provides real, separate Render96ex and SM64 co-op DX identities related to Super
Mario 64. Their missing source-edition/quality observations must not manufacture
a winner or transfer qualification between implementations. Related implementations
with their own edition data do not supply the missing identity of another project.
SDL Sopwith provides a sparse single-project case; being the only implementation
is not a best-port claim. No new support or gameplay assertion is authored for
these projects by this feature.

Synthetic exact-artifact provider cases exercise a justified winner, comparable
alternatives, insufficient evidence, explicit requirement changes, changed releases,
retained failures and accepted corrections. Named-outcome fixtures cover all six
rubrics. Real CLI JSON and JSONL comparisons use the same Core result. Registered
installation/save fixtures check that metadata and recommendation refreshes cannot
rewrite player state. Browser fixtures exercise keyboard/focus and the production
virtual-controller path; they are not physical-controller or gameplay observations.
Actual execution, independent review and delivery receipts belong on the PR.
