//! Upstream-managed setup mechanism evidence (#8555).
//!
//! A synthetic port declares `adapter: upstream-managed-setup` with a setup
//! program, arguments, marker and owned output paths; nothing in production
//! names it. Every case drives the real service entry points: provider
//! resolution and download, install, explicit preparation (the upstream
//! setup run), launch preparation, update, rollback and removal. The setup
//! program is the repository's owned native probe, so the same cases run on
//! hosted Windows and Linux.
//!
//! The mechanism's promises: Portcove runs the upstream setup only as an
//! explicit, journaled preparation into a private copy, publishes it only when
//! the declared marker exists and the setup wrote nothing outside its declared
//! outputs, never runs setup on Play, and never changes the player's original
//! or progress.
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

use serde_json::{Value, json};

use super::*;
use crate::mechanism_fixtures::{
    self as fixture, ReleaseServer, SETUP_MARKER, SETUP_PORT, SETUP_PROFILE, SETUP_REPOSITORY,
    SETUP_SAVE, ServedPackage,
};
use crate::operation::{LifecycleFaultInjector, LifecycleFaultPoint, OperationStore};
use crate::{ErrorCode, PreparationMode, PreparationOptions};

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

fn options() -> PreparationOptions {
    PreparationOptions {
        target: host(),
        mode: PreparationMode::Default,
    }
}

struct Harness {
    temporary: tempfile::TempDir,
    library: Library,
    probe: PathBuf,
    original: PathBuf,
    original_identity: (Vec<u8>, u64, std::time::SystemTime),
}

impl Harness {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let tools = temporary.path().join("tools");
        fs::create_dir_all(&tools).unwrap();
        let probe = crate::test_fixture::build_probe(&tools);
        let originals = temporary.path().join("player-originals");
        fs::create_dir_all(&originals).unwrap();
        let original = originals.join("owned-setup-disc.iso");
        fs::write(&original, b"owned disc awaiting the upstream validator").unwrap();
        Self {
            original_identity: fixture::file_identity(&original),
            temporary,
            library,
            probe,
            original,
        }
    }

    fn package(&self, tag: &str, mode: &str) -> ServedPackage {
        ServedPackage {
            tag: tag.into(),
            asset: fixture::setup_asset_name(host()),
            bytes: fixture::setup_package(tag, host(), &self.probe, mode),
            corrupt: false,
        }
    }

    fn service(
        &self,
        server: &ReleaseServer,
        document: &Value,
        fault: Option<LifecycleFaultPoint>,
    ) -> PortcoveService {
        let mut service = match fault {
            Some(point) => PortcoveService::with_provider_and_faults(
                self.library.clone(),
                server.provider(),
                Arc::new(FailOnce {
                    point,
                    fired: AtomicBool::new(false),
                }),
            ),
            None => PortcoveService::with_provider(self.library.clone(), server.provider()),
        }
        .unwrap();
        service.replace_catalog_for_test(fixture::catalog_from(document));
        service
    }

    fn register_original(&self, service: &PortcoveService) -> SourceRecord {
        service
            .register_source(SETUP_PROFILE, &self.original)
            .unwrap()
    }

    fn assert_original_untouched(&self) {
        assert_eq!(
            fixture::file_identity(&self.original),
            self.original_identity
        );
        assert_eq!(
            fs::read_dir(self.original.parent().unwrap())
                .unwrap()
                .count(),
            1,
            "nothing is written next to the player's original"
        );
    }

    fn only(&self, tag: &str) -> Value {
        let mut releases = fixture::served_releases("upstream_setup");
        releases
            .as_array_mut()
            .unwrap()
            .retain(|release| release["tag_name"] == tag);
        releases
    }
}

fn prepare(service: &PortcoveService) -> Result<InstallRecord> {
    let plan = service.plan_preparation(SETUP_PORT, options())?;
    let authorization = service.authorize_preparation(SETUP_PORT, options(), &plan.plan_sha256)?;
    service.prepare(SETUP_PORT, options(), &authorization.token, |_| {})
}

fn write_save(install: &InstallRecord, bytes: &[u8]) {
    let save = install.path.join(SETUP_SAVE);
    fs::create_dir_all(save.parent().unwrap()).unwrap();
    fs::write(save, bytes).unwrap();
}

/// Model a finished play session: launch preparation, progress written by
/// the game and the launched marker Portcove's collection keys on.
fn play_once(service: &PortcoveService, install: &InstallRecord, progress: &[u8]) {
    service.prepare_launch(SETUP_PORT, None).unwrap();
    write_save(install, progress);
    fs::write(install.path.join(crate::service::LAUNCH_MARKER), b"1").unwrap();
}

fn pending_setup(service: &PortcoveService) -> bool {
    service
        .status(SETUP_PORT)
        .unwrap()
        .readiness
        .is_some_and(|readiness| readiness.pending_setup)
}

fn no_journals(library: &Library) -> bool {
    OperationStore::new(library.clone())
        .all()
        .unwrap()
        .is_empty()
}

/// Whether Portcove records the setup process tree as proven quiet after the
/// upstream setup ran. Before any setup process starts, the journal records
/// `Some(true)` (`preparation_execution.rs`, `prepare_derivative`). Starting
/// the setup records `Some(false)`; only a Windows job object can then prove
/// the tree quiet (`tool_process.rs`, `proves_tree_quiescence` is `false` on
/// Unix because a helper may leave its process group).
const SETUP_RAN_QUIESCED: bool = cfg!(windows);

/// A failed or interrupted private preparation keeps its work for review: one
/// `Preparing` journal whose final path was never published. Cleanup is offered
/// only once the setup process tree is proven quiet; otherwise the private work
/// stays for manual review, unchanged.
///
/// `recorded_quiesced` is the state this host must have recorded. Both
/// decisions are then exercised on every host by writing each recorded state
/// into the journal: first unproven (refused, nothing changes), then proven
/// (reviewed cleanup discards exactly that private tree and journal).
fn review_and_clean_retained_preparation(
    service: &PortcoveService,
    context: &str,
    recorded_quiesced: bool,
) {
    let store = OperationStore::new(service.library().clone());
    let journals = store.all().unwrap();
    assert_eq!(journals.len(), 1, "{context}");
    let mut journal = journals[0].clone();
    assert_eq!(
        journal.phase,
        crate::operation::LifecyclePhase::Preparing,
        "{context}"
    );
    assert!(journal.install.is_none(), "{context}");
    assert!(
        journal
            .paths
            .final_path
            .as_ref()
            .is_none_or(|path| !path.exists()),
        "{context}"
    );
    assert_eq!(
        journal.preparation_process_quiesced,
        Some(recorded_quiesced),
        "{context}"
    );
    let retained = journal
        .paths
        .staging
        .as_ref()
        .map(|path| fixture::tree(path))
        .unwrap_or_default();

    // Unproven quiescence: cleanup is refused for manual review.
    journal.preparation_process_quiesced = Some(false);
    store.put(&mut journal).unwrap();
    let refused = service
        .preview_preparation_cleanup(&journal.id)
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Conflict, "{context}: {refused:?}");
    assert_eq!(
        refused.details.get("recovery_action").map(String::as_str),
        Some("manual_review"),
        "{context}"
    );
    let after = store.all().unwrap();
    assert_eq!(after.len(), 1, "{context}");
    assert_eq!(after[0].id, journal.id, "{context}");
    assert_eq!(
        after[0]
            .paths
            .staging
            .as_ref()
            .map(|path| fixture::tree(path))
            .unwrap_or_default(),
        retained,
        "{context}"
    );

    // Proven quiescence: reviewed cleanup removes only the private work.
    let mut journal = after[0].clone();
    journal.preparation_process_quiesced = Some(true);
    store.put(&mut journal).unwrap();
    let preview = service.preview_preparation_cleanup(&journal.id).unwrap();
    let authorization = service
        .authorize_preparation_cleanup(&journal.id, &preview.preview_sha256)
        .unwrap();
    service
        .cleanup_preparation(&journal.id, &authorization.token)
        .unwrap();
    assert!(no_journals(service.library()), "{context}");
    if let Some(staging) = &journal.paths.staging {
        assert!(!staging.exists(), "{context}");
    }
}

async fn install_and_prepare(
    harness: &Harness,
    server: &ReleaseServer,
    document: &Value,
) -> (PortcoveService, InstallRecord, InstallRecord) {
    let service = harness.service(server, document, None);
    harness.register_original(&service);
    let installed = service
        .install(SETUP_PORT, None, None, None, true, |_| {})
        .await
        .unwrap();
    assert!(pending_setup(&service));
    let prepared = prepare(&service).unwrap();
    (service, installed, prepared)
}

#[tokio::test]
async fn success_runs_setup_once_as_explicit_preparation_and_play_never_reruns_it() {
    let harness = Harness::new();
    let server = ReleaseServer::start(
        SETUP_REPOSITORY,
        "upstream_setup",
        vec![harness.package("v2.0.0", "success")],
    );
    let document = fixture::document();
    let service = harness.service(&server, &document, None);
    harness.register_original(&service);
    let installed = service
        .install(SETUP_PORT, None, None, None, true, |_| {})
        .await
        .unwrap();
    // The newest release ships only mobile/console packages; the desktop
    // channel uses the newest release with this host's package, and only that
    // package is downloaded (never the checksum list or another host's package).
    assert_eq!(installed.version, "v2.0.0");
    assert_eq!(
        server.downloads(),
        [format!(
            "{SETUP_REPOSITORY}/releases/download/v2.0.0/{}",
            fixture::setup_asset_name(host())
        )]
    );
    // Installing never runs setup; Play is refused until preparation.
    assert!(pending_setup(&service));
    assert!(!installed.path.join(SETUP_MARKER).exists());
    assert!(service.prepare_launch(SETUP_PORT, None).is_err());
    assert!(!installed.path.join(SETUP_MARKER).exists());

    let installed_tree = fixture::tree(&installed.path);
    let prepared = prepare(&service).unwrap();
    assert_ne!(prepared.path, installed.path);
    assert_eq!(prepared.artifact, installed.artifact);
    assert!(prepared.path.join(SETUP_MARKER).is_file());
    assert!(
        prepared
            .path
            .join(crate::preparation::RECEIPT_FILE)
            .is_file()
    );
    // The prepared copy carries the original as its private runtime input.
    assert_eq!(
        fs::read(prepared.path.join("source.iso")).unwrap(),
        harness.original_identity.0
    );
    // Preparation published a private copy; the installed tree is unchanged.
    assert_eq!(fixture::tree(&installed.path), installed_tree);
    let status = service.status(SETUP_PORT).unwrap();
    assert_eq!(status.active.unwrap().id, prepared.id);
    assert_eq!(status.previous.unwrap().id, installed.id);
    assert!(!pending_setup(&service));
    assert!(service.verify(SETUP_PORT).unwrap().valid);
    assert!(no_journals(&harness.library));

    // Play prepares the declared game without running setup again.
    let before = fixture::tree(&prepared.path);
    for _ in 0..2 {
        let spec = service.prepare_launch(SETUP_PORT, None).unwrap();
        assert_eq!(
            spec.executable.file_name().unwrap().to_string_lossy(),
            fixture::game_program(host())
        );
        assert!(fixture::within(&spec.executable, &prepared.path));
    }
    assert_eq!(fixture::tree(&prepared.path), before);
    harness.assert_original_untouched();
}

#[tokio::test]
async fn refusal_held_acquisition_downloads_nothing() {
    let harness = Harness::new();
    let server = ReleaseServer::start(
        SETUP_REPOSITORY,
        "upstream_setup",
        vec![harness.package("v2.0.0", "success")],
    );
    let mut document = fixture::document();
    fixture::port_mut(&mut document, SETUP_PORT)["managed_acquisition_hold"] = json!({
        "reason": "Managed acquisition is held for this fixture.",
        "activation_reason": "Activation is held for this fixture.",
        "reviewed_artifacts": []
    });
    let service = harness.service(&server, &document, None);
    harness.register_original(&service);
    let error = service
        .install(SETUP_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported, "{error:?}");
    assert!(server.downloads().is_empty());
    assert!(service.status(SETUP_PORT).unwrap().active.is_none());
}

#[tokio::test]
async fn refusal_checksum_mismatch_publishes_nothing() {
    let harness = Harness::new();
    let mut corrupt = harness.package("v2.0.0", "success");
    corrupt.corrupt = true;
    let server = ReleaseServer::start(SETUP_REPOSITORY, "upstream_setup", vec![corrupt]);
    let document = fixture::document();
    let service = harness.service(&server, &document, None);
    harness.register_original(&service);
    let error = service
        .install(SETUP_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification, "{error:?}");
    assert!(service.status(SETUP_PORT).unwrap().active.is_none());
    assert!(fixture::tree(&harness.library.versions_dir()).is_empty());
}

#[tokio::test]
async fn refusal_unsupported_platform_downloads_nothing() {
    let harness = Harness::new();
    let server = ReleaseServer::start(
        SETUP_REPOSITORY,
        "upstream_setup",
        vec![harness.package("v2.0.0", "success")],
    );
    let mut document = fixture::document();
    let other = fixture::platforms()
        .into_iter()
        .find(|platform| *platform != host())
        .unwrap();
    let key = fixture::platform_key(other);
    let port = fixture::port_mut(&mut document, SETUP_PORT);
    port["platforms"] = json!([other]);
    port["executable_hints"] = json!({ key.clone(): [fixture::game_program(other)] });
    port["setup_executable_hints"] = json!({ key: [fixture::setup_program(other)] });
    let service = harness.service(&server, &document, None);
    let error = service
        .install(SETUP_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported, "{error:?}");
    assert!(server.downloads().is_empty());
}

/// Typed route facts: a checksum list, a mobile or console package and another
/// host's package are never offered as this host's game, and the recorded
/// installer and source-archive decoys are served beside the game package,
/// whose own name carries upstream's `setup` token. Each recorded decoy is
/// then offered alone under this host's name and refused with nothing
/// downloaded: the source archive, and on Windows the installer, by their role
/// (#8602); the rest, and the installer where `.exe` is not a package form, by
/// host or form.
#[tokio::test]
async fn refusal_wrong_role_or_host_is_never_selected() {
    let harness = Harness::new();
    let mut releases = fixture::served_releases("upstream_setup");
    let host_asset = fixture::setup_asset_name(host());
    for release in releases.as_array_mut().unwrap() {
        release["assets"]
            .as_array_mut()
            .unwrap()
            .retain(|asset| asset["name"] != host_asset.as_str());
    }
    let server = ReleaseServer::start_with_releases(SETUP_REPOSITORY, releases, Vec::new());
    let document = fixture::document();
    let service = harness.service(&server, &document, None);
    harness.register_original(&service);
    let error = service
        .install(SETUP_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound, "{error:?}");
    assert!(server.downloads().is_empty());

    // Each decoy alone, named for this host and serving real game bytes, so
    // the outcome depends on its role and not on host filtering.
    let decoys = fixture::same_host_decoys("upstream_setup");
    let names = decoys
        .iter()
        .map(|(_, decoy)| decoy["name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 5, "{names:?}");
    for (tag, decoy) in decoys {
        let name = decoy["name"].as_str().unwrap().to_owned();
        let server = ReleaseServer::start_with_releases(
            SETUP_REPOSITORY,
            decoy_only_release("upstream_setup", &tag, &decoy),
            vec![ServedPackage {
                asset: name.clone(),
                ..harness.package(&tag, "success")
            }],
        );
        let service = harness.service(&server, &document, None);
        let result = service
            .install(SETUP_PORT, None, None, None, true, |_| {})
            .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound, "{name}: {error:?}");
        let role_held =
            name.ends_with("-source.tar.gz") || (name.contains("-installer-") && cfg!(windows));
        assert_eq!(
            error.details.get("route_hold").map(String::as_str),
            role_held.then_some("wrong-role"),
            "{name}: {error:?}"
        );
        assert!(server.downloads().is_empty(), "{name}");
        assert!(
            service.status(SETUP_PORT).unwrap().active.is_none(),
            "{name}"
        );
        assert!(
            fixture::tree(&harness.library.versions_dir()).is_empty(),
            "{name}"
        );
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
async fn refusal_missing_or_moved_original() {
    // Without a registered original, install is refused before any download.
    let harness = Harness::new();
    let server = ReleaseServer::start(
        SETUP_REPOSITORY,
        "upstream_setup",
        vec![harness.package("v2.0.0", "success")],
    );
    let document = fixture::document();
    let service = harness.service(&server, &document, None);
    let error = service
        .install(SETUP_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::SourceInvalid, "{error:?}");
    assert!(server.downloads().is_empty());
    assert!(service.status(SETUP_PORT).unwrap().active.is_none());

    // An original that disappears after install refuses preparation and Play
    // before setup starts.
    harness.register_original(&service);
    let installed = service
        .install(SETUP_PORT, None, None, None, true, |_| {})
        .await
        .unwrap();
    let before = fixture::tree(&installed.path);
    let moved = harness.temporary.path().join("moved-away.iso");
    fs::rename(&harness.original, &moved).unwrap();
    assert!(prepare(&service).is_err());
    assert!(service.prepare_launch(SETUP_PORT, None).is_err());
    assert_eq!(fixture::tree(&installed.path), before);
    assert_eq!(
        service.status(SETUP_PORT).unwrap().active.unwrap().id,
        installed.id
    );
    assert!(no_journals(&harness.library));
    fs::rename(&moved, &harness.original).unwrap();
}

/// A package that lacks its declared setup program could never be prepared,
/// so install refuses it (#8602): the setup program is resolved in the staged
/// package exactly as preparation resolves it, before anything is published or
/// journaled. With an earlier version installed, that version stays active and
/// unchanged; the player's original is untouched.
#[tokio::test]
async fn refusal_setupless_package_publishes_nothing() {
    let harness = Harness::new();
    let setupless = |tag: &str| {
        let mut package = harness.package(tag, "success");
        package.bytes = fixture::zip(&[(
            fixture::game_program(host()),
            b"inert upstream-setup game".to_vec(),
            true,
        )]);
        package
    };
    let assert_refused = |error: PortcoveError| {
        assert_eq!(error.code, ErrorCode::Verification, "{error:?}");
        assert!(
            error
                .message
                .contains("does not contain the setup program this game needs"),
            "{error:?}"
        );
        assert_eq!(
            error
                .details
                .get("expected_setup_program")
                .map(String::as_str),
            Some(fixture::setup_program(host()).as_str())
        );
    };
    let server = ReleaseServer::start(
        SETUP_REPOSITORY,
        "upstream_setup",
        vec![setupless("v2.0.0")],
    );
    let document = fixture::document();
    let service = harness.service(&server, &document, None);
    harness.register_original(&service);
    let error = service
        .install(SETUP_PORT, None, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_refused(error);
    assert!(service.status(SETUP_PORT).unwrap().active.is_none());
    assert!(fixture::tree(&harness.library.versions_dir()).is_empty());
    assert!(no_journals(&harness.library));
    harness.assert_original_untouched();
    drop(service);

    // An update to a setupless package keeps the prepared version active.
    let server = ReleaseServer::start_with_releases(
        SETUP_REPOSITORY,
        harness.only("v1.0.0"),
        vec![harness.package("v1.0.0", "success")],
    );
    let (service, _, prepared) = install_and_prepare(&harness, &server, &document).await;
    drop(service);
    let before = fixture::tree(&prepared.path);
    let server = ReleaseServer::start(
        SETUP_REPOSITORY,
        "upstream_setup",
        vec![setupless("v2.0.0")],
    );
    let service = harness.service(&server, &document, None);
    let error = service
        .update(SETUP_PORT, None, None, true, |_| {})
        .await
        .unwrap_err();
    assert_refused(error);
    let status = service.status(SETUP_PORT).unwrap();
    assert_eq!(status.active.unwrap().id, prepared.id);
    assert_eq!(fixture::tree(&prepared.path), before);
    assert!(!pending_setup(&service));
    service.prepare_launch(SETUP_PORT, None).unwrap();
    assert!(no_journals(&harness.library));
    harness.assert_original_untouched();
}

#[tokio::test]
async fn refusal_changed_original_after_review_does_not_start_setup() {
    let harness = Harness::new();
    let server = ReleaseServer::start(
        SETUP_REPOSITORY,
        "upstream_setup",
        vec![harness.package("v2.0.0", "success")],
    );
    let document = fixture::document();
    let service = harness.service(&server, &document, None);
    harness.register_original(&service);
    let installed = service
        .install(SETUP_PORT, None, None, None, true, |_| {})
        .await
        .unwrap();
    let before = fixture::tree(&installed.path);
    let plan = service.plan_preparation(SETUP_PORT, options()).unwrap();
    let authorization = service
        .authorize_preparation(SETUP_PORT, options(), &plan.plan_sha256)
        .unwrap();
    fs::write(&harness.original, b"a different disc after review").unwrap();
    let error = service
        .prepare(SETUP_PORT, options(), &authorization.token, |_| {})
        .unwrap_err();
    assert_eq!(
        error.report().presentation.mutation_state,
        crate::MutationState::NotStarted
    );
    assert_eq!(fixture::tree(&installed.path), before);
    assert!(!installed.path.join(SETUP_MARKER).exists());
    assert_eq!(
        service.status(SETUP_PORT).unwrap().active.unwrap().id,
        installed.id
    );
    assert!(no_journals(&harness.library));
}

/// The upstream setup rejecting the original, finishing without its marker,
/// or writing outside its declared outputs publishes nothing and keeps the
/// active installation and player progress.
#[tokio::test]
async fn refusal_setup_rejection_or_unowned_writes_keep_the_active_installation() {
    for (mode, expected) in [
        ("failure", "exit 23"),
        ("missing-marker", "marker"),
        ("unowned-output", "outside its declared output ownership"),
    ] {
        let harness = Harness::new();
        let server = ReleaseServer::start(
            SETUP_REPOSITORY,
            "upstream_setup",
            vec![harness.package("v2.0.0", mode)],
        );
        let document = fixture::document();
        let service = harness.service(&server, &document, None);
        harness.register_original(&service);
        let installed = service
            .install(SETUP_PORT, None, None, None, true, |_| {})
            .await
            .unwrap();
        write_save(&installed, b"player progress");
        let before = fixture::tree(&installed.path);
        let error = prepare(&service).unwrap_err();
        assert!(error.message.contains(expected), "{mode}: {error:?}");
        assert_eq!(fixture::tree(&installed.path), before, "{mode}");
        let status = service.status(SETUP_PORT).unwrap();
        assert_eq!(status.active.unwrap().id, installed.id, "{mode}");
        assert!(pending_setup(&service), "{mode}");
        review_and_clean_retained_preparation(&service, mode, SETUP_RAN_QUIESCED);
        assert_eq!(fixture::tree(&installed.path), before, "{mode}");
        harness.assert_original_untouched();
    }
}

/// The state a restart must reach after a crash at one preparation boundary.
#[derive(Debug, Clone, Copy)]
enum AfterRecovery {
    /// The journal is still `Preparing`: recovery refuses to resume it
    /// (`preparation_execution.rs`, `recover`, `LifecyclePhase::Preparing`).
    /// The unprepared installation stays active and needs setup; the private
    /// work is retained for review and nothing was published.
    Unpublished {
        /// Whether the private working folder had been created.
        staging_exists: bool,
        /// The recorded process state (see [`SETUP_RAN_QUIESCED`]).
        quiesced: bool,
    },
    /// The verified prepared installation was journaled as `Prepared` or
    /// later: recovery finishes publication and registration
    /// (`recovery.rs`, `recover_published_install`), so the prepared copy is
    /// active and no journal or private work remains. The rollback version is
    /// the last working version: on a first install, with nothing earlier,
    /// the unprepared installation; after an update, the previous prepared
    /// version, never the update's own unprepared package (#8602).
    Published,
}

/// A crash at each preparation boundary resolves on restart to exactly one
/// expected state, never a mixture, with player progress and the original
/// intact. Faults are deterministic, so each point has one outcome. Every
/// point runs for a first install and for an update whose previous version
/// is prepared.
#[tokio::test]
async fn interrupted_preparation_recovers_with_player_data_intact() {
    use AfterRecovery::{Published, Unpublished};
    for (point, expected) in [
        // Journal persisted; the private working folder is created after it.
        (
            LifecycleFaultPoint::PreparationJournaled,
            Unpublished {
                staging_exists: false,
                quiesced: true,
            },
        ),
        // Reviewed copy made; no setup process has started.
        (
            LifecycleFaultPoint::PreparationCopied,
            Unpublished {
                staging_exists: true,
                quiesced: true,
            },
        ),
        (
            LifecycleFaultPoint::PreparationToolCompleted,
            Unpublished {
                staging_exists: true,
                quiesced: SETUP_RAN_QUIESCED,
            },
        ),
        (
            LifecycleFaultPoint::PreparationOutputsValidated,
            Unpublished {
                staging_exists: true,
                quiesced: SETUP_RAN_QUIESCED,
            },
        ),
        (LifecycleFaultPoint::PreparationPrepared, Published),
        (LifecycleFaultPoint::PreparationPublished, Published),
        (LifecycleFaultPoint::PreparationRegistered, Published),
    ] {
        for update in [false, true] {
            interrupted_preparation_case(point, expected, update).await;
        }
    }
}

async fn interrupted_preparation_case(
    point: LifecycleFaultPoint,
    expected: AfterRecovery,
    update: bool,
) {
    let context = format!("{point:?} update={update}");
    let harness = Harness::new();
    let document = fixture::document();
    // After an update, the last working version is the prepared earlier one.
    let last_working = if update {
        let server = ReleaseServer::start_with_releases(
            SETUP_REPOSITORY,
            harness.only("v1.0.0"),
            vec![harness.package("v1.0.0", "success")],
        );
        let (service, _, prepared_v1) = install_and_prepare(&harness, &server, &document).await;
        play_once(&service, &prepared_v1, b"player progress");
        Some(prepared_v1)
    } else {
        None
    };
    let server = ReleaseServer::start(
        SETUP_REPOSITORY,
        "upstream_setup",
        vec![harness.package("v2.0.0", "success")],
    );
    let service = harness.service(&server, &document, None);
    let installed = if update {
        service
            .update(SETUP_PORT, None, None, true, |_| {})
            .await
            .unwrap()
    } else {
        harness.register_original(&service);
        let installed = service
            .install(SETUP_PORT, None, None, None, true, |_| {})
            .await
            .unwrap();
        write_save(&installed, b"player progress");
        installed
    };
    let installed_tree = fixture::tree(&installed.path);
    drop(service);
    let faulted = harness.service(&server, &document, Some(point));
    let error = prepare(&faulted).unwrap_err();
    assert!(
        error.message.contains("injected mechanism fault"),
        "{context}: {error:?}"
    );
    drop(faulted);

    let restarted = harness.service(&server, &document, None);
    restarted.recover_pending_operations().unwrap();
    let status = restarted.status(SETUP_PORT).unwrap();
    let active = status.active.clone().unwrap();
    let previous = status.previous.as_ref().map(|install| install.id.clone());
    assert!(restarted.verify(SETUP_PORT).unwrap().valid, "{context}");
    // The installed package is never changed by preparation or recovery.
    assert_eq!(fixture::tree(&installed.path), installed_tree, "{context}");
    assert!(!installed.path.join(SETUP_MARKER).exists(), "{context}");
    harness.assert_original_untouched();
    match expected {
        AfterRecovery::Unpublished {
            staging_exists,
            quiesced,
        } => {
            assert_eq!(active.id, installed.id, "{context}");
            assert_eq!(
                previous,
                last_working.as_ref().map(|install| install.id.clone()),
                "{context}"
            );
            assert!(pending_setup(&restarted), "{context}");
            let journals = OperationStore::new(harness.library.clone()).all().unwrap();
            assert_eq!(journals.len(), 1, "{context}");
            let journal = &journals[0];
            assert_eq!(
                journal.phase,
                crate::operation::LifecyclePhase::Preparing,
                "{context}"
            );
            assert_eq!(
                journal
                    .paths
                    .staging
                    .as_ref()
                    .is_some_and(|path| path.is_dir()),
                staging_exists,
                "{context}"
            );
            // A retry succeeds beside the retained work; reviewed cleanup
            // then removes only that work.
            let retried = prepare(&restarted).unwrap();
            assert!(!pending_setup(&restarted), "{context}");
            review_and_clean_retained_preparation(&restarted, &context, quiesced);
            restarted.prepare_launch(SETUP_PORT, None).unwrap();
            assert_eq!(
                fs::read(retried.path.join(SETUP_SAVE)).unwrap(),
                b"player progress",
                "{context}"
            );
            let status = restarted.status(SETUP_PORT).unwrap();
            assert_eq!(status.active.unwrap().id, retried.id, "{context}");
            assert_eq!(
                status.previous.unwrap().id,
                last_working.as_ref().unwrap_or(&installed).id,
                "{context}"
            );
            assert!(retried.path.join(SETUP_MARKER).is_file(), "{context}");
        }
        AfterRecovery::Published => {
            assert_ne!(active.id, installed.id, "{context}");
            assert_eq!(active.artifact, installed.artifact, "{context}");
            assert_eq!(
                previous.as_deref(),
                Some(last_working.as_ref().unwrap_or(&installed).id.as_str()),
                "{context}"
            );
            assert!(!pending_setup(&restarted), "{context}");
            assert!(active.path.join(SETUP_MARKER).is_file(), "{context}");
            assert!(
                active.path.join(crate::preparation::RECEIPT_FILE).is_file(),
                "{context}"
            );
            assert!(no_journals(&harness.library), "{context}");
            restarted.prepare_launch(SETUP_PORT, None).unwrap();
            assert_eq!(
                fs::read(active.path.join(SETUP_SAVE)).unwrap(),
                b"player progress",
                "{context}"
            );
        }
    }
    if let Some(prepared_v1) = &last_working {
        // Rollback reaches the last working version, launchable and with the
        // player's progress, whichever state recovery reached.
        let rolled_back = restarted.rollback(SETUP_PORT).unwrap();
        assert_eq!(rolled_back.id, prepared_v1.id, "{context}");
        assert!(!pending_setup(&restarted), "{context}");
        restarted.prepare_launch(SETUP_PORT, None).unwrap();
        assert_eq!(
            fs::read(prepared_v1.path.join(SETUP_SAVE)).unwrap(),
            b"player progress",
            "{context}"
        );
    }
}

/// Update never runs setup and leaves the previous prepared copy and the
/// player's progress intact; the new package needs its own preparation.
///
/// After update and preparation, rollback returns to the last working version
/// (#8602): publishing prepared v2 keeps prepared v1 as the rollback version
/// because the replaced active installation was the preparation's own
/// unprepared source (`library.rs`, `register_prepared_install`). Rollback
/// then swaps between the two prepared versions. The unprepared v2 package
/// stays tracked like any superseded installation and is removed with the
/// port; nothing the upstream setup or the player owns is deleted, collected
/// progress is kept, and player data follows the active version.
#[tokio::test]
async fn update_needs_its_own_preparation_and_rollback_reaches_the_last_working_version() {
    let harness = Harness::new();
    let document = fixture::document();
    let server = ReleaseServer::start_with_releases(
        SETUP_REPOSITORY,
        harness.only("v1.0.0"),
        vec![harness.package("v1.0.0", "success")],
    );
    let (service, _v1, prepared_v1) = install_and_prepare(&harness, &server, &document).await;
    assert_eq!(prepared_v1.version, "v1.0.0");
    play_once(&service, &prepared_v1, b"player progress");
    drop(service);

    let server = ReleaseServer::start(
        SETUP_REPOSITORY,
        "upstream_setup",
        vec![harness.package("v2.0.0", "success")],
    );
    let service = harness.service(&server, &document, None);
    let v2 = service
        .update(SETUP_PORT, None, None, true, |_| {})
        .await
        .unwrap();
    assert_eq!(v2.version, "v2.0.0");
    // Update never runs setup: the new package awaits its own preparation.
    // The launched copy's progress was collected into the player's data
    // folder, and the previous prepared copy is kept unchanged.
    assert!(pending_setup(&service));
    assert!(!v2.path.join(SETUP_MARKER).exists());
    assert_eq!(
        service.status(SETUP_PORT).unwrap().previous.unwrap().id,
        prepared_v1.id
    );
    let user = harness.library.user_dir(SETUP_PORT);
    assert_eq!(fs::read(user.join(SETUP_SAVE)).unwrap(), b"player progress");
    assert_eq!(
        fs::read(prepared_v1.path.join(SETUP_SAVE)).unwrap(),
        b"player progress"
    );
    assert!(prepared_v1.path.join(SETUP_MARKER).is_file());
    let prepared_v2 = prepare(&service).unwrap();
    assert_eq!(prepared_v2.version, "v2.0.0");
    service.prepare_launch(SETUP_PORT, None).unwrap();
    assert_eq!(
        fs::read(prepared_v2.path.join(SETUP_SAVE)).unwrap(),
        b"player progress"
    );
    play_once(&service, &prepared_v2, b"progress from v2");

    // Publishing prepared v2 kept prepared v1 as the rollback version.
    let status = service.status(SETUP_PORT).unwrap();
    assert_eq!(status.active.as_ref().unwrap().id, prepared_v2.id);
    assert_eq!(status.previous.as_ref().unwrap().id, prepared_v1.id);
    let rolled_back = service.rollback(SETUP_PORT).unwrap();
    assert_eq!(rolled_back.id, prepared_v1.id);
    assert!(!pending_setup(&service));
    let spec = service.prepare_launch(SETUP_PORT, None).unwrap();
    assert!(fixture::within(&spec.executable, &prepared_v1.path));
    // Player data follows the active version.
    assert_eq!(
        fs::read(prepared_v1.path.join(SETUP_SAVE)).unwrap(),
        b"progress from v2"
    );
    assert_eq!(
        service.status(SETUP_PORT).unwrap().previous.unwrap().id,
        prepared_v2.id
    );

    // Rolling back again returns to prepared v2.
    let restored = service.rollback(SETUP_PORT).unwrap();
    assert_eq!(restored.id, prepared_v2.id);
    assert_eq!(
        service.status(SETUP_PORT).unwrap().previous.unwrap().id,
        prepared_v1.id
    );
    assert!(!pending_setup(&service));
    let spec = service.prepare_launch(SETUP_PORT, None).unwrap();
    assert!(fixture::within(&spec.executable, &prepared_v2.path));

    // Nothing is deleted and progress is kept throughout; the unprepared v2
    // package stays tracked for removal.
    for copy in [&prepared_v1, &prepared_v2] {
        assert!(copy.path.join(SETUP_MARKER).is_file());
    }
    assert_eq!(
        fs::read(prepared_v2.path.join(SETUP_SAVE)).unwrap(),
        b"progress from v2"
    );
    assert!(v2.path.is_dir());
    assert!(
        harness
            .library
            .port_install_paths(SETUP_PORT)
            .unwrap()
            .contains(&v2.path)
    );
    harness.assert_original_untouched();
    assert!(no_journals(&harness.library));
}

/// Removal deletes only Portcove's installations. The player's original and
/// registration remain, and progress is kept outside the removed folders.
#[tokio::test]
async fn removal_preserves_the_original_and_player_progress() {
    let harness = Harness::new();
    let server = ReleaseServer::start(
        SETUP_REPOSITORY,
        "upstream_setup",
        vec![harness.package("v2.0.0", "success")],
    );
    let document = fixture::document();
    let (service, installed, prepared) = install_and_prepare(&harness, &server, &document).await;
    play_once(&service, &prepared, b"player progress");

    let preview = service.preview_removal(SETUP_PORT).unwrap();
    let authorization = service
        .authorize_removal(SETUP_PORT, &preview.preview_sha256)
        .unwrap();
    let removed = service.remove(SETUP_PORT, &authorization.token).unwrap();
    for path in &removed {
        assert!(
            !fixture::within(&harness.original, path),
            "removal reached the original: {path:?}"
        );
    }
    assert!(!installed.path.exists());
    assert!(!prepared.path.exists());
    assert!(service.status(SETUP_PORT).unwrap().active.is_none());
    harness.assert_original_untouched();
    assert!(harness.library.source(SETUP_PROFILE).unwrap().is_some());
    let user = harness.library.user_dir(SETUP_PORT);
    assert_eq!(
        fs::read(user.join(SETUP_SAVE)).unwrap(),
        b"player progress",
        "removal must keep collected player progress"
    );
}
