use std::{fs, path::Path, sync::Arc};

use super::*;
use crate::Library;

#[derive(Default)]
struct FixtureHost {
    steam: Vec<PathBuf>,
    gog: Vec<RegisteredStoreInstall>,
    epic: Vec<PathBuf>,
}

impl StoreInstallHost for FixtureHost {
    fn steam_client_roots(&self) -> Vec<PathBuf> {
        self.steam.clone()
    }

    fn gog_registered_installs(&self) -> Vec<RegisteredStoreInstall> {
        self.gog.clone()
    }

    fn epic_manifest_dirs(&self) -> Vec<PathBuf> {
        self.epic.clone()
    }
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
    assert!(
        detection
            .protected
            .iter()
            .any(|(store, folder)| *store == GameStore::Steam
                && *folder == canonical(&second.join("steamapps")))
    );
}

#[test]
fn vdf_reader_accepts_escapes_comments_and_the_older_library_layout() {
    assert_eq!(
        steam_library_paths(
            "// comment\n\"LibraryFolders\"\n{\n\t\"TimeNextStatsReport\"\t\"1\"\n\t\"1\"\t\t\"D:\\\\Steam \\\"Library\\\"\"\n}\n"
        ),
        vec![PathBuf::from("D:\\Steam \"Library\"")]
    );
    assert_eq!(
        steam_library_paths("\"libraryfolders\" { \"0\" {"),
        Vec::<PathBuf>::new()
    );
    assert_eq!(steam_library_paths("unquoted"), Vec::<PathBuf>::new());
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
    let report = detect(&FixtureHost {
        gog,
        ..FixtureHost::default()
    })
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
    let detection = detect(&FixtureHost {
        steam: vec![steam],
        ..FixtureHost::default()
    });
    let row = &detection.report.installs[0];
    assert_eq!(row.path, canonical(&elsewhere));
    assert_eq!(row.product_id.as_deref(), Some("32400"));
    assert!(row.original_folder.is_none());
    assert!(
        detection
            .protected
            .contains(&(GameStore::Steam, row.path.clone()))
    );
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
    let detection = detect(&host);
    assert_eq!(detection.report.installs.len(), 1);
    assert_eq!(
        detection.report.installs[0].path,
        canonical(&real.join("common").join("Quake"))
    );
    assert!(
        detection
            .protected
            .iter()
            .any(|(_, folder)| *folder == canonical(&real))
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
