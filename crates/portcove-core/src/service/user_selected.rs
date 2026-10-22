//! Bounded launch-only registration of an installation selected by its user.
use super::*;

impl PortcoveService {
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
        let port = self.catalog.port(port_id)?;
        let spec = port
            .release
            .user_prepared
            .get(&Platform::current()?)
            .ok_or_else(|| {
                PortcoveError::unsupported("no existing-installation route for this platform")
            })?;
        if port.release.provider != ReleaseSource::UserPrepared
            || spec.trust != crate::ExternalRuntimeTrust::UserSelected
        {
            return Err(PortcoveError::unsupported(
                "this port requires its accepted package route",
            ));
        }
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
        crate::external_runtime::preview_user_selected(
            port,
            executable,
            working_directory,
            arguments,
            self.library.root(),
            checkpoint,
        )
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
                retained_definition: self.catalog.definition_selection(port_id).cloned(),
                shared_preferences: None,
            };
            self.library
                .register_external_runtime(&record, &self.catalog)?;
            Ok(record)
        })();
        self.finish_activity(activity, result)
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
        let executable = working.join(if cfg!(windows) { "game.exe" } else { "game" });
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
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

    #[test]
    fn user_selected_production_launch_restart_and_removal_preserve_external_bytes() {
        // Two independent definitions reuse the same capability with case data.
        // The executable is this Rust test harness --help, not an observed game.
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
