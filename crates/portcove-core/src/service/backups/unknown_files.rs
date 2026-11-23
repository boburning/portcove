//! Unknown player-side files (#5359 Tier 1).
//!
//! These are undeclared regular files in a managed portable runtime that are
//! not programs, scripts, libraries or links, such as settings a game writes
//! beside itself. They do not hold managed operations. Backups copy them into
//! a separate `unknown-files/<install-id>/` area with its own integrity
//! record. Restore publishes only `data/`, so it never writes them into a
//! declared path. An explicit backup and the backup before removal copy
//! every file and need only the free space for them (owner decision
//! 2026-11-15); without it they hold instead of truncating. An automatic
//! snapshot before a version change or restore keeps the caps: past one it
//! copies none and records how many it left in place, because those
//! operations delete nothing and run on every switch.
//!
//! A removal backup collects every version, and Tier 2 places identical
//! copies in several of them, so it stores each distinct (path, bytes) once
//! under the first installation that has it and lists every installation's
//! copy in `unknown-files/index.json` (`unknown_files_v2`). The space check
//! counts what is stored.
use super::*;
use std::collections::BTreeMap;

pub(crate) const UNKNOWN_FILES_DIRECTORY: &str = "unknown-files";
pub(crate) const MAX_UNKNOWN_FILES: usize = 1_024;
pub(crate) const MAX_UNKNOWN_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_UNKNOWN_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
/// The bytes that must be free to copy `bytes`, or `None` when they fit. The
/// reserve kept afterwards is the Tier 2 carry reserve,
/// `crate::carry_step::reserve_bytes`.
pub(crate) fn space_shortfall(bytes: u64, available: u64, total: u64) -> Option<u64> {
    let required = bytes.saturating_add(crate::carry_step::reserve_bytes(total));
    (required > available).then_some(required)
}

/// Bytes of the regular files under `root`, which a backup copies to `data/`.
pub(crate) fn tree_bytes(root: &Path) -> Result<u64> {
    let mut total = 0_u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

/// Hold an explicit or removal backup that the library volume can't hold:
/// its unknown files plus `data_bytes` of saves and settings.
pub(crate) fn require_space(
    volume: &Path,
    files: &[UnknownRuntimeFile],
    data_bytes: u64,
) -> Result<()> {
    if files.is_empty() && data_bytes == 0 {
        return Ok(());
    }
    let bytes = files
        .iter()
        .fold(data_bytes, |total, file| total.saturating_add(file.size));
    let available = fs4::available_space(volume)?;
    let total = fs4::total_space(volume)?;
    match space_shortfall(bytes, available, total) {
        None => Ok(()),
        Some(required) => Err(PortcoveError::conflict(
            "There isn't enough free space to back up this game's files first. This operation stopped and every file stayed in place. Free up space on the drive that holds your Portcove library, then try again.",
        )
        .detail("unknown_file_count", files.len().to_string())
        .detail("backup_bytes", bytes.to_string())
        .detail("required_bytes", required.to_string())
        .detail("available_bytes", available.to_string())),
    }
}

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
    /// Files the area keeps, counting each installation's copy.
    pub(super) file_count: u64,
    /// Bytes stored, after identical copies collapse.
    pub(super) size: u64,
    pub(super) sha256: String,
    /// Files actually stored, when identical copies collapsed (`unknown_files_v2`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) stored_file_count: Option<u64>,
}

/// The removal layout's list of every copy and the folder holding its bytes.
pub(crate) const UNKNOWN_FILES_INDEX: &str = "index.json";

/// One installation's copy of an unknown file in a removal backup. Identical
/// copies of one path are stored once, under the first installation that has
/// them, so Portcove's own carried copies need no extra space (D6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct UnknownFileCopy {
    pub(crate) install_id: String,
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    /// The installation folder under `unknown-files/` that holds these bytes,
    /// and their path there. Versions can name their top folder differently.
    pub(crate) stored_in: String,
    pub(crate) stored_path: String,
    /// The game-folder file this copy records, re-hashed after the stored
    /// copies are written. Not part of the index.
    #[serde(skip)]
    pub(crate) source: PathBuf,
}

#[derive(Debug, Serialize)]
struct UnknownFilesIndex<'a> {
    schema_version: u32,
    files: &'a [UnknownFileCopy],
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

/// The caps of automatic snapshots (past one they copy no unknown file) and
/// of the capped safety snapshot (past one it holds).
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
    Ok(Some(UnknownFilesArea {
        file_count: stats.file_count,
        size: stats.size,
        sha256: hex::encode(stats.hasher.finalize()),
        stored_file_count: None,
    }))
}

/// Collapse identical copies of one file across installations. `key` is the
/// path the copies share, relative to each version's persistence root, which
/// is how Tier 2 carries them. Only same-key, same-size copies are hashed.
pub(crate) fn deduplicate(
    files: Vec<(UnknownRuntimeFile, String)>,
) -> Result<UnknownFileSelection> {
    let mut groups = BTreeMap::<(&str, u64), usize>::new();
    for (file, key) in &files {
        *groups.entry((key.as_str(), file.size)).or_default() += 1;
    }
    let mut digests = Vec::with_capacity(files.len());
    for (file, key) in &files {
        digests.push(if groups[&(key.as_str(), file.size)] > 1 {
            Some(crate::service::sha256_file(
                &crate::install::manifest_member(&file.install_root, &file.relative)?,
            )?)
        } else {
            None
        });
    }
    drop(groups);
    let mut first = BTreeMap::<(String, String), (String, String)>::new();
    let mut stored = Vec::new();
    let mut duplicates = Vec::new();
    for ((file, key), digest) in files.into_iter().zip(digests) {
        let Some(digest) = digest else {
            stored.push(file);
            continue;
        };
        match first.get(&(key.clone(), digest.clone())) {
            Some((stored_in, stored_path)) => duplicates.push(UnknownFileCopy {
                source: crate::install::manifest_member(&file.install_root, &file.relative)?,
                install_id: file.install_id,
                path: file.relative,
                size: file.size,
                sha256: digest,
                stored_in: stored_in.clone(),
                stored_path: stored_path.clone(),
            }),
            None => {
                first.insert(
                    (key, digest),
                    (file.install_id.clone(), file.relative.clone()),
                );
                stored.push(file);
            }
        }
    }
    Ok(UnknownFileSelection {
        files: stored,
        duplicates,
        left_in_place: 0,
    })
}

/// Copy a removal backup's unknown files once per distinct copy and write
/// the index of every installation's copy (`unknown_files_v2`).
pub(super) fn copy_removal_area(
    staging: &Path,
    files: &[UnknownRuntimeFile],
    duplicates: &[UnknownFileCopy],
) -> Result<Option<UnknownFilesArea>> {
    let Some(mut area) = copy_area(staging, files)? else {
        return if duplicates.is_empty() {
            Ok(None)
        } else {
            Err(PortcoveError::state(
                "collapsed unknown files have no stored copy",
            ))
        };
    };
    let root = staging.join(UNKNOWN_FILES_DIRECTORY);
    let expected = duplicates
        .iter()
        .map(|copy| {
            (
                (copy.stored_in.as_str(), copy.stored_path.as_str()),
                copy.sha256.as_str(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut index = Vec::with_capacity(files.len() + duplicates.len());
    for file in files {
        // Hash the stored copy, so the index describes exactly what was kept.
        let sha256 = crate::service::sha256_file(&crate::install::manifest_member(
            &root.join(&file.install_id),
            &file.relative,
        )?)?;
        if expected
            .get(&(file.install_id.as_str(), file.relative.as_str()))
            .is_some_and(|digest| *digest != sha256)
        {
            return Err(PortcoveError::conflict(
                "An unrecognized file in the game folder changed while Portcove was backing it up. Nothing was changed; try again.",
            )
            .detail("path", &file.relative));
        }
        index.push(UnknownFileCopy {
            install_id: file.install_id.clone(),
            path: file.relative.clone(),
            size: file.size,
            sha256,
            stored_in: file.install_id.clone(),
            stored_path: file.relative.clone(),
            source: PathBuf::new(),
        });
    }
    let stored = index.len() as u64;
    if duplicates.iter().any(|copy| {
        !index
            .iter()
            .any(|kept| kept.install_id == copy.stored_in && kept.path == copy.stored_path)
    }) {
        return Err(PortcoveError::state(
            "a collapsed unknown file has no stored copy",
        ));
    }
    // A collapsed copy's bytes live only in its stored copy, so it must not
    // have changed since it was hashed: removal deletes it next.
    for copy in duplicates {
        let metadata = fs::symlink_metadata(&copy.source)?;
        if !metadata.is_file()
            || metadata.len() != copy.size
            || crate::service::sha256_file(&copy.source)? != copy.sha256
        {
            return Err(PortcoveError::conflict(
                "An unrecognized file in the game folder changed while Portcove was backing it up. Nothing was changed; try again.",
            )
            .detail("path", &copy.path));
        }
    }
    index.extend(duplicates.iter().cloned());
    index.sort_by(|left, right| {
        (&left.install_id, &left.path).cmp(&(&right.install_id, &right.path))
    });
    let mut bytes = serde_json::to_vec_pretty(&UnknownFilesIndex {
        schema_version: 2,
        files: &index,
    })?;
    bytes.push(b'\n');
    let path = root.join(UNKNOWN_FILES_INDEX);
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    output.write_all(&bytes)?;
    output.sync_all()?;
    let mut hasher = Sha256::new();
    hasher.update(b"unknown_files_v2\0");
    hasher.update(area.sha256.as_bytes());
    hasher.update(b"\0index\0");
    hasher.update(&bytes);
    area.sha256 = hex::encode(hasher.finalize());
    area.file_count = index.len() as u64;
    area.stored_file_count = Some(stored);
    Ok(Some(area))
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
        if scope == UnknownFileScope::Removal {
            return deduplicate(self.removal_unknown_files(&installs)?);
        }
        let mut files = Vec::new();
        for install in &installs {
            files.extend(self.portable_runtime_unknown_files(install)?);
        }
        if scope == UnknownFileScope::CappedSafety {
            require_within_caps(&files)?;
        }
        if scope == UnknownFileScope::Automatic && require_within_caps(&files).is_err() {
            return Ok(UnknownFileSelection {
                left_in_place: files.len() as u64,
                files: Vec::new(),
                duplicates: Vec::new(),
            });
        }
        Ok(UnknownFileSelection {
            files,
            duplicates: Vec::new(),
            left_in_place: 0,
        })
    }
}

impl PortcoveService {
    /// Every version's unknown files, each with the path it shares with other
    /// versions: relative to its persistence root, or a key unique to the
    /// installation when it lies outside that root.
    pub(crate) fn removal_unknown_files(
        &self,
        installs: &[InstallRecord],
    ) -> Result<Vec<(UnknownRuntimeFile, String)>> {
        let mut keyed = Vec::new();
        for install in installs {
            let files = self.portable_runtime_unknown_files(install)?;
            if files.is_empty() {
                continue;
            }
            // The selected executable, as verification uses; a version whose
            // root can't be read keeps its own keys and never collapses.
            let root = self
                .installed_mutability_qualification(install)
                .ok()
                .and_then(|qualification| {
                    qualification
                        .persistence_root(
                            &install.path,
                            &install.path.join(&install.selected_executable),
                        )
                        .strip_prefix(&install.path)
                        .ok()
                        .map(Path::to_path_buf)
                })
                .map(|root| {
                    root.components()
                        .map(|part| part.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/")
                });
            for file in files {
                let shared = match root.as_deref() {
                    Some("") => Some(file.relative.clone()),
                    Some(root) => file
                        .relative
                        .strip_prefix(root)
                        .and_then(|rest| rest.strip_prefix('/'))
                        .map(str::to_owned),
                    None => None,
                };
                let key = shared.map_or_else(
                    || format!("\0{}\0{}", install.id, file.relative),
                    |shared| format!("/{shared}"),
                );
                keyed.push((file, key));
            }
        }
        Ok(keyed)
    }
}

/// Which versions' unknown files a backup copies, and what a cap does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnknownFileScope {
    /// A backup the player asked for: the active version; every file, if
    /// there is space.
    Explicit,
    /// A safety snapshot whose operation sized its capacity review for the
    /// caps (legacy Ghostship recovery): the active version; past a cap, hold.
    CappedSafety,
    /// A safety snapshot before a version change, restore or import, which
    /// deletes no unknown file: the active version; past a cap, copy none.
    Automatic,
    /// The safety backup before removal: every version; every file, if there
    /// is space.
    Removal,
}

/// The unknown files a backup copies, and how many it left in place.
#[derive(Debug, Default)]
pub(crate) struct UnknownFileSelection {
    /// The files stored, one per distinct copy in a removal backup.
    pub(crate) files: Vec<UnknownRuntimeFile>,
    /// Removal only: copies identical to a stored one, kept in the index.
    pub(crate) duplicates: Vec<UnknownFileCopy>,
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

    fn keyed(files: Vec<UnknownRuntimeFile>) -> Vec<(UnknownRuntimeFile, String)> {
        files
            .into_iter()
            .map(|file| {
                let key = format!("/{}", file.relative);
                (file, key)
            })
            .collect()
    }

    fn installation(root: &Path, id: &str, files: &[(&str, &[u8])]) -> Vec<UnknownRuntimeFile> {
        let install_root = root.join(id);
        files
            .iter()
            .map(|(relative, bytes)| {
                let path = install_root.join(relative);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, bytes).unwrap();
                UnknownRuntimeFile {
                    install_id: id.into(),
                    install_root: install_root.clone(),
                    relative: (*relative).into(),
                    size: bytes.len() as u64,
                }
            })
            .collect()
    }

    #[test]
    fn removal_stores_identical_copies_once_and_indexes_every_copy() {
        let temporary = tempfile::tempdir().unwrap();
        let mut files = installation(
            temporary.path(),
            "install-a",
            &[("settings.ini", b"lives=9"), ("log.txt", b"first")],
        );
        files.extend(installation(
            temporary.path(),
            "install-b",
            &[
                ("settings.ini", b"lives=9"),
                ("log.txt", b"other"),
                ("new.ini", b"x"),
            ],
        ));
        let selection = deduplicate(keyed(files)).unwrap();
        let stored = selection
            .files
            .iter()
            .map(|file| (file.install_id.as_str(), file.relative.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            stored,
            [
                ("install-a", "settings.ini"),
                ("install-a", "log.txt"),
                ("install-b", "log.txt"),
                ("install-b", "new.ini"),
            ]
        );
        assert_eq!(selection.duplicates.len(), 1);
        let duplicate = &selection.duplicates[0];
        assert_eq!(
            (
                duplicate.install_id.as_str(),
                duplicate.path.as_str(),
                duplicate.stored_in.as_str()
            ),
            ("install-b", "settings.ini", "install-a")
        );

        let stage = temporary.path().join("stage");
        fs::create_dir(&stage).unwrap();
        let area = copy_removal_area(&stage, &selection.files, &selection.duplicates)
            .unwrap()
            .unwrap();
        assert_eq!((area.file_count, area.stored_file_count), (5, Some(4)));
        assert_eq!(area.size, 7 + 5 + 5 + 1);
        let root = stage.join(UNKNOWN_FILES_DIRECTORY);
        assert!(!root.join("install-b/settings.ini").exists());
        assert_eq!(fs::read(root.join("install-b/log.txt")).unwrap(), b"other");
        let index: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(UNKNOWN_FILES_INDEX)).unwrap()).unwrap();
        assert_eq!(index["schema_version"], 2);
        let listed = index["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|copy| {
                (
                    copy["install_id"].as_str().unwrap(),
                    copy["path"].as_str().unwrap(),
                    copy["stored_in"].as_str().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            listed,
            [
                ("install-a", "log.txt", "install-a"),
                ("install-a", "settings.ini", "install-a"),
                ("install-b", "log.txt", "install-b"),
                ("install-b", "new.ini", "install-b"),
                ("install-b", "settings.ini", "install-a"),
            ]
        );
        assert_eq!(
            index["files"][1]["sha256"], index["files"][4]["sha256"],
            "the collapsed copy names the stored bytes"
        );
    }

    #[test]
    fn removal_collapses_copies_past_the_snapshot_caps() {
        let temporary = tempfile::tempdir().unwrap();
        let names = (0..MAX_UNKNOWN_FILES)
            .map(|index| format!("file-{index}.ini"))
            .collect::<Vec<_>>();
        let entries = names
            .iter()
            .map(|name| (name.as_str(), b"same".as_slice()))
            .collect::<Vec<_>>();
        let mut files = installation(temporary.path(), "install-a", &entries);
        files.extend(installation(temporary.path(), "install-b", &entries));
        // Twice the snapshot's count cap in copies; removal has no cap and
        // stores each identical copy once.
        assert!(require_within_caps(&files).is_err());
        let selection = deduplicate(keyed(files.clone())).unwrap();
        assert_eq!(selection.files.len(), MAX_UNKNOWN_FILES);
        assert_eq!(selection.duplicates.len(), MAX_UNKNOWN_FILES);
        fs::write(temporary.path().join("install-b/file-0.ini"), b"diff").unwrap();
        let selection = deduplicate(keyed(files)).unwrap();
        assert_eq!(selection.files.len(), MAX_UNKNOWN_FILES + 1);
    }

    #[test]
    fn space_check_keeps_the_larger_reserve_free() {
        let gib = 1024 * 1024 * 1024;
        // A 10 GiB volume keeps 1 GiB free; a 300 GiB volume keeps its 2% (6 GiB).
        assert_eq!(space_shortfall(gib, 2 * gib, 10 * gib), None);
        assert_eq!(
            space_shortfall(gib + 1, 2 * gib, 10 * gib),
            Some(2 * gib + 1)
        );
        assert_eq!(space_shortfall(gib, 7 * gib, 300 * gib), None);
        assert_eq!(space_shortfall(gib, 6 * gib, 300 * gib), Some(7 * gib));
        assert_eq!(space_shortfall(u64::MAX, u64::MAX - 1, 0), Some(u64::MAX));
        // The reserve stops growing at 8 GiB: a small backup fits on a 10 TiB
        // volume with 9 GiB free, which the uncapped 2% (205 GiB) refused.
        assert_eq!(space_shortfall(gib, 9 * gib, 10 * 1024 * gib), None);
        assert_eq!(
            space_shortfall(gib, 8 * gib, 10 * 1024 * gib),
            Some(9 * gib)
        );
        let temporary = tempfile::tempdir().unwrap();
        let mut huge = installation(temporary.path(), "install-a", &[("replay.dat", b"x")]);
        require_space(temporary.path(), &huge, 0).unwrap();
        require_space(temporary.path(), &[], 0).unwrap();
        huge[0].size = u64::MAX / 2;
        let error = require_space(temporary.path(), &huge, 0).unwrap_err();
        // Saves count too: no unknown file, but more data than the volume holds.
        assert!(require_space(temporary.path(), &[], u64::MAX / 2).is_err());
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("every file stayed in place"));
        assert!(error.details.contains_key("required_bytes"));
    }

    #[test]
    fn removal_holds_when_a_collapsed_copy_changed_before_storing() {
        let temporary = tempfile::tempdir().unwrap();
        let mut files = installation(
            temporary.path(),
            "install-a",
            &[("settings.ini", b"lives=9")],
        );
        files.extend(installation(
            temporary.path(),
            "install-b",
            &[("settings.ini", b"lives=9")],
        ));
        let selection = deduplicate(keyed(files)).unwrap();
        fs::write(temporary.path().join("install-a/settings.ini"), b"lives=1").unwrap();
        let stage = temporary.path().join("stage");
        fs::create_dir(&stage).unwrap();
        let error = copy_removal_area(&stage, &selection.files, &selection.duplicates).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        // A collapsed copy changed after hashing: removal would delete bytes
        // the backup doesn't hold, so it holds (review M1).
        fs::write(temporary.path().join("install-a/settings.ini"), b"lives=9").unwrap();
        let selection = deduplicate(keyed(
            installation(
                temporary.path(),
                "install-a",
                &[("settings.ini", b"lives=9")],
            )
            .into_iter()
            .chain(installation(
                temporary.path(),
                "install-b",
                &[("settings.ini", b"lives=9")],
            ))
            .collect(),
        ))
        .unwrap();
        assert_eq!(selection.duplicates.len(), 1);
        fs::write(temporary.path().join("install-b/settings.ini"), b"lives=2").unwrap();
        let again = temporary.path().join("stage-again");
        fs::create_dir(&again).unwrap();
        let error = copy_removal_area(&again, &selection.files, &selection.duplicates).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(error.details["path"], "settings.ini");
    }
}
