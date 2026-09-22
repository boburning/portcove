// Compile the exact host-owned declarations without exposing them as product API.
#[path = "../src/transport.rs"]
mod transport;

use portcove_core::{ReconcileResult, UpdateCheck};
use portcove_desktop::application_update_commands::{
    ApplicationUpdateCheckPhase, ApplicationUpdateCheckResult, ApplicationUpdateDownloadRequest,
    ApplicationUpdateNoticeSnapshot,
};
use portcove_desktop::application_update_preferences::{
    ApplicationUpdateChoice, ApplicationUpdatePreferences, ApplicationUpdateProductionDecision,
    ApplicationUpdateProductionTransition, ApplicationUpdateProductionTransitionResult,
};
use portcove_desktop::application_update_status::{
    ApplicationUpdateRecoveryArea, ApplicationUpdateStatus,
};
use portcove_desktop::steam_entries::SteamEntryApplyResult;
use portcove_desktop::steam_entry_commands::{SteamEntryReview, SteamEntrySelection};
use schemars::{JsonSchema, generate::SchemaSettings};
use serde_json::{Value, json};
use transport::{
    BackupReview, BatchOutcome, BootstrapStatus, CliCommandContext,
    DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE, DESKTOP_EVENT_LIBRARY_CHANGED,
    DESKTOP_EVENT_OPERATION, DesktopError, DesktopLocalePreference, DesktopWorkspaceSnapshot,
    InstallInput, LaunchResult, SourceBatchOutcome,
};

fn output<T: JsonSchema>() -> Value {
    json!(
        SchemaSettings::default()
            .for_serialize()
            .into_generator()
            .into_root_schema_for::<T>()
    )
}

fn main() {
    let _emit_adapter = transport::emit_desktop_event::<()>;
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
    println!(
        "{}",
        json!({
            "output": {
                "bootstrap_status": output::<BootstrapStatus>(),
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
                "application_update_check_phase": output::<ApplicationUpdateCheckPhase>(),
                "application_update_notice": output::<ApplicationUpdateNoticeSnapshot>(),
                "workspace_snapshot": output::<DesktopWorkspaceSnapshot>(),
                "game_file_roots": output::<Vec<portcove_core::GameFileRoot>>(),
                "game_file_scan_snapshot": output::<Option<portcove_core::GameFileScanSnapshot>>(),
                "preparation_cleanup_preview": output::<portcove_core::PreparationCleanupPreview>(),
                "steam_entry_review": output::<SteamEntryReview>(),
                "steam_entry_apply_result": output::<SteamEntryApplyResult>(),
            },
            "input": {
                "install_input": schemars::schema_for!(InstallInput),
                "application_update_choice": schemars::schema_for!(ApplicationUpdateChoice),
                "application_update_production_decision": schemars::schema_for!(ApplicationUpdateProductionDecision),
                "application_update_recovery_area": schemars::schema_for!(ApplicationUpdateRecoveryArea),
                "application_update_download_request": schemars::schema_for!(ApplicationUpdateDownloadRequest),
                "steam_entry_selection": schemars::schema_for!(SteamEntrySelection),
            },
            "events": events,
        })
    );
}
