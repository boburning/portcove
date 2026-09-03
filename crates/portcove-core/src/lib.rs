mod adapter;
mod archive;
mod auth;
mod authorization;
mod cancellation;
mod catalog;
mod catalog_store;
mod catalog_update;
mod database;
mod durability;
mod error;
mod gitlab;
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
mod path;
mod portability;
mod process;
mod providers;
mod psx;
mod recovery;
mod release;
mod runtime;
mod service;
mod signed_catalog;
mod source;
mod source_discovery;
mod source_file;
mod transfer_copy;
mod transfer_journal;
mod types;

pub use adapter::{Adapter, AdapterRegistry};
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
pub use gitlab::GitlabReleaseProvider;
pub use import_execution::LibraryImportResult;
pub use install::{InstallQualification, InstallRequest, Installer, VerificationReport};
pub use launch::forward_launch_signal;
pub use library::{Library, PortOperationGuard};
pub use library_import::LibraryImportPlan;
pub use library_move::LibraryMoveResult;
pub use library_transfer::{LibraryMovePlan, LibraryTreePlan};
pub use operation::{OPERATION_EVENT_SCHEMA_VERSION, OperationCoordinator};
pub use portability::{
    LibraryContentKind, LibraryContentRoot, LibraryLaunchHistory, LibraryMetadata,
    LibraryMetadataFile, LibraryPortSettings,
};
pub use process::{ChildProcessClass, ChildProcessPolicy, GameProcessSpec, LaunchKind, LaunchSpec};
pub use providers::CompositeReleaseProvider;
pub use psx::PsxManagedPreparation;
pub use release::{GithubReleaseProvider, ReleaseProvider};
pub use service::{
    AdoptionCopyFile, AdoptionCopyPlan, AdoptionPreview, AdoptionSkippedEntry, BackupAction,
    BackupActionPreview, PortRemovalPreview, PortcoveService,
};
pub use signed_catalog::{
    CatalogOrigin, CatalogProvenance, CatalogTrustKey, SignedCatalogEnvelope, SignedCatalogPayload,
};
pub use source::SourceRelinkPlan;
pub use source_discovery::{
    SourceDiscoveryIssue, SourceDiscoveryLimit, SourceDiscoveryLimits, SourceDiscoveryReport,
    SourceDiscoveryRequest,
};
pub use types::*;

pub const API_SCHEMA_VERSION: u32 = 8;
