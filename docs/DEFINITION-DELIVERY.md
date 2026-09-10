# Independent definition delivery contract

This is the successor design for #245. It does not extend signed catalog format
1, admit a new port, provision a publisher, or activate automatic delivery.
`portcove-core` remains the sole definition, admission and lifecycle authority.
The CLI and Tauri expose its outcomes; React and external clients present them.
The Project owns scheduling, #397 owns client implementation, #398 observes
upstreams, and #246 owns the protected publication and unchanged-client proof.

## Implemented engine capability negotiation

Core advertises each of the seven installed `AdapterKind` templates with contract
version 1. These versions describe the implemented combinations below; they do
not imply support for loading successor definition bundles. A new incompatible
template contract must receive a new version alongside its implementation and
compatibility evidence. Definitions cannot supply engine implementations.

API schema 45 exposes the inventory as `capabilities.engine_templates`. The CLI
`catalog check-capabilities <file>` and Tauri `check_definition_capabilities`
delegate to the same core negotiation. Tauri `get_engine_capabilities` returns
the core capability document. No library, network, trust grant, or lifecycle
mutation is involved in the requirement check.

The standalone requirement document is deliberately smaller than a definition
bundle: at most 64 KiB, with 1–64 unique requirements. Contract schema 1 accepts
only `capability_contract_schema` and `required_capabilities`. Each requirement
has `template` (1–255 lowercase ASCII letters, digits or hyphens),
`minimum_version` and `maximum_version` (positive inclusive integers, ordered).
Unknown fields, duplicate templates, invalid ranges and unsupported request
schema versions are rejected. For example:

```json
{
  "capability_contract_schema": 1,
  "required_capabilities": [
    {
      "template": "n64-recomp-portable",
      "minimum_version": 1,
      "maximum_version": 1
    }
  ]
}
```

A valid request returns one result per requirement: `supported`,
`unsupported_template`, or `unsupported_version`, retaining the requested range
and the installed version (null for an unknown template). `compatible` means all
requirements matched. Unsupported entries do not erase the other results. The
CLI exits successfully after a valid check even when `compatible` is false;
callers must inspect that value. Malformed requests use the normal error envelope.
Neither successful negotiation nor a supported adapter establishes publisher
trust, source admission, artifact integrity, or permission to install or launch.

## Decision and threat model

Use a catalog-specific TUF repository with maintained Rust `tough`, consistent
snapshots and content-addressed definition targets. Authoring can remain in this
repository. A static HTTPS origin suffices; no account, paid service, persistent
device identifier, new source repository or always-running backend is required.
Application-updater and catalog roots, delegates, credentials and target paths
are separate. Catalog authorization cannot replace application code or introduce
engine capabilities. The TUF feasibility tests under the updater trust design
establish the selected library's cryptographic primitives, not catalog admission.

| Alternative                                                         | Decision                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Extend the format-1 signature while relaxing its embedded allowlist | Reject: old clients must keep their exact format-1 behavior, and this does not supply scoped delegation or compromise recovery.      |
| Git tags, unsigned manifests or TLS alone                           | Reject as the client trust boundary: mutable hosting/transport state does not establish freshness, replay floors or publisher scope. |
| Sigstore-only observations                                          | Useful optional provenance; not the sole offline catalog/update/recovery policy.                                                     |
| TUF plus core-owned typed definition validation                     | Select: maintained freshness, replay and delegation machinery with separate semantic admission.                                      |

Assume hostile metadata, an untrusted candidate branch, compromised online
publisher or CDN, interrupted writes, malformed archives, mixed client versions
and conflicting definitions. Protect source/execution identity, mutable-data
ownership, exact retained contracts and trusted acceptance. The design does not
claim confinement for launched native programs, protection from a local attacker
rewriting the database, recovery of a replay floor after an entire database
rollback, or a trusted clock when the host clock is wrong.

## Identities and five independent facts

A definition is `(namespace, stable_id, revision, content_sha256)`. Revision is a
positive monotonic integer within that identity; equal revision with different
bytes is a conflict. Display names, upstream tags and download URLs are not
definition identity. Existing official IDs remain externally unchanged: the
internal namespace `official` must not rewrite installed IDs or CLI arguments.

| Identity          | Exact binding                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine capability | Installed engine capability identifier and supported contract version; capabilities are shipped/reviewed code.                                                                      |
| Definition        | Exact canonical target bytes, definition revision and all referenced source/execution/persistence contract bytes.                                                                   |
| Upstream artifact | Publisher/repository, release ID/tag, asset ID/name, platform, size, SHA-256 and independently established acquisition provenance. A new release is not a new definition by itself. |
| Runtime/tool      | Exact artifact identity, permitted mount/executable, immutable files, host-tool probe identity and required capability.                                                             |
| Evidence          | Check/version, exact inputs and artifact/definition/source/platform identities, environment, observation, outcome and limitations.                                                  |

Core exposes five separate facts, preserving the source and evidence contracts
already defined by #178/#184/#201:

1. Operation eligibility and stable reason codes, scoped to operation, artifact,
   platform and source variant.
2. Publisher/source trust and official, community or local origin.
3. Artifact integrity and digest provenance, including whether acquisition was
   authenticated or bytes were only observed locally.
4. Game-file compatibility and admission: exact identity, representation,
   supported variant and operation requirements.
5. Scoped evidence and health; synthetic lifecycle, real artifact, physical
   platform and gameplay observations retain their distinct scopes.

No aggregate trust score, LLM confidence, popularity, gameplay count, upstream
channel or Project stage substitutes for one of these facts. A signature says
who authorized bytes, not that those bytes are safe or playable.

## Typed engine vocabulary

The first successor maps the existing adapters to supported combinations of the
operations below. It does not require rewriting every adapter or inventing a
general recipe interpreter. Existing catalog data remains the expression of
port-specific facts. A supported combination is a versioned engine template;
listing several individually supported operations does not authorize arbitrary
composition, ordering, output types or widened paths.

| Operation                   | Inputs and outputs                                                                                       | Permitted authority                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolve/download            | Scoped upstream selector -> exact release/asset and bounded immutable bytes                              | Approved repository identity and explicit asset hosts/redirect rules; no ambient credentials.                                                 |
| Validate/materialize source | Existing source-catalog contract and selected exact input -> admitted representation under owned staging | Read selected source; copy/convert only through implemented validators and declared transformations.                                          |
| Extract/install             | Verified artifact and executable/runtime contract -> staged immutable install                            | Existing archive, symlink, executable ambiguity, lock and atomic-activation protections.                                                      |
| Prepare generated data      | Admitted source plus implemented template/tool identity -> declared validated output manifest            | Existing bounded managed preparation, cancellation and output checks; no downloaded shell/YAML/JavaScript.                                    |
| Launch selected game        | Exact retained install, admitted inputs and typed launch arguments -> observed game session              | Explicit selected-game execution through the existing child-process policy. This is not an OS sandbox.                                        |
| Preserve/restore            | Retained mutable-data contract and explicit operation intent -> verified owned data/backup               | Existing persistent-data manifests, per-port locking, transactional replacement and recovery; no new ownership inferred from path correction. |

Representative capability families are simple portable binaries (`n64-recomp-
portable`), generated data (`generated-cache` and `libultraship-portable`), exact
disc input (`referenced-disc` and `psx-recomp-managed`), staged file sets, and the
bundled-runtime/named-save combinations used by Severed Chains. They are examples,
not a finite catalog whitelist. Upstream-managed setup remains limited to the
exact implemented template, known executable/tool and admitted inputs.

Each newly introduced template requires redistributable success, missing and
malformed input, output validation, interruption/retry and preservation fixtures.
Existing reusable coverage includes exact source/archive validation, transactional
runtime source replacement, managed raw-disc immutability, generated-cache input
contracts, runtime checksum/collision/cancellation failures, and named-save
activation, rollback, restore and reinstall. These tests establish capabilities;
they do not qualify an arbitrary downloaded port artifact or gameplay.

## Admission and escalation

The executable decision examples accompanying this contract are design fixtures,
not a second production validator. #397 must implement this contract in core and
reuse those cases. Installed core policy owns supported schemas/templates and
publisher grants; incoming data cannot declare itself supported or approved.

| Observation within the exact operation scope                                                                                             | Result                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted publisher, supported contract, authenticated exact input and mandatory deterministic checks pass                                | Eligible for automatic definition availability, including a new stable ID and zero gameplay reports.                                                      |
| Existing selector already resolves the next upstream release                                                                             | No definition PR required; observe, authenticate and qualify the distinct new artifact normally.                                                          |
| Safe metadata/relative-path/selector correction within the accepted template and grant                                                   | Admit after deterministic checks; existing installs retain their original definition.                                                                     |
| Same recorded asset identity now yields different bytes                                                                                  | Hold the replacement; retain the pinned identity and verified current install. Never silently repin.                                                      |
| Missing independent expected integrity, unsafe archive, mismatched source, ambiguous executable or failed mandatory check                | Hold/reject only the affected operation/artifact/platform/variant.                                                                                        |
| Optional ROM fixture absent or gameplay missing/stale                                                                                    | Evidence remains Not run/Unknown. Definition availability is not universally blocked. An operation requiring that actual input waits for it.              |
| New publisher authority, ambiguous identity, unsupported template, arbitrary setup code, wider access or unsupported ownership migration | Escalate the exact trust/engineering change; preserve unaffected usable versions.                                                                         |
| New safety-critical field or unsupported contract version                                                                                | Isolate that entry. Unknown fields in a safety-critical contract fail closed; an explicit bounded presentation `extensions` map may carry ignorable data. |

Eligibility never starts installation or migration. User pins, keep-current versus
disabled game updates, explicit operation consent, sessions and busy locks still
govern execution. Channel changes for the application do not opt games into previews.

Publisher grants bind a namespace, upstream repository's stable provider identity,
allowed operations/templates, exact artifact identity scheme, permitted HTTPS
hosts and redirect policy. A domain or organization allowlist alone is inadequate.
Repository transfer/rename or new artifact hosting must be reconciled against the
grant; a reused textual repository name is not continuity of authority.

## Acquisition decision

Retain authenticated upstream expected SHA-256 or the existing narrowly reviewed
direct-manifest provenance. Read-only API observations distinguish missing API
digests from independently published checksum assets; neither is inferred from a
same-download hash. The dated inventory linked from the issue records current
observations and known legacy adoption failures without admitting those assets.

Do not add a general curated-legacy pinning authority for the minimum #246 proof.
Use a redistributable candidate whose acquisition identity can be authenticated.
Repeated hashing establishes repeatability, not original authenticity. An existing
verified cache may be reused only against its retained trusted expected identity.
Wrong bytes, ambiguous sidecar checksums, missing provenance and changed asset IDs
remain explicit outcomes; a fresh digest does not silently repair a recorded
same-identity replacement. No new DirectManifest exception or source-build
workaround is introduced by this decision.

If legacy acquisition later warrants #315, its separate proposal must bind narrow
repositories/assets/platforms, exact observed bytes/size, origin/provenance,
explicit distinct consent, cache reuse, withdrawal/revocation and recovery. The
owner must authorize that new trust authority before implementation/activation.
Existing direct-manifest pins and permitted installed use survive this design.

## Delivery, compatibility and retention

The successor target bundle has its own versioned schema, independent of source
catalog schema 2 and signed envelope format 1. Its outer index is bounded and
strictly validated before entry processing. Each content-addressed entry includes
stable identity, revision, capability requirements, exact source/execution/
persistence contracts and referenced artifact/evidence identities. Bound entry
count, individual and total bytes, depth, path lengths and fetched references;
reject cycles and missing references. No reference can become an executable URL.
The initial content contract uses a 4 MiB index, at most 4,096 entries, 4 MiB per
entry, 32 MiB total fetched definition/contract content, depth 32, at most 1,024
references per entry, and 255 UTF-8 bytes per relative path component. Existing
stricter core path/archive limits still apply. TUF metadata retains the maintained
client's own separate limits. An unsupported larger document cannot evict the
current catalog; raising a client resource bound is a reviewed engine change.

Each entry's required fields are `definition_schema`, `namespace`, `stable_id`,
`revision`, `required_capabilities`, `port`, `source_contracts`,
`execution_contract`, `persistence_contract`, `artifact_bindings` and
`evidence_references`. `port` projects through the existing core `PortDefinition`
schema. Every referenced record is content-addressed and carries its exact bytes,
schema version and identity; a relative target reference must resolve inside the
authenticated index. Capability requirements identify an installed template and
an exact supported version interval, not a candidate-provided implementation.
Presentation extensions are explicitly segregated from these required fields.

| Client/content combination                            | Required behavior                                                                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing client + format 1                            | Unchanged embedded-contract restrictions and normal fallback.                                                                                                   |
| Successor client + existing embedded/format-1 content | Lossless core projection; preserve every current stable ID, source, install, save/config and external command. Representation alone cannot remove availability. |
| Successor client + supported new definition           | Same core loader and lifecycle path; no per-port React or CLI dispatch change.                                                                                  |
| Successor client + unsupported new entry              | Isolate new work, retain exact existing definitions; do not discard the complete usable catalog.                                                                |
| Old CLI + newer library/contract writer               | Apply existing schema/lock/protocol refusal rules. No mixed unsupported writers or invented compatibility.                                                      |

Before staging, installation or adoption can commit, retain all exact referenced
contract bytes and their digest bindings in library-owned immutable storage,
alongside definition revision, artifact, runtime/tool, platform, source identity,
grant/policy version and provenance. Installed, staged, previous, adopted and
rollback-retained versions reference these records transactionally. Neither a URL
nor a current catalog lookup can reconstruct an old version's ownership. Adopted
content records what was verified and what remains unverified; adoption is not a
downloaded-artifact trust upgrade.
An existing explicitly authorized local/adopted launch may remain permitted
against its retained local identity and valid bytes without claiming authenticated
upstream acquisition. That local execution authorization cannot authorize a new
unauthenticated download, suppress corruption/revocation, or silently become an
official publisher grant.

Refresh may update discoverable definitions, but must not reinterpret an existing
install's mutable paths, source mapping or launch contract. Compatible migrations
need an explicitly supported reusable template, old/new exact bindings, preserved
manifest, reversible journal and required consent. Otherwise hold migration and
retain old operation semantics. Remove content only after proving no installation,
staging, previous version, backup/recovery or active operation references it.

## Freshness, compromise and interrupted work

Use an independently provisioned catalog root with two of three offline root
keys. Offline top-level targets delegate bounded official definition and policy
paths to separate online roles; timestamp/snapshot keys are separate again.
Incoming definition targets cannot change publisher grants or engine policy.
Persist accepted metadata versions/replay floors atomically with the selected
snapshot; do not reset floors on rollback or key rotation.

| Failure                                                           | Retained-use and recovery rule                                                                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline, outage or expired metadata                               | Stop new admission requiring fresh authority. Preserve verified, permitted installed use against retained contracts and independent local integrity; report stale discovery accurately. |
| Signature/hash/length error, metadata replay or mixed snapshot    | Reject refresh atomically; current selected data and replay floors remain intact.                                                                                                       |
| Partial refresh or process loss before publication                | Incomplete staged bytes have no authority. Retry exact inputs or abandon owned staging after reference/lock checks.                                                                     |
| Interrupted atomic selection commit                               | Recover from the database transaction/journal; never expose a mixture of old/new definitions or consume an uncommitted floor.                                                           |
| Explicit artifact/definition revocation or failed local integrity | Hold affected launch/install operations; ordinary offline fallback cannot bypass an already-known revocation. Preserve files and verified recovery versions.                            |
| Online key compromise                                             | Offline authority rotates/revokes the affected delegate, identifies suspect scope/window and publishes explicit holds. Re-evaluate affected retained use; unaffected entries continue.  |
| Root rotation                                                     | Verify consecutive roots under both old and new thresholds; persist the new floor before accepting delegated updates.                                                                   |
| One root key lost                                                 | Remaining quorum rotates to restored independent custody. No lowered threshold.                                                                                                         |
| Root quorum lost or compromised                                   | Freeze network admission; use a separately authenticated application/root recovery procedure and explicit trust establishment. No online key may replace its own root.                  |

Revocation is learned when authenticated metadata is available; the application
does not claim to know unseen offline revocations. Recovery guidance distinguishes
stale metadata, withdrawn content, permission errors and corrupt local files.

## Protected acceptance and local/community loading

#246 uses the existing strict required checks and distinct review under Protect
main ruleset 22155633, including its zero approval count. That rule supplies
routine merge authority, not signing authority. A separately authorized trusted
controller runs from a pinned protected revision and accepts inert candidate data.
It binds exact source/tree, definition/contracts, artifacts/digests, grant/template
policy, trusted test harness, check results/run attempts and review evidence.
Revalidate current scope and exact bytes immediately before signing/publication.
Builds/tests have no production secrets; the signer never executes candidate
scripts, local actions, binaries or instructions. Upstream observation in #398
has no signing, acceptance or trust-grant authority.

The controller serializes revisions, makes retries idempotent, publishes immutable
targets before signed snapshot/timestamp metadata, and independently reads back
the full published chain. A new definition, next artifact and safe correction
must each reach an already-built client with zero routine owner action in the
accepted scope. New authority/capability remains an explicit scoped escalation,
not a mandatory queue for ordinary data. Provisioning is not authorized here.

#268 uses the same core parser, validators, retained contracts and operation
eligibility. Local/community definitions have explicit namespaced identity and
provenance. Loading requires consent to that source and exact scope; it grants no
automatic execution or arbitrary script capability. They cannot shadow official
IDs, seize an install, merge saves or win conflicts by display name. An explicit
conflict/migration decision is needed to change an install's source. Unknown or
unsupported management operations remain unavailable with stable reasons; launch
integration does not imply full lifecycle management or sandbox confinement.

## Verification boundary

The design fixtures cover decision outcomes, independent evidence dimensions,
unknown semantics, content replacement, source requirements, retained use and
revocation. Core's existing exact-input, archive, runtime, persistence and signed
catalog tests remain required. #397 adds the unchanged-client/new-definition
execution, complete catalog migration and exact retained-content transactions;
#246 adds protected publication refusal/recovery tests and the three end-to-end
delivery cases. Physical/gameplay evidence is required only for a claim that
intrinsically depends on it. The design can be reviewed independently of production
credentials or per-game physical testing.
