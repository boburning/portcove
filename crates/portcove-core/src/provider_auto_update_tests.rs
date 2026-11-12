use super::*;
use crate::{retained_build::tests::fixture, test_http::serve_http_bytes};
use std::{
    fs,
    io::{Cursor, Write},
};

const PORT: &str = "starship";
const GAME: u64 = 777;
const PROJECT: u64 = 42;

fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// A provider wrapper holding `packages` (file name, asset path, asset bytes).
fn wrapper(packages: &[(&str, &str, &[u8])]) -> Vec<u8> {
    let inner = packages
        .iter()
        .map(|(name, asset, bytes)| (format!("mods/{name}"), zip_bytes(&[(asset, bytes)])))
        .collect::<Vec<_>>();
    zip_bytes(
        &inner
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
            .collect::<Vec<_>>(),
    )
}

fn json_response(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// Project JSON offering `files` as (file ID, download size).
fn project(version: &str, files: &[(u64, usize)]) -> Vec<u8> {
    json_response(
        &serde_json::json!({
            "_sName": "HD Link", "_sVersion": version, "_bIsObsolete": false,
            "_tsDateUpdated": 5, "_aGame": {"_idRow": GAME},
            "_aFiles": files.iter().map(|(id, size)| serde_json::json!({
                "_idRow": id, "_sFile": format!("pack-{id}.zip"), "_nFilesize": size,
                "_tsDateAdded": id, "_sMd5Checksum": "1c5133f5d7a8d9c72af51bab03452fbb",
                "_sAvResult": "clean", "_bIsArchived": false
            })).collect::<Vec<_>>(),
        })
        .to_string(),
    )
}

fn redirect() -> Vec<u8> {
    b"HTTP/1.1 302 Found\r\nLocation: /files/pack.zip\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
}

fn file(bytes: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    )
    .into_bytes();
    response.extend_from_slice(bytes);
    response
}

struct World {
    _temporary: tempfile::TempDir,
    service: PortcoveService,
    profile: String,
}

fn world() -> World {
    let (temporary, service, _first) = fixture();
    let profile = service.ensure_default_profile(PORT).unwrap().id;
    World {
        _temporary: temporary,
        service,
        profile,
    }
}

impl World {
    fn user(&self) -> std::path::PathBuf {
        self.service.library().user_dir(PORT)
    }

    /// Installs `payload` as file 10 of the project through a reviewed plan.
    async fn install_first(&self, payload: &[u8]) {
        let (root, _requests, server) = serve_http_bytes(vec![
            project("1.0", &[(10, payload.len())]),
            redirect(),
            file(payload),
        ]);
        let client = GameBananaClient::with_roots(&root, None).unwrap();
        let plan = self
            .service
            .plan_provider_install_with(&client, PORT, &self.profile, PROJECT, 10)
            .await
            .unwrap();
        server.join().unwrap();
        let authorization = self.service.authorize_provider_install(&plan).unwrap();
        self.service
            .apply_provider_install(&plan, &authorization.token)
            .unwrap();
    }

    fn allow_automatic(&self) {
        self.service
            .set_profile_update_policy(PORT, &self.profile, ProfileUpdatePolicy::AutomaticEligible)
            .unwrap();
    }

    /// One standing pass while the provider offers file 11 with `next`.
    async fn pass_with_update(&self, next: &[u8]) -> Vec<ProviderAutoUpdate> {
        let files = [(10, 1), (11, next.len())];
        let (root, _requests, server) = serve_http_bytes(vec![
            project("2.0", &files),
            project("2.0", &files),
            redirect(),
            file(next),
        ]);
        let client = GameBananaClient::with_roots(&root, None).unwrap();
        let updates = self
            .service
            .run_eligible_provider_updates_with(&client, PORT)
            .await
            .unwrap();
        server.join().unwrap();
        updates
    }

    fn revision(&self) -> crate::ProfileRevision {
        profile::current_revision(
            &self.service.library().connection().unwrap(),
            PORT,
            &self.profile,
        )
        .unwrap()
    }
}

#[tokio::test]
async fn an_unambiguous_update_installs_unattended_and_keeps_newer_progress() {
    let w = world();
    w.install_first(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v1")]))
        .await;
    w.allow_automatic();
    // Progress made after the first install must survive the update.
    fs::create_dir_all(w.user().join("Save")).unwrap();
    fs::write(w.user().join("Save/file1.sav"), b"newer progress").unwrap();
    let before = w.revision();

    let next = wrapper(&[("hd-link.o2r", "objects/link.bin", b"v2")]);
    let updates = w.pass_with_update(&next).await;
    assert_eq!(updates.len(), 1, "{updates:?}");
    assert_eq!(updates[0].native_ids, ["hd-link.o2r"]);
    let ProviderAutoUpdateOutcome::Applied { revision, file_id } = &updates[0].outcome else {
        panic!("{updates:?}");
    };
    assert_eq!(file_id, "11");
    assert_eq!(*revision, before.revision + 1);

    let after = w.revision();
    let package = &after.packages[0];
    assert_eq!(
        package.provider.as_ref().unwrap().file.as_deref(),
        Some("11")
    );
    assert_ne!(package.sha256, before.packages[0].sha256);
    let live = zip::ZipArchive::new(fs::File::open(w.user().join("mods/hd-link.o2r")).unwrap())
        .unwrap()
        .by_name("objects/link.bin")
        .map(|mut entry| {
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
            bytes
        })
        .unwrap();
    assert_eq!(live, b"v2");
    assert_eq!(
        fs::read(w.user().join("Save/file1.sav")).unwrap(),
        b"newer progress"
    );
    // The earlier setup stays recoverable: its revision still names file 10.
    let earlier = profile::revision_by_number(
        &w.service.library().connection().unwrap(),
        &w.profile,
        before.revision,
    )
    .unwrap();
    assert_eq!(
        earlier.packages[0]
            .provider
            .as_ref()
            .unwrap()
            .file
            .as_deref(),
        Some("10")
    );
}

#[tokio::test]
async fn updates_that_add_packages_or_need_a_choice_are_held_and_change_nothing() {
    let w = world();
    w.install_first(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v1")]))
        .await;
    w.allow_automatic();
    let before = w.revision();

    // The newer file brings a package this setup does not have.
    let next = wrapper(&[
        ("hd-link.o2r", "objects/link.bin", b"v2"),
        ("extra.o2r", "objects/extra.bin", b"new"),
    ]);
    let updates = w.pass_with_update(&next).await;
    let ProviderAutoUpdateOutcome::Held { reason } = &updates[0].outcome else {
        panic!("{updates:?}");
    };
    assert!(reason.contains("extra.o2r"), "{reason}");
    assert_eq!(w.revision(), before, "nothing changed");
    let layout = w.service.deploy_layout(PORT).unwrap();
    assert!(
        fs::read_dir(layout.store().join("staged"))
            .map(|entries| entries.count() == 0)
            .unwrap_or(true),
        "a held plan's staging is discarded"
    );

    // Two newer files are a choice for the player.
    let (root, _requests, server) =
        serve_http_bytes(vec![project("3.0", &[(10, 1), (11, 1), (12, 1)])]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let updates = w
        .service
        .run_eligible_provider_updates_with(&client, PORT)
        .await
        .unwrap();
    server.join().unwrap();
    let ProviderAutoUpdateOutcome::Held { reason } = &updates[0].outcome else {
        panic!("{updates:?}");
    };
    assert!(reason.contains("several newer files"));
    assert_eq!(w.revision(), before);
}

#[tokio::test]
async fn profiles_that_review_updates_are_not_contacted() {
    let w = world();
    w.install_first(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v1")]))
        .await;
    // The default policy reviews updates: no request is made at all.
    let client = GameBananaClient::with_roots("http://127.0.0.1:9", None).unwrap();
    let updates = w
        .service
        .run_eligible_provider_updates_with(&client, PORT)
        .await
        .unwrap();
    assert!(updates.is_empty());
}

impl World {
    fn install_local(&self, name: &str, entries: &[(&str, &[u8])]) {
        let scratch = self._temporary.path().join("scratch");
        fs::create_dir_all(&scratch).unwrap();
        let local = scratch.join(name);
        fs::write(&local, zip_bytes(entries)).unwrap();
        let current = self.revision().revision;
        self.service
            .install_mod_package(PORT, &self.profile, &local, current)
            .unwrap();
    }

    /// A pass that serves only the update check, so any download would fail.
    async fn pass_without_download(&self, files: &[(u64, usize)]) -> Vec<ProviderAutoUpdate> {
        let (root, requests, server) = serve_http_bytes(vec![project("2.0", files)]);
        let client = GameBananaClient::with_roots(&root, None).unwrap();
        let updates = self
            .service
            .run_eligible_provider_updates_with(&client, PORT)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(
            requests.try_iter().count(),
            1,
            "only the update check was made"
        );
        updates
    }
}

#[tokio::test]
async fn an_existing_overlap_with_an_unchanged_winner_does_not_hold_an_update() {
    let w = world();
    w.install_first(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v1")]))
        .await;
    // A local mod installed later already wins the same asset.
    w.install_local("recolor.o2r", &[("objects/link.bin", b"recolor")]);
    w.allow_automatic();
    let updates = w
        .pass_with_update(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v2")]))
        .await;
    assert!(
        matches!(
            updates[0].outcome,
            ProviderAutoUpdateOutcome::Applied { .. }
        ),
        "{updates:?}"
    );
}

#[tokio::test]
async fn an_update_that_changes_which_mod_wins_an_asset_waits_for_review() {
    let w = world();
    w.install_first(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v1")]))
        .await;
    w.install_local("sword.o2r", &[("objects/sword.bin", b"mine")]);
    w.allow_automatic();
    let before = w.revision();
    // The newer file also changes the sword the local mod changes.
    let next = zip_bytes(&[(
        "mods/hd-link.o2r",
        &zip_bytes(&[
            ("objects/link.bin", b"v2"),
            ("objects/sword.bin", b"theirs"),
        ]),
    )]);
    let updates = w.pass_with_update(&next).await;
    let ProviderAutoUpdateOutcome::Held { reason } = &updates[0].outcome else {
        panic!("{updates:?}");
    };
    assert!(reason.contains("which mod wins"), "{reason}");
    assert_eq!(w.revision(), before);
}

#[tokio::test]
async fn a_turned_off_mod_is_not_updated_or_downloaded() {
    let w = world();
    w.install_first(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v1")]))
        .await;
    let current = w.revision().revision;
    w.service
        .set_mod_package_enabled(PORT, &w.profile, "hd-link.o2r", false, current)
        .unwrap();
    w.allow_automatic();
    let before = w.revision();
    let updates = w.pass_without_download(&[(10, 1), (11, 1)]).await;
    let ProviderAutoUpdateOutcome::Held { reason } = &updates[0].outcome else {
        panic!("{updates:?}");
    };
    assert!(reason.contains("turned off"));
    assert_eq!(w.revision(), before, "the mod stays off");
}

#[tokio::test]
async fn a_file_with_several_mods_updates_once_and_a_dropped_mod_is_held_without_redownloading() {
    let w = world();
    w.install_first(&wrapper(&[
        ("a.o2r", "objects/a.bin", b"a1"),
        ("b.o2r", "objects/b.bin", b"b1"),
    ]))
    .await;
    w.allow_automatic();
    let before = w.revision();
    let updates = w
        .pass_with_update(&wrapper(&[
            ("a.o2r", "objects/a.bin", b"a2"),
            ("b.o2r", "objects/b.bin", b"b2"),
        ]))
        .await;
    assert_eq!(
        updates.len(),
        1,
        "one outcome per installed file: {updates:?}"
    );
    assert_eq!(updates[0].native_ids, ["a.o2r", "b.o2r"]);
    assert!(matches!(
        updates[0].outcome,
        ProviderAutoUpdateOutcome::Applied { .. }
    ));
    assert_eq!(
        w.revision().revision,
        before.revision + 1,
        "exactly one revision"
    );

    // File 12 drops b: held, and the next pass does not download it again.
    let dropped = wrapper(&[("a.o2r", "objects/a.bin", b"a3")]);
    let files = [(11, 1), (12, dropped.len())];
    let (root, _requests, server) = serve_http_bytes(vec![
        project("3.0", &files),
        project("3.0", &files),
        redirect(),
        file(&dropped),
    ]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let held = w
        .service
        .run_eligible_provider_updates_with(&client, PORT)
        .await
        .unwrap();
    server.join().unwrap();
    let ProviderAutoUpdateOutcome::Held { reason } = &held[0].outcome else {
        panic!("{held:?}");
    };
    assert!(reason.contains("drops: b.o2r"), "{reason}");
    let again = w.pass_without_download(&files).await;
    assert!(matches!(
        again[0].outcome,
        ProviderAutoUpdateOutcome::Held { .. }
    ));
    assert_eq!(w.revision().revision, before.revision + 1);
}

#[tokio::test]
async fn a_busy_setup_defers_the_update_without_remembering_a_hold() {
    let w = world();
    w.install_first(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v1")]))
        .await;
    w.allow_automatic();
    let before = w.revision();
    let guard = w
        .service
        .library()
        .try_lock_port(PORT, "another change")
        .unwrap();
    // Deferred before any download: only the update check is made.
    let updates = w.pass_without_download(&[(10, 1), (11, 1)]).await;
    drop(guard);
    assert!(
        matches!(
            updates[0].outcome,
            ProviderAutoUpdateOutcome::Deferred { .. }
        ),
        "{updates:?}"
    );
    assert_eq!(w.revision(), before);
    let layout = w.service.deploy_layout(PORT).unwrap();
    assert!(
        fs::read_dir(layout.store().join("staged"))
            .map(|entries| entries.count() == 0)
            .unwrap_or(true),
        "staging is discarded"
    );
    // Not remembered: the next pass downloads and applies it.
    let updates = w
        .pass_with_update(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v2")]))
        .await;
    assert!(
        matches!(
            updates[0].outcome,
            ProviderAutoUpdateOutcome::Applied { .. }
        ),
        "{updates:?}"
    );
}

#[tokio::test]
async fn unknown_files_in_the_live_mods_folder_defer_before_downloading() {
    let w = world();
    w.install_first(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v1")]))
        .await;
    w.allow_automatic();
    fs::write(w.user().join("mods/mine.o2r"), b"player's own").unwrap();
    let updates = w.pass_without_download(&[(10, 1), (11, 1)]).await;
    let ProviderAutoUpdateOutcome::Deferred { reason } = &updates[0].outcome else {
        panic!("{updates:?}");
    };
    assert!(reason.contains("did not add"), "{reason}");
}

#[tokio::test]
async fn a_held_update_is_shown_with_the_setup_until_the_setup_changes() {
    let w = world();
    w.install_first(&wrapper(&[("hd-link.o2r", "objects/link.bin", b"v1")]))
        .await;
    w.allow_automatic();
    let next = wrapper(&[
        ("hd-link.o2r", "objects/link.bin", b"v2"),
        ("extra.o2r", "objects/extra.bin", b"new"),
    ]);
    w.pass_with_update(&next).await;
    let view = w.service.mod_setups(PORT).unwrap();
    assert_eq!(view.held_updates.len(), 1, "{:?}", view.held_updates);
    let held = &view.held_updates[0];
    assert_eq!(held.profile_id, w.profile);
    assert_eq!(held.native_ids, ["hd-link.o2r"]);
    assert_eq!(held.candidate_file_id, "11");
    assert!(held.reason.contains("extra.o2r"));

    // A new revision of the setup means the held comparison no longer applies.
    let current = w.revision().revision;
    w.service
        .set_mod_package_enabled(PORT, &w.profile, "hd-link.o2r", false, current)
        .unwrap();
    assert!(w.service.mod_setups(PORT).unwrap().held_updates.is_empty());
}
