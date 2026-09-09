# Configured upstream observations

The read-only observer supplies inert provider facts to independent definition
delivery (#246). It does not admit a port, download game artifacts, sign or
publish definitions, install updates, or execute upstream instructions.
`portcove-core` remains the sole release-policy authority.

## Scope and cadence

`release/upstream-observer.json` configures the existing `shipwright` catalog
entry and GitHub repository `HarbourMasters/Shipwright`, numeric ID `472575717`.
Changing that repository identity fails closed. The core projection covers
every platform in the embedded definition and game Stable, Beta and Rolling
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
prerelease flag is false; Beta retains its existing stable fallback, while
Rolling requires the catalog's explicit rolling tag. A held newest candidate
does not fall through to an older release and call it current. Missing or
ambiguous platform assets and absent provider SHA-256 claims remain held.
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
