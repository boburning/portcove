# Supported capability contracts as the unit of integration (design, November 23, 2026)

**Proposed design, revision 1.** Nothing here is implemented or activated.
The [catalog contract](../CATALOG.md#integration-ownership), the
[definition delivery contract](../DEFINITION-DELIVERY.md) and the
[architecture](../ARCHITECTURE.md) remain the current contracts until each
step below lands through its own pull request.

- **Owning work:** [#1422](https://github.com/boburning/portcove/issues/1422)
  (dynamic native ports program; batch 1 "Contracts" in the lead's mechanism
  map of 2026-11-23) and [#921](https://github.com/boburning/portcove/issues/921)
  (definition delivery and retained installed contracts).
- **Source:** `main` at `47f824704`.
- **In flight:** these open pull requests are not merged at that commit, and
  this document builds on them:
  - [#8618](https://github.com/boburning/portcove/pull/8618) (identity pins → declared contract; test-only `cfg` classification)
  - [#8622](https://github.com/boburning/portcove/pull/8622) (external-profile policies bound to the definition; step 1)
  - `feature/1422-retire-family-generator-literals`
- **Line numbers:** every file:line citation refers to `47f824704`. Core paths
  are relative to `crates/portcove-core/src/` unless stated otherwise.

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
| Trace remaining title-specific behavior                                                 | [Measured starting point](#measured-starting-point) lists all 117 identities that fail the retired-authority gate, with their authority kinds. [Implementation breakdown](#implementation-breakdown) assigns every identity to the pull request that retires its authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The missing concepts                                                                    | Eight concepts:<br>- **Process handoff:** [C1](#c1-process-handoff-launchprocess-handoff-v1)<br>- **Launch environment contributions:** [C2](#c2-launch-environment-contributions-launchenvironment-contributions-v1)<br>- **External roots with typed checks** (covers external save locations and root resolution): [C3](#c3-external-roots-and-typed-checks-nativeexternal-roots-v1)<br>- **Player-data roles** (covers generated-data ownership, save-file role maps and runtime credentials): [C4](#c4-player-data-roles-dataroles-v1)<br>- **Seeded files** (covers managed initialization): [C5](#c5-seeded-files-and-file-signature-checks-stagedseeded-files-v1)<br>- **Shared write scopes:** [C6](#c6-shared-write-scope-stagedshared-write-scope-v2)<br>- **Byte-bound artifact exceptions** (covers artifact-specific restrictions): [C7](#c7-byte-bound-artifact-exceptions-runtimeartifact-exceptions-v1)<br>- **Exact mod-provider bindings:** [C8](#c8-recorded-mod-provider-bindings-library-migration-no-definition-change) |
| Six areas                                                                               | The [contract map](#contract-map) lists the existing contracts and the missing concepts for each area.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Core implements and validates supported combinations; definitions supply facts          | Each contract states what Core validates (adapters, platforms, interaction with other contracts) and what it selects. No contract carries code, paths outside closed bases, shell text or an open check vocabulary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Keep composition within reviewed capabilities                                           | A combination table per contract. Combinations not listed are refused by `Catalog::validate` and by indexed-entry inspection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Preserve the five distinctions                                                          | [The five distinctions](#the-five-distinctions-in-todays-code) gives each distinction's home, its conflations (cited) and the rule its consumers follow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Missing optional evidence is not a blanket refusal                                      | Seven current cases are cited, with the corrected per-operation rule. Pull request [IC-3](#ic-3-operation-scoped-eligibility-for-existing-installations) repairs them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
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

`node scripts/maintenance-program-view.mts --json` on `47f824704`:

| Gate                | Numerator / denominator (version)              | Ratio  | Failing |
| ------------------- | ---------------------------------------------- | ------ | ------- |
| `fitting`           | 777 / 1624 (`program-view/in-scope/1`)         | 0.4784 | 847     |
| `retired-authority` | 343 / 460 (`program-view/in-scope-enrolled/1`) | 0.7457 | 117     |

The retired-authority gate reports no unknown kinds.

Per-kind authority counts:

| Kind                                   | State   | Entries | Files | Identities                                    | Members (rows)                                                                                                  |
| -------------------------------------- | ------- | ------- | ----- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `core-title-literal`                   | active  | 37      | 37    | 60                                            | —                                                                                                               |
| `title-named-core-item`                | active  | 61      | 22    | 33                                            | —                                                                                                               |
| `family-generator-script`              | active  | 14      | 14    | 52                                            | —                                                                                                               |
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
    `native_portable_data.rs:217-226` and `adapter.rs:288-300`.
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
| 4   | Port absent from the current catalog                                                                                                                                         | Backup, restore, rollback and `prepare_launch` (see distinction 4)                                                                                                                                                                                                                                                               | Absence withholds new acquisition and successor selection only. Retained operations proceed on the retained contract. The comment at `service.rs:4989-4991` ("a retained contract proves the target's identity, not a newly offered rollback route") is an explicit product decision to revisit: rollback to a retained, already-verified build offers no new route.                                    |
| 5   | Legacy install with no retained catalog where the current port gained policy fields (`service.rs:7559-7574`)                                                                 | Every operation that uses `persistence_contract_for_install`, including backup                                                                                                                                                                                                                                                   | Same as case 3: the historical reader, not the current port.                                                                                                                                                                                                                                                                                                                                            |
| 6   | Shipwright version or asset outside "stable 9.x / `soh-*-win64.zip`" (`installed_mutability.rs:53-83`)                                                                       | Launch mutability qualification (`service/launch_preparation.rs:75`) and backup, through `checked_port` (`:93-99`)                                                                                                                                                                                                               | Retired with [C4](#c4-player-data-roles-dataroles-v1). The role map is read from the retained contract; a version outside a declared version set withholds only progress copy, the one operation the role map's version scope concerns.                                                                                                                                                                 |
| 7   | Ghostship data-compatibility inspection error (`service.rs:3012-3016`, `:4999-5008`; `service/launch_preparation.rs:69`)                                                     | Launch and rollback held with `UnsafeData`                                                                                                                                                                                                                                                                                       | Correct when inspection _found_ incompatible data. An inspection _error_ (unknown) should hold only the data-transforming route. Fenced as historical in [IC-1](#ic-1-frozen-historical-fence-and-program-view-category); the narrowing is part of [IC-3](#ic-3-operation-scoped-eligibility-for-existing-installations).                                                                               |

Not found, recorded so a later reader does not repeat the search: an unknown
`support_tier` or qualification record, an absent release observation
(`service.rs:3072-3073` explicitly does not infer Update eligibility) or a
missing route fact does not refuse backup, launch or removal. Typed
restrictions exclude removal, rollback and backup by design
(`acquisition_restriction.rs:50-51`, `:79-91`).

**UNKNOWN:** whether removal execution (`service.rs:5703`) requires
`self.catalog.port`. Reading that path settles it.

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
- **`runtime_source_materialization`** (85 entries).
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
  `adapter.rs:288-300` inserts `USER=PLAYER` for `corsixth-corsixth` because
  "CorsixTH's blank player name expects USER or USERNAME before its own PLAYER
  fallback". The existing `launch_environment` field cannot carry it, for two
  reasons:
  - launch values allow only port-prefixed names or `PYTHONDONTWRITEBYTECODE`
    ([launch value rules](../CATALOG.md#package-and-launch-declaration-compatibility));
  - `validate_layout` forbids any `launch_environment` with an external
    profile (`native_external_profile.rs:212`).
- **Launch-argument injection** for external roots: Doom 3
  `+set fs_configpath`/`fs_savepath` (`native_external_profile/doom3_linux.rs:171-180`),
  vkQuake `-userdir .` (`adapter.rs:422-427`) and JGRPP `-X`
  (`adapter.rs:428-432`). Merged into
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
  - Identity pins at `native_external_profile.rs:119-199` and in submodules.
    #8622 removes 12 of them and keeps Dune Dynasty and fheroes2.
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

**Retained contract.** It records the value.

**Read boundary.** A retained definition with `windows_tracked_handoff: true`
reads as `tracked-successor`. The boundary is defined in
[the read/migration boundary](#installed-state-and-the-readmigration-boundary).

**Users.** 8 entries. Seven become `tracked-successor`; `snap64-recomp` becomes
`tracked-successor-after-launcher-exit`.

**Retires:**

- `launch.rs:24-30` (the id branch).
- `library_import.rs:28-38`, the Snap64 import reconciliation. The read
  boundary moves into the fenced historical reader of
  [IC-1](#ic-1-frozen-historical-fence-and-program-view-category); it is not
  deleted.

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

The value set is closed. Each value has a fixed name and value pair defined in
Core:

| Value                 | Platform | Variable set      |
| --------------------- | -------- | ----------------- |
| `default-player-name` | Linux    | `USER=PLAYER`     |
| `default-player-name` | Windows  | `USERNAME=PLAYER` |

The variables are set only in the child environment. At most 8 values, with no
duplicates.

**Core validates.** The set is independent of adapter. A contribution may not
collide with a `launch_environment` name or a `PORTCOVE_*` name. It is
permitted alongside an external profile, because the contribution names no
path.

**Selects in Core.** It inserts the pairs in `adapter.rs` where the CorsixTH
branch is today.

**Retained contract.** It records the value set.

**Users.** 1 entry, `corsixth-corsixth`.

**Retires.** The `adapter.rs:288-300` branch.

**Accepted.** The alternative, relaxing `launch_environment` to allow `USER`,
was rejected: it lets data override an account variable that other runtimes
read for path construction. A closed contribution names a _mechanism_ (supply a
neutral player name) that a different runtime can select.

**UNKNOWN:** whether CorsixTH on Windows reads `USERNAME`. The branch applies to
Windows and Linux today, so parity keeps both. Reading `CorsixTH/Lua` startup
code settles it.

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
    { "env": "XDG_CONFIG_HOME", "empty": "absent" | "present", "join": ["CorsixTH"] },
    { "known_folder": "account-home", "join": [".config", "CorsixTH"] }
  ],
  "fallback": { "relative_to_working_directory": [".z2rs-data"] },
  "checks": [ { "kind": "...", ... } ]
}]
```

Field rules:

- `candidates` is ordered. The first candidate whose base resolves wins.
- `env` takes a closed list: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
  `XDG_STATE_HOME`, `HOME`, `APPDATA`, `LOCALAPPDATA` and `TMPDIR`.
- `known_folder` takes a closed list, resolved by OS APIs:

  | Value                     | Resolution                                                 |
  | ------------------------- | ---------------------------------------------------------- |
  | `account-home`            | `getpwuid_r` (`native_external_profile.rs:442-475`)        |
  | `roaming-app-data`        | Windows roaming application data                           |
  | `local-app-data`          | Windows local application data                             |
  | `documents`               | `CSIDL_PERSONAL` (`native_external_profile/vcmi.rs:73-99`) |
  | `mac-application-support` | macOS Application Support                                  |
  | `system-temp`             | The system temporary directory                             |

- `join` segments are each 1-64 bytes of `[A-Za-z0-9 ._+-]`, with no `..`,
  separator, drive, stream or device name. At most 6 segments.
- Bounds: at most 4 roots per platform, at most 6 candidates per root and at
  most 12 checks per root.
- `role: upstream-profile` means the upstream reads and writes it. Portcove
  only guards it: Portcove never acquires, backs up or deletes it, and refuses
  overlap with owned storage. This is today's semantics, stated in #8622.
- `role: external-write` means the runtime writes there and Portcove reserves
  or validates the location before launch (OpenSC2K autosaves; the
  `recomp-appimage-v1` `/tmp/{stem}-{uid}` root).
- The bounded walk keeps Core's constants: depth 32 and 65,536 entries
  (`external_runtime/shared_preferences.rs:396-418`). Data may only lower them.

**Check kinds.** The set is closed. Each kind is reusable Core code
parameterized by typed, bounded fields. This is the "small closed set of named
typed check kinds for what cannot be data".

| Kind                      | Parameters                                                                                                                                                                                                     | Replaces                                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refuse-file`             | `scope: root \| working-directory \| install-root`, `name`                                                                                                                                                     | `dunedynasty.cfg` (`native_external_profile.rs:799-808`), `portable.txt` (`recomp_direct.rs:48-56`), `config/dirs.json` (`vcmi.rs:39-70`), `openttd.cfg` in runtime (`archive_siblings.rs:182-217`) |
| `refuse-host-environment` | `names` (≤8, exact or `PREFIX_*`)                                                                                                                                                                              | `APP_FOLDER_PATH`, `OPENGLAD_CONFIG_DIR`, `OPENOMF_*_PATH`, `LD_LIBRARY_PATH`, `DYLD_LIBRARY_PATH` (several modules)                                                                                |
| `refuse-loadable-modules` | `scope: root \| path`, `extensions` (`so`, `dylib`, closed)                                                                                                                                                    | Doom 3 (`doom3_linux.rs:231-239`, `/usr/local/lib/dhewm3` at `:14`, `:160-167`), OpenJK (`openjk.rs:223-232`), JGRPP `*-social.so` (`archive_siblings.rs:219-247`)                                  |
| `path-byte-budget`        | `max_bytes`, `forbid` (closed: `backslash`, `dot-dot`, `double-colon`, `non-ascii`)                                                                                                                            | Doom 3 767 bytes, OpenJK <191, Dune, OpenMoHAA, OpenOMF, VCMI `MAX_PATH`                                                                                                                            |
| `json-field-null`         | `file` (relative to root), `pointer` (RFC 6901, ≤8 tokens), `max_bytes` ≤ 64 KiB                                                                                                                               | Z2RS `data_dir_override` (`z2rs.rs:99-131`)                                                                                                                                                         |
| `payload-format`          | `path`, `format` (closed: `elf-x86-64`, `pe-x86-64`, `mach-o-arm64`, `mach-o-universal`, `appimage-type-2`)                                                                                                    | ELF/Mach-O/AppImage checks across modules (`openmohaa.rs:142-187`, `quake_linux.rs:76-93`, `profile_siblings.rs:151-170`, …)                                                                        |
| `payload-members`         | `required` / `forbidden` relative paths (≤32)                                                                                                                                                                  | OpenMoHAA companions, Ironwail `ironwail.pak`, JGRPP baseset/lang                                                                                                                                   |
| `inject-launch-arguments` | `arguments` (templates using only the closed placeholders `{root:<id>}` and `{working_directory}`, values under the existing [launch value rules](../CATALOG.md#package-and-launch-declaration-compatibility)) | Doom 3 `+set fs_*` (`doom3_linux.rs:12-13`, `:171-180`; `adapter.rs:416-421`), vkQuake `-userdir .`, JGRPP `-X`                                                                                     |
| `reserve-directory`       | `mode: owner-only`, `require_sticky_parent: bool`                                                                                                                                                              | OpenSC2K `/tmp/OpenSC2K Autosaves` (`native_portable_data.rs:325-373`), recomp AppImage `/tmp` roots (`native_external_profile.rs:668-722`)                                                         |
| `appimage-runtime-layout` | `stem` (must equal the declared executable stem)                                                                                                                                                               | Recomp AppImage layout (`native_external_profile.rs:313-344`, `:573-601`)                                                                                                                           |

**Core validates:**

- **Adapter:** native-portable only. This is today's `validate_layout`
  precondition (`native_external_profile.rs:118-306`), which stays as the
  generic structural rule.
- **Platforms:** each root's platforms ⊆ the entry's platforms.
- **Restricted check kinds:** `inject-launch-arguments` only with
  `launch_arguments` empty or exactly reviewed, and
  `appimage-runtime-layout` only with an AppImage hint.
- **Shared rules:** existing `require_external_roots` refuses relative roots,
  `..` and overlap with owned roots (`native_external_profile.rs:914-929`).
  This stays generic Core code and applies to every resolved root.

**Selects in Core.** It selects the root resolution at launch
(`service.rs:6440-6463`), the install-time checks (`install.rs:1718-1824`,
`:5676-5712`), the release archive restriction (`release.rs:280-293`) and the
AppImage selector (`managed_runtime_policy.rs:203-215`). Each currently
dispatches on the policy.

**Retained contract.** It records `external_roots`.

**Read boundary.** A retained definition carrying `external_profile_policy`
reads through a _frozen translation table_: one row per historical policy
value, producing the equivalent `external_roots`. The table lives in the
historical reader module. Policy values never reach ordinary execution. The
published DUDE Doom 3 definitions and every installed native-portable retained
contract keep working.

**Users.** 25 entries and OpenSC2K.

**Retires:**

- `ExternalProfilePolicy` from live code: the enum survives only as a
  read-boundary type.
- The 11 resolver modules. They become check-kind implementations named by
  mechanism, not title.
- `native_portable_data.rs:217-226`.
- The two pins #8622 keeps (Dune Dynasty, fheroes2). Those pins exist because
  "nothing binds this policy to a package shape". With declared roots, the
  binding _is_ the definition's own data, so a wrong claim guards the wrong
  directory of the claimant's own declaration. This needs the lead's decision
  recorded on #8622; see [risks](#open-risks-and-unknowns).

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
    { "path": "asset_dump", "role": "generated-content", "reserve": true },
    { "path": "retroachievements.credentials", "role": "runtime-credential", "scope": "version-local" }
  ]
}
```

Field rules:

- `role` takes a closed set: today's 8 `PersistentDataRole` values plus
  `runtime-credential`.
- `path` must be inside a declared `persistent_paths` or
  `runtime_mutable_paths` entry. The same relative-path grammar as
  `persistent_paths` applies.
- At most 64 entries.
- `scope` takes `shared` (the default) or `version-local`.
- `reserve: true` means Core creates and checks the exact directory before
  launch, as `require_graphics_export_directory` does today.
- `applies_to_versions` is an optional exact version list (≤16).
  `portable_saves.rs` scopes the role map to 9.3.1 today. When present,
  version-scoped operations (progress copy, portable export/import) are
  offered only for listed versions. Other operations are unaffected; this is
  case 6 of [blanket refusals](#where-missing-optional-evidence-becomes-a-blanket-refusal-today).

**Core validates:**

- `runtime-credential` is never exported, backed up, recipe-shared or copied
  across versions. This is `runtime_data_policy.rs:95-114` today.
- `original-derived` paths must be reproducible from admitted originals and
  are excluded from backup.
- `portable-progress` requires a non-empty role map for the containing
  directory.
- Combination with `archive_data_compatibility_v1`: role paths must not
  overlap `build_specific_progress_paths` with a contradictory role.

**Selects in Core:**

- `service/portable_saves.rs` (export/import, folder sync) and `profile_deploy.rs`
  progress copy (`:165`, `:215`, `:3009`) read roles from the retained
  definition instead of `contract_for(port_id)`.
- Backup/rollback copying reads `generated-content` plus `reserve` instead of
  `owns_regaiden_graphics_exports` (`service.rs:5750-5755`, `:7670`, `:8024`,
  `:8146`).
- Credential exclusion reads `runtime-credential`.

**Also needed for Shipwright** (`installed_mutability.rs:6-187`). Parity needs
two things existing fields can already express, so they are authored rather
than new contract fields:

- Hard-injected `Save` and `SoHTimeSplitData.json` become authored
  `persistent_paths`.
- `logs/Ship of Harkinian.log` becomes authored `runtime_mutable_paths`.

`windows_shipwright_persistence` then reduces to "working-directory
persistence on Windows": the runtime writes relative to the working directory,
set by `SHIP_HOME` at `adapter.rs:322`. Expressing that needs one more value of
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
  exact repository to `asset_dump` `generated-content` plus `reserve`.

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
fixed-argument forcing (`adapter.rs:446`), which becomes ordinary
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
  "kind": "destination-path-reserve" | "discard-empty-output-scaffold",
  "paths": ["build-portcove/mods/bundled/psx.enhancement.internal-resolution/1.0.0/manifest.toml"]
}]
```

The `kind` set is closed. At most 16 exceptions per entry and at most 16 paths
per exception. Paths use the relative grammar.

| Kind                            | Meaning                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `destination-path-reserve`      | The destination must leave room for these relative paths under the platform's path limit |
| `discard-empty-output-scaffold` | After the tool runs, these directories may exist only if empty, and are discarded        |

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

- **Phase A (no schema change).** A Core-bundled `artifact-exceptions.json`
  holds the same records keyed only by `(size, sha256)`, with no port id. The
  callers already hold the artifact sha256 (#8618). The program view gains a
  kind for it that attributes rows by digest. It is _declared data authority,
  not title authority_, because an unfamiliar identity shipping the same bytes
  receives the same, correct, treatment.
- **Phase B (reader generation).** The definition carries
  `artifact_exceptions`, so a publisher can add an exception for a new artifact
  without a Core release. The bundled table remains the reader for retained
  installs whose definitions predate the field.

**Users.** alexbeav-diablo-recomp and opengoal-jak1.

**Retires.** The two id-and-sha pins.

**Accepted.** "Artifact-specific restrictions" proper are already covered by
typed acquisition restrictions with `artifacts` scope (hold/permit). C7 covers
only _behavioral_ allowances and additional checks, which restrictions cannot
express.

### C8. Recorded mod-provider bindings (library migration; no definition change)

**What it is.** No new definition contract: `mod_provider_bindings` and
`mod_loader` exist. This is a library-state migration plus a writer change.

1. **Writer.** `provider_install.rs:626-629` stops eliding the binding. Every
   new `ProviderPackageRef` records `binding: Some(exact)`.
2. **Migration 78** (`database.rs:17-27`, after `CURRENT_SCHEMA_VERSION = 77`).
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

**UNKNOWN:** whether auto-update hold scopes (`provider_auto_update.rs:177-184`)
are persisted, and where. Reading that module settles it. If they are
persisted, they join the migration.

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

| Mechanism                                                                                                                                    | Why it cannot be data                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Known-folder resolution (`getpwuid_r`, `SHGetSpecialFolderPathW`, `directories::BaseDirs`)                                                   | OS API calls with platform error semantics. Data selects among a closed list.                                                                                                                                                                                                                                                                                          |
| Owned-storage overlap refusal, single-link and safe-ancestor checks, bounded walks                                                           | Trust protections. They apply to _every_ resolved root regardless of data (`native_external_profile.rs:783-962`).                                                                                                                                                                                                                                                      |
| Executable and payload format parsers (ELF, PE, Mach-O fat/thin, AppImage type 2)                                                            | Binary parsing with bounds. Data names a format from a closed list.                                                                                                                                                                                                                                                                                                    |
| Content parsers for check kinds (`json-field-null`, `godot-config-constructor-free`)                                                         | Bounded parsers. The SMB1R filter guards a parser that can instantiate objects (ARCHITECTURE). Data selects the check and its file; it cannot supply a grammar.                                                                                                                                                                                                        |
| Windows job objects, the job keeper and `CREATE_NEW_PROCESS_GROUP`                                                                           | Process supervision ([child-process boundary](../ARCHITECTURE.md#child-process-boundary)). C1 selects among Core behaviors.                                                                                                                                                                                                                                            |
| Disc, archive, STFS and ROM-patch readers; source materialization transforms                                                                 | Existing reusable mechanisms, each with fixtures.                                                                                                                                                                                                                                                                                                                      |
| Mod-format readers (`dfu_mod.rs`, `recomp_mod*.rs`) and provider clients (`gamebanana.rs`, `thunderstore.rs`, `jakmods.rs`, `quaddicted.rs`) | Genuine reusable mechanisms for a file format or third-party service, selected through `mod_loader`, `mod_provider_bindings` or `mod_sources` data. Their names identify a format or service, not a catalog title. The program view should classify them as such ([IC-1](#ic-1-frozen-historical-fence-and-program-view-category)), subject to the check stated there. |
| Historical readers                                                                                                                           | They interpret exact past bytes. See [declared frozen historical recovery](#declared-frozen-historical-recovery).                                                                                                                                                                                                                                                      |

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
  - the two exception pins → C7
- **Fencing.** Each translation is keyed on the retired field's _value_ and,
  where today's code also requires it, on the exact historical package
  (`historical-artifacts.json#packages`). It is never keyed on a current
  definition.
- **Consumers.** Ordinary execution (launch, backup, rollback, transfer,
  import, settings) consumes only `CurrentInterpretation`. Translated values
  are not written back: the retained bytes and the `installed_contract_sha256`
  identity stay unchanged, so retained-build references, recipes and profile
  revisions keep matching (`retained_build.rs:33-43`, `:975-989`).
- **Pre-contract manifests.** Schema 2-5 manifests use the frozen historical
  reader to produce a retained definition. The DKR reader at
  `install.rs:4185-4227` is the precedent, and other ports join it. The current
  catalog is not used ([distinction 4](#4-exact-installed-state)).
- **Migrations.** Only C8 needs a library migration (78, additive). No
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

## Declared frozen historical recovery

Lead decision 5 (#1422): historical recovery code is fenced as deliberately
historical, not retired. This section defines the fence so the code stops
counting as _live_ title authority without losing its meaning.

**Program-view category.** A new attribute for `authorityKinds` members and
code regions: `frozen_historical`. Each declaration states the fields below.

| Field          | Content                                        |
| -------------- | ---------------------------------------------- |
| `fence`        | The exact formats, ids and digests it may read |
| `reached_from` | The read/recovery entry points                 |
| `tests`        | Test names                                     |
| `end_of_life`  | The retirement condition                       |

The gate's numerator counts an identity as retired when _all_ its remaining
matches are inside declared frozen regions. The view reports frozen counts
separately (`frozen_historical: {entries, identities}`) so they stay visible.
The detector fails when any of these hold:

- a frozen region is reachable from a non-historical entry point. A test-time
  call-graph assertion is listed per region; a static Rust call graph is
  UNKNOWN as tooling.
- a frozen region's fence key set changes without a doc update;
- a new literal appears outside declared regions.

Declared regions (from the scouts' inventory at `47f824704`):

| Region                                                                                                       | Fence (may read only)                                                                                                                                                                                                                                                                                                               | Reached from                                                                                                                                                                                                                                            | Tests                                                                                                                          | End of life                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ghostship legacy recovery (`ghostship_data_store.rs`, `preparation_ghostship.rs`, `service/ghostship_*.rs`)  | Migration-37 tables; `LegacyDataSeal` format 1; package `ghostship-200-windows` (`Mary-Celeste-Alfa-Win64.zip`, sha `a49f4c79…`); executable sha `2063529579d2…` (11,533,312 bytes); source `ghostship-source` (8,388,608 bytes, sha `17ce0773…`); preparation plan format 2 mode `Ghostship200Legacy`; installed contract format 4 | Launch completion qualification (`service.rs:6729` → `library.rs:2121`); backup create and list (`service/backups.rs:904`, `:930`); user plan, authorize and recover (`service/ghostship_recovery.rs:50`, `:239`; `ghostship_recovery_execution.rs:22`) | `ghostship_data_store_tests.rs:82-330`, `preparation_ghostship_tests.rs:5-133`, `service/ghostship_recovery_execution.rs:951+` | No library holds a format-4 contract or unresolved migration-37 row: a library-level count reported by the existing diagnostics, then an owner-confirmed retirement. Today: none stated. |
| Legacy cartridge (`legacy_cartridge/`, `legacy_cartridge_cleanup.rs`, `historical-artifacts.json#cartridge`) | 6 `(port_id, recipe, projection)` rows; frozen `legacy_cartridge/*.json` definitions; the CVLoD WinINet junction path                                                                                                                                                                                                               | Catalog validation of retained recipes (`catalog.rs:1064` → `cartridge_build.rs:123-140`); cancellation (`cancellation.rs:514`); published cleanup (`legacy_cartridge_cleanup.rs:92`); `install.rs` ~2098 and `recovery.rs` ~269                        | `historical_artifacts.rs:244-279`, `cancellation_managed_builder_tests.rs`                                                     | As stated in `legacy_cartridge/README.md:38-41`: explicit supported transition for manifests, retained definitions, backups and exports; journals resolved                               |
| Legacy DKR (`legacy_dkr/`, `historical-artifacts.json#dkr`)                                                  | 4 rows (1.0.2 and 1.0.4 × Windows zip / Linux AppImage); only when the manifest lacks `retained_contract`                                                                                                                                                                                                                           | `install.rs:4185-4227`                                                                                                                                                                                                                                  | `install.rs` `legacy_dkr_tests`; `historical_artifacts.rs:220-242`                                                             | `legacy_dkr/README.md:61-64`                                                                                                                                                             |
| Direct exceptions (`historical-artifacts.json#direct`)                                                       | 4 rows (Sonic 3 & Knuckles, Sonic the Hedgehog, Mega Man X2, Super Metroid recomps)                                                                                                                                                                                                                                                 | `persistence.rs:161`                                                                                                                                                                                                                                    | `historical_artifacts.rs` tests                                                                                                | Same as legacy cartridge                                                                                                                                                                 |
| Historical packages (`historical-artifacts.json#packages`)                                                   | 7 `PackageContract`s                                                                                                                                                                                                                                                                                                                | The [read boundary](#installed-state-and-the-readmigration-boundary) translations only, after C4-C6                                                                                                                                                     | Retained-contract tests                                                                                                        | Per package: no retained contract or registration references it                                                                                                                          |
| Library-import reconciliation (`library_import.rs:22-42`)                                                    | Embedded-vs-retained tolerance for `windows_shipwright_persistence` and Snap64 `windows_tracked_handoff`; library metadata schema 1-16                                                                                                                                                                                              | `plan_library_import` (`:313`); `import_execution.rs:332`                                                                                                                                                                                               | `library_import.rs:44-56`, `:767-950`                                                                                          | Library metadata schemas below the oldest supported export generation are refused with an explicit upgrade route (owner decision)                                                        |
| C8 migration input (`GAMEBANANA_BINDINGS`, `COMMUNITY_BINDINGS` copies)                                      | Rows for stored refs with `binding: None`                                                                                                                                                                                                                                                                                           | Migration 78 and recipe/library import of format-3 data                                                                                                                                                                                                 | Migration tests                                                                                                                | No supported import format can carry `binding: None`                                                                                                                                     |
| `legacy_loader`                                                                                              | Retained definitions without `mod_loader`                                                                                                                                                                                                                                                                                           | Read boundary only                                                                                                                                                                                                                                      | `profile_loader.rs` tests plus a "current definitions cannot reach it" test                                                    | Same as library-import reconciliation                                                                                                                                                    |

**Excluded from the fence** (live, retired by contracts instead):

- `launch.rs:24-30`, retired by C1.
- `runtime_path_policy.rs:288-293`, retired by C7.
- Any Ghostship 3.0.0 _current_ behavior. Whether all Ghostship literals
  (`preparation.rs`, `preparation_readiness.rs`, `service.rs:6175-6183`,
  `service/launch_preparation.rs:384-394`) are confined to the 2.0.0 legacy
  route is UNKNOWN. Tracing each literal to a 2.0.0-only entry point settles
  it. Any literal that is not confined stays counted.

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
  inputs_digest: sha256 of the exact catalog/retained/local facts consulted,
}
```

**Owners composed, in the order `service.rs` applies today:**

1. `definition_eligibility`
2. `acquisition_restriction`
3. retained-contract and integrity checks
4. uploader continuity, scoped per [IC-3](#ic-3-operation-scoped-eligibility-for-existing-installations)
5. source assessment, for operations that consume originals
6. launch readiness

**Status consumers.** `with_definition_operations`, `with_port_actions`,
`port_capabilities` and listing status become projections over `Assessment`
values.

**Mutations revalidate.** Each mutation calls `assess` _inside its library
transaction or port lock_ with the same subject and operation. It proceeds only
on `eligible`, and refuses with the same reason otherwise. The returned
`inputs_digest` lets a caller detect drift between preview and execution. This
generalizes the conflict re-read that `port_capabilities` already performs
(`capabilities.rs:411-424`). Mutations keep their own _execution_ checks
(integrity, archive safety, consent). Those are not eligibility, and they are
not duplicated into the assessment.

### Maintenance scripts

**Recommended: call Core through the CLI in bulk form.** The other route,
a generated shared table with a parity test, is the fallback.

**New command.**

```text
portcove --json catalog assess --operations download,install,register-external,launch \
  --platforms all --input catalog.json [--resume-from ID] [--output FILE]
```

- **Runtime.** No library. It evaluates catalog and listing subjects with the
  pure owners only (`definition_eligibility`, `acquisition_restriction`, route
  facts) for each requested platform, not only the current host. That matches
  route fit's per-platform holds (`catalog-route-fit.mts:298-300`).
- **Output.** NDJSON, one line per (identity, platform, operation), sorted, so
  output is deterministic.
- **Resumable.** `--resume-from` restarts after the last complete identity.
- **Prior art.** `target_inspection.rs` already evaluates routes without a
  library (`:1-9`).
- **Script changes.** `catalog-route-fit.mts`, `catalog-generated-registration.mts`
  and `maintenance-program-view.mts` consume the NDJSON.
  `catalog-route-holds.mts` and the mirror in
  `catalog-acquisition-restrictions.mts` are deleted after parity.
- **Authoring-time validation.** `checkAcquisitionRestrictions` either calls
  the same command in `--validate` mode or keeps a schema-only check. Shape
  validation is not eligibility.

**Why not a generated table.** A table must enumerate (restriction set ×
platform × operation × artifact scope). That is the evaluation itself, so it
would be a per-catalog output, which the CLI route already gives. A generated
_rules_ table still needs a TypeScript evaluator, which is the duplication to
remove.

**Cost.** Route fit runs inside `pnpm run check` and the program view. A Rust
CLI build becomes a prerequisite of those script tests. The tests can use the
prebuilt workspace binary that CI already produces for CLI tests. Whether those
script tests already run where that binary exists is UNKNOWN. Reading the node
test partitions in CI settles it. If not, the fallback is a committed
`catalog-assessment.generated.json` produced by the CLI and checked by
`generate-catalog --check`. That is the "generated shared table" form, with
Core as its only producer and no TypeScript evaluator.

### Parity test (first step, before any deletion)

`scripts/catalog-assessment-parity.test.mts` runs both the TypeScript `heldAt`
and the Core CLI over the whole catalog, every platform and every operation
route fit uses. It asserts equality, and lists the known divergences above as
explicit expected differences, each with an issue link. Each listed divergence
is then fixed or ruled correct before deletion.

## Compatibility and rollout order

Classification of each change:

| Change                                         | Class                                                                                                                                   | Reader generation needed                                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IC-1 frozen fence; program-view categories     | Tooling and Core-internal (module moves, no behavior)                                                                                   | No                                                                                                                                                                                |
| IC-2 capability CLI and parity test            | Core-internal plus CLI additive JSON command (API schema bump for the new command only)                                                 | No                                                                                                                                                                                |
| IC-3 operation-scoped eligibility              | Core-internal behavior change; trust-sensitive                                                                                          | No                                                                                                                                                                                |
| IC-4 (C8) binding migration                    | Library schema 78 (additive); recipe format unchanged                                                                                   | No definition change; older clients cannot open a library after migration, as for every library migration ([database and migrations](../ARCHITECTURE.md#database-and-migrations)) |
| IC-5 (C7 phase A) bundled exceptions           | Core-internal data                                                                                                                      | No                                                                                                                                                                                |
| C1-C6, C7 phase B                              | New definition features. Embedded catalog entries can use them in the same release, because the embedded catalog ships with its reader. | Yes, for _published/live_ definitions                                                                                                                                             |
| Authoring shorthands that expand to new fields | Authoring-only                                                                                                                          | No; the generated catalog changes only when the field is adopted                                                                                                                  |

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
validation, runtime, retained state, docs and program view. Gate estimates are
cumulative.

**Gate estimate method.**

- The baseline is 343/460 at `47f824704`.
- They assume the in-flight work merges first:
  - **#8618:** about +19 identities whose only match is test-gated literals in
    `service/native_portable.rs`.
  - **The family-generator branch:** about +40 identities served only by
    `family-generator-script`, plus 2 that clear once both land.
  - Together: **about 404/460**.
- Assignments come from mapping each of the 117 failing identities to its
  remaining kinds. They are estimates: a denominator change from new
  enrollments shifts them.

### Can start immediately (no definition schema change)

#### IC-1 Frozen historical fence and program-view category

- **Files:**
  - `scripts/maintenance-program-view.mts` (+ tests).
  - `docs/MAINTENANCE-STORE.md` (program cutover view).
  - New `historical/` module re-exports, or `// frozen-historical:` region
    declarations in the files listed in the
    [fence table](#declared-frozen-historical-recovery).
  - Each region's README or module doc with fence, tests and end-of-life.
- **Behavior:** none changes.
- **Acceptance:**
  - Each region has its declared fence, tests and end-of-life.
  - The view reports `frozen_historical` separately.
  - The detector fails on a new literal outside regions and on a changed fence
    key set.
  - A test asserts each region's entry points.
- **Identities cleared:** cvlod-recomp, dkr-r, dr-mario-nes-recomp,
  earthbound-recomp, gundam-wing-endless-duel-recomp, render96ex,
  yoshis-cookie-recomp, mega-man-x2-snes-recomp, sonic-3-and-knuckles-recomp,
  sonic-the-hedgehog-recomp and super-metroid-recomp, **about +11 → about
  415/460**.
  - The five cartridge identities clear only if their title-named recipe
    variants are inside the declared region.
  - Ghostship is not counted ([UNKNOWN](#declared-frozen-historical-recovery)).
- **Retires:** live-authority counting of historical code (not the code).

#### IC-2 Capability-assessment parity, then one assessment

- **Part (a).**
  - `portcove --json catalog assess` (CLI over pure Core owners).
  - `scripts/catalog-assessment-parity.test.mts` with the explicit divergence
    list.
- **Part (b).**
  - `operation_assessment.rs`; status stages and mutations call it.
  - Delete `catalog-route-holds.mts` and the mirror in
    `catalog-acquisition-restrictions.mts`; route fit consumes CLI output.
- **Entries:** all 1,649 listings × platforms × route-fit operations.
- **Acceptance:**
  - The parity test is green over the whole catalog with zero unexplained
    differences.
  - Route fit and the program view are byte-identical before and after the
    switch, except for documented divergence fixes.
- **Gate:** +0. It retires the duplicated evaluator, not title authority.
- **Split:** part (a) is one pull request, part (b) one or two.

#### IC-3 Operation-scoped eligibility for existing installations

- **Files:**
  - `service.rs` (activation gates, rollback target, installed-catalog
    fallback).
  - `service/backups.rs`, `release/uploader_continuity.rs`, `profile_deploy.rs`
    and `service/game_settings.rs`.
  - Owning docs: ARCHITECTURE [definition operation eligibility](../ARCHITECTURE.md#definition-operation-eligibility)
    and [backup service](../ARCHITECTURE.md#backup-service-ownership).
- **Cases:** 1-5 and 7 of the [blanket-refusal table](#where-missing-optional-evidence-becomes-a-blanket-refusal-today).
- **Acceptance:** for each case, a test where the evidence is missing:
  - the related operation still holds;
  - the unrelated operation proceeds on retained state.
- **Review:** a critical reviewer is needed for the uploader-continuity part.
  It is trust-sensitive and can be split out.
- **Gate:** +0. This is a distinction repair.

#### IC-4 Recorded mod-provider bindings (C8)

- **Files:**
  - `provider_install.rs`, `provider_binding.rs`, `provider_auto_update.rs`,
    `provider_browse.rs`, `thunderstore.rs`, `database.rs` (migration 78),
    `profile.rs`, `library_import.rs` and `recipe.rs` import.
  - `profile_loader.rs` (`legacy_loader` → historical reader).
  - `native_mod_list.rs`.
  - Program view: provider-binding-table members declared retired.
- **Entries:** 2 (shipwright and zelda64-recomp), plus all stored references.
- **Acceptance:**
  - Migration tests over fixture libraries that hold `binding: None` references
    in profiles and revisions; no revision digest changes.
  - New installs record the exact binding.
  - The unfamiliar-identity scenario: an unfamiliar definition with
    `mod_provider_bindings` gets provider install, browse and auto-update with
    no table.
- **Gate:** clears zelda64-recomp, **+1 → about 416**.
- **Retires:** `GAMEBANANA_BINDINGS` and `COMMUNITY_BINDINGS` from live paths;
  `legacy_loader` from live paths.

#### IC-5 Byte-bound artifact exceptions, phase A (C7A)

- **Files:**
  - New `catalog/artifact-exceptions.json` (bundled, keyed by size and sha256).
  - `runtime_path_policy.rs` and `preparation_execution.rs`.
  - Program view: new kind, declared data authority.
- **Entries:** 2 artifacts.
- **Acceptance:**
  - Parity tests for Diablo destination reservation and the OpenGOAL scaffold.
  - Unfamiliar-identity scenario: the same bytes under an unfamiliar fixture id
    get the behavior; different bytes under the Diablo id do not.
- **Gate:**
  - Clears alexbeav-diablo-recomp, **+1 → about 417**.
  - opengoal-jak1 stays counted through `title-named-core-item`.
- **Retires:** the two id pins.

### Needs the next reader generation (one coordinated reader release)

These pull requests may merge independently. They become usable for
_published_ definitions together, at the next minimum generation.

#### IC-6 Process handoff (C1)

- **Files:**
  - `types.rs`, `definition_capabilities.rs` (feature),
    `definition_entry.rs:436-447`, `launch.rs`.
  - The read-boundary translation.
  - `library_import.rs` (reconciliation into the fence).
  - Authoring (`catalog/ports/*.json` for the 8 entries; generator).
  - [CATALOG](../CATALOG.md) / [DEFINITION-DELIVERY](../DEFINITION-DELIVERY.md).
- **Entries:** 8.
- **Acceptance:**
  - The unfamiliar identity gains capability 35 by declaring
    `tracked-successor-after-launcher-exit` and returns to 28 by declaring
    `tracked-successor`.
  - Parity: 7 entries at 28 and Snap64 at 35.
  - Retained `windows_tracked_handoff: true` translates.
- **Gate:** clears snap64-recomp, **+1 → about 418**.

#### IC-7 Launch environment contributions (C2)

- **Files:** `types.rs`, the feature, `adapter.rs` and authoring.
- **Entries:** 1.
- **Acceptance:** the unfamiliar-identity scenario plus parity for CorsixTH on
  Windows and Linux.
- **Gate:** +0 alone. CorsixTH clears with IC-8.

#### IC-8 External roots and check kinds (C3)

The largest change; split as follows.

- **IC-8a. Reader, check kinds and translation table.**
  - Files: new `external_roots.rs`, check-kind modules named by mechanism
    (`check_payload_format.rs`, `check_loadable_modules.rs`, …), `install.rs`,
    `release.rs`, `managed_runtime_policy.rs`, `service.rs:6440-6463`.
  - Retained translation for all 18 policy values.
- **IC-8b. Migrate the 25 entries and OpenSC2K.**
  - Delete the 11 resolver modules and `ExternalProfilePolicy` from live code.
- **Acceptance:**
  - Per-policy parity tests. Each existing module test runs against the
    translated `external_roots` and must produce identical roots, refusals and
    arguments.
  - Unfamiliar-identity scenarios for each check kind.
  - A retained DUDE Doom 3 contract with `doom3-linux-v1` launches through the
    translation.
- **Gate:** clears the 25 policy identities plus nicholas-ochoa-opensc2k.
  CorsixTH needs IC-7. Estimate **+26 → about 444**.
- **Precondition:** the lead's decision on #8622's two kept pins.

#### IC-9 Player-data roles (C4)

- **Files:**
  - `portable_saves.rs`, `service/portable_saves.rs`, `service/portable_save_folder.rs`,
    `profile_deploy.rs`, `installed_mutability.rs`, `runtime_data_policy.rs`,
    `managed_shared_preferences.rs` (graphics exports),
    `install.rs:2775-2780`, `:3879-3900` and `service.rs` backup/rollback
    copying.
  - Authoring for 3 entries.
- **Acceptance:**
  - The existing Shipwright persistence suite (`service/shipwright_persistence_tests.rs:111-771`)
    passes on the data path.
  - RaceWave credential exclusion tests and RE Gaiden export tests pass.
  - Unfamiliar-identity scenario: a fixture declares `data_roles` and gains
    progress copy.
- **Gate:** clears shipwright (with IC-4) and wave-race-64-racewave46,
  **+2 → about 446**.

#### IC-10 Seeded files and signatures (C5)

- **Files:** `managed_initialization.rs`, `managed_chocolate.rs`,
  `managed_tfe.rs`, `adapter.rs:446`, `install.rs:1172-1183` and `:5444`,
  `managed_runtime_policy.rs:181-184` and authoring.
- **Entries:** 4.
- **Acceptance:**
  - Parity of the seeded bytes, arguments and screenshot patterns per Chocolate
    executable.
  - TFE pilot signature parity.
  - "Never rewrite an existing file" test.
- **Gate:** clears 4 identities, **+4 → about 450**.

#### IC-11 Shared write scope v2 (C6)

- **Files:** `external_runtime/shared_preferences.rs` (and `/smb1r.rs`),
  `managed_shared_preferences.rs`, the consent review in `service.rs`
  (`:1775-1864`, `:4220-4259`) and the Tauri disclosure. The copy stays
  owned by CONTENT-DESIGN.
- **Entries:** 2.
- **Acceptance:**
  - Consent fingerprint parity: the same account and path digest for existing
    registrations.
  - Unfamiliar-identity scenario with a fixture base.
- **Review:** a critical reviewer. This is a trust and consent boundary.
- **Gate:** clears resident-evil-gaiden-recomp (with IC-9) and
  super-mario-bros-remastered, **+2 → about 452**.

#### IC-12 Byte-bound exceptions, phase B (C7B), and residuals

- **C7B:** the definition-carried `artifact_exceptions`.
- **Residuals** (8 identities, each with its own route):

| Identity                                                                 | Route                                                                                                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| surge-the-rabbit-opensurge                                               | Rename `KnownFailureCause::OpenSurgeUserDataPath` to a generic cause with a decode alias at the failure-wire read boundary. Needs an API schema note. |
| g-diffuser                                                               | Gate `ROM_PATCH_FIXTURE_PORT` (`catalog.rs:2457`) under the qualification-fixtures feature, or move it to test data                                   |
| yu-gi-oh-forbidden-memories-recompiled                                   | Move the qualification-fixture title code to fixture data                                                                                             |
| opengoal-jak1, opengoal-jak2, opengoal-jak3, interkarma-daggerfall-unity | Named-mechanism classification, subject to the call-site check in [IC-1](#ic-1-frozen-historical-fence-and-program-view-category)                     |
| ghostship                                                                | Confinement of the 2.0.0 literals                                                                                                                     |

- **Gate:** up to **+8 → 460/460**, if every UNKNOWN resolves favorably.

### Summary

| PR          | Mechanism                       | Schema            | Entries            | Gate after (estimate) |
| ----------- | ------------------------------- | ----------------- | ------------------ | --------------------- |
| (in flight) | #8618, family-generator branch  | no                | —                  | about 404             |
| IC-1        | Frozen historical fence         | no                | 11 identities      | about 415             |
| IC-2        | One capability assessment       | no (CLI additive) | whole catalog      | about 415             |
| IC-3        | Operation-scoped eligibility    | no                | all installs       | about 415             |
| IC-4        | Recorded provider bindings (C8) | library 78        | 2 plus stored refs | about 416             |
| IC-5        | Byte-bound exceptions A (C7)    | no                | 2                  | about 417             |
| IC-6        | Process handoff (C1)            | reader            | 8                  | about 418             |
| IC-7        | Environment contributions (C2)  | reader            | 1                  | about 418             |
| IC-8a/b     | External roots (C3)             | reader            | 26                 | about 444             |
| IC-9        | Player-data roles (C4)          | reader            | 3                  | about 446             |
| IC-10       | Seeded files (C5)               | reader            | 4                  | about 450             |
| IC-11       | Shared write scope v2 (C6)      | reader            | 2                  | about 452             |
| IC-12       | Exceptions B (C7) and residuals | reader / mixed    | 8                  | up to 460             |

**Dependency order.**

- IC-1, IC-2a, IC-4 and IC-5 are independent and can start now.
- IC-3 depends on nothing, but its trust portion needs a critical reviewer.
- IC-6, IC-7 and IC-8a can proceed in parallel. IC-8b depends on IC-8a and the
  #8622 decision.
- IC-9 depends on IC-4, because Shipwright's binding must be settled first.
- IC-11 depends on IC-9, because the RE Gaiden graphics exports move first.
- IC-12 comes last.

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

## Open risks and unknowns

| Item                                                                                              | Status                                   | What settles it                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #8622's two kept pins (Dune Dynasty, fheroes2): is a definition-declared root binding sufficient? | Lead decision                            | The lead records the decision on #8622. C3's argument is in [C3](#c3-external-roots-and-typed-checks-nativeexternal-roots-v1).                                     |
| "Never active" is not a recorded fact for the IC-3 uploader-continuity narrowing                  | UNKNOWN                                  | Read `InstallRecord` and the activation history. If absent, IC-3 keeps the hold for rollback and narrows only active-build launch and file-only settings recovery. |
| Ghostship literals confined to the 2.0.0 route                                                    | UNKNOWN                                  | Trace each production literal to its entry points                                                                                                                  |
| `jakmods` selected only through definition data                                                   | UNKNOWN                                  | Read its call sites                                                                                                                                                |
| Whether other tracked-handoff upstreams exit before their successor joins                         | UNKNOWN                                  | Native launch-tree observation per entry                                                                                                                           |
| CorsixTH on Windows reads `USERNAME`                                                              | UNKNOWN                                  | Upstream source read                                                                                                                                               |
| GB Recompiled fallback expressible as an ordered candidate list                                   | UNKNOWN                                  | Full read of `managed_shared_preferences.rs`                                                                                                                       |
| `regaiden-gbc` materialization is title-specific                                                  | UNKNOWN                                  | Read the transform implementation                                                                                                                                  |
| Auto-update hold scopes persisted                                                                 | UNKNOWN                                  | Read `provider_auto_update.rs:177-184` and its storage                                                                                                             |
| Removal execution consults the current catalog                                                    | UNKNOWN                                  | Read `service.rs:5703` onward                                                                                                                                      |
| Node script tests can use a built CLI binary in CI                                                | UNKNOWN                                  | Read the node test partitions in CI; if not, use the generated-table fallback                                                                                      |
| Static proof that frozen regions are unreachable from live entry points                           | UNKNOWN as tooling                       | Per-region entry-point tests are the proposed substitute                                                                                                           |
| Check-kind list completeness for the 11 modules                                                   | Risk                                     | IC-8a's per-policy parity tests. A behavior that fits no kind is either a new kind with its own consumer or stays a declared historical translation.               |
| Gate estimates                                                                                    | Estimates                                | Each pull request records the actual program-view result                                                                                                           |
| Older previews lose live updates for definitions adopting new features                            | Accepted (owner compatibility amendment) | One minimum supported generation, shared with the compact-listing cutover                                                                                          |
