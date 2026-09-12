# Architecture

## Successor definition content inventory

Core owns the immutable successor index parser and exact target-byte verification
through `DefinitionContentIndex`. It bounds and validates identities, revisions,
content-addressed references and declared bytes before exposing read-only records.
The original index bytes remain available for later authenticated bindings.
This pure content boundary has no network, library or lifecycle side effects and
does not replace the current catalog loader. Authentication, entry interpretation,
independent eligibility and transactional selection remain required before these
bytes can acquire definition authority. The exact initial representation and
limits are documented in [DEFINITION-DELIVERY.md](DEFINITION-DELIVERY.md).

The same core boundary inspects individual indexed entries through
`DefinitionContentIndex::inspect_entry`. It binds the exact bytes and identity,
checks the complete typed port projection and installed capability requirements,
and retains separately labeled in-index contract references. It rejects duplicate
JSON keys before constructing object maps. An inspection cannot construct a
usable catalog, authenticate a publisher, interpret referenced contracts or grant
an operation; existing semantic validators and the remaining loader gates still
own those decisions.

`inspect_catalog_projection` supplies the first referenced-contract interpreter.
It accepts a single terminal `catalog_projection` record shared explicitly by the
source, execution and persistence roles. The complete authoritative catalog is
validated by the existing `Catalog` and source validators, compared without
discarding unknown/default semantics, and bound to the selected entry's complete
port projection. Exact entry and contract bytes remain available. This preserves
one owner of domain rules and a complete source graph rather than introducing
parallel execution/persistence models. Other ports inside that retained graph are
not independently admitted definitions. Unsupported record types or extra target
edges are rejected; this initial format cannot express recursive target graphs.
The result supplies validated semantics only: publisher grants, authentication,
freshness, catalog selection and operation eligibility remain separate boundaries.

## Authenticated successor candidate acquisition

Core acquires an inert `AuthenticatedDefinitionCandidate` from a caller-supplied
trusted root and separate metadata/target HTTPS bases. The loader uses maintained
TUF verification with safe expiration enforcement, bounded root rotation and
consistent snapshots. A terminating `official-definitions` role must have exactly
the `definitions/index.json` and `sha256/*.json` paths; top-level or nested roles
cannot widen that authority. The public transport accepts no URL credentials,
queries, fragments, redirects, ambient proxy configuration or non-HTTPS fetches.

The authenticated index is read within its declared bound, then every indexed
target's signed length and digest is checked before any content fetch begins.
Target reads are streamed into their individual and aggregate index bounds and
verified again against both TUF and the core content inventory. The returned
snapshot keeps all authenticated bytes in memory with metadata versions, earliest
expiration and the index digest. A caller may inspect one supported catalog
projection without interpreting unsupported sibling definitions.

Each candidate also binds the canonical signed body of the root, timestamp,
snapshot, top-level targets and `official-definitions` metadata. The pure replay
evaluator compares those identities with a supplied floor, rejecting any version
downgrade and any changed signed body at an equal version. An exact retry is
distinguished from a monotonic advance. Signature bytes are excluded so a valid
re-signing of unchanged metadata does not create false equivocation.

Acquisition does not write a library, persist replay floors, select a catalog,
grant a publisher, check operation eligibility, install content or activate an
updater. Replay evaluation also has no side effect: a floor must advance in the
later catalog-selection transaction, never merely because a candidate was
downloaded. Those remain later core-owned transactions. The filesystem transport
is available only to disposable signed tests; production construction requires
the restricted HTTPS source type.

## Definition operation eligibility

Core owns the pure definition operation-eligibility decision for availability,
install, preparation and launch. `evaluate_definition_eligibility` consumes facts
established separately by trust policy, capability negotiation, retained-contract,
artifact-integrity, source and mandatory-check authorities. It returns a typed
`eligible`, `hold` or `escalate` outcome with a stable reason. Candidate content
cannot set these facts or interpret its own result as admission.

Known publisher revocation and unknown safety semantics take precedence over all
operations. New admission requires fresh, non-replayed, complete metadata;
retained launch may continue during outage or a rejected refresh, but known
revocation, local corruption, changed recorded identity and failed mandatory
checks still hold it. An explicitly authorized local retained launch may omit
authenticated upstream acquisition without acquiring official publisher authority.
Source failures hold only operations whose existing operation-specific authority
establishes that source requirement. A catalog source profile alone does not make
the source mandatory for every operation. Gameplay remains separate evidence and
is not an input to the decision. The evaluator has no I/O or mutation.

`AuthenticatedDefinitionCandidate::evaluate_availability` composes the acquisition,
entry, capability, complete catalog projection, replay and eligibility boundaries
for one exact identity. Its only independent authority input is a typed publisher
status obtained from installed policy and bound to the authenticated repository
root, namespace and stable ID; that status is not deserializable from candidate
content or reusable across repositories. A successful result carries a non-serializable
`EligibleDefinitionCandidate` proof with the exact projection, authenticated
provenance, replay disposition, proposed floor and identity-bound publisher
observation, including its grant ID and policy revision. Held or escalated content
cannot produce that proof. The proof remains inert until a later library
transaction persists the selected projection and floor together.

SQLite schema 26 adds the successor-selection boundary. Library assessment
reads the installed publisher record and accepted replay floor from one snapshot;
an immediate selection transaction then rechecks that exact policy revision,
grant, root, identity, metadata expiration and the latest floor before writing the
exact definition snapshot and new floor together. Stored state is strictly decoded
and reinterpreted from its original index, entry and contract bytes on every
status read. An exact retry is idempotent, and any failed or interrupted statement
leaves both the prior selection and floor unchanged. The runtime catalog loader
reads that selection with the current embedded or signed baseline in one SQLite
snapshot. It activates only a fresh, still-scoped projection whose selected port
is the sole semantic change; unrelated ports and existing source authority remain
exact, and new source records must be reachable from the selected port. Rejected,
revoked, stale or corrupt selections fall back visibly without hiding baseline
ports. Catalog provenance reports `definition_selected` when activation succeeds.
The loaded catalog also carries the exact selection identity that passed those
checks. Core now compares that identity with current publisher policy and replay
state when it builds API-schema-47 port status. Install, preparation and launch
entry points consume the same decision before publication, persistent-data work
or child-process preparation. Retained launch ignores metadata expiry and an older
replay floor, while new install and retained preparation do not; known revocation,
policy identity drift and invalid retained local state remain holds. CLI and Tauri
receive the same typed operation, outcome and stable reason without reimplementing
policy. SQLite schema 27 advances the library writer protocol so a newly written
successor install retains that identity instead of losing its authenticated
origin during later lifecycle work. Production still has no grant writer.

## Engine template capability ownership

Core owns the installed template/version inventory and pure requirement
negotiation. API schema 45 adds this inventory to the capability document and a
bounded, read-only requirements inspection command. CLI and Tauri delegate to
that same implementation; React does not infer compatibility. This prerequisite
does not load definitions or confer admission or execution permission. The
[definition delivery contract](DEFINITION-DELIVERY.md#implemented-engine-capability-negotiation)
specifies request bounds, version semantics, and independent trust checks.

## Local artwork ownership

Core owns independent cover/detail choices, copied local originals, bounded raster
decoding and disposable thumbnails. SQLite schema 24 records assets and monotonic
choice revisions; older writers refuse the upgraded library. API schema 44 exposes
selection and integrity metadata through the CLI and Desktop. Catalog and signed-envelope
formats are unchanged. Local filenames, hashes and import times record provenance;
they establish neither copyright permission nor upstream authenticity.

Imports accept static PNG/JPEG files with at most 16 MiB encoded bytes, 8192 pixels
per dimension, 8 megapixels and 32 MiB decoded pixel storage. Decoder allocation
limits also apply; destination pixel allocation is checked explicitly. A separate
library artwork lock bounds concurrent decoding and serializes import, reset,
thumbnail generation, cache clearing and unused-original removal without holding
a game's operation lock. Expected slot revisions reject stale changes, including
reset/reselect cycles. Missing or changed originals retain the selection and report
unavailability through the artwork API; ordinary lifecycle reads do not read images.

Imports reserve tracked inventory before atomically publishing copied bytes, then
commit the choice. Interruption retains the previous choice and may leave an unused
record or original; retrying the import or explicitly removing that unused asset
resolves it. Inventory includes interrupted imports and is bounded to 4096 assets
and 1 GiB. Each reserved image has at most one fixed file in `artwork-staging`;
retry replaces only a matching partial copy, and explicit unused-image removal
also discards that bounded incomplete copy. No random temporary-file accumulation
is possible across repeated import interruptions. Staging is excluded from payload
exports. Originals remain until explicit unused-image removal. Thumbnail failures
cannot prevent choosing a validated original. On-demand PNG thumbnails fit within
384 by 576 pixels and 1 MiB each. Their separate 64 MiB cache verifies content hashes,
rebuilds missing/corrupt entries, and evicts entries in deterministic filename order.
One bounded pending thumbnail is recognized for interrupted-write retry or cache
clearing; publication may require up to 1 MiB of temporary working space.
Unexpected files or symlink paths are retained and rejected, never traversed.

Library metadata format 3 exports logical choices and local asset identities with
an explicit `artwork` payload root. Moves and metadata/content imports use existing
reviewed copy, exclusive ownership and recovery machinery, verifying both original
hashes and decoded dimensions before publication. Metadata alone contains no image
payload. Formats 1 and 2 remain importable with empty artwork state and reject
artwork fields; disposable `artwork-cache` files are excluded. Per-game save backups
continue to cover saved data; whole-library backup copies include the artwork root.

Desktop owns native file selection and routes each read/change through a library
generation check. React displays core results through a disposable cache for the
visible viewport plus at most 32 inactive previews per generation. Requests are
serialized to avoid competing for the artwork lock; queued reads are discarded
when their view no longer needs them. Visible cards load asynchronously and preserve
the cached image while refreshing. PNG data URLs carry only bounded core thumbnails;
the renderer never reads original files or changes the content-security policy.
Picker cancellation, closing the editor, changing ports or changing libraries
invalidates the pending intent before mutation. Core still checks the selected slot
revision. Titles, status and actions stay outside portrait/letterboxed covers;
detail images are optional. Reset preserves imported originals. Source information
reports the original filename, dimensions and import time, with author/license
explicitly unavailable for local imports.

There is no provider, network fetch or catalog artwork default. Deterministic
fallback remains available when there is no local choice. Provider access and
redistribution permissions remain separate from this account-free storage contract.

The [independent definition delivery contract](DEFINITION-DELIVERY.md) keeps
successor definition admission, retained source/execution/persistence contracts
and operation eligibility in core. Successor admission and capability examples
remain test-only design fixtures. The format-1 loader retains its frozen contract;
new installations now retain the admitted catalog content described below.

## Retained installation contracts

For an inspected successor catalog projection, core carries an immutable exact
definition snapshot with the catalog for its selected port only. Catalog clones
share that snapshot; a newly parsed unrelated catalog does not inherit it. This
is origin retention, not another source/execution/persistence authority. The
existing qualification and manifest paths capture it without consulting current
discovery or reconstructing old bytes during preparation or manifest refresh.

Retained-contract format 2 stores the namespace, stable ID and exact index, entry
and shared leaf JSON strings inside the existing schema-6 install manifest.
Format 3 adds the exact authenticated selection identity: definition revision,
repository root, publisher grant and policy revision, metadata role versions and
digests, expiration, and index digest. The admission record must agree with the
snapshot before the catalog can be reused or recaptured. Neither format has a
parallel canonical `catalog_json` authority. On read, core checks bounds, identity,
index-to-content digests and all current supported contract semantics. The existing
immutable manifest digest covers both the snapshot and admission record. Format 1
continues to retain canonical legacy catalog content. Format 2 remains readable as
exact supplied successor content but does not acquire invented authentication.
Pure decode caching is bounded to one exact format/content pair and never caches
filesystem integrity, source admission or revocation decisions. Each content
component keeps its existing 4 MiB bound; the three retained components total at
most 12 MiB before JSON string encoding and decoding overhead.

SQLite writer protocols 25 and 27 prevent older clients from discarding exact
successor bytes and authenticated admission provenance respectively. They change
no table layout and use the existing exclusive migration lease. Existing legacy
and format-2 installs remain readable; no historical snapshot or authenticated
provenance is invented for them. An unselected port in a shared projection cannot
inherit the selected definition's identity.

For legacy and embedded catalogs, core captures a canonical, self-contained
projection before publishing a new installation, adoption, or prepared derivative. Schema-6 installation
manifests include the port identity and complete referenced source graph, covered
by the existing immutable manifest digest. Keeping the complete bounded catalog
avoids a second mutable database or a missing sidecar during moves and exports.
This trades repeated catalog bytes per version for a single atomic payload and
an independently readable contract. The retained catalog uses the existing 4 MiB
catalog limit and rejects unknown or discarded semantics.
Core memoizes pure decoding of the most recently validated exact content string,
bounded to one catalog. Each read still verifies the current manifest bytes and
digest; the cache contains no filesystem, source-admission, or revocation decision.

Launch, preparation, rollback, staged activation, recovery, verification, output
relocation, and save synchronization resolve each registered version's execution
and persistence definition from that verified manifest. Manifest refresh and
prepared derivatives preserve the original snapshot. Legacy schemas 2–5 keep
their existing catalog-based interpretation; reading them does not manufacture
historical evidence. New manifests always require a complete captured catalog.

SQLite schema 23 is a writer-protocol migration with no table-layout change. Its
migration ledger makes older clients refuse to open the upgraded library. An
upgrade requires exclusive library access, so previously opened clients must
release their shared leases before the protocol advances. API schema 43 adds `invalid_installation` to launch blockers;
an unreadable or corrupt manifest blocks its game without failing the entire
status list. Actual launch still performs immutable-file verification.

Retained content is not a new admission authority. Metadata import continues to
check the current platform contract and compares retained execution semantics
with the existing frozen admission rules; a self-consistent hash cannot authorize
new launch arguments. Source registration still uses the admitted current
catalog. Installed launch resolves both registered and explicit source
inputs through the verified version-owned catalog, then rechecks their complete
payload/storage identity after adapter preparation. Legacy manifests retain their
current-catalog fallback. The shared source inspector takes an explicit catalog;
this does not register a new source, replace its baseline or authorize a new
publisher. Managed preparation also uses that version-owned source contract for
verification, its inspection report and the reviewed definition digest. Prepared
receipt validation uses the retained contract, so a later catalog edit cannot
invalidate unchanged prepared inputs. Actual source, setup tool, manifest or
prepared-output changes still fail the existing review and integrity checks.
Installed launch readiness uses the retained source and BIOS profiles too.
Within each status snapshot, source-health results are reused only for identical
profile content; two installed contracts sharing a profile ID cannot inherit each
other's result. Uninstalled sources retain their explicit unchecked state.
API schema 47 exposes successor install, preparation and launch assessments on the
shared port status model. Lifecycle entry points enforce the same core result;
legacy format-1/2 contracts retain their existing behavior because they have no
invented publisher identity. No new publisher, signing grant, or updater is enabled.

Portcove currently has one authority for catalog, source, release, installation, update, rollback, persistence, recovery, and launch behavior: `portcove-core`. The CLI and Tauri backend are thin adapters around it. The React frontend invokes Tauri commands and never owns installation state. External frontends use the public CLI and own only their presentation and platform-facing translation; they do not become another game-management authority.

```text
External frontend / launcher / script
       │ JSON, JSONL, exit codes; raw supervised exec
       ▼
  portcove CLI
       │
React UI ── Tauri IPC ───┤
                         ▼
                  portcove-core
 catalog ─ sources ─ releases ─ lifecycle ─ launch
                         │
                 SQLite + library tree
```

## Public launch observation

The external Playnite example in `integrations/playnite` consumes only the public
standalone CLI and public Playnite SDK. It owns launcher presentation, literal
process arguments, schema checks and a last-launch reference pointer. Core owns
all durable outcomes; the pointer stores no parallel operation or installation
state. A framework-native JSON reader avoids shipping an additional runtime JSON
assembly into Playnite. SDK and framework targeting dependencies are build-only
and lockfile-verified. Desktop remains a direct core adapter.

External launchers may supply a UUID to CLI `exec` and query `launch show` through
core's existing retained launch-request record. CLI input parsing normalizes UUID
syntax; core remains the authority for request reuse, port exclusion, acceptance,
exact process identity, cancellation and terminal save collection. The read uses
`Library::launch_request` before service recovery initialization, so observation
cannot advance a retained operation. API schema 42 exports the nullable core record.
No daemon, adapter job store or machine output inside raw game streams is added.

## Public library identity

Core exposes its existing database identity with the effective library root through
`Library::identity_record`. CLI `library identity` and generation-bound Tauri
`get_library_identity` are thin reads of that record under the library lease.
The same ID continues to protect output-root ownership; there is no second identity
store or adapter SQL. Managed moves preserve it, while supported metadata/content
imports retain the destination's independently initialized identity. The identity
command was introduced in API schema 41; metadata and database formats are unchanged. The public ID is opaque and is
not an authentication, trust or qualification claim. See [CLI identity semantics](CLI.md#library-identity).

## Desktop command-line handoff

The native host reports the effective library and discovers a separate CLI beside
Desktop or in absolute PATH directories. Discovery reads file metadata and never
executes that program; it supplies a path, not a version or trust attestation.
The request binds the current library generation. React formats documented CLI
arguments and shell syntax as presentation, including an explicit library root.
It labels missing executables or source inputs as templates and exposes program
and argument-array fields separately. This creates no independent lifecycle
state or command authority: the standalone CLI validates and executes through core.
Desktop continues to call core directly.

## Desktop library handoff state

Library selection and transfer share the same adapter initialization lock. Either
in-flight handoff excludes another switch, move, import or recovery transfer before
it can replace the active adapter state. Bootstrap captures the library and its
generation under that same lock; successful selection and every attempted transfer
publish the reopened state and new generation together. A transfer error can follow
committed changes or reopening through a relocation receipt, so it also expires
earlier reviews. Rejected overlapping handoffs leave the owned operation untouched.
Reviews from the previous generation must be requested again. Core still owns library leases, copy verification,
persistence, transfer journals and durable library selection; this is host-state
coordination, not another domain authority.

## Existing-install adoption review

Core's adoption preview binds both the source copy plan and the destination:
output preference, current active installation, copied persistent paths and current
saved-data identity. It reuses catalog persistence rules and reviewed tree hashing.
Authorization is checked under the existing port lock; the reviewed output root is
used for copying, and destination/saved-data identity is checked again before
publication. Catalog-selected saved data is merged with matching files replaced;
there is no automatic safety backup. Original folders and retained versions remain.
Existing journal recovery may finish verified publication and saved-data transfer.

Desktop transports this core preview under the selected library generation and
retains backend-owned native confirmation. Its detailed review names destination,
preserved state, saved-file replacement, lack of a single undo and interruption
behavior. Once applying, dismissal and path editing are disabled because adoption
has no supported cancellation. React owns only the review request and pending UI;
core remains the only copy/persistence/authorization authority. CLI schema 40
versions the extended preview; no crate boundary or dependency changes.

## Backup review presentation

Core owns backup selection, payload/user-data fingerprints, single-use authorization,
per-port exclusion and journal recovery. Desktop exposes a generation-bound review
that combines the existing core preview with its saved-data path. Its custom restore
and deletion dialogs show affected paths, preserved data, safety-backup behavior,
reversibility and interruption semantics. Explicit application submits the reviewed fingerprint to a final backend-owned
native confirmation; changed data or library selection requires another review.
Closing a review makes no backup mutation. CLI backup review and authorization keep
their existing core implementation and machine contract.

## Installed-game removal review

Desktop lists every managed version path returned by core before removal,
including retained versions and external output paths. The review names saved
settings that are removed, saved data and backups that remain, original source
and adoption-folder preservation, and the irreversible/interruption behavior.
An explicit apply request is bound to the reviewed install fingerprint and current
library generation, followed by final backend-owned native confirmation. The adapter delegates authorization and removal to core,
which revalidates under its port lock, collects saved data and journals quarantine
before removing metadata. Dismissal makes no removal request; changed inventory
requires a new review. The CLI and core machine contract remain unchanged.

## Source-reference removal and shared review state

Settings exposes the existing core source-removal preview with the original path,
installed dependents and all catalog dependents. The review explains that only the
library reference is removed, other files/state remain, and later use requires
registration under current checks. Both preview and application use the selected
library generation. The adapter checks the fingerprint before backend-owned native
confirmation, then reacquires the current service and delegates authorization and
locked deletion to core. A changed reference or dependency set requires a fresh
review; no renderer request can bypass native consent.

Backup, installed-game and source-removal dialogs share one presentation-only
review lifecycle: stale request rejection, synchronous duplicate-apply exclusion,
neutral native cancellation and renewed review after failure. Each domain keeps
its own core preview, confirmation, action and detailed copy. Source-list refresh
failure after a confirmed removal is reported as a stale view, never a failed
removal that should be retried. No domain state or authorization moves into React.

## Failure and diagnostic authority

Core owns failure presentation, observed mutation outcomes, recovery-action
vocabulary and terminal activity reports. CLI and Tauri serialize the same core
report while preserving original machine error fields. React presents this
information; it does not infer successful rollback or unchanged files from a
failed operation or a particular error code. Unannotated outcomes remain Unknown.
Not started, no requested changes, committed and recovery-required observations
must be assigned where the operation owner has matching evidence. These states
do not make blanket claims about diagnostic or lock-file bookkeeping.

SQLite schema 20 records structured failure reports in the existing activity
history update, atomically with terminal status. Older rows remain readable with
no report. Corrupt optional failure details are reported as unreadable without
hiding the activity or preventing ordinary library access. Shared text/field
redaction now lives in core so activity presentation and desktop diagnostic
bundles use one policy; host tracing, rotation and support-bundle packaging stay
in the desktop adapter. Raw machine error fields retain their established meaning.

SQLite schema 21 adds lazy, per-activity diagnostic captures. Core owns two
bounded output streams, shared redaction, periodic and terminal snapshots, and
retention. Existing setup supervision records snapshots at most every 500 ms;
there is no new scheduler. Raw tool bytes stay in bounded memory and are redacted
as complete retained streams before SQLite writes. The original stream boundary
and byte counts remain distinct. A final capture is complete only after both
streams close; truncation is a separate observation. An interrupted process can
leave an explicitly incomplete snapshot, never an invented complete log.

Each stream retains its first 2 MiB of input bytes. SQLite diagnostic payloads
share a 64 MiB budget: only older terminal captures may be pruned, while their
activity outcomes and retained preparation files remain intact. If running
captures exhaust that budget, setup stops safely and preserves partial work.
Deleting an expired activity cascades to its diagnostic row. Normal activity
lists do not load tool output. CLI and Tauri request one activity ID through
core; desktop requests also bind the selected library generation. Support bundles
include the retained redacted captures, with fixed archive entry names. Source
files and private setup output directories are not copied into the bundle.

SQLite schema 22 keys captures by activity and phase, preserving schema-21 setup
payloads without changing their bytes. Phase snapshots update only their own row;
source conversion output survives later setup execution. Retention removes all
captures for an expired terminal activity together. Explicit reads return phase
captures in their original start order, and reject mismatched stored identities.
CLI schema 39 versions this array response; Desktop and support bundles consume
the same core data.

PS2 CHD conversion and upstream setup share the existing owned tool supervisor.
The caller constructs a policy-admitted command and supplies cancellation and,
for managed preparation, a phase-bound diagnostic sink. Host-tool and upstream
setup executable policies remain distinct. Cancellation or diagnostic failure
stops the owned process tree before returning. Failed conversion keeps its
temporary output private. The private destination is replaced only after successful
conversion and a cancellation check; its source identity marker is written after
required output-hash verification.
This extends an existing core responsibility without introducing another runner,
scheduler, domain owner, dependency or trust grant.

Startup recovery closes an interrupted, unpublished preparation's running
activity only after acquiring its port and activity ownership locks and checking
the recorded activity's operation and port identity. The report preserves private
work, describes the interrupted outcome and offers review before a new attempt.
A stored cancellation request does not prove that every native child stopped,
so recovery does not manufacture a successful cancellation. Existing terminal
reports and incomplete phase captures remain unchanged. The original private
attempt cannot resume; repair guidance names starting a new preparation after
reviewing current inputs. Later validated publication recovery keeps its existing
idempotent behavior.

## Evolution policy

This document records the architecture Portcove tests today; it is not a promise to preserve the initial crate graph forever. The durable requirement is unambiguous ownership, not the name or number of crates. A real implementation need may justify splitting a coherent domain from `portcove-core`, adding a boundary service, or keeping genuinely host-specific orchestration in an adapter.

Make such changes as one reviewed migration: explain the pressure and tradeoffs here, assign one owner to every durable state transition, update `scripts/check-rust-architecture.mjs` and its tests, and remove the superseded route. Safety invariants, machine-readable CLI compatibility, and rollback behavior remain hard constraints. File size, a complexity score, or a desire to make a tool green is not sufficient evidence by itself.

In this document, “thin adapter” means that the CLI and desktop do not reimplement catalog, installation, release, source, or library policy. Adapters may own concerns that exist only at their boundary, including argument and IPC translation, native dialogs, credential-store access, process attachment, and presentation-shaped aggregation. If a boundary concern becomes reusable domain behavior, move it behind the shared authority instead of copying it.

The CLI's schema module assembles the transport schema inventory from existing
Rust `JsonSchema`/Serde definitions. Explicit input and output contracts use
Schemars' deserialization and serialization modes; a default accepted on input
does not remove a field from emitted output. This host-facing export performs
no domain validation and opens no library. Crate ownership and architecture
metadata rules remain unchanged.

React's domain transport types are generated from these Rust schemas. The Rust
quality check compares complete output schemas and the explicitly consumed
request input schemas with committed generated snapshots. The frontend check
regenerates TypeScript declarations with a pinned schema compiler and checks
the application against them, including nested arrays, nullable fields and
discriminated variants. Requests retain input defaults; responses retain emitted
presence. Type-only imports add no schema data or validator to the application.
Rust continues to validate runtime values and domain constraints. Tauri owns
bootstrap/error/batch/launch envelopes and its install request in its private
transport module. The desktop package's repository-only schema export example
compiles that exact source module; it does not initialize Tauri, open a library,
or become a product API. Repository tooling checks those schemas independently
and combines their declarations with core types for the frontend. Matching
nested definitions must agree before reuse. Both adapters still call core
directly; neither adapter depends on or executes the other. The module split
changes no domain owner, crate boundary, or architecture metadata rule and does
not by itself prove complete command/readiness parity.

The core preparation module owns exact input planning for the existing
upstream-managed setup family. It reuses port locks, source assessment, installed
manifest verification, host-tool selection and reviewed tree identity. The CLI and Tauri transport its result and state-bound execution. Plans neither execute tools nor publish readiness;
catalog output ownership is validated separately from existing artifact trust.
This module introduces no job database, process runner, domain owner or crate
dependency. Existing lifecycle execution remains unchanged by planning.

Explicit core preparation copies a fully verified installation to a unique
private directory, materializes its reviewed source, and runs only the admitted
native setup executable with catalog arguments. It checks the declared generated
output ownership and preserves executable, source and save identities before
creating a derivative manifest and receipt. The existing lifecycle journal owns
publication and recovery; no second job database or state owner is introduced.
Publication preserves a separately staged update and retains the original
installation as the previous version. Interrupted private work is retained for
inspection; retry creates a new directory. Validated publication can recover only
while its original inputs and operation identity still match.

Native setup shares process-group handling with fixed host probes. Private
preparation captures bounded diagnostics and observes cancellation while setup
runs. The working directory and process group are not a sandbox. The reviewed
family now prepares through explicit CLI/Tauri operations. Its launch path checks
manifest-bound readiness and full immutable output, then restores user data and
supervises the game; it does not materialize sources or run setup. React owns the
review screen and transient progress only. Tauri rejects a review from another
library generation and translates events through its existing channel transport.

Preparation receipts bind the generating definition, source, artifact/runtime,
host and default options. Changed identities require a new preparation review.
Already completed legacy installations retain the existing manifest/setup/source
binding without synthesizing historical definition evidence. Missing new receipts
cannot be treated as legacy installs. Tools recorded as generation provenance need
not remain installed to play immutable output. Other adapter families retain their
existing behavior. No crate or durable state ownership boundary changes.

Game-update settings and execution are separate. Saving a policy only persists
that setting through core. The desktop uses explicit reviewed updates rather
than bulk reconciliation disguised as a settings action. Core binds each review
to its release, definition, destination, source records, installed/retained state,
host and chosen stage/activate mode. A single-use authorization is revalidated
under the port lock before the existing release-application transaction runs.
Checks, downloads and activation have distinct visible actions; a staged local
copy can be activated offline with its expected active/staged identities. CLI
reconciliation remains an explicit policy-execution operation. Host library
generation checks prevent a desktop review or settings save from crossing into
another selected library. No new durable job or installation authority is added.

## Monorepo and deliverable decision

`portcove-release-tools` is an unpublished, offline repository tool for checking
application artifact signatures and constructing signed application-update TUF
metadata from an already reconstructed target inventory. It uses maintained
Minisign verification and `tough` signing with externally supplied, distinct role
keys, independently of the desktop's GUI build dependencies. The existing JavaScript
release tooling owns package selection, inventory, and deterministic record
reconstruction. This tool checks exact artifact tuples and creates one staged TUF
bundle; it cannot provision credentials, publish bytes, or activate an updater and
has no catalog, installation or application replacement state.
It is outside the default Cargo members and shipped packages. Architecture rules
forbid dependencies in either direction between it and the player crates, so it
cannot become a second domain authority or a runtime dependency. Disposable test
Payload test signers are development dependencies only. TUF role credentials are
external inputs and are never copied into repository output.

The [application updater trust design](UPDATER-TRUST.md) assigns application
replacement/trust state to the Tauri host; core retains library/game authority.
The host's independent `application_update_preferences` store records the user's
single explicit channel, update mode and pause choice outside every library. Reads
do not create state, writers use optimistic revisions under path-keyed process and
operating-system locks, and the shared durable-file helper publishes a flushed
sibling atomically. Missing state means no consent; malformed or future state fails
closed until an explicit reset clears the choice and advances its revision. These
typed host commands only read or persist policy and cannot check, download, stage or
apply an update.
The sibling `application_update_schedule` store persists only successful-check
cadence and bounded retry state. Its pure decision boundary combines that state
with the explicit preference, a 30-second startup delay, and observable offline or
metered status. Successful checks defer the next automatic check by at least 24
hours. Failures use a 15-minute exponential retry with bounded jitter and a six-hour
cap without shortening an existing hold. Each outcome binds the preference revision
observed by its check, so a later channel or mode change ignores stale cadence.
Manual checks bypass cadence, startup, pause, mode and metered holds but still refuse
a known offline state. Unknown
metered status holds automatic work so the user can choose manually. Strict parsing,
compare-and-swap revisions, path-keyed process and OS locks, atomic durable writes,
and explicit corrupt-state reset match the preference boundary. The module has no
network, download, staging, application or persistent-device-identifier authority.
The `application_update_coordinator` is the single host owner for manual and due
automatic checks. It re-evaluates policy after acquiring one process and OS lock,
awaits an injected authenticated checker off the startup path, and records success
or failure only after completion against the schedule revision that admitted the
check, so a concurrent explicit reset wins. Dropping a check releases ownership
without inventing an outcome. An observed preference change during the check makes
its result superseded; the coordinator records it against the old revision but
returns no candidate for staging. A returned candidate carries the preference
revision that downstream work must revalidate. Current policy ignores old cadence.
The checker remains the existing authenticated repository boundary, so coordination
adds no URL, key, network, staging or apply authority.
Immediately before a host application replacement, core's
`ApplicationUpdateQuiescenceGuard` acquires the current library's
exclusive lifetime lease. Every CLI and Desktop library instance already retains the
shared side for its lifetime, so another process or previously dispatched operation
prevents admission. After ownership, core requires the current schema and rejects any
unfinished launch session or running activity until explicit recovery. The host
retains the guard across its checks and replacement, preventing a new library
operation from winning the recheck-to-apply interval. Relocated source roots are
rejected in favor of their current destination. This proves current-library
quiescence only; candidate freshness, executable ownership, permissions, consent and
native replacement remain host checks.
Independently, every normal CLI command, Desktop process, launch supervisor and
recovery helper retains a shared `ApplicationRuntimeGuard` in the canonical user host
directory for its full process operation. Update admission takes the exclusive
side before the library guard, so a process using another library also blocks
replacement and a new process cannot enter while replacement is admitted. The lock
contains no state and does not enumerate libraries; per-library recovery and busy
details remain owned by the library guard.
The host's `application_update` module validates separately authenticated immutable
release and channel records against installed identity and compatibility context,
then selects by SemVer precedence. `application_update_repository` is the bounded
bridge from TUF to that selector: it discovers the installed package's versioned
promotions, requires separate direct release/channel delegation, rejects top-level
or duplicate records and fully consumes authenticated streams before parsing. A
sibling strict payload-key parser validates the offline-authorized top-level
`keys/payload.json`, including the exact decoded public-key SHA-256 and minisign
format, and the bridge returns only the selected release's Tauri-compatible key.
`application_update_trust` wraps the maintained `tough` client with path-keyed
process ownership plus one host OS lock, atomically persisted greatest accepted
time, the latest verified root and explicit
timestamp/snapshot/targets version and signed-body replay floors. After TUF
authentication it enforces the host's delegated-role depth/count, global role-name,
target-count, selector-count and bounded-name/path policy; unavailable delegated
metadata fails closed, and rejected authenticated versions still advance replay floors.
It supplies the latest persisted root on restart and retains verified root progress
when later metadata fails. Disposable local-file repositories remain available to
tests.

`application_update_host` is the sole runtime constructor for that repository and
selection path. Updater-enabled Desktop builds embed a bounded public TUF root and
fixed metadata and target bases as one build-time configuration; partial input
fails the build, and ordinary alpha builds remain unconfigured. Runtime environment
variables and React cannot supply those authorities. The Windows context source
proves the running package through the exact current-user NSIS registration and
combines it with compiled target, API, catalog, library and lock compatibility plus
the actual operating-system version. The provider serves both ordinary checks and
fresh helper revalidation. A fixed manual-check command now invokes that provider,
streams only checking, acquiring-and-verifying, staged and complete phases, and
returns only candidate version/channel/size, policy reasons and staging outcome.
One process-owned cancellation token prevents overlapping renderer requests and
cooperatively stops the existing restart-reconcilable operation. The command is
unavailable in ordinary unconfigured alpha builds. No production root or origin is
present, and no automatic schedule, exit hook or helper launch currently activates
the provider.
The sibling payload boundary independently binds an already obtained stream to the
selected release length, SHA-256 and exact registry key using bounded, prehashed
Minisign verification. Only its Rust-only verified identity may cross into later
staging work; it owns no download, eligibility, replacement or installation state.
The host's private `application_update_staging` module tees that exact verification
stream into a fixed incoming file, checks capacity for both the authenticated payload
and native replacement workspace, and publishes one active candidate with durable
staged, payload-verified and verified journal phases. Its path-keyed process and OS
locks serialize writers. On restart it discards pre-verification bytes, restores the
prior verified slot after an interrupted attempt, or completes publication only from
the durable payload-verified phase. Corrupt or future journals require explicit
bounded reset. A reconciled file is retained state rather than fresh eligibility or
apply authority. The sibling payload downloader accepts only the authenticated
Portcove GitHub release/version path, follows at most five redirects through the
reviewed GitHub release-asset host, resolves and pins public addresses, bypasses
ambient proxies and streams anonymously under connection, idle, total-time and
authenticated-length bounds. It returns only a reader for the existing verifier and
staging boundary; no platform replacement is active.
The sibling `application_update_apply` journal binds a requested safe exit or
explicit one-restart action to the exact staged candidate, preference revision and
choice, installed application context, and canonical current-library root. Its
strict compare-and-swap revisions prevent a stale exit observer from changing a
newer request, and a different candidate cannot replace an unfinished intent.
Normal Exit and Restart to apply are distinct eligible observations; crash, OS
shutdown, Steam Stop, missing hooks and mismatched observations remain held for
next-launch reconciliation. Only a Portcove-owned installation can enter the
journal. Even a matching observation permits only another revalidation attempt:
the host locks the apply journal, preferences, staging slot, user-scoped application
runtime and current library in that order, then requires the expected journal
revision, matching termination,
unchanged consent, exact verified staged candidate, exact freshly authenticated
candidate and installed context, current compatibility and core quiescence. Those
locks are retained together through final native admission and process creation.
Executable ownership and permissions still require a platform proof before
replacement. On Windows,
`application_update_windows` adds that platform proof without accepting paths from
IPC. It requires one exact HKCU Portcove uninstall registration, the registered
version and install directory to own the running `portcove-desktop.exe` and direct
`uninstall.exe`, a writable non-reparse install tree, and the locked staged payload
to remain an exact Windows x64 Portcove NSIS candidate with PE bytes. It inventories
both HKLM registry views and refuses system-wide, custom, ambiguous or identity-drifted
installations. An admitted payload starts through the documented passive NSIS
`/P /UPDATE` path and the reviewed host-integration child-process policy, with no
relocation or elevation argument, while retaining the shared revalidation lease
through process creation. Before creating the process, the apply journal records
`starting`; a helper crash then remains an ambiguous attempt instead of silently
starting the installer twice. The launch remains `starting` while every updater
lock is retained and the helper observes the child. A zero exit records
`installer-succeeded`
but still requires installed-identity and application-health reconciliation before
the request can clear. A proven pre-spawn failure records `failed`; a nonzero exit
records `installer-failed`. Both are known to have no live child and are eligible
only for an explicit retry. A legacy `started` state and any crash while `starting`
remain ambiguous and held. Windows staging uses one fixed
`.exe` payload slot so the operating system can execute the authenticated bytes;
other platforms retain their inert generic slot until their own adapters define a
format-specific replacement. The sibling `application_update_helper` defines the
post-exit revalidation sequence for a dedicated process without accepting paths,
repository locations, trust roots, candidates or keys in its request. It first
requires the exact eligible apply-journal revision, then waits up to two minutes for
the persistent user-scoped application-runtime lock to become exclusively available.
Using the runtime lock avoids the process-ID race where a fast parent can disappear
before a child opens its handle and also accounts for other Portcove processes. The
helper releases that probe, obtains a newly observed installed context and fresh
authenticated selection through its host-owned Rust provider, and immediately
acquires the canonical apply, preference, staging, application and library lease.
The retained and newly observed installed contexts must match. A process that starts
during the fresh check wins the shared runtime lock and safely defers replacement.
The exact `--portcove-apply-update <revision>` helper mode is reachable only from
the host-owned Restart to update command after the current library generation,
verified staging, saved preference and installed package have been rebound into the
durable journal. While holding the desktop's library-selection mutex, the parent blocks
new backend workers and manual application-update checks, refuses workers already in
flight, and preflights
the same durable activity and launch-session idle conditions so the restart does not
knowingly interrupt current-process work. The helper receives no path, URL,
candidate or key. After the parent
releases its runtime lease it repeats fresh repository, installed identity, consent,
staging and quiescence checks, crosses Windows NSIS admission, and records the native
outcome. It reopens the registered application after success or a failure proven to
have no live installer, and only after proving that no Portcove runtime peer already
exists. A child-observation failure remains ambiguous and starts no peer process. The
later healthy startup remains the only authority that can clear a
successful attempt. On a later Windows startup, reconciliation
runs only after the new process holds the application runtime lease, initializes its
selected library and diagnostics, creates the Tauri application, focuses the main
window, and restores every retained launch-session observer. It then requires the
compiled version to equal the retained candidate and one
exact current-user NSIS registration to report that version and own the running
executable and uninstaller. The host retires only that exact staged candidate under
the apply-before-staging lock order; a newer staged candidate is preserved. It clears
the apply request last, so interruption during cleanup remains restart-reconcilable.
Installer exit status alone never grants this installed-identity or health proof.
The adapter-local `application_update_status` command combines sanitized summaries
of check cadence, a verified staged candidate, and any pending safe-exit or restart
request. Its apply summary includes the durable `starting`, `started`, `failed`,
`installer-succeeded` or `installer-failed`
native-launch state so React can explain why another launch is held without receiving
host paths or native authority. It never exposes authenticated URLs, signatures,
payload keys, installed paths or library paths to React, and retained state is never
described as fresh apply authority. Malformed or future schedule, staging and apply
journals are reported independently so other readable state remains visible. Each
fixed recovery action rechecks that its journal is still invalid under that store's
lock before it clears only that domain; a stale UI action cannot discard state another
process already repaired. Native automation redirects every updater journal into the
run's fresh evidence directory.
The Settings action appears only for a verified staged candidate with no conflicting
or ambiguous apply attempt. It supplies the current library generation and can reopen
only a proven `failed` or `installer-failed` attempt; `starting`, legacy `started` and
`installer-succeeded` remain held for installed-identity reconciliation.
For production metadata, a sibling host transport accepts only host-selected
HTTPS bases with separate path prefixes on port 443, resolves and pins public DNS
results, bypasses proxies, refuses redirects and enforces request, deadline, idle,
per-role and aggregate byte limits. Its Rust-only request cannot be populated from
frontend IPC. No production origin, updater check, publication or
replacement is active. Existing architecture metadata rules continue to forbid
independent catalog verification in adapters.

Offline release tooling reconstructs the host's record inputs from complete raw
qualified updater inventories, their signature files, frozen run/tree context,
compatibility policy and separately reviewed channel eligibility. It emits one
immutable release record and versioned channel promotion per applicable target,
so compatibility selection remains host-owned. Reconstruction protects existing
release records from mutation or omission and can atomically repair derived channel
output. It holds no runtime, signing, publication or production eligibility
authority; protected automation must authenticate the inputs and sign the distinct
TUF roles without executing candidate tooling with production credentials.

Portcove Core, CLI, and Desktop remain in one repository. Shared core services
own game-management behavior. CLI and Desktop are independently usable
interfaces and separately packaged deliverables. Repository separation is not
needed to provide standalone CLI downloads, focused builds, or independent
release scheduling if that is eventually justified.

The dependency direction remains CLI -> core, Tauri backend -> core, and React
-> Tauri IPC. The official desktop application calls core through its Tauri
backend; it does not shell out to a separately installed CLI. Catalog and source
admission, installation, game updates, persistence, per-port locking, recovery,
and launch policy retain one shared authority. Host argument parsing, native
dialogs, process integration, IPC translation, and presentation remain at their
appropriate boundaries. Interfaces need compatible domain outcomes, not
identical presentation.

Core, CLI, and Desktop keep coordinated product versions for now. Coordinated
versions do not make arbitrary separately installed CLI and Desktop versions
compatible: library-schema, locking, migration, and machine-contract protections
still apply. This decision does not publish internal crates, promise a stable
internal Rust API, introduce a daemon/RPC layer, or prevent a focused crate from
being extracted when implementation evidence supports the evolution policy.

Reconsider repository extraction only for demonstrated independent ownership,
access-control requirements, or a genuinely independent product. Download-list
clutter, implementation language, file counts, directory aesthetics, and a wish
for different release timing are not sufficient. Community-maintained clients
may live elsewhere and consume the public CLI contract without becoming official
Portcove maintenance obligations.

The same rule applies to third-party clients. A launch-only integration may
translate a stable Portcove/library identity into its frontend's executable and
argument fields. A library integration may map supported metadata. A lifecycle
integration may present Portcove readiness, progress, errors, cancellation, and
recovery. None may read SQLite, duplicate catalog/admission rules, derive durable
identity from display names or mutable paths, or retain a parallel operation
database. `exec` deliberately transfers its standard streams and final process
status to the game; structured management calls and durable core activity remain
the observation path around it. See [External frontend integration](INTEGRATIONS.md).

## Library model

The [configured upstream observer](UPSTREAM-OBSERVATIONS.md) owns bounded,
read-only provider collection and factual operational checkpoints. It submits
inert observations through the standalone CLI to core's existing release
channel and asset policy. Core validates the exact scope and facts and exports
metadata eligibility separately from authentication, integrity and admission.
The CLI translates this offline command without opening a library. The
observer neither writes catalog support nor owns installed/update state;
existing crate dependency rules remain unchanged.

`source_assessment` defines the shared source fact contract: existing
`SourceHealth` (including selected bytes without a baseline), classification,
reviewed release-contract result, actual admission/mode/reason, and scoped
evidence are independent. These serializable records are descriptions, not
operation authorizations or a second matcher. Existing validators and lifecycle
checks remain authoritative. Schema export exposes the contract for subsequent
inspection integration; current verification responses retain their existing
fields and read-only behavior.

Evidence relevance compares the exact port, platform, artifact, upstream ref,
contract, source variant/representation and check version. An unspecified legacy
variant or absent artifact/check identity cannot establish exact qualification.
Relevance does not mean success: consumers must retain the evidence kind and
outcome, including failed and not-run observations. Recorded Portcove build and
observation time remain historical attribution; changing an unrelated build
does not erase a fact. Evidence IDs are catalog references, not renderer URLs.
Schema 2 stores exact source qualification under the same core authority. Core
validates each record's port, platform, contract, artifact applicability,
variant, representation, check version, method, outcome, and evidence references
and derives category and all-source claims from exact matches only. Legacy
platform arrays remain historical unscoped facts. Signed format 1 can add
reviewed artifact applicability and exact qualification for existing contracts,
while source meanings and prior facts remain frozen.

The schema-2 source contract models the input to those facts through reusable
identity profiles with logical variants and alternative physical
representations. Per-port contracts select supported variants and an enforced
or informational admission mode. Digests inside one identity record are
conjunctive and carry an explicit byte scope; separate identity records and
representations are alternatives. Evidence, validators, aliases, tombstones,
release applicability, and review URLs use stable validated IDs. The embedded
catalog is schema 2. Core deterministically projects its source authority into
the temporary schema-1 `SourceProfile` view consumed by the existing matcher;
catalog input may not supply a conflicting view. The frozen full schema-1
fixture and contract fingerprints prove that projection preserves every prior
profile and port binding. Profiles with reviewed Alpha 2 variant corrections
retain an explicit `legacy_projection_only` record that contracts cannot select;
this keeps the old matcher unchanged without treating the projection as current
schema-2 identity. The projection retires when #180 moves all consumers to the
shared inspector.

`SourceInspection` is the read-only core result for selected source bytes. Its
observed digests retain algorithm and byte scope, schema-2 digest fields match
conjunctively, representations match as alternatives, and more than one matching
representation is rejected as ambiguous. Ordinary files, cartridge ZIP members,
canonical N64 byte orders, and file sets use this result for discovery,
registration, relink, verification, install overrides, and launch preflight.
GameCube and PlayStation disc sources use the same result through their existing
bounded conversion paths. LIVE/STFS compound inspection also applies the same
bounded parser, path checks, expanded-size limit, and block-chain checks used by
materialization before an exact package identity can be admitted. Pinned
upstream-validator sources record the selected validator contract and a `not_run`
result while preserving preliminary structural admission; they do not claim an
exact identity until the pinned setup tool performs its validation.

File-set inspection records each required top-level member with its stable
catalog member ID, selected filename, byte size, and SHA-1, SHA-256, and CRC32
facts. It matches all digest fields inside one member identity together and
aggregates admitted members with the established source-record algorithm. ZIP
storage identity remains distinct from member and aggregate content identity.

Disc inspection reuses the established bounded GameCube and PlayStation
materializers without changing the selected input. GameCube results retain the
normalized ISO SHA-1/SHA-256 separately from compressed-container storage
identity. PlayStation results retain ordered per-disc track counts, readable
volume IDs, normalized data-track SHA-1/SHA-256, and aggregate versus CHD-set
storage identity. Schema-2 matching requires every configured fact for one
representation and rejects reordered, incomplete, mismatching, or ambiguous
disc sets before a source record becomes usable.
`HostPreferenceStore` provides bounded format-1 host preference storage and selection provenance without moving a library. CLI and desktop use its platform configuration path outside movable library data and credentials, with an optional absolute preference-file override for portable/test hosts. Selection precedence is an explicit invocation path, saved path, then the platform default. Invalid selected configuration fails visibly; an explicit invocation path or reset remains available when preferences are corrupt or from a future format.

Preference writers serialize through a process lock keyed by the exact preference path before taking the persistent sibling operating-system lock, then publish a flushed sibling atomically using the shared durability helper. The process lock closes platforms where operating-system file locks do not serialize handles owned by one process; the sibling lock preserves the cross-process boundary. Reads never create files. Setting a library preserves compatible unknown JSON fields; explicit reset replaces the whole document, including damaged or future-format content, with current defaults. Core validates that a saved target is an existing empty directory or recognizable Portcove root, refuses symlinks, filesystem roots, unrelated content, and preference/library overlap, then stores its canonical path without initializing it.

For a live desktop switch, the adapter makes its current state unavailable and drops its cached library/providers. Core then acquires an exclusive lease on the old root; an already-dispatched operation retains a shared lease and makes the switch fail, after which the adapter reopens the old state. Only a successfully opened target is persisted and published as current. A monotonically increasing bootstrap generation remounts React's library-owned state so results from the old workspace cannot populate the new one. This introduces no second library authority or database/catalog migration.

Core resolves newly opened library roots and validated source references to absolute paths before they produce durable records. Relative CLI arguments therefore do not tie a new installation or source to that process's working directory. Existing ambiguous relative records are not guessed or silently rebased; they require qualification from their original base and explicit reinstallation or source relinking.

Catalog `persistent_file_patterns` extends the same core-owned persistence boundary to named save files. Rules are literal nonempty filename prefixes/suffixes in one working directory, with no recursive traversal or general glob syntax. A scan admits at most 4,096 directory entries and 1,024 matching regular files; links, directories, special entries and unsafe filenames fail closed. Collection and restore consider both source and destination names so deleted/restored-away profiles cannot reappear. Manifest schema 5 stores the rules with their resolved directory, preserves immutable executable/bootstrap/runtime checks, records the qualified target platform and each immutable file's executable intent, and rejects changed rules or permissions during import. Schema 2-4 manifests remain readable without silently acquiring executable metadata they never recorded. Signed catalog delivery keeps persistence rules frozen like literal persistence paths. This adds no adapter authority or crate dependency; the existing architecture metadata rules remain unchanged.

Before rollback, retained reuse, or staged activation switches the active pointer, core collects the current launched version and synchronizes its target. A previously launched target also loses persistent entries deleted from canonical data; a never-launched version keeps upstream defaults absent from canonical data. Synchronization failure leaves the old pointer authoritative, and activation recovery repeats the same order. This prevents a stale launch marker from collecting older saves over current progress after a version switch.

The default application-data directory contains:

```text
library/
  portcove.sqlite3
  versions/<port-id>/<artifact-sha256>/
  staging/<operation-id>/
  recovery/<operation-id>/
  user/<port-id>/
  source-inbox/<profile-id>/
  downloads/
  toolchains/
  runtime-sources/<port-id>/
  logs/
```

`runtime-sources` is a lazy, core-owned, rebuildable cache for source bytes that
an upstream process needs only while creating its own persistent runtime data.
It is outside authoritative `user` data. Before an archive-backed Libultraship
first launch, core removes only its exact fixed or UUID-named cache files,
normalizes into a private temporary file, verifies the result against the
admitted source SHA-256 and size, and publishes it with an atomic no-replace
rename. A restart removes an interrupted temporary; recognition of the
catalog-declared generated archive removes the cached ROM. Unknown entries,
links, and non-files fail closed.

The cache is excluded from library metadata content roots, backup content,
library import, and library move. A destination library rebuilds it from its
still-registered source when required. The retained source directory from a
library move may keep an old cache until that retained directory is removed by
the owner; it is never treated as user data or recovery evidence.

SQLite stores source references, settings, install records, active/previous version pointers, successful launch history, timestamped successful update-check snapshots, a typed activity ledger, durable launch requests, and the small set of incomplete cross-store lifecycle operations. An install record keeps its human-readable display version separately from the asset name, verified asset SHA-256 and size, manifest SHA-256, selected executable, and exact concrete path. Database opening takes a library-scoped operating-system migration lock before checking or changing the schema. Migrations are contiguous, individually transactional, postcondition-checked steps; a gap, a recorded partial step, or a schema newer than the running build fails with the affected versions instead of guessing. WAL and the busy timeout remain ordinary concurrency aids, not migration locks. Schema-8 migration leaves pre-identity installs explicitly unqualified rather than inventing provenance; they fail current-integrity gates until replaced or re-adopted. Schema 9 introduced active launch sessions. Schema 13 evolves them into retained request records with exact supervisor/child process-start identities, active phase, terminal outcome, child exit code, explanation, and timestamps; migrated sessions without start identity remain blocked for manual review rather than trusting a PID. Schema 14 adds an optional normalized absolute output directory to each port's settings. Core resolves a request override, then that saved setting, then the existing `versions/<port-id>` default. This preference controls future placement only; current installs, central user data, backups, sources, and shared tools keep their recorded locations. Schema 15 assigns the movable library a stable identity and records every claimed external game-output root with its port, marker identity, and filesystem-volume identity. The root marker and SQLite record must agree before core stages or publishes there. External installation preparation lives under that root's private `.staging` directory so verified publication remains a same-filesystem rename; missing or replaced volumes fail instead of falling back to the library drive.

Schema 16 adds the reviewed relocation plan to the existing lifecycle journal. Core copies every recorded version for one port into operation-private staging on the destination volume, verifies the copied tree and install manifest, publishes each copy with an atomic same-volume no-replace operation, then changes all install paths and the port output preference in one SQLite transaction. A destination that appears after review is retained and blocks publication; a platform or filesystem without the required primitive fails closed. Before the metadata commit the old paths are authoritative; after it the destination paths are authoritative. Startup resumes every recorded interruption phase. Cleanup verifies that an old tree contains only reviewed content before removing it; changed or undeletable old content is retained with `cleanup_pending`. Sources, central user data, backups, and shared tools are outside relocation ownership.

Schema 17 adds an optional format-1 observed-identity document to each source registration while preserving `profile_id` as the registration key. New registration and relink writes retain versioned digest scopes, safe selected ZIP-member names, file-set or disc components, and validator observations. Existing rows remain usable with no structured observation, which means not evaluated rather than an inferred variant. Verification, install, and launch inspect current bytes through the shared source inspector; stored facts remain the registration baseline and never become a cached admission verdict. Catalog changes therefore neither rewrite source rows nor leave an old classification authoritative. Library metadata format 1 carries the same optional document without source payloads, and imports validate it before hydration.

Schema 18 adds a reviewed source-import plan to the lifecycle journal. Copy and
move stage into an operation-private directory on the Source Inbox volume,
reinspect both the selected original and staged bytes, publish with an atomic
same-volume no-replace operation, and then register the published path. A
destination that arrives after review is preserved as a conflict, and a
platform or filesystem without the required primitive fails closed. Move additionally requires a
single-use state-bound authorization and quarantines the still-matching original
beside its old path only after registration commits. An interrupted operation is
resumed from its durable phase at startup. Before rename, core durably records an
operation-bound receipt beside private staging with the reviewed plan,
destination, and staged filesystem-object identity. If rename succeeds before
the next journal phase is persisted, recovery accepts the visible destination
only when that receipt, object identity, content, admission, path, and operation
lock still agree. A missing or unrelated destination, including a same-content
replacement with another filesystem identity, remains an actionable,
non-destructive conflict. If original cleanup cannot complete,
the verified Inbox copy stays registered and the result reports the exact
retained path rather than claiming a move.

The Source Inbox is the core-owned `source-inbox/<profile-id>` tree inside the
movable library. Profile IDs pass one conservative ASCII portable-component
policy, case aliases and symlink ancestors fail closed, and every scan stays
inside one canonical profile root. Core reuses the shared inspector and returns
typed exact, approval-required, ambiguous, incomplete, or unresolved results.
Only one exact result may be rechecked and registered when install needs that
profile; a saved registration retains precedence. Library metadata format 2
adds the Source Inbox as a reviewed movable content root. Format-1 Alpha 1
metadata remains readable and has no implied Source Inbox content. Explicit
import defaults to copy, while use-current-location performs inspection and
registration without copying. Deterministic digest-suffixed collision paths
prevent an unrelated existing entry from being replaced.

CLI and Tauri expose the same core-owned Source Inbox paths, profile scan,
state-bound import plan, and transactional import result. Adapters may open a
core-validated profile directory with the operating-system file manager and
may collect move confirmation, but they do not choose destinations, classify
candidates, copy bytes, grant reusable authorization, or write registrations.
React retains only transient scan, plan-review, progress, and cancellation
state.

Source inspection problems may include only the registry-owned host-tool ID
needed to continue a check. Desktop maps that ID back to the shared readiness
controls and reuses the selected paths for the retry; tool paths and other
private error details do not cross this presentation contract.

The versioned source-inspection report is the shared explanation boundary for CLI
and desktop. It combines current health and observed facts with the complete
expected profile, every dependent port contract, reviewed evidence metadata,
release applicability, exact evidence records, and explicitly conservative
legacy platform coverage. Its open state code supports additive presentation
states while the report and outer API schema versions guard typed meaning. A
registered inspection returns missing and unreadable states without mutating its
baseline. Evidence navigation accepts a stable evidence ID; core resolves that
ID from the active catalog and revalidates the immutable HTTPS URL at the moment
the Tauri host opens it.

React presents that report without deriving a second source decision. It leads
with the requirement, edition, admission, and per-port result, then exposes full
scoped expected and calculated identities, compound members, qualification, and
reviewed evidence. An absent expected digest stays visibly absent. Inspection
requests are bound to the selected path and active source catalog so an older
response cannot replace newer intent. A saved registered path may display its
current report; a different typed or picked path remains selected and unchecked
until a core operation evaluates it.

Native game-file intake is another read-only route to the same inspector. Core
classifies empty, single-path, directory, multi-path, unsupported, mismatch, and
ambiguous inputs for one requested source profile. Tauri translates only native
external-file events and does not infer identity or perform a mutation. React
temporarily reveals eligible port-card targets, binds each reply to the current
port/profile/path intent, and opens the same detailed evidence before offering
separate copy, current-location, or authorized move actions. A drop by itself
never registers, installs, copies, moves, replaces, or deletes source data.

Core also owns the read-only output-destination preview, capacity/ownership assessment, state-bound fingerprint, one-use authorization, port locking, and apply-time revalidation. CLI and Tauri translate the same preview and mutation results. New desktop storage commands bind each request to the active bootstrap generation, while React holds only the typed path entry and transient review state; a library, port, path, or newer-request change discards an old response. The Settings surface reviews whole-library switching separately, and a game page labels its per-port choice “Export / install folder” and states that it changes future placement without relocating recorded installs.

Management operations create a running activity before work and finish it as succeeded or failed without replacing the command's primary result. Best-effort progress uses a versioned core event envelope containing that activity UUID, a per-operation sequence, millisecond timestamp, typed target, optional parent operation, and terminal result. Nested work receives its own ID and names the parent. SQLite activity is authoritative after disconnect or restart; event delivery is never treated as durable truth. Update snapshots likewise come from the core, allowing a CLI check to repopulate the desktop after restart; consumers validate the snapshot's installed artifact digest, display version, and channel before presenting it as current. Catalog-wide status uses one bulk read model: settings, installs, launch history, update snapshots, and registered source records are each loaded once, and results are reassembled in catalog order without writing default rows. Required source identities are hashed once per profile during that status request and shared by every installed dependent. Uninstalled registrations are reported as `not_checked` instead of causing catalog browsing to hash source files. Debug diagnostics record the port and SQLite-query counts; scale tests hold the database portion to four queries at 250, 500, and 1,000 rows.

Every filesystem-mutating operation takes an operating-system advisory lock keyed by library and port. The lock is shared across CLI and desktop processes, fails immediately with a structured conflict instead of waiting indefinitely, and is released automatically if a process exits. A launch retains its lock until the game exits and the exact launched version's mutable data has been collected, so another frontend cannot update, roll back, remove, verify, or launch that port during the save-critical interval. The desktop starts a detached instance of its own native binary in a hidden supervisor mode; Tauri only forwards an identified request and observes that exact durable row. Core commits the request, exact install, supervisor PID/start identity, cancellable preparation phase, and generic activity before the adapter reports acceptance. Immediately before process creation, one conditional SQLite transition closes cancellation; a request wins that transition or child creation proceeds, never both. Core records `spawning` before process creation and then records the child PID/start identity before reporting it, writes the per-version launched marker only after child creation, waits for the child, records successful-exit history separately from in-flight state, and commits the terminal request outcome only after exact-install collection. Terminal rows remain reconnectable evidence but do not block another launch. If a supervisor disappears, the active row continues to block mutation; startup recovery waits only a child with the exact recorded start identity, repeats exact-install collection, and records failure rather than success. A crash in the irreducibly ambiguous spawning window remains blocked for manual review, as do PID mismatch, missing legacy identity, and changed install identity. Different ports remain independently operable.

Each registered source keeps its original path, content identity, storage identity, and registration time. A normal file has the same content and storage identity. A ZIP-backed cartridge records the selected inner member separately from the outer ZIP, a GameCube compressed image records its normalized ISO identity separately from its container, and a PS1 CHD records the normalized Track 01 identity separately from the CHD container. A file-set profile registers one folder or ZIP and derives a stable identity from every exact, top-level member; folder symlinks, nested ZIP members, and ambiguous alternative names are rejected. ZIP-backed file sets also retain the outer container identity. A declared multi-disc profile similarly derives a stable identity from its exact filename-sorted CHD set. Verification reruns the catalog profile checks and compares both fresh identities with the stored baseline without updating SQLite, activity history, or source bytes. It runs on demand and before a registered source is reused for install, update, or launch. Status reports each installed requirement as `current`, `missing`, `unreadable`, or `changed`; `unregistered` and the deliberately deferred `not_checked` state remain distinct. `current` proves only that storage bytes still match the registration baseline and never promotes an informational or extension-only catalog profile into an exact-revision claim. After adapter preparation, core performs a final identity check immediately before process creation; managed PS1 preparation rechecks storage identity after disc materialization and after BIOS use. A persistent source swap therefore fails before launch markers or child creation. Single-profile checks return normal structured failures; bulk checks isolate each profile so one missing or replaced file does not hide the others. Removing a source is a two-step core operation whose preview fingerprint binds the source identity, catalog dependents, and installed-dependent set; a short-lived one-use core authorization is consumed only after locking those ports and recomputing that state. Removal deletes only the SQLite reference.

Before launch, catalog-declared persistent paths are synchronized from `user/<port-id>/` into the active version. They are collected from that exact launched version when the child exits and before update, staged activation, rollback, removal, or backup. Synchronization refuses symlink destinations and ancestors. A per-version marker prevents a fresh release's defaults from replacing established user data while still recovering changes after an abnormal exit. Adapters may also use an upstream storage contract: Libultraship receives `SHIP_HOME`, N64 recomp releases get their upstream-supported `portable.txt` marker, and a reviewed catalog entry can declare a portable marker beside its executable together with a narrowly validated source-import variable and fixed arguments. Mutable paths are resolved against the same working directory the adapter launches, including when a release archive contains a wrapper directory.

Removal consumes its short-lived, one-use, state-bound authorization under the port lock before collecting live data. An admitted operation may finish a large collection after that token's expiry; expiry is never extended for a new request. The recovery journal is published with the exact managed paths before quarantine begins. A rejected request cannot collect live data or create a resumable removal intent. Startup marks legacy empty preparation intents as failed without claiming that versions were removed.

Persistent-data backups use the same per-port lock and canonical user root. A backup is copied into a same-volume temporary directory, rejects symlinks or unsupported entries, flushes every copied file plus its identity/count/size/tree-digest manifest, and is then renamed into `backups/<port-id>/<backup-id>`. That rename is an atomic namespace-visibility boundary for running processes. On Linux filesystems that accept directory `fsync`, core also synchronizes the staged directory tree and relevant library/backup parent directories before the rename, then synchronizes the final parent before returning success; a final-parent sync failure attempts to roll the visible snapshot back to private staging. Other platforms and Linux filesystems that reject directory synchronization explicitly do not receive a sudden-power-loss durability claim. Inventory ignores active private staging, returns verified manifest entries together with structured per-entry problems, and marks unmatched private deletion data or an incomplete deletion journal as recovery-required; one damaged entry cannot hide healthy backups or prevent an unrelated new snapshot. Restore stages and rehashes the selected tree before mutation, creates an automatic safety backup when current data is non-empty, and records the staged/current/recovery paths before swapping them. Startup can finish either half of an unambiguous process interruption; that journal and same-volume rename boundary do not claim cross-platform power-loss atomicity. Confirmed deletion records the exact bounded original and private quarantine paths before rename, then advances its lifecycle record after quarantine, filesystem removal, and commit. Startup completes an unambiguous authorized deletion, including a partially removed quarantine, but retains ambiguous or out-of-root state for repair review. Backups are intentionally independent of install rollback: they preserve mutable data, while release rollback changes application versions.

Elsewhere in this document, “atomic rename” describes namespace visibility and the operation's tested process-crash boundary unless an accompanying directory-sync step explicitly extends the claim to supported power-loss durability.

Source registration is a core-owned mutation. All source writers take a library/profile lock and the locks for every catalog port sharing that game source or BIOS, including registration through install overrides. These fail-fast locks prevent reference changes throughout a dependent launch or lifecycle operation without introducing a wait-order deadlock. Read-only relink planning validates the new location against the current profile and stored content identity; applying the content-bound plan repeats validation under those locks. The old source can be offline, but a changed registration or candidate invalidates the plan. Only SQLite's reference and validation baseline are replaced; source bytes remain untouched. CLI and desktop use this same service boundary.

Every open `Library` also holds a shared operating-system lease on `locks/library.lock`, acquired before SQLite initialization and retained by every clone. Whole-library transfer must acquire that lock exclusively, so it cannot proceed while a current CLI, desktop, or launch supervisor owns the library. Per-port locks remain the normal concurrency boundary between independent games.

`portability` owns the versioned metadata document and its export policy inside core. It uses the library's existing source/install readers inside one SQLite read transaction, with typed settings and history. It exports identities and references, not payloads or credentials; managed paths become relative and the four content categories remain explicit. A metadata file is published from a flushed private sibling file without replacing an existing destination. CLI and Tauri only translate output choices and native picker results.

`library_transfer`, `transfer_copy`, and `library_move` own move planning, copy verification, and authority transitions respectively. An exclusive source lease excludes every current client and launch supervisor. The reviewed plan binds metadata and each managed file's hash, detects portable-path collisions and unsupported entries, and budgets destination space. A versioned journal precedes its identified activity, so interruption before activity creation is recoverable. The original library receives a pending authority marker before copying. A newly created destination holds an exclusive lease and a pending marker while files are individually published without overwrite and SQLite is snapshotted with `VACUUM INTO`. Copied paths are rebased; active, previous, and staged identities remain unchanged. Source and destination inventories, logical metadata, database integrity, and all immutable install manifests are verified before a destination receipt is written.

Publication records the source as moved before clearing the destination's pending marker. Normal library opens follow only matching receipts, stop at pending transfers, and bound relocation chains. Recovery after activation only finalizes bookkeeping; it never copies old data over a destination that could have received new saves. Abort before publication removes the original's gate and retains the incomplete destination under its gate. Neither operation deletes either data tree. Pending transfer activity remains running with an explicit recovery journal, then becomes succeeded or failed on completion or abort. Flushed files and directory synchronization support Linux process/power-loss recovery; Windows/macOS retain process interruption recovery without a directory power-loss guarantee. Tauri owns only the temporary handoff of its cached library/provider handles and reopens the root selected by core. This changes no durable domain ownership or crate dependency rule.

## Library imports

Library import reads a metadata export and an explicitly selected copy of its four content trees without opening or migrating the input database. The destination must be new or contain an empty Portcove library; merging into existing domain state is rejected. Core reviews capacity, portable paths, source references, and active/previous/staged identity, then requires the content-bound plan again under an exclusive destination lease. A bounded destination-owned import journal is also the open gate and is published before database initialization or copying. Metadata hydration uses one SQLite transaction and the same source/install writers as ordinary registration. The shared transfer verifier checks all copied bytes and manifest identities; import additionally rebuilds the current platform executable, mutable-path, and critical-file policy for comparison with each restored manifest. This establishes consistency with a trusted local backup, not independent publisher authenticity for that backup.

Only a verified import changes its journal to published and becomes openable. Recovery after publication finalizes bookkeeping without reading offline input or replaying old saves. Terminal activity is idempotent, and an interrupted abort cannot later publish as success. Completed journals move under recovery so normal opens do not parse a full historical inventory. CLI abort preserves and gates an incomplete destination; a subsequent import uses another empty root. Desktop Settings restores into the currently configured empty library, releases cached handles for the core operation, obtains native confirmation of the trusted backup and destination, and reopens the same root. Original source references retain their locations and must pass current profile validation or explicit relinking before use. There is no new crate boundary or parallel library authority.

## Source discovery

Core owns opt-in discovery requests, traversal and hashing budgets, candidate validation, and explicit acceptance. Search requires selected roots and profiles; it does not infer personal folders. It skips symlinks and entries outside the canonical selected roots, filters extensions and size before hashing, bounds traversal and hashing, and shares original-file/cartridge-ZIP identity validation with manual registration. Equal source contracts share a hashing pass. Only profiles with exact published hash identities are automatically matched; disc conversion, folder sets, and upstream-validator handoffs continue through manual selection. Results are candidates, never registrations. Acceptance runs current validation under the existing source/dependent-port locks and compares the reviewed normalized digest before writing the registry. CLI and Tauri expose this core operation; React holds only the selected search scope and transient result list.

## Install transaction

1. Validate catalog, channel, platform, and required source reference.
2. Query the declared GitHub or GitLab game upstream, or a reviewed pinned direct manifest, and enforce its lifecycle policy.
3. Select a platform asset and require a SHA-256 digest or checksum sidecar.
4. Create a durable SQLite intent tied to the activity UUID, then download into a same-volume operation-specific staging directory.
5. Enforce the declared compressed size and global download ceiling while streaming, then verify SHA-256 before extraction.
6. Preflight the complete ZIP or TAR before writing. The shared release/toolchain policy accepts regular files and directories only; rejects traversal, links, special files, duplicate/case-folded paths, Windows device names, alternate-data-stream separators, trailing-dot/space aliases, unsafe Unicode, and file/directory collisions; and bounds compressed bytes, expanded bytes, entry bytes/count, compression ratio, path length/depth, and required free space. On Unix, core reduces archive mode metadata to executable intent: directories and executable files become `0755`, data files become `0644`, and ownership plus setuid, setgid, and sticky bits are discarded. Windows extraction behavior is unchanged.
7. Resolve the executable only from catalog-qualified safe-relative hints. Exact paths bind one file; legacy basenames must have exactly one case-insensitive match and ambiguity fails before publication. Hash immutable files into a schema-5 manifest bound to port, install, display version, artifact, target platform, selected executable, executable intent, and critical-file identities; then record the `prepared` postcondition.
8. Atomically claim the vacant version path without replacement, record `payload_published`, commit activation or staging metadata, and record `metadata_committed`. A late destination remains untouched and blocks recovery until the conflict is explicitly resolved. On Windows, a just-exited process, indexer, or scanner can briefly retain a handle that denies renaming its parent directory; publication waits up to two seconds only for the corresponding access, sharing, or lock errors while rechecking that staging still exists and the destination remains vacant. Persistent errors retain private staging and report the exact operation paths and operating-system code for recovery.
9. Remove only the operation-private staging tree. Failed cleanup remains `cleanup_pending` for retry; completed journals are removed because the activity ledger owns terminal history.

Adoption uses the same publication state machine and never copies into a final version path directly. Its first step recursively hashes every regular file into a deterministic copy plan, preserves empty directories, and reports symlinks or special entries that will be skipped. The reviewed plan fingerprint is authorized for five minutes and one use; core recomputes it under the port lock and verifies the private copied tree before activation. Persistent data is taken from that verified private copy, never from a source path that can change after copying. Removal runs the publication state machine in reverse: every registered managed version is renamed under `recovery/<operation-id>/` before SQLite metadata is deleted, then quarantine cleanup is retried. Port removal, backup restore, backup deletion, adoption, and source-reference removal all consume action-, target-, and state-bound core authorizations. Desktop issuance occurs only after a native backend-owned confirmation dialog; renderer state cannot authorize a destructive command. Backup and installed-game removal also provide detailed custom reviews before this final confirmation. Core still revalidates the selected action and reviewed state under its operation lock. Startup advances only recorded states whose payload, manifest, and path layout are unambiguous. It never deletes an untracked final directory. The read-only doctor repair plan reports incomplete journals, cleanup-pending trees, registered paths that are missing, and orphaned final directories with proposed review actions.

Staged activation and rollback collect user data from the version being deactivated only when its per-version launch marker proves it has actually run, then change active/previous pointers transactionally. The same guard applies before install, update, removal, and retained-version reuse, so a verified but never-launched release cannot propagate absent files as user-requested deletions. Adoption copies files into a new managed version and leaves the source directory untouched.

Backup restore publishes its verified canonical snapshot, then synchronizes the declared persistent paths in every registered version before completing the journal. This also removes files absent from the restored snapshot and clears stale launch markers. Active, previous, staged, and retained versions therefore cannot overwrite a restore at the next launch, rollback, activation, or save collection. This costs a bounded pass over each existing managed version; missing versions remain repair items, and unsafe paths fail without following links. Interrupted synchronization is idempotently retried from the published canonical data. Launch and save collection reject an unfinished prepared or published restore, including when the same service instance remains alive after failure. The automatic safety backup preserves the pre-restore canonical data.

Restore consumes its one-use, action/target-bound authorization under the port lock before expensive save collection and fingerprint recomputation. Expiry is an admission deadline; an admitted operation can finish hashing a large tree. The current backup/data fingerprint must still match the reviewed state before any restore publication. Expired or mismatched tokens never begin that work, and changed state consumes the grant and requires a new review.

When an update resolves to an artifact already present in the managed library, Portcove compares the verified digest, asset name, and size rather than the display tag. A republished stable, beta, rolling, or direct-manifest tag therefore remains visibly the same version while becoming a distinct update and content-addressed install. Before active/staged/retained reuse, activation, rollback, recovery, or launch, Portcove validates the manifest identity and rehashes the selected executable plus immutable libraries and bootstrap configuration beside it. The same targeted check enumerates the executable directory and rejects new unmanifested libraries, launchers, scripts, loader configuration, or symlinks before a child can be created. Catalog-declared mutable paths and exact generated metadata remain explicit exclusions; explicit full verification checks every other immutable file and rejects unexpected immutable additions.

The desktop process shares one release provider across Tauri commands. Successful release and asset selections are cached in memory for five minutes, but every reuse first revalidates current GitHub or GitLab repository metadata; an observed archive rejects the cached selection, and a temporary network failure remains a network failure. Provider JSON is streamed under a 4 MiB per-response limit and parsed before it may replace the library-scoped SQLite conditional cache. `ETag` and `Last-Modified` requests therefore reuse only the last semantically valid body on `304 Not Modified`. Provider metadata redirects are rejected; unauthenticated checksum downloads may follow at most five redirects and are streamed under a 1 MiB limit. GitHub and GitLab release discovery reads at most ten 100-item pages. GitLab package discovery reads the same maximum, then checks at most sixteen packages whose version matches the selected release, with four package-file list requests in flight and at most five 100-file pages per package. Equally scored runnable assets or package links fail as ambiguous, and an aggregate checksum file must name the exact selected asset; only its exact `.sha256` sidecar may contain a bare digest. Core bulk update checking admits at most four provider resolutions at once, returns results in the caller's order, records each activity independently, and never retries a rate-limited item implicitly; CLI and Tauri only translate those outcomes. React generation-gates overlapping refreshes and tracks pending commands independently, so reverse completion cannot replace newer data or clear an unrelated busy state. Gamepad navigation is scoped to the top modal and a single Back stack closes command palette, adoption, then port detail in visual order. A top-level render boundary reports the component failure to Tauri and presents a reload surface without claiming domain failure. If library opening, migration recovery, or release-provider construction fails, Tauri keeps a typed failed bootstrap state: every domain command returns that error and React shows a retry/recovery surface without exposing library actions.

React retains the latest event for each active operation and its available
ancestor context, plus at most 32 other recent terminal events. Retained
identities reject stale sequence delivery and cannot return from terminal to
progress state. Finished ancestors leave the protected context when their last
active descendant finishes. The current progress surface prefers active work to
newer terminal notifications, so a completed child does not hide its ongoing
parent. Retention uses event timestamps with deterministic ties rather than
arrival order. This library-workspace-scoped cache is presentation only: a
workspace remount clears it, and the core activity ledger and recovery state
remain authoritative for completed, interrupted and failed operations. Evicting
an event never removes durable history or declares recovery successful.

Tauri writes structured JSONL diagnostics under `logs/`, rotates at a bounded size, retains five generations, and appends across restarts. Sensitive structured field names and common inline credential forms are redacted before persistence. Operation events are logged with their core operation and parent IDs. A user-requested support ZIP re-redacts the retained logs and adds only readiness summaries and recent activity metadata; it does not include source payloads, credential storage, cached response bodies, or the SQLite database.

Disk-heavy desktop commands run on Tauri's blocking worker pool. Entire mixed async/core operations such as planning, update checks, install, update, and reconciliation enter a worker before constructing the service, then drive their network future from that worker; source hashing, manifest verification, managed-tree copies or removal, adoption, backup review, rollback, activation, folder integration, and launch preparation never occupy the IPC event loop. Cancelling an IPC waiter does not asynchronously kill an in-flight blocking mutation: the worker finishes under the core lifecycle journal and lock, while the durable activity/result remains available after refresh. Their command names, structured errors, and core-service safety boundaries are unchanged.

## Cooperative operation cancellation

Cancellation belongs to core and uses the existing durable activity UUID. SQLite migration 10 adds optional preparation/finishing state, a request bit, and a service-owner identity to activity history. Each controlled activity holds an OS lock for its lifetime; another process may request cancellation but cannot mistake a live worker for an orphan. Source discovery, update checks, install, update, and reconcile opt in. The CLI signal handler targets only its own service's running and queued work; Tauri forwards a specific activity UUID. Presentation never declares an operation cancelled merely because a request was accepted or an IPC waiter disappeared.

A conditional SQLite write serializes cancellation against the end of preparation. Requests accepted before that boundary stop at cooperative checkpoints. Network waits, download reads, and source/download hashing check between bounded steps. Blocking extraction, conversion, setup, and managed builder steps are allowed to finish atomically before their next checkpoint; their workers are never abandoned. Install closes cancellation before recording the recoverable `prepared` intent. Retained/staged activation closes it before collecting data or changing pointers. Launch uses the same activity UUID and closes cancellation as its final pre-spawn action; hashing checks incrementally, and conversion, setup, mutable-data synchronization, manifest refresh, and source revalidation each check before the child boundary. A CLI signal before that boundary requests durable cancellation; after it, the signal is forwarded to the child process group. Publication, restore, migration, and library transfers remain outside the cancellable region.

Accepted install cancellation removes only its identified private staging tree and intent; failed private cleanup is retained for review without permitting publication. Startup holds the activity and port locks before recovering interrupted preparation and preserves canonical user data. Prepared or published work follows the existing lifecycle recovery path. The activity ledger records a distinct `cancelled` terminal status before cancellation is returned, and schema-2 operation events distinguish it from success and failure. CLI API schema 6 exposes cancellation state, request results, and error/exit code `cancelled`/130. No second durable operation authority or crate boundary is introduced.

## GitHub trust and discovery

Portcove works anonymously, with a token supplied by the host process, or with a user credential held by the operating-system secure store. Environment credentials take precedence so launchers and managed deployments remain deterministic. Neither tokens nor device-flow access codes enter the library database, cache, structured output, logs, release downloads, or launched-game environments.

Device authorization uses a public GitHub App client ID and stores the resulting user token only after GitHub validates it. A personal token follows the same validation and storage path. The GUI and CLI expose authentication status and rate-limit metadata without exposing credential material.

A 401 response when checking an existing credential returns an unauthenticated status with its original credential source and device-login availability. The credential is not deleted or silently replaced. This keeps reconnect/logout available after a saved sign-in expires or is revoked; environment-managed credentials instead explain their external replacement boundary. Other network failures remain errors, and authenticated release requests that receive 401 provide an actionable sign-in message.

Authentication does not grant webhook access to arbitrary upstream repositories. A future optional Portcove update relay may combine webhooks from cooperative upstreams with one centralized conditional poller and publish signed advisory catalog events. Local polling remains authoritative and available without an account or relay; every event must still pass normal repository, channel, asset, and checksum validation before installation.

RetComM is not a Portcove release provider. Its title catalog is used only by a CI audit to confirm that PS1 entries still name the same direct per-game repositories. The RetComM launcher cannot satisfy a game release request and is explicitly rejected by catalog validation. `retcomm-toolchains` is a separate checksum-pinned build dependency used by the shared PS1 adapter.

## Adapter boundary

Adapters describe recurring families rather than individual games: libultraship portable releases, N64 recomp portable releases, staged-source portable releases, referenced-disc ports, generated-cache ports, upstream-managed setup, and managed PS1 recomp builds. Port-specific facts stay in `catalog.json`: repository, channels, platform availability, source profile, executable hints, launch behavior, persistent paths, and optional runtime subdirectory and source paths. Source profiles may use exact SHA-1, SHA-256, file-set CRC32, reviewed PS1 ISO-volume allowlists, or a tightly bounded upstream-validator handoff so Portcove can enforce the strongest identity form an upstream actually publishes while continuing to record SHA-256 in local state. A declared runtime subdirectory keeps working-directory, portable-marker, and stored-source behavior inside a stable nested release layout without port-specific code. Runtime source materialization is limited to reviewed generic operations: N64 byte-order normalization, bounded exact copy or ZIP-member extraction, GameCube or PS2 ISO conversion, single-disc PS1 CHD expansion to a multi-BIN/CUE directory, multi-disc PS1 CHD expansion to numbered raw data tracks, and read-only LIVE/STFS extraction into a new directory. STFS extraction validates a bounded ASCII path table, rejects traversal, case collisions, cyclic or out-of-range block chains, caps depth/count/expanded bytes against available storage, and publishes only after declared inner-file SHA-256 checks pass. File replacements and directory swaps preserve the prior destination until the staged replacement is ready; schema-2 source sidecars bind reuse to the current storage SHA-256 and size instead of path metadata, forcing restaging even when changed bytes retain the same path, length, and timestamp.

Catalog entries may add fixed launch environment values and one dynamic user-data environment variable. Validation rejects session-critical, Portcove-owned, credential-shaped, duplicate, multiline, or empty values before a process is constructed. The dynamic value always resolves to the canonical per-port library user directory; fixed values express an upstream selector or disable an upstream updater that would otherwise compete with Portcove's verified lifecycle. Reviewed nonpersistent paths created by staged-source or upstream-setup runtimes remain catalog-owned integrity exclusions and cannot overlap persistent data.

The upstream-managed setup adapter runs only a checksum-verified executable selected by catalog hints, fixed reviewed arguments, and the normalized registered source. It requires a concrete safe-relative marker before producing a game launch specification. Its private setup metadata binds that marker to the staged source SHA-256 and size, so a changed registration reruns validation rather than reusing another disc's output. After setup and the final original-source identity check, the installer rebuilds the immutable manifest over the generated application data, publishes the new manifest bytes, and updates only that exact install record before the child starts. A database-commit failure restores the prior manifest bytes and fails closed. Catalog-declared `runtime_mutable_paths` identify narrowly reviewed, nonpersistent files that the upstream runtime creates inside this generated tree; they are excluded from immutable verification and backup ownership without becoming executable or source exceptions. The service writes its first-success marker only after all adapter preparation succeeds, so source rejection, partial extraction, or manifest-registration failure cannot be reported as a completed launch.

The managed PS1 adapter downloads a platform-specific, fixed-version toolchain asset, verifies its declared size and SHA-256, and extracts it through the same bounded archive policy into Portcove's private toolchain cache. Its schema-2 marker binds the pinned artifact to the current bytes of bundled Python, CMake, Ninja, and toolchain metadata; cache reuse fails after any critical-file change. It invokes only the reviewed `generate` and `rebuild` commands with toolchain downloads disabled; it does not execute arbitrary catalog scripts. CHD extraction for identity checks is temporary. A title may declare a second exact BIOS source profile; it is validated and recorded independently, supplied only to the reviewed generator, and the staged raw dump is removed after backend generation. By default, the installed runtime mounts the verified original CHD path and Portcove rewrites that path from the registered source before each launch. Reviewed runtime-generated diagnostics may be cataloged as nonpersistent mutable paths, but they cannot overlap an executable, source materialization, or persistent user data. A cataloged multi-disc title whose runtime cannot read CHD may instead request an immutable numbered raw set during installation. Portcove transactionally extracts all discs, verifies their aggregate normalized identity and size against the registered source record, retains deterministic cue descriptors, writes relative cue paths into the manifest-covered base configuration, and includes every cue and raw track in the critical installation manifest set checked before launch. The original CHDs remain authoritative and are also rechecked before launch. After immutable verification, launch preparation derives one exact core-owned runtime configuration with absolute cue paths for upstreams that cannot resolve relative paths and pins the runtime's memory-card directory to the catalog-owned persistent `saves` path; it never rewrites or regenerates the immutable raw set. Generated compiler intermediates and any unrequested expanded disc files are pruned before activation.

V1 deliberately avoids automating arbitrary build scripts or installers. A new adapter is warranted only when several active projects share a deterministic, reviewable workflow.

## Child-process boundary

`portcove-core::ChildProcessPolicy` is the single construction path for every production child process. Callers select a typed class for games, upstream setup, host tools such as `chdman` and DolphinTool, managed builders, or operating-system integration. All classes begin from the same reviewed session allowlist rather than inheriting the complete Portcove environment. The allowlist preserves cross-platform process discovery, profile/home, temporary-directory, locale, desktop/display, audio/graphics, Steam/Proton, Wine, and dynamic-runtime variables needed by native ports. GitHub variables and other credential-shaped token, secret, password, API-key, cloud-key, SSH-agent, and askpass variables are removed centrally. Catalog/adapter overlays are checked by the same policy and cannot reintroduce a credential-shaped variable.

Manual host-tool selection crosses that policy only through the core registry's fixed probe. Core rejects nonregular files, symlink paths, scripts, and executables that do not satisfy the host platform; fingerprints the candidate before spawn; rechecks it immediately before and after the probe; supplies only registry-owned arguments; and bounds executable size, combined output, and elapsed time. Timeout, cancellation, and excessive output terminate the probe process tree. A path and SHA-256 fingerprint are published atomically to host preferences only after the expected tool identity and required command markers appear, so failure preserves the previous valid selection and a later byte change becomes `misconfigured`. This fingerprint binds the saved choice to the probed bytes; it does not establish publisher authenticity or prove arbitrary software safe.

Core also owns the fixed host-tool registry and resolution order. Each definition fixes its stable ID, display name, supported platforms, official HTTPS reference, and bounded probe policy. Resolution is environment override, saved host preference, reviewed discovery, then missing. An invalid environment or saved path is reported as misconfigured and blocks lower-priority fallback. Tool paths share the versioned host-preference document outside the movable library; changing them does not modify a library or source tree.

Native game executables receive catalog-owned arguments plus literal caller arguments. Windows `.bat` and `.cmd` launchers are represented as `WindowsBatch`; caller arguments are rejected, and fixed catalog arguments pass a strict metacharacter check before the implicit `cmd.exe` boundary. Setup tools, validators, builders, conversion tools, and host integration require native executables. `scripts/check-child-process-policy.mjs` prevents a production adapter from reintroducing direct `Command::new` construction outside the core policy.

Supervised native games run in their own process group. The CLI intercepts Ctrl-C and, on Unix, termination. Before child creation it durably cancels its known request ID; if the core has already closed cancellation, the CLI forwards the pending signal after the exact child is recorded and continues waiting so core can complete exact-install save collection. A nonzero exit or signal is a failed launch outcome and never advances successful-launch history, but it does not skip collection. The desktop supervisor is detached from the UI process and uses null standard streams; closing the window therefore cannot become a save-lifecycle decision. Desktop completion observation queries only its exact request primary key and emits one refresh after the durable terminal outcome; it never polls the complete launch-session table per launch.

Game release-channel choices come from catalog/provider classification, not title
or release-name words. A single available channel is read-only in Desktop; multiple
channels use the existing accessible choice dialog. Core rejects unsupported
choices and persists settings under the per-port lock. Desktop binds channel
saving and release checks to the selected library generation, refreshes metadata
after a successful change, and distinguishes a saved choice from a failed release
refresh. Changing channel does not install or activate a version. Current channel
identity invalidates old install/update reviews and mismatched update snapshots.

Desktop install and adoption reviews are ephemeral, generation-bound presentation state. Port/channel changes invalidate install plans; adoption path, target, dialog closure and newer reviews invalidate copy previews. Late results and request errors cannot replace newer review intent, and an older adoption completion cannot close a reopened dialog. Core still revalidates the content-bound adoption plan before copying.

## External frontend contract

The CLI is the integration boundary. Consumers should probe `capabilities`, including `product_version`, `failure_isolated_batches`, and `port_operation_locking`, use `--json` for request/response automation or `--jsonl` for progress streams, select an explicit library, and launch through `exec`. `catalog export` supplies the complete versioned port and source-profile document, `activity` supplies a bounded, newest-first durable ledger for frontends that need recent results without replaying progress streams, and `storage` reports the resolved root and containing-volume capacity. `plan` combines release resolution, retained/staged version discovery, registered requirements, and capacity into a typed preflight without changing installed state. `paths` exposes canonical persistent-data and managed-version roots so backup tools do not depend on private layout conventions; `backup create`, `list`, and confirmed `restore` provide a first-party snapshot lifecycle. Bulk check, reconcile, and update operations isolate every installed port; bulk source verification isolates every registered profile. Frontends must inspect each nested outcome rather than treating a completed batch as proof that every item succeeded. `catalog export`, `source verify --all`, `activity`, `storage`, `paths`, `backup list`, and `exec` are network-free; backup create/restore are also network-free but copy local data, `plan` may make a conditional release request, and launch inherits the child's standard streams and exit code.

The CLI's `schema export` is library-free and is also the transport authority for the desktop. The deterministic transport-contract gate compares the Rust schema with TypeScript DTO field names, catalog adapter values, common enums, and event variants before either adapter can ship. Filesystem paths are deliberately narrower than native Unix paths in V1: any path crossing durable serialization or a child-process string boundary must be Unicode, and an unrepresentable path is rejected as unsupported rather than lossily rewritten.

## Signed catalog authority

`portcove-core` owns Ed25519 verification, explicit public-key trust, bounded delivery, catalog admission, replay protection, effective selection, and provenance. SQLite migration 11 stores at most 16 public trust keys, the active and previous bounded envelopes, a monotonic highest accepted sequence, and selection revision. One read transaction captures trust and selection consistently. One write transaction publishes the reviewed candidate, advances replay protection, and completes its activity; an interrupted transaction cannot leave a successful catalog without its terminal result. CLI and Tauri only collect consent, translate commands/events, and call core; architecture metadata forbids an independent Ed25519 verifier in either adapter.

Each service command captures one validated catalog and its matching provenance. No startup network fetch occurs. Current trust, strict signature validation, expiry, and the normal catalog validator are checked on every load: active, then a valid previous snapshot, then the embedded baseline. `doctor` reports the provenance actually used by that command; catalog status reports the current selection. An explicit rollback does not lower the replay floor. Selecting the embedded catalog preserves cached updates, and selecting cached metadata revalidates it without admitting an external replay.

Delivery format 1 deliberately freezes the embedded V1 ID set, source profiles, executable/setup/source-materialization contracts, and persistent-data ownership. It permits presentation, release resolution, platform/channel/support metadata, and upstream status updates. Adding/changing a lifecycle contract requires a Portcove application update. This keeps import planning/recovery's embedded safety-contract checks equivalent to the active catalog's contract and prevents expiry or metadata rollback from changing save ownership. A managed library move copies this public trust/replay configuration with SQLite; metadata-only export/import excludes it, so a destination explicitly configures its own trust. No private key or account credential is stored in the catalog database. Publisher infrastructure and custody remain external choices; optional relay events and desktop self-updates are separate contracts.

## Immutable bundled runtimes

`portcove-core::runtime` validates a catalog-declared, checksum-pinned runtime archive for every supported platform. `Installer` owns preparation and publication: the game archive and runtime use the same bounded download, hash, checked extraction, private staging, cancellation, manifest, and journal path. A runtime occupies one otherwise vacant directory in the game working directory; its target and executable cannot overlap source preparation or persistent data. No new crate, durable store, adapter domain authority, or executable downloader is introduced. The existing build-time PS1 toolchain cache retains its separate lifetime; game runtimes belong to each immutable version because they must roll back with it.

SQLite migration 12 adds one optional runtime identity to install rows and invalidates derived update snapshots. The identity records verified-download or explicitly adopted-tree origin, artifact digest/size/name, archive root, mount directory, and runtime executable. Managed storage keys bind both game and runtime identities, while runtime-free installations retain their existing keys. Active, staged, retained, and update decisions compare both identities. Schema-5 manifests bind the runtime identity and actual relative root together with the target platform and executable intent; schema-2 through schema-4 manifests remain readable under the contracts each version originally recorded. Every manifest-tracked immutable game and runtime file is critical, including Java archives and extensionless module data; launch rejects altered, missing, or additional runtime files. A legacy install without the required runtime is blocked before child creation, and the desktop routes setup to a reviewed update.

Adoption requires the complete runtime in the reviewed copied tree and records its own manifest-derived tree digest, never a vendor archive claim. Metadata format 1 carries this additive optional identity and preserves it through move/import; the manifest schema prevents older clients from silently accepting runtime-bearing installs. Import validates the current mount/executable and immutable-file policy but permits an older pinned runtime artifact so restoring or rolling back cannot silently upgrade executable bytes. Existing legacy mutable runtime copies remain in their original retained install or user directory; the new catalog contract never restores them over the verified runtime. API schema 8 exposes the combined download plan and runtime identity; event schema remains 2.

Install qualifications identify exact core-generated source/portable metadata paths as mutable integrity metadata. These paths are derived from the existing adapter naming contract, remain separate from persistent user data, and cannot overlap a bundled runtime. Managed verification and transfer also recognize those exact paths in older manifests without rewriting the manifest or exempting any tracked immutable bytes. There is no wildcard exclusion for source-marker-like filenames.

Post-exit collection compares canonical install and versions-directory paths after refusing symlink ancestors. This preserves the managed-directory boundary across relative library paths and Windows extended paths introduced by a verified move. Persistent files are reused only when both size and complete SHA-256 match; equal timestamps never establish equal content.

Persistent-data synchronization skips a redundant file copy only when lengths and complete SHA-256 content match. Timestamps alone never authorize reuse, and a same-size changed save still replaces its collected copy. Existing ancestor checks, port locking, and deletion propagation remain in force.

ZIP entry names from Windows producers are normalized from DOS separators to forward slashes before the shared portable validator and collision inventory run. This is one platform-independent output namespace: mixed-separator aliases collide, and traversal, drive/UNC roots, reserved names, links, special files, and resource limits still fail before extraction writes. Catalog and TAR paths retain their forward-slash requirement.
