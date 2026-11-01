//! Inert Windows filesystem/manifest fixtures. No original game bytes are
//! acquired, and the synthetic executable is never launched. These tests cannot
//! establish Desktop interaction or consumption by either actual game.

use super::*;
use crate::operation::{LifecycleFaultInjector, SettingsFaultPoint};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

const SHIP: &str = "shipwright";
const GOLDEN: &str = "diddy-kong-racing-golden-balloon";

struct Fixture {
    _temporary: tempfile::TempDir,
    service: PortcoveService,
    install: InstallRecord,
    file: GameSettingsFile,
    canonical: PathBuf,
    runtime: PathBuf,
    original: Vec<u8>,
    proposed: Value,
}

fn fixture(port_id: &str) -> Fixture {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let mut port = Catalog::embedded().unwrap().port(port_id).unwrap().clone();
    port.source_profile = None;
    port.presentation = None;
    let descriptor = port.game_settings.as_ref().unwrap();
    let file = descriptor.files[0].clone();
    let release = &descriptor.releases[0];
    let catalog =
        Catalog::from_json(&json!({"schema_version":1,"ports":[port.clone()]}).to_string())
            .unwrap();
    let qualification =
        InstallQualification::from_catalog(&catalog, port_id, Platform::WindowsX86_64).unwrap();
    let root = library
        .versions_dir()
        .join(port_id)
        .join("settings-fixture");
    fs::create_dir_all(&root).unwrap();
    if port_id == GOLDEN {
        fs::create_dir_all(root.join("GoldenBalloon")).unwrap();
    }
    let executable = &port.executable_hints[&Platform::WindowsX86_64][0];
    fs::write(
        root.join(executable),
        b"inert settings fixture executable, never run",
    )
    .unwrap();
    let artifact = crate::ArtifactIdentity {
        asset_name: if port_id == SHIP {
            "SoH-Dewey-Bravo-Win64.zip"
        } else {
            "Golden-Balloon-1.8.0-windows-x64.zip"
        }
        .into(),
        sha256: release.archive_sha256.clone(),
        size: if port_id == SHIP {
            72_980_600
        } else {
            31_898_069
        },
    };
    let installer = Installer::new(library.clone()).unwrap();
    let (manifest_sha256, selected_executable, runtime) = installer
        .create_manifest(
            "settings-fixture",
            port_id,
            &release.version,
            &artifact,
            &qualification,
            &root,
        )
        .unwrap();
    let install = InstallRecord {
        id: "settings-fixture".into(),
        port_id: port_id.into(),
        version: release.version.clone(),
        path: root,
        channel: crate::ReleaseChannel::Stable,
        installed_at: 1,
        verified: true,
        staged: false,
        artifact,
        runtime,
        manifest_sha256,
        selected_executable,
    };
    library.register_install(&install, true).unwrap();
    let mut service = PortcoveService::new(library.clone()).unwrap();
    service.replace_catalog_for_test(catalog);
    let guard = library
        .try_lock_port(port_id, "settings-fixture-setup")
        .unwrap();
    let context = service.settings_context_already_locked(port_id).unwrap();
    assert!(!context.direct);
    let canonical = library.user_dir(port_id).join(&file.path);
    let runtime = context.runtime_root.join(&file.path);
    assert_ne!(canonical, runtime);
    let original = if port_id == SHIP {
        br#"{"CVars":{"gSettings":{"Volume":{"Master":40},"unknown":"keep"}},"unrelated":[1,null,true]}"#.to_vec()
    } else {
        b"# player comment\r\nui_scale=1.00\r\nunknown=value=with=equals\nlast=unchanged".to_vec()
    };
    for path in [&canonical, &runtime] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, &original).unwrap();
    }
    drop(guard);
    Fixture {
        _temporary: temporary,
        service,
        install,
        file,
        canonical,
        runtime,
        original,
        proposed: if port_id == SHIP {
            json!(70)
        } else {
            json!(1.25)
        },
    }
}

fn apply(fixture: &Fixture, change: GameSettingChange) -> Result<GameSettingsView> {
    let setting = &fixture.file.settings[0].id;
    let review = fixture.service.review_game_setting(
        &fixture.install.port_id,
        &fixture.file.id,
        setting,
        change.clone(),
    )?;
    fixture.service.apply_game_setting(
        &fixture.install.port_id,
        &fixture.file.id,
        setting,
        change,
        &review.review_sha256,
    )
}

fn observed(fixture: &Fixture) -> Value {
    let view = fixture
        .service
        .get_game_settings(&fixture.install.port_id)
        .unwrap();
    assert!(view.available);
    assert!(view.files[0].available, "{:?}", view.files[0].reason);
    view.files[0].settings[0].value.clone().unwrap()
}

fn replace_retention(fixture: &mut Fixture, catalog: Option<&Catalog>) {
    let port = fixture
        .service
        .catalog
        .port(&fixture.install.port_id)
        .unwrap();
    let qualification = match catalog {
        Some(catalog) => InstallQualification::from_catalog(
            catalog,
            &fixture.install.port_id,
            Platform::WindowsX86_64,
        )
        .unwrap(),
        None => InstallQualification::from_port(port, Platform::WindowsX86_64).unwrap(),
    };
    let (manifest_sha256, selected_executable, runtime) =
        Installer::new(fixture.service.library.clone())
            .unwrap()
            .create_manifest(
                &fixture.install.id,
                &fixture.install.port_id,
                &fixture.install.version,
                &fixture.install.artifact,
                &qualification,
                &fixture.install.path,
            )
            .unwrap();
    fixture.install.manifest_sha256 = manifest_sha256;
    fixture.install.selected_executable = selected_executable;
    fixture.install.runtime = runtime;
    fixture
        .service
        .library
        .update_install_manifest(&fixture.install)
        .unwrap();
}

#[test]
fn current_settings_cannot_enroll_unretained_or_retained_without_settings_installs() {
    use std::os::windows::fs::OpenOptionsExt;
    for port_id in [SHIP, GOLDEN] {
        for unretained in [true, false] {
            let mut fixture = fixture(port_id);
            if unretained {
                replace_retention(&mut fixture, None);
            } else {
                let mut document = fixture.service.catalog.authoritative_document();
                document
                    .ports
                    .iter_mut()
                    .find(|port| port.id == port_id)
                    .unwrap()
                    .game_settings = None;
                let retained =
                    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
                replace_retention(&mut fixture, Some(&retained));
            }
            assert!(
                fixture
                    .service
                    .catalog
                    .port(port_id)
                    .unwrap()
                    .game_settings
                    .is_some()
            );
            let locked = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&fixture.canonical)
                .unwrap();
            let view = fixture.service.get_game_settings(port_id).unwrap();
            assert!(!view.available);
            assert!(view.files.is_empty());
            assert!(view.reason.unwrap().contains("retained"));
            let error = fixture
                .service
                .review_game_setting(
                    port_id,
                    &fixture.file.id,
                    &fixture.file.settings[0].id,
                    GameSettingChange::Reset,
                )
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Unsupported);
            assert!(error.message.contains("retained"));
            drop(locked);
            assert_eq!(fs::read(&fixture.canonical).unwrap(), fixture.original);
        }
    }
}

#[test]
fn retained_settings_and_defaults_do_not_follow_current_absence_or_replacement() {
    for port_id in [SHIP, GOLDEN] {
        for absent in [true, false] {
            let mut fixture = fixture(port_id);
            let mut document = fixture.service.catalog.authoritative_document();
            let port = document
                .ports
                .iter_mut()
                .find(|port| port.id == port_id)
                .unwrap();
            if absent {
                port.game_settings = None;
            } else {
                match &mut port.game_settings.as_mut().unwrap().files[0].settings[0].value {
                    crate::GameSettingType::Integer { default, .. } => *default = 5,
                    crate::GameSettingType::Number { default, .. } => *default = 1.5,
                    _ => unreachable!(),
                }
            }
            fixture.service.replace_catalog_for_test(
                Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
            );
            assert_eq!(
                observed(&fixture),
                fixture.file.settings[0].value.default_value()
            );
            let review = fixture
                .service
                .review_game_setting(
                    port_id,
                    &fixture.file.id,
                    &fixture.file.settings[0].id,
                    GameSettingChange::Reset,
                )
                .unwrap();
            assert_eq!(
                review.proposed_value,
                fixture.file.settings[0].value.default_value()
            );
        }
    }
}

#[test]
fn retained_settings_keep_current_publisher_restrictions_effective() {
    for port_id in [SHIP, GOLDEN] {
        let mut fixture = fixture(port_id);
        let admitted =
            crate::test_fixture::admitted_indexed_catalog(&fixture.service.catalog, port_id);
        let selection = admitted.definition_selection(port_id).unwrap();
        fixture.service.library.connection().unwrap().execute(
            "INSERT INTO definition_publisher_policy(namespace,stable_id,root_sha256,policy_revision,grant_id,status) VALUES(?1,?2,?3,?4,?5,'scoped')",
            rusqlite::params![selection.namespace, selection.stable_id, selection.repository_root_sha256, selection.policy_revision, selection.grant_id],
        ).unwrap();
        replace_retention(&mut fixture, Some(&admitted));
        fixture.service.replace_catalog_for_test(admitted);
        assert!(
            fixture
                .service
                .get_game_settings(port_id)
                .unwrap()
                .available
        );
        fixture.service.library.connection().unwrap().execute("UPDATE definition_publisher_policy SET status='revoked' WHERE namespace='official' AND stable_id=?1", [port_id]).unwrap();
        let view = fixture.service.get_game_settings(port_id).unwrap();
        assert!(!view.available);
        assert!(view.files.is_empty());
        assert!(
            fixture
                .service
                .review_game_setting(
                    port_id,
                    &fixture.file.id,
                    &fixture.file.settings[0].id,
                    GameSettingChange::Reset
                )
                .is_err()
        );
        assert_eq!(fs::read(&fixture.canonical).unwrap(), fixture.original);
    }
}

#[test]
fn both_formats_read_apply_reset_and_restart_through_the_same_core_service() {
    for port_id in [SHIP, GOLDEN] {
        let mut fixture = fixture(port_id);
        let manifest = fs::read(fixture.install.path.join(".portcove-manifest.json")).unwrap();
        let executable = fs::read(
            fixture
                .install
                .path
                .join(&fixture.install.selected_executable),
        )
        .unwrap();
        let change = GameSettingChange::Set {
            value: fixture.proposed.clone(),
        };
        apply(&fixture, change).unwrap();
        assert_eq!(observed(&fixture), fixture.proposed);
        assert_eq!(
            fs::read(&fixture.canonical).unwrap(),
            fs::read(&fixture.runtime).unwrap()
        );
        let bytes = fs::read(&fixture.canonical).unwrap();
        if port_id == SHIP {
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["CVars"]["gSettings"]["unknown"], "keep");
            assert_eq!(value["unrelated"], json!([1, null, true]));
        } else {
            assert_eq!(
                bytes,
                b"# player comment\r\nui_scale=1.25\r\nunknown=value=with=equals\nlast=unchanged"
            );
        }
        let library = fixture.service.library.clone();
        let current = fixture.service.catalog.clone();
        fixture.service = PortcoveService::new(library).unwrap();
        fixture.service.replace_catalog_for_test(current);
        assert_eq!(observed(&fixture), fixture.proposed);
        apply(&fixture, GameSettingChange::Reset).unwrap();
        assert_eq!(
            observed(&fixture),
            fixture.file.settings[0].value.default_value()
        );
        assert_eq!(
            fs::read(fixture.install.path.join(".portcove-manifest.json")).unwrap(),
            manifest
        );
        assert_eq!(
            fs::read(
                fixture
                    .install
                    .path
                    .join(&fixture.install.selected_executable)
            )
            .unwrap(),
            executable
        );
        assert!(
            OperationStore::new(fixture.service.library.clone())
                .all()
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn stale_bytes_and_replaced_same_bytes_objects_refuse_without_changing_config() {
    for port_id in [SHIP, GOLDEN] {
        for replace_identity in [false, true] {
            let fixture = fixture(port_id);
            let change = GameSettingChange::Set {
                value: fixture.proposed.clone(),
            };
            let review = fixture
                .service
                .review_game_setting(
                    port_id,
                    &fixture.file.id,
                    &fixture.file.settings[0].id,
                    change.clone(),
                )
                .unwrap();
            if replace_identity {
                let replacement = fixture.canonical.with_extension("replacement");
                fs::write(&replacement, &fixture.original).unwrap();
                fs::rename(&replacement, &fixture.canonical).unwrap();
            } else {
                let changed = crate::game_settings::document::edit(
                    &fixture.file,
                    &fixture.original,
                    &fixture.file.settings[0].id,
                    &fixture.proposed,
                )
                .unwrap();
                fs::write(&fixture.canonical, &changed).unwrap();
                fs::write(&fixture.runtime, &changed).unwrap();
            }
            let before = fs::read(&fixture.canonical).unwrap();
            assert!(
                fixture
                    .service
                    .apply_game_setting(
                        port_id,
                        &fixture.file.id,
                        &fixture.file.settings[0].id,
                        change,
                        &review.review_sha256
                    )
                    .is_err()
            );
            assert_eq!(fs::read(&fixture.canonical).unwrap(), before);
            assert!(
                OperationStore::new(fixture.service.library.clone())
                    .all()
                    .unwrap()
                    .is_empty()
            );
        }
    }
}

#[test]
fn canonical_runtime_disagreement_and_invalid_value_preserve_both_copies() {
    for port_id in [SHIP, GOLDEN] {
        let fixture = fixture(port_id);
        let change = GameSettingChange::Set { value: json!(999) };
        assert!(
            fixture
                .service
                .review_game_setting(
                    port_id,
                    &fixture.file.id,
                    &fixture.file.settings[0].id,
                    change
                )
                .is_err()
        );
        assert_eq!(fs::read(&fixture.canonical).unwrap(), fixture.original);
        let changed = crate::game_settings::document::edit(
            &fixture.file,
            &fixture.original,
            &fixture.file.settings[0].id,
            &fixture.proposed,
        )
        .unwrap();
        fs::write(&fixture.runtime, &changed).unwrap();
        assert!(
            fixture
                .service
                .review_game_setting(
                    port_id,
                    &fixture.file.id,
                    &fixture.file.settings[0].id,
                    GameSettingChange::Reset
                )
                .is_err()
        );
        let view = fixture.service.get_game_settings(port_id).unwrap();
        assert!(!view.files[0].available);
        assert_eq!(fs::read(&fixture.runtime).unwrap(), changed);
        assert_eq!(fs::read(&fixture.canonical).unwrap(), fixture.original);
    }
}

#[test]
fn read_only_configuration_refuses_review_without_journal_or_staging() {
    for port_id in [SHIP, GOLDEN] {
        let fixture = fixture(port_id);
        let mut permissions = fs::metadata(&fixture.canonical).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&fixture.canonical, permissions).unwrap();
        let error = fixture
            .service
            .review_game_setting(
                port_id,
                &fixture.file.id,
                &fixture.file.settings[0].id,
                GameSettingChange::Reset,
            )
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert!(error.message.contains("read-only"));
        assert!(
            OperationStore::new(fixture.service.library.clone())
                .all()
                .unwrap()
                .is_empty()
        );
        assert_eq!(fs::read(&fixture.canonical).unwrap(), fixture.original);
        assert!(
            !fs::read_dir(fixture.canonical.parent().unwrap())
                .unwrap()
                .any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".portcove-settings-"))
        );
        let mut permissions = fs::metadata(&fixture.canonical).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&fixture.canonical, permissions).unwrap();
    }
}

#[test]
fn actual_nondefault_integrity_policy_refuses_before_journaling_or_staging() {
    for port_id in [SHIP, GOLDEN] {
        let fixture = fixture(port_id);
        crate::game_settings::windows::HeldFile::set_no_read_up_for_test(&fixture.canonical)
            .unwrap();
        let error = fixture
            .service
            .review_game_setting(
                port_id,
                &fixture.file.id,
                &fixture.file.settings[0].id,
                GameSettingChange::Reset,
            )
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert!(error.message.contains("integrity"));
        assert!(
            OperationStore::new(fixture.service.library.clone())
                .all()
                .unwrap()
                .is_empty()
        );
        assert_eq!(fs::read(&fixture.canonical).unwrap(), fixture.original);
        assert_eq!(fs::read(&fixture.runtime).unwrap(), fixture.original);
        assert!(
            !fs::read_dir(fixture.canonical.parent().unwrap())
                .unwrap()
                .any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".portcove-settings-"))
        );
    }
}

#[test]
fn actual_default_policy_low_integrity_refuses_before_journaling_or_staging() {
    for (port_id, label_parent) in [(SHIP, false), (GOLDEN, false), (SHIP, true), (GOLDEN, true)] {
        let fixture = fixture(port_id);
        let label_path = if label_parent {
            fixture.canonical.parent().unwrap()
        } else {
            &fixture.canonical
        };
        crate::game_settings::windows::HeldFile::set_low_integrity_for_test(label_path).unwrap();
        let error = fixture
            .service
            .review_game_setting(
                port_id,
                &fixture.file.id,
                &fixture.file.settings[0].id,
                GameSettingChange::Reset,
            )
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert!(error.message.contains("integrity"));
        assert!(
            OperationStore::new(fixture.service.library.clone())
                .all()
                .unwrap()
                .is_empty()
        );
        assert_eq!(fs::read(&fixture.canonical).unwrap(), fixture.original);
        assert_eq!(fs::read(&fixture.runtime).unwrap(), fixture.original);
        assert!(
            !fs::read_dir(fixture.canonical.parent().unwrap())
                .unwrap()
                .any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".portcove-settings-"))
        );
    }
}

#[test]
fn foreign_staging_suffix_and_occupied_publication_name_are_retained_for_review() {
    for point in [
        SettingsFaultPoint::CanonicalStageBound,
        SettingsFaultPoint::CanonicalMoved,
    ] {
        let mut fixture = fixture(GOLDEN);
        fixture.service.faults = Arc::new(FailAt {
            point,
            fired: AtomicBool::new(false),
        });
        assert!(
            apply(
                &fixture,
                GameSettingChange::Set {
                    value: fixture.proposed.clone()
                }
            )
            .is_err()
        );
        fixture.service.faults = Arc::new(NoLifecycleFaults);
        let store = OperationStore::new(fixture.service.library.clone());
        let record = store.all().unwrap().pop().unwrap();
        let path = if point == SettingsFaultPoint::CanonicalStageBound {
            record.paths.staging.clone().unwrap()
        } else {
            fixture.canonical.clone()
        };
        fs::write(&path, b"foreign content must survive").unwrap();
        let payload_before = serde_json::to_value(&record.game_settings).unwrap();
        fixture.service.recover_pending_operations().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"foreign content must survive");
        assert_eq!(
            serde_json::to_value(&store.get(&record.id).unwrap().unwrap().game_settings).unwrap(),
            payload_before
        );
        assert!(
            fixture
                .service
                .library
                .try_lock_port(GOLDEN, "launch")
                .is_err()
        );
        let original = if point == SettingsFaultPoint::CanonicalMoved {
            record.paths.quarantine.unwrap()
        } else {
            fixture.canonical.clone()
        };
        assert_eq!(fs::read(original).unwrap(), fixture.original);
        assert_eq!(fs::read(&fixture.runtime).unwrap(), fixture.original);
    }
}

struct FailAt {
    point: SettingsFaultPoint,
    fired: AtomicBool,
}
impl LifecycleFaultInjector for FailAt {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == LifecycleFaultPoint::SettingsBoundary(self.point)
            && !self.fired.swap(true, Ordering::SeqCst)
        {
            return Err(PortcoveError::state(format!(
                "controlled settings interruption: {point:?}"
            )));
        }
        Ok(())
    }
}

fn interrupted(port_id: &str, point: SettingsFaultPoint) {
    let mut fixture = fixture(port_id);
    let fault = Arc::new(FailAt {
        point,
        fired: AtomicBool::new(false),
    });
    fixture.service.faults = fault.clone();
    let error = apply(
        &fixture,
        GameSettingChange::Set {
            value: fixture.proposed.clone(),
        },
    )
    .unwrap_err();
    assert!(fault.fired.load(Ordering::SeqCst), "{point:?}: {error}");
    let store = OperationStore::new(fixture.service.library.clone());
    let before = store.all().unwrap();
    let unbound = matches!(
        point,
        SettingsFaultPoint::CanonicalStageCreated | SettingsFaultPoint::RuntimeStageCreated
    );
    if !before.is_empty() {
        assert!(fixture.service.get_game_settings(port_id).is_err());
        assert!(
            fixture
                .service
                .library
                .try_lock_port(port_id, "launch")
                .is_err()
        );
    }
    fixture.service.faults = Arc::new(NoLifecycleFaults);
    fixture.service.recover_pending_operations().unwrap();
    if unbound {
        assert_eq!(fs::read(&fixture.canonical).unwrap(), fixture.original);
        assert_eq!(fs::read(&fixture.runtime).unwrap(), fixture.original);
        let pending = store.all().unwrap();
        assert_eq!(pending.len(), 1);
        assert!(
            pending[0]
                .last_error
                .as_deref()
                .unwrap()
                .contains("unbound")
        );
        assert_eq!(pending[0].phase, LifecyclePhase::Preparing);
    } else {
        assert!(store.all().unwrap().is_empty());
        let expected = if point == SettingsFaultPoint::IntentBeforeInsert {
            fixture.file.settings[0].value.default_value()
        } else {
            fixture.proposed.clone()
        };
        assert_eq!(observed(&fixture), expected);
        assert_eq!(
            fs::read(&fixture.canonical).unwrap(),
            fs::read(&fixture.runtime).unwrap()
        );
    }
}

macro_rules! interruption_cases {
    ($($name:ident: $point:ident),+ $(,)?) => { $(#[test] fn $name() { for port in [SHIP, GOLDEN] { interrupted(port, SettingsFaultPoint::$point); } })+ };
}

interruption_cases! {
    intent_before_insert: IntentBeforeInsert,
    canonical_before_create: CanonicalStageBeforeCreate,
    canonical_created_before_binding: CanonicalStageCreated,
    canonical_bound_before_write: CanonicalStageBound,
    canonical_partial_write: CanonicalStagePartialWrite,
    canonical_before_flush: CanonicalStageBeforeFlush,
    canonical_flushed: CanonicalStageFlushed,
    interrupted_between_stages: BetweenStages,
    runtime_before_create: RuntimeStageBeforeCreate,
    runtime_created_before_binding: RuntimeStageCreated,
    runtime_bound_before_write: RuntimeStageBound,
    runtime_partial_write: RuntimeStagePartialWrite,
    runtime_before_flush: RuntimeStageBeforeFlush,
    runtime_flushed: RuntimeStageFlushed,
    journal_before_staging: Journaled,
    prepared_before_custody_transfer: Prepared,
    canonical_original_moved: CanonicalMoved,
    canonical_postimage_published: CanonicalPublished,
    runtime_original_moved: RuntimeMoved,
    runtime_postimage_published: RuntimePublished,
    metadata_committed_before_cleanup: MetadataCommitted,
    cleanup_marked_before_retirement: CleanupPending,
    canonical_preimage_retired: CanonicalRetired,
    runtime_preimage_retired: RuntimeRetired,
    journal_retired_before_response: JournalRetired,
}
