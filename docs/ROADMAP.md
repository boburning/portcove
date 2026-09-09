# Product roadmap

Public beta and 1.0 are cumulative product-readiness commitments. They are
not frozen port lists and have no catalog-count requirement. The catalog may
grow continuously; each port carries its own channel, platform, and
qualification state without automatically becoming a global 1.0 blocker.

Current priority, horizon, target release, blockers, and detailed scope live in
the [Portcove Roadmap](https://github.com/users/boburning/projects/1).

## Product direction

**North Star:** Portcove is the place players go to discover and play native
game ports: a broad, continually updated catalog, straightforward setup, and a
dependable library that preserves their progress, without players or maintainers
managing every upstream project individually.

Compatible additions and routine updates should flow through without
proportional maintainer work. Automation handles ordinary work inside
established authority; the owner handles direction and genuine exceptions.
The owner should spend time on product direction, useful capabilities and
genuine exceptions rather than processing releases, repairing the same
integrations, personally playtesting every port or approving already-validated
changes. Catalog coverage and freshness should grow faster than the recurring
maintainer attention needed to sustain them.
The intended experience is: “I choose a game, understand what files I need, use
what I already have, get it running, and keep my setup usable when things
change.”

Discovery can also begin with “I have these files”: identify explicitly selected
inputs, explain which independent ports can use them, and reuse existing sources
through the same inspection and deliberate import contract. This optional
file-first journey complements game-first onboarding without becoming another
Alpha 2 or 1.0 gate. Recognizable reviewed or local artwork, clear version and
setup choices, visible ongoing work and actionable failures should make those
journeys easier; broad customization and historical selection remain separate.

Portcove makes heterogeneous native ports feel like one coherent platform.
Portcove Desktop is the flagship experience for discovery, setup, updates,
everyday play, and controller use. Shared core services own each port's source,
installation, game-update, persistence, and launch semantics, so another
frontend can integrate once. Desktop application updating belongs at its host
boundary. Absorbing ecosystem complexity does not mean translating operating
system APIs or supplying builds that upstream does not provide.

Portcove is a complete native-port manager with a dependable public CLI. Other
applications should integrate once with Portcove instead of learning how to
manage each individual port. CLI-first interoperability does not make Desktop
secondary or require players to use a terminal. Portcove maintains the core,
public contract, author documentation, conformance fixtures, and one bounded
real reference client. Additional applications may integrate independently;
Portcove does not promise a first-party plugin for every launcher. Community
participation, partnerships, marketplace approval, integration count, and
adoption are not release gates. See
[External frontend integration](INTEGRATIONS.md).

Prefer policy-accepted catalog data and reusable adapters that minimize upstream work.
Upstream metadata and tooling are optional aids, not blanket admission rules.
Preserve local-first use, optional accounts, honest qualification, and all
safety invariants; require no cloud service, silent telemetry, or distributed
copyrighted game data. Judge progress by successful play, dependable updates,
useful discovery/customization, low-risk migration, and maintainable coverage.

Portcove is not complete by reaching a fixed port count, covering every
upstream, requiring personal gameplay of every entry, becoming a universal
launcher/emulator or compatibility layer, hosting games or ROMs, mandating
telemetry/cloud/accounts, operating a social network or unrestricted mod
marketplace, or trusting runtime AI to execute arbitrary upstream instructions.

Portcove maintains reusable capabilities and acceptance policies. Compatible
new ports and routine upstream releases must eventually complete acceptance
and delivery without personal playtesting or per-candidate owner approval.
Operation eligibility, publisher/source trust, artifact integrity, game-file
compatibility, and scoped evidence/health are independent. An eligible untested
entry belongs in the normal catalog with Install enabled when prerequisites
pass. Missing evidence is unknown; a known failure limits the affected operation.
The current runtime and format-1 delivery remain as documented in
[Catalog policy](CATALOG.md) and [Signed catalog delivery](SIGNED-CATALOG.md).

Broad, current coverage is central, not a small curated selection.
Representative ports bound architectural proofs and release qualification, not
the available catalog. Native source ports, decompilations, recompilations and
new implementations remain within established scope; this does not silently
admit every derivative, emulator, wrapper or compatibility layer. Research
inventory remains distinct from usable coverage and gameplay evidence.

During incremental migration, preserve existing availability, stable identities,
installations, sources, saves/configuration, retained versions and documented
external behavior. Existing adapters may remain behind the shared authority;
unmigrated definitions alone do not justify withdrawing ports. A demonstrated
safety failure still holds the affected operation/artifact/platform. Compatible
additions should mainly add definitions and fixtures. Important new ports may
justify reusable capabilities or a narrowly isolated title-specific exception;
neither a universal abstraction nor a duplicate lifecycle is the entry price.

Use the existing queue for both application maturity and catalog freshness.
High-priority active port work can be Opportunistic for a release: absence does
not block that release, but the work need not always wait. Bound work in progress
and give safety/release blockers precedence. Before independent delivery ships,
compatible additions may still require application releases; preserve that
transitional route without claiming format-1 clients can load new definitions.

The long-term operating test is an extended absence from routine maintainer
work: installed libraries remain usable, accepted routine releases keep arriving,
compatible submitted additions flow through the authorized path, and failures
become isolated, deduplicated exceptions. This is an unproven operating target,
not a new month-long 1.0 gate.

## Planned local-first artwork

Artwork should provide useful account-free defaults, explicit local choices and
cached display that never delays installation or play. Existing owners
[#208](https://github.com/boburning/portcove/issues/208) and
[#206](https://github.com/boburning/portcove/issues/206) own the shared foundation
and presentation within the flagship outcome. Start with recognizable covers,
permitted defaults and generated fallbacks; optional wide imagery, a complete
asset pipeline and artwork for every entry are not release gates.

For each slot, prefer an explicit user choice, then a usable catalog default,
then an automatic provider choice only when enabled, then generated fallback.
Availability does not erase preference: catalog references cannot bypass provider
setup, and refreshes or rankings cannot replace explicit selections. Shared Rust
services own selection, sparse exact-port/original-game mappings, provenance,
safe ingestion and cache policy; hosts own dialogs, secure credentials and display
bridging. React presents that state. Public machine contracts must evolve
compatibly without weakening strict catalog readers or depending on the broader
game-centered discovery model.

Durable choices, mapping corrections and library-owned local imports survive
cache clearing and provider disconnection. Relocation and relevant backup/export
contracts must preserve them explicitly, excluding credentials and any remote
files without redistribution permission. Defaults need actual permission;
attribution, public availability and local hashes are not rights evidence.

[#527](https://github.com/boburning/portcove/issues/527) owns optional SteamGridDB
access using a user-supplied credential, subject to verified application-use and
retention conditions. Provider failure or unresolved access affects only that
scope, never foundational artwork, compatible catalog delivery or 1.0. Steam
entry management remains separate under #292. These are future requirements,
not implemented artwork support or an activated provider.

## Finite 1.0 outcome contract

The cumulative 1.0 finish line has seven outcomes. Canonical issues own their
executable details and evidence; this map is stable direction, not another live
status checklist.

1. **Unassisted first play:** #15 with #36–#39 and exact packaged qualification
   in #242 covers discovery, source understanding, explicit local discovery or
   selection, preparation, storage choice, installation, launch, and actionable
   refusal within representative scope.
2. **Safe ongoing management:** the core trust/recovery owners under #13 plus
   #42 and #48 cover tested install, update, adoption, backup, restore, rollback,
   removal, interruption, capacity, busy-session, and failed-update semantics.
3. **A user-controlled library:** #37 and #38 own coherent default/per-game
   destinations, safe copy versus authorized move, relocation, and currently
   committed adoption/portability. Broad importer coverage in #249 is Post-1.0.
4. **A finished flagship experience:** #200 and its active UX owners cover
   understandable setup, progress, errors, cancellation, interrupted recovery,
   return from play, accessibility, and declared keyboard/mouse/controller use.
5. **Production-ready distribution:** #46 and #52 own qualified packages and
   understandable application upgrade/recovery for every claimed platform,
   without conflating application updates with game updates.
6. **One independently consumable integration contract:** #14, #30, and #243
   provide a documented, tested public CLI plus one bounded real lifecycle
   reference and fresh-workspace consumer exercise without private knowledge or
   copied per-port rules. Multiple frontends, organic adoption, marketplace
   acceptance, automatic Steam entries, and Decky are not gates.
7. **A proven autonomous catalog path:** #245 and #246 prove one accepted scope
   delivering a new compatible definition, its next routine artifact, and a safe
   correction to an unchanged client through protected acceptance and exact
   publication, with zero per-candidate owner actions after provisioning.
   The bounded configured-upstream observer in #398 supplies regular exact
   observations; #246 owns the combined observation-to-client proof. Broad
   discovery in #177 remains outside this finite outcome.

Alpha 2's onboarding and storage outcomes are released. Subsequent delivery is
capability-based: small safe previews may ship while cumulative Public beta or
1.0 commitments remain incomplete. Versions, Stable/Preview channels, workstreams
and readiness are separate. The complete Windows/Linux/Steam Deck/macOS updater
is required for Public beta; independent catalog delivery and production
qualification remain required for 1.0. See [Continuous verified delivery](DELIVERY.md).

General autonomous engineering is separately owned by #284. It is a Post-1.0
extension, not a 1.0, Alpha 2, #243, or #246 dependency. Repository auto-merge
capability and zero required approvals do not establish unattended operation;
the trusted controller, least-privilege trigger, durable resume/evidence model,
budgeting, separate review gate, and end-to-end refusal/recovery scenarios must
exist and pass first.

## Alpha 1 — Trustworthy technical alpha

Close the core install, source-identity, launch, backup, provider, executable,
and permission trust blockers required for controlled technical testing.

## Alpha 2 — Onboarding and storage alpha

Ship structured supported-source inspection, actual-versus-expected hash
visibility, Source Inbox with safe copy/move import and discovery, persisted
library selection, per-game destinations and safe relocation, and official
source-tool links with persisted manual paths.

The central acceptance scenario is unassisted first successful play: choose a
game, provide or explicitly discover its required files, understand preparation,
choose storage, install, and play without maintainer coaching or unnecessary
settings trips. Exercise supported and unsupported variants, missing files or
tools, supported manual handoffs, actionable recovery, destination choices,
and copy/move interruption while preserving originals. Lead with understandable
identity and support results, with full actual/expected hashes accessible beneath
them. Identified, unchanged, upstream-supported, admitted, and physically
qualified remain independent; presentation must not tighten source admission.

The source/storage issues shared this scenario through
[#15](https://github.com/boburning/portcove/issues/15). The released, narrowly
qualified packaged technical preview exercises it outside a development
checkout with disposable or fully backed-up libraries. Its reviewed integrated
implementation, trust checkpoint, and packaged first-play qualification are
recorded in [#242](https://github.com/boburning/portcove/issues/242), which
supplied the evidence for the required outcomes and final Alpha 2 closure.
Alpha 2 did not require universal coverage. Finding additional games
compatible with already-selected files is an optional follow-on: discovery is
opt-in and bounded, registration is explicit, and source compatibility alone
does not establish full installation/platform readiness.

With Alpha 2 qualification complete, start #245 design and continue compatible
catalog work. Independent delivery, freshness and preparation-boundary
migration add no Alpha 2 prerequisite and do not alter the exact package handoff.

## Integration and scale

#14 retains the former Alpha 3 workstream identity and finite outcomes: scoped
reads/provider scaling (#24), controller performance/polish (#29/#44), shared
transport authority (#30), one justified preparation/launch improvement (#31),
bounded operation-event state (#32), and the real reference-client proof (#243).
The Project maps their readiness commitments explicitly; no numbered Alpha 3
release is required. #31 starts with one setup-heavy family and reuses core
journals, locks, activity, cancellation and recovery without a daemon or second
job store. Inspect inputs, resolve a plan, prepare, publish readiness and
supervise launch; necessary upstream interactive setup stays a visible handoff.

#245 design, #397 compatible loading/retained contracts, #398 configured upstream
observation and #246 protected acceptance/delivery form the independent catalog
workstream, prioritized during beta and required for 1.0. Preserve existing
adapters, stable identity, local SQLite, available ports and installed/source/save
state. Typed capabilities need redistributable success/failure/interruption
fixtures; unknown safety semantics fail closed. One official feed and bounded
accepted upstream suffice; full adapter migration and broad #177 discovery are
not prerequisites. #246 must prove a new definition, its next routine artifact
and safe correction reaching an unchanged compatible client with zero routine
owner actions after provisioning. Format-1 clients do not already support this.

Observation retains explicit upstream stable/preview/rolling policies where
supported, full pagination, validated caching, backoff and interrupted recovery.
Latest observed, eligible per platform/channel/capability and installed are
distinct; show stale/unmonitored/held reasons. Same-day availability is a measured
engineering objective within accepted scope, not an existing guarantee. No
automatic game installation or application-channel coupling follows.

## Public beta

Broader testing is appropriate when representative first-play and recovery are
usable; fundamental safety, honest limitations and the complete baseline
application updater are proven. #52 includes Windows per-user NSIS, Linux
AppImage, that same application on Steam Deck, and installed macOS bundles on
Intel and Apple Silicon. Require real updater-enabled release-to-release and
skipped-version evidence, safe failure/data preservation, and a provisioned
bounded release/feed pipeline. Manual reinstall or compiled packages alone do
not satisfy the gate. Missing platform evidence keeps the milestone open.

#51/#213–#217 retain the package/controller/Gamescope/storage/device baseline and
#290 retains plugin-free application and individual-game Steam launch routes.
No automatic entries, Decky, root modification or separate Deck binary/channel
is required. Qualification starts during implementation, including actual
Gaming Mode, normal Exit versus Steam Stop, suspend and removable storage.

Safety-critical UX, clear game-channel controls and existing early safety
commitments stay visible. Public beta does not freeze every 1.0 capability or
require paid certificates, every Linux distro/format, every port or flawless
first-download OS trust. Automatic mode uses one-time consent and safe-time
application with a single restart action when apply-on-exit is not safely
supported. [Delivery](DELIVERY.md) defines acceptance and platform limits.

## 1.0 and exact production candidates

Complete the finite seven outcomes above and every Required Project outcome and
genuine transitive blocker. #46 owns later exact-artifact distribution, upgrade,
recovery and production rehearsal across declared platforms, preserving earlier
#52 beta evidence without making #52 depend on a post-beta closure. Broader
representative usability/platform qualification continues throughout beta;
fundamental updater safety is already required at beta.

RC is stabilization of a frozen candidate scope/commit. Qualified routine fixes
may ship while another capability remains unfinished. Bind production evidence
to exact final packages and catalog inputs; an RC with different embedded
metadata cannot be renamed into its final artifact. Compatible independent
catalog updates may continue; unsupported capabilities cannot enter a client
silently. Production declaration requires cumulative readiness and existing
authority, not a tag suffix alone.

The public CLI and #243 bounded real reference remain independently consumable
without private repository knowledge or per-port rules. Marketplace acceptance,
community adoption, a universal frontend list, catalog counts, automatic Steam
entries, Decky and standalone CLI self-updating are not gates.

## Post-1.0 principles



Initial value order is:

1. **More coverage without proportional maintainer work** — #246, #177, #247,
   #254, and #268. First prove one additional reusable family or one narrow
   local-definition flow with exact identity, repeated completion, rejection,
   recovery, budgets, and explicit local trust; stop before arbitrary scripts,
   false official endorsement, or a broad feed network.
2. **Discover what the user can actually play** — #251 with existing
   identity/source discovery owners. First compare two implementations and
   connect explicitly selected-file matches to readiness while keeping source
   match, platform artifact, prerequisites, and observed gameplay distinct.
3. **Bring existing libraries and preferred frontends along** — first #291's
   reusable ES-DE export profile, then #292's safe Steam-entry evaluation and
   demand-led Windows/environment profiles; #249 remains the bounded existing-
   library importer. #293 is a separate optional/community Decky opportunity.
   Use inspect/preview, consent, stable ownership, duplicate prevention,
   preservation, scoped cleanup, and recovery; stop before broad promises,
   partnerships, a plugin per launcher, or copied lifecycle logic.
4. **Continue progress between PC and Steam Deck** — #252 before #253. First
   prove manual export/import for one persistence family and declared
   version/platform pair with identity-bound snapshots, conflicts, a pre-import
   safety snapshot, and interrupted recovery; transport remains optional.
5. **Customize safely and reversibly** — #40 where exact-version identity is
   required, then #250. First prove one clean and one local customized profile,
   including switching, disabling, removal, compatibility limits, and recovery;
   no hosted mod marketplace or arbitrary execution authority is implied.
6. **Reduce attention required by larger libraries** — #248. First prove that
   suitable stages resume or safely restart without duplicate destructive work
   or lost consent, reusing existing activity/cancellation/recovery and honoring
   locks, sessions, pins, budgets, and recovery assets.

These are ordered themes, not new epics, dated promises, or simultaneous
commitments. Dependencies override display order. Keep them Opportunistic and
outside the active Now/Next queue unless a narrow existing 1.0 prerequisite
actually requires otherwise.

Expand the bounded delivery path through local/community import, conservative
partial management, scalable publisher onboarding and selective health checks.
Review genuinely new authorities, capabilities and ownership boundaries; routine
data changes inside accepted scopes do not require another personal approval.
Under #254, gather identity/distribution evidence and declare accepted repository,
artifact-host and operation scopes for repeatable onboarding; no universal
GitHub/domain trust or per-release review queue. Upstreams need not publish
Portcove metadata, change packaging or make special releases. Deterministic
maintenance is the default; agents assist capability work, diagnosis and bounded
repair without becoming publication authority.
Retain exact installed definition content and contracts, not only a remote URL
or digest. A publishing outage alone must not disable a usable library.

Release monitoring preserves neutral intake and keeps automated canaries separate
from physical qualification. Historical pinning supports scoped mods/profiles;
captured identities and settings bound reproducibility claims, and executable
rollback never implies save-format compatibility. Durable jobs build on existing
activity, cancellation, and recovery; they need one shared authority and
stage-appropriate resume or restart, not a mandatory daemon.

Game-centered discovery may explain distinct implementations without merging
their identities, sources, saves, or provenance. Cross-device continuity follows
data classification and explicit portable save export/import before optional
user-selected synchronization. Never sync the live library database or blindly
mirror mutable data; preserve conflicts, active-session safety, compatibility,
deletion semantics, and recovery. Accounts and transports remain optional.

Maintainer tooling should strengthen existing catalog intake and qualification.
Demand, installation friction, reusable adapter coverage, maintenance cost, and
upstream stability inform prioritization; optional upstream examples require no
universal packaging standard. Actual order and targets remain in the Project.

Competitive catalogs are discovery evidence. Resolve the game, implementation,
source edition, distribution authority, and native runtime separately before
intake. Different games may share an upstream; a wrapper, renamed repository,
framework, or planned game is not an additional implementation. Alternatives
retain independent sources, installations, saves, and qualification. A working
alternative does not resolve the original implementation's failure.

The Port Pipeline Project view is the complete port inventory, with one canonical
issue per independent port across upstream versions, including completed and
deferred records. Active Port Work filters unfinished, non-deferred work without
changing that inventory. The former #16 umbrella is superseded by these views
and finite engineering issues. Parent groups are optional and useful for bounded
outcomes. Intake preserves existing links and does not require a parent or create
numbered overflow workstreams. Work completion remains separate from the
catalog's support and qualification evidence.

Schedule bounded source/setup, process ownership, and package-assembly work
around demonstrated reusable needs. An investigation may proceed while an
affected operation remains blocked. Legacy artifact acquisition requires its
own accepted trust decision; hashing observed bytes does not establish their
initial authenticity. Optional legacy coverage must not become a prerequisite
for the minimum autonomous catalog path. Qualification covers shipped claims
and selected canaries, never every discovery record.

The [2026-09-06 port audit and discovery reconciliation](archive/2026-09-06-ports-roadmap-reconciliation.md)
preserves the historical findings, owner mapping, source gaps, and observed
planning changes. It is a dated snapshot; current issue scope and Project
placement remain authoritative. Comparative claims about effort or reliability
require measured evidence, even when feature lists overlap.

## Outcome measures

Owners record measurements in existing Completion evidence sections and linked
CI/qualification artifacts, not a new dashboard or telemetry service. Every
report declares observation time, method, denominator, exclusions and unknown or
baseline status. This planning change establishes no measurement baseline.

| Measure and owner | Collection and denominator | Exclusions and limits |
|---|---|---|
| Available coverage: #246; expanded onboarding #254 | Catalog/core assessment counts distinct usable ports per platform/operation against declared catalog scope. | Separate research inventory, catalog presence and gameplay qualification; report unsupported/unknown operations. |
| Freshness: #398 observation, #246 acceptance-to-client | Timestamp upstream publication, observation, acceptance, publication and client availability for each release in configured scope. | Declare cadence/clocks; list holds, missing timestamps, unmonitored/stale entries and capability/authority exclusions. Same-day is a target until measured. |
| Compatible addition effort: #246/#254 | Record human/agent effort and application-code changes per addition expected to use existing capabilities. | Separate new-capability engineering and one-time onboarding; retain failed attempts. |
| Routine intervention: #246 | Count owner actions and zero-action completions per eligible definition, artifact update and correction. | Separate provisioning/authority decisions from recurring actions; report excluded candidates and reasons. |
| Exceptions: #246 minimum, #247 expansion | Existing records report age, recurrence, affected scope, failed rule, evidence, fallback and resume condition per unique exception and attempted change. | Deduplicate occurrences without hiding recurrence or unresolved holds. |
| Player outcomes: #15/#242/#255, #46/#52, #22/#48 | Scoped journey records measure active first-play effort, return after app/game updates, recovery and source/save/settings preservation per attempted scenario. | Separate passive waits, automation, physical observation and novice comprehension; synthetic success cannot establish understanding. |
| Operating cost: #398/#246, expanded tooling #254 | Record API calls, download bytes, CI time, retained storage and agent cost per accepted change and per exception. | Declare shared/provisioning costs and unavailable billing data; bound retries, concurrency and retention while protecting active/pinned/recovery assets. |

Targets remain targets until measured. One accepted upstream does not establish
ecosystem-wide autonomy; expand declared proven scope over time. Preservation
failures are failures, not an average to hide, and job count is not success.

Freeze application feature scope when needed, not compatible catalog growth.
Representative ports prove the engine; use that engine to make the full catalog
broader, more current and less expensive to maintain.
