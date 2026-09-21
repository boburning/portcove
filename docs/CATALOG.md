# Catalog policy

For managed setup, `setup_output_paths` declares safe relative generated files
or directories. They cannot overlap game/setup executables, persistent data,
disposable runtime state, the materialized source, or one another. The completion
marker must belong to a declared output path. Older definitions may omit
the field and remain readable, but cannot acquire the explicit preparation-plan
capability without a reviewed output contract. These paths add no manifest
exclusion or permission to trust newly hashed files.

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

`crates/portcove-core/catalog/catalog.json` is the machine-readable authority
for actual ports, platforms, upstream sources, release channels, adapters,
source contracts, and qualification evidence. The catalog grows continuously
and independently of Portcove's product release stages. Durable prose must not
copy its current count or maintain a second title list.

## Continuous admission

A candidate is eligible only when Portcove can represent it without weakening
the architecture or trust model. Admission requires:

- a direct and attributable upstream;
- a useful native release for each declared platform;
- immutable artifact identity through a published digest, verified checksum
  sidecar, or a narrowly reviewed retired-project manifest;
- an exact, lawful local-source contract when upstream code needs game data;
- deterministic executable, setup, persistence, and update boundaries;
- a reusable existing adapter or a justified family-level adapter owned by
  `portcove-core`; and
- honest automated and manual qualification fields.

Every declared platform must provide at least one executable hint. A hint is an
ASCII safe relative path under the declared runtime root; a basename remains a
legacy shorthand only when it identifies exactly one file. Ordered alternatives
do not make an ambiguous basename acceptable. Catalog validation rejects
missing platform entries, duplicate hints, traversal, cross-platform filename
aliases, and macOS bundle directories in place of the executable inside the
bundle.

Release asset hints identify a stable port, platform, architecture and package
shape. Do not include an ordinary release number merely because it was the
version used for qualification: hosted providers already select the current
eligible channel release and obtain that artifact's independently advertised
SHA-256. Intake must answer, with provider metadata or a controlled N/N+1 test,
“Will the next ordinary compatible upstream release work without editing this
definition?” When the answer is no, record the concrete selector, layout,
integrity, source, persistence or compatibility constraint and the condition
that would remove it. A deliberate `DirectManifest`, rolling tag, source/runtime
identity or exact qualification record is not an asset-selection pin and must
not be broadened to manufacture automatic updates.

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
resolution, including reuse of a five-minute in-memory release selection, and
reject resolution when the host reports the repository as archived. A
conditional `304 Not Modified` reuses only the last semantically valid metadata
body. If repository-state revalidation cannot reach the host, resolution fails
with that network error instead of treating the cached release as either
supported or withdrawn.

The hosting service's archive flag is not the same as Portcove's catalog
`Retired` status. A `Retired` entry cannot use a hosted provider; current
catalog validation permits it only through a manually reviewed
`DirectManifest` containing exactly one stable artifact for every declared
platform, each with an HTTPS URL, nonzero size, version, and SHA-256 digest.
`Superseded` and `Abandoned` entries are rejected. Active projects may also use
direct manifests when their immutable artifacts satisfy the same contract.

Future work to harden approval, withdrawal, cache, rollback, or signing
governance for retired-project manifests is tracked in
[issue #233](https://github.com/boburning/portcove/issues/233). That optional
work does not grant catalog eligibility and is not an Alpha 1 or V1
requirement. Current catalog admission and all ordinary source, archive,
executable, install, and rollback checks remain authoritative.

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

Stable, beta, and rolling are user-selected release channels, not qualification
claims. A catalog entry may be beta, rolling, platform-limited,
qualification-pending, or blocked while the application continues toward V1,
provided the UI and documentation represent that state honestly.

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

The procedure below describes the current repository workflow. Future automatic
admission is owned by [#245](https://github.com/boburning/portcove/issues/245)
and [#246](https://github.com/boburning/portcove/issues/246); this policy direction
does not remove current runtime checks or activate a publisher.

1. Capture or update the roadmap item and direct upstream evidence.
2. Search the catalog and core adapters before adding behavior.
3. Add declarative metadata and the narrowest reusable adapter contract.
4. Run catalog validation, release-resolution tests, source/profile tests,
   lifecycle tests, and the relevant platform checks.
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
references. Maintainers edit the complete schema-2 authority in
`catalog-current-authoring.json`; `scripts/generate-catalog.mjs` deterministically
generates the embedded `catalog.json`, and `--check` refuses stale output. Core owns the temporary
schema-1 compatibility projection required by the existing matcher and rejects
any conflicting projection supplied by catalog input. The deterministic
historical migration is no longer a current authoring path. It reads the frozen
`catalog-schema1-fixture.json` and checks only the frozen
`catalog-schema2-migration-fixture.json`; current ports, evidence, and
qualification records must not be added to that migration.

Current embedded ports include an additive `presentation` object for installation
method, required game/BIOS labels, verification method, and saves/settings
behavior. The current schema-2 authoring document records these facts beside the
same adapter and source-contract authority, and core rejects labels or verification methods
that disagree with those bindings. Existing platform, channel, support,
upstream-state, and qualification fields remain the structured authority for
those facts. Older catalogs may omit presentation and remain readable; clients
must report the missing detail instead of inferring it from an adapter ID.
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

File-set representations match only when every declared member has exactly one
top-level filename match and one conjunctive digest identity. Directory
symlinks and nested or traversal-shaped ZIP entries cannot satisfy a member.
Observed member facts remain available separately from the aggregate identity.

## Planned policy acceptance and evidence

Operation eligibility is independent of publisher/source trust, artifact
integrity, game-file compatibility, and evidence/health. Release channels and
Project stages are separate again. Policy-eligible untested entries remain
ordinary installable catalog entries when installation prerequisites pass.
Missing/stale gameplay reports change the evidence display, not automatically
installation or update eligibility. A known relevant failure holds only the
affected operation/artifact/platform/variant. A schema pass is not an install
test, and source-file correctness is not gameplay certification.

Reusable capabilities, templates and narrowly scoped publisher authorities are
reviewed once; deterministic checks decide routine candidates within them.

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
conditions, not a broad domain popularity rule. Missing published digests must
be inventoried by #245; a same-download hash does not replace today's required
independent integrity evidence. No integrity-policy change is implemented here.

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
