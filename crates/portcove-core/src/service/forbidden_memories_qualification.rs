//! Isolated, fixed historical bootstrap. All durable execution uses the service.
use super::*;

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
    let root = fs::canonicalize(parent)?.join(name);
    // Exclusive creation refuses retained libraries and concurrent claims.
    fs::create_dir(&root)?;
    refuse_symlink_ancestors(&root)?;
    Ok(root)
}

#[cfg(feature = "qualification-fixtures")]
impl PortcoveService {
    /// Supervise the reviewed first-party child through the existing native
    /// process authority. A local digest binds the admitted build; it is not
    /// independently an authenticity or qualification grant.
    pub fn qualification_forbidden_memories_supervise(
        program: &Path,
        expected_program_sha256: &str,
        root: &Path,
        source: &Path,
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
        if root.exists() || source.starts_with(root) || program.starts_with(root) {
            return Err(PortcoveError::conflict("producer custody is not fresh"));
        }
        if sha256_file(program)? != expected_program_sha256 {
            return Err(PortcoveError::verification("producer executable changed"));
        }
        let started = std::time::Instant::now();
        let mut command = std::process::Command::new(program);
        command.arg("--owned-child").arg(root).arg(source);
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
                "failure": null,
            }),
            Err(error) => serde_json::json!({"failure": error.to_string()}),
        };
        Ok(serde_json::json!({
            "schema_version": 1,
            "kind": "owned_producer_session",
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
        create_owned_root(&root, false).unwrap();
        fs::write(root.join("retained-evidence"), b"preserve").unwrap();
        assert!(create_owned_root(&root, false).is_err());
        assert_eq!(
            fs::read(root.join("retained-evidence")).unwrap(),
            b"preserve"
        );
    }

    #[cfg(windows)]
    #[test]
    fn historical_producer_refuses_junction_ancestry_without_touching_target() {
        let parent = tempfile::tempdir().unwrap();
        let target = parent.path().join("retained");
        let link = parent.path().join("junction");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("evidence"), b"preserve").unwrap();
        let output = std::process::Command::new("cmd.exe")
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
