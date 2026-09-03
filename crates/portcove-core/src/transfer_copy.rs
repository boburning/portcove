use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};

use sha2::{Digest, Sha256};

use crate::{Library, LibraryMovePlan, PortcoveError, Result};

pub(crate) fn copy_content(plan: &LibraryMovePlan) -> Result<()> {
    let work = plan.destination_root.join(".portcove-transfer-work");
    ensure_directory(&work)?;
    for tree in &plan.content {
        let source = plan.source_root.join(&tree.relative_path);
        let destination = plan.destination_root.join(&tree.relative_path);
        ensure_directory(&destination)?;
        for relative in &tree.copy.directories {
            ensure_directory(&destination.join(relative))?;
        }
        for file in &tree.copy.files {
            let target = destination.join(&file.relative_path);
            if fs::symlink_metadata(&target).is_ok() {
                verify_file(&target, file.size, &file.sha256)?;
                continue;
            }
            let origin = source.join(&file.relative_path);
            regular_file(&origin)?;
            let mut input = File::open(&origin)?;
            let mut output = tempfile::NamedTempFile::new_in(&work)?;
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
                        "library file grew while copying",
                    ));
                }
                digest.update(&buffer[..read]);
                output.write_all(&buffer[..read])?;
            }
            if size != file.size || hex::encode(digest.finalize()) != file.sha256 {
                return Err(PortcoveError::verification(
                    "library file changed while copying",
                ));
            }
            output
                .as_file()
                .set_permissions(input.metadata()?.permissions())?;
            output.as_file().sync_all()?;
            output
                .persist_noclobber(&target)
                .map_err(|error| PortcoveError::from(error.error))?;
            crate::durability::sync_publication(
                target
                    .parent()
                    .ok_or_else(|| PortcoveError::state("copy target has no parent"))?,
            )?;
        }
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

pub(crate) fn verify_destination(library: &Library, plan: &LibraryMovePlan) -> Result<()> {
    for tree in &plan.content {
        let copy = crate::library_transfer::reviewed_tree(
            &plan.destination_root.join(&tree.relative_path),
        )?;
        if serde_json::to_value(&copy)? != serde_json::to_value(&tree.copy)? {
            return Err(PortcoveError::verification(
                "destination contents differ from the reviewed library move",
            )
            .detail("content_root", &tree.relative_path));
        }
    }
    let mut metadata = library.metadata_for_root(&plan.destination_root)?;
    let mut expected = plan.metadata.clone();
    metadata.original_root = expected.original_root.clone();
    metadata.exported_at = 0;
    expected.exported_at = 0;
    if serde_json::to_value(metadata)? != serde_json::to_value(expected)? {
        return Err(PortcoveError::verification(
            "destination metadata differs from the reviewed library move",
        ));
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
    for relative in &plan.metadata.application_versions {
        let mut install = relative.clone();
        install.path = plan.destination_root.join(&install.path);
        let report = installer.verify(&install)?;
        if !report.valid {
            return Err(PortcoveError::verification(
                "moved application failed immutable manifest verification",
            )
            .detail("install_id", install.id)
            .detail("failures", report.failures.join(", ")));
        }
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
