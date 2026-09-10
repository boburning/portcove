use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    Catalog, LibraryContentKind, LibraryMetadata, LibraryMetadataFile, LibraryTreePlan,
    PortcoveError, PortcoveService, Result,
};

/// The export carries metadata; all payload bytes remain in the explicitly chosen content root.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LibraryImportPlan {
    pub metadata_file: LibraryMetadataFile,
    pub content_root: PathBuf,
    pub destination_root: PathBuf,
    pub destination_exists: bool,
    pub metadata: LibraryMetadata,
    pub content: Vec<LibraryTreePlan>,
    pub required_bytes: u64,
    pub available_bytes: u64,
    pub plan_sha256: String,
}

impl PortcoveService {
    /// Plan without opening, migrating, or modifying a library at the input location.
    pub fn plan_library_import(
        metadata_path: &Path,
        content_root: &Path,
        destination: &Path,
    ) -> Result<LibraryImportPlan> {
        let (metadata_file, metadata) = read_metadata(metadata_path)?;
        validate_metadata(&metadata, &Catalog::embedded()?)?;
        let content_root = fs::canonicalize(content_root)?;
        let destination_root =
            crate::path::resolve_existing_ancestor(&std::path::absolute(destination)?)?;
        let destination_exists = destination_root.exists();
        if destination_root.starts_with(&content_root)
            || content_root.starts_with(&destination_root)
        {
            return Err(PortcoveError::usage(
                "import content and destination roots must not overlap",
            ));
        }
        if destination_exists {
            crate::import_journal::ensure_empty_destination(&destination_root)?;
        } else {
            crate::library_transfer::transfer_destination(&content_root, &destination_root)?;
        }
        if metadata_file.path.starts_with(&destination_root) {
            return Err(PortcoveError::usage(
                "import destination overlaps the metadata export",
            ));
        }
        let content = metadata
            .content_roots
            .iter()
            .map(|root| {
                Ok(LibraryTreePlan {
                    kind: root.kind,
                    relative_path: root.relative_path.clone(),
                    copy: crate::library_transfer::reviewed_tree(
                        &content_root.join(&root.relative_path),
                    )?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        crate::artwork_store::validate_transfer_inventory(&metadata, &content)?;
        let required_bytes = content.iter().try_fold(
            metadata_file
                .size
                .checked_mul(4)
                .and_then(|size| size.checked_add(64 * 1024 * 1024))
                .ok_or_else(|| PortcoveError::state("import capacity estimate overflowed"))?,
            |size, tree| {
                size.checked_add(tree.copy.total_bytes)
                    .ok_or_else(|| PortcoveError::state("import content size overflowed"))
            },
        )?;
        let available_bytes = fs2::available_space(
            destination_root
                .parent()
                .ok_or_else(|| PortcoveError::usage("import destination needs a parent"))?,
        )?;
        if required_bytes > available_bytes {
            return Err(
                PortcoveError::state("import destination has insufficient free space")
                    .detail("required_bytes", required_bytes.to_string())
                    .detail("available_bytes", available_bytes.to_string()),
            );
        }
        let mut plan = LibraryImportPlan {
            metadata_file,
            content_root,
            destination_root,
            destination_exists,
            metadata,
            content,
            required_bytes,
            available_bytes,
            plan_sha256: String::new(),
        };
        plan.plan_sha256 = import_fingerprint(&plan)?;
        Ok(plan)
    }
}

pub(crate) fn read_metadata(path: &Path) -> Result<(LibraryMetadataFile, LibraryMetadata)> {
    let bytes = crate::path::read_bounded_regular(path, 16 * 1024 * 1024)?;
    let document = serde_json::from_slice(&bytes)?;
    Ok((
        LibraryMetadataFile {
            path: fs::canonicalize(path)?,
            sha256: hex::encode(Sha256::digest(&bytes)),
            size: bytes.len() as u64,
        },
        document,
    ))
}

pub(crate) fn import_fingerprint(plan: &LibraryImportPlan) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        &plan.metadata_file,
        &plan.content_root,
        &plan.destination_root,
        plan.destination_exists,
        &plan.metadata,
        &plan.content,
    ))?)))
}

pub(crate) fn validate_metadata(metadata: &LibraryMetadata, catalog: &Catalog) -> Result<()> {
    if !matches!(metadata.schema_version, 1..=3) {
        return Err(PortcoveError::unsupported(
            "unsupported library metadata schema",
        ));
    }
    let legacy_expected = [
        (LibraryContentKind::ApplicationVersions, "versions"),
        (LibraryContentKind::UserData, "user"),
        (LibraryContentKind::Backups, "backups"),
        (LibraryContentKind::Toolchains, "toolchains"),
    ];
    let current_expected = [
        (LibraryContentKind::ApplicationVersions, "versions"),
        (LibraryContentKind::UserData, "user"),
        (LibraryContentKind::SourceInbox, "source-inbox"),
        (LibraryContentKind::Backups, "backups"),
        (LibraryContentKind::Toolchains, "toolchains"),
    ];
    let artwork_expected = [
        (LibraryContentKind::ApplicationVersions, "versions"),
        (LibraryContentKind::UserData, "user"),
        (LibraryContentKind::SourceInbox, "source-inbox"),
        (LibraryContentKind::Backups, "backups"),
        (LibraryContentKind::Toolchains, "toolchains"),
        (LibraryContentKind::LocalArtwork, "artwork"),
    ];
    let expected = match metadata.schema_version {
        1 => legacy_expected.as_slice(),
        2 => current_expected.as_slice(),
        _ => artwork_expected.as_slice(),
    };
    match (&metadata.artwork, metadata.schema_version) {
        (Some(artwork), 3) => crate::artwork_store::validate_metadata(artwork, catalog)?,
        (None, 1 | 2) => {}
        _ => {
            return Err(PortcoveError::verification(
                "artwork metadata does not match the export schema",
            ));
        }
    }
    if metadata.content_roots.len() != expected.len()
        || metadata
            .content_roots
            .iter()
            .zip(expected.iter())
            .any(|(root, (kind, path))| root.kind != *kind || root.relative_path != *path)
    {
        return Err(PortcoveError::verification(
            "metadata has unexpected or overlapping content roots",
        ));
    }
    let mut sources = BTreeSet::new();
    for source in &metadata.source_references {
        catalog.source_profile(&source.profile_id)?;
        if let Some(identity) = &source.observed_identity {
            identity.validate_for_record(source)?;
        }
        if !sources.insert(&source.profile_id)
            || source.path.as_os_str().is_empty()
            || !sha256(&source.sha256)
            || !sha256(&source.storage_sha256)
        {
            return Err(PortcoveError::verification(
                "metadata has an invalid or repeated source reference",
            ));
        }
    }
    let mut installs = BTreeMap::new();
    let mut paths = BTreeSet::new();
    let mut staged = BTreeSet::new();
    for install in &metadata.application_versions {
        catalog.port(&install.port_id)?;
        let relative = crate::portability::portable_relative(&install.path)?;
        let (_, key) = crate::archive::validate_relative_path(&relative, true)?;
        crate::archive::validate_relative_path(
            &crate::portability::portable_relative(&install.selected_executable)?,
            false,
        )?;
        if !relative.starts_with(&format!("versions/{}/", install.port_id))
            || !paths.insert(key)
            || install.id.is_empty()
            || installs.insert(&install.id, install).is_some()
            || !sha256(&install.artifact.sha256)
            || !sha256(&install.manifest_sha256)
            || (install.staged && !staged.insert(&install.port_id))
        {
            return Err(PortcoveError::verification(
                "metadata has an invalid, aliased, or repeated application identity",
            ));
        }
    }
    let mut settings = BTreeSet::new();
    for setting in &metadata.port_settings {
        catalog.port(&setting.port_id)?;
        if let Some(path) = setting.output_directory.as_deref() {
            crate::path::unicode(path, "port output directory")?;
            if !path.is_absolute() {
                return Err(PortcoveError::verification(
                    "metadata contains a non-absolute port output directory",
                ));
            }
        }
        if !settings.insert(&setting.port_id)
            || (setting.active_install_id.is_some()
                && setting.active_install_id == setting.previous_install_id)
        {
            return Err(PortcoveError::verification(
                "metadata repeats port settings or active/previous identity",
            ));
        }
        for id in [&setting.active_install_id, &setting.previous_install_id]
            .into_iter()
            .flatten()
        {
            if installs
                .get(id)
                .is_none_or(|install| install.port_id != setting.port_id || install.staged)
            {
                return Err(PortcoveError::verification(
                    "metadata pointer does not reference a retained install of its own port",
                ));
            }
        }
    }
    if metadata
        .application_versions
        .iter()
        .any(|install| !settings.contains(&install.port_id))
    {
        return Err(PortcoveError::verification(
            "metadata omits settings for an installed port",
        ));
    }
    let mut history = BTreeSet::new();
    for launch in &metadata.launch_history {
        catalog.port(&launch.port_id)?;
        if !history.insert(&launch.port_id) {
            return Err(PortcoveError::verification(
                "metadata repeats launch history",
            ));
        }
    }
    Ok(())
}

fn sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Library;

    #[test]
    fn import_plan_reads_separate_content_without_opening_or_modifying_the_bundle() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let metadata_path = temporary.path().join("library.json");
        let bundle = temporary.path().join("bundle");
        let destination = temporary.path().join("destination");
        let service = PortcoveService::new(Library::open(&source).unwrap()).unwrap();
        service.write_library_metadata(&metadata_path).unwrap();
        fs::create_dir_all(bundle.join("user/starship")).unwrap();
        fs::write(bundle.join("user/starship/save.dat"), b"synthetic save").unwrap();
        let first =
            PortcoveService::plan_library_import(&metadata_path, &bundle, &destination).unwrap();
        assert!(!destination.exists());
        assert!(!bundle.join("locks").exists());
        assert!(!bundle.join("portcove.sqlite3").exists());
        fs::write(
            bundle.join("user/starship/save.dat"),
            b"changed synthetic save",
        )
        .unwrap();
        assert_ne!(
            first.plan_sha256,
            PortcoveService::plan_library_import(&metadata_path, &bundle, &destination)
                .unwrap()
                .plan_sha256
        );
        let mut metadata: LibraryMetadata =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        metadata.content_roots[0].relative_path = "../outside".into();
        fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert!(
            PortcoveService::plan_library_import(&metadata_path, &bundle, &destination).is_err()
        );
        assert!(!destination.exists());
    }

    #[test]
    fn import_rejects_observed_identity_that_does_not_match_its_source_baseline() {
        let temporary = tempfile::tempdir().unwrap();
        let source_library = temporary.path().join("source");
        let original = temporary.path().join("original.z64");
        let metadata_path = temporary.path().join("library.json");
        let bundle = temporary.path().join("bundle");
        let destination = temporary.path().join("destination");
        let service = PortcoveService::new(Library::open(&source_library).unwrap()).unwrap();
        fs::write(&original, b"synthetic source identity").unwrap();
        service.register_source("star-fox-64", &original).unwrap();
        service.write_library_metadata(&metadata_path).unwrap();
        fs::create_dir_all(&bundle).unwrap();

        let mut metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        for digest in metadata["source_references"][0]["observed_identity"]["digests"]
            .as_array_mut()
            .unwrap()
        {
            if digest["algorithm"] == "sha256" {
                digest["value"] = serde_json::Value::String("0".repeat(64));
            }
        }
        fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();

        let error = PortcoveService::plan_library_import(&metadata_path, &bundle, &destination)
            .unwrap_err();
        assert!(error.message.contains("registration baseline"));
        assert!(!destination.exists());
    }

    #[test]
    fn alpha_one_metadata_without_a_source_inbox_remains_importable() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let bundle = temporary.path().join("bundle");
        let metadata_path = temporary.path().join("alpha-one-library.json");
        let destination = temporary.path().join("destination");
        let service = PortcoveService::new(Library::open(&source).unwrap()).unwrap();
        let mut metadata = service.export_library_metadata().unwrap();
        assert_eq!(metadata.schema_version, 3);
        metadata.schema_version = 1;
        metadata.artwork = None;
        metadata.content_roots.retain(|root| {
            !matches!(
                root.kind,
                LibraryContentKind::SourceInbox | LibraryContentKind::LocalArtwork
            )
        });
        validate_metadata(&metadata, &Catalog::embedded().unwrap()).unwrap();

        for root in &metadata.content_roots {
            fs::create_dir_all(bundle.join(&root.relative_path)).unwrap();
        }
        fs::write(
            &metadata_path,
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .unwrap();
        let plan =
            PortcoveService::plan_library_import(&metadata_path, &bundle, &destination).unwrap();
        assert_eq!(plan.metadata.schema_version, 1);
        assert!(
            plan.content
                .iter()
                .all(|root| root.kind != LibraryContentKind::SourceInbox)
        );
        assert!(!destination.exists());

        metadata.schema_version = 2;
        assert!(validate_metadata(&metadata, &Catalog::embedded().unwrap()).is_err());
    }
}
