use super::{json_stdout, portcove};
use serde_json::json;

#[test]
fn definition_requirements_are_inspected_offline_without_opening_a_library() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("unopened");
    let file = temporary.path().join("requirements.json");
    let mut request = json!({
        "capability_contract_schema": 1,
        "required_capabilities": [
            {"template":"n64-recomp-portable", "minimum_version":1, "maximum_version":1},
            {"template":"future-template", "minimum_version":1, "maximum_version":1},
            {"template":"generated-cache", "minimum_version":2, "maximum_version":3}
        ]
    });
    std::fs::write(&file, serde_json::to_vec(&request).unwrap()).unwrap();
    for mode in ["--json", "--jsonl"] {
        let output = portcove(
            &library,
            &[
                mode,
                "catalog",
                "check-capabilities",
                file.to_str().unwrap(),
            ],
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let response = json_stdout(&output);
        assert_eq!(response["schema_version"], 45);
        assert_eq!(response["command"], "catalog.check-capabilities");
        assert_eq!(response["data"]["compatible"], false);
        let checks = &response["data"]["checks"];
        assert_eq!(checks[0]["outcome"], "supported");
        assert_eq!(checks[1]["outcome"], "unsupported_template");
        assert!(checks[1]["installed_version"].is_null());
        assert_eq!(checks[2]["outcome"], "unsupported_version");
        assert_eq!(checks[2]["installed_version"], 1);
        assert!(!library.exists());
    }
    request["publisher_approved"] = true.into();
    std::fs::write(&file, serde_json::to_vec(&request).unwrap()).unwrap();
    let output = portcove(
        &library,
        &[
            "--json",
            "catalog",
            "check-capabilities",
            file.to_str().unwrap(),
        ],
    );
    assert!(!output.status.success());
    assert_eq!(json_stdout(&output)["ok"], false);
    assert!(!library.exists());
}

#[test]
fn advertised_engine_templates_match_negotiation_and_exported_schemas() {
    let temporary = tempfile::tempdir().unwrap();
    let capabilities = json_stdout(&portcove(temporary.path(), &["--json", "capabilities"]));
    let templates = capabilities["data"]["engine_templates"].as_array().unwrap();
    assert_eq!(
        templates.len(),
        capabilities["data"]["adapters"].as_array().unwrap().len()
    );
    for template in templates {
        let request = serde_json::from_value(json!({
            "capability_contract_schema": 1,
            "required_capabilities": [{"template":template["template"], "minimum_version":template["contract_version"], "maximum_version":template["contract_version"]}]
        })).unwrap();
        assert!(
            portcove_core::check_definition_capabilities(&request)
                .unwrap()
                .compatible
        );
    }
    let schemas = json_stdout(&portcove(
        temporary.path(),
        &["--json", "schema", "export", "--contract", "input"],
    ));
    assert_eq!(
        schemas["data"]["definition_capability_request"]["additionalProperties"],
        false
    );
    assert!(schemas["data"]["definition_capability_report"]["properties"]["checks"].is_object());
}
