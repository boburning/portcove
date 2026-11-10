//! Generation-bound transport for Core-built, player-reviewed bug reports.
//!
//! Core owns drafting, redaction and the link. This adapter supplies host facts
//! (version, home directory, user name) and opens the link only after the
//! webview returns the text the player reviewed. Nothing is sent by Portcove.
use crate::{
    DesktopResult, DesktopState, blocking_worker, open_host_target, service, service_at_generation,
};
use portcove_core::{
    BugReportDraft, BugReportField, BugReportInputs, BugReportLink, Platform, PortcoveService,
    ReportRedactions, bug_report_link, draft_bug_report,
};

fn environment(names: &[&str]) -> Option<String> {
    // An empty variable must not shadow the next candidate.
    names
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| !value.trim().is_empty())
}

/// The library root is the opened library's own path, so it is known even when
/// the volume is unreadable or unmounted, which is when a report is most needed.
fn redactions(service: &PortcoveService) -> ReportRedactions {
    ReportRedactions {
        home_dir: environment(&["USERPROFILE", "HOME"]),
        user_name: environment(&["USERNAME", "USER"]),
        library_root: Some(service.library().root().to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub(crate) async fn preview_bug_report(
    state: tauri::State<'_, DesktopState>,
    port_id: Option<String>,
    generation: u64,
) -> DesktopResult<BugReportDraft> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
        let doctor = service.doctor_with_preferences(preferences)?;
        let mut summary = vec![
            format!("Games in catalog: {}", doctor.catalog_port_count),
            format!("Installed games: {}", doctor.installed_port_count),
            format!(
                "Registered game-file sources: {}",
                doctor.registered_source_count
            ),
            format!("Repair items: {}", doctor.repair.items.len()),
        ];
        let unavailable = doctor
            .host_tools
            .iter()
            .filter(|tool| !matches!(tool.state, portcove_core::HostToolState::Available))
            .map(|tool| tool.id.as_str())
            .collect::<Vec<_>>();
        if !unavailable.is_empty() {
            summary.push(format!(
                "Host tools not available: {}",
                unavailable.join(", ")
            ));
        }
        let (installed_version, last_outcome, last_exit_code) = match port_id.as_deref() {
            Some(port) => {
                let status = service.status(port)?;
                let last = service.library().latest_finished_launch_session(port)?;
                (
                    status.active.map(|install| install.version),
                    last.as_ref()
                        .and_then(|session| session.outcome)
                        .map(|o| o.to_string()),
                    last.and_then(|session| session.exit_code),
                )
            }
            None => (None, None, None),
        };
        let inputs = BugReportInputs {
            portcove_version: env!("CARGO_PKG_VERSION").to_owned(),
            platform: Platform::current()?,
            port_id,
            installed_version,
            last_session_outcome: last_outcome,
            last_exit_code,
            doctor_summary: summary,
        };
        Ok(draft_bug_report(&inputs, &redactions(&service)))
    })
    .await
}

/// Builds the link from the player's final text and opens it when it fits.
/// The result always carries the clipboard text, so the caller can fall back.
#[tauri::command]
pub(crate) async fn open_bug_report(
    state: tauri::State<'_, DesktopState>,
    fields: Vec<BugReportField>,
) -> DesktopResult<BugReportLink> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let redactions = redactions(&service(&state)?);
        let link = bug_report_link(&fields, &redactions);
        if let Some(url) = &link.url {
            open_host_target(std::ffi::OsStr::new(url))?;
        }
        Ok(link)
    })
    .await
}
