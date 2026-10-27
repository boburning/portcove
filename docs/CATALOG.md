# Catalog policy

## Integration ownership

The owner adopted this upstream-first boundary on October 22, 2026 in
[#1422](https://github.com/boburning/portcove/issues/1422). Catalog breadth and
management depth are separate. Ordinary integration selects an appropriate
official package, helps supply original game files through upstream conventions,
invokes supported upstream preparation when needed, and launches the result.
Upstream owns its engine, game-specific generation/extraction, compilation
implementation, rendering, audio, codecs, gameplay and bug fixes.

Each installation has one owner for runtime replacement:

| Offered route                  | Runtime replacement and updates    | Portcove's responsibility                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Managed official package       | Portcove                           | Accepted artifact identity, safe installation, documented input/setup invocation and launch; player-data protection for explicitly owned paths. Offer update, rollback, backup and removal only where established.                   |
| Supported upstream preparation | Explicitly selected for the output | Delegate the substantive work to upstream's CLI, builder, extractor or setup window. If upstream retains an updater/launcher, use non-owning registration; its mutable runtime cannot also be a Portcove-owned immutable version.    |
| Existing installation          | Player or upstream launcher        | Explicit selected executable, working directory and bounded arguments; register, launch, and remove the registration while preserving external files. User selection establishes execution intent, not curated package authenticity. |
| No useful reasonable route     | Unoffered                          | Record the precise upstream dependency or product deferral and reconsideration condition on the canonical issue. Preserve research, patches and failures as evidence.                                                                |

A supported setup window is acceptable. Shared PSX preparation remains useful:
it invokes upstream generation/rebuild rather than implementing each engine.
Compilation is permitted; replacing a game's build implementation or repairing
its engine is an exceptional maintenance commitment, requiring an identified
consumer and a concrete reason. Mere technical feasibility does not require it.

Before extending behavior, remove unnecessary management promises. Unknown save
ownership may allow non-destructive launch while withholding replacement,
backup, rollback or deletion. Qualification follows the operations actually
offered. Fixtures, actual setup/launch and optional gameplay/device observations
remain separate; known relevant failures remain visible. A link, catalog
placeholder, research record or deferral is not a delivered integration.

Ordinary fitting additions use reviewed definition facts and existing behavior.
Compatible upstream updates normally change artifact facts. Reuse a policy only
after checking the behavior it relies on; a checksum or filename alone is
insufficient. New capabilities represent genuinely new behavior and retain
strict refusal of unknown execution/ownership semantics. Current schema IDs and
retained installed contracts keep their historical meanings.

See [compatibility and retired creation](reference/upstream-first-compatibility.md)
for identified consumers and retirement conditions. Preserve installed runtimes,
originals, saves, settings, backups and recovery independently of whether the
builder that created them remains an active feature.

## Managed native portable packages

The `native-portable` adapter offers the existing managed installation, update,
retained-version, backup and recovery lifecycle to fitting upstream archives.
For ordinary GitHub discovery, releases containing only explicit other-OS
players are outside that platform's stream. Same-OS, unknown or mixed package
names still use the normal variant, processor and integrity refusals; source-only
releases never silently select an older runtime. Curated identities retain their
existing exact selection.
It does not need a game-specific adapter. Setup provider and runtime update owner
are independent: the game can ask for original files on first launch while
Portcove continues to replace its runtime. A launcher that replaces its own
runtime instead uses the non-owning existing-installation route.

Verify that the selected process stays alive through edition dispatch and
settings-triggered restarts, or uses a supported tracked handoff. A launcher that
starts a successor and exits can end Core's supervision while the game still
uses its files. Keep that upstream-owned route non-owning until its full lifetime
can be tracked; bypassing useful setup or settings is not a management fix.

Adding this route does not adopt an existing external registration. Players can
review a separate managed copy while keeping the current copy usable. Core can
switch a fitting fresh native-portable route after verified separate publication;
the external files stay untouched and external saves are not copied. Retain
owner-neutral listing instructions, including upstream profile locations, and
put managed preservation promises only in integration presentation. A shared
upstream profile may still be read on the next explicit Play. A saved Core data
store or richer preparation/account contract requires its own compatible
transition rather than guessing at migration or rewriting retained definitions.

Use an official ZIP, tar.gz or tgz with an independently expected SHA-256,
reviewed native package and executable hints, and a small declared persistence
contract. For example, the CorsixTH and SDL Sopwith records use the shared route
without game-specific Rust or React code. The minimum integration shape is:

```json
{
  "support_tier": "beta",
  "channels": ["stable"],
  "platforms": ["windows-x86-64"],
  "adapter": "native-portable",
  "release": {
    "repository": "owner/project",
    "asset_hints": { "windows-x86-64": ["windows", "x64", ".zip"] }
  },
  "executable_hints": { "windows-x86-64": ["Game.exe"] },
  "persistent_paths": ["saves", "settings.ini", "game-data"]
}
```

These are reviewed facts, not an invitation to copy those paths to every game.
Trace save and settings writes during the first setup session as well as after
restart. Choosing a game-data folder does not prove that the running process
also changed its save folder; preserve every actual managed write coordinate
before promising updates or backup. Keep a useful upstream-owned route when
that coordinate requires upstream repair or supported preparation.
For ordinary captures written beside the executable, reuse reviewed
`persistent_file_patterns` with literal filename prefixes and suffixes. These
files remain player data through collection, backup, replacement and rollback;
do not exempt them as disposable runtime output or widen ownership to unrelated
files. A save-directory argument alone does not prove that capture writers use it.

For manual preparation that must finish before Play, `native-portable` may
declare a `setup_marker` pointing to an upstream completion JSON record beneath
an already declared persistent directory. Establish that upstream removes the
record before starting and publishes it atomically after successful preparation.
Core reads one bounded, single-link regular JSON object relative to the retained
runtime working directory; it does not execute a helper or certify the original
edition, data format or game content from that record. The upstream runtime keeps
those checks. Missing, unreadable, malformed or oversized records keep Finish
setup available and block launch. Native template capability 2 is required.
A reviewed marker may be added under unchanged existing player-data coordinates
for a new runtime; it never rewrites an installed contract. Changing or removing
an existing marker needs a supported transition. First-Play file pickers remain
Play and need no artificial completion marker.

When an active installation exists, activation checks the destination's actual
retained data contract, including artifact reuse, interrupted install publication
and pending activation recovery. Native portable publication recovery collects
current player data and restores it before committing activation, just as the
normal staged route does; this adds no restore-receipt requirement to native ports.
Today's recommended definition cannot authorize an incompatible retained target.
A failed pre-commit check preserves the active version and all player data;
already committed recovery finishes with the authoritative committed version.
Reuse, normal staged activation and both recovery routes share the existing
`prepare_retained_install_data` preflight. Their callers retain distinct admission,
publication, journal and commit boundaries. Rollback retains its stricter
directional compatibility check.

Assess preparation separately on each platform. A Windows first-Play picker
does not establish a Linux picker or a manual completion record. Keep a useful
upstream setup/non-owning route for a platform whose preparation cannot be
represented by the existing contract; never fabricate a marker. Managed-platform
badges describe the definition's managed scope, so record separately supported
external handoffs and their presentation limits explicitly. Application wrappers
that seed data or set required environment values must retain their supported
entry point; selecting a private native binary is not an equivalent handoff.

For mutable release tags, keep the tag commit, current source head and any
publisher-declared package build commit separate. A checksummed build manifest
is a publisher source claim, not an independent reproducible-build attestation.
Use Core's channel classification rather than a provider's prerelease flag alone;
a tag such as `v0.3-dutch-preview-1` selects Preview even when that flag is unset.
Preparation feedback retains the raw observed tag and provider flag as advice; it
does not classify a stream or override the player's saved choice.

Every package hint must match for managed replacement; the shared native
suitability check still rejects known foreign processors, platforms, supporting
files and equally plausible variants. The existing channel and artifact-integrity
rules remain in force. A missing digest can allow an explicitly unverified
non-owning download, but cannot authenticate a managed installation.

Review the actual linked or vendored components and their attributable grants,
including packaged fonts. A parent's license, a published archive or resemblance
to another project does not settle a separately authored component's permission.
Retain a named acquisition condition at its exact operation scope. When fresh
self-service acquisition is held, the authored listing can set
`download_block_reason` to a bounded practical explanation and reconsideration
condition. The generator emits listing format 2; Core refuses download options,
preview and mutation before contacting the provider. This restriction grants no
permission to acquire, register or execute an existing copy and does not rewrite
its retained contract. Keep useful existing permitted-copy instructions and
upstream links. Remove a restriction only after reviewing the changed fact.
Preparation refuses replacement records that remove or change an existing
restriction; resolve its canonical condition in a reviewed Git-authored edit.
A restricted authored listing cannot also supply a managed integration, whose
acquisition eligibility belongs to the strict definition. Package observations,
release links, hints and artwork enrichment do not resolve either condition.

For an upstream-owned route, optional listing `download_asset_hints` maps a host
platform to one through eight bounded, case-insensitive literal filename fragments.
Optional `recommended_download_channel` selects `stable` or `beta` for the initial
download lookup, for example when the reviewed player is published as a preview.
A player's explicit saved channel or release takes precedence. For a genuinely
fresh `native-portable` installation, Core also uses this hint when the managed
definition declares that channel. Settings, retained or staged installs, external
registrations and pending downloaded setup keep their existing fallback and
choices. Destination/policy changes and accepted install intent preserve the
chosen channel durably; read-only discovery never creates settings. This hint
does not change an installed channel, version pin or update policy.
Core uses all fragments together to recommend the reviewed player package or
upstream installer. Prefer stable discriminators instead of a version string;
retain a choice when incompatible variants are equally plausible. Operational
release hints take precedence. `prepare-port` reports complete/partial selected
asset coverage and competing literal matches as `download_preparation` feedback.
This is advisory selection, compatible with descriptive listing format 1: it
grants no authenticity, invocation or managed operation. Core still binds current
release/asset IDs, destination and extraction in the download preview. A reviewed
player ZIP named `debug` needs an explicit whole-filename hint; generic project
or platform fragments do not override its exclusion. Symbols, source,
checksum files, foreign platforms and processor mismatches remain excluded from
recommendations. Explain the actual upstream setup and its update/data owner in
the authored guide; downloading an installer never runs it.

A ready native archive with reviewed disposable runtime writes may instead fit
the existing `staged-source-portable` adapter; it does not require a source
profile or build step. A ready archive may also receive one explicitly declared
verified raw-file `copy`, with its exact destination declared persistent. This
does not include extraction, generation, BIOS or helper preparation. Establish
its actual executable-relative working directory,
declare player data separately from disposable caches and diagnostics, and keep
new package defaults version-owned. MC2 is an example: local settings/custom
multiplayer data persist, while generated texture/geometry caches stay with each
version. This is not permission to exempt arbitrary data folders or executable
outputs. Review interrupted temporary writes and packaged script callers too.
External user-profile saves remain outside backup ownership. Use
`external-user-owned` saved-data presentation when normal saves are external,
and explain any separately managed local settings in the authored instructions.
The shared installation review surfaces that limit for every managed adapter;
external registration must retain its ownership-neutral guide.
Ready staged archives require capability version 23 for independent definition
delivery. Core stages their installation before restoring declared data and
activating. Data added before first Play participates in backup, update and
rollback. A retained runtime without proof of completed Core data restoration
uses conservative additive collection: canonical-only data survives and differing
copies require a deliberate resolution. Existing source/build integrations keep
their preparation and collection contracts.

A ready staged archive whose reviewed mod layout is
`mods/packages/<id>/<version>` may opt into
`mod_package_policy: "versioned-packages-v1"` with the exact `mods` persistent
root. This requires capability 24, a format-7 retained contract and runtime-local
data. Direct-write `user_data_environment` bindings are refused because they bypass
package restoration. Core reuses the existing complete-package coexistence
behavior: absent versions are staged
privately and published without overwriting, successor-only packages survive,
and same-ID/version content conflicts report both paths before activation or
explicit data restore. Package identity compares contents rather than publisher
timestamps; current root state keeps its replacement/deletion behavior. Preserve
the player's choices without rebasing them onto a new default. This policy does
not authenticate mod code, promise compatibility, or preserve generated executable
caches. An old contract merely declaring `mods` does not acquire these semantics;
changing the policy holds replacement until a supported transition exists.

Declared data copies preserve exact file modification times, including upstream
original-data integrity records that depend on them. New backups verify those
times separately from content; old byte-only snapshots retain their historical
limits. New ready archives retain a format-6 contract so older programs cannot
apply timestamp-losing behavior to them. See [definition compatibility](DEFINITION-DELIVERY.md#implemented-engine-capability-negotiation).

An explicitly hinted Win32 player can be recommended on a Windows x64 host;
[Windows supplies WOW64 for x86 applications](https://learn.microsoft.com/en-us/windows/win32/winprog64/running-32-bit-applications).
This does not establish game-specific dependencies, gameplay, or other processor
compatibility. Supply the accurate `original_game_title` where the listing name
also contains the engine/project name so bounded launch suggestions can identify
the game among unrelated converters; equally plausible targets still require a choice.
Portable preparation reports a missing original game title alongside package
feedback. Use the canonical game identity; a helper name is not a substitute.
For listing-only downloads, a unique native player whose basename exactly matches
the upstream project name can also be recommended. Raw packages, supporting
programs, incomplete searches and ambiguous matches still require manual setup
or a choice. Suggestions remain read-only; registration and Play stay explicit.

Persistent paths are relative to the executable's directory, or the install root
when `launch_from_install_root` is declared. Declare only compatible original
inputs, generated data, saves, settings and supported mods that should reach
replacement versions. Outside data remains upstream/player-owned and outside
Portcove backups. Describe setup and this limit in `presentation`; optional unknown
gameplay evidence does not hide the listing or prevent a separately safe operation.

Literal launch arguments and environment values also belong to that coordinate
contract. A native portable replacement refuses changes to either, even when the
declared data paths stay the same: changing `--data-dir` or a data-location
environment variable cannot silently redirect a retained installation. A supported
transition must establish compatibility before changing these execution facts.

Put the actual next game-setup step first in the authored manual guide: original
files the game will request, a required manual preparation, or an explicit statement
that the package is ready for Play. Avoid a redundant first step telling the player
to install. Desktop uses this first step in the managed installation review and
keeps the guide in Files even when Core needs no source profile. Listing guides
also survive as saved-download handoffs after a definition disappears. Keep their
steps truthful for both routes, spell out any external launch arguments, and put
managed retention/backup/replacement details in the integration's
`presentation.manual_preparation`, which Desktop scopes to managed ownership.
An empty Core
input requirement describes Portcove's action; it does not assert that the upstream
game never needs original files.

Follow the selected fork's actual setup route. An Android APK belongs to Android's
package manager and upstream app; a desktop parent's archive, converter, save path
or native plugin is not its contract. Describe the app's own original-file picker
or on-device preparation, actual profile location/export controls and meaningful
update limits. A signing-key change that requires reinstall needs concrete data
preservation instructions before uninstall. Keep source/artifact version conflicts
explicitly unresolved rather than importing another build's inputs or save promises.

Reference catalogs such as [Quiver](https://github.com/tgeorgiadis/quiver-launcher)
can expose useful asset filters, preferred executables, required files and simpler
upstream alternatives. Join by the exact implementation and reviewed lineage, then
verify those hints against the selected upstream source and package. An empty
required-files list does not establish an empty persistence contract; a portable
marker can change storage behavior and needs its own upstream evidence. Keep
distinct games sharing a repository separate. A reference catalog's release,
checksum, scanner or verification label is not Portcove admission or qualification.

Native portable runtimes use complete immutable-file verification. Changed package
files or undeclared additions block update, version switching and managed removal
with the current files preserved. The player can back up and relocate additions
or retain an external installation. Updates extract into a new version, collect
declared data from the active version even before its first launch, restore it to
the staged version, revalidate, then activate through the existing journal.
Obsolete package files stay in retained versions, rather than surviving in the
new runtime. A changed retained data/working-coordinate contract refuses an
unsupported transition. Version-dependent generated data needing regeneration,
mutable engines, installers and custom preparation are outside this adapter;
use an existing supported integration or a non-owning handoff.

Update policies, explicit staging/application and version pins keep their existing
meaning; automatic application stays opt-in. Runtime rollback carries current
declared data and does not promise that older software can read newer saves.
Committed activation remains authoritative after a later failure; recovery must
not claim an automatic rollback. Existing managed and external installations are
never silently converted when a catalog entry gains this capability.

## Catalog author task routes

The machine-readable catalog owns port, platform, source, release and
qualification facts. Use these routes to describe a useful integration and its
limits before preparing a change; stable IDs remain the operational references.

| Task                                         | Start here                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Define the required original game files      | [Original game-file requirements](#original-game-file-requirements), then the [shared source contract](ARCHITECTURE.md#original-game-files)                                      |
| Explain what happens to saves and settings   | [Saved-data behavior](#saved-data-behavior), then [Core persistence](ARCHITECTURE.md#saves-and-settings) and [backups](ARCHITECTURE.md#backups)                                  |
| Check releases and record maintenance limits | [Release checking](#release-checking), [continuous admission](#continuous-admission) and [channels, support and qualification](#channels-support-and-qualification)              |
| Prepare and review the definition            | [Adding or changing a port](#adding-or-changing-a-port), [cover preparation](#default-covers) and [protected publication](#admission-decisions-and-protected-publication-target) |

### Original game-file requirements

Give players clearly defined requirements for their original game files and any
required BIOS. Bind the labels, edition/representation facts and exact property
checked to the declared source profiles and contracts. Distinguish an exact
identity match from structural admission, an informational observation and a
validator that has not run. The [shared inspector](ARCHITECTURE.md#original-game-files)
owns these conclusions; a filename or descriptive label cannot supply them.
The [authoring procedure](#adding-or-changing-a-port) keeps presentation tied to
the same source authority.

### Saved-data behavior

Explain how updates preserve saves and settings for the offered route. Declare
the managed persistent locations and distinguish them from disposable runtime
output and external player-owned files. Use the existing
[synchronization and version-switch contract](ARCHITECTURE.md#saves-and-settings)
and [backup ownership](ARCHITECTURE.md#backup-service-ownership); a non-owning
registration does not acquire those management rights. Record an unknown or
unsupported behavior at its actual scope rather than implying every file is
backed up or every older game version can read newer saves.

### Release checking

Record release checking, required game files, saved-data behavior and
implementation notes together for the offered route. Identify its release
provider, offered channels, exact artifact and checksum requirements, then use
the existing [release-selection and maintenance rules](#release-selection-and-maintenance).
Separate safe selection of an artifact from qualification of that artifact and
permission to install it. Keep pinned and user-managed limits explicit; a
successful metadata check does not establish gameplay or authorize publication.

## Managed PS1 package and player-data restoration

`psx-recomp-managed` keeps its owned-disc/BIOS preparation and runtime generation.
Official release discovery may replace changing direct manifests when the same
reviewed package, executable and preparation rules apply. Native archives do not
replace this richer integration. Platform commitments remain independently scoped.

The upstream framework stages bundled mod packages into the same
`mods/packages/<id>/<version>` tree used for player imports. For a retained
contract declaring `mods`, Core preserves complete destination-only packages and
adds complete absent versions through private, same-filesystem staging and atomic
no-replace publication. An existing ID/version must have an identical complete
tree; differing, missing or additional members, case/type conflicts and links hold
the operation with exact paths. Preserve conflicting copies separately and resolve
the reported conflict before retrying. Core does not identify which package was
player-created, authenticate a modified mod, insert arbitrary unknown runtime
files, rebase upstream selections or promise mod/save compatibility. Ordinary
declared state retains its existing restore/deletion semantics. Runtime rollback
carries current data, including selected mod versions; it does not rewind saves.

PS1 installs publish inactive and run player-data preflight before activation.
Older interrupted install journals use the same order; an already committed
active version remains authoritative. Explicit backup restoration also preflights
retained mod trees before publishing canonical data, including recovery replay.
Failed copies preserve original sources and pre-existing destination packages;
complete additions may already be present. Retrying recomputes from those copies.
Interrupted private staging is retained in the existing owned staging namespace;
this does not promise automatic reuse or cleanup of orphaned private copies.

Before first Play, a historical runtime without proof of completed Core data
restoration uses additive collection: canonical-only files stay, and differing
common files hold for preservation review. A successful full restore records
`.portcove-psx-data-restored.json` at the installation root, bound to the registered
install and manifest. This lets subsequent collection preserve deliberate saves,
settings and mod selections made before first Play. It is not a launch receipt or
game-file/edition validation. Missing or stale proof never authorizes destructive
collection; malformed or future proof holds rather than being overwritten. Only
the exact PS1 metadata path and its defined atomic-write temporary names are
excluded from package integrity checks. No undeclared `mods` path is adopted.

## Managed ReGaiden shared preferences

The reviewed v0.4.1 Windows package uses the constrained
`gbrecompiled-windows-v1` consent-bearing policy. An exact direct release or
reusable GitHub package rules bind acquisition through the configured provider;
`managed_shared_preferences_save_id` records the reviewed upstream
save basename independently of the executable name. New declarations require
staged-source capability 19 for direct manifests or 21 for GitHub discovery, and the
`regaiden-gbc` materialization that older engines cannot parse. Core retains
explicit review of the Windows account and both shared/local preference paths
in schema7 installation manifests. Local saves/settings are managed; the
account-wide file is never owned, backed up, restored or deleted. Scope cannot
travel through adoption, relocation or library transfer. See the
[exact contract and manual reinstall recovery](reference/managed-regaiden.md).
Historical prepared registrations retain their previous non-owning semantics;
this route neither migrates them nor establishes gameplay qualification.

## Managed RaceWave46 sign-in boundary

The reviewed official Windows v1.0.0 package uses the reusable
`version-local-retroachievements-v1` runtime-data policy requiring staged-source
capability 19 for direct manifests or 21 for GitHub discovery. Core binds the
provider's exact artifact facts to the retained rules. Ordinary `.runtime` saves and
settings are managed; RetroAchievements credentials stay inside each version.
They are never opened, hashed or copied. Whole-tree transfer and recovery refuse
known credential names before reading payloads and again before publication.
See [data ownership and manual recovery](reference/managed-racewave46.md).
This user-side acquisition route does not authorize redistribution or remove
upstream contribution-license caveats. Existing external registrations retain
their historical contract.

## Exact relative-file sources and managed TFE

`relative-file-set` is an explicit source representation and projected source
kind. Unlike historical basename-only file sets, each member declares a portable
relative path, exact size and SHA-256. Required members must cover the managed
runtime targets bijectively with matching hashes; directory and ZIP namespace,
size and caller-budget checks precede member admission. The normalized aggregate
uses its own versioned SHA-256 protocol, including single-member sets. Existing
basename file-set identities and aggregates are unchanged.

Member hashing and owned staging use bounded 128 KiB chunks for directory and ZIP
sources. Directory reads retain no-follow, single-link and before/after object
identity checks; cache revalidation uses the same streaming path. Cancellation
is checked between chunks. A hash or size mismatch refuses admission/publication,
and interrupted writes stay in the existing private staging/recovery boundary.
The 128 MiB member, 512 MiB aggregate and 256-member capability limits remain:
the current reviewed 48-member Dark Forces representation totals 68,386,776 bytes,
with a largest member of 14,244,049 bytes (catalog measured 2026-10-27). No reviewed
supported representation was demonstrated to need a larger bound. Streaming
reduces scratch allocation; it does not expand source or archive authority.

The reviewed Windows TFE v1.22.420 package selects the constrained
`tfe-dark-forces-portable-v1` initializer and requires staged-source capability
**19** for direct manifests or **21** for GitHub discovery. The retained definition supplies executable and package rules; an exact
direct release or the configured GitHub provider supplies changing artifact facts.
Its checked complete game-data layout, pilot/settings initialization and recovery
remain Core behavior. The exact old initializer retains its original meaning for
persisted consumers. Transport schema **75** originally added the relative source shape and managed initializer;
older consumers must refuse unsupported semantics. Full source inspection and
bounded quick filter observations are distinct: the latter returns `NotChecked`
for this shape. See [managed Dark Forces setup and recovery](reference/managed-tfe.md)
for player workflow, persistence boundaries and the removal recovery hold.

## Default covers

Ordinary single-record preparation uses [the authoring entry point](#adding-or-changing-a-port).
It enriches both listing-only records and integrations through the same cover
matching, decoder and fallback policy. Shared descriptive facts live once in the
authored record; the strict projection places the mapping in `presentation.artwork`.

For bulk cover preparation across both listing-only records and integrations, use
the same entry point with a selected workset:

```text
node scripts/prepare-port.mts --artwork-ids fragglet-sdl-sopwith,faxanadu-recomp --validator-cli TRUSTED_PORTCOVE_CLI --output-dir /path/to/cover-preparation
```

This mode reads the complete per-ID source catalog and accepts a logical workset
of unique known IDs, automatically continuing through bounded operations of at
most 400 identities. It collects no upstream repository/release facts. A
522-record directory needs one logical specification; accepted per-ID progress
resumes after interruption. Provider request, byte and time ceilings remain
unchanged. Optional `--identities` and `--credentials-file` work as in
single-record preparation. `--refresh-artwork ID,OTHER_ID` refreshes only IDs in
the selected workset; otherwise accepted mappings are reused. Project, issue,
record, release and route options cannot be mixed into an artwork-only batch.

The checkpoint retains per-ID proposals, full generated projections and precise
cover outcomes without editing accepted sources. A successful identical workset
reuses its receipt. A mixed result retains useful proposals and reports
`pending_port_ids`; review and accept the useful per-ID files, then retry only the
pending subset. Missing credentials or a failed match does not block other records.
Use a new checkpoint for a fresh scheduled refresh of unchanged mappings. Core
listing inspection runs when a validator is supplied; operational projection
changes require it. Neither mode changes local artwork choices or publishes data.

For a strict operational catalog proposal, use
`node scripts/generate-catalog.mts --prepare-proposal PROPOSAL.json --validator-cli TRUSTED_PORTCOVE_CLI --output-dir NEW_OUTPUT_DIRECTORY`.
Optional artwork facts/credentials/refresh flags are the same as below. This
mode snapshots the explicitly selected CLI, checks accepted/input/output catalog
declarations through `catalog inspect-proposal`, and prepares existing artwork in
the same output. `proposal-evidence.json` adds exact input-byte/core receipts,
typed per-port declaration hashes and the complete accepted-to-proposed diff;
`artwork-evidence.json` retains its distinct cover reasons and provider costs.
The additive `proposal_changes` report matches ports and named source records by
stable ID. Each changed port includes its old/new display name and exact source,
execution, persistence and other changes; source identities/contracts/validators/
evidence are reported by collection and ID. Record insertion or removal does not
make unchanged siblings appear modified, including games sharing a repository.
Ordering changes are explicit. The same report accompanies `--compare-historical`.
These groups describe declared fields, not acceptance or inferred dependency
impact. The complete `differences` and Core receipts remain necessary: unkeyed
qualification facts and other catalog fields are outside this named-record report.
Full proposals also include `declaration_cases`: complete before/after ports,
shared source tables, unchanged port fields, accepted peers referencing the same
declared adapter, and the exact inspector receipts for each case. Shared source
records and adapter peers appear once. Per-case source references name identity
and contract IDs and qualification ordinals in that side's source table; follow
their declared validator/evidence IDs to reconstruct the complete scoped records.
No shared evidence or peer list is copied into every case. Cases include unchanged
port definitions when their declared source/evidence/qualification relationships
change. They are ordered by stable port ID; source-record order and exact scoped
qualification remain preserved. Unreferenced source changes stay in the complete
diff rather than being assigned to an unrelated port. These relationships are
not validation impact, capability fit or permission to reuse qualification.
Declared evidence is neither authenticated nor executed by proposal preparation;
an absent per-port inspector receipt remains null. Existing preparation/artwork
costs are linked separately. Engineering, application/harness changes,
interventions, maintenance execution, eliminated work and comparative savings
remain explicitly unmeasured. Preparation does not establish subsequent artifact
compatibility or delivery speedup.
All files remain unsigned proposals. No publisher grant, artifact authenticity,
actual source/operation/gameplay qualification or production delivery is inferred.
The `compatibility_fixture_review` report compares proposed source and port IDs
with the frozen schema-1 identities plus the independently reviewed lists in
`catalog-legacy-additions-fixture.json`. Missing or unreviewed IDs require a
manual fixture review; preparation can still describe an unreviewed candidate.
The generator never updates these expectations. Ordinary generation and `--check`
refuse an identity mismatch before replacing embedded bytes. This cheap check
does not establish full source-contract equality: Rust still compares complete
frozen legacy projections and retains its qualification and negative assertions.
Add independently reviewed additive IDs to this fixture once instead of updating
the expected count and three exclusion lists separately. Do not regenerate the
fixture from the catalog or derive expected identities from a proposal.
An unavailable validator or failed declaration check stops this proposal, retains
its process receipts and leaves the accepted catalog/libraries unchanged. A new
output directory is required; an interrupted or prior batch is never overwritten.
Full proposals capture the selected validator before declaration checks. Their
image decoder takes its own snapshot from that captured artifact only when fresh
image bytes need validation, then reuses it for the batch. A reuse-only batch
therefore retains one executable snapshot and creates no image-validation scratch
library. Decoder initialization failure is not retried within the batch; existing
artwork exception/fallback handling remains responsible for the result. Artwork-only
preparation keeps its eager selected-tool snapshot boundary.

Prepare a cover beside each new port definition. Search its public project name
and known aliases first; accept an exact port record only after checking the
underlying title and project identity. Keep the original-game identity separate.
Prefer a usable port cover, then the exact original game, then generated fallback.
Record ambiguous, coverless or unavailable candidates as finite exceptions.
Explicit local selections remain preferred; artwork never grants game support.

`presentation.artwork` contains the selected IGDB game/cover/image identities,
fixed CDN image digest and match kind. Maintainer preparation uses private Twitch
credentials; clients need no key and only fetch the bounded mapped image through
the existing shared resolver. Do not bundle images or treat display permission as
Steam export permission. All current and future covers use the shared full-image
presentation: preserve aspect ratio, show the complete cover, and use the card's
surface instead of a generated colored matte. Generated colors return only when
no usable image is displayed.

The [2026-09-30 identity receipt](archive/2026-09-30-igdb-catalog-cover-identities.json)
records the catalog-wide preparation, accepted port and original identities, and
port-specific exceptions. It is dated evidence, not another scheduling tracker.
Preserve accepted mappings when adding entries; investigate only additions or
changed references. Ordinary schema-2 catalog proposals can prepare covers and
their evidence in the same batch using the existing generator:

```text
node scripts/generate-catalog.mts --prepare-artwork PROPOSAL.json --identities FACTS.json --credentials-file PRIVATE.json --validator-cli TRUSTED_PORTCOVE_CLI --output-dir NEW_OUTPUT_DIRECTORY
```

Maintainers can save an existing private credentials-file path once per user with
`node scripts/maintainer-config.mts set-igdb-credentials-file ABSOLUTE_PATH` and
inspect its redacted, no-network status with `node scripts/maintainer-config.mts check`.
The versioned `~/.portcove/maintainer.json` contains only the path and is shared
across worktrees outside Git. Explicit `--credentials-file` takes precedence.
Configuration and credentials are read only when provider authentication is
needed; accepted reuse and fallback do not require them. Credentials, tokens and
private paths stay out of proposal evidence and client bundles.

The optional facts document is keyed by stable port ID. Ordinary port matching
uses the definition's public name and exact project URL without a supplied IGDB
ID; a unique exact name/alias plus matching provider project website is required.
Its optional `port` and `underlying_game` records supply public `names` and
attributable HTTPS `evidence_url`, with an exact `project_url` for name-based port
matching. A reviewed original title may use its attributable upstream project URL
for a bounded exact-name lookup; known `platform_ids` and a specific `edition`
narrow that match when supplied. An independently established positive IGDB
`game_id` and exact `slug` may pin a known identity. These are proposal inputs,
not admission authority. Original-title lookup requires one exact eligible match
in the complete bounded result set; undeclared editions, ambiguity, sequels and
truncated results remain fallback. All supplied identity facts must agree before
image acquisition. A coverless port falls through to its identified original game.
Missing, ambiguous, mismatched or
unusable assets produce specific nonblocking cover exceptions and generated
fallback; a decoded image cannot establish semantic identity.

The assembled accepted records are the baseline. Artwork preparation also reads
accepted listing-only covers, so adding a managed integration can retain its
reviewed artwork. This artwork context has a separate evidence digest and does
not expand the accepted Core operational baseline. A changed source profile still
requires a matching explicit original-game identity to reuse that game's cover.
Unchanged port/source
identities reuse accepted mappings without provider requests; distinct ports may
reuse a uniquely accepted original-game mapping without merging their identities.
An ordinary executable release does not trigger artwork searches. For an assessed
reference change, `--refresh-artwork PORT_ID,OTHER_ID` explicitly refreshes those
batch entries. A failed refresh retains the matching permitted accepted mapping
for uncertain or transient failures, including HTTP404, authentication/network
errors and rate limits, without claiming live validation. HTTP410 from the fixed
IGDB image request identifies that exact image as Gone: preparation excludes it
from every reference in the output batch, regardless of record order, and records
its image identity/status. Existing exact-port/original selection can supply a
checked replacement; otherwise the generated/text fallback applies. Gone for a
different candidate image does not invalidate an accepted mapping. Unchanged
entries still make no provider requests. This bounded observation changes only
the unsigned proposal; accepted inputs, client choices/cache and protected
acceptance remain unchanged. It does not establish live provider removal or a
legal withdrawal.

The new output directory is required to be absent. It receives
`catalog-proposal.json` and `artwork-evidence.json`, including exact input/baseline
digests, artwork differences, per-cover reasons/checks/exceptions and request/byte
counts. No source catalog, client preference, signature or published feed changes.
Fresh image bytes pass the existing core decoder through the explicitly selected
trusted CLI and fresh task-owned scratch libraries. No new decoder or publisher
is introduced. Credentials stay maintainer-side; output carries fixed references
and digests, never credentials or image payloads. Scratch libraries retain local
validation material and are not a distributable image archive.

The provider route is sequential, has one lazy authentication attempt, no retries,
and bounds metadata/image requests, bytes and execution time. A valid `Retry-After`
on a captured metadata 429 or 503 postpones the next metadata request, preserving
the normal 300 ms floor. All three HTTP-date forms are interpreted in UTC,
including the zoneless asctime form, independently of the authoring host timezone.
Decimal seconds and HTTP dates retain the actual provider reset, including a
pause beyond the current 15-minute operation. Such a pause refuses further
requests without sleeping past the operation deadline. Metadata and image
429/503 responses preserve their separate retry clocks across bounded operations.
Waits and requests accept cancellation. Failed identities are not automatically
retried within the logical invocation, and uncertain failures retain eligible
accepted metadata. Fixed OAuth, metadata and image responses are consumed within
finite byte bounds or their unfinished bodies are cancelled when refused.
Cleanup does not drain rejected payloads or await an arbitrary cancellation
promise; reader locks and original failures are preserved. Retained references
are not fresh source-health evidence.
This command prepares the cover role only;
other roles, full backlog coverage, protected acceptance/publication and installed
or physical-platform evidence retain their own acceptance.

### Reference and exception maintenance

Use the existing catalog/onboarding maintenance checkpoint weekly. Run
`prepare-port.mts --artwork-ids @due --output-dir EXISTING_CHECKPOINT` to select
missing, invalid and then oldest observed references automatically against the
28-day refresh target. Unknown dates remain due. Explicit
`--artwork-ids ID,OTHER_ID --refresh-artwork ID,OTHER_ID` remains supported.
This is the existing operator cadence, not a new scheduler or player startup task.
Ordinary executable updates do not refresh artwork.

A logical workset may exceed 400 IDs. The driver admits operations of at most 400
selected IDs and adjusts subsequent admission using observed elapsed time,
requests and image bytes. Completed identities are atomically checkpointed after
each result under the existing preparation lock. Reinvoke the same full workset
after interruption or provider recovery: unchanged successful IDs are reused;
changed per-ID identity, relevant accepted-original mappings or validator bytes
invalidate the affected result. Earlier attempt receipts remain available.
A provider-blocked operation leaves its IDs pending while later unrelated or
offline work continues. A fully deferred operation is never blindly retried.
Provider Retry-After dates remain durable, and incomplete work never claims
successful full maintenance. Retained mappings after unavailable refresh remain
pending. Proposed records still require the existing review and delivery route.

The full input retains its bounded 10,000-record authoring contract. Each provider
operation retains 800 metadata queries, 400 image queries, 32 MiB metadata,
512 MiB images, 16 MiB per image, 15 minutes and 15 seconds per request.
Processing remains sequential with at least 300 ms between metadata starts,
one lazy authentication attempt per invocation and no failed-request retries.
A bounded 32 MiB metadata memo avoids repeated matching, image downloads and
decoding within the logical invocation. Memo reuse retains the earliest actual
observation clock; it cannot make old facts fresh. Per-ID checkpoint documents
are bounded to 8 MiB and contain metadata and digests, never image payloads.

Unknown or repeated IDs and changed artwork identities outside the selected
workset are refused. Results merge by stable ID. An exact-image Gone observation
removes every matching output reference, including unselected and checkpointed
records, without additional provider queries. Accepted source records, user
choices, source licensing and offline fallback stay authoritative. Only a
changed accepted image needs new semantic review and affected display validation.

Recheck the bounded missing-fact/resume exceptions at the same checkpoint; query
again when attributable facts, asset/provider state or a previous transient
failure changes. Preserve one current exception per stable port/role rather than
opening another owner queue. Absence of a current admitted definition stays with
its existing per-port/onboarding owner; it is not a successful artwork exception.

The [official IGDB documentation](https://api-docs.igdb.com/#rate-limits), checked
2026-10-18, permits four API requests per second and eight open requests.
Its [image guidance](https://api-docs.igdb.com/#images) says removed/replaced images
remain on its servers for 30 days. That is server behavior, not an observed expiry
or an image-retention license. The [caching FAQ](https://api-docs.igdb.com/#faq)
allows caching API data; it does not establish rights to bundle, mirror or export
a particular image. Keep maintainer authentication private and existing attribution.

Transient failure/404 preserves only eligible permitted known-good state and
reports uncertainty; an observed HTTP 410 or a concrete withdrawal/invalidation stops
that image's reuse in the proposal, preserving the exact reason and scope. Prepare
a validated replacement or generated fallback through the existing protected
catalog correction route. Retained bytes are not permission to continue a known
forbidden use. Client propagation needs its own accepted signed correction; an
unsigned maintenance report cannot revoke trust or mutate installed libraries.
Local imports/choices/corrections and unrelated game data remain independent of
remote cache eviction. Broader production correction remains with #1155/#246/#534.

Generate the embedded catalog with
`node scripts/generate-catalog.mts`, then run selected local checks and the opt-in
`just desktop-verify --scenario native-default-cover-display --require-clean`.
That scenario derives its cover inventory from the actual native catalog, checks
every mapped cover in both themes, and captures representative detail surfaces.
Live CDN evidence is separate from ordinary offline CI and signed publication.

For managed setup, `setup_output_paths` declares safe relative generated files
or directories. They cannot overlap game/setup executables, persistent data,
disposable runtime state, the materialized source, or one another. The completion
marker must belong to a declared output path. Older definitions may omit
the field and remain readable, but cannot acquire the explicit preparation-plan
capability without a reviewed output contract. These paths add no manifest
exclusion or permission to trust newly hashed files.
Output paths are relative to the install root; setup markers, persistent paths,
and disposable runtime paths are relative to the runtime working directory when a
nested runtime is declared. Managed preparation permits that nested working directory only for
the upstream-managed adapter and still checks every generated path against the
install and runtime ownership boundaries.

Generated setup trees use a separate portable-path check from downloaded
archives. It preserves Unicode names byte-for-byte, rejects traversal,
Windows-unrepresentable names, and collisions under NFD full Unicode case
folding with default-ignorable code points removed. It does not apply
compatibility normalization that could merge distinct names. Library transfer
and import use the same check so verified generated assets keep their names when
copied. The stricter ASCII archive-member policy remains in place for downloaded
packages.

The OpenGOAL family declares `data/iso_data`, `data/decompiler_out` and `data/out`,
following the [extractor](https://github.com/open-goal/jak-project/blob/ce97ce959b8c773097f593bf42f470555f6a6e2b/decompiler/extractor/main.cpp)
and its [decompilation output](https://github.com/open-goal/jak-project/blob/ce97ce959b8c773097f593bf42f470555f6a6e2b/decompiler/decompilation_process.cpp)
contract. Saves and `data/log` remain separately owned. These declarations are
implementation facts, not new artifact or platform qualification.

PaperBoat uses the same isolated preparation transaction through the
Libultraship adapter. Portcove normalizes the registered Paper Mario source to a
private big-endian `.z64`, runs only the checksum-qualified PaperBoat executable,
and admits `pm64.o2r` plus the optional Torch hash record as version-owned output.
The upstream setup window remains visible; after generation the user chooses its
close option rather than launching outside Portcove. `SHIP_HOME` points at the
private copy during setup and at canonical user data during supervised play.
Generated game data therefore rolls back with its release, while saves,
configuration and mods remain separately backed-up player data. Logs remain
disposable. This contract does not claim a ROM, gameplay, Steam Deck, macOS, or
unpublished-release qualification.

Open Nectar 0.8.5 creates a `shader_cache` directory beside its Windows runtime
on launch. The catalog treats that exact directory as disposable runtime output;
its `save` directory and `pikmin_settings.conf` remain Portcove-managed player
data. Preparation capacity checks reserve a full GameCube disc image for
materialization and a separate disc-sized allowance for generated setup output,
in addition to the copied installation; the registered compressed file size
alone cannot represent that peak. The [2026-09-24 Windows observation record](qualification/open-nectar-pikmin-windows-observations-2026-09-24.md)
describes setup, startup and persistence evidence and its limits. This runtime
observation does not establish gameplay qualification.

`crates/portcove-core/catalog/catalog.json` is the machine-readable authority
for actual ports, platforms, upstream sources, release channels, adapters,
source contracts, and qualification evidence. The catalog grows continuously
and independently of Portcove's product release stages. Durable prose must not
copy its current count or maintain a second title list.

## Continuous admission

A candidate is eligible when it has an attributable upstream or accepted
user-provided-runtime route and a useful operation Portcove can perform safely
on at least one declared platform. Record acquisition authority, exact artifact
identity where bytes are acquired, required game-source identity, and the
platform and operations actually offered. Each offered operation needs its own
bounded executable, setup, ownership, consent, persistence and recovery
contract. Unknown saves may coexist with non-destructive launch; they do not
authorize replacement, cleanup, backup, restore or deletion of unowned bytes.
Missing gameplay observations, active upstream maintenance, automatic updates,
complete save mapping, every platform, or a reusable family adapter are not
universal admission gates. Prefer an appropriate official package, supported
upstream preparation or useful non-owning existing installation before a
title-specific exception. An exception needs an identified consumer and bounded
maintenance reason; disproportionate downstream engine repair/build work can
instead justify a precise upstream dependency or product deferral. Any retained
glue uses the shared acquisition, transaction, persistence and lifecycle owners.
A bare upstream link or placeholder is not an integration.

Schema-2 GitHub proposals may carry `release.curated`, keyed by declared platform.
Each version-1 record binds repository/upstream, canonical original GitHub release
asset URL and host, release/tag/commit/asset identities, platform/route, safe
filename, nonzero size and canonical SHA-256. Acquisition, distribution,
independent-review and protected-acceptance evidence references carry bounded
HTTPS locations and exact declared digests. Distribution basis is explicit.
These are inert declarations: shape validation does not authenticate the
referenced evidence, publisher, build or distribution permission.

The existing Core proposal inspector includes each record's declaration hash
alongside its port hash without fetching or changing anything. Empty maps are
omitted from serialized definitions, preserving existing declaration identities.
Schema-1 and non-GitHub curated proposals are refused. Custom providers and
legacy managed GitHub grants refuse curated declarations. The explicit
[schema-4 capability](DEFINITION-DELIVERY.md#exact-definition-availability-policy)
requires independent policy admission, exact fresh upstream identity and the
shared byte verifier; library schema 36 retains immutable accepted identities
against silent repinning and authenticated scoped transition receipts. Exact
artifact revocation holds acquisition and critical installed use; distribution
withdrawal holds acquisition while permitting local use under existing guards.
Future-acceptance loss is a separate fact and does not revoke historical bytes.
Neither expiry nor omitted transitions erase a recorded hold. Record preparation
still grants no runtime authority.
[#315](https://github.com/boburning/portcove/issues/315) remains incomplete until
verified cache reuse, scoped holds, recovery and lawful canary qualification
establish the full offered route. No client-observed self-hash acceptance is
introduced by record preparation.

GitHub Stable selection excludes provider-declared prereleases, existing
hyphenated development markers, and case-insensitive numbered beta suffixes
such as `Version1.0.5beta12`, even when upstream leaves its prerelease flag unset.
Preview (`beta`) selection still requires the catalog to declare that channel; classification
does not grant compatibility or installation authority. No selectable stable
release produces an unavailable result, rather than falling through to a beta.

Managed `staged-source-portable` execution requires complete immutable install
verification, including nested package selectors previously recorded as
noncritical. Retained adapter identity selects this policy; changing the current
catalog cannot remove it. The existing mutable and generated-metadata rules
remain in force, while recorded immutable files cannot become exempt through
new mutable declarations. Inventory refuses redirected/unsafe filesystem objects
and is bounded to 100,000 entries and depth 64. These sequential observations
provide no filesystem snapshot or execution sandbox. External user-prepared
inspection remains its separate non-owning route.

API 80 / staged-source version 20 adds an explicit `trust: "user-selected"`
existing-installation route. The definition supplies identity and useful setup
instructions; the player selects a native executable, working directory and
bounded argument array. Core reviews those exact inputs, confirms execution
intent and retains them for supervised launch. It checks executable/path safety
and refuses script launchers and library-owned locations. It does not certify an
official package, require a catalog-pinned immutable tree, inspect unrelated
external contents or acquire ownership of them. Runtime replacement belongs to
the player or selected upstream launcher. Only launch and registration removal
are offered; external installation, save and settings files remain untouched by
removal. The launched program can make its normal writes; this is no sandbox.

This mode has empty archive/tree/executable-hint/mutable-path declarations and
cannot combine with source invocation, managed policy, bundled runtime, setup
or managed-build hooks. Historical source-catalog identities remain preserved
without an active source binding or a source-validation claim. New retained
records explicitly distinguish user intent from accepted-package certification
and make older readers refuse the new meaning. Unknown trust values are refused.

Catalog schema 1/2 supports hosted or exact direct-manifest package installation
through its existing adapters. The `user-prepared` release route is separate:
an official definition pins the package's exact archive identity and the
immutable extracted tree, executable, platform, and explicitly mutable game
output. Core only inspects and records a player-owned folder; it does not
acquire, extract, own, update, back up, relocate, or delete that folder.
Only catalog entries that declare and qualify this route offer it. [#1169](https://github.com/boburning/portcove/issues/1169)
owns the first real-port qualification and its remaining end-to-end evidence.
An optional `presentation.manual_preparation` gives the exact player-created
steps for a user-prepared runtime; the short port summary remains an outcome
description. The Wave Race pilot requires an empty `portable.txt` beside its
executable, in addition to the extracted upstream ZIP files.
Optional `presentation.manual_setup` supplies authored `steps` (one to eight
objects with nonempty `title` and `instruction`), up to eight essential `warnings`,
and an optional HTTPS `help_url` without credentials. Include `warnings: []`
when no warning is needed; omitting the required array does not produce a
Core-readable guide. Use preparation's Core inspector
or the required catalog checks to validate the complete projection. These
presentation facts are never executable recipes or evidence that a step was
completed. Current prepared routes supply them separately from the retained `manual_preparation`
compatibility and technical notes. Older definitions keep their prose fallback.
Clients keep warnings visible, show numbered steps, and disclose the longer notes
without parsing free-form prose or changing file/operation authority.
A platform-specific prepared spec may opt into `library_user_data: true` for
`staged-source-portable`, with a safe `user_data_environment` name on the port.
After retained-package and original-source revalidation, Core creates only the
private `<library>/user/<port>` directory and binds its absolute path for launch.
Existing private contents are preserved; missing parents, links and non-directory
paths are refused. Omitted or false flags create no directory and bind no variable.
This declaration requires staged-source template contract version 2. It does not
migrate AppData, qualify an upstream package, or grant update/backup ownership.
Removing the external registration preserves both the external folder and private
user files. No current title is admitted by this generic engine component.

API 79 / staged-source template version 18 adds the opt-in prepared spec flag
`source_directory_environment: true`. It requires `staged-source-portable`, a
`relative-file-set` source profile, and a safe port `source_environment` name.
Core revalidates the retained runtime and original-source contract, requires a
real directory without redirected ancestors, then binds its absolute path through
that variable. An otherwise valid relative-file-set ZIP is incompatible for this
route; Core does not extract it. Authored fixed arguments remain available, while
caller-forwarded arguments are refused. This flag cannot combine with a positional
source extension, settings/shared-preferences selector, or the version-17 Windows
positional-file path policy. Omitted/false retains previous behavior.

The existing relative-file-set bounds and identity scope remain unchanged: exact
declared members are authenticated; additional scanned files are not thereby
authenticated as a complete original tree. This binding grants no runtime write
protection, source ownership, assembly, acquisition or update authority. A source
directory alone does not establish a safe title route. Opt-in registrations retain
the strict contract envelope so older readers refuse rather than ignore this
binding; indexed definitions must declare a minimum staged-source version of 18.
Private user data can reuse `library_user_data` after source verification. No
re:Blue definition, game-data hashes, executable, or operation acceptance is added
by the generic capability.

Mutable paths exempt player-owned output bytes from the immutable digest, not
from filesystem safety. Every regular mutable file must have exactly one
filesystem link during both sweeps of full prepared-runtime inspection, including
the inspection before launch. This applies even when no required selector is
declared; a hard-linked save or settings file could otherwise redirect a game
write into the original installation or other data. Independent mutable content
may still change without changing package identity. These observations do not
freeze player-owned paths after inspection or provide an execution sandbox.

A `staged-source-portable` prepared spec may declare up to 64
`required_mutable_files`, each an exact relative file path within its declared
`mutable_paths`. Portable path keys must be unique, including case aliases.
For example, The Force Engine's portable selector is a mutable `settings.ini`:
its presence selects the program directory instead of host Documents, while its
contents legitimately change. Core observes each required file as a regular,
non-redirected file with exactly one filesystem link before inspection, at the
final callback-free inspection boundary, and during registered-location readiness.
Missing files, directories, symlinks, reparse paths and hardlink aliases refuse
readiness or the affected review/launch operation. Contents are neither hashed
into immutable identity nor frozen between observations. These checks do not
provide an atomic tree snapshot or an execution sandbox.

This declaration requires staged-source template contract version 4; versions
1–3 and omitted/empty declarations retain their previous behavior. Independently
delivered entries must declare version 4, and complete typed projection prevents
an older reader from silently dropping the new constraint. The retained
registration contract continues to enforce it after a current definition changes.
Registration creates no selector, claims no external ownership and changes no
original files. Preparation instructions must explain how the player creates
the reviewed selector; removal of registration remains available if it is missing
and preserves all external files. This capability alone admits no TFE package,
source input, native operation or managed maintenance route.

Registrations using required mutable files retain the existing strict contract
envelope instead of a raw catalog document. Older external-runtime readers
refuse that envelope because they require a raw catalog's schema and port list;
they cannot silently drop the selector requirement after a client downgrade.

Staged-source version 5 adds the optional `settings_contract` value
`tfe-dark-forces-v1.22.420`. This is a narrow read-only contract for the pinned
Windows x64 TFE parser, requiring version `1.22.420`, a root executable/working
directory, no runtime subdirectory or launch arguments, no source argument or
private user-data binding, and required mutable `settings.ini`. `GameData` must
remain wholly immutable; all four GOB files must be regular, non-redirected
objects. The accepted tree authenticates their bytes and required companions.
The settings reader requires one effective `[Game] game="Dark Forces"` and one
`[Dark_Forces] sourcePath="GameData/"` assignment. It checks the existing opened
selector at each inspection boundary, without writing settings or granting
ownership. Other preferences remain mutable.

This reader follows the consequential rules in TFE commit
`cc25205cc94c36a396f6f50295772f6ec83069a2`: case-insensitive section/key/game names,
whitespace/comma/equals separators, comments even inside quotes, and empty-quote
tokens. It conservatively refuses malformed sections, duplicate effective
selectors, unmatched quotes, NUL bytes, files exceeding 1 MiB, raw lines of
4096 bytes or more, tokens of 1024 bytes or more, and decoded CVar values of 256
bytes or more. A string CVar's second space-delimited word must also contain at
least two bytes when present, avoiding the pinned reader's empty-tail write.
Forwarded launch arguments are refused using the retained declaration before a
launch session is created. These limits protect the reviewed line/token/CVar buffers;
they do not establish general upstream memory safety. Valid selected data prevents
Dark Forces source fallback while observed valid; TFE may still probe host paths
for other games. Sequential observations neither freeze player writes nor
provide a sandbox.

Independently delivered entries must require version 5. Retained registrations
reuse the strict installed-contract envelope: older v4 readers reject the
noncanonical projection when they cannot preserve this field. This refusal
does not extend to newly supplied plain legacy catalogs, whose older decoders
may discard unknown fields. Such catalogs are not a compatible delivery route
for this declaration. The component alone admits no TFE package or source and
claims no native operation, production-client delivery or managed maintenance.
Both ordinary and bounded readers decode the same retained contract. Registrations
without this opt-in keep their existing encoding; no library-wide schema migration
or external-file ownership is introduced.

Custom cartridge creation capabilities 6, 7, 9, 13 and 14 are retired.
The old N64 v3 CVLoD recipe is also read-only compatibility. New definitions
cannot offer these builders; retained installed contracts preserve their exact
historical runtime meanings. See
[retirement and consumers](reference/upstream-first-compatibility.md).

Staged-source version 8 adds optional prepared-runtime `shared_preferences`
with the single value `regaiden041-windows`. It is restricted to the exact
ReGaiden 0.4.1 Windows x64 archive and staged-source use-in-place route. It
accepts no arbitrary external path. Windows resolves the shared roaming file
`gbrecompiled/runtime/runtime_prefs.ini` without creating it. Review discloses
the resolved path, current account fingerprint and present/absent state;
registration requires explicit acknowledgment of that exact preview. CLI
requires `--acknowledge-shared-preferences` with `--expected-preview`, in
addition to ordinary consent; Desktop presents a separate native acceptance.
Generic confirmation or the legacy Core authorization method cannot opt in.

The retained binding preserves the accepted account and path. Preference
contents may change normally; safe directory ancestors and a regular
single-link file are rechecked before launch. Account/path changes require
fresh registration. Other copies can overwrite this shared file and discard
unknown entries. Portcove does not own, migrate, back up, restore or delete it.
This is an explicit shared write scope, without private isolation or a sandbox.
Forwarded launch arguments are refused for this exact prepared contract.

This closed contract supplies `--rom` before the separately validated raw
`.gbc` source. Its only catalog arguments are `--save-dir saves`; an existing
safe `saves` directory is required. The five game-owned mutable paths are
`config.ini`, `runtime_prefs.ini`, `imgui.ini`, `saves` and `snapshots`. Review also discloses
the local preference fallback. Existing files must be regular and single-link,
and existing ancestors must not redirect through reparse points. Inspection,
registration and removal create no preference or save data. Printable ASCII
Windows paths and a conservative MAX_PATH allowance for generated transaction
filenames preserve the selected runtime's narrow-path behavior. These are
sequential path observations, not filesystem isolation after launch.
Indexed entries using this exact shared-preferences contract require minimum
staged-source version 8. Earlier public versions remain available only for their
implemented contracts; retired creation versions 6 and 7 are absent from the
public inventory. Private retained readers preserve their identified historical
runtime contracts without admitting new builds. Older readers that cannot
interpret shared preferences refuse through the existing strict envelope. See
[capability negotiation](DEFINITION-DELIVERY.md#implemented-engine-capability-negotiation)
and the [compatibility record](reference/upstream-first-compatibility.md).

Existing managed cartridge runtimes retain their original executable, arguments,
source receipt, mutable paths, protected companions and environment restrictions.
Preserving those readers does not retain source generation, engine patches,
compiler/linker orchestration or SDK acquisition. New Yoshi, Dr. Mario NES,
EarthBound, Render96 and Gundam definitions offer bounded user-managed
registration. Gundam's own supported setup pack performs generation and builds.
CVLoD continues to select official upstream packages; a new release does not
inherit private repaired-runtime or prior shipping-package observations.
Historical preparation instructions and failure receipts remain linked in the
[compatibility record](reference/upstream-first-compatibility.md).

Staged-source version 17 extends the printable-ASCII/MAX_PATH policy to a
Windows-only user-prepared runtime with a positional original-file argument.
The complete retained definition must require capability 17; managed version 11
keeps its existing meaning. Registration and folder changes check the canonical
executable and actual working directory. Readiness and launch also check the
selected registered original or source override, because these runtimes receive
that external path directly. Launch repeats the checks before child creation and
refuses caller-supplied arguments. Shared-preferences variants are outside this
narrow combination. This adds no acquisition, modification, backup or removal
authority over the external runtime or original files, and implies no particular
port's admission or actual operation acceptance.

Hosted
installation still requires a provider digest or verified checksum sidecar;
an exact direct manifest still requires an accepted HTTPS URL, size, version and
SHA-256 for each declared platform. The owner has approved catalog-curated
exact-byte acquisition under [#315](https://github.com/boburning/portcove/issues/315),
but its protected authority and runtime route must be implemented before use.
No client may accept bytes by hashing an arbitrary first download.

Every declared platform must provide at least one executable hint. A hint is an
ASCII safe relative path under the declared runtime root; a basename remains a
legacy shorthand only when it identifies exactly one file. Ordered alternatives
do not make an ambiguous basename acceptable. Catalog validation rejects
missing platform entries, duplicate hints, traversal, cross-platform filename
aliases, and macOS bundle directories in place of the executable inside the
bundle.

### Release selection and maintenance

Release asset hints should identify a stable port, platform, architecture and
package shape when automatic release selection is offered. A controlled N/N+1
test supports an automatic-update claim; it is not a prerequisite for a useful
pinned-release integration. If the selector cannot safely follow an ordinary
compatible release, record that limit and the exact condition for enabling
updates. A deliberate `DirectManifest`, rolling tag, source/runtime identity or
exact qualification record must not be broadened to manufacture automatic
updates.

An ordinary compatible upstream release must resolve and install with the same
application and unchanged definition. Author the reusable integration rules;
let the existing provider observe each release's version, asset ID, exact name,
URL, size and independent digest. Core retains those exact facts with the
installed artifact. A per-release JSON edit or automatic version-bump PR is not
compatible progression. Historical source links and qualification hashes remain
exact observations; their presence alone does not pin provider selection.
Managed preparation records observed release facts in its receipt and preserves
authored listing links, including a useful separate upstream launcher. It does
not add a current-tag listing URL to an otherwise reusable managed definition.

Preparation flags hints containing the observed release version for applicability
review. Prefer stable discriminating fragments, including the actual package
variant. Preserve numeric ABI/engine-generation requirements where intentional.
Test unchanged rules through the production provider for N, N+1 and a fresh
installation after N+1, including competing variants, foreign architectures and
successor-specific integrity evidence. Ordinary observed release changes do not
add a mandatory maintainer review or full gameplay campaign. Changed setup,
executable/data coordinates, ownership or package handling can require a reviewed
rule change; existing transition and recovery guards still apply.

The reusable managed TFE, GB shared-preferences and version-local credentials
policies support reviewed GitHub package rules as well as exact direct manifests.
Fresh dynamic acquisition requires an opaque in-process resolver binding to the
complete retained definition, platform, requested channel and exact release.
A serialized review cannot supply that proof: Core resolves again and refuses
changed facts before downloading. This binding is distinct from publisher-scope
authorization. Offline installed-version checks still use the verified manifest
and registered artifact, never today's latest release. Historical exact policy
variants and direct-manifest targets retain their original meanings.

Independent compatible definition delivery to installed clients remains with
[#534](https://github.com/boburning/portcove/issues/534) and
[#246](https://github.com/boburning/portcove/issues/246). It does not replace
dynamic release discovery or authorize production publication in an ordinary
catalog change.

Declare the offered route's maintenance policy on its existing canonical Port
issue during admission and subsequent disposition work, independently from its
operations and qualification. [#1422](https://github.com/boburning/portcove/issues/1422)
owns cohort reconciliation; completed [#254](https://github.com/boburning/portcove/issues/254)
provides repeatable proposal and evidence preparation, and
[#246](https://github.com/boburning/portcove/issues/246) owns protected compatible
delivery. These declarations are not new catalog schema fields or a second
planning registry.

Prefer `managed-compatible-release` when upstream releases are safely versioned
and observable and ordinary compatibility can be validated deterministically.
Every accepted release still retains immutable version, artifact and accepted
hash identity. A declaration describes the maintenance target; separately name
the observation, selection, executable, source, persistence and compatibility
checks actually implemented and any remaining facts or capability owner. It
does not prove a future package compatible, inherit gameplay evidence, authorize
publication, install an update, or override a player's keep-current choice.

Use `pinned-release` for a concrete upstream or safety limitation that prevents
compatible progression. Record the retained exact pin, the limitation and the
facts or checks needed to resume. An accepted immutable artifact, unfinished
research, missing optional gameplay or a gap on another platform alone is not a
pin justification. A direct manifest is a release representation, not a permanent
maintenance exception; a bounded observer and reviewed compatible candidates
may remain required work. Keep unknown facts explicit instead of inventing a
limitation.

Use `user-managed-update` for an offered non-owning user-prepared runtime route.
Its exact package and extracted-runtime checks remain required, but Portcove
does not update or replace that external runtime. Preserve the offered
registration/launch/removal boundary and all applicable holds; the declaration
grants no acquisition, backup, rollback or deletion right. Revisit the policy only
when an independently justified managed route or changed input warrants it.

A standalone Linux AppImage release may use a version-bearing asset filename.
When its port declares exactly one AppImage basename and no runtime subdirectory,
the installer gives the verified file that declared name before writing its
manifest. This does not apply to archives, setup executables, or ambiguous hint
lists. The original release filename, digest and size remain the artifact identity;
the installed executable path remains recorded per installation, so existing
installations and rollback retain their original paths. DKR-R retains its existing
declared runtime filename for compatibility; that filename is not a release-version
claim. Version displays and update selection use the recorded release identity.

Hosted GitHub and GitLab providers inspect repository metadata before every
resolution, including reuse of a five-minute in-memory release selection. A
host archive flag and Portcove's `Retired`, `Superseded` and `Abandoned` values
describe maintenance status; none alone proves unsafe bytes, revokes an exact
accepted release, or grants acquisition authority. A conditional `304 Not
Modified` reuses only the last semantically valid metadata body. If metadata
revalidation cannot reach the host, resolution fails with that network error
rather than silently using a cached selection. Known withdrawal, compromised
routes, changed accepted bytes, failed integrity and unsafe operations still
hold at their actual scope. Exact direct manifests retain their existing
per-platform HTTPS URL, nonzero size, version and SHA-256 requirements.

GitLab generic-package links can use the same reusable project, channel and
native-archive selectors. Core joins the selected versioned URL to independently
published package names, versions, filenames, sizes and SHA-256 values. It reads
all relevant bounded registry pages before claiming a unique match. If upstream
has uploaded different files to the same package/version/filename, a bounded,
redirect-free HEAD of that exact official project URL must identify exactly one
registry row through its published checksum and optional size. Repeated identities,
missing or conflicting integrity, ambiguous uploads and incomplete pagination
refuse resolution without caching a result. The joined filename must satisfy the
actual native archive/platform/variant rules; a display label is insufficient.
The new route downloads the exact URL it validated, then applies ordinary Core
byte verification and staged lifecycle protections. A mutable URL changing after
resolution can fail integrity safely; five-minute cache reuse is not a fresh
HEAD observation. Existing explicit package-file and published-description
checksum routes retain their behavior. This adds no per-release definition edit
or new approval/publication authority.

The earlier archive-state veto was completed under
[issue #212](https://github.com/boburning/portcove/issues/212) and remains
historical evidence. This availability-first contract supersedes that veto;
it preserves the independent release, source, archive, executable,
installation, rollback and retained-version checks. Broader retired-project
governance remains [#233](https://github.com/boburning/portcove/issues/233).

Discovery creates one durable issue immediately for every independently
catalogable or independently prioritizable port, with the direct upstream URL,
title identity, a durable game/target key for non-catalog candidates, neutral
Inbox/Watchlist fields, and an explicit statement that research intake does not
grant support. The key identifies the independently prioritizable game or
target, not merely a shared upstream repository. Project drafts are only for
fleeting non-port ideas. Triage records platform, artifact-integrity, source,
persistence, adapter, blocker, and resume-condition evidence. A newly cataloged
port does not automatically become a global V1
blocker.

## Channels, support, and qualification

Game-port release channels display as **Stable / Preview / Rolling**. Current game-port CLI inputs prefer `stable` / `preview` / `rolling`; `beta` remains a compatibility alias for `preview`. Both Preview spellings select the same existing stream. Canonical JSON, catalog, installation and preference values remain `stable` / `beta` / `rolling`; no serialized `preview` value or saved-choice migration is introduced. Copied commands and integrations may retain `beta` when the intended CLI's Preview input support is unverified, preserving supported older consumers. Changing the spelling does not select a different release. Offered channels, the selected stream and the actual upstream release are separate facts. Preview prefers eligible prereleases and can fall back to an eligible stable release; that fallback does not acquire an upstream Beta/Alpha designation. Original upstream tags/names, application Public beta milestones, qualification evidence and compatibility limitations retain their own meaning.

Stable, Preview, and Rolling are user-selected release channels, not qualification
claims. Preview is the human label for the unchanged `beta` machine value. An entry may offer Preview or Rolling, be platform-limited, lack qualification
evidence, or have documented blockers while the application continues toward V1,
provided the UI and documentation represent that state honestly.

Legacy `support_tier` values remain compatibility metadata, separate from release-channel choices. Neither a channel label nor a tier name supplies artifact/platform/operation testing evidence or removes a concrete compatibility limitation.

Schema 2 stores new source qualification in `source_catalog.qualification`.
Each record binds the port, platform, release artifact SHA-256, upstream ref,
source contract, exact variant and representation, check-contract version,
method, time, result, and reviewed evidence IDs. Structural checks, automated
lifecycle results, hands-on observations, and known failures remain separate.
The core derives an exact claim only when the whole requested scope matches;
adding an artifact, variant, representation, platform, or check version cannot
inherit an older result. Missing or not-run evidence remains distinct from a
bounded failure and does not change source admission.

`automated_tested_platforms` and `manually_validated_platforms` are retained as
legacy historical coverage. They identify a port/platform intersection but do
not identify the artifact or source variant that was exercised. Migration keeps
those arrays visible and does not manufacture exact records from them. New
qualification belongs in the scoped collection. Never promote synthetic tests,
a clean process exit, or generated files into hands-on evidence. Qualify each
declared platform independently.

For scoped records, `hands_on` describes direct observation of the specific
claimed behavior with the real runtime and any input or device relevant to that
claim; it does not encode the operator's identity. An agent can operate and
record that session.
Synthetic game data can establish bounded host lifecycle behavior but does not
establish gameplay, a physical-controller path, or a platform not exercised.
Retain the historical `automated_tested_platforms` and
`manually_validated_platforms` field names and their existing recorded claims;
this clarification creates no new qualification record or platform support.

### Qualification evidence preparation

For the repeated managed setup sequence owned by #1742, the existing report tool
accepts `--preparation-case FILE` together with `--cli`, `--library` and a new
`--output` directory. This mode performs reviewed preparation; ordinary capture
remains read-only. A case contains `format_version: 1`, `evidence_kind` (`synthetic`
or `actual`), the verified `cli_sha256`, an exact `environment` object with Node's
`platform`, `arch` and `node` values, and `plan`: the unchanged `data` object from
that CLI's `preparation plan PORT` response. Review the plan and its offered setup
before running the case.

The one fixed sequence re-reads the plan, refuses changed inputs, verifies the
original managed install, runs `preparation run` with its exact expected plan,
verifies the prepared install, and captures the new Core plan/inventory. Core
performs setup supervision, source checks, generated-output ownership, publication
and recovery; the report adds no execution language or installer. Artifact,
runtime, retained-definition, actual source inspection, host/target, setup and
conversion-tool joins must match. Unknown legacy source identity stays unknown.
Setup acceptance never promotes a separate source validator or gameplay result.

The new output retains `preparation-case.json`, per-phase raw Core responses and
`sequence.json`, including failures, elapsed execution and the existing operation
inputs/inventories. It never overwrites a prior attempt or automatically replays a
failed operation. Read activity/recovery before a fresh reviewed attempt. External
registration has no managed preparation operation and cannot acquire management
scenarios through this tool. Launch, gameplay, audio, input and save/load remain
unassessed; update/rollback/backup/removal are outside this bounded sequence.
Compiled production-CLI synthetic cases reuse it for Jak 1 ISO and Jak 2 CHD,
including the conversion-tool contrast. Actual upstream/game observations remain
in their existing qualification receipts. Comparative effort and speed baselines
remain unknown; per-title commands are eliminated for this repeated sequence.

`node scripts/qualification-report.mts --cli <executable> --library <library> --output <new-directory>`
captures existing versioned core snapshots and a checklist for active managed
installs and non-owning external registrations. Format 1 retains managed fields
and adds `runtime_kind`, a distinct `registration_id`, and available platform,
runtime/executable paths and immutable-tree identity. External `artifact_sha256`
is the registration's accepted archive identity, not a new download observation;
its immutable-tree hash is a separate fact. External platform comes from its
registration. Managed records lack artifact-platform identity, which remains
unknown; the capture host's platform stays in the doctor response separately.

Missing optional version, hash, platform, path or readiness facts remain null
(unknown), rather than borrowing current catalog or host facts for a retained
external record. Missing required port/record IDs, duplicate identities within a
route, conflicting managed/external records or a changed record owner refuse the
capture before report publication. Existing capture directories are preserved.
`installed_ports` still counts managed installs; `registered_ports` counts
external registrations and `reported_ports` counts both.

To project actual Core offers into the existing scenario report, run
`node scripts/desktop-verify.mts --list-scenarios --json --qualification-evidence <capture/evidence.json>`.
The rows retain Core's allowed, held or waiting assessment, execution platform,
exact available artifact/record identity, intended scenario producer and missing
observations. A managed record's unknown installed platform stays unknown.
Scenario `operation_routes` describe test coverage; they do not decide which
operations Core offers.

Repeat `--current-preflight <preflight.json>` for each operation/observation scope and
`--acceptance-packet <completed.json>`
to inspect receipts against the requested frozen dependencies. The owning acceptance
verifier rechecks the completed packet and its retained artifacts. Scope lives in
the existing binding's `execution_qualification.initial_state.offered_operation`:
`port_id`, `operation`, `runtime_kind`, `record_id`, `availability`, `reason`,
`platform`, `package_sha256`, `producer` and `evidence_kind`; an external record
also binds `package_platform`. Runtime conditions must declare the same platform
and observation kind. Kinds are `browser-fixture`, `native-harness-contract` and
`real-installed-execution`. A receipt with missing scope or incompatible inputs
cannot fill a missing observation. Retained execution `captured_at` orders observations, independently of packet completion.
Missing observation times remain explicitly unordered. Current required gaps or failed
source reviews block completeness while historical observations remain visible.
Prerequisites remain descriptive metadata; required gaps and actual source-review
fields provide the defined disposition checks. Empty
or truncated inventories never imply complete native coverage. The latest compatible failure remains visible;
an adjacent green fixture or harness result cannot replace it. This read-only
projection grants no acceptance and inventories only the supplied receipts.

The capture keeps the selected CLI's original path so sibling tool discovery
retains its normal behavior. It records the initial SHA-256 and checks that the
path remains a regular file with those bytes before and after every command,
including failed commands and managed backup listings. Changed bytes, a missing
path or a nonregular replacement refuses publication. If a command also
fails, both errors are retained, with the command failure first. These checks
detect observed drift; they do not make execution atomic or immutable, or prove
that an adversarial change and restoration did not occur between observations.

Backup listings and the backup/restore checklist apply only to managed installs.
External rows do not establish save locations or Portcove ownership; their
`user_data_root` remains unknown. For both runtime routes, `source_profile` stays
unknown because the captured runtime record does not bind a source profile.
The additive `catalog_source_profile` records the current catalog declaration,
or null for an absent/unspecified entry; it is not evidence of the source used by
the retained runtime. Exact source facts, when available, stay in the captured
core source responses without an inferred runtime association. Gameplay,
audio, controller and save/load observations start null (unassessed), regardless
of readiness or historical qualification. Record exact operation, method, scope,
date and actual result separately. Neither capture nor synthetic CLI responses
grant runtime/gameplay qualification or modify catalog evidence.

Legacy Project `Port stage = Supported` means that at least one declared
platform is present in both historical arrays. That historical claim is limited
to the port/platform intersection and does not become an unconditional claim
about every current source representation or artifact. Catalog support tier, upstream
release channel, upstream status, catalog admission, source-contract coverage,
Project Status, and Port stage are independent. In particular, a stable support
tier, successful download, or catalog entry does not itself mean Supported.

On 2026-09-04, the repository owner reported completing the defined hands-on
Windows checks for every catalog port whose Windows automation was complete and
whose only remaining gate was manual qualification. Those entries therefore
pair their Windows automation evidence with Windows manual validation. Catalog
entries with source, release, upstream, or native-platform blockers remain
unqualified. This attestation does not imply qualification for any other
declared platform.

Yu-Gi-Oh! Forbidden Memories v0.6.1 has exact Windows structural and bounded
automated lifecycle records for its Track 01 contract, checksum-qualified
artifact, clean managed build, immutable verification, responsive native
launches, persistence, backup restore, removal, and clean reinstall. A separate
current-client exercise covers exact v0.5.7-to-v0.6.1 update, retained-version
rollback/reactivation, immutable verification, and bounded canonical
persistence and backup preservation. It does not establish native v0.5.7
launch, cross-version runtime collection or restore, hands-on gameplay,
controls, audio, in-game save/load, or non-Windows platforms. The exact scope
and interrupted-launch limitation are recorded in the
[cross-version qualification record](qualification/yu-gi-oh-forbidden-memories-recompiled-windows-cross-version-2026-09-15.md).
Revelations: Persona
v0.1.1 has exact Windows structural and bounded automated lifecycle records for
its owned-input artifact and Track 01 contract, including v0.1.0 installation,
v0.1.1 update, no-op, rollback/reactivation, fail-closed verification, repaired
native launches, persistence, and backup restore. A separate current-client
exercise covers managed removal, preservation of canonical configuration, a
genuinely clean v0.1.1 reinstall, regenerated runtime configuration,
byte-identical restoration, final immutable verification, and a healthy backup.
It does not claim Play/game-intro execution, hands-on gameplay, controls, audio,
in-game save/load, or non-Windows platforms. The exact scope is recorded in the
[clean-reinstall qualification record](qualification/revelations-persona-recompiled-windows-reinstall-2026-09-15.md).
For both ports, `input.ini` is persistent user configuration and
`psx_last_run_report.json` is reviewed disposable runtime output.

Dr. Mario 64 Recompiled Plus 1.0.0 preserves the existing
`dr-mario-64-recomp` catalog identity while replacing the inactive predecessor
repository with its traceable successor. Its exact Windows structural and
bounded automated lifecycle records cover the checksum-qualified USA Rev 0
source, release artifact, wrapper runtime directory, immutable verification,
three responsive D3D12 launches with normal close, no-op update, safe refusal
of rollback without a retained version, removal preservation, and clean
reinstall. Its persistent runtime ROM is SHA-256-bound on every reuse, so a
restored or edited destination is rematerialized from the admitted source
before launch. The port remains beta: the same current AMD host failed under
Auto and explicit Vulkan inside `amdxc64.dll`, and the evidence does not claim
hands-on gameplay, controls, audio, in-game save/load, backup restore,
cross-version update/rollback, or non-Windows behavior. The exact identities,
methods, and remaining boundaries are recorded in
[`docs/qualification/dr-mario-64-recompiled-windows-2026-09-15.md`](qualification/dr-mario-64-recompiled-windows-2026-09-15.md).

The optional `n64_windows_initial_d3d12` declaration seeds only
`{"api_option":"D3D12"}` in a fresh Windows N64 portable working directory.
Both `graphics.json` and `graphics.json.bak` must be declared persistent at that
runtime coordinate. Core initializes `graphics.json` only when both are absent, after
source preparation and persistent restoration, using synchronized no-replace
publication. Existing regular settings, malformed bytes and backup-only recovery
remain untouched; symlinks, nonregular files and unreadable metadata are refused.
Initialization is not a repair of an existing configuration or a qualification
claim for its selected renderer. Dr. Mario's catalog summary retains the specific
AMD RX 9070 XT / driver 32.0.31041.1004 Auto/Vulkan failure and D3D12 remedy.
Other Windows hardware and newly created settings require their own applicable
evidence. Retained installation contracts preserve their original declaration;
indexed definitions require the N64 version 2 capability for this behavior.

The optional `n64_runtime_at_executable_parent` contract keeps a reviewed ready
N64 runtime and its declared data beside the selected executable when an archive
wrapper changes between releases. It requires a managed portable archive,
`portable_marker`, an admitted source with persistent N64 big-endian materialization,
and no conflicting runtime root, external data environment or generated build.
Review the actual package and component grants before enabling acquisition.
Do not add this flag to an existing installation to migrate its data coordinates.

This opt-in uses the existing staged lifecycle and conservative data-restore
receipt. Declared data is collected before first Play, backup, replacement,
rollback and removal. Without a matching restore receipt, conflicting runtime and
canonical copies are preserved for explicit resolution. Full immutable verification
holds modified runtime files and undeclared additions; current data crosses only
compatible retained coordinates. Runtime rollback does not rewind saves.
N64 engine capability 4 and retained-contract format 8 fence these semantics from
older readers; omitted/false retains historical N64 coordinates and behavior.
The contract itself supplies no platform, native, original-file or gameplay
qualification, and does not grant ownership of external copies.

Duke Nukem: Zero Hour Recompiled 0.0.3 has exact Windows structural and
bounded automated lifecycle records for the checksum-qualified USA source and
GitLab artifact. They cover mismatch refusal, archive-member normalization,
dynamic release resolution, installation, 47-file immutable verification,
responsive native launcher starts and normal close, backup and fail-closed
restore authorization, reviewed restore, adoption, update, rollback, retained
release reuse, managed removal, clean reinstall, and byte-identical persistent
state restoration. The stable GitLab definition has no release-version field,
so a future ordinary compatible release can be discovered without editing the
definition; its new artifact does not inherit 0.0.3's qualification record.
The port remains beta and the evidence does not claim gameplay, controls,
audio, in-game save/load, non-Windows support, signing, or publication. Exact
identities, methods, and boundaries are recorded in the
[Windows qualification record](qualification/duke-nukem-zero-hour-windows-2026-09-16.md).

Ape Escape Recompiled v0.3.0 has exact Windows structural and bounded
automated lifecycle records for the normalized USA Rev 0 `SCUS-94423` source
and GitHub artifact. They cover valid-CHD mismatch refusal, dynamic release
resolution, installation, 287-file immutable verification after responsive
native launches, bounded dynamic freeze diagnostics, persistent-only backup
and guarded restore, adoption, update, rollback, retained release reuse,
managed removal, clean reinstall, and byte-identical persistent-state
restoration. Generated `disc/`, JIT `cache/`, overlay captures, heartbeat, run
report, and `psx_freeze_dump_psx-runtime_*.json` files remain disposable and
outside backups. The definition has no release-version field, and any future
artifact or source identity requires its own qualification. The port remains
beta; gameplay, dual-analog controls, audio, in-game save/load, Linux, signing,
and publication are unclaimed. Exact identities and boundaries are recorded in
the [Windows qualification record](qualification/ape-escape-recompiled-windows-2026-09-16.md).

Mega Man X5 Recompiled v0.1.0-alpha has exact Windows structural and bounded
automated lifecycle records for the normalized USA Original `SLUS-01334`
source and GitHub artifact. They cover valid-CHD mismatch refusal, dynamic
release resolution, installation, 287-file immutable verification after a
responsive native launch, bounded dynamic freeze diagnostics, persistent-only
backup and guarded restore, adoption, update, rollback, retained release reuse,
managed removal, clean reinstall, and byte-identical persistent-state
restoration. Generated `disc/`, JIT `cache/`, overlay captures, heartbeat, run
report, and `psx_freeze_dump_psx-runtime_*.json` files remain disposable and
outside backups. The definition has no release-version field, and any future
artifact or source identity requires its own qualification. The port remains
beta; gameplay, controls, audio, in-game save/load, Linux, signing, and
publication are unclaimed. Exact identities and boundaries are recorded in the
[Windows qualification record](qualification/mega-man-x5-recompiled-windows-2026-09-16.md).

## Adding or changing a port

Managed PS1 generation and rebuild use the owned pinned toolchain, whose critical
file identities are rechecked before each builder process. Both prohibit the kit's
toolchain download fallback. Builder PATH contains only the owned toolchain and
bundled Python directories; profile, cache and temporary paths are private to the
preparation workspace. Missing or changed declared tools refuse before the builder
starts. Kits must support the generation no-download argument; incompatible CLI
contracts refuse rather than retrying with weaker arguments. This is builder
acquisition/environment policy, not title-native qualification or a general OS
sandbox. Retained workspaces and existing cancellation/closure guards still apply.

Managed PS1 ports pass their reviewed runtime configuration with `--game` and
an explicit `--memcard-dir` inside the managed runtime's `saves` directory.
This applies both to referenced discs and to materialized raw disc sets. It
keeps upstream defaults from moving player data into a Documents directory
outside Portcove's backup, update and rollback ownership. For example,
[Yu-Gi-Oh! v0.5.7's runtime](https://github.com/Unchiga/psxrecomp/blob/f003d3b9d76e8e54cb1e94957162c4e7de467f45/runtime/src/main.cpp)
honors this explicit directory for memory cards, settings and mod data.
Windows launch arguments use ordinary path spelling only when resolving the
existing ancestors proves it identifies the same location as the extended path.
Yu-Gi-Oh! additionally declares `PSX_PORTABLE=1`, because its launcher caches
use a separate upstream data-directory resolver. Its source and BIOS selection
files (`disc.cfg`, `bios.cfg`) are persistent preferences; the checked-disc
cache (`disc_verified.cfg`) and exact
[`diagnostics/psx_freeze_heartbeat.json`](https://github.com/Unchiga/psxrecomp/blob/f003d3b9d76e8e54cb1e94957162c4e7de467f45/runtime/src/freeze_heartbeat.c)
are reproducible runtime outputs. Other files in `diagnostics` remain verified.
New named persistent-path declarations also permit newly created preference
files in existing installations. Verification still checks every file recorded
as immutable in the original manifest; a later declaration cannot hide changes
to those bytes or rewrite that recorded identity during library import.
For an installed version with a retained definition, runtime verification may
recognize new exact persistent and runtime-mutable paths only when the current
port definition otherwise matches that retained definition and keeps all old
mutable paths. Recorded immutable members and executable companions cannot gain
mutability. This verification allowance does not prove that player data was
restored under a wider scope. Receipt-governed installations refuse collection or
restoration when historical scope evidence is absent or interpreted persistence
paths/patterns differ from their retained scope; the same persistence-authority
preflight covers inactive versions in read-only Restore review and again before
canonical publication. Actual restore also checks mod conflicts at its existing
mutation boundary.
The original receipt, manifest and diagnostic-mutability
behavior remain unchanged. Other existing integration interpretations, including
the separately qualified Shipwright exception, retain their own boundaries.

A ready staged archive may move forward to a fresh, strictly larger persistence
contract only when the old authenticated contract and its current data
interpretation agree, all source/launch coordinates and patterns remain compatible,
and every added path is absent from the active runtime, canonical data and actual
destination. Missing immutable package files do not make their names adoptable;
links, case aliases, overlapping paths and uncertain inspection refuse. Recheck
under the port lock after preparation, synchronization and before activation or
pending recovery. The new installation retains its full new scope; old copies keep
their original scope. Shrinking a contract, populated additions and unproven scope
expansion remain refused. Runtime rollback still carries current data and does not
rewind saves.

If fresh acquisition publishes a staged copy before its final data-compatibility
check refuses, the error includes `staged_install_id`: that copy and its files stay
registered, the active copy stays active, and activation and stage-only retries
repeat the actual-destination check. This is an ordinary retained staged copy,
not a new durable held-status type. Whole-library export/import continue using
historical retained authority, with no current-catalog-only ownership grant.

Managed PS1 launches regenerate `.portcove-psx-runtime.toml` from the verified
`game.toml` template and current verified disc paths for both source modes.
Upstream launcher writes therefore affect a disposable copy; the template and
source identities remain checked. An edited generated copy is replaced before
it can become the next launch's source authority. This also accommodates
[Persona v0.1.1's controller-preference write](https://github.com/mstan/psxrecomp/blob/c0139b4538723ef1d297257f101db2958b8b39f3/runtime/src/main.cpp).
Persona declares its exact `keybinds.ini`, `disc.cfg` and `bios.cfg` preferences
as persistent, and `psx_freeze_heartbeat.json` as a disposable runtime output.
Its older runtime keeps those launcher files beside the executable without a
portable-mode environment override. Installations whose old manifests already
recorded keyboard preferences as immutable need a clean reinstall before those
bytes can be edited; an already modified immutable template also requires a
clean reinstall. Current declarations never authorize silently accepting those
changes to an existing manifest.

Use `runtime_mutable_file_patterns` only for reviewed disposable files whose
names vary inside the catalog-owned runtime working directory. Each rule has a
literal nonempty `prefix` and `suffix`; it is anchored to one filename, requires
at least one character between them, and never recurses or behaves as a general
glob. Matching files are omitted from immutable verification but are not
enumerated, backed up or restored. By contrast, `persistent_file_patterns` uses
the same bounded syntax for player-owned files that must participate in those
persistence operations, while `runtime_mutable_paths` remains the exact-path
form for disposable runtime output. Catalog validation rejects overlapping or
duplicate rules and conflicts with executable, source, metadata, exact-runtime
or persistent declarations. This contract cannot claim files in roaming AppData
or another external user-profile directory; such state needs an upstream
redirect or a separately reviewed ownership capability.

`windows_runtime_path_policy: "printable-ascii-max-path"` declares a verified
upstream limitation for a Windows-only managed staged-source runtime. Core rejects
known unsuitable output roots before acquisition, and checks the selected executable
and its probe filename budget during readiness and again before preparation. The
requirement is retained with the installation and survives an output-folder move;
it grants no relocation or adoption permission. Source files may remain in their
original Unicode locations when the adapter passes a checked relative runtime copy.
This policy currently excludes external runtimes, setup executables and managed
build recipes. Independent definition entries must require staged-source template
version11. Absent policy retains the prior route contract; this is not a blanket
ASCII restriction or a claim that every other runtime supports Unicode paths.

Ghostship 3.0.0 writes its disposable extraction cache to `torch.hash.yml` and
rotates `logs/Ghostship.log` through `logs/Ghostship.10.log`. The catalog declares
those exact runtime outputs through the existing nonpersistent runtime-path
contract, now available to the libultraship portable adapter. Source, executable,
Portcove metadata and persistent-path overlap checks still apply. Other files in
`logs` remain subject to immutable
verification. Generated `sm64.o2r`, configuration, saves, screenshots and mods keep
their existing persistent ownership. This declaration does not grant gameplay
or platform qualification. The paths come from the tagged
[Ghostship engine](https://github.com/HarbourMasters/Ghostship/blob/deb091c29caff57dd986398087b058f16b11911e/src/port/Engine.cpp),
its pinned [logger](https://github.com/Kenix3/libultraship/blob/6b861a64d29d9fe95d100be228eb6d190231cc0d/src/ship/log/Logger.cpp),
and [Torch cache writer](https://github.com/HarbourMasters/Torch/blob/106621f0f0f9731b8739bec95227c2c5887492df/src/Companion.cpp).

2Ship2Harkinian 5.0.1 writes `imgui.ini` and `logs/2 Ship 2 Harkinian.log`
beside its Windows executable during a native session. The former is a player
preference; the latter is disposable diagnostic output. The pinned engine's
[rotating logger](https://github.com/Kenix3/libultraship/blob/7cb10226e7875ec48ceec2f841d00afd84eef964/src/ship/Context.cpp)
can also write ten numbered versions of that log. The optional
[time-splits save action](https://github.com/2ship2harkinian/2ship2harkinian/blob/8a24047fbce8915993804e7819f4df4fa591551f/mm/2s2h/Enhancements/Trackers/TimeSplits/TimeSplitsActions.cpp)
writes `2S2HTimeSplitData.json` in the same directory. The catalog owns the two
configuration files as persistent and the eleven exact log names as disposable
runtime output, matching the selected upstream
[generated-file exclusions](https://github.com/2ship2harkinian/2ship2harkinian/blob/8a24047fbce8915993804e7819f4df4fa591551f/.gitignore).
This qualifies new installs against those bounded files while retaining
immutable checks for recorded files, other log files and launch-sensitive
companions.
An installation created under the earlier catalog retains its original
definition and can still fail pre-launch integrity after these files appear;
the new catalog does not silently rewrite its admitted manifest. Preserve that
install and its data until a reviewed recovery or clean reinstall is completed.

The procedure below describes the current repository workflow. The completed
[#245](https://github.com/boburning/portcove/issues/245) design is a foundation;
future protected publication remains owned by
[#246](https://github.com/boburning/portcove/issues/246). This contract does not
activate a publisher.

1. Capture or update the roadmap item and direct upstream evidence.
2. Search the per-ID authored records and Core adapters before adding behavior.
3. Prepare the listing and optional existing integration with the command below.
   Add the smallest safe shared capability only when the offered route needs it.
4. Run catalog and source/profile validation, release-resolution checks where
   acquisition is offered, and the lifecycle and platform checks for operations
   actually promised.
5. Record only the qualification evidence that actually passed.
6. Link the pull request to its issue and update Project status.

Catalog changes must preserve source identity, checksums, bounded archive
extraction, symlink refusal, persistent-data ownership, per-port locking,
atomic activation, rollback, credential boundaries, and executable trust. See
[ARCHITECTURE.md](ARCHITECTURE.md) and [PROJECT-GOVERNANCE.md](PROJECT-GOVERNANCE.md).

The embedded catalog uses schema 2. It contains reusable identities, logical
variants, tagged physical representations, explicitly scoped conjunctive digest
records, per-port game and BIOS contracts, validators, exact qualification facts,
and immutable evidence
references. Maintainers edit one record in
`crates/portcove-core/catalog/ports/<stable-id>.json`. Its format-1 `listing` owns
the stable ID, name, summary, public project URL and optional original title,
issue reference, release/setup links, setup guidance and artwork. An optional
`integration` owns the existing strict operational fields. Common identity and
presentation facts must not be repeated in that object. Integrated platform
facts remain in `integration`; the listing projection derives them. A listing
without an integration carries no managed operation or qualification claim.
Shared source identities, contracts, validators, evidence and qualification stay
in `catalog-shared.json`, preserving their existing order and scope.

`node scripts/generate-catalog.mts` deterministically assembles these sources into
`catalog-current-authoring.json`, the embedded `catalog.json`, and `listings.json`.
All three are generated outputs, and `--check` refuses a stale projection.
Filename/ID disagreement, duplicate IDs or JSON keys and a second shared port authority are
refused. The migrated records retain their established order; new records sort
by stable ID. Unknown retained operational metadata and ordered arrays remain
unchanged. Reassemble after a rebase; do not hand-merge the generated aggregates.
Core owns the temporary
schema-1 compatibility projection required by the existing matcher and rejects
any conflicting projection supplied by catalog input. The deterministic
historical migration is no longer a current authoring path. It reads the frozen
`catalog-schema1-fixture.json` and checks only the frozen
`catalog-schema2-migration-fixture.json`; current ports, evidence, and
qualification records must not be added to that migration.

Use one thin preparation entry point for a new or updated record:

Shared upstream families retain complete independent per-ID records. The existing
authoring tests compare Raze's shared package/platform/profile/update facts and
Namco's common upstream/platform links. Original-file requirements, canonical
issues, identities and independently reviewed acquisition restrictions stay local
to each record. These checks add no runtime inheritance or shared policy registry.

```text
node scripts/prepare-port.mts --issue 156 --output-dir /path/to/preparation
node scripts/prepare-port.mts --project https://github.com/owner/project --id stable-id --name "Project name" --output-dir /path/to/preparation
node scripts/prepare-port.mts --record /path/to/stable-id.json --route download --release-tag v1.2 --validator-cli TRUSTED_PORTCOVE_CLI --output-dir /path/to/preparation
```

The command accepts a canonical Portcove issue number/URL, a direct public
project URL or a reviewed authored record. It refuses conflicting stable IDs or
unreviewed origin changes and asks for a stable ID when a shared upstream is ambiguous.
A reviewed `--record` can append the lineage transition described below. Supply a
non-GitHub project's reviewed `--id`, `--name` and optional `--summary`; no generic
web scrape is required. A listing needs identity and origin, not a save audit,
release history, README or resolved tag. GitHub listing collection reads repository
metadata only. `--route download` collects one 20-release candidate window or the
explicit `--release-tag` and at most two 100-asset pages. Truncated or unavailable
assets remain Unknown. Metadata never supplies package authenticity or executable
acceptance.

When a record names a canonical issue, `canonical_preparation` points to its exact
retained specification in `files.upstream`, with the observed timestamp and UTF-8
body SHA-256, or explicitly says that it was not observed. Read the complete
specification and relevant Roadmap context before deciding route, lineage,
acquisition conditions or deferrals. `--issue` uses the existing bounded issue
read; record/project preparation does not gain a new request or approval gate.
This feedback does not infer permission, a hold, support or ownership from prose.
An already published package and technical fit do not resolve an existing named
condition. Carry a reviewed operation condition through the existing
`download_block_reason` contract where applicable.

For a proposed `native-portable` record, the completion receipt also shows literal
package-hint matches among the supported ZIP/tar.gz/tgz archives for each declared platform, whether each matching asset has
a published SHA-256, and whether the selected release's asset enumeration is
complete. Resolve missing or ambiguous matches before acquisition review. This is
authoring feedback, not a second package selector or a capability certificate.
Review the executable headers and launch folder, then the runtime's actual writes
and update behavior. Include compatible original inputs, generated data, mods,
settings and relevant logs in the declared preservation contract. An empty
contract is useful when evidence establishes external storage; describe that
location and its backup limits, and classify the main saves/settings as
`external-user-owned`. Inspect emitted writes beyond the save folder, including
first-run failure instructions, preference exports, registry settings and mod
state. A self-updater or a setup kit that regenerates
version-dependent runtime code needs the appropriate existing integration or
non-owning handoff. Keep the player's installed contract unchanged when adding a
new route.

The owned output directory is a resumable preparation checkpoint. Reuse it for
several IDs sharing a repository to reuse endpoint observations. Collection is
bounded to 12 HTTP requests including redirects, 8 MiB and two minutes per call.
For a listing-only download, a reviewed `release_url` may identify a related
upstream setup launcher while `project_url`, stable ID and canonical issue keep
the game identity. Preparation records that public release repository separately
and verifies release/asset provenance within the same budget and cache. The URL's
tag path does not pin a version; `--release-tag` selects the exact observation.
Managed package feedback uses the operational release specification instead of
an optional listing helper. A provider outside the bounded GitHub collector
remains explicitly unobserved; it never falls back to a different repository.
Repository observations expire after 24 hours; issue/release/asset observations
after one hour. Failed refreshes retain prior observations separately and do not
report them as current; provider backoff survives resume. Malformed checkpoints
are preserved and refused. A lock refuses concurrent writers to the same
checkpoint. Interrupted locks require verifying the prior preparer has stopped
before removing only that checkpoint's `active.lock` directory.

Artwork preparation runs automatically for the selected ID. Reviewed
`listing.original_game_title` supplies a name-only underlying-game declaration
with the listing's project URL as evidence. Optional `--identities` overrides that
default; no IGDB game, slug or platform IDs are guessed. `--credentials-file` and
the established maintainer configuration supply provider credentials. Missing
credentials, ambiguity or provider failure produce an independently retryable
generated fallback. Unchanged accepted mappings remain reusable before lookup.
Successful artwork receipts are reused only for the same input and accepted
baseline. Operational changes require `--validator-cli`; captured Core
`inspect-proposal` checks their exact assembled bytes. Whenever that CLI is
supplied, `catalog inspect-listings --path` also validates the generated listing
document, and its returned document must match the exact input semantics.
Successful receipts bind input bytes and validator identity and survive resume.
Without a CLI, listing-only preparation reports Core inspection as pending.
Ordinary CI remains the final catalog/listing validation boundary.

The concise completion receipt links proposed per-ID files, full generated
projections, upstream facts, cover outcomes, Core checks and independent
compatibility review. `preparation_costs` records monotonic elapsed time and its
boundary, including provider/subprocess waiting and excluding final completion
writing. This measures preparation, not authoring effort, gameplay or delivery.
Files are content addressed; unchanged reruns do not create
duplicate authored records or alter accepted sources. Copy reviewed proposed
records into `catalog/ports`, regenerate, and complete normal review and delivery.
Preparation does not download or run packages, post issue comments, install an
unsigned catalog, publish a feed or establish actual user delivery. A malformed
candidate does not replace previously prepared records. Keep discovery listing,
accepted executable behavior and published client/catalog delivery separate.

Current embedded ports include an additive `presentation` object for installation
method, required game/BIOS labels, verification method, and saves/settings
behavior. The authored integration records these facts beside the
same adapter and source-contract authority, and core rejects labels or verification methods
that disagree with those bindings. Existing platform, channel, support,
upstream-state, and qualification fields remain the structured authority for
those facts. Older catalogs may omit presentation and remain readable; clients
must report the missing detail instead of inferring it from an adapter ID.
`original_game_title` and optional `variant_label` are reviewed descriptive
presentation metadata. They do not change the project `name`, port/source IDs,
release selection, support or qualification, and never group implementations.
Current entries provide a recognizable game title; retained and older definitions
may omit it and display their project name instead. A variant may describe an
edition, prototype or original-platform distinction, without widening the source
contract. Empty, padded or control-bearing display text is rejected.
Signed format 1 may update presentation without changing its frozen execution,
source, persistence, or installed-code contracts.
Summaries remain one outcome sentence and do not duplicate channel, platform,
verification, setup, or storage claims.

`catalog-schema1-fixture.json` preserves the full pre-migration document and
`catalog-schema2-migration-fixture.json` preserves its reviewed historical output, while
`catalog-schema1-admission-baseline.json` fingerprints every source profile and
the complete port/profile/adapter binding set. Tests compare every projected
profile and port definition to that frozen input. The reviewed
Bomberman Party Edition correction records raw MODE2/2352 and cooked ISO as two
physical alternatives using the upstream contract at commit
`0aef0b66186b3f8f29d1bd9a3ba15b6307739c7b`; the compatibility projection keeps
the old matcher boundary unchanged until the shared schema-2 inspector lands.

The same migration records the reviewed versioned N64 contracts without
broadening that temporary matcher: Ghostship 2.0.0 (US and Japanese), Lighthouse
1.1.0 (US revisions 0 and 1, PAL, and Japanese), Ship of Harkinian 9.2.3,
2Ship2Harkinian 5.0.1, Zelda 64: Recompiled 1.2.2, Starship 2.0.0's selected US
revisions, and Banjo: Recompiled 1.0.2. Each contract points to its immutable
upstream commit and selects variants from the shared game identity. Transitional
`legacy_projection_only` variants preserve schema-1 matching and cannot be
selected by a schema-2 contract.

The core source inspector matches ordinary-file and cartridge-ZIP observations
against schema 2. It records original-container, original-file or archive-member,
normalized-content, and canonical N64 big-endian digests separately. Every
digest present in one identity must match; representations remain alternatives,
and multiple matching representations are an ambiguity rather than an automatic
choice. Extension-only compatibility can pass existing structural admission but
is never reported by discovery as an exact identity.

An admitted cartridge archive member may be copied unchanged to a different fixed
runtime filename, such as `game.md` inside a ZIP becoming `game.bin`. The source
representation must explicitly admit that member extension; the runtime filename
does not broaden source admission. Preparation binds both the outer ZIP identity
and the checked member's name, size and SHA-256, and freshly verifies cached
runtime bytes. This is exact byte copying, not interleaving or header conversion.
Registrations without structured member observations retain legacy selection
until checked again. The bounded ZIP32 source-reader limits and unsupported
container recovery are documented in the architecture contract.

For an `archive-member` representation, `extensions` is matched against the
decompressed original's extension, just like `member_extensions`; the reader
recognizes the ZIP container separately. For example, an unchanged Genesis
original stored as `.bin` or `.md` uses those extensions in both lists and
`archive-member` digest scope. Putting `zip` in `extensions` does not admit a
`.md` member. The outer ZIP hash is a container observation, never the expected
original-byte identity.

File-set representations match only when every declared member has exactly one
top-level filename match and one conjunctive digest identity. Directory
symlinks and nested or traversal-shaped ZIP entries cannot satisfy a member.
Observed member facts remain available separately from the aggregate identity.

## Admission decisions and protected publication target

Operation eligibility is independent of publisher/source trust, artifact
integrity, game-file compatibility, and evidence/health. Release channels and
Project stages are separate. Untested entries may remain useful catalog entries
when their actually offered operation prerequisites pass.
Missing/stale gameplay reports change the evidence display, not automatically
installation or update eligibility. A known relevant failure holds only the
affected operation/artifact/platform/variant. A schema pass is not an install
test, and source-file correctness is not gameplay certification.

The following table is the approved target for #246 and related publisher
work, not behavior shipped by the current manual catalog workflow. The
current core evaluator applies the operation-specific rules above; automatic
candidate acceptance and publication still require their protected pipeline.
Under that future pipeline, reusable capabilities, templates and narrowly
scoped publisher authorities are reviewed once; deterministic checks decide
routine candidates within them.

| Candidate                                                                                  | Planned result                                                                                     |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Accepted upstream, ordinary new artifact, supported contract and required checks pass      | Automatically available; verify its new digest. Existing selectors need no needless definition PR. |
| New definition or path/metadata correction inside accepted capabilities and authority      | Automatically admit with honest evidence, including zero gameplay reports.                         |
| Established asset identity unexpectedly changes bytes                                      | Hold replacement, retain pinned identity and deduplicate the exception.                            |
| New authority, ambiguous identity, new capability, widened access or unsupported migration | Scoped trust/engineering review; retain usable versions.                                           |
| Missing optional input or gameplay                                                         | Not run/Unknown, not a blanket block or a fabricated pass.                                         |
| Integrity, archive, source, executable or mandatory operation failure                      | Reject/hold the affected operation; untested cannot bypass it.                                     |
| Unsupported client capability or failing platform                                          | Isolate the affected definition/platform, retaining compatible entries.                            |

Source hashes, variants and relative paths may be accepted data inside a bounded
schema. Ownership reinterpretation needs explicit migration/consent semantics;
safe reusable migration templates can later be policy-authorized. Publisher
onboarding specifies actual repository/artifact authority and reauthorization
conditions, not a broad domain popularity rule. The authorized
[#315](https://github.com/boburning/portcove/issues/315) policy allows an
independently reviewed catalog-curated exact hash for an attributable release.
That authority is not yet implemented: hosted providers still require their
current published digest or checksum sidecar, and an arbitrary same-download
hash is never a substitute.

Local/community definitions use the same validator, explicit namespaced origin,
conflict handling and scoped trust. Partial management may permit install/launch
while saves or updates are unavailable. Unknown persistence cannot authorize
destructive replacement, cleanup, broad backups or false recovery claims. This
future behavior is owned by [#268](https://github.com/boburning/portcove/issues/268).

Evidence collection distinguishes reusable adapter fixtures, actual artifact
lifecycle checks and voluntary attributed observations. Invalidate only facts
whose relevant inputs change; preserve historical and legacy evidence honestly.
Opt-in reports must exclude game data, secrets and personal paths; untrusted
reports cannot revoke the whole catalog. Ordinary success needs no owner action;
exceptions have bounded retries, scope and a reproducible resume condition.

## Upstream lineage and alternative implementations

The stable port ID and canonical port issue identify the Portcove integration.
Its upstream lineage records who continues that implementation. An accepted
release identifies exact repository/release/asset/platform/size/digest facts;
acquisition locations describe where those accepted bytes may be obtained under
their own authority. A location change does not replace any of these identities.

| Relationship | Meaning and catalog treatment                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relocation   | The same project moves location, including to another host. Retain the port ID and canonical issue after reviewed continuity. A different known repository ID on the same host is not a same-repository relocation. |
| Successor    | A continued implementation with attributable continuity, potentially under different maintainers or repository identity. Retain the port and issue only after independent review accepts that exact relationship.   |
| Fork         | A derived implementation with independent continuing identity. Give it a distinct port record and canonical issue; retain the original.                                                                             |
| Alternative  | A separately selectable implementation of the same game or target. Give it a distinct port and issue; a recommendation does not merge identities.                                                                   |
| Independent  | A separate product or game/target, even if it shares a repository or some code. Keep its distinct port and issue.                                                                                                   |

Assess sufficient attributable continuity for the concrete proposal. Record the
supporting facts, contextual facts, contradictory evidence, rationale and exact
reconsideration condition. A name, redirect, shared commit, copied credits or
popularity alone is insufficient. There is no mandatory announcement format,
universal evidence checklist or numerical trust score. Unresolved contradictions
prevent acceptance; insufficient evidence remains `unresolved`, and evidence
against the proposed relationship can produce `rejected`. Neither changes the
current accepted upstream. Independent review may be an authorized separate
non-writing agent; this policy creates no universal human gate.

### One authoring representation and decision boundary

The optional `upstream_lineage` object lives on the existing per-port authored
record, beside `listing` and `integration`. `scripts/upstream-lineage.mts` is the
shared validator and assessor used by generation and preparation. It is not a
second project inventory and is excluded from every runtime/catalog/listing
projection, signed definition and installed contract.

Format 1 contains `target_key`, `origin` and ordered `decisions`. The stable
lowercase kebab-case target key identifies the underlying game/target; reuse the
same key for implementations of that target. An identity contains `project_url`
and, when actually observed, `repository: { host, id }` with the provider's stable
ID. Provider IDs are scoped to their host. Explicit GitHub identities name a
repository root without query or fragment; case, trailing slash and `.git`
spellings cannot create duplicate known aliases. Other hosts keep their own path
semantics, supporting cross-host migrations without assuming GitHub identity.

Each decision records `from`, `to`, `relationship`, `outcome`, `rationale`,
`evidence` and `reconsider_when`. Evidence entries contain `kind` (`supporting`,
`context` or `contradiction`), an attributable HTTPS `reference` and a bounded
`note`. Accepted decisions require supporting evidence and a `review` containing
its reference and `decision_sha256`. `lineageDecisionDigest(record, lineage,
decision)` computes the canonical SHA-256 over all decision facts except
`review`, bound to the stable port, canonical issue and target. This detects stale
or copied declarations; it does not authenticate a reviewer. The referenced
evidence and independent PR review establish the actual decision, not a supplied
hash or evidence label.

Accepted relocation/succession advances the current upstream; all prior
identities remain in history. Accepted fork/alternative/independent decisions
instead require `related_port: { id, issue_number }`, matching a separate
catalog record and its known destination identity. They leave the original
current upstream intact. Generation rejects duplicate canonical issues and
duplicate known upstream implementations for one target, while allowing different
targets in one repository. Unknown historical IDs must not be invented.

Records without lineage remain `legacy-unassessed`; no mass migration or inferred
acceptance occurs. Their existing projection and runtime behavior stay intact.
For an ordinary update, start from the current authored record, append the exact
proposed decision, obtain independent review, bind its digest and reference, then
use `prepare-port.mts --record ...`. Preparation checks the previous record,
preserves known port/issue/target/origin and all earlier decisions, and reports
the assessment. A known provider ID conflicting with collected metadata refuses
the proposal even when its URL is unchanged. Unavailable provider metadata does
not become a verified identity. Failure retains accepted input files.

Reversal appends a new reviewed decision from the current identity to the retained
earlier identity. Never delete a failed or accepted event to make a transition
pass. Generation checks internal chain consistency; direct file edits and
historical imports additionally require Git diff review against the retained
record. A self-consistent edited chain alone cannot prove immutable history.

### Preservation and authority

Lineage acceptance does not accept a new release, authorize a mirror, clear an
operation hold, grant distribution, widen publisher authority or migrate saves.
Release selectors and acquisition declarations remain separately reviewed
operational fields. A source/tag match cannot substitute for an accepted
artifact's exact bytes. Historical qualification stays attached to its original
artifact, source, platform and environment; it does not transfer to a successor.

Existing installations, pins, retained versions and rollback keep their captured
definition, accepted release/source identity, execution and save/configuration
ownership. Core's retained-contract tests exercise catalog changes across legacy
and successor versions; lineage metadata does not enter that interpretation.
The authoring tests check identical complete runtime projections and preservation
of existing inputs through accepted, refused and reversed decisions. Signed
catalog format 1 retains its existing compatibility policy: it permits the
already supported release/project-location metadata updates while preserving
source, execution and persistence contracts. No new format or relaxed validator
is introduced here.

The [October 23 policy record](archive/2026-10-23-upstream-lineage-policy.md)
imports the independently delivered ReCut relocation and retains the initial
unresolved Star Fox event. The later
[Star Fox successor decision](archive/2026-10-23-star-fox-successor.md) accepts
attributable project continuity from newly reviewed maintainer statements and
corroborating history. It appends acceptance and updates the current project URL;
the historical release repository, accepted artifact and operational contracts
remain unchanged. The restored source tag does not recover the accepted ZIP, and
the newer Windows release's antivirus investigation remains unresolved. #139's
policy case stays complete; #2440 owns this finite transition. #251 consumes the
shared contract; #1306 owns preservation/failover, #315 release/distribution
authority, #246 protected delivery and #254 proposals.

## Read-only disappearance reporting

`scripts/check-catalog-repositories.mts` reports six separate facts for each
selected port: declared project/acquisition reachability, retained lineage,
exact accepted-artifact obtainability, preservation, applicable holds and
qualification. Its format-3 output records the catalog and policy hashes,
per-observation health contracts and observation interval. `collection_status`
states whether collection completed; condition `outcome`, classifications and
degradation state whether observed problems are accounted for. A completely
observed 404 or identity mismatch can remain actionable. Neither a complete
collection nor an accounted condition establishes installability.

DirectManifest entries retain their exact version/platform/digest/size and
acquisition URL. Declared project and acquisition roles are inventoried
separately, so a project URL change does not erase an older release repository.
Hosted endpoints use bounded metadata requests; direct artifact and other project
endpoints use credential-free HEAD without following redirects. Matching
Content-Length establishes endpoint reachability only. Accepted bytes remain
Unknown until their identity is verified. Missing, corrupt, inaccessible,
contradictory or partial inputs remain explicit.

Lineage fields retain the [shared authoring contract](#upstream-lineage-and-alternative-implementations)
facts available when the port is observed, including reviewed decisions and
history. Cached reports retain those observation-time facts; they are not a
continuously refreshed lineage service or new decisions. Preservation remains
owned by #1306 and artifact/operation holds by #315/#246. This collector modifies
none of those authorities. Catalog qualification stays attached to its exact
artifact/source/platform scope; legacy platform arrays are labeled historical.
Neither transfers to another release or location. Absent preservation or hold
evidence is Unknown, never permission or a clean hold status.
Validated authoring lineage participates in the port's freshness contract and PR
selection independently of the generated runtime catalog. A lineage-only decision
therefore requests a new observation instead of retaining a stale decision as fresh.

The retained Star Fox Enhanced incident in #247 (run 36735216087, job
109955016518, source `5d6905ea8bf90fb887bb49a6a8524ab2ecc5846b`) reported
`kandowontu/starfox-enhanced: github returned 404`. That remains historical
disappearance evidence. The later
[accepted successor decision](archive/2026-10-23-star-fox-successor.md) rests on
separate attributable continuity evidence and updates the current project URL.
The old release repository remains inventoried under its acquisition role, with
its exact known 404 accounted for and still visibly unknown. The successor does
not restore the historical release, recover accepted bytes, transfer qualification
or clear holds. A bare 404 neither establishes retirement/deletion nor selects
a successor; known endpoint failure and accepted project continuity can coexist.

Reviewed catalog maintenance declarations (`retired`, `superseded`, `abandoned`)
account for a 404 only at the port's declared project scope. They retain degraded
output and cannot suppress a missing artifact, new access/integrity failure,
repository-name reuse or an unclassified shared location. An archived flag or
bare 404 creates no such declaration.

The format-2 `.github/upstream-health-accounting.json` preserves the reviewed
monitoring dispositions and existing numeric release-pin identities. Versioned
artifact bindings cover only the relevant port/platform/provider and exact
URL/version/size/SHA-256; presentation edits and other platforms do not invalidate
them. Endpoint conditions bind an explicit project/acquisition role and its
relevant declaration, maintenance state, operation and HTTP rule. A reviewed 301
also binds its numeric redirect identity. These dispositions grant no lineage,
relocation, artifact, distribution or catalog mutation authority. Changed or
unclassified conditions remain actionable in the report.

Ordinary GitHub release-download 302 responses need no new exception record.
Three fixed API metadata reads can validate the catalog's exact repository/tag,
complete asset collection, URL/name/size and provider SHA-256 claim. A pin without
a reviewed numeric binding reports `provider-reported-pin-observed` and
`identity-unbound`. Existing reviewed repository/release/asset IDs and fact hashes
remain mandatory for their artifact scope, producing `provider-reported-pin-present`
only when they match; generic observations cannot replace those bindings. Both paths
retain the HEAD redirect as unknown, with destination availability unknown and
accepted bytes unverified. No redirect is followed or artifact downloaded or
executed. Reviewed immutable source archives have a separate bounded commit
metadata path with the same byte-verification boundary. See
[upstream observations](UPSTREAM-OBSERVATIONS.md#health-inputs-and-reviewed-accounting)
for the complete accounting contract.

Historical qualification identities are inventoried at their exact refs and
declared hosted locations, or the matching immutable DirectManifest pin.
Provider-reported digests remain metadata, never verified bytes. Empty,
conflicting, capped or partial asset collections stay Unknown. A historical
identity without a locatable declaration stays visibly unmonitored. Failed
qualification records are reported at their original scope without creating or
clearing a publisher hold.

Each condition has a deterministic key binding the port, location, operation,
rule and relevant observation contract. First-seen time and recurrence survive
unchanged repeats; material HTTP/identity/digest/size/classification changes and
fresh recovery are reported separately. Narrow contracts preserve comparison
across unrelated catalog edits. Prior numeric identity is a comparison baseline,
never ownership or continuity evidence. The standalone `--previous-report=PATH`
accepts bounded comparison evidence and writes no state or issue comments.

The workflow coordinator persists validated main-only observation history and
automatically drains checkpointed operations of at most 320 requests and 512 new
location assessments. Individually oversized collections continue by endpoint
without starving smaller scopes; compatible completed facts retain their original
24-hour clocks and do not consume another request or new-location slot.
Its report distinguishes this run's assessed ports from retained observations,
stale/unmonitored entries
and recent partial attempts, with a 24-hour freshness window and the complete
inventory denominator. PRs compare actual merge-target health inputs with the
merge result; presentation-only edits select no probes, while related semantic
changes select their owning ports. PRs can read history but cannot advance the
main checkpoint. Collection failures retain partial reports and failure history;
invalid coordinator inputs preserve the prior checkpoint and emit a failure
report. The diagnostic job is not a required merge check. Its collection exit
is distinct from the standalone checker's stricter condition outcome, and neither
changes required catalog validation, qualification or publication authority.

The exact ReGaiden v0.4.1 Windows prepared-runtime route uses this closed
shared-preference contract. Its [qualification report](qualification/slice6-regaiden-prepared-windows-2026-10-19.md)
records original/artifact identity, the preserved ImGui failure, corrected
consent and operation acceptance, and the separate delivery boundaries.
