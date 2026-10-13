# Configured upstream observations

The read-only observer supplies inert provider facts to independent definition
delivery (#246). It does not admit a port, download game artifacts, sign or
publish definitions, install updates, or execute upstream instructions.
`portcove-core` remains the sole release-policy authority.

## Scope and cadence

`release/upstream-observer.json` configures the existing `shipwright` catalog
entry and GitHub repository `HarbourMasters/Shipwright`, numeric ID `472575717`.
Changing that repository identity fails closed. The core projection covers
every platform in the embedded definition and game Stable, Preview and Rolling
channels; unsupported channels remain visible with a hold reason. These game
channels are distinct from the application's Stable/Preview channels.

The `Configured upstream observer` workflow requests observations at 00:17,
06:17, 12:17 and 18:17 UTC. Hosted scheduling can be delayed or skipped; this is
a requested cadence, not a delivery guarantee. A report is stale after twelve
hours without a complete observation. Every other catalog entry is explicitly
unmonitored. Manual dispatch is available for diagnosis and produces separately
attributed evidence; it does not prove scheduled execution.

## Bounded interface and policy

`scripts/upstream-observer.mjs` reads the configured repository, all release
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

Run `node scripts/observe-configured-upstream.mjs --cli PATH_TO_PORTCOVE` from
the checkout. The optional `GITHUB_TOKEN` is sent only to the fixed GitHub API
origin. `--config` must stay in the checkout; optional `--state` and `--report`
must stay under its `work` directory without symlink/reparse components.
Defaults are `work/upstream-observer/<config-sha256>/checkpoint.json` and
`report.json`. These are factual runtime cache/evidence, not roadmap state.

Only a complete observation with a matching core projection advances the
checkpoint. Each replacement is atomic and bounded to 32 MiB. A crash before
replacement leaves the prior checkpoint usable. The checkpoint contains the
complete observation, validated conditional cache and projection in one file;
the report is a derived export written afterwards. Interruption between these
two writes can leave an older report. Compare its facts hash and completion
clock with the checkpoint and rerun; never treat that old report as current.

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

## Resource bounds and availability evidence

The configured per-run bounds are 256 API requests, ten pages per collection,
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
saved observation checkpoint/report pair is bounded to 64 MiB before cache
compression; standard repository CI/billing limits still apply. Rust build
caches remain separate from observation evidence.

Same-day compatible-client availability is a 24-hour engineering objective with
an **unknown baseline**. Reports identify UTC upstream publication clocks and
observation intervals, one monitored repository, unmonitored entries and all
holds. Protected acceptance, definition publication and compatible-client
availability clocks remain null, and measured end-to-end samples remain zero
until #246 integrates those stages. Initial historical inventory, unmonitored
upstreams and unintegrated downstream stages are explicit exclusions, not
successful latency samples. Workflow event, source commit, run and attempt are
recorded as execution context; they are not a self-issued trust attestation.

Deterministic fixtures cover pagination, changed/replaced test-asset metadata,
partial reads, cache, rate limits, bounded retries, malformed facts, RC flags,
stale state, exception recovery and coordinator contention. The fixture byte
strings and their SHA-256 changes are test data, not executable game archives.
Core and compiled-CLI tests prove the shared policy and offline boundary.
Scheduled live observation, actual artifact lifecycle and gameplay evidence
must be recorded separately in the owning issue and linked run artifacts.

## Catalog location reachability

`node scripts/check-catalog-repositories.mjs` is the separate read-only location
checker used by `upstream-health.yml`. `--json` emits its format-2 diagnostic
report instead of human lines. Its inventory includes each distinct declared
GitHub or GitLab repository, original project location, DirectManifest artifact
location and locatable historical qualification identity. Changing the release
provider does not discard the original upstream. User-prepared entries retain
upstream coverage; externally prepared files are not inspected.

Hosted metadata records stable port IDs, observed numeric repository ID and
archive state. GitLab public metadata may omit archive state; a matching reachable
repository then carries `archived: null`, not an inferred false value. Explicit
malformed archive values are rejected. Direct artifacts and other project
locations use credential-free HEAD requests. A matching declared size establishes
location reachability only; metadata and HEAD never verify accepted artifact bytes.
Historical release metadata preserves exact refs and provider-reported digest
claims, with incomplete or contradictory asset collections remaining unknown.

Complete means every inventoried condition is accounted for, not that every port
is installable. Existing reviewed catalog maintenance declarations account for
an unavailable original location only at their stated scope and retain degraded
output. They cannot suppress missing artifacts, new identity/access failures or
an unclassified shared location. Archived repositories remain reachable and do
not create a hold by themselves. Original reachability, unresolved lineage,
accepted-byte obtainability, preservation, holds and retained qualification stay
separate; this report cannot replace the configured observer or Core authority.
See [read-only disappearance reporting](CATALOG.md#read-only-disappearance-reporting)
for the full contract and the existing #124/#139 Starfox continuity incident.

Failures retain a nonzero exit and the complete coverage denominator. Transport
errors, timeouts, malformed/oversized metadata, mismatched identities, HTTP access
failures and provider failures remain unknown. A 404 is inaccessible-or-missing;
it cannot establish deletion, retirement or succession. GitHub documents that
improperly authenticated private resources can return 404:
[REST troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api?apiVersion=2022-11-28).

Requests observe redirects manually without following them. HTTP 301, 302, 303,
307 and 308 produce `provider-redirect`, retaining the original response status
and an identity-review resume condition. Redirects remain unknown; destination
reachability or continuity is not inferred. Unclassified redirects remain
unaccounted and incomplete. No
Location header, potentially signed redirect URL, raw response prose, credentials
or transport-error details enter the report, and credentials are never forwarded.
A redirect is therefore distinguishable from a failed transport without trusting
another location or changing the catalog.

The protected `.github/upstream-health-accounting.json` binds the owner-reviewed
monitoring dispositions proposed in #247 comment 6082358982. It grants no catalog,
lineage, artifact, hold or publication authority. Its original-location conditions
bind exact port contracts (excluding summary), original location, operation,
HTTP status and rule. A repository 301 additionally requires the exact documented
numeric redirect identity in bounded JSON metadata; that endpoint is never followed.
The Starfox 404 remains inaccessible-or-missing with unresolved continuity, not
retirement. Every shared port must have the matching reviewed scope. Changed,
missing, malformed or unclassified conditions retain a nonzero outcome.

For each exactly matching reviewed GitHub direct pin record, a HEAD 302 may trigger three bounded
fixed API metadata reads derived from the declared repository/tag/filename. These
validate the reviewed repository, release and asset IDs, complete uncapped asset
collections, exact uploaded asset URL/name/size/provider digest and retained asset
facts. They reuse the configured observer's strict metadata normalization through
a narrow helper; unrelated release enumeration and redirects remain prohibited.
Missing or changed facts, API redirects, partial/capped/ambiguous collections,
rate limits and access failures remain unknown and unaccounted.

An exact match is `provider-reported-pin-present; destination-unknown;
bytes-unverified`. It accounts for this reviewed metadata monitoring obligation,
never the downstream download or accepted bytes. The original HEAD 302 remains
visible and unknown, contributes no reachable endpoint, and keeps degraded output.
Original-location accounting likewise retains unknown availability and lineage.
The report digests its accounting policy and material condition facts; changed
conditions produce a new material incident requiring review. Collection counts
distinguish network-attempted locations, reused repository observations and total
network requests. A complete bounded HTTP 200 repository response may serve the
pin check and identical original-location endpoint within the same collection;
all per-pin and original-location identity checks still run. Failed, redirected,
partial or malformed reads are not cached. The map is discarded after collection
and never imports prior-report metadata. Old and relocated endpoints stay distinct.
The dated #1732 89-port observation completed with 125 requests under the former
128-request bound. Its cache-boundary repair remains valid. After DKC3 historical
release coverage and Diablo admission, the October 11 inventory contains 90 ports,
106 locations and eleven matching reviewed pin records. Its successful metadata
path requires `106 − 9 + 33 = 130` requests; the failed 128-request full collection
and its two unattempted historical-release records remain retained evidence.
A passing monitor means accounted conditions, not installability.

An optional bounded `--previous-report=PATH` supplies comparison evidence. A
matching canonical catalog hash and nonfuture report no older than 24 hours may
supply notification comparison/backoff; an older matching structural snapshot
retains only its repository-ID baseline. A different observed numeric ID fails
closed, rather than silently replacing that baseline. The report does not
authenticate historical ownership or turn a reused name into continuity evidence.
Repeated unchanged incidents keep their first-seen time and stable condition key
without repeated notification; their unknown status and failure exit remain.
Fresh recovery is reported separately. Current availability is always observed
within the attempt, except explicitly deferred rate-limit requests.

Before any network I/O, the collector validates the complete inventory, selected
scope and accounting policy, then derives a conservative request budget. Each
network-capable location reserves one call; each matching reviewed pin record
reserves three additional conditional metadata calls. Unlocated historical
identities require no request and remain unknown. Successful cache reuse,
redirects, failures and backoff are never speculative budget credits. The report
separately records conditional reuse opportunities and actual consumption.

Each run receives only that derived budget, bounded by a separately fixed **256
request hard ceiling** in source. No caller, environment or catalog can override
or automatically increase the ceiling. Today's conservative forecast is
`106 + 33 = 139`; the fixed ceiling does not grant today's run 256 calls.
A forecast above 256 refuses **all** network work before collection, sets the
admitted-call budget to zero and reports global health unassessed. Every selected
location and port stays in the complete denominator, unknown and unattempted;
static missing-release/conflicting-identity reasons remain distinct from deferred
network obligations marked budget. Outside-scope ports remain explicitly
unassessed. Overflow requires reducing legitimate obligations or a separately
reviewed capacity redesign; partial successful collections cannot establish full
health.

This openly doubles the former 128 ceiling while preserving inventory-sized
execution. The existing `release/upstream-observer.json` 256-request/three-minute/
16-MiB envelope supplies a repository resource precedent, not quota proof. Its
separate four-MiB response and retry allowances are not adopted here. At the dated
October 11 accounting inventory's fifteen of 32 entries, seventeen additional
typical pins at five conservative calls each would forecast `139 + 85 = 224`;
other history/platform/location growth can still overflow. This arithmetic grants
no admission authority or guaranteed completion.

The fixed ceiling represents at most 25.6% of the documented 1,000-request hourly
`GITHUB_TOKEN` repository allowance; today's forecast at most 13.9%. Sequential
GET/HEAD collection remains below the documented concurrency and ordinary-point
limits, but shared quota and secondary limits can still refuse it. Preserve
provider backoff rather than acquire credentials, retry or buy capacity. See
[GitHub REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
Existing public standard-runner execution is
[no-charge](https://docs.github.com/en/billing/concepts/product-billing/github-actions);
that does not establish storage headroom. No cadence, runner, retention or paid
service expansion accompanies the request ceiling change.

Collection retains zero retries, three minutes total, fifteen seconds per
request, one MiB per response and sixteen MiB of consumed response bytes. The
stream is bounded before JSON parsing; the chunk crossing a byte limit is counted
but not retained. A detected rate limit stops requests to that provider, records
its retry time and leaves deferred identities unattempted and unknown. Other
providers may continue within the admitted shared budget. Budget exhaustion
preserves every unattempted identity. Prior reports remain bounded independently
at 512 observations and 512 incident entries per port, with the existing two-MiB
regular-file admission bound. These diagnostics write no incidents and transfer
no authority.

## Pull-request applicability

The upstream-health workflow derives PR scope from exact base, merge-base, head
and checkout commits, retaining the complete Git diff and catalog digests in its
log. Only regular modifications of the existing authoring/generated catalog pair
can select narrowly. The comparison excludes port summaries only; other port
contract changes select that stable port ID. Root/history changes, removals,
mixed or uncertain diffs, tooling, workflow and policy changes retain full scope.
Missing or invalid refs, catalogs or diff discovery refuse a narrower check.
An interacting synthetic checkout also retains full scope. This transition's
own checker/workflow changes therefore cannot use narrow selection.

Main pushes, scheduled runs and manual runs retain full-catalog monitoring.
For a verified summary-only PR, the report explicitly says no changed upstream
health inputs and no live requests, with global health unassessed. This is
applicability, not a healthy inventory. A selected port's unknown endpoint still
fails; shared endpoint facts retain all associated port identities and maintenance
declarations. Other ports remain explicitly unassessed by that PR collection.
RetComM live comparisons use the same selected PS1 IDs; deterministic offline
mapping validation in required catalog CI always retains the complete catalog.
Release checks and standalone invocation retain their existing full scope.

The workflow's protected applicability change requires existing pre-change full
fresh audit and exhaustive exact-head hosted qualification plus independent
review. It supplies no exception to an existing failed run, and never changes
catalog maintenance, accepted bytes, lineage, holds or qualification states.
