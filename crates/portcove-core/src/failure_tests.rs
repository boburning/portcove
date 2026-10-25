use super::*;

#[test]
fn known_facts_preserve_machine_identity_and_cannot_be_supplied_by_diagnostics() {
    let error = PortcoveError::conflict("original message: token=private")
        .with_mutation_state(MutationState::Committed)
        .detail("known_cause", "StaleRemoval")
        .detail("presentation_key", "removal_review_stale");
    let original = error.report();
    assert_eq!(original.presentation.presentation_key, "selection_changed");
    let annotated = error
        .with_known_cause(KnownFailureCause::StaleRemoval)
        .report();
    assert_eq!(annotated.code, original.code);
    assert_eq!(annotated.message, original.message);
    assert_eq!(annotated.details, original.details);
    assert_eq!(
        annotated.presentation.mutation_state,
        MutationState::Committed
    );
    assert_eq!(
        annotated.presentation.recovery_actions,
        original.presentation.recovery_actions
    );
    assert_eq!(
        annotated.presentation.technical_message,
        original.presentation.technical_message
    );
    assert_eq!(
        annotated.presentation.presentation_key,
        "removal_review_stale"
    );
    assert!(!annotated.presentation.summary.contains("private"));
    assert!(!annotated.presentation.summary.contains("No changes"));
}

#[test]
fn portable_refusals_explain_recovery_without_rewriting_mutation_facts() {
    for state in [MutationState::Unknown, MutationState::Committed] {
        for (cause, key, action) in [
            (
                KnownFailureCause::PortableRuntimeModified {
                    directory: std::path::PathBuf::from("C:/Games/<preserve>"),
                    failures: vec![
                        "changed: Game.exe".into(),
                        "unexpected: custom-notes.txt".into(),
                    ],
                },
                "portable_runtime_modified",
                "Back up",
            ),
            (
                KnownFailureCause::PortableDataContractChanged,
                "portable_data_contract_changed",
                "Keep using",
            ),
        ] {
            let error = PortcoveError::conflict("original diagnostic")
                .with_mutation_state(state)
                .detail("failures", "package.txt");
            let before = error.report();
            let report = error.with_known_cause(cause).report();
            assert_eq!(report.code, before.code);
            assert_eq!(report.message, before.message);
            assert_eq!(report.details, before.details);
            assert_eq!(report.presentation.mutation_state, state);
            assert_eq!(
                report.presentation.recovery_actions,
                before.presentation.recovery_actions
            );
            assert_eq!(
                report.presentation.technical_message,
                before.presentation.technical_message
            );
            assert_eq!(report.presentation.presentation_key, key);
            assert!(report.presentation.summary.contains(action));
            assert!(
                !report
                    .presentation
                    .summary
                    .contains("No files were changed")
            );
        }
    }
}

#[test]
fn diagnostic_documents_redact_nested_fields_without_corrupting_json() {
    let mut document = serde_json::json!({
        "activities": [{"details": {"access_token": "private-value"},
            "message": "setup rejected password=\"unterminated secret"}],
        "safe": "retained evidence"
    });
    redact_diagnostic_value(&mut document);
    let text = serde_json::to_string(&document).unwrap();
    assert!(!text.contains("private-value"));
    assert!(!text.contains("unterminated secret"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&text).unwrap(),
        document
    );
    assert_eq!(document["safe"], "retained evidence");
}

#[test]
fn unknown_mutation_is_not_reinterpreted_as_no_changes() {
    for code in [
        ErrorCode::Usage,
        ErrorCode::Verification,
        ErrorCode::Cancelled,
        ErrorCode::Network,
    ] {
        let error = PortcoveError::new(code, "private/path");
        let presentation = error.presentation();
        assert_eq!(presentation.mutation_state, MutationState::Unknown);
        assert!(!presentation.summary.contains("private/path"));
        assert!(!presentation.summary.contains("No files"));
        assert_eq!(
            presentation.tone == FailureTone::Neutral,
            code == ErrorCode::Cancelled
        );
    }
}

#[test]
fn diagnostic_details_cannot_supply_a_preparation_target() {
    let error = PortcoveError::state("original diagnostic")
        .during("preparation.interrupted")
        .detail("port_id", "opengoal-jak1")
        .detail("port_name", "Untrusted diagnostic title");
    assert!(
        !error
            .presentation()
            .summary
            .starts_with("Game preparation for ")
    );
    assert_eq!(error.presentation().recovery_target, None);
    assert!(
        !error
            .presentation()
            .summary
            .contains("Untrusted diagnostic title")
    );
}

#[test]
fn preparation_target_is_bounded_control_safe_and_adds_only_summary_and_read_only_target() {
    let catalog = crate::Catalog::embedded().unwrap();
    let mut port = catalog.port("opengoal-jak1").unwrap().clone();
    for name in [
        "Title\u{001b}\nwith\u{202e} controls token=owned-name-secret".to_owned(),
        "界".repeat(200),
        "\n\r\u{001b}".to_owned(),
    ] {
        port.name = name;
        let error = PortcoveError::source("original machine message")
            .detail("port_name", "untrusted diagnostic title")
            .with_mutation_state(MutationState::RecoveryRequired)
            .during("preparation.setup")
            .offer_recovery(RecoveryAction::ReviewPreparation);
        let original = error.report();
        let annotated = error.with_preparation_target(&port).report();
        assert_eq!(
            annotated.presentation.recovery_target,
            Some(FailureRecoveryTarget::Preparation {
                port_id: port.id.clone()
            })
        );
        assert!(annotated.presentation.summary.contains("opengoal-jak1"));
        assert!(!annotated.presentation.summary.chars().any(char::is_control));
        assert!(!annotated.presentation.summary.contains('\u{202e}'));
        assert!(!annotated.presentation.summary.contains("owned-name-secret"));
        assert!(
            !annotated
                .presentation
                .summary
                .contains("untrusted diagnostic title")
        );
        assert!(annotated.presentation.summary.len() < 1024);
        if port.name.starts_with('界') {
            assert_eq!(annotated.presentation.summary.matches('界').count(), 160);
            assert!(annotated.presentation.summary.contains('…'));
        }
        let mut expected = serde_json::to_value(&original).unwrap();
        let mut actual = serde_json::to_value(&annotated).unwrap();
        expected["presentation"]
            .as_object_mut()
            .unwrap()
            .remove("summary");
        actual["presentation"]
            .as_object_mut()
            .unwrap()
            .remove("summary");
        actual["presentation"]
            .as_object_mut()
            .unwrap()
            .remove("recovery_target");
        assert_eq!(actual, expected);
        assert_eq!(
            serde_json::from_value::<FailureReport>(serde_json::to_value(&original).unwrap())
                .unwrap(),
            original
        );
    }
}

#[test]
fn unknown_or_malformed_optional_recovery_targets_preserve_the_failure() {
    let report = PortcoveError::state("retained diagnostic")
        .with_mutation_state(MutationState::RecoveryRequired)
        .offer_recovery(RecoveryAction::ReviewPreparation)
        .report();
    let original = serde_json::to_value(&report).unwrap();
    assert!(original["presentation"].get("recovery_target").is_none());
    for target in [
        serde_json::json!({"kind":"future","port_id":"opengoal-jak1"}),
        serde_json::json!({"kind":"preparation","port_id":3}),
        serde_json::json!([]),
        serde_json::Value::Null,
    ] {
        let mut stored = original.clone();
        stored["presentation"]["recovery_target"] = target;
        let decoded: FailureReport = serde_json::from_value(stored).unwrap();
        assert_eq!(decoded, report);
        assert_eq!(serde_json::to_value(decoded).unwrap(), original);
    }
}

#[test]
fn preparation_cause_is_not_inferred_from_messages_or_details() {
    for code in [ErrorCode::SourceInvalid, ErrorCode::Verification] {
        for phase in ["preparation.setup", "preparation.verify"] {
            let error = PortcoveError::new(
                code,
                "setup completed without its declared output marker; exit 23",
            )
            .during(phase)
            .detail("preparation_cause", "setup_unsuccessful")
            .detail("presentation_key", "setup_output_unconfirmed")
            .detail("exit_code", "23");
            let report = error.report();
            assert_eq!(
                report.presentation.presentation_key,
                if code == ErrorCode::SourceInvalid {
                    "source_not_accepted"
                } else {
                    "verification_failed"
                }
            );
            assert_eq!(report.presentation.mutation_state, MutationState::Unknown);
            assert_eq!(report.details, error.details);
            assert_eq!(report.message, error.message);
        }
    }
}

#[test]
fn preparation_causes_preserve_machine_fields_outcomes_and_recovery() {
    for (cause, code, phase, key, summary) in [
        (
            PreparationFailureCause::SetupUnsuccessful,
            ErrorCode::SourceInvalid,
            "preparation.setup",
            "setup_unsuccessful",
            "Running game setup: The setup process ended unsuccessfully.",
        ),
        (
            PreparationFailureCause::CompletionFileUnconfirmed,
            ErrorCode::Verification,
            "preparation.verify",
            "setup_output_unconfirmed",
            "Checking prepared files: Setup finished, but its required completion file could not be confirmed.",
        ),
    ] {
        for state in [
            MutationState::NotStarted,
            MutationState::NoChanges,
            MutationState::Committed,
            MutationState::RecoveryRequired,
            MutationState::Unknown,
        ] {
            let private_source = std::env::temp_dir().join("private-source");
            let error = PortcoveError::new(
                code,
                format!("original diagnostic {}", private_source.display()),
            )
            .detail("path", private_source.to_string_lossy())
            .during(phase)
            .with_mutation_state(state)
            .offer_recovery(RecoveryAction::ReviewPreparation);
            let original = error.report();
            let report = error.with_preparation_cause(cause).report();
            assert_eq!(report.code, original.code);
            assert_eq!(report.message, original.message);
            assert_eq!(report.details, original.details);
            assert_eq!(report.presentation.presentation_key, key);
            assert_eq!(report.presentation.summary, summary);
            assert_eq!(report.presentation.mutation_state, state);
            assert_eq!(report.presentation.phase, original.presentation.phase);
            assert_eq!(report.presentation.tone, original.presentation.tone);
            assert_eq!(
                report.presentation.recovery_actions,
                original.presentation.recovery_actions
            );
            assert_eq!(
                report.presentation.technical_message,
                original.presentation.technical_message
            );
            assert_eq!(
                report.presentation.technical_context,
                original.presentation.technical_context
            );
            assert_eq!(
                serde_json::from_value::<FailureReport>(serde_json::to_value(&original).unwrap())
                    .unwrap(),
                original
            );
        }
    }
}

#[test]
fn owner_outcomes_and_recovery_are_explicit_without_changing_machine_fields() {
    for state in [
        MutationState::NotStarted,
        MutationState::NoChanges,
        MutationState::Committed,
        MutationState::RecoveryRequired,
        MutationState::Unknown,
    ] {
        let error = PortcoveError::source("setup exit 9: password=private.with-punctuation!")
            .detail("exit_code", "9")
            .detail("access_token", "keep-machine-contract")
            .with_mutation_state(state)
            .during("preparation.setup")
            .offer_recovery(RecoveryAction::ReviewPreparation);
        let presentation = error.presentation();
        assert_eq!(presentation.mutation_state, state);
        assert_eq!(presentation.phase.as_deref(), Some("preparation.setup"));
        assert!(
            presentation
                .recovery_actions
                .contains(&RecoveryAction::ReviewPreparation)
        );
        assert_eq!(presentation.technical_context["exit_code"], "9");
        assert_eq!(presentation.technical_context["access_token"], "[REDACTED]");
        assert!(
            !presentation
                .technical_message
                .contains("private.with-punctuation!")
        );
        assert_eq!(error.details["access_token"], "keep-machine-contract");
        assert_eq!(error.code, ErrorCode::SourceInvalid);
    }
}

#[test]
fn inline_credentials_with_punctuation_are_redacted_to_the_delimiter() {
    let text = redact_diagnostic_text(
        "Bearer a.b+c/d== password=hello.world! token=abc-123, safe=visible",
    );
    for secret in ["a.b+c/d==", "hello.world!", "abc-123"] {
        assert!(!text.contains(secret));
    }
    assert!(text.contains("safe=visible"));
    assert!(text.contains(","));
}
#[test]
fn quoted_credentials_are_redacted_and_repeated_redaction_is_stable() {
    let input = r#"password="secret with spaces!" token='quoted secret' safe=visible"#;
    let once = redact_diagnostic_text(input);
    assert!(!once.contains("secret"));
    assert!(once.contains("safe=visible"));
    assert_eq!(redact_diagnostic_text(&once), once);
    let document = serde_json::json!({ "message": input });
    let redacted = redact_diagnostic_text(&serde_json::to_string(&document).unwrap());
    let parsed: serde_json::Value = serde_json::from_str(&redacted).unwrap();
    assert!(!parsed["message"].as_str().unwrap().contains("secret"));
    assert!(
        !redact_diagnostic_text("token=[REDACTED]still-private next=visible")
            .contains("still-private")
    );
}
