// Reviewed host interfaces and command switches with platform-defined spelling.
const GLOBAL: &[&str] = &[
    "/dev/null",
    "/proc/self/stat",
    "/bin/sh",
    "/bin/sleep",
    "/d",
    "/c",
    "/u",
    "/C",
    "/J",
    "/usr/bin/dolphin-tool",
    "/usr/local/bin/dolphin-tool",
    "/app/bin/dolphin-tool",
    "/opt/homebrew/bin/dolphin-tool",
    "/Applications/Dolphin.app/Contents/MacOS/DolphinTool",
    "/usr/bin/mame/chdman",
    "/usr/bin/chdman",
    "/usr/local/bin/chdman",
    "/opt/homebrew/bin/chdman",
    "/Applications/MAME/chdman",
    "/usr/bin/dpkg-query",
    "/usr/bin/rpm",
    "/usr/sbin:/usr/bin:/sbin:/bin",
    "/usr/bin/portcove-desktop",
];

const SCOPED: &[(&str, &[&str])] = &[
    // This dedicated test file intentionally rejects the exact hostile selector below.
    (
        "crates/portcove-core/src/external_runtime/tfe_settings_tests.rs",
        &["C:/Games/"],
    ),
    (
        "apps/desktop/src-tauri/src/application_update_restart_tests.rs",
        &["/owned host helpers/fusermount3"],
    ),
    (
        "apps/desktop/src-tauri/src/source_removal_tests.rs",
        &["D:/Original ü/game.iso"],
    ),
    (
        "apps/desktop/src-tauri/src/application_update_process_environment_tests.rs",
        &[
            "/usr/bin/env",
            "/owned host helpers/fusermount3",
            "/owned library",
        ],
    ),
    (
        "crates/portcove-release-tools/tests/tuf_repository/offline.rs",
        &["/keytype", "/scheme", "/keyval/public"],
    ),
    (
        "crates/portcove-release-tools/src/definition_repository/tests.rs",
        &["/absolute"],
    ),
    (
        "crates/portcove-cli/src/human/transfers_tests.rs",
        &[
            "/game files/星の狐.z64",
            "/original/星の狐.z64",
            "/new\nlocation.z64",
            "/restored",
            "/original",
            "/export/metadata.json",
            "/copied payload",
            "/restore target",
        ],
    ),
    (
        "crates/portcove-cli/src/human/task_results_tests.rs",
        &[
            "/library/备份/backup-1",
            "/managed\nゲーム\u{001b}",
            "/original\nゲーム\u{001b}",
            "/library",
            "/library/ports",
            "/library/user/starship",
            "/managed/retained-install",
            "/library/セーブ\tsettings\u{001b}",
            "/library/ゲーム",
            "/owned/ゲーム\nfolder",
            "/owned/ゲーム/game",
        ],
    ),
    (
        "crates/portcove-core/src/relative_file_set_tests.rs",
        &["C:/outside", "/DARK.GOB"],
    ),
    (
        "crates/portcove-core/src/external_runtime/shared_preferences_tests.rs",
        &[
            "C:\\Runtime\\runtime_prefs.ini",
            "C:\\café",
            "C:\\game\nfile",
            "C:\\game\u{0000}file",
        ],
    ),
    (
        "crates/portcove-core/src/service/ghostship_legacy_save_tests.rs",
        &[
            "/shipSaveData/achievementSaveData/entries/0/id",
            "/shipSaveData/achievementSaveData/entries/0/progress",
            "/shipSaveData/achievementSaveData/cheated",
            "/shipSaveData/achievementSaveData/capStars",
            "/shipSaveData/achievementSaveData/coins",
            "/shipSaveData/randoSaveData/randoSaveChecks/0/randoItemId",
            "/shipSaveData/randoSaveData/randoSaveChecks/0/randoAct",
            "/shipSaveData/randoSaveData/randoSaveChecks/1/randoAct",
            "/shipSaveData/randoSaveData/randoSaveChecks/0/obtained",
            "/shipSaveData/randoSaveData/randoSaveChecks/0/skipped",
            "/shipSaveData/randoSaveData/randoSaveEntrances/0/destinationId",
            "/shipSaveData/randoSaveData/randoSaveEntrances/1/destinationId",
            "/shipSaveData/randoSaveData/randoSaveEntrances/1/randoEntranceId",
            "/shipSaveData/randoSaveData/randoSaveEntrances/1/found",
            "/shipSaveData/randoSaveData/randoSaveOptions/9",
            "/shipSaveData/randoSaveData/finalSeed",
            "/version",
            "/capLevel",
            "/capArea",
            "/capPos/x",
            "/capPos/y",
            "/capPos/z",
            "/flags",
            "/courseStars/BOB",
            "/courseCoinScores/RR",
        ],
    ),
    (
        "crates/portcove-core/src/service/catalog_download_tests.rs",
        &[
            "/repos/owner/game/releases/7",
            "/download/game.zip",
            "/download/game.zip.sha256",
        ],
    ),
    // Launcher metadata must reject these remote and Windows device paths.
    (
        "crates/portcove-core/src/service/launcher_library_tests.rs",
        &[
            r"\\host\share\Game",
            r"\\?\UNC\host\share\Game",
            r"\\.\pipe\x",
            r"\\?\C:\Games",
        ],
    ),
    (
        "crates/portcove-core/src/native_portable_data.rs",
        &[
            // OpenSC2K writes to this fixed Godot temp path on Linux. Its parent must be sticky.
            "/tmp/OpenSC2K Autosaves",
            "/tmp",
            // The inline tests exercise Godot profile fallback and reject a Windows drive path.
            "/profiles",
            "/home/player",
            "/config",
            "C:/redirect",
        ],
    ),
    (
        "crates/portcove-core/src/failure_tests.rs",
        &[
            "C:/Games/<preserve>",
            "C:/Transfer/retroachievements.credentials.1",
        ],
    ),
    (
        "crates/portcove-core/src/cancellation_managed_builder_tests.rs",
        &["/L", "/deny", "/d", "/c", "/J"],
    ),
    (
        "crates/portcove-core/src/runtime_path_policy_tests.rs",
        &[
            "C:\\Games 日本語",
            "C:\\Games",
            "C:\\Games with spaces",
            "C:\\Games\\DKC3",
            "C:\\Games with spaces\\F-Zero",
            "\\\\?\\C:\\Games\\F-Zero",
            "\\\\server\\games\\F-Zero",
            "\\\\?\\UNC\\server\\games\\F-Zero",
            "C:\\Juegos\\José",
            "C:\\Games\\日本語",
            "C:\\Games\\bad\tname",
            "C:\\Games\\runtime\\game.exe",
            "C:\\Games\\runtime",
            "C:\\Originals\\game.sfc",
            "C:\\Originals\\日本語.sfc",
            "C:\\日本語",
            "/home/日本語",
            "C:\\Games\\José",
            "\\\\?\\C:\\Games\\日本語",
            "\\\\?\\UNC\\server\\games",
            "C:\\",
        ],
    ),
    // exact Windows extended UNC prefix; values are exact and apply only to this file.
    (
        "crates/portcove-core/src/runtime_path_policy.rs",
        &["\\\\?\\UNC\\"],
    ),
    (
        "crates/portcove-core/src/preparation_ghostship_tests.rs",
        &[
            "E:/fixture/Ghostship",
            "E:/fixture with spaces/baserom.us.z64",
        ],
    ),
    // GitLab URL path comparisons, not host filesystem locations.
    (
        "crates/portcove-core/src/gitlab.rs",
        &[
            "/packages/generic/",
            "/projects/other%2Fproject/packages/generic/game/1.0.0/game-windows-x64.zip",
        ],
    ),
    // Managed PS1 preparation uses this fixed macOS host-tool directory. Apple
    // developer tool queries cannot inherit an arbitrary executable search path.
    (
        "crates/portcove-core/src/psx.rs",
        &[
            "/usr/bin",
            "D:\\ROMs\\Example (Disc 1).chd",
            "D:\\ROMs\\Example (Disc 2).chd",
            "D:\\ROMs\\Game.chd",
        ],
    ),
    // The Unix-only failure fixture runs this exact non-mutating system command.
    (
        "crates/portcove-core/src/adapter_unix_failure_tests.rs",
        &["/usr/bin/false"],
    ),
    // Catalog media URL path prefixes; exact values in their URL comparison owner.
    (
        "crates/portcove-core/src/catalog_media.rs",
        &["/igdb/image/upload/", "/wikipedia/commons/"],
    ),
    // Exact Windows path-envelope fixture values; no production-file allowance.
    (
        "crates/portcove-core/src/install/tests/native_paths.rs",
        &["C:\\日本語"],
    ),
    // GitLab HTTP route fixtures and package-file URL path comparisons.
    (
        "crates/portcove-core/src/gitlab/catalog_download/tests.rs",
        &[
            "/releases",
            "/releases/v1",
            "/assets/links/7",
            "/assets/links",
            "/packages",
            "/package_files",
            "/owner/game/-/package_files/17/download",
            "/owner/game/-/package_files/18/download",
            "/owner/other/-/package_files/17/download",
        ],
    ),
    // Windows path-envelope rejection fixtures with exact hostile values.
    (
        "crates/portcove-core/src/game_settings/windows.rs",
        &[
            "\\\\server\\share\\file.ini",
            "\\\\?\\UNC\\server\\share\\file.ini",
            "\\\\.\\C:\\file.ini",
            "C:\\parent\\.\\file.ini",
            "C:\\parent\\..\\file.ini",
            "C:\\parent.\\file.ini",
            "C:\\parent \\file.ini",
            "C:\\parent\\file.ini:stream",
        ],
    ),
    // Absolute selector fixtures for rejecting paths in game settings.
    (
        "crates/portcove-core/src/game_settings_tests.rs",
        &["/mdkr64_app.ini", "C:/mdkr64_app.ini"],
    ),
    // User-selected input fixtures and emulator switches, with exact values.
    (
        "crates/portcove-core/src/service/user_selected.rs",
        &[
            "C:\\Owned Discs\\Ape Escape.cue",
            "C:\\Player Data\\Ape Escape\\game.toml",
            "C:\\Player Data\\Ape Escape Cards",
            "/opengl",
            "/win",
            "/b0",
            "/x800",
            "/y600",
            "C:\\Owned Games\\Star Fox Adventures.iso",
            "C:\\Owned originals\\EarthBound USA.sfc",
        ],
    ),
    // Provider release URL suffixes in listing identity validation.
    (
        "crates/portcove-core/src/service/listings.rs",
        &["/releases", "/-/releases"],
    ),
    // Path-like text fragments rejected by advisory display redaction.
    (
        "crates/portcove-core/src/service/advisories.rs",
        &["/home/", "/users/"],
    ),
    // HTTP checksum route in the native archive fixture.
    (
        "crates/portcove-core/src/service/native_portable.rs",
        &["/checksums.txt"],
    ),
    // Fixed HTTPS route checks in the installed-update rehearsal example.
    (
        "apps/desktop/src-tauri/examples/prepare_installed_update.rs",
        &["/portcove/rehearsal/", "/application/metadata/"],
    ),
    // GitHub OAuth web routes and their exact HTTP request fixture expectations.
    (
        "crates/portcove-core/src/release.rs",
        &["/login/device/code", "/login/oauth/access_token"],
    ),
    // Test-only game locations across profile resolution and relocation.
    (
        "crates/portcove-core/src/profile_tests.rs",
        &[
            "/games/original.z64",
            "/old/location.z64",
            "/new/location.z64",
            "/a.z64",
            "/b.z64",
        ],
    ),
    // JSON pointers in definition validation fixtures.
    (
        "crates/portcove-core/src/definition_entry_tests.rs",
        &[
            "/port/release/linux_tar_xz",
            "/port/release/tar_xz_platforms",
            "/port/release/asset_hints/macos-aarch64",
            "/port/platforms",
            "/port/release/provider",
            "/port/adapter",
        ],
    ),
    // Exact path controls in the diagnostic redaction tests.
    (
        "crates/portcove-core/src/bug_report.rs",
        &[
            "C:\\Users\\Alice Smith",
            "D:/Games/Portcove Library",
            "C:\\Users\\Alice",
            "/home/bob",
            "C:\\",
            "/h",
            "\\\\nas\\games\\library",
            "/home/zoë",
        ],
    ),
    // Exact hostile profile import and relocation fixture paths.
    (
        "crates/portcove-core/src/profile_deploy_tests.rs",
        &["/etc/passwd", "/tmp/does-not-matter/user/starship"],
    ),
    // Synthetic environment and account paths in profile-resolution tests.
    (
        "crates/portcove-core/src/native_external_profile/archive_siblings.rs",
        &[
            "/player/home",
            "/account/home",
            "/player/config",
            "/player/data",
        ],
    ),
    // Synthetic account and environment paths in the profile tests.
    (
        "crates/portcove-core/src/native_external_profile/quake_linux.rs",
        &["/accounts/player", "/environment/player"],
    ),
    // Upstream system module location and an exact invalid profile fixture.
    (
        "crates/portcove-core/src/native_external_profile/doom3_linux.rs",
        &["/usr/local/lib/dhewm3", "/with\\backslash"],
    ),
    // Synthetic profile roots in resolution and symlink tests.
    (
        "crates/portcove-core/src/native_external_profile/openmohaa.rs",
        &["/player/home", "/player/data"],
    ),
    // Synthetic profile roots in layout tests.
    (
        "crates/portcove-core/src/native_external_profile/profile_siblings.rs",
        &["/player/settings", "/player/home", "/account/home"],
    ),
    // Synthetic home and exact invalid profile roots in tests.
    (
        "crates/portcove-core/src/native_external_profile/openjk.rs",
        &[
            "/personal",
            "/back\\slash",
            "/double..period",
            "/double::colon",
        ],
    ),
    // AppImage system temporary directory and an exact rejected test value.
    (
        "crates/portcove-core/src/native_external_profile.rs",
        &["/tmp", "/custom/libs"],
    ),
    // An exact rooted package name that recipe inspection must reject.
    ("crates/portcove-core/src/recipe_tests.rs", &["/etc/passwd"]),
];

pub fn allows(file: &str, value: &str) -> bool {
    GLOBAL.contains(&value)
        || SCOPED
            .iter()
            .any(|(owner, values)| file == *owner && values.contains(&value))
}
