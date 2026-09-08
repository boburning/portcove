# Product roadmap

Portcove release stages are cumulative product-maturity contracts. They are
not frozen port lists and have no catalog-count requirement. The catalog may
grow continuously; each port carries its own channel, platform, and
qualification state without automatically becoming a global V1 blocker.

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
Alpha 2 or V1 gate. Recognizable reviewed or local artwork, clear version and
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
not a new month-long V1 gate.

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
scope, never foundational artwork, compatible catalog delivery or V1. Steam
entry management remains separate under #292. These are future requirements,
not implemented artwork support or an activated provider.

## Finite V1 outcome contract

The cumulative V1 finish line has seven outcomes. Canonical issues own their
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
   committed adoption/portability. Broad importer coverage in #249 is Post-V1.
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

Alpha 2's onboarding and storage outcomes are released. The sequence continues
with Alpha 3 bounded integration and scale; Beta 1 required V1 capabilities and
feature completeness; Beta 2 qualification; RC exact artifacts and rehearsal;
and V1 the cumulative support contract. Tests influence development before
qualification. If feature
development paused after V1, users could still set up, play, update, preserve
progress, and recover while compatible routine catalog changes kept flowing.

General autonomous engineering is separately owned by #284. It is a Post-V1
extension, not a V1, Alpha 2, #243, or #246 dependency. Repository auto-merge
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

## Alpha 3 — Integration and scale alpha

Close stale asynchronous behavior, machine-contract and transport gaps,
provider/data-access scaling problems, controller performance issues, and
internal boundary work justified by proven transaction seams. Prove the shared
machine contract through one bounded real reference client: catalog/installed
discovery, prerequisites/readiness, install/update progress, actionable errors,
supervised launch, and recovery without copied per-port rules. Stable identities
and supported launch entry points must survive game updates. Complete a compact
integration-author path with tested schemas/examples, conformance fixtures and
redistributable synthetic assets. A fresh client workspace must consume only a
released CLI artifact and public material; an exactly identified packaged
candidate may stand in during development, with that limitation disclosed.
External marketplace acceptance, partnerships, third-party adoption, and an
integration count are not release gates.

After accepted #245 design, #397 schedules #246's first independently verifiable
phase: compatible client loading, capability negotiation and exact retained
contracts. The complete delivery outcome remains Beta 1. Begin #398's bounded
configured-upstream observation, independently testable without a publisher.
Neither full adapter migration nor broad #177 discovery closes this alpha.

#31 owns one justified preparation/launch improvement, starting with one
setup-heavy family: inspect requirements, resolve an exact plan, perform managed
preparation, publish readiness, then validate/supervise launch and preserve data.
Substantial extraction, conversion, builds and tool setup should be explicit
preparation; necessary upstream interactive first-run work remains a visible
handoff. Reuse the journal, locks, activity, cancellation and recovery; revalidate
stale inputs and resume only safe phases. No daemon, second job store or full
#248 scheduler is required. #30 exposes core-owned operation actions/reasons;
#206 owns presentation, focus and progressive disclosure. Consistent inputs must
produce consistent supported actions across clients, never path-based readiness.

The bounded preparation proof may expose a justified upstream-supported typed
option with a sensible default. Bind options to the exact plan, validate outputs,
and distinguish host execution, preparation target and qualified platform support.
Optional content acquisition and broad profiles are not prerequisites. A named
launch alternative requires the core's executable, argument, process and
persistence contract; a target selector does not establish cross-compilation.

#245/#397 define a small typed capability vocabulary with explicit inputs,
outputs, permissions and supported combinations; existing adapters may implement
it incrementally. Simple binaries, generated data, disc inputs and awkward
runtime/persistence cases guide proof selection without shrinking coverage. Each
new capability needs redistributable success, malformed/missing-input, output,
interruption/retry and preservation fixtures. Synthetic evidence is not gameplay.

Complete the planned Windows desktop updater feature work before the V1 feature
freeze, after trust and onboarding priorities. Exact historical game-release
pinning and reproducible profiles remain independent of required onboarding.

## Beta 1 — V1 feature-complete beta

All required V1 capabilities are present. Application feature scope freezes
except for blocker-driven changes; compatible independent catalog growth
continues after that capability ships. The initial Steam Deck baseline target is
Beta 1; qualification determines whether ordinary Linux packaging is sufficient
rather than assuming a separate build. #290 adds a required documented
plugin-free Steam route for Portcove itself and individual already-installed
games, coordinated with #51's packaging, controller, Gamescope, storage, and
physical-evidence owners. Desktop Steam and Steam Deck evidence remain separate.
Automatic entry management in #292 and a Decky client in #293 are optional
Post-V1 work, not prerequisites.

The minimum sustainable catalog path is a required V1 capability: an existing
adapter and scoped accepted upstream deliver a new untested definition to a
client built before that definition, then make its routine next release
available, with protected validation, exact signed publication and recoverable
last-known-good state. Both routine scenarios require zero per-candidate owner
actions. Application updates and automatic game installation are separate.
The design and complete delivery owners are
[#245](https://github.com/boburning/portcove/issues/245) and
[#246](https://github.com/boburning/portcove/issues/246).

The bounded feature proof remains Beta 1, with design and the #397 client phase
ahead of it. One official feed, shared local loading and #398's configured
accepted-upstream observation suffice. #398 begins during Alpha 3 and completes
for Beta 1; #246 depends on its observation contract for final integration, while
both components develop with fixtures independently. Broad discovery, authoring,
community reports, legacy acquisition and feed networks are not prerequisites.
Optional social-preview/exporter work yields to this path. Live targets remain
in the Project. No Alpha 2 preview prerequisite is added.

The freshness proof connects observation, candidate, protected acceptance, exact
publication and compatible-client availability. It covers complete pagination,
validated caching, rate limits/backoff, bounded retry, interrupted recovery and
explicit stable/preview/rolling policies where supported. Verify provider
semantics during implementation; a latest endpoint need not include previews.
Prerelease-only projects remain discoverable. Distinguish latest observed,
latest eligible per platform/channel/capabilities and installed version; show
newer held releases and reasons instead of calling an older version fully
current. Availability never overrides update settings, sessions or consent.

Use deterministic fixtures, a scheduled actual configured-upstream observation
and controlled redistributable/test-upstream artifact changes. Keep synthetic,
live observation, real-artifact lifecycle and gameplay evidence distinct.
Same-day availability within accepted scope is an initial measured engineering
objective, not existing performance or a universal guarantee. Declare cadence,
clocks, scope, exclusions and unknown baseline; expose unmonitored/stale entries.

The flagship client lets a player find something playable, finish setup,
understand progress/errors, return to running or interrupted work, and launch
again using keyboard, mouse, and controller. Required setup stays visible;
optional maintenance is secondary. Current core state and evidence support
readiness and trust claims, never a nonempty selected path alone. Consistent game
pages, recognizable reviewed or local artwork, upstream attribution, readability,
and accessibility matter more than a branding redesign or elaborate asset pipeline.

Representative real Steam Deck checks begin during development soon enough to
affect design; beta records completion evidence for controller-first operation,
Desktop handoff, Gamescope focus/process behavior, suspend/interruption recovery,
removable storage, and return from a game. Hardware and human observations remain
unverified until performed. Automatic per-game Steam shortcut management is a
separate optional feature. The baseline must work with Decky absent and remain
usable when an optional plugin is disabled, removed, broken, or incompatible.

## Beta 2 — Qualification beta

Physical platform, controller, representative-port, installer, migration,
backup/restore, and user-experience qualification is substantially complete.

Qualify the Windows upgrade mechanism, reference-client outcome, and claimed
plugin-free Steam/Steam Deck launch environments. Required
migration safety means core adoption, backup/restore, and schema migration;
experimental imports from other launchers and broad importer coverage are
separate. Voluntary comparative sessions may inform development, but recruitment,
external participation, and sample size are not release gates. Reproducible
first-play, recovery, and return-after-update acceptance remains required.

Qualify the bounded independent-delivery path and its migration/recovery as well
as application packages and declared controls/platforms. Compatible catalog work
continues; a failure limits the affected scope rather than freezing the inventory.

## RC — Release candidate

Exact release artifacts, upgrade paths, packaging, signing requirements for
claimed platforms, and the release rehearsal pass with no known release blocker.
Rehearse exact installer, feed, signature, failed-update recovery, and previous
signed rollback identities for the Windows updater when included. Qualify
package-appropriate Linux, Steam Deck, and macOS upgrade paths separately.

Bind qualification to exact application artifacts and exact catalog inputs.
Compatible independent catalog updates may continue during RC/V1 application
freezes; new engine capabilities or unsafe contract changes cannot silently
enter the candidate. Requalify inputs relevant to each changed claim.

## V1

Ordinary users can safely use the declared V1 platforms and understand every
port's support state. All cumulative required gates are complete. Representative
canary ports and platform evidence may be release gates; the total number of
catalog entries is never a V1 gate.

A tested, understandable, verified application-upgrade path is required.
Signed Windows desktop in-app updates are the preferred delivery mechanism;
[#52](https://github.com/boburning/portcove/issues/52) preserves its bounded host
scope, explicit approval, busy-state guards, trusted origins, version rules,
separate app/game channels, key custody, and exact previous signed rollback.
Early previews may use a clearly communicated verified manual path. An actual
external prerequisite preventing safe in-app delivery requires a recorded
blocker and explicit reviewed scope/Project-target decision. Manual upgrading
does not complete an in-app updater ticket. All-platform automatic updating and
standalone-CLI self-updating are not V1 gates. See [Releasing](RELEASING.md).

The public interface at V1 is documented, tested, independently consumable, and
proven by one real reference client. V1 does not require a universal frontend
list, a community-contribution or adoption quota, a plugin matrix, automatic
Steam entry management, or Decky. Launch-only, library, and lifecycle claims
remain distinct, as do planned, implemented, automated-tested,
frontend-tested, and physically qualified evidence.

## Post-V1 principles

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
outside the active Now/Next queue unless a narrow existing V1 prerequisite
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
