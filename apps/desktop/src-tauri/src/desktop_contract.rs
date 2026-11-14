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

/// The application release feed a player follows. Beta is the default; Preview
/// is an opt-in feed that receives builds before Beta.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ApplicationUpdateChannel {
    #[default]
    Beta,
    Preview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdatePreferences {
    pub channel: ApplicationUpdateChannel,
    /// Check for updates at startup and periodically. A found update is only
    /// announced; installing always needs the player's click.
    pub automatic_checks: bool,
}

impl Default for ApplicationUpdatePreferences {
    fn default() -> Self {
        Self {
            channel: ApplicationUpdateChannel::Beta,
            automatic_checks: true,
        }
    }
}

/// A newer signed release announced by the channel feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateAvailable {
    pub version: String,
    pub channel: ApplicationUpdateChannel,
    pub notes: Option<String>,
    /// Publication date as written in the feed (RFC 3339).
    pub date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateStatus {
    pub current_version: String,
    pub checking: bool,
    pub installing: bool,
    pub available: Option<ApplicationUpdateAvailable>,
    pub last_checked_unix_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum ApplicationUpdateProgress {
    Downloading {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
    Installing,
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
    /// As `RemoveOwned`, for one role only; the entry's other artwork stays.
    RemoveOwnedRole {
        role: portcove_core::DestinationArtworkRole,
    },
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
    /// Roles whose Portcove-added Steam image came from a SteamGridDB image
    /// Portcove has since removed from its library. Display only: it is not
    /// part of the reviewed plan, and removal still needs its own review.
    /// Empty when unknown.
    pub withdrawn_sources: Vec<SteamArtworkWithdrawnSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamArtworkWithdrawnSource {
    pub role: portcove_core::DestinationArtworkRole,
    /// When Portcove removed its own copy of the source image.
    pub source_evicted_at: i64,
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
            output::<ApplicationUpdateStatus>(),
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
            "dat_reference_status": output::<portcove_core::DatReferenceStatus>(),
            "dat_reference_statuses": output::<Vec<portcove_core::DatReferenceStatus>>(),
            "automatic_snapshots_enabled": output::<bool>(),
            "ready_notices_enabled": output::<bool>(),
            "bug_report_draft": output::<portcove_core::BugReportDraft>(),
            "bug_report_link": output::<portcove_core::BugReportLink>(),
            "submitted_report": output::<portcove_core::SubmittedReport>(),
            "application_update_preferences": output::<ApplicationUpdatePreferences>(),
            "application_update_status": output::<ApplicationUpdateStatus>(),
            "application_update_progress": output::<ApplicationUpdateProgress>(),
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
            "store_game_installs": output::<portcove_core::StoreGameInstalls>(),
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
            "application_update_preferences": schemars::schema_for!(ApplicationUpdatePreferences),
            "steam_entry_selection": schemars::schema_for!(SteamEntrySelection),
            "steam_batch_selection": schemars::schema_for!(SteamBatchSelection),
            "steam_artwork_selection": schemars::schema_for!(SteamArtworkSelection),
        },
        "events": events,
    })
}
