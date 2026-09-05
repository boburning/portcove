use super::*;

#[test]
fn preference_restart_precedence_and_reset_never_mutate_libraries() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    let saved = temp.path().join("saved-library");
    let default = temp.path().join("default-library");
    let explicit = temp.path().join("invocation-library");
    for root in [&saved, &default, &explicit] {
        fs::create_dir(root).unwrap();
    }
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    assert_eq!(
        store.resolve(None, &default).unwrap().source,
        LibrarySelectionSource::PlatformDefault
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 3);
    store.set_library(&saved).unwrap();
    let restarted = HostPreferenceStore::new(path).unwrap();
    let saved_canonical = fs::canonicalize(&saved).unwrap();
    assert_eq!(
        restarted.resolve(None, &default).unwrap(),
        LibrarySelection {
            root: saved_canonical,
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
        assert!(root.is_dir());
    }
}

#[test]
fn damaged_or_future_preferences_are_visible_and_explicitly_recoverable() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    let selected = temp.path().join("library");
    fs::create_dir(&selected).unwrap();
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
    let chosen = temp.path().join("chosen");
    fs::create_dir(&chosen).unwrap();
    store.set_library(&chosen).unwrap();
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
    let selected = temp.path().join("selected");
    fs::create_dir(&selected).unwrap();
    assert!(store.set_library(&selected).is_err());
    assert_eq!(fs::read(target).unwrap(), b"preserve");
}

#[test]
fn concurrent_set_and_reset_publish_complete_documents() {
    let temp = tempfile::tempdir().unwrap();
    let store = HostPreferenceStore::new(temp.path().join("preferences.json")).unwrap();
    let selected = temp.path().join("selected");
    fs::create_dir(&selected).unwrap();
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
    assert!(
        result.library_root.is_none()
            || result.library_root == Some(fs::canonicalize(&selected).unwrap())
    );
    assert!(selected.is_dir());
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
    let selected = temp.path().join("a".repeat(200));
    fs::create_dir(&selected).unwrap();
    assert!(store.load().is_ok());
    assert!(store.set_library(&selected).is_err());
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn selected_library_must_be_existing_empty_or_recognizable_and_outside_preferences() {
    let temp = tempfile::tempdir().unwrap();
    let store = HostPreferenceStore::new(temp.path().join("config/preferences.json")).unwrap();
    assert!(store.set_library(&temp.path().join("missing")).is_err());
    let file = temp.path().join("file");
    fs::write(&file, b"not a directory").unwrap();
    assert!(store.set_library(&file).is_err());
    let unrelated = temp.path().join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    fs::write(unrelated.join("keep.txt"), b"preserve").unwrap();
    assert!(store.set_library(&unrelated).is_err());
    assert_eq!(fs::read(unrelated.join("keep.txt")).unwrap(), b"preserve");
    let incompatible = temp.path().join("incompatible");
    fs::create_dir(&incompatible).unwrap();
    fs::write(incompatible.join("portcove.sqlite3"), b"not sqlite").unwrap();
    assert!(store.set_library(&incompatible).is_err());
    assert_eq!(
        fs::read(incompatible.join("portcove.sqlite3")).unwrap(),
        b"not sqlite"
    );
    let config = temp.path().join("config");
    fs::create_dir(&config).unwrap();
    assert!(store.set_library(&config).is_err());
}

#[test]
fn platform_preference_path_is_absolute_and_outside_the_default_library() {
    let preferences = HostPreferenceStore::default_path().unwrap();
    let library = crate::Library::default_root().unwrap();
    assert!(preferences.is_absolute());
    assert_eq!(preferences.file_name().unwrap(), "preferences.json");
    assert!(!preferences.starts_with(library));
}
