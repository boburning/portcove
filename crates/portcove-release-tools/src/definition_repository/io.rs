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
pub(super) fn no_overlap(output: &Path, inputs: &[PathBuf]) -> Result<()> {
    let normalized_output = if output.try_exists()? {
        output.canonicalize()?
    } else {
        output
            .parent()
            .ok_or_else(|| TufRepositoryError::Invalid("output parent absent".into()))?
            .canonicalize()?
            .join(
                output
                    .file_name()
                    .ok_or_else(|| TufRepositoryError::Invalid("output name absent".into()))?,
            )
    };
    let inputs = inputs
        .iter()
        .map(|p| p.canonicalize())
        .collect::<std::io::Result<Vec<_>>>()?;
    if inputs.iter().any(|p| {
        normalized_output == *p
            || normalized_output.starts_with(p)
            || p.starts_with(&normalized_output)
    }) {
        return invalid("catalog output overlaps original inputs");
    }
    let parent = output
        .parent()
        .ok_or_else(|| TufRepositoryError::Invalid("output has no parent".into()))?;
    ancestry(parent)
}
pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<bool> {
    if path.try_exists()? {
        if read(path, ROLE_MAX)? == bytes {
            return Ok(false);
        }
        return invalid("catalog output already exists with different bytes; retain original");
    }
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
    drop(file);
    if read(path, ROLE_MAX)? != bytes {
        return invalid("catalog output readback differs");
    }
    Ok(true)
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
