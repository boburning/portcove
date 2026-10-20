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
        let mut supported: Vec<_> = AdapterKind::ALL
            .into_iter()
            .map(|template| Self {
                template,
                contract_version: 1,
            })
            .collect();
        supported.push(Self {
            template: AdapterKind::N64RecompPortable,
            contract_version: 2,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 2,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 3,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 4,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 5,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 6,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 7,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 8,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 9,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 10,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 11,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 12,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 13,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 14,
        });
        supported.push(Self {
            template: AdapterKind::StagedSourcePortable,
            contract_version: 15,
        });
        supported
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
    check_with_inventory(request, &EngineTemplateCapability::current())
}

fn check_with_inventory(
    request: &DefinitionCapabilityRequest,
    supported: &[EngineTemplateCapability],
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
            .filter(|entry| Some(entry.template) == template)
            .map(|entry| entry.contract_version)
            .filter(|version| {
                *version >= requirement.minimum_version && *version <= requirement.maximum_version
            })
            .max()
            .or_else(|| {
                supported
                    .iter()
                    .filter(|entry| Some(entry.template) == template)
                    .map(|entry| entry.contract_version)
                    .max()
            });
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
            let report = check_definition_capabilities(&request(
                template.as_str().unwrap(),
                installed.contract_version,
                installed.contract_version,
            ))
            .unwrap();
            assert!(report.compatible);
            assert_eq!(
                report.checks[0].installed_version,
                Some(installed.contract_version)
            );
        }
    }

    #[test]
    fn n64_windows_initial_renderer_preserves_v1_negotiation() {
        for template in ["n64-recomp-portable", "staged-source-portable"] {
            for (minimum, maximum, selected, compatible) in
                [(1, 1, 1, true), (2, 2, 2, true), (1, 2, 2, true)]
            {
                let report =
                    check_definition_capabilities(&request(template, minimum, maximum)).unwrap();
                assert_eq!(report.compatible, compatible);
                assert_eq!(report.checks[0].installed_version, Some(selected));
            }
        }
        let pairs: HashSet<_> = EngineTemplateCapability::current()
            .into_iter()
            .map(|entry| (entry.template, entry.contract_version))
            .collect();
        assert_eq!(pairs.len(), EngineTemplateCapability::current().len());
    }

    #[test]
    fn prepared_directory_version_does_not_widen_other_templates() {
        let previous: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| entry.contract_version <= 2)
            .collect();
        let unsupported =
            check_with_inventory(&request("staged-source-portable", 3, 3), &previous).unwrap();
        assert!(!unsupported.compatible);
        assert_eq!(
            unsupported.checks[0].outcome,
            DefinitionCapabilityOutcome::UnsupportedVersion
        );
        assert_eq!(unsupported.checks[0].installed_version, Some(2));
        let staged =
            check_definition_capabilities(&request("staged-source-portable", 3, 3)).unwrap();
        assert!(staged.compatible);
        assert_eq!(staged.checks[0].installed_version, Some(3));
        let n64 = check_definition_capabilities(&request("n64-recomp-portable", 3, 3)).unwrap();
        assert!(!n64.compatible);
        assert_eq!(n64.checks[0].installed_version, Some(2));
        let future =
            check_definition_capabilities(&request("staged-source-portable", 16, 16)).unwrap();
        assert!(!future.compatible);
    }

    #[test]
    fn narrow_windows_paths_require_v11_and_preserve_older_capabilities() {
        let requirement = request("staged-source-portable", 11, 11);
        assert!(
            check_definition_capabilities(&requirement)
                .unwrap()
                .compatible
        );
        let previous: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| {
                entry.template != AdapterKind::StagedSourcePortable || entry.contract_version < 11
            })
            .collect();
        let old = check_with_inventory(&requirement, &previous).unwrap();
        assert!(!old.compatible);
        assert_eq!(old.checks[0].installed_version, Some(10));
        assert_eq!(
            old.checks[0].outcome,
            DefinitionCapabilityOutcome::UnsupportedVersion
        );
    }

    #[test]
    fn fixed_source_builds_require_v9_and_preserve_older_capabilities() {
        let request = request("staged-source-portable", 9, 9);
        assert!(check_definition_capabilities(&request).unwrap().compatible);
        let previous: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| {
                entry.template != AdapterKind::StagedSourcePortable || entry.contract_version < 9
            })
            .collect();
        let old = check_with_inventory(&request, &previous).unwrap();
        assert!(!old.compatible);
        assert_eq!(
            old.checks[0].outcome,
            DefinitionCapabilityOutcome::UnsupportedVersion
        );
        assert_eq!(old.checks[0].installed_version, Some(8));
    }

    #[test]
    fn managed_preferences_require_v15_beyond_credential_only_v14() {
        let credential_only: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| {
                entry.template != AdapterKind::StagedSourcePortable || entry.contract_version <= 14
            })
            .collect();
        assert!(
            check_with_inventory(&request("staged-source-portable", 14, 14), &credential_only)
                .unwrap()
                .compatible
        );
        let refused =
            check_with_inventory(&request("staged-source-portable", 15, 15), &credential_only)
                .unwrap();
        assert!(!refused.compatible);
        assert_eq!(refused.checks[0].installed_version, Some(14));
        assert!(
            check_definition_capabilities(&request("staged-source-portable", 15, 15))
                .unwrap()
                .compatible
        );
    }

    #[test]
    fn runtime_credentials_require_v14_beyond_render96_only_v13() {
        let render96_only: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| {
                entry.template != AdapterKind::StagedSourcePortable || entry.contract_version <= 13
            })
            .collect();
        assert!(
            check_with_inventory(&request("staged-source-portable", 13, 13), &render96_only)
                .unwrap()
                .compatible
        );
        let refused =
            check_with_inventory(&request("staged-source-portable", 14, 14), &render96_only)
                .unwrap();
        assert!(!refused.compatible);
        assert_eq!(refused.checks[0].installed_version, Some(13));
        assert!(
            check_definition_capabilities(&request("staged-source-portable", 14, 14))
                .unwrap()
                .compatible
        );
    }

    #[test]
    fn render96_source_recipe_negotiates_v13_without_widening_existing_clients() {
        let required = request("staged-source-portable", 13, 13);
        assert!(check_definition_capabilities(&required).unwrap().compatible);
        let previous: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| {
                entry.template != AdapterKind::StagedSourcePortable || entry.contract_version < 13
            })
            .collect();
        let report = check_with_inventory(&required, &previous).unwrap();
        assert!(!report.compatible);
        assert_eq!(report.checks[0].installed_version, Some(12));
        assert!(
            check_with_inventory(&request("staged-source-portable", 12, 12), &previous)
                .unwrap()
                .compatible
        );
        assert!(
            check_with_inventory(&request("staged-source-portable", 11, 11), &previous)
                .unwrap()
                .compatible
        );
        assert!(
            check_with_inventory(&request("staged-source-portable", 9, 9), &previous)
                .unwrap()
                .compatible
        );
    }

    #[test]
    fn cartridge_build_preserves_v5_and_refuses_v5_readers() {
        let previous: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| entry.contract_version <= 5)
            .collect();
        let required = request("staged-source-portable", 6, 6);
        let old = check_with_inventory(&required, &previous).unwrap();
        assert!(!old.compatible);
        assert_eq!(old.checks[0].installed_version, Some(5));
        assert!(check_definition_capabilities(&required).unwrap().compatible);
        assert_eq!(
            check_definition_capabilities(&request("staged-source-portable", 5, 5))
                .unwrap()
                .checks[0]
                .installed_version,
            Some(5)
        );
        assert!(
            !check_definition_capabilities(&request("n64-recomp-portable", 6, 6))
                .unwrap()
                .compatible
        );
    }

    #[test]
    fn shared_preferences_require_v8_and_refuse_v7_readers() {
        let previous: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| entry.contract_version <= 7)
            .collect();
        let required = request("staged-source-portable", 8, 8);
        let old = check_with_inventory(&required, &previous).unwrap();
        assert!(!old.compatible);
        assert_eq!(old.checks[0].installed_version, Some(7));
        assert!(check_definition_capabilities(&required).unwrap().compatible);
        assert!(
            !check_definition_capabilities(&request("n64-recomp-portable", 8, 8))
                .unwrap()
                .compatible
        );
        assert!(
            check_definition_capabilities(&request("staged-source-portable", 7, 7))
                .unwrap()
                .compatible
        );
    }

    #[test]
    fn shared_smb_data_requires_v10_without_replacing_old_shared_preferences() {
        let previous: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| entry.contract_version <= 9)
            .collect();
        let required = request("staged-source-portable", 10, 10);
        let old = check_with_inventory(&required, &previous).unwrap();
        assert!(!old.compatible);
        assert_eq!(old.checks[0].installed_version, Some(9));
        assert!(check_definition_capabilities(&required).unwrap().compatible);
        assert!(
            check_definition_capabilities(&request("staged-source-portable", 8, 8))
                .unwrap()
                .compatible
        );
    }

    #[test]
    fn dr_mario_cartridge_version_refuses_v6_inventory_and_preserves_yoshi_v6() {
        let previous: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| entry.contract_version <= 6)
            .collect();
        let required = request("staged-source-portable", 7, 7);
        let old = check_with_inventory(&required, &previous).unwrap();
        assert!(!old.compatible);
        assert_eq!(old.checks[0].installed_version, Some(6));
        assert!(check_definition_capabilities(&required).unwrap().compatible);
        assert!(
            check_definition_capabilities(&request("staged-source-portable", 6, 6))
                .unwrap()
                .compatible
        );
    }

    #[test]
    fn prepared_settings_version_refuses_v4_inventory() {
        let previous: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| entry.contract_version <= 4)
            .collect();
        let required = request("staged-source-portable", 5, 5);
        assert!(
            !check_with_inventory(&required, &previous)
                .unwrap()
                .compatible
        );
        assert!(check_definition_capabilities(&required).unwrap().compatible);
        assert!(
            !check_definition_capabilities(&request("n64-recomp-portable", 5, 5))
                .unwrap()
                .compatible
        );
    }

    #[test]
    fn required_mutable_files_version_refuses_older_readers() {
        let previous: Vec<_> = EngineTemplateCapability::current()
            .into_iter()
            .filter(|entry| entry.contract_version <= 3)
            .collect();
        let required = request("staged-source-portable", 4, 4);
        assert!(
            !check_with_inventory(&required, &previous)
                .unwrap()
                .compatible
        );
        assert!(check_definition_capabilities(&required).unwrap().compatible);
        assert!(
            !check_definition_capabilities(&request("n64-recomp-portable", 4, 4))
                .unwrap()
                .compatible
        );
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
