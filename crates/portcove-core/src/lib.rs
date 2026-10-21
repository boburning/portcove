mod activity_diagnostics;
mod adapter;
mod application_runtime;
mod archive;
mod artwork;
mod artwork_image;
mod artwork_ingestion;
mod artwork_store;
#[cfg(test)]
mod artwork_tests;
mod auth;
mod authorization;
mod browsing_context;
mod cancellation;
mod cartridge_build;
mod catalog;
mod catalog_store;
mod catalog_update;
mod curated_acquisition;
mod curated_cache;
mod database;
mod definition_acquisition;
mod definition_candidate;
mod definition_capabilities;
mod definition_eligibility;
mod definition_entry;
mod definition_index;
mod definition_loader;
#[cfg(test)]
mod definition_policy_tests;
mod definition_projection;
mod definition_repository;
mod durability;
mod error;
mod external_runtime;
mod failure;
mod game_file_query;
mod game_file_root;
mod ghostship_data_store;
mod gitlab;
mod host_preferences;
mod host_tools;
mod import_execution;
mod import_journal;
mod install;
mod installed_contract;
mod launch;
mod library;
mod library_access;
mod library_authority;
mod library_import;
mod library_move;
mod library_transfer;
mod managed_shared_preferences;
mod managed_tfe;
mod n64_graphics;
mod operation;
mod output_relocation;
mod output_root;
mod path;
mod permissions;
mod persistence;
mod portability;
mod portability_authority;
mod portable_tree;
mod preparation;
mod process;
mod providers;
mod psx;
#[cfg(feature = "qualification-fixtures")]
mod qualification_checkpoint;
mod recovery;
mod relative_file_set;
mod release;
mod runtime;
mod runtime_data_policy;
mod runtime_path_policy;
mod service;
mod signed_catalog;
mod source;
mod source_assessment;
mod source_batch;
mod source_catalog;
mod source_disc;
mod source_discovery;
mod source_file;
mod source_import;
mod source_inbox;
mod source_inspection;
mod source_report;
mod source_zip;
mod stfs;
mod support_bundle;
#[cfg(test)]
mod test_fixture;
mod tool_process;
mod transfer_copy;
mod transfer_journal;
mod types;

pub use activity_diagnostics::{ActivityDiagnostic, DiagnosticStream};
pub use adapter::{Adapter, AdapterRegistry, LaunchSpecRequest};
pub use adapter::{host_tool_statuses, recheck_host_tool};
pub use application_runtime::{ApplicationRuntimeGuard, ApplicationUpdateExclusivityGuard};
pub use artwork::{
    ARTWORK_HANDOFF_SCHEMA, ArtworkAvailability, ArtworkCacheClear, ArtworkChoice,
    ArtworkImageFormat, ArtworkMetadata, ArtworkResolvedSource, ArtworkSlot, ArtworkState,
    ArtworkThumbnail, DestinationArtworkBytes, DestinationArtworkContent,
    DestinationArtworkHandoff, DestinationArtworkRole, DestinationArtworkSource,
    DestinationArtworkUnavailableReason, GeneratedArtworkFallback, LocalArtworkAsset,
};
pub use auth::{
    GithubAuthSource, GithubAuthStatus, GithubDeviceLogin, GithubDeviceLoginResult,
    GithubDeviceLoginState, GithubRateLimit,
};
pub use authorization::DestructiveAuthorization;
pub use browsing_context::{CatalogBrowsingContext, CatalogBrowsingSnapshot};
pub use cancellation::{CancellationPhase, CancellationState};
pub use cartridge_build::CartridgeBuildRecipe;
pub use catalog::{Catalog, CatalogProposalInspection, CatalogProposalPortInspection};
pub use catalog_store::CatalogStatus;
pub use catalog_update::{CatalogUpdatePlan, CatalogUpdateSource};
pub use curated_acquisition::{CuratedAcquisitionRecord, CuratedEvidenceReference};
pub use definition_acquisition::{DefinitionAcquisitionScope, ScopedResolvedRelease};
pub use definition_candidate::{
    DefinitionCandidateAvailability, DefinitionPublisherObservation, DefinitionPublisherStatus,
    EligibleDefinitionCandidate,
    selection::{DefinitionSelectionIdentity, DefinitionSelectionStatus},
};
pub use definition_capabilities::{
    DefinitionCapabilityOutcome, DefinitionCapabilityReport, DefinitionCapabilityRequest,
    DefinitionCapabilityRequirement, DefinitionCapabilityResult, EngineTemplateCapability,
    check_definition_capabilities, inspect_definition_capabilities,
};
pub use definition_eligibility::{
    DefinitionEligibility, DefinitionEligibilityFacts, DefinitionEligibilityOutcome,
    DefinitionEligibilityReason, DefinitionOperation, DefinitionOperationAssessment, PortAction,
    PortActionAssessment, PortActionAvailability, PortActionReason,
    evaluate_definition_eligibility,
};
pub use definition_entry::DefinitionEntryInspection;
pub use definition_index::{DefinitionContentIndex, IndexedDefinition};
pub use definition_projection::DefinitionCatalogProjection;
pub use definition_repository::{
    AuthenticatedDefinitionCandidate, AuthenticatedDefinitionProvenance,
    DefinitionReplayDisposition, DefinitionReplayFloor, DefinitionRepositorySource,
    acquire_definition_candidate,
    publisher_policy::{
        AuthenticatedDefinitionLaunchAssessment, AuthenticatedDefinitionPublisherPolicy,
        DefinitionAuthorityProvisioning, DefinitionAuthorityReview, DefinitionRefresh,
        DefinitionRefreshDisposition, acquire_definition_launch_assessment,
        acquire_definition_publisher_policy,
    },
};
pub use error::{ErrorCode, PortcoveError, Result};
pub use external_runtime::{
    ExternalRuntimePreview, ExternalRuntimeRelinkPreview, ExternalRuntimeRemovalPreview,
};
pub use failure::{
    FailurePresentation, FailureRecoveryTarget, FailureReport, FailureTone, MutationState,
    RecoveryAction, redact_diagnostic_text, redact_diagnostic_value, sensitive_diagnostic_field,
};
pub use game_file_query::{
    GameFileQueryReason, GameFileQueryRefreshRequest, GameFileQuerySnapshot, GameFileQueryState,
    GameFileRouteKind, GameFileRouteProjection, GameFileRouteRequest,
};
pub use game_file_root::{
    GameFileRoot, GameFileRootAvailability, GameFileScanCoverage, GameFileScanFreshness,
    GameFileScanSnapshot,
};
pub use ghostship_data_store::{GhostshipRecoveryPlan, GhostshipRecoveryResult};
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
pub use library::{
    ApplicationUpdateQuiescenceGuard, Library, LibraryChangeObserver, PortOperationGuard,
};
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
pub use portability_authority::PortabilityAuthority;
pub use preparation::{
    PreparationCleanupPreview, PreparationInputs, PreparationMode, PreparationOptions,
    PreparationPlan, PreparationTool,
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
pub use source_batch::{
    RegisteredSourceInspectionBatch, RegisteredSourceInspectionLimits, RegisteredSourceObservation,
};
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
pub use support_bundle::SupportBundleData;
pub use types::*;

// Private parked 58/59/64 contracts remain unclaimed. Public 65 adds game-file queries.
// Public 66 adds reviewed update assessments while retaining both delivered scopes.
// Public 67 adds caller-bound external review and retained source representation readiness.
// Public 68 adds the closed Ghostship legacy preparation mode and plan/receipt v2.
// Public 69 adds qualified Ghostship legacy snapshot recovery.
// Public 70 adds release-scoped input assessments and BIOS incompatibility guidance.
// Public 71 adds descriptive game identity and authored manual setup guidance.
// Public 72 adds retained-contract external folder relink and its activity operation.
// Install plans also expose optional recipe acquisitions and temporary install capacity.
// Public75 adds exact relative-file sets and closed managed TFE initialization.
// API74 retains managed Windows path policy; API73 retains external shared directories.
pub const API_SCHEMA_VERSION: u32 = 77;
/// Oldest library schema this build can read and migrate.
pub const MIN_LIBRARY_SCHEMA_VERSION: u32 = 1;
/// Library schema this build writes after opening a library.
pub const LIBRARY_SCHEMA_VERSION: u32 = database::CURRENT_SCHEMA_VERSION as u32;
/// Cross-process exclusion capability required by application update metadata.
pub const APPLICATION_UPDATE_LOCK_PROTOCOL: &str = "library-lock-v1";
