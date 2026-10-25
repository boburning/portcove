use super::*;
use crate::{Catalog, RuntimeSourceMaterialization, RuntimeSourceTarget};

fn members() -> Vec<RelativeSourceMemberIdentity> {
    [
        ("dark-gob", "DARK.GOB", b"original gob".as_slice()),
        (
            "agent-menu",
            "LFD/AGENTMNU.LFD",
            b"original companion".as_slice(),
        ),
    ]
    .into_iter()
    .map(|(id, path, bytes)| RelativeSourceMemberIdentity {
        id: id.into(),
        path: path.into(),
        size: bytes.len() as u64,
        sha256: hex::encode(Sha256::digest(bytes)),
    })
    .collect()
}

fn catalog() -> Catalog {
    Catalog::from_json(&serde_json::json!({
        "schema_version":2,"ports":[],"source_catalog":{"evidence":[],"contracts":[],"validators":[],
            "identities":[{"id":"relative-fixture","label":"Exact relative fixture","kind":"file-set","evidence_gap":null,
                "variants":[{"id":"fixture-edition","title":"Inert fixture","region":null,"revision":null,"product_codes":[],
                    "representations":[{"id":"relative-files","extensions":[],"kind":"relative-file-set","members":members()}]}]}]}
    }).to_string()).unwrap()
}

fn original(root: &Path) {
    fs::create_dir(root.join("LFD")).unwrap();
    fs::write(root.join("DARK.GOB"), b"original gob").unwrap();
    fs::write(root.join("LFD/AGENTMNU.LFD"), b"original companion").unwrap();
    fs::write(root.join("unrelated.ini"), b"never staged").unwrap();
}

fn port() -> crate::PortDefinition {
    let mut port = crate::Catalog::embedded()
        .unwrap()
        .port("dkc3-recomp")
        .unwrap()
        .clone();
    port.runtime_source_set = members()
        .iter()
        .map(|member| RuntimeSourceTarget {
            source_filenames: vec![member.path.clone()],
            destination: format!("GameData/{}", member.path),
            materialization: RuntimeSourceMaterialization::Copy,
        })
        .collect();
    port.runtime_source_hashes = members()
        .iter()
        .map(|member| (format!("GameData/{}", member.path), member.sha256.clone()))
        .collect();
    port
}

fn zip(path: &Path, files: &[(&str, &[u8])]) {
    let mut archive = zip::ZipWriter::new(fs::File::create(path).unwrap());
    for (name, bytes) in files {
        archive
            .start_file(
                *name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        archive.write_all(bytes).unwrap();
    }
    archive.finish().unwrap();
}

#[test]
fn exact_directory_and_zip_have_equal_content_and_distinct_storage_identity() {
    let root = tempfile::tempdir().unwrap();
    original(root.path());
    let archive = root.path().join("original.zip");
    zip(
        &archive,
        &[
            ("DARK.GOB", b"original gob"),
            ("LFD/AGENTMNU.LFD", b"original companion"),
            ("unrelated.ini", b"never staged"),
        ],
    );
    let directory = inspect(&catalog(), "relative-fixture", root.path())
        .unwrap()
        .require_admitted_record()
        .unwrap();
    let zipped = inspect(&catalog(), "relative-fixture", &archive)
        .unwrap()
        .require_admitted_record()
        .unwrap();
    assert_eq!(directory.sha256, zipped.sha256);
    assert_eq!(directory.size, zipped.size);
    assert_ne!(directory.storage_sha256, zipped.storage_sha256);
    assert_eq!(zipped.observed_identity.unwrap().components.len(), 2);
    assert_eq!(
        validate_profile(
            catalog().source_profile("relative-fixture").unwrap(),
            root.path()
        )
        .unwrap()
        .sha256,
        directory.sha256
    );
}

#[test]
fn wrong_basename_missing_or_changed_companion_never_satisfies_relative_member() {
    let root = tempfile::tempdir().unwrap();
    original(root.path());
    fs::rename(
        root.path().join("LFD/AGENTMNU.LFD"),
        root.path().join("AGENTMNU.LFD"),
    )
    .unwrap();
    assert!(inspect(&catalog(), "relative-fixture", root.path()).is_err());
    fs::write(root.path().join("LFD/AGENTMNU.LFD"), b"changed companion").unwrap();
    assert!(inspect(&catalog(), "relative-fixture", root.path()).is_err());
    let archive = root.path().join("wrong.zip");
    zip(
        &archive,
        &[
            ("DARK.GOB", b"original gob"),
            ("AGENTMNU.LFD", b"original companion"),
        ],
    );
    assert!(inspect(&catalog(), "relative-fixture", &archive).is_err());
}

#[test]
fn hostile_zip_names_and_namespace_collisions_refuse() {
    for bad in [
        "../outside",
        "C:/outside",
        "LFD/file:stream",
        "LFD/CON",
        "LFD/../AGENTMNU.LFD",
        "LFD/agentmnu.lfd",
        "LFD",
    ] {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("unsafe.zip");
        zip(
            &archive,
            &[
                ("DARK.GOB", b"original gob"),
                ("LFD/AGENTMNU.LFD", b"original companion"),
                (bad, b"extra"),
            ],
        );
        assert!(
            inspect(&catalog(), "relative-fixture", &archive).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn generated_copies_are_checked_on_reuse_and_unrelated_files_are_not_staged() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let runtime = root.path().join("runtime");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&runtime).unwrap();
    original(&source);
    let record = inspect(&catalog(), "relative-fixture", &source)
        .unwrap()
        .require_admitted_record()
        .unwrap();
    materialize(&port(), &record, &runtime, &|| Ok(())).unwrap();
    assert!(!runtime.join("GameData/unrelated.ini").exists());
    fs::write(
        runtime.join("GameData/LFD/AGENTMNU.LFD"),
        b"corrupt private cache",
    )
    .unwrap();
    fs::write(
        runtime.join("matching-source-marker.json"),
        b"same admitted source",
    )
    .unwrap();
    materialize(&port(), &record, &runtime, &|| Ok(())).unwrap();
    assert_eq!(
        fs::read(runtime.join("GameData/LFD/AGENTMNU.LFD")).unwrap(),
        b"original companion"
    );
    check_runtime(&port(), &runtime, &|| Ok(())).unwrap();
    fs::write(runtime.join("GameData/player-file.dat"), b"retain me").unwrap();
    assert!(materialize(&port(), &record, &runtime, &|| Ok(())).is_err());
    assert_eq!(
        fs::read(runtime.join("GameData/player-file.dat")).unwrap(),
        b"retain me"
    );
    assert_eq!(
        fs::read(source.join("unrelated.ini")).unwrap(),
        b"never staged"
    );
}

#[test]
fn interrupted_preparation_does_not_publish_partial_data() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let runtime = root.path().join("runtime");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&runtime).unwrap();
    original(&source);
    let record = inspect(&catalog(), "relative-fixture", &source)
        .unwrap()
        .require_admitted_record()
        .unwrap();
    let cancel = || {
        let staged = runtime.join(".tfe-preparation");
        if staged.exists()
            && fs::read_dir(staged)?
                .filter_map(std::result::Result::ok)
                .any(|entry| entry.path().join("DARK.GOB").exists())
        {
            Err(PortcoveError::conflict(
                "synthetic cancellation after first staged member",
            ))
        } else {
            Ok(())
        }
    };
    assert!(materialize(&port(), &record, &runtime, &cancel).is_err());
    assert!(!runtime.join("GameData").exists());
    materialize(&port(), &record, &runtime, &|| Ok(())).unwrap();
    check_runtime(&port(), &runtime, &|| Ok(())).unwrap();
}

#[test]
fn changed_original_and_linked_cache_refuse_without_replacement() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let runtime = root.path().join("runtime");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&runtime).unwrap();
    original(&source);
    let record = inspect(&catalog(), "relative-fixture", &source)
        .unwrap()
        .require_admitted_record()
        .unwrap();
    materialize(&port(), &record, &runtime, &|| Ok(())).unwrap();
    fs::write(source.join("DARK.GOB"), b"changed original").unwrap();
    assert!(materialize(&port(), &record, &runtime, &|| Ok(())).is_err());
    assert_eq!(
        fs::read(runtime.join("GameData/DARK.GOB")).unwrap(),
        b"original gob"
    );
    fs::hard_link(
        runtime.join("GameData/DARK.GOB"),
        root.path().join("held-original"),
    )
    .unwrap();
    assert!(materialize(&port(), &record, &runtime, &|| Ok(())).is_err());
    assert_eq!(
        fs::read(root.path().join("held-original")).unwrap(),
        b"original gob"
    );
}

#[test]
fn traversal_bounds_and_discovery_hash_budget_are_enforced() {
    for path in [
        "../DARK.GOB",
        "/DARK.GOB",
        "LFD/CON",
        "LFD/file:stream",
        "LFD\\AGENTMNU.LFD",
    ] {
        let mut set = members();
        set[1].path = path.into();
        assert!(validate(&set).is_err(), "{path}");
    }
    let mut set = members();
    set[1].path = "dark.gob".into();
    assert!(validate(&set).is_err());
    let root = tempfile::tempdir().unwrap();
    original(root.path());
    let mut budget = crate::source_file::HashBudget {
        operation: None,
        limit: 1,
        hashed: 0,
        max_zip_entries: 16,
    };
    assert!(
        inspect_with_limits(
            &catalog(),
            "relative-fixture",
            root.path(),
            &mut budget,
            &mut ReadLimits::default()
        )
        .is_err()
    );
    assert!(budget.hashed <= budget.limit);
}

#[test]
fn relative_record_is_sha256_for_one_member_and_order_independent() {
    let root = tempfile::tempdir().unwrap();
    original(root.path());
    let input = Input::open(root.path(), &|| Ok(())).unwrap();
    let mut set = members();
    let first = record("fixture", root.path(), &set, &input);
    set.reverse();
    assert_eq!(
        first.sha256,
        record("fixture", root.path(), &set, &input).sha256
    );
    let single = record("fixture", root.path(), &set[..1], &input);
    assert_eq!(single.sha256.len(), 64);
    assert!(single.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(single.sha256, set[0].sha256);
    set[0].path = "different/path".into();
    assert_ne!(
        single.sha256,
        record("fixture", root.path(), &set[..1], &input).sha256
    );
}

#[test]
fn caller_limits_bound_directory_and_zip_before_member_reads() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("data");
    fs::create_dir(&source).unwrap();
    original(&source);
    let archive = root.path().join("data.zip");
    zip(
        &archive,
        &[
            ("DARK.GOB", b"original gob"),
            ("LFD/AGENTMNU.LFD", b"original companion"),
        ],
    );
    for (path, entries, depth, file_bytes, expected) in [
        (&source, 1, 64, u64::MAX, "entries"),
        (&source, 4096, 0, u64::MAX, "depth"),
        (&source, 4096, 64, 1, "file_size"),
        (&archive, 1, 64, u64::MAX, "entries"),
        (&archive, 4096, 0, u64::MAX, "depth"),
        (&archive, 4096, 64, 1, "file_size"),
    ] {
        let mut budget = crate::source_file::HashBudget {
            operation: None,
            limit: u64::MAX,
            hashed: 0,
            max_zip_entries: 4096,
        };
        let mut limits = ReadLimits {
            max_entries: entries,
            max_depth: depth,
            max_file_bytes: file_bytes,
            entries: 0,
        };
        let error = inspect_with_limits(
            &catalog(),
            "relative-fixture",
            path,
            &mut budget,
            &mut limits,
        )
        .unwrap_err();
        assert_eq!(
            error.details.get("scan_limit").map(String::as_str),
            Some(expected),
            "{}",
            error.message
        );
        assert!(limits.entries <= limits.max_entries);
        if path == &source {
            assert_eq!(budget.hashed, 0);
        }
    }
}

#[test]
fn capture_interruption_and_racing_destination_preserve_every_directory() {
    for occupied in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let runtime = root.path().join("runtime");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&runtime).unwrap();
        original(&source);
        let record = inspect(&catalog(), "relative-fixture", &source)
            .unwrap()
            .require_admitted_record()
            .unwrap();
        materialize(&port(), &record, &runtime, &|| Ok(())).unwrap();
        fs::write(runtime.join("GameData/DARK.GOB"), b"corrupt private copy").unwrap();
        let injected = std::cell::Cell::new(false);
        let interrupt = || {
            let captured = fs::read_dir(runtime.join(".tfe-preparation"))?
                .filter_map(std::result::Result::ok)
                .find(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("previous-data-")
                });
            if let Some(captured) = captured
                && !injected.replace(true)
            {
                fs::write(
                    captured.path().join("late-player-file"),
                    b"preserve captured player data",
                )?;
                if occupied {
                    fs::create_dir(runtime.join("GameData"))?;
                    fs::write(
                        runtime.join("GameData/new-player-file"),
                        b"preserve racing destination",
                    )?;
                }
                return Err(PortcoveError::conflict(
                    "synthetic interruption after capture",
                ));
            }
            Ok(())
        };
        assert!(materialize(&port(), &record, &runtime, &interrupt).is_err());
        assert!(injected.get());
        let retained = if occupied {
            assert_eq!(
                fs::read(runtime.join("GameData/new-player-file")).unwrap(),
                b"preserve racing destination"
            );
            fs::read_dir(runtime.join(".tfe-preparation"))
                .unwrap()
                .filter_map(std::result::Result::ok)
                .find(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("previous-data-")
                })
                .unwrap()
                .path()
        } else {
            runtime.join("GameData")
        };
        assert_eq!(
            fs::read(retained.join("late-player-file")).unwrap(),
            b"preserve captured player data"
        );
        assert_eq!(
            fs::read(retained.join("DARK.GOB")).unwrap(),
            b"corrupt private copy"
        );
    }
}
