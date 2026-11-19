//! Generation-bound transport for Core-built, player-reviewed bug reports and
//! feedback.
//!
//! Core owns drafting, redaction and the link. This adapter supplies host facts
//! (version, home directory, user name) and opens the link only after the
//! webview returns the text the player reviewed. Nothing is sent by Portcove.
use crate::{
    DesktopResult, DesktopState, blocking_worker, open_host_target, service, service_at_generation,
};
use portcove_core::{
    BugReportDraft, BugReportField, BugReportInputs, BugReportLink, Platform, PortcoveService,
    ReportKind, ReportRedactions, SubmittedReport, draft_report, report_issue, report_link,
};

fn environment(names: &[&str]) -> Option<String> {
    first_non_empty(names, |name| std::env::var(name).ok())
}

/// The first candidate that is set to something other than blank. An empty
/// variable must not shadow the next candidate.
fn first_non_empty(names: &[&str], lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
    names
        .iter()
        .filter_map(|name| lookup(name))
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
    kind: Option<ReportKind>,
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
        Ok(draft_report(
            kind.unwrap_or_default(),
            &inputs,
            &redactions(&service),
        ))
    })
    .await
}

/// Builds the link from the player's final text and opens it when it fits,
/// unless the player asked to copy the text instead. The result always carries
/// the clipboard text, so the caller can fall back.
#[tauri::command]
pub(crate) async fn open_bug_report(
    state: tauri::State<'_, DesktopState>,
    fields: Vec<BugReportField>,
    kind: Option<ReportKind>,
    copy_only: Option<bool>,
) -> DesktopResult<BugReportLink> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let redactions = redactions(&service(&state)?);
        let link = report_link(kind.unwrap_or_default(), &fields, &redactions);
        if let Some(url) = link.url.as_ref().filter(|_| copy_only != Some(true)) {
            open_host_target(std::ffi::OsStr::new(url))?;
        }
        Ok(link)
    })
    .await
}

/// Files the player's final text as an issue under their GitHub sign-in. Core
/// builds and redacts the issue and holds the token; the webview sees only the
/// created issue's number and link.
#[tauri::command]
pub(crate) async fn submit_report(
    state: tauri::State<'_, DesktopState>,
    fields: Vec<BugReportField>,
    kind: ReportKind,
) -> DesktopResult<SubmittedReport> {
    let state = state.inner().clone();
    let issue = blocking_worker({
        let state = state.clone();
        move || {
            let redactions = redactions(&service(&state)?);
            Ok(report_issue(kind, &fields, &redactions)?)
        }
    })
    .await?;
    let request = crate::ready(&state)?.github.submit_report(&issue);
    Ok(request.await?)
}

#[cfg(test)]
mod tests {
    use super::first_non_empty;
    use std::collections::HashMap;

    fn lookup<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        let map: HashMap<_, _> = pairs.iter().copied().collect();
        move |name| map.get(name).map(|value| (*value).to_owned())
    }

    #[test]
    fn an_empty_or_blank_variable_does_not_shadow_the_next_candidate() {
        let names = ["USERPROFILE", "HOME"];
        assert_eq!(
            first_non_empty(
                &names,
                lookup(&[("USERPROFILE", ""), ("HOME", "/home/alice")])
            ),
            Some("/home/alice".to_owned())
        );
        assert_eq!(
            first_non_empty(
                &names,
                lookup(&[("USERPROFILE", "  "), ("HOME", "/home/alice")])
            ),
            Some("/home/alice".to_owned())
        );
    }

    #[test]
    fn the_first_usable_candidate_wins_and_nothing_set_is_none() {
        let names = ["USERPROFILE", "HOME"];
        assert_eq!(
            first_non_empty(
                &names,
                lookup(&[("USERPROFILE", r"C:\Users\Alice"), ("HOME", "/home/alice")])
            ),
            Some(r"C:\Users\Alice".to_owned())
        );
        assert_eq!(first_non_empty(&names, lookup(&[])), None);
        assert_eq!(first_non_empty(&names, lookup(&[("HOME", "")])), None);
    }
}
