# Product roadmap

Portcove release stages are cumulative product-maturity contracts. They are
not frozen port lists and have no catalog-count requirement. The catalog may
grow continuously; each port carries its own channel, platform, and
qualification state without automatically becoming a global V1 blocker.

Current priority, horizon, target release, blockers, and detailed scope live in
the [Portcove Roadmap](https://github.com/users/boburning/projects/1).

## Product direction

Portcove makes heterogeneous native ports feel like one coherent platform.
Portcove Desktop is the flagship experience for discovery, setup, updates,
everyday play, and controller use. Shared core services own each port's source,
installation, game-update, persistence, and launch semantics, so another
frontend can integrate once. Desktop application updating belongs at its host
boundary. Absorbing ecosystem complexity does not mean translating operating
system APIs or supplying builds that upstream does not provide.

Prefer reviewed catalog data and reusable adapters that minimize upstream work.
Upstream metadata and tooling are optional aids, not blanket admission rules.
Preserve local-first use, optional accounts, honest qualification, and all
safety invariants; require no cloud service, silent telemetry, or distributed
copyrighted game data. Judge progress by successful play, dependable updates,
useful discovery/customization, low-risk migration, and maintainable coverage.

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
and supported launch entry points must survive game updates. External marketplace
acceptance, partnerships, or third-party adoption are not release gates.

Complete the planned Windows desktop updater feature work before the V1 feature
freeze, after trust and onboarding priorities. Exact historical game-release
pinning and reproducible profiles remain independent of required onboarding.

## Beta 1 — V1 feature-complete beta

All required V1 capabilities are present. Feature scope freezes except for
blocker-driven changes. The initial Steam Deck baseline qualification target is
Beta 1; qualification determines whether ordinary Linux packaging is sufficient
rather than assuming a separate build.

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
separate optional feature.

## Beta 2 — Qualification beta

Physical platform, controller, representative-port, installer, migration,
backup/restore, and user-experience qualification is substantially complete.

Qualify the Windows upgrade mechanism and the reference-client outcome. Required
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

## Post-V1 principles

Independent delivery of reviewed definitions should let a capable installed
engine accept new ports and compatible recipe fixes, following a
trust/compatibility design before implementation.
Informational metadata, declarative definitions, and new engine capabilities
remain distinct; source, executable, setup, and persistence changes need explicit
review and migration semantics. Retain installed definition identity and normal
offline use; a publishing outage alone must not disable a usable library.

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
