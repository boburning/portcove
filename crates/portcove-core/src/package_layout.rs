//! Reviewed package-layout fingerprints for managed routes.
//!
//! A release can keep matching its asset selector while its package changes
//! shape, for example by adding a runtime-replacing launcher. The catalog may
//! record a bounded fingerprint of the reviewed layout per platform. A candidate
//! whose extracted layout matches proceeds as an ordinary compatible release; a
//! different layout is held for review before anything is activated.
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use crate::{Platform, PortDefinition, PortcoveError, Result, ReviewedPackageLayout};

/// Upper bound on entries inspected; extraction already bounds the staged tree.
const MAXIMUM_ENTRIES: usize = 200_000;
const REPORTED_NAMES: usize = 3;

pub(crate) fn require_reviewed_layout(
    port: &PortDefinition,
    platform: Platform,
    payload_root: &Path,
) -> Result<()> {
    let Some(reviewed) = port.reviewed_package_layouts.get(&platform) else {
        return Ok(());
    };
    let observed = observe(payload_root, platform)?;
    match compare(reviewed, &observed) {
        None => Ok(()),
        Some(drift) => Err(PortcoveError::unsupported(drift.player_reason())),
    }
}

pub(crate) fn observe(root: &Path, platform: Platform) -> Result<ReviewedPackageLayout> {
    let root = look_through_wrapper(root)?;
    let mut directories = BTreeSet::new();
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            directories.insert(lowercase_name(&entry.file_name()));
        }
    }
    let mut executables = BTreeSet::new();
    let mut pending: Vec<(PathBuf, String)> = vec![(root, String::new())];
    let mut inspected = 0_usize;
    while let Some((directory, prefix)) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            inspected += 1;
            if inspected > MAXIMUM_ENTRIES {
                return Err(PortcoveError::verification(
                    "package has too many entries to fingerprint",
                ));
            }
            let file_type = entry.file_type()?;
            let relative = format!("{prefix}{}", lowercase_name(&entry.file_name()));
            if file_type.is_dir() {
                pending.push((entry.path(), format!("{relative}/")));
            } else if file_type.is_file() && is_executable(&entry, platform)? {
                // Location matters: a launcher moved into a subfolder or a second
                // program with the same name is a different layout.
                executables.insert(relative);
            }
        }
    }
    Ok(ReviewedPackageLayout {
        directories: directories.into_iter().collect(),
        executables: executables.into_iter().collect(),
    })
}

/// One wrapper directory with nothing beside it is the package root's container,
/// whatever its (often versioned) name.
fn look_through_wrapper(root: &Path) -> Result<PathBuf> {
    let mut entries = fs::read_dir(root)?;
    let (Some(first), None) = (entries.next(), entries.next()) else {
        return Ok(root.to_path_buf());
    };
    let first = first?;
    Ok(if first.file_type()?.is_dir() {
        first.path()
    } else {
        root.to_path_buf()
    })
}

fn lowercase_name(name: &std::ffi::OsStr) -> String {
    name.to_string_lossy().to_ascii_lowercase()
}

fn is_executable(entry: &fs::DirEntry, platform: Platform) -> Result<bool> {
    let name = lowercase_name(&entry.file_name());
    let extension = Path::new(&name)
        .extension()
        .and_then(|extension| extension.to_str());
    if matches!(
        extension,
        Some("exe" | "appimage" | "bat" | "cmd" | "ps1" | "sh" | "msi" | "jar" | "vbs" | "lnk")
    ) {
        return Ok(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Windows packages extracted on Unix keep no meaningful mode bits.
        if platform != Platform::WindowsX86_64 {
            return Ok(entry.metadata()?.permissions().mode() & 0o111 != 0);
        }
    }
    let _ = platform;
    Ok(false)
}

#[derive(Debug, PartialEq, Eq)]
struct LayoutDrift {
    added_directories: Vec<String>,
    removed_directories: Vec<String>,
    added_executables: Vec<String>,
    removed_executables: Vec<String>,
}

fn difference(left: &[String], right: &[String]) -> Vec<String> {
    let right: BTreeSet<_> = right.iter().collect();
    left.iter()
        .filter(|name| !right.contains(name))
        .cloned()
        .collect()
}

fn compare(
    reviewed: &ReviewedPackageLayout,
    observed: &ReviewedPackageLayout,
) -> Option<LayoutDrift> {
    let drift = LayoutDrift {
        added_directories: difference(&observed.directories, &reviewed.directories),
        removed_directories: difference(&reviewed.directories, &observed.directories),
        added_executables: difference(&observed.executables, &reviewed.executables),
        removed_executables: difference(&reviewed.executables, &observed.executables),
    };
    let unchanged = drift.added_directories.is_empty()
        && drift.removed_directories.is_empty()
        && drift.added_executables.is_empty()
        && drift.removed_executables.is_empty();
    (!unchanged).then_some(drift)
}

impl LayoutDrift {
    fn player_reason(&self) -> String {
        let mut changes = Vec::new();
        for (label, names) in [
            ("new programs", &self.added_executables),
            ("missing programs", &self.removed_executables),
            ("new folders", &self.added_directories),
            ("missing folders", &self.removed_directories),
        ] {
            if !names.is_empty() {
                changes.push(format!("{label}: {}", summarize(names)));
            }
        }
        format!(
            "Portcove did not install this version because its files changed in a way Portcove has not reviewed yet ({}). Nothing on your computer was changed. Check again after Portcove's next update.",
            changes.join("; ")
        )
    }
}

fn summarize(names: &[String]) -> String {
    let mut shown = names
        .iter()
        .take(REPORTED_NAMES)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > REPORTED_NAMES {
        shown.push_str(&format!(" and {} more", names.len() - REPORTED_NAMES));
    }
    shown
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, relative: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }

    fn package(wrapper: Option<&str>, files: &[&str]) -> tempfile::TempDir {
        let temporary = tempfile::tempdir().unwrap();
        let root = match wrapper {
            Some(name) => temporary.path().join(name),
            None => temporary.path().to_path_buf(),
        };
        for file in files {
            write(&root, file);
        }
        temporary
    }

    const REVIEWED_FILES: &[&str] = &[
        "Game.exe",
        "data/level.dat",
        "data/readme.txt",
        "lib/helper.dll",
        "README.md",
    ];

    fn reviewed() -> ReviewedPackageLayout {
        let package = package(Some("game-1.0"), REVIEWED_FILES);
        observe(package.path(), Platform::WindowsX86_64).unwrap()
    }

    #[test]
    fn observation_records_directories_and_executables_through_a_wrapper() {
        assert_eq!(
            reviewed(),
            ReviewedPackageLayout {
                directories: vec!["data".to_owned(), "lib".to_owned()],
                executables: vec!["game.exe".to_owned()],
            }
        );
    }

    #[test]
    fn a_compatible_successor_with_a_renamed_wrapper_and_new_data_proceeds() {
        let mut files = REVIEWED_FILES.to_vec();
        files.extend(["data/new-level.dat", "lib/other.dll", "CHANGELOG.md"]);
        let successor = package(Some("game-1.1"), &files);
        let observed = observe(successor.path(), Platform::WindowsX86_64).unwrap();
        assert_eq!(compare(&reviewed(), &observed), None);
    }

    #[test]
    fn a_new_launcher_or_folder_is_drift_with_a_player_reason() {
        let mut files = REVIEWED_FILES.to_vec();
        files.extend(["Launcher.exe", "runtime/engine.bin"]);
        let drifted = package(Some("game-1.1"), &files);
        let observed = observe(drifted.path(), Platform::WindowsX86_64).unwrap();
        let drift = compare(&reviewed(), &observed).unwrap();
        assert_eq!(drift.added_executables, ["launcher.exe"]);
        assert_eq!(drift.added_directories, ["runtime"]);
        let reason = drift.player_reason();
        assert!(reason.contains("new programs: launcher.exe"), "{reason}");
        assert!(reason.contains("new folders: runtime"), "{reason}");
        assert!(
            reason.contains("Nothing on your computer was changed"),
            "{reason}"
        );
    }

    #[test]
    fn a_renamed_executable_is_drift_in_both_directions() {
        let files = ["Game2.exe", "data/level.dat", "lib/helper.dll"];
        let renamed = package(Some("game-1.1"), &files);
        let observed = observe(renamed.path(), Platform::WindowsX86_64).unwrap();
        let drift = compare(&reviewed(), &observed).unwrap();
        assert_eq!(drift.added_executables, ["game2.exe"]);
        assert_eq!(drift.removed_executables, ["game.exe"]);
    }

    #[test]
    fn a_moved_or_duplicated_program_is_drift_even_with_an_unchanged_name() {
        let reviewed = reviewed();
        let duplicated = package(
            Some("game-1.1"),
            &[
                "Game.exe",
                "tools/Game.exe",
                "data/level.dat",
                "lib/helper.dll",
            ],
        );
        let observed = observe(duplicated.path(), Platform::WindowsX86_64).unwrap();
        let drift = compare(&reviewed, &observed).unwrap();
        assert_eq!(drift.added_executables, ["tools/game.exe"]);
        let moved = package(
            Some("game-1.1"),
            &["bin/Game.exe", "data/level.dat", "lib/helper.dll"],
        );
        let observed = observe(moved.path(), Platform::WindowsX86_64).unwrap();
        let drift = compare(&reviewed, &observed).unwrap();
        assert_eq!(drift.added_executables, ["bin/game.exe"]);
        assert_eq!(drift.removed_executables, ["game.exe"]);
    }

    #[test]
    fn installers_scripts_and_shortcuts_count_but_libraries_do_not() {
        let mut files = REVIEWED_FILES.to_vec();
        files.extend(["lib/other.dll", "lib/other.so"]);
        let libraries = package(Some("game-1.1"), &files);
        let observed = observe(libraries.path(), Platform::WindowsX86_64).unwrap();
        assert_eq!(compare(&reviewed(), &observed), None);
        for extra in ["Setup.msi", "tool.jar", "run.vbs", "Game.lnk"] {
            let mut files = REVIEWED_FILES.to_vec();
            files.push(extra);
            let drifted = package(Some("game-1.1"), &files);
            let observed = observe(drifted.path(), Platform::WindowsX86_64).unwrap();
            assert!(compare(&reviewed(), &observed).is_some(), "{extra}");
        }
    }

    #[test]
    fn an_unreviewed_platform_has_no_layout_requirement() {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .ports()
            .first()
            .unwrap()
            .clone();
        port.reviewed_package_layouts.clear();
        let anything = package(None, &["whatever.exe"]);
        assert!(require_reviewed_layout(&port, Platform::WindowsX86_64, anything.path()).is_ok());
    }

    #[test]
    fn drift_is_refused_as_a_hold_and_a_match_is_accepted() {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .ports()
            .first()
            .unwrap()
            .clone();
        port.reviewed_package_layouts
            .insert(Platform::WindowsX86_64, reviewed());
        let same = package(Some("game-2.0"), REVIEWED_FILES);
        assert!(require_reviewed_layout(&port, Platform::WindowsX86_64, same.path()).is_ok());
        let drifted = package(
            Some("game-2.0"),
            &[
                "Game.exe",
                "Updater.exe",
                "data/level.dat",
                "lib/helper.dll",
            ],
        );
        let refusal =
            require_reviewed_layout(&port, Platform::WindowsX86_64, drifted.path()).unwrap_err();
        assert_eq!(refusal.code, crate::ErrorCode::Unsupported);
        assert!(
            refusal.message.contains("updater.exe"),
            "{}",
            refusal.message
        );
    }
}
