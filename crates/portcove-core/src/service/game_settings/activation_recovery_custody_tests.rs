//! Native filesystem and SQL custody only. The installed records are inert.

use super::super::transaction::custody;
use super::*;
use crate::operation::game_settings::{SettingsFileWitness, tests::activation_record};
use crate::operation::{LifecycleFaultInjector, NoLifecycleFaults};

const OLD: &[u8] = br#"{"volume":40}"#;
const NEW: &[u8] = br#"{"volume":70}"#;
const PLAYER: &[u8] = br#"{"volume":12,"custom":true}"#;

struct FailAt(SettingsFaultPoint);

impl LifecycleFaultInjector for FailAt {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == LifecycleFaultPoint::SettingsBoundary(self.0) {
            return Err(PortcoveError::state("interrupted fixture transition"));
        }
        Ok(())
    }
}

fn stage(
    writer: &SettingsActivationWriter<'_>,
    operation: &mut LifecycleOperation,
    role: &str,
    faults: &dyn LifecycleFaultInjector,
) -> Result<()> {
    let payload = operation.settings_activation.as_ref().unwrap();
    let file = (if role == "canonical" {
        payload.canonical.as_ref().unwrap()
    } else {
        payload.runtime.as_ref().unwrap()
    })
    .clone();
    let id = operation.id.clone();
    let mut original = HeldFile::open(&file.path)?;
    assert_eq!(checked_bytes(&mut original, &file, true, 1024)?, OLD);
    prepare_file_stage(
        &id,
        role,
        NEW,
        &original,
        &file,
        faults,
        |binding| match binding {
            StageBinding::Bind(id) => writer.bind_stage(operation, role, id),
            StageBinding::Confirm => writer.confirm(operation),
        },
    )
}

#[test]
fn bound_stage_prefix_and_rename_gap_resume_while_player_edit_holds_publication() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let store = OperationStore::new(library.clone());
    let mut operation = activation_record(&library);
    let target = operation.install.as_ref().unwrap().clone();
    let payload = operation.settings_activation.as_mut().unwrap();
    let previous = payload.previous.clone();
    let user_path = payload.canonical.as_ref().unwrap().path.clone();
    let target_path = payload.runtime.as_ref().unwrap().path.clone();
    let player_path = previous.path.join(&payload.relative_path);
    for path in [&user_path, &target_path, &player_path] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, OLD).unwrap();
    }
    let build_custody = |path| custody(&HeldFile::open(path).unwrap(), &hash(OLD), &hash(NEW));
    payload.canonical = Some(build_custody(&user_path));
    payload.runtime = Some(build_custody(&target_path));
    let witness = HeldFile::open(&player_path).unwrap();
    payload.previous_runtime = Some(SettingsFileWitness {
        path: player_path.clone(),
        parent_identity: witness.parent_identity.clone(),
        original_identity: witness.identity.clone(),
    });
    drop(witness);
    library.register_install(&previous, true).unwrap();
    library.register_install(&target, false).unwrap();
    let mut legacy = operation.clone();
    legacy.settings_activation = None;
    store.put(&mut legacy).unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE lifecycle_operations SET game_settings_json=?2 WHERE id=?1",
            rusqlite::params![
                operation.id,
                serde_json::to_string(&operation.settings_activation).unwrap()
            ],
        )
        .unwrap();
    let writer = SettingsActivationWriter::for_windows_fixture(&store);
    let _guard = library
        .try_lock_port_for_settings_recovery(&operation.port_id, &operation.id)
        .unwrap();
    let (user_stage, user_old) = owned_names(&user_path, &operation.id, "canonical").unwrap();
    let (_, target_old) = owned_names(&target_path, &operation.id, "runtime").unwrap();

    let unbound = operation.clone();
    assert!(
        stage(
            &writer,
            &mut operation,
            "canonical",
            &FailAt(SettingsFaultPoint::CanonicalStagePartialWrite)
        )
        .is_err()
    );
    let prefix = fs::read(&user_stage).unwrap();
    assert!(!prefix.is_empty() && prefix.len() < NEW.len() && NEW.starts_with(&prefix));
    assert_eq!(fs::read(&user_path).unwrap(), OLD);
    assert!(writer.confirm(&unbound).is_err());
    operation = store.get(&operation.id).unwrap().unwrap();
    assert!(
        operation
            .settings_activation
            .as_ref()
            .unwrap()
            .canonical
            .replacement_identity
            .is_some()
    );
    stage(&writer, &mut operation, "canonical", &NoLifecycleFaults).unwrap();
    stage(&writer, &mut operation, "runtime", &NoLifecycleFaults).unwrap();
    writer
        .advance(&mut operation, LifecyclePhase::Prepared)
        .unwrap();

    let payload = operation.settings_activation.as_ref().unwrap().clone();
    {
        let mut canonical = Leg::open(
            payload.canonical.as_ref().unwrap(),
            &operation.id,
            "canonical",
            1024,
        )
        .unwrap();
        assert!(
            canonical
                .publish(
                    payload.canonical.as_ref().unwrap(),
                    &operation.id,
                    "canonical",
                    1024,
                    &FailAt(SettingsFaultPoint::CanonicalMoved)
                )
                .is_err()
        );
    }
    assert!(!user_path.exists());
    assert_eq!(fs::read(&user_old).unwrap(), OLD);
    operation = store.get(&operation.id).unwrap().unwrap();
    assert_eq!(operation.phase, LifecyclePhase::Prepared);
    {
        let mut canonical = Leg::open(
            payload.canonical.as_ref().unwrap(),
            &operation.id,
            "canonical",
            1024,
        )
        .unwrap();
        assert!(canonical.state == LegState::Gap);
        canonical
            .publish(
                payload.canonical.as_ref().unwrap(),
                &operation.id,
                "canonical",
                1024,
                &NoLifecycleFaults,
            )
            .unwrap();
    }
    writer
        .advance(&mut operation, LifecyclePhase::PayloadPublished)
        .unwrap();

    let runtime = payload.runtime.as_ref().unwrap();
    fs::write(&target_path, PLAYER).unwrap();
    assert!(Leg::open(runtime, &operation.id, "runtime", 1024).is_err());
    assert_eq!(fs::read(&target_path).unwrap(), PLAYER);
    assert_eq!(fs::read(&user_old).unwrap(), OLD);
    assert_eq!(fs::read(&player_path).unwrap(), OLD);
    assert!(store.get(&operation.id).unwrap().is_some());
    writer
        .record_hold(&mut operation, "fixture player edit retained")
        .unwrap();
    assert_eq!(
        store
            .get(&operation.id)
            .unwrap()
            .unwrap()
            .last_error
            .as_deref(),
        Some("fixture player edit retained")
    );

    // The explicit fixture repair restores the original target bytes.
    fs::write(&target_path, OLD).unwrap();
    {
        let mut leg = Leg::open(runtime, &operation.id, "runtime", 1024).unwrap();
        leg.publish(runtime, &operation.id, "runtime", 1024, &NoLifecycleFaults)
            .unwrap();
    }
    assert_eq!(fs::read(&user_path).unwrap(), NEW);
    assert_eq!(fs::read(&target_path).unwrap(), NEW);
    library.activate_staged_exact(&previous, &target).unwrap();
    let status = library.status(&operation.port_id, target.channel).unwrap();
    assert_eq!(
        activation_pointer(&operation, &status).unwrap(),
        SettingsActivationPointer::TargetActive
    );
    writer
        .advance(&mut operation, LifecyclePhase::MetadataCommitted)
        .unwrap();
    writer
        .advance(&mut operation, LifecyclePhase::CleanupPending)
        .unwrap();
    for (role, custody) in [
        ("canonical", payload.canonical.as_ref().unwrap()),
        ("runtime", runtime),
    ] {
        let mut leg = Leg::open(custody, &operation.id, role, 1024).unwrap();
        leg.retire_preimage(custody, 1024).unwrap();
    }
    writer.retire(&operation).unwrap();
    assert!(!user_old.exists() && !target_old.exists());
    assert_eq!(fs::read(player_path).unwrap(), OLD);
    assert!(store.get(&operation.id).unwrap().is_none());
}
