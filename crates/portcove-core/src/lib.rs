mod activity_diagnostics;
mod adapter;
mod archive;
mod auth;
mod authorization;
mod cancellation;
mod catalog;
mod catalog_store;
mod catalog_update;
mod database;
#[cfg(test)]
mod definition_policy_tests;
mod durability;
mod error;
mod failure;
mod gitlab;
mod host_preferences;
mod host_tools;
mod import_execution;
mod import_journal;
mod install;
mod launch;
mod library;
mod library_access;
mod library_authority;
mod library_import;
mod library_move;
mod library_transfer;
mod operation;
mod output_relocation;
mod output_root;
mod path;
mod permissions;
mod persistence;
mod portability;
mod preparation;
mod process;
mod providers;
mod psx;
mod recovery;
mod release;
mod runtime;
mod service;
mod signed_catalog;
mod source;
mod source_assessment;
mod source_catalog;
mod source_discovery;
mod source_file;
mod source_import;
mod source_inbox;
mod source_inspection;
mod source_report;
mod stfs;
#[cfg(test)]
mod test_fixture;
mod tool_process;
mod transfer_copy;
mod transfer_journal;
mod types;

pub use activity_diagnostics::{ActivityDiagnostic, DiagnosticStream};
pub use adapter::{Adapter, AdapterRegistry, LaunchSpecRequest};
pub use adapter::{host_tool_statuses, recheck_host_tool};
pub use auth::{
    GithubAuthSource, GithubAuthStatus, GithubDeviceLogin, GithubDeviceLoginResult,
    GithubDeviceLoginState, GithubRateLimit,
};
pub use authorization::DestructiveAuthorization;
pub use cancellation::{CancellationPhase, CancellationState};
pub use catalog::Catalog;
pub use catalog_store::CatalogStatus;
pub use catalog_update::{CatalogUpdatePlan, CatalogUpdateSource};
pub use error::{ErrorCode, PortcoveError, Result};
pub use failure::{
    FailurePresentation, FailureReport, FailureTone, MutationState, RecoveryAction,
    redact_diagnostic_text, redact_diagnostic_value, sensitive_diagnostic_field,
};
pub use gitlab::GitlabReleaseProvider;
pub use host_preferences::{
    HostPreferenceStore, HostPreferences, HostToolPreference, LibrarySelection,
    LibrarySelectionSource,
};
pub use host_tools::{
    HostToolDefinition, HostToolProbePolicy, HostToolProbeResult, HostToolProbeState,
    clear_host_tool, configure_host_tool, configure_host_tool_with_cancellation,
    definitions as host_tool_definitions, probe_host_tool, probe_host_tool_with_cancellation,
};
pub use import_execution::LibraryImportResult;
pub use install::{InstallQualification, InstallRequest, Installer, VerificationReport};
pub use launch::forward_launch_signal;
pub use library::{Library, PortOperationGuard};
pub use library_import::LibraryImportPlan;
pub use library_move::LibraryMoveResult;
pub use library_transfer::{LibraryMovePlan, LibraryTreePlan};
pub use operation::{OPERATION_EVENT_SCHEMA_VERSION, OperationCoordinator};
pub use output_relocation::{
    OutputRelocationInstall, OutputRelocationPlan, OutputRelocationResult, OutputRelocationStatus,
};
pub use portability::{
    LibraryContentKind, LibraryContentRoot, LibraryLaunchHistory, LibraryMetadata,
    LibraryMetadataFile, LibraryPortSettings,
};
pub use preparation::{
    PreparationInputs, PreparationMode, PreparationOptions, PreparationPlan, PreparationTool,
};
pub use process::{ChildProcessClass, ChildProcessPolicy, GameProcessSpec, LaunchKind, LaunchSpec};
pub use providers::CompositeReleaseProvider;
pub use psx::PsxManagedPreparation;
pub use release::{
    GithubReleaseProvider, ObservationEvidence, ObservedReleaseIdentity, ObservedResolution,
    ReleaseProvider, UpstreamChannelObservation, UpstreamObservationReport,
    inspect_upstream_observation,
};
pub use service::{
    AdoptionCopyFile, AdoptionCopyPlan, AdoptionDestinationPreview, AdoptionPreview,
    AdoptionSkippedEntry, BackupAction, BackupActionPreview, IdentifiedLaunchRequest,
    InstallOverrides, PortRemovalPreview, PortcoveService,
};
pub use signed_catalog::{
    CatalogOrigin, CatalogProvenance, CatalogTrustKey, SignedCatalogEnvelope, SignedCatalogPayload,
};
pub use source::SourceRelinkPlan;
pub use source_assessment::*;
pub use source_catalog::*;
pub use source_discovery::{
    SourceDiscoveryIssue, SourceDiscoveryLimit, SourceDiscoveryLimits, SourceDiscoveryReport,
    SourceDiscoveryRequest,
};
pub use source_import::{
    SourceImportMode, SourceImportOutcome, SourceImportPlan, SourceImportResult,
};
pub use source_inbox::{
    SourceInboxCandidate, SourceInboxPaths, SourceInboxResolution, SourceInboxResolutionState,
    SourceInboxScanStats,
};
pub use source_inspection::{
    ObservedSourceComponent, ObservedSourceDigest, ObservedSourceIdentity, ObservedSourceValidator,
    SourceComponentKind, SourceDigestAlgorithm, SourceInspection, SourceValidatorResult,
};
pub use source_report::{
    SOURCE_INSPECTION_REPORT_SCHEMA_VERSION, SOURCE_INTAKE_INSPECTION_SCHEMA_VERSION,
    SourceApplicationInspection, SourceEvidenceLink, SourceInspectionProblem,
    SourceInspectionReport, SourceIntakeInspection, SourceLegacyCoverage,
    SourceQualificationCoverage, SourceReleaseApplicability,
};
pub use types::*;

pub const API_SCHEMA_VERSION: u32 = 41;
