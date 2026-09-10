//! Version negotiation for implemented engine templates, independent of admission.
use std::{collections::HashSet, path::Path};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{AdapterKind, PortcoveError, Result};

const REQUIREMENT_FORMAT: u32 = 1;
const MAX_REQUIREMENT_BYTES: u64 = 64 * 1024;
const MAX_REQUIREMENTS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EngineTemplateCapability {
    pub template: AdapterKind,
    pub contract_version: u32,
}

impl EngineTemplateCapability {
    pub fn current() -> Vec<Self> {
        AdapterKind::ALL
            .into_iter()
            .map(|template| Self {
                template,
                contract_version: 1,
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DefinitionCapabilityRequirement {
    pub template: String,
    pub minimum_version: u32,
    pub maximum_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DefinitionCapabilityRequest {
    pub capability_contract_schema: u32,
    pub required_capabilities: Vec<DefinitionCapabilityRequirement>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionCapabilityOutcome {
    Supported,
    UnsupportedTemplate,
    UnsupportedVersion,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DefinitionCapabilityResult {
    pub requirement: DefinitionCapabilityRequirement,
    pub installed_version: Option<u32>,
    pub outcome: DefinitionCapabilityOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DefinitionCapabilityReport {
    pub capability_contract_schema: u32,
    pub compatible: bool,
    pub checks: Vec<DefinitionCapabilityResult>,
}

/// Read only the selected bounded file; do not open a library or establish trust.
pub fn inspect_definition_capabilities(path: &Path) -> Result<DefinitionCapabilityReport> {
    let bytes = crate::path::read_bounded_regular(path, MAX_REQUIREMENT_BYTES)?;
    let request: DefinitionCapabilityRequest = serde_json::from_slice(&bytes)?;
    check_definition_capabilities(&request)
}

/// Check installed template versions. This is not definition or operation admission.
pub fn check_definition_capabilities(
    request: &DefinitionCapabilityRequest,
) -> Result<DefinitionCapabilityReport> {
    if request.capability_contract_schema != REQUIREMENT_FORMAT {
        return Err(PortcoveError::unsupported(
            "unsupported definition capability contract",
        ));
    }
    if request.required_capabilities.is_empty()
        || request.required_capabilities.len() > MAX_REQUIREMENTS
    {
        return Err(PortcoveError::usage(
            "definition capability requirements must contain between 1 and 64 entries",
        ));
    }
    let supported = EngineTemplateCapability::current();
    let mut identities = HashSet::new();
    let mut checks = Vec::with_capacity(request.required_capabilities.len());
    for requirement in &request.required_capabilities {
        if requirement.template.is_empty()
            || requirement.template.len() > 255
            || !requirement
                .template
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || requirement.minimum_version == 0
            || requirement.minimum_version > requirement.maximum_version
        {
            return Err(PortcoveError::usage(
                "invalid definition capability requirement",
            ));
        }
        if !identities.insert(&requirement.template) {
            return Err(PortcoveError::conflict(
                "duplicate definition capability requirement",
            ));
        }
        let template = serde_json::from_value::<AdapterKind>(serde_json::Value::String(
            requirement.template.clone(),
        ))
        .ok();
        let installed_version = supported
            .iter()
            .find(|entry| Some(entry.template) == template)
            .map(|entry| entry.contract_version);
        let outcome = match installed_version {
            None => DefinitionCapabilityOutcome::UnsupportedTemplate,
            Some(version)
                if version < requirement.minimum_version
                    || version > requirement.maximum_version =>
            {
                DefinitionCapabilityOutcome::UnsupportedVersion
            }
            Some(_) => DefinitionCapabilityOutcome::Supported,
        };
        checks.push(DefinitionCapabilityResult {
            requirement: requirement.clone(),
            installed_version,
            outcome,
        });
    }
    Ok(DefinitionCapabilityReport {
        capability_contract_schema: REQUIREMENT_FORMAT,
        compatible: checks
            .iter()
            .all(|check| check.outcome == DefinitionCapabilityOutcome::Supported),
        checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        template: &str,
        minimum_version: u32,
        maximum_version: u32,
    ) -> DefinitionCapabilityRequest {
        DefinitionCapabilityRequest {
            capability_contract_schema: 1,
            required_capabilities: vec![DefinitionCapabilityRequirement {
                template: template.into(),
                minimum_version,
                maximum_version,
            }],
        }
    }

    #[test]
    fn every_installed_template_negotiates_its_exact_version() {
        for installed in EngineTemplateCapability::current() {
            let template = serde_json::to_value(installed.template).unwrap();
            let report =
                check_definition_capabilities(&request(template.as_str().unwrap(), 1, 1)).unwrap();
            assert!(report.compatible);
            assert_eq!(
                report.checks[0].installed_version,
                Some(installed.contract_version)
            );
        }
    }

    #[test]
    fn mixed_requirements_keep_independent_template_and_version_outcomes() {
        let mut input = request("n64-recomp-portable", 1, 2);
        input
            .required_capabilities
            .extend(request("generated-cache", 2, 2).required_capabilities);
        input
            .required_capabilities
            .extend(request("future-template", 1, 1).required_capabilities);
        let report = check_definition_capabilities(&input).unwrap();
        assert!(!report.compatible);
        assert_eq!(
            report
                .checks
                .iter()
                .map(|check| check.outcome)
                .collect::<Vec<_>>(),
            vec![
                DefinitionCapabilityOutcome::Supported,
                DefinitionCapabilityOutcome::UnsupportedVersion,
                DefinitionCapabilityOutcome::UnsupportedTemplate
            ]
        );
        assert_eq!(report.checks[1].installed_version, Some(1));
        assert_eq!(report.checks[2].installed_version, None);
    }

    #[test]
    fn malformed_duplicate_and_unsupported_requests_do_not_negotiate() {
        for input in [
            request("", 1, 1),
            request("n64-recomp-portable", 0, 1),
            request("n64-recomp-portable", 2, 1),
            request("Template", 1, 1),
        ] {
            assert!(check_definition_capabilities(&input).is_err());
        }
        let mut input = request("n64-recomp-portable", 1, 1);
        input
            .required_capabilities
            .push(input.required_capabilities[0].clone());
        assert!(check_definition_capabilities(&input).is_err());
        input.required_capabilities.clear();
        assert!(check_definition_capabilities(&input).is_err());
        let mut input = request("n64-recomp-portable", 1, 1);
        input.capability_contract_schema = 2;
        assert!(check_definition_capabilities(&input).is_err());
        let oversized = DefinitionCapabilityRequest {
            capability_contract_schema: 1,
            required_capabilities: (0..65)
                .map(|index| {
                    request(&format!("template-{index}"), 1, 1)
                        .required_capabilities
                        .remove(0)
                })
                .collect(),
        };
        assert!(check_definition_capabilities(&oversized).is_err());
        assert!(check_definition_capabilities(&request(&"a".repeat(256), 1, 1)).is_err());
    }

    #[test]
    fn unknown_safety_fields_and_oversized_files_are_refused_without_library_state() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("requirements.json");
        let mut input = serde_json::to_value(request("n64-recomp-portable", 1, 1)).unwrap();
        input["publisher_approved"] = true.into();
        std::fs::write(&path, serde_json::to_vec(&input).unwrap()).unwrap();
        assert!(inspect_definition_capabilities(&path).is_err());
        input.as_object_mut().unwrap().remove("publisher_approved");
        input["required_capabilities"][0]["downloaded_implementation"] =
            "https://example.invalid/code".into();
        std::fs::write(&path, serde_json::to_vec(&input).unwrap()).unwrap();
        assert!(inspect_definition_capabilities(&path).is_err());
        std::fs::write(&path, vec![b' '; MAX_REQUIREMENT_BYTES as usize + 1]).unwrap();
        assert!(inspect_definition_capabilities(&path).is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
}
