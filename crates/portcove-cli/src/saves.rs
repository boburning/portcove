//! Thin portable-save adapter. Core owns classification, review, consent,
//! locking, the safety backup and recovery.
use crate::*;
use portcove_core::{
    LocalDataEntry, PersistentDataRole, PortableSaveBlocker, PortableSaveExportPreview,
    PortableSaveExportResult, PortableSaveFileEffect, PortableSaveImportOptions,
    PortableSaveImportPreview, PortableSaveImportResult, PortableSaveRelation,
};

pub(crate) fn name(command: &SavesCommand) -> &'static str {
    match command {
        SavesCommand::ExportPreview { .. } => "saves.export-preview",
        SavesCommand::Export { .. } => "saves.export",
        SavesCommand::ImportPreview { .. } => "saves.import-preview",
        SavesCommand::Import { .. } => "saves.import",
    }
}

fn options(choices: &SaveImportChoiceArgs) -> PortableSaveImportOptions {
    PortableSaveImportOptions {
        remove_local_only_saves: choices.remove_local_only_saves,
        replace_diverged_progress: choices.replace_diverged_progress,
    }
}

pub(crate) fn execute(
    command: SavesCommand,
    service: &PortcoveService,
    mode: OutputMode,
    non_interactive: bool,
) -> Result<()> {
    let command_name = name(&command);
    match command {
        SavesCommand::ExportPreview { port_id } => render_read_success(
            mode,
            command_name,
            service.preview_portable_save_export(&port_id)?,
            export_preview,
        ),
        SavesCommand::Export {
            port_id,
            output,
            expected_content,
        } => render_read_success(
            mode,
            command_name,
            service.export_portable_saves(&port_id, &output, &expected_content)?,
            exported,
        ),
        SavesCommand::ImportPreview {
            port_id,
            file,
            choices,
        } => render_read_success(
            mode,
            command_name,
            service.preview_portable_save_import(&port_id, &file, options(&choices))?,
            import_preview,
        ),
        SavesCommand::Import {
            port_id,
            file,
            choices,
            expected_preview,
            yes,
        } => {
            let options = options(&choices);
            let preview = service.preview_portable_save_import(&port_id, &file, options)?;
            if mode == OutputMode::Human {
                println!("{}", import_preview(&preview));
                io::stdout().flush()?;
            }
            if preview.preview_sha256 != expected_preview {
                return Err(PortcoveError::conflict(
                    "the saves or the selected file changed after review; review the import again",
                ));
            }
            if !confirmation(
                &format!(
                    "Import these saves into {}? Current saves and settings are backed up first.",
                    human::port_name(service.catalog(), &port_id)
                ),
                yes,
                non_interactive,
            )? {
                return render_backup_cancellation(mode, command_name, "Save import");
            }
            let authorization = service.authorize_portable_save_import(
                &port_id,
                &file,
                options,
                &expected_preview,
            )?;
            render_read_success(
                mode,
                command_name,
                service.import_portable_saves(&port_id, &file, options, &authorization.token)?,
                imported,
            )
        }
    }
}

fn role(role: PersistentDataRole) -> &'static str {
    match role {
        PersistentDataRole::PortableProgress => "save progress",
        PersistentDataRole::DeviceConfiguration => "this device's settings",
        PersistentDataRole::Mods => "mods",
        PersistentDataRole::GeneratedContent => "created by the game",
        PersistentDataRole::OriginalDerived => "made from your original game files",
        PersistentDataRole::LocalPlayerData => "player data not qualified to move",
        PersistentDataRole::PortcoveMetadata => "Portcove sync record",
        PersistentDataRole::Unknown => "not recognized",
    }
}

fn blocker(blocker: PortableSaveBlocker) -> &'static str {
    match blocker {
        PortableSaveBlocker::Unqualified => {
            "Portcove has not qualified moving saves for this game."
        }
        PortableSaveBlocker::NotInstalled => "Install the game with Portcove first.",
        PortableSaveBlocker::UnsupportedVersion => {
            "This game version is not qualified for moving saves."
        }
        PortableSaveBlocker::UnsupportedPlatform => {
            "Moving saves is not qualified on this kind of device."
        }
        PortableSaveBlocker::VersionMismatch => {
            "The saves come from a different game version. Use the same version on both devices."
        }
        PortableSaveBlocker::DifferentGame => "These saves belong to a different game.",
        PortableSaveBlocker::Busy => {
            "The game is running or Portcove is busy with it. Close it and try again."
        }
        PortableSaveBlocker::NoPortableProgress => "There are no saves to export yet.",
        PortableSaveBlocker::ConflictNeedsChoice => {
            "Both devices have new progress. Add --replace-diverged-progress to use the file's progress; this device's progress stays in a backup."
        }
        PortableSaveBlocker::AlreadyCurrent => "This device already has these saves.",
    }
}

fn stays_local(entries: &[LocalDataEntry]) -> String {
    if entries.is_empty() {
        return "  (nothing else)".into();
    }
    entries
        .iter()
        .map(|entry| {
            format!(
                "  {}{} — {}",
                human::clean(&entry.path),
                if entry.directory { "/" } else { "" },
                role(entry.role)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn blockers(list: &[PortableSaveBlocker]) -> String {
    if list.is_empty() {
        return String::new();
    }
    format!(
        "\nCannot continue:\n{}",
        list.iter()
            .map(|item| format!("  {}", blocker(*item)))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

fn export_preview(preview: &PortableSaveExportPreview) -> String {
    let identity = preview.identity.as_ref().map_or_else(
        || "unknown (not installed)".to_owned(),
        |identity| {
            format!(
                "{} {} on {}",
                human::clean(&identity.port_id),
                human::clean(&identity.version),
                human::platform_name(identity.platform)
            )
        },
    );
    let files = if preview.files.is_empty() {
        "  (none)".to_owned()
    } else {
        preview
            .files
            .iter()
            .map(|file| format!("  {} ({} bytes)", human::clean(&file.path), file.size))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "Save export review\nGame version: {identity}\nMoves:\n{files}\nStays on this device:\n{}\nContent SHA-256: {}{}",
        stays_local(&preview.stays_local),
        preview.content_sha256.as_deref().unwrap_or("none"),
        blockers(&preview.blockers),
    )
}

fn exported(result: &PortableSaveExportResult) -> String {
    format!(
        "Saved {} save file(s) to {}.\nContent SHA-256: {}",
        result.files.len(),
        human::clean(&result.path.display().to_string()),
        result.content_sha256
    )
}

fn import_preview(preview: &PortableSaveImportPreview) -> String {
    let relation = match preview.relation {
        PortableSaveRelation::NoLocalProgress => "This device has no saves for this game yet.",
        PortableSaveRelation::AlreadyCurrent => "This device already has these saves.",
        PortableSaveRelation::Continues => "The file continues from this device's saves.",
        PortableSaveRelation::Diverged => {
            "Both devices have progress the other does not have. Choose which to use; nothing is lost."
        }
    };
    let changes = preview
        .changes
        .iter()
        .map(|change| {
            let effect = match change.effect {
                PortableSaveFileEffect::Add => "add",
                PortableSaveFileEffect::Replace => "replace",
                PortableSaveFileEffect::Unchanged => "unchanged",
                PortableSaveFileEffect::Remove => "remove",
                PortableSaveFileEffect::KeepLocal => "keep (not in the file)",
            };
            format!("  {} — {effect}", human::clean(&change.path))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let destination = preview.destination.as_ref().map_or_else(
        || "not installed".to_owned(),
        |identity| {
            format!(
                "{} on {}",
                human::clean(&identity.version),
                human::platform_name(identity.platform)
            )
        },
    );
    format!(
        "Save import review\nFile: {} {} from {}\nThis device: {destination}\n{relation}\nChanges:\n{changes}\nStays on this device:\n{}\nSafety backup first: {}\nReview SHA-256: {}{}",
        human::clean(&preview.source.port_id),
        human::clean(&preview.source.version),
        human::platform_name(preview.source.platform),
        stays_local(&preview.stays_local),
        if preview.safety_backup_will_be_created {
            "yes"
        } else {
            "no (no current data)"
        },
        preview.preview_sha256,
        blockers(&preview.blockers),
    )
}

fn imported(result: &PortableSaveImportResult) -> String {
    format!(
        "Saves imported.\nImported progress is also kept as backup {}.{}",
        human::clean(&result.import_snapshot.id),
        result.safety_backup.as_ref().map_or_else(String::new, |safety| format!(
            "\nThe previous saves and settings are in backup {}. Restore it with `portcove backup restore` if needed.",
            human::clean(&safety.id)
        )),
    )
}
