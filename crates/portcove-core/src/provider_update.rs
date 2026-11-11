//! Update discovery for installed provider packages.
//!
//! Reads current provider observations and compares them with what a profile
//! installed. It changes nothing and picks nothing: several newer files are
//! reported as candidates, never resolved by a fuzzy name match, and a version
//! label that did not change can still hide a different file. Acting on a
//! candidate goes through the ordinary reviewed plan and consent path.
use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    GameBananaClient, PortcoveService, ProviderFileCandidate, ProviderFreshness,
    ProviderPackageRef, Result, profile,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderUpdateState {
    /// The installed file is still offered and nothing newer exists.
    Current,
    /// One or more files were added after the installed one.
    NewerFiles,
    /// The provider no longer offers the installed file.
    InstalledFileRemoved,
    /// No current observation: an outage, backoff or stale data. Not "no update".
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderUpdateObservation {
    pub native_id: String,
    pub provider: ProviderPackageRef,
    pub state: ProviderUpdateState,
    pub installed_version: Option<String>,
    pub observed_version: Option<String>,
    /// False with `NewerFiles` means files changed under an unchanged version label.
    pub version_changed: bool,
    /// Candidates in ascending file-ID order; more than one is ambiguous.
    pub newer_files: Vec<ProviderFileCandidate>,
    pub freshness: Option<ProviderFreshness>,
    pub reason: Option<String>,
}

impl PortcoveService {
    pub async fn check_provider_updates(
        &self,
        port_id: &str,
        profile_id: &str,
    ) -> Result<Vec<ProviderUpdateObservation>> {
        let client = GameBananaClient::for_library(&self.library)?;
        self.check_provider_updates_with(&client, port_id, profile_id)
            .await
    }

    pub(crate) async fn check_provider_updates_with(
        &self,
        client: &GameBananaClient,
        port_id: &str,
        profile_id: &str,
    ) -> Result<Vec<ProviderUpdateObservation>> {
        let revision = profile::current_revision(&self.library.connection()?, port_id, profile_id)?;
        // One observation per project, however many of its files are installed.
        let mut projects = BTreeMap::new();
        let mut observations = Vec::new();
        for package in &revision.packages {
            let Some(provider) = package.provider.clone() else {
                continue;
            };
            if provider.provider != crate::gamebanana::PROVIDER {
                continue;
            }
            let (Some(file), Ok(project_id)) =
                (provider.file.clone(), provider.project.parse::<u64>())
            else {
                continue;
            };
            let observed = match projects.get(&project_id) {
                Some(observed) => observed,
                None => {
                    let result = client.project(project_id).await;
                    projects.entry(project_id).or_insert(result)
                }
            };
            let installed_id = file.parse::<u64>().unwrap_or_default();
            let mut observation = ProviderUpdateObservation {
                native_id: package.native_id.clone(),
                installed_version: provider.version.clone(),
                provider,
                state: ProviderUpdateState::Unavailable,
                observed_version: None,
                version_changed: false,
                newer_files: Vec::new(),
                freshness: None,
                reason: None,
            };
            match observed {
                Err(error) => observation.reason = Some(error.message.clone()),
                Ok(observed) if observed.freshness == ProviderFreshness::Stale => {
                    observation.freshness = Some(ProviderFreshness::Stale);
                    observation.reason =
                        Some("the provider could not be reached; this is earlier data".into());
                }
                Ok(observed) => {
                    let project = &observed.value;
                    observation.freshness = Some(observed.freshness);
                    observation.observed_version = project.version.clone();
                    if project.obsolete {
                        observation.reason =
                            Some("the provider marks this project obsolete".into());
                    }
                    observation.version_changed = project.version != observation.installed_version;
                    let still_offered = project
                        .files
                        .iter()
                        .any(|candidate| candidate.file_id == file && !candidate.archived);
                    let mut newer = project
                        .files
                        .iter()
                        .filter(|candidate| {
                            !candidate.archived
                                && candidate.file_id.parse::<u64>().unwrap_or_default()
                                    > installed_id
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    newer.sort_by_key(|candidate| {
                        candidate.file_id.parse::<u64>().unwrap_or_default()
                    });
                    observation.state = if !newer.is_empty() {
                        ProviderUpdateState::NewerFiles
                    } else if !still_offered {
                        ProviderUpdateState::InstalledFileRemoved
                    } else {
                        ProviderUpdateState::Current
                    };
                    observation.newer_files = newer;
                }
            }
            observations.push(observation);
        }
        Ok(observations)
    }
}

#[cfg(test)]
#[path = "provider_update_tests.rs"]
mod tests;
