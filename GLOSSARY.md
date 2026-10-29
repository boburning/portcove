# Portcove glossary

<a id="portcove"></a>

This glossary defines Portcove's concepts and distinguishes them from preferred
player wording. [Content design](docs/CONTENT-DESIGN.md) owns communication rules;
the [design system](docs/DESIGN-SYSTEM.md#public-beta-writing-and-terminology) owns
concrete interface labels. Definitions describe current contracts; proposed
names remain explicitly proposed.

Start with [collection and installations](#player-collection-and-storage),
[original files](#game-files), [saves and backups](#installations-and-saved-data),
[releases and updates](#games-ports-and-releases), [setup](#setup-and-readiness)
and [actions and recovery](#review-execution-and-recovery). [Operational
meaning](#evidence-designation-and-permission), [delivery evidence](#delivery-evidence)
and [developer mappings](#developer-mappings) follow.

## Player collection and storage

| Concept                          | Meaning and context                                                                                                                                       | Preferred player wording and example                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Game / original game             | The original title a player recognizes. Its title or artwork does not identify a particular port or installation.                                         | **Game** for play-oriented tasks: “Continue playing {game}.”                                                                                              |
| Port                             | An independently identified native implementation or variant of a game. Several ports can implement one game.                                             | **Port** or **port project** when choosing implementations: “2 ports for this game.”                                                                      |
| Catalog port                     | A catalog entry for an identified port integration. Listing does not establish a runnable release, current-device compatibility or permission to install. | Name the project and its actual setup options, rather than promising every listed port is available.                                                      |
| Original system                  | The hardware for which the original game was made, separate from the port's runtime operating system.                                                     | **Original system**, for example Nintendo 64. Do not infer absent metadata.                                                                               |
| Target platform                  | The operating system and architecture a port targets. A target declaration does not establish compatibility with a particular device or tested gameplay.  | **Platform** or **Runs on**, for example Windows x86-64; explain architecture variants when needed.                                                       |
| Library                          | The selected collection, durable records and managed content. The library identity and port identity distinguish operational context.                     | **Library** for the destination; **Library folder** for its location.                                                                                     |
| Library entry                    | One port's managed, registered external or retained unfinished-setup context in the selected library. Separate ports of one game remain separate entries. | Count **ports**, **entries** or **installations** according to the actual collection. Two projects for one game are two entries, not two different games. |
| Installation                     | A particular local installed or registered instance of a port. It can be managed by Portcove or registered from an existing runtime.                      | **Installation** when a local copy matters: “Choose this installation.”                                                                                   |
| Managed installation             | A port release whose installed files and lifecycle belong to Portcove's supported managed route.                                                          | **Managed by Portcove**, with the actual managed capabilities nearby.                                                                                     |
| Registered external installation | An existing runtime recorded for launch. Registration gives Portcove no file-replacement, backup or deletion ownership.                                   | **Existing installation**; “Updates handled by {project}” or “You manage updates” only when that fact is known.                                           |
| Library folder                   | The chosen location containing Portcove's managed content and records.                                                                                    | **Library folder**, not an original-games folder.                                                                                                         |
| Install folder                   | The location for a particular managed installation; a configured future placement is distinct from an existing installed path.                            | **Install folder** or **Future install folder**, according to the actual path.                                                                            |

Counts name their actual unit. A Discover group can represent one game with two
ports; a Library can contain two installations of that game. Retained previous
and staged versions do not automatically become extra Library entries. Names,
artwork and matching paths never replace library/port identity.

## Game files

| Concept                | Meaning and context                                                                                                                             | Preferred player wording and example                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Game files             | User-supplied original inputs required by a route, separate from saved progress.                                                                | **Game files**; name the ROM, disc image, file set or separately modeled BIOS when its format matters.             |
| Game-file location     | A remembered reference to original files used by one or more ports. Remembering it does not copy or transfer ownership of the files.            | **Saved file location**: “Saved file location could not be checked.”                                               |
| Saved folder           | A remembered folder selected for discovering game files. It is not continuously monitored merely because it was saved.                          | **Saved folder**, not “Watched folder.”                                                                            |
| Managed game-file copy | A copy admitted and stored by the relevant managed-file operation. Using the existing location, copying and moving have different consequences. | Name the actual copy or location in review; **Move** can remove an original only under its owning plan.            |
| Connected files        | Inputs connected in the relevant current, admitted context. A path or record alone is insufficient.                                             | **Files connected** only for that assessed state; otherwise say saved, missing, unchecked, changed or unavailable. |
| Saved-file baseline    | The stored identity against which current bytes can be compared. Matching it does not strengthen the original admission evidence.               | “Game files are unchanged since they were saved,” with actual check scope.                                         |

Portcove checks selected bytes; it does not determine legal provenance. Removing
a saved location removes its registration, not its original files. The
[property checked](docs/CONTENT-DESIGN.md#name-the-property-checked) determines
what a result may claim.

**Game-file observation**: A Core-produced, scope-bound check of connected game
files accepted for specified ports, routes, target platforms and channels at
Core's recorded observation time. Acceptance includes negative and inconclusive
results; it is not a positive file match or permission to operate. Current
classifications require the existing context and freshness checks. Retained
history contains only accepted time, scope and original expiry information and
cannot provide classifications, counts or matching-build evidence.
_Avoid_: File availability guarantee

## Installations and saved data

| Concept               | Meaning and context                                                                                                                              | Preferred player wording and example                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Game saves            | Game progress and related player data, separate from original game files.                                                                        | **Saves** when progress is the actual scope.                                                                                                           |
| Saves and settings    | Saves and configuration within the named operation's declared scope.                                                                             | **Saves and settings** for that data scope; **Saves & backups** for the detail destination.                                                            |
| Saved data            | The broader declared persistent files, potentially including settings, bindings and applicable mods. Management follows the route and operation. | **Saved data** when more than saves are included: “Open saved data folder.” Explain the actual covered files.                                          |
| Backup                | A recorded snapshot of the selected managed saved-data scope. Restore preconditions and any checked inventory/content belong to that snapshot.   | **Back up now** starts an eligible backup; **Review backup** opens an existing review. “Backup history unavailable” is distinct from “No backups yet.” |
| Metadata export       | Exported library records and references, with an inventory of separate payload roots. It does not include those payload trees.                   | **Export library metadata**, distinct from a game-save backup.                                                                                         |
| Library recovery copy | The metadata and separately copied payload roots needed for the owning library recovery route.                                                   | **Library recovery copy**, distinct from a metadata-only export or a saved-data snapshot.                                                              |

Do not promise all user files or cross-version save compatibility. A retained
snapshot is not proof of an exercised restore. See [library recovery](docs/UPGRADING.md)
and [CLI transfer tasks](docs/CLI.md).

## Games, ports and releases

| Concept                      | Meaning and context                                                                                                                                                                                    | Preferred player wording and example                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port release                 | A release of one port resolved by its release provider. A version/tag alone does not identify the artifact bytes.                                                                                      | **Version** in a selected installation; **release** when choosing a project release.                                                                                                          |
| Release provider             | The mechanism resolving a port release, such as GitHub releases or a pinned direct manifest. It is separate from the publisher and channel.                                                            | Name the project/download where useful; retain provider detail in technical contexts.                                                                                                         |
| Release channel              | A project's selected stream. Stable is its stable stream; Preview its preview/testing stream; Rolling its continuously updated stream.                                                                 | **Release channel: Stable / Preview / Rolling**. Rolling does not mean unstable; none guarantees quality, security, gameplay or Portcove qualification.                                       |
| Portcove application release | A release of Portcove itself, with its own installer, updater, stage and trust contract.                                                                                                               | **Portcove update**. Portcove's Public beta stage is separate from a port's Preview channel.                                                                                                  |
| Catalog update               | An update to port definitions, not an installation/update of every listed port.                                                                                                                        | **Catalog update**, separate from **Game updates** and application updates.                                                                                                                   |
| Active installation          | The managed version selected for launch. Selection still requires current Core checks at launch.                                                                                                       | **Current version** or **Installed version**.                                                                                                                                                 |
| Previous installation        | The prior managed version retained in Core's rollback history, if it still exists.                                                                                                                     | **Previous version**; its presence does not guarantee rollback or save compatibility.                                                                                                         |
| Retained archive             | A completed acquired download kept for a later preparation/install review. It is not yet a checked staged installation merely because its bytes were downloaded.                                       | **Archive downloaded** when the acquisition owner reports completion; unfinished downloads keep their progress/recovery state.                                                                |
| Staged installation          | A checked managed release retained locally for later activation, distinct from an unfinished download or the active version.                                                                           | **Update saved for later** for the retained version. **Downloaded for later** needs established download facts; reuse does not perform a new transfer. Activation still needs current checks. |
| Update policy                | The saved notify, keep-for-later or automatic-install preference for a managed port.                                                                                                                   | Describe the actual saved preference separately from a one-off action.                                                                                                                        |
| Immediate update             | A reviewed update that checks and applies the eligible version, downloading only when needed.                                                                                                          | **Update now** for the intention; **Review update** when opening its review.                                                                                                                  |
| Download for later           | An intention to retain a download or prepared version for later while keeping the active version. The actual review distinguishes archive-only acquisition from preparation and may reuse local bytes. | **Download for later**, not an unfinished download or an applied update.                                                                                                                      |
| Keep current version         | A one-time choice not to apply a reviewed release now.                                                                                                                                                 | **Keep current version** does not change saved policy or skip future notices.                                                                                                                 |
| Skipped release notice       | Notice suppression for an exact release identity in the selected library and port, currently version plus artifact digest.                                                                             | **Skip this version**, with the exact-download scope explained. A rebuilt release with different bytes can appear again; installed/staged files and policy are unchanged.                     |
| Paused update notices        | Notice suppression for the selected library and port until resumed. Checks and updates remain available.                                                                                               | **Pause update notices**, not “Pause updates,” “Pause downloads” or “Pin version.”                                                                                                            |
| Pinned version               | A distinct version-following constraint. Notice suppression and a one-off keep-current choice are not a pin.                                                                                           | Do not present a pin control as implemented by those existing choices; exact historical version selection is separately owned by [#40](https://github.com/boburning/portcove/issues/40).      |

The [design system](docs/DESIGN-SYSTEM.md#public-beta-writing-and-terminology)
records actual update controls. An available download, retained checked version,
partial download and activation in progress are different facts.

## Setup and readiness

Setup, launch eligibility and verification are independent dimensions supplied by
the owning assessment. Installing a runtime or launching once does not prove its
game data is configured. These labels communicate facts; they are not a new state
machine or permanent rules keyed by port ID.

| Wording                         | Applicable meaning                                                       | Example or limit                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs game files                | Required original inputs are missing for the selected route.             | Name the file and offer its existing selection/review route.                                                                                                                                  |
| Setup needed                    | The selected route has known setup work remaining.                       | Keep known setup visible even if the runtime can launch to finish it.                                                                                                                         |
| Finish setup in {project}       | Setup is performed by the named upstream runtime/project.                | A launch action may say **Launch to finish setup** when it actually opens configuration.                                                                                                      |
| Ready to play                   | The relevant current launch assessment permits ordinary play launch.     | This is not tested-gameplay evidence.                                                                                                                                                         |
| Ready to launch                 | Launch is permitted but the next runtime task can be configuration.      | Explain the known first-run task beside the action.                                                                                                                                           |
| Setup not verified              | The relevant setup check has not established completion.                 | Do not equate a user's setup statement, absent data or a remembered path with a completed check. Retain more precise supplied states.                                                         |
| Update available                | An applicable successful check found an eligible update.                 | Keep earlier observations labeled as earlier.                                                                                                                                                 |
| Downloaded for later            | A checked release is retained for later activation.                      | Do not use for partial downloads or merely available releases.                                                                                                                                |
| Applying update                 | Activation/application is actually in progress.                          | A request or downloaded file alone does not establish this.                                                                                                                                   |
| Up to date                      | A successful applicable check found no eligible update within its scope. | Prefer **No update found at last check** for the current retained observation.                                                                                                                |
| Not checked / Check failed      | A check was not performed, or an attempted check failed.                 | Neither is up to date. Keep unavailable, changed, missing and stale distinct too.                                                                                                             |
| No original game files required | Explicit route evidence establishes that no original inputs are needed.  | Absent declarations mean **Requirements not available** or **Check project requirements**. The current qualified **No files to add in Portcove** does not make an upstream requirement claim. |

## Review, execution and recovery

| Concept                  | Meaning and context                                                                                                                                          | Preferred player wording and example                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan or preview          | A proposed operation with actual targets, consequences and preconditions; reading it applies nothing.                                                        | **Review installation / Review setup / Review update** when the next action opens the existing review.                                                          |
| Execution                | Performing the reviewed operation under its existing consent and freshness contract.                                                                         | **Install / Start setup / Apply update** only when that is the operation performed. Do not add another review merely to standardize a label.                    |
| Installed-file check     | The current Check installed files operation checks the full recorded installation manifest. Separate launch checks can cover a narrower launch-critical set. | **Check installed files**; its result names which scope was checked.                                                                                            |
| Restore previous version | Recovery of retained installed code/content through the owning rollback operation.                                                                           | **Restore previous version**, distinct from restoring player data.                                                                                              |
| Restore backup           | Recovery of the recorded saved-data snapshot under its restore preconditions.                                                                                | **Restore backup**, naming the snapshot and covered data.                                                                                                       |
| Restore library copy     | Recovery of a library's records and required payload roots.                                                                                                  | **Restore library copy**, not a metadata-only import or saved-data restore.                                                                                     |
| Uninstall                | Removal of managed installed files under the reviewed removal plan.                                                                                          | **Uninstall** for the managed target. State actual retained/deleted data before confirming.                                                                     |
| Remove registration      | Removal of a record/reference to an existing external installation.                                                                                          | **Remove from library / Remove saved location** for that target; registration grants no deletion ownership.                                                     |
| Steam shortcut           | A launch integration object in Steam, separate from an installation and its management ownership.                                                            | **Steam shortcut**; **Review Steam shortcut** opens its existing add/repair/remove review. **Add to Steam** is appropriate when that is the actual next action. |
| Cancellation request     | A request to stop at supported boundaries. Acknowledgment does not prove work stopped or cleanup completed.                                                  | **Cancel** requests; **Cancelling** describes unsettled work.                                                                                                   |
| Terminal outcome         | The authoritative result and its committed, retained, recovery-required or unknown consequences.                                                             | **Cancelled** only for that settled result; retained recovery facts remain visible.                                                                             |
| Interrupted recovery     | Continuation/reconciliation under the owning journal, identities, locks and phase rules.                                                                     | Name **Retry**, **Resume** or **Remove unfinished files** only for the supported action. Retained files are not automatically disposable.                       |
| Dismiss notice           | Hiding the notice, independent of the operation.                                                                                                             | **Dismiss notice** does not cancel, resume or clean work.                                                                                                       |

Controls and results follow [content design](docs/CONTENT-DESIGN.md#controls-confirmations-and-shortcuts).
Core owns durable library operations/recovery; Tauri owns native consent and
application replacement; React owns presentation. Logs, progress and client caches
never become another durable authority.

## Evidence, designation and permission

| Term                           | Meaning and limit                                                                                                                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog designation            | The catalog's declared category for a port. The current type/field is `SupportTier` / `support_tier`; its stable/beta/rolling values do not replace platform qualification, current readiness or operation permission. `CatalogDesignation` is a proposed name, not a shipped type.    |
| Qualification or test evidence | A recorded method and result for identified source/artifact, platform, operation and environment. Automated checks, direct application observations, gameplay and physical-device observations establish different properties. An old platform summary is not a current-binary result. |
| Observation                    | Facts returned by a particular check, within its stated scope and time. An unavailable or unperformed check is unknown, not a failed check or an inferred pass.                                                                                                                        |
| Assessment                     | Core's interpretation of relevant facts for a requested route or operation. A rendered assessment can become stale; execution still takes the required locks and revalidates current state.                                                                                            |
| Permission or authorization    | Authority to perform the particular operation under its current contract, including required review, consent and freshness. Discovery, a catalog entry, a stored record or a green presentation does not supply it.                                                                    |
| Readiness                      | Whether the requested setup or launch route can proceed under current Core checks. Optional missing gameplay evidence does not by itself create an execution hold; a known mandatory failure retains its owning refusal.                                                               |
| Publisher trust                | An explicit trust decision about an authority/key and its allowed role. Official/community/local origin, a valid signature and artifact integrity remain separate facts.                                                                                                               |

Use the [verification wording table](docs/CONTENT-DESIGN.md#name-the-property-checked)
for exact claims. [Catalog qualification](docs/CATALOG.md#channels-support-and-qualification),
[signed catalogs](docs/SIGNED-CATALOG.md) and [application updater trust](docs/UPDATER-TRUST.md)
retain their own admission rules. A glossary entry cannot promote catalog support.

## Delivery evidence

**Retained input**: A preserved copy of declared input bytes, identified at a recorded observation time. Its existence does not establish that execution consumed those bytes.
_Avoid_: Execution proof

**Build-input fingerprint**: A comparison identity for the effective inputs observed for a product build. Its completeness is a separate property.
_Avoid_: Source-head identity

**Product-artifact identity**: The identity of the actual product bytes and required resources being observed or executed.
_Avoid_: Build-input fingerprint

**Harness identity**: The identity of the declared scenario implementation and helper inputs.
_Avoid_: Product identity

**Execution/qualification binding**: The relationship between observed execution and its product, harness, runtime, fixtures, initial state, requirements and acceptance criteria.
_Avoid_: Acceptance authority

**Runtime capability observation**: An observation of an exposed runtime capability under stated conditions. API absence, access restriction, exposed devices and injected or physical behavior are distinct observations.
_Avoid_: Hardware qualification

**Settled visual capture**: A scenario-bound image of an intended visible target after its semantic readiness condition, accompanied by application-state and viewport observations.
_Avoid_: Screenshot existence

**Acceptance packet**: A bounded collection of bindings, requirements and evidence with preflight and completed stages. It records observations and review without granting acceptance or merge authority.
_Avoid_: Approval token

**Preflight packet**: Frozen prospective execution and review bindings. It does not claim future outcomes or images.
_Avoid_: Completed evidence

**Completed packet**: Actual outcomes and retained artifacts bound to process closure, exact-image inspection, separate review and final delivery. It records evidence without granting acceptance or merge authority.
_Avoid_: Acceptance authority

## Developer mappings

Player concepts do not rename implemented types. Managed installations use
`InstallRecord`; registered external installations use `ExternalRuntimeRecord`.
The broad player concept **installation** does not give the external record the
managed record's ownership or capabilities. Current release structures include
`PortDefinition`, `ReleaseSpec`, `ReleaseSource`, `ReleaseAsset`, `ResolvedRelease`,
`ScopedResolvedRelease` and `ReleaseChannel`; the resolver is `ReleaseProvider`.
See [catalog policy](docs/CATALOG.md) and [Core ownership](docs/ARCHITECTURE.md#find-the-owning-boundary).

Human channel labels are Stable / Preview / Rolling. Serialized fields keep
`stable` / `beta` / `rolling`. Current CLI channel input prefers `preview` and
accepts `beta` as a compatibility alias; this glossary does not rename fields,
flags or command contracts.

**Review fingerprint**: The exact identity/hash binding an operation's reviewed
plan or state. A hash is not consent; execution verifies current authorization
and facts.

**Consent**: Approval for an identified action and consequences. A changed target,
plan or relevant state requires the owning fresh-review path; old consent does
not authorize translated work.

**Authenticated historical representation**: Original versioned bytes admitted
through applicable historical authentication/codec rules and projected for
current use. Rewriting them with today's serializer does not prove original
authenticity.

### Game files, inspection and registration

Current `SourceInspectionReport` separates observed inspection, a possible
registered record, health, applicability, evidence and a next action. Current
`SourceRecord` is also used for a not-yet-committed replacement inside
`SourceRelinkPlan`: `original` is registered, while `replacement` is inspected
planning data until the reviewed relink commits. The Rust type name alone
does not prove registration. See [source inspection](crates/portcove-core/src/source_report.rs)
and [relink ownership](crates/portcove-core/src/source.rs).

The accepted naming direction below is **proposed**, owned by
[#1686](https://github.com/boburning/portcove/issues/1686). These types and renamed
commands are not introduced by this documentation:

| Proposed term                | Meaning                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SourceCandidate`            | Unregistered observed or inspected input, with evidence identifying what was checked and within which scope. Discovery and inspection do not register it automatically. |
| `SourceRegistrationProposal` | Prepared internal registration data where the write boundary needs that concept. It is not an additional public workflow or an assertion that a write happened.         |
| `SourceRegistrationRecord`   | A registration committed to the library. It does not assert current presence, unchanged bytes, compatibility with every port or permission to install.                  |

A stored identity is the registration baseline. `SourceHealth::Current` means
the checked storage bytes still match that baseline; it does not strengthen an
informational or extension-only profile into exact-edition evidence. `Missing`,
`Unreadable`, `Changed`, `NotChecked`, `NotBaselined` and `Unregistered` have
different meanings. Preserve the supplied scope rather than collapsing them
into a single supported/unsupported label.

The [domain decision record](docs/adr/0005-distinguish-source-observations-and-registration.md)
records the proposed cutover and compatibility boundaries. Use current commands
from [CLI documentation](docs/CLI.md) until that migration is delivered.

## Delivery language

Implemented, checked, merged, qualified and released are separate claims. Name
the source or artifact and the evidence supporting each. A fixture proves its
tested contract, not an installed application, physical device or gameplay.
Current issue/Project planning and the [agent](AGENTS.md),
[quality](docs/QUALITY.md) and [contribution](docs/CONTRIBUTION-CONVENTIONS.md)
contracts own work selection, review and delivery; this glossary is not a status
ledger or an extra acceptance gate.
