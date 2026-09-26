# Desktop capability and state inventory — 2026-09-25

This is a source and checked-in-test inventory for the #206 information-architecture
acceptance delta at main `4bd1df1a35decc1a30d4b8d0c4e7352bb40d1311`. It maps
the existing desktop journeys to their current destination and identifies the
state that can be revisited. It is dated evidence, not a second roadmap or a
claim that #206 or #917 is complete. The live issues and Project own remaining
work and status.

| Journey | Current destination and authority | State and return path visible in source | Checked-in evidence and limit |
| --- | --- | --- | --- |
| First use and empty library | `PortBrowser` Library empty state routes to Catalog; `useLibraryBrowsingContext` chooses Catalog once for the first eligible empty profile in the UI preference store after a coherent snapshot. | Early explicit input keeps its chosen destination. Empty, filtered-empty, unavailable, and refresh-failure copy have separate paths. | `use-library-browsing-context.test.tsx`, `PortBrowser` tests, `desktop-test.mjs` `empty-library`; actual prior native results remain on #206. |
| Library and Catalog discovery | `PortBrowser` renders separate library controls and catalog discovery cards; `useAppModel` derives entries from backend catalog/status. | Per-view query/filter, catalog sort, scroll and focus snapshots live in `useAppShellState` and `useWorkspaceContinuity`; library switch records the prior library's browsing context. | `use-library-browsing-context.test.tsx`, `keyboard-shortcuts` tests; source tests do not prove physical controller use. |
| Continue, Play, details and overflow | Library cards expose separate Details, Play and overflow controls; Catalog cards open details. | Detail opening records exact origin and scroll; Back restores the origin or workspace focus. Removed entries return to browsing. | `use-detail-workspace-navigation.test.tsx`, card tests, native `keyboard-layout` scenario. |
| Game details and installation review | `DetailPanel` is a main-workspace destination. It leads with state/action, then requirements, installation/version, updates, saves/storage, compatibility/testing, project/release and technical details. Bounded install review remains a dialog. | Ready, missing game files, BIOS, staged update, external runtime and pending setup have distinct actions. Review keeps core-supplied plan/consequences. | `DetailPanel` and install-action tests, #924 component scenarios, native `keyboard-layout`; minimum platforms and human comprehension remain separate. |
| Game files and source discovery | Detail Requirements offers inline source controls and `SourceIntakeDialog`; Settings > Game Files offers saved source health and `SourceDiscoveryButton`. | Intake selects a specific port/profile; async source health and library generation reject stale context. | `SourceIntake.test.tsx`, `SourceDiscovery.test.tsx`, `SourceIdentity.test.tsx`, native `native-source-intake-and-discovery-dialogs`. |
| Saved game-file removal | Settings > Game Files renders `SourceRemovalControl` with a preview and bounded review before removing a saved reference. | The reviewed action names the source and impact; core owns the removal and resulting source health. | `SourceRemoval.test.tsx`, native `native-reviewed-source-reference-removal` in `desktop-source-removal-test.mjs`; no game file deletion is implied. |
| Optional local artwork | `ArtworkControls` and `DetailArtwork` live in details; fallback cover is independent of title, state and actions. Settings offers appearance, while local choose/reset actions live with each game. | Artwork requests and choices are keyed to port/library generation; no provider setup is required for first play. | `Artwork.test.tsx`, native `native-local-artwork-picker-and-recovery`; online provider browsing remains open under #527. |
| Tools and library storage | Settings sections expose tool status, library selection, location, move and import; bootstrap recovery offers library choice and platform default before workspace entry. | Picker cancellation and move/import recovery have separate component routes; library selection returns to the prior browsing context when available. | `LibraryImport.test.tsx`, `use-library-browsing-context.test.tsx`, native source/tool scenarios; unavailable device and capacity claims require their own fixtures. |
| Per-game output location | Detail Saves and storage renders `OutputLocationControl` for eligible managed setup output; core owns the path and migration consequence. | A changed location invalidates the pending install plan; the control handles unavailable or stale location intent. | `OutputLocation` tests and detail component coverage; source review is not native removable-drive evidence. |
| Game updates and activity | Sidebar Game updates & activity hosts `UpdateCenter`, while Settings owns Portcove and catalog updates. Both provide cross-links. | Saved game-update checks reconnect after restart, fresh failures take precedence, external runtimes are labelled externally updated. Core activity feed protects active/actionable records beyond recent history. | `GameUpdates.test.tsx`, `UpdateNavigation.test.tsx`, `workspace-refresh.test.tsx`; component evidence for restored-check precedence is distinct from native restart. |
| Preparation failure and retained log | `UpdateCenter` activity rows show failure summary, recovery action, cancellation state and `ActivityDiagnostic` log disclosure. | Activity feed and workspace snapshot reconnect from core; diagnostic read is generation-scoped and stale responses are ignored. | `ActivityDiagnostic.test.tsx`, workspace refresh tests, native preparation-recovery scenario; a frontend restart is not evidence that every task resumes. |
| Install, update, backup and removal | Detail owns reviewed install/update actions, `BackupHistory` and `RemovalControl`; core owns outcomes and persistent state. | Mutation reviews distinguish cancellation, failure, recovery and retained data; activity remains in Updates after leaving details. | `InstallAction.test.tsx`, `BackupReview.test.tsx`, `RemovalReview.test.tsx`, `RecoveryReview.test.tsx`; source tests do not establish game save compatibility. |
| Catalog and application updates | Settings hosts `CatalogSettings` and application update preferences/notices, separate from game updates. | Publisher/review state and app-update recovery are backend/host-owned; UI provides review, consent and recovery destinations. | `CatalogUpdates.test.tsx`, `ApplicationUpdates.test.tsx`, native application-update scenario; publication/signing is outside this inventory. |
| Integration and external installation | Settings has Integrations; details offer external-runtime registration, launch-command help and reviewed Steam entry actions. Library offers a reviewed multi-game Steam entry action; adoption is a bounded dialog. | Registered runtime is explicitly external, with Portcove management limits; copied installations and Steam entry changes use review paths. Steam integration does not turn Steam into the release or save authority. | `ExternalRuntime.test.tsx`, `AdoptionModal.test.tsx`, `SteamEntry.test.tsx`, native `native-reviewed-steam-entry-add-and-remove`; registration is not gameplay or platform qualification. |
| Global navigation and overlays | `Sidebar`, `PageHeader`, command palette and Base UI dialogs/menus share the shell. | `navigationScope`, `overlayBackAction`, command shortcuts and detail return coordinate dismissal, focus and primary navigation. | `CommandPalette.test.ts`, navigation/focus tests and native `keyboard-layout`; physical controller and IME coverage are separate. |
| Crash, refresh and interrupted recovery | `ErrorBoundary`, `WorkspaceRefreshNotice`, `LibraryMoveRecovery`, `LibraryImportRecovery`, `RecoveryReview`, StatusLayer and Updates expose distinct recovery surfaces. | Workspace refresh retains its last coherent snapshot, activity is read from core after mount, and move/import recovery can precede normal workspace entry. | `workspace-refresh.test.tsx`, recovery tests, native `native-error-recovery` and preparation-recovery scenarios. |

## Acceptance still requiring direct evidence or implementation

- The accepted #206/#917 matrix calls for both themes, 1280×800 and 960×640,
  scaling, long and mixed artwork, keyboard, mouse, controller, async removal,
  nested overlays, native pickers and return from game. Existing component
  scenarios and prior Windows native slices cover parts of it; this source map
  does not certify the matrix or physical/human observations.
- #206 UA-12 asks for specific Settings recovery destinations from readiness,
  missing-tool, source, storage and update messages. `UpdateCenter` currently
  provides a target-aware Settings route for activity and update messages, while
  `DetailPanel` offers source controls inline. The other cross-workspace
  recovery routes require a focused route audit and any missing links before
  that acceptance can be checked off.
- The optional online artwork provider and its Settings integration are not
  present in this checkout. #527 owns that follow-on; local choose/reset and
  fallback remain the available artwork journey.
- The activity and recovery entries establish discoverable UI paths and
  backend-read state. They do not establish resumption of an interrupted
  operation, complete history beyond the feed's declared coverage, or native
  restart behavior for every failure state.
