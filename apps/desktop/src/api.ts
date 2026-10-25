import type {
  ArtworkSlot,
  ArtworkState,
  ArtworkThumbnail,
  CliCommandContext,
  BackupAction,
  BackupReview,
  PortRemovalPreview,
  ExternalRuntimePreview,
  ExternalRuntimeRemovalPreview,
  ExternalRuntimeRecord,
} from "./types";

import type { InstallInput, LaunchResult } from "./types";
import type { GameUpdatePlan, PreparationCleanupPreview, PreparationPlan } from "./types";
import type {
  ListingDeliveryStatus,
  CatalogStatus,
  CatalogUpdatePlan,
  CatalogUpdateSource,
} from "./types";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { FrontendFailureReport } from "./frontend-diagnostics";
import type { CancellationState, OperationEvent } from "./types";
import type {
  LibraryImportPlan,
  LibraryImportResult,
  LibraryMovePlan,
  LibraryMoveResult,
} from "./types";
import type {
  SourceDiscoveryLimits,
  SourceDiscoveryRequest,
  SourceDiscoveryReport,
  SourceImportMode,
  SourceImportPlan,
  SourceImportResult,
  SourceInboxPaths,
  SourceInboxResolution,
} from "./types";
import type {
  ActivityDiagnostic,
  ActivityFeed,
  AdoptionPreview,
  ApplicationUpdateChoice,
  ApplicationUpdateCheckPhase,
  ApplicationUpdateCheckResult,
  ApplicationUpdateManualCheckRequest,
  ApplicationUpdateManualCheckResult,
  ApplicationUpdateDownloadRequest,
  ApplicationUpdateNoticeSnapshot,
  ApplicationUpdatePreferences,
  ApplicationUpdateProductionDecision,
  ApplicationUpdateProductionTransition,
  ApplicationUpdateProductionTransitionResult,
  ApplicationUpdateRecoveryArea,
  ApplicationUpdateStatus,
  BackupInventory,
  BackupRecord,
  BootstrapStatus,
  CapabilityDocument,
  CatalogDocument,
  CatalogDownloadCandidates,
  CatalogDownloadPreview,
  CatalogDownloadRequest,
  PendingSetupRecord,
  DefinitionCapabilityReport,
  DefinitionCapabilityRequest,
  DesktopSupportBundleExport,
  DoctorReport,
  GithubAuthStatus,
  GithubDeviceLogin,
  GithubDeviceLoginResult,
  GameFileRoot,
  GameFileQueryRefreshRequest,
  GameFileQuerySnapshot,
  GameFileScanSnapshot,
  HostToolProbeResult,
  HostToolStatus,
  InstallPlan,
  InstallRecord,
  LibraryIdentity,
  LibraryMetadataFile,
  LocalePreferenceSnapshot,
  OutputDestinationPreview,
  OutputRelocationPlan,
  OutputRelocationResult,
  OutputRelocationStatus,
  PortOutputLocation,
  PortStatus,
  ReleaseChannel,
  RestoreResult,
  SourceInspectionReport,
  SourceIntakeInspection,
  SourceRecord,
  SourceRelinkPlan,
  SourceRemovalPreview,
  SourceVerificationOutcome,
  SteamEntryApplyResult,
  SteamEntryOperation,
  SteamEntryReview,
  SteamEntrySelection,
  SteamBatchReview,
  SteamBatchSelection,
  UpdateCheck,
  UpdateCheckOutcome,
  UpdatePolicy,
  WorkspaceSnapshot,
} from "./types";

export type DesktopArtworkThumbnail = Pick<ArtworkThumbnail, "asset_sha256" | "choice_revision"> & {
  png_base64: string;
};

export const desktopApi = {
  favoritePorts: (generation: number) => invoke<string[]>("get_favorite_ports", { generation }),
  setPortFavorite: (portId: string, favorite: boolean, generation: number) =>
    invoke<void>("set_port_favorite", { portId, favorite, generation }),
  localePreference: () => invoke<LocalePreferenceSnapshot>("get_locale_preference"),
  setLocalePreference: (locale: string | null) =>
    invoke<LocalePreferenceSnapshot>("set_locale_preference", { locale }),
  applicationUpdateNotice: () =>
    invoke<ApplicationUpdateNoticeSnapshot>("get_application_update_notice"),
  dismissApplicationUpdateNotice: (expectedRevision: number) =>
    invoke<ApplicationUpdateNoticeSnapshot>("dismiss_application_update_notice", {
      expectedRevision,
    }),
  applicationUpdatePreferences: () =>
    invoke<ApplicationUpdatePreferences>("get_application_update_preferences"),
  applicationUpdateProductionTransition: () =>
    invoke<ApplicationUpdateProductionTransition>("get_application_update_production_transition"),
  completeApplicationUpdateProductionTransition: (
    expectedRevision: number,
    decision: ApplicationUpdateProductionDecision,
  ) =>
    invoke<ApplicationUpdateProductionTransitionResult>(
      "complete_application_update_production_transition",
      { expectedRevision, decision },
    ),
  setApplicationUpdatePreferences: (expectedRevision: number, choice: ApplicationUpdateChoice) =>
    invoke<ApplicationUpdatePreferences>("set_application_update_preferences", {
      expectedRevision,
      choice,
    }),
  resetApplicationUpdatePreferences: () =>
    invoke<ApplicationUpdatePreferences>("reset_application_update_preferences"),
  recoverApplicationUpdatePreferences: () =>
    invoke<ApplicationUpdatePreferences>("recover_application_update_preferences"),
  applicationUpdateStatus: () => invoke<ApplicationUpdateStatus>("get_application_update_status"),
  recoverApplicationUpdateState: (area: ApplicationUpdateRecoveryArea) =>
    invoke<ApplicationUpdateStatus>("recover_application_update_state", { area }),
  checkApplicationUpdate: (
    onEvent: (event: ApplicationUpdateCheckPhase) => void,
    request: ApplicationUpdateManualCheckRequest = {},
  ) => {
    const channel = new Channel<ApplicationUpdateCheckPhase>();
    channel.onmessage = onEvent;
    return invoke<ApplicationUpdateManualCheckResult>("check_application_update", {
      request,
      onEvent: channel,
    });
  },
  downloadApplicationUpdate: (
    request: ApplicationUpdateDownloadRequest,
    onEvent: (event: ApplicationUpdateCheckPhase) => void,
  ) => {
    const channel = new Channel<ApplicationUpdateCheckPhase>();
    channel.onmessage = onEvent;
    return invoke<ApplicationUpdateCheckResult>("download_application_update", {
      request,
      onEvent: channel,
    });
  },
  cancelApplicationUpdateCheck: () => invoke<boolean>("cancel_application_update_check"),
  restartToApplyApplicationUpdate: (generation: number) =>
    invoke<void>("restart_to_apply_application_update", { generation }),
  artwork: (portId: string, slot: ArtworkSlot, generation: number) =>
    invoke<ArtworkState>("get_artwork", { portId, slot, generation }),
  artworkThumbnail: (
    portId: string,
    slot: ArtworkSlot,
    expectedRevision: number,
    generation: number,
  ) =>
    invoke<DesktopArtworkThumbnail>("get_artwork_thumbnail", {
      portId,
      slot,
      expectedRevision,
      generation,
    }),
  importArtwork: (
    portId: string,
    slot: ArtworkSlot,
    path: string,
    expectedRevision: number,
    generation: number,
  ) =>
    invoke<ArtworkState>("import_artwork", {
      portId,
      slot,
      path,
      expectedRevision,
      generation,
    }),
  resetArtwork: (portId: string, slot: ArtworkSlot, expectedRevision: number, generation: number) =>
    invoke<ArtworkState>("reset_artwork", {
      portId,
      slot,
      expectedRevision,
      generation,
    }),
  cliCommandContext: (generation: number) =>
    invoke<CliCommandContext>("get_cli_command_context", { generation }),
  libraryIdentity: (generation: number) =>
    invoke<LibraryIdentity>("get_library_identity", { generation }),
  listSteamProfiles: (steamRoot: string, generation: number) =>
    invoke<string[]>("list_steam_profiles", { steamRoot, generation }),
  previewSteamEntry: (
    portId: string,
    steamRoot: string,
    steamUserId: string,
    operation: SteamEntryOperation,
    generation: number,
  ) =>
    invoke<SteamEntryReview>("preview_steam_entry", {
      request: { portId, steamRoot, steamUserId, operation } satisfies SteamEntrySelection,
      generation,
    }),
  applySteamEntry: (
    portId: string,
    steamRoot: string,
    steamUserId: string,
    operation: SteamEntryOperation,
    expectedPlanSha256: string,
    generation: number,
  ) =>
    invoke<SteamEntryApplyResult | null>("apply_steam_entry", {
      request: { portId, steamRoot, steamUserId, operation } satisfies SteamEntrySelection,
      expectedPlanSha256,
      generation,
    }),
  previewSteamBatchAdd: (request: SteamBatchSelection, generation: number) =>
    invoke<SteamBatchReview>("preview_steam_batch_add", { request, generation }),
  applySteamBatchAdd: (
    request: SteamBatchSelection,
    expectedReviewSha256: string,
    generation: number,
  ) =>
    invoke<SteamEntryApplyResult | null>("apply_steam_batch_add", {
      request,
      expectedReviewSha256,
      generation,
    }),
  listingDeliveryStatus: () => invoke<ListingDeliveryStatus>("get_listing_delivery_status"),
  refreshCatalogListings: (
    metadataBaseUrl: string,
    targetsBaseUrl: string,
    onEvent: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<ListingDeliveryStatus>("refresh_catalog_listings", {
      metadataBaseUrl,
      targetsBaseUrl,
      onEvent: channel,
    });
  },
  catalogStatus: () => invoke<CatalogStatus>("get_catalog_status"),
  engineCapabilities: () => invoke<CapabilityDocument>("get_engine_capabilities"),
  checkDefinitionCapabilities: (request: DefinitionCapabilityRequest) =>
    invoke<DefinitionCapabilityReport>("check_definition_capabilities", { request }),
  trustCatalogKey: (publicKey: string) =>
    invoke<CatalogStatus | null>("trust_catalog_key", { publicKey }),
  revokeCatalogKey: (keyId: string, expectedState: string) =>
    invoke<CatalogStatus>("revoke_catalog_key", { keyId, expectedState }),
  planCatalogUpdate: (source: CatalogUpdateSource) =>
    invoke<CatalogUpdatePlan>("plan_catalog_update", { source }),
  applyCatalogUpdate: (
    source: CatalogUpdateSource,
    expectedPlan: string,
    onEvent: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<CatalogStatus>("apply_catalog_update", {
      source,
      expectedPlan,
      onEvent: channel,
    });
  },
  rollbackCatalog: (expectedState: string) =>
    invoke<CatalogStatus>("rollback_catalog", { expectedState }),
  useCachedCatalog: (expectedState: string) =>
    invoke<CatalogStatus>("use_cached_catalog", { expectedState }),
  useEmbeddedCatalog: (expectedState: string) =>
    invoke<CatalogStatus>("use_embedded_catalog", { expectedState }),

  bootstrapStatus: () => invoke<BootstrapStatus>("get_bootstrap_status"),
  defaultLibraryRoot: () => invoke<string>("get_default_library_root"),
  setDefaultLibrary: (path: string) => invoke<BootstrapStatus>("set_default_library", { path }),
  resetDefaultLibrary: () => invoke<BootstrapStatus>("reset_default_library"),
  githubAuthStatus: () => invoke<GithubAuthStatus>("get_github_auth_status"),
  setGithubToken: (token: string) => invoke<GithubAuthStatus>("set_github_token", { token }),
  logoutGithub: () => invoke<GithubAuthStatus>("logout_github"),
  beginGithubDeviceLogin: () => invoke<GithubDeviceLogin>("begin_github_device_login"),
  pollGithubDeviceLogin: (sessionId: string) =>
    invoke<GithubDeviceLoginResult>("poll_github_device_login", { sessionId }),
  catalog: () => invoke<CatalogDocument>("get_catalog"),
  statuses: () => invoke<PortStatus[]>("get_statuses"),
  workspaceSnapshot: (generation: number) =>
    invoke<WorkspaceSnapshot>("get_workspace_snapshot", { generation }),
  workspaceChanged: (generation: number) =>
    invoke<boolean>("get_workspace_changed", { generation }),
  catalogDownloadCandidates: (
    portId: string,
    generation: number,
    selectedReleaseId?: number,
    channel = "stable",
  ) =>
    invoke<CatalogDownloadCandidates>("catalog_download_candidates", {
      portId,
      generation,
      selectedReleaseId,
      channel,
    }),
  discoverSetupLaunchTargets: (portId: string, pendingId: string, generation: number) =>
    invoke<import("./types").SetupLaunchTargets>("discover_setup_launch_targets", {
      portId,
      pendingId,
      generation,
    }),
  previewCatalogDownload: (request: CatalogDownloadRequest, generation: number) =>
    invoke<CatalogDownloadPreview>("preview_catalog_download", { request, generation }),
  downloadCatalogPackage: (
    request: CatalogDownloadRequest,
    expectedPreviewSha256: string,
    generation: number,
    onEvent?: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    if (onEvent) channel.onmessage = onEvent;
    return invoke<PendingSetupRecord>("download_catalog_package", {
      request,
      expectedPreviewSha256,
      onEvent: channel,
      generation,
    });
  },
  forgetPendingSetup: (portId: string, pendingId: string, generation: number) =>
    invoke<void>("forget_pending_setup", { portId, pendingId, generation }),
  openPendingSetupFolder: (portId: string, pendingId: string, generation: number) =>
    invoke<void>("open_pending_setup_folder", { portId, pendingId, generation }),
  discoverOrphanedOperations: (generation: number) =>
    invoke<void>("discover_orphaned_operations", { generation }),
  planPreparation: (portId: string, generation: number) =>
    invoke<PreparationPlan>("plan_preparation", { portId, generation }),
  planGameUpdate: (portId: string, activate: boolean, generation: number) =>
    invoke<GameUpdatePlan>("plan_game_update", {
      portId,
      activate,
      generation,
    }),
  applyGameUpdate: (
    portId: string,
    activate: boolean,
    expectedPlan: string,
    generation: number,
    onEvent: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<InstallRecord>("apply_game_update", {
      portId,
      activate,
      expectedPlan,
      generation,
      onEvent: channel,
    });
  },
  prepare: (
    portId: string,
    expectedPlan: string,
    generation: number,
    onEvent: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<InstallRecord>("prepare_port", {
      portId,
      expectedPlan,
      generation,
      onEvent: channel,
    });
  },
  outputLocation: (portId: string, generation: number) =>
    invoke<PortOutputLocation>("get_output_location", { portId, generation }),
  previewOutputLocation: (portId: string, path: string | null, generation: number) =>
    invoke<OutputDestinationPreview>("preview_output_location", {
      portId,
      path,
      generation,
    }),
  setOutputLocation: (portId: string, path: string, expectedPreview: string, generation: number) =>
    invoke<PortOutputLocation>("set_output_location", {
      portId,
      path,
      expectedPreview,
      generation,
    }),
  resetOutputLocation: (portId: string, expectedPreview: string, generation: number) =>
    invoke<PortOutputLocation>("reset_output_location", {
      portId,
      expectedPreview,
      generation,
    }),
  planOutputRelocation: (portId: string, path: string, generation: number) =>
    invoke<OutputRelocationPlan>("plan_output_relocation", {
      portId,
      path,
      generation,
    }),
  relocateOutput: (portId: string, path: string, expectedPlan: string, generation: number) =>
    invoke<OutputRelocationResult>("relocate_output", {
      portId,
      path,
      expectedPlan,
      generation,
    }),
  outputRelocationStatus: (portId: string, generation: number) =>
    invoke<OutputRelocationStatus | null>("get_output_relocation_status", {
      portId,
      generation,
    }),
  sources: () => invoke<SourceRecord[]>("get_sources"),
  activities: () => invoke<ActivityFeed>("get_activities"),
  activityDiagnostic: (activityId: string, generation: number) =>
    invoke<ActivityDiagnostic>("get_activity_diagnostic", {
      activityId,
      generation,
    }),
  cancelOperation: (operationId: string) =>
    invoke<CancellationState>("cancel_operation", { operationId }),
  backups: (portId: string) => invoke<BackupInventory>("get_backups", { portId }),
  backup: (portId: string, generation: number) =>
    invoke<BackupRecord>("create_backup", { portId, generation }),
  previewBackupAction: (
    portId: string,
    backupId: string,
    action: BackupAction,
    generation: number,
  ) =>
    invoke<BackupReview>("preview_backup_action", {
      portId,
      backupId,
      action,
      generation,
    }),
  restoreBackup: (portId: string, backupId: string, expectedPreview: string, generation: number) =>
    invoke<RestoreResult | null>("restore_backup", {
      portId,
      backupId,
      expectedPreview,
      generation,
    }),
  deleteBackup: (portId: string, backupId: string, expectedPreview: string, generation: number) =>
    invoke<BackupRecord | null>("delete_backup", {
      portId,
      backupId,
      expectedPreview,
      generation,
    }),
  addSource: (profileId: string, path: string, expectedSha256?: string) =>
    invoke<SourceRecord>("add_source", { profileId, path, expectedSha256 }),
  gameFileRoots: (generation: number) =>
    invoke<GameFileRoot[]>("get_game_file_roots", { generation }),
  addGameFileRoot: (path: string, generation: number) =>
    invoke<GameFileRoot>("add_game_file_root", { path, generation }),
  relinkGameFileRoot: (rootId: string, path: string, generation: number) =>
    invoke<GameFileRoot>("relink_game_file_root", { rootId, path, generation }),
  removeGameFileRoot: (rootId: string, generation: number) =>
    invoke<boolean>("remove_game_file_root", { rootId, generation }),
  scanGameFileRoots: (
    limits: SourceDiscoveryLimits,
    generation: number,
    onEvent?: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = (event) => onEvent?.(event);
    return invoke<GameFileScanSnapshot>("scan_game_file_roots", {
      limits,
      generation,
      onEvent: channel,
    });
  },
  gameFileScanSnapshot: (generation: number) =>
    invoke<GameFileScanSnapshot | null>("get_game_file_scan_snapshot", { generation }),
  refreshGameFileQuery: (
    request: GameFileQueryRefreshRequest,
    generation: number,
    onEvent?: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = (event) => onEvent?.(event);
    return invoke<GameFileQuerySnapshot>("refresh_game_file_query", {
      request,
      generation,
      onEvent: channel,
    });
  },
  discoverSources: (request: SourceDiscoveryRequest, onEvent?: (event: OperationEvent) => void) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = (event) => onEvent?.(event);
    return invoke<SourceDiscoveryReport>("discover_sources", {
      request,
      onEvent: channel,
    });
  },
  sourceInboxPaths: (profileId: string) =>
    invoke<SourceInboxPaths>("get_source_inbox_paths", { profileId }),
  openSourceInbox: (profileId: string) =>
    invoke<SourceInboxPaths>("open_source_inbox", { profileId }),
  scanSourceInbox: (
    profileId: string,
    limits: SourceDiscoveryLimits,
    onEvent?: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = (event) => onEvent?.(event);
    return invoke<SourceInboxResolution>("scan_source_inbox", {
      profileId,
      limits,
      onEvent: channel,
    });
  },
  planSourceImport: (profileId: string, path: string, mode: SourceImportMode) =>
    invoke<SourceImportPlan>("plan_source_import", { profileId, path, mode }),
  importSource: (
    profileId: string,
    path: string,
    mode: SourceImportMode,
    expectedPlan: string,
    onEvent?: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = (event) => onEvent?.(event);
    return invoke<SourceImportResult | null>("import_source", {
      profileId,
      path,
      mode,
      expectedPlan,
      onEvent: channel,
    });
  },
  planSourceRelink: (profileId: string, path: string) =>
    invoke<SourceRelinkPlan>("plan_source_relink", { profileId, path }),
  relinkSource: (profileId: string, path: string, previewSha256: string) =>
    invoke<SourceRecord>("relink_source", { profileId, path, previewSha256 }),
  previewSourceRemoval: (profileId: string, generation: number) =>
    invoke<SourceRemovalPreview>("preview_source_removal", {
      profileId,
      generation,
    }),
  removeSource: (profileId: string, previewSha256: string, generation: number) =>
    invoke<SourceRemovalPreview | null>("remove_source", {
      profileId,
      previewSha256,
      generation,
    }),
  verifySources: () => invoke<SourceVerificationOutcome[]>("verify_sources"),
  inspectSource: (profileId: string) =>
    invoke<SourceInspectionReport>("inspect_source", { profileId }),
  inspectSourceIntake: (profileId: string, paths: string[]) =>
    invoke<SourceIntakeInspection>("inspect_source_intake", {
      profileId,
      paths,
    }),
  openSourceEvidence: (evidenceId: string) => invoke<void>("open_source_evidence", { evidenceId }),
  check: (portId: string, generation: number) =>
    invoke<UpdateCheck>("check_port", { portId, generation }),
  checkInstalled: () => invoke<UpdateCheckOutcome[]>("check_installed"),
  doctor: (generation: number) => invoke<DoctorReport>("get_doctor_report", { generation }),
  previewPreparationCleanup: (operationId: string, generation: number) =>
    invoke<PreparationCleanupPreview>("preview_preparation_cleanup", {
      operationId,
      generation,
    }),
  cleanupPreparation: (operationId: string, expectedPreview: string, generation: number) =>
    invoke<PreparationCleanupPreview | null>("cleanup_preparation", {
      operationId,
      expectedPreview,
      generation,
    }),
  hostTools: () => invoke<HostToolStatus[]>("get_host_tools"),
  setHostToolPath: (toolId: string, path: string) =>
    invoke<HostToolProbeResult>("set_host_tool_path", { toolId, path }),
  clearHostToolPath: (toolId: string) => invoke<HostToolStatus>("clear_host_tool_path", { toolId }),
  recheckHostTool: (toolId: string) => invoke<HostToolProbeResult>("recheck_host_tool", { toolId }),
  openHostToolOfficialSite: (toolId: string) =>
    invoke<void>("open_host_tool_official_site", { toolId }),
  createSupportBundle: () => invoke<DesktopSupportBundleExport>("create_support_bundle"),
  runtimeDiagnosticHealth: () => invoke<string>("get_runtime_diagnostic_health"),
  exportLibraryMetadata: (path: string) =>
    invoke<LibraryMetadataFile>("export_library_metadata", { path }),
  planLibraryMove: (destination: string) =>
    invoke<LibraryMovePlan>("plan_library_move", { destination }),
  moveLibrary: (destination: string, expectedPlan: string) =>
    invoke<LibraryMoveResult>("move_library", { destination, expectedPlan }),
  recoverLibraryMove: (source: string, abort: boolean) =>
    invoke<LibraryMoveResult>("recover_library_move", { source, abort }),
  planLibraryImport: (metadata: string, contentRoot: string) =>
    invoke<LibraryImportPlan>("plan_library_import", { metadata, contentRoot }),
  importLibrary: (metadata: string, contentRoot: string, expectedPlan: string) =>
    invoke<LibraryImportResult>("import_library", {
      metadata,
      contentRoot,
      expectedPlan,
    }),
  recoverLibraryImport: (destination: string) =>
    invoke<LibraryImportResult>("recover_library_import", {
      destination,
      abort: false,
    }),
  reportFrontendError: (report: FrontendFailureReport) =>
    invoke<void>("report_frontend_error", { report }),
  plan: (portId: string, channel: ReleaseChannel) =>
    invoke<InstallPlan>("plan_port", { portId, channel }),
  openUserData: (portId: string, generation: number) =>
    invoke<string>("open_user_data", { portId, generation }),
  openManualSetupFolder: (portId: string, installId: string, generation: number) =>
    invoke<string>("open_manual_setup_folder", { portId, installId, generation }),
  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),
  setChannel: (portId: string, channel: ReleaseChannel, generation: number) =>
    invoke<PortStatus>("set_channel", { portId, channel, generation }),
  setPolicy: (portId: string, policy: UpdatePolicy, generation: number) =>
    invoke<PortStatus>("set_policy", { portId, policy, generation }),
  install: (
    portId: string,
    channel: ReleaseChannel,
    source: string,
    bios: string,
    stage: boolean,
    generation: number,
  ) =>
    invoke<InstallRecord>("install_port", {
      generation,
      input: {
        portId,
        channel,
        source: source || null,
        bios: bios || null,
        stage,
      } satisfies InstallInput,
    }),
  verify: (portId: string, generation: number) => invoke("verify_port", { portId, generation }),
  activate: (
    portId: string,
    expectedActive: string | null,
    expectedStaged: string,
    generation: number,
  ) =>
    invoke<InstallRecord>("activate_port", {
      portId,
      expectedActive,
      expectedStaged,
      generation,
    }),
  rollback: (portId: string, generation: number) => invoke("rollback_port", { portId, generation }),
  previewRemoval: (portId: string, generation: number) =>
    invoke<PortRemovalPreview>("preview_removal", { portId, generation }),
  remove: (portId: string, expectedPreview: string, generation: number) =>
    invoke<string[] | null>("remove_port", {
      portId,
      expectedPreview,
      generation,
    }),
  previewExternalRuntime: (portId: string, path: string, generation: number) =>
    invoke<ExternalRuntimePreview>("preview_external_runtime", { portId, path, generation }),
  previewUserSelectedRuntime: (
    portId: string,
    executable: string,
    workingDirectory: string,
    arguments_: string[],
    generation: number,
  ) =>
    invoke<ExternalRuntimePreview>("preview_user_selected_runtime", {
      portId,
      executable,
      workingDirectory,
      arguments: arguments_,
      generation,
    }),
  registerUserSelectedRuntime: (
    portId: string,
    executable: string,
    workingDirectory: string,
    arguments_: string[],
    expectedPreview: string,
    generation: number,
  ) =>
    invoke<ExternalRuntimeRecord | null>("register_user_selected_runtime", {
      portId,
      executable,
      workingDirectory,
      arguments: arguments_,
      expectedPreview,
      generation,
    }),
  previewUserSelectedRuntimeRelink: (
    portId: string,
    executable: string,
    workingDirectory: string,
    arguments_: string[],
    generation: number,
  ) =>
    invoke<import("./types").ExternalRuntimeRelinkPreview>("preview_user_selected_runtime_relink", {
      portId,
      executable,
      workingDirectory,
      arguments: arguments_,
      generation,
    }),
  relinkUserSelectedRuntime: (
    portId: string,
    executable: string,
    workingDirectory: string,
    arguments_: string[],
    expectedPreview: string,
    generation: number,
  ) =>
    invoke<ExternalRuntimeRecord | null>("relink_user_selected_runtime", {
      portId,
      executable,
      workingDirectory,
      arguments: arguments_,
      expectedPreview,
      generation,
    }),
  previewExternalRuntimeRelink: (portId: string, path: string, generation: number) =>
    invoke<import("./types").ExternalRuntimeRelinkPreview>("preview_external_runtime_relink", {
      portId,
      path,
      generation,
    }),
  previewManagedRouteChange: (portId: string, generation: number) =>
    invoke<import("./types").ManagedRouteChangePreview>("preview_managed_route_change", {
      portId,
      channel: null,
      outputDirectory: null,
      generation,
    }),
  changeToManagedRuntime: (portId: string, expectedPreview: string, generation: number) =>
    invoke<import("./types").ManagedRouteChangeResult>("change_to_managed_runtime", {
      portId,
      channel: null,
      outputDirectory: null,
      expectedPreview,
      generation,
    }),
  relinkExternalRuntime: (
    portId: string,
    path: string,
    expectedPreview: string,
    generation: number,
  ) =>
    invoke<ExternalRuntimeRecord | null>("relink_external_runtime", {
      portId,
      path,
      expectedPreview,
      generation,
    }),
  registerExternalRuntime: (
    portId: string,
    path: string,
    expectedPreview: string,
    generation: number,
  ) =>
    invoke<ExternalRuntimeRecord | null>("register_external_runtime", {
      portId,
      path,
      expectedPreview,
      generation,
    }),
  previewExternalRemoval: (portId: string, generation: number) =>
    invoke<ExternalRuntimeRemovalPreview>("preview_external_removal", { portId, generation }),
  removeExternalRuntime: (portId: string, expectedPreview: string, generation: number) =>
    invoke<ExternalRuntimeRecord | null>("remove_external_runtime", {
      portId,
      expectedPreview,
      generation,
    }),
  launch: (portId: string, source: string, generation: number) =>
    invoke<LaunchResult>("launch_port", {
      portId,
      generation,
      source: source || null,
      arguments: [],
    }),
  previewAdoption: (path: string, generation: number, portId?: string) =>
    invoke<AdoptionPreview>("preview_adoption", {
      path,
      generation,
      portId: portId ?? null,
    }),
  adopt: (path: string, planSha256: string, generation: number, portId?: string) =>
    invoke<InstallRecord | null>("adopt_port", {
      path,
      generation,
      portId: portId ?? null,
      planSha256,
    }),
};
