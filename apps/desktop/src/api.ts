import type { GameComparison, GameComparisonRequest } from "./types";
import type {
  ArtworkSlot,
  ArtworkState,
  DestinationArtworkRole,
  SteamGridDbCandidate,
  SteamGridDbGame,
  SteamGridDbKeyStatus,
  SteamGridDbListingReport,
  ArtworkThumbnail,
  CliCommandContext,
  BackupAction,
  BackupReview,
  PortRemovalPreview,
  ExternalRuntimePreview,
  ExternalRuntimeRemovalPreview,
  ExternalRuntimeRecord,
} from "./types";

import type {
  BugReportDraft,
  BugReportField,
  BugReportLink,
  ReportKind,
  SubmittedReport,
  InstallInput,
  LaunchResult,
  LaunchSessionView,
  RuntimePrerequisiteReport,
} from "./types";
import type {
  GameUpdateAcquisition,
  GameUpdatePlan,
  PreparationCleanupPreview,
  PreparationPlan,
} from "./types";
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
  LibraryRecoveryBundle,
  LibraryRecoveryBundlePlan,
  LibraryRecoveryRestorePlan,
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
  AdoptionBatchItem,
  AdoptionBatchPreview,
  AdoptionBatchResult,
  LauncherKind,
  LauncherLibraryInventory,
  ApplicationUpdatePreferences,
  ApplicationUpdateProgress,
  ApplicationUpdateStatus,
  GhostshipRecoveryPlan,
  GhostshipRecoveryResult,
  BackupInventory,
  BackupRecord,
  BootstrapStatus,
  LibrarySelectionReview,
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
  InstallBatchRecord,
  InstallBatchRequestItem,
  InstallBatchReview,
  PortIntent,
  PortIntentAssessments,
  PortIntentMode,
  PortReadinessAcknowledgement,
  StandingSetupResult,
  RootSetupConsent,
  RootSetupEnrollment,
  LibraryMembership,
  LibraryMembershipOutcome,
  LibraryMembershipRequest,
  GameFileQueryRefreshRequest,
  GameFileQuerySnapshot,
  GameFileScanMatchPage,
  GameFileScanRegisteredMatches,
  StoreGameInstalls,
  GameFileScanMatchQuery,
  GameFileScanSnapshot,
  DatReferenceStatus,
  HostToolProbeResult,
  HostToolStatus,
  InstallPlan,
  InstallRecord,
  LibraryIdentity,
  LibraryOrganization,
  OrganizationChange,
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
  SteamArtworkApplyResult,
  SteamArtworkReview,
  SteamArtworkSelection,
  SteamEntryApplyResult,
  SteamEntryOperation,
  SteamEntryReview,
  SteamEntrySelection,
  SteamBatchReview,
  SteamBatchSelection,
  UpdateCheck,
  UpdateCheckForecast,
  UpdateCheckOutcome,
  UpdatePolicy,
  WorkspaceSnapshotTransport,
} from "./types";

export type DesktopArtworkThumbnail = Pick<ArtworkThumbnail, "asset_sha256" | "choice_revision"> & {
  png_base64: string;
};

/** Explicit player choices bound into a reviewed save import. */
export interface PortableSaveChoices {
  removeLocalOnlySaves: boolean;
  replaceDivergedProgress: boolean;
}

type ModSetupDraftEdits = {
  packages: { native_id: string; enabled: boolean | null }[];
  order: string[] | null;
  local_files: { path: string; expected_plan_sha256: string }[];
};

function recoveryBundleEventChannel(onEvent?: (event: OperationEvent) => void) {
  if (!onEvent) return undefined;
  const channel = new Channel<OperationEvent>();
  channel.onmessage = onEvent;
  return channel;
}

export const desktopApi = {
  gameSettings: (portId: string, generation: number) =>
    invoke<import("./types").GameSettingsView>("get_game_settings", { portId, generation }),
  portCapabilities: (portId: string, generation: number) =>
    invoke<import("./types").PortCapabilityReport>("get_port_capabilities", { portId, generation }),
  reviewGameSetting: (
    portId: string,
    fileId: string,
    settingId: string,
    change: import("./types").GameSettingChange,
    generation: number,
  ) =>
    invoke<import("./types").GameSettingReview>("review_game_setting", {
      portId,
      fileId,
      settingId,
      change,
      generation,
    }),
  applyGameSetting: (review: import("./types").GameSettingReview, generation: number) =>
    invoke<import("./types").GameSettingsView>("apply_game_setting", {
      portId: review.port_id,
      fileId: review.file_id,
      settingId: review.setting_id,
      change: review.change,
      reviewSha256: review.review_sha256,
      generation,
    }),
  gameSettingsChangeSetView: (portId: string, generation: number) =>
    invoke<import("./types").GameSettingsChangeSetView>("get_game_settings_change_set_view", {
      portId,
      generation,
    }),
  reviewGameSettingsChangeSet: (
    portId: string,
    fileId: string,
    edits: import("./types").GameSettingsEdit[],
    generation: number,
  ) =>
    invoke<import("./types").GameSettingsChangeSetReview>("review_game_settings_change_set", {
      portId,
      fileId,
      edits,
      generation,
    }),
  applyGameSettingsChangeSet: (
    review: import("./types").GameSettingsChangeSetReview,
    generation: number,
  ) =>
    invoke<import("./types").GameSettingsView>("apply_game_settings_change_set", {
      portId: review.port_id,
      fileId: review.file_id,
      edits: review.edits.map(({ edit }) => edit),
      reviewSha256: review.review_sha256,
      generation,
    }),
  compareGamePorts: (request: GameComparisonRequest, generation: number) =>
    invoke<GameComparison>("compare_game_ports", { request, generation }),
  organizationPreferences: (generation: number) =>
    invoke<LibraryOrganization>("get_library_organization", { generation }),
  changeOrganization: (expectedRevision: number, change: OrganizationChange, generation: number) =>
    invoke<LibraryOrganization>("change_library_organization", {
      expectedRevision,
      change,
      generation,
    }),
  favoritePorts: (generation: number) => invoke<string[]>("get_favorite_ports", { generation }),
  setPortFavorite: (portId: string, favorite: boolean, generation: number) =>
    invoke<void>("set_port_favorite", { portId, favorite, generation }),
  localePreference: () => invoke<LocalePreferenceSnapshot>("get_locale_preference"),
  setLocalePreference: (locale: string | null) =>
    invoke<LocalePreferenceSnapshot>("set_locale_preference", { locale }),
  applicationUpdateStatus: () => invoke<ApplicationUpdateStatus>("get_application_update_status"),
  checkApplicationUpdate: () => invoke<ApplicationUpdateStatus>("check_application_update"),
  installApplicationUpdate: (
    version: string,
    generation: number,
    onEvent: (event: ApplicationUpdateProgress) => void,
  ) => {
    const channel = new Channel<ApplicationUpdateProgress>();
    channel.onmessage = onEvent;
    return invoke<void>("install_application_update", { generation, version, onEvent: channel });
  },
  applicationUpdatePreferences: () =>
    invoke<ApplicationUpdatePreferences>("get_application_update_preferences"),
  setApplicationUpdatePreferences: (preferences: ApplicationUpdatePreferences) =>
    invoke<ApplicationUpdatePreferences>("set_application_update_preferences", { preferences }),
  artwork: (portId: string, slot: ArtworkSlot, generation: number) =>
    invoke<ArtworkState>("get_artwork", { portId, slot, generation }),
  artworkThumbnail: (
    portId: string,
    slot: ArtworkSlot,
    expectedRevision: number,
    generation: number,
    cacheOnly = false,
    cacheEpoch?: string,
  ) =>
    invoke<DesktopArtworkThumbnail>("get_artwork_thumbnail", {
      portId,
      slot,
      expectedRevision,
      generation,
      ...(cacheOnly ? { cacheOnly } : {}),
      ...(cacheEpoch ? { cacheEpoch } : {}),
    }),
  collectionCoverThumbnail: (
    portId: string,
    expectedSha256: string,
    expectedRevision: number,
    generation: number,
    cacheOnly = false,
    cacheEpoch?: string,
  ) =>
    invoke<DesktopArtworkThumbnail>("get_collection_cover_thumbnail", {
      portId,
      expectedSha256,
      expectedRevision,
      generation,
      ...(cacheOnly ? { cacheOnly } : {}),
      ...(cacheEpoch ? { cacheEpoch } : {}),
    }),
  companionCoverThumbnail: (
    portId: string,
    expectedPrimaryCacheId: string,
    expectedSha256: string,
    expectedRevision: number,
    generation: number,
    cacheOnly = false,
    cacheEpoch?: string,
  ) =>
    invoke<DesktopArtworkThumbnail>("get_companion_cover_thumbnail", {
      portId,
      expectedPrimaryCacheId,
      expectedSha256,
      expectedRevision,
      generation,
      ...(cacheOnly ? { cacheOnly } : {}),
      ...(cacheEpoch ? { cacheEpoch } : {}),
    }),
  catalogMediaThumbnail: (
    portId: string,
    mediaId: string,
    expectedSha256: string,
    generation: number,
    cacheOnly = false,
    cacheEpoch?: string,
  ) =>
    invoke<DesktopArtworkThumbnail>("get_catalog_media_thumbnail", {
      portId,
      mediaId,
      expectedSha256,
      generation,
      ...(cacheOnly ? { cacheOnly } : {}),
      ...(cacheEpoch ? { cacheEpoch } : {}),
    }),
  steamGridDbKeyStatus: () => invoke<SteamGridDbKeyStatus>("get_steamgriddb_key_status"),
  /** Saves the player's own key in the OS secure store; it is never read back. */
  setSteamGridDbKey: (key: string) => invoke<SteamGridDbKeyStatus>("set_steamgriddb_key", { key }),
  clearSteamGridDbKey: () => invoke<SteamGridDbKeyStatus>("clear_steamgriddb_key"),
  searchSteamGridDbGames: (term: string) =>
    invoke<SteamGridDbGame[]>("search_steamgriddb_games", { term }),
  steamGridDbCandidates: (gameId: number, role: DestinationArtworkRole, page = 0) =>
    invoke<SteamGridDbCandidate[]>("get_steamgriddb_candidates", { gameId, role, page }),
  steamGridDbPreview: (url: string) =>
    invoke<{ png_base64: string }>("get_steamgriddb_preview", { url }),
  checkSteamGridDbListings: (generation: number) =>
    invoke<SteamGridDbListingReport>("check_steamgriddb_listings", { generation }),
  chooseSteamGridDbArtwork: (
    portId: string,
    slot: ArtworkSlot,
    gameId: number,
    candidateId: number,
    expectedRevision: number,
    generation: number,
  ) =>
    invoke<ArtworkState>("choose_steamgriddb_artwork", {
      portId,
      slot,
      gameId,
      candidateId,
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
  modSetups: (portId: string, generation: number, browseOnly?: true) =>
    invoke<import("./types").ModSetupsView>("get_mod_setups", {
      portId,
      generation,
      ...(browseOnly ? { browseOnly } : {}),
    }),
  reviewModSetupOriginal: (target: import("./types").ModSetupOriginalTarget) =>
    invoke<import("./types").ModSetupOriginalReview>("review_mod_setup_original", target),
  selectModSetupOriginal: (target: import("./types").ModSetupOriginalTarget, instanceId: string) =>
    invoke<void>("select_mod_setup_original", { ...target, instanceId }),
  relinkModSetupOriginal: (target: import("./types").ModSetupOriginalTarget, path: string) =>
    invoke<void>("relink_mod_setup_original", { ...target, path }),
  inspectModFile: (portId: string, fileName: string, generation: number) =>
    invoke<import("./types").ModFilePreservationPlan>("inspect_mod_file", {
      portId,
      fileName,
      generation,
    }),
  preserveModFile: (portId: string, fileName: string, expectedPlan: string, generation: number) =>
    invoke<import("./types").ModFilePreservationResult>("preserve_mod_file", {
      portId,
      fileName,
      expectedPlan,
      generation,
    }),
  createDefaultModSetup: (portId: string, generation: number) =>
    invoke<import("./types").ModSetup>("create_default_mod_setup", { portId, generation }),
  copyModSetup: (
    portId: string,
    profileId: string,
    displayName: string,
    generation: number,
    currentBuild = false,
    progress?: {
      source_revision_sha256: string;
      target_install_id: string;
      target_revision_sha256: string;
    },
  ) =>
    invoke<import("./types").ModSetup>("copy_mod_setup", {
      portId,
      profileId,
      displayName,
      generation,
      currentBuild,
      ...(progress && { progress }),
    }),
  createCleanModSetup: (
    portId: string,
    profileId: string,
    displayName: string,
    expectedRevision: number,
    generation: number,
  ) =>
    invoke<import("./types").ModSetup>("create_clean_mod_setup", {
      portId,
      profileId,
      displayName,
      expectedRevision,
      generation,
    }),
  modSetupRevisions: (portId: string, profileId: string, generation: number) =>
    invoke<import("./types").ModSetupRevision[]>("list_mod_setup_revisions", {
      portId,
      profileId,
      generation,
    }),
  planProfileRecovery: (portId: string, profileId: string, revision: number, generation: number) =>
    invoke<import("./types").ModSetupRecoveryPlan>("plan_profile_recovery", {
      portId,
      profileId,
      revision,
      generation,
    }),
  applyProfileRecovery: (
    portId: string,
    profileId: string,
    revision: number,
    expectedPlanSha256: string,
    generation: number,
  ) =>
    invoke<import("./types").ModSetupRevision>("apply_profile_recovery", {
      portId,
      profileId,
      revision,
      expectedPlanSha256,
      generation,
    }),
  modSetupRecoveryBuilds: (portId: string, profileId: string, generation: number) =>
    invoke<import("./types").ModSetupRecoveryBuild[]>("list_mod_setup_recovery_builds", {
      portId,
      profileId,
      generation,
    }),
  previewModSetupRetirement: (
    portId: string,
    profileId: string,
    revision: number,
    generation: number,
  ) =>
    invoke<import("./types").ModSetupRetirementPreview>("preview_mod_setup_retirement", {
      portId,
      profileId,
      revision,
      generation,
    }),
  retireModSetupRecoveryBuild: (
    portId: string,
    profileId: string,
    revision: number,
    expectedPreviewSha256: string,
    generation: number,
  ) =>
    invoke<import("./types").ModSetupRetirementPreview["revision"]>(
      "retire_mod_setup_recovery_build",
      { portId, profileId, revision, expectedPreviewSha256, generation },
    ),
  useModSetup: (portId: string, profileId: string, generation: number) =>
    invoke<import("./types").ModSetupRevision>("use_mod_setup", {
      portId,
      profileId,
      generation,
    }),
  exportModRecipe: (portId: string, profileId: string, path: string, generation: number) =>
    invoke<void>("export_mod_recipe", { portId, profileId, path, generation }),
  inspectModRecipe: (portId: string, path: string, generation: number) =>
    invoke<import("./transport-types.generated").OutputDesktopRecipeImportReview>(
      "inspect_mod_recipe",
      {
        portId,
        path,
        generation,
      },
    ),
  acquireModRecipePackage: (
    portId: string,
    profileId: string,
    nativeId: string,
    review: import("./transport-types.generated").OutputDesktopRecipeImportReview,
    generation: number,
  ) =>
    invoke<import("./transport-types.generated").OutputDesktopRecipeImportReview>(
      "acquire_mod_recipe_package",
      { portId, profileId, nativeId, serializedPlan: review.serialized_plan, generation },
    ),
  discardModRecipeReview: (
    portId: string,
    review: import("./transport-types.generated").OutputDesktopRecipeImportReview,
    generation: number,
  ) =>
    invoke<void>("discard_mod_recipe_review", {
      portId,
      serializedPlan: review.serialized_plan,
      generation,
    }),
  applyModRecipe: (
    portId: string,
    displayName: string,
    review: import("./transport-types.generated").OutputDesktopRecipeImportReview,
    generation: number,
    allowCode: boolean,
  ) =>
    invoke<import("./types").ModSetup>("apply_mod_recipe", {
      portId,
      allowCode,
      displayName,
      serializedPlan: review.serialized_plan,
      generation,
    }),
  setModPackageEnabled: (
    portId: string,
    profileId: string,
    nativeId: string,
    enabled: boolean,
    expectedRevision: number,
    generation: number,
  ) =>
    invoke<import("./types").ModSetupRevision>("set_mod_package_enabled", {
      portId,
      profileId,
      nativeId,
      enabled,
      expectedRevision,
      generation,
    }),
  removeModPackage: (
    portId: string,
    profileId: string,
    nativeId: string,
    expectedRevision: number,
    generation: number,
  ) =>
    invoke<import("./types").ModSetupRevision>("remove_mod_package", {
      portId,
      profileId,
      nativeId,
      expectedRevision,
      generation,
    }),
  setModUpdatePolicy: (
    portId: string,
    profileId: string,
    policy: import("./types").ModUpdatePolicy,
    generation: number,
  ) =>
    invoke<import("./types").ModSetup>("set_mod_update_policy", {
      portId,
      profileId,
      policy,
      generation,
    }),
  checkProviderModUpdates: (portId: string, profileId: string, generation: number) =>
    invoke<import("./types").ProviderUpdateObservation[]>("check_provider_mod_updates", {
      portId,
      profileId,
      generation,
    }),
  openProviderModProject: (
    portId: string,
    projectId: string,
    generation: number,
    provider?: string,
  ) => invoke<void>("open_provider_mod_project", { portId, projectId, generation, provider }),
  jakModsSetupUrl: (portId: string, generation: number) =>
    invoke<string | null>("jakmods_setup_url", { portId, generation }),
  jakModsCatalog: (portId: string, generation: number) =>
    invoke<import("./types").JakModsCatalog>("get_jakmods_catalog", { portId, generation }),
  openJakModsResource: (
    portId: string,
    generation: number,
    expectedUrl: string,
    projectId?: string,
  ) => invoke<void>("open_jakmods_resource", { portId, generation, projectId, expectedUrl }),
  quaddictedCatalog: (portId: string, generation: number, page: number, filenameSearch?: string) =>
    invoke<import("./types").QuaddictedCatalog>("get_quaddicted_catalog", {
      portId,
      generation,
      page,
      filenameSearch,
    }),
  modDbFileNotices: (portId: string, generation: number) =>
    invoke<import("./types").ModDbFileNotices>("get_moddb_file_notices", { portId, generation }),
  openUpstreamModNotice: (
    portId: string,
    generation: number,
    source: NonNullable<import("./types").ModSetupsView["external_mod_portals"]>[number]["source"],
    pageUrl: string,
  ) => invoke<void>("open_upstream_mod_notice", { portId, generation, source, pageUrl }),
  modProviderCatalog: (portId: string, source: string, generation: number, startPage = 1) =>
    invoke<import("./types").ProviderCatalog>("get_mod_provider_catalog", {
      portId,
      source,
      generation,
      startPage,
    }),
  providerProject: (portId: string, projectId: string, generation: number, provider?: string) =>
    invoke<import("./types").ProviderProjectView>("get_provider_project", {
      portId,
      projectId,
      generation,
      provider,
    }),
  planProviderInstall: (
    portId: string,
    profileId: string,
    projectId: string,
    fileId: string,
    generation: number,
    provider?: string,
    expectedGameId?: string,
  ) =>
    invoke<import("./types").ProviderInstallPlan>("plan_provider_install", {
      portId,
      profileId,
      projectId,
      fileId,
      generation,
      provider,
      expectedGameId,
    }),
  previewModSetupDraft: (
    portId: string,
    profileId: string,
    expectedRevision: number,
    plans: readonly import("./types").ProviderInstallPlan[],
    edits: ModSetupDraftEdits,
    generation: number,
  ) =>
    invoke<import("./types").ModSetupDraftPreview>("preview_mod_setup_draft", {
      portId,
      profileId,
      expectedRevision,
      plans,
      edits,
      generation,
    }),
  applyModSetupDraft: (
    portId: string,
    profileId: string,
    expectedRevision: number,
    plans: readonly import("./types").ProviderInstallPlan[],
    edits: ModSetupDraftEdits,
    generation: number,
    allowCode: boolean,
  ) =>
    invoke<import("./types").ModSetupRevision>("apply_mod_setup_draft", {
      portId,
      profileId,
      expectedRevision,
      plans,
      edits,
      generation,
      allowCode,
    }),
  applyProviderInstall: (
    portId: string,
    profileId: string,
    expectedPlanSha256: string,
    plan: import("./types").ProviderInstallPlan,
    generation: number,
    allowCode = false,
  ) =>
    invoke<import("./types").ModSetupRevision>("apply_provider_install", {
      portId,
      profileId,
      expectedPlanSha256,
      plan,
      generation,
      allowCode,
    }),
  discardProviderInstall: (
    portId: string,
    plan: import("./types").ProviderInstallPlan,
    generation: number,
  ) => invoke<void>("discard_provider_install", { portId, plan, generation }),
  addModPackage: (
    portId: string,
    profileId: string,
    path: string,
    expectedRevision: number,
    generation: number,
    allowCodeSha256: string | null = null,
  ) =>
    invoke<import("./types").ModSetupRevision>("add_mod_package", {
      portId,
      profileId,
      path,
      expectedRevision,
      generation,
      allowCodeSha256,
    }),
  planLocalModPackage: (
    portId: string,
    profileId: string,
    path: string,
    expectedRevision: number,
    generation: number,
    workspace = false,
  ) =>
    invoke<import("./transport-types.generated").OutputLocalModPackagePlan>(
      "plan_local_mod_package",
      { portId, profileId, path, expectedRevision, generation, workspace },
    ),
  applyLocalModPackage: (
    portId: string,
    profileId: string,
    path: string,
    expectedPlanSha256: string,
    generation: number,
    allowCode: boolean,
  ) =>
    invoke<import("./types").ModSetupRevision>("apply_local_mod_package", {
      portId,
      profileId,
      path,
      expectedPlanSha256,
      generation,
      allowCode,
    }),
  reviewModPackageCode: (portId: string, path: string, generation: number) =>
    invoke<import("./types").ModCodeReview | null>("review_mod_package_code", {
      portId,
      path,
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
  discoverSteamClientRoots: (generation: number) =>
    invoke<string[]>("discover_steam_client_roots", { generation }),
  listSteamProfiles: (steamRoot: string, generation: number) =>
    invoke<string[]>("list_steam_profiles", { steamRoot, generation }),
  previewSteamEntry: (
    portId: string,
    steamRoot: string,
    steamUserId: string,
    operation: SteamEntryOperation,
    includeArtwork: boolean,
    generation: number,
  ) =>
    invoke<SteamEntryReview>("preview_steam_entry", {
      request: {
        portId,
        steamRoot,
        steamUserId,
        operation,
        includeArtwork,
      } satisfies SteamEntrySelection,
      generation,
    }),
  applySteamEntry: (
    portId: string,
    steamRoot: string,
    steamUserId: string,
    operation: SteamEntryOperation,
    includeArtwork: boolean,
    expectedPlanSha256: string,
    expectedArtworkReviewSha256: string | null,
    generation: number,
  ) =>
    invoke<SteamEntryApplyResult | null>("apply_steam_entry", {
      request: {
        portId,
        steamRoot,
        steamUserId,
        operation,
        includeArtwork,
      } satisfies SteamEntrySelection,
      expectedPlanSha256,
      expectedArtworkReviewSha256,
      generation,
    }),
  previewSteamBatchAdd: (request: SteamBatchSelection, generation: number) =>
    invoke<SteamBatchReview>("preview_steam_batch_add", { request, generation }),
  applySteamBatchAdd: (
    request: SteamBatchSelection,
    expectedReviewSha256: string,
    expectedArtworkReviewSha256: string | null,
    generation: number,
  ) =>
    invoke<SteamEntryApplyResult | null>("apply_steam_batch_add", {
      request,
      expectedReviewSha256,
      expectedArtworkReviewSha256,
      generation,
    }),
  previewSteamArtwork: (request: SteamArtworkSelection, generation: number) =>
    invoke<SteamArtworkReview>("preview_steam_artwork", { request, generation }),
  applySteamArtwork: (
    request: SteamArtworkSelection,
    expectedPlanSha256: string,
    generation: number,
  ) =>
    invoke<SteamArtworkApplyResult | null>("apply_steam_artwork", {
      request,
      expectedPlanSha256,
      generation,
    }),
  listingDeliveryStatus: () => invoke<ListingDeliveryStatus>("get_listing_delivery_status"),
  officialCatalogReview: (generation: number) =>
    invoke<import("./types").OfficialCatalogReview>("get_official_catalog_review", { generation }),
  officialCatalogAutomaticUpdates: () => invoke<boolean>("get_official_catalog_automatic_updates"),
  setOfficialCatalogAutomaticUpdates: (enabled: boolean) =>
    invoke<boolean>("set_official_catalog_automatic_updates", { enabled }),
  refreshOfficialCatalogAutomatically: (
    generation: number,
    onEvent: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<import("./types").OfficialCatalogAutomaticRefresh>(
      "refresh_official_catalog_automatically",
      { generation, onEvent: channel },
    );
  },
  refreshOfficialCatalog: (generation: number, onEvent: (event: OperationEvent) => void) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<ListingDeliveryStatus>("refresh_official_catalog", {
      generation,
      onEvent: channel,
    });
  },
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
  refreshOfficialDefinition: (
    portId: string,
    generation: number,
    onEvent: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<import("./types").DefinitionRefresh>("refresh_official_definition", {
      portId,
      generation,
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
  reviewLibrarySelection: (path: string | null, generation: number) =>
    invoke<LibrarySelectionReview>("review_library_selection", { path, generation }),
  setDefaultLibrary: (path: string, expectedReview?: string) =>
    invoke<BootstrapStatus>("set_default_library", {
      path,
      ...(expectedReview && { expectedReview }),
    }),
  resetDefaultLibrary: (expectedReview?: string) =>
    invoke<BootstrapStatus>(
      "reset_default_library",
      expectedReview ? { expectedReview } : undefined,
    ),
  githubAuthStatus: () => invoke<GithubAuthStatus>("get_github_auth_status"),
  setGithubToken: (token: string) => invoke<GithubAuthStatus>("set_github_token", { token }),
  logoutGithub: () => invoke<GithubAuthStatus>("logout_github"),
  beginGithubDeviceLogin: () => invoke<GithubDeviceLogin>("begin_github_device_login"),
  pollGithubDeviceLogin: (sessionId: string) =>
    invoke<GithubDeviceLoginResult>("poll_github_device_login", { sessionId }),
  catalog: () => invoke<CatalogDocument>("get_catalog"),
  statuses: () => invoke<PortStatus[]>("get_statuses"),
  workspaceSnapshot: (generation: number, knownCatalogDigest?: string | null) =>
    invoke<WorkspaceSnapshotTransport>("get_workspace_snapshot", {
      generation,
      knownCatalogDigest: knownCatalogDigest ?? null,
    }),
  workspaceChanged: (generation: number) =>
    invoke<boolean>("get_workspace_changed", { generation }),
  catalogDownloadCandidates: (
    portId: string,
    generation: number,
    selectedReleaseId?: NonNullable<CatalogDownloadCandidates["selected_release_id"]>,
    channel = "stable",
    releaseWindow?: number,
  ) =>
    invoke<CatalogDownloadCandidates>("catalog_download_candidates", {
      portId,
      generation,
      selectedReleaseId,
      channel,
      ...(releaseWindow === undefined ? {} : { releaseWindow }),
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
  openPendingSetupResource: (portId: string, pendingId: string, url: string, generation: number) =>
    invoke<void>("open_pending_setup_resource", { portId, pendingId, url, generation }),
  openCatalogDownloadReleaseNotes: (
    portId: string,
    releaseId: CatalogDownloadRequest["release_id"],
    assetId: CatalogDownloadRequest["asset_id"],
    url: string,
    generation: number,
  ) =>
    invoke<void>("open_catalog_download_release_notes", {
      portId,
      releaseId,
      assetId,
      url,
      generation,
    }),
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
  planGameUpdateAcquisition: (portId: string, generation: number) =>
    invoke<GameUpdatePlan>("plan_game_update_acquisition", { portId, generation }),
  acquireGameUpdate: (
    portId: string,
    expectedPlan: string,
    generation: number,
    onEvent: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<GameUpdateAcquisition>("acquire_game_update", {
      portId,
      expectedPlan,
      generation,
      onEvent: channel,
    });
  },
  discardGameUpdateAcquisition: (portId: string, acquisitionId: string, generation: number) =>
    invoke<void>("discard_game_update_acquisition", { portId, acquisitionId, generation }),
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
  previewPortableSaveExport: (portId: string, generation: number) =>
    invoke<import("./types").PortableSaveExportPreview>("preview_portable_save_export", {
      portId,
      generation,
    }),
  exportPortableSaves: (
    portId: string,
    path: string,
    expectedContent: string,
    generation: number,
  ) =>
    invoke<import("./types").PortableSaveExportResult>("export_portable_saves", {
      portId,
      path,
      expectedContent,
      generation,
    }),
  previewPortableSaveImport: (
    portId: string,
    path: string,
    choices: PortableSaveChoices,
    generation: number,
  ) =>
    invoke<import("./types").PortableSaveImportPreview>("preview_portable_save_import", {
      portId,
      path,
      ...choices,
      generation,
    }),
  importPortableSaves: (
    portId: string,
    path: string,
    choices: PortableSaveChoices,
    expectedPreview: string,
    generation: number,
  ) =>
    invoke<import("./types").PortableSaveImportResult | null>("import_portable_saves", {
      portId,
      path,
      ...choices,
      expectedPreview,
      generation,
    }),
  planGhostshipLegacyRecovery: (backupId: string, generation: number) =>
    invoke<GhostshipRecoveryPlan>("plan_ghostship_legacy_recovery", { backupId, generation }),
  recoverGhostshipLegacyData: (backupId: string, expectedPlan: string, generation: number) =>
    invoke<GhostshipRecoveryResult | null>("recover_ghostship_legacy_data", {
      backupId,
      expectedPlan,
      generation,
    }),
  deleteBackup: (portId: string, backupId: string, expectedPreview: string, generation: number) =>
    invoke<BackupRecord | null>("delete_backup", {
      portId,
      backupId,
      expectedPreview,
      generation,
    }),
  addSource: (profileId: string, path: string, generation: number, expectedSha256?: string) =>
    invoke<SourceRecord>("add_source", { profileId, path, generation, expectedSha256 }),
  reviewSourceReuse: (profileId: string, generation: number) =>
    invoke<import("./types").SourceReuseReview>("review_source_reuse", { profileId, generation }),
  gameFileRoots: (generation: number) =>
    invoke<GameFileRoot[]>("get_game_file_roots", { generation }),
  libraryMemberships: (generation: number) =>
    invoke<LibraryMembership[]>("get_library_memberships", { generation }),
  addGamesToLibrary: (requests: LibraryMembershipRequest[], generation: number) =>
    invoke<LibraryMembershipOutcome[]>("add_games_to_library", { requests, generation }),
  removeLibraryMembership: (portId: string, generation: number) =>
    invoke<boolean>("remove_library_membership", { portId, generation }),
  planInstallBatch: (portIds: string[], generation: number) =>
    invoke<InstallBatchReview>("plan_install_batch", { portIds, generation }),
  /** Saves the reviewed games to the Library and records them as one batch. Runs nothing. */
  startInstallBatch: (items: InstallBatchRequestItem[], generation: number) =>
    invoke<InstallBatchRecord>("start_install_batch", { items, generation }),
  /** Runs unstarted games once each; finished games are never repeated. Never launches a game. */
  runInstallBatch: (
    batchId: string,
    generation: number,
    onEvent: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<InstallBatchRecord>("run_install_batch", {
      batchId,
      generation,
      onEvent: channel,
    });
  },
  unfinishedInstallBatches: (generation: number) =>
    invoke<InstallBatchRecord[]>("get_unfinished_install_batches", { generation }),
  setPortIntent: (portId: string, mode: PortIntentMode, generation: number) =>
    invoke<PortIntent>("set_port_intent", { portId, mode, generation }),
  portIntents: (generation: number) => invoke<PortIntent[]>("get_port_intents", { generation }),
  assessPortIntents: (generation: number) =>
    invoke<PortIntentAssessments>("assess_port_intents", { generation }),
  acknowledgePortReadiness: (
    acknowledgements: PortReadinessAcknowledgement[],
    generation: number,
  ) => invoke<null>("acknowledge_port_readiness", { acknowledgements, generation }),
  /** Installs ready set-up-when-ready games under the player's standing choice. Never launches. */
  runStandingSetup: (generation: number, onEvent: (event: OperationEvent) => void) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<StandingSetupResult>("run_standing_setup", { generation, onEvent: channel });
  },
  /** Turns automatic setup for one saved folder on, or off with `null`. Installed games are kept. */
  setRootSetupConsent: (
    rootId: string,
    enrollment: RootSetupEnrollment | null,
    generation: number,
  ) =>
    invoke<RootSetupConsent | null>("set_root_setup_consent", { rootId, enrollment, generation }),
  setRootSetupImplementation: (
    rootId: string,
    profileId: string,
    portId: string,
    generation: number,
  ) =>
    invoke<RootSetupConsent>("set_root_setup_implementation", {
      rootId,
      profileId,
      portId,
      generation,
    }),
  setRootSetupLocalCopy: (rootId: string, keepLocalCopy: boolean, generation: number) =>
    invoke<RootSetupConsent>("set_root_setup_local_copy", {
      rootId,
      keepLocalCopy,
      generation,
    }),
  rootSetupConsents: (generation: number) =>
    invoke<RootSetupConsent[]>("get_root_setup_consents", { generation }),
  cancelInstallBatch: (batchId: string, generation: number) =>
    invoke<InstallBatchRecord>("cancel_install_batch", { batchId, generation }),
  installBatch: (batchId: string, generation: number) =>
    invoke<InstallBatchRecord | null>("get_install_batch", { batchId, generation }),
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
    finishScanId?: string,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = (event) => onEvent?.(event);
    return invoke<GameFileScanSnapshot>("scan_game_file_roots", {
      limits,
      generation,
      onEvent: channel,
      ...(finishScanId === undefined ? {} : { finishScanId }),
    });
  },
  gameFileScanSnapshot: (generation: number) =>
    invoke<GameFileScanSnapshot | null>("get_game_file_scan_snapshot", { generation }),
  gameFileScanMatches: (query: GameFileScanMatchQuery, generation: number) =>
    invoke<GameFileScanMatchPage>("get_game_file_scan_matches", { query, generation }),
  gameFileScanRegisteredMatches: (
    expected: NonNullable<GameFileScanSnapshot["matches"]>,
    generation: number,
  ) =>
    invoke<GameFileScanRegisteredMatches>("get_game_file_scan_registered_matches", {
      expected,
      generation,
    }),
  gameFileRootMatchProfiles: (rootId: string, generation: number) =>
    invoke<string[]>("get_game_file_root_match_profiles", { rootId, generation }),
  storeGameInstalls: (generation: number, profileId?: string) =>
    invoke<StoreGameInstalls>("get_store_game_installs", {
      generation,
      ...(profileId !== undefined ? { profileId } : {}),
    }),
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
    generation: number,
    onEvent?: (event: OperationEvent) => void,
  ) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = (event) => onEvent?.(event);
    return invoke<SourceImportResult | null>("import_source", {
      profileId,
      path,
      mode,
      expectedPlan,
      generation,
      onEvent: channel,
    });
  },
  planSourceRelink: (profileId: string, path: string, generation?: number) =>
    invoke<SourceRelinkPlan>("plan_source_relink", {
      profileId,
      path,
      ...(generation === undefined ? {} : { generation }),
    }),
  relinkSource: (profileId: string, path: string, previewSha256: string, generation?: number) =>
    invoke<SourceRecord>("relink_source", {
      profileId,
      path,
      previewSha256,
      ...(generation === undefined ? {} : { generation }),
    }),
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
  inspectSource: (profileId: string, artworkGeneration?: number) =>
    invoke<SourceInspectionReport>("inspect_source", {
      profileId,
      ...(artworkGeneration === undefined ? {} : { artworkGeneration }),
    }),
  inspectSourceIntake: (profileId: string, paths: string[]) =>
    invoke<SourceIntakeInspection>("inspect_source_intake", {
      profileId,
      paths,
    }),
  openSourceEvidence: (evidenceId: string) => invoke<void>("open_source_evidence", { evidenceId }),
  check: (portId: string, generation: number) =>
    invoke<UpdateCheck>("check_port", { portId, generation }),
  checkInstalled: () => invoke<UpdateCheckOutcome[]>("check_installed"),
  forecastInstalledUpdateChecks: () =>
    invoke<UpdateCheckForecast>("forecast_installed_update_checks"),
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
  datReferences: () => invoke<DatReferenceStatus[]>("get_dat_references"),
  addDatReference: (path: string) => invoke<DatReferenceStatus>("add_dat_reference", { path }),
  removeDatReference: (datId: string) => invoke<void>("remove_dat_reference", { datId }),
  setHostToolPath: (toolId: string, path: string) =>
    invoke<HostToolProbeResult>("set_host_tool_path", { toolId, path }),
  clearHostToolPath: (toolId: string) => invoke<HostToolStatus>("clear_host_tool_path", { toolId }),
  recheckHostTool: (toolId: string) => invoke<HostToolProbeResult>("recheck_host_tool", { toolId }),
  openHostToolOfficialSite: (toolId: string) =>
    invoke<void>("open_host_tool_official_site", { toolId }),
  createSupportBundle: (generation?: number) =>
    invoke<DesktopSupportBundleExport>(
      "create_support_bundle",
      generation === undefined ? undefined : { generation },
    ),
  openSupportReportFolder: () => invoke<void>("open_support_report_folder"),
  runtimeDiagnosticHealth: () => invoke<string>("get_runtime_diagnostic_health"),
  exportLibraryMetadata: (path: string, generation: number) =>
    invoke<LibraryMetadataFile>("export_library_metadata", { path, generation }),
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
  planLibraryRecoveryBundle: (destination: string, generation: number) =>
    invoke<LibraryRecoveryBundlePlan>("plan_library_recovery_bundle", { destination, generation }),
  createLibraryRecoveryBundle: (
    destination: string,
    expectedPlan: string,
    generation: number,
    onProgress?: (event: OperationEvent) => void,
  ) =>
    invoke<LibraryRecoveryBundle>("create_library_recovery_bundle", {
      destination,
      expectedPlan,
      generation,
      onEvent: recoveryBundleEventChannel(onProgress),
    }),
  inspectLibraryRecoveryBundle: (path: string, expectedPlan?: string) =>
    invoke<LibraryRecoveryBundle>("inspect_library_recovery_bundle", { path, expectedPlan }),
  planLibraryRecoveryRestore: (path: string, destination: string, generation: number) =>
    invoke<LibraryRecoveryRestorePlan>("plan_library_recovery_restore", {
      path,
      destination,
      generation,
    }),
  restoreLibraryRecoveryBundle: (
    path: string,
    destination: string,
    expectedPlan: string,
    generation: number,
    onProgress?: (event: OperationEvent) => void,
  ) =>
    invoke<LibraryImportResult>("restore_library_recovery_bundle", {
      path,
      destination,
      expectedPlan,
      generation,
      onEvent: recoveryBundleEventChannel(onProgress),
    }),
  readLibraryRecoveryRestore: (destination: string, expectedPlan: string) =>
    invoke<LibraryImportResult>("read_library_recovery_restore", { destination, expectedPlan }),
  resumeLibraryRecoveryBundle: (
    staging: string,
    generation: number,
    onProgress?: (event: OperationEvent) => void,
  ) =>
    invoke<LibraryRecoveryBundle>("resume_library_recovery_bundle", {
      staging,
      generation,
      onEvent: recoveryBundleEventChannel(onProgress),
    }),
  resumeLibraryRecoveryRestore: (
    destination: string,
    generation: number,
    onProgress?: (event: OperationEvent) => void,
    expectedTransferId?: string,
  ) =>
    invoke<LibraryImportResult>("resume_library_recovery_restore", {
      destination,
      generation,
      expectedTransferId,
      onEvent: recoveryBundleEventChannel(onProgress),
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
  canReviewExactRelease: (portId: string, generation: number) =>
    invoke<boolean>("can_review_exact_release", { portId, generation }),
  reviewExactRelease: (portId: string, version: string, generation: number) =>
    invoke<import("./types").ExactReleaseReview>("review_exact_release", {
      portId,
      version,
      generation,
    }),
  pinExactRelease: (portId: string, version: string, reviewSha256: string, generation: number) =>
    invoke<PortStatus>("pin_exact_release", { portId, version, reviewSha256, generation }),
  clearExactRelease: (portId: string, generation: number) =>
    invoke<PortStatus>("clear_exact_release", { portId, generation }),
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
    onEvent?: (event: OperationEvent) => void,
    sourceReference?: import("./types").SourceRegistrationReference,
  ) => {
    const eventChannel = new Channel<OperationEvent>();
    eventChannel.onmessage = (event) => onEvent?.(event);
    return invoke<InstallRecord>("install_port", {
      onEvent: eventChannel,
      generation,
      input: {
        portId,
        channel,
        source: source || null,
        bios: bios || null,
        stage,
        ...(sourceReference ? { sourceReference } : {}),
      } satisfies InstallInput,
    });
  },
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
  launch: (portId: string, source: string, generation: number, disc?: number) =>
    invoke<LaunchResult>("launch_port", {
      portId,
      generation,
      source: source || null,
      arguments: [],
      disc: disc ?? null,
    }),
  /** The jump-list play request this process started with, returned only once. */
  takeStartupPlayRequest: () => invoke<string | null>("take_startup_play_request"),
  automaticSnapshots: (generation: number) =>
    invoke<boolean>("get_automatic_snapshots", { generation }),
  setAutomaticSnapshots: (enabled: boolean, generation: number) =>
    invoke<boolean>("set_automatic_snapshots", { enabled, generation }),
  readyNoticesEnabled: (generation: number) =>
    invoke<boolean>("get_ready_notices_enabled", { generation }),
  setReadyNoticesEnabled: (enabled: boolean, generation: number) =>
    invoke<boolean>("set_ready_notices_enabled", { enabled, generation }),
  previewBugReport: (portId: string | undefined, generation: number, kind: ReportKind) =>
    invoke<BugReportDraft>("preview_bug_report", { portId: portId ?? null, generation, kind }),
  /** Opens the reviewed form, or only returns its text when `copyOnly` is set. */
  openBugReport: (fields: BugReportField[], kind: ReportKind, copyOnly: boolean) =>
    invoke<BugReportLink>("open_bug_report", { fields, kind, copyOnly }),
  /** Files the reviewed text as an issue under the player's GitHub sign-in. */
  submitReport: (fields: BugReportField[], kind: ReportKind) =>
    invoke<SubmittedReport>("submit_report", { fields, kind }),
  launchFailure: (portId: string, generation: number) =>
    invoke<LaunchSessionView | null>("get_launch_failure", { portId, generation }),
  /** Microsoft runtimes one current installation most likely needs; read on request. */
  runtimePrerequisites: (portId: string, installId: string, generation: number) =>
    invoke<RuntimePrerequisiteReport | null>("get_runtime_prerequisites", {
      portId,
      installId,
      generation,
    }),
  previewAdoption: (path: string, generation: number, portId?: string) =>
    invoke<AdoptionPreview>("preview_adoption", {
      path,
      generation,
      portId: portId ?? null,
    }),
  inspectLauncherLibrary: (
    launcher: LauncherKind,
    dataRoot: string,
    generation: number,
    appsRoot?: string,
  ) =>
    invoke<LauncherLibraryInventory>("inspect_launcher_library", {
      launcher,
      dataRoot,
      appsRoot: appsRoot ?? null,
      generation,
    }),
  /** Read-only review of several existing installations as one batch. */
  previewAdoptionBatch: (items: AdoptionBatchItem[], generation: number) =>
    invoke<AdoptionBatchPreview>("preview_adoption_batch", { items, generation }),
  /** Re-reviews, asks once natively, then copies each unchanged item; null when declined. */
  adoptBatch: (items: AdoptionBatchItem[], batchSha256: string, generation: number) =>
    invoke<AdoptionBatchResult | null>("adopt_batch", { items, generation, batchSha256 }),
  adopt: (path: string, planSha256: string, generation: number, portId?: string) =>
    invoke<InstallRecord | null>("adopt_port", {
      path,
      generation,
      portId: portId ?? null,
      planSha256,
    }),
};
