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

/// A finished download exactly as publication stores it: format 1 with no
/// stage, and a fresh user-owned folder holding either the unextracted
/// package or extracted files and a receipt.
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

fn open(setup: &Setup) -> Result<Option<PendingSetupStageKind>> {
    setup
        .service
        .note_pending_setup_opened(FIXTURE, &setup.record.id, None)
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

fn select(
    setup: &Setup,
    executable: &Path,
    working: &Path,
) -> Result<crate::ExternalRuntimePreview> {
    setup
        .service
        .choose_user_selected_runtime(FIXTURE, executable, working, &[])
}

fn review(setup: &Setup, executable: &Path, working: &Path) -> crate::DestructiveAuthorization {
    let preview = setup
        .service
        .preview_user_selected_runtime(FIXTURE, executable, working, &[])
        .unwrap();
    setup
        .service
        .authorize_user_selected_runtime(FIXTURE, executable, working, &[], &preview.preview_sha256)
        .unwrap()
}

fn invalidation(service: &PortcoveService) -> Option<PendingSetupInvalidation> {
    match stage_of(service) {
        PendingSetupStage::Invalidated { reason, .. } => Some(reason),
        _ => None,
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

/// The pending setup record exactly as the released reader parses it: the
/// same field set under `deny_unknown_fields`, with the nested listing and
/// artifact left opaque.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct ReleasedRecord {
    #[serde(default = "released_default_format")]
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

fn released_default_format() -> u8 {
    1
}

/// The released reader's parse and format check: GitHub records are format
/// 1, GitLab records format 2, and nothing else is accepted.
fn released_reader_accepts(json: &str) -> bool {
    let Ok(record) = serde_json::from_str::<ReleasedRecord>(json) else {
        return false;
    };
    let github = record.artifact["release_id"].is_u64();
    record.format_version == if github { 1 } else { 2 }
}

#[test]
fn each_stage_resumes_after_restart_without_repeating_work() {
    for extracted in [false, true] {
        let mut setup = published(extracted);
        let folder = setup.record.path.clone();
        let package_before = fs::read_dir(&folder).unwrap().count();
        // Artifact obtained: the stage a reader maps from the stored record.
        setup.service = reopened(&setup.service);
        assert_eq!(
            stage_of(&setup.service),
            PendingSetupStage::ArtifactObtained
        );

        // Upstream setup opened: Core records the handoff and when.
        assert_eq!(
            open(&setup).unwrap(),
            Some(PendingSetupStageKind::UpstreamSetupOpened)
        );
        setup.service = reopened(&setup.service);
        assert!(matches!(
            stage_of(&setup.service),
            PendingSetupStage::UpstreamSetupOpened {
                handoff: UpstreamSetupHandoff::Folder,
                ..
            }
        ));

        // Final selected: Core checks the chosen program and records its identity.
        let (executable, working) = installed_program(&setup);
        select(&setup, &executable, &working).unwrap();
        let PendingSetupStage::FinalSelected { selection } = stage_of(&setup.service) else {
            panic!("selection was not recorded");
        };
        assert_eq!(
            selection.executable_size,
            fs::metadata(&executable).unwrap().len()
        );
        setup.service = reopened(&setup.service);
        assert_eq!(
            stage_of(&setup.service).kind(),
            PendingSetupStageKind::FinalSelected
        );

        // Registration reviewed: the confirmed plan survives a restart.
        let authorization = review(&setup, &executable, &working);
        setup.service = reopened(&setup.service);
        assert_eq!(
            stage_of(&setup.service).kind(),
            PendingSetupStageKind::RegistrationReviewed
        );
        // Choosing the same program again keeps the reviewed plan.
        select(&setup, &executable, &working).unwrap();
        assert_eq!(
            stage_of(&setup.service).kind(),
            PendingSetupStageKind::RegistrationReviewed
        );

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
fn a_fresh_download_stays_readable_by_the_released_reader_until_a_stage_change() {
    let setup = published(false);
    let stored = raw_row(&setup.service);
    assert!(released_reader_accepts(&stored), "{stored}");
    assert!(!stored.contains("progress") && !stored.contains("format_version"));
    // Reading the mapped stage never writes it back.
    setup.service.pending_setups().unwrap();
    setup.service.port_capabilities(FIXTURE).unwrap();
    assert_eq!(raw_row(&setup.service), stored);
    // Startup recovery keeps it unchanged too.
    reopened(&setup.service);
    assert_eq!(raw_row(&setup.service), stored);

    // Opening the setup folder is the first stage change; it writes format 3,
    // which the released reader refuses.
    open(&setup).unwrap();
    let staged = raw_row(&setup.service);
    let value: serde_json::Value = serde_json::from_str(&staged).unwrap();
    assert_eq!(value["format_version"], 3);
    assert_eq!(value["progress"]["stage"]["stage"], "upstream-setup-opened");
    assert_eq!(value["progress"]["binding"]["retained"]["kind"], "package");
    assert_eq!(
        value["progress"]["binding"]["source_url"],
        "https://github.com/owner/staged/releases"
    );
    assert!(!released_reader_accepts(&staged));

    // Forgetting the setup removes the only format 3 row.
    setup
        .service
        .forget_pending_setup(FIXTURE, &setup.record.id)
        .unwrap();
    assert!(setup.service.pending_setups().unwrap().is_empty());
}

#[test]
fn guide_handoff_records_only_the_retained_setup_guide() {
    let setup = published(false);
    let stored = raw_row(&setup.service);
    // A release page is not setup and changes nothing.
    assert_eq!(
        setup
            .service
            .note_pending_setup_opened(
                FIXTURE,
                &setup.record.id,
                Some("https://github.com/owner/staged/releases/tag/v1"),
            )
            .unwrap(),
        None
    );
    assert_eq!(raw_row(&setup.service), stored);
    setup
        .service
        .note_pending_setup_opened(
            FIXTURE,
            &setup.record.id,
            Some("https://example.com/staged/setup-guide"),
        )
        .unwrap()
        .unwrap();
    assert!(matches!(
        stage_of(&setup.service),
        PendingSetupStage::UpstreamSetupOpened {
            handoff: UpstreamSetupHandoff::Guide { .. },
            ..
        }
    ));
}

#[test]
fn opening_records_the_handoff_without_reading_the_package() {
    let setup = published(false);
    // Same size, different bytes: only a digest check can see the change.
    let package = setup.record.path.join(&setup.record.artifact.name);
    let mut changed = PACKAGE.to_vec();
    changed[0] ^= 0xff;
    fs::write(&package, &changed).unwrap();
    assert_eq!(
        open(&setup).unwrap(),
        Some(PendingSetupStageKind::UpstreamSetupOpened)
    );
    // Choosing and reviewing check presence and size, not the digest.
    let (executable, working) = installed_program(&setup);
    select(&setup, &executable, &working).unwrap();
    let authorization = review(&setup, &executable, &working);
    // Registration verifies the digest and refuses the changed package.
    let error = setup
        .service
        .register_user_selected_runtime(FIXTURE, &executable, &working, &[], &authorization.token)
        .unwrap_err();
    assert_eq!(
        error.details.get("invalidation").map(String::as_str),
        Some("retained-bytes-changed")
    );
    assert_eq!(
        invalidation(&setup.service),
        Some(PendingSetupInvalidation::RetainedBytesChanged)
    );
}

#[test]
fn opening_again_keeps_a_chosen_program_and_an_invalidated_stage() {
    let mut setup = published(false);
    let (executable, working) = installed_program(&setup);
    select(&setup, &executable, &working).unwrap();
    let chosen = raw_row(&setup.service);
    assert_eq!(
        open(&setup).unwrap(),
        Some(PendingSetupStageKind::FinalSelected)
    );
    assert_eq!(raw_row(&setup.service), chosen);

    set_listing(&mut setup.service, |listing| {
        listing["download_block_reason"] = json!("Upstream withdrew this package.");
    });
    assert!(select(&setup, &executable, &working).is_err());
    let invalidated = raw_row(&setup.service);
    assert_eq!(
        open(&setup).unwrap(),
        Some(PendingSetupStageKind::Invalidated)
    );
    assert_eq!(raw_row(&setup.service), invalidated);
}

#[test]
fn an_interrupted_stage_write_reads_as_one_of_the_adjacent_stages() {
    for (fault, expect_new) in [
        (fault::StageWriteFault::BeforeCommit, false),
        (fault::StageWriteFault::AfterCommit, true),
    ] {
        let setup = published(false);
        fault::set(Some(fault));
        assert!(open(&setup).is_err());
        fault::set(None);
        // A restart reads the whole earlier or whole later record.
        let reopened = reopened(&setup.service);
        let stage = stage_of(&reopened);
        if expect_new {
            assert_eq!(stage.kind(), PendingSetupStageKind::UpstreamSetupOpened);
        } else {
            assert_eq!(stage, PendingSetupStage::ArtifactObtained);
            assert!(released_reader_accepts(&raw_row(&reopened)));
        }
        // Either way the setup can continue.
        let (executable, working) = installed_program(&setup);
        reopened
            .choose_user_selected_runtime(FIXTURE, &executable, &working, &[])
            .unwrap();
        assert_eq!(
            stage_of(&reopened).kind(),
            PendingSetupStageKind::FinalSelected
        );
    }
}

#[test]
fn an_unfinished_download_has_no_stage_and_changes_nothing() {
    let setup = published(false);
    let mut attention: serde_json::Value = serde_json::from_str(&raw_row(&setup.service)).unwrap();
    attention["state"] = json!("attention-required");
    let attention = attention.to_string();
    replace_row(&setup.service, &attention);
    assert_eq!(
        setup.service.pending_setups().unwrap()[0].stage_kind(),
        None
    );
    assert_eq!(open(&setup).unwrap(), None);
    assert_eq!(raw_row(&setup.service), attention);
}

#[test]
fn record_readers_refuse_unknown_or_malformed_stages_without_changing_them() {
    let setup = published(false);
    open(&setup).unwrap();
    let staged = raw_row(&setup.service);

    // This release refuses a future format the same way, keeping the row.
    let mut future: serde_json::Value = serde_json::from_str(&staged).unwrap();
    future["format_version"] = json!(4);
    let future = future.to_string();
    replace_row(&setup.service, &future);
    assert!(setup.service.pending_setups().is_err());
    assert!(open(&setup).is_err());
    // Startup recovery refuses the unknown row too, as for format 2 before it.
    assert!(PortcoveService::new(setup.service.library.clone()).is_err());
    assert_eq!(raw_row(&setup.service), future);

    // A stage without its binding, a stored `artifact-obtained`, a removed
    // stage name, or a stage on an unfinished download is refused.
    let edits: [&dyn Fn(&mut serde_json::Value); 4] = [
        &|value| {
            value["progress"].as_object_mut().unwrap().remove("binding");
        },
        &|value| value["progress"]["stage"] = json!({"stage": "artifact-obtained"}),
        &|value| {
            value["progress"]["stage"] = json!({
                "stage": "player-action-needed", "action": "finish-upstream-setup"
            })
        },
        &|value| value["state"] = json!("attention-required"),
    ];
    for edit in edits {
        let mut value: serde_json::Value = serde_json::from_str(&staged).unwrap();
        edit(&mut value);
        replace_row(&setup.service, &value.to_string());
        assert!(setup.service.pending_setups().is_err(), "{value}");
    }
    replace_row(&setup.service, &staged);
    assert_eq!(setup.service.pending_setups().unwrap().len(), 1);
}

type Step<'a> = Box<dyn Fn(&Setup) + 'a>;

#[test]
fn cancelling_at_any_stage_keeps_a_resumable_or_cleanly_forgotten_setup() {
    for stop_at in 0..4 {
        let setup = published(false);
        let (executable, working) = installed_program(&setup);
        let steps: Vec<Step<'_>> = vec![
            Box::new(|_| {}),
            Box::new(|setup| {
                open(setup).unwrap();
            }),
            Box::new(|setup| {
                select(setup, &executable, &working).unwrap();
            }),
            Box::new(|setup| {
                review(setup, &executable, &working);
            }),
        ];
        for step in &steps[..=stop_at] {
            step(&setup);
        }
        let before = raw_row(&setup.service);
        // A refused step, such as choosing a missing program, keeps the stage.
        assert!(select(&setup, &working.join("missing.exe"), &working).is_err());
        assert_eq!(raw_row(&setup.service), before);
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

/// Continue the setup by choosing a program and expect the given invalidation.
fn assert_invalidated(setup: &Setup, expected: PendingSetupInvalidation) {
    let (executable, working) = installed_program(setup);
    let error = select(setup, &executable, &working).unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    let kind = serde_json::to_value(&expected).unwrap()["kind"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(error.details.get("invalidation"), Some(&kind));
    assert_eq!(invalidation(&setup.service), Some(expected.clone()));
    // An invalidated stage never silently continues, and the capability
    // report shows Core's explanation.
    assert!(select(setup, &executable, &working).is_err());
    let report = setup.service.port_capabilities(FIXTURE).unwrap();
    assert_eq!(
        report.pending_setup_stage,
        Some(PendingSetupStageKind::Invalidated)
    );
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
    open(&setup).unwrap();
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

fn fixture_definition(edit: impl FnOnce(&mut serde_json::Value)) -> Catalog {
    let platform = Platform::current().unwrap();
    let platform_key = serde_json::to_value(platform)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let mut document = json!({
    "schema_version":1,"source_profiles":[],"ports":[{
        "id":FIXTURE,"name":"Staged setup fixture","summary":"Synthetic definition only",
        "project_url":"https://github.com/owner/staged","support_tier":"beta","channels":["stable"],
        "platforms":[platform],"adapter":"staged-source-portable",
        "release":{"provider":"user-prepared","user_prepared":{
            (platform_key):{"trust":"user-selected","version":"user-managed","archive_name":"","archive_size":0,"archive_sha256":"","immutable_tree_sha256":"","executable":"","mutable_paths":[]}
        }}
    }]});
    edit(&mut document["ports"][0]);
    Catalog::from_json(&document.to_string())
        .unwrap()
        .with_listing_document(listing_document(|_| {}))
        .unwrap()
}

#[test]
fn a_changed_definition_invalidates_the_stage() {
    let mut setup = published(false);
    open(&setup).unwrap();
    setup.service.catalog = fixture_definition(|_| {});
    assert_invalidated(&setup, PendingSetupInvalidation::DefinitionChanged);
}

#[test]
fn an_unchanged_definition_keeps_its_binding_across_application_changes() {
    // The binding covers the documented setup fields, not this application's
    // serialization of the whole definition.
    let catalog = fixture_definition(|_| {});
    let port = catalog.port(FIXTURE).unwrap().clone();
    let mut reserialized = port.clone();
    // A defaulted field that a later application serializes, as when a new
    // version adds a serialized definition field.
    reserialized.n64_windows_initial_d3d12 = true;
    reserialized.summary = "Presentation text a later catalog revision rewords".into();
    assert_ne!(
        serde_json::to_value(&port).unwrap(),
        serde_json::to_value(&reserialized).unwrap()
    );
    assert_eq!(
        setup_definition_sha256(None, Some(&port)).unwrap(),
        setup_definition_sha256(None, Some(&reserialized)).unwrap()
    );
    // A setup-relevant field still changes it.
    let mut moved = port.clone();
    moved.release.repository = "another/staged".into();
    assert_ne!(
        setup_definition_sha256(None, Some(&port)).unwrap(),
        setup_definition_sha256(None, Some(&moved)).unwrap()
    );
    // A retained signed entry is bound by its own bytes alone.
    let entry = Some("e".repeat(64));
    assert_eq!(
        setup_definition_sha256(entry.clone(), Some(&port)).unwrap(),
        setup_definition_sha256(entry.clone(), Some(&moved)).unwrap()
    );
    assert_ne!(
        setup_definition_sha256(entry, Some(&port)).unwrap(),
        setup_definition_sha256(Some("f".repeat(64)), Some(&port)).unwrap()
    );

    // Through the service: an unchanged definition keeps a bound stage.
    let mut setup = published(false);
    setup.service.catalog = fixture_definition(|_| {});
    open(&setup).unwrap();
    setup.service.catalog = fixture_definition(|port| {
        port["summary"] = json!("Reworded synthetic definition");
    });
    let (executable, working) = installed_program(&setup);
    select(&setup, &executable, &working).unwrap();
    assert_eq!(
        stage_of(&setup.service).kind(),
        PendingSetupStageKind::FinalSelected
    );
}

#[test]
fn a_restriction_that_now_holds_invalidates_the_stage() {
    let mut setup = published(false);
    open(&setup).unwrap();
    set_listing(&mut setup.service, |listing| {
        listing["download_block_reason"] = json!("Upstream withdrew this package.");
    });
    let (executable, working) = installed_program(&setup);
    let error = select(&setup, &executable, &working).unwrap_err();
    let Some(PendingSetupInvalidation::RestrictionHolds { explanation }) =
        invalidation(&setup.service)
    else {
        panic!("restriction did not invalidate");
    };
    assert!(explanation.contains("Upstream withdrew this package."));
    assert!(error.message.contains(&explanation));
}

#[test]
fn a_changed_artifact_role_invalidates_the_stage() {
    let setup = published(false);
    open(&setup).unwrap();
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
fn missing_retained_bytes_invalidate_instead_of_downloading_again() {
    let setup = published(false);
    open(&setup).unwrap();
    fs::remove_file(setup.record.path.join(&setup.record.artifact.name)).unwrap();
    assert_invalidated(&setup, PendingSetupInvalidation::RetainedBytesChanged);

    let setup = published(true);
    open(&setup).unwrap();
    fs::remove_file(setup.record.path.join(RECEIPT_NAME)).unwrap();
    assert_invalidated(&setup, PendingSetupInvalidation::RetainedBytesChanged);
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
    let authorization = review(&setup, &executable, &working);
    set_listing(&mut setup.service, |listing| {
        listing["download_block_reason"] = json!("Upstream withdrew this package.");
    });
    // The capability report rechecks the catalog and never shows the stale
    // reviewed plan.
    let report = setup.service.port_capabilities(FIXTURE).unwrap();
    assert_eq!(
        report.pending_setup_stage,
        Some(PendingSetupStageKind::Invalidated)
    );
    let explanation = &report
        .routes
        .iter()
        .find(|route| route.route == "upstream-setup")
        .unwrap()
        .features[0]
        .explanation;
    assert!(!explanation.contains("You reviewed"), "{explanation}");
    assert!(explanation.contains("Upstream withdrew this package."));

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

/// A complete upstream observation naming the downloaded release `v1`
/// (identity 7) and, optionally, a later release.
fn observed(newer: Option<(u64, &str, &str)>) -> serde_json::Value {
    let release = |id: u64, version: &str, published_at: &str| {
        json!({
            "id": id, "version": version,
            "release_url": format!("https://github.com/owner/staged/releases/tag/{version}"),
            "published_at": published_at, "provider_prerelease": false,
            "assets_complete": true, "assets": []
        })
    };
    let mut releases = vec![release(7, "v1", "2026-11-01T00:00:00Z")];
    if let Some((id, version, published_at)) = newer {
        releases.push(release(id, version, published_at));
    }
    json!({
        "provider": "github", "repository": "owner/staged", "repository_id": 5,
        "status": "complete", "attempted_at": "2026-11-21T00:00:00Z",
        "observed_at": "2026-11-21T00:00:00Z", "fresh_until": "2026-11-22T00:00:00Z",
        "facts_sha256": "a".repeat(64), "release_limit": 4, "releases": releases
    })
}

fn pinned(version: &str, published_at: Option<&str>) -> serde_json::Value {
    json!({
        "reason": "Reviewed direct contract", "reconsider_when": "A newer release is reviewed",
        "pinned_releases": [{
            "platform": Platform::current().unwrap(), "version": version,
            "published_at": published_at
        }]
    })
}

#[test]
fn only_a_later_release_with_another_identity_is_newer() {
    let cases: [(&str, Box<dyn Fn(&mut serde_json::Value)>, Option<&str>); 6] = [
        (
            "newer observed release",
            Box::new(|listing| {
                listing["upstream_observation"] = observed(Some((8, "v2", "2026-11-10T00:00:00Z")));
            }),
            Some("v2"),
        ),
        (
            "older observed release",
            Box::new(|listing| {
                listing["upstream_observation"] =
                    observed(Some((6, "v0.9", "2026-10-01T00:00:00Z")));
            }),
            None,
        ),
        (
            "newer reviewed pin",
            Box::new(|listing| {
                listing["upstream_observation"] = observed(None);
                listing["release_maintenance"] = pinned("v2", Some("2026-11-10T00:00:00Z"));
            }),
            Some("v2"),
        ),
        (
            "older reviewed pin",
            Box::new(|listing| {
                listing["upstream_observation"] = observed(None);
                listing["release_maintenance"] = pinned("v0.9", Some("2026-10-01T00:00:00Z"));
            }),
            None,
        ),
        (
            "same release spelled differently",
            Box::new(|listing| {
                listing["upstream_observation"] = observed(None);
                listing["release_maintenance"] = pinned("1", Some("2026-11-10T00:00:00Z"));
            }),
            None,
        ),
        (
            "pin of unknown age",
            Box::new(|listing| {
                listing["upstream_observation"] = observed(None);
                listing["release_maintenance"] = pinned("v2", None);
            }),
            None,
        ),
    ];
    for (name, edit, expected) in cases {
        let mut setup = published(false);
        set_listing(&mut setup.service, |listing| edit(listing));
        assert_eq!(
            setup
                .service
                .newer_pending_release(&setup.record)
                .as_deref(),
            expected,
            "{name}"
        );
    }
    // Incomplete coverage is unknown and shows no notice.
    let mut setup = published(false);
    set_listing(&mut setup.service, |listing| {
        let mut observation = observed(Some((8, "v2", "2026-11-10T00:00:00Z")));
        observation["status"] = json!("incomplete");
        listing["upstream_observation"] = observation;
    });
    assert_eq!(setup.service.newer_pending_release(&setup.record), None);
}

#[test]
fn a_newer_release_is_a_notice_and_never_blocks_registration() {
    let mut setup = published(false);
    let (executable, working) = installed_program(&setup);
    select(&setup, &executable, &working).unwrap();
    set_listing(&mut setup.service, |listing| {
        listing["upstream_observation"] = observed(Some((8, "v2", "2026-11-10T00:00:00Z")));
    });
    let record = setup.service.pending_setups().unwrap().pop().unwrap();
    let (stage, message) = setup.service.pending_setup_presentation(&record).unwrap();
    assert_eq!(stage, PendingSetupStageKind::FinalSelected);
    assert_eq!(
        message.notice.as_deref(),
        Some(
            "Version v2 is newer than the one you downloaded. You can still add the game you set up."
        )
    );
    let report = setup.service.port_capabilities(FIXTURE).unwrap();
    let explanation = &report
        .routes
        .iter()
        .find(|route| route.route == "upstream-setup")
        .unwrap()
        .features[0]
        .explanation;
    assert!(explanation.contains("Version v2 is newer"), "{explanation}");

    let authorization = review(&setup, &executable, &working);
    let registered = setup
        .service
        .register_user_selected_runtime(FIXTURE, &executable, &working, &[], &authorization.token)
        .unwrap();
    assert_eq!(
        registered.setup_download.unwrap().release_tag,
        setup.record.artifact.release_tag
    );
    assert!(setup.service.pending_setups().unwrap().is_empty());
}

#[test]
fn stage_changes_respect_the_port_lock() {
    let setup = published(false);
    let stored = raw_row(&setup.service);
    let _held = setup
        .service
        .library
        .try_lock_port(FIXTURE, "test-holder")
        .unwrap();
    let error = open(&setup).unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    let (executable, working) = installed_program(&setup);
    assert!(select(&setup, &executable, &working).is_err());
    assert_eq!(raw_row(&setup.service), stored);
}

#[test]
fn capability_report_shows_cores_stage_message() {
    let setup = published(false);
    open(&setup).unwrap();
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
    for reason in [
        PendingSetupInvalidation::SourceChanged {
            current_source_url: "https://example.com".into(),
        },
        PendingSetupInvalidation::DefinitionChanged,
        PendingSetupInvalidation::RestrictionHolds {
            explanation: "Held.".into(),
        },
        PendingSetupInvalidation::ArtifactRoleChanged {
            current_role: ArtifactRole::Installer,
        },
        PendingSetupInvalidation::RetainedBytesChanged,
    ] {
        stages.push(PendingSetupStage::Invalidated {
            previous: PendingSetupStageKind::UpstreamSetupOpened,
            reason,
        });
    }
    let notice = newer_release_notice("v2");
    for stage in stages {
        let message = pending_setup_message(&stage, Some(ArtifactRole::Installer));
        assert_eq!(message.notice, None);
        for text in [&message.summary, &message.next_step, &notice] {
            assert!(text.ends_with('.'), "{text}");
            assert!(text.split_whitespace().count() <= 25, "{text}");
        }
    }
}
