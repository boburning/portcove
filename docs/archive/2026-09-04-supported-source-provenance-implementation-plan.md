> Historical implementation-planning evidence. #36 and its current sub-issues own executable scope, and Project fields own live priority and status. This file is not a live roadmap authority. Current code and schema versions may supersede literal version numbers below. Appendix A supersedes Workstream 1 of the older prelaunch plan where they conflict.

# Codex implementation task: Supported-ROM/source identity, provenance, inspection, and qualification

You are implementing this directly in the Portcove repository:

- Repository: `boburning/portcove`
- Primary issue: `#36` — structured supported-ROM/source variants and hash inspection
- Related read-only references: `#19`, `#53`, and the individual `[Port]` issues
- Execute the implementation end to end. Do not stop after writing another plan.

## Mission

Add a core-owned, versioned model for supported source variants, provenance, source inspection, and granular qualification while preserving Portcove’s current safety and admission behavior.

The completed product must let a user answer all of these questions without conflating them:

1. Is the registered source still present and unchanged?
2. What exact game/disc/source variant did Portcove identify?
3. Is that variant listed by the reviewed upstream source contract for this port?
4. Did Portcove accept or reject the source, and why?
5. Has Portcove actually tested this exact port build, platform, and source variant?
6. What immutable evidence supports each claim?
7. What hash did Portcove observe for the original file/container versus normalized game content?

Portcove must never imply that upstream support, local byte integrity, Portcove admission, and Portcove qualification are the same thing.

---

## Operating boundaries

### Worktree and repository safety

1. Read `AGENTS.md`, `CONTRIBUTING.md`, the current source/catalog architecture, CLI contract, signed-catalog contract, project governance, and the related issues before changing code.
2. Inspect the current branch, worktree status, and `origin/main`.
3. If the current checkout contains unrelated changes, do **not** stash, reset, clean, overwrite, or modify them. Create a safe sibling worktree from the current `origin/main` and work there.
4. Record the exact base commit in the final implementation report.
5. Keep changes scoped to this feature. Do not refactor unrelated subsystems.
6. Do not modify GitHub issues, issue comments, Projects, Project fields, milestones, labels, or other external state.
7. Do not commit ROMs, disc images, copyrighted source bytes, local paths, private test data, crash dumps, credentials, or preservation-database dumps.
8. Do not add runtime network lookups to No-Intro, Redump, MAME, GitHub source manifests, or arbitrary ROM databases. Reviewed evidence is captured in the trusted catalog; local source matching stays offline.
9. Do not upload local source hashes or source metadata to any external service.
10. Use official upstream repositories, immutable commits/tags, and versioned preservation metadata. Never fabricate, infer, or copy an identity from an unreviewed ROM site.

### Behavioral safety

Preserve the existing source admission boundary unless a change appears in the explicit reviewed-expansion list below.

- Existing exact-hash, exact-file-set, exact-disc, volume-ID, and pinned-validator behavior remains enforced.
- Existing extension-only profiles remain permissive but become explicitly informational.
- Informational admission may accept an unrecognized plausible source, but it must never call that source supported, compatible, or qualified.
- Enforced-profile mismatches continue to fail.
- Malformed files, unsafe archives, invalid disc layouts, failed validators, hashing-budget failures, missing tools, and other existing structural/safety failures continue to fail in both modes.
- `source verify` remains read-only. It must not replace the stored baseline, mutate classification metadata, rewrite source rows, or touch source bytes.
- Source files and containers remain user-owned and untouched.

### Explicit reviewed behavior changes

The final implementation may intentionally change only these source-identity outcomes after immutable evidence is captured and reviewed:

1. Add the Ghostship variants listed by its selected versioned source manifest, including the Japanese variant.
2. Add the four retail Banjo-Kazooie variants listed by Lighthouse 1.1.0.
3. Reconcile Ship of Harkinian, 2Ship2Harkinian, and Starship against their selected versioned upstream source contracts.
4. Replace Bomberman Party Edition’s ambiguous parallel digest arrays with proven paired identity alternatives.
5. Split **per-port source contracts** where ports accept different variant subsets. Do not split a reusable game identity profile merely because its consumers differ.
6. Reject only synthetic cross-paired identities that were possible because of the old ambiguous digest-array representation. Preserve every real, reviewed source variant that the old catalog legitimately accepted.

Any other admission difference must be treated as a regression and fixed or documented as a separately reviewed defect before completion.

---

## Required domain separation

Implement independent typed dimensions. Do not collapse these into one `supported`, `unknown`, or `verified` enum.

### 1. Source health

Represents the current filesystem and baseline-integrity state.

Conceptual shape:

```text
availability:
  available | missing | unreadable

integrity:
  unchanged | changed | not-baselined
```

This remains separate from game/source classification.

### 2. Source classification

Represents what Portcove can identify from observed content.

Conceptual states:

```text
matched:
  variant_id
  representation_id

upstream-validated:
  validator_contract_id
  optional reported variant

unrecognized

not-evaluated
```

- `matched` requires deterministic evidence.
- `upstream-validated` is valid when a pinned reviewed validator accepts the source but does not expose a precise variant.
- `unrecognized` means Portcove checked the source and found no known deterministic match.
- `not-evaluated` is a legacy or deferred classification state, not a compatibility judgment.

### 3. Upstream contract result

Represents whether the classified source is covered by the selected reviewed upstream source contract.

Conceptual states:

```text
listed
validator-accepted
not-listed
indeterminate
unreviewed-for-current-release
```

A source can be recognized but not listed by a specific port. A source can also be admitted informationally while upstream support remains indeterminate.

### 4. Admission result

Represents the actual Portcove decision.

```text
accepted | rejected
```

Include:

- `admission_mode: enforced | informational`
- a stable machine-readable reason
- a clear user-facing explanation

Required semantics:

| Contract/match result | Enforced | Informational |
|---|---:|---:|
| Recognized and listed | Accept | Accept |
| Pinned validator accepts | Accept | Accept |
| Recognized but not listed | Reject | Accept with compatibility unknown |
| Unrecognized plausible source | Reject | Accept with compatibility unknown |
| Unsafe/malformed/invalid structure | Reject | Reject |
| Validator rejects | Reject | Reject |

“Not listed” never means “known incompatible.” Use conservative wording.

### 5. Portcove qualification

Represents what Portcove actually tested.

Keep automated and hands-on qualification separate and bind new records to:

- `port_id`
- platform
- exact port artifact SHA-256 whenever an artifact exists
- upstream release/tag/commit
- Portcove version or commit
- source contract ID
- exact source variant ID when known
- representation ID when representation-specific behavior was exercised
- qualification kind: automated or hands-on
- outcome: passed, failed, or inconclusive
- test date
- evidence IDs

Do not allow a newly published or republished artifact to inherit qualification from an older artifact digest.

Existing port-level lifecycle/support status remains, but platform badges and summaries must be derived from granular qualification records rather than maintained as an independent second truth.

Historical qualification whose source variant cannot be proven must be migrated as variant-unspecified legacy evidence. Do not guess the variant.

---

## Catalog schema 2

Bump the embedded catalog document to schema 2. Keep signed envelope format 1.

Use typed Rust structures and generated TypeScript/API schemas. Avoid a large collection of loosely related optional fields. A tagged enum or equivalent typed representation is preferred for identity kinds.

A recommended conceptual top-level shape is:

```text
CatalogDocument
  schema_version: 2
  evidence: EvidenceRecord[]
  source_profiles: SourceIdentityProfile[]
  source_contracts: PortSourceContract[]
  ports: PortDefinition[]
```

Qualification records may be stored under each port or in a top-level registry, but there must be one catalog authority and one derivation path.

### Stable IDs

The following IDs are durable, lowercase kebab-case identifiers:

- evidence IDs
- source profile IDs
- logical variant IDs
- representation IDs
- source contract IDs
- validator contract IDs
- qualification record IDs

IDs must be unique within their namespace, must never be silently reused for a different meaning, and must remain resolvable when referenced by durable source or qualification metadata. If historical references require it, retain a tombstone/alias rather than recycling an ID.

### Source identity profiles

A source identity profile describes reusable game/disc/source identity. It does **not** decide whether a particular port accepts every variant.

Conceptual shape:

```text
SourceIdentityProfile
  id
  label
  source kind
  variants[]
  optional explicit identity/evidence gap
```

Preserve current profile IDs wherever possible so existing registrations continue to resolve.

Do not split `banjo-kazooie`, `majoras-mask`, or another reusable identity profile solely because different ports accept different subsets. Express that difference in per-port contracts.

### Logical variants and representations

A logical variant represents a meaningful edition of the game/source, such as:

- title
- region
- revision
- serial/product code
- disc number/set
- prototype/build identity

Conceptual shape:

```text
SourceVariant
  id
  upstream title
  region
  revision
  serials/product codes
  representations[]
  evidence_ids[]
```

A physical representation is not automatically a new logical variant.

Examples:

- `.z64`, `.n64`, `.v64`, and a ZIP member containing the same N64 revision are representations of one logical variant.
- CHD and reconstructed BIN/CUE tracks can represent one logical disc variant.
- A multi-disc game is one variant containing an ordered, named disc set.
- A file-set variant contains named members.
- Volume-ID-only identification is weaker than exact-track identity and must be labeled honestly.
- A pinned validator may accept a source without identifying a precise logical variant.

Conceptual representation kinds should cover the current supported paths:

- raw file
- canonicalized N64 content
- archive member
- file set
- GameCube normalized ISO
- optical disc / normalized track set
- multi-disc set
- volume ID
- pinned upstream validator
- any current STFS/LIVE or other compound source identity already supported by core

Do not turn container format or byte order into a separate game edition.

### Paired identity alternatives

Eliminate ambiguous parallel arrays as the authoritative schema.

Represent one exact byte identity as one object:

```json
{
  "sha1": "…",
  "sha256": "…",
  "crc32": "…"
}
```

Rules:

1. Every digest present inside one identity object is conjunctive and describes the same byte sequence/scope.
2. Different identity objects are alternatives.
3. Different representations under one logical variant are alternatives.
4. Never pair old digest arrays by array index without explicit evidence.
5. Do not create a SHA-1/SHA-256 pair merely because both values occur under the same old profile.
6. If two logical variants match the same observed deterministic identity, reject the catalog unless an explicit reviewed alias/equivalence model exists.
7. If matching produces more than one candidate, return an ambiguity error. Never choose the first match.
8. Every digest must carry or inherit an explicit identity scope, such as:
   - original file/container bytes
   - normalized source content
   - canonical N64 big-endian content
   - archive member bytes
   - GameCube normalized ISO
   - PS1 normalized data track/track set
   - file-set member
   - disc-set member

### Per-port source contracts

A port source contract binds a port’s upstream requirement to a reusable identity profile.

Conceptual shape:

```text
PortSourceContract
  id
  profile_id
  admission_mode: enforced | informational
  supported_variant_ids[]
  optional pinned validator contract
  support_evidence_ids[]
  authority version/ref
  reviewed_at
  immutable review URL
  optional live review URL
  optional explicit evidence gap
```

Rules:

- Enforced contracts require at least one deterministic listed variant or a pinned reviewed validator.
- Informational contracts with no deterministic variant require explicit gap text.
- A known variant set may still use informational admission to preserve a current permissive boundary.
- New informational contracts are allowed only when the generic adapter and upstream runtime safely accept an unrecognized plausible source.
- Sharing one source contract across ports is allowed only when the selected upstream requirement is truly identical. Do not share merely because the game is the same.
- A port may reference a source contract and, where applicable, a BIOS contract.
- Keep profile identity reusable and contract admission port-specific.

### Release applicability

The source contract must record the upstream version/ref at which it was reviewed.

Where exact artifact applicability is known, add a binding from the resolved artifact digest to an existing frozen source contract. Such a binding may be signed-updateable only when it references an already embedded contract.

For a later unbound upstream release:

- preserve existing install/update behavior unless an existing trust rule already blocks it;
- do not silently claim that the source contract or qualification was re-reviewed for that artifact;
- expose `unreviewed-for-current-release` or equivalent conservative status;
- never inherit artifact-scoped qualification.

A new variant, a changed variant meaning, changed admission behavior, or a new source contract requires a reviewed Portcove application release.

### Evidence registry

Use a deduplicated trusted evidence registry so repeated commit metadata does not bloat the catalog.

Conceptual shape:

```text
EvidenceRecord
  id
  role
  authority
  authority_version_or_ref
  reviewed_at
  claim
  immutable_url
  optional live_url
  optional preservation metadata
```

Evidence roles are distinct:

| Role | Question answered |
|---|---|
| Upstream support | Does the selected upstream contract list or accept this source? |
| Byte identity | What bytes/serial/disc/file set identify the variant? |
| Preservation crosswalk | Why does a preservation record correspond to the upstream-described edition? |
| Portcove qualification | What exact Portcove/port/platform/source combination was tested? |

Authority order for upstream support and deterministic identity:

1. Versioned upstream machine-readable `supported-roms`, `supportedHashes`, configuration, or equivalent manifest.
2. Versioned upstream validator or source-code identity table.
3. Versioned upstream README/documentation.
4. If upstream uniquely identifies title/region/revision/serial but omits hashes, a reviewed crosswalk to a versioned No-Intro DAT, Redump DAT, or MAME metadata release.
5. A locally computed hash alone never establishes upstream support. It only establishes local byte/storage integrity.

Evidence requirements:

- Git-hosted evidence uses a full immutable commit SHA as authority, even if a tag/release name is also recorded for readability.
- Live links are non-authoritative and exist only for drift review.
- Preservation evidence records the database/DAT release, DAT or source digest, record key/serial, captured fields, and a deterministic canonical record digest.
- Define and document exactly how the canonical preservation record digest is produced. Lock the format with fixtures.
- A preservation record can establish identity but can never independently establish upstream support.
- If a variant is listed upstream but cannot be deterministically identified and no reviewed validator exists, represent the variant and record an evidence gap. Do not fabricate a matcher.
- Evidence URLs must be HTTPS and pass strict catalog validation. Reject unsafe schemes, credential-bearing URLs, localhost/private targets, malformed URLs, and other unsafe forms.
- The application opens only an exact URL resolved from an evidence ID in the active trusted catalog.

---

## Central source matcher

Create one core-owned matcher/inspection pipeline in `portcove-core`. CLI, Tauri, source discovery, registration, relink, verification, install, launch preflight, and GUI presentation must consume its result rather than reimplementing rules.

A recommended core result is conceptually:

```text
SourceInspection
  profile_id
  source_health
  observed_identity
  classification
  upstream_contract_result
  admission_result
  expected_identity_details
  qualification_summary
  evidence_ids
  catalog_sha256
```

### Required matcher coverage

Support all current paths:

- ordinary files
- raw N64 byte orders
- canonicalized N64 big-endian matching
- ZIP members
- exact file sets
- GameCube normalized ISO identity
- PS1 single-disc tracks
- PS1 multi-disc sets
- volume IDs
- pinned upstream validators
- current STFS/LIVE or compound source paths
- current BIOS identity paths

### Matching rules

1. Compute and retain both original storage identity and normalized content identity where they differ.
2. Always label the algorithm and byte scope.
3. Preserve hashing limits, archive-entry limits, traversal protection, tool requirements, cancellation checkpoints, and current error typing.
4. Multiple digests in one identity alternative are conjunctive.
5. Multiple identity alternatives and representations are disjunctive.
6. Return an ambiguity error rather than selecting the first match.
7. Do not claim an exact revision from a volume ID unless the evidence proves that the ID is revision-unique.
8. A validator-only success may produce `upstream-validated` without a variant ID.
9. A recognized variant outside the selected port contract is `not-listed`, not “incompatible.”
10. Informational acceptance does not convert `unrecognized` or `not-listed` into upstream support.
11. Enforced mismatch errors continue to include useful actual identity details without leaking source bytes.
12. Source discovery automatically identifies only deterministic exact matches. Informational extension-only candidates may be shown after explicit user-selected roots/profiles, but they are never silently registered or presented as exact matches.
13. Results are candidates until the user explicitly registers them.
14. Preserve equal-contract hashing deduplication and current bounded scanning behavior.

### Observed identity

Introduce a versioned structured `ObservedSourceIdentity` or equivalent that can represent:

- content SHA-1/SHA-256/CRC32 values
- storage SHA-256 and size
- canonicalization used
- archive member name and identity
- file-set members
- disc/track members
- multi-disc ordering
- volume IDs
- validator contract/result
- tool/version information where a normalized identity depends on a local tool

Observed facts are authoritative local evidence. A catalog classification is derived from those facts.

---

## SQLite schema 13

Bump SQLite from the current schema to 13 after verifying the actual current value.

Keep the existing `profile_id` registration key stable.

Add versioned structured observed identity and optional derived-classification cache data. This may use new columns or a dedicated table, but it must satisfy these rules:

1. Existing source rows remain usable.
2. Existing rows begin with no structured observed identity and durable classification `not-evaluated` unless the migration can prove a result without guessing.
3. Do not pair old digest arrays or infer variants during migration.
4. Registration and relink persist the newly observed identity and may persist the current derived classification.
5. `source verify` computes and returns current inspection/classification but does not mutate SQLite.
6. Install and launch preflight consume a current inspection but do not require a classification cache for correctness.
7. Any cached match includes:
   - classification state
   - matched variant ID if known
   - matched representation ID if known
   - catalog SHA-256 used for classification
   - classification timestamp
8. The cache is never the byte authority and must be safely recomputable or invalidated when the active catalog changes.
9. A catalog update cannot rewrite the source baseline.
10. Source files remain untouched.
11. Migration verification proves all new columns/tables and constraints are completely applied.
12. Opening an older library upgrades safely.
13. Opening schema 13 with an older Portcove binary is not promised. The newer-schema error must remain explicit and non-destructive.

Do not store a singular `matched_evidence_id` as though one evidence record always proves a match. Resolve the evidence chain from the variant/representation/contract or store plural evidence IDs.

---

## Library metadata format 1

Keep library metadata format 1 for backward compatibility.

Add only optional/defaulted fields for:

- structured observed source identity
- classification cache
- matched variant/representation IDs
- source-contract context where needed

Requirements:

- New Portcove imports existing format-1 metadata.
- New format-1 exports round-trip all new optional fields.
- Missing new fields default conservatively to `not-evaluated`.
- Exported metadata contains identities/references only, never source payloads.
- Do not claim that an older Portcove binary can understand every new semantic field; only preserve the documented safe compatibility behavior.

---

## API schema 11 and CLI

Bump the shared CLI/Tauri API schema from the current value to 11 after verifying the actual current value.

Expose one core-owned inspection model consistently.

### Required machine-readable output

Include:

- source health
- storage identity
- normalized content identity
- classification state
- matched variant and representation
- upstream source-contract result
- admission mode/result/reason
- expected identities with algorithm and scope
- evidence IDs and safe display metadata
- per-platform automated and hands-on qualification coverage
- artifact/release applicability status
- legacy variant-unspecified qualification where applicable

### CLI surface

Add or extend a command so users can inspect a registered source without mutating it. Prefer an explicit command such as:

```text
portcove source inspect <profile-id>
```

Also include the same inspection in `source verify` results.

Human-readable output must show:

- recognized title/region/revision
- whether the reviewed upstream contract lists it
- whether Portcove accepted it and why
- original file/container SHA-256
- normalized content hashes
- expected hashes
- automated and hands-on coverage
- evidence labels/links

JSON output must expose full hashes and stable IDs without relying on formatted prose.

Do not make the CLI independently interpret catalog variants.

---

## Tauri and external navigation

Tauri commands must call the core inspection API.

For evidence navigation:

1. The renderer passes an `evidence_id`, not an arbitrary URL.
2. The backend resolves the ID against the active trusted catalog.
3. The backend revalidates the exact stored URL.
4. Only then may the backend open the link.
5. Reject unknown IDs, stale IDs, unsafe URLs, and URLs not present in the active catalog.

Do not trust a URL merely because React previously displayed it.

---

## GUI requirements

Update all relevant source surfaces:

- source discovery
- game/port details
- Source Integrity
- registration/relink/verification feedback where appropriate

### Primary user-facing states

Use player-facing wording similar to:

| Internal meaning | Preferred copy |
|---|---|
| Deterministic match | **Recognized source: Super Mario 64 (USA)** |
| Informational unrecognized | **Accepted, but the exact edition could not be identified** |
| Legacy/not evaluated | **This source has not been checked yet** |
| Recognized but not listed by this port | **This edition is not listed in this port’s reviewed requirements** |
| Enforced rejection | **This source does not match an edition accepted by this port** |
| Automated pass | **Automated setup checks passed on Windows** |
| Hands-on pass | **Hands-on test passed on Windows** |
| No exact qualification | **Not yet tested with this edition on Windows** |
| Storage unchanged | **Original file unchanged since it was added** |
| Normalized match | **Normalized game data matches** |
| Release not rebound | **Source requirements have not been rechecked for this release** |

Do not use “provenance,” “qualification,” “materialization,” or “identity scope” as the primary player-facing labels.

### Hash presentation

- Always show algorithm and scope.
- Clearly distinguish:
  - original file/container SHA-256
  - normalized content SHA-1/SHA-256
  - archive-member identity
  - disc/track identity
  - file-set member identity
- Show a short digest in summary rows and the full copyable digest in expanded details.
- Allow copying every full expected and observed digest.
- For N64, explain that canonicalized game-data hashes can differ from `.n64`/`.v64` file hashes.
- For ZIPs, show the member and outer ZIP separately.
- For discs, show disc number/name and track-set scope.
- Never communicate match state by color alone.
- Preserve keyboard and gamepad navigation, focus behavior, accessible labels, and existing modal hierarchy.

### Evidence wording

Use a label such as:

- **Why Portcove recognizes this source**
- **Reviewed upstream requirements**
- **View current upstream requirements — they may differ from Portcove’s reviewed contract**

The immutable reviewed link is the primary evidence. The live link is explicitly a drift-review convenience.

### Qualification aggregation

A port-level badge must be derived from exact records and remain honest.

Examples:

- “Automated checks passed on Windows for 1 of 4 recognized variants.”
- “Hands-on tested on Windows with US 1.0.”
- “Historical Windows test exists, but the source edition was not recorded.”

Adding a new untested variant must not leave an unconditional all-variant badge.

---

## Signed catalog behavior

Keep:

- signed envelope format 1
- Ed25519 trust and replay protection
- active/previous/embedded fallback
- current 4 MiB signed-catalog size limit
- frozen installed-code/source/persistence safety boundary

### Frozen fields

The following require a Portcove application release:

- source identity profiles
- logical variants
- representations
- paired identity alternatives
- evidence that defines source identity
- source contracts
- admission mode
- supported variant membership
- validator definitions
- meaning of stable IDs

### Signed-updateable fields

The signed delivery path may update reviewed metadata that is already allowed to change, including:

- port presentation metadata
- release metadata
- exact artifact-to-existing-contract bindings
- artifact-scoped qualification records
- qualification evidence links
- platform coverage derived from those records

A signed catalog must never introduce a new source contract or change the meaning of an existing one.

### Compatibility and fallback tests

Add fixtures proving:

1. New Portcove encountering an incompatible cached schema-1 signed catalog safely falls back through current active/previous/embedded selection without corrupting state.
2. An older schema consumer rejects a schema-2 signed catalog rather than partially interpreting it.
3. A schema-2 catalog cannot change frozen source contracts through delivery format 1.
4. Permitted qualification/release metadata can still update.
5. Catalog selection and rollback remain valid.
6. Catalog-size tests leave meaningful headroom below 4 MiB.
7. Evidence registry deduplication prevents unnecessary growth.

Do not build a second catalog authority.

---

## Catalog migration and evidence audit

### Current catalog

Migrate every current source profile to schema 2.

For each profile:

1. Preserve its stable profile ID.
2. Assign its consuming port contract an explicit `enforced` or `informational` admission mode.
3. Preserve current rejection behavior.
4. Convert deterministic identities to named logical variants and representations.
5. Capture immutable upstream support evidence.
6. Use preservation crosswalks only when required and fully versioned.
7. Record an explicit evidence gap where no deterministic variant can be identified.
8. Preserve current exact source, disc, file-set, validator, conversion, and adapter safety behavior.
9. Avoid duplicate game identities where reusable profiles already exist.
10. Do not commit source bytes.

### Required targeted corrections

At minimum, add regressions and reviewed catalog corrections for:

- Ghostship US and JP from the selected immutable 2.0.0 manifest
- Lighthouse 1.1.0:
  - US 1.0
  - US 1.1
  - JP
  - PAL
- Ship of Harkinian’s selected versioned supported-ROM contract
- 2Ship2Harkinian’s selected versioned supported-ROM contract
- Starship’s selected versioned supported-ROM contract and supported US revisions
- shared Banjo identity with distinct Lighthouse/Banjo Recompiled contracts
- shared Majora’s Mask identity with distinct 2Ship2Harkinian/Zelda 64: Recompiled contracts
- Bomberman Party Edition’s proven paired identities
- current validator-only profiles
- current volume-ID-only profiles
- current extension-only informational profiles

The Ghostship manifest values beginning `8a20a5…` and `9bef11…` are SHA-1 values. Label them correctly and prove any SHA-256 crosswalk rather than assuming it.

### Dynamic port-ticket audit

Do not hard-code “115 tickets,” “50 research tickets,” or any other total.

Generate the inventory dynamically from:

- the current catalog
- durable `[Port]` issues and their machine-readable markers
- read-only Project fields where available

Fail or flag:

- duplicate catalog IDs
- duplicate direct-upstream identities
- catalog ports without exactly one durable port issue
- non-catalog port issues incorrectly presented as supported
- malformed/missing machine-readable markers
- stale catalog/issue identity mismatches

Every current port ticket must appear in the generated snapshot, but only cataloged ports appear in the GUI.

For non-catalog tickets, capture:

- issue/upstream identity
- cataloged or not
- source-evidence state
- release-integrity state if already recorded
- exact gap/blocker
- timestamped Project stage/horizon/target-release context where available

Do not make exhaustive source-contract research for every non-catalog ticket a blocker for shipping the cataloged-source feature. Missing research remains an explicit gap.

---

## Generated provenance snapshot

Produce a dated immutable snapshot, not a second roadmap.

Recommended location:

```text
docs/archive/YYYY-MM-DD-supported-source-provenance-audit.md
```

The report must record:

- generation timestamp
- repository base/final commit
- catalog SHA-256
- catalog/profile/variant/contract counts discovered at generation time
- issue inventory count discovered at generation time
- Project-state fingerprint or explicit unavailable status
- cataloged versus non-catalog entries
- deterministic identity completeness
- upstream support evidence completeness
- preservation crosswalk usage
- qualification coverage
- explicit gaps and drift observations

Group primarily by stable source-evidence facts. Project priority, horizon, target release, status, and Port stage are timestamped context only.

The live GitHub Project remains the sole planning authority. The snapshot must not become a TODO ledger, status file, milestone mirror, or priority authority.

Provide:

- an offline deterministic generator/test path
- an optional read-only live enrichment path
- no normal-CI requirement for a personal GitHub Project token
- no GitHub writes

Use the existing roadmap tooling and governance model rather than creating a parallel tracker.

---

## Tests and acceptance criteria

### Catalog validation

Reject:

- missing or duplicate stable IDs
- invalid ID syntax
- references to missing profiles, variants, representations, contracts, validators, evidence, or qualifications
- logical variants with no representation and no explicit gap
- enforced contracts with neither deterministic variants nor a validator
- informational empty contracts without explicit gap text
- malformed digest lengths/algorithms
- identity objects whose algorithms are not proven to share one scope
- duplicate/ambiguous deterministic identities
- ambiguous member/disc identity
- unsafe filenames/paths
- unsafe or malformed evidence URLs
- unsupported preservation crosswalk records
- preservation records without version/source digest
- empty silent source contracts
- qualification for undeclared ports/platforms/variants/contracts
- manual qualification that violates current automated-prerequisite policy, unless the policy is deliberately changed and documented
- qualification bound to no artifact where an artifact digest is available
- duplicate qualification IDs
- source-contract binding to a nonexistent frozen contract

### Matcher tests

Cover:

- deterministic supported match
- recognized but not listed
- informational unrecognized acceptance
- enforced mismatch
- validator accepted without variant
- validator rejected
- not-evaluated legacy state
- normalized N64 byte orders
- ZIP member and ZIP storage identity
- file set
- single-disc track identity
- multi-disc set
- GameCube normalized ISO
- volume ID
- STFS/LIVE or current compound source path
- BIOS source
- multiple conjunctive hashes
- alternative representations
- ambiguous match rejection
- hashing/cancellation/size-budget behavior
- original file unchanged versus normalized content matched

### Admission-equivalence test

Build a golden comparison against the pre-change catalog and matcher:

- Every currently legitimate accepted source fixture remains accepted.
- Every current rejected mismatch remains rejected.
- The only allowed differences are the explicit reviewed expansions and the rejection of impossible cross-paired identities caused by the old ambiguous schema.
- The test must identify the profile and reason for every difference.

Do not include copyrighted ROM bytes. Use digest-level fixtures and small synthetic data for byte-order/container behavior.

### Database and lifecycle tests

Prove:

- schema 12 upgrades to 13
- existing registrations remain usable
- existing source rows start conservatively
- registration and relink persist observed identity
- source files are never modified
- `source verify` leaves SQLite and the stored baseline unchanged
- classification can be recomputed under a new catalog
- stale classification cache is invalidated or ignored
- missing/changed source health remains independent of variant match
- import/export/relink preserve optional identity metadata
- old format-1 metadata imports
- new format-1 metadata round-trips
- install/launch consume current inspection
- unbound new artifacts do not inherit qualification
- a changed artifact digest invalidates qualification
- interrupted mutations preserve current recovery guarantees

### CLI/API tests

Verify:

- API schema 11
- stable machine-readable states and IDs
- full actual and expected hashes
- explicit algorithm/scope
- inspection and verification parity
- human-readable wording
- legacy variant-unspecified qualification
- error/exit behavior for enforced mismatch and ambiguity
- no CLI-owned matching logic

### GUI tests

Verify:

- recognized source wording
- informational unknown wording
- recognized-but-not-listed wording
- legacy not-evaluated wording
- full copyable hashes
- original versus normalized identity
- ZIP member versus container identity
- disc/member labels
- separate automated and hands-on badges
- partial variant coverage summaries
- historical unspecified coverage
- unreviewed-current-release state
- evidence navigation by ID
- rejection of arbitrary URLs
- keyboard/gamepad/focus/accessibility behavior
- no color-only state
- no raw internal architecture terminology as primary copy

### Signed-catalog tests

Verify:

- schema-2 embedded catalog
- format-1 envelope
- frozen source/evidence/contract fields
- permitted artifact binding and qualification updates
- active/previous/embedded fallback
- old/new schema rejection behavior
- rollback
- replay protection
- evidence URL safety
- payload-size headroom

### Audit-generator tests

Verify:

- dynamic counts
- deterministic output for fixed fixtures
- duplicate issue/catalog detection
- cataloged/non-catalog separation
- no network requirement for offline tests
- read-only live mode
- no Project/issue writes
- generated snapshot declares itself non-authoritative for planning

### Targeted regressions

Include named regressions for:

- Ghostship US
- Ghostship JP
- Lighthouse US 1.0
- Lighthouse US 1.1
- Lighthouse JP
- Lighthouse PAL
- Shipwright selected variants
- 2Ship2Harkinian selected variants
- Starship selected US revisions
- Bomberman Party Edition paired identities
- one informational extension-only profile
- one pinned-validator profile
- one volume-ID profile
- one file-set profile
- one multi-disc profile

---

## Implementation sequence

Implement in reviewable phases and commits, but continue through the full task.

### Phase 0 — Baseline and design lock

- Record the base commit.
- Inventory current catalog profiles, ports, source kinds, admission behavior, qualification data, and issue coverage dynamically.
- Add the golden admission baseline.
- Document the final domain distinctions and frozen-versus-updateable signed fields.
- Do not create a second planning ledger.

### Phase 1 — Catalog schema 2

- Add evidence registry.
- Add reusable logical variants and typed representations.
- Add paired identity alternatives.
- Add per-port source contracts and admission modes.
- Add catalog validation.
- Migrate existing catalog data without changing admission behavior.

### Phase 2 — Core matcher and inspection

- Centralize matching and inspection in `portcove-core`.
- Route every source path through the same domain result.
- Add ambiguity protection and identity-scope labeling.
- Preserve budgets, cancellation, and structural safety.
- Add targeted upstream variant expansions only after evidence review.

### Phase 3 — SQLite 13 and metadata compatibility

- Add observed identity and optional classification cache.
- Migrate existing libraries conservatively.
- Preserve read-only verification.
- Extend format-1 metadata with optional fields.
- Add migration, import/export, relink, and stale-cache tests.

### Phase 4 — API 11, CLI, and Tauri

- Expose the shared inspection model.
- Add/extend `source inspect`.
- Add verification parity.
- Add backend evidence-ID navigation.
- Update generated schemas and transport tests.

### Phase 5 — GUI

- Update discovery, game details, and Source Integrity.
- Implement player-facing copy and hash inspection.
- Add per-variant/platform qualification coverage.
- Preserve accessibility and controller/keyboard behavior.

### Phase 6 — Granular qualification and signed delivery

- Introduce artifact-scoped automated/hands-on records.
- Migrate old platform arrays honestly as variant-unspecified where necessary.
- Derive aggregate badges.
- Update signed-catalog mutable/frozen comparison.
- Add fallback and payload-size tests.

### Phase 7 — Provenance snapshot and documentation

- Generate the dated dynamic snapshot.
- Update stable architecture, CLI, signed-catalog, security, catalog, and user-facing documentation as applicable.
- Keep live priority/status in the Project.
- Record evidence gaps without admitting research tickets to the GUI.

---

## Documentation updates

Update the existing authoritative documents rather than creating redundant status files.

At minimum review and update as applicable:

- `docs/ARCHITECTURE.md`
- `docs/CLI.md`
- `docs/SIGNED-CATALOG.md`
- catalog/source documentation
- `SECURITY.md`
- user-facing README/help text
- generated JSON schema/API references
- project governance only if needed to describe the dated read-only snapshot

Document:

- five independent source/qualification dimensions
- logical variants versus representations
- original versus normalized hashes
- admission-mode semantics
- evidence authority and crosswalk policy
- release applicability
- read-only verification
- signed frozen/updateable boundaries
- compatibility and downgrade limits
- audit snapshot’s non-authoritative planning role

Do not create `STATUS.md`, a JSON backlog, a duplicate roadmap, or a fixed port-count target.

---

## Required commands and validation

Run focused tests throughout, then the full repository gates.

At minimum run the appropriate current equivalents of:

```text
cargo fmt --check
focused Rust tests for catalog, matcher, database, source lifecycle, signed catalog, and CLI
focused frontend/component tests
generated schema/contract checks
just check
just audit
just deep
```

If a named command has changed, use the current repository-defined equivalent and report it.

Do not claim success for a command that was not run. Record exact failures, environmental blockers, and skipped human checks.

---

## Completion report

When implementation is complete, provide a concise but complete report containing:

1. Base commit and branch/worktree used.
2. Architectural summary.
3. Catalog schema 2 summary.
4. SQLite 13 migration summary.
5. API 11 and GUI/CLI summary.
6. Exact reviewed admission changes.
7. Confirmation that no other legitimate admission boundary changed.
8. Evidence sources and unresolved evidence gaps.
9. Dynamic catalog/issue counts from the generated snapshot.
10. Files changed.
11. Focused and full test commands with exact outcomes.
12. Any remaining hands-on or external validation that cannot be replaced by automation.
13. Confirmation that no GitHub issue or Project state was modified.

Do not mark the task complete merely because the code compiles. Completion requires matching tests, migration tests, transport tests, UI tests, signed-catalog tests, documentation, the generated snapshot, and exact validation evidence.

