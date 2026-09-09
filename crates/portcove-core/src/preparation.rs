//! Exact, read-only plans for the existing upstream-managed setup family.
use std::path::PathBuf;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AdapterKind, AdoptionCopyPlan, ChildProcessClass, ChildProcessPolicy, InstallQualification,
    InstallRecord, Installer, Platform, PortcoveError, PortcoveService, Result,
    SourceInspectionReport, SourceRecord,
};

/// This family currently exposes the catalog's reviewed defaults only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreparationMode {
    #[default]
    Default,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PreparationOptions {
    pub target: Platform,
    #[serde(default)]
    pub mode: PreparationMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PreparationTool {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PreparationInputs {
    pub install: InstallRecord,
    /// Binds the admitted port and source definitions; hashing does not admit a definition.
    pub definition_sha256: String,
    pub source: SourceRecord,
    pub source_inspection: SourceInspectionReport,
    pub setup_tool: PreparationTool,
    pub conversion_tool: Option<PreparationTool>,
    pub host: Platform,
    pub options: PreparationOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PreparationPlan {
    pub format_version: u32,
    pub port_id: String,
    pub inputs: PreparationInputs,
    /// A copy identity, checked only after the existing install trust checks pass.
    pub copy: AdoptionCopyPlan,
    pub plan_sha256: String,
}

impl PortcoveService {
    /// Inspect installed inputs without acquiring software, starting setup, or changing readiness.
    pub fn plan_preparation(
        &self,
        port_id: &str,
        options: PreparationOptions,
    ) -> Result<PreparationPlan> {
        let _guard = self.library().try_lock_port(port_id, "plan-preparation")?;
        self.plan_preparation_locked(port_id, options)
    }

    pub(crate) fn plan_preparation_locked(
        &self,
        port_id: &str,
        options: PreparationOptions,
    ) -> Result<PreparationPlan> {
        let port = self.catalog().port(port_id)?;
        let host = Platform::current()?;
        if port.adapter != AdapterKind::UpstreamManagedSetup {
            return Err(PortcoveError::unsupported(
                "this port has no managed preparation operation",
            )
            .detail("port_id", port_id));
        }
        if port.setup_output_paths.is_empty() {
            return Err(PortcoveError::unsupported(
                "this definition has no reviewed managed preparation output contract",
            ));
        }
        if options.target != host || !port.platforms.contains(&host) {
            return Err(PortcoveError::unsupported(
                "managed preparation requires an available artifact for this host; target selection does not enable cross-compilation",
            ));
        }
        let install = self.status(port_id)?.active.ok_or_else(|| {
            PortcoveError::not_found("install this port before preparing its source")
                .detail("port_id", port_id)
        })?;
        crate::output_root::validate_install_path(self.library(), port_id, &install.path)?;
        let qualification = InstallQualification::from_port(port, host)?;
        let installer = Installer::new(self.library().clone())?;
        let selected = installer.verify_critical(&install, &qualification)?;
        let working =
            crate::adapter::launch_working_directory(port.adapter, port, &install.path, &selected)?;
        if working != install.path {
            return Err(PortcoveError::unsupported(
                "managed preparation currently requires an install-root working directory",
            ));
        }
        if !installer.verify_managed(&install, &qualification)?.valid {
            return Err(PortcoveError::verification(
                "installed setup inputs do not match their admitted manifest; repair the installation before preparation",
            ));
        }
        crate::runtime::require_ready(port, host, &install)?;
        let profile_id = port
            .source_profile
            .as_deref()
            .ok_or_else(|| PortcoveError::state("managed preparation has no source contract"))?;
        let source = self.library().source(profile_id)?.ok_or_else(|| {
            PortcoveError::source("register the required source before preparation")
                .detail("profile_id", profile_id)
        })?;
        self.verify_source_record(&source)?;
        let source_inspection = self.inspect_registered_source(profile_id)?;
        let hints = port.setup_executable_hints.get(&host).ok_or_else(|| {
            PortcoveError::unsupported("this host has no declared setup executable")
        })?;
        let setup =
            crate::install::resolve_executable_hints(&working, host, hints, "setup executable")?;
        let setup_tool = tool_identity(setup, ChildProcessClass::UpstreamSetup)?;
        let conversion_tool = if source
            .path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("chd"))
        {
            Some(tool_identity(
                crate::adapter::resolve_chdman()?,
                ChildProcessClass::HostTool,
            )?)
        } else {
            None
        };
        let definition_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
            port,
            self.catalog().source_profile(profile_id)?,
        ))?);
        let copy = crate::library_transfer::reviewed_tree(&install.path)?;
        let mut plan = PreparationPlan {
            format_version: 1,
            port_id: port_id.into(),
            inputs: PreparationInputs {
                install,
                definition_sha256,
                source,
                source_inspection,
                setup_tool,
                conversion_tool,
                host,
                options,
            },
            copy,
            plan_sha256: String::new(),
        };
        plan.plan_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&plan)?);
        Ok(plan)
    }
}

fn tool_identity(path: PathBuf, class: ChildProcessClass) -> Result<PreparationTool> {
    crate::path::refuse_symlink_ancestors(&path)?;
    let _command = ChildProcessPolicy::native_command(class, &path)?;
    let (sha256, size) = crate::adapter::hash_file(&path)?;
    Ok(PreparationTool { path, sha256, size })
}

pub(crate) fn validate_output_contract(port: &crate::PortDefinition) -> Result<()> {
    let generated_metadata = crate::adapter::generated_metadata(port)?;
    for (index, output) in port.setup_output_paths.iter().enumerate() {
        crate::archive::validate_relative_path(output, true)?;
        let overlaps = |other: &String| crate::runtime::overlaps(output, other);
        if crate::path::is_portcove_metadata(std::path::Path::new(output))
            || generated_metadata.iter().any(overlaps)
            || port.setup_output_paths[..index].iter().any(overlaps)
            || port.persistent_paths.iter().any(overlaps)
            || port.runtime_mutable_paths.iter().any(overlaps)
            || port.runtime_source_filename.iter().any(overlaps)
            || port
                .bundled_runtime
                .values()
                .any(|runtime| overlaps(&runtime.target_directory))
            || port
                .executable_hints
                .values()
                .chain(port.setup_executable_hints.values())
                .flatten()
                .any(overlaps)
        {
            return Err(PortcoveError::usage(
                "setup output paths overlap another ownership contract",
            )
            .detail("port_id", &port.id)
            .detail("path", output));
        }
    }
    if !port.setup_output_paths.is_empty()
        && !port.setup_marker.as_ref().is_some_and(|marker| {
            port.setup_output_paths
                .iter()
                .any(|output| std::path::Path::new(marker).starts_with(output))
        })
    {
        return Err(PortcoveError::usage(
            "setup marker must belong to a declared generated output path",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ArtifactIdentity, Catalog, ErrorCode, Library, ReleaseChannel};
    use std::fs;

    const PORT: &str = "opengoal-jak1";

    struct Fixture {
        _temporary: tempfile::TempDir,
        service: PortcoveService,
        install: InstallRecord,
        source: PathBuf,
        setup: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let service = PortcoveService::new(library.clone()).unwrap();
            let port = service.catalog().port(PORT).unwrap();
            let platform = Platform::current().unwrap();
            let artifact = ArtifactIdentity {
                asset_name: "owned-fixture.zip".into(),
                sha256: crate::signed_catalog::digest(b"owned-fixture-artifact"),
                size: 22,
            };
            let root = library.versions_dir().join(PORT).join(&artifact.sha256);
            fs::create_dir_all(&root).unwrap();
            let setup = root.join(&port.setup_executable_hints[&platform][0]);
            for relative in [
                &port.executable_hints[&platform][0],
                &port.setup_executable_hints[&platform][0],
            ] {
                let path = root.join(relative);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                // Intentionally not executable program bytes: planning must never start them.
                fs::write(&path, b"owned inert fixture").unwrap();
                crate::permissions::normalize_archive_entry(&path, false, true).unwrap();
            }
            let qualification = InstallQualification::from_port(port, platform).unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
                .unwrap()
                .create_manifest(&id, PORT, "fixture", &artifact, &qualification, &root)
                .unwrap();
            let install = InstallRecord {
                id,
                port_id: PORT.into(),
                version: "fixture".into(),
                path: root,
                channel: ReleaseChannel::Stable,
                installed_at: Library::now(),
                verified: true,
                staged: false,
                artifact,
                manifest_sha256,
                selected_executable,
                runtime,
            };
            library.register_install(&install, true).unwrap();
            let source = temporary.path().join("owned.iso");
            fs::write(&source, b"owned source awaiting the upstream validator").unwrap();
            let (sha256, size) = crate::adapter::hash_file(&source).unwrap();
            library
                .register_source(&SourceRecord {
                    profile_id: port.source_profile.clone().unwrap(),
                    path: source.clone(),
                    sha256: sha256.clone(),
                    size,
                    storage_sha256: sha256,
                    storage_size: size,
                    updated_at: Library::now(),
                    observed_identity: None,
                })
                .unwrap();
            Self {
                _temporary: temporary,
                service,
                install,
                source,
                setup,
            }
        }

        fn options(&self) -> PreparationOptions {
            PreparationOptions {
                target: Platform::current().unwrap(),
                mode: PreparationMode::Default,
            }
        }
    }

    #[test]
    fn planning_is_stable_and_preserves_preliminary_source_and_unprepared_state() {
        let fixture = Fixture::new();
        // The real definitions use the executable's parent, not an explicit root override.
        assert!(
            !fixture
                .service
                .catalog()
                .port(PORT)
                .unwrap()
                .launch_from_install_root
        );
        let before = crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap();
        let first = fixture
            .service
            .plan_preparation(PORT, fixture.options())
            .unwrap();
        let second = fixture
            .service
            .plan_preparation(PORT, fixture.options())
            .unwrap();
        assert_eq!(first.plan_sha256, second.plan_sha256);
        assert_eq!(first.inputs.install.id, fixture.install.id);
        assert_eq!(first.inputs.setup_tool.path, fixture.setup);
        assert!(first.inputs.conversion_tool.is_none());
        assert_eq!(first.copy, before);
        assert_eq!(
            crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap(),
            before
        );
        assert!(
            fixture
                .service
                .status(PORT)
                .unwrap()
                .readiness
                .unwrap()
                .pending_setup
        );
        assert_eq!(
            first.inputs.source_inspection.state_code,
            "selected_needs_checking"
        );
    }

    #[test]
    fn changed_source_or_setup_bytes_cannot_acquire_a_fresh_trust_identity() {
        let source = Fixture::new();
        fs::write(&source.source, b"changed source").unwrap();
        assert_eq!(
            source
                .service
                .plan_preparation(PORT, source.options())
                .unwrap_err()
                .code,
            ErrorCode::SourceInvalid
        );
        let setup = Fixture::new();
        fs::write(&setup.setup, b"changed setup").unwrap();
        assert_eq!(
            setup
                .service
                .plan_preparation(PORT, setup.options())
                .unwrap_err()
                .code,
            ErrorCode::Verification
        );
    }

    #[test]
    fn definition_changes_invalidate_the_plan_and_options_fail_closed() {
        let mut fixture = Fixture::new();
        let before = fixture
            .service
            .plan_preparation(PORT, fixture.options())
            .unwrap();
        let mut document = fixture.service.catalog().document().clone();
        document
            .ports
            .iter_mut()
            .find(|port| port.id == PORT)
            .unwrap()
            .setup_arguments
            .push("--fixture-option".into());
        fixture.service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        let after = fixture
            .service
            .plan_preparation(PORT, fixture.options())
            .unwrap();
        assert_ne!(
            before.inputs.definition_sha256,
            after.inputs.definition_sha256
        );
        assert_ne!(before.plan_sha256, after.plan_sha256);
        let mut other = fixture.options();
        other.target = if other.target == Platform::WindowsX86_64 {
            Platform::LinuxX86_64
        } else {
            Platform::WindowsX86_64
        };
        assert_eq!(
            fixture
                .service
                .plan_preparation(PORT, other)
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
        let mut unknown = serde_json::to_value(fixture.options()).unwrap();
        unknown["renderer"] = serde_json::json!("unreviewed");
        assert!(serde_json::from_value::<PreparationOptions>(unknown).is_err());
    }

    #[test]
    fn generated_outputs_cannot_claim_executables_sources_or_persistent_data() {
        let fixture = Fixture::new();
        let port = fixture.service.catalog().port(PORT).unwrap();
        validate_output_contract(port).unwrap();
        for outputs in [
            vec!["../outside".into()],
            vec![port.executable_hints[&Platform::current().unwrap()][0].clone()],
            vec![port.runtime_source_filename.clone().unwrap()],
            vec![port.persistent_paths[0].clone()],
            vec!["data".into()],
            vec!["data/out".into(), "data/out/jak1".into()],
            vec!["unrelated-output".into()],
            vec!["data/.PORTCOVE-hidden".into()],
        ] {
            let mut changed = port.clone();
            changed.setup_output_paths = outputs;
            assert!(validate_output_contract(&changed).is_err());
        }
        let mut nested = port.clone();
        nested.runtime_subdirectory = Some("nested".into());
        validate_output_contract(&nested).unwrap();
        let mut portable = port.clone();
        portable.portable_marker = true;
        portable.setup_output_paths.push("portable.txt".into());
        assert!(validate_output_contract(&portable).is_err());
        for reserved in [
            r"data\.PORTCOVE-hidden",
            "data/.portcove-hidden",
            r"data\source.PORTCOVE-source.json",
        ] {
            assert!(crate::path::is_portcove_metadata(std::path::Path::new(
                reserved
            )));
        }
        let mut legacy = port.clone();
        legacy.setup_output_paths.clear();
        // Old definitions remain readable; they cannot acquire the new preparation capability.
        validate_output_contract(&legacy).unwrap();
        let mut document = fixture.service.catalog().document().clone();
        *document
            .ports
            .iter_mut()
            .find(|candidate| candidate.id == PORT)
            .unwrap() = legacy;
        let mut service = fixture.service;
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        assert_eq!(
            service
                .plan_preparation(
                    PORT,
                    PreparationOptions {
                        target: Platform::current().unwrap(),
                        mode: PreparationMode::Default
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
    }
}
