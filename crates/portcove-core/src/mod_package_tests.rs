use super::*;
use std::io::Write;

fn archive(directory: &Path, name: &str, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
    let path = directory.join(name);
    let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
    for (entry, bytes) in entries {
        writer
            .start_file(*entry, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
    path
}

#[test]
fn inspection_reports_exact_bytes_and_sorted_lowercase_assets_without_extracting() {
    let dir = tempfile::tempdir().unwrap();
    let path = archive(
        dir.path(),
        "hd-link.o2r",
        &[("objects/Link.bin", b"one"), ("textures/a.png", b"two")],
    );
    let inspection = inspect_asset_archive(&path).unwrap();
    assert_eq!(inspection.file_name, "hd-link.o2r");
    assert_eq!(
        inspection.sha256,
        hex::encode(Sha256::digest(std::fs::read(&path).unwrap()))
    );
    assert_eq!(
        inspection.asset_paths,
        ["objects/link.bin", "textures/a.png"]
    );
    assert_eq!(inspection.declared_uncompressed_bytes, 6);
    assert!(inspection.holds.is_empty());
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        1,
        "nothing extracted"
    );
}

#[test]
fn executable_content_and_empty_archives_are_held_not_deployed() {
    let dir = tempfile::tempdir().unwrap();
    let executable = archive(
        dir.path(),
        "native.o2r",
        &[("textures/a.png", b"x"), ("Hook.DLL", b"MZ")],
    );
    let inspection = inspect_asset_archive(&executable).unwrap();
    assert_eq!(
        inspection.holds,
        [ModPackageHold::ContainsExecutableContent]
    );
    assert_eq!(inspection.executable_entries, ["hook.dll"]);
    let empty = archive(dir.path(), "empty.o2r", &[]);
    assert_eq!(
        inspect_asset_archive(&empty).unwrap().holds,
        [ModPackageHold::Empty]
    );
}

#[test]
fn malicious_or_ambiguous_archives_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    for (case, entries) in [
        ("traversal", vec![("../escape.bin", &b"x"[..])]),
        ("absolute", vec![("/etc/passwd", &b"x"[..])]),
        ("backslash", vec![("a\\b.bin", &b"x"[..])]),
        ("alias", vec![("A.bin", &b"x"[..]), ("a.bin", &b"y"[..])]),
        ("device", vec![("con.txt", &b"x"[..])]),
    ] {
        let path = archive(dir.path(), &format!("{case}.o2r"), &entries);
        assert!(inspect_asset_archive(&path).is_err(), "{case}");
    }
    let not_zip = dir.path().join("plain.o2r");
    std::fs::write(&not_zip, b"not a zip").unwrap();
    assert!(inspect_asset_archive(&not_zip).is_err());
    assert!(
        inspect_asset_archive(dir.path()).is_err(),
        "directories are not packages"
    );
}

#[test]
fn conflicts_follow_the_supplied_precedence_and_ignore_unique_assets() {
    let a = vec!["objects/link.bin".to_string(), "only-a".to_string()];
    let b = vec!["objects/link.bin".to_string()];
    let c = vec!["objects/link.bin".to_string(), "only-c".to_string()];
    let conflicts = asset_conflicts(&[("a", &a), ("b", &b), ("c", &c)]);
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].providers, ["a", "b", "c"]);
    assert_eq!(conflicts[0].winner, "c");
    let reordered = asset_conflicts(&[("c", &c), ("b", &b), ("a", &a)]);
    assert_eq!(reordered[0].winner, "a");
    assert!(asset_conflicts(&[("a", &a)]).is_empty());
}
