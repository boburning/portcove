//! Bounded, shareable profile recipes.
//!
//! A recipe describes what a profile *is*: runtime identity, original-input
//! references, package identities, dependency closure, enabled state, typed
//! orderings and the loader contract. It never carries original game payloads,
//! credentials, private machine paths, saves or settings. A recipe is untrusted
//! data: it grants no URL, path, script, acquisition or execution authority.
//! Inspection is local and needs no provider account. Applying one goes through
//! ordinary Core state: the exact runtime must already be installed, every original
//! registered and every package's bytes in the store; otherwise the plan holds and
//! nothing changes. An identity round trip does not establish gameplay or save
//! compatibility.
use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ArtifactIdentity, DefinitionSelectionIdentity, LoaderContractRef, Platform, PortcoveError,
    PortcoveService, Profile, ProviderPackageRef, Result, RuntimeIdentity, TypedOrdering,
    profile::{self, valid_native_id},
    profile_deploy::sha256_file,
};

pub const RECIPE_FORMAT: u32 = 1;
const MAX_RECIPE_BYTES: usize = 256 * 1024;
const MAX_PACKAGES: usize = 512;
const MAX_TEXT: usize = 256;
const ACTION: &str = "import_profile_recipe";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecipeRuntime {
    pub artifact: ArtifactIdentity,
    pub runtime: Option<RuntimeIdentity>,
    pub definition: Option<DefinitionSelectionIdentity>,
    pub installed_contract_sha256: String,
    pub platform: Platform,
}

/// A reference to an original, by content identity only. No path, no payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecipeOriginal {
    pub requirement_id: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecipePackage {
    pub native_id: String,
    pub native_version: Option<String>,
    pub provider: Option<ProviderPackageRef>,
    pub sha256: String,
    pub size: u64,
    pub enabled: bool,
    pub requires: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileRecipe {
    pub format: u32,
    pub port_id: String,
    pub runtime: RecipeRuntime,
    pub loader: Option<LoaderContractRef>,
    pub originals: Vec<RecipeOriginal>,
    pub packages: Vec<RecipePackage>,
    pub orderings: Vec<TypedOrdering>,
    /// Inputs this recipe cannot reproduce; always stated, never implied.
    pub uncaptured: Vec<String>,
    /// SHA-256 of the recipe's canonical content with this field empty.
    pub identity_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecipeInputStatus {
    /// Present locally with the exact identity the recipe names.
    Available,
    /// Not present; ordinary acquisition could supply it.
    Acquirable,
    /// Present but different, or absent with no way to acquire it from the recipe.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecipeInputPlan {
    pub name: String,
    pub status: RecipeInputStatus,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecipeImportPlan {
    pub recipe: ProfileRecipe,
    pub runtime: RecipeInputPlan,
    /// The exact installation the new profile would bind, when one matches.
    pub install_id: Option<String>,
    pub originals: Vec<RecipeInputPlan>,
    pub packages: Vec<RecipeInputPlan>,
    /// Why applying is not possible yet; empty when every input is present.
    pub holds: Vec<String>,
    pub can_apply: bool,
    pub plan_sha256: String,
}

fn invalid(message: &str) -> PortcoveError {
    PortcoveError::verification(format!("profile recipe is not valid: {message}"))
}

fn text_ok(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_TEXT && !value.chars().any(char::is_control)
}

fn hash_ok(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Absent optional fields and explicit nulls mean the same thing.
fn without_nulls(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(object) => serde_json::Value::Object(
            object
                .into_iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| (key, without_nulls(value)))
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(without_nulls).collect())
        }
        other => other,
    }
}

fn identity(recipe: &ProfileRecipe) -> Result<String> {
    let mut copy = recipe.clone();
    copy.identity_sha256.clear();
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&copy)?)))
}

impl ProfileRecipe {
    /// Like [`ProfileRecipe::inspect`], also accepting the CLI's JSON output
    /// envelope (the recipe under `data`). The whole document is parsed with
    /// duplicate-key refusal first, so the envelope cannot hide a second value.
    pub fn inspect_document(bytes: &[u8]) -> Result<ProfileRecipe> {
        if bytes.len() > MAX_RECIPE_BYTES {
            return Err(invalid("it exceeds 256 KiB"));
        }
        let crate::definition_entry::strict_json::UniqueValue(value) =
            serde_json::from_slice(bytes)
                .map_err(|error| invalid(&format!("it is not JSON with unique keys ({error})")))?;
        match value.get("data") {
            Some(inner) if value.get("format").is_none() => {
                Self::inspect(serde_json::to_string(inner)?.as_bytes())
            }
            _ => Self::inspect(bytes),
        }
    }

    /// Parses and validates untrusted recipe bytes. Pure and local.
    pub fn inspect(bytes: &[u8]) -> Result<ProfileRecipe> {
        if bytes.len() > MAX_RECIPE_BYTES {
            return Err(invalid("it exceeds 256 KiB"));
        }
        // Duplicate keys are refused, so no reader can see a different value.
        let crate::definition_entry::strict_json::UniqueValue(value) =
            serde_json::from_slice(bytes)
                .map_err(|error| invalid(&format!("it is not JSON with unique keys ({error})")))?;
        match value.get("format").and_then(serde_json::Value::as_u64) {
            Some(1) => {}
            Some(_) => {
                return Err(PortcoveError::unsupported(
                    "this recipe uses a format this Portcove does not understand",
                ));
            }
            None => return Err(invalid("it has no format version")),
        }
        let recipe: ProfileRecipe = serde_json::from_value(value.clone())
            .map_err(|error| invalid(&format!("it has unexpected content ({error})")))?;
        // Nested identity types are shared with other surfaces and ignore fields
        // they do not know. Require that nothing was dropped at any depth, so a
        // recipe cannot carry content that inspection would not show.
        if without_nulls(serde_json::to_value(&recipe)?) != without_nulls(value) {
            return Err(invalid("it has fields this format does not define"));
        }
        recipe.validate()?;
        Ok(recipe)
    }

    fn validate(&self) -> Result<()> {
        if self.format != RECIPE_FORMAT {
            return Err(PortcoveError::unsupported(
                "this recipe uses a format this Portcove does not understand",
            ));
        }
        if !text_ok(&self.runtime.artifact.asset_name)
            || self
                .loader
                .as_ref()
                .is_some_and(|loader| !text_ok(&loader.id) || !text_ok(&loader.version))
            || self
                .orderings
                .iter()
                .any(|ordering| !text_ok(&ordering.domain))
        {
            return Err(invalid(
                "an identity field is empty, oversized or malformed",
            ));
        }
        if self.packages.len() > MAX_PACKAGES
            || self.originals.len() > MAX_PACKAGES
            || self.orderings.len() > MAX_PACKAGES
            || self.uncaptured.len() > MAX_PACKAGES
            || !text_ok(&self.port_id)
            || self.uncaptured.iter().any(|line| !text_ok(line))
            || !hash_ok(&self.runtime.artifact.sha256)
            || !hash_ok(&self.runtime.installed_contract_sha256)
        {
            return Err(invalid("a field is missing, oversized or malformed"));
        }
        let mut ids = BTreeSet::new();
        // Names that differ only by case alias one file on Windows and macOS.
        let mut folded = BTreeSet::new();
        for package in &self.packages {
            if !valid_native_id(&package.native_id)
                || !hash_ok(&package.sha256)
                || !ids.insert(package.native_id.as_str())
                || !folded.insert(package.native_id.to_ascii_lowercase())
                || package.requires.iter().any(|id| !valid_native_id(id))
                || package
                    .native_version
                    .as_deref()
                    .is_some_and(|v| !text_ok(v))
                || package.provider.as_ref().is_some_and(|p| {
                    !text_ok(&p.provider)
                        || !text_ok(&p.project)
                        || p.file.as_deref().is_some_and(|f| !text_ok(f))
                        || p.version.as_deref().is_some_and(|v| !text_ok(v))
                })
            {
                return Err(invalid(
                    "packages need distinct plain native IDs and exact SHA-256 digests",
                ));
            }
        }
        let mut requirements = BTreeSet::new();
        for original in &self.originals {
            if !text_ok(&original.requirement_id)
                || !hash_ok(&original.sha256)
                || !requirements.insert(original.requirement_id.as_str())
            {
                return Err(invalid("originals need distinct requirements and digests"));
            }
        }
        let mut domains = BTreeSet::new();
        for ordering in &self.orderings {
            let members = ordering.native_ids.iter().collect::<BTreeSet<_>>();
            if !text_ok(&ordering.domain)
                || !domains.insert(ordering.domain.as_str())
                || members.len() != ordering.native_ids.len()
                || ordering
                    .native_ids
                    .iter()
                    .any(|id| !ids.contains(id.as_str()))
            {
                return Err(invalid(
                    "each ordering domain must be unique and name only listed packages",
                ));
            }
        }
        // Dependency closure: enabled packages need their requirements present
        // and enabled, and requirements must not form a cycle.
        let enabled = self
            .packages
            .iter()
            .filter(|package| package.enabled)
            .map(|package| (package.native_id.as_str(), package))
            .collect::<BTreeMap<_, _>>();
        for package in enabled.values() {
            if let Some(missing) = package
                .requires
                .iter()
                .find(|id| !enabled.contains_key(id.as_str()))
            {
                return Err(PortcoveError::conflict(
                    "an enabled package requires one the recipe does not enable",
                )
                .detail("package", &package.native_id)
                .detail("requires", missing));
            }
        }
        let mut done = BTreeSet::new();
        for start in enabled.keys() {
            let mut stack = vec![(*start, 0usize)];
            let mut path = BTreeSet::new();
            while let Some((node, index)) = stack.pop() {
                if index == 0 {
                    if done.contains(node) {
                        continue;
                    }
                    if !path.insert(node) {
                        return Err(PortcoveError::conflict(
                            "the recipe's package dependencies form a cycle",
                        )
                        .detail("package", node));
                    }
                }
                let requires = &enabled[node].requires;
                if let Some(next) = requires.get(index) {
                    stack.push((node, index + 1));
                    if path.contains(next.as_str()) {
                        return Err(PortcoveError::conflict(
                            "the recipe's package dependencies form a cycle",
                        )
                        .detail("package", next));
                    }
                    stack.push((next.as_str(), 0));
                } else {
                    path.remove(node);
                    done.insert(node);
                }
            }
        }
        if identity(self)? != self.identity_sha256 {
            return Err(invalid("its identity digest does not match its content"));
        }
        Ok(())
    }
}

fn default_uncaptured() -> Vec<String> {
    [
        "original game files are never included; originals are referenced by content identity only",
        "player saves and progress are not included",
        "settings are not exported",
        "packages without provider identity cannot be fetched from this recipe",
        "this describes identity, not gameplay or save compatibility",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

impl PortcoveService {
    /// Exports a profile revision as a recipe (the current revision by default).
    pub fn export_profile_recipe(
        &self,
        port_id: &str,
        profile_id: &str,
        revision: Option<u64>,
    ) -> Result<ProfileRecipe> {
        let connection = self.library.connection()?;
        let revision = match revision {
            Some(number) => profile::revision_by_number(&connection, profile_id, number)?,
            None => profile::current_revision(&connection, port_id, profile_id)?,
        };
        if revision.build.port_id != port_id {
            return Err(PortcoveError::not_found(
                "profile is not registered for this port",
            ));
        }
        let mut recipe = ProfileRecipe {
            format: RECIPE_FORMAT,
            port_id: port_id.into(),
            runtime: RecipeRuntime {
                artifact: revision.build.artifact.clone(),
                runtime: revision.build.runtime.clone(),
                definition: revision.build.definition.clone(),
                installed_contract_sha256: revision.build.installed_contract_sha256.clone(),
                platform: revision.build.platform,
            },
            loader: revision.loader.clone(),
            originals: revision
                .originals
                .iter()
                .map(|original| RecipeOriginal {
                    requirement_id: original.requirement_id.clone(),
                    sha256: original.sha256.clone(),
                    size: original.size,
                })
                .collect(),
            packages: revision
                .packages
                .iter()
                .map(|package| RecipePackage {
                    native_id: package.native_id.clone(),
                    native_version: package.native_version.clone(),
                    provider: package.provider.clone(),
                    sha256: package.sha256.clone(),
                    size: package.size,
                    enabled: package.enabled,
                    requires: package.requires.clone(),
                })
                .collect(),
            orderings: revision.orderings.clone(),
            uncaptured: default_uncaptured(),
            identity_sha256: String::new(),
        };
        recipe.identity_sha256 = identity(&recipe)?;
        // Recipes are stricter than local revisions (for example, an enabled
        // package whose requirement is disabled). Say why the export stopped.
        recipe.validate().map_err(|error| {
            PortcoveError::conflict(
                "this profile cannot be shared as a recipe until the problem below is fixed in the profile",
            )
            .detail("reason", error.message)
        })?;
        Ok(recipe)
    }

    /// Plans an import without changing anything.
    pub fn plan_recipe_import(&self, recipe: &ProfileRecipe) -> Result<RecipeImportPlan> {
        recipe.validate()?;
        self.catalog().port(&recipe.port_id)?;
        let mut holds = Vec::new();
        if Platform::current()? != recipe.runtime.platform {
            holds.push("the recipe targets a different platform".to_owned());
        }
        let installs = self
            .library
            .all_installs()?
            .into_iter()
            .filter(|install| {
                install.port_id == recipe.port_id
                    && install.artifact.sha256 == recipe.runtime.artifact.sha256
                    && install.runtime == recipe.runtime.runtime
            })
            .collect::<Vec<_>>();
        let mut install_id = None;
        let runtime = {
            let mut exact = None;
            for install in &installs {
                if let Ok(build) = self.verified_retained_build(&recipe.port_id, &install.id)
                    && build.artifact == recipe.runtime.artifact
                    && build.definition == recipe.runtime.definition
                    && build.installed_contract_sha256 == recipe.runtime.installed_contract_sha256
                    && build.platform == recipe.runtime.platform
                {
                    exact = Some(install.id.clone());
                    break;
                }
            }
            match exact {
                Some(id) => {
                    install_id = Some(id);
                    RecipeInputPlan {
                        name: "runtime".into(),
                        status: RecipeInputStatus::Available,
                        detail: "the exact runtime build is installed".into(),
                    }
                }
                None => {
                    holds.push("the exact runtime build is not installed".to_owned());
                    RecipeInputPlan {
                        name: "runtime".into(),
                        status: RecipeInputStatus::Acquirable,
                        detail: "install the runtime through the ordinary setup path".into(),
                    }
                }
            }
        };
        let sources = self.library.sources()?;
        let port = self.catalog().port(&recipe.port_id)?;
        let requirements = [
            port.source_profile.as_deref(),
            port.bios_source_profile.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        let originals = recipe
            .originals
            .iter()
            .map(|original| {
                if !requirements.contains(&original.requirement_id.as_str()) {
                    holds.push(format!(
                        "original {} is not an input this game uses",
                        original.requirement_id
                    ));
                    return RecipeInputPlan {
                        name: original.requirement_id.clone(),
                        status: RecipeInputStatus::Unavailable,
                        detail: "this game does not use this original".into(),
                    };
                }
                let registered = sources
                    .iter()
                    .filter(|source| source.profile_id == original.requirement_id)
                    .collect::<Vec<_>>();
                let (status, detail) = if registered
                    .iter()
                    .any(|source| source.sha256 == original.sha256 && source.size == original.size)
                {
                    (
                        RecipeInputStatus::Available,
                        "a registered original matches",
                    )
                } else if registered.is_empty() {
                    holds.push(format!(
                        "original {} is not registered",
                        original.requirement_id
                    ));
                    (
                        RecipeInputStatus::Unavailable,
                        "no original is registered for this requirement",
                    )
                } else {
                    holds.push(format!("original {} differs", original.requirement_id));
                    (
                        RecipeInputStatus::Unavailable,
                        "a different original is registered",
                    )
                };
                RecipeInputPlan {
                    name: original.requirement_id.clone(),
                    status,
                    detail: detail.into(),
                }
            })
            .collect::<Vec<_>>();
        let user = self.library.user_dir(&recipe.port_id);
        let layout = crate::profile_deploy::Layout::for_user(&user);
        let connection = self.library.connection()?;
        let packages = recipe
            .packages
            .iter()
            .map(|package| {
                let stored = layout.package(&package.sha256, &package.native_id);
                let present = stored.try_exists().unwrap_or(false)
                    && sha256_file(&stored).is_ok_and(|sha| sha == package.sha256);
                let unrecorded_label = match &package.provider {
                    Some(provider) => !profile::provider_label_recorded(
                        &connection,
                        &recipe.port_id,
                        &package.sha256,
                        &package.native_id,
                        provider,
                    )?,
                    None => false,
                };
                let plannable = package
                    .provider
                    .as_ref()
                    .and_then(|provider| plannable_provider_file(&recipe.port_id, provider));
                let (status, detail) = if present && unrecorded_label {
                    (
                        RecipeInputStatus::Available,
                        "its exact bytes are in the package store; its provider label is not recorded in this library for these bytes, so the new profile does not keep it".to_owned(),
                    )
                } else if present {
                    (
                        RecipeInputStatus::Available,
                        "its exact bytes are in the package store".to_owned(),
                    )
                } else if let Some((project, file)) = plannable {
                    holds.push(format!(
                        "package {} must be acquired first",
                        package.native_id
                    ));
                    (
                        RecipeInputStatus::Acquirable,
                        format!(
                            "review GameBanana project {project}, file {file} with `profile provider-plan`; the new profile keeps the recipe's label only if this library records exactly that label for those bytes"
                        ),
                    )
                } else if package.provider.is_some() {
                    holds.push(format!(
                        "package {} names a source Portcove cannot plan",
                        package.native_id
                    ));
                    (
                        RecipeInputStatus::Unavailable,
                        "its bytes are not in the store, and its source is not a GameBanana file this game has a reviewed binding for".to_owned(),
                    )
                } else {
                    holds.push(format!(
                        "package {} has no source in this recipe",
                        package.native_id
                    ));
                    (
                        RecipeInputStatus::Unavailable,
                        "a local package: its bytes are not in the store and cannot be fetched"
                            .to_owned(),
                    )
                };
                Ok(RecipeInputPlan {
                    name: package.native_id.clone(),
                    status,
                    detail,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        // The game must be able to load the enabled packages unambiguously, as for
        // any new revision.
        if crate::native_mod_list::loader_list(&recipe.port_id).is_some() {
            let enabled = recipe
                .packages
                .iter()
                .filter(|package| package.enabled)
                .map(|package| package.native_id.as_str())
                .collect::<Vec<_>>();
            if let Some(name) = enabled
                .iter()
                .find(|name| crate::native_mod_list::require_listable(name).is_err())
            {
                holds.push(format!(
                    "the game's mod list cannot name {name}; ask for a recipe without it"
                ));
            }
            if let Some((first, second)) = crate::native_mod_list::identity_collision(enabled) {
                holds.push(format!(
                    "{first} and {second} would load as the same mod; ask for a recipe with one of them turned off"
                ));
            }
        }
        let mut plan = RecipeImportPlan {
            recipe: recipe.clone(),
            runtime,
            install_id,
            originals,
            packages,
            can_apply: holds.is_empty(),
            holds,
            plan_sha256: String::new(),
        };
        let mut copy = plan.clone();
        copy.plan_sha256.clear();
        plan.plan_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&copy)?));
        Ok(plan)
    }

    pub fn authorize_recipe_import(
        &self,
        plan: &RecipeImportPlan,
        display_name: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        self.library
            .issue_authorization(ACTION, &target(plan, display_name)?, &plan.plan_sha256)
    }

    /// Creates a new profile from the recipe only when every input is already
    /// present. The plan is recomputed under the port lock; any difference refuses.
    pub fn apply_recipe_import(
        &self,
        plan: &RecipeImportPlan,
        display_name: &str,
        token: &str,
    ) -> Result<Profile> {
        let port_id = plan.recipe.port_id.clone();
        let _guard = self
            .library
            .try_lock_port(&port_id, "apply-recipe-import")?;
        let current = self.plan_recipe_import(&plan.recipe)?;
        if current.plan_sha256 != plan.plan_sha256 {
            return Err(PortcoveError::conflict(
                "the local inputs changed after review; plan the import again",
            ));
        }
        self.library.consume_authorization(
            token,
            ACTION,
            &target(plan, display_name)?,
            &plan.plan_sha256,
        )?;
        if !current.can_apply {
            return Err(PortcoveError::conflict(
                "the recipe cannot be applied until every input is present",
            )
            .detail("holds", current.holds.join("; ")));
        }
        let install_id = current
            .install_id
            .clone()
            .ok_or_else(|| PortcoveError::state("a ready plan has no matching installation"))?;
        let build = self.verified_retained_build(&port_id, &install_id)?;
        let sources = self.library.sources()?;
        let originals = plan
            .recipe
            .originals
            .iter()
            .filter_map(|original| {
                sources
                    .iter()
                    .find(|source| {
                        source.profile_id == original.requirement_id
                            && source.sha256 == original.sha256
                            && source.size == original.size
                    })
                    .map(|source| profile::bind_original(&original.requirement_id, source))
            })
            .collect::<Vec<_>>();
        // A recipe's provider label is an unverified claim. The new profile keeps it
        // only when this port already recorded exactly that label for the same
        // bytes and file name, so update checks never follow a label the recipe
        // supplied. The reviewed plan says which labels are dropped.
        let connection = self.library.connection()?;
        let mut providers = Vec::with_capacity(plan.recipe.packages.len());
        for package in &plan.recipe.packages {
            let kept = match &package.provider {
                Some(provider)
                    if profile::provider_label_recorded(
                        &connection,
                        &port_id,
                        &package.sha256,
                        &package.native_id,
                        provider,
                    )? =>
                {
                    Some(provider.clone())
                }
                _ => None,
            };
            providers.push(kept);
        }
        let packages = plan
            .recipe
            .packages
            .iter()
            .zip(providers)
            .map(|(package, provider)| crate::ResolvedPackage {
                native_id: package.native_id.clone(),
                native_version: package.native_version.clone(),
                provider,
                sha256: package.sha256.clone(),
                size: package.size,
                enabled: package.enabled,
                requires: package.requires.clone(),
            })
            .collect::<Vec<_>>();
        let base = crate::ProfileRevision {
            profile_id: String::new(),
            revision: 0,
            parent_revision: None,
            build: build.clone(),
            originals: originals.clone(),
            loader: plan.recipe.loader.clone(),
            packages,
            orderings: plan.recipe.orderings.clone(),
            settings: BTreeMap::new(),
            save_group: String::new(),
            limits: Vec::new(),
            created_at: 0,
            digest: String::new(),
        };
        let connection = self.library.connection()?;
        if profile::profile_count(&connection, &port_id)? >= profile::MAX_PROFILES {
            return Err(PortcoveError::state(
                "this port has the maximum number of profiles",
            ));
        }
        let profile = profile::new_profile(&port_id, display_name, false);
        self.publish_new_profile(
            &profile,
            &install_id,
            build,
            originals,
            Some(&base),
            base.loader.clone(),
        )
    }
}

/// The GameBanana project and file a recipe package names, when this game has a
/// reviewed binding and the reference is complete enough for `provider-plan`.
fn plannable_provider_file(port_id: &str, provider: &ProviderPackageRef) -> Option<(u64, u64)> {
    crate::provider_install::gamebanana_game(port_id)?;
    if provider.provider != crate::gamebanana::PROVIDER {
        return None;
    }
    let project = provider.project.parse::<u64>().ok()?;
    let file = provider.file.as_deref()?.parse::<u64>().ok()?;
    Some((project, file))
}

fn target(plan: &RecipeImportPlan, display_name: &str) -> Result<String> {
    Ok(serde_json::to_string(&(
        &plan.recipe.port_id,
        &plan.recipe.identity_sha256,
        display_name,
    ))?)
}

#[cfg(test)]
#[path = "recipe_tests.rs"]
mod tests;
