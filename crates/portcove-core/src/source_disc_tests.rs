use super::*;

fn observed_size(bytes: &[u8], extension: &str) -> Result<u64> {
    let mut file = tempfile::tempfile()?;
    file.write_all(bytes)?;
    container_decoded_bytes(&mut file, extension, &|| Ok(()))
}

fn chd_header() -> Vec<u8> {
    let mut header = vec![0; 156];
    header[..8].copy_from_slice(b"MComprHD");
    header[8..12].copy_from_slice(&124_u32.to_be_bytes());
    header[12..16].copy_from_slice(&5_u32.to_be_bytes());
    header[32..40].copy_from_slice(&4096_u64.to_be_bytes());
    header[40..48].copy_from_slice(&124_u64.to_be_bytes());
    header[56..60].copy_from_slice(&512_u32.to_be_bytes());
    header
}

#[test]
fn fixed_chd_preflight_bounds_hunks_parent_metadata_and_truncated_chains() {
    let header = chd_header();
    assert_eq!(observed_size(&header, "chd").unwrap(), 4096);
    for hunk in [0, 512 * 1024 + 1] {
        let mut invalid = header.clone();
        invalid[56..60].copy_from_slice(&(hunk as u32).to_be_bytes());
        assert!(observed_size(&invalid, "chd").is_err());
    }
    let mut parent = header.clone();
    parent[104] = 1;
    assert!(observed_size(&parent, "chd").is_err());
    let mut metadata = header;
    metadata[48..56].copy_from_slice(&156_u64.to_be_bytes());
    assert!(observed_size(&metadata, "chd").is_err());
    metadata.resize(172, 0);
    metadata[164..172].copy_from_slice(&156_u64.to_be_bytes());
    assert!(
        observed_size(&metadata, "chd")
            .unwrap_err()
            .message
            .contains("chain")
    );
    metadata[164..172].fill(0);
    metadata[160..164].copy_from_slice(&0x00ff_ffff_u32.to_be_bytes());
    assert!(
        observed_size(&metadata, "chd")
            .unwrap_err()
            .message
            .contains("bounded size")
    );
    metadata[160..164].copy_from_slice(&16_u32.to_be_bytes());
    assert!(
        observed_size(&metadata, "chd")
            .unwrap_err()
            .message
            .contains("truncated")
    );
}

#[test]
fn gcz_and_rvz_preflight_reject_oversized_maps_before_decoding() {
    let mut gcz = vec![0; 44];
    gcz[..4].copy_from_slice(&0xb10b_c001_u32.to_le_bytes());
    gcz[16..24].copy_from_slice(&4096_u64.to_le_bytes());
    gcz[24..28].copy_from_slice(&4096_u32.to_le_bytes());
    gcz[28..32].copy_from_slice(&1_u32.to_le_bytes());
    assert_eq!(observed_size(&gcz, "gcz").unwrap(), 4096);
    assert!(observed_size(&gcz[..43], "gcz").is_err());
    gcz[24..28].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(observed_size(&gcz, "gcz").is_err());
    let mut rvz = vec![0; 292];
    rvz[..4].copy_from_slice(b"RVZ\x01");
    rvz[12..16].copy_from_slice(&220_u32.to_be_bytes());
    rvz[36..44].copy_from_slice(&32768_u64.to_be_bytes());
    rvz[84..88].copy_from_slice(&32768_u32.to_be_bytes());
    assert_eq!(observed_size(&rvz, "rvz").unwrap(), 32768);
    rvz[72 + 144..72 + 148].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(observed_size(&rvz, "rvz").is_err());
    rvz[72 + 148..72 + 152].copy_from_slice(&48_u32.to_be_bytes());
    assert!(
        observed_size(&rvz, "rvz")
            .unwrap_err()
            .message
            .contains("bounded metadata")
    );
}

fn ciso(block: u32, map: &[u8], payload: &[u8]) -> File {
    let mut header = vec![0; CISO_HEADER_BYTES];
    header[..4].copy_from_slice(b"CISO");
    header[4..8].copy_from_slice(&block.to_le_bytes());
    header[8..8 + map.len()].copy_from_slice(map);
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(&header).unwrap();
    file.write_all(payload).unwrap();
    file
}

#[test]
fn ciso_map_streams_stored_and_sparse_blocks_with_a_fixed_logical_end() {
    let block = 64 * 1024;
    let mut payload = vec![0x12; block];
    payload.extend(vec![0x34; block]);
    let mut reader = CisoReader::new(ciso(block as u32, &[1, 0, 1], &payload)).unwrap();
    let mut sample = [0; 4];
    reader.read_exact(&mut sample).unwrap();
    assert_eq!(sample, [0x12; 4]);
    reader.position = block as u64 - 2;
    reader.read_exact(&mut sample).unwrap();
    assert_eq!(sample, [0x12, 0x12, 0, 0]);
    reader.position = 2 * block as u64;
    reader.read_exact(&mut sample).unwrap();
    assert_eq!(sample, [0x34; 4]);
    reader.position = GAMECUBE_DISC_CAPACITY_BYTES - 2;
    assert_eq!(reader.read(&mut sample).unwrap(), 2);
    assert_eq!(&sample[..2], &[0, 0]);
    assert_eq!(reader.read(&mut sample).unwrap(), 0);
}

#[test]
fn ciso_rejects_invalid_maps_extents_and_blocks_without_expansion() {
    for (block, map, payload) in [
        (0, vec![], vec![]),
        (1, vec![], vec![]),
        (64 * 1024, vec![2], vec![]),
        (64 * 1024, vec![1], vec![]),
        (64 * 1024, vec![], vec![1]),
    ] {
        assert!(CisoReader::new(ciso(block, &map, &payload)).is_err());
    }
    let mut map = vec![0; CISO_HEADER_BYTES - 8];
    map[GAMECUBE_DISC_CAPACITY_BYTES.div_ceil(64 * 1024) as usize] = 1;
    assert!(CisoReader::new(ciso(64 * 1024, &map, &[])).is_err());
}

#[test]
fn snapshot_reader_copies_exact_hashed_bytes_and_closure_guard_refuses_unknown() {
    let mut copied = Vec::new();
    let mut read = Vec::new();
    SnapshotReader {
        input: &b"owned immutable fixture"[..],
        output: &mut copied,
    }
    .read_to_end(&mut read)
    .unwrap();
    assert_eq!(copied, read);
    assert!(require_decoder_quiescence(&Cell::new(false)).is_err());
    require_decoder_quiescence(&Cell::new(true)).unwrap();
}

#[test]
fn decoder_output_tree_rejects_oversize_and_deep_empty_directories() {
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("too-large"), b"12345").unwrap();
    assert!(check_output_tree(temporary.path(), 4).is_err());
    check_output_tree(temporary.path(), 5).unwrap();
    let mut nested = temporary.path().to_path_buf();
    for _ in 0..9 {
        nested.push("nested");
        fs::create_dir(&nested).unwrap();
    }
    assert!(check_output_tree(temporary.path(), 5).is_err());
}

#[test]
fn ordered_disc_aggregate_keeps_normalized_and_original_identities_separate() {
    let member = |hash: &str, stored: &str, size, storage_size| ObservedDiscSource {
        record: SourceRecord {
            profile_id: "owned".into(),
            path: "member.chd".into(),
            sha256: hash.repeat(32),
            size,
            storage_sha256: stored.repeat(32),
            storage_size,
            updated_at: 0,
            observed_identity: None,
        },
        discs: vec![ObservedOpticalDisc {
            name: Some(format!("{hash}.chd")),
            sha1: "00".repeat(20),
            sha256: hash.repeat(32),
            size,
            track_count: 1,
            volume_id: None,
        }],
    };
    let first = member("11", "aa", 17, 9);
    let second = member("22", "bb", 23, 13);
    let set = aggregate("owned", Path::new("set"), &[first.clone(), second.clone()]).unwrap();
    assert_eq!(
        set.record.sha256,
        "a9f8e02ad60146ceb500e1abb7ece9e836175af87e7c3530a07faaaf7d1c8acd"
    );
    assert_eq!(
        set.record.storage_sha256,
        "94268a637c44316a8aed801f1f16ab857ad2eadda9e9fb16459dc67133419dab"
    );
    assert_eq!((set.record.size, set.record.storage_size), (40, 22));
    assert_eq!(
        set.discs
            .iter()
            .map(|disc| disc.name.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["11.chd", "22.chd"]
    );
    let reversed = aggregate("owned", Path::new("set"), &[second, first]).unwrap();
    assert_ne!(reversed.record.sha256, set.record.sha256);
    assert_ne!(reversed.record.storage_sha256, set.record.storage_sha256);
}

#[cfg(windows)]
#[test]
#[ignore = "explicit owned CHD plus installed codec acceptance; not a gameplay or retail fixture"]
fn real_owned_chd_decoder_matches_manual_observation() {
    use sha2::{Digest, Sha256};
    let path =
        fs::canonicalize(std::env::var_os("PORTCOVE_OWNED_CHD_INPUT").expect("owned input path"))
            .unwrap();
    let tool = std::path::PathBuf::from(
        std::env::var_os("PORTCOVE_OWNED_CHDMAN").expect("reviewed installed codec path"),
    );
    let original = fs::read(&path).unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let closed = Cell::new(true);
    let mut budget = HashBudget {
        operation: None,
        limit: 1024 * 1024,
        hashed: 0,
        max_zip_entries: 4096,
    };
    let bounded = observe_converted_disc(
        DiscInput {
            profile_id: "masters-of-teras-kasi-psx",
            kind: SourceKind::PsxDisc,
            path: &path,
            maximum_size: 128 * 1024,
        },
        workspace.path(),
        &mut budget,
        &closed,
        Some(&tool),
    )
    .unwrap()
    .source;
    assert!(closed.get());
    assert_eq!(bounded.record.size, 94080);
    assert_eq!(
        bounded.record.sha256,
        "f04a98f6d9294ae7b7b8bde4c6ac1da6f6677fb9a0a64210d8f7c3c1eaf7a653"
    );
    assert_eq!(
        bounded.record.storage_sha256,
        hex::encode(Sha256::digest(&original))
    );
    assert_eq!(bounded.discs[0].track_count, 1);
    let catalog = crate::Catalog::embedded().unwrap();
    let manual = crate::adapter::observe_psx_disc_source(
        catalog.source_profile("masters-of-teras-kasi-psx").unwrap(),
        &path,
    )
    .unwrap();
    assert_eq!(manual.record.sha256, bounded.record.sha256);
    assert_eq!(manual.record.storage_sha256, bounded.record.storage_sha256);
    assert_eq!(manual.record.size, bounded.record.size);
    assert_eq!(manual.record.storage_size, bounded.record.storage_size);
    assert_eq!(manual.discs[0].sha1, bounded.discs[0].sha1);
    assert_eq!(budget.hashed, original.len() as u64 * 2 + 94080);
    assert_eq!(fs::read(&path).unwrap(), original);
    println!(
        "owned real codec: stored_bytes={} normalized_bytes={} hash_work={} original_sha256={} normalized_sha256={} tree_closed={}",
        original.len(),
        bounded.record.size,
        budget.hashed,
        bounded.record.storage_sha256,
        bounded.record.sha256,
        closed.get()
    );
}

#[cfg(windows)]
#[test]
#[ignore = "explicit owned GameCube inputs plus reviewed Dolphin codec; not retail or gameplay acceptance"]
fn real_owned_gamecube_containers_match_the_original_iso_observation() {
    use sha2::{Digest, Sha256};
    let root = std::path::PathBuf::from(
        std::env::var_os("PORTCOVE_OWNED_GAMECUBE_ROOT").expect("owned input directory"),
    );
    let tool = std::path::PathBuf::from(
        std::env::var_os("PORTCOVE_OWNED_DOLPHIN").expect("reviewed codec path"),
    );
    let catalog = crate::Catalog::embedded().unwrap();
    let profile = catalog
        .document()
        .source_profiles
        .iter()
        .find(|profile| profile.kind == SourceKind::GamecubeDisc)
        .unwrap();
    let iso = fs::canonicalize(root.join("owned.iso")).unwrap();
    let expected = crate::adapter::observe_gamecube_disc_source(profile, &iso).unwrap();
    assert_eq!(expected.record.size, 131072);
    assert_eq!(
        expected.record.sha256,
        "aedd4af009037a6e1a0c0a959c24261cf778906f870a564bd875f5fe159286a5"
    );
    for extension in ["gcz", "wia", "rvz"] {
        let source = fs::canonicalize(root.join(format!("owned.{extension}"))).unwrap();
        let original = fs::read(&source).unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let closed = Cell::new(true);
        let mut budget = HashBudget {
            operation: None,
            limit: 1024 * 1024,
            hashed: 0,
            max_zip_entries: 4096,
        };
        let bounded = observe_converted_disc(
            DiscInput {
                profile_id: &profile.id,
                kind: SourceKind::GamecubeDisc,
                path: &source,
                maximum_size: 256 * 1024,
            },
            workspace.path(),
            &mut budget,
            &closed,
            Some(&tool),
        )
        .unwrap()
        .source;
        assert!(closed.get());
        assert_eq!(bounded.record.sha256, expected.record.sha256);
        assert_eq!(bounded.record.size, expected.record.size);
        assert_eq!(bounded.discs[0].sha1, expected.discs[0].sha1);
        assert_eq!(bounded.record.storage_size, original.len() as u64);
        assert_eq!(
            bounded.record.storage_sha256,
            hex::encode(Sha256::digest(&original))
        );
        assert_eq!(
            budget.hashed,
            original.len() as u64 * 2 + expected.record.size
        );
        assert_eq!(fs::read(&source).unwrap(), original);
        println!(
            "owned {extension}: stored={} normalized={} hash_work={} original_sha256={} tree_closed={}",
            original.len(),
            bounded.record.size,
            budget.hashed,
            bounded.record.storage_sha256,
            closed.get()
        );
    }
}

#[cfg(windows)]
#[test]
fn supervised_psx_conversion_binds_original_and_normalized_facts() {
    use sha2::{Digest, Sha256};
    let temporary = tempfile::tempdir().unwrap();
    let tool = crate::test_fixture::build_probe(temporary.path());
    let source = temporary.path().join("original.chd");
    let original = chd_header();
    fs::write(&source, &original).unwrap();
    let source = fs::canonicalize(source).unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let closed = Cell::new(true);
    let mut budget = HashBudget {
        operation: None,
        limit: 8192,
        hashed: 0,
        max_zip_entries: 4096,
    };
    let observed = observe_converted_disc(
        DiscInput {
            profile_id: "owned",
            kind: SourceKind::PsxDisc,
            path: &source,
            maximum_size: 8192,
        },
        workspace.path(),
        &mut budget,
        &closed,
        Some(&tool),
    )
    .unwrap()
    .source;
    assert!(closed.get());
    assert_eq!(observed.record.path, source);
    assert_eq!(
        observed.record.sha256,
        hex::encode(Sha256::digest(b"owned psx track"))
    );
    assert_eq!(
        observed.record.storage_sha256,
        hex::encode(Sha256::digest(&original))
    );
    assert_eq!(
        budget.hashed,
        original.len() as u64 * 2 + b"owned psx track".len() as u64
    );
    assert_eq!(observed.discs[0].track_count, 1);
    assert_eq!(fs::read(source).unwrap(), original);
    assert!(workspace.path().join("input.chd").is_file());
}

#[cfg(windows)]
#[test]
fn cancellation_joins_the_decoder_tree_before_private_cleanup_is_allowed() {
    let temporary = tempfile::tempdir().unwrap();
    let tool = crate::test_fixture::build_probe(temporary.path());
    let source = temporary.path().join("original.chd");
    let original = chd_header();
    fs::write(&source, &original).unwrap();
    let source = fs::canonicalize(source).unwrap();
    let workspace = tempfile::tempdir().unwrap();
    // The fixture sees this only beside its private immutable input, never in
    // the connected folder. Its handshake follows an actual descendant spawn.
    fs::write(workspace.path().join("input.conversion-mode"), b"wait").unwrap();
    let service = std::sync::Arc::new(
        crate::PortcoveService::new(Library::open(temporary.path().join("library")).unwrap())
            .unwrap(),
    );
    let (activity, operation) = service
        .begin_cancellable_activity(
            crate::ActivityOperation::DiscoverSources,
            crate::ActivityTargetKind::Library,
            None,
        )
        .unwrap();
    let cancellation = service.clone();
    let ready = workspace.path().join("input.conversion-ready");
    let cancel = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.is_file() {
            assert!(
                Instant::now() < deadline,
                "decoder worker did not reach its handshake"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        cancellation.request_cancellation(&activity.id).unwrap();
    });
    let closed = Cell::new(true);
    let mut budget = HashBudget {
        operation: Some(operation),
        limit: 8192,
        hashed: 0,
        max_zip_entries: 4096,
    };
    let error = observe_converted_disc(
        DiscInput {
            profile_id: "owned",
            kind: SourceKind::PsxDisc,
            path: &source,
            maximum_size: 8192,
        },
        workspace.path(),
        &mut budget,
        &closed,
        Some(&tool),
    )
    .err()
    .expect("actual decoder cancellation");
    cancel.join().unwrap();
    assert_eq!(error.code, crate::ErrorCode::Cancelled);
    assert_eq!(error.details["process_tree_active"], "0");
    assert_eq!(error.details["process_tree_all_retained_signaled"], "true");
    assert!(
        closed.get(),
        "terminal cancellation must follow proved tree closure"
    );
    assert!(
        workspace
            .path()
            .join("input.conversion-child-pid")
            .is_file()
    );
    assert!(!workspace.path().join("input.orphan-output").exists());
    assert!(
        !workspace
            .path()
            .join("input.conversion-unexpected-completion")
            .exists()
    );
    assert_eq!(fs::read(&source).unwrap(), original);
    workspace.close().unwrap();
}

#[cfg(windows)]
#[test]
#[ignore = "owned decoder allocation child selected explicitly"]
fn decoder_allocation_child() {
    let Some(root) = std::env::var_os("PORTCOVE_DECODER_ALLOCATION_FIXTURE") else {
        return;
    };
    let root = Path::new(&root);
    fs::write(
        root.join("allocation-ready"),
        b"actual child reached allocation",
    )
    .unwrap();
    let mut bytes = Vec::<u8>::new();
    let result = if bytes.try_reserve_exact(256 * 1024 * 1024).is_err() {
        "denied"
    } else {
        "allowed"
    };
    fs::write(root.join("allocation-result"), result).unwrap();
}

#[cfg(windows)]
#[test]
fn changing_an_original_while_the_decoder_is_held_cannot_publish_normalized_facts() {
    let temporary = tempfile::tempdir().unwrap();
    let tool = crate::test_fixture::build_probe(temporary.path());
    let source = temporary.path().join("original.chd");
    let original = chd_header();
    fs::write(&source, &original).unwrap();
    let source = fs::canonicalize(source).unwrap();
    let workspace = tempfile::tempdir().unwrap();
    fs::write(
        workspace.path().join("input.conversion-mode"),
        b"inspection-held",
    )
    .unwrap();
    let ready = workspace.path().join("input.conversion-ready");
    let release = workspace.path().join("input.conversion-release");
    let mutable = source.clone();
    let mut changed = original.clone();
    changed[100] = 1;
    let writer_bytes = changed.clone();
    let writer = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.is_file() {
            assert!(
                Instant::now() < deadline,
                "decoder did not reach its held phase"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::write(mutable, writer_bytes).unwrap();
        fs::write(release, b"owned producer finished the change").unwrap();
    });
    let closed = Cell::new(true);
    let mut budget = HashBudget {
        operation: None,
        limit: 8192,
        hashed: 0,
        max_zip_entries: 4096,
    };
    let error = observe_converted_disc(
        DiscInput {
            profile_id: "owned",
            kind: SourceKind::PsxDisc,
            path: &source,
            maximum_size: 8192,
        },
        workspace.path(),
        &mut budget,
        &closed,
        Some(&tool),
    )
    .err()
    .expect("changed original must not yield an observation");
    writer.join().unwrap();
    assert!(error.message.contains("changed"));
    assert!(closed.get());
    assert_eq!(fs::read(source).unwrap(), changed);
    assert_eq!(
        fs::read(workspace.path().join("input.chd")).unwrap(),
        original
    );
}

#[cfg(windows)]
#[test]
fn decoder_job_memory_bound_is_enforced_on_the_actual_child() {
    use crate::process::{ChildProcessClass, ChildProcessPolicy};
    for (limit, expected) in [
        (128 * 1024 * 1024, "denied"),
        (512 * 1024 * 1024, "allowed"),
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let mut spec = ChildProcessPolicy::native_tool_spec(
            ChildProcessClass::HostTool,
            &std::env::current_exe().unwrap(),
        )
        .unwrap();
        spec.args([
            "--exact",
            "source_disc::tests::decoder_allocation_child",
            "--ignored",
            "--nocapture",
        ]);
        spec.env("PORTCOVE_DECODER_ALLOCATION_FIXTURE", temporary.path());
        spec.decoder_limits = Some(crate::process::DecoderLimits {
            memory_bytes: limit,
            file_bytes: 4096,
        });
        let closed = Cell::new(false);
        let mut confirm = || {
            closed.set(true);
            Ok(())
        };
        let result = crate::tool_process::run_tool(
            &mut spec,
            &|| Ok(()),
            crate::tool_process::ToolProcessObserver {
                diagnostics: None,
                quiesced: Some(&mut confirm),
            },
        )
        .unwrap();
        assert!(result.status.success());
        assert!(closed.get());
        assert!(temporary.path().join("allocation-ready").is_file());
        assert_eq!(
            fs::read_to_string(temporary.path().join("allocation-result")).unwrap(),
            expected
        );
    }
}
