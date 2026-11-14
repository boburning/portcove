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
                title: "Fallout 2".into(),
                path: gog_folder.clone(),
            },
            // The same folder from another store entry is listed once.
            RegisteredStoreInstall {
                title: "Fallout 2 duplicate".into(),
                path: gog_folder.join("."),
            },
            RegisteredStoreInstall {
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
    // Gone, `..`, `a/b`, malformed, oversized, missing GOG, partial and broken Epic.
    assert_eq!(report.skipped_entries, 8);
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
        Some((String::new(), "Game".into()))
    );
    assert_eq!(
        steam_app_manifest("\"AppState\" { \"name\" \"No folder\" }"),
        None
    );
    assert!(single_normal_component("Half-Life"));
    for unsafe_name in ["", ".", "..", "a/b", "a\\b", "C:", "/abs"] {
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
