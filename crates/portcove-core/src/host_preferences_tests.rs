use super::*;

#[test]
fn preference_restart_precedence_and_reset_never_mutate_libraries() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    let saved = temp.path().join("saved-library");
    let default = temp.path().join("default-library");
    let explicit = temp.path().join("invocation-library");
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    assert_eq!(
        store.resolve(None, &default).unwrap().source,
        LibrarySelectionSource::PlatformDefault
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    store.set_library(&saved).unwrap();
    let restarted = HostPreferenceStore::new(path).unwrap();
    assert_eq!(
        restarted.resolve(None, &default).unwrap(),
        LibrarySelection {
            root: saved.clone(),
            source: LibrarySelectionSource::Saved
        }
    );
    assert_eq!(
        restarted.resolve(Some(&explicit), &default).unwrap().source,
        LibrarySelectionSource::Invocation
    );
    assert!(
        restarted
            .resolve(Some(Path::new("relative")), &default)
            .is_err()
    );
    restarted.reset().unwrap();
    assert_eq!(restarted.resolve(None, &default).unwrap().root, default);
    for root in [&saved, &default, &explicit] {
        assert!(!root.exists());
    }
}

#[test]
fn damaged_or_future_preferences_are_visible_and_explicitly_recoverable() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    let selected = temp.path().join("library");
    for bytes in [
        b"".as_slice(),
        b"{",
        br#"{"format_version":1,"library_root":"relative"}"#,
        br#"{"format_version":99,"library_root":null}"#,
    ] {
        fs::write(&path, bytes).unwrap();
        assert!(store.load().is_err());
        assert!(store.resolve(None, &selected).is_err());
        assert!(store.set_library(&selected).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(
            store.resolve(Some(&selected), &selected).unwrap().source,
            LibrarySelectionSource::Invocation
        );
        store.reset().unwrap();
        assert_eq!(store.load().unwrap(), HostPreferences::default());
    }
}

#[test]
fn compatible_extensions_survive_set_and_private_staging_is_ignored() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    fs::write(
        &path,
        br#"{"format_version":1,"library_root":null,"future_setting":{"enabled":true}}"#,
    )
    .unwrap();
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    // A process dying before publication leaves its sibling outside authority.
    fs::write(temp.path().join(".tmp-interrupted"), b"{").unwrap();
    store.set_library(&temp.path().join("chosen")).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(value["future_setting"]["enabled"], true);
    assert!(store.load().unwrap().library_root.is_some());
    store.clear_library().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(value["future_setting"]["enabled"], true);
    assert!(store.load().unwrap().library_root.is_none());
}

#[cfg(unix)]
#[test]
fn preference_and_lock_symlinks_do_not_redirect_writes() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    let target = temp.path().join("unrelated");
    fs::write(&target, b"preserve").unwrap();
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    symlink(&target, &path).unwrap();
    assert!(store.load().is_err());
    assert!(store.reset().is_err());
    fs::remove_file(&path).unwrap();
    symlink(&target, temp.path().join("preferences.json.lock")).unwrap();
    assert!(store.set_library(temp.path()).is_err());
    assert_eq!(fs::read(target).unwrap(), b"preserve");
}

#[test]
fn concurrent_set_and_reset_publish_complete_documents() {
    let temp = tempfile::tempdir().unwrap();
    let store = HostPreferenceStore::new(temp.path().join("preferences.json")).unwrap();
    let selected = temp.path().join("selected");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    std::thread::scope(|scope| {
        for worker in 0..8 {
            let barrier = barrier.clone();
            let store = &store;
            let selected = &selected;
            scope.spawn(move || {
                barrier.wait();
                for _ in 0..8 {
                    if worker % 2 == 0 {
                        store.set_library(selected).unwrap();
                    } else {
                        store.reset().unwrap();
                    }
                }
            });
        }
    });
    let result = store.load().unwrap();
    assert!(result.library_root.is_none() || result.library_root == Some(selected.clone()));
    assert!(!selected.exists());
}

#[test]
fn oversized_and_nonregular_documents_are_rejected_without_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    fs::write(&path, vec![b' '; MAX_BYTES as usize + 1]).unwrap();
    assert!(store.load().is_err());
    assert!(store.set_library(temp.path()).is_err());
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(store.load().is_err());
    assert!(store.reset().is_err());
    assert!(path.is_dir());
}

#[test]
fn failed_publication_preserves_the_previous_document() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    let bytes = serde_json::to_vec(&serde_json::json!({
        "format_version": 1, "library_root": null,
        "padding": "a".repeat(MAX_BYTES as usize - 100)
    }))
    .unwrap();
    assert!(bytes.len() < MAX_BYTES as usize);
    fs::write(&path, &bytes).unwrap();
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    assert!(store.load().is_ok());
    assert!(
        store
            .set_library(&temp.path().join("a".repeat(200)))
            .is_err()
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
}
