# External frontend integration

Portcove is a complete native-port manager with a dependable public CLI. Other
applications should integrate once with Portcove instead of learning how to
manage each individual port.

Portcove Desktop remains the flagship player experience; using another
frontend is optional and never requires a player to use a terminal. The shared
core owns source requirements, admission, installation, updates, activation,
rollback, persistence, launch, and recovery. The CLI exposes supported external
entry points. An integration may translate those entry points into its own
presentation and platform conventions, but it does not become another authority
for Portcove lifecycle or catalog policy.

This document is the stable integration direction and support vocabulary. The
[live Project](https://github.com/users/boburning/projects/1) owns priority,
schedule, and status; issues own detailed implementation and evidence. A named
frontend below is a deliberate product-fit candidate, not a shipped-support
claim.

## What exists today

Technical-alpha releases include separate CLI archives for the declared Windows,
Linux, and macOS targets. Alpha 1 and Alpha 2 retain their original unversioned
filenames and platform manifests; future releases use versioned CLI names and one aggregate
checksum manifest. They do not require the desktop application to run. The CLI
currently provides versioned JSON results, JSONL operation
events, schema and capability discovery, explicit library selection, stable
error/exit behavior, durable activity readback, and a raw-stream supervised
`exec` route. See [CLI contract](CLI.md) and [Releasing](RELEASING.md) for exact
current behavior and package limitations.

That shipped foundation is not yet the complete V1 external-client promise.
[#30](https://github.com/boburning/portcove/issues/30) owns demonstrated public
contract gaps and compatibility policy, while
[#243](https://github.com/boburning/portcove/issues/243) owns the bounded real
consumer proof and integration-author experience. Planned behavior remains
planned until those owners contain matching implementation and evidence.

## Capability and support claims

An integration claim must name its capability; the levels do not imply one
another:

1. **Launch-only** invokes an already-installed port with the correct library
   selection and supervises its session. It does not install or update.
2. **Library integration** discovers, imports, exports, or refreshes entries and
   metadata using stable identities.
3. **Lifecycle integration** exposes readiness, setup, installation, updates,
   progress, errors, cancellation, and recovery through Portcove.

Every published support record identifies the environment, integration method,
operations, implementation state, maintenance category, versions/platforms
actually checked, evidence, and known limits. Implementation state uses the
separate values **planned**, **implemented**, **automated-tested**,
**frontend-tested**, and **physically qualified**. Missing evidence is unknown,
not failed.

Maintenance is separately described as **Portcove-maintained**,
**community-maintained**, or **generic/manual**. A reference example is not a
production-plugin support claim. Prefer an existing-compatible versioned fixture
and generated documentation where that avoids drift; do not create a hosted
compatibility service or duplicate Project status by hand.

Portcove maintains the core, public CLI contract, developer documentation,
conformance fixtures, and one small real reference client. Others may build
integrations without private APIs, special permission, or per-port coordination.
Portcove does not promise a first-party plugin for every launcher. Any additional
first-party integration needs a demonstrated recurring user problem, reusable
implementation, and explicit maintenance scope.

## Public interface expectations

External clients use a verified standalone CLI package and discover its
executable, product/API versions, capabilities, schemas, host prerequisites, and
effective library explicitly. Identity for libraries, ports, installations, and
operations must be contract-defined across refresh, update, rollback,
relocation, and supported copy/import flows; titles, mutable paths, display
versions, and array order are not identity.

Machine consumers use versioned JSON results or JSONL events. Diagnostics stay
off machine stdout. The compatibility policy must define additive fields,
unknown enum values, capability negotiation, supported schema window,
announced alpha breaks, migration guidance, and breaking-change handling.
Contracts are generated or structurally checked from authoritative definitions
rather than independently maintained DTOs or lifecycle rules.

Clients may read catalog/installed state, source/tool requirements, readiness,
blocked reasons, previews, activity, and supported operation results. They must
keep eligibility, source compatibility, publisher trust, artifact integrity,
and scoped evidence distinct. They expose Portcove decisions rather than
recreating them.

Headless calls select noninteractive behavior deliberately. Documentation must
cover confirmation, previews and stale-plan rejection, timeouts, fail-fast
conflicts, cancellation, safe retries, and mutations that require fresh consent.
Noninteractive mode is not blanket authorization. A client must not retry
destructive or trust-changing work blindly or depend on hidden desktop state.

Progress records use operation identity, ordered best-effort events, explicit
terminal outcomes, bounded readback/polling, and authoritative durable state
where the core supports it. An interrupted stream or lost output is not success.
Not every operation is promised to survive its initiating process, and
integration support does not require a daemon or another durable job database.

Launch stays distinct from management. The supported route resolves the active
installation, arguments, working directory, approved environment, source
preparation, supervision, and persistence in the core. `exec` intentionally
gives its streams and exit status to the game rather than emitting JSON. A
launcher distinguishes game start, session progress, wrapper failure, game exit
or crash, and post-exit save collection; process creation or a success-shaped
stream fragment is not proof of a successful session. Launch-only integrations
play the installed version and never silently install or update it.

No integration reads Portcove SQLite directly, imports private Rust code, scrapes
GUI state, duplicates catalog rules, interpolates arbitrary shell commands,
leaks credentials, or adds a hidden online dependency for ordinary launch. All
source, checksum, archive, symlink, executable, locking, consent, activation,
and recovery protections remain in force. Desktop application updates, game
updates, catalog updates, and frontend/plugin updates are distinct.

## Author path and independent-consumer proof

The [integration author guide](INTEGRATION-AUTHOR.md) and
[local Playnite reference](../integrations/playnite/README.md) provide the concrete
schema-42 development path. Their protocol fixtures and candidate checks remain
distinct from final frontend, two-adapter and independent-consumer qualification.

The author guide owned by #243 progresses from locating/verifying the CLI and
selecting a library, through listing installed ports and supervised launch, to
optional lifecycle, progress, cancellation, readback, and recovery. Examples
must use argument arrays rather than shell-string interpolation and must be tied
to tested schemas and actual error cases.

It includes troubleshooting for a missing CLI, unsupported capability/schema,
missing prerequisite, concurrent work, interrupted events, and package/sandbox
restrictions. Redistributable synthetic game/source assets, example metadata,
and conformance fixtures must permit basic development without copyrighted game
data. Contribution, issue-reporting, support-record, maintenance-ownership, and
migration guidance are part of the deliverable.

One small general example and the Playnite client in #243 are sufficient.
Bindings are generated only when the reference work demonstrates value; a
language-by-language SDK family, plugin framework, hosted REST service, and
marketplace are not V1 prerequisites.

Acceptance includes a fresh client workspace that uses only a released CLI
artifact plus public documentation, examples, and schemas. During development,
an exactly identified packaged candidate may be substituted to avoid a release
cycle; the result must say so, and final published guidance must point to an
available public release. An agent may perform the exercise, but that is
agent-driven contract evidence, not organic community adoption. Record required
private knowledge, manual workarounds, per-port client code, and maintainer
interventions—not a minimum integration count.

## Deliberate frontend sequence

| Environment                                            | Intended first claim                       | Owner and target                                           | Boundary                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Playnite                                               | Real lifecycle reference client            | #243; integration workstream and Public beta qualification | Small Portcove-maintained example/regression client, not feature parity or an endlessly expanding plugin commitment. |
| Desktop Steam / Big Picture and Steam Deck Gaming Mode | Generic/manual launch-only route           | #290; required Public beta qualification                   | Plugin-free baseline. Automatic game entries and Decky are separate.                                                 |
| ES-DE                                                  | First reusable library-export profile      | #291; opportunistic early Post-V1                          | Thin profile over supported library/launch data, not a second manager.                                               |
| Steam automatic entry management                       | Optional launch convenience                | #292; opportunistic early Post-V1                          | May remain manual if safe supported reconciliation is unavailable.                                                   |
| LaunchBox / Big Box and RetroBat                       | Next Windows candidates                    | #291 evaluation sequence                                   | Proceed only for demonstrated friction, demand, reuse, and maintenance fit.                                          |
| EmuDeck and RetroDECK                                  | Separately qualified packaged environments | #291 evaluation sequence                                   | Inspect actual ES-DE/Steam route and host/sandbox boundaries; do not inherit an ES-DE claim.                         |
| Batocera                                               | Deployment feasibility before support      | #291 evaluation sequence                                   | Invocation alone does not prove executable or dependency compatibility.                                              |
| Lutris, Heroic, and Pegasus                            | Second-wave candidates                     | #291 evaluation sequence                                   | Prefer community ownership where practical.                                                                          |
| PortMaster                                             | Adjacent native-port ecosystem             | #291 evaluation sequence                                   | Evaluate interoperability separately rather than treating it as only a launcher.                                     |
| Decky                                                  | Optional Steam-facing lifecycle client     | #293; opportunistic Post-V1                                | Prefer community maintenance; never required for baseline use or V1.                                                 |

These priorities are product-fit choices, not a market-share ranking, mandatory
matrix, or expansion of Portcove's supported operating systems, architectures,
handhelds, or upstream-build commitments.

## Repeatable library profiles

Where a recurring problem justifies an exporter/profile, it consumes
core-provided library information and shares stable identities plus safe
executable/argument handling. Export has an explicit destination and preview,
requires consent, remains duplicate-free across refresh and update, preserves
user edits where the target permits, and removes only entries owned by that
integration. Artwork ownership and attribution stay explicit.

Repair behavior covers Portcove application-path changes, moved or unavailable
libraries, custom/removable storage, an absent CLI, and stale entries. Profiles
must not hard-code usernames, Deck mount paths, versioned install directories,
or assumptions shared only by similarly derived frontends. They do not mutate
arbitrary third-party libraries, copy original game data, or bypass consent.

## Steam and Steam Deck without Decky

Steam integration puts Portcove-managed games in the Steam library. A Decky
plugin provides optional Portcove controls inside Steam's interface. They share
the public CLI contract, not path, packaging, process, or compatibility
assumptions.

### Plugin-free baseline

[#290](https://github.com/boburning/portcove/issues/290) owns a documented route
to add/open Portcove from Steam Deck Gaming Mode, navigate its supported
controller-first experience, launch a representative game, and return to
Portcove or Steam as appropriate. A clearly explained manual non-Steam entry is
enough; complex setup may hand off to Desktop Mode. It does not promise that
every file picker or upstream setup tool works inside Gaming Mode.
[Steam documents adding a non-Steam game](https://help.steampowered.com/en/faqs/view/4B8B-9697-2338-40EC)
and [switching Steam Deck to Desktop Mode](https://help.steampowered.com/en/faqs/view/671A-4453-E8D2-323C);
implementation must revalidate those current user-facing routes rather than
inventing a shortcut API.

Individual games target:

```text
Steam entry -> supported Portcove CLI launch -> managed game
```

The entry uses stable port and explicit library identity, not a
version-specific upstream executable. It remains valid through ordinary game
updates and rollback and has documented repair for application/library path
changes or unavailable media. Neither the desktop UI nor a plugin is required
to remain open while the game runs. Desktop Steam and Steam Deck are qualified
separately, beginning with appropriate native Linux routes on SteamOS.
Windows-only ports, Proton/Wine configuration, additional architectures, and
other SteamOS devices require their own scope and evidence.

The existing Steam Deck owners keep their boundaries: #213 packaging, #214
controller-first use, #215 Gamescope process/focus lifecycle, #216 storage, and
#217 physical qualification. #290 supplies the Steam-facing baseline and blocks
the applicable final qualification scenarios; it does not absorb device or
package implementation.

### Optional automatic entries

[#292](https://github.com/boburning/portcove/issues/292) evaluates current
mechanisms and reusable import/export tooling before any custom Steam-data
writer. This is neither a V1 nor Steam Deck baseline gate. Any implementation
must select the Steam installation and user, preview exact changes, reject stale
plans, reconcile only its stable owned entries without duplicates, preserve
unrelated games and user artwork/collections/controller configuration, and
bound backup, recovery, restart, concurrent-Steam, partial-failure, and removable
storage behavior. When safe automation is unavailable, documentation must say
what remains manual.

### Optional Decky client

[#293](https://github.com/boburning/portcove/issues/293) evaluates a small,
preferably community-maintained client only after #30 can support it:

```text
Decky interface -> small supported backend bridge -> public Portcove CLI
```

Its initial scope is installed status, available updates, selected explicit
management actions, progress/actionable errors, and handoff to Portcove for
involved setup. It does not recreate Portcove's catalog, onboarding, storage, or
recovery UI; gain private APIs, arbitrary shell authority, elevated trust, a
network service, or another operation database; or require a daemon.

Game launch remains the independent plugin-free route. Plugin reload, removal,
crash, or Steam incompatibility must not delete data, invalidate independent
entries, or strand normal Desktop/CLI use. Operation survival, cancellation, or
recovery is claimed only as implemented by the public contract. Marketplace
acceptance, a volunteer, and community adoption are not gates.
[Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) and its
[plugin template](https://github.com/SteamDeckHomebrew/decky-plugin-template)
are the primary implementation references to revalidate before choosing a
plugin execution, packaging, permission, or bridge design.

## Evidence and release sequence

The integration workstream closes bounded public-contract and author-usability
gaps and proves the real Playnite slice for Public beta. Public beta also includes
the plugin-free Steam Deck baseline under #51/#290, the same Linux application's
updater proof under #52, and unchanged-reference-client compatibility with
independent catalog delivery under #246. Exact production/platform
requalification continues toward 1.0. The cumulative 1.0 contract needs one
independently consumable public interface and real
reference, not a universal frontend list, community quota, automatic entries or
Decky. Optional frontend profiles remain Post-1.0.

Acceptance reuses representative adapter shapes and the smallest real
frontend/device set that supports each claim. Evidence identifies exact
artifacts, OS/frontend versions, and hardware where relevant. Automated,
frontend-tested, and real-device results remain separate. Controller navigation,
focus, actual-game session tracking, orderly return, crash/Stop behavior,
suspend/resume, interruption recovery, internal/removable storage, library
selection, spaces/Unicode, missing tools/media, permissions, and supported
offline launch are exercised only where the claimed scope needs them.

An orderly exit and a forced termination or power loss are not equivalent; do
not promise save collection after every hard kill. Steam registration is not
runtime qualification. Portcove never claims Valve verification or universal
game compatibility. Compatible routine definitions inherit a reusable
integration path, not fabricated gameplay/platform evidence or mandatory owner
playtesting.
