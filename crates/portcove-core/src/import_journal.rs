//! The destination-owned journal is also its gate against opening an incomplete import.
use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::{
    LibraryImportPlan, LibraryRecoveryBundle, PortcoveError, PortcoveService, Result,
    transfer_journal::TransferPhase,
};

const JOURNAL: &str = ".portcove-import.json";
const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImportJournal {
    pub schema_version: u32,
    pub transfer_id: String,
    pub plan: LibraryImportPlan,
    pub phase: TransferPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<BundleImportAdmission>,
}

const BUNDLE_IMPORT_DOMAIN: &str = "portcove:recovery-bundle-import:v1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BundleImportAdmission {
    bundle_id: String,
    bundle_path: PathBuf,
    receipt_sha256: String,
    proof_sha256: String,
}

impl BundleImportAdmission {
    pub fn admit(
        bundle: &LibraryRecoveryBundle,
        plan_sha256: &str,
        transfer_id: &str,
    ) -> Result<Self> {
        let mut admission = Self {
            bundle_id: bundle.bundle_id.clone(),
            bundle_path: bundle.path.clone(),
            receipt_sha256: bundle.receipt_sha256.clone(),
            proof_sha256: String::new(),
        };
        admission.proof_sha256 = crate::portability_authority::sign_recovery_bundle(
            BUNDLE_IMPORT_DOMAIN,
            &admission.binding(plan_sha256, transfer_id),
        )?;
        Ok(admission)
    }

    fn binding<'a>(
        &'a self,
        plan_sha256: &'a str,
        transfer_id: &'a str,
    ) -> (&'a str, &'a Path, &'a str, &'a str, &'a str) {
        (
            &self.bundle_id,
            &self.bundle_path,
            &self.receipt_sha256,
            plan_sha256,
            transfer_id,
        )
    }

    fn verify(&self, plan_sha256: &str, transfer_id: &str) -> Result<()> {
        crate::portability_authority::verify_recovery_bundle(
            BUNDLE_IMPORT_DOMAIN,
            &self.binding(plan_sha256, transfer_id),
            &self.proof_sha256,
        )
    }

    fn verify_input(&self) -> Result<()> {
        let current = PortcoveService::inspect_library_recovery_bundle(&self.bundle_path)?;
        if current.path != self.bundle_path
            || current.bundle_id != self.bundle_id
            || current.receipt_sha256 != self.receipt_sha256
        {
            return Err(PortcoveError::verification(
                "recovery bundle no longer matches the interrupted restore",
            ));
        }
        Ok(())
    }
}

pub(crate) fn recovery_restore_fingerprint(
    bundle_path: &Path,
    receipt_sha256: &str,
    import_plan_sha256: &str,
) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        "portcove-library-recovery-restore-v1",
        bundle_path,
        receipt_sha256,
        import_plan_sha256,
    ))?)))
}

impl ImportJournal {
    /// Rediscover the selected bundle's operation at a known destination without
    /// acquiring a transfer lease or opening the destination for mutation.
    pub fn review_bundle_recovery(
        destination: &Path,
        selected: &LibraryRecoveryBundle,
    ) -> Option<PortcoveError> {
        crate::path::refuse_symlink_ancestors(&std::path::absolute(destination).ok()?).ok()?;
        let destination = fs::canonicalize(destination).ok()?;
        let journal = Self::read_recovery(&destination).ok()??;
        let bundle = journal.bundle.as_ref()?;
        if journal.plan.destination_root != destination
            || bundle.bundle_id != selected.bundle_id
            || bundle.bundle_path != selected.path
            || bundle.receipt_sha256 != selected.receipt_sha256
            || [&bundle.bundle_path, &journal.plan.metadata.original_root]
                .iter()
                .any(|root| destination.starts_with(root) || root.starts_with(&destination))
        {
            return None;
        }
        let action = match journal.phase {
            TransferPhase::Published | TransferPhase::Complete => {
                let plan = recovery_restore_fingerprint(
                    &bundle.bundle_path,
                    &bundle.receipt_sha256,
                    &journal.plan.plan_sha256,
                )
                .ok()?;
                PortcoveError::conflict(
                    "This bundle was restored to this folder. Check the recorded restore result.",
                )
                .detail("recovery_action", "read_published_recovery_restore")
                .detail("import_destination", destination.display().to_string())
                .detail("transfer_id", &journal.transfer_id)
                .detail("recovery_restore_plan_sha256", plan)
            }
            TransferPhase::Copying | TransferPhase::Verified => journal.error(
                PortcoveError::conflict("An interrupted restore is waiting in this folder."),
            ),
            TransferPhase::Aborted => return None,
        };
        Some(
            action
                .detail("recovery_bundle_id", &bundle.bundle_id)
                .detail("recovery_bundle_receipt_sha256", &bundle.receipt_sha256)
                .detail(
                    "recovery_bundle_path",
                    bundle.bundle_path.display().to_string(),
                ),
        )
    }

    pub fn require_published_bundle_review(&self, expected_plan: &str) -> Result<()> {
        let bundle = self.bundle.as_ref().ok_or_else(|| {
            PortcoveError::conflict("this destination belongs to a manual library import")
        })?;
        let reviewed = recovery_restore_fingerprint(
            &bundle.bundle_path,
            &bundle.receipt_sha256,
            &self.plan.plan_sha256,
        )?;
        if reviewed != expected_plan {
            return Err(PortcoveError::conflict(
                "the destination belongs to a different restore review",
            ));
        }
        match self.phase {
            TransferPhase::Published | TransferPhase::Complete => Ok(()),
            TransferPhase::Copying | TransferPhase::Verified => Err(self.error(
                PortcoveError::conflict("the reviewed restore has not finished"),
            )),
            TransferPhase::Aborted => {
                Err(PortcoveError::conflict("the reviewed restore was stopped"))
            }
        }
    }

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
        if self.schema_version != u32::from(self.bundle.is_some()) + 1
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
        if let Some(bundle) = &self.bundle {
            bundle.verify(&self.plan.plan_sha256, &self.transfer_id)?;
        }
        if matches!(
            self.phase,
            TransferPhase::Published | TransferPhase::Complete
        ) {
            verify_publication_record(root, &self.transfer_id, self.publication_binding())?;
        }
        let contract_root = if matches!(
            self.phase,
            TransferPhase::Published | TransferPhase::Complete
        ) {
            &self.plan.destination_root
        } else {
            &self.plan.content_root
        };
        let catalogs = crate::library_import::PortabilityCatalogs::from_root(
            &self.plan.metadata,
            contract_root,
        )?;
        crate::library_import::validate_metadata(&self.plan.metadata, &catalogs)?;
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
                crate::portable_tree::validate_relative_path(
                    &crate::portability::portable_relative(path)?,
                    directory,
                )?;
            }
        }
        Ok(())
    }

    pub fn publication_binding(&self) -> &str {
        self.bundle
            .as_ref()
            .map_or(&self.plan.plan_sha256, |bundle| &bundle.proof_sha256)
    }

    pub fn verify_bundle_input(&self) -> Result<()> {
        if let Some(bundle) = &self.bundle {
            bundle.verify_input()?;
        }
        Ok(())
    }

    pub fn require_recovery_kind(
        &self,
        bundle: bool,
        expected_transfer_id: Option<&str>,
    ) -> Result<()> {
        if expected_transfer_id.is_some_and(|expected| expected != self.transfer_id) {
            return Err(PortcoveError::conflict(
                "the interrupted restore changed; review the current recovery",
            ));
        }
        if self.bundle.is_some() != bundle {
            return Err(if bundle {
                PortcoveError::conflict("this destination belongs to a manual library import")
            } else {
                self.error(PortcoveError::conflict(
                    "this destination belongs to a recovery bundle restore",
                ))
            });
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
        if let Some(previous) = Self::read_path(root, &recovery.join("library-import.json"))?
            && previous.transfer_id != self.transfer_id
        {
            return Err(PortcoveError::conflict(
                "an unrelated import recovery journal was retained",
            ));
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
            .detail(
                "recovery_action",
                if self.bundle.is_some() {
                    "resume_library_recovery_restore"
                } else {
                    "resume_library_import"
                },
            )
    }
}

fn verify_publication_record(root: &Path, transfer_id: &str, plan_sha256: &str) -> Result<()> {
    let connection = rusqlite::Connection::open_with_flags(
        root.join("portcove.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let record = connection
        .query_row(
            "SELECT status, operation, target_kind, target_id, import_receipt_sha256
             FROM activity_history WHERE id=?1",
            [transfer_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    if record
        .as_ref()
        .map(|(status, operation, kind, target_id, receipt)| {
            (
                status.as_str(),
                operation.as_str(),
                kind.as_str(),
                target_id.as_deref(),
                receipt.as_deref(),
            )
        })
        != Some((
            "succeeded",
            "import_library",
            "library",
            None,
            Some(plan_sha256),
        ))
    {
        return Err(PortcoveError::verification(
            "published import has no matching verified publication record",
        ));
    }
    Ok(())
}

pub(crate) fn check_open(root: &Path) -> Result<()> {
    if let Some(journal) = ImportJournal::read(root)?
        && !matches!(
            journal.phase,
            TransferPhase::Published | TransferPhase::Complete
        )
    {
        return Err(journal.error(PortcoveError::conflict(
            if journal.phase == TransferPhase::Aborted {
                "this incomplete import was aborted; copied data is retained"
            } else {
                "library import needs recovery before this library can open"
            },
        )));
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
                "versions" | "user" | "source-inbox" | "backups" | "toolchains" | "staging"
                | "downloads" | "recovery" | "artwork" | "artwork-cache" => {
                    fs::read_dir(entry.path())?.next().is_none()
                }
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
            )
            .detail("import_destination_state", "occupied"));
        }
    }
    let path = root.join("portcove.sqlite3");
    if path.exists() {
        let connection = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        if !metadata_tables_empty(&connection)? {
            return Err(
                PortcoveError::conflict("import cannot merge with an existing library")
                    .detail("import_destination_state", "occupied"),
            );
        }
    }
    Ok(())
}

pub(crate) fn metadata_tables_empty(connection: &rusqlite::Connection) -> Result<bool> {
    let has_retained_build_references: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='retained_build_references')",
        [],
        |row| row.get(0),
    )?;
    if has_retained_build_references {
        let occupied: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM retained_build_references)",
            [],
            |row| row.get(0),
        )?;
        if occupied {
            return Ok(false);
        }
    }
    let has_source_instances: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_instances')",
        [],
        |row| row.get(0),
    )?;
    if has_source_instances
        && connection.query_row("SELECT EXISTS(SELECT 1 FROM source_instances)", [], |row| {
            row.get::<_, bool>(0)
        })?
    {
        return Ok(false);
    }
    if crate::profile::any_profiles(connection)? {
        return Ok(false);
    }
    if crate::library_membership::any_memberships(connection)? {
        return Ok(false);
    }
    let has_artwork: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='artwork_assets')",
        [],
        |row| row.get(0),
    )?;
    if has_artwork {
        let occupied: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM artwork_assets) OR EXISTS(SELECT 1 FROM artwork_choices)",
            [],
            |row| row.get(0),
        )?;
        if occupied {
            return Ok(false);
        }
    }
    Ok(connection.query_row(
        "SELECT NOT (EXISTS(SELECT 1 FROM installs) OR EXISTS(SELECT 1 FROM sources)
         OR EXISTS(SELECT 1 FROM port_settings) OR EXISTS(SELECT 1 FROM launch_history)
         OR EXISTS(SELECT 1 FROM launch_sessions) OR EXISTS(SELECT 1 FROM lifecycle_operations))",
        [],
        |row| row.get(0),
    )?)
}
