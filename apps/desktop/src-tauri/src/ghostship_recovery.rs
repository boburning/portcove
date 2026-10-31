//! Thin host consent for Core-owned compound legacy recovery.
use crate::{
    DesktopResult, DesktopState, blocking_worker, confirm_destructive, service_at_generation,
};
use portcove_core::{GhostshipRecoveryPlan, GhostshipRecoveryResult, PortcoveError};

#[tauri::command]
pub(crate) async fn plan_ghostship_legacy_recovery(
    state: tauri::State<'_, DesktopState>,
    backup_id: String,
    generation: u64,
) -> DesktopResult<GhostshipRecoveryPlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .plan_ghostship_legacy_recovery(&backup_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn recover_ghostship_legacy_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    backup_id: String,
    expected_plan: String,
    generation: u64,
) -> DesktopResult<Option<GhostshipRecoveryResult>> {
    let plan = plan_ghostship_legacy_recovery(state.clone(), backup_id.clone(), generation).await?;
    validate_review(&plan, &expected_plan)?;
    if !confirm_destructive(
        &app,
        "Confirm Ghostship legacy recovery",
        recovery_consent(&plan),
        "Recover legacy installation and data",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        // Dialog time grants no authority over changed data, installs or a new library.
        let current = service.plan_ghostship_legacy_recovery(&backup_id)?;
        validate_review(&current, &expected_plan)?;
        let authorization =
            service.authorize_ghostship_legacy_recovery(&backup_id, &expected_plan)?;
        service
            .recover_ghostship_legacy_data(&backup_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

fn validate_review(plan: &GhostshipRecoveryPlan, expected: &str) -> DesktopResult<()> {
    if plan.plan_sha256 != expected {
        return Err(PortcoveError::conflict(
            "legacy recovery inputs changed; review the plan again",
        )
        .into());
    }
    Ok(())
}

fn recovery_consent(plan: &GhostshipRecoveryPlan) -> String {
    format!(
        "Recover Ghostship using qualified backup {}?\n\nLibrary: {}\nSelected snapshot: {}\nRetained legacy installation: {} ({})\nCurrent installation: {} ({})\nRequired free space: {} bytes\n\nThis activates a fresh derivative of the retained legacy installation and replaces canonical saved data with the selected snapshot. Both existing installations, other staged installations and the selected backup remain. Independent safety copies preserve current canonical data and newer-runtime saves/settings.\n\nThe runtime safety copy is retained alongside its canonical safety backup. Ordinary restore uses only canonical data; deleting that safety backup also deletes its runtime copy. This does not launch the game or prove gameplay/save compatibility.",
        plan.backup.id,
        plan.library_root.display(),
        plan.backup.path.display(),
        plan.legacy_install.id,
        plan.legacy_install.path.display(),
        plan.active_install.id,
        plan.active_install.path.display(),
        plan.required_bytes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan() -> GhostshipRecoveryPlan {
        let install = |id: &str, version: &str| {
            json!({
                "id": id, "port_id": "ghostship", "version": version,
                "path": format!("library/{id}"), "channel": "stable", "installed_at": 1,
                "verified": true, "staged": false,
                "artifact": { "asset_name": "fixture.zip", "sha256": "a".repeat(64), "size": 1 },
                "manifest_sha256": "b".repeat(64), "selected_executable": "fixture.exe", "runtime": null
            })
        };
        let tree = json!({"directories": [], "files": [], "skipped_entries": [], "total_bytes": 0});
        serde_json::from_value(json!({
            "format_version": 1, "library_root": "library",
            "backup": { "id": "qualified", "port_id": "ghostship", "path": "library/snapshot",
                "created_at": 1, "file_count": 1, "size": 1, "sha256": "c".repeat(64) },
            "qualification_sha256": "d".repeat(64), "legacy_install": install("legacy", "2.0.0"),
            "active_install": install("current", "3.0.0"), "staged_install": null,
            "source": { "profile_id": "ghostship", "path": "original.z64", "sha256": "e".repeat(64),
                "size": 1, "storage_sha256": "e".repeat(64), "storage_size": 1, "updated_at": 1 },
            "channel": "stable", "update_policy": "notify", "canonical_data": tree,
            "active_install_tree": tree, "legacy_install_tree": tree, "snapshot_data": tree,
            "required_bytes": 1234, "plan_sha256": "f".repeat(64)
        }))
        .unwrap()
    }

    #[test]
    fn compound_review_refuses_a_changed_core_fingerprint() {
        let plan = plan();
        assert!(validate_review(&plan, &plan.plan_sha256).is_ok());
        assert!(validate_review(&plan, &"0".repeat(64)).is_err());
        assert!(validate_review(&plan, "").is_err());
    }

    #[test]
    fn compound_consent_names_both_installs_and_independent_safety_consequences() {
        let message = recovery_consent(&plan());
        for required in [
            "qualified",
            "library/snapshot",
            "library/legacy",
            "library/current",
            "1234 bytes",
            "fresh derivative",
            "Both existing installations",
            "Independent safety copies",
            "newer-runtime saves/settings",
            "Ordinary restore uses only canonical data",
            "deleting that safety backup also deletes its runtime copy",
            "does not launch",
        ] {
            assert!(message.contains(required), "missing disclosure: {required}");
        }
    }
}
