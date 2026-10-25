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
        check_prepared_launch(port, Platform::WindowsX86_64, executable, directory, &[]).is_err()
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
        port.executable_hints = [(Platform::WindowsX86_64, vec!["nested/inert.exe".into()])].into();
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
                    .authorize_output_relocation(&port_id, &output_destination, &plan.plan_sha256)
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
