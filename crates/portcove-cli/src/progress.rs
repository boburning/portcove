use portcove_core::{ActivityTargetKind, Catalog, OperationEvent, OperationEventKind};

use crate::human;

pub(crate) struct HumanProgress<'a> {
    interactive: bool,
    catalog: Option<&'a Catalog>,
    phase: Option<String>,
    latest: Option<(u64, Option<u64>)>,
    completed_line: bool,
    inline_line: bool,
}

impl<'a> HumanProgress<'a> {
    #[cfg(test)]
    pub(crate) fn new(interactive: bool) -> Self {
        Self::create(interactive, None)
    }

    pub(crate) fn with_catalog(interactive: bool, catalog: &'a Catalog) -> Self {
        Self::create(interactive, Some(catalog))
    }

    fn create(interactive: bool, catalog: Option<&'a Catalog>) -> Self {
        Self {
            interactive,
            catalog,
            phase: None,
            latest: None,
            completed_line: false,
            inline_line: false,
        }
    }

    pub(crate) fn render(&mut self, event: &OperationEvent) -> String {
        let mut output = String::new();
        match &event.event {
            OperationEventKind::Progress {
                phase,
                completed,
                total,
            } => {
                if self.phase.as_deref() != Some(phase) {
                    output.push_str(&self.end_phase());
                    self.phase = Some(phase.clone());
                    self.completed_line = false;
                    if !self.interactive {
                        output.push_str(&format!("{}: started\n", human::phase_name(phase)));
                    }
                }
                self.latest = Some((*completed, *total));
                if self.interactive {
                    output.push_str(&format!("\r{}", progress_line(phase, *completed, *total)));
                    self.inline_line = true;
                } else if total.is_some_and(|total| *completed >= total) && !self.completed_line {
                    output.push_str(&format!("{}\n", progress_line(phase, *completed, *total)));
                    self.completed_line = true;
                }
            }
            OperationEventKind::Finished { .. } => output.push_str(&self.end_phase()),
            OperationEventKind::SourceCandidate {
                profile_id,
                path,
                sha256,
                size,
            } => {
                output.push_str(&self.break_inline_line());
                let profile = self
                    .catalog
                    .filter(|catalog| catalog.source_profile(profile_id).is_ok())
                    .map_or_else(
                        || "Selected game files".to_owned(),
                        |catalog| human::profile_name(catalog, profile_id),
                    );
                output.push_str(&format!(
                    "Exact candidate for {profile}: {}\nSize: {}\nSHA-256: {}\nCandidate only; discovery does not register these files.\n",
                    human::clean(&path.display().to_string()), human::format_bytes(*size), human::clean(sha256),
                ));
            }
            OperationEventKind::Message { message, .. } => {
                output.push_str(&self.break_inline_line());
                output.push_str(&human::clean(&portcove_core::redact_diagnostic_text(
                    message,
                )));
                output.push('\n');
            }
            OperationEventKind::Started => {
                output.push_str(&self.end_phase());
                output.push_str(human::operation_event_name(&event.operation));
                if let Some(target) = &event.target {
                    let name = match (target.kind, self.catalog) {
                        (ActivityTargetKind::Port, Some(catalog))
                            if catalog.port(&target.id).is_ok() =>
                        {
                            human::port_name(catalog, &target.id)
                        }
                        (ActivityTargetKind::Source, Some(catalog))
                            if catalog.source_profile(&target.id).is_ok() =>
                        {
                            human::profile_name(catalog, &target.id)
                        }
                        (ActivityTargetKind::Library, _) => "Selected library".into(),
                        (ActivityTargetKind::Port, _) => "Selected port".into(),
                        (ActivityTargetKind::Source, _) => "Selected game files".into(),
                    };
                    output.push_str(&format!(": {name}"));
                }
                output.push('\n');
            }
        }
        output
    }

    fn break_inline_line(&mut self) -> String {
        if self.inline_line {
            self.inline_line = false;
            "\n".into()
        } else {
            String::new()
        }
    }

    fn end_phase(&mut self) -> String {
        let mut output = self.break_inline_line();
        if !self.interactive
            && !self.completed_line
            && let (Some(phase), Some((completed, total))) = (&self.phase, self.latest)
        {
            output.push_str(&format!("{}\n", progress_line(phase, completed, total)));
        }
        self.phase = None;
        self.latest = None;
        output
    }
}

fn progress_line(phase: &str, completed: u64, total: Option<u64>) -> String {
    // Current Core download/copy progress counts bytes. Unknown future phases
    // have no known unit; never label an arbitrary counter as a byte count.
    let bytes = matches!(phase, "download" | "copy" | "psx-toolchain-download");
    let count = |value| {
        if bytes {
            human::format_bytes(value)
        } else {
            value.to_string()
        }
    };
    let units = if bytes { "" } else { " units" };
    let count = match total {
        Some(total) => format!("{} of {}{units}", count(completed), count(total)),
        None => format!("{}{units} (total unknown)", count(completed)),
    };
    format!("{}: {count}", human::phase_name(phase))
}

#[cfg(test)]
mod tests {
    use super::*;
    use portcove_core::{OperationCoordinator, OperationResult};

    #[test]
    fn redirected_unknown_totals_and_phases_are_bounded_and_do_not_claim_bytes() {
        let operation = OperationCoordinator::new("check_update", None);
        let mut progress = HumanProgress::new(false);
        let mut text = progress.render(&operation.progress("future-\u{1b}[2J-phase", 0, None));
        for count in 1..100 {
            text.push_str(&progress.render(&operation.progress(
                "future-\u{1b}[2J-phase",
                count,
                None,
            )));
        }
        text.push_str(&progress.render(&operation.finished(OperationResult::Cancelled)));
        assert_eq!(text.lines().count(), 2);
        assert!(text.contains("99 units (total unknown)"));
        assert!(!text.contains('\r') && !text.contains('\u{1b}'));
        assert!(!text.contains("bytes"));
    }

    #[test]
    fn progress_uses_catalog_identity_and_iec_sizes_without_changing_events() {
        let catalog = Catalog::embedded().unwrap();
        let port = &catalog.ports()[0];
        let operation = OperationCoordinator::new(
            "check_update",
            Some(portcove_core::OperationTarget {
                kind: ActivityTargetKind::Port,
                id: port.id.clone(),
            }),
        );
        let mut progress = HumanProgress::with_catalog(false, &catalog);
        let event = operation.started();
        let original = serde_json::to_value(&event).unwrap();
        let start = progress.render(&event);
        assert!(start.contains(&format!("{} ({})", port.name, port.id)));
        let progress_event = operation.progress("download", 1024, Some(2048));
        let mut text = progress.render(&progress_event);
        text.push_str(&progress.render(&operation.finished(OperationResult::Failed)));
        assert!(text.contains("1.0 KiB of 2.0 KiB"));
        assert_eq!(serde_json::to_value(&event).unwrap(), original);
        assert_eq!(
            progress_event.event,
            OperationEventKind::Progress {
                phase: "download".into(),
                completed: 1024,
                total: Some(2048)
            }
        );
    }

    #[test]
    fn zero_length_progress_and_terminal_controls_are_safe() {
        let operation = OperationCoordinator::new("install", None);
        let mut progress = HumanProgress::new(false);
        let mut text = progress.render(&operation.progress("copy", 0, Some(0)));
        text.push_str(&progress.render(&operation.message("info", "hello\u{1b}[2J\rworld")));
        text.push_str(&progress.render(&operation.finished(OperationResult::Succeeded)));
        assert!(text.contains("0 B of 0 B"));
        assert!(!text.contains('\r') && !text.contains('\u{1b}'));
    }
}
