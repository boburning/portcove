//! The destination-owned journal is also its gate against opening an incomplete import.
use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::{Catalog, LibraryImportPlan, PortcoveError, Result, transfer_journal::TransferPhase};

const JOURNAL: &str = ".portcove-import.json";
const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImportJournal {
    pub schema_version: u32,
    pub transfer_id: String,
    pub plan: LibraryImportPlan,
    pub phase: TransferPhase,
}

impl ImportJournal {
    pub fn read(root: &Path) -> Result<Option<Self>> {
        Self::read_path(root, &root.join(JOURNAL))
    }

    pub fn read_recovery(root: &Path) -> Result<Option<Self>> {
        if let Some(journal) = Self::read(root)? {
            return Ok(Some(journal));
        }
        Self::read_path(root, &root.join("recovery/library-import.json"))
    }

    fn read_path(root: &Path, path: &Path) -> Result<Option<Self>> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_BYTES as u64
        {
            return Err(PortcoveError::verification(
                "import journal is not a bounded regular file",
            ));
        }
        let journal: Self =
            serde_json::from_slice(&crate::path::read_bounded_regular(path, MAX_BYTES as u64)?)?;
        journal.validate(root)?;
        Ok(Some(journal))
    }

    fn validate(&self, root: &Path) -> Result<()> {
        if self.schema_version != 1
            || uuid::Uuid::parse_str(&self.transfer_id).is_err()
            || fs::canonicalize(root)? != self.plan.destination_root
            || self
                .plan
                .destination_root
                .starts_with(&self.plan.content_root)
            || self
                .plan
                .content_root
                .starts_with(&self.plan.destination_root)
            || crate::library_import::import_fingerprint(&self.plan)? != self.plan.plan_sha256
        {
            return Err(PortcoveError::verification(
                "import journal identity or location is invalid",
            ));
        }
        crate::library_import::validate_metadata(&self.plan.metadata, &Catalog::embedded()?)?;
        if self.plan.content.len() != self.plan.metadata.content_roots.len() {
            return Err(PortcoveError::verification(
                "import journal content roots are invalid",
            ));
        }
        for (tree, root) in self
            .plan
            .content
            .iter()
            .zip(&self.plan.metadata.content_roots)
        {
            if tree.kind != root.kind || tree.relative_path != root.relative_path {
                return Err(PortcoveError::verification(
                    "import journal content root changed",
                ));
            }
            for (path, directory) in tree.copy.directories.iter().map(|path| (path, true)).chain(
                tree.copy
                    .files
                    .iter()
                    .map(|file| (&file.relative_path, false)),
            ) {
                crate::archive::validate_relative_path(
                    &crate::portability::portable_relative(path)?,
                    directory,
                )?;
            }
        }
        Ok(())
    }

    pub fn write(&self, replace: bool) -> Result<()> {
        if serde_json::to_vec_pretty(self)?.len() > MAX_BYTES - 4096 {
            return Err(PortcoveError::unsupported(
                "import inventory exceeds the recoverable journal limit",
            ));
        }
        crate::durability::write_json_atomically(
            &self.plan.destination_root.join(JOURNAL),
            self,
            replace,
        )
    }

    pub fn archive(&self) -> Result<()> {
        let root = &self.plan.destination_root;
        let recovery = root.join("recovery");
        let metadata = fs::symlink_metadata(&recovery)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(PortcoveError::verification(
                "import recovery directory is not a real directory",
            ));
        }
        if let Some(previous) = Self::read_path(root, &recovery.join("library-import.json"))? {
            if previous.transfer_id != self.transfer_id {
                return Err(PortcoveError::conflict(
                    "an unrelated import recovery journal was retained",
                ));
            }
        }
        crate::durability::write_json_atomically(
            &recovery.join("library-import.json"),
            self,
            true,
        )?;
        fs::remove_file(root.join(JOURNAL))?;
        crate::durability::sync_publication(root)
    }

    pub fn error(&self, error: PortcoveError) -> PortcoveError {
        error
            .detail("transfer_id", &self.transfer_id)
            .detail(
                "import_destination",
                self.plan.destination_root.display().to_string(),
            )
            .detail("recovery_action", "resume_library_import")
    }
}

pub(crate) fn check_open(root: &Path) -> Result<()> {
    if let Some(journal) = ImportJournal::read(root)? {
        if !matches!(
            journal.phase,
            TransferPhase::Published | TransferPhase::Complete
        ) {
            return Err(journal.error(PortcoveError::conflict(
                if journal.phase == TransferPhase::Aborted {
                    "this incomplete import was aborted; copied data is retained"
                } else {
                    "library import needs recovery before this library can open"
                },
            )));
        }
    }
    Ok(())
}

/// Read-only review accepts an empty directory or an initialized, empty Portcove library.
pub(crate) fn ensure_empty_destination(root: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PortcoveError::verification(
            "import destination must be a real directory",
        ));
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| {
            PortcoveError::unsupported("import destination has a non-Unicode entry")
        })?;
        let kind = entry.file_type()?;
        let allowed = if kind.is_dir() {
            match name {
                "locks" | "logs" => true,
                "versions" | "user" | "backups" | "toolchains" | "staging" | "downloads"
                | "recovery" => fs::read_dir(entry.path())?.next().is_none(),
                _ => false,
            }
        } else {
            kind.is_file()
                && matches!(
                    name,
                    "portcove.sqlite3" | "portcove.sqlite3-wal" | "portcove.sqlite3-shm"
                )
        };
        if !allowed {
            return Err(PortcoveError::conflict(
                "import requires a new or empty library; existing data was retained",
            ));
        }
    }
    let path = root.join("portcove.sqlite3");
    if path.exists() {
        let connection = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        if !metadata_tables_empty(&connection)? {
            return Err(PortcoveError::conflict(
                "import cannot merge with an existing library",
            ));
        }
    }
    Ok(())
}

pub(crate) fn metadata_tables_empty(connection: &rusqlite::Connection) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT NOT (EXISTS(SELECT 1 FROM installs) OR EXISTS(SELECT 1 FROM sources)
         OR EXISTS(SELECT 1 FROM port_settings) OR EXISTS(SELECT 1 FROM launch_history)
         OR EXISTS(SELECT 1 FROM launch_sessions) OR EXISTS(SELECT 1 FROM lifecycle_operations))",
        [],
        |row| row.get(0),
    )?)
}
