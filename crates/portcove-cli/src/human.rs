use std::path::Path;

use portcove_core::{
    ActivityRecord, BackupRecord, CapabilityDocument, DoctorReport, GithubAuthSource,
    GithubAuthStatus, HostToolSource, HostToolState, InstallPlan, InstallPlanAction, LaunchBlocker,
    Platform, PortDefinition, PortPaths, PortStatus, RepairItemKind, SourceRecord,
    SourceRequirementRole, StorageSummary, SupportTier,
};
use serde::Serialize;
use serde_json::Value;

pub(crate) fn document<T: Serialize>(data: &T) -> serde_json::Result<String> {
    let mut output = String::new();
    render_value(&serde_json::to_value(data)?, 0, &mut output);
    Ok(output.trim_end().to_owned())
}

pub(crate) fn auth_status(status: &GithubAuthStatus) -> String {
    let source = match status.source {
        GithubAuthSource::Anonymous => "anonymous",
        GithubAuthSource::Environment => "environment",
        GithubAuthSource::CredentialStore => "credential store",
    };
    let mut lines = vec![
        format!(
            "GitHub: {}",
            if status.authenticated {
                status.login.as_deref().unwrap_or("authenticated")
            } else {
                "anonymous"
            }
        ),
        format!("Credential source: {source}"),
        format!(
            "Device login: {}",
            if status.device_login_available {
                "available"
            } else {
                "unavailable"
            }
        ),
    ];
    if let Some(rate) = &status.rate_limit {
        lines.push(format!(
            "API allowance: {}/{} (reset Unix time {})",
            rate.remaining, rate.limit, rate.resets_at
        ));
    }
    lines.join("\n")
}

pub(crate) fn catalog_list(ports: &[PortDefinition]) -> String {
    let rows = ports
        .iter()
        .map(|port| {
            vec![
                port.id.clone(),
                port.name.clone(),
                support_tier(port.support_tier).into(),
                port.channels
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            ]
        })
        .collect();
    format!(
        "Ports ({})\n{}",
        ports.len(),
        table(&["ID", "NAME", "TIER", "CHANNELS"], rows)
    )
}

pub(crate) fn catalog_show(port: &PortDefinition) -> String {
    format!(
        "{} ({})\nSupport: {}\nChannels: {}\nPlatforms: {}\nSource: {}\nProject: {}\n{}",
        clean(&port.name),
        clean(&port.id),
        support_tier(port.support_tier),
        port.channels
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", "),
        port.platforms
            .iter()
            .map(|platform| platform_name(*platform))
            .collect::<Vec<_>>()
            .join(", "),
        clean(port.source_profile.as_deref().unwrap_or("none")),
        clean(&port.project_url),
        clean(&port.summary),
    )
}

pub(crate) fn backup_list(port_id: &str, backups: &[BackupRecord]) -> String {
    if backups.is_empty() {
        return format!("No backups for {}.", clean(port_id));
    }
    let rows = backups
        .iter()
        .map(|backup| {
            vec![
                backup.id.clone(),
                backup.created_at.to_string(),
                backup.file_count.to_string(),
                format_bytes(backup.size),
                backup.path.display().to_string(),
            ]
        })
        .collect();
    format!(
        "Backups for {} ({})\n{}",
        clean(port_id),
        backups.len(),
        table(&["ID", "CREATED (UNIX)", "FILES", "SIZE", "PATH"], rows)
    )
}

pub(crate) fn source_list(sources: &[SourceRecord]) -> String {
    if sources.is_empty() {
        return "No registered sources.".into();
    }
    let rows = sources
        .iter()
        .map(|source| {
            vec![
                source.profile_id.clone(),
                format_bytes(source.storage_size),
                source.updated_at.to_string(),
                source.path.display().to_string(),
            ]
        })
        .collect();
    format!(
        "Registered sources ({})\n{}",
        sources.len(),
        table(&["PROFILE", "SIZE", "UPDATED (UNIX)", "PATH"], rows)
    )
}

pub(crate) fn status(status: &PortStatus) -> String {
    statuses(std::slice::from_ref(status))
}

pub(crate) fn statuses(statuses: &[PortStatus]) -> String {
    if statuses.is_empty() {
        return "No catalog ports.".into();
    }
    let rows = statuses
        .iter()
        .map(|status| {
            vec![
                status.port_id.clone(),
                status.channel.to_string(),
                status.update_policy.to_string(),
                status
                    .active
                    .as_ref()
                    .map_or_else(|| "-".into(), |install| install.version.clone()),
                status
                    .staged
                    .as_ref()
                    .map_or_else(|| "-".into(), |install| install.version.clone()),
                readiness(status),
            ]
        })
        .collect();
    format!(
        "Status ({})\n{}",
        statuses.len(),
        table(
            &["PORT", "CHANNEL", "POLICY", "ACTIVE", "STAGED", "READINESS"],
            rows,
        )
    )
}

pub(crate) fn activities(records: &[ActivityRecord]) -> String {
    if records.is_empty() {
        return "No activity records.".into();
    }
    let rows = records
        .iter()
        .map(|record| {
            vec![
                record.status.to_string(),
                record.operation.to_string(),
                record.target_id.as_deref().unwrap_or("library").into(),
                record.started_at.to_string(),
                record.message.as_deref().unwrap_or("").into(),
            ]
        })
        .collect();
    format!(
        "Recent activity ({})\n{}",
        records.len(),
        table(
            &["STATUS", "OPERATION", "TARGET", "STARTED (UNIX)", "MESSAGE"],
            rows,
        )
    )
}

pub(crate) fn storage(summary: &StorageSummary) -> String {
    format!(
        "Library storage\nRoot: {}\nAvailable: {}\nTotal: {}",
        clean(&summary.library_root.display().to_string()),
        format_bytes(summary.volume_available_bytes),
        format_bytes(summary.volume_total_bytes),
    )
}

pub(crate) fn doctor(report: &DoctorReport) -> String {
    let tool_rows = report
        .host_tools
        .iter()
        .map(|tool| {
            vec![
                tool.id.clone(),
                host_tool_state(tool.state).into(),
                tool.source.map_or("-".into(), |source| match source {
                    HostToolSource::Environment => "environment".into(),
                    HostToolSource::Discovery => "discovery".into(),
                }),
                tool.path
                    .as_deref()
                    .map_or_else(|| "-".into(), |path| path.display().to_string()),
            ]
        })
        .collect();
    let repairs = if report.repair.items.is_empty() {
        "Repair review: no items".into()
    } else {
        let rows = report
            .repair
            .items
            .iter()
            .map(|item| {
                vec![
                    repair_kind(item.kind).into(),
                    item.port_id.as_deref().unwrap_or("-").into(),
                    item.message.clone(),
                    item.proposed_action.clone(),
                ]
            })
            .collect();
        format!(
            "Repair review ({})\n{}",
            report.repair.items.len(),
            table(&["KIND", "PORT", "MESSAGE", "PROPOSED ACTION"], rows)
        )
    };
    format!(
        "Portcove doctor\nPlatform: {}\nCatalog: {} ports; {} installed; {} sources\n{}\nHost tools\n{}\n{}",
        platform_name(report.platform),
        report.catalog_port_count,
        report.installed_port_count,
        report.registered_source_count,
        storage(&report.library),
        table(&["TOOL", "STATE", "SOURCE", "PATH"], tool_rows),
        repairs,
    )
}

pub(crate) fn plan(plan: &InstallPlan) -> String {
    let requirements = if plan.source_requirements.is_empty() {
        "none".into()
    } else {
        plan.source_requirements
            .iter()
            .map(|requirement| {
                format!(
                    "{} ({}, {})",
                    clean(&requirement.label),
                    match requirement.role {
                        SourceRequirementRole::GameSource => "game source",
                        SourceRequirementRole::Bios => "BIOS",
                    },
                    if requirement.registered {
                        "registered"
                    } else {
                        "needed"
                    },
                )
            })
            .collect::<Vec<_>>()
            .join("; ")
    };
    let runtime = plan.bundled_runtime.as_ref().map_or_else(
        || "none".to_owned(),
        |runtime| {
            format!(
                "{} ({})",
                clean(&runtime.asset.name),
                format_bytes(runtime.asset.size)
            )
        },
    );
    format!(
        "Install plan for {}\nAction: {}\nChannel: {}\nPlatform: {}\nRelease: {}\nAsset: {} ({})\nBundled runtime: {}\nTotal download: {}\nSources: {}\nAvailable storage: {}",
        clean(&plan.port_id),
        install_action(plan.action),
        plan.channel,
        platform_name(plan.platform),
        clean(&plan.release.version),
        clean(&plan.release.asset.name),
        format_bytes(plan.release.asset.size),
        runtime,
        format_bytes(plan.download_bytes),
        requirements,
        format_bytes(plan.storage.volume_available_bytes),
    )
}

pub(crate) fn paths(paths: &PortPaths) -> String {
    format!(
        "Paths for {}\nLibrary: {}\nPersistent data: {}\nActive: {}\nPrevious: {}\nStaged: {}",
        clean(&paths.port_id),
        clean(&paths.library_root.display().to_string()),
        clean(&paths.user_data_root.display().to_string()),
        optional_path(paths.active_install_root.as_deref()),
        optional_path(paths.previous_install_root.as_deref()),
        optional_path(paths.staged_install_root.as_deref()),
    )
}

pub(crate) fn capabilities(capabilities: &CapabilityDocument) -> String {
    format!(
        "{} {} capabilities\nSchema: {}\nPlatforms: {}\nMachine formats: {}\nRaw streams: {}\nFailure-isolated batches: {}\nPort locking: {}",
        clean(&capabilities.product),
        clean(&capabilities.product_version),
        capabilities.schema_version,
        capabilities.platforms.len(),
        capabilities.machine_formats.join(", "),
        capabilities.raw_stream_commands.join(", "),
        capabilities.failure_isolated_batches.join(", "),
        clean(&capabilities.port_operation_locking),
    )
}

fn render_value(value: &Value, indent: usize, output: &mut String) {
    let padding = " ".repeat(indent);
    match value {
        Value::Object(fields) => {
            if fields.is_empty() {
                output.push_str(&format!("{padding}(none)\n"));
            }
            for (key, value) in fields {
                if value.is_array() || value.is_object() {
                    output.push_str(&format!("{padding}{}:\n", human_key(key)));
                    render_value(value, indent + 2, output);
                } else {
                    output.push_str(&format!("{padding}{}: {}\n", human_key(key), scalar(value)));
                }
            }
        }
        Value::Array(items) => {
            if items.is_empty() {
                output.push_str(&format!("{padding}(none)\n"));
            }
            for item in items {
                if item.is_array() || item.is_object() {
                    output.push_str(&format!("{padding}-\n"));
                    render_value(item, indent + 2, output);
                } else {
                    output.push_str(&format!("{padding}- {}\n", scalar(item)));
                }
            }
        }
        value => output.push_str(&format!("{padding}{}\n", scalar(value))),
    }
}

fn scalar(value: &Value) -> String {
    match value {
        Value::Null => "none".into(),
        Value::Bool(value) => {
            if *value {
                "yes".into()
            } else {
                "no".into()
            }
        }
        Value::Number(value) => value.to_string(),
        Value::String(value) => clean(value),
        _ => unreachable!("compound JSON values are rendered recursively"),
    }
}

fn human_key(key: &str) -> String {
    let text = key.replace('_', " ");
    let mut characters = text.chars();
    characters.next().map_or(text.clone(), |first| {
        first.to_uppercase().chain(characters).collect()
    })
}

fn table(headers: &[&str], rows: Vec<Vec<String>>) -> String {
    let sanitized = rows
        .into_iter()
        .map(|row| row.into_iter().map(|cell| clean(&cell)).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let mut widths = headers
        .iter()
        .map(|header| header.chars().count())
        .collect::<Vec<_>>();
    for row in &sanitized {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(cell.chars().count());
        }
    }
    let format_row = |row: Vec<String>| {
        row.into_iter()
            .enumerate()
            .map(|(index, cell)| {
                if index + 1 == widths.len() {
                    cell
                } else {
                    format!("{cell:<width$}", width = widths[index])
                }
            })
            .collect::<Vec<_>>()
            .join("  ")
    };
    let mut lines = vec![format_row(
        headers.iter().map(|header| (*header).into()).collect(),
    )];
    lines.push(format_row(
        widths.iter().map(|width| "-".repeat(*width)).collect(),
    ));
    lines.extend(sanitized.into_iter().map(format_row));
    lines.join("\n")
}

fn clean(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| match character {
            '\r' | '\n' | '\t' => Some(' '),
            character if character.is_control() => None,
            character => Some(character),
        })
        .collect::<String>()
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn readiness(status: &PortStatus) -> String {
    let Some(readiness) = &status.readiness else {
        return if status.active.is_some() {
            "unknown"
        } else {
            "not installed"
        }
        .into();
    };
    if readiness.launchable {
        return if readiness.pending_setup {
            "ready; setup pending"
        } else {
            "ready"
        }
        .into();
    }
    readiness
        .blockers
        .iter()
        .map(|blocker| match blocker {
            LaunchBlocker::MissingSource => "missing source",
            LaunchBlocker::UnreadableSource => "unreadable source",
            LaunchBlocker::ChangedSource => "changed source",
            LaunchBlocker::MissingBios => "missing BIOS",
            LaunchBlocker::UnreadableBios => "unreadable BIOS",
            LaunchBlocker::ChangedBios => "changed BIOS",
            LaunchBlocker::MissingRuntime => "needs verified runtime (update port)",
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn support_tier(tier: SupportTier) -> &'static str {
    match tier {
        SupportTier::Stable => "stable",
        SupportTier::Beta => "beta",
        SupportTier::Rolling => "rolling",
    }
}

fn platform_name(platform: Platform) -> &'static str {
    match platform {
        Platform::WindowsX86_64 => "windows-x86_64",
        Platform::LinuxX86_64 => "linux-x86_64",
        Platform::MacosX86_64 => "macos-x86_64",
        Platform::MacosAarch64 => "macos-aarch64",
    }
}

fn host_tool_state(state: HostToolState) -> &'static str {
    match state {
        HostToolState::Available => "available",
        HostToolState::Missing => "missing",
        HostToolState::Misconfigured => "misconfigured",
    }
}

fn repair_kind(kind: RepairItemKind) -> &'static str {
    match kind {
        RepairItemKind::PartialOperation => "partial operation",
        RepairItemKind::CleanupPending => "cleanup pending",
        RepairItemKind::OrphanedFinalDirectory => "orphaned directory",
        RepairItemKind::MissingRegisteredPath => "missing path",
    }
}

fn install_action(action: InstallPlanAction) -> &'static str {
    match action {
        InstallPlanAction::AlreadyActive => "already active",
        InstallPlanAction::UseStaged => "activate staged release",
        InstallPlanAction::ReuseRetained => "reuse retained release",
        InstallPlanAction::BlockedUnverified => "blocked by unverified install",
        InstallPlanAction::Download => "download",
    }
}

fn optional_path(path: Option<&Path>) -> String {
    path.map_or_else(|| "-".into(), |path| clean(&path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use portcove_core::{BackupRecord, StorageSummary};

    use super::{backup_list, document, storage, table};

    #[test]
    fn read_renderers_have_stable_human_snapshots() {
        assert_eq!(backup_list("sample", &[]), "No backups for sample.");
        assert_eq!(
            backup_list(
                "sample",
                &[BackupRecord {
                    id: "backup-1".into(),
                    port_id: "sample".into(),
                    path: PathBuf::from("C:/Portcove/backups/backup-1"),
                    created_at: 42,
                    file_count: 3,
                    size: 2048,
                    sha256: "a".repeat(64),
                }],
            ),
            "Backups for sample (1)\nID        CREATED (UNIX)  FILES  SIZE     PATH\n--------  --------------  -----  -------  ----------------------------\nbackup-1  42              3      2.0 KiB  C:/Portcove/backups/backup-1",
        );
        assert_eq!(
            storage(&StorageSummary {
                library_root: PathBuf::from("C:/Portcove"),
                volume_total_bytes: 2 * 1024 * 1024,
                volume_available_bytes: 1024 * 1024,
            }),
            "Library storage\nRoot: C:/Portcove\nAvailable: 1.0 MiB\nTotal: 2.0 MiB",
        );
    }

    #[test]
    fn tables_and_generic_documents_neutralize_terminal_controls() {
        assert_eq!(
            table(
                &["NAME", "VALUE"],
                vec![vec!["unsafe\u{1b}[31m".into(), "two\nlines".into()]]
            ),
            "NAME        VALUE\n----------  ---------\nunsafe[31m  two lines",
        );
        assert_eq!(
            document(&serde_json::json!({"some_value": "line\nnext", "ready": true})).unwrap(),
            "Ready: yes\nSome value: line next",
        );
    }
}
