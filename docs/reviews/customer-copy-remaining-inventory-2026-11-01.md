# Remaining customer-copy inventory — 2026-11-01

Issue: [#4198](https://github.com/boburning/portcove/issues/4198). Source base:
`c5214c867b4234593f5935115fc64bb122bf679a`; inventory captured from the active
customer-copy worktree while other issue workers edited their assigned files.
This is source-grounded editorial research, not rendered or native acceptance.
No product source was changed by this inventory worker.

The most consequential remaining findings concern what an action actually does:
registration must not promise an immediate launch; selecting an update policy
does not start background updates; reusing a retained installation does not
necessarily select the previous version; a successful empty diagnostic inventory
does not prove global health; and backup restore creates a safety backup only
when current managed files exist. Ordinary labels and recovery guidance also
still expose implementation language outside the initially audited components.

The governing authorities are [content design](../CONTENT-DESIGN.md),
[the glossary](../../GLOSSARY.md), [Desktop composition](../DESIGN-SYSTEM.md),
[the CLI contract](../CLI.md) and the cited behavior owners below. Wording does
not change their machine values, assessment decisions, permissions or recovery.

## Coverage and evidence level

The complete retained candidate inventory is
`work/customer-copy/remaining-inventory.json` (ignored local work evidence).
`work/customer-copy/remaining-replacements.json` contains exact old/new source
spans, occurrence counts, source lines and semantic constraints for inspected
replacement proposals. Applying a proposal requires its exact occurrence check;
other workers may already have changed the source after capture.

The source enumeration starts with **all tracked paths**, then classifies every
Desktop TypeScript/TSX/JSON module, every Core/Tauri/CLI Rust module and every
tracked Markdown file. It does not begin with a terminology keyword search.
It retains tests, generated sources and development-only fixtures as explicit
excluded records. All candidate literals, JSX text, CLI doc-comment help,
Desktop accessibility/live/error sinks and Markdown paragraphs are retained
separately; technical identifiers are not silently discarded as ordinary prose.

| Area                                     | Enumerated candidate source files | Review performed                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop production-candidate TS/TSX/JSON |                               171 | Editorial pass over extracted visible/help/ARIA/live strings, plus contextual handler review for proposed changes; utility/type/data modules recorded separately from visible text                      |
| Core Rust production-candidate modules   |                               176 | Full file enumeration and literal candidates; contextual review of the shared failure owner and directly displayed summary/reason/recovery/progress producer families below                             |
| Tauri Rust production-candidate modules  |                                59 | Full module enumeration, native confirmation/picker title inventory, and contextual review of direct-display producers; compile-time qualification modules remain distinct from ordinary shipping paths |
| CLI source modules                       |                                17 | Editorial pass over help declarations, human renderers, prompts, cancellation, progress, retained-build and setup output; machine-only schemas and inert exports retain their purpose                   |
| Tracked Markdown                         |                               450 | Complete file/paragraph/audience inventory; editorial review of player entry points and selected current task sections; historical/evidence/developer content classified without wholesale rewriting    |

The capture contains 1,205 file records including exclusions, 28,740 lexical
literal/JSX candidates, 912 Desktop sink candidates, 457 CLI help-comment
candidates and 14,634 Markdown blocks. These are **enumeration counts**, not
counts of individually approved customer strings. The lexical extractor can
misclassify syntax, comments, Rust raw strings or JSX boundaries; it is not an
AST or a rendered extraction. Nested-template/JSX parsing and embedded test or
qualification code are explicitly recorded limitations. Initial source hashes bind file records to the first capture; separate
`literal_capture_sha256` values bind refreshed literal records. Neither is
final-head qualification.

Contextual Desktop review covered the complete source routes for DetailPanel,
RecoveryReview, LibraryImport, LibraryMove, OutputLocation, BackupHistory,
ProtectionSummary, GameSettingsControl/Panel, GameFileQuery/filter presentation,
OperationCancellation/Progress, ActivityDiagnostic, ManagedRouteChange,
ListingDetailPanel, UpdateCenter, the command surface, and the live/error
adapters they consume. Remaining initial-audit components are represented in the
inventory but keep the parent worker's ownership. This worker inspected no live
WebView, screen reader, native picker, installed package, game or human session.

## High-priority semantic findings

1. **Native existing-installation consent promises a launch that does not occur.**
   The [external registration and relink host handlers](../../apps/desktop/src-tauri/src/external_runtime_commands.rs#L277)
   recheck consent and save the registration; their text says “will verify and
   launch” (original lines 293 and 372). Use “Portcove checks this installation
   and saves its location. Choose Play separately to launch.” Preserve exact
   package checks, shared-preferences consent and external ownership. The
   [user-selected handler](../../apps/desktop/src-tauri/src/external_runtime_commands.rs#L115)
   already distinguishes saving from Play. The parent worker received this
   finding early and owns its implementation.
2. **CLI policy help still implies independent background updates.**
   [Policy help](../../crates/portcove-cli/src/args.rs#L1415) originally says
   “automatically activate eligible updates”; the
   [human policy mapping](../../crates/portcove-cli/src/human.rs#L2238) originally
   said “Apply updates automatically”. Describe behavior **when update
   reconciliation runs** and align human values with “Keep update for later” /
   “Install when I run updates”. Keep `notify`, `stage`, `automatic`, serialized
   values and execution/consent unchanged. Exact remaining help replacements
   are in the proposal JSON; the parent already changed the human mapping.
3. **A reused local release is not necessarily the previous version.**
   [Core selection](../../crates/portcove-core/src/service.rs#L1750) searches by
   artifact after checking active/staged state. `ReuseRetained` can identify any
   matching retained installation. Change “Use previous version” to “Use checked
   local version” in the [Desktop plan mapping](../../apps/desktop/src/install-plan-presentation.ts#L7)
   and [CLI plan mapping](../../crates/portcove-cli/src/human.rs#L2383). Keep the
   actual selected install ID, release and hashes visible. This must not change
   the separate Restore previous version action.
4. **CLI no-files wording overstates a route-limited fact.**
   [Human game-file query](../../crates/portcove-cli/src/human.rs#L12) originally
   maps `NoFilesRequired` to “No files required”. Match Desktop's “No files to add
   in Portcove”; upstream setup may still require originals. Preserve positive
   `explicit_empty_requirements` evidence and every unknown/missing distinction.
   [Desktop binding checks and reason mapping](../../apps/desktop/src/features/browsing/game-file-query-context.ts#L14)
   own the existing presentation scope. The parent received this early.
5. **Backup presence is not an unqualified verification claim.**
   [BackupHistory](../../apps/desktop/src/components/BackupHistory.tsx#L148)
   originally says “Verified backups remain listed and usable” and “N verified
   backups”. Use “Available backups…” / “N backups”, retaining the separate
   current restore assessment, degraded history, integrity checks and recovery
   holds. [Protection's snapshot type](../../crates/portcove-core/src/service/protection.rs#L94)
   explicitly distinguishes a valid manifest from payload integrity and current
   restore eligibility. Do not turn unavailable history into “No backups yet”.
   The parent owns this early fix.
6. **Backup documentation promises a safety backup unconditionally.**
   [Restore saved data](../UPGRADING.md#restore-saved-data) originally guarantees
   one; [the review](../../apps/desktop/src/components/BackupReview.tsx#L155) and
   [Core backup preview](../../crates/portcove-core/src/service/backups.rs#L1073)
   distinguish absent/empty current managed data. Say the review reports whether
   a safety backup will be created. The parent received this early.
7. **The CLI external-select confirmation flag describes execution rather than registration.**
   [Argument help](../../crates/portcove-cli/src/args.rs#L671) says “Confirm execution
   of the reviewed user-selected executable”. Use “Confirm saving the reviewed
   launch details without prompting; launching is a separate command.” The
   [dispatch](../../crates/portcove-cli/src/main.rs#L1943) preserves registration
   and subsequent `exec` as separate actions. No flag or consent bypass changes.
8. **An empty diagnostic list is narrower than “no repairs needed”.**
   [Human doctor output](../../crates/portcove-cli/src/human.rs#L1555) should say
   “Repair review: no repair items were recorded.” Keep complete/incomplete
   journal and related-assessment facts; this prose does not establish global
   library health or authorize repair.
9. **An available prepared update should say saved for later.**
   [DetailPanel compatibility attention](../../apps/desktop/src/components/DetailPanel.tsx#L2989)
   uses `status.staged` but calls the update “downloaded”. Use “Update {version}
   is saved for later. You can review it separately.” No transfer, activation,
   freshness or readiness conclusion follows solely from this label.

## Remaining Desktop editorial groups

Exact replacements and occurrence counts are in the proposal JSON. The
following boundaries were checked before proposing them:

| Group                                | Inspected issue and proposed wording                                                                                                                                                                                                                                                                                                                 | Constraints                                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Detail overview                      | [CompatibilitySummary](../../apps/desktop/src/components/DetailPanel.tsx#L1268) shows declared package platforms, Steam Deck not-tested limits and installation method. Its “Compatibility qualifications” summary should be “Platforms and installation method”. The separate detailed qualification disclosure should be “Test results”.           | A catalog platform list is not platform, device or gameplay qualification. Do not merge the two disclosures.                                                                                     |
| Saved-data coverage                  | [DetailPanel](../../apps/desktop/src/components/DetailPanel.tsx#L1411) still says “external runtime”, “Core permits it”, “retained declarations” and “collection scope”. Use external installation/folder, current backup checks, recorded backup rules and which files Portcove collects.                                                           | Preserve external profile/custom-location exclusions, unknown installed-version rules and the separate already-managed data folder.                                                              |
| Unfinished setup                     | [RecoveryReview](../../apps/desktop/src/components/RecoveryReview.tsx#L328) twice calls the review an “account”. Use “review”; use “Saved game files” for the preserved source-path label.                                                                                                                                                           | Inspection changes no files; cleanup remains separately reviewed and irreversibly removes only its owned private folder/record. Do not change account/authentication strings elsewhere.          |
| Future installation folder and moves | [OutputLocation](../../apps/desktop/src/components/OutputLocation.tsx#L425) exposes “Current output destination” and “Output destination review” as accessible names. Use “Current install folder” / “Install folder review”; simplify unknown availability/ownership wording.                                                                       | Future placement, relocation and cleanup are different actions. Keep all exact paths, capacity unknowns, preserved originals/saves/backups and retained old-folder cleanup state.                |
| Restore/import                       | [LibraryImport](../../apps/desktop/src/components/LibraryImport.tsx#L88) correctly requires metadata plus copied content, new/empty destination, review and checked restore; it retains failures and explicit recovery.                                                                                                                              | Preserve this route. A review is not a tested recovery copy. The generic folder picker has no custom title for its shared install/import selection; do not invent a narrowly named global title. |
| Managed copy                         | [ManagedRouteChange](../../apps/desktop/src/components/ManagedRouteChange.tsx#L213) can say “New installation folder” and name recorded saved-data rules instead of “new runtime”.                                                                                                                                                                   | Preserve external saves not copied, existing registration usable until activation, explicit Play and the warning that upstream profiles may still be shared.                                     |
| File-check results                   | [GameFileQuery](../../apps/desktop/src/components/GameFileQuery.tsx#L61) and [query presentation](../../apps/desktop/src/features/browsing/game-file-query-context.ts#L14) can say setup/launch option, current file-check result and saved location instead of route, accepted observation, admitted identity and context.                          | Keep exact route/platform/channel/release binding, no implicit registration or scan, and unknown distinct from missing. Change button cross-references together.                                 |
| Palette/navigation                   | [Command surface](../../apps/desktop/src/use-command-surface.ts#L55) still says Open/Search Find games while its handlers open Discover. Use Open/Search Discover.                                                                                                                                                                                   | Preserve route IDs, shortcuts, search scope and keywords.                                                                                                                                        |
| Progress and cancellation            | [OperationCancellation](../../apps/desktop/src/components/OperationCancellation.tsx#L31) already says request accepted / finishing safely, not cancelled completion. [OperationProgress](../../apps/desktop/src/components/OperationProgress.tsx#L18) uses authoritative phase/range text for visible and accessible values.                         | Preserve request/terminal distinction and unknown total. Proposed backend message edits below change only prose.                                                                                 |
| Errors and refresh failures          | [FailureDetails](../../apps/desktop/src/components/FailureDetails.tsx#L10), [ActionReviewFailure](../../apps/desktop/src/components/ActionReviewFailure.tsx#L5) and [WorkspaceRefreshNotice](../../apps/desktop/src/features/workspace/WorkspaceRefreshNotice.tsx#L113) preserve committed/unknown/recovery outcomes and failed readback separately. | Keep these distinctions and the existing safe summary/redacted technical disclosure. A cosmetic edit must not imply that retrying refresh repeats the mutation.                                  |
| Activity/update history              | [UpdateCenter](../../apps/desktop/src/components/UpdateCenter.tsx#L950) distinguishes current tasks, bounded historical records, incomplete coverage, process exit and gameplay not checked.                                                                                                                                                         | Retain per-item outcome/counts and unknown timestamps. These existing distinctions should not be simplified to generic success.                                                                  |
| Localized settings                   | [English settings messages](../../apps/desktop/src/locales/en/settings.json) and the engineering RTL preview explicitly limit translation support to the language panel.                                                                                                                                                                             | No claim that all Desktop text is localized. Pseudo/engineering examples are not ordinary player task guidance.                                                                                  |

Additional source-backed items require a presentation mapping rather than a safe
literal-only replacement: [ProtectionSummary](../../apps/desktop/src/components/ProtectionSummary.tsx#L127)
displays `entry.state`, managed-data `state` and `saves_and_settings` values;
[comparison eligibility](../../crates/portcove-core/src/service/listings/recommendations.rs#L712)
originally formatted Rust Debug action/reason names into a directly displayed reason
(the parent has since added an explicit human mapping);
[native Ghostship consent](../../apps/desktop/src-tauri/src/ghostship_recovery.rs#L93)
and adoption/preparation prompts still show raw byte integers. Preserve machine
values and consequential full hashes/IDs; use explicit human mappings and IEC
formatting only at the appropriate presentation boundary. These are retained
candidates, not authorization for a global enum or schema rename.

## Dynamic backend text: producers to customer sinks

These are source paths, not an assumption that every Rust error string is shown
as the primary UI message. Failure presentation normally supplies a safe summary;
several read-result fields and operation messages intentionally bypass that path.
The parent applied or adapted the 68 literal proposals after review; the local
JSON retains old/new occurrence readback. That readback is not a rendered check.

| Producer owner                                                                                                                                                                                                                                                               | Transport/result route                                                                                                                                                                                           | Customer sink and review disposition                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Core failure summary and known cause](../../crates/portcove-core/src/failure.rs#L148)                                                                                                                                                                                       | `PortcoveError::report()` → `FailureReport`; [DesktopError aliases this report](../../apps/desktop/src-tauri/src/desktop_contract.rs#L17)                                                                        | `errorText`, ActionReviewFailure, FailureDetails, ActivityFailure and human CLI failure output. Preserve cause/outcome/remedy, neutral cancellation, exact mutation state, redaction and known recovery target. Detailed source report/view-model wording belongs to the parent.                                           |
| [Source report](../../crates/portcove-core/src/source_report.rs#L154)                                                                                                                                                                                                        | `SourceInspectionReport.summary/next_action` via inspection commands                                                                                                                                             | [SourceIdentity](../../apps/desktop/src/components/SourceIdentity.tsx#L91), SourceIntake nested report and CLI source inspection. Parent-owned implementation; do not rewrite state codes.                                                                                                                                 |
| [Source-intake wrapper](../../crates/portcove-core/src/service/sources.rs#L43)                                                                                                                                                                                               | `SourceIntakeInspection.summary/next_action`; success forwards source report, empty/multiple/shape/error branches add their own strings                                                                          | [SourceIntake](../../apps/desktop/src/components/SourceIntake.tsx#L361). Replace source folder / one source / supported shape with selected game files or file/folder language; keep no_paths/multiple_paths/unsupported_shape and read-only behavior. Parent received exact early replacements.                           |
| [Repair-plan guidance](../../crates/portcove-core/src/service.rs#L455)                                                                                                                                                                                                       | `DoctorReport.repair.items[].message/proposed_action`                                                                                                                                                            | [RecoveryReview](../../apps/desktop/src/components/RecoveryReview.tsx#L169) and human doctor. Restart/reconcile, private setup cleanup, missing registered path, orphan, malformed journal and incomplete coverage each retain distinct guidance. Raw retained error text is diagnostic data; no blanket sentence rewrite. |
| [Backup problems](../../crates/portcove-core/src/service/backups.rs#L680)                                                                                                                                                                                                    | `BackupInventory.problems[].message/proposed_action`; common [backup_problem](../../crates/portcove-core/src/service/backups.rs#L1649)                                                                           | BackupHistory warning/technical detail and human backup/doctor output. Preserve current restore hold and do not imply that diagnostic guidance itself authorizes manual deletion.                                                                                                                                          |
| [Backup coverage/protection](../../crates/portcove-core/src/service/protection.rs#L160)                                                                                                                                                                                      | `protection.problem`, installation problem/exclusions, path states and retained/effective declarations; [runtime data notices](../../crates/portcove-core/src/runtime_data_policy.rs#L222) contribute exclusions | ProtectionSummary, DetailPanel and preview preservation notices. Keep declaration/presence/current collection/completed backup/restore eligibility as separate facts; raw enum presentation remains a retained candidate.                                                                                                  |
| [Optional game settings](../../crates/portcove-core/src/service/game_settings.rs#L80)                                                                                                                                                                                        | `GameSettingsView.reason` and file-level reason contain domain error messages rather than FailurePresentation                                                                                                    | [GameSettingsPanel](../../apps/desktop/src/components/GameSettingsPanel.tsx#L54) and CLI game-settings renderer. Reasons include missing active install, absent retained contract, unsupported exact release and unreadable config. A current catalog declaration never grants an older installation write authority.      |
| [Comparison operation eligibility](../../crates/portcove-core/src/service/listings/recommendations.rs#L658)                                                                                                                                                                  | `GameComparison.ports[].operation.reason` for held/unknown                                                                                                                                                       | [GameComparisonEvidence](../../apps/desktop/src/features/recommendations/GameComparisonEvidence.tsx#L274). The initial Debug-formatted reason leaked into the human explanation. The parent subsequently added an explicit human mapping and retained the actual held reason, advisory status and existing action checks.  |
| [Preparation messages](../../crates/portcove-core/src/preparation_execution.rs#L305), [install messages](../../crates/portcove-core/src/install.rs#L1201), [import message](../../crates/portcove-core/src/source_import.rs#L481)                                            | `OperationEventKind::Message` through Tauri channels/events and CLI progress                                                                                                                                     | Preparation, GameUpdates, OperationProgress and human progress. Proposals replace “Materializing the reviewed source/runtime originals” with preparing reviewed game files; preserve stable phase IDs and partial/recovery state.                                                                                          |
| [Source discovery issue creation](../../crates/portcove-core/src/source_discovery.rs#L2483)                                                                                                                                                                                  | scan issues retain domain `message` and omitted/limit counts                                                                                                                                                     | SourceDiscovery / GameFileLibraries and human source discovery. Keep bounded scope, unavailable folders, skipped links and partial scans explicit. File absence cannot be inferred from incomplete work.                                                                                                                   |
| [Output destination validation](../../crates/portcove-core/src/output_root.rs) and [relocation](../../crates/portcove-core/src/output_relocation.rs)                                                                                                                         | validation_errors and cleanup-pending paths                                                                                                                                                                      | OutputLocation review and human output preview/relocation. Folder availability/ownership/capacity and retained old files remain independent; no blanket “safe” result for unknowns.                                                                                                                                        |
| [Package selection](../../crates/portcove-core/src/service/package_selection.rs#L90), [catalog download](../../crates/portcove-core/src/service/catalog_download.rs#L700) and [listing maintenance](../../apps/desktop/src/features/browsing/ListingMaintenanceFacts.tsx#L5) | acquisition reasons, pending setup and authored maintenance reason/reconsider_when                                                                                                                               | CatalogDownload, SelfServiceSetup, ListingDetailPanel, detail release information and CLI setup. Human labels must not make filename hints a compatibility check or download into execution. Catalog-authored wording remains the catalog worker's scope.                                                                  |
| Tauri application update status/recovery/schedule and [native confirmations](../../apps/desktop/src-tauri/src/lib.rs#L440)                                                                                                                                                   | typed updater states are mapped by ApplicationUpdates/Notices; host-owned prompt strings remain native                                                                                                           | Check, download, staged identity, restart request, installer start, reported installer success and confirmed running version remain separate. Do not replace a signed/checked update's precise trust evidence with a generic gameplay/safety badge.                                                                        |

Native consent enumeration includes adoption, backup restore/deletion, Steam
single/batch shortcuts, saved source removal, managed removal, Ghostship legacy
recovery, catalog publisher trust, external selection/relink/registration/removal,
shared-preferences acceptance, preparation cleanup and library import. Picker
source enumeration includes artwork, game/BIOS/ZIP, folder, library, Steam,
output folder, host tool executable, metadata import/export and signed catalog.
The shared generic install-folder picker intentionally lacks a task-specific
title; a future change should supply call-site purpose rather than rename it
for every consumer. The [HTML/app window metadata](../../apps/desktop/index.html)
and [bundle description](../../apps/desktop/src-tauri/tauri.conf.json#L49)
were also read; their normal product title/description requires no new claim.

## Human CLI review and preserved advanced content

The file inventory includes every source module under `portcove-cli/src`,
including root/argument help, nested help, catalog/comparison renderers, task
results, transfer output, retained-build output, game settings, setup, progress,
cancellation and dispatch prompts. Help comments and literal output candidates
are retained even when their command is advanced or hidden. Static editorial
review does not mean every generated `--help` path was executed.

Task grouping in [args](../../crates/portcove-cli/src/args.rs#L9), safe failure
summaries and next steps in [human adapters](../../crates/portcove-cli/src/human_adapters.rs#L382),
per-item batches and transfer outcomes are already maintained owners; extend
them. Keep JSON/JSONL fields, exit behavior, source/profile IDs, CLI aliases,
review fingerprints, final paths and cancellation terminal evidence unchanged.

Further retained candidates include:

- [Comparison human output](../../crates/portcove-cli/src/catalog/comparison.rs#L4)
  prints Debug enum/Option values, a raw evaluation timestamp and ranking evidence
  numbers in its default human view. Use explicit human state labels, labeled UTC
  time and a task summary; retain exact source/evidence IDs in relevant details.
  Optional unknown evidence must not become failed or zero. This needs a scoped
  renderer change, not replacing serialized fields or globally removing enums.
- [Game settings output](../../crates/portcove-cli/src/game_settings.rs#L82)
  displays Core reasons directly; review those alongside the Desktop panel.
- [Retained-build output](../../crates/portcove-cli/src/retained_build_human.rs#L11)
  says “Verified local build”. If revised, name the local manifest/current-policy
  check scope and retain the existing launch/preparation recheck caveat. Do not
  imply upstream availability, another host or future download guarantees.
- Inert `catalog export`, schema exports, proposal/publication inspectors and
  explicit capability output legitimately retain technical identifiers and full
  documents. A human formatting pass does not convert them into a player install
  workflow or remove consequential trust/review inputs.
- Raw game streams from `exec` and retained preparation stdout/stderr are evidence
  or game output. They are not Portcove-authored copy to rephrase. CLI signal and
  cancellation warnings are separately retained; their safety/redaction cannot
  be established by a terminology pass alone.

## Player documents, READMEs and release notes

[docs/README](../README.md) already distinguishes player tasks, connector authors,
current contributor contracts, original release evidence and dated snapshots.
The Markdown inventory explicitly preserves that audience distinction.

| Documents                                                                                                                                                    | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Root README](../../README.md), [downloads](../DOWNLOADS.md), [upgrading](../UPGRADING.md), CLI task sections                                                | Current player entry points. Root README belongs to the initial worker; download choices distinguish desktop/CLI/source archives and exact published Alpha 2 from compatible newer candidates. Apply the conditional safety-backup correction and keep package/version/OS limits.                                                                                                                                                                                                                     |
| [CLI exact-package and game-file tasks](../CLI.md#exact-package-registration), [library recovery](../CLI.md#recover-an-interrupted-transfer)                 | Human task guidance with advanced evidence where consequential. Keep registration separate from launch, imports separate from metadata exports, and original/external files separate from managed content. Examples/flags remain literal contracts.                                                                                                                                                                                                                                                   |
| [UPGRADING whole-library copy](../UPGRADING.md#before-upgrading)                                                                                             | Further consistency candidate: “complete library” / “protects the full state” should cross-link current [manual recovery-copy exclusions](../../apps/desktop/src/components/LibraryRecovery.tsx#L154): protected RetroAchievements sign-in files are not transferable, external originals/BIOS/installations/saves require separate handling, and a copied folder is not a tested restore. Preserve the exact Alpha 1→Alpha 2 historical downgrade requirements; do not rewrite frozen release notes. |
| [Glossary](../../GLOSSARY.md), [security policy](../../SECURITY.md)                                                                                          | Domain/trust authorities also read by technical players. Preserve exact meanings; no broad source/runtime/retained terminology substitution. Potential security-policy freshness claims need their owning source/spec review, not editorial inference.                                                                                                                                                                                                                                                |
| [Playnite README](../../integrations/playnite/README.md), [integration author guide](../INTEGRATION-AUTHOR.md), CLI reference/schema-history sections        | Advanced integration/maintainer guidance. Exact version windows, SDK/API identifiers, opt-in runner evidence and compatibility limits are purposeful. Improve player onboarding only where appropriate; never rename those symbols to match ordinary Desktop labels.                                                                                                                                                                                                                                  |
| [Alpha 1](../releases/0.1.0-alpha.1-release-notes.md), [Alpha 2](../releases/0.1.0-alpha.2-release-notes.md), [release-record policy](../releases/README.md) | Historical published release sources. They retain original scope, asset names, older UI labels, manual-upgrade behavior and unassessed evidence. The release-record policy says not to rewrite after publication. Add current navigation/context outside the frozen records when needed.                                                                                                                                                                                                              |
| [First-play media](../media/first-play/README.md), [application-update media](../media/application-update/README.md), docs/evidence, docs/qualification      | Original captures and dated observations. Preserve quoted UI, hashes, bytes, source commits, failed paths and method/platform limits. Current wording guidance does not authorize changing screenshots or their historical captions into a newer observation.                                                                                                                                                                                                                                         |
| docs/archive, ADRs, release-readiness snapshots, generated references, contributor/tool READMEs, vendor docs                                                 | Historical, future-decision, generated, advanced, developer or third-party content. Retained in the audience inventory; not a second customer-copy backlog, global rename target or fresh runtime proof.                                                                                                                                                                                                                                                                                              |

## Completion boundary and remaining evidence

This work supplies a finite source inventory, contextual editorial findings,
exact script-ready proposals and direct backend-to-customer routes. It does not
claim that every enumerated Rust string/Markdown paragraph was individually
edited or that every Desktop composition was rendered. Production fixtures,
native picker focus, long Unicode values, keyboard/screen-reader narration,
unknown/zero/one/many/partial/failure/cancellation branches and end-to-end
entry → review → result → recovery need the owning implementation's applicable
checks. Historical data, tool/game stdout, generated machine contracts and
advanced identifiers are deliberately preserved.

Before delivery, the implementing worker should reconcile exact proposals with
the final diff, verify changed string assertions in meaningful existing tests,
perform the required independent review and exact-head hosted checks, then
reconcile #4198. No new publication/signing/protected-acceptance authority is
created by this inventory.
