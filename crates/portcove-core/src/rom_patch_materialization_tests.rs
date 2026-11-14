//! Behavior of the `rom-patch` materialization against real files.
use std::{collections::BTreeMap, io::Write, path::Path};

use sha2::{Digest, Sha256};

use super::*;
use crate::{
    ErrorCode, RomPatchFormat, RomPatchProfile,
    rom_patch::tests::{Action, bps, ips},
};

fn original() -> Vec<u8> {
    (0..8192_u32)
        .map(|value| (value * 11 % 253) as u8)
        .collect()
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

struct Case {
    profile: RomPatchProfile,
    output: Vec<u8>,
    hashes: BTreeMap<String, String>,
}

fn case(format: RomPatchFormat, patch: &[u8], output: Vec<u8>) -> Case {
    Case {
        profile: RomPatchProfile {
            format,
            original_filenames: vec!["original.sfc".into()],
            original_sha256: sha256(&original()),
            patch_filenames: vec!["translation.patch".into()],
            patch_sha256: sha256(patch),
        },
        hashes: BTreeMap::from([("game.sfc".to_owned(), sha256(&output))]),
        output,
    }
}

fn ips_case() -> (Vec<u8>, Case) {
    let patch = ips(&[(64, b"ENGLISH")], &[(512, 32, 0)], None);
    let mut output = original();
    output[64..71].copy_from_slice(b"ENGLISH");
    output[512..544].fill(0);
    let case = case(RomPatchFormat::Ips, &patch, output);
    (patch, case)
}

fn folder(root: &Path, patch: &[u8]) -> std::path::PathBuf {
    let source = root.join("player-files");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("original.sfc"), original()).unwrap();
    std::fs::write(source.join("translation.patch"), patch).unwrap();
    source
}

fn prepare(source: &Path, destination: &Path, case: &Case) -> Result<()> {
    prepare_rom_patch_source(source, destination, &case.profile, &case.hashes, &|| Ok(()))
}

fn staging_left(directory: &Path) -> Vec<String> {
    std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".portcove-rom-patch-") || name.contains(".tmp-"))
        .collect()
}

#[test]
fn a_folder_source_produces_the_exact_patched_file_and_keeps_the_inputs() {
    let directory = tempfile::tempdir().unwrap();
    let (patch, case) = ips_case();
    let source = folder(directory.path(), &patch);
    let before = std::fs::metadata(source.join("original.sfc"))
        .unwrap()
        .modified()
        .unwrap();
    let destination = directory.path().join("install/game.sfc");
    prepare(&source, &destination, &case).unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), case.output);
    assert_eq!(
        std::fs::read(source.join("original.sfc")).unwrap(),
        original()
    );
    assert_eq!(
        std::fs::read(source.join("translation.patch")).unwrap(),
        patch
    );
    assert_eq!(
        std::fs::metadata(source.join("original.sfc"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert!(runtime_source_marker_path(&destination).unwrap().is_file());
    assert!(staging_left(destination.parent().unwrap()).is_empty());
}

#[test]
fn a_zip_source_produces_the_exact_patched_file() {
    let directory = tempfile::tempdir().unwrap();
    let source = original();
    let mut target = source[..4096].to_vec();
    target.extend(b"translated text");
    target.extend(&source[5000..5100]);
    let patch = bps(
        &source,
        &target,
        b"",
        &[
            Action::SourceRead(4096),
            Action::TargetRead(b"translated text".to_vec()),
            Action::SourceCopy(5000, 100),
        ],
    );
    let case = case(RomPatchFormat::Bps, &patch, target);
    let archive = directory.path().join("player-files.zip");
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
    for (name, bytes) in [("original.sfc", &source), ("translation.patch", &patch)] {
        writer
            .start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
    let archive_bytes = std::fs::read(&archive).unwrap();
    let destination = directory.path().join("install/game.sfc");
    prepare(&archive, &destination, &case).unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), case.output);
    assert_eq!(std::fs::read(&archive).unwrap(), archive_bytes);
}

#[test]
fn wrong_inputs_or_output_leave_the_previous_file_in_place() {
    let directory = tempfile::tempdir().unwrap();
    let (patch, good) = ips_case();
    let source = folder(directory.path(), &patch);
    let destination = directory.path().join("install/game.sfc");
    std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
    std::fs::write(&destination, b"previous").unwrap();

    let mut wrong_original = ips_case().1;
    wrong_original.profile.original_sha256 = "0".repeat(64);
    let mut wrong_patch = ips_case().1;
    wrong_patch.profile.patch_sha256 = "0".repeat(64);
    let mut wrong_output = ips_case().1;
    wrong_output.hashes = BTreeMap::from([("game.sfc".to_owned(), "0".repeat(64))]);
    let mut wrong_format = ips_case().1;
    wrong_format.profile.format = RomPatchFormat::Bps;
    for (label, case, code) in [
        ("original", &wrong_original, ErrorCode::SourceInvalid),
        ("patch", &wrong_patch, ErrorCode::SourceInvalid),
        ("output", &wrong_output, ErrorCode::Verification),
        ("format", &wrong_format, ErrorCode::SourceInvalid),
    ] {
        let error = prepare(&source, &destination, case).unwrap_err();
        assert_eq!(error.code, code, "{label}: {error:?}");
        assert_eq!(std::fs::read(&destination).unwrap(), b"previous", "{label}");
        assert!(!runtime_source_marker_path(&destination).unwrap().exists());
        assert!(
            staging_left(destination.parent().unwrap()).is_empty(),
            "{label}"
        );
    }
    prepare(&source, &destination, &good).unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), good.output);
}

#[test]
fn a_member_that_changed_since_registration_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let (patch, case) = ips_case();
    let source = folder(directory.path(), &patch);
    let mut changed = original();
    changed[0] ^= 1;
    std::fs::write(source.join("original.sfc"), changed).unwrap();
    let destination = directory.path().join("install/game.sfc");
    let error = prepare(&source, &destination, &case).unwrap_err();
    assert_eq!(error.code, ErrorCode::SourceInvalid);
    assert!(!destination.exists());
}

#[test]
fn an_unchanged_result_is_reused_and_a_changed_one_is_regenerated() {
    let directory = tempfile::tempdir().unwrap();
    let (patch, case) = ips_case();
    let source = folder(directory.path(), &patch);
    let destination = directory.path().join("install/game.sfc");
    prepare(&source, &destination, &case).unwrap();
    let marker = runtime_source_marker_path(&destination).unwrap();
    let marker_bytes = std::fs::read(&marker).unwrap();
    let first = std::fs::metadata(&destination).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    prepare(&source, &destination, &case).unwrap();
    assert_eq!(
        std::fs::metadata(&destination).unwrap().modified().unwrap(),
        first,
        "an unchanged result is not rewritten"
    );
    assert_eq!(std::fs::read(&marker).unwrap(), marker_bytes);

    std::fs::write(&destination, b"edited by hand").unwrap();
    prepare(&source, &destination, &case).unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), case.output);
}

#[test]
fn a_catalog_declared_patch_is_admitted_and_applied_end_to_end() {
    let directory = tempfile::tempdir().unwrap();
    let source = original();
    let mut target = b"header".to_vec();
    target.extend(&source[..6000]);
    let patch = bps(
        &source,
        &target,
        b"",
        &[
            Action::TargetRead(b"header".to_vec()),
            Action::SourceCopy(0, 6000),
        ],
    );
    let catalog = crate::Catalog::from_document(crate::catalog::rom_patch_fixture_document(
        &sha256(&source),
        &sha256(&patch),
        &sha256(&target),
    ))
    .unwrap();
    let port = catalog
        .port(crate::catalog::ROM_PATCH_FIXTURE_PORT)
        .unwrap();
    let profile = catalog
        .source_profile(port.source_profile.as_deref().unwrap())
        .unwrap();
    let folder = directory.path().join("player-files");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("original.sfc"), &source).unwrap();
    std::fs::write(folder.join("translation.bps"), &patch).unwrap();
    let record = StandardAdapter(crate::AdapterKind::StagedSourcePortable)
        .validate_source(profile, &folder)
        .unwrap();
    let destination = directory.path().join("install/game.sfc");
    prepare_rom_patch_source(
        &record.path,
        &destination,
        port.runtime_rom_patch.as_ref().unwrap(),
        &port.runtime_source_hashes,
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), target);

    // Admission refuses a patch other than the reviewed one.
    std::fs::write(folder.join("translation.bps"), b"not the reviewed patch").unwrap();
    let error = StandardAdapter(crate::AdapterKind::StagedSourcePortable)
        .validate_source(profile, &folder)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::SourceInvalid);
}

#[test]
fn the_generic_materialization_path_refuses_rom_patch_without_its_declaration() {
    let directory = tempfile::tempdir().unwrap();
    let (patch, _) = ips_case();
    let source = folder(directory.path(), &patch);
    let error = prepare_runtime_source(
        &source.join("original.sfc"),
        &directory.path().join("game.sfc"),
        RuntimeSourceMaterialization::RomPatch,
        &BTreeMap::new(),
        &|| Ok(()),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Usage);
}
