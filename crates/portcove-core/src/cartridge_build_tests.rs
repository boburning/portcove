use super::*;

#[cfg(target_os = "windows")]
struct PlanningRelease(ResolvedRelease);

#[cfg(target_os = "windows")]
#[async_trait::async_trait]
impl crate::ReleaseProvider for PlanningRelease {
    async fn resolve(
        &self,
        _: &PortDefinition,
        _: crate::ReleaseChannel,
        _: Platform,
    ) -> Result<ResolvedRelease> {
        Ok(self.0.clone())
    }
}

#[cfg(target_os = "windows")]
#[tokio::test]
async fn ordinary_cartridge_plan_includes_execution_inputs_and_temporary_capacity_read_only() {
    for (recipe, (port, profile), total) in [
        (
            CartridgeBuildRecipe::YoshisCookieNesCycle110,
            fixture_port(),
            230_411_690,
        ),
        (
            CartridgeBuildRecipe::DrMarioNesCycle130Usa,
            dr_mario_fixture(),
            230_716_233,
        ),
        (
            CartridgeBuildRecipe::AdvanceWarsGbaSourceV1,
            source_build::tests::fixture(source_build::SourceRecipe::AdvanceWarsUsaRev1),
            224_932_042,
        ),
        (
            CartridgeBuildRecipe::EarthBoundSnesSourceV1,
            source_build::tests::fixture(source_build::SourceRecipe::EarthBoundUsa),
            228_366_267,
        ),
        (
            CartridgeBuildRecipe::GundamWingSnesSourceV1,
            source_build::tests::fixture(source_build::SourceRecipe::GundamWingJapan),
            467_081_447,
        ),
    ] {
        let (version, asset) = if let Some(source) = recipe.source_recipe() {
            (source.facts().version, source.primary_asset())
        } else {
            let facts = recipe.facts().unwrap();
            (
                facts.release_version,
                ReleaseAsset {
                    name: facts.asset_name.into(),
                    url: "https://example.invalid/primary.zip".into(),
                    size: facts.asset_size,
                    sha256: facts.asset_sha256.into(),
                },
            )
        };
        let primary_bytes = asset.size;
        let root = tempfile::tempdir().unwrap();
        let library = crate::Library::open(root.path()).unwrap();
        let release = ResolvedRelease {
            version: version.into(),
            channel: crate::ReleaseChannel::Stable,
            published_at: None,
            asset,
        };
        let mut service = crate::PortcoveService::with_provider_read_only(
            library.clone(),
            std::sync::Arc::new(PlanningRelease(release)),
        )
        .unwrap();
        let catalog = crate::Catalog::from_json(
            &serde_json::to_string(&crate::CatalogDocument {
                schema_version: 1,
                source_catalog: None,
                source_profiles: vec![profile],
                ports: vec![port.clone()],
            })
            .unwrap(),
        )
        .unwrap();
        service.replace_catalog_for_test(catalog);
        let before = crate::test_fixture::library_file_snapshot(&library);
        let activities = serde_json::to_value(library.activities(100).unwrap()).unwrap();
        let _volume = crate::output_root::override_volume_details(
            crate::output_root::TestVolumeDetails::Available {
                available_bytes: 1024 * 1024 * 1024,
                total_bytes: 10 * 1024 * 1024 * 1024,
                volume_identity: "fixture-volume".into(),
            },
        );
        let plan = service.plan_install(&port.id, None).await.unwrap();
        assert_eq!(plan.action, crate::InstallPlanAction::Download);
        assert_eq!(plan.download_bytes, total);
        assert_eq!(
            plan.auxiliary_downloads
                .iter()
                .map(|asset| asset.name.as_str())
                .collect::<Vec<_>>(),
            recipe
                .archives()
                .iter()
                .map(|archive| archive.name)
                .collect::<Vec<_>>()
        );
        let space = plan.temporary_space.unwrap();
        let capacity = if recipe == CartridgeBuildRecipe::GundamWingSnesSourceV1 {
            4_294_967_296
        } else {
            2_147_483_648
        };
        assert_eq!(space.required_bytes, capacity + primary_bytes);
        assert_eq!(space.path, plan.output_location.effective_output_directory);
        assert_eq!(space.volume_identity.as_deref(), Some("fixture-volume"));
        assert_eq!(space.sufficient, Some(false));
        assert_eq!(crate::test_fixture::library_file_snapshot(&library), before);
        assert_eq!(
            serde_json::to_value(library.activities(100).unwrap()).unwrap(),
            activities
        );
    }
}

pub(crate) fn fixture_port() -> (PortDefinition, SourceProfile) {
    let mut port: PortDefinition = serde_json::from_str(include_str!(
        "../tests/fixtures/sonic2-083-prepared-port-historical.json"
    ))
    .unwrap();
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

fn dr_mario_fixture() -> (PortDefinition, SourceProfile) {
    let (mut port, mut profile) = fixture_port();
    port.id = "dr-mario-nes-recomp".into();
    port.source_profile = Some("dr-mario-nes-japan-usa-rev1".into());
    port.release.repository = "mstan/DrMarioNesRecomp".into();
    port.release.managed_build = BTreeMap::from([(
        Platform::WindowsX86_64,
        CartridgeBuildRecipe::DrMarioNesCycle130Usa,
    )]);
    port.executable_hints =
        BTreeMap::from([(Platform::WindowsX86_64, vec!["DrMarioRecomp.exe".into()])]);
    profile.id = "dr-mario-nes-japan-usa-rev1".into();
    profile.accepted_sha1 = vec!["0f18c2a5760be0647339b0e3cab9183af86fdd8c".into()];
    (port, profile)
}

#[test]
fn dr_mario_recipe_binds_its_own_source_executable_and_retained_contract() {
    let (port, profile) = dr_mario_fixture();
    validate_port(&port, &profile).unwrap();
    let (yoshi, yoshi_profile) = fixture_port();
    assert!(validate_port(&port, &yoshi_profile).is_err());
    assert!(validate_port(&yoshi, &profile).is_err());
    let mut wrong = port.clone();
    wrong.executable_hints = yoshi.executable_hints;
    assert!(validate_port(&wrong, &profile).is_err());
    let document = crate::CatalogDocument {
        schema_version: 1,
        source_catalog: None,
        source_profiles: vec![profile],
        ports: vec![port],
    };
    let catalog = crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    let retained =
        crate::installed_contract::InstalledContract::capture(&catalog, "dr-mario-nes-recomp")
            .unwrap();
    let restored: crate::installed_contract::InstalledContract =
        serde_json::from_slice(&serde_json::to_vec(&retained).unwrap()).unwrap();
    let decoded = restored.catalog("dr-mario-nes-recomp").unwrap();
    assert_eq!(
        serde_json::to_value(decoded.port("dr-mario-nes-recomp").unwrap()).unwrap(),
        serde_json::to_value(catalog.port("dr-mario-nes-recomp").unwrap()).unwrap()
    );
    crate::test_fixture::indexed_catalog(&catalog, "dr-mario-nes-recomp");
    assert_eq!(
        CartridgeBuildRecipe::DrMarioNesCycle130Usa.minimum_template_version(),
        7
    );
    assert_eq!(
        CartridgeBuildRecipe::YoshisCookieNesCycle110.minimum_template_version(),
        6
    );
}

#[test]
fn dr_mario_generated_identity_and_92_object_graph_refuse_yoshi_or_changed_inputs() {
    let temporary = tempfile::tempdir().unwrap();
    let cycle = temporary.path().join("cycle-DrMarioRecomp");
    let generated = cycle.join("0123456789abcdef0123").join("generated");
    fs::create_dir_all(&generated).unwrap();
    let source_manifest = "set(CYC_PROJECT_ROM_SHA256\n  [=[5f4849329f0ece227a3c7d6a63c0ecb6c9a1edee424e70e7bc6fa4bfda4a82d8]=]\n)\nset(CYC_PROJECT_LAUNCHER_SHA256\n  [=[d2fbe8b10f762099d320016ddfd4d2961a591fe6dfaaab2efbeb77282264d06a]=]\n)\n";
    fs::write(cycle.join("sources.cmake"), source_manifest).unwrap();
    let dispatch = "const uint32_t cyc_native_cart_hash = 0x7422B8F0u;\nconst uint32_t cyc_native_prg_hash = 0x8F8C755Eu;\n";
    let dispatch_path = generated.join("game_cyc.c");
    fs::write(&dispatch_path, dispatch).unwrap();
    let recipe = CartridgeBuildRecipe::DrMarioNesCycle130Usa;
    generated_identity(temporary.path(), recipe).unwrap();
    for changed in [
        dispatch.replace("7422B8F0", "DCEE267B"),
        dispatch.replace("8F8C755E", "F586F909"),
    ] {
        fs::write(&dispatch_path, changed).unwrap();
        assert!(generated_identity(temporary.path(), recipe).is_err());
    }
    fs::write(&dispatch_path, dispatch).unwrap();
    fs::write(
        cycle.join("sources.cmake"),
        source_manifest.replace("5f484932", "00000000"),
    )
    .unwrap();
    assert!(generated_identity(temporary.path(), recipe).is_err());
    fs::write(cycle.join("sources.cmake"), source_manifest).unwrap();
    fs::create_dir(temporary.path().join("CMakeFiles")).unwrap();
    fs::write(
        temporary.path().join("CMakeFiles/rules.ninja"),
        "inert compiler rules; never executed",
    )
    .unwrap();
    let graph = temporary.path().join("build.ninja");
    // Counts are independent measurements, not generated from RecipeFacts.
    for count in [91, 92, 93] {
        let objects: String = (0..count).map(|i|format!("build CMakeFiles/DrMarioRecomp.dir/object{i}.c.obj: C_COMPILER__DrMarioRecomp_unscanned_Release source{i}.c\n")).collect();
        fs::write(&graph, format!("include CMakeFiles/rules.ninja\n{objects}")).unwrap();
        assert_eq!(
            CompilePlan::read(temporary.path(), recipe).is_ok(),
            count == 92
        );
        assert!(
            CompilePlan::read(
                temporary.path(),
                CartridgeBuildRecipe::YoshisCookieNesCycle110
            )
            .is_err()
        );
    }
}

#[test]
fn dr_mario_build_input_cannot_reuse_yoshi_or_a_changed_asset() {
    let recipe = CartridgeBuildRecipe::DrMarioNesCycle130Usa;
    let preparation = CartridgeBuildPreparation {
        recipe,
        source: SourceRecord {
            profile_id: "dr-mario-nes-japan-usa-rev1".into(),
            path: PathBuf::from("not-supplied.nes"),
            sha256: "5f4849329f0ece227a3c7d6a63c0ecb6c9a1edee424e70e7bc6fa4bfda4a82d8".into(),
            size: 65552,
            storage_sha256: "5f4849329f0ece227a3c7d6a63c0ecb6c9a1edee424e70e7bc6fa4bfda4a82d8"
                .into(),
            storage_size: 65552,
            updated_at: 0,
            observed_identity: None,
        },
        worker_test_latch: None,
    };
    let accepted = ResolvedRelease {
        version: "v1.3.0".into(), channel: crate::ReleaseChannel::Stable, published_at: None,
        asset: ReleaseAsset { name: "DrMarioRecomp-usa-windows-x64.zip".into(), url: "https://github.com/mstan/DrMarioNesRecomp/releases/download/v1.3.0/DrMarioRecomp-usa-windows-x64.zip".into(), size: 3_709_949, sha256: "80e9606b0795bf09cadc57cd5ac97ff292f35436011800a406060f3a1a86ae5f".into() },
    };
    preparation.verify_release(&accepted).unwrap();
    for change in 0..5 {
        let mut changed = accepted.clone();
        match change {
            0 => changed.version = "v1.1.0".into(),
            1 => changed.channel = crate::ReleaseChannel::Beta,
            2 => changed.asset.name = "YoshisCookieRecomp-windows-x64.zip".into(),
            3 => changed.asset.size += 1,
            _ => {
                changed.asset.sha256 =
                    "3f0b2219479960664312429f464a6c2de2ae155bb112278320e14e94b07bb947".into()
            }
        }
        let error = preparation.verify_release(&changed).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert_eq!(
            error.message,
            "cartridge build requires its exact reviewed release input"
        );
    }
    let primary = "80e9606b0795bf09cadc57cd5ac97ff292f35436011800a406060f3a1a86ae5f";
    assert_ne!(
        recipe.storage_identity(primary).unwrap(),
        CartridgeBuildRecipe::YoshisCookieNesCycle110
            .storage_identity(primary)
            .unwrap()
    );
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
fn fixed_build_input_refuses_a_changed_release_without_preparing_output() {
    let temporary = tempfile::tempdir().unwrap();
    // This tests only the release-input boundary. No cartridge is supplied or
    // admitted; the independently pinned upstream tuple is not read from code.
    let preparation = CartridgeBuildPreparation {
        recipe: CartridgeBuildRecipe::YoshisCookieNesCycle110,
        source: SourceRecord {
            profile_id: "yoshis-cookie-nes-usa".into(),
            path: temporary.path().join("not-supplied.nes"),
            sha256: ORIGINAL_SHA256.into(),
            size: ORIGINAL_SIZE,
            storage_sha256: ORIGINAL_SHA256.into(),
            storage_size: ORIGINAL_SIZE,
            updated_at: 0,
            observed_identity: None,
        },
        worker_test_latch: None,
    };
    let accepted = ResolvedRelease {
        version: "v1.1.0".into(),
        channel: crate::ReleaseChannel::Stable,
        published_at: Some("2026-10-05T06:06:13Z".into()),
        asset: ReleaseAsset {
            name: "YoshisCookieRecomp-windows-x64.zip".into(),
            url: "https://github.com/mstan/YoshisCookieRecomp/releases/download/v1.1.0/YoshisCookieRecomp-windows-x64.zip".into(),
            size: 3_919_022,
            sha256: "3f0b2219479960664312429f464a6c2de2ae155bb112278320e14e94b07bb947".into(),
        },
    };
    preparation.verify_release(&accepted).unwrap();
    let mut changed = vec![accepted.clone(); 5];
    changed[0].version = "v1.2.0".into();
    changed[1].channel = crate::ReleaseChannel::Beta;
    changed[2].asset.name = "DrMarioRecomp-windows-x64.zip".into();
    changed[3].asset.size += 1;
    changed[4].asset.sha256 = "0".repeat(64);
    for release in changed {
        let error = preparation.verify_release(&release).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert_eq!(
            error.message,
            "cartridge build requires its exact reviewed release input"
        );
        assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 0);
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
    generated_identity(
        temporary.path(),
        CartridgeBuildRecipe::YoshisCookieNesCycle110,
    )
    .unwrap();
    for bad in [
        dispatch.replace("DCEE267B", "00000000"),
        dispatch.replace("F586F909", "00000000"),
    ] {
        fs::write(generated.join("game_cyc.c"), bad).unwrap();
        assert!(
            generated_identity(
                temporary.path(),
                CartridgeBuildRecipe::YoshisCookieNesCycle110
            )
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
        generated_identity(
            temporary.path(),
            CartridgeBuildRecipe::YoshisCookieNesCycle110
        )
        .unwrap_err()
        .message
        .contains("original identity")
    );
    fs::write(root.join("sources.cmake"), manifest).unwrap();
    fs::create_dir(root.join("abcdef0123456789abcd")).unwrap();
    assert!(
        generated_identity(
            temporary.path(),
            CartridgeBuildRecipe::YoshisCookieNesCycle110
        )
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
    let inputs = BuildInputs {
        recipe: CartridgeBuildRecipe::YoshisCookieNesCycle110,
        roots: roots.into(),
        identities: identities.into(),
    };
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
    // Independently reconstructed from the prior actual build receipt before
    // extracting recipe facts. Preserve the existing serialized tuple exactly.
    assert_eq!(
        key,
        "c8244ea817b868583391a4978c92b09135afdb88976030c6e2f28e267a37bc13"
    );
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
    let objects: String = (0..101).map(|i| format!("build CMakeFiles/YoshisCookieRecomp.dir/object{i}.c.obj: C_COMPILER__YoshisCookieRecomp_unscanned_Release source{i}.c\n")).collect();
    let manifest = format!("include CMakeFiles/rules.ninja\n{objects}");
    fs::write(&graph, &manifest).unwrap();
    let plan = CompilePlan::read(
        temporary.path(),
        CartridgeBuildRecipe::YoshisCookieNesCycle110,
    )
    .unwrap();
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
        assert!(
            CompilePlan::read(
                temporary.path(),
                CartridgeBuildRecipe::YoshisCookieNesCycle110
            )
            .is_err()
        );
        assert!(plan.require_unchanged(temporary.path()).is_err());
    }
    fs::write(&graph, &manifest).unwrap();
    assert_eq!(
        CompilePlan::read(
            temporary.path(),
            CartridgeBuildRecipe::YoshisCookieNesCycle110
        )
        .unwrap(),
        plan
    );
    fs::write(
        &graph,
        manifest.replace("object0.c.obj", "E_/private$ root/object$ 0.c.obj"),
    )
    .unwrap();
    let spaced = CompilePlan::read(
        temporary.path(),
        CartridgeBuildRecipe::YoshisCookieNesCycle110,
    )
    .unwrap();
    assert_eq!(
        spaced.object_targets[0],
        "CMakeFiles/YoshisCookieRecomp.dir/E_/private root/object 0.c.obj"
    );
    fs::write(&graph, &manifest).unwrap();
    fs::write(&rules, b"changed compiler rule fixture").unwrap();
    assert!(plan.require_unchanged(temporary.path()).is_err());
    fs::write(&rules, b"include another.ninja\n").unwrap();
    assert!(
        CompilePlan::read(
            temporary.path(),
            CartridgeBuildRecipe::YoshisCookieNesCycle110
        )
        .is_err()
    );
    fs::write(&rules, b"inert rules fixture; never executed").unwrap();
    fs::write(&graph, format!("{manifest}include additional.ninja\n")).unwrap();
    assert!(
        CompilePlan::read(
            temporary.path(),
            CartridgeBuildRecipe::YoshisCookieNesCycle110
        )
        .is_err()
    );
}

#[test]
fn compiler_plan_oracle_preserves_cxx_order_complete_digests_and_case_identity() {
    let temporary = tempfile::tempdir().unwrap();
    fs::create_dir(temporary.path().join("CMakeFiles")).unwrap();
    fs::write(
        temporary.path().join("CMakeFiles/rules.ninja"),
        b"inert pre-extraction CXX and order oracle\n",
    )
    .unwrap();
    // This is an inert, independently fixed pre-extraction oracle. Neither
    // count nor expected digests come from RecipeFacts or the parsed plan.
    let objects: String = (0..101)
        .rev()
        .map(|i| {
            let language = if i == 100 { "CXX" } else { "C" };
            format!("build CMakeFiles/YoshisCookieRecomp.dir/object{i}.c.obj: {language}_COMPILER__YoshisCookieRecomp_unscanned_Release source{i}.c\n")
        })
        .collect();
    let manifest = format!("include CMakeFiles/rules.ninja\n{objects}");
    let graph = temporary.path().join("build.ninja");
    fs::write(&graph, &manifest).unwrap();
    let plan = CompilePlan::read(
        temporary.path(),
        CartridgeBuildRecipe::YoshisCookieNesCycle110,
    )
    .unwrap();
    assert_eq!(
        plan.manifest_sha256,
        "a08e63a1e0d9a9f3d42cd6479825a5da0617c5ccc132b055a422abc8d09adc6c"
    );
    assert_eq!(
        plan.rules_sha256,
        "8d340fb3791bed2901736e8910cd0cbcc55fce859b451a2cbf8a9b79e0112407"
    );
    assert_eq!(plan.object_targets.len(), 101);
    assert_eq!(
        plan.object_targets[0],
        "CMakeFiles/YoshisCookieRecomp.dir/object100.c.obj"
    );
    assert_eq!(
        plan.object_targets[50],
        "CMakeFiles/YoshisCookieRecomp.dir/object50.c.obj"
    );
    assert_eq!(
        plan.object_targets[100],
        "CMakeFiles/YoshisCookieRecomp.dir/object0.c.obj"
    );
    fs::write(
        &graph,
        manifest.replace("object99.c.obj", "OBJECT100.c.obj"),
    )
    .unwrap();
    assert!(
        CompilePlan::read(
            temporary.path(),
            CartridgeBuildRecipe::YoshisCookieNesCycle110
        )
        .is_err()
    );
}

#[test]
fn fixed_target_plan_enforces_independent_nonempty_object_bounds() {
    let temporary = tempfile::tempdir().unwrap();
    fs::create_dir(temporary.path().join("CMakeFiles")).unwrap();
    fs::write(
        temporary.path().join("CMakeFiles/rules.ninja"),
        "# fixed rules\n",
    )
    .unwrap();
    fs::write(
        temporary.path().join("build.ninja"),
        "include CMakeFiles/rules.ninja\nbuild CMakeFiles/FixedTarget.dir/a.c.obj: C_COMPILER__FixedTarget_unscanned_Release a.c\nbuild CMakeFiles/FixedTarget.dir/b.cpp.obj: CXX_COMPILER__FixedTarget_unscanned_Release b.cpp\n",
    ).unwrap();
    let plan = CompilePlan::read_target(temporary.path(), "FixedTarget", 2..=3).unwrap();
    assert_eq!(
        plan.object_targets,
        [
            "CMakeFiles/FixedTarget.dir/a.c.obj",
            "CMakeFiles/FixedTarget.dir/b.cpp.obj"
        ]
    );
    for limits in [
        0..=2,
        std::ops::RangeInclusive::new(3, 2),
        1..=1,
        3..=3,
        1..=20_001,
    ] {
        assert!(CompilePlan::read_target(temporary.path(), "FixedTarget", limits).is_err());
    }
    for target in [
        "",
        "../FixedTarget",
        "FixedTarget.dir/",
        "FixedTarget\n",
        "FixedTarget$ ",
    ] {
        assert!(CompilePlan::read_target(temporary.path(), target, 2..=2).is_err());
    }
}

#[test]
fn crash_report_import_is_scoped_without_relaxing_existing_recipes() {
    let imports = "Name: KERNEL32.dll\nName: DBGHELP.dll\n";
    assert!(validate_imports(imports).is_err());
    assert_eq!(
        validate_imports_with_crash_reports(imports, true).unwrap(),
        ["dbghelp.dll", "kernel32.dll"]
    );
    assert!(validate_imports_with_crash_reports("Name: other.dll\n", true).is_err());
    assert!(
        validate_imports_with_crash_reports("Name: DBGHELP.dll\nName: dbghelp.DLL\n", true)
            .is_err()
    );
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
    let drive_rooted_import = ["C:", "WS2_32.dll"].join("\\");
    for bad in [
        "",
        " ",
        "../WS2_32.dll",
        drive_rooted_import.as_str(),
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
