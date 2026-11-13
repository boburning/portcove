use std::{cell::Cell, collections::BTreeMap, path::Path};

use super::{
    DiscImage, DiscPlan, MAX_IMAGE_BYTES, ensure_free_space, fixtures::*, parse_iso_record,
    required_free_bytes,
};
use crate::{DiscImageFormat, ErrorCode, PortcoveError, Result};

const XDVDFS_OFFSETS: [u64; 4] = [0, 0x0208_0000, 0x0FD9_0000, 0x1830_0000];

fn ok() -> Result<()> {
    Ok(())
}

fn cancelled() -> PortcoveError {
    PortcoveError::new(ErrorCode::Cancelled, "cancelled")
}

fn sample() -> Vec<Item> {
    vec![
        file("default.xex", b"XEX2-payload"),
        file("empty.bin", b""),
        dir(
            "Media",
            vec![
                dir("Deep", vec![file("a.dat", &vec![7_u8; 5000])]),
                file("b.txt", b"hello"),
            ],
        ),
        dir("EmptyDir", vec![]),
    ]
}

fn expected_tree() -> BTreeMap<String, Option<Vec<u8>>> {
    BTreeMap::from([
        ("default.xex".into(), Some(b"XEX2-payload".to_vec())),
        ("empty.bin".into(), Some(Vec::new())),
        ("Media".into(), None),
        ("Media/Deep".into(), None),
        ("Media/Deep/a.dat".into(), Some(vec![7_u8; 5000])),
        ("Media/b.txt".into(), Some(b"hello".to_vec())),
        ("EmptyDir".into(), None),
    ])
}

fn read_tree(root: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    fn walk(root: &Path, directory: &Path, out: &mut BTreeMap<String, Option<Vec<u8>>>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            assert!(!metadata.file_type().is_symlink());
            if metadata.is_dir() {
                out.insert(relative, None);
                walk(root, &path, out);
            } else {
                out.insert(relative, Some(std::fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn plan(image: &Image, format: DiscImageFormat) -> Result<DiscPlan> {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("image.bin");
    image.write_to(&path);
    DiscImage::open(&path, format, MAX_IMAGE_BYTES)?.plan(&|| ok())
}

fn refused(image: &Image, format: DiscImageFormat) -> PortcoveError {
    let error = plan(image, format).expect_err("hostile image must be refused");
    assert_eq!(error.code, ErrorCode::SourceInvalid, "{}", error.message);
    error
}

fn extract(image: &Image, format: DiscImageFormat) -> BTreeMap<String, Option<Vec<u8>>> {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("image.bin");
    image.write_to(&path);
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions).unwrap();
    let before = (
        std::fs::read(&path).unwrap(),
        std::fs::metadata(&path).unwrap().modified().unwrap(),
    );
    let mut disc = DiscImage::open(&path, format, MAX_IMAGE_BYTES).unwrap();
    let plan = disc.plan(&|| ok()).unwrap();
    let staging = directory.path().join("staging");
    let reported = Cell::new((0, 0));
    disc.extract(&plan, &staging, &|| ok(), &|done, total| {
        reported.set((done, total))
    })
    .unwrap();
    assert_eq!(reported.get(), (plan.expanded_bytes, plan.expanded_bytes));
    let after = (
        std::fs::read(&path).unwrap(),
        std::fs::metadata(&path).unwrap().modified().unwrap(),
    );
    assert_eq!(before, after, "the source image must be untouched");
    read_tree(&staging)
}

#[test]
fn xdvdfs_extracts_identical_trees_at_every_partition_offset() {
    for base in XDVDFS_OFFSETS {
        let image = xiso(base, sample());
        assert_eq!(
            extract(&image, DiscImageFormat::Xdvdfs),
            expected_tree(),
            "partition offset {base:#x}"
        );
    }
}

#[test]
fn iso9660_extracts_identical_trees_and_strips_version_suffixes() {
    let image = iso(sample());
    assert_eq!(extract(&image, DiscImageFormat::Iso9660), expected_tree());
}

#[test]
fn iso9660_treats_an_empty_extension_dot_as_part_of_the_record_syntax() {
    let image = iso(vec![file("NOEXT.", b"x")]);
    let planned = plan(&image, DiscImageFormat::Iso9660).unwrap();
    assert_eq!(planned.entries[0].relative, Path::new("NOEXT"));
}

fn xdvdfs_record(image: &Image, name: &str) -> u64 {
    image.find(name.as_bytes()) - 14
}

fn iso_record_at(image: &Image, name: &str) -> u64 {
    image.find(name.as_bytes()) - 33
}

#[test]
fn xdvdfs_refuses_hostile_names_before_planning_succeeds() {
    let cases: Vec<(&str, Vec<Item>)> = vec![
        ("dot-dot", vec![file("..", b"x")]),
        ("dot", vec![file(".", b"x")]),
        ("reserved", vec![file("CON", b"x")]),
        ("reserved with extension", vec![file("aux.txt", b"x")]),
        ("numbered device", vec![file("COM1", b"x")]),
        ("trailing dot", vec![file("bad.", b"x")]),
        ("trailing space", vec![file("bad ", b"x")]),
        ("backslash", vec![file("a\\b", b"x")]),
        ("slash", vec![file("a/b", b"x")]),
        ("non-ascii", vec![file("caf\u{e9}", b"x")]),
        ("control character", vec![file("a\u{1}b", b"x")]),
        (
            "case collision",
            vec![file("README.TXT", b"x"), file("readme.txt", b"y")],
        ),
        (
            "file and folder collision",
            vec![file("Same", b"x"), dir("same", vec![file("a", b"y")])],
        ),
        (
            "nested case collision",
            vec![dir("D", vec![file("A", b"1"), file("a", b"2")])],
        ),
    ];
    for (label, items) in cases {
        let error = refused(&xiso(0, items), DiscImageFormat::Xdvdfs);
        assert!(!error.message.is_empty(), "{label}");
    }
}

#[test]
fn xdvdfs_refuses_hostile_structure() {
    let wide = || {
        xiso(
            0,
            vec![
                file("aaa.bin", b"1"),
                file("bbb.bin", b"2"),
                file("ccc.bin", b"3"),
                dir("sub", vec![file("x.bin", b"4")]),
                dir("sub2", vec![file("y.bin", b"5")]),
                file("data.bin", &vec![9_u8; 5000]),
                file("more.bin", &vec![8_u8; 5000]),
            ],
        )
    };

    // Tree pointer that revisits an earlier entry.
    let mut image = wide();
    let target = (xdvdfs_record(&image, "bbb.bin") - xdvdfs_record(&image, "aaa.bin")) / 4;
    let last = xdvdfs_record(&image, "sub2");
    image.patch(last + 2, &(target as u16).to_le_bytes());
    refused(&image, DiscImageFormat::Xdvdfs);

    // A folder pointing back at the root table.
    let mut image = wide();
    let root_sector = u32::from_le_bytes(image.segments[0].1[20..24].try_into().unwrap());
    let record = xdvdfs_record(&image, "sub2");
    image.patch(record + 4, &root_sector.to_le_bytes());
    refused(&image, DiscImageFormat::Xdvdfs);

    // Two folders sharing one directory table.
    let mut image = wide();
    let first = xdvdfs_record(&image, "sub");
    let second = xdvdfs_record(&image, "sub2");
    let sector: Vec<u8> = {
        let (offset, bytes) = image
            .segments
            .iter()
            .find(|(offset, _)| *offset <= first && first < offset + bytes_len(&image, *offset))
            .unwrap();
        let at = (first - offset) as usize;
        bytes[at + 4..at + 8].to_vec()
    };
    image.patch(second + 4, &sector);
    refused(&image, DiscImageFormat::Xdvdfs);

    // A file extent past the end of the image.
    let mut image = wide();
    let record = xdvdfs_record(&image, "data.bin");
    image.patch(record + 8, &0x7fff_0000_u32.to_le_bytes());
    refused(&image, DiscImageFormat::Xdvdfs);

    // Two files whose extents partly overlap.
    let mut image = wide();
    let data = xdvdfs_record(&image, "data.bin");
    let more = xdvdfs_record(&image, "more.bin");
    let data_sector = read_u32(&image, data + 4);
    image.patch(more + 4, &(data_sector + 1).to_le_bytes());
    refused(&image, DiscImageFormat::Xdvdfs);

    // An oversized root directory table.
    let mut image = wide();
    image.patch(32 * 2048 + 24, &(5 * 1024 * 1024_u32).to_le_bytes());
    let error = refused(&image, DiscImageFormat::Xdvdfs);
    assert!(error.message.contains("too large"), "{}", error.message);

    // Zero-length and overlong names.
    let mut image = wide();
    let record = xdvdfs_record(&image, "ccc.bin");
    image.patch(record + 13, &[0]);
    refused(&image, DiscImageFormat::Xdvdfs);
    let mut image = wide();
    let record = xdvdfs_record(&image, "sub2");
    image.patch(record + 13, &[255]);
    refused(&image, DiscImageFormat::Xdvdfs);
}

fn bytes_len(image: &Image, offset: u64) -> u64 {
    image
        .segments
        .iter()
        .find(|(start, _)| *start == offset)
        .map_or(0, |(_, bytes)| bytes.len() as u64)
}

fn read_u32(image: &Image, offset: u64) -> u32 {
    let (start, bytes) = image
        .segments
        .iter()
        .find(|(start, bytes)| *start <= offset && offset < start + bytes.len() as u64)
        .unwrap();
    let at = (offset - start) as usize;
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

#[test]
fn xdvdfs_refuses_truncated_missing_and_ambiguous_volumes() {
    let image = xiso(0, sample());
    let length = image.len;
    refused(
        &xiso(0, sample()).truncated(length - 2 * 2048),
        DiscImageFormat::Xdvdfs,
    );
    refused(
        &xiso(0, sample()).truncated(10 * 1024),
        DiscImageFormat::Xdvdfs,
    );
    refused(&iso(sample()), DiscImageFormat::Xdvdfs);
    refused(&xiso(0, vec![]), DiscImageFormat::Xdvdfs);

    let mut ambiguous = xiso(0, sample());
    let descriptor = ambiguous.segments[0].1.clone();
    ambiguous.put(0x0208_0000 + 32 * 2048, &descriptor);
    let error = refused(&ambiguous, DiscImageFormat::Xdvdfs);
    assert!(error.message.contains("more than one"));
}

#[test]
fn iso9660_refuses_hostile_records() {
    let base = || {
        iso(vec![
            file("A.BIN", b"aaaa"),
            file("B.TXT", b"bbbb"),
            file("DATA.BIN", &vec![1_u8; 5000]),
            file("MORE.BIN", &vec![2_u8; 5000]),
            dir("SUB", vec![file("X.BIN", b"x")]),
        ])
    };
    plan(&base(), DiscImageFormat::Iso9660).unwrap();

    // Multi-extent and interleaved files are never mis-extracted.
    let mut image = base();
    let record = iso_record_at(&image, "B.TXT;1");
    image.patch(record + 25, &[0x80]);
    let error = refused(&image, DiscImageFormat::Iso9660);
    assert!(error.message.contains("multi-extent"));
    for field in [26, 27] {
        let mut image = base();
        let record = iso_record_at(&image, "B.TXT;1");
        image.patch(record + field, &[1]);
        let error = refused(&image, DiscImageFormat::Iso9660);
        assert!(error.message.contains("interleaved"));
    }

    // Disagreeing little- and big-endian fields.
    let mut image = base();
    let record = iso_record_at(&image, "B.TXT;1");
    image.patch(record + 14, &9_u32.to_be_bytes());
    refused(&image, DiscImageFormat::Iso9660);

    // Extent past the volume.
    let mut image = base();
    let record = iso_record_at(&image, "B.TXT;1");
    image.patch(record + 2, &0x00ff_0000_u32.to_le_bytes());
    image.patch(record + 6, &0x00ff_0000_u32.to_be_bytes());
    refused(&image, DiscImageFormat::Iso9660);

    // Partly overlapping files.
    let mut image = base();
    let data = iso_record_at(&image, "DATA.BIN;1");
    let more = iso_record_at(&image, "MORE.BIN;1");
    let sector = read_u32(&image, data + 2) + 1;
    image.patch(more + 2, &sector.to_le_bytes());
    image.patch(more + 6, &sector.to_be_bytes());
    refused(&image, DiscImageFormat::Iso9660);

    // A folder pointing back at the root.
    let mut image = base();
    let root = read_u32(&image, 16 * 2048 + 156 + 2);
    let record = iso_record_at(&image, "SUB");
    image.patch(record + 2, &root.to_le_bytes());
    image.patch(record + 6, &root.to_be_bytes());
    refused(&image, DiscImageFormat::Iso9660);

    // Invalid version suffix.
    let mut image = base();
    let at = image.find(b"B.TXT;1") + 6;
    image.patch(at, b"x");
    refused(&image, DiscImageFormat::Iso9660);

    // Not 2048-byte sectors; truncated volume; oversized root table.
    let mut image = base();
    image.patch(16 * 2048 + 128, &4096_u16.to_le_bytes());
    refused(&image, DiscImageFormat::Iso9660);
    let image = base();
    let length = image.len;
    refused(&base().truncated(length - 2048), DiscImageFormat::Iso9660);
    let mut image = base();
    image.patch(16 * 2048 + 156 + 10, &(5 * 1024 * 1024_u32).to_le_bytes());
    image.patch(16 * 2048 + 156 + 14, &(5 * 1024 * 1024_u32).to_be_bytes());
    // The root extent no longer fits the volume, so it is refused as invalid.
    refused(&image, DiscImageFormat::Iso9660);

    // A record that runs past its sector.
    let mut image = base();
    let record = iso_record_at(&image, "MORE.BIN;1");
    image.patch(record, &[250]);
    refused(&image, DiscImageFormat::Iso9660);
}

#[test]
fn iso9660_refuses_hostile_names() {
    for (label, name) in [
        ("dot-dot", ".."),
        ("reserved", "NUL"),
        ("reserved with extension", "PRN.TXT"),
        ("backslash", "A\\B"),
        ("non-ascii", "caf\u{e9}"),
    ] {
        refused(&iso(vec![file(name, b"x")]), DiscImageFormat::Iso9660);
        let _ = label;
    }
    refused(
        &iso(vec![file("A.TXT", b"1"), file("a.txt", b"2")]),
        DiscImageFormat::Iso9660,
    );
}

#[test]
fn identical_repeated_file_extents_are_accepted_but_counted() {
    let mut image = xiso(
        0,
        vec![
            file("one.bin", &vec![3_u8; 4096]),
            file("two.bin", &vec![4_u8; 4096]),
        ],
    );
    let one = xdvdfs_record(&image, "one.bin");
    let two = xdvdfs_record(&image, "two.bin");
    let sector = read_u32(&image, one + 4);
    image.patch(two + 4, &sector.to_le_bytes());
    let planned = plan(&image, DiscImageFormat::Xdvdfs).unwrap();
    assert_eq!(planned.expanded_bytes, 8192);
}

#[test]
fn expanded_size_is_capped_by_the_image_size() {
    // Many names for one extent can never expand beyond the image itself.
    let mut many = Vec::new();
    for index in 0..40 {
        many.push(file(&format!("f{index:02}.bin"), &vec![1_u8; 4096]));
    }
    let mut big = xiso(0, many);
    let first = xdvdfs_record(&big, "f00.bin");
    let sector = read_u32(&big, first + 4);
    for index in 1..40 {
        let record = xdvdfs_record(&big, &format!("f{index:02}.bin"));
        big.patch(record + 4, &sector.to_le_bytes());
    }
    big.patch(first + 8, &(1024 * 1024_u32).to_le_bytes());
    for index in 1..40 {
        let record = xdvdfs_record(&big, &format!("f{index:02}.bin"));
        big.patch(record + 8, &(1024 * 1024_u32).to_le_bytes());
    }
    let error = refused(&big, DiscImageFormat::Xdvdfs);
    assert!(error.message.contains("size limit") || error.message.contains("extends"));
}

#[test]
fn the_profile_image_limit_is_enforced_before_reading() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("image.bin");
    xiso(0, sample()).write_to(&path);
    let size = std::fs::metadata(&path).unwrap().len();
    let error = DiscImage::open(&path, DiscImageFormat::Xdvdfs, size - 1)
        .err()
        .unwrap();
    assert_eq!(error.code, ErrorCode::SourceInvalid);
    assert!(DiscImage::open(&path, DiscImageFormat::Xdvdfs, size).is_ok());
    // A profile can never lift the fixed ceiling.
    assert!(DiscImage::open(&path, DiscImageFormat::Xdvdfs, u64::MAX).is_ok());
}

#[test]
fn root_files_can_be_peeked_with_a_byte_bound() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("image.bin");
    iso(vec![
        file("SYSTEM.CNF", b"BOOT2 = cdrom0:\\SLUS_200.62;1\r\n"),
        dir("PSP_GAME", vec![file("PARAM.SFO", b"sfo-bytes")]),
    ])
    .write_to(&path);
    let mut disc = DiscImage::open(&path, DiscImageFormat::Iso9660, MAX_IMAGE_BYTES).unwrap();
    let all = disc
        .read_root_file("system.cnf", 4096, &|| ok())
        .unwrap()
        .unwrap();
    assert!(all.starts_with(b"BOOT2"));
    let prefix = disc
        .read_root_file("SYSTEM.CNF", 5, &|| ok())
        .unwrap()
        .unwrap();
    assert_eq!(prefix, b"BOOT2");
    assert_eq!(
        disc.read_root_file("psp_game/param.sfo", 64, &|| ok())
            .unwrap()
            .unwrap(),
        b"sfo-bytes"
    );
    assert!(
        disc.read_root_file("missing.bin", 64, &|| ok())
            .unwrap()
            .is_none()
    );
    // A folder is not a file, and a file is not a folder.
    assert!(
        disc.read_root_file("PSP_GAME", 64, &|| ok())
            .unwrap()
            .is_none()
    );
    assert!(
        disc.read_root_file("SYSTEM.CNF/x", 64, &|| ok())
            .unwrap()
            .is_none()
    );
}

#[test]
fn cancellation_at_every_checkpoint_never_reports_success() {
    for (format, image) in [
        (DiscImageFormat::Xdvdfs, xiso(0, sample())),
        (DiscImageFormat::Iso9660, iso(sample())),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("image.bin");
        image.write_to(&path);
        let run = |stop_at: usize| -> (Result<()>, usize) {
            let calls = Cell::new(0_usize);
            let checkpoint = || {
                calls.set(calls.get() + 1);
                if calls.get() == stop_at {
                    Err(cancelled())
                } else {
                    Ok(())
                }
            };
            let staging = directory.path().join(format!("staging-{stop_at}"));
            let result = DiscImage::open(&path, format, MAX_IMAGE_BYTES).and_then(|mut disc| {
                let plan = disc.plan(&checkpoint)?;
                disc.extract(&plan, &staging, &checkpoint, &|_, _| {})
            });
            (result, calls.get())
        };
        let (success, total) = run(usize::MAX);
        success.unwrap();
        assert!(total > 8, "{format:?} exercised {total} checkpoints");
        for stop_at in 1..=total {
            let (result, _) = run(stop_at);
            let error = result.expect_err(&format!("{format:?} cancelled at {stop_at}/{total}"));
            assert_eq!(error.code, ErrorCode::Cancelled);
        }
    }
}

#[test]
fn free_space_is_checked_with_a_margin_before_any_write() {
    assert_eq!(required_free_bytes(0), 64 * 1024 * 1024);
    assert_eq!(
        required_free_bytes(3_200_000_000),
        3_200_000_000 + 100_000_000
    );
    let directory = tempfile::tempdir().unwrap();
    ensure_free_space(directory.path(), 1024).unwrap();
    let error = ensure_free_space(directory.path(), u64::MAX / 2).unwrap_err();
    assert_eq!(error.code, ErrorCode::State);
    assert!(error.details.contains_key("required_bytes"));
    assert!(error.details.contains_key("available_bytes"));
}

#[test]
fn extraction_refuses_an_existing_destination_and_changed_sources() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("image.bin");
    iso(sample()).write_to(&path);
    let mut disc = DiscImage::open(&path, DiscImageFormat::Iso9660, MAX_IMAGE_BYTES).unwrap();
    let plan = disc.plan(&|| ok()).unwrap();
    let existing = directory.path().join("existing");
    std::fs::create_dir(&existing).unwrap();
    std::fs::write(existing.join("keep.txt"), b"keep").unwrap();
    assert!(
        disc.extract(&plan, &existing, &|| ok(), &|_, _| {})
            .is_err()
    );
    assert_eq!(std::fs::read(existing.join("keep.txt")).unwrap(), b"keep");
}

/// One directory record for `A.BIN;1` followed by the given system-use bytes.
fn iso_record_with_system_use(area: &[u8]) -> Vec<u8> {
    let name = b"A.BIN;1";
    let minimal = (33 + name.len()).div_ceil(2) * 2;
    let mut record = vec![0_u8; minimal];
    record[0] = (minimal + area.len()) as u8;
    record[2..6].copy_from_slice(&20_u32.to_le_bytes());
    record[6..10].copy_from_slice(&20_u32.to_be_bytes());
    record[10..14].copy_from_slice(&5_u32.to_le_bytes());
    record[14..18].copy_from_slice(&5_u32.to_be_bytes());
    record[32] = name.len() as u8;
    record[33..33 + name.len()].copy_from_slice(name);
    record.extend_from_slice(area);
    record
}

#[test]
fn iso9660_accepts_zero_padding_xa_and_susp_but_not_other_system_use_bytes() {
    // No system-use area at all.
    assert!(parse_iso_record(&iso_record_with_system_use(&[])).is_ok());
    // Plain zero padding, as written by Sony PS2 mastering, of any length.
    for length in [1_usize, 14, 40] {
        assert!(parse_iso_record(&iso_record_with_system_use(&vec![0; length])).is_ok());
    }
    // A CD-XA tail.
    let mut xa = [0_u8; 14];
    xa[6..8].copy_from_slice(b"XA");
    assert!(parse_iso_record(&iso_record_with_system_use(&xa)).is_ok());
    // A well-formed SUSP entry.
    assert!(parse_iso_record(&iso_record_with_system_use(&[b'R', b'R', 5, 1, 0x81])).is_ok());
    // Anything else, such as a following record swallowed by a corrupted
    // length, is still refused.
    let mut swallowed = vec![0_u8; 14];
    swallowed[0] = 34;
    swallowed[5] = 1;
    assert!(parse_iso_record(&iso_record_with_system_use(&swallowed)).is_err());
    let mut mixed = vec![0_u8; 14];
    mixed[13] = 7;
    assert!(parse_iso_record(&iso_record_with_system_use(&mixed)).is_err());
}

#[test]
fn iso9660_refuses_a_record_that_is_missing_its_pad_byte() {
    // `AB.BIN;1` is eight bytes long, so ECMA-119 requires one pad byte after it:
    // the record is 42 bytes, and 41 is malformed (an empty system-use area must
    // not be mistaken for zero padding).
    let name = b"AB.BIN;1";
    let build = |length: usize| {
        let mut record = vec![0_u8; length];
        record[0] = length as u8;
        record[2..6].copy_from_slice(&20_u32.to_le_bytes());
        record[6..10].copy_from_slice(&20_u32.to_be_bytes());
        record[10..14].copy_from_slice(&5_u32.to_le_bytes());
        record[14..18].copy_from_slice(&5_u32.to_be_bytes());
        record[32] = name.len() as u8;
        record[33..33 + name.len()].copy_from_slice(name);
        record
    };
    assert!(parse_iso_record(&build(42)).is_ok());
    assert!(parse_iso_record(&build(41)).is_err());
}

mod cso {
    use std::io::Write;

    use super::*;
    use crate::disc_filesystem::{DiscContainer, cso_header, expand_cso, sniff_container};

    fn expand(bytes: &[u8]) -> Result<Vec<u8>> {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("image.cso");
        std::fs::write(&source, bytes).unwrap();
        let header = cso_header(&source)?;
        let target = temporary.path().join("out.iso");
        expand_cso(&source, &header, &target, &ok)?;
        Ok(std::fs::read(target).unwrap())
    }

    fn sample_iso() -> Vec<u8> {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("a.iso");
        iso(sample()).write_to(&path);
        std::fs::read(path).unwrap()
    }

    #[test]
    fn a_cso_inflates_to_the_same_bytes_as_the_iso() {
        let plain = sample_iso();
        for (name, mode) in [
            ("deflated", (|_| 1) as fn(usize) -> u8),
            ("stored", |_| 0),
            ("mixed", |block| (block % 3 == 0) as u8),
        ] {
            assert_eq!(
                expand(&cso_bytes(&plain, 2048, mode)).unwrap(),
                plain,
                "{name}"
            );
        }
        // The inflated image reads as the same file system.
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("a.iso");
        std::fs::write(&path, expand(&cso_bytes(&plain, 2048, |_| 1)).unwrap()).unwrap();
        let mut image = DiscImage::open(&path, DiscImageFormat::Iso9660, MAX_IMAGE_BYTES).unwrap();
        let plan = image.plan(&ok).unwrap();
        assert!(plan.entries.iter().any(|entry| !entry.directory));
    }

    #[test]
    fn a_larger_block_size_is_accepted() {
        let plain = sample_iso();
        assert_eq!(expand(&cso_bytes(&plain, 8192, |_| 1)).unwrap(), plain);
    }

    #[test]
    fn hostile_cso_images_are_refused() {
        let plain = sample_iso();
        let good = cso_bytes(&plain, 2048, |_| 1);
        let refused = |bytes: Vec<u8>, why: &str| {
            let error = expand(&bytes).expect_err(why);
            assert_eq!(error.code, ErrorCode::SourceInvalid, "{why}");
        };
        let patched = |at: usize, value: &[u8]| {
            let mut bytes = good.clone();
            bytes[at..at + value.len()].copy_from_slice(value);
            bytes
        };
        refused(patched(0, b"CISX"), "magic");
        refused(patched(4, &20_u32.to_le_bytes()), "header size");
        refused(patched(20, &[2]), "version");
        refused(patched(21, &[9]), "index shift");
        refused(patched(16, &1000_u32.to_le_bytes()), "block size");
        refused(patched(16, &1_048_576_u32.to_le_bytes()), "huge block size");
        refused(
            patched(8, &1_u64.to_le_bytes()),
            "size not a sector multiple",
        );
        refused(patched(8, &0_u64.to_le_bytes()), "zero size");
        refused(good[..good.len() - 40].to_vec(), "truncated data");
        refused(good[..40].to_vec(), "truncated index");
        // An index entry pointing backwards, and one pointing past the file.
        refused(patched(28, &30_u32.to_le_bytes()), "backwards index");
        refused(patched(28, &u32::MAX.to_le_bytes()), "index past the file");
        // The size claims one more block than the file holds.
        refused(
            patched(8, &((plain.len() as u64) + 2048).to_le_bytes()),
            "size larger than the data",
        );
    }

    #[test]
    fn a_block_that_inflates_to_the_wrong_size_is_refused() {
        // A deflated block of 4096 bytes in a 2048-byte block, and one of 1024 bytes.
        for wrong in [4096_usize, 1024] {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(&vec![5_u8; wrong]).unwrap();
            let block = encoder.finish().unwrap();
            let base = 24 + 2 * 4;
            let mut bytes = Vec::new();
            bytes.extend_from_slice(b"CISO");
            bytes.extend_from_slice(&24_u32.to_le_bytes());
            bytes.extend_from_slice(&2048_u64.to_le_bytes());
            bytes.extend_from_slice(&2048_u32.to_le_bytes());
            bytes.extend_from_slice(&[1, 0, 0, 0]);
            bytes.extend_from_slice(&(base as u32).to_le_bytes());
            bytes.extend_from_slice(&((base + block.len()) as u32).to_le_bytes());
            bytes.extend_from_slice(&block);
            let error = expand(&bytes).expect_err("wrong inflated size");
            assert_eq!(error.code, ErrorCode::SourceInvalid, "{wrong}");
        }
    }

    #[test]
    fn expansion_stops_when_cancelled() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("image.cso");
        std::fs::write(&source, cso_bytes(&sample_iso(), 2048, |_| 1)).unwrap();
        let header = cso_header(&source).unwrap();
        let error = expand_cso(&source, &header, &temporary.path().join("out.iso"), &|| {
            Err(cancelled())
        })
        .expect_err("cancelled");
        assert_eq!(error.code, ErrorCode::Cancelled);
    }

    #[test]
    fn containers_are_recognised_by_magic() {
        let temporary = tempfile::tempdir().unwrap();
        let check = |bytes: &[u8]| {
            let path = temporary.path().join("x");
            std::fs::write(&path, bytes).unwrap();
            sniff_container(&path)
        };
        assert_eq!(check(b"CISO....").unwrap(), DiscContainer::Cso);
        assert_eq!(check(b"\0\0\0\0").unwrap(), DiscContainer::Plain);
        assert_eq!(check(b"").unwrap(), DiscContainer::Plain);
        assert!(check(b"ZISO....").is_err());
    }
}

mod cd {
    use super::*;
    use crate::disc_filesystem::{CdTrackMode, cd_track_to_iso, chd_is_cd, first_cd_track};

    fn chd_with(tags: &[&[u8; 4]]) -> Vec<u8> {
        let mut bytes = vec![0_u8; 124];
        bytes[..8].copy_from_slice(b"MComprHD");
        bytes[8..12].copy_from_slice(&124_u32.to_be_bytes());
        bytes[12..16].copy_from_slice(&5_u32.to_be_bytes());
        let first = bytes.len() as u64;
        bytes[48..56].copy_from_slice(&(if tags.is_empty() { 0 } else { first }).to_be_bytes());
        for (number, tag) in tags.iter().enumerate() {
            let here = bytes.len() as u64;
            let next = if number + 1 == tags.len() {
                0
            } else {
                here + 16 + 4
            };
            bytes.extend_from_slice(*tag);
            bytes.extend_from_slice(&[1, 0, 0, 4]);
            bytes.extend_from_slice(&next.to_be_bytes());
            bytes.extend_from_slice(b"data");
        }
        bytes
    }

    #[test]
    fn a_chd_is_classified_as_cd_or_dvd_from_its_metadata() {
        let temporary = tempfile::tempdir().unwrap();
        let check = |bytes: Vec<u8>| {
            let path = temporary.path().join("x.chd");
            std::fs::write(&path, bytes).unwrap();
            chd_is_cd(&path)
        };
        assert!(check(chd_with(&[b"CHT2"])).unwrap());
        assert!(check(chd_with(&[b"CHT2", b"CHT2"])).unwrap());
        assert!(!check(chd_with(&[b"DVD "])).unwrap());
        assert!(check(chd_with(&[])).is_err(), "no metadata");
        assert!(check(chd_with(&[b"DVD ", b"CHT2"])).is_err(), "both");
        let mut bad = chd_with(&[b"CHT2"]);
        bad[48..56].copy_from_slice(&u64::MAX.to_be_bytes());
        assert!(check(bad).is_err(), "pointer past the file");
        let mut cyclic = chd_with(&[b"CHT2"]);
        cyclic[124 + 8..124 + 16].copy_from_slice(&124_u64.to_be_bytes());
        assert!(check(cyclic).unwrap(), "a cycle ends at the bound");
        assert!(check(b"MComprHD".to_vec()).is_err(), "short header");
    }

    #[test]
    fn the_first_data_track_comes_from_the_cue_sheet() {
        let cue = |text: &str| first_cd_track(text);
        assert_eq!(
            cue("FILE \"disc1.bin\" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n")
                .unwrap(),
            ("disc1.bin".to_owned(), CdTrackMode::Mode1Cooked)
        );
        assert_eq!(
            cue("FILE \"d.bin\" BINARY\n TRACK 01 MODE2/2352\n")
                .unwrap()
                .1,
            CdTrackMode::Mode2Form1Raw
        );
        assert_eq!(
            cue("FILE \"d.bin\" BINARY\n TRACK 01 MODE1/2352\n")
                .unwrap()
                .1,
            CdTrackMode::Mode1Raw
        );
        for bad in [
            "",
            "TRACK 01 MODE1/2048\n",
            "FILE \"a.bin\" BINARY\n TRACK 01 AUDIO\n",
            "FILE \"a.bin\" BINARY\n TRACK 02 MODE1/2048\n",
            "FILE \"a.bin\" BINARY\n TRACK 01 MODE2/2336\n",
            "FILE \"../a.bin\" BINARY\n TRACK 01 MODE1/2048\n",
            "FILE \"x/a.bin\" BINARY\n TRACK 01 MODE1/2048\n",
            "FILE \"\" BINARY\n TRACK 01 MODE1/2048\n",
            "FILE a.bin BINARY\n TRACK 01 MODE1/2048\n",
        ] {
            assert!(cue(bad).is_err(), "{bad:?}");
        }
    }

    fn raw_sector(mode: u8, form2: bool, payload: &[u8]) -> Vec<u8> {
        let mut sector = vec![0_u8; 2352];
        sector[1..11].fill(255);
        sector[15] = mode;
        let at = if mode == 1 {
            16
        } else {
            let submode = if form2 { 0x20 } else { 0x08 };
            sector[16..24].copy_from_slice(&[0, 0, submode, 0, 0, 0, submode, 0]);
            24
        };
        sector[at..at + payload.len()].copy_from_slice(payload);
        sector
    }

    #[test]
    fn cd_tracks_convert_to_the_same_iso_and_unsupported_sectors_are_refused() {
        let temporary = tempfile::tempdir().unwrap();
        let plain = {
            let path = temporary.path().join("a.iso");
            iso(sample()).write_to(&path);
            std::fs::read(path).unwrap()
        };
        let convert = |name: &str, mode, bytes: &[u8]| {
            let track = temporary.path().join(format!("{name}.bin"));
            std::fs::write(&track, bytes).unwrap();
            let target = temporary.path().join(format!("{name}.iso"));
            cd_track_to_iso(&track, mode, &target, MAX_IMAGE_BYTES, &ok)
                .map(|_| std::fs::read(target).unwrap())
        };
        assert_eq!(
            convert("cooked", CdTrackMode::Mode1Cooked, &plain).unwrap(),
            plain
        );
        for (mode, number, name) in [
            (CdTrackMode::Mode1Raw, 1, "mode1"),
            (CdTrackMode::Mode2Form1Raw, 2, "mode2"),
        ] {
            let raw: Vec<u8> = plain
                .chunks(2048)
                .flat_map(|chunk| raw_sector(number, false, chunk))
                .collect();
            assert_eq!(convert(name, mode, &raw).unwrap(), plain, "{name}");
            // A form 2 sector, a wrong mode byte, a missing sync and a partial sector.
            let mut form2 = raw.clone();
            form2[2352..2352 * 2].copy_from_slice(&raw_sector(number, true, b""));
            let mut wrong_mode = raw.clone();
            wrong_mode[15] = 3;
            let mut no_sync = raw.clone();
            no_sync[0] = 1;
            for (case, bytes) in [
                ("form2", form2),
                ("mode", wrong_mode),
                ("sync", no_sync),
                ("partial", raw[..raw.len() - 1].to_vec()),
                ("empty", Vec::new()),
            ] {
                let expect_error = !(mode == CdTrackMode::Mode1Raw && case == "form2");
                assert_eq!(
                    convert(&format!("{name}-{case}"), mode, &bytes).is_err(),
                    expect_error,
                    "{name} {case}"
                );
            }
        }
        // The size bound is enforced before anything is written.
        let track = temporary.path().join("big.bin");
        std::fs::write(&track, &plain).unwrap();
        let target = temporary.path().join("big.iso");
        let error =
            cd_track_to_iso(&track, CdTrackMode::Mode1Cooked, &target, 2048, &ok).unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceInvalid);
        assert!(!target.exists());
        let error = cd_track_to_iso(
            &track,
            CdTrackMode::Mode1Cooked,
            &target,
            MAX_IMAGE_BYTES,
            &|| Err(cancelled()),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
    }
}
