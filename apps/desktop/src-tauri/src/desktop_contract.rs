//! Host-owned serialization declarations shared by the native app and headless exporter.
//! Native policies, commands, storage, and event emission remain in their owners.

use portcove_core::{
    LibrarySelection, ReconcileResult, ReleaseChannel, SourceVerification, UpdateCheck,
};
use schemars::{JsonSchema, generate::SchemaSettings};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;

pub(crate) const DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE: &str =
    "portcove://application-update-notice";
pub(crate) const DESKTOP_EVENT_LIBRARY_CHANGED: &str = "portcove://library-changed";
pub(crate) const DESKTOP_EVENT_OPERATION: &str = "portcove://operation";

pub(crate) type DesktopError = portcove_core::FailureReport;

#[derive(Debug, Serialize, JsonSchema)]
pub(crate) struct DesktopWorkspaceSnapshot {
    pub(crate) catalog: portcove_core::CatalogDocument,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) listing_catalog: Option<portcove_core::CatalogListingDocument>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) listing_statuses: Vec<portcove_core::PortListingStatus>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) pending_setups: Vec<portcove_core::PendingSetupRecord>,
    pub(crate) statuses: Vec<portcove_core::PortStatus>,
    pub(crate) sources: Vec<portcove_core::SourceRecord>,
    pub(crate) activities: portcove_core::ActivityFeed,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) browsing: Option<portcove_core::CatalogBrowsingSnapshot>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub(crate) struct BatchOutcome<T> {
    pub(crate) port_id: String,
    pub(crate) ok: bool,
    pub(crate) result: Option<T>,
    pub(crate) error: Option<DesktopError>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub(crate) struct SourceBatchOutcome {
    pub(crate) profile_id: String,
    pub(crate) ok: bool,
    pub(crate) result: Option<SourceVerification>,
    pub(crate) error: Option<DesktopError>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub(crate) struct BootstrapStatus {
    pub(crate) ready: bool,
    pub(crate) library_root: Option<PathBuf>,
    pub(crate) selection: Option<LibrarySelection>,
    pub(crate) generation: u64,
    pub(crate) error: Option<DesktopError>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub(crate) struct DesktopLocalePreference {
    pub(crate) locale: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub(crate) struct BackupReview {
    pub(crate) preview: portcove_core::BackupActionPreview,
    pub(crate) port_name: String,
    pub(crate) persistent_data_path: PathBuf,
}

#[derive(Debug, Serialize, JsonSchema)]
pub(crate) struct CliCommandContext {
    pub(crate) library_root: PathBuf,
    pub(crate) executable: Option<PathBuf>,
    pub(crate) platform: portcove_core::Platform,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallInput {
    pub(crate) port_id: String,
    pub(crate) channel: Option<ReleaseChannel>,
    pub(crate) source: Option<PathBuf>,
    pub(crate) bios: Option<PathBuf>,
    pub(crate) stage: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchResult {
    pub(crate) process_id: Option<u32>,
    pub(crate) session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ApplicationChannel {
    Preview,
    Stable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdateCandidateSummary {
    pub version: String,
    pub channel: ApplicationChannel,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateCheckPhase {
    Checking,
    AcquiringAndVerifying,
    Staged,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateCheckResultKind {
    ConsentRequired,
    Paused,
    ManualMode,
    Offline,
    Metered,
    MeteredStateUnknown,
    StartupDelay,
    Cadence,
    Superseded,
    Current,
    UpdateAvailable,
    Held,
    Incompatible,
    NoCandidate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateCheckResult {
    pub kind: ApplicationUpdateCheckResultKind,
    pub candidate: Option<ApplicationUpdateCandidateSummary>,
    pub reasons: Vec<String>,
    pub staged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdateManualCheckRequest {
    pub channel: Option<ApplicationChannel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateManualCheckResult {
    pub checked_channel: ApplicationChannel,
    pub result: ApplicationUpdateCheckResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateNotice {
    pub preference_revision: u64,
    pub result: ApplicationUpdateCheckResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateNoticeSnapshot {
    pub revision: u64,
    pub notice: Option<ApplicationUpdateNotice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdateDownloadRequest {
    pub expected_preference_revision: u64,
    pub expected_candidate: ApplicationUpdateCandidateSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateMode {
    Automatic,
    NotifyOnly,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdateChoice {
    pub channel: ApplicationChannel,
    pub mode: ApplicationUpdateMode,
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdatePreferences {
    pub schema_version: u32,
    pub revision: u64,
    /// `None` means the user has not completed the one-time choice.
    pub choice: Option<ApplicationUpdateChoice>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateProductionDecision {
    UseStable,
    KeepPreview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateProductionTransition {
    pub schema_version: u32,
    pub preference_revision: u64,
    pub offer_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateProductionTransitionResult {
    pub preferences: ApplicationUpdatePreferences,
    pub transition: ApplicationUpdateProductionTransition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateRecoveryArea {
    Schedule,
    Staging,
    Apply,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateRecoveryNotice {
    pub area: ApplicationUpdateRecoveryArea,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateScheduleSummary {
    pub last_success_unix_seconds: Option<u64>,
    pub consecutive_failures: u32,
    pub next_automatic_check_unix_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateRequestedAction {
    SafeExit,
    RestartToApply,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateObservedTermination {
    NormalExit,
    RestartToApply,
    Crash,
    OsShutdown,
    SteamStop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateNativeLaunchSummary {
    Starting,
    Started,
    Failed,
    InstallerSucceeded,
    InstallerFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateApplySummary {
    pub revision: u64,
    pub request: ApplicationUpdateRequestedAction,
    pub termination: Option<ApplicationUpdateObservedTermination>,
    pub native_launch: Option<ApplicationUpdateNativeLaunchSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateInstallEligibility {
    Eligible,
    PackageManagedDeb,
    PackageManagedRpm,
    NotConfigured,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateStatus {
    pub schedule: Option<ApplicationUpdateScheduleSummary>,
    pub staged: Option<ApplicationUpdateCandidateSummary>,
    pub apply: Option<ApplicationUpdateApplySummary>,
    pub install_eligibility: ApplicationUpdateInstallEligibility,
    pub recovery_required: Vec<ApplicationUpdateRecoveryNotice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamGameEntryTarget {
    pub port_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamEntryChangeKind {
    Add,
    Repair,
    Remove,
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamEntryChange {
    pub port_id: String,
    pub display_name: Option<String>,
    pub kind: SteamEntryChangeKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamClientState {
    Closed,
    Running,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamEntryApplyResult {
    pub plan_sha256: String,
    pub shortcuts_path: PathBuf,
    pub backup_path: Option<PathBuf>,
    pub changes: Vec<SteamEntryChange>,
    pub wrote: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamEntryOperation {
    AddOrRepair,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SteamEntrySelection {
    pub port_id: String,
    pub steam_root: PathBuf,
    pub steam_user_id: String,
    pub operation: SteamEntryOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SteamBatchSelection {
    pub port_ids: Vec<String>,
    pub steam_root: PathBuf,
    pub steam_user_id: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SteamBatchReview {
    pub schema_version: u32,
    pub selected_games: Vec<SteamGameEntryTarget>,
    pub steam_root: PathBuf,
    pub steam_user_id: String,
    pub library_root: PathBuf,
    pub cli_path: PathBuf,
    pub cli_sha256: String,
    pub cli_product_version: String,
    pub shortcuts_path: PathBuf,
    pub snapshot_sha256: Option<String>,
    pub proposed_sha256: String,
    pub review_sha256: String,
    pub writer_plan_sha256: String,
    pub changes: Vec<SteamEntryChange>,
    pub steam_client_state: SteamClientState,
    pub writes_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct SteamEntryReview {
    pub schema_version: u32,
    pub operation: SteamEntryOperation,
    pub port_id: String,
    pub display_name: String,
    pub steam_root: PathBuf,
    pub steam_user_id: String,
    pub library_root: PathBuf,
    pub cli_path: Option<PathBuf>,
    pub cli_sha256: Option<String>,
    pub cli_product_version: Option<String>,
    pub shortcuts_path: PathBuf,
    pub snapshot_sha256: Option<String>,
    pub proposed_sha256: String,
    pub plan_sha256: String,
    pub changes: Vec<SteamEntryChange>,
    pub steam_client_state: SteamClientState,
    pub writes_required: bool,
}

fn output<T: JsonSchema>() -> Value {
    json!(
        SchemaSettings::default()
            .for_serialize()
            .into_generator()
            .into_root_schema_for::<T>()
    )
}

pub fn export_transport_schemas() -> Value {
    let events = serde_json::Map::from_iter([
        (
            DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE.to_owned(),
            output::<ApplicationUpdateNoticeSnapshot>(),
        ),
        (DESKTOP_EVENT_LIBRARY_CHANGED.to_owned(), output::<()>()),
        (
            DESKTOP_EVENT_OPERATION.to_owned(),
            output::<portcove_core::OperationEvent>(),
        ),
    ]);
    json!({
        "output": {
            "bootstrap_status": output::<BootstrapStatus>(),
            "support_bundle_export": output::<portcove_core::SupportBundleExport>(),
            "locale_preference": output::<DesktopLocalePreference>(),
            "backup_review": output::<BackupReview>(),
            "cli_command_context": output::<CliCommandContext>(),
            "desktop_error": output::<DesktopError>(),
            "update_check_outcome": output::<BatchOutcome<UpdateCheck>>(),
            "reconcile_outcome": output::<BatchOutcome<ReconcileResult>>(),
            "source_verification_outcome": output::<SourceBatchOutcome>(),
            "launch_result": output::<LaunchResult>(),
            "application_update_preferences": output::<ApplicationUpdatePreferences>(),
            "application_update_production_transition": output::<ApplicationUpdateProductionTransition>(),
            "application_update_production_transition_result": output::<ApplicationUpdateProductionTransitionResult>(),
            "application_update_status": output::<ApplicationUpdateStatus>(),
            "application_update_check_result": output::<ApplicationUpdateCheckResult>(),
            "application_update_manual_check_result": output::<ApplicationUpdateManualCheckResult>(),
            "application_update_check_phase": output::<ApplicationUpdateCheckPhase>(),
            "application_update_notice": output::<ApplicationUpdateNoticeSnapshot>(),
            "workspace_snapshot": output::<DesktopWorkspaceSnapshot>(),
            "game_file_roots": output::<Vec<portcove_core::GameFileRoot>>(),
            "game_file_scan_snapshot": output::<Option<portcove_core::GameFileScanSnapshot>>(),
            "game_file_query_snapshot": output::<portcove_core::GameFileQuerySnapshot>(),
            "preparation_cleanup_preview": output::<portcove_core::PreparationCleanupPreview>(),
            "external_runtime_preview": output::<portcove_core::ExternalRuntimePreview>(),
            "external_runtime_relink_preview": output::<portcove_core::ExternalRuntimeRelinkPreview>(),
            "external_runtime_removal_preview": output::<portcove_core::ExternalRuntimeRemovalPreview>(),
            "external_runtime_record": output::<portcove_core::ExternalRuntimeRecord>(),
            "catalog_download_candidates": output::<portcove_core::CatalogDownloadCandidates>(),
            "setup_launch_targets": output::<portcove_core::SetupLaunchTargets>(),
            "catalog_download_preview": output::<portcove_core::CatalogDownloadPreview>(),
            "pending_setup_record": output::<portcove_core::PendingSetupRecord>(),
            "steam_entry_review": output::<SteamEntryReview>(),
            "steam_profiles": output::<Vec<String>>(),
            "steam_batch_review": output::<SteamBatchReview>(),
            "steam_entry_apply_result": output::<SteamEntryApplyResult>(),
        },
        "input": {
            "install_input": schemars::schema_for!(InstallInput),
            "catalog_download_request": schemars::schema_for!(portcove_core::CatalogDownloadRequest),
            "game_file_query_request": schemars::schema_for!(portcove_core::GameFileQueryRefreshRequest),
            "application_update_choice": schemars::schema_for!(ApplicationUpdateChoice),
            "application_update_production_decision": schemars::schema_for!(ApplicationUpdateProductionDecision),
            "application_update_recovery_area": schemars::schema_for!(ApplicationUpdateRecoveryArea),
            "application_update_download_request": schemars::schema_for!(ApplicationUpdateDownloadRequest),
            "application_update_manual_check_request": schemars::schema_for!(ApplicationUpdateManualCheckRequest),
            "steam_entry_selection": schemars::schema_for!(SteamEntrySelection),
            "steam_batch_selection": schemars::schema_for!(SteamBatchSelection),
        },
        "events": events,
    })
}
