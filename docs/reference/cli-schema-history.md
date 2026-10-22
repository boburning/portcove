# Machine contracts and CLI schema history

Use this history to identify the document that changed and the compatibility
consequence. It records changes already described by the CLI guide; it is not
an exhaustive release changelog, a list of published binaries, or permission to
accept every intervening version. The running CLI's `capabilities` and exported
input/output schemas describe that artifact. The
[current reference-reader window](../INTEGRATION-AUTHOR.md#discover-and-bind)
records the independently tested consumer membership.

The [CLI task guide](../CLI.md) owns invocation, mutation and recovery routes.
The [domain glossary](../../GLOSSARY.md) distinguishes present names from proposed
renaming; this history does not deliver future commands or migrate stored data.

## Version authorities

| Version or identity                                     | Affected document                                                                | Compatibility rule                                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI `schema_version`                                    | JSON response envelope, command results and advertised capability/output schemas | Decode the used command under a supported version. Additive fields do not authorize ignoring unknown consequential values. Product version is separate.                                                        |
| `operation_event_schema_version`                        | JSONL operation events                                                           | Negotiate independently of API results. API 50 advertises this explicitly; the historical API 42–49 reference window uses event 2. Event 3 adds provisional discovery candidates, not registration permission. |
| Catalog schema                                          | Catalog document and source authority                                            | Schema 2 adds source identity/representation/admission/evidence contracts. A CLI response version does not replace the catalog document's own version.                                                         |
| Library metadata format                                 | `library export` document                                                        | Format 2 adds Source Inbox; format 3 adds local artwork. Formats 1/2 remain importable at their stated scope. Unknown formats must be refused, and metadata contains references rather than payload bytes.     |
| Source-inspection and saved-scan formats                | Inspection reports and persisted discovery snapshots                             | Their formats and evidence scopes remain separate from API envelopes. Open `state_code` values are not approval. Historical readable scans may have stale coverage or invalid continuation.                    |
| Manifest, retained-contract and library writer versions | Installed execution/persistence contracts and private durable state              | Older writers refuse unsupported upgraded state. External clients use public commands rather than interpreting SQLite or rewriting historical representations.                                                 |
| Signed envelope format                                  | Optional signed catalog delivery                                                 | Implemented format 1 remains distinct from the successor definition-delivery work. Signature verification does not establish artifact, source or gameplay qualification.                                       |

## Documented API changes

API80 introduces explicit selected-executable external trust/intent and the
reusable typed managed-policy declarations (staged-source capabilities 20 and
19 respectively). Registration preview/results distinguish selected bytes from
accepted-package certification. New retained format5 makes old readers refuse
user-selected execution semantics. Existing exact-package records and managed
runtime manifests retain their original meanings; creation-only recipe
capabilities retire without erasing those readers. Events remain version3.
The [compatibility record](upstream-first-compatibility.md) identifies actual
published, development and persisted consumers and remaining retirement conditions.

“Additive” describes the recorded shape change, not automatic compatibility with
an unknown enum, capability or execution consequence. Breaking array/object,
review, ownership and required-assessment changes need explicit reader handling.
The detailed records below preserve the actual guarantees and limits.

| API version | Affected document or surface                    | Compatibility effect                                          | Recorded change                                                                                                                                                                                                                    |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2           | Bulk update result                              | Changed result shape                                          | Per-port success/failure outcomes replace bare successful installs.                                                                                                                                                                |
| 3           | Install records/update checks                   | Added immutable identity                                      | Artifact digest, manifest digest and selected executable distinguish bytes from a display tag.                                                                                                                                     |
| 4           | Adoption, backup and removal previews           | Review/field change                                           | Deterministic previews and `preview_sha256` source-removal consent binding.                                                                                                                                                        |
| 5           | Library transfers/activity                      | Added operation/results                                       | Move plans, metadata and terminal source/destination/active-root results.                                                                                                                                                          |
| 7           | Signed catalog/doctor                           | Added trust and review contracts                              | [Format-1 catalog commands](../CLI.md#signed-catalog-delivery); event contract stayed 2.                                                                                                                                           |
| 8           | Runtime/install/update plans                    | Added runtime identity                                        | A bundled-runtime-only change is an update; retained installs bind their runtime.                                                                                                                                                  |
| 9           | Catalog/manifest                                | Added persistence declarations                                | Bounded persistent filename patterns; manifest 5 records their exact authority.                                                                                                                                                    |
| 10          | Catalog/runtime materialization                 | Added reviewed environment/source fields                      | Restricted environment overlays and exact bounded LIVE/STFS materialization.                                                                                                                                                       |
| 11          | Backup inventory                                | Array becomes object                                          | Healthy records plus explicit degraded/recovery-required state and per-entry problems.                                                                                                                                             |
| 12          | Launch cancellation                             | Consequential phase behavior                                  | Cancellation before spawn and exact-child supervision after the atomic boundary.                                                                                                                                                   |
| 13          | Source assessment                               | Added typed facts                                             | Health, classification, admission and scoped evidence stay distinct.                                                                                                                                                               |
| 14          | Library selection                               | Added commands/provenance                                     | Invocation, saved or platform-default selection without assuming identity creation.                                                                                                                                                |
| 15–17       | Catalog/source authority                        | Staged schema-2 migration                                     | Typed authority, embedded migration and explicit legacy projection-only variants.                                                                                                                                                  |
| 20–21       | Source inspection                               | Added reports/validator observations                          | Exact, structural, mismatch and ambiguity facts; preliminary validation remains `not_run`.                                                                                                                                         |
| 22–25       | Output location/plans                           | Added reviewed placement and relocation                       | Future-placement preferences, availability/capacity and state-bound moves have different consequences.                                                                                                                             |
| 26–27       | Host tools                                      | Added definitions/resolution/commands                         | A fixed successful probe is required before saving a selected path.                                                                                                                                                                |
| 28–30       | Source records/inspection/qualification         | Added scoped observed identity and evidence                   | Legacy missing identity stays readable; exact qualification needs every applicable scope.                                                                                                                                          |
| 31–34       | Source Inbox/imports/tool hints                 | Added plans, execution and metadata format 2                  | Copy/Move/use-current-location, separate Move authorization and recoverable registration.                                                                                                                                          |
| 35–36       | Preparation/activity/readiness                  | Added operation and blocker                                   | Reviewed setup, `prepare` activity and `preparation_required`.                                                                                                                                                                     |
| 37          | Errors/activity                                 | Added structured failure report                               | Mutation/recovery facts remain explicit; old records have no invented report.                                                                                                                                                      |
| 38–39       | `activity_diagnostic`                           | Single/null becomes array in 39                               | Ordered retained phase captures, per-stream truncation and completeness.                                                                                                                                                           |
| 40          | Adoption preview                                | Expanded review binding                                       | Destination, installed state and saved-data identities require a fresh review when changed.                                                                                                                                        |
| 41          | Library identity                                | Added public identity read                                    | Existing Core identity becomes public; metadata/database formats are unchanged by this API addition.                                                                                                                               |
| 42, 49      | Launch requests/recovery                        | Added durable exact-request observations                      | Request UUID/readback, then explicit recovery with child/start/install checks.                                                                                                                                                     |
| 43          | Readiness/retained installation                 | Added blocker and retained-contract interpretation            | Invalid installation refuses launch; manifest/writer versions remain separate authorities.                                                                                                                                         |
| 44          | Artwork/library metadata                        | Added commands; metadata format 3                             | Local choices and copied originals have a separate payload root.                                                                                                                                                                   |
| 45–47       | Definition capabilities/provenance/status       | Added distinct observations                                   | Template support, selected-definition origin and per-operation eligibility do not grant consent.                                                                                                                                   |
| 48          | Doctor/preparation cleanup                      | Added explicit recovery surface                               | [Retained preparation and reviewed cleanup](../CLI.md#review-and-recover-preparation) preserve missing process-closure proof.                                                                                                      |
| 50          | Capabilities                                    | Added independent event version                               | Lifecycle consumers negotiate API and event contracts separately.                                                                                                                                                                  |
| 51          | Activity result                                 | Array becomes feed                                            | Protected active/actionable sets and bounded-history completeness must be consumed.                                                                                                                                                |
| 52–53       | Saved game-file folders/scans                   | Added commands/snapshot schema                                | Saved roots, bounded scans and input-match readback do not register candidates.                                                                                                                                                    |
| 54          | Port status                                     | Added action assessments                                      | Availability/reason is not execution permission or proof every mutable input was checked.                                                                                                                                          |
| 55          | External runtimes                               | Added non-owning registration route                           | Runtime files stay user-owned; register/remove require review and consent.                                                                                                                                                         |
| 56          | Managed removal                                 | Added read-only preview                                       | Exact inventory fingerprint precedes one-use authorization.                                                                                                                                                                        |
| 57          | First installation                              | Added optional reviewed route                                 | [Installation plan/run](../CLI.md#reviewed-first-installation) bind separately registered inputs and matching consent.                                                                                                             |
| 58–59, 64   | Private candidates                              | Not accepted public-reference versions                        | Their integers are not inferred compatible from support for later versions.                                                                                                                                                        |
| 60–61       | Rollback/status                                 | Required exact retained-target assessment; added hold reasons | Revocation and distribution withdrawal have different acquisition/retained-use consequences.                                                                                                                                       |
| 62–63       | Backup inventory                                | Required creation and Restore assessments                     | Eligibility, snapshot integrity and execution consent remain separate.                                                                                                                                                             |
| 65–66       | Source query/game-update status                 | Added query, then required update assessment                  | [Route-bound observations](../CLI.md#route-bound-game-file-observations) and current update status supply no candidate or execution authority.                                                                                     |
| 67          | Readiness/external review/artwork handoff       | Added optional fields/capabilities and consequential reasons  | Source representation, exact external fingerprints and independently versioned [artwork handoff](../CLI.md#local-artwork) need their own interpretation.                                                                           |
| 68–70       | Preparation/legacy recovery/input compatibility | Added closed mode and scoped recovery/assessment              | Unknown modes refuse; [qualified Ghostship recovery](../CLI.md#qualified-ghostship-recovery-api-69) and input compatibility do not establish gameplay.                                                                             |
| 71          | Catalog presentation/install plans              | Added display and acquisition facts                           | Original-game/variant/manual steps, auxiliary downloads and temporary-space facts grant no operation authority.                                                                                                                    |
| 72          | External relink                                 | Added reviewed location change                                | Preserves registration/retained contract; separate shared-preferences consent stays bound to the outer fingerprint.                                                                                                                |
| 73–74       | Shared external data/managed path policy        | Added closed shared-data variant and optional retained policy | [Shared-directory review](../CLI.md#shared-directory-external-runtimes-api-73) and path refusals cannot be inferred from an installed flag.                                                                                        |
| 77–78       | Managed ReGaiden/CVLoD plans                    | Added exact managed-route consequences                        | Shared-preference acknowledgment remains consequential. CVLoD custom creation is retired; [retained runtime/recovery compatibility](upstream-first-compatibility.md) preserves its historical meaning without offering new builds. |

## Early result, runtime and persistence contracts

Schema version 2 changed `update --all` from an array of bare successful install records to failure-isolated outcome objects. Schema version 3 adds immutable `artifact`, `manifest_sha256`, and `selected_executable` fields to install records, plus `installed_artifact` to update checks. Schema version 4 adds deterministic adoption, backup-action, and managed-removal previews and renames the source-removal consent fingerprint to `preview_sha256`. The human-facing `version` remains the upstream display tag; integrations must use the artifact SHA-256 when deciding whether two releases are identical. Consumers written for an earlier schema must branch on the envelope version before decoding these results.

Machine schema version 5 introduced `move_library` to the activity operation enum and exports library metadata, move-plan, and move-result schemas. Move result fields identify the retained source, destination, active root, and terminal completion state. A transfer awaiting recovery has a durable journal and running activity; a resumed or aborted transfer records its explicit terminal outcome.

### API 8

API schema 8 adds optional `runtime` identity to install records, `installed_runtime` and `required_runtime` to update checks, `bundled_runtime` and `download_bytes` to install plans, and `missing_runtime` launch readiness. `catalog` exposes the platform runtime archive pins and layout. A runtime-only change is an update even if the game's release name and archive are unchanged. `update` supplies a missing runtime; `exec` fails before running an upstream downloader. Rollback retains the runtime recorded with that install. Operation event schema remains 2.

### API 9

API schema 9 adds `persistent_file_patterns` to catalog ports. Each rule has a literal filename `prefix` and `suffix`, with at least one character between them, and matches regular files only in the port's existing persistent working directory. Core uses these rules for named saves during adoption, collection, backup/restore, and version transitions. Manifest schema 5 binds these rules, the target platform, and immutable-file executable intent to verification and import admission; older manifests do not acquire new persistence exclusions or permission claims silently. The additive optional `runtime_mutable_paths` catalog field identifies reviewed disposable output from upstream-managed setup; current trusted catalog paths are honored during verification so a newly declared runtime log cannot strand an otherwise valid older manifest. Event schema remains 2.

### API 10

API schema 10 adds `user_data_environment`, `launch_environment`, `runtime_source_hashes`, and `stfs-directory` runtime materialization to catalog ports. Catalog validation keeps environment overlays away from credentials, Portcove/session variables, and multiline values. LIVE/STFS materialization is bounded, transactional, and requires exact source and extracted-file SHA-256 identities. Event schema remains 2.

### API 11

API schema 11 changes `backup list` from an array to `BackupInventory`, preserving healthy records while adding overall `healthy`, `degraded`, or `recovery_required` state and structured per-entry problems. It also exposes the durable backup-deletion lifecycle through inventory and doctor repair reporting. Event schema remains 2.

### API 12

API schema 12 makes launch preparation part of the durable activity cancellation contract. A CLI interrupt before child creation requests cancellation by the launch activity UUID; once the atomic pre-spawn boundary has closed, the pending signal is forwarded to the exact child process group. Durable desktop launch requests retain preparation/running/collection phase, process-start identities, terminal outcome, exit code, and explanation for reconnectable exact-request observation. Event schema remains 2.

## Source, catalog and storage contracts

### API 13

API schema 13 exports `source_assessment`, the shared typed contract for source
health, classification, release-contract result, admission and scoped evidence.
`not_baselined` means selected readable bytes have no saved identity baseline;
`not_checked` means current bytes were not checked. `current` still means only
unchanged against registration. This foundation adds no inspection command and
does not change source admission or verification responses. Consumers must not
use evidence presence, relevance, or a selected path as permission to install.
Legacy variant-unspecified evidence never establishes exact qualification;
failed, unknown and not-run evidence retain separate meanings.

### API 14

API schema 14 adds library selection output with its effective root and
`invocation`, `saved`, or `platform_default` provenance. It also adds the
library-free `library show`, `library set`, and `library reset` commands shared
with desktop bootstrap.

### API 15

API schema 15 exports `source_catalog`, the typed schema-2 authority for source
identity profiles, logical variants, physical representations, scoped digest
objects, per-port admission contracts, pinned validators, and reviewed evidence.
It introduced the migration contract before the embedded data changed.

### API 16

API schema 16 adds that authority to catalog results after the embedded catalog
migrates to schema 2. `source_profiles` remains the core-generated compatibility
view for current clients until the shared inspector replaces it.

### API 17

API schema 17 marks transitional schema-1 projection-only variants explicitly.
Those variants preserve Alpha 1 admission while the new per-port reviewed
variant sets wait for the shared schema-2 inspector. Port contracts cannot select
a projection-only variant.

### API 20

API schema 20 exports the shared read-only source inspection result. It includes
observed digest algorithm/scope records, typed file-set and optical-disc
components (including track counts and readable volume IDs), and typed exact,
structural, mismatch, and ambiguity outcomes.
Human source inspection output prints the core report's next action: an accepted
new selection offers an add choice, a current registration needs no source action,
an unfinished file check runs during reviewed setup, and a known mismatch calls for files
from a supported edition. JSON and JSONL retain the same report fields.

### API 21

API schema 21 adds the pinned source-validator observation to that result. It
identifies the catalog contract, tool, protocol, and current validator result.
Preliminary ISO/CHD selection reports `not_run` with structural admission rather
than claiming an exact match. LIVE/STFS packages now reach exact admission only
after the shared bounded package validator succeeds.

### API 22

API schema 22 adds the core-resolved per-game output location to install plans
and path results. It distinguishes a one-request override, the saved port
setting, and the existing library default while retaining the exact recorded
paths for active, previous, and staged installations.

### API 23

API schema 23 adds a read-only per-game output-destination preview with the
resolved path, inherited or custom origin, availability, capacity, ownership,
affected install records, validation results, and a state-bound fingerprint.
`output set` and `output reset` require that exact reviewed fingerprint and
revalidate it under the port lock. These commands change future placement only;
they never move an existing installation. `plan`, `install`, and `ensure` accept
one `--output-dir` request override. No all-port command accepts a shared output
directory. API schema 24 distinguishes a full volume from an unavailable volume.
A preview fingerprint changes when the volume becomes full or unavailable, or
when its identity changes. Exact free-space and total-capacity values remain
visible review facts, but ordinary positive free-space movement does not stale
consent. Apply repeats the availability check, and install or relocation repeats
the exact sufficiency check for the bytes that operation needs.

### API 25

API schema 25 added explicit per-game relocation. `output move <port-id> <path>`
returns a read-only, state-bound plan covering every recorded active, previous,
staged, and retained installation. Add `--apply --expected-plan <sha256> --yes`
to copy and verify those versions, atomically switch their recorded paths and the
future output preference, then remove reviewed old copies. Sources, persistent
data, and backups remain in their central locations. If old-copy cleanup cannot
finish, the result reports `cleanup_pending` and startup retries it from the
durable journal; the new paths remain authoritative.

### API 26

API schema 26 adds fixed disc-tool definitions, saved-path resolution, and the
`saved`/`unsupported` tool states.

### API 27

API schema 27 adds library-free `tool list`, `tool set-path`, and
`tool clear-path` commands plus typed status and bounded-probe results. Desktop
uses the same core resolver, validation, and host-preference store. A selected
path is saved only after its registry-owned, shell-free probe succeeds; clearing
it reveals any environment or discovered candidate without changing a library.

### API 28

API schema 28 adds an optional `observed_identity` to source records returned by
registration, listing, relink planning, and relink apply. New registrations retain
versioned digest scopes, component facts, a selected ZIP member when present, and
validator observations. Legacy registrations omit the field and remain usable;
classification and admission are recomputed against the active catalog.

### API 29

API schema 29 added the read-only `source inspect <profile-id>` command and embeds
that same complete report in successful `source verify` results. The report has
its own format version and an open `state_code`, includes full observed and
expected digests with their algorithms and scopes, dependent source contracts,
reviewed evidence IDs and links, release applicability, and conservative
qualification and legacy coverage. Missing or unreadable registered paths return
a structured inspection state; inspection and verification never replace the
saved baseline.

### API 30

API schema 30 adds exact schema-2 source qualification records and core-derived
qualification states. These records keep structural, automated lifecycle,
hands-on, known-failure, missing, and not-run evidence distinct and require an
exact artifact, contract, variant, representation, platform, and check version.
Legacy platform arrays remain historical unscoped coverage.

### API 31

API schema 31 adds the core Source Inbox path and resolution contracts and
library metadata format 2. Metadata format 2 includes `source-inbox` as a
movable content root; format-1 Alpha 1 exports remain importable and represent
an empty Source Inbox. Core scans only one profile directory at a time, returns
typed exact, approval-required, conflict, incomplete, and unresolved states,
and reuses a candidate during install only after one exact match is rechecked.

### API 32

API schema 32 adds the core source-import plan and result contracts. A plan
binds the inspected identity, filesystem objects, current registration, chosen
Source Inbox destination, capacity requirement, and copy, move, or
use-current-location mode. Copy is non-destructive. Import-plan version 2 copies
only the admitted original members of a directory input, with capacity based on
their stored bytes; unrelated collection files remain at the original location.
Version-1 journal recovery preserves its reviewed whole-selection semantics.
Move consumes a separate
single-use authorization and reports a verified registered copy with the exact
retained-original path if cleanup fails. Lifecycle activity and SQLite schema 18
allow interrupted imports to resume without duplicate registration. A durable
operation-bound receipt lets restart recognize a rename that completed before
its journal phase write, while missing, changed, or unrelated destinations stay
blocked without deletion.

### API 33

API schema 33 exposes Source Inbox paths, scans, import plans, and import
execution through the CLI and desktop adapters. Both adapters preserve the
core operation ID in progress events and final results. Opening the profile
folder remains a host-integration action after core validates and creates the
profile directory. A move requires a separately reviewed plan and explicit
confirmation before the adapter grants the core's single-use authorization.

### API 34

API schema 34 adds an optional `tool_id` to source-inspection problems. The
core exposes only the matching host-tool identifier, so CLI and desktop clients
can offer the same readiness actions without receiving configured tool paths or
other private error details.

Desktop inspection calls the same core method. Evidence navigation accepts only
a stable evidence ID, resolves it from the active catalog, revalidates the stored
immutable HTTPS URL at use, and then hands that URL to the operating system.

### API 43

API schema 43 adds the `invalid_installation` launch blocker. A game whose saved
installation contract cannot be verified remains visible but cannot launch;
other games remain readable. New installations retain their execution and
persistence definitions in manifest schema 6, introduced with writer protocol 23.
Protocol 25 now protects exact successor definition retention; older clients refuse
to modify an upgraded library. The current reference-reader compatibility window is documented in the
[integration author guide](../INTEGRATION-AUTHOR.md#discover-and-bind); a historical
API change does not extend that window. Event schema 3 adds a provisional exact
`source_candidate` during discovery, carrying profile, path, SHA-256 and size.
Clients still read the completed report or saved-root snapshot and request a
fresh import plan before registration. Event negotiation and activity-feed
completeness retain their independent contracts.

### API 71: acquisition and temporary space

API schema 71 adds optional `auxiliary_downloads` and `temporary_space` to install
plans. The cold `download_bytes` total includes the primary artifact, bundled
runtime and every required recipe archive. A primary cache hit can reduce the
download but does not remove recipe auxiliary acquisitions, which have no curated
cache restoration. `temporary_space` reports execution's free-space floor and
the output folder/volume it concerns, with observed available bytes and an
optional capacity result. Unknown capacity is not sufficient capacity; execution
always rechecks. These quantities do not estimate final installed size. Plans for
active, staged or retained reuse need no download and omit temporary acquisition
capacity. Planning does not execute a cartridge build or grant title admission.

## Preparation and failure contracts

Schema 35 added `prepare` to the activity vocabulary and SQLite schema 19 added
reviewed preparation plans to the existing lifecycle journal. Schema 36 adds the
`preparation_required` launch blocker and the `preparation.run` command.

Schema 37 adds core-owned failure presentation to error objects and an optional
structured failure report to activity records. Existing machine `code`, `message`
and `details` fields retain their values; JSON and JSONL use the same report.
Presentation supplies a stable key, human summary, phase, explicit mutation state,
recovery actions and redacted technical context. Unknown outcomes are not treated
as no changes, and cancellation has neutral presentation. SQLite schema 20 stores
these reports alongside terminal activity status; older records have no report.

Schema 39 changes `activity_diagnostic`, available through `activity log <activity-id>`,
to an array of retained, redacted phase captures in phase-start order. An empty
array means no capture remains. Schema 38 returned one setup capture or `null`;
consumers must use the envelope version when interpreting this change.
The command does not load logs in the normal activity list. Each capture's
`phase` distinguishes source conversion and game setup. `complete` records observed stream closure;
each stream separately reports truncation and observed input bytes. An interrupted
capture stays incomplete. Human output explains whether both streams ended or whether later output may be
missing, with a separate warning for omitted output; log availability does
not establish the operation outcome. The first 2 MiB per stream are retained within a shared
64 MiB library budget; older terminal activities' captures may expire together
while their activity outcomes remain. The per-stream limit applies to each phase.

## Operation and consumer contracts

### API 40

Schema 40 extends adoption previews with the selected output destination, current
active installation, imported persistent paths and current saved-data identity.
Review authorization binds these values as well as the source copy plan. A changed
destination, active installation or saved-data tree requires a fresh review. Copying
merges catalog-selected saved data and replaces matching files without creating an
automatic safety backup; originals and retained installations remain. The final
version folder is named only after verification of the private copy.

### API 41

Schema 41 adds `library identity`, the `library_identity` schema and the
`library.identity` capability entry. It exposes the existing core-owned identity
with its effective location; no database or metadata format changes are required.

### API 42

Schema 42 adds `exec --request-id <uuid>` and `launch show <uuid>` for exact durable
launch observation, plus the nullable `launch_request` output schema. `exec`
continues to own raw game streams and supervise through game exit/save collection.

### API 44

Schema 44 adds `artwork` commands and the `artwork_state`, `artwork_thumbnail`,
`artwork_cache_clear` and `artwork_assets` machine schemas. It also versions library
metadata exports to format 3 with a separate local artwork payload root. Existing
launch/status fields are unchanged from schema 43.

### API 45

Schema 45 adds `capabilities.engine_templates`, `catalog.check-capabilities`, and
the `definition_capability_request` / `definition_capability_report` schemas.
This reports installed template contract versions independently from definition
admission, trust, and operation eligibility.

### API 46

Schema 46 adds the `definition_selected` catalog provenance origin. Core reports
that origin only while the exact selected definition is fresh, still authorized,
and scoped to its selected port. A rejected selection keeps the existing catalog
origin and appends a visible fallback reason.

### API 47

Schema 47 adds `definition_operations` to port status results for authenticated
successor definitions. Each entry identifies install, preparation or launch,
reports the core `eligible`, `hold` or `escalate` result with its stable reason,
and distinguishes current selection from a retained installed contract. Legacy
ports omit the field. CLI operations and Tauri commands consume the same core
assessment; retained launch can survive metadata expiry, while known revocation
or changed publisher identity remains a hold.

### API 49

Schema 49 adds explicit `launch recover <uuid>` for an unfinished request after
its recorded supervisor exits. Recovery retains core's exact child/start/install
checks and reports a failed terminal launch; it never converts interruption into
success.

### API 50

Schema 50 adds `operation_event_schema_version` to `capabilities`. API result
envelopes and JSONL operation events are independently versioned, so a lifecycle
consumer must negotiate both instead of assuming the event version from the API
version. Launch-only and read-only library consumers do not need JSONL or the
event schema and may negotiate only their used commands, `json`, and—for
launch—raw supervised `exec`.

### API 51

Schema 51 changes the `activity` result from an unqualified array to an activity
feed. `records` contains a deterministic, deduplicated union of every current,
failed-needs-attention, and lifecycle-recovery-owned activity plus the requested
bounded terminal-history window. The three ID lists classify those protected
sets. `active_and_actionable_complete` is explicit; `terminal_history_limit`,
`terminal_history_count`, and `terminal_history_complete` describe the ordinary
completed-history window. Retained failures are attention-required within core's
1,000-terminal-record retention policy; older terminal evidence is retired. A
truncated terminal window is not a complete ledger.

### API 52

Schema 52 adds the `source.roots` capability, the `source roots` add, list,
relink and remove commands, and the `game_file_roots` exported schema. Saved
roots retain stable identities and unavailable paths; consumers must negotiate
this specific capability rather than infer it from the coarse `source` entry. Adding the same canonical folder from concurrent clients is idempotent: all successful registrations return the same persisted root identity and leave unrelated saved roots unchanged.

### API 53

Schema 53 adds the `source.roots.scan` capability, the `source roots scan` and
`source roots snapshot` commands, and the nullable `game_file_scan_snapshot`
exported schema. Scan uses core's bounded limits and emits the existing
`discover_sources` operation events under `--jsonl`; snapshot readback reports
`inputs_match` or `inputs_changed` rather than treating older evidence as current. Human scan completion and snapshot readback share a summary of recorded limits, issue and omitted-issue counts, and unavailable folders at scan time. Matching recorded inputs does not prove complete coverage or revalidate file contents. Unavailable folders do not mean deleted files; changed inputs require a new scan. Use `--json source roots snapshot` for recorded details; human summaries omit raw issue messages and paths. The scan result uses the same summary rather than dumping the full serialized record; `--json` and `--jsonl` retain the complete result and operation-event contracts.
Candidates remain unregistered until separately accepted.

### API 54

Schema 54 adds `port_actions` to port status. Core projects install, launch,
and owned-removal availability as `not_offered`, `waiting`, `held`, or
`allowed` with a stable reason. A signed-definition restriction includes the
existing exact eligibility result. The projection does not grant consent or
replace execution-time source, ownership, and reviewed-plan checks. In
particular, an uninstalled registered source is not hashed merely to render
status; `allowed` means the attempt can start without a known blocker, not
that every mutable input has already passed execution validation.

### API 55

Schema 55 adds the `external` capability and `external.preview`,
`external.register`, and `external.remove`,
the `user-prepared` release route, external registration status, and retained
launch ownership. Register and remove require reviewed state and consent. The
registration is local library state; metadata export/import does not transfer
the outside runtime or grant ownership of it. On another host or after moving
the external folder, prepare and register it again against an accepted catalog
entry.

### API 56

Schema 56 adds the read-only `remove.preview` capability. `remove-preview PORT_ID`
returns core's exact managed paths, persistent-data preservation statement and
fingerprint without issuing consent. A client may then show that preview and
submit `remove PORT_ID --expected-preview <sha256> --yes`; the CLI rejects a
changed inventory before issuing the one-use core authorization, and core
rechecks it under the port lock. Existing interactive `remove PORT_ID` remains
available. Hiding or deleting a Playnite entry does not authorize this command.

### API 60

Schema 60 adds a required `rollback` action assessment for the retained previous
managed version. It is `not_offered/not_installed` without a previous version,
`not_offered/route_not_offered` if the port has left the current catalog,
`allowed/available` after retained contract, runtime, ownership and critical-file
checks, or `held/missing_runtime` or `held/invalid_installation` when those checks
fail. Status checks are read-only; they neither restore saved data nor grant
execution authority. Rollback rechecks its target under the operation lock and
verifies critical files again after restoring saved data. Current launch or
definition eligibility is not a substitute for retained rollback checks.
Private paired candidates used schemas 58 and 59; they are not included in this
public reference client's compatibility declaration. This contract does not
establish a published standalone schema-60 release.

### API 61

Schema 61 adds exact artifact eligibility reasons `curated_artifact_revoked` and
`curated_distribution_withdrawn`. They project independently admitted immutable
artifact history and the same current hold guard used by execution. Existing
publisher, freshness and launch-baseline failures retain precedence. Revocation
holds affected acquisition and retained local use; withdrawal holds acquisition
without revoking permitted installed use. Retained rollback adds only
`held/definition_ineligible` with `hold/curated_artifact_revoked`; this is an exact
target-artifact refusal, not current-definition permission. Status does not
delete files or saves and still grants no execution authority.

### API 62

Schema 62 adds required `create_assessment` to `backup.list` inventory, with the
shared `backup_create` action. API schema 63 also requires `restore_assessment`
with action `backup_restore`: `waiting/missing_backup` when no usable snapshot
exists, `held/recovery_required` for unfinished restore/deletion recovery,
`held/unsafe_data` or `held/unreadable_data` for an unsafe/unreadable owned root,
and `allowed/available` when snapshot review can be attempted. Preparing restore
records and unrelated damaged history do not hold a usable snapshot. Restore-only
holds do not change Delete's own rules. These read-only decisions supply neither
snapshot integrity nor consent; execution repeats its guards under the port lock.
For creation, `allowed/available` means owned data exists or
launched managed save collection can yield it. Retained owned saves remain
eligible without an install; unknown external saves never become owned data.
`waiting/missing_data` means no data was found; `held` distinguishes recovery,
unsafe paths, unreadable data and a bounded `assessment_incomplete` result.
An incomplete preview establishes neither empty data nor an execution limit.
The probe reads retained persistence coordinates without collecting or deleting
mirrors. Malformed historical backup entries alone do not hold creation.
Creation retains its authoritative lock, save collection, tree validation,
publication and recovery checks. Preview existence is not whole-tree integrity
or permission proof. Desktop requires a current inventory before enabling its
action; CLI human inventory displays the same action and reason.

### API 66

Schema 66 requires one `update` action in port status: non-owning/user-prepared
routes and absent managed installs are not offered, current-definition
restrictions are held, and an eligible managed route waits for explicit candidate
review. Status performs no update check and supplies no candidate or execution
authority. An exact `GameUpdatePlan.assessment` reports an already active release
as not offered, an unverified retained copy as held, missing original files or
BIOS for a download as waiting, or a usable candidate as allowed. Verified local
reuse does not reacquire original input bytes. Execution still rechecks critical
files, reviewed identities and consent under the existing per-port lock.

### API 67: external review

Schema 67 adds optional `external.review`. Read `external preview PORT_ID PATH`
or `external removal-preview PORT_ID`, show that exact preview and submit
`external register PORT_ID PATH --expected-preview SHA256 --yes` or
`external remove PORT_ID --expected-preview SHA256 --yes`. Core rejects changed
runtime/contract or registration identity before issuing its existing one-use
authorization and rechecks under the operation lock. These commands never grant
ownership of external files. Omitted fingerprints retain legacy CLI behavior;
interactive clients must advertise/negotiate this capability and send the
reviewed fingerprint. Registration alone does not establish launch readiness.

### API 67: runtime input representation

Schema 67 adds optional readiness `required_source_extension` and the
`incompatible_source` launch blocker/action reason. These describe the effective
runtime's required original-file representation, including its retained contract
after registration. An unchanged registered ZIP may have `source: current` while
launch waits for a validated uncompressed file of that extension. Source identity
health and runtime compatibility remain separate; status never extracts inputs.

### API 68

Schema 68 adds `ghostship200_legacy` to preparation modes. On the exact reviewed
Ghostship 2.0.0 Windows installation, the ordinary default request returns this
explicit mode with plan/receipt format 2. It uses a private zero-argument setup;
other modes retain format 1. Unknown modes or mismatched format/mode pairs fail
closed. The prepared installation retains contract format 4, which older readers
must reject even when mutable runtime data is absent. This interpretation does
not replace the admitted catalog or establish cross-version data acceptance.

### API 70

Schema 70 adds optional readiness `source_assessment` and `bios_assessment`,
plus the `incompatible_bios` blocker/action reason. These assessments bind input
identity and compatibility to the retained installed release; unchanged bytes
alone do not confirm compatibility. Missing legacy facts, unreviewed releases and
unreconstructable observations remain unknown. Unknown compatibility alone is
not a launch prohibition: clients may offer an explained trial/setup action
when Core permits it. Known input rejection is checked again before launch side
effects. Clean process exits and launch-history counts never establish gameplay.
Clients must understand these fields/reasons before accepting schema 70; the
maintained reference reader retains its supported older schema membership.

### API 71: catalog presentation

Schema 71 adds optional catalog presentation `original_game_title` and
`variant_label`. These are descriptive labels: `name` remains the port project's
name, and `id`, source contracts, installations and launch authority are unchanged.
Clients may ignore these additive display fields; a game-led client should search
both game and project names and keep alternative projects as distinct entries.
Older catalog and retained definitions may omit either label.
The same schema adds optional `presentation.manual_setup`: authored numbered
steps, essential warnings and an optional HTTPS help link. These display facts
grant no preparation or operation authority. `manual_preparation` remains the
legacy fallback and the retained detailed compatibility notes.

### API 72

Schema 72 adds `external.relink` and the `relink_external` activity operation.
Read `external relink-preview PORT_ID PATH`, disclose the previous and proposed
folders, then submit `external relink PORT_ID PATH --expected-preview SHA256 --yes`.
The required fingerprint binds the exact retained registration/catalog and the
new folder inspection. A generic registration confirmation cannot authorize a
folder change. Shared preferences require `--acknowledge-shared-preferences`
bound to this outer fingerprint; their accepted account/location cannot transfer.
Core rechecks under the port lock and updates the location atomically. Failure
or cancellation before publication leaves the original registration intact.
Registration ID, timestamp, retained contract and all external files remain.
The old folder may be missing; the proposed folder must satisfy its retained
contract even when the current catalog offers managed installation instead.
This command does not upgrade, copy, adopt, migrate saves or grant managed ownership.
Managed planning, install and update commands refuse an external registration
before resolving a release. Remove the registration explicitly before considering
a separate new managed installation; removal itself does not adopt retained data.

### API 74

Schema 74 adds the optional retained `windows_runtime_path_policy` declaration.
Core enforces it during managed readiness and before launch preparation; clients
must retain Core's readiness/refusal result rather than infer that an installed
runtime can run from every path. Staged-source template version11 is required for
independent definitions using this policy. Operation-event schemas remain unchanged.
