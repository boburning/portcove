# Catalog policy

## Managed ReGaiden shared preferences

The exact v0.4.1 Windows package has a closed consent-bearing managed route.
`managed_shared_preferences` requires staged-source capability16 and the
`regaiden-gbc` materialization that older engines cannot parse. Core retains
explicit review of the Windows account and both shared/local preference paths
in schema7 installation manifests. Local saves/settings are managed; the
account-wide file is never owned, backed up, restored or deleted. Scope cannot
travel through adoption, relocation or library transfer. See the
[exact contract and manual reinstall recovery](reference/managed-regaiden.md).
Historical prepared registrations retain their previous non-owning semantics;
this route neither migrates them nor establishes gameplay qualification.

## Managed RaceWave46 sign-in boundary

The exact official Windows v1.0.0 package uses a closed retained runtime-data
policy requiring staged-source capability 15. Ordinary `.runtime` saves and
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

The closed Windows TFE v1.22.420 initializer requires staged-source capability
**12** as a minimum, rather than a range admitting an older implementation.
Transport schema **75** adds the relative source shape and managed initializer;
older consumers must refuse unsupported semantics. Full source inspection and
bounded quick filter observations are distinct: the latter returns `NotChecked`
for this shape. See [managed Dark Forces setup and recovery](reference/managed-tfe.md)
for player workflow, persistence boundaries and the removal recovery hold.

## Default covers

For a whole ordinary catalog proposal, use
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
matching or known `platform_ids` and any specific `edition` for original-game
matching. An independently established positive IGDB `game_id` and exact `slug`
may pin a known identity. These are proposal inputs, not admission authority.
Names alone, a sequel, wrong edition or truncated result set cannot establish a
match. All required identity facts must agree before image acquisition. A coverless port falls
through to its identified original game. Missing, ambiguous, mismatched or
unusable assets produce specific nonblocking cover exceptions and generated
fallback; a decoded image cannot establish semantic identity.

The current authoring catalog is the accepted baseline. Unchanged port/source
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
Decimal seconds and HTTP dates stay within the existing
15 minute batch deadline; a pause reaching that deadline refuses further metadata
requests without sleeping past the budget. Waits remain cancellable, failed
identities are not retried, and uncertain failures retain eligible accepted
metadata. Image requests retain their existing policy. Fixed OAuth, metadata and image responses
are consumed within those byte bounds or their unfinished bodies are cancelled
when refused, including status, content-type and early length checks. Cleanup
does not drain rejected payloads or await an arbitrary cancellation promise;
reader locks are released and the original result or failure is preserved.
Request signals, deadlines, request/byte counters and authentication policy
remain unchanged. Retained references are not fresh source-health evidence.
This command prepares the cover role only;
other roles, full backlog coverage, protected acceptance/publication and installed
or physical-platform evidence retain their own acceptance.

### Reference and exception maintenance

Use the existing catalog/onboarding maintenance checkpoint weekly. Select at most
50 stable port IDs per batch, oldest successful reference observation first, with
stable ID as the tie breaker; check every accepted reference within 28 days.
Use the existing preparation receipt and owning issue evidence for observation
time, input digest, selected refresh IDs, outcome and next due checkpoint. Missing
or uncertain observation dates are due, not evidence of healthy content. This is
an operator cadence, not a new scheduler, registry or player startup task. New or
changed identities and assessed mistakes are investigated when encountered;
ordinary executable updates do not refresh artwork.

Refresh due IDs with `--refresh-artwork` and reuse all unaffected accepted mappings.
The existing hard ceilings remain 400 batch entries, 800 metadata queries, 400 image
queries, 32 MiB metadata, 512 MiB images, 16 MiB per image, 15 minutes overall and 15
seconds per request. The adapter is sequential, spaces metadata starts by at least
300 ms, authenticates once and does not retry failed requests. Stop at those
limits, retain the incomplete receipt and resume only unobserved IDs in the next
bounded batch. Do not call a retained mapping a successful live refresh. Reuse
unchanged downloaded content by identity; only a changed accepted image needs new
semantic review and affected display validation.

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
universal admission gates. Small title-specific core code may use the existing
shared acquisition, transaction, persistence and lifecycle owners when catalog
data or a shared adapter cannot express the useful route. A bare upstream link
or placeholder is not an integration.

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
and an optional HTTPS `help_url` without credentials. These are presentation
facts, never executable recipes or evidence that a step was completed. Current
prepared routes supply them separately from the retained `manual_preparation`
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

Staged-source version 6 adds the Core-owned `release.managed_build` recipe
`yoshis-cookie-nes-cycle-v1.1.0` for Windows x64. This exact recipe binds the
unchanged full USA NES2 original, reviewed game/framework/UI commits, authenticated
CMake/Clang toolchain archive, one checked missing-header patch, generated
cartridge/PRG identities and fixed output inventory. It is an original-driven
build, with a manifest-bound `.portcove-cartridge-build.json` receipt; the
upstream release executable is retained only as an authenticated input. No
caller-supplied command, compiler, executable or recipe extension is accepted.
The ordinary Core install, staging, activation, verification, user-data,
rollback and recovery paths own the result. Compilation runs in its private
operation under existing capacity, cancellation and child-quiescence boundaries.

The declaration fixes `YoshisCookieRecomp.exe`, runtime-root CWD, `game.nes`,
`NESRECOMP_NO_LAUNCHER=1`, and no forwarded arguments. It preserves `config.ini`,
`config.ini.tmp`, `saves/`, and root files matching prefix `cyc_shot_` and suffix
`.png`. The screenshot pattern is not constrained to numeric names. Original,
receipt, executable, libraries, assets and notices remain protected. Undeclared
launch-sensitive companions, including `debug.ini`, are refused before launch;
that file can activate an upstream TCP interface despite developer UI being
disabled. This is sequential verification, not a runtime sandbox. Net, developer
UI and mods are disabled by the recipe, and the common process policy excludes
inherited developer controls. New fitting consumers require their own reviewed
source, build and runtime facts; this enum is not a universal NES builder.

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
Indexed entries require minimum staged-source version 8; versions 1–7 remain
available. Older retained readers refuse through the existing strict envelope.

Staged-source version 7 adds the fixed `dr-mario-nes-cycle-v1.3.0-usa` recipe.
It binds the unchanged full Japan/USA Rev1 NES2 original, Dr. Mario v1.3.0 USA
release input and exact game source. The engine, UI, toolchain and checked patch
are shared with Yoshi. Its explicit USA region selects `game-usa.toml`, NTSC and
the pinned `cyc_seeds.txt`; generated cartridge/PRG identities and the separately
measured 92-object graph must match. Its executable is `DrMarioRecomp.exe`; the
ordinary argument, environment, persistence and protected-companion contracts
above are unchanged. Yoshi retains its 101-object graph and storage identity.

Indexed definitions must require minimum version 6 for Yoshi and 7 for Dr. Mario.
Versions 1–6 remain advertised. Retained contracts preserve the whole
recipe declaration; older readers that cannot preserve it must refuse the strict
projection. Newly supplied plain legacy catalogs may discard unknown fields and
are not a compatible delivery route. Engine capability implementation alone
establishes no title admission, native operation acceptance, signed definition
publication or installed-client delivery.

Staged-source version 9 adds two closed Windows x64 source-only recipes:
`advance-wars-gba-source-cb3facb53b6b-usa-rev1` and
`earthbound-snes-source-fe1155dc26ff-usa`. They bind exact game/framework
source archives, the official SDL2 SDK and the existing authenticated toolchain.
Catalog data supplies no compiler commands or arbitrary recipe extensions. The
primary ZIP is source input, not a fabricated upstream runtime release.

Advance Wars requires the raw USA Rev 1 GBA original with SHA1
`15053499d5b3f49128a941d7f2d84876f5424d0c` within the finite cartridge bound;
no unverified canonical size is invented. EarthBound requires the headerless
3,145,728-byte USA SNES original with SHA256
`a8fe2226728002786d68c27ddddf0b90a894db52e4dfe268fdf72a68cae5f02e`.
Both bind the observed SHA256 and size into private storage and verify the
owned original copy before generation and packaging. Advance Wars builds the
fixed GBA translator before generating C; EarthBound explicitly uses the pinned
Python HiROM backend and disables launcher, mods, netplay, tracing and co-simulation.
The existing bounded compiler groups, graph identity checks, supervised worker,
quiescence proof and publication/recovery authority remain in effect.

These recipes allow only their fixed owned `game.gba` or `game.sfc` argument.
Core refuses forwarded arguments and nonempty inherited `SDL_DYNAMIC_API` for
these two recipes. It does not rewrite the host environment. The runtime contains
the fixed executable, authenticated companions, owned original and notices;
source-only build receipts confer no binary redistribution grant. EarthBound's
crash reporter may import `dbghelp.dll`; that allowance does not apply to other
recipes. Version 9 is required for indexed entries; earlier capabilities and
NES recipe storage identities remain unchanged. Capability implementation,
repository title admission, actual operation acceptance, optional gameplay and
protected installed-client delivery retain their separate evidence requirements.

Staged-source version 13 adds `render96-us-source-48da5c491c8a`, a closed
Windows x64 source recipe for `render96ex`. It pins Render96 source commit
`48da5c491c8abfb2f5192b59278c1c269411e533`, SDL2 2.32.10 and the existing
authenticated toolchain. The selected output is `sm64.us.f3dex2e.exe`, built
with the US/f3dex2e, D3D11/DXGI and SDL2 settings, external stock resources,
and text saves, Discord RPC and RMODERN disabled. No optional model or texture
pack is acquired. Fixed client patches declare the standard I/O header,
adapt the assembler driver, preserve generated C across compiler batches, extract
raw sound-player bytecode from the COFF section with exact identity checks, and
divide extraction/build work into supervised phases. The linker-only plan is
checked before execution. These patches do not authorize catalogue-supplied code
or arbitrary executables. The independent version 11 Windows path capability
retains its existing meaning; the fixed Render96 contract requires that optional
retained path policy to be absent.

The source contract selects only the USA 1.0 variant of the existing
`ghostship-source` identity. Building requires an exact 8,388,608-byte raw
`.z64`, `.n64` or `.v64` file whose canonical big-endian SHA256 is
`17ce077343c6133f8c9f2d6d6d9a4ab62c8cd2aa57c40aea1f490b4c8bb21d91`.
Registering a ZIP for another consumer does not make it a build input; extract
and register its raw original first. Stored bytes and canonical identity are
verified separately. The private runtime retains an immutable owned canonical
copy; the external original remains outside removal authority.

Core fixes launch to `--savepath !` from the runtime root, without forwarded
arguments. Only `sm64config.txt` and `sm64_save_file.bin` are persistent.
Resources, DLLs, extra roots and `cont.m64` remain immutable; no broad save-folder
or file-pattern exception is allowed. Nonempty inherited `SDL_DYNAMIC_API` is
refused. The initial Make recipe requires build paths containing only ASCII
letters, digits, slash, colon, dot, underscore or hyphen. A different source
revision or ambiguous path requires a reviewed compatible recipe. Source and
private build evidence establish no redistribution, signing or publication grant.

Staged-source version 14 adds the closed Windows x64 recipe
`gundam-wing-snes-source-c7aaaa152192-japan-offline`. It pins the game,
framework and UI source trees, SDL2 SDK, toolchain and official setup package.
Only the package-authenticated native analyzer is selected from that kit; the
setup host and bundled build commands never run. Its directory must contain
exactly the admitted analyzer, whose imports are checked independently from
runtime imports. The fixed generator receives its explicit path and cannot
fall back to a Cargo or network build. Generation and compilation reuse Core's
supervised worker, finite deadline, compiler batches, quiescence and publication
fences. The measured larger inputs require a separate 4 GiB temporary allowance.

The recipe requires the headerless 2,097,152-byte Japanese original, SHA256
`dd94308d822636c6ddf73c5e2644c84f2eb8fb4d9201150fc5f37d44d6f423f1`.
It generates C with the pinned project's recipe and builds a stock offline
runtime. Exact preimage-bound patches disable launcher/setup, netplay, optional
mods and diagnostics, keep the real presentation/state-digest helpers, restrict
configuration resolution to `config.ini` in the runtime directory, and identify
the offline build truthfully. Launch takes only the owned `game.sfc`; forwarded
arguments and inherited `SDL_DYNAMIC_API` are refused. Persistent paths are
`config.ini`, `config.local.ini`, `keybinds.ini`, `rom.cfg` and `saves`; the
transient writable-directory probe is the only other declared runtime write.
Configuration `!include` can read additional data files; this is not a filesystem
sandbox or ownership of those external files. Four-input Advance Wars and
EarthBound storage identities remain unchanged. Capability 14 does not imply
catalog admission, actual offered-operation acceptance or protected delivery.

N64 portable version 3 adds only the Windows x64 recipe
`cvlod-n64-source-cb8548d145a1-ui-lifetime-v1`. It pins the Legacy of Darkness
source, dependencies, toolchain, complete CMake package and official SDL/DXC
packages. Source Git identities and official release-transport acquisitions
remain distinct in the retained input manifest. The complete installed
VC 14.44.35207 / Windows SDK 10.0.19041.0 profile is checked and privately copied;
ambient compiler paths and catalog-provided scripts cannot select build tools.
The independent staged-source version 11 Windows path requirement remains
necessary. Linux/macOS retain their existing GitHub release routes.

The recipe accepts only the existing North American original identity, canonical
SHA256 `89e15df6042defddc48c61f7408f99d06fffdb845e2422cf8b5ba8e73d4d70fb`,
as a raw `.z64`, `.n64` or `.v64` file. It retains an immutable canonical proof at
`.portcove-cvlod-build-original.z64`; working `rom.z64` remains persistent and
is checked/rematerialized through the existing exact runtime-source hash. The
UI-context lifetime repair is exact-preimage bound. The fixed generated-byte
oracle, sealed build graphs, process-tree drain and finite 40-minute build
deadline precede atomic publication. CVLoD uses one clock from private SDK
preparation through generation, compilation and pre-publication packaging;
individual commands do not renew it. Other cartridge recipes retain their
20-minute allowance.
Cancellation and the separate process-tree closure deadline are unchanged.
Each invocation preflights at most eight
pure compiler targets, or two compiler targets when helpers are present, with
at most eight helpers. RmlUi uses those same bounds after its compiler-options
correction; the temporary singleton workaround for unintended `-Weverything`
output is removed. Every closure still receives complete preflight and bounded
capture; fitting unit output does not waive a grouped command's output limit.
Ninja still runs only two jobs. The exact pinned RmlUi compiler-options patch forwards its intended
`-Wall -Wextra -pedantic` through clang-cl's `/clang:` interface for the MSVC
frontend; bare `-Wall` otherwise enables `-Weverything` and bare `-pedantic` is
ignored. Other compiler branches and warnings-as-errors stay intact. The
preimage/postimage hashes bind storage identity and the receipt, before input
capture. Individual stream and aggregate diagnostic retention limits stay
unchanged. Oversized closures first
split compiler dependencies, then request up to eight fixed helpers together.
Every selected request group passes the same complete dry-run preflight again;
an unfit group that cannot shrink refuses. Dependency expansion is
split before execution; complete observed action identities must match the
reviewed dry-run, and the sealed graph is rechecked around every invocation.
Shader prerequisites are literal fixed outputs: 55 DXIL files, 56 SPIR-V files
and one preprocessed header. They are bound to the pinned RT64 and project CMake
calls and precede the already fixed generated-C outputs. They add no shader-name
pattern, tool acquisition or larger execution closure. Raw-file cancellation
also drains queued writes before private cleanup; ambiguous drain
retains staging and its journal. Original-dependent output stays local. This
capability establishes neither catalog admission nor actual operation acceptance
or redistribution permission.

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

Release asset hints should identify a stable port, platform, architecture and
package shape when automatic release selection is offered. A controlled N/N+1
test supports an automatic-update claim; it is not a prerequisite for a useful
pinned-release integration. If the selector cannot safely follow an ordinary
compatible release, record that limit and the exact condition for enabling
updates. A deliberate `DirectManifest`, rolling tag, source/runtime identity or
exact qualification record must not be broadened to manufacture automatic
updates.

Declare the offered route's maintenance policy on its existing canonical Port
issue during admission and subsequent disposition work, independently from its
operations and qualification. [#1422](https://github.com/boburning/portcove/issues/1422)
owns cohort reconciliation, [#254](https://github.com/boburning/portcove/issues/254)
owns repeatable proposal and evidence preparation, and
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
For an installed version with a retained definition, the service admits newly
declared exact persistent and runtime-mutable paths only when the current port
definition otherwise matches that retained definition and keeps all of its old
mutable paths. An addition overlapping a recorded immutable file or naming an
executable companion is rejected. The retained definition still owns source and
launch behavior, while newly admitted persistent files participate in collection,
restore, activation, interrupted-activation recovery, rollback and game-output
relocation. Other catalog changes do not silently expand an old installation's
mutable surface. Whole-library export and import retain their separately reviewed
historical contract and can still reject an older install with new sidecars.

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
2. Search the catalog and core adapters before adding behavior.
3. Add declarative metadata or the smallest safe core capability needed for the
   offered route; do not require a family abstraction first.
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
references. Maintainers edit the complete schema-2 authority in
`catalog-current-authoring.json`; `scripts/generate-catalog.mts` deterministically
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

## Read-only disappearance reporting

`scripts/check-catalog-repositories.mts` reports each catalog port against six
separate facts: original-upstream reachability, lineage, exact accepted-artifact
obtainability, preservation, applicable holds, and retained qualification. Its
format-2 output binds the canonical catalog hash and observation interval. A
complete location collection means its declared probes completed; it does not
mean every port is installable or that an artifact was verified.

DirectManifest entries remain in the inventory, with their exact declared
version/platform/digest/size and acquisition URL. The declared original project
is also observed after a provider change. Hosted repositories use their existing
bounded metadata requests. Direct artifact and other project endpoints use HEAD
without provider credentials or redirects. A matching Content-Length establishes
endpoint reachability only; the exact accepted bytes remain Unknown until their
identity is actually verified. Missing, corrupt, inaccessible, contradictory or
partial inputs remain explicit rather than becoming empty healthy inventories.

Lineage decisions remain owned by #139, preservation by #1306 and artifact or
operation holds by #315/#246. This collector evaluates or modifies none of those
authorities. Retained catalog qualification stays attached to its exact original
artifact/source/platform scope; legacy platform arrays are labeled historical
and neither is inherited by another release or location. An absent policy or
preservation observation is Unknown, never permission or a clean hold status.

Each failed availability condition has a deterministic incident key binding
port, location, operation and failed rule, with HTTP evidence, collection time,
backoff and a resume condition. Observation time is excluded from that key, so an
unchanged condition retains its identity. The collector performs no issue writes,
source transfer, installation, artifact execution or automatic qualification.
The shared request, duration and byte bounds remain in force; direct-origin rate
limits leave unrelated locations observable.

The retained Star Fox Enhanced incident in #247 (run 36735216087, job
109955016518, source `5d6905ea8bf90fb887bb49a6a8524ab2ecc5846b`) reported
`kandowontu/starfox-enhanced: github returned 404`. It is candidate continuity
evidence for #124/#139 with authority unresolved. A bare 404 neither establishes
retirement/deletion nor selects a successor or transfers historical qualification.

Existing reviewed catalog maintenance declarations (`retired`, `superseded`,
`abandoned`) account for a 404 only at that port's declared original location.
They produce explicit degraded/unavailable output. They cannot suppress a missing
artifact, new access/integrity failure, repository-name reuse, or an unclassified
location shared with another port. An archived flag or a bare 404 creates no such
declaration. The lineage, byte verification, preservation and distribution
meaning remains independent, even when the monitoring job succeeds.

The owner-approved narrow monitoring extension in #247 comment 6082358982 is
represented by `.github/upstream-health-accounting.json`. Exact reviewed original
301/404 conditions may be accounted while remaining visibly unknown/degraded;
matching requires the same semantic port contract, original location, operation,
HTTP rule and, for301, numeric redirect identity. This is not retirement,
succession, relocation acceptance or a catalog URL change. Changed/shared/new
conditions without matching review remain failures.

Reviewed GitHub direct pins may additionally report exact provider metadata
presence after a delivery302, with repository/release/asset IDs, complete asset
inventory and exact URL/name/size/provider digest/facts matched. No redirect is
followed and no artifact is downloaded or executed. Destination availability and
accepted bytes stay unknown; endpoint reachability is not incremented. Missing,
changed, partial or contradictory metadata stays unaccounted. See
[upstream observations](UPSTREAM-OBSERVATIONS.md) for the bounded collection and
protected accounting contract.

Historical qualification identities are also inventoried at their exact refs
and declared hosted locations, or the matching immutable DirectManifest pin.
Provider-reported digests remain metadata, never verified bytes. Empty/conflicting
asset inventories and capped/partial pages stay Unknown; unavailable optional
provider digests are explicitly unverified. A historical identity without a
locatable declaration stays visibly unmonitored. Failed qualification records are
reported at their original scope without creating or clearing a publisher hold.

An optional `--previous-report=PATH` consumes a bounded prior format-2 report as
comparison evidence. It writes no state, issue comment or status ledger. Only a
matching canonical catalog hash and a nonfuture report no older than 24 hours
can provide notification comparison/backoff; stale or malformed scope is labeled unused.
A structurally valid matching older snapshot retains only its repository-ID
baseline so an outage or repeated replacement cannot silently establish a new
identity. Current availability is always observed afresh.
Repeated identical conditions keep their first-seen time, bounded occurrence
count and `notify: false`; changed HTTP/identity/digest/size/classification facts
request an update while retaining the condition’s first-seen time and count.
Deferred attempts report no fresh HTTP response and identify prior comparison
evidence separately. Rate limits without a usable retry clock use a one-minute
fallback. Fresh recovery is reported separately. Unclassified failures
remain prominent and keep their failure exit even when notification is
unchanged. Ordinary unchanged success with a matching prior report is quiet;
`--json` always emits the complete evidence record. The report never authenticates
a prior snapshot as lineage, publication or distribution authority.

The exact ReGaiden v0.4.1 Windows prepared-runtime route uses this closed
shared-preference contract. Its [qualification report](qualification/slice6-regaiden-prepared-windows-2026-10-19.md)
records original/artifact identity, the preserved ImGui failure, corrected
consent and operation acceptance, and the separate delivery boundaries.
