use super::*;
use std::{fs::OpenOptions, io::Write, path::Component};
pub(super) fn read(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    crate::tuf_repository::offline::read_input(path, maximum, "catalog input")
}
pub(super) fn parse<T: serde::de::DeserializeOwned>(path: &Path, max: u64) -> Result<T> {
    Ok(serde_json::from_slice(&read(path, max)?)?)
}
pub(super) fn ancestry(path: &Path) -> Result<()> {
    for item in path.ancestors() {
        if item.as_os_str().is_empty() {
            continue;
        }
        let m = fs::symlink_metadata(item)?;
        if m.file_type().is_symlink() {
            return invalid("catalog path ancestry is linked");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return invalid("catalog path ancestry is reparse point");
            }
        }
    }
    Ok(())
}
pub(super) fn resolve(base: &Path, value: &str) -> Result<PathBuf> {
    let p = Path::new(value);
    if value.is_empty()
        || p.components()
            .any(|v| matches!(v, Component::ParentDir | Component::CurDir))
    {
        return invalid("catalog path contains traversal");
    }
    let absolute_base = if base.is_absolute() {
        base.to_path_buf()
    } else {
        std::env::current_dir()?.join(base)
    };
    if absolute_base
        .components()
        .any(|v| matches!(v, Component::ParentDir))
    {
        return invalid("catalog base path contains traversal");
    }
    Ok(if p.is_absolute() {
        p.to_path_buf()
    } else {
        absolute_base.join(p)
    })
}
pub(super) fn relative(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 256
        || value.contains('\\')
        || value.contains(':')
        || value.starts_with('/')
        || value.split('/').any(|v| {
            v.is_empty()
                || v == "."
                || v == ".."
                || v.ends_with('.')
                || v.ends_with(' ')
                || !v
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        })
    {
        return invalid("catalog public target path is not canonical");
    }
    Ok(())
}
fn normalize_output(output: &Path) -> Result<PathBuf> {
    match output.symlink_metadata() {
        Ok(_) => {
            ancestry(output)?;
            output.canonicalize().map_err(Into::into)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(output
            .parent()
            .ok_or_else(|| TufRepositoryError::Invalid("output parent absent".into()))?
            .canonicalize()?
            .join(
                output
                    .file_name()
                    .ok_or_else(|| TufRepositoryError::Invalid("output name absent".into()))?,
            )),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn no_overlap(output: &Path, inputs: &[PathBuf]) -> Result<()> {
    let normalized_output = normalize_output(output)?;
    let inputs = inputs
        .iter()
        .map(|p| p.canonicalize())
        .collect::<std::io::Result<Vec<_>>>()?;
    for input in inputs {
        if output_contains(&normalized_output, &input)
            || output_contains(&input, &normalized_output)
            || same_directory_ancestry(&normalized_output, &input)?
        {
            return invalid("catalog output overlaps original inputs");
        }
    }
    let parent = output
        .parent()
        .ok_or_else(|| TufRepositoryError::Invalid("output has no parent".into()))?;
    ancestry(parent)
}
pub(super) fn no_output_overlap(first: &Path, second: &Path) -> Result<()> {
    let first = normalize_output(first)?;
    let second = normalize_output(second)?;
    if output_contains(&first, &second)
        || output_contains(&second, &first)
        || same_directory_ancestry(&first, &second)?
    {
        return invalid("catalog assembly outputs overlap");
    }
    Ok(())
}
// Once the roots exist, compare actual Unix directory identities as well as names.
// This covers volume-specific case folding, Unicode normalization and mount aliases.
#[cfg(unix)]
fn same_directory_ancestry(first: &Path, second: &Path) -> Result<bool> {
    use std::os::unix::fs::MetadataExt as _;

    fn identity(path: &Path) -> Result<Option<(u64, u64)>> {
        match path.symlink_metadata() {
            Ok(metadata) if metadata.is_dir() => Ok(Some((metadata.dev(), metadata.ino()))),
            Ok(_) => Ok(None),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    for (path, other) in [(first, second), (second, first)] {
        if let Some(expected) = identity(path)? {
            for parent in other.ancestors() {
                if identity(parent)? == Some(expected) {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

#[cfg(not(unix))]
fn same_directory_ancestry(_: &Path, _: &Path) -> Result<bool> {
    Ok(false)
}

#[cfg(not(windows))]
fn output_contains(path: &Path, prefix: &Path) -> bool {
    let mut components = path.components();
    prefix.components().all(|expected| {
        components.next().is_some_and(|actual| {
            let actual = actual.as_os_str().as_encoded_bytes();
            let expected = expected.as_os_str().as_encoded_bytes();
            actual.eq_ignore_ascii_case(expected)
        })
    })
}

#[cfg(windows)]
fn output_contains(path: &Path, prefix: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};

    let mut components = path.components();
    prefix.components().all(|expected| {
        components.next().is_some_and(|actual| {
            let wide = |component: Component<'_>| {
                let mut bytes: Vec<u16> = component.as_os_str().encode_wide().collect();
                while matches!(bytes.last(), Some(32 | 46)) {
                    bytes.pop();
                }
                bytes.push(0);
                bytes
            };
            let actual = wide(actual);
            let expected = wide(expected);
            // SAFETY: Both component buffers have a trailing NUL.
            (unsafe { CompareStringOrdinal(actual.as_ptr(), -1, expected.as_ptr(), -1, 1) })
                == CSTR_EQUAL
        })
    })
}

/// A missing directory may be created. Existing links and wrong kinds are refused.
pub(super) fn directory_exists(path: &Path) -> Result<bool> {
    match path.symlink_metadata() {
        Ok(metadata) => {
            ancestry(path)?;
            if !metadata.is_dir() {
                return invalid("catalog output path is not a directory");
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// An empty directory created exclusively during assembly preflight.
/// Keep the original handle alive so a reused path cannot impersonate it.
pub(super) struct OutputReservation {
    path: PathBuf,
    handle: Option<fs::File>,
}

impl OutputReservation {
    pub(super) fn create(path: &Path) -> Result<Self> {
        ancestry(
            path.parent().ok_or_else(|| {
                TufRepositoryError::Invalid("catalog output parent absent".into())
            })?,
        )?;
        #[cfg(not(unix))]
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            handle: open_reserved_directory(path).ok(),
        })
    }

    pub(super) fn remove_if_owned(&self) {
        let held = self.handle.as_ref().and_then(directory_identity);
        if held.is_some()
            && open_reserved_directory(&self.path)
                .ok()
                .as_ref()
                .and_then(directory_identity)
                == held
        {
            let _ = fs::remove_dir(&self.path);
        }
    }
}

fn open_reserved_directory(path: &Path) -> Result<fs::File> {
    if !directory_exists(path)? {
        return invalid("catalog output reservation is missing");
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        };
        options
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    Ok(options.open(path)?)
}

#[cfg(unix)]
fn directory_identity(file: &fs::File) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt as _;
    let metadata = file.metadata().ok()?;
    metadata.is_dir().then(|| (metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn directory_identity(file: &fs::File) -> Option<(u64, [u8; 16])> {
    use std::os::windows::{fs::MetadataExt as _, io::AsRawHandle as _};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
    };

    let metadata = file.metadata().ok()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return None;
    }
    // SAFETY: the borrowed handle and initialized output storage are valid
    // throughout this synchronous Win32 query.
    let mut information: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as _,
            FileIdInfo,
            std::ptr::from_mut(&mut information).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    (success != 0 && information.FileId.Identifier != [0; 16]).then_some((
        information.VolumeSerialNumber,
        information.FileId.Identifier,
    ))
}

#[cfg(not(any(unix, windows)))]
fn directory_identity(_: &fs::File) -> Option<(u64, u64)> {
    None
}

/// Check immutable reuse without writing so a different output cannot be partially created.
pub(super) fn output_file_exists(path: &Path, bytes: &[u8]) -> Result<bool> {
    match path.symlink_metadata() {
        Ok(_) if read(path, ROLE_MAX)? != bytes => {
            invalid("catalog output already exists with different bytes; retain original")
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<bool> {
    if output_file_exists(path, bytes)? {
        return Ok(false);
    }
    create_synced(path, bytes)?;
    if read(path, ROLE_MAX)? != bytes {
        return invalid("catalog output readback differs");
    }
    Ok(true)
}

/// Create a file for an assembly whose complete inventory will be read back.
pub(super) fn create_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    ancestry(
        path.parent()
            .ok_or_else(|| TufRepositoryError::Invalid("output parent absent".into()))?,
    )?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
pub(super) fn canonical(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)?;
    value.sort_all_objects();
    Ok([serde_json::to_vec_pretty(&value)?.as_slice(), b"\n"].concat())
}
pub(super) fn tree(root: &Path, max_files: usize, max_bytes: u64) -> Result<Files> {
    collect_tree(root, max_files, max_bytes, |_, bytes| bytes)
}
/// Retain exact identities, reading at most one bounded file body at a time.
pub(super) fn inventory(
    root: &Path,
    max_files: usize,
    max_bytes: u64,
) -> Result<Vec<DefinitionFile>> {
    Ok(
        collect_tree(root, max_files, max_bytes, |target, bytes| DefinitionFile {
            target: target.to_owned(),
            bytes: bytes.len() as u64,
            sha256: sha(&bytes),
        })?
        .into_values()
        .collect(),
    )
}
fn collect_tree<T>(
    root: &Path,
    max_files: usize,
    max_bytes: u64,
    collect: impl Fn(&str, Vec<u8>) -> T,
) -> Result<BTreeMap<String, T>> {
    ancestry(root)?;
    let mut walk = TreeWalk {
        files: BTreeMap::new(),
        entries: 0,
        total: 0,
        max_files,
        max_bytes,
        collect,
    };
    walk.visit(root, "")?;
    Ok(walk.files)
}
struct TreeWalk<T, F> {
    files: BTreeMap<String, T>,
    entries: usize,
    total: u64,
    max_files: usize,
    max_bytes: u64,
    collect: F,
}
impl<T, F: Fn(&str, Vec<u8>) -> T> TreeWalk<T, F> {
    fn visit(&mut self, root: &Path, prefix: &str) -> Result<()> {
        if prefix.split('/').count() > 8 || !fs::symlink_metadata(root)?.is_dir() {
            return invalid("catalog tree kind/depth differs");
        }
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            self.entries += 1;
            if self.entries > self.max_files * 2 + 16 {
                return invalid("catalog tree entry bound exceeded");
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| TufRepositoryError::Invalid("catalog tree name nonUTF8".into()))?;
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            self::relative(&relative)?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                return invalid("catalog tree includes link");
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return invalid("catalog tree includes reparse point");
                }
            }
            if metadata.is_dir() {
                self.visit(&entry.path(), &relative)?;
            } else {
                if self.files.len() >= self.max_files {
                    return invalid("catalog tree file bound exceeded");
                }
                let bytes = read(&entry.path(), ROLE_MAX)?;
                self.total += bytes.len() as u64;
                if self.total > self.max_bytes {
                    return invalid("catalog tree total byte bound exceeded");
                }
                let value = (self.collect)(&relative, bytes);
                self.files.insert(relative, value);
            }
        }
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod reservation_tests {
    use super::*;

    #[test]
    fn reservation_cleanup_keeps_a_replacement_directory() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let original = root.join("original");
        let moved = root.join("moved");
        let reservation = OutputReservation::create(&original).unwrap();
        fs::rename(&original, &moved).unwrap();
        fs::create_dir(&original).unwrap();

        reservation.remove_if_owned();
        assert!(original.is_dir());
        assert!(moved.is_dir());

        let fresh = root.join("fresh");
        let fresh_reservation = OutputReservation::create(&fresh).unwrap();
        fresh_reservation.remove_if_owned();
        assert!(!fresh.exists());
    }
}
