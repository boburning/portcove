//! Library-scoped host presentation choices; no launch or mutation permission.
use crate::{
    DesktopError, DesktopResult, DesktopState, blocking_worker, require_library_generation,
    state_generation,
};
use portcove_core::{InstallationContext, LibraryOrganization, OrganizationChange, PortcoveError};

#[tauri::command]
pub(crate) async fn get_library_organization(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
) -> DesktopResult<LibraryOrganization> {
    let state = state.inner().clone();
    blocking_worker(move || organization_at_generation(&state, generation, None)).await
}

#[tauri::command]
pub(crate) async fn change_library_organization(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    expected_revision: u64,
    change: OrganizationChange,
) -> DesktopResult<LibraryOrganization> {
    let state = state.inner().clone();
    blocking_worker(move || {
        organization_at_generation(&state, generation, Some((expected_revision, change)))
    })
    .await
}

fn organization_at_generation(
    state: &DesktopState,
    generation: u64,
    change: Option<(u64, OrganizationChange)>,
) -> DesktopResult<LibraryOrganization> {
    // Bind identity, optional attestation context and publication to one selection.
    let initialization = state
        .initialization
        .lock()
        .map_err(|_| DesktopError::from(PortcoveError::state("desktop state lock was poisoned")))?;
    require_library_generation(state_generation(state), generation)?;
    let library = &initialization.as_ref().map_err(Clone::clone)?.library;
    let identity = library.identity_record().map_err(DesktopError::from)?;
    let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
    if let Some((revision, change)) = change {
        if let OrganizationChange::SetSetupConfirmation {
            confirmation,
            confirmed: true,
        } = &change
        {
            let status = library
                .status(&confirmation.port_id, portcove_core::ReleaseChannel::Stable)
                .map_err(DesktopError::from)?;
            let matches = match &confirmation.context {
                InstallationContext::Managed { installation_id } => status
                    .active
                    .as_ref()
                    .is_some_and(|install| install.id == *installation_id),
                InstallationContext::External { installation_id } => status
                    .external_runtime
                    .as_ref()
                    .is_some_and(|install| install.id == *installation_id),
            };
            if !matches {
                return Err(PortcoveError::conflict(
                    "installation changed; review setup for the current installation",
                )
                .into());
            }
        }
        preferences
            .change_library_organization(&identity.id, revision, change)
            .map_err(DesktopError::from)
    } else {
        preferences
            .library_organization(&identity.id)
            .map_err(DesktopError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::initialize_desktop_selection;
    use portcove_core::{ErrorCode, HostPreferenceStore, LibrarySelection, LibrarySelectionSource};
    use std::sync::{Arc, Mutex, atomic::AtomicU64};

    #[test]
    fn organization_rejects_stale_library_and_uninstalled_attestation_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preferences.json");
        let state = DesktopState {
            initialization: Arc::new(Mutex::new(initialize_desktop_selection(LibrarySelection {
                root: tmp.path().join("library"),
                source: LibrarySelectionSource::Invocation,
            }))),
            preferences: Ok(HostPreferenceStore::new(path.clone()).unwrap()),
            generation: Arc::new(AtomicU64::new(1)),
            launch_observer: Arc::new(Mutex::new(None)),
        };
        assert_eq!(
            organization_at_generation(&state, 0, None)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let change = OrganizationChange::SetSetupConfirmation {
            confirmation: portcove_core::SetupConfirmation {
                port_id: "absent-port".into(),
                context: InstallationContext::External {
                    installation_id: "absent-installation".into(),
                },
            },
            confirmed: true,
        };
        assert!(organization_at_generation(&state, 1, Some((0, change))).is_err());
        assert!(!path.exists());
        let saved = organization_at_generation(
            &state,
            1,
            Some((
                0,
                OrganizationChange::SetSaved {
                    game_id: "absent-game".into(),
                    saved: true,
                },
            )),
        )
        .unwrap();
        assert!(saved.saved_game_ids.contains("absent-game"));
        assert_eq!(organization_at_generation(&state, 1, None).unwrap(), saved);
    }
}
