use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use flate2::read::GzDecoder;

use crate::{PortcoveError, Result};

const MAX_COMPRESSED_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_PATH_DEPTH: usize = 32;
const MAX_PATH_BYTES: usize = 1024;
const MAX_COMPONENT_BYTES: usize = 255;
const MAX_COMPRESSION_RATIO: u64 = 200;

#[derive(Debug, Clone)]
struct EntryPlan {
    relative: PathBuf,
    directory: bool,
    size: u64,
}

#[derive(Default)]
struct CollisionSet {
    entries: BTreeMap<String, bool>,
}

impl CollisionSet {
    fn insert(&mut self, key: String, directory: bool) -> Result<()> {
        if self.entries.contains_key(&key) {
            return Err(PortcoveError::verification(format!(
                "archive contains duplicate or platform-colliding path: {key}"
            )));
        }
        let mut ancestor = key.as_str();
        while let Some(index) = ancestor.rfind('/') {
            ancestor = &ancestor[..index];
            if self
                .entries
                .get(ancestor)
                .is_some_and(|is_directory| !*is_directory)
            {
                return Err(PortcoveError::verification(format!(
                    "archive path descends through a file: {key}"
                )));
            }
        }
        if !directory {
            let prefix = format!("{key}/");
            if self
                .entries
                .keys()
                .any(|existing| existing.starts_with(&prefix))
            {
                return Err(PortcoveError::verification(format!(
                    "archive file collides with a directory: {key}"
                )));
            }
        }
        self.entries.insert(key, directory);
        Ok(())
    }
}

pub(crate) fn extract_archive(
    source: &Path,
    destination: &Path,
    asset_name: &str,
    expected_compressed_size: u64,
) -> Result<()> {
    let compressed_size = validate_compressed_size(source, expected_compressed_size)?;
    let lower = asset_name.to_ascii_lowercase();
    if lower.ends_with(".zip") {
        extract_zip(source, destination, compressed_size)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        extract_tar_gz(source, destination, compressed_size)
    } else {
        Err(PortcoveError::unsupported(format!(
            "unsupported archive format: {asset_name}"
        )))
    }
}

pub(crate) fn validate_download_size(actual: u64, expected: u64) -> Result<()> {
    validate_download_progress(actual, expected)?;
    if expected > 0 && actual != expected {
        return Err(
            PortcoveError::verification("download size does not match release metadata")
                .detail("expected", expected.to_string())
                .detail("actual", actual.to_string()),
        );
    }
    Ok(())
}

pub(crate) fn validate_download_progress(actual: u64, expected: u64) -> Result<()> {
    if expected > MAX_COMPRESSED_BYTES || actual > MAX_COMPRESSED_BYTES {
        return Err(
            PortcoveError::verification("download exceeds the global artifact size limit")
                .detail("limit", MAX_COMPRESSED_BYTES.to_string())
                .detail("expected", expected.to_string())
                .detail("actual", actual.to_string()),
        );
    }
    if expected > 0 && actual > expected {
        return Err(
            PortcoveError::verification("download exceeded its declared release size")
                .detail("expected", expected.to_string())
                .detail("actual", actual.to_string()),
        );
    }
    Ok(())
}

fn validate_compressed_size(source: &Path, expected: u64) -> Result<u64> {
    let actual = fs::metadata(source)?.len();
    validate_download_size(actual, expected)?;
    Ok(actual)
}

fn validate_plan(destination: &Path, plans: &[EntryPlan], compressed_size: u64) -> Result<()> {
    if plans.len() > MAX_ENTRIES {
        return Err(PortcoveError::verification(
            "archive contains too many entries",
        ));
    }
    let total = plans.iter().try_fold(0_u64, |total, plan| {
        if plan.size > MAX_ENTRY_BYTES {
            return Err(PortcoveError::verification(format!(
                "archive entry exceeds its size limit: {}",
                plan.relative.display()
            )));
        }
        total
            .checked_add(plan.size)
            .ok_or_else(|| PortcoveError::verification("archive expanded size overflowed"))
    })?;
    if total > MAX_EXPANDED_BYTES {
        return Err(PortcoveError::verification(
            "archive exceeds the total expanded size limit",
        ));
    }
    if compressed_size > 0 && total > compressed_size.saturating_mul(MAX_COMPRESSION_RATIO) {
        return Err(PortcoveError::verification(
            "archive exceeds the maximum compression ratio",
        ));
    }
    let available = fs2::available_space(destination)?;
    if total > available {
        return Err(
            PortcoveError::state("archive cannot fit in the available destination space")
                .detail("required", total.to_string())
                .detail("available", available.to_string()),
        );
    }
    Ok(())
}

pub(crate) fn validate_relative_path(name: &str, directory: bool) -> Result<(PathBuf, String)> {
    if !name.is_ascii() {
        return Err(PortcoveError::verification(
            "archive paths must be ASCII to avoid cross-platform Unicode aliases",
        ));
    }
    if name.contains('\\') {
        return Err(PortcoveError::verification(
            "archive paths must use forward-slash separators",
        ));
    }
    let canonical = if directory {
        name.trim_end_matches('/')
    } else {
        name
    };
    if canonical.is_empty() || canonical.len() > MAX_PATH_BYTES {
        return Err(PortcoveError::verification(
            "archive contains an empty or overlong path",
        ));
    }
    let components = canonical.split('/').collect::<Vec<_>>();
    if components.len() > MAX_PATH_DEPTH {
        return Err(PortcoveError::verification(
            "archive path exceeds the maximum depth",
        ));
    }
    for component in &components {
        validate_component(component)?;
    }
    let key = components
        .iter()
        .map(|component| component.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("/");
    Ok((PathBuf::from(canonical), key))
}

fn validate_component(component: &str) -> Result<()> {
    if component.is_empty()
        || matches!(component, "." | "..")
        || component.len() > MAX_COMPONENT_BYTES
        || component.ends_with(['.', ' '])
        || component.bytes().any(|byte| {
            byte < 0x20 || matches!(byte, b':' | b'"' | b'<' | b'>' | b'|' | b'?' | b'*')
        })
    {
        return Err(PortcoveError::verification(format!(
            "archive contains an unsafe path component: {component}"
        )));
    }
    let stem = component
        .split_once('.')
        .map_or(component, |(stem, _)| stem)
        .to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || stem
            .strip_prefix("com")
            .or_else(|| stem.strip_prefix("lpt"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'));
    if reserved {
        return Err(PortcoveError::verification(format!(
            "archive contains a reserved device path: {component}"
        )));
    }
    Ok(())
}

fn extract_zip(source: &Path, destination: &Path, compressed_size: u64) -> Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(source)?)
        .map_err(|error| PortcoveError::verification(format!("invalid ZIP: {error}")))?;
    if archive.len() > MAX_ENTRIES {
        return Err(PortcoveError::verification(
            "archive contains too many entries",
        ));
    }
    let mut collisions = CollisionSet::default();
    let mut plans = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| PortcoveError::verification(format!("invalid ZIP entry: {error}")))?;
        if !entry.is_file() && !entry.is_dir() {
            return Err(PortcoveError::verification(
                "ZIP contains an unsupported entry type",
            ));
        }
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if kind != 0 && kind != 0o100000 && kind != 0o040000 {
                return Err(PortcoveError::verification(
                    "ZIP links and special files are not allowed",
                ));
            }
        }
        // Some Windows ZIP producers write DOS separators. Resolve that spelling once,
        // before portable validation and collision detection, on every host platform.
        // Catalog paths and TAR entries retain their stricter forward-slash contract.
        let portable_name = entry.name().replace('\\', "/");
        let (relative, key) = validate_relative_path(&portable_name, entry.is_dir())?;
        collisions.insert(key, entry.is_dir())?;
        plans.push(EntryPlan {
            relative,
            directory: entry.is_dir(),
            size: entry.size(),
        });
    }
    validate_plan(destination, &plans, compressed_size)?;
    drop(archive);

    let mut archive = zip::ZipArchive::new(File::open(source)?)
        .map_err(|error| PortcoveError::verification(format!("invalid ZIP: {error}")))?;
    for (index, plan) in plans.iter().enumerate() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| PortcoveError::verification(format!("invalid ZIP entry: {error}")))?;
        write_entry(destination, plan, &mut entry)?;
    }
    Ok(())
}

fn extract_tar_gz(source: &Path, destination: &Path, compressed_size: u64) -> Result<()> {
    let mut archive = tar::Archive::new(GzDecoder::new(File::open(source)?));
    let mut collisions = CollisionSet::default();
    let mut plans = Vec::new();
    for entry in archive
        .entries()
        .map_err(|error| PortcoveError::verification(format!("invalid TAR: {error}")))?
    {
        let entry = entry
            .map_err(|error| PortcoveError::verification(format!("invalid TAR entry: {error}")))?;
        if plans.len() == MAX_ENTRIES {
            return Err(PortcoveError::verification(
                "archive contains too many entries",
            ));
        }
        let directory = entry.header().entry_type().is_dir();
        if !directory && !entry.header().entry_type().is_file() {
            return Err(PortcoveError::verification(
                "TAR links and special files are not allowed",
            ));
        }
        let path = entry
            .path()
            .map_err(|error| PortcoveError::verification(format!("invalid TAR path: {error}")))?;
        let name = path
            .to_str()
            .ok_or_else(|| PortcoveError::verification("TAR contains a non-Unicode path"))?;
        let (relative, key) = validate_relative_path(name, directory)?;
        collisions.insert(key, directory)?;
        plans.push(EntryPlan {
            relative,
            directory,
            size: entry.size(),
        });
    }
    validate_plan(destination, &plans, compressed_size)?;

    let mut archive = tar::Archive::new(GzDecoder::new(File::open(source)?));
    for (entry, plan) in archive
        .entries()
        .map_err(|error| PortcoveError::verification(format!("invalid TAR: {error}")))?
        .zip(plans.iter())
    {
        let mut entry = entry
            .map_err(|error| PortcoveError::verification(format!("invalid TAR entry: {error}")))?;
        write_entry(destination, plan, &mut entry)?;
    }
    Ok(())
}

fn write_entry(destination: &Path, plan: &EntryPlan, reader: &mut impl Read) -> Result<()> {
    let output = destination.join(&plan.relative);
    if !output.starts_with(destination) {
        return Err(PortcoveError::verification(
            "archive output escaped its destination",
        ));
    }
    if plan.directory {
        fs::create_dir_all(output)?;
        return Ok(());
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?;
    let copied = std::io::copy(&mut reader.take(plan.size.saturating_add(1)), &mut target)?;
    if copied != plan.size {
        return Err(PortcoveError::verification(format!(
            "archive entry size changed while extracting: {}",
            plan.relative.display()
        )));
    }
    target.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn portable_path_policy_rejects_aliases_and_reserved_names() {
        for path in [
            "../escape",
            "CON",
            "NUL.txt",
            "name:stream",
            "trailing.",
            "trailing ",
            "unicode-\u{e9}",
            "back\\slash",
        ] {
            assert!(validate_relative_path(path, false).is_err(), "{path}");
        }

        let mut collisions = CollisionSet::default();
        let (_, first) = validate_relative_path("A/File.dll", false).unwrap();
        collisions.insert(first, false).unwrap();
        let (_, second) = validate_relative_path("a/file.DLL", false).unwrap();
        assert!(collisions.insert(second, false).is_err());

        let mut duplicates = CollisionSet::default();
        duplicates.insert("same.dll".into(), false).unwrap();
        assert!(duplicates.insert("same.dll".into(), false).is_err());
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8], Option<u32>)]) {
        let file = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        for (name, bytes, mode) in entries {
            let mut options = zip::write::SimpleFileOptions::default();
            if let Some(mode) = mode {
                options = options.unix_permissions(*mode);
            }
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn mark_first_zip_entry_as_symlink(path: &Path) {
        let mut bytes = fs::read(path).unwrap();
        let central = bytes
            .windows(4)
            .position(|window| window == b"PK\x01\x02")
            .expect("central directory entry");
        bytes[central + 4..central + 6].copy_from_slice(&0x0314_u16.to_le_bytes());
        bytes[central + 38..central + 42].copy_from_slice(&(0o120777_u32 << 16).to_le_bytes());
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn zip_preflight_rejects_traversal_links_collisions_and_aliases_before_writing() {
        let temporary = tempdir().unwrap();
        for (name, entries) in [
            ("traversal", vec![("../escape", b"x".as_slice(), None)]),
            (
                "symlink",
                vec![("link", b"target".as_slice(), Some(0o120777))],
            ),
            (
                "case-collision",
                vec![
                    ("A.dll", b"a".as_slice(), None),
                    ("a.DLL", b"b".as_slice(), None),
                ],
            ),
            ("device-con", vec![("CON", b"x".as_slice(), None)]),
            ("device", vec![("NUL.txt", b"x".as_slice(), None)]),
            ("ads", vec![("name:stream", b"x".as_slice(), None)]),
            ("trailing", vec![("name.", b"x".as_slice(), None)]),
        ] {
            let source = temporary.path().join(format!("{name}.zip"));
            let destination = temporary.path().join(format!("out-{name}"));
            fs::create_dir_all(&destination).unwrap();
            write_zip(&source, &entries);
            if name == "symlink" {
                mark_first_zip_entry_as_symlink(&source);
            }

            assert!(
                extract_archive(
                    &source,
                    &destination,
                    "fixture.zip",
                    fs::metadata(&source).unwrap().len(),
                )
                .is_err(),
                "{name}"
            );
            assert_eq!(fs::read_dir(destination).unwrap().count(), 0, "{name}");
        }
    }

    #[test]
    fn zip_dos_separators_are_validated_and_collide_in_one_portable_namespace() {
        let temporary = tempdir().unwrap();
        let source = temporary.path().join("windows.zip");
        let destination = temporary.path().join("windows");
        fs::create_dir(&destination).unwrap();
        write_zip(&source, &[("assets\\nested\\game.dat", b"game", None)]);
        extract_archive(
            &source,
            &destination,
            "windows.zip",
            fs::metadata(&source).unwrap().len(),
        )
        .unwrap();
        assert_eq!(
            fs::read(destination.join("assets/nested/game.dat")).unwrap(),
            b"game"
        );

        for (index, names) in [
            vec!["..\\escape"],
            vec!["folder\\..\\escape"],
            vec!["\\rooted"],
            vec!["\\\\server\\share\\file"],
            vec!["C:\\drive"],
            vec!["folder\\NUL.txt"],
            vec!["folder\\file:stream"],
            vec!["folder\\trailing.\\file"],
            vec!["assets/file", "assets\\file"],
            vec!["Assets\\File", "assets/file"],
            vec!["assets", "assets\\file"],
            vec!["assets\\file", "assets"],
        ]
        .into_iter()
        .enumerate()
        {
            let source = temporary.path().join(format!("rejected-{index}.zip"));
            let destination = temporary.path().join(format!("rejected-{index}"));
            fs::create_dir(&destination).unwrap();
            let entries = names
                .iter()
                .map(|name| (*name, b"x".as_slice(), None))
                .collect::<Vec<_>>();
            write_zip(&source, &entries);
            assert!(
                extract_archive(
                    &source,
                    &destination,
                    "fixture.zip",
                    fs::metadata(&source).unwrap().len()
                )
                .is_err(),
                "{names:?}"
            );
            assert_eq!(fs::read_dir(destination).unwrap().count(), 0, "{names:?}");
        }
    }

    #[test]
    fn zip_preflight_rejects_high_ratio_and_overlong_or_deep_paths() {
        let temporary = tempdir().unwrap();
        for (name, entry_name, bytes) in [
            (
                "ratio",
                "large.bin".to_string(),
                vec![0_u8; 2 * 1024 * 1024],
            ),
            ("long", format!("{}.bin", "a".repeat(1025)), vec![1]),
            ("deep", format!("{}/file", "a/".repeat(33)), vec![1]),
        ] {
            let source = temporary.path().join(format!("{name}.zip"));
            let destination = temporary.path().join(format!("out-{name}"));
            fs::create_dir_all(&destination).unwrap();
            write_zip(&source, &[(entry_name.as_str(), bytes.as_slice(), None)]);

            assert!(
                extract_archive(
                    &source,
                    &destination,
                    "fixture.zip",
                    fs::metadata(&source).unwrap().len(),
                )
                .is_err(),
                "{name}"
            );
            assert_eq!(fs::read_dir(destination).unwrap().count(), 0, "{name}");
        }
    }

    #[test]
    fn tar_preflight_rejects_links_fifo_and_device_entries() {
        for (name, kind) in [
            ("symlink", tar::EntryType::Symlink),
            ("hardlink", tar::EntryType::Link),
            ("fifo", tar::EntryType::Fifo),
            ("block", tar::EntryType::Block),
            ("character", tar::EntryType::Char),
        ] {
            let temporary = tempdir().unwrap();
            let source = temporary.path().join(format!("{name}.tar.gz"));
            let encoder = flate2::write::GzEncoder::new(
                File::create(&source).unwrap(),
                flate2::Compression::default(),
            );
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(kind);
            header.set_size(0);
            header.set_mode(0o644);
            if matches!(kind, tar::EntryType::Symlink | tar::EntryType::Link) {
                header.set_link_name("target").unwrap();
            }
            header.set_cksum();
            builder
                .append_data(&mut header, name, Cursor::new(Vec::<u8>::new()))
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
            let destination = temporary.path().join("out");
            fs::create_dir_all(&destination).unwrap();

            assert!(
                extract_archive(
                    &source,
                    &destination,
                    "fixture.tar.gz",
                    fs::metadata(&source).unwrap().len(),
                )
                .is_err(),
                "{name}"
            );
            assert_eq!(fs::read_dir(destination).unwrap().count(), 0, "{name}");
        }
    }

    #[test]
    fn declared_and_streamed_size_limits_fail_closed() {
        let temporary = tempdir().unwrap();
        let destination = temporary.path();
        assert!(validate_download_progress(12, 11).is_err());
        assert!(validate_download_progress(0, MAX_COMPRESSED_BYTES + 1).is_err());
        assert!(validate_download_size(10, 11).is_err());
        assert!(
            validate_plan(
                destination,
                &[EntryPlan {
                    relative: "huge.bin".into(),
                    directory: false,
                    size: MAX_ENTRY_BYTES + 1,
                }],
                1,
            )
            .is_err()
        );
        let plan = EntryPlan {
            relative: "short.bin".into(),
            directory: false,
            size: 2,
        };
        assert!(write_entry(destination, &plan, &mut Cursor::new(vec![1])).is_err());
    }
}
