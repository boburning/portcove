use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

use sha2::{Digest, Sha256};

use crate::{
    AdoptionCopyPlan, Library, LibraryMetadata, LibraryMovePlan, LibraryTreePlan, PortcoveError,
    Result,
};

/// Recheck names at an authority/publication boundary without rereading payloads.
pub(crate) fn refuse_sensitive_content(
    source: &Path,
    destination: &Path,
    content: &[LibraryTreePlan],
) -> Result<()> {
    for tree in content {
        crate::runtime_data_policy::refuse_sensitive_tree(&source.join(&tree.relative_path))?;
        crate::runtime_data_policy::refuse_sensitive_tree(&destination.join(&tree.relative_path))?;
    }
    Ok(())
}

pub(crate) fn copy_content(
    source_root: &Path,
    destination_root: &Path,
    content: &[LibraryTreePlan],
) -> Result<()> {
    let work = destination_root.join(".portcove-transfer-work");
    ensure_directory(&work)?;
    for tree in content {
        let source = source_root.join(&tree.relative_path);
        let destination = destination_root.join(&tree.relative_path);
        copy_reviewed_tree(&source, &destination, &tree.copy, &work)?;
    }
    Ok(())
}

pub(crate) fn copy_reviewed_tree(
    source: &Path,
    destination: &Path,
    plan: &AdoptionCopyPlan,
    work: &Path,
) -> Result<()> {
    crate::runtime_data_policy::refuse_sensitive_tree(source)?;
    crate::runtime_data_policy::refuse_sensitive_tree(destination)?;
    ensure_directory(work)?;
    ensure_directory(destination)?;
    for relative in &plan.directories {
        crate::runtime_data_policy::refuse_sensitive_entry(&source.join(relative))?;
        crate::runtime_data_policy::refuse_sensitive_entry(&destination.join(relative))?;
        ensure_directory(&destination.join(relative))?;
    }
    for file in &plan.files {
        let target = destination.join(&file.relative_path);
        let origin = source.join(&file.relative_path);
        crate::runtime_data_policy::refuse_sensitive_entry(&origin)?;
        crate::runtime_data_policy::refuse_sensitive_entry(&target)?;
        regular_file(&origin)?;
        let mut input = crate::external_runtime::open_single_link_file(&origin)?;
        let before = input.metadata()?;
        if fs::symlink_metadata(&target).is_ok() {
            let existing = crate::external_runtime::open_single_link_file(&target)?;
            let target_before = existing.metadata()?;
            verify_file(&origin, file.size, &file.sha256)?;
            verify_file(&target, file.size, &file.sha256)?;
            recheck_copy_file(&origin, &input, &before)?;
            recheck_copy_file(&target, &existing, &target_before)?;
            if target_before.modified()? != before.modified()? {
                return Err(PortcoveError::verification(
                    "an existing destination file has different modification time; both copies have been retained",
                ).detail("path", target.display().to_string()));
            }
            continue;
        }
        let mut output = tempfile::NamedTempFile::new_in(work)?;
        let mut digest = Sha256::new();
        let mut size = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            size += read as u64;
            if size > file.size {
                return Err(PortcoveError::verification(
                    "reviewed file grew while copying",
                ));
            }
            digest.update(&buffer[..read]);
            output.write_all(&buffer[..read])?;
        }
        if size != file.size || hex::encode(digest.finalize()) != file.sha256 {
            return Err(PortcoveError::verification(
                "reviewed file changed while copying",
            ));
        }
        recheck_copy_file(&origin, &input, &before)?;
        crate::runtime_data_policy::preserve_modified_time(output.as_file(), &before)?;
        output.as_file().set_permissions(before.permissions())?;
        output.as_file().sync_all()?;
        recheck_copy_file(&origin, &input, &before)?;
        output
            .persist_noclobber(&target)
            .map_err(|error| PortcoveError::from(error.error))?;
        crate::durability::sync_publication(
            target
                .parent()
                .ok_or_else(|| PortcoveError::state("copy target has no parent"))?,
        )?;
    }
    Ok(())
}

fn recheck_copy_file(path: &Path, file: &fs::File, before: &fs::Metadata) -> Result<()> {
    let current = crate::external_runtime::open_single_link_file(path)?;
    let after = file.metadata()?;
    if after.len() != before.len()
        || after.modified()? != before.modified()?
        || same_file::Handle::from_file(file.try_clone()?)?
            != same_file::Handle::from_file(current)?
    {
        return Err(PortcoveError::verification(
            "reviewed file identity or metadata changed while copying",
        )
        .detail("path", path.display().to_string()));
    }
    Ok(())
}

pub(crate) fn verify_reviewed_tree(root: &Path, expected: &AdoptionCopyPlan) -> Result<()> {
    let actual = crate::library_transfer::reviewed_tree(root)?;
    if &actual != expected {
        return Err(PortcoveError::verification(
            "copied application differs from the reviewed source tree",
        )
        .detail("path", root.display().to_string()));
    }
    Ok(())
}

pub(crate) fn copy_database(library: &Library, plan: &LibraryMovePlan) -> Result<()> {
    let destination = plan.destination_root.join("portcove.sqlite3");
    if destination.exists() {
        regular_file(&destination)?;
        return Ok(());
    }
    let temporary =
        tempfile::NamedTempFile::new_in(plan.destination_root.join(".portcove-transfer-work"))?;
    library.connection()?.execute(
        "VACUUM INTO ?1",
        [crate::path::unicode(
            temporary.path(),
            "library database snapshot",
        )?],
    )?;
    {
        let mut database = rusqlite::Connection::open(temporary.path())?;
        let transaction = database.transaction()?;
        for install in &plan.metadata.application_versions {
            let changed = transaction.execute(
                "UPDATE installs SET path=?2 WHERE id=?1",
                rusqlite::params![
                    install.id,
                    crate::path::unicode(
                        &plan.destination_root.join(&install.path),
                        "moved installation"
                    )?
                ],
            )?;
            if changed != 1 {
                return Err(PortcoveError::verification(
                    "database snapshot lost an installation",
                ));
            }
        }
        transaction.commit()?;
    }
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(destination)
        .map_err(|error| PortcoveError::from(error.error))?;
    crate::durability::sync_publication(&plan.destination_root)
}

pub(crate) fn verify_destination(
    library: &Library,
    expected_metadata: &LibraryMetadata,
    content: &[LibraryTreePlan],
) -> Result<()> {
    let destination_root = library.root();
    crate::artwork_store::validate_transfer_inventory(expected_metadata, content)?;
    for tree in content {
        let copy =
            crate::library_transfer::reviewed_tree(&destination_root.join(&tree.relative_path))?;
        if serde_json::to_value(&copy)? != serde_json::to_value(&tree.copy)? {
            return Err(PortcoveError::verification(
                "destination contents differ from the reviewed library copy",
            )
            .detail("content_root", &tree.relative_path));
        }
    }
    verify_metadata(library, expected_metadata)?;
    let catalogs =
        crate::library_import::PortabilityCatalogs::from_root(expected_metadata, destination_root)?;
    if let Some(artwork) = &expected_metadata.artwork {
        for asset in &artwork.assets {
            let bytes = crate::artwork::original_bytes(library, asset)?;
            let decoded = crate::artwork_image::decode(&bytes)?;
            if decoded.format != asset.format
                || decoded.width != asset.width
                || decoded.height != asset.height
            {
                return Err(PortcoveError::verification(
                    "artwork payload differs from its declared image contract",
                ));
            }
        }
    }
    let database = library.connection()?;
    let integrity: String = database.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    let foreign_keys: u64 =
        database.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    if integrity != "ok" || foreign_keys != 0 {
        return Err(PortcoveError::verification(
            "destination database integrity check failed",
        ));
    }
    let installer = crate::install::Installer::new(library.clone())?;
    let platform = crate::Platform::current()?;
    for relative in &expected_metadata.application_versions {
        let mut install = relative.clone();
        install.path = destination_root.join(&install.path);
        let retained = catalogs
            .catalog_for_install(relative)?
            .port(&install.port_id)?;
        // Transfer retains its historical catalog authority. Apply the same
        // checked runtime interpretation as service operations, without using
        // current catalog facts or changing any copied manifest bytes.
        let interpreted = crate::installed_mutability::checked_port(
            &installer, &install, retained, retained, platform,
        )?;
        let qualification = crate::InstallQualification::from_port(&interpreted, platform)?;
        let report = installer.verify_managed(&install, &qualification)?;
        if !report.valid {
            return Err(PortcoveError::verification(
                "copied application failed immutable manifest verification",
            )
            .detail("install_id", install.id)
            .detail("failures", report.failures.join(", ")));
        }
    }
    Ok(())
}

pub(crate) fn verify_metadata(
    library: &Library,
    expected_metadata: &LibraryMetadata,
) -> Result<()> {
    let mut metadata = library.metadata_for_root(&fs::canonicalize(library.root())?)?;
    let mut expected = expected_metadata.clone();
    metadata.original_root = expected.original_root.clone();
    metadata.exported_at = 0;
    expected.exported_at = 0;
    if expected.schema_version == 5 {
        // Schema 5 can carry an empty reference set. A fresh export keeps using
        // schema 3/4 when no reference requires the newer reader contract.
        metadata.schema_version = 5;
    }
    if expected.schema_version < 3 {
        if metadata
            .artwork
            .as_ref()
            .is_some_and(|artwork| !artwork.assets.is_empty() || !artwork.choices.is_empty())
        {
            return Err(PortcoveError::verification(
                "legacy import gained unreviewed artwork",
            ));
        }
        metadata.artwork = None;
        metadata
            .content_roots
            .retain(|root| root.kind != crate::LibraryContentKind::LocalArtwork);
        if expected.schema_version == 1 {
            metadata
                .content_roots
                .retain(|root| root.kind != crate::LibraryContentKind::SourceInbox);
        }
        metadata.schema_version = expected.schema_version;
    }
    if serde_json::to_value(metadata)? != serde_json::to_value(expected)? {
        return Err(PortcoveError::verification(
            "destination metadata differs from the reviewed library copy",
        ));
    }
    Ok(())
}

fn ensure_directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => crate::durability::sync_publication(
            path.parent()
                .ok_or_else(|| PortcoveError::state("directory has no parent"))?,
        )?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PortcoveError::verification(
            "library copy directory is not a real directory",
        ));
    }
    Ok(())
}

fn regular_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(PortcoveError::verification(
            "library copy entry is not a regular file",
        ));
    }
    Ok(())
}

fn verify_file(path: &Path, expected_size: u64, expected_hash: &str) -> Result<()> {
    crate::runtime_data_policy::refuse_sensitive_entry(path)?;
    regular_file(path)?;
    if fs::metadata(path)?.len() != expected_size
        || crate::service::sha256_file(path)? != expected_hash
    {
        return Err(PortcoveError::verification(
            "an existing destination file differs from the reviewed copy; it has been retained",
        )
        .detail("path", path.display().to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_preserves_exact_times_and_refuses_changed_resume_without_overwrite() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let target = temporary.path().join("target");
        let work = temporary.path().join("work");
        fs::create_dir_all(&source).unwrap();
        let original = source.join("save");
        fs::write(&original, b"retained data").unwrap();
        let stamp = std::time::UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 123_456_700);
        fs::OpenOptions::new()
            .write(true)
            .open(&original)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(stamp))
            .unwrap();
        let plan = crate::library_transfer::reviewed_tree(&source).unwrap();
        copy_reviewed_tree(&source, &target, &plan, &work).unwrap();
        assert_eq!(
            fs::metadata(target.join("save"))
                .unwrap()
                .modified()
                .unwrap(),
            stamp
        );
        copy_reviewed_tree(&source, &target, &plan, &work).unwrap();
        let changed = stamp + std::time::Duration::from_secs(1);
        fs::OpenOptions::new()
            .write(true)
            .open(target.join("save"))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(changed))
            .unwrap();
        let error = copy_reviewed_tree(&source, &target, &plan, &work).unwrap_err();
        assert!(error.message.contains("different modification time"));
        assert_eq!(fs::read(target.join("save")).unwrap(), b"retained data");
        assert_eq!(
            fs::metadata(target.join("save"))
                .unwrap()
                .modified()
                .unwrap(),
            changed
        );
        assert_eq!(fs::metadata(&original).unwrap().modified().unwrap(), stamp);
        // Published verification remains destination-owned. A byte-only plan
        // does not establish historical timestamp authenticity.
        fs::remove_file(original).unwrap();
        verify_reviewed_tree(&target, &plan).unwrap();
    }
}
