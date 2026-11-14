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
        shape: shape_of(port, files),
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
            derivation_inputs_sha256(raw_port(&entry.port_id), platform.as_str().unwrap()),
            "{} catalog facts the shape derivation reads changed; run node scripts/package-shape-baselines.mts --prune",
            entry.port_id
        );
        assert!(seen.insert((&entry.port_id, entry.platform, &entry.sha256)));
    }
}

/// Mirrors `derivationInputs` in `scripts/package-shape-baselines.mts`: the
/// catalog facts `roots`, `derive` and `anchors` read for one route platform.
fn derivation_inputs_sha256(port: &serde_json::Value, platform: &str) -> String {
    let runtime_subdirectory = match &port["runtime_subdirectory_by_platform"][platform] {
        serde_json::Value::Null => port["runtime_subdirectory"].clone(),
        value => value.clone(),
    };
    let mut inputs = serde_json::json!({
        "adapter": port["adapter"],
        "executable_hints": port["executable_hints"][platform],
        "external_profile_policy": port["external_profile_policy"],
        "grant_declared_executable": port["release"]["grant_declared_executable"],
        "ignore_verified_macos_libraries":
            port["reviewed_package_layouts"][platform]["ignore_verified_macos_libraries"],
        "launch_from_install_root": port["launch_from_install_root"],
        "managed_shared_preferences": port["managed_shared_preferences"],
        "n64_runtime_at_executable_parent": port["n64_runtime_at_executable_parent"],
        "persistent_file_patterns": port["persistent_file_patterns"],
        "persistent_paths": port["persistent_paths"],
        "runtime_subdirectory": runtime_subdirectory,
        "tar_xz_platforms": port["release"]["tar_xz_platforms"],
    });
    inputs.sort_all_objects();
    hex::encode(<sha2::Sha256 as sha2::Digest>::digest(
        serde_json::to_string(&inputs).unwrap().as_bytes(),
    ))
}

/// The derivation version these golden shapes belong to. Any change to the
/// classifier, `CONFIG_EXTENSIONS`, the parts or their anchoring changes the
/// expected shape below: bump `SHAPE_VERSION` in the same change and update
/// both, so older tables and recorded shapes stop being baselines.
const GOLDEN_SHAPE_VERSION: u32 = 1;

#[test]
fn the_derivation_matches_its_versioned_golden_shape() {
    assert_eq!(
        SHAPE_VERSION, GOLDEN_SHAPE_VERSION,
        "update the golden shape together with SHAPE_VERSION"
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
