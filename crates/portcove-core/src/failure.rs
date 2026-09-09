//! Core-owned failure presentation; machine error identity remains unchanged.
use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ErrorCode, PortcoveError};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MutationState {
    NotStarted,
    NoChanges,
    Committed,
    RecoveryRequired,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    ReviewCurrentState,
    ReviewPreparation,
    ViewTechnicalDetails,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FailureTone {
    Neutral,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FailurePresentation {
    pub presentation_key: String,
    pub summary: String,
    pub tone: FailureTone,
    pub mutation_state: MutationState,
    pub phase: Option<String>,
    pub recovery_actions: Vec<RecoveryAction>,
    pub technical_message: String,
    pub technical_context: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FailureReport {
    pub code: ErrorCode,
    pub message: String,
    pub details: BTreeMap<String, String>,
    pub presentation: FailurePresentation,
}

impl From<PortcoveError> for FailureReport {
    fn from(error: PortcoveError) -> Self {
        error.report()
    }
}

#[derive(Debug, Default)]
pub(crate) struct FailureContext {
    pub(crate) mutation_state: MutationState,
    pub(crate) phase: Option<String>,
    pub(crate) recovery_actions: Vec<RecoveryAction>,
}

impl PortcoveError {
    pub fn report(&self) -> FailureReport {
        FailureReport {
            code: self.code,
            message: self.message.clone(),
            details: self.details.clone(),
            presentation: self.presentation(),
        }
    }

    /// Attach an outcome observed by the operation owner, never inferred from an error code.
    pub fn with_mutation_state(mut self, state: MutationState) -> Self {
        self.failure.mutation_state = state;
        self
    }

    pub(crate) fn during(mut self, phase: &str) -> Self {
        self.failure.phase = Some(phase.into());
        self
    }

    pub(crate) fn offer_recovery(mut self, action: RecoveryAction) -> Self {
        if !self.failure.recovery_actions.contains(&action) {
            self.failure.recovery_actions.push(action);
        }
        self
    }

    pub fn presentation(&self) -> FailurePresentation {
        let (key, summary) = match self.code {
            ErrorCode::Usage => (
                "request_invalid",
                "Review the requested operation and its required inputs.",
            ),
            ErrorCode::Unsupported => (
                "operation_unsupported",
                "This operation is not supported for the current selection.",
            ),
            ErrorCode::NotFound => (
                "item_unavailable",
                "A required item is no longer available.",
            ),
            ErrorCode::SourceInvalid => (
                "source_not_accepted",
                "The required game files could not be accepted or prepared.",
            ),
            ErrorCode::Network => (
                "connection_failed",
                "The online request could not be completed.",
            ),
            ErrorCode::Verification => {
                ("verification_failed", "Required verification did not pass.")
            }
            ErrorCode::Install => (
                "installation_failed",
                "The installation could not be completed.",
            ),
            ErrorCode::State => (
                "state_unavailable",
                "The current operation state could not be confirmed.",
            ),
            ErrorCode::Launch => (
                "process_failed",
                "The requested process could not be started or supervised.",
            ),
            ErrorCode::Conflict => (
                "selection_changed",
                "The selection changed or another operation is using it. Review its current state.",
            ),
            ErrorCode::Cancelled => ("operation_cancelled", "The operation was cancelled."),
        };
        let phase_label = match self.failure.phase.as_deref() {
            Some("preparation.review") => Some("Reviewing game preparation"),
            Some("preparation.copy") => Some("Copying the installed version"),
            Some("preparation.extract") => Some("Preparing original game files"),
            Some("preparation.setup") => Some("Running game setup"),
            Some("preparation.verify") => Some("Checking prepared files"),
            Some("preparation.publish") => Some("Activating prepared data"),
            _ => None,
        };
        let mut recovery_actions = self.failure.recovery_actions.clone();
        for action in [
            RecoveryAction::ReviewCurrentState,
            RecoveryAction::ViewTechnicalDetails,
        ] {
            if !recovery_actions.contains(&action) {
                recovery_actions.push(action);
            }
        }
        FailurePresentation {
            presentation_key: key.into(),
            summary: phase_label
                .map_or_else(|| summary.into(), |phase| format!("{phase}: {summary}")),
            tone: if self.code == ErrorCode::Cancelled {
                FailureTone::Neutral
            } else {
                FailureTone::Error
            },
            mutation_state: self.failure.mutation_state,
            phase: self.failure.phase.clone(),
            recovery_actions,
            technical_message: redact_diagnostic_text(&self.message),
            technical_context: self
                .details
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if sensitive_diagnostic_field(key) {
                            "[REDACTED]".into()
                        } else {
                            redact_diagnostic_text(value)
                        },
                    )
                })
                .collect(),
        }
    }
}

pub fn sensitive_diagnostic_field(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "credential",
        "authorization",
        "device_code",
        "user_code",
    ]
    .iter()
    .any(|part| name.contains(part))
}

/// Shared redaction for human diagnostics. Original machine error fields are not rewritten.
pub fn redact_diagnostic_text(input: &str) -> String {
    let mut output = input.to_owned();
    for marker in [
        "Bearer ",
        "ghp_",
        "github_pat_",
        "glpat-",
        "token=",
        "password=",
        "secret=",
        "authorization=",
    ] {
        output = redact_after_marker(&output, marker);
    }
    output
}

fn redact_after_marker(input: &str, marker: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;
    let marker_lower = marker.to_ascii_lowercase();
    while let Some(index) = remaining.to_ascii_lowercase().find(&marker_lower) {
        let (before, matched) = remaining.split_at(index);
        output.push_str(before);
        output.push_str(&matched[..marker.len()]);
        output.push_str("[REDACTED]");
        let after = &matched[marker.len()..];
        let secret_len = diagnostic_secret_length(after);
        remaining = &after[secret_len..];
    }
    output.push_str(remaining);
    output
}

fn diagnostic_secret_length(after: &str) -> usize {
    if after.starts_with("[REDACTED]") {
        return "[REDACTED]".len();
    }
    for quote in ["\\\"", "\"", "'"] {
        if let Some(value) = after.strip_prefix(quote) {
            return value
                .find(quote)
                .map_or(after.len(), |index| quote.len() + index + quote.len());
        }
    }
    after
        .char_indices()
        .take_while(|(_, character)| {
            !character.is_whitespace()
                && !matches!(character, '"' | '\'' | ',' | ';' | '}' | ']' | '<' | '>')
        })
        .map(|(index, character)| index + character.len_utf8())
        .last()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
