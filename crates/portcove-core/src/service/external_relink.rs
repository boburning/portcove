//! Change an external folder without deleting its retained registration first.
use super::*;
use crate::{ExternalRuntimeRelinkPreview, library::ExternalRuntimeRelinkState};

impl PortcoveService {
    pub(super) fn require_managed_runtime_ownership(status: &PortStatus) -> Result<()> {
        if status.external_runtime.is_some() {
            return Err(PortcoveError::conflict(
                "this game uses an external folder; change its folder or remove its registration before installing a managed copy",
            ));
        }
        Ok(())
    }

    pub fn preview_external_runtime_relink(
        &self,
        port_id: &str,
        requested_root: &Path,
    ) -> Result<ExternalRuntimeRelinkPreview> {
        self.external_runtime_relink_review(port_id, requested_root, &|| Ok(()))
            .map(|(_, preview)| preview)
    }

    fn external_runtime_relink_review(
        &self,
        port_id: &str,
        requested_root: &Path,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<(ExternalRuntimeRelinkState, ExternalRuntimeRelinkPreview)> {
        checkpoint()?;
        let state = self
            .library
            .external_runtime_relink_state(port_id)?
            .ok_or_else(|| {
                PortcoveError::not_found("external runtime registration was not found")
            })?;
        let port = state.catalog.port(port_id)?;
        let record = &state.record;
        let platform = Platform::current()?;
        if record.platform != platform || port.release.provider != ReleaseSource::UserPrepared {
            return Err(PortcoveError::verification(
                "external runtime retained platform contract does not match",
            ));
        }
        let spec = port.release.user_prepared.get(&platform).ok_or_else(|| {
            PortcoveError::verification("retained external runtime has no platform contract")
        })?;
        if spec.trust == crate::ExternalRuntimeTrust::UserSelected {
            return Err(PortcoveError::unsupported(
                "remove only this registration, then select the new executable and working directory; all external files remain in place",
            ));
        }
        if record.version != spec.version
            || !record
                .archive_sha256
                .eq_ignore_ascii_case(&spec.archive_sha256)
            || !record
                .immutable_tree_sha256
                .eq_ignore_ascii_case(&spec.immutable_tree_sha256)
            || !record.path.is_absolute()
        {
            return Err(PortcoveError::verification(
                "external runtime record differs from its retained accepted identity",
            ));
        }
        crate::external_runtime::require_retained_executable_path(
            &record.path,
            &record.executable,
            &spec.executable,
        )?;
        // The old folder may be missing. Preserve its accepted binding without
        // probing that folder, then revalidate the current account at the new root.
        crate::external_runtime::shared_preferences::check_binding(record, spec)?;
        let context =
            DefinitionOperationContext::observed(DefinitionOperation::RegisterExternal, true, true);
        if record.retained_definition.is_some() {
            self.require_definition_identity(record.retained_definition.as_ref(), context)?;
        } else {
            self.require_definition_operation(&state.catalog, port, context)?;
        }
        let proposed =
            self.inspect_external_runtime_preview(port, spec, requested_root, checkpoint)?;
        if record.shared_preferences
            != proposed
                .shared_preferences
                .as_ref()
                .map(|review| review.binding.clone())
        {
            return Err(PortcoveError::conflict(
                "shared preferences account or location changed; folder relinking cannot transfer its accepted account scope",
            ));
        }
        let preview_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&(
            "portcove-external-runtime-relink-v1",
            &state.row_sha256,
            &proposed,
        ))?));
        let preview = ExternalRuntimeRelinkPreview {
            port_id: port_id.to_owned(),
            registration_id: record.id.clone(),
            previous_path: record.path.clone(),
            proposed,
            external_files_will_be_preserved: true,
            preview_sha256,
        };
        Ok((state, preview))
    }

    pub fn authorize_external_runtime_relink(
        &self,
        port_id: &str,
        requested_root: &Path,
        expected_preview_sha256: &str,
        acknowledged_preview_sha256: Option<&str>,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_external_runtime_relink(port_id, requested_root)?;
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "external game folder or registration changed after review",
            ));
        }
        crate::external_runtime::shared_preferences::require_scoped_ack(
            preview.proposed.shared_preferences.is_some(),
            &preview.preview_sha256,
            acknowledged_preview_sha256,
        )?;
        self.library
            .issue_authorization("relink_external", port_id, &preview.preview_sha256)
    }

    pub fn relink_external_runtime(
        &self,
        port_id: &str,
        requested_root: &Path,
        authorization_token: &str,
    ) -> Result<ExternalRuntimeRecord> {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::RelinkExternal,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            let _lock = self.library.try_lock_port(port_id, "relink-external")?;
            let (state, preview) =
                self.external_runtime_relink_review(port_id, requested_root, &|| {
                    operation.checkpoint()
                })?;
            self.library.consume_authorization(
                authorization_token,
                "relink_external",
                port_id,
                &preview.preview_sha256,
            )?;
            operation.begin_publication()?;
            self.library
                .relink_external_runtime(port_id, &state.row_sha256, &preview.proposed)
        })();
        self.finish_activity(activity, result)
    }
}
