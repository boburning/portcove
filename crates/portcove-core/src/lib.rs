mod adapter;
mod auth;
mod catalog;
mod error;
mod gitlab;
mod install;
mod library;
mod process;
mod providers;
mod psx;
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
pub use install::{InstallRequest, Installer, VerificationReport};
pub use library::{Library, PortOperationGuard};
pub use process::{ChildProcessClass, ChildProcessPolicy, GameProcessSpec, LaunchKind, LaunchSpec};
pub use providers::CompositeReleaseProvider;
pub use psx::PsxManagedPreparation;
pub use release::{GithubReleaseProvider, ReleaseProvider};
pub use service::{AdoptionPreview, PortcoveService};
pub use types::*;

pub const API_SCHEMA_VERSION: u32 = 2;
