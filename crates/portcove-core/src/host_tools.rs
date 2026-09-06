//! Fixed host-tool definitions and the shared environment/saved/discovery resolver.

use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    HostPreferenceStore, HostToolSource, HostToolState, HostToolStatus, Platform, PortcoveError,
    Result,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HostToolProbePolicy {
    pub arguments: Vec<String>,
    pub expected_output: String,
    pub timeout_millis: u64,
    pub max_output_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HostToolDefinition {
    pub id: String,
    pub display_name: String,
    pub configuration_variable: String,
    pub purpose: String,
    pub official_url: String,
    pub supported_platforms: Vec<Platform>,
    pub probe: HostToolProbePolicy,
}

pub fn definitions() -> Vec<HostToolDefinition> {
    let registry = fixed_definitions();
    debug_assert!(validate_definitions(&registry).is_ok());
    registry
}

fn fixed_definitions() -> Vec<HostToolDefinition> {
    let all = vec![
        Platform::WindowsX86_64,
        Platform::LinuxX86_64,
        Platform::MacosX86_64,
        Platform::MacosAarch64,
    ];
    vec![
        HostToolDefinition {
            id: "chdman".into(),
            display_name: "chdman".into(),
            configuration_variable: "PORTCOVE_CHDMAN".into(),
            purpose: "CHD validation and disc-image materialization".into(),
            official_url: "https://docs.mamedev.org/tools/chdman.html".into(),
            supported_platforms: all.clone(),
            probe: HostToolProbePolicy {
                arguments: vec!["-help".into()],
                expected_output: "chdman".into(),
                timeout_millis: 5_000,
                max_output_bytes: 64 * 1024,
            },
        },
        HostToolDefinition {
            id: "dolphin_tool".into(),
            display_name: "DolphinTool".into(),
            configuration_variable: "PORTCOVE_DOLPHIN_TOOL".into(),
            purpose: "compressed GameCube validation and ISO materialization".into(),
            official_url: "https://dolphin-emu.org/download/".into(),
            supported_platforms: all,
            probe: HostToolProbePolicy {
                arguments: vec!["--help".into()],
                expected_output: "DolphinTool".into(),
                timeout_millis: 5_000,
                max_output_bytes: 64 * 1024,
            },
        },
    ]
}

pub(crate) fn validate_definitions(registry: &[HostToolDefinition]) -> Result<()> {
    let expected = fixed_definitions();
    if registry.len() != expected.len() {
        return Err(PortcoveError::usage(format!(
            "host-tool registry must contain exactly {} reviewed definitions",
            expected.len()
        )));
    }

    let mut seen = std::collections::HashSet::new();
    for definition in registry {
        if !seen.insert(definition.id.as_str()) {
            return Err(PortcoveError::usage(format!(
                "duplicate host-tool ID: {}",
                definition.id
            )));
        }
        let reviewed = expected
            .iter()
            .find(|candidate| candidate.id == definition.id)
            .ok_or_else(|| {
                PortcoveError::usage(format!(
                    "unknown host-tool ID is not reviewed: {}",
                    definition.id
                ))
            })?;
        let url = reqwest::Url::parse(&definition.official_url).map_err(|error| {
            PortcoveError::usage(format!(
                "host-tool {} has an invalid official URL: {error}",
                definition.id
            ))
        })?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || definition.official_url != reviewed.official_url
        {
            return Err(PortcoveError::usage(format!(
                "host-tool {} official URL is not the reviewed HTTPS reference",
                definition.id
            )));
        }
        if definition.supported_platforms != reviewed.supported_platforms {
            return Err(PortcoveError::usage(format!(
                "host-tool {} has an unsupported platform policy",
                definition.id
            )));
        }
        if definition.probe != reviewed.probe {
            return Err(PortcoveError::usage(format!(
                "host-tool {} has an inconsistent probe definition",
                definition.id
            )));
        }
        if definition.display_name != reviewed.display_name
            || definition.configuration_variable != reviewed.configuration_variable
            || definition.purpose != reviewed.purpose
        {
            return Err(PortcoveError::usage(format!(
                "host-tool {} does not match its reviewed definition",
                definition.id
            )));
        }
    }
    Ok(())
}

pub fn definition(id: &str) -> Result<HostToolDefinition> {
    definitions()
        .into_iter()
        .find(|definition| definition.id == id)
        .ok_or_else(|| PortcoveError::usage(format!("unknown host tool: {id}")))
}

pub(crate) fn resolve(
    id: &str,
    candidates: Vec<PathBuf>,
    preferences: &HostPreferenceStore,
) -> Result<HostToolStatus> {
    let definition = definition(id)?;
    let configured = std::env::var_os(&definition.configuration_variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    resolve_with_environment(definition, candidates, preferences, configured)
}

fn resolve_with_environment(
    definition: HostToolDefinition,
    candidates: Vec<PathBuf>,
    preferences: &HostPreferenceStore,
    configured: Option<PathBuf>,
) -> Result<HostToolStatus> {
    let platform = Platform::current()?;
    if !definition.supported_platforms.contains(&platform) {
        return Ok(status(&definition, HostToolState::Unsupported, None, None));
    }
    if let Some(path) = configured {
        return Ok(status(
            &definition,
            if path.is_file() {
                HostToolState::Available
            } else {
                HostToolState::Misconfigured
            },
            Some(path),
            Some(HostToolSource::Environment),
        ));
    }
    if let Some(path) = preferences.host_tool_path(&definition.id)? {
        return Ok(status(
            &definition,
            if path.is_file() {
                HostToolState::Available
            } else {
                HostToolState::Misconfigured
            },
            Some(path),
            Some(HostToolSource::Saved),
        ));
    }
    let path = candidates.into_iter().find(|candidate| candidate.is_file());
    let source = path.as_ref().map(|_| HostToolSource::Discovery);
    Ok(status(
        &definition,
        if path.is_some() {
            HostToolState::Available
        } else {
            HostToolState::Missing
        },
        path,
        source,
    ))
}

pub(crate) fn require_path(status: &HostToolStatus, searched: &[PathBuf]) -> Result<PathBuf> {
    match status.state {
        HostToolState::Available => Ok(status.path.clone().expect("available tool has a path")),
        HostToolState::Misconfigured => Err(PortcoveError::source(format!(
            "{} does not point to a file: {}",
            status.configuration_variable,
            status
                .path
                .as_deref()
                .unwrap_or_else(|| Path::new(""))
                .display()
        ))
        .detail("tool_id", &status.id)
        .detail(
            "tool_path",
            status
                .path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
        )
        .detail(
            "setup_hint",
            format!(
                "select a valid {} executable or clear the explicit setting",
                status.display_name
            ),
        )),
        HostToolState::Missing => Err(PortcoveError::source(format!(
            "{} was not found; install it or select its full executable path",
            status.display_name
        ))
        .detail("tool_id", &status.id)
        .detail(
            "searched_paths",
            searched
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(";"),
        )
        .detail(
            "setup_hint",
            format!(
                "open {} or select the installed executable",
                status.official_url
            ),
        )),
        HostToolState::Unsupported => Err(PortcoveError::unsupported(format!(
            "{} is not supported on this platform",
            status.display_name
        ))),
    }
}

fn status(
    definition: &HostToolDefinition,
    state: HostToolState,
    path: Option<PathBuf>,
    source: Option<HostToolSource>,
) -> HostToolStatus {
    HostToolStatus {
        id: definition.id.clone(),
        display_name: definition.display_name.clone(),
        state,
        path,
        source,
        configuration_variable: definition.configuration_variable.clone(),
        purpose: definition.purpose.clone(),
        official_url: definition.official_url.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, fs};

    #[test]
    fn fixed_registry_has_unique_safe_complete_definitions() {
        let registry = definitions();
        let mut ids = HashSet::new();
        assert_eq!(registry.len(), 2);
        for definition in registry {
            assert!(ids.insert(definition.id.clone()));
            assert!(definition.official_url.starts_with("https://"));
            assert!(!definition.supported_platforms.is_empty());
            assert!(!definition.probe.arguments.is_empty());
            assert!(
                definition
                    .probe
                    .arguments
                    .iter()
                    .all(|argument| !argument.trim().is_empty())
            );
            assert!(definition.probe.timeout_millis <= 5_000);
            assert!(definition.probe.max_output_bytes <= 64 * 1024);
        }
        validate_definitions(&definitions()).unwrap();
        assert!(definition("unknown").is_err());
    }

    #[test]
    fn registry_validation_rejects_unreviewed_definitions() {
        let mut registry = definitions();
        registry[1].id = registry[0].id.clone();
        assert!(validate_definitions(&registry).is_err());

        let mut registry = definitions();
        registry[0].id = "unknown".into();
        assert!(validate_definitions(&registry).is_err());

        for url in [
            "http://docs.mamedev.org/tools/chdman.html",
            "https://example.invalid/chdman",
        ] {
            let mut registry = definitions();
            registry[0].official_url = url.into();
            assert!(validate_definitions(&registry).is_err());
        }

        let mut registry = definitions();
        registry[0].supported_platforms.pop();
        assert!(validate_definitions(&registry).is_err());

        let mut registry = definitions();
        registry[0].probe.arguments.clear();
        assert!(validate_definitions(&registry).is_err());
        let mut registry = definitions();
        registry[0].probe.expected_output.clear();
        assert!(validate_definitions(&registry).is_err());
        let mut registry = definitions();
        registry[0].probe.timeout_millis = 0;
        assert!(validate_definitions(&registry).is_err());
        let mut registry = definitions();
        registry[0].probe.max_output_bytes = 0;
        assert!(validate_definitions(&registry).is_err());
    }

    #[test]
    fn saved_path_precedes_discovery_and_invalid_saved_path_does_not_fall_back() {
        let temporary = tempfile::tempdir().unwrap();
        let store = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        let saved = temporary.path().join("saved-tool");
        let discovered = temporary.path().join("discovered-tool");
        fs::write(&saved, b"saved").unwrap();
        fs::write(&discovered, b"discovered").unwrap();
        store.set_host_tool_path("chdman", &saved).unwrap();
        let selected = resolve("chdman", vec![discovered.clone()], &store).unwrap();
        assert_eq!(selected.path.as_deref(), Some(saved.as_path()));
        assert_eq!(selected.source, Some(HostToolSource::Saved));

        fs::remove_file(&saved).unwrap();
        let invalid = resolve("chdman", vec![discovered], &store).unwrap();
        assert_eq!(invalid.state, HostToolState::Misconfigured);
        assert_eq!(invalid.source, Some(HostToolSource::Saved));
    }

    #[test]
    fn environment_path_precedes_saved_and_invalid_environment_does_not_fall_back() {
        let temporary = tempfile::tempdir().unwrap();
        let store = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        let saved = temporary.path().join("saved-tool");
        let environment = temporary.path().join("environment-tool");
        fs::write(&saved, b"saved").unwrap();
        fs::write(&environment, b"environment").unwrap();
        store.set_host_tool_path("chdman", &saved).unwrap();
        let selected = resolve_with_environment(
            definition("chdman").unwrap(),
            Vec::new(),
            &store,
            Some(environment.clone()),
        )
        .unwrap();
        assert_eq!(selected.path.as_deref(), Some(environment.as_path()));
        assert_eq!(selected.source, Some(HostToolSource::Environment));

        fs::remove_file(&environment).unwrap();
        let invalid = resolve_with_environment(
            definition("chdman").unwrap(),
            Vec::new(),
            &store,
            Some(environment),
        )
        .unwrap();
        assert_eq!(invalid.state, HostToolState::Misconfigured);
        assert_eq!(invalid.source, Some(HostToolSource::Environment));
    }

    #[test]
    fn discovery_and_missing_results_are_structured() {
        let temporary = tempfile::tempdir().unwrap();
        let store = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        let discovered = temporary.path().join("DolphinTool");
        fs::write(&discovered, b"tool").unwrap();
        let available = resolve("dolphin_tool", vec![discovered.clone()], &store).unwrap();
        assert_eq!(available.path.as_deref(), Some(discovered.as_path()));
        assert_eq!(available.source, Some(HostToolSource::Discovery));
        let missing = resolve(
            "dolphin_tool",
            vec![temporary.path().join("missing")],
            &store,
        )
        .unwrap();
        assert_eq!(missing.state, HostToolState::Missing);
        assert_eq!(missing.source, None);
    }
}
