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
    AssetConflict, PortcoveError, PortcoveService, ProfileRevision, ProviderFileCandidate,
    ProviderFreshness, ProviderPackageRef, RecompExecution, Result, asset_conflicts,
    inspect_asset_archive,
    mod_package::extract_packages,
    profile,
    profile_deploy::{CodePolicy, adapter_extensions, inspect_for_port, sha256_file},
    provider_client::ProviderClient,
};

const MAX_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_REPORTED_CONFLICTS: usize = 100;
const STAGED_RETENTION_SECONDS: u64 = 24 * 60 * 60;
const ACTION: &str = "install_provider_package";
/// A plan whose packages run code is authorized separately, only when the player
/// explicitly allows that code.
const ACTION_WITH_CODE: &str = "install_provider_package_with_code";

/// Reviewed operational binding between a port and the provider's game identity.
/// Names and popularity never authorize compatibility; only this binding does.
/// Thunderstore communities are bound in `thunderstore`.
const GAMEBANANA_BINDINGS: &[(&str, u64)] = &[("shipwright", 16121)];

pub(crate) fn gamebanana_game(port_id: &str) -> Option<u64> {
    #[cfg(test)]
    if port_id == "starship" {
        return Some(777);
    }
    GAMEBANANA_BINDINGS
        .iter()
        .find(|(port, _)| *port == port_id)
        .map(|(_, game)| *game)
}

/// Ports with a reviewed provider binding, for passes that visit each of them.
pub(crate) fn provider_ports() -> impl Iterator<Item = &'static str> {
    GAMEBANANA_BINDINGS
        .iter()
        .map(|(port, _)| *port)
        .chain(crate::thunderstore::bound_ports())
}

/// The provider a port has a reviewed binding for, and its name in messages.
pub(crate) fn bound_provider(port_id: &str) -> Option<(&'static str, &'static str)> {
    if gamebanana_game(port_id).is_some() {
        Some((crate::gamebanana::PROVIDER, "GameBanana"))
    } else if crate::thunderstore::thunderstore_community(port_id).is_some() {
        Some((crate::thunderstore::PROVIDER, "Thunderstore"))
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PlanMember {
    pub file_name: String,
    pub sha256: String,
    pub size: u64,
    pub asset_count: usize,
    /// What the package runs if installed (Recomp code); empty for asset mods.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runs_code: Vec<RecompExecution>,
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
    /// Installed packages this plan replaces: the same native ID with different
    /// bytes, or a package the game loads as the same mod under another extension.
    pub replaces: Vec<String>,
    pub conflicts: Vec<AssetConflict>,
    pub conflicts_truncated: bool,
    /// What this plan relies on without verifying.
    pub unverified_claims: Vec<String>,
    pub plan_sha256: String,
}

pub(crate) fn digest(plan: &ProviderInstallPlan) -> Result<String> {
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
    /// Reviews one provider file for one profile without changing anything but a
    /// private staging area. IDs are the provider's own: a GameBanana mod and file
    /// number, or a Thunderstore `NAMESPACE-NAME` package and version.
    pub async fn plan_provider_install(
        &self,
        port_id: &str,
        profile_id: &str,
        project_id: &str,
        file_id: &str,
    ) -> Result<ProviderInstallPlan> {
        self.catalog().port(port_id)?;
        let client = ProviderClient::for_port(&self.library, port_id)?;
        self.plan_provider_install_via(&client, port_id, profile_id, project_id, file_id)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn plan_provider_install_with(
        &self,
        client: &crate::GameBananaClient,
        port_id: &str,
        profile_id: &str,
        project_id: u64,
        file_id: u64,
    ) -> Result<ProviderInstallPlan> {
        let client = ProviderClient::gamebanana(client, port_id)?;
        self.plan_provider_install_via(
            &client,
            port_id,
            profile_id,
            &project_id.to_string(),
            &file_id.to_string(),
        )
        .await
    }

    pub(crate) async fn plan_provider_install_via(
        &self,
        client: &ProviderClient,
        port_id: &str,
        profile_id: &str,
        project_id: &str,
        file_id: &str,
    ) -> Result<ProviderInstallPlan> {
        let layout = self.deploy_layout(port_id)?;
        let extensions = adapter_extensions(port_id).unwrap_or(&[]);
        let current = profile::current_revision(&self.library.connection()?, port_id, profile_id)?;

        let observed = client.project(project_id).await?;
        if observed.freshness == ProviderFreshness::Stale {
            return Err(PortcoveError::network(format!(
                "{} could not be reached; a plan needs a current observation, not cached data",
                client.label()
            )));
        }
        let project = observed.value;
        if project.game_id.as_deref() != Some(client.game_id().as_str()) {
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
            .find(|file| file.file_id == file_id)
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
        if !crate::profile::valid_native_id(&file.file_name) {
            return Err(PortcoveError::unsupported(
                "the provider's file name is not a plain file name; it cannot be installed",
            ));
        }
        let staging = tempfile::tempdir_in(layout.tmp())?;
        let download = staging.path().join("download.bin");
        let (download_sha256, download_size) = client
            .download(project_id, &file, &download, MAX_DOWNLOAD_BYTES)
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
        let mut recomp_code = std::collections::BTreeMap::<String, Vec<RecompExecution>>::new();

        // A loader that names packages by their own manifest (Recomp) is reviewed
        // the way a local install is: named by mod ID, other games refused, and
        // any code it would run reported for the player's decision.
        let member_paths = match crate::native_mod_list::recomp_game(port_id) {
            Some(game) => {
                let named_dir = staging.path().join("named");
                fs::create_dir(&named_dir)?;
                let mut renamed = Vec::new();
                let mut code = std::collections::BTreeMap::new();
                for path in &member_paths {
                    let recomp = crate::inspect_recomp_mod(path, game)?;
                    if recomp.holds.contains(&crate::RecompModHold::OtherGame) {
                        return Err(PortcoveError::unsupported(
                            "a mod in this file is made for a different game; it cannot be installed",
                        )
                        .detail("mod", &recomp.native_id));
                    }
                    if !recomp.execution.is_empty() || !recomp.holds.is_empty() {
                        crate::profile_deploy::require_admissible_code(&recomp)?;
                    }
                    let name = format!("{}.nrm", recomp.native_id);
                    // Names are compared case-insensitively, as on Windows.
                    if !profile::valid_native_id(&name)
                        || code
                            .keys()
                            .any(|used: &String| used.eq_ignore_ascii_case(&name))
                    {
                        return Err(PortcoveError::unsupported(
                            "this file contains two mods with the same ID, or an ID that cannot be a file name",
                        )
                        .detail("mod", &recomp.native_id));
                    }
                    // Reviewed members move into an empty folder under their IDs,
                    // so only a true duplicate can collide.
                    let destination = named_dir.join(&name);
                    fs::rename(path, &destination)?;
                    code.insert(name, recomp.execution);
                    renamed.push(destination);
                }
                recomp_code = code;
                renamed
            }
            None => member_paths,
        };

        // Recomp packages are reviewed through their manifests; which of two mods
        // wins an asset is not established for that loader, so their entries are
        // not compared, as for a local install.
        let compares_assets = crate::native_mod_list::recomp_game(port_id).is_none();
        let mut members = Vec::new();
        let mut inspections = Vec::new();
        for path in &member_paths {
            let mut inspection = inspect_asset_archive(path)?;
            if !compares_assets {
                inspection.asset_paths.clear();
            }
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
                runs_code: recomp_code
                    .get(&inspection.file_name)
                    .cloned()
                    .unwrap_or_default(),
            });
            inspections.push(inspection);
        }
        members.sort_by(|a, b| a.file_name.cmp(&b.file_name));

        // Conflicts are reported against what the profile has enabled now.
        let mut existing_assets = Vec::new();
        for package in current
            .packages
            .iter()
            .filter(|package| compares_assets && package.enabled)
        {
            let stored = layout.package(&package.sha256, &package.native_id);
            if let Ok(inspection) = inspect_asset_archive(&stored) {
                existing_assets.push((package.native_id.clone(), inspection.asset_paths));
            }
        }
        // The checks apply would make, made before anything is authorized.
        let named = crate::native_mod_list::contract(port_id).is_some();
        if named {
            for member in &members {
                crate::native_mod_list::require_listable(&member.file_name)?;
            }
            if let Some((first, second)) = crate::native_mod_list::identity_collision(
                members.iter().map(|member| member.file_name.as_str()),
            ) {
                return Err(PortcoveError::unsupported(
                    "this file contains two packages the game would load as the same mod, so it cannot be installed",
                )
                .detail("packages", format!("{first}, {second}")));
            }
        }
        // A package the game loads as the same mod is replaced, even under another
        // extension (`.otr` to `.o2r`).
        let same = |member: &PlanMember, id: &str| {
            member.file_name == id
                || (named && crate::native_mod_list::same_mod(&member.file_name, id))
        };
        let replaces = current
            .packages
            .iter()
            .filter(|package| {
                members.iter().any(|m| {
                    same(m, &package.native_id)
                        && (m.sha256 != package.sha256 || m.file_name != package.native_id)
                })
            })
            .map(|package| package.native_id.clone())
            .collect::<Vec<_>>();
        let mut ordered = existing_assets
            .iter()
            .filter(|(id, _)| !members.iter().any(|m| same(m, id)))
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
                provider: client.provider().into(),
                project: project_id.to_owned(),
                file: Some(file_id.to_owned()),
                // A Thunderstore version is the file itself; GameBanana shows one
                // label for the whole project.
                version: match client {
                    ProviderClient::Thunderstore { .. } => Some(file.file_id.clone()),
                    ProviderClient::GameBanana { .. } => project.version.clone(),
                },
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
    pub(crate) fn prune_staged(&self, root: &std::path::Path) {
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
        if let Some(member) = plan
            .members
            .iter()
            .find(|member| !member.runs_code.is_empty())
        {
            return Err(PortcoveError::usage(
                "this file includes a mod that runs its own code inside the game; it is installed only when you allow its code",
            )
            .detail("package", &member.file_name)
            .detail("sha256", &member.sha256));
        }
        self.library
            .issue_authorization(ACTION, &target(plan)?, &plan.plan_sha256)
    }

    /// Like [`Self::authorize_provider_install`], and the player allows the code of
    /// the packages this plan reports as running code. The plan digest binds those
    /// packages' exact bytes; it records the player's choice, not that the code is
    /// safe.
    pub fn authorize_provider_install_allowing_code(
        &self,
        plan: &ProviderInstallPlan,
    ) -> Result<crate::DestructiveAuthorization> {
        if digest(plan)? != plan.plan_sha256 {
            return Err(PortcoveError::verification(
                "the plan does not match its recorded digest",
            ));
        }
        let action = if plan
            .members
            .iter()
            .any(|member| !member.runs_code.is_empty())
        {
            ACTION_WITH_CODE
        } else {
            ACTION
        };
        self.library
            .issue_authorization(action, &target(plan)?, &plan.plan_sha256)
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
        if bound_provider(&plan.port_id)
            .is_none_or(|(provider, _)| plan.provider.provider != provider)
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
        let runs_code = plan
            .members
            .iter()
            .any(|member| !member.runs_code.is_empty());
        self.library.consume_authorization(
            token,
            if runs_code { ACTION_WITH_CODE } else { ACTION },
            &target(plan)?,
            &plan.plan_sha256,
        )?;
        let recorded = crate::profile_deploy::consented_code(&layout).unwrap_or_default();
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
            // The same loader review a local install gets.
            // Code is allowed only for packages the authorized plan reported as
            // running code, and only for their reviewed bytes.
            let allowed = (!member.runs_code.is_empty()).then_some(member.sha256.as_str());
            let item = inspect_for_port(
                &plan.port_id,
                path,
                Some(plan.provider.clone()),
                CodePolicy::Consent {
                    allowed,
                    recorded: &recorded,
                },
            )?;
            if item.inspection.sha256 != member.sha256 {
                return Err(PortcoveError::verification(
                    "the reviewed package bytes changed during inspection; plan again",
                ));
            }
            staged.push(item);
        }
        for item in &staged {
            if item.code_consent {
                crate::profile_deploy::record_code_consent(&layout, &item.inspection.sha256)?;
            }
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
        // The plan is caller-supplied: its digest names a directory only when it
        // is the digest of the plan itself.
        if digest(plan)? != plan.plan_sha256 {
            return Err(PortcoveError::conflict(
                "this plan was changed after review; nothing was discarded",
            ));
        }
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
