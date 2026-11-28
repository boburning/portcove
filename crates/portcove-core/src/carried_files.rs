//! Read-only disclosure of a recorded version switch. This grants no file authority.
use std::path::PathBuf;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Complete counts recorded before the bounded path examples are truncated.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct CarriedFileCounts {
    pub carried: u64,
    pub removed: u64,
    pub kept_separately: u64,
    pub source_unreadable: u64,
    pub new_version_ships_file: u64,
}

/// The result of carrying files during one switch, rather than an operation failure.
/// Older rows have path examples but no complete counts or byte observations.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct CarriedFileOutcome {
    pub carried: Vec<String>,
    pub removed: Vec<String>,
    pub kept_separately: Vec<String>,
    pub source_unreadable: Vec<String>,
    pub new_version_ships_file: Vec<String>,
    pub insufficient_space: bool,
    pub source_modified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counts: Option<CarriedFileCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub carried_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_carried_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_bytes: Option<u64>,
}

/// A historical outcome applicable only to the currently active target installation.
/// The source may since have been removed; absent coordinates must stay absent.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CarriedFilesStatus {
    pub from_install_id: String,
    pub to_install_id: String,
    pub from_version: Option<String>,
    pub from_path: Option<PathBuf>,
    pub to_version: String,
    pub to_path: PathBuf,
    pub outcome: CarriedFileOutcome,
}

pub(crate) fn decode_outcome(text: &str) -> Option<CarriedFileOutcome> {
    // The SQL caller also bounds the value before loading it from SQLite.
    if text.len() > 65_536 {
        return None;
    }
    let outcome: CarriedFileOutcome = serde_json::from_str(text).ok()?;
    if [
        &outcome.carried,
        &outcome.removed,
        &outcome.kept_separately,
        &outcome.source_unreadable,
        &outcome.new_version_ships_file,
    ]
    .iter()
    .any(|paths| paths.len() > 64)
    {
        return None;
    }
    if let Some(counts) = &outcome.counts
        && [
            (counts.carried, outcome.carried.len()),
            (counts.removed, outcome.removed.len()),
            (counts.kept_separately, outcome.kept_separately.len()),
            (counts.source_unreadable, outcome.source_unreadable.len()),
            (
                counts.new_version_ships_file,
                outcome.new_version_ships_file.len(),
            ),
        ]
        .iter()
        .any(|(count, examples)| *count < *examples as u64)
    {
        return None;
    }
    Some(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ArtifactIdentity, InstallRecord, Library, ReleaseChannel};

    fn legacy_outcome() -> serde_json::Value {
        serde_json::json!({
            "carried": ["settings/extra.ini"], "removed": [],
            "kept_separately": ["notes.txt"], "source_unreadable": [],
            "new_version_ships_file": [], "insufficient_space": false,
            "source_modified": false
        })
    }

    #[test]
    fn legacy_path_examples_do_not_become_complete_counts() {
        let outcome = decode_outcome(&legacy_outcome().to_string()).unwrap();
        assert_eq!(outcome.kept_separately, ["notes.txt"]);
        assert!(outcome.counts.is_none());
        assert!(outcome.carried_bytes.is_none());
        assert!(decode_outcome("{}").is_none());
        assert!(decode_outcome("not json").is_none());
        let mut excessive = legacy_outcome();
        excessive["carried"] = serde_json::json!(vec!["file"; 65]);
        assert!(decode_outcome(&excessive.to_string()).is_none());
        let mut contradictory = legacy_outcome();
        contradictory["counts"] = serde_json::json!({
            "carried": 0, "removed": 0, "kept_separately": 0,
            "source_unreadable": 0, "new_version_ships_file": 0
        });
        assert!(decode_outcome(&contradictory.to_string()).is_none());
    }

    #[test]
    fn status_binds_the_outcome_to_the_active_target_and_retains_missing_source_honestly() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        for id in ["source", "target"] {
            library
                .register_install(
                    &InstallRecord {
                        id: id.into(),
                        port_id: "lighthouse".into(),
                        version: format!("{id}-version"),
                        path: temporary.path().join(id),
                        channel: ReleaseChannel::Stable,
                        installed_at: Library::now(),
                        verified: true,
                        staged: false,
                        artifact: ArtifactIdentity::default(),
                        manifest_sha256: String::new(),
                        selected_executable: PathBuf::new(),
                        runtime: None,
                    },
                    true,
                )
                .unwrap();
        }
        let mut connection = library.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        crate::carry_ledger::put_outcome(
            &transaction,
            "lighthouse",
            "source",
            "target",
            &legacy_outcome(),
        )
        .unwrap();
        transaction.commit().unwrap();
        let status = library
            .status("lighthouse", ReleaseChannel::Stable)
            .unwrap();
        let outcome = status.carried_files.unwrap();
        assert_eq!(outcome.to_install_id, status.active.unwrap().id);
        assert_eq!(outcome.from_version.as_deref(), Some("source-version"));
        assert_eq!(outcome.from_path, Some(temporary.path().join("source")));
        connection
            .execute(
                "UPDATE port_settings SET active_install_id='source' WHERE port_id='lighthouse'",
                [],
            )
            .unwrap();
        assert!(
            library
                .status("lighthouse", ReleaseChannel::Stable)
                .unwrap()
                .carried_files
                .is_none()
        );
        connection.execute("UPDATE port_settings SET active_install_id='target', previous_install_id=NULL WHERE port_id='lighthouse'", []).unwrap();
        connection
            .execute("DELETE FROM installs WHERE id='source'", [])
            .unwrap();
        let outcome = library
            .status("lighthouse", ReleaseChannel::Stable)
            .unwrap()
            .carried_files
            .unwrap();
        assert_eq!(outcome.from_install_id, "source");
        assert!(outcome.from_path.is_none());
        assert!(outcome.from_version.is_none());

        // Future formats and malformed or oversized data are optional disclosure,
        // not a reason to break the Library's otherwise usable status.
        connection
            .execute("UPDATE carried_file_outcomes SET format=99", [])
            .unwrap();
        assert!(
            library
                .status("lighthouse", ReleaseChannel::Stable)
                .unwrap()
                .carried_files
                .is_none()
        );
        connection
            .execute(
                "UPDATE carried_file_outcomes SET format=1, outcome='{}'",
                [],
            )
            .unwrap();
        assert!(
            library
                .status("lighthouse", ReleaseChannel::Stable)
                .unwrap()
                .carried_files
                .is_none()
        );
        connection
            .execute(
                "UPDATE carried_file_outcomes SET from_install_id=x'736f75726365', outcome=?1",
                [legacy_outcome().to_string()],
            )
            .unwrap();
        assert!(
            library
                .status("lighthouse", ReleaseChannel::Stable)
                .unwrap()
                .carried_files
                .is_none()
        );
        connection
            .execute(
                "UPDATE carried_file_outcomes SET from_install_id='source'",
                [],
            )
            .unwrap();
        let unicode = serde_json::json!({"unused": "😀".repeat(20_000)}).to_string();
        assert!(unicode.chars().count() < 65_536 && unicode.len() > 65_536);
        connection
            .execute("UPDATE carried_file_outcomes SET outcome=?1", [&unicode])
            .unwrap();
        assert!(
            library
                .status("lighthouse", ReleaseChannel::Stable)
                .unwrap()
                .carried_files
                .is_none()
        );
    }
}
