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
            launchable: blockers.is_empty(),
            blockers,
            pending_setup: false,
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
        let preview_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&(
            "portcove-user-selected-relink-v1",
            &state.row_sha256,
            &proposed,
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
            self.library
                .relink_user_selected_runtime(port_id, &state.row_sha256, &preview.proposed)
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

    #[test]
    fn listing_only_registration_relink_restart_and_launch_preserve_user_ownership() {
        let (temporary, mut service, executable, working) = fixture("listing-only");
        listing_only(&mut service);
        assert!(service.catalog.port("listing-only").is_err());
        let initial = service.listing_status("listing-only").unwrap();
        assert!(
            initial.actions.iter().any(|action| action.action
                == crate::ListingAction::AttachExisting
                && action.allowed)
        );
        let record = register(&service, "listing-only", &executable, &working);
        assert!(
            service
                .preview_user_selected_runtime("listing-only", &executable, &working, &[])
                .is_err()
        );

        let replacement = temporary.path().join("upstream update");
        fs::create_dir(&replacement).unwrap();
        let replacement_executable = replacement.join(executable.file_name().unwrap());
        fs::copy(&executable, &replacement_executable).unwrap();
        let arguments = vec!["--help".into()];
        let preview = service
            .preview_user_selected_runtime_relink(
                "listing-only",
                &replacement_executable,
                &replacement,
                &arguments,
            )
            .unwrap();
        assert!(
            service
                .authorize_user_selected_runtime_relink(
                    "listing-only",
                    &replacement_executable,
                    &replacement,
                    &[],
                    &preview.preview_sha256,
                )
                .is_err()
        );
        let authorization = service
            .authorize_user_selected_runtime_relink(
                "listing-only",
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
                "listing-only",
                &replacement_executable,
                &replacement,
                &arguments,
                &authorization.token,
            )
            .unwrap();
        assert_eq!(relinked.id, record.id);
        assert_eq!(relinked.registered_at, record.registered_at);
        assert!(
            service
                .relink_user_selected_runtime(
                    "listing-only",
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
        let workspace = service.workspace_snapshot(10).unwrap();
        assert!(
            workspace
                .listing_catalog
                .unwrap()
                .listings
                .iter()
                .any(|listing| listing.id == "listing-only")
        );
        assert!(
            workspace
                .listing_statuses
                .iter()
                .any(|listing| listing.port_id == "listing-only"
                    && listing.status.external_runtime.is_some())
        );
        assert!(
            service
                .status("listing-only")
                .unwrap()
                .readiness
                .unwrap()
                .launchable
        );
        assert!(
            service
                .supervise_launch("listing-only", None, &[], LaunchStdio::Null, |_| {})
                .unwrap()
                .successful
        );
        let removal = service.preview_external_removal("listing-only").unwrap();
        let consent = service
            .authorize_external_removal("listing-only", &removal.preview_sha256)
            .unwrap();
        service
            .remove_external_runtime("listing-only", &consent.token)
            .unwrap();
        assert!(replacement_executable.is_file());
        assert_eq!(
            fs::read(working.join("player-save.dat")).unwrap(),
            b"player save"
        );
    }

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
}
