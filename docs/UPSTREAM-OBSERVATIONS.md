# Configured upstream observations

The read-only observer collects facts from providers for independent definition
delivery (#246). It records its findings as data. It never admits ports,
downloads game artifacts, signs or publishes definitions, or installs updates.
It never runs instructions from a provider. `portcove-core` owns release policy.

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

The `Configured upstream observer` workflow requests observations hourly at
minute 31 UTC, away from the daily 09:23 upstream-health run and the :17 and :43
schedules that share the repository token. Scheduled run 42484849060 on
2026-11-08 used 744 requests and reported 4,026 remaining, so its observed hourly
allowance was about 5,000. This is dated evidence, not a guaranteed limit. Hosted
scheduling is delayed or dropped often on this repository: on 2026-11-08 the
hourly `:43` cleanup schedule started about every four hours and the daily 09:23
health run started near 16:00. This is a requested cadence, not a delivery
guarantee, so each hosted run carries more work instead of relying on frequency. The configured baseline keeps its twelve-hour
freshness bound and receives a turn in every opportunity. Catalog sources use durable fair
turns, activity observations and staleness to admit work within the same job.
Unknown activity uses the existing cadence; measured change intervals may defer
quieter sources only inside the freshness margin. Manual dispatch remains
separately attributed and does not prove scheduled execution.

## Bounded interface and policy

`scripts/upstream-observer.mts` reads the configured repository, all release
pages and each release's complete asset collection. It preserves provider
release order, draft/prerelease flags, numeric identities, tags, publication
clocks, asset names, URLs, sizes and provider digest claims. It discards prose
and recommendations. Metadata API redirects are refused; pagination links must
stay inside the exact collection, and asset URLs inside the configured
repository and release. Duplicate IDs, malformed data and partial pagination
fail the run. Every consumed page is revalidated after collection against its
normalized observed facts and pagination links. Unrelated counters and prose
cannot invalidate an otherwise unchanged release observation. New cached pages use
the explicit `observer-facts-v1` representation: only the exact repository,
release and asset fields consumed by these normalizers are retained. Release
notes, author/uploader objects, unrelated counters and unused embedded assets are
removed. This is a semantic projection, not lossless raw-response storage.
The original `sha256` remains the canonical parsed-body identity and historical
provenance; it cannot independently verify the removed raw body. The separate
`facts_sha256` verifies the retained body, with its exact versioned field schema.
ETags, Link headers, array order/count, accepted observation facts, cursors and
clocks remain unchanged. Reuse compares normalized facts as well as original page
identities and Link headers, including mixed raw/projected proofs. Asset pages
remain bound to their matching release ID/tag. Historical conditional pages are checked under their original
complete-cache or restart graph; replacement responses still match the current
collected release headers. A changed fact schema needs a new
projection revision and cannot silently gain evidence from an older projection.
Legacy raw pages remain readable and their original body hashes and input bounds
are checked before projection. Fresh responses are fully read, charged and
validated before unused fields are removed. Independent declared-pin metadata
checks, including embedded-asset completeness, retain their original raw inputs.
Dedicated GitHub release asset pages can include a failed upload with state
`starter`. The observer retains that row in `observer-facts-v2` page evidence
and excludes it from package facts and selection. Pages without these rows
continue to use `observer-facts-v1`. A later upload can change the package facts under
the same release identity. Unknown states and malformed rows still fail
validation, and exact pins still require an uploaded asset.
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
asks the same Core projection for channel candidates; the observer collects
those asset collections and asks Core again until the current candidates are
covered. NativePortable uses runtime's platform-stream predicate: a complete
Linux-only player release can expose the preceding Windows candidate. Uncollected
assets cannot establish another platform's stream. Each continuation retains
the existing request, byte and time budgets and revalidates all consumed pages.
Missing candidate
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
Rolling requires the catalog's explicit rolling tag. A held newest applicable candidate
does not fall through to an older release and call it current. Missing or
ambiguous platform assets and absent provider SHA-256 claims remain held.
When the runtime's supported checksum policy can supply the missing digest,
Core returns exact release/asset dependencies rather than a manual task. The
collector fetches those asset texts through GitHub's asset API, retains bounded
UTF-8 facts and revalidates every used text. Both inspector and runtime share
exact `<asset>.sha256` precedence, aggregate filename matching, all-source
agreement, eight-source and one-MiB-per-source limits. Incomplete or conflicting
text cannot produce an eligible asset.

Checksum transport alone permits at most three redirects to the fixed GitHub
asset delivery hosts. Each physical request consumes existing admission and
each hop uses the remaining deadline. Operation-owned redirect progress resumes
even with a one-request source quantum; API credentials never reach the CDN.
The same checkpoint/cache preserves text and metadata. Changed dependencies reset
validation order; unchanged fresh facts can be reprojected without changing their
observation clock. Checksum metadata does not establish artifact-byte verification
or protected acquisition/publication authority.

These provider and text facts remain observations, never admitted artifact bytes.
Actual acquisition retains exact installed artifact/provider identity and refuses
changed bytes under that binding. A new rolling asset ID identifies distinct bytes;
this observer does not rewrite the old installed identity or supply publication.
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

### Typed release facts and coverage

The Core report may also carry `release_facts`, omitted when empty. It holds
one entry per release a projection observed (the latest observed, channel
candidate, reviewed fallback or eligible release), with its identity,
`assets_complete` and an `ArtifactFact` for each asset. A fact records the
asset's identity, its typed role (for example `desktop-game-runtime`,
`installer`, `compiler`, `mobile-package`, `source-archive` or
`integrity-metadata`), target operating system and architecture, and the
`FactSource` that established them. A consumer checks `source` before treating
a role as authorized: a `filename-suggestion` never authorizes one.
`assets_complete: false` means the asset list is unknown, never that the
release has no player.

Each channel projection may add `selected_artifact`, the typed fact for the
eligible or held asset; `reviewed_fallback`, the reviewed release that replaces
an excluded candidate; and `route_holds`, typed holds kept beside the stable
`hold_reasons` strings. All three are omitted when empty, so earlier fields and
their values are unchanged. In this slice `incomplete-coverage` accompanies
`release-asset-observation-incomplete`; `wrong-role`, `wrong-host` and
`contradictory-role` are reserved for authorizing sources that later slices
add and do not fire for current catalog entries. Source precedence is described
in [Catalog policy](CATALOG.md#artifact-roles-and-fact-sources).

Channel projection uses the same platform stream as release resolution. A
release whose complete asset list names players only for other hosts (another
desktop, Android, iOS or a console) is outside this platform's stream, so a
newer release for another platform no longer hides an older release for this
one. A release whose assets were not collected still stops the walk as unknown
with `release-asset-observation-incomplete` and the typed
`incomplete-coverage` hold. Asset selection collects the channel candidate's
and the reviewed fallback's assets.

`fact_provenance` states the observation clock, the parser and its version,
`facts_sha256`, `catalog_definition_sha256` and `coverage`. Coverage describes
provider paging and collection. Core accepts only observations with complete
release-header paging, so an accepted observation reports `complete`. A
selection-scoped asset gap is a projection hold on that accepted observation,
not partial coverage. Core interprets one observation, so `fresh_until` and
`last_good` are empty; the observer owns freshness and last-good facts.

**Cursor rule.** Only a final projection is gated: selection probes project
release headers before their assets are collected. A final projection whose
stated coverage is `partial`, `unavailable` or `failed` (or unrecognized) never
advances an accepted cursor. `observe-configured-upstream.mts` and the catalog
coordinator record the `incomplete-coverage` exception, keep `last_complete`
(the last-good facts and projection) and restore the continuation that existed
before the attempt. Changed facts with a stated incomplete coverage are not
accepted progress (`acceptedObservationAdvanced`). A projection without
`fact_provenance` keeps its existing acceptance rules; Core's GitHub report
always states coverage. Retained checkpoints and handoffs drop `release_facts`,
which are derivable from the retained provider facts, and keep
`fact_provenance` and each projection's typed fields.

### Stated source coverage in the observer scripts

The observer scripts state, per source, how an attempt that did not complete
covered its provider. They reuse Core's coverage vocabulary
(`partial`, `unavailable`, `failed`); a complete attempt states nothing and
the field is omitted. `statedSourceCoverage` in
`catalog-observer-continuation.mts` derives the statement from the recorded
exception rule:

| Provider outcome                                                    | Stated coverage                           | Rule                                |
| ------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| Truncated nonterminal page or missing next-page metadata            | `partial`                                 | `pagination`, `provider-pagination` |
| Own request, byte or time budget spent; cancellation                | `partial`                                 | `budget`, `cancelled`               |
| Collection changed during validation                                | `partial` (restarts, `next_cursor: null`) | `concurrent-change`                 |
| 429, or 403 with `Retry-After` or exhausted `x-ratelimit-remaining` | `unavailable`                             | `rate-limit`, `provider-quota`      |
| 5xx or 408 (see retries below)                                      | `unavailable`                             | `provider-status`, `provider-http`  |
| Network failure or timeout                                          | `unavailable`                             | `transport`, `provider-transport`   |
| Malformed, escaping or repeating pagination; page/cursor mismatch   | `failed`                                  | `pagination`, `provider-pagination` |
| Malformed JSON or metadata, other 4xx, identity changes             | `failed`                                  | the recorded rule                   |
| Core stated `partial`, `unavailable` or `failed`                    | Core's kind                               | `incomplete-coverage`               |

The pagination rules carry both outcomes. Only a truncated nonterminal page
(or a GitLab page without next-page metadata) keeps retained progress and is
`partial`; a malformed link, a link escaping its configured collection, a
duplicate relation, a non-advancing page, a repeated identity or a GitLab
page/cursor mismatch is an integrity failure and is `failed`.

Retries differ by provider. GitHub reads retry a 5xx response up to the
configured `budget.retries` within the run; a 408 is not retried. GitLab and
direct-manifest reads make one request per page and do not retry a 5xx or 408
within the run; the source is attempted again on the next scheduled run. In
both cases a non-quota 403, 451 or other 4xx is `failed`, notifies through the
ordinary exception path, and is not deferred as quota.

Each statement is `{ "kind", "rule" }`. It adds `retry_at` only when the provider
or its quota reserve named the earliest retry time (`Retry-After`, or
`x-ratelimit-reset` / `ratelimit-reset`). Provider retry clocks are bounded
where they are parsed (`boundedProviderRetryTime`, shared by the GitHub and
GitLab/direct-manifest paths): an unparsable, negative or fractional value is
ignored, a time in the past means "now", and no clock defers a source more than
24 hours (`providerRetryHorizonMs`). A retained clock beyond that horizon can
only predate the bound; it is discarded and the source is attempted. A `partial` statement adds
`next_cursor`: the retained position the next run resumes from. For GitHub
this is `collect:<retained pages>` or `validate:<validation cursor>`; for
GitLab and direct manifests it is `reads:<retained reads>:validate:<cursor>`;
it is `null` when the attempt restarts. Incomplete API coverage is UNKNOWN. It
never means that a release or asset is absent.

The statement is recorded in three places and omitted when complete:

- `coverage` on the catalog checkpoint's source progress
- `coverage` on the configured observer's checkpoint and report `exception`
- `coverage` on the matching report `source_statuses` and `failures` entries

Checkpoints written before this field still parse. A retained statement is
validated and bounded, so it adds at most a few hundred bytes per source.

**Script cursor rule.** An incomplete attempt never advances that source's
accepted cursor and never replaces its last-good facts. `completed_scope_sha256`,
`last_complete_facts_sha256`, `last_complete_policies`, `completed_at` and
`freshness_observed_at` stay as they were. Collection pages accepted before the
stop stay in the continuation, and the next admitted run resumes from that
retained cursor. A source with `retry_at` is not attempted again before that
time. A later complete attempt removes the statement.

One failing source does not stop the run. Its failure is recorded, it is
excluded from the remaining bounded batches, and the other sources continue
within their own budgets. GitHub quota is shared by the token, so a GitHub
rate limit defers the remaining GitHub sources until `provider_retry_at`. Those
sources stay pending with their own cursors; they are not marked incomplete.
GitLab and direct-manifest sources keep their separate reserves and continue.

Exit status keeps the convention the hosted workflow consumes. The coordinator
exits 0 when every attempted source completed, or when a source stopped with
only a quiet or repeated condition. It exits 1 once for a new notifying
exception. Budget and cancellation stops never notify; a new GitHub rate-limit
or outage exception notifies once. A GitLab or direct-manifest quota stop
(`provider-quota`: a 429, or a 403 with `Retry-After` or an exhausted reserve)
stays quiet while it is transient. The source's progress counts consecutive
quota deferrals in `quota_deferrals` (omitted when zero, capped at
`quotaDeferralNotifyAfter + 1`, also shown on its `source_statuses` entry); the
attempt after `quotaDeferralNotifyAfter` (3) consecutive deferrals notifies
once through the ordinary exception path. A complete attempt or any other
outcome clears the counter.
The exit status therefore does not separate "all complete" from "some
incomplete". Read that from the report: a source whose `source_statuses` entry
carries `coverage` is incomplete.

A listing's descriptive failure candidate takes its `upstream_observation.status`
from the same statement, in the listing vocabulary Core accepts: `partial`
becomes `incomplete`, and `unavailable` and `failed` are unchanged. A report
without a statement keeps the earlier rule-based mapping, which also maps
`provider-quota` to `unavailable`. Core, definition delivery, the desktop
presentation and route-fit reporting treat only `complete` as usable, so the
change affects only which incomplete word is shown.

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

## Original-file source observations

For an operational Libultraship definition with a source profile, the catalog
observer can read an upstream `docs/supportedHashes.json` table at the exact
commit resolved for Core's current Stable release. It binds the observation to
the provider repository and release identities and the platform artifact
digests returned by Core. The parser records its version, the source file's Git
object and SHA-256, and the SHA-1 values the upstream table declares.

For a GitHub N64 Recomp definition with a source profile, the observer reads
`src/main/main.cpp` at the same release boundary. It recognizes the family's
literal `supported_games` table and records the game ID, optional native mod game
ID, and declared 64-bit ROM hash per row. Unrecognized declarations and
conditional tables leave current evidence unknown. An observed table describes
the release source. Runtime hash normalization, compiled platform coverage and
actual acceptance require separate evidence before Core can use it for setup.

For a release that pins the canonical N64ModernRuntime Git submodule, the
same observer records the dependency revision and checked runtime source blob.
It compares the unconditional input and storage routines with reviewed source
patterns that pad the ROM, normalize it to big-endian byte order and call XXH3.
Unrelated runtime routines can change while those blocks stay the same. A
matched runtime's nested canonical xxHash Gitlink and its checked header blobs
record the hash source pinned by that revision. The observer reuses checked
headers across releases that pin the same dependency. A missing header read
leaves the previously checked runtime and game table available. A
required binding needs evidence of the effective hash implementation and
provenance linking the selected compiled asset to its source and dependencies.
Unavailable runtime metadata can be retried without losing the checked game
table.

For a matched N64 runtime and pinned hash dependency, the observer can associate
a selected published artifact digest with an Actions output at the same
upstream repository and source commit. The observer requires a successful
same-repository first attempt, the output's own run identity, and run readback
before retaining a match. A bounded search resumes from the retained position.
Packages without a match stay unknown. An exact match remains available after
the Actions artifact expires, including when other selected packages change
at the same repository and commit. This establishes a provider-reported build-to-release
digest link. Effective checkout and dependency behavior, the job that produced
the output, and native original-file acceptance need separate evidence.

For outputs with an identifiable upload step, the observer reads that step
and the earlier checkout step from the exact run attempt. The upload log must
identify the same digest, artifact ID and size. The checkout log must report
the selected repository, source commit, runtime and xxHash revisions. The
checkpoint retains checked job and step identities and log digests. Missing
or unusable job evidence leaves the affected package unknown and advances the
search to other packages. Shared budget and rate-limit deferrals still apply.
Raw logs and signed download addresses stay out of the checkpoint. On a later
turn, a matched job can retain the ordered CMake/Ninja runtime compile, static
library, and executable link evidence from a successful step between checkout
and upload. An unavailable compile log keeps the previously checked steps.

Maintenance projects a provisional original-file binding for the exact port
definition, source contracts, and package selection evaluated by the observer.
It uses the native game ID from the configured runtime filename, the reviewed
hash-header bytes, and the linked executable's name against the port's sole executable hint
for that platform. A package review also binds the selected runtime layout. The proposal remains held until the packaged executable and its effective
hash behavior are verified. A checked package receipt joins the selected platform and artifact digest
to the observed source, runtime, hash dependency and exact build job. For a
universal package, each selected architecture needs its own review. The
maintenance projection then prepares a source-contract amendment and immutable
upstream support evidence. It preserves existing bindings and the enforced
legacy contract. The first enforced migration requires N64 reader capability
11; informational exact bindings require capability 10.

Run `node scripts/prepare-n64-original-inputs.mts CHECKPOINT PORT_ID` to
replay a current observer checkpoint against the authored catalog and emit the
replacement contract and evidence record. Apply them to the indicated shared
catalog source through normal catalog review and generation. The output carries
the previous contract digest and exact executable receipts for review. Native
acceptance and signed definition delivery continue through their existing owners.

These optional facts follow the existing request budget and checkpoint. The
maintenance projection keeps the last complete exact observation and records
when current evidence is unavailable. A due refresh checks the release tag
before reusing the immutable table. A moved tag leaves the stored artifact
observation intact while reporting the change. A release fallback never supplies a
current observation. Recognition-only observations carry no verdict about a
player's files or the runtime's acceptance, and confer no setup, acquisition
or publication authority.

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
observed request cost and remaining runtime. Sources serving at least one managed
port go before listing-only sources while they have no recorded failure,
because their releases can change what players install. Budget, cancellation and
quota stops are partial progress and keep that priority; checkpoints record each
exception's rule, and older entries without one keep it until their next attempt. Within each group,
eligible sources without a recorded turn go first, then the least recently
attempted sources. A completed managed source leaves the pending set until it is
due again, and a managed source with a recorded failure rejoins ordinary
rotation, so listing-only sources still receive turns. Each admitted source receives a turn large enough to finish a typical
collection and validation (twice the per-collection page allowance plus four
requests, within the per-operation request budget) rather than an equal split of
the remaining capacity across every pending source, which rounded each turn down
to a single request and completed almost nothing. Sources beyond the remaining
capacity wait for a later batch in rotation order; early configured or
scheduled-priority turns keep their existing page-allowance and half-capacity cap. Unknown quota uses
the existing finite request envelope; it is not assumed available. Quantum/runtime
exhaustion has no provider retry clock. Actual depletion and provider retry
responses defer the shared provider until its reset. A budget-limited source with
progress can receive another turn automatically while capacity remains. A failure
isolates its source. A new non-budget exception fails the job once when its source
serves a managed port, is the configured baseline, or is a scheduled priority
scope; continuing exceptions and normal continuation remain visible without
repeated notifications. Other listing-only exceptions are recorded in the report
and checkpoint without failing the job, because they cannot change what players
install. They use a separate exception key, so a listing that later gains a
managed port still reports its unresolved rule once.

After each hosted run, `scripts/upstream-relocation-candidates.mts` reads that
run's summary and lists proposal-only relocation candidates in the step summary
for repositories whose failure was `repository-unavailable` (404), `provider-transport`
or `transport`. A first identity lookup reports HTTP 301 directly, while a source
with a retained identity fails in its release listing, where the refused redirect
surfaces as a transport failure. A summary without a failure list is reported as
coverage unknown, and one failed lookup leaves only that repository `unknown`.
The step runs after every retention step. For a 301 it reads the
`Moved Permanently` body's numeric repository URL without following it, then
makes one `/repositories/{id}` read for the current name. It compares that ID with
the observer checkpoint's retained `repository_id`: `same-repository-renamed`
means the numeric identities match; `different-repository`, `identity-unbound`,
`name-reused`, `unavailable` and `unknown` keep the change unreviewed. The step
continues on error and never changes the job result. Candidates grant no lineage,
relocation, accounting or catalog authority; an accepted rename is still a
reviewed catalog change, and qualification, holds and accepted bytes do not
transfer by themselves. The same command accepts `--repository OWNER/NAME` for
manual use.

The owner-dispatched `Upstream relocation evidence` workflow
(`scripts/upstream-relocation-evidence.mts`) gathers the provider facts a reviewed
rename needs. It takes up to eight current names, each `OWNER/NAME` or
`OWNER/NAME@TAG`. For each one it reads the repository identity and the first page
of releases with their asset names. For a named tag it also reads that release and
its complete asset collection, with release and asset facts and hashes produced
by the observer's own fact functions. A reviewer can compare a reviewed pin's
numeric release and asset identities, size and digest at the new name, and see the
exact facts a rebinding would record. Redirects are refused, nothing is
downloaded, the job has read-only repository permission, and the JSON report is
retained as a run artifact. The evidence grants no lineage, relocation, selector,
acquisition or accounting authority; any rebinding remains a reviewed accounting
change.

The forty-five-minute hosted job establishes a forty-minute observation deadline
before checkout and build, reserving the final five minutes for checkpoint and
artifact publication. Accepted page, validation or Core progress can automatically
start another operation within that opportunity; each operation keeps its existing
three-minute admission budget. Request counts and refreshed clocks alone cannot
authorize another batch. A hosted opportunity's observation step spends at most 1,800 GitHub API
requests, about a third of the observed hourly allowance, so upstream-health and
other workflows sharing the token keep capacity. The ceiling is a hard total.
Each batch receives only the remaining allowance, and release and registry
requests count against it. GitLab and direct-manifest sources also keep
their own per-source bound. Checkpoint recovery, push admission and
relocation proposals make separately bounded reads outside the step. A
gap-filling push opportunity (below) spends at most 900, so a push followed by
the next schedule within one hour stays near half of that allowance. Non-budget failures stay visible and are excluded from
further attempts in that job. All batches share one aggregate handoff byte budget;
input or inspector changes stop continuation and preserve earlier evidence. The
standalone command without this explicit hosted deadline remains one bounded
operation.

The scheduled workflow can give one exact catalog source key an early
collection turn alongside the configured source. It splits the existing
early allowance between the due scopes and retains the ordinary rotation
for the rest of the inventory. A selected completed scope can re-enter
rotation once its provider observation expires, even if its completion-based
due time is later. Freshness still uses the original provider validation
clock, and retained checkpoints keep their existing configuration identities.

The scheduled hosted opportunity gives Chameleon JP (#246) and OpenTyrian
(#315) early turns using their exact configured source keys. These turns share
the existing collection allowance with the configured Shipwright source and
preserve the regular rotation and checkpoint handling. A due appointed GitHub source takes its bounded provider refresh even if a Core
binding change also permits offline reprojection of earlier facts. An incomplete
refresh retains the prior observation and freshness clock. Manual dispatch has
no scheduled appointments.

Each hosted batch starts with the appointed scopes and healthy managed sources
whose provider receipt is missing or will expire by the batch deadline. The
batch then offers one recovery turn before every three ordinary healthy managed
turns while both groups have work. Recovery covers eligible listing-only
sources and managed sources with a recorded failure whose provider freshness is
missing or expired. Retry deadlines still apply. Within recovery, sources
without a recorded attempt go first, followed by the least recently attempted
sources. Every turn uses the existing source quantum and shared request,
runtime, and byte limits. Sources that run out of capacity keep their durable
place for a later batch.

The legacy `configured-upstream-observation-RUN-ATTEMPT` artifact retains exactly
one `report.json` and its existing consumer/configuration binding. Catalog reports
use a separate, uniquely owned handoff directory for each invocation, exported as
`catalog-upstream-observations-RUN-ATTEMPT`. It contains inert observations and
per-port Core policies for #246's existing supplied-observation → bounded-candidate
path. Source files carry their own coverage and consumer IDs. The legacy
configured report carries its unmonitored inventory, and the catalog summary
reports coverage across configured sources. Historical fallback policies retain their own facts/definition identities
and are explicitly held as unknown current state. No automatic acceptance,
publication, signing or player update eligibility follows from this handoff.

A handoff holds only the sources its run attempted, so consumers that need
every source read the retained checkpoint snapshot instead
(`readUpstreamObservations`): the maintenance inventory, the listing delivery
and the listing facts batch job
([accumulated observations](CATALOG.md#accumulated-observations)), which
projects each completed source to its last complete listing observation.

Each source operation admits response bytes, including identity lookups, while
reading. Its finite byte envelope does not cap cumulative catalog-session work:
further bounded operations continue while actual quota and runtime remain.
Failed reads without accepted page/Core progress are not immediately requeued.
An exhausted observation deadline during provider setup or a batch-limited
Core inspection is a budget stop. The next admitted batch resumes the retained
state. For GitHub metadata reads, the reported budget detail distinguishes the
individual response limit, total response bytes, request count, admission and
available time. The continuation still uses the same budget rule.
The new handoff has the existing sixteen-MiB response envelope as its aggregate
byte budget, with four MiB reserved for the summary and one-day artifact retention.
The output reserves sixteen MiB separately for a complete inert recovery snapshot.
The four-MiB summary and eight-MiB standalone handoff limits still apply across
all batches. Provider request and response budgets are unchanged.
A hosted opportunity gives source handoffs thirty-two MiB in aggregate,
proportionate to its forty-minute window; each source file keeps the eight-MiB
standalone bound, within the sixteen-MiB per-file limit of the manual
`prepare-port.mts --listing-observations` consumer. The
snapshot contains the catalog scheduler and its referenced per-source checkpoints;
it excludes reports, locks, temporary files and executables. Production format 4
streams source checkpoint JSON records through one Brotli compressor, preserving
cross-file redundancy that nested source gzip/base64 cannot share. A fixed binary
magic and closed header of at most 512 bytes bind record count, complete framed
byte count and SHA-256. The format 4 ZIP is limited to sixteen MiB, with sixteen
KiB reserved for ZIP framing. Formats 1, 2 and 3 remain readable within their
original four-MiB ZIP and thirty-two-MiB decoded snapshot limits.

Production snapshot collection projects every referenced GitHub source's legacy
raw pages to the versioned fact representation before encoding. It validates
the full original source and page bounds/digests first; a tiny resulting projection
cannot admit an oversized original input. Each complete projected source must
also fit the existing thirty-two-MiB write bound. Export leaves the original cache
files untouched; ordinary observation migrates pages when saving its replacement
checkpoint. All accepted observations, Core projections, source configurations,
scheduler positions, validation cursors, page identities, counters and clocks are
retained. Null caches keep their fresh-read fallback. There is no history reset.
Collection metrics distinguish original logical bytes, projected `fact_json_bytes`
and compressed stored bytes so metadata reduction is not reported as lost work.

Each record has a closed name/length header of at most 512 bytes. Scope metadata
comes first (at most four KiB), then the controller and only source paths appointed
by its validated configuration graph. Names, counts and length bounds are admitted
before allocating a body; duplicates, foreign paths, missing required sources,
incomplete records and trailing compressed/decoded bytes refuse. Decompression
uses backpressure and 64-KiB chunks, with one at-most-thirty-two-MiB record body.
Each source passes ordinary complete checkpoint/configuration validation and is
recompacted before retaining the next source. Exact reconstructed stored bytes,
including scope metadata and paths, are bounded to forty-eight MiB in format 4.
The full logical transfer stream is never assembled in one buffer.

The actual RFC7932 Brotli window header must request at most four MiB; nonstandard
large-window mode is disabled. The one absolute collection deadline cancels both
stream directions on timeout or any parser/budget refusal. Encoding uses quality
six and a four-MiB window. Streaming codecs require a supported Node release
containing the October 2026 decoder fix; the repository already pins Node24.22.2.
No runtime pin, security credential or workflow permission is changed.

Large source checkpoints use lossless, tagged gzip/base64 storage wrappers
inside the decoded **stored graph**.
Each wrapper has a closed schema, canonical encoding, declared decoded size and
SHA-256; inflation cannot exceed the original thirty-two-MiB per-source reader
limit. Nested wrappers and decoded non-source documents refuse. Normal complete
checkpoint/configuration validation still follows decoding. Uncompressed legacy
files remain valid; small or incompressible files need not be wrapped. A raw source
larger than the original reader limit is refused even if it would compress well.

The aggregate logical source JSON can exceed thirty-two MiB; it is never assembled
as one expanded graph. Collection and validation decode one source at a time and
retain only its stored representation. Atomic restoration writes those compact
files, whose aggregate stored bytes remain within the graph bound. Runtime loads
decode before continuation, progress-position and retired-cache ownership checks.
Accepted provider facts and original page identities, clocks, Core cursors and
configuration bindings remain unchanged. One absolute collection deadline covers
codecs and graph validation. These codecs preserve the represented checkpoints losslessly. The explicit
fact-page migration above removes unused raw metadata. Per-checkpoint and
archive byte limits apply independently of the aggregate stored graph.

Collection diagnostics distinguish actual input-file bytes, original logical JSON,
projected fact JSON, stored value bytes, largest source and file count.
`stored_graph_bytes` counts the serialized scope metadata, checkpoint names,
values and JSON delimiters. Export logs also report framed logical-transfer
bytes and actual transferred bytes.

The hosted export covers collection, validation and encoding in one bounded
step. It has up to 120 seconds from its start and ends within 120 seconds after
the 40-minute observation opportunity. The workflow's 45-minute limit covers
the full job, including retention and cleanup.

If the lossless encoding cannot fit its reserve, export fails visibly and the
original checkpoints and cache remain retained. The snapshot transfer has its
own reserve. The request, runtime, provider response, summary and handoff
allowances retain their existing bounds.

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

### Scheduled managed package drift

The configured observer’s existing schedule supplies the exact current GitHub
release and asset selected by Core. A downstream inspection reads only those
complete source handoffs from the same run and attempt. It compares eligible
packages for catalog listings with generated reviewed shape baselines first.
If the same route and platform have no generated entry, Core can compare an
explicit reviewed layout within the remaining inspection budget. That layout
covers programs and top-level directories. Differences in those components
are drift, and a match remains an incomplete comparison because the other
shape components lack a reviewed baseline. A listing's stable port ID
identifies its inspections even when no issue is linked.
An older reviewed fallback stays distinct from the latest candidate. Other
providers, incomplete scopes and unavailable archives have no current shape
assessment from this job.
When an exact current managed GitHub candidate lacks both reviewed baselines,
the inspection report records `no-reviewed-baseline` under `baseline_gaps`.
Each row binds the port, platform, channel, definition and asset identity.
The report retains up to 1,024 rows in stable order and counts any additional
rows. These gaps spend no archive budget and do not trigger issue notices.

The read-only inspection verifies size and SHA-256 before comparing the archive
through `portcove catalog inspect-package-drift`, an alias for the verified
package-shape inspector. Nothing from the archive runs. The inspection retains a
bounded report and reuses finished comparisons only for matching package,
definition, reviewed baseline and built inspector bytes. A partial layout
comparison can be reused when Core confirms both reviewed components matched.
Its verdict stays incomplete. Failed archive checks remain visible and can be
retried in a later observation. Installed-state eligibility stays with Core.

The inspection checkpoint also tracks where each baseline group ran out of
time or download budget. The next run continues from that route in stable
port, platform and channel order, even when new inspector bytes invalidate
previous results. Generated baselines keep priority over reviewed layouts.
If a handoff omits the saved route and the group has no new budget deferral,
its checkpoint retains that position for a later handoff.
Oversized archives stay unassessed and do not set the next route. A failed
download or inspection remains eligible on a later pass. The continuation
changes only the order of work within existing limits.

A separate main-branch job has only the issue write permission for the notice.
When a listing links a canonical issue, it records one bot-owned marker comment
per affected issue, with the
platform, channel, artifact identity, changed components and inspection run.
Issue-free observations remain in the inspection report.
Compatible or unknown evidence leaves existing observations in issue history.
The notice job keeps an unchanged marker and refuses duplicate or concurrently
changed markers. It does not publish or edit the catalog.

## Resource bounds and availability evidence

The configured per-batch bounds are 256 API requests and ten newly read pages
per collection; retained pages do not consume another collection allowance.
These bounds do not cap the total legitimate collection across resumed batches.
Each batch also retains
4 MiB per response, 16 MiB total response bytes and three minutes of observation.
Eligible transient transport/server failures use the configured GitHub SDK with
at most two retries; smaller configured allowances remain effective. Cancellation,
resource limits and invalid metadata remain terminal. Continued catalog batches
retain the command's original monotonic deadline and exhausted logical-read
allowances. Rate-limit responses respect provider waits and defer whenever those
waits cannot fit the original bounds. The existing observer owns conditional
cache reuse, facts digests, identity validation and complete-versus-prefix proofs;
the SDK supplies bounded transport and request evidence.
Conditional requests count against the request budget. No game artifact bytes
are downloaded. Core inspection reads the catalog within the 16 MiB generated-catalog
bound and each observation within 4 MiB. Each Core process is bounded to thirty
seconds, and the entire hosted job to ten minutes on one fixed Linux runner.
Only observing jobs share the per-ref concurrency slot, with one active and at
most one pending. Hourly schedules and manual runs always observe. A merge to
main starts an admission job that lets its run observe only to fill a schedule
gap: when no schedule or push run of the observer observed, or is observing,
within the last fifty-five minutes. Admission reads one ten-run page per trigger and the jobs of recent runs; a
full page still inside the cooldown is incomplete coverage, and that or any
read failure declines. A declined push run
finishes without observing, so it neither consumes the slot nor displaces a
pending scheduled observation. Actual usage is lower with a warm build cache.
There are no agent/model calls.

The main observer job has `contents: read` and `actions: read`; the latter permits
retrieval of the preceding observer's checkpoint artifact. No write,
signing or publication permission follows. The existing cache remains the fast
path with its original thirty-two-MiB per-file reader limits. On complete cache
loss, recovery admits only the same repository, workflow and default branch's
completed producer from a natural schedule or a push to main, including a
failed run carrying a complete snapshot. GitHub can skip scheduled runs for
hours, so gap-filling push runs (above) keep progress continuous (#4779). Both triggers run main's reviewed workflow source. Recovery reads one
provider-filtered inventory per trigger and merges them newest-first, so manual
dispatches, fork pull requests and other triggers never enter it, consume its
window or set its age boundary; a listed run whose trigger differs from its
filter refuses. Each trigger's window must be complete or reach its own age
boundary; one cannot certify the other. A push run within the
recovery age without a snapshot is passed over, because declined push runs never
observe; at the age boundary it reaches the same cutover check as a schedule, so
missing history still requires explicit recovery. The producer's trigger is re-read after collection.
Provider run/artifact identity, main ancestry, the exact configuration digest,
artifact digest, archive structure and the complete checkpoint graph are checked
before an absent checkpoint tree is published atomically. A partial or foreign
cache is preserved and refused. Existing current catalog/Core scope and freshness
checks still apply; restoration never refreshes an observation clock.

Recovery has one at-most-sixty-second collection opportunity inside the
forty-minute job opportunity, with finite metadata, compressed and expanded bytes
and no automatic retry. Snapshots have one-day retention and a twenty-four-hour
recovery-age bound. The deployment cutover explicitly records a new baseline only
when trusted predecessor source shows no snapshot publisher; an older
publisher is inspected even after artifact expiry. Missing post-cutover history,
invalid or unavailable advertised artifacts and incomplete inventories require
explicit recovery rather than a silent new baseline. Interrupted snapshot export
does not erase the earlier cache or original failures. A later real scheduled
run must demonstrate continued source/page/Core progress separately from fixture
tests and an individual batch's `made_progress` field.

The November 2 checkpoint-history loss's one approved fresh-baseline opportunity
was consumed and has expired; it cannot be renewed. After snapshot export failures
left no retained snapshot, the November 11 checkpoint-history loss has one
explicitly owner-approved fresh-baseline opportunity (Related to #246), approved
for the upstream source of the #4129 maintenance inventory. It is pinned in source
to failed scheduled run `43116173426`, its original attempt/source/creation
identity (`538ce14b`, `2026-11-11T22:58:46Z`), main ancestry anchor `d7f5e10b`,
and the unchanged configuration digest. Only its first natural scheduled
successor, attempt one, may initialize an entirely absent checkpoint tree. Every
intervening scheduled status consumes that opportunity, including queued, failed
and cancelled runs; reruns and manual dispatch cannot use it. The known
predecessor must still be inside the existing twenty-four-hour recovery window. Provider-verified current
run identity, complete ordered history, retained main ancestry, and exact-current-
source Contents metadata bind the config and both catalog/listing input files.
Their paths, regular-file type, size and locally computed Git blob identity must
match. A final provider/run-history readback precedes an exclusive local consumption
receipt and atomic publication. A failed publication retains that receipt.

Valid surviving checkpoints take precedence. Partial trees, invalid/expired
artifacts, unavailable metadata, quota/deadline exhaustion and changed inputs
remain refusals; none enter this terminal missing-history initializer. A config
change cannot turn missing history from an already deployed publisher into an
initial baseline. There is no reusable flag, dispatch input, credential, new
permission, schedule change or automatic reset path.

The new controller starts with sequence zero, no source observations, no successful
clocks and no provider/Core cursors. Validated historical `baseline` provenance
records lost prior continuity, unknown initial freshness, the actual initializer
and SHA-256 identities of its inputs. Ordinary later progress and snapshots retain
that provenance without treating it as current eligibility or refreshing its
clocks. Existing artifacts and failures remain evidence; fresh bounded reads must
recollect every missing fact. The one-time opportunity is spent even if its first
job fails, so another whole-history loss still requires an explicit decision.

Discovery reads scheduled history in ten-record pages through the relevant age
boundary, retaining the existing hundred-record ceiling. Every fetched page must
match its declared count; totals, unique identities and descending creation order
must remain consistent across pages. A bounded prefix that cannot establish the
required history stays unknown rather than initializing a clean baseline.
Ancestry reads use the comparison endpoint's second page: GitHub's file patches
occur only on page one, while global status and merge-base identity still describe
the same exact source comparison. No commit or file inventory is inferred from
that partial page. Metadata logs retain the controlled route, response bytes,
cumulative charged bytes and request count before the aggregate limit is checked.
This reduces unrelated data transfer without raising the four-MiB metadata budget,
relaxing ancestry or permitting missing post-cutover checkpoints to be ignored.

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

GitHub metadata uses the configured Octokit integration, preserving this collector's
single-attempt reads, explicit API/media headers and command-wide request, byte and
monotonic time limits. A bounded redirect response can supply the existing reviewed
repository-identity diagnostic; its Location is never followed. Failed body reads,
resource refusal and command cancellation remain failures. A cancelled unfinished
read does not publish a fresh provider observation. GitLab metadata and credential-free
artifact HEAD requests retain their separate owner. Domain tests can provide narrow
asynchronous metadata operations with explicit byte evidence; transport tests exercise
the actual locked SDK.

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
collections remaining unknown. A reviewed GitHub pin can supply the publisher tag
for a different retained install version when port, platform, repository, version
and artifact digest all match. The observation requires the reviewed release ID
and provider-reported digest, and keeps the original qualification scope.
Metadata and HEAD never verify accepted bytes.

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

Tests distinguish exact current direct URLs from retained bindings whose catalog
ports now use dynamic GitHub acquisition or a different direct URL in the same
exact GitHub repository. A changed version, size, hash or provider at the same URL
cannot use historical facts. Replacement URLs remain unbound observations;
historical projections grant no current identity, byte, admission or release authority. The historical artifact projections come
from catalog commit `3305a4707d5b902fe5565608c3330cecc8b701da`; the test fixture
retains its source hashes and grants no current acquisition or identity authority.
Bindings at the current direct URL must still match all current inputs, while
retained cases require the exact historical port/platform binding and the current
repository/platform declaration. Historical projection coverage does not claim
that an old URL is currently monitored or that a new URL has reviewed numeric IDs. Missing, duplicate or unused projections fail. All reviewed policy
facts and endpoint/source-archive checks remain in place.

After a reviewed same-identity relocation (an accepted `upstream_lineage`
relocation with an unchanged numeric repository ID), a rebound pin names the
current repository and download URL. Its retained historical projection keeps
the former path, because that projection is frozen with its source hash. The
binding test pairs them by port, platform and historical contract hash, not by
repository name. The reviewed `upstream_lineage` relocation and the pin's
unchanged `repository_id` establish that both paths name the same repository.
Rebinding requires
read-only evidence that the reviewed repository, release and asset IDs, release
facts, size and SHA-256 are unchanged at the new name; only the URL-bearing
asset facts hash is recorded anew.

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

The health monitor shows the observed operation and the affected artifact
platforms and variants when the incident matches the active inventory in the
monitoring session. The JSON report includes the exact declared direct or
historical identities for that port. Repository-only incidents and conditions
retained from a prior session without that match show unknown artifact scope.
Reporting scope leaves observation history, byte verification and operational
hold decisions with their existing owners.

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
incremental operation permits at most **352 requests**, **512 newly assessed locations**,
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

The standalone full collector, which the release workflow and the local release
preflight run, is never refused by inventory size. The 352-request and
512-location ceilings size scheduled monitor operations only; a plan above the
location ceiling still reports `request_plan.status: "overflow"` so the monitor's
planner splits it, but a full collection attempts it. Every request is admitted
against the collection's own conservative forecast, the provider quota reserve,
the three-minute limit and the byte limits. Locations the time or byte limits
leave unattempted are reported as `budget`, and the collection is `partial`. In
observed release runs 34761853116, 34769169958, 34847939207 and 35158181486
(2026-09-13 to 2026-09-16), the "Verify active catalog upstreams" step took 14–17
seconds; this is an observation of a smaller catalog, not a guarantee. Without
provider quota headers, the forecast is the only request bound, so the local
preflight requires a GitHub token. Catalog edits run the real-catalog collector
test, so growth that breaks it fails on the pull request. The maintained
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
counts. The final report distinguishes ports selected across the session from
the last batch and its budgets. Freshness is 24 hours and requires matching
per-port health inputs and accounting policy. Main pushes skip matching recent complete observations;
partial attempts remain due. Scheduled and manual runs reconsider their requested
inventory and prioritize older attempts. Ports deferred entirely by time/request
budgets or rate limits retain their earlier scheduling position for later batches.
The daily schedule requests 09:23 UTC, subject to hosted scheduling delays.
A location replayed from a prior session keeps its original observation clock,
even when its port is selected again. An observation made by an earlier batch
of the current session still counts for that session when the final report
contains the same incident, material facts and clock. Carrying either observation
forward does not add another occurrence. The session's condition labels describe
current observations. The nested collection retains its batch-local diagnostics
and recovery counts, including incidents first reconstructed from prior progress.
Retained conditions identify whether they were observed in the current session
and whether their evidence is stale.

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

The report's batch-level `recovery_evidence` joins each recorded recovery to the
prior condition's exact location, contract, observation clocks and occurrence
count. Endpoint recovery and provider-metadata recovery have separate kinds.
The recovery timestamp comes from the matching observation, and reused
observations retain their original clock. This evidence does not change which
conditions recover or modify the checkpoint format.

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
The collector's 352-request and 512-new-location envelopes bound one monitor operation,
not the logical catalog or retained cross-run history. Checkpoints use their
existing 16 MiB physical envelope rather than separate 4,096-port, 8,192-record
or 512-incident historical count ceilings. Input catalogs are bounded to 16 MiB,
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

When every consumer of a source is a descriptive listing, its private
checkpoint scope binds the source, provider, listing declarations, exact
descriptive projector and freshness policy. A Core rebuild alone leaves that
scope current. Mixed sources and managed sources keep their exact Core and
definition bindings. Earlier listing checkpoints use the same bounded
reprojection path. Offline success retains the original validation, completion
and change clocks without postponing a due provider check. A tighter freshness
limit can move the next provider check earlier.

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

For managed GitLab N64 recompilation sources, the same provider handoff can
also report `gitlab_n64_source_declarations_v1`. It follows stable tags selected
by the current Core metadata projection. A numeric project, exact release and
tag commit, complete bounded directory listing and verified Git blob identify
the source declaration. A second tag read brackets the proof, and incomplete,
moved or ambiguous source evidence remains unassessed. These requests use the
existing provider quota and observation deadline. A budget or quota deferral
can bring forward the next observation, after the provider reset when known.
A previous exact declaration may remain in the handoff as historical evidence
when the current source scope, project, tag and commit still match. The package
and descriptive listing projections remain independently available.

A source declaration reports what the exact tagged GameEntry table says.
Player launch and an exact release-specific original-file recommendation need
separate reviewed evidence linking the selected shipped package and executable
to that source. The existing signed original-file preparation requires a
supported package/build provenance route and independent admission where
applicable. Until those bindings are available for GitLab, keep existing
signed guidance and treat observations as evidence for review.

## Descriptive consumers and accepted listing corrections

The same scheduled coordinator also reads the reviewed listing directory. GitHub
and supported public GitLab listing consumers share repository identity, conditional page collection, quotas,
continuation and last-complete facts with operational consumers. A listing never
needs an adapter or managed definition. Explicit consumer kind, declaration hash,
projection implementation/schema-inventory hash and repository identity bind its
scope. An accepted observation does not invalidate its unchanged declaration.
Only explicit credential-free HTTPS identities on github.com or gitlab.com enter
the existing provider collectors. Unsupported hosts or source shapes are reported
as observation unsupported, never as an empty release history. Existing GitLab
metadata pagination proofs, request budgets, per-origin quotas and checkpoints
also apply to listings; no new collector or per-title task is introduced.

Descriptive consumers request complete asset collections for at most four newest
published release headers. GitLab uses exact tag identities and generic registry
file IDs, sizes and provider digest claims through its existing collector. Release
links without supported exact registry metadata leave asset coverage incomplete;
no size, digest or acquisition permission is guessed. GitLab does not have a
GitHub numeric release ID or provider prerelease flag; tags remain strings and
its upcoming releases are excluded. Existing project/tag release references and
Desktop identity keys are reused, without a parallel provider identity model. Listing format8 fences this provider shape;
older readers retain their last accepted directory. This is a bounded release window, not complete
repository history. Drafts are excluded. Release assets retain exact provider
identities, names, URLs, sizes and optional digest claims. Authored literal
filename hints can annotate platform candidates; these are neither compatibility
nor verified bytes. Checksums, documentation and unknown assets cannot establish
package availability. Asset output is bounded; truncation remains incomplete.

`descriptive_listing_candidates` in the existing handoff contains unsigned
corrections for the existing acceptance and signed listing-delivery path. Current
authored fields always win over historical policies. Refresh failures retain only
applicable last-good observation facts and their original clocks, with a separate
attempt status. A first failure has no successful observation or invented digest.
Collection never accepts, signs or publishes these candidates. Actual protected
provisioning and unchanged-client production acceptance remain #534/#246 work.

A source whose consumers are all descriptive listings also keeps each of its
four newest published releases' own text, for generated registration's
release-text rule only: its observer configuration says so
(`release_text: "listing-window"`, so its checkpoints are its own), and its
facts keep the release name and, of the body, only the first line the rule
judges, looked for in the whole body (`text: { title, line, line_complete }`).
Only the first release list page keeps text (the provider lists releases
newest first); a window release on a later page reads as unobserved text, so
the stored pages and the projection each hold at most one window.
The kept text of one source is bounded by the checkpoint's capacity
(`releaseTextSourceBytes`, 32 MiB ÷ 2 ÷ 2 ÷ 1,295 sources, a bounded unit);
over it, each kept release records only a typed overflow with its size
(`overflow_bytes`), which reads as unobserved text, never as a statement
either way. A change to the kept text during an observation is a concurrent change
like any other fact. Managed sources keep no release text: their facts,
checkpoints and Core projections are unchanged. The text travels beside the
candidates, never inside `upstream_observation`, whose shape Core's signed
listing accepts: each listing projection carries `listing_release_text`
(format 1) bound to its observation's facts digest. The checkpoint's
`last_complete_policies` keep it with each projection, which is where the
facts batch reads it; the handoff's `catalog_policies` omit it. A reader
attaches text only to the observation whose digest it names; a projection
without it reads as unobserved text. The text is unsigned, untrusted upstream content, never shown to
players and never accepted into a listing
([release text statements](CATALOG.md#release-text-statements)).

The same report carries `descriptive_listing_preimages`, keyed by stable ID and
binding the prior accepted observation hash. Feed a retained source report to
`prepare-port.mts --listing-observations REPORT --validator-cli TRUSTED_CLI
--output-dir CHECKPOINT` to obtain complete authored-record proposals through the
existing preparation machinery. It checks the current declaration and observation
preimage, preserves integration/artwork/restriction fields and makes no provider
requests. This removes manual record reconstruction while preserving ordinary
acceptance and signing. Preimages prevent stale proposal application; they do not
authenticate provider data or grant publication authority.

Reason-bearing pin maintenance comes from authored `release_maintenance`; exact
versions and publication dates derive from the accepted Direct contract. Newer
observed headers trigger a bounded reconsideration report with its reason and
resume condition. They establish neither package compatibility nor an accepted
managed replacement. Marathon's archive-root/shared-profile contract and Super
Metroid's build-specific quickstates retain their pins.

## Release content scan

The [`release-content-scan.yml`](../.github/workflows/release-content-scan.yml)
workflow applies the automated half of the
[rights basis for upstream-hosted packages](CATALOG.md#rights-basis-for-upstream-hosted-packages)
([#5353](https://github.com/boburning/portcove/issues/5353)). Every six hours it reads
every unheld GitHub or GitLab listing that offers a download, finds the newest
release in the listing's recommended channel and the single asset each
platform's hints select, and downloads each asset it has not scanned before.
`scripts/release-content-scan.mts` lists the package with `7z`, `tar` or
`unsquashfs` and inspects the first bytes of up to 64 candidate files of at
most 64 MiB each; `tar` stops at the first matching member. Nothing is extracted to run, executed or
installed. Member names that a lister could read as an option, list file or
wildcard are never passed to it, every lister call has a hard timeout, and
encrypted archives fail instead of waiting for a password. A provider-published
SHA-256 digest must match the downloaded bytes.

`scripts/release-content-signals.mts` flags concrete game-data signals: ROM,
disc and original executable files by name; copied cartridge headers by
Nintendo's boot logo bytes; Nintendo 64 and iNES ROM headers, ISO 9660 (cooked
or raw sectors), XEX and Xenia shader storage by content; and PlayStation BIOS
images that are not OpenBIOS. Fonts, icons, launcher art and code are not
signals. Homebrew ROMs and similar legitimate files can also match; a finding
is review evidence, so a person confirms it and, unless the material falls
under a rights-basis owner exception, sets the listing's
`download_block_reason` in a reviewed change.

Each scanned asset is remembered in a cached checkpoint by rules version,
provider, repository, tag, name and, where the provider gives them, digest or
size, so a successfully scanned
release is downloaded once; a rules change rescans. Each scheduled run has an
asset budget of 160 packages that counts every attempt, a 40 GB byte budget
that counts failed transfers too, and a 75-minute deadline that also caps every release read (each at
most one minute), download, listing and file read, so a slow provider or
package cannot outlast the job. No release read or download starts after the
deadline; those targets are reported as `time-budget`. Targets that need no
further I/O keep their outcome after the deadline: a resolved skip, a package
reused from the checkpoint, a remembered failure, or a remembered unlistable
retry, which stays `unlistable`. Targets that share one package
attempt it once per run, including transient failures. The existing checkpoint
retains ordinary transient attempt order: fresh assets and the oldest deferred
attempts take precedence on the next run, without increasing any budget.
When a provider changes the digest or size metadata it supplies without proving
that the package changed, the next attempt still uses the package's previous order.
Successful scans and persistent failures leave that rotation. The scheduled run uses
`--complete-targets` with the canonical listings. It drops deferred attempts for
repositories with no remaining targets, or when every target for a repository resolves
to a different package from a complete release read. Scoped scans and failed,
incomplete or ambiguous reads preserve the previous attempt order. Every target not scanned
is reported with a stable code. Persistent targets are reported as not
scannable: `no-release`,
`no-single-asset`, `release-unavailable` (the release read answers with a
redirect, 404 or 410, for example a renamed repository), `asset-too-large`
(over the per-asset limit, also when a transfer of unknown size reaches it),
`digest-mismatch`, `encrypted-archive` and `unlistable` (no lister can read
the package). The checkpoint remembers `asset-too-large`, `digest-mismatch`
and `encrypted-archive` for a downloaded asset, so it is not fetched again
until its release, the rules or, for its size, the per-asset limit changes.
`unlistable` is remembered as a retry instead, because a lister or environment
fault can cause it too. Known retries are re-checked in rotation under their
own allowance (4 attempts and 2 GB by default, `--max-retry-assets` and
`--max-retry-bytes`), which never spends the main asset or byte budget. The
least recently checked come first, and the checkpoint records each retry's
last check (`checked_at`, a retry-run counter). A retry outside this run's
rotation or byte allowance is reported as `unlistable` again, never deferred,
so it cannot keep a port's coverage partial, and every retry is re-checked in
turn. A retry that now lists cleanly becomes an ordinary scanned record. Each
not-scanned target also names its provider. The rest (`time-budget`,
`asset-budget`, `time-cut`,
`release-read-failed` and `scan-failed` for transient network, provider or tool
failures) continues in a later run. The report (format 3) declares how many
targets the listings produced and a digest of that list, and a run with no
targets fails. Each record notes candidate files it could not read or did not
reach, and keeps at most 20 signals, sorted, with `signal_count` giving the
true total. The job summary lists findings first, each unaccounted finding is
also a workflow warning, and the report artifact keeps every record for 30
days.

A confirmed false positive, such as a homebrew test ROM, is dismissed in
[`.github/release-content-accounting.json`](../.github/release-content-accounting.json)
by a reviewed change. Each entry names the port, platform, package SHA-256 and
rules version, a reason, and the reviewed `boburning/portcove` issue or pull
request as evidence. The scan validates the file strictly against the listings
and fails on a malformed or duplicate entry, wrong evidence or an unknown port.
A finding that matches an entry under the current rules is reported as
`accounted` with that reason and evidence: the summary lists it separately and
it raises no warning. A new package digest or rules version is not covered, so
the finding returns for review. The summary also lists entries no finding
matched in that run (stale, or their target was not reached).
Nested archives and installers are listed only at their outer level.
Findings from the latest scheduled `main` report reach the
[maintenance inventory](MAINTENANCE-STORE.md#release-content) with their
listing and evidence, together with every target it could not scan. A
`complete` report opens one routine handoff per port, carrying its findings and
any package the scan could not inspect.

## Shared observations in preliminary package browsing

Core can reuse a complete, unexpired GitHub observation from the existing
signed descriptive directory when opening a non-managed project's package
chooser. It preserves the repository/release/asset identities, original
observation time, expiry and provider digest claim. The chooser dates the
reused metadata and explains that preview checks the selected file upstream.
This window never claims complete provider release history. Preview without
an observed prerelease, an unknown explicit release, stale/future-dated,
failed, incomplete, unavailable or malformed enrichment falls back to the
existing provider read. The observation is never retimed by a local read.

This projection does not enter managed release resolution or update checking.
Preview and acquisition retain the existing exact upstream candidate,
checksum/hold, destination, package and publication checks. Offline browsing
can display fresh retained metadata; offline acquisition retains its normal
failure. A report-only release can supply descriptive file facts without
creating a playable runtime or managed support.

The targeted HTTP-fixture measurement in
`service::catalog_download::tests::shared_observation_browse_counts_requests_and_keeps_exact_preview_live`
opens the package chooser for 1, 20 and 100 distinct game entries, including
shared repositories. It distinguishes baseline provider metadata reads,
repeated shared-observation reads and subsequent exact preview reads. This
is a browse-workflow measurement, not a forecast of managed library updates,
live production latency or payload-download savings. Existing signed listing
delivery supplies the reusable projection; this change creates no additional
feed, account, scheduler or publication grant.

The current CI-green main catalog publisher derives the existing
`policy/official/catalog.listings.json` target from the canonical directory plus
completed policies in the existing observer checkpoint artifact. The maintained
artifact reader binds the source workflow, run, commit, configuration and digest.
Only `upstream_observation` may differ from the current canonical row. Changes to
the repository, hints, restrictions, setup or operational route invalidate reuse.
Core exports the exact supplied directory to format 11 before enrichment; this
preserves its original guide and current strict-reader compatibility, while the
authored directory and public browse projection retain format 12 metadata.
Delivery encodes slash-containing GitHub tags as single URL segments after
checking the exact observed repository, tag and asset name. The observer
checkpoint keeps the provider's original URL and observation clock.
Delivery omits null provider digest fields to fit more observations within the
same byte limit. Core reads an omitted digest as absent, and publication counts
changes to the observation itself when tallying updates.
Newer clients retain their existing implementation descriptions when a format-11
row has the same project URL and exact original-game identity. The older delivery
cannot express that field; a format-12 delivery can explicitly clear it. Changed
projects or game/edition identities do not inherit descriptions.

Prior observations are reused only after the existing compiled repository
verifier succeeds, the exact logical target is referenced by its role, and its
physical bytes match the verified hash and length. Unavailable or partial source
reads preserve applicable prior facts and original clocks. Identical directories
retain exact bytes and revision. The unchanged signer still verifies the entire
prior repository and historical revision bounds before renewal. Publication uses
the existing official-policy namespace and keys.

The signed target reserves each previously admitted identity and each matching
operational catalog guide within the existing eight-MiB limit. Initial admission
uses the reviewed operational declaration even when an upstream observation is
unavailable. A previously signed identity missing from the canonical directory
requires an explicit withdrawal. The signer’s historical verification can renew
the exact previous bytes when current verification is unavailable. This path
makes no new admission or provider claim.

The projection reserves complete current guides and still-valid applicable prior
observations before filling remaining space with optional enrichment. Under
pressure it can omit an expired observation at its recorded freshness boundary.
Its receipt lists deferred enrichment and omitted discovery rows separately.
An over-budget required set preserves the published target and reports failure.
Omitted discovery rows use the client’s embedded fallback. Existing scheduled renewals refresh
optional observations, while unrelated main commits do not become changed solely
because the fixed source bundle omits this derived target.

The publisher can prepare a compact carrier at
`policy/official/catalog.listings.compact.json` after compatible clients ship.
It uses one gzip stream in a versioned JSON envelope with the decoded size and
SHA-256. The carrier has an eight-MiB limit and the decoded directory has a
32-MiB limit. Compact delivery retains all applicable canonical listings,
including implementation explanations and reviewed IGDB scenes when present.
The existing policy role signs the exact carrier bytes. The legacy
directory stays signed for older clients with its last bytes and never changes
again; compact delivery is the only live listing carrier
([minimum supported preview](SIGNED-CATALOG.md#compact-listing-delivery-and-the-minimum-supported-preview)).
Both carriers share a revision floor and must decode to the same bytes at
equal revisions. First compact publication and later format upgrades wait until
the publisher has verified the current released preview reader. Until then,
the publisher renews the prior listing targets exactly. The preparation report
records the verified reader version and digest. Compact preparation excludes
and reports an observer candidate that fails Core validation; the definitions
and the remaining candidates still publish.
If prior metadata has expired, the publisher first renews the exact known
targets through historical signature verification.

The maintained snapshot codec has a finite 180-second validation harness ceiling.
The previous 60-second budget failed during a real retained-checkpoint decode and
re-encode. Provider request deadlines, artifact/record byte bounds, Brotli window
checks, original observation expiry and cancellation checks remain independent.
Optional source failure does not prevent publication of the canonical bundle.
The generated Core fixture is produced by `projectListingObservation` and the same
target builder, then signed and reopened through the real cache in the Core test;
its synthetic fixed clock is not a live provider or production acceptance claim.

## Optional research-progress observations

The existing maintenance collection accepts `--progress FILE`, a bounded
format-1 source manifest. The reviewed initial scope is
[`scripts/upstream-progress/sources-v1.json`](../scripts/upstream-progress/sources-v1.json).
The existing daily maintenance job consumes it; no new scheduler or executor is
introduced. Collection uses the maintained discovery HTTP transport, its byte,
redirect, request and deadline limits, with a generic JSON/text Accept header for
external providers. GitHub-specific media types remain scoped to the GitHub API.
Each source failure is isolated and retains its last-good observation.
Progress-provider `Retry-After` applies to its HTTPS origin. Independent origins
can continue, while request, byte and time limits remain shared across the batch.

Adapters read ByteMatch and decomp.dev version-specific structured JSON,
frogress's exact reviewed project/version/category/measure, and project-owned
JSON or column-mapped CSV reports. They never discover ownership from a copied
badge, search title or shared name. Provider JSON must identify the configured
repository and exact edition; project-report URLs and methodology require
reviewed primary evidence. Source keys retain game, implementation, edition,
provider and report/measure scope, allowing several games to use one repository.

Records retain provider/evidence URLs, full source commit when available,
observation/check times, source-content digest and methodology. Matching code,
fuzzy similarity, linked code, matched functions and decompiled code remain
separate metrics. JSON numeric source tokens and integer counts retain their
original decimal precision; derived CSV/frogress percentages retain the raw
numerator and denominator. For example, Fire Emblem's frogress `code` counts bytes
in `src`, including potentially nonmatching code, and is described as decompiled
code rather than matching code. Display rounds downward below 100; milestone
comparisons use exact decimal/count arithmetic, so 99.999999999999999999 does not
become a completion claim. Neither 100 nor a published GitHub release grants a
playable package, admission, platform support or qualification.

Each source has an independent changes-only observation history and freshness
clock in the existing maintenance store. Polling timestamps do not rewrite
unchanged content. Failed reads do not advance its successful clock. Optional
`reconsider` names an existing recorded research condition, exact metric and
threshold. Only a changed condition result or comparability scope records a
transition; repeated reads stay quiet and A→B→A remains ordered history. The
existing changes-only digest can carry those transitions; dispatch remains
disabled. The initial source manifest deliberately sets no new reconsideration
conditions and creates no unsolicited progress notices.

A project opt-out on any configured source suppresses all its provider/fallback
reads. Current opt-out observations also suppress older progress rows and pending
historical notifications from newly generated reports/digests. Immutable private
store evidence remains retained for recovery; no public history reader bypasses
that current suppression. Re-enrichment requires an explicit reviewed source
change. Malformed stored optional progress, including unsafe links, is excluded
from the report and cannot affect player operations.

Provider disposition and live evidence on November 17, 2026:

| Source          | Disposition and exercised scope                                                                                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ByteMatch       | Implemented and exercised: OpenRAC/rac3-decomp, PAL SCES_524.56, version-specific JSON. The provider's [API contract](https://bytematch.dev/docs/api) documents this read shape.                                                                                                                                                                          |
| decomp.dev      | Implemented and exercised: doldecomp/melee, GALE01 JSON. The global `projects.json` index returned HTTP 410; collection does not depend on that retired index.                                                                                                                                                                                            |
| frogress        | Implemented and exercised: fireemblem8/us/default `code` and `code/total`, bound to the project's [upload template](https://github.com/FireEmblemUniverse/fireemblem8u/blob/3b89a0880e5b1b1d7c09ff3259608e8f1a233c46/scripts/progress-template.txt). Its [guide](https://github.com/decompals/frogress/blob/main/GUIDE.md) documents scoped latest reads. |
| Project reports | Implemented and exercised: Paper Mario US matching-code CSV from papermar.io, linked by the project's [README](https://github.com/pmret/papermario/blob/222af07f2ce4250c1eb70f751fefe8a8476fae96/README.md). Project JSON parsing also has fixture coverage.                                                                                              |

Direct generic HTTP probes initially received 403 from ByteMatch/frogress; that
was host/transport evidence, not proof of retirement. The maintained transport
exposed a GitHub-only Accept header causing frogress HTTP 406. After scoping that
header correctly, all four configured sources returned usable HTTP 200 reports.
The actual live observation packet is retained with the implementation evidence;
fixtures and a local manual read do not establish unattended production operation.

## Mod provider registry

The catalog observation job reads the
[Thunderstore ecosystem registry](https://thunderstore.io/api/experimental/schema/ecosystem-json-data/latest/)
on its existing cadence when the opportunity has request capacity. The public
read shares the job deadline and response budget and counts toward the same
request ceiling as the release providers. When Thunderstore defers a request,
the observer saves the retry deadline before unrelated source work. Its deadline
is independent of GitHub's retry clock.

The checkpoint retains the schema version, raw response digest, stable community
IDs, registry game UUIDs, listing states and exact GameBanana game links when
present. An incomplete response, unsupported schema or change to an already
observed identity keeps the previous complete snapshot and reports a coverage
gap. Maintenance reports expired observations as stale using the same
configured freshness bound. When saved registry evidence and new source progress
would exceed the existing checkpoint limit, the observer preserves the last
readable checkpoint and reports the storage hold. The maintenance inventory
records the registry as one discovery subject.
A community record supplies neither a canonical Portcove port mapping nor
runtime, package, installation or publication authority.
