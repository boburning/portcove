# Independent definition delivery contract

This is the successor design for #245. It does not extend signed catalog format
1, admit a new port, provision a publisher, or activate automatic delivery.
`portcove-core` remains the sole definition, admission and lifecycle authority.
The CLI and Tauri expose its outcomes; React and external clients present them.
The Project owns scheduling. Completed #245/#397/#398 components supply the
design, compatible client and configured observer; completed #254 supplies bounded
authoring tooling. #177 owns continued discovery and normalized observations,
#247 scoped release-health incidents/recovery, and #246 the actual protected
publication and unchanged-client journey. #534 retains provisioning acceptance;
component fixtures do not complete either production outcome.

## Implemented engine capability negotiation

Core advertises each installed `AdapterKind` template with contract version 1.
The public inventory additionally advertises native portable versions 2 and 3,
managed PS1 version 2, N64 portable versions 2 and 3 and
staged-source portable versions 2–5, 8, 10–12 and 15–24. Staged-source creation
versions 6, 7, 9, 13 and 14 are absent from that inventory. Serialized identifiers
and historical meanings are preserved; version numbers are not reused.

Capability negotiation, new-definition admission and retained-state interpretation
are separate checks. A supported capability does not admit every operation once
associated with it. New indexed entries with `release.managed_build` are refused,
including the retired CVLoD recipe associated with the still-advertised N64
portable version 3 and staged-source version 11 path capability. Advertising those
versions does not restore CVLoD source creation or authorize compilers or scripts.
Shared path capabilities remain available to their other consumers.

Native portable version 3 admits exact `direct-manifest` archives through the
existing native lifecycle. New and retained independent entries using that
combination require minimum version 3. Earlier versions 1/2 retain their GitHub
package meanings and cannot negotiate this variant. Direct pins bind one Stable
version, URL, size and expected SHA-256 per platform; they do not discover newer
upstream versions or inherit another artifact's qualification. Installer, source
preparation and mutable-runtime exclusions remain in force. Capability and API
envelope versions remain separate; advertising version 3 grants no publisher,
installation, protected-delivery or external-profile authority.

Native portable version 4 consumes the Windows `relative-file-max-path` policy.
It checks authenticated immutable package members and actual selected launch
coordinates at their final destination before publication or data synchronization.
It preserves Unicode, counts UTF-16 units with the relative spelling and NUL
headroom, and does not claim a general long-path fix or external-profile coverage.
New and retained independent entries declaring this policy require minimum4;
Direct-only version3 and earlier versions retain their separate meanings. This
capability grants no additional publisher or protected-operation authority.

Native portable version 2 observes an upstream-owned manual setup completion
record beneath declared player data. New and retained indexed entries using
this optional JSON marker require minimum version 2. Core checks bounded regular
file structure at status and locked launch boundaries; it neither executes setup
nor treats the record as a verified original-game receipt. Earlier retained
definitions without a marker keep their meaning. A marker may be added for a new
runtime only under unchanged already-owned data coordinates; changed markers
remain held. Explicit rollback to an exact retained older contract keeps that
contract's historical semantics and current declared data.

Managed PS1 version 2 stages a replacement before activation and preserves complete
declared `mods/packages/<id>/<version>` packages beside successor defaults. New
indexed PS1 entries require minimum version 2. Retained version-1 entries stay
readable and receive the current conservative restoration safety checks; their
definitions are not rewritten. This admission floor does not fence older programs
reading unscoped legacy manifests. A bounded, install/manifest-bound Core receipt
records completed data restoration before first Play; it establishes no launch,
game-file, mod, publisher or gameplay qualification. See the
[PS1 data boundary](CATALOG.md#managed-ps1-package-and-player-data-restoration).

Staged-source version 22 covers ready managed archives without a source, build,
setup-helper, initialization or shared-account contract. New indexed entries of
that shape now require version 23. They stage and restore declared data before
activation, collect edits made before first Play, and retain current data during
runtime rollback. Raw activation refuses; interrupted activation repeats retained
contract compatibility and data preflight. The same bounded data-restoration
receipt is reused, including its historical metadata filename. A retained copy
without proof of initial restoration uses additive collection and refuses
differing canonical/runtime data. Other staged-source contracts and older
retained readers keep their existing interpretation; advertising version 22
does not grant acquisition, publisher or external-data ownership.

Version 23 also covers a ready archive with one explicit verified raw-file
`copy` whose exact destination is declared persistent. BIOS, source sets,
compilers, setup helpers and richer initialization/account policies remain outside
this ready-archive boundary. Existing raw-copy installations receive conservative
additive collection if initial restoration was not recorded; retained contracts
are not rewritten. Source destination, materialization, identity-profile, expected
runtime hashes and source-environment changes hold replacement before collection.

Version 23 additionally preserves exact declared-file modification times through
collection, synchronization, backup and restore. A destination that rounds a
timestamp refuses before private replacement publication. New ready-archive
installations also retain a format-6 installed contract wrapping their original
embedded/indexed/admitted interpretation, so older programs refuse the unknown
format even for an unscoped install. Existing retained contracts are not rewritten.
New backup manifests bind timestamps with an additional metadata digest while
retaining their byte digest. Restore verifies the consent-bound manifest before
collecting current runtime data; later manifest changes cannot downgrade it to a
historical snapshot. Old backups without that digest retain byte-only historical
integrity: their original timestamps cannot be reconstructed or authenticated.
Older backup readers ignore the optional digest; capability and retained-contract
fences, rather than that optional field alone, protect new metadata-dependent
managed installations.

Version 24 adds the explicit ready-archive `mod_package_policy` value
`versioned-packages-v1`, requiring the exact declared `mods` root. Indexed new
and retained entries require minimum version 24. Embedded, indexed and admitted
installations retain a format-7 envelope wrapping their original interpretation;
older readers refuse it. The policy and envelope must agree, including cached
reads. Existing contracts keep their bytes and meaning. Updates, staged
activation, recovered activation and rollback refuse a policy change. Data
restore preflights complete package conflicts across all retained runtimes before
publishing canonical data. This reuses the PS1 coexistence algorithm and grants
no new publisher, executable, original-file or external-data authority.

The N64 portable template also advertises version 2, which implements the
catalog-declared fresh Windows D3D12 default. Inventory identities are unique
`(template, contract_version)` pairs; a template may implement several versions.
Negotiation selects the highest supported version inside the requested inclusive
window, or reports the highest installed version with `UnsupportedVersion` if
none fits. Version 1 remains available for unchanged definitions. The staged-source portable
template also advertises version 2 for explicit prepared `library_user_data`
bindings. An indexed entry opting into either behavior must require its template
minimum version 2. Capability contract schema remains 1; parsing a flag alone
does not implement its directory, environment or renderer behavior. These versions
describe the implemented combinations below; they do
not imply support for loading successor definition bundles. A new incompatible
template contract must receive a new version alongside its implementation and
compatibility evidence. Definitions cannot supply engine implementations.

An indexed entry using `n64_windows_initial_d3d12` must require N64 portable
version 2 or later as its minimum. A `[1,2]` window is refused for that entry:
version 1 engines could otherwise silently ignore the safety-relevant default.
This compatibility check supplies no admission, signing or execution authority.

Entries using `n64_runtime_at_executable_parent` require N64 portable minimum
version 4. Earlier engines retain versions 1–3 but cannot interpret the new
runtime coordinates, strict archive selection and pre-Play data preservation.
New captures use retained-contract format 8; format 7 continues to mean versioned
mod packages. Existing retained definitions are never recaptured or migrated by
today's catalog. A change between these coordinates requires a supported explicit
transition; an incompatible update preserves the working installation.

Staged-source portable version 3 implements a user-prepared runtime's declared
`runtime_subdirectory` as its launch working directory. Core verifies the whole
registered tree and requires the executable inside that directory before creating
private user data. The installation root remains the whole prepared tree; absent
a declaration, the working directory remains that root. Indexed entries using
this combination must require minimum version 3; `[1,3]` and `[2,3]` are refused.
Versions 1 and 2 remain supported. Other templates cannot declare a prepared
runtime subdirectory. Capability schema and public envelope shapes are unchanged.
This primitive supplies no title, package, generated-output or native acceptance.

Only the private retained-definition reader can interpret retired staged-source
versions 6, 7, 9, 13 and 14 for the identified existing runtime contracts. Yoshi's
historical version 6 and Dr. Mario NES's historical version 7 retain their exact
meanings there; they are not recipes for new indexed entries. The small cartridge
interpreter preserves installed-runtime launch, original/source and persistence
semantics without retaining generation, compiler acquisition or new builds.
Preserving an installed runtime's contract never re-enables its creation recipe.
The [compatibility record](reference/upstream-first-compatibility.md) identifies
the actual consumers, CVLoD recovery cleanup and concrete retirement conditions.

Staged-source portable version 8 adds the typed `regaiden041-windows` shared
preferences opt-in for the exact reviewed ReGaiden 0.4.1 Windows package.
Indexed entries declaring it must require minimum version 8. Earlier advertised
versions remain negotiable only within their implemented contracts; the retired
creation versions are not public capabilities. Preview, explicit consumer acknowledgment, retained
account/path and launch-time checks are consequential semantics; accepting the
field alone is insufficient. Retained external registrations use the existing
strict installed-contract envelope so older readers refuse lost semantics.

Staged-source portable version 19 covers the constrained reusable TFE initializer,
version-local RetroAchievements credential policy and GBRecompiled shared
preferences policy. Indexed entries using these policies must require minimum
version 19 for direct manifests. Typed retained release facts select the reviewed behavior; artifact,
path, persistence, credential and consent invariants remain in Core. A compatible
release can reuse the policy after focused validation without a new title-specific
capability. A checksum or matching filename alone does not prove compatibility.

Staged-source portable version 20 covers explicit `trust: "user-selected"`
execution. Such indexed entries must require minimum version 20. Explicit native
executable, working directory and bounded literal arguments support registration,
launch and registration-only removal; selected bytes are not authenticated
official packages. This contract grants no update, deletion, migration, backup or
rollback rights over external files. Older readers must refuse its unknown
consequential semantics. See [installation ownership](CATALOG.md#integration-ownership).

Staged-source portable version 21 adds configured GitHub provider resolution to
those three reusable runtime policies. Indexed entries using this combination
must require minimum version 21. Stable project/package rules resolve changing
release facts without definition edits. Core binds the exact retained definition,
platform, channel and resolved artifact before installation, and refreshes the
provider result before applying a review. Older clients refuse this combination;
direct manifests retain version 19. This capability does not authenticate a
publisher, authorize publication or widen the policies' data and consent scope.

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

Upstream continuity is recorded by the shared
[catalog lineage policy](CATALOG.md#upstream-lineage-and-alternative-implementations).
Its per-port authoring metadata is deliberately absent from signed definitions
and runtime projections. Stable port/issue identity, upstream lineage, accepted
release identity and acquisition locations remain separate. A reviewed relocation
or successor decision may support a separately reviewed acquisition change; it
does not grant a publisher namespace, accept artifact bytes, clear holds or
reinterpret installed source/execution/persistence contracts. Forks and
alternative implementations retain distinct port identities. Unresolved lineage
retains the existing origin and historical qualification. Consumers must use the
shared decision boundary instead of inferring continuity from names or redirects.

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

The executable decision examples accompanying this contract now run against the
single production `evaluate_definition_eligibility` implementation in core.
Installed core policy still owns supported schemas/templates and publisher grants;
incoming data cannot declare itself supported, populate the evaluator's independent
facts or approve its own result. The evaluator returns typed `eligible`, `hold` or
`escalate` outcomes with stable reasons for availability, install, prepare and
launch, and has no I/O or mutation of its own.

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

The current runtime accepts an upstream expected SHA-256 or existing reviewed
direct-manifest provenance. Read-only API observations distinguish missing API
digests from published checksum assets; neither is inferred from a same-download
hash. The minimum [#246](https://github.com/boburning/portcove/issues/246)
publication proof is independent of curated acquisition and uses an existing
accepted route. A verified cache may be reused only against its retained
accepted expected identity. Wrong bytes, ambiguous sidecars, missing provenance
and changed asset IDs remain explicit outcomes.

On 2026-09-25 the owner authorized
[#315](https://github.com/boburning/portcove/issues/315)'s policy direction:
an exact artifact from an attributable upstream release may be accepted without
a separately published publisher checksum after the acquisition route receives
independent review under protected catalog authority. The accepted record must
bind upstream/host, release, asset, platform, size, SHA-256, acquisition evidence
and acceptance provenance. A catalog-curated hash proves integrity against
accepted bytes; it is not a publisher signature or authentication claim. A new
release identity may enter normal protected acceptance. Different bytes under
the same accepted identity require investigation, not silent repinning.

The #315 implementation must preserve withdrawal/revocation, verified-cache,
recovery and permitted retained-version behavior. Proposal-producing runners
cannot approve their own authority changes or hold signing credentials.
Protected publisher automation may sign or publish only exact independently
authorized inputs, with enforceable workflow separation and exact-input
validation. Routine candidates within established authority do not need a
separate owner stamp. The policy decision accepts no particular artifact and
does not provision credentials or change current protections; existing source,
acquisition, ownership, consent and operation guards remain in force until the
route is implemented and afterward.

## Delivery, compatibility and retention

Core's `DefinitionContentIndex` implements the first structural boundary for the
successor index. Schema 1 has exactly `index_schema`, `definitions` and `contents`.
Each definition has `namespace`, `stable_id`, positive `revision` and `target`;
each content record has `target`, lowercase `sha256` and positive byte `length`.
Namespace and stable ID use 1–255 lowercase ASCII letters, digits or hyphens.
One namespace/stable-ID pair occurs once per snapshot, regardless of revision.
Official stable IDs remain unchanged. Other namespaces cannot acquire official
authority merely by appearing in this inventory.

The initial target spelling is exactly `sha256/<64 lowercase hex digits>.json`,
bound to the record's digest. URLs, aliases and traversal components cannot be
target references. Duplicate content records and definition targets absent from
the content inventory are rejected. Shared contracts may be referenced repeatedly
but occur once in the inventory. Empty snapshots are structurally valid; parsing
one cannot remove catalog availability. Unknown or duplicate fields at every
index boundary fail closed. Index bytes are retained exactly, not reserialized.

The parser enforces the 4 MiB index, 4,096 definitions, 4 MiB per content target
and 32 MiB aggregate bounds below before exposing an immutable inventory. This
first representation conservatively bounds all listed content, including records
not referenced by a definition. A transport can obtain each target's validated
length before its bounded read and then check supplied bytes against that length
and SHA-256. Repeated reads remain the transport's responsibility.

This pure inspector neither authenticates the index nor interprets entries,
fetches targets, grants publisher scope or changes the selected catalog. Entry
semantics, reference-graph depth/cycle checks, identity agreement with entry
content, replay/revocation policy and transactional loading remain separate
required boundaries. A byte match alone cannot turn a target into a usable port.

`acquire_definition_candidate` now supplies the authenticated acquisition boundary
around that inspector. It accepts a caller-supplied trusted root and credential-free
HTTPS metadata and target bases. Safe expiration checks, at most 32 root updates,
consistent snapshots and separate metadata limits are mandatory. A terminating
`official-definitions` delegation must contain exactly `definitions/index.json`
and `sha256/*.json`; targets in the top-level role, nested delegates, a hash-prefix
form of the named role or broader path patterns fail closed. Redirects and ambient
proxy configuration are disabled.

The loader authenticates and bounds the index, compares every listed target's TUF
length and SHA-256 before fetching content, streams at most eight target reads at a
time, and verifies every completed target against both authenticated metadata and
the index. Its immutable in-memory result includes all target bytes, the loaded
metadata versions, canonical signed-body digests, earliest expiration and exact
index digest. Its replay evaluator rejects a lower role version or different
signed body at an equal version, while distinguishing an exact retry from a
monotonic compatible advance. It can interpret one supported projection while an
unsupported sibling remains isolated. Evaluation does not persist or consume a
floor; that must happen atomically with later catalog selection. This candidate
does not select or replace a catalog, establish publisher grants or operation
eligibility, install content, or provision a production root/repository.

The composed availability assessment accepts an installed-policy publisher status
bound to the authenticated repository root, namespace and stable ID, then derives
the other availability facts from the authenticated candidate. It rechecks expiry
using the core-owned clock at the assessment time, isolates
unsupported capabilities, converts replay/equivocation into the stable
`metadata_replay` hold and keeps malformed policy floors as state errors. Only a
scoped, fresh, supported and replay-compatible projection yields the
non-serializable eligible-candidate proof containing its exact projection,
provenance, replay disposition, proposed floor and identity-bound grant ID/policy
revision. Unscoped, revoked, stale or unsupported entries expose only the typed
eligibility result. This proof still has no selection or persistence authority.

Schema 26 persists the first successor selection state. Core reads the current
publisher policy and replay floor when it assesses a candidate. Consuming the
result opens an immediate SQLite transaction and rechecks the policy revision,
grant ID, repository root, definition identity, metadata expiration and newest
floor before storing the exact interpreted snapshot and proposed floor in the
same row. A repeated exact selection does not advance the state revision. A
policy change, downgrade, equivocation, malformed stored value or failed commit
preserves the previous selected bytes and floor. The runtime loader now consumes
that record from the same SQLite snapshot as the embedded or signed baseline. It
accepts the projection only while the exact publisher grant remains scoped and
fresh and the selected port is the only semantic catalog change. Every unrelated
port and existing source-authority record must remain exact; additions must be
reachable only from the selected port. Failure leaves the baseline catalog usable
and records a visible fallback reason. Production grant provisioning remains a
separate protected boundary.

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

`DefinitionContentIndex::inspect_entry(namespace, stable_id, bytes)` implements
the entry inspection boundary. It verifies the indexed target bytes before JSON
decoding and requires schema 1 and exact namespace, stable ID and revision
agreement. The port ID must match that stable ID. The initial `port` value must
contain the complete serialization of the existing `PortDefinition`, including
default-valued fields. Comparing its typed projection rejects unknown fields at
every nested port boundary without changing legacy catalog parsing. Object key
order, whitespace and escaped string spellings need not be canonical; the input
bytes remain exact. Duplicate JSON keys, including escaped aliases inside maps
and arrays, are rejected before they can be overwritten. No presentation
extension fields are supported by this initial entry schema.

`required_capabilities` uses the existing requirement vocabulary and must include
the entry's adapter. Valid unsupported versions/templates remain reportable as
incompatible; they grant no capability. `source_contracts`, `artifact_bindings`
and `evidence_references` are ordered arrays of target strings;
`execution_contract` and `persistence_contract` are required target strings.
Every occurrence must resolve inside the index, and all five fields together
contain at most 1,024 references. Shared targets are allowed; role and order remain
available separately in the immutable inspection result.

Inspection failures affect the requested entry only and do not mutate the index.
Successful shape inspection is not semantic validation: even a representable port
still needs the existing catalog/source/execution/persistence checks. Referenced
record interpretation, role/identity agreement, complete graph depth/cycle bounds,
authenticated provenance, replay/revocation handling and atomic catalog selection
remain required. An indexed empty object is not a usable execution contract.

### Initial referenced catalog projection

`DefinitionContentIndex::inspect_catalog_projection` interprets supplied entry
and contract bytes through the existing core validators. Its terminal record has
exactly `contract_schema: 1`, `representation: "catalog_projection"` and `catalog`.
The catalog is the complete authoritative schema-1 or schema-2 document. Schema 2
omits derived `source_profiles`; the existing loader reconstructs that projection.
Every field emitted by the authoritative serializer must be present, including
default-valued port fields. Unknown, missing or discarded semantics and duplicate
decoded JSON keys fail closed. Whitespace and object-key order are immaterial;
the original exact bytes are retained separately.

The entry's source array must contain exactly one target, equal to both its
execution and persistence target. The artifact and evidence target arrays must
be empty for this representation. Existing release, runtime, source and scoped
qualification records stay intact inside the catalog; they do not become new
artifact acquisition or publisher authority. This deliberate shared leaf avoids
duplicating durable domain models while retaining the complete legacy graph.
It is not permission to omit source or evidence records from that graph.

The leaf has no outgoing target references. Additional graph fields, distinct
role leaves or record types require a separately implemented versioned contract;
they are rejected rather than silently ignored or traversed. Thus this supported
target graph is exactly one edge deep with one distinct leaf, within the index's
existing byte and reference bounds. The projected catalog also keeps its existing
4 MiB bound. Source-graph references are checked by the current catalog validators.

All catalog semantics must validate, the selected port must exactly match the
entry, and its installed template requirements must be supported. A failure
affects only that inspection and leaves the index and other inspections unchanged.
Other catalog ports preserve the self-contained legacy graph; their presence does
not admit additional indexed definitions. `DefinitionCatalogProjection` retains
the exact entry and contract bytes alongside the validated catalog. This is pure
supplied-content interpretation, with no I/O, signing, publisher grant, selection
or installation. Its validated catalog now carries the selected port's exact
snapshot into existing manifest capture. Retained-contract format 2 preserves the
index, entry and shared leaf strings rather than reserializing their semantics.
Reads reinterpret the snapshot and verify its identities and digest bindings;
recapture after preparation or manifest refresh preserves the same bytes. Other
ports in the shared graph do not inherit the selected entry's origin. Format 1
keeps the existing canonical legacy projection without inventing historical data.
After authenticated selection, retained-contract format 3 binds those same exact
bytes to the accepted definition revision, repository root, publisher grant and
policy revision, metadata role identities and expiration. Reads require the
admission record and snapshot to agree exactly, and every existing lifecycle path
recaptures the complete record. Format 2 stays readable as supplied successor
content but gains no invented authentication. Writer protocols 25 and 27 prevent
older clients from dropping exact successor bytes or the authenticated admission
record.
Authenticated loading, freshness/revocation, transactional catalog selection and
scoped runtime activation are implemented in core. Production root and grant
provisioning remain required before automatic public delivery can use this path.
API schema 47 composes a format-3 selection or retained admission with current
library-owned publisher policy, replay floor and metadata freshness. Port status
exports typed install, preparation and launch outcomes and stable reasons through
the shared CLI/Tauri contract. The matching lifecycle entry points re-evaluate the
same policy before publication, persistent-data work or child-process preparation.
Retained launch may use its exact verified contract after metadata expiration or a
newer replay floor; preparation and new installation require current metadata.
Known revocation and changed publisher authorization continue to hold retained use.
Library schema 34 records a retained-launch policy-revision interval in the
existing protected admission transaction. A compatible definition correction
preserves that interval only while the authenticated managed authorization is
unchanged: namespace, stable identity, authority/root, grant, schema, template,
repository ID, permitted hosts, redirect bound and operations. An authorization
change or withdrawal starts a new interval; restoring an earlier scope does not
revive its old interval. Existing schema-33 admissions start at their current
revision on upgrade, without inferred historical permission. Only verified
retained Launch can use an older revision in that interval. Install, Update,
Prepare, acquisition and selection retain their exact current-policy checks.

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

### Exact-definition availability policy

Core can authenticate an independently scoped policy target at
`policy/official/<stable-id>.json`. The direct terminating `official-policy`
delegation has exactly `policy/official/*.json`; its key material must be distinct
from the definition role and top-level metadata keys. Authentication uses the
existing bounded TUF transport, consistent snapshots and expiration enforcement.
Caller-supplied root bytes do not install trust. A library must already contain
the independently provisioned matching authority; there is no caller-selected root
or grant setter. Ordinary unprovisioned libraries remain unscoped.
The existing offline top-level targets authority still appoints and rotates
delegates. This component does not infer offline custody from public key bytes;
that custody remains a protected provisioning obligation. Policy fixtures use a
separate offline delegation signer rather than the timestamp/snapshot signer.

**Fixed-anchor client provisioning.**

`Library::review_definition_authority` reviews only the immutable public root
compiled into the release from `crates/portcove-core/catalog/official-definition-root.json`.
The checked-in value is `null`: ordinary builds report `configured: false` and
refuse application. Selecting a production root, demonstrating its custody and
shipping a configured release remain separate protected owner decisions. A valid
root document alone does not prove offline custody or grant signing/publication
permissions.

For a separately approved configured release, `catalog definition-authority`
returns a `provisioning_schema: 1` review. `--apply --expected-plan <expected_plan>`
requires explicit confirmation (`--yes` for noninteractive use) and delegates to
Core. No file, URL, key, environment override or qualification option supplies
the anchor. The compiled root is bounded to 1 MiB and must self-verify against
the initial-anchor profile appointed in reviewed source. The selected Slice 4
profile is single-owner-one-of-one-v1: one Root key/signature, distinct Ed25519
Root/Targets/Snapshot/Timestamp material, consistent snapshots and exactly four
top-level roles. The compiled root remains null until its separate appointment.
Legacy two-of-three validation remains available for existing anchors and
qualification; downloaded metadata cannot select a lower profile. Existing TUF
acquisition still authenticates rotation, expiry and fresh metadata. This new
initial profile cannot replace an installed anchor or bypass its old quorum.

The reviewed fingerprint binds the library identity and canonical path, compiled
anchor and retained authority/policy/admission/launch/curated state. Core recomputes
it inside an immediate SQLite transaction and inserts only a missing authority.
Conflicting roots, corrupt or incomplete retained baselines and stale reviews
refuse without repair. An exact retry writes nothing. A lost-response retry using
the original plan is accepted only while the inserted authority remains exact
and has no replay floor or dependent history; once admission advances, review
again. Provisioning cannot replace roots, reset floors, clear holds, grant policy,
select definitions or install games. Deleting all history or rolling back the
entire database cannot be detected without an independent witness; this seam
does not claim that protection.

This is a CLI operator command with additive exported review/result schemas and
capability advertisement. API result-envelope and operation-event versions stay
unchanged; no event is emitted and no Tauri command/binding is introduced.

**Ordinary refresh.** `PortcoveService::refresh_definition` and the thin
`catalog definition-refresh` CLI use only the fixed installed compiled root.
Credential-free HTTPS locations cannot supply authority. Preflight rejects
unconfigured/unprovisioned roots before transport or activity creation. One TUF
repository supplies policy, candidate and any required launch assessment from the
same authenticated snapshot. A revocation skips candidate acquisition. For a
positive policy, required assessment acquisition settles before the candidate;
after all network work, the existing cancellation/publication seal precedes
synchronous policy admission, assessment admission and opaque eligible selection.

An independently valid narrower policy remains durable if its companion later
fails verification or binding. The error reports the phase and committed policy/
assessment changes; prior selection remains retained. Retry does not rewind
floors, clear holds or replace the installed root. Selection uses the existing
atomic commit and rechecks current authority, so a concurrent revocation defeats
an older eligibility proof. Ordinary selection also validates the transition
against the current format-1/embedded catalog in that same immediate transaction,
including exact retries; a definition cannot remove or change unrelated entries.
Existing service instances keep their constructor
catalog; a new service (the next CLI invocation) consumes the durable selection.
This explicit command adds no startup polling, Tauri binding, game lifecycle
side effects or production feed activation. The default root remains absent;
fixture orchestration is not the protected unchanged-client journey.

Policy schema 1 authorizes **availability only**, binding the namespace,
stable ID, grant and monotonic policy revision to the exact index, definition
revision, definition bytes and implemented template. Unknown fields or decisions
are refused. It does not grant Install, Update, Prepare, RegisterExternal or
Launch. Schema 2 provides the bounded managed GitHub scope described below. The inert upstream
observation's `provider_authenticated: false` and an exact definition hash cannot
substitute for that acquisition proof.

Policy schema 2 accepts `managed_github` or `revoked` decisions and requires a
`managed-github-v1-` grant ID. That prefix is a refusal discriminator for unsupported
consumers, not proof of authority. A managed decision retains schema 1's exact
definition/index/template bindings and adds a positive numeric `repository_id`,
1–8 unique canonical domain `artifact_hosts`, `max_redirects` from 0 through 5,
and exactly the coupled `install`, `update`, `prepare`, `launch` operation set.
Partial, duplicate, unknown or wider operations and schema/grant mismatches are
refused. The independent installed authority, authenticated policy, exact
candidate and monotonic floors remain mandatory; policy bytes cannot provision
their own authority.

Policy schema 4 adds `decision.curated_acquisition_checks: 1` and also requires
`decision.scoped_launch_checks: 1`. Earlier schemas refuse the curated field,
including null; unknown versions fail closed. A schema-4 grant binds a nonempty
curated record map to the exact independently authenticated definition. Record
claims or a first client download cannot create this grant or install its root.

Curated resolution freshly observes the numeric GitHub repository, release and
asset IDs, tag, peeled commit, filename, canonical asset URL and nonzero size.
They must match the accepted record. A present publisher digest must agree; an
absent digest uses the protected record's expected SHA-256. Mutable metadata
bypasses selection and HTTP caches and refuses redirects. Installation refreshes
these identities through the same opaque scope before acquiring artifact bytes,
then uses the existing shared byte verifier and policy checks at publication.
Previously returned resolutions do not confer reusable upstream freshness.

Only an exactly qualified curated platform uses the shared `downloads/curated-v1`
byte cache; another platform's publisher-digest route remains independent. Cache
hits still refresh upstream metadata, recheck current policy and immutable
admission history, and verify a private copy against the protected size and
SHA-256 before extraction. Copying and hashing bound actual reads and writes,
including growth after a preflight size check. A cached file is never authority.
Cache copying and verification run in an awaited blocking worker. Cooperative
cancellation must join that worker before the installer cleans private staging
or reports its terminal result; interrupted cache partials retain their separate
evidence lifetime.

The cache uses one existing library OS lock. Retaining a new entry inventories
at most 256 entries and 8 GiB of retained bytes, including interrupted partial
copies, and refuses unexpected members or over-bound inventories. An existing
hit verifies its own bytes and path without auditing unrelated members. Lock
contention or exhausted capacity permits ordinary verified acquisition without
new cache retention. Symlinks and corruption are refused and preserved.
Private `.partial-<UUID>` copies never qualify as hits; no eviction
or automatic failed-evidence cleanup is introduced. Cancellation and policy
checks precede atomic cache publication. A later installation interruption can
retain verified cache bytes without registering an installed version.

Library schema 36 retains the first immutable curated identity and admitting
policy hash under the numeric repository/asset pair, atomically with policy
admission. Changing accepted bytes, size, commit or other immutable coordinates
for that pair fails; advancing evidence or policy cannot silently repin it.
Platform and evidence references do not redefine an artifact's byte identity.
History survives policy replacement and revocation. A separately retained
admission count detects missing history before acquisition or another admission;
an exact retry cannot recreate lost rows. This structural corruption holds fresh
curated acquisition without deleting installations or granting retained Launch.
Existing retained integrity, policy and launch-assessment guards still apply.

Schema 4 can additionally carry an explicit `curated_transitions` fact with
`future_acceptance_lost` and at most 64 distinct artifact transitions. Each
transition binds a nonzero numeric asset ID and accepted SHA-256 within the
grant's numeric repository scope; its status is `revoked`,
`distribution_withdrawn` or explicitly `cleared`. Null, earlier schemas,
unknown fields/statuses and repeated asset IDs are refused. Each affected
artifact must already exist in immutable admission history and have retained
authenticated membership in that policy's namespace, stable ID and independent
authority anchor. A transition cannot accept new arbitrary bytes or exercise
another port's authority merely because it shares an upstream repository.
Membership survives omission from a later definition; a separate completeness
count detects deleted membership. Holds from scopes that independently admitted
the same immutable bytes remain applicable until each scope explicitly clears
its own observation. Future-acceptance loss also refuses new scope membership.

The policy transaction retains the full authenticated transition policy and
original provenance, up to 256 receipts of the existing 64-KiB policy/16-KiB
provenance bounds. A separate completeness count prevents a deleted receipt
from being silently renewed. Capacity exhaustion holds admission and preserves
the receipts. Exact policy-byte renewal retains its original fact receipt;
current policy freshness remains independently required. Omission, later grant
replacement or expiry cannot erase a known hold. A higher explicit `cleared`
fact changes only its own authority/scope's observation; another scope's hold
remains applicable.

Artifact revocation holds acquisition and critical retained use, including the
same verification guard consumed by managed launch and rollback. Distribution
withdrawal holds acquisition across locations and the byte cache but does not
itself revoke permitted local use. Future-acceptance loss refuses previously
unadmitted identities in that scope while leaving exact historical artifacts
under their existing authorization. Existing `publisher_revoked`, missing-scope,
changed-grant, source, integrity and execution checks are unchanged. These facts
do not delete installations, saves or configuration and do not renew authority.
Read-only integrity verification remains distinct from permission to execute.

The shared status model projects these exact artifact guards after existing
publisher, freshness and launch-baseline assessment. API schema 61 distinguishes
artifact revocation from distribution withdrawal for Desktop and CLI consumers;
retained rollback carries the exact revoked-target reason. A status observation
is advisory and execution rechecks authority under its existing operation guards.

Interrupted publication rechecks the exact artifact from the verified manifest
owned by its current phase: the private payload before publication rename and
the published payload before installation registration. Install recovery applies
acquisition holds; adoption and preparation recovery apply local-use holds
alongside their existing publisher and freshness guards. A refusal retains the
payload and operation journal without activating or registering the target.

These capability and fixture paths do not establish production acceptance.
[#315](https://github.com/boburning/portcove/issues/315) still requires complete
cache qualification, exact scoped holds, cancellation/recovery, exhaustive transition
qualification and a lawful exact canary before its complete route is delivered.

### Exact managed Launch assessment format

Policy schema 3 keeps schema 2's exact managed acquisition grant and coupled
operation set and requires `decision.scoped_launch_checks: 1`. Schemas 1 and 2
refuse that field, including an explicit null. A reader that does not implement
schema 3 refuses the grant; adapter template version 1 is not evidence that a
reader supports scoped assessments. Existing schema 1/2 behavior is unchanged.

An independently authenticated companion target is
`policy/official/<stable-id>.launch.json`, under the existing independent
`official-policy` delegation and installed authority. Its dot suffix cannot
alias a valid stable ID's grant target. Acquisition is bounded by the same
64 KiB target limit, metadata transport and freshness controls. The incoming
assessment cannot provision a key, authorize its own grant or execute code.

Assessment schema 1 contains only `assessment_schema`, `namespace`, `stable_id`,
the exact current `policy_sha256`, a positive monotonic `revision`, and at most
128 `assessments`. An accepted empty collection establishes the initial baseline;
missing baseline or missing verified subject holds Launch with unknown safety
semantics, rather than inventing a failed check. Unknown fields, duplicate keys,
unknown operations or formats, malformed identities and duplicate subject/check
decisions are refused before admission.

Each assessment binds `subject`, `check_id`, `check_input_sha256`, its positive
`revision` (at most the collection revision), and `decision`. A subject names the
exact release `version`, `channel`, `platform`, `artifact` (`asset_name`, nonzero
`size`, lowercase SHA-256), and `operation: launch`. A `held` decision includes
`failure_sha256`; a `cleared` decision includes `previous_decision_sha256` and
`correction_sha256`. Check/failure/correction hashes name exact accepted inputs;
they are not optional gameplay observations. Canonical typed decision hashes
are available from the authenticated inspection for an explicit correction.
Authentication alone does not imply library admission.

Admission requires the exact currently installed schema 3 or 4 grant, matching
independent anchor/root, fresh grant and assessment metadata, and the authority
chain replay floor. An immediate transaction binds the collection revision,
individual decisions and complete retained inventory before committing the
authority floor. Equal-revision replacement and replay refuse without changing
the previous decision. Omission never removes a previous hold. Correcting one
check requires its exact currently held decision and leaves other checks active.
Fresh metadata cannot reset a lost initialized baseline or ledger; corruption
and missing initialized state refuse rather than becoming first use.

Managed Launch derives its subject from the registered installation and verified
manifest. Current accepted failures hold that exact subject before child creation
and in shared status. Unaffected subjects and acquisition operations remain
separate; manifests, grants, definitions, user pins, saves and source contracts
are not rewritten by assessment admission. Known holds survive disconnected or
expired metadata. Only a fresh independently accepted exact correction clears
them; Unknown, NotRun, a user report or a grant refresh cannot do so. An initialized
grant cannot downgrade to a managed format that ignores these decisions.

The final managed authority read and child creation share an immediate database
transaction that excludes concurrent admission. A committed hold therefore
precedes the final read or follows child creation; the guard releases before
session writes and child waiting, including on refusal. Explicit publisher
revocation retains its typed refusal even when expressed by schema 2, without
resetting the scoped ledger. A later regrant preserves recorded-identity-change
refusal for the old retained grant and cannot erase its accepted subject holds.

Controlled native fixtures acquire and install two ordinary release archives
containing the already-built host-tool probe. They check the retained manifest
subject, shared status, unaffected next-release launch, exact held-release
refusal and accepted correction followed by successful supervised launch.
Separate database contention controls prove writer exclusion, delayed actual
assessment admission and release after a refused guarded closure. These are
core/native fixture controls, not gameplay, production publication or whole
#246/#315 acceptance.

Launch-consumer fixtures use one authenticated port and the existing test-only
catalog injection; full embedded-compatible discovery remains a separate
qualified control. Late-hold acceptance runs through the public supervisor after
preparation. Controlled stored-provenance expiry and an in-process library reopen
preserve the exact hold, refuse correction while its grant is expired and permit
an unaffected verified subject. This does not establish a physical restart or
expired signed-TUF acquisition.

Library schema 35 retains assessment decisions, inventory identity and an
initialization/revision binding alongside publisher admission. Existing lifetime
leases require exclusive access for migration, preventing upgrade beneath an
older open client; older clients refuse an upgraded library on reopen. An old
reader using a separate unupgraded library cannot enforce an unseen companion
record. Qualification therefore builds the capable reader before publishing its
fixture failure/correction and keeps that reader unchanged thereafter. This
component does not claim a new CLI wire capability, automatic refresh, protected
production signing/publication, or whole #246/#315 acceptance.

Schema 35 builds on schema 34's retained-authorization interval. Signed schema-3
fixtures verify that a compatible definition correction preserves exact-subject
holds, requires a current-policy companion, and clears each hold only through its
explicit correction; narrowing and restoring authorization cannot revive an old
launch identity. A separate single-port historical-upgrade fixture retains a real
ordinary installation and player data, preserves signed admission and authority
bytes, refuses migration with live library users, and conservatively initializes
the old admission's launch floor to its current policy revision. The full
embedded-compatible two-artifact and compatible-correction journey remains a
separate control with ordinary service discovery, retained contracts and player
data. A small signed stored-admission fixture keeps the original identity and
acquisition scope through both compatible corrections and verifies rejection,
replay and idempotence without an installed-payload or embedded-discovery claim.
The six authorization change-and-restoration pairs likewise retain their complete
signed transitions. These fixtures do not establish production publication or
gameplay.

The GitHub resolver observes the numeric repository ID before release cache reuse.
Release requests still use the repository's textual name; this observation does
not claim an immutable ID-addressed route or eliminate concurrent rename races.
Scope-bound cache keys include the authority, policy and exact port definition.
Scoped metadata requests carry no ambient GitHub credential or conditional cache
validator. Checksums and ordinary artifact downloads require credential-free
HTTPS on port 443, an exact admitted host and no fragment; every redirect rechecks
the current admission, URL and explicit hop bound before following it. Artifact
digests, archive safety and executable verification remain separate controls.

Installers consume an opaque resolver proof bound to the exact release, definition
and library. A direct request cannot substitute a serialized release for that
proof. Admission is checked before staging and at publication/registration;
unfinished preparation recovery also checks its retained admission. Revocation or
missing authority/floors preserves refused journals and data. Expired metadata
holds new acquisition while verified retained launch and its save collection can
use the exact installed contract; revocation and corrupt authority still refuse.

This initial scope covers ordinary GitHub artifacts for the existing portable
Libultraship, N64Recomp, staged-source and referenced-disc workflows without bundled
runtimes. Auxiliary toolchains/runtimes, managed adoption, external registration
and restricted library portability are unsupported. No public trust-root setter,
new serialized client field or API schema increment is introduced.

`apply_definition_publisher_policy` requires the exact authenticated candidate
for availability; a `revoked` decision needs no definition candidate. Library
schema 33 stores bounded independent authority and policy admissions. One
immediate transaction updates the authority-wide TUF chain replay floor, the
per-grant revision and exact-byte identity, and the existing publisher status.
Lower metadata or grant versions and equal-version replacement are refused.
An exact retry is idempotent; failure preserves the previous grant and replay
floor. Assessment, selection and runtime loading recheck the installed exact scope
and freshness, including policy changes between assessment and consumption. Runtime
cache validity ends at the earlier definition or policy expiration. An admitted
authority cannot revert to an empty replay floor; advancing another identity does
not invalidate its still-current exact grants. Adoption also checks Install
eligibility before staging and publication, so availability cannot manufacture a
retained lifecycle admission. Existing retained
contracts and independently admitted historical use keep their separate rules;
known revocation remains a refusal.
Uncommitted installation/adoption recovery rechecks the exact manifest-bound
definition before publishing staged bytes and before registering published bytes.
A refused operation keeps its journal and recovery evidence; the current fallback
catalog cannot authorize its retained definition. Committed cleanup remains distinct.

Disposable TUF authority and owned HTTP/native probe fixtures exercise this component.
They do not qualify production TLS, gameplay or automatic publisher delivery.
Production root/grant provisioning, protected publisher custody and write/signing
authority, automatic publication and the unchanged-client new-definition,
next-artifact and correction proof remain distinct #246 acceptance. This is not
activation of a production feed or whole-issue delivery.

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

## Managed publication tooling

`portcove --json catalog inspect-definition-publication DIRECTORY` inspects an
inert prepared bundle without opening preferences or a Library. The directory
contains `definitions/index.json`, exactly its `sha256/*.json` content, and the
corresponding `policy/official/<stable_id>.json` plus required `.launch.json`
records. Core reuses the definition, capability, publisher and launch parsers;
missing, extra, changed, linked or unsupported content refuses. The bounds are
16,385 files and 32 MiB in total, with 4 MiB indexed leaves and 64 KiB policy
records. Its exact file/definition manifest grants no semantic or publisher
acceptance. An empty index is bootstrap preparation, not a delivered definition.

The release tool provides `sign-offline-definition-targets CONFIG`,
`sign-definition-role ROLE CONFIG` and `assemble-definition-repository CONFIG`.
Catalog Root and offline Targets remain separate from application authority.
Online roles are `official-definitions`, `official-policy`, `snapshot` and
`timestamp`; each signing invocation reads only its one appointed private key.
Keyless assembly uses Tough to authenticate the exact public closure, preserving
immutable history and semantic revision floors. It cannot appoint a publisher or
replace protected acceptance. Version strings in the public tool report preserve
positive u64 identities without JavaScript numeric conversion.

The existing coordinator models a catalog publication as its own bounded subject,
without allocating an application version. Both publishers use the same complete
site and pending-effect owner: a global site cursor advances with one component's
metadata, while the other component's publication provenance remains intact.
Schema 2 site markers name separate application/catalog roots; legacy app markers
remain readable. A marker or byte digest is not a TUF verifier. Actual callers
must authenticate the prior complete site and preserve both histories before the
sole Pages writer. The site's 6,000-file / 256 MiB bound remains independent of
producer and historical-repository bounds. Protected configuration, admission,
source/producer binding and the live controller integration remain required.

The automatic catalog authoring boundary is the fixed inert source subtree
`release/catalog-publication/`: strict `request.json` plus `bundle/` containing
the managed index, checksum-addressed definitions and official policy/launch
records. This is separate from the compiled catalog. The existing coordinator
freezes exact raw Git inputs, actual Core projection, accumulated changes from
the accepted catalog baseline and current component/site identities. Its neutral
request is consumed by the selected independent whole-opportunity producer;
parser success or persistence does not establish acceptance. Negative results
retain the actual authenticated Check and bounded repair history in the same
journal. An unchanged accepted subtree does not require another review solely
because unrelated main commits arrived.

Four independently isolated catalog online roles feed keyless Tough assembly
and the same complete-site deployment owner as application publication. Recovery
verifies existing public bytes against the original intent and attested roles;
it does not remint clocks or repeat publication. See the dated
[controller connection receipt](qualification/slice4-catalog-controller-connection-2026-10-21.md)
for reviewed implementation and the remaining provisioning/public acceptance.

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

The #397 client acceptance is executable across the existing test layers. The
authenticated `selected_post_client_definition_loads_as_the_active_catalog`
fixture publishes a definition absent from the embedded client, preserves every
embedded port exactly, retains its complete bytes and admission identity, then
loads the new port through `PortcoveService` with an eligible install assessment.
Unsupported siblings and unknown safety semantics have separate isolation tests.
`authenticated_admission_survives_staging_rollback_activation_and_refresh`
exercises installed, staged and previous format-3 retention through the shared
lifecycle and preserves version-owned settings.
`authenticated_adoption_retains_exact_definition_and_publisher_identity` runs
the real adoption path and verifies its retained port definition and publisher
admission identity after the active catalog changes. The operation assessment
matrix distinguishes stale install/preparation, permitted retained launch, local
integrity failure and explicit revocation. Selection interruption, replay and
policy-change tests prove atomic retry and recovery without consuming an invalid
floor. CLI status calls core directly, while
`desktop_statuses_are_the_exact_core_results` proves the Tauri adapter returns the
same `PortStatus` documents without establishing its own eligibility result.

These tests establish client loading and retained lifecycle behavior without
production credentials. Automatic unchanged-client publication, signed readback
and production refusal/recovery remain #246 acceptance and do not belong to the
client implementation boundary.

The existing compiled adapter-conformance route consumes the signed managed
ordinary-release fixture. It builds and hashes the fixture-capable CLI and Desktop
once before publication, then starts those same binaries in fresh sessions after
the new definition, both owned artifact acquisitions and compatible corrections.
The CLI uses canonical reviewed first-install authority for v1 and reviewed update
authority for v2. Its hidden qualification-only update commands forward Core's
existing plan fingerprint, explicit confirmation, activation and one-use authorization
checks. They do not change the ordinary CLI update command. The fixture records the
exact reviewed releases, digests, install records and selected definition identities.
Complete status documents must equal Core and each other; CLI `catalog show` must
return corrected content. Desktop evidence remains its actual status projection.

The CLI's nondefault `qualification-fixtures` feature forwards Core's existing fixture
feature. Its explicit origin and library flags bind the provider to a canonical literal
loopback HTTP origin and the exact fixture library; malformed, nonloopback and
mismatched bindings refuse before ordinary-origin fallback or provider requests.
Only independently admitted managed scopes can acquire fixture artifacts. The
provider starts anonymous without loading ambient credentials. Default builds reject
these flags and hidden update commands. This route does not alter publisher policy,
trust roots, grant checks, serialization or production provider selection.

Explicit qualification-provider invocations also refuse nonempty `HTTP_PROXY`,
`HTTPS_PROXY` or `ALL_PROXY` environment variables, case-insensitively, before
preferences, library opening, provider construction or requests. `NO_PROXY` does
not waive this conservative refusal. Values are neither printed nor changed;
ordinary invocations preserve their existing proxy behavior. This keeps the
synthetic fixture CLI route isolated without changing production networking.

Stale plans, digest mismatch and redirects outside the bound origin must refuse
without changing selected definitions or retained installation bytes and records.
Authenticated authorization narrowing and restoration cannot revive retained Launch
permission. Existing revoke and invalid-manifest cases remain. Consumer digests stay
unchanged through all phases. The opt-in fixture seam uses canonical policy admission
and selection; it adds no production trust setter or publisher authority.

The separate opt-in compiled CLI acquisition test exercises this component on hosts
without a Desktop SDK. Its report explicitly records that Desktop projection was
not executed; it cannot satisfy the combined adapter-conformance gate. Combined
evidence requires both actual compiled consumers. These fixtures demonstrate
reviewed acquisition of inert loopback artifacts and unchanged-client correction
consumption, without executing any fixture payload. They do not establish a real
production feed, installed GUI behavior, automatic protected publication or native
platform qualification. #246/#534 retain production custody, publication readback,
zero routine owner intervention and operation-delivery acceptance.

## Descriptive directory delivery

A capable reader can refresh `policy/official/catalog.listings.json` in the same
catalog-specific TUF repository. This fixed target uses the independent
`official-policy` delegation and the already installed compiled catalog anchor.
It never installs a managed publisher policy or adds a `PortDefinition`. Network
locations select transport only; they cannot select a trust root. The application
updater, catalog role keys, delegated paths and protected production activation
remain separate and unchanged.

The strict UTF-8 target has `listing_delivery_schema: 1`, a positive safe-integer
`revision`, `withdrawn_ids` and a `directory` containing the existing format-1 or
format-2 `CatalogListingDocument`; `download_block_reason` requires format 2.
The complete target is bounded to 8 MiB, each listing
uses the existing descriptive validator, and both lists are bounded to 10,000
identities. Unknown fields, duplicate JSON keys, duplicate IDs, conflicting
withdrawals, unsafe links and operational fields are rejected. Setup instructions
and IGDB artwork mappings remain inert descriptions; acquisition, user-selected
execution consent and managed installation retain their existing boundaries.

Ordinary preparation and publication carry complete authored listings, including
acquisition restrictions; package observations and metadata enrichment cannot
resolve a condition. A reviewed Git-authored resolution may remove it in a newer
authenticated snapshot. The reader retains snapshot replacement semantics rather
than making an older restriction an additional policy authority.

Core atomically retains the exact target bytes and authenticated metadata
provenance with the shared installed-authority replay floor. Lower metadata or
feed revisions and changed bytes at an equal feed revision are refused. A newer
metadata version can renew identical target bytes. Acquisition, validation or
cancellation before admission leaves the accepted directory intact. Each service
captures one coherent catalog snapshot; a fresh service sees an admitted refresh.

The selected directory overlays bundled and accepted managed presentation by
stable ID, then orders records by ID. Omitted remote-only records disappear when
the snapshot is replaced. Omitted bundled records remain available. Explicit
withdrawals remove descriptive-only bundled records; managed definitions and
retained runtime contracts remain available through their owning projections.
No previous remote snapshot is automatically restored after a withdrawal.
Local artwork overrides remain higher priority than corrected remote artwork.
Existing external registrations and pending setups retain their captured listing
identity independently of catalog availability.

Cached selected data works offline until its authenticated expiry. Expired,
corrupt or no-longer-authorized cached data falls back to the bundled directory;
the retained revision/replay floor is not lowered. Status exposes the actual
selection, revision, target and authority digests, expiry, counts, withdrawals
and fallback reason. An expired tombstone is not an indefinite new authority over
the bundled fallback. There is no startup fetch or unsigned GitHub JSON fallback.

CLI `catalog listing-refresh --metadata-base-url <https-base>
--targets-base-url <https-base>` performs an explicit refresh under the installed
authority. `catalog listing-status` reports its selection. Tauri delegates the
same operations to Core; settings exposes the manual refresh and existing catalog
and artwork projections display the resulting data after a workspace reload.
Authority provisioning still requires the existing exact-plan consent. Automatic
scheduling and real production configuration remain with their existing owners.

Publication inspection schema 2 includes a separately bound listing summary
(target, revision, exact digest and listing/withdrawal counts). The
existing source acquisition, complete-opportunity classification/review, release
tool and policy-role signing route carry it; schema 1 remains byte-compatible
when the target is absent. Listing publication requires the explicit
`official-catalog-listings-v2` compatibility declaration. This supplies no
semantic acceptance or activation authority by itself.

Readers without this new target reader can continue using their existing
repository targets. They need one bootstrap application release to consume
listing delivery; later compatible listing/artwork changes need no executable
build. Library migration 40 makes older executables refuse a newer library
rather than silently lose its selection/replay state. Fixture tests establish
engineering behavior only. #534's actual configured protected publication and
public/native unchanged-binary evidence remain prerequisites to production;
this descriptive milestone does not close #246 or qualify #144's real artifacts.

The controller also requires an explicit source-bound `catalog.descriptive_directory`
appointment with exactly `listing_delivery_schema: 1` and
`target: "policy/official/catalog.listings.json"`. Existing title-limited
`publisher_scope` grants do not authorize this target. A descriptive-only
appointment may use an empty managed scope. No configuration or production
appointment is installed by the reader implementation; #534 retains that protected
setup/activation boundary. Existing infrastructure and Chameleon decisions remain
in effect at their granted scope. Frozen review, preflight, context transfer and
retained readback allow up to 8 MiB only for this exact target and its
content-addressed historical copies; unrelated per-file and aggregate limits
remain in effect.

These are per-file limits, not guaranteed complete-publication capacity. The
unchanged fixed-reader session permits 8 MiB of output in total, including
manifest, encoded current/prior content and changed-source evidence. Attempts
that exhaust that budget refuse complete review and remain held. The transport
fixture exercises a 2 MiB current directory and retained prior copy; it supplies
no actual semantic-review acceptance or production qualification.
