//! Provider install: plan, consent, apply.
//!
//! Planning downloads a provider file privately, unwraps only loader packages,
//! inspects them without execution, and records exactly what would change. The plan
//! binds the computed bytes; the provider's checksum and scan claims are shown as
//! claims and never verified as authenticity. Apply consumes a one-use
//! authorization bound to the plan digest, rechecks the staged bytes and the
//! profile revision under the port lock, then installs through the ordinary
//! profile path. Bytes that differ from the plan invalidate it.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AssetConflict, PortcoveError, PortcoveService, ProfileRevision, ProfileUpdatePolicy,
    ProviderFileCandidate, ProviderFreshness, ProviderPackageRef, ProviderProject,
    ProviderRequirement, RecompExecution, Result, asset_conflicts, inspect_asset_archive,
    mod_package::{MAX_EXTRACTED_BYTES, MAX_MEMBERS, extract_provider_packages},
    profile,
    profile_deploy::{
        CodePolicy, Layout, inspect_for_port, require_reviewed_or_reordered, sha256_file,
    },
    provider_client::ProviderClient,
};

const MAX_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_REPORTED_CONFLICTS: usize = 100;
pub(crate) const RECOMP_REVIEW_BINDING: &str = "recomp_review_binding";
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
pub struct ProviderWrapper {
    pub provider: ProviderPackageRef,
    pub file: ProviderFileCandidate,
    pub download_sha256: String,
    pub download_size: u64,
    pub members: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderInstallPlan {
    pub port_id: String,
    pub profile_id: String,
    /// Private workspace reviews use distinct staging even for the same file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_nonce: Option<String>,
    /// Profile revision this plan was reviewed against.
    pub expected_revision: u64,
    pub provider: ProviderPackageRef,
    pub project_name: String,
    pub file: ProviderFileCandidate,
    /// Computed from the actual downloaded bytes.
    pub download_sha256: String,
    pub download_size: u64,
    pub members: Vec<PlanMember>,
    /// Exact Thunderstore wrapper closure in dependency-first order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wrappers: Vec<ProviderWrapper>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModSetupDraftPreview {
    pub order: Vec<String>,
    /// Local packages that require consent after the complete draft passes dependency checks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub local_code_packages: Vec<String>,
    pub conflicts: Vec<AssetConflict>,
    pub conflicts_truncated: bool,
}

struct PreparedModSetupDraft {
    packages: Vec<crate::profile_deploy::StagedPackage>,
    provider_directories: Vec<PathBuf>,
    _local_directories: Vec<tempfile::TempDir>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderInstallMode<'a> {
    Reviewed,
    Workspace,
    Automatic,
    Recipe { identity: &'a str, byte_budget: u64 },
}

impl ProviderInstallMode<'_> {
    fn staging_root(self, layout: &Layout) -> PathBuf {
        let store = layout.store();
        match self {
            Self::Reviewed | Self::Workspace => store.join("staged"),
            Self::Automatic => store.join("automatic-staged"),
            Self::Recipe { identity, .. } => store.join("recipe-staged").join(identity),
        }
    }

    pub(crate) fn staging(self, layout: &Layout, digest: &str) -> PathBuf {
        match self {
            Self::Reviewed | Self::Workspace => layout.staged(digest),
            Self::Automatic | Self::Recipe { .. } => self.staging_root(layout).join(digest),
        }
    }
}

pub(crate) fn recomp_review_binding(
    revision_digest: &str,
    file: &ProviderFileCandidate,
) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        revision_digest,
        file,
    ))?)))
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

pub(crate) fn validate_offer(
    client: &ProviderClient,
    project: &ProviderProject,
    file: &ProviderFileCandidate,
) -> Result<()> {
    if project.game_id.as_deref() != Some(client.game_id().as_str()) {
        return Err(PortcoveError::verification(
            "this project does not belong to the game this port is bound to",
        ));
    }
    if project.status_unknown.is_some() || file.status_unknown.is_some() {
        return Err(PortcoveError::verification(
            crate::mod_provider::UNKNOWN_PROVIDER_ELIGIBILITY,
        ));
    }
    if project.obsolete {
        return Err(PortcoveError::unsupported(
            "the provider marks this project obsolete",
        ));
    }
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
    if !profile::valid_native_id(&file.file_name) {
        return Err(PortcoveError::unsupported(
            "the provider's file name is not a plain file name; it cannot be installed",
        ));
    }
    Ok(())
}

pub(crate) fn accepts_provider_file(layout: &Layout, file: &ProviderFileCandidate) -> bool {
    let extension = file
        .file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    (extension == "zip" || layout.package_extensions().contains(&extension.as_str()))
        && file.size > 0
        && file.size <= MAX_DOWNLOAD_BYTES
}

fn matches_dependency_coordinates(
    recorded: &[ProviderRequirement],
    offered: &ProviderFileCandidate,
) -> bool {
    offered
        .thunderstore_dependencies
        .as_ref()
        .is_some_and(|dependencies| {
            dependencies.len() == recorded.len()
                && dependencies.iter().all(|dependency| {
                    let project = format!("{}-{}", dependency.namespace, dependency.package);
                    recorded.iter().any(|required| {
                        required.provider.project == project
                            && required.provider.file.as_deref()
                                == Some(dependency.version.as_str())
                    })
                })
        })
}

/// Only previously reviewed, complete and enabled dependencies can be reused.
/// A fresh listing must still name the same exact graph before any download.
fn retained_dependencies(
    layout: &Layout,
    revision: &ProfileRevision,
    project: &str,
    file: &ProviderFileCandidate,
    binding: Option<&crate::ModProviderBinding>,
    observed: Option<&[(ProviderProject, ProviderFileCandidate)]>,
) -> Result<Vec<ProviderRequirement>> {
    let changed = || {
        PortcoveError::unsupported(
        "the Thunderstore dependency set changed or has no complete prior review; review this update",
    ).detail("project", project)
    };
    let mut roots = revision.packages.iter().filter(|package| {
        package.provider.as_ref().is_some_and(|provider| {
            provider.provider == crate::thunderstore::PROVIDER
                && provider.project == project
                && provider.binding.as_ref() == binding
        })
    });
    let root = roots.next().ok_or_else(changed)?;
    if !root.enabled
        || !matches_dependency_coordinates(&root.provider_requires, file)
        || roots.any(|package| {
            !package.enabled
                || package.provider != root.provider
                || package.provider_requires != root.provider_requires
        })
    {
        return Err(changed());
    }

    let mut pending = root.provider_requires.iter().collect::<Vec<_>>();
    let mut reviewed = BTreeMap::<&str, &ProviderRequirement>::new();
    let mut remaining_members = MAX_MEMBERS;
    let mut remaining_bytes = MAX_EXTRACTED_BYTES;
    while let Some(required) = pending.pop() {
        if required.provider.provider != crate::thunderstore::PROVIDER
            || required.provider.binding.as_ref() != binding
        {
            return Err(changed());
        }
        let name = required.provider.project.as_str();
        if let Some(previous) = reviewed.get(name) {
            if *previous != required {
                return Err(changed());
            }
            continue;
        }
        if name == project || reviewed.len() >= MAX_MEMBERS {
            return Err(changed());
        }
        let missing = || {
            PortcoveError::unsupported(
            "a required Thunderstore package is missing, changed or turned off; review this update",
        ).detail("project", name)
            .detail("version", required.provider.version.as_deref().unwrap_or_default())
        };
        let packages = revision
            .packages
            .iter()
            .filter(|package| package.provider.as_ref() == Some(&required.provider))
            .collect::<Vec<_>>();
        let primary = *packages.first().ok_or_else(missing)?;
        if packages.len() != required.members.len() {
            return Err(missing());
        }
        remaining_members = remaining_members
            .checked_sub(packages.len())
            .ok_or_else(changed)?;
        for package in packages {
            remaining_bytes = remaining_bytes
                .checked_sub(package.size)
                .ok_or_else(changed)?;
            if !package.enabled
                || package.provider_requires != primary.provider_requires
                || required.members.get(&package.native_id) != Some(&package.sha256)
            {
                return Err(missing());
            }
            let path = layout.package(&package.sha256, &package.native_id);
            if !crate::external_runtime::hash_stable_regular(&path, package.size, &|| Ok(()))
                .is_ok_and(|(digest, size)| size == package.size && digest == package.sha256)
            {
                return Err(missing());
            }
        }
        if let Some(observed) = observed {
            let observation = observed
                .iter()
                .find(|(project, file)| {
                    project.project_id == name
                        && required.provider.file.as_deref() == Some(file.file_id.as_str())
                })
                .map(|(_, file)| file)
                .ok_or_else(changed)?;
            if !matches_dependency_coordinates(&primary.provider_requires, observation) {
                return Err(changed());
            }
        }
        pending.extend(&primary.provider_requires);
        reviewed.insert(name, required);
    }
    Ok(reviewed.into_values().cloned().collect())
}

pub(crate) struct ReviewedMember<'a> {
    pub(crate) provider: &'a ProviderPackageRef,
    pub(crate) requirements: Vec<ProviderRequirement>,
}

/// Validate that every reviewed native member belongs to exactly one wrapper,
/// with all exact prerequisites earlier in the same reviewed closure.
pub(crate) fn wrapper_members<'a>(
    plan: &'a ProviderInstallPlan,
    retained: &[ProviderRequirement],
) -> Result<BTreeMap<&'a str, ReviewedMember<'a>>> {
    let mut members = BTreeMap::new();
    if plan.provider.provider != crate::thunderstore::PROVIDER {
        if !plan.wrappers.is_empty() {
            return Err(PortcoveError::verification(
                "unexpected Thunderstore wrapper review",
            ));
        }
        return Ok(members);
    }
    let invalid = || {
        PortcoveError::verification(
            "the reviewed Thunderstore wrapper set is incomplete or inconsistent; plan again",
        )
    };
    let root = plan.wrappers.last().ok_or_else(invalid)?;
    if root.provider != plan.provider
        || root.file != plan.file
        || root.download_sha256 != plan.download_sha256
        || root.download_size != plan.download_size
    {
        return Err(invalid());
    }
    let reviewed = plan
        .members
        .iter()
        .map(|member| (member.file_name.as_str(), &member.sha256))
        .collect::<BTreeMap<_, _>>();
    let mut seen = retained
        .iter()
        .map(|required| (required.provider.project.as_str(), required.clone()))
        .collect::<BTreeMap<_, _>>();
    for wrapper in &plan.wrappers {
        if wrapper.provider.provider != crate::thunderstore::PROVIDER
            || wrapper.provider.file.as_ref() != Some(&wrapper.file.file_id)
            || wrapper.provider.version != wrapper.provider.file
            || wrapper.members.is_empty()
        {
            return Err(invalid());
        }
        let mut requirements = Vec::new();
        for dependency in wrapper
            .file
            .thunderstore_dependencies
            .as_ref()
            .ok_or_else(invalid)?
        {
            let project = format!("{}-{}", dependency.namespace, dependency.package);
            let required = seen
                .get(project.as_str())
                .filter(|required| {
                    required.provider.file.as_deref() == Some(dependency.version.as_str())
                })
                .ok_or_else(invalid)?;
            requirements.push(required.clone());
        }
        let proof = ProviderRequirement {
            provider: wrapper.provider.clone(),
            members: wrapper.members.clone(),
        };
        if seen.insert(&wrapper.provider.project, proof).is_some() {
            return Err(invalid());
        }
        for (id, hash) in &wrapper.members {
            if reviewed.get(id.as_str()) != Some(&hash)
                || members
                    .insert(
                        id.as_str(),
                        ReviewedMember {
                            provider: &wrapper.provider,
                            requirements: requirements.clone(),
                        },
                    )
                    .is_some()
            {
                return Err(invalid());
            }
        }
    }
    if members.len() != plan.members.len() {
        return Err(invalid());
    }
    Ok(members)
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
        self.plan_provider_install_for_provider(port_id, profile_id, project_id, file_id, None)
            .await
    }

    pub async fn plan_provider_install_for_provider(
        &self,
        port_id: &str,
        profile_id: &str,
        project_id: &str,
        file_id: &str,
        provider: Option<&str>,
    ) -> Result<ProviderInstallPlan> {
        let client =
            ProviderClient::for_definition(&self.library, self.catalog().port(port_id)?, provider)?;
        self.plan_provider_install_via(&client, port_id, profile_id, project_id, file_id)
            .await
    }

    pub async fn plan_workspace_provider_install(
        &self,
        port_id: &str,
        profile_id: &str,
        source: &str,
        project_id: &str,
        file_id: &str,
        expected_game_id: &str,
    ) -> Result<ProviderInstallPlan> {
        let client = ProviderClient::for_definition(
            &self.library,
            self.catalog().port(port_id)?,
            Some(source),
        )?;
        if client.game_id() != expected_game_id {
            return Err(PortcoveError::conflict(
                "the selected mod source changed scope",
            ));
        }
        self.plan_provider_install_in_mode(
            &client,
            port_id,
            profile_id,
            project_id,
            file_id,
            ProviderInstallMode::Workspace,
        )
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
        self.plan_provider_install_in_mode(
            client,
            port_id,
            profile_id,
            project_id,
            file_id,
            ProviderInstallMode::Reviewed,
        )
        .await
    }

    pub(crate) async fn plan_provider_install_in_mode(
        &self,
        client: &ProviderClient,
        port_id: &str,
        profile_id: &str,
        project_id: &str,
        file_id: &str,
        mode: ProviderInstallMode<'_>,
    ) -> Result<ProviderInstallPlan> {
        let current = profile::current_revision(&self.library.connection()?, port_id, profile_id)?;
        // A recipe checks its own retained target when the staged inputs are reviewed together.
        let layout = if matches!(mode, ProviderInstallMode::Recipe { .. }) {
            self.deploy_layout(port_id)?
        } else {
            self.require_layout_for_revision(&current)?
        };
        let extensions = layout.package_extensions();

        let projects = match client {
            ProviderClient::Thunderstore { client, community } => {
                let listing = client.community(community).await?;
                if listing.freshness == ProviderFreshness::Stale {
                    return Err(PortcoveError::network(
                        "Thunderstore could not be reached; a plan needs a current observation",
                    ));
                }
                crate::thunderstore::resolve_dependencies(&listing.value, project_id, file_id)?
                    .into_iter()
                    .map(|(project, file)| (project.clone(), file.clone()))
                    .collect::<Vec<_>>()
            }
            ProviderClient::GameBanana { .. } => {
                let observed = client.project(project_id).await?;
                if observed.freshness == ProviderFreshness::Stale {
                    return Err(PortcoveError::network(
                        "GameBanana could not be reached; a plan needs a current observation",
                    ));
                }
                let project = observed.value;
                let file = project
                    .files
                    .iter()
                    .find(|file| file.file_id == file_id)
                    .cloned()
                    .ok_or_else(|| PortcoveError::not_found("the project has no such file"))?;
                vec![(project, file)]
            }
        };
        if mode == ProviderInstallMode::Automatic
            && current
                .packages
                .iter()
                .filter(|package| package.enabled)
                .flat_map(|package| &package.provider_requires)
                .any(|requirement| {
                    requirement.provider.project == project_id
                        && requirement.provider.file.as_deref() != Some(file_id)
                })
        {
            return Err(PortcoveError::unsupported(
                "another enabled mod needs the installed Thunderstore version; review the dependent mod first",
            ));
        }
        let (project, file) = projects
            .last()
            .ok_or_else(|| PortcoveError::verification("the provider returned no exact package"))?;
        let scope = client.binding();
        let binding = (crate::provider_binding::legacy_binding(port_id, client.provider())
            .as_ref()
            != Some(&scope))
        .then_some(scope);
        let reuse_dependencies = mode == ProviderInstallMode::Automatic
            && matches!(client, ProviderClient::Thunderstore { .. });
        let retained = if reuse_dependencies {
            retained_dependencies(
                &layout,
                &current,
                project_id,
                file,
                binding.as_ref(),
                Some(&projects),
            )?
        } else {
            Vec::new()
        };
        let projects =
            if reuse_dependencies {
                std::slice::from_ref(projects.last().ok_or_else(|| {
                    PortcoveError::state("the exact package changed during review")
                })?)
            } else {
                projects.as_slice()
            };
        fs::create_dir_all(layout.tmp())?;
        let staging = tempfile::tempdir_in(layout.tmp())?;
        let mut member_paths = Vec::new();
        let mut source_indices = Vec::new();
        let mut wrappers = Vec::new();
        let mut ignored = 0usize;
        let mut combined_budget = match mode {
            ProviderInstallMode::Recipe { byte_budget, .. } => byte_budget,
            _ => u64::MAX,
        };
        let mut download_budget = MAX_DOWNLOAD_BYTES;
        let mut extraction_budget = MAX_EXTRACTED_BYTES;
        for (index, (project, file)) in projects.iter().enumerate() {
            validate_offer(client, project, file)?;
            let extension = file
                .file_name
                .rsplit_once('.')
                .map(|(_, extension)| extension.to_ascii_lowercase())
                .unwrap_or_default();
            let direct = extensions.contains(&extension.as_str());
            if !direct && extension != "zip" {
                return Err(PortcoveError::unsupported(
                    "the file is neither a supported package nor a zip wrapper",
                )
                .detail("accepted", extensions.join(", ")));
            }
            let directory = staging.path().join(index.to_string());
            fs::create_dir(&directory)?;
            let download = directory.join("download.bin");
            let (download_sha256, download_size) = client
                .download(
                    &project.project_id,
                    file,
                    &download,
                    download_budget.min(combined_budget),
                )
                .await?;
            download_budget -= download_size;
            combined_budget -= download_size;
            let members_dir = directory.join("members");
            fs::create_dir(&members_dir)?;
            let paths = if direct {
                if download_size > extraction_budget.min(combined_budget) {
                    return Err(PortcoveError::unsupported(
                        "the package set exceeds its size limit",
                    ));
                }
                extraction_budget -= download_size;
                combined_budget -= download_size;
                if member_paths.len() == MAX_MEMBERS {
                    return Err(PortcoveError::unsupported(
                        "the package set has too many members",
                    ));
                }
                let destination = members_dir.join(&file.file_name);
                fs::rename(download, &destination)?;
                vec![destination]
            } else {
                let extracted = extract_provider_packages(
                    &download,
                    &members_dir,
                    extensions,
                    extraction_budget.min(combined_budget),
                    MAX_MEMBERS - member_paths.len(),
                    projects.len(),
                    matches!(client, ProviderClient::Thunderstore { .. })
                        .then_some((project.project_id.as_str(), file)),
                )?;
                extraction_budget -= extracted.extracted_bytes;
                combined_budget -= extracted.extracted_bytes;
                ignored += extracted.ignored;
                extracted.files
            };
            if paths.is_empty() {
                return Err(PortcoveError::unsupported(
                    "the download contains no package this game can load",
                )
                .detail("project", &project.project_id)
                .detail("file", &file.file_id));
            }
            source_indices.extend(std::iter::repeat_n(index, paths.len()));
            member_paths.extend(paths);
            wrappers.push(ProviderWrapper {
                provider: ProviderPackageRef {
                    binding: binding.clone(),
                    provider: client.provider().into(),
                    project: project.project_id.clone(),
                    file: Some(file.file_id.clone()),
                    version: match client {
                        ProviderClient::Thunderstore { .. } => Some(file.file_id.clone()),
                        ProviderClient::GameBanana { .. } => project.version.clone(),
                    },
                },
                file: file.clone(),
                download_sha256,
                download_size,
                members: BTreeMap::new(),
            });
        }
        let mut recomp_members = std::collections::BTreeMap::new();

        // A loader that names packages by their own manifest (Recomp) is reviewed
        // the way a local install is: named by mod ID, other games refused, and
        // any code it would run reported for the player's decision.
        let member_paths = match layout.recomp_game() {
            Some(game) => {
                let named_dir = staging.path().join("named");
                fs::create_dir(&named_dir)?;
                let mut renamed = Vec::new();
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
                        || recomp_members
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
                    recomp_members.insert(name, recomp);
                    renamed.push(destination);
                }
                renamed
            }
            None => member_paths,
        };

        // Recomp packages are reviewed through their manifests; which of two mods
        // wins an asset is not established for that loader, so their entries are
        // not compared, as for a local install.
        let compares_assets = layout.recomp_game().is_none();
        let mut members = Vec::new();
        let mut inspections = Vec::new();
        for (path, index) in member_paths.iter().zip(source_indices) {
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
            wrappers[index]
                .members
                .insert(inspection.file_name.clone(), inspection.sha256.clone());
            members.push(PlanMember {
                file_name: inspection.file_name.clone(),
                sha256: inspection.sha256.clone(),
                size: inspection.size,
                asset_count: inspection.asset_paths.len(),
                runs_code: recomp_members
                    .get(&inspection.file_name)
                    .map(|recomp| recomp.execution.clone())
                    .unwrap_or_default(),
            });
            inspections.push(inspection);
        }
        members.sort_by(|a, b| a.file_name.cmp(&b.file_name));

        // Conflicts are reported against what the profile has enabled now.
        let mut existing_assets = Vec::new();
        for package in current.packages.iter().filter(|package| {
            compares_assets
                && package.enabled
                && !matches!(mode, ProviderInstallMode::Recipe { .. })
        }) {
            let stored = layout.package(&package.sha256, &package.native_id);
            if let Ok(inspection) = inspect_asset_archive(&stored) {
                existing_assets.push((package.native_id.clone(), inspection.asset_paths));
            }
        }
        // The checks apply would make, made before anything is authorized.
        let named = layout.loader_list().is_some();
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
                !matches!(mode, ProviderInstallMode::Recipe { .. })
                    && members.iter().any(|m| {
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

        let root = wrappers
            .last()
            .ok_or_else(|| PortcoveError::state("missing wrapper review"))?;
        let mut plan = ProviderInstallPlan {
            port_id: port_id.into(),
            profile_id: profile_id.into(),
            review_nonce: (mode == ProviderInstallMode::Workspace)
                .then(|| uuid::Uuid::new_v4().to_string()),
            expected_revision: current.revision,
            provider: root.provider.clone(),
            project_name: project.name.clone(),
            file: file.clone(),
            download_sha256: root.download_sha256.clone(),
            download_size: root.download_size,
            members,
            wrappers: if matches!(client, ProviderClient::Thunderstore { .. }) {
                wrappers
            } else {
                Vec::new()
            },
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
        let reviewed = wrapper_members(&plan, &retained)?;
        if !matches!(
            mode,
            ProviderInstallMode::Recipe { .. } | ProviderInstallMode::Workspace
        ) && !reviewed.is_empty()
        {
            for installed in &current.packages {
                if !plan
                    .members
                    .iter()
                    .any(|member| same(member, &installed.native_id))
                    && installed.provider.as_ref().is_some_and(|provider| {
                        plan.wrappers.iter().any(|wrapper| {
                            crate::provider_binding::same_project(
                                port_id,
                                &wrapper.provider,
                                provider,
                            )
                        })
                    })
                {
                    return Err(PortcoveError::conflict(
                        "the reviewed Thunderstore version drops a previously installed member; review its removal first",
                    ).detail("package", &installed.native_id));
                }
            }
            let disabled = plan
                .members
                .iter()
                .filter(|member| {
                    current
                        .packages
                        .iter()
                        .any(|package| !package.enabled && same(member, &package.native_id))
                })
                .map(|member| member.file_name.as_str())
                .collect::<BTreeSet<_>>();
            for (name, member) in &reviewed {
                if disabled.contains(name) {
                    continue;
                }
                for requirement in &member.requirements {
                    if let Some(required) = requirement
                        .members
                        .keys()
                        .find(|id| disabled.contains(id.as_str()))
                    {
                        return Err(PortcoveError::conflict(
                            "turn on the required mod in this setup, then review the Thunderstore version again",
                        ).detail("package", *name).detail("requires", required));
                    }
                }
            }
            // Existing dependants may still require an older exact package or
            // bytes. Surface that before the user is asked to authorize.
            for installed in &current.packages {
                if plan
                    .members
                    .iter()
                    .any(|member| same(member, &installed.native_id))
                {
                    continue;
                }
                profile::validate_provider_requirements(
                    &installed.native_id,
                    installed.enabled,
                    &installed.provider_requires,
                    |provider, id, hash| {
                        if let Some(member) = plan.members.iter().find(|member| same(member, id)) {
                            return member.file_name == id
                                && !disabled.contains(id)
                                && member.sha256 == hash
                                && reviewed
                                    .get(id)
                                    .is_some_and(|member| member.provider == provider);
                        }
                        current.packages.iter().any(|member| {
                            member.enabled
                                && member.native_id == id
                                && member.sha256 == hash
                                && member.provider.as_ref() == Some(provider)
                        })
                    },
                )?;
            }
        }
        if !recomp_members.is_empty()
            && !matches!(
                mode,
                ProviderInstallMode::Recipe { .. } | ProviderInstallMode::Workspace
            )
        {
            let _guard = self
                .library
                .try_read_lock_port(port_id, "plan-provider-recomp")?;
            let latest =
                profile::current_revision(&self.library.connection()?, port_id, profile_id)?;
            if latest.digest != current.digest {
                return Err(PortcoveError::conflict(
                    "the setup changed; review the package again",
                ));
            }
            if let Err(error) =
                self.review_recomp_changes(&layout, &latest, recomp_members.values(), None)
            {
                if mode == ProviderInstallMode::Automatic
                    && error.details.get("review_stage").is_some_and(|stage| {
                        stage == crate::profile_loader::RECOMP_DEPENDENCY_REVIEW
                    })
                {
                    return Err(error.detail(
                        RECOMP_REVIEW_BINDING,
                        recomp_review_binding(&latest.digest, &plan.file)?,
                    ));
                }
                return Err(error);
            }
        }
        plan.plan_sha256 = digest(&plan)?;

        let _recipe_lock = if matches!(mode, ProviderInstallMode::Recipe { .. }) {
            Some(
                self.library
                    .try_lock_port(port_id, "stage-recipe-provider-file")?,
            )
        } else {
            None
        };
        if matches!(mode, ProviderInstallMode::Recipe { .. }) {
            self.prune_staged(&layout.store().join("recipe-staged"));
        }
        let staging_root = mode.staging_root(&layout);
        self.prune_staged(&staging_root);
        fs::create_dir_all(&staging_root)?;
        let staged = mode.staging(&layout, &plan.plan_sha256);
        let reviewed = staging.path().join("reviewed");
        fs::create_dir(&reviewed)?;
        for path in &member_paths {
            let name = path
                .file_name()
                .ok_or_else(|| PortcoveError::state("a staged package lost its name"))?;
            fs::rename(path, reviewed.join(name))?;
        }
        if let Err(error) = fs::rename(reviewed, &staged) {
            // A concurrent plan for the same digest can publish the same bytes.
            if !staged.is_dir() {
                return Err(error.into());
            }
            for member in &plan.members {
                if sha256_file(&staged.join(&member.file_name))? != member.sha256 {
                    return Err(PortcoveError::verification(
                        "the staged review changed; discard it and plan again",
                    ));
                }
            }
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

    fn require_current_provider_scope(&self, plan: &ProviderInstallPlan) -> Result<()> {
        let (catalog, _) = self.library.load_catalog()?;
        let port = catalog.port(&plan.port_id)?;
        if !crate::provider_binding::reference_matches(port, &plan.provider)
            || plan.wrappers.iter().any(|wrapper| {
                wrapper.provider.provider != plan.provider.provider
                    || !crate::provider_binding::reference_matches(port, &wrapper.provider)
            })
        {
            return Err(PortcoveError::verification(
                "the plan names a provider scope this port does not accept",
            ));
        }
        Ok(())
    }

    pub fn authorize_provider_install(
        &self,
        plan: &ProviderInstallPlan,
    ) -> Result<crate::DestructiveAuthorization> {
        self.require_current_provider_scope(plan)?;
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
        self.require_current_provider_scope(plan)?;
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
        self.apply_provider_install_in_mode(plan, token, ProviderInstallMode::Reviewed)
    }

    pub(crate) fn apply_automatic_provider_install(
        &self,
        plan: &ProviderInstallPlan,
        token: &str,
    ) -> Result<ProfileRevision> {
        self.apply_provider_install_in_mode(plan, token, ProviderInstallMode::Automatic)
    }

    fn apply_provider_install_in_mode(
        &self,
        plan: &ProviderInstallPlan,
        token: &str,
        mode: ProviderInstallMode<'_>,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(&plan.port_id)?;
        // A plan is caller-supplied data: re-establish what planning established.
        if plan.members.is_empty()
            || plan.members.len() > MAX_MEMBERS
            || plan.wrappers.len() > MAX_MEMBERS
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
        self.require_current_provider_scope(plan)?;
        self.recover_switch_locked(&plan.port_id, &layout)?;
        if mode == ProviderInstallMode::Automatic {
            let setup = profile::profile_from(
                &self.library.connection()?,
                &plan.port_id,
                &plan.profile_id,
            )?;
            if setup.intent.update_policy != ProfileUpdatePolicy::AutomaticEligible
                || setup.current_revision != plan.expected_revision
            {
                return Err(PortcoveError::conflict(
                    "the setup or its automatic update policy changed; check again",
                ));
            }
        }
        if digest(plan)? != plan.plan_sha256 {
            return Err(PortcoveError::verification(
                "the plan does not match its recorded digest",
            ));
        }
        if mode == ProviderInstallMode::Automatic && plan.wrappers.len() > 1 {
            return Err(PortcoveError::usage(
                "a Thunderstore dependency set needs explicit permission",
            ));
        }
        if plan.wrappers.len() > 1 {
            let current = profile::current_revision(
                &self.library.connection()?,
                &plan.port_id,
                &plan.profile_id,
            )?;
            if current.revision != plan.expected_revision {
                return Err(PortcoveError::conflict(
                    "the setup changed after the dependency review; plan again",
                ));
            }
        }
        let retained = if mode == ProviderInstallMode::Automatic
            && plan.provider.provider == crate::thunderstore::PROVIDER
        {
            let current = profile::current_revision(
                &self.library.connection()?,
                &plan.port_id,
                &plan.profile_id,
            )?;
            retained_dependencies(
                &layout,
                &current,
                &plan.provider.project,
                &plan.file,
                plan.provider.binding.as_ref(),
                None,
            )?
        } else {
            Vec::new()
        };
        let wrapper_members = wrapper_members(plan, &retained)?;
        let runs_code = plan
            .members
            .iter()
            .any(|member| !member.runs_code.is_empty());
        if mode == ProviderInstallMode::Automatic && runs_code {
            return Err(PortcoveError::usage(
                "automatic updates do not grant permission to run mod code",
            ));
        }
        let consume = || {
            self.library.consume_authorization(
                token,
                if runs_code { ACTION_WITH_CODE } else { ACTION },
                &target(plan)?,
                &plan.plan_sha256,
            )
        };
        let recomp = layout.recomp_game().is_some();
        if !recomp {
            consume()?;
        }
        let staged_dir = mode.staging(&layout, &plan.plan_sha256);
        let staged = inspect_reviewed_members(plan, &layout, &staged_dir, &wrapper_members)?;
        if recomp {
            let connection = self.library.connection()?;
            let current = profile::current_revision(&connection, &plan.port_id, &plan.profile_id)?;
            require_reviewed_or_reordered(&connection, &current, plan.expected_revision)?;
            self.review_recomp_changes(
                &layout,
                &current,
                staged.iter().filter_map(|item| item.recomp.as_ref()),
                None,
            )?;
            consume()?;
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

    /// Commit one reviewed draft through the same deployment and recovery path
    /// as a single provider install. No per-package revision is published.
    pub fn apply_mod_setup_draft(
        &self,
        port_id: &str,
        profile_id: &str,
        expected_revision: u64,
        plans: &[ProviderInstallPlan],
        edits: &crate::ModSetupEdits,
        allow_code: bool,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(port_id)?;
        let _guard = self
            .library
            .try_lock_port(port_id, "apply-mod-setup-draft")?;
        self.recover_switch_locked(port_id, &layout)?;
        let current = profile::current_revision(&self.library.connection()?, port_id, profile_id)?;
        if current.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "the setup changed; review the changes again",
            ));
        }
        let prepared =
            self.prepare_mod_setup_draft(&layout, &current, plans, edits, Some(allow_code))?;
        let revision = self.apply_mod_setup_draft_locked(
            port_id,
            profile_id,
            expected_revision,
            prepared.packages,
            Some(edits),
        )?;
        for directory in prepared.provider_directories {
            let _ = fs::remove_dir_all(directory);
        }
        Ok(revision)
    }

    /// Shows precedence and asset overlaps for the exact proposed setup.
    pub fn preview_mod_setup_draft(
        &self,
        port_id: &str,
        profile_id: &str,
        expected_revision: u64,
        plans: &[ProviderInstallPlan],
        edits: &crate::ModSetupEdits,
    ) -> Result<ModSetupDraftPreview> {
        let layout = self.deploy_layout(port_id)?;
        let _guard = self
            .library
            .try_read_lock_port(port_id, "preview-mod-setup-draft")?;
        let current = profile::current_revision(&self.library.connection()?, port_id, profile_id)?;
        if current.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "the setup changed; review the changes again",
            ));
        }
        let prepared = self.prepare_mod_setup_draft(&layout, &current, plans, edits, None)?;
        let next = crate::profile_deploy::proposed_mod_setup(
            &layout,
            &current,
            &prepared.packages,
            Some(edits),
        )?;
        self.review_recomp_changes(
            &layout,
            &next,
            prepared
                .packages
                .iter()
                .filter(|staged| {
                    next.packages.iter().any(|item| {
                        item.enabled
                            && item.native_id == staged.inspection.file_name
                            && item.sha256 == staged.inspection.sha256
                    })
                })
                .filter_map(|staged| staged.recomp.as_ref()),
            None,
        )?;
        let ordered = crate::profile_deploy::enabled_in_override_order(&next);
        let order = ordered.iter().map(|item| item.native_id.clone()).collect();
        let mut owned_paths = Vec::new();
        let mut truncated = false;
        if layout.recomp_game().is_none() {
            let mut remaining = 100_000usize;
            for item in ordered {
                let paths = if let Some(staged) = prepared.packages.iter().find(|staged| {
                    staged.inspection.sha256 == item.sha256
                        && staged.inspection.file_name == item.native_id
                }) {
                    staged.inspection.asset_paths.clone()
                } else {
                    let stored = layout.package(&item.sha256, &item.native_id);
                    let inspected = inspect_asset_archive(&stored)?;
                    if inspected.sha256 != item.sha256 {
                        return Err(PortcoveError::verification(
                            "a stored mod changed; review the setup again",
                        )
                        .detail("package", &item.native_id));
                    }
                    inspected.asset_paths
                };
                if paths.len() > remaining {
                    truncated = true;
                    break;
                }
                remaining -= paths.len();
                owned_paths.push((item.native_id.as_str(), paths));
            }
        }
        let assets = owned_paths
            .iter()
            .map(|(id, paths)| (*id, paths.as_slice()))
            .collect::<Vec<_>>();
        let mut conflicts = asset_conflicts(&assets);
        // An omitted mod may win an overlap. A partial inspection cannot report winners.
        if truncated {
            conflicts.clear();
        } else if conflicts.len() > MAX_REPORTED_CONFLICTS {
            truncated = true;
            conflicts.truncate(MAX_REPORTED_CONFLICTS);
        }
        let recorded_code = crate::profile_deploy::consented_code(&layout).unwrap_or_default();
        let local_code_packages = prepared
            .packages
            .iter()
            .filter(|package| {
                package.provider.is_none()
                    && package.code_consent
                    && !recorded_code.contains(&package.inspection.sha256)
            })
            .map(|package| package.inspection.file_name.clone())
            .collect();
        Ok(ModSetupDraftPreview {
            order,
            local_code_packages,
            conflicts,
            conflicts_truncated: truncated,
        })
    }

    fn prepare_mod_setup_draft(
        &self,
        layout: &Layout,
        current: &ProfileRevision,
        plans: &[ProviderInstallPlan],
        edits: &crate::ModSetupEdits,
        allow_code: Option<bool>,
    ) -> Result<PreparedModSetupDraft> {
        if plans.len() + edits.local_files.len() > 16 || edits.packages.len() > 1024 {
            return Err(PortcoveError::usage("the setup draft is too large"));
        }
        if plans.is_empty()
            && edits.packages.is_empty()
            && edits.order.is_none()
            && edits.local_files.is_empty()
        {
            return Err(PortcoveError::usage("the setup draft has no changes"));
        }
        let port_id = &current.build.port_id;
        let profile_id = &current.profile_id;
        let expected_revision = current.revision;
        let mut staged = BTreeMap::<String, crate::profile_deploy::StagedPackage>::new();
        let mut directories = Vec::new();
        for plan in plans {
            if &plan.port_id != port_id
                || &plan.profile_id != profile_id
                || plan.expected_revision != expected_revision
                || plan.members.is_empty()
                || plan.members.len() > MAX_MEMBERS
                || plan.wrappers.len() > MAX_MEMBERS
                || plan
                    .members
                    .iter()
                    .any(|member| !profile::valid_native_id(&member.file_name))
                || digest(plan)? != plan.plan_sha256
            {
                return Err(PortcoveError::conflict(
                    "a file review belongs to another setup revision or has changed",
                ));
            }
            self.require_current_provider_scope(plan)?;
            let runs_code = plan
                .members
                .iter()
                .any(|member| !member.runs_code.is_empty());
            let directory = ProviderInstallMode::Reviewed.staging(layout, &plan.plan_sha256);
            let wrappers = wrapper_members(plan, &[])?;
            let members = inspect_reviewed_members(plan, layout, &directory, &wrappers)?;
            for member in members {
                let id = &member.inspection.file_name;
                if let Some(previous) = staged.get(id) {
                    if previous.inspection.sha256 != member.inspection.sha256
                        || previous.provider != member.provider
                        || previous.provider_requires != member.provider_requires
                    {
                        return Err(PortcoveError::conflict(
                            "two queued files supply different copies of the same mod",
                        )
                        .detail("package", id));
                    }
                } else {
                    staged.insert(id.clone(), member);
                }
            }
            if let Some(allow_code) = allow_code {
                let authorization = if runs_code && allow_code {
                    self.authorize_provider_install_allowing_code(plan)?
                } else {
                    self.authorize_provider_install(plan)?
                };
                self.library.consume_authorization(
                    &authorization.token,
                    if runs_code { ACTION_WITH_CODE } else { ACTION },
                    &target(plan)?,
                    &plan.plan_sha256,
                )?;
            }
            directories.push(directory);
        }
        let mut local_staging = Vec::new();
        for file in &edits.local_files {
            let (directory, item) =
                self.inspect_local_draft_file(layout, current, file, allow_code.unwrap_or(true))?;
            let native_id = item.inspection.file_name.clone();
            if staged.insert(native_id.clone(), item).is_some() {
                return Err(
                    PortcoveError::conflict("two files in the draft supply the same mod")
                        .detail("package", native_id),
                );
            }
            local_staging.push(directory);
        }
        Ok(PreparedModSetupDraft {
            packages: staged.into_values().collect(),
            provider_directories: directories,
            _local_directories: local_staging,
        })
    }

    /// Discards a reviewed plan's private staging.
    pub fn discard_provider_install(&self, plan: &ProviderInstallPlan) -> Result<()> {
        let _guard = self
            .library
            .try_lock_port(&plan.port_id, "discard-provider-install")?;
        self.discard_provider_install_in_mode(plan, ProviderInstallMode::Reviewed)
    }

    pub(crate) fn discard_provider_install_in_mode(
        &self,
        plan: &ProviderInstallPlan,
        mode: ProviderInstallMode<'_>,
    ) -> Result<()> {
        // The plan is caller-supplied: its digest names a directory only when it
        // is the digest of the plan itself.
        if digest(plan)? != plan.plan_sha256 {
            return Err(PortcoveError::conflict(
                "this plan was changed after review; nothing was discarded",
            ));
        }
        let layout = self.deploy_layout(&plan.port_id)?;
        let staged = mode.staging(&layout, &plan.plan_sha256);
        if staged.exists() {
            fs::remove_dir_all(staged)?;
        }
        Ok(())
    }
}

fn inspect_reviewed_members(
    plan: &ProviderInstallPlan,
    layout: &Layout,
    staged_dir: &Path,
    wrapper_members: &std::collections::BTreeMap<&str, ReviewedMember<'_>>,
) -> Result<Vec<crate::profile_deploy::StagedPackage>> {
    let recorded = crate::profile_deploy::consented_code(layout).unwrap_or_default();
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
        let origin = wrapper_members.get(member.file_name.as_str());
        let mut item = inspect_for_port(
            layout,
            path,
            Some(
                origin
                    .map_or(&plan.provider, |member| member.provider)
                    .clone(),
            ),
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
        if let Some(origin) = origin {
            item.provider_requires.clone_from(&origin.requirements);
        }
        staged.push(item);
    }
    Ok(staged)
}

#[cfg(test)]
#[path = "provider_install_tests.rs"]
mod tests;
