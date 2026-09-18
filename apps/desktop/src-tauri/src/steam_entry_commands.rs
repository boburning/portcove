//! Desktop transport for explicit, reviewed Steam shortcut changes.
//!
//! The writer remains in `steam_entries`; this module derives every owned
//! identity from the active Portcove library and observes Steam itself rather
//! than trusting renderer-provided process or library state.

use crate::steam_entries::{
    SteamCliIdentity, SteamClientState, SteamEntryApplyResult, SteamEntryChange, SteamEntryError,
    SteamEntryPlan, SteamEntryPlanRequest, SteamGameEntryTarget, apply_steam_entry_plan,
    plan_steam_entries,
};
use crate::{
    DesktopError, DesktopResult, DesktopState, blocking_worker, cli_context, confirm_destructive,
    service_at_generation,
};
use portcove_core::{PortcoveError, PortcoveService};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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

#[derive(Debug, Clone)]
struct SteamEntryContext {
    port_id: String,
    display_name: String,
    library_id: String,
    library_root: PathBuf,
    cli: Option<cli_context::CliExecutableIdentity>,
}

#[tauri::command]
pub(crate) async fn preview_steam_entry(
    state: tauri::State<'_, DesktopState>,
    request: SteamEntrySelection,
    generation: u64,
) -> DesktopResult<SteamEntryReview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let context = entry_context(&service, &request.port_id)?;
        review_entry(
            context,
            request.steam_root,
            request.steam_user_id,
            request.operation,
            observe_steam_client(),
        )
        .map_err(steam_error)
    })
    .await
}

#[tauri::command]
pub(crate) async fn apply_steam_entry(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    request: SteamEntrySelection,
    expected_plan_sha256: String,
    generation: u64,
) -> DesktopResult<Option<SteamEntryApplyResult>> {
    let state_for_apply = state.inner().clone();
    let state_for_review = state_for_apply.clone();
    let request_for_review = request.clone();
    let (review, plan) = blocking_worker(move || {
        let service = service_at_generation(&state_for_review, generation)?;
        let context = entry_context(&service, &request_for_review.port_id)?;
        let plan = plan_entry(
            &context,
            request_for_review.steam_root,
            request_for_review.steam_user_id,
            request_for_review.operation,
        )
        .map_err(steam_error)?;
        if plan.plan_sha256 != expected_plan_sha256 {
            return Err(DesktopError::from(PortcoveError::conflict(
                "Steam entry state changed after preview; review the current plan again",
            )));
        }
        let review = review_from_plan(&context, request.operation, &plan, observe_steam_client());
        Ok((review, plan))
    })
    .await?;
    let action = match review.operation {
        SteamEntryOperation::AddOrRepair => "Apply reviewed Add / Repair",
        SteamEntryOperation::Remove => "Apply reviewed Remove",
    };
    let message = format!(
        "{action} for {} in Steam profile {}?\n\nShortcut file: {}\nPortcove library: {}\n\nSteam must be closed. Portcove will recheck the profile, process state, and reviewed plan before writing.",
        review.display_name,
        review.steam_user_id,
        review.shortcuts_path.display(),
        review.library_root.display(),
    );
    if !confirm_destructive(&app, "Confirm Steam entry change", message, action).await {
        return Ok(None);
    }
    blocking_worker(move || {
        let service = service_at_generation(&state_for_apply, generation)?;
        let context = entry_context(&service, &request.port_id)?;
        let current = revalidate_reviewed_plan(&context, &request, &plan).map_err(steam_error)?;
        let client_state = observe_steam_client();
        apply_steam_entry_plan(&current, client_state)
            .map(Some)
            .map_err(steam_error)
    })
    .await
}

fn entry_context(service: &PortcoveService, port_id: &str) -> DesktopResult<SteamEntryContext> {
    let port = service.catalog().port(port_id)?;
    if service.status(port_id)?.active.is_none() {
        return Err(DesktopError::from(PortcoveError::usage(format!(
            "install {} before adding it to Steam",
            port.name
        ))));
    }
    let library = service.library().identity_record()?;
    Ok(SteamEntryContext {
        port_id: port.id.clone(),
        display_name: port.name.clone(),
        library_id: library.id,
        library_root: library.root,
        cli: cli_context::discover_cli_identity_from_environment(),
    })
}

fn review_entry(
    context: SteamEntryContext,
    steam_root: PathBuf,
    steam_user_id: String,
    operation: SteamEntryOperation,
    client_state: SteamClientState,
) -> Result<SteamEntryReview, SteamEntryError> {
    let plan = plan_entry(&context, steam_root, steam_user_id, operation)?;
    Ok(review_from_plan(&context, operation, &plan, client_state))
}

fn plan_entry(
    context: &SteamEntryContext,
    steam_root: PathBuf,
    steam_user_id: String,
    operation: SteamEntryOperation,
) -> Result<SteamEntryPlan, SteamEntryError> {
    let request = match operation {
        SteamEntryOperation::AddOrRepair => SteamEntryPlanRequest::AddOrRepair {
            steam_root,
            steam_user_id,
            library_id: context.library_id.clone(),
            library_root: context.library_root.clone(),
            cli: context
                .cli
                .clone()
                .map(|identity| SteamCliIdentity {
                    path: identity.path,
                    sha256: identity.sha256,
                    product_version: identity.product_version,
                })
                .ok_or_else(|| {
                    SteamEntryError::InvalidInput(
                        "a compatible standalone Portcove CLI was not found; install this Portcove version or add it to PATH before creating a Steam entry".into(),
                    )
                })?,
            games: vec![SteamGameEntryTarget {
                port_id: context.port_id.clone(),
                display_name: context.display_name.clone(),
            }],
        },
        SteamEntryOperation::Remove => SteamEntryPlanRequest::Remove {
            steam_root,
            steam_user_id,
            library_id: context.library_id.clone(),
            port_ids: vec![context.port_id.clone()],
        },
    };
    plan_steam_entries(request)
}

fn revalidate_reviewed_plan(
    context: &SteamEntryContext,
    request: &SteamEntrySelection,
    reviewed: &SteamEntryPlan,
) -> Result<SteamEntryPlan, SteamEntryError> {
    let current = plan_entry(
        context,
        request.steam_root.clone(),
        request.steam_user_id.clone(),
        request.operation,
    )?;
    if current != *reviewed {
        return Err(SteamEntryError::Conflict(
            "the installed game, Portcove library, standalone CLI, Steam profile, or reviewed plan changed while consent was open".into(),
        ));
    }
    Ok(current)
}

fn review_from_plan(
    context: &SteamEntryContext,
    operation: SteamEntryOperation,
    plan: &SteamEntryPlan,
    client_state: SteamClientState,
) -> SteamEntryReview {
    SteamEntryReview {
        schema_version: 1,
        operation,
        port_id: context.port_id.clone(),
        display_name: context.display_name.clone(),
        steam_root: plan.request.steam_root().to_path_buf(),
        steam_user_id: plan.request.steam_user_id().to_owned(),
        library_root: context.library_root.clone(),
        cli_path: context.cli.as_ref().map(|identity| identity.path.clone()),
        cli_sha256: context.cli.as_ref().map(|identity| identity.sha256.clone()),
        cli_product_version: context
            .cli
            .as_ref()
            .map(|identity| identity.product_version.clone()),
        shortcuts_path: plan.shortcuts_path.clone(),
        snapshot_sha256: plan.snapshot_sha256.clone(),
        proposed_sha256: plan.proposed_sha256.clone(),
        plan_sha256: plan.plan_sha256.clone(),
        changes: plan.changes.clone(),
        steam_client_state: client_state,
        writes_required: plan.changes_required(),
    }
}

fn steam_error(error: SteamEntryError) -> DesktopError {
    match error {
        SteamEntryError::InvalidInput(message) => DesktopError::from(PortcoveError::usage(message)),
        SteamEntryError::Malformed(message) => {
            DesktopError::from(PortcoveError::unsupported(message))
        }
        SteamEntryError::Conflict(message) => DesktopError::from(PortcoveError::conflict(message)),
        SteamEntryError::RecoveryRequired(message) => DesktopError::from(PortcoveError::conflict(
            format!("Steam entry recovery is required: {message}"),
        )),
        SteamEntryError::Io { context, source } => DesktopError::from(PortcoveError::state(
            format!("Steam entry I/O failed while {context}: {source}"),
        )),
        SteamEntryError::Serialization(source) => DesktopError::from(PortcoveError::state(
            format!("Steam entry serialization failed: {source}"),
        )),
    }
}

fn observe_steam_client() -> SteamClientState {
    #[cfg(feature = "qualification-fixtures")]
    if let Some(state) = qualification_steam_client_state() {
        return state;
    }
    match running_process_names() {
        Ok(names) if names.iter().any(|name| is_steam_process(name)) => SteamClientState::Running,
        Ok(_) => SteamClientState::Closed,
        Err(()) => SteamClientState::Unknown,
    }
}

#[cfg(feature = "qualification-fixtures")]
fn qualification_steam_client_state() -> Option<SteamClientState> {
    match std::env::var("PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE")
        .ok()?
        .as_str()
    {
        "closed" => Some(SteamClientState::Closed),
        "running" => Some(SteamClientState::Running),
        "unknown" => Some(SteamClientState::Unknown),
        _ => None,
    }
}

fn is_steam_process(name: &str) -> bool {
    name.eq_ignore_ascii_case("steam") || name.eq_ignore_ascii_case("steam.exe")
}

#[cfg(windows)]
fn running_process_names() -> Result<Vec<String>, ()> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_NO_MORE_FILES, GetLastError, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut names = Vec::new();
        if Process32FirstW(snapshot, &mut entry) == 0 {
            let _ = CloseHandle(snapshot);
            return Err(());
        }
        loop {
            let length = entry
                .szExeFile
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(entry.szExeFile.len());
            names.push(String::from_utf16_lossy(&entry.szExeFile[..length]));
            if Process32NextW(snapshot, &mut entry) == 0 {
                let error = GetLastError();
                let _ = CloseHandle(snapshot);
                return if error == ERROR_NO_MORE_FILES {
                    Ok(names)
                } else {
                    Err(())
                };
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn running_process_names() -> Result<Vec<String>, ()> {
    let proc_root = PathBuf::from(std::path::MAIN_SEPARATOR.to_string()).join("proc");
    let entries = std::fs::read_dir(proc_root).map_err(|_| ())?;
    let names = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .bytes()
                .all(|byte| byte.is_ascii_digit())
        })
        .filter_map(|entry| std::fs::read_to_string(entry.path().join("comm")).ok())
        .map(|name| name.trim().to_owned())
        .collect::<Vec<_>>();
    if names.is_empty() { Err(()) } else { Ok(names) }
}

#[cfg(not(any(windows, target_os = "linux")))]
fn running_process_names() -> Result<Vec<String>, ()> {
    Err(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(root: &std::path::Path) -> SteamEntryContext {
        let library_root = root.join("Portcove library ü");
        let cli_path = root.join("Portcove tools/portcove.exe");
        std::fs::create_dir_all(&library_root).unwrap();
        std::fs::create_dir_all(cli_path.parent().unwrap()).unwrap();
        let mut cli_bytes = b"controlled CLI fixture".to_vec();
        cli_bytes.extend_from_slice(&cli_context::cli_steam_exec_identity());
        std::fs::write(&cli_path, cli_bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cli_path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        SteamEntryContext {
            port_id: "example-port".into(),
            display_name: "Example Port".into(),
            library_id: "library-123".into(),
            library_root,
            cli: Some(cli_context::inspect_cli(&cli_path).unwrap()),
        }
    }

    #[test]
    fn consumer_review_binds_exact_profile_library_cli_and_process_observation() {
        let root = tempfile::tempdir().unwrap();
        let steam_root = root.path().join("Steam root ü");
        std::fs::create_dir_all(steam_root.join("userdata/12345/config")).unwrap();
        let review = review_entry(
            context(root.path()),
            steam_root.clone(),
            "12345".into(),
            SteamEntryOperation::AddOrRepair,
            SteamClientState::Running,
        )
        .unwrap();
        assert_eq!(review.steam_root, steam_root);
        assert_eq!(review.steam_user_id, "12345");
        assert_eq!(review.steam_client_state, SteamClientState::Running);
        assert_eq!(review.changes.len(), 1);
        assert!(review.writes_required);
        assert!(review.cli_path.unwrap().is_absolute());
        assert_eq!(review.cli_sha256.unwrap().len(), 64);
        assert_eq!(
            review.cli_product_version.as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert!(
            review
                .shortcuts_path
                .ends_with("userdata/12345/config/shortcuts.vdf")
        );
    }

    #[test]
    fn add_requires_cli_but_owned_remove_remains_reviewable_without_it() {
        let root = tempfile::tempdir().unwrap();
        let steam_root = root.path().join("Steam");
        std::fs::create_dir_all(steam_root.join("userdata/42/config")).unwrap();
        let mut context = context(root.path());
        context.cli = None;
        assert!(matches!(
            plan_entry(
                &context,
                steam_root.clone(),
                "42".into(),
                SteamEntryOperation::AddOrRepair
            ),
            Err(SteamEntryError::InvalidInput(_))
        ));
        let remove = plan_entry(
            &context,
            steam_root,
            "42".into(),
            SteamEntryOperation::Remove,
        )
        .unwrap();
        assert!(!remove.changes_required());
    }

    #[test]
    fn post_consent_revalidation_rejects_changed_host_context() {
        let root = tempfile::tempdir().unwrap();
        let steam_root = root.path().join("Steam");
        std::fs::create_dir_all(steam_root.join("userdata/42/config")).unwrap();
        let original = context(root.path());
        let request = SteamEntrySelection {
            port_id: original.port_id.clone(),
            steam_root,
            steam_user_id: "42".into(),
            operation: SteamEntryOperation::AddOrRepair,
        };
        let reviewed = plan_entry(
            &original,
            request.steam_root.clone(),
            request.steam_user_id.clone(),
            request.operation,
        )
        .unwrap();
        let mut changed = original;
        changed.library_id = "replacement-library".into();
        assert!(matches!(
            revalidate_reviewed_plan(&changed, &request, &reviewed),
            Err(SteamEntryError::Conflict(_))
        ));
        assert!(!reviewed.shortcuts_path.exists());
    }

    #[test]
    fn process_classification_ignores_web_helpers_and_matches_only_main_steam_process() {
        assert!(is_steam_process("steam.exe"));
        assert!(is_steam_process("STEAM"));
        assert!(!is_steam_process("steamwebhelper.exe"));
        assert!(!is_steam_process("portcove.exe"));
    }

    #[cfg(feature = "qualification-fixtures")]
    #[test]
    fn qualification_process_state_accepts_only_explicit_bounded_values() {
        unsafe { std::env::set_var("PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE", "closed") };
        assert_eq!(
            qualification_steam_client_state(),
            Some(SteamClientState::Closed)
        );
        unsafe { std::env::set_var("PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE", "invalid") };
        assert_eq!(qualification_steam_client_state(), None);
        unsafe { std::env::remove_var("PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE") };
    }
}
