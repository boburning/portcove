# Portcove CLI

Use the standalone CLI to inspect and manage one explicitly selected library.
This guide describes the maintained source contract. Published Alpha 2 contains
API 34 and does not provide the later library-identity, reviewed-first-install,
durable launch-request and activity-feed contracts. Select a [published package](DOWNLOADS.md) for its actual
capabilities, or an [identified compatible candidate](INTEGRATION-AUTHOR.md#choose-a-cli-and-fixture-library)
for current integration development. A local candidate is not a public release.

## Task guides

| Task                                                | Route                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browse, register game files, install and play       | [Using the CLI](#using-the-cli)                                                                                                                               |
| Explore all projects and finish upstream setup      | [Download and finish setup](#download-and-finish-setup)                                                                                                       |
| Choose the library and inspect its identity         | [Library selection](#library-selection) and [identity](#library-identity)                                                                                     |
| Inspect, find or relink original files              | [Game-file tasks](#find-and-relink-game-files)                                                                                                                |
| Check releases, manage updates and inspect outcomes | [Automation and game management](#idempotent-automation)                                                                                                      |
| Keep an exact local build for a stable setup        | [Retained builds and setup references](#retained-builds-and-setup-references)                                                                                 |
| Export metadata and restore copied library content  | [Export and restore](#export-and-restore-a-library)                                                                                                           |
| Move a library or recover a transfer                | [Move](#move-a-library) and [interrupted transfers](#recover-an-interrupted-transfer)                                                                         |
| Request cancellation and establish the outcome      | [Cancel work safely](#cancel-work-safely)                                                                                                                     |
| Resolve disc-tool prerequisites or GitHub access    | [Disc tools](#disc-formats-and-optional-tools) and [authentication](#github-authentication)                                                                   |
| Build a machine consumer                            | [JSON/JSONL reference](#automation-and-integration-reference), [author workflow](INTEGRATION-AUTHOR.md) and [schema history](reference/cli-schema-history.md) |

The [glossary](../GLOSSARY.md) defines domain objects; the
[content-design contract](CONTENT-DESIGN.md) defines human wording. Neither
changes command names, serialized fields, IDs, timestamps or permission checks.

## Using the CLI

Run `portcove --help` for four task groups: **Everyday commands**, **Game files
and library**, **Updates and recovery**, and **Advanced and integration**.
Use `portcove COMMAND --help` for the selected command's arguments, required
review inputs and examples before a consequential action. Help is human
discovery, not a stable parsing contract; machine clients use capabilities,
schemas and JSON/JSONL.
The commands below use `PORT_ID` from
`catalog list`. For a source command, `portcove catalog show PORT_ID` displays the
declared `Game-file profile ID` and `BIOS profile ID` when present; use the
applicable one as `PROFILE_ID`. Substitute paths on your machine. Use `--library PATH` when working with a library other than
the saved default. These examples are human-output commands; automation should
use the [reference below](#automation-and-integration-reference).

1. Browse available ports with `portcove catalog list`, then read a port's game
   file and BIOS requirements with `portcove catalog show PORT_ID`. Use
   `portcove plan PORT_ID` to review what an installation would do.
2. If that port needs your game files, save the required file location with
   `portcove source add PROFILE_ID PATH`. Portcove checks the expected file and
   saves its location; it does not copy, move, or upload it. Use
   `portcove source list` to check saved locations.
3. Run `portcove install PORT_ID` after reviewing the plan. Installation can
   download and activate a managed version, subject to its source and host
   requirements. Use [reviewed first installation](#reviewed-first-installation)
   when the caller needs to bind execution to the exact separately reviewed plan. `portcove status PORT_ID` reports the resulting state. To reuse
   the current install when its required runtime is present, or install a
   selected release, run `portcove ensure PORT_ID`. Check reported launch blockers
   with `portcove status PORT_ID` separately.
4. Start the installed game with `portcove exec PORT_ID`. Portcove supervises
   the process and retains a launch activity; inspect recent outcomes with
   `portcove activity`. Review reported launch blockers first in
   `portcove status PORT_ID`.
5. Check for an update with `portcove check PORT_ID`. To follow the port's saved
   update policy, use `portcove reconcile PORT_ID`; a notify policy can report
   an available update without installing it. Review the current channel and
   policy in `portcove status PORT_ID` before changing anything.
6. For managed saved data, run `portcove backup create PORT_ID`, then
   `portcove backup list PORT_ID` to inspect verified backups and any problems.
   A backup is not a copy of the game files. Review backup and restore
   consequences in `portcove backup --help` before deleting or restoring one.

Human `backup delete` and `backup restore` show the selected archive folder,
exact content and review hashes, UTC creation time, file count and size before
confirmation. The review distinguishes current managed saved data from Core's
safety-backup decision: an existing empty saved-data folder does not imply a
safety backup will be created. Deletion preserves live saved data and other
backups; restoration preserves the selected backup and reports whether a safety
backup is planned before replacement. Declining leaves the reviewed data intact.
`--yes` supplies confirmation but still shows the human review; `--json` and
`--jsonl` retain their existing output without that document. Core rechecks the
reviewed contents when executing the authorized action.

For a port offering **Use an existing installation**, choose its native executable
and working directory explicitly. For example, review
`portcove external select-preview render96ex C:/Games/Render96/sm64.us.f3dex2e.exe --working-directory C:/Games/Render96 --arg=--savepath --arg=!`.
Repeat the same details with `external select`, its `--expected-preview` and
`--yes` to confirm execution intent. Use `--arg=VALUE` once per documented
argument. `portcove exec render96ex` launches the saved selection; `external
remove render96ex` removes only Portcove's reference and preserves every external
file. You or the selected upstream launcher manage setup and updates. Selected
bytes are not certified as an authenticated official package, and this route
offers no managed backup, repair, update, rollback or file deletion. A descriptive
catalog listing is sufficient; a managed definition or declared platform is not
required for this explicit alternative. Script launchers and library-owned paths
are refused; use a supported native executable or native upstream launcher.

### Download and finish setup

`portcove catalog listings` returns the complete descriptive directory, including
projects without managed definitions. `catalog list` and `catalog export` retain
their strict managed-definition contracts. Unknown platform or package facts in
a listing do not establish support. Desktop uses the same directory and lets the
player reset catalog filters with **All ports**.

For a GitHub-hosted upstream project:

```sh
portcove setup candidates PORT_ID
portcove setup candidates PORT_ID --release-id RELEASE_ID
portcove setup candidates PORT_ID --channel beta
portcove setup preview PORT_ID --release-id RELEASE_ID --asset-id ASSET_ID --destination-parent C:/Games --extract
portcove setup download PORT_ID --release-id RELEASE_ID --asset-id ASSET_ID --destination-parent C:/Games --extract --expected-preview PREVIEW_SHA256 --yes
portcove setup pending
portcove setup targets PORT_ID --pending-id RECORD_ID
```

Choose IDs returned by `setup candidates`; Core selects a release by channel and
assesses its packages for this host. The response includes the selected release,
recommendation, reasons, alternatives, coverage and a read-only default download
parent. Explicit release inspection does not require complete older history.
Review the actual package name, source, size, checksum evidence
and new destination. It does not infer that every upstream asset is a playable
package for this computer. Omit `--extract` for an installer or unsupported
archive that the player will handle using upstream instructions. Acquisition
does not run an installer. `setup targets` inspects a completed download for
bounded native launch suggestions without executing files. Registration remains
explicit and may select an executable outside the download folder after upstream
setup; retain its working directory and literal arguments.

Core re-reads the selected release/asset and binds the review to the destination.
A supplied checksum must match. Without an upstream checksum the observed
download hash is recorded with that limitation. Supported ZIP/tar.gz extraction
uses the existing traversal, symlink, collision and expansion bounds. Publication
creates a fresh child folder outside the entire Library root and managed output
locations, with atomic refusal to replace an existing destination.

The downloaded folder becomes user-owned. Its durable **Downloaded—finish setup**
record appears in Library after restart, with **Continue setup** and **Open
folder**. Complete the upstream steps, then use `external select-preview` and
`external select` with the chosen native executable, directory and literal
arguments. The exact matching setup record is retired with registration;
download provenance does not certify the resulting executable or game data.
An interrupted handoff is reconciled from the recorded attempt and publication
receipt. An unresolved attempt remains visible as requiring attention.

`setup forget PORT_ID --pending-id RECORD_ID` forgets only that exact setup
record. It does not remove handed-off files. Each port has one active managed
installation or external registration. A separate downloaded setup may coexist
with an external registration until a reviewed change replaces its launch target.

When an upstream update changes the executable or working directory, use
`external select-relink-preview PORT_ID EXECUTABLE --working-directory DIRECTORY`
and `external select-relink` with the matching `--expected-preview` and `--yes`.
Use `--arg=VALUE` for every reviewed argument. The registration identity and old
external files remain intact. The player or upstream launcher remains the
runtime-replacement owner.

For a fitting native-portable definition, `external managed-preview PORT_ID`
reviews a separate managed runtime while the current external copy stays usable.
`external change-to-managed PORT_ID --expected-preview SHA256 --yes` prepares and
verifies that copy, then atomically switches the saved route. Pass the same
optional `--channel` and `--output-directory` in both commands. The destination
must be separate from the external folder. No external file or save is adopted,
copied or deleted; the new runtime may still read its existing upstream profile
on a later explicit Play. Keep a separate backup of that profile. Core retains
the update policy and rechecks consent, registration, definition, release and
destination. A pre-existing Core data store, shared-account contract, unfinished
download or richer setup requiring an unsupported transition remains held with
the current registration preserved; inspect the offered reason before proceeding.

For an eligible managed portable definition, use the ordinary `plan`, `install`,
`check`, `update`, `activate`, `rollback` and `policy` commands. Portcove owns
runtime replacement through the same lifecycle as deeper integrations. Upstream
first-launch setup can remain responsible for original-file selection. Declared
player data follows the retained persistence contract; outside data remains
outside managed backups. Removing a setup reminder or external registration never
transfers managed replacement/removal rights.

`catalog inspect-listings --path FILE` validates an inert format-1 listing
projection before opening a Library. Validation neither installs an integration
nor signs, accepts or publishes that file. Machine consumers negotiate
`catalog.listings`, `setup.*` and `external.select-relink` through capabilities and
use the exported DTOs; these additions do not relax `PortDefinition`.

### Exact-package registration

An official port that offers an exact-package user-prepared runtime uses a separate route:
prepare the exact accepted package outside Portcove, run `portcove external
preview PORT_ID PATH` against its extracted folder, then `portcove external
register PORT_ID PATH` to review and save a non-owning reference. `portcove exec
PORT_ID` supervises its launch. `portcove external remove PORT_ID` removes only
that reference; it never uninstalls or cleans up external files. The catalog must
actually offer this route for the selected platform. Portcove checks immutable
package files at registration and launch; game-owned output remains outside
Portcove backup and restore. Source files, when required, are registered
separately through the accepted source profile.

For Wave Race 64: Recompiled on Windows, extract the official v1.0.2 ZIP and
create an **empty `portable.txt`** beside `WaveRace64Recomp.exe` before
`external preview`. The marker is a player-created preparation step, not a file
in the upstream ZIP. It is part of the exact accepted tree; without it, review
fails. Portable mode keeps game-owned settings, the copied source, and saves
beside the executable. Portcove does not back up, remove, or restore those files.

Human results lead with the task and its actual outcome, followed by relevant
review fingerprints, retained locations and the next supported action. Ports
and game-file profiles use display names with their operational IDs when the
catalog supplies a name; a missing name does not create a new identity. Batch
summaries count successful items separately from items that did not succeed,
while retaining each failure or cancellation outcome. Byte quantities use IEC
units, such as KiB and MiB, while unknown observations stay explicit.

Timestamps are labeled by meaning, such as Created, Started, Finished, Expires
or Resets, and include an explicit offset (`Z` denotes UTC). A value outside
the supported timestamp range is labeled unknown. Review fingerprints,
consequential file hashes and publisher keys remain complete. `--json` and
`--jsonl` retain their original IDs, byte counts and timestamp fields.

## Path rules

Portcove requires every path that crosses a durable SQLite/JSON boundary or child-process argument/environment boundary to be valid Unicode. On Unix, a non-UTF-8 library, source, install, backup, lifecycle, executable, or generated runtime path fails with `unsupported` instead of being stored or launched through a lossy alias.

Quote paths containing spaces when typing in a shell. Programs should pass
separate arguments with shell execution disabled, as shown in the
[author guide](INTEGRATION-AUTHOR.md#discover-and-bind). Unicode support does not
remove a source profile's format rules, archive/transfer path checks or a
retained upstream runtime's narrower path policy. In particular, whole-library
moves retain their documented portable filename policy; they do not rename or
normalize original game-file references.

## Release channels

Game-port release channels display as **Stable / Preview / Rolling**. Current game-port CLI inputs prefer `stable` / `preview` / `rolling`; `beta` remains a compatibility alias for `preview`. Both Preview spellings select the same existing stream. Canonical JSON, catalog, installation and preference values remain `stable` / `beta` / `rolling`; no serialized `preview` value or saved-choice migration is introduced. Copied commands and integrations may retain `beta` when the intended CLI's Preview input support is unverified, preserving supported older consumers. Changing the spelling does not select a different release. Offered channels, the selected stream and the actual upstream release are separate facts. Preview prefers eligible prereleases and can fall back to an eligible stable release; that fallback does not acquire an upstream Beta/Alpha designation. Original upstream tags/names, application Public beta milestones, qualification evidence and compatibility limitations retain their own meaning.

Use `portcove plan PORT_ID --channel preview`, `portcove install PORT_ID --channel preview`,
`portcove ensure PORT_ID --channel preview`, or `portcove channel set PORT_ID preview`.
The legacy `beta` spelling remains accepted on each route. Inputs remain case-sensitive;
Stable/Rolling spellings, omitted-channel defaults, consent and eligibility checks are unchanged.
Changing a saved channel does not install or activate a release.

## Automation and integration reference

Use the [schema history](reference/cli-schema-history.md) for each affected
document and compatibility change. Current task sections retain operation
preconditions and recovery; a historical API number does not imply a published
package or authorize an operation.

Without a machine-output flag, reads and mutations use task-specific human
summaries or tables. Installation, updates, adoption, source changes, backups,
library transfers and catalog changes describe the returned outcome rather than
printing a generic field tree. Full documents remain available through
JSON/JSONL and explicit export commands. `portcove about` prints the product,
version, description, repository and license without opening a library.
Repeated operational commands do not print banners or artwork.

Human operation progress goes to standard error. An interactive terminal receives an updating inline byte counter. When standard error is redirected, Portcove emits a bounded line for each phase start and its final observed byte count instead of carriage-return updates for every chunk. A partial final count does not imply success; read the command result or retained activity for the authoritative outcome. Machine clients should use `--jsonl` for the full versioned event stream.

`--json` and `--jsonl` remain the stable automation surfaces and are byte-shape independent from human rendering. Use `--json catalog export` and `--json schema export` when consuming their full documents programmatically.

Human `status` keeps managed active/staged versions separate from the registered
external version, labeled user-owned. Both `status PORT_ID` and all-port `status`
group core action assessments by operational port ID and explain their existing
availability and reason codes, including game-file versus BIOS prerequisites and
definition holds. Ports without recorded assessments have no invented action
group. These read-only explanations do not authorize an operation or establish
complete runtime verification, native qualification or gameplay; execution
rechecks its own current inputs and consent. JSON/JSONL contracts are unchanged.

`schema export --contract input` describes values accepted by Rust deserialization,
including omitted fields with defaults. `schema export --contract output`
describes serialized values, including required emitted fields, nullable values
and fields omitted by serialization rules. The default remains `input` for
compatibility. Both modes export the same named schema inventory through
`schema.export`, and neither opens a library. Use the output contract when
checking response consumers; an input default does not mean an output field
will be absent. These are JSON shape contracts, not operation authorization or
validation of filesystem/network state.

The public CLI is the supported boundary for external frontends; the desktop is
not required to run it. [External frontend integration](INTEGRATIONS.md) defines
the launch-only, library, and lifecycle capability vocabulary, maintenance and
support-record expectations, author path, and Steam/Steam Deck boundaries. This
file documents current implemented behavior. Completed
[#30](https://github.com/boburning/portcove/issues/30) records the bounded public
surface audit and [#243](https://github.com/boburning/portcove/issues/243) the
reference-client proof. Their retained checklists do not reopen completed work.
Later consumer gaps require evidence and a current owner; a roadmap statement
does not ship a command or extend compatibility.

The Public beta contract keeps launch-only, library, and lifecycle consumers
independently useful: a basic launcher negotiates only the operations, formats,
schemas, and consequential semantics it uses rather than implementing every
management command. The completed audit covered stable identity,
metadata/artwork references, installation and readiness, requirements, allowed
next actions, stable blocked reasons, update eligibility, operation results, and
launcher-ready program, argument-array, working-directory, and explicit-library
information. Its recorded scope does not qualify the complete Playnite product,
automatic Steam entry management, or a later agent consumer.

That audit also covered verified runtime/library binding, operation-specific and
mixed-version compatibility, batch-read reuse, bounded polling/concurrency,
cancellation, prepared offline behavior, and measured refresh/launch
responsiveness. Budgets follow representative measurements rather than planning
claims. Runtime discovery must not blindly execute an untrusted candidate, and
no gap by itself authorizes a daemon, hidden cache authority, private API, or
standalone CLI self-updater. The implemented behavior below remains authoritative
until an exact reviewed change addresses a demonstrated consumer gap. See the
[public author path](INTEGRATION-AUTHOR.md) for current invocation and recovery
semantics; process-local authorization is not a persistent automation grant.

Future eligibility/evidence and independent-definition work must use one core
assessment across CLI, Tauri and integrations. Operation availability and reasons,
publisher origin/trust, digest provenance, source compatibility and scoped test
evidence must not collapse into one supported flag. Missing gameplay is not a
source mismatch. Observable schema changes require explicit versioning and
legacy/unknown-value handling; this planning contract adds no command or field.

The CLI API schema version is independent of the Portcove release version.

The catalog listing document has its own format version. Readers accept format 1
descriptive directories and format 2 directories with optional
`download_block_reason`. A restriction requires format 2; unknown formats and
invalid reasons are refused. Core uses the restriction for fresh self-service
download options, preview and application. The existing `allowed: false` and
`reason` response drives clients; a client cannot bypass it by retaining an older
preview. Existing registrations, pending setup, Play and registration removal
retain their separate contracts. This additive output field keeps API schema 80
and operation-event schema 3; neither number grants permission or a new command.
Optional per-platform `download_asset_hints` remain advisory within either listing
format. Core consumes them for self-service package ranking when an operational
release does not supply hints. They do not override unavailable acquisition,
authenticate a package, run setup or add a managed operation.
For `setup candidates`, an omitted `--channel` uses Core's authored
`recommended_download_channel`, or stable when absent; an explicit channel wins.
This initial download recommendation never changes an installation's update policy.
Every `--json` result uses this envelope shape (the example is API 78; inspect
the selected runtime's actual version before decoding):

```json
{
  "schema_version": 78,
  "ok": true,
  "command": "status",
  "data": {},
  "error": null
}
```

Human errors use `Error: {safe summary}` and an actual `Next step:` when one
is available, preserving Core's explicit mutation outcome. A stopped operation
uses neutral `Operation cancelled.` wording with any known retained changes or
recovery state. An accepted cancellation request is an acknowledgement; it does
not establish that work has stopped. A failed readback after a known mutation
keeps that mutation outcome separate from the unavailable refreshed state.

`--technical-details` includes redacted technical error context and retained
activity detail. For inert catalog proposal and publication inspections, it
also includes the checked definition or file identities and full hashes. It
does not turn every result into an unrestricted raw diagnostic document.
Human activity entries show their stable ID, catalog-known target, shared
failure summary and observed mutation outcome. Older entries without a structured report do not infer
unchanged files or a resumable operation. Their recorded message and targets no
longer in the current catalog are available only as requested redacted technical
details. Use `activity log <activity-id>` to read any retained phase captures.
Human retained logs preserve newlines, tabs, and Unicode text. Other control
characters are shown as visible escapes (for example, `\u{1b}` or `\r`) so
captured tool output cannot issue terminal instructions. Activity and phase
headers use the same single-line cleaning as other human labels. This display
format does not rewrite retained captures, observed byte counts, truncation or
completion flags, JSON/JSONL data, or the raw game streams from `exec`.
JSON and JSONL keep the original machine error and activity fields.
A new preparation always starts with fresh private work; it does not consume or
automatically delete a failed attempt's retained files.

Known refusal branches attach their own presentation facts for catalog validity
and replay, library versions and locks, changed sources, stale removal reviews,
unfinished recovery, storage and extraction limits, unsupported paths/packages,
and provider API responses. Human summaries give the supported next review or
recovery step without deriving a cause from diagnostics or changing the mutation
outcome. Provider reset times are reported absolute UTC times, not a guarantee
that retry will succeed. Unclassified failures retain the generic presentation.

Errors use the same envelope with `ok: false`, `data: null`, and a stable error code. `--jsonl` emits versioned operation events followed by one final `type: "result"` object. Each event carries `operation_id`, `sequence`, `timestamp_ms`, operation name, optional typed target and parent ID, plus a terminal `result` for success, failure, or cancellation. Event delivery is best-effort; the activity ledger is authoritative after reconnect or restart. Diagnostics never contaminate JSON stdout.

Argument-parser failures also use the machine envelope when `--json` or `--jsonl` is present. Their stable command name is `cli`, their error code is `usage`, and they exit with code 2. The parser's descriptive message may include generated help, so its prose follows help revisions; clients must not parse that wording. Help and version output remain intentionally human-readable even when a machine-output flag is supplied.

The compiled-binary machine contract is exercised on both Windows and Linux CI. These tests treat stdout line count, envelope fields, nested command names, JSONL completion, parser behavior, and exit codes as public integration behavior rather than implementation details.

### Catalog proposal inspection

Maintainer proposal checks use `portcove --json catalog inspect-proposal FILE`.
This inert command reads at most 4 MiB and uses core's existing catalog/schema,
source-reference and declared path/contract validators. Its separate format-1
receipt binds the exact input bytes and canonical typed per-port declaration
hashes. It runs before host preferences or a library are opened. It does not
resolve an upstream release, validate an actual artifact/source, qualify gameplay,
establish publisher trust, change a catalog or permit application. Existing catalog
parsing semantics remain unchanged; the check is not signed-definition admission.
Legacy parsing tolerates unknown fields: raw input hashes bind them, but typed
port hashes and declaration checks do not validate discarded fields.
Malformed/duplicate-key inputs and unsupported or unsafe declarations fail.

### Standalone package and focused build

`catalog inspect-observation <port-id> <file> --repository-id <numeric-id>`
inspects an inert format-1 or scoped format-2 GitHub observation using the embedded catalog and
shared core release policy, without network access or opening a library. Its
machine command is `catalog.inspect-observation`; `schema export` includes the
additive `upstream_observation_report` format-1 contract. Results distinguish
observed facts, metadata eligibility and unassessed trust/admission. See
[Configured upstream observations](UPSTREAM-OBSERVATIONS.md) for bounds,
comparison inputs, hold reasons and operational evidence.

For another reviewed provider, use `catalog inspect-observation <port-id> <file>
--provider-facts`. That explicit mode accepts inert format-3 GitLab or fixed
manifest facts and emits a version-2 provider report with actual provider
identities. It rejects a GitHub repository-ID argument; GitHub keeps its required
`--repository-id`. Inspection performs no network or library writes. The legacy
`upstream_observation_report` schema remains the GitHub format-1 report contract;
provider report versioning and evidence boundaries are described in the
[observation contract](UPSTREAM-OBSERVATIONS.md#additional-reviewed-providers).

Alpha 1 and Alpha 2 retain their published unversioned CLI archive names.
The next-release packaging contract uses `portcove-cli-<version>-<platform>`;
see the [exact names and transition](RELEASING.md#standalone-cli-integration-artifact).
Each archive contains one executable named `portcove` (`portcove.exe` on Windows). The CLI runs without
Portcove Desktop, and Desktop runs without a separately installed CLI. Download
the archive matching the host operating system and processor from the exact
versioned release; a CLI archive is not a graphical or cross-platform portable
application.

From a source checkout, build only the public CLI and its shared core with:

```text
cargo build --release -p portcove-cli
```

That command does not build React/Tauri or require Node, pnpm, the Tauri CLI,
WebView development packages, or the frontend dependency tree. It does require
the repository's pinned Rust toolchain and the host prerequisites of the Rust
dependency graph. Released binaries use native operating-system facilities;
Linux requires the normal C runtime and D-Bus/secret-service integration when
saved credentials are used, while Windows and macOS use their system credential
stores. Standalone means independent of Desktop, not dependency-free.

See [Releasing](RELEASING.md) for exact archive names, checksums, package limits,
and the transition from Alpha 1 and Alpha 2's unversioned CLI archive names.

### Discovery

Read the selected runtime's contracts and current observations before choosing a
mutation. `catalog check-capabilities` checks definition-template requirements;
`capabilities` describes the CLI itself.

```text
portcove --json capabilities
portcove --json schema export
portcove --json schema export --contract output
portcove --json catalog check-capabilities requirements.json
portcove --json catalog export
portcove --json catalog list
portcove --json catalog show <port-id>
portcove --json storage
portcove --json doctor
portcove --json plan <port-id>
portcove --json paths <port-id>
portcove --json backup list <port-id>
```

Call `capabilities` rather than assuming commands or platforms. It reports both the machine `schema_version` and the running `product_version`; integrations should branch on advertised capabilities instead of parsing either version string. `raw_stream_commands` identifies commands such as `exec` that intentionally cannot use the advertised machine formats. Generate bindings from `schema export` when useful, and tolerate additive object fields within a schema version. Portcove's own desktop declarations are checked against that export by `just check-rust`, including all catalog adapters, shared enum values, and the top-level fields of transported DTOs.

`catalog check-capabilities <file>` reads a bounded local requirements document
without opening the library or making network requests. Its report distinguishes
unknown templates from unsupported contract versions. A valid check exits 0 even
when `data.compatible` is false; invalid requests fail normally. Matching installed
template versions does not authorize loading, installation or execution. See the
[request format and limits](DEFINITION-DELIVERY.md#implemented-engine-capability-negotiation).

Completed [#30](https://github.com/boburning/portcove/issues/30) and
[#243](https://github.com/boburning/portcove/issues/243) provide the scoped public
contract and reference-consumer proof. Use the [current reference compatibility
window](INTEGRATION-AUTHOR.md#discover-and-bind) and
[document-specific schema history](reference/cli-schema-history.md), including
unknown consequential values and required readback. Alpha may make announced
breaks; negotiate the selected runtime rather than infer compatibility from its
product version. Later gaps need their own demonstrated owner and migration.

`doctor` is a local, network-free, read-only host report. Observation commands such as `status`, `activity`, `storage`, and `doctor` do not advance cancellation or lifecycle recovery merely by opening core state. A later mutating command, desktop startup, or explicit desktop orphan-discovery pass performs locked recovery; a repair-plan read can therefore report a retained journal before that pass. It returns the current platform, library capacity, catalog/installation/source counts, one typed entry for each optional host tool Portcove can use, and a repair plan. The repair plan distinguishes retained private preparation from other partial lifecycle operations, cleanup-pending private trees, missing registered install paths, and untracked final directories. It proposes an action but never mutates or deletes files. Tool state is `available`, `missing`, `misconfigured`, or `unsupported`; an available tool includes its resolved path and whether it came from an environment override, saved host preference, or reviewed discovery. Missing optional tools do not fail the command because callers may never select a port or source format that needs them. An invalid environment or saved path remains `misconfigured` instead of silently falling back to another executable. `status` and `doctor` never initialize missing per-port settings; their in-memory defaults come from the catalog, choosing stable when offered and otherwise the port's first declared channel. A later policy-only change persists that same catalog default.

`catalog list` is a concise port array and `catalog show PORT_ID` retrieves one port. The human detail view includes the catalog-owned installation method, required game/BIOS labels and verification method, saves/settings behavior, and upstream state without exposing adapter IDs. For a user-prepared runtime, it also lists each accepted platform/version, exact package filename, byte count and SHA-256, and executable from the definition. Keep the catalog's manual preparation steps and required player inputs; return with the displayed external-preview command on the matching platform for exact-file review. The runtime remains user-owned and Portcove does not download or update it. These catalog facts describe accepted inputs; registration and current operation eligibility are assessed separately. `catalog export` returns the complete versioned `CatalogDocument`, including every source profile referenced by a port and its optional additive presentation object. External frontends should use that document when they need accepted source extensions, exact multi-file or disc requirements, source labels, or presentation facts instead of copying Portcove's embedded catalog. Older catalogs can omit presentation; consumers must handle that absence explicitly.

### Output placement and per-port relocation

Inspect future placement and request the relevant read-only preview or move plan:

```text
portcove --json output show <port-id>
portcove --json output preview <port-id> [path]
portcove --json output move <port-id> <path>
```

Changing future placement does not move an existing installation. After reviewing
the exact destination and fingerprint, choose the applicable setting action:

```text
portcove --json output set <port-id> <path> --expected-preview <sha256> --yes
portcove --json output reset <port-id> --expected-preview <sha256> --yes
```

Relocation is a different operation. Apply its exact reviewed plan only when the
copy, authority change and old-copy cleanup are intended:

```text
portcove --json output move <port-id> <path> --apply --expected-plan <sha256> --yes
```

It covers that port's recorded versions; sources, saved data and backups stay in
their central locations. A pending old-copy cleanup leaves the new paths
authoritative and is reported explicitly. See the retained
[placement](reference/cli-schema-history.md#api-23) and
[relocation](reference/cli-schema-history.md#api-25) contracts for capacity,
ownership, stale-plan and recovery guarantees. This is separate from a
[whole-library move](#move-a-library), which retains the original library as a
recovery copy.

### GitHub authentication

#### Anonymous use

Authentication is optional. Anonymous operation remains supported, while a GitHub user token raises the API allowance and lets unchanged conditional requests return `304 Not Modified` without consuming the authenticated primary limit.

#### Device sign-in

```text
portcove auth login
```

`auth login` uses GitHub's device authorization flow with Portcove's public GitHub App client ID. `PORTCOVE_GITHUB_CLIENT_ID` can override it at runtime or build time; an explicitly empty override disables device login. Its polling wait is asynchronous, follows GitHub's pending and slowdown intervals, reports expiry or denial as typed errors, and can be cancelled with Ctrl-C. Authentication calls fail after ten seconds without a connection, fifteen seconds without response progress, or sixty seconds overall; a retry starts a new intent, so an older delayed token or device completion cannot replace it or a later logout.

#### Supply a token

```text
portcove auth set-token
```

`auth set-token` reads interactively with hidden input, or from standard input when `--stdin` is present. A token is deliberately never accepted as a positional option because command arguments can be exposed through process inspection and shell history. Tokens saved by either flow go to the operating-system credential store. For scripted input, use the explicit standard-input route, for example in
PowerShell:

```powershell
Get-Content $tokenFile -Raw | portcove --non-interactive --json auth set-token --stdin
```

#### Inspect or remove credentials

```text
portcove --json auth status
portcove --json auth logout
```

`auth logout` removes that saved credential; it cannot remove an
environment-provided token.

Automated frontends normally provide `PORTCOVE_GITHUB_TOKEN` in the child-process environment and avoid interactive auth commands. `auth status` reports only the credential source, GitHub login, and rate-limit headers; it never returns the token.

Authentication does not bypass original game-file, artifact, source or operation checks.

## Find and relink game files

Use `catalog show PORT_ID` to identify the applicable game-file or BIOS profile.
A saved discovery folder, an inspected candidate and a registered source are
different objects; none alone grants installation or launch permission.

| Task                                 | Command                                                      | Mutation boundary                                                            |
| ------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Inspect a registered source          | `source inspect PROFILE_ID`                                  | Reads current facts without changing bytes or the saved baseline.            |
| Compare registered bytes             | `source verify PROFILE_ID` or `source verify --all`          | Rechecks the saved baseline; bulk results need per-profile inspection.       |
| Find possible files                  | `source discover --root PATH --profile PROFILE_ID`           | Reads only the requested scope; candidates remain unregistered.              |
| Save discovery folders               | `source roots add PATH` / `source roots relink ROOT_ID PATH` | Changes the saved search input, not source registration or files.            |
| Register a known file                | `source add PROFILE_ID PATH`                                 | Validates and saves its location; does not copy, move or upload it.          |
| Correct a registered file's location | `source relink PROFILE_ID PATH`                              | Review only until the same inputs are applied with the returned fingerprint. |
| Forget a registered file             | `source remove PROFILE_ID`                                   | Requires confirmation and removes only the reference.                        |

### Register and inspect

`source inspect PROFILE_ID` inspects an already registered source and takes no
path argument. To review an unregistered candidate, use
`source inbox import PROFILE_ID PATH` with the intended mode, then apply only
its returned plan; use `source add PROFILE_ID PATH` for deliberate current-location
registration. Discovery itself does not register a candidate.

`source add` validates the configured extension plus any exact SHA-1 and SHA-256 allowlists before recording the source reference. A source that matches the game name but not the required revision fails with `source_invalid` and exit code 5. An `upstream-validated-disc` profile is deliberately two-stage: registration records and later rechecks the local ISO/CHD container, while exact retail-revision admission is delegated during setup to a checksum-verified upstream extractor with fixed catalog arguments. Extractor rejection is returned as the same structured `source_invalid` failure before the game can launch.

### Use a location, copy or move game files

The Source Inbox route can review three different consequences. Registration
through ordinary `source add` still uses the selected file in place.

| Import mode            | Consequence of applying the reviewed plan                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use-current-location` | Validate and register the selected original location without copying its bytes.                                                                       |
| `copy`                 | Publish a checked managed copy and register it; keep the original.                                                                                    |
| `move`                 | Register the checked managed copy, then remove the original only within the separately authorized Move. Failed cleanup reports the retained original. |

Inspect the profile folder or scan it with the existing bounded route:

```text
portcove --json source inbox path <profile-id>
portcove --jsonl source inbox scan <profile-id>
```

`source inbox open <profile-id>` additionally creates the validated profile folder
and asks the host file manager to open it. For an explicit Copy, first review:

```text
portcove --library <path> --json source inbox import <profile-id> <source-path> --mode copy
```

After checking the source, registered state, destination, byte requirement and
plan fingerprint, apply that same selection:

```text
portcove --library <path> --jsonl source inbox import <profile-id> <source-path> --mode copy --apply --expected-plan <sha256>
```

Changing mode requires a new review. Move also requires its separate confirmation
(`--yes` for an authorized unattended caller); generic registration or Copy
consent cannot authorize removal of the original. A checked-copy reuse does not
remove that Move consequence. Retain any reported original or private recovery
material and follow the actual result. The [source-import contract](reference/cli-schema-history.md#api-32)
retains version-specific directory-member, capacity, locking and interrupted
publication guarantees.

### Saved discovery folders

Saved game-file folders are explicit catalog-wide discovery inputs, separate from
profile registrations:

```text
portcove --library <path> --json source roots list
portcove --library <path> --json source roots add "D:\Games"
portcove --library <path> --json source roots relink <root-id> "E:\Games"
portcove --library <path> --json source roots remove <root-id>
portcove --library <path> --json source roots scan
portcove --library <path> --json source roots snapshot
```

Adding requires an available directory and returns the existing stable identity
when the same canonical folder is already saved. Listing retains unavailable
folders so a disconnected drive does not erase user intent. Relinking preserves
the root identity after a mount or path change. Removing forgets only the saved
folder; it does not modify files, source registrations, or managed installs.
Scan uses the shared bounded discovery limits described below, records their exact
values with the resulting candidates, and replaces the prior snapshot only after
success. Snapshot reads that evidence without scanning or registering candidates.

### Disc formats and optional tools

`tool list` identifies each fixed tool's purpose, effective resolution and
official setup reference. `tool set-path TOOL_ID EXECUTABLE_PATH` saves a path
only after the tool's fixed probe succeeds; `tool clear-path TOOL_ID` clears the
saved choice without removing an environment override or modifying a library.
Optional tools are needed only for the selected source/preparation route.

Managed PlayStation recompilation profiles accept CHD sources. Pass one `.chd` path for a single-disc title. For a declared multi-disc title such as Final Fantasy VII, pass one directory containing exactly the required `.chd` files with filenames that sort in disc order:

```text
portcove --library <path> --json source add twisted-metal-4-psx "D:\ROMs\Twisted Metal 4.chd"
portcove --library <path> --json source add final-fantasy-vii-psx "D:\ROMs\Final Fantasy VII"
portcove --library <path> --jsonl ensure mortal-kombat-4-recompiled --source "D:\ROMs\Mortal Kombat 4.chd" --bios "D:\BIOS\scph1001.bin"
```

Portcove uses `chdman` only inside operation-specific staging to validate normalized disc content or perform a catalog-declared conversion. It checks `PORTCOVE_CHDMAN`, `PATH`, its own executable directory, `MAME_HOME`, launcher-provided `RETROBAT_ROOT` paths, EmuDeck's backend tool path, and the normal MAME/Batocera system paths. A missing tool fails with structured `searched_paths` and `setup_hint` details; Portcove never silently downloads an executable. A declared `--bios` is independently checked against its catalog source profile, registered for future updates, passed to the reviewed generator, and removed from staging after its generated backend is built. Managed PS1 runtimes mount the original registered CHD by default. A reviewed multi-disc entry may instead retain numbered raw tracks and deterministic cue sheets when the upstream runtime cannot read CHD; Portcove verifies the extracted aggregate against the registered source, marks every retained disc file critical in the immutable install manifest, and still rechecks the original CHDs before launch. The manifest-covered base config uses relocatable relative cue paths. Each launch derives an exact core-owned runtime config with absolute cue paths after immutable verification and explicitly directs memory cards to the port's persistent `saves` directory, leaving the installed discs and base config unchanged.

GameCube source profiles accept the catalog-declared ISO/GCM and compressed RVZ/CISO/GCZ/WIA formats. Portcove validates the normalized ISO hash and records the original container hash separately. When a port needs an ISO in its managed runtime, the same locally supplied DolphinTool performs a transactional conversion. Discovery checks `PORTCOVE_DOLPHIN_TOOL`, `PATH`, Portcove's executable directory, `DOLPHIN_HOME`, launcher-provided `RETROBAT_ROOT` paths, common Unix locations, and the standard macOS app bundle. Missing tooling fails with structured setup details and never triggers a download.

File-set profiles take one directory or ZIP path. Every required top-level member is matched by its catalog filename allowlist and exact SHA-1, SHA-256, and/or CRC32 identity; missing members, duplicate alternatives, nested ZIP entries, and directory symlinks fail closed. The source record aggregates all member identities, records a ZIP container identity separately, and launch can transactionally stage each reviewed member to a separate managed destination. This keeps the CLI contract one-path-per-profile for external frontends even when a port requires a cartridge, disk, firmware, or arcade ROM set.

A reviewed single-disc PS1 port may request `psx-bin-cue` runtime materialization. Portcove uses the same registered CHD and local `chdman` trust boundary to create one cue sheet and split track BIN files in a staging directory, then swaps the complete directory into the managed release. A reviewed multi-disc profile may instead request `psx-raw-set`, which validates each filename-sorted CHD and transactionally writes numbered raw data tracks such as `disc-01.bin`. Managed recomp ports also retain one normalized cue sheet per single-track disc for runtime selection. A failed extraction leaves the prior runtime directory intact. Original CHDs remain the registered sources and are never modified.

### Check registered files

Source integrity checks are local, network-free, and read-only:

```text
portcove --library <path> --json source inspect <profile-id>
portcove --library <path> --json source verify <profile-id>
portcove --library <path> --json source verify --all
```

Verification reruns the source profile validation and compares the current content and storage identities with the baseline stored by `source add`. It never replaces that baseline, changes source bytes, or writes an activity row. A missing or changed file fails a single-profile command with the normal structured error and exit code. `--all` returns one failure-isolated outcome per registered profile; completing the batch returns exit code 0, so consumers inspect each outcome's `ok`, `result`, and `error` fields. An empty registry returns an empty successful batch.

`source remove <profile-id>` first returns or prints a preview containing the exact registered source, every catalog port that shares it, the currently installed dependents, and a confirmation token. Removal requires interactive confirmation or `--yes`; core rejects the token if the source identity or installed-dependent set changes before deletion. Only the reference is removed. Original source bytes and managed installs are never deleted.

### Relink moved game files

After moving a source yourself, review its new location without resetting its
content identity. Apply only the returned plan after checking the old and new
paths and matched content:

```text
portcove --library <path> --json source relink <profile-id> <new-path>
portcove --library <path> --json source relink <profile-id> <new-path> --apply --expected-plan <preview_sha256>
```

The preview validates the new path against the current catalog profile and the registered content hash and size; the old path may be offline. It returns the original record, validated replacement, and `preview_sha256` without changing either file or the registry. Apply takes the profile and dependent-port locks, revalidates the replacement, and rejects a stale plan if registration, catalog rules, location, or validated bytes changed. A different container is allowed only when its normalized content is identical. Settings → Game files → Update file location uses the same core operation. Registration, relinking, and removal fail with a conflict while a dependent port is running or another source writer holds the profile lock.

On Windows and Linux, selecting a converted disc for inspection or registration uses the same bounded immutable snapshot and positive decoder-tree closure as discovery. Explicit selection has no scan batch or hashing allowance; each original and decoded disc is limited to 2 GiB, and a selected PSX directory has a complete inventory bound of 16,384 top-level entries. Ordered sets retain one inventory and recheck every original after conversion before admission. A changed, incomplete or unavailable input cannot create a registration. Unknown decoder closure retains private evidence.

Selected file sets allow at most 512 MiB per member and 2 GiB in aggregate. File-set ZIPs also allow at most 2 GiB of container bytes, 4,096 entries and 16 MiB of metadata. Source ZIP verification uses a private temporary snapshot and needs corresponding temporary disk space. Limit failures and cancellation preserve original source bytes and registered baselines.

### Opt-in source discovery

Human output describes the searched scope, processing limits, scan issues and omitted issue count. An empty candidate list describes only inspected inputs; it does not prove that a matching file is absent or invalid. Candidates keep their content and stored-file hashes/sizes separate. The summary names the explicit registration command; discovery never registers, installs or launches a game. JSON and JSONL retain the existing exact report fields.

```powershell
portcove --json source discover --root D:\Sources --profile minish-cap-gba --profile super-smash-bros-64
portcove --json source add <profile-id> <candidate-path> --expected-sha256 <candidate-sha256>
```

Discovery requires explicit roots and source profiles. It never registers a match automatically. Like saved-folder scans, one-off discovery refuses roots inside the selected Portcove library or its registered managed output and visibly skips those owned subtrees within a broader root before charging scan budgets. Explicit manual inspection and reviewed source registration retain their own validation paths. Defaults are 10,000 examined entries, six nested directory levels, 2 GiB per file, 16 GiB of hashing per saved batch, and 64 combined exact matches and preliminary selections. The corresponding `--max-entries`, `--max-depth`, `--max-file-bytes`, `--max-hash-bytes`, and `--max-candidates` flags can narrow these limits; core also enforces hard ceilings. The report identifies searched scope, validated candidates, hashed bytes, reached limits, and bounded per-path issues. A partial search is not evidence that every file was considered.

Exact-hash original-file, cartridge-ZIP and complete schema-2 directory/ZIP-file-set profiles participate automatically. Directory sets use the shared inspector: every required member must resolve uniquely within one completely examined directory and match one coherent variant. Member hash work shares the request-wide budget with ordinary files; raw observations are reused without sharing admission. File-set ZIPs use the same exact matcher with unique safe top-level members, bounded entry inventory and expanded member sizes, and budgeted/cancellable member plus container hashing. Their facts are shared across file-set profiles without sharing admission; missing or ambiguous member inventories consume no hashing budget. Exact schema-2 uncompressed GameCube ISO/GCM sources use the same disc matcher and bounded raw-file reader, sharing one byte observation across applicable profiles. Exact STFS LIVE compound sources, including extensionless packages, use a bounded four-byte eligibility probe, one raw hashing pass shared across applicable profiles, and the existing structural validator only after an exact compound digest match. Probe, hashing and validation use one open handle with location, object and metadata checks; structural validation adds bounded reads beyond reported hash bytes. Unrelated files are not hashed by this probe. Compressed GameCube and PSX CHD contracts participate through the shared schema-2 disc matcher. CISO uses a bounded sparse normalized stream. Tool-based GCZ/RVZ/WIA/CHD inspection requires an admitted decoder and verified process-tree closure; this route is available on Windows and on Linux kernels permitting the decoder-only user/PID namespace supervisor. Linux launch requires clone3 with an atomic namespace-init pidfd, private startup acknowledgement, and terminal waitid(P_PIDFD) closure; unavailable kernel capabilities fail inspection without falling back to a process-group proof. Other platforms report these inputs as uninspected and explain the required normalized/direct-selection route. Complete PSX sets require the full ordered directory inventory, every member and fresh original-byte verification; partial or mixed sets do not become exact candidates. Decoding uses private local snapshots and outputs, never writes to connected folders, and never registers a source. Missing tools, unsafe metadata, resource limits, changed bytes and unknown closure remain explicit failures, not known mismatches. ZIP-wrapped STFS is not accepted. Extract and select or scan the original LIVE package. Pinned-validator disc profiles also participate through read-only preliminary selection using the shared inspector. These results appear separately in optional `preliminary_selections` as full inspection records with structural admission and validator `not_run`; they are not exact matches or proof of compatibility. The `candidates` collection and progressive `source_candidate` events keep their exact-match meaning. Both result collections share the cumulative candidate allowance and byte observations. Desktop offers a deliberate current-location review that rechecks the selected bytes; discovery never invokes the pinned validator. Old reports omit the advisory collection and remain readable as an empty collection. Scan format 12 marks older coverage stale while retaining readable versions 1–11. Other source contracts still require manual selection. A reached processing limit remains partial coverage. One-off `source discover` starts anew. Saved `source roots scan` requests with the same recorded inputs and limits resume entry- or hash-limited work, including after process restart. Each batch replenishes the entry and hash processing allowances; reported hash bytes remain cumulative, including repeated inspection work. An unfinished file or directory file set is retried from fresh bytes in the existing bounded cursor. Previously emitted identical candidates are not repeated, and different source/profile/representation facts remain distinct. If one indivisible inspection cannot fit a fresh hash allowance, coverage remains explicitly limited with guidance rather than offering a no-progress retry. Candidate, checkpoint-storage, metadata-work, depth, file-size and archive/path/symlink safety limits remain cumulative or unchanged. Cancellation preserves the last published checkpoint. Scan format 12 invalidates earlier continuation semantics without discarding readable historical reports.

Saved scan snapshots add optional `coverage` and opaque, internally validated `continuation` fields without changing API schema 57, request fields or discovery-report fields. Coverage reports cumulative batches, this batch's examined entries, re-listed entries, metadata checks, prior-batch file-set member rehashes, pending directories and whether continuation is available. Remaining entries are unknown until a frontier is exhausted without limits or issues; zero never promises coverage for unavailable or omitted inputs. Re-listing and metadata checks have a separate 100,000-work ceiling per batch. Continuations retain at most 16,384 observed paths and a conservative 4 MiB construction charge within the existing 8 MiB snapshot ceiling; Reaching a continuation storage or work bound publishes the current report as terminal partial coverage, discards the cursor, and requires narrower folders for further progress. Prior file-set hashes are never persisted as admission authority: prior-batch members are rehashed against the current batch hash allowance when their directory completes.

Saved-folder records, catalog, limits, platform, output ownership, or recorded filesystem metadata changes refuse the continuation and preserve the prior report with `restart_required`; the next explicit scan starts fresh. Invalid cursor data follows the same refusal path. Snapshot publication compares the previous raw checkpoint, saved-root records and managed-output registry in one transaction, so concurrent writers cannot overwrite each other's progress. Metadata checks detect recorded changes, but neither continuation nor snapshot readback proves current file bytes; accepting a candidate still revalidates it through the normal source path. Symlinks and entries outside the selected canonical roots are skipped. Equal profile contracts share hashing; both normalized ZIP payload and original container bytes count toward the budget. Accepting a candidate with `--expected-sha256` checks the current profile and reviewed content under the normal source locks before registration. Settings → Sources → Find source files exposes the same search, cancellation, and explicit acceptance.

## Cancel work safely

### Cancellation

```text
portcove --json activity
portcove --json cancel <activity-uuid>
```

The activity feed always includes current and actionable rows independently of
the requested terminal-history limit. Consumers must use its completeness fields
instead of treating absence from bounded terminal history as proof that no work
exists. An active cancellable activity reports `cancellation.phase` (`preparing`
or `finishing`) and `cancellation.requested`. `cancel` accepts only a running
preparation and returns request acknowledgement. Wait for the operation or ledger
to report its terminal outcome. A completed cancellation has status/error code
`cancelled`, a schema-2 finished event with `result: cancelled`, and exit code 130
for the cancelled command. A late request returns `conflict`; it cannot interrupt
publication. Existing failure-isolated batch commands still return per-port
outcomes, which must be inspected individually.

Ctrl-C requests cancellation of this CLI command's current and queued source discovery, release checks, install, update, ensure, or reconciliation work, then keeps waiting. Unix SIGTERM uses the same path. Another client's operations are unaffected. Downloads and hashing stop cooperatively; extraction, conversion, or compilation may need to finish their current preparation step. Repeated signals do not force an unsafe publication interruption. If requesting cancellation fails, the signal warning uses the core human summary without raw error messages, local paths or technical context, and keeps waiting for a safe terminal result; it does not report the operation as stopped. Restore, library transfer, migration, and game supervision retain their existing recovery/lifetime behavior. Desktop game details and activity history offer the same core cancellation request; source search also keeps its own Cancel search control inside its dialog.

## Select a library

### Library selection

```text
portcove --json library show
portcove --json library set <existing-directory>
portcove --json library reset
```

Library selection uses `--library` or `PORTCOVE_LIBRARY` for one invocation, then the saved host preference, then the platform default. `library show` reports the resolved root and `invocation`, `saved`, or `platform_default` provenance without opening a library. An explicit invocation remains available when saved preferences are malformed or from a future format.

`library set` accepts an existing empty directory or a recognizable Portcove library, canonicalizes it, and publishes only the host preference. It rejects missing paths, files, symlinks, filesystem roots, unrelated nonempty directories, and a choice that would place preferences inside the library. It does not move or initialize the selected directory. `library reset` replaces damaged or unsupported preferences with format 1 and restores platform-default selection without opening that library. The desktop clears only the library preference when opening the platform default from a valid document; a damaged or future-format document requires the explicit full reset. A live desktop switch first drops adapter-owned handles and refuses while an already-dispatched operation still holds the old library; successful switches remount UI data against a new library generation.

The preference document lives in Portcove's platform configuration directory, outside movable library data and credential storage. `PORTCOVE_PREFERENCES` may select an alternate absolute preference file for portable/test hosts; it does not change library precedence or make a relative path valid.

### Library identity

```text
portcove --library <path> --json library identity
```

This opens the resolved library through normal core initialization and returns
`library.identity` with `data: {"id": "<opaque-library-id>", "root": "<effective-path>"}`.
A new library is initialized if needed; use `library show` for selection inspection
without opening it. A completed managed move redirects an old root to the effective
location. Both locations report the same ID. Malformed, future or recovery-gated
libraries report the existing structured errors instead of manufacturing an ID.

Treat `id` as an opaque, case-sensitive string and `root` as a canonical current
location. Windows paths may use the extended-length prefix.
Refresh, game update, rollback and managed library moves do not create a new library
identity. A supported metadata/content import preserves the destination's own
identity (creating one for a new destination), while preserving exported installation
IDs. It never replaces that ID with the source library's ID. A raw SQLite copy is a
replica with the same ID, not a supported way to create an independent library.
The ID is neither a credential nor proof of ownership, artifact integrity or qualification.

Use the library ID plus catalog `port_id` as a library entry key. Installation IDs
identify retained versions within that library; update creates a new installation,
while activation/rollback changes pointers among retained IDs. Use `(library ID,
installation ID)` when tracking installations across libraries and imports. Never
use titles, display versions, array order or mutable paths as identity. The library
ID does not replace operation/session IDs or the Desktop generation used to reject
stale requests. Tauri's `get_library_identity(generation)` reads the same core record
under the current generation and lease; Desktop continues to call core directly.

### Local artwork

```text
portcove --json artwork show <port-id> --slot cover
portcove --json artwork import <port-id> <image.png> --slot cover --expected-revision <revision>
portcove --json artwork reset <port-id> --slot cover --expected-revision <revision>
portcove --json artwork clear-cache
portcove --json artwork unused
portcove --json --non-interactive artwork remove-unused <asset-sha256> --yes
```

Slots are `cover` (default) and `detail`; their selections are independent. Read the
current choice revision before changing it. Omitted `--expected-revision` captures
the current revision at command execution; interactive clients should pass their
reviewed revision so stale selections fail explicitly. Reset increments the
revision and returns to fallback, retaining copied originals. Removal requires an
unused asset and explicit confirmation; external source images are never removed.

Core copies static PNG/JPEG images into library-owned storage, preserves the first
filename/import time for deduplicated content and reports `available`, `unavailable`
or `fallback`. The additive schema-49 `resolved_source` field identifies the source
core resolved before a client transports or renders it, while `generated_fallback`
supplies a deterministic identity, style version, initials and palette for every slot.
Available local imports resolve first. A missing/changed import retains the explicit
choice and local provenance while core resolves the generated fallback; restoration
resolves the same local asset again. A client that cannot safely transport or decode a
resolved local preview displays the generated fallback and must disclose that actual
rendered source without changing the durable choice. The generated fallback uses no external image asset. Local hashes
describe integrity, not rights or authenticity; copyright permission for imports
remains unknown. Artwork errors do not block normal catalog or game lifecycle operations.
The [architecture limits](ARCHITECTURE.md#local-artwork-ownership) apply to both
encoded input and decoding. Clear-cache removes disposable derived thumbnails
and fetched catalog-default JPEG originals, which are rebuilt when requested by
a client. A reviewed catalog cover can resolve
as the default for a mapped cover slot through the fixed IGDB image CDN path.
The CLI does not search IGDB through these local-choice commands.

API 67 also advertises optional `artwork_handoff_schema: 1`, `artwork.handoff`
and `artwork.handoff-bytes`. These read-only destination observations export
semantic role, exact library/port/choice revision, accepted source provenance and
availability; the bytes route additionally requires the observed library ID,
revision and asset digest. V1 returns only validated durable local Cover originals
as portrait bytes. Catalog defaults and unprovided landscape/hero roles remain
explicitly unavailable, without provider requests or disposable-cache export.
See the [destination contract](INTEGRATION-AUTHOR.md#destination-artwork-handoff)
for commands, strict v1 schemas, byte validation and destination preview obligations.

## Export and restore a library

### Library metadata

Format 3 includes local artwork choices and copied-image identities. Include the
`artwork` tree when copying the separate payload backup; `artwork-cache` contains
disposable derived thumbnails and fetched catalog-default JPEG originals and is
excluded. Formats 1 and 2 remain importable
without artwork. Clients that do not understand format 3 must reject it; SQLite
schema 24 also prevents older clients from writing the upgraded library. Per-game
saved-data backups keep their existing scope.

```text
portcove --library <path> --json library export
portcove --library <path> --json library export --output <new-file.json>
```

Export reads one consistent SQLite snapshot. The versioned metadata document contains source references, managed version identities, active/previous/staged state, per-port preferences, and successful launch history. Application versions, user data, Source Inbox, backups, toolchains, and local artwork are identified as separate content roots; their contents and credentials are not embedded. The lazy `runtime-sources` cache is rebuildable from a registered source and is deliberately excluded from metadata, import, move, and backup content roots. Managed installation paths become relative to the original library root, while source references retain their original paths and identities. Format-1 Alpha 1 metadata without a Source Inbox root remains importable.

Without `--output`, the document appears in the normal CLI response. With `--output`, core writes a raw metadata document to a new file and returns its path, byte size, and SHA-256. Publication does not replace an existing file. Settings → Library → Export metadata invokes the same operation through a native save dialog.

### Library imports and recovery

`library import --help` identifies the metadata file separately from the payload
folder, explains the new-or-empty `--library` destination and shows the read-only
review route. `--expected-plan` is the exact plan SHA-256 from that review;
changed metadata or payloads require a new review. Recovery help explicitly uses
`--library <destination>`: resume preserves the input backup, while abort retains
the copied files and leaves the incomplete destination closed.

#### Preconditions and review

Use a trusted metadata export and its separately copied content roots. Format 3
includes `versions`, `user`, `source-inbox`, `backups`, `toolchains` and `artwork`;
follow the selected export's content-root inventory for older formats. The
metadata file alone cannot restore these bytes. Select a new or empty destination
explicitly; import does not merge an existing library.

```text
portcove --library <new-or-empty-root> --json library import <metadata.json> <copied-library-folder>
```

Review reads only the explicitly selected metadata and content, checks capacity
and portable paths, and rejects existing application/source/settings/history
state. Examine the reported destination, content inventory and plan fingerprint.

#### Apply the reviewed import

Only after reviewing that exact plan, repeat the same inputs with both flags:

```text
portcove --library <new-or-empty-root> --json library import <metadata.json> <copied-library-folder> --apply --expected-plan <plan-sha256>
```

Apply requires both flags, recomputes the plan, acquires exclusive library access,
copies without replacing existing files, restores metadata transactionally, and
verifies the copied manifests against current platform executable and persistence
rules. Active, previous, and staged identity and source references survive the
round trip. Import does not copy input SQLite, credentials, HTTP caches, or logs;
metadata JSON is limited to 16 MiB and the recoverable inventory to 64 MiB. Source
references remain subject to normal validation and relinking. If interrupted,
use the [destination-specific recovery route](#recover-an-interrupted-transfer).

## Move a library

### Library moves and recovery

`library move --help` explains the new destination beneath an existing parent,
the read-only review route and its plan SHA-256 binding. Apply retains the
original as a recovery copy. Recovery help uses `--library <original>` rather
than the destination; abort refuses after authority publication and retains
copied files. Help describes these existing Core semantics without granting an
unreviewed move or changing the machine contract.

#### Preconditions and review

The destination must be a new directory beneath an existing parent. Complete
launch/lifecycle recovery and close other Portcove clients before applying;
every open handle holds a library lease. Review the original and destination:

```text
portcove --library <original> --json library move <new-directory>
```

Review is read-only. The plan identifies the managed content categories, source
references, required working space, and available capacity. It rejects symlinks,
special entries, case-insensitive collisions, and paths outside the conservative
portable ASCII filename policy. Source references stay at their original paths.
Settings → Library → Move library uses the same plan and core operation while
releasing its own cached handles.

#### Apply the reviewed move

Repeat the same inputs with the complete fingerprint from that review:

```text
portcove --library <original> --json library move <new-directory> --apply --expected-plan <plan-sha256>
```

Apply recomputes the reviewed fingerprint, copies with no overwrite, verifies
file inventories, metadata, SQLite integrity and immutable installation manifests,
then switches authority. The original directory is retained as a recovery copy.
Opening that old path subsequently follows the verified relocation, so configured
paths survive an ordinary move. For disk removal or machine migration, configure
the new root directly. Metadata export alone is not a payload backup or import.

Human move review shows the original and destination paths, copied file/folder counts by managed content category, working-space requirement and available capacity, source-reference preservation, and the complete review SHA-256. It states that review has not applied a move and gives the existing `--apply --expected-plan` next step. Completed apply/resume output identifies the actual active library and retained original. An aborted move reports that the move is not completed, the original remains active, and copied destination files remain in place; another move needs a new destination. Resuming an already aborted transfer is refused. JSON/JSONL, schemas and Core review/recovery rules are unchanged.

## Recover an interrupted transfer

Read the reported operation and location before selecting a recovery command.
An import is recovered through its **destination**; a move is recovered through
its **original** directory. `doctor` or `status` is observation, not an implicit
resume, abort or cleanup operation. Never remove authority markers or copied
files to make an interrupted destination appear empty.

| Transfer | Continue the existing operation                                 | Stop within the supported boundary                             |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Import   | `portcove --library <destination> --json library resume-import` | `portcove --library <destination> --json library abort-import` |
| Move     | `portcove --library <original> --json library resume-move`      | `portcove --library <original> --json library abort-move`      |

### Interrupted import

An interrupted import reports `details.import_destination` and `recovery_action: resume_library_import`. Unpublished copies remain closed until recovery succeeds. Resume after publication preserves new destination saves and works with the old backup offline. Abort retains every copied file and keeps the incomplete destination closed; choose a different empty destination for another import. Settings → Library → Import library exposes review, native confirmation, and recovery for the currently configured empty library. This is a trusted local-backup restore, not a merge operation or proof of third-party backup authenticity.

### Interrupted move

An interrupted move blocks normal use until `resume-move` finishes or `abort-move` reactivates an unpublished original. Pass the original directory, including when normal opening is blocked. Abort never deletes copied files, and it refuses once authority publication has begun. An unmarked destination with ambiguous database state is retained for inspection. Startup and the move dialog expose these same recovery actions. Recovery after activation preserves any new destination saves. Do not manually remove authority markers to bypass these checks.

## Manage games and inspect outcomes

### Idempotent automation

```text
portcove --library <path> --json --non-interactive ensure <port-id> [--channel stable|preview|rolling] [--source <path>]
portcove --library <path> --json status [port-id]
portcove --library <path> --json check <port-id>
portcove --library <path> --json check --all
portcove --library <path> --jsonl reconcile <port-id>
portcove --library <path> --jsonl reconcile --all
portcove --library <path> --jsonl update --all [--stage]
portcove --library <path> --json verify <port-id>
portcove --library <path> --json activate <port-id>
portcove --library <path> exec <port-id> -- <game arguments...>
```

Saving a per-port update policy (`policy set`) persists the setting only; it does
not check releases, download, stage or activate anything. `reconcile` explicitly
executes the saved policy. Single-port `update --stage` and staged `activate`
remain explicit separate actions. Desktop likewise saves settings separately,
reviews the exact game release and stage/activate action before execution, and
allows exact staged activation without contacting upstream. A stale release,
source registration, destination, definition, retained state or chosen action
requires a new review. The exported `game_update_plan` schema describes this
core-owned review contract. The desktop's Install action activates the requested
installation; a saved Stage preference cannot silently turn that action into
staging. These are game-update operations, separate from the signed Portcove
application updater.

#### Game updates and review

Human task wording follows the [glossary](../GLOSSARY.md) and
[content-design guidance](CONTENT-DESIGN.md). **Check installed files** (`verify`)
compares the full recorded installation manifest; its report names that scope
and the actual checked-file count. Launch-critical checks are separate.
**Update saved for later** names a retained staged version, and `activate` applies
that version. A **saved-data backup** covers its declared player files, which can
include more than progress saves; it is separate from original game files,
installed versions and a metadata export. These labels change neither command
names nor the versioned JSON/JSONL fields.

`ensure` returns the active installation when one exists and installs otherwise. `check` is read-only and resolves the latest checksum-qualified release for the selected channel. Stable selection excludes prereleases; beta selects an eligible prerelease when present and otherwise falls back only to an eligible stable release; rolling selects only its exact configured tag. GitHub and GitLab use this same core rule. `check --all` uses the core batch path, runs at most four provider resolutions concurrently, preserves catalog order in its outcomes, and does not retry a rate-limited item implicitly. `reconcile` applies the stored policy: `notify` reports an available release without mutation, `stage` prepares or keeps the eligible version for later without switching versions, downloading only when needed, and `automatic` installs and activates it. Repeated runs reuse the matching staged version, and an automatic run promotes it transactionally. `activate` explicitly promotes the one staged version and preserves the deactivated version as the rollback target.

Destructive or copying operations require `--yes` under `--non-interactive`; after confirmation, core issues a five-minute, one-use authorization bound to the action, target, and reviewed state and consumes it only under the operation lock. Adoption prints a content-hashed copy plan and every skipped symlink or special entry before confirmation.

Desktop's separate immutable acquisition API returns a typed archive identity,
not an installed version. It can transfer and verify bytes while the current
verified managed runtime runs. A later Prepare for later or Apply obtains a fresh
`game_update_plan` and consent under the normal exclusive mutation lock; acquired
archives never imply staged or active state. The existing CLI `update --stage`,
`reconcile`, and `activate` contracts are unchanged. Acquisition interruptions
remain explicit attention-required records with an exact-ID private-archive
discard route; they never automatically prepare or activate on restart. The
[Core acquisition contract](ARCHITECTURE.md#immutable-game-update-acquisition)
owns retention, concurrency and recovery bounds.

#### Launch and retained observation

`exec` is intentionally network-free and GUI-free: it resolves the active executable, working directory, source reference, adapter arguments, and Portcove environment, then inherits standard input/output/error. Because the launched game owns those streams and its process exit code, `exec` rejects `--json` and `--jsonl` with a structured usage error before starting a child; external frontends should use machine mode for management and plain `exec` for launch.

A registered source is rehashed against its stored baseline before install, update, or launch and receives one final identity check after adapter preparation before a child can start. Managed PS1 builds likewise recheck storage bytes around disc materialization and BIOS use. Unmigrated upstream-managed setup records the staged source identity and, after successful validation, replaces the install manifest with one that covers the generated application data before launch. A changed source reruns setup; a partial setup or manifest registration failure starts no child. An unregistered source remains optional at launch for ports whose generated data is already complete. Adapter arguments are prepended to arguments after `--`; persistent catalog paths are restored before launch and collected from the exact launched version after the child exits. Narrow `runtime_mutable_paths` remain disposable runtime output and are excluded from both immutable verification and backup collection.

A port may transactionally materialize a catalog-declared runtime source through N64 normalization, bounded copy/ZIP extraction, GameCube ISO conversion, PS1 CHD expansion, or PS2 ISO/CHD normalization. A schema-2 source marker binds reuse to the current storage SHA-256 and size, so changing bytes at the same path, size, and timestamp forces restaging.

`exec` forwards arguments after `--` literally only to native executables. A cataloged Windows `.bat` or `.cmd` launcher crosses an implicit `cmd.exe` boundary, so Portcove rejects caller-supplied arguments for that launch kind and permits only fixed catalog arguments that pass the batch metacharacter policy. The same core process policy removes GitHub and credential-shaped environment variables from games and every third-party setup, validation, conversion, and builder process while retaining the reviewed host/session variables required for graphics, audio, locale, profile paths, Steam/Proton, Wine, and executable discovery. Native games run in a supervised process group. Ctrl-C, plus SIGTERM on Unix, is forwarded to that group; the CLI keeps supervising until the child exits and exact-install save collection finishes.

External launchers can supply a fresh UUID before starting the raw-stream CLI and
observe it from another process:

```text
portcove --library <path> exec <port-id> --request-id <fresh-uuid> -- <game arguments...>
portcove --library <path> --json launch show <uuid>
```

Omitting `--request-id` preserves generated-ID behavior. CLI UUID arguments are
normalized to the canonical lowercase form; core still validates, locks and rejects
reused retained request identities. A retry needs a new explicit launch decision and UUID.
`launch.show` returns the core session or `null` if absent or expired. It opens the
selected library through normal initialization/relocation gates but does not start,
cancel, recover or otherwise advance lifecycle work. It requires no network or GUI.
The latest 1,000 terminal launch sessions remain readable alongside active sessions.

A record identifies the exact port, installation, supervisor and child. `phase` is
`preparing`, `spawning`, `running`, `collecting` or `recovering`; it describes the
last recorded phase, even after termination. `outcome` is null while unresolved and
`succeeded`, `failed` or `cancelled` when terminal; `exit_code` and `finished_at`
carry the retained result. `started_at` is request acceptance, not a precise game-start
timestamp. `child_pid`/`child_identity` are recorded only after child
creation; they are observations, never authorization for a client to signal a PID.
A running snapshot can become stale immediately. Poll at a bounded interval and stop
on a terminal outcome; never equate CLI process creation, a missing record, lost raw
output, an unknown enum or a stopped wrapper with success. A failure before session
creation can leave no session; retain the CLI error and inspect durable activity or
recovery guidance. Use existing `cancel <id>` semantics where cancellation is still
supported; game signals and post-exit save collection stay with the supervisor.

Status objects include additive `readiness`, `last_launched_at`, `successful_launches`, and `last_update_check` fields. Readiness separates one-time upstream setup from the current game-source and BIOS states: `unregistered`, `current`, `missing`, `unreadable`, `changed`, or `not_checked`. Installed requirements are hashed against their registered storage baseline; uninstalled registrations use `not_checked` so catalog browsing does not imply a current-byte check. `current` means unchanged since registration, not that an informational or extension-only profile gained exact-revision evidence. Missing, unreadable, and changed requirements block launch and route Continue to setup. Install and launch still repeat the full catalog validation at their final use boundary. Launch history advances only after a child process exits successfully; a failed start, crash, or non-zero exit never becomes a Continue candidate. Both the CLI and desktop write the same SQLite record, so external frontends can use these fields without scraping GUI state.

`last_update_check` contains the timestamped successful `UpdateCheck` most recently produced by `check`, `update`, or `reconcile`. It survives process and desktop restarts. Consumers should display it as current only when its channel equals the status channel and its `installed_version` equals the active version; Portcove's GUI applies both guards so activating a release or changing channels cannot leave a stale update badge. A failed network or release check does not overwrite the last successful snapshot, and its error remains available through the command result and applicable activity record.

#### Read current and retained outcomes

Durable management activity is available without scraping transient JSONL progress or the desktop UI:

```text
portcove --library <path> --json activity [--limit 1..200]
```

The result is an `ActivityFeed`. Its `records` are newest-first and contain each
activity once, including the complete current, attention-required and
recovery-required sets for the same SQLite snapshot. The corresponding ID lists
and `active_and_actionable_complete` describe those protected sets. `--limit`
bounds the ordinary terminal-history window to 1–200; it does not cap the complete
feed. `terminal_history_limit`, `terminal_history_count` and
`terminal_history_complete` report that window separately.

Each record has a stable `id`, typed `operation`, `target_kind` (`port`, `source`,
or `library`), optional `target_id`, `status` (`running`, `succeeded`, `failed`, or
`cancelled`), start and finish timestamps, and optional message, structured failure
and cancellation details. Core-managed update checks, install, update, policy
reconciliation, install verification, activation, rollback, backup, restore,
adoption, removal, and source registration all write this same SQLite ledger
whether initiated by the CLI or desktop. Explicit source verification is the
read-only exception and writes no activity row. Listing activity is local,
read-only, and network-free. Portcove retains the newest 1,000 ordinary terminal
records plus still-running records and records protected by pending lifecycle
recovery. Failed attention remains complete within that durable retention policy.
A `running` record means the operation has not reported a terminal result;
consumers should not infer success from it. The desktop labels a record that
remains running for 24 hours as `Unfinished`, but this is presentation only: CLI
consumers retain the original state and can choose a threshold appropriate to
their host.

Storage preflight is also local, read-only, and network-free:

```bash
portcove --library <path> --json storage
```

The response contains the resolved `library_root` plus `volume_total_bytes` and `volume_available_bytes` for the filesystem containing it. LaunchBox, Playnite, RetroBat, EmuDeck, Batocera, and other callers can use the raw byte counts to warn before a large install without scraping platform-specific disk tools. The values describe the containing volume, not Portcove's own footprint.

Before presenting an install or update confirmation, a frontend can resolve Portcove's intended work without mutating installed state:

```bash
portcove --library <path> --json plan <port-id> [--channel stable|preview|rolling]
```

The plan reports the resolved release and asset size, current platform and channel, registered game-source and BIOS requirements, containing-volume capacity, and one typed action: `already_active`, `use_staged`, `reuse_retained`, `blocked_unverified`, or `download`. These actions compare immutable artifact identity, not display version, so an upstream republish under the same tag is still an update. Planning may perform a normal conditional network lookup and update Portcove's HTTP response cache, but it does not download a release, change source registrations, switch versions, or create an activity record. `use_staged` does not imply activation: the following install's `--stage` choice still controls whether that verified release remains staged. Asset size is the upstream download size; callers must not present it as a guarantee of final extracted footprint.

### Review and recover preparation

API schema 82 adds source-only preparation format 3 and the optional retained
`LaunchReadiness.preparation_mode` route. For staged originals that
have no existing mutable-data or setup owner, new installs materialize registered
sources before sealing the immutable manifest. Previously launched generations
with only declared source outputs added can be reviewed and prepared into a new
derivative; unrelated additions or changed recorded bytes are refused. These
plans omit `inputs.setup_tool`, use `source_only` mode and preserve the released
format-1/2 JSON and fingerprints. Installed interpretation 9 fences older readers.
The authenticated source receipt binds the retained definition, source, host and
conversion tool. Changed registration requires a new review; launch verifies
sealed originals without rewriting them. An install made before registering its
originals remains unprepared until this review completes. No ROM path becomes
mutable as part of this repair.

`portcove --library <path> --json preparation plan <port-id>` inspects the
upstream-managed setup family's already installed artifact and registered source
using the current host, install-root working layout and reviewed default options.
It starts no setup process,
downloads nothing, creates no activity and changes no launch readiness. Missing
installation/source/tool inputs and unsupported families return the normal typed
errors. The result binds the install/manifest/runtime, admitted definition, exact
source and its core assessment, setup and required conversion tools, host/target,
options and copied tree to `plan_sha256`. A preliminary source remains marked as
needing its upstream validator. The copy digest is an identity after existing
trust checks, never initial artifact admission or permission to execute a plan.
The exported `preparation_plan` and `preparation_options` schemas describe this
additive machine contract; unknown setup options are rejected.

`portcove --library <path> --jsonl --non-interactive preparation run <port-id>
--expected-plan <plan_sha256> --yes` applies the unchanged reviewed plan. Without
`--yes`, an interactive terminal asks for confirmation; non-interactive callers
receive a usage error. The core operation produces ordinary activity/events,
retains failed private work, and publishes only after output validation. `cancel
<operation-id>` uses the existing cancellation contract; source conversion can
finish its current step before acknowledging cancellation. A retry requires a
new review and uses another private directory.

An interrupted attempt stays retained until a caller reviews its exact private
tree. `preparation cleanup-plan <operation-id>` reports every affected file,
folder, link or special entry; the original installation, registered
source, saved-data root, backup root and logs that remain outside the action; and
an exact `preview_sha256`. Apply it with `preparation cleanup <operation-id>
--expected-preview <preview_sha256> --yes`. Core rehashes the tree under the port
and original-activity locks, consumes one action-bound authorization, and rejects
changed content without deleting anything. Accepted cleanup records the reviewed
fingerprint in an operation-owned quarantine path, then atomically moves the
reviewed private tree there before deletion. Startup retries only that same
fingerprint. Files newly created at the original staging path remain retained for
a fresh review, and the failed preparation never becomes a success. Desktop
presents the same custom review and still requires its native backend
confirmation. SQLite schema 28 durably marks the preparation process boundary
before an external conversion or setup child can start and records quiescence
only after the platform proves the owned process tree has stopped. Windows uses
a kill-on-close job established before the child can execute. Unix process groups
cannot prove that a helper did not detach, so an attempt that started an external
tool remains retained and cleanup fails closed there. Legacy or interrupted
attempts without proof behave the same way. API schema 48 adds the
`retained_preparation` repair kind and `preparation_cleanup_preview`; operation
event schema remains 2.

For definitions with reviewed managed output ownership, `exec` validates the
prepared installation and launches it without materializing sources or starting
setup. New receipts bind definition, source, artifact/runtime, host and default
options. A changed definition or source requires preparation again; missing or
modified immutable output fails launch validation. Small readiness metadata is
checked against its registered manifest, and launch verifies the complete managed
output before restoring saves. Existing completed installations without a new
receipt retain their manifest-bound setup/source compatibility path; a missing
receipt that was previously recorded cannot fall back to legacy readiness.
Preparation tools are retained as production provenance, not prerequisites for
playing already verified output. Unmigrated definitions retain existing adapter
behavior. Desktop exposes the same core plan, confirmation, events and operation
cancellation, with reviews scoped to the selected library generation.

### Managed saved data and backups

Save managers and launcher integrations should ask Portcove for its canonical roots rather than constructing internal paths:

```bash
portcove --library <path> --json paths <port-id>
```

The response contains `user_data_root` plus the active, previous, and staged install roots when those versions exist. Back up the complete user-data root: catalog persistence rules may include saves, configuration, controller bindings, mods, generated assets, or upstream-specific portable state. The path remains canonical even before the directory has been populated. Treat install roots as read-only implementation state and never modify SQLite directly.

Portcove can also create and enumerate its own immutable snapshots:

```bash
portcove --library <path> --json backup create <port-id>
portcove --library <path> --json backup list <port-id>
portcove --library <path> --json backup restore <port-id> <backup-id> --yes
portcove --library <path> --json backup delete <port-id> <backup-id> --yes
```

`backup create` first collects mutable data from a previously launched active release, then copies the complete canonical user-data root into a private directory and publishes it as `backups/<port-id>/<backup-id>` with an adjacent `backup.json` manifest only after the copy is complete. Every copied file and the manifest are flushed. The same-volume rename gives atomic namespace visibility to running processes. On Linux filesystems that accept directory `fsync`, Portcove additionally synchronizes the staged directory tree and the backup parent before reporting success, covering that supported directory-durability boundary. Other platforms and Linux filesystems that reject directory synchronization do not receive that claim, so a successful backup there does not promise that the final directory entry survives sudden power loss even though partial data is never published during normal execution or process failure. The result reports its stable ID, absolute path, creation timestamp, file count, byte count, and deterministic tree SHA-256. Empty roots fail with `not_found`; a symlink, non-Unicode path, or unsupported filesystem entry fails closed with no published partial backup. `backup list` is local, read-only, network-free, and returns a `BackupInventory`: verified backups remain newest-first while missing, unreadable, malformed, identity-mismatched, unsupported, and recovery-required entries are reported individually. Active private publication staging remains hidden. Damaged unrelated entries do not prevent creation of another backup. All backup commands validate the port against the embedded catalog.

`backup restore` is destructive to current persistent data and therefore requires confirmation, or `--yes` for an unattended caller. It copies the selected snapshot into an operation-private staging directory, recomputes and compares its file count, byte count, and tree SHA-256, then creates an automatic safety backup of current non-empty data before replacing the canonical user root with same-volume renames. Those renames and the lifecycle journal prevent another running process from observing a partial staged tree and allow unambiguous process-crash recovery; they are not a cross-platform sudden-power-loss guarantee. A missing, mismatched, symlinked, or tampered backup fails before live data or the backup list changes. The result includes both `restored_backup` and the new `safety_backup`; the latter is absent only when no current files existed. Restore does not modify application versions or original game sources, and the restored data is synchronized into the active release on its next Portcove launch.

`backup delete` also requires confirmation or `--yes`. Declining an interactive backup restore or deletion is a successful neutral result that says no changes were made; unattended use still requires `--yes`. Deletion validates the selected snapshot and records a core-owned lifecycle operation with the exact original and private quarantine paths before moving that directory out of the visible backup set. The journal advances after quarantine, filesystem removal, and commit. On restart, Portcove completes an unambiguous authorized deletion, including a partially removed quarantine; it never treats both paths, neither pre-publication path, a reappeared visible backup, or out-of-root paths as successful deletion. Such state remains recovery-required in backup inventory and `doctor`. This is process-interruption recovery and visibility isolation, not a cross-platform sudden-power-loss claim. Current persistent data, application versions, original sources, and every other backup remain outside the deletion target.

### Concurrency and failure-isolated batches

Mutating commands, verification, and `exec` use a cross-process lock for the selected port. A second frontend targeting that same port fails immediately with `error.code: "conflict"`, exit code 14, and `details.port_id`; it should retry later rather than run a competing operation. The launch lock remains held through game exit and post-exit mutable-data collection. An unfinished durable launch request continues to block the port even if its supervisor crashes. Desktop startup or `launch recover <request-id>` recovers only the exact recorded child/start identity/install before committing a failed terminal outcome. A live supervisor, PID/start mismatch, ambiguous spawning phase, legacy missing identity, or changed install fails closed for manual review. Recovery can wait for an exact still-running child and then collect from the recorded install; it cannot claim that hard termination allowed a game to flush data. Completed request rows remain reconnectable evidence without blocking a later launch. Commands for other ports continue independently. `capabilities.port_operation_locking` is `per_port_fail_fast` when this contract is available.

An update also reuses a matching artifact already retained as a rollback or inactive installation. Before reuse, activation, rollback, or launch, Portcove checks the registered manifest identity and current critical executable/library/bootstrap bytes. `--stage` marks the checked local artifact for activation, while a normal update promotes it without another download. An install migrated from an older schema without immutable identity must be replaced or re-adopted; Portcove never fabricates its provenance.

`check --all`, `reconcile --all`, and `update --all` are failure-isolated and operate on installed ports. Every port produces an outcome with its own `port_id`, `ok`, `result`, and `error` fields. A metadata, source, verification, or download failure for one port does not suppress other results. Completing the batch returns exit code 0, so schedulers must inspect each outcome's `ok`; a command-level setup failure still uses the normal non-zero exit codes. `update --all --stage` stages successful updates without activation. Without `--stage`, each port's stored update policy is honored: a `stage` policy remains staged while `notify` and `automatic` ports activate the requested update. A source override is deliberately rejected with `--all` because one path cannot safely satisfy multiple source profiles.

`source verify --all` follows the same batch rule, keyed by `profile_id` rather than `port_id`. `capabilities.failure_isolated_batches` advertises these contracts so launchers do not need to infer support from a Portcove version string.

### Exit codes

| Code | Meaning                               |
| ---: | ------------------------------------- |
|    0 | Success                               |
|    2 | Usage or confirmation required        |
|    3 | Unsupported channel/platform/workflow |
|    4 | Not found                             |
|    5 | Invalid source                        |
|   10 | Network failure                       |
|   11 | Verification failure                  |
|   12 | Installation failure                  |
|   13 | Local state failure                   |
|   14 | Conflict                              |
|  125 | Launch setup failure                  |

For `exec`, a successfully started game returns its exit code when it fits the portable `0..=255` process range. Native Windows crash statuses and other out-of-range codes map to `1`, never `0`, while termination without a code maps to `125`. Integrators should treat the structured `error.code` as authoritative for management commands.

### Environment

- `PORTCOVE_LIBRARY`: overrides the default library root.
- `PORTCOVE_PREFERENCES`: optional absolute host-preference file override for portable/test hosts.
- `PORTCOVE_GITHUB_TOKEN`: preferred optional GitHub API token for unattended update checks.
- `GH_TOKEN` / `GITHUB_TOKEN`: compatible fallbacks when the Portcove-specific token is absent.
- `PORTCOVE_GITHUB_CLIENT_ID`: public GitHub App client ID used by device login. It may be embedded at build time or provided at runtime; it is not a client secret.
- `PORTCOVE_PORT_ID`: supplied to launched ports.
- `PORTCOVE_USER_DATA`: stable per-port mutable-data directory.
- `PORTCOVE_SOURCE`: registered source path when the port needs one.
- `PORTCOVE_CACHE`: generated-cache location for applicable adapters.
- `PORTCOVE_CHDMAN`: optional full path to `chdman`; an invalid explicit path fails closed instead of falling back to another copy.
- `PORTCOVE_DOLPHIN_TOOL`: optional full path to `DolphinTool`; an invalid explicit path fails closed instead of falling back to another copy.
- `DOLPHIN_HOME`: optional Dolphin installation directory hint used after `PATH` discovery.
- `MAME_HOME`: optional MAME directory hint used after `PATH` discovery.
- `RETROBAT_ROOT`: optional RetroBat root hint used to inspect its MAME and tools subdirectories.
- `PORTCOVE_TEMP_DIR`: optional parent directory for operation-specific temporary disc extraction; useful when the system drive lacks working space.

Adapters and reviewed catalog entries may additionally set an upstream-native variable such as `SHIP_HOME` or `POKEPORT_IMPORT_ROM`, create a documented portable-mode marker, and prepend fixed launch arguments. Consumers should treat all environment fields, portable markers, and built-in arguments as Portcove-owned and add only game-specific arguments after `--`.

Environment tokens take precedence over a credential saved by Portcove. Tokens are sent only as bearer authorization to the configured GitHub API origin. Release assets, checksum URLs, redirects to other origins, operation journals, structured output, SQLite state, cached response bodies, and child-game environments never receive the token.

There is no prompt unless an operation needs confirmation. Pass `--non-interactive` from frontends and services.

### Signed catalog delivery

`catalog definition-refresh <stable-id> --metadata-base-url <https-base>
--targets-base-url <https-base>` refreshes one official identity under the fixed
compiled authority already installed in the library. The locations supply no
root, key, grant or executable input. Unconfigured or unprovisioned authority
refuses before network work or activity creation. The `refresh_schema: 1` result
reports `selected`, `ineligible` or `revoked`, the policy/assessment changes and
durable selection. A subsequent CLI invocation loads that selection; existing
Core service instances retain their constructor catalog snapshot.

Core acquires one authenticated metadata snapshot, admits the exact policy and
any required launch assessment, then selects through existing eligibility gates.
Revocation needs no candidate download. A separately valid restrictive policy can
remain committed when a companion fails: error details report
`definition_refresh_phase`, `definition_policy_changed` and
`definition_launch_assessment_changed`. Retry after repairing the authenticated
input; a generic refresh cannot clear a hold. Acquisition is cancellable until
the existing publication seal. The command emits existing update-catalog events,
advertises `catalog.definition-refresh` and exports `definition_refresh` without
changing envelope/event versions. It performs no game install, update or launch.

`catalog definition-authority` separately reviews the independent definition
authority compiled into this release. Its `provisioning_schema: 1` result includes
`configured`, library/anchor identities, `installed` and `expected_plan`.
Current builds have no configured anchor and refuse application. A separately
approved configured release can apply with
`catalog definition-authority --apply --expected-plan <expected_plan>` and
explicit confirmation (`--yes` in noninteractive use). There is no root/key/file/URL
input. Core recomputes the exact library and retained-state fingerprint in its
transaction, inserts once, preserves exact retries without writes and refuses
conflicts, stale reviews or incomplete retained history. This does not grant
publisher policy or install games. See
[fixed-anchor provisioning](DEFINITION-DELIVERY.md#exact-definition-availability-policy)
for trust and recovery limits. `capabilities.commands` advertises the command;
`schema export` adds `definition_authority_review` and
`definition_authority_provisioning`. The existing API envelope and event versions
are unchanged; provisioning emits no operation event.

API schema 7 adds catalog provenance to `doctor`, public-key trust and selection state, signed-envelope/payload schemas, reviewed catalog updates, and the `update_catalog` activity operation. Operation event schema stays at 2.

- `catalog status`: current effective provenance, trusted public keys, highest accepted sequence, valid rollback/cache availability, and `state_sha256`.
- `catalog trust-key <64-character-public-key-hex> [--yes]`: explicitly trust a publisher. Non-interactive callers need `--yes`; verify its fingerprint independently first.
- `catalog revoke-key <key-id> --expected-state <state_sha256>`: remove trust and immediately recompute fallback.
- `catalog update --file <signed.json>` or `--url <https-address>`: verify and return a read-only plan with added or changed port IDs, candidate display names, validity, publisher fingerprint, and `plan_sha256`. That list does not enumerate removed entries. The existing `changed_port_ids` field remains available to JSON consumers.
- The same command with `--apply --expected-plan <plan_sha256>`: reread, reverify, and atomically publish only the reviewed candidate against unchanged trust/selection state.
- `catalog rollback --expected-state <state_sha256>`: select the still-trusted, unexpired previous catalog. The replay floor never decreases, and the rejected newer version is not retained as fallback.
- `catalog use-embedded --expected-state <state_sha256>`: choose the built-in catalog without discarding trust, cached versions, or replay history.
- `catalog use-cached --expected-state <state_sha256>`: reverify and select the cached signed catalog without downloading or admitting an older external candidate.

Human catalog reviews show the active source, exact publisher/key identities,
full catalog and review hashes, issued/expiry times and rollback/replay facts.
Trust a public key only after verifying it through a trusted channel. Completed
catalog operations report the resulting active catalog and fallback state;
they do not install or update game files. Definition refresh keeps policy and
launch-assessment changes separate from selection and eligibility.

Local-file review does not write library domain state. Explicit HTTPS delivery is anonymous, bounded to 4 MiB and 20 seconds, and rejects redirects, userinfo, fragments, and non-HTTPS URLs. Catalog application supports cross-process cancellation and CLI Ctrl-C/SIGTERM until publication admission; SQLite activation, replay advancement, and the terminal activity outcome commit together. A service command uses the catalog snapshot it opened with; subsequent commands see the new selection. See [SIGNED-CATALOG.md](SIGNED-CATALOG.md) for the exact signing contract and offline publisher utility.

## Retained builds and setup references

A setup reference protects one already accepted local managed build from cleanup.
Use a stable `SETUP_ID` supplied by the consuming setup or profile; it is separate
from a display name, game-file profile, installation path, and the currently
active build. This interface supplies the retention component for later profile
management. It does not create mod profiles or select a launch target.

Inspect the local inventory and resolve an existing reference:

```text
portcove --library PATH --json installation retained PORT_ID
portcove --library PATH --json installation reference PORT_ID SETUP_ID
```

`installation.retained` returns `RetainedBuildInventory`: registered local build
records, active/previous flags, setup IDs in `retained_by`, and current resolutions
of saved references. `installation.reference` returns `RetainedBuildResolution`.
The saved identity binds the exact install and port IDs, artifact, immutable
manifest, selected executable, installed contract, target platform, and any
separately recorded runtime and definition selection. Version labels cannot
substitute for those identities.

Availability is `verified`, `missing`, `changed`, `held`, or `unavailable`. A
resolution keeps the saved reference and reports its precise `gap` even when its
bytes are missing or current policy prevents use. `verified` describes the local
verification observation; ordinary launch and preparation still apply their
current checks. Neither inventory nor resolution downloads a replacement or
substitutes the current active build. Local retention makes no promise that an
upstream server still offers the release or that it can be downloaded again.

### Review and bind a retained build

Select the exact `INSTALL_ID` from the inventory and review the complete binding:

```text
portcove --library PATH --json installation reference-plan PORT_ID SETUP_ID INSTALL_ID
portcove --library PATH --json installation reference-bind PORT_ID SETUP_ID INSTALL_ID --expected-preview SHA256 --yes
```

`installation.reference-plan` returns `RetainedBuildBindingPreview`, including the
verified build identity, any previous reference for this setup, and
`preview_sha256`. Pass that complete fingerprint as `--expected-preview` only
after reviewing the proposed change. `--yes` confirms the action; it does not
replace the fingerprint. Without `--yes`, the human CLI asks for confirmation;
`--non-interactive` refuses an unconfirmed change.

Binding issues and consumes Core's existing one-use authorization within the same
process. Core rechecks the exact inputs and previous reference under the port
lock, then publishes the reference atomically. A stale review requires a new
plan. Each binding advances the saved reference revision, so restoring a prior
build does not revive an older review. Rebinding a setup changes only its own
reference. The default installation
can advance independently while another setup keeps its exact build protected.
Binding does not activate a build, change source ownership, or copy saved data.

### Review and remove a setup reference

```text
portcove --library PATH --json installation reference-removal-plan PORT_ID SETUP_ID
portcove --library PATH --json installation reference-remove PORT_ID SETUP_ID --expected-preview SHA256 --yes
```

`installation.reference-removal-plan` returns `RetainedBuildRemovalPreview`, which
binds the complete saved reference and `preview_sha256`. Removal requires the
same fingerprint and confirmation rules as binding. The success result is the
removed `RetainedBuildReference` snapshot. Removal releases this setup's cleanup
protection; it does not delete build files or player data. Other references,
active sessions, active selection, and unfinished lifecycle work retain their
existing protections. Missing or held build bytes do not erase the reference or
prevent its explicit removal when the operation's locking and lifecycle checks
permit it.

The four inspection/review commands use read-only Core startup and do not advance
pending recovery. Binding and removal use ordinary recovering startup and accept
CLI cancellation signals before durable publication. After interruption or lost
output, read `installation reference` or `installation retained` to establish
the saved outcome before obtaining another review; do not assume an interrupted
caller means the reference change was rolled back.

JSON command names are `installation.retained`, `installation.reference`,
`installation.reference-plan`, `installation.reference-bind`,
`installation.reference-removal-plan`, and `installation.reference-remove`.
Each command also supports JSONL's terminal result envelope. `schema export`
includes `retained_build_inventory`, `retained_build_reference`,
`retained_build_resolution`, `retained_build_binding_preview`, and
`retained_build_removal_preview` in both input and output directions. Check the
selected CLI's capabilities and schemas before using this maintained-source
contract with a released binary.

## Reviewed first installation

API schema 57 adds the optional `installation.review` capability. Register
original files separately, then use `installation plan PORT_ID --json` to read
`GameInstallPlan`: the resolved version/artifact, download bytes, registered
source requirements, managed versions folder, saved-data location and
`plan_sha256`. The plan is read-only and does not download game bytes.
When reusing staged or retained bytes, `selected_install` identifies the actual
copy, its path and stored version/channel; future output placement is not its
activation destination. Reuse does not download the resolved artifact again.

After reviewing those consequences, use `installation run PORT_ID
--expected-plan SHA256 --yes --jsonl`. The executing CLI issues and consumes
core's ordinary one-use authorization in the same process. Core re-resolves the
review under the port lock and refuses changed release/runtime, channel,
destination, definition, registered inputs or retained installation state.
Capacity and actual source/destination safety remain execution checks. A
download refuses missing source/BIOS registration instead of discovering an
unreviewed inbox input. Verified retained reuse needs no new source registration.
A changed plan requires another review; cancellation may retain private work for
existing recovery. No source/BIOS/output overrides are accepted on this route.

This route activates a first managed installation. An active installation
requires separate setup, Play or explicit update; it cannot become an update
through first-install consent. Existing `install`, `ensure` and `update`
commands retain their contracts. `ensure` still reuses a ready active version
without resolving the latest upstream release.

### Shared-directory external runtimes (API 73)

API 73 adds the closed `smb1r-1.1-stable-windows` shared-data contract.
The registration preview binds the effective APPDATA/SMB1R directory and current
Windows account. Its `local_fallback_path` is null and
`local_fallback_present` is false. The existing ReGaiden file contract still
returns its fallback path. Unknown or inconsistent variants must be refused.
Review this directory separately and supply `--acknowledge-shared-preferences`
with the exact preview digest; ordinary `--yes` does not grant shared writes.

This non-owning route uses the exact five-file stock Windows 1.1-stable tree,
fixed `--disable-mods` arguments and no portable marker. The game can share
settings, saves, custom data and original files with other copies, regenerate
or trash caches and prune logs. Portcove never seeds, owns, migrates, updates,
backs up, restores or deletes that directory. Registration removal preserves it.
Manually copy the recognized Super Mario Bros. (World) original to
`baserom.nes` in the reviewed directory. Existing `settings.cfg` must be
bounded ordinary data without Godot object/resource constructors; Core checks
this and the original before launch and immediately before spawning. Missing or
unsafe settings yield `preparation_required` without offering Core setup.
Unsafe shared loader metadata or aliases fail existing registration-safety checks.
This is an execution admission check, not a sandbox or lock against other apps.

For SMB1R, this limited route accepts only vanilla BaseAssets. Shared Godot
loader sidecars, custom levels/autosaves, blueprints, custom-character files
and extra resource packs are refused without changes. Their empty directories
may remain. Generated BaseAssets PNGs and its root pack_info.json remain mutable.
Existing visuals.resource_packs must select only BaseAssets. Move unreviewed
inputs elsewhere manually before using this route. Import/editor workflows are
outside this offered route; independently importing files while the game runs
is outside Core admission and its checks are not a sandbox.

## Current specialized routes

### Managed ReGaiden preferences (API 77)

API 77 adds the closed managed ReGaiden shared-preferences review. Register the
supported original, run `installation plan resident-evil-gaiden-recomp`, then pass
its exact `--expected-plan` and `--acknowledge-shared-preferences` to
`installation run`. Ordinary `--yes` does not acknowledge this scope. See
[ownership and changed-account recovery](reference/managed-regaiden.md). Existing
prepared registrations retain their non-owning contract. Local saves/settings
remain managed; the resolved account-wide preferences file is never owned or
included in backup/restore. The reference client accepts public API77 and requires
explicit confirmation before transmitting acknowledgment. The current tested reference
window extends through API81; unknown API82 and unknown consequential semantics are refused.

### Retired custom source creation

New custom cartridge creation is retired, including API78's private CVLoD source
recipe. Existing managed runtimes retain their original launch, data and recovery
contracts without requiring the compiler that created them. New Yoshi, Dr. Mario
NES, EarthBound, Render96 and Gundam routes use explicit existing-installation
registration. CVLoD continues to offer official upstream packages at its recorded
qualification scope. See [compatibility and retirement](reference/upstream-first-compatibility.md).

### Managed Dark Forces

For managed Dark Forces on Windows, register the complete reviewed installed-data
folder or ZIP with
`portcove source add dark-forces-pc-complete-installed-data PATH`, then use the ordinary
reviewed installation and launch commands. The full source check validates all
48 relative members; quick file-filter refresh remains `NotChecked`. Existing
prepared registrations retain their non-owning route. See
[managed Dark Forces setup](reference/managed-tfe.md), including manual
preservation when `.tfe-preparation` recovery material prevents removal.

### Startup and observation boundary

The private startup policy exhaustively classifies every CLI command and nested
variant as read-only or recovering. Adding a variant requires an explicit choice.
Artwork handoff and status observations leave pending constructor recovery alone;
recovering commands retain Core's existing recovery before shared-service dispatch.
Commands with early dispatch keep their own existing construction paths. This
classification does not grant mutation, cancellation, or launch authority.

### Local host diagnostics

CLI and Desktop share a bounded, redacted file logger initialized before
preferences, runtime leases or a library are opened. Each process uses its own
leased session namespace in the host diagnostics directory, independently of the
selected library. Preference, selection and startup failures can therefore leave
typed phase/error evidence without a healthy library. Logging is best effort:
an unavailable location, exhausted session inventory or failed writer never
changes the command result. Core's durable activity and recovery remain authoritative.

File logging defaults to application **INFO** and dependency **WARN**. CLI
stderr retains its existing thresholds: **WARN** normally, **INFO** with `-v`,
and **DEBUG** with `-vv`. New host-startup observations go only to files.
`-vv` also enables application DEBUG in that process's file log. Setting
`PORTCOVE_DIAGNOSTICS_DEBUG=1` enables application DEBUG file logging without
changing stderr verbosity. Other values have no effect. These choices are never
saved to preferences; each new process starts from its own arguments and
environment. There is no automatic timer within a running process: DEBUG ends
when that process ends. Command arguments and environment values are not logged.

JSON/JSONL stdout, human rendering, exit codes and the child's raw `exec` streams
keep their existing contracts. Explicit `-v`/`-vv` still select the pre-existing
stderr trace output around those commands. Normal exit allows up to two seconds
for the bounded file queue to flush; forced termination can lose records. A
previous session without a completed close is reported as unclean with an unknown
cause, never as proof of a crash or failed operation. Logs are redacted, not anonymous.

### Route-bound game-file observations

`source query PORT_ID --route managed-install --channel stable` explicitly
refreshes registered game-file observations for the selected route on the current
host. Other route choices are `external-registration`, `managed-launch` and
`external-launch`. JSON and JSONL reuse Core's route-bound snapshot; JSONL emits
the existing `verify_source` activity with a Library target and settles it after
the worker returns. This command does not register sources, plan setup, resolve
network releases or execute a game. Filtering the returned snapshot performs no
inspection. API 65 exposes the command without claiming private schema 64.
API 66 preserves this query contract and adds managed update assessments. Private
schema 64 remains unclaimed; the reference reader accepts public 65 without an
update action and requires the new update assessment only in 66.

The observation age defaults to 300 seconds and is bounded to 1–1800 seconds.
`--max-file-bytes`, `--max-hash-bytes` and `--max-elapsed-ms` may reduce the
respective 2 GiB, 32 GiB and 30-second caps; larger or zero limits are refused.
The elapsed limit is cooperative and cannot interrupt an individual filesystem
call. A game-file state does not grant setup or launch authority.

### Qualified Ghostship recovery (API 69)

API 69 adds the optional Windows Ghostship legacy recovery leaves:

```text
portcove --library <path> --json backup ghostship-legacy-plan <backup-id>
portcove --library <path> --json backup ghostship-legacy-recover <backup-id> --expected-plan <sha256> --yes
```

The selected snapshot must have Core-owned qualification from successful exact
prepared 2.0.0 consumption before the selected 3.0.0 transition. Historical
successful sessions, ordinary backup files and imported metadata do not grant
that qualification. Plan review binds source/code, the complete installation
tuple and both canonical/newer-runtime preimages. Recovery preserves both old
installations and the selected snapshot, stages a fresh 2.0.0 derivative with
only the retained persistent entries restored, and atomically selects it with
3.0.0 previous while preserving another staged installation. It creates a full
canonical safety backup with a separate newer-runtime persistent-data companion.
Ordinary restore uses only canonical `data/`; deleting that backup also deletes
the companion, which deletion preview and confirmation explicitly disclose.
The successful result returns `install`, `restored_backup`, `safety_backup` and
`runtime_safety_path`, identifying the committed derivative and both retained
backup records without a separate lookup.

An unfinished Ghostship launch or lifecycle operation holds this route. A
Preparing interruption retains private work for review. Validated Prepared
recovery rechecks phase-owned content and current policy before publication;
committed recovery only finishes forward. It never collects newer runtime data
over the selected legacy snapshot. This route is distinct from ordinary
`backup restore` and `rollback`; it does not weaken the held unqualified 3→2
transition. See the [exact contract](qualification/ghostship-legacy-data-safety-2026-10-18.md#qualified-pre-transition-snapshot-recovery).
