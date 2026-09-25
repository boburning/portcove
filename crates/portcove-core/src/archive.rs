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
const TAR_BLOCK_BYTES: u64 = 512;
const MAX_TAR_EXTENSION_BYTES: u64 = 64 * 1024;
const MAX_TAR_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TAR_RAW_HEADERS: usize = MAX_ENTRIES * 6;
const MAX_TAR_FORMAT_OVERHEAD_BYTES: u64 =
    (MAX_ENTRIES as u64) * 6 * TAR_BLOCK_BYTES + 2 * TAR_BLOCK_BYTES;
const ARCHIVE_IO_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
struct EntryPlan {
    relative: PathBuf,
    directory: bool,
    executable: bool,
    size: u64,
}

#[derive(Default)]
struct CollisionSet {
    entries: BTreeMap<String, bool>,
    #[cfg(test)]
    descendant_candidates_checked: usize,
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
            // Only the first key at or after the prefix can be a descendant.
            let next = self.entries.range(prefix.clone()..).next();
            #[cfg(test)]
            {
                self.descendant_candidates_checked += usize::from(next.is_some());
            }
            if next.is_some_and(|(existing, _)| existing.starts_with(&prefix)) {
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
    extract_archive_with_checkpoint(
        source,
        destination,
        asset_name,
        expected_compressed_size,
        &|| Ok(()),
    )
}

pub(crate) fn extract_archive_with_checkpoint(
    source: &Path,
    destination: &Path,
    asset_name: &str,
    expected_compressed_size: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    let compressed_size = validate_compressed_size(source, expected_compressed_size)?;
    let lower = asset_name.to_ascii_lowercase();
    if lower.ends_with(".zip") {
        extract_zip(source, destination, compressed_size, checkpoint)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        extract_tar_gz(source, destination, compressed_size, checkpoint)
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
    let mut total = 0_u64;
    for plan in plans {
        validate_declared_entry(&plan.relative, plan.size, &mut total, compressed_size)?;
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

fn validate_declared_entry(
    relative: &Path,
    size: u64,
    expanded_size: &mut u64,
    compressed_size: u64,
) -> Result<()> {
    if size > MAX_ENTRY_BYTES {
        return Err(PortcoveError::verification(format!(
            "archive entry exceeds its size limit: {}",
            relative.display()
        )));
    }
    *expanded_size = expanded_size
        .checked_add(size)
        .ok_or_else(|| PortcoveError::verification("archive expanded size overflowed"))?;
    if *expanded_size > MAX_EXPANDED_BYTES {
        return Err(PortcoveError::verification(
            "archive exceeds the total expanded size limit",
        ));
    }
    if compressed_size > 0 && *expanded_size > compressed_size.saturating_mul(MAX_COMPRESSION_RATIO)
    {
        return Err(PortcoveError::verification(
            "archive exceeds the maximum compression ratio",
        ));
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

fn extract_zip(
    source: &Path,
    destination: &Path,
    compressed_size: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
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
        checkpoint()?;
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
            executable: crate::permissions::archive_executable(entry.unix_mode()),
            size: entry.size(),
        });
    }
    validate_plan(destination, &plans, compressed_size)?;
    drop(archive);

    let mut archive = zip::ZipArchive::new(File::open(source)?)
        .map_err(|error| PortcoveError::verification(format!("invalid ZIP: {error}")))?;
    for (index, plan) in plans.iter().enumerate() {
        checkpoint()?;
        let mut entry = archive
            .by_index(index)
            .map_err(|error| PortcoveError::verification(format!("invalid ZIP entry: {error}")))?;
        write_entry(destination, plan, &mut entry, checkpoint)?;
    }
    Ok(())
}

fn extract_tar_gz(
    source: &Path,
    destination: &Path,
    compressed_size: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let decoded_limit = MAX_EXPANDED_BYTES
        .checked_add(MAX_TAR_FORMAT_OVERHEAD_BYTES)
        .expect("archive limits fit in u64");
    let reader = CheckpointReader::new(
        GzDecoder::new(File::open(source)?),
        decoded_limit,
        checkpoint,
    );
    preflight_raw_tar(reader, compressed_size, checkpoint)?;

    checkpoint()?;
    let reader = CheckpointReader::new(
        GzDecoder::new(File::open(source)?),
        decoded_limit,
        checkpoint,
    );
    let mut archive = tar::Archive::new(reader);
    let mut collisions = CollisionSet::default();
    let mut plans = Vec::new();
    let mut expanded_size = 0_u64;
    for entry in archive
        .entries()
        .map_err(|error| map_tar_error("invalid TAR", error, checkpoint))?
    {
        checkpoint()?;
        let entry = entry.map_err(|error| map_tar_error("invalid TAR entry", error, checkpoint))?;
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
        let size = entry.size();
        validate_declared_entry(&relative, size, &mut expanded_size, compressed_size)?;
        plans.push(EntryPlan {
            relative,
            directory,
            executable: crate::permissions::archive_executable(Some(
                entry.header().mode().map_err(|error| {
                    PortcoveError::verification(format!("invalid TAR mode: {error}"))
                })?,
            )),
            size,
        });
    }
    validate_plan(destination, &plans, compressed_size)?;

    checkpoint()?;
    let reader = CheckpointReader::new(
        GzDecoder::new(File::open(source)?),
        decoded_limit,
        checkpoint,
    );
    let mut archive = tar::Archive::new(reader);
    for (entry, plan) in archive
        .entries()
        .map_err(|error| map_tar_error("invalid TAR", error, checkpoint))?
        .zip(plans.iter())
    {
        checkpoint()?;
        let mut entry =
            entry.map_err(|error| map_tar_error("invalid TAR entry", error, checkpoint))?;
        write_entry(destination, plan, &mut entry, checkpoint)?;
    }
    Ok(())
}

fn preflight_raw_tar(
    reader: impl Read,
    compressed_size: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let mut archive = tar::Archive::new(reader);
    let mut raw_headers = 0_usize;
    let mut metadata_bytes = 0_u64;
    let mut expanded_size = 0_u64;
    for entry in archive
        .entries()
        .map_err(|error| map_tar_error("invalid TAR", error, checkpoint))?
        .raw(true)
    {
        checkpoint()?;
        let entry = entry.map_err(|error| map_tar_error("invalid TAR entry", error, checkpoint))?;
        raw_headers += 1;
        if raw_headers > MAX_TAR_RAW_HEADERS {
            return Err(PortcoveError::verification(
                "TAR contains too many raw headers",
            ));
        }
        let kind = entry.header().entry_type();
        let size = entry.size();
        if kind.is_gnu_longlink() {
            return Err(PortcoveError::verification(
                "TAR links and special files are not allowed",
            ));
        }
        if kind.is_gnu_longname()
            || kind.is_pax_local_extensions()
            || kind.is_pax_global_extensions()
        {
            if size > MAX_TAR_EXTENSION_BYTES {
                return Err(PortcoveError::verification(
                    "TAR extension metadata exceeds its size limit",
                ));
            }
            metadata_bytes = metadata_bytes.checked_add(size).ok_or_else(|| {
                PortcoveError::verification("TAR extension metadata size overflowed")
            })?;
            if metadata_bytes > MAX_TAR_METADATA_BYTES {
                return Err(PortcoveError::verification(
                    "TAR extension metadata exceeds the total size limit",
                ));
            }
            continue;
        }
        if kind.is_dir() {
            if size != 0 {
                return Err(PortcoveError::verification(
                    "TAR directory entries must not contain data",
                ));
            }
            continue;
        }
        if !kind.is_file() {
            return Err(PortcoveError::verification(
                "TAR links and special files are not allowed",
            ));
        }
        validate_declared_entry(
            Path::new("<raw TAR entry>"),
            size,
            &mut expanded_size,
            compressed_size,
        )?;
    }
    Ok(())
}

fn map_tar_error(
    context: &str,
    error: impl std::fmt::Display,
    checkpoint: &dyn Fn() -> Result<()>,
) -> PortcoveError {
    checkpoint()
        .err()
        .unwrap_or_else(|| PortcoveError::verification(format!("{context}: {error}")))
}

struct CheckpointReader<'a, R> {
    inner: R,
    decoded: u64,
    decoded_limit: u64,
    checkpoint: &'a dyn Fn() -> Result<()>,
}

impl<'a, R> CheckpointReader<'a, R> {
    fn new(inner: R, decoded_limit: u64, checkpoint: &'a dyn Fn() -> Result<()>) -> Self {
        Self {
            inner,
            decoded: 0,
            decoded_limit,
            checkpoint,
        }
    }
}

impl<R: Read> Read for CheckpointReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        (self.checkpoint)().map_err(|error| std::io::Error::other(error.message))?;
        let remaining = self.decoded_limit.saturating_sub(self.decoded);
        if remaining == 0 {
            let mut probe = [0_u8; 1];
            return match self.inner.read(&mut probe)? {
                0 => Ok(0),
                _ => Err(std::io::Error::other(
                    "decoded TAR data exceeds the metadata-aware work limit",
                )),
            };
        }
        let read_limit = buffer
            .len()
            .min(ARCHIVE_IO_CHUNK_BYTES)
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        let read = self.inner.read(&mut buffer[..read_limit])?;
        self.decoded = self.decoded.saturating_add(read as u64);
        Ok(read)
    }
}

fn write_entry(
    destination: &Path,
    plan: &EntryPlan,
    reader: &mut impl Read,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    let output = destination.join(&plan.relative);
    if !output.starts_with(destination) {
        return Err(PortcoveError::verification(
            "archive output escaped its destination",
        ));
    }
    if plan.directory {
        fs::create_dir_all(&output)?;
        normalize_archive_directories(destination, &output)?;
        return Ok(());
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
        normalize_archive_directories(destination, parent)?;
    }
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?;
    let mut reader = reader.take(plan.size.saturating_add(1));
    let mut buffer = [0_u8; ARCHIVE_IO_CHUNK_BYTES];
    let mut copied = 0_u64;
    loop {
        checkpoint()?;
        let read = match reader.read(&mut buffer) {
            Ok(read) => read,
            Err(error) => {
                checkpoint()?;
                return Err(error.into());
            }
        };
        if read == 0 {
            break;
        }
        target.write_all(&buffer[..read])?;
        copied = copied.saturating_add(read as u64);
        checkpoint()?;
    }
    if copied != plan.size {
        return Err(PortcoveError::verification(format!(
            "archive entry size changed while extracting: {}",
            plan.relative.display()
        )));
    }
    target.flush()?;
    drop(target);
    crate::permissions::normalize_archive_entry(&output, false, plan.executable)?;
    Ok(())
}

fn normalize_archive_directories(destination: &Path, deepest: &Path) -> Result<()> {
    let mut directory = deepest;
    while directory != destination {
        if !directory.starts_with(destination) {
            return Err(PortcoveError::verification(
                "archive parent escaped its destination",
            ));
        }
        crate::permissions::normalize_archive_entry(directory, true, false)?;
        directory = directory
            .parent()
            .ok_or_else(|| PortcoveError::verification("archive parent escaped its destination"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use std::{
        cell::Cell,
        io::{Cursor, Write},
    };

    use tempfile::tempdir;

    use super::*;

    // The pre-#989 implementation is retained only as a test oracle.
    fn reference_collision_insert(
        entries: &mut BTreeMap<String, bool>,
        key: String,
        directory: bool,
    ) -> Result<()> {
        if entries.contains_key(&key) {
            return Err(PortcoveError::verification(format!(
                "archive contains duplicate or platform-colliding path: {key}"
            )));
        }
        let mut ancestor = key.as_str();
        while let Some(index) = ancestor.rfind('/') {
            ancestor = &ancestor[..index];
            if entries
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
            if entries.keys().any(|existing| existing.starts_with(&prefix)) {
                return Err(PortcoveError::verification(format!(
                    "archive file collides with a directory: {key}"
                )));
            }
        }
        entries.insert(key, directory);
        Ok(())
    }

    proptest! {
        #[test]
        fn property_archive_paths_reject_traversal_and_device_aliases(
            segment in "[a-zA-Z][a-zA-Z0-9_-]{0,24}",
            suffix in "[a-zA-Z0-9]{1,8}",
            device in prop::sample::select(vec!["CON", "nul", "Aux", "COM1", "lpt9"]),
        ) {
            prop_assert!(validate_relative_path(&format!("{segment}/../{suffix}"), false).is_err(), "traversal accepted");
            prop_assert!(validate_relative_path(&format!("{segment}/{device}.{suffix}"), false).is_err(), "device alias accepted");
            prop_assert!(validate_relative_path(&format!("{segment}:{suffix}"), false).is_err(), "alternate stream accepted");
        }

        #[test]
        fn property_case_aliases_cannot_publish_two_entries(
            segment in "[a-z]{1,20}",
            filename in "[a-z]{1,20}",
        ) {
            let name = format!("dir_{segment}/file_{filename}.bin");
            let (_, first) = validate_relative_path(&name, false).unwrap();
            let (_, second) = validate_relative_path(&name.to_ascii_uppercase(), false).unwrap();
            let mut collisions = CollisionSet::default();
            prop_assert!(collisions.insert(first, false).is_ok());
            prop_assert!(collisions.insert(second, false).is_err());
        }

        #[test]
        fn ordered_collision_lookup_matches_the_previous_decisions(
            entries in prop::collection::vec((
                prop::sample::select(vec![
                    "a", "a/b", "a/b/c", "a/bc", "ab", "ab/c", "b", "b/a", "foo", "foo/bar", "foobar",
                ]),
                any::<bool>(),
            ), 0..128),
        ) {
            let mut reference = BTreeMap::new();
            let mut actual = CollisionSet::default();
            for (key, directory) in entries {
                let expected = reference_collision_insert(&mut reference, key.into(), directory);
                let observed = actual.insert(key.into(), directory);
                prop_assert_eq!(
                    observed.as_ref().err().map(|error| error.message.as_str()),
                    expected.as_ref().err().map(|error| error.message.as_str()),
                );
                prop_assert_eq!(&actual.entries, &reference);
            }
        }
    }

    #[test]
    fn archive_collision_edges_keep_both_orders_and_prefix_neighbors() {
        for (first, first_dir, second, second_dir, rejected) in [
            ("foo", false, "foo/bar", false, true),
            ("foo/bar", false, "foo", false, true),
            ("foo", true, "foo/bar", false, false),
            ("foo/bar", false, "foo", true, false),
            ("foo", false, "foobar/bar", false, false),
            ("foobar/bar", false, "foo", false, false),
            ("foo/bar", false, "foo/bar", false, true),
            ("foo", true, "foo", true, true),
        ] {
            let mut collisions = CollisionSet::default();
            collisions.insert(first.into(), first_dir).unwrap();
            assert_eq!(
                collisions.insert(second.into(), second_dir).is_err(),
                rejected,
                "{first} then {second}",
            );
        }
    }

    #[test]
    fn large_noncolliding_archive_checks_at_most_one_descendant_candidate_per_file() {
        let mut collisions = CollisionSet::default();
        let count = 4096;
        for index in (0..count).rev() {
            collisions.insert(format!("file{index:05}"), false).unwrap();
        }
        assert_eq!(collisions.entries.len(), count);
        assert_eq!(collisions.descendant_candidates_checked, count - 1);
        // The previous whole-map scan would check this many keys for the same order.
        assert_eq!(count * (count - 1) / 2, 8_386_560);
    }

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

    fn write_declared_tar_gz(path: &Path, size: u64) {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_path("declared.bin").unwrap();
        header.set_size(size);
        header.set_mode(0o644);
        header.set_cksum();
        let mut encoder = flate2::write::GzEncoder::new(
            File::create(path).unwrap(),
            flate2::Compression::default(),
        );
        encoder.write_all(header.as_bytes()).unwrap();
        encoder.finish().unwrap();
    }

    fn write_declared_tar_extension_gz(
        path: &Path,
        kind: tar::EntryType,
        declared_size: u64,
        body: &[u8],
    ) {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_path("extension").unwrap();
        header.set_size(declared_size);
        header.set_mode(0o644);
        header.set_cksum();
        let mut encoder = flate2::write::GzEncoder::new(
            File::create(path).unwrap(),
            flate2::Compression::default(),
        );
        encoder.write_all(header.as_bytes()).unwrap();
        encoder.write_all(body).unwrap();
        encoder.finish().unwrap();
    }

    fn mark_first_zip_entry_mode(path: &Path, mode: u32) {
        let mut bytes = fs::read(path).unwrap();
        let central = bytes
            .windows(4)
            .position(|window| window == b"PK\x01\x02")
            .expect("central directory entry");
        bytes[central + 4..central + 6].copy_from_slice(&0x0314_u16.to_le_bytes());
        bytes[central + 38..central + 42].copy_from_slice(&(mode << 16).to_le_bytes());
        fs::write(path, bytes).unwrap();
    }

    fn mark_first_zip_entry_as_symlink(path: &Path) {
        mark_first_zip_entry_mode(path, 0o120777);
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;

        fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    #[cfg(unix)]
    fn write_tar_gz(path: &Path, entries: &[(&str, &[u8], u32)]) {
        let encoder = flate2::write::GzEncoder::new(
            File::create(path).unwrap(),
            flate2::Compression::default(),
        );
        let mut builder = tar::Builder::new(encoder);
        for (name, bytes, mode) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(bytes.len() as u64);
            header.set_mode(*mode);
            header.set_cksum();
            builder
                .append_data(&mut header, *name, Cursor::new(*bytes))
                .unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn zip_and_tar_preserve_only_safe_executable_intent() {
        let temporary = tempdir().unwrap();
        let script = b"#!/bin/sh\nexit 0\n".as_slice();

        let zip = temporary.path().join("permissions.zip");
        write_zip(
            &zip,
            &[
                ("bin/run.sh", script, Some(0o755)),
                ("data.txt", b"data", Some(0o644)),
                ("deep/nested/data.txt", b"nested", Some(0o644)),
            ],
        );
        let zip_unsafe = temporary.path().join("permissions-unsafe.zip");
        write_zip(&zip_unsafe, &[("unsafe.sh", script, Some(0o755))]);
        mark_first_zip_entry_mode(&zip_unsafe, 0o104755);

        let zip_output = temporary.path().join("zip-output");
        fs::create_dir(&zip_output).unwrap();
        extract_archive(
            &zip,
            &zip_output,
            "permissions.zip",
            fs::metadata(&zip).unwrap().len(),
        )
        .unwrap();
        extract_archive(
            &zip_unsafe,
            &zip_output,
            "permissions-unsafe.zip",
            fs::metadata(&zip_unsafe).unwrap().len(),
        )
        .unwrap();
        assert_eq!(mode(&zip_output.join("bin")), 0o755);
        assert_eq!(mode(&zip_output.join("bin/run.sh")), 0o755);
        assert_eq!(mode(&zip_output.join("data.txt")), 0o644);
        assert_eq!(mode(&zip_output.join("deep")), 0o755);
        assert_eq!(mode(&zip_output.join("deep/nested")), 0o755);
        assert_eq!(mode(&zip_output.join("deep/nested/data.txt")), 0o644);
        assert_eq!(mode(&zip_output.join("unsafe.sh")), 0o755);
        assert!(
            crate::ChildProcessPolicy::native_command(
                crate::ChildProcessClass::HostTool,
                zip_output.join("bin/run.sh"),
            )
            .unwrap()
            .status()
            .unwrap()
            .success()
        );

        let tar = temporary.path().join("permissions.tar.gz");
        write_tar_gz(
            &tar,
            &[
                ("run.sh", script, 0o755),
                ("data.txt", b"data", 0o644),
                ("unsafe.sh", script, 0o7755),
            ],
        );
        let tar_output = temporary.path().join("tar-output");
        fs::create_dir(&tar_output).unwrap();
        extract_archive(
            &tar,
            &tar_output,
            "permissions.tar.gz",
            fs::metadata(&tar).unwrap().len(),
        )
        .unwrap();
        assert_eq!(mode(&tar_output.join("run.sh")), 0o755);
        assert_eq!(mode(&tar_output.join("data.txt")), 0o644);
        assert_eq!(mode(&tar_output.join("unsafe.sh")), 0o755);
        assert!(
            crate::ChildProcessPolicy::native_command(
                crate::ChildProcessClass::HostTool,
                tar_output.join("run.sh"),
            )
            .unwrap()
            .status()
            .unwrap()
            .success()
        );
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
                    executable: false,
                    size: MAX_ENTRY_BYTES + 1,
                }],
                1,
            )
            .is_err()
        );
        let plan = EntryPlan {
            relative: "short.bin".into(),
            directory: false,
            executable: false,
            size: 2,
        };
        assert!(write_entry(destination, &plan, &mut Cursor::new(vec![1]), &|| Ok(())).is_err());
    }

    #[test]
    fn tar_header_limits_reject_before_an_offending_body_is_drained() {
        let temporary = tempdir().unwrap();
        for (name, size, expected) in [
            (
                "entry",
                MAX_ENTRY_BYTES + 1,
                "archive entry exceeds its size limit",
            ),
            (
                "ratio",
                1024 * 1024,
                "archive exceeds the maximum compression ratio",
            ),
        ] {
            let source = temporary.path().join(format!("{name}.tar.gz"));
            let destination = temporary.path().join(name);
            fs::create_dir(&destination).unwrap();
            write_declared_tar_gz(&source, size);
            let error = extract_archive(
                &source,
                &destination,
                "fixture.tar.gz",
                fs::metadata(&source).unwrap().len(),
            )
            .unwrap_err();
            assert!(error.message.contains(expected), "{}", error.message);
            assert_eq!(fs::read_dir(destination).unwrap().count(), 0);
        }

        let mut expanded = 0;
        validate_declared_entry(Path::new("first"), MAX_ENTRY_BYTES, &mut expanded, 0).unwrap();
        validate_declared_entry(Path::new("second"), MAX_ENTRY_BYTES, &mut expanded, 0).unwrap();
        let error = validate_declared_entry(Path::new("third"), 1, &mut expanded, 0).unwrap_err();
        assert!(error.message.contains("total expanded size limit"));
    }

    #[test]
    fn tar_extension_metadata_is_bounded_before_buffering_or_draining() {
        let temporary = tempdir().unwrap();
        let boundary_source = temporary.path().join("boundary-pax.tar.gz");
        let boundary_destination = temporary.path().join("boundary-pax");
        fs::create_dir(&boundary_destination).unwrap();
        let mut pax_header = tar::Header::new_gnu();
        pax_header.set_entry_type(tar::EntryType::XHeader);
        pax_header.set_path("boundary-pax").unwrap();
        pax_header.set_size(MAX_TAR_EXTENSION_BYTES);
        pax_header.set_mode(0o644);
        pax_header.set_cksum();
        let mut file_header = tar::Header::new_gnu();
        file_header.set_entry_type(tar::EntryType::Regular);
        file_header.set_path("accepted.bin").unwrap();
        file_header.set_size(0);
        file_header.set_mode(0o644);
        file_header.set_cksum();
        let mut encoder = flate2::write::GzEncoder::new(
            File::create(&boundary_source).unwrap(),
            flate2::Compression::default(),
        );
        encoder.write_all(pax_header.as_bytes()).unwrap();
        encoder.write_all(b"65536 comment=").unwrap();
        encoder.write_all(&vec![b'a'; 65_521]).unwrap();
        encoder.write_all(b"\n").unwrap();
        encoder.write_all(file_header.as_bytes()).unwrap();
        encoder.write_all(&[0_u8; 1024]).unwrap();
        encoder.finish().unwrap();
        extract_archive(
            &boundary_source,
            &boundary_destination,
            "fixture.tar.gz",
            fs::metadata(&boundary_source).unwrap().len(),
        )
        .unwrap();
        assert!(boundary_destination.join("accepted.bin").is_file());

        for (name, kind) in [
            ("pax", tar::EntryType::XHeader),
            ("pax-global", tar::EntryType::XGlobalHeader),
            ("gnu-long-name", tar::EntryType::GNULongName),
        ] {
            let source = temporary.path().join(format!("{name}.tar.gz"));
            let destination = temporary.path().join(name);
            fs::create_dir(&destination).unwrap();
            write_declared_tar_extension_gz(
                &source,
                kind,
                MAX_TAR_EXTENSION_BYTES + 1,
                b"sentinel",
            );
            let error = extract_archive(
                &source,
                &destination,
                "fixture.tar.gz",
                fs::metadata(&source).unwrap().len(),
            )
            .unwrap_err();
            assert!(
                error.message.contains("extension metadata exceeds"),
                "{name}: {}",
                error.message
            );
            assert!(fs::metadata(&source).unwrap().len() < 1024, "{name}");
            assert_eq!(fs::read_dir(destination).unwrap().count(), 0, "{name}");
        }

        let truncated = temporary.path().join("truncated-pax.tar.gz");
        let destination = temporary.path().join("truncated-pax");
        fs::create_dir(&destination).unwrap();
        write_declared_tar_extension_gz(&truncated, tar::EntryType::XHeader, 1024, b"x");
        let error = extract_archive(
            &truncated,
            &destination,
            "fixture.tar.gz",
            fs::metadata(&truncated).unwrap().len(),
        )
        .unwrap_err();
        assert!(
            error.message.contains("invalid TAR entry"),
            "{}",
            error.message
        );
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);

        let long_link = temporary.path().join("gnu-long-link.tar.gz");
        write_declared_tar_extension_gz(
            &long_link,
            tar::EntryType::GNULongLink,
            MAX_TAR_EXTENSION_BYTES + 1,
            b"sentinel",
        );
        let error = extract_archive(
            &long_link,
            &destination,
            "fixture.tar.gz",
            fs::metadata(&long_link).unwrap().len(),
        )
        .unwrap_err();
        assert!(error.message.contains("links and special files"));
    }

    #[test]
    fn decoded_tar_work_and_entry_writes_are_bounded_and_cancellable() {
        let checkpoint_count = Cell::new(0_u64);
        let checkpoint = || {
            checkpoint_count.set(checkpoint_count.get() + 1);
            Ok(())
        };
        let mut reader = CheckpointReader::new(Cursor::new(vec![0_u8; 1025]), 1024, &checkpoint);
        let mut decoded = Vec::new();
        let error = reader.read_to_end(&mut decoded).unwrap_err();
        assert!(error.to_string().contains("metadata-aware work limit"));
        assert_eq!(decoded.len(), 1024);
        assert_eq!(reader.decoded, 1024);
        assert!(checkpoint_count.get() >= 2);

        let temporary = tempdir().unwrap();
        let plan = EntryPlan {
            relative: "large.bin".into(),
            directory: false,
            executable: false,
            size: (ARCHIVE_IO_CHUNK_BYTES * 3) as u64,
        };
        let output = temporary.path().join(&plan.relative);
        let cancel = || {
            if fs::metadata(&output).is_ok_and(|metadata| metadata.len() > 0) {
                Err(PortcoveError::new(
                    crate::ErrorCode::Cancelled,
                    "test cancellation",
                ))
            } else {
                Ok(())
            }
        };
        let error = write_entry(
            temporary.path(),
            &plan,
            &mut Cursor::new(vec![7_u8; plan.size as usize]),
            &cancel,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        assert_eq!(
            fs::metadata(output).unwrap().len(),
            ARCHIVE_IO_CHUNK_BYTES as u64
        );

        let nested_output = temporary.path().join("nested.bin");
        let nested_plan = EntryPlan {
            relative: "nested.bin".into(),
            directory: false,
            executable: false,
            size: 4,
        };
        let nested_calls = Cell::new(0);
        let nested_checkpoint = || {
            nested_calls.set(nested_calls.get() + 1);
            if nested_calls.get() >= 3 {
                Err(PortcoveError::new(
                    crate::ErrorCode::Cancelled,
                    "test cancellation",
                ))
            } else {
                Ok(())
            }
        };
        let mut nested_reader =
            CheckpointReader::new(Cursor::new(b"data"), 1024, &nested_checkpoint);
        let error = write_entry(
            temporary.path(),
            &nested_plan,
            &mut nested_reader,
            &nested_checkpoint,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        assert_eq!(fs::metadata(nested_output).unwrap().len(), 0);
    }

    #[test]
    fn cancellation_checkpoints_cover_preflight_and_entry_boundaries() {
        let temporary = tempdir().unwrap();
        let source = temporary.path().join("entries.zip");
        write_zip(
            &source,
            &[
                ("first.bin", b"first", None),
                ("second.bin", b"second", None),
            ],
        );

        let preflight_output = temporary.path().join("preflight");
        fs::create_dir(&preflight_output).unwrap();
        let calls = Cell::new(0);
        let cancel_preflight = || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                Err(PortcoveError::new(
                    crate::ErrorCode::Cancelled,
                    "test cancellation",
                ))
            } else {
                Ok(())
            }
        };
        let error = extract_archive_with_checkpoint(
            &source,
            &preflight_output,
            "entries.zip",
            fs::metadata(&source).unwrap().len(),
            &cancel_preflight,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        assert_eq!(fs::read_dir(preflight_output).unwrap().count(), 0);

        let boundary_output = temporary.path().join("boundary");
        fs::create_dir(&boundary_output).unwrap();
        let full_observations = Cell::new(0);
        let cancel_between = || {
            if fs::metadata(boundary_output.join("first.bin"))
                .is_ok_and(|metadata| metadata.len() == 5)
            {
                full_observations.set(full_observations.get() + 1);
                if full_observations.get() >= 3 {
                    return Err(PortcoveError::new(
                        crate::ErrorCode::Cancelled,
                        "test cancellation",
                    ));
                }
            }
            Ok(())
        };
        let error = extract_archive_with_checkpoint(
            &source,
            &boundary_output,
            "entries.zip",
            fs::metadata(&source).unwrap().len(),
            &cancel_between,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        assert_eq!(
            fs::read(boundary_output.join("first.bin")).unwrap(),
            b"first"
        );
        assert!(!boundary_output.join("second.bin").exists());
    }
}
