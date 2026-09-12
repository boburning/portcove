import type {
  ArtworkSlot,
  ArtworkState,
  ArtworkThumbnail,
  CliCommandContext,
  BackupAction,
  BackupReview,
  PortRemovalPreview,
} from "./types";
import type { InstallInput, LaunchResult } from "./types";
import type { GameUpdatePlan, PreparationPlan } from "./types";
import type { CatalogStatus, CatalogUpdatePlan, CatalogUpdateSource } from "./types";
import { Channel, invoke } from "@tauri-apps/api/core";
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
  ActivityRecord,
  AdoptionPreview,
  ApplicationUpdateChoice,
  ApplicationUpdatePreferences,
  ApplicationUpdateRecoveryArea,
  ApplicationUpdateStatus,
  BackupInventory,
  BackupRecord,
  BootstrapStatus,
  CatalogDocument,
  DoctorReport,
  GithubAuthStatus,
  GithubDeviceLogin,
  GithubDeviceLoginResult,
  HostToolProbeResult,
  HostToolStatus,
  InstallPlan,
  InstallRecord,
  LibraryMetadataFile,
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
  UpdateCheck,
  UpdateCheckOutcome,
  UpdatePolicy,
} from "./types";

export const desktopApi = {
  applicationUpdatePreferences: () =>
    invoke<ApplicationUpdatePreferences>("get_application_update_preferences"),
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
  artwork: (portId: string, slot: ArtworkSlot, generation: number) =>
    invoke<ArtworkState>("get_artwork", { portId, slot, generation }),
  artworkThumbnail: (
    portId: string,
    slot: ArtworkSlot,
    expectedRevision: number,
    generation: number,
  ) =>
    invoke<ArtworkThumbnail>("get_artwork_thumbnail", {
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
  catalogStatus: () => invoke<CatalogStatus>("get_catalog_status"),
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
  activities: () => invoke<ActivityRecord[]>("get_activities"),
  activityDiagnostic: (activityId: string, generation: number) =>
    invoke<ActivityDiagnostic>("get_activity_diagnostic", {
      activityId,
      generation,
    }),
  cancelOperation: (operationId: string) =>
    invoke<CancellationState>("cancel_operation", { operationId }),
  backups: (portId: string) => invoke<BackupInventory>("get_backups", { portId }),
  backup: (portId: string) => invoke<BackupRecord>("create_backup", { portId }),
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
  doctor: () => invoke<DoctorReport>("get_doctor_report"),
  hostTools: () => invoke<HostToolStatus[]>("get_host_tools"),
  setHostToolPath: (toolId: string, path: string) =>
    invoke<HostToolProbeResult>("set_host_tool_path", { toolId, path }),
  clearHostToolPath: (toolId: string) => invoke<HostToolStatus>("clear_host_tool_path", { toolId }),
  recheckHostTool: (toolId: string) => invoke<HostToolProbeResult>("recheck_host_tool", { toolId }),
  openHostToolOfficialSite: (toolId: string) =>
    invoke<void>("open_host_tool_official_site", { toolId }),
  createSupportBundle: () => invoke<string>("create_support_bundle"),
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
  reportFrontendError: (message: string, componentStack: string) =>
    invoke<void>("report_frontend_error", { message, componentStack }),
  plan: (portId: string, channel: ReleaseChannel) =>
    invoke<InstallPlan>("plan_port", { portId, channel }),
  openUserData: (portId: string) => invoke<string>("open_user_data", { portId }),
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
  ) =>
    invoke<InstallRecord>("install_port", {
      input: {
        portId,
        channel,
        source: source || null,
        bios: bios || null,
        stage,
      } satisfies InstallInput,
    }),
  verify: (portId: string) => invoke("verify_port", { portId }),
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
  rollback: (portId: string) => invoke("rollback_port", { portId }),
  previewRemoval: (portId: string, generation: number) =>
    invoke<PortRemovalPreview>("preview_removal", { portId, generation }),
  remove: (portId: string, expectedPreview: string, generation: number) =>
    invoke<string[] | null>("remove_port", {
      portId,
      expectedPreview,
      generation,
    }),
  launch: (portId: string, source: string) =>
    invoke<LaunchResult>("launch_port", {
      portId,
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
