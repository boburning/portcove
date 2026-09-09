//! Executable design examples for #245, not runtime admission or a new authority.
//! #397 must consume these cases in the one core implementation. No candidate
//! file can supply trusted grants or mandatory-check results to production.

use serde::Deserialize;

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

type Decision = (&'static str, &'static str);

fn authority(scenario: &Scenario) -> Option<Decision> {
    if scenario.publisher_revoked {
        return Some(("hold", "publisher_revoked"));
    }
    if scenario.unknown_safety_field {
        return Some(("hold", "unknown_safety_semantics"));
    }
    if !scenario.publisher_scoped {
        return Some(("escalate", "publisher_scope_required"));
    }
    if !scenario.capability_supported {
        return Some(("escalate", "engine_capability_required"));
    }
    if !scenario.ownership_preserved {
        return Some(("escalate", "ownership_migration_required"));
    }
    None
}

fn refresh(scenario: &Scenario) -> Option<Decision> {
    if scenario.replayed_metadata {
        return Some(("hold", "metadata_replay"));
    }
    if scenario.refresh_interrupted {
        return Some(("hold", "refresh_incomplete"));
    }
    if !scenario.fresh_metadata {
        return Some(("hold", "metadata_stale"));
    }
    None
}

fn operation_inputs(scenario: &Scenario) -> Option<Decision> {
    if scenario.same_identity_changed {
        return Some(("hold", "recorded_identity_changed"));
    }
    let retained_local_launch = scenario.operation == Operation::Launch
        && scenario.retained_contract
        && scenario.retained_local_authorization;
    if !scenario.expected_integrity && !retained_local_launch {
        return Some(("hold", "authenticated_integrity_required"));
    }
    if !scenario.local_integrity_valid {
        return Some(("hold", "local_integrity_failed"));
    }
    if !scenario.mandatory_checks_passed {
        return Some(("hold", "mandatory_check_failed"));
    }
    if scenario.operation == Operation::Availability {
        return None;
    }
    if scenario.source_mismatch {
        return Some(("hold", "source_identity_mismatch"));
    }
    if scenario.required_source_missing {
        return Some(("hold", "required_source_missing"));
    }
    None
}

fn decision(scenario: &Scenario) -> Decision {
    if let Some(result) = authority(scenario) {
        return result;
    }
    if !(scenario.operation == Operation::Launch && scenario.retained_contract)
        && let Some(result) = refresh(scenario)
    {
        return result;
    }
    operation_inputs(scenario).unwrap_or(("eligible", "mandatory_checks_passed"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    scenario: Scenario,
    outcome: String,
    reason: String,
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
            decision(&case.scenario),
            (case.outcome.as_str(), case.reason.as_str()),
            "{}",
            case.name
        );
    }
}

#[test]
fn gameplay_is_an_independent_observation_not_a_definition_admission_gate() {
    let mut scenario = Scenario::default();
    let missing_gameplay = decision(&scenario);
    assert!(!scenario.gameplay_observed);
    scenario.gameplay_observed = true;
    assert_eq!(decision(&scenario), missing_gameplay);
    scenario.expected_integrity = false;
    assert_eq!(decision(&scenario).1, "authenticated_integrity_required");
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
