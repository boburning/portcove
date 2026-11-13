//! Host presentation of Core-owned portable-save export and import. Core owns
//! classification, review fingerprints, consent, locking, the safety backup and
//! recovery; the host only reads files the player picked and asks for native
//! confirmation of a reviewed import.
use std::path::PathBuf;

use crate::{
    DesktopResult, DesktopState, blocking_worker, confirm_destructive, service_at_generation,
};
use portcove_core::{
    PortableSaveExportPreview, PortableSaveExportResult, PortableSaveImportOptions,
    PortableSaveImportPreview, PortableSaveImportResult, PortableSaveRelation, PortcoveError,
};

fn options(
    remove_local_only_saves: bool,
    replace_diverged_progress: bool,
) -> PortableSaveImportOptions {
    PortableSaveImportOptions {
        remove_local_only_saves,
        replace_diverged_progress,
    }
}

#[tauri::command]
pub(crate) async fn preview_portable_save_export(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    generation: u64,
) -> DesktopResult<PortableSaveExportPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        service
            .preview_portable_save_export(&port_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn export_portable_saves(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    expected_content: String,
    generation: u64,
) -> DesktopResult<PortableSaveExportResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        service
            .export_portable_saves(&port_id, &path, &expected_content)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_portable_save_import(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    remove_local_only_saves: bool,
    replace_diverged_progress: bool,
    generation: u64,
) -> DesktopResult<PortableSaveImportPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        service
            .preview_portable_save_import(
                &port_id,
                &path,
                options(remove_local_only_saves, replace_diverged_progress),
            )
            .map_err(Into::into)
    })
    .await
}

/// Re-review, ask for native confirmation of exactly that review, then apply.
/// A declined confirmation returns `None` and changes nothing.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn import_portable_saves(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    remove_local_only_saves: bool,
    replace_diverged_progress: bool,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<PortableSaveImportResult>> {
    let review = preview_portable_save_import(
        state.clone(),
        port_id.clone(),
        path.clone(),
        remove_local_only_saves,
        replace_diverged_progress,
        generation,
    )
    .await?;
    if review.preview_sha256 != expected_preview {
        return Err(PortcoveError::conflict(
            "The saves or the selected file changed after review. Review the import again.",
        )
        .into());
    }
    let (title, message, action) = import_consent(&review);
    if !confirm_destructive(&app, title, message, action).await {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let options = options(remove_local_only_saves, replace_diverged_progress);
        let authorization =
            service.authorize_portable_save_import(&port_id, &path, options, &expected_preview)?;
        service
            .import_portable_saves(&port_id, &path, options, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

fn platform_name(platform: portcove_core::Platform) -> &'static str {
    match platform {
        portcove_core::Platform::WindowsX86_64 => "Windows",
        portcove_core::Platform::LinuxX86_64 => "Linux",
        portcove_core::Platform::MacosX86_64 | portcove_core::Platform::MacosAarch64 => "macOS",
    }
}

fn import_consent(review: &PortableSaveImportPreview) -> (&'static str, String, &'static str) {
    let changed = review
        .changes
        .iter()
        .filter(|change| {
            !matches!(
                change.effect,
                portcove_core::PortableSaveFileEffect::Unchanged
                    | portcove_core::PortableSaveFileEffect::KeepLocal
            )
        })
        .count();
    let relation = match review.relation {
        PortableSaveRelation::Diverged => {
            "Portcove can't confirm these saves continue from this device's saves."
        }
        PortableSaveRelation::Continues => "These saves continue from this device's saves.",
        PortableSaveRelation::NoLocalProgress => "This device has no saves for this game yet.",
        PortableSaveRelation::AlreadyCurrent => "This device already has these saves.",
    };
    let safety = if review.safety_backup_will_be_created {
        "Portcove backs up this device's current saves and settings first, so you can restore them."
    } else {
        "There are no current saves or settings on this device to back up."
    };
    (
        "Import saves",
        format!(
            "Import saves from {} (game version {}) into this device?\n\n{relation}\n{changed} save {} will change. Settings, mods and other files stay as they are on this device.\n\n{safety}",
            platform_name(review.source.platform),
            review.source.version,
            if changed == 1 { "file" } else { "files" },
        ),
        "Import saves",
    )
}

#[cfg(test)]
mod tests {
    use super::import_consent;
    use portcove_core::{
        Platform, PortableSaveFile, PortableSaveFileChange, PortableSaveFileEffect,
        PortableSaveIdentity, PortableSaveImportPreview, PortableSaveRelation,
    };

    fn review(relation: PortableSaveRelation, safety: bool) -> PortableSaveImportPreview {
        let file = PortableSaveFile {
            path: "Save/file1.sav".into(),
            size: 2,
            sha256: "a".repeat(64),
        };
        PortableSaveImportPreview {
            port_id: "shipwright".into(),
            source: PortableSaveIdentity {
                port_id: "shipwright".into(),
                contract_id: "shipwright-save-files-v1".into(),
                version: "9.3.1".into(),
                platform: Platform::WindowsX86_64,
            },
            destination: None,
            relation,
            changes: vec![PortableSaveFileChange {
                path: file.path.clone(),
                effect: PortableSaveFileEffect::Replace,
                incoming: Some(file.clone()),
                local: Some(file),
            }],
            stays_local: Vec::new(),
            incoming_content_sha256: "b".repeat(64),
            local_content_sha256: None,
            options: Default::default(),
            safety_backup_will_be_created: safety,
            blockers: Vec::new(),
            preview_sha256: "c".repeat(64),
        }
    }

    #[test]
    fn consent_states_source_scope_and_safety_backup() {
        let (_, message, action) = import_consent(&review(PortableSaveRelation::Diverged, true));
        assert_eq!(action, "Import saves");
        assert!(message.contains("9.3.1"));
        assert!(message.contains("1 save file will change"));
        assert!(message.contains("Settings, mods and other files stay"));
        assert!(message.contains("can't confirm"));
        assert!(message.contains("backs up this device's current saves"));
        let (_, empty, _) = import_consent(&review(PortableSaveRelation::NoLocalProgress, false));
        assert!(empty.contains("no current saves or settings"));
    }
}
