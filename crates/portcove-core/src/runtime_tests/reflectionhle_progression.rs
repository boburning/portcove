//! Inert package fixtures through Core; no upstream game or original is executed.
use super::*;

async fn progression(id: &str) {
    let started = std::time::Instant::now();
    let phase = |name: &str| eprintln!("ReflectionHLE {id} {name}: {:?}", started.elapsed());
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let catalog = Catalog::embedded().unwrap();
    let port = catalog.port(id).unwrap();
    let unchanged = serde_json::to_value(port).unwrap();
    let payloads = [
        archive(&[
            ("old-wrapper/reflectionhle.exe", b"inert N code"),
            ("old-wrapper/SDL3.dll", b"inert N library"),
            ("old-wrapper/libspeexdsp-1.dll", b"inert audio library"),
            ("old-wrapper/gpl-2.0.txt", b"inert license fixture"),
        ]),
        archive(&[
            ("new-wrapper/reflectionhle.exe", b"inert N+1 code"),
            ("new-wrapper/SDL3.dll", b"inert N+1 library"),
            ("new-wrapper/libspeexdsp-1.dll", b"inert audio library"),
            ("new-wrapper/gpl-2.0.txt", b"inert license fixture"),
        ]),
    ];
    let names = [
        "reflectionhle-win64-synthetic-n.zip",
        "reflectionhle-win64-synthetic-next.zip",
    ];
    let server = Archives::new(
        names
            .iter()
            .zip(payloads.iter())
            .map(|(name, bytes)| (name.to_string(), bytes.clone()))
            .collect(),
    );
    let releases = [0, 1].map(|i| {
        let mut archive = asset(names[i], &payloads[i]);
        archive.url = format!("{}/{}", server.url, names[i]);
        ResolvedRelease {
            version: format!("synthetic-{}", i + 1),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: archive,
        }
    });
    let first = PortcoveService::with_provider(
        library.clone(),
        Arc::new(FixedRelease(releases[0].clone())),
    )
    .unwrap();
    phase("install N begin");
    let old = first
        .install(id, None, None, None, true, |_| {})
        .await
        .unwrap();
    let old_root = crate::runtime::working_root(port, &old);
    assert_eq!(old_root, old.path.join("old-wrapper"));
    fs::create_dir(old_root.join("wl6ap14")).unwrap();
    for (relative, bytes) in original_progress() {
        fs::write(old_root.join(relative), bytes).unwrap();
    }
    // Existing owned-fixture convention models completed player writes; these
    // bytes are not claimed as a playable save or authenticated original.
    fs::write(old.path.join(LAUNCH_MARKER), b"1").unwrap();
    assert!(first.verify(id).unwrap().valid);
    let backup = first.create_backup(id).unwrap();
    first
        .set_update_policy(id, crate::UpdatePolicy::Stage)
        .unwrap();
    drop(first);
    phase("N backup complete; reconcile N+1 begin");
    let next = PortcoveService::with_provider(
        library.clone(),
        Arc::new(FixedRelease(releases[1].clone())),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(next.catalog.port(id).unwrap()).unwrap(),
        unchanged
    );
    let result = next.reconcile(id, |_| {}).await.unwrap();
    assert_eq!(result.action, crate::ReconcileAction::Staged);
    assert_eq!(next.status(id).unwrap().active.unwrap().id, old.id);
    let updated = next.activate_staged(id).unwrap();
    let new_root = crate::runtime::working_root(port, &updated);
    assert_eq!(new_root, updated.path.join("new-wrapper"));
    assert!(next.verify(id).unwrap().valid);
    for root in [&old_root, &new_root] {
        assert_progress(root, original_progress());
        assert!(!root.parent().unwrap().join("reflectionhle.cfg").exists());
    }
    phase("N+1 activated; rollback begin");
    let current = [
        (
            "wl6ap14/SAVEGAM0.WL6",
            b"synthetic current progress".as_slice(),
        ),
        ("wl6ap14.txt", b"current external original-location witness"),
        ("reflectionhle.cfg", b"current private configuration"),
    ];
    for (relative, bytes) in current {
        fs::write(new_root.join(relative), bytes).unwrap();
    }
    fs::write(updated.path.join(LAUNCH_MARKER), b"1").unwrap();
    let rolled = next.rollback(id).unwrap();
    assert_eq!(rolled.id, old.id);
    assert_progress(&old_root, current);
    assert_eq!(
        fs::read(old_root.join("reflectionhle.exe")).unwrap(),
        b"inert N code"
    );
    assert_eq!(
        fs::read(new_root.join("reflectionhle.exe")).unwrap(),
        b"inert N+1 code"
    );
    let preview = next
        .preview_backup_action(id, &backup.id, BackupAction::Restore)
        .unwrap();
    let consent = next
        .authorize_backup_action(
            id,
            &backup.id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    next.restore_backup(id, &backup.id, &consent.token).unwrap();
    for root in [&old_root, &new_root] {
        assert_progress(root, original_progress());
    }
    assert!(next.verify(id).unwrap().valid);
    phase("reviewed restore complete; preserving removal begin");
    let preview = next.preview_removal(id).unwrap();
    let consent = next.authorize_removal(id, &preview.preview_sha256).unwrap();
    next.remove(id, &consent.token).unwrap();
    assert!(library.all_installs().unwrap().is_empty());
    assert_progress(&library.user_dir(id), original_progress());
    assert_eq!(
        serde_json::to_value(next.catalog.port(id).unwrap()).unwrap(),
        unchanged
    );
    phase("complete");
}

fn original_progress() -> [(&'static str, &'static [u8]); 3] {
    [
        ("wl6ap14/SAVEGAM0.WL6", b"synthetic progress N"),
        ("wl6ap14.txt", b"unowned original-location witness"),
        ("reflectionhle.cfg", b"private player configuration"),
    ]
}

fn assert_progress(root: &Path, expected: [(&str, &[u8]); 3]) {
    for (relative, bytes) in expected {
        assert_eq!(
            fs::read(root.join(relative)).unwrap(),
            bytes,
            "{}",
            root.join(relative).display()
        );
    }
}

macro_rules! case {
    ($name:ident, $id:literal) => {
        #[tokio::test]
        async fn $name() {
            progression($id).await;
        }
    };
}
case!(reflectionhle_progression_2683, "keen-dreams-reflectionhle");
case!(
    reflectionhle_progression_2684,
    "catacomb-3-d-the-descent-reflectionhle"
);
case!(
    reflectionhle_progression_2685,
    "the-catacomb-abyss-reflectionhle"
);
case!(
    reflectionhle_progression_2686,
    "the-catacomb-armageddon-reflectionhle"
);
case!(
    reflectionhle_progression_2687,
    "the-catacomb-apocalypse-reflectionhle"
);
case!(
    reflectionhle_progression_2688,
    "wolfenstein-3d-reflectionhle"
);
case!(
    reflectionhle_progression_2689,
    "spear-of-destiny-reflectionhle"
);
case!(
    reflectionhle_progression_2690,
    "super-3-d-noah-s-ark-dos-reflectionhle"
);
case!(reflectionhle_progression_2692, "bio-menace-reflectionhle");
