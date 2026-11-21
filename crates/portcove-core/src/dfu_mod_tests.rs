use super::*;

const LINUX: &[u8] = include_bytes!("fixtures/dfu-mods/pointycursor-linux.dfmod");
const WINDOWS: &[u8] = include_bytes!("fixtures/dfu-mods/pointycursor-windows.dfmod");
const CODE: &[u8] = include_bytes!("fixtures/dfu-mods/easynpcbehavior-linux.dfmod");
const NATIVE_NAME: &str = "wandererhud - pointycursor.dfmod";
const GUID: &str = "4c44a472-a28f-48a7-ac8a-2ba3318dbf5f";

fn inspect(bytes: &[u8], name: &str, platform: Platform) -> Result<DfuModInspection> {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(name);
    std::fs::write(&file, bytes).unwrap();
    inspect_data_only(&file, platform)
}

#[test]
fn publisher_texture_bundles_bind_platform_and_native_identity() {
    for (bytes, platform, digest) in [
        (
            LINUX,
            Platform::LinuxX86_64,
            "f6f35897159bcc124ed8501d0aef0d87b3269d258abce28420f924610e1a639b",
        ),
        (
            WINDOWS,
            Platform::WindowsX86_64,
            "48b89f2092725205a43b8dfe1c8714384ce9385929feac43c49f17409574c7de",
        ),
    ] {
        let result = inspect(bytes, NATIVE_NAME, platform).unwrap();
        assert_eq!(result.guid, GUID);
        assert_eq!(result.title, "WandererHud - PointyCursor");
        assert_eq!(result.optional_dependencies, ["wandererhud"]);
        assert_eq!(result.package.file_name, NATIVE_NAME);
        assert_eq!(result.package.asset_paths, ["cursor.png"]);
        assert_eq!(result.package.entry_count, 1);
        assert_eq!(result.package.size, bytes.len() as u64);
        assert_eq!(result.package.sha256, digest);
    }
    assert!(inspect(LINUX, NATIVE_NAME, Platform::WindowsX86_64).is_err());
    assert!(inspect(WINDOWS, NATIVE_NAME, Platform::LinuxX86_64).is_err());
    assert!(inspect(LINUX, "different.dfmod", Platform::LinuxX86_64).is_err());
    assert!(
        inspect(
            LINUX,
            "Wandererhud - pointycursor.dfmod",
            Platform::LinuxX86_64
        )
        .is_err()
    );
}

#[test]
fn refuses_non_reconstructible_native_filenames_before_opening() {
    let dir = tempfile::tempdir().unwrap();
    for file_name in [".dfmod", "mod.dfmod.extra.dfmod", "mod.DFMOD"] {
        let error = inspect_data_only(&dir.path().join(file_name), Platform::LinuxX86_64)
            .err()
            .unwrap();
        assert!(
            error
                .message
                .contains("original .dfmod file with one extension"),
            "{}",
            error.message
        );
    }
}

#[cfg(unix)]
#[test]
fn refuses_links_in_the_package_or_its_parents() {
    use std::{fs, os::unix::fs::symlink};

    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    fs::create_dir(&source).unwrap();
    let bundle = source.join(NATIVE_NAME);
    fs::write(&bundle, LINUX).unwrap();
    assert!(inspect_data_only(&bundle, Platform::LinuxX86_64).is_ok());

    let leaf_alias = dir.path().join(NATIVE_NAME);
    symlink(&bundle, &leaf_alias).unwrap();
    assert!(inspect_data_only(&leaf_alias, Platform::LinuxX86_64).is_err());
    let parent_alias = dir.path().join("redirected");
    symlink(source, &parent_alias).unwrap();
    assert!(inspect_data_only(&parent_alias.join(NATIVE_NAME), Platform::LinuxX86_64).is_err());

    fs::remove_file(&leaf_alias).unwrap();
    fs::hard_link(&bundle, &leaf_alias).unwrap();
    assert!(inspect_data_only(&leaf_alias, Platform::LinuxX86_64).is_err());
}

#[test]
fn refuses_the_published_code_bearing_bundle() {
    let error = inspect(CODE, "easynpcbehavior.dfmod", Platform::LinuxX86_64)
        .err()
        .unwrap();
    assert!(
        error.message.contains("code or another unsupported object"),
        "{}",
        error.message
    );
}

#[test]
fn follows_manifest_identity_and_rejects_invalid_identity_or_required_dependency() {
    let data = read_bundle(LINUX).unwrap();
    // Test the reviewed serialized layout independently of its compression.
    let replace = |needle: &str, destination: &str| {
        assert_eq!(needle.len(), destination.len());
        let mut updated = data.clone();
        let offset = data
            .windows(needle.len())
            .position(|part| part == needle.as_bytes())
            .unwrap();
        updated[offset..offset + needle.len()].copy_from_slice(destination.as_bytes());
        updated
    };
    let changed = replace(GUID, "638610a7-57be-45b9-b92a-412915e5afc3");
    let result = inspect(&store_bundle(&changed), NATIVE_NAME, Platform::LinuxX86_64).unwrap();
    assert_eq!(result.guid, "638610a7-57be-45b9-b92a-412915e5afc3");

    let invalid_guid = replace(GUID, "00000000-0000-0000-0000-000000000000");
    assert!(
        inspect(
            &store_bundle(&invalid_guid),
            NATIVE_NAME,
            Platform::LinuxX86_64
        )
        .is_err()
    );
    let required = replace("\"IsOptional\": true,", "\"IsOptional\":false,");
    assert!(inspect(&store_bundle(&required), NATIVE_NAME, Platform::LinuxX86_64).is_err());

    let mixed_case = replace("\"wandererhud\"", "\"WandererHud\"");
    let result = inspect(
        &store_bundle(&mixed_case),
        NATIVE_NAME,
        Platform::LinuxX86_64,
    )
    .unwrap();
    assert_eq!(result.optional_dependencies, ["WandererHud"]);
}

fn store_bundle(data: &[u8]) -> Vec<u8> {
    let mut header = b"UnityFS\0\0\0\0\x075.x.x\02019.4.40f1\0".to_vec();
    let mut metadata = vec![0; 16];
    metadata.extend(1u32.to_be_bytes());
    metadata.extend((data.len() as u32).to_be_bytes());
    metadata.extend((data.len() as u32).to_be_bytes());
    metadata.extend(0u16.to_be_bytes());
    metadata.extend(1u32.to_be_bytes());
    metadata.extend(0u64.to_be_bytes());
    metadata.extend((data.len() as u64).to_be_bytes());
    metadata.extend(4u32.to_be_bytes());
    metadata.extend(b"CAB-0123456789abcdef0123456789abcdef\0");
    let data_start = (header.len() + 20).next_multiple_of(16);
    header.extend(((data_start + data.len() + metadata.len()) as u64).to_be_bytes());
    header.extend((metadata.len() as u32).to_be_bytes());
    header.extend((metadata.len() as u32).to_be_bytes());
    header.extend(0x40u32.to_be_bytes());
    header.resize(data_start, 0);
    header.extend(metadata);
    header.extend(data);
    header
}

#[test]
fn refuses_raw_decompression_overflow_or_invalid_match_before_copying() {
    assert!(decompress(&[0x5d, 0xff, 0xff, 0xff, 0xff], 64, 1).is_err());
    assert!(decompress(&[0xf0, 255, 255, 1], 64, 3).is_err());
    assert!(decompress(&[0x10, b'a', 0, 0], 64, 3).is_err());
    assert!(read_bundle(&LINUX[..LINUX.len() - 1]).is_err());
}

#[test]
fn enforces_raw_lz4_final_sequence_conditions() {
    assert_eq!(lz4_block(b"\x31abc", 3).unwrap(), b"abc");
    assert_eq!(
        lz4_block(b"\x13a\x01\x00\x50bcdef", 13).unwrap(),
        b"aaaaaaaabcdef"
    );
    assert!(lz4_block(b"\x18a\x01\x00", 13).is_err());
    assert!(lz4_block(b"\x14a\x01\x00\x40bcde", 13).is_err());
    assert!(lz4_block(b"\x10a\x01\x00\x50bcdef", 10).is_err());
}

#[test]
fn refuses_unknown_type_unindexed_bytes_and_streamed_textures() {
    let original = read_bundle(LINUX).unwrap();
    let mut wrong_kind = original.clone();
    let type_table = 20 + UNITY_VERSION.len() + 1 + 4 + 1 + 4;
    wrong_kind[type_table..type_table + 4].copy_from_slice(&114u32.to_le_bytes());
    let result = read_objects(&wrong_kind, Platform::LinuxX86_64)
        .err()
        .unwrap();
    assert!(result.message.contains("unreviewed Unity object type"));

    let mut extra = original.clone();
    extra.push(1);
    let size = extra.len() as u32;
    extra[4..8].copy_from_slice(&size.to_be_bytes());
    let result = read_objects(&extra, Platform::LinuxX86_64).err().unwrap();
    assert!(
        result
            .message
            .contains("unindexed trailing Unity asset data")
    );

    let objects = read_objects(&original, Platform::LinuxX86_64).unwrap();
    let texture = objects
        .values()
        .find(|object| object.kind == ObjectKind::Texture)
        .unwrap();
    let mut streamed = texture.bytes.to_vec();
    *streamed.last_mut().unwrap() = 1;
    assert!(
        review_texture(
            &Object {
                kind: ObjectKind::Texture,
                bytes: &streamed
            },
            "cursor.png"
        )
        .is_err()
    );
}
