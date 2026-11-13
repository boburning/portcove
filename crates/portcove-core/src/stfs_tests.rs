use std::path::Path;

use sha2::{Digest, Sha256};

use super::{fixtures::*, *};

fn cancelled() -> PortcoveError {
    PortcoveError::new(crate::ErrorCode::Cancelled, "fixture cancellation")
}

fn tree() -> Vec<Item> {
    vec![
        file("default.xex", &payload(2 * BLOCK + 17, 3)),
        dir(
            "Media",
            vec![
                file("a.bin", &payload(3000, 5)),
                dir("Deep", vec![file("b.bin", &payload(BLOCK, 7))]),
                file("empty.txt", b""),
            ],
        ),
    ]
}

fn payload(length: usize, seed: u8) -> Vec<u8> {
    (0..length)
        .map(|index| (index as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

fn write(directory: &Path, bytes: &[u8]) -> PathBuf {
    let source = directory.join("source");
    std::fs::write(&source, bytes).unwrap();
    source
}

fn extract(bytes: &[u8]) -> Result<tempfile::TempDir> {
    let temporary = tempfile::tempdir().unwrap();
    let source = write(temporary.path(), bytes);
    let destination = temporary.path().join("assets");
    let result = extract_with_checkpoint(&source, &destination, None, &|| Ok(()));
    assert_eq!(
        std::fs::read(&source).unwrap(),
        bytes,
        "source is never changed"
    );
    result.map(|()| temporary)
}

/// Validation and extraction refuse the bytes, and extraction leaves nothing behind.
fn assert_refused(bytes: &[u8]) -> PortcoveError {
    let temporary = tempfile::tempdir().unwrap();
    let source = write(temporary.path(), bytes);
    let destination = temporary.path().join("assets");
    let error = extract_with_checkpoint(&source, &destination, None, &|| Ok(())).unwrap_err();
    assert!(validate(&source, &|| Ok(())).is_err());
    let names = std::fs::read_dir(temporary.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    // A late hash failure can leave the private staging directory, which the adapter
    // removes; nothing is ever written beside it.
    assert!(
        names
            .iter()
            .all(|name| name == "source" || name == "assets")
    );
    error
}

fn assert_tree(root: &Path) {
    assert_eq!(
        std::fs::read(root.join("default.xex")).unwrap(),
        payload(2 * BLOCK + 17, 3)
    );
    assert_eq!(
        std::fs::read(root.join("Media/a.bin")).unwrap(),
        payload(3000, 5)
    );
    assert_eq!(
        std::fs::read(root.join("Media/Deep/b.bin")).unwrap(),
        payload(BLOCK, 7)
    );
    assert_eq!(std::fs::read(root.join("Media/empty.txt")).unwrap(), b"");
}

#[test]
fn extracts_chained_and_contiguous_live_and_pirs_packages() {
    for allocation in [
        Allocation::Chained,
        Allocation::Contiguous,
        Allocation::ContiguousWithoutPointers,
    ] {
        for magic in [*b"LIVE", *b"PIRS"] {
            let mut builder = live(tree());
            builder.magic = magic;
            builder.allocation = allocation;
            let extracted = extract(&builder.bytes()).unwrap();
            assert_tree(&extracted.path().join("assets"));
        }
    }
}

#[test]
fn chained_files_really_use_the_hash_chain() {
    let built = live(tree()).build();
    let blocks = &built.file("default.xex").blocks;
    assert!(blocks.windows(2).all(|pair| pair[0] > pair[1]));
    // Treating a chained file as contiguous would read the wrong blocks.
    let mut bytes = built.to_vec();
    let entry = built.file("default.xex").entry_offset;
    bytes[entry + 0x28] |= 0x40;
    reseal_block(&mut bytes, 0, built.total_blocks);
    assert_refused(&bytes);
}

#[test]
fn contiguous_files_refuse_a_contradicting_recorded_chain() {
    let mut builder = live(tree());
    builder.allocation = Allocation::Contiguous;
    let built = builder.build();
    let blocks = built.file("default.xex").blocks.clone();
    let mut bytes = built.to_vec();
    set_next(&mut bytes, blocks[0], blocks[2], built.total_blocks);
    assert!(
        assert_refused(&bytes)
            .message
            .contains("disagrees with its recorded block chain")
    );
}

#[test]
fn validates_level_one_trees_with_real_hashes() {
    for allocation in [Allocation::Chained, Allocation::Contiguous] {
        let large = payload(240 * BLOCK + 5, 9);
        let mut builder = live(vec![file("default.xex", &large), file("tail.bin", b"tail")]);
        builder.allocation = allocation;
        let built = builder.build();
        assert!(built.total_blocks > 170);
        let bytes = built.to_vec();
        let extracted = extract(&bytes).unwrap();
        assert_eq!(
            std::fs::read(extracted.path().join("assets/default.xex")).unwrap(),
            large
        );

        // A wrong level-1 entry is caught against the top hash; a resealed level-1 table
        // is then caught against the level-0 table it describes.
        let mut level1 = bytes.clone();
        level1[level1_offset(0) as usize + 0x18] ^= 1;
        assert!(assert_refused(&level1).message.contains("hash check"));
        let mut resealed = level1.clone();
        let table = level1_offset(0) as usize;
        let top = sha1::Sha1::digest(&resealed[table..table + BLOCK]);
        resealed[0x379 + 8..0x379 + 28].copy_from_slice(&top);
        reseal_header(&mut resealed);
        assert!(
            assert_refused(&resealed)
                .message
                .contains("level 0 hash table")
        );
    }
}

#[test]
fn validates_level_two_trees_in_a_sparse_package() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let mut builder = live(vec![file("default.xex", &payload(2 * BLOCK, 1))]);
    builder.data_start = 28_950;
    let built = builder.build();
    assert!(u64::from(built.total_blocks) > 170 * 170);
    built.write_to(&source);

    let summary = validate(&source, &|| Ok(())).unwrap();
    assert_eq!(
        summary.file_sha256("default.xex").unwrap(),
        hex::encode(Sha256::digest(payload(2 * BLOCK, 1)))
    );

    let mut corrupt = std::fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap();
    corrupt.seek(SeekFrom::Start(level1_offset(1) + 4)).unwrap();
    corrupt.write_all(&[0xaa]).unwrap();
    drop(corrupt);
    let error = validate(&source, &|| Ok(())).unwrap_err();
    assert!(error.message.contains("level 1 hash table"), "{error:?}");
}

#[test]
fn reports_verified_header_facts_and_file_digests() {
    let mut builder = pirs(tree());
    builder.version = 7;
    let summary = {
        let temporary = tempfile::tempdir().unwrap();
        let source = write(temporary.path(), &builder.bytes());
        validate(&source, &|| Ok(())).unwrap()
    };
    assert_eq!(summary.header.package_type, StfsPackageType::Pirs);
    assert_eq!(summary.header.title_id_hex(), "58410A6B");
    assert_eq!(summary.header.content_type_hex(), "000D0000");
    assert_eq!(summary.header.media_id, 0x1234_5678);
    assert_eq!(summary.header.version, 7);
    assert_eq!(
        summary
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        [
            "default.xex",
            "Media/a.bin",
            "Media/Deep/b.bin",
            "Media/empty.txt"
        ]
    );
    assert_eq!(
        summary.file_sha256("DEFAULT.XEX").unwrap(),
        hex::encode(Sha256::digest(payload(2 * BLOCK + 17, 3)))
    );

    // Licence entries lie outside the header hash: another owner's copy has different
    // whole-file bytes but the same verified content.
    builder.licence = [0x5a; 16];
    let other = builder.bytes();
    let temporary = tempfile::tempdir().unwrap();
    let source = write(temporary.path(), &other);
    assert_eq!(validate(&source, &|| Ok(())).unwrap(), summary);
}

#[test]
fn refuses_a_changed_byte_at_every_hash_level() {
    let built = live(tree()).build();
    let bytes = built.to_vec();
    let data = data_offset(built.file("Media/a.bin").blocks[0]) as usize;
    let level0 = level0_offset(0) as usize;
    for (label, offset) in [
        ("data block", data + 17),
        ("level-0 entry", level0 + 0x18 * 2),
        ("level-0 next pointer", level0 + 0x18 + 23),
        ("top hash", 0x379 + 8),
        ("header field", 0x360),
        ("header metadata", 0x1691),
    ] {
        let mut changed = bytes.clone();
        changed[offset] ^= 0x01;
        let error = assert_refused(&changed);
        assert!(error.message.contains("hash check"), "{label}: {error:?}");
    }
    // A consistent edit everywhere except the header hash itself.
    let mut changed = bytes.clone();
    changed[0x32c] ^= 1;
    assert!(assert_refused(&changed).message.contains("header"));
}

#[test]
fn refuses_unsupported_containers_with_distinct_reasons() {
    let bytes = live(tree()).bytes();
    for (label, edit, expected) in [
        (
            "CON",
            (|bytes: &mut Vec<u8>| bytes[..4].copy_from_slice(b"CON ")) as fn(&mut Vec<u8>),
            "CON",
        ),
        ("two-table", |bytes| bytes[0x379 + 2] = 0, "two-table"),
        (
            "SVOD",
            |bytes| bytes[0x3a9..0x3ad].copy_from_slice(&1_u32.to_be_bytes()),
            "SVOD",
        ),
        (
            "unknown magic",
            |bytes| bytes[..4].copy_from_slice(b"XEX2"),
            "not an Xbox 360",
        ),
        (
            "descriptor length",
            |bytes| bytes[0x379] = 0x23,
            "volume descriptor",
        ),
    ] {
        let mut changed = bytes.clone();
        edit(&mut changed);
        reseal_header(&mut changed);
        let error = assert_refused(&changed);
        assert!(error.message.contains(expected), "{label}: {error:?}");
        assert_eq!(
            error.presentation().presentation_key,
            "stfs_format_unsupported",
            "{label}"
        );
    }
}

/// Edit the file table and reseal every hash so only the structural check can refuse.
fn with_entry(builder: Builder, path: &str, edit: impl Fn(&mut [u8])) -> Vec<u8> {
    let built = builder.build();
    let mut bytes = built.to_vec();
    let offset = built.file(path).entry_offset;
    edit(&mut bytes[offset..offset + 64]);
    reseal_block(&mut bytes, 0, built.total_blocks);
    bytes
}

#[test]
fn refuses_hostile_tables_and_chains_after_their_hashes_verify() {
    let out_of_range = with_entry(live(tree()), "default.xex", |entry| {
        entry[0x2f..0x32].copy_from_slice(&0x00ff_fff0_u32.to_le_bytes()[..3]);
    });
    assert!(assert_refused(&out_of_range).message.contains("chain"));

    let oversized = with_entry(live(tree()), "Media/a.bin", |entry| {
        entry[0x34..0x38].copy_from_slice(&u32::MAX.to_be_bytes());
    });
    assert!(assert_refused(&oversized).message.contains("size"));

    let short_allocation = with_entry(live(tree()), "default.xex", |entry| {
        entry[0x29] = 1;
    });
    assert!(assert_refused(&short_allocation).message.contains("size"));

    let file_parent = with_entry(live(tree()), "Media/Deep/b.bin", |entry| {
        entry[0x32..0x34].copy_from_slice(&2_u16.to_be_bytes());
    });
    assert!(assert_refused(&file_parent).message.contains("parent"));

    let built = live(tree()).build();
    // Entry 1 is `Media`; pointing it at its own child `Deep` (entry 3) forms a cycle.
    let mut parent_cycle = built.to_vec();
    let media = data_offset(0) as usize + 64;
    parent_cycle[media + 0x32..media + 0x34].copy_from_slice(&3_u16.to_be_bytes());
    reseal_block(&mut parent_cycle, 0, built.total_blocks);
    assert!(assert_refused(&parent_cycle).message.contains("parent"));

    let blocks = built.file("default.xex").blocks.clone();
    let mut cycle = built.to_vec();
    set_next(&mut cycle, blocks[1], blocks[0], built.total_blocks);
    assert!(assert_refused(&cycle).message.contains("cycled"));
    let mut outside = built.to_vec();
    set_next(
        &mut outside,
        blocks[0],
        built.total_blocks,
        built.total_blocks,
    );
    assert!(assert_refused(&outside).message.contains("chain"));

    let mut truncated = built.to_vec();
    truncated.truncate(data_offset(blocks[0]) as usize);
    assert_refused(&truncated);
}

#[test]
fn refuses_unsafe_and_duplicate_names_before_writing() {
    for items in [
        vec![file("..", b"x")],
        vec![dir("..", vec![file("escape.txt", b"x")])],
        vec![file("a:b", b"x")],
        vec![file("default.xex", b"one"), file("DEFAULT.XEX", b"two")],
        vec![dir("Media", vec![]), file("media", b"x")],
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let source = write(temporary.path(), &live(items).bytes());
        let destination = temporary.path().join("assets");
        assert!(extract_with_checkpoint(&source, &destination, None, &|| Ok(())).is_err());
        assert!(validate(&source, &|| Ok(())).is_err());
        assert!(!destination.exists());
    }
}

fn binding(title_ids: &[&str], content_types: &[&str], max: u64) -> crate::StfsPackageProfile {
    crate::StfsPackageProfile {
        content_types: content_types.iter().map(|value| (*value).into()).collect(),
        title_ids: title_ids.iter().map(|value| (*value).into()).collect(),
        max_package_bytes: max,
    }
}

#[test]
fn binding_refuses_another_title_or_content_type_before_any_write() {
    let bytes = live(tree()).bytes();
    let size = bytes.len() as u64;
    let mut update = live(tree());
    update.content_type = 0x000b_0000;
    for (bytes, profile, cause) in [
        (
            bytes.clone(),
            binding(&["58410A6C"], &["000D0000"], size),
            true,
        ),
        (
            update.bytes(),
            binding(&["58410A6B"], &["000D0000"], size),
            true,
        ),
        (
            bytes.clone(),
            binding(&["58410A6B"], &["000D0000"], size - 1),
            false,
        ),
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let source = write(temporary.path(), &bytes);
        let destination = temporary.path().join("assets");
        let checkpoints = std::cell::Cell::new(0);
        let error = extract_with_checkpoint(&source, &destination, Some(&profile), &|| {
            checkpoints.set(checkpoints.get() + 1);
            Ok(())
        })
        .unwrap_err();
        assert!(!destination.exists());
        assert_eq!(checkpoints.get(), 1, "refused before reading the package");
        assert_eq!(
            error.presentation().presentation_key == "stfs_package_mismatch",
            cause,
            "{error:?}"
        );
    }
    let temporary = tempfile::tempdir().unwrap();
    let source = write(temporary.path(), &bytes);
    let destination = temporary.path().join("assets");
    extract_with_checkpoint(
        &source,
        &destination,
        Some(&binding(&["58410a6b"], &["000d0000"], size)),
        &|| Ok(()),
    )
    .unwrap();
    assert_tree(&destination);
}

#[test]
fn cancellation_before_extraction_creates_no_output() {
    let temporary = tempfile::tempdir().unwrap();
    let package = single_file(b"XEX2");
    let source = write(temporary.path(), &package);
    let destination = temporary.path().join("assets");

    let error =
        extract_with_checkpoint(&source, &destination, None, &|| Err(cancelled())).unwrap_err();

    assert_eq!(error.code, crate::ErrorCode::Cancelled);
    assert!(!destination.exists());
    assert_eq!(std::fs::read(&source).unwrap(), package);
}

#[test]
fn cancellation_after_a_copied_block_stops_before_the_remaining_payload() {
    let temporary = tempfile::tempdir().unwrap();
    let payload = payload(2 * BLOCK + 17, 11);
    let package = single_file(&payload);
    let source = write(temporary.path(), &package);
    let destination = temporary.path().join("assets");
    let output = destination.join("default.xex");
    let checkpoint = || {
        if std::fs::metadata(&output).is_ok_and(|metadata| metadata.len() >= BLOCK as u64) {
            Err(cancelled())
        } else {
            Ok(())
        }
    };

    let error = extract_with_checkpoint(&source, &destination, None, &checkpoint).unwrap_err();

    assert_eq!(error.code, crate::ErrorCode::Cancelled);
    // The adapter owns this private output's cleanup. The extractor must
    // return before copying the rest, without changing the original package.
    assert_eq!(std::fs::read(&output).unwrap(), payload[..BLOCK]);
    assert_eq!(std::fs::read(&source).unwrap(), package);
}

#[test]
fn cancellation_after_the_final_payload_block_does_not_report_success() {
    let temporary = tempfile::tempdir().unwrap();
    let package = single_file(b"XEX2");
    let source = write(temporary.path(), &package);
    let destination = temporary.path().join("assets");
    let output = destination.join("default.xex");
    let checkpoint = || {
        if std::fs::metadata(&output).is_ok_and(|metadata| metadata.len() == 4) {
            Err(cancelled())
        } else {
            Ok(())
        }
    };

    let error = extract_with_checkpoint(&source, &destination, None, &checkpoint).unwrap_err();

    assert_eq!(error.code, crate::ErrorCode::Cancelled);
    assert_eq!(std::fs::read(&output).unwrap(), b"XEX2");
    assert_eq!(std::fs::read(&source).unwrap(), package);
}

#[test]
fn validates_a_package_without_creating_output() {
    let temporary = tempfile::tempdir().unwrap();
    let package = single_file(b"XEX2");
    let source = write(temporary.path(), &package);

    let summary = validate(&source, &|| Ok(())).unwrap();

    assert_eq!(summary.files.len(), 1);
    assert_eq!(std::fs::read(&source).unwrap(), package);
    assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 1);
}

#[test]
fn the_historical_single_file_layout_is_preserved() {
    let package = single_file(b"XEX2");
    assert_eq!(package.len(), 0xe000);
    assert_eq!(&package[0xc000..0xc00b], b"default.xex");
    assert_eq!(&package[0xd000..0xd004], b"XEX2");
}
