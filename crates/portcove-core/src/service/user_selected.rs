//! Bounded launch-only registration of an installation selected by its user.
use super::*;

impl PortcoveService {
    pub(super) fn require_user_selected_path_ownership(
        &self,
        executable: &Path,
        working_directory: &Path,
    ) -> Result<()> {
        // Metadata names only this library's claimed trees. Do not infer ownership
        // from output preferences, inspect foreign libraries or scan game folders.
        let mut owned = self
            .library
            .output_roots()?
            .into_iter()
            .map(|root| root.path)
            .collect::<Vec<_>>();
        owned.extend(
            self.library
                .all_installs()?
                .into_iter()
                .map(|install| install.path),
        );
        let executable = managed_overlap_key(executable)?;
        let working_directory = managed_overlap_key(working_directory)?;
        for root in owned {
            if !root.is_absolute() {
                return Err(PortcoveError::state(
                    "recorded managed runtime path is not absolute",
                ));
            }
            // Reachable records use current canonical spelling. An unrelated
            // offline root remains comparable without becoming a global blocker.
            let root = fs::canonicalize(&root).unwrap_or(root);
            let root = managed_overlap_key(&root)?;
            if executable.starts_with(&root)
                || working_directory.starts_with(&root)
                || root.starts_with(&working_directory)
            {
                return Err(PortcoveError::conflict(
                    "selected launch paths overlap this library's managed installation or claimed output; use the managed entry for those files",
                ));
            }
        }
        Ok(())
    }

    pub(super) fn check_user_selected_runtime_record(
        &self,
        record: &ExternalRuntimeRecord,
        spec: &crate::UserPreparedRuntimeSpec,
    ) -> Result<()> {
        crate::external_runtime::check_user_selected_record(record, spec, self.library.root())?;
        self.require_user_selected_path_ownership(&record.executable, &record.path)
    }

    pub(super) fn check_user_selected_retained_runtime(
        &self,
        record: &ExternalRuntimeRecord,
        catalog: &Catalog,
    ) -> Result<()> {
        if self
            .library
            .all_installs()?
            .iter()
            .any(|install| install.port_id == record.port_id)
        {
            return Err(PortcoveError::state(
                "managed installation and user-selected registration both exist for this port",
            ));
        }
        if catalog.is_user_selected_listing(&record.port_id) {
            crate::external_runtime::check_user_selected_listing_record(
                record,
                self.library.root(),
            )?;
            self.require_user_selected_path_ownership(&record.executable, &record.path)
        } else {
            let port = catalog.port(&record.port_id)?;
            let spec = port
                .release
                .user_prepared
                .get(&record.platform)
                .ok_or_else(|| {
                    PortcoveError::verification(
                        "retained selected runtime has no platform contract",
                    )
                })?;
            self.check_user_selected_runtime_record(record, spec)
        }
    }

    fn require_user_selected_registration_available(&self, port_id: &str) -> Result<()> {
        let state = self.library.status(port_id, ReleaseChannel::Stable)?;
        if state.external_runtime.is_some()
            || self
                .library
                .all_installs()?
                .iter()
                .any(|install| install.port_id == port_id)
        {
            return Err(PortcoveError::conflict(
                "this port already has an installation; selecting another route requires explicitly removing the existing installation or registration",
            ));
        }
        Ok(())
    }

    fn current_user_selected_definition(&self, port_id: &str) -> Result<Option<&PortDefinition>> {
        let Some(port) = self.catalog.ports().iter().find(|port| port.id == port_id) else {
            return Ok(None);
        };
        if port.release.provider != ReleaseSource::UserPrepared {
            return Ok(None);
        }
        let Some(spec) = port
            .release
            .user_prepared
            .get(&Platform::current()?)
            .filter(|spec| spec.trust == crate::ExternalRuntimeTrust::UserSelected)
        else {
            return Ok(None);
        };
        // Preserve the existing accepted selected-runtime route and its retained
        // authority. New directory presentation bounds cannot redefine it.
        crate::external_runtime::validate_user_selected_route(port, spec)?;
        self.require_definition_operation(
            &self.catalog,
            port,
            DefinitionOperationContext::observed(
                DefinitionOperation::RegisterExternal,
                false,
                true,
            ),
        )?;
        Ok(Some(port))
    }

    pub fn preview_user_selected_runtime(
        &self,
        port_id: &str,
        executable: &Path,
        working_directory: &Path,
        arguments: &[String],
    ) -> Result<ExternalRuntimePreview> {
        self.user_selected_runtime_preview(
            port_id,
            executable,
            working_directory,
            arguments,
            &|| Ok(()),
        )
    }

    fn user_selected_runtime_preview(
        &self,
        port_id: &str,
        executable: &Path,
        working_directory: &Path,
        arguments: &[String],
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<ExternalRuntimePreview> {
        let pending = self.pending_setup_registration(port_id)?;
        let listing = match &pending {
            Some((record, _)) => &record.listing,
            None => self.catalog.listing(port_id)?,
        };
        let selected_definition = if pending.is_none() {
            self.current_user_selected_definition(port_id)?
        } else {
            None
        };
        if selected_definition.is_none() {
            listing.validate()?;
        }
        // This is an explicit alternative ownership route. Descriptive platform
        // guesses and managed package holds grant neither trust nor denial of an
        // unrelated native executable selected by the user.
        let mut preview = crate::external_runtime::preview_user_selected(
            listing,
            executable,
            working_directory,
            arguments,
            self.library.root(),
            checkpoint,
        )?;
        self.require_user_selected_path_ownership(&preview.executable, &preview.path)?;
        self.require_user_selected_registration_available(port_id)?;
        if let Some(port) = selected_definition {
            preview.preview_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
                "accepted-user-selected-definition-v1",
                &preview.preview_sha256,
                port,
                self.catalog.definition_selection(port_id),
            ))?);
        }
        // The exact retained row binds continuation after directory retirement;
        // a stale preview cannot consume a different download's bookkeeping.
        if let Some((record, json)) = &pending {
            preview.preview_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
                "pending-user-selected-v1",
                &preview.preview_sha256,
                &record.id,
                json,
            ))?);
        }
        Ok(preview)
    }

    pub(super) fn with_user_selected_readiness(&self, mut status: PortStatus) -> PortStatus {
        // The general Library row carries a conventional managed save path;
        // this route has no Core-owned save or settings directory.
        status.user_data_root = None;
        let mut blockers = Vec::new();
        match status.external_runtime.as_ref() {
            None => blockers.push(LaunchBlocker::MissingRuntime),
            Some(record) => {
                let checked = (|| {
                    if status.active.is_some()
                        || status.previous.is_some()
                        || status.staged.is_some()
                    {
                        return Err(PortcoveError::state(
                            "multiple installation owners are recorded",
                        ));
                    }
                    let (current, catalog) = self
                        .library
                        .external_runtime_with_port(&status.port_id)?
                        .ok_or_else(|| PortcoveError::state("selected registration disappeared"))?;
                    if current.id != record.id {
                        return Err(PortcoveError::conflict("selected registration changed"));
                    }
                    self.check_user_selected_retained_runtime(record, &catalog)?;
                    self.require_definition_identity(
                        record.retained_definition.as_ref(),
                        DefinitionOperationContext::observed(
                            DefinitionOperation::Launch,
                            true,
                            true,
                        ),
                    )
                })();
                if checked.is_err() {
                    blockers.push(LaunchBlocker::InvalidInstallation);
                }
            }
        }
        status.readiness = Some(LaunchReadiness {
            setup_contract: None,
            launchable: blockers.is_empty(),
            blockers,
            pending_setup: false,
            preparation_mode: None,
            required_source_extension: None,
            source: None,
            bios: None,
            source_assessment: None,
            bios_assessment: None,
        });
        // Public PortStatus carries lifecycle actions; backup-only assessments
        // belong to the backup inventory, including for selected runtimes.
        status.port_actions = [
            PortAction::Install,
            PortAction::RegisterExternal,
            PortAction::RemoveManaged,
            PortAction::Update,
        ]
        .into_iter()
        .map(|action| PortActionAssessment {
            action,
            availability: PortActionAvailability::NotOffered,
            reason: PortActionReason::RouteNotOffered,
            definition: None,
        })
        .collect();
        let launchable = status
            .readiness
            .as_ref()
            .is_some_and(|readiness| readiness.launchable);
        let registered = status.external_runtime.is_some();
        for (action, availability, reason) in [
            (
                PortAction::Launch,
                if launchable {
                    PortActionAvailability::Allowed
                } else {
                    PortActionAvailability::Held
                },
                if launchable {
                    PortActionReason::Available
                } else if registered {
                    PortActionReason::InvalidInstallation
                } else {
                    PortActionReason::NotInstalled
                },
            ),
            (
                PortAction::RemoveExternal,
                if registered {
                    PortActionAvailability::Waiting
                } else {
                    PortActionAvailability::NotOffered
                },
                if registered {
                    PortActionReason::ReviewRequired
                } else {
                    PortActionReason::NotInstalled
                },
            ),
        ] {
            status.port_actions.push(PortActionAssessment {
                action,
                availability,
                reason,
                definition: None,
            });
        }
        status
    }

    pub fn authorize_user_selected_runtime(
        &self,
        port_id: &str,
        executable: &Path,
        working_directory: &Path,
        arguments: &[String],
        expected_preview_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview =
            self.preview_user_selected_runtime(port_id, executable, working_directory, arguments)?;
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "selected executable, arguments or working directory changed after review",
            ));
        }
        self.library
            .issue_authorization("register_user_selected", port_id, &preview.preview_sha256)
    }

    pub fn register_user_selected_runtime(
        &self,
        port_id: &str,
        executable: &Path,
        working_directory: &Path,
        arguments: &[String],
        authorization_token: &str,
    ) -> Result<ExternalRuntimeRecord> {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::RegisterExternal,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            let _lock = self
                .library
                .try_lock_port(port_id, "register-user-selected")?;
            operation.checkpoint()?;
            let preview = self.user_selected_runtime_preview(
                port_id,
                executable,
                working_directory,
                arguments,
                &|| operation.checkpoint(),
            )?;
            self.library.consume_authorization(
                authorization_token,
                "register_user_selected",
                port_id,
                &preview.preview_sha256,
            )?;
            let pending = self.pending_setup_registration(port_id)?;
            let accepted_selected =
                pending.is_none() && self.current_user_selected_definition(port_id)?.is_some();
            let retained = if accepted_selected {
                self.catalog.clone()
            } else {
                let listing = match &pending {
                    Some((record, _)) => record.listing.clone(),
                    None => self.catalog.listing(port_id)?.clone(),
                };
                Catalog::for_user_selected_listing(listing)?
            };
            operation.begin_publication()?;
            let record = ExternalRuntimeRecord {
                user_selected: preview.user_selected,
                id: Uuid::new_v4().to_string(),
                port_id: port_id.into(),
                path: preview.path,
                executable: preview.executable,
                version: preview.version,
                platform: Platform::current()?,
                archive_sha256: String::new(),
                immutable_tree_sha256: String::new(),
                registered_at: Library::now(),
                retained_definition: accepted_selected
                    .then(|| self.catalog.definition_selection(port_id).cloned())
                    .flatten(),
                shared_preferences: None,
            };
            self.library.register_external_runtime_finishing_setup(
                &record,
                &retained,
                pending
                    .as_ref()
                    .map(|(record, json)| (record.id.as_str(), json.as_str())),
            )?;
            Ok(record)
        })();
        self.finish_activity(activity, result)
    }

    pub fn preview_user_selected_runtime_relink(
        &self,
        port_id: &str,
        executable: &Path,
        working_directory: &Path,
        arguments: &[String],
    ) -> Result<crate::ExternalRuntimeRelinkPreview> {
        self.user_selected_runtime_relink_review(
            port_id,
            executable,
            working_directory,
            arguments,
            &|| Ok(()),
        )
        .map(|(_, preview)| preview)
    }

    fn user_selected_runtime_relink_review(
        &self,
        port_id: &str,
        executable: &Path,
        working_directory: &Path,
        arguments: &[String],
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<(
        crate::library::ExternalRuntimeRelinkState,
        crate::ExternalRuntimeRelinkPreview,
    )> {
        checkpoint()?;
        let state = self
            .library
            .external_runtime_relink_state(port_id)?
            .ok_or_else(|| {
                PortcoveError::not_found("selected runtime registration was not found")
            })?;
        let record = &state.record;
        // The previous path may have disappeared after an upstream update. Only
        // its retained authority is read; review checks the newly selected paths.
        crate::external_runtime::check_user_selected_identity(record)?;
        if record.platform != Platform::current()? {
            return Err(PortcoveError::unsupported(
                "selected installation belongs to another platform",
            ));
        }
        self.require_definition_identity(
            record.retained_definition.as_ref(),
            DefinitionOperationContext::observed(DefinitionOperation::RegisterExternal, true, true),
        )?;
        let proposed = crate::external_runtime::preview_user_selected(
            state.catalog.listing(port_id)?,
            executable,
            working_directory,
            arguments,
            self.library.root(),
            checkpoint,
        )?;
        self.require_user_selected_path_ownership(&proposed.executable, &proposed.path)?;
        let pending = self.pending_setup_registration(port_id)?;
        let preview_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&(
            "portcove-user-selected-relink-v1",
            &state.row_sha256,
            &proposed,
            &pending,
        ))?));
        let preview = crate::ExternalRuntimeRelinkPreview {
            port_id: port_id.into(),
            registration_id: record.id.clone(),
            previous_path: record.path.clone(),
            proposed,
            external_files_will_be_preserved: true,
            preview_sha256,
        };
        Ok((state, preview))
    }

    pub fn authorize_user_selected_runtime_relink(
        &self,
        port_id: &str,
        executable: &Path,
        working_directory: &Path,
        arguments: &[String],
        expected_preview_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_user_selected_runtime_relink(
            port_id,
            executable,
            working_directory,
            arguments,
        )?;
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "selected installation or registration changed after review",
            ));
        }
        self.library
            .issue_authorization("relink_user_selected", port_id, &preview.preview_sha256)
    }

    pub fn relink_user_selected_runtime(
        &self,
        port_id: &str,
        executable: &Path,
        working_directory: &Path,
        arguments: &[String],
        authorization_token: &str,
    ) -> Result<ExternalRuntimeRecord> {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::RelinkExternal,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            let _lock = self
                .library
                .try_lock_port(port_id, "relink-user-selected")?;
            let (state, preview) = self.user_selected_runtime_relink_review(
                port_id,
                executable,
                working_directory,
                arguments,
                &|| operation.checkpoint(),
            )?;
            self.library.consume_authorization(
                authorization_token,
                "relink_user_selected",
                port_id,
                &preview.preview_sha256,
            )?;
            operation.begin_publication()?;
            let pending = self.pending_setup_registration(port_id)?;
            self.library.relink_user_selected_runtime(
                port_id,
                &state.row_sha256,
                &preview.proposed,
                pending
                    .as_ref()
                    .map(|(record, json)| (record.id.as_str(), json.as_str())),
            )
        })();
        self.finish_activity(activity, result)
    }
}

pub(super) fn managed_overlap_key(path: &Path) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let text = crate::path::unicode(path, "managed ownership path")?
            .replace('\\', "/")
            .to_lowercase();
        if let Some(unc) = text.strip_prefix("//?/unc/") {
            return Ok(PathBuf::from(format!("//{unc}")));
        }
        Ok(PathBuf::from(text.strip_prefix("//?/").unwrap_or(&text)))
    }
    #[cfg(not(windows))]
    {
        crate::path::unicode(path, "managed ownership path")?;
        Ok(path.to_path_buf())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(id: &str) -> (tempfile::TempDir, PortcoveService, PathBuf, PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let working = temporary.path().join("user-owned game");
        fs::create_dir(&working).unwrap();
        let executable = crate::test_fixture::build_probe(&working);
        fs::write(working.join("player-save.dat"), b"player save").unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let mut service = PortcoveService::new(library).unwrap();
        let platform = serde_json::to_value(Platform::current().unwrap())
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        let document = json!({
        "schema_version":1,"source_profiles":[],"ports":[{
            "id":id,"name":"Synthetic selected native runtime","summary":"Fixture only; no game observation",
            "project_url":"https://example.com/upstream","support_tier":"beta","channels":["stable"],
            "platforms":[Platform::current().unwrap()],"adapter":"staged-source-portable",
            "release":{"provider":"user-prepared","user_prepared":{
                (platform):{"trust":"user-selected","version":"user-managed","archive_name":"","archive_size":0,"archive_sha256":"","immutable_tree_sha256":"","executable":"","mutable_paths":[]}
            }}
        }]});
        service.catalog = Catalog::from_json(&document.to_string()).unwrap();
        (temporary, service, executable, working)
    }

    fn register(
        service: &PortcoveService,
        id: &str,
        executable: &Path,
        working: &Path,
    ) -> ExternalRuntimeRecord {
        let arguments = vec!["--help".into()];
        let preview = service
            .preview_user_selected_runtime(id, executable, working, &arguments)
            .unwrap();
        assert!(preview.archive_sha256.is_empty());
        assert!(preview.immutable_tree_sha256.is_empty());
        assert_eq!(preview.immutable_file_count, 0);
        let authorization = service
            .authorize_user_selected_runtime(
                id,
                executable,
                working,
                &arguments,
                &preview.preview_sha256,
            )
            .unwrap();
        service
            .register_user_selected_runtime(
                id,
                executable,
                working,
                &arguments,
                &authorization.token,
            )
            .unwrap()
    }

    fn listing_only(service: &mut PortcoveService) {
        let mut document = service.catalog.listing_document().clone();
        for listing in &mut document.listings {
            listing.platforms.clear();
            listing.availability = crate::ListingAvailability::SourceOnly;
        }
        service.catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#)
            .unwrap()
            .with_listing_document(document)
            .unwrap();
    }

    // The listing-based contract retains its acquisition restriction without
    // promoting the descriptive identity into a strict managed definition.
    fn assert_listing_only_player_route(id: &str, embedded_download_hold: Option<bool>) {
        let (temporary, mut service, executable, working) = fixture(id);
        if let Some(download_hold) = embedded_download_hold {
            service.catalog = Catalog::embedded().unwrap();
            let listing = service.catalog.listing(id).unwrap();
            assert!(listing.manual_setup.is_some());
            assert_eq!(listing.download_block_reason.is_some(), download_hold);
        } else {
            listing_only(&mut service);
        }
        assert!(service.catalog.port(id).is_err());
        assert_selected_listing_lifecycle(temporary, service, executable, working, id);
    }

    fn assert_selected_listing_lifecycle(
        temporary: tempfile::TempDir,
        service: PortcoveService,
        executable: PathBuf,
        working: PathBuf,
        id: &str,
    ) {
        let expected_listing = service.catalog.listing(id).unwrap().clone();
        let expected_definition = service
            .catalog
            .port(id)
            .ok()
            .map(|port| serde_json::to_value(port).unwrap());
        let initial = service.listing_status(id).unwrap();
        assert!(
            initial.actions.iter().any(|action| action.action
                == crate::ListingAction::AttachExisting
                && action.allowed)
        );
        let record = register(&service, id, &executable, &working);
        assert_eq!(
            service
                .catalog
                .port(id)
                .ok()
                .map(|port| serde_json::to_value(port).unwrap()),
            expected_definition
        );
        assert!(
            service
                .preview_user_selected_runtime(id, &executable, &working, &[])
                .is_err()
        );

        let replacement = temporary.path().join("upstream update");
        fs::create_dir(&replacement).unwrap();
        let replacement_executable = replacement.join(executable.file_name().unwrap());
        fs::copy(&executable, &replacement_executable).unwrap();
        let arguments = vec!["--help".into()];
        let preview = service
            .preview_user_selected_runtime_relink(
                id,
                &replacement_executable,
                &replacement,
                &arguments,
            )
            .unwrap();
        assert!(
            service
                .authorize_user_selected_runtime_relink(
                    id,
                    &replacement_executable,
                    &replacement,
                    &[],
                    &preview.preview_sha256,
                )
                .is_err()
        );
        let authorization = service
            .authorize_user_selected_runtime_relink(
                id,
                &replacement_executable,
                &replacement,
                &arguments,
                &preview.preview_sha256,
            )
            .unwrap();
        // Relinking must remain useful if an upstream updater removed the old
        // executable. The player-owned save and the new selected tree remain.
        fs::remove_file(&executable).unwrap();
        let relinked = service
            .relink_user_selected_runtime(
                id,
                &replacement_executable,
                &replacement,
                &arguments,
                &authorization.token,
            )
            .unwrap();
        assert_eq!(relinked.id, record.id);
        assert_eq!(relinked.registered_at, record.registered_at);
        assert_eq!(
            service
                .catalog
                .port(id)
                .ok()
                .map(|port| serde_json::to_value(port).unwrap()),
            expected_definition
        );
        assert!(
            service
                .relink_user_selected_runtime(
                    id,
                    &replacement_executable,
                    &replacement,
                    &arguments,
                    &authorization.token,
                )
                .is_err()
        );
        assert_eq!(
            fs::read(working.join("player-save.dat")).unwrap(),
            b"player save"
        );

        let root = service.library.root().to_path_buf();
        drop(service);
        let service = PortcoveService::new(Library::open(root).unwrap()).unwrap();
        let (_, retained) = service
            .library
            .external_runtime_with_port(id)
            .unwrap()
            .unwrap();
        assert!(retained.is_user_selected_listing(id));
        assert_eq!(
            serde_json::to_value(retained.listing(id).unwrap()).unwrap(),
            serde_json::to_value(&expected_listing).unwrap()
        );
        let workspace = service.workspace_snapshot(10).unwrap();
        assert!(
            workspace
                .listing_catalog
                .unwrap()
                .listings
                .iter()
                .any(|listing| listing.id == id)
        );
        assert!(
            workspace
                .listing_statuses
                .iter()
                .any(|listing| listing.port_id == id && listing.status.external_runtime.is_some())
        );
        assert!(service.status(id).unwrap().readiness.unwrap().launchable);
        assert!(
            service
                .supervise_launch(id, None, &[], LaunchStdio::Null, |_| {})
                .unwrap()
                .successful
        );
        let removal = service.preview_external_removal(id).unwrap();
        let consent = service
            .authorize_external_removal(id, &removal.preview_sha256)
            .unwrap();
        service.remove_external_runtime(id, &consent.token).unwrap();
        assert!(replacement_executable.is_file());
        assert_eq!(
            fs::read(working.join("player-save.dat")).unwrap(),
            b"player save"
        );
        assert_eq!(
            service
                .catalog
                .port(id)
                .ok()
                .map(|port| serde_json::to_value(port).unwrap()),
            expected_definition
        );
    }

    #[test]
    fn listing_only_registration_relink_restart_and_launch_preserve_user_ownership() {
        assert_listing_only_player_route("listing-only", None);
    }

    #[test]
    fn cannonball_route_120() {
        assert_listing_only_player_route("cannonball-outrun", Some(true));
    }

    #[test]
    fn cannonball_route_1132() {
        assert_listing_only_player_route("cannonball-dx-outrun", Some(true));
    }

    #[test]
    fn psx_permitted_player_route_826() {
        assert_listing_only_player_route("mstan-battle-arena-toshinden-recomp", Some(true));
    }

    #[test]
    fn psx_permitted_player_route_827() {
        assert_listing_only_player_route("novapowers0-bloody-roar-ii-recomp", Some(true));
    }

    #[test]
    fn verdite_prepared_player_route_1900() {
        assert_listing_only_player_route("voicedrew11-verdite2", Some(false));
    }

    #[test]
    fn verdite_prepared_player_route_1901() {
        assert_listing_only_player_route("voicedrew11-verdite3", Some(false));
    }

    #[test]
    fn snes_source_player_route_146() {
        assert_listing_only_player_route("mega-man-x-snes-recomp", Some(true));
    }

    #[test]
    fn snes_source_player_route_340() {
        assert_listing_only_player_route("super-metroid-snesrev-sm", Some(false));
    }

    #[test]
    fn nes_cycle_source_player_route_1840() {
        assert_listing_only_player_route("mstan-legendofzeldanesrecomp", Some(false));
    }

    #[test]
    fn nes_cycle_source_player_route_2739() {
        assert_listing_only_player_route("mstan-yoshinesrecomp", Some(false));
    }

    #[test]
    fn rechan_prepared_player_route_348() {
        assert_listing_only_player_route("jackie-chan-stuntmaster-rechan", Some(false));
    }

    #[test]
    fn crash_prepared_player_route_385() {
        assert_listing_only_player_route("crash-bandicoot-crashbandicoot-launcher", Some(false));
    }

    #[test]
    fn symphony_permitted_player_route_319() {
        assert_listing_only_player_route(
            "castlevania-symphony-of-the-night-ps1-symphonyrecomp",
            Some(false),
        );
    }

    #[test]
    fn rage_permitted_player_route_349() {
        assert_listing_only_player_route("rage-racer-rage-racer-pc", Some(true));
    }

    #[test]
    fn kameo_permitted_player_route_129() {
        assert_listing_only_player_route("kameo-repowered", Some(true));
    }

    #[test]
    fn redahm_permitted_player_route_130() {
        assert_listing_only_player_route(
            "redahm-destroy-all-humans-path-of-the-furon",
            Some(false),
        );
    }

    #[test]
    fn svr07_permitted_player_route_131() {
        assert_listing_only_player_route("svr07-recomp-wwe-smackdown-vs-raw-2007", Some(false));
    }

    #[test]
    fn valkyrie_prepared_product_route_491() {
        assert_listing_only_player_route("alexbeav-valkyrie-profile-recomp", Some(false));
    }

    #[test]
    fn dprecomp_permitted_prepared_runtime_route_812() {
        assert_listing_only_player_route("deadly-premonition-dprecomp", Some(true));
    }

    #[test]
    fn melee_static_prepared_player_route_814() {
        assert_listing_only_player_route("melee-unlocked", Some(false));
    }

    #[test]
    fn strikers_prepared_player_route_816() {
        assert_listing_only_player_route("super-mario-strikers-strikers", Some(false));
    }

    #[test]
    fn skate3_permitted_prepared_player_route_150() {
        assert_listing_only_player_route("skate-3-recomp", Some(true));
    }

    #[test]
    fn budokai3_prepared_player_route_366() {
        assert_listing_only_player_route(
            "dragon-ball-z-budokai-3-hd-budokai-3-hd-collection-recomp",
            Some(false),
        );
    }

    #[test]
    fn triaevum_prepared_player_route_515() {
        assert_listing_only_player_route("triaevum-ocarina-of-time-3d", Some(false));
    }

    #[test]
    fn arwing2_installed_player_route_1946() {
        assert_listing_only_player_route("star-fox-2-arwing2", Some(false));
    }

    #[test]
    fn ackman_permitted_player_route_2881() {
        assert_listing_only_player_route("go-go-ackman-go-go-ackman-recompiled", Some(true));
    }

    #[test]
    fn strike_gunner_prepared_player_route_2713() {
        assert_listing_only_player_route(
            "strike-gunner-s-t-g-strike-gunner-stg-recomp",
            Some(false),
        );
    }

    #[test]
    fn top_gear_direct_player_route_2905() {
        assert_listing_only_player_route("top-gear-snes-top-gear-for-windows", Some(false));
    }

    #[test]
    fn opentie_prepared_player_route_1975() {
        assert_listing_only_player_route("star-wars-tie-fighter-opentie", Some(false));
    }

    #[test]
    fn open_annihilation_settled_player_route_1635() {
        assert_listing_only_player_route("total-annihilation-open-annihilation", Some(false));
    }

    #[test]
    fn woodyre_prepared_player_route_1636() {
        assert_listing_only_player_route("woody-woodpecker-woodyre", Some(false));
    }

    #[test]
    fn reblue_prepared_player_preserves_strict_definition_route_56() {
        let id = "re-blue";
        let (temporary, mut service, executable, working) = fixture(id);
        service.catalog = Catalog::embedded().unwrap();
        let declared = service.catalog.port(id).unwrap();
        assert_eq!(declared.adapter, crate::AdapterKind::GeneratedCache);
        assert_ne!(declared.release.provider, ReleaseSource::UserPrepared);
        assert!(declared.source_profile.is_some());
        assert!(service.catalog.listing(id).unwrap().manual_setup.is_some());
        assert!(
            service
                .current_user_selected_definition(id)
                .unwrap()
                .is_none()
        );
        assert_selected_listing_lifecycle(temporary, service, executable, working, id);
    }

    #[test]
    fn redriver2_prepared_player_route_317() {
        assert_listing_only_player_route("driver-2-redriver2", Some(false));
    }

    // Bind the real embedded identities to Core's offered operations with an
    // owned native probe. These are not game/ROM observations. Separate cases
    // keep each complete consent/restart/launch/removal sequence independently
    // bounded by the ordinary harness; no case or assertion is sampled away.
    fn assert_prepared_player_route(id: &str, selected_arguments: Option<&[&str]>) {
        let (_temporary, mut service, executable, working) = fixture(id);
        service.catalog = Catalog::embedded().unwrap();
        // A new managed offer does not rewrite an existing registration's
        // creating contract. Unreplaced cases continue to bind current data.
        let retained_fixture = [
            include_str!("../testdata/reflectionhle-retained-selected-2026-10-28.json"),
            include_str!("../testdata/crispy-retained-selected-2026-10-29.json"),
            include_str!("../testdata/crispy-final-doom-retained-selected-2026-10-29.json"),
            include_str!("../testdata/bstone-retained-selected-2026-10-29.json"),
            include_str!("../testdata/devilution-retained-selected-2026-10-29.json"),
        ]
        .into_iter()
        .find(|fixture| Catalog::from_json(fixture).unwrap().port(id).is_ok());
        if let Some(fixture) = retained_fixture {
            assert_eq!(
                service.catalog.port(id).unwrap().adapter,
                crate::AdapterKind::NativePortable
            );
            service.catalog = Catalog::from_json(fixture)
                .unwrap()
                .with_embedded_listings()
                .unwrap();
        }
        let declared = service.catalog.port(id).unwrap();
        assert_eq!(declared.release.provider, ReleaseSource::UserPrepared);
        assert_eq!(
            declared.release.user_prepared[&Platform::WindowsX86_64].trust,
            crate::ExternalRuntimeTrust::UserSelected
        );
        assert!(declared.source_profile.is_none());
        assert!(declared.persistent_paths.is_empty());
        assert!(service.catalog.listing(id).unwrap().manual_setup.is_some());
        #[cfg(windows)]
        assert!(
            service
                .current_user_selected_definition(id)
                .unwrap()
                .is_some()
        );
        #[cfg(not(windows))]
        if declared
            .release
            .user_prepared
            .contains_key(&Platform::current().unwrap())
        {
            assert!(
                service
                    .current_user_selected_definition(id)
                    .unwrap()
                    .is_some()
            );
        }
        let executable_before = fs::read(&executable).unwrap();
        let selected_arguments = selected_arguments
            .map(|arguments| {
                arguments
                    .iter()
                    .map(|argument| (*argument).to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![id.into(), "literal argument with spaces".into()]);
        let arguments = ["--record".into(), "route-binding".into()]
            .into_iter()
            .chain(selected_arguments.iter().cloned())
            .collect::<Vec<_>>();
        let preview = service
            .preview_user_selected_runtime(id, &executable, &working, &arguments)
            .unwrap();
        assert!(
            service
                .register_user_selected_runtime(id, &executable, &working, &arguments, "")
                .is_err()
        );
        assert!(
            service
                .authorize_user_selected_runtime(
                    id,
                    &executable,
                    &working,
                    &[],
                    &preview.preview_sha256,
                )
                .is_err()
        );
        let authorization = service
            .authorize_user_selected_runtime(
                id,
                &executable,
                &working,
                &arguments,
                &preview.preview_sha256,
            )
            .unwrap();
        let record = service
            .register_user_selected_runtime(
                id,
                &executable,
                &working,
                &arguments,
                &authorization.token,
            )
            .unwrap();
        assert_eq!(record.executable, preview.executable);
        assert_eq!(record.path, preview.path);
        assert_eq!(record.user_selected.unwrap().arguments, arguments);
        #[cfg(windows)]
        {
            let (_, retained) = service
                .library
                .external_runtime_with_port(id)
                .unwrap()
                .unwrap();
            let selected =
                &retained.port(id).unwrap().release.user_prepared[&Platform::WindowsX86_64];
            let expected =
                &service.catalog.port(id).unwrap().release.user_prepared[&Platform::WindowsX86_64];
            assert_eq!(
                serde_json::to_value(selected).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
        }
        assert!(
            service
                .preview_user_selected_runtime(id, &executable, &working, &arguments)
                .is_err()
        );

        let root = service.library.root().to_path_buf();
        drop(service);
        let service = PortcoveService::new(Library::open(root).unwrap()).unwrap();
        if retained_fixture.is_some() {
            assert_eq!(
                service.catalog.port(id).unwrap().adapter,
                crate::AdapterKind::NativePortable
            );
        }
        #[cfg(windows)]
        if let Some(fixture) = retained_fixture {
            let (_, retained) = service
                .library
                .external_runtime_with_port(id)
                .unwrap()
                .unwrap();
            let expected = Catalog::from_json(fixture).unwrap();
            assert_eq!(
                serde_json::to_value(retained.port(id).unwrap()).unwrap(),
                serde_json::to_value(expected.port(id).unwrap()).unwrap()
            );
        }
        let status = service.listing_status(id).unwrap();
        assert!(
            status
                .actions
                .iter()
                .any(|action| { action.action == crate::ListingAction::Launch && action.allowed })
        );
        for action in [
            PortAction::Install,
            PortAction::Update,
            PortAction::RemoveManaged,
        ] {
            assert!(status.status.port_actions.iter().any(|assessment| {
                assessment.action == action
                    && assessment.availability == PortActionAvailability::NotOffered
            }));
        }
        assert!(service.rollback(id).is_err());
        let launch = service
            .supervise_launch(id, None, &[], LaunchStdio::Null, |_| {})
            .unwrap();
        assert!(launch.successful);
        assert_eq!(
            fs::read_to_string(working.join("route-binding")).unwrap(),
            selected_arguments.join("\n")
        );
        let removal = service.preview_external_removal(id).unwrap();
        let consent = service
            .authorize_external_removal(id, &removal.preview_sha256)
            .unwrap();
        service.remove_external_runtime(id, &consent.token).unwrap();
        assert_eq!(fs::read(&executable).unwrap(), executable_before);
        assert_eq!(
            fs::read(working.join("player-save.dat")).unwrap(),
            b"player save"
        );
        assert_eq!(
            fs::read_to_string(working.join("route-binding")).unwrap(),
            selected_arguments.join("\n")
        );
        assert!(
            service
                .library
                .external_runtime_with_port(id)
                .unwrap()
                .is_none()
        );
    }

    macro_rules! prepared_player_case {
        ($name:ident, $id:literal) => {
            #[test]
            fn $name() {
                assert_prepared_player_route($id, None);
            }
        };
        ($name:ident, $id:literal, [$($argument:literal),+ $(,)?]) => {
            #[test]
            fn $name() {
                assert_prepared_player_route($id, Some(&[$($argument),+]));
            }
        };
    }

    prepared_player_case!(
        cps_route_2769,
        "cps2recomp-alien-vs-predator",
        ["--play", "avsp"]
    );
    prepared_player_case!(
        cps_route_2770,
        "cps2recomp-cadillacs-and-dinosaurs",
        ["--play", "dino"]
    );
    prepared_player_case!(
        cps_route_2764,
        "cps2recomp-marvel-super-heroes",
        ["--play", "msh"]
    );
    prepared_player_case!(
        cps_route_2763,
        "cps2recomp-street-fighter-alpha-2",
        ["--play", "sfa2"]
    );
    prepared_player_case!(
        cps_route_2762,
        "cps2recomp-street-fighter-alpha",
        ["--play", "sfa"]
    );
    prepared_player_case!(
        cps_route_2780,
        "cps2recomp-super-gem-fighter-mini-mix",
        ["--play", "pocket_fighter"]
    );
    prepared_player_case!(
        cps_route_2765,
        "cps2recomp-super-puzzle-fighter-ii-turbo",
        ["--play", "puzzle_fighter"]
    );
    prepared_player_case!(
        cps_route_2782,
        "cps2recomp-vampire-hunter-2",
        ["--play", "vhunt2"]
    );
    prepared_player_case!(
        cps_route_2767,
        "cps2recomp-vampire-savior-2",
        ["--play", "vsav2"]
    );
    prepared_player_case!(
        cps_route_2768,
        "cps2recomp-vampire-savior-definitive",
        ["--play", "vsav_definitive"]
    );
    prepared_player_case!(
        cps_route_2766,
        "cps2recomp-vampire-savior",
        ["--play", "vampire_savior"]
    );
    prepared_player_case!(
        cps_route_2781,
        "cps2recomp-x-men-vs-street-fighter",
        ["--play", "xmvsf"]
    );

    prepared_player_case!(render96_selected_native_route_519, "render96ex");

    prepared_player_case!(classic_pc_route_1877, "lethal-guitar-rigelengine");
    prepared_player_case!(classic_pc_route_1793, "keriew-augustus");
    prepared_player_case!(classic_pc_route_1790, "elasota-aerofoil");
    prepared_player_case!(classic_pc_route_1826, "m-x-d-heretic2r");

    prepared_player_case!(classic_fps_route_1873, "bodbdearg-psydoom");
    prepared_player_case!(classic_fps_route_1812, "styd051-doom64-ex-plus-enhanced");
    prepared_player_case!(classic_fps_route_1899, "uzdoom-uzdoom");

    prepared_player_case!(wiicompiled_route_149, "mario-kart-wii-wiicompiled");
    prepared_player_case!(
        ringout_route_148,
        "soulcalibur-ii-ring-out",
        [
            "--user-dir",
            r"C:\Ring Out\userdata",
            "--game",
            r"C:\Ring Out\game",
            "--module",
            r"C:\Ring Out\bin\gGRSEAF_recomp.dll"
        ]
    );

    prepared_player_case!(historical_pc_route_369, "doom-rpg-doomrpg-re");
    prepared_player_case!(historical_pc_route_370, "doom-ii-rpg-doomiirpg-re");
    prepared_player_case!(historical_pc_route_371, "wolfenstein-rpg-wolfensteinrpg-re");
    prepared_player_case!(
        historical_pc_route_725,
        "openjkdf2-jedi-knight-dark-forces-ii"
    );

    prepared_player_case!(historical_route_zelda3, "zelda3");
    prepared_player_case!(historical_route_smw, "super-mario-world-snesrev-smw");
    prepared_player_case!(historical_route_sonic3air, "sonic-3-knuckles-sonic-3-a-i-r");
    prepared_player_case!(historical_route_sm64coopdx, "super-mario-64-sm64-co-op-dx");
    prepared_player_case!(historical_route_wipeout, "wipeout-phantom-edition");
    prepared_player_case!(historical_route_emerald, "pokemon-emerald-emeraldrecomp");
    prepared_player_case!(
        historical_route_firered,
        "pokemon-firered-fireredleafgreenrecomp"
    );
    prepared_player_case!(
        historical_route_leafgreen,
        "pokemon-leafgreen-fireredleafgreenrecomp"
    );
    prepared_player_case!(historical_route_ruby, "pokemon-ruby-rubysapphirerecomp");
    prepared_player_case!(
        historical_route_sapphire,
        "pokemon-sapphire-rubysapphirerecomp"
    );

    prepared_player_case!(
        native_engine_route_2592,
        "medal-of-honor-allied-assault-openmohaa"
    );
    prepared_player_case!(
        native_engine_route_2593,
        "medal-of-honor-allied-assault-spearhead-openmohaa"
    );
    prepared_player_case!(
        native_engine_route_2594,
        "medal-of-honor-allied-assault-breakthrough-openmohaa"
    );
    prepared_player_case!(
        native_engine_route_2565,
        "doom-3-classic-dude-doom-3-unified-development-engine"
    );
    prepared_player_case!(
        native_engine_route_2566,
        "doom-3-resurrection-of-evil-classic-dude-doom-3-unified-development-engine"
    );
    prepared_player_case!(
        native_engine_route_2612,
        "star-wars-jedi-knight-jedi-academy-single-player-and-multiplayer-openjk-openjo"
    );
    prepared_player_case!(
        native_engine_route_2611,
        "star-wars-jedi-knight-ii-jedi-outcast-single-player-openjk-openjo"
    );
    prepared_player_case!(
        native_engine_route_2889,
        "perimeter-perimeter-community-engine"
    );
    prepared_player_case!(
        native_engine_route_2890,
        "perimeter-emperor-s-testament-perimeter-community-engine"
    );
    prepared_player_case!(native_engine_route_2910, "zeus-master-of-olympus-ezeus");
    prepared_player_case!(
        native_engine_route_2911,
        "poseidon-master-of-atlantis-ezeus"
    );
    prepared_player_case!(
        native_engine_route_2707,
        "s-t-a-l-k-e-r-call-of-pripyat-openxray"
    );
    prepared_player_case!(native_engine_route_2708, "s-t-a-l-k-e-r-clear-sky-openxray");
    prepared_player_case!(native_engine_route_2701, "quake-iii-arena-ioquake3");
    prepared_player_case!(native_engine_route_2702, "quake-iii-team-arena-ioquake3");
    prepared_player_case!(
        native_engine_route_2605,
        "serious-sam-the-first-encounter-serioussamclassic"
    );
    prepared_player_case!(
        native_engine_route_2606,
        "serious-sam-the-second-encounter-serioussamclassic"
    );

    prepared_player_case!(
        historical_route_stadium,
        "pokemon-stadium-ss-anne-pokemonstadiumrecomp"
    );

    #[test]
    fn cps_shared_player_keeps_independent_game_intent_and_removal() {
        let ids = [
            "cps2recomp-street-fighter-alpha",
            "cps2recomp-alien-vs-predator",
        ];
        let (_temporary, mut service, executable, working) = fixture(ids[0]);
        service.catalog = Catalog::embedded().unwrap();
        let executable_before = fs::read(&executable).unwrap();
        for (id, game, observation) in [
            (ids[0], "sfa", "observed-sfa"),
            (ids[1], "avsp", "observed-avsp"),
        ] {
            #[cfg(windows)]
            assert!(
                service
                    .current_user_selected_definition(id)
                    .unwrap()
                    .is_some()
            );
            let arguments = vec![
                "--record".into(),
                observation.into(),
                "--play".into(),
                game.into(),
            ];
            let preview = service
                .preview_user_selected_runtime(id, &executable, &working, &arguments)
                .unwrap();
            let authorization = service
                .authorize_user_selected_runtime(
                    id,
                    &executable,
                    &working,
                    &arguments,
                    &preview.preview_sha256,
                )
                .unwrap();
            let other = if id == ids[0] { ids[1] } else { ids[0] };
            assert!(
                service
                    .register_user_selected_runtime(
                        other,
                        &executable,
                        &working,
                        &arguments,
                        &authorization.token,
                    )
                    .is_err()
            );
            let authorization = service
                .authorize_user_selected_runtime(
                    id,
                    &executable,
                    &working,
                    &arguments,
                    &preview.preview_sha256,
                )
                .unwrap();
            service
                .register_user_selected_runtime(
                    id,
                    &executable,
                    &working,
                    &arguments,
                    &authorization.token,
                )
                .unwrap();
            assert!(
                service
                    .supervise_launch(id, None, &[], LaunchStdio::Null, |_| {})
                    .unwrap()
                    .successful
            );
            assert_eq!(
                fs::read_to_string(working.join(observation)).unwrap(),
                format!("--play\n{game}")
            );
        }
        let root = service.library.root().to_path_buf();
        drop(service);
        let service = PortcoveService::new(Library::open(root).unwrap()).unwrap();
        for id in ids {
            assert!(service.status(id).unwrap().readiness.unwrap().launchable);
        }
        let preview = service.preview_external_removal(ids[0]).unwrap();
        let consent = service
            .authorize_external_removal(ids[0], &preview.preview_sha256)
            .unwrap();
        service
            .remove_external_runtime(ids[0], &consent.token)
            .unwrap();
        assert!(
            service
                .library
                .external_runtime_with_port(ids[0])
                .unwrap()
                .is_none()
        );
        assert!(
            service
                .library
                .external_runtime_with_port(ids[1])
                .unwrap()
                .is_some()
        );
        assert!(
            service
                .supervise_launch(ids[1], None, &[], LaunchStdio::Null, |_| {})
                .unwrap()
                .successful
        );
        assert_eq!(fs::read(&executable).unwrap(), executable_before);
        assert_eq!(
            fs::read(working.join("player-save.dat")).unwrap(),
            b"player save"
        );
        assert_eq!(
            fs::read_to_string(working.join("observed-sfa")).unwrap(),
            "--play\nsfa"
        );
        assert_eq!(
            fs::read_to_string(working.join("observed-avsp")).unwrap(),
            "--play\navsp"
        );
        let preview = service.preview_external_removal(ids[1]).unwrap();
        let consent = service
            .authorize_external_removal(ids[1], &preview.preview_sha256)
            .unwrap();
        service
            .remove_external_runtime(ids[1], &consent.token)
            .unwrap();
        assert_eq!(fs::read(&executable).unwrap(), executable_before);
        assert_eq!(
            fs::read(working.join("player-save.dat")).unwrap(),
            b"player save"
        );
    }

    #[test]
    fn pre_declaration_selected_registration_keeps_its_creating_listing_contract() {
        let id = "super-mario-64-sm64-co-op-dx";
        let (_temporary, mut service, executable, working) = fixture(id);
        let embedded = Catalog::embedded().unwrap();
        service.catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#)
            .unwrap()
            .with_listing_document(embedded.listing_document().clone())
            .unwrap();
        let record = register(&service, id, &executable, &working);
        let read_contract = |service: &PortcoveService| -> String {
            service.library.connection().unwrap().query_row(
                "SELECT retained_catalog_json FROM external_runtime_registrations WHERE port_id=?1",
                [id],
                |row| row.get(0),
            ).unwrap()
        };
        let before = read_contract(&service);
        let root = service.library.root().to_path_buf();
        drop(service);
        let service = PortcoveService::new(Library::open(root).unwrap()).unwrap();
        assert!(service.catalog.port(id).is_ok());
        let (retained_record, retained) = service
            .library
            .external_runtime_with_port(id)
            .unwrap()
            .unwrap();
        assert_eq!(retained_record.id, record.id);
        assert!(retained.port(id).is_err());
        assert_eq!(read_contract(&service), before);
        assert!(service.status(id).unwrap().readiness.unwrap().launchable);
        assert!(
            service
                .supervise_launch(id, None, &[], LaunchStdio::Null, |_| {})
                .unwrap()
                .successful
        );
        assert_eq!(read_contract(&service), before);
        let removal = service.preview_external_removal(id).unwrap();
        let consent = service
            .authorize_external_removal(id, &removal.preview_sha256)
            .unwrap();
        service.remove_external_runtime(id, &consent.token).unwrap();
        assert!(executable.is_file());
        assert_eq!(
            fs::read(working.join("player-save.dat")).unwrap(),
            b"player save"
        );
    }

    // Preserve all nine prior route case identities across the managed offer.
    prepared_player_case!(desktop_prepared_route_2683, "keen-dreams-reflectionhle");
    prepared_player_case!(
        desktop_prepared_route_2684,
        "catacomb-3-d-the-descent-reflectionhle"
    );
    prepared_player_case!(
        desktop_prepared_route_2685,
        "the-catacomb-abyss-reflectionhle"
    );
    prepared_player_case!(
        desktop_prepared_route_2686,
        "the-catacomb-armageddon-reflectionhle"
    );
    prepared_player_case!(
        desktop_prepared_route_2687,
        "the-catacomb-apocalypse-reflectionhle"
    );
    prepared_player_case!(desktop_prepared_route_2688, "wolfenstein-3d-reflectionhle");
    prepared_player_case!(
        desktop_prepared_route_2689,
        "spear-of-destiny-reflectionhle"
    );
    prepared_player_case!(
        desktop_prepared_route_2690,
        "super-3-d-noah-s-ark-dos-reflectionhle"
    );
    prepared_player_case!(desktop_prepared_route_2692, "bio-menace-reflectionhle");

    prepared_player_case!(
        desktop_prepared_route_2555,
        "blake-stone-aliens-of-gold-bstone"
    );
    prepared_player_case!(
        desktop_prepared_route_2556,
        "blake-stone-planet-strike-bstone"
    );
    prepared_player_case!(desktop_prepared_route_2652, "descent-dxx-rebirth");
    prepared_player_case!(desktop_prepared_route_2653, "descent-ii-dxx-rebirth");
    prepared_player_case!(
        desktop_prepared_route_2619,
        "ufo-enemy-unknown-x-com-ufo-defense-openxcom"
    );
    prepared_player_case!(
        desktop_prepared_route_2620,
        "x-com-terror-from-the-deep-openxcom"
    );
    prepared_player_case!(desktop_prepared_route_2628, "baldur-s-gate-original-gemrb");
    prepared_player_case!(
        desktop_prepared_route_2629,
        "baldur-s-gate-ii-original-gemrb"
    );
    prepared_player_case!(desktop_prepared_route_2630, "icewind-dale-original-gemrb");
    prepared_player_case!(desktop_prepared_route_2631, "icewind-dale-ii-gemrb");
    prepared_player_case!(
        desktop_prepared_route_2632,
        "planescape-torment-original-gemrb"
    );
    prepared_player_case!(desktop_prepared_route_2641, "cannon-fodder-open-fodder");
    prepared_player_case!(desktop_prepared_route_2642, "cannon-fodder-2-open-fodder");
    prepared_player_case!(
        desktop_prepared_route_2621,
        "ultima-vii-the-black-gate-exult"
    );
    prepared_player_case!(
        desktop_prepared_route_2622,
        "ultima-vii-part-two-serpent-isle-exult"
    );
    prepared_player_case!(desktop_prepared_route_2563, "diablo-devilutionx");
    prepared_player_case!(desktop_prepared_route_2564, "diablo-hellfire-devilutionx");
    prepared_player_case!(
        desktop_prepared_route_2616,
        "the-elder-scrolls-iii-morrowind-openmw"
    );
    prepared_player_case!(desktop_prepared_route_2567, "doom-3-classic-dhewm3");
    prepared_player_case!(
        desktop_prepared_route_2568,
        "doom-3-resurrection-of-evil-classic-dhewm3"
    );
    prepared_player_case!(
        desktop_prepared_route_2654,
        "doom-the-ultimate-doom-crispy-doom-family"
    );
    prepared_player_case!(desktop_prepared_route_2655, "doom-ii-crispy-doom-family");
    prepared_player_case!(desktop_prepared_route_2656, "final-doom-crispy-doom-family");
    prepared_player_case!(desktop_prepared_route_2657, "heretic-crispy-doom-family");
    prepared_player_case!(desktop_prepared_route_2662, "hexen-crispy-doom-family");
    prepared_player_case!(desktop_prepared_route_2663, "strife-crispy-doom-family");
    prepared_player_case!(
        desktop_prepared_route_2643,
        "catacomb-3-d-the-descent-catacombgl"
    );
    prepared_player_case!(desktop_prepared_route_2644, "the-catacomb-abyss-catacombgl");
    prepared_player_case!(
        desktop_prepared_route_2645,
        "the-catacomb-armageddon-catacombgl"
    );
    prepared_player_case!(
        desktop_prepared_route_2646,
        "the-catacomb-apocalypse-catacombgl"
    );
    prepared_player_case!(desktop_prepared_route_2648, "commander-keen-4-omnispeak");
    prepared_player_case!(desktop_prepared_route_2649, "commander-keen-5-omnispeak");
    prepared_player_case!(desktop_prepared_route_2650, "commander-keen-6-omnispeak");
    prepared_player_case!(desktop_prepared_route_2866, "pokemon-blue-gen1recomp");
    prepared_player_case!(desktop_prepared_route_2875, "pokemon-emerald-gen1recomp");
    prepared_player_case!(desktop_prepared_route_2871, "pokemon-firered-gen1recomp");
    prepared_player_case!(desktop_prepared_route_2872, "pokemon-leafgreen-gen1recomp");
    prepared_player_case!(desktop_prepared_route_2873, "pokemon-ruby-gen1recomp");
    prepared_player_case!(desktop_prepared_route_2874, "pokemon-sapphire-gen1recomp");
    prepared_player_case!(desktop_prepared_route_2867, "pokemon-yellow-gen1recomp");

    #[test]
    fn generic_route_beside_managed_definition_does_not_change_the_managed_contract() {
        let (_temporary, mut service, executable, working) = fixture("generic-alternative");
        service.catalog = Catalog::embedded().unwrap();
        let before = serde_json::to_value(service.catalog.port("shipwright").unwrap()).unwrap();
        let record = register(&service, "shipwright", &executable, &working);
        let status = service.status("shipwright").unwrap();
        assert!(status.readiness.unwrap().launchable);
        assert!(
            status
                .port_actions
                .iter()
                .any(|action| action.action == PortAction::Update
                    && action.availability == PortActionAvailability::NotOffered)
        );
        assert!(service.catalog.port("shipwright").is_ok());
        assert_eq!(
            serde_json::to_value(service.catalog.port("shipwright").unwrap()).unwrap(),
            before
        );
        assert!(record.retained_definition.is_none());
        let (_, retained) = service
            .library
            .external_runtime_with_port("shipwright")
            .unwrap()
            .unwrap();
        assert!(retained.port("shipwright").is_err());
    }

    #[test]
    fn vkquake_prepared_player_route_2697() {
        assert_listing_only_player_route("quake-vkquake", Some(false));
    }

    #[test]
    fn ironwail_prepared_player_route_2698() {
        assert_listing_only_player_route("quake-ironwail", Some(false));
    }

    #[test]
    fn fallout1_ce_prepared_player_route_2573() {
        assert_listing_only_player_route("fallout-fallout-community-edition", Some(false));
    }

    #[test]
    fn fallout2_ce_prepared_player_route_2574() {
        assert_listing_only_player_route("fallout-2-fallout-2-community-edition", Some(false));
    }

    #[test]
    fn arx_libertatis_prepared_player_route_2554() {
        assert_listing_only_player_route("arx-fatalis-arx-libertatis", Some(false));
    }

    #[test]
    fn iortcw_sp_prepared_player_route_2706() {
        assert_listing_only_player_route("return-to-castle-wolfenstein-iortcw", Some(false));
    }

    #[test]
    fn yamagi_direct_player_route_2700() {
        assert_listing_only_player_route("quake-ii-yamagi-quake-ii", Some(false));
    }

    #[test]
    fn sdlpop_permitted_player_route_2892() {
        assert_listing_only_player_route("prince-of-persia-dos-sdlpop", Some(false));
    }

    #[test]
    fn accepted_user_selected_definition_preserves_creation_and_public_status_contract() {
        let (_temporary, mut service, executable, working) = fixture("legacy-description");
        let mut document = serde_json::to_value(service.catalog.authoritative_document()).unwrap();
        document["ports"][0]["summary"] = json!("");
        service.catalog = Catalog::from_json(&document.to_string()).unwrap();
        // New authoring has its own stricter descriptive admission; an already
        // accepted strict selected route keeps its historic creation behavior.
        assert!(service.catalog.listing_document().validate().is_err());
        register(&service, "legacy-description", &executable, &working);
        let (_, retained) = service
            .library
            .external_runtime_with_port("legacy-description")
            .unwrap()
            .unwrap();
        assert_eq!(retained.port("legacy-description").unwrap().summary, "");

        // These are the existing public PortStatus consumer invariants, not
        // backup inventory actions or a new client-specific compatibility path.
        let single = service.status("legacy-description").unwrap();
        let batch = service.statuses().unwrap().pop().unwrap();
        for status in [single, batch] {
            assert!(!status.port_actions.iter().any(|assessment| matches!(
                assessment.action,
                PortAction::BackupCreate | PortAction::BackupRestore
            )));
            for (action, availability, reason) in [
                (
                    PortAction::Update,
                    PortActionAvailability::NotOffered,
                    PortActionReason::RouteNotOffered,
                ),
                (
                    PortAction::Rollback,
                    PortActionAvailability::NotOffered,
                    PortActionReason::NotInstalled,
                ),
                (
                    PortAction::RemoveExternal,
                    PortActionAvailability::Waiting,
                    PortActionReason::ReviewRequired,
                ),
            ] {
                let assessments = status
                    .port_actions
                    .iter()
                    .filter(|assessment| assessment.action == action)
                    .collect::<Vec<_>>();
                assert_eq!(assessments.len(), 1);
                assert_eq!(assessments[0].availability, availability);
                assert_eq!(assessments[0].reason, reason);
            }
        }
    }

    #[test]
    fn legacy_selected_contract_relinks_without_rewriting_its_retained_bytes() {
        let (_temporary, service, executable, working) = fixture("retained-selected");
        let record = register(&service, "retained-selected", &executable, &working);
        service.library.remove_external_runtime(&record).unwrap();
        service
            .library
            .register_external_runtime(&record, &service.catalog)
            .unwrap();
        let read_contract = || {
            service.library.connection().unwrap().query_row(
            "SELECT retained_catalog_json FROM external_runtime_registrations WHERE port_id=?1",
            ["retained-selected"], |row| row.get::<_, String>(0),
        ).unwrap()
        };
        let before = read_contract();
        let envelope: serde_json::Value = serde_json::from_str(&before).unwrap();
        assert_eq!(envelope["format"], 5);
        let arguments = vec!["--help".into()];
        let preview = service
            .preview_user_selected_runtime_relink(
                "retained-selected",
                &executable,
                &working,
                &arguments,
            )
            .unwrap();
        let consent = service
            .authorize_user_selected_runtime_relink(
                "retained-selected",
                &executable,
                &working,
                &arguments,
                &preview.preview_sha256,
            )
            .unwrap();
        service
            .relink_user_selected_runtime(
                "retained-selected",
                &executable,
                &working,
                &arguments,
                &consent.token,
            )
            .unwrap();
        assert_eq!(read_contract(), before);
        assert!(
            service
                .status("retained-selected")
                .unwrap()
                .readiness
                .unwrap()
                .launchable
        );
    }

    #[test]
    fn managed_installation_blocks_generic_registration_without_changing_files() {
        let (_temporary, service, executable, working) = fixture("owned-route");
        service
            .library
            .register_install(
                &InstallRecord {
                    id: Uuid::new_v4().to_string(),
                    port_id: "owned-route".into(),
                    version: "v1".into(),
                    path: service.library.root().join("versions/owned-route/v1"),
                    channel: ReleaseChannel::Stable,
                    installed_at: Library::now(),
                    verified: false,
                    staged: true,
                    artifact: crate::ArtifactIdentity::default(),
                    runtime: None,
                    manifest_sha256: String::new(),
                    selected_executable: PathBuf::from("game"),
                },
                false,
            )
            .unwrap();
        assert!(
            service
                .preview_user_selected_runtime("owned-route", &executable, &working, &[])
                .unwrap_err()
                .message
                .contains("already has an installation")
        );
        assert!(executable.is_file());
        assert_eq!(
            fs::read(working.join("player-save.dat")).unwrap(),
            b"player save"
        );
    }

    #[test]
    fn user_selected_production_launch_restart_and_removal_preserve_external_bytes() {
        // Two independent definitions reuse the same capability with case data.
        // The executable is the repository's owned native probe, not an observed game.
        for id in ["selected-a", "selected-b"] {
            let (_temporary, service, executable, working) = fixture(id);
            let record = register(&service, id, &executable, &working);
            assert!(record.user_selected.is_some());
            let retained = service
                .library
                .external_runtime_with_port(id)
                .unwrap()
                .unwrap();
            let bytes: String = service.library.connection().unwrap().query_row("SELECT retained_catalog_json FROM external_runtime_registrations WHERE port_id=?1", [id], |row| row.get(0)).unwrap();
            let envelope: serde_json::Value = serde_json::from_str(&bytes).unwrap();
            assert_eq!(envelope["format"], 5);
            assert_eq!(envelope["external_trust"], "user-selected");
            assert!(retained.1.port(id).is_ok());
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            #[allow(dead_code)]
            struct PriorEnvelope {
                format: u32,
                original_format: Option<u32>,
                preparation_mode: Option<serde_json::Value>,
                port_id: String,
                catalog_json: Option<String>,
                definition: Option<serde_json::Value>,
                admission: Option<serde_json::Value>,
            }
            assert!(
                serde_json::from_str::<PriorEnvelope>(&bytes).is_err(),
                "prior strict readers must refuse new execution semantics"
            );
            assert_eq!(retained.0.id, record.id);
            let library_root = service.library.root().to_path_buf();
            drop(service);
            // The current embedded catalog does not contain these synthetic
            // identities. Restart must use the exact retained definition.
            let service = PortcoveService::new(Library::open(library_root).unwrap()).unwrap();
            let status = service.status(id).unwrap();
            assert!(status.readiness.unwrap().launchable);
            assert!(
                status
                    .port_actions
                    .iter()
                    .any(|action| action.action == crate::PortAction::Update
                        && action.availability == crate::PortActionAvailability::NotOffered)
            );
            assert!(service.rollback(id).is_err());
            let result = service
                .supervise_launch(id, None, &[], LaunchStdio::Null, |_| {})
                .unwrap();
            assert!(result.successful);
            let connection = service.library.connection().unwrap();
            let owner: String = connection
                .query_row(
                    "SELECT owner_kind FROM launch_sessions WHERE id=?1",
                    [&result.session_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(owner, "external");
            let removal = service.preview_external_removal(id).unwrap();
            let authorization = service
                .authorize_external_removal(id, &removal.preview_sha256)
                .unwrap();
            service
                .remove_external_runtime(id, &authorization.token)
                .unwrap();
            assert!(executable.is_file());
            assert_eq!(
                fs::read(working.join("player-save.dat")).unwrap(),
                b"player save"
            );
            assert!(
                service
                    .library
                    .external_runtime_with_port(id)
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn user_selected_review_refuses_changed_details_and_managed_or_script_paths() {
        let (_temporary, service, executable, working) = fixture("selected-negative");
        let preview = service
            .preview_user_selected_runtime("selected-negative", &executable, &working, &[])
            .unwrap();
        assert!(
            service
                .authorize_user_selected_runtime(
                    "selected-negative",
                    &executable,
                    &working,
                    &["different".into()],
                    &preview.preview_sha256
                )
                .is_err()
        );
        assert!(
            service
                .preview_external_runtime("selected-negative", &working)
                .is_err()
        );
        assert!(
            service
                .preview_user_selected_runtime(
                    "selected-negative",
                    &executable,
                    service.library.root(),
                    &[]
                )
                .is_err()
        );
        let script = working.join("game.cmd");
        fs::write(&script, b"@echo unsafe\n").unwrap();
        assert!(
            service
                .preview_user_selected_runtime("selected-negative", &script, &working, &[])
                .is_err()
        );
        assert!(
            service
                .preview_user_selected_runtime(
                    "selected-negative",
                    &executable,
                    &working,
                    &["nul\0argument".into()]
                )
                .is_err()
        );
        assert!(
            service
                .preview_user_selected_runtime(
                    "selected-negative",
                    Path::new("relative.exe"),
                    &working,
                    &[]
                )
                .is_err()
        );
        let record = register(&service, "selected-negative", &executable, &working);
        let removal = service
            .preview_external_removal("selected-negative")
            .unwrap();
        fs::remove_dir_all(&working).unwrap();
        let authorization = service
            .authorize_external_removal("selected-negative", &removal.preview_sha256)
            .unwrap();
        assert_eq!(
            service
                .remove_external_runtime("selected-negative", &authorization.token)
                .unwrap()
                .id,
            record.id
        );
    }

    #[test]
    fn user_selected_launch_rechecks_native_paths_immediately_before_spawn() {
        struct ReplaceBeforeSpawn(PathBuf);
        impl crate::operation::LifecycleFaultInjector for ReplaceBeforeSpawn {
            fn check(&self, point: crate::operation::LifecycleFaultPoint) -> Result<()> {
                if point == crate::operation::LifecycleFaultPoint::LaunchReadyToSpawn {
                    fs::write(&self.0, b"not a native executable")?;
                }
                Ok(())
            }
        }
        let (_temporary, mut service, executable, working) = fixture("selected-spawn-check");
        register(&service, "selected-spawn-check", &executable, &working);
        service.faults = Arc::new(ReplaceBeforeSpawn(executable));
        let error = service
            .supervise_launch("selected-spawn-check", None, &[], LaunchStdio::Null, |_| {})
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("native game executable"));
        let child_pid: Option<u32> = service
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT child_pid FROM launch_sessions WHERE port_id=?1",
                ["selected-spawn-check"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(child_pid.is_none());
        assert_eq!(
            fs::read(working.join("player-save.dat")).unwrap(),
            b"player save"
        );
    }

    fn claim_output(library: &Library, path: &Path) -> Result<()> {
        library.register_output_root(&crate::library::OutputRootRecord {
            path: path.to_path_buf(),
            port_id: "another-managed-port".into(),
            marker_id: Uuid::new_v4().to_string(),
            volume_identity: "synthetic-volume".into(),
        })
    }

    #[test]
    fn user_selected_refuses_known_external_managed_outputs_and_retained_versions() {
        for version_only in [false, true] {
            let (_temporary, service, executable, working) = fixture("selected-managed-overlap");
            // An unrelated unavailable recorded root is metadata, not a reason
            // to require that drive or inspect any foreign installation.
            claim_output(
                &service.library,
                &working.with_file_name("unavailable-unrelated-output"),
            )
            .unwrap();
            register(&service, "selected-managed-overlap", &executable, &working);
            if version_only {
                service
                    .library
                    .register_install(
                        &crate::InstallRecord {
                            id: Uuid::new_v4().to_string(),
                            port_id: "another-managed-port".into(),
                            version: "historical-v1".into(),
                            path: working.clone(),
                            channel: ReleaseChannel::Stable,
                            installed_at: Library::now(),
                            verified: false,
                            staged: true,
                            artifact: crate::ArtifactIdentity::default(),
                            runtime: None,
                            manifest_sha256: String::new(),
                            selected_executable: PathBuf::from("game.exe"),
                        },
                        false,
                    )
                    .unwrap();
            } else {
                claim_output(&service.library, &working).unwrap();
            }
            assert!(
                service
                    .preview_user_selected_runtime(
                        "selected-managed-overlap",
                        &executable,
                        &working,
                        &[]
                    )
                    .unwrap_err()
                    .message
                    .contains("managed installation or claimed output")
            );
            assert!(
                !service
                    .status("selected-managed-overlap")
                    .unwrap()
                    .readiness
                    .unwrap()
                    .launchable
            );
            assert!(
                service
                    .supervise_launch(
                        "selected-managed-overlap",
                        None,
                        &[],
                        LaunchStdio::Null,
                        |_| {}
                    )
                    .unwrap_err()
                    .message
                    .contains("managed installation or claimed output")
            );
            assert_eq!(
                fs::read(working.join("player-save.dat")).unwrap(),
                b"player save"
            );
        }
    }

    #[test]
    fn user_selected_refuses_a_managed_output_claim_appearing_at_spawn() {
        struct ClaimBeforeSpawn {
            library: Library,
            path: PathBuf,
        }
        impl crate::operation::LifecycleFaultInjector for ClaimBeforeSpawn {
            fn check(&self, point: crate::operation::LifecycleFaultPoint) -> Result<()> {
                if point == crate::operation::LifecycleFaultPoint::LaunchReadyToSpawn {
                    claim_output(&self.library, &self.path)?;
                }
                Ok(())
            }
        }
        let (_temporary, mut service, executable, working) = fixture("selected-managed-spawn");
        register(&service, "selected-managed-spawn", &executable, &working);
        service.faults = Arc::new(ClaimBeforeSpawn {
            library: service.library.clone(),
            path: working.clone(),
        });
        assert!(
            service
                .supervise_launch(
                    "selected-managed-spawn",
                    None,
                    &[],
                    LaunchStdio::Null,
                    |_| {}
                )
                .unwrap_err()
                .message
                .contains("managed installation or claimed output")
        );
        let child_pid: Option<u32> = service
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT child_pid FROM launch_sessions WHERE port_id=?1",
                ["selected-managed-spawn"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(child_pid.is_none());
        assert_eq!(
            fs::read(working.join("player-save.dat")).unwrap(),
            b"player save"
        );
    }

    #[test]
    fn user_selected_catalog_rejects_authenticity_and_ownership_ambiguity() {
        let (_temporary, service, _, _) = fixture("selected-contract");
        let original = serde_json::to_value(service.catalog.authoritative_document()).unwrap();
        let platform = serde_json::to_value(Platform::current().unwrap())
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        for (key, value) in [
            ("archive_sha256", json!("a".repeat(64))),
            ("trust", json!("unknown-trust")),
            ("library_user_data", json!(true)),
            ("source_directory_environment", json!(true)),
            ("executable", json!("game.exe")),
        ] {
            let mut changed = original.clone();
            changed["ports"][0]["release"]["user_prepared"][&platform][key] = value;
            assert!(Catalog::from_json(&changed.to_string()).is_err(), "{key}");
        }
        let mut changed = original;
        changed["ports"][0]["launch_environment"] = json!({"SECRET":"value"});
        assert!(Catalog::from_json(&changed.to_string()).is_err());
    }

    #[test]
    fn dune_ii_opendune_prepared_player_route_2674() {
        assert_listing_only_player_route("dune-ii-opendune", Some(false));
    }

    #[test]
    fn dune_ii_dune_dynasty_prepared_player_route_2569() {
        assert_listing_only_player_route("dune-ii-dune-dynasty", Some(false));
    }

    #[test]
    fn might_and_magic_vii_openenroth_prepared_player_route_2885() {
        assert_listing_only_player_route("might-and-magic-vii-openenroth", Some(false));
    }

    #[test]
    fn gothic_ii_night_of_the_raven_opengothic_prepared_player_route_2578() {
        assert_listing_only_player_route("gothic-ii-night-of-the-raven-opengothic", Some(false));
    }

    #[test]
    fn jazz_jackrabbit_2_jazz2_resurrection_prepared_player_route_2682() {
        assert_listing_only_player_route("jazz-jackrabbit-2-jazz2-resurrection", Some(false));
    }

    #[test]
    fn heroes_of_might_and_magic_ii_fheroes2_prepared_player_route_2582() {
        assert_listing_only_player_route("heroes-of-might-and-magic-ii-fheroes2", Some(false));
    }

    #[test]
    fn transport_tycoon_deluxe_openttd_upstream_prepared_player_route_2716() {
        assert_listing_only_player_route("transport-tycoon-deluxe-openttd-upstream", Some(false));
    }

    #[test]
    fn half_life_xash3d_fwgs_prepared_player_route_2678() {
        assert_listing_only_player_route("half-life-xash3d-fwgs", Some(false));
    }

    #[test]
    fn freespace_2_freespace_open_prepared_player_route_2677() {
        assert_listing_only_player_route("freespace-2-freespace-open", Some(false));
    }

    #[test]
    fn pharaoh_akhenaten_prepared_player_route_2891() {
        assert_listing_only_player_route("pharaoh-akhenaten", Some(false));
    }

    #[test]
    fn midtown_madness_sneak_preview_beta_build_1560_open1560_prepared_player_route_2884() {
        assert_listing_only_player_route(
            "midtown-madness-sneak-preview-beta-build-1560-open1560",
            Some(false),
        );
    }

    #[test]
    fn need_for_speed_iii_hot_pursuit_nfs_recompiled_prepared_player_route_2888() {
        assert_listing_only_player_route(
            "need-for-speed-iii-hot-pursuit-nfs-recompiled",
            Some(false),
        );
    }

    #[test]
    fn smbx_13_thextech_prepared_player_route_2731() {
        assert_listing_only_player_route("smbx-13-thextech", Some(false));
    }

    #[test]
    fn ambermoon_permitted_copy_keeps_fresh_acquisition_held_2625() {
        assert_listing_only_player_route("ambermoon-ambermoon-net", Some(true));
    }
    #[test]
    fn cave_story_nxengine_evo_prepared_player_route_2647() {
        assert_listing_only_player_route("cave-story-nxengine-evo", Some(false));
    }

    #[test]
    fn chasm_the_rift_panzerchasm_prepared_player_route_2878() {
        assert_listing_only_player_route("chasm-the-rift-panzerchasm", Some(false));
    }

    #[test]
    fn urban_chaos_openchaos_prepared_player_route_2906() {
        assert_listing_only_player_route("urban-chaos-openchaos", Some(false));
    }

    #[test]
    fn tomb_raider_openlara_prepared_player_route_2904() {
        assert_listing_only_player_route("tomb-raider-openlara", Some(false));
    }
    #[test]
    fn need_for_speed_ii_special_edition_nfs_recompiled_prepared_player_route_2887() {
        assert_listing_only_player_route(
            "need-for-speed-ii-special-edition-nfs-recompiled",
            Some(false),
        );
    }

    #[test]
    fn the_operative_no_one_lives_forever_goty_nolf1_modern_nolfsrc_prepared_player_route_2902() {
        assert_listing_only_player_route(
            "the-operative-no-one-lives-forever-goty-nolf1-modern-nolfsrc",
            Some(false),
        );
    }

    #[test]
    fn need_for_speed_ii_special_edition_nfsiise_prepared_player_route_2886() {
        assert_listing_only_player_route("need-for-speed-ii-special-edition-nfsiise", Some(false));
    }

    #[test]
    fn syndicate_wars_syndicate_wars_fan_expansion_prepared_player_route_2715() {
        assert_listing_only_player_route(
            "syndicate-wars-syndicate-wars-fan-expansion",
            Some(false),
        );
    }

    #[test]
    fn heart_of_darkness_hode_prepared_player_route_2882() {
        assert_listing_only_player_route("heart-of-darkness-hode", Some(false));
    }

    #[test]
    fn master_of_orion_1oom_vanilla_branch_prepared_player_route_2883() {
        assert_listing_only_player_route("master-of-orion-1oom-vanilla-branch", Some(false));
    }

    #[test]
    fn elite_force_holomatch_lilium_voyager_prepared_player_route_1918() {
        assert_listing_only_player_route("elite-force-holomatch-lilium-voyager", Some(false));
    }

    #[test]
    fn wolfenstein_enemy_territory_et_legacy_prepared_player_route_2721() {
        assert_listing_only_player_route("wolfenstein-enemy-territory-et-legacy", Some(false));
    }

    #[test]
    fn zuma_deluxe_zuma_portable_circleshootapp_prepared_player_route_2912() {
        assert_listing_only_player_route("zuma-deluxe-zuma-portable-circleshootapp", Some(false));
    }

    #[test]
    fn cut_the_rope_dx_prepared_player_route_1128() {
        assert_listing_only_player_route("cut-the-rope-dx", Some(false));
    }

    #[test]
    fn metal_gear_solid_integral_reintegral_prepared_player_route_2106() {
        assert_listing_only_player_route("metal-gear-solid-integral-reintegral", Some(false));
    }

    #[test]
    fn sonic_unleashed_recompiled_prepared_player_route_126() {
        assert_listing_only_player_route("sonic-unleashed-recompiled", Some(false));
    }

    #[test]
    fn dead_rising_2_case_zero_recomp_prepared_player_route_1121() {
        assert_listing_only_player_route("dead-rising-2-case-zero-recomp", Some(true));
    }

    #[test]
    fn mega_man_x4_recompiled_prepared_player_route_144() {
        assert_listing_only_player_route("mega-man-x4-recompiled", Some(false));
    }

    #[test]
    fn viva_pinata_trouble_in_paradise_retip_prepared_player_route_158() {
        assert_listing_only_player_route("viva-pinata-trouble-in-paradise-retip", Some(false));
    }

    #[test]
    fn odrannnn_metroidprimeport_prepared_player_route_1846() {
        assert_listing_only_player_route("odrannnn-metroidprimeport", Some(true));
    }

    #[test]
    fn naughty_bear_gold_edition_restuff_prepared_player_route_160() {
        assert_listing_only_player_route("naughty-bear-gold-edition-restuff", Some(false));
    }

    #[test]
    fn lollipop_chainsaw_re_cherry_prepared_player_route_162() {
        assert_listing_only_player_route("lollipop-chainsaw-re-cherry", Some(true));
    }

    #[test]
    fn kileak_the_dna_imperative_ktdir_prepared_player_route_324() {
        assert_listing_only_player_route("kileak-the-dna-imperative-ktdir", Some(false));
    }

    #[test]
    fn sexy_parodius_sexyparorecomp_prepared_player_route_325() {
        assert_listing_only_player_route("sexy-parodius-sexyparorecomp", Some(false));
    }

    #[test]
    fn snowboard_kids_frontend_license_player_route_1354() {
        assert_listing_only_player_route("snowboard-kids", Some(true));
    }

    #[test]
    fn cdlewis_snowboardkids_recomp_frontend_license_player_route_1886() {
        assert_listing_only_player_route("cdlewis-snowboardkids-recomp", Some(true));
    }

    #[test]
    fn vidanox_banjotooierecompiled_frontend_license_player_route_1795() {
        assert_listing_only_player_route("vidanox-banjotooierecompiled", Some(true));
    }

    #[test]
    fn dahsidiabdallah_conkerbfdreloaded_frontend_license_player_route_1806() {
        assert_listing_only_player_route("dahsidiabdallah-conkerbfdreloaded", Some(false));
    }

    #[test]
    fn danielgomesvieira2000_beetle_adventure_racing_recomp_frontend_license_player_route_1800() {
        assert_listing_only_player_route(
            "danielgomesvieira2000-beetle-adventure-racing-recomp",
            Some(false),
        );
    }

    #[test]
    fn body_harvest_recompiled_frontend_license_player_route_1448() {
        assert_listing_only_player_route("body-harvest-recompiled", Some(false));
    }

    #[test]
    fn cbfd_recompiled_sciaschi_frontend_license_player_route_1216() {
        assert_listing_only_player_route("cbfd-recompiled-sciaschi", Some(false));
    }

    #[test]
    fn blast_corps_recompiled_permitted_player_route_2558() {
        assert_listing_only_player_route("blast-corps-blastcorps-recompiled", Some(true));
    }
    #[test]
    fn final_fantasy_tactics_finfantacrecomp_prepared_player_route_327() {
        assert_listing_only_player_route("final-fantasy-tactics-finfantacrecomp", Some(true));
    }

    #[test]
    fn einhander_einhander_recompiled_prepared_player_route_350() {
        assert_listing_only_player_route("einhander-einhander-recompiled", Some(false));
    }

    #[test]
    fn syphon_filter_sf_pc_port_prepared_player_route_344() {
        assert_listing_only_player_route("syphon-filter-sf-pc-port", Some(false));
    }

    #[test]
    fn silent_hill_silent_hill_decomp_pc_branch_prepared_player_route_351() {
        assert_listing_only_player_route("silent-hill-silent-hill-decomp-pc-branch", Some(true));
    }

    #[test]
    fn tenchu_stealth_assassins_tenchu_sa_recomp_prepared_player_route_353() {
        assert_listing_only_player_route("tenchu-stealth-assassins-tenchu-sa-recomp", Some(true));
    }

    #[test]
    fn exit_rexglue_exit_exit1_prepared_player_route_362() {
        assert_listing_only_player_route("exit-rexglue-exit-exit1", Some(false));
    }

    #[test]
    fn exit_2_rexglue_exit_exit2_prepared_player_route_363() {
        assert_listing_only_player_route("exit-2-rexglue-exit-exit2", Some(false));
    }

    #[test]
    fn fable_ii_recomp_prepared_player_route_1124() {
        assert_listing_only_player_route("fable-ii-recomp", Some(false));
    }

    #[test]
    fn eternal_sonata_reprise_prepared_player_route_1126() {
        assert_listing_only_player_route("eternal-sonata-reprise", Some(false));
    }

    #[test]
    fn dead_rising_2_case_west_recomp_prepared_player_route_1122() {
        assert_listing_only_player_route("dead-rising-2-case-west-recomp", Some(true));
    }

    #[test]
    fn condemned_2_bloodshot_condemned2recomp_prepared_player_route_361() {
        assert_listing_only_player_route("condemned-2-bloodshot-condemned2recomp", Some(true));
    }

    #[test]
    fn guitar_hero_warriors_of_rock_re_wor_prepared_player_route_359() {
        assert_listing_only_player_route("guitar-hero-warriors-of-rock-re-wor", Some(false));
    }

    #[test]
    fn project_gotham_racing_4_pgr4_recomp_prepared_player_route_360() {
        assert_listing_only_player_route("project-gotham-racing-4-pgr4-recomp", Some(false));
    }

    #[test]
    fn silent_hill_downpour_downpourrecomp_prepared_player_route_358() {
        assert_listing_only_player_route("silent-hill-downpour-downpourrecomp", Some(true));
    }

    #[test]
    fn tony_hawks_project_8_recomp_prepared_player_route_1125() {
        assert_listing_only_player_route("tony-hawks-project-8-recomp", Some(true));
    }

    #[test]
    fn sonic_free_riders_recompiled_prepared_player_route_1450() {
        assert_listing_only_player_route("sonic-free-riders-recompiled", Some(true));
    }

    #[test]
    fn x_men_destiny_xmd_recompiled_prepared_player_route_365() {
        assert_listing_only_player_route("x-men-destiny-xmd-recompiled", Some(false));
    }

    #[test]
    fn sega_superstars_tennis_rematch_prepared_player_route_378() {
        assert_listing_only_player_route("sega-superstars-tennis-rematch", Some(false));
    }

    #[test]
    fn street_fighter_ex_plus_alpha_recomp_prepared_player_route_1116() {
        assert_listing_only_player_route("street-fighter-ex-plus-alpha-recomp", Some(false));
    }

    #[test]
    fn street_fighter_ex2_plus_recompiled_prepared_player_route_1117() {
        assert_listing_only_player_route("street-fighter-ex2-plus-recompiled", Some(false));
    }

    #[test]
    fn strider_2_recompiled_prepared_player_route_1118() {
        assert_listing_only_player_route("strider-2-recompiled", Some(false));
    }

    #[test]
    fn wwf_smackdown_2_know_your_role_recomp_prepared_player_route_1396() {
        assert_listing_only_player_route("wwf-smackdown-2-know-your-role-recomp", Some(false));
    }

    #[test]
    fn space_channel_5_native_prepared_player_route_1540() {
        assert_listing_only_player_route("space-channel-5-native", Some(false));
    }

    #[test]
    fn kirbys_return_to_dream_land_kirby_wii_recomp_prepared_player_route_1131() {
        assert_listing_only_player_route(
            "kirbys-return-to-dream-land-kirby-wii-recomp",
            Some(false),
        );
    }

    #[test]
    fn unchiga_yu_gi_oh_forbidden_memories_recompiled_prepared_player_route_1910() {
        assert_listing_only_player_route(
            "unchiga-yu-gi-oh-forbidden-memories-recompiled",
            Some(true),
        );
    }

    #[test]
    fn james2doyle_ffta_recomp_prepared_player_route_2824() {
        assert_listing_only_player_route("james2doyle-ffta-recomp", Some(true));
    }

    #[test]
    fn final_fantasy_tactics_advance_fftarecomp_prepared_player_route_2575() {
        assert_listing_only_player_route("final-fantasy-tactics-advance-fftarecomp", Some(false));
    }

    #[test]
    fn kingdom_hearts_chain_of_memories_gba_rekhcom_prepared_player_route_2586() {
        assert_listing_only_player_route(
            "kingdom-hearts-chain-of-memories-gba-rekhcom",
            Some(true),
        );
    }

    #[test]
    fn vibecodekun_shantaerecomp_prepared_player_route_1881() {
        assert_listing_only_player_route("vibecodekun-shantaerecomp", Some(true));
    }

    #[test]
    fn monster_hunter_portable_3rd_hd_yakumo_prepared_player_route_1120() {
        assert_listing_only_player_route("monster-hunter-portable-3rd-hd-yakumo", Some(false));
    }

    #[test]
    fn mario_party_4_party_board_prepared_player_route_1130() {
        assert_listing_only_player_route("mario-party-4-party-board", Some(false));
    }

    #[test]
    fn pokemon_platinum_pokeplatinum_pc_port_lead_prepared_player_route_373() {
        assert_listing_only_player_route("pokemon-platinum-pokeplatinum-pc-port-lead", Some(false));
    }

    #[test]
    fn ace_combat_5_static_recompilation_prepared_player_route_1119() {
        assert_listing_only_player_route("ace-combat-5-static-recompilation", Some(false));
    }

    #[test]
    fn ace_combat_x_skies_of_deception_ace_combat_x_recompilation_prepared_player_route_355() {
        assert_listing_only_player_route(
            "ace-combat-x-skies-of-deception-ace-combat-x-recompilation",
            Some(false),
        );
    }

    #[test]
    fn star_wars_episode_iii_revenge_of_the_sith_prepared_player_route_1310() {
        assert_listing_only_player_route("star-wars-episode-iii-revenge-of-the-sith", Some(false));
    }

    #[test]
    fn the_simpsons_game_thesimpsonsgamerecomp_prepared_player_route_379() {
        assert_listing_only_player_route("the-simpsons-game-thesimpsonsgamerecomp", Some(false));
    }

    #[test]
    fn abilliontokens_sims1_recomp_prepared_player_route_2733() {
        assert_listing_only_player_route("abilliontokens-sims1-recomp", Some(false));
    }

    #[test]
    fn abilliontokens_sims2_recomp_prepared_player_route_2752() {
        assert_listing_only_player_route("abilliontokens-sims2-recomp", Some(false));
    }

    #[test]
    fn abilliontokens_urbz_recomp_prepared_player_route_2813() {
        assert_listing_only_player_route("abilliontokens-urbz-recomp", Some(false));
    }

    #[test]
    fn bitsandbreakpoints_d_psx_pc_recomp_prepared_player_route_2741() {
        assert_listing_only_player_route("bitsandbreakpoints-d-psx-pc-recomp", Some(false));
    }

    #[test]
    fn bluddy_rails_prepared_player_route_2787() {
        assert_listing_only_player_route("bluddy-rails", Some(false));
    }

    #[test]
    fn legend_of_legaia_legend_of_legaia_recomp_prepared_player_route_352() {
        assert_listing_only_player_route("legend-of-legaia-legend-of-legaia-recomp", Some(false));
    }

    #[test]
    fn x_men_mutant_academy_2_xmen_mutant_academy_2_pc_prepared_player_route_356() {
        assert_listing_only_player_route(
            "x-men-mutant-academy-2-xmen-mutant-academy-2-pc",
            Some(true),
        );
    }

    #[test]
    fn burnout_3_takedown_ps2_burnout3_pc_prepared_player_route_2638() {
        assert_listing_only_player_route("burnout-3-takedown-ps2-burnout3-pc", Some(false));
    }

    #[test]
    fn burnout_3_takedawn_xbox_prepared_player_route_2105() {
        assert_listing_only_player_route("burnout-3-takedawn-xbox", Some(false));
    }

    #[test]
    fn burnout_xbox_burnout_recompilation_prepared_player_route_2637() {
        assert_listing_only_player_route("burnout-xbox-burnout-recompilation", Some(false));
    }

    #[test]
    fn dead_or_alive_3_doa3_recomp_prepared_player_route_2560() {
        assert_listing_only_player_route("dead-or-alive-3-doa3-recomp", Some(false));
    }

    #[test]
    fn goliathret_edgeoftimerecomp_prepared_player_route_1818() {
        assert_listing_only_player_route("goliathret-edgeoftimerecomp", Some(false));
    }

    #[test]
    fn dragon_ball_z_burst_limit_dbz_burst_limit_recompiled_prepared_player_route_2664() {
        assert_listing_only_player_route(
            "dragon-ball-z-burst-limit-dbz-burst-limit-recompiled",
            Some(false),
        );
    }

    #[test]
    fn dudux42_freedomunbound_prepared_player_route_2808() {
        assert_listing_only_player_route("dudux42-freedomunbound", Some(false));
    }

    #[test]
    fn erreib_pure_recomp_prepared_player_route_2749() {
        assert_listing_only_player_route("erreib-pure-recomp", Some(false));
    }

    #[test]
    fn eternal_darkness_sanity_s_requiem_eternal_darkness_recomp_prepared_player_route_2570() {
        assert_listing_only_player_route(
            "eternal-darkness-sanity-s-requiem-eternal-darkness-recomp",
            Some(true),
        );
    }

    #[test]
    fn geometry_wars_retro_evolved_2_geometry_wars_2_recompiled_prepared_player_route_2577() {
        assert_listing_only_player_route(
            "geometry-wars-retro-evolved-2-geometry-wars-2-recompiled",
            Some(true),
        );
    }

    #[test]
    fn hard_corps_uprising_hard_corps_uprising_recompiled_prepared_player_route_2581() {
        assert_listing_only_player_route(
            "hard-corps-uprising-hard-corps-uprising-recompiled",
            Some(true),
        );
    }

    #[test]
    fn jedeyesniv_art_pacman_ce_pc_recomp_prepared_player_route_2727() {
        assert_listing_only_player_route("jedeyesniv-art-pacman-ce-pc-recomp", Some(false));
    }

    #[test]
    fn iron_jay_banjo_tooie_xbla_recomp_prepared_player_route_2860() {
        assert_listing_only_player_route("iron-jay-banjo-tooie-xbla-recomp", Some(false));
    }

    #[test]
    fn fataldecomp_roller_prepared_player_route_2792() {
        assert_listing_only_player_route("fataldecomp-roller", Some(false));
    }
}
