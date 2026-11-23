use std::path::Path;

use crate::{PortcoveError, Result};

#[cfg(test)]
#[path = "path_property_tests.rs"]
mod property_tests;

/// Normalizes a Win32 path for a case-insensitive containment comparison:
/// verbatim prefixes are removed, separators unified and trailing separators
/// dropped. It never touches the filesystem.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn comparable_windows_path(path: &str) -> String {
    let path = path.replace('/', "\\");
    // `\\?\` verbatim prefix; `\\?\UNC\server\share` becomes `\\server\share`.
    let path = match path.strip_prefix("\\\\?\\") {
        Some(verbatim) => match verbatim.strip_prefix("UNC\\") {
            Some(unc) => format!("\\\\{unc}"),
            None => verbatim.to_owned(),
        },
        None => path,
    };
    path.trim_end_matches('\\').to_lowercase()
}

/// The ordinary Win32 spelling of a path for player-facing details and stored
/// identity. Filesystem operations keep the extended (`\\?\`) form for
/// long-path safety; only the presented spelling drops a verbatim disk or UNC
/// prefix. Other paths, including non-Unicode ones, are returned unchanged.
pub(crate) fn ordinary_path(path: &Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};

        if let Some(Component::Prefix(prefix)) = path.components().next()
            && matches!(
                prefix.kind(),
                Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _)
            )
            && let Some(ordinary) = path.to_str().and_then(ordinary_windows_text)
        {
            return ordinary.into();
        }
    }
    path.to_path_buf()
}

/// Host-independent spelling rule behind [`ordinary_path`]: `\\?\X:\…`
/// becomes `X:\…` and `\\?\UNC\server\share…` becomes `\\server\share…`.
/// Any other spelling, including a bare `\\?\X:` and other verbatim devices,
/// has no ordinary equivalent here and yields `None`.
#[cfg_attr(not(windows), allow(dead_code))]
fn ordinary_windows_text(text: &str) -> Option<String> {
    let verbatim = text.strip_prefix(r"\\?\")?;
    if let Some(unc) = verbatim.strip_prefix(r"UNC\") {
        return (!unc.is_empty()).then(|| format!(r"\\{unc}"));
    }
    match verbatim.as_bytes() {
        [letter, b':', b'\\', ..] if letter.is_ascii_alphabetic() => Some(verbatim.to_owned()),
        _ => None,
    }
}

#[cfg(windows)]
pub(crate) fn windows_ordinal_names_equal(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};

    let left: Vec<_> = left.encode_wide().collect();
    let right: Vec<_> = right.encode_wide().collect();
    let (Ok(left_len), Ok(right_len)) = (i32::try_from(left.len()), i32::try_from(right.len()))
    else {
        return false;
    };
    // SAFETY: both buffers have exactly the supplied lengths.
    unsafe {
        CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) == CSTR_EQUAL
    }
}

/// Join a declared `/`-separated relative path under `root` one component at a
/// time. A raw join keeps `/` inside the component on Windows, which the
/// extended (`\\?\`) namespace used for atomic publication treats literally.
/// Callers must pass an already-validated relative path: confinement (no
/// rooted, prefixed, empty or `..` components) is enforced upstream, not here.
pub(crate) fn join_relative(root: &Path, relative: &str) -> std::path::PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

pub(crate) fn is_portcove_metadata(path: &Path) -> bool {
    path.to_str().is_some_and(|relative| {
        relative.split(['/', '\\']).any(|name| {
            let name = name.to_ascii_lowercase();
            name.starts_with(".portcove-") || name.ends_with(".portcove-source.json")
        })
    })
}

pub(crate) fn refuse_symlink_ancestors(path: &Path) -> Result<()> {
    for candidate in path.ancestors() {
        match std::fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(PortcoveError::conflict(format!(
                    "refusing to synchronize through a symlink: {}",
                    candidate.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// Bound the read itself as well as the initial stat, including concurrent file growth.
pub(crate) fn read_bounded_regular(path: &Path, limit: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(
            PortcoveError::verification("metadata must be a bounded regular file")
                .detail("path", path.display().to_string()),
        );
    }
    if metadata.len() > limit {
        return Err(
            PortcoveError::verification("metadata must be a bounded regular file")
                .detail("path", path.display().to_string())
                .detail("bounded_regular_oversize", "true"),
        );
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(
            PortcoveError::verification("metadata grew beyond its read limit")
                .detail("bounded_regular_oversize", "true"),
        );
    }
    Ok(bytes)
}

/// Resolve aliases in the existing part while preserving missing descendants.
/// Missing install directories must remain exportable as recovery metadata.
pub(crate) fn resolve_existing_ancestor(path: &Path) -> Result<std::path::PathBuf> {
    let mut existing = std::path::absolute(path)?;
    let mut tail = Vec::new();
    loop {
        match std::fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = existing
                    .file_name()
                    .ok_or_else(|| PortcoveError::usage("path has no resolvable parent"))?
                    .to_owned();
                tail.push(name);
                if !existing.pop() {
                    return Err(PortcoveError::usage("path has no resolvable parent"));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    let mut resolved = std::fs::canonicalize(existing)?;
    for name in tail.into_iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

pub(crate) fn existing_ancestor(path: &Path) -> Result<std::path::PathBuf> {
    let mut existing = std::path::absolute(path)?;
    loop {
        match std::fs::symlink_metadata(&existing) {
            Ok(_) => return std::fs::canonicalize(existing).map_err(Into::into),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !existing.pop() {
                    return Err(PortcoveError::usage("path has no existing parent"));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub(crate) fn normalized_absolute(path: &Path, role: &str) -> Result<std::path::PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(PortcoveError::usage(format!("{role} cannot be empty")));
    }
    unicode(path, role)?;
    let resolved = resolve_existing_ancestor(&std::path::absolute(path)?)?;
    unicode(&resolved, role)?;
    Ok(resolved)
}

/// Compare saved Win32 disk and UNC spellings even when their volume is offline
/// or the reader runs on another OS. Only the volume prefix and separators change.
pub(crate) fn comparable_windows_absolute(path: &Path) -> Option<String> {
    let separators = path.to_str()?.replace('\\', "/");
    let mut ordinary = match separators.strip_prefix("//?/") {
        Some(verbatim) => match verbatim.strip_prefix("UNC/") {
            Some(unc) => format!("//{unc}"),
            None => verbatim.to_owned(),
        },
        None => separators,
    };
    if matches!(ordinary.as_bytes(), [drive, b':', b'/', ..] if drive.is_ascii_alphabetic()) {
        ordinary.get_mut(..1)?.make_ascii_uppercase();
        return Some(ordinary);
    }
    let mut unc = ordinary.strip_prefix("//")?.split('/');
    let (host, share) = (unc.next()?, unc.next()?);
    (![host, share]
        .iter()
        .any(|name| matches!(*name, "" | "." | ".." | "?")))
    .then_some(ordinary)
}

/// V1's durable and child-process contracts use Unicode strings on every host.
/// Reject an unrepresentable path at the boundary instead of storing or passing
/// a lossy alias that cannot identify the original filesystem object.
pub(crate) fn unicode(path: &Path, role: &str) -> Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        PortcoveError::unsupported(format!(
            "Portcove V1 requires {role} paths to be valid Unicode"
        ))
        .with_known_cause(crate::failure::KnownFailureCause::UnicodePath)
        .detail("path_role", role)
    })
}

#[cfg(test)]
#[test]
fn ancestor_check_allows_missing_components() {
    let temporary = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temporary.path()).unwrap();
    refuse_symlink_ancestors(&root.join("missing/child")).unwrap();
}

#[cfg(all(test, unix))]
#[test]
fn ancestor_check_propagates_metadata_errors() {
    let temporary = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temporary.path()).unwrap();
    let file = root.join("file");
    std::fs::write(&file, b"").unwrap();
    let child = file.join("child");
    let metadata_error = std::fs::symlink_metadata(&child).unwrap_err();
    assert_eq!(metadata_error.kind(), std::io::ErrorKind::NotADirectory);
    assert_eq!(
        refuse_symlink_ancestors(&child).unwrap_err().message,
        metadata_error.to_string()
    );
}

/// What each root can detect about a regression from `join_relative` to a raw
/// `root.join("a/b/c")`:
/// - Ordinary Windows root (the un-canonicalized temporary directory, a
///   `Prefix::Disk` path): a raw join leaves `/` in the string, which atomic
///   publication later prefixed with `\\?\` (os error 123). This case fails on
///   that regression, and the control assertion proves the input discriminates.
/// - Verbatim Windows root (`\\?\D:\…` from `canonicalize`): `PathBuf::push`
///   re-parses a pushed path onto a verbatim base and rejoins its components
///   with `\`, so a raw join is indistinguishable here. This case only pins that
///   the helper keeps verbatim roots verbatim and adds normal components.
/// - Unix: `/` is the native separator, so neither form can be told apart; the
///   case checks the component shape only.
#[cfg(test)]
#[test]
fn relative_joins_use_only_native_separators() {
    use std::path::{Component, MAIN_SEPARATOR, MAIN_SEPARATOR_STR};
    let foreign = if MAIN_SEPARATOR == '/' { '\\' } else { '/' };
    let relative = "DaggerfallUnity_Data/StreamingAssets/Mods";
    let names = ["DaggerfallUnity_Data", "StreamingAssets", "Mods"];
    let temporary = tempfile::tempdir().unwrap();
    let ordinary = temporary.path().join("port");
    let verbatim = std::fs::canonicalize(temporary.path())
        .unwrap()
        .join("port");
    #[cfg(windows)]
    {
        use std::path::Prefix;
        fn kind(path: &Path) -> Option<Prefix<'_>> {
            match path.components().next() {
                Some(Component::Prefix(prefix)) => Some(prefix.kind()),
                _ => None,
            }
        }
        assert!(
            matches!(kind(&ordinary), Some(Prefix::Disk(_))),
            "{ordinary:?}"
        );
        assert!(
            matches!(kind(&verbatim), Some(Prefix::VerbatimDisk(_))),
            "{verbatim:?}"
        );
        // Control: the ordinary root discriminates a raw join; the verbatim
        // root does not, because push rejoins the parsed components there.
        assert!(ordinary.join(relative).to_str().unwrap().contains('/'));
        assert!(!verbatim.join(relative).to_str().unwrap().contains('/'));
    }
    for root in [&ordinary, &verbatim] {
        let joined = join_relative(root, relative);
        let text = joined.to_str().unwrap();
        assert!(!text.contains(foreign), "{text}");
        let suffix = joined.strip_prefix(root).unwrap().to_str().unwrap();
        assert_eq!(suffix, names.join(MAIN_SEPARATOR_STR));
        let added = joined
            .components()
            .skip(root.components().count())
            .map(|component| match component {
                Component::Normal(name) => name.to_str().unwrap().to_owned(),
                other => panic!("a relative join added {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(added, names);
    }
}

#[cfg(test)]
#[test]
fn ordinary_spelling_drops_only_verbatim_disk_and_unc_prefixes() {
    // Built from prefix pieces so no absolute path literal appears here.
    let verbatim = r"\\?\";
    let disk = |prefix: &str, rest: &[&str]| {
        let mut text = format!("{prefix}D:");
        for part in rest {
            text.push('\\');
            text.push_str(part);
        }
        text
    };
    let parts = ["a", "_temp", ".portcove-dfu-save-cleanup-1"];
    assert_eq!(
        ordinary_windows_text(&disk(verbatim, &parts)),
        Some(disk("", &parts))
    );
    let unc = ["server", "share", "Games"].join("\\");
    assert_eq!(
        ordinary_windows_text(&format!("{verbatim}UNC\\{unc}")),
        Some(format!("\\\\{unc}"))
    );
    // A bare verbatim drive is drive-relative once unprefixed, other verbatim
    // devices have no ordinary spelling, and ordinary paths are not verbatim.
    for unchanged in [
        disk(verbatim, &[]),
        format!("{verbatim}UNC\\"),
        format!("{verbatim}GLOBALROOT\\Device"),
        format!("{verbatim}1:\\a"),
        disk("", &parts),
        parts.join("\\"),
    ] {
        assert_eq!(ordinary_windows_text(&unchanged), None, "{unchanged}");
    }

    // The host path wrapper changes only what Windows parses as verbatim; on
    // Unix the same text is an ordinary relative name and must not change.
    let temporary = tempfile::tempdir().unwrap();
    assert_eq!(ordinary_path(temporary.path()), temporary.path());
    let canonical = std::fs::canonicalize(temporary.path()).unwrap();
    let presented = ordinary_path(&canonical);
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        assert!(matches!(
            presented.components().next(),
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))
        ));
        assert!(!presented.to_str().unwrap().starts_with(verbatim));
        // Presentation keeps identity: it resolves to the same directory.
        assert_eq!(std::fs::canonicalize(&presented).unwrap(), canonical);
        let text = disk(verbatim, &parts);
        assert_eq!(
            ordinary_path(Path::new(&text)),
            Path::new(&disk("", &parts))
        );
    }
    #[cfg(not(windows))]
    {
        assert_eq!(presented, canonical);
        let text = disk(verbatim, &parts);
        assert_eq!(ordinary_path(Path::new(&text)), Path::new(&text));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt, path::PathBuf};

    #[test]
    fn non_unicode_paths_are_explicitly_unsupported() {
        let path = PathBuf::from(OsString::from_vec(vec![b'p', 0xff]));

        let error = super::unicode(&path, "test source").unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert_eq!(error.details["path_role"], "test source");
    }
}
