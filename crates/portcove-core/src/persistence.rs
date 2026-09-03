//! Catalog-owned rules for variable names in one persistent working directory.
use std::{collections::BTreeSet, fs, path::Path};

use crate::{PersistentFilePattern, PortDefinition, PortcoveError, Result};

const MAX_DIRECTORY_ENTRIES: usize = 4096;
const MAX_MATCHING_FILES: usize = 1024;

impl PersistentFilePattern {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.prefix.is_empty()
            || self.suffix.is_empty()
            || self.prefix.contains(['/', '\\'])
            || self.suffix.contains(['/', '\\'])
        {
            return Err(PortcoveError::usage(
                "persistent file patterns need a filename prefix and suffix without directories",
            ));
        }
        crate::archive::validate_relative_path(&format!("{}x{}", self.prefix, self.suffix), false)?;
        let suffix = self.suffix.to_ascii_lowercase();
        if matches!(
            suffix.rsplit('.').next(),
            Some(
                "exe"
                    | "com"
                    | "dll"
                    | "so"
                    | "dylib"
                    | "appimage"
                    | "jar"
                    | "bat"
                    | "cmd"
                    | "ps1"
                    | "sh"
                    | "js"
                    | "vbs"
                    | "py"
            )
        ) {
            return Err(PortcoveError::usage(
                "persistent file patterns cannot select executable or script extensions",
            ));
        }
        Ok(())
    }

    pub(crate) fn matches(&self, name: &str) -> bool {
        !name.contains(['/', '\\'])
            && name.len() > self.prefix.len() + self.suffix.len()
            && name.starts_with(&self.prefix)
            && name.ends_with(&self.suffix)
    }
}

pub(crate) fn entries(port: &PortDefinition, roots: &[&Path]) -> Result<Vec<String>> {
    let mut entries: BTreeSet<String> = port.persistent_paths.iter().cloned().collect();
    if port.persistent_file_patterns.is_empty() {
        return Ok(entries.into_iter().collect());
    }
    for pattern in &port.persistent_file_patterns {
        pattern.validate()?;
    }
    let mut matches = BTreeSet::new();
    for root in roots {
        crate::path::refuse_symlink_ancestors(root)?;
        let directory = match fs::read_dir(root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            result => result?,
        };
        for (index, entry) in directory.enumerate() {
            if index >= MAX_DIRECTORY_ENTRIES {
                return Err(PortcoveError::unsupported(
                    "persistent file scan entry limit reached",
                ));
            }
            let entry = entry?;
            let name = crate::path::unicode(Path::new(&entry.file_name()), "persistent filename")?;
            if !port
                .persistent_file_patterns
                .iter()
                .any(|pattern| pattern.matches(&name))
            {
                continue;
            }
            crate::archive::validate_relative_path(&name, false)?;
            if !entry.file_type()?.is_file() {
                return Err(PortcoveError::conflict(
                    "a persistent file pattern matched a directory, link, or special entry",
                ));
            }
            matches.insert(name.clone());
            if matches.len() > MAX_MATCHING_FILES {
                return Err(PortcoveError::unsupported(
                    "persistent file match limit reached",
                ));
            }
            entries.insert(name);
        }
    }
    Ok(entries.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_patterns_are_anchored_bounded_and_refuse_non_files() {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("project-picori")
            .unwrap()
            .clone();
        port.persistent_paths.clear();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("tmc_test.sav"), b"save").unwrap();
        fs::write(root.path().join("tmc_test.sav.exe"), b"code").unwrap();
        fs::write(root.path().join("other.sav"), b"unrelated").unwrap();
        assert_eq!(entries(&port, &[root.path()]).unwrap(), ["tmc_test.sav"]);
        fs::create_dir(root.path().join("tmc_directory.sav")).unwrap();
        assert!(entries(&port, &[root.path()]).is_err());
        fs::remove_dir(root.path().join("tmc_directory.sav")).unwrap();
        for index in 0..MAX_MATCHING_FILES {
            fs::write(root.path().join(format!("tmc_{index}.sav")), b"save").unwrap();
        }
        assert!(
            entries(&port, &[root.path()])
                .unwrap_err()
                .message
                .contains("match limit")
        );
        for (prefix, suffix) in [
            ("", ".sav"),
            ("tmc_", ""),
            ("../tmc_", ".sav"),
            ("tmc_*", ".sav"),
            ("tmc_", ".sav/child"),
            ("profile_", ".exe"),
        ] {
            assert!(
                PersistentFilePattern {
                    prefix: prefix.into(),
                    suffix: suffix.into()
                }
                .validate()
                .is_err()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn filename_patterns_refuse_symlinks_without_reading_the_target() {
        let port = crate::Catalog::embedded()
            .unwrap()
            .port("project-picori")
            .unwrap()
            .clone();
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), b"untouched").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("tmc_link.sav")).unwrap();
        assert!(entries(&port, &[root.path()]).is_err());
        assert_eq!(fs::read(outside.path()).unwrap(), b"untouched");
    }
}
