//! Versioned, Core-owned explanations for common unsuccessful game exit statuses.
//!
//! Wording is deliberately "most likely": an explained status is a hint, never
//! proof of cause. Unmapped statuses get a generic message with no invented cause.

use schemars::JsonSchema;
use serde::Serialize;

use crate::{LaunchSessionOutcome, LaunchSessionRecord};

/// Bumped whenever a key, status or next action changes meaning.
pub const EXIT_EXPLANATION_TABLE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ExitExplanation {
    pub table_version: u32,
    /// Stable machine key, e.g. `dll_not_found`.
    pub key: &'static str,
    /// Raw status as Windows reports it, e.g. `0xC0000135`, or the decimal value.
    pub raw_code: String,
    pub explanation: &'static str,
    pub next_action: &'static str,
}

struct Entry {
    status: u32,
    key: &'static str,
    explanation: &'static str,
    next_action: &'static str,
}

const ENTRIES: &[Entry] = &[
    Entry {
        status: 0xC000_0135,
        key: "dll_not_found",
        explanation: "A required DLL or runtime is most likely missing.",
        next_action: "Install the runtime the game's page lists, then try again.",
    },
    Entry {
        status: 0xC000_007B,
        key: "invalid_image_format",
        explanation: "The game most likely loaded a file built for a different architecture, or a damaged DLL.",
        next_action: "Verify the installation, or reinstall it.",
    },
    Entry {
        status: 0xC000_0005,
        key: "access_violation",
        explanation: "The game most likely crashed.",
        next_action: "Update your graphics drivers, or try the previous version.",
    },
    Entry {
        status: 0xC000_0409,
        key: "fail_fast",
        explanation: "The game most likely stopped itself after an internal error.",
        next_action: "Open the logs, or try the previous version.",
    },
    Entry {
        status: 0xC000_0142,
        key: "dll_init_failed",
        explanation: "A DLL most likely failed to start.",
        next_action: "Verify the installation and your Visual C++ runtimes, then try again.",
    },
];

const GENERIC_KEY: &str = "unexplained_exit";
const GENERIC_EXPLANATION: &str = "The game closed with an error.";
const GENERIC_ACTION: &str = "Open the logs for details.";

/// Explains an unsuccessful exit. Returns `None` for success (`0`) and for a
/// missing status, so user-initiated stops and clean exits show nothing.
pub fn explain_exit_code(code: Option<i32>) -> Option<ExitExplanation> {
    let code = code.filter(|code| *code != 0)?;
    // Windows reports NTSTATUS values as the same 32 bits, surfaced as i32.
    let status = code as u32;
    Some(match ENTRIES.iter().find(|entry| entry.status == status) {
        Some(entry) => ExitExplanation {
            table_version: EXIT_EXPLANATION_TABLE_VERSION,
            key: entry.key,
            raw_code: format!("0x{status:08X}"),
            explanation: entry.explanation,
            next_action: entry.next_action,
        },
        None => ExitExplanation {
            table_version: EXIT_EXPLANATION_TABLE_VERSION,
            key: GENERIC_KEY,
            raw_code: code.to_string(),
            explanation: GENERIC_EXPLANATION,
            next_action: GENERIC_ACTION,
        },
    })
}

/// A launch-session record plus the explanation for an unsuccessful exit.
/// The record stays the only durable authority; the explanation is derived.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct LaunchSessionView {
    #[serde(flatten)]
    pub record: LaunchSessionRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_explanation: Option<ExitExplanation>,
}

impl LaunchSessionView {
    /// Only a failed session is explained; success and user-initiated stops
    /// (cancelled) and unfinished sessions show nothing.
    pub fn new(record: LaunchSessionRecord) -> Self {
        let exit_explanation = (record.outcome == Some(LaunchSessionOutcome::Failed))
            .then(|| explain_exit_code(record.exit_code))
            .flatten();
        Self {
            record,
            exit_explanation,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_each_documented_status_from_signed_values() {
        for (code, key) in [
            (0xC000_0135_u32, "dll_not_found"),
            (0xC000_007B, "invalid_image_format"),
            (0xC000_0005, "access_violation"),
            (0xC000_0409, "fail_fast"),
            (0xC000_0142, "dll_init_failed"),
        ] {
            let found = explain_exit_code(Some(code as i32)).unwrap();
            assert_eq!(found.key, key);
            assert_eq!(found.raw_code, format!("0x{code:08X}"));
            assert_eq!(found.table_version, EXIT_EXPLANATION_TABLE_VERSION);
            assert!(found.explanation.contains("most likely"));
        }
    }

    #[test]
    fn success_and_missing_status_show_nothing() {
        assert_eq!(explain_exit_code(Some(0)), None);
        assert_eq!(explain_exit_code(None), None);
    }

    #[test]
    fn unmapped_and_negative_codes_stay_generic() {
        for code in [1, 42, -1, i32::MIN] {
            let found = explain_exit_code(Some(code)).unwrap();
            assert_eq!(found.key, GENERIC_KEY);
            assert_eq!(found.raw_code, code.to_string());
            assert_eq!(found.explanation, GENERIC_EXPLANATION);
        }
    }

    fn session(
        outcome: Option<LaunchSessionOutcome>,
        exit_code: Option<i32>,
    ) -> LaunchSessionRecord {
        serde_json::from_value(serde_json::json!({
            "id": "r", "port_id": "p", "install_id": "i", "install_root": "/i",
            "supervisor_pid": 1, "phase": "running", "started_at": 0, "updated_at": 1,
            "outcome": outcome, "exit_code": exit_code,
        }))
        .unwrap()
    }

    #[test]
    fn view_explains_only_failed_sessions() {
        let failed = LaunchSessionView::new(session(
            Some(LaunchSessionOutcome::Failed),
            Some(0xC000_0135_u32 as i32),
        ));
        assert_eq!(
            failed.exit_explanation.as_ref().unwrap().key,
            "dll_not_found"
        );
        let json = serde_json::to_value(&failed).unwrap();
        assert_eq!(json["exit_explanation"]["raw_code"], "0xC0000135");
        assert_eq!(json["id"], "r");

        for record in [
            session(Some(LaunchSessionOutcome::Succeeded), Some(0)),
            session(Some(LaunchSessionOutcome::Cancelled), Some(1)),
            session(None, None),
        ] {
            let view = LaunchSessionView::new(record);
            assert!(view.exit_explanation.is_none());
            assert!(
                serde_json::to_value(&view)
                    .unwrap()
                    .get("exit_explanation")
                    .is_none()
            );
        }
    }
}
