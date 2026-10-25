use crate::{
    DesktopResult, DesktopState, blocking_async_service_at_generation, blocking_worker,
    confirm_destructive, emit_operation, service_at_generation,
};
use portcove_core::{
    ExternalRuntimePreview, ExternalRuntimeRecord, ExternalRuntimeRelinkPreview,
    ExternalRuntimeRemovalPreview, ManagedRouteChangePreview, ManagedRouteChangeResult,
    PortcoveError, ReleaseChannel,
};
use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
pub(crate) async fn preview_managed_route_change(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    channel: Option<ReleaseChannel>,
    output_directory: Option<PathBuf>,
    generation: u64,
) -> DesktopResult<ManagedRouteChangePreview> {
    blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            service
                .preview_managed_route_change(&port_id, channel, output_directory.as_deref())
                .await
                .map_err(Into::into)
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn change_to_managed_runtime(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    channel: Option<ReleaseChannel>,
    output_directory: Option<PathBuf>,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<ManagedRouteChangeResult> {
    blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            let authorization = service
                .authorize_managed_route_change(
                    &port_id,
                    channel,
                    output_directory.as_deref(),
                    &expected_preview,
                )
                .await?;
            service
                .change_to_managed_runtime(
                    &port_id,
                    channel,
                    output_directory.as_deref(),
                    &authorization.token,
                    |event| emit_operation(&app, event),
                )
                .await
                .map_err(Into::into)
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn preview_user_selected_runtime(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<String>,
    generation: u64,
) -> DesktopResult<ExternalRuntimePreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_user_selected_runtime(&port_id, &executable, &working_directory, &arguments)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn register_user_selected_runtime(
    app: tauri::AppHandle,
    port_id: String,
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<String>,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<ExternalRuntimeRecord>> {
    let state = app
        .try_state::<DesktopState>()
        .ok_or_else(|| PortcoveError::unsupported("Desktop application state is unavailable"))?;
    let review = preview_user_selected_runtime(
        state.clone(),
        port_id.clone(),
        executable.clone(),
        working_directory.clone(),
        arguments.clone(),
        generation,
    )
    .await?;
    if review.preview_sha256 != expected_preview {
        return Err(PortcoveError::conflict(
            "selected launch details changed after review; inspect them again",
        )
        .into());
    }
    let description = format!(
        "Save launch details for the executable you selected at {} with working directory {} and arguments {}? This adds the game without starting it; choose Play separately to launch. Portcove has not authenticated these bytes as an official package. You or the upstream launcher manage setup and updates. Portcove can remove this registration; it will not replace, back up, restore, roll back or delete the external files.",
        review.executable.display(),
        review.path.display(),
        serde_json::to_string(&arguments).map_err(PortcoveError::from)?
    );
    if !confirm_destructive(
        &app,
        "Use your existing installation",
        description,
        "Use installation",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_user_selected_runtime(
            &port_id,
            &executable,
            &working_directory,
            &arguments,
            &expected_preview,
        )?;
        service
            .register_user_selected_runtime(
                &port_id,
                &executable,
                &working_directory,
                &arguments,
                &authorization.token,
            )
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_user_selected_runtime_relink(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<String>,
    generation: u64,
) -> DesktopResult<ExternalRuntimeRelinkPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_user_selected_runtime_relink(
                &port_id,
                &executable,
                &working_directory,
                &arguments,
            )
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn relink_user_selected_runtime(
    app: tauri::AppHandle,
    port_id: String,
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<String>,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<ExternalRuntimeRecord>> {
    let state = app
        .try_state::<DesktopState>()
        .ok_or_else(|| PortcoveError::unsupported("Desktop application state is unavailable"))?;
    let review = preview_user_selected_runtime_relink(
        state.clone(),
        port_id.clone(),
        executable.clone(),
        working_directory.clone(),
        arguments.clone(),
        generation,
    )
    .await?;
    if review.preview_sha256 != expected_preview {
        return Err(PortcoveError::conflict(
            "selected launch details or registration changed after review; inspect them again",
        )
        .into());
    }
    if !confirm_destructive(
        &app,
        "Change launch details",
        format!(
            "Save {} as the launch target with working directory {} and arguments {}? This changes the saved launch details without starting the game; choose Play separately to launch. The old and new game files stay where they are. Portcove has not authenticated these bytes as an official package. You or the upstream launcher remain responsible for setup and updates.",
            review.proposed.executable.display(),
            review.proposed.path.display(),
            serde_json::to_string(&arguments).map_err(PortcoveError::from)?,
        ),
        "Change launch details",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_user_selected_runtime_relink(
            &port_id,
            &executable,
            &working_directory,
            &arguments,
            &expected_preview,
        )?;
        service
            .relink_user_selected_runtime(
                &port_id,
                &executable,
                &working_directory,
                &arguments,
                &authorization.token,
            )
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_external_runtime_relink(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    generation: u64,
) -> DesktopResult<ExternalRuntimeRelinkPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_external_runtime_relink(&port_id, &path)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn relink_external_runtime(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<ExternalRuntimeRecord>> {
    let review =
        preview_external_runtime_relink(state.clone(), port_id.clone(), path.clone(), generation)
            .await?;
    if review.preview_sha256 != expected_preview {
        return Err(PortcoveError::conflict(
            "external game folder or registration changed after review; inspect it again",
        )
        .into());
    }
    if let Some(shared) = &review.proposed.shared_preferences
        && !confirm_destructive(
            &app,
            "Review shared preferences",
            shared.write_scope_disclosure()?,
            "Accept shared preferences",
        )
        .await
    {
        return Ok(None);
    }
    if !confirm_destructive(&app, "Change game folder", format!(
        "Change {} from {} to {}? All external game files, settings and saves stay where they are. Portcove will verify and launch the replacement folder. It will not copy, update, back up or delete either folder.",
        review.port_id, review.previous_path.display(), review.proposed.path.display(),
    ), "Change folder").await { return Ok(None); }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_external_runtime_relink(
            &port_id,
            &path,
            &expected_preview,
            review
                .proposed
                .shared_preferences
                .as_ref()
                .map(|_| expected_preview.as_str()),
        )?;
        service
            .relink_external_runtime(&port_id, &path, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_external_runtime(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    generation: u64,
) -> DesktopResult<ExternalRuntimePreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_external_runtime(&port_id, &path)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn register_external_runtime(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<ExternalRuntimeRecord>> {
    let review =
        preview_external_runtime(state.clone(), port_id.clone(), path.clone(), generation).await?;
    if review.preview_sha256 != expected_preview {
        return Err(PortcoveError::conflict(
            "external runtime changed after review; inspect it again",
        )
        .into());
    }
    if let Some(shared) = &review.shared_preferences {
        let disclosure = format!(
            "{} The shared location is currently {}. Accept this write scope?",
            shared.write_scope_disclosure()?,
            if shared.present {
                "present"
            } else {
                "absent; the game may create it"
            },
        );
        if !confirm_destructive(
            &app,
            "Review shared game data",
            disclosure,
            "Accept shared write scope",
        )
        .await
        {
            return Ok(None);
        }
    }
    let consent = format!(
        "Register {} version {} at {}? Portcove will verify and launch this exact runtime. It will not copy, update, back up, or delete the external folder. Game-owned output there remains outside Portcove's save management.",
        review.port_id,
        review.version,
        review.path.display(),
    );
    if !confirm_destructive(
        &app,
        "Confirm external runtime",
        consent,
        "Register runtime",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_external_runtime_with_shared_preferences_ack(
            &port_id,
            &path,
            &expected_preview,
            review
                .shared_preferences
                .as_ref()
                .map(|_| expected_preview.as_str()),
        )?;
        service
            .register_external_runtime(&port_id, &path, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_external_removal(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    generation: u64,
) -> DesktopResult<ExternalRuntimeRemovalPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_external_removal(&port_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn remove_external_runtime(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<ExternalRuntimeRecord>> {
    let review = preview_external_removal(state.clone(), port_id.clone(), generation).await?;
    if review.preview_sha256 != expected_preview || !review.external_files_will_be_preserved {
        return Err(PortcoveError::conflict(
            "external registration changed after review; inspect it again",
        )
        .into());
    }
    let consent = format!(
        "Remove Portcove's registration for {}? Every file at {} remains untouched, including the game, settings, and saves. Portcove will no longer launch this entry until it is registered again.",
        review.port_id,
        review.path.display(),
    );
    if !confirm_destructive(
        &app,
        "Confirm registration removal",
        consent,
        "Remove registration",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_external_removal(&port_id, &expected_preview)?;
        service
            .remove_external_runtime(&port_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}
