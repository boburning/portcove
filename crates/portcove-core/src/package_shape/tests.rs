use super::*;

const PLATFORM: Platform = Platform::WindowsX86_64;
const SHA: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_SHA: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn port() -> PortDefinition {
    let mut port = crate::Catalog::embedded()
        .unwrap()
        .port("super-mario-world-recomp")
        .unwrap()
        .clone();
    port.id = "shape-fixture".into();
    port.persistent_paths = vec![
        "config.ini".into(),
        "input.ini".into(),
        "saves".into(),
        "mods/state.toml".into(),
    ];
    port.persistent_file_patterns.clear();
    port.reviewed_package_layouts.clear();
    port.executable_hints = [(PLATFORM, vec!["Game.exe".into()])].into();
    port
}

const REVIEWED: &[&str] = &[
    "Game.exe",
    "config.ini",
    "data/level.dat",
    "lib/helper.dll",
    "mods/packages/base/manifest.toml",
    "saves/README.txt",
    "README.md",
];

fn package(files: &[&str]) -> tempfile::TempDir {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("game-1.0");
    for file in files {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }
    temporary
}

fn shape_of(port: &PortDefinition, files: &[&str]) -> PackageShape {
    let package = package(files);
    let qualification = crate::install::InstallQualification::from_port(port, PLATFORM).unwrap();
    let roots = roots(port, &qualification, PLATFORM, package.path()).unwrap();
    derive(port, PLATFORM, &roots).unwrap()
}

fn table_for(port: &PortDefinition, files: &[&str]) -> Vec<GeneratedEntry> {
    vec![GeneratedEntry {
        port_id: port.id.clone(),
        platform: PLATFORM,
        version: "v1.0".into(),
        sha256: SHA.into(),
        derivation_inputs_sha256: SHA.into(),
        shape_version: Some(COMPONENT_RULES_VERSION),
        shape: shape_of(port, files),
        player_candidates: None,
    }]
}

fn verdict_with(files: &[&str]) -> ShapeVerdict {
    let port = port();
    let table = table_for(&port, REVIEWED);
    let observed = shape_of(&port, files);
    evaluate_with_table(&table, &port, PLATFORM, OTHER_SHA, &observed, None).0
}

fn changes(verdict: &ShapeVerdict) -> &[ShapeChange] {
    match verdict {
        ShapeVerdict::Drifted { changes, .. } => changes,
        other => panic!("expected drift, got {other:?}"),
    }
}

fn change(verdict: &ShapeVerdict, component: ShapeComponent) -> &ShapeChange {
    changes(verdict)
        .iter()
        .find(|change| change.component == component)
        .unwrap_or_else(|| panic!("no {component:?} change in {verdict:?}"))
}

#[test]
fn shape_records_every_part_through_a_wrapper() {
    let shape = shape_of(&port(), REVIEWED);
    assert_eq!(
        shape.programs.as_deref(),
        Some(&["game.exe".to_owned()][..])
    );
    assert_eq!(
        shape.top_directories.as_deref(),
        Some(&["data", "lib", "mods", "saves"].map(String::from)[..])
    );
    assert_eq!(
        shape.persistent_parent_children.as_deref(),
        Some(&["mods/packages".to_owned()][..])
    );
    assert_eq!(
        shape.persistent_overlap.as_deref(),
        Some(&["config.ini", "saves/readme.txt"].map(String::from)[..])
    );
    assert_eq!(
        shape.config_files.as_deref(),
        Some(&["config.ini", "mods/packages/base/manifest.toml"].map(String::from)[..])
    );
    assert_eq!(shape.missing_persistent_parents.as_deref(), Some(&[][..]));
}

#[cfg(unix)]
#[test]
fn only_the_verified_empty_portable_directory_is_neutral_to_shape() {
    const PLATFORM: Platform = Platform::LinuxX86_64;
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("nicholas-ochoa-opensc2k").unwrap();
    let package = package(&["OpenSC2K.x86_64", "licenses/fixture.txt"]);
    let root = package.path().join("game-1.0");
    let mut elf = [0_u8; 48];
    elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
    elf[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
    fs::write(root.join("OpenSC2K.x86_64"), elf).unwrap();
    crate::permissions::normalize_archive_entry(&root.join("OpenSC2K.x86_64"), false, true)
        .unwrap();
    let qualification = crate::install::InstallQualification::from_port(port, PLATFORM).unwrap();
    let observed = || {
        let roots = roots(port, &qualification, PLATFORM, package.path())?;
        derive(port, PLATFORM, &roots)
    };
    let absent = observed().unwrap();
    fs::create_dir(root.join("data")).unwrap();
    assert_eq!(observed().unwrap(), absent);
    fs::create_dir(root.join("data/empty")).unwrap();
    assert!(
        observed().is_err(),
        "even a nested empty directory populates the data slot"
    );
    fs::remove_dir(root.join("data/empty")).unwrap();
    fs::remove_dir(root.join("data")).unwrap();

    fs::create_dir(root.join("DATA")).unwrap();
    assert!(
        observed().is_err(),
        "a case alias is not the declared directory"
    );
    fs::remove_dir(root.join("DATA")).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("licenses", root.join("data")).unwrap();
        assert!(
            observed().is_err(),
            "a linked directory is not the declared slot"
        );
        fs::remove_file(root.join("data")).unwrap();
    }
    fs::create_dir(root.join("other")).unwrap();
    let unknown = observed().unwrap();
    assert!(matches!(
        evaluate(port, PLATFORM, SHA, &unknown, None, None).0,
        ShapeVerdict::Drifted { .. }
    ));
}

#[test]
fn a_compatible_release_with_the_same_shape_passes_without_edits() {
    let mut files = REVIEWED.to_vec();
    files.extend([
        "data/new-level.dat",
        "lib/other.dll",
        "CHANGELOG.md",
        "mods/packages/base/extra.bin",
    ]);
    let verdict = verdict_with(&files);
    assert_eq!(
        verdict,
        ShapeVerdict::Compatible {
            baseline: ShapeBaseline::Generated {
                version: "v1.0".into(),
                sha256: SHA.into(),
                exact: false,
            }
        }
    );
    let port = port();
    let table = table_for(&port, REVIEWED);
    let (_, provenance) = evaluate_with_table(
        &table,
        &port,
        PLATFORM,
        OTHER_SHA,
        &shape_of(&port, &files),
        None,
    );
    assert_eq!(provenance, ShapeProvenance::Inherited);
    let (exact, provenance) = evaluate_with_table(
        &table,
        &port,
        PLATFORM,
        SHA,
        &shape_of(&port, REVIEWED),
        None,
    );
    assert!(matches!(
        exact,
        ShapeVerdict::Compatible {
            baseline: ShapeBaseline::Generated { exact: true, .. }
        }
    ));
    assert_eq!(provenance, ShapeProvenance::Reviewed);
}

#[test]
fn a_mods_preloaded_move_is_drift_in_persistent_parent_children() {
    let files = [
        "Game.exe",
        "config.ini",
        "data/level.dat",
        "lib/helper.dll",
        "mods/preloaded/packages/base/manifest.toml",
        "saves/README.txt",
    ];
    let verdict = verdict_with(&files);
    let moved = change(&verdict, ShapeComponent::PersistentParentChildren);
    assert_eq!(moved.added, ["mods/preloaded"]);
    assert_eq!(moved.removed, ["mods/packages"]);
}

#[test]
fn a_new_saves_subfolder_is_drift() {
    let mut files = REVIEWED.to_vec();
    files.push("saves/netplay/README.txt");
    let verdict = verdict_with(&files);
    assert_eq!(
        change(&verdict, ShapeComponent::PersistentParentChildren).added,
        ["saves/netplay"]
    );
    assert_eq!(
        change(&verdict, ShapeComponent::PersistentOverlap).added,
        ["saves/netplay/readme.txt"]
    );
}

#[test]
fn a_new_program_is_drift() {
    let mut files = REVIEWED.to_vec();
    files.extend(["tools/report.exe", "Collect-Diagnostics.ps1"]);
    let verdict = verdict_with(&files);
    let programs = change(&verdict, ShapeComponent::Programs);
    assert_eq!(
        programs.added,
        ["collect-diagnostics.ps1", "tools/report.exe"]
    );
    assert_eq!(programs.added_count, 2);
    assert_eq!(
        change(&verdict, ShapeComponent::TopDirectories).added,
        ["tools"]
    );
}

#[test]
fn a_shipped_file_on_a_persistent_path_is_drift() {
    let mut files = REVIEWED.to_vec();
    files.push("input.ini");
    let verdict = verdict_with(&files);
    assert_eq!(
        change(&verdict, ShapeComponent::PersistentOverlap).added,
        ["input.ini"]
    );
    assert_eq!(
        change(&verdict, ShapeComponent::ConfigFiles).added,
        ["input.ini"]
    );
}

#[test]
fn file_patterns_count_as_persistent_overlap() {
    let mut port = port();
    port.persistent_file_patterns = vec![crate::PersistentFilePattern {
        prefix: "Profile-".into(),
        suffix: ".sav".into(),
        allow_empty_middle: false,
    }];
    let mut files = REVIEWED.to_vec();
    files.extend(["profile-default.sav", "data/profile-other.sav"]);
    let shape = shape_of(&port, &files);
    assert_eq!(
        shape.persistent_overlap.as_deref(),
        Some(&["config.ini", "profile-default.sav", "saves/readme.txt"].map(String::from)[..])
    );
}

#[test]
fn a_config_added_or_removed_is_drift() {
    let mut added = REVIEWED.to_vec();
    added.extend(["data/execution.json", "RELEASE_MANIFEST.json"]);
    let verdict = verdict_with(&added);
    let configs = change(&verdict, ShapeComponent::ConfigFiles);
    assert_eq!(
        configs.added,
        ["data/execution.json", "release_manifest.json"]
    );
    assert!(configs.removed.is_empty());

    let removed = REVIEWED
        .iter()
        .copied()
        .filter(|file| *file != "config.ini")
        .collect::<Vec<_>>();
    let verdict = verdict_with(&removed);
    assert_eq!(
        change(&verdict, ShapeComponent::ConfigFiles).removed,
        ["config.ini"]
    );
    assert_eq!(
        change(&verdict, ShapeComponent::PersistentOverlap).removed,
        ["config.ini"]
    );
}

#[test]
fn a_missing_persistent_parent_is_drift() {
    let files = REVIEWED
        .iter()
        .copied()
        .filter(|file| !file.starts_with("mods/"))
        .collect::<Vec<_>>();
    let verdict = verdict_with(&files);
    assert_eq!(
        change(&verdict, ShapeComponent::MissingPersistentParents).added,
        ["mods"]
    );
    assert_eq!(
        change(&verdict, ShapeComponent::TopDirectories).removed,
        ["mods"]
    );
}

#[test]
fn no_baseline_is_unknown_not_a_pass() {
    let port = port();
    let observed = shape_of(&port, REVIEWED);
    let (verdict, provenance) = evaluate_with_table(&[], &port, PLATFORM, SHA, &observed, None);
    assert_eq!(
        verdict,
        ShapeVerdict::Unknown {
            baseline: None,
            reason: ShapeUnknownReason::NoBaseline,
            unknown: Vec::new(),
            detail: None,
        }
    );
    assert_eq!(provenance, ShapeProvenance::Unreviewed);
}

#[test]
fn a_baseline_part_it_does_not_know_is_unknown_not_a_pass() {
    let mut port = port();
    port.reviewed_package_layouts.insert(
        PLATFORM,
        crate::ReviewedPackageLayout {
            ignore_verified_macos_libraries: false,
            classify_linux_programs_by_format: false,
            directories: ["data", "lib", "mods", "saves"].map(String::from).to_vec(),
            executables: vec!["game.exe".into()],
        },
    );
    let observed = shape_of(&port, REVIEWED);
    let (verdict, provenance) = evaluate_with_table(&[], &port, PLATFORM, SHA, &observed, None);
    let ShapeVerdict::Unknown {
        baseline: Some(ShapeBaseline::ReviewedLayout),
        reason: ShapeUnknownReason::IncompleteComparison,
        unknown,
        ..
    } = verdict
    else {
        panic!("expected an incomplete comparison, got {verdict:?}");
    };
    assert_eq!(
        unknown,
        [
            ShapeComponent::PersistentParentChildren,
            ShapeComponent::PersistentOverlap,
            ShapeComponent::ConfigFiles,
            ShapeComponent::MissingPersistentParents,
        ]
    );
    assert_eq!(provenance, ShapeProvenance::Unreviewed);
    // A known part that differs is still drift.
    let mut files = REVIEWED.to_vec();
    files.push("Updater.exe");
    let observed = shape_of(&port, &files);
    let (verdict, _) = evaluate_with_table(&[], &port, PLATFORM, SHA, &observed, None);
    assert_eq!(
        change(&verdict, ShapeComponent::Programs).added,
        ["updater.exe"]
    );
}

#[test]
fn an_unresolved_executable_leaves_persistent_parts_unknown() {
    let port = port();
    let table = table_for(&port, REVIEWED);
    let files = REVIEWED
        .iter()
        .copied()
        .filter(|file| *file != "Game.exe")
        .collect::<Vec<_>>();
    let observed = shape_of(&port, &files);
    assert!(observed.persistent_overlap.is_none());
    let (verdict, _) = evaluate_with_table(&table, &port, PLATFORM, OTHER_SHA, &observed, None);
    let ShapeVerdict::Drifted { unknown, .. } = &verdict else {
        panic!("expected drift, got {verdict:?}");
    };
    assert_eq!(unknown.len(), 3);
    assert_eq!(
        change(&verdict, ShapeComponent::Programs).removed,
        ["game.exe"]
    );
}

#[test]
fn the_local_installation_is_the_fallback_baseline_with_its_provenance() {
    let port = port();
    let reviewed = shape_of(&port, REVIEWED);
    let local = LocalBaseline {
        install_id: "install-1".into(),
        version: "v1.0".into(),
        sha256: SHA.into(),
        record: PackageShapeRecord {
            shape_version: SHAPE_VERSION,
            shape: Some(reviewed.clone()),
            provenance: ShapeProvenance::Reviewed,
            verdict: ShapeVerdict::Compatible {
                baseline: ShapeBaseline::ReviewedLayout,
            },
        },
    };
    let (verdict, provenance) =
        evaluate_with_table(&[], &port, PLATFORM, OTHER_SHA, &reviewed, Some(&local));
    assert!(matches!(
        verdict,
        ShapeVerdict::Compatible {
            baseline: ShapeBaseline::Local {
                provenance: ShapeProvenance::Reviewed,
                ..
            }
        }
    ));
    assert_eq!(provenance, ShapeProvenance::Inherited);
    let unreviewed = LocalBaseline {
        record: PackageShapeRecord {
            provenance: ShapeProvenance::Unreviewed,
            ..local.record.clone()
        },
        ..local
    };
    let (_, provenance) = evaluate_with_table(
        &[],
        &port,
        PLATFORM,
        OTHER_SHA,
        &reviewed,
        Some(&unreviewed),
    );
    assert_eq!(provenance, ShapeProvenance::Unreviewed);
}

#[test]
fn the_newest_generated_entry_is_the_baseline_for_a_new_artifact() {
    let port = port();
    let mut table = table_for(&port, REVIEWED);
    let mut newer = REVIEWED.to_vec();
    newer.push("tools/report.exe");
    table.push(GeneratedEntry {
        version: "v1.1".into(),
        sha256: OTHER_SHA.into(),
        derivation_inputs_sha256: OTHER_SHA.into(),
        ..table_for(&port, &newer).remove(0)
    });
    let observed = shape_of(&port, &newer);
    let candidate = "3333333333333333333333333333333333333333333333333333333333333333";
    let (verdict, _) = evaluate_with_table(&table, &port, PLATFORM, candidate, &observed, None);
    assert!(matches!(
        verdict,
        ShapeVerdict::Compatible {
            baseline: ShapeBaseline::Generated { ref version, exact: false, .. }
        } if version == "v1.1"
    ));
    // An older exactly listed artifact still matches itself.
    let (verdict, _) = evaluate_with_table(
        &table,
        &port,
        PLATFORM,
        SHA,
        &shape_of(&port, REVIEWED),
        None,
    );
    assert!(matches!(
        verdict,
        ShapeVerdict::Compatible {
            baseline: ShapeBaseline::Generated { exact: true, .. }
        }
    ));
}

#[test]
fn change_lists_are_bounded_with_exact_counts() {
    let mut files = REVIEWED.to_vec();
    let extra = (0..40)
        .map(|index| format!("data/{index:02}.json"))
        .collect::<Vec<_>>();
    files.extend(extra.iter().map(String::as_str));
    let verdict = verdict_with(&files);
    let configs = change(&verdict, ShapeComponent::ConfigFiles);
    assert_eq!(configs.added_count, 40);
    assert_eq!(configs.added.len(), REPORTED_CHANGE_PATHS);
}

#[test]
fn the_embedded_generated_table_is_current_and_bound_to_reviewed_catalog_artifacts() {
    let entries = parse_table(GENERATED_TABLE).unwrap();
    let catalog = crate::Catalog::embedded().unwrap();
    let document: serde_json::Value =
        serde_json::from_str(include_str!("../../catalog/catalog.json")).unwrap();
    let reviewed = |port_id: &str, sha256: &str, version: &str| {
        let applicability = document["source_catalog"]["contracts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|contract| contract["port_id"] == port_id)
            .flat_map(|contract| {
                contract["applicability"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .any(|row| row["artifact_sha256"] == sha256 && row["upstream_ref"] == version);
        let held = catalog
            .port(port_id)
            .ok()
            .and_then(|port| port.managed_acquisition_hold.as_ref())
            .is_some_and(|hold| {
                hold.reviewed_artifacts
                    .iter()
                    .any(|artifact| artifact.sha256 == sha256 && artifact.version == version)
            });
        applicability || held
    };
    let raw_port = |port_id: &str| {
        document["ports"]
            .as_array()
            .unwrap()
            .iter()
            .find(|port| port["id"] == port_id)
            .unwrap()
    };
    // Core's embedded lookup is the same digest the inspection command reports.
    let first = entries.first().unwrap();
    assert_eq!(
        embedded_derivation_inputs_sha256(&first.port_id, first.platform).as_deref(),
        Some(first.derivation_inputs_sha256.as_str())
    );
    let mut seen = BTreeSet::new();
    for entry in &entries {
        let port = catalog.port(&entry.port_id).unwrap();
        assert!(
            port.platforms.contains(&entry.platform),
            "{}",
            entry.port_id
        );
        assert!(
            reviewed(&entry.port_id, &entry.sha256, &entry.version),
            "{} {} {} is no longer a reviewed catalog artifact; run node scripts/package-shape-baselines.mts --prune",
            entry.port_id,
            entry.version,
            entry.sha256
        );
        let platform = serde_json::to_value(entry.platform).unwrap();
        assert_eq!(
            entry.derivation_inputs_sha256,
            derivation_inputs_sha256(raw_port(&entry.port_id), platform.as_str().unwrap()).unwrap(),
            "{} catalog facts the shape derivation reads changed; run node scripts/package-shape-baselines.mts --prune",
            entry.port_id
        );
        assert!(seen.insert((&entry.port_id, entry.platform, &entry.sha256)));
    }
}

#[test]
fn generated_baseline_compares_against_active_definition_inputs() {
    let catalog = crate::Catalog::embedded().unwrap();
    for entry in generated_table() {
        let mut port = catalog.port(&entry.port_id).unwrap().clone();
        port.summary = "A revised player-facing summary.".into();
        let (verdict, provenance) = evaluate(
            &port,
            entry.platform,
            &entry.sha256,
            &entry.shape,
            None,
            None,
        );
        assert!(
            matches!(verdict, ShapeVerdict::Compatible { .. }),
            "{}",
            entry.port_id
        );
        assert_eq!(provenance, ShapeProvenance::Reviewed);

        port.persistent_paths.push("new-save-root".into());
        let (verdict, provenance) = evaluate(
            &port,
            entry.platform,
            &entry.sha256,
            &entry.shape,
            None,
            None,
        );
        assert!(
            matches!(
                verdict,
                ShapeVerdict::Unknown {
                    baseline: Some(ShapeBaseline::Generated { exact: true, .. }),
                    reason: ShapeUnknownReason::IncompleteComparison,
                    ..
                }
            ),
            "{}",
            entry.port_id
        );
        assert_eq!(provenance, ShapeProvenance::Unreviewed);
    }
}

/// The component rules version these golden shapes belong to. Any change to
/// the classifier, `CONFIG_EXTENSIONS`, the parts or their anchoring changes
/// the expected shape below: bump `SHAPE_VERSION` and raise
/// `COMPONENT_RULES_VERSION` to it in the same change and update both, so
/// older tables and recorded shapes stop being baselines.
const GOLDEN_COMPONENT_RULES_VERSION: u32 = 1;

#[test]
fn the_derivation_matches_its_versioned_golden_shape() {
    assert_eq!(
        COMPONENT_RULES_VERSION, GOLDEN_COMPONENT_RULES_VERSION,
        "update the golden shape together with COMPONENT_RULES_VERSION"
    );
    let mut port = port();
    port.persistent_paths
        .extend(["profiles/user/settings.cfg".to_owned()]);
    port.persistent_file_patterns = vec![crate::PersistentFilePattern {
        prefix: "save".into(),
        suffix: ".srm".into(),
        allow_empty_middle: false,
    }];
    let shape = shape_of(
        &port,
        &[
            "Game.exe",
            "tools/Run.BAT",
            "tools/setup.msi",
            "tools/x.cmd",
            "tools/y.ps1",
            "tools/z.sh",
            "tools/app.AppImage",
            "tools/t.jar",
            "tools/v.vbs",
            "tools/l.lnk",
            "lib/helper.dll",
            "lib/helper.so",
            "config.ini",
            "input.ini",
            "a.cfg",
            "b.TOML",
            "c.json",
            "d.xml",
            "e.yaml",
            "f.txt",
            "g.ini.bak",
            "save1.srm",
            "save.srm",
            "data/save2.srm",
            "data/level.dat",
            "saves/README.txt",
            "saves/slot1/x.sav",
            "mods/packages/base/manifest.toml",
        ],
    );
    let golden = |paths: &[&str]| Some(paths.iter().map(|path| (*path).to_owned()).collect());
    assert_eq!(
        shape,
        PackageShape {
            programs: golden(&[
                "game.exe",
                "tools/app.appimage",
                "tools/l.lnk",
                "tools/run.bat",
                "tools/setup.msi",
                "tools/t.jar",
                "tools/v.vbs",
                "tools/x.cmd",
                "tools/y.ps1",
                "tools/z.sh",
            ]),
            top_directories: golden(&["data", "lib", "mods", "saves", "tools"]),
            persistent_parent_children: golden(&["mods/packages", "saves/slot1"]),
            persistent_overlap: golden(&[
                "config.ini",
                "input.ini",
                "save1.srm",
                "saves/readme.txt",
                "saves/slot1/x.sav",
            ]),
            config_files: golden(&[
                "a.cfg",
                "b.toml",
                "c.json",
                "config.ini",
                "d.xml",
                "input.ini",
                "mods/packages/base/manifest.toml",
            ]),
            missing_persistent_parents: golden(&["profiles/user"]),
        }
    );
}

#[test]
fn declared_paths_outside_the_package_leave_persistent_parts_unknown() {
    let mut port = port();
    // Persistence at the payload root, outside the looked-through wrapper.
    port.launch_from_install_root = true;
    let shape = shape_of(&port, REVIEWED);
    assert!(shape.programs.is_some() && shape.config_files.is_some());
    assert_eq!(shape.persistent_parent_children, None);
    assert_eq!(shape.persistent_overlap, None);
    assert_eq!(shape.missing_persistent_parents, None);
}

#[test]
fn generated_shapes_agree_with_explicit_reviewed_layouts_on_their_shared_parts() {
    let catalog = crate::Catalog::embedded().unwrap();
    for entry in parse_table(GENERATED_TABLE).unwrap() {
        let port = catalog.port(&entry.port_id).unwrap();
        let Some(layout) = port.reviewed_package_layouts.get(&entry.platform) else {
            continue;
        };
        assert_eq!(
            entry.shape.programs.as_ref(),
            Some(&layout.executables),
            "{}",
            entry.port_id
        );
        assert_eq!(
            entry.shape.top_directories.as_ref(),
            Some(&layout.directories),
            "{}",
            entry.port_id
        );
    }
}

#[test]
fn a_table_from_another_derivation_version_is_not_a_baseline() {
    let stale = GENERATED_TABLE.replacen(
        &format!("\"shape_version\": {SHAPE_VERSION}"),
        "\"shape_version\": 999",
        1,
    );
    assert_ne!(stale, GENERATED_TABLE);
    assert!(parse_table(&stale).is_err());
}

#[test]
fn archive_inspection_derives_the_installer_shape() {
    use std::io::Write as _;
    let port = port();
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("game.zip");
    let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    for name in REVIEWED {
        writer
            .start_file(
                format!("game-1.0/{name}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"x").unwrap();
    }
    writer.finish().unwrap();
    let size = fs::metadata(&path).unwrap().len();
    let digest = crate::service::sha256_file(&path).unwrap();
    let inspection = inspect_package_shape_archive(&path, &port, PLATFORM, size, &digest).unwrap();
    assert_eq!(inspection.shape, shape_of(&port, REVIEWED));
    // The fixture route is not in the embedded catalog.
    assert_eq!(inspection.derivation_inputs_sha256, None);
    assert!(matches!(
        inspection.verdict,
        ShapeVerdict::Unknown {
            reason: ShapeUnknownReason::NoBaseline,
            ..
        }
    ));
    assert!(inspect_package_shape_archive(&path, &port, PLATFORM, size, &"0".repeat(64)).is_err());
    assert!(
        inspect_package_shape_archive(&path, &port, Platform::MacosAarch64, size, &digest).is_err()
    );
}

#[cfg(unix)]
#[test]
fn sole_n64_mac_bundle_proves_flat_install_root_persistence_absent() {
    use std::io::{Cursor, Write as _};

    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("zelda64-recomp").unwrap();
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("official.zip");
    let make_archive = |bundle: &str, executable: &str, ship_saves: bool| {
        let mut inner = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        inner
            .start_file(
                format!("{bundle}/Contents/MacOS/{executable}"),
                options.unix_permissions(0o755),
            )
            .unwrap();
        inner.write_all(b"inert executable for layout").unwrap();
        inner
            .start_file(format!("{bundle}/Contents/Resources/config.json"), options)
            .unwrap();
        inner.write_all(b"{}").unwrap();
        if ship_saves {
            inner.start_file("saves/slot/README", options).unwrap();
            inner.write_all(b"upstream data beside the bundle").unwrap();
        }
        let payload = inner.finish().unwrap().into_inner();
        let mut outer = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        outer.start_file("inner.zip", options).unwrap();
        outer.write_all(&payload).unwrap();
        outer.finish().unwrap();
    };
    let inspect = |port: &PortDefinition, platform| {
        let size = fs::metadata(&archive).unwrap().len();
        let digest = crate::service::sha256_file(&archive).unwrap();
        inspect_package_shape_archive(&archive, port, platform, size, &digest)
            .unwrap()
            .shape
    };

    make_archive("Game.app", "Zelda64Recompiled", false);
    for platform in [Platform::MacosX86_64, Platform::MacosAarch64] {
        let observed = inspect(port, platform);
        assert_eq!(
            observed.programs,
            Some(vec!["contents/macos/zelda64recompiled".into()])
        );
        assert_eq!(observed.top_directories, Some(vec!["contents".into()]));
        assert_eq!(
            observed.config_files,
            Some(vec!["contents/resources/config.json".into()])
        );
        assert_eq!(observed.persistent_parent_children, Some(vec![]));
        assert_eq!(observed.persistent_overlap, Some(vec![]));
        assert_eq!(observed.missing_persistent_parents, Some(vec![]));

        let mut older = observed.clone();
        older.persistent_parent_children = None;
        older.persistent_overlap = None;
        older.missing_persistent_parents = None;
        assert!(matches!(
            compare(ShapeBaseline::ReviewedLayout, &older, &observed),
            ShapeVerdict::Unknown {
                reason: ShapeUnknownReason::IncompleteComparison,
                ..
            }
        ));
    }

    let mut nested = port.clone();
    nested
        .persistent_paths
        .push("mods/profile/settings.json".into());
    assert_eq!(
        inspect(&nested, Platform::MacosAarch64).persistent_overlap,
        None
    );
    let mut bundle_owned = port.clone();
    bundle_owned.persistent_paths.push("GAME.APP".into());
    assert_eq!(
        inspect(&bundle_owned, Platform::MacosAarch64).persistent_overlap,
        None
    );

    make_archive("OrdinaryWrapper", "Zelda64Recompiled", false);
    assert_eq!(
        inspect(port, Platform::MacosAarch64).persistent_overlap,
        None
    );
    make_archive("Game.app", "DifferentPlayer", false);
    assert_eq!(
        inspect(port, Platform::MacosAarch64).persistent_overlap,
        None
    );

    make_archive("Game.app", "Zelda64Recompiled", true);
    let observed = inspect(port, Platform::MacosAarch64);
    assert_eq!(
        observed.persistent_parent_children,
        Some(vec!["saves/slot".into()])
    );
    assert_eq!(
        observed.persistent_overlap,
        Some(vec!["saves/slot/readme".into()])
    );
}

#[cfg(unix)]
#[test]
fn reviewed_openmohaa_shape_uses_prepared_title_programs() {
    use std::io::Write as _;

    let catalog = crate::Catalog::embedded().unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let mut elf = [0_u8; 48];
    elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
    elf[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
    let mut universal = [0_u8; 112];
    universal[..8].copy_from_slice(&[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
    for (entry, offset, cpu) in [(8, 48, 7), (28, 80, 12)] {
        universal[entry..entry + 4].copy_from_slice(&[1, 0, 0, cpu]);
        universal[entry + 8..entry + 16].copy_from_slice(&[0, 0, 0, offset as u8, 0, 0, 0, 32]);
        universal[offset..offset + 8].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe, cpu, 0, 0, 1]);
        universal[offset + 12] = 2; // MH_EXECUTE
    }
    let launchers = [
        (
            "medal-of-honor-allied-assault-openmohaa",
            "launch_openmohaa_base",
        ),
        (
            "medal-of-honor-allied-assault-spearhead-openmohaa",
            "launch_openmohaa_spearhead",
        ),
        (
            "medal-of-honor-allied-assault-breakthrough-openmohaa",
            "launch_openmohaa_breakthrough",
        ),
    ];
    for (filename, platforms, program, companions) in [
        (
            "openmohaa-v0.82.1-linux-amd64.zip",
            &[Platform::LinuxX86_64][..],
            &elf[..],
            [
                "cgame.so",
                "game.so",
                "libSDL2-2.0.so.0",
                "libopenal.so.1",
                "libcurl.so.4",
            ],
        ),
        (
            "openmohaa-v0.82.1-macos-multiarch-arm64-x86_64.zip",
            &[Platform::MacosX86_64, Platform::MacosAarch64][..],
            &universal[..],
            [
                "cgame.dylib",
                "game.dylib",
                "libSDL2-2.0.0.dylib",
                "libopenal.1.dylib",
                "libcurl.4.dylib",
            ],
        ),
    ] {
        let path = temporary.path().join(filename);
        for dedicated_mode in [0o644, 0o755] {
            let mut archive = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            // The official ZIPs contain all three launchers and the dedicated
            // server. All ten members have mode 0644. An executable dedicated
            // server is the control that must still be reported as drift.
            for name in launchers
                .iter()
                .map(|(_, launcher)| *launcher)
                .chain(["openmohaa", "omohaaded"])
                .chain(companions)
            {
                let mode = if name == "omohaaded" {
                    dedicated_mode
                } else {
                    0o644
                };
                archive
                    .start_file(
                        name,
                        zip::write::SimpleFileOptions::default().unix_permissions(mode),
                    )
                    .unwrap();
                archive.write_all(program).unwrap();
            }
            archive.finish().unwrap();
            let size = fs::metadata(&path).unwrap().len();
            let sha = crate::service::sha256_file(&path).unwrap();

            for &platform in platforms {
                for (port_id, launcher) in launchers {
                    let port = catalog.port(port_id).unwrap();
                    let inspection =
                        inspect_package_shape_archive(&path, port, platform, size, &sha).unwrap();
                    let observed = inspection.shape.programs.as_deref().unwrap();
                    if dedicated_mode == 0o644 {
                        assert_eq!(observed, [launcher, "openmohaa"]);
                        assert!(matches!(
                            inspection.verdict,
                            ShapeVerdict::Unknown {
                                baseline: Some(ShapeBaseline::ReviewedLayout),
                                reason: ShapeUnknownReason::IncompleteComparison,
                                ..
                            }
                        ));
                    } else {
                        assert_eq!(observed, [launcher, "omohaaded", "openmohaa"]);
                        assert!(matches!(
                            inspection.verdict,
                            ShapeVerdict::Drifted { changes, .. }
                                if changes.len() == 1
                                    && changes[0].component == ShapeComponent::Programs
                                    && changes[0].added == ["omohaaded"]
                        ));
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn reviewed_mac_tar_shape_uses_managed_bundle_rules() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("bio-menace-reflectionhle").unwrap();
    let no_opt_in = catalog.port("tux-racer-sdl2-port").unwrap();
    let other_adapter = catalog.port("perfect-dark").unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let archive = temporary.path().join("fixture.tar.xz");
    let program = "publisher/reflectionhle.app/Contents/MacOS/reflectionhle";

    for (platform, cpu) in [
        (Platform::MacosX86_64, 0x0100_0007_u32),
        (Platform::MacosAarch64, 0x0100_000c_u32),
    ] {
        let mut binary = [0_u8; 32];
        binary[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        binary[4..8].copy_from_slice(&cpu.to_le_bytes());
        binary[12..16].copy_from_slice(&2_u32.to_le_bytes());
        let tar = |link| {
            let mut tar = tar::Builder::new(Vec::new());
            let mut header = tar::Header::new_ustar();
            header.set_mode(0o755);
            header.set_size(binary.len() as u64);
            tar.append_data(&mut header, program, &binary[..]).unwrap();
            if link {
                let mut header = tar::Header::new_ustar();
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_size(0);
                tar.append_link(
                    &mut header,
                    "publisher/alias",
                    "reflectionhle.app/Contents/MacOS/reflectionhle",
                )
                .unwrap();
            }
            crate::archive::encode_xz_fixture(&tar.into_inner().unwrap())
        };
        let write = |bytes: &[u8]| {
            fs::write(&archive, bytes).unwrap();
            (
                bytes.len() as u64,
                crate::service::sha256_file(&archive).unwrap(),
            )
        };
        let (size, digest) = write(&tar(false));
        let inspection =
            inspect_package_shape_archive(&archive, port, platform, size, &digest).unwrap();
        let layout = &port.reviewed_package_layouts[&platform];
        assert_eq!(
            inspection.shape.top_directories.as_ref(),
            Some(&layout.directories)
        );
        assert_eq!(
            inspection.shape.programs.as_ref(),
            Some(&layout.executables)
        );
        assert!(matches!(
            inspection.verdict,
            ShapeVerdict::Unknown {
                reason: ShapeUnknownReason::IncompleteComparison,
                ..
            }
        ));
        for unqualified in [no_opt_in, other_adapter] {
            let error =
                inspect_package_shape_archive(&archive, unqualified, platform, size, &digest)
                    .unwrap_err();
            assert_eq!(error.message, "choose a supported managed archive");
        }
        let error =
            crate::package_layout::inspect_package_archive(&archive, platform, size, &digest)
                .unwrap_err();
        assert_eq!(error.message, "choose a supported managed archive");
        let error = inspect_package_shape_archive(&archive, port, platform, size, SHA).unwrap_err();
        assert_eq!(error.message, "package archive SHA-256 differs");
        let zip_name = temporary.path().join("fixture.zip");
        let error =
            inspect_package_shape_archive(&zip_name, port, platform, size, &digest).unwrap_err();
        assert_eq!(error.message, "the reviewed Mac bundle requires TAR.XZ");

        let (size, digest) = write(&tar(true));
        let error =
            inspect_package_shape_archive(&archive, port, platform, size, &digest).unwrap_err();
        assert!(error.message.contains("TAR links"), "{}", error.message);

        let mut oversized = tar::Header::new_ustar();
        oversized.set_path("pax").unwrap();
        oversized.set_entry_type(tar::EntryType::XHeader);
        oversized.set_size(64 * 1024 + 1);
        oversized.set_cksum();
        let (size, digest) = write(&crate::archive::encode_xz_fixture(oversized.as_bytes()));
        let error =
            inspect_package_shape_archive(&archive, port, platform, size, &digest).unwrap_err();
        assert!(
            error.message.contains("extension metadata exceeds"),
            "{}",
            error.message
        );
    }
}

// Shape version 2: machine-typed player candidates from reviewed bytes (#8569).

mod players {
    use super::*;
    use crate::PlayerCandidate;
    use machine::{ImageKind, MAXIMUM_READ, classify, fixtures};
    use sha2::Digest as _;
    use std::io::{Cursor, Read, Seek, SeekFrom};

    fn classified(bytes: &[u8]) -> Option<(ImageKind, String)> {
        classify(&mut Cursor::new(bytes))
            .unwrap()
            .map(|image| (image.kind, image.machine))
    }

    #[test]
    fn headers_name_pe_elf_and_mach_o_machines_and_kinds() {
        use ImageKind::{Executable, Library, Other};
        for (bytes, kind, machine) in [
            (fixtures::pe(0x8664, 0x0022), Executable, "pe-x86-64"),
            (fixtures::pe(0x014c, 0x0102), Executable, "pe-x86"),
            (fixtures::pe(0xaa64, 0x0022), Executable, "pe-arm64"),
            (fixtures::pe(0x8664, 0x2022), Library, "pe-x86-64"),
            (fixtures::pe(0x01c2, 0x0002), Executable, "pe-0x01c2"),
            (fixtures::pe(0x8664, 0x0000), Other, "pe-x86-64"),
            (fixtures::elf64(2, 62, false), Executable, "elf64-x86-64"),
            (fixtures::elf64(3, 62, true), Executable, "elf64-x86-64"),
            (fixtures::elf64(3, 62, false), Library, "elf64-x86-64"),
            (fixtures::elf64(3, 183, true), Executable, "elf64-arm64"),
            (fixtures::elf64(1, 62, false), Other, "elf64-x86-64"),
            (fixtures::elf32(3), Executable, "elf32-x86"),
            (fixtures::elf32(40), Executable, "elf32-arm"),
            (fixtures::mach_o(0x0100_000c, 2), Executable, "macho-arm64"),
            (fixtures::mach_o(0x0100_0007, 2), Executable, "macho-x86-64"),
            (fixtures::mach_o(0x0100_0007, 6), Library, "macho-x86-64"),
            (fixtures::mach_o(0x0100_0007, 8), Library, "macho-x86-64"),
            (
                fixtures::mach_o(0x0000_0012, 2),
                Executable,
                "macho-0x00000012",
            ),
            (
                fixtures::universal(&[(0x0100_0007, 2), (0x0100_000c, 2)]),
                Executable,
                "macho-universal-arm64+x86-64",
            ),
            (
                fixtures::universal(&[(0x0100_000c, 6)]),
                Library,
                "macho-universal-arm64",
            ),
            (
                fixtures::universal(&[(0x0100_000c, 2), (0x0100_0007, 6)]),
                Other,
                "macho-universal-arm64+x86-64",
            ),
        ] {
            assert_eq!(
                classified(&bytes),
                Some((kind, machine.to_owned())),
                "{machine}"
            );
        }
        // A big-endian ELF names its byte order.
        let mut big = fixtures::elf32(0);
        big[5] = 2;
        big[16..18].copy_from_slice(&2_u16.to_be_bytes());
        big[18..20].copy_from_slice(&8_u16.to_be_bytes());
        assert_eq!(
            classified(&big),
            Some((ImageKind::Executable, "elf32be-0x0008".into()))
        );
        // Scripts, text, empty files and Java classes are not native images.
        let mut java = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34];
        java.resize(64, 0);
        for bytes in [
            b"#!/bin/sh\nexec ./game \"$@\"\n".to_vec(),
            b"@echo off\r\ngame.exe\r\n".to_vec(),
            b"x".to_vec(),
            Vec::new(),
            java,
        ] {
            assert_eq!(classified(&bytes), None);
        }
    }

    /// Counts what the classifier reads.
    struct Counting {
        inner: Cursor<Vec<u8>>,
        bytes: usize,
    }

    impl Read for Counting {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.inner.read(buffer)?;
            self.bytes += read;
            Ok(read)
        }
    }

    impl Seek for Counting {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(position)
        }
    }

    fn bounded(bytes: Vec<u8>) -> Option<(ImageKind, String)> {
        let mut reader = Counting {
            inner: Cursor::new(bytes),
            bytes: 0,
        };
        let image = classify(&mut reader).unwrap();
        assert!(reader.bytes <= MAXIMUM_READ * 10, "{} bytes", reader.bytes);
        image.map(|image| (image.kind, image.machine))
    }

    #[test]
    fn truncated_and_hostile_headers_never_panic_and_reads_stay_bounded() {
        let samples = [
            fixtures::pe(0x8664, 0x0022),
            fixtures::elf64(3, 62, true),
            fixtures::elf32(3),
            fixtures::mach_o(0x0100_000c, 2),
            fixtures::universal(&[(0x0100_0007, 2), (0x0100_000c, 2)]),
        ];
        for sample in &samples {
            for length in 0..=sample.len().min(256) {
                bounded(sample[..length].to_vec());
            }
            // A universal binary cut inside its second slice is not classified.
            for length in (sample.len().saturating_sub(4096)..sample.len()).step_by(7) {
                bounded(sample[..length].to_vec());
            }
        }
        // PE pointing far beyond the file, or at itself.
        for offset in [u32::MAX, 0xffff_fff0, 0, 2] {
            let mut pe = fixtures::pe(0x8664, 0x0022);
            pe[0x3c..0x40].copy_from_slice(&offset.to_le_bytes());
            assert_eq!(bounded(pe), None, "{offset:#x}");
        }
        // ELF program headers out of bounds, oversized or beyond any file.
        for (offset, entry, count) in [
            (u64::MAX, 56_u16, 2_u16),
            (64, 56, u16::MAX),
            (64, 4096, 2),
            (64, 1, 2),
            (1 << 40, 56, 2),
        ] {
            let mut elf = fixtures::elf64(3, 62, true);
            elf[32..40].copy_from_slice(&offset.to_le_bytes());
            elf[54..56].copy_from_slice(&entry.to_le_bytes());
            elf[56..58].copy_from_slice(&count.to_le_bytes());
            assert_eq!(
                bounded(elf),
                Some((ImageKind::Other, "elf64-x86-64".into())),
                "{offset} {entry} {count}"
            );
        }
        // Universal tables with too many slices, slices beyond the file or a
        // slice whose header names another CPU.
        let mut many = fixtures::universal(&[(0x0100_0007, 2)]);
        many[4..8].copy_from_slice(&1_000_000_u32.to_be_bytes());
        assert_eq!(bounded(many), None);
        let mut beyond = fixtures::universal(&[(0x0100_0007, 2)]);
        beyond[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(bounded(beyond), None);
        let mut mismatched = fixtures::universal(&[(0x0100_0007, 2)]);
        mismatched[8..12].copy_from_slice(&0x0100_000c_u32.to_be_bytes());
        assert_eq!(bounded(mismatched), None);
        let mut wide = vec![0_u8; 64];
        wide[..4].copy_from_slice(&[0xca, 0xfe, 0xba, 0xbf]);
        wide[4..8].copy_from_slice(&1_u32.to_be_bytes());
        wide[16..24].copy_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(bounded(wide), None);
        // A large file that merely starts like an image is read only in part.
        let mut large = fixtures::pe(0x8664, 0x0022);
        large.resize(8 * 1024 * 1024, 0x41);
        assert_eq!(
            bounded(large),
            Some((ImageKind::Executable, "pe-x86-64".into()))
        );
    }

    fn players_of(port: &PortDefinition, files: &[(&str, Vec<u8>)]) -> Vec<PlayerCandidate> {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("game-1.0");
        for (file, bytes) in files {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let qualification =
            crate::install::InstallQualification::from_port(port, PLATFORM).unwrap();
        let roots = roots(port, &qualification, PLATFORM, temporary.path()).unwrap();
        let shape = derive(port, PLATFORM, &roots).unwrap();
        derive_player_candidates(&roots, &shape).unwrap()
    }

    fn player(path: &str, machine: &str, bytes: &[u8]) -> PlayerCandidate {
        PlayerCandidate {
            path: path.into(),
            machine: Some(machine.into()),
            sha256: Some(hex::encode(sha2::Sha256::digest(bytes))),
        }
    }

    fn bundled_tools() -> Vec<(&'static str, Vec<u8>)> {
        let program = fixtures::pe(0x8664, 0x0022);
        vec![
            ("overlay_toolchain/tcc.exe", program.clone()),
            ("overlay_toolchain/python/python.exe", program.clone()),
            ("overlay_toolchain/psxrecomp-game.exe", program.clone()),
            ("updater.exe", program.clone()),
            ("crashpad_handler.exe", program.clone()),
            ("setup.exe", program.clone()),
            ("tools/level-editor.exe", program.clone()),
            ("lib/helper.dll", fixtures::pe(0x8664, 0x2022)),
            ("launch.cmd", b"@echo off\r\nGame.exe\r\n".to_vec()),
            ("config.ini", b"x".to_vec()),
        ]
    }

    #[test]
    fn bundled_tools_and_helpers_are_never_players() {
        let port = port();
        let game = fixtures::pe(0x8664, 0x0022);
        let mut files = bundled_tools();
        files.push(("Game.exe", game.clone()));
        assert_eq!(
            players_of(&port, &files),
            [player("game.exe", "pe-x86-64", &game)]
        );

        // The declared target decides, not names: a declared program inside
        // a toolchain or tool location is still no player.
        for hint in [
            "overlay_toolchain/tcc.exe",
            "tools/level-editor.exe",
            "setup.exe",
        ] {
            let mut tool = port.clone();
            tool.executable_hints = [(PLATFORM, vec![hint.into()])].into();
            assert_eq!(players_of(&tool, &files), [], "{hint}");
        }
        // A declared library, script or non-image is no player either.
        for (target, bytes) in [
            ("Game.exe", fixtures::pe(0x8664, 0x2022)),
            ("Game.exe", b"x".to_vec()),
            ("Game.exe", fixtures::elf64(3, 62, false)),
        ] {
            let mut files = bundled_tools();
            files.push((target, bytes));
            assert_eq!(players_of(&port, &files), []);
        }
        // An unresolved declared target leaves no player and no error.
        assert_eq!(players_of(&port, &bundled_tools()), []);
    }

    #[test]
    fn player_digests_are_stable_and_name_the_exact_bytes() {
        let port = port();
        let game = fixtures::pe(0x014c, 0x0102);
        let first = players_of(&port, &[("Game.exe", game.clone())]);
        let again = players_of(
            &port,
            &[("Game.exe", game.clone()), ("readme.txt", b"y".into())],
        );
        assert_eq!(first, again);
        assert_eq!(first, [player("game.exe", "pe-x86", &game)]);
        // Golden digest of the fixture bytes: the digest is SHA-256 of the
        // whole file, independent of path, wrapper or neighbours.
        assert_eq!(
            first[0].sha256.as_deref(),
            Some("84688bad318edad6e9778337577fa4c9b46e7fde35d037aef47a01e65939f83b")
        );
        let mut changed = game.clone();
        changed.push(0);
        assert_ne!(
            players_of(&port, &[("Game.exe", changed)])[0].sha256,
            first[0].sha256
        );
        // Reviewed archives shared by several routes record one digest.
        // The same player inside the same reviewed archive records one
        // machine and digest, whichever route recorded it.
        let mut by_archive = BTreeMap::<(&str, &str), &PlayerCandidate>::new();
        let mut shared = 0;
        for entry in generated_table() {
            for player in entry.player_candidates.iter().flatten() {
                if let Some(previous) =
                    by_archive.insert((entry.sha256.as_str(), player.path.as_str()), player)
                {
                    shared += 1;
                    assert_eq!(previous, player, "{}", entry.port_id);
                }
            }
        }
        assert!(shared > 0, "the committed table shares reviewed archives");
    }

    /// The committed table with every entry rewritten as version 1 wrote it.
    fn version_one_table() -> String {
        let mut table: serde_json::Value = serde_json::from_str(GENERATED_TABLE).unwrap();
        table["shape_version"] = 1.into();
        for entry in table["entries"].as_array_mut().unwrap() {
            let entry = entry.as_object_mut().unwrap();
            entry.remove("shape_version");
            entry.remove("player_candidates");
        }
        serde_json::to_string(&table).unwrap()
    }

    #[test]
    fn version_one_tables_and_records_keep_loading_with_version_one_semantics() {
        let catalog = crate::Catalog::embedded().unwrap();
        let current = parse_table(GENERATED_TABLE).unwrap();
        let legacy = parse_table(&version_one_table()).unwrap();
        assert_eq!(legacy.len(), current.len());
        for (old, new) in legacy.iter().zip(&current) {
            assert_eq!(old.shape_version, Some(1));
            assert_eq!(old.player_candidates, None);
            assert_eq!(new.shape_version, Some(SHAPE_VERSION));
            // Components and their verdicts are the same under both versions.
            assert_eq!(old.shape, new.shape);
            let port = catalog.port(&old.port_id).unwrap();
            let judge = |table: &[GeneratedEntry]| {
                let entry = preferred_generated_entry(table, &port.id, old.platform, &old.sha256);
                evaluate_with_generated_entry(
                    entry,
                    port,
                    old.platform,
                    &old.sha256,
                    &old.shape,
                    None,
                    None,
                )
            };
            assert_eq!(judge(&legacy), judge(&current), "{}", old.port_id);
            // A version 1 entry keeps the version 1 path-only player rule.
            let claim = crate::route_facts::archive_claim(
                reviewed_archive_in(&legacy, port, &old.sha256).unwrap(),
                &old.sha256,
            );
            assert_eq!(
                claim.source,
                crate::route_facts::FactSource::ExactReleaseStructured {
                    shape_version: 1,
                    archive_sha256: old.sha256.clone(),
                }
            );
            assert_eq!(
                claim.players,
                crate::route_facts::player_candidates(old.shape.programs.as_deref().unwrap())
            );
        }
        // A version 1 entry beside version 2 entries keeps its version.
        let mut mixed: serde_json::Value = serde_json::from_str(GENERATED_TABLE).unwrap();
        let first = mixed["entries"][0].as_object_mut().unwrap();
        first.insert("shape_version".into(), 1.into());
        first.remove("player_candidates");
        let mixed = parse_table(&mixed.to_string()).unwrap();
        assert_eq!(mixed[0].shape_version, Some(1));
        assert!(
            mixed[1..]
                .iter()
                .all(|entry| entry.shape_version == Some(2))
        );
        // Players without their version, or a version 2 entry without players, are refused.
        for (version, players) in [(1, true), (2, false)] {
            let mut table: serde_json::Value = serde_json::from_str(GENERATED_TABLE).unwrap();
            let first = table["entries"][0].as_object_mut().unwrap();
            first.insert("shape_version".into(), version.into());
            if !players {
                first.remove("player_candidates");
            }
            assert!(parse_table(&table.to_string()).is_err(), "{version}");
        }
        // Installation and observation records of either readable version load.
        let record = serde_json::json!({
            "shape_version": 1,
            "shape": { "programs": ["game.exe"] },
            "provenance": "unreviewed",
            "verdict": { "status": "unknown", "reason": "no_baseline" }
        });
        for (version, readable) in [(0, false), (1, true), (2, true), (3, false)] {
            let mut record = record.clone();
            record["shape_version"] = version.into();
            assert_eq!(stored_record(&record).is_some(), readable, "{version}");
        }
        assert_eq!(COMPONENT_RULES_VERSION, 1);
    }

    #[test]
    fn version_two_players_carry_machine_and_digest_without_changing_any_role() {
        let catalog = crate::Catalog::embedded().unwrap();
        for entry in generated_table() {
            let port = catalog.port(&entry.port_id).unwrap();
            let claim = crate::route_facts::structured_claim(port, &entry.sha256).unwrap();
            assert_eq!(
                claim.source,
                crate::route_facts::FactSource::ExactReleaseStructured {
                    shape_version: 2,
                    archive_sha256: entry.sha256.clone(),
                }
            );
            assert!(!claim.players.is_empty(), "{}", entry.port_id);
            let path_only =
                crate::route_facts::player_candidates(entry.shape.programs.as_deref().unwrap());
            for player in &claim.players {
                assert!(player.machine.is_some() && player.sha256.is_some());
                // Version 2 players are a subset of what version 1 admitted.
                assert!(
                    path_only
                        .iter()
                        .any(|candidate| candidate.path == player.path),
                    "{} {}",
                    entry.port_id,
                    player.path
                );
            }
            // The role, and so release selection, is what version 1 claimed.
            let legacy = parse_table(&version_one_table()).unwrap();
            let old = crate::route_facts::archive_claim(
                reviewed_archive_in(&legacy, port, &entry.sha256).unwrap(),
                &entry.sha256,
            );
            assert_eq!(
                (claim.role, claim.os, claim.arch),
                (old.role, old.os, old.arch)
            );
        }
    }
}
