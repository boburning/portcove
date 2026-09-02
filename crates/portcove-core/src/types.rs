use std::{collections::BTreeMap, path::PathBuf, str::FromStr};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{PortcoveError, Result};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum Platform {
    WindowsX86_64,
    LinuxX86_64,
    MacosX86_64,
    MacosAarch64,
}

impl Platform {
    pub fn current() -> Result<Self> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => Ok(Self::WindowsX86_64),
            ("linux", "x86_64") => Ok(Self::LinuxX86_64),
            ("macos", "x86_64") => Ok(Self::MacosX86_64),
            ("macos", "aarch64") => Ok(Self::MacosAarch64),
            (os, arch) => Err(PortcoveError::unsupported(format!(
                "Portcove does not support host platform {os}/{arch}"
            ))),
        }
    }

    pub fn asset_tokens(self) -> &'static [&'static str] {
        match self {
            Self::WindowsX86_64 => &["windows", "win64", "x64", ".exe", ".msi"],
            Self::LinuxX86_64 => &["linux", "appimage", "x86_64", "amd64"],
            Self::MacosX86_64 => &["macos", "mac", "darwin", "x86_64", "intel"],
            Self::MacosAarch64 => &[
                "macos",
                "mac",
                "darwin",
                "aarch64",
                "arm64",
                "apple-silicon",
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseChannel {
    Stable,
    Beta,
    Rolling,
}

impl std::fmt::Display for ReleaseChannel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
            Self::Rolling => "rolling",
        })
    }
}

impl FromStr for ReleaseChannel {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "stable" => Ok(Self::Stable),
            "beta" => Ok(Self::Beta),
            "rolling" => Ok(Self::Rolling),
            _ => Err(PortcoveError::usage(format!(
                "unknown release channel: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePolicy {
    Notify,
    Stage,
    Automatic,
}

impl std::fmt::Display for UpdatePolicy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Notify => "notify",
            Self::Stage => "stage",
            Self::Automatic => "automatic",
        })
    }
}

impl FromStr for UpdatePolicy {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "notify" => Ok(Self::Notify),
            "stage" => Ok(Self::Stage),
            "automatic" => Ok(Self::Automatic),
            _ => Err(PortcoveError::usage(format!(
                "unknown update policy: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SupportTier {
    Stable,
    Beta,
    Rolling,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AdapterKind {
    LibultrashipPortable,
    N64RecompPortable,
    StagedSourcePortable,
    ReferencedDisc,
    GeneratedCache,
    UpstreamManagedSetup,
    PsxRecompManaged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeSourceMaterialization {
    N64BigEndian,
    Copy,
    GamecubeIso,
    PsxBinCue,
    PsxRawSet,
    Ps2Iso,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    #[default]
    File,
    FileSet,
    GamecubeDisc,
    PsxDisc,
    UpstreamValidatedDisc,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceMemberProfile {
    pub id: String,
    pub label: String,
    pub accepted_filenames: Vec<String>,
    #[serde(default)]
    pub accepted_sha1: Vec<String>,
    #[serde(default)]
    pub accepted_sha256: Vec<String>,
    #[serde(default)]
    pub accepted_crc32: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DiscSourceProfile {
    pub track_counts: Vec<u32>,
    #[serde(default)]
    pub discs: Vec<DiscIdentityProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DiscIdentityProfile {
    pub label: String,
    #[serde(default)]
    pub accepted_sha1: Vec<String>,
    #[serde(default)]
    pub accepted_sha256: Vec<String>,
    #[serde(default)]
    pub accepted_volume_ids: Vec<String>,
    pub track_counts: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceProfile {
    pub id: String,
    pub label: String,
    pub accepted_extensions: Vec<String>,
    #[serde(default)]
    pub accepted_sha1: Vec<String>,
    #[serde(default)]
    pub accepted_sha256: Vec<String>,
    #[serde(default)]
    pub kind: SourceKind,
    #[serde(default)]
    pub disc: Option<DiscSourceProfile>,
    #[serde(default)]
    pub members: Vec<SourceMemberProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeSourceTarget {
    pub source_filenames: Vec<String>,
    pub destination: String,
    pub materialization: RuntimeSourceMaterialization,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ReleaseSource {
    #[default]
    Github,
    Gitlab,
    DirectManifest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "kebab-case")]
pub enum UpstreamStatus {
    #[default]
    Active,
    Retired,
    Superseded,
    Abandoned,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DirectReleaseSpec {
    pub version: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReleaseSpec {
    #[serde(default)]
    pub provider: ReleaseSource,
    #[serde(default)]
    pub repository: String,
    #[serde(default)]
    pub rolling_tag: Option<String>,
    #[serde(default)]
    pub asset_hints: BTreeMap<Platform, Vec<String>>,
    #[serde(default)]
    pub direct: BTreeMap<Platform, DirectReleaseSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortDefinition {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub project_url: String,
    pub support_tier: SupportTier,
    pub channels: Vec<ReleaseChannel>,
    pub platforms: Vec<Platform>,
    #[serde(default)]
    pub automated_tested_platforms: Vec<Platform>,
    #[serde(default)]
    pub manually_validated_platforms: Vec<Platform>,
    pub adapter: AdapterKind,
    pub release: ReleaseSpec,
    #[serde(default)]
    pub source_profile: Option<String>,
    #[serde(default)]
    pub bios_source_profile: Option<String>,
    #[serde(default)]
    pub executable_hints: BTreeMap<Platform, Vec<String>>,
    #[serde(default)]
    pub persistent_paths: Vec<String>,
    #[serde(default)]
    pub portable_marker: bool,
    #[serde(default)]
    pub source_environment: Option<String>,
    #[serde(default)]
    pub launch_arguments: Vec<String>,
    #[serde(default)]
    pub runtime_subdirectory: Option<String>,
    #[serde(default)]
    pub runtime_source_filename: Option<String>,
    #[serde(default)]
    pub runtime_source_materialization: Option<RuntimeSourceMaterialization>,
    #[serde(default)]
    pub runtime_source_set: Vec<RuntimeSourceTarget>,
    #[serde(default)]
    pub launch_from_install_root: bool,
    #[serde(default)]
    pub setup_executable_hints: BTreeMap<Platform, Vec<String>>,
    #[serde(default)]
    pub setup_arguments: Vec<String>,
    #[serde(default)]
    pub setup_marker: Option<String>,
    #[serde(default)]
    pub upstream_status: UpstreamStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogDocument {
    pub schema_version: u32,
    pub source_profiles: Vec<SourceProfile>,
    pub ports: Vec<PortDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceRecord {
    pub profile_id: String,
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
    pub storage_sha256: String,
    pub storage_size: u64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceVerification {
    pub profile_id: String,
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
    pub storage_sha256: String,
    pub storage_size: u64,
    pub registered_at: i64,
    pub verified_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InstallRecord {
    pub id: String,
    pub port_id: String,
    pub version: String,
    pub path: PathBuf,
    pub channel: ReleaseChannel,
    pub installed_at: i64,
    pub verified: bool,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortStatus {
    pub port_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_data_root: Option<PathBuf>,
    pub channel: ReleaseChannel,
    pub update_policy: UpdatePolicy,
    pub active: Option<InstallRecord>,
    pub previous: Option<InstallRecord>,
    pub staged: Option<InstallRecord>,
    #[serde(default)]
    pub last_launched_at: Option<i64>,
    #[serde(default)]
    pub successful_launches: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness: Option<LaunchReadiness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_update_check: Option<UpdateSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActivityTargetKind {
    Port,
    Source,
    Library,
}

impl std::fmt::Display for ActivityTargetKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Port => "port",
            Self::Source => "source",
            Self::Library => "library",
        })
    }
}

impl FromStr for ActivityTargetKind {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "port" => Ok(Self::Port),
            "source" => Ok(Self::Source),
            "library" => Ok(Self::Library),
            _ => Err(PortcoveError::state(format!(
                "unknown activity target kind: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActivityOperation {
    CheckUpdate,
    Backup,
    Restore,
    DeleteBackup,
    Install,
    Update,
    Reconcile,
    VerifyInstall,
    Activate,
    Rollback,
    Adopt,
    Remove,
    RegisterSource,
    VerifySource,
}

impl std::fmt::Display for ActivityOperation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::CheckUpdate => "check_update",
            Self::Backup => "backup",
            Self::Restore => "restore",
            Self::DeleteBackup => "delete_backup",
            Self::Install => "install",
            Self::Update => "update",
            Self::Reconcile => "reconcile",
            Self::VerifyInstall => "verify_install",
            Self::Activate => "activate",
            Self::Rollback => "rollback",
            Self::Adopt => "adopt",
            Self::Remove => "remove",
            Self::RegisterSource => "register_source",
            Self::VerifySource => "verify_source",
        })
    }
}

impl FromStr for ActivityOperation {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "check_update" => Ok(Self::CheckUpdate),
            "backup" => Ok(Self::Backup),
            "restore" => Ok(Self::Restore),
            "delete_backup" => Ok(Self::DeleteBackup),
            "install" => Ok(Self::Install),
            "update" => Ok(Self::Update),
            "reconcile" => Ok(Self::Reconcile),
            "verify_install" => Ok(Self::VerifyInstall),
            "activate" => Ok(Self::Activate),
            "rollback" => Ok(Self::Rollback),
            "adopt" => Ok(Self::Adopt),
            "remove" => Ok(Self::Remove),
            "register_source" => Ok(Self::RegisterSource),
            "verify_source" => Ok(Self::VerifySource),
            _ => Err(PortcoveError::state(format!(
                "unknown activity operation: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActivityStatus {
    Running,
    Succeeded,
    Failed,
}

impl std::fmt::Display for ActivityStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        })
    }
}

impl FromStr for ActivityStatus {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            _ => Err(PortcoveError::state(format!(
                "unknown activity status: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ActivityRecord {
    pub id: String,
    pub operation: ActivityOperation,
    pub target_kind: ActivityTargetKind,
    pub target_id: Option<String>,
    pub status: ActivityStatus,
    pub message: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StorageSummary {
    pub library_root: PathBuf,
    pub volume_total_bytes: u64,
    pub volume_available_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostToolState {
    Available,
    Missing,
    Misconfigured,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostToolSource {
    Environment,
    Discovery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HostToolStatus {
    pub id: String,
    pub state: HostToolState,
    pub path: Option<PathBuf>,
    pub source: Option<HostToolSource>,
    pub configuration_variable: String,
    pub purpose: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DoctorReport {
    pub platform: Platform,
    pub library: StorageSummary,
    pub catalog_port_count: usize,
    pub installed_port_count: usize,
    pub registered_source_count: usize,
    pub host_tools: Vec<HostToolStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BackupRecord {
    pub id: String,
    pub port_id: String,
    pub path: PathBuf,
    pub created_at: i64,
    pub file_count: u64,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RestoreResult {
    pub restored_backup: BackupRecord,
    pub safety_backup: Option<BackupRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InstallPlanAction {
    AlreadyActive,
    UseStaged,
    ReuseRetained,
    BlockedUnverified,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceRequirementRole {
    GameSource,
    Bios,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InstallSourceRequirement {
    pub profile_id: String,
    pub label: String,
    pub role: SourceRequirementRole,
    pub registered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InstallPlan {
    pub port_id: String,
    pub channel: ReleaseChannel,
    pub platform: Platform,
    pub release: ResolvedRelease,
    pub action: InstallPlanAction,
    pub source_requirements: Vec<InstallSourceRequirement>,
    pub storage: StorageSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortPaths {
    pub port_id: String,
    pub library_root: PathBuf,
    pub user_data_root: PathBuf,
    pub active_install_root: Option<PathBuf>,
    pub previous_install_root: Option<PathBuf>,
    pub staged_install_root: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LaunchReadiness {
    pub launchable: bool,
    pub blockers: Vec<LaunchBlocker>,
    pub pending_setup: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LaunchBlocker {
    MissingSource,
    MissingBios,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ResolvedRelease {
    pub version: String,
    pub channel: ReleaseChannel,
    pub published_at: Option<String>,
    pub asset: ReleaseAsset,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UpdateCheck {
    pub port_id: String,
    pub channel: ReleaseChannel,
    pub installed_version: Option<String>,
    pub update_available: bool,
    pub release: ResolvedRelease,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UpdateSnapshot {
    pub checked_at: i64,
    pub check: UpdateCheck,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReconcileAction {
    UpToDate,
    Notify,
    Staged,
    Activated,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReconcileResult {
    pub port_id: String,
    pub policy: UpdatePolicy,
    pub action: ReconcileAction,
    pub check: UpdateCheck,
    pub install: Option<InstallRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OperationEvent {
    Started {
        operation: String,
        port_id: Option<String>,
    },
    Progress {
        phase: String,
        completed: u64,
        total: Option<u64>,
    },
    Message {
        level: String,
        message: String,
    },
    Finished {
        operation: String,
        success: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CapabilityDocument {
    pub schema_version: u32,
    pub product: String,
    pub product_version: String,
    pub commands: Vec<String>,
    pub platforms: Vec<Platform>,
    pub adapters: Vec<AdapterKind>,
    pub machine_formats: Vec<String>,
    pub failure_isolated_batches: Vec<String>,
    pub port_operation_locking: String,
}

impl CapabilityDocument {
    pub fn current() -> Self {
        Self {
            schema_version: crate::API_SCHEMA_VERSION,
            product: "Portcove".into(),
            product_version: env!("CARGO_PKG_VERSION").into(),
            commands: vec![
                "auth".into(),
                "backup".into(),
                "catalog".into(),
                "source".into(),
                "status".into(),
                "activity".into(),
                "storage".into(),
                "doctor".into(),
                "about".into(),
                "plan".into(),
                "paths".into(),
                "check".into(),
                "reconcile".into(),
                "install".into(),
                "adopt".into(),
                "ensure".into(),
                "update".into(),
                "verify".into(),
                "activate".into(),
                "rollback".into(),
                "remove".into(),
                "channel".into(),
                "policy".into(),
                "exec".into(),
                "capabilities".into(),
                "schema".into(),
            ],
            platforms: vec![
                Platform::WindowsX86_64,
                Platform::LinuxX86_64,
                Platform::MacosX86_64,
                Platform::MacosAarch64,
            ],
            adapters: vec![
                AdapterKind::LibultrashipPortable,
                AdapterKind::N64RecompPortable,
                AdapterKind::ReferencedDisc,
                AdapterKind::GeneratedCache,
                AdapterKind::UpstreamManagedSetup,
                AdapterKind::PsxRecompManaged,
            ],
            machine_formats: vec!["json".into(), "jsonl".into()],
            failure_isolated_batches: vec![
                "check".into(),
                "reconcile".into(),
                "update".into(),
                "source.verify".into(),
            ],
            port_operation_locking: "per_port_fail_fast".into(),
        }
    }
}
