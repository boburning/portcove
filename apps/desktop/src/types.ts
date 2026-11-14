import type * as Requests from "./transport-input-types.generated";
import type * as Events from "./transport-event-types.generated";
import type { PortStatus } from "./transport-types.generated";
import type * as Generated from "./transport-types.generated";
export type PortCapabilityReport = Generated.TransportOutputs["port_capability_report"];

export type SourceReuseReview = Generated.TransportOutputs["source_reuse_review"];
export type SourceRegistrationReference = SourceReuseReview["reference"];
export type OfficialCatalogReview = Generated.TransportOutputs["official_catalog_review"];
export type OfficialCatalogSetup = Generated.TransportOutputs["official_catalog_setup"];
export type DefinitionRefresh = Generated.TransportOutputs["definition_refresh"];

export type { ReleaseChannel } from "./transport-types.generated";
export type { OriginalGameIdentity } from "./transport-types.generated";
export type { CatalogMediaAsset } from "./transport-types.generated";

export type { UpdatePolicy } from "./transport-types.generated";

export type { SourceProfile } from "./transport-types.generated";

export type { DigestIdentity } from "./transport-types.generated";

export type { SourceRepresentation } from "./transport-types.generated";

export type { PortDefinition } from "./transport-types.generated";

export type CatalogDocument = Generated.TransportOutputs["catalog"];
export type {
  CatalogListingDocument,
  PortListing,
  PortListingStatus,
  PendingSetupRecord,
  CatalogDownloadRequest,
  CatalogDownloadCandidate,
} from "./transport-types.generated";
export type CatalogDownloadCandidates =
  Generated.TransportOutputs["desktop_catalog_download_candidates"];
export type SetupLaunchTargets = Generated.TransportOutputs["desktop_setup_launch_targets"];
export type ManagedRouteChangePreview =
  Generated.TransportOutputs["desktop_managed_route_change_preview"];
export type ManagedRouteChangeResult =
  Generated.TransportOutputs["desktop_managed_route_change_result"];
export type CatalogDownloadPreview = Generated.TransportOutputs["desktop_catalog_download_preview"];
export type CapabilityDocument = Generated.TransportOutputs["capabilities"];
export type DefinitionCapabilityReport = Generated.TransportOutputs["definition_capability_report"];
export type DefinitionCapabilityRequest = Requests.TransportInputs["definition_capability_request"];
export type LibraryIdentity = Generated.TransportOutputs["library_identity"];
export type LibraryOrganization = Generated.TransportOutputs["desktop_library_organization"];
export type OrganizationChange = Requests.TransportInputs["desktop_organization_change"];
export type ArtworkState = Generated.TransportOutputs["artwork_state"];
export type ArtworkThumbnail = Generated.TransportOutputs["artwork_thumbnail"];
export type ArtworkSlot = ArtworkState["choice"]["slot"];
export type ArtworkAttribution = ArtworkState["attribution"][number];
export type SteamGridDbKeyStatus = Generated.TransportOutputs["steamgriddb_key_status"];
export type SteamGridDbGame = Generated.TransportOutputs["steamgriddb_games"][number];
export type SteamGridDbCandidate = Generated.TransportOutputs["steamgriddb_candidates"][number];
export type DestinationArtworkRole = SteamGridDbCandidate["role"];

export type { InstallRecord } from "./transport-types.generated";

export type PreparationPlan = Generated.TransportOutputs["preparation_plan"];
export type PreparationCleanupPreview = Generated.TransportOutputs["preparation_cleanup_preview"];
export type GameUpdatePlan = Generated.TransportOutputs["game_update_plan"];
export type GameSettingsView = Generated.TransportOutputs["game_settings_view"];
export type GameSettingView = GameSettingsView["files"][number]["settings"][number];
export type GameSettingReview = Generated.TransportOutputs["game_setting_review"];
export type GameSettingChange = Requests.TransportInputs["game_setting_change"];
export type GameUpdateAcquisition = Generated.TransportOutputs["game_update_acquisition"];
export type ModSetupsView = Generated.TransportOutputs["mod_setups_view"];
export type ModSetupView = NonNullable<ModSetupsView["inventory"]>["profiles"][number];
export type ModSetup = ModSetupView["profile"];
export type ModSetupRevision = Generated.TransportOutputs["profile_revision"];
export type LiveMods = Generated.TransportOutputs["live_mods"];
export type ProviderBrowsePage = Generated.TransportOutputs["provider_browse_page"];
export type ProviderProjectView = Generated.TransportOutputs["provider_project_view"];
export type ProviderInstallPlan = Generated.TransportOutputs["provider_install_plan"];
export type ModCodeReview = Generated.TransportOutputs["mod_code_review"];

export type { SourceHealth } from "./transport-types.generated";

export type ReadinessBlocker = NonNullable<PortStatus["readiness"]>["blockers"][number];

export type { PortStatus } from "./transport-types.generated";

export type { ActivityOperation } from "./transport-types.generated";

export type { CancellationState } from "./transport-types.generated";

export type ActivityFeed = Generated.TransportOutputs["activity"];
export type ActivityRecord = ActivityFeed["records"][number];
export type ActivityDiagnostic = Generated.TransportOutputs["activity_diagnostic"];

export type { StorageSummary } from "./transport-types.generated";

export type { HostToolStatus } from "./transport-types.generated";

export type HostToolProbeResult = Generated.TransportOutputs["host_tool_probe_result"];

export type DoctorReport = Generated.TransportOutputs["doctor"];

/** The snapshot as it crosses IPC; the catalog may be omitted when unchanged. */
export type WorkspaceSnapshotTransport = Generated.TransportOutputs["desktop_workspace_snapshot"];
/** A complete snapshot after the frontend restores an unchanged catalog. */
export type WorkspaceSnapshot = WorkspaceSnapshotTransport & {
  catalog: NonNullable<WorkspaceSnapshotTransport["catalog"]>;
};
export type CatalogBrowsingSnapshot = NonNullable<WorkspaceSnapshot["browsing"]>;
export type CatalogBrowsingContext = CatalogBrowsingSnapshot["contexts"][number];

export type LocalePreferenceSnapshot = Generated.TransportOutputs["desktop_locale_preference"];

export type BackupRecord = Generated.TransportOutputs["backup"];
export type PortableSaveExportPreview = Generated.TransportOutputs["portable_save_export_preview"];
export type PortableSaveExportResult = Generated.TransportOutputs["portable_save_export_result"];
export type PortableSaveImportPreview = Generated.TransportOutputs["portable_save_import_preview"];
export type PortableSaveImportResult = Generated.TransportOutputs["portable_save_import_result"];

export type { BackupProblem } from "./transport-types.generated";

export type BackupInventory = Generated.TransportOutputs["backup_inventory"];

export type RestoreResult = Generated.TransportOutputs["restore_result"];
export type GhostshipRecoveryPlan = Generated.TransportOutputs["ghostship_recovery_plan"];
export type GhostshipRecoveryResult = Generated.TransportOutputs["ghostship_recovery_result"];

export type AdoptionPreview = Generated.TransportOutputs["adoption_preview"];
export type LauncherLibraryInventory = Generated.TransportOutputs["launcher_library_inventory"];
export type LauncherLibraryEntry = LauncherLibraryInventory["entries"][number];
export type LauncherKind = LauncherLibraryInventory["launcher"];
export type AdoptionBatchItem = Requests.TransportInputs["desktop_adoption_batch_items"][number];
export type AdoptionBatchPreview = Generated.TransportOutputs["desktop_adoption_batch_preview"];
export type AdoptionBatchResult = NonNullable<
  Generated.TransportOutputs["desktop_adoption_batch_result"]
>;
export type ExternalRuntimePreview = Generated.TransportOutputs["desktop_external_runtime_preview"];
export type ExternalRuntimeRelinkPreview =
  Generated.TransportOutputs["desktop_external_runtime_relink_preview"];
export type ExternalRuntimeRemovalPreview =
  Generated.TransportOutputs["desktop_external_runtime_removal_preview"];
export type ExternalRuntimeRecord = Generated.TransportOutputs["desktop_external_runtime_record"];

export type { SourceRecord } from "./transport-types.generated";

export type GameFileRoot = Generated.TransportOutputs["game_file_roots"][number];
export type LibraryMembership = Generated.TransportOutputs["desktop_library_memberships"][number];
export type LibraryMembershipOutcome =
  Generated.TransportOutputs["desktop_library_membership_outcomes"][number];
export type LibraryMembershipRequest =
  Requests.TransportInputs["desktop_library_membership_requests"][number];
export type InstallBatchReview = Generated.TransportOutputs["desktop_install_batch_review"];
export type InstallBatchRecord = Generated.TransportOutputs["desktop_install_batch"];
export type PortIntent = Generated.TransportOutputs["desktop_port_intent"];
export type PortIntentMode = PortIntent["mode"];
export type PortIntentAssessments = Generated.TransportOutputs["desktop_port_intent_assessments"];
export type PortIntentAssessment = PortIntentAssessments["assessments"][number];
export type StandingSetupResult = Generated.TransportOutputs["desktop_standing_setup"];
export type RootSetupConsent = Generated.TransportOutputs["desktop_root_setup_consents"][number];
export type RootSetupEnrollment = RootSetupConsent["enrollment"];
export type PortReadinessAcknowledgement =
  Requests.TransportInputs["desktop_port_readiness_acknowledgements"][number];
export type InstallBatchRequestItem =
  Requests.TransportInputs["desktop_install_batch_request_items"][number];
export type GameFileQueryRefreshRequest = Requests.TransportInputs["game_file_query_request"];
export type GameFileQuerySnapshot = Generated.TransportOutputs["game_file_query_snapshot"];

export type GameFileScanSnapshot = NonNullable<
  Generated.TransportOutputs["game_file_scan_snapshot"]
>;
export type GameFileScanMatchPage = Generated.TransportOutputs["desktop_game_file_scan_match_page"];
export type GameFileScanMatchQuery = Requests.TransportInputs["desktop_game_file_scan_match_query"];

export type { ObservedSourceDigest } from "./transport-types.generated";

export type { ObservedSourceComponent } from "./transport-types.generated";

export type SourceRemovalPreview = Generated.TransportOutputs["source_removal_preview"];

export type SourceRelinkPlan = Generated.TransportOutputs["source_relink_plan"];

export type { SourceInspectionReport } from "./transport-types.generated";

export type SourceIntakeInspection = Generated.TransportOutputs["source_intake_inspection"];

// These envelopes are generated from the exact Tauri-owned Rust definitions.
export type SourceVerificationOutcome =
  Generated.TransportOutputs["desktop_source_verification_outcome"];

export type { UpdateCheck } from "./transport-types.generated";
export type UpdateCheckForecast = Generated.TransportOutputs["update_check_forecast"];

export type { PortOutputLocation } from "./transport-types.generated";

export type OutputDestinationPreview = Generated.TransportOutputs["output_destination_preview"];

export type OutputRelocationPlan = Generated.TransportOutputs["output_relocation_plan"];

export type OutputRelocationResult = Generated.TransportOutputs["output_relocation_result"];

export type OutputRelocationStatus = Generated.TransportOutputs["output_relocation_status"];

export type InstallPlan = Generated.TransportOutputs["install_plan"];

export type { UpdateSnapshot } from "./transport-types.generated";

export type UpdateCheckOutcome = Generated.TransportOutputs["desktop_update_check_outcome"];

export type OperationEvent = Generated.TransportOutputs["operation_event"];

export type DesktopEventPayloads = Events.DesktopEventPayloads;

export type DesktopError = Generated.TransportOutputs["desktop_desktop_error"];

export type BootstrapStatus = Generated.TransportOutputs["desktop_bootstrap_status"];

export type DesktopSupportBundleExport =
  Generated.TransportOutputs["desktop_support_bundle_export"];

export type ApplicationUpdatePreferences =
  Generated.TransportOutputs["desktop_application_update_preferences"];

export type ApplicationUpdateChoice = Requests.TransportInputs["desktop_application_update_choice"];

export type ApplicationUpdateProductionDecision =
  Requests.TransportInputs["desktop_application_update_production_decision"];

export type ApplicationUpdateProductionTransition =
  Generated.TransportOutputs["desktop_application_update_production_transition"];

export type ApplicationUpdateProductionTransitionResult =
  Generated.TransportOutputs["desktop_application_update_production_transition_result"];

export type ApplicationUpdateStatus =
  Generated.TransportOutputs["desktop_application_update_status"];

export type ApplicationUpdateRecoveryArea =
  Requests.TransportInputs["desktop_application_update_recovery_area"];

export type ApplicationUpdateCheckResult =
  Generated.TransportOutputs["desktop_application_update_check_result"];

export type ApplicationUpdateManualCheckRequest =
  Requests.TransportInputs["desktop_application_update_manual_check_request"];
export type ApplicationUpdateManualCheckResult =
  Generated.TransportOutputs["desktop_application_update_manual_check_result"];

export type ApplicationUpdateNoticeSnapshot =
  Generated.TransportOutputs["desktop_application_update_notice"];

export type ApplicationUpdateCheckPhase =
  Generated.TransportOutputs["desktop_application_update_check_phase"];

export type ApplicationUpdateDownloadRequest =
  Requests.TransportInputs["desktop_application_update_download_request"];

export type LibrarySelection = Generated.TransportOutputs["library_selection"];

export type { LibraryMetadataFile } from "./transport-types.generated";

export type LibraryMovePlan = Generated.TransportOutputs["library_move_plan"];

export type LibraryMoveResult = Generated.TransportOutputs["library_move_result"];

export type LibraryImportPlan = Generated.TransportOutputs["library_import_plan"];

export type LibraryImportResult = Generated.TransportOutputs["library_import_result"];

export type SourceDiscoveryLimits = Requests.TransportInputs["source_discovery_limits"];

export type SourceDiscoveryRequest = Requests.TransportInputs["source_discovery_request"];

export type SourceDiscoveryReport = Generated.TransportOutputs["source_discovery_report"];

export type SourceInboxPaths = Generated.TransportOutputs["source_inbox_paths"];

export type SourceInboxResolution = Generated.TransportOutputs["source_inbox_resolution"];

export type { SourceImportMode } from "./transport-types.generated";

export type SourceImportPlan = Generated.TransportOutputs["source_import_plan"];

export type SourceImportResult = Generated.TransportOutputs["source_import_result"];

export type GithubAuthStatus = Generated.TransportOutputs["github_auth_status"];

export type GithubDeviceLogin = Generated.TransportOutputs["github_device_login"];

export type GithubDeviceLoginResult = Generated.TransportOutputs["github_device_login_result"];

export type CatalogUpdateSource = Requests.TransportInputs["catalog_update_source"];

export type CatalogProvenance = Generated.TransportOutputs["catalog_provenance"];

export type ListingDeliveryStatus = Generated.TransportOutputs["listing_delivery_status"];

export type CatalogStatus = Generated.TransportOutputs["catalog_status"];

export type CatalogUpdatePlan = Generated.TransportOutputs["catalog_update_plan"];

export type InstallInput = Requests.TransportInputs["desktop_install_input"];
export type LaunchResult = Generated.TransportOutputs["desktop_launch_result"];
export type LaunchSessionView = NonNullable<Generated.TransportOutputs["launch_request"]>;
export type RuntimePrerequisiteReport = NonNullable<
  Generated.TransportOutputs["runtime_prerequisite_report"]
>;
export type RuntimePrerequisite = RuntimePrerequisiteReport["requirements"][number];

export type BackupReview = Generated.TransportOutputs["desktop_backup_review"];
export type BackupAction = BackupReview["preview"]["action"];

export type PortRemovalPreview = Generated.TransportOutputs["port_removal_preview"];

export type CliCommandContext = Generated.TransportOutputs["desktop_cli_command_context"];

export type SteamEntryReview = Generated.TransportOutputs["desktop_steam_entry_review"];
export type SteamEntryApplyResult = Generated.TransportOutputs["desktop_steam_entry_apply_result"];
export type SteamEntryOperation = SteamEntryReview["operation"];
export type SteamEntrySelection = Requests.TransportInputs["desktop_steam_entry_selection"];
export type SteamBatchReview = Generated.TransportOutputs["desktop_steam_batch_review"];
export type SteamBatchSelection = Requests.TransportInputs["desktop_steam_batch_selection"];
export type SteamArtworkReview = Generated.TransportOutputs["desktop_steam_artwork_review"];
export type SteamArtworkApplyResult =
  Generated.TransportOutputs["desktop_steam_artwork_apply_result"];
export type SteamArtworkOperation = SteamArtworkReview["operation"];
export type SteamArtworkSelection = Requests.TransportInputs["desktop_steam_artwork_selection"];

export type GameComparison = Generated.TransportOutputs["desktop_game_comparison"];
export type BugReportDraft = Generated.TransportOutputs["desktop_bug_report_draft"];
export type BugReportLink = Generated.TransportOutputs["desktop_bug_report_link"];
export type BugReportField = Requests.TransportInputs["desktop_bug_report_field"];
export type ReportKind = Requests.TransportInputs["desktop_report_kind"];
export type SubmittedReport = Generated.TransportOutputs["desktop_submitted_report"];
export type GameComparisonRequest = Requests.TransportInputs["desktop_game_comparison_request"];
