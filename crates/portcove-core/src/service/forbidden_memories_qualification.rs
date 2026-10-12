//! Isolated, fixed historical bootstrap. All durable execution uses the service.
use super::*;

#[cfg(feature = "qualification-fixtures")]
fn owned_producer_command(
    program: &Path,
    environment: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Result<crate::process::NativeToolLaunchSpec> {
    // These are first-party host configuration, never upstream-child inheritance.
    // Preserve absent/empty semantics; native admission separately binds private paths.
    const BINDINGS: [&str; 4] = [
        "PORTCOVE_CHDMAN",
        "PORTCOVE_TEMP_DIR",
        "PORTCOVE_PREFERENCES",
        "PORTCOVE_APPLICATION_RUNTIME_LOCK",
    ];
    let mut bindings = std::collections::BTreeMap::new();
    for (name, value) in environment {
        let name = name.to_string_lossy();
        if name.eq_ignore_ascii_case("PORTCOVE_QUALIFICATION_CATALOG") {
            return Err(PortcoveError::unsupported(
                "historical producer refuses catalog overrides before spawn",
            ));
        }
        if let Some(canonical) = BINDINGS.iter().find(|key| name.eq_ignore_ascii_case(key)) {
            if bindings.insert(*canonical, value).is_some() {
                return Err(PortcoveError::usage(
                    "historical producer configuration has ambiguous case aliases",
                ));
            }
        }
    }
    let mut command =
        crate::ChildProcessPolicy::native_tool_spec(crate::ChildProcessClass::HostTool, program)?;
    command.envs(bindings);
    Ok(command)
}

fn require_immutable_catalog(current: &Catalog, immutable: &Catalog) -> Result<()> {
    if current
        .definition_selection("yu-gi-oh-forbidden-memories-recompiled")
        .is_some()
    {
        return Err(PortcoveError::unsupported(
            "historical producer cannot bypass publisher admission",
        ));
    }
    if serde_json::to_value(current.document())? != serde_json::to_value(immutable.document())? {
        return Err(PortcoveError::verification(
            "historical producer effective catalog changed",
        ));
    }
    Ok(())
}

fn create_owned_root(root: &Path, catalog_override_present: bool) -> Result<PathBuf> {
    if catalog_override_present {
        return Err(PortcoveError::unsupported(
            "historical producer refuses catalog overrides",
        ));
    }
    if !root.is_absolute()
        || root.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(PortcoveError::usage(
            "historical producer root must be absolute",
        ));
    }
    #[cfg(windows)]
    if !matches!(root.components().next(), Some(std::path::Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::UNC(_, _)))
    {
        return Err(PortcoveError::unsupported(
            "historical producer requires an ordinary Windows path",
        ));
    }
    refuse_symlink_ancestors(root)?;
    let parent = root
        .parent()
        .ok_or_else(|| PortcoveError::usage("historical producer root needs an existing parent"))?;
    if !parent.is_dir() {
        return Err(PortcoveError::usage(
            "historical producer parent must exist",
        ));
    }
    let name = root
        .file_name()
        .ok_or_else(|| PortcoveError::usage("historical producer root needs a directory name"))?;
    let owned = fs::canonicalize(parent)?.join(name);
    // Exclusive creation refuses retained libraries and concurrent claims.
    fs::create_dir(&owned)?;
    refuse_symlink_ancestors(&owned)?;
    refuse_symlink_ancestors(root)?;
    if fs::canonicalize(root)? != fs::canonicalize(&owned)? {
        return Err(PortcoveError::verification(
            "producer root identity changed",
        ));
    }
    // Canonicalization is an identity check, not a new caller coordinate.
    // On Windows its verbatim prefix makes upstream mixed-slash paths invalid.
    // Preserve the ordinary absolute path used by normal Library::open callers.
    Ok(root.to_path_buf())
}

#[cfg(feature = "qualification-fixtures")]
fn require_stage_request(stage: &str, retained_operation_id: Option<&str>) -> Result<()> {
    if !matches!(
        stage,
        "acquire"
            | "normalize-inputs"
            | "materialize-inputs"
            | "seal-inputs"
            | "generate-normalized"
            | "seal-generation"
            | "generate-acquired"
            | "generate"
            | "configure"
            | "compile-first"
            | "compile-next"
            | "finalize"
    ) || matches!(stage, "acquire" | "generate") != retained_operation_id.is_none()
        || retained_operation_id.is_some_and(|id| {
            uuid::Uuid::parse_str(id).map_or(true, |parsed| parsed.to_string() != id)
        })
    {
        return Err(PortcoveError::usage(
            "invalid fixed historical stage request",
        ));
    }
    Ok(())
}

#[cfg(feature = "qualification-fixtures")]
impl PortcoveService {
    /// One independently admitted historical stage. This never loops through
    /// multiple native phases or reuses the old failed monolithic producer.
    pub async fn qualification_forbidden_memories_stage(
        root: &Path,
        source: &Path,
        stage: &str,
        retained_operation_id: Option<&str>,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<serde_json::Value> {
        require_stage_request(stage, retained_operation_id)?;
        if Platform::current()? != Platform::WindowsX86_64 {
            return Err(PortcoveError::unsupported(
                "historical stages are Windows x64 only",
            ));
        }
        let override_present = std::env::vars_os().any(|(name, _)| {
            name.to_string_lossy()
                .eq_ignore_ascii_case("PORTCOVE_QUALIFICATION_CATALOG")
        });
        if override_present
            || !root.is_absolute()
            || !source.is_absolute()
            || source.starts_with(root)
            || root.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err(PortcoveError::usage("invalid historical stage custody"));
        }
        #[cfg(windows)]
        if !matches!(root.components().next(), Some(std::path::Component::Prefix(prefix))
            if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::UNC(_, _)))
        {
            return Err(PortcoveError::unsupported(
                "historical stage requires an ordinary Windows path",
            ));
        }
        refuse_symlink_ancestors(root)?;
        refuse_symlink_ancestors(source)?;
        let root = if matches!(stage, "acquire" | "generate") {
            create_owned_root(root, override_present)?
        } else {
            if !root.is_dir() {
                return Err(PortcoveError::state("retained stage library is missing"));
            }
            root.to_path_buf()
        };
        let library = Library::open(&root)?;
        let port_id = "yu-gi-oh-forbidden-memories-recompiled";
        if let Some(id) = retained_operation_id {
            let owner = crate::operation::OperationStore::new(library.clone())
                .get(id)?
                .ok_or_else(|| PortcoveError::state("retained stage owner is missing"))?;
            if owner.kind != crate::operation::LifecycleOperationKind::Install
                || owner.phase != crate::operation::LifecyclePhase::StagedPreparing
                || owner.port_id != port_id
                || owner.preparation_process_quiesced != Some(true)
                || owner.last_error.is_some()
            {
                return Err(PortcoveError::conflict(
                    "retained stage custody is not resumable",
                ));
            }
        }
        let service = Self::new(library)?;
        let immutable = Catalog::from_json(include_str!("../../catalog/catalog.json"))?;
        require_immutable_catalog(&service.catalog, &immutable)?;
        let (activity, control) = service.begin_cancellable_activity(
            ActivityOperation::Install,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let operation = retained_operation_id.map_or_else(
            || control.clone(),
            |id| control.retained_child(id, format!("historical-{stage}")),
        );
        emit(control.started());
        let result = async {
            let require_legacy = || -> Result<()> {
                let (current, _) = service.library.load_catalog()?;
                require_immutable_catalog(&current, &immutable)?;
                if crate::definition_repository::publisher_policy::acquisition_scope(
                    &service.library, &current, port_id,
                )?.is_some() {
                    return Err(PortcoveError::unsupported("historical stage cannot bypass publisher admission"));
                }
                Ok(())
            };
            require_legacy()?;
            let port = service.catalog.port(port_id)?;
            service.require_definition_operation(&service.catalog, port,
                DefinitionOperationContext::observed(DefinitionOperation::Install, false, true))?;
            if service.status(port_id)?.active.is_some() || service.status(port_id)?.staged.is_some()
                || service.status(port_id)?.previous.is_some()
            {
                return Err(PortcoveError::conflict("historical stage already has an installation"));
            }
            let provider = crate::GithubReleaseProvider::for_library(&service.library)?;
            let release = operation.interruptible(provider.forbidden_memories_baseline(port)).await?;
            require_legacy()?;
            let source = if matches!(stage, "acquire" | "generate") {
                service.validate_and_remember_source(port, Some(source), &operation)?
            } else {
                let profile = port.source_profile.as_deref().ok_or_else(|| {
                    PortcoveError::state("historical source profile missing")
                })?;
                let registered = service.verified_source_record_with_checkpoint(
                    &immutable, profile, &|| operation.checkpoint(),
                )?;
                if registered.path != source {
                    return Err(PortcoveError::verification("retained source coordinate differs from admission"));
                }
                Some(registered)
            };
            let managed = service.managed_preparation(port, source, None, Platform::current()?, &operation, &mut emit).await?;
            require_legacy()?;
            let request = InstallRequest {
                port_id: port_id.to_owned(), release,
                output_root: service.output_location(port_id, None)?.effective_output_directory,
                activate: true, managed,
                qualification: InstallQualification::from_catalog(&immutable, port_id, Platform::current()?)?,
            };
            let installer = Installer::new(service.library.clone())?;
            let outcome = match stage {
                "acquire" => serde_json::to_value(installer.acquire_managed_install(request, &operation, &mut emit).await?)?,
                "normalize-inputs" => serde_json::to_value(installer.normalize_acquired_managed_install(request, &operation, &mut emit).await?)?,
                "materialize-inputs" => serde_json::to_value(installer.materialize_acquired_managed_inputs(request, &operation, &mut emit).await?)?,
                "seal-inputs" => serde_json::to_value(installer.seal_materialized_managed_inputs(request, &operation, &mut emit).await?)?,
                "generate-normalized" => serde_json::to_value(installer.generate_normalized_managed_install(request, &operation, &mut emit).await?)?,
                "seal-generation" => serde_json::to_value(installer.seal_generated_managed_install(request, &operation, &mut emit).await?)?,
                "generate-acquired" => serde_json::to_value(installer.generate_acquired_managed_install(request, &operation, &mut emit).await?)?,
                "generate" => serde_json::to_value(installer.generate_managed_install(request, &operation, &mut emit).await?)?,
                "configure" => serde_json::to_value(installer.configure_managed_install(request, &operation, &mut emit).await?)?,
                "compile-first" | "compile-next" => {
                    let progress = if stage == "compile-first" {
                        installer.compile_managed_install_first_batch(request, &operation, &mut emit).await?
                    } else {
                        installer.compile_managed_install_next_batch(request, &operation, &mut emit).await?
                    };
                    let witness = crate::operation::OperationStore::new(service.library.clone()).psx_compilation(&operation)?;
                    serde_json::json!({"progress": progress, "total_batches": witness.total_batches()})
                }
                "finalize" => serde_json::to_value(installer.finalize_managed_install(request, &operation, &mut emit).await?)?,
                _ => unreachable!("validated fixed stage"),
            };
            require_legacy()?;
            Ok(serde_json::json!({"stage": stage, "lifecycle_operation_id": operation.operation_id(),
                "control_activity_id": activity.id, "outcome": outcome}))
        }.await;
        let result = service.finish_activity(activity, result);
        emit(control.finished(OperationResult::from_result(&result)));
        result
    }

    /// Supervise the reviewed first-party child through the existing native
    /// process authority. A local digest binds the admitted build; it is not
    /// independently an authenticity or qualification grant.
    pub fn qualification_forbidden_memories_supervise(
        program: &Path,
        expected_program_sha256: &str,
        root: &Path,
        source: &Path,
    ) -> Result<serde_json::Value> {
        Self::qualification_forbidden_memories_supervise_bound(
            program,
            expected_program_sha256,
            root,
            source,
            None,
        )
    }

    /// One finite admitted stage, using the same native process authority and
    /// limits as the original producer session. This is not dispatch admission.
    pub fn qualification_forbidden_memories_supervise_stage(
        program: &Path,
        expected_program_sha256: &str,
        root: &Path,
        source: &Path,
        stage: &str,
        retained_operation_id: Option<&str>,
    ) -> Result<serde_json::Value> {
        require_stage_request(stage, retained_operation_id)?;
        Self::qualification_forbidden_memories_supervise_bound(
            program,
            expected_program_sha256,
            root,
            source,
            Some((stage, retained_operation_id)),
        )
    }

    fn qualification_forbidden_memories_supervise_bound(
        program: &Path,
        expected_program_sha256: &str,
        root: &Path,
        source: &Path,
        selected_stage: Option<(&str, Option<&str>)>,
    ) -> Result<serde_json::Value> {
        if Platform::current()? != Platform::WindowsX86_64
            || !program.is_absolute()
            || !root.is_absolute()
            || !source.is_absolute()
            || expected_program_sha256.len() != 64
            || !expected_program_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PortcoveError::usage("invalid owned producer binding"));
        }
        refuse_symlink_ancestors(program)?;
        refuse_symlink_ancestors(root)?;
        refuse_symlink_ancestors(source)?;
        let fresh = selected_stage.is_none_or(|(stage, _)| matches!(stage, "acquire" | "generate"));
        if (fresh && root.exists())
            || (!fresh && !root.is_dir())
            || source.starts_with(root)
            || program.starts_with(root)
        {
            return Err(PortcoveError::conflict("producer custody is not fresh"));
        }
        if sha256_file(program)? != expected_program_sha256 {
            return Err(PortcoveError::verification("producer executable changed"));
        }
        let started = std::time::Instant::now();
        let mut command = owned_producer_command(program, std::env::vars_os())?;
        if let Some((stage, retained_operation_id)) = selected_stage {
            command
                .arg("--owned-stage")
                .arg(stage)
                .arg(retained_operation_id.unwrap_or("-"))
                .arg(root)
                .arg(source);
        } else {
            command.arg("--owned-child").arg(root).arg(source);
        }
        let mut quiesced = false;
        let mut final_diagnostic = None;
        let activity_id = uuid::Uuid::new_v4().to_string();
        let mut record = |diagnostic: &crate::ActivityDiagnostic| {
            final_diagnostic = Some(diagnostic.clone());
            Ok(())
        };
        let mut confirm = || {
            quiesced = true;
            Ok(())
        };
        let result = crate::tool_process::run_tool(
            &mut command,
            &|| {
                if started.elapsed() >= std::time::Duration::from_secs(180) {
                    Err(PortcoveError::state("producer session deadline reached"))
                } else {
                    Ok(())
                }
            },
            crate::tool_process::ToolProcessObserver {
                diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                    activity_id: &activity_id,
                    phase: "historical-producer-child",
                    record: &mut record,
                }),
                quiesced: Some(&mut confirm),
            },
        );
        // Always preserve child output, failure and conservative exit holds.
        // The caller must retain this receipt, never clean a failed root.
        let receipt = match result {
            Ok(output) => serde_json::json!({
                "child_exit_code": output.status.code(),
                "child_success": output.status.success(),
                "output": output.output,
                "output_truncated": output.truncated,
                "process_tree_proof": output.process_tree_proof,
                "failure": null,
            }),
            Err(error) => serde_json::json!({
                "failure": error.to_string(),
                "failure_code": error.code,
                "process_tree_proof": crate::tool_process::copy_proof_details(&error),
            }),
        };
        Ok(serde_json::json!({
            "schema_version": 1,
            "kind": "owned_producer_session",
            "selected_stage": selected_stage.map(|(stage, _)| stage),
            "retained_operation_id": selected_stage.and_then(|(_, id)| id),
            "program_sha256": expected_program_sha256,
            "library": root,
            "source": source,
            "budget_seconds": 180,
            "elapsed_ms": started.elapsed().as_millis(),
            "process_tree_quiesced": quiesced,
            "diagnostic": final_diagnostic,
            "outcome": receipt,
            "qualification": "not granted by this receipt",
        }))
    }

    /// Create only an owned fresh #141 producer baseline using official v0.6.1.
    /// This does not grant publisher admission or qualify later updates.
    pub async fn qualification_forbidden_memories_baseline(
        root: &Path,
        source: &Path,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<(Self, InstallRecord)> {
        if Platform::current()? != Platform::WindowsX86_64 {
            return Err(PortcoveError::unsupported(
                "historical producer is Windows x64 only",
            ));
        }
        let override_present = std::env::vars_os().any(|(name, _)| {
            name.to_string_lossy()
                .eq_ignore_ascii_case("PORTCOVE_QUALIFICATION_CATALOG")
        });
        let root = create_owned_root(root, override_present)?;
        let library = Library::open(&root)?;
        // Never accept a caller-provided service/provider or fixture origin.
        let service = Self::new(library)?;
        let immutable = Catalog::from_json(include_str!("../../catalog/catalog.json"))?;
        require_immutable_catalog(&service.catalog, &immutable)?;
        let port_id = "yu-gi-oh-forbidden-memories-recompiled";
        let (activity, operation) = service.begin_cancellable_activity(
            ActivityOperation::Install,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        emit(operation.started());
        let result = async {
            let _guard = service
                .library
                .try_lock_port(port_id, "historical-producer")?;
            let port = service.catalog.port(port_id)?;
            let status = service.status(port_id)?;
            if status.active.is_some() || status.staged.is_some() || status.previous.is_some() {
                return Err(PortcoveError::conflict(
                    "historical producer library is not fresh",
                ));
            }
            let require_legacy = || -> Result<()> {
                // Metadata awaits are a freshness boundary. Re-read effective
                // authority, including a same-byte selected definition, instead
                // of granting acquisition from the original service snapshot.
                let (current, _) = service.library.load_catalog()?;
                require_immutable_catalog(&current, &immutable)?;
                if crate::definition_repository::publisher_policy::acquisition_scope(
                    &service.library,
                    &current,
                    port_id,
                )?
                .is_some()
                {
                    return Err(PortcoveError::unsupported(
                        "historical producer cannot bypass publisher admission",
                    ));
                }
                Ok(())
            };
            require_legacy()?;
            service.require_definition_operation(
                &service.catalog,
                port,
                DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
            )?;
            let provider = crate::GithubReleaseProvider::for_library(&service.library)?;
            let release = operation
                .interruptible(provider.forbidden_memories_baseline(port))
                .await?;
            require_legacy()?;
            service
                .apply_scoped_release(
                    port,
                    status,
                    InstallOverrides {
                        source: Some(source),
                        bios: None,
                        output_directory: None,
                    },
                    crate::ScopedResolvedRelease::legacy(release),
                    true,
                    &mut OperationReporter {
                        operation: &operation,
                        emit: &mut emit,
                    },
                )
                .await
        }
        .await;
        let result = service.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        result.map(|install| (service, install))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "qualification-fixtures")]
    #[test]
    fn historical_acquired_stages_require_exact_fresh_or_retained_custody() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(require_stage_request("acquire", None).is_ok());
        assert!(require_stage_request("normalize-inputs", Some(&id)).is_ok());
        assert!(require_stage_request("normalize-inputs", None).is_err());
        assert!(require_stage_request("normalize-inputs", Some("caller-reconstructed")).is_err());
        assert!(require_stage_request("acquire", Some(&id)).is_err());
        assert!(require_stage_request("generate-acquired", Some(&id)).is_ok());
        assert!(require_stage_request("generate-acquired", None).is_err());
        assert!(require_stage_request("generate-acquired", Some("caller-reconstructed")).is_err());
        for stage in ["generate-normalized", "seal-generation"] {
            assert!(require_stage_request(stage, Some(&id)).is_ok());
            assert!(require_stage_request(stage, None).is_err());
            assert!(require_stage_request(stage, Some("caller-reconstructed")).is_err());
        }
    }

    #[cfg(feature = "qualification-fixtures")]
    #[tokio::test]
    async fn historical_stage_refuses_unrecognized_phase_before_root_creation() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("must-not-create");
        let result = PortcoveService::qualification_forbidden_memories_stage(
            &root,
            &fixture.path().join("source.chd"),
            "generate-and-build",
            None,
            |_| {},
        )
        .await;
        assert!(result.is_err());
        assert!(!root.exists());
    }

    #[cfg(feature = "qualification-fixtures")]
    #[tokio::test]
    async fn historical_stage_refuses_reconstructed_owner_before_library_open() {
        let fixture = tempfile::tempdir().unwrap();
        fs::write(fixture.path().join("preserved.txt"), b"original custody").unwrap();
        let result = PortcoveService::qualification_forbidden_memories_stage(
            fixture.path(),
            &fixture.path().join("source.chd"),
            "configure",
            Some("not-an-operation"),
            |_| {},
        )
        .await;
        assert!(result.is_err());
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 1);
        assert_eq!(
            fs::read(fixture.path().join("preserved.txt")).unwrap(),
            b"original custody"
        );
    }

    #[cfg(feature = "qualification-fixtures")]
    #[test]
    fn historical_stage_retained_child_uses_fresh_cancellation_and_ancestry() {
        let fixture = tempfile::tempdir().unwrap();
        let library = Library::open(fixture.path()).unwrap();
        let service = PortcoveService::new_read_only(library.clone()).unwrap();
        let port = "yu-gi-oh-forbidden-memories-recompiled";
        let old = library
            .begin_activity(
                ActivityOperation::Install,
                ActivityTargetKind::Port,
                Some(port),
            )
            .unwrap();
        library
            .finish_activity(&old.id, ActivityStatus::Succeeded, None)
            .unwrap();
        let (_activity, control) = service
            .begin_cancellable_activity(
                ActivityOperation::Install,
                ActivityTargetKind::Port,
                Some(port),
            )
            .unwrap();
        let retained = control.retained_child(&old.id, "historical-configure");
        let event = retained.started();
        assert_eq!(event.operation_id, old.id);
        assert_eq!(
            event.parent_operation_id.as_deref(),
            Some(control.operation_id())
        );
        assert_ne!(control.operation_id(), old.id);
        service
            .request_cancellation(control.operation_id())
            .unwrap();
        assert_eq!(
            retained.checkpoint().unwrap_err().code,
            crate::ErrorCode::Cancelled
        );
        assert_eq!(
            library
                .activities(10)
                .unwrap()
                .into_iter()
                .find(|item| item.id == old.id)
                .unwrap()
                .status,
            ActivityStatus::Succeeded
        );
    }

    #[cfg(all(windows, feature = "qualification-fixtures"))]
    #[test]
    fn historical_producer_child_preserves_only_reviewed_first_party_bindings() {
        let fixture = tempfile::tempdir().unwrap();
        let values = [
            ("portcove_chdman", fixture.path().join("chdman.exe")),
            ("PORTCOVE_TEMP_DIR", fixture.path().join("temp")),
            (
                "PORTCOVE_PREFERENCES",
                fixture.path().join("preferences.json"),
            ),
            (
                "PORTCOVE_APPLICATION_RUNTIME_LOCK",
                fixture.path().join("runtime.lock"),
            ),
        ];
        let environment = values
            .iter()
            .map(|(name, path)| (std::ffi::OsString::from(name), path.as_os_str().to_owned()))
            .chain([
                ("PORTCOVE_GITHUB_TOKEN".into(), "fixture-secret".into()),
                ("PORTCOVE_UNREVIEWED".into(), "fixture-secret".into()),
            ]);
        let output = owned_producer_command(Path::new("cmd.exe"), environment)
            .unwrap()
            .args(["/d", "/u", "/c", "set PORTCOVE_"])
            .command()
            .unwrap()
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len() % 2, 0);
        let observed = String::from_utf16(
            &output
                .stdout
                .chunks_exact(2)
                .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        for (name, path) in values {
            assert!(observed.contains(&format!(
                "{}={}",
                name.to_ascii_uppercase(),
                path.display()
            )));
        }
        assert_eq!(observed.lines().count(), 4);
        assert!(!observed.contains("fixture-secret"));
    }

    #[cfg(feature = "qualification-fixtures")]
    #[test]
    fn historical_producer_child_refuses_overrides_and_ambiguous_bindings_before_spawn() {
        let fixture = tempfile::tempdir().unwrap();
        let absent_program = fixture.path().join("never-spawned.exe");
        for value in ["", "override.json"] {
            assert_eq!(
                owned_producer_command(
                    &absent_program,
                    [("portcove_qualification_catalog".into(), value.into())]
                )
                .unwrap_err()
                .code,
                crate::ErrorCode::Unsupported
            );
        }
        assert_eq!(
            owned_producer_command(
                &absent_program,
                [
                    ("PORTCOVE_PREFERENCES".into(), "first.json".into()),
                    ("portcove_preferences".into(), "second.json".into()),
                ]
            )
            .unwrap_err()
            .code,
            crate::ErrorCode::Usage
        );
        let command = owned_producer_command(
            &absent_program,
            [("PORTCOVE_PREFERENCES".into(), "".into())],
        )
        .unwrap();
        assert!(
            command
                .command()
                .unwrap()
                .get_envs()
                .any(|(name, value)| name == "PORTCOVE_PREFERENCES"
                    && value == Some(std::ffi::OsStr::new("")))
        );
        assert!(!absent_program.exists());
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 0);
    }

    #[cfg(all(windows, feature = "qualification-fixtures"))]
    #[test]
    fn historical_producer_supervisor_refuses_unbound_or_retained_inputs_before_spawn() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("producer");
        let source = parent.path().join("source.bin");
        fs::write(&source, b"fixture source, never acquired").unwrap();
        let program = std::env::current_exe().unwrap();
        assert_eq!(
            PortcoveService::qualification_forbidden_memories_supervise(
                &program,
                &"0".repeat(64),
                &root,
                &source
            )
            .unwrap_err()
            .code,
            crate::ErrorCode::Verification
        );
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        fs::write(root.join("evidence"), b"preserve").unwrap();
        assert_eq!(
            PortcoveService::qualification_forbidden_memories_supervise(
                &program,
                &sha256_file(&program).unwrap(),
                &root,
                &source
            )
            .unwrap_err()
            .code,
            crate::ErrorCode::Conflict
        );
        assert_eq!(fs::read(root.join("evidence")).unwrap(), b"preserve");
    }

    #[test]
    fn historical_producer_refuses_effective_catalog_or_selection_drift() {
        let immutable = Catalog::from_json(include_str!("../../catalog/catalog.json")).unwrap();
        require_immutable_catalog(&immutable, &immutable).unwrap();
        let mut changed = immutable.authoritative_document();
        changed.ports[0].name.push_str(" changed after metadata");
        let changed = Catalog::from_json(&serde_json::to_string(&changed).unwrap()).unwrap();
        assert_eq!(
            require_immutable_catalog(&changed, &immutable)
                .unwrap_err()
                .code,
            crate::ErrorCode::Verification
        );
        let selected = crate::test_fixture::admitted_indexed_catalog(
            &immutable,
            "yu-gi-oh-forbidden-memories-recompiled",
        );
        assert!(
            selected
                .definition_selection("yu-gi-oh-forbidden-memories-recompiled")
                .is_some()
        );
        assert_eq!(
            require_immutable_catalog(&selected, &immutable)
                .unwrap_err()
                .code,
            crate::ErrorCode::Unsupported
        );
    }

    #[test]
    fn historical_producer_root_refuses_overrides_and_existing_custody() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("producer");
        assert!(create_owned_root(&root, true).is_err());
        assert!(
            !root.exists(),
            "override refusal must precede directory creation"
        );
        assert!(create_owned_root(Path::new("relative-library"), false).is_err());
        assert_eq!(create_owned_root(&root, false).unwrap(), root);
        fs::write(root.join("retained-evidence"), b"preserve").unwrap();
        assert!(create_owned_root(&root, false).is_err());
        assert_eq!(
            fs::read(root.join("retained-evidence")).unwrap(),
            b"preserve"
        );
    }

    #[cfg(windows)]
    #[test]
    fn historical_producer_root_preserves_windows_upstream_coordinates() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("producer");
        let expected_identity = fs::canonicalize(parent.path()).unwrap().join("producer");
        assert_eq!(create_owned_root(&root, false).unwrap(), root);
        assert_eq!(fs::canonicalize(&root).unwrap(), expected_identity);
        fs::create_dir(root.join("bios")).unwrap();
        fs::write(
            root.join("bios").join("OpenBIOS.toml"),
            b"owned inert fixture",
        )
        .unwrap();
        assert!(root.join("bios/OpenBIOS.toml").is_file());
        // PathBuf::join normalizes verbatim components. The upstream combines
        // raw strings, so exercise the literal native lookup instead.
        use std::os::windows::ffi::OsStrExt;
        let attributes = |base: &Path| {
            let mut literal = base.as_os_str().to_os_string();
            literal.push("\\bios/OpenBIOS.toml");
            let wide = literal.encode_wide().chain(Some(0)).collect::<Vec<_>>();
            unsafe { windows_sys::Win32::Storage::FileSystem::GetFileAttributesW(wide.as_ptr()) }
        };
        assert_ne!(
            attributes(&root),
            windows_sys::Win32::Storage::FileSystem::INVALID_FILE_ATTRIBUTES
        );
        assert_eq!(
            attributes(&expected_identity),
            windows_sys::Win32::Storage::FileSystem::INVALID_FILE_ATTRIBUTES
        );
        let verbatim = fs::canonicalize(parent.path()).unwrap().join("refused");
        assert_eq!(
            create_owned_root(&verbatim, false).unwrap_err().code,
            crate::ErrorCode::Unsupported
        );
        assert!(!verbatim.exists());
    }

    #[cfg(windows)]
    #[test]
    fn historical_producer_refuses_junction_ancestry_without_touching_target() {
        let parent = tempfile::tempdir().unwrap();
        let target = parent.path().join("retained");
        let link = parent.path().join("junction");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("evidence"), b"preserve").unwrap();
        let output = crate::ChildProcessPolicy::native_command(
            crate::ChildProcessClass::HostTool,
            "cmd.exe",
        )
        .unwrap()
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "owned junction fixture could not be created"
        );
        assert!(create_owned_root(&link.join("producer"), false).is_err());
        assert!(!target.join("producer").exists());
        assert_eq!(fs::read(target.join("evidence")).unwrap(), b"preserve");
    }
}
