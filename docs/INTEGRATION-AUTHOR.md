# Build an external Portcove client

Build against the public CLI, its exported schemas and one explicitly selected
library. Core owns admission, plans, consent-bound execution, lifecycle state and
recovery. The client presents that authority; it does not read SQLite or infer
permission from a catalog flag.

| Stage                 | Use this recipe                                                   | Required observation or boundary                                                                                 |
| --------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Choose inputs         | [CLI and fixture library](#choose-a-cli-and-fixture-library)      | Verified artifact, host prerequisites and an explicitly owned library.                                           |
| Discover              | [Capabilities, schemas and identity](#discover-and-bind)          | Supported commands/versions, actual library ID and unknown-value handling.                                       |
| Inspect               | [Public requirements and current state](#inspect-before-planning) | Catalog requirements, current readiness and stable blocking reasons.                                             |
| Plan and authorize    | [Optional management](#optional-management)                       | Exact supported plan, disclosed consequences and the matching operation's consent.                               |
| Observe and reconnect | [Launch and reconnect](#launch-and-reconnect)                     | Authoritative terminal result and retained/current readback; lost output is not success or permission to replay. |
| Diagnose              | [Troubleshooting](#troubleshooting-and-conformance)               | Actual failure, mutation state and advertised operation-specific recovery.                                       |
| Hand off              | [Evidence and continuation](#evidence-and-continuation)           | Exact artifact/library/target/operation, observed result and next permitted action.                              |

See the [domain glossary](../GLOSSARY.md) for current and proposed terms, and the
[content-design contract](CONTENT-DESIGN.md) when presenting these distinctions.

The [Playnite reference](../integrations/playnite/README.md) is one external
consumer. Its protocol and process files are examples, not a general SDK or
permission to copy core lifecycle rules. See [integration ownership](INTEGRATIONS.md)
and the complete [CLI contract](CLI.md).

Choose only the capability level the client needs. A launch-only client binds
identity, readiness and supervised launch; library integration adds stable entry
discovery/refresh; lifecycle integration adds explicit management, progress and
recovery. A basic launcher is not required to implement every management command.
Negotiate the operations and schemas actually used, and keep unsupported higher
levels unavailable rather than accepting consequential data the client cannot
interpret.

## Choose a CLI and fixture library

1. Choose the standalone CLI for the actual operating system and processor from
   the [download guide](DOWNLOADS.md). Follow the selected release's checksum
   manifest; Desktop and GitHub Source code archives are different deliverables.
2. Check the artifact's available capabilities before designing its client.
   Published Alpha 2 exposes API 34. It cannot run this guide's schema-42 identity
   and launch-request path or later reviewed management. Do not silently substitute
   that preview for a compatible artifact.
3. For current development, reuse an exactly identified compatible candidate
   through the [maintained packaging route](RELEASING.md#standalone-cli-integration-artifact).
   Retain source commit, package and extracted-executable SHA-256, host prerequisites
   and the capabilities actually read. A local release-profile build can retain an
   Alpha 2 product-version string while exposing newer APIs; it is still a local
   candidate, not the historical published package. The final published-client
   claim must identify an available compatible released artifact.
4. Select a disposable fixture directory or a library explicitly chosen by the
   player. Pass `--library` on every invocation, including readback and recovery.
   `library show` inspects selection without opening the library; `library identity`
   can initialize an empty root and records the resulting identity. Never fall back
   to the operator's default library to make a fixture pass.

Use the [reference client's redistributable fixtures](../integrations/playnite/README.md)
and [representative source-built checks](#representative-source-built-developer-checks)
when their scope fits. They need no personal game data. The
[completed packaged-agent evidence](archive/2026-10-11-packaged-agent-consumer.md)
records the exact Windows/Linux candidates, synthetic inputs, isolation and
limitations used for #1499. Reuse those accepted results at their recorded scope;
an unchanged documentation task does not require a new package build or replay.

## Channel compatibility

API80 adds explicit user-selected external execution intent and reusable managed
runtime policies. User-selected registrations are distinct from exact accepted
package certification: use Core's selected executable/working-directory/argument
review and consent, then supervised launch and registration-only removal. Never
invent package authenticity or managed update/backup/rollback/delete rights.
The Playnite reference launches/removes retained registrations, and directs new
user-selected setup to Desktop or CLI; it does not parse build internals. Unknown
trust values, required capabilities and future API versions remain refused.
See [the CLI flow](CLI.md#using-the-cli) and
[retained consumer commitments](reference/upstream-first-compatibility.md).

Game-port release channels display as **Stable / Preview / Rolling**. Current game-port CLI inputs prefer `stable` / `preview` / `rolling`; `beta` remains a compatibility alias for `preview`. Both Preview spellings select the same existing stream. Canonical JSON, catalog, installation and preference values remain `stable` / `beta` / `rolling`; no serialized `preview` value or saved-choice migration is introduced. Copied commands and integrations may retain `beta` when the intended CLI's Preview input support is unverified, preserving supported older consumers. Changing the spelling does not select a different release. Offered channels, the selected stream and the actual upstream release are separate facts. Preview prefers eligible prereleases and can fall back to an eligible stable release; that fallback does not acquire an upstream Beta/Alpha designation. Original upstream tags/names, application Public beta milestones, qualification evidence and compatibility limitations retain their own meaning.

New independently delivered fresh Sonic 3K, Sonic 1 and Mega Man X2 managed
recipes require staged-source capability version 25 for their canonical-data
isolation. Emit a requirement with minimum 25 and a compatible inclusive upper
bound; older readers must refuse rather than apply the new recipe to retained
data. Existing exact old Direct readers and retained projections keep their
creating contracts. See [the definition contract](DEFINITION-DELIVERY.md#implemented-engine-capability-negotiation).

## Discover and bind

Agents use this same public route, with an identified verified CLI and explicit
fixture or player-selected library. Inspect capabilities and output/event schemas,
then requirements/readiness, review the supported plan, execute only within its
matching consent, and inspect the terminal response and current state. Use the
management and reconnect examples below; do not invent a command or per-port
rule when a public answer is missing. Report that gap to its current owner.

After lost output or interruption, inspect retained activity and current state
before selecting another mutation. `doctor` and `status` reads do not perform
recovery. Use only the operation-specific recovery actually advertised. There is
no universal replay, exactly-once, detached-lifetime or resumable-preparation
contract. Setup, observed launch and gameplay/device qualification are separate
claims. Preserve unknown outcomes and share only selected redacted diagnostics.

The completed #30/#243 consumer evidence and existing redistributable reference
fixtures are reusable at their actual inputs and scope. An identified-agent
exercise is further evidence, not a reason to repeat every unchanged check or
claim an unattended service. Record artifact, environment, scenario, observations,
limits and a bounded continuation state through the existing evidence workflow.

Use the runtime's argument-array API with shell execution disabled. These are
program/argument objects, not shell command strings:

```json
{"program":"H:/candidate/portcove.exe","args":["--library","H:/fixtures/library","--non-interactive","--json","capabilities"]}
{"program":"H:/candidate/portcove.exe","args":["--library","H:/fixtures/library","--non-interactive","--json","library","identity"]}
{"program":"H:/candidate/portcove.exe","args":["--library","H:/fixtures/library","--non-interactive","--json","catalog","list"]}
{"program":"H:/candidate/portcove.exe","args":["--library","H:/fixtures/library","--non-interactive","--json","status"]}
```

Check the envelope's schema, command, `ok`, data/error and exit status. Negotiate
only the required command names and formats: launch-only needs JSON plus raw
`exec`, read-only library integration needs JSON, and lifecycle operations add
JSONL. The reference supports API 42–57, 60–63 or 65–85/events 2–3; schema 50 advertises
the event authority as `operation_event_schema_version`, while the historical
42–49 window retains its documented event-2 contract. Schema 51 replaces the
activity array with a feed whose protected ID sets and completeness fields must
be consumed by lifecycle clients; absence from bounded terminal history is not
evidence that work is absent. A visual preview may bound ordinary terminal rows
only after unioning every protected ID. A client that does not use
lifecycle events does not reject a runtime solely because it cannot interpret an
unused event channel. Tolerate additive object fields within the supported window
and reject unknown consequential enum values or a different used schema with a
migration message. Future client revisions should extend that window only after
matching fixtures and package tests. The product version is descriptive, never a
substitute for these checks. Export authoritative schemas with `schema export`.

API 65 adds explicit `source.query` game-file refresh, tracked as the existing
`verify_source` activity with a Library target. Its inputs select routes and resource limits;
inspection batches remain private to Core. The client does not invoke this
optional command and does not infer readiness from its game-file observations.
Private schemas 58, 59 and the retained unmerged 64 candidate remain rejected;
65 does not require that candidate's game-update review fields. Existing launch,
lifecycle and backup decisions keep their earlier contracts.

Schema 60 introduces retained rollback assessment in status. The reference
validates exactly one rollback decision per status against the envelope version,
including batched status, and presents its reason. Supported tuples are
`allowed/available`, `not_offered/not_installed`,
`not_offered/route_not_offered` when the port has left the current catalog, and `held` with
`missing_runtime` or `invalid_installation`; a definition decision cannot replace
these retained-target checks. Legacy envelopes cannot carry this action. The
supported membership excludes private paired schemas 58 and 59; accepting 60
does not imply support for every intervening integer. Event schemas stay 2–3.
No new client rollback command is exposed and no published package is inferred.

Schema 61 adds exact revoked-artifact and distribution-withdrawal reasons. The
reference consumes both through install/launch status and its management summary;
withdrawal cannot become a Launch hold. It admits only the exact revoked-artifact
rollback tuple described in the CLI contract. Contradictory outcomes, unknown
reasons and schema-61 meanings carried by older envelopes are refused, including
batched status. These source changes do not qualify an installed client update.

Schema 66 requires one current `update` decision in every port status. The
reference displays its stable reason, rejects absent/duplicate or contradictory
decisions, and rejects this meaning in older envelopes. A status decision cannot
be `allowed`: only explicit Core candidate review can report a usable update.
Non-owning routes remain outside managed updates. API and event windows remain
independent; this change does not alter events 2–3 or grant execution authority.

Schema 62 requires `create_assessment` on backup inventory. Consume the exact
`backup_create` availability/reason tuple before presenting creation. Schema 63
also requires `restore_assessment` with action `backup_restore`; consume its
current availability/reason separately from Delete. Missing, stale or failed
inventory reads do not establish Restore eligibility. An eligible snapshot still
requires exact review, fingerprint, consent and locked execution. Do not
infer it from whether an installation or a backup row exists. Retained owned
data and collectible managed saves are distinct from unknown external saves.
An incomplete bounded assessment cannot establish empty data or impose a new
backup execution cap. The reference validates this contract on `backup.list`
results, rejects it in older envelopes, and keeps private schemas 58/59 outside
its accepted window. Source parity remains separate from installed updates.

Backup inventory can additionally contain `protection`. Older responses may omit
it; omission means unknown protection details, not an empty backup list. This
optional descriptive output does not change the API version or any operation
eligibility. Consume current/retained/effective declarations and metadata-only
collection candidates separately from actual completed snapshots. Bind every
installation identity and the selected library before presenting facts as current;
retain stale/failed read states. `latest_completed_backup` is port-scoped history
with a valid manifest, not a fresh payload-integrity check or proof of game-save
compatibility. Current create/restore assessments and reviewed mutation protocols
still govern actions.

Runtime discovery is a trust boundary, not permission to execute the first file
with a matching name. Ask the user to select or approve a verified compatible
package, validate its documented identity/checksum before negotiation, and show
the effective library before any mutation. Reuse an intentionally selected
library; never silently create or fall back to another one. Separate libraries
remain separate identities. Desktop, CLI and plugins may be at different versions,
so each consumer must reject an incompatible shared-library protocol or required
operation without weakening core locking or migration authority.

`library identity` may initialize an empty library. Its opaque ID plus catalog
port ID forms the game key. Encode both components without delimiter collisions.
Use the active installation only as current display state. Update/rollback and
managed moves retain the game key; a supported import destination has its own
library ID. Recheck selection before operations, and reject keys belonging to
another library. Do not identify games by name, executable path or version.

## Inspect before planning

Read `catalog show PORT_ID` or the exported catalog for accepted original/BIOS
requirements and offered routes, then `status PORT_ID` for the selected library's
installation and current action assessments. `doctor` reports host/tool and
retained-recovery facts; it does not execute a repair. For registered game files,
`source inspect PROFILE_ID` distinguishes observed identity, unchanged bytes,
admission and scoped evidence. A source record is not a promise that the file is
still present, compatible with every release or authorized for installation.

Keep the stable port ID and library identity through the workflow. Select the
supported plan for the actual task: first managed installation, preparation of
an existing managed installation, reviewed external registration or another
advertised operation. Source registration, copy, move, game installation,
external-folder registration and launch have different effects. A missing
capability or unknown consequential value stops that action with an explicit
compatibility message; it does not justify a private API or a guessed command.

A launch-only client can stop after supported readiness and the launch route.
Library integration adds public entry/metadata discovery. Lifecycle management
adds the plan, authorization and outcome obligations below. Application updates,
game updates, catalog/definition updates and plugin updates retain their
[separate owners](INTEGRATIONS.md#update-ownership).

## Launch and reconnect

Generate a new UUID for an explicit launch decision and retain it before starting
the process. Invoke the same program with these argument arrays:

```json
["--library","H:/fixtures/library","--non-interactive","exec","shipwright","--request-id","19c66cf0-656f-4a02-9c0b-dba89767ab4e"]
["--library","H:/fixtures/library","--non-interactive","--json","launch","show","19c66cf0-656f-4a02-9c0b-dba89767ab4e"]
["--library","H:/fixtures/library","--non-interactive","--json","launch","recover","19c66cf0-656f-4a02-9c0b-dba89767ab4e"]
```

The UUID above is illustrative; never reuse it for separate real attempts. Read
core readiness before offering Play. Unknown gameplay evidence is not a client
launch blocker. `exec` launches the current installed version without network
installation and owns process supervision and exact-install save collection.
Its streams and exit code belong to the game: never request JSON for `exec` or
parse game stdout as management events.

Poll `launch show` at a bounded frequency. Null means absent/expired, not success.
Validate returned request and port identities. Distinguish observed child start,
last phase, terminal outcome and post-exit collection. `started_at` is request
acceptance time, not a precise child-start clock. Returned PIDs are observations,
not authority to terminate a process. A lost wrapper or reader cannot establish
successful gameplay or saved data. Core's retained request and activity are the
reconnect authority; the client need only retain a reference pointer.

Do not call `launch recover` while the recorded supervisor is live. After a
lost supervisor leaves an unfinished request, the explicit command delegates to
core's exact-identity recovery and returns the retained failed terminal record.
It may wait for the exact recorded child to exit. A spawning-phase ambiguity,
missing process-start identity, changed install, or live supervisor remains a
conflict requiring review. Recovery does not prove that a hard-killed game flushed
its own saves; it only performs the collection that core can verify afterward.

API78 introduced the closed `cvlod-n64-source-cb8548d145a1-ui-lifetime-v1`
recipe and N64 template version 3 without adding a command, input field or event
version. That creation route is now retired. New indexed definitions with
`release.managed_build` are refused even though N64 version 3 and the shared
Windows path capability 11 remain advertised. Private retained readers preserve
the identified installed runtimes and recovery contracts; they do not offer new
builds or require clients to acquire compilers. See
[retained consumers and retirement conditions](reference/upstream-first-compatibility.md).

Clients display Core's complete current plan, acquisitions and capacity when
offered, obtain its required consent and consume its action/readiness decisions.
They must not execute catalog build instructions or derive eligibility from a
historical recipe name. The maintained reference accepts API85 within its reviewed
42–57, 60–63 or 65–85 membership and event schemas 2–3; unknown future APIs,
unsupported required capabilities and unknown execution/ownership semantics
remain refused. API or template negotiation alone grants no admission or operation
authority.

API85 adds `source.reuse PROFILE_ID`: a read-only review of a saved registration,
its baseline, per-integration listed identity or potential/incompatible/unavailable
state, and remaining checks. Informational admission and its evidence gap remain
explicit; a shared profile does not authorize another integration's edition.
The Desktop's `review_source_reuse` binds the library generation. A returned
`SourceRegistrationReference` binds the saved record and applicable catalog
contracts; `InstallInput.sourceReference` requires the matching game-source
profile, a fresh reinspection and the existing source lock throughout execution.
It never registers an override or grants source, runtime or player-data ownership.
Older hosts cannot produce this new review; consumers must not fall back to an
unchecked installation when the command is unsupported. API/event/library and
retained-definition versions are independent. Existing API84 evidence stays at
its original executable/input scope. The Playnite reference retains its existing
operations on API85; it does not expose Desktop's new source-reuse chooser.

API79 adds the prepared `source_directory_environment` contract, requiring
staged-source template18. Core authenticates declared relative-file-set members,
rejects archive input for this launch route, and binds the selected directory
through the retained source environment variable. Launch consumers continue to
delegate readiness, source overrides, verification and process supervision to
Core; they must not reconstruct environment bindings or append arguments to this
fixed-argument route. The Playnite reference accepts API79 through the same Core
launch path. Negotiation and these generic fixtures do not admit a re:Blue runtime
or establish actual game operation acceptance.

## Optional management

Read `status <port>`, `catalog show <port>`, `catalog export` and `doctor` for
core requirements, source contracts and local tools. Keep eligibility, integrity,
publisher trust and scoped gameplay/platform evidence distinct. Unknown evidence
must not be promoted to passed or translated into a blanket refusal.

Use `--non-interactive --jsonl` for explicit `ensure`, `update` and preparation.
`ensure` can return an existing active installation; it is not a general setup
repair. Review `preparation plan`, then apply its fingerprint with
`preparation run --expected-plan <hash> --yes` only after showing the copy/source,
tool and preservation consequences. A stale plan needs renewed review. Source
registration and install/update are separate observable mutations; a later
failure does not imply earlier registration was undone.

Schema 71 adds optional `presentation.original_game_title` and `variant_label`.
These descriptive fields are not identity, grouping or eligibility authority.
Retain the port `id` and project `name`; use the latter as the display fallback
when older catalogs omit game titles. The reference Playnite reader puts the game
title first, retains project/variant labels and preserves separate library IDs.
Optional `presentation.manual_setup` supplies authored steps, essential warnings
and a safe HTTPS help link. The reference consumes these as numbered instructions;
older definitions retain their `manual_preparation` prose fallback. Instructions
are not completed-step evidence or operation authority.

Schema 70 adds optional release-scoped `source_assessment` and `bios_assessment`
alongside byte health, and the `incompatible_bios` blocker/action reason. Current
bytes alone do not confirm compatibility. Missing legacy facts remain unknown;
when Core permits launch, offer an explained trial rather than declaring the
input compatible or refusing it. Known input failures remain Core launch gates.
Process exits and launch counts do not establish gameplay.

Schema 68 adds the closed `ghostship200_legacy` preparation mode, paired only
with plan/receipt format 2. Unknown modes or mismatched formats require an
upgrade and renewed review. The reference Playnite client does not invoke
preparation plan/run/bootstrap; this additive mode does not expand its commands
or permissions. Reviewed retained-preparation cleanup remains available.
Its existing launch, lifecycle and reviewed external-runtime decisions remain
authoritative for the commands it does expose.

Schema 69 adds optional `backup.ghostship-legacy-plan` and
`backup.ghostship-legacy-recover` capabilities. The latter requires a selected
Core-qualified pre-transition snapshot, an unchanged reviewed plan and explicit
consent. `BackupActionPreview.retained_runtime_copy_will_be_deleted` must be
shown by backup-deletion consumers when true: deleting that snapshot also
permanently deletes its retained newer-runtime saves/settings companion.
Ordinary restore reads canonical `data/` only. Playnite invokes neither the new
compound recovery nor backup deletion, so accepting schema 69 preserves its
existing decisions without granting either operation. Event schemas remain 2–3.

API77 adds managed ReGaiden shared-preferences review and separate changed-scope
and inspection-unavailable guidance. The installation reader shows both resolved
paths and requires a separate confirmation before adding
`--acknowledge-shared-preferences` to the exact reviewed request. Generic `--yes`
does not accept this scope. The client refuses these new status reasons/blockers
inside older API envelopes. Account-wide preferences remain outside managed data;
see [the managed contract and recovery path](reference/managed-regaiden.md).

Current event records have **event schema 3 at the root**; they are not nested in API
envelopes. A final root record has `type: "result"` and a negotiated API
schema within the client's supported 42–57, 60–63 or 65–85 membership. Some
commands emit only the result. Track sequences per operation ID and parent IDs;
do not fabricate progress when a phase or event is missing. A valid terminal
result and matching exit status establish the command response; refresh core
state before claiming the requested installed state. Missing/reordered events,
malformed output, a missing final result or exit disagreement require readback,
never automatic mutation replay.

Event schema 3 adds `source_candidate` during source discovery. It carries an
exact matched `profile_id`, absolute `path`, SHA-256 digest, and byte `size`.
The event is provisional progress evidence; a completed discovery report or
saved-root scan snapshot and a fresh core import plan still govern registration.
Event schema 2 remains valid for clients paired with older CLIs. Negotiate the
advertised event version before consuming JSONL.

`cancel <operation-id>` requests cancellation of a known operation. Wait for the
core result; a request acknowledgment is not completion. Use `activity --limit
200` and `activity log <id>` for retained results and redacted diagnostics. Reads
are bounded and retention may remove old records. On reconnect inspect exact
IDs and current state, then present the specific supported recovery action.
An error does not imply unchanged files or a completed rollback.

Schema 47 status may include `definition_operations`. Consume each core-owned
install, preparation and launch outcome with its stable reason and `retained`
scope. An `eligible` result can be offered, while `hold` and `escalate` require
the recovery or trust action Portcove reports. Treat an unknown operation,
outcome or reason as a compatibility failure. Do not reduce publisher trust,
artifact integrity, source compatibility, scoped evidence or missing gameplay to
one client-maintained support flag, and do not cache a decision as authorization;
core revalidates current state when execution begins.

Schema 48 adds reviewed cleanup for a retained private preparation. Negotiate
the `preparation.cleanup` capability, read the current `retained_preparation`
repair from `doctor`, and validate its stable port and operation identities
before requesting `preparation cleanup-plan`. Show the complete affected
inventory and the installation, source, saved data, backups and logs that remain
outside the action. Submit `preparation cleanup` only with the exact reviewed
`preview_sha256` and explicit confirmation. Changed, missing, duplicated,
unknown or cross-port repair values require a fresh read and review; never reuse
an earlier fingerprint or infer cleanup from an interrupted preparation.

Schema 49 adds `launch.recover`. Negotiate the capability before offering an
explicit recovery action, bind it to the retained request ID already observed
through `launch.show`, and read the returned terminal record. Never substitute
client-side PID checks, direct SQLite changes, automatic relaunch, or a success
claim for the core result.

## Destination-artwork handoff

API 67 offers an optional, independently versioned `artwork_handoff_schema: 1`
capability and the `artwork.handoff` / `artwork.handoff-bytes` commands. A destination
adapter such as #292 must negotiate all three before using them. API envelopes and
operation events retain their existing versions; existing cover/detail clients
and clients that ignore this optional capability remain compatible.

```powershell
portcove --library C:\Games\Portcove --json --non-interactive artwork handoff shipwright --role portrait-cover
portcove --library C:\Games\Portcove --json --non-interactive artwork handoff-bytes shipwright --role portrait-cover --expected-library-id <observed-id> --expected-revision <observed-revision> --expected-asset-sha256 <observed-sha256>
```

Both commands are read-only observations, including startup: they perform no
recovery, provider fetch, thumbnail-cache read/write or destination write. Core resolves
the same current or retained admitted port as existing artwork reads. The metadata
contains `handoff_schema`, exact library identity, port, semantic role, Cover choice
and revision, selected SHA-256, tagged source provenance and tagged availability.
Local provenance retains the full admitted asset even when its original is missing;
catalog provenance retains the accepted IGDB game, cover, image, slug, match kind
and digest. This distinguishes an underlying-game default from a port-specific one.

The three static roles are `portrait_cover`, `landscape_cover` and `hero_banner`
(CLI flags use hyphens). V1 offers accepted durable Cover originals as portrait
content. Landscape and hero roles explicitly report `role_not_provided`; Detail
dimensions never assign a destination role. Catalog defaults report
`no_local_original`, even if a disposable display thumbnail exists. Missing or
invalid selected originals report `selected_original_unavailable` while retaining
the choice and provenance. Generated fallback also has no reusable original.
Never stretch or destructively crop one role into another.

The bytes command requires the previously observed library ID, choice revision and
asset digest, rechecks them under the artwork lock, and returns the complete handoff
plus an `original` JSON byte array. It reads the bounded regular original and checks
its digest, decoded format and dimensions. Stale bindings fail and require a fresh
preview. Originals retain the existing 16 MiB limit; bound process output for JSON
array expansion as well. Validate the handoff, byte count, digest and decode before
storing a durable destination copy. Exported `destination_artwork_handoff` and
`destination_artwork_bytes` schemas describe v1; the Core readers additionally reject
contradictory identity/source/content combinations. Unknown versions, roles,
provenance kinds or availability values require refusal, not inferred success.

The adapter binds a preview to the exact library/port, choice revision, selected
asset identity, destination installation/profile/entry, existing destination
identity and write preconditions. It rereads destination state before mutation;
changed or ambiguous state requires a fresh preview. Per-game/per-role results
distinguish written, preserved, skipped, unavailable and failed. Missing provider
credentials, offline access, no match or one unavailable role cannot turn a safe
entry or prepared launch into failure.

Provider credentials never cross this handoff. Provider configuration and enabled
automatic fetching are separate from permission to reuse a suitable local asset.
Destination writes use validated durable local copies, not disposable thumbnails
or remote URLs. Repair preserves customization, artwork refresh fills missing roles
by default, replacement requires deliberate consent, and cleanup is limited to
demonstrably integration-owned unchanged bytes. No public contract field grants
filesystem ownership, provider permission or mutation consent by itself.

## Responsiveness

Measure responsiveness against representative library sizes before setting a
budget. Record process invocation counts, refresh and launch latency, bounded
polling/concurrency, cancellation and prepared offline behavior. Prefer existing
batch reads over one CLI process per game, and refresh incrementally where the
public contract supports it. These measurements may expose a contract gap; they
do not by themselves justify a daemon, hidden cache authority or invented command.

## Representative source-built developer checks

The source-built Core/public CLI route can exercise disposable installation,
checksum refusal and controlled interruption without a published package or
personal game files. Provision the checkout's pinned Core capabilities explicitly
first; ordinary checks do not install tools. These commands use the existing
guarded Rust runner and compile the selected CLI from that checkout:

```powershell
node scripts/run-rust-tests.mts --locked -p portcove-cli --test machine_contract -E 'test(preparation_plan_reports_missing_inputs_without_starting_work)'
node scripts/run-rust-tests.mts --locked -p portcove-core --lib -E 'test(runtime_only_updates_stage_reuse_and_rollback_with_their_exact_bytes) | test(package_checksum_refusal_preserves_active_install_and_user_data) | test(cancellation_before_prepared_cleans_private_data) | test(cancellation_after_prepared_finishes_publication) | test(interrupted_requested_preparation_is_discarded_without_touching_user_data)'
```

The CLI case reads the public preparation plan, structured blocking reasons,
activity completeness and exported schemas from a disposable library. It starts
no preparation or game process. Core's existing fixture serves tiny synthetic ZIP
archives on loopback and uses the real installer, verification, activity and
lifecycle cleanup. The package checksum case retains the previous verified
installation and exact saved bytes after refusal, including fresh-library
readback. The cancellation cases distinguish cleanup before publication admission
from completing an already admitted publication. The interrupted private-intent
case verifies restart cleanup and preserved user data. These are precise
operation-specific outcomes, not a general process-kill, replay or resumability
contract. No fixture executable is launched by this selection.

Loopback fixture traffic does not establish that external networking was denied.
For the offline acceptance, execute the selected checks only through an existing
approved environment that denies external network access while allowing the
fixture's loopback traffic. Retain the enforced boundary and its actual readback,
exact checkout and compiled CLI identity, pinned tool observations, archive byte
identities, selected commands, disposable library and terminal/current-state
results. Cargo's `--locked` protects dependency resolution; it is not a network
isolation switch. Do not provision during the denied-network execution.

If that environment boundary is unavailable, retain the refusal and leave only
the external-network-denied criterion pending until an approved capable route is
available; continue independent fixture work. A namespace permission failure
does not authorize escalation or a security override. Label Linux and Windows
results separately and obtain both before claiming representative portability.
Prepared execution, warm reuse, successful cold acquisition, source-built CLI
proof and an identified packaged-agent exercise remain separate evidence.

## Troubleshooting and conformance

The [October 11 packaged-agent evidence map](archive/2026-10-11-packaged-agent-consumer.md)
records the identified local Windows/Linux candidates, public preparation,
negative cases, cancellation and lost-output readback. It was delivered through
[PR #1768](https://github.com/boburning/portcove/pull/1768) and the
[complete #1499 acceptance receipt](https://github.com/boburning/portcove/issues/1499#issuecomment-6106634012).
The completed exercise is consumed proof, not a new prerequisite to repeat. Reuse each result only at
its stated artifact, fixture and environment scope. In particular, an obstructed
library path is not a disk-full test, synthetic setup is not retail-source or
gameplay qualification, and a local package is not a published release. This map
also identifies accepted source-built offline checks separately from packaged
consumer observations and retains their failed admission evidence.

| Observation                         | Client response                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| CLI missing or path relative        | Ask for an existing verified executable and explicit library; do not search for a game executable instead.                  |
| Unsupported schema/capability       | Select a compatible package/client pair. Never continue by ignoring the version.                                            |
| Missing source/tool or bad checksum | Present core's requirement/error. Preserve the original file and admission rules.                                           |
| Busy port/library                   | Wait for the other operation and refresh; do not compete or force-unlock.                                                   |
| Interrupted output/cancellation     | Read retained activity and current state; no blind retry or assumed cleanup.                                                |
| Changed library/stale review        | Refresh identity/plan and obtain fresh action intent.                                                                       |
| Package/sandbox failure             | Confirm the package, native executable, mount and permission scope on that exact host; do not infer another platform works. |

Run `just playnite-check` for the reference's synthetic protocol/process cases.
The fixtures are freely redistributable repository code and need no original
game bytes. A passing fixture is not catalog admission or a real two-adapter
lifecycle qualification. Reports should include exact versions, schema, platform,
operation, expected/observed result and redacted reproduction instructions.

A fresh independent-consumer exercise must use only this public guide, examples,
schemas and an identified released package or explicitly labeled candidate.
Record private knowledge, workarounds, per-port branches and maintainer help; do
not retroactively describe implementation work as an independent exercise.
Agent-driven evidence is distinct from community adoption and human play.

API 73 extends external shared-write review with the closed SMB1R shared-directory
variant. Consume its directory scope, account/location binding, null fallback
and cache/log mutation disclosure before issuing the separate acknowledgement.
Reject unknown or contradictory variants; do not infer acknowledgement from
generic registration consent. The reference client binds the returned
registration to the reviewed shared account and path. External
`preparation_required` remains manual preparation, not a managed setup action.
See [the CLI shared-directory contract](CLI.md#shared-directory-external-runtimes-api-73).

## Evidence and continuation

Keep a bounded sanitized receipt that another author can use without private
implementation knowledge:

| Record                                                                            | Why it matters                                                                                                              |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Source/package/executable identities, OS/processor and prerequisites              | Distinguishes the exact published artifact or local candidate from a product-version label.                                 |
| Used API/event versions and capabilities                                          | Shows which consequential data the client was prepared to interpret.                                                        |
| Explicit library identity, catalog port ID and relevant operation/request ID      | Binds readback to the intended library and action without using mutable names or paths as identity.                         |
| Reviewed plan, selected inputs, actual authorization and observed terminal result | Separates proposed effects, permission, execution and authoritative outcome. Do not persist process-local tokens as grants. |
| Current state, retained recovery guidance and selected redacted diagnostics       | Makes interruption or lost output understandable before another mutation.                                                   |
| Fixture/input identity, interventions, limits and next supported action           | Preserves synthetic/native/published scope and enables a concrete handoff without inventing speedup or autonomous service.  |

After interruption, preserve the original error and inspect retained activity plus
current status before another mutation. If no authoritative terminal outcome was
observed, a failed readback leaves that outcome unknown; a later successful read
does not retroactively prove what missing output said. If a committed mutation or
terminal success is already known, preserve that fact and report a failed refresh
separately. Regenerate affected commands and request a fresh plan when runtime,
library, target or consequential inputs change. Use only the advertised
operation-specific recovery and its current review. A cleanup preview is not
cleanup application, and a cancellation acknowledgment is not a terminal outcome.

Report demonstrated contract/recipe gaps through the [contributor workflow](../CONTRIBUTING.md)
and the existing owning issue. Link the exact public response and reproduction,
state expected versus observed behavior, preserve failures, and identify the next
capable action. [Architecture ownership](ARCHITECTURE.md#find-the-owning-boundary),
[CLI schema history](reference/cli-schema-history.md) and
[platform/package limits](RELEASING.md#standalone-cli-integration-artifact) provide
the subsystem and migration routes. No private source bytes, credentials or
unredacted personal library paths belong in a public report.

## Game-author descriptors

This section concerns game authors, separately from the external-client CLI
contract above. The native descriptor is the existing version-1 authored port
record: `format_version`, `listing` and `integration`. It translates through
`scripts/catalog-authoring.mts`; the captured compiled Core inspector owns
catalog, original-file, preparation and launch validation. There is no second
plugin runtime, catalog, trust store or executable-selection owner.

The minimum useful integration supplies an explicit port/original-game identity,
supported platform/package and executable selection, and any required existing
source contract. Use literal existing launch arguments and declared contained
data paths. Settings, save management and custom preparation are optional. A
descriptor cannot make a weak source check, arbitrary command/environment,
absolute path, script or unreviewed executable acceptable.

The runnable examples share the same native validation path:

- [Shipwright descriptor](../examples/integrations/shipwright/portcove.json), with
  its existing Libultraship preparation and JSON configuration.
- [Golden Balloon descriptor](../examples/integrations/golden-balloon/portcove.json),
  with its existing source materialization/runtime subdirectory and INI app
  preferences.
- [Basic Shipwright descriptor](../examples/integrations/shipwright/basic.portcove.json),
  deliberately without settings. This still proposes ordinary setup and launch.

After building the repository's Core-backed CLI with the maintained development
route, select its actual path; on Windows include `.exe`:

```sh
node scripts/port-descriptor.mts validate examples/integrations/shipwright/portcove.json --validator-cli target/debug/portcove --output-dir work/descriptor-shipwright
node scripts/port-descriptor.mts validate examples/integrations/golden-balloon/portcove.json --validator-cli target/debug/portcove --output-dir work/descriptor-golden-balloon
node scripts/port-descriptor.mts validate examples/integrations/shipwright/basic.portcove.json --validator-cli target/debug/portcove --output-dir work/descriptor-basic
```

Each output directory must be new. The tool captures the selected validator,
exports its input schema, checks the basic proposal before optional settings,
and retains exact input/validator identities, process receipts, a candidate-only
`validated-descriptor.json` and a report. `--catalog-root` selects an explicit
existing authoring/source-contract context; it never opens a player library.
Capability-stripped compatibility inputs are validation evidence, not catalog
replacements. The exported descriptor has no
admission, installation, execution or publication authority. Existing accepted
and retained definitions take precedence over any release-embedded or fetched
descriptor. Local/community import and its separate trust decisions remain #268.

Exit 0 means the declared capabilities were validated as proposals. Exit 2 means
basic behavior validated but optional settings did not: read the diagnostic and
retained Core process receipt, correct that field or omit the optional contract.
An older captured Core schema cannot claim support for `game_settings` it does
not implement. Invalid basic/source/launch semantics refuse basic validation.

### Declaring release-bound settings

`integration.game_settings` is optional operational definition data. Version 1
declares exact Windows release/archive/source identities and evidence, explicit
contained persistent configuration files, byte bounds, literal keys and bounded
boolean/integer/decimal/enum choices and defaults. JSON keys are object-member
components, not executable expressions. One INI key component means case-sensitive
flat preferences. Two components mean a bounded section/key grammar with ASCII
case-insensitive identities, including root dotted aliases. A file cannot mix
these grammars. Sectioned files are UTF-8 without BOM/NUL, at most 32,767 bytes,
128 entries, 127-byte flattened keys, 1,023-byte values and 1,155-byte physical
lines. Malformed sections and duplicate declared identities refuse edits.
Unrelated lines and comments remain intact; this is not universal INI support.
An installation must retain the declaration; a current catalog advertisement
cannot grant new file access to an older retained install.

The inspected examples deliberately distinguish consumer representations:
Shipwright 9.3.1's `CVars.gSettings.Volume.Master` is an integer percentage from
0 to 100, default 40. Its pinned Libultraship loader distinguishes integers from
floats. Golden Balloon 1.8.0's `mdkr64.ini` `[Audio]` / `MasterVolume`
is an integer percentage from 0 to 100, default 100. Its interactive `--ui`
shell exposes the settings overlay and publishes this setting to the audio
consumer. On first use, select the already materialized `dkr-v80.z64` through
Golden's normal ROM picker; the shell validates and remembers that selection in
`mdkr64_app.ini`. It does not search the working directory. The
[pinned argument dispatch](https://github.com/akratch/goldenballoon/blob/2b69e748ec04f87a4dc6f032c598726de1b0e813/platform/app/arg_triage.h)
routes `--rom` directly to the engine without the shell or settings overlay;
combining `--ui` and `--rom` does not establish supported ROM seeding.
Both configuration writers create sibling OS-lock files. Declare the exact
runtime-relative `mdkr64.ini.lock` and `mdkr64_app.ini.lock` leaves as runtime
mutable paths, rather than treating the whole runtime directory as writable.
The pinned [video configuration writer](https://github.com/akratch/goldenballoon/blob/2b69e748ec04f87a4dc6f032c598726de1b0e813/platform/video_config_runtime.c)
and [shell preference writer](https://github.com/akratch/goldenballoon/blob/2b69e748ec04f87a4dc6f032c598726de1b0e813/platform/app/app_config.cpp)
own these locks; they are runtime coordination files, not player preferences.
Root `Audio.MasterVolume`
is equivalent; duplicate dotted, sectioned or case aliases refuse edits.
The earlier `mdkr64_app.ini` / `ui_scale` choice was shell-only and could not
qualify this launch route. Native evidence must verify the package's executable
and portable-marker location, resolved INI path, absence of higher-priority
environment/CLI overrides, restart and actual consumer behavior. Their exact
released source/asset identities are in the descriptors; another release or
repacked asset must not inherit these settings by name alone.

Descriptor validation is an internal partial delivery of #4156. It does not
establish editable Desktop settings, safe read/review/apply/reset, write recovery
or actual consumer execution. Those operations require their own implemented
Core service, retained authority, current storage/preimage checks and actual
Windows Desktop/consumer evidence. Validation receipts, source inspection and
existing save evidence are not substitutes for that acceptance.

### Interoperability decision

Portcove does not adopt the `recomplauncher.json` wire schema in this version.
The progressive author experience described by
[RecompLauncher's developer guide at the inspected revision](https://github.com/elripalda/RecompLauncher/blob/6ab3f113934baae14cb2c1f4348ca61d16897f49/docs/DEVELOPERS.md)
is useful context; Portcove instead reuses its implemented source, launch,
preparation, authoring and retained-definition contracts. A competitor descriptor
is not converted implicitly or given precedence. Arbitrary preparation programs,
expanded home/config paths, unconstrained arguments/environment, file clearing,
account/cloud actions and executable fallbacks are not interoperability grants.

The inspected repository's license is
[GPL version 3](https://github.com/elripalda/RecompLauncher/blob/6ab3f113934baae14cb2c1f4348ca61d16897f49/LICENSE).
This is an attribution/license observation, not permission to copy its
implementation or schema text. This native path uses neither. Maintaining even
the narrow supported surface requires release-specific key/type/path and
consumer checks, negative fixtures, and explicit review when upstream changes.
No universal compatibility or upstream-adoption promise follows.
