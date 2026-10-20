//! Read-only refusal for runtimes whose legacy Windows path APIs can be lossy.
use std::path::Path;

use crate::{
    AdapterKind, Platform, PortDefinition, PortcoveError, Result, WindowsRuntimePathPolicy,
};

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    if port.windows_runtime_path_policy.is_some()
        && (port.platforms != [Platform::WindowsX86_64]
            || port.adapter != AdapterKind::StagedSourcePortable
            || !port.setup_executable_hints.is_empty()
            || !port.release.managed_build.is_empty())
    {
        return Err(PortcoveError::usage(
            "Windows runtime path policy requires a Windows-only staged-source route without a setup executable or managed build",
        ));
    }
    if port.windows_runtime_path_policy.is_some()
        && port.release.user_prepared.values().any(|runtime| {
            runtime.source_argument_extension.is_none() || runtime.shared_preferences.is_some()
        })
    {
        return Err(PortcoveError::usage(
            "prepared Windows runtime paths require a fixed positional original-file argument without shared preferences",
        ));
    }
    Ok(())
}

pub(crate) fn minimum_capability(port: &PortDefinition) -> u32 {
    if port.release.user_prepared.is_empty() {
        11
    } else {
        17
    }
}

/// Prepared runtimes receive these paths directly, including any extended prefix.
pub(crate) fn check_prepared_path(
    port: &PortDefinition,
    platform: Platform,
    path: &Path,
) -> Result<()> {
    check(port, platform, path)?;
    if platform == Platform::WindowsX86_64
        && port.windows_runtime_path_policy.is_some()
        && path.to_str().is_none_or(|text| text.len() >= 260)
    {
        return Err(path_error());
    }
    Ok(())
}

/// Check the actual coordinates used by a non-owning prepared launch. The first
/// argument is the Core-selected original, never an unchecked caller argument.
pub(crate) fn check_prepared_launch(
    port: &PortDefinition,
    platform: Platform,
    executable: &Path,
    working_directory: &Path,
    arguments: &[String],
) -> Result<()> {
    if port.windows_runtime_path_policy.is_none() {
        return Ok(());
    }
    check_executable(port, platform, executable)?;
    check_prepared_path(port, platform, executable)?;
    check_working_directory(port, platform, working_directory)?;
    if platform == Platform::WindowsX86_64 {
        check_prepared_path(
            port,
            platform,
            &working_directory.join(".snesrecomp_write_probe"),
        )?;
    }
    let source = arguments.first().ok_or_else(path_error)?;
    check_prepared_path(port, platform, Path::new(source))
}

pub(crate) fn check_working_directory(
    port: &PortDefinition,
    platform: Platform,
    directory: &Path,
) -> Result<()> {
    check(port, platform, directory)?;
    if platform == Platform::WindowsX86_64 && port.windows_runtime_path_policy.is_some() {
        require_narrow_windows_path(directory, "\\.snesrecomp_write_probe")
            .map_err(|_| path_error())?;
    }
    Ok(())
}

pub(crate) fn check(port: &PortDefinition, platform: Platform, path: &Path) -> Result<()> {
    if platform != Platform::WindowsX86_64 || port.windows_runtime_path_policy.is_none() {
        return Ok(());
    }
    match port.windows_runtime_path_policy.unwrap() {
        WindowsRuntimePathPolicy::PrintableAsciiMaxPath => {
            require_narrow_windows_path(path, "").map_err(|_| path_error())
        }
    }
}

/// Reject an already impossible destination before resolving or acquiring a release.
/// Actual selected executable/work-directory paths are checked again for readiness
/// and launch, including package nesting which is unknown before acquisition.
pub(crate) fn check_output_root(
    port: &PortDefinition,
    platform: Platform,
    root: &Path,
) -> Result<()> {
    check(port, platform, &root.join("0".repeat(64)))
}

pub(crate) fn check_executable(
    port: &PortDefinition,
    platform: Platform,
    executable: &Path,
) -> Result<()> {
    check(port, platform, executable)?;
    if platform == Platform::WindowsX86_64 && port.windows_runtime_path_policy.is_some() {
        let parent = executable.parent().ok_or_else(path_error)?;
        require_narrow_windows_path(parent, "\\.snesrecomp_write_probe")
            .map_err(|_| path_error())?;
    }
    Ok(())
}

fn path_error() -> PortcoveError {
    PortcoveError::unsupported(
        "This game port needs a shorter installation folder using basic Latin characters. Choose a folder such as C:\\Games\\Portcove in its setup options, then review the installation again.",
    ).detail("runtime_path_requirement", "printable-ascii-max-path")
    .with_known_cause(crate::failure::KnownFailureCause::RuntimePathRequirement)
}

/// Shared with the separately scoped legacy shared-preferences path check.
pub(crate) fn require_narrow_windows_path(path: &Path, suffix: &str) -> Result<()> {
    let text = path.to_str().ok_or_else(|| {
        PortcoveError::unsupported("this runtime requires a printable ASCII Windows path")
    })?;
    let valid = {
        let ordinary = if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{unc}")
        } else {
            text.strip_prefix("\\\\?\\").unwrap_or(text).to_owned()
        };
        !ordinary.is_empty()
            && ordinary.bytes().all(|byte| (32..127).contains(&byte))
            && ordinary.len().saturating_add(suffix.len()) < 260
    };
    if !valid {
        return Err(PortcoveError::unsupported(
            "this exact runtime requires printable ASCII Windows paths shorter than MAX_PATH",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn narrow_paths_reject_lossy_names_controls_and_probe_overflow() {
        for path in [
            "C:\\Games\\DKC3",
            "C:\\Games with spaces\\F-Zero",
            "\\\\?\\C:\\Games\\F-Zero",
            "\\\\server\\games\\F-Zero",
            "\\\\?\\UNC\\server\\games\\F-Zero",
        ] {
            require_narrow_windows_path(Path::new(path), "").unwrap();
        }
        for path in [
            "",
            "C:\\Juegos\\José",
            "C:\\Games\\日本語",
            "C:\\Games\\bad\tname",
        ] {
            assert!(
                require_narrow_windows_path(Path::new(path), "").is_err(),
                "{path:?}"
            );
        }
        let suffix = "\\.snesrecomp_write_probe";
        let last_valid = "a".repeat(259 - suffix.len());
        require_narrow_windows_path(Path::new(&last_valid), suffix).unwrap();
        assert!(require_narrow_windows_path(Path::new(&(last_valid + "a")), suffix).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn prepared_checks_cover_selected_source_and_actual_working_directory() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("f-zero-snes-recomp").unwrap();
        let executable = Path::new("C:\\Games\\runtime\\game.exe");
        let directory = Path::new("C:\\Games\\runtime");
        check_prepared_launch(
            port,
            Platform::WindowsX86_64,
            executable,
            directory,
            &["C:\\Originals\\game.sfc".into()],
        )
        .unwrap();
        for original in [
            "C:\\Originals\\日本語.sfc".to_owned(),
            "a".repeat(260),
            format!("\\\\?\\{}", "a".repeat(259)),
        ] {
            assert!(
                check_prepared_launch(
                    port,
                    Platform::WindowsX86_64,
                    executable,
                    directory,
                    &[original]
                )
                .is_err()
            );
        }
        assert!(
            check_prepared_launch(
                port,
                Platform::WindowsX86_64,
                executable,
                Path::new("C:\\日本語"),
                &["C:\\game.sfc".into()]
            )
            .is_err()
        );
        assert!(
            check_prepared_launch(port, Platform::WindowsX86_64, executable, directory, &[])
                .is_err()
        );
    }

    #[test]
    fn optional_policy_does_not_restrict_other_routes_or_platforms() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("f-zero-snes-recomp").unwrap().clone();
        port.windows_runtime_path_policy = None;
        check(&port, Platform::WindowsX86_64, Path::new("C:\\日本語")).unwrap();
        port.windows_runtime_path_policy = Some(WindowsRuntimePathPolicy::PrintableAsciiMaxPath);
        let refused = check(&port, Platform::WindowsX86_64, Path::new("C:\\日本語"))
            .unwrap_err()
            .report();
        assert_eq!(refused.code, crate::ErrorCode::Unsupported);
        assert_eq!(
            refused.details["runtime_path_requirement"],
            "printable-ascii-max-path"
        );
        assert_eq!(
            refused.presentation.presentation_key,
            "runtime_path_requirement"
        );
        assert_eq!(
            refused.presentation.summary,
            "This game port needs a shorter installation folder using basic Latin characters. Choose a folder such as C:\\Games\\Portcove in setup options, then review the installation again. Review the original-file location too when the runtime uses it directly."
        );
        assert_eq!(
            refused.presentation.mutation_state,
            crate::MutationState::Unknown
        );
        assert_eq!(
            refused.presentation.recovery_actions,
            [
                crate::RecoveryAction::ReviewCurrentState,
                crate::RecoveryAction::ViewTechnicalDetails
            ]
        );
        check(&port, Platform::LinuxX86_64, Path::new("/home/日本語")).unwrap();
        validate(&port).unwrap();
        port.platforms.push(Platform::LinuxX86_64);
        assert!(validate(&port).is_err());
    }

    #[test]
    fn adapter_refuses_lossy_runtime_before_creating_or_preparing_data() {
        use crate::Adapter;
        let temporary = tempfile::tempdir().unwrap();
        let library = crate::Library::open(temporary.path().join("library")).unwrap();
        let runtime = temporary.path().join("Japanese-ゲーム");
        std::fs::create_dir(&runtime).unwrap();
        let executable = runtime.join("inert.exe");
        std::fs::write(&executable, b"inert fixture; never executed").unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("f-zero-snes-recomp").unwrap().clone();
        port.windows_runtime_path_policy = Some(WindowsRuntimePathPolicy::PrintableAsciiMaxPath);
        let adapter = crate::adapter::standard(port.adapter);
        let request = crate::LaunchSpecRequest {
            library: &library,
            port: &port,
            platform: Platform::WindowsX86_64,
            install_root: &runtime,
            selected_executable: &executable,
            source: None,
            source_record: None,
        };
        for error in [
            adapter
                .launch_spec_with_executable(request, &|| Ok(()))
                .unwrap_err(),
            adapter
                .prepare_launch_with_executable(request, &|| Ok(()))
                .unwrap_err(),
        ] {
            assert_eq!(
                error
                    .details
                    .get("runtime_path_requirement")
                    .map(String::as_str),
                Some("printable-ascii-max-path")
            );
        }
        assert!(!library.user_dir(&port.id).exists());
        assert_eq!(
            std::fs::read(executable).unwrap(),
            b"inert fixture; never executed"
        );
    }

    #[cfg(windows)]
    #[test]
    fn move_previews_check_retained_policy_before_creating_destinations() {
        for constrained in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let library = crate::Library::open(temporary.path().join("library")).unwrap();
            let (catalog, port_id) = crate::test_fixture::post_client_catalog();
            let mut document = catalog.authoritative_document();
            let port = document
                .ports
                .iter_mut()
                .find(|port| port.id == port_id)
                .unwrap();
            port.adapter = AdapterKind::StagedSourcePortable;
            port.platforms = vec![Platform::WindowsX86_64];
            port.executable_hints =
                [(Platform::WindowsX86_64, vec!["nested/inert.exe".into()])].into();
            port.setup_executable_hints.clear();
            port.setup_arguments.clear();
            port.setup_marker = None;
            port.setup_output_paths.clear();
            port.runtime_subdirectory = None;
            port.runtime_source_filename = None;
            port.runtime_source_materialization = None;
            port.runtime_source_hashes.clear();
            port.runtime_source_set.clear();
            port.n64_windows_initial_d3d12 = false;
            port.windows_runtime_path_policy =
                constrained.then_some(WindowsRuntimePathPolicy::PrintableAsciiMaxPath);
            let catalog =
                crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
            let retained = crate::test_fixture::admitted_indexed_catalog(&catalog, &port_id);
            let install =
                crate::test_fixture::register_qualification_install(&library, &retained, &port_id);
            assert_eq!(install.selected_executable, Path::new("nested/inert.exe"));
            let original = std::fs::read(install.path.join(&install.selected_executable)).unwrap();
            let mut service = crate::PortcoveService::new(library).unwrap();
            // Current catalog drift must not remove or invent a retained restriction.
            let mut current = catalog.authoritative_document();
            current
                .ports
                .iter_mut()
                .find(|port| port.id == port_id)
                .unwrap()
                .windows_runtime_path_policy =
                (!constrained).then_some(WindowsRuntimePathPolicy::PrintableAsciiMaxPath);
            service.replace_catalog_for_test(
                crate::Catalog::from_json(&serde_json::to_string(&current).unwrap()).unwrap(),
            );
            let library_destination = temporary.path().join("moved-ゲーム");
            let library_plan = service.plan_library_move(&library_destination);
            if constrained {
                assert_eq!(
                    library_plan
                        .unwrap_err()
                        .details
                        .get("runtime_path_requirement")
                        .map(String::as_str),
                    Some("printable-ascii-max-path")
                );
            } else {
                library_plan.unwrap();
            }
            assert!(!library_destination.exists());
            let output_destination = temporary.path().join("output-ゲーム");
            let plan = service
                .plan_output_relocation(&port_id, &output_destination)
                .unwrap();
            assert_eq!(!plan.validation_errors.is_empty(), constrained);
            if constrained {
                assert!(
                    service
                        .authorize_output_relocation(
                            &port_id,
                            &output_destination,
                            &plan.plan_sha256
                        )
                        .is_err()
                );
            }
            assert!(!output_destination.exists());
            assert_eq!(
                std::fs::read(install.path.join(&install.selected_executable)).unwrap(),
                original
            );
        }
    }
}
