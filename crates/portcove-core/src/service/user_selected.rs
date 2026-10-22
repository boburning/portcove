//! Bounded launch-only registration of an installation selected by its user.
use super::*;

impl PortcoveService {
    fn require_user_selected_path_ownership(
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
        let preview = crate::external_runtime::preview_user_selected(
            port,
            executable,
            working_directory,
            arguments,
            self.library.root(),
            checkpoint,
        )?;
        self.require_user_selected_path_ownership(&preview.executable, &preview.path)?;
        Ok(preview)
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

fn managed_overlap_key(path: &Path) -> Result<PathBuf> {
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
