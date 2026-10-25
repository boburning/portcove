//! A fresh managed copy replaces registration only after checked publication.
use super::*;
use crate::library::ExternalRuntimeRelinkState;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ManagedRouteChangePreview {
    pub port_id: String,
    pub current_registration: ExternalRuntimeRecord,
    pub installation: InstallPlan,
    pub update_policy: UpdatePolicy,
    pub permitted: bool,
    pub reason: Option<String>,
    pub external_files_will_be_preserved: bool,
    pub external_data_will_be_copied: bool,
    pub preview_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ManagedRouteChangeResult {
    pub installation: InstallRecord,
    pub previous_registration: ExternalRuntimeRecord,
    pub external_files_preserved: bool,
}

impl PortcoveService {
    fn validate_managed_route_publication_path(
        &self,
        install: &InstallRecord,
        expected: &str,
    ) -> Result<()> {
        let journal = crate::operation::OperationStore::new(self.library.clone())
            .get(&install.id)?
            .ok_or_else(|| {
                PortcoveError::conflict("the managed-copy publication journal is missing")
            })?;
        if !journal.activate || journal.external_registration_sha256.as_deref() != Some(expected) {
            return Err(PortcoveError::conflict(
                "the managed-copy publication journal changed",
            ));
        }
        crate::output_root::validate_published_install_path(&self.library, &journal, install)?;
        Ok(())
    }

    // This initial-copy transition has no admitted Core data to migrate. An
    // existing data store stays intact and needs an explicit compatible restore.
    pub(crate) fn route_change_has_core_data(&self, port_id: &str) -> Result<bool> {
        let path = self.library.user_dir(port_id);
        refuse_symlink_ancestors(&path)?;
        match fs::read_dir(path) {
            Ok(mut entries) => entries
                .next()
                .transpose()
                .map(|entry| entry.is_some())
                .map_err(Into::into),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn require_separate_route_output(
        &self,
        old: &ExternalRuntimeRecord,
        output: &Path,
    ) -> Result<()> {
        let output = user_selected::managed_overlap_key(output)?;
        for path in [&old.path, &old.executable] {
            let external = user_selected::managed_overlap_key(path)?;
            if output.starts_with(&external) || external.starts_with(&output) {
                return Err(PortcoveError::conflict(
                    "choose a separate managed destination outside the current external folder; the current copy has been preserved",
                ));
            }
        }
        Ok(())
    }

    /// Resume only the admitted fresh-copy transition. This never reads or
    /// changes external game files, and the database repeats the final CAS.
    pub(crate) fn recover_managed_route_publication(
        &self,
        install: &InstallRecord,
        expected: &str,
    ) -> Result<()> {
        let state = self.library.external_runtime_relink_state(&install.port_id)?.ok_or_else(|| PortcoveError::conflict("the reviewed external registration no longer exists; preserve the prepared managed copy and review recovery"))?;
        if state.row_sha256 != expected {
            return Err(PortcoveError::conflict(
                "the external registration changed; recovery preserved it and the prepared managed copy",
            ));
        }
        self.validate_managed_route_publication_path(install, expected)?;
        // This payload is not registered yet. Load its exact retained contract
        // only after journal/owned-root validation, without requiring an install row.
        let retained = Installer::new(self.library.clone())?
            .retained_catalog(install)?
            .ok_or_else(|| {
                PortcoveError::verification(
                    "the managed-copy payload has no retained installation contract",
                )
            })?;
        let port = retained.port(&install.port_id)?;
        if port.adapter != AdapterKind::NativePortable
            || port.managed_shared_preferences.is_some()
            || port.runtime_data_policy.is_some()
            || state.record.shared_preferences.is_some()
        {
            return Err(PortcoveError::unsupported(
                "this retained route does not support a fresh managed-copy transition",
            ));
        }
        self.require_separate_route_output(&state.record, &install.path)?;
        if self.route_change_has_core_data(&install.port_id)? {
            return Err(PortcoveError::conflict(
                "saved data appeared before publication; recovery preserved the external registration, prepared copy and saved data",
            ));
        }
        crate::runtime::require_ready(port, Platform::current()?, install)?;
        self.library
            .register_install_replacing_external(install, expected)
    }

    async fn managed_route_change_review(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
        output_directory: Option<&Path>,
    ) -> Result<(ExternalRuntimeRelinkState, ManagedRouteChangePreview)> {
        let state = self
            .library
            .external_runtime_relink_state(port_id)?
            .ok_or_else(|| {
                PortcoveError::not_found("this game has no external registration to change")
            })?;
        let port = self.catalog.port(port_id)?;
        let current = self.library.status(port_id, default_channel(port))?;
        let channel = channel.unwrap_or_else(|| {
            if port.channels.contains(&current.channel) {
                current.channel
            } else {
                default_channel(port)
            }
        });
        let installation = self
            .plan_install_at(port_id, Some(channel), output_directory)
            .await?;
        self.require_separate_route_output(
            &state.record,
            &installation.output_location.effective_output_directory,
        )?;
        let reason = if port.adapter != AdapterKind::NativePortable {
            Some("This managed route needs preparation or data handling that this registration change does not transfer. Keep using your current copy; upstream setup in a separate folder remains available.".into())
        } else if state.record.shared_preferences.is_some()
            || port.managed_shared_preferences.is_some()
            || port.runtime_data_policy.is_some()
        {
            Some("This installation has a separate account or shared-data contract. Keep the current route until its reviewed transition is available.".into())
        } else if self
            .library
            .all_installs()?
            .iter()
            .any(|install| install.port_id == port_id)
        {
            Some("A managed version already exists for this game. Review its current state before changing the external registration.".into())
        } else if self
            .pending_setups()?
            .iter()
            .any(|pending| pending.port_id == port_id)
        {
            Some("A downloaded copy still has saved setup progress. Finish that copy or forget its setup reminder before changing to a managed copy; its files remain in place.".into())
        } else if self.route_change_has_core_data(port_id)? {
            Some(format!(
                "Portcove already has saved data for this game at {}. Close all copies, move that saved-data folder to a separate location and verify the preserved files before retrying this fresh-copy transition. Keep it for a deliberate compatible restore later; this operation does not guess how older saved data fits the new route. The external installation stays registered.",
                self.library.user_dir(port_id).display()
            ))
        } else {
            None
        };
        let fresh = self
            .library
            .external_runtime_relink_state(port_id)?
            .ok_or_else(|| {
                PortcoveError::conflict("the external registration changed during review")
            })?;
        if fresh.row_sha256 != state.row_sha256 {
            return Err(PortcoveError::conflict(
                "the external registration changed during review; refresh the proposed route",
            ));
        }
        let permitted = reason.is_none();
        let installation_digest = self.game_release_review_digest(
            "portcove-managed-route-change-installation-v1",
            &installation,
            &current,
            true,
        )?;
        let definition =
            crate::installed_contract::InstalledContract::capture(&self.catalog, port_id)?;
        let preview_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&(
            "portcove-managed-route-change-v1",
            &state.row_sha256,
            installation_digest,
            definition,
            permitted,
            &reason,
        ))?));
        Ok((
            state,
            ManagedRouteChangePreview {
                port_id: port_id.into(),
                current_registration: fresh.record,
                installation,
                update_policy: current.update_policy,
                permitted,
                reason,
                external_files_will_be_preserved: true,
                external_data_will_be_copied: false,
                preview_sha256,
            },
        ))
    }

    pub async fn preview_managed_route_change(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
        output_directory: Option<&Path>,
    ) -> Result<ManagedRouteChangePreview> {
        self.managed_route_change_review(port_id, channel, output_directory)
            .await
            .map(|(_, preview)| preview)
    }

    pub async fn authorize_managed_route_change(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
        output_directory: Option<&Path>,
        expected_preview_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self
            .preview_managed_route_change(port_id, channel, output_directory)
            .await?;
        if !preview.permitted {
            return Err(PortcoveError::unsupported(
                preview
                    .reason
                    .unwrap_or_else(|| "this route change is unavailable".into()),
            ));
        }
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "the proposed route changed after review; the current copy has been preserved",
            ));
        }
        self.library
            .issue_authorization("change_to_managed", port_id, &preview.preview_sha256)
    }

    pub async fn change_to_managed_runtime<F>(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
        output_directory: Option<&Path>,
        authorization_token: &str,
        mut emit: F,
    ) -> Result<ManagedRouteChangeResult>
    where
        F: FnMut(OperationEvent),
    {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::Install,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        emit(operation.started());
        let mut previous_registration = None;
        let result = async {
            let _lock = self.library.try_lock_port(port_id, "change-installation-route")?;
            let (state, preview) = operation.interruptible(self.managed_route_change_review(port_id, channel, output_directory)).await?;
            previous_registration = Some(state.record.clone());
            if !preview.permitted {
                return Err(PortcoveError::unsupported(preview.reason.unwrap_or_else(|| "this route change is unavailable".into())));
            }
            self.library.consume_authorization(authorization_token, "change_to_managed", port_id, &preview.preview_sha256)?;
            self.require_no_pending_setup(port_id)?;
            let port = self.catalog.port(port_id)?;
            let resolution = operation.interruptible(self.resolve_release(port, preview.installation.channel, preview.installation.platform)).await?;
            if serde_json::to_value(&resolution.release)? != serde_json::to_value(&preview.installation.release)? {
                return Err(PortcoveError::conflict("the release changed before preparation; review it again without changing the current copy"));
            }
            operation.observe_release(&resolution.release.version, None);
            let qualification = InstallQualification::from_catalog(&self.catalog, port_id, preview.installation.platform)?.with_acquisition_resolution(resolution.clone())?;
            let validate_activation = |install: &InstallRecord| {
                self.require_separate_route_output(&state.record, &preview.installation.output_location.effective_output_directory)?;
                if self.route_change_has_core_data(port_id)? {
                    return Err(PortcoveError::conflict("saved data appeared while preparing the replacement; the external registration and all saved data have been preserved"));
                }
                self.validate_managed_route_publication_path(install, &state.row_sha256)?;
                crate::runtime::require_ready(port, preview.installation.platform, install)
            };
            let installation = Installer::with_faults(self.library.clone(), self.faults.clone())?.install_replacing_external(
                InstallRequest { port_id: port_id.into(), release: resolution.release,
                    output_root: preview.installation.output_location.effective_output_directory.clone(),
                    activate: true, managed: None, qualification },
                &state.row_sha256, &state.record.path, &validate_activation, &operation, &mut emit,
            ).await?;
            Ok(ManagedRouteChangeResult { installation, previous_registration: state.record, external_files_preserved: true })
        }.await;
        let known_committed = result
            .as_ref()
            .ok()
            .map(|result| result.installation.clone());
        let classify_commit = |mut error: PortcoveError| {
            if let Some(previous) = previous_registration.as_ref() {
                if let Some(install) = &known_committed {
                    error.mark_managed_route_committed(install, &previous.path, false);
                }
                match self.library.status(port_id, ReleaseChannel::Stable) {
                    Ok(status) if status.external_runtime.is_none() => {
                        if let Some(active) = status.active
                            && active.id == operation.operation_id()
                        {
                            error.mark_managed_route_committed(&active, &previous.path, true);
                        }
                    }
                    _ => {}
                }
            }
            error
        };
        let result = self
            .finish_activity(activity, result)
            .map_err(classify_commit);
        emit(operation.finished(OperationResult::from_result(&result)));
        result
    }
}
