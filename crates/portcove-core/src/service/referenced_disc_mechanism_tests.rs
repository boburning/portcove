//! Referenced-disc mechanism evidence (#8555).
//!
//! A synthetic port declares `adapter: referenced-disc`; nothing in production
//! names it. Every case drives the real service entry points (provider
//! resolution, download, install, update, rollback, launch preparation and
//! removal) against a local GitHub-shaped origin serving inert packages. The
//! invariant the mechanism promises: the player's original disc is referenced
//! in place and is never modified, moved, copied into the library or deleted.
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use serde_json::{Value, json};

use super::*;
use crate::ErrorCode;
use crate::mechanism_fixtures::{
    self as fixture, DISC_PORT, DISC_PROFILE, DISC_REPOSITORY, ReleaseServer, ServedPackage,
};
use crate::operation::{LifecycleFaultInjector, LifecycleFaultPoint};

struct FailOnce {
    point: LifecycleFaultPoint,
    fired: AtomicBool,
}

impl LifecycleFaultInjector for FailOnce {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == self.point && !self.fired.swap(true, Ordering::SeqCst) {
            return Err(PortcoveError::state(format!(
                "injected mechanism fault at {point:?}"
            )));
        }
        Ok(())
    }
}

fn host() -> Platform {
    Platform::current().unwrap()
}

fn package(tag: &str) -> ServedPackage {
    ServedPackage {
        tag: tag.into(),
        asset: fixture::disc_asset_name(host()),
        bytes: fixture::disc_package(tag, host()),
        corrupt: false,
    }
}

fn service_for(
    library: &Library,
    server: &ReleaseServer,
    document: &Value,
    faults: Option<LifecycleFaultPoint>,
) -> PortcoveService {
    let mut service = match faults {
        Some(point) => PortcoveService::with_provider_and_faults(
            library.clone(),
            server.provider(),
            Arc::new(FailOnce {
                point,
                fired: AtomicBool::new(false),
            }),
        ),
        None => PortcoveService::with_provider(library.clone(), server.provider()),
    }
    .unwrap();
    service.replace_catalog_for_test(fixture::catalog_from(document));
    service
}

struct Original {
    path: PathBuf,
    directory: PathBuf,
    identity: (Vec<u8>, u64, std::time::SystemTime),
    neighbours: std::collections::BTreeMap<PathBuf, Vec<u8>>,
}

impl Original {
    fn create(root: &Path) -> Self {
        let directory = root.join("player-originals");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("owned-disc.iso");
        fs::write(&path, b"owned referenced disc bytes").unwrap();
        fs::write(directory.join("notes.txt"), b"player notes").unwrap();
        Self {
            identity: fixture::file_identity(&path),
            neighbours: fixture::tree(&directory),
            path,
            directory,
        }
    }

    /// Never modified, moved or deleted; nothing written next to it.
    fn assert_untouched(&self) {
        assert!(self.path.is_file(), "the referenced original disappeared");
        assert_eq!(fixture::file_identity(&self.path), self.identity);
        assert_eq!(fixture::tree(&self.directory), self.neighbours);
    }
}

fn no_library_copy(library: &Library, original: &Original) {
    let bytes = &original.identity.0;
    let copies = fixture::tree(library.root())
        .into_iter()
        .filter(|(_, contents)| contents == bytes)
        .map(|(path, _)| path)
        .collect::<Vec<_>>();
    assert!(
        copies.is_empty(),
        "the library holds a copy of the original: {copies:?}"
    );
}

/// A launch argument names `expected`, compared by canonical components so
/// Windows verbatim prefixes and short names do not decide the result.
fn same_path(argument: &str, expected: &Path) {
    assert_eq!(
        fixture::canonical(Path::new(argument))
            .components()
            .collect::<Vec<_>>(),
        fixture::canonical(expected)
            .components()
            .collect::<Vec<_>>(),
        "{argument} does not name {expected:?}"
    );
}

/// Install through the real provider, register the original through the
/// service and return the launch it prepares.
async fn installed(
    library: &Library,
    server: &ReleaseServer,
    document: &Value,
    original: &Original,
) -> (PortcoveService, InstallRecord, SourceRecord) {
    let service = service_for(library, server, document, None);
    let source = service
        .register_source(DISC_PROFILE, &original.path)
        .unwrap();
    let install = service
        .install(DISC_PORT, None, None, None, true, |_| {})
        .await
        .unwrap();
    (service, install, source)
}

fn assert_launch_references(
    service: &PortcoveService,
    library: &Library,
    install: &InstallRecord,
    source: &SourceRecord,
) {
    let spec = service.prepare_launch(DISC_PORT, None).unwrap();
    assert_eq!(
        spec.executable.file_name().unwrap().to_string_lossy(),
        fixture::disc_player_program(host())
    );
    assert!(fixture::within(&spec.executable, &install.path));
    assert_eq!(spec.arguments.len(), 4, "{:?}", spec.arguments);
    assert_eq!(spec.arguments[0], "--user-dir");
    same_path(&spec.arguments[1], &library.user_dir(DISC_PORT));
    assert_eq!(spec.arguments[2], "--dvd");
    same_path(&spec.arguments[3], &source.path);
    let descriptor: Value = serde_json::from_slice(
        &fs::read(spec.working_directory.join("data_location.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(descriptor["mode"], "custom");
    same_path(
        descriptor["customPath"].as_str().unwrap(),
        &library.user_dir(DISC_PORT),
    );
}

#[tokio::test]
async fn success_installs_the_host_player_and_launches_against_the_original_in_place() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let original = Original::create(temporary.path());
    let server = ReleaseServer::start(
        DISC_REPOSITORY,
        "referenced_disc",
        vec![package("v1.0.0"), package("v2.0.0")],
    );
    let document = fixture::document();
    let (service, install, source) = installed(&library, &server, &document, &original).await;

    // v3.0.0 ships only a mobile package: the newest desktop release is used,
    // and only this host's player package is downloaded.
    assert_eq!(install.version, "v2.0.0");
    assert_eq!(
        install.artifact.asset_name,
        fixture::disc_asset_name(host())
    );
    assert_eq!(
        server.downloads(),
        [format!(
            "{DISC_REPOSITORY}/releases/download/v2.0.0/{}",
            fixture::disc_asset_name(host())
        )]
    );
    assert!(service.verify(DISC_PORT).unwrap().valid);
    // The registration names the player's file where it is.
    assert_eq!(fs::read(&source.path).unwrap(), original.identity.0);
    assert_eq!(source.path.file_name(), original.path.file_name());
    assert_launch_references(&service, &library, &install, &source);
    // Repeated preparation is stable and still references the same original.
    assert_launch_references(&service, &library, &install, &source);
    original.assert_untouched();
    no_library_copy(&library, &original);
}

#[tokio::test]
async fn refusal_held_acquisition_downloads_nothing() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let original = Original::create(temporary.path());
    let server = ReleaseServer::start(DISC_REPOSITORY, "referenced_disc", vec![package("v2.0.0")]);
    let mut document = fixture::document();
    fixture::port_mut(&mut document, DISC_PORT)["managed_acquisition_hold"] = json!({
        "reason": "Managed acquisition is held for this fixture.",
        "activation_reason": "Activation is held for this fixture.",
        "reviewed_artifacts": []
    });
    let service = service_for(&library, &server, &document, None);
    service
        .register_source(DISC_PROFILE, &original.path)
        .unwrap();
    let error = service
        .install(DISC_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported, "{error:?}");
    assert!(server.downloads().is_empty());
    assert!(service.status(DISC_PORT).unwrap().active.is_none());
    original.assert_untouched();
}

#[tokio::test]
async fn refusal_checksum_mismatch_publishes_nothing() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let original = Original::create(temporary.path());
    let mut corrupt = package("v2.0.0");
    corrupt.corrupt = true;
    let server = ReleaseServer::start(DISC_REPOSITORY, "referenced_disc", vec![corrupt]);
    let document = fixture::document();
    let service = service_for(&library, &server, &document, None);
    service
        .register_source(DISC_PROFILE, &original.path)
        .unwrap();
    let error = service
        .install(DISC_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification, "{error:?}");
    assert!(service.status(DISC_PORT).unwrap().active.is_none());
    assert!(fixture::tree(&library.versions_dir()).is_empty());
    original.assert_untouched();
}

#[tokio::test]
async fn refusal_unsupported_platform_downloads_nothing() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let server = ReleaseServer::start(DISC_REPOSITORY, "referenced_disc", vec![package("v2.0.0")]);
    let mut document = fixture::document();
    let other = fixture::platforms()
        .into_iter()
        .find(|platform| *platform != host())
        .unwrap();
    let port = fixture::port_mut(&mut document, DISC_PORT);
    port["platforms"] = json!([other]);
    port["executable_hints"] =
        json!({ fixture::platform_key(other): [fixture::disc_player_program(other)] });
    let service = service_for(&library, &server, &document, None);
    let error = service
        .install(DISC_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported, "{error:?}");
    assert!(server.downloads().is_empty());
}

/// Typed route facts: a mobile package and another host's player are never
/// offered as this host's game. Tool and debug decoys are excluded from the
/// served list (see `mechanism_fixtures::tool_or_debug_decoy`); each recorded
/// decoy is then offered alone under this host's name, and the builder and
/// debug cases record an observed, tracked defect.
#[tokio::test]
async fn refusal_wrong_role_or_host_is_never_selected() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let mut releases = fixture::served_releases("referenced_disc");
    let host_asset = fixture::disc_asset_name(host());
    for release in releases.as_array_mut().unwrap() {
        release["assets"]
            .as_array_mut()
            .unwrap()
            .retain(|asset| asset["name"] != host_asset.as_str());
    }
    let server = ReleaseServer::start_with_releases(DISC_REPOSITORY, releases, Vec::new());
    let document = fixture::document();
    let service = service_for(&library, &server, &document, None);
    let original = Original::create(temporary.path());
    service
        .register_source(DISC_PROFILE, &original.path)
        .unwrap();
    let error = service
        .install(DISC_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound, "{error:?}");
    assert!(server.downloads().is_empty());
    assert!(service.status(DISC_PORT).unwrap().active.is_none());

    // Each decoy alone, named for this host and serving a real player
    // package, so the outcome depends on its role and not on host filtering.
    original.assert_untouched();
    let decoys = fixture::same_host_decoys("referenced_disc");
    let names = decoys
        .iter()
        .map(|(_, decoy)| decoy["name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 3, "{names:?}");
    for (tag, decoy) in decoys {
        let name = decoy["name"].as_str().unwrap().to_owned();
        let server = ReleaseServer::start_with_releases(
            DISC_REPOSITORY,
            decoy_only_release("referenced_disc", &tag, &decoy),
            vec![ServedPackage {
                asset: name.clone(),
                ..package(&tag)
            }],
        );
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_for(&library, &server, &document, None);
        service
            .register_source(DISC_PROFILE, &original.path)
            .unwrap();
        let result = service
            .install(DISC_PORT, None, None, None, true, |_| {})
            .await;
        if name.contains("-builder-") || name.ends_with("-debug.zip") {
            // Observed behavior, tracked as a defect (#8602), not a
            // contract: a builder or debug package that is the only host
            // archive is selected, downloaded and installed as the player.
            // The generic package choice (`release.rs`,
            // `choose_asset_for_variant`) applies the typed-role gate only for
            // portable adapters.
            let install = result.unwrap();
            assert_eq!(install.artifact.asset_name, name);
            assert_eq!(
                server.downloads(),
                [format!("{DISC_REPOSITORY}/releases/download/{tag}/{name}")],
                "{name}"
            );
        } else {
            // Mobile package.
            let error = result.unwrap_err();
            assert_eq!(error.code, ErrorCode::NotFound, "{name}: {error:?}");
            assert!(server.downloads().is_empty(), "{name}");
            assert!(
                service.status(DISC_PORT).unwrap().active.is_none(),
                "{name}"
            );
        }
        original.assert_untouched();
        no_library_copy(&library, &original);
    }
}

/// One recorded release (`tag`) that publishes only `decoy`, renamed for this
/// host, with real game bytes served under the decoy's name.
fn decoy_only_release(member: &str, tag: &str, decoy: &Value) -> Value {
    let mut release = fixture::release_lists()[member]
        .as_array()
        .unwrap()
        .iter()
        .find(|release| release["tag_name"] == tag)
        .unwrap()
        .clone();
    release["assets"] = json!([decoy]);
    json!([release])
}

#[tokio::test]
async fn refusal_missing_player_or_missing_original() {
    // A package without the declared player is refused before publication.
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let original = Original::create(temporary.path());
    let mut playerless = package("v2.0.0");
    playerless.bytes = fixture::zip(&[(
        "README.txt".into(),
        b"no player in this package".to_vec(),
        false,
    )]);
    let server = ReleaseServer::start(DISC_REPOSITORY, "referenced_disc", vec![playerless]);
    let document = fixture::document();
    let service = service_for(&library, &server, &document, None);
    service
        .register_source(DISC_PROFILE, &original.path)
        .unwrap();
    let error = service
        .install(DISC_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert!(
        service.status(DISC_PORT).unwrap().active.is_none(),
        "{error:?}"
    );
    original.assert_untouched();

    // Without a registered original nothing is downloaded or installed.
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let server = ReleaseServer::start(DISC_REPOSITORY, "referenced_disc", vec![package("v2.0.0")]);
    let service = service_for(&library, &server, &document, None);
    let error = service
        .install(DISC_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::SourceInvalid, "{error:?}");
    assert!(server.downloads().is_empty());
    assert!(service.status(DISC_PORT).unwrap().active.is_none());

    // An original that is moved away after install is not launched; Portcove
    // does not follow, recreate or replace it.
    let original = Original::create(temporary.path());
    service
        .register_source(DISC_PROFILE, &original.path)
        .unwrap();
    service
        .install(DISC_PORT, None, None, None, true, |_| {})
        .await
        .unwrap();
    service.prepare_launch(DISC_PORT, None).unwrap();
    let moved = temporary.path().join("moved-away.iso");
    fs::rename(&original.path, &moved).unwrap();
    assert!(service.prepare_launch(DISC_PORT, None).is_err());
    assert!(!original.path.exists());
    fs::rename(&moved, &original.path).unwrap();
    original.assert_untouched();
}

#[tokio::test]
async fn refusal_changed_original_identity_is_not_launched() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let original = Original::create(temporary.path());
    let server = ReleaseServer::start(DISC_REPOSITORY, "referenced_disc", vec![package("v2.0.0")]);
    let document = fixture::document();
    let (service, _install, _source) = installed(&library, &server, &document, &original).await;
    service.prepare_launch(DISC_PORT, None).unwrap();
    fs::write(&original.path, b"a different disc at the registered path").unwrap();
    let changed = fixture::file_identity(&original.path);
    let error = service.prepare_launch(DISC_PORT, None).unwrap_err();
    assert_eq!(error.code, ErrorCode::SourceInvalid, "{error:?}");
    // The refusal reads the original; it does not repair or replace it.
    assert_eq!(fixture::file_identity(&original.path), changed);
}

#[tokio::test]
async fn update_and_rollback_keep_player_data_and_the_original() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let original = Original::create(temporary.path());
    let document = fixture::document();
    let mut first = fixture::served_releases("referenced_disc");
    first
        .as_array_mut()
        .unwrap()
        .retain(|release| release["tag_name"] == "v1.0.0");
    let server =
        ReleaseServer::start_with_releases(DISC_REPOSITORY, first, vec![package("v1.0.0")]);
    let (service, v1, source) = installed(&library, &server, &document, &original).await;
    assert_eq!(v1.version, "v1.0.0");
    let user = library.user_dir(DISC_PORT);
    fs::create_dir_all(user.join("saves")).unwrap();
    fs::write(user.join("saves/slot1.sav"), b"player progress").unwrap();
    fs::write(user.join("config.json"), b"{\"player\":true}").unwrap();
    let user_before = fixture::tree(&user);

    let server = ReleaseServer::start(DISC_REPOSITORY, "referenced_disc", vec![package("v2.0.0")]);
    let service_v2 = service_for(&library, &server, &document, None);
    drop(service);
    let check = service_v2.check_update(DISC_PORT).await.unwrap();
    assert!(check.update_available, "{check:?}");
    let v2 = service_v2
        .update(DISC_PORT, None, None, true, |_| {})
        .await
        .unwrap();
    assert_eq!(v2.version, "v2.0.0");
    let status = service_v2.status(DISC_PORT).unwrap();
    assert_eq!(status.active.unwrap().id, v2.id);
    assert_eq!(status.previous.unwrap().id, v1.id);
    assert_eq!(fixture::tree(&user), user_before);
    assert_launch_references(&service_v2, &library, &v2, &source);

    let rolled_back = service_v2.rollback(DISC_PORT).unwrap();
    assert_eq!(rolled_back.id, v1.id);
    assert_eq!(fixture::tree(&user), user_before);
    assert_launch_references(&service_v2, &library, &rolled_back, &source);
    original.assert_untouched();
    no_library_copy(&library, &original);
}

/// Directory names beside the active installation: every published version
/// folder of this port, whether or not it is registered.
fn version_folders(install: &InstallRecord) -> std::collections::BTreeSet<std::ffi::OsString> {
    fs::read_dir(install.path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_dir())
        .map(|entry| entry.file_name())
        .collect()
}

/// A crash at each update boundary resolves to exactly one state. Before the
/// verified install is journaled as `Prepared`, the failed update discards its
/// private work itself (`install.rs`, the `LifecyclePhase::Preparing` failure
/// branch), so v1 stays active and nothing of v2 is published. From
/// `Prepared` on, restart recovery finishes publication, registration and
/// cleanup (`recovery.rs`, `recover_published_install`), so v2 is active and
/// v1 is kept as the rollback version. Player data and the original are kept
/// in every case.
#[tokio::test]
async fn interrupted_update_recovers_with_player_data_and_original_intact() {
    for (point, v2_published) in [
        (LifecycleFaultPoint::InstallReadyToPublish, false),
        (LifecycleFaultPoint::InstallPrepared, true),
        (LifecycleFaultPoint::InstallPublished, true),
        (LifecycleFaultPoint::InstallMetadataCommitted, true),
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let original = Original::create(temporary.path());
        let document = fixture::document();
        let mut first = fixture::served_releases("referenced_disc");
        first
            .as_array_mut()
            .unwrap()
            .retain(|release| release["tag_name"] == "v1.0.0");
        let server =
            ReleaseServer::start_with_releases(DISC_REPOSITORY, first, vec![package("v1.0.0")]);
        let (service, v1, source) = installed(&library, &server, &document, &original).await;
        drop(service);
        let user = library.user_dir(DISC_PORT);
        fs::create_dir_all(user.join("saves")).unwrap();
        fs::write(user.join("saves/slot1.sav"), b"player progress").unwrap();
        let user_before = fixture::tree(&user);
        let v1_tree = fixture::tree(&v1.path);

        let server =
            ReleaseServer::start(DISC_REPOSITORY, "referenced_disc", vec![package("v2.0.0")]);
        let faulted = service_for(&library, &server, &document, Some(point));
        let error = faulted
            .update(DISC_PORT, None, None, true, |_| {})
            .await
            .unwrap_err();
        assert!(
            error.message.contains("injected mechanism fault"),
            "{point:?}: {error:?}"
        );
        drop(faulted);

        // Restart: recovery resolves the journal without a further operation.
        let restarted = service_for(&library, &server, &document, None);
        restarted.recover_pending_operations().unwrap();
        let status = restarted.status(DISC_PORT).unwrap();
        let active = status.active.clone().unwrap();
        if v2_published {
            assert_eq!(active.version, "v2.0.0", "{point:?}");
            assert_ne!(active.id, v1.id, "{point:?}");
            assert_eq!(status.previous.unwrap().id, v1.id, "{point:?}");
            assert_eq!(
                version_folders(&v1),
                [&v1, &active]
                    .iter()
                    .map(|install| install.path.file_name().unwrap().to_owned())
                    .collect(),
                "{point:?}"
            );
        } else {
            assert_eq!(active.id, v1.id, "{point:?}");
            assert!(status.previous.is_none(), "{point:?}");
            assert_eq!(
                version_folders(&v1),
                [v1.path.file_name().unwrap().to_owned()].into(),
                "{point:?}"
            );
        }
        assert_eq!(fixture::tree(&v1.path), v1_tree, "{point:?}");
        assert!(restarted.verify(DISC_PORT).unwrap().valid, "{point:?}");
        assert!(
            crate::operation::OperationStore::new(library.clone())
                .all()
                .unwrap()
                .is_empty(),
            "{point:?}: journal left behind"
        );
        assert_eq!(fixture::tree(&user), user_before, "{point:?}");
        assert_launch_references(&restarted, &library, &active, &source);
        original.assert_untouched();
        no_library_copy(&library, &original);
    }
}

/// Removal deletes Portcove's installation and registration only: the
/// referenced original and its folder are untouched.
#[tokio::test]
async fn removal_leaves_the_referenced_original_untouched() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let original = Original::create(temporary.path());
    let server = ReleaseServer::start(DISC_REPOSITORY, "referenced_disc", vec![package("v2.0.0")]);
    let document = fixture::document();
    let (service, install, _source) = installed(&library, &server, &document, &original).await;
    service.prepare_launch(DISC_PORT, None).unwrap();
    let preview = service.preview_removal(DISC_PORT).unwrap();
    let authorization = service
        .authorize_removal(DISC_PORT, &preview.preview_sha256)
        .unwrap();
    let removed = service.remove(DISC_PORT, &authorization.token).unwrap();
    for path in &removed {
        assert!(
            !fixture::within(&original.path, path) && !fixture::within(path, &original.directory),
            "removal reached the original: {path:?}"
        );
    }
    assert!(!install.path.exists());
    assert!(service.status(DISC_PORT).unwrap().active.is_none());
    original.assert_untouched();
    // The player's source registration is not Portcove's installation.
    assert!(library.source(DISC_PROFILE).unwrap().is_some());

    // Removing the source registration forgets it without deleting the file.
    let preview = service.preview_source_removal(DISC_PROFILE).unwrap();
    let authorization = service
        .authorize_source_removal(DISC_PROFILE, &preview.preview_sha256)
        .unwrap();
    service
        .remove_source(DISC_PROFILE, &authorization.token)
        .unwrap();
    assert!(library.source(DISC_PROFILE).unwrap().is_none());
    original.assert_untouched();
}
