use std::{fs, path::Path, sync::Arc};

use super::*;
use crate::Library;

#[derive(Default)]
struct FixtureHost {
    steam: Vec<PathBuf>,
    gog: Vec<RegisteredStoreInstall>,
    gog_unread: u32,
    epic: Vec<PathBuf>,
}

impl StoreInstallHost for FixtureHost {
    fn steam_client_roots(&self) -> Vec<PathBuf> {
        self.steam.clone()
    }

    fn gog_registered_installs(&self) -> RegisteredStoreInstalls {
        RegisteredStoreInstalls {
            installs: self.gog.clone(),
            unread_records: self.gog_unread,
        }
    }

    fn epic_manifest_dirs(&self) -> Vec<PathBuf> {
        self.epic.clone()
    }
}

fn detect(host: &dyn StoreInstallHost) -> Detection<'static> {
    detect_for_profile(host, None)
}

fn vdf_escape(path: &Path) -> String {
    path.display().to_string().replace('\\', "\\\\")
}

fn steam_app(library: &Path, id: u32, name: &str, installdir: &str, create: bool) {
    let steamapps = library.join("steamapps");
    fs::create_dir_all(steamapps.join("common")).unwrap();
    fs::write(
        steamapps.join(format!("appmanifest_{id}.acf")),
        format!(
            "\"AppState\"\n{{\n\t\"appid\"\t\t\"{id}\"\n\t\"name\"\t\t\"{name}\"\n\t\"installdir\"\t\t\"{installdir}\"\n\t\"UserConfig\"\n\t{{\n\t\t\"name\"\t\t\"nested\"\n\t}}\n}}\n"
        ),
    )
    .unwrap();
    if create {
        fs::create_dir_all(steamapps.join("common").join(installdir)).unwrap();
    }
}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap()
}

#[test]
fn steam_libraries_gog_and_epic_installs_are_listed_read_only() {
    let temporary = tempfile::tempdir().unwrap();
    let client = temporary.path().join("Steam");
    let second = temporary.path().join("SteamLibrary");
    steam_app(&client, 10, "Dark Forces", "Dark Forces", true);
    steam_app(&second, 20, "Quake", "Quake", true);
    steam_app(&second, 30, "Uninstalled", "Gone", false);
    steam_app(&second, 40, "Escape", "..", true);
    steam_app(&second, 50, "Nested", "a/b", true);
    fs::write(
        client.join("steamapps").join("libraryfolders.vdf"),
        format!(
            "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t\t\"apps\"\n\t\t{{\n\t\t\t\"10\"\t\t\"1\"\n\t\t}}\n\t}}\n\t\"1\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n\t\"2\"\n\t{{\n\t\t\"path\"\t\t\"relative\"\n\t}}\n}}\n",
            vdf_escape(&client),
            vdf_escape(&second),
        ),
    )
    .unwrap();
    // Malformed and oversized manifests are skipped, not fatal.
    fs::write(
        second.join("steamapps").join("appmanifest_60.acf"),
        "\"AppState\" { \"name\" ",
    )
    .unwrap();
    fs::write(
        second.join("steamapps").join("appmanifest_70.acf"),
        vec![b' '; MAX_METADATA_BYTES as usize + 1],
    )
    .unwrap();

    let gog_folder = temporary.path().join("GOG Games").join("Fallout 2");
    fs::create_dir_all(&gog_folder).unwrap();
    let epic_folder = temporary.path().join("Epic Games").join("Jedi Knight");
    fs::create_dir_all(&epic_folder).unwrap();
    let manifests = temporary.path().join("Manifests");
    fs::create_dir_all(&manifests).unwrap();
    fs::write(
        manifests.join("one.item"),
        serde_json::json!({
            "DisplayName": "Jedi Knight",
            "InstallLocation": epic_folder,
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        manifests.join("partial.item"),
        serde_json::json!({
            "DisplayName": "Partial",
            "InstallLocation": epic_folder,
            "bIsIncompleteInstall": true,
        })
        .to_string(),
    )
    .unwrap();
    fs::write(manifests.join("broken.item"), "{").unwrap();
    fs::write(manifests.join("ignored.txt"), "{}").unwrap();

    let host = FixtureHost {
        // The same client twice is one library.
        steam: vec![
            client.clone(),
            client.clone(),
            temporary.path().join("none"),
        ],
        gog: vec![
            RegisteredStoreInstall {
                product_id: None,
                title: "Fallout 2".into(),
                path: gog_folder.clone(),
            },
            // The same folder from another store entry is listed once.
            RegisteredStoreInstall {
                product_id: None,
                title: "Fallout 2 duplicate".into(),
                path: gog_folder.join("."),
            },
            RegisteredStoreInstall {
                product_id: None,
                title: "Missing".into(),
                path: temporary.path().join("missing"),
            },
        ],
        gog_unread: 0,
        epic: vec![manifests],
    };
    let detection = detect(&host);
    let report = &detection.report;
    let listed = report
        .installs
        .iter()
        .map(|install| (install.store, install.title.as_str(), install.path.clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        listed,
        vec![
            (
                GameStore::Steam,
                "Dark Forces",
                canonical(&client.join("steamapps/common/Dark Forces"))
            ),
            (GameStore::Gog, "Fallout 2", canonical(&gog_folder)),
            (GameStore::Epic, "Jedi Knight", canonical(&epic_folder)),
            (
                GameStore::Steam,
                "Quake",
                canonical(&second.join("steamapps/common/Quake"))
            ),
        ]
    );
    // Relative listed library, Gone, `..`, `a/b`, malformed, oversized,
    // missing GOG, partial and broken Epic.
    assert_eq!(report.skipped_entries, 9);
    assert_eq!(
        report.checked_stores,
        vec![GameStore::Steam, GameStore::Gog, GameStore::Epic]
    );
    assert!(!report.limited);
    // The listed library is protected; a path no record covers is not yet
    // known to be safe, because some of these records could not be read.
    assert!(matches!(
        store_folder_ownership(&host, &canonical(&second.join("steamapps")).join("x")),
        StoreFolderOwnership::StoreOwned {
            store: GameStore::Steam,
            ..
        }
    ));
    let StoreFolderOwnership::Undetermined { unread } =
        store_folder_ownership(&host, &canonical(temporary.path()).join("elsewhere"))
    else {
        panic!("unreadable store records must not establish safety");
    };
    let stores = unread
        .iter()
        .map(|(store, _)| *store)
        .collect::<BTreeSet<_>>();
    assert_eq!(stores, BTreeSet::from([GameStore::Steam, GameStore::Epic]));
}

#[test]
fn vdf_reader_accepts_escapes_comments_and_the_older_library_layout() {
    assert_eq!(
        steam_library_paths(
            "// comment\n\"LibraryFolders\"\n{\n\t\"TimeNextStatsReport\"\t\"1\"\n\t\"1\"\t\t\"D:\\\\Steam \\\"Library\\\"\"\n}\n"
        ),
        Some(vec![PathBuf::from("D:\\Steam \"Library\"")])
    );
    assert_eq!(steam_library_paths("\"libraryfolders\" { \"0\" {"), None);
    assert_eq!(steam_library_paths("unquoted"), None);
    assert_eq!(
        steam_app_manifest("\"AppState\" { \"installdir\" \"Game\" }"),
        Some((String::new(), "Game".into(), None))
    );
    assert_eq!(
        steam_app_manifest("\"AppState\" { \"name\" \"No folder\" }"),
        None
    );
    assert!(single_normal_component("Half-Life"));
    for unsafe_name in ["", ".", "..", "a/b", "a\\b", "C:"] {
        assert!(!single_normal_component(unsafe_name), "{unsafe_name}");
    }
    assert_eq!(clean_title("  A\u{7}B  "), Some("AB".into()));
    assert_eq!(clean_title("\n"), None);
}

#[test]
fn the_install_limit_marks_the_list_incomplete() {
    let temporary = tempfile::tempdir().unwrap();
    let mut gog = Vec::new();
    for index in 0..=MAX_INSTALLS {
        let folder = temporary.path().join(index.to_string());
        fs::create_dir(&folder).unwrap();
        gog.push(RegisteredStoreInstall {
            product_id: None,
            title: index.to_string(),
            path: folder,
        });
    }
    let report = detect_for_profile(
        &FixtureHost {
            gog,
            ..FixtureHost::default()
        },
        None,
    )
    .report;
    assert_eq!(report.installs.len(), MAX_INSTALLS);
    assert!(report.limited);
}

#[test]
fn service_reports_saved_folders_and_refuses_moves_out_of_store_folders() {
    let temporary = tempfile::tempdir().unwrap();
    let client = temporary.path().join("Steam");
    steam_app(&client, 10, "Dark Forces", "Dark Forces", true);
    let game = canonical(&client.join("steamapps/common/Dark Forces"));
    let library = Library::open(temporary.path().join("library")).unwrap();
    let saved = library.add_game_file_root(&game).unwrap();
    let service = PortcoveService::new(library)
        .unwrap()
        .with_store_install_host(Arc::new(FixtureHost {
            steam: vec![client.clone()],
            ..FixtureHost::default()
        }));

    let report = service.store_game_installs().unwrap();
    assert_eq!(report.installs.len(), 1);
    assert_eq!(
        report.installs[0].saved_root_id.as_deref(),
        Some(saved.id.as_str())
    );

    let error = service
        .refuse_store_install_move("profile", &game.join("DARK.GOB"))
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert!(error.message.contains("Steam"));
    // A manifest-less file in the library's steamapps folder is protected too.
    service
        .refuse_store_install_move("profile", &canonical(&client.join("steamapps")).join("x"))
        .unwrap_err();
    service
        .refuse_store_install_move("profile", &canonical(temporary.path()).join("elsewhere"))
        .unwrap();
}

fn service_with(temporary: &Path, host: FixtureHost) -> PortcoveService {
    PortcoveService::new(Library::open(temporary.join("library")).unwrap())
        .unwrap()
        .with_store_install_host(Arc::new(host))
}

#[test]
fn classic_steam_original_hint_requires_matching_manifest_identity_and_a_folder() {
    let temporary = tempfile::tempdir().unwrap();
    let steam = temporary.path().join("Steam");
    steam_app(&steam, 32400, "Dark Forces", "Classic", true);
    steam_app(&steam, 2292260, "Dark Forces", "Remaster", true);
    steam_app(&steam, 1234, "Dark Forces", "Ambiguous", true);
    let manifest = steam.join("steamapps/appmanifest_1234.acf");
    let wrong_id = fs::read_to_string(&manifest)
        .unwrap()
        .replace("1234", "32400");
    fs::write(manifest, wrong_id).unwrap();
    for folder in ["Classic", "Remaster", "Ambiguous"] {
        fs::create_dir(steam.join("steamapps/common").join(folder).join("Game")).unwrap();
    }
    let service = service_with(
        temporary.path(),
        FixtureHost {
            steam: vec![steam.clone()],
            ..FixtureHost::default()
        },
    );
    let report = service.store_game_installs().unwrap();
    let installs = report.installs;
    assert_eq!(installs.len(), 3);
    let hints = installs
        .iter()
        .filter_map(|install| install.original_folder.as_ref())
        .collect::<Vec<_>>();
    assert_eq!(
        hints,
        vec![&StoreOriginalFolder {
            profile_id: "dark-forces-pc-complete-installed-data".into(),
            path: canonical(&steam.join("steamapps/common/Classic/Game")),
        }]
    );
    assert!(
        installs
            .iter()
            .any(|install| install.path.ends_with("Ambiguous") && install.product_id.is_none())
    );
    assert!(
        installs
            .iter()
            .any(|install| install.path.ends_with("Remaster")
                && install.product_id.as_deref() == Some("2292260"))
    );
    fs::remove_dir(steam.join("steamapps/common/Classic/Game")).unwrap();
    let report = service.store_game_installs().unwrap();
    assert!(
        report
            .installs
            .iter()
            .all(|install| install.original_folder.is_none())
    );
}

#[test]
fn classic_doom_steam_hints_require_the_classic_product_and_layout() {
    let temporary = tempfile::tempdir().unwrap();
    let steam = temporary.path().join("Steam");
    steam_app(&steam, 9050, "DOOM 3", "Classic", true);
    steam_app(&steam, 9070, "Resurrection of Evil", "Expansion", true);
    steam_app(&steam, 208200, "DOOM 3", "BFG", true);
    let common = steam.join("steamapps/common");
    for folder in [
        "Classic/base",
        "Expansion/base",
        "Expansion/d3xp",
        "BFG/base",
        "BFG/d3xp",
    ] {
        fs::create_dir(common.join(folder)).unwrap();
    }
    let service = service_with(
        temporary.path(),
        FixtureHost {
            steam: vec![steam.clone()],
            ..FixtureHost::default()
        },
    );
    let hints = || {
        service
            .store_game_installs()
            .unwrap()
            .installs
            .into_iter()
            .filter_map(|row| row.original_folder)
            .map(|hint| (hint.profile_id, hint.path))
            .collect::<BTreeMap<_, _>>()
    };
    assert_eq!(
        hints(),
        BTreeMap::from([
            (
                "doom-3-classic-pc-131-pk4".into(),
                canonical(&common.join("Classic"))
            ),
            (
                "doom-3-roe-classic-pc-131-pk4".into(),
                canonical(&common.join("Expansion"))
            ),
        ])
    );
    fs::remove_dir(common.join("Expansion/base")).unwrap();
    assert!(!hints().contains_key("doom-3-roe-classic-pc-131-pk4"));
    steam_app(&steam, 9070, "Resurrection of Evil", "Classic", false);
    fs::create_dir(common.join("Classic/d3xp")).unwrap();
    assert!(
        hints().is_empty(),
        "conflicting product identities must not offer a hint"
    );
}

#[test]
fn classic_gog_original_hint_uses_the_registered_root_and_preserves_move_protection() {
    let temporary = tempfile::tempdir().unwrap();
    let mut gog = Vec::new();
    for (folder, product_id) in [
        ("Classic", Some("1421404433")),
        ("Remaster", Some("1853348102")),
        ("Unknown", None),
    ] {
        let path = temporary.path().join(folder);
        fs::create_dir(&path).unwrap();
        gog.push(RegisteredStoreInstall {
            title: "Dark Forces".into(),
            path,
            product_id: product_id.map(str::to_owned),
        });
    }
    let service = service_with(
        temporary.path(),
        FixtureHost {
            gog,
            ..FixtureHost::default()
        },
    );
    let report = service.store_game_installs().unwrap();
    assert_eq!(report.installs.len(), 3);
    let root = canonical(&temporary.path().join("Classic"));
    assert_eq!(
        report
            .installs
            .into_iter()
            .filter_map(|install| install.original_folder)
            .collect::<Vec<_>>(),
        [StoreOriginalFolder {
            profile_id: "dark-forces-pc-complete-installed-data".into(),
            path: root.clone(),
        }]
    );
    let refusal = service
        .refuse_store_install_move("dark-forces-pc-complete-installed-data", &root)
        .unwrap_err();
    assert_eq!(refusal.code, crate::ErrorCode::Conflict);
    assert!(refusal.message.contains("GOG installed"));
}

#[test]
fn conflicting_steam_metadata_keeps_the_folder_without_a_product_hint() {
    for text in [
        r#""AppState" { "appid" "32400" "installdir" "Classic" "installdir" "Other" }"#,
        r#""AppState" { "appid" "32400" } "Other" { "installdir" "Classic" }"#,
    ] {
        let (_, folder, id) = steam_app_manifest(text).unwrap();
        assert_eq!(folder, "Classic");
        assert!(id.is_none());
    }
    let temporary = tempfile::tempdir().unwrap();
    let steam = temporary.path().join("Steam");
    steam_app(&steam, 32400, "Dark Forces", "Classic", true);
    steam_app(&steam, 42900, "Other game", "Classic", true);
    fs::create_dir(steam.join("steamapps/common/Classic/Game")).unwrap();
    let detection = detect(&FixtureHost {
        steam: vec![steam],
        ..FixtureHost::default()
    });
    assert_eq!(detection.report.installs.len(), 1);
    assert!(detection.report.installs[0].product_id.is_none());
    assert!(detection.report.installs[0].original_folder.is_none());
}

#[cfg(unix)]
#[test]
fn linked_steam_install_is_protected_without_an_original_folder_hint() {
    let temporary = tempfile::tempdir().unwrap();
    let steam = temporary.path().join("Steam");
    let elsewhere = temporary.path().join("elsewhere");
    fs::create_dir_all(elsewhere.join("Game")).unwrap();
    steam_app(&steam, 32400, "Dark Forces", "Classic", false);
    std::os::unix::fs::symlink(&elsewhere, steam.join("steamapps/common/Classic")).unwrap();
    let host = FixtureHost {
        steam: vec![steam],
        ..FixtureHost::default()
    };
    let detection = detect(&host);
    let row = &detection.report.installs[0];
    assert_eq!(row.path, canonical(&elsewhere));
    assert_eq!(row.product_id.as_deref(), Some("32400"));
    assert!(row.original_folder.is_none());
    // The linked game folder is outside `steamapps`, so only its manifest
    // protects it.
    assert_eq!(
        store_folder_ownership(&host, &row.path.join("Game")),
        StoreFolderOwnership::StoreOwned {
            store: GameStore::Steam,
            folder: row.path.clone(),
            evidence: OwnershipEvidence::StoreRecord,
        }
    );
}

#[test]
fn a_new_store_product_can_get_an_original_hint_from_data_alone() {
    let temporary = tempfile::tempdir().unwrap();
    let steam = temporary.path().join("Steam");
    steam_app(
        &steam,
        440001,
        "Existing title from the manifest",
        "ExtraGame",
        true,
    );
    let game = steam.join("steamapps/common/ExtraGame");
    let source = game.join("data/demo");
    fs::create_dir_all(source.join("levels")).unwrap();
    let host = FixtureHost {
        steam: vec![steam],
        ..FixtureHost::default()
    };
    let profile = "dark-forces-pc-complete-installed-data";
    let row = serde_json::json!({
        "store": "steam",
        "product_id": "440001",
        "profile_id": profile,
        "relative_directory": "data/demo",
        "required_directories": ["levels"],
    });
    let layouts = parse_store_original_layouts(&serde_json::json!([row]).to_string()).unwrap();
    assert!(detect(&host).report.installs[0].original_folder.is_none());
    let with_layout = detect_with_layouts(&host, Some(profile), &layouts);
    assert_eq!(
        with_layout.report.installs[0]
            .original_folder
            .as_ref()
            .unwrap()
            .path,
        canonical(&source)
    );
    assert!(
        detect_with_layouts(&host, Some("different-edition"), &layouts)
            .report
            .installs[0]
            .original_folder
            .is_none()
    );
    fs::remove_dir(source.join("levels")).unwrap();
    assert!(
        detect_with_layouts(&host, Some(profile), &layouts)
            .report
            .installs[0]
            .original_folder
            .is_none()
    );

    let mut invalid = row.clone();
    invalid["relative_directory"] = serde_json::json!("../outside");
    assert!(parse_store_original_layouts(&serde_json::json!([invalid]).to_string()).is_err());
    assert!(parse_store_original_layouts(&serde_json::json!([row, row]).to_string()).is_err());

    let catalog = crate::Catalog::embedded().unwrap();
    assert!(!embedded_store_original_layouts().is_empty());
    for layout in embedded_store_original_layouts() {
        catalog.source_profile(&layout.profile_id).unwrap();
    }
}

#[test]
fn bstone_store_products_offer_only_the_reviewed_original_folders() {
    let temporary = tempfile::tempdir().unwrap();
    let steam = temporary.path().join("Steam");
    let cases = [
        (
            358190,
            "Gold",
            "Blake Stone - Aliens of Gold",
            "bstone-aliens-of-gold-originals",
        ),
        (
            358310,
            "Strike",
            "Blake Stone - Planet Strike",
            "bstone-planet-strike-originals",
        ),
    ];
    for (id, folder, child, _) in cases {
        steam_app(&steam, id, "Untrusted store title", folder, true);
        fs::create_dir(steam.join("steamapps/common").join(folder).join(child)).unwrap();
    }
    steam_app(&steam, 12345, "Blake Stone", "Unreviewed", true);
    let mut gog = Vec::new();
    for (id, folder) in [("1207658728", "GOG Gold"), ("1207658729", "GOG Strike")] {
        let path = temporary.path().join(folder);
        fs::create_dir(&path).unwrap();
        gog.push(RegisteredStoreInstall {
            title: "Untrusted store title".into(),
            path,
            product_id: Some(id.into()),
        });
    }
    let service = service_with(
        temporary.path(),
        FixtureHost {
            steam: vec![steam.clone()],
            gog,
            ..FixtureHost::default()
        },
    );
    let report = service.store_game_installs().unwrap();
    assert_eq!(report.installs.len(), 5);
    assert_eq!(
        report
            .installs
            .iter()
            .filter(|row| row.original_folder.is_some())
            .count(),
        4
    );
    for (id, folder, child, profile) in cases {
        let row = report
            .installs
            .iter()
            .find(|row| row.product_id.as_deref() == Some(id.to_string().as_str()))
            .unwrap();
        let hint = row.original_folder.as_ref().unwrap();
        assert_eq!(hint.profile_id, profile);
        assert_eq!(
            hint.path,
            canonical(&steam.join("steamapps/common").join(folder).join(child))
        );
        // Recognized store metadata is only a path hint. Empty originals must
        // still fail the existing complete file-set admission.
        assert!(
            service
                .inspect_source(profile, &hint.path)
                .and_then(|inspection| inspection.require_admitted_record())
                .is_err()
        );
        assert!(service.library().source(profile).unwrap().is_none());
    }
    for (id, folder, profile) in [
        ("1207658728", "GOG Gold", "bstone-aliens-of-gold-originals"),
        ("1207658729", "GOG Strike", "bstone-planet-strike-originals"),
    ] {
        let hint = report
            .installs
            .iter()
            .find(|row| row.product_id.as_deref() == Some(id))
            .unwrap()
            .original_folder
            .as_ref()
            .unwrap();
        assert_eq!(hint.profile_id, profile);
        assert_eq!(hint.path, canonical(&temporary.path().join(folder)));
        assert!(
            service
                .refuse_store_install_move(profile, &hint.path)
                .is_err()
        );
    }
}

#[test]
fn bstone_anthology_requires_profile_context_and_serializes_the_matching_hint() {
    let temporary = tempfile::tempdir().unwrap();
    let steam = temporary.path().join("Steam");
    steam_app(
        &steam,
        238050,
        "The Apogee Throwback Pack",
        "Throwback",
        true,
    );
    let root = steam.join("steamapps/common/Throwback");
    for child in ["Blake Stone", "Planet Strike"] {
        fs::create_dir(root.join(child)).unwrap();
    }
    let service = service_with(
        temporary.path(),
        FixtureHost {
            steam: vec![steam],
            ..FixtureHost::default()
        },
    );
    assert!(
        service.store_game_installs().unwrap().installs[0]
            .original_folder
            .is_none()
    );
    for (profile, child) in [
        ("bstone-aliens-of-gold-originals", "Blake Stone"),
        ("bstone-planet-strike-originals", "Planet Strike"),
    ] {
        let report = service.store_game_installs_for_profile(profile).unwrap();
        let expected = canonical(&root.join(child));
        assert_eq!(
            report.installs[0].original_folder.as_ref().unwrap(),
            &StoreOriginalFolder {
                profile_id: profile.into(),
                path: expected.clone()
            }
        );
        let wire = serde_json::to_value(&report).unwrap();
        assert_eq!(
            wire["installs"][0]["original_folder"]["profile_id"],
            profile
        );
        assert_eq!(
            wire["installs"][0]["original_folder"]["path"],
            expected.to_str().unwrap()
        );
        assert!(
            service
                .refuse_store_install_move(profile, &expected)
                .is_err()
        );
    }
    assert!(
        service
            .store_game_installs_for_profile("dark-forces-pc-complete-installed-data")
            .unwrap()
            .installs[0]
            .original_folder
            .is_none()
    );
    fs::remove_dir(root.join("Blake Stone")).unwrap();
    assert!(
        service
            .store_game_installs_for_profile("bstone-aliens-of-gold-originals")
            .unwrap()
            .installs[0]
            .original_folder
            .is_none()
    );
    assert!(
        service
            .store_game_installs_for_profile("bstone-planet-strike-originals")
            .unwrap()
            .installs[0]
            .original_folder
            .is_some()
    );
}

#[test]
fn unknown_store_profile_refuses_before_host_metadata_is_read() {
    struct UnreadHost;
    impl StoreInstallHost for UnreadHost {
        fn steam_client_roots(&self) -> Vec<PathBuf> {
            panic!("unknown profile must not read Steam");
        }
        fn gog_registered_installs(&self) -> RegisteredStoreInstalls {
            panic!("unknown profile must not read GOG");
        }
        fn epic_manifest_dirs(&self) -> Vec<PathBuf> {
            panic!("unknown profile must not read Epic");
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    let service = PortcoveService::new(Library::open(temporary.path().join("library")).unwrap())
        .unwrap()
        .with_store_install_host(Arc::new(UnreadHost));
    assert_eq!(
        service
            .store_game_installs_for_profile("unknown-profile")
            .unwrap_err()
            .code,
        crate::ErrorCode::NotFound
    );
}

#[test]
fn contextual_bstone_hint_does_not_restore_conflicting_product_identity() {
    let temporary = tempfile::tempdir().unwrap();
    let steam = temporary.path().join("Steam");
    for id in [238050, 358190] {
        steam_app(&steam, id, "Blake Stone", "Shared", true);
    }
    for child in ["Blake Stone", "Blake Stone - Aliens of Gold"] {
        fs::create_dir(steam.join("steamapps/common/Shared").join(child)).unwrap();
    }
    let service = service_with(
        temporary.path(),
        FixtureHost {
            steam: vec![steam],
            ..FixtureHost::default()
        },
    );
    let report = service
        .store_game_installs_for_profile("bstone-aliens-of-gold-originals")
        .unwrap();
    assert_eq!(report.installs.len(), 1);
    assert!(report.installs[0].product_id.is_none());
    assert!(report.installs[0].original_folder.is_none());
    assert!(
        service
            .refuse_store_install_move("bstone-aliens-of-gold-originals", &report.installs[0].path)
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn contextual_bstone_hint_refuses_linked_child_and_linked_install_coordinates() {
    for linked_install in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let steam = temporary.path().join("Steam");
        let elsewhere = temporary.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        steam_app(&steam, 238050, "Throwback", "Throwback", !linked_install);
        let installed = steam.join("steamapps/common/Throwback");
        if linked_install {
            for child in ["Blake Stone", "Planet Strike"] {
                fs::create_dir(elsewhere.join(child)).unwrap();
            }
            std::os::unix::fs::symlink(&elsewhere, &installed).unwrap();
        } else {
            std::os::unix::fs::symlink(&elsewhere, installed.join("Blake Stone")).unwrap();
        }
        let service = service_with(
            temporary.path(),
            FixtureHost {
                steam: vec![steam],
                ..FixtureHost::default()
            },
        );
        let report = service
            .store_game_installs_for_profile("bstone-aliens-of-gold-originals")
            .unwrap();
        assert!(report.installs[0].original_folder.is_none());
        assert!(
            service
                .refuse_store_install_move(
                    "bstone-aliens-of-gold-originals",
                    &report.installs[0].path
                )
                .is_err()
        );
    }
}

#[test]
fn unit_test_services_read_no_store_by_default() {
    let temporary = tempfile::tempdir().unwrap();
    let service =
        PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
    let report = service.store_game_installs().unwrap();
    assert!(report.checked_stores.is_empty());
    assert!(report.installs.is_empty());
}

#[test]
fn gog_and_epic_folders_and_folders_containing_them_cannot_be_moved() {
    let temporary = tempfile::tempdir().unwrap();
    let games = temporary.path().join("GOG Games");
    let gog = games.join("Fallout 2");
    let epic = temporary.path().join("Epic Games").join("Jedi Knight");
    fs::create_dir_all(&gog).unwrap();
    fs::create_dir_all(&epic).unwrap();
    let manifests = temporary.path().join("Manifests");
    fs::create_dir_all(&manifests).unwrap();
    fs::write(
        manifests.join("one.item"),
        serde_json::json!({"DisplayName": "Jedi Knight", "InstallLocation": epic}).to_string(),
    )
    .unwrap();
    let service = service_with(
        temporary.path(),
        FixtureHost {
            gog: vec![RegisteredStoreInstall {
                product_id: None,
                title: "Fallout 2".into(),
                path: gog.clone(),
            }],
            epic: vec![manifests],
            ..FixtureHost::default()
        },
    );
    let refused = |path: &Path| {
        service
            .refuse_store_install_move("profile", path)
            .unwrap_err()
            .details
            .get("store")
            .cloned()
    };
    assert_eq!(
        refused(&canonical(&gog).join("MASTER.DAT")).as_deref(),
        Some("GOG")
    );
    assert_eq!(
        refused(&canonical(&epic).join("x")).as_deref(),
        Some("Epic")
    );
    // A directory Move ends by removing the whole source; one that contains a
    // store game is refused too.
    assert_eq!(refused(&canonical(&games)).as_deref(), Some("GOG"));
    service
        .refuse_store_install_move("profile", &canonical(temporary.path()).join("Other"))
        .unwrap();
}

#[test]
fn a_steamapps_folder_is_protected_even_without_readable_metadata() {
    let temporary = tempfile::tempdir().unwrap();
    let service = service_with(temporary.path(), FixtureHost::default());
    let error = service
        .refuse_store_install_move(
            "profile",
            &temporary
                .path()
                .join("Lib")
                .join("SteamApps")
                .join("common")
                .join("G"),
        )
        .unwrap_err();
    assert_eq!(
        error.details.get("store").map(String::as_str),
        Some("Steam")
    );
    // Only the folder name matched, so the message does not claim a Steam game.
    assert!(error.message.contains("a folder named steamapps"));
}

#[cfg(unix)]
#[test]
fn a_linked_steamapps_folder_is_read_and_protected_as_its_real_folder() {
    let temporary = tempfile::tempdir().unwrap();
    let client = temporary.path().join("Steam");
    let real = temporary.path().join("Real Library Apps");
    fs::create_dir_all(real.join("common").join("Quake")).unwrap();
    fs::write(
        real.join("appmanifest_1.acf"),
        "\"AppState\" { \"name\" \"Quake\" \"installdir\" \"Quake\" }",
    )
    .unwrap();
    fs::create_dir_all(&client).unwrap();
    std::os::unix::fs::symlink(&real, client.join("steamapps")).unwrap();
    let host = FixtureHost {
        steam: vec![client],
        ..FixtureHost::default()
    };
    let detection = detect_for_profile(&host, None);
    assert_eq!(detection.report.installs.len(), 1);
    assert_eq!(
        detection.report.installs[0].path,
        canonical(&real.join("common").join("Quake"))
    );
    let service = service_with(temporary.path(), host);
    // The real folder has no `steamapps` name, so only detection protects it.
    service
        .refuse_store_install_move("profile", &canonical(&real).join("appmanifest_2.acf"))
        .unwrap_err();
}

#[test]
fn folders_that_hold_the_library_or_are_roots_are_not_suggested() {
    let temporary = tempfile::tempdir().unwrap();
    let service = service_with(
        temporary.path(),
        FixtureHost {
            gog: vec![
                RegisteredStoreInstall {
                    product_id: None,
                    title: "Everything".into(),
                    path: temporary.path().to_path_buf(),
                },
                RegisteredStoreInstall {
                    product_id: None,
                    title: "Root".into(),
                    path: std::path::absolute(Path::new(std::path::MAIN_SEPARATOR_STR)).unwrap(),
                },
            ],
            ..FixtureHost::default()
        },
    );
    let report = service.store_game_installs().unwrap();
    assert!(report.installs.is_empty());
    assert_eq!(report.skipped_entries, 2);
}

/// One Steam library list naming every given library folder.
fn library_list(client: &Path, libraries: &[PathBuf]) {
    let mut text = String::from("\"libraryfolders\"\n{\n");
    for (index, library) in libraries.iter().enumerate() {
        text.push_str(&format!(
            "\t\"{index}\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n",
            vdf_escape(library)
        ));
    }
    text.push_str("}\n");
    fs::create_dir_all(client.join("steamapps")).unwrap();
    fs::write(client.join("steamapps").join("libraryfolders.vdf"), text).unwrap();
}

fn refusal(service: &PortcoveService, path: &Path) -> Option<(String, String)> {
    let error = service.refuse_store_install_move("profile", path).err()?;
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    Some((
        error.details["store_ownership"].clone(),
        error
            .details
            .get("store")
            .or_else(|| error.details.get("unchecked_stores"))
            .cloned()
            .unwrap_or_default(),
    ))
}

#[test]
fn ownership_reads_every_steam_library_beyond_the_old_listing_bounds() {
    let temporary = tempfile::tempdir().unwrap();
    let client = temporary.path().join("Steam");
    // 65 libraries was one past the old 64-library bound; 100 is well beyond.
    let libraries = (0..100)
        .map(|index| temporary.path().join(format!("Library {index}")))
        .collect::<Vec<_>>();
    for library in &libraries {
        fs::create_dir_all(library.join("steamapps").join("common")).unwrap();
    }
    library_list(&client, &libraries);
    // The last library's game is a link to a folder outside `steamapps`.
    let last = libraries.last().unwrap();
    let linked = temporary.path().join("Linked Game");
    fs::create_dir_all(&linked).unwrap();
    steam_app(last, 77, "Linked", "Linked", false);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&linked, last.join("steamapps/common/Linked")).unwrap();
    let service = service_with(
        temporary.path(),
        FixtureHost {
            steam: vec![client],
            ..FixtureHost::default()
        },
    );
    // A folder holding the 65th and 100th library is refused from records.
    for index in [64, 99] {
        assert_eq!(
            refusal(&service, &canonical(&libraries[index])),
            Some(("store_owned".into(), "Steam".into())),
            "library {index}"
        );
    }
    #[cfg(unix)]
    assert_eq!(
        refusal(&service, &canonical(&linked).join("data.pak")),
        Some(("store_owned".into(), "Steam".into()))
    );
    let outside = temporary.path().join("Downloads");
    fs::create_dir_all(&outside).unwrap();
    assert_eq!(refusal(&service, &canonical(&outside)), None);
}

#[test]
fn ownership_reads_every_epic_manifest_and_gog_record_beyond_the_old_bounds() {
    let temporary = tempfile::tempdir().unwrap();
    let manifests = temporary.path().join("Manifests");
    fs::create_dir_all(&manifests).unwrap();
    // One past the old 16,384-entry manifest bound, all naming removed games.
    for index in 0..16_385 {
        fs::write(
            manifests.join(format!("{index:05}.item")),
            serde_json::json!({
                "DisplayName": "Removed",
                "InstallLocation": temporary.path().join("removed").join(index.to_string()),
            })
            .to_string(),
        )
        .unwrap();
    }
    let epic = temporary.path().join("Epic Games").join("Last");
    fs::create_dir_all(&epic).unwrap();
    fs::write(
        manifests.join("99999.item"),
        serde_json::json!({"DisplayName": "Last", "InstallLocation": epic}).to_string(),
    )
    .unwrap();
    // One past the old 4,096-key registry bound; the selected game is last.
    let mut gog = (0..=4_096)
        .map(|index| RegisteredStoreInstall {
            product_id: None,
            title: index.to_string(),
            path: temporary.path().join("gone").join(index.to_string()),
        })
        .collect::<Vec<_>>();
    let gog_game = temporary.path().join("GOG Games").join("Last");
    fs::create_dir_all(&gog_game).unwrap();
    gog.push(RegisteredStoreInstall {
        product_id: None,
        title: "Last".into(),
        path: gog_game.clone(),
    });
    let service = service_with(
        temporary.path(),
        FixtureHost {
            gog,
            epic: vec![manifests],
            ..FixtureHost::default()
        },
    );
    assert_eq!(
        refusal(&service, &canonical(&epic).join("x")),
        Some(("store_owned".into(), "Epic".into()))
    );
    assert_eq!(
        refusal(&service, &canonical(&gog_game)),
        Some(("store_owned".into(), "GOG".into()))
    );
    // A folder genuinely outside every store is allowed.
    let outside = temporary.path().join("Originals");
    fs::create_dir_all(&outside).unwrap();
    assert_eq!(refusal(&service, &canonical(&outside)), None);
}

#[test]
fn unreadable_store_records_block_a_move_as_not_yet_checked() {
    let temporary = tempfile::tempdir().unwrap();
    let outside = temporary.path().join("Originals");
    fs::create_dir_all(&outside).unwrap();
    let outside = canonical(&outside);

    // A Steam library list that cannot be read hides library locations.
    let client = temporary.path().join("Steam");
    fs::create_dir_all(client.join("steamapps")).unwrap();
    fs::write(
        client.join("steamapps/libraryfolders.vdf"),
        "\"libraryfolders\" { \"0\" {",
    )
    .unwrap();
    let service = service_with(
        temporary.path(),
        FixtureHost {
            steam: vec![client.clone()],
            ..FixtureHost::default()
        },
    );
    let error = service
        .refuse_store_install_move("profile", &outside)
        .unwrap_err();
    assert_eq!(error.details["store_ownership"], "not_checked");
    assert_eq!(error.details["unchecked_stores"], "Steam");
    assert!(error.details["unread_record"].ends_with("libraryfolders.vdf"));
    assert!(
        error
            .message
            .contains("could not read every game location Steam recorded")
    );
    // A file larger than any real list is unreadable too.
    fs::write(
        client.join("steamapps/libraryfolders.vdf"),
        vec![b' '; MAX_METADATA_BYTES as usize + 1],
    )
    .unwrap();
    assert_eq!(
        refusal(&service, &outside),
        Some(("not_checked".into(), "Steam".into()))
    );
    // A readable list restores the decision.
    library_list(&client, std::slice::from_ref(&client));
    assert_eq!(refusal(&service, &outside), None);
    // So does a malformed app manifest: its game folder could be a link.
    fs::write(client.join("steamapps/appmanifest_5.acf"), "\"AppState\" {").unwrap();
    assert_eq!(
        refusal(&service, &outside),
        Some(("not_checked".into(), "Steam".into()))
    );

    // A malformed Epic manifest and an unread GOG registry record.
    let manifests = temporary.path().join("Manifests");
    fs::create_dir_all(&manifests).unwrap();
    fs::write(manifests.join("broken.item"), "{").unwrap();
    let service = service_with(
        temporary.path(),
        FixtureHost {
            gog_unread: 1,
            epic: vec![manifests.clone()],
            ..FixtureHost::default()
        },
    );
    let error = service
        .refuse_store_install_move("profile", &outside)
        .unwrap_err();
    assert_eq!(error.details["unchecked_stores"], "GOG,Epic");
    assert_eq!(error.details["unread_records"], "2");
    assert!(error.message.contains("GOG and Epic"));
    // A record that does name a covering folder still decides ownership.
    let epic = temporary.path().join("Epic Game");
    fs::create_dir_all(&epic).unwrap();
    fs::write(
        manifests.join("good.item"),
        serde_json::json!({"DisplayName": "Game", "InstallLocation": epic}).to_string(),
    )
    .unwrap();
    assert_eq!(
        refusal(&service, &canonical(&epic)),
        Some(("store_owned".into(), "Epic".into()))
    );
    // A relative recorded location cannot be placed.
    let service = service_with(
        temporary.path(),
        FixtureHost {
            gog: vec![RegisteredStoreInstall {
                product_id: None,
                title: "Relative".into(),
                path: PathBuf::from("Games/Relative"),
            }],
            ..FixtureHost::default()
        },
    );
    assert_eq!(
        refusal(&service, &outside),
        Some(("not_checked".into(), "GOG".into()))
    );
}

#[test]
fn missing_and_unfinished_store_records_are_definite_facts() {
    let temporary = tempfile::tempdir().unwrap();
    let manifests = temporary.path().join("Manifests");
    fs::create_dir_all(&manifests).unwrap();
    let partial = temporary.path().join("Partial");
    fs::create_dir_all(&partial).unwrap();
    // An unfinished Epic install still holds Epic's files.
    fs::write(
        manifests.join("partial.item"),
        serde_json::json!({
            "DisplayName": "Partial",
            "InstallLocation": partial,
            "bIsIncompleteInstall": true,
        })
        .to_string(),
    )
    .unwrap();
    let service = service_with(
        temporary.path(),
        FixtureHost {
            // An absent Steam client, a removed GOG game and a missing Epic
            // folder are all known: nothing is installed there.
            steam: vec![temporary.path().join("No Steam")],
            gog: vec![RegisteredStoreInstall {
                product_id: None,
                title: "Removed".into(),
                path: temporary.path().join("Removed"),
            }],
            epic: vec![manifests, temporary.path().join("No Manifests")],
            ..FixtureHost::default()
        },
    );
    assert_eq!(
        refusal(&service, &canonical(&partial)),
        Some(("store_owned".into(), "Epic".into()))
    );
    let outside = temporary.path().join("Originals");
    fs::create_dir_all(&outside).unwrap();
    assert_eq!(refusal(&service, &canonical(&outside)), None);
}

#[test]
fn store_names_are_listed_in_reading_order() {
    assert_eq!(store_list(&[GameStore::Steam]), "Steam");
    assert_eq!(
        store_list(&[GameStore::Gog, GameStore::Epic]),
        "GOG and Epic"
    );
    assert_eq!(
        store_list(&[GameStore::Steam, GameStore::Gog, GameStore::Epic]),
        "Steam, GOG and Epic"
    );
}
