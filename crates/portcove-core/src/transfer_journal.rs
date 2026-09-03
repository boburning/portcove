use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{LibraryMovePlan, PortcoveError, Result};

const JOURNAL: &str = "library-move.json";
const MAX_JOURNAL_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TransferPhase {
    Copying,
    Verified,
    Published,
    Complete,
    Aborted,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TransferJournal {
    pub schema_version: u32,
    pub transfer_id: String,
    pub plan: LibraryMovePlan,
    pub phase: TransferPhase,
}

impl TransferJournal {
    pub fn read(source: &Path) -> Result<Self> {
        validate_recovery_directory(source)?;
        let path = source.join("recovery").join(JOURNAL);
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_JOURNAL_BYTES as u64
        {
            return Err(PortcoveError::state(
                "library move journal is not a bounded regular file",
            ));
        }
        let journal: Self = serde_json::from_slice(&crate::path::read_bounded_regular(
            &path,
            MAX_JOURNAL_BYTES as u64,
        )?)?;
        journal.validate(source)?;
        Ok(journal)
    }

    fn validate(&self, source: &Path) -> Result<()> {
        let destination = &self.plan.destination_root;
        let actual_destination = crate::path::resolve_existing_ancestor(destination)?;
        if self.schema_version != 1
            || uuid::Uuid::parse_str(&self.transfer_id).is_err()
            || self.plan.source_root != fs::canonicalize(source)?
            || actual_destination != *destination
            || destination.starts_with(source)
            || source.starts_with(destination)
            || crate::library_transfer::move_fingerprint(&self.plan)? != self.plan.plan_sha256
        {
            return Err(PortcoveError::verification(
                "library move journal identity or destination is invalid",
            ));
        }
        let expected = ["versions", "user", "backups", "toolchains"];
        if self.plan.content.len() != expected.len()
            || self
                .plan
                .content
                .iter()
                .zip(expected)
                .any(|(tree, expected)| tree.relative_path != expected)
        {
            return Err(PortcoveError::verification(
                "library move journal has unexpected content roots",
            ));
        }
        for tree in &self.plan.content {
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
        for install in &self.plan.metadata.application_versions {
            let relative = crate::portability::portable_relative(&install.path)?;
            crate::archive::validate_relative_path(&relative, true)?;
            if !relative.starts_with("versions/") {
                return Err(PortcoveError::verification(
                    "library installation is outside its application tree",
                ));
            }
        }
        Ok(())
    }

    pub fn create(&self) -> Result<()> {
        if serde_json::to_vec_pretty(self)?.len() > MAX_JOURNAL_BYTES - 4096 {
            return Err(PortcoveError::unsupported(
                "library move inventory exceeds the recoverable journal size limit",
            ));
        }
        let recovery = self.plan.source_root.join("recovery");
        fs::create_dir_all(&recovery)?;
        validate_recovery_directory(&self.plan.source_root)?;
        let path = recovery.join(JOURNAL);
        if path.exists() {
            let previous = Self::read(&self.plan.source_root)?;
            if !matches!(
                previous.phase,
                TransferPhase::Complete | TransferPhase::Aborted
            ) {
                return Err(PortcoveError::conflict(
                    "a previous library move needs recovery",
                ));
            }
            // Retain the prior journal together with its data; never replace ambiguous state.
            let archive = recovery.join(format!("library-move-{}.json", previous.transfer_id));
            crate::durability::write_json_atomically(&archive, &previous, false)?;
        }
        self.write()
    }

    pub fn write(&self) -> Result<()> {
        if serde_json::to_vec_pretty(self)?.len() > MAX_JOURNAL_BYTES {
            return Err(PortcoveError::unsupported(
                "library move journal exceeds its size limit",
            ));
        }
        validate_recovery_directory(&self.plan.source_root)?;
        crate::durability::write_json_atomically(&self.path(), self, true)
    }

    fn path(&self) -> PathBuf {
        self.plan.source_root.join("recovery").join(JOURNAL)
    }
}

fn validate_recovery_directory(source: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source.join("recovery"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PortcoveError::verification(
            "library recovery directory must be a real directory",
        ));
    }
    Ok(())
}
