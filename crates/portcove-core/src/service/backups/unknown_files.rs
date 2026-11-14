//! Unknown player-side files (#5359 Tier 1).
//!
//! These are undeclared regular files in a managed portable runtime that are
//! not programs, scripts, libraries or links, such as settings a game writes
//! beside itself. They do not hold managed operations. Backups copy them into
//! a separate `unknown-files/<install-id>/` area with its own integrity
//! record. Restore publishes only `data/`, so it never writes them into a
//! declared path. The caps apply only where files are copied. Past a cap an
//! explicit backup or a removal holds instead of truncating; an automatic
//! snapshot before a version change or restore copies none and records how
//! many it left in place, because those operations delete nothing.
use super::*;

pub(crate) const UNKNOWN_FILES_DIRECTORY: &str = "unknown-files";
pub(crate) const MAX_UNKNOWN_FILES: usize = 1_024;
pub(crate) const MAX_UNKNOWN_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_UNKNOWN_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// One unknown player-side file in one installed version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnknownRuntimeFile {
    pub(crate) install_id: String,
    pub(crate) install_root: PathBuf,
    /// Install-relative path with `/` separators.
    pub(crate) relative: String,
    pub(crate) size: u64,
}

/// Integrity record of a backup's unknown-file area. It is not part of the
/// restorable content digest: restore never reads this area.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct UnknownFilesArea {
    pub(super) file_count: u64,
    pub(super) size: u64,
    pub(super) sha256: String,
}

/// Measure the unknown files a verification reported. No cap applies here.
pub(crate) fn measure(
    install: &InstallRecord,
    relatives: Vec<String>,
) -> Result<Vec<UnknownRuntimeFile>> {
    relatives
        .into_iter()
        .map(|relative| {
            let path = crate::install::manifest_member(&install.path, &relative)?;
            let metadata = fs::symlink_metadata(&path)?;
            if !metadata.is_file() {
                return Err(PortcoveError::conflict(
                    "An unrecognized file in the game folder changed while Portcove was checking it. Nothing was changed; try again.",
                )
                .detail("path", relative));
            }
            Ok(UnknownRuntimeFile {
                install_id: install.id.clone(),
                install_root: install.path.clone(),
                relative,
                size: metadata.len(),
            })
        })
        .collect::<Result<Vec<_>>>()
}

/// Hold rather than back up only part of the unknown files.
pub(crate) fn require_within_caps(files: &[UnknownRuntimeFile]) -> Result<()> {
    let total = files
        .iter()
        .fold(0_u64, |total, file| total.saturating_add(file.size));
    let oversized = files.iter().find(|file| file.size > MAX_UNKNOWN_FILE_BYTES);
    if files.len() <= MAX_UNKNOWN_FILES && oversized.is_none() && total <= MAX_UNKNOWN_TOTAL_BYTES {
        return Ok(());
    }
    let mut error = PortcoveError::conflict(
        "The game folder has more unrecognized files than Portcove can back up. This operation stopped and every file stayed in place. Move files you don't need out of the game folder, then try again.",
    )
    .detail("unknown_file_count", files.len().to_string())
    .detail("unknown_file_bytes", total.to_string())
    .detail(
        "unknown_file_limits",
        format!(
            "{MAX_UNKNOWN_FILES} files, {MAX_UNKNOWN_FILE_BYTES} bytes each, {MAX_UNKNOWN_TOTAL_BYTES} bytes in total"
        ),
    );
    if let Some(file) = oversized {
        error = error
            .detail("oversized_unknown_file", &file.relative)
            .detail("oversized_unknown_file_bytes", file.size.to_string());
    }
    Err(error)
}

/// Copy unknown files into the unpublished backup stage.
pub(super) fn copy_area(
    staging: &Path,
    files: &[UnknownRuntimeFile],
) -> Result<Option<UnknownFilesArea>> {
    if files.is_empty() {
        return Ok(None);
    }
    require_within_caps(files)?;
    let area = staging.join(UNKNOWN_FILES_DIRECTORY);
    let mut stats = BackupStats::default();
    for file in files {
        let install = Path::new(&file.install_id);
        if !matches!(
            install.components().collect::<Vec<_>>().as_slice(),
            [std::path::Component::Normal(_)]
        ) {
            return Err(PortcoveError::state(
                "installation identity is not a single path component",
            ));
        }
        let source = crate::install::manifest_member(&file.install_root, &file.relative)?;
        let metadata = fs::symlink_metadata(&source)?;
        if !metadata.is_file() || metadata.len() != file.size {
            return Err(PortcoveError::conflict(
                "An unrecognized file in the game folder changed while Portcove was backing it up. Nothing was changed; try again.",
            )
            .detail("path", &file.relative));
        }
        stats.hasher.update(b"install\0");
        stats.hasher.update(file.install_id.as_bytes());
        stats.hasher.update(b"\0");
        copy_backup_tree(
            &source,
            &crate::install::manifest_member(&area.join(install), &file.relative)?,
            &file.install_root,
            &mut stats,
        )?;
    }
    if stats.size > MAX_UNKNOWN_TOTAL_BYTES {
        return Err(PortcoveError::conflict(
            "Unrecognized files in the game folder grew while Portcove was backing them up. Nothing was changed; try again.",
        ));
    }
    Ok(Some(UnknownFilesArea {
        file_count: stats.file_count,
        size: stats.size,
        sha256: hex::encode(stats.hasher.finalize()),
    }))
}

impl PortcoveService {
    /// Unknown files of the versions a backup already checks: the collectible
    /// active version and every generated-cache version, or every version for
    /// the safety backup taken before removal. Hazards hold as before.
    pub(super) fn backup_unknown_files(
        &self,
        port_id: &str,
        scope: UnknownFileScope,
    ) -> Result<UnknownFileSelection> {
        let mut all = self
            .library
            .all_installs()?
            .into_iter()
            .filter(|install| install.port_id == port_id)
            .collect::<Vec<_>>();
        all.sort_by(|left, right| left.id.cmp(&right.id));
        let mut installs = Vec::new();
        if scope != UnknownFileScope::Removal
            && let Some(active) = self.collectible_active_install(port_id)?
        {
            installs.push(active);
        }
        for install in all {
            // An absent runtime has nothing to copy; removal reports it separately.
            if installs.iter().any(|selected| selected.id == install.id)
                || matches!(fs::symlink_metadata(&install.path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
            {
                continue;
            }
            if scope == UnknownFileScope::Removal
                || self.installed_port(&install)?.adapter == crate::AdapterKind::GeneratedCache
            {
                installs.push(install);
            }
        }
        let mut files = Vec::new();
        for install in &installs {
            files.extend(self.portable_runtime_unknown_files(install)?);
        }
        match (scope, require_within_caps(&files)) {
            (_, Ok(())) => Ok(UnknownFileSelection {
                files,
                left_in_place: 0,
            }),
            (UnknownFileScope::Automatic, Err(_)) => Ok(UnknownFileSelection {
                left_in_place: files.len() as u64,
                files: Vec::new(),
            }),
            (_, Err(error)) => Err(error),
        }
    }
}

/// Which versions' unknown files a backup copies, and what a cap does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnknownFileScope {
    /// A backup the player asked for: the active version; past a cap, hold.
    Explicit,
    /// A safety snapshot before a version change, restore or import, which
    /// deletes no unknown file: the active version; past a cap, copy none.
    Automatic,
    /// The safety backup before removal: every version; past a cap, hold.
    Removal,
}

/// The unknown files a backup copies, and how many it left in place.
#[derive(Debug, Default)]
pub(crate) struct UnknownFileSelection {
    pub(crate) files: Vec<UnknownRuntimeFile>,
    pub(crate) left_in_place: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(sizes: &[u64]) -> Vec<UnknownRuntimeFile> {
        sizes
            .iter()
            .enumerate()
            .map(|(index, size)| UnknownRuntimeFile {
                install_id: "install".into(),
                install_root: PathBuf::from("root"),
                relative: format!("file-{index}.ini"),
                size: *size,
            })
            .collect()
    }

    #[test]
    fn caps_admit_their_limits_and_hold_one_past_each() {
        let mib = 1024 * 1024;
        assert_eq!(MAX_UNKNOWN_FILES, 1_024);
        assert_eq!(MAX_UNKNOWN_FILE_BYTES, 16 * mib);
        assert_eq!(MAX_UNKNOWN_TOTAL_BYTES, 64 * mib);
        for admitted in [
            files(&vec![1; MAX_UNKNOWN_FILES]),
            files(&[MAX_UNKNOWN_FILE_BYTES]),
            files(&[16 * mib; 4]),
            Vec::new(),
        ] {
            require_within_caps(&admitted).unwrap();
        }
        for (held, detail) in [
            (files(&vec![1; MAX_UNKNOWN_FILES + 1]), "unknown_file_count"),
            (
                files(&[MAX_UNKNOWN_FILE_BYTES + 1]),
                "oversized_unknown_file",
            ),
            (
                files(&[16 * mib, 16 * mib, 16 * mib, 16 * mib, 1]),
                "unknown_file_bytes",
            ),
            (files(&[u64::MAX, u64::MAX]), "oversized_unknown_file"),
        ] {
            let error = require_within_caps(&held).unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Conflict);
            assert!(error.details.contains_key(detail), "{error:?}");
            assert!(error.message.contains("every file stayed in place"));
        }
    }

    #[test]
    fn unknown_area_copies_exact_bytes_under_each_installation() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("install");
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::write(root.join("settings.ini"), b"lives=9").unwrap();
        fs::write(root.join("logs/run.txt"), b"log").unwrap();
        let stage = temporary.path().join("stage");
        fs::create_dir(&stage).unwrap();
        let entry = |relative: &str, size| UnknownRuntimeFile {
            install_id: "install-a".into(),
            install_root: root.clone(),
            relative: relative.into(),
            size,
        };
        let area = copy_area(
            &stage,
            &[entry("logs/run.txt", 3), entry("settings.ini", 7)],
        )
        .unwrap()
        .unwrap();
        assert_eq!((area.file_count, area.size), (2, 10));
        let copied = stage.join(UNKNOWN_FILES_DIRECTORY).join("install-a");
        assert_eq!(fs::read(copied.join("settings.ini")).unwrap(), b"lives=9");
        assert_eq!(fs::read(copied.join("logs/run.txt")).unwrap(), b"log");
        assert!(copy_area(&stage, &[]).unwrap().is_none());
        // A file that changed since it was measured holds the backup.
        let other = temporary.path().join("other-stage");
        fs::create_dir(&other).unwrap();
        assert!(copy_area(&other, &[entry("settings.ini", 3)]).is_err());
        let mut escaping = entry("settings.ini", 7);
        escaping.install_id = "../escape".into();
        assert!(copy_area(&other, &[escaping]).is_err());
    }
}
