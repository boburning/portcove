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
    /// Omitted only when `catalog_unchanged` is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) catalog: Option<portcove_core::CatalogDocument>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) listing_catalog: Option<portcove_core::CatalogListingDocument>,
    /// SHA-256 of the catalog and listing documents as serialized here. A
    /// caller that already holds these exact documents passes the digest back
    /// and receives `catalog_unchanged` without either document.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) catalog_digest: Option<String>,
    /// True when `catalog` and `listing_catalog` were omitted because the
    /// caller's known digest matched; the caller keeps its own copies.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) catalog_unchanged: bool,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallInput {
    pub(crate) port_id: String,
    pub(crate) channel: Option<ReleaseChannel>,
    pub(crate) source: Option<PathBuf>,
    pub(crate) bios: Option<PathBuf>,
    pub(crate) stage: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source_reference: Option<portcove_core::SourceRegistrationReference>,
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
    /// Per-game outcome of artwork included with a shortcut Add. A failed or
    /// unavailable role never undoes a successfully written shortcut.
    #[serde(default)]
    pub artwork: Vec<SteamEntryArtworkOutcome>,
}

/// Artwork reviewed together with a shortcut Add for one game.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamEntryArtworkPreview {
    pub port_id: String,
    pub roles: Vec<SteamArtworkRoleChange>,
    /// Why this game's artwork cannot be reviewed now; the shortcut is unaffected.
    pub unavailable: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamEntryArtworkOutcome {
    pub port_id: String,
    pub roles: Vec<SteamArtworkRoleChange>,
    pub backup_paths: Vec<PathBuf>,
    pub wrote: bool,
    /// Why no artwork was written for this game; retry with Review artwork update.
    pub error: Option<String>,
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
    /// Also fill missing Steam artwork for a newly added shortcut.
    #[serde(default)]
    pub include_artwork: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SteamBatchSelection {
    pub port_ids: Vec<String>,
    pub steam_root: PathBuf,
    pub steam_user_id: String,
    /// Also fill missing Steam artwork for each newly added shortcut.
    #[serde(default)]
    pub include_artwork: bool,
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
    pub artwork: Vec<SteamEntryArtworkPreview>,
    pub artwork_review_sha256: Option<String>,
    /// An interrupted shortcut (or, for shortcut reviews, artwork) change in this
    /// profile was settled before review.
    pub recovered_shortcut_change: bool,
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
    pub artwork: Vec<SteamEntryArtworkPreview>,
    pub artwork_review_sha256: Option<String>,
    /// An interrupted shortcut (or, for shortcut reviews, artwork) change in this
    /// profile was settled before review.
    pub recovered_shortcut_change: bool,
}

/// Separate reviewed Steam artwork action for one owned shortcut.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SteamArtworkOperation {
    /// Fill missing roles; replace existing art only when explicitly requested.
    Update { replace_existing: bool },
    /// Remove only recorded, unchanged Portcove-written art for this entry.
    RemoveOwned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamArtworkRoleAction {
    Write,
    Replace,
    Preserve,
    Unchanged,
    Unavailable,
    Remove,
    PreserveModified,
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamArtworkRoleChange {
    pub role: portcove_core::DestinationArtworkRole,
    pub action: SteamArtworkRoleAction,
    pub destination_path: Option<PathBuf>,
    pub existing_paths: Vec<PathBuf>,
    pub existing_sha256: Option<String>,
    pub proposed_sha256: Option<String>,
    pub unavailable_reason: Option<portcove_core::DestinationArtworkUnavailableReason>,
    /// The destination-local ownership record for this role is dropped.
    pub forget_ownership: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SteamArtworkSelection {
    pub port_id: String,
    pub steam_root: PathBuf,
    pub steam_user_id: String,
    pub operation: SteamArtworkOperation,
}

/// Roles an earlier interrupted artwork change settled before this review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamArtworkRecovery {
    pub completed: Vec<portcove_core::DestinationArtworkRole>,
    pub abandoned: Vec<portcove_core::DestinationArtworkRole>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct SteamArtworkReview {
    pub schema_version: u32,
    pub operation: SteamArtworkOperation,
    pub port_id: String,
    pub display_name: String,
    pub steam_root: PathBuf,
    pub steam_user_id: String,
    pub app_id: Option<u32>,
    pub grid_path: PathBuf,
    pub plan_sha256: String,
    pub roles: Vec<SteamArtworkRoleChange>,
    pub steam_client_state: SteamClientState,
    pub writes_required: bool,
    pub recovered: Option<SteamArtworkRecovery>,
    /// An interrupted shortcut (or, for shortcut reviews, artwork) change in this
    /// profile was settled before review.
    pub recovered_shortcut_change: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamArtworkApplyResult {
    pub plan_sha256: String,
    pub roles: Vec<SteamArtworkRoleChange>,
    pub backup_paths: Vec<PathBuf>,
    pub wrote: bool,
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
            "game_comparison": output::<portcove_core::GameComparison>(),
            "bootstrap_status": output::<BootstrapStatus>(),
            "support_bundle_export": output::<portcove_core::SupportBundleExport>(),
            "locale_preference": output::<DesktopLocalePreference>(),
            "library_organization": output::<portcove_core::LibraryOrganization>(),
            "backup_review": output::<BackupReview>(),
            "cli_command_context": output::<CliCommandContext>(),
            "desktop_error": output::<DesktopError>(),
            "update_check_outcome": output::<BatchOutcome<UpdateCheck>>(),
            "reconcile_outcome": output::<BatchOutcome<ReconcileResult>>(),
            "source_verification_outcome": output::<SourceBatchOutcome>(),
            "launch_result": output::<LaunchResult>(),
            "automatic_snapshots_enabled": output::<bool>(),
            "bug_report_draft": output::<portcove_core::BugReportDraft>(),
            "bug_report_link": output::<portcove_core::BugReportLink>(),
            "submitted_report": output::<portcove_core::SubmittedReport>(),
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
            "library_memberships": output::<Vec<portcove_core::LibraryMembership>>(),
            "library_membership_outcomes": output::<Vec<portcove_core::LibraryMembershipOutcome>>(),
            "install_batch_review": output::<portcove_core::InstallBatchReview>(),
            "adoption_batch_preview": output::<portcove_core::AdoptionBatchPreview>(),
            "adoption_batch_result": output::<Option<portcove_core::AdoptionBatchResult>>(),
            "install_batch": output::<portcove_core::InstallBatchRecord>(),
            "install_batches": output::<Vec<portcove_core::InstallBatchRecord>>(),
            "port_intent": output::<portcove_core::PortIntent>(),
            "port_intents": output::<Vec<portcove_core::PortIntent>>(),
            "port_intent_assessments": output::<portcove_core::PortIntentAssessments>(),
            "standing_setup": output::<portcove_core::StandingSetupResult>(),
            "root_setup_consent": output::<Option<portcove_core::RootSetupConsent>>(),
            "root_setup_consents": output::<Vec<portcove_core::RootSetupConsent>>(),
            "source_reuse_review": output::<portcove_core::SourceReuseReview>(),
            "game_file_scan_snapshot": output::<Option<portcove_core::GameFileScanSnapshot>>(),
            "game_file_scan_match_page": output::<portcove_core::GameFileScanMatchPage>(),
            "game_file_query_snapshot": output::<portcove_core::GameFileQuerySnapshot>(),
            "preparation_cleanup_preview": output::<portcove_core::PreparationCleanupPreview>(),
            "external_runtime_preview": output::<portcove_core::ExternalRuntimePreview>(),
            "external_runtime_relink_preview": output::<portcove_core::ExternalRuntimeRelinkPreview>(),
            "managed_route_change_preview": output::<portcove_core::ManagedRouteChangePreview>(),
            "managed_route_change_result": output::<portcove_core::ManagedRouteChangeResult>(),
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
            "steam_artwork_review": output::<SteamArtworkReview>(),
            "steam_artwork_apply_result": output::<SteamArtworkApplyResult>(),
        },
        "input": {
            "game_comparison_request": schemars::schema_for!(portcove_core::GameComparisonRequest),
            "bug_report_field": schemars::schema_for!(portcove_core::BugReportField),
            "report_kind": schemars::schema_for!(portcove_core::ReportKind),
            "install_input": schemars::schema_for!(InstallInput),
            "organization_change": schemars::schema_for!(portcove_core::OrganizationChange),
            "catalog_download_request": schemars::schema_for!(portcove_core::CatalogDownloadRequest),
            "game_file_query_request": schemars::schema_for!(portcove_core::GameFileQueryRefreshRequest),
            "library_membership_requests": schemars::schema_for!(Vec<portcove_core::LibraryMembershipRequest>),
            "install_batch_request_items": schemars::schema_for!(Vec<portcove_core::InstallBatchRequestItem>),
            "adoption_batch_items": schemars::schema_for!(Vec<portcove_core::AdoptionBatchItem>),
            "port_intent_mode": schemars::schema_for!(portcove_core::PortIntentMode),
            "root_setup_enrollment": schemars::schema_for!(Option<portcove_core::RootSetupEnrollment>),
            "game_file_scan_match_query": schemars::schema_for!(portcove_core::GameFileScanMatchQuery),
            "port_readiness_acknowledgements": schemars::schema_for!(Vec<portcove_core::PortReadinessAcknowledgement>),
            "application_update_choice": schemars::schema_for!(ApplicationUpdateChoice),
            "application_update_production_decision": schemars::schema_for!(ApplicationUpdateProductionDecision),
            "application_update_recovery_area": schemars::schema_for!(ApplicationUpdateRecoveryArea),
            "application_update_download_request": schemars::schema_for!(ApplicationUpdateDownloadRequest),
            "application_update_manual_check_request": schemars::schema_for!(ApplicationUpdateManualCheckRequest),
            "steam_entry_selection": schemars::schema_for!(SteamEntrySelection),
            "steam_batch_selection": schemars::schema_for!(SteamBatchSelection),
            "steam_artwork_selection": schemars::schema_for!(SteamArtworkSelection),
        },
        "events": events,
    })
}
