use super::{json_stdout, portcove};
use serde_json::json;

#[test]
fn definition_publication_inspection_is_offline_and_never_opens_a_library() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("unopened");
    let bundle = temporary.path().join("bundle");
    std::fs::create_dir_all(bundle.join("definitions")).unwrap();
    let index = br#"{"index_schema":1,"definitions":[],"contents":[]}"#;
    std::fs::write(bundle.join("definitions/index.json"), index).unwrap();
    for mode in ["--json", "--jsonl"] {
        let result = portcove(
            &library,
            &[
                mode,
                "catalog",
                "inspect-definition-publication",
                bundle.to_str().unwrap(),
            ],
        );
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let response = json_stdout(&result);
        assert_eq!(
            response["command"],
            "catalog.inspect-definition-publication"
        );
        assert_eq!(response["data"]["authority"], "none");
        assert_eq!(response["data"]["publication_schema"], 1);
        assert_eq!(
            response["data"]["files"][0]["target"],
            "definitions/index.json"
        );
        assert_eq!(response["data"]["definitions"], json!([]));
        assert!(!library.exists());
    }
    std::fs::write(bundle.join("extra.json"), b"{}").unwrap();
    let result = portcove(
        &library,
        &[
            "--json",
            "catalog",
            "inspect-definition-publication",
            bundle.to_str().unwrap(),
        ],
    );
    assert!(!result.status.success());
    assert!(!library.exists());
}

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
        assert_eq!(
            response["schema_version"],
            portcove_core::API_SCHEMA_VERSION
        );
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
    let pairs: std::collections::HashSet<_> = templates
        .iter()
        .map(|entry| {
            (
                entry["template"].as_str().unwrap(),
                entry["contract_version"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(pairs.len(), templates.len());
    let adapters = capabilities["data"]["adapters"].as_array().unwrap();
    let mut expected = std::collections::HashSet::new();
    for adapter in adapters {
        assert!(expected.insert((adapter.as_str().unwrap(), 1)));
    }
    for capability in [
        ("n64-recomp-portable", 2),
        ("n64-recomp-portable", 3),
        ("n64-recomp-portable", 4),
        ("psx-recomp-managed", 2),
        ("native-portable", 2),
        ("native-portable", 3),
        ("native-portable", 4),
        ("native-portable", 5),
        ("native-portable", 6),
        ("native-portable", 7),
    ] {
        assert!(expected.insert(capability));
    }
    let staged_versions = [
        2, 3, 4, 5, 8, 10, 11, 12, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    ];
    for version in staged_versions {
        assert!(expected.insert(("staged-source-portable", version)));
    }
    for retired in [6, 7, 9, 13, 14] {
        assert!(!pairs.contains(&("staged-source-portable", retired)));
    }
    assert_eq!(pairs, expected);
    let requirements = temporary.path().join("prepared-directory.json");
    std::fs::write(&requirements, serde_json::to_vec(&json!({
        "capability_contract_schema": 1,
        "required_capabilities": [{"template":"staged-source-portable", "minimum_version":3, "maximum_version":3}]
    })).unwrap()).unwrap();
    let negotiated = json_stdout(&portcove(
        temporary.path(),
        &[
            "--json",
            "catalog",
            "check-capabilities",
            requirements.to_str().unwrap(),
        ],
    ));
    assert_eq!(negotiated["data"]["compatible"], true);
    assert_eq!(negotiated["data"]["checks"][0]["installed_version"], 3);
    std::fs::write(&requirements, serde_json::to_vec(&json!({
        "capability_contract_schema": 1,
        "required_capabilities": [{"template":"staged-source-portable", "minimum_version":10, "maximum_version":10}]
    })).unwrap()).unwrap();
    let current = json_stdout(&portcove(
        temporary.path(),
        &[
            "--json",
            "catalog",
            "check-capabilities",
            requirements.to_str().unwrap(),
        ],
    ));
    assert_eq!(current["data"]["compatible"], true);
    assert_eq!(current["data"]["checks"][0]["installed_version"], 10);
    for (version, compatible, installed_version) in [
        (18, true, 18),
        (19, true, 19),
        (20, true, 20),
        (21, true, 21),
        (22, true, 22),
        (23, true, 23),
        (24, true, 24),
        (25, true, 25),
        (26, false, 25),
        (6, false, 25),
        (7, false, 25),
        (9, false, 25),
        (13, false, 25),
        (14, false, 25),
    ] {
        std::fs::write(&requirements, serde_json::to_vec(&json!({
            "capability_contract_schema": 1,
            "required_capabilities": [{"template":"staged-source-portable", "minimum_version":version, "maximum_version":version}]
        })).unwrap()).unwrap();
        let negotiated = json_stdout(&portcove(
            temporary.path(),
            &[
                "--json",
                "catalog",
                "check-capabilities",
                requirements.to_str().unwrap(),
            ],
        ));
        assert_eq!(
            negotiated["schema_version"],
            portcove_core::API_SCHEMA_VERSION
        );
        assert_eq!(negotiated["data"]["compatible"], compatible);
        assert_eq!(
            negotiated["data"]["checks"][0]["installed_version"],
            installed_version
        );
    }
    let mut identities = std::collections::HashSet::new();
    for template in templates {
        assert!(identities.insert((
            template["template"].to_string(),
            template["contract_version"].as_u64().unwrap()
        )));
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

#[test]
fn fixed_definition_authority_is_advertised_reviewable_and_unconfigured() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let core = portcove_core::Library::open(&library).unwrap();
    let initial = core.review_definition_authority().unwrap();
    drop(core);
    let capabilities = json_stdout(&portcove(&library, &["--json", "capabilities"]));
    assert_eq!(
        capabilities["data"]["commands"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|name| name.as_str() == Some("catalog.definition-authority"))
            .count(),
        1
    );
    let schema = json_stdout(&portcove(
        &library,
        &["--json", "schema", "export", "--contract", "output"],
    ));
    for name in [
        "definition_authority_review",
        "definition_authority_provisioning",
    ] {
        assert!(schema["data"][name].is_object());
    }
    for mode in ["--json", "--jsonl"] {
        let result = json_stdout(&portcove(
            &library,
            &[mode, "catalog", "definition-authority"],
        ));
        assert_eq!(result["schema_version"], portcove_core::API_SCHEMA_VERSION);
        assert_eq!(result["command"], "catalog.definition-authority");
        assert_eq!(result["data"], serde_json::to_value(&initial).unwrap());
        assert_eq!(result["data"]["provisioning_schema"], 1);
        assert_eq!(result["data"]["configured"], false);
        assert_eq!(result["data"]["installed"], false);
        for field in schema["data"]["definition_authority_review"]["required"]
            .as_array()
            .unwrap()
        {
            assert!(result["data"].get(field.as_str().unwrap()).is_some());
        }
    }
    let failed = portcove(
        &library,
        &[
            "--json",
            "--non-interactive",
            "catalog",
            "definition-authority",
            "--apply",
            "--expected-plan",
            &initial.expected_plan,
            "--yes",
        ],
    );
    assert!(!failed.status.success());
    assert_eq!(json_stdout(&failed)["error"]["code"], "unsupported");
    let final_review = portcove_core::Library::open(&library)
        .unwrap()
        .review_definition_authority()
        .unwrap();
    assert_eq!(final_review.expected_plan, initial.expected_plan);
}

#[test]
fn ordinary_definition_refresh_advertises_contract_and_refuses_unconfigured_authority() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let core = portcove_core::Library::open(&library).unwrap();
    let before = core.review_definition_authority().unwrap();
    let capabilities = json_stdout(&portcove(&library, &["--json", "capabilities"]));
    assert_eq!(
        capabilities["data"]["commands"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|name| name.as_str() == Some("catalog.definition-refresh"))
            .count(),
        1
    );
    let schema = json_stdout(&portcove(
        &library,
        &["--json", "schema", "export", "--contract", "output"],
    ));
    assert!(schema["data"]["definition_refresh"]["properties"]["refresh_schema"].is_object());
    for mode in ["--json", "--jsonl"] {
        let output = portcove(
            &library,
            &[
                mode,
                "--non-interactive",
                "catalog",
                "definition-refresh",
                "future-port",
                "--metadata-base-url",
                "https://definitions.invalid/metadata/",
                "--targets-base-url",
                "https://definitions.invalid/targets/",
            ],
        );
        assert!(!output.status.success());
        let response = json_stdout(&output);
        assert_eq!(
            response["schema_version"],
            portcove_core::API_SCHEMA_VERSION
        );
        assert_eq!(response["command"], "catalog.definition-refresh");
        assert_eq!(response["error"]["code"], "unsupported");
    }
    let injected = portcove(
        &library,
        &[
            "catalog",
            "definition-refresh",
            "future-port",
            "--metadata-base-url",
            "https://definitions.invalid/metadata/",
            "--targets-base-url",
            "https://definitions.invalid/targets/",
            "--root",
            "untrusted.json",
        ],
    );
    assert!(!injected.status.success());
    assert!(String::from_utf8_lossy(&injected.stderr).contains("--root"));
    assert_eq!(
        core.review_definition_authority().unwrap().expected_plan,
        before.expected_plan
    );
    assert!(core.activities(10).unwrap().is_empty());
    assert!(
        core.definition_selection_status()
            .unwrap()
            .selected
            .is_none()
    );
}

#[test]
fn listing_delivery_is_negotiable_and_cannot_provision_an_incoming_authority() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let core = portcove_core::Library::open(&library).unwrap();
    let before = core.review_definition_authority().unwrap();
    let capabilities = json_stdout(&portcove(&library, &["--json", "capabilities"]));
    let commands = capabilities["data"]["commands"].as_array().unwrap();
    assert!(
        commands
            .iter()
            .any(|value| value == "catalog.listing-refresh")
    );
    assert!(
        commands
            .iter()
            .any(|value| value == "catalog.listing-status")
    );
    let output = portcove(
        &library,
        &[
            "--json",
            "catalog",
            "listing-refresh",
            "--metadata-base-url",
            "https://definitions.invalid/metadata/",
            "--targets-base-url",
            "https://definitions.invalid/targets/",
        ],
    );
    assert!(!output.status.success());
    assert_eq!(json_stdout(&output)["error"]["code"], "unsupported");
    let status = json_stdout(&portcove(
        &library,
        &["--json", "catalog", "listing-status"],
    ));
    assert_eq!(status["data"]["selected"], false);
    assert_eq!(status["data"]["revision"], serde_json::Value::Null);
    assert_eq!(
        core.review_definition_authority().unwrap().expected_plan,
        before.expected_plan
    );
}
