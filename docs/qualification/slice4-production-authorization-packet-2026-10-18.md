# Slice 4 protected execution and custody decision packet

Owner: [#534](https://github.com/boburning/portcove/issues/534). This dated packet
refines the [accepted custody design](https://github.com/boburning/portcove/issues/534#issuecomment-5690295114),
its [custody amendment](https://github.com/boburning/portcove/issues/534#issuecomment-5999823580),
[execution amendment](https://github.com/boburning/portcove/issues/534#issuecomment-6107645487)
and [controller proposal](https://github.com/boburning/portcove/issues/534#issuecomment-6119064584).
It grants nothing. The runnable workflow remains admission-only. The
[held complete workflow](application-update-production.aggregate.yml) is outside
`.github/workflows`; its four new jobs also have literal false conditions.

## Proposed execution boundary

### Bounded unblock proposal — 2026-10-18

This section records recommendations, not appointed authorities or an execution
grant. Pickup found no commits on remote `main` after
`c65cb34bc707265c7cd6b1ae12fd490b476da897`. Fresh owner checkpoints retain #254
Closed/Done and #315, #534 and #246 Open/Blocked/Required. The sixteen delivered
component receipts remain scoped evidence. No old canary is eligible by reuse.

Read-only provider observations found repository rulesets 22155633 (main),
22334556 (release tags) and 24845568 (the exhausted controller canary). Main's
effective rules require the five CI contexts but zero approving reviews. A
merged PR alone therefore cannot authenticate semantic release classification.
The proposed new control refs below have no observed protection. Named pause
and controller variable reads, and the personal-account billing summary read,
were unavailable; these are coverage gaps, not proof of absence or free capacity.
The operator account was observed as `boburning`, numeric ID `43177418`.

### Recommended input authorities: decision D1

Use immutable Git input documents in this same repository and the existing raw
Git-object verification, classification parser and coordinator. These documents
contain no allocation, retry, publication phase or second journal. The existing
coordinator remains the only reservation and recovery authority.

| Input                   | Proposed exact location                                                                            | Authorized writer to appoint                                                                                                                                                                                                                             | Reader and interpretation                                                                                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewed classification | `refs/heads/portcove-release-inputs`, path `classification/<source-commit>/<net-tree-sha256>.json` | A dedicated GitHub App named `portcove-release-review`, installed only on repository 1354613114, with contents write and metadata read. Its numeric App/installation IDs must be recorded after owner-approved creation; a display name is insufficient. | Fixed controller's read-only admission job. Read the ref, fetch the exact commit/tree/blob, reconstruct object IDs and pass the complete opportunity to the existing #532/#533 parsers. Require the original source/tree/base and net-tree digest to match #2120 and the retained preparation intent. |
| Publication pause       | `refs/heads/portcove-release-pause`, path `publication.json`                                       | Existing repository administrator `boburning` (43177418), for rare pause/resume administration, not individual releases. No candidate job or classification App is an authorized pause writer.                                                           | Same fixed reader; exact document `{"schema_version":1,"publication_paused":true}` or explicit `false`. Missing/unknown fields, nonboolean values, unavailable protection, conflicting reads or a pause all HOLD.                                                                                     |

Appointing the review App and configuring these refs/rules is the owner decision.
Recommendation: no candidate credentials can update either ref. Use active
creation/update/deletion restrictions and non-fast-forward protection, with only
the review App allowed to update the classification ref and only the owner
administrator role allowed to update the pause ref. Verify the complete bypass
actor sets, actual administrator inventory and effective restrictions before
accepting inputs. A role that includes additional administrators is not evidence
of an owner-only boundary. Do not give the generic GitHub Actions App a bypass:
that would also authorize candidate workflows using the same App identity.

The dedicated App persists already independently reviewed classification; it
does not introduce a new semantic classifier or infer change kind from filenames,
green CI or an AI version guess. Its credential may be released only to a fixed,
separately reviewed writer workflow on its specifically protected ref, with no
candidate checkout, candidate commands, shared cache or candidate-supplied policy.
The owner must approve this new writer role and its credential boundary. App
installation tokens are scoped and short-lived; private App credentials stay
outside candidate jobs. No App or credential is created by this preparation.

The concrete proposed writer identity is
`.github/workflows/release-reviewed-inputs.yml` at
`refs/tags/portcove-production-controller-slice4-review-20261018-r1`, with App
credential access confined to environment `production-release-classification`
and that exact tag. This is a proposed workflow/ref/environment, not an existing
executed producer. Its reviewed source/digest, numeric App/installation identity
and the authenticated output boundary of the existing non-writing review process
must be bound before appointment is consumed. The App alone proves persistence,
not that a semantic review occurred. Approval of D1 enables this dependent writer
and reader implementation; it is not permission to accept an unidentified review
producer or run a protected candidate.

Classification documents use the existing whole opportunity fields: source and
base commits, source tree, complete change-set flag/digest, meaningful/docs-only/
urgency flags, channel and reviewed classification. Use
`portcove-release-net-tree-delta-v1` for the digest scope. A complete independent
review must cover semantic flags and compatibility, not merely the Git digest.
Record its exact inputs and reviewer evidence with the document; validate known
fields rather than treating an arbitrary `reviewed:true` as authority. Identical
input retries reuse the accepted record; changed source/base/tree/digest or policy
requires new dependent acceptance. Do not expire an otherwise identical frozen
classification merely because a queued opportunity advanced or a retry took time.

For both refs, acquire current protection and ref identities before and after
collection. Re-read the pause and authority configuration immediately before
each protected effect, within 60 seconds, and refuse any drift; never cache a
resume across jobs. Expiration of this read window requires a fresh read, not
another personal approval. A pause cannot undo an effect already committed;
recovery preserves that effect's evidence and blocks further effects. These
timing and reader rules are proposed adapter behavior, not implemented claims.

[GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
provide branch/tag restrictions and API-visible enforcement. Their documented
availability is not proof that the proposed actor sets are installed here.
Repository variables were rejected as the primary pause source: their values
and `updated_at` are readable through a separately permissioned API, but the
current job has no such permission, the record does not identify its writer,
and a value captured at job start cannot prove a later pre-effect read.
See the [variables API](https://docs.github.com/en/rest/actions/variables).

### Fresh zero-cost admission: decision D2 and provider capability gap

Use GitHub's own account billing facts, never cache byte totals or candidate
claims. Proposed usage source:
`GET /users/boburning/settings/billing/usage/summary?year=<UTC-year>&month=<UTC-month>`.
Its authenticated response must identify the account and current period; retain
the exact bounded response, acquisition time and product/SKU coverage. The
[documented user endpoint](https://docs.github.com/en/rest/billing/usage#get-billing-usage-summary-for-a-user)
requires a GitHub App **user** access token or fine-grained personal token with
Plan user permission read. An installation token or ordinary `GITHUB_TOKEN`
cannot be assumed to supply it. Recommend a separately protected, read-only
billing reader; no account token enters candidate or package jobs. Establishing
that credential boundary is D2, not implied by repository write access.

The proposed reader is `.github/workflows/release-capacity-inputs.yml` at
`refs/tags/portcove-production-controller-slice4-capacity-20261018-r1`, environment
`production-release-capacity`, using a dedicated `portcove-billing-reader` GitHub
App user authorization for account 43177418 with Plan read only. It has no
repository contents-write permission. GitHub's billing service is the fact
writer; the reader cannot set budgets or mint positive allowance facts. Its
fixed workflow and numeric App/user identities require verification before use.
Keep raw account responses in access-controlled evidence, outside public logs
and artifacts; expose only the bounded capacity disposition and its evidence
association to the existing admission consumer. No user token value is requested
in chat. This proposed reader still cannot overcome the capability limit below.

Positive capacity requires all of: standard public runners, current visibility,
no larger runners or paid fallback, provider-enforced zero paid spending, complete
current account-wide usage and allowance coverage, and conservative remaining
artifact/retention headroom for this candidate plus overlapping account use.
The current proposal remains five job ceilings of 5/25/30/5/20 minutes, seven-day
retention and existing archive limits; those limits are not a storage reservation.
Fresh reads must bracket admission and precede every storage-producing effect;
read age is at most five minutes, with no optimistic reuse across billing periods.
Missing, stale, partial, inconsistent or inaccessible facts mean
`free_capacity_available:false` and HOLD in the existing planner.

**Capability limit:** the published budgets REST API manages organization budgets;
its user scope describes users inside an organization, not the personal
`boburning` account's Actions budget. Do not invent a personal budget endpoint or
change repository ownership to obtain one. Usage summaries also do not establish
the current allowance or hard-stop configuration. The live usage read remained
unavailable. D2 must include an owner-controlled account-budget/settings readback
and an executable way to verify the needed invariant; approval alone cannot make
an unsupported or inaccessible provider read work. Until that exists, no positive
capacity adapter or protected run is represented as ready. A one-time screenshot
or declared budget cannot serve as a fresh per-run capacity verdict.

The [billing contract](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
distinguishes public standard runner use, accrued artifact/Packages storage and
separate cache allowance. The
[budget contract](https://docs.github.com/en/billing/concepts/budgets-and-alerts)
also warns about usage predating a newly created budget. Verify the actual
account controls; a zero-dollar notification or today's artifact count is
insufficient. No budget, payment setting or account credential was changed here.

### Exact current payload and staged execution decision

The reviewable implementation payload remains source
`c65cb34bc707265c7cd6b1ae12fd490b476da897`, tree
`d11d37cc726f86d0d7c6db422c95da1f95fd7056`:

| Item                                      | Exact proposed or observed identity                                                                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing runnable admission-only workflow | `.github/workflows/application-update-production.yml`, 2,254 bytes, SHA-256 `0765f9d51002761abf51108364470096f702abeb419f12cd82cff45ef8e12750`                                                                                                                       |
| Held aggregate workflow                   | `application-update-production.aggregate.yml` alongside this packet, 12,639 bytes, SHA-256 `bee2037f33ae9a317af0b93a49eede17ddb81298f83d77e12f69bae7c4fd0a35`                                                                                                        |
| Proposed new full execution ref           | `refs/tags/portcove-production-controller-slice4-aggregate-20261018-r1`                                                                                                                                                                                              |
| Proposed operator                         | `boburning`, actor `43177418`; first `workflow_dispatch` attempt only                                                                                                                                                                                                |
| Proposed coordinator namespace            | `portcove-production-slice4-aggregate`                                                                                                                                                                                                                               |
| Candidate/reservation                     | No currently eligible accepted reservation or complete retained Release artifacts were established. Do not copy the exhausted canary reservation or invent a new version/run. The existing coordinator must allocate once from complete accepted inputs after D1/D2. |

These are exact payload identities, not a final runnable aggregate controller.
The held file cannot be substituted for the runnable file under the latter's
digest. D1-selected adapters, D2 capability and executed-producer acceptance are
unfinished. It would be false to offer an execution grant against today's inert
workflow as if those changes were included. No protected execution approval is
requested at this stage. After D1/D2, finish dependent implementation, separate
review and exact-head CI, then replace this row with the actual final controller
commit and workflow digest and the real existing-journal candidate/reservation.
Any subsequent source, permission, digest or boundary change invalidates that
dependent execution decision and must be reconciled before dispatch.

For that later **aggregate-only** decision, retain the job permission/destination
table below: contents/actions read for input and verification, own-job OIDC for
assembly, attestation/OIDC write only for attesting, immutable same-run Actions
uploads and repository attestations, seven days, no overwrite. A new ref requires
observed provider protection; the canary ruleset does not cover it by analogy.
Preflight observes all controls and exact reservation, executes one admitted
attempt, verifies fresh producer/artifact/bundle identities, then exercises only
the specifically admitted refusal/interruption/recovery cases. Existing
first-attempt policy means a retry needs an eligible admission, not a blind rerun.

Assembly/attestation does **not** finish #534. Payload signing, immutable public
Release publication, application metadata signing, Preview promotion, Pages feed
publication, snapshot/timestamp finalization and their readback/recovery still
need their separately scoped permissions, keys and exact destinations. Stable
promotion remains outside the initial proof. The existing custody section and
production environments remain required; root/targets custody is manual evidence,
not supplied by GitHub OIDC or this aggregate's attestation certificate.

### Catalog decision D3 and honest #246 baseline

Recommend the same static host with separate catalog origins:
`https://boburning.github.io/portcove/catalog/metadata/` and
`https://boburning.github.io/portcove/catalog/targets/`. These are proposed locations;
no TLS/content/deployment availability is claimed. No application-update root,
key, target path or grant is reused. D3 appoints the catalog authority and scoped
publisher, not an application signer or all-port publisher.

Use the existing fixed-anchor TUF contract: independent catalog root threshold
2-of-3, separate offline targets, snapshot and timestamp material; terminating
`official-definitions` delegation exactly `definitions/index.json` and
`sha256/*.json`; distinct `official-policy` signer exactly
`policy/official/*.json`; launch-assessment targets use that same existing
`official-policy` role at `policy/official/<stable-id>.launch.json`, with the
existing exact bindings and checks. Public key fingerprints, signed root
bytes, expiry/rotation policy and custody evidence are still absent. Do not
generate or install a provisional root. D3 enables their preparation through the
existing process; physical quorum/backup/loss/rotation observations cannot be
replaced by an approval.

Recommended initial expiry ceilings are root 365 days, top-level targets 90 days,
definitions/policy/snapshot seven days and timestamp 24 hours, with renewal before
expiry through the separately authorized fixed publisher. These are proposed
policy settings for the eventual exact root/metadata review, not current signed
versions or permission to use keys. D3 does not approve unidentified key material;
record and review the resulting public fingerprints and signed bytes before
shipping the configured baseline or signing targets.

For Gen2, recommend scope `official/gen2recomp-gold`, template `generated-cache`,
Windows x86-64, repository `UNDERdecoded/Gen2Recomped` (numeric ID 1328250646),
`github.com` plus `release-assets.githubusercontent.com`, at most one redirect,
and only the schema-2 managed install/update/prepare/launch set. Verify that
numeric repository identity against retained and fresh provider records before
granting it; the proposal is not a signed policy. Use the actual ZIPs, not MSIX
installation as a substitute for the existing route:

| Release   | Release / ZIP asset       | Bytes / provider SHA-256                                                        |
| --------- | ------------------------- | ------------------------------------------------------------------------------- |
| `v0.7.49` | `387619558` / `559511636` | 15,382,734 / `66781ce17aa55c77d1cb21dd0d0f76e465db3ddae862fdf7a1b4b12530e98287` |
| `v0.7.50` | `387832535` / `560829469` | 15,593,494 / `fed3bd31fd263d14b09316c53f5dcae9592396cd6d3ba38cbbc5c724f0438ffc` |

These exact retained provider observations and static inspections support the
ordinary artifact and compatible correction legs independently of Chameleon.
The actual Shipwright scheduled receipt remains observation evidence for its
own target, not a Gen2 scheduled event or protected publication. Reuse it only
where target-specific observation is not required; collect the selected target's
actual configured scheduled observation for final combined proof.

**New-definition constraint:** all three Gen2 stable IDs already occur in the
96-port compiled catalog at this payload. A first authenticated managed revision
is not, without an explicit accepted interpretation, a definition absent from
that client. Preserve those entries. Do not delete them, alias IDs, edit the
database, inject qualification content or declare the minimum demonstrated.
Gen2 is ready as an artifact/correction proposal, not a proved complete minimum.
The strict new-definition leg requires a genuinely absent supported definition
or an actually existing capable ordinary baseline predating it. Neither was
established here. No weaker acceptance interpretation is recommended silently.

The ordinary baseline recipe is a release-profile `portcove-cli` build with
default features, no `qualification-fixtures`, after the authorized public root
is compiled at `crates/portcove-core/catalog/official-definition-root.json`, and
before publication of the selected genuinely new definition. Record source/tree,
Cargo.lock, compiler/target/features, compiled catalog/root hashes, executable
SHA-256 and size, API/engine capability output, canonical isolated library identity,
and configuration. Use `catalog definition-authority` review and its exact
`--apply --expected-plan ... --yes` consent only under that grant. Capture initial
absence through ordinary Core/CLI state before delivery. Current root bytes are
literally `null`; no positive capable binary, package hash or initial-absence
observation can honestly be manufactured from that state. A configured build is
a new baseline, never a relabelled old executable. Its executable and compiled
catalog stay fixed through authenticated refresh, real artifact progression and
safe correction; retain install/staged/previous/source/save/pin and hold readback.

The concrete build command is
`cargo build --release --locked -p portcove-cli --bin portcove`; the selected
Gen2 capability requirement is `generated-cache`, contract version 1, window
`[1,1]`. Use an isolated baseline library, not the ordinary user library. Run the
fixed binary's `catalog check-capabilities`, `catalog definition-authority`,
`catalog status` and `catalog definition-refresh gen2recomp-gold` surfaces;
metadata/target URLs use the two catalog origins above. Capture the actual
binary/package and library identities when they exist; the recipe is not an
already-built client identity or proof of initial absence.

For Chameleon, D3's **separate schema-4 scope** is limited to
`official/chameleon-twist-jp-recompiled`, template `n64-recomp-portable`, Windows
x86-64 and repository 803577244, with the same two hosts and redirect bound.
It requires both `curated_acquisition_checks:1` and `scoped_launch_checks:1`, the
existing coupled operations, exact definition/index hashes and monotonic policy
revision. Use the existing prepared release 190757282 / asset 213295268 / commit
`a2c5cbb4fbf3ca01a2f8bec4614c5aab1eb188f9` and expected archive digest, not a
blanket publisher grant. Independent provenance review can be completed now;
protected acceptance and the signed policy remain unset. No reopening of #245,
new per-artifact owner ritual or inherited compiler/native proof is introduced.

Use the repository's GitHub Actions principal and job-scoped `GITHUB_TOKEN` in
repository `boburning/portcove`, immutable numeric identity `1354613114`, on
GitHub-hosted Ubuntu 22.04 runners. A fixed operator numeric actor ID, protected
tag, exact controller commit and exact workflow SHA-256 must be separately
ratified in `PORTCOVE_CONTROLLER_ADMISSION`. None is selected by this packet.
The accepted pattern is
`refs/tags/portcove-production-controller-<reviewed-name>`; the final full ref,
commit and digest must be written into the owner grant and verified against
provider protection before any activation. A pattern alone is insufficient.

The only proposed initial trigger is `workflow_dispatch` at that exact protected
tag, first attempt only, with the admitted triggering actor unchanged. No push,
PR, reusable workflow, candidate descriptor input or schedule is introduced.
Routine independently eligible cases must eventually run without per-candidate
personal approval. This initial bounded proof trigger does not demonstrate that
unattended acceptance. The candidate admission consumer now acquires bounded
provider facts, but still always holds pending independently authenticated
control and executed-producer acceptance.

| Job                               | Proposed permissions                                    | Scope and destination                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission                         | `contents:read`                                         | Exact fixed workflow/source identity only                                                                                                                                                       |
| Independent input admission, held | `contents:read`, `actions:read`                         | Existing reservation plus complete independently accepted source/tree, qualification, policy, classification, pause and free-capacity facts; no candidate execution                             |
| Trusted package assembly, held    | `contents:read`, `actions:read`, `id-token:write`       | Bounded candidate archives; new same-repository `trusted-release-final-<own-run>-<attempt>` Actions artifact, seven-day retention, no overwrite; fresh own-job identity JWT kept only in memory |
| Attest, held                      | `contents:read`, `id-token:write`, `attestations:write` | Existing pinned `actions/attest`, custom aggregate predicate in GitHub repository attestation service; no package extraction or candidate checkout                                              |
| Verify, held                      | `contents:read`, `actions:read`                         | Exact aggregate and dedicated bundle artifact IDs/bytes, existing pinned certificate/predicate verifier and reservation readback; no OIDC, signing or publication                               |

There is no requested `contents:write`, Pages deployment, public Release upload,
feed mutation, package signing key, long-lived PAT or GitHub App installation in
this aggregate proof. Those production destinations/permissions remain a
separate exact activation decision under this same owner, after their consumers
and custody proof exist. Repository visibility is public; that observation does
not prove billing eligibility, available free runner minutes or storage budget.

## Input, candidate and reservation isolation

Only fixed controller code and pinned actions run in the proposed trusted jobs.
The unprivileged input gate installs the fixed controller's frozen dependencies
into a fresh private store, with scripts and pnpmfile hooks disabled, before its
read-only token is supplied. Assembly and attestation require no dependency
installation; a clean temporary-copy import test checks the assembler without
`node_modules`. No candidate checkout, build hook, candidate executable, archive
extraction in the attester, shared build cache or production secret is allowed.
Opaque candidate archives pass existing subprocess byte/time limits,
raw ZIP preflight, private exact size/CRC/SHA-256 staging and full package policy.
Assembler source admission cannot stand in for candidate qualification.

`production-aggregate-steps.mts` reads the existing coordinator namespace and
checkpoint before and after assembly, then again before binding. It requires
the existing active prepared commit/tree/version and frozen Release run/attempt
to match the independently admitted matrix. It never allocates another version,
changes the reservation, publishes coordinator state or clears failure evidence.
The exact namespace and checkpoint must come from the independent admission
consumer; dispatch JSON, a candidate checksum manifest and recovered journal
facts cannot authenticate themselves.

`acquire-release-admission.mts` enumerates complete bounded tag and Release
inventories, validates the existing paired preparation/source receipts and
recovers the existing checkpoint through the full state validator. It reads
required exact-head checks with fixed GitHub Actions issuer identity and the
frozen Release run/attempt, then derives the complete policy file matrix from
provider-digested opaque archives. Checks/statuses, run/jobs/artifacts,
publication/reservations and checkpoint are reread after acquisition; changed
facts refuse. Raw snapshot reads in the assembler preserve the same immutable
checkpoint association without importing the planner's package dependencies.

The existing journal can additionally retain an optional immutable
`frozen_opportunity` at allocation, equal to the whole preceding preparation
input. It is never backfilled into legacy active states. The input gate binds
that original classification to complete bounded source comparison and
cryptographically reconstructed tree inventories using the explicit versioned
[net tree delta encoding](../RELEASING.md#frozen-source-consistency). Queued source
changes cannot substitute for it. Net difference is consistency evidence, not
semantic classification or source authority. Missing frozen evidence and opaque
legacy hash scopes hold; mismatches refuse. Existing checkpoint and acquisition
limits remain. This adds no source-selection authority or positive descriptor.

These are acquired facts, not independent acceptance. Producer JSON is only a
declaration. Historical original-source/routine publication attribution can
remain unknown. The gate still needs actual executed-workflow/producer/isolation
acceptance and authenticated fresh classification, pause and free-capacity
inputs through the accepted authority. It emits no descriptor and always holds.
Its conservative paused planner invocation is a schema diagnostic only.
Missing or partial
facts remain UNKNOWN and hold. Existing #532/#533 parsers preserve facts but do
not supply their authentication. This packet does not replace them with a new
classifier, inventory authority, recurring personal stamp or caller-supplied
`authorized:true`. The consumer and its source configuration must be reviewed
before removing any literal hold. Controlled injected-provider tests cover
pagination, duplicate/truncated and drifting inventories, source/issuer mismatch,
qualification/job changes during downloads and secret-free failure retention;
they establish no live producer or protected execution proof.

The assembler creates a new artifact rather than relabelling historical output.
The upload ID/digest feed the existing fresh own-job verifier and aggregate-member
checker. The attester receives only the resulting bounded structured predicate,
subject name and digest. Its certificate identifies the attester; the fixed
workflow's signed predicate associates the assembler job. Original compiler
identity remains unknown unless independently proven. Release authorization,
SBOM finalization, installed/native acceptance and #706 remain separate gates.

The attester normalizes its actual completed public bundle into one bounded
`aggregate-attestation.json` and uploads only that file without overwrite. The
separate held verifier receives exact upload IDs/digests through trusted job
outputs and candidate facts through the independently admitted descriptor. It
never derives expectations from an unverified bundle. Direct controller
run/attempt and artifact reads are bracketed around download and verification;
the controller is still active, so the completed-Release collector cannot be
used here. The opaque bundle ZIP must contain exactly that fixed member, with
size/CRC checks before invoking the existing certificate/predicate verifier.
Acquired opaque inputs and sanitized failure association are retained in owned
private directories. The job retains bounded orchestration/result metadata.

Controlled tests exercise this integration and the actual held normalization
script, including changed identities, expired objects, changed bytes,
extra/aliased members and oversized metadata. Successful injected CLI output is
a synthetic verification boundary, not cryptographic or hosted execution
evidence. The four literal holds and missing independent control acceptance
remain. Aggregate verification confers no original compiler identity or
release authorization.

## Key roles and manual custody

Preserve the accepted design: three distinct offline root keys with a two-of-three
signing threshold in three independent locations, each location holding copies
of only one root key, with targets custody separately held in a fourth location;
backups of every online key and a preauthorized successor
payload key. Do not generate new production keys or reinterpret this as an
implemented ceremony. The owner must name custodians, locations, media and
independent recovery access outside public issues and chat. Never paste keys,
recovery secrets or bearer credentials into chat, logs or artifacts.

Application payload/targets/feed authority remains distinct from catalog root,
schema-4 publisher scope and curated acceptance. #246/#315 cannot inherit those
grants from an application attestation or this workflow. Their exact root/feed
destinations, publisher scope, expiry, sequence and provisioning transport still
require the owning explicit authority and independently accepted artifacts.

Before any key is used, prove offline backup readability, quorum restoration,
online-key loss recovery, the signed successor/rotation bridge and compromise
response with the existing verification paths. Record only public fingerprints,
identities and evidence references. Pause publication on compromise; preserve
current roots and rollback/replay protections until a verified authorized bridge
exists. Loss of the sole unbacked key is not recoverable by weakening signatures.

## Bounded activation and proof sequence

1. Finish and independently review candidate admission's missing authenticated
   control and executed-producer acceptance,
   exact permission proposal, source-bound qualification and fresh budget source.
   Required exact-head CI and held-template checks must pass. No runtime privilege
   is needed to merge this inert preparation.
2. Obtain the owner's exact grant for the principal/actor, full protected ref,
   controller commit/workflow digest, namespace/protection, permissions and proof
   scope. Verify actual provider enforcement and $0 capacity. Do not consume an
   available token as permission or silently select the retained exhausted ref.
3. Only then prepare and review the runnable workflow replacement and provision
   the granted boundary. Select a newly eligible, specifically admitted existing
   reservation and candidate. Do not redispatch an exhausted canary or start a
   full Release for convenience. The latest retained Release inventory observed
   in this work has zero current artifacts; no reusable bytes are claimed.
4. Execute once within the explicit proof budget. Collect exact controller and
   candidate commit/tree, run/attempt/numeric jobs, new artifact ID/digest, bounded
   archive/member readback, attestation bundle and independent pinned consumer
   verification. Preserve all original failures and ambiguity.
5. Exercise the required refusal/interruption/recovery cases within the same
   authority. Pause by disabling future admission, preserve the existing
   reservation and append-only receipt identity, reconcile any ambiguous upload
   or attestation through exact readback before any retry. First-attempt policy
   forbids assuming a rerun is admitted. No automatic overwrite, new version,
   clearing failed receipts or paid-overage fallback.
6. Reconcile the actual outcome on #534. Only the separately granted signing/feed
   and capable-client paths may then supply #246/#315 protected delivery proof.

The proposed job ceilings are 5/25/30/5/20 minutes and seven-day artifact retention.
Input acquisition has a 15-minute overall bound, at most 160 API reads with
120 seconds cumulative API transport time, bounded independent recovery reads,
16-page/1,600-record inventories and four policy-selected archives of at most
512 MiB each (2 GiB total). Its 25-minute job ceiling also accommodates fixed
dependency setup and diagnostic collection. These are refusal limits, not a
promise that every repository history will fit. Oversized history holds until
an explicitly reviewed existing-source strategy can prove completeness.
The new verifier permits eight direct provider reads, two bounded opaque
downloads and one existing 30-second CLI verifier invocation within ten minutes;
its 20-minute job ceiling also accommodates two existing bounded reservation
reads and setup/collection. Bundle ZIP input is at most 1 MiB compressed and
512 KiB expanded; aggregate input retains the existing 512 MiB limit. This inert
ceiling is not a free-capacity claim or permission to dispatch.
The held jobs use `always()` retention for bounded orchestration JSONL receipts,
the declared predicate and any completed public attestation bundle. A receipt is
created exclusively before effects, appends its terminal stage without exception
text, and refuses repeated use before another operation. It contains only the
descriptor hash/checkpoint association, status and stage; bearer tokens and raw
provider responses are excluded. Acquisition errors retain the owned partial
directory, bounded phase, checkpoint if known and API count; arbitrary exception
text is omitted. This is diagnostic metadata, not retention of
every failed payload. Hard runner loss, cancellation and ambiguous uploads still
need the specifically authorized recovery proof and exact remote readback.
Assembly's existing 15-minute bound and archive limits still apply. Concurrency
is one fixed controller group with cancellation disabled. These ceilings bound a
proof; they do not certify free capacity. No dispatch, OIDC request, upload,
attestation, signing, protected configuration or publication was performed for
this preparation. Real protected execution/refusal/recovery and manual custody
remain unproven, so #534 stays open.

OIDC runner variables and job permission semantics follow the
[official GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).
The implementation additionally bounds the request/response, refuses redirects,
and never persists or emits the bearer token. Endpoint compatibility still needs
actual admitted-run observation; synthetic tests do not prove it.
