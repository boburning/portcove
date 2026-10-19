use super::*;

pub(crate) fn fixture_port() -> (PortDefinition, SourceProfile) {
    let mut port = crate::Catalog::embedded()
        .unwrap()
        .port("sonic-the-hedgehog-2-recomp")
        .unwrap()
        .clone();
    port.id = "yoshis-cookie-recomp".into();
    port.presentation = None;
    port.source_profile = Some("yoshis-cookie-nes-usa".into());
    port.release.provider = ReleaseSource::Github;
    port.release.repository = "mstan/YoshisCookieRecomp".into();
    port.release.user_prepared.clear();
    port.release.curated.clear();
    port.release.managed_build = BTreeMap::from([(
        Platform::WindowsX86_64,
        CartridgeBuildRecipe::YoshisCookieNesCycle110,
    )]);
    port.executable_hints = BTreeMap::from([(
        Platform::WindowsX86_64,
        vec!["YoshisCookieRecomp.exe".into()],
    )]);
    port.launch_arguments = vec!["game.nes".into()];
    port.launch_environment = BTreeMap::from([("NESRECOMP_NO_LAUNCHER".into(), "1".into())]);
    port.persistent_paths = vec!["config.ini".into(), "config.ini.tmp".into(), "saves".into()];
    port.runtime_mutable_paths.clear();
    port.persistent_file_patterns = vec![crate::PersistentFilePattern {
        prefix: "cyc_shot_".into(),
        suffix: ".png".into(),
    }];
    let profile = SourceProfile {
        id: "yoshis-cookie-nes-usa".into(),
        label: "fixture definition for exact original identity".into(),
        accepted_extensions: vec!["nes".into()],
        accepted_sha1: vec![ORIGINAL_SHA1.into()],
        accepted_sha256: vec![],
        kind: crate::SourceKind::File,
        disc: None,
        members: vec![],
    };
    (port, profile)
}

#[test]
fn fixed_recipe_refuses_different_executable_source_or_persistence() {
    let (port, profile) = fixture_port();
    validate_port(&port, &profile).unwrap();
    for change in 0..7 {
        let mut modified = port.clone();
        let mut source = profile.clone();
        match change {
            0 => modified
                .executable_hints
                .get_mut(&Platform::WindowsX86_64)
                .unwrap()
                .push("other.exe".into()),
            1 => modified.persistent_paths.push("game.nes".into()),
            2 => modified.runtime_mutable_paths.push(RECEIPT.into()),
            3 => source.accepted_sha1.push("0".repeat(40)),
            4 => modified.launch_arguments.push("--hash-out".into()),
            5 => modified.release.provider = ReleaseSource::UserPrepared,
            _ => modified
                .release
                .managed_build
                .insert(
                    Platform::LinuxX86_64,
                    CartridgeBuildRecipe::YoshisCookieNesCycle110,
                )
                .map(|_| ())
                .unwrap_or(()),
        }
        assert!(
            validate_port(&modified, &source).is_err(),
            "change {change} must refuse"
        );
    }
}

#[test]
fn record_metadata_cannot_bless_different_original_bytes() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("original.nes");
    fs::write(&path, vec![0; ORIGINAL_SIZE as usize]).unwrap();
    let source = SourceRecord {
        profile_id: "yoshis-cookie-nes-usa".into(),
        path: path.clone(),
        sha256: ORIGINAL_SHA256.into(),
        size: ORIGINAL_SIZE,
        storage_sha256: ORIGINAL_SHA256.into(),
        storage_size: ORIGINAL_SIZE,
        updated_at: 0,
        observed_identity: None,
    };
    let error =
        CartridgeBuildPreparation::new(CartridgeBuildRecipe::YoshisCookieNesCycle110, source)
            .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
    assert_eq!(
        error
            .details
            .get("recorded_storage_sha256")
            .map(String::as_str),
        Some(ORIGINAL_SHA256)
    );
    assert_eq!(fs::metadata(path).unwrap().len(), ORIGINAL_SIZE);
}

#[test]
fn complete_input_inventory_detects_dependency_changes_and_refuses_hard_links() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("toolchain");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("compiler.exe"), b"inert compiler").unwrap();
    fs::write(root.join("header.h"), b"initial header").unwrap();
    let initial = inventory(&root, &|| Ok(())).unwrap();
    fs::write(root.join("header.h"), b"changed header").unwrap();
    assert_ne!(inventory(&root, &|| Ok(())).unwrap(), initial);
    fs::write(root.join("new-library.dll"), b"unexpected library").unwrap();
    assert_eq!(inventory(&root, &|| Ok(())).unwrap().len(), 3);
    let outside = temporary.path().join("outside");
    fs::write(&outside, b"shared bytes").unwrap();
    fs::hard_link(&outside, root.join("alias")).unwrap();
    let error = inventory(&root, &|| Ok(())).unwrap_err();
    assert!(error.message.contains("hard-linked"));
    assert_eq!(fs::read(outside).unwrap(), b"shared bytes");
}

#[test]
fn generated_identity_refuses_wrong_source_cart_prg_and_ambiguous_outputs() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("cycle-YoshisCookieRecomp");
    let generated = root.join("0123456789abcdef0123/generated");
    fs::create_dir_all(&generated).unwrap();
    let manifest = format!(
        "set(CYC_PROJECT_ROM_SHA256\n  [=[{ORIGINAL_SHA256}]=]\n)\nset(CYC_PROJECT_LAUNCHER_SHA256\n  [=[24b117a0830fcb91d88d9150ff89a374134a9ddebd5eedcb5df21eab580eb2c0]=]\n)\n"
    );
    let dispatch = "const uint32_t cyc_native_cart_hash = 0xDCEE267Bu;\nconst uint32_t cyc_native_prg_hash = 0xF586F909u;\n";
    fs::write(root.join("sources.cmake"), &manifest).unwrap();
    fs::write(generated.join("game_cyc.c"), dispatch).unwrap();
    generated_identity(temporary.path()).unwrap();
    for bad in [
        dispatch.replace("DCEE267B", "00000000"),
        dispatch.replace("F586F909", "00000000"),
    ] {
        fs::write(generated.join("game_cyc.c"), bad).unwrap();
        assert!(
            generated_identity(temporary.path())
                .unwrap_err()
                .message
                .contains("cartridge or PRG")
        );
    }
    fs::write(generated.join("game_cyc.c"), dispatch).unwrap();
    fs::write(
        root.join("sources.cmake"),
        manifest.replace(ORIGINAL_SHA256, &"0".repeat(64)),
    )
    .unwrap();
    assert!(
        generated_identity(temporary.path())
            .unwrap_err()
            .message
            .contains("original identity")
    );
    fs::write(root.join("sources.cmake"), manifest).unwrap();
    fs::create_dir(root.join("abcdef0123456789abcd")).unwrap();
    assert!(
        generated_identity(temporary.path())
            .unwrap_err()
            .message
            .contains("ambiguous")
    );
}

#[test]
fn host_configuration_uses_the_authenticated_tool_paths_and_config_directories() {
    let temporary = tempfile::tempdir().unwrap();
    let tool = temporary.path().join("tool chain");
    let roots = [
        temporary.path().join("game"),
        temporary.path().join("engine"),
        temporary.path().join("ui"),
        tool.clone(),
    ];
    for name in [
        "bin/ninja.exe",
        "bin/clang.exe",
        "bin/clang++.exe",
        "bin/llvm-ar.exe",
        "bin/llvm-ranlib.exe",
        "bin/llvm-windres.exe",
        "bin/ld.lld.exe",
        "python/python.exe",
    ] {
        let file = tool.join(name);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, b"inert tool identity").unwrap();
    }
    let identities = [
        vec![],
        vec![],
        vec![],
        inventory(&tool, &|| Ok(())).unwrap(),
    ];
    let inputs = BuildInputs { roots, identities };
    let arguments = configure_arguments(
        &inputs,
        &inputs.roots[1].join("recompiler"),
        &temporary.path().join("host-build"),
    )
    .unwrap();
    for compiler in ["CMAKE_C_COMPILER_ARG1", "CMAKE_CXX_COMPILER_ARG1"] {
        let value = arguments
            .iter()
            .find(|a| a.starts_with(&format!("-D{compiler}=")))
            .unwrap();
        assert_eq!(
            value,
            &format!(
                "-D{compiler}=--config-user-dir= --config-system-dir= --no-default-config --config=x86_64-w64-windows-gnu.cfg"
            )
        );
    }
    assert!(
        arguments
            .iter()
            .any(|a| a == "-DCMAKE_C_COMPILER_LAUNCHER:STRING=")
    );
    assert!(cmake_path(Path::new("unsafe;path")).is_err());
}

// Synthetic declarations only: no cartridge or generated executable is supplied.
pub(crate) fn fixture_catalog() -> crate::Catalog {
    let (port, profile) = fixture_port();
    let document = crate::CatalogDocument {
        schema_version: 1,
        source_catalog: None,
        source_profiles: vec![profile],
        ports: vec![port],
    };
    crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

#[test]
fn cartridge_contract_roundtrips_and_index_requires_v6() {
    let catalog = fixture_catalog();
    let retained =
        crate::installed_contract::InstalledContract::capture(&catalog, "yoshis-cookie-recomp")
            .unwrap();
    let bytes = serde_json::to_vec(&retained).unwrap();
    let restored: crate::installed_contract::InstalledContract =
        serde_json::from_slice(&bytes).unwrap();
    let decoded = restored.catalog("yoshis-cookie-recomp").unwrap();
    assert_eq!(
        serde_json::to_value(decoded.port("yoshis-cookie-recomp").unwrap()).unwrap(),
        serde_json::to_value(catalog.port("yoshis-cookie-recomp").unwrap()).unwrap()
    );
    let indexed = crate::test_fixture::indexed_catalog(&catalog, "yoshis-cookie-recomp");
    assert_eq!(
        indexed
            .port("yoshis-cookie-recomp")
            .unwrap()
            .release
            .managed_build,
        catalog
            .port("yoshis-cookie-recomp")
            .unwrap()
            .release
            .managed_build
    );
}

#[test]
fn cartridge_storage_identity_cannot_reuse_downloaded_artifact_root() {
    let primary = "3f0b2219479960664312429f464a6c2de2ae155bb112278320e14e94b07bb947";
    let key = CartridgeBuildRecipe::YoshisCookieNesCycle110
        .storage_identity(primary)
        .unwrap();
    assert_eq!(key.len(), 64);
    assert_ne!(key, primary);
    assert_ne!(
        key,
        CartridgeBuildRecipe::YoshisCookieNesCycle110
            .storage_identity(&"a".repeat(64))
            .unwrap()
    );
}

#[test]
fn compiler_groups_bind_the_complete_fixed_manifest_and_refuse_changed_or_unsafe_targets() {
    let temporary = tempfile::tempdir().unwrap();
    let graph = temporary.path().join("build.ninja");
    fs::create_dir(temporary.path().join("CMakeFiles")).unwrap();
    let rules = temporary.path().join("CMakeFiles/rules.ninja");
    fs::write(&rules, b"inert rules fixture; never executed").unwrap();
    let objects: String = (0..COMPILE_OBJECTS).map(|i| format!("build CMakeFiles/YoshisCookieRecomp.dir/object{i}.c.obj: C_COMPILER__YoshisCookieRecomp_unscanned_Release source{i}.c\n")).collect();
    let manifest = format!("include CMakeFiles/rules.ninja\n{objects}");
    fs::write(&graph, &manifest).unwrap();
    let plan = CompilePlan::read(temporary.path()).unwrap();
    assert_eq!(plan.object_targets.len(), 101);
    assert_eq!(
        plan.object_targets.chunks(OBJECTS_PER_INVOCATION).count(),
        13
    );
    assert!(
        plan.object_targets
            .chunks(OBJECTS_PER_INVOCATION)
            .all(|objects| objects.len() <= 8)
    );
    plan.require_unchanged(temporary.path()).unwrap();
    for bad in [
        manifest.replace("object0.c.obj", "../outside.c.obj"),
        manifest.replace("object0.c.obj", "object 0.c.obj"),
        manifest.replace("object0.c.obj", "object$unknown.c.obj"),
        manifest.replace("object0.c.obj", "object$$0.c.obj"),
        manifest.replace("object0.c.obj", "object$:0.c.obj"),
        manifest.replace("object0.c.obj", "object1.c.obj"),
        manifest.replace(
            "C_COMPILER__YoshisCookieRecomp_unscanned_Release",
            "CUSTOM_COMMAND",
        ),
        manifest.replacen(
            "CMakeFiles/YoshisCookieRecomp.dir/",
            "CMakeFiles/Other.dir/",
            1,
        ),
        format!(
            "include CMakeFiles/rules.ninja\n{}",
            objects.lines().skip(1).collect::<Vec<_>>().join("\n")
        ),
        format!(
            "{manifest}build CMakeFiles/YoshisCookieRecomp.dir/extra.c.obj: C_COMPILER__YoshisCookieRecomp_unscanned_Release extra.c\n"
        ),
    ] {
        fs::write(&graph, bad).unwrap();
        assert!(CompilePlan::read(temporary.path()).is_err());
        assert!(plan.require_unchanged(temporary.path()).is_err());
    }
    fs::write(&graph, &manifest).unwrap();
    assert_eq!(CompilePlan::read(temporary.path()).unwrap(), plan);
    fs::write(
        &graph,
        manifest.replace("object0.c.obj", "E_/private$ root/object$ 0.c.obj"),
    )
    .unwrap();
    let spaced = CompilePlan::read(temporary.path()).unwrap();
    assert_eq!(
        spaced.object_targets[0],
        "CMakeFiles/YoshisCookieRecomp.dir/E_/private root/object 0.c.obj"
    );
    fs::write(&graph, &manifest).unwrap();
    fs::write(&rules, b"changed compiler rule fixture").unwrap();
    assert!(plan.require_unchanged(temporary.path()).is_err());
    fs::write(&rules, b"include another.ninja\n").unwrap();
    assert!(CompilePlan::read(temporary.path()).is_err());
    fs::write(&rules, b"inert rules fixture; never executed").unwrap();
    fs::write(&graph, format!("{manifest}include additional.ninja\n")).unwrap();
    assert!(CompilePlan::read(temporary.path()).is_err());
}

#[test]
fn runtime_imports_accept_reviewed_windows_names_but_refuse_unsafe_or_unknown_dependencies() {
    // Names retained from the first real game import inspection. No PE runs here.
    let names = [
        "WS2_32.dll",
        "SDL2.dll",
        "OPENGL32.dll",
        "d2d1.dll",
        "DWrite.dll",
        "ole32.dll",
        "KERNEL32.dll",
        "USER32.dll",
        "SHELL32.dll",
        "comdlg32.dll",
        "libc++.dll",
        "libunwind.dll",
        "api-ms-win-crt-stdio-l1-1-0.dll",
        "api-ms-win-crt-runtime-l1-1-0.dll",
        "api-ms-win-crt-math-l1-1-0.dll",
        "api-ms-win-crt-filesystem-l1-1-0.dll",
        "api-ms-win-crt-conio-l1-1-0.dll",
        "api-ms-win-crt-string-l1-1-0.dll",
        "api-ms-win-crt-environment-l1-1-0.dll",
        "api-ms-win-crt-locale-l1-1-0.dll",
        "api-ms-win-crt-convert-l1-1-0.dll",
        "api-ms-win-crt-heap-l1-1-0.dll",
        "api-ms-win-crt-private-l1-1-0.dll",
        "api-ms-win-crt-utility-l1-1-0.dll",
    ];
    let output = names
        .iter()
        .map(|name| format!("    Name: {name}\n"))
        .collect::<String>();
    let parsed = validate_imports(&output).unwrap();
    assert_eq!(parsed.len(), names.len());
    assert!(parsed.contains(&"ws2_32.dll".to_owned()));
    for bad in [
        "",
        " ",
        "../WS2_32.dll",
        "C:\\WS2_32.dll",
        "WS2_32 .dll",
        "arbitrary.dll",
        "WS2_32.dll\nName: ws2_32.DLL",
        "WS2_32.dll\nName: arbitrary.dll",
    ] {
        assert!(
            validate_imports(&format!("Name: {bad}\n")).is_err(),
            "{bad}"
        );
    }
    assert!(validate_imports("no import records").is_err());
}
