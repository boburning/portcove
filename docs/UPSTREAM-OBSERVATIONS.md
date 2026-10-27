# Configured upstream observations

The read-only observer supplies inert provider facts to independent definition
delivery (#246). It does not admit a port, download game artifacts, sign or
publish definitions, install updates, or execute upstream instructions.
`portcove-core` remains the sole release-policy authority.

## Scope and cadence

`release/upstream-observer.json` retains the reviewed `shipwright` baseline,
GitHub repository `HarbourMasters/Shipwright`, numeric ID `472575717`, and finite
operation budgets. The scheduled coordinator discovers GitHub, GitLab, and fixed direct-manifest sources
from the reviewed embedded catalog. Ports sharing an exact repository use one
provider collection and separate Core projections; channel, platform, artifact,
checksum and adapter policy never transfer between ports. Unsupported providers
remain held with an explicit capability/resume reason; user-prepared sources do
not acquire an executable-update owner through observation.

A new source establishes its numeric identity from fresh primary-provider metadata
or genuinely equivalent fresh trusted upstream-health repository observations.
The baseline persists before further reads. A conflicting identity is held rather
than silently rebaselined. Health facts can save that metadata lookup, but cannot
stand in for complete release headers, candidate assets, Core eligibility or bytes.
Invalid optional health evidence is preserved and falls back to a fresh primary
lookup; conflicting trusted identities remain held.

The `Configured upstream observer` workflow requests observations at 00:17,
06:17, 12:17 and 18:17 UTC. Hosted scheduling can be delayed or skipped; this is
a requested cadence, not a delivery guarantee. The configured baseline retains
its cadence and twelve-hour freshness bound. Catalog sources use durable fair
turns, activity observations and staleness to admit work within the same job.
Unknown activity uses the existing cadence; measured change intervals may defer
quieter sources only inside the freshness margin. Manual dispatch remains
separately attributed and does not prove scheduled execution.

## Bounded interface and policy

`scripts/upstream-observer.mts` reads the configured repository, all release
pages and each release's complete asset collection. It preserves provider
release order, draft/prerelease flags, numeric identities, tags, publication
clocks, asset names, URLs, sizes and provider digest claims. It discards prose
and recommendations. GitHub API redirects are refused; pagination links must
stay inside the exact collection, and asset URLs inside the configured
repository and release. Duplicate IDs, malformed data and partial pagination
fail the run. Every consumed page is revalidated after collection against its
normalized observed facts and pagination links. Unrelated counters and prose
cannot invalidate an otherwise unchanged release observation. The cache still
binds each complete raw API response to its own digest and conditional header.
GitHub offers
no atomic repository snapshot: evidence therefore records the observation's
start/end interval, and any detected change invalidates the entire attempt.

The format-1 observation carries `authority: provider-observation-only`,
`config_sha256`, `facts_sha256`, `facts`, clocks and consumed budgets. Digests
use SHA-256 of UTF-8 compact JSON with recursively sorted object keys and
original array order; the schema uses ASCII keys and safe integer identities.
These hashes bind bytes across components; they are not publisher signatures.

`portcove --json catalog inspect-observation shipwright FILE --repository-id
472575717` verifies a bounded regular observation file against the embedded
catalog and applies the existing core channel/asset rules. It opens no library
and performs no network requests. The format-1 result is exported by
`schema export` as `upstream_observation_report`.

Format 2 adds explicit `channel-candidate-assets` coverage for catalog-scale
observation. It retains every release header in provider order and identifies
which release IDs have complete asset collections. An inert header-only probe
asks the same Core projection for channel candidates; the observer then collects
only those asset collections and revalidates all consumed pages. Missing candidate
coverage produces `release-asset-observation-incomplete`, never metadata eligibility.
Unknown, repeated or foreign coverage IDs and asset payloads outside declared
coverage are refused. Format 1 retains its existing full-asset semantics; existing
clients and the configured Shipwright workflow continue to use that format.

The format-2 configuration binds `asset_scope: core-channel-candidates` and a
`policy_input_sha256` to the maintained selection inputs. A changed Core candidate
set during continuation resets the validation cursor and discards irrelevant
asset pages from the active scope. Retained conditional representations may save
bytes but cannot establish current coverage. This interface adds no artifact
verification, signing or protected admission authority. The catalog coordinator
supplies the selector through the maintained Core inspector. Hosted and protected
acceptance remain distinct from deterministic orchestration fixtures.

Each platform/channel projection retains the latest observed release, its
channel candidate, latest metadata-eligible asset, and hold reasons. Core's
existing prerelease policy recognizes RC/preview tags even when the provider's
prerelease flag is false; Preview (`beta`) retains its existing stable fallback, while
Rolling requires the catalog's explicit rolling tag. A held newest candidate
does not fall through to an older release and call it current. Missing or
ambiguous platform assets and absent provider SHA-256 claims remain held.
The observed host archive flag is retained in the digested facts as maintenance
information; it is not a hold by itself.
The output includes the adapter capability and exact catalog-definition hash.

`latest_eligible` means **core release metadata eligibility only**. Its
`ResolvedRelease` contains the version, channel, publication time and exact
asset URL/name/size/SHA-256 comparison inputs; numeric release/asset identities
are retained alongside it. Provider authentication, artifact-byte verification
and catalog admission are explicitly unassessed. A downstream consumer must
revalidate protected acceptance and current installed-state policy; the observer
does not decide whether a user should update or whether bytes are trusted.

## Checkpoints, interruption and exceptions

Run `node scripts/observe-configured-upstream.mts --cli PATH_TO_PORTCOVE` from
the checkout. The optional `GITHUB_TOKEN` is sent only to the fixed GitHub API
origin. `--config` must stay in the checkout; optional `--state` and `--report`
must stay under its `work` directory without symlink/reparse components.
Defaults are `work/upstream-observer/<config-sha256>/checkpoint.json` and
`report.json`. These are factual runtime cache/evidence, not roadmap state.

Only a complete observation with a matching Core projection advances
`last_complete`. Accepted collection pages and the subsequent semantic-validation
cursor are persisted separately in the same checkpoint after each operation.
They bind the exact configuration, page bodies/digests, ordered validation scope
and observation clocks. Resource exhaustion retains that continuation; a later
admitted batch reconstructs completed work without refetching collection pages
and resumes the exact next read or validation position. Partial facts never
become an eligible observation or advance successful completion clocks.

Each replacement remains atomic and bounded to 32 MiB. A crash before replacement
leaves the prior checkpoint usable. Report export follows checkpoint replacement;
interruption can leave an older report, so compare its facts/completion clocks
and continuation with the checkpoint before reuse. Cache eviction or a whole-job
termination before hosted cache save can still lose unsaved progress; no new
storage service or durability guarantee is introduced.

A detected semantic change restarts the observation, retaining valid conditional
representations as cache evidence. Malformed uncompleted pages are not committed
as replay positions. Cross-release identity conflicts likewise require a fresh
collection rather than permanently replaying invalid facts. Cancellation stops
cached replay and Core projection too. A completed validation awaiting Core
projection retains its original clocks; retrying projection does not manufacture
a fresh provider observation. Freshness uses the earliest validation clock, so
validation spanning stale intervals remains explicitly stale even after all pages
have been accounted for. Legacy format-1 checkpoints remain readable.

An exclusive `<checkpoint>.lock` prevents concurrent local writers. Normal
errors release it; a killed coordinator can leave it behind. Never steal a lock
using age or PID alone. Confirm the exact former coordinator is no longer
running, preserve its checkpoint/report/lock as evidence, then remove only that
verified lock and rerun. Corrupt or foreign checkpoints fail without replacing
them; preserve the failed inputs and start an explicitly new state/report path
for a fresh baseline. Abandoned uniquely named `.next` or observation input
files are not recovered as authoritative data or uploaded as cache.

Failures retain the last complete snapshot but label current upstream state
unknown. Exception identity includes configured port/repository, operation and
failed rule; reports include first/last occurrence, age, recurrence, retry
clock, usable fallback and resume condition. A new exception produces one
failed workflow run; repeats and deferred retries are quiet while retaining
the failed/stale report. A successful observation clears the exception. This
deduplication depends on the retained cache: eviction starts a new baseline.
When core inspection rejects a complete observation, `failed_policy_input` in
that run's report preserves the inert input for bounded offline reproduction;
it never replaces the successful checkpoint or becomes an eligible candidate.
All platform projections remain in the retained snapshot during a provider
failure, and no catalog entry is removed.

## Catalog scheduling and definition-delivery handoff

`node scripts/observe-catalog-upstreams.mts --cli PATH_TO_PORTCOVE` uses the same
source checkpoints, transports, atomic replacement and locks. Its bounded
`work/upstream-observer/catalog/checkpoint.json` records source turns, numeric
identity, scope/freshness, actual provider backoff and Core continuation. Current
per-port catalog inputs and the observed inspector-binary digest bind completion
and both Core cursors. A changed scope cannot inherit old freshness. Completed
header selections and per-port final projections survive runtime interruption
without repeating completed Core calls. Provider and Core clocks are never
manufactured by a later resume.

Request admission uses received provider capacity with a five-percent reserve,
observed request cost, remaining runtime and fair source turns. Unknown quota uses
the existing finite request envelope; it is not assumed available. Quantum/runtime
exhaustion has no provider retry clock. Actual depletion and provider retry
responses defer the shared provider until its reset. A budget-limited source with
progress can receive another turn automatically while capacity remains. A failure
isolates its source. New non-budget exceptions fail the job once; continuing
exceptions and normal continuation remain visible without repeated notifications.

The existing ten-minute hosted job establishes a nine-minute observation deadline
before checkout and build, reserving the final minute for checkpoint and artifact
publication. Accepted page, validation or Core progress can automatically start
another operation within that opportunity; each operation keeps its existing
three-minute admission budget. Request counts and refreshed clocks alone cannot
authorize another batch. Non-budget failures stay visible and are excluded from
further attempts in that job. All batches share one aggregate handoff byte budget;
input or inspector changes stop continuation and preserve earlier evidence. The
standalone command without this explicit hosted deadline remains one bounded
operation.

The legacy `configured-upstream-observation-RUN-ATTEMPT` artifact retains exactly
one `report.json` and its existing consumer/configuration binding. Catalog reports
use a separate, uniquely owned handoff directory for each invocation, exported as
`catalog-upstream-observations-RUN-ATTEMPT`. It contains inert observations and
per-port Core policies for #246's existing supplied-observation → bounded-candidate
path. Historical fallback policies retain their own facts/definition identities
and are explicitly held as unknown current state. No automatic acceptance,
publication, signing or player update eligibility follows from this handoff.

Each source operation admits response bytes, including identity lookups, while
reading. Its finite byte envelope does not cap cumulative catalog-session work:
further bounded operations continue while actual quota and runtime remain.
Failed reads without accepted page/Core progress are not immediately requeued.
The new handoff has the existing sixteen-MiB response envelope as its aggregate
byte budget, with four MiB reserved for the summary and one-day artifact retention.
A handoff that cannot fit the remaining batch stays checkpointed for a later
automatic batch. An individual handoff exceeding the physical response envelope
is explicitly held for a reviewed framed-handoff capability; it is not reported
as export-complete or retried immediately. An
oversized diagnostic summary reports omission counts and the runtime-checkpoint
digest instead of claiming complete exported coverage. The legacy artifact keeps
its existing seven-day retention. Unique handoff directories prevent old outputs
from being uploaded as a later invocation's evidence.

Retired configuration caches are removed only after replacement, under their
existing exact checkpoint locks and validated configuration identities. Current
and last-complete fallback configurations, contended locks, foreign metadata and
unrelated files are retained. Interrupted cleanup is idempotent and resumes from
the controller's retired-configuration journal. Each source/controller checkpoint
retains the thirty-two-MiB byte bound; there is no growing per-revision cache list
or new storage service. Cache eviction and unavailable physical storage still
provide no durability guarantee.

## Resource bounds and availability evidence

The configured per-batch bounds are 256 API requests and ten newly read pages
per collection; retained pages do not consume another collection allowance.
These bounds do not cap the total legitimate collection across resumed batches.
Each batch also retains
4 MiB per response, 16 MiB total response bytes and three minutes of observation.
Transport/server failures allow two retries with bounded backoff; rate-limit
responses defer to the provider retry clock rather than sleep through a job.
Conditional requests count against the request budget. No game artifact bytes
are downloaded. The core input is bounded to 4 MiB, its process to thirty
seconds, and the entire hosted job to ten minutes on one fixed Linux runner.
Workflow concurrency permits one active run per ref. The scheduled upper bound
is four jobs/forty runner-minutes daily, plus explicitly requested manual runs;
actual usage is lower with a warm build cache. There are no agent/model calls.

Only checkpoint/report files enter the observation cache, scoped by config and
ref; interrupted locks and temporary files do not. Reports have seven-day
artifact retention. GitHub manages cache quotas and evicts unused cache entries;
cache availability is not durable storage or an availability guarantee. Each
legacy observation checkpoint/report pair is bounded to 64 MiB before cache
compression. Catalog cache size depends on the observed source workset within the
existing per-file bounds; standard repository CI/billing limits and the account's
$0 stop still apply. No paid fallback or spending setting is introduced. Rust build
caches remain separate from observation evidence.

Same-day compatible-client availability is a 24-hour engineering objective with
an **unknown baseline**. Reports identify UTC upstream publication clocks and
observation intervals, assessed and pending source scopes, unsupported entries
and all holds. Protected acceptance, definition publication and compatible-client
availability clocks remain null, and measured end-to-end samples remain zero
until #246 integrates those stages. Initial historical inventory, unmonitored
upstreams and unintegrated downstream stages are explicit exclusions, not
successful latency samples. Workflow event, source commit, run and attempt are
recorded as execution context; they are not a self-issued trust attestation.

Deterministic fixtures cover pagination, changed/replaced test-asset metadata,
partial reads, durable collection/validation continuation, cancellation, changed
input bindings, cache, rate limits, bounded retries, malformed facts, RC flags,
stale state, exception recovery and coordinator contention. The fixture byte
strings and their SHA-256 changes are test data, not executable game archives.
Core and compiled-CLI tests prove the shared policy and offline boundary.
Scheduled live observation, actual artifact lifecycle and gameplay evidence
must be recorded separately in the owning issue and linked run artifacts.

## Catalog location reachability

`scripts/check-catalog-repositories.mts` is the separate read-only catalog
location collector. `--json` emits its format-3 diagnostic report. The
`upstream-health.yml` workflow runs it through
`scripts/upstream-health-monitor.mts`, which selects a bounded batch, compares
retained observations and publishes a summary. This workflow is diagnostic and
is not a required merge check; the deterministic catalog checks remain required
under [QUALITY](QUALITY.md#required-hosted-baseline).
The workflow's format-1 monitor report embeds the format-3 collection alongside
batch selection and inventory history.

The inventory includes declared GitHub/GitLab repositories, current project
locations, DirectManifest artifact locations and locatable historical
qualification identities. Project and acquisition roles are explicit, so changing
a project's URL does not discard an older release repository. Shared locations
retain every associated port's identity and obligations. User-prepared entries
retain upstream coverage; externally prepared files are not inspected.

Hosted metadata records numeric repository identity and archive state. GitLab
may omit archive state; the report then records `archived: null`. Direct artifact
and other project locations use credential-free HEAD requests. Matching declared
size establishes endpoint reachability only. Historical release metadata retains
exact refs and provider digest claims, with incomplete or contradictory asset
collections remaining unknown. Metadata and HEAD never verify accepted bytes.

The report separates two outcomes. `collection_status: complete` means the
selected observations completed; a collected 404, redirect or identity change can
still describe an actionable condition. Authentication, rate limits, transport,
timeout, malformed metadata and budget failures leave collection partial. The
separate `outcome`, `accounted_for`, classification and degradation fields retain
the observed condition and its disposition. The workflow monitor fails on partial
collection or invalid coordinator inputs, while a complete observation of an
upstream problem remains visible in its report and summary. The standalone
checker retains its stricter exit based on condition `outcome`.

A 404 remains inaccessible-or-missing; it cannot establish deletion, retirement
or succession. HTTP 301, 302, 303, 307 and 308 remain `provider-redirect`, without
following the destination. No Location header, signed URL, response prose,
credential or raw transport-error detail enters the report. Archived repositories
remain reachable and create no hold by themselves. Original reachability,
lineage, accepted-byte obtainability, preservation, holds and qualification stay
separate; this report replaces none of their authorities. See
[read-only disappearance reporting](CATALOG.md#read-only-disappearance-reporting).

## Health inputs and reviewed accounting

`scripts/upstream-health-inputs.mts` defines the versioned health projection.
Project and acquisition declarations, maintenance state, adapter/platform inputs
and exact direct pins affect health selection; each port's historical
qualification and validated authoring lineage also affect its scope and freshness.
The lineage projection binds listing ID/project URL/canonical issue and the
retained lineage records through the shared authoring validator. Presentation fields,
including artwork, names and summaries, and unrelated runtime settings do not
invalidate these observations or their reviewed bindings.

The protected `.github/upstream-health-accounting.json` uses format 2 with an
explicit input version. It preserves the 35 existing reviewed release-pin
identity bindings. Each artifact binding covers the port ID, platform, provider
and that exact URL/version/size/SHA-256, independently of project artwork,
project URL and other platforms. Endpoint conditions bind an explicit `project`
or `acquisition` role, provider/repository, relevant declaration and maintenance
state, plus the exact operation, HTTP status and rule. A repository 301 also
requires its reviewed numeric redirect identity from bounded JSON metadata.
Every shared port must have the applicable reviewed scope. Changed conditions
remain actionable; a hash match cannot approve a new endpoint or identity.

Tests distinguish current direct pins from retained bindings whose catalog ports
now use dynamic GitHub acquisition. The historical artifact projections come
from catalog commit `3305a4707d5b902fe5565608c3330cecc8b701da`; the test fixture
retains its source hashes and grants no current acquisition or identity authority.
Current direct pins must still match current inputs, while retained cases require
the exact historical port/platform binding and the current repository/platform
declaration. Missing, duplicate or unused projections fail. All reviewed policy
facts and endpoint/source-archive checks remain in place.

The retained Star Fox `kandowontu/starfox-enhanced` 404 is an acquisition-endpoint
condition. Its separately reviewed successor decision and current project
location are reported from the authoring lineage records. The old endpoint stays
unknown; neither the known 404 nor the accepted successor restores the historical
release, promotes a URL or verifies bytes. Lineage fields retain authoring facts
available when that port is observed, and cached reports retain that observation's
facts. They are not new lineage decisions or a continuously refreshed authority.
An authored lineage change invalidates that port's prior freshness and selects
it for observation even when the generated runtime catalog is unchanged.

A normal GitHub release-download 302 needs no new exception record. For an exact
catalog-declared GitHub pin, the collector may make three fixed API reads for its
repository, tag and complete asset collection. Exact repository/URL scope, tag,
asset name, size and provider SHA-256 claim must match; capped, partial, ambiguous
or contradictory collections fail. Without an existing reviewed numeric binding,
the result is `provider-reported-pin-observed; identity-unbound;
destination-unknown; bytes-unverified`. Returned numeric IDs are observed facts,
not approved identities. Existing reviewed repository/release/asset IDs and
normalized fact hashes are still enforced, including when reviewed and unbound
pins share a location; they cannot fall back to weaker generic accounting.
Their matching result remains `provider-reported-pin-present`.

Both results account only for the metadata monitoring obligation. The HEAD 302
remains unknown, adds no reachable endpoint and retains degraded output. The
collector follows no redirect and downloads or executes no artifact. Unchanged
routine metadata conditions remain in JSON and are counted separately in the
summary; material changes to observed pin identities remain visible as new or
changed conditions. Metadata assessment recovery is reported separately from
endpoint recovery and does not establish destination availability.

Optional reviewed source-archive bindings remain a distinct path for literal
GitHub `/owner/repository/archive/<40-lowercase-hex>.zip` URLs. They bind the exact
artifact scope, numeric repository identity and immutable commit/tree/ordered
parent facts. Two fixed no-follow API reads may establish
`provider-reported-commit-present; destination-unknown; bytes-unverified`.
Commit identity supplies neither an archive size/digest claim nor accepted bytes.
The policy bounds endpoint exceptions at 64 and retained artifact bindings at
8,192; normal release-download observations do not consume exception records.
Format-1 policy fixtures retain their earlier interpretation.

## Bounded batches and retained history

The coordinator validates the complete inventory and accounting policy before
network work. It selects ports oldest-attempt-first and admits at most one
individually oversized port alongside normally fitting scopes. Within that
scope, locations rotate fairly across owners and oldest actual attempts. Each
operation permits at most **320 requests**, **512 newly assessed locations**,
three minutes, fifteen seconds per request, one MiB per response and sixteen MiB
consumed response bytes. Compatible completed locations may be replayed from the
validated checkpoint without spending another operation slot or request; their
original clocks remain unchanged. Coverage exceeding an operation envelope is
partial until every location has an applicable completed observation.

Each network-capable location reserves one request, each qualifying release-pin
location up to three additional metadata reads and each reviewed source archive
up to two. Unproven reuse is never a speculative budget credit. Successful
same-operation repository metadata can serve identical endpoints. Actual GitHub
and GitLab quota headers preserve a five-percent provider reserve (at least one
request); provider-wide reset and Retry-After clocks persist across automatic batches and
resumed invocations and defer related reads without
blocking unrelated providers. Unknown capacity retains the finite request
bootstrap. Failed reads are not retried within the same logical job.

The standalone full collector keeps its strict preflight refusal when the
selected logical inventory exceeds either historical ceiling. The maintained
workflow uses incremental admission instead: completed locations are checkpointed
atomically after each operation, under the existing lock and 16 MiB envelope.
Continuation binds the accounting policy and exact per-owner health contracts.
Changed contracts discard incompatible reuse; corrupt or future evidence fails
closed. An interrupted process can resume accepted locations without resetting
numeric identity baselines. A PR cannot write trusted history.

The ten-minute hosted deadline remains. A deadline anchored at the first job step
allows up to nine minutes for preparation and automatic bounded collector batches,
leaving one minute for history/artifact retention and cleanup. Observed main run
40462280230 used roughly twelve seconds for preparation and two seconds for
retention. The separate RetComM check retains at most two sequential 15-second
request deadlines per title (titles run concurrently); selected IDs accumulate
across all health batches. This reserve is operational headroom, not a claimed worst-case service
guarantee. The coordinator drains while work and productive capacity remain,
without a fixed logical batch count. It persists every completed batch, retains
failed conditions, and stops on exhausted runtime, provider backoff or lack of
progress. Later runs resume the same authoritative history. Summaries distinguish
the final batch from aggregate session API consumption and never claim an atomic
global health snapshot or verified artifact bytes.

`work/upstream-health/checkpoint.json` is a bounded history of per-port attempts,
location observations and incidents, not a fresh full-inventory report. Only
validated main push, scheduled or manual executions of this repository's workflow
may replace it and save the main cache. PRs may read that comparison history but
never update it. The checkpoint records execution identity, health and policy
hashes, observation clocks, collection status and incident material facts. It is
bounded to 16 MiB and written atomically under an exclusive lock. Historical
cardinality does not impose a second limit inside that physical envelope. Cache loss starts a new comparison baseline; cache retention
provides no durability or observation-frequency guarantee.

The report states the total inventory, ports assessed this run, deferred and
unassessed ports, and recent complete, recent partial, stale and unmonitored
counts. Freshness is 24 hours and requires matching per-port health inputs and
accounting policy. Main pushes skip matching recent complete observations;
partial attempts remain due. Scheduled and manual runs reconsider their requested
inventory and prioritize older attempts. Ports deferred entirely by time/request
budgets or rate limits retain their earlier scheduling position for later batches.
The daily schedule requests 09:23 UTC, subject to hosted scheduling delays.
An earlier observation never counts as a current live probe. Retained conditions
identify whether they were observed this run and whether their evidence is stale.

Incident keys bind the port, location, operation, rule and relevant observation
contract. Unchanged conditions retain first-seen time and recurrence without a
new notification; material changes and freshly observed recovery are separate.

Shared location observations retain all applicable catalog port identities within
the existing 16 MiB history envelope, independently of the former 4,096-ID count.
The immutable inventory compiles its port-identity lookup once. Resource admission
uses indexed membership for growing selected worksets rather than repeatedly
scanning every catalog record for every selected ID. This changes neither the
request estimate nor endpoint ownership, coverage or trust semantics.

The checkpoint keeps a separate `incident_history` within its existing 16 MiB
physical limit. An inconclusive 503
does not erase a prior 404: a later matching 404 retains its original first-seen
time and recurrence. Only the latest conditions appear as current in `port_health`
and the summary. History is removed on matching endpoint or metadata assessment
recovery, replacement of the observed location contract, or port removal. The
whole-port health hash controls freshness and scheduling; per-location contracts
control incident continuity, so a platform change can trigger a new probe without
resetting an unchanged endpoint incident.

The workflow summary separates fresh, complete routine provider-metadata
conditions (quiet but retained in JSON) from stale and partial conditions that
still need evidence. It prioritizes changed conditions and unaccounted failures
before stale and partial acknowledged history, and includes each visible port/provider/location, applicable release
reference, failed rule and HTTP status, metadata assessment, first and last
observation clocks, occurrence count, observed time span, collection freshness,
retry clock and existing resume condition. Occurrences count distinct matching
observations; their time span is **not** uninterrupted outage time. A condition
not selected in the current batch remains explicitly retained rather than
freshly verified. The human summary is capped at 20 rows; the complete bounded
JSON report remains the diagnostic record. Stale accepted-provider conditions
cannot be silently hidden by a prior metadata-accounting result.

This is presentation-only triage of location observations. It does not infer
an affected platform/variant when none was measured, available fallback,
expected-version-vs-same-identity byte replacement, installation safety or an
authorized hold/recovery decision. Those require their existing exact artifact,
Core operation, acceptance and protected policy authorities. Metadata-only
success or recovery is not verified client download or gameplay qualification.

Per-observation hashes allow unrelated catalog edits to retain comparison history.
Prior numeric repository identity remains a comparison baseline, including after
its freshness window; it never authenticates ownership or continuity. The
standalone `--previous-report=PATH` accepts bounded comparison evidence and writes
no state; format-2 compatibility still requires its matching whole-catalog hash.

A partial collection retains its report and, on trusted main executions, its
checkpointed failure history before returning an error. Input/checkpoint or
coordinator validation failure emits a failure report and preserves the prior
checkpoint as history. Reports and summaries are uploaded after failed steps
unless the job is cancelled, with seven-day artifact retention. The workflow
writes no issues, qualifications, catalog entries, holds or publication state.

## Pull-request applicability

The planner verifies the exact base, head and checkout commits, merge parents,
trees, raw diff and checked-out catalog. For GitHub's merge checkout it compares
the actual first-parent target catalog with the merge result and verifies that
the second parent is the requested PR head. It checks ancestry when the event's
base SHA has advanced; that event value is not substituted for the actual target.
An exact-head checkout uses its verified merge base. Invalid refs, parentage,
readback or catalogs fail scope discovery.
Changed per-port authoring files are read at those same comparison commits, with
their lineage projections checked against the working files and catalog identities.

Semantic health changes select their stable port IDs across the current per-port
catalog layout and mixed changes, including lineage-only authoring decisions.
Artwork-only or other presentation-only edits
select no live probes; unrelated files in a mixed PR do not widen its scope.
Relevant shared tools, policy or workflow changes, schema changes, removals and
uncertain/nonregular diffs conservatively request the full inventory, still
subject to the coordinator's batch budget. Unselected ports remain explicitly
unassessed by that run. Main pushes, scheduled and manual runs request full
inventory monitoring over those bounded batches.

RetComM live comparisons use the PS1 IDs actually selected for the batch;
deterministic offline mapping validation in required catalog CI retains the
complete catalog. Release checks and standalone invocation retain their full
scope. A no-probe PR result establishes applicability only. It is not a healthy
inventory, accepted artifact or exception to required hosted validation.

### Growing monitoring inventories

The monitor retains fair oldest-attempt rotation across bounded collector runs.
The collector's 320-request and 512-new-location envelopes bound one operation,
not the logical catalog or retained cross-run history. Checkpoints use their
existing 16 MiB physical envelope rather than separate 4,096-port, 8,192-record
or 512-incident historical count ceilings. Input catalogs are bounded to 4 MiB,
including programmatic invocations. Oversized physical inputs remain refused;
no history is silently truncated to claim complete coverage.

Each invocation validates and snapshots the complete inventory once for request
estimation. Scoped estimates retain shared-location identities and reviewed
accounting semantics. Per-port freshness hashes likewise reuse one catalog
projection; hash semantics and legacy checkpoints remain unchanged. These local
optimizations do not equate repository reachability with release eligibility,
and partial batches continue to report global health as unassessed.

### Current Core projection of fresh provider facts

A changed Core binary or catalog policy invalidates prior eligibility. When the
provider configuration is unchanged, the coordinator can reuse the prior complete
provider interval and recompute every port's current Core selection and policy.
The exact current catalog input is inspected once by Core, and every projection
must match the resulting normalized per-port definition hash. An older embedded
catalog cannot claim the reviewed input's eligibility. Scope identities bind a
versioned validated contract and normalized definition hashes, so pre-guard
completion and partial cursors are automatically reprojected. Retained per-port
policies are also checked before cursor reuse. The coordinator reconstructs
repository, complete release headers and covered asset collections
from the existing bounded page proofs, verifies their identities/digests against
the complete observation, and retains the original oldest validation clock.
Reprojection never makes an old provider fact fresh. Normal cadence/expiry still
requires provider checks.

Current Core must select candidates from the complete header universe, and every
selected release must have complete validated asset coverage. Missing coverage
returns to the ordinary incremental collection path. Corrupt or missing page
proofs refuse reuse; changed known partial pages, restarted collections and
expired facts use ordinary observation. Old policy and acceptance output cannot
become current eligibility. Current per-port projection cursors remain durable,
including while provider capacity is unavailable, and cancellation refuses a
projection before it is retained. Core executable object/size/time identity is
checked around hashing and each inspection so a changed executable cannot inherit
the invocation's policy identity. This adds no provider, queue, database, artifact
trust or protected admission authority.

Catalog proposal receipts retain the legacy field-order `definition_sha256` and
add `observation_definition_sha256`, the normalized recursively sorted identity
shared with Core observation projections. Observation binding requires this
explicit canonical field; the two hashes are not interchangeable. Both remain
inert declarations, without trust or publication authority. This preserves old
proposal consumers while preventing serialization-order mismatches from holding
otherwise valid current Core projections.

### Additional reviewed providers

The same fair catalog queue and atomic checkpoint schedule GitLab projects and
fixed direct manifests. GitLab uses actual project, tag, release-link and
package-file identities. Its numeric project baseline persists before release
collection; same-path project recreation is held for source reconciliation. Public GitLab metadata may omit archive state. Omission/null is reported as unknown, matching runtime resolution; it never becomes an active/archived assertion or weakens project identity. Malformed known archive values remain refused.
Explicit current-page, page-size and terminal/advancing next-page proofs are required before a GitLab collection page is accepted. Missing pagination metadata remains incomplete. Conditional 304 responses preserve body reuse only with matching page coverage; a changed or missing page boundary requires a separately admitted unconditional read before validation can advance. Legacy generic read proofs remain historical while a clean version 2 proof is collected with the retained numeric baseline.

Complete release/package pagination and selected-version package-file records
feed Core's shared channel, native archive and checksum rules. The observer
never invents GitHub IDs for another provider. Ambiguous registry uploads remain
held when the collected facts cannot identify one exact file. Contradictory
description and registry checksums remain held; metadata observation does not
override runtime checksum precedence.

Direct manifests observe the exact reviewed pinned endpoints with bounded HEAD
requests and credential-free HTTPS redirect handling. They retain the reviewed
version, channel, platform, size and checksum. A fixed URL is not a declared
future-version stream: a different release still needs reviewed manifest data.
Unknown lengths do not verify bytes; changed sizes and unavailable endpoints
produce explicit Core holds. No image or executable artifact is downloaded.

Provider reads retain exact ordered prefixes and conditional validation positions
inside the existing catalog checkpoint. Changed reviewed scopes retain their
prior evidence and start a clean prefix; changed provider facts discard the
incomplete current collection before a fresh attempt. Core projections retain
per-port progress bound to exact definitions, facts and executable identity.
Quota evidence and Retry-After are isolated by HTTPS origin with a five-percent
reserve (at least one request). Only typed positive pre-admission budget
exhaustion permits another automatic turn; a last-request transport failure
never becomes retry permission. Individual requests, operation quanta, response
bytes, runtime, checkpoint bytes and the Core input envelope remain finite.

The offline CLI inspects these inputs with `catalog inspect-observation PORT FILE --provider-facts`. GitHub keeps its required `--repository-id`; conflicting modes are usage errors.

Version 3 inert provider observations and version 2 provider reports enter the
same bounded #246 artifact handoff with per-port current Core projections.
Reports distinguish observed releases, metadata eligibility and endpoint
availability from verified artifact bytes, protected catalog admission and
player update eligibility. The latter three remain unassessed. GitHub's existing
formats 1/2 and report format 1 remain compatible; no workflow per port, service,
account, signing authority or production activation is introduced.
