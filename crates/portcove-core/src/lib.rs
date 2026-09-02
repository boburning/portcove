mod adapter;
mod archive;
mod auth;
mod catalog;
mod database;
mod error;
mod gitlab;
mod install;
mod launch;
mod library;
mod operation;
mod path;
mod process;
mod providers;
mod psx;
mod recovery;
mod release;
mod service;
mod types;

pub use adapter::{Adapter, AdapterRegistry};
pub use auth::{
    GithubAuthSource, GithubAuthStatus, GithubDeviceLogin, GithubDeviceLoginResult,
    GithubDeviceLoginState, GithubRateLimit,
};
pub use catalog::Catalog;
pub use error::{ErrorCode, PortcoveError, Result};
pub use gitlab::GitlabReleaseProvider;
pub use install::{InstallQualification, InstallRequest, Installer, VerificationReport};
pub use launch::forward_launch_signal;
pub use library::{Library, PortOperationGuard};
pub use operation::{OPERATION_EVENT_SCHEMA_VERSION, OperationCoordinator};
pub use process::{ChildProcessClass, ChildProcessPolicy, GameProcessSpec, LaunchKind, LaunchSpec};
pub use providers::CompositeReleaseProvider;
pub use psx::PsxManagedPreparation;
pub use release::{GithubReleaseProvider, ReleaseProvider};
pub use service::{AdoptionPreview, PortcoveService};
pub use types::*;

pub const API_SCHEMA_VERSION: u32 = 3;
