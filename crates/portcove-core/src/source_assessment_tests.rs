use super::*;

fn identity() -> SourceIdentity {
    SourceIdentity {
        game_id: "synthetic-game".into(),
        variant_id: "retail-a".into(),
        representation_id: "original".into(),
    }
}

fn evidence() -> SourceEvidence {
    SourceEvidence {
        scope: SourceEvidenceScope {
            port_id: "synthetic-port".into(),
            platform: Platform::WindowsX86_64,
            artifact_sha256: Some("a".repeat(64)),
            upstream_ref: Some("v1".into()),
            contract_id: Some("contract-v1".into()),
            variant: SourceVariantScope::Exact {
                identity: identity(),
            },
            check_version: Some("fixture-1".into()),
        },
        kind: SourceEvidenceKind::AutomatedLifecycle,
        outcome: SourceEvidenceOutcome::Passed,
        observed_at: 1,
        portcove_version: Some("0.1.0-alpha.1".into()),
        portcove_commit: None,
        method: "synthetic test".into(),
        evidence_ids: vec!["fixture-evidence".into()],
    }
}

#[test]
fn source_health_machine_meanings_remain_distinct() {
    for (health, name) in [
        (SourceHealth::Unregistered, "unregistered"),
        (SourceHealth::Current, "current"),
        (SourceHealth::Missing, "missing"),
        (SourceHealth::Unreadable, "unreadable"),
        (SourceHealth::Changed, "changed"),
        (SourceHealth::NotChecked, "not_checked"),
        (SourceHealth::NotBaselined, "not_baselined"),
    ] {
        assert_eq!(serde_json::to_value(health).unwrap(), name);
        assert_eq!(
            serde_json::from_value::<SourceHealth>(name.into()).unwrap(),
            health
        );
    }
}

#[test]
fn evidence_is_independent_of_admission_and_health() {
    // These are reported facts, not an alternative source-policy evaluator.
    // Optional gameplay evidence cannot rewrite the actual admission result.
    for admission in [
        SourceAdmission::NotEvaluated,
        SourceAdmission::Admitted {
            mode: SourceAdmissionMode::InformationalConsent,
        },
        SourceAdmission::Admitted {
            mode: SourceAdmissionMode::ExactIdentity,
        },
        SourceAdmission::Rejected {
            reason: SourceRejectionReason::KnownMismatch,
        },
    ] {
        for outcome in [
            SourceEvidenceOutcome::Passed,
            SourceEvidenceOutcome::Failed,
            SourceEvidenceOutcome::NotRun,
            SourceEvidenceOutcome::Unknown,
        ] {
            let mut observation = evidence();
            observation.outcome = outcome;
            let assessment = SourceAssessment {
                health: SourceHealth::NotBaselined,
                classification: SourceClassification::NotEvaluated,
                contract: SourceContractResult::NotEvaluated,
                admission: admission.clone(),
                evidence: vec![observation],
            };
            let decoded: SourceAssessment =
                serde_json::from_value(serde_json::to_value(&assessment).unwrap()).unwrap();
            assert_eq!(decoded, assessment);
            assert_eq!(decoded.admission, admission);
        }
    }
}

#[test]
fn classification_and_contract_states_round_trip_without_inferred_admission() {
    for classification in [
        SourceClassification::NotEvaluated,
        SourceClassification::Unrecognized,
        SourceClassification::Recognized {
            identity: identity(),
        },
        SourceClassification::Ambiguous {
            candidates: vec![identity()],
        },
    ] {
        for contract in [
            SourceContractResult::NotEvaluated,
            SourceContractResult::UnreviewedForRelease,
            SourceContractResult::Supported {
                contract_id: "c".into(),
            },
            SourceContractResult::RecognizedNotListed {
                contract_id: "c".into(),
            },
            SourceContractResult::KnownIncompatible {
                contract_id: "c".into(),
            },
            SourceContractResult::Informational {
                contract_id: "c".into(),
            },
        ] {
            let assessment = SourceAssessment {
                health: SourceHealth::Current,
                classification: classification.clone(),
                contract,
                admission: SourceAdmission::NotEvaluated,
                evidence: vec![],
            };
            assert_eq!(
                serde_json::from_value::<SourceAssessment>(
                    serde_json::to_value(&assessment).unwrap()
                )
                .unwrap(),
                assessment
            );
        }
    }
}

#[test]
fn legacy_unspecified_evidence_is_retained_but_never_exact_qualification() {
    let mut value = serde_json::to_value(evidence()).unwrap();
    value["scope"].as_object_mut().unwrap().remove("variant");
    let legacy: SourceEvidence = serde_json::from_value(value).unwrap();
    assert_eq!(legacy.scope.variant, SourceVariantScope::Unspecified);
    assert!(!legacy.applies_to(&legacy.scope));
    assert!(!legacy.applies_to(&evidence().scope));
    assert_eq!(legacy.outcome, SourceEvidenceOutcome::Passed);
}

#[test]
fn changed_relevant_inputs_prevent_inheritance_without_erasing_history() {
    let record = evidence();
    assert!(record.applies_to(&record.scope));
    let baseline = serde_json::to_value(&record.scope).unwrap();
    for (field, value) in [
        ("port_id", serde_json::json!("another-port")),
        ("platform", serde_json::json!("linux-x86-64")),
        ("artifact_sha256", serde_json::json!("b".repeat(64))),
        ("upstream_ref", serde_json::json!("v2")),
        ("contract_id", serde_json::json!("contract-v2")),
        ("check_version", serde_json::json!("fixture-2")),
    ] {
        let mut changed = baseline.clone();
        changed[field] = value;
        assert!(
            !record.applies_to(&serde_json::from_value(changed).unwrap()),
            "{field}"
        );
    }
    for field in ["game_id", "variant_id", "representation_id"] {
        let mut changed = baseline.clone();
        changed["variant"]["identity"][field] = "different".into();
        assert!(
            !record.applies_to(&serde_json::from_value(changed).unwrap()),
            "{field}"
        );
    }
    let mut other_build = record.clone();
    other_build.portcove_version = Some("0.1.0-alpha.2".into());
    other_build.portcove_commit = Some("unrelated-build".into());
    assert!(other_build.applies_to(&record.scope));
    assert_eq!(record.portcove_version.as_deref(), Some("0.1.0-alpha.1"));
}

#[test]
fn incomplete_artifact_or_check_scope_never_matches_itself() {
    for hash in [None, Some(String::new()), Some("not-a-digest".into())] {
        let mut record = evidence();
        record.scope.artifact_sha256 = hash;
        assert!(!record.applies_to(&record.scope));
    }
    let mut record = evidence();
    record.scope.check_version = None;
    assert!(!record.applies_to(&record.scope));
}

#[test]
fn relevant_failure_remains_failure_and_unknown_states_fail_decoding() {
    let mut record = evidence();
    record.outcome = SourceEvidenceOutcome::Failed;
    assert!(record.applies_to(&record.scope));
    assert_eq!(record.outcome, SourceEvidenceOutcome::Failed);
    assert!(serde_json::from_str::<SourceAdmission>(r#"{"state":"future_admission"}"#).is_err());
    assert!(serde_json::from_str::<SourceVariantScope>(r#"{"state":"future_scope"}"#).is_err());
}
