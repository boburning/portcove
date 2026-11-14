//! Player-supplied DAT files. Core owns parsing, persistence and identification;
//! these commands only reach the host preference store.
use crate::{DesktopResult, DesktopState, blocking_worker};
use portcove_core::DatReferenceStatus;
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn get_dat_references(
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<Vec<DatReferenceStatus>> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
        portcove_core::dat_reference_statuses(preferences).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn add_dat_reference(
    state: tauri::State<'_, DesktopState>,
    path: PathBuf,
) -> DesktopResult<DatReferenceStatus> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
        portcove_core::add_dat_reference(preferences, &path).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn remove_dat_reference(
    state: tauri::State<'_, DesktopState>,
    dat_id: String,
) -> DesktopResult<()> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
        portcove_core::remove_dat_reference(preferences, &dat_id).map_err(Into::into)
    })
    .await
}
