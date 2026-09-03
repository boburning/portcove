use super::*;
use sha2::{Digest, Sha256};
use std::io::Write;

fn catalog(bytes: &[u8]) -> Catalog {
    let mut document = Catalog::embedded().unwrap().document().clone();
    for id in ["star-fox-64", "ocarina-of-time"] {
        let profile = document
            .source_profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .unwrap();
        profile.accepted_extensions = vec!["z64".into()];
        profile.accepted_sha1.clear();
        profile.accepted_sha256 = vec![hex::encode(Sha256::digest(bytes))];
    }
    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

fn request(root: &Path) -> SourceDiscoveryRequest {
    SourceDiscoveryRequest {
        roots: vec![root.into()],
        profile_ids: vec!["star-fox-64".into(), "ocarina-of-time".into()],
        limits: SourceDiscoveryLimits::default(),
    }
}

#[test]
fn only_selected_roots_are_read_and_matching_profiles_share_one_hash_pass() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("renamed.z64"), payload).unwrap();
    fs::write(root.join("unrelated.txt"), payload).unwrap();
    fs::write(temporary.path().join("outside.z64"), payload).unwrap();
    let report = scan(&catalog(payload), &request(&root)).unwrap();
    assert_eq!(report.candidates.len(), 2);
    assert_eq!(report.files_hashed, 1);
    assert_eq!(report.hash_bytes, payload.len() as u64);
    assert_eq!(report.entries_examined, 2);
    assert!(report.limits_reached.is_empty());
    assert!(!root.join("portcove.sqlite3").exists());
    assert_eq!(fs::read(root.join("renamed.z64")).unwrap(), payload);
}

#[test]
fn directory_depth_entry_file_size_and_hash_budgets_bound_work() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let payload = b"synthetic supported source";
    fs::create_dir(root.join("child")).unwrap();
    fs::write(root.join("child/source.z64"), payload).unwrap();
    let mut selected = request(root);
    selected.limits.max_depth = 0;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert_eq!(limited.hash_bytes, 0);
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::Depth)
    );
    selected.limits.max_depth = 1;
    selected.limits.max_entries = 1;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert_eq!(limited.entries_examined, 1);
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::Entries)
    );
    selected.limits.max_entries = 10;
    selected.limits.max_file_bytes = 1;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::FileSize)
    );
    assert_eq!(limited.hash_bytes, 0);
    selected.limits.max_file_bytes = 100;
    selected.limits.max_hash_bytes = payload.len() as u64 - 1;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::HashBytes)
    );
    assert_eq!(limited.hash_bytes, 0);
    selected.limits.max_hash_bytes = payload.len() as u64;
    selected.limits.max_candidates = 1;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert_eq!(limited.candidates.len(), 1);
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::Candidates)
    );
}

#[test]
fn zip_payload_and_container_hashing_are_both_budgeted_before_expansion() {
    let temporary = tempfile::tempdir().unwrap();
    let payload = b"synthetic cartridge bytes";
    let path = temporary.path().join("source.zip");
    let mut archive = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    archive
        .start_file("game.z64", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(payload).unwrap();
    archive.finish().unwrap();
    let bytes = fs::metadata(&path).unwrap().len() + payload.len() as u64;
    let mut selected = request(temporary.path());
    selected.limits.max_hash_bytes = bytes - 1;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert_eq!(limited.hash_bytes, 0);
    selected.limits.max_hash_bytes = bytes;
    let found = scan(&catalog(payload), &selected).unwrap();
    assert_eq!(found.hash_bytes, bytes);
    assert_eq!(found.candidates.len(), 2);
    assert_ne!(
        found.candidates[0].sha256,
        found.candidates[0].storage_sha256
    );
}

#[test]
fn weak_profiles_are_reported_without_hashing_and_acceptance_revalidates_the_selected_digest() {
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("source.z64"), b"synthetic").unwrap();
    let mut selected = request(temporary.path());
    selected.profile_ids = vec!["star-fox-64".into()];
    let report = scan(&Catalog::embedded().unwrap(), &selected).unwrap();
    assert!(report.candidates.is_empty());
    assert_eq!(report.hash_bytes, 0);
    assert_eq!(report.issues[0].profile_id.as_deref(), Some("star-fox-64"));
    let service =
        PortcoveService::new(crate::Library::open(temporary.path().join("library")).unwrap())
            .unwrap();
    let path = temporary.path().join("source.z64");
    let expected = hex::encode(Sha256::digest(b"synthetic"));
    fs::write(&path, b"changed").unwrap();
    assert!(
        service
            .register_source_with_digest("star-fox-64", &path, &expected)
            .is_err()
    );
    assert!(service.library().sources().unwrap().is_empty());
    fs::write(&path, b"synthetic").unwrap();
    service
        .register_source_with_digest("star-fox-64", &path, &expected)
        .unwrap();
    assert_eq!(service.library().sources().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn traversal_never_follows_a_symlink_out_of_the_selected_root() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let outside = temporary.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("source.z64"), b"synthetic").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("shortcut")).unwrap();
    let report = scan(&catalog(b"synthetic"), &request(&root)).unwrap();
    assert_eq!(report.symlinks_skipped, 1);
    assert_eq!(report.hash_bytes, 0);
}
