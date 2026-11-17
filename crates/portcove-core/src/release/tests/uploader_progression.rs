//! Production-provider fixtures for uploader continuity. Accounts, times and
//! releases are first-party fixtures, not upstream observations.
use super::*;

const OWNER: u64 = 1;
const REGULAR: u64 = 2;
const FOREIGN: u64 = 9;
const BEFORE: &str = "2026-11-01T12:00:00Z";
const AFTER: &str = "2026-12-01T12:00:00Z";

fn account(id: u64) -> serde_json::Value {
    serde_json::json!({"id": id, "login": format!("account-{id}"), "type": "User"})
}

fn actions_bot() -> serde_json::Value {
    serde_json::json!({"id": 41_898_282, "login": "github-actions[bot]", "type": "Bot"})
}

/// One release whose only package the Windows selector accepts. `uploader` is
/// the provider field verbatim; `None` omits the field entirely.
fn release(
    id: u64,
    tag: &str,
    uploader: Option<serde_json::Value>,
    created_at: &str,
) -> serde_json::Value {
    let mut asset = serde_json::json!({
        "id": id * 10, "name": "game-windows.zip", "size": 42,
        "digest": format!("sha256:{}", "a".repeat(64)),
        "browser_download_url": format!(
            "https://github.com/HarbourMasters/Shipwright/releases/download/{tag}/game-windows.zip"
        ),
        "created_at": created_at,
    });
    if let Some(uploader) = uploader {
        asset["uploader"] = uploader;
    }
    serde_json::json!({
        "id": id, "tag_name": tag, "draft": false, "prerelease": false,
        "published_at": created_at, "assets": [asset]
    })
}

fn repository() -> String {
    ok_json(
        &serde_json::json!({"id": 100, "archived": false, "owner": account(OWNER)}).to_string(),
        "",
    )
}

fn listing(newest_first: &[serde_json::Value]) -> String {
    ok_json(&serde_json::to_string(newest_first).unwrap(), "")
}

fn shipwright() -> PortDefinition {
    crate::Catalog::embedded()
        .unwrap()
        .port("shipwright")
        .unwrap()
        .clone()
}

/// Resolves once through a fresh production provider, as a fresh Install,
/// Update or update check would after the five-minute cache.
async fn resolve(
    port: &PortDefinition,
    newest_first: &[serde_json::Value],
) -> Result<crate::ScopedResolvedRelease> {
    let (origin, _, server) = serve_http(vec![repository(), listing(newest_first)]);
    let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
    let result = provider
        .resolve_scoped(port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
        .await;
    server.join().unwrap();
    result
}

fn assert_held(error: &PortcoveError, uploader: Option<u64>) {
    assert_eq!(error.code, crate::ErrorCode::Unsupported, "{error:?}");
    assert_eq!(error.details["reason"], "provider_uploader_not_continuous");
    assert_eq!(
        error.details.get("uploader_id").map(String::as_str),
        uploader.map(|id| id.to_string()).as_deref()
    );
}

#[tokio::test]
async fn github_progression_requires_a_continuous_uploader() {
    let port = shipwright();
    let n = release(1, "v1.0.0", Some(account(REGULAR)), BEFORE);

    // N, and N+1 from the same established uploader, follow automatically.
    let resolved = resolve(&port, std::slice::from_ref(&n)).await.unwrap();
    assert_eq!(resolved.release.version, "v1.0.0");
    let same = release(2, "v1.1.0", Some(account(REGULAR)), AFTER);
    let resolved = resolve(&port, &[same, n.clone()]).await.unwrap();
    assert_eq!(resolved.release.version, "v1.1.0");
    // The decision travels with the resolved release, so the build staged from
    // it can apply the same decision before it becomes active.
    assert_eq!(
        resolved.release.uploader_continuity,
        Some(crate::UploaderContinuityRecord {
            basis: crate::UploaderContinuityBasis::Established,
            uploader_id: Some(REGULAR),
            uploaded_at: Some(AFTER.into()),
        })
    );

    // A foreign uploader's N+1 is held with the player reason, and a later
    // N+2 cannot launder that account through its own post-baseline upload.
    let foreign = release(2, "v1.1.0", Some(account(FOREIGN)), AFTER);
    let error = resolve(&port, &[foreign.clone(), n.clone()])
        .await
        .unwrap_err();
    assert_held(&error, Some(FOREIGN));
    assert!(
        error
            .message
            .starts_with("Portcove is holding back this version")
    );
    assert!(error.message.contains("Nothing was downloaded or changed"));
    assert_eq!(error.details["release_tag"], "v1.1.0");
    let laundered = release(3, "v1.2.0", Some(account(FOREIGN)), AFTER);
    let error = resolve(&port, &[laundered, foreign.clone(), n.clone()])
        .await
        .unwrap_err();
    assert_held(&error, Some(FOREIGN));

    // The repository owner and the project's own Actions automation continue.
    for uploader in [account(OWNER), actions_bot()] {
        let next = release(2, "v1.1.0", Some(uploader), AFTER);
        let resolved = resolve(&port, &[next, n.clone()]).await.unwrap();
        assert_eq!(resolved.release.version, "v1.1.0");
    }

    // A response without any uploader facts is UNKNOWN and keeps today's
    // behavior; a selected asset missing the field beside attributed assets is an
    // inconsistent observation and is held. GitHub reporting no account after the
    // baseline is a known refusal.
    let unknown = release(2, "v1.1.0", None, AFTER);
    let unobserved_n = release(1, "v1.0.0", None, BEFORE);
    let resolved = resolve(&port, &[unknown.clone(), unobserved_n])
        .await
        .unwrap();
    assert_eq!(resolved.release.version, "v1.1.0");
    let error = resolve(&port, &[unknown, n.clone()]).await.unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Unsupported);
    assert_eq!(error.details["reason"], "provider_uploader_not_observed");
    let unattributed = release(2, "v1.1.0", Some(serde_json::Value::Null), AFTER);
    let error = resolve(&port, &[unattributed, n.clone()])
        .await
        .unwrap_err();
    assert_held(&error, None);
    assert!(error.message.contains("doesn't show who uploaded it"));

    // Existing releases keep their behavior whoever uploaded them.
    let existing = release(2, "v1.1.0", Some(account(FOREIGN)), BEFORE);
    let resolved = resolve(&port, &[existing, n.clone()]).await.unwrap();
    assert_eq!(resolved.release.version, "v1.1.0");

    // A maintainer-reviewed uploader continues once accepted by numeric ID, and
    // the acceptance is part of the selection cache identity.
    let mut accepted = port.clone();
    accepted.release.accepted_uploaders = vec![crate::AcceptedUploader {
        id: FOREIGN,
        login: format!("account-{FOREIGN}"),
    }];
    assert_ne!(
        ReleaseSelectionCacheKey::new(&port, ReleaseChannel::Stable, Platform::WindowsX86_64),
        ReleaseSelectionCacheKey::new(&accepted, ReleaseChannel::Stable, Platform::WindowsX86_64)
    );
    let resolved = resolve(&accepted, &[foreign, n]).await.unwrap();
    assert_eq!(resolved.release.version, "v1.1.0");
}

#[tokio::test]
async fn a_held_github_release_is_not_cached_and_requests_no_checksum() {
    let port = shipwright();
    let n = release(1, "v1.0.0", Some(account(REGULAR)), BEFORE);
    // Without a publisher digest, selection would fetch this sidecar next; the
    // refusal must come first, so the fixture serves only metadata requests.
    let mut foreign = release(2, "v1.1.0", Some(account(FOREIGN)), AFTER);
    foreign["assets"][0]["digest"] = serde_json::Value::Null;
    foreign["assets"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": 21, "name": "game-windows.zip.sha256", "size": 80, "digest": null,
            "browser_download_url": "https://downloads.example.invalid/game-windows.zip.sha256",
            "created_at": AFTER, "uploader": account(FOREIGN),
        }));
    let same = release(2, "v1.1.0", Some(account(REGULAR)), AFTER);
    let (origin, _, server) = serve_http(vec![
        repository(),
        listing(&[foreign, n.clone()]),
        repository(),
        listing(&[same, n]),
    ]);
    let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
    let error = provider
        .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
        .await
        .unwrap_err();
    assert_held(&error, Some(FOREIGN));
    // The same provider observes upstream again instead of reusing a held result.
    let resolved = provider
        .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
        .await
        .unwrap();
    assert_eq!(resolved.release.version, "v1.1.0");
    server.join().unwrap();
}

#[tokio::test]
async fn a_held_update_check_leaves_the_installed_copy_active() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    // Starship declares an executable for every platform this suite runs on.
    let installed =
        crate::retained_build::tests::install(&library, "installed", b"accepted runtime", true);
    let name = match Platform::current().unwrap() {
        Platform::WindowsX86_64 => "starship-windows.zip",
        Platform::LinuxX86_64 => "starship-linux.zip",
        Platform::MacosX86_64 | Platform::MacosAarch64 => "starship-macos.zip",
    };
    let n = release(1, "v1", Some(account(REGULAR)), BEFORE);
    let mut foreign = release(2, "v2", Some(account(FOREIGN)), AFTER);
    foreign["assets"][0]["name"] = serde_json::json!(name);
    let (origin, _, server) = serve_http(vec![repository(), listing(&[foreign, n])]);
    let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
    let service = crate::PortcoveService::with_provider(library, Arc::new(provider)).unwrap();
    let error = service.check_update("starship").await.unwrap_err();
    server.join().unwrap();
    assert_held(&error, Some(FOREIGN));
    let status = service.status("starship").unwrap();
    assert_eq!(status.active.unwrap().id, installed.id);
    assert!(status.staged.is_none());
}

/// The fixtures below stand in for downloaded builds: `create_manifest` writes
/// the same marker and facts a fresh install of this version would.
///
/// Rewrites a registered build's manifest as a version before #6209 wrote it,
/// without the marker that acquisition facts are recorded.
fn as_unrecorded(library: &Library, install: &crate::InstallRecord) -> crate::InstallRecord {
    rewrite_manifest(library, install, |manifest| {
        assert_eq!(manifest["acquisition_facts_recorded"], true);
        manifest
            .as_object_mut()
            .unwrap()
            .remove("acquisition_facts_recorded");
    })
}

fn rewrite_manifest(
    library: &Library,
    install: &crate::InstallRecord,
    change: impl FnOnce(&mut serde_json::Value),
) -> crate::InstallRecord {
    use sha2::Digest as _;
    let path = install.path.join(".portcove-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    change(&mut manifest);
    let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let mut rewritten = install.clone();
    rewritten.manifest_sha256 = hex::encode(sha2::Sha256::digest(&bytes));
    library.update_install_manifest(&rewritten).unwrap();
    rewritten
}

fn assert_unconfirmed(error: &PortcoveError) {
    assert_eq!(error.code, crate::ErrorCode::Unsupported, "{error:?}");
    assert_eq!(error.details["reason"], "provider_uploader_not_observed");
    assert!(
        error
            .message
            .starts_with("Portcove is holding back this version"),
        "{}",
        error.message
    );
}

#[test]
fn a_build_staged_without_recorded_uploader_facts_needs_a_fresh_resolution() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let active = crate::retained_build::tests::install(&library, "active", b"active runtime", true);
    let staged =
        crate::retained_build::tests::install(&library, "staged", b"staged runtime", false);
    let service = crate::PortcoveService::new(library.clone()).unwrap();
    // A build this version recorded passes the uploader check.
    service
        .require_activation_uploader_continuity(&staged, None)
        .unwrap();

    // Staged after the baseline by a version that recorded nothing: activation
    // is held and nothing changes.
    let unrecorded = as_unrecorded(&library, &staged);
    assert_unconfirmed(&service.activate_staged("starship").unwrap_err());
    let status = service.status("starship").unwrap();
    assert_eq!(status.active.unwrap().id, active.id);
    assert_eq!(status.staged.unwrap().id, unrecorded.id);
    // A fresh resolution of the same artifact supplies the decision.
    service
        .require_activation_uploader_continuity(
            &unrecorded,
            Some(&crate::UploaderContinuityRecord {
                basis: crate::UploaderContinuityBasis::RepositoryOwner,
                uploader_id: Some(OWNER),
                uploaded_at: Some(AFTER.into()),
            }),
        )
        .unwrap();
    // Installed before the baseline: unchanged behavior.
    service
        .require_activation_uploader_continuity(
            &crate::InstallRecord {
                installed_at: 1,
                ..unrecorded
            },
            None,
        )
        .unwrap();
}

#[test]
fn rollback_to_a_build_without_recorded_uploader_facts_is_held() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    crate::retained_build::tests::install(&library, "first", b"first runtime", true);
    let second = crate::retained_build::tests::install(&library, "second", b"second runtime", true);
    let previous = library
        .status("starship", ReleaseChannel::Stable)
        .unwrap()
        .previous
        .unwrap();
    as_unrecorded(&library, &previous);
    let service = crate::PortcoveService::new(library.clone()).unwrap();
    let assessment = service
        .status("starship")
        .unwrap()
        .port_actions
        .into_iter()
        .find(|assessment| assessment.action == crate::PortAction::Rollback)
        .unwrap();
    assert_eq!(assessment.availability, crate::PortActionAvailability::Held);
    assert_eq!(assessment.reason, crate::PortActionReason::ReviewRequired);
    assert_unconfirmed(&service.rollback("starship").unwrap_err());
    assert_eq!(
        service.status("starship").unwrap().active.unwrap().id,
        second.id
    );
}

#[test]
fn a_staged_build_from_an_uploader_no_longer_accepted_is_held() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let active = crate::retained_build::tests::install(&library, "active", b"active runtime", true);
    let staged =
        crate::retained_build::tests::install(&library, "staged", b"staged runtime", false);
    let service = crate::PortcoveService::new(library.clone()).unwrap();
    assert!(
        service
            .catalog()
            .port("starship")
            .unwrap()
            .release
            .accepted_uploaders
            .iter()
            .all(|account| account.id != FOREIGN)
    );
    // Staged while the catalog accepted this uploader; the catalog no longer does.
    let accepted = rewrite_manifest(&library, &staged, |manifest| {
        manifest["uploader_continuity"] = serde_json::json!({
            "basis": "accepted", "uploader_id": FOREIGN, "uploaded_at": AFTER
        });
    });
    let error = service.activate_staged("starship").unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Unsupported, "{error:?}");
    assert_eq!(error.details["reason"], "provider_uploader_not_continuous");
    assert_eq!(error.details["uploader_id"], FOREIGN.to_string());
    let status = service.status("starship").unwrap();
    assert_eq!(status.active.unwrap().id, active.id);
    assert_eq!(status.staged.unwrap().id, accepted.id);
    // Any other recorded basis stands.
    let established = rewrite_manifest(&library, &accepted, |manifest| {
        manifest["uploader_continuity"] = serde_json::json!({
            "basis": "established", "uploader_id": REGULAR, "uploaded_at": AFTER
        });
    });
    service
        .require_activation_gates(&established, None)
        .unwrap();
}

#[test]
fn profile_binding_holds_a_staged_build_without_recorded_uploader_facts() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = crate::PortcoveService::new(library.clone()).unwrap();
    crate::retained_build::tests::install(&library, "active", b"active runtime", true);
    let default = service.ensure_default_profile("starship").unwrap();
    let customized = service
        .copy_profile("starship", &default.id, "Customized")
        .unwrap();
    let staged =
        crate::retained_build::tests::install(&library, "staged", b"staged runtime", false);
    service
        .preview_retained_build_binding("starship", "saved-build", &staged.id)
        .unwrap();

    let unrecorded = as_unrecorded(&library, &staged);
    assert_unconfirmed(
        &service
            .preview_retained_build_binding("starship", "saved-build", &unrecorded.id)
            .unwrap_err(),
    );
    assert_unconfirmed(
        &service
            .create_profile_revision(
                "starship",
                &customized.id,
                &crate::ProfileRevisionRequest {
                    expected_revision: customized.current_revision,
                    install_id: Some(unrecorded.id),
                    ..Default::default()
                },
            )
            .unwrap_err(),
    );
}

#[test]
fn an_existing_pin_holds_launch_after_an_accepted_uploader_is_removed() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let mut service = crate::PortcoveService::new(library.clone()).unwrap();
    let active = crate::retained_build::tests::install(&library, "active", b"active runtime", true);
    let default = service.ensure_default_profile("starship").unwrap();
    let customized = service
        .copy_profile("starship", &default.id, "Customized")
        .unwrap();

    let mut document = service.catalog().document().clone();
    let port = document
        .ports
        .iter_mut()
        .find(|port| port.id == "starship")
        .unwrap();
    port.release.accepted_uploaders = serde_json::from_value(serde_json::json!([
        {"id": FOREIGN, "login": "accepted-before"}
    ]))
    .unwrap();
    let narrowed = service.catalog().clone();
    service.replace_catalog_for_test(crate::Catalog::from_document(document).unwrap());
    let staged =
        crate::retained_build::tests::install(&library, "staged", b"staged runtime", false);
    let accepted = rewrite_manifest(&library, &staged, |manifest| {
        manifest["uploader_continuity"] = serde_json::json!({
            "basis": "accepted", "uploader_id": FOREIGN, "uploaded_at": AFTER
        });
    });
    service
        .create_profile_revision(
            "starship",
            &customized.id,
            &crate::ProfileRevisionRequest {
                expected_revision: customized.current_revision,
                install_id: Some(accepted.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    service
        .activate_profile("starship", &customized.id)
        .unwrap();
    assert_eq!(
        service
            .profile_pinned_install("starship", Some(active.clone()))
            .unwrap()
            .unwrap()
            .id,
        accepted.id
    );

    service.replace_catalog_for_test(narrowed);
    let error = service
        .profile_pinned_install("starship", Some(active))
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Unsupported);
    assert_eq!(error.details["reason"], "provider_uploader_not_continuous");
    assert_eq!(error.details["profile"], "Customized");
    let resolved = service
        .resolve_retained_build("starship", &customized.id)
        .unwrap();
    assert_eq!(
        resolved.availability,
        crate::RetainedBuildAvailability::Held
    );

    // Matching the active ID also cannot bypass the pin gate. The clean
    // Default launch follows the existing active-runtime policy.
    library.register_install(&accepted, true).unwrap();
    let error = service
        .profile_pinned_install("starship", Some(accepted.clone()))
        .unwrap_err();
    assert_eq!(error.details["reason"], "provider_uploader_not_continuous");
    service.activate_profile("starship", &default.id).unwrap();
    assert_eq!(
        service
            .profile_pinned_install("starship", Some(accepted.clone()))
            .unwrap()
            .unwrap()
            .id,
        accepted.id
    );
}

#[test]
fn unconfirmed_output_folder_publication_recovers_as_held_without_activation() {
    use crate::operation::{
        LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore,
    };

    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = crate::PortcoveService::new(library.clone()).unwrap();
    let active = crate::retained_build::tests::install(&library, "active", b"active runtime", true);
    let id = uuid::Uuid::new_v4().to_string();
    let install = crate::retained_build::tests::install(&library, &id, b"published runtime", false);
    let mut install = as_unrecorded(&library, &install);
    install.installed_at = 1_795_000_000;
    install.staged = false;
    let output = temporary.path().join("custom-game-output");
    service.set_output_directory("starship", &output).unwrap();
    let output =
        crate::output_root::prepare_for_install(&library, "starship", &output, &id, 0).unwrap();
    let destination = output.root.join("published");
    std::fs::rename(&install.path, &destination).unwrap();
    std::fs::create_dir_all(&output.operation_root).unwrap();
    install.path = destination.clone();
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM installs WHERE id=?1", [&id])
        .unwrap();
    assert!(
        library
            .all_installs()
            .unwrap()
            .iter()
            .all(|row| row.id != id)
    );
    let mut operation = LifecycleOperation::new(&id, LifecycleOperationKind::Install, "starship");
    operation.phase = LifecyclePhase::PayloadPublished;
    operation.activate = true;
    operation.paths.staging = Some(output.operation_root.clone());
    operation.paths.final_path = Some(destination.clone());
    operation.install = Some(install.clone());
    let store = OperationStore::new(library.clone());
    store.put(&mut operation).unwrap();

    let error =
        crate::recovery::recover_published_install(&service, &store, &mut operation).unwrap_err();
    assert_unconfirmed(&error);
    assert_eq!(error.details["recovery_action"], "check_for_updates");
    let status = service.status("starship").unwrap();
    assert_eq!(status.active.unwrap().id, active.id);
    let staged = status.staged.unwrap();
    assert_eq!(staged.id, install.id);
    assert_eq!(staged.path, destination);
    assert!(destination.is_dir());
    assert!(!output.operation_root.exists());
    assert!(!library.has_unfinished_lifecycle("starship").unwrap());
    assert_unconfirmed(&service.activate_staged("starship").unwrap_err());
}
