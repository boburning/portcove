//! Provider install: plan, consent, apply.
//!
//! Planning downloads a provider file privately, unwraps only loader packages,
//! inspects them without execution, and records exactly what would change. The plan
//! binds the computed bytes; the provider's checksum and scan claims are shown as
//! claims and never verified as authenticity. Apply consumes a one-use
//! authorization bound to the plan digest, rechecks the staged bytes and the
//! profile revision under the port lock, then installs through the ordinary
//! profile path. Bytes that differ from the plan invalidate it.
use std::fs;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AssetConflict, GameBananaClient, PortcoveError, PortcoveService, ProfileRevision,
    ProviderFileCandidate, ProviderFreshness, ProviderPackageRef, Result, asset_conflicts,
    inspect_asset_archive,
    mod_package::extract_packages,
    profile,
    profile_deploy::{StagedPackage, adapter_extensions, sha256_file},
};

const MAX_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_REPORTED_CONFLICTS: usize = 100;
const STAGED_RETENTION_SECONDS: u64 = 24 * 60 * 60;
const ACTION: &str = "install_provider_package";

/// Reviewed operational binding between a port and the provider's game identity.
/// Names and popularity never authorize compatibility; only this binding does.
fn gamebanana_game(port_id: &str) -> Option<u64> {
    match port_id {
        "shipwright" => Some(16121),
        #[cfg(test)]
        "starship" => Some(777),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PlanMember {
    pub file_name: String,
    pub sha256: String,
    pub size: u64,
    pub asset_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderInstallPlan {
    pub port_id: String,
    pub profile_id: String,
    /// Profile revision this plan was reviewed against.
    pub expected_revision: u64,
    pub provider: ProviderPackageRef,
    pub project_name: String,
    pub file: ProviderFileCandidate,
    /// Computed from the actual downloaded bytes.
    pub download_sha256: String,
    pub download_size: u64,
    pub members: Vec<PlanMember>,
    /// Entries of the provider's wrapper that are not packages and were not read.
    pub ignored_entries: u32,
    /// Installed packages with the same native ID but different bytes.
    pub replaces: Vec<String>,
    pub conflicts: Vec<AssetConflict>,
    pub conflicts_truncated: bool,
    /// What this plan relies on without verifying.
    pub unverified_claims: Vec<String>,
    pub plan_sha256: String,
}

fn digest(plan: &ProviderInstallPlan) -> Result<String> {
    let mut copy = plan.clone();
    copy.plan_sha256.clear();
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&copy)?)))
}

fn target(plan: &ProviderInstallPlan) -> Result<String> {
    Ok(serde_json::to_string(&(
        &plan.port_id,
        &plan.profile_id,
        &plan.plan_sha256,
    ))?)
}

impl PortcoveService {
    /// Reviews one GameBanana file for one profile without changing anything but a
    /// private staging area.
    pub async fn plan_provider_install(
        &self,
        port_id: &str,
        profile_id: &str,
        project_id: u64,
        file_id: u64,
    ) -> Result<ProviderInstallPlan> {
        let client = GameBananaClient::for_library(&self.library)?;
        self.plan_provider_install_with(&client, port_id, profile_id, project_id, file_id)
            .await
    }

    pub(crate) async fn plan_provider_install_with(
        &self,
        client: &GameBananaClient,
        port_id: &str,
        profile_id: &str,
        project_id: u64,
        file_id: u64,
    ) -> Result<ProviderInstallPlan> {
        let game = gamebanana_game(port_id).ok_or_else(|| {
            PortcoveError::unsupported("this port has no reviewed GameBanana binding yet")
        })?;
        let layout = self.deploy_layout(port_id)?;
        let extensions = adapter_extensions(port_id).unwrap_or(&[]);
        let current = profile::current_revision(&self.library.connection()?, port_id, profile_id)?;

        let observed = client.project(project_id).await?;
        if observed.freshness == ProviderFreshness::Stale {
            return Err(PortcoveError::network(
                "GameBanana could not be reached; a plan needs a current observation, not cached data",
            ));
        }
        let project = observed.value;
        if project.game_id.as_deref() != Some(game.to_string().as_str()) {
            return Err(PortcoveError::verification(
                "this project does not belong to the game this port is bound to",
            ));
        }
        if project.obsolete {
            return Err(PortcoveError::unsupported(
                "the provider marks this project obsolete",
            ));
        }
        let file = project
            .files
            .iter()
            .find(|file| file.file_id == file_id.to_string())
            .cloned()
            .ok_or_else(|| PortcoveError::not_found("the project has no such file"))?;
        if file.archived {
            return Err(PortcoveError::unsupported(
                "the provider archived this file",
            ));
        }
        if file.claimed_scan.as_deref() == Some("infected") {
            return Err(PortcoveError::unsupported(
                "the provider's scan reports this file as infected",
            ));
        }

        // Decide what the file is before spending bandwidth on it.
        let wrapper_extension = file
            .file_name
            .rsplit_once('.')
            .map(|(_, extension)| extension.to_ascii_lowercase())
            .unwrap_or_default();
        let direct_package = extensions.contains(&wrapper_extension.as_str());
        if !direct_package && wrapper_extension != "zip" {
            return Err(PortcoveError::unsupported(
                "the file is neither a supported package nor a zip wrapper",
            )
            .detail("accepted", extensions.join(", ")));
        }
        fs::create_dir_all(layout.tmp())?;
        let staging = tempfile::tempdir_in(layout.tmp())?;
        let download = staging.path().join("download.bin");
        let (download_sha256, download_size) = client
            .download_file(&file, &download, MAX_DOWNLOAD_BYTES)
            .await?;

        let members_dir = staging.path().join("members");
        fs::create_dir(&members_dir)?;
        let (member_paths, ignored) = if direct_package {
            let destination = members_dir.join(&file.file_name);
            fs::rename(&download, &destination)?;
            (vec![destination], 0)
        } else {
            let extracted = extract_packages(&download, &members_dir, extensions)?;
            (extracted.files, extracted.ignored)
        };
        if member_paths.is_empty() {
            return Err(PortcoveError::unsupported(
                "the download contains no package this game can load",
            ));
        }

        let mut members = Vec::new();
        let mut inspections = Vec::new();
        for path in &member_paths {
            let inspection = inspect_asset_archive(path)?;
            if let Some(hold) = inspection.holds.first() {
                return Err(PortcoveError::unsupported(format!(
                    "a package in the download is held: {hold:?}"
                ))
                .detail("package", &inspection.file_name));
            }
            members.push(PlanMember {
                file_name: inspection.file_name.clone(),
                sha256: inspection.sha256.clone(),
                size: inspection.size,
                asset_count: inspection.asset_paths.len(),
            });
            inspections.push(inspection);
        }
        members.sort_by(|a, b| a.file_name.cmp(&b.file_name));

        // Conflicts are reported against what the profile has enabled now.
        let mut existing_assets = Vec::new();
        for package in current.packages.iter().filter(|package| package.enabled) {
            let stored = layout.package(&package.sha256, &package.native_id);
            if let Ok(inspection) = inspect_asset_archive(&stored) {
                existing_assets.push((package.native_id.clone(), inspection.asset_paths));
            }
        }
        let replaces = current
            .packages
            .iter()
            .filter(|package| {
                members
                    .iter()
                    .any(|m| m.file_name == package.native_id && m.sha256 != package.sha256)
            })
            .map(|package| package.native_id.clone())
            .collect::<Vec<_>>();
        let mut ordered = existing_assets
            .iter()
            .filter(|(id, _)| !members.iter().any(|m| &m.file_name == id))
            .map(|(id, paths)| (id.as_str(), paths.as_slice()))
            .collect::<Vec<_>>();
        for inspection in &inspections {
            ordered.push((
                inspection.file_name.as_str(),
                inspection.asset_paths.as_slice(),
            ));
        }
        let mut conflicts = asset_conflicts(&ordered);
        let conflicts_truncated = conflicts.len() > MAX_REPORTED_CONFLICTS;
        conflicts.truncate(MAX_REPORTED_CONFLICTS);

        let mut plan = ProviderInstallPlan {
            port_id: port_id.into(),
            profile_id: profile_id.into(),
            expected_revision: current.revision,
            provider: ProviderPackageRef {
                provider: crate::gamebanana::PROVIDER.into(),
                project: project_id.to_string(),
                file: Some(file_id.to_string()),
                version: project.version.clone(),
            },
            project_name: project.name.clone(),
            file: file.clone(),
            download_sha256,
            download_size,
            members,
            ignored_entries: ignored.try_into().unwrap_or(u32::MAX),
            replaces,
            conflicts,
            conflicts_truncated,
            unverified_claims: [
                file.claimed_md5.as_ref().map(|_| {
                    "the provider's MD5 claim is recorded but not used as verification".to_owned()
                }),
                file.claimed_scan.as_ref().map(|scan| {
                    format!("the provider reports its own scan as \"{scan}\"; that is a claim")
                }),
                Some("a computed digest establishes bytes, not who published them".to_owned()),
            ]
            .into_iter()
            .flatten()
            .collect(),
            plan_sha256: String::new(),
        };
        plan.plan_sha256 = digest(&plan)?;

        self.prune_staged(&layout.store().join("staged"));
        let staged = layout.staged(&plan.plan_sha256);
        if staged.exists() {
            fs::remove_dir_all(&staged)?;
        }
        fs::create_dir_all(&staged)?;
        for path in &member_paths {
            let name = path
                .file_name()
                .ok_or_else(|| PortcoveError::state("a staged package lost its name"))?;
            fs::rename(path, staged.join(name))?;
        }
        Ok(plan)
    }

    /// Removes reviewed-but-unapplied staging older than a day (best effort).
    fn prune_staged(&self, root: &std::path::Path) {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| m.elapsed().ok())
                .is_some_and(|age| age.as_secs() > STAGED_RETENTION_SECONDS);
            if old {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    pub fn authorize_provider_install(
        &self,
        plan: &ProviderInstallPlan,
    ) -> Result<crate::DestructiveAuthorization> {
        if digest(plan)? != plan.plan_sha256 {
            return Err(PortcoveError::verification(
                "the plan does not match its recorded digest",
            ));
        }
        self.library
            .issue_authorization(ACTION, &target(plan)?, &plan.plan_sha256)
    }

    /// Installs exactly the reviewed bytes. A changed profile revision, missing or
    /// altered staged bytes, or a mismatched plan refuse without changing anything.
    pub fn apply_provider_install(
        &self,
        plan: &ProviderInstallPlan,
        token: &str,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(&plan.port_id)?;
        // A plan is caller-supplied data: re-establish what planning established.
        if gamebanana_game(&plan.port_id).is_none()
            || plan.provider.provider != crate::gamebanana::PROVIDER
            || plan.members.is_empty()
            || plan
                .members
                .iter()
                .any(|member| !profile::valid_native_id(&member.file_name))
        {
            return Err(PortcoveError::verification(
                "the plan names a provider, port or package this install does not accept",
            ));
        }
        let _guard = self
            .library
            .try_lock_port(&plan.port_id, "apply-provider-install")?;
        self.recover_switch_locked(&plan.port_id, &layout)?;
        if digest(plan)? != plan.plan_sha256 {
            return Err(PortcoveError::verification(
                "the plan does not match its recorded digest",
            ));
        }
        self.library
            .consume_authorization(token, ACTION, &target(plan)?, &plan.plan_sha256)?;
        let staged_dir = layout.staged(&plan.plan_sha256);
        let mut staged = Vec::new();
        for member in &plan.members {
            let path = staged_dir.join(&member.file_name);
            if !path.try_exists()? || sha256_file(&path)? != member.sha256 {
                return Err(PortcoveError::verification(
                    "the reviewed package bytes are missing or changed; plan again",
                )
                .detail("package", &member.file_name));
            }
            let inspection = inspect_asset_archive(&path)?;
            if inspection.sha256 != member.sha256 {
                return Err(PortcoveError::verification(
                    "the reviewed package bytes changed during inspection; plan again",
                ));
            }
            staged.push(StagedPackage {
                private: path,
                inspection,
                provider: Some(plan.provider.clone()),
            });
        }
        let revision = self.install_staged_locked(
            &plan.port_id,
            &plan.profile_id,
            plan.expected_revision,
            staged,
        )?;
        let _ = fs::remove_dir_all(staged_dir);
        Ok(revision)
    }

    /// Discards a reviewed plan's private staging.
    pub fn discard_provider_install(&self, plan: &ProviderInstallPlan) -> Result<()> {
        let layout = self.deploy_layout(&plan.port_id)?;
        let staged = layout.staged(&plan.plan_sha256);
        if staged.exists() {
            fs::remove_dir_all(staged)?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "provider_install_tests.rs"]
mod tests;
