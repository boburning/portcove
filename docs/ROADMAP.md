# Product roadmap

Portcove release stages are cumulative product-maturity contracts. They are
not frozen port lists and have no catalog-count requirement. The catalog may
grow continuously; each port carries its own channel, platform, and
qualification state without automatically becoming a global V1 blocker.

Current priority, horizon, target release, blockers, and detailed scope live in
the [Portcove Roadmap](https://github.com/users/boburning/projects/1).

## Product direction

**North Star:** Make native game ports easy to discover, set up, and keep
playing, without making players manage the quirks of every upstream project.

Compatible additions and routine updates should flow through without
proportional maintainer work. Automation handles ordinary work inside
established authority; the owner handles direction and genuine exceptions.
The intended experience is: “I choose a game, understand what files I need, use
what I already have, get it running, and keep my setup usable when things
change.”

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

The sequence remains Alpha 2 onboarding/storage outcomes; Alpha 3 bounded
integration and scale; Beta 1 required V1 capabilities and feature completeness;
Beta 2 qualification; RC exact artifacts and rehearsal; and V1 the cumulative
support contract. Tests influence development before qualification. If feature
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

The existing source/storage issues share this scenario through
[#15](https://github.com/boburning/portcove/issues/15). A narrowly qualified,
clearly labeled packaged technical preview can exercise it outside a development
checkout once applicable trust gates permit, using disposable or fully backed-up
libraries. Preview planning can precede implementation readiness, but packaging
requires a reviewed integrated-commit implementation and trust checkpoint for
the required onboarding outcomes. Packaged first-play qualification in
[#242](https://github.com/boburning/portcove/issues/242) then supplies evidence
for those outcomes and final Alpha 2 closure; it must not depend on closing the
workstream or outcome issues that still require that same preview evidence.
It need not wait for universal coverage. Finding additional games
compatible with already-selected files is an optional follow-on: discovery is
opt-in and bounded, registration is explicit, and source compatibility alone
does not establish full installation/platform readiness.

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

Complete the planned Windows desktop updater feature work before the V1 feature
freeze, after trust and onboarding priorities. Exact historical game-release
pinning and reproducible profiles remain independent of required onboarding.

## Beta 1 — V1 feature-complete beta

All required V1 capabilities are present. Feature scope freezes except for
blocker-driven changes. The initial Steam Deck baseline qualification target is
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

The 2026-09-05 sequencing decision targets that bounded feature proof at Beta 1,
with design started ahead of it. One official feed and shared local loading
suffice; broad discovery, authoring assistance, community reports and feed
networks are not prerequisites. Optional social-preview/exporter work yields
to this path. Live targets remain in the Project. This adds no Alpha 1 blocker
and no independent-delivery prerequisite to the Alpha 2 packaged preview.

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

## RC — Release candidate

Exact release artifacts, upgrade paths, packaging, signing requirements for
claimed platforms, and the release rehearsal pass with no known release blocker.
Rehearse exact installer, feed, signature, failed-update recovery, and previous
signed rollback identities for the Windows updater when included. Qualify
package-appropriate Linux, Steam Deck, and macOS upgrade paths separately.

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

## Outcome measures

Existing owners record lightweight measures with an explicit scope,
denominator, evidence source, exclusions, and reporting location:

- #15/#242/#255 record active user effort from game selection to first play,
  excluding passive waits and separating automated evidence from usability
  observation.
- #46/#52 and game-update owners record successful return after application and
  game updates separately.
- #22/#48 and applicable lifecycle owners record recovery without manual file
  repair or maintainer coaching and preservation of original sources, saves,
  settings, and recoverable state.
- #246/#247/#254 record owner interventions per eligible routine addition,
  artifact update, and correction; zero-intervention completions; deduplicated
  exceptions; repair attempts; latency/cost; and recovery outcomes. One-time
  provisioning is separate from routine intervention.

Do not invent baselines, adoption claims, or numeric targets without evidence,
or require telemetry infrastructure to make these measures possible. Eligibility
and exclusions stay visible. Preservation failures are failures, not an average
to hide, and agent-job count is not a success measure.
