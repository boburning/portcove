use super::*;
use crate::{ObservedSourceDigest, ObservedSourceIdentity};
use std::{cell::Cell, io::Cursor, path::PathBuf};

fn zip_bytes(entries: &[(&str, &[u8])], symlink: bool) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(
                *name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    if symlink {
        writer
            .add_symlink("link", "outside", zip::write::SimpleFileOptions::default())
            .unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn record(path: PathBuf, archive: &[u8], member: &str, payload: &[u8]) -> SourceRecord {
    let sha256 = hex::encode(Sha256::digest(payload));
    let storage_sha256 = hex::encode(Sha256::digest(archive));
    SourceRecord {
        profile_id: "qualification-original".into(),
        path,
        sha256: sha256.clone(),
        size: payload.len() as u64,
        storage_sha256: storage_sha256.clone(),
        storage_size: archive.len() as u64,
        updated_at: 1,
        observed_identity: Some(ObservedSourceIdentity {
            schema_version: 1,
            archive_member_name: Some(member.into()),
            components: vec![],
            validator: None,
            digests: vec![
                ObservedSourceDigest {
                    algorithm: SourceDigestAlgorithm::Sha256,
                    scope: DigestScope::ArchiveMember,
                    value: sha256,
                    size: payload.len() as u64,
                },
                ObservedSourceDigest {
                    algorithm: SourceDigestAlgorithm::Sha256,
                    scope: DigestScope::OriginalContainer,
                    value: storage_sha256,
                    size: archive.len() as u64,
                },
            ],
        }),
    }
}

fn prepare(
    record: &SourceRecord,
    destination: &Path,
    hashes: &BTreeMap<String, String>,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    super::super::prepare_admitted_runtime_source(
        record,
        destination,
        RuntimeSourceMaterialization::Copy,
        hashes,
        None,
        checkpoint,
        crate::tool_process::ToolProcessObserver::default(),
    )
}

#[test]
fn checked_md_member_is_copied_to_game_bin_instead_of_a_bin_decoy() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("player original – source.zip");
    let payload = b"exact unchanged original";
    let bytes = zip_bytes(
        &[
            ("original/game.md", payload),
            ("decoy.bin", b"another original"),
        ],
        false,
    );
    std::fs::write(&source, &bytes).unwrap();
    let record = record(source.clone(), &bytes, "original/game.md", payload);
    let destination = temporary.path().join("game.bin");
    let hashes = BTreeMap::from([("game.bin".into(), record.sha256.clone())]);
    prepare(&record, &destination, &hashes, &|| Ok(())).unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), payload);
    assert_eq!(std::fs::read(source).unwrap(), bytes);
    let marker: serde_json::Value = serde_json::from_slice(
        &std::fs::read(destination.with_file_name("game.bin.portcove-source.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(marker["source_member"], "original/game.md");
    assert_eq!(marker["storage_sha256"], record.storage_sha256);
}

#[test]
fn cached_copy_is_repaired_with_unchanged_marker_even_without_a_catalog_hash() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("original.zip");
    let payload = b"original exact payload";
    let bytes = zip_bytes(&[("game.md", payload)], false);
    std::fs::write(&source, &bytes).unwrap();
    let record = record(source.clone(), &bytes, "game.md", payload);
    let destination = temporary.path().join("game.bin");
    prepare(&record, &destination, &BTreeMap::new(), &|| Ok(())).unwrap();
    let marker_path = destination.with_file_name("game.bin.portcove-source.json");
    let marker = std::fs::read(&marker_path).unwrap();
    std::fs::write(&destination, b"damaged cached payload").unwrap();
    prepare(&record, &destination, &BTreeMap::new(), &|| Ok(())).unwrap();
    assert_eq!(std::fs::read(destination).unwrap(), payload);
    assert_eq!(std::fs::read(marker_path).unwrap(), marker);
    assert_eq!(std::fs::read(source).unwrap(), bytes);
}

#[test]
fn changed_container_or_payload_does_not_publish_over_a_previous_runtime_original() {
    for changed_payload in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("original.zip");
        let payload = b"checked source";
        let bytes = zip_bytes(&[("game.md", payload), ("readme.txt", b"first")], false);
        let mut record = record(source.clone(), &bytes, "game.md", payload);
        let changed = zip_bytes(
            &[
                (
                    "game.md",
                    if changed_payload {
                        b"changed source"
                    } else {
                        payload
                    },
                ),
                ("readme.txt", b"later"),
            ],
            false,
        );
        std::fs::write(&source, &changed).unwrap();
        if changed_payload {
            // A self-consistent container baseline cannot manufacture the claimed
            // checked payload. Its member must still be hashed before publication.
            record.storage_sha256 = hex::encode(Sha256::digest(&changed));
            record.storage_size = changed.len() as u64;
            let storage = record
                .observed_identity
                .as_mut()
                .unwrap()
                .digests
                .iter_mut()
                .find(|digest| digest.scope == DigestScope::OriginalContainer)
                .unwrap();
            storage.value = record.storage_sha256.clone();
            storage.size = record.storage_size;
        }
        let destination = temporary.path().join("game.bin");
        std::fs::write(&destination, b"previous runtime original").unwrap();
        assert!(prepare(&record, &destination, &BTreeMap::new(), &|| Ok(())).is_err());
        assert_eq!(
            std::fs::read(destination).unwrap(),
            b"previous runtime original"
        );
        assert_eq!(std::fs::read(source).unwrap(), changed);
    }
}

#[test]
fn wrong_fixed_hash_and_missing_or_contradictory_member_facts_refuse_before_publication() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("original.zip");
    let payload = b"exact bytes";
    let bytes = zip_bytes(&[("game.md", payload)], false);
    std::fs::write(&source, &bytes).unwrap();
    let record = record(source, &bytes, "game.md", payload);
    let destination = temporary.path().join("game.bin");
    std::fs::write(&destination, b"previous").unwrap();
    assert!(
        prepare(
            &record,
            &destination,
            &BTreeMap::from([("game.bin".into(), "0".repeat(64))]),
            &|| Ok(())
        )
        .is_err()
    );
    let mut contradictory = record.clone();
    let duplicate = contradictory.observed_identity.as_ref().unwrap().digests[0].clone();
    contradictory
        .observed_identity
        .as_mut()
        .unwrap()
        .digests
        .push(duplicate);
    assert!(prepare(&contradictory, &destination, &BTreeMap::new(), &|| Ok(())).is_err());
    let mut missing = record;
    missing
        .observed_identity
        .as_mut()
        .unwrap()
        .archive_member_name = Some("not-present.md".into());
    assert!(prepare(&missing, &destination, &BTreeMap::new(), &|| Ok(())).is_err());
    assert_eq!(std::fs::read(destination).unwrap(), b"previous");
}

#[test]
fn unsafe_colliding_and_linked_archives_never_publish_the_selected_member() {
    for (extra, symlink) in [
        ("../outside.md", false),
        ("GAME.MD", false),
        ("safe.txt", true),
        ("game.md/child", false),
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("original.zip");
        let payload = b"original";
        let bytes = zip_bytes(&[("game.md", payload), (extra, b"decoy")], symlink);
        std::fs::write(&source, &bytes).unwrap();
        let record = record(source, &bytes, "game.md", payload);
        let destination = temporary.path().join("game.bin");
        std::fs::write(&destination, b"previous").unwrap();
        assert!(
            prepare(&record, &destination, &BTreeMap::new(), &|| Ok(())).is_err(),
            "{extra}"
        );
        assert_eq!(std::fs::read(destination).unwrap(), b"previous");
        assert!(!temporary.path().join("outside.md").exists());
    }
}

#[test]
fn cancellation_during_private_copy_retains_old_destination_and_cleans_staging() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("original.zip");
    let payload = vec![42; 512 * 1024];
    let bytes = zip_bytes(&[("game.md", &payload)], false);
    std::fs::write(&source, &bytes).unwrap();
    let record = record(source.clone(), &bytes, "game.md", &payload);
    let destination = temporary.path().join("game.bin");
    std::fs::write(&destination, b"previous").unwrap();
    let copied = Cell::new(false);
    let checkpoint = || {
        if std::fs::read_dir(temporary.path())?
            .filter_map(std::result::Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".portcove-source-")
                    && entry.metadata().is_ok_and(|metadata| metadata.len() > 0)
            })
        {
            copied.set(true);
            return Err(PortcoveError::conflict("qualification cancellation"));
        }
        Ok(())
    };
    assert!(prepare(&record, &destination, &BTreeMap::new(), &checkpoint).is_err());
    assert!(
        copied.get(),
        "cancellation must occur during actual staged payload copying"
    );
    assert_eq!(std::fs::read(&destination).unwrap(), b"previous");
    assert_eq!(std::fs::read(source).unwrap(), bytes);
    assert!(std::fs::read_dir(temporary.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".portcove-source-")
    }));
}

#[test]
fn absent_observation_does_not_grant_cross_extension_member_selection() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("original.zip");
    let bytes = zip_bytes(&[("game.md", b"original")], false);
    std::fs::write(&source, &bytes).unwrap();
    let mut record = record(source, &bytes, "game.md", b"original");
    record.observed_identity = None;
    let destination = temporary.path().join("game.bin");
    assert!(prepare(&record, &destination, &BTreeMap::new(), &|| Ok(())).is_err());
    assert!(!destination.exists());
}
