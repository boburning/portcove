use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AdoptionCopyPlan, LibraryContentKind, LibraryMetadata, PortcoveError, PortcoveService, Result,
    portability::portable_relative,
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LibraryTreePlan {
    pub kind: LibraryContentKind,
    pub relative_path: String,
    pub copy: AdoptionCopyPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LibraryMovePlan {
    pub source_root: PathBuf,
    pub destination_root: PathBuf,
    pub metadata: LibraryMetadata,
    pub content: Vec<LibraryTreePlan>,
    pub required_bytes: u64,
    pub available_bytes: u64,
    pub source_will_be_retained: bool,
    pub plan_sha256: String,
}

impl PortcoveService {
    pub fn plan_library_move(&self, destination: &Path) -> Result<LibraryMovePlan> {
        let source_root = fs::canonicalize(self.library().root())?;
        let destination_root = transfer_destination(&source_root, destination)?;
        ensure_idle(self.library())?;
        let metadata = self.export_library_metadata()?;
        let catalogs =
            crate::library_import::PortabilityCatalogs::from_root(&metadata, &source_root)?;
        crate::library_import::validate_metadata(&metadata, &catalogs)?;
        let content = metadata
            .content_roots
            .iter()
            .map(|root| {
                let source = source_root.join(&root.relative_path);
                let copy = reviewed_tree(&source)?;
                Ok(LibraryTreePlan {
                    kind: root.kind,
                    relative_path: root.relative_path.clone(),
                    copy,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        crate::artwork_store::validate_transfer_inventory(&metadata, &content)?;
        let copied_bytes = content.iter().try_fold(0_u64, |total, tree| {
            total
                .checked_add(tree.copy.total_bytes)
                .ok_or_else(|| PortcoveError::state("library copy size overflowed"))
        })?;
        let connection = self.library().connection()?;
        let pages: u64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let page_size: u64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let database_bytes = pages
            .checked_mul(page_size)
            .ok_or_else(|| PortcoveError::state("library database size overflowed"))?;
        let required_bytes = copied_bytes
            .checked_add(database_bytes)
            .and_then(|size| size.checked_add(64 * 1024 * 1024))
            .ok_or_else(|| PortcoveError::state("library capacity estimate overflowed"))?;
        let available_bytes = fs2::available_space(
            destination_root
                .parent()
                .ok_or_else(|| PortcoveError::usage("destination needs a parent directory"))?,
        )?;
        if required_bytes > available_bytes {
            return Err(PortcoveError::state(
                "destination has insufficient free space for a verified library copy",
            )
            .detail("required_bytes", required_bytes.to_string())
            .detail("available_bytes", available_bytes.to_string()));
        }
        let mut plan = LibraryMovePlan {
            source_root,
            destination_root,
            metadata,
            content,
            required_bytes,
            available_bytes,
            source_will_be_retained: true,
            plan_sha256: String::new(),
        };
        plan.plan_sha256 = move_fingerprint(&plan)?;
        Ok(plan)
    }
}

pub(crate) fn transfer_destination(source: &Path, destination: &Path) -> Result<PathBuf> {
    crate::path::unicode(destination, "library destination")?;
    let absolute = std::path::absolute(destination)?;
    let parent = absolute
        .parent()
        .ok_or_else(|| PortcoveError::usage("destination needs a parent directory"))?;
    let name = absolute
        .file_name()
        .ok_or_else(|| PortcoveError::usage("destination needs a directory name"))?;
    let destination = fs::canonicalize(parent)?.join(name);
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            return Err(PortcoveError::conflict(
                "library destination must be a new directory",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if destination.starts_with(source) || source.starts_with(&destination) {
        return Err(PortcoveError::usage(
            "source and destination library roots must not overlap",
        ));
    }
    Ok(destination)
}

pub(crate) fn reviewed_tree(root: &Path) -> Result<AdoptionCopyPlan> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AdoptionCopyPlan {
                directories: Vec::new(),
                files: Vec::new(),
                skipped_entries: Vec::new(),
                total_bytes: 0,
            });
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PortcoveError::verification(
            "library content roots must not be symbolic links",
        ));
    }
    let mut copy = crate::service::adoption_copy_plan(root)?;
    if !copy.skipped_entries.is_empty() {
        return Err(PortcoveError::unsupported(
            "library transfer cannot preserve symbolic links or special entries",
        )
        .detail(
            "path",
            copy.skipped_entries[0].relative_path.display().to_string(),
        ));
    }
    let mut paths = BTreeSet::new();
    for (path, directory) in copy.directories.iter_mut().map(|path| (path, true)).chain(
        copy.files
            .iter_mut()
            .map(|file| (&mut file.relative_path, false)),
    ) {
        let relative = portable_relative(path)?;
        let (normalized, key) = crate::portable_tree::validate_relative_path(&relative, directory)
            .map_err(|error| {
                PortcoveError::unsupported(
                    "library path does not satisfy the portable filesystem policy",
                )
                .detail("path", &relative)
                .detail("cause", error.message)
            })?;
        if !paths.insert(key) {
            return Err(PortcoveError::verification(
                "library paths would collide on a case-insensitive destination",
            )
            .detail("path", relative));
        }
        *path = normalized;
    }
    Ok(copy)
}

pub(crate) fn move_fingerprint(plan: &LibraryMovePlan) -> Result<String> {
    let mut metadata = plan.metadata.clone();
    metadata.exported_at = 0;
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        &plan.source_root,
        &plan.destination_root,
        metadata,
        &plan.content,
    ))?)))
}

pub(crate) fn verify_source_plan(library: &crate::Library, plan: &LibraryMovePlan) -> Result<()> {
    ensure_idle(library)?;
    let mut current = plan.clone();
    current.metadata = library.metadata_for_root(&plan.source_root)?;
    for tree in &mut current.content {
        tree.copy = reviewed_tree(&plan.source_root.join(&tree.relative_path))?;
    }
    if move_fingerprint(&current)? != plan.plan_sha256 {
        return Err(PortcoveError::conflict(
            "library content changed after the move was reviewed; abort and create a new plan",
        ));
    }
    Ok(())
}

fn ensure_idle(library: &crate::Library) -> Result<()> {
    if !library.launch_sessions()?.is_empty()
        || !crate::operation::OperationStore::new(library.clone())
            .all()?
            .is_empty()
    {
        return Err(PortcoveError::conflict(
            "finish launch and lifecycle recovery before moving the library",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Library;

    #[test]
    fn move_planning_is_content_bound_and_keeps_source_and_destination_untouched() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let service = PortcoveService::new(Library::open(&source).unwrap()).unwrap();
        fs::create_dir_all(source.join("user/example")).unwrap();
        fs::write(source.join("user/example/save.dat"), b"synthetic save").unwrap();
        fs::create_dir_all(source.join("source-inbox/example-profile")).unwrap();
        fs::write(
            source.join("source-inbox/example-profile/source.bin"),
            b"synthetic owned source",
        )
        .unwrap();
        let first = service.plan_library_move(&destination).unwrap();
        let second = service.plan_library_move(&destination).unwrap();
        assert_eq!(first.plan_sha256, second.plan_sha256);
        assert!(first.source_will_be_retained);
        let inbox = first
            .content
            .iter()
            .find(|tree| tree.kind == LibraryContentKind::SourceInbox)
            .unwrap();
        assert_eq!(inbox.copy.files.len(), 1);
        assert_eq!(
            inbox.copy.files[0].relative_path,
            PathBuf::from("example-profile/source.bin")
        );
        assert!(!destination.exists());
        assert_eq!(
            fs::read(source.join("user/example/save.dat")).unwrap(),
            b"synthetic save"
        );
        fs::write(
            source.join("user/example/save.dat"),
            b"changed synthetic save",
        )
        .unwrap();
        assert_ne!(
            first.plan_sha256,
            service.plan_library_move(&destination).unwrap().plan_sha256
        );
        assert!(service.plan_library_move(&source.join("nested")).is_err());
        assert!(service.plan_library_move(&source).is_err());
    }

    #[test]
    fn generated_unicode_tree_round_trips_without_compatibility_normalization() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let fullwidth = Path::new("dataDir/stages/コピー ～ practice/re_ｐ2_00.blo");
        let ascii = Path::new("dataDir/stages/コピー ～ practice/re_p2_00.blo");
        fs::create_dir_all(source.join(fullwidth.parent().unwrap())).unwrap();
        fs::write(source.join(fullwidth), b"fullwidth p").unwrap();
        fs::write(source.join(ascii), b"ASCII p").unwrap();

        let plan = reviewed_tree(&source).unwrap();
        assert_eq!(plan.files.len(), 2);
        assert!(
            plan.files
                .iter()
                .any(|file| file.relative_path == fullwidth)
        );
        assert!(plan.files.iter().any(|file| file.relative_path == ascii));
        assert!(
            crate::archive::validate_relative_path(&fullwidth.to_string_lossy(), false).is_err()
        );

        crate::transfer_copy::copy_reviewed_tree(
            &source,
            &destination,
            &plan,
            &temporary.path().join("copy-work"),
        )
        .unwrap();
        crate::transfer_copy::verify_reviewed_tree(&destination, &plan).unwrap();
        assert_eq!(
            fs::read(destination.join(fullwidth)).unwrap(),
            b"fullwidth p"
        );
        assert_eq!(fs::read(destination.join(ascii)).unwrap(), b"ASCII p");
    }

    #[test]
    fn reviewed_tree_rejects_unicode_portable_aliases_when_the_host_can_represent_both() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        fs::create_dir(&source).unwrap();
        for (index, (left, right)) in [
            ("σ.bin", "ς.bin"),
            ("Straße.bin", "STRASSE.BIN"),
            ("foo\u{200b}.bin", "foo.bin"),
        ]
        .into_iter()
        .enumerate()
        {
            let pair = source.join(format!("pair-{index}"));
            fs::create_dir(&pair).unwrap();
            fs::write(pair.join(left), b"left").unwrap();
            fs::write(pair.join(right), b"right").unwrap();

            let names = fs::read_dir(&pair)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<BTreeSet<_>>();
            if names.contains(left) && names.contains(right) {
                let error = reviewed_tree(&pair).unwrap_err();
                assert!(
                    error
                        .message
                        .contains("collide on a case-insensitive destination"),
                    "unexpected error for aliases {left:?} and {right:?}: {error}"
                );
            } else {
                assert_eq!(names.len(), 1, "host did not preserve both alias names");
            }
        }
    }

    #[test]
    fn move_plan_accepts_an_admitted_post_client_definition() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let library = Library::open(&source).unwrap();
        let (post_client, port_id) = crate::test_fixture::post_client_catalog();
        let catalog = crate::test_fixture::admitted_indexed_catalog(&post_client, &port_id);
        crate::test_fixture::register_qualification_install(&library, &catalog, &port_id);
        let service = PortcoveService::new(library).unwrap();

        let plan = service.plan_library_move(&destination).unwrap();
        assert_eq!(plan.metadata.application_versions[0].port_id, port_id);
        drop(service);
        assert!(
            PortcoveService::move_library(&source, &destination, &plan.plan_sha256)
                .unwrap()
                .completed
        );
        assert!(
            Library::open(&destination)
                .unwrap()
                .status(&port_id, crate::ReleaseChannel::Stable)
                .unwrap()
                .active
                .is_some()
        );
    }
}
