//! Compiled host configuration and installed-context selection for application updates.
//!
//! Updater-enabled builds embed only a public TUF root and fixed repository
//! locations. The default alpha build has no such configuration. Runtime
//! environment variables and frontend IPC cannot supply or replace this trust
//! authority.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use url::Url;

use crate::application_update::{ApplicationChannel, InstalledApplicationContext};
use crate::application_update_coordinator::ApplicationUpdateChecker;
use crate::application_update_helper::{
    ApplicationUpdateFreshSelection, ApplicationUpdateFreshSelectionError,
    ApplicationUpdateFreshSelectionProvider,
};
use crate::application_update_repository::{
    AuthenticatedCandidateSelection, CandidateLoadError, select_repository_candidate,
};
use crate::application_update_trust::{TrustedRepositoryRequest, load_trusted_repository};

const MAX_BUNDLED_ROOT_BYTES: usize = 256 * 1024;
const TRUST_DIRECTORY: &str = "trust";

mod compiled {
    include!(concat!(env!("OUT_DIR"), "/application-update-build.rs"));
}

#[derive(Debug, thiserror::Error)]
pub enum ApplicationUpdateHostConfigurationError {
    #[error("application update host configuration is invalid: {0}")]
    Invalid(String),
}

#[derive(Clone)]
pub struct ApplicationUpdateRepositoryConfiguration {
    bundled_root: Arc<[u8]>,
    metadata_base_url: Url,
    targets_base_url: Url,
    state_directory: PathBuf,
}

impl ApplicationUpdateRepositoryConfiguration {
    pub fn new(
        bundled_root: Vec<u8>,
        metadata_base_url: Url,
        targets_base_url: Url,
        state_directory: PathBuf,
    ) -> Result<Self, ApplicationUpdateHostConfigurationError> {
        if bundled_root.is_empty() || bundled_root.len() > MAX_BUNDLED_ROOT_BYTES {
            return Err(ApplicationUpdateHostConfigurationError::Invalid(
                "the bundled root is missing or oversized".into(),
            ));
        }
        if !state_directory.is_absolute() {
            return Err(ApplicationUpdateHostConfigurationError::Invalid(
                "the trust state directory must be absolute".into(),
            ));
        }
        Ok(Self {
            bundled_root: bundled_root.into(),
            metadata_base_url,
            targets_base_url,
            state_directory,
        })
    }

    /// Returns no configuration for ordinary alpha builds. Enabling this path
    /// requires all three build-time inputs; partial input fails the build.
    pub fn compiled() -> Result<Option<Self>, ApplicationUpdateHostConfigurationError> {
        if !compiled::ENABLED {
            return Ok(None);
        }
        let metadata_base_url = Url::parse(compiled::METADATA_BASE_URL)
            .map_err(|error| ApplicationUpdateHostConfigurationError::Invalid(error.to_string()))?;
        let targets_base_url = Url::parse(compiled::TARGETS_BASE_URL)
            .map_err(|error| ApplicationUpdateHostConfigurationError::Invalid(error.to_string()))?;
        let apply = crate::application_update_apply::ApplicationUpdateApplyStore::open_configured()
            .map_err(|error| ApplicationUpdateHostConfigurationError::Invalid(error.to_string()))?;
        let state_directory = apply.root().join(TRUST_DIRECTORY);
        Self::new(
            include_bytes!(concat!(env!("OUT_DIR"), "/application-update-root.json")).to_vec(),
            metadata_base_url,
            targets_base_url,
            state_directory,
        )
        .map(Some)
    }

    async fn select(
        &self,
        channel: ApplicationChannel,
        installed: &InstalledApplicationContext,
    ) -> Result<AuthenticatedCandidateSelection, CandidateLoadError> {
        let trusted = load_trusted_repository(TrustedRepositoryRequest {
            bundled_root: self.bundled_root.as_ref(),
            metadata_base_url: self.metadata_base_url.clone(),
            targets_base_url: self.targets_base_url.clone(),
            state_directory: &self.state_directory,
        })
        .await?;
        select_repository_candidate(&trusted, channel, installed).await
    }

    pub fn state_directory(&self) -> &Path {
        &self.state_directory
    }
}

pub trait InstalledApplicationContextSource: Send + Sync {
    fn observe(&self) -> Result<InstalledApplicationContext, String>;
}

#[derive(Debug, Default)]
pub struct CurrentInstalledApplicationContext;

impl InstalledApplicationContextSource for CurrentInstalledApplicationContext {
    fn observe(&self) -> Result<InstalledApplicationContext, String> {
        #[cfg(windows)]
        {
            crate::application_update_windows::current_windows_installed_application_context()
                .map_err(|_| {
                    "the running package is not an eligible registered installation".into()
                })
        }
        #[cfg(target_os = "linux")]
        {
            crate::application_update_linux::current_linux_appimage_context()
                .map_err(|error| error.to_string())
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            Err("this build has no installed application update adapter".into())
        }
    }
}

#[derive(Clone)]
pub struct ApplicationUpdateHostProvider {
    repository: ApplicationUpdateRepositoryConfiguration,
    installed: Arc<dyn InstalledApplicationContextSource>,
}

impl ApplicationUpdateHostProvider {
    pub fn new(
        repository: ApplicationUpdateRepositoryConfiguration,
        installed: Arc<dyn InstalledApplicationContextSource>,
    ) -> Self {
        Self {
            repository,
            installed,
        }
    }

    pub fn compiled() -> Result<Option<Self>, ApplicationUpdateHostConfigurationError> {
        Ok(ApplicationUpdateRepositoryConfiguration::compiled()?
            .map(|repository| Self::new(repository, Arc::new(CurrentInstalledApplicationContext))))
    }

    async fn select_fresh(
        &self,
        choice: &crate::application_update_preferences::ApplicationUpdateChoice,
    ) -> Result<ApplicationUpdateFreshSelection, ApplicationUpdateFreshSelectionError> {
        let installed = self
            .installed
            .observe()
            .map_err(ApplicationUpdateFreshSelectionError::InstalledContext)?;
        let authenticated = self.repository.select(choice.channel, &installed).await?;
        Ok(ApplicationUpdateFreshSelection {
            installed,
            authenticated,
        })
    }
}

#[async_trait]
impl ApplicationUpdateFreshSelectionProvider for ApplicationUpdateHostProvider {
    async fn select(
        &self,
        choice: &crate::application_update_preferences::ApplicationUpdateChoice,
    ) -> Result<ApplicationUpdateFreshSelection, ApplicationUpdateFreshSelectionError> {
        self.select_fresh(choice).await
    }
}

#[async_trait]
impl ApplicationUpdateChecker for ApplicationUpdateHostProvider {
    async fn check(
        &self,
        choice: crate::application_update_preferences::ApplicationUpdateChoice,
    ) -> Result<AuthenticatedCandidateSelection, CandidateLoadError> {
        self.select_fresh(&choice)
            .await
            .map(|selection| selection.authenticated)
            .map_err(|error| match error {
                ApplicationUpdateFreshSelectionError::InstalledContext(message) => {
                    CandidateLoadError::InstalledContext(message)
                }
                ApplicationUpdateFreshSelectionError::Candidate(error) => error,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_configuration_requires_bounded_root_and_absolute_state() {
        let metadata = Url::parse("file:///metadata/").unwrap();
        let targets = Url::parse("file:///targets/").unwrap();
        assert!(
            ApplicationUpdateRepositoryConfiguration::new(
                Vec::new(),
                metadata.clone(),
                targets.clone(),
                PathBuf::from("relative"),
            )
            .is_err()
        );
        assert!(
            ApplicationUpdateRepositoryConfiguration::new(
                vec![b'x'],
                metadata,
                targets,
                std::env::temp_dir().join("portcove-update-trust"),
            )
            .is_ok()
        );
    }
}
