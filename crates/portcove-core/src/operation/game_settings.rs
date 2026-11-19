//! Typed custody for one retained configuration change and its runtime projection.
//! This codec grants no pathname mutation authority. Actuation must revalidate
//! the retained definition, installation and held physical objects.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase};
use crate::{InstallRecord, Library, PortcoveError, Result};

#[cfg(windows)]
mod activation_writer;
#[cfg(windows)]
pub(crate) use activation_writer::SettingsActivationWriter;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SettingsJournal {
    pub format_version: u32,
    pub install: InstallRecord,
    pub definition_sha256: String,
    pub file_id: String,
    pub relative_path: String,
    pub maximum_bytes: u64,
    pub review: crate::GameSettingReview,
    pub canonical: FileCustody,
    /// A projection of the same canonical postimage, never a second policy or
    /// settings store. Direct-to-user-root runtimes require no second leg.
    pub runtime: Option<FileCustody>,
}

/// Whole-file custody for one staged activation. The lifecycle record owns the
/// exact staged target; this payload also binds the still-active predecessor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ActivationSettingsJournal {
    pub format_version: u32,
    pub previous: InstallRecord,
    pub file_id: String,
    pub relative_path: String,
    pub maximum_bytes: u64,
    pub previous_runtime: Option<SettingsFileWitness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical: Option<FileCustody>,
    pub runtime: Option<FileCustody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletion: Option<ActivationSettingsDeletion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_projection_launch_id: Option<String>,
}

/// A positively recorded absence has no writable canonical leg. Only the
/// pristine incoming runtime file can be moved into this operation's custody.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ActivationSettingsDeletion {
    pub restore_id: String,
    pub canonical: SettingsAbsenceWitness,
    pub previous_runtime: SettingsAbsenceWitness,
    pub incoming: SettingsFileWitness,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SettingsAbsenceWitness {
    pub path: PathBuf,
    pub parent_identity: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SettingsActivationPointer {
    PreviousActive,
    TargetActive,
}

pub(crate) fn activation_pointer(
    operation: &LifecycleOperation,
    status: &crate::PortStatus,
) -> Result<SettingsActivationPointer> {
    let payload = operation.settings_activation.as_ref().ok_or_else(invalid)?;
    let target = operation.install.as_ref().ok_or_else(invalid)?;
    let matches = |actual: Option<&InstallRecord>, expected| {
        actual.is_some_and(|actual| crate::recovery::same_activation_install(actual, expected))
    };
    if status.port_id == operation.port_id {
        if matches!(
            operation.phase,
            LifecyclePhase::Preparing | LifecyclePhase::Prepared | LifecyclePhase::PayloadPublished
        ) && matches(status.active.as_ref(), &payload.previous)
            && matches(status.staged.as_ref(), target)
        {
            return Ok(SettingsActivationPointer::PreviousActive);
        }
        // SQLite can commit the pointer just before journal phase publication.
        // Recognize only the exact target and its exact retained predecessor.
        if matches!(
            operation.phase,
            LifecyclePhase::PayloadPublished
                | LifecyclePhase::MetadataCommitted
                | LifecyclePhase::CleanupPending
        ) && matches(status.active.as_ref(), target)
            && matches(status.previous.as_ref(), &payload.previous)
            && status.staged.is_none()
        {
            return Ok(SettingsActivationPointer::TargetActive);
        }
    }
    Err(PortcoveError::conflict(
        "settings activation custody differs from the current installation pointers",
    ))
}

/// An observed predecessor file. Its bytes are bound to the canonical
/// preimage. It never grants custody to rename or retire the predecessor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SettingsFileWitness {
    pub path: PathBuf,
    pub parent_identity: String,
    pub original_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FileCustody {
    pub path: PathBuf,
    pub parent_identity: String,
    pub original_identity: String,
    /// None is permitted only in Preparing, before a stage identity has been
    /// positively recorded. Its reserved pathname never proves ownership.
    pub replacement_identity: Option<String>,
    pub previous_sha256: String,
    pub proposed_sha256: String,
}

fn invalid() -> PortcoveError {
    PortcoveError::verification("settings journal has an invalid or foreign custody binding")
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn identity(value: &str) -> bool {
    let components: Vec<_> = value.split(':').collect();
    components.len() == 3
        && components[0] == "win128"
        && components[1].len() == 16
        && components[2].len() == 32
        && components[1..].iter().all(|part| {
            part.bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        && components[2] != "0".repeat(32)
        && components[2] != "f".repeat(32)
}

pub(crate) fn owned_names(path: &Path, id: &str, leg: &str) -> Result<(PathBuf, PathBuf)> {
    if !Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
        || !matches!(leg, "canonical" | "runtime")
    {
        return Err(invalid());
    }
    let parent = path.parent().ok_or_else(invalid)?;
    for suffix in ["new", "old"] {
        crate::archive::validate_relative_path(
            &format!(".portcove-settings-{id}-{leg}.{suffix}"),
            false,
        )?;
    }
    Ok((
        parent.join(format!(".portcove-settings-{id}-{leg}.new")),
        parent.join(format!(".portcove-settings-{id}-{leg}.old")),
    ))
}

pub(crate) fn decode_journal(encoded: Option<&str>) -> Result<Option<SettingsJournal>> {
    decode_payload(encoded)
}

pub(crate) fn decode_activation(
    encoded: Option<&str>,
) -> Result<Option<ActivationSettingsJournal>> {
    decode_payload(encoded)
}

fn decode_payload<T: serde::de::DeserializeOwned + Serialize>(
    encoded: Option<&str>,
) -> Result<Option<T>> {
    encoded
        .map(|value| {
            if value.len() > 16384 {
                return Err(invalid());
            }
            let crate::definition_entry::strict_json::UniqueValue(raw) =
                serde_json::from_str(value)?;
            let decoded: T = serde_json::from_value(raw.clone())?;
            if serde_json::to_value(&decoded)? != raw {
                return Err(invalid());
            }
            Ok(decoded)
        })
        .transpose()
}

pub(crate) fn validate_journal(library: &Library, operation: &LifecycleOperation) -> Result<()> {
    if let Some(payload) = &operation.settings_activation {
        validate_activation(library, operation, payload)?;
    }
    if operation.kind != LifecycleOperationKind::SettingsChange {
        return if operation.game_settings.is_none() {
            Ok(())
        } else {
            Err(invalid())
        };
    }
    let payload = operation.game_settings.as_ref().ok_or_else(invalid)?;
    crate::archive::validate_relative_path(&payload.relative_path, false)?;
    crate::archive::validate_relative_path(&operation.port_id, false)?;
    if operation.port_id.contains(['/', '\\'])
        || payload.relative_path.len() > 512
        || payload.relative_path.contains(['\\', ':'])
        || payload.format_version != 1
        || payload.install.port_id != operation.port_id
        || payload.install.id.is_empty()
        || payload.install.id.len() > 128
        || !digest(&payload.install.manifest_sha256)
        || !digest(&payload.definition_sha256)
        || payload.file_id.is_empty()
        || payload.file_id.len() > 64
        || payload.maximum_bytes == 0
        || payload.maximum_bytes > crate::game_settings::MAX_SETTINGS_BYTES
        || payload.canonical.path
            != library
                .user_dir(&operation.port_id)
                .join(&payload.relative_path)
        || payload.review.port_id != operation.port_id
        || payload.review.install_id != payload.install.id
        || payload.review.file_id != payload.file_id
        || payload.review.path != payload.relative_path
        || payload.review.configuration_sha256 != payload.canonical.previous_sha256
        || !digest(&payload.review.review_sha256)
        || operation.activate
        || !operation.original_paths.is_empty()
    {
        return Err(invalid());
    }
    // Ownership validation resolves physical placement. A canonical verbatim
    // spelling need not equal the exact logical InstallRecord retained here;
    // the actor separately binds that entire registered record before mutation.
    crate::output_root::validate_install_path(library, &operation.port_id, &payload.install.path)?;
    let (new, old) = owned_names(&payload.canonical.path, &operation.id, "canonical")?;
    if operation.paths.final_path.as_ref() != Some(&payload.canonical.path)
        || operation.paths.staging.as_ref() != Some(&new)
        || operation.paths.quarantine.as_ref() != Some(&old)
    {
        return Err(invalid());
    }
    validate_legs(
        operation.phase,
        &payload.canonical,
        payload.runtime.as_ref(),
        false,
    )?;
    if let Some(runtime) = &payload.runtime {
        let relative = runtime
            .path
            .strip_prefix(&payload.install.path)
            .map_err(|_| invalid())?;
        crate::archive::validate_relative_path(
            &relative.to_string_lossy().replace('\\', "/"),
            false,
        )?;
        if runtime.path == payload.canonical.path || relative.as_os_str().is_empty() {
            return Err(invalid());
        }
    }
    Ok(())
}

fn validate_legs(
    phase: super::LifecyclePhase,
    canonical: &FileCustody,
    runtime: Option<&FileCustody>,
    allow_pristine_runtime: bool,
) -> Result<()> {
    for custody in std::iter::once(canonical).chain(runtime) {
        if !identity(&custody.parent_identity)
            || !identity(&custody.original_identity)
            || custody
                .replacement_identity
                .as_ref()
                .is_some_and(|value| !identity(value))
            || (custody.replacement_identity.is_none() && phase != super::LifecyclePhase::Preparing)
            || custody.replacement_identity.as_deref() == Some(custody.original_identity.as_str())
            || !digest(&custody.previous_sha256)
            || !digest(&custody.proposed_sha256)
            || (custody.previous_sha256 != canonical.previous_sha256
                && !(allow_pristine_runtime
                    && custody.previous_sha256 == canonical.proposed_sha256))
            || custody.proposed_sha256 != canonical.proposed_sha256
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn validate_activation(
    library: &Library,
    operation: &LifecycleOperation,
    payload: &ActivationSettingsJournal,
) -> Result<()> {
    let target = operation.install.as_ref().ok_or_else(invalid)?;
    let previous = &payload.previous;
    crate::archive::validate_relative_path(&payload.relative_path, false)?;
    crate::archive::validate_relative_path(&operation.port_id, false)?;
    if operation.kind != LifecycleOperationKind::Activate
        || operation.activate
        || !operation.original_paths.is_empty()
        || operation.paths.staging.is_some()
        || operation.paths.final_path.is_some()
        || operation.paths.quarantine.is_some()
        || operation.port_id.contains(['/', '\\'])
        || payload.format_version != 1
        || payload.relative_path.len() > 512
        || payload.relative_path.contains(['\\', ':'])
        || payload.file_id.is_empty()
        || payload.file_id.len() > 64
        || payload.maximum_bytes == 0
        || payload.maximum_bytes > crate::game_settings::MAX_SETTINGS_BYTES
        || previous.id == target.id
        || previous.path == target.path
        || previous.staged
        || !target.staged
    {
        return Err(invalid());
    }
    for install in [previous, target] {
        if install.port_id != operation.port_id
            || install.id.is_empty()
            || install.id.len() > 128
            || !install.verified
            || !digest(&install.manifest_sha256)
            || !digest(&install.artifact.sha256)
            || install.artifact.size == 0
        {
            return Err(invalid());
        }
        crate::output_root::validate_install_path(library, &operation.port_id, &install.path)?;
    }
    let canonical_path = library
        .user_dir(&operation.port_id)
        .join(&payload.relative_path);
    if let Some(deletion) = &payload.deletion {
        if payload.canonical.is_some()
            || payload.runtime_projection_launch_id.is_some()
            || payload.runtime.is_some()
            || payload.previous_runtime.is_some()
            || !Uuid::parse_str(&deletion.restore_id)
                .is_ok_and(|id| id.to_string() == deletion.restore_id)
            || deletion.canonical.path != canonical_path
            || !identity(&deletion.canonical.parent_identity)
            || !identity(&deletion.previous_runtime.parent_identity)
            || !identity(&deletion.incoming.parent_identity)
            || !identity(&deletion.incoming.original_identity)
            || deletion.canonical.parent_identity == deletion.previous_runtime.parent_identity
            || deletion.canonical.parent_identity == deletion.incoming.parent_identity
            || deletion.previous_runtime.parent_identity == deletion.incoming.parent_identity
        {
            return Err(invalid());
        }
        for (path, root) in [
            (&deletion.previous_runtime.path, &previous.path),
            (&deletion.incoming.path, &target.path),
        ] {
            let relative = path.strip_prefix(root).map_err(|_| invalid())?;
            crate::archive::validate_relative_path(
                &relative.to_string_lossy().replace('\\', "/"),
                false,
            )?;
            if !relative.ends_with(&payload.relative_path) {
                return Err(invalid());
            }
        }
        owned_names(&deletion.incoming.path, &operation.id, "runtime")?;
        return Ok(());
    }
    let canonical = payload.canonical.as_ref().ok_or_else(invalid)?;
    if canonical.path != canonical_path
        || canonical.previous_sha256 == canonical.proposed_sha256
        || payload
            .runtime_projection_launch_id
            .as_ref()
            .is_some_and(|id| {
                payload.previous_runtime.is_none()
                    || !Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == *id)
            })
    {
        return Err(invalid());
    }
    if let Some(runtime) = &payload.runtime {
        let relative = runtime
            .path
            .strip_prefix(&target.path)
            .map_err(|_| invalid())?;
        crate::archive::validate_relative_path(
            &relative.to_string_lossy().replace('\\', "/"),
            false,
        )?;
        if runtime.path == canonical.path
            || !relative.ends_with(&payload.relative_path)
            || runtime.parent_identity == canonical.parent_identity
            || duplicate_physical_objects(canonical, runtime)
        {
            return Err(invalid());
        }
        owned_names(&runtime.path, &operation.id, "runtime")?;
    }
    if let Some(witness) = &payload.previous_runtime {
        let relative = witness
            .path
            .strip_prefix(&previous.path)
            .map_err(|_| invalid())?;
        crate::archive::validate_relative_path(
            &relative.to_string_lossy().replace('\\', "/"),
            false,
        )?;
        if !relative.ends_with(&payload.relative_path)
            || !identity(&witness.parent_identity)
            || !identity(&witness.original_identity)
            || std::iter::once(canonical)
                .chain(payload.runtime.iter())
                .any(|leg| {
                    leg.path == witness.path
                        || leg.original_identity == witness.original_identity
                        || leg.replacement_identity.as_deref()
                            == Some(witness.original_identity.as_str())
                })
        {
            return Err(invalid());
        }
    }
    owned_names(&canonical.path, &operation.id, "canonical")?;
    validate_legs(operation.phase, canonical, payload.runtime.as_ref(), true)
}

fn duplicate_physical_objects(left: &FileCustody, right: &FileCustody) -> bool {
    std::iter::once(left.original_identity.as_str())
        .chain(left.replacement_identity.as_deref())
        .any(|identity| {
            identity == right.original_identity
                || right.replacement_identity.as_deref() == Some(identity)
        })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{ArtifactIdentity, ReleaseChannel, operation::OperationStore};

    fn record(library: &Library) -> LifecycleOperation {
        let id = Uuid::new_v4().to_string();
        let path = library.user_dir("shipwright").join("shipofharkinian.json");
        let (new, old) = owned_names(&path, &id, "canonical").unwrap();
        let mut operation =
            LifecycleOperation::new(id, LifecycleOperationKind::SettingsChange, "shipwright");
        operation.paths.staging = Some(new);
        operation.paths.quarantine = Some(old);
        operation.paths.final_path = Some(path.clone());
        operation.game_settings = Some(SettingsJournal {
            format_version: 1,
            install: InstallRecord {
                id: "inert-settings-install".into(),
                port_id: "shipwright".into(),
                version: "9.3.1".into(),
                path: library
                    .versions_dir()
                    .join("shipwright/inert-settings-install"),
                channel: ReleaseChannel::Stable,
                installed_at: 1,
                verified: true,
                staged: false,
                artifact: ArtifactIdentity::default(),
                runtime: None,
                manifest_sha256: "a".repeat(64),
                selected_executable: "soh.exe".into(),
            },
            definition_sha256: "b".repeat(64),
            file_id: "preferences".into(),
            relative_path: "shipofharkinian.json".into(),
            maximum_bytes: 1024,
            review: crate::GameSettingReview {
                port_id: "shipwright".into(),
                install_id: "inert-settings-install".into(),
                file_id: "preferences".into(),
                setting_id: "master-volume".into(),
                label: "Master volume".into(),
                path: "shipofharkinian.json".into(),
                change: crate::GameSettingChange::Reset,
                previous_value: Some(serde_json::json!(70)),
                proposed_value: serde_json::json!(40),
                configuration_sha256: "c".repeat(64),
                review_sha256: "e".repeat(64),
            },
            canonical: FileCustody {
                path,
                parent_identity: format!("win128:{:016x}:{:032x}", 1, 11),
                original_identity: format!("win128:{:016x}:{:032x}", 1, 22),
                replacement_identity: Some(format!("win128:{:016x}:{:032x}", 1, 33)),
                previous_sha256: "c".repeat(64),
                proposed_sha256: "d".repeat(64),
            },
            runtime: None,
        });
        std::fs::create_dir_all(&operation.game_settings.as_ref().unwrap().install.path).unwrap();
        operation
    }

    pub(crate) fn activation_record(library: &Library) -> LifecycleOperation {
        let scalar = record(library).game_settings.unwrap();
        let mut previous = scalar.install;
        previous.artifact.sha256 = "a".repeat(64);
        previous.artifact.size = 10;
        let mut target = previous.clone();
        target.id = "inert-settings-successor".into();
        target.version = "9.3.2".into();
        target.staged = true;
        target.artifact.sha256 = "b".repeat(64);
        target.manifest_sha256 = "e".repeat(64);
        target.path = library
            .versions_dir()
            .join("shipwright/inert-settings-successor");
        std::fs::create_dir_all(&target.path).unwrap();
        let runtime = FileCustody {
            path: target.path.join("wrapper").join(&scalar.relative_path),
            parent_identity: format!("win128:{:016x}:{:032x}", 2, 11),
            original_identity: format!("win128:{:016x}:{:032x}", 2, 22),
            replacement_identity: Some(format!("win128:{:016x}:{:032x}", 2, 33)),
            previous_sha256: scalar.canonical.previous_sha256.clone(),
            proposed_sha256: scalar.canonical.proposed_sha256.clone(),
        };
        let mut activation = LifecycleOperation::new(
            Uuid::new_v4().to_string(),
            LifecycleOperationKind::Activate,
            "shipwright",
        );
        activation.install = Some(target);
        activation.settings_activation = Some(ActivationSettingsJournal {
            format_version: 1,
            file_id: scalar.file_id,
            relative_path: scalar.relative_path,
            maximum_bytes: scalar.maximum_bytes,
            previous_runtime: Some(SettingsFileWitness {
                path: previous.path.join(&scalar.relative_path),
                parent_identity: format!("win128:{:016x}:{:032x}", 3, 11),
                original_identity: format!("win128:{:016x}:{:032x}", 3, 22),
            }),
            canonical: Some(scalar.canonical),
            runtime: Some(runtime),
            deletion: None,
            runtime_projection_launch_id: None,
            previous,
        });
        activation
    }

    #[test]
    fn settings_activation_custody_holds_one_port_and_current_writer_refuses_to_emit_it() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let store = OperationStore::new(library.clone());
        let mut activation = activation_record(&library);
        assert!(validate_journal(&library, &activation).is_ok());
        let error = store.put(&mut activation).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert!(store.get(&activation.id).unwrap().is_none());

        let mut legacy = activation.clone();
        legacy.settings_activation = None;
        store.put(&mut legacy).unwrap();
        assert!(library.try_lock_port("shipwright", "launch").is_ok());

        // Simulate a future-writer recovery row in an isolated library. The
        // current writer must preserve it without running legacy activation.
        let encoded = serde_json::to_string(&activation.settings_activation).unwrap();
        let payload = activation.settings_activation.as_ref().unwrap();
        for path in [
            &payload.canonical.as_ref().unwrap().path,
            &payload.runtime.as_ref().unwrap().path,
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"owned preimage").unwrap();
        }
        library.connection().unwrap().execute(
            "UPDATE lifecycle_operations SET game_settings_json=?2,phase='payload_published' WHERE id=?1",
            rusqlite::params![activation.id, encoded],
        ).unwrap();
        let observed = store.get(&activation.id).unwrap().unwrap();
        assert_eq!(
            observed.phase,
            super::super::LifecyclePhase::PayloadPublished
        );
        assert_eq!(
            serde_json::to_string(&observed.settings_activation).unwrap(),
            encoded
        );
        assert!(store.put(&mut legacy).is_err());
        assert!(store.remove(&activation.id).is_err());
        assert!(library.try_lock_port("shipwright", "launch").is_err());
        assert!(
            library
                .try_lock_port("shipwright", "collect-user-data")
                .is_err()
        );
        assert!(library.try_lock_port("another-port", "launch").is_ok());
        assert!(
            library
                .try_lock_port_for_settings_recovery("shipwright", "foreign")
                .is_err()
        );
        drop(
            library
                .try_lock_port_for_settings_recovery("shipwright", &activation.id)
                .unwrap(),
        );

        let _service = crate::PortcoveService::new(library.clone()).unwrap();
        assert!(store.get(&activation.id).unwrap().is_some());
        assert_eq!(
            std::fs::read(&payload.canonical.as_ref().unwrap().path).unwrap(),
            b"owned preimage"
        );
        assert_eq!(
            std::fs::read(&payload.runtime.as_ref().unwrap().path).unwrap(),
            b"owned preimage"
        );
        assert!(library.try_lock_port("shipwright", "launch").is_err());
    }

    #[test]
    fn settings_activation_refuses_foreign_routes_aliases_and_unbound_published_legs() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let valid = activation_record(&library);
        for mutation in 0..8 {
            let mut changed = valid.clone();
            let payload = changed.settings_activation.as_mut().unwrap();
            let runtime = payload.runtime.as_mut().unwrap();
            match mutation {
                0 => payload.previous.port_id = "foreign-port".into(),
                1 => payload.previous.path = changed.install.as_ref().unwrap().path.clone(),
                2 => runtime.path = payload.previous.path.join(&payload.relative_path),
                3 => {
                    runtime.replacement_identity = Some(
                        payload
                            .canonical
                            .as_ref()
                            .unwrap()
                            .original_identity
                            .clone(),
                    )
                }
                4 => runtime.previous_sha256 = "f".repeat(64),
                5 => {
                    changed.phase = super::super::LifecyclePhase::PayloadPublished;
                    runtime.replacement_identity = None;
                }
                6 => changed.kind = LifecycleOperationKind::Install,
                _ => {
                    payload.previous_runtime.as_mut().unwrap().original_identity = payload
                        .canonical
                        .as_ref()
                        .unwrap()
                        .original_identity
                        .clone()
                }
            }
            assert!(
                validate_journal(&library, &changed).is_err(),
                "mutation {mutation}"
            );
        }
        let mut encoded = serde_json::to_value(valid.settings_activation.unwrap()).unwrap();
        encoded["unknown_execution"] = serde_json::json!("refused");
        assert!(decode_activation(Some(&encoded.to_string())).is_err());
    }

    #[test]
    fn settings_activation_detects_a_committed_pointer_with_a_lagging_journal() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let mut operation = activation_record(&library);
        operation.phase = LifecyclePhase::PayloadPublished;
        let previous = &operation.settings_activation.as_ref().unwrap().previous;
        let target = operation.install.as_ref().unwrap();
        library.register_install(previous, true).unwrap();
        library.register_install(target, false).unwrap();
        let status = || {
            library
                .status("shipwright", ReleaseChannel::Stable)
                .unwrap()
        };
        assert_eq!(
            activation_pointer(&operation, &status()).unwrap(),
            SettingsActivationPointer::PreviousActive
        );

        let mut stale = target.clone();
        stale.manifest_sha256 = "f".repeat(64);
        assert!(library.activate_staged_exact(previous, &stale).is_err());
        assert_eq!(
            activation_pointer(&operation, &status()).unwrap(),
            SettingsActivationPointer::PreviousActive
        );

        library.activate_staged_exact(previous, target).unwrap();
        // Stop after the library commits but before the journal records it.
        assert_eq!(operation.phase, LifecyclePhase::PayloadPublished);
        assert_eq!(
            activation_pointer(&operation, &status()).unwrap(),
            SettingsActivationPointer::TargetActive
        );
        assert!(library.activate_staged_exact(previous, target).is_err());
        assert_eq!(status().previous.unwrap().id, previous.id);
        operation.phase = LifecyclePhase::Prepared;
        assert!(activation_pointer(&operation, &status()).is_err());
    }

    #[test]
    fn settings_journal_round_trip_holds_port_until_exact_owner_recovery() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let store = OperationStore::new(library.clone());
        #[cfg(windows)]
        assert!(
            matches!(library.root().components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
        );
        let mut operation = record(&library);
        store.put(&mut operation).unwrap();
        let retained = store.get(&operation.id).unwrap().unwrap();
        let diagnostic = store.diagnostic_inventory().unwrap();
        assert_eq!(diagnostic.report.decoded_rows, 1);
        assert!(diagnostic.report.problems.is_empty());
        assert_eq!(diagnostic.decoded[0].id, operation.id);
        assert_eq!(
            serde_json::to_value(&retained.game_settings).unwrap(),
            serde_json::to_value(&operation.game_settings).unwrap()
        );
        assert!(library.try_lock_port("shipwright", "launch").is_err());
        assert!(
            library
                .try_lock_port("shipwright", "collect-user-data")
                .is_err()
        );
        assert!(
            library
                .try_lock_port_for_settings_recovery("shipwright", "foreign")
                .is_err()
        );
        let guard = library
            .try_lock_port_for_settings_recovery("shipwright", &operation.id)
            .unwrap();
        assert!(library.try_lock_port("shipwright", "launch").is_err());
        drop(guard);
        store.remove(&operation.id).unwrap();
        assert!(library.try_lock_port("shipwright", "launch").is_ok());
    }

    #[test]
    fn settings_journal_refuses_foreign_family_path_identity_and_encoding() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let valid = record(&library);
        let mut foreign = valid.clone();
        foreign.kind = LifecycleOperationKind::Activate;
        assert!(foreign.validate_family().is_err());
        for mutation in 0..8 {
            let mut changed = valid.clone();
            let payload = changed.game_settings.as_mut().unwrap();
            match mutation {
                0 => payload.format_version = 2,
                1 => payload.relative_path = "../outside.json".into(),
                2 => payload.canonical.path = temporary.path().join("foreign.json"),
                3 => {
                    payload.canonical.replacement_identity =
                        Some(payload.canonical.original_identity.clone())
                }
                4 => payload.definition_sha256 = "unknown".into(),
                5 => changed.paths.quarantine = Some(temporary.path().join("foreign.old")),
                6 => payload.install.port_id = "another-port".into(),
                _ => {
                    payload.install.path = temporary.path().join("foreign-install");
                    std::fs::create_dir_all(&payload.install.path).unwrap();
                }
            }
            assert!(validate_journal(&library, &changed).is_err());
        }
        let mut encoded = serde_json::to_value(valid.game_settings.unwrap()).unwrap();
        encoded["unknown_execution"] = serde_json::json!("refused");
        assert!(decode_journal(Some(&encoded.to_string())).is_err());
        assert!(decode_journal(Some(&"x".repeat(16385))).is_err());
    }

    #[test]
    fn new_nullable_family_column_preserves_old_row_and_foreign_failed_evidence() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let store = OperationStore::new(library.clone());
        let mut old = LifecycleOperation::new(
            "old-install-operation",
            LifecycleOperationKind::Install,
            "shipwright",
        );
        old.last_error = Some("original failure remains failed".into());
        store.put(&mut old).unwrap();
        assert!(store.get(&old.id).unwrap().unwrap().game_settings.is_none());
        let mut settings = record(&library);
        store.put(&mut settings).unwrap();
        let connection = library.connection().unwrap();
        let old_raw: Option<String> = connection
            .query_row(
                "SELECT game_settings_json FROM lifecycle_operations WHERE id=?1",
                [&old.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(old_raw.is_none());
        connection.execute("UPDATE lifecycle_operations SET game_settings_json=replace(game_settings_json,'\"format_version\":1','\"format_version\":2') WHERE id=?1", [&settings.id]).unwrap();
        let before: String = connection
            .query_row(
                "SELECT game_settings_json FROM lifecycle_operations WHERE id=?1",
                [&settings.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(store.get(&settings.id).is_err());
        assert!(store.all().is_err());
        let diagnostic = store.diagnostic_inventory().unwrap();
        assert!(diagnostic.report.enumeration_complete);
        assert_eq!(diagnostic.report.enumerated_rows, 2);
        assert_eq!(diagnostic.report.decoded_rows, 1);
        assert!(!diagnostic.report.related_assessments_complete);
        assert_eq!(diagnostic.decoded[0].id, old.id);
        assert_eq!(diagnostic.report.problems.len(), 1);
        let problem = &diagnostic.report.problems[0];
        assert_eq!(problem.operation_id.as_deref(), Some(settings.id.as_str()));
        assert_eq!(problem.operation_kind.as_deref(), Some("settings_change"));
        assert_eq!(problem.stage, crate::JournalValidationStage::Payload);
        let after: String = connection
            .query_row(
                "SELECT game_settings_json FROM lifecycle_operations WHERE id=?1",
                [&settings.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(
            store.get(&old.id).unwrap().unwrap().last_error,
            old.last_error
        );
    }

    #[test]
    fn settings_custody_names_and_runtime_root_refuse_aliases() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        for id in [
            "ABCDEF12-3456-7890-ABCD-EF1234567890",
            "abcdef1234567890abcdef1234567890",
            "urn:uuid:abcdef12-3456-7890-abcd-ef1234567890",
        ] {
            assert!(owned_names(&library.root().join("config.json"), id, "canonical").is_err());
        }
        let mut operation = record(&library);
        let payload = operation.game_settings.as_mut().unwrap();
        let outside = temporary.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        payload.install.path = outside.clone();
        let mut runtime = payload.canonical.clone();
        runtime.path = outside.join("shipofharkinian.json");
        payload.runtime = Some(runtime);
        assert!(validate_journal(&library, &operation).is_err());
        for value in [
            "win128:1:11",
            "win128:0000000000000001:00000000000000000000000000000000",
            "arbitrary",
        ] {
            assert!(!identity(value));
        }
    }
}
