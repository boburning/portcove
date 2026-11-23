//! Typed stages of an upstream setup that Portcove does not own.
//!
//! A pending setup keeps the verified download and the player's place in the
//! upstream steps that follow it, so closing Portcove, cancelling or a crash
//! resumes at that place instead of starting over. Each stage is bound to the
//! exact retained source, artifact role and definition it began with; a change
//! invalidates the stage with a typed reason instead of continuing silently.
//!
//! No stage makes Portcove the owner of the upstream setup's output. An upstream
//! setup that exits, even with code 0, is never completion: completion is the
//! player's selection plus Core's verification of what was selected, followed
//! by the existing reviewed, non-owning registration.
use super::*;
use crate::route_facts::{self, ArtifactFact, ArtifactRole, AssetIdentity, FactSource, RoleClaim};

/// Record format of a pending setup that carries a typed stage. Formats 1
/// (GitHub) and 2 (GitLab) remain readable and map to their stage on read.
pub(super) const STAGED_RECORD_FORMAT: u8 = 3;

/// Where the player is in an upstream setup, and what that place is bound to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PendingSetupProgress {
    /// Absent only for a record written before stages existed. Core binds it
    /// to the current facts when the player first continues that setup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<PendingSetupBinding>,
    pub stage: PendingSetupStage,
    pub updated_at: String,
}

/// The exact facts a stage belongs to. Any change invalidates the stage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PendingSetupBinding {
    /// Upstream project or release address of the retained listing.
    pub source_url: String,
    /// Digest of the strict definition and selection known for this port, or
    /// of their absence for a listing-only project.
    pub definition_sha256: String,
    /// Typed route fact for the downloaded artifact. A filename suggestion
    /// describes it; it never authorizes a runtime.
    pub artifact_role: ArtifactRole,
    pub role_source: FactSource,
    pub retained: RetainedSetupBytes,
}

/// Verified bytes the setup folder retains, rechecked before each stage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RetainedSetupBytes {
    /// The downloaded package itself, kept unextracted in the setup folder.
    Package {
        file: String,
        sha256: String,
        size: u64,
    },
    /// Files extracted from the package; the publication receipt binds them
    /// to the downloaded archive digest.
    Extracted { archive_sha256: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PendingSetupStageKind {
    ArtifactObtained,
    UpstreamSetupOpened,
    PlayerActionNeeded,
    FinalSelected,
    RegistrationReviewed,
    Invalidated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "stage", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PendingSetupStage {
    /// The verified package is retained; nothing has been run.
    ArtifactObtained,
    /// Portcove handed the upstream setup to the player.
    UpstreamSetupOpened {
        handoff: UpstreamSetupHandoff,
        opened_at: String,
    },
    /// Portcove waits for the player's named next action.
    PlayerActionNeeded {
        action: PlayerSetupAction,
        /// The upstream setup's reported exit code, when one was reported.
        /// It never decides completion.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
    },
    /// The player chose the resulting program and Core checked it.
    FinalSelected { selection: SelectedSetupResult },
    /// The player confirmed this registration plan.
    RegistrationReviewed {
        selection: SelectedSetupResult,
        preview_sha256: String,
    },
    /// A bound fact changed; the earlier stage cannot continue.
    Invalidated {
        previous: PendingSetupStageKind,
        reason: PendingSetupInvalidation,
    },
}

impl PendingSetupStage {
    pub fn kind(&self) -> PendingSetupStageKind {
        match self {
            Self::ArtifactObtained => PendingSetupStageKind::ArtifactObtained,
            Self::UpstreamSetupOpened { .. } => PendingSetupStageKind::UpstreamSetupOpened,
            Self::PlayerActionNeeded { .. } => PendingSetupStageKind::PlayerActionNeeded,
            Self::FinalSelected { .. } => PendingSetupStageKind::FinalSelected,
            Self::RegistrationReviewed { .. } => PendingSetupStageKind::RegistrationReviewed,
            Self::Invalidated { .. } => PendingSetupStageKind::Invalidated,
        }
    }

    /// The last stage that could continue, for an invalidation record.
    fn resumable_kind(&self) -> PendingSetupStageKind {
        match self {
            Self::Invalidated { previous, .. } => *previous,
            stage => stage.kind(),
        }
    }

    fn selection(&self) -> Option<&SelectedSetupResult> {
        match self {
            Self::FinalSelected { selection } | Self::RegistrationReviewed { selection, .. } => {
                Some(selection)
            }
            _ => None,
        }
    }
}

/// What Portcove handed to the player. Portcove never runs the upstream
/// installer itself from a pending setup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum UpstreamSetupHandoff {
    /// The retained setup folder was opened.
    Folder,
    /// The retained upstream setup guide was opened.
    Guide { url: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PlayerSetupAction {
    FinishUpstreamSetup,
    ChooseInstalledGame,
    RetryUpstreamSetup,
}

/// Identity facts of the program the player chose, as Core checked them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SelectedSetupResult {
    pub executable: PathBuf,
    pub working_directory: PathBuf,
    pub arguments: Vec<String>,
    pub executable_sha256: String,
    pub executable_size: u64,
    pub version: String,
    pub selected_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PendingSetupInvalidation {
    /// The current listing names another upstream source.
    SourceChanged { current_source_url: String },
    /// The strict definition or its selection changed.
    DefinitionChanged,
    /// A complete upstream observation or reviewed pin names a newer release.
    ReleaseSuperseded { current_release_tag: String },
    /// A download restriction now holds for these exact bytes.
    RestrictionHolds { explanation: String },
    /// Typed route facts now give the artifact a different role.
    ArtifactRoleChanged { current_role: ArtifactRole },
    /// The retained package or its receipt changed or is missing.
    RetainedBytesChanged,
    /// The chosen program changed or is missing.
    SelectedResultChanged,
}

/// A player's action or an adapter's observation that moves the stage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "event", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PendingSetupEvent {
    UpstreamSetupOpened {
        handoff: UpstreamSetupHandoff,
    },
    /// The upstream setup process ended. Its exit code is recorded, never
    /// treated as completion.
    UpstreamSetupExited {
        exit_code: Option<i32>,
    },
    PlayerActionNeeded {
        action: PlayerSetupAction,
    },
    ResultSelected {
        executable: PathBuf,
        working_directory: PathBuf,
        arguments: Vec<String>,
    },
}

/// Core's player explanation: what happened, then what to do next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PendingSetupMessage {
    pub summary: String,
    pub next_step: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PendingSetupResume {
    pub port_id: String,
    pub pending_id: String,
    pub stage: PendingSetupStageKind,
    pub message: PendingSetupMessage,
    pub record: PendingSetupRecord,
}

fn role_phrase(role: ArtifactRole) -> &'static str {
    match role {
        ArtifactRole::DesktopGameRuntime => "a game package",
        ArtifactRole::DesktopGameData => "game data",
        ArtifactRole::DedicatedServer => "a server program",
        ArtifactRole::Builder => "a build tool",
        ArtifactRole::Installer => "an installer",
        ArtifactRole::Importer => "an import tool",
        ArtifactRole::Compiler => "a compiler",
        ArtifactRole::DevTool => "a development tool",
        ArtifactRole::OriginalGameInput => "original game files",
        ArtifactRole::MobilePackage => "a mobile package",
        ArtifactRole::ConsoleOutput => "a console package",
        ArtifactRole::Documentation => "documentation",
        ArtifactRole::SourceArchive => "source code",
        ArtifactRole::IntegrityMetadata => "a checksum file",
        ArtifactRole::DebugSymbols => "debug symbols",
        ArtifactRole::Unknown => "an unidentified file",
    }
}

const KEEP_FILES: &str = "Your files stay where they are.";

/// Player explanation for one stage. Core owns this text; clients show it.
pub fn pending_setup_message(
    stage: &PendingSetupStage,
    role: Option<ArtifactRole>,
) -> PendingSetupMessage {
    let message = |summary: String, next_step: String| PendingSetupMessage { summary, next_step };
    let setup_tool = matches!(
        role,
        Some(ArtifactRole::Installer | ArtifactRole::Builder | ArtifactRole::Importer)
    );
    match stage {
        PendingSetupStage::ArtifactObtained => message(
            "Portcove downloaded the package. Nothing from it has been run.".into(),
            if setup_tool {
                "Open the setup folder and run the upstream installer.".into()
            } else {
                "Open the setup folder and follow the upstream setup steps.".into()
            },
        ),
        PendingSetupStage::UpstreamSetupOpened { handoff, .. } => message(
            match handoff {
                UpstreamSetupHandoff::Folder => "You opened the setup folder.",
                UpstreamSetupHandoff::Guide { .. } => "You opened the upstream setup guide.",
            }
            .into(),
            "Finish the upstream setup steps. Then choose the installed game program.".into(),
        ),
        PendingSetupStage::PlayerActionNeeded { action, exit_code } => match action {
            PlayerSetupAction::FinishUpstreamSetup => message(
                "Upstream setup is not finished yet.".into(),
                "Finish the upstream setup steps. Then choose the installed game program.".into(),
            ),
            PlayerSetupAction::ChooseInstalledGame => message(
                "Upstream setup closed. Portcove hasn't checked what it installed.".into(),
                "Choose the installed game program so Portcove can check it.".into(),
            ),
            PlayerSetupAction::RetryUpstreamSetup => message(
                match exit_code {
                    Some(code) => format!(
                        "Upstream setup closed with exit code {code}. It might not have finished."
                    ),
                    None => "Upstream setup closed before it finished.".into(),
                },
                "Run the upstream setup again. If it finished, choose the installed game program."
                    .into(),
            ),
        },
        PendingSetupStage::FinalSelected { selection } => message(
            format!(
                "You chose {}. Portcove checked that it is a native program for this computer.",
                selection
                    .executable
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "a program".into())
            ),
            "Review the program, start folder and launch options. Then add the game to Portcove."
                .into(),
        ),
        PendingSetupStage::RegistrationReviewed { .. } => message(
            "You reviewed how Portcove will add this game.".into(),
            format!("Confirm to add the game to Portcove. {KEEP_FILES}"),
        ),
        PendingSetupStage::Invalidated { reason, .. } => invalidation_message(reason),
    }
}

fn invalidation_message(reason: &PendingSetupInvalidation) -> PendingSetupMessage {
    let (summary, next_step) = match reason {
        PendingSetupInvalidation::SourceChanged { .. } => (
            "The catalog now lists a different upstream project for this game.".to_owned(),
            format!("Forget this setup, then download the package again. {KEEP_FILES}"),
        ),
        PendingSetupInvalidation::DefinitionChanged => (
            "The catalog changed how this port is set up since you started.".to_owned(),
            format!("Forget this setup, then download the package again. {KEEP_FILES}"),
        ),
        PendingSetupInvalidation::ReleaseSuperseded {
            current_release_tag,
        } => (
            format!("Release {current_release_tag} replaced the release you downloaded."),
            format!("Forget this setup, then download {current_release_tag}. {KEEP_FILES}"),
        ),
        PendingSetupInvalidation::RestrictionHolds { explanation } => (
            format!("Portcove can no longer continue with this download. {explanation}"),
            format!("Forget this setup. {KEEP_FILES}"),
        ),
        PendingSetupInvalidation::ArtifactRoleChanged { current_role } => (
            format!(
                "Portcove now identifies the downloaded file as {}.",
                role_phrase(*current_role)
            ),
            format!("Forget this setup, then choose a package again. {KEEP_FILES}"),
        ),
        PendingSetupInvalidation::RetainedBytesChanged => (
            "The downloaded package changed or is missing since Portcove checked it.".to_owned(),
            format!("Forget this setup, then download the package again. {KEEP_FILES}"),
        ),
        PendingSetupInvalidation::SelectedResultChanged => (
            "The game program you chose changed or is missing since Portcove checked it."
                .to_owned(),
            "Choose the installed game program again.".to_owned(),
        ),
    };
    PendingSetupMessage { summary, next_step }
}

impl PendingSetupRecord {
    /// The typed stage, mapped for records written before stages existed.
    /// A download that has not finished has no setup stage yet.
    pub fn stage_kind(&self) -> Option<PendingSetupStageKind> {
        self.progress.as_ref().map(|progress| progress.stage.kind())
    }

    /// Core's player explanation for this record's current stage.
    pub fn stage_message(&self) -> Option<PendingSetupMessage> {
        let progress = self.progress.as_ref()?;
        Some(pending_setup_message(
            &progress.stage,
            progress
                .binding
                .as_ref()
                .map(|binding| binding.artifact_role),
        ))
    }

    /// Identity a registration review binds. Stage progress is excluded so a
    /// recorded review does not invalidate the authorization it records.
    pub(crate) fn continuation_identity(&self) -> Result<serde_json::Value> {
        let mut identity = self.clone();
        identity.progress = None;
        identity.format_version = 1;
        Ok(serde_json::to_value(identity)?)
    }
}

/// Read-only mapping of an earlier record to its stage.
pub(super) fn map_legacy_stage(record: &mut PendingSetupRecord) {
    if record.progress.is_none() && record.state == PendingSetupState::Downloaded {
        record.progress = Some(PendingSetupProgress {
            binding: None,
            stage: PendingSetupStage::ArtifactObtained,
            updated_at: record.downloaded_at.clone(),
        });
    }
}

/// The legacy mapping is never written back; only a bound stage is durable.
pub(super) fn storage_form(
    record: &PendingSetupRecord,
) -> std::borrow::Cow<'_, PendingSetupRecord> {
    match &record.progress {
        Some(progress) if progress.binding.is_none() => {
            let mut legacy = record.clone();
            legacy.progress = None;
            std::borrow::Cow::Owned(legacy)
        }
        _ => std::borrow::Cow::Borrowed(record),
    }
}

pub(super) fn validate_progress(record: &PendingSetupRecord) -> Result<()> {
    let Some(progress) = &record.progress else {
        return Ok(());
    };
    let Some(binding) = &progress.binding else {
        return Err(PortcoveError::verification(
            "a stored setup stage lost its binding",
        ));
    };
    let text_ok =
        |value: &str, limit: usize| value.len() <= limit && !value.chars().any(char::is_control);
    let digest_ok = |value: &str| super::is_digest(value);
    let retained_ok = match &binding.retained {
        RetainedSetupBytes::Package { file, sha256, size } => {
            *file == record.artifact.name
                && sha256.eq_ignore_ascii_case(&record.archive_sha256)
                && *size == record.artifact.size
        }
        RetainedSetupBytes::Extracted { archive_sha256 } => {
            archive_sha256.eq_ignore_ascii_case(&record.archive_sha256)
        }
    };
    let selection_ok = |selection: &SelectedSetupResult| {
        selection.executable.is_absolute()
            && selection.working_directory.is_absolute()
            && digest_ok(&selection.executable_sha256)
            && selection.arguments.len() <= 64
            && selection
                .arguments
                .iter()
                .all(|argument| text_ok(argument, 4096))
            && text_ok(&selection.version, 512)
            && text_ok(&selection.selected_at, 128)
    };
    let stage_ok = match &progress.stage {
        PendingSetupStage::ArtifactObtained => true,
        PendingSetupStage::UpstreamSetupOpened { handoff, opened_at } => {
            text_ok(opened_at, 128)
                && match handoff {
                    UpstreamSetupHandoff::Folder => true,
                    UpstreamSetupHandoff::Guide { url } => text_ok(url, 4096),
                }
        }
        PendingSetupStage::PlayerActionNeeded { .. } => true,
        PendingSetupStage::FinalSelected { selection } => selection_ok(selection),
        PendingSetupStage::RegistrationReviewed {
            selection,
            preview_sha256,
        } => selection_ok(selection) && digest_ok(preview_sha256),
        PendingSetupStage::Invalidated { previous, reason } => {
            *previous != PendingSetupStageKind::Invalidated
                && match reason {
                    PendingSetupInvalidation::SourceChanged { current_source_url } => {
                        text_ok(current_source_url, 4096)
                    }
                    PendingSetupInvalidation::ReleaseSuperseded {
                        current_release_tag,
                    } => text_ok(current_release_tag, 512),
                    PendingSetupInvalidation::RestrictionHolds { explanation } => {
                        text_ok(explanation, 2048)
                    }
                    _ => true,
                }
        }
    };
    if record.format_version != STAGED_RECORD_FORMAT
        || record.state != PendingSetupState::Downloaded
        || !digest_ok(&record.archive_sha256)
        || !text_ok(&binding.source_url, 4096)
        || !digest_ok(&binding.definition_sha256)
        || !text_ok(&progress.updated_at, 128)
        || !retained_ok
        || !stage_ok
    {
        return Err(PortcoveError::verification(
            "pending setup stage does not match its retained download",
        ));
    }
    Ok(())
}

fn clock() -> Result<String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| PortcoveError::state(error.to_string()))
}

#[cfg(test)]
pub(super) mod fault {
    use std::cell::Cell;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum StageWriteFault {
        BeforeCommit,
        AfterCommit,
    }

    thread_local! {
        static FAULT: Cell<Option<StageWriteFault>> = const { Cell::new(None) };
    }

    pub(crate) fn set(fault: Option<StageWriteFault>) {
        FAULT.with(|cell| cell.set(fault));
    }

    pub(super) fn check(point: StageWriteFault) -> crate::Result<()> {
        if FAULT.with(Cell::get) == Some(point) {
            FAULT.with(|cell| cell.set(None));
            return Err(crate::PortcoveError::state("injected stage write fault"));
        }
        Ok(())
    }
}

fn source_url(listing: &PortListing) -> &str {
    listing
        .release_url
        .as_deref()
        .unwrap_or(&listing.project_url)
}

impl PortcoveService {
    fn pending_definition_sha256(&self, port_id: &str) -> Result<String> {
        Ok(crate::signed_catalog::digest(&serde_json::to_vec(&(
            "pending-setup-definition-v1",
            self.catalog.port(port_id).ok(),
            self.catalog.definition_selection(port_id),
        ))?))
    }

    /// Typed route facts for the retained artifact under the current catalog.
    fn pending_artifact_fact(&self, record: &PendingSetupRecord) -> ArtifactFact {
        let mut claims: Vec<RoleClaim> =
            vec![route_facts::suggest_from_filename(&record.artifact.name).claim()];
        if let Ok(port) = self.catalog.port(&record.port_id)
            && let Some(claim) = route_facts::structured_claim(port, &record.archive_sha256)
        {
            claims.push(claim);
        }
        route_facts::assign_role(
            AssetIdentity {
                asset_id: record.artifact.asset_id.github_id().unwrap_or_default(),
                name: &record.artifact.name,
                size: record.artifact.size,
                sha256: Some(&record.archive_sha256),
            },
            &claims,
        )
    }

    /// Bind a stage to the current facts. The retained form is read from the
    /// published folder: an unextracted package keeps its own file there.
    fn bind_pending_setup(&self, stored: &StoredDownload) -> Result<PendingSetupBinding> {
        let record = &stored.record;
        let package = record.path.join(&record.artifact.name);
        let retained = if fs::symlink_metadata(&package).is_ok_and(|metadata| metadata.is_file()) {
            RetainedSetupBytes::Package {
                file: record.artifact.name.clone(),
                sha256: record.archive_sha256.to_ascii_lowercase(),
                size: record.artifact.size,
            }
        } else {
            RetainedSetupBytes::Extracted {
                archive_sha256: record.archive_sha256.to_ascii_lowercase(),
            }
        };
        let fact = self.pending_artifact_fact(record);
        Ok(PendingSetupBinding {
            source_url: source_url(&record.listing).to_owned(),
            definition_sha256: self.pending_definition_sha256(&record.port_id)?,
            artifact_role: fact.role,
            role_source: fact.source,
            retained,
        })
    }

    /// The first stage of a download being handed off now.
    pub(super) fn publication_progress(
        &self,
        record: &PendingSetupRecord,
        extracted: bool,
    ) -> Result<PendingSetupProgress> {
        let archive_sha256 = record.archive_sha256.to_ascii_lowercase();
        let fact = self.pending_artifact_fact(record);
        Ok(PendingSetupProgress {
            binding: Some(PendingSetupBinding {
                source_url: source_url(&record.listing).to_owned(),
                definition_sha256: self.pending_definition_sha256(&record.port_id)?,
                artifact_role: fact.role,
                role_source: fact.source,
                retained: if extracted {
                    RetainedSetupBytes::Extracted { archive_sha256 }
                } else {
                    RetainedSetupBytes::Package {
                        file: record.artifact.name.clone(),
                        sha256: archive_sha256,
                        size: record.artifact.size,
                    }
                },
            }),
            stage: PendingSetupStage::ArtifactObtained,
            updated_at: record.downloaded_at.clone(),
        })
    }

    /// A newer release named by the current listing's complete observation or
    /// by its reviewed pin for this host. Incomplete coverage is unknown and
    /// never invalidates.
    fn superseding_release(&self, record: &PendingSetupRecord) -> Option<String> {
        let listing = self.catalog.listing(&record.port_id).ok()?;
        let bound = &record.artifact.release_tag;
        if let (Some(maintenance), Ok(platform)) =
            (&listing.release_maintenance, Platform::current())
            && let Some(pin) = maintenance
                .pinned_releases
                .iter()
                .find(|pin| pin.platform == platform)
        {
            return (pin.version != *bound).then(|| pin.version.clone());
        }
        let observation = listing.upstream_observation.as_ref()?;
        if observation.status != crate::ListingObservationStatus::Complete {
            return None;
        }
        let bound_release = observation
            .releases
            .iter()
            .find(|release| release.id == record.artifact.release_id);
        if bound_release.is_some_and(|release| release.provider_prerelease) {
            // A chosen preview release is compared only with later previews'
            // channel, which this observation does not establish.
            return None;
        }
        let newest = observation
            .releases
            .iter()
            .filter(|release| !release.provider_prerelease)
            .max_by(|left, right| left.published_at.cmp(&right.published_at))?;
        if newest.id == record.artifact.release_id {
            return None;
        }
        match bound_release {
            Some(release) if release.published_at >= newest.published_at => None,
            _ => Some(newest.version.clone()),
        }
    }

    /// Recheck every bound fact. The first changed fact is the reason.
    fn pending_setup_invalidation(
        &self,
        stored: &StoredDownload,
        binding: &PendingSetupBinding,
        stage: &PendingSetupStage,
    ) -> Result<Option<PendingSetupInvalidation>> {
        let record = &stored.record;
        if let Ok(listing) = self.catalog.listing(&record.port_id) {
            let current = source_url(listing);
            if current != binding.source_url {
                return Ok(Some(PendingSetupInvalidation::SourceChanged {
                    current_source_url: current.to_owned(),
                }));
            }
        }
        if self.pending_definition_sha256(&record.port_id)? != binding.definition_sha256 {
            return Ok(Some(PendingSetupInvalidation::DefinitionChanged));
        }
        if let Some(explanation) = EffectiveRestrictions::of(&self.catalog, &record.port_id)
            .evaluate(&download_artifact_subject(
                &record.artifact.release_tag,
                &record.artifact.name,
                Some(&record.archive_sha256),
                Phase::Final,
            ))
            .explanation()
        {
            return Ok(Some(PendingSetupInvalidation::RestrictionHolds {
                explanation: explanation.chars().take(2048).collect(),
            }));
        }
        if let Some(current_release_tag) = self.superseding_release(record) {
            return Ok(Some(PendingSetupInvalidation::ReleaseSuperseded {
                current_release_tag,
            }));
        }
        let fact = self.pending_artifact_fact(record);
        if fact.role != binding.artifact_role {
            return Ok(Some(PendingSetupInvalidation::ArtifactRoleChanged {
                current_role: fact.role,
            }));
        }
        let retained_matches = match &binding.retained {
            RetainedSetupBytes::Package { file, sha256, size } => {
                let path = record.path.join(file);
                refuse_symlink_ancestors(&path)?;
                fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file())
                    && crate::adapter::hash_file_bounded_with_checkpoint(&path, *size, || Ok(()))
                        .is_ok_and(|(actual, _)| actual.eq_ignore_ascii_case(sha256))
            }
            RetainedSetupBytes::Extracted { .. } => {
                self.publication_receipt_matches(stored).unwrap_or(false)
            }
        };
        if !retained_matches {
            return Ok(Some(PendingSetupInvalidation::RetainedBytesChanged));
        }
        if let Some(selection) = stage.selection()
            && !selection_matches(selection)
        {
            return Ok(Some(PendingSetupInvalidation::SelectedResultChanged));
        }
        Ok(None)
    }

    fn stored_pending_setup(&self, port_id: &str, pending_id: &str) -> Result<StoredDownload> {
        stored_downloads_from(&self.library.connection()?)?
            .into_iter()
            .find(|stored| stored.record.port_id == port_id && stored.record.id == pending_id)
            .ok_or_else(|| PortcoveError::conflict("pending setup changed or no longer exists"))
    }

    /// Replace exactly the row that was read. SQLite commits the whole record
    /// or nothing, so an interruption leaves the earlier or the later stage.
    fn write_pending_stage(
        &self,
        stored: &StoredDownload,
        record: &PendingSetupRecord,
    ) -> Result<()> {
        let json = encoded_download_record(record)?;
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_download_record_capacity(&transaction, &record.port_id, &json)?;
        let changed = transaction.execute(
            "UPDATE catalog_downloads SET record_json=?4
             WHERE port_id=?1 AND pending_id=?2 AND record_json=?3 AND phase='downloaded'",
            params![record.port_id, record.id, stored.record_json, json],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "pending setup changed while its stage was saved",
            ));
        }
        #[cfg(test)]
        fault::check(fault::StageWriteFault::BeforeCommit)?;
        transaction.commit()?;
        #[cfg(test)]
        fault::check(fault::StageWriteFault::AfterCommit)?;
        Ok(())
    }

    /// The bound stage of a finished download, binding an earlier record now.
    fn staged_progress(
        &self,
        stored: &StoredDownload,
    ) -> Result<(PendingSetupBinding, PendingSetupStage)> {
        if stored.record.state != PendingSetupState::Downloaded || stored.phase != "downloaded" {
            return Err(PortcoveError::conflict(
                "resolve the download recovery before continuing setup",
            ));
        }
        let progress = stored
            .record
            .progress
            .clone()
            .ok_or_else(|| PortcoveError::state("downloaded setup has no stage"))?;
        let binding = match progress.binding {
            Some(binding) => binding,
            None => self.bind_pending_setup(stored)?,
        };
        Ok((binding, progress.stage))
    }

    fn save_stage(
        &self,
        stored: &StoredDownload,
        binding: PendingSetupBinding,
        stage: PendingSetupStage,
    ) -> Result<PendingSetupRecord> {
        let mut record = stored.record.clone();
        record.format_version = STAGED_RECORD_FORMAT;
        record.reason = None;
        record.progress = Some(PendingSetupProgress {
            binding: Some(binding),
            stage,
            updated_at: clock()?,
        });
        self.write_pending_stage(stored, &record)?;
        Ok(record)
    }

    /// Recheck the bound facts and persist an invalidation. Returns the error
    /// a caller reports when the stage cannot continue.
    fn require_current_stage(
        &self,
        stored: &StoredDownload,
        binding: &PendingSetupBinding,
        stage: &PendingSetupStage,
    ) -> Result<Option<PendingSetupRecord>> {
        if matches!(stage, PendingSetupStage::Invalidated { .. }) {
            return Ok(None);
        }
        let Some(reason) = self.pending_setup_invalidation(stored, binding, stage)? else {
            return Ok(None);
        };
        let stage = PendingSetupStage::Invalidated {
            previous: stage.kind(),
            reason,
        };
        Ok(Some(self.save_stage(stored, binding.clone(), stage)?))
    }

    fn resume_view(record: PendingSetupRecord) -> Result<PendingSetupResume> {
        let stage = record
            .stage_kind()
            .ok_or_else(|| PortcoveError::state("downloaded setup has no stage"))?;
        let message = record
            .stage_message()
            .ok_or_else(|| PortcoveError::state("downloaded setup has no stage"))?;
        Ok(PendingSetupResume {
            port_id: record.port_id.clone(),
            pending_id: record.id.clone(),
            stage,
            message,
            record,
        })
    }

    fn invalidated_error(record: &PendingSetupRecord) -> PortcoveError {
        let message = record
            .stage_message()
            .map(|message| format!("{} {}", message.summary, message.next_step))
            .unwrap_or_else(|| "This setup can no longer continue.".into());
        let mut error = PortcoveError::conflict(message);
        if let Some(PendingSetupStage::Invalidated { reason, .. }) =
            record.progress.as_ref().map(|progress| &progress.stage)
            && let Ok(value) = serde_json::to_value(reason)
            && let Some(kind) = value.get("kind").and_then(|kind| kind.as_str())
        {
            error = error.detail("invalidation", kind);
        }
        error
    }

    /// Continue a saved setup at the stage the player reached. Completed work
    /// is not repeated: retained bytes are rechecked against their digest, not
    /// downloaded again. A changed bound fact invalidates the stage.
    pub fn resume_pending_setup(
        &self,
        port_id: &str,
        pending_id: &str,
    ) -> Result<PendingSetupResume> {
        let _lock = self
            .library
            .try_lock_port(port_id, "resume-pending-setup")?;
        let stored = self.stored_pending_setup(port_id, pending_id)?;
        let (binding, stage) = self.staged_progress(&stored)?;
        if let Some(invalidated) = self.require_current_stage(&stored, &binding, &stage)? {
            return Self::resume_view(invalidated);
        }
        let record = if stored
            .record
            .progress
            .as_ref()
            .is_some_and(|progress| progress.binding.is_some())
        {
            stored.record
        } else {
            self.save_stage(&stored, binding, stage)?
        };
        Self::resume_view(record)
    }

    /// Move a saved setup to its next stage. The upstream setup's exit never
    /// completes it; only a selection Core checks can.
    pub fn advance_pending_setup(
        &self,
        port_id: &str,
        pending_id: &str,
        event: PendingSetupEvent,
    ) -> Result<PendingSetupResume> {
        let _lock = self
            .library
            .try_lock_port(port_id, "advance-pending-setup")?;
        let stored = self.stored_pending_setup(port_id, pending_id)?;
        let (binding, stage) = self.staged_progress(&stored)?;
        // A new selection replaces an earlier one, so only the setup's own
        // bound facts are rechecked first. A changed chosen program can be
        // chosen again; every other invalidation needs the setup forgotten.
        let selecting = matches!(event, PendingSetupEvent::ResultSelected { .. });
        if let PendingSetupStage::Invalidated { reason, .. } = &stage
            && !(selecting && *reason == PendingSetupInvalidation::SelectedResultChanged)
        {
            return Err(Self::invalidated_error(&stored.record));
        }
        let checked = if selecting {
            PendingSetupStage::ArtifactObtained
        } else {
            stage.clone()
        };
        if let Some(reason) = self.pending_setup_invalidation(&stored, &binding, &checked)? {
            let invalidated = self.save_stage(
                &stored,
                binding,
                PendingSetupStage::Invalidated {
                    previous: stage.resumable_kind(),
                    reason,
                },
            )?;
            return Err(Self::invalidated_error(&invalidated));
        }
        let selected = stage.selection().is_some();
        let next = match event {
            PendingSetupEvent::UpstreamSetupOpened { handoff } => {
                if let UpstreamSetupHandoff::Guide { url } = &handoff
                    && !retained_setup_guide(&stored.record, url)
                {
                    return Err(PortcoveError::usage(
                        "This link is not the saved setup guide.",
                    ));
                }
                if selected {
                    // Reopening setup keeps the checked selection.
                    stage.clone()
                } else {
                    PendingSetupStage::UpstreamSetupOpened {
                        handoff,
                        opened_at: clock()?,
                    }
                }
            }
            PendingSetupEvent::UpstreamSetupExited { exit_code } => match stage.clone() {
                PendingSetupStage::UpstreamSetupOpened { .. }
                | PendingSetupStage::PlayerActionNeeded { .. } => {
                    PendingSetupStage::PlayerActionNeeded {
                        action: if exit_code.is_none_or(|code| code == 0) {
                            PlayerSetupAction::ChooseInstalledGame
                        } else {
                            PlayerSetupAction::RetryUpstreamSetup
                        },
                        exit_code,
                    }
                }
                stage if selected => stage,
                _ => {
                    return Err(PortcoveError::conflict(
                        "upstream setup was not opened for this download",
                    ));
                }
            },
            PendingSetupEvent::PlayerActionNeeded { action } => {
                if selected {
                    return Err(PortcoveError::conflict(
                        "a checked game program is already chosen for this setup",
                    ));
                }
                PendingSetupStage::PlayerActionNeeded {
                    action,
                    exit_code: None,
                }
            }
            PendingSetupEvent::ResultSelected {
                executable,
                working_directory,
                arguments,
            } => PendingSetupStage::FinalSelected {
                selection: self.checked_setup_selection(
                    port_id,
                    &executable,
                    &working_directory,
                    &arguments,
                )?,
            },
        };
        let record = if next == stage
            && stored
                .record
                .progress
                .as_ref()
                .is_some_and(|progress| progress.binding.is_some())
        {
            stored.record
        } else {
            self.save_stage(&stored, binding, next)?
        };
        Self::resume_view(record)
    }

    /// Record that the player opened this setup's upstream handoff: the
    /// folder, or a retained setup guide. A release page is not setup and a
    /// download still in recovery has no stage; neither changes anything.
    pub fn note_pending_setup_opened(
        &self,
        port_id: &str,
        pending_id: &str,
        guide_url: Option<&str>,
    ) -> Result<Option<PendingSetupResume>> {
        let stored = self.stored_pending_setup(port_id, pending_id)?;
        if stored.record.progress.is_none() {
            return Ok(None);
        }
        let handoff = match guide_url {
            None => UpstreamSetupHandoff::Folder,
            Some(url) if retained_setup_guide(&stored.record, url) => {
                UpstreamSetupHandoff::Guide { url: url.into() }
            }
            Some(_) => return Ok(None),
        };
        self.advance_pending_setup(
            port_id,
            pending_id,
            PendingSetupEvent::UpstreamSetupOpened { handoff },
        )
        .map(Some)
    }

    /// Core's own check of the player's choice: the same native-program,
    /// path-ownership and argument checks as registration review.
    fn checked_setup_selection(
        &self,
        port_id: &str,
        executable: &Path,
        working_directory: &Path,
        arguments: &[String],
    ) -> Result<SelectedSetupResult> {
        let preview =
            self.preview_user_selected_runtime(port_id, executable, working_directory, arguments)?;
        selected_result(&preview)
    }

    /// Record the registration plan the player just confirmed. A record still
    /// in download recovery or invalidated keeps its state; registration
    /// itself rechecks the stage.
    pub(crate) fn record_pending_registration_review(
        &self,
        port_id: &str,
        preview: &crate::ExternalRuntimePreview,
    ) -> Result<()> {
        let Some(stored) = stored_downloads_from(&self.library.connection()?)?
            .into_iter()
            .find(|stored| stored.record.port_id == port_id)
        else {
            return Ok(());
        };
        if stored.record.state != PendingSetupState::Downloaded || stored.phase != "downloaded" {
            return Ok(());
        }
        let _lock = self
            .library
            .try_lock_port(port_id, "review-pending-setup-registration")?;
        let stored = self.stored_pending_setup(port_id, &stored.record.id)?;
        let (binding, stage) = self.staged_progress(&stored)?;
        if let PendingSetupStage::Invalidated { reason, .. } = &stage
            && *reason != PendingSetupInvalidation::SelectedResultChanged
        {
            return Err(Self::invalidated_error(&stored.record));
        }
        if let Some(reason) = self.pending_setup_invalidation(
            &stored,
            &binding,
            &PendingSetupStage::ArtifactObtained,
        )? {
            let invalidated = self.save_stage(
                &stored,
                binding,
                PendingSetupStage::Invalidated {
                    previous: stage.resumable_kind(),
                    reason,
                },
            )?;
            return Err(Self::invalidated_error(&invalidated));
        }
        // The preview just checked the program it names; an earlier choice
        // is replaced by this reviewed one.
        let selection = selected_result(preview)?;
        self.save_stage(
            &stored,
            binding,
            PendingSetupStage::RegistrationReviewed {
                selection,
                preview_sha256: preview.preview_sha256.clone(),
            },
        )?;
        Ok(())
    }

    /// Registration completes a staged setup only while its bound facts hold.
    pub(crate) fn require_pending_setup_continuable(&self, port_id: &str) -> Result<()> {
        let Some(stored) = stored_downloads_from(&self.library.connection()?)?
            .into_iter()
            .find(|stored| stored.record.port_id == port_id)
        else {
            return Ok(());
        };
        let Some(PendingSetupProgress {
            binding: Some(binding),
            stage,
            ..
        }) = &stored.record.progress
        else {
            // An earlier record keeps its earlier registration behavior.
            return Ok(());
        };
        if matches!(stage, PendingSetupStage::Invalidated { .. }) {
            return Err(Self::invalidated_error(&stored.record));
        }
        // The program is checked again by the registration preview itself.
        let check_stage = PendingSetupStage::ArtifactObtained;
        if let Some(reason) = self.pending_setup_invalidation(&stored, binding, &check_stage)? {
            let invalidated = self.save_stage(
                &stored,
                binding.clone(),
                PendingSetupStage::Invalidated {
                    previous: stage.kind(),
                    reason,
                },
            )?;
            return Err(Self::invalidated_error(&invalidated));
        }
        Ok(())
    }
}

fn retained_setup_guide(record: &PendingSetupRecord, url: &str) -> bool {
    [
        record.listing.setup_url.as_deref(),
        record
            .listing
            .manual_setup
            .as_ref()
            .and_then(|guide| guide.help_url.as_deref()),
    ]
    .contains(&Some(url))
}

fn selected_result(preview: &crate::ExternalRuntimePreview) -> Result<SelectedSetupResult> {
    let (executable_sha256, executable_size) = crate::adapter::hash_file(&preview.executable)?;
    Ok(SelectedSetupResult {
        executable: preview.executable.clone(),
        working_directory: preview.path.clone(),
        arguments: preview
            .user_selected
            .as_ref()
            .map(|launch| launch.arguments.clone())
            .unwrap_or_default(),
        executable_sha256,
        executable_size,
        version: preview.version.clone(),
        selected_at: clock()?,
    })
}

fn selection_matches(selection: &SelectedSetupResult) -> bool {
    fs::symlink_metadata(&selection.executable).is_ok_and(|metadata| metadata.is_file())
        && fs::symlink_metadata(&selection.working_directory)
            .is_ok_and(|metadata| metadata.is_dir())
        && crate::adapter::hash_file(&selection.executable).is_ok_and(|(sha256, size)| {
            size == selection.executable_size
                && sha256.eq_ignore_ascii_case(&selection.executable_sha256)
        })
}

#[cfg(test)]
#[path = "pending_setup_stage_tests.rs"]
mod tests;
