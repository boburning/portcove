//! The reviewed portable subset of Recomp's per-mod native configuration.
//! The exact package declares the meaning and range of each portable option.
//! Free-form strings may contain local data and stay in the mutable file.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Number, Value, json};

use crate::{
    PortcoveError, ProfileRevision, ResolvedPackage, Result, durability, game_settings::document,
    path, profile_deploy::Layout, recomp_mod,
};

const NAMESPACE: &str = "recomp-config/";
const MAX_CONFIG_BYTES: u64 = 128 * 1024;
const MAX_CHOICE_BYTES: usize = 256;
const MAX_OPTION_ID_BYTES: usize = 64;
const MAX_CAPTURED_SETTINGS: usize = crate::profile::MAX_SETTINGS;

enum OptionRule {
    Enum(Vec<String>),
    Number { min: f64, max: f64 },
}

struct PortableOption {
    default: Value,
    rule: OptionRule,
}

impl OptionRule {
    fn resolve(&self, value: &Value) -> Option<Value> {
        match self {
            Self::Enum(choices) => value
                .as_str()
                .filter(|value| choices.iter().any(|item| item == value))
                .map(|value| Value::String(value.to_owned())),
            Self::Number { min, max } => value
                .as_f64()
                .filter(|value| value >= min && value <= max)
                .and_then(Number::from_f64)
                .map(Value::Number),
        }
    }
}

fn portable_options(manifest: &Value) -> Result<BTreeMap<String, PortableOption>> {
    let mut result = BTreeMap::new();
    let Some(options) = manifest
        .get("config_schema")
        .and_then(|schema| schema.get("options"))
        .and_then(Value::as_array)
    else {
        return Ok(result);
    };
    let mut visited = std::collections::BTreeSet::new();
    for option in options {
        let id = option["id"].as_str().unwrap_or_default();
        if !visited.insert(id) {
            return Err(PortcoveError::conflict(
                "the mod declares the same configuration option more than once",
            )
            .detail("option", id));
        }
        if id.is_empty()
            || id.len() > MAX_OPTION_ID_BYTES
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            continue;
        }
        let rule = match option["type"].as_str() {
            Some("Enum") => {
                let Some(choices) = option["options"].as_array().and_then(|choices| {
                    choices
                        .iter()
                        .map(|choice| {
                            choice.as_str().filter(|choice| {
                                !choice.is_empty()
                                    && choice.len() <= MAX_CHOICE_BYTES
                                    && !choice.chars().any(char::is_control)
                                    && !choice.contains(['/', '\\', ':'])
                            })
                        })
                        .collect::<Option<Vec<_>>>()
                }) else {
                    continue;
                };
                OptionRule::Enum(choices.into_iter().map(str::to_owned).collect())
            }
            Some("Number") => {
                let (Some(min), Some(max)) = (option["min"].as_f64(), option["max"].as_f64())
                else {
                    continue;
                };
                OptionRule::Number { min, max }
            }
            _ => continue,
        };
        if let Some(default) = rule.resolve(&option["default"]) {
            result.insert(id.to_owned(), PortableOption { default, rule });
        }
    }
    Ok(result)
}

struct PackageSettings {
    id: String,
    version: String,
    options: BTreeMap<String, PortableOption>,
}

fn package_settings(
    layout: &Layout,
    game: &str,
    package: &ResolvedPackage,
) -> Result<PackageSettings> {
    let path = layout.package(&package.sha256, &package.native_id);
    package_settings_at(
        &path,
        game,
        &package.native_id,
        &package.sha256,
        package.size,
    )
}

fn package_settings_at(
    path: &Path,
    game: &str,
    native_id: &str,
    sha256: &str,
    size: u64,
) -> Result<PackageSettings> {
    path::refuse_symlink_ancestors(path)?;
    if !fs::symlink_metadata(path).is_ok_and(|entry| entry.is_file() && entry.len() == size) {
        return Err(
            PortcoveError::conflict("the exact mod package is unavailable")
                .detail("mod", native_id),
        );
    }
    let (inspection, manifest) = recomp_mod::inspect_with_manifest(path, game)?;
    if inspection.sha256 != sha256
        || inspection.game_id != game
        || format!("{}.nrm", inspection.native_id) != native_id
    {
        return Err(
            PortcoveError::conflict("the exact mod package changed").detail("mod", native_id)
        );
    }
    Ok(PackageSettings {
        id: inspection.native_id,
        version: inspection.native_version,
        options: portable_options(&manifest)?,
    })
}

fn config_path(user: &Path, id: &str) -> PathBuf {
    user.join("mod_config").join(format!("{id}.json"))
}

fn read_config(path: &Path, id: &str) -> Result<Option<Value>> {
    if let Some(value) = read_config_file(path, id)? {
        return Ok(Some(value));
    }
    read_config_file(&path.with_extension("json.bak"), id)
}

fn read_config_file(path: &Path, id: &str) -> Result<Option<Value>> {
    path::refuse_symlink_ancestors(path)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(entry) if !entry.is_file() || entry.len() > MAX_CONFIG_BYTES => {
            return Err(PortcoveError::conflict(
                "the mod configuration is not a bounded regular file",
            )
            .detail("mod", id));
        }
        Ok(_) => {}
    }
    let bytes = crate::external_runtime::read_stable_metadata(path, MAX_CONFIG_BYTES)?;
    let data = std::str::from_utf8(&bytes).map_err(|_| {
        PortcoveError::conflict("the mod configuration needs to be UTF-8").detail("mod", id)
    })?;
    let value = document::json_document(data)?;
    if value["mod_id"].as_str() != Some(id)
        || (!value["storage"].is_object() && !value["storage"].is_null())
    {
        return Err(
            PortcoveError::conflict("the mod configuration needs review").detail("mod", id),
        );
    }
    Ok(Some(value))
}

fn mod_prefix(id: &str) -> String {
    format!("{NAMESPACE}{id}/")
}

fn package_prefix(id: &str, sha256: &str) -> String {
    format!("{}{sha256}/", mod_prefix(id))
}

/// Captures supported choices while leaving other settings and files untouched.
pub(crate) fn capture(
    user: &Path,
    layout: &Layout,
    game: &str,
    revision: &ProfileRevision,
) -> Result<BTreeMap<String, String>> {
    let mut settings = revision.settings.clone();
    for package in revision.packages.iter().filter(|package| package.enabled) {
        let native = package_settings(layout, game, package)?;
        let mod_prefix = mod_prefix(&native.id);
        settings.retain(|option, _| !option.starts_with(&mod_prefix));
        if native.options.is_empty() {
            continue;
        }
        let config = read_config(&config_path(user, &native.id), &native.id)?;
        let prefix = package_prefix(&native.id, &package.sha256);
        for (id, option) in native.options {
            let recorded = config
                .as_ref()
                .and_then(|document| document["storage"].get(&id));
            let value = match recorded {
                Some(value) => option.rule.resolve(value).ok_or_else(|| {
                    PortcoveError::conflict("an edited mod setting is outside its declared choices")
                        .detail("mod", &native.id)
                        .detail("option", &id)
                })?,
                None => option.default,
            };
            settings.insert(format!("{prefix}{id}"), value.to_string());
        }
        if settings.len() > MAX_CAPTURED_SETTINGS {
            return Err(PortcoveError::unsupported(
                "this setup exceeds the supported captured mod settings limit",
            ));
        }
    }
    Ok(settings)
}

/// Validate the exact target and prepare edits to only recorded known keys.
fn projection(
    user: &Path,
    layout: &Layout,
    game: &str,
    revision: &ProfileRevision,
) -> Result<Vec<(PathBuf, Vec<u8>)>> {
    let mut writes = Vec::new();
    for package in revision.packages.iter().filter(|package| package.enabled) {
        let Some(id) = package.native_id.strip_suffix(".nrm") else {
            continue;
        };
        let prefix = package_prefix(id, &package.sha256);
        if !revision
            .settings
            .keys()
            .any(|option| option.starts_with(&prefix))
        {
            continue;
        }
        let native = package_settings(layout, game, package)?;
        let destination = config_path(user, &native.id);
        let old = read_config(&destination, &native.id)?;
        let mut next = old.clone().unwrap_or_else(
            || json!({ "mod_id": native.id, "mod_version": native.version, "storage": {} }),
        );
        if !next["storage"].is_object() {
            next["storage"] = Value::Object(Map::new());
        }
        let storage = next["storage"]
            .as_object_mut()
            .ok_or_else(|| PortcoveError::state("the mod configuration has no storage object"))?;
        for (name, raw) in revision.settings.range(prefix.clone()..) {
            let Some(option) = name.strip_prefix(&prefix) else {
                break;
            };
            let rule = native.options.get(option).ok_or_else(|| {
                PortcoveError::conflict("the target mod does not declare this saved setting")
                    .detail("mod", &native.id)
                    .detail("option", option)
            })?;
            let wanted = serde_json::from_str(raw)
                .ok()
                .and_then(|value| rule.rule.resolve(&value))
                .ok_or_else(|| {
                    PortcoveError::conflict(
                        "the saved mod setting is invalid for this exact package",
                    )
                    .detail("mod", &native.id)
                    .detail("option", option)
                })?;
            storage.insert(option.to_owned(), wanted);
        }
        if old.as_ref() != Some(&next) {
            let bytes = serde_json::to_vec_pretty(&next)?;
            if bytes.len() as u64 > MAX_CONFIG_BYTES {
                return Err(PortcoveError::conflict(
                    "the resulting mod configuration is too large",
                )
                .detail("mod", &native.id));
            }
            writes.push((destination, bytes));
        }
    }
    Ok(writes)
}

pub(crate) fn review_projection(
    user: &Path,
    layout: &Layout,
    game: &str,
    revision: &ProfileRevision,
) -> Result<()> {
    projection(user, layout, game, revision).map(|_| ())
}

pub(crate) fn project(
    user: &Path,
    layout: &Layout,
    game: &str,
    revision: &ProfileRevision,
) -> Result<()> {
    for (destination, bytes) in projection(user, layout, game, revision)? {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        durability::write_bytes_atomically(&destination, &bytes, true)?;
    }
    Ok(())
}

pub(crate) fn review_recovery(
    layout: &Layout,
    game: &str,
    current: &ProfileRevision,
    target: &ProfileRevision,
) -> Result<()> {
    let unsupported = |name: &str| !name.starts_with(NAMESPACE);
    if !current
        .settings
        .iter()
        .filter(|(name, _)| unsupported(name))
        .eq(target.settings.iter().filter(|(name, _)| unsupported(name)))
    {
        return Err(PortcoveError::unsupported(
            "This setup records a different setting that Portcove cannot restore.",
        ));
    }
    for package in target.packages.iter().filter(|package| package.enabled) {
        let native = package_settings(layout, game, package)?;
        let prefix = package_prefix(&native.id, &package.sha256);
        if let Some(option) = native
            .options
            .keys()
            .find(|option| !target.settings.contains_key(&format!("{prefix}{option}")))
        {
            return Err(PortcoveError::unsupported(
                "This earlier setup did not capture all supported settings for the retained package. Choose a revision that recorded them.",
            )
            .detail("mod", &native.id)
            .detail("option", option));
        }
    }
    // Validate the proposed values against the retained package, without
    // reading or updating the live document until the journaled action.
    export(layout, game, target)?;
    Ok(())
}

/// Exactly one reviewed, manifest-declared option in a shareable recipe.
#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(deny_unknown_fields)]
pub struct RecipeModSetting {
    pub native_id: String,
    pub package_sha256: String,
    pub option_id: String,
    pub value: RecipeModSettingValue,
}

#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(untagged)]
pub enum RecipeModSettingValue {
    Number(Number),
    Choice(String),
}

impl RecipeModSetting {
    fn key(&self) -> String {
        format!(
            "{}{}",
            package_prefix(
                self.native_id.strip_suffix(".nrm").unwrap_or_default(),
                &self.package_sha256,
            ),
            self.option_id
        )
    }

    pub(crate) fn validates_shape(&self) -> bool {
        let option = &self.option_id;
        !option.is_empty()
            && option.len() <= MAX_OPTION_ID_BYTES
            && option
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            && match &self.value {
                RecipeModSettingValue::Number(number) => {
                    number.as_f64().is_some_and(f64::is_finite)
                }
                RecipeModSettingValue::Choice(value) => {
                    !value.is_empty()
                        && value.len() <= MAX_CHOICE_BYTES
                        && !value.chars().any(char::is_control)
                        && !value.contains(['/', '\\', ':'])
                }
            }
    }
}

pub(crate) fn export(
    layout: &Layout,
    game: &str,
    revision: &ProfileRevision,
) -> Result<Vec<RecipeModSetting>> {
    let mut exported = Vec::new();
    for package in revision.packages.iter().filter(|package| package.enabled) {
        let Some(id) = package.native_id.strip_suffix(".nrm") else {
            continue;
        };
        let prefix = package_prefix(id, &package.sha256);
        if !revision.settings.keys().any(|key| key.starts_with(&prefix)) {
            continue;
        }
        let native = package_settings(layout, game, package)?;
        for (key, raw) in revision.settings.range(prefix.clone()..) {
            let Some(option) = key.strip_prefix(&prefix) else {
                break;
            };
            let value = native
                .options
                .get(option)
                .and_then(|rule| {
                    serde_json::from_str(raw)
                        .ok()
                        .and_then(|value| rule.rule.resolve(&value))
                })
                .ok_or_else(|| {
                    PortcoveError::conflict("a saved setting does not match its exact mod package")
                        .detail("mod", &package.native_id)
                        .detail("option", option)
                })?;
            let value = serde_json::from_value(value)?;
            exported.push(RecipeModSetting {
                native_id: package.native_id.clone(),
                package_sha256: package.sha256.clone(),
                option_id: option.to_owned(),
                value,
            });
        }
    }
    Ok(exported)
}

pub(crate) fn import(settings: &[RecipeModSetting]) -> Result<BTreeMap<String, String>> {
    settings
        .iter()
        .map(|setting| Ok((setting.key(), serde_json::to_string(&setting.value)?)))
        .collect()
}

pub(crate) fn validate_portable<'a>(
    layout: &Layout,
    game: &str,
    recipe: &crate::ProfileRecipe,
    staged: impl Fn(&str) -> Option<&'a Path>,
) -> Result<()> {
    for package in &recipe.packages {
        let selected = recipe
            .settings
            .iter()
            .filter(|setting| setting.native_id == package.native_id);
        if selected.clone().next().is_none() {
            continue;
        }
        let retained = layout.package(&package.sha256, &package.native_id);
        let path = staged(&package.native_id).unwrap_or(&retained);
        let native = package_settings_at(
            path,
            game,
            &package.native_id,
            &package.sha256,
            package.size,
        )?;
        for setting in selected {
            let value = serde_json::to_value(&setting.value)?;
            if native
                .options
                .get(&setting.option_id)
                .and_then(|rule| rule.rule.resolve(&value))
                .is_none()
            {
                return Err(PortcoveError::conflict(
                    "the exact package does not allow a recipe setting",
                )
                .detail("mod", &package.native_id)
                .detail("option", &setting.option_id));
            }
        }
    }
    Ok(())
}
