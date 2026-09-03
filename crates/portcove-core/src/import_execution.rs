use std::{fs, path::Path, sync::Arc};

use rusqlite::OptionalExtension;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ActivityOperation, ActivityStatus, ActivityTargetKind, Catalog, InstallQualification,
    Installer, Library, LibraryImportPlan, LibraryMetadata, Platform, PortcoveError,
    PortcoveService, Result,
    import_journal::ImportJournal,
    library_access::{LibraryAccess, LibraryLease},
    transfer_journal::TransferPhase,
};

#[cfg(test)]
#[path = "import_execution_tests.rs"]
mod tests;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LibraryImportResult {
    pub transfer_id: String,
    pub destination_root: std::path::PathBuf,
    pub completed: bool,
    pub input_retained: bool,
}

impl PortcoveService {
    pub fn import_library(
        metadata: &Path,
        content: &Path,
        destination: &Path,
        expected_plan: &str,
    ) -> Result<LibraryImportResult> {
        start_import(metadata, content, destination, expected_plan, &|_| Ok(()))
    }

    pub fn resume_library_import(destination: &Path) -> Result<LibraryImportResult> {
        recover_import(destination, false)
    }

    /// Retain and gate incomplete copies. This never deletes input or destination data.
    pub fn abort_library_import(destination: &Path) -> Result<LibraryImportResult> {
        recover_import(destination, true)
    }
}

fn start_import(
    metadata: &Path,
    content: &Path,
    destination: &Path,
    expected_plan: &str,
    checkpoint: &dyn Fn(TransferPhase) -> Result<()>,
) -> Result<LibraryImportResult> {
    let plan = PortcoveService::plan_library_import(metadata, content, destination)?;
    if plan.plan_sha256 != expected_plan {
        return Err(PortcoveError::conflict(
            "library import plan changed; review it again",
        ));
    }
    if !plan.destination_exists {
        // create_dir is exclusive; never claim a directory that appeared after review.
        fs::create_dir(&plan.destination_root)?;
    }
    let metadata = fs::symlink_metadata(&plan.destination_root)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || fs::canonicalize(&plan.destination_root)? != plan.destination_root
    {
        return Err(PortcoveError::verification(
            "import destination was replaced or redirected",
        ));
    }
    let lease = Arc::new(LibraryLease::with_access(
        &plan.destination_root,
        LibraryAccess::Exclusive,
    )?);
    crate::import_journal::ensure_empty_destination(&plan.destination_root)?;
    let mut journal = ImportJournal {
        schema_version: 1,
        transfer_id: uuid::Uuid::new_v4().to_string(),
        plan,
        phase: TransferPhase::Copying,
    };
    verify_input(&journal.plan)?;
    // Intent and open gate are one durable file, written before database initialization or copying.
    journal.write(false)?;
    crate::durability::sync_publication(
        journal
            .plan
            .destination_root
            .parent()
            .ok_or_else(|| PortcoveError::state("import destination has no parent"))?,
    )?;
    let target = Library::initialize(journal.plan.destination_root.clone(), lease)?;
    continue_import(&target, &mut journal, checkpoint).map_err(|error| journal.error(error))
}

fn recover_import(destination: &Path, abort: bool) -> Result<LibraryImportResult> {
    let destination = fs::canonicalize(destination)?;
    if crate::library_authority::authority(&destination)?.is_some() {
        return Err(PortcoveError::conflict(
            "library has a move authority marker; recover that transfer first",
        ));
    }
    // Verify that this root belongs to an import before creating any control files.
    if ImportJournal::read_recovery(&destination)?.is_none() {
        return Err(PortcoveError::state(
            "no library import journal exists at this destination",
        ));
    }
    let lease = Arc::new(LibraryLease::with_access(
        &destination,
        LibraryAccess::Exclusive,
    )?);
    let mut journal = ImportJournal::read_recovery(&destination)?.ok_or_else(|| {
        PortcoveError::state("no library import journal exists at this destination")
    })?;
    if journal.phase == TransferPhase::Aborted {
        return if abort {
            Ok(result(&journal, false))
        } else {
            Err(journal.error(PortcoveError::conflict(
                "this import was aborted; choose a new destination",
            )))
        };
    }
    let target = Library::initialize(destination, lease)?;
    if abort {
        if matches!(
            journal.phase,
            TransferPhase::Published | TransferPhase::Complete
        ) {
            return Err(PortcoveError::conflict(
                "import already reached publication; resume its bookkeeping",
            ));
        }
        ensure_activity(&target, &journal)?;
        target.finish_activity_once(
            &journal.transfer_id,
            ActivityStatus::Failed,
            "Library import aborted; original and copied data retained",
        )?;
        journal.phase = TransferPhase::Aborted;
        journal.write(true)?;
        Ok(result(&journal, false))
    } else {
        continue_import(&target, &mut journal, &|_| Ok(())).map_err(|error| journal.error(error))
    }
}

fn continue_import(
    target: &Library,
    journal: &mut ImportJournal,
    checkpoint: &dyn Fn(TransferPhase) -> Result<()>,
) -> Result<LibraryImportResult> {
    if journal.phase == TransferPhase::Complete {
        if ImportJournal::read(target.root())?.is_some() {
            journal.archive()?;
        }
        return Ok(result(journal, true));
    }
    let status = ensure_activity(target, journal)?;
    if status != ActivityStatus::Running
        && !(journal.phase == TransferPhase::Published && status == ActivityStatus::Succeeded)
    {
        return Err(PortcoveError::conflict(
            "import activity reached a different terminal outcome; finish aborting the import",
        ));
    }
    if journal.phase == TransferPhase::Published {
        // The restored library may already contain new saves. Never copy or reimport its old snapshot.
        return finish_import(target, journal);
    }
    checkpoint(TransferPhase::Copying)?;
    verify_input(&journal.plan)?;
    crate::transfer_copy::copy_content(
        &journal.plan.content_root,
        target.root(),
        &journal.plan.content,
    )?;
    restore_metadata(target, &journal.plan.metadata)?;
    crate::transfer_copy::verify_destination(
        target,
        &journal.plan.metadata,
        &journal.plan.content,
    )?;
    let catalog = Catalog::embedded()?;
    let installer = Installer::new(target.clone())?;
    for install in target.all_installs()? {
        let qualification =
            InstallQualification::from_port(catalog.port(&install.port_id)?, Platform::current()?)?;
        installer.verify_import_contract(&install, &qualification)?;
    }
    verify_input(&journal.plan)?;
    journal.phase = TransferPhase::Verified;
    journal.write(true)?;
    checkpoint(TransferPhase::Verified)?;
    // This single write changes the open gate; no cancellation or fallible copying occurs inside publication.
    journal.phase = TransferPhase::Published;
    journal.write(true)?;
    checkpoint(TransferPhase::Published)?;
    finish_import(target, journal)
}

fn finish_import(target: &Library, journal: &mut ImportJournal) -> Result<LibraryImportResult> {
    target.finish_activity_once(
        &journal.transfer_id,
        ActivityStatus::Succeeded,
        "Library import verified and opened; input backup retained",
    )?;
    journal.phase = TransferPhase::Complete;
    journal.write(true)?;
    journal.archive()?;
    Ok(result(journal, true))
}

fn ensure_activity(target: &Library, journal: &ImportJournal) -> Result<ActivityStatus> {
    let activity = target
        .connection()?
        .query_row(
            "SELECT status, operation, target_kind FROM activity_history WHERE id=?1",
            [&journal.transfer_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    if let Some((status, operation, kind)) = activity {
        if operation != "import_library" || kind != "library" {
            return Err(PortcoveError::verification(
                "import activity identity belongs to another operation",
            ));
        }
        status.parse()
    } else {
        if journal.phase != TransferPhase::Copying {
            return Err(PortcoveError::verification(
                "published import lost its activity identity",
            ));
        }
        target.begin_identified_activity(
            uuid::Uuid::parse_str(&journal.transfer_id)
                .map_err(|_| PortcoveError::state("invalid import ID"))?,
            ActivityOperation::ImportLibrary,
            ActivityTargetKind::Library,
            None,
        )?;
        Ok(ActivityStatus::Running)
    }
}

fn restore_metadata(target: &Library, metadata: &LibraryMetadata) -> Result<()> {
    let mut connection = target.connection()?;
    let transaction = connection.transaction()?;
    if !crate::import_journal::metadata_tables_empty(&transaction)? {
        drop(transaction);
        return crate::transfer_copy::verify_metadata(target, metadata);
    }
    for source in &metadata.source_references {
        Library::write_source(&transaction, source)?;
    }
    for original in &metadata.application_versions {
        let mut install = original.clone();
        install.path = target.root().join(&install.path);
        Library::write_install(&transaction, &install, install.staged)?;
    }
    for settings in &metadata.port_settings {
        transaction.execute("INSERT INTO port_settings(port_id, channel, update_policy, active_install_id, previous_install_id) VALUES (?1, ?2, ?3, ?4, ?5)", rusqlite::params![settings.port_id, settings.channel.to_string(), settings.update_policy.to_string(), settings.active_install_id, settings.previous_install_id])?;
    }
    for launch in &metadata.launch_history {
        transaction.execute("INSERT INTO launch_history(port_id, last_launched_at, successful_launches) VALUES (?1, ?2, ?3)", rusqlite::params![launch.port_id, launch.last_launched_at, launch.successful_launches])?;
    }
    transaction.commit()?;
    Ok(())
}

fn verify_input(plan: &LibraryImportPlan) -> Result<()> {
    let (file, _) = crate::library_import::read_metadata(&plan.metadata_file.path)?;
    if file.sha256 != plan.metadata_file.sha256 || file.size != plan.metadata_file.size {
        return Err(PortcoveError::verification(
            "metadata export changed after import review",
        ));
    }
    for tree in &plan.content {
        let actual =
            crate::library_transfer::reviewed_tree(&plan.content_root.join(&tree.relative_path))?;
        if serde_json::to_value(actual)? != serde_json::to_value(&tree.copy)? {
            return Err(
                PortcoveError::verification("import content changed after review")
                    .detail("content_root", &tree.relative_path),
            );
        }
    }
    Ok(())
}

fn result(journal: &ImportJournal, completed: bool) -> LibraryImportResult {
    LibraryImportResult {
        transfer_id: journal.transfer_id.clone(),
        destination_root: journal.plan.destination_root.clone(),
        completed,
        input_retained: true,
    }
}
