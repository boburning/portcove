//! Bounded, shareable profile recipes.
//!
//! A recipe describes what a profile *is*: runtime identity, original-input
//! references, package identities, dependency closure, enabled state, typed
//! orderings and the loader contract. It never carries original game payloads,
//! credentials, private machine paths, saves or arbitrary settings. A recipe is untrusted
//! data: it grants no URL, path, script, acquisition or execution authority.
//! Inspection is local and needs no provider account. Applying one goes through
//! ordinary Core state: the exact runtime must be installed, every required
//! original registered and each package present locally or in reviewed private
//! staging. An identity round trip does not establish gameplay or save compatibility.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ArtifactIdentity, DefinitionSelectionIdentity, Library, LoaderContractRef, OriginalBinding,
    Platform, PortcoveError, PortcoveService, Profile, ProviderPackageRef, Result, RuntimeIdentity,
    TypedOrdering,
    profile::{self, valid_native_id},
    recomp_mod_settings::{self, RecipeModSetting},
};

#[path = "recipe_originals.rs"]
mod original_inputs;

pub const RECIPE_FORMAT: u32 = 3;
const RECIPE_FORMAT_WITH_PROVIDER_BINDINGS: u32 = 4;
const LEGACY_RECIPE_FORMAT: u32 = 1;
const RECIPE_FORMAT_WITH_MOD_STATE: u32 = 2;
const MAX_RECIPE_SETTINGS: usize = crate::profile::MAX_SETTINGS;
const MAX_RECIPE_BYTES: usize = crate::setup_capacity::MAX_RECIPE_DOCUMENT_BYTES;
const MAX_PACKAGES: usize = crate::setup_capacity::MAX_SETUP_PACKAGES;
/// The same text bound as a revision, so every exported revision is importable.
const MAX_TEXT: usize = profile::MAX_TEXT;
const ACTION: &str = "import_profile_recipe";
const ACTION_WITH_CODE: &str = "apply_mod_recipe_with_code";
/// Provider downloads one acquisition call stages before it returns, so
/// progress reaches the player and a stop is honored between calls. The calls
/// continue until every package is staged; this is not a recipe size bound.
pub const RECIPE_ACQUISITION_STEP: usize = 8;
const ACQUISITION_RECORDS: &str = "acquisitions";
/// Inside the records: one file per staged provider plan, by digest, and one
/// small reference per package naming the plan that holds it.
const PLAN_RECORDS: &str = "plans";
const MEMBER_RECORDS: &str = "members";
/// Every distinct provider plan a recipe review holds, serialized. A review is
/// kept whole in memory and crosses IPC once, so this is its working-set
/// budget; a review past it is refused with this reason before it grows.
pub const MAX_RECIPE_REVIEW_BYTES: usize = 2 * crate::setup_capacity::MAX_RECIPE_DOCUMENT_BYTES;
/// Room a revision needs beyond its recipe-derived content.
const MAX_IMPORTED_SETUP_BYTES: usize = crate::setup_capacity::MAX_SETUP_DOCUMENT_BYTES - 64 * 1024;
/// One recorded step: a provider plan, whose wrapper closure is bounded by the
/// setup capacity.
const MAX_ACQUISITION_RECORD_BYTES: usize = crate::setup_capacity::MAX_SETUP_DOCUMENT_BYTES;

fn record_name(native_id: &str) -> String {
    format!("{}.json", hex::encode(Sha256::digest(native_id.as_bytes())))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecipeRuntime {
    pub artifact: ArtifactIdentity,
    pub runtime: Option<RuntimeIdentity>,
    pub definition: Option<DefinitionSelectionIdentity>,
    pub installed_contract_sha256: String,
    pub platform: Platform,
}

/// Local original identity, without its path or payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecipeOriginal {
    pub requirement_id: String,
    pub sha256: String,
    pub size: u64,
    /// Earlier recipes identified content only. Format 3 also binds its saved representation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage: Option<RecipeOriginalStorage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecipeOriginalStorage {
    pub sha256: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_identity_sha256: Option<String>,
}

impl From<&OriginalBinding> for RecipeOriginal {
    fn from(binding: &OriginalBinding) -> Self {
        Self {
            requirement_id: binding.requirement_id.clone(),
            sha256: binding.sha256.clone(),
            size: binding.size,
            storage: Some(RecipeOriginalStorage {
                sha256: binding.storage_sha256.clone(),
                size: binding.storage_size,
                observed_identity_sha256: binding.observed_identity_sha256.clone(),
            }),
        }
    }
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_requires: Vec<crate::ProviderRequirement>,
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
    /// Portable, exact-package settings. Omitted by format 1.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<RecipeModSetting>,
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

/// Private provider staging bound to one exact recipe and expected package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecipeAcquisitionPlan {
    pub recipe_identity_sha256: String,
    pub native_id: String,
    pub provider_plan: crate::ProviderInstallPlan,
}

/// One staged recipe package and the provider plan (by digest) that holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecipeAcquisitionRef {
    pub native_id: String,
    pub plan_sha256: String,
}

/// The provider files a recipe review has staged. Each provider plan is held
/// once, however many of its members the recipe uses, so a shared closure
/// costs its plan once in the review, its records and IPC.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecipeStaging {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acquisitions: Vec<RecipeAcquisitionRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_plans: Vec<crate::ProviderInstallPlan>,
}

impl RecipeStaging {
    /// Collects single-package acquisitions (as the CLI exchanges them).
    pub fn from_acquisitions(
        recipe: &ProfileRecipe,
        acquisitions: &[RecipeAcquisitionPlan],
    ) -> Result<Self> {
        let mut staging = Self::default();
        for acquisition in acquisitions {
            if acquisition.recipe_identity_sha256 != recipe.identity_sha256 {
                return Err(PortcoveError::conflict(
                    "the provider review does not match this exact recipe",
                ));
            }
            staging.insert(&acquisition.native_id, acquisition.provider_plan.clone())?;
        }
        Ok(staging)
    }

    pub(crate) fn plan(&self, plan_sha256: &str) -> Option<&crate::ProviderInstallPlan> {
        self.provider_plans
            .iter()
            .find(|plan| plan.plan_sha256 == plan_sha256)
    }

    pub(crate) fn contains(&self, native_id: &str) -> bool {
        self.acquisitions
            .iter()
            .any(|item| item.native_id == native_id)
    }

    /// Adds one staged package; its plan is stored only if not already held.
    /// A different plan under an existing digest is refused.
    pub(crate) fn insert(
        &mut self,
        native_id: &str,
        plan: crate::ProviderInstallPlan,
    ) -> Result<()> {
        if self.contains(native_id) {
            return Err(PortcoveError::conflict(
                "the provider review does not match this exact recipe",
            ));
        }
        match self.plan(&plan.plan_sha256) {
            Some(held) if *held != plan => {
                return Err(PortcoveError::conflict(
                    "two provider reviews claim the same digest",
                ));
            }
            Some(_) => {}
            None => self.provider_plans.push(plan.clone()),
        }
        self.acquisitions.push(RecipeAcquisitionRef {
            native_id: native_id.to_owned(),
            plan_sha256: plan.plan_sha256,
        });
        Ok(())
    }

    /// Each staged package with the plan that holds it.
    fn steps(&self) -> Result<Vec<(&str, &crate::ProviderInstallPlan)>> {
        let plans = self
            .provider_plans
            .iter()
            .map(|plan| (plan.plan_sha256.as_str(), plan))
            .collect::<BTreeMap<_, _>>();
        if plans.len() != self.provider_plans.len() {
            return Err(PortcoveError::conflict(
                "the review holds a provider plan twice",
            ));
        }
        self.acquisitions
            .iter()
            .map(|item| {
                plans
                    .get(item.plan_sha256.as_str())
                    .map(|plan| (item.native_id.as_str(), *plan))
                    .ok_or_else(|| {
                        PortcoveError::conflict("a staged package names no provider review")
                    })
            })
            .collect()
    }

    fn encoded_bytes(&self) -> Result<usize> {
        self.provider_plans.iter().try_fold(0usize, |sum, plan| {
            Ok(sum.saturating_add(serde_json::to_vec(plan)?.len()))
        })
    }
}

fn require_review_budget(bytes: usize) -> Result<()> {
    if bytes > MAX_RECIPE_REVIEW_BYTES {
        return Err(PortcoveError::unsupported(format!(
            "this recipe review's provider files would exceed the {} review budget",
            crate::setup_capacity::mebibytes(MAX_RECIPE_REVIEW_BYTES)
        ))
        .detail("review_bytes", bytes.to_string()));
    }
    Ok(())
}

/// The package an acquisition batch stopped at, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecipeAcquisitionFailure {
    pub native_id: String,
    pub message: String,
}

impl RecipeAcquisitionFailure {
    fn new(native_id: &str, error: PortcoveError) -> Self {
        Self {
            native_id: native_id.to_owned(),
            message: error.message,
        }
    }
}

/// One bounded step of staging a recipe's missing packages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecipeAcquisitionBatch {
    /// The review including every step staged so far.
    pub plan: RecipeImportPlan,
    /// Packages this call staged, in order.
    pub acquired: Vec<String>,
    /// Set when the call stopped at a package it could not stage. Earlier
    /// steps stay staged and recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<RecipeAcquisitionFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecipeCodeApproval {
    pub native_id: String,
    pub sha256: String,
    pub runs: Vec<crate::RecompExecution>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecipeImportPlan {
    pub recipe: ProfileRecipe,
    pub runtime: RecipeInputPlan,
    /// The exact installation the new profile would bind, when one matches.
    pub install_id: Option<String>,
    pub originals: Vec<RecipeInputPlan>,
    /// Exact, path-free local resolutions consumed by the reviewed import.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verified_originals: Vec<OriginalBinding>,
    pub packages: Vec<RecipeInputPlan>,
    /// Provider files staged for this review, each plan held once.
    #[serde(flatten)]
    pub staging: RecipeStaging,
    /// Missing packages with an exact coordinate that the player can check.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_checks: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub code_approval: Vec<RecipeCodeApproval>,
    /// Why applying is not possible yet; empty when every input is present.
    pub holds: Vec<String>,
    pub can_apply: bool,
    pub plan_sha256: String,
}

fn invalid(message: &str) -> PortcoveError {
    PortcoveError::verification(format!("profile recipe is not valid: {message}"))
}

fn too_large() -> PortcoveError {
    invalid(&format!(
        "it exceeds {}",
        crate::setup_capacity::mebibytes(MAX_RECIPE_BYTES)
    ))
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
    /// Reads a regular recipe file without waiting on a special input stream.
    pub fn read_file(path: &Path) -> Result<Self> {
        if !std::fs::metadata(path)?.is_file() {
            return Err(invalid("choose a regular recipe file"));
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = options.open(path)?;
        if !file.metadata()?.is_file() {
            return Err(invalid("choose a regular recipe file"));
        }
        Self::read_document(file)
    }

    /// Reads a local recipe or CLI JSON envelope with the same bound as inspection.
    pub fn read_document(reader: impl Read) -> Result<Self> {
        let mut bytes = Vec::new();
        reader
            .take(MAX_RECIPE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        Self::inspect_document(&bytes)
    }

    /// Like [`ProfileRecipe::inspect`], also accepting the CLI's JSON output
    /// envelope (the recipe under `data`). The whole document is parsed with
    /// duplicate-key refusal first, so the envelope cannot hide a second value.
    pub fn inspect_document(bytes: &[u8]) -> Result<ProfileRecipe> {
        if bytes.len() > MAX_RECIPE_BYTES {
            return Err(too_large());
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
            return Err(too_large());
        }
        // Duplicate keys are refused, so no reader can see a different value.
        let crate::definition_entry::strict_json::UniqueValue(value) =
            serde_json::from_slice(bytes)
                .map_err(|error| invalid(&format!("it is not JSON with unique keys ({error})")))?;
        match value.get("format").and_then(serde_json::Value::as_u64) {
            Some(format)
                if format == u64::from(LEGACY_RECIPE_FORMAT)
                    || format == u64::from(RECIPE_FORMAT_WITH_MOD_STATE)
                    || format == u64::from(RECIPE_FORMAT)
                    || format == u64::from(RECIPE_FORMAT_WITH_PROVIDER_BINDINGS) => {}
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
        if !matches!(
            self.format,
            LEGACY_RECIPE_FORMAT
                | RECIPE_FORMAT_WITH_MOD_STATE
                | RECIPE_FORMAT
                | RECIPE_FORMAT_WITH_PROVIDER_BINDINGS
        ) {
            return Err(PortcoveError::unsupported(
                "this recipe uses a format this Portcove does not understand",
            ));
        }
        if self.format == LEGACY_RECIPE_FORMAT
            && self
                .packages
                .iter()
                .any(|package| !package.provider_requires.is_empty())
        {
            return Err(invalid("exact provider requirements need recipe format 2"));
        }
        if self.format < RECIPE_FORMAT_WITH_PROVIDER_BINDINGS
            && self.packages.iter().any(|package| {
                crate::provider_binding::has_explicit_scope(
                    package.provider.as_ref(),
                    &package.provider_requires,
                )
            })
        {
            return Err(invalid("reviewed provider bindings need recipe format 4"));
        }
        if self.settings.len() > MAX_RECIPE_SETTINGS
            || (self.format == LEGACY_RECIPE_FORMAT && !self.settings.is_empty())
            || (!self.settings.is_empty()
                && !self.loader.as_ref().is_some_and(|loader| {
                    *loader == crate::profile_loader::ModEngine::N64Recomp.reference()
                })
                && crate::native_mod_list::recomp_game(&self.port_id).is_none())
        {
            return Err(invalid(
                "this format or loader cannot share the supplied settings",
            ));
        }
        let mut setting_ids = BTreeSet::new();
        let enabled_digests = self
            .packages
            .iter()
            .filter(|package| package.enabled)
            .map(|package| (package.native_id.as_str(), package.sha256.as_str()))
            .collect::<BTreeSet<_>>();
        for setting in &self.settings {
            if !setting.validates_shape()
                || !setting_ids.insert((&setting.native_id, &setting.option_id))
                || !enabled_digests
                    .contains(&(setting.native_id.as_str(), setting.package_sha256.as_str()))
            {
                return Err(invalid(
                    "a setting does not name a unique option for an exact enabled package",
                ));
            }
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
            match (self.format, &original.storage) {
                (LEGACY_RECIPE_FORMAT | RECIPE_FORMAT_WITH_MOD_STATE, None) => {}
                (RECIPE_FORMAT | RECIPE_FORMAT_WITH_PROVIDER_BINDINGS, Some(storage))
                    if hash_ok(&storage.sha256)
                        && storage
                            .observed_identity_sha256
                            .as_deref()
                            .is_none_or(hash_ok) => {}
                _ => {
                    return Err(invalid(
                        "original storage identity does not match the recipe format",
                    ));
                }
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
        for package in &self.packages {
            crate::provider_binding::validate_dependency_scope(
                package.provider.as_ref(),
                &package.provider_requires,
            )?;
            crate::profile::validate_provider_requirements(
                &package.native_id,
                package.enabled,
                &package.provider_requires,
                |required, id, hash| {
                    enabled.get(id).is_some_and(|member| {
                        member.sha256 == hash && member.provider.as_ref() == Some(required)
                    })
                },
            )?;
        }
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

fn default_uncaptured(format: u32) -> Vec<String> {
    let original_note = if format < RECIPE_FORMAT {
        "original game files are never included; originals are referenced by content identity only"
    } else {
        "original game files are never included"
    };
    [
        original_note,
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
            None => {
                let profile = profile::profile_by_id(&connection, port_id, profile_id)?;
                let revision =
                    profile::revision_by_number(&connection, profile_id, profile.current_revision)?;
                profile::require_active_default_revision(&connection, &profile, &revision)?;
                revision
            }
        };
        if revision.build.port_id != port_id {
            return Err(PortcoveError::not_found(
                "profile is not registered for this port",
            ));
        }
        let loader = if revision.packages.iter().any(|package| package.enabled) {
            self.profile_loader_binding(&revision.build, revision.loader.as_ref(), true)?
        } else {
            revision.loader.clone()
        };
        let settings = if let Some(layout) = self.layout_for_revision(&revision)?
            && let Some(game) = layout.recomp_game()
        {
            recomp_mod_settings::export(&layout, game, &revision)?
        } else {
            Vec::new()
        };
        let originals = revision
            .originals
            .iter()
            .map(RecipeOriginal::from)
            .collect::<Vec<_>>();
        let needs_provider_closure = revision
            .packages
            .iter()
            .any(|package| !package.provider_requires.is_empty());
        let format = if revision.packages.iter().any(|package| {
            crate::provider_binding::has_explicit_scope(
                package.provider.as_ref(),
                &package.provider_requires,
            )
        }) {
            RECIPE_FORMAT_WITH_PROVIDER_BINDINGS
        } else if !originals.is_empty() {
            RECIPE_FORMAT
        } else if !settings.is_empty() || needs_provider_closure {
            RECIPE_FORMAT_WITH_MOD_STATE
        } else {
            LEGACY_RECIPE_FORMAT
        };
        let mut uncaptured = default_uncaptured(format);
        if !settings.is_empty() {
            uncaptured.retain(|line| line != "settings are not exported");
            uncaptured.push("ordinary settings, free-form text and settings of disabled or unmanaged mods are not exported".into());
        }
        let mut recipe = ProfileRecipe {
            format,
            port_id: port_id.into(),
            runtime: RecipeRuntime {
                artifact: revision.build.artifact.clone(),
                runtime: revision.build.runtime.clone(),
                definition: revision.build.definition.clone(),
                installed_contract_sha256: revision.build.installed_contract_sha256.clone(),
                platform: revision.build.platform,
            },
            loader,
            originals,
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
                    provider_requires: package.provider_requires.clone(),
                })
                .collect(),
            orderings: revision.orderings.clone(),
            settings,
            uncaptured,
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

    /// Privately obtains an exact provider file explicitly selected from a recipe.
    /// The ordinary provider plan checks origin, bounds and executable content.
    /// `prior` are the review's earlier steps; with none, the steps recorded for
    /// this exact recipe are used, so a CLI review resumes like Desktop's.
    pub async fn plan_recipe_acquisition(
        &self,
        recipe: &ProfileRecipe,
        review_profile_id: &str,
        native_id: &str,
        prior: &[RecipeAcquisitionPlan],
    ) -> Result<RecipeAcquisitionPlan> {
        recipe.validate()?;
        let staging = if prior.is_empty() {
            self.recorded_recipe_staging(recipe)?
        } else {
            RecipeStaging::from_acquisitions(recipe, prior)?
        };
        let step = self
            .acquire_recipe_step(recipe, review_profile_id, native_id, &staging)
            .await?;
        let provider_plan = match step {
            AcquiredStep::Reused { plan_sha256 } => staging
                .plan(&plan_sha256)
                .cloned()
                .ok_or_else(|| PortcoveError::state("a reused provider review disappeared"))?,
            AcquiredStep::Staged(plan) => plan,
        };
        Ok(RecipeAcquisitionPlan {
            recipe_identity_sha256: recipe.identity_sha256.clone(),
            native_id: native_id.to_owned(),
            provider_plan,
        })
    }

    /// One acquisition step. A package already held by a staged plan reuses it
    /// by digest; nothing is copied. A new plan is staged, read in full and
    /// recorded before it is returned.
    async fn acquire_recipe_step(
        &self,
        recipe: &ProfileRecipe,
        review_profile_id: &str,
        native_id: &str,
        prior: &RecipeStaging,
    ) -> Result<AcquiredStep> {
        use crate::provider_install::ProviderInstallMode;
        let package = recipe
            .packages
            .iter()
            .find(|package| package.native_id == native_id)
            .ok_or_else(|| PortcoveError::not_found("the recipe has no such package"))?;
        let (catalog, _) = self.library.load_catalog()?;
        let (reference, (_, project, file)) = package
            .provider
            .as_ref()
            .and_then(|provider| {
                plannable_provider_file(&catalog, &recipe.port_id, provider)
                    .map(|identity| (provider, identity))
            })
            .ok_or_else(|| {
                PortcoveError::unsupported("this recipe package needs its exact local file")
            })?;
        let installs = self.library.all_installs()?;
        let (install, build) = self
            .match_recipe_install(recipe, &installs)
            .ok_or_else(|| {
                PortcoveError::conflict("the recipe's exact installation is unavailable")
            })?;
        self.profile_loader_binding(&build, recipe.loader.as_ref(), true)?;
        let layout = self.layout_for_install(install)?.ok_or_else(|| {
            PortcoveError::unsupported("the recipe build has no reviewed mod loader")
        })?;
        // Earlier steps were verified when they were staged and are rechecked by
        // every plan and in full by apply; this step only needs to know which
        // packages they already cover, so its work does not grow with them.
        if prior.contains(native_id) {
            return Err(PortcoveError::usage(
                "the recipe package is already in this review",
            ));
        }
        if let Some(plan) = prior.provider_plans.iter().find(|plan| {
            reviewed_origin(plan, native_id).is_ok_and(|(origin, _)| {
                origin.project == project
                    && origin.file.as_deref() == Some(file.as_str())
                    && plan
                        .members
                        .iter()
                        .any(|member| member.file_name == native_id)
            })
        }) {
            verify_steps(
                &catalog,
                recipe,
                &layout,
                [(native_id, plan)],
                Depth::Recorded,
            )?;
            self.record_recipe_step(recipe, native_id, plan)?;
            return Ok(AcquiredStep::Reused {
                plan_sha256: plan.plan_sha256.clone(),
            });
        }
        let client = crate::provider_client::ProviderClient::for_definition(
            &self.library,
            catalog.port(&recipe.port_id)?,
            Some(&reference.provider),
        )?;
        let mode = ProviderInstallMode::Recipe {
            identity: &recipe.identity_sha256,
            install_id: Some(&install.id),
        };
        let provider_plan = self
            .plan_provider_install_in_mode(
                &client,
                &recipe.port_id,
                review_profile_id,
                &project,
                &file,
                mode,
            )
            .await?;
        let discard = |plan: &crate::ProviderInstallPlan| {
            let _ = self.discard_provider_install_in_mode(plan, mode);
        };
        // The review stays inside its working-set budget as it grows.
        let added = serde_json::to_vec(&provider_plan)?.len();
        if let Err(error) = require_review_budget(prior.encoded_bytes()?.saturating_add(added)) {
            discard(&provider_plan);
            return Err(error);
        }
        // Only the new step is read in full; the earlier ones were checked above.
        if let Err(error) = verify_steps(
            &catalog,
            recipe,
            &layout,
            [(native_id, &provider_plan)],
            Depth::Content,
        ) {
            discard(&provider_plan);
            return Err(error);
        }
        // Recorded before it is returned, so a review interrupted after this
        // step resumes with it (see `plan_recipe_import`).
        if let Err(error) = self.record_recipe_step(recipe, native_id, &provider_plan) {
            discard(&provider_plan);
            return Err(error);
        }
        Ok(AcquiredStep::Staged(provider_plan))
    }

    /// Releases the private staging for a cancelled recipe review.
    pub fn discard_recipe_acquisition(&self, acquisition: &RecipeAcquisitionPlan) -> Result<()> {
        let _guard = self.library.try_lock_port(
            &acquisition.provider_plan.port_id,
            "discard-recipe-acquisition",
        )?;
        if !hash_ok(&acquisition.recipe_identity_sha256) {
            return Err(invalid(
                "the provider review has an invalid recipe identity",
            ));
        }
        self.discard_recipe_plan_locked(
            &acquisition.recipe_identity_sha256,
            &acquisition.provider_plan,
        )
    }

    /// Releases a whole review: every staged provider plan and its records.
    pub fn discard_recipe_review(&self, plan: &RecipeImportPlan) -> Result<()> {
        plan.recipe.validate()?;
        let _guard = self
            .library
            .try_lock_port(&plan.recipe.port_id, "discard-recipe-review")?;
        for provider_plan in &plan.staging.provider_plans {
            if provider_plan.port_id != plan.recipe.port_id {
                return Err(PortcoveError::conflict(
                    "staging belongs to a different recipe review",
                ));
            }
        }
        for provider_plan in &plan.staging.provider_plans {
            self.discard_recipe_plan_locked(&plan.recipe.identity_sha256, provider_plan)?;
        }
        self.clear_recipe_acquisition_record(&plan.recipe)
    }

    /// Removes one plan's staging and its record. References to it from other
    /// packages no longer resolve and are dropped on the next review.
    fn discard_recipe_plan_locked(
        &self,
        identity: &str,
        provider_plan: &crate::ProviderInstallPlan,
    ) -> Result<()> {
        self.discard_provider_install_in_mode(
            provider_plan,
            crate::provider_install::ProviderInstallMode::Recipe {
                identity,
                install_id: None,
            },
        )?;
        let record = self
            .acquisition_records(&provider_plan.port_id, identity)
            .join(PLAN_RECORDS)
            .join(format!("{}.json", provider_plan.plan_sha256));
        match fs::remove_file(record) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    /// Where a recipe review records its staged steps: beside the staging they
    /// name, so abandoned reviews are pruned with their bytes.
    fn acquisition_records(&self, port_id: &str, identity: &str) -> PathBuf {
        let layout = crate::profile_deploy::Layout::for_user(&self.library.user_dir(port_id));
        crate::provider_install::ProviderInstallMode::Recipe {
            identity,
            install_id: None,
        }
        .staging_root(&layout)
        .join(ACQUISITION_RECORDS)
    }

    /// Durably records one staged package: its plan once, by digest, and a
    /// small reference naming that plan. Reusing a plan writes only the
    /// reference, so records grow with the packages, not with plan copies.
    fn record_recipe_step(
        &self,
        recipe: &ProfileRecipe,
        native_id: &str,
        provider_plan: &crate::ProviderInstallPlan,
    ) -> Result<()> {
        if !hash_ok(&recipe.identity_sha256) || !hash_ok(&provider_plan.plan_sha256) {
            return Err(invalid("its identity digest is malformed"));
        }
        if provider_plan.port_id != recipe.port_id {
            return Err(PortcoveError::conflict(
                "the provider review does not match this exact recipe",
            ));
        }
        let directory = self.acquisition_records(&recipe.port_id, &recipe.identity_sha256);
        crate::path::refuse_symlink_ancestors(&directory)?;
        let plans = directory.join(PLAN_RECORDS);
        let members = directory.join(MEMBER_RECORDS);
        fs::create_dir_all(&plans)?;
        fs::create_dir_all(&members)?;
        let plan_path = plans.join(format!("{}.json", provider_plan.plan_sha256));
        if !plan_path.is_file() {
            let bytes = serde_json::to_vec(provider_plan)?;
            if bytes.len() > MAX_ACQUISITION_RECORD_BYTES {
                return Err(PortcoveError::unsupported(
                    "one provider review is too large to record",
                ));
            }
            crate::durability::write_bytes_atomically(&plan_path, &bytes, true)?;
        }
        let reference = RecipeAcquisitionRef {
            native_id: native_id.to_owned(),
            plan_sha256: provider_plan.plan_sha256.clone(),
        };
        crate::durability::write_bytes_atomically(
            &members.join(record_name(native_id)),
            &serde_json::to_vec(&reference)?,
            true,
        )?;
        self.keep_recipe_staging(recipe, provider_plan);
        Ok(())
    }

    /// A review in use keeps its plan staging, records and root out of the
    /// 24-hour pruning of abandoned staging, however long it takes.
    fn keep_recipe_staging(
        &self,
        recipe: &ProfileRecipe,
        provider_plan: &crate::ProviderInstallPlan,
    ) {
        let staging = self.recipe_plan_staging(recipe, provider_plan);
        touch_directory(&staging);
        if let Some(root) = staging.parent() {
            touch_directory(root);
            touch_directory(&root.join(ACQUISITION_RECORDS));
        }
    }

    fn recipe_plan_staging(
        &self,
        recipe: &ProfileRecipe,
        provider_plan: &crate::ProviderInstallPlan,
    ) -> PathBuf {
        let layout =
            crate::profile_deploy::Layout::for_user(&self.library.user_dir(&recipe.port_id));
        crate::provider_install::ProviderInstallMode::Recipe {
            identity: &recipe.identity_sha256,
            install_id: None,
        }
        .staging(&layout, &provider_plan.plan_sha256)
    }

    /// The recorded steps that still name present, exact staging for this
    /// recipe. A step that no longer verifies is forgotten, so the review shows
    /// that package as missing rather than ready. Each plan is read once.
    pub fn recorded_recipe_staging(&self, recipe: &ProfileRecipe) -> Result<RecipeStaging> {
        recipe.validate()?;
        let directory = self.acquisition_records(&recipe.port_id, &recipe.identity_sha256);
        if crate::path::refuse_symlink_ancestors(&directory).is_err() {
            return Ok(RecipeStaging::default());
        }
        let members = match fs::read_dir(directory.join(MEMBER_RECORDS)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RecipeStaging::default());
            }
            Err(error) => return Err(error.into()),
        };
        let read_bounded = |path: &Path| {
            fs::symlink_metadata(path)
                .is_ok_and(|metadata| {
                    metadata.is_file() && metadata.len() <= MAX_ACQUISITION_RECORD_BYTES as u64
                })
                .then(|| fs::read(path).ok())
                .flatten()
        };
        let layout =
            crate::profile_deploy::Layout::for_user(&self.library.user_dir(&recipe.port_id));
        let mut plans = BTreeMap::<String, Option<crate::ProviderInstallPlan>>::new();
        let mut staging = RecipeStaging::default();
        let mut references = BTreeMap::new();
        for entry in members {
            let entry = entry?;
            let path = entry.path();
            let reference = read_bounded(&path)
                .and_then(|bytes| serde_json::from_slice::<RecipeAcquisitionRef>(&bytes).ok())
                .filter(|reference| {
                    entry.file_name().to_str() == Some(record_name(&reference.native_id).as_str())
                        && hash_ok(&reference.plan_sha256)
                });
            let Some(reference) = reference else {
                let _ = fs::remove_file(&path);
                continue;
            };
            let plan = plans
                .entry(reference.plan_sha256.clone())
                .or_insert_with(|| {
                    read_bounded(
                        &directory
                            .join(PLAN_RECORDS)
                            .join(format!("{}.json", reference.plan_sha256)),
                    )
                    .and_then(|bytes| {
                        serde_json::from_slice::<crate::ProviderInstallPlan>(&bytes).ok()
                    })
                    .filter(|plan| {
                        plan.plan_sha256 == reference.plan_sha256
                            && crate::provider_install::digest(plan)
                                .is_ok_and(|digest| digest == plan.plan_sha256)
                    })
                });
            let verified = plan.as_ref().is_some_and(|plan| {
                verify_steps(
                    self.catalog(),
                    recipe,
                    &layout,
                    [(reference.native_id.as_str(), plan)],
                    Depth::Recorded,
                )
                .is_ok()
            });
            if verified {
                references.insert(reference.native_id.clone(), reference);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
        for reference in references.into_values() {
            if let Some(Some(plan)) = plans.get(&reference.plan_sha256) {
                staging.insert(&reference.native_id, plan.clone())?;
                self.keep_recipe_staging(recipe, plan);
            }
        }
        require_review_budget(staging.encoded_bytes()?)?;
        Ok(staging)
    }

    fn clear_recipe_acquisition_record(&self, recipe: &ProfileRecipe) -> Result<()> {
        let directory = self.acquisition_records(&recipe.port_id, &recipe.identity_sha256);
        crate::path::refuse_symlink_ancestors(&directory)?;
        match fs::remove_dir_all(directory) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    /// Releases each plan holding a step whose staged bytes no longer match,
    /// so a fresh review shows it as missing instead of repeatedly offering it
    /// as ready. `layout` must be the recipe installation's own layout, so
    /// native code is checked with the loader that reviewed it.
    fn forget_unverifiable_acquisitions(
        &self,
        recipe: &ProfileRecipe,
        layout: &crate::profile_deploy::Layout,
        staging: &RecipeStaging,
    ) {
        let Ok(steps) = staging.steps() else {
            return;
        };
        let mut released = BTreeSet::new();
        for (native_id, plan) in steps {
            if released.contains(plan.plan_sha256.as_str()) {
                continue;
            }
            if verify_steps(
                self.catalog(),
                recipe,
                layout,
                [(native_id, plan)],
                Depth::Content,
            )
            .is_err()
            {
                released.insert(plan.plan_sha256.as_str());
                let _ = self.discard_recipe_plan_locked(&recipe.identity_sha256, plan);
            }
        }
    }

    /// Stages one named package of a reviewed plan and returns the new review.
    /// The plan must still be current and must list the package to check.
    pub async fn acquire_recipe_package(
        &self,
        plan: &RecipeImportPlan,
        review_profile_id: &str,
        native_id: &str,
    ) -> Result<RecipeImportPlan> {
        require_import_plan_digest(plan)?;
        let current = self.plan_recipe_import_with_staging(&plan.recipe, &plan.staging)?;
        if current.plan_sha256 != plan.plan_sha256
            || !current.provider_checks.iter().any(|id| id == native_id)
        {
            return Err(PortcoveError::conflict(
                "recipe inputs changed; inspect the recipe again",
            ));
        }
        let mut staging = current.staging;
        match self
            .acquire_recipe_step(&plan.recipe, review_profile_id, native_id, &staging)
            .await?
        {
            AcquiredStep::Reused { plan_sha256 } => {
                staging.acquisitions.push(RecipeAcquisitionRef {
                    native_id: native_id.to_owned(),
                    plan_sha256,
                });
            }
            AcquiredStep::Staged(provider_plan) => staging.insert(native_id, provider_plan)?,
        }
        self.plan_recipe_import_with_staging(&plan.recipe, &staging)
    }

    /// Stages the next missing recipe packages, at most
    /// [`RECIPE_ACQUISITION_STEP`] provider downloads per call. Each staged
    /// step is recorded before the next starts. A failure stops the batch at
    /// that package and returns the progress so far with the reason; the
    /// caller repeats the call until nothing is left to check.
    pub async fn acquire_recipe_packages(
        &self,
        plan: &RecipeImportPlan,
        review_profile_id: &str,
    ) -> Result<RecipeAcquisitionBatch> {
        require_import_plan_digest(plan)?;
        let current = self.plan_recipe_import_with_staging(&plan.recipe, &plan.staging)?;
        if current.plan_sha256 != plan.plan_sha256 {
            return Err(PortcoveError::conflict(
                "recipe inputs changed; inspect the recipe again",
            ));
        }
        let mut staging = current.staging;
        let mut acquired = Vec::new();
        let mut downloads = 0usize;
        let mut failure = None;
        for native_id in &current.provider_checks {
            if downloads == RECIPE_ACQUISITION_STEP {
                break;
            }
            match self
                .acquire_recipe_step(&plan.recipe, review_profile_id, native_id, &staging)
                .await
            {
                Ok(AcquiredStep::Reused { plan_sha256 }) => {
                    staging.acquisitions.push(RecipeAcquisitionRef {
                        native_id: native_id.clone(),
                        plan_sha256,
                    });
                    acquired.push(native_id.clone());
                }
                Ok(AcquiredStep::Staged(provider_plan)) => {
                    downloads += 1;
                    staging.insert(native_id, provider_plan)?;
                    acquired.push(native_id.clone());
                }
                Err(error) => {
                    failure = Some(RecipeAcquisitionFailure::new(native_id, error));
                    break;
                }
            }
        }
        let plan = self.plan_recipe_import_with_staging(&plan.recipe, &staging)?;
        Ok(RecipeAcquisitionBatch {
            plan,
            acquired,
            failure,
        })
    }

    /// Exports the current resolved setup into the player-selected file.
    pub fn write_profile_recipe(
        &self,
        port_id: &str,
        profile_id: &str,
        destination: &Path,
    ) -> Result<()> {
        let recipe = self.export_profile_recipe(port_id, profile_id, None)?;
        let bytes = serde_json::to_vec(&recipe)?;
        if bytes.len() > MAX_RECIPE_BYTES {
            return Err(PortcoveError::unsupported(format!(
                "the exported recipe would exceed {}",
                crate::setup_capacity::mebibytes(MAX_RECIPE_BYTES)
            )));
        }
        crate::durability::write_bytes_atomically(destination, &bytes, true)
    }

    /// Plans an import without changing anything.
    fn match_recipe_install<'a>(
        &self,
        recipe: &ProfileRecipe,
        installs: &'a [crate::InstallRecord],
    ) -> Option<(&'a crate::InstallRecord, crate::RetainedBuildIdentity)> {
        installs
            .iter()
            .filter(|install| install.port_id == recipe.port_id)
            .find_map(|install| {
                let build = self
                    .verified_retained_build(&recipe.port_id, &install.id)
                    .ok()?;
                (build.runtime == recipe.runtime.runtime
                    && build.artifact == recipe.runtime.artifact
                    && build.definition == recipe.runtime.definition
                    && build.installed_contract_sha256 == recipe.runtime.installed_contract_sha256
                    && build.platform == recipe.runtime.platform)
                    .then_some((install, build))
            })
    }

    /// Plans an import, resuming the provider files an earlier review of the
    /// same recipe already staged (see [`PortcoveService::record_recipe_acquisitions`]).
    pub fn plan_recipe_import(&self, recipe: &ProfileRecipe) -> Result<RecipeImportPlan> {
        recipe.validate()?;
        let recorded = self.recorded_recipe_staging(recipe)?;
        self.plan_recipe_import_with_staging(recipe, &recorded)
    }

    /// Plans with explicit single-package acquisitions (as the CLI passes them).
    pub fn plan_recipe_import_with_acquisitions(
        &self,
        recipe: &ProfileRecipe,
        acquisitions: &[RecipeAcquisitionPlan],
    ) -> Result<RecipeImportPlan> {
        recipe.validate()?;
        let staging = RecipeStaging::from_acquisitions(recipe, acquisitions)?;
        self.plan_recipe_import_with_staging(recipe, &staging)
    }

    pub fn plan_recipe_import_with_staging(
        &self,
        recipe: &ProfileRecipe,
        staging: &RecipeStaging,
    ) -> Result<RecipeImportPlan> {
        self.plan_recipe_import_at(recipe, staging, Depth::Recorded)
    }

    fn plan_recipe_import_at(
        &self,
        recipe: &ProfileRecipe,
        staging: &RecipeStaging,
        depth: Depth,
    ) -> Result<RecipeImportPlan> {
        recipe.validate()?;
        require_review_budget(staging.encoded_bytes()?)?;
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
        let exact = self.match_recipe_install(recipe, &installs);
        let install = exact.as_ref().map(|(install, _)| *install);
        let install_id = install.map(|install| install.id.clone());
        let runtime = match exact {
            Some((install, build)) => {
                if let Err(error) = self.profile_loader_binding(
                    &build,
                    recipe.loader.as_ref(),
                    recipe.packages.iter().any(|package| package.enabled),
                ) {
                    holds.push(error.message);
                }
                RecipeInputPlan {
                    name: "runtime".into(),
                    status: RecipeInputStatus::Available,
                    detail: format!("the exact runtime build {} is installed", install.version),
                }
            }
            None => {
                holds.push("the exact runtime build is not installed".to_owned());
                RecipeInputPlan {
                    name: "runtime".into(),
                    status: RecipeInputStatus::Unavailable,
                    detail: "the recipe names an exact runtime and this library could not verify it. Locate that exact build before reviewing the import again".into(),
                }
            }
        };
        let retained_catalog = install
            .map(|install| self.installed_catalog(install))
            .transpose()?;
        let catalog = retained_catalog.as_ref().unwrap_or(self.catalog());
        let connection = self.library.connection()?;
        let (originals, verified_originals) = original_inputs::plan(
            &self.library,
            &connection,
            catalog,
            install,
            recipe,
            &mut holds,
        )?;
        let user = self.library.user_dir(&recipe.port_id);
        let layout = install
            .map(|install| self.layout_for_install(install))
            .transpose()?
            .flatten()
            .unwrap_or_else(|| crate::profile_deploy::Layout::for_user(&user));
        let catalog = self.catalog();
        let acquisition_bytes = verify_steps(catalog, recipe, &layout, staging.steps()?, depth)?;
        // Every review of these steps keeps their staging from aging out.
        for provider_plan in &staging.provider_plans {
            self.keep_recipe_staging(recipe, provider_plan);
        }
        let recorded_code = crate::profile_deploy::consented_code(&layout).unwrap_or_default();
        let mut code_approval = Vec::new();
        let mut provider_checks = Vec::new();
        let recomp_game = layout.recomp_game();
        let connection = self.library.connection()?;
        let packages = recipe
            .packages
            .iter()
            .map(|package| {
                let stored = layout.package(&package.sha256, &package.native_id);
                let staged = acquisition_bytes.get(&package.native_id);
                let exact_size = crate::path::refuse_symlink_ancestors(&stored).is_ok()
                    && fs::symlink_metadata(&stored)
                        .is_ok_and(|entry| entry.is_file() && entry.len() == package.size);
                let present = if staged.is_some() {
                    true
                } else if !exact_size {
                    false
                } else if let Some(game) = recomp_game {
                    match crate::inspect_recomp_mod(&stored, game) {
                        Ok(recomp)
                            if recomp.sha256 == package.sha256
                                && package.native_id == format!("{}.nrm", recomp.native_id)
                                && package.native_version.as_ref().is_none_or(|version| {
                                    version == &recomp.native_version
                                }) =>
                        {
                            if recomp.holds.contains(&crate::RecompModHold::OtherGame) {
                                holds.push(format!("{} is for a different game", package.native_id));
                            } else if let Err(error) =
                                crate::profile_deploy::require_admissible_code(&recomp)
                            {
                                holds.push(format!("Portcove held {}. {}", package.native_id, error.message));
                            } else if package.enabled
                                && !recomp.execution.is_empty()
                                && !recorded_code.contains(&package.sha256)
                            {
                                code_approval.push(RecipeCodeApproval {
                                    native_id: package.native_id.clone(),
                                    sha256: package.sha256.clone(),
                                    runs: recomp.execution,
                                });
                            }
                            true
                        }
                        _ => false,
                    }
                } else {
                    matches_exact_package(&stored, package)
                };
                if let Some(staged) = staged
                    && package.enabled
                    && !staged.runs_code.is_empty()
                    && !recorded_code.contains(&package.sha256)
                {
                    code_approval.push(RecipeCodeApproval {
                        native_id: package.native_id.clone(),
                        sha256: package.sha256.clone(),
                        runs: staged.runs_code.clone(),
                    });
                }
                let evidence = profile::provider_evidence(
                    &connection,
                    &recipe.port_id,
                    package,
                    package.provider.as_ref(),
                )?;
                let closure_member = !package.provider_requires.is_empty()
                    || recipe.packages.iter().filter(|member| member.enabled).any(|member| {
                        member.provider_requires.iter().any(|requirement| {
                            requirement.members.contains_key(&package.native_id)
                        })
                    });
                let closure_unverified = evidence == profile::ProviderEvidence::RequirementsDiffer
                    || closure_member && evidence != profile::ProviderEvidence::Matches;
                let plannable = package
                    .provider
                    .as_ref()
                    .and_then(|provider| plannable_provider_file(catalog, &recipe.port_id, provider));
                let (status, detail) = if staged.is_some() {
                    (
                        RecipeInputStatus::Available,
                        "the exact package is ready in private review staging".to_owned(),
                    )
                } else if present && closure_unverified {
                    if plannable.is_some() {
                        provider_checks.push(package.native_id.clone());
                    }
                    holds.push(format!(
                        "package {} needs an exact Thunderstore review before import",
                        package.native_id
                    ));
                    (
                        RecipeInputStatus::Unavailable,
                        "review the exact Thunderstore wrapper set and match its native members and requirements to this recipe".to_owned(),
                    )
                } else if present && package.provider.is_some()
                    && evidence == profile::ProviderEvidence::Unrecorded {

                    (
                        RecipeInputStatus::Available,
                        "its exact bytes are in the package store; its provider label is not recorded in this library for these bytes, so the new profile does not keep it".to_owned(),
                    )
                } else if present {
                    (
                        RecipeInputStatus::Available,
                        "its exact bytes are in the package store".to_owned(),
                    )
                } else if let Some((label, project, file)) = plannable {
                    provider_checks.push(package.native_id.clone());
                    holds.push(format!(
                        "package {} needs its exact bytes before import",
                        package.native_id
                    ));
                    (
                        RecipeInputStatus::Unavailable,
                        format!(
                            "availability has not been verified for the recipe's exact bytes. Review {label} project {project}, file {file} with `profile provider-plan` and compare its package digests with the recipe"
                        ),
                    )
                } else if package.provider.is_some() {
                    holds.push(format!(
                        "package {} names a source Portcove cannot plan",
                        package.native_id
                    ));
                    (
                        RecipeInputStatus::Unavailable,
                        "its bytes are not in the store, and its source is not a provider file this game has a reviewed binding for".to_owned(),
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
        if layout.loader_list().is_some() {
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
        if !recipe.settings.is_empty()
            && packages
                .iter()
                .all(|package| package.status == RecipeInputStatus::Available)
            && let Some(game) = layout.recomp_game()
            && let Err(error) =
                recomp_mod_settings::validate_portable(&layout, game, recipe, |native_id| {
                    acquisition_bytes
                        .get(native_id)
                        .map(|package| package.path.as_path())
                })
        {
            holds.push(format!(
                "The recipe's mod settings need review. {}",
                error.message
            ));
        }
        if let (Some(game), Some(install)) = (recomp_game, install)
            && packages
                .iter()
                .all(|package| package.status == RecipeInputStatus::Available)
            && let Err(error) = review_native_requirements(
                recipe,
                &layout,
                game,
                &install.version,
                &acquisition_bytes,
            )
        {
            let details = error
                .details
                .iter()
                .map(|(name, value)| format!("{name} {value}"))
                .collect::<Vec<_>>();
            holds.push(
                format!("{} {}", error.message, details.join(", "))
                    .trim_end()
                    .to_owned(),
            );
        }
        if encoded_setup_bytes(recipe)? > MAX_IMPORTED_SETUP_BYTES {
            holds.push(format!(
                "this recipe's setup would not fit in one saved setup ({} limit)",
                crate::setup_capacity::mebibytes(crate::setup_capacity::MAX_SETUP_DOCUMENT_BYTES)
            ));
        }
        let mut plan = RecipeImportPlan {
            recipe: recipe.clone(),
            runtime,
            install_id,
            originals,
            verified_originals,
            packages,
            staging: staging.clone(),
            provider_checks,
            code_approval,
            can_apply: holds.is_empty(),
            holds,
            plan_sha256: String::new(),
        };
        plan.plan_sha256 = import_plan_digest(&plan)?;
        Ok(plan)
    }

    pub fn authorize_recipe_import(
        &self,
        plan: &RecipeImportPlan,
        display_name: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        require_import_plan_digest(plan)?;
        if !plan.code_approval.is_empty() {
            return Err(PortcoveError::usage(
                "this recipe needs permission to run the exact mod code shown in its review",
            ));
        }
        self.library
            .issue_authorization(ACTION, &target(plan, display_name)?, &plan.plan_sha256)
    }

    pub fn authorize_recipe_import_allowing_code(
        &self,
        plan: &RecipeImportPlan,
        display_name: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        if plan.code_approval.is_empty() {
            return self.authorize_recipe_import(plan, display_name);
        }
        require_import_plan_digest(plan)?;
        self.library.issue_authorization(
            ACTION_WITH_CODE,
            &target(plan, display_name)?,
            &plan.plan_sha256,
        )
    }

    /// Creates a new profile from exact local or privately staged inputs.
    /// Recomputes the review under the source and port locks before applying.
    pub fn apply_recipe_import(
        &self,
        plan: &RecipeImportPlan,
        display_name: &str,
        token: &str,
    ) -> Result<Profile> {
        plan.recipe.validate()?;
        require_import_plan_digest(plan)?;
        let port_id = plan.recipe.port_id.clone();
        let plan_install =
            Library::install_by_id(&self.library.connection()?, plan.install_id.as_deref())?
                .filter(|install| install.port_id == port_id)
                .ok_or_else(|| {
                    PortcoveError::conflict(
                        "the recipe's exact installation is unavailable; review it again",
                    )
                })?;
        let catalog = self.installed_catalog(&plan_install)?;
        let port = catalog.port(&port_id)?;
        if plan.recipe.originals.iter().any(|original| {
            port.source_profile.as_deref() != Some(original.requirement_id.as_str())
                && port.bios_source_profile.as_deref() != Some(original.requirement_id.as_str())
        }) {
            return Err(PortcoveError::conflict(
                "the recipe names an original outside this installation's rules",
            ));
        }
        let mut requirements = plan
            .recipe
            .originals
            .iter()
            .map(|original| original.requirement_id.as_str())
            .collect::<Vec<_>>();
        requirements.sort_unstable();
        let _source_guards = requirements
            .into_iter()
            .map(|requirement| self.library.try_lock_source(requirement))
            .collect::<Result<Vec<_>>>()?;
        let _guard = self
            .library
            .try_lock_port(&port_id, "apply-recipe-import")?;
        // Apply reads every staged byte; a step that no longer matches leaves
        // the review so the next plan shows it as missing instead of ready.
        let current = match self.plan_recipe_import_at(&plan.recipe, &plan.staging, Depth::Content)
        {
            Ok(current) => current,
            Err(error) => {
                let layout = self.layout_for_install(&plan_install)?.unwrap_or_else(|| {
                    crate::profile_deploy::Layout::for_user(&self.library.user_dir(&port_id))
                });
                self.forget_unverifiable_acquisitions(&plan.recipe, &layout, &plan.staging);
                return Err(error);
            }
        };
        if current.plan_sha256 != plan.plan_sha256 {
            return Err(PortcoveError::conflict(
                "the local inputs changed after review; plan the import again",
            ));
        }
        self.library.consume_authorization(
            token,
            if current.code_approval.is_empty() {
                ACTION
            } else {
                ACTION_WITH_CODE
            },
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
        let originals = current.verified_originals;
        let layout = self.layout_for_install(&plan_install)?.unwrap_or_else(|| {
            crate::profile_deploy::Layout::for_user(&self.library.user_dir(&port_id))
        });
        let (catalog, _) = self.library.load_catalog()?;
        let acquisition_bytes = verify_steps(
            &catalog,
            &current.recipe,
            &layout,
            current.staging.steps()?,
            Depth::Content,
        )?;
        for package in &current.recipe.packages {
            if let Some(acquired) = acquisition_bytes.get(&package.native_id) {
                publish_acquired_package(&layout, package, &acquired.path)?;
            }
        }
        for approved in &current.code_approval {
            crate::profile_deploy::record_code_consent(&layout, &approved.sha256)?;
        }
        // A recipe's provider label is an unverified claim. The new profile keeps it
        // only when this port already recorded exactly that label for the same
        // bytes and file name, so update checks never follow a label the recipe
        // supplied. The reviewed plan says which labels are dropped.
        let connection = self.library.connection()?;
        let mut providers = Vec::with_capacity(plan.recipe.packages.len());
        for package in &plan.recipe.packages {
            let kept = match &package.provider {
                Some(provider)
                    if profile::provider_evidence(
                        &connection,
                        &port_id,
                        package,
                        Some(provider),
                    )? == profile::ProviderEvidence::Matches =>
                {
                    Some(provider.clone())
                }
                _ => None,
            };
            providers.push(
                acquisition_bytes
                    .get(&package.native_id)
                    .map(|acquired| acquired.provider.clone())
                    .or(kept),
            );
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
                provider_requires: package.provider_requires.clone(),
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
            recomp_companion_sets_v1: None,
            orderings: plan.recipe.orderings.clone(),
            settings: recomp_mod_settings::import(&plan.recipe.settings)?,
            save_group: String::new(),
            limits: Vec::new(),
            created_at: 0,
            digest: String::new(),
        };
        let profile = profile::new_profile(&port_id, display_name, false);
        let created = self.publish_new_profile(
            &profile,
            &install_id,
            build,
            originals,
            Some(&base),
            base.loader.clone(),
        )?;
        for provider_plan in &current.staging.provider_plans {
            let _ = self.discard_recipe_plan_locked(&current.recipe.identity_sha256, provider_plan);
        }
        let _ = self.clear_recipe_acquisition_record(&current.recipe);
        Ok(created)
    }
}

struct AcquiredPackage {
    path: PathBuf,
    provider: ProviderPackageRef,
    runs_code: Vec<crate::RecompExecution>,
}

fn review_native_requirements(
    recipe: &ProfileRecipe,
    layout: &crate::profile_deploy::Layout,
    game: &str,
    runtime: &str,
    acquired: &BTreeMap<String, AcquiredPackage>,
) -> Result<()> {
    let builtin = layout.recomp_builtins();
    let mut enabled = BTreeMap::new();
    for package in &recipe.packages {
        let retained = layout.package(&package.sha256, &package.native_id);
        let path = acquired
            .get(&package.native_id)
            .map(|package| package.path.as_path())
            .unwrap_or(&retained);
        let exact = crate::inspect_recomp_mod(path, game)?;
        if exact.sha256 != package.sha256
            || exact.size != package.size
            || package.native_id != format!("{}.nrm", exact.native_id)
            || exact.game_id != game
        {
            return Err(PortcoveError::verification(
                "the recipe package changed during native review",
            )
            .detail("package", &package.native_id));
        }
        let declared = exact
            .dependencies
            .iter()
            .filter(|item| {
                !matches!(item.id.as_str(), "." | "*") && !builtin.contains(&item.id.as_str())
            })
            .map(|item| format!("{}.nrm", item.id))
            .collect::<BTreeSet<_>>();
        if package.requires.iter().cloned().collect::<BTreeSet<_>>() != declared {
            return Err(PortcoveError::conflict("the exact package declares different native requirements; export the complete setup again")
                .detail("package", &package.native_id));
        }
        if package.enabled {
            enabled.insert(exact.native_id.clone(), exact);
        }
    }
    crate::profile_loader::validate_recomp_versions(
        &enabled,
        runtime.strip_prefix('v').unwrap_or(runtime),
        builtin,
    )
}

fn reviewed_origin<'a>(
    plan: &'a crate::ProviderInstallPlan,
    native_id: &str,
) -> Result<(&'a ProviderPackageRef, Vec<crate::ProviderRequirement>)> {
    let mut reviewed = crate::provider_install::wrapper_members(plan, &[])?;
    if plan.provider.provider == crate::thunderstore::PROVIDER {
        let origin = reviewed.remove(native_id).ok_or_else(|| {
            PortcoveError::verification("the exact provider closure has no such native package")
                .detail("package", native_id)
        })?;
        Ok((origin.provider, origin.requirements))
    } else {
        Ok((&plan.provider, Vec::new()))
    }
}

/// How much of a staged acquisition a check reads.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Depth {
    /// Identity, plan digest, presence and exact size. Used between review
    /// steps, so each step's work stays proportional to the step itself.
    Recorded,
    /// Also the exact bytes and native content. Used when a step is staged and
    /// by apply, which is the authority for what the new setup contains.
    Content,
}

/// A staged step: reused by digest from a plan the review already holds, or a
/// newly staged plan.
enum AcquiredStep {
    Reused { plan_sha256: String },
    Staged(crate::ProviderInstallPlan),
}

/// Refreshes a staging directory's age so age-based pruning keeps a review
/// that is still being used. Best effort: pruning only causes a re-download.
pub(crate) fn touch_directory(path: &Path) {
    set_directory_modified(path, std::time::SystemTime::now());
}

pub(crate) fn set_directory_modified(path: &Path, modified: std::time::SystemTime) {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // A directory handle needs backup semantics; writing its times needs
        // FILE_WRITE_ATTRIBUTES.
        options.custom_flags(0x0200_0000).access_mode(0x0100);
    }
    if let Ok(directory) = options.open(path) {
        let _ = directory.set_modified(modified);
    }
}

fn verify_steps<'a>(
    catalog: &crate::Catalog,
    recipe: &ProfileRecipe,
    layout: &crate::profile_deploy::Layout,
    steps: impl IntoIterator<Item = (&'a str, &'a crate::ProviderInstallPlan)>,
    depth: Depth,
) -> Result<BTreeMap<String, AcquiredPackage>> {
    use crate::provider_install::{ProviderInstallMode, digest};
    let steps = steps.into_iter().collect::<Vec<_>>();
    // One acquisition per recipe package: the recipe's own package bound is
    // the only count bound. Bytes are admitted by free space when staged.
    if steps.len() > recipe.packages.len() {
        return Err(PortcoveError::usage(
            "the review has more provider files than the recipe has packages",
        ));
    }
    let mut verified = BTreeMap::new();
    // Steps of one closure share a provider plan; check each plan's digest once.
    let mut digested = BTreeSet::new();
    let packages = recipe
        .packages
        .iter()
        .map(|item| (item.native_id.as_str(), item))
        .collect::<BTreeMap<_, _>>();
    for (native_id, plan) in steps {
        let package = packages.get(native_id).copied();
        let (origin, exact_requirements) = reviewed_origin(plan, native_id)?;
        let reference = package.and_then(|package| package.provider.as_ref());
        let identity = reference
            .and_then(|provider| plannable_provider_file(catalog, &recipe.port_id, provider));
        let agrees = reference
            .zip(identity)
            .is_some_and(|(reference, (_, project, file))| {
                origin.provider == reference.provider
                    && catalog.port(&recipe.port_id).is_ok_and(|port| {
                        crate::provider_binding::reference_matches(port, origin)
                            && crate::provider_binding::reference_matches(port, &plan.provider)
                            && plan.wrappers.iter().all(|wrapper| {
                                wrapper.provider.provider == plan.provider.provider
                                    && crate::provider_binding::reference_matches(
                                        port,
                                        &wrapper.provider,
                                    )
                            })
                    })
                    && origin.project == project
                    && origin.file.as_deref() == Some(file.as_str())
                    && reference
                        .version
                        .as_ref()
                        .is_none_or(|version| origin.version.as_ref() == Some(version))
            });
        // Identity binding: steps are only ever staged and recorded under this
        // recipe's identity directory, and single-package inputs are checked
        // against it when collected (`RecipeStaging::from_acquisitions`).
        if !agrees
            || plan.port_id != recipe.port_id
            || (!digested.contains(plan.plan_sha256.as_str()) && digest(plan)? != plan.plan_sha256)
            || verified.contains_key(native_id)
        {
            return Err(PortcoveError::conflict(
                "the provider review does not match this exact recipe",
            ));
        }
        digested.insert(plan.plan_sha256.as_str());
        let package =
            package.ok_or_else(|| PortcoveError::conflict("the recipe package changed"))?;
        if exact_requirements != package.provider_requires {
            return Err(PortcoveError::conflict(
                "the provider file declares different exact requirements. Use a recipe exported with the complete provider closure.",
            )
            .detail("package", &package.native_id));
        }
        let member = plan
            .members
            .iter()
            .find(|member| {
                member.file_name == package.native_id
                    && member.sha256 == package.sha256
                    && member.size == package.size
            })
            .ok_or_else(|| {
                PortcoveError::verification(
                    "the provider file does not contain the exact recipe package",
                )
                .detail("package", &package.native_id)
            })?;
        let path = ProviderInstallMode::Recipe {
            identity: &recipe.identity_sha256,
            install_id: None,
        }
        .staging(layout, &plan.plan_sha256)
        .join(&package.native_id);
        let present = match depth {
            Depth::Recorded => {
                crate::path::refuse_symlink_ancestors(&path).is_ok()
                    && fs::symlink_metadata(&path)
                        .is_ok_and(|entry| entry.is_file() && entry.len() == package.size)
            }
            Depth::Content => matches_exact_package(&path, package),
        };
        if !present {
            return Err(PortcoveError::conflict(
                "the private package changed or was discarded; review it again",
            )
            .detail("package", &package.native_id));
        }
        if depth == Depth::Recorded {
            verified.insert(
                package.native_id.clone(),
                AcquiredPackage {
                    path,
                    provider: origin.clone(),
                    runs_code: member.runs_code.clone(),
                },
            );
            continue;
        }
        // The plan is input. Recheck actual code facts from its exact staged bytes.
        let runs_code = if let Some(game) = layout.recomp_game() {
            let observed = crate::inspect_recomp_mod(&path, game)?;
            if observed.sha256 != package.sha256
                || package.native_id != format!("{}.nrm", observed.native_id)
                || package
                    .native_version
                    .as_ref()
                    .is_some_and(|version| version != &observed.native_version)
                || observed.holds.contains(&crate::RecompModHold::OtherGame)
                || observed.execution != member.runs_code
            {
                return Err(PortcoveError::verification(
                    "the package no longer matches its reviewed native identity or code",
                ));
            }
            crate::profile_deploy::require_admissible_code(&observed)?;
            observed.execution
        } else {
            let observed = crate::inspect_asset_archive(&path)?;
            if observed.sha256 != package.sha256
                || !observed.holds.is_empty()
                || !member.runs_code.is_empty()
            {
                return Err(PortcoveError::verification(
                    "the package no longer matches its reviewed asset content",
                ));
            }
            Vec::new()
        };
        verified.insert(
            package.native_id.clone(),
            AcquiredPackage {
                path,
                provider: origin.clone(),
                runs_code,
            },
        );
    }
    Ok(verified)
}

/// What the imported revision's recipe-derived content occupies. The rest of
/// a revision (build identity, originals, save group) has fixed small size.
fn encoded_setup_bytes(recipe: &ProfileRecipe) -> Result<usize> {
    let packages = recipe
        .packages
        .iter()
        .map(|package| crate::ResolvedPackage {
            native_id: package.native_id.clone(),
            native_version: package.native_version.clone(),
            provider: package.provider.clone(),
            sha256: package.sha256.clone(),
            size: package.size,
            enabled: package.enabled,
            requires: package.requires.clone(),
            provider_requires: package.provider_requires.clone(),
        })
        .collect::<Vec<_>>();
    let settings = recomp_mod_settings::import(&recipe.settings)?;
    Ok(serde_json::to_vec(&(&packages, &recipe.orderings, &recipe.originals, &settings))?.len())
}

fn matches_exact_package(path: &Path, package: &RecipePackage) -> bool {
    crate::external_runtime::hash_stable_regular(path, package.size, &|| Ok(()))
        .is_ok_and(|(digest, size)| size == package.size && digest == package.sha256)
}

fn publish_acquired_package(
    layout: &crate::profile_deploy::Layout,
    package: &RecipePackage,
    private: &Path,
) -> Result<()> {
    let destination = layout.package(&package.sha256, &package.native_id);
    crate::path::refuse_symlink_ancestors(&destination)?;
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("package store path has no parent"))?;
    if destination.try_exists()? {
        if !matches_exact_package(&destination, package) {
            return Err(PortcoveError::verification(
                "the package store contains changed bytes at the exact identity",
            ));
        }
    } else {
        fs::create_dir_all(parent)?;
        crate::path::refuse_symlink_ancestors(&destination)?;
        let target = crate::durability::tempfile_destination(&destination)?;
        let mut temp = tempfile::NamedTempFile::new_in(
            target
                .parent()
                .ok_or_else(|| PortcoveError::state("package store path has no parent"))?,
        )?;
        crate::external_runtime::stream_single_link_metadata(
            private,
            package.size,
            &|| Ok(()),
            &mut |bytes| temp.as_file_mut().write_all(bytes).map_err(Into::into),
        )?;
        temp.as_file().sync_all()?;
        if !matches_exact_package(temp.path(), package) {
            return Err(PortcoveError::verification(
                "the acquired bytes changed while being stored",
            ));
        }
        temp.persist_noclobber(&target)
            .map_err(|error| error.error)?;
    }
    // A prior attempt may have stored the file before its directory flush failed.
    crate::durability::sync_publication(parent)?;
    crate::durability::sync_publication(&layout.store().join("packages"))?;
    crate::durability::sync_publication(&layout.store())
}

/// The provider project and file a recipe package names, when this game has a
/// reviewed binding for that provider and the reference is complete enough for
/// `provider-plan`.
fn plannable_provider_file(
    catalog: &crate::Catalog,
    port_id: &str,
    provider: &ProviderPackageRef,
) -> Option<(&'static str, String, String)> {
    let port = catalog.port(port_id).ok()?;
    if !crate::provider_binding::reference_matches(port, provider) {
        return None;
    }
    let binding = crate::provider_binding::reviewed_binding(port, &provider.provider)?;
    let bound = binding.provider();
    let label = binding.label();
    let file = provider.file.as_deref()?;
    // GameBanana IDs are numbers, named in their canonical form.
    if bound == crate::gamebanana::PROVIDER {
        let project = provider.project.parse::<u64>().ok()?;
        let file = file.parse::<u64>().ok()?;
        return Some((label, project.to_string(), file.to_string()));
    }
    let readable = |id: &str| {
        !id.is_empty()
            && id.len() <= 256
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    if !readable(&provider.project) || !readable(file) {
        return None;
    }
    Some((label, provider.project.clone(), file.to_owned()))
}

fn import_plan_digest(plan: &RecipeImportPlan) -> Result<String> {
    let mut copy = plan.clone();
    copy.plan_sha256.clear();
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&copy)?)))
}

fn require_import_plan_digest(plan: &RecipeImportPlan) -> Result<()> {
    if import_plan_digest(plan)? != plan.plan_sha256 {
        return Err(PortcoveError::conflict(
            "the import review changed; review the recipe again before approving it",
        ));
    }
    Ok(())
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
