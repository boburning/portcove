//! Executable design examples for #245, not runtime admission or a new authority.
//! #397 must consume these cases in the one core implementation. No candidate
//! file can supply trusted grants or mandatory-check results to production.

use serde::Deserialize;

use crate::{
    DefinitionEligibilityFacts, DefinitionEligibilityOutcome, DefinitionEligibilityReason,
    DefinitionOperation, evaluate_definition_eligibility,
};

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Operation {
    #[default]
    Availability,
    Install,
    Prepare,
    Launch,
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Scenario {
    operation: Operation,
    publisher_scoped: bool,
    publisher_revoked: bool,
    capability_supported: bool,
    unknown_safety_field: bool,
    ownership_preserved: bool,
    same_identity_changed: bool,
    expected_integrity: bool,
    local_integrity_valid: bool,
    required_source_missing: bool,
    source_mismatch: bool,
    mandatory_checks_passed: bool,
    gameplay_observed: bool,
    fresh_metadata: bool,
    replayed_metadata: bool,
    refresh_interrupted: bool,
    retained_contract: bool,
    retained_local_authorization: bool,
}

impl Default for Scenario {
    fn default() -> Self {
        Self {
            operation: Operation::Availability,
            publisher_scoped: true,
            publisher_revoked: false,
            capability_supported: true,
            unknown_safety_field: false,
            ownership_preserved: true,
            same_identity_changed: false,
            expected_integrity: true,
            local_integrity_valid: true,
            required_source_missing: false,
            source_mismatch: false,
            mandatory_checks_passed: true,
            gameplay_observed: false,
            fresh_metadata: true,
            replayed_metadata: false,
            refresh_interrupted: false,
            retained_contract: false,
            retained_local_authorization: false,
        }
    }
}

impl From<&Scenario> for DefinitionEligibilityFacts {
    fn from(scenario: &Scenario) -> Self {
        Self {
            operation: match scenario.operation {
                Operation::Availability => DefinitionOperation::Availability,
                Operation::Install => DefinitionOperation::Install,
                Operation::Prepare => DefinitionOperation::Prepare,
                Operation::Launch => DefinitionOperation::Launch,
            },
            publisher_scoped: scenario.publisher_scoped,
            publisher_revoked: scenario.publisher_revoked,
            capability_supported: scenario.capability_supported,
            unknown_safety_field: scenario.unknown_safety_field,
            ownership_preserved: scenario.ownership_preserved,
            same_identity_changed: scenario.same_identity_changed,
            expected_integrity: scenario.expected_integrity,
            local_integrity_valid: scenario.local_integrity_valid,
            required_source_missing: scenario.required_source_missing,
            source_mismatch: scenario.source_mismatch,
            mandatory_checks_passed: scenario.mandatory_checks_passed,
            fresh_metadata: scenario.fresh_metadata,
            replayed_metadata: scenario.replayed_metadata,
            refresh_interrupted: scenario.refresh_interrupted,
            retained_contract: scenario.retained_contract,
            retained_local_authorization: scenario.retained_local_authorization,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    scenario: Scenario,
    outcome: DefinitionEligibilityOutcome,
    reason: DefinitionEligibilityReason,
}

#[test]
fn definition_design_decision_table_preserves_scoped_failures_and_retained_use() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../tests/fixtures/definition-policy/decisions.json"
    ))
    .unwrap();
    assert!(cases.len() >= 20);
    for case in cases {
        assert_eq!(
            evaluate_definition_eligibility(&DefinitionEligibilityFacts::from(&case.scenario)),
            crate::DefinitionEligibility {
                outcome: case.outcome,
                reason: case.reason,
            },
            "{}",
            case.name
        );
    }
}

#[test]
fn gameplay_is_an_independent_observation_not_a_definition_admission_gate() {
    let mut scenario = Scenario::default();
    let missing_gameplay =
        evaluate_definition_eligibility(&DefinitionEligibilityFacts::from(&scenario));
    assert!(!scenario.gameplay_observed);
    scenario.gameplay_observed = true;
    assert_eq!(
        evaluate_definition_eligibility(&DefinitionEligibilityFacts::from(&scenario)),
        missing_gameplay
    );
    scenario.expected_integrity = false;
    assert_eq!(
        evaluate_definition_eligibility(&DefinitionEligibilityFacts::from(&scenario)).reason,
        DefinitionEligibilityReason::AuthenticatedIntegrityRequired
    );
}

#[test]
fn design_examples_reject_unknown_safety_claims_instead_of_ignoring_them() {
    assert!(serde_json::from_str::<Scenario>(r#"{"execute_arbitrary_script":true}"#).is_err());
    assert!(serde_json::from_str::<Scenario>(r#"{"operation":"shell"}"#).is_err());
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CapabilityExample {
    family: String,
    port_id: String,
    adapter: crate::AdapterKind,
}

#[test]
fn representative_schema_examples_use_existing_core_capabilities_and_exact_contracts() {
    let examples: Vec<CapabilityExample> = serde_json::from_str(include_str!(
        "../tests/fixtures/definition-policy/capabilities.json"
    ))
    .unwrap();
    let catalog = crate::Catalog::embedded().unwrap();
    for example in examples {
        let port = catalog.port(&example.port_id).unwrap();
        assert_eq!(port.adapter, example.adapter, "{}", example.family);
        for platform in &port.platforms {
            crate::InstallQualification::from_port(port, *platform).unwrap();
        }
        // The specimen retains the entire existing contract, not only a name,
        // selector or digest. This is not a successor-client migration proof.
        let bytes = serde_json::to_vec(port).unwrap();
        let retained: crate::PortDefinition = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            serde_json::to_value(retained).unwrap(),
            serde_json::to_value(port).unwrap()
        );
    }
}
