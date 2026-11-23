//! Typed stages of an upstream setup that Portcove does not own.
//!
//! A pending setup keeps the verified download and the player's place in the
//! upstream steps that follow it, so closing Portcove, cancelling or a crash
//! resumes at that place instead of starting over. Each stage is bound to the
//! exact retained source, artifact role and definition it began with; a change
//! to a fact that makes this route invalid invalidates the stage with a typed
//! reason instead of continuing silently. A newer upstream release is not such
//! a fact: Core reports it as a notice and registration of what the player
//! already set up continues.
//!
//! Only stages that the existing flow reaches exist: the download itself, the
//! player opening the setup folder or retained setup guide, the player choosing
//! the installed program, and the player confirming the registration plan.
//! Portcove never runs the upstream installer from a pending setup, so it
//! observes no upstream exit. Completion is the player's selection plus Core's
//! verification of what was selected, followed by the existing reviewed,
//! non-owning registration.
//!
//! Compatibility: publication keeps the record format that earlier releases
//! read (1 for GitHub, 2 for GitLab); Core maps it to `artifact-obtained` on
//! read. Format 3 is written only when the player moves the setup past that
//! stage.
use super::*;
use crate::route_facts::{self, ArtifactFact, ArtifactRole, AssetIdentity, FactSource, RoleClaim};

/// Record format of a pending setup that carries a typed stage past
/// `artifact-obtained`. Formats 1 (GitHub) and 2 (GitLab) remain the
/// publication formats and map to `artifact-obtained` on read.
pub(super) const STAGED_RECORD_FORMAT: u8 = 3;

/// Where the player is in an upstream setup, and what that place is bound to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PendingSetupProgress {
    /// Absent only on the read-time mapping of a format 1 or 2 record. Core
    /// binds it to the current facts when the player first moves the setup
    /// past `artifact-obtained`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<PendingSetupBinding>,
    pub stage: PendingSetupStage,
    pub updated_at: String,
}

/// The exact facts a stage belongs to. A change invalidates the stage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PendingSetupBinding {
    /// Upstream project or release address of the retained listing.
    pub source_url: String,
    /// Digest of the catalog content this setup depends on: the retained
    /// signed definition entry and its contracts when one is selected, else
    /// the documented setup fields of the embedded definition, else their
    /// absence for a listing-only project. It never covers Portcove's own
    /// serialization of a definition, so an application update alone keeps
    /// the binding.
    pub definition_sha256: String,
    /// Typed route fact for the downloaded artifact. A filename suggestion
    /// describes it; it never authorizes a runtime.
    pub artifact_role: ArtifactRole,
    pub role_source: FactSource,
    pub retained: RetainedSetupBytes,
}

/// Verified bytes the setup folder retains.
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
    FinalSelected,
    RegistrationReviewed,
    Invalidated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "stage", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PendingSetupStage {
    /// The verified package is retained; nothing has been run. Never stored:
    /// it is the read-time stage of a format 1 or 2 record.
    ArtifactObtained,
    /// The player opened the setup folder or the retained setup guide.
    UpstreamSetupOpened {
        handoff: UpstreamSetupHandoff,
        opened_at: String,
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
            Self::FinalSelected { .. } => PendingSetupStageKind::FinalSelected,
            Self::RegistrationReviewed { .. } => PendingSetupStageKind::RegistrationReviewed,
            Self::Invalidated { .. } => PendingSetupStageKind::Invalidated,
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

/// What the player opened. Portcove never runs the upstream installer itself
/// from a pending setup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum UpstreamSetupHandoff {
    /// The retained setup folder was opened.
    Folder,
    /// The retained upstream setup guide was opened.
    Guide { url: String },
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

impl SelectedSetupResult {
    /// The same program and plan, whenever it was chosen.
    fn same_choice(&self, other: &Self) -> bool {
        self.executable == other.executable
            && self.working_directory == other.working_directory
            && self.arguments == other.arguments
            && self
                .executable_sha256
                .eq_ignore_ascii_case(&other.executable_sha256)
            && self.executable_size == other.executable_size
            && self.version == other.version
    }
}

/// A fact that makes this setup route itself invalid. A newer upstream
/// release is not one; Core reports it as a notice instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PendingSetupInvalidation {
    /// The current listing names another upstream source.
    SourceChanged { current_source_url: String },
    /// The catalog content this setup depends on changed.
    DefinitionChanged,
    /// A download restriction now holds for these exact bytes.
    RestrictionHolds { explanation: String },
    /// Typed route facts now give the artifact a different role.
    ArtifactRoleChanged { current_role: ArtifactRole },
    /// The retained package or its receipt changed or is missing.
    RetainedBytesChanged,
}

/// Core's player explanation: what happened, then what to do next. A notice
/// is information that does not block the next step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PendingSetupMessage {
    pub summary: String,
    pub next_step: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
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
    let message = |summary: String, next_step: String| PendingSetupMessage {
        summary,
        next_step,
        notice: None,
    };
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
    };
    PendingSetupMessage {
        summary,
        next_step,
        notice: None,
    }
}

/// Core's notice when a newer version exists. It never blocks registration of
/// the game the player already set up.
fn newer_release_notice(version: &str) -> String {
    format!("A newer version, {version}, is available. You can still add the game you set up.")
}

impl PendingSetupRecord {
    /// The typed stage, mapped for records written before stages existed.
    /// A download that has not finished has no setup stage yet.
    pub fn stage_kind(&self) -> Option<PendingSetupStageKind> {
        self.progress.as_ref().map(|progress| progress.stage.kind())
    }

    /// Core's player explanation for this record's stored stage. Use
    /// [`PortcoveService::pending_setup_presentation`] to show a record: it
    /// also rechecks the current catalog.
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

/// Read-only mapping of a format 1 or 2 record to its stage.
pub(super) fn map_legacy_stage(record: &mut PendingSetupRecord) {
    if record.progress.is_none() && record.state == PendingSetupState::Downloaded {
        record.progress = Some(PendingSetupProgress {
            binding: None,
            stage: PendingSetupStage::ArtifactObtained,
            updated_at: record.downloaded_at.clone(),
        });
    }
}

/// The read-time mapping is never written back; only a bound stage past
/// `artifact-obtained` is durable.
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
        // Publication keeps format 1 or 2, so a stored stage is always later.
        PendingSetupStage::ArtifactObtained => false,
        PendingSetupStage::UpstreamSetupOpened { handoff, opened_at } => {
            text_ok(opened_at, 128)
                && match handoff {
                    UpstreamSetupHandoff::Folder => true,
                    UpstreamSetupHandoff::Guide { url } => text_ok(url, 4096),
                }
        }
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

/// The documented setup-relevant fields of an embedded definition: identity,
/// project address, adapter, platforms, release provider and repository,
/// rolling tag, package hints and executable hints. Fields added to the
/// definition type later are not part of the binding until listed here.
fn setup_definition_facts(port: &crate::PortDefinition) -> serde_json::Value {
    serde_json::json!({
        "id": port.id,
        "project_url": port.project_url,
        "adapter": port.adapter,
        "platforms": port.platforms,
        "release_provider": port.release.provider,
        "release_repository": port.release.repository,
        "rolling_tag": port.release.rolling_tag,
        "asset_hints": port.release.asset_hints,
        "executable_hints": port.executable_hints,
    })
}

/// Digest of the catalog content a setup depends on. A retained signed entry
/// is bound by its own stored bytes; only an embedded definition uses the
/// explicit field subset.
pub(super) fn setup_definition_sha256(
    retained_entry_sha256: Option<String>,
    port: Option<&crate::PortDefinition>,
) -> Result<String> {
    let embedded = match retained_entry_sha256 {
        Some(_) => None,
        None => port.map(setup_definition_facts),
    };
    Ok(crate::signed_catalog::digest(&serde_json::to_vec(&(
        "pending-setup-definition-v2",
        retained_entry_sha256,
        embedded,
    ))?))
}

/// Release tags that name one release: a leading `v` and letter case differ
/// between sources without naming another release.
fn same_release_tag(left: &str, right: &str) -> bool {
    let normal = |tag: &str| {
        let tag = tag.trim();
        tag.strip_prefix(['v', 'V'])
            .unwrap_or(tag)
            .to_ascii_lowercase()
    };
    normal(left) == normal(right)
}

fn release_time(value: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
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

    thread_local! {
        static RETAINED_READ: Cell<bool> = const { Cell::new(false) };
    }

    /// Make every read of a waiting setup's retained download fail as a file
    /// that another program holds open would, until reset.
    pub(crate) fn fail_retained_reads(fail: bool) {
        RETAINED_READ.with(|cell| cell.set(fail));
    }

    pub(super) fn retained_read() -> std::io::Result<()> {
        if RETAINED_READ.with(Cell::get) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected retained read fault",
            ));
        }
        Ok(())
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

/// How much of the retained download a continuation rechecks.
#[derive(Clone, Copy)]
enum RetainedCheck<'a> {
    /// The retained file is present with its recorded size, or the extracted
    /// folder keeps its receipt. Used when the player chooses or reviews.
    Presence,
    /// The retained package matches its digest, bounded by its recorded size
    /// and cancellable through the checkpoint. Used by registration.
    Digest(&'a dyn Fn() -> Result<()>),
}

impl PortcoveService {
    fn pending_definition_sha256(&self, port_id: &str) -> Result<String> {
        setup_definition_sha256(
            self.catalog
                .definition_snapshot(port_id)
                .map(crate::definition_projection::DefinitionSnapshot::content_sha256),
            self.catalog.port(port_id).ok(),
        )
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

    /// Bind a stage to the current facts when the player first moves a
    /// format 1 or 2 record past `artifact-obtained`. The retained form is
    /// read from the published folder: an unextracted package keeps its own
    /// file there.
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

    /// The newest release that the current listing establishes as newer than
    /// the downloaded one, compared by the release identity the download
    /// candidate uses. A complete upstream observation must contain the
    /// downloaded release to compare against; a reviewed pin counts only
    /// when its publication time is known and later and its tag names
    /// another release. Anything else is unknown and shows no notice.
    pub(super) fn newer_pending_release(&self, record: &PendingSetupRecord) -> Option<String> {
        let listing = self.catalog.listing(&record.port_id).ok()?;
        let observation = listing
            .upstream_observation
            .as_ref()
            .filter(|observation| {
                observation.status == crate::ListingObservationStatus::Complete
            })?;
        let bound = observation
            .releases
            .iter()
            .find(|release| release.id == record.artifact.release_id)?;
        if bound.provider_prerelease {
            // A chosen preview release is compared only with later previews'
            // channel, which this observation does not establish.
            return None;
        }
        let bound_at = release_time(&bound.published_at)?;
        let newer = |version: &str, published_at: Option<&str>| {
            let at = published_at.and_then(release_time)?;
            (at > bound_at && !same_release_tag(version, &record.artifact.release_tag))
                .then(|| (at, version.to_owned()))
        };
        let observed = observation
            .releases
            .iter()
            .filter(|release| !release.provider_prerelease && release.id != bound.id)
            .filter_map(|release| newer(&release.version, Some(&release.published_at)));
        let pinned = listing
            .release_maintenance
            .as_ref()
            .zip(Platform::current().ok())
            .and_then(|(maintenance, platform)| {
                maintenance
                    .pinned_releases
                    .iter()
                    .find(|pin| pin.platform == platform)
            })
            .and_then(|pin| newer(&pin.version, pin.published_at.as_deref()));
        observed
            .chain(pinned)
            .max_by(|left, right| left.0.cmp(&right.0))
            .map(|(_, version)| version)
    }

    /// Recheck the catalog facts a stage is bound to. These are cheap and
    /// read nothing from the retained download.
    fn catalog_fact_invalidation(
        &self,
        record: &PendingSetupRecord,
        binding: &PendingSetupBinding,
    ) -> Result<Option<PendingSetupInvalidation>> {
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
        let fact = self.pending_artifact_fact(record);
        if fact.role != binding.artifact_role {
            return Ok(Some(PendingSetupInvalidation::ArtifactRoleChanged {
                current_role: fact.role,
            }));
        }
        Ok(None)
    }

    /// Recheck every bound fact for a continuation. The first changed fact is
    /// the reason.
    fn pending_setup_invalidation(
        &self,
        stored: &StoredDownload,
        binding: &PendingSetupBinding,
        retained_check: RetainedCheck<'_>,
    ) -> Result<Option<PendingSetupInvalidation>> {
        if let Some(reason) = self.catalog_fact_invalidation(&stored.record, binding)? {
            return Ok(Some(reason));
        }
        let record = &stored.record;
        let retained_matches = match &binding.retained {
            RetainedSetupBytes::Package { file, sha256, size } => {
                let path = record.path.join(file);
                refuse_symlink_ancestors(&path)?;
                retained_package_matches(&path, sha256, *size, retained_check)
            }
            RetainedSetupBytes::Extracted { .. } => self.publication_receipt_still_matches(stored),
        }
        .map_err(retained_read_error)?;
        if !retained_matches {
            return Ok(Some(PendingSetupInvalidation::RetainedBytesChanged));
        }
        Ok(None)
    }

    /// Core's current explanation of a saved setup for display. It rechecks
    /// the catalog facts the stage is bound to without writing, so a stage
    /// that a catalog change made invalid never reads as continuable, and
    /// adds a notice when a newer version exists.
    pub fn pending_setup_presentation(
        &self,
        record: &PendingSetupRecord,
    ) -> Option<(PendingSetupStageKind, PendingSetupMessage)> {
        let progress = record.progress.as_ref()?;
        let role = progress
            .binding
            .as_ref()
            .map(|binding| binding.artifact_role);
        let current = match (&progress.binding, &progress.stage) {
            (_, PendingSetupStage::Invalidated { .. }) | (None, _) => None,
            (Some(binding), stage) => self
                .catalog_fact_invalidation(record, binding)
                .ok()
                .flatten()
                .map(|reason| PendingSetupStage::Invalidated {
                    previous: stage.kind(),
                    reason,
                }),
        };
        let stage = current.as_ref().unwrap_or(&progress.stage);
        let mut message = pending_setup_message(stage, role);
        if stage.kind() != PendingSetupStageKind::Invalidated {
            message.notice = self
                .newer_pending_release(record)
                .map(|version| newer_release_notice(&version));
        }
        Some((stage.kind(), message))
    }

    fn stored_pending_setup(&self, port_id: &str, pending_id: &str) -> Result<StoredDownload> {
        stored_downloads_from(&self.library.connection()?)?
            .into_iter()
            .find(|stored| stored.record.port_id == port_id && stored.record.id == pending_id)
            .ok_or_else(|| PortcoveError::conflict("pending setup changed or no longer exists"))
    }

    /// The finished download of this port, if one is waiting for setup.
    fn downloaded_pending_setup(&self, port_id: &str) -> Result<Option<StoredDownload>> {
        Ok(stored_downloads_from(&self.library.connection()?)?
            .into_iter()
            .find(|stored| {
                stored.record.port_id == port_id
                    && stored.record.state == PendingSetupState::Downloaded
                    && stored.phase == "downloaded"
            }))
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

    /// The stage of a finished download with its binding, binding a format 1
    /// or 2 record to the current facts now.
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

    /// Persist a stage past `artifact-obtained`. This is the only write of
    /// record format 3.
    fn save_stage(
        &self,
        stored: &StoredDownload,
        binding: PendingSetupBinding,
        stage: PendingSetupStage,
    ) -> Result<PendingSetupRecord> {
        if stage == PendingSetupStage::ArtifactObtained {
            return Err(PortcoveError::state(
                "artifact-obtained is the publication stage and is never stored",
            ));
        }
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

    /// Refuse an invalidated stage, then recheck the bound facts and persist
    /// an invalidation when one now holds.
    fn require_continuable_stage(
        &self,
        stored: &StoredDownload,
        binding: &PendingSetupBinding,
        stage: &PendingSetupStage,
        retained_check: RetainedCheck<'_>,
    ) -> Result<()> {
        if matches!(stage, PendingSetupStage::Invalidated { .. }) {
            return Err(Self::invalidated_error(&stored.record));
        }
        if let Some(reason) = self.pending_setup_invalidation(stored, binding, retained_check)? {
            let invalidated = self.save_stage(
                stored,
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

    /// Record that the player opened this setup's upstream handoff: the
    /// folder, or a retained setup guide. It only records the handoff; it
    /// reads no retained bytes, and the next continuation rechecks the bound
    /// facts. A release page is not setup, a download still in recovery has
    /// no stage, an invalidated stage stays invalidated and a chosen program
    /// stays chosen; none of these changes anything.
    pub fn note_pending_setup_opened(
        &self,
        port_id: &str,
        pending_id: &str,
        guide_url: Option<&str>,
    ) -> Result<Option<PendingSetupStageKind>> {
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
        let _lock = self
            .library
            .try_lock_port(port_id, "note-pending-setup-opened")?;
        let stored = self.stored_pending_setup(port_id, pending_id)?;
        let (binding, stage) = self.staged_progress(&stored)?;
        if matches!(
            stage,
            PendingSetupStage::Invalidated { .. }
                | PendingSetupStage::FinalSelected { .. }
                | PendingSetupStage::RegistrationReviewed { .. }
        ) {
            return Ok(Some(stage.kind()));
        }
        let next = PendingSetupStage::UpstreamSetupOpened {
            handoff,
            opened_at: clock()?,
        };
        Ok(self.save_stage(&stored, binding, next)?.stage_kind())
    }

    /// Check the program the player chose, as registration review does, and
    /// record the choice as the `final-selected` stage of this port's waiting
    /// setup. Without a waiting setup this is the plain preview. Choosing the
    /// same program again keeps a stage that is already further on.
    pub fn choose_user_selected_runtime(
        &self,
        port_id: &str,
        executable: &Path,
        working_directory: &Path,
        arguments: &[String],
    ) -> Result<crate::ExternalRuntimePreview> {
        let preview =
            self.preview_user_selected_runtime(port_id, executable, working_directory, arguments)?;
        let Some(found) = self.downloaded_pending_setup(port_id)? else {
            return Ok(preview);
        };
        let _lock = self
            .library
            .try_lock_port(port_id, "choose-pending-setup-result")?;
        let stored = self.stored_pending_setup(port_id, &found.record.id)?;
        let (binding, stage) = self.staged_progress(&stored)?;
        self.require_continuable_stage(&stored, &binding, &stage, RetainedCheck::Presence)?;
        let selection = selected_result(&preview, &|| Ok(()))?;
        if stage
            .selection()
            .is_none_or(|current| !current.same_choice(&selection))
        {
            self.save_stage(
                &stored,
                binding,
                PendingSetupStage::FinalSelected { selection },
            )?;
        }
        Ok(preview)
    }

    /// Record the registration plan the player just confirmed. A record still
    /// in download recovery keeps its state; registration itself rechecks
    /// the stage.
    pub(crate) fn record_pending_registration_review(
        &self,
        port_id: &str,
        preview: &crate::ExternalRuntimePreview,
    ) -> Result<()> {
        let Some(found) = self.downloaded_pending_setup(port_id)? else {
            return Ok(());
        };
        let _lock = self
            .library
            .try_lock_port(port_id, "review-pending-setup-registration")?;
        let stored = self.stored_pending_setup(port_id, &found.record.id)?;
        let (binding, stage) = self.staged_progress(&stored)?;
        self.require_continuable_stage(&stored, &binding, &stage, RetainedCheck::Presence)?;
        // The preview just checked the program it names; an earlier choice
        // is replaced by this reviewed one.
        self.save_stage(
            &stored,
            binding,
            PendingSetupStage::RegistrationReviewed {
                selection: selected_result(preview, &|| Ok(()))?,
                preview_sha256: preview.preview_sha256.clone(),
            },
        )?;
        Ok(())
    }

    /// Registration completes a staged setup only while its bound facts hold.
    /// The retained package digest is verified here, bounded by its recorded
    /// size and cancellable through the registration's checkpoint. A newer
    /// upstream release never blocks this.
    pub(crate) fn require_pending_setup_continuable(
        &self,
        port_id: &str,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
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
            // A format 1 or 2 record keeps its earlier registration behavior.
            return Ok(());
        };
        self.require_continuable_stage(&stored, binding, stage, RetainedCheck::Digest(checkpoint))
    }
}

/// Whether the retained package still has its recorded bytes. Only a missing
/// file, something other than a file, or a size or digest mismatch means it
/// changed. Any other read failure, such as another program holding the file,
/// is returned so nothing is recorded and the player can try again.
fn retained_package_matches(
    path: &Path,
    sha256: &str,
    size: u64,
    retained_check: RetainedCheck<'_>,
) -> Result<bool> {
    match retained_metadata(path) {
        Ok(metadata) if metadata.is_file() && metadata.len() == size => {}
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    let RetainedCheck::Digest(checkpoint) = retained_check else {
        return Ok(true);
    };
    let (actual, read) = crate::adapter::hash_file_bounded_with_checkpoint(path, size, checkpoint)?;
    Ok(read == size && actual.eq_ignore_ascii_case(sha256))
}

/// Metadata of a retained setup file, with the test read-fault seam.
pub(super) fn retained_metadata(path: &Path) -> std::io::Result<fs::Metadata> {
    #[cfg(test)]
    fault::retained_read()?;
    fs::symlink_metadata(path)
}

/// A retained-download read failure the player can retry. Cancellation stays
/// the player's own result.
fn retained_read_error(error: PortcoveError) -> PortcoveError {
    if error.code == crate::ErrorCode::Cancelled {
        return error;
    }
    error.with_known_cause(crate::failure::KnownFailureCause::RetainedDownloadUnreadable)
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

/// The chosen program's identity, read with the same bounded, cancellable
/// stable-file hashing that its preview used.
fn selected_result(
    preview: &crate::ExternalRuntimePreview,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<SelectedSetupResult> {
    let (executable_sha256, executable_size) = crate::external_runtime::hash_stable_regular(
        &preview.executable,
        crate::external_runtime::MAX_FILE_BYTES,
        checkpoint,
    )?;
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

#[cfg(test)]
#[path = "pending_setup_stage_tests.rs"]
pub(super) mod tests;
