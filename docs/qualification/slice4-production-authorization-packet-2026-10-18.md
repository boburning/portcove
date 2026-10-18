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
