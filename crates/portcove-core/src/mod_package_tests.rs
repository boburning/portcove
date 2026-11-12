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

#[test]
fn wrapper_extraction_takes_only_package_members_flattened_and_ignores_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let wrapper = archive(
        dir.path(),
        "pack.zip",
        &[
            ("readme.txt", b"hello"),
            ("mods/hd-link.O2R", b"pkg-one"),
            ("extras/other.otr", b"pkg-two"),
            ("tool.exe", b"MZ"),
        ],
    );
    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();
    let extracted = extract_packages(&wrapper, &out, &["o2r", "otr"]).unwrap();
    assert_eq!(extracted.ignored, 2, "non-packages are left unread");
    let mut names = extracted
        .files
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, ["hd-link.O2R", "other.otr"]);
    assert_eq!(std::fs::read(out.join("hd-link.O2R")).unwrap(), b"pkg-one");
    assert!(!out.join("tool.exe").exists());
}

#[test]
fn wrapper_extraction_refuses_unsafe_duplicate_or_traversing_members() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();
    for (case, entries) in [
        ("traversal", vec![("../x.o2r", &b"x"[..])]),
        (
            "duplicate",
            vec![("a/x.o2r", &b"x"[..]), ("b/x.o2r", &b"y"[..])],
        ),
        (
            "case-duplicate",
            vec![("a/X.o2r", &b"x"[..]), ("b/x.O2R", &b"y"[..])],
        ),
        ("hidden", vec![(".hidden.o2r", &b"x"[..])]),
        ("empty", vec![("empty.o2r", &b""[..])]),
    ] {
        let wrapper = archive(dir.path(), &format!("{case}.zip"), &entries);
        assert!(
            extract_packages(&wrapper, &out, &["o2r"]).is_err(),
            "{case}"
        );
    }
    assert!(extract_packages(&dir.path().join("missing.zip"), &out, &["o2r"]).is_err());
}

#[test]
fn wrapper_extraction_bounds_the_aggregate_not_just_each_member() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();
    let wrapper = archive(
        dir.path(),
        "many.zip",
        &[("a.o2r", &[1u8; 600][..]), ("b.o2r", &[2u8; 600][..])],
    );
    // Each member fits under the cap; together they do not.
    assert!(extract_packages_capped(&wrapper, &out, &["o2r"], 1000).is_err());
    assert!(extract_packages_capped(&wrapper, &out, &["o2r"], 1200).is_ok());
}
