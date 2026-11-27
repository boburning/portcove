# Signed catalog delivery, format 1

This optional local-first contract updates metadata for the embedded catalog. No publisher key, production private key, server, account, or scheduled fetch is configured by default. Local files work without a network; an explicitly requested HTTPS fetch carries no Portcove/GitHub credential and follows no redirects. The optional advisory relay and desktop self-updater are separate features.

This is the implemented format-1 contract. The [independent definition delivery
contract](DEFINITION-DELIVERY.md) owns the successor's authority, admission,
retention and recovery boundaries. Completed
[#245](https://github.com/boburning/portcove/issues/245),
[#397](https://github.com/boburning/portcove/issues/397),
[#398](https://github.com/boburning/portcove/issues/398) and
[#254](https://github.com/boburning/portcove/issues/254) supply the accepted design,
compatible client loader, configured upstream observer and bounded authoring.
Their delivered components and fixture evidence remain distinct from
[#246](https://github.com/boburning/portcove/issues/246)'s pending protected
production journey and [#534](https://github.com/boburning/portcove/issues/534)'s
pending provisioning acceptance. They do not weaken or retrofit this format's
embedded-contract restrictions. No live automatic admission is enabled here.

#246's remaining minimum observes a new operational definition, its next actual
eligible artifact and a safe compatible correction on one exact unchanged
capable installed client through actual protected acceptance, signing,
publication and public readback. Authenticated descriptive listing delivery
does not grant execution or installation capability. Existing components retain
exact definition content and referenced source/execution/persistence contracts
for installed, staged, previous and adopted versions, together with relevant
artifact, runtime/tool, platform and source identities. A remote URL or digest
alone cannot preserve an installed contract. Migration preserves existing catalog
availability and isolates unsupported new semantics. Observation has no signing
or admission authority, and availability never authorizes installation, trust
expansion or data migration. The format-1 behavior below remains unchanged.

## Publisher format

The outer JSON object has exactly `format_version: 1`, `key_id`, `payload`, and `signature`. It is at most 16 MiB, including all JSON escaping; clients before library writer protocol 60 still refuse more than 4 MiB (see [Size bounds and older clients](#size-bounds-and-older-clients)). `key_id` is the lowercase hex SHA-256 of the raw 32-byte Ed25519 public key. `signature` is the 64-byte signature in hex. `payload` is a JSON **string**; its exact UTF-8 bytes are signed, without parsing, whitespace changes, or reserialization by the verifier.

The signing message is the byte concatenation of:

1. UTF-8 `Portcove signed catalog v1` followed by one LF (`0a`);
2. the 64 ASCII characters of `key_id`, followed by one LF;
3. the exact UTF-8 bytes of `payload`.

The payload object has exactly `sequence`, `issued_at`, `expires_at`, and `catalog`. Sequence is a positive integer at most `9007199254740991`; times are integer Unix seconds. Issuance cannot be in the future, expiry must be in the future and later than issuance, and validity cannot exceed 366 days. The embedded `catalog` is the ordinary schema-2 catalog document, not a CLI response envelope. Signed envelope format remains 1. Consumers use `ed25519-dalek` strict verification and reject weak keys. See the [verifier's primary documentation](https://docs.rs/ed25519-dalek/3.0.0/ed25519_dalek/struct.VerifyingKey.html) and [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032).

All normal core catalog validation runs before admission. The schema-2 identity, representation, identity evidence, admission, validator, alias, tombstone, plus embedded entry identity, executable/setup/source-materialization contracts, persistent-data ownership, and legacy qualification arrays must match the embedded application catalog. Changes to those contracts ship in an application update. Format 1 may add reviewed release applicability and exact artifact-scoped qualification records for existing source contracts. Existing applicability and qualification facts cannot be removed or rewritten, and every added record must reference an existing port, contract, supported variant, representation, artifact binding, check version, and reviewed evidence ID. Allowed metadata also includes names, descriptions, project URLs, support/channel/platform declarations, release resolution, and upstream status. Product-level V1 scope remains a Project/release-gate decision, not catalog membership. A signed catalog cannot bypass release SHA-256 verification or execute an arbitrary adapter.

## Producing and reviewing an envelope

Format-1 metadata corrections retain the authored listing directory's download
restrictions through Core's existing strict-presentation projection. A release
URL, asset hint or package availability cannot clear that separate condition.
Bounded authoring (#254), compatible loading (#397) and configured observation
(#398) are completed components. Their fixtures and this envelope format do not
establish #246's production journey or #534's provisioning acceptance.

Shipwright working-directory persistence requires a capable bundled client or
an indexed definition declaring `libultraship-portable` capability version 3.
The format-1 signer and verifier refuse that operational field. A newer client
applies compatible format-1 metadata with the persistence authority compiled into
the client. Use a format-1-compatible catalog input for the legacy command.

Run `node scripts/sign-catalog.mts --help` for the required arguments, limits and
an example. Help does not read signing inputs or create output files.

With an existing publisher-controlled Ed25519 PKCS#8 PEM key, run:

```text
node scripts/sign-catalog.mts --catalog legacy-catalog.json --key publisher-private.pem --sequence 1 --expires-at <unix-seconds> --output catalog-signed.json
```

The key and catalog inputs must be regular files, limited to 64 KiB (65536 bytes)
and 16 MiB (16777216 bytes), respectively. The escaped signed envelope has its own
16 MiB limit, so a catalog within its input limit can still produce an oversized
envelope. The capacity check reserves growth margin below supported bounds.
Refusals identify the affected argument, limit and observed size without
including key or catalog contents. Sequence must be a positive safe integer;
issuance and expiry use integer Unix seconds with validity of at most 366 days.

The utility defaults issuance to the current time, accepts an explicit `--issued-at`, prints only the public key/fingerprint and output identity, and refuses to overwrite its output. It does not generate or choose a production key, upload anything, or replace core catalog validation. Private-key paths are inputs to this offline publisher utility, never Portcove runtime configuration. Publishers should validate the signed output through core before distributing it:

```text
portcove --library <isolated-review-library> --json catalog trust-key <public-key-hex> --yes
portcove --library <isolated-review-library> --json catalog update --file catalog-signed.json
portcove --library <isolated-review-library> --json catalog update --file catalog-signed.json --apply --expected-plan <plan_sha256>
portcove --library <isolated-review-library> --json doctor
```

Production users verify the public key/fingerprint through a trusted independent channel before granting trust. Key rotation requires explicitly adding the replacement key and later revoking the old one. Sequences continue increasing across keys; rotation does not reset replay protection. No production custody or infrastructure decision is implied by these examples.

The review plan lists changed port IDs and display names from the verified candidate catalog. Desktop presents those names as catalog information changes and makes clear that applying the catalog does not install game updates. It keeps the verified signature, trusted key fingerprint, accepted sequence, expiry, changed IDs, and envelope digest available in technical details. Trusting a publisher permits changes to release download locations. Desktop keeps the selected source when the trust prompt is cancelled or accepted. Review that source again after a trust change. Each verification replaces the previous review, and applying a verified catalog requires a separate action.

## Publication and recovery

Review binds the exact envelope, delivery selection, current key set, selection revision, cached versions, and highest accepted sequence. Application rereads and revalidates, including expiry. SQLite atomically publishes the candidate, advances the replay floor, and records the completed activity. Cancellation can win before publication admission; a critical commit finishes safely. Concurrent or changed reviews cannot both publish. Failed verification or a rolled-back database transaction leaves the prior selection intact.

Each service command reads one coherent local snapshot. Later commands verify current key trust, signature, validity and catalog contracts again. If active data is bad, the previous trusted unexpired catalog is tried; otherwise the embedded catalog is used. Diagnostics report actual origin, document digest, sequence, key fingerprint, expiry and fallback reasons. Expired signatures never become an indefinite offline exception; embedded metadata remains available instead.

Within one catalog-status command, active and previous candidates are each verified at most once. That command reuses only its in-memory evaluation while composing status and selected-definition provenance under the same database snapshot, key set, candidate bytes and evaluation time. It is not a cross-command cache: a later command, changed trust or selection, or a later clock reading performs a new evaluation. Direct catalog loads retain their narrower active-then-previous fallback and do not verify an unused previous candidate.

Explicit rollback consumes the previous selection and keeps the highest sequence. It does not retain the rejected newer catalog as the next fallback. `use-embedded` preserves trust and cache; `use-cached` revalidates the cache without admitting an external replay. Revocation immediately affects the next command, including both cached versions. Already-running commands keep their original snapshot and cannot change executable or data ownership because those contracts are frozen.

Trust and replay state belong to the local library's database. Managed moves retain it. Metadata-only export/import intentionally leaves it out, so each destination configures its own trust; old installed artifacts remain subject to the same embedded safety contracts. This protects against network/publisher-delivery tampering and replay under an intact local database. It does not protect against a local attacker rewriting that database, restore its newer replay floor after a whole-database rollback, or supply a trustworthy system clock.

Bundled-runtime updates may change their pinned archive asset and archive root, like a game release update. They cannot add or remove a runtime platform, change its mount directory or executable, or make runtime files mutable. Runtime-only updates receive a distinct immutable install identity. Adding a new runtime execution contract requires an application update; an older cached catalog that omits the new contract is rejected and falls back through the normal verified selection rules.

## Size bounds and older clients

The publication policy in #5894 uses supported consumer bounds. Changes reserve
15% of capacity for growth, including JSON escaping. A catalog may exceed 4 MiB
once compatible application packages are available on the affected channels.

| Representation                            | Supported bound and owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generated and compact operational catalog | 16 MiB for signer input, local proposal inspection and whole-catalog upstream observation and checkpoints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Escaped signed envelope                   | 16 MiB including the signature, checked on file and HTTPS reads and before signing. Migration 60 preserves both exact active and previous envelopes and the replay floor. Each has a frozen 16 MiB SQLite check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Core catalog projection                   | 16 MiB per indexed content target. The release-tools publisher and Core share the path-specific size policy. The separate index and definition entries have 4 MiB limits. Definition contents share a 32 MiB aggregate bound.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Retained format-1 catalog                 | 16 MiB of compact catalog JSON. The retained contract is escaped again inside an installation manifest or registration. The CI guard budgets that escaped contract against 16 MiB and leaves space for the rest of the record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Retained browsing                         | Verified per-install manifests and retained registration reads have a 32 MiB byte limit. The retired-listing lookup and workspace projection still use finite request-wide budgets. User-selected listings already retain one entry. Artwork requests can use the existing per-port route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Other retained and descriptive documents  | SQLite indexed selection rows have a separate 16 MiB limit including escaping. Publication checks the exact escaped snapshot and reserves 4 KiB for selection identity and provenance. The embedded listing directory has no byte bound; listing text inspected from outside the binary has a 64 MiB working-memory bound, and signed listing targets keep their delivery bounds (see [Reader generations](#reader-generations)). The TUF snapshot has a 4 MiB limit. [Observer recovery archives](UPSTREAM-OBSERVATIONS.md#catalog-scheduling-and-definition-delivery-handoff) have a 16 MiB format 4 limit and a 4 MiB legacy limit. The staged coherence check has a 64 MiB aggregate budget for authored, generated and historical data together. Provider responses, package downloads and artwork keep their own bounds. |

`node scripts/catalog-capacity.mts --check` reports generated and compact
operational bytes, a representative escaped signed envelope, the listing
directory against each consumer that can stop its delivery and the committed
definition index. It is one guard with one bound source
(`listingDeliveryBounds`). The listing rows cover Core's 64 MiB inspection of
the authored text, which is also the canonical read in
`scripts/listing-observation-delivery.mts`; the compact carrier's decoded,
wire, per-record and entry-count bounds that the released readers enforce,
modeled with observations and a lead-time margin (see
[Compact carrier capacity guard](#compact-carrier-capacity-guard)); the
current generation's element budget; and the frozen legacy target, which is
informational only.
The Core test `catalog_growth_stays_within_supported_capacity` measures Core
serialization for the complete projection, escaped indexed snapshot, retained
catalog and escaped contract. On November 23, 2026 the generated operational
catalog measured 4,263,284 bytes, the compact catalog 3,271,875 bytes and its
representative signed envelope 3,449,316 bytes. The generated listing
directory measured 6,449,993 bytes. The complete retained graph remains
available for existing installs and rollback. A per-port retention redesign
requires separate work. Once the lead activates the [listing-body window](RELEASING.md#catalog-listing-body-window), superseded listing bodies leave the served tree. They stay in `gh-pages` Git history, and the listing-floor ledger keeps what history verification derives from them. Metadata, current and previous bodies, and pinned publications stay served. Metadata stale across two or more publications inside the 600-second Pages cache window can name a pruned body and get a 404; the client treats that as an incomplete delivery and recovers on its next refresh.

### Reader generations

Each application build is a reader generation. A released reader's limits
bind every publication it must still read: the publisher keeps honoring them
until a newer generation is released, the released-reader gate verifies it,
and the publisher is changed to depend on it. The current generation advertises
its limits as `listing_delivery_limits` in `capabilities`; older readers omit
the field. Listing formats and bounds by released reader (from each tag's
`types.rs`, `listing_delivery.rs` and `portcove-listing-carrier`):

| Released reader                                             | Listing formats | Compact carrier | Legacy target | Compact decoded, record | Entry count                |
| ----------------------------------------------------------- | --------------- | --------------- | ------------- | ----------------------- | -------------------------- |
| `v0.1.0-preview.1`, `.2`; `nightly-0.1.0-preview.3` to `.6` | 5–10            | No              | 8 MiB         | —                       | 10,000 each                |
| `nightly-0.1.0-preview.7` to `.12`                          | 5–12            | No              | 8 MiB         | —                       | 10,000 each                |
| `nightly-0.1.0-preview.13`                                  | 5–13            | No              | 8 MiB         | —                       | 10,000 each                |
| `nightly-0.1.0-preview.14`                                  | 5–15            | Yes             | 8 MiB         | 32 MiB, 1 MiB           | 10,000 each, while parsing |
| `nightly-0.1.0-preview.15`                                  | 5–15            | Yes             | 8 MiB         | 32 MiB, 1 MiB           | 10,000 each, while parsing |
| `nightly-0.1.0-preview.16`, `.17`                           | 5–15            | Yes             | 8 MiB         | 32 MiB, 1 MiB           | 40 MiB element budget      |

Preview 16 is the first released reader with the element budget, and
Preview 17 keeps its listing bounds unchanged: they charge listings and
withdrawals against the element budget instead of counting them, advertise
`listing_delivery_limits`, and keep the 4 MiB definition index without a
definition count. Every earlier reader refuses more than 4,096 indexed
definitions and keeps the 4 MiB definition index. Which of them are still
supported is decided by `updates/withdrawn.json` and the released-reader gate.
The file is written by the first withdrawal; until then it is absent and no
version is withdrawn.

| Bound                                                | Preview 15 and earlier   | Current generation        | Why it stays or changed                                                                                                                |
| ---------------------------------------------------- | ------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Listing target body, either carrier                  | 8 MiB                    | 8 MiB                     | Whole-target read before its digest check; the frozen `listing_delivery` SQLite check.                                                 |
| Decoded compact directory                            | 32 MiB                   | 32 MiB                    | Decompression-ratio and working-memory bound, allocated before inflation; the `compact_listing_delivery` SQLite check. Measured below. |
| One compact listing record                           | 1 MiB                    | 1 MiB                     | Bounds the per-record duplicate-key JSON tree. The largest record is 8,517 bytes without observations and 36,596 with them.            |
| Listings and withdrawals                             | 10,000 each              | One 40 MiB element budget | Each element's measured working memory is charged: 4,027 bytes per listing, 68 per withdrawal. Measured below.                         |
| Definition index                                     | 4 MiB, 4,096 definitions | 4 MiB, no count           | An entry is about 110 bytes, so the index bound allows about 38,000 entries, a few MiB of memory (estimated, not measured).            |
| Definition content aggregate                         | 32 MiB                   | 32 MiB                    | One authenticated index with no continuation; 87,102 bytes today, 0.26%.                                                               |
| Bundled listing directory                            | 8 MiB, 10,000 listings   | No bound                  | Compiled into the binary; no untrusted input or allocation to protect.                                                                 |
| Listing text inspected by `catalog inspect-listings` | 8 MiB                    | 64 MiB                    | Twice the largest decoded directory a reader admits, so authored formatting never binds before delivery.                               |

The legacy target is already at its bound. Its frozen bytes, signed revision
49, are 8,388,496 bytes, 112 bytes below 8 MiB, and carry 1,193 of the 1,649
listings (observed November 24, 2026; see
[Compact listing activation evidence](#compact-listing-activation-evidence-november-24-2026)):
the publisher filled it and left the remaining rows to each reader's bundled
copy. A complete legacy target with today's signed observations would need
9,778,469 bytes. Format-11 readers therefore already receive a partial
directory. The legacy target is frozen at its last pre-cutover revision by the compact cutover
(see [Compact listing delivery](#compact-listing-delivery-and-the-minimum-supported-preview)),
so this size is reported as information, never as a CI ceiling. The canonical
read in `scripts/listing-observation-delivery.mts` is publisher input, not a
wire format, so it follows Core's 64 MiB inspection bound
(`listingDirectoryTextMaximum`) without a new reader generation. The next
constraints are the compact carrier's released-reader bounds and the element
budget below.

On November 23, 2026, with the signed observations of legacy revision 47, the
compact carrier measured 9,858,222 decoded bytes (29% of 32 MiB) and 2,808,370
wire bytes (33% of 8 MiB). Only 933 listings carried an observation, about
4,790 bytes each.

On November 23, 2026 the committed directory, deterministic 5x and 10x copies
with fresh identities, and two worst-case element shapes at the 32 MiB decoded
bound were measured in a Linux debug test build
(`measure_compact_directory_admission`, one phase per process). Admission is
carrier decode, compact parse and validation, and projection onto the bundled
catalog; inspection is the strict text parse `catalog inspect-listings` runs.
Peak is the resident-memory increase over the process before the operation.

| Scenario                         | Elements              | Decoded bytes | Admission peak, time | Text bytes | Inspection peak, time |
| -------------------------------- | --------------------- | ------------- | -------------------- | ---------- | --------------------- |
| 1x                               | 1,649 listings        | 5,365,988     | 17.6 MiB, 73 ms      | 6,449,992  | 28.6 MiB, 70 ms       |
| 5x                               | 8,245 listings        | 26,884,452    | 108.4 MiB, 374 ms    | 32,304,720 | 97.8 MiB, 339 ms      |
| 10x                              | 16,490 listings       | 53,782,532    | 220.2 MiB, 759 ms    | 64,623,130 | 194.9 MiB, 692 ms     |
| Minimal listings, no budget      | 350,672 listings      | 33,553,510    | 1,442.5 MiB, 2.6 s   | 48,281,672 | 607.6 MiB, 1.2 s      |
| Minimal withdrawals, no budget   | 2,888,709 withdrawals | 33,553,506    | 284.0 MiB, 1.9 s     | —          | —                     |
| Minimal listings, with budget    | refused while parsing | 33,553,510    | 45.6 MiB, 76 ms      | —          | —                     |
| Minimal withdrawals, with budget | refused while parsing | 33,553,506    | 58.6 MiB, 174 ms     | —          | —                     |

The decoded bound alone does not bound memory: small elements cost far more
than their bytes. Fitting the runs gives about 3.06 times the decoded bytes,
plus 3.93 KiB per listing and 68 bytes per withdrawal. A realistic directory
at the 32 MiB bound holds about 10,300 listings and needs about 138 MiB, of
which about 40 MiB is the per-listing share. The current generation charges
each element against that 40 MiB budget while it parses, so any shape stays
near the realistic directory's working memory: about 10,400 listings, or about
616,000 withdrawals, per admission. Admission also re-reads the stored
previous directory, so replacing a directory of the same size needs about
twice that. A directory beyond about 10,400 listings needs continuation (a
sharded, separately authenticated directory), not a larger count. Timings come
from a debug build and are upper bounds.

The 10x copy exceeds the released 8 MiB carrier and 32 MiB decoded bounds and
this generation's element budget; it was measured with the measurement-only
unbounded budget to show where the next change would land. The authoring
inspection has no element budget: it runs on authoring and CI machines, and a
64 MiB text bound of minimal listings would need about 860 MiB by
extrapolation from the measured 48 MB case. The Desktop IPC cost of a full
`listing_catalog` response at 5x and 10x is Unknown; a native measurement of
that command's serialized size and webview parse time with these fixtures
settles it.

To move the minimum supported generation:

1. Release an application build with this generation through the normal
   release route.
2. The released-reader gate selects that release and verifies that its
   `capabilities` report the required `listing_delivery_limits`.
3. Only then change the publisher (`scripts/listing-observation-delivery.mts`,
   the release-tools signer and the publication contracts) to depend on the
   new limits, for example to publish more than 10,000 withdrawals or 4,096
   definitions.

An older preview refuses the larger target and keeps its last admitted
directory until that signed metadata expires, then shows its bundled directory.
More than 4,096 definitions would make it refuse the whole definition index, so
it would also stop receiving definition refreshes. Its installed games,
libraries, saves and settings are unchanged. A library downgraded to an older
build after the current build stored a directory above the released count
cannot read that stored directory. It shows its bundled directory, and the
older build cannot admit a new directory until the current build replaces the
stored one. Step 3 makes that downgrade one-way for listings. The application
update offered on its channel restores current listings.

The catalog publisher bounds the retained signed repository at 768 MiB.
The publication job checks the exact staged Pages tree against its separate
900,000,000-byte limit, including browse and application files. The keyless
prepare job checks that retained files and new hash-addressed targets fit
before it starts the signing jobs. The signer rechecks capacity before opening
its key file. Assembly verifies the exact signed output and preserves prior
immutable URLs. The verifier loads one bounded history file at a time and
rechecks its digest before use.
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

Once the keyless release tool verifies and assembles the repository, the Pages
job matches its exact file inventory against the guarded current Pages tree.
It retains matching immutable files in place and stages only added repository
files, the new timestamp and the browse update. A stale prior digest, a missing
retained file, an immutable replacement or a changed assembled body stops the
run before the Pages push. Signers and the keyless assembler still validate
retained history under the existing TUF root and role keys. The signer extracts
historical revision floors from the delegated role body it already verified.
It checks each signed descriptor against a fresh SHA-256 inventory and parses
each referenced historical target body once. If Tough has already authenticated
that exact target body in the current generation, the signer reuses those bytes. Each new invocation computes its
own inventory and keeps the existing write-time and post-write readbacks.

Each descriptive target has an 8 MiB wire limit. The compact carrier has a
separate 32 MiB decoded limit. Both carriers share one decoded revision floor.
Checkpoint segments preserve the exact legacy artifact and every immutable
carrier body. The compact carrier is the only live listing carrier; the
legacy target keeps its last signed bytes (see
[Compact listing delivery and the minimum supported preview](#compact-listing-delivery-and-the-minimum-supported-preview)).

Run 44643025884 needed 139,099,484 bytes for retained files and new targets
before new role metadata, exceeding the former 128 MiB limit. Run 44838313111
could still read signed timestamp 45, but its proposed directory exceeded the
later 256 MiB limit.

Library writer protocol 60 rebuilds `catalog_state` in one transaction, copying
the singleton row, replay floor and both envelopes byte for byte. Failure leaves
the schema-59 table intact. Older binaries refuse both a migrated library and
their own catalog input above 4 MiB. The migration-11 and migration-60 constants
are fixed historical schema values.

See [Upgrading before a larger public catalog](UPGRADING.md#upgrading-before-a-larger-public-catalog)
for the release prerequisite and the supported player path.

### Indexed PS1 toolchain delivery

An operational `tool_artifacts` list belongs to a single managed PS1 subject
in catalog projection schema 4. The indexed entry must be definition schema 4
and require `tools.psx-toolchain-v1`. The authenticated content hash binds the
complete artifact inventory, including the exact allowed publisher URL, size,
SHA-256 and platform layout. Inspection can retain a proposal. Runtime
acquisition requires the independently pinned bundled identity, including
when a signed definition contains the proposal. The current independent
managed acquisition policy accepts the game subject's release asset and has
no tool-pack admission. Legacy catalog updates cannot appoint tool artifacts.
The primary publisher continues to produce its existing formats until a
capable released reader qualifies.

## Authenticated publication history checkpoints

History checkpoints are implemented but inert. Merging the implementation
enables no new publication. Push and scheduled `Catalog publish` runs never
request a checkpoint. Without a published checkpoint pointer they produce the
same plan, signing context and Pages tree as before. They create no checkpoint
target or `catalog-history/` tree and run no history steps.

Bootstrap is a separate owner-authorized activation. Only a manual
`workflow_dispatch` run with the `bootstrap_history` input set passes the
bootstrap request. The planner also refuses that request from any other
trigger. Bootstrap signs a new official-policy target,
`policy/official/catalog.history-checkpoint.json`, and publishes
`catalog-history/`. After that, every run continues the segmented history.
Activation is one-way: no supported path removes the pointer.

The checkpoint uses one standard official-policy target under the existing
scoped delegation. The target names an active checkpoint by length and
SHA-256. The checkpoint binds its predecessor timestamp, compiled root,
delegated authority and exact revision floors. Immutable segments carry old
file identities outside the legacy TUF URL tree. There are no custom Snapshot
or Timestamp fields, which earlier release tools would refuse.

The first checkpoint uses a fully verified predecessor. Once the current
signed policy names a checkpoint, each signing job receives the active TUF
roles and targets, a bounded active index and its tip segment. It verifies
the TUF chain, authority, latest suffix and exact revision floors before using
a role key. No file passed from the prepare job becomes signing authority.

Keyless assembly restores the pinned Pages inputs, verifies the segment and
parent chain against the actual historical SHA-256 inventory, and compares the
independently signed role bodies with its own expected successor. Publication
guards both the previous catalog and history trees and adds only addressed
history objects. An expected missing checkpoint, unavailable segment, exceeded
bound, stale Pages tree or changed body stops publication. Recover the exact
addressed objects from the pinned last-good Git tree before retrying. A broken
history pointer cannot trigger a new bootstrap.

### History bootstrap preconditions

The owner must resolve these before history bootstrap. Each failure below
stops publication in the prepare job's context check, before any role key is
used. The last good publication stays served, but publication stays stopped
until the cause is repaired. Compact listings and the signed cover checkpoint
can use the retained full repository. The signer authenticates its retained
policy, checks that the current cover matches the latest signed reference, and
validates the exact successor. Cover replacement review verifies the same
retained references. If segmented history is active, the signer also requires
its authenticated store and predecessor.
The first cover checkpoint still requires the separate owner activation,
authenticated compact listings, a verified withdrawal, and released-reader proof.

1. **Unbounded chain.** Each publication adds one inventory segment and one
   parent checkpoint. Verification walks both chains under one shared bound of
   4,096 objects and 64 MiB. After about 2,048 publications, every run fails
   with `catalog history chain reached its verification bound`. Two
   publications a day reach that in under three years. There is no bounded
   rebase. A rebase needs a fresh active checkpoint without a parent, and a
   defined way to keep archive-retention evidence once the segment chain
   restarts. _Open._
2. **Root rotation.** Each checkpoint binds the compiled root's SHA-256. The
   first publication after a root rotation fails with `catalog history
   checkpoint was made under a different trusted root`. Bootstrap cannot
   recover it, because an existing pointer always selects segmented history.
   Rotation needs a defined checkpoint successor before history is activated.
   _Open._

## Compact listing delivery and the minimum supported preview

Portcove is pre-beta. Under the owner policy of November 23, 2026 (#1422), the
compact carrier `policy/official/catalog.listings.compact.json`
(`gzip-base64-json-v1`) is the only listing target that changes.
Preview 14 (`0.1.0-preview.14`) introduced the compact carrier and remains the
minimum for format 15. **Preview 20 (`0.1.0-preview.20`) is the minimum for
formats 16 and 17.** The publisher reports the active format's minimum in each
preparation report. It is raised when a later reader generation replaces the
compact carrier.

Format 16 adds descriptive mod website links. Format 17 binds GitHub listing
identity and acquisition observations to a stable numeric repository ID. The
live publisher checks the protected release against `liveListingReaderFloors`
and runs the official binary to verify the candidate format before activation.
When an older compact reader rejects a successor, it can select its last
accepted directory while the stored provenance remains current. After that
provenance expires it uses its bundled directory until the application updates.

With a qualified format-16 reader, the publisher can add a browser link to a
listed Thunderstore community. The registry must explicitly refer to the same
numeric GameBanana ID already reviewed for that exact port. An unavailable
registry preserves the last accepted link. A complete registry can withdraw
a link that no longer matches. A changed community identity stops that link
until the provider reconciles it. A port's authored Thunderstore link takes
precedence. Maintainers can set `no_observed_mod_portals: true` on the port's
authored record to suppress generated links. If the optional candidate
fails carrier or reader validation, the publisher tries the same catalog
without the optional links. This projection changes only website actions in Mods.

The legacy format-11 target `policy/official/catalog.listings.json` stays
named in the official-policy role with its last signed pre-cutover bytes and
never changes again. Those bytes are revision 49, SHA-256 `9a025755…`,
8,388,496 bytes, first signed in official-policy version 62 and unchanged in
version 63, the cutover (observed November 24, 2026; see
[Compact listing activation evidence](#compact-listing-activation-evidence-november-24-2026)).
Preparation
republishes those exact authenticated bytes beside every compact target; it
has no legacy projection, byte-budget fitting, hold successor or legacy-only
return. Each compact revision is above the legacy revision.

### What an older preview does after cutover

Preview 13 and earlier read only the legacy target (format 11; Preview 13's
capability report lists formats 5–13 and no carrier). Read from the
`nightly-0.1.0-preview.13` sources:

- **Listing refresh.** The reader acquires `catalog.listings.json` by name
  (`listing_delivery.rs`, `acquire_admissible`). It is still signed in every
  new policy role version with the same bytes. An equal revision with equal
  bytes is admitted, so the stored directory stays selected and its signed
  provenance stays fresh. The player keeps the frozen legacy directory, with no
  error and no fallback, and receives no further listing changes.
- **Unknown target name.** Definition refresh walks the policy role's targets
  and skips any name that is not a stable definition ID. The compact name
  contains dots, so it is ignored.
- **Library and play.** The bundled catalog, library, installed games,
  originals, saves, settings and launch do not read the listing target.
  Definition and policy delivery continue unchanged.
- **Application update.** The updater reads
  `updates/{beta,preview}/latest.json` with its own minisign key, separately
  from the TUF catalog (`application_update.rs`); it does not read listing
  targets or catalog freshness. `application_update.rs` is identical at
  Preview 13, Preview 15 and `main` (read November 23, 2026), and the channel
  defaults to Beta.
  No Beta release exists yet, so each preview publication also writes
  `updates/beta/latest.json` as a byte-identical copy of the Preview feed
  ([interim Beta alias](RELEASING.md#interim-beta-alias)). A default-configured
  older preview is therefore offered the current preview through the Beta feed
  alias by its automatic check (at startup and every six hours) and by a
  manual check in Settings; no channel change is needed.

**What a Preview 13 player sees after cutover.** The game list stays on the
frozen legacy directory with no error, and installed games, saves and settings
are unchanged. The application offers the update to the current preview.
After updating, the next listing refresh selects the compact target and the
listing changes since the frozen legacy revision appear. A player who declines
the update keeps the frozen legacy directory and receives no listing changes.

The cutover is sequenced after the alias: `Catalog publish` must not publish
the first compact target until the first alias publication has been confirmed
by reading `updates/beta/latest.json` (see the
[cutover runbook](#cutover-runbook) preconditions). Before the alias existed,
the Beta feed returned 404 (anonymous read, November 23, 2026), and a
default-configured older preview never saw an update notice.

Alternatives considered:

- **Remove the legacy target from the policy role.** The old reader's refresh
  then fails on a missing target. When the stored provenance expires the
  directory falls back to the build's bundled listings with
  `ListingDirectoryUnavailable`, losing the delivered frozen directory. The signer
  also refuses a compact target without its legacy target, so this needs a
  signer rule change.
- **Signed metadata the old reader cannot parse.** It would stop all catalog
  delivery to older builds, including definition and policy updates.

Keeping the frozen target needs no signer rule change and leaves older builds
on a valid, fresh, unchanging directory.

**Accepted consequence.** Older previews no longer receive listing changes,
including new or changed download holds, withdrawals and typed restrictions
added after the frozen legacy revision. Their bundled holds and the frozen legacy holds
remain. Operational definition and policy holds still reach them. The
mitigation is the application update to Preview 14 or later.

### Released-reader gate

After the cutover the released reader is consulted only for a compact format
raise; an ordinary compact publication does not select or probe it.
The compact carrier is published first, or raised to a newer listing format,
only after preparation verifies that the current released preview reads it.
`--official-released-reader` selects that reader from the protected
`gh-pages` Preview pointer (`updates/preview/latest.json`, which also follows
newer Beta and Stable releases) and verifies it without credentials. The
pointer is read from the commit checked out in the Pages worktree that holds
`--prior`, the same commit the prior catalog comes from, never from a
remote-tracking ref:

- The version must not be listed in `updates/withdrawn.json`. An absent file
  lists no version.
- The tag's object and peeled commit come from an anonymous `git ls-remote`,
  and the commit must be an ancestor of protected `main`.
- `SHA256SUMS` and the Linux x86-64 CLI archive come from the public release
  download route under fixed byte bounds.
- One anonymous API read lists the archive's attestations. A GitHub release
  attestation, which GitHub issues only for an immutable release, must bind
  the repository, owner and repository IDs, tag, exact tag object, archive and
  `SHA256SUMS`. It is verified offline with `node:crypto` against GitHub's
  Sigstore trusted root, read anonymously with `gh attestation trusted-root`.
- The single regular archive member is unpacked privately. Its capability
  report, run in a private directory with no credentials, must name the
  `gzip-base64-json-v1` carrier, the candidate listing format and the release
  version. The protected release must meet that format's reader floor.

If the Preview pointer changes between preparation and publication, that
recheck fails the push and nothing from the run is published. Freshness then
waits for the next scheduled run, at most 12 hours later, well inside the
one-day timestamp.

When selection or the probe fails, or no reader source is configured,
preparation does not stop and publishes nothing new for listings: a
legacy-only prior is renewed byte for byte, and an active compact prior
renews its exact compact and legacy targets. Other catalog changes and
freshness renewal continue. The report records the reason in
`released_reader_unavailable`. GitHub allows 60 anonymous API requests an hour
per address, so a shared runner address can delay the cutover; it cannot
change what is published. The attestation read retries a rate limit (403, 429) or server error (5xx) up to three times, after 5, 15 and 45 seconds
(`attestationRetryDelaysMs`); any other failure is not retried. While the
first compact publication, or a compact format raise, is pending, any run
that renews the prior targets instead records `listing_activation_pending`
(prior carrier and format, candidate format, reason). Like a listing stop,
it fails the run after the Pages push and readback, so a deferred cutover is
never silent.

When the prior signed repository cannot be verified (for example, an expired
timestamp after a missed day, or a release-tools fault), preparation renews
the exact prior listing targets without projecting. After the cutover no
activation is pending, so the report records `listing_prior_unverified`
(prior carrier and reason) instead, and the run likewise fails after the
Pages push and readback: canonical listing changes are unpublished. The publish job reruns
`node scripts/catalog-released-reader.mts site` on each fresh Pages base and
stops that push if the selected reader was withdrawn or replaced.
`node scripts/catalog-released-reader.mts select DIR [PAGES]` is a read-only
preflight over the Pages worktree `PAGES` (default `site`).
`--released-reader PATH --released-reader-sha256 HEX` is an explicit reader for
rehearsal, tests and offline evidence; it cannot be combined with official
selection.

### Listing publication stops

A listing-only failure stops listing publication, never the catalog.
Preparation then renews the exact prior listing targets: legacy-only before
the cutover, the compact target and the frozen legacy target after it. The
signer sees the same bytes it already admitted, so freshness, definitions and
policy still publish. The report records `listing_publication_stopped` with a
`code`, the `reason` and its `figures`. After the Pages push and readback,
`Catalog publish` emits an `::error::` annotation and a step summary with those
figures and fails the run, so a person resolves it. The stop codes are:

| Code                         | Cause                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `decoded_bound`              | The decoded compact document exceeds 32 MiB                                   |
| `transport_bound`            | The encoded compact target exceeds 8 MiB                                      |
| `listing_count`              | Delivered listings exceed 10,000 (`compactListingCountMaximum`)               |
| `record_bound`               | A delivered listing serializes above 1 MiB (`compactListingRecordMaximum`)    |
| `withdrawal_count`           | Withdrawals exceed 10,000                                                     |
| `withdrawal_input`           | The committed withdrawal record is invalid (see the next section)             |
| `missing_without_withdrawal` | A published listing left `listings.json` without a committed withdrawal       |
| `conflicting_observations`   | Two observer candidates claim the same listing                                |
| `cover_evidence_unavailable` | Evidence for a cover withdrawal is missing or its historical scope is unknown |
| `core_refusal`               | Core refused the final staged publication with an input-refusal envelope      |

If an older withdrawal blocks a cover from returning, recover the exact old
mapping from a verified observation or signed listing. The current publication
keeps its prior listing and withdrawal until the publisher can match that
mapping to the current cover.
Everything else fails preparation as before and publishes nothing: canonical
inputs (`listings.json`, `catalog.json`, the withdrawal record) changing during
the run; a Core crash, timeout, output overflow or non-refusal error; Core
refusing the exact prior renewal; a failed prior verification that cannot be
renewed; and filesystem errors. These are typed: only
`ListingPublicationStop` and Core's `CoreInspectionRefusal` (a completed
process whose exit code and JSON envelope both name an input refusal) stop
listing publication.

### Withdrawing a listing

`crates/portcove-core/catalog/listing-withdrawals.json` is the reviewed,
committed withdrawal record:

```json
{
  "schema_version": 1,
  "withdrawals": [
    {
      "id": "example-port",
      "reason": "The upstream project asked to be removed.",
      "reference": "https://github.com/boburning/portcove/issues/1234"
    }
  ]
}
```

To withdraw a listing, remove its row from `listings.json` and add an entry in
the same pull request. Entries are sorted by `id` without repeats. Each needs
a non-empty `reason` of at most 500 characters and a Portcove issue or pull
request `reference`. The record is cumulative: an entry is never removed, and
a withdrawn identity never returns to `listings.json`. A project that comes
back is listed under a new identity. CI validates the committed record against
the committed `listings.json`, and preparation validates it again against the
canonical directory and every withdrawal already published. Any violation is a
`withdrawal_input` stop.

`Catalog publish` passes the record with `--withdrawals`. Preparation adds its
identities to the published `withdrawn_ids` and leaves those rows out of the
compact target. Removing a row without a record entry is a
`missing_without_withdrawal` stop; the row is never silently dropped. The
signer's existing rules hold unchanged: compact withdrawals include the legacy
target's withdrawals (`listing_targets` in `bundle.rs`), and history
verification refuses any publication that forgets a withdrawal
(`history_checkpoint.rs`). The frozen legacy target keeps its own withdrawals,
so older previews never see later withdrawals.

### Cutover runbook

**Preconditions.**

- The first interim Beta alias publication is live: an anonymous GET of
  `https://boburning.github.io/portcove/updates/beta/latest.json` returns 200
  and names the same version as `updates/preview/latest.json`. Merge only
  after this readback, because the first `Catalog publish` run after merge can
  publish the compact target.
- Required checks are green on the merge commit.
- `node scripts/listing-compact-activation-rehearsal.mts --cli PATH --workspace DIR`
  passes with a release or stripped CLI.
- `node scripts/catalog-capacity.mts --check` passes, including the compact
  carrier rows.
- The `select` preflight reports the current Preview, format 15 and
  `gzip-base64-json-v1`.
- No history bootstrap is requested in the same change.
- `Catalog publish` keeps its permissions, secrets, environments and
  triggers.

**The merge.** Merging this change makes the next `Catalog publish` run
publish the compact carrier, if its reader verifies.

**First-publication readback.** The lead follows these numbered steps after
the first `Catalog publish` run that publishes the compact target. The steps
are the contract; they name no
expected revision, digest or count, because those change with every
publication. Take the expected values from the run itself: the frozen legacy
entry is the `policy/official/catalog.listings.json` entry of the last
official-policy version before the run, and the current Preview is the version
in `updates/preview/latest.json` when the run prepared. Record each result,
with the date, on the owning issue, and add the observed figures to this
document as dated evidence, as in
[Compact listing activation evidence](#compact-listing-activation-evidence-november-24-2026).
Report each client kind separately: a step not run on a client kind is
recorded as not observed, never as passed.

1. In the prepare job's `catalog-work` artifact, open
   `observation-projection.json` and check:
   - `carrier` is `compact` and `listing_format` is 15.
   - `revision` is above `legacy_target.revision`.
   - `delivered_records` equals `canonical_records`, and
     `not_projected_records` equals `withdrawn_records`.
   - `legacy_target.sha256` and `legacy_target.bytes` equal the frozen legacy
     entry.
   - `released_reader` and `released_reader_source` name the current Preview,
     and `released_reader_activation` is present.
   - `target_bytes` is at most 8 MiB and `decoded_bytes` at most 32 MiB.
   - `listing_publication_stopped`, `listing_activation_pending` and
     `listing_prior_unverified` are all absent, and no `diagnostics` line
     says `prior unavailable`.
   - `withdrawal_record` names the committed record's SHA-256 and count;
     `excluded_candidates` and `diagnostics` are reviewed.

   In the same artifact, `capacity-guard.json` has `status` 0.

2. On Pages, follow `catalog/metadata/timestamp.json` to its snapshot, then to
   `official-policy`, checking each hash and length. The policy role names
   `policy/official/catalog.listings.compact.json` with the report's
   `target_sha256` and `target_bytes`. It still names
   `policy/official/catalog.listings.json` with the frozen legacy entry's
   SHA-256 and length.
3. Fetch the served compact target and decode it. Its `decoded_bytes` and
   `decoded_sha256` match the report, and it holds format 15, the reported
   revision, every canonical row and the typed `restrictions`.
4. The frozen legacy target
   `catalog/targets/<legacy SHA-256>.policy/official/catalog.listings.json`
   still serves the frozen legacy entry's bytes. Earlier legacy targets named
   by older signed versions are still served.
5. `updates/preview/latest.json` names the version recorded in
   `released_reader_activation`, and `updates/beta/latest.json` names the same
   version.
6. Real clients. A defect found here can only be fixed forward. With each
   released CLI, in a fresh library, run
   `catalog definition-authority --apply`, then
   `catalog listing-refresh --metadata-base-url https://boburning.github.io/portcove/catalog/metadata --targets-base-url https://boburning.github.io/portcove/catalog/targets`,
   then `catalog listing-status`:
   - The current Preview and every released preview down to the minimum
     supported preview: `selected` true, `revision` and `target_sha256` from
     the report, every canonical listing, no fallback.
   - The newest released preview below the minimum supported preview:
     `selected` true, the frozen legacy revision and target, the legacy
     listing count, `fallback_reason` null.
   - One **Windows desktop client** on the current Preview shows the compact
     revision's listings after its listing refresh, including a held row.

   A released-client observation runs the published binary: the CLI archive
   from the release, or the desktop application installed from the signed
   release installer. A local build of the release tag, such as a
   desktop-verify run, is a distinct and weaker kind of evidence: its bytes
   differ from the released binary. Record it as a local-build observation,
   and record the released binary as not observed.

7. Record the retained catalog tree size (at most 805,306,368 bytes, 768 MiB)
   and the Pages tree size (at most 900,000,000 bytes).

**Rollback.** Clients cannot be rolled back. Compact readers keep their
replay floor, so the signer refuses any return to a lower compact revision.
Older previews keep the frozen legacy target either way.

Reverting the merge restores the dual-carrier publisher. That publisher keeps
the compact target, but it fails preparation as soon as a catalog hold needs
a legacy successor that does not fit the 8 MiB legacy target. Treat
a revert as a stop-gap and fix publisher defects forward. No release-tools
rule changes in either direction. History bootstrap is not part of the
cutover or its rollback and stays with the owner.

**Transitional behavior and removal conditions.**

- **The frozen legacy target.** It stays named while any supported release
  reads it. Remove it with a reviewed signer and history rule change after the
  minimum supported application generation for all catalog delivery is
  Preview 14 or later.
- **Retired release-tools paths.** These remain unused by the publisher:
  `check_legacy_successor`, the legacy-only return in `check_listings`, and
  the legacy body kept in `HistoricalRevisionFloors`. Remove them with that
  same reviewed change, after the retained legacy bodies are pruned.
- **Retained legacy bodies.** The retained legacy listing bodies are no
  longer read by any client except the frozen one, but historical
  verification still reads each referenced body. Pruning needs a retained
  listing-floor ledger: a signed or checkpointed record of each historical
  listing revision, decoded SHA-256 and withdrawals, verified against the
  bodies before they are removed. Pruning without one is unsafe.

### Rehearsing the cutover

`node scripts/listing-compact-activation-rehearsal.mts --cli PATH --workspace DIR`
runs the production preparation entry point, `prepareObservationBundle`, once
per step against the committed catalog and the committed publication bundle.
`PATH` is a locally built `portcove` CLI that exports, validates and inspects
every publication. The first step's prior is a fixture legacy-only repository
whose format-11 target is Core's export of the operational rows. Automatic
selection runs over fixture Pages, tag, release-asset and attestation sources
that publish `PATH`, or `--released-reader PATH`. The fixture statement stands
in for GitHub's signature, which `scripts/github-release-attestation.test.mts`
verifies against a real GitHub release attestation. `DIR` must be empty.
Nothing is signed or published; the release-tools tests cover signer
admission. Each step stops the rehearsal when its property fails:

- **Released-reader gate.** These cases each renew the legacy-only
  publication byte for byte, with a reason:
  - an explicit reader without the carrier, without format 15, or with a
    different SHA-256;
  - an automatically selected version that is withdrawn, lacks format 15,
    has a substituted archive or an unattested tag object, or comes from a
    commit off protected `main`.
- **Cutover.** The first compact target is format 15, delivers every
  canonical row and publishes above the legacy revision. The legacy bytes are
  unchanged, and the selected reader is verified and reported.
- **After cutover.** A new download hold reaches the compact target only. The
  legacy target stays byte-identical, and an unchanged directory republishes
  the exact compact bytes.
- **Enrichment.** Two observer candidates are prepared, one with a field
  Core's observation schema refuses. Preparation excludes and reports only
  that candidate, and its row keeps the prior signed observation. Only Core's
  own refusal counts: the inspection must exit with Core's `verification`,
  `source_invalid` or `unsupported` code and the matching JSON error envelope.
  A Core crash, timeout, output overflow or other Core error fails
  preparation. A projection or carrier capacity failure stops listing
  publication (see [Listing publication stops](#listing-publication-stops)).
- **Preconditions.** Preparation without the prior signed repository is
  refused.

### Cutover evidence, November 23, 2026

All offline; nothing was signed or uploaded. Inputs:

- Pages `gh-pages` commit `7585833` (timestamp 60, expiring
  2026-11-24T15:53Z).
- The committed catalog at this branch's merge of `main` `76539c9`.
- Release-built `portcove` and `portcove-release-tools`.
- The released Linux x86-64 CLIs. Each archive matched its release
  `SHA256SUMS`.

| Step                                                                                                                                                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare, with Preview 15 (`749bb1e6…`) as the explicit reader, the prior verified by release tools                                                                                                                             | Compact revision 48 (legacy 47), format 15, 1,649 of 1,649 rows, 0 withdrawals. Wire: 2,745,010 bytes of 8 MiB, SHA-256 `ed6d37df…`. Decoded: 9,602,327 bytes of 32 MiB. 152 held rows with 155 typed restrictions; 875 rows keep their signed observations. The legacy target is byte-identical. The observer was unavailable offline (it needs an Actions token), so no new observations. |
| Workflow steps after prepare                                                                                                                                                                                                   | Core `inspect-definition-publication` selects the compact target (revision 48, 1,649 rows, `ed6d37df…`). The plan advances every role to version 61. `check-definition-publication-context`, which runs the historical listing-floor rules against the real prior, passes.                                                                                                                  |
| Preview 15 CLI `inspect-definition-publication` on the staged bundle                                                                                                                                                           | Selects `catalog.listings.compact.json`, revision 48, 1,649 listings, SHA-256 `ed6d37df…`.                                                                                                                                                                                                                                                                                                  |
| Preview 14 CLI `inspect-definition-publication` on the staged bundle                                                                                                                                                           | Refused: `query metadata exceeds its read budget`. Preview 14's offline publication inspector does not yet recognize the compact name and applies the 64 KiB policy-file cap; Preview 15 fixed this. The inspector is a publisher tool, not the client's acquisition path. The client result is in the next row.                                                                            |
| Preview 14 client code at tag `nightly-0.1.0-preview.14`: carrier decode, `parse_compact`, `parse` of the legacy target and projection onto the embedded catalog, run as a temporary `cargo test` added in a detached worktree | Wire SHA-256 `ed6d37df…`, decoded SHA-256 `e8cd9a88…`, revision 48 above legacy 47, 1,649 rows, 0 withdrawals, 1,649 listings after projection. This is the client's own parser and projection; it skips only TUF signature checks, which an unsigned bundle cannot pass.                                                                                                                   |
| Preview 13 CLI                                                                                                                                                                                                                 | Reports formats 5–13 and no carrier. Its offline publication inspector refuses the staged bundle the same way as Preview 14. Its client path is the code reading in [What an older preview does after cutover](#what-an-older-preview-does-after-cutover); the legacy bytes it acquires are the ones it already admits from Pages today.                                                    |

A live client refresh against the staged bundle cannot run offline: the
bundle is unsigned, and clients trust only the compiled root. After the first
signed cutover publication, a person runs readback steps 3 to 6 against Pages.

**Rerun with listing publication stops and the withdrawal record.** Same
day, Pages commit `7585833` (timestamp 60), release-built `portcove` and
`portcove-release-tools` from this branch, and the released Linux x86-64 CLIs
for Preview 13, 14 and 15, each matching its release `SHA256SUMS`:

| Step                                                                                                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listing-compact-activation-rehearsal.mts --cli` with the release CLI                                                                 | Passed: all eight gate cases renew legacy-only; cutover 1,649 of 1,649 rows above the legacy revision; a later hold reaches only the compact target; enrichment excludes only the refused candidate.                                                                                                                                                                                                                                        |
| Prepare with `--official-released-reader` and `--withdrawals`                                                                         | The anonymous attestation read returned 403 from the sandbox, so the gate failed closed: exact legacy renewal (revision 47, `0d20ba97…`), no compact target.                                                                                                                                                                                                                                                                                |
| Prepare with the real Preview 15 and, separately, Preview 14 CLI as explicit reader                                                   | Both: compact revision 48, format 15, 1,649 of 1,649 rows, 0 withdrawals, wire 2,745,010 bytes `ed6d37df…`, decoded 9,602,327 bytes; legacy target unchanged; no stop. The two compact targets are byte-identical and equal the earlier evidence target.                                                                                                                                                                                    |
| Real Preview 13, 14 and 15 clients: `catalog definition-authority --apply`, `catalog listing-refresh` against Pages, `listing-status` | Each selects revision 47, target `0d20ba97…`, 1,193 listings, expiring 2026-11-24T15:53Z, no fallback. This is the pre-cutover baseline.                                                                                                                                                                                                                                                                                                    |
| Real CLIs' `inspect-definition-publication` on the staged bundle                                                                      | Preview 15 selects the compact target, revision 48, 1,649 listings, `ed6d37df…`. Preview 14 and 13 refuse with `query metadata exceeds its read budget` (their publisher inspector's 64 KiB policy-file cap).                                                                                                                                                                                                                               |
| Preview 14 storage of a decoded document above 8 MiB (source at `nightly-0.1.0-preview.14`, `listing_delivery.rs`)                    | Compact documents go to their own `compact_listing_delivery` table with a 32 MiB `CHECK`; before inserting a document above 8 MiB, Preview 14 drops a table created with the 8 MiB check. Replaying that DDL in SQLite 3.54.1 with the staged 9,602,327-byte document: the 8 MiB-checked table refuses it, the 32 MiB table stores it. Preview 14's parser and projection of these exact bytes were run earlier (the evidence table above). |

Control: the same Preview 13, 14 and 15 inspectors accept the legacy-only
bundle staged by the fail-closed run (revision 47, `0d20ba97…`, 1,193
listings). Their refusal of the cutover bundle comes from the compact target
alone, which their inspector does not recognize and reads under the 64 KiB
policy-file cap.

No real client can refresh from the staged bundle. `listing-refresh` accepts
only HTTPS bases and only the compiled-in root, and the staged bundle carries
no role signatures; producing them needs the official online keys. Readback
steps 3 to 6 therefore run against Pages after the first signed cutover
publication.

**Migration simulation (not committed).** The simulation gives 200 and 400
listing-only identities a generated registration shaped like `generatedRecord`
(`scripts/catalog-generated-registration.mts`), using the committed port
`dkr-r` as the per-port template. In every case, preparation succeeds with
1,649 rows and the legacy target stays byte-identical. A changed declaration
drops its prior observation until it is observed again, so the compact target
shrinks.

| Identities | Compact wire | Decoded   | `catalog.json` (85% ceiling 14,260,633) | Embedded `listings.json` (85% ceiling 7,130,316) |
| ---------- | ------------ | --------- | --------------------------------------- | ------------------------------------------------ |
| 0          | 2,745,010    | 9,602,327 | 4,263,284                               | 6,449,993 (headroom 680,323)                     |
| 200        | 2,478,558    | 8,922,800 | 5,087,120                               | 6,293,881                                        |
| 400        | 2,177,290    | 8,163,715 | 5,914,276                               | 6,141,705                                        |

The template's manual setup is shorter than most generated route guides, so
these embedded-directory figures are optimistic. An earlier same-day run
applied the generator's own `generatedRecord` and `checkedAuthoredPort`. In
that run, 400 identities grew `listings.json` to 7,036,903 bytes, 93,413 below
the 85% guard. That guard, not the compact carrier, is the next limit; the
compact target stayed under 2.8 MB wire and 10.1 MB decoded.

**Storage runway, measured November 23, 2026.** These are pre-cutover
figures; the activation evidence below has later ones. The retained catalog
tree measured 404,914,714 of
805,306,368 bytes (768 MiB), and the Pages tree 404,922,011 of 900,000,000.
The 47 retained legacy listing bodies make up 390,631,685 bytes.

- **Before cutover.** Each listing change added an 8.39 MB legacy body: about
  47 more changes before 768 MiB, roughly a week at the 6.7 changes a day
  measured over the previous week.
- **After cutover.** Each listing change adds one compact body (about 2.75 MB)
  plus about 7 KB of role metadata. A renewal with unchanged listings adds
  only metadata. That leaves about 145 listing changes before 768 MiB (about
  three weeks at the same pace) and about 180 before the Pages bound.
- **Pruning.** Pruning the 46 superseded legacy bodies would free 382,243,287
  bytes, but it needs the listing-floor ledger above.

### Compact listing activation evidence, November 24, 2026

The first signed compact publication and its readback, recorded in three #1422
comments:
[Compact listing: activated](https://github.com/boburning/portcove/issues/1422#issuecomment-7137198571);
[Compact listing: released-client readback](https://github.com/boburning/portcove/issues/1422#issuecomment-7137500145)
(command-line clients observed 16:11–16:20 UTC; comment posted 16:20 UTC); and
[Compact listing: Windows desktop readback](https://github.com/boburning/portcove/issues/1422#issuecomment-7138279401)
(run 16:44–16:47 UTC; listing selected 16:46:14 UTC; comment posted 16:50 UTC;
the comment's "~17:40 UTC" header time is inaccurate). These are dated
observations, not expected values for later publications.

- **Publication.** Scheduled `Catalog publish` run 45430469470, source commit
  `8a3ae155`, published signed versions 63 at 16:06 UTC. Reader activation:
  `0.1.0-preview.16`, the current released reader at activation (not Preview
  15). Preview 14 remains the minimum supported preview.
- **Frozen legacy target.** Two legacy-only publications happened before the
  cutover merged, so the frozen bytes are revision 49, not revision 47:
  SHA-256 `9a025755756b60acf4ee911295b339a8cfccfeb932ded981ee6ade441e80e6e6`,
  8,388,496 bytes, format 11, 1,193 listings. The legacy entry by
  official-policy version: 60, revision 47 (`0d20ba97…`, 8,388,398 bytes); 61,
  revision 48 (`4224a495…`, 8,388,578 bytes); 62, revision 49 (`9a025755…`);
  63, the same revision-49 entry beside the compact target. The older targets
  are still served.
- **Compact target.** `policy/official/catalog.listings.compact.json`,
  SHA-256 `5a2d3bd1e349472b3bb2ddaf7cac4a306c481f5b592dafb03c097932d1cc1d7e`,
  3,505,447 bytes, 12,267,447 decoded, format 15, revision 50, 1,649 rows, 152
  held rows.

| Readback step                                            | Result                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Publisher report and capacity guard                   | Carrier compact, format 15, revision 50, 1,649 of 1,649 rows delivered; no stop, pending or unverified marker; capacity guard `status` 0.                                                                                                  |
| 2. Signed metadata on Pages                              | The chain was verified from the root that hashes to the clients' built-in anchor; official-policy version 63 names the compact target above and the frozen revision-49 legacy target.                                                      |
| 3. Served compact target                                 | Fetched and decoded anonymously: SHA-256 and length match the policy entry; decoded length and `decoded_sha256` match the carrier; format 15, revision 50, 1,649 listings, 0 withdrawn identities, 152 rows with 155 typed `restrictions`. |
| 4. Legacy targets                                        | The revision-49, 48 and 47 legacy targets each serve their signed length.                                                                                                                                                                  |
| 5. Update feeds                                          | `updates/preview/latest.json` and `updates/beta/latest.json` are byte-identical and name `0.1.0-preview.16`.                                                                                                                               |
| 6. Released CLIs, Linux x86-64, fresh isolated libraries | Previews 16, 15 and 14 select the compact target: format 15, 1,649 listings, revision 50. Preview 13, below the minimum supported preview, keeps the frozen legacy target: format 11, 1,193 listings, revision 49, no error. All exit 0.   |
| 6. Windows desktop client, local build of the tag        | Passed, as a local-build observation (below). The signed released installer binary was not run.                                                                                                                                            |
| 7. Retained sizes                                        | Catalog tree 411,430,525 of 805,306,368 bytes; Pages tree 425,230,684 of 900,000,000.                                                                                                                                                      |

**Windows desktop, local build of the release tag.** Releases ship only an
installer, and installing it on the available host would have changed its
registered player install, so the released binary was not run. Instead a local
debug build of release tag `nightly-0.1.0-preview.16` (commit
`cb29b0b83259f80015238b4fe69563707a7f880d`) was built through the
repository's desktop-verify route with an uncommitted observe-only scenario
and run in a fresh isolated library against live Pages. It selected listing
revision 50 from the compact transport target `5a2d3bd1…`, format 15, 1,649
listings (152 restricted), about 21 s after launch. The held row
`abuse-abuse-2025` showed its hold explanation and offered no download. No
error and no fallback. This build's bytes differ from the signed released
binary, so it is evidence about the tag's source on Windows, not a
released-binary observation.

**Retained legacy bodies.** On November 24, 2026 the served tree held 49
retained legacy listing bodies, 407,408,759 bytes.

**Not observed.** The signed released Windows installer binary, the Windows
and macOS CLIs, and an in-place upgrade of a library written by an older
preview. The Linux CLI results and the local desktop build do not stand in for
them.

Steps 3 and 4 and the version history above were also read anonymously from
Pages on November 24, 2026 for this record. `updates/withdrawn.json` returned
404 and is absent from the Pages tree: no preview has been withdrawn, so the owner-only
[withdrawal workflow](RELEASING.md#current-release-process) has never written
it, and the released-reader selection reads an absent file as no withdrawals.

### Compact carrier capacity guard

The compact carrier rows of `node scripts/catalog-capacity.mts --check` guard
the released readers' bounds. Those bounds are real constraints of the
minimum supported generation and lift only with the next reader generation;
`listingDeliveryBounds` takes them from the publisher's own constants and
refuses a current Rust constant below them, so a next-generation raise in Core
never loosens what is guarded or signed. The guard models the decoded
document from the committed `listings.json` and withdrawal record. A row
carries its signed observation when `--observed-target FILE` (legacy JSON, a
decoded compact document or a compact carrier) has one; every other row is
charged the mean live observation (4,791 bytes over the 933 observed rows of
revision 47). The wire uses the worse of the staged target's compression
ratio and the document's own. The largest record adds the largest live
observation (31,106 bytes) to the largest row without a signed one.

Each carrier ceiling reserves 28 days of measured growth below the bound. The
compact reader shipped two days after its merge (#8450 to Preview 14), but
older previews update only when the player accepts the update, so the
reservation covers a reader release and its adoption. Growth is the committed
directory's over November 16–23, 2026: 159,241 authored bytes and 17.4 rows a
day. A single record has no growth rate, so half its bound is reserved. CI
fails at the ceiling, before publication would stop. The figures live in
`compactCarrierModel` and are refreshed with new measurements.

The `Catalog publish` prepare job runs the same guard with
`--observed-target` on the staged compact target. That measurement never
blocks the publication; a failing guard fails the run after the Pages push and
readback, like a listing publication stop.

| Measure (November 24, 2026, `--observed-target` revision 47) | Value      | Ceiling    | Released-reader bound | Runway at the measured rate     |
| ------------------------------------------------------------ | ---------- | ---------- | --------------------- | ------------------------------- |
| Modeled decoded bytes                                        | 13,288,592 | 26,757,676 | 33,554,432 (32 MiB)   | 55 days to ceiling, 83 to bound |
| Modeled wire bytes                                           | 3,799,056  | 6,445,624  | 8,388,608 (8 MiB)     | 38 days to ceiling, 66 to bound |
| Listings                                                     | 1,649      | 9,512      | 10,000                | 451 days to ceiling             |
| Withdrawals                                                  | 0          | 9,512      | 10,000                | —                               |
| Largest modeled record bytes                                 | 39,050     | 524,288    | 1,048,576 (1 MiB)     | —                               |
| Frozen legacy target, complete format-11 successor           | 9,778,469  | —          | 8,388,608 (8 MiB)     | Informational; never fails CI   |

Without `--observed-target` every row is charged the mean: 13,266,362 decoded
and 3,860,331 wire bytes. The model is deliberately conservative: the staged
target, with 875 rows observed, measured 2,745,010 wire and 9,602,327 decoded
bytes. The wire bound is the nearest; a new reader generation should start
well before its ceiling.

### Listing delivery limits

The released readers' limits can change only with a new reader release.

| Limit                              | Value                | Enforced by                                                                                                                                      | Released reader (Preview 14/15) |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Listing target wire bytes          | 8 MiB                | Reader acquisition and carrier decode; publisher transport encoding; signer and history verification (`portcove_listing_carrier::MAX_BYTES`)     | Yes                             |
| Compact decoded bytes              | 32 MiB               | Reader `parse_compact` and its SQLite check; publisher projection                                                                                | Yes                             |
| Compact record bytes               | 1 MiB                | Reader `parse_compact`; publisher projection (`compactListingRecordMaximum`)                                                                     | Yes                             |
| Listings and withdrawals           | 10,000 each          | Reader; publisher projection                                                                                                                     | Yes                             |
| TUF snapshot / targets / timestamp | 4 / 8 / 1 MiB        | Reader TUF client (`definition_repository.rs`)                                                                                                   | Yes                             |
| Authored `listings.json`           | 64 MiB, 85% CI guard | Core inspection (`MAX_LISTING_DIRECTORY_TEXT_BYTES`); publisher canonical input read; `catalog-capacity --check`. The embedded copy has no bound | No                              |
| Retained repository                | 768 MiB              | Signer (`PUBLIC_REPOSITORY_MAX_BYTES`) and Pages overlay                                                                                         | No                              |
| Signer bundle                      | 32 MiB               | Signer                                                                                                                                           | No                              |

Removed with the cutover: the publisher's legacy byte-budget fitting, which
omitted optional observations and non-required rows to fit 8 MiB, and the
legacy hold successor's byte check.

## Capacity diagnostics and retained representations

Run `node scripts/catalog-capacity.mts --catalog PATH` for offline counts of the
current source, compact document, representative escaped format-1 envelope and
remaining parser headroom. The tool reads the existing Core limit constants; it
creates no key or signature and contacts no provider. Its growth model holds
shared source data and average per-port metadata fixed. It is not admission,
semantic validation, a production signed envelope or a guarantee for future
source identities. Existing clients still require matching embedded membership;
adding ports remains an application/catalog compatibility decision.

Measured October 27, 2026 at catalog SHA-256
`a3de2a0a1b18d9c2110521f58c40dbdf13396fed381f5b960a81cbec4d59a1e3`:
167 operational ports occupy 990,397 source bytes and 708,076 compact JSON bytes.
A representative envelope with a maximum-safe-integer sequence, two ten-digit
Unix timestamps and fixed-width placeholder key/signature fields occupies 761,067
bytes, leaving 3,433,237 of the 4,194,304-byte bound (about 81.9%). Shared data in
that model occupies 324,799 bytes; future shared source growth is not assumed
constant in the actual product. The current byte limit has ample observed
headroom, so format1 and its security bound remain unchanged.

Verification now moves the parsed catalog document through the existing shared
validator rather than serializing and parsing it again. The verified result
retains only sequence/validity metadata alongside its validated catalog and exact
signed payload string. It no longer retains a second full parsed payload catalog.
Exact signed bytes, validation, signatures, replay protection, snapshots, atomic
publication and recovery remain unchanged. Serialized sizes do not measure heap
or RSS savings; those remain Unknown.

The optional local GitHub metadata cache retains a 64 MiB **charged record** budget
rather than 512 rows. Charges include body bytes, URL key/index bytes, validators
and a 4 KiB per-record reserve, so empty/tiny entries cannot grow without a resource
bound. A single uncacheable record is excluded before ordinary oldest-first
resource eviction. Seven-day expiry, per-response bounds, conditional validation
and unchanged observations remain intact; a 304 already refreshes the existing
cache age. The SQLite schema and old-client readers are unchanged. This budget
is not a limit on the entire library database or its existing free pages.

In a controlled 1,000-row SQLite fixture, 22,000 body bytes and 173,780 text/index
bytes occupied 221,184 database bytes; the former row cap would evict 488 entries.
That demonstrates avoidable loss of small conditional responses, not actual
production misses or traffic. A conservative 4 KiB record reserve exceeds that
fixture's observed 47.404-byte average physical overhead. Pruning checks aggregate
resource admission before sorting for eviction. With 20 local SQLite 3.53.1
samples per case, the 1,000/10,000-row aggregate checks averaged 0.080/0.759ms;
unconditional window eviction averaged 0.420/3.857ms. These are small-body fixture
CPU observations, not application timings or provider costs. Live occupancy,
API consumption, process memory and actual release throughput remain Unknown.

Catalog provenance reports `fallback_codes` in the same order as the legacy
`fallback_reasons` diagnostics. The codes drive localized Desktop guidance.
Clients can continue to display the original diagnostic and use generic guidance
when a reason code is absent or unfamiliar.
