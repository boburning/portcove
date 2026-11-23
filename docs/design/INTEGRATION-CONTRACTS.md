# Supported capability contracts as the unit of integration (design, November 23, 2026)

> **Status: PROPOSED design, revision 2.** Nothing here is implemented or
> activated. The [catalog contract](../CATALOG.md#integration-ownership), the
> [definition delivery contract](../DEFINITION-DELIVERY.md) and the
> [architecture](../ARCHITECTURE.md) remain the current contracts until each
> step below lands through its own pull request.

- **Owning work:** [#1422](https://github.com/boburning/portcove/issues/1422)
  (dynamic native ports program; batch 1 "Contracts" in the lead's mechanism
  map of 2026-11-23) and [#921](https://github.com/boburning/portcove/issues/921)
  (definition delivery and retained installed contracts).
- **Source:** `main` at `f8799fb31`.
- **Merged since revision 1:**
  [#8622](https://github.com/boburning/portcove/pull/8622) (external-profile
  policies bound to the definition's own identity; step 1), merged as
  `f8799fb31`. It removed 12 compiled pins and kept two (Dune Dynasty,
  fheroes2) in `reviewed_subject` (`native_external_profile.rs:173-183`).
- **Still in flight** (open, not merged at `f8799fb31`); this document builds
  on them:
  - [#8618](https://github.com/boburning/portcove/pull/8618) (Open Surge and
    CVLoD path-policy pins; test-only `cfg` items counted as tests)
  - [#8625](https://github.com/boburning/portcove/pull/8625) (family-generator
    shorthands expanded by declared fields, not repository literals)
- **Line numbers:** every file:line citation refers to `f8799fb31`. Core paths
  are relative to `crates/portcove-core/src/` unless stated otherwise.

**Revision 2** applies an independent review (verdict: adopt with changes). It:

- narrows the [frozen fence](#declared-frozen-historical-recovery) to regions
  entered only through a guard predicate on a retained key, and moves the
  `#direct` registry out of the fence, because a current definition reads it;
- adds a [retained compatibility encoding](#retained-compatibility-encoding)
  so no existing install changes identity when its definition migrates;
- states the security rules of C3 and the role effects of C4 normatively;
- replaces the "call Core through the CLI" route with a
  [Rust-verified generated table](#maintenance-scripts);
- adds the transport and script consumers of `external_profile_policy`;
- corrects C2 parity, the materialization count (59), and IC-4's schema class;
- settles five open items (removal reads the current catalog; auto-update
  hold scopes are persisted; no CLI binary in node tests; no static
  call-graph proof; CorsixTH needs no `USERNAME`), and finds one more
  byte-bound pin (G-Diffuser) for C7;
- re-measures the gate with the two open pull requests merged locally.

## Contents

1. [Owner direction and how this design answers it](#owner-direction-and-how-this-design-answers-it)
2. [Measured starting point](#measured-starting-point)
3. [The five distinctions in today's code](#the-five-distinctions-in-todays-code)
4. [Contract map](#contract-map)
5. [Proposed contracts](#proposed-contracts)
6. [What must remain Core code](#what-must-remain-core-code)
7. [Installed state and the read/migration boundary](#installed-state-and-the-readmigration-boundary)
8. [Declared frozen historical recovery](#declared-frozen-historical-recovery)
9. [One capability assessment](#one-capability-assessment)
10. [Compatibility and rollout order](#compatibility-and-rollout-order)
11. [Implementation breakdown](#implementation-breakdown)
12. [Alternatives rejected](#alternatives-rejected)
13. [Open risks and unknowns](#open-risks-and-unknowns)

## Owner direction and how this design answers it

The owner's direction, quoted in full:

> Make supported capability contracts the unit of integration. Trace the
> remaining title-specific behavior and identify the missing concepts that force
> Core to recognize a particular game, repository, executable name, or release.
> Examples from the audit include process-handoff behavior, generated-data
> ownership, external save locations, root resolution, and artifact-specific
> restrictions. Represent reusable behavior through small, explicit, versioned
> contracts covering: acquisition and release selection; original-file
> requirements and preparation; runtime layout and launch; runtime replacement
> ownership; saves, settings, and generated data; mods and extension mechanisms.
> Core implements and validates supported combinations. Definitions supply the
> facts that select those behaviors. Keep composition within reviewed
> capabilities and valid combinations. Preserve the distinction between: 1.
> observed upstream facts; 2. reviewed integration behavior; 3. current
> operation eligibility; 4. exact installed state; 5. qualification evidence at
> its stated scope. Missing optional evidence must not become a blanket refusal
> of unrelated operations. Observations must not independently authorize
> installation or reinterpret existing installations. Completion test: an
> unfamiliar game identity whose requirements fit existing capabilities can use
> those capabilities through data without a title-specific Core branch. A
> genuinely new mechanism receives a reusable Core extension. Update actual
> authoring, generation, validation, runtime, and retained-state consumers
> together. Replacing a title literal with another identifying literal is
> insufficient.

Each part of the direction maps to a concrete proposal:

| Direction                                                                               | Proposal in this document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability contracts are the unit of integration                                        | Every proposed contract is a named, versioned definition feature in Core's existing registry (`definition_capabilities.rs:42-100`). It has a closed typed shape, a validator and a retained-contract representation ([contract map](#contract-map)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Trace remaining title-specific behavior                                                 | [Measured starting point](#measured-starting-point) lists the identities that fail the retired-authority gate (117 at `f8799fb31`, 56 with the in-flight pull requests merged), with their authority kinds. [Implementation breakdown](#implementation-breakdown) assigns every identity to the pull request that retires its authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The missing concepts                                                                    | Eight concepts:<br>- **Process handoff:** [C1](#c1-process-handoff-launchprocess-handoff-v1)<br>- **Launch environment contributions:** [C2](#c2-launch-environment-contributions-launchenvironment-contributions-v1)<br>- **External roots with typed checks** (covers external save locations and root resolution): [C3](#c3-external-roots-and-typed-checks-nativeexternal-roots-v1)<br>- **Player-data roles** (covers generated-data ownership, save-file role maps and runtime credentials): [C4](#c4-player-data-roles-dataroles-v1)<br>- **Seeded files** (covers managed initialization): [C5](#c5-seeded-files-and-file-signature-checks-stagedseeded-files-v1)<br>- **Shared write scopes:** [C6](#c6-shared-write-scope-stagedshared-write-scope-v2)<br>- **Byte-bound artifact exceptions** (covers artifact-specific restrictions): [C7](#c7-byte-bound-artifact-exceptions-runtimeartifact-exceptions-v1)<br>- **Exact mod-provider bindings:** [C8](#c8-recorded-mod-provider-bindings-library-migration-no-definition-change) |
| Six areas                                                                               | The [contract map](#contract-map) lists the existing contracts and the missing concepts for each area.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Core implements and validates supported combinations; definitions supply facts          | Each contract states what Core validates (adapters, platforms, interaction with other contracts) and what it selects. No contract carries code, paths outside closed bases, shell text or an open check vocabulary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Keep composition within reviewed capabilities                                           | A combination table per contract. Combinations not listed are refused by `Catalog::validate` and by indexed-entry inspection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Preserve the five distinctions                                                          | [The five distinctions](#the-five-distinctions-in-todays-code) gives each distinction's home, its conflations (cited) and the rule its consumers follow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Missing optional evidence is not a blanket refusal                                      | Seven current cases are cited, with the corrected per-operation rule. Pull requests [IC-3a](#ic-3a-retained-operations-do-not-consult-the-current-catalog-cases-4-and-5), [IC-3b](#ic-3b-uploader-continuity-scoped-to-activation-cases-1-2) and [IC-3c](#ic-3c-remaining-refusals-cases-3-6-7) repair them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Observations never authorize installation or reinterpret installs                       | The rule for observed facts. The existing generated-registration path is evaluated against it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Completion test                                                                         | Each contract has an executable scenario: an unfamiliar fixture identity gains and then loses the capability through data alone. Each also has a parity proof over every current entry and a source-absence assertion. #8618 established this pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A genuinely new mechanism receives a reusable Core extension                            | [What must remain Core code](#what-must-remain-core-code) lists the closed check kinds and resolvers that stay Core code and why.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Update authoring, generation, validation, runtime and retained-state consumers together | Each pull request in the [breakdown](#implementation-breakdown) owns all consumers of its contract. A contract with no runtime consumer is not proposed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A replacement literal is insufficient                                                   | Every proposal is checked against this. Proposals rejected for exactly this reason: keying Snap64 on `SNAP_DATA_DIR`, and moving pins into package-shape asset names ([alternatives](#alternatives-rejected)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The owner's constraints also bind this design:

- Rust Core owns policy; CLI and Tauri stay thin.
- Each runtime has one replacement owner.
- Libraries, originals, saves, settings, installation identity, retained
  recovery meaning, trust protections and forward upgrades are preserved.
- Historical storage interpretation sits at a deliberate read/migration boundary.
- Pre-beta coherent schema changes are allowed, with an explicit minimum
  supported preview generation for live catalog updates.
- No scripting language, arbitrary shell hooks, second planner or title-named
  capability variants.
- A new contract, extension point or wire format is added only for a
  demonstrated missing behavior with a real consumer.

## Measured starting point

`node scripts/maintenance-program-view.mts --json` on `f8799fb31`, and on a
local merge of `f8799fb31` with #8618 (`cea9c5863`) and #8625 (`67549c5fb`):

| Gate                | Numerator / denominator (version)            | `f8799fb31`    | With #8618 and #8625 merged |
| ------------------- | -------------------------------------------- | -------------- | --------------------------- |
| `fitting`           | 777 / 1624 (`program-view/in-scope/1`)       | 0.4784         | unchanged                   |
| `retired-authority` | n / 460 (`program-view/in-scope-enrolled/1`) | 343 (117 fail) | **404 (56 fail)**           |

The retired-authority gate reports no unknown kinds. The local merge is a
measurement, not a prediction: the 56 remaining identities are assigned one by
one in the [implementation breakdown](#implementation-breakdown).

Per-kind authority counts at `f8799fb31` (#8622 lowered `core-title-literal`
from 37 entries and 60 identities). The last column gives the count after the
local merge where it differs:

| Kind                                   | State   | Entries | Files | Identities                                    | Members (rows)                                                                                                  |
| -------------------------------------- | ------- | ------- | ----- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `core-title-literal`                   | active  | 35      | 35    | 50 (24 after merge)                           | —                                                                                                               |
| `title-named-core-item`                | active  | 61      | 22    | 33                                            | —                                                                                                               |
| `family-generator-script`              | active  | 14      | 14    | 52 (retired after merge)                      | —                                                                                                               |
| `historical-artifact-registry`         | active  | 26      | 2     | 18                                            | `#dkr` 4, `#direct` 4, `#packages` 7, `#cartridge` 6, `#forbidden_memories_producer` 1, `tool-artifacts.json` 4 |
| `external-profile-policy`              | active  | 18      | 1     | 25                                            | `ExternalProfilePolicy` 18                                                                                      |
| `native-external-profile-module`       | active  | 11      | 11    | 0 (covered through `external-profile-policy`) | —                                                                                                               |
| `managed-initialization`               | active  | 3       | 1     | 4                                             | `ManagedInitialization` 3                                                                                       |
| `prepared-shared-preferences-contract` | active  | 3       | 1     | 2                                             | `PreparedSharedPreferencesContract` 3                                                                           |
| `runtime-data-policy`                  | active  | 2       | 1     | 1                                             | `RuntimeDataPolicy` 2                                                                                           |
| `prepared-runtime-settings-contract`   | active  | 1       | 1     | 0 (`no_catalog_consumer`)                     | `PreparedRuntimeSettingsContract` 1                                                                             |
| `provider-binding-table`               | active  | 2       | 2     | 2                                             | `COMMUNITY_BINDINGS` 1, `GAMEBANANA_BINDINGS` 1                                                                 |
| `qualification-fixture-title-code`     | active  | 2       | 2     | 1                                             | —                                                                                                               |
| `github-mod-source-table`              | retired | 0       | 0     | 0                                             | `SOURCES` (declared retired)                                                                                    |
| `external-mod-portals`                 | retired | 0       | 0     | 0                                             | `external-mod-portals.json` (declared retired)                                                                  |

Catalog facts used below come from `crates/portcove-core/catalog/catalog.json`
(document schema 3):

- 452 operational ports.
- Adapters: native-portable 150, staged-source-portable 133,
  psx-recomp-managed 119, n64-recomp-portable 31, libultraship-portable 8,
  generated-cache 6, upstream-managed-setup 4, referenced-disc 1.
- The published indexed bundle
  (`release/catalog-publication/bundle/definitions/index.json`) holds five
  entries, all at definition schema 1. Two of them, the DUDE Doom 3 entries,
  carry `external_profile_policy: "doom3-linux-v1"` in their projections.
  This affects [rollout order](#compatibility-and-rollout-order).

## The five distinctions in today's code

DEFINITION-DELIVERY already names
[five independent facts](../DEFINITION-DELIVERY.md#identities-and-five-independent-facts)
for one definition: eligibility, trust and origin, artifact integrity,
game-file admission, and scoped evidence. The owner's five distinctions are a
lifecycle-wide axis that cuts across them. This section states where each one
lives, where it is conflated and the rule every consumer follows.

### 1. Observed upstream facts

- **Lives in:**
  - `provider_observation.rs:6-7`: inert, with no acquisition or trust mutation.
  - `route_facts.rs:1-7`: a file name never authorizes; `RouteHold` is at `:230`.
  - `release/observation.rs`: `route_holds` at `:79`, `hold_reasons` at `:455-468`.
  - `release/uploader_continuity.rs`.
  - `listing.compatibility` advisories, consumed by `service/advisories.rs:145`.
  - The maintenance store's upstream observations ([UPSTREAM-OBSERVATIONS](../UPSTREAM-OBSERVATIONS.md)).
- **Conflated in:**
  - **Generated registration** (`scripts/catalog-generated-registration.mts:1-31`;
    route fit calls it "an operational definition produced from observed
    facts", `scripts/catalog-route-fit.mts:38-40`). Observed package facts
    become an operational user-selected registration route at authoring time.
    This is not a runtime conflation. The generated definition is reviewed,
    signed catalog data, and the route is non-owning registration, where user
    selection establishes execution intent. But the generator also _withdraws_
    the route when a fact stops holding (`:12-13`). Withdrawal is correct for
    _offering_ a new registration. It must never reach existing registrations;
    see the rule below.
  - **Uploader-continuity observations gate retained-build operations**
    (`release/uploader_continuity.rs:288-297`). The evidence path is listed
    under [blanket refusals](#where-missing-optional-evidence-becomes-a-blanket-refusal-today), case 1.
- **Rule:** an observation may:
  - propose a candidate to authoring;
  - hold _offering a new acquisition_ when it contradicts reviewed facts;
  - appear as an advisory.

  It never selects behavior for, re-scopes, or holds operations on an existing
  installation or registration. Those read the retained contract.

### 2. Reviewed integration behavior

- **Lives in:**
  - `PortDefinition` (`types.rs:994ff`), in signed/embedded catalog data.
  - Indexed definition entries (`definition_entry.rs:28-44`) with the named
    feature registry (`definition_capabilities.rs:42-100`, 57 features).
  - `ReviewedLaunchContractV1` (`reviewed_launch_contract.rs:9-25`).
  - The typed acquisition restrictions (`acquisition_restriction.rs`).
- **Conflated in:** reviewed behavior is still partly _compiled_, so Core code
  rather than data carries the review. These are the clusters this design
  retires:
  - 18 `ExternalProfilePolicy` variants (`types.rs:908-927`).
  - Identity pins in `launch.rs:24-30`, `runtime_path_policy.rs:288-293`,
    `preparation_execution.rs:775-777`, `managed_shared_preferences.rs:307-315`,
    `native_portable_data.rs:217-226` and `adapter.rs:289-302`.
  - Compiled save-role and loader tables: `portable_saves.rs:89-107` and
    `profile_loader.rs:120-130`.
- **Rule:** reviewed behavior is selected only by typed definition fields
  validated by a named feature. Core code may implement a mechanism, but it may
  not decide _which entries_ receive it except through those fields.

### 3. Current operation eligibility

- **Lives in:**
  - `evaluate_definition_eligibility` (`definition_eligibility.rs:207-263`),
    route exclusion (`:266-315`) and `PortActionAssessment` (`:144`).
  - `acquisition_restriction.rs`.
  - Per-mutation gates in `service.rs` (install `:1683`, adopt `:5408-5410`,
    activation `:7432-7445`) and `service/launch_preparation.rs:68-88`.
- **Conflated in:** the status pipeline computes eligibility in four stages
  (`service.rs:1181-1261`). Each mutation then re-derives it with separate code
  ([one capability assessment](#one-capability-assessment)). The current
  catalog is also consulted for operations that belong to installed state; see
  distinction 4.
- **Rule:** eligibility is a pure function of (operation, subject,
  operation-specific authorities). The authorities for an operation on an
  existing installation are its retained contract and local integrity. The
  current catalog contributes only to offering _new_ acquisitions, updates and
  explicit successor selection. Mutations call the same function they were
  assessed with.

### 4. Exact installed state

- **Lives in:**
  - `InstalledContract` (`installed_contract.rs:75-91`): formats 1-3 base,
    with wrapper formats 4-12 fencing older readers (`:225-262`).
  - Stored in `.portcove-manifest.json` (`install.rs:677-692`).
  - Identity: `RetainedBuildIdentity.installed_contract_sha256`
    (`retained_build.rs:33-43`).
  - `InstallRecord` and the non-owning registration rows.
- **Conflated in:**
  - `installed_catalog_or_fallback` uses `self.catalog.clone()` for a legacy
    install without a retained catalog, and refuses if the current port gained
    policy fields (`service.rs:7550-7577`).
  - `checked_installed_mutability_port` borrows current-catalog paths
    (`service.rs:7500ff` → `installed_mutability.rs:86-188`), and
    `profile_persistent_paths` reads current `persistent_paths`
    (`service.rs:7581-7594`).
  - Rollback, backup create/list/preview/restore and `prepare_launch` all
    require the port in the _current_ catalog: `self.catalog.port(port_id)?` at
    `service/backups.rs:659`, `:917`, `:927`, `:1410`, `:1516`, `:1637` and
    `:1874`, and `service.rs:4942`, `:4986-4997` and `:7017`. Ordinary launch
    uses `catalog_for_installed_fallback` instead (`service.rs:6163`,
    `:1137-1170`), so the two paths disagree.
- **Rule:** an existing installation is interpreted only by its own retained
  contract, read at the boundary in
  [the read/migration boundary](#installed-state-and-the-readmigration-boundary).
  Where no retained contract exists (pre-schema-6 manifests), the frozen
  historical reader supplies one. The _current_ catalog is never a substitute.
  Departure of a port from the current catalog withholds new acquisition
  only. Backup, restore, rollback to a retained build, launch of a retained
  build and removal stay governed by retained state and local integrity.

### 5. Qualification evidence at its stated scope

- **Lives in:**
  - `SourceCatalog.qualification` and `assess_qualification`
    (`source_catalog.rs:21-25`, `:669-687`; report-only at
    `target_inspection.rs:697`).
  - `support_tier`, `automated_tested_platforms` and
    `manually_validated_platforms` (validated only at `catalog.rs:1555-1572`).
  - `qualification_checkpoint.rs:1-2`: receipts are observations, never
    operation authority.
  - Dated records in `docs/qualification/`.
- **Conflated in:** nowhere found. Support tier and qualification are
  explicitly excluded from operational compatibility
  (`installed_mutability.rs:208-221`). The scout found no path where unknown
  qualification refuses backup, launch or removal. This is correct and must
  stay so.
- **Rule:** qualification is reported at its stated scope (artifact,
  definition, platform, operation). It selects nothing and holds nothing. An
  operation that needs proof of a behavior proves it through the reviewed
  contract and runtime checks, not through a qualification record.

### Where missing optional evidence becomes a blanket refusal today

Each case lists the missing evidence and the refused operation. Each case also
names the operation that evidence actually concerns, which is the only
operation it should hold.

| #   | Missing or absent evidence                                                                                                                                                   | Unrelated operations refused                                                                                                                                                                                                                                                                                                     | Corrected rule                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No recorded uploader for a build acquired after the baseline (`release/uploader_continuity.rs:288-297`), reached through `require_activation_gates` (`service.rs:7432-7445`) | Rollback (`service.rs:5017-5030`); profile-pinned launch of the _already active_ build (`profile_deploy.rs:2763-2767`); settings recovery (`service/game_settings.rs:573`; `game_settings/activation_deletion.rs:85`); retained-build permission (`retained_build.rs:429`); recovery (`recovery.rs:170`, `:199`, `:874`)         | Uploader continuity is acquisition-trust evidence for _making a not-yet-executed build active_. It keeps holding first activation and rollback to a build that was never active. It does not hold launch of the currently active build or file-only settings recovery. "Never active" is UNKNOWN as a recorded fact; see [risks](#open-risks-and-unknowns). The trust change needs a critical reviewer. |
| 2   | The current catalog narrowed `accepted_uploaders` (`release/uploader_continuity.rs:302-325`, `current.unwrap_or(retained)` at `:304`)                                        | Same as case 1                                                                                                                                                                                                                                                                                                                   | Narrowing is a reviewed revocation, not missing evidence, so it may hold activation of a build from that uploader. It must not reinterpret the retained route for operations that execute nothing.                                                                                                                                                                                                      |
| 3   | No retained contract (pre-schema-6 manifest) for a port whose persistence needs a restore receipt (`service.rs:7618-7630`)                                                   | Backup assessment (`service/backups.rs:1306`, `:1362-1373`); collectible-data review (`:554`); protection (`service/protection.rs:227`); game settings (`service/game_settings.rs:108`); native-portable transitions (`service/native_portable.rs:343-493`); restore deletion (`service/restore_deletion.rs:82`, `:420`, `:473`) | The frozen historical reader supplies the retained interpretation, as `install.rs:4185-4227` already does for DKR. Where none can be established, _whole-directory_ backup (copying everything under the install's owned roots without per-path claims) stays available. Only path-selective operations hold.                                                                                           |
| 4   | Port absent from the current catalog                                                                                                                                         | Backup, restore, rollback, `prepare_launch` and removal (preview `service.rs:5606`, execution `:5716`; see distinction 4)                                                                                                                                                                                                        | Absence withholds new acquisition and successor selection only. Retained operations proceed on the retained contract. The comment at `service.rs:4989-4991` ("a retained contract proves the target's identity, not a newly offered rollback route") is an explicit product decision to revisit: rollback to a retained, already-verified build offers no new route.                                    |
| 5   | Legacy install with no retained catalog where the current port gained policy fields (`service.rs:7559-7574`)                                                                 | Every operation that uses `persistence_contract_for_install`, including backup                                                                                                                                                                                                                                                   | Same as case 3: the historical reader, not the current port.                                                                                                                                                                                                                                                                                                                                            |
| 6   | Shipwright version or asset outside "stable 9.x / `soh-*-win64.zip`" (`installed_mutability.rs:53-83`)                                                                       | Launch mutability qualification (`service/launch_preparation.rs:75`) and backup, through `checked_port` (`:93-99`)                                                                                                                                                                                                               | Retired with [C4](#c4-player-data-roles-dataroles-v1). The role map is read from the retained contract; a version outside a declared version set withholds only progress copy, the one operation the role map's version scope concerns.                                                                                                                                                                 |
| 7   | Ghostship data-compatibility inspection error (`service.rs:3012-3016`, `:4999-5008`; `service/launch_preparation.rs:69`)                                                     | Launch and rollback held with `UnsafeData`                                                                                                                                                                                                                                                                                       | Correct when inspection _found_ incompatible data. An inspection _error_ (unknown) should hold only the data-transforming route. The legacy region is entered only through its retained guard ([fence](#declared-frozen-historical-recovery)); the narrowing is part of [IC-3c](#ic-3c-remaining-refusals-cases-3-6-7).                                                                                 |

Not found, recorded so a later reader does not repeat the search: an unknown
`support_tier` or qualification record, an absent release observation
(`service.rs:3072-3073` explicitly does not infer Update eligibility) or a
missing route fact does not refuse backup, launch or removal. Typed
restrictions exclude removal, rollback and backup by design
(`acquisition_restriction.rs:50-51`, `:79-91`).

**Settled (revision 2):** removal requires the port in the current catalog,
both in `preview_removal` (`service.rs:5606`) and in `remove` (`:5716`), even
though its classification already reads the retained contract
(`service/removal.rs:195-201`). Removal joins case 4.

## Contract map

**Legend.**

- **Exists:** the contract is in the feature registry today.
- **Count:** catalog.json entries whose field would trigger the feature at
  schema 4. No published indexed entry uses schema 4 yet.
- **Feature:** the reader gate. Template minimums come from
  `definition_entry.rs` gates.
- **Missing:** a concept whose absence forces a title branch today, with its
  proposal (C1-C8).

### (a) Acquisition and release selection

Existing contracts:

| Contract (field)                                                                                | Feature (version)                                            | Validator                                                                       | Count                                                 |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `release.provider`, `repository`, `asset_hints`, `rolling_tag`                                  | base                                                         | `Catalog::validate` `catalog.rs:753+`; `validate_github_streams` `types.rs:827` | repository 443, asset hints 345, rolling tag 8        |
| `release.direct` (`DirectReleaseSpec`)                                                          | `native.direct-manifest-v1`                                  | `definition_entry.rs:579-586`                                                   | 6                                                     |
| `release.linux_tar_xz`                                                                          | `native.linux-tar-xz`                                        | `definition_entry.rs:382-386`                                                   | 16                                                    |
| `release.tar_xz_platforms`                                                                      | `release.platform-tar-xz-v1`                                 | `runtime.rs:84`; `definition_entry.rs:387-405`                                  | 10                                                    |
| `release.archive_file_links`                                                                    | `release.archive-file-links-v1`                              | `definition_entry.rs:484-499`                                                   | 22                                                    |
| `release.grant_declared_executable`                                                             | `release.declared-executable-v1`                             | `definition_entry.rs:460-483`; `package_layout.rs:85`                           | 3                                                     |
| Reviewed forge                                                                                  | `release.reviewed-forge-v1`                                  | `definition_entry.rs:269-276`                                                   | 0                                                     |
| Exact exclusions (`managed_acquisition_hold.excluded_artifacts`)                                | `release.exact-exclusions-v1`                                | `managed_runtime_policy.rs:29`; gate `definition_entry.rs:344-352`              | 5 holds, 1 with exclusions                            |
| Typed acquisition restrictions (`integration.acquisition_restrictions`, `listing.restrictions`) | carried by authoring; compiled to `managed_acquisition_hold` | `acquisition_restriction.rs:956` (`validate`)                                   | see [CATALOG](../CATALOG.md#acquisition-restrictions) |
| Reviewed compatibility artifacts (`managed_runtime_applies_to`, `{version,size,sha256}`)        | `runtime.reviewed-compatibility-artifacts-v1`                | `managed_runtime_policy.rs:232`; gate `definition_entry.rs:278-289`             | 0                                                     |

Registry discrepancy, to fix in passing: the feature registry labels exact
exclusions `port.release.exact_exclusions` (`definition_capabilities.rs:48`),
but the field is `managed_acquisition_hold.excluded_artifacts`
(`managed_runtime_policy.rs:7-11`).

Missing concept: **artifact-specific restriction or allowance bound to exact
bytes** ([C7](#c7-byte-bound-artifact-exceptions-runtimeartifact-exceptions-v1)).

| Title branch it forces | Location                           | Literals                                      | Effect                                                                |
| ---------------------- | ---------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Diablo                 | `runtime_path_policy.rs:288-293`   | Port id plus sha256 `ea3aa940…063d`           | Requires a deep bundled-mod path to fit `MAX_PATH` at the destination |
| OpenGOAL               | `preparation_execution.rs:775-777` | Port id plus extractor sha256 `bc2d0718…5cc9` | Tolerates and discards an empty `out/jak1/obj` scaffold               |

Neither sha256 is in catalog.json.

### (b) Original-file requirements and preparation

Existing contracts:

- **`source_profile`, `bios_source_profile` → `source_catalog` contracts.**
  - Counts: 206 and 102 entries. The source catalog holds 314 contracts,
    210 identities, 418 evidence records and 43 qualification records.
  - Validator: `SourceCatalog::validate` (`source_catalog.rs:395`).
  - Projection features: `source.optional-original-recognition-v1`,
    `n64.release-inputs-v1`, `psx.multi-track-disc-set-v1`,
    `source.snes-copier-header-v1` and `tools.psx-toolchain-v1`.
- **`runtime_source_materialization`** (59 entries).
  - Kinds and counts: copy 15, n64-big-endian 10, psx-raw-set 17,
    snes-headerless 5, psx-bin-cue 4, ps2-iso 3, gamecube-iso 2,
    stfs-directory 1, xdvdfs-directory 1, regaiden-gbc 1.
  - Features: `staged.snes-headerless-runtime-v1`, `staged.disc-image-v1`,
    `staged.stfs-package-v1`, `staged.rom-patch-v1` and
    `staged.optional-game-source-v1`.
  - Note: `regaiden-gbc` is a materialization kind named for a title. It
    transforms a GBC ROM for GB Recompiled. It belongs in a C6 follow-up review
    of whether the transform is generic for GB Recompiled; UNKNOWN until its
    implementation is read.
- **Native originals:** `native.original-files-v1`
  (`preparation_source.rs:35`, gate `definition_entry.rs:560-571`).
- **Setup contract:** `setup_executable_hints` 5, `setup_arguments` 4,
  `setup_marker` 6, `setup_output_paths` 5.
  - Validators: `catalog.rs:2276-2336` and `preparation.rs:403`.
  - Features: `native.manual-setup-v1`.
- **Managed initialization:** `staged.managed-initialization-v1`,
  `staged.chocolate-preparation-v1` and `staged.reusable-runtime-policy-v1`.
  4 entries: `chocolate-family-portable-v1` ×3 and
  `tfe-dark-forces-portable-v1` ×1.
- **User-prepared:** `source_directory_environment`
  (`staged.source-directory-binding-v1`) and `settings_contract`
  (`staged.settings-contract-v1`, 0 entries).

Missing concepts:

- **Seeded files with typed signature checks**
  ([C5](#c5-seeded-files-and-file-signature-checks-stagedseeded-files-v1)).
  `managed_chocolate.rs` and `managed_tfe.rs` each write a fixed seed
  (`managed_chocolate.rs:7`, `managed_tfe.rs:10`) and validate a fixed shape:
  - Chocolate pins repository `chocolate-doom/chocolate-doom` at
    `managed_chocolate.rs:66`.
  - Chocolate derives config names and screenshot prefixes from three
    executable names at `:14-46`.
  - TFE checks a pilot file of exactly 14,943 bytes with a fixed header
    (`managed_tfe.rs:11-12`).

  Everything except the seed bytes and the signature check is already
  expressible in existing fields: `launch_arguments`,
  `persistent_file_patterns` and `runtime_source_filename`.

- **The OpenGOAL scaffold tolerance** is a preparation-output allowance bound
  to tool bytes. It is merged into C7 rather than given its own contract.

### (c) Runtime layout and launch

Existing contracts:

| Contract (field)                                                | Feature                                                                    | Count   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| `executable_hints`                                              | base                                                                       | 364     |
| `launch_arguments`                                              | base                                                                       | 171     |
| `launch_environment`                                            | base (prefix-derived names only)                                           | 132     |
| `runtime_subdirectory` / `_by_platform`                         | `staged.runtime-subdirectory-v1`, `n64.platform-runtime-subdirectories-v1` | 124 / 2 |
| `launch_from_install_root`                                      | base                                                                       | 8       |
| `launch_disc_choice`                                            | base                                                                       | 15      |
| `reviewed_package_layouts`                                      | `native.package-layouts-v1`                                                | 146     |
| `windows_runtime_path_policy`                                   | `runtime.windows-path-policy-v1`                                           | 58      |
| `windows_tracked_handoff`                                       | `native.tracked-handoff-v1` (native ≥28)                                   | 8       |
| `linux_packaged_library`                                        | `native.linux-packaged-library-v1`                                         | 2       |
| `portable_marker_file` / `portable_marker`                      | `native.portable-marker-v1`                                                | 8 / 13  |
| `n64_runtime_at_executable_parent`, `n64_windows_initial_d3d12` | `n64.executable-parent-v1`, `n64.initial-d3d12-v1`                         | 1 / 1   |
| `reviewed_launch_contract_v1`                                   | `runtime.reviewed-package-and-launch-v1`                                   | 0       |
| `bundled_runtime`                                               | base                                                                       | 1       |

Missing concepts:

- **Process handoff** ([C1](#c1-process-handoff-launchprocess-handoff-v1)).
  `tracked_handoff_native_capability` returns 35 instead of 28 when
  `port.id == "snap64-recomp"` (`launch.rs:24-30`). At runtime every tracked
  session already starts the Windows job keeper (`launch.rs:127-137`). The pin
  only raises the _declared reader minimum_ so that readers without the keeper
  refuse Snap64. The missing fact is: "the upstream launcher exits before its
  successor joins the session; the session requires an independent job
  holder."
- **Launch environment contribution**
  ([C2](#c2-launch-environment-contributions-launchenvironment-contributions-v1)).
  `adapter.rs:289-302` inserts `USER=PLAYER` for `corsixth-corsixth` because
  "CorsixTH's blank player name expects USER or USERNAME before its own PLAYER
  fallback". The existing `launch_environment` field cannot carry it, for two
  reasons:
  - launch values allow only port-prefixed names or `PYTHONDONTWRITEBYTECODE`
    ([launch value rules](../CATALOG.md#package-and-launch-declaration-compatibility));
  - `validate_layout` forbids any `launch_environment` with an external
    profile (`native_external_profile.rs:198`).
- **Launch-argument injection** for external roots: Doom 3
  `+set fs_configpath`/`fs_savepath` (`native_external_profile/doom3_linux.rs:171-180`),
  vkQuake `-userdir .` (`adapter.rs:424-429`) and JGRPP `-X`
  (`adapter.rs:430-434`). Merged into
  [C3](#c3-external-roots-and-typed-checks-nativeexternal-roots-v1) as a
  check kind, because the injected value is a resolved root.

### (d) Runtime replacement ownership

Existing contracts:

- **Adapter plus provider selects the owner** (`types.rs:134`, `:530`):
  - Managed official package (github/gitlab/direct): Portcove owns replacement.
  - `upstream-managed-setup` (4): the upstream setup tool owns it.
  - `referenced-disc` (1): the player's disc stays in place.
  - `user_prepared` (90 entries, 191 platform records with `trust:
    user-selected`, 2 with `accepted-package`): non-owning registration,
    feature `staged.user-selected-runtime-v1`.
- **`external_profile_policy`** (25 entries, 18 values). This is
  _player-data-location_ knowledge for a Portcove-owned runtime whose upstream
  writes outside Portcove storage. It is not a replacement owner.

Missing concept: none for replacement ownership itself. The one-owner rule is
already structural. External profiles are moved to area (e) as
[C3](#c3-external-roots-and-typed-checks-nativeexternal-roots-v1), because they
describe _where the runtime writes_ and _what Portcove must not own_, not who
replaces the runtime.

### (e) Saves, settings and generated data

Existing contracts:

| Contract (field)                                               | Feature                                                           | Count     |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | --------- |
| `persistent_paths`, `persistent_file_patterns`                 | base                                                              | 361 / 20  |
| `runtime_mutable_paths`, `runtime_mutable_file_patterns`       | base                                                              | 157 / 112 |
| `windows_temp_directory`                                       | `native.temporary-data-v1`, `-siblings-v1`                        | 10        |
| `linux_portable_data_directory`                                | `native.linux-portable-data-v1`                                   | 1         |
| `windows_shipwright_persistence`                               | `libultraship.windows-persistence-v1`                             | 1         |
| `archive_data_compatibility_v1` / `archive_data_transition_v1` | staged 34 policy (`archive_data.rs:20,36`)                        | 4 / 3     |
| `runtime_data_policy`                                          | `staged.runtime-data-policy-v1`                                   | 1         |
| `managed_shared_preferences`                                   | `staged.shared-preferences-v1`                                    | 1         |
| `user_prepared.*.shared_preferences`                           | `staged.shared-write-scope-v1`                                    | 1         |
| `user_prepared.*.required_mutable_files`, `library_user_data`  | `staged.required-mutable-files-v1`, `staged.private-user-data-v1` | 0 / 0     |
| `user_data_environment`, `source_environment`                  | base                                                              | 3 / 5     |
| `game_settings` (`GameSettingsContract`)                       | no named feature; `game_settings.rs:669`                          | 3         |

Missing concepts:

- **External save and profile locations, and root resolution**
  ([C3](#c3-external-roots-and-typed-checks-nativeexternal-roots-v1)):
  - 18 `ExternalProfilePolicy` variants with 11 per-runtime resolver modules
    (`native_external_profile/*.rs`).
  - Identity pins: #8622 (merged) removed 12 of them; Dune Dynasty and
    fheroes2 remain in `reviewed_subject` (`native_external_profile.rs:173-183`).
  - OpenSC2K's external Godot profile and `/tmp/OpenSC2K Autosaves` writes
    (`native_portable_data.rs:217-373`).
- **Generated-data ownership and save-file roles**
  ([C4](#c4-player-data-roles-dataroles-v1)):
  - The `portable_saves.rs` `CONTRACTS` table, with one row keyed on port id
    `shipwright` (`:89-113`).
  - Shipwright's hard-injected persistent paths (`installed_mutability.rs:128-145`).
  - RE Gaiden's graphics-export namespace `asset_dump`
    (`managed_shared_preferences.rs:16`, `:307-315`; `install.rs:2775-2780`,
    `:3879-3900`).
  - RaceWave's `retroachievements.credentials` handling
    (`runtime_data_policy.rs:12`, `:95-114`).
- **Shared preferences** ([C6](#c6-shared-write-scope-stagedshared-write-scope-v2)):
  `PreparedSharedPreferencesContract` has three variants. Two are bound to
  exact historical packages; one is `gbrecompiled-windows-v1`.

### (f) Mods and extension mechanisms

Existing contracts:

| Contract (field)        | Feature                                                                 | Validator                 | Count          |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------- | -------------- |
| `mod_loader`            | `mods.native-loader-binding-v1`                                         | `profile_loader.rs:449`   | 5              |
| `mod_provider_bindings` | `mods.provider-bindings-v1`                                             | `provider_binding.rs:157` | 2              |
| `mod_sources`           | `mods.sources-v1`                                                       | `mod_source.rs:388`       | 7 (10 sources) |
| `mod_package_policy`    | `staged.mod-packages-v1`                                                | `persistence.rs:144`      | 8              |
| Profile recipes         | none (player data, `RECIPE_FORMAT = 3`; format 4 for explicit bindings) | `recipe.rs:34-37`         | n/a            |

Missing concept: **exact recorded binding for installed mod references**
([C8](#c8-recorded-mod-provider-bindings-library-migration-no-definition-change)).

- The definition contracts already exist and both bundled consumers declare
  them.
- The remaining title authority is the compatibility _reader_ for stored
  references whose `binding` is `None`:
  - `provider_binding::legacy_binding` maps them through `GAMEBANANA_BINDINGS`
    (`provider_install.rs:44`) and `COMMUNITY_BINDINGS` (`thunderstore.rs:37`)
    (`provider_binding.rs:33-46`).
- The writer still elides the binding when it equals the legacy one
  (`provider_install.rs:626-629`).
- `legacy_loader` maps port ids to the SHIP and RECOMP loaders when
  `mod_loader` is absent (`profile_loader.rs:120-130`, reached from `:459-470`).
  `native_mod_list::recomp_game` also uses it (`native_mod_list.rs:60-62`).

## Proposed contracts

Every contract below follows the same rules:

- **Closed shape:** `deny_unknown_fields`, closed enums, and bounded lengths
  and counts.
- **Feature gate:** a named feature, gated by
  `require_feature` (`definition_capabilities.rs:157-168`) and a minimum
  template version.
- **Validator:** a validator called from both `Catalog::validate` and indexed
  entry inspection.
- **Retained representation:** a representation in the retained contract.
  Retained contracts already store the exact definition bytes, so they need no
  new installed format unless stated.
- **Combination table:** a table of valid combinations. Anything not listed is
  refused.
- **Completion test** (the executable scenario):
  - an unfamiliar fixture identity (for example
    `unfamiliar-contract-fixture`) gains the behavior through data alone;
  - it loses the behavior when the field is removed or changed;
  - the fixture id is absent from the embedded catalog and from every non-test
    Core file, the pattern established in #8618;
  - the retired pin, table or variant is absent from production Core, and the
    program view reports the kind retired, or its member declared retired.
- **Parity proof:** for every current entry using the old path, the new path
  selects identical behavior. This is a test over the embedded catalog that
  compares the old and new selection functions before the old one is deleted,
  plus the existing per-consumer tests.

### C1. Process handoff (`launch.process-handoff-v1`)

**Fields.** The field `process_handoff` replaces the boolean
`windows_tracked_handoff` in new definitions:

```json
"process_handoff": { "windows": "tracked-successor" | "tracked-successor-after-launcher-exit" }
```

The value set is closed. Absent means no handoff: the session ends when the
spawned process exits.

**Core validates:**

| Rule           | Detail                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapters       | native-portable, n64-recomp-portable or libultraship-portable, the adapters that carry `windows_tracked_handoff` today                         |
| Platform       | Windows x86-64 only, matching `session_job.rs`                                                                                                 |
| Exclusions     | Not combined with `upstream-managed-setup` or user-prepared registration, which have no Portcove-owned job                                     |
| Reader minimum | Derived from the value: `tracked-successor` requires native 28; `tracked-successor-after-launcher-exit` requires native 35 (`launch.rs:19-22`) |

**Selects in Core.** It selects the minimum capability that
`tracked_handoff_native_capability` derives. Runtime behavior is unchanged,
because the keeper already runs for every tracked session.

**Process boundary (normative, unchanged by this contract).**

- The tracked set is the job members whose image lies under the
  installation root (`launch.rs:100-104`). Membership is decided by Core from
  the job object and the image path, never by data.
- Data never names a process, an image, a window or a command line. Neither
  value adds a process to the tracked set or removes one from it.
- Only members of the session's own job can be terminated. Neither value
  grants Portcove authority over any other process.
- `tracked-successor-after-launcher-exit` changes nothing at runtime. It only
  raises the declared reader minimum to 35, so that readers without the
  independent job keeper refuse the definition instead of ending the session
  when the launcher exits.

**Retained contract.** It records the value.

**Read boundary.** A retained definition with `windows_tracked_handoff: true`
reads as `tracked-successor`. The boundary is defined in
[the read/migration boundary](#installed-state-and-the-readmigration-boundary).

**Compatibility encoding.** `operational_compatibility` encodes either value
as today's `"windows_tracked_handoff": true` and encodes absence as absence
(`installed_mutability.rs:369-372`); see
[retained compatibility encoding](#retained-compatibility-encoding). The two
values differ only in the reader minimum, which is not an operational
property of an installation, so Snap64's retained builds compare equal to its
migrated definition.

**Users.** 8 entries. Seven become `tracked-successor`; `snap64-recomp` becomes
`tracked-successor-after-launcher-exit`.

**Retires:**

- `launch.rs:24-30` (the id branch).
- The id literal in the Snap64 library-import reconciliation
  (`library_import.rs:22-42`). The reconciliation itself stays, re-keyed in
  [IC-1](#ic-1-frozen-fence-dkr-legacy-cartridge-and-library-import) on a
  retained key; it is not deleted.

**Accepted** as a new contract. A new value of an existing concept is the
smallest form. The alternative, a second boolean, allows the invalid state
`job_holder && !tracked`.

**UNKNOWN:** whether other tracked-handoff upstreams also exit before their
successor joins. Observing their launch trees settles it. Such an entry
switches its value and gains nothing else.

### C2. Launch environment contributions (`launch.environment-contributions-v1`)

**Fields.**

```json
"launch_environment_contributions": ["default-player-name"]
```

The value set is closed. Each value has one fixed name and value pair defined
in Core, the same on every platform:

| Value                 | Platforms      | Variable set  |
| --------------------- | -------------- | ------------- |
| `default-player-name` | Windows, Linux | `USER=PLAYER` |

This is exact parity with today: `adapter.rs:289-302` inserts `USER=PLAYER`
on both Windows and Linux. The value deliberately does **not** set `USERNAME`
on Windows. `USERNAME` is an account variable that Windows runtimes read to
build paths, which is the hazard that rules out relaxing
`launch_environment` (below). A future runtime that needs a different
variable gets a new closed value with its own consumer, not a widened one.

The variables are set only in the child environment. At most 8 values, with no
duplicates.

**Core validates.** The set is independent of adapter. A contribution may not
collide with a `launch_environment` name or a `PORTCOVE_*` name. It is
permitted alongside an external profile, because the contribution names no
path.

**Unchanged rules.** The `launch_environment` rules stay exactly as they are:
names must carry the port prefix or be `PYTHONDONTWRITEBYTECODE`
([launch value rules](../CATALOG.md#package-and-launch-declaration-compatibility)),
and the loader-injection prefix deny-list defined there still refuses every
name in it. C2 is a separate closed list; it does not pass through,
widen or relax either rule.

**Selects in Core.** It inserts the pairs in `adapter.rs` where the CorsixTH
branch is today (`:289-302`).

**Retained contract.** It records the value set.

**Users.** 1 entry, `corsixth-corsixth`.

**Retires.** The `adapter.rs:289-302` branch.

**Accepted.** The alternative, relaxing `launch_environment` to allow `USER`,
was rejected: it lets data override an account variable that other runtimes
read for path construction. A closed contribution names a _mechanism_ (supply a
neutral player name) that a different runtime can select.

**Not needed for parity:** whether CorsixTH on Windows would also read
`USERNAME`. Parity is `USER=PLAYER` on both platforms, which is what ships
today and what the existing test
`managed_corsixth_uses_a_neutral_player_name_without_inheriting_the_account`
(`adapter.rs:4497`) asserts.

### C3. External roots and typed checks (`native.external-roots-v1`)

This replaces `ExternalProfilePolicy` (18 variants), the 11 resolver modules
and the OpenSC2K branch. It is #8622's proposed "step 2, declarative
root-resolution contract", with that PR's conditions:

- no package-shape pin moved into asset names;
- the threat stays "a definition claiming a guard written for another upstream".

The binding is now the definition's own declared roots, so a wrong claim
resolves _its own declared_ roots. That is not another upstream's.

**Fields.**

```json
"external_roots": [{
  "id": "profile",
  "platforms": ["linux-x86-64"],
  "role": "upstream-profile" | "external-write",
  "candidates": [
    { "env": "XDG_CONFIG_HOME", "empty": "absent", "join": ["CorsixTH"] },
    { "known_folder": "account-home", "join": [".config", "CorsixTH"] }
  ],
  "owned_fallback": { "persistent_path": ".z2rs-data" },
  "checks": [ { "kind": "...", ... } ]
}]
```

Field rules:

- `candidates` is ordered. The first candidate whose base resolves wins.
- `env` takes a closed list: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
  `XDG_STATE_HOME`, `HOME`, `APPDATA`, `LOCALAPPDATA` and `TMPDIR`. No other
  variable can be named, and the list grows only with a Core change.
- `empty` takes `absent` or `present` and is required on every `env`
  candidate:
  - `absent`: a variable that is set to the empty string is treated as unset,
    and resolution moves to the next candidate (XDG semantics).
  - `present`: a variable that is set to the empty string counts as set. The
    upstream would then use an empty, relative base, so the check refuses
    launch; it does not fall through.
  - An unset variable always moves to the next candidate. A set, non-empty
    value that fails the base rules below always refuses; it never falls
    through, because the upstream would use it.
- `known_folder` takes a closed list, resolved by OS APIs:

  | Value                     | Resolution                                                 |
  | ------------------------- | ---------------------------------------------------------- |
  | `account-home`            | `getpwuid_r` (`native_external_profile.rs:427-461`)        |
  | `roaming-app-data`        | Windows roaming application data                           |
  | `local-app-data`          | Windows local application data                             |
  | `documents`               | `CSIDL_PERSONAL` (`native_external_profile/vcmi.rs:73-99`) |
  | `mac-application-support` | macOS Application Support                                  |
  | `system-temp`             | The system temporary directory                             |

- Bounds: at most 4 roots per platform, at most 6 candidates per root, at
  most 6 `join` segments per candidate and at most 12 checks per root.
- The bounded walk keeps Core's constants: depth 32 and 65,536 entries
  (`external_runtime/shared_preferences.rs:396-433`). Data may only lower them.

**Path rules (normative).** Core enforces these for every candidate. They are
stated here, not inherited from a module, and each has its own refusal test.

1. **Join grammar.** Each `join` segment is 1-64 bytes of
   `[A-Za-z0-9 ._+-]`. The validator refuses, in addition:
   - `.` and `..`;
   - a segment that ends with a dot or a space;
   - a reserved Windows device name, compared case-insensitively, with or
     without an extension: `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`,
     `LPT1`-`LPT9` (so `con`, `CON.txt` and `Nul.cfg` are all refused);
   - anything that could form a prefix or an absolute path: `\\?\`, `\\.\`,
     a drive form (`C:`), a UNC form (`\\server`), a leading `/` or `\`, or
     a stream (`:`). The character class already excludes `:`, `/` and `\`;
     the validator also checks the joined result, so a future grammar change
     cannot reintroduce them.
2. **Environment-derived bases.** The value must be absolute and already
   normalized: no `.` or `..` component, no repeated separator, no trailing
   separator other than a root. It must not be a UNC path or a device path
   (`\\?\`, `\\.\`, `//?/`). Anything else refuses launch.
3. **Links on the resolved root and its ancestors.** There are two regimes.
   Each root uses exactly one of them, chosen by role, never by data:
   - `upstream-profile` roots: the existing ancestors are **resolved and
     rechecked**. Core canonicalizes the longest existing ancestor once
     (`path.rs:150-174`). It refuses overlap of the canonical result with
     owned storage, and then re-inspects every existing component of the
     canonical path without following: a symlink, junction or reparse point
     found then (a race) refuses (`external_runtime/shared_preferences.rs:353-391`).
     The root itself and every entry walked under it are inspected with
     `symlink_metadata`: a symlink, junction or reparse point is **refused**,
     never followed, and a file must be single-link.
   - `external-write` roots: ancestors are **not resolved**. Every existing
     ancestor must be a real directory, inspected without following, owned
     by root or by the current user, and without group or other write
     permission unless it is root-owned and sticky. A symlink, junction or
     reparse point anywhere on the path refuses. This is today's AppImage and
     temporary-directory rule (`native_external_profile.rs:652-694`).
4. **Overlap.** A resolved root must be absolute, contain no `..`, and must
   not overlap owned storage in either direction: output roots, the versions
   directory and the installation root (`native_external_profile.rs:807-813`,
   `:899-912`). This applies to every root regardless of data.

**Write and delete authority (normative).** Signed definition data never
grants Portcove write or delete access in an external root. Portcove does not
acquire, back up, restore, migrate, clean or delete anything under an external
root. The only exceptions are the `reserve-directory` check below and the
separately consented shared write scope of
[C6](#c6-shared-write-scope-stagedshared-write-scope-v2).

**Roles.**

- `role: upstream-profile`: the upstream reads and writes it. Portcove only
  guards it, under the rules above. This is today's semantics, stated in #8622.
- `role: external-write`: the runtime writes there and Portcove validates the
  location before launch, and may reserve it with `reserve-directory`
  (OpenSC2K autosaves; the `recomp-appimage-v1` `/tmp/{stem}-{uid}` root).

**Owned fallback.** Some runtimes fall back to a directory relative to their
working directory (Z2RS `.z2rs-data`). That directory is inside Portcove-owned
storage, so it is not an external root. `owned_fallback.persistent_path` must
equal a declared `persistent_paths` entry. It has ordinary owned-data
semantics (backup, rollback, removal and update, as every persistent path).
The external-root rules, including the overlap refusal, do not apply to it,
and it is never resolved through `candidates`.

**Check kinds.** The set is closed. Each kind is reusable Core code
parameterized by typed, bounded fields. This is the "small closed set of named
typed check kinds for what cannot be data".

| Kind                      | Parameters                                                                                                                                                                                                     | Replaces                                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refuse-file`             | `scope: root \| working-directory \| install-root`, `name`                                                                                                                                                     | `dunedynasty.cfg` (`native_external_profile.rs:783-791`), `portable.txt` (`recomp_direct.rs:48-56`), `config/dirs.json` (`vcmi.rs:39-70`), `openttd.cfg` in runtime (`archive_siblings.rs:182-217`) |
| `refuse-host-environment` | `names` (≤8, exact or `PREFIX_*`)                                                                                                                                                                              | `APP_FOLDER_PATH`, `OPENGLAD_CONFIG_DIR`, `OPENOMF_*_PATH`, `LD_LIBRARY_PATH`, `DYLD_LIBRARY_PATH` (several modules)                                                                                |
| `refuse-loadable-modules` | `scope: root \| path`, `extensions` (`so`, `dylib`, closed)                                                                                                                                                    | Doom 3 (`doom3_linux.rs:231-239`, `/usr/local/lib/dhewm3` at `:14`, `:160-167`), OpenJK (`openjk.rs:223-232`), JGRPP `*-social.so` (`archive_siblings.rs:219-247`)                                  |
| `path-byte-budget`        | `max_bytes`, `forbid` (closed: `backslash`, `dot-dot`, `double-colon`, `non-ascii`)                                                                                                                            | Doom 3 767 bytes, OpenJK <191, Dune, OpenMoHAA, OpenOMF, VCMI `MAX_PATH`                                                                                                                            |
| `json-field-null`         | `file` (relative to root), `pointer` (RFC 6901, ≤8 tokens), `max_bytes` ≤ 64 KiB                                                                                                                               | Z2RS `data_dir_override` (`z2rs.rs:99-131`)                                                                                                                                                         |
| `payload-format`          | `path`, `format` (closed: `elf-x86-64`, `pe-x86-64`, `mach-o-arm64`, `mach-o-universal`, `appimage-type-2`)                                                                                                    | ELF/Mach-O/AppImage checks across modules (`openmohaa.rs:142-187`, `quake_linux.rs`, `profile_siblings.rs`, …)                                                                                      |
| `payload-members`         | `required` / `forbidden` relative paths (≤32)                                                                                                                                                                  | OpenMoHAA companions, Ironwail `ironwail.pak`, JGRPP baseset/lang                                                                                                                                   |
| `inject-launch-arguments` | `arguments` (templates using only the closed placeholders `{root:<id>}` and `{working_directory}`, values under the existing [launch value rules](../CATALOG.md#package-and-launch-declaration-compatibility)) | Doom 3 `+set fs_*` (`doom3_linux.rs:12-13`, `:171-180`; `adapter.rs:418-423`), vkQuake `-userdir .` (`:424-429`), JGRPP `-X` (`:430-434`)                                                           |
| `reserve-directory`       | none (see the rules below)                                                                                                                                                                                     | OpenSC2K `/tmp/OpenSC2K Autosaves` (`native_portable_data.rs:329-372`), recomp AppImage `/tmp` roots (`native_external_profile.rs:709-765`)                                                         |
| `appimage-runtime-layout` | `stem` (must equal the declared executable stem)                                                                                                                                                               | Recomp AppImage layout (`native_external_profile.rs:297-329`, `:557-587`)                                                                                                                           |

**`reserve-directory` rules (normative).**

- **Where.** Only on a root with `role: external-write` whose single candidate
  is `known_folder: system-temp`, on Linux. The parent (the system temporary
  directory) must be a real, root-owned, sticky directory, checked without
  following (`native_portable_data.rs:329-341`). Other bases and platforms are
  refused by the validator until a consumer with its own ownership check
  exists.
- **Create only.** Core creates the final component with owner-only mode
  `0700`, without following a link (`mkdir` of the exact path; an existing
  link makes creation fail and the check below refuses). It never creates
  ancestors.
- **Existing path.** If the path already exists, it must be a real directory,
  not a link, owned by the current effective user, with no group or other
  write permission. Otherwise the check refuses launch and changes nothing.
  This adds one rule to today's OpenSC2K check, which tests owner and mode
  but not that the path is a directory (`native_portable_data.rs:358-372`).
  The mode rule is today's (`mode & 0o022 == 0`), not `0700`: the upstream
  creates the same directory itself with the default umask, and refusing a
  `0755` directory would refuse existing players.
- **Never more.** The check never changes the mode or owner of an existing
  path, never cleans, empties or deletes anything, and never moves files.

**Core validates:**

- **Adapter:** native-portable only. This is today's `validate_layout`
  precondition (`native_external_profile.rs:185-284`), which stays as the
  generic structural rule, including its refusal of `launch_environment`
  beside an external profile (`:198`).
- **Platforms:** each root's platforms ⊆ the entry's platforms.
- **Restricted check kinds:** `inject-launch-arguments` only with
  `launch_arguments` empty or exactly reviewed; `appimage-runtime-layout` only
  with an AppImage hint; `reserve-directory` only as stated above.
- **Shared rules:** the path rules, overlap refusal and write/delete rule above
  are generic Core code and apply to every resolved root.

**Selects in Core.** It selects the root resolution at launch
(`service.rs:6440-6463`), the install-time checks (`install.rs:1718-1824`,
`:5676-5712`), the release archive restriction (`release.rs:280-293`) and the
AppImage selector (`managed_runtime_policy.rs:203-215`). Each currently
dispatches on the policy.

**Retained contract.** It records `external_roots`.

**Read boundary.** A retained definition carrying `external_profile_policy`
reads through a _frozen translation table_: one row per historical policy
value, producing the equivalent `external_roots`. The table lives in the
historical reader module and is keyed on the retired field's value, which no
current definition may carry after IC-8b. Policy values never reach ordinary
execution. The published DUDE Doom 3 definitions and every installed
native-portable retained contract keep working.

**Compatibility encoding.** `operational_compatibility` keeps today's
`"external_profile_policy": <value>` key for any interpretation whose
`external_roots` equal the frozen translation of that value, and adds
`"external_roots"` only for an interpretation with no historical equivalent
([retained compatibility encoding](#retained-compatibility-encoding)). The same
rule applies to the package-shape derivation inputs
(`scripts/package-shape-baselines.mts:190-216`), which carry
`external_profile_policy` and an `openmohaa-unix-v1` condition, so no existing
route's derivation digest changes.

**Consumers outside Core.** `external_profile_policy` is also a transport and
script field. IC-8 updates every consumer together:

| Consumer                                                                                                                                | Change                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/transport-types.generated.d.ts` (`:2809`), `transport-schemas.generated.json`, `transport-host-output.generated.json` | Regenerated through `pnpm run transport:check` from the Rust types; `external_roots` added, the policy enum kept read-only for retained definitions |
| `scripts/package-shape-baselines.mts`                                                                                                   | Derivation inputs use the compatibility encoding above                                                                                              |
| `scripts/catalog-literal-launch-publication.mts` (`argumentReaders`, `:85-95`)                                                          | `external_roots` with `inject-launch-arguments` joins the list of argument readers                                                                  |
| `scripts/scheduled-package-drift.test.mts` (`:41`), `scripts/catalog-openmohaa-portable.mts` (`:108`)                                   | Fixtures and the OpenMoHAA generator emit `external_roots`                                                                                          |
| `scripts/maintenance-program-view.mts` (+ tests)                                                                                        | The `external-profile-policy` and `native-external-profile-module` kinds are declared retired                                                       |
| `scripts/catalog-source-authoring.test.mts`, `scripts/catalog-literal-launch-publication.test.mts`                                      | Updated fixtures                                                                                                                                    |
| Desktop presentation and Tauri                                                                                                          | None: no non-generated file under `apps/desktop/src` or `apps/desktop/src-tauri` reads the field at `f8799fb31`; IC-8 repeats the search            |

**Users.** 25 entries and OpenSC2K.

**Retires:**

- `ExternalProfilePolicy` from live code: the enum survives only as a
  read-boundary type.
- The 11 resolver modules. They become check-kind implementations named by
  mechanism, not title.
- `native_portable_data.rs:217-226`.
- The two pins #8622 kept in `reviewed_subject`
  (`native_external_profile.rs:173-183`). Those pins exist because "nothing
  binds this policy to a package shape". With declared roots, the binding
  _is_ the definition's own data, so a wrong claim guards the wrong directory
  of the claimant's own declaration. This needs the lead's decision recorded
  on #8622; see [risks](#open-risks-and-unknowns).

**Accepted** (merges "external save locations", "root resolution" and the
OpenSC2K external write).

### C4. Player-data roles (`data.roles-v1`)

This merges three candidates: generated-data ownership, save-file role maps and
`RuntimeDataPolicy`. Each one assigns a _role_ to a declared player-side path,
and the role determines what backup, export, progress copy, rollback and
removal may do. Core already has the role vocabulary: `PersistentDataRole`, 8
values (`portable_saves.rs:38-54`).

**Fields.**

```json
"data_roles": {
  "applies_to_versions": ["9.3.1"],
  "platforms": ["windows-x86-64", "linux-x86-64"],
  "entries": [
    { "path": "Save/file1.sav", "role": "portable-progress" },
    { "path": "Save/global.sav", "role": "device-configuration" },
    { "path": "randomizer", "role": "generated-content" },
    { "path": "asset_dump", "role": "local-player-data", "scope": "version-local", "reserve": true },
    { "path": "retroachievements.credentials", "role": "runtime-credential", "scope": "version-local" }
  ]
},
"data_roles_transition_v1": {
  "predecessor_contract_sha256": "…",
  "changes": [{ "path": "logs", "from": "local-player-data", "to": "generated-content" }]
}
```

Field rules:

- `role` takes a closed set: today's 8 `PersistentDataRole` values plus
  `runtime-credential`.
- `path` must be inside a declared `persistent_paths` or
  `runtime_mutable_paths` entry. The same relative-path grammar as
  `persistent_paths` applies.
- At most 64 entries.
- `scope` takes `shared` (the default: the canonical player-data root) or
  `version-local` (inside one installation root).
- `reserve: true` means Core creates and checks the exact directory before
  launch, as `require_graphics_export_directory` does today. It is allowed only
  on `local-player-data` and `generated-content`.
- `applies_to_versions` is an optional exact version list (≤16).
  `portable_saves.rs` scopes the role map to 9.3.1 today. When present,
  version-scoped operations (progress copy, portable export/import) are
  offered only for listed versions. Other operations are unaffected; this is
  case 6 of [blanket refusals](#where-missing-optional-evidence-becomes-a-blanket-refusal-today).

**Role effects (normative).** Roles never widen what Portcove deletes. A role
only (a) narrows what may leave the device, (b) selects progress copy, or (c)
adds preservation. "As owned data" below means exactly today's behavior for
a path in `persistent_paths` or `runtime_mutable_paths`, unchanged.

| Role                   | Backup and restore                  | Rollback and update                                                                                    | Removal                                                                                                                                        | Export, recipe and progress copy        |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `portable-progress`    | As owned data                       | As owned data; never replaced by a build-local copy                                                    | As owned data (player data is kept unless the player deletes it)                                                                               | Exported and copied (version-scoped)    |
| `device-configuration` | As owned data                       | As owned data                                                                                          | As owned data                                                                                                                                  | Not exported; stays on this device      |
| `mods`                 | As `mod_package_policy` today       | As `mod_package_policy` today                                                                          | As owned data                                                                                                                                  | Not exported by portable export         |
| `generated-content`    | As owned data                       | As owned data                                                                                          | As owned data                                                                                                                                  | Not exported                            |
| `original-derived`     | As owned data                       | As owned data                                                                                          | As owned data                                                                                                                                  | Never exported or recipe-shared         |
| `local-player-data`    | As owned data                       | As owned data; `version-local` is copied to the canonical root before its installation root is removed | Preserved; `version-local` is copied to the canonical root first, as `asset_dump` today (`service.rs:5750-5755`, `service/removal.rs:202-205`) | Not exported                            |
| `portcove-metadata`    | As owned data                       | As owned data                                                                                          | As owned data                                                                                                                                  | Portcove's own record                   |
| `unknown`              | As owned data                       | As owned data                                                                                          | As owned data                                                                                                                                  | Not exported; shown for review          |
| `runtime-credential`   | Excluded (`runtime_data_policy.rs`) | Never copied across versions when `version-local`                                                      | Removed with its installation root, as today                                                                                                   | Never exported, recipe-shared or copied |

The table is parity with today: the only rows that differ from "as owned data"
are the ones today's code already implements (portable export in
`portable_saves.rs`, credential exclusion in `runtime_data_policy.rs`, and the
graphics-export copy). Revision 1 proposed excluding `original-derived` from
backup; that is a behavior change with no consumer, so it is withdrawn.

**Progress is never discarded by data (normative).** No role, no role
change and no definition update can cause Portcove to discard, overwrite with
an older copy, or omit from backup a file that any retained or current
interpretation classifies as `portable-progress` or `local-player-data`.

**Core validates:**

- `runtime-credential` is never exported, backed up, recipe-shared or copied
  across versions. This is `runtime_data_policy.rs:95-114` today.
- **No overlap with progress.** A path with role `original-derived` or
  `generated-content` must not equal, contain or lie inside a path with role
  `portable-progress` or `local-player-data`, in either direction. The same
  holds against `archive_data_compatibility_v1.build_specific_progress_paths`.
- `portable-progress` requires a non-empty role map for the containing
  directory.
- **Transitions.** Order the roles by preservation:
  `portable-progress` = `local-player-data` > `device-configuration` = `mods`
  > `unknown` > `generated-content` = `original-derived` > `runtime-credential`.
  > When the current definition gives a path a lower role than the retained
  > definition it updates or rolls back from, the current definition must carry
  > a `data_roles_transition_v1` record. The record names the exact predecessor
  > retained contract (`predecessor_contract_sha256`) and each lowered path with
  > its `from` and `to` roles, as `archive_data_transition_v1`
  > (`archive_data_transition.rs:1-40`) does for data admission. Without it the
  > update, rollback, backup and progress operations treat the path under its
  > higher retained role and report the conflict. A transition can never lower a
  > path below `local-player-data` while any retained contract still gives it a
  > progress role and that file exists; the player must move it first.

**Selects in Core:**

- `service/portable_saves.rs` (export/import, folder sync) and `profile_deploy.rs`
  progress copy (`:165`, `:215`, `:3009`) read roles from the retained
  interpretation instead of `contract_for(port_id)`.
- The graphics-export copy reads `local-player-data` with `version-local` and
  `reserve` instead of `owns_regaiden_graphics_exports`
  (`service.rs:5750-5755`, `:7670`; `service/removal.rs:202-205`;
  `install.rs:2775-2780`, `:3879-3900`).
- Credential exclusion reads `runtime-credential`.

**Also needed for Shipwright** (`installed_mutability.rs:6-187`). Parity needs
two things existing fields can already express, so they are authored rather
than new contract fields:

- Hard-injected `Save` and `SoHTimeSplitData.json` become authored
  `persistent_paths`.
- `logs/Ship of Harkinian.log` becomes authored `runtime_mutable_paths`.

`windows_shipwright_persistence` then reduces to "working-directory
persistence on Windows": the runtime writes relative to the working directory,
set by `SHIP_HOME` at `adapter.rs:329`. Expressing that needs one more value of
the existing `user_data_environment` mechanism. That value would be
`SHIP_HOME=working-directory`, which is an identifying literal. **Rejected in
that form.** Instead C4 adds `working_directory_writes: true`. It is the
generic fact the validator checks: the runtime writes its declared persistent
paths relative to the working directory. `launch_paths.rs` sets the
upstream-declared variable from the existing `user_data_environment` field.
The Shipwright checks in `require_shipwright_release` (stable 9.x,
`soh-*-win64.zip`) are release-selection facts already covered by the reviewed
GitHub rules and `reviewed_package_layouts`; they become authored there.

**Retained contract.** It records `data_roles`.

**Read boundary:**

- Retained Shipwright definitions without `data_roles` read through a frozen
  translation of the current `CONTRACTS` row and the injected paths, bound to
  `PackageContract::Shipwright931Windows`, which is already in
  `historical-artifacts.json#packages`.
- Retained `runtime_data_policy` values translate to role entries.
- Retained RE Gaiden contracts translate `gbrecompiled-windows-v1` with the
  exact repository to `asset_dump` as `local-player-data`, `version-local`,
  `reserve`.

**Compatibility encoding.** `operational_compatibility` keeps today's
`runtime_data_policy`, `windows_shipwright_persistence` and
`managed_shared_preferences` keys whenever the interpretation equals the
frozen translation of a historical value, and adds `data_roles` or
`working_directory_writes` only for interpretations with no historical
equivalent ([retained compatibility encoding](#retained-compatibility-encoding)).

**Users.** shipwright, wave-race-64-racewave46 and resident-evil-gaiden-recomp
(3 entries).

**Retires:**

- `portable_saves.rs` `CONTRACTS`.
- The Shipwright pins in `installed_mutability.rs` (`:6-83`, `:128-145`).
- `RuntimeDataPolicy` from live code.
- `owns_graphics_exports` / `owns_regaiden_graphics_exports`.
- `windows_shipwright_persistence`, which is replaced by
  `working_directory_writes` and authored paths.

**Accepted (merged).** A separate "generated-data ownership" contract was
rejected: it would duplicate the role vocabulary and need the same consumers.

### C5. Seeded files and file-signature checks (`staged.seeded-files-v1`)

**Fields.**

```json
"seeded_files": [{ "path": "chocolate-doom.cfg", "text": "autoload_path \"autoload\"\n...", "when": "absent" }],
"file_signatures": [{ "path": "GameData/PILOT.CFG", "size": 14943, "prefix_hex": "504346120e" }]
```

Field rules:

- Seeded files: at most 4 per entry. `path` must be inside the entry's mutable
  paths. `text` is UTF-8 of at most 4 KiB with no NUL. `when` is closed:
  `absent`, meaning Core never rewrites an existing file, which is today's
  invariant in `managed_chocolate.rs:1`.
- File signatures: at most 8 per entry. `prefix_hex` is at most 32 bytes.
  Signatures apply to admitted source materialization outputs or seeded paths.

**Core validates:**

- staged-source-portable only. Windows is the only consumer today; adding a
  platform needs a fixture, not a new contract.
- Seeded paths must not be `original-derived` or `runtime-credential` roles
  (C4).
- No seeded file may be a declared executable or a `setup_output_paths`
  member.

**Selects in Core.** The `managed_initialization::prepare` and `check`
dispatch (`managed_initialization.rs:5-60`), and the adapter's
fixed-argument forcing (`adapter.rs:448`), which becomes ordinary
`launch_arguments`.

**Retained contract.** It records both fields.

**Read boundary.**

| Retained value                 | Translation                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `chocolate-family-portable-v1` | Today's three executable-keyed seeds, screenshot patterns and argument lists |
| `tfe-dark-forces-portable-v1`  | `SETTINGS` and the pilot signature                                           |
| `tfe-dark-forces-v1.22.420`    | Stays bound to the exact historical package                                  |

**Users.** 4 entries.

**Retires:**

- `ManagedInitialization` from live code.
- The repository pin `managed_chocolate.rs:66` and the executable-name table
  `:14-46`.
- `PreparedRuntimeSettingsContract`, if its single TFE use is reproducible as a
  user-prepared `seeded_files` (`external_runtime/tfe_settings.rs:17`). It has
  0 catalog consumers today. Its retained reader moves to the historical
  module.

**Accepted.** A "managed initialization recipe" with steps was rejected: it is
a step interpreter, and the owner excludes another planner.

### C6. Shared write scope (`staged.shared-write-scope-v2`)

**Fields.**

```json
"shared_write_scope": {
  "base": { "known_folder": "roaming-app-data", "join": ["SMB1R"] },
  "files": ["settings.cfg"],
  "account_binding": "sid",
  "content_checks": [{ "kind": "godot-config-constructor-free", "max_bytes": 65536 }],
  "fixed_arguments": ["--disable-mods"],
  "required_inputs": [{ "path": "baserom.nes", "source_profile": "..." }]
}
```

Field rules:

- `base` uses C3's closed bases and `join` grammar.
- `files` is optional (≤16). An empty list means the whole directory, as for
  SMB1R.
- `account_binding` is closed: `sid` on Windows.
- `content_checks` is a closed list (`godot-config-constructor-free` is a
  format check, not a title check).
- `fixed_arguments` follow the launch value rules.
- `required_inputs` references existing source contracts.

**Core validates:**

- user-prepared registration or managed staged-source.
- Separate consent stays mandatory. The review fingerprints the account and
  the resolved path ([retained installation contracts](../ARCHITECTURE.md#retained-installation-contracts)).
- Never combined with C4 roles over the same directory, because Portcove never
  owns shared data.

**Selects in Core.** `external_runtime/shared_preferences.rs` and
`managed_shared_preferences.rs`, through declared data instead of variant
dispatch.

**Retained contract.** It records the scope. The existing consent receipt
already binds account and path.

**Read boundary.** The three historical variants translate. The two variants
bound to exact packages keep their `PackageContract` binding in the historical
reader.

**Users.** resident-evil-gaiden-recomp and super-mario-bros-remastered
(2 entries).

**Retires:** `PreparedSharedPreferencesContract` from live code.

**Accepted with a narrower scope than the variants suggest.** The variants also
pin executable names and package trees. Those pins are expressed by existing
`reviewed_package_layouts` and `accepted-package` trust, not by C6.

**UNKNOWN:** whether the GB Recompiled roaming/installation-local fallback
(`types.rs:573-576`) is fully expressible as an ordered candidate list. Reading
`managed_shared_preferences.rs` in full settles it.

### C7. Byte-bound artifact exceptions (`runtime.artifact-exceptions-v1`)

**Fields.**

```json
"artifact_exceptions": [{
  "artifact": { "role": "runtime" | "setup-tool", "size": 0, "sha256": "…" },
  "platforms": ["windows-x86-64"],
  "kind": "destination-path-reserve" | "discard-empty-output-scaffold" | "reviewed-runtime-write",
  "paths": ["build-portcove/mods/bundled/psx.enhancement.internal-resolution/1.0.0/manifest.toml"]
}]
```

The `kind` set is closed. At most 16 exceptions per entry and at most 16 paths
per exception. Paths use the relative grammar.

| Kind                            | Meaning                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `destination-path-reserve`      | The destination must leave room for these relative paths under the platform's path limit                                         |
| `discard-empty-output-scaffold` | After the tool runs, these directories may exist only if empty, and are discarded                                                |
| `reviewed-runtime-write`        | These exact files, written by the runtime beside its executable, are reported as reviewed mutable files instead of unknown files |

**Core validates:**

- `role: runtime` matches a selected release artifact. `role: setup-tool`
  matches the preparation tool identity (`preparation_execution.rs:591`).
- `discard-empty-output-scaffold` requires a setup contract with
  `setup_output_paths`.
- `destination-path-reserve` requires Windows.
- An exception never relaxes integrity, ownership or archive safety. Both kinds
  only _add_ a check or _tolerate_ a provably empty directory.

**Selects in Core:**

- `check_artifact_destination` (`runtime_path_policy.rs:295-309`) and its
  callers: `install.rs:991`, `:5076`; `service.rs:1748`;
  `output_relocation.rs:502`; `transfer_copy.rs:314`; `library_transfer.rs:53`;
  `library_import.rs:333`.
- Output validation (`preparation_execution.rs:901-918`).

**Retained contract.** It records the exceptions.

**Two phases:**

- **Phase A (no schema change): a frozen retained reader.** A Core-bundled
  `historical-artifacts.json#artifact_exceptions` section holds today's three
  behaviors as rows keyed only by `(role, size, sha256)`, with no port id. The
  callers already hold the artifact digest (#8618). Byte binding is legitimate
  here for two reasons, and only for these rows:
  - the behavior is a property of those exact bytes (a bundled path depth, an
    extractor's empty scaffold, a runtime's cache file name), not of a title;
  - it must cover installs that predate any definition field, whose retained
    definitions can never gain one.

  The section is **closed**: it is declared in the
  [frozen fence](#declared-frozen-historical-recovery) with its exact row set,
  and the detector fails if a row is added. It is not a growing "declared data
  authority". After phase B, its only reader is the retained interpretation of
  installs whose retained definitions predate `artifact_exceptions`.

- **Phase B (reader generation).** The definition carries
  `artifact_exceptions`. Every new exception goes only into a definition, so a
  publisher can add one for a new artifact without a Core release. The current
  definitions of the three users declare their rows in the same pull request,
  so the bundled section is reached only through retained definitions.

**Users.** alexbeav-diablo-recomp, opengoal-jak1 and g-diffuser (`reviewed-runtime-write`:
the two v1.2.3 shader-cache files, `install.rs:6008-6035`).

**Retires.** The three id-and-digest pins: `runtime_path_policy.rs:288-293`,
`preparation_execution.rs:775-777` and `reviewed_g_diffuser_cache`
(`install.rs:6008-6035`).

**Accepted.** "Artifact-specific restrictions" proper are already covered by
typed acquisition restrictions with `artifacts` scope (hold/permit). C7 covers
only _behavioral_ allowances and additional checks, which restrictions cannot
express.

### C8. Recorded mod-provider bindings (library migration; no definition change)

**What it is.** No new definition contract: `mod_provider_bindings` and
`mod_loader` exist. This is a library-state migration plus a writer change.

1. **Writer.** `provider_install.rs:626-629` stops eliding the binding. Every
   new `ProviderPackageRef` records `binding: Some(exact)`.
2. **Migration 78, one-way** (`database.rs:17-27`, after
   `CURRENT_SCHEMA_VERSION = 77`). Like every library migration, it is not
   reversible: a client below 78 refuses the migrated library
   ([database and migrations](../ARCHITECTURE.md#database-and-migrations)).
   - It adds a side table: `profile_package_bindings(profile_id,
     revision_digest, package_path, binding_json)`.
   - For each stored `ProviderPackageRef` with `binding: None` in
     `profiles.profile_json` and `profile_revisions.revision_json`, it records
     the binding that `legacy_binding` resolves today.
   - Revisions are append-only and digest-bound (`profile.rs:1693`,
     `:1641-1648`), and prior migrations deliberately avoid rewriting them
     (`database.rs:625-629`). The migration therefore _adds_ rows and rewrites
     nothing.
   - The compiled tables move into the migration module as its frozen input.
3. **Readers.** `reference_matches`, `same_project`, auto-update and browse
   (`provider_binding.rs:84-104`; `provider_auto_update.rs:129-179`;
   `provider_browse.rs:105`) read `binding.or(side_table)`. They never read a
   port-keyed table.
4. **Imported data.** Library import (`library_import.rs:676`) and recipe
   import (format 3 vs 4, `recipe.rs:319-327`) apply the same resolution at
   their own read boundaries.
5. **`legacy_loader`** (`profile_loader.rs:120-130`). It stays only for
   _retained_ definitions without `mod_loader`. It moves to the historical
   reader, keyed on retained format and the absence of the field, never on a
   current definition. `Catalog::validate` already requires `mod_loader` where
   a loader is used; a regression test asserts that a current definition
   cannot reach the fallback. `native_mod_list::recomp_game` reads the
   retained or current `mod_loader` contract.

**Retires.** `GAMEBANANA_BINDINGS` and `COMMUNITY_BINDINGS` from live paths.
The program-view member is declared retired; the migration-module copy is
counted under the frozen historical category.

6. **Auto-update holds (settled in revision 2, so no second migration is
   needed).** Hold scopes _are_ persisted, outside the database: held updates
   are stored in the mod layout's `auto-update-holds.json`
   (`provider_auto_update.rs:35`, read and written at `:452-458`). A hold key
   ends with `|<scope>` only when the reference's binding differs from the
   legacy table (`nonlegacy_binding`, `:130-139`; `hold_scope`, `:177-184`;
   key built at `:328-335`). Holds remembered for legacy references therefore
   have no scope suffix.

   Rule: `hold_scope` returns `None` for a binding that came from the side
   table (a migrated legacy reference) and `Some(scope)` for a recorded
   binding. Every existing hold key is then byte-identical after migration 78,
   so the holds file is neither rewritten nor migrated, and no hold is lost or
   shown again. New installs record exact bindings, so their holds carry a
   scope, as non-legacy holds do today.

**Forward-upgrade test.** A fixture library at schema 77 holds profiles and
revisions with `binding: None` references for both providers, recipes in
formats 3 and 4, and an `auto-update-holds.json` with scoped and unscoped
keys. Opening it with the new client migrates to 78. The test asserts:

- every revision digest and profile JSON byte string is unchanged;
- the side table holds exactly the bindings `legacy_binding` resolves at 77;
- browse, `reference_matches`, auto-update and both import paths resolve the
  same bindings as at 77;
- every hold in the holds file still matches its reference;
- a second open is a no-op, and a client that knows only 77 refuses the
  library with the existing newer-schema error.

### Candidates evaluated

| Candidate                                     | Decision                                        | Reason                                                                                  |
| --------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Process-handoff / launch-supervision contract | Accepted as C1                                  | Real consumer (Snap64). It removes the id branch. It is a value of an existing concept. |
| Generated-data ownership                      | Merged into C4                                  | Same consumers and role vocabulary as save-file roles.                                  |
| External save/profile locations               | Merged into C3                                  | Same resolution mechanism as root resolution.                                           |
| Declarative root resolution with check kinds  | Accepted as C3                                  | 25 entries plus OpenSC2K; #8622 step 2.                                                 |
| Byte-bound exception records                  | Accepted as C7                                  | Phase A needs no schema change.                                                         |
| Launch environment contributions              | Accepted as C2                                  | Closed and mechanism-named.                                                             |
| Save-file role maps                           | Merged into C4                                  | `portable_saves.rs` is a role map.                                                      |
| Managed initialization recipes                | Accepted as C5, without steps                   | Seeds and signatures only; any step sequencing would be a planner.                      |
| Shared preferences                            | Accepted as C6 (v2 of the existing write scope) | Generalizes the three variants to declared bases.                                       |
| Per-title capability variants (status quo)    | Rejected                                        | See [alternatives](#alternatives-rejected).                                             |

## What must remain Core code

| Mechanism                                                                                                                                    | Why it cannot be data                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Known-folder resolution (`getpwuid_r`, `SHGetSpecialFolderPathW`, `directories::BaseDirs`)                                                   | OS API calls with platform error semantics. Data selects among a closed list.                                                                                                                                                                                                                                                                                             |
| Owned-storage overlap refusal, single-link and safe-ancestor checks, bounded walks                                                           | Trust protections. They apply to _every_ resolved root regardless of data (`native_external_profile.rs:767-947`).                                                                                                                                                                                                                                                         |
| Executable and payload format parsers (ELF, PE, Mach-O fat/thin, AppImage type 2)                                                            | Binary parsing with bounds. Data names a format from a closed list.                                                                                                                                                                                                                                                                                                       |
| Content parsers for check kinds (`json-field-null`, `godot-config-constructor-free`)                                                         | Bounded parsers. The SMB1R filter guards a parser that can instantiate objects (ARCHITECTURE). Data selects the check and its file; it cannot supply a grammar.                                                                                                                                                                                                           |
| Windows job objects, the job keeper and `CREATE_NEW_PROCESS_GROUP`                                                                           | Process supervision ([child-process boundary](../ARCHITECTURE.md#child-process-boundary)). C1 selects among Core behaviors.                                                                                                                                                                                                                                               |
| Disc, archive, STFS and ROM-patch readers; source materialization transforms                                                                 | Existing reusable mechanisms, each with fixtures.                                                                                                                                                                                                                                                                                                                         |
| Mod-format readers (`dfu_mod.rs`, `recomp_mod*.rs`) and provider clients (`gamebanana.rs`, `thunderstore.rs`, `jakmods.rs`, `quaddicted.rs`) | Genuine reusable mechanisms for a file format or third-party service, selected through `mod_loader`, `mod_provider_bindings` or `mod_sources` data. Their names identify a format or service, not a catalog title. The program view should classify them as such ([IC-1](#ic-1-frozen-fence-dkr-legacy-cartridge-and-library-import)), subject to the check stated there. |
| Historical readers                                                                                                                           | They interpret exact past bytes. See [declared frozen historical recovery](#declared-frozen-historical-recovery).                                                                                                                                                                                                                                                         |

## Installed state and the read/migration boundary

Principle: "Keep historical storage interpretation at a deliberate
read/migration boundary so ordinary execution can evolve."

**One read boundary.** A new module, `retained_interpretation`, is the only
place where historical shapes are read. It is a submodule of `installed_contract`.

- **Input.** The verified manifest and its retained contract, after
  `install::verified_manifest_with_budget` (`install.rs:5243`),
  `catalog_for_verified_manifest` (`:4208-4227`) and `InstalledContract::catalog`
  (`installed_contract.rs:267-390`) have checked integrity.
- **Output.** A `CurrentInterpretation`: the retained `PortDefinition` with
  every retired field _translated_ into the current typed contracts (C1-C7), or
  a typed refusal naming the unreadable shape.
- **Translations.** They are frozen tables, one per retired field:
  - `windows_tracked_handoff` → C1
  - `ExternalProfilePolicy` → C3
  - `RuntimeDataPolicy`, `windows_shipwright_persistence` and the
    `portable_saves` row → C4
  - `ManagedInitialization` and `PreparedRuntimeSettingsContract` → C5
  - `PreparedSharedPreferencesContract` → C6
  - the three byte-bound pins → C7 (phase A rows)
- **Fencing.** Each translation is keyed on the retired field's _value_ and,
  where today's code also requires it, on the exact historical package
  (`historical-artifacts.json#packages`). It is never keyed on a current
  definition.
- **Consumers.** Ordinary execution (launch, backup, rollback, transfer,
  import, settings) consumes only `CurrentInterpretation`. Translated values
  are not written back: the retained bytes and the `installed_contract_sha256`
  identity stay unchanged, so retained-build references, recipes and profile
  revisions keep matching (`retained_build.rs:33-43`, `:975-989`).
- **Pre-contract manifests** (schema 2-5, no `retained_contract`). The rule is
  whole-directory backup, case 3 of
  [blanket refusals](#where-missing-optional-evidence-becomes-a-blanket-refusal-today):
  - Backup copies everything under the installation's owned roots without
    per-path claims, and restore puts back exactly what it copied. This needs
    no historical definition, so it is available for every pre-contract
    install.
  - Path-selective operations (collectible-data review, progress copy,
    folder sync, native-portable transitions, restore deletion, game
    settings) need a retained definition. Without one they hold, with a
    reason that names the missing contract. The current catalog is never
    substituted ([distinction 4](#4-exact-installed-state)).
  - Ports that need path-selective claims for pre-contract installs get them
    only from a frozen historical definition. Today that is **DKR only**
    (`legacy_dkr/catalog.json`, read at `install.rs:4183-4228`). No other port
    is added by this design. A port is added later only when two things hold:
    the library diagnostics report pre-contract installs of it in the classes
    that need a restore receipt (`persistence.rs:241-245`: psx-recomp-managed,
    ready staged archives, N64 executable-parent runtimes), and its creating
    definition is recovered from catalog history as an exact frozen file.
- **Migrations.** Only C8 needs a library migration (78, one-way). No
  installed-contract format is added: translation happens on read, and the
  existing wrapper formats 4-12 (`installed_contract.rs:225-262`) already fence
  older _readers_.
- **Older clients.** A retained contract written by a newer client with C1-C7
  fields is unreadable by an older client. This is already true of every
  feature-gated field, so no new compatibility class is created.
- **Retained-contract tests.** For every retired field, a fixture retained
  contract from each historical shape translates to the expected current
  contract. Ordinary execution is then exercised on it: launch, backup and
  rollback for C3 and C4, and preparation for C5. The existing retained
  fixtures (Ghostship, DKR, legacy cartridge, Shipwright 9.3.1) are reused.

### Retained compatibility encoding

`operational_compatibility` (`installed_mutability.rs:214-378`) serializes
the operational fields of a definition, including `external_profile_policy`,
`runtime_data_policy`, `managed_initialization`, `managed_shared_preferences`,
`windows_shipwright_persistence` and `windows_tracked_handoff`.
`checked_port` compares the value for the retained definition with the value
for the current one (`:109-123`). When they differ, the install keeps its
retained authority and does not borrow current paths. Migrating an entry from
a retired field to its new contract would therefore make every existing
install of it look like it changed contract, on update, rollback and launch,
although nothing operational changed.

Rule:

- `operational_compatibility` is computed from the
  `CurrentInterpretation` of both sides, never from raw retained bytes.
- Its encoding is **canonical**: each contract has one encoding derived from
  its interpretation. Where the interpretation equals the frozen translation
  of a historical value, the encoding is that historical key and value,
  byte-for-byte as today. A new key appears only for an interpretation with no
  historical equivalent.

| Contract | Canonical encoding                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1       | `windows_tracked_handoff: true` for either `process_handoff.windows` value; absent when absent                                                                                          |
| C3       | `external_profile_policy: <v>` when `external_roots` equals the translation of `<v>`; otherwise `external_roots`                                                                        |
| C4       | `runtime_data_policy`, `windows_shipwright_persistence` (and the injected Shipwright paths) as today when equal to a translation; otherwise `data_roles` and `working_directory_writes` |
| C5       | `managed_initialization: <v>` when equal to a translation; otherwise `seeded_files` and `file_signatures`                                                                               |
| C6       | `managed_shared_preferences` and `managed_shared_preferences_save_id` as today when equal to a translation; otherwise `shared_write_scope`                                              |
| C7       | Not encoded today and not encoded after: exceptions are byte-bound and never rebind an install                                                                                          |

**Parity tests, required in every migration pull request (IC-6 to IC-12):**

1. For every embedded entry the pull request migrates, and for every
   retained fixture of that contract, `operational_compatibility` of the
   pre-migration definition equals `operational_compatibility` of the
   migrated definition, byte for byte.
2. A retained build created before the migration and checked against the
   migrated current definition yields the same `checked_port` result as
   before (same paths, same authority).
3. `installed_contract_sha256` of every retained fixture is unchanged, since
   retained bytes are never rewritten.
4. The same equality for `scripts/package-shape-baselines.mts` derivation
   inputs over every migrated route.

## Declared frozen historical recovery

Lead decision 5 (#1422): historical recovery code is fenced as deliberately
historical, not retired. This section defines the fence so the code stops
counting as _live_ title authority without losing its meaning.

**What makes code historical.** Code is historical only when a **guard
predicate on a retained key** decides whether it runs. A retained key is a
fact that a current definition cannot carry or produce:

- a retained contract format, or the absence of a retained contract;
- a retired definition field that `retired_creation` refuses for new
  definitions (for example `release.managed_build`, `definition_entry.rs:340-342`);
- a specific migration row or library metadata schema range;
- an exact package or artifact digest recorded in `historical-artifacts.json`;
- a retained preparation mode (for example `Ghostship200Legacy`).

A port id is never a retained key: a current definition carries the same id.
Ordinary entry points (launch completion, backup, import) may _call into_ a
fenced region. What the fence guarantees is that the region's guard returns
"not historical" for every current definition, so a current definition with
the same id never enters it. Revision 1 asked for a static call-graph proof
that regions are unreachable from ordinary entry points; that is both
unnecessary and false for Ghostship (launch completion `service.rs:6729` and
backup `service/backups.rs:904`, `:930` legitimately call it). It is replaced
by guard-predicate tests.

**Program-view category.** A new attribute for `authorityKinds` members and
code regions: `frozen_historical`. Each declaration states:

| Field         | Content                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `guard`       | The predicate and the retained key it reads, with its file and function |
| `fence`       | The exact formats, rows and digests the region may read                 |
| `tests`       | The guard-predicate tests (below) and the region's behavior tests       |
| `end_of_life` | The retirement condition                                                |

The gate's numerator counts an identity as retired when _all_ its remaining
matches are inside declared frozen regions. The view reports frozen counts
separately (`frozen_historical: {entries, identities}`) so they stay visible.
The detector fails when any of these hold:

- a literal or row appears outside declared regions;
- a region's fence row set changes without a doc update (rows are hashed into
  the declaration);
- a declared region has no guard-predicate test.

**Guard-predicate tests (required per region).**

1. **Current definitions never enter.** For every embedded catalog entry with
   the region's port id (and, as a fixture, an unfamiliar current definition
   that copies that id), call the region's guard: it returns "not
   historical", and the region's side effects (data-store rows, journal
   writes, frozen-definition reads) do not happen. The test runs the ordinary
   entry points listed for the region with that current definition.
2. **Retained keys enter.** A fixture carrying the retained key enters the
   region and behaves as today.
3. **The id alone does not enter.** A fixture with the right port id but
   without the retained key does not enter.

**Declared regions** (at `f8799fb31`):

| Region                                                                                                                                                                  | Guard (retained key)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Fence (may read only)                                                                                                                                                                                                                                                        | Ordinary callers                                                                                                                                                                                                               | End of life                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Legacy DKR (`legacy_dkr/`, `historical-artifacts.json#dkr`)                                                                                                             | Manifest has no `retained_contract` **and** its `(version, platform, artifact size and sha256, selected executable)` matches a `#dkr` row (`install.rs:4183-4206`). IC-1 removes the leading `install.port_id != "dkr-r"` test: the digest match is sufficient and stricter.                                                                                                                                                                                                     | 4 rows (1.0.2 and 1.0.4 × Windows zip / Linux AppImage); `legacy_dkr/catalog.json`                                                                                                                                                                                           | `catalog_for_verified_manifest` (`install.rs:4208-4228`)                                                                                                                                                                       | `legacy_dkr/README.md:61-64`                                                                                                      |
| Legacy cartridge (`legacy_cartridge/`, `legacy_cartridge_cleanup.rs`, `cartridge_build.rs`, `historical-artifacts.json#cartridge`, the `CartridgeBuildRecipe` variants) | The definition carries the retired `release.managed_build` field, which `retired_creation` refuses for every non-retained definition (`definition_entry.rs:338-342`; 0 current catalog entries carry it); for journals and cleanup, the journal's recorded recipe. IC-1 replaces the id tests at `cancellation.rs`, `install.rs` and `legacy_cartridge_cleanup.rs` (`operation.port_id == "cvlod-recomp"`) with the recorded recipe.                                             | 6 `(port_id, recipe, projection)` rows; frozen `legacy_cartridge/*.json` definitions; the CVLoD WinINet junction path                                                                                                                                                        | Catalog validation of retained recipes (`catalog.rs:1060-1065` → `cartridge_build.rs:123-140`); cancellation; published cleanup; recovery                                                                                      | `legacy_cartridge/README.md:38-41`                                                                                                |
| Library-import reconciliation (`library_import.rs:22-42`)                                                                                                               | Shipwright: already a field comparison (embedded declares `windows_shipwright_persistence`, retained does not). Snap64: IC-1 replaces `embedded.id == "snap64-recomp"` with "the retained definition's selected artifact digest is in a frozen list of pre-handoff Snap64 packages", recorded as new `historical-artifacts.json#packages` rows. The worker derives the exact list from catalog history (the Snap64 releases offered before `windows_tracked_handoff` was added). | Those rows; library metadata schema 1-16                                                                                                                                                                                                                                     | `plan_library_import` (`:313`); `import_execution.rs:332`                                                                                                                                                                      | Library metadata schemas below the oldest supported export generation are refused with an explicit upgrade route (owner decision) |
| Ghostship 2.0.0 legacy recovery (`ghostship_data_store.rs`, `preparation_ghostship.rs`, `service/ghostship_*.rs`)                                                       | The active install's retained preparation mode is `Ghostship200Legacy` with installed contract format 4 (`service/ghostship_recovery.rs:286`), or a migration-37 row exists for the install. Today the guard first tests `session.port_id != "ghostship"` (`:263`); that test is removed so the retained mode alone decides.                                                                                                                                                     | Migration-37 tables; `LegacyDataSeal` format 1; package `ghostship-200-windows` (`Mary-Celeste-Alfa-Win64.zip`, sha `a49f4c79…`); executable sha `2063529579d2…` (11,533,312 bytes); source `ghostship-source` (8,388,608 bytes, sha `17ce0773…`); preparation plan format 2 | Launch completion (`service.rs:6729` → `library.rs:2121`); backup create and list (`service/backups.rs:904`, `:930`); user plan, authorize and recover (`service/ghostship_recovery.rs`, `ghostship_recovery_execution.rs:22`) | No library holds a format-4 contract or unresolved migration-37 row, reported by diagnostics, then owner-confirmed retirement     |
| Historical packages (`historical-artifacts.json#packages`)                                                                                                              | The retained definition's artifact digest matches a row                                                                                                                                                                                                                                                                                                                                                                                                                          | 7 `PackageContract`s plus IC-1's Snap64 rows                                                                                                                                                                                                                                 | The [read boundary](#installed-state-and-the-readmigration-boundary) translations only, after C4-C6                                                                                                                            | Per package: no retained contract or registration references it                                                                   |
| Artifact exceptions, phase A (`historical-artifacts.json#artifact_exceptions`, [C7](#c7-byte-bound-artifact-exceptions-runtimeartifact-exceptions-v1))                  | The artifact's `(role, size, sha256)` matches a row and, after phase B, the retained definition predates `artifact_exceptions`                                                                                                                                                                                                                                                                                                                                                   | Exactly 3 rows (Diablo, OpenGOAL, G-Diffuser); closed                                                                                                                                                                                                                        | Destination checks, preparation output validation, unknown-file reporting                                                                                                                                                      | No retained definition without `artifact_exceptions` references a row                                                             |
| C8 migration input (`GAMEBANANA_BINDINGS`, `COMMUNITY_BINDINGS` copies)                                                                                                 | A stored reference with `binding: None` at schema 77, or imported format-3 data                                                                                                                                                                                                                                                                                                                                                                                                  | Rows for stored refs with `binding: None`                                                                                                                                                                                                                                    | Migration 78 and recipe/library import of format-3 data                                                                                                                                                                        | No supported import format can carry `binding: None`                                                                              |
| `legacy_loader`                                                                                                                                                         | A retained definition without `mod_loader` **and** a retained format that predates `mods.native-loader-binding-v1`                                                                                                                                                                                                                                                                                                                                                               | `profile_loader.rs:120-130` rows                                                                                                                                                                                                                                             | Read boundary only                                                                                                                                                                                                             | Same as library-import reconciliation                                                                                             |

**Moved out of the fence: `historical-artifacts.json#direct`.** Revision 1
fenced it; that was wrong. `requires_fresh_direct_data_guard`
(`persistence.rs:180-196`) looks the row up **by port id** and applies it to
the _current_ definitions of the four identities ("Newer managed recipes for
these identities require the same bounded data guard", `:157-159`), and
`require_direct_backup_snapshot` does the same for backups
(`service/retained_direct_compatibility.rs:88`). That is live title authority.
Three of the four current definitions already declare
`archive_data_compatibility_v1`, which sets the guard by itself (`:183-185`);
only `sonic-3-and-knuckles-recomp` depends on the id lookup. The re-keying is
[IC-1b](#ic-1b-re-key-the-direct-data-guard-on-declared-data):

- **New field** on the current definition:

  ```json
  "predecessor_data_guard_v1": {
    "predecessor_release": { "provider": "direct-manifest", "version": "v0.5.3", "sha256": "42ada105…be99" }
  }
  ```

  It declares that installations of an exact earlier Direct release of this
  identity exist, and that this definition's installs must keep their data
  apart from them. Feature `staged.predecessor-data-guard-v1`, reader minimum
  staged-source capability 26 (today's value for this guard, so no new
  capability). Validator: a ready staged archive; the declaring definition's
  own release must not be the predecessor; at most one predecessor.

- **Predicate:** `requires_fresh_direct_data_guard(port)` becomes
  `ready_staged_archive(port) && (port.archive_data_compatibility_v1.is_some()
  || port.predecessor_data_guard_v1.is_some())`. It no longer reads the
  `#direct` registry.
- **Retained installs:** the registry is consulted only to recognize a
  _retained_ definition that is itself the exact Direct predecessor:
  provider `direct-manifest` and `(version, sha256)` equal to a row, looked up
  by digest. `require_direct_backup_snapshot` decides from the retained
  definitions of the installs it already enumerates, not from the port id.
- The row set then reads only retained definitions and joins the fence as a
  closed region.

**Excluded from the fence** (live, retired by contracts instead):

- `launch.rs:24-30`, retired by C1.
- `runtime_path_policy.rs:288-293`, `preparation_execution.rs:775-777` and
  `install.rs:6008-6035`, retired by C7 (the frozen rows replace them).
- The `#direct` registry lookups by port id (`persistence.rs:157-196`;
  `service/retained_direct_compatibility.rs:88`), re-keyed by IC-1b before the
  rows join the fence.
- Any Ghostship 3.0.0 _current_ behavior. Production `"ghostship"` literals
  remain in `ghostship_data_store.rs`, `installed_contract.rs`, `library.rs`,
  `operation.rs`, `preparation.rs`, `preparation_readiness.rs` and
  `preparation_ghostship.rs` (measured with the program view's own
  test-item filter on the local merge). Whether each is confined to the 2.0.0
  route is UNKNOWN; each is re-keyed on the retained mode or stays counted.

**Mechanism classification** (not a fence). `title-named-core-item` matches
`jakmods.rs` (OpenGOAL's mod provider) and `ModEngine::DaggerfallUnity`
(`native_mod_list.rs:73`), a mod-format reader, because the catalog dictionary
contains those words. The proposal declares them `named-mechanism` members with
a stated check: the item is selected only through `mod_loader`,
`mod_provider_bindings` or `mod_sources` data and names a format or service.
Whether `jakmods` is selected only that way is UNKNOWN; reading its call sites
settles it. Until then they stay counted.

## One capability assessment

**Today:**

- `service/capabilities.rs` is presentation over results computed in four
  status stages (`service.rs:1181-1261`).
- Each mutation re-derives its own gates. Install: `service.rs:1683`,
  `:3277`, `:3295`. Adopt: `:5408-5410`. Activation: `:7432-7445`. Launch:
  `service/launch_preparation.rs:68-88`. Rollback: `service.rs:4935-4975`.
  Backup: `service/backups.rs:652-671`.
- `scripts/catalog-route-holds.mts` re-implements `acquisition_restriction.rs`
  in TypeScript (`carriers` `:51-74`, `specificity` `:79-85`, `fit` `:94-101`,
  `evaluateCarrier` `:103-118`, `heldAt` `:121-129`).
- `scripts/catalog-acquisition-restrictions.mts:198`, `:292` and `:311`
  mirror validation and `to_restrictions`.
- `catalog-route-fit.mts` and `catalog-generated-registration.mts` consume
  those mirrors.

Known divergences:

- TS reads authored `integration.acquisition_restrictions`; Core reads compiled
  `managed_acquisition_hold`.
- The legacy listing hold id differs: TS `legacy-download-block` at `:59`, Core
  `download` at `:801`.
- TS has no `unverifiable` phase.

There is no cross-language parity test (`catalog-route-fit.test.mts:241-283`
uses hand-written expectations).

### Single Core entry point

`OperationAssessment::assess(subject, operation, context) -> Assessment`, in a
new `operation_assessment.rs`, composes the existing owners. It does not
re-implement them.

**Inputs.**

- **Subject:** a port, a listing, an install or a registration.
- **Operation:** the closed `OperationKind`: download, install, update, adopt,
  activate, prepare, launch, rollback, backup, restore and remove.
- **Context:** the host platform and the library snapshot.

**Returns.**

```text
Assessment {
  outcome: eligible | hold | escalate | unknown,
  reason: stable code,
  authorities: [which owners decided],
}
```

Revision 1 also returned an `inputs_digest`. Nothing consumes it, so it is
dropped. It can be added with its first consumer.

**Owners composed, in the order `service.rs` applies today:**

1. `definition_eligibility`
2. `acquisition_restriction`
3. retained-contract and integrity checks
4. uploader continuity, scoped per [IC-3b](#ic-3b-uploader-continuity-scoped-to-activation-cases-1-2)
5. source assessment, for operations that consume originals
6. launch readiness

**Status consumers.** `with_definition_operations`, `with_port_actions`,
`port_capabilities` and listing status become projections over `Assessment`
values.

**Mutations revalidate.** Each mutation calls `assess` _inside its library
transaction or port lock_ with the same subject and operation. It proceeds only
on `eligible`, and refuses with the same reason otherwise. This generalizes the
conflict re-read that `port_capabilities` already performs
(`capabilities.rs:411-424`). Mutations keep their own _execution_ checks
(integrity, archive safety, consent). Those are not eligibility, and they are
not duplicated into the assessment.

### Maintenance scripts

**Primary route: a generated table produced and verified by a Rust test.**
Core is the only evaluator. TypeScript only reads the table. This follows the
other committed `*.generated` files and the transport schemas, which Rust
produces and CI checks.

Revision 1 recommended calling Core through a new CLI command. That route is
circular and is withdrawn:

- `scripts/catalog-generated-registration.mts` feeds the generated catalog and
  depends on route holds;
- Core evaluates the compiled `managed_acquisition_hold`, which exists only
  after generation;
- it would also add a Rust build to the node-only catalog job.

**Two-phase input, so there is no cycle.**

1. **Input (authored, phase 1).** The table is computed from the _authored_
   restriction carriers that `generate-catalog` reads: each authored port's
   `integration.acquisition_restrictions` and each listing's `restrictions`
   and legacy reason, deserialized with Core's own `AcquisitionRestriction`
   types and evaluated with `EffectiveRestrictions::evaluate`
   (`acquisition_restriction.rs:479-525`). It does not read `catalog.json`.
2. **Output.** `crates/portcove-core/catalog/route-holds.generated.json`:
   format version, then one sorted row per (identity, platform, operation,
   scope) that route fit and generated registration use, with the outcome and
   stable reason code. Rows are emitted for every platform, not only the host
   (`catalog-route-fit.mts:298-300`).
3. **Consumers (phase 2).** `catalog-route-fit.mts`,
   `catalog-generated-registration.mts` and `maintenance-program-view.mts`
   read the table. Generation of `catalog.json` then runs as today.
4. **Consistency (phase 3, Rust).** A second Rust test evaluates the
   _compiled_ `managed_acquisition_hold` of every embedded entry through
   `to_restrictions` (`:878`) and asserts the same outcomes as the table. This
   is the test that catches a TypeScript compilation step that drifts from
   Core.

**Verification.** The Rust test `route_holds_table_is_current` regenerates the
table in memory and fails with a diff when the committed file differs. The
same test writes the file when run in its documented regeneration mode;
IC-2a documents that command in [CATALOG](../CATALOG.md) beside the other
generated catalog files. `generate-catalog --check` reads the table but never
writes it. If an authored carrier does not deserialize into Core's type, the
test fails; that is a divergence to fix, not to tolerate.

**Authoring-time validation.** `checkAcquisitionRestrictions` keeps a
schema-only check. Shape validation is not eligibility.

**Why not a TypeScript rules table.** It keeps a second evaluator. The
generated table carries outcomes, not rules, so TypeScript evaluates nothing.

### Parity test (first step, before any deletion)

`scripts/catalog-assessment-parity.test.mts` compares the TypeScript `heldAt`
with the Rust-generated table over the whole catalog, every platform and every
operation route fit uses. It asserts equality, and lists the known divergences
above as explicit expected differences, each with an issue link. Each listed
divergence is then fixed or ruled correct before the TypeScript evaluator is
deleted.

## Compatibility and rollout order

Classification of each change:

| Change                                                                                           | Class                                                                                                                                                                        | Reader generation needed                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| IC-1 frozen fence; program-view categories                                                       | Tooling and Core-internal (guards re-keyed on retained keys; no behavior change)                                                                                             | No                                                                                                                                         |
| IC-1b direct-guard re-keying                                                                     | New definition feature used only by one embedded entry; Core-internal re-keying                                                                                              | No published entry uses it; embedded entry ships with its reader                                                                           |
| IC-2 generated assessment table; parity; Core                                                    | Tooling (Rust-generated, committed table) and Core-internal                                                                                                                  | No                                                                                                                                         |
| IC-3 operation-scoped eligibility                                                                | Core-internal behavior change; trust-sensitive                                                                                                                               | No                                                                                                                                         |
| IC-4 (C8) binding migration                                                                      | **Library schema 78, one-way.** Recipe format unchanged; the holds file unchanged                                                                                            | No definition change; older clients cannot open a migrated library ([database and migrations](../ARCHITECTURE.md#database-and-migrations)) |
| IC-5 (C7 phase A) frozen exception rows                                                          | Core-internal data, closed                                                                                                                                                   | No                                                                                                                                         |
| C1-C6, C7 phase B                                                                                | New definition features. Embedded catalog entries can use them in the same release, because the embedded catalog ships with its reader.                                      | Yes, for _published/live_ definitions                                                                                                      |
| TRANSPORT: generated transport types and schemas (IC-8, and any contract exposed to the desktop) | Generated TypeScript/JSON regenerated from the Rust types in the same pull request (`pnpm run transport:check`); additive fields only, retired enums kept as read-only types | No; the desktop ships with its Core                                                                                                        |
| Package-shape derivation inputs (IC-8, IC-9, IC-11)                                              | Script inputs under the [compatibility encoding](#retained-compatibility-encoding); digests unchanged                                                                        | No                                                                                                                                         |
| Authoring shorthands that expand to new fields                                                   | Authoring-only                                                                                                                                                               | No; the generated catalog changes only when the field is adopted                                                                           |

**Order for reader-gated contracts:**

1. **Reader release.** Merge the reader for C1-C6 and C7B, with validators,
   features, retained translations and tests. Embedded catalog entries migrate
   in the same pull request, because they ship with their reader.
2. **Released preview.** The reader reaches a released preview. That preview's
   generation is recorded as the _minimum supported generation_ for definitions
   using these features. It joins the compact-listing minimum from lead
   decision 1 on #1422, so there is one minimum.
3. **Publisher migration.** Only then may the publisher migrate _published_
   definitions. Today these are the two DUDE Doom 3 definitions carrying
   `doom3-linux-v1`.
   - A schema-4 entry names the new feature. Older readers record
     `engine_capability_required` for that one definition and keep siblings
     usable (`definition_entry.rs:195-204`; `definition_refresh.rs:54-58`).
   - Older readers keep their stored definitions and installed state, and
     update the application.
4. **Old field stays readable.** Publication does not delete the old field from
   _retained_ contracts. The read boundary keeps translating it indefinitely,
   subject to each region's end-of-life.

Authoring refuses the retired fields for new definitions after step 1:
`external_profile_policy`, `managed_initialization`, `runtime_data_policy`,
`managed_shared_preferences` variants, `windows_tracked_handoff` and
`windows_shipwright_persistence`. This mirrors how
`retired_creation` refuses `managed_build` (`definition_entry.rs:340-342`).

## Implementation breakdown

Each pull request owns all consumers of its mechanism: authoring, generation,
validation, runtime, retained state, transport, scripts, docs and program
view. Every migration pull request (IC-6 to IC-12) also carries the
[compatibility parity tests](#retained-compatibility-encoding).

**Gate method.**

- **Baseline: 404/460, measured** on a local merge of `f8799fb31` with #8618
  and #8625 (see [measured starting point](#measured-starting-point)). At
  `f8799fb31` alone it is 343/460. If either pull request changes before
  merging, re-measure.
- Each of the 56 remaining identities is assigned below to the pull request
  that removes its last authority kind. The numbers are estimates until each
  pull request records its actual program-view result. A denominator change
  from new enrollments shifts them.

### Start first

These four need no definition schema change, are independent of each other,
and retire authority or a distinction failure directly. Each brief below can
be pasted as a worker assignment. Every brief shares these rules:

- Read [AGENTS.md](../../AGENTS.md), this document's sections named in the
  brief, and the owning issue (#1422; #921 for retained state).
- Branch from current `main`. Re-verify every cited `file:line` on it before
  editing; the citations here refer to `f8799fb31`.
- Own only the listed files. If another open pull request writes one of them,
  stop and report instead of editing.
- Return a pushed draft pull request and a report (head SHA, program-view
  before and after, tests added). Do not wait on CI, review or merge.

#### IC-2a Rust-verified route-holds table and parity test

- **Goal.** Make Core the only acquisition-restriction evaluator that
  maintenance scripts depend on, without deleting anything yet.
- **Read:** [one capability assessment](#one-capability-assessment), in
  particular [maintenance scripts](#maintenance-scripts).
- **Files owned:**
  - New Rust test module in `crates/portcove-core/src/` (for example
    `route_holds_table_tests.rs`) that reads the authored carriers under
    `crates/portcove-core/catalog/` and writes or verifies
    `crates/portcove-core/catalog/route-holds.generated.json`.
  - The new generated file.
  - New `scripts/catalog-assessment-parity.test.mts`.
  - `docs/CATALOG.md`: the table's regeneration command and contract, beside
    the other generated catalog files.
  - Validation plan / test-impact wiring only as needed for the new file
    (`scripts/validation-plan.mts`, `scripts/rust-test-impact.mts`).
- **Not owned:** `acquisition_restriction.rs` semantics,
  `catalog-route-holds.mts`, `catalog-route-fit.mts`,
  `catalog-generated-registration.mts` (IC-2b changes them).
- **Acceptance evidence:**
  - `route_holds_table_is_current` fails on a stale table and passes on the
    committed one.
  - The phase-3 consistency test: for every embedded entry, the compiled
    `managed_acquisition_hold` evaluates to the same outcomes as the table.
  - The parity test compares TypeScript `heldAt` with the table over every
    identity, platform and route-fit operation. Every difference is listed as
    an expected divergence with an issue link (at least: authored vs compiled
    input, `legacy-download-block` vs `download`, the missing `unverifiable`
    phase).
  - Route fit and the program view are byte-identical before and after.
- **Retires:** nothing yet; it creates the single source that IC-2b switches
  to. **Gate:** +0.
- **Review:** independent reviewer.

#### IC-1 Frozen fence: DKR, legacy cartridge and library import

- **Goal.** Re-key three historical regions on retained keys, declare them
  frozen, and teach the program view the `frozen_historical` category.
- **Read:** [declared frozen historical recovery](#declared-frozen-historical-recovery).
- **Files owned:**
  - DKR: `install.rs` (`legacy_dkr_artifact`, `:4183-4206`: drop the
    `"dkr-r"` id test; the digest row match decides); `legacy_dkr/README.md`.
  - Legacy cartridge: `cancellation.rs`, `install.rs`,
    `legacy_cartridge_cleanup.rs`, `recovery.rs` (replace `cvlod-recomp` id
    tests with the recorded recipe), `cartridge_build.rs`,
    `legacy_cartridge/README.md`.
  - Library import: `library_import.rs:22-42` (replace
    `embedded.id == "snap64-recomp"` with the frozen Snap64 package digest
    list); `historical-artifacts.json#packages` (new Snap64 rows, derived
    from catalog history) and `historical_artifacts.rs`.
  - Program view: `scripts/maintenance-program-view.mts` and its test, and
    `docs/MAINTENANCE-STORE.md` (program cutover view): the
    `frozen_historical` attribute with `guard`, `fence`, `tests` and
    `end_of_life`; a row-set hash per region; detector failures as listed in
    the fence section.
- **Not owned:** `persistence.rs` and the `#direct` rows (IC-1b); Ghostship
  files (IC-12); `launch.rs` (IC-6).
- **Acceptance evidence:**
  - For each region, the three guard-predicate tests: every embedded entry
    with the region's id, and an unfamiliar current definition copying that
    id, never enter; a retained-key fixture enters and behaves as today; the
    id without the key does not enter.
  - Existing tests unchanged and passing: `install.rs` `legacy_dkr_tests`,
    `historical_artifacts.rs:220-279`,
    `cancellation_managed_builder_tests.rs`, `library_import.rs:44-56` and
    `:767-950`.
  - The program view reports `frozen_historical` separately, fails on a new
    literal outside regions, and fails when a region's rows change without a
    doc update.
- **Retires:** live-authority counting for dkr-r, cvlod-recomp,
  dr-mario-nes-recomp, earthbound-recomp, gundam-wing-endless-duel-recomp,
  render96ex and yoshis-cookie-recomp, and the Snap64 id literal in
  `library_import.rs`. **Gate:** +7 → about 411, if the `CartridgeBuildRecipe`
  variants and cartridge module stems are inside the declared region.
- **Review:** independent reviewer.

#### IC-5 Frozen byte-bound exception rows (C7 phase A)

- **Goal.** Replace three id-and-digest pins with a closed, frozen row set
  keyed only by artifact bytes.
- **Read:** [C7](#c7-byte-bound-artifact-exceptions-runtimeartifact-exceptions-v1).
- **Files owned:** `historical-artifacts.json` (new
  `#artifact_exceptions` section, exactly 3 rows) and
  `historical_artifacts.rs`; `runtime_path_policy.rs:288-293` and its callers'
  argument (`install.rs:991`, `:5076`; `service.rs:1748`;
  `output_relocation.rs:502`; `transfer_copy.rs:314`; `library_transfer.rs:53`;
  `library_import.rs:333`); `preparation_execution.rs:775-777`;
  `install.rs:6008-6035` (`reviewed_g_diffuser_cache`); program-view
  declaration of the section as a closed frozen region.
- **Not owned:** definition types (phase B is IC-12); `catalog.rs`
  (`ROM_PATCH_FIXTURE_PORT`, IC-12).
- **Acceptance evidence:**
  - Parity: Diablo destination reservation, the OpenGOAL empty-scaffold
    discard, and the two G-Diffuser cache files reported as reviewed, all as
    today.
  - Unfamiliar-identity scenario: the same bytes under an unfamiliar fixture
    id get each behavior; different bytes under the original ids do not.
  - The detector fails when a fourth row is added.
- **Retires:** the three pins. **Gate:** +1, alexbeav-diablo-recomp
  (cumulative about 412 after IC-1). opengoal-jak1 and g-diffuser stay counted for
  other kinds (IC-12).
- **Review:** independent reviewer.

#### IC-3a Retained operations do not consult the current catalog (cases 4 and 5)

- **Goal.** Backup, restore, launch and removal of an existing installation
  read its retained contract, and a pre-contract install keeps whole-directory
  backup, whether or not the current catalog still has the port or has gained
  policy fields.
- **Read:** distinction 4, [blanket refusals](#where-missing-optional-evidence-becomes-a-blanket-refusal-today)
  cases 3-5, and [pre-contract manifests](#installed-state-and-the-readmigration-boundary).
- **Files owned:** `service.rs` (`installed_catalog_or_fallback` `:7550-7579`,
  `prepare_launch` `:7017`, `preview_removal` `:5606`, `remove` `:5716`);
  `service/backups.rs` (`:659`, `:917`, `:927`, `:1410`, `:1516`, `:1637`,
  `:1874`); ARCHITECTURE
  [backup service](../ARCHITECTURE.md#backup-service-ownership) and
  [definition operation eligibility](../ARCHITECTURE.md#definition-operation-eligibility).
- **Not owned:** rollback target selection (`service.rs:4935-5030`): the
  comment at `:4989-4991` records a product decision. Rollback of a departed
  port is included only if the lead records that decision on #1422 first;
  otherwise rollback stays held and the brief says so. Uploader continuity
  (IC-3b, critical reviewer).
- **Acceptance evidence:** for each operation, a test with the port removed
  from the current catalog and one with the current port carrying a policy
  field the retained one lacks:
  - backup, restore, launch of the active build and removal proceed on the
    retained contract;
  - a pre-contract install backs up and restores as a whole directory, while
    collectible-data review, folder sync and restore deletion hold with a
    reason naming the missing contract;
  - new acquisition, update and successor selection stay held.
- **Retires:** two of the seven blanket refusals. **Gate:** +0 (distinction
  repair).
- **Review:** independent reviewer.

### Can start after the first four

#### IC-1b Re-key the direct data guard on declared data

- **Files:** `types.rs` (`predecessor_data_guard_v1`),
  `definition_capabilities.rs` (`staged.predecessor-data-guard-v1`),
  `definition_entry.rs:594`, `persistence.rs:157-196`,
  `service/retained_direct_compatibility.rs`,
  `service/backups/guarded_archive.rs:126`, `:160`, `test_fixture.rs:571`,
  the S3K authored definition, `historical_artifacts.rs` (lookup by digest),
  [CATALOG](../CATALOG.md), program view (`#direct` declared frozen).
- **Acceptance:** for all four identities, the guard and the backup-snapshot
  checks give the same results as today for current definitions and for
  retained Direct installs; an unfamiliar fixture declaring the field gains
  the guard; the S3K current definition without the field loses it; no
  `#direct` lookup takes a port id.
- **Gate:** +4 (cumulative about 416): sonic-3-and-knuckles-recomp,
  sonic-the-hedgehog-recomp, super-metroid-recomp, mega-man-x2-snes-recomp.

#### IC-2b Retire the TypeScript evaluator

- **Files:** `catalog-route-fit.mts`, `catalog-generated-registration.mts`,
  `maintenance-program-view.mts` read the table; delete
  `catalog-route-holds.mts` `heldAt`/`evaluateCarrier` and the mirror in
  `catalog-acquisition-restrictions.mts:198`, `:292`, `:311` (keep the schema
  check).
- **Acceptance:** parity test retired with zero open divergences; route fit
  and program view byte-identical except documented fixes. **Gate:** +0.

#### IC-2c One Core assessment

- **Files:** new `operation_assessment.rs`; status stages
  (`service.rs:1181-1261`) and each mutation gate listed in
  [today](#one-capability-assessment) call it.
- **Acceptance:** status and mutation outcomes identical over the existing
  service suites; each mutation re-assesses inside its lock. **Gate:** +0.
  Independent of IC-2b.

#### IC-3b Uploader continuity scoped to activation (cases 1, 2)

- **Files:** `release/uploader_continuity.rs`, `service.rs:7432-7445`,
  `:5017-5030`, `profile_deploy.rs:2763-2767`, `service/game_settings.rs:573`,
  `game_settings/activation_deletion.rs:85`, `retained_build.rs:429`,
  `recovery.rs`.
- **Review:** critical reviewer (trust boundary). **Gate:** +0.

#### IC-3c Remaining refusals (cases 3, 6, 7)

- Case 3 with the pre-contract rule; case 6 with IC-9; case 7 narrows the
  Ghostship inspection-error hold to the data-transforming route.
  **Gate:** +0.

#### IC-4 Recorded mod-provider bindings (C8), library schema 78, one-way

- **Files:** `provider_install.rs`, `provider_binding.rs`,
  `provider_auto_update.rs` (`hold_scope` rule), `provider_browse.rs`,
  `thunderstore.rs`, `database.rs` (migration 78), `profile.rs`,
  `library_import.rs` and `recipe.rs` import, `profile_loader.rs`
  (`legacy_loader` behind its retained guard), `native_mod_list.rs`; program
  view (provider-binding-table members declared retired).
- **Acceptance:** the [forward-upgrade test](#c8-recorded-mod-provider-bindings-library-migration-no-definition-change)
  from schema 77; new installs record exact bindings; the
  unfamiliar-identity scenario gets provider install, browse and auto-update
  from `mod_provider_bindings` with no table; current definitions cannot reach
  `legacy_loader`.
- **Gate:** +1 → zelda64-recomp.

### Needs the next reader generation (one coordinated reader release)

These pull requests may merge independently. They become usable for
_published_ definitions together, at the next minimum generation.

#### IC-6 Process handoff (C1)

- **Files:** `types.rs`, `definition_capabilities.rs`,
  `definition_entry.rs:436-447`, `launch.rs`, `installed_mutability.rs`
  (encoding), the read-boundary translation, authoring for the 8 entries,
  transport regeneration, [CATALOG](../CATALOG.md) and
  [DEFINITION-DELIVERY](../DEFINITION-DELIVERY.md).
- **Acceptance:** unfamiliar identity gains capability 35 and returns to 28;
  parity 7 × 28, Snap64 × 35; retained `windows_tracked_handoff: true`
  translates; compatibility parity tests; a test that the tracked set is
  unchanged for both values.
- **Gate:** +1 → snap64-recomp (needs IC-1).

#### IC-7 Launch environment contributions (C2)

- **Files:** `types.rs`, the feature, `adapter.rs:289-302`, authoring,
  transport regeneration.
- **Acceptance:** unfamiliar-identity scenario; `USER=PLAYER` on Windows and
  Linux for CorsixTH; `launch_environment` rules and the loader deny-list
  unchanged (existing tests pass untouched). **Gate:** +0 alone.

#### IC-8 External roots and check kinds (C3)

- **IC-8a. Reader, check kinds, translation table.** New `external_roots.rs`,
  check-kind modules named by mechanism, `install.rs`, `release.rs`,
  `managed_runtime_policy.rs`, `service.rs:6440-6463`,
  `installed_mutability.rs` (encoding); the frozen translation of all 18
  policy values; the normative path, link, overlap, `reserve-directory` and
  write/delete rules, each with refusal tests (device names with extensions,
  trailing dot or space, `\\?\` and `\\.\`, UNC, relative and non-normalized
  environment values, a symlink or junction at the root, at an ancestor and
  inside the walk, an existing reserve path that is a link, foreign-owned or
  group-writable).
- **IC-8b. Migrate the 25 entries and OpenSC2K.** Authoring and generation;
  delete the 11 resolver modules and `ExternalProfilePolicy` from live code;
  every consumer in the [C3 consumer table](#c3-external-roots-and-typed-checks-nativeexternal-roots-v1):
  transport regeneration (`apps/desktop/src/transport-types.generated.d.ts`,
  `transport-schemas.generated.json`, `transport-host-output.generated.json`),
  `scripts/package-shape-baselines.mts`,
  `scripts/catalog-literal-launch-publication.mts`,
  `scripts/scheduled-package-drift.test.mts`,
  `scripts/catalog-openmohaa-portable.mts`, `scripts/maintenance-program-view.mts`
  and their tests.
- **Acceptance:** per-policy parity (each existing module test against the
  translated roots: identical roots, refusals and arguments); compatibility
  and derivation-digest parity; unfamiliar-identity scenario per check kind; a
  retained DUDE Doom 3 contract with `doom3-linux-v1` launches through the
  translation.
- **Gate:** +26 → the 25 policy identities and nicholas-ochoa-opensc2k
  (CorsixTH needs IC-7).
- **Precondition:** the lead's decision on #8622's two kept pins.

#### IC-9 Player-data roles (C4)

- **Files:** `portable_saves.rs`, `service/portable_saves.rs`,
  `service/portable_save_folder.rs`, `profile_deploy.rs`,
  `installed_mutability.rs`, `runtime_data_policy.rs`,
  `managed_shared_preferences.rs`, `install.rs:2775-2780`, `:3879-3900`,
  `service.rs:5750-5755`, `:7670`, `service/removal.rs:202-205`, authoring for
  3 entries, transport regeneration.
- **Acceptance:** Shipwright persistence suite
  (`service/shipwright_persistence_tests.rs:111-771`) on the data path;
  RaceWave credential exclusion and RE Gaiden export tests; role-effect tests
  per table row; overlap refusal; a lowered role without a transition record
  is treated under the retained role; compatibility parity.
- **Gate:** +2 → shipwright (with IC-4), wave-race-64-racewave46.

#### IC-10 Seeded files and signatures (C5)

- **Files:** `managed_initialization.rs`, `managed_chocolate.rs`,
  `managed_tfe.rs`, `adapter.rs:448`, `install.rs:1172-1183`, `:5444`,
  `managed_runtime_policy.rs:181-184`, authoring.
- **Acceptance:** seeded bytes, arguments and screenshot patterns per
  Chocolate executable; TFE pilot signature; never rewrite an existing file;
  compatibility parity.
- **Gate:** +4 → chocolate-doom-family, chocolate-heretic, chocolate-hexen,
  the-force-engine-dark-forces.

#### IC-11 Shared write scope v2 (C6)

- **Files:** `external_runtime/shared_preferences.rs` (and `/smb1r.rs`),
  `managed_shared_preferences.rs`, the consent review in `service.rs`
  (`:1775-1864`, `:4220-4259`), the Tauri disclosure (copy owned by
  CONTENT-DESIGN), transport regeneration.
- **Acceptance:** consent fingerprint parity; unfamiliar-identity scenario.
- **Review:** critical reviewer. **Gate:** +2 → resident-evil-gaiden-recomp
  (with IC-9), super-mario-bros-remastered.

#### IC-12 Exceptions phase B (C7B) and residuals

- **C7B:** definition-carried `artifact_exceptions`; the three current
  definitions declare their rows; the bundled section becomes retained-only.
- **Residuals** (8 identities):

| Identity                                                                 | Route                                                                                                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| surge-the-rabbit-opensurge                                               | Rename `KnownFailureCause::OpenSurgeUserDataPath` to a generic cause with a decode alias at the failure-wire read boundary. Needs an API schema note. |
| g-diffuser                                                               | IC-5 removes the cache pin; gate `ROM_PATCH_FIXTURE_PORT` (`catalog.rs:2457`) under the qualification-fixtures feature, or move it to test data       |
| yu-gi-oh-forbidden-memories-recompiled                                   | Move the qualification-fixture title code to fixture data                                                                                             |
| opengoal-jak1, opengoal-jak2, opengoal-jak3, interkarma-daggerfall-unity | Named-mechanism classification, subject to the call-site check in [mechanism classification](#declared-frozen-historical-recovery)                    |
| ghostship                                                                | Re-key the production literals on the retained mode; each one confined or counted                                                                     |

- **Gate:** up to +8 → 460/460, if every UNKNOWN resolves favorably.

### Summary

| PR          | Mechanism                                | Schema                  | Entries            | Gate after (estimate) |
| ----------- | ---------------------------------------- | ----------------------- | ------------------ | --------------------- |
| (merged)    | #8622                                    | no                      | —                  | 343 (measured)        |
| (in flight) | #8618, #8625                             | no                      | —                  | 404 (measured)        |
| IC-2a       | Rust-verified route-holds table, parity  | no                      | whole catalog      | 404                   |
| IC-1        | Fence: DKR, cartridge, library import    | no                      | 7 identities       | 411                   |
| IC-5        | Frozen exception rows (C7A)              | no                      | 3 artifacts        | 412                   |
| IC-3a       | Retained operations (cases 4, 5)         | no                      | all installs       | 412                   |
| IC-1b       | Direct guard on declared data            | embedded feature        | 4                  | 416                   |
| IC-2b, 2c   | Retire TS evaluator; one Core assessment | no                      | whole catalog      | 416                   |
| IC-3b, 3c   | Uploader continuity; cases 3, 6, 7       | no                      | all installs       | 416                   |
| IC-4        | Recorded provider bindings (C8)          | **library 78, one-way** | 2 plus stored refs | 417                   |
| IC-6        | Process handoff (C1)                     | reader                  | 8                  | 418                   |
| IC-7        | Environment contributions (C2)           | reader                  | 1                  | 418                   |
| IC-8a/b     | External roots (C3)                      | reader + transport      | 26                 | 444                   |
| IC-9        | Player-data roles (C4)                   | reader + transport      | 3                  | 446                   |
| IC-10       | Seeded files (C5)                        | reader                  | 4                  | 450                   |
| IC-11       | Shared write scope v2 (C6)               | reader + transport      | 2                  | 452                   |
| IC-12       | Exceptions B (C7) and residuals          | reader / mixed          | 8                  | up to 460             |

**Dependency order.**

- IC-2a, IC-1, IC-5 and IC-3a are independent and start now.
- IC-1b, IC-3b, IC-3c and IC-4 can start at any time; IC-3b needs a critical
  reviewer.
- IC-2b depends on IC-2a. IC-2c is independent of both.
- IC-6, IC-7 and IC-8a can proceed in parallel. IC-6 needs IC-1 for its gate
  credit. IC-8b depends on IC-8a and the #8622 decision.
- IC-9 depends on IC-4 (Shipwright's binding first).
- IC-11 depends on IC-9 (the RE Gaiden graphics exports move first).
- IC-12 comes last; its g-diffuser row needs IC-5.

## Alternatives rejected

- **A scripting language, hook commands or a step interpreter.**
  - Excluded by the owner: no general scripting, no arbitrary shell hooks and
    no other planner.
  - It would move trust review from closed Core checks to arbitrary programs.
    Definitions are signed for _who_ authorized them, not for safety
    ([DEFINITION-DELIVERY](../DEFINITION-DELIVERY.md#identities-and-five-independent-facts)).
  - The check-kind list in C3 is the bounded alternative.
- **Per-title capability variants** (the status quo pattern, such as
  `ExternalProfilePolicy::VcmiWindowsV1`).
  - Each variant is reviewed behavior compiled into Core, so an unfamiliar
    identity can never gain it through data. That fails the completion test by
    construction.
  - 18 policies serve 25 entries; only 4 policies are shared at all
    (doom3 ×4, openmohaa ×3, openjk ×2, recomp-appimage ×2).
- **Leaving the pins and declaring them reviewed.** This does not meet the
  completion test. It also keeps the program view's gate permanently failing
  for those identities without distinguishing history from live authority.
- **Moving pins into package-shape asset names** (#8622 "needs a design
  decision"). This replaces an identity literal with another identifying
  literal, which the owner rules insufficient.
- **Keying Snap64 on `user_data_environment == "SNAP_DATA_DIR"`.** Same
  reason: an identifying literal.
- **Rewriting stored profile revisions to add bindings.** It breaks
  append-only digests (`profile.rs:1641-1648`) and the precedent at
  `database.rs:625-629`.
- **Translating retained contracts by rewriting manifests.** It changes
  `installed_contract_sha256`, which retained builds, recipes and profiles
  reference. Translate on read instead.
- **A generated TypeScript rules table for eligibility.** It keeps a second
  evaluator ([one capability assessment](#one-capability-assessment)).
- **Calling Core through a bulk CLI command from the catalog scripts**
  (revision 1's recommendation). It is circular: generated registration feeds
  the generated catalog and needs route holds, while Core evaluates the
  compiled hold that exists only after generation. It also adds a Rust build to
  the node-only catalog job. The [Rust-verified table](#maintenance-scripts)
  replaces it.
- **Fencing `historical-artifacts.json#direct` as historical** (revision 1).
  A current definition reads it by port id, so it is live authority until
  [IC-1b](#ic-1b-re-key-the-direct-data-guard-on-declared-data) re-keys it.
- **A static call-graph proof that frozen regions are unreachable.** Ordinary
  entry points legitimately call them; the guarantee that matters is that the
  guard rejects current definitions, which guard-predicate tests prove.

## Open risks and unknowns

| Item                                                                                              | Status                                   | What settles it                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #8622's two kept pins (Dune Dynasty, fheroes2): is a definition-declared root binding sufficient? | Lead decision                            | The lead records the decision on #8622. C3's argument is in [C3](#c3-external-roots-and-typed-checks-nativeexternal-roots-v1).                                      |
| Rollback of a port absent from the current catalog (`service.rs:4989-4991`)                       | Lead decision                            | Recorded on #1422 before IC-3a includes rollback                                                                                                                    |
| "Never active" is not a recorded fact for the IC-3b uploader-continuity narrowing                 | UNKNOWN                                  | Read `InstallRecord` and the activation history. If absent, IC-3b keeps the hold for rollback and narrows only active-build launch and file-only settings recovery. |
| Ghostship production literals confined to the 2.0.0 route                                         | UNKNOWN                                  | Re-key each on the retained mode (IC-12); any that cannot be stays counted                                                                                          |
| `jakmods` selected only through definition data                                                   | UNKNOWN                                  | Read its call sites                                                                                                                                                 |
| Whether other tracked-handoff upstreams exit before their successor joins                         | UNKNOWN                                  | Native launch-tree observation per entry                                                                                                                            |
| The exact pre-handoff Snap64 package digests                                                      | To derive                                | IC-1 reads catalog history for the Snap64 releases offered before `windows_tracked_handoff`                                                                         |
| GB Recompiled fallback expressible as an ordered candidate list                                   | UNKNOWN                                  | Full read of `managed_shared_preferences.rs`                                                                                                                        |
| `regaiden-gbc` materialization is title-specific                                                  | UNKNOWN                                  | Read the transform implementation                                                                                                                                   |
| Authored restriction carriers deserialize into Core's `AcquisitionRestriction`                    | UNKNOWN                                  | IC-2a's table test; a failure is a divergence to fix                                                                                                                |
| Check-kind list completeness for the 11 modules                                                   | Risk                                     | IC-8a's per-policy parity tests. A behavior that fits no kind is either a new kind with its own consumer or stays a declared historical translation.                |
| Gate estimates                                                                                    | Estimates from a measured 404 baseline   | Each pull request records the actual program-view result                                                                                                            |
| Older previews lose live updates for definitions adopting new features                            | Accepted (owner compatibility amendment) | One minimum supported generation, shared with the compact-listing cutover                                                                                           |

**Settled in revision 2** (kept so a later reader does not repeat the search):

| Item                                             | Finding                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Removal consults the current catalog             | Yes: `preview_removal` (`service.rs:5606`) and `remove` (`:5716`); now case 4                                    |
| Auto-update hold scopes persisted                | Yes, in `auto-update-holds.json` (`provider_auto_update.rs:35`); C8 keeps every key byte-identical               |
| Node script tests need a built CLI binary        | No longer applies: the [generated table](#maintenance-scripts) is produced by a Rust test and read by TypeScript |
| Static proof that frozen regions are unreachable | Not needed: replaced by [guard-predicate tests](#declared-frozen-historical-recovery)                            |
| CorsixTH on Windows reads `USERNAME`             | Not needed for parity: C2 sets `USER=PLAYER` on both platforms, as today                                         |
