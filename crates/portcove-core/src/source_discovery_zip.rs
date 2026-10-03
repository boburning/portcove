//! Scan-local ZIP facts feed the same matcher as manual file-set inspection.
use crate::source_inspection::HashedNamedSource;
use crate::{Catalog, PortcoveError, Result, SourceInspection, source_file::HashBudget};
use std::{collections::BTreeMap, fs::File, path::Path};

pub(super) struct ZipFileSet {
    archive: zip::ZipArchive<File>,
    members: Vec<(usize, String)>,
    identities: BTreeMap<usize, HashedNamedSource>,
    storage: (String, u64),
}

impl ZipFileSet {
    pub(super) fn open(
        path: &Path,
        catalog: &Catalog,
        profile_ids: &[&str],
        maximum: u64,
        budget: &mut HashBudget,
    ) -> Result<Option<Self>> {
        validate_location(path)?;
        Self::open_file(File::open(path)?, catalog, profile_ids, maximum, budget)
    }

    pub(super) fn open_file(
        file: File,
        catalog: &Catalog,
        profile_ids: &[&str],
        maximum: u64,
        budget: &mut HashBudget,
    ) -> Result<Option<Self>> {
        let expected = file.metadata()?.len();
        // A duplicate handle retains this artifact even if its pathname changes.
        // The storage pass rewinds it; by_index seeks before each member read.
        let storage_file = file.try_clone()?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|error| PortcoveError::source(format!("invalid file-set ZIP: {error}")))?;
        if archive.len() > budget.max_zip_entries {
            return Err(PortcoveError::source(
                "source ZIP has too many entries for discovery",
            ));
        }
        let mut members = Vec::new();
        for index in 0..archive.len() {
            if let Some(operation) = &budget.operation {
                operation.checkpoint()?;
            }
            let entry = archive.by_index(index).map_err(|error| {
                PortcoveError::source(format!("invalid file-set ZIP entry: {error}"))
            })?;
            let name = entry
                .enclosed_name()
                .ok_or_else(|| PortcoveError::source("file-set ZIP contains an unsafe path"))?;
            // Discovery never treats an archive symlink as game bytes.
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(PortcoveError::source("file-set ZIP contains a symlink"));
            }
            if entry.is_dir() || name.components().count() != 1 {
                continue;
            }
            if let Some(name) = name.file_name().and_then(|name| name.to_str()) {
                members.push((index, name.to_owned()));
            }
        }
        let names = members
            .iter()
            .map(|(_, name)| name.clone())
            .collect::<Vec<_>>();
        if !profile_ids
            .iter()
            .any(|id| crate::source_inspection::file_set_names_are_complete(catalog, id, &names))
        {
            return Ok(None);
        }
        let storage =
            crate::source_file::read_storage_identity(storage_file, expected, maximum, budget)?;
        Ok(Some(Self {
            archive,
            members,
            identities: BTreeMap::new(),
            storage,
        }))
    }

    pub(super) fn inspect(
        &mut self,
        catalog: &Catalog,
        profile_id: &str,
        path: &Path,
        maximum: u64,
        budget: &mut HashBudget,
    ) -> Result<SourceInspection> {
        let names = self
            .members
            .iter()
            .map(|(_, name)| name.clone())
            .collect::<Vec<_>>();
        let inspection = crate::source_inspection::inspect_observed_zip_file_set(
            catalog,
            profile_id,
            path,
            &names,
            self.storage.clone(),
            &mut |accepted| self.member(accepted, maximum, budget),
        )?;
        validate_location(path)?;
        if std::fs::metadata(path)?.len() != self.storage.1 {
            return Err(PortcoveError::source(
                "source container changed after inspection",
            ));
        }
        Ok(inspection)
    }

    fn member(
        &mut self,
        accepted: &[String],
        maximum: u64,
        budget: &mut HashBudget,
    ) -> Result<Option<HashedNamedSource>> {
        let selected = self
            .members
            .iter()
            .filter(|(_, name)| {
                accepted
                    .iter()
                    .any(|expected| expected.eq_ignore_ascii_case(name))
            })
            .collect::<Vec<_>>();
        let [(index, name)] = selected.as_slice() else {
            return Ok(None);
        };
        if let Some(identity) = self.identities.get(index) {
            return Ok(Some(identity.clone()));
        }
        let (sha1, sha256, crc32, size) =
            crate::source_file::read_zip_member_hashes(&mut self.archive, *index, maximum, budget)?;
        let identity = HashedNamedSource {
            name: name.clone(),
            sha1,
            sha256,
            crc32,
            size,
        };
        self.identities.insert(*index, identity.clone());
        Ok(Some(identity))
    }
}

fn validate_location(path: &Path) -> Result<()> {
    if !std::fs::symlink_metadata(path)?.is_file() || std::fs::canonicalize(path)? != path {
        return Err(PortcoveError::source(
            "source ZIP moved outside its scanned location",
        ));
    }
    Ok(())
}
