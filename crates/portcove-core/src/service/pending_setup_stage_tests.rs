use super::*;
use serde_json::json;

// Mechanism fixture only; this identity names no catalog project.
const FIXTURE: &str = "staged-setup-fixture";
const PACKAGE: &[u8] = b"synthetic upstream setup package bytes";

struct Setup {
    _temporary: tempfile::TempDir,
    service: PortcoveService,
    record: PendingSetupRecord,
    parent: PathBuf,
}

fn listing_document(edit: impl FnOnce(&mut serde_json::Value)) -> crate::CatalogListingDocument {
    let mut listing = json!({
        "id": FIXTURE, "name": "Staged setup fixture",
        "summary": "Synthetic upstream project for setup stage tests",
        "project_url": "https://github.com/owner/staged",
        "release_url": "https://github.com/owner/staged/releases",
        "setup_url": "https://example.com/staged/setup-guide",
        "platforms": []
    });
    edit(&mut listing);
    crate::CatalogListingDocument {
        format_version: 4,
        listings: vec![serde_json::from_value(listing).unwrap()],
    }
}

fn empty_catalog() -> Catalog {
    Catalog::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[]}"#).unwrap()
}

fn set_listing(service: &mut PortcoveService, edit: impl FnOnce(&mut serde_json::Value)) {
    service.catalog = empty_catalog()
        .with_listing_document(listing_document(edit))
        .unwrap();
}

/// A finished download as publication leaves it: a fresh user-owned folder
/// holding either the unextracted package or extracted files and a receipt.
fn published(extracted: bool) -> Setup {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let mut service = PortcoveService::new(library).unwrap();
    set_listing(&mut service, |_| {});
    let parent = temporary.path().join("user-games");
    fs::create_dir(&parent).unwrap();
    let parent = fs::canonicalize(parent).unwrap();
    let request = CatalogDownloadRequest {
        port_id: FIXTURE.into(),
        release_id: 7.into(),
        asset_id: 11.into(),
        destination_parent: parent.clone(),
        extract_archive: extracted,
    };
    let (sha256, size) = {
        let path = temporary.path().join("package-digest");
        fs::write(&path, PACKAGE).unwrap();
        crate::adapter::hash_file(&path).unwrap()
    };
    let mut record = PendingSetupRecord {
        format_version: 1,
        id: Uuid::new_v4().to_string(),
        port_id: FIXTURE.into(),
        listing: service.catalog.listing(FIXTURE).unwrap().clone(),
        path: service.download_destination(&request).unwrap(),
        state: PendingSetupState::AttentionRequired,
        artifact: CatalogDownloadCandidate {
            release_id: 7.into(),
            asset_id: 11.into(),
            release_tag: "v1".into(),
            release_url: "https://github.com/owner/staged/releases/tag/v1".into(),
            name: "staged-game-windows-x64.zip".into(),
            size,
            download_url:
                "https://github.com/owner/staged/releases/download/v1/staged-game-windows-x64.zip"
                    .into(),
            sha256: Some(sha256.clone()),
            can_extract: true,
        },
        archive_sha256: String::new(),
        downloaded_at: String::new(),
        reason: Some("Package download is in progress.".into()),
        progress: None,
    };
    let preview = "c".repeat(64);
    let stage = tempfile::Builder::new()
        .prefix(".portcove-download-")
        .tempdir_in(&parent)
        .unwrap();
    service
        .insert_catalog_download(&record, stage.path(), &preview, &Uuid::new_v4().to_string())
        .unwrap();
    record.archive_sha256 = sha256.clone();
    record.downloaded_at = "2026-11-20T00:00:00Z".into();
    fs::create_dir(&record.path).unwrap();
    if extracted {
        fs::write(record.path.join("staged-game.dat"), b"extracted").unwrap();
        crate::durability::write_json_atomically(
            &record.path.join(RECEIPT_NAME),
            &PublicationReceipt {
                format_version: 1,
                pending_id: record.id.clone(),
                port_id: record.port_id.clone(),
                preview_sha256: preview,
                archive_sha256: sha256,
            },
            false,
        )
        .unwrap();
    } else {
        fs::write(record.path.join(&record.artifact.name), PACKAGE).unwrap();
    }
    record.state = PendingSetupState::Downloaded;
    record.reason = None;
    record.format_version = STAGED_RECORD_FORMAT;
    record.progress = Some(service.publication_progress(&record, extracted).unwrap());
    service
        .update_catalog_download(&record, "downloaded", true)
        .unwrap();
    Setup {
        _temporary: temporary,
        service,
        record,
        parent,
    }
}

fn reopened(service: &PortcoveService) -> PortcoveService {
    let mut reopened = PortcoveService::new(service.library.clone()).unwrap();
    reopened.catalog = service.catalog.clone();
    reopened
}

fn stage_of(service: &PortcoveService) -> PendingSetupStage {
    service.pending_setups().unwrap()[0]
        .progress
        .clone()
        .unwrap()
        .stage
}

fn advance(setup: &Setup, event: PendingSetupEvent) -> Result<PendingSetupResume> {
    setup
        .service
        .advance_pending_setup(FIXTURE, &setup.record.id, event)
}

/// The player's installed result, outside the setup folder as an upstream
/// installer often places it.
fn installed_program(setup: &Setup) -> (PathBuf, PathBuf) {
    let working = setup.parent.join("upstream-installed");
    fs::create_dir_all(&working).unwrap();
    let executable = crate::test_fixture::build_probe(&working);
    fs::write(working.join("player-save.dat"), b"mine").unwrap();
    (executable, working)
}

fn select(setup: &Setup, executable: &Path, working: &Path) -> Result<PendingSetupResume> {
    advance(
        setup,
        PendingSetupEvent::ResultSelected {
            executable: executable.into(),
            working_directory: working.into(),
            arguments: vec![],
        },
    )
}

fn invalidation(service: &PortcoveService) -> Option<PendingSetupInvalidation> {
    match stage_of(service) {
        PendingSetupStage::Invalidated { reason, .. } => Some(reason),
        _ => None,
    }
}

#[test]
fn each_stage_resumes_after_restart_without_repeating_work() {
    for extracted in [false, true] {
        let mut setup = published(extracted);
        let folder = setup.record.path.clone();
        let package_before = fs::read_dir(&folder).unwrap().count();
        // Artifact obtained: resume rechecks retained bytes; it never downloads.
        setup.service = reopened(&setup.service);
        let resumed = setup
            .service
            .resume_pending_setup(FIXTURE, &setup.record.id)
            .unwrap();
        assert_eq!(resumed.stage, PendingSetupStageKind::ArtifactObtained);
        assert!(!resumed.message.summary.is_empty() && !resumed.message.next_step.is_empty());

        // Upstream setup opened: Core records the handoff and when.
        let opened = setup
            .service
            .note_pending_setup_opened(FIXTURE, &setup.record.id, None)
            .unwrap()
            .unwrap();
        assert_eq!(opened.stage, PendingSetupStageKind::UpstreamSetupOpened);
        setup.service = reopened(&setup.service);
        assert!(matches!(
            setup
                .service
                .resume_pending_setup(FIXTURE, &setup.record.id)
                .unwrap()
                .record
                .progress
                .unwrap()
                .stage,
            PendingSetupStage::UpstreamSetupOpened {
                handoff: UpstreamSetupHandoff::Folder,
                ..
            }
        ));

        // Player action needed after the upstream setup closed.
        advance(
            &setup,
            PendingSetupEvent::UpstreamSetupExited { exit_code: Some(0) },
        )
        .unwrap();
        setup.service = reopened(&setup.service);
        assert_eq!(
            setup
                .service
                .resume_pending_setup(FIXTURE, &setup.record.id)
                .unwrap()
                .stage,
            PendingSetupStageKind::PlayerActionNeeded
        );

        // Final selected: Core checks the chosen program and records its identity.
        let (executable, working) = installed_program(&setup);
        let selected = select(&setup, &executable, &working).unwrap();
        let PendingSetupStage::FinalSelected { selection } =
            selected.record.progress.clone().unwrap().stage
        else {
            panic!("selection was not recorded");
        };
        assert_eq!(
            selection.executable_size,
            fs::metadata(&executable).unwrap().len()
        );
        setup.service = reopened(&setup.service);
        assert_eq!(
            setup
                .service
                .resume_pending_setup(FIXTURE, &setup.record.id)
                .unwrap()
                .stage,
            PendingSetupStageKind::FinalSelected
        );

        // Registration reviewed: the confirmed plan survives a restart.
        let preview = setup
            .service
            .preview_user_selected_runtime(FIXTURE, &executable, &working, &[])
            .unwrap();
        let authorization = setup
            .service
            .authorize_user_selected_runtime(
                FIXTURE,
                &executable,
                &working,
                &[],
                &preview.preview_sha256,
            )
            .unwrap();
        setup.service = reopened(&setup.service);
        let reviewed = setup
            .service
            .resume_pending_setup(FIXTURE, &setup.record.id)
            .unwrap();
        assert_eq!(reviewed.stage, PendingSetupStageKind::RegistrationReviewed);

        // Completing registration consumes exactly this record. Portcove owns
        // no installation or runtime replacement for the selected program.
        let registered = setup
            .service
            .register_user_selected_runtime(
                FIXTURE,
                &executable,
                &working,
                &[],
                &authorization.token,
            )
            .unwrap();
        assert!(registered.user_selected.is_some());
        assert_eq!(
            registered.setup_download.unwrap().download_sha256,
            setup.record.archive_sha256
        );
        assert!(setup.service.pending_setups().unwrap().is_empty());
        assert!(setup.service.library.all_installs().unwrap().is_empty());
        assert_eq!(fs::read(working.join("player-save.dat")).unwrap(), b"mine");
        assert_eq!(fs::read_dir(&folder).unwrap().count(), package_before);
        if !extracted {
            assert_eq!(
                fs::read(folder.join(&setup.record.artifact.name)).unwrap(),
                PACKAGE
            );
        }
    }
}

#[test]
fn zero_exit_from_upstream_setup_is_not_completion() {
    let setup = published(false);
    // Exit before any handoff is not a stage transition.
    assert!(
        advance(
            &setup,
            PendingSetupEvent::UpstreamSetupExited { exit_code: Some(0) }
        )
        .is_err()
    );
    assert_eq!(
        stage_of(&setup.service),
        PendingSetupStage::ArtifactObtained
    );
    setup
        .service
        .note_pending_setup_opened(FIXTURE, &setup.record.id, None)
        .unwrap();
    let closed = advance(
        &setup,
        PendingSetupEvent::UpstreamSetupExited { exit_code: Some(0) },
    )
    .unwrap();
    assert_eq!(closed.stage, PendingSetupStageKind::PlayerActionNeeded);
    assert_eq!(
        stage_of(&setup.service),
        PendingSetupStage::PlayerActionNeeded {
            action: PlayerSetupAction::ChooseInstalledGame,
            exit_code: Some(0),
        }
    );
    assert!(closed.message.summary.contains("hasn't checked"));
    // Registration still requires the player's selection and Core's review.
    assert_eq!(setup.service.pending_setups().unwrap().len(), 1);
    assert!(setup.service.library.all_installs().unwrap().is_empty());

    let failed = advance(
        &setup,
        PendingSetupEvent::UpstreamSetupExited { exit_code: Some(3) },
    )
    .unwrap();
    assert_eq!(
        stage_of(&setup.service),
        PendingSetupStage::PlayerActionNeeded {
            action: PlayerSetupAction::RetryUpstreamSetup,
            exit_code: Some(3),
        }
    );
    assert!(failed.message.summary.contains("exit code 3"));
}

#[test]
fn guide_handoff_records_only_the_retained_setup_guide() {
    let setup = published(false);
    // A release page is not setup and changes no stage.
    assert!(
        setup
            .service
            .note_pending_setup_opened(
                FIXTURE,
                &setup.record.id,
                Some("https://github.com/owner/staged/releases/tag/v1"),
            )
            .unwrap()
            .is_none()
    );
    assert_eq!(
        stage_of(&setup.service),
        PendingSetupStage::ArtifactObtained
    );
    assert!(
        advance(
            &setup,
            PendingSetupEvent::UpstreamSetupOpened {
                handoff: UpstreamSetupHandoff::Guide {
                    url: "https://example.com/other".into()
                },
            },
        )
        .is_err()
    );
    let opened = setup
        .service
        .note_pending_setup_opened(
            FIXTURE,
            &setup.record.id,
            Some("https://example.com/staged/setup-guide"),
        )
        .unwrap()
        .unwrap();
    assert!(matches!(
        opened.record.progress.unwrap().stage,
        PendingSetupStage::UpstreamSetupOpened {
            handoff: UpstreamSetupHandoff::Guide { .. },
            ..
        }
    ));
}

#[test]
fn an_interrupted_stage_write_reads_as_one_of_the_adjacent_stages() {
    for (fault, expect_new) in [
        (fault::StageWriteFault::BeforeCommit, false),
        (fault::StageWriteFault::AfterCommit, true),
    ] {
        let setup = published(false);
        fault::set(Some(fault));
        assert!(
            setup
                .service
                .note_pending_setup_opened(FIXTURE, &setup.record.id, None)
                .is_err()
        );
        fault::set(None);
        // A restart reads the whole earlier or whole later record.
        let reopened = reopened(&setup.service);
        let stage = stage_of(&reopened);
        if expect_new {
            assert_eq!(stage.kind(), PendingSetupStageKind::UpstreamSetupOpened);
        } else {
            assert_eq!(stage, PendingSetupStage::ArtifactObtained);
        }
        // Either way the setup resumes and can continue.
        reopened
            .resume_pending_setup(FIXTURE, &setup.record.id)
            .unwrap();
        reopened
            .advance_pending_setup(
                FIXTURE,
                &setup.record.id,
                PendingSetupEvent::PlayerActionNeeded {
                    action: PlayerSetupAction::FinishUpstreamSetup,
                },
            )
            .unwrap();
    }
}

fn raw_row(service: &PortcoveService) -> String {
    service
        .library
        .connection()
        .unwrap()
        .query_row("SELECT record_json FROM catalog_downloads", [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn replace_row(service: &PortcoveService, json: &str) {
    service
        .library
        .connection()
        .unwrap()
        .execute("UPDATE catalog_downloads SET record_json=?1", [json])
        .unwrap();
}

#[test]
fn earlier_records_map_to_their_stage_and_bind_when_the_player_continues() {
    let setup = published(false);
    // The record format the current release writes before stages existed.
    let mut legacy = setup.record.clone();
    legacy.format_version = 1;
    legacy.progress = None;
    let legacy_json = serde_json::to_string(&legacy).unwrap();
    assert!(!legacy_json.contains("progress") && !legacy_json.contains("format_version"));
    replace_row(&setup.service, &legacy_json);

    let read = setup.service.pending_setups().unwrap().pop().unwrap();
    assert_eq!(
        read.stage_kind(),
        Some(PendingSetupStageKind::ArtifactObtained)
    );
    assert!(read.progress.as_ref().unwrap().binding.is_none());
    // Reading never rewrites the earlier record.
    assert_eq!(raw_row(&setup.service), legacy_json);

    // An unfinished earlier download has no setup stage.
    let mut attention = legacy.clone();
    attention.state = PendingSetupState::AttentionRequired;
    replace_row(&setup.service, &serde_json::to_string(&attention).unwrap());
    assert_eq!(
        setup.service.pending_setups().unwrap()[0].stage_kind(),
        None
    );
    assert!(
        setup
            .service
            .resume_pending_setup(FIXTURE, &setup.record.id)
            .is_err()
    );

    replace_row(&setup.service, &legacy_json);
    let resumed = setup
        .service
        .resume_pending_setup(FIXTURE, &setup.record.id)
        .unwrap();
    assert_eq!(resumed.stage, PendingSetupStageKind::ArtifactObtained);
    let stored: serde_json::Value = serde_json::from_str(&raw_row(&setup.service)).unwrap();
    assert_eq!(stored["format_version"], 3);
    assert_eq!(stored["progress"]["binding"]["retained"]["kind"], "package");
    assert_eq!(
        stored["progress"]["binding"]["source_url"],
        "https://github.com/owner/staged/releases"
    );
}

/// The pending setup record exactly as the previous release reads it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct PreviousReleaseRecord {
    #[serde(default = "previous_format")]
    format_version: u8,
    id: String,
    port_id: String,
    listing: serde_json::Value,
    path: PathBuf,
    state: PendingSetupState,
    artifact: serde_json::Value,
    archive_sha256: String,
    downloaded_at: String,
    reason: Option<String>,
}

fn previous_format() -> u8 {
    1
}

#[test]
fn record_readers_refuse_newer_formats_without_changing_them() {
    let setup = published(false);
    let staged = raw_row(&setup.service);
    // The previous release rejects the stage field outright and accepts only
    // formats 1 and 2, so it refuses this record before recovery or mutation.
    assert!(serde_json::from_str::<PreviousReleaseRecord>(&staged).is_err());
    let mut without_stage: serde_json::Value = serde_json::from_str(&staged).unwrap();
    without_stage.as_object_mut().unwrap().remove("progress");
    let previous: PreviousReleaseRecord = serde_json::from_value(without_stage).unwrap();
    assert!(!matches!(previous.format_version, 1 | 2));

    // This release refuses a future format the same way, keeping the row.
    let mut future: serde_json::Value = serde_json::from_str(&staged).unwrap();
    future["format_version"] = json!(4);
    let future = future.to_string();
    replace_row(&setup.service, &future);
    assert!(setup.service.pending_setups().is_err());
    assert!(
        setup
            .service
            .resume_pending_setup(FIXTURE, &setup.record.id)
            .is_err()
    );
    // Startup recovery refuses the unknown row too, as for format 2 before it.
    assert!(PortcoveService::new(setup.service.library.clone()).is_err());
    assert_eq!(raw_row(&setup.service), future);

    // A stage without its binding, or on an unfinished download, is refused.
    let mut unbound: serde_json::Value = serde_json::from_str(&staged).unwrap();
    unbound["progress"]
        .as_object_mut()
        .unwrap()
        .remove("binding");
    replace_row(&setup.service, &unbound.to_string());
    assert!(setup.service.pending_setups().is_err());
    let mut unfinished: serde_json::Value = serde_json::from_str(&staged).unwrap();
    unfinished["state"] = json!("attention-required");
    replace_row(&setup.service, &unfinished.to_string());
    assert!(setup.service.pending_setups().is_err());
    replace_row(&setup.service, &staged);
    assert_eq!(setup.service.pending_setups().unwrap().len(), 1);
}

type Step<'a> = Box<dyn Fn(&Setup) + 'a>;

#[test]
fn cancelling_at_any_stage_keeps_a_resumable_or_cleanly_forgotten_setup() {
    for stop_at in 0..5 {
        let setup = published(false);
        let (executable, working) = installed_program(&setup);
        let steps: Vec<Step<'_>> = vec![
            Box::new(|_| {}),
            Box::new(|setup| {
                setup
                    .service
                    .note_pending_setup_opened(FIXTURE, &setup.record.id, None)
                    .unwrap();
            }),
            Box::new(|setup| {
                advance(
                    setup,
                    PendingSetupEvent::UpstreamSetupExited { exit_code: None },
                )
                .unwrap();
            }),
            Box::new(|setup| {
                select(setup, &executable, &working).unwrap();
            }),
            Box::new(|setup| {
                let preview = setup
                    .service
                    .preview_user_selected_runtime(FIXTURE, &executable, &working, &[])
                    .unwrap();
                setup
                    .service
                    .authorize_user_selected_runtime(
                        FIXTURE,
                        &executable,
                        &working,
                        &[],
                        &preview.preview_sha256,
                    )
                    .unwrap();
            }),
        ];
        for step in &steps[..=stop_at] {
            step(&setup);
        }
        let before = stage_of(&setup.service);
        // A refused step, such as choosing a missing program, keeps the stage.
        assert!(select(&setup, &working.join("missing.exe"), &working).is_err());
        assert_eq!(stage_of(&setup.service), before);
        // Forgetting removes only bookkeeping; every player file stays.
        setup
            .service
            .forget_pending_setup(FIXTURE, &setup.record.id)
            .unwrap();
        assert!(setup.service.pending_setups().unwrap().is_empty());
        assert_eq!(
            fs::read(setup.record.path.join(&setup.record.artifact.name)).unwrap(),
            PACKAGE
        );
        assert!(executable.is_file());
        assert_eq!(fs::read(working.join("player-save.dat")).unwrap(), b"mine");
    }
}

fn assert_invalidated(setup: &Setup, expected: PendingSetupInvalidation) {
    let resumed = setup
        .service
        .resume_pending_setup(FIXTURE, &setup.record.id)
        .unwrap();
    assert_eq!(resumed.stage, PendingSetupStageKind::Invalidated);
    assert_eq!(invalidation(&setup.service), Some(expected.clone()));
    assert!(!resumed.message.summary.is_empty() && !resumed.message.next_step.is_empty());
    // An invalidated stage never silently continues.
    let error = advance(
        setup,
        PendingSetupEvent::PlayerActionNeeded {
            action: PlayerSetupAction::FinishUpstreamSetup,
        },
    )
    .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    let kind = serde_json::to_value(&expected).unwrap()["kind"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(error.details.get("invalidation"), Some(&kind));
    // The setup can still be forgotten without touching player files.
    setup
        .service
        .forget_pending_setup(FIXTURE, &setup.record.id)
        .unwrap();
    assert!(setup.record.path.is_dir());
}

#[test]
fn a_changed_source_invalidates_the_stage() {
    let mut setup = published(false);
    set_listing(&mut setup.service, |listing| {
        listing["project_url"] = json!("https://github.com/another/staged");
        listing["release_url"] = json!("https://github.com/another/staged/releases");
    });
    assert_invalidated(
        &setup,
        PendingSetupInvalidation::SourceChanged {
            current_source_url: "https://github.com/another/staged/releases".into(),
        },
    );
}

#[test]
fn a_changed_definition_invalidates_the_stage() {
    let mut setup = published(false);
    let platform = Platform::current().unwrap();
    let platform_key = serde_json::to_value(platform)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let document = json!({
    "schema_version":1,"source_profiles":[],"ports":[{
        "id":FIXTURE,"name":"Staged setup fixture","summary":"Synthetic definition only",
        "project_url":"https://github.com/owner/staged","support_tier":"beta","channels":["stable"],
        "platforms":[platform],"adapter":"staged-source-portable",
        "release":{"provider":"user-prepared","user_prepared":{
            (platform_key):{"trust":"user-selected","version":"user-managed","archive_name":"","archive_size":0,"archive_sha256":"","immutable_tree_sha256":"","executable":"","mutable_paths":[]}
        }}
    }]});
    setup.service.catalog = Catalog::from_json(&document.to_string())
        .unwrap()
        .with_listing_document(listing_document(|_| {}))
        .unwrap();
    assert_invalidated(&setup, PendingSetupInvalidation::DefinitionChanged);
}

#[test]
fn a_restriction_that_now_holds_invalidates_the_stage() {
    let mut setup = published(false);
    set_listing(&mut setup.service, |listing| {
        listing["download_block_reason"] = json!("Upstream withdrew this package.");
    });
    let resumed = setup
        .service
        .resume_pending_setup(FIXTURE, &setup.record.id)
        .unwrap();
    assert_eq!(resumed.stage, PendingSetupStageKind::Invalidated);
    let Some(PendingSetupInvalidation::RestrictionHolds { explanation }) =
        invalidation(&setup.service)
    else {
        panic!("restriction did not invalidate");
    };
    assert!(explanation.contains("Upstream withdrew this package."));
    assert!(resumed.message.summary.contains(&explanation));
}

#[test]
fn a_newer_reviewed_release_invalidates_the_stage() {
    let mut setup = published(false);
    let platform = Platform::current().unwrap();
    set_listing(&mut setup.service, |listing| {
        listing["release_maintenance"] = json!({
            "reason": "Reviewed direct contract", "reconsider_when": "A newer release is reviewed",
            "pinned_releases": [{"platform": platform, "version": "v2", "published_at": null}]
        });
    });
    assert_invalidated(
        &setup,
        PendingSetupInvalidation::ReleaseSuperseded {
            current_release_tag: "v2".into(),
        },
    );
    // A pin naming the downloaded release keeps the stage.
    let mut setup = published(false);
    set_listing(&mut setup.service, |listing| {
        listing["release_maintenance"] = json!({
            "reason": "Reviewed direct contract", "reconsider_when": "A newer release is reviewed",
            "pinned_releases": [{"platform": platform, "version": "v1", "published_at": null}]
        });
    });
    assert_eq!(
        setup
            .service
            .resume_pending_setup(FIXTURE, &setup.record.id)
            .unwrap()
            .stage,
        PendingSetupStageKind::ArtifactObtained
    );
}

#[test]
fn a_changed_artifact_role_invalidates_the_stage() {
    let setup = published(false);
    // The typed route fact recorded at binding differs from the current one,
    // as when an earlier classifier or reviewed observation applied.
    let mut stored: serde_json::Value = serde_json::from_str(&raw_row(&setup.service)).unwrap();
    assert_eq!(
        stored["progress"]["binding"]["artifact_role"],
        "desktop-game-runtime"
    );
    stored["progress"]["binding"]["artifact_role"] = json!("installer");
    replace_row(&setup.service, &stored.to_string());
    assert_invalidated(
        &setup,
        PendingSetupInvalidation::ArtifactRoleChanged {
            current_role: ArtifactRole::DesktopGameRuntime,
        },
    );
}

#[test]
fn changed_or_missing_retained_bytes_invalidate_instead_of_downloading_again() {
    let setup = published(false);
    fs::write(
        setup.record.path.join(&setup.record.artifact.name),
        b"changed",
    )
    .unwrap();
    assert_invalidated(&setup, PendingSetupInvalidation::RetainedBytesChanged);

    let setup = published(true);
    fs::remove_file(setup.record.path.join(RECEIPT_NAME)).unwrap();
    assert_invalidated(&setup, PendingSetupInvalidation::RetainedBytesChanged);
}

#[test]
fn a_changed_chosen_program_can_be_chosen_again() {
    let setup = published(false);
    let (executable, working) = installed_program(&setup);
    select(&setup, &executable, &working).unwrap();
    let mut bytes = fs::read(&executable).unwrap();
    bytes.extend_from_slice(b"upstream update");
    fs::write(&executable, &bytes).unwrap();
    let resumed = setup
        .service
        .resume_pending_setup(FIXTURE, &setup.record.id)
        .unwrap();
    assert_eq!(
        invalidation(&setup.service),
        Some(PendingSetupInvalidation::SelectedResultChanged)
    );
    assert_eq!(
        resumed.message.next_step,
        "Choose the installed game program again."
    );
    // Registration of the earlier plan is refused until a new choice.
    assert!(
        advance(
            &setup,
            PendingSetupEvent::UpstreamSetupExited { exit_code: Some(0) }
        )
        .is_err()
    );
    let (replacement, replacement_working) = {
        let working = setup.parent.join("upstream-reinstalled");
        fs::create_dir(&working).unwrap();
        (crate::test_fixture::build_probe(&working), working)
    };
    let selected = select(&setup, &replacement, &replacement_working).unwrap();
    assert_eq!(selected.stage, PendingSetupStageKind::FinalSelected);
}

#[test]
fn an_invalidated_setup_cannot_complete_registration() {
    let mut setup = published(false);
    let (executable, working) = installed_program(&setup);
    select(&setup, &executable, &working).unwrap();
    let preview = setup
        .service
        .preview_user_selected_runtime(FIXTURE, &executable, &working, &[])
        .unwrap();
    let authorization = setup
        .service
        .authorize_user_selected_runtime(
            FIXTURE,
            &executable,
            &working,
            &[],
            &preview.preview_sha256,
        )
        .unwrap();
    set_listing(&mut setup.service, |listing| {
        listing["download_block_reason"] = json!("Upstream withdrew this package.");
    });
    let error = setup
        .service
        .register_user_selected_runtime(FIXTURE, &executable, &working, &[], &authorization.token)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert_eq!(
        error.details.get("invalidation").map(String::as_str),
        Some("restriction-holds")
    );
    assert_eq!(setup.service.pending_setups().unwrap().len(), 1);
    assert!(
        setup
            .service
            .library
            .external_runtime_with_port(FIXTURE)
            .unwrap()
            .is_none()
    );
    assert!(
        setup
            .service
            .authorize_user_selected_runtime(
                FIXTURE,
                &executable,
                &working,
                &[],
                &preview.preview_sha256
            )
            .is_err()
    );
}

#[test]
fn stage_changes_respect_the_port_lock() {
    let setup = published(false);
    let _held = setup
        .service
        .library
        .try_lock_port(FIXTURE, "test-holder")
        .unwrap();
    let error = setup
        .service
        .note_pending_setup_opened(FIXTURE, &setup.record.id, None)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert!(
        setup
            .service
            .resume_pending_setup(FIXTURE, &setup.record.id)
            .is_err()
    );
    assert_eq!(
        stage_of(&setup.service),
        PendingSetupStage::ArtifactObtained
    );
}

#[test]
fn capability_report_shows_cores_stage_message() {
    let setup = published(false);
    setup
        .service
        .note_pending_setup_opened(FIXTURE, &setup.record.id, None)
        .unwrap();
    let report = setup.service.port_capabilities(FIXTURE).unwrap();
    assert_eq!(
        report.pending_setup_stage,
        Some(PendingSetupStageKind::UpstreamSetupOpened)
    );
    let setup_feature = report
        .routes
        .iter()
        .find(|route| route.route == "upstream-setup")
        .unwrap()
        .features
        .first()
        .unwrap();
    assert_eq!(setup_feature.explanation, "You opened the setup folder.");
    assert_eq!(
        setup_feature.next_step,
        "Finish the upstream setup steps. Then choose the installed game program."
    );
}

#[test]
fn every_stage_and_invalidation_has_a_player_message() {
    let selection = SelectedSetupResult {
        executable: PathBuf::from("game.exe"),
        working_directory: PathBuf::new(),
        arguments: vec![],
        executable_sha256: "a".repeat(64),
        executable_size: 1,
        version: "user-managed".into(),
        selected_at: "2026-11-20T00:00:00Z".into(),
    };
    let mut stages = vec![
        PendingSetupStage::ArtifactObtained,
        PendingSetupStage::UpstreamSetupOpened {
            handoff: UpstreamSetupHandoff::Folder,
            opened_at: "2026-11-20T00:00:00Z".into(),
        },
        PendingSetupStage::FinalSelected {
            selection: selection.clone(),
        },
        PendingSetupStage::RegistrationReviewed {
            selection,
            preview_sha256: "b".repeat(64),
        },
    ];
    for action in [
        PlayerSetupAction::FinishUpstreamSetup,
        PlayerSetupAction::ChooseInstalledGame,
        PlayerSetupAction::RetryUpstreamSetup,
    ] {
        stages.push(PendingSetupStage::PlayerActionNeeded {
            action,
            exit_code: None,
        });
    }
    for reason in [
        PendingSetupInvalidation::SourceChanged {
            current_source_url: "https://example.com".into(),
        },
        PendingSetupInvalidation::DefinitionChanged,
        PendingSetupInvalidation::ReleaseSuperseded {
            current_release_tag: "v2".into(),
        },
        PendingSetupInvalidation::RestrictionHolds {
            explanation: "Held.".into(),
        },
        PendingSetupInvalidation::ArtifactRoleChanged {
            current_role: ArtifactRole::Installer,
        },
        PendingSetupInvalidation::RetainedBytesChanged,
        PendingSetupInvalidation::SelectedResultChanged,
    ] {
        stages.push(PendingSetupStage::Invalidated {
            previous: PendingSetupStageKind::ArtifactObtained,
            reason,
        });
    }
    for stage in stages {
        let message = pending_setup_message(&stage, Some(ArtifactRole::Installer));
        for text in [&message.summary, &message.next_step] {
            assert!(text.ends_with('.'), "{text}");
            assert!(text.split_whitespace().count() <= 25, "{text}");
        }
    }
}
