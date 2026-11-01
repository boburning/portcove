//! One canonical settings commit and its checked persistence projection. The
//! journal fences normal port operations until both postimages and cleanup are
//! verified. Foreign bytes are never replaced during recovery.

use super::*;
use crate::game_settings::{document, windows::HeldFile};
use crate::operation::game_settings::{FileCustody, SettingsJournal, owned_names};
use crate::operation::{LifecycleFaultInjector, SettingsFaultPoint};

fn checkpoint(faults: &dyn LifecycleFaultInjector, point: SettingsFaultPoint) -> Result<()> {
    faults.check(LifecycleFaultPoint::SettingsBoundary(point))
}

fn conflict() -> PortcoveError {
    PortcoveError::conflict(
        "configuration custody changed; preserve the files and review recovery before another change",
    )
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn persist_checked(store: &OperationStore, operation: &mut LifecycleOperation) -> Result<()> {
    store.put(operation)?;
    confirm_persisted(store, operation)
}

fn confirm_persisted(store: &OperationStore, operation: &LifecycleOperation) -> Result<()> {
    let current = store.get(&operation.id)?.ok_or_else(conflict)?;
    if current.id != operation.id
        || current.kind != operation.kind
        || current.port_id != operation.port_id
        || current.created_at != operation.created_at
        || current.phase != operation.phase
        || current.paths.staging != operation.paths.staging
        || current.paths.final_path != operation.paths.final_path
        || current.paths.quarantine != operation.paths.quarantine
        || serde_json::to_value(&current.game_settings)?
            != serde_json::to_value(&operation.game_settings)?
    {
        return Err(conflict());
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LegState {
    Before,
    Gap,
    Published,
    Cleaned,
}

struct Leg {
    live: Option<HeldFile>,
    stage: Option<HeldFile>,
    old: Option<HeldFile>,
    state: LegState,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}

fn open_optional(path: &Path) -> Result<Option<HeldFile>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(_) => HeldFile::open(path).map(Some),
    }
}

fn checked_bytes(
    held: &mut HeldFile,
    custody: &FileCustody,
    original: bool,
    maximum: u64,
) -> Result<Vec<u8>> {
    let expected = if original {
        &custody.original_identity
    } else {
        custody.replacement_identity.as_ref().ok_or_else(conflict)?
    };
    if &held.identity != expected || held.parent_identity != custody.parent_identity {
        return Err(conflict());
    }
    let bytes = held.bytes(maximum)?;
    let expected_hash = if original {
        &custody.previous_sha256
    } else {
        &custody.proposed_sha256
    };
    if hash(&bytes) != *expected_hash {
        return Err(conflict());
    }
    Ok(bytes)
}

impl Leg {
    fn open(custody: &FileCustody, id: &str, role: &str, maximum: u64) -> Result<Self> {
        let (stage_path, old_path) = owned_names(&custody.path, id, role)?;
        let mut live = open_optional(&custody.path)?;
        let mut stage = open_optional(&stage_path)?;
        let mut old = open_optional(&old_path)?;
        let state = match (
            live.as_ref().map(|held| held.identity.as_str()),
            stage.is_some(),
            old.is_some(),
        ) {
            (Some(identity), true, false) if identity == custody.original_identity => {
                LegState::Before
            }
            (None, true, true) => LegState::Gap,
            (Some(identity), false, true)
                if Some(identity) == custody.replacement_identity.as_deref() =>
            {
                LegState::Published
            }
            (Some(identity), false, false)
                if Some(identity) == custody.replacement_identity.as_deref() =>
            {
                LegState::Cleaned
            }
            _ => return Err(conflict()),
        };
        let before = match state {
            LegState::Before => Some(checked_bytes(
                live.as_mut().unwrap(),
                custody,
                true,
                maximum,
            )?),
            LegState::Gap | LegState::Published => Some(checked_bytes(
                old.as_mut().unwrap(),
                custody,
                true,
                maximum,
            )?),
            LegState::Cleaned => None,
        };
        let after = match state {
            LegState::Before | LegState::Gap => {
                checked_bytes(stage.as_mut().unwrap(), custody, false, maximum)?
            }
            LegState::Published | LegState::Cleaned => {
                checked_bytes(live.as_mut().unwrap(), custody, false, maximum)?
            }
        };
        Ok(Self {
            live,
            stage,
            old,
            state,
            before,
            after,
        })
    }

    fn publish(
        &mut self,
        custody: &FileCustody,
        id: &str,
        role: &str,
        maximum: u64,
        faults: &dyn LifecycleFaultInjector,
    ) -> Result<()> {
        let (_, old_path) = owned_names(&custody.path, id, role)?;
        if self.state == LegState::Before {
            let mut original = self.live.take().ok_or_else(conflict)?;
            checked_bytes(&mut original, custody, true, maximum)?;
            self.stage
                .as_ref()
                .ok_or_else(conflict)?
                .verify_security_matches(&original)?;
            original.move_to(&old_path)?;
            checked_bytes(&mut original, custody, true, maximum)?;
            self.old = Some(original);
            self.state = LegState::Gap;
            checkpoint(
                faults,
                if role == "canonical" {
                    SettingsFaultPoint::CanonicalMoved
                } else {
                    SettingsFaultPoint::RuntimeMoved
                },
            )?;
        }
        if self.state == LegState::Gap {
            let mut replacement = self.stage.take().ok_or_else(conflict)?;
            replacement.verify_security_matches(self.old.as_ref().ok_or_else(conflict)?)?;
            checked_bytes(&mut replacement, custody, false, maximum)?;
            replacement.move_to(&custody.path)?;
            checked_bytes(&mut replacement, custody, false, maximum)?;
            self.live = Some(replacement);
            self.state = LegState::Published;
            checkpoint(
                faults,
                if role == "canonical" {
                    SettingsFaultPoint::CanonicalPublished
                } else {
                    SettingsFaultPoint::RuntimePublished
                },
            )?;
        }
        if self.state != LegState::Published {
            return Err(conflict());
        }
        Ok(())
    }

    fn retire_preimage(&mut self, custody: &FileCustody, maximum: u64) -> Result<()> {
        checked_bytes(
            self.live.as_mut().ok_or_else(conflict)?,
            custody,
            false,
            maximum,
        )?;
        if let Some(mut old) = self.old.take() {
            checked_bytes(&mut old, custody, true, maximum)?;
            old.retire()?;
        }
        self.state = LegState::Cleaned;
        Ok(())
    }
}

fn custody(original: &HeldFile, previous_sha256: &str, proposed_sha256: &str) -> FileCustody {
    FileCustody {
        path: original.path.clone(),
        parent_identity: original.parent_identity.clone(),
        original_identity: original.identity.clone(),
        replacement_identity: None,
        previous_sha256: previous_sha256.into(),
        proposed_sha256: proposed_sha256.into(),
    }
}

impl PortcoveService {
    fn prepare_settings_stages(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
        context: &SettingsContext,
        file: &GameSettingsFile,
    ) -> Result<()> {
        let payload = operation
            .game_settings
            .as_ref()
            .ok_or_else(conflict)?
            .clone();
        let mut canonical = HeldFile::open(&payload.canonical.path)?;
        canonical.require_editable_security()?;
        let before = checked_bytes(
            &mut canonical,
            &payload.canonical,
            true,
            payload.maximum_bytes,
        )?;
        let mut runtime = payload
            .runtime
            .as_ref()
            .map(|leg| HeldFile::open(&leg.path))
            .transpose()?;
        if let Some((held, custody)) = runtime.as_mut().zip(payload.runtime.as_ref()) {
            held.require_editable_security()?;
            if checked_bytes(held, custody, true, payload.maximum_bytes)? != before {
                return Err(conflict());
            }
        }
        for (role, custody) in std::iter::once(("canonical", &payload.canonical))
            .chain(payload.runtime.as_ref().map(|leg| ("runtime", leg)))
        {
            let (_, old) = owned_names(&custody.path, &operation.id, role)?;
            match fs::symlink_metadata(&old) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                _ => return Err(conflict()),
            }
        }
        let index = file
            .settings
            .iter()
            .position(|setting| setting.id == payload.review.setting_id)
            .ok_or_else(conflict)?;
        let setting = &file.settings[index];
        let proposed = match &payload.review.change {
            GameSettingChange::Set { value } => value.clone(),
            GameSettingChange::Reset => setting.value.default_value(),
        };
        let bytes = document::edit(file, &before, &setting.id, &proposed)?;
        if hash(&bytes) != payload.canonical.proposed_sha256
            || payload.review.label != setting.label
            || document::read(file, &before)?.get(index) != Some(&payload.review.previous_value)
            || document::read(file, &bytes)?.get(index)
                != Some(&Some(payload.review.proposed_value.clone()))
            || review_binding(
                context,
                file,
                &payload.review,
                &payload.canonical.proposed_sha256,
                ReviewObjects {
                    canonical: (
                        &payload.canonical.original_identity,
                        &payload.canonical.parent_identity,
                    ),
                    runtime: payload
                        .runtime
                        .as_ref()
                        .map(|leg| (leg.original_identity.as_str(), leg.parent_identity.as_str())),
                },
            )? != payload.review.review_sha256
        {
            return Err(conflict());
        }
        self.prepare_settings_stage(store, operation, "canonical", &bytes, &canonical)?;
        if payload.runtime.is_some() {
            checkpoint(self.faults.as_ref(), SettingsFaultPoint::BetweenStages)?;
            self.prepare_settings_stage(
                store,
                operation,
                "runtime",
                &bytes,
                runtime.as_ref().ok_or_else(conflict)?,
            )?;
        }
        Ok(())
    }

    fn prepare_settings_stage(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
        role: &str,
        bytes: &[u8],
        original: &HeldFile,
    ) -> Result<()> {
        use crate::game_settings::windows::StageCheckpoint;
        let payload = operation.game_settings.as_ref().ok_or_else(conflict)?;
        let custody = if role == "canonical" {
            &payload.canonical
        } else {
            payload.runtime.as_ref().ok_or_else(conflict)?
        }
        .clone();
        let (new, _) = owned_names(&custody.path, &operation.id, role)?;
        let mut stage = if let Some(expected) = &custody.replacement_identity {
            let stage = HeldFile::open_stage(&new)?;
            if &stage.identity != expected || stage.parent_identity != custody.parent_identity {
                return Err(conflict());
            }
            stage
        } else {
            checkpoint(
                self.faults.as_ref(),
                if role == "canonical" {
                    SettingsFaultPoint::CanonicalStageBeforeCreate
                } else {
                    SettingsFaultPoint::RuntimeStageBeforeCreate
                },
            )?;
            // Even empty or byte-identical unbound entries are unknown; the
            // durable intent keeps them discoverable without adopting them.
            match fs::symlink_metadata(&new) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Ok(_) => return Err(PortcoveError::conflict("unbound configuration staging requires review; original files and staging were preserved").detail("settings_stage_state", "unbound_existing")),
                Err(error) => return Err(error.into()),
            }
            let stage = HeldFile::create_stage(&new)?;
            if stage.parent_identity != custody.parent_identity {
                return Err(conflict());
            }
            checkpoint(
                self.faults.as_ref(),
                if role == "canonical" {
                    SettingsFaultPoint::CanonicalStageCreated
                } else {
                    SettingsFaultPoint::RuntimeStageCreated
                },
            )?;
            let payload = operation.game_settings.as_mut().ok_or_else(conflict)?;
            let target = if role == "canonical" {
                &mut payload.canonical
            } else {
                payload.runtime.as_mut().ok_or_else(conflict)?
            };
            target.replacement_identity = Some(stage.identity.clone());
            persist_checked(store, operation)?;
            checkpoint(
                self.faults.as_ref(),
                if role == "canonical" {
                    SettingsFaultPoint::CanonicalStageBound
                } else {
                    SettingsFaultPoint::RuntimeStageBound
                },
            )?;
            stage
        };
        confirm_persisted(store, operation)?;
        stage.preserve_security_from(original)?;
        stage.fill_stage(bytes, &|point| {
            checkpoint(
                self.faults.as_ref(),
                match (role, point) {
                    ("canonical", StageCheckpoint::PartialWrite) => {
                        SettingsFaultPoint::CanonicalStagePartialWrite
                    }
                    ("canonical", StageCheckpoint::BeforeFlush) => {
                        SettingsFaultPoint::CanonicalStageBeforeFlush
                    }
                    ("canonical", StageCheckpoint::Flushed) => {
                        SettingsFaultPoint::CanonicalStageFlushed
                    }
                    (_, StageCheckpoint::PartialWrite) => {
                        SettingsFaultPoint::RuntimeStagePartialWrite
                    }
                    (_, StageCheckpoint::BeforeFlush) => {
                        SettingsFaultPoint::RuntimeStageBeforeFlush
                    }
                    (_, StageCheckpoint::Flushed) => SettingsFaultPoint::RuntimeStageFlushed,
                },
            )
        })?;
        if hash(&stage.bytes(bytes.len() as u64)?) != custody.proposed_sha256 {
            return Err(conflict());
        }
        Ok(())
    }

    pub fn apply_game_setting(
        &self,
        port_id: &str,
        file_id: &str,
        setting_id: &str,
        change: GameSettingChange,
        review_sha256: &str,
    ) -> Result<GameSettingsView> {
        let _ownership = self.library.try_lock_port(port_id, "apply-game-setting")?;
        let context = self.settings_context_already_locked(port_id)?;
        let prepared = self.prepare_settings_change(&context, file_id, setting_id, change)?;
        if prepared.review.review_sha256 != review_sha256 {
            return Err(PortcoveError::conflict(
                "settings review is stale; read the configuration and review again",
            ));
        }
        let file = context
            .port
            .game_settings
            .as_ref()
            .unwrap()
            .files
            .iter()
            .find(|file| file.id == file_id)
            .unwrap();
        let activity = self.library.begin_activity(
            ActivityOperation::SettingsChange,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let (canonical_new, canonical_old) =
            owned_names(&prepared.canonical.path, &activity.id, "canonical")?;
        let previous_sha256 = &prepared.review.configuration_sha256;
        let proposed_sha256 = hash(&prepared.bytes);
        let payload = SettingsJournal {
            format_version: 1,
            install: context.install.clone(),
            definition_sha256: context.definition_sha256.clone(),
            file_id: file_id.into(),
            relative_path: file.path.clone(),
            maximum_bytes: file.maximum_bytes,
            review: prepared.review.clone(),
            canonical: custody(&prepared.canonical, previous_sha256, &proposed_sha256),
            runtime: prepared
                .runtime
                .as_ref()
                .map(|original| custody(original, previous_sha256, &proposed_sha256)),
        };
        let mut operation = LifecycleOperation::new(
            &activity.id,
            LifecycleOperationKind::SettingsChange,
            port_id,
        );
        operation.paths.staging = Some(canonical_new);
        operation.paths.quarantine = Some(canonical_old);
        operation.paths.final_path = Some(prepared.canonical.path.clone());
        operation.game_settings = Some(payload);
        let store = OperationStore::new(self.library.clone());
        if let Err(error) = checkpoint(self.faults.as_ref(), SettingsFaultPoint::IntentBeforeInsert)
            .and_then(|()| persist_checked(&store, &mut operation))
        {
            // No stage has been created. Ambiguous journal commits remain
            // discoverable; a later exact-owner recovery revalidates intent.
            let _ = self.library.finish_activity(
                &activity.id,
                ActivityStatus::Failed,
                Some(&error.message),
            );
            return Err(error);
        }
        drop(prepared);
        // Reacquisition is intentional: the same checked recovery engine is
        // used immediately and after restart. Every physical/byte preimage is
        // checked again before an original is moved.
        if let Err(error) = checkpoint(self.faults.as_ref(), SettingsFaultPoint::Journaled)
            .and_then(|()| self.recover_settings_change(&store, &mut operation))
        {
            if let Ok(Some(mut current)) = store.get(&activity.id) {
                current.last_error = Some(error.message.clone());
                let _ = store.put(&mut current);
            }
            let _ = self.library.finish_activity(
                &activity.id,
                ActivityStatus::Failed,
                Some(&error.message),
            );
            return Err(error);
        }
        self.library.finish_activity(
            &activity.id,
            ActivityStatus::Succeeded,
            Some("reviewed configuration change and runtime projection verified"),
        )?;
        self.settings_view_already_locked(&context)
    }

    pub(in crate::service) fn recover_settings_change(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        crate::operation::game_settings::validate_journal(&self.library, operation)?;
        let initial = operation
            .game_settings
            .as_ref()
            .ok_or_else(conflict)?
            .clone();
        let context = self.settings_context_already_locked(&operation.port_id)?;
        if serde_json::to_value(&context.install)? != serde_json::to_value(&initial.install)?
            || context.definition_sha256 != initial.definition_sha256
        {
            return Err(conflict());
        }
        let file = context
            .port
            .game_settings
            .as_ref()
            .unwrap()
            .files
            .iter()
            .find(|file| file.id == initial.file_id)
            .ok_or_else(conflict)?;
        let expected_runtime = (!context.direct).then(|| context.runtime_root.join(&file.path));
        if file.path != initial.relative_path
            || file.maximum_bytes != initial.maximum_bytes
            || initial.canonical.path != self.library.user_dir(&operation.port_id).join(&file.path)
            || initial.runtime.as_ref().map(|leg| &leg.path) != expected_runtime.as_ref()
        {
            return Err(conflict());
        }
        if operation.phase == LifecyclePhase::Preparing {
            self.prepare_settings_stages(store, operation, &context, file)?;
        }
        let payload = operation
            .game_settings
            .as_ref()
            .ok_or_else(conflict)?
            .clone();
        let mut canonical = Leg::open(
            &payload.canonical,
            &operation.id,
            "canonical",
            payload.maximum_bytes,
        )?;
        let mut runtime = payload
            .runtime
            .as_ref()
            .map(|leg| Leg::open(leg, &operation.id, "runtime", payload.maximum_bytes))
            .transpose()?;
        let index = file
            .settings
            .iter()
            .position(|setting| setting.id == payload.review.setting_id)
            .ok_or_else(conflict)?;
        let setting = &file.settings[index];
        if payload.review.label != setting.label {
            return Err(conflict());
        }
        let proposed = match &payload.review.change {
            GameSettingChange::Set { value } => value.clone(),
            GameSettingChange::Reset => setting.value.default_value(),
        };
        for leg in std::iter::once(&canonical).chain(runtime.iter()) {
            if let Some(before) = &leg.before {
                if document::read(file, before)?.get(index) != Some(&payload.review.previous_value)
                    || document::edit(file, before, &setting.id, &proposed)? != leg.after
                {
                    return Err(conflict());
                }
            }
            if document::read(file, &leg.after)?.get(index)
                != Some(&Some(payload.review.proposed_value.clone()))
            {
                return Err(conflict());
            }
        }
        let binding = review_binding(
            &context,
            file,
            &payload.review,
            &payload.canonical.proposed_sha256,
            ReviewObjects {
                canonical: (
                    &payload.canonical.original_identity,
                    &payload.canonical.parent_identity,
                ),
                runtime: payload
                    .runtime
                    .as_ref()
                    .map(|leg| (leg.original_identity.as_str(), leg.parent_identity.as_str())),
            },
        )?;
        if binding != payload.review.review_sha256 {
            return Err(conflict());
        }
        let runtime_state = runtime.as_ref().map(|leg| leg.state);
        let allowed = match operation.phase {
            LifecyclePhase::Preparing => {
                canonical.state == LegState::Before
                    && runtime_state.is_none_or(|state| state == LegState::Before)
            }
            LifecyclePhase::Prepared => {
                canonical.state != LegState::Cleaned
                    && runtime_state.is_none_or(|state| state == LegState::Before)
            }
            LifecyclePhase::PayloadPublished => {
                canonical.state == LegState::Published
                    && runtime_state.is_none_or(|state| state != LegState::Cleaned)
            }
            LifecyclePhase::MetadataCommitted => {
                canonical.state == LegState::Published
                    && runtime_state.is_none_or(|state| state == LegState::Published)
            }
            LifecyclePhase::CleanupPending => {
                matches!(canonical.state, LegState::Published | LegState::Cleaned)
                    && runtime_state.is_none_or(|state| {
                        matches!(state, LegState::Published | LegState::Cleaned)
                    })
            }
        };
        if !allowed {
            return Err(conflict());
        }
        if operation.phase == LifecyclePhase::Preparing {
            operation.phase = LifecyclePhase::Prepared;
            persist_checked(store, operation)?;
            checkpoint(self.faults.as_ref(), SettingsFaultPoint::Prepared)?;
        }
        if operation.phase == LifecyclePhase::Prepared {
            canonical.publish(
                &payload.canonical,
                &operation.id,
                "canonical",
                payload.maximum_bytes,
                self.faults.as_ref(),
            )?;
            operation.phase = LifecyclePhase::PayloadPublished;
            persist_checked(store, operation)?;
        }
        if operation.phase == LifecyclePhase::PayloadPublished {
            if let Some((leg, custody)) = runtime.as_mut().zip(payload.runtime.as_ref()) {
                leg.publish(
                    custody,
                    &operation.id,
                    "runtime",
                    payload.maximum_bytes,
                    self.faults.as_ref(),
                )?;
            }
            operation.phase = LifecyclePhase::MetadataCommitted;
            persist_checked(store, operation)?;
            checkpoint(self.faults.as_ref(), SettingsFaultPoint::MetadataCommitted)?;
        }
        if operation.phase == LifecyclePhase::MetadataCommitted {
            operation.phase = LifecyclePhase::CleanupPending;
            persist_checked(store, operation)?;
            checkpoint(self.faults.as_ref(), SettingsFaultPoint::CleanupPending)?;
        }
        canonical.retire_preimage(&payload.canonical, payload.maximum_bytes)?;
        checkpoint(self.faults.as_ref(), SettingsFaultPoint::CanonicalRetired)?;
        if let Some((leg, custody)) = runtime.as_mut().zip(payload.runtime.as_ref()) {
            leg.retire_preimage(custody, payload.maximum_bytes)?;
            checkpoint(self.faults.as_ref(), SettingsFaultPoint::RuntimeRetired)?;
        }
        store.remove(&operation.id)?;
        checkpoint(self.faults.as_ref(), SettingsFaultPoint::JournalRetired)?;
        Ok(())
    }
}
