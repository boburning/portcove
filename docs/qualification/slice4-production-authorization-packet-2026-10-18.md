# Slice 4 protected execution and custody decision packet

Owner: [#534](https://github.com/boburning/portcove/issues/534). This dated packet
refines the [accepted custody design](https://github.com/boburning/portcove/issues/534#issuecomment-5690295114),
its [custody amendment](https://github.com/boburning/portcove/issues/534#issuecomment-5999823580),
[execution amendment](https://github.com/boburning/portcove/issues/534#issuecomment-6107645487)
and [controller proposal](https://github.com/boburning/portcove/issues/534#issuecomment-6119064584).
It grants nothing. The runnable workflow remains admission-only. The
[held complete workflow](application-update-production.aggregate.yml) is outside
`.github/workflows`; its three new jobs also have literal false conditions.

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
unattended acceptance. The exact candidate admission consumer is still missing.

| Job                               | Proposed permissions                                    | Scope and destination                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission                         | `contents:read`                                         | Exact fixed workflow/source identity only                                                                                                                                                       |
| Independent input admission, held | `contents:read`, `actions:read`                         | Existing reservation plus complete independently accepted source/tree, qualification, policy, classification, pause and free-capacity facts; no candidate execution                             |
| Trusted package assembly, held    | `contents:read`, `actions:read`, `id-token:write`       | Bounded candidate archives; new same-repository `trusted-release-final-<own-run>-<attempt>` Actions artifact, seven-day retention, no overwrite; fresh own-job identity JWT kept only in memory |
| Attest, held                      | `contents:read`, `id-token:write`, `attestations:write` | Existing pinned `actions/attest`, custom aggregate predicate in GitHub repository attestation service; no package extraction or candidate checkout                                              |

There is no requested `contents:write`, Pages deployment, public Release upload,
feed mutation, package signing key, long-lived PAT or GitHub App installation in
this aggregate proof. Those production destinations/permissions remain a
separate exact activation decision under this same owner, after their consumers
and custody proof exist. Repository visibility is public; that observation does
not prove billing eligibility, available free runner minutes or storage budget.

## Input, candidate and reservation isolation

Only fixed controller code and pinned actions run in the proposed trusted jobs.
No candidate checkout, dependency installation, build hook, candidate executable,
archive extraction in the attester, shared build cache or production secret is
allowed. Opaque candidate archives pass existing subprocess byte/time limits,
raw ZIP preflight, private exact size/CRC/SHA-256 staging and full package policy.
Assembler source admission cannot stand in for candidate qualification.

`production-aggregate-steps.mts` recovers the existing coordinator namespace and
checkpoint before and after assembly, then again before binding. It requires
the existing active prepared commit/tree/version and frozen Release run/attempt
to match the independently admitted matrix. It never allocates another version,
changes the reservation, publishes coordinator state or clears failure evidence.
The exact namespace and checkpoint must come from the independent admission
consumer; dispatch JSON, a candidate checksum manifest and recovered journal
facts cannot authenticate themselves.

The missing consumer must acquire the accepted complete candidate/file matrix,
actual producer/isolation/qualification evidence and fresh policy/classification,
pause and free-capacity inputs through the accepted authority. Missing or partial
facts remain UNKNOWN and hold. Existing #532/#533 parsers preserve facts but do
not supply their authentication. This packet does not replace them with a new
classifier, inventory authority, recurring personal stamp or caller-supplied
`authorized:true`. The consumer and its source configuration must be reviewed
before removing any literal hold.

The assembler creates a new artifact rather than relabelling historical output.
The upload ID/digest feed the existing fresh own-job verifier and aggregate-member
checker. The attester receives only the resulting bounded structured predicate,
subject name and digest. Its certificate identifies the attester; the fixed
workflow's signed predicate associates the assembler job. Original compiler
identity remains unknown unless independently proven. Release authorization,
SBOM finalization, installed/native acceptance and #706 remain separate gates.

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

1. Finish and independently review the unavailable candidate admission consumer,
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

The proposed job ceilings are 5/5/30/5 minutes and seven-day artifact retention.
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
