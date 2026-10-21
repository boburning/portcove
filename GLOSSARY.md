# Portcove glossary

<a id="portcove"></a>

Use this glossary to distinguish domain objects, evidence and authority. It
describes the current contracts unless a section explicitly says **proposed**.
Player wording follows the task: “Game files” or “Saved file location” can be
clearer than a developer type name. [Content design](docs/CONTENT-DESIGN.md)
owns how those meanings appear in messages and controls.

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

## Game files

**Game-file observation**: A Core-produced, scope-bound check of connected game
files accepted for specified ports, routes, target platforms and channels at
Core's recorded observation time. Acceptance includes negative and inconclusive
results; it is not a positive file match or permission to operate. Current
classifications require the existing context and freshness checks. Retained
history contains only accepted time, scope and original expiry information and
cannot provide classifications, counts or matching-build evidence.
_Avoid_: File availability guarantee

## Player collection and storage

**Game**: The original title a player recognizes. More than one port can implement the same game.
_Avoid_: Port project

**Port**: An independently identified native implementation or variant of a game.
_Avoid_: Original game

**Library entry**: One port's installed, external or retained unfinished-setup context in the selected library. Separate ports for one game remain separate entries.
_Avoid_: Unique game

**Game-file location**: A remembered reference to original files used by one or more ports. Remembering the location does not itself copy or transfer ownership of those files.
_Avoid_: Game saves

**Saved folder**: A remembered folder selected for discovering game files. Saving it does not establish continuous monitoring or current verification.
_Avoid_: Watched folder

**Game saves**: Game progress and related player data, separate from original game files.
_Avoid_: Game-file location

**Library folder**: The chosen location containing Portcove's managed library content and records.
_Avoid_: Original-games folder

## Games, ports and releases

| Term                         | Meaning and limit                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original game                | The game a port implements. Its title or artwork does not identify one runnable port, release or local installation.                                                                                                                     |
| Catalog port                 | One runnable native-port integration identified by its catalog port ID. Several ports can implement the same original game. Names and artwork are presentation, not replacement identifiers.                                             |
| Port release                 | A release of that specific catalog port, resolved through its release provider. A displayed version/tag alone does not identify bytes: an artifact also has a filename, size and digest.                                                 |
| Portcove application release | A release of Portcove itself. Its installer, updater, release stage and trust contract are separate from a game's release or update.                                                                                                     |
| Library                      | The selected Core-owned collection, durable records and managed content. Operational context includes the library identity and catalog port ID; a matching title, path or version in another library does not supply the same authority. |
| Release provider             | The mechanism that resolves a port's release, such as GitHub releases or a pinned direct manifest. It is separate from who published the artifact and which channel is selected.                                                         |
| Release channel              | A selected port stream: human **Stable / Preview / Rolling**, with compatible values `stable` / `beta` / `rolling`. A channel is not a quality score or evidence of gameplay. Application Public beta is a separate release-stage term.  |
| Update policy                | The saved notify, stage or automatic-install preference for a managed port. A preference is not a completed update, and a one-off reviewed action does not implicitly change it.                                                         |

Current structures include `PortDefinition`, `ReleaseSpec`, `ReleaseSource`,
`ReleaseAsset`, `ResolvedRelease`, `ScopedResolvedRelease` and `ReleaseChannel`;
the resolver abstraction is `ReleaseProvider`. See [catalog policy](docs/CATALOG.md)
and [Core ownership](docs/ARCHITECTURE.md#find-the-owning-boundary).

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

## Game files, inspection and registration

**Game files** are user-supplied original inputs required by a route. Name the
actual ROM, disc, file set or separately modeled BIOS when it matters. Portcove
checks selected bytes; it does not determine legal provenance. A saved external
location, a managed copy and an explicitly authorized Move have different
consequences. Removing a saved registration does not mean deleting its original.

Current `SourceInspectionReport` separates observed inspection, a possible
registered record, health, applicability, evidence and a next action. Current
`SourceRecord` is also used for a not-yet-committed replacement inside
`SourceRelinkPlan`: `original` is registered, while `replacement` is inspected
planning data until the reviewed relink commits. **The Rust type name alone
does not prove registration.** See [source inspection](crates/portcove-core/src/source_report.rs)
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

## Installations and saved data

| Term                             | Meaning and limit                                                                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation                     | A managed local installation of a port release, currently represented by `InstallRecord`. Its identity and immutable-file checks are separate from its display version.                                                                                          |
| Active installation              | The managed version currently selected for launch. Being selected does not bypass current source, integrity, preparation or launch checks.                                                                                                                       |
| Previous installation            | The retained prior managed version selected by Core's rollback history. Report whether it actually exists; a previous version does not guarantee save compatibility or a successful future rollback.                                                             |
| Staged installation              | A downloaded/checked managed release retained for later activation. It is not the active version; activation still requires the current Core checks.                                                                                                             |
| Registered external installation | An existing runtime whose location and checked contract are recorded for launch. Registration does not give Portcove ownership of its files or imply managed updates, backup or deletion.                                                                        |
| Saved data                       | The port's declared persistent files, such as saves, settings, bindings and applicable mods. Scope follows the catalog and actual operation; do not promise all user files or version compatibility.                                                             |
| Backup                           | A recorded snapshot of the selected managed saved-data scope. Name any verified inventory/content property and the actual restore preconditions; “backup” alone is not proof that recovery has been exercised.                                                   |
| Metadata export                  | Exported library records and references. Metadata alone is not a copy of game files, managed applications, saved data or other payload trees. Its content-root inventory identifies the separate payload folders that must be copied alongside it for a restore. |

See [library ownership and recovery](docs/ARCHITECTURE.md),
[CLI transfer tasks](docs/CLI.md) and [upgrade safety](docs/UPGRADING.md).

## Review, execution and recovery

| Term                                    | Meaning and limit                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan or preview                         | A proposed operation with its actual target, consequences and preconditions. Reading it does not apply it.                                                                                                          |
| Review fingerprint                      | The exact identity/hash used by an operation's existing contract to bind a reviewed plan or state. A hash is not consent; execution still verifies the required authorization and current facts.                    |
| Consent                                 | Approval for the identified action and consequences. A changed target, plan or relevant library state requires the owning fresh-review path; old consent cannot authorize translated work.                          |
| Cancellation request                    | A request to stop at supported boundaries. Its acknowledgment does not prove work has stopped, no changes occurred or cleanup completed.                                                                            |
| Terminal outcome                        | The authoritative operation result, such as succeeded, failed or cancelled, together with its committed, retained, recovery-required or unknown consequences. A UI dismissal or lost response is not a result.      |
| Interrupted recovery                    | Continuation or reconciliation under the owning journal, identities, locks and phase-specific rules. Retained files are not automatically disposable; ambiguous output never authorizes replay.                     |
| Authenticated historical representation | Original versioned bytes admitted through the applicable historical authentication/codec rules, then projected for current use. Rewriting them with today's serializer is not proof of their original authenticity. |

Core owns durable library operations and recovery. Tauri owns native consent and
Portcove application replacement; React owns presentation. Runtime logs, progress
events and client caches do not become another durable state authority.

## Delivery language

Implemented, checked, merged, qualified and released are separate claims. Name
the source or artifact and the evidence supporting each. A fixture proves its
tested contract, not an installed application, physical device or gameplay.
Current issue/Project planning and the [agent](AGENTS.md),
[quality](docs/QUALITY.md) and [contribution](docs/CONTRIBUTION-CONVENTIONS.md)
contracts own work selection, review and delivery; this glossary is not a status
ledger or an extra acceptance gate.
