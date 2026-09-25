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
currently provides versioned JSON results, independently versioned JSONL
operation events, schema and capability discovery, explicit library selection, stable
error/exit behavior, durable activity readback, and a raw-stream supervised
`exec` route. See [CLI contract](CLI.md) and [Releasing](RELEASING.md) for exact
current behavior and package limitations.

That shipped foundation is not yet the complete Public beta external-client
promise.
[#30](https://github.com/boburning/portcove/issues/30) owns demonstrated public
contract gaps and compatibility policy, while
[#243](https://github.com/boburning/portcove/issues/243) owns the bounded real
consumer proof and integration-author experience. The current Playnite client is
developer-loaded; [#910](https://github.com/boburning/portcove/issues/910) owns its
separate normally installable, user-ready lifecycle product. Planned behavior
remains planned until its canonical owner contains matching implementation and
evidence.

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
schema-42 through schema-53 development path. The
[dated command audit and measurements](archive/2026-09-20-public-cli-consumer-audit.md)
record the proportional capability mapping, process budgets, representative
refresh and launch observations, and offline boundary. Their protocol fixtures
and candidate checks remain distinct from final frontend, two-adapter and
independent-consumer qualification.

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

One small general example and the Playnite reference in #243 are sufficient for
public-contract proof. They do not complete #910's user-ready product experience.
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

| Environment                                            | Intended first claim                           | Owner and target                                           | Boundary                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Playnite reference                                     | Real lifecycle contract proof                  | #243; integration workstream and Public beta qualification | Developer-loaded regression/author client with preserved evidence; it is not the user-ready package.                                   |
| Playnite product                                       | Normally installable everyday lifecycle client | #910; required Public beta product                         | Thin over core policy, useful for declared operations, with no marketplace or universal-launcher gate.                                 |
| Desktop Steam / Big Picture and Steam Deck Gaming Mode | Generic/manual launch-only route               | #290; required Public beta qualification                   | Plugin-free supported fallback and direct-launch baseline.                                                                             |
| ES-DE                                                  | First reusable library-export profile          | #291; opportunistic early Post-V1                          | Thin profile over supported library/launch data, not a second manager.                                                                 |
| Steam selected-game entry management                   | Add/Repair/Update-artwork/Remove               | #292 with #527; required Public beta product               | Exact installation/profile and owned-entry/art reconciliation; provider use stays optional and continuous synchronization is excluded. |
| LaunchBox / Big Box and RetroBat                       | Next Windows candidates                        | #291 evaluation sequence                                   | Proceed only for demonstrated friction, demand, reuse, and maintenance fit.                                                            |
| EmuDeck and RetroDECK                                  | Separately qualified packaged environments     | #291 evaluation sequence                                   | Inspect actual ES-DE/Steam route and host/sandbox boundaries; do not inherit an ES-DE claim.                                           |
| Batocera                                               | Deployment feasibility before support          | #291 evaluation sequence                                   | Invocation alone does not prove executable or dependency compatibility.                                                                |
| Lutris, Heroic, and Pegasus                            | Second-wave candidates                         | #291 evaluation sequence                                   | Prefer community ownership where practical.                                                                                            |
| PortMaster                                             | Adjacent native-port ecosystem                 | #291 evaluation sequence                                   | Evaluate interoperability separately rather than treating it as only a launcher.                                                       |
| Decky                                                  | Optional Steam-facing lifecycle client         | #293; opportunistic Post-V1                                | Prefer community maintenance; never required for baseline use or V1.                                                                   |

These priorities are product-fit choices, not a market-share ranking, mandatory
matrix, or expansion of Portcove's supported operating systems, architectures,
handhelds, or upstream-build commitments.

## User-ready Playnite lifecycle

[#910](https://github.com/boburning/portcove/issues/910) owns a normally
installable `.pext`; building C# and enabling external-extension loading are not
the consumer path. First use guides the player to a verified compatible Portcove
runtime and an explicit existing or intentionally separate library. A missing or
incompatible runtime gets an understandable install, upgrade or repair path, but
the integration does not invent a backend installer, require Desktop to remain
open, or imply a standalone CLI self-updater.

The default personal library contains installed and explicitly selected games,
with compatible-catalog browsing as a separate flow. It does not dump the whole
catalog, scan whole drives by default, infer ownership from compatibility, or
fuzzy-merge a native port with an emulated/original-game entry. Stable library and
port identities prevent duplication across refresh, rename, update, rollback and
supported relocation while preserving user-selected metadata and organization.

The primary action is state-driven—Install, Choose original files, Finish setup,
Play, or Review problem—with an eligible update offered separately from Play.
File/folder selection, requirements, source validation, destination and
consequences stay understandable while core retains policy, exact consent,
trust, stale-plan, concurrency and preparation authority. Genuine upstream setup
may use an explicit Desktop-mode handoff instead of a mouse-only dead end.

Play launches the installed version through core supervision and never silently
installs or updates. Supported Playnite conventions expose installed state,
explicit install/update/uninstall, progress, cancellation, durable readback and
recovery. Automatic game updates occur only under separately selected core policy.
Uninstall previews exactly what core removes and preserves originals, saves,
backups and unrelated installs; hiding or removing a Playnite entry is not
uninstall consent. Session presentation distinguishes child start, exit/crash,
stream loss and post-exit work instead of fabricating success or blindly retrying.

The product consumes shared metadata/artwork with provenance and applicable
export rights, allows readable generated/offline fallbacks, and supports routine
fullscreen/controller launch and messages. Its support record names tested
Playnite/runtime versions, package/runtime/catalog/game update boundaries,
maintenance ownership, diagnostics and known limitations. Marketplace acceptance,
a complete artwork catalog and a new metadata provider are not completion gates.

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

Keep Steam's fields separate; do not paste one shell command into a target field:

| Entry                | Program/target                                                                | Argument array                                                           | Start in                              |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| Portcove application | The stable current-user AppImage path selected under #213                     | Empty                                                                    | The AppImage's parent directory       |
| Installed game       | A stable absolute path to `portcove` from the verified standalone CLI archive | `--library`, the absolute library root, `exec`, the stable port ID, `--` | The standalone CLI's parent directory |

The argument-array row is the canonical identity. When entering it in Steam's
Launch Options field, quote the library value as one argument if it contains
spaces; do not add `sh -c`, interpolate a game title, or target a versioned game
executable. A static manual entry intentionally omits `--request-id`: the CLI
creates a fresh launch identity itself. A real external client that needs
durable polling supplies a new UUID per launch and uses `launch show`; reusing a
fixed UUID is rejected.

If that client loses its Portcove supervisor and `launch show` still reports an
unfinished request, it may explicitly invoke `launch recover <request-id>`.
Recovery succeeds only after core proves the recorded supervisor is gone, retains
the per-port exclusion, follows only the recorded child with its process-start
identity, and still matches the exact registered install. It waits for that child
when necessary, performs exact-install collection, and records a failed terminal
outcome. Live supervisors, ambiguous child creation, missing identity, or install
drift remain manual-review conflicts. Steam Stop or another hard termination must
not be described as giving the game an opportunity to flush saves.

The entry uses stable port and explicit library identity, not a version-specific
upstream executable. Ordinary game update or rollback changes neither field.
After a supported library relocation, update only the explicit library argument.
If the separately packaged CLI is moved or replaced at a different path, repair
the target and Start In fields; the Desktop/AppImage updater does not silently
relocate or update that standalone executable. Unavailable removable storage or
a missing CLI must remain a visible launch failure, never an implicit install,
update, or fallback to another library. Neither the desktop UI nor a plugin is
required to remain open while the game runs.

Current controlled release smoke executes every actual standalone CLI package
from an extracted path containing spaces and Unicode, selects an explicit
spaces/Unicode library, verifies exact `invocation` provenance, and confirms the
packaged `exec`, `launch.show`, and `launch.recover` capability surface. This proves packaged
executable/path/library admission, not a game session or a Steam-client launch.
Desktop Steam and Steam Deck remain separate qualification environments,
beginning with appropriate native Linux routes on SteamOS.
Windows-only ports, Proton/Wine configuration, additional architectures, and
other SteamOS devices require their own scope and evidence.

The existing Steam Deck owners keep their boundaries: #213 packaging, #214
controller-first use, #215 Gamescope process/focus lifecycle, #216 storage, and
#217 physical qualification. #290 supplies the Steam-facing baseline and blocks
the applicable final qualification scenarios; it does not absorb device or
package implementation.

### Required selected-game Add, Repair, artwork update, and Remove

[#292](https://github.com/boburning/portcove/issues/292) owns user-initiated Add,
Repair, Update artwork, and Remove for selected installed games, including selected
batch Add.
The current Desktop shortcut review requires a live managed installation and a
compatible standalone CLI for Add or Repair. Remove can review and delete a
demonstrably Portcove-owned shortcut after the managed game has been uninstalled;
it still binds the selected library, Steam installation/profile, exact shortcut
contents, process state and final consent. Removing the shortcut never uninstalls
the game or removes saved data. An unowned or changed shortcut is not eligible
for removal through this route.
It investigates current primary documentation and maintained mechanisms before
choosing a writer; it must not invent an official API or conceal a reverse-
engineered dependency. The user selects the exact Steam installation and profile,
previews exact changes, consents, and receives stale-plan rejection. If Steam
must be closed, the flow explains and requests that action rather than forcing it.

Add offers **Include artwork** and previews the exact existing destination state
plus each proposed static portrait cover, landscape cover and hero/banner. Existing
Steam artwork is preserved by default. Suitable explicit local choices and
permitted defaults are reused through #208; that reuse cannot silently authorize
a remote request. When separately configured and enabled, #527 may fill missing
roles through the same shared authority. Any role may be unavailable: a truthful
result such as “Added to Steam; hero artwork unavailable” still represents a
successful entry and supports a later explicit retry.

Repeated Add/Repair/Update-artwork is duplicate-free and targets the active managed
game through the verified Portcove launch runtime, explicit library, safe argument
array, and working directory rather than a version-specific game executable. Repair covers
runtime moves/upgrades, library relocation, missing executables, and unavailable
removable storage without silently choosing another library. It never resets
artwork, names, collections, controller configuration or other customization and
does not write artwork; missing or changed art uses the separate action below.
**Update Steam artwork** is a separate reviewed action: filling missing roles is
the default, while replacing existing artwork requires a deliberate choice.
Portrait art is not stretched or destructively cropped into another role.

#208 owns selected assets, accepted bytes, provenance and the small versioned role
handoff; #527 owns provider authentication, lookup and provider rules; #292 alone
owns the Steam destination plan and write. Destination-local copies use bounded,
staged, recoverable replacement and do not point at Portcove's disposable thumbnail
cache or a provider URL. Compare destination state again before writing. Only an
exact demonstrably Portcove-owned, unchanged file is eligible for consented cleanup;
ambiguous or externally modified files are preserved. Remove affects only the
selected owned entry and eligible owned art and never uninstalls a game or removes
saves, Portcove originals, backups or unrelated Steam content. Bookkeeping remains
minimal entry/art reconciliation, not another lifecycle database.

Backup/recovery, missing-account, concurrent change, interrupted write, partial
batch/role failure, cache clearing, relocation, provider outage/disconnection,
withdrawal, missing storage, spaces/Unicode, and exact ownership are part of
acceptance. Remote work is bounded and cancellable and cannot hold shortcut
creation indefinitely. Missing/revoked credentials, offline service, throttling,
ambiguous/no match or failed art cannot block a safe entry or prepared launch.
#290's manual route remains a supported fallback and useful interim delivery, but
it does not complete #292. If safe implementation is unavailable, the commitment remains
open with its exact blocker; continuous synchronization stays outside beta.

#### Implemented controlled writer foundation

The Desktop backend now has a controlled, profile-scoped foundation for the local
shortcut file. This is not an official Valve API. Valve's current user guidance
documents adding non-Steam games through the client and explicitly describes the
result as a shortcut, but does not specify a programmatic writer. As a maintained
comparison, [Steam ROM Manager at the inspected revision](https://github.com/SteamGridDB/steam-rom-manager/blob/bd66e5f4ef1eb0b4855bbd216063f547f1468368/src/lib/vdf-shortcuts-file.ts)
still reads, merges and writes each selected profile's `shortcuts.vdf` using the
separately maintained
[`steam-shortcut-editor` package](https://github.com/tirish/steam-shortcut-editor/tree/d755f03e28280e64c96e4a6039739fcb41e28f0e).
That package also warns that concurrent Steam changes can overwrite the file and
malformed output can be deleted. Portcove does not take either project as runtime
authority or dependency; it owns a smaller
fail-closed compatibility boundary and must requalify it against actual supported
Steam versions.

The implemented planner supports one explicitly selected installation/profile and
single or selected-batch Add/Repair/Remove against the actual binary shortcut
format. It binds the original and proposed file hashes plus the selected library,
CLI and port identities into the review hash. Repeated Add/Repair reconciles by the
exact ownership marker. A new canonical Steam AppID must be unique across the
selected profile; a collision between Portcove routes or with an unrelated entry
fails before mutation rather than creating an ambiguous duplicate. Repair
preserves the stored app ID, user title, icon/artwork reference, tags and unknown
fields while changing only the stable CLI route. Remove requires the exact
Portcove marker and leaves unrelated entries, the managed installation, saved data
and backups alone. Paths containing spaces or Unicode remain literal quoted Steam
fields; no shell is introduced.

Application requires a closed-client observation, an unchanged review, and an
exclusive per-profile Portcove lock. The encoded candidate must remain within the
same byte, nesting and field-count limits used for reading. A content-addressed
regular-file backup is flushed before publication; a symlink, directory or
same-name file with different bytes is never followed or replaced. The journaled
publication evacuates and rechecks the reviewed source, then installs the staged
candidate through a no-clobber handoff. A concurrent edit is restored when that is
unambiguous; a concurrent destination or any third identity keeps the journal,
staged bytes, evacuated original and backup for manual reconciliation instead of
overwriting data or calling the outcome a rollback.

Current evidence is fixture-controlled binary parsing and durable local publication,
including stale-state, parser-limit, AppID-collision, concurrent-edit,
malformed-data and interrupted-journal cases. Desktop exposes a bounded
single-game consumer in the game's Technical details, including after uninstall. The
Library also offers selected-batch Add/Repair for at least two installed games.
The selection is explicit and one reviewed plan covers every selected game in
one exact Steam profile. The host rejects duplicate, unknown, or uninstalled
selection, binds each active install ID into the batch review hash, rederives
every game and the compatible CLI before and after native consent, and refuses
the write if any selected install or profile state changed.
The durable writer applies the batch as one shortcut-file publication, retaining
its original backup and journal recovery behavior.
The user chooses a Steam installation folder and enters the exact numeric profile
directory, then reviews the resolved shortcut file, library, standalone CLI and
Add/Repair/Remove result before a separate confirmation. The host derives the
catalog port and durable library identities itself, observes the main Steam
process, never closes it, and reconstructs the complete host context and plan
after consent; an unknown or running process and any changed reviewed profile,
library, shortcut, runtime or selection fail closed. Add/Repair also rechecks the
installed game. Remove remains available without an install or CLI only when the
selected profile contains an exact owned entry.
Add/Repair accepts only a standalone CLI whose passive embedded marker advertises
this Portcove version's Steam `exec` contract, shows its SHA-256 in the review,
binds that identity into the plan, and rehashes the same no-follow regular file
before writing. Desktop carries only the expected marker length and digest, not
the plaintext capability marker, so its own executable cannot satisfy that
inspection merely by containing the scanner. Desktop does not execute or shell
out to a discovered candidate, and this compatibility marker is not a
publisher-signature claim.

This consumer is not profile discovery, batch selection, artwork delivery, or an
actual Steam-client qualification. Controlled host and renderer tests prove the
review/apply contract and isolated shortcut-file behavior. Native positive-path
qualification may use the compile-time fixture that reports the client closed;
that proves UI, consent, stale-plan and writer integration against an output-owned
Steam tree, not an actual closed Steam process. It does **not** prove Steam
consumed the entry, client restart behavior, Steam-facing launch/Stop/return,
Desktop presentation in a packaged candidate, or Steam Deck behavior. Those
remain separate implementation and actual-platform gates for #292, #527 and #217.

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
gaps and proves the real Playnite reference under #243. Public beta additionally
requires the normally installable Playnite lifecycle product under #910, selected-
game Steam Add/Repair/Update-artwork/Remove under #292 with the bounded SteamGridDB
capability under #527, the plugin-free Steam Deck baseline under #51/#290, the same
Linux application's updater proof under #52, and unchanged-
reference-client compatibility with independent catalog delivery under #246.
Exact production/platform requalification continues toward 1.0. The cumulative
1.0 contract does not require a universal frontend list, community quota,
marketplace approval, continuous Steam synchronization or Decky. Other optional
frontend profiles remain Post-1.0.

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
