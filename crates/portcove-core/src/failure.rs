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

/// A known item to inspect, never authorization to resume or change it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FailureRecoveryTarget {
    Preparation { port_id: String },
}

// Optional routing context must not make an otherwise readable retained failure
// disappear when a newer writer adds a target kind this reader does not know.
fn read_recovery_target<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<FailureRecoveryTarget>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FailurePresentation {
    pub presentation_key: String,
    pub summary: String,
    pub tone: FailureTone,
    pub mutation_state: MutationState,
    pub phase: Option<String>,
    pub recovery_actions: Vec<RecoveryAction>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "read_recovery_target"
    )]
    pub recovery_target: Option<FailureRecoveryTarget>,
    pub technical_message: String,
    pub technical_context: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FailureReport {
    pub code: ErrorCode,
    pub message: String,
    pub details: BTreeMap<String, String>,
    pub presentation: Box<FailurePresentation>,
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
    preparation_cause: Option<PreparationFailureCause>,
    preparation_target: Option<PreparationTarget>,
    known_cause: Option<KnownFailureCause>,
    upstream: Option<UpstreamObservation>,
}

/// Transport facts recorded where an upstream request failed. They classify
/// acquisition failover (#1306) and never change presentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpstreamObservation {
    /// The connection could not be established or a timeout budget expired.
    Transport { timed_out: bool },
    /// The upstream answered with this non-success HTTP status.
    Status(u16),
}

/// How an upstream acquisition failure relates to preserved-location failover.
/// Only `Unavailable` permits it; every other class keeps today's behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpstreamFailure {
    /// The upstream or its asset is gone or unreachable.
    Unavailable,
    /// Authentication, authorization or rate limiting refused the request.
    Forbidden,
    /// The upstream answered with identity that differs from the accepted record.
    Disagreement,
    Other,
}

impl UpstreamObservation {
    /// Connect and timeout failures only; mid-stream resets stay unclassified.
    pub(crate) fn from_reqwest(error: &reqwest::Error) -> Option<Self> {
        (error.is_connect() || error.is_timeout()).then(|| Self::Transport {
            timed_out: error.is_timeout(),
        })
    }
}

/// Facts attached at the refusing domain branch, never recovered from diagnostics.
#[derive(Debug)]
pub(crate) enum KnownFailureCause {
    HostLocalCredential {
        path: std::path::PathBuf,
    },
    CatalogValidity,
    CatalogReplay,
    NewerLibrary,
    IncompleteLibrary,
    Busy,
    CancellationUnavailable,
    OperationInterrupted,
    RequiredRuntimeUnverified,
    SourceChanged,
    AmbiguousAdoption,
    StaleRemoval,
    PortableRuntimeModified {
        directory: std::path::PathBuf,
        failures: Vec<String>,
    },
    PortableDataContractChanged,
    ManagedRouteCommitted {
        version: String,
        previous_path: std::path::PathBuf,
        current_confirmed: bool,
    },
    RestoreRecovery,
    BackupDeletionRecovery,
    TfePreparationRecovery {
        directory: std::path::PathBuf,
    },
    DestinationCapacity,
    MetadataExportExists,
    ArchiveLimit,
    UnicodePath,
    RuntimePathRequirement,
    UnsupportedStfs,
    /// The selected file is not a disc image the read-only readers accept.
    UnsupportedDiscImage,
    /// A disc image exceeded a fixed unpacking safety limit.
    DiscImageLimit,
    /// The disc is a different game or region than the port requires.
    DiscProductMismatch {
        found: String,
        expected: Vec<String>,
    },
    /// Unpacking would not fit on the destination volume.
    DiscSpace {
        required_bytes: u64,
        available_bytes: u64,
        volume: String,
    },
    DeviceLoginUnavailable,
    ProviderRequest {
        provider: FailureProvider,
        status: u16,
        rate_limited: bool,
        resets_at: Option<i64>,
    },
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum FailureProvider {
    Github,
    Gitlab,
}

fn decimal_gigabytes(bytes: u64) -> String {
    let tenths = bytes.saturating_add(50_000_000) / 100_000_000;
    format!("{}.{} GB", tenths / 10, tenths % 10)
}

impl KnownFailureCause {
    fn presentation(&self) -> (&'static str, String) {
        let (key, summary) = match self {
            Self::HostLocalCredential { path } => {
                return (
                    "host_local_credential_transfer_refused",
                    format!(
                        "Portcove stopped the transfer because this file may contain RetroAchievements sign-in information. Do not upload it.\n1. If possible, sign out in the affected game version, then close it.\n2. If the file remains, keep a private copy on this Windows computer outside the Portcove folders.\n3. Remove only the listed file from the transfer or recovery folder. Review the transfer again.\nFile: {}",
                        path.display()
                    ),
                );
            }
            Self::CatalogValidity => (
                "catalog_validity_rejected",
                "The signed catalog sequence or validity period was not accepted. Check the system clock and obtain a current catalog from its configured source.",
            ),
            Self::CatalogReplay => (
                "catalog_replay_rejected",
                "This catalog revision has already been seen or is older than the recorded revision. Check for a newer catalog; do not reset the library's trust history.",
            ),
            Self::NewerLibrary => (
                "library_version_newer",
                "This library requires a newer Portcove database version. Open it with a compatible newer Portcove build, or select another library.",
            ),
            Self::IncompleteLibrary => (
                "library_history_incomplete",
                "The library's recorded database history is incomplete or inconsistent. Preserve the library and review the technical details before recovery; do not delete or edit its database to bypass this check.",
            ),
            Self::Busy => (
                "target_busy",
                "Another task or program is using these files. Check Activity in Portcove and close the game if it’s open. Review the action again when the other task has finished.",
            ),
            Self::SourceChanged => (
                "registered_source_changed",
                "These files have changed since you added them. To use the changed files, add them again so Portcove can check them.",
            ),
            Self::CancellationUnavailable => (
                "cancellation_unavailable",
                "Cancellation is unavailable for this operation's current state. Review its current activity and result before taking another action.",
            ),
            Self::OperationInterrupted => (
                "operation_interrupted",
                "Portcove stopped before this task finished. Review the current state before trying again.",
            ),
            Self::RequiredRuntimeUnverified => (
                "required_runtime_unverified",
                "This installation's required runtime could not be verified. Review its runtime requirements and current installation; use an offered compatible update or repair when available.",
            ),
            Self::AmbiguousAdoption => (
                "adoption_ambiguous",
                "More than one matching port was detected in this folder. Select the intended port explicitly and review the adoption again.",
            ),
            Self::StaleRemoval => (
                "removal_review_stale",
                "The installations changed after the removal review. Check the updated removal details before confirming again.",
            ),
            Self::PortableRuntimeModified {
                directory,
                failures,
            } => {
                let paths = failures
                    .iter()
                    .take(8)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                let remainder = failures.len().saturating_sub(8);
                return (
                    "portable_runtime_modified",
                    format!(
                        "Package files changed, went missing, or unrecognized files were added. This operation stopped and preserved the current files. Back up your changes to a separate folder, then restore changed or missing package files from the accepted package and move unrecognized additions before reviewing and trying again. Declared player data is handled separately. A preserved unknown file is not automatically safe to add to a replacement.\nInstallation: {}\nAffected package paths:\n{}{}",
                        directory.display(),
                        paths,
                        if remainder > 0 {
                            format!("\n{remainder} more reported paths are in technical details.")
                        } else {
                            String::new()
                        }
                    ),
                );
            }
            Self::PortableDataContractChanged => (
                "portable_data_contract_changed",
                "This package changes where player data is stored or how it is located. Portcove stopped the transition and kept the current installation and files. Keep using the current version; use upstream instructions until a compatible package or supported data migration is available.",
            ),
            Self::ManagedRouteCommitted {
                version,
                previous_path,
                current_confirmed,
            } => {
                let outcome = if *current_confirmed {
                    format!("The managed copy ({version}) is now active")
                } else {
                    format!(
                        "The managed copy ({version}) was activated; its current active state is not confirmed"
                    )
                };
                return (
                    "managed_route_committed",
                    format!(
                        "{outcome}. Finishing the operation needs recovery. Restart Portcove to reconcile it, then review the current installation before continuing. Your previous external files remain at {}. They were not copied into the managed version.",
                        previous_path.display()
                    ),
                );
            }
            Self::RestoreRecovery => (
                "restore_recovery_required",
                "A backup restore is unfinished. Keep the backup and any safety copy. Reopen Portcove and check the recovery result before playing or backing up saves again.",
            ),
            Self::BackupDeletionRecovery => (
                "backup_deletion_recovery_required",
                "A backup deletion is unfinished. Reopening Portcove may finish deleting that backup. If it remains unfinished, check the recovery instructions in portcove doctor before changing other files.",
            ),
            Self::TfePreparationRecovery { directory } => {
                return (
                    "tfe_preparation_recovery_required",
                    format!(
                        "Preparation copies need manual preservation before continuing. Close the game, move the entire folder outside all Portcove installation and recovery folders, verify the preserved files, then review and retry this operation.\nFolder to preserve: {}",
                        directory.display()
                    ),
                );
            }
            Self::MetadataExportExists => (
                "metadata_export_exists",
                "Portcove kept the existing file. Choose a new filename to export library information.",
            ),
            Self::DestinationCapacity => (
                "destination_space_insufficient",
                "The prepared files cannot fit in the available destination space. Free space or select a suitable destination, then review the operation again.",
            ),
            Self::ArchiveLimit => (
                "archive_safety_limit",
                "The archive exceeds a supported extraction safety limit. Obtain a supported package; do not bypass the limit or use its partially extracted files.",
            ),
            Self::UnicodePath => (
                "path_not_representable",
                "Portcove can’t read this file or folder name correctly. Choose a location with a valid Unicode name so Portcove can identify the exact files.",
            ),
            Self::RuntimePathRequirement => (
                "runtime_path_requirement",
                "This game port needs a shorter installation folder using basic Latin characters. Choose a folder such as C:\\Games\\Portcove in setup options, then review the installation again. Review the original-file location too when the runtime uses it directly.",
            ),
            Self::UnsupportedStfs => (
                "stfs_format_unsupported",
                "This source is not a supported read-only Xbox LIVE STFS package. Select the required original package format and review the source again.",
            ),
            Self::UnsupportedDiscImage => (
                "disc_image_unsupported",
                "Portcove can’t read this disc image safely. Select an unmodified original image in a supported format, then review the source again.",
            ),
            Self::DiscImageLimit => (
                "disc_image_limit",
                "This disc image is larger or more complex than Portcove will unpack safely. Select an unmodified original image; do not use partly unpacked files.",
            ),
            Self::DiscProductMismatch { found, expected } => {
                return (
                    "disc_product_mismatch",
                    format!(
                        "This disc is a different game or region (found {found}, needs {}). Select the matching disc image.",
                        expected.join(" or ")
                    ),
                );
            }
            Self::DiscSpace {
                required_bytes,
                available_bytes,
                volume,
            } => {
                return (
                    "disc_space_insufficient",
                    format!(
                        "Unpacking needs {} free on {volume} ({} free). Free some space or choose another location, then try again.",
                        decimal_gigabytes(*required_bytes),
                        decimal_gigabytes(*available_bytes)
                    ),
                );
            }
            Self::DeviceLoginUnavailable => (
                "device_login_unavailable",
                "GitHub device sign-in is unavailable in this build. Use the offered token sign-in, or continue anonymously where supported.",
            ),
            Self::ProviderRequest {
                provider,
                status,
                rate_limited,
                resets_at,
            } => {
                let provider = match provider {
                    FailureProvider::Github => "GitHub",
                    FailureProvider::Gitlab => "GitLab",
                };
                if *status == 401 {
                    return (
                        "provider_sign_in_rejected",
                        format!(
                            "{provider} rejected the API sign-in (HTTP 401). Review the configured credentials or use anonymous access where supported."
                        ),
                    );
                }
                if *rate_limited {
                    let reset = resets_at
                        .and_then(|seconds| time::OffsetDateTime::from_unix_timestamp(seconds).ok())
                        .and_then(|time| {
                            time.format(&time::format_description::well_known::Rfc3339)
                                .ok()
                        });
                    let reset = reset.map_or_else(String::new, |time| {
                        format!(" The provider reported a reset time of {time}.")
                    });
                    return (
                        "provider_rate_limited",
                        format!(
                            "{provider} limited the API request (HTTP {status}).{reset} Wait before retrying and review the provider's current limits."
                        ),
                    );
                }
                return (
                    "provider_request_rejected",
                    format!(
                        "{provider} rejected the API request (HTTP {status}). Review the technical details and current provider status before retrying."
                    ),
                );
            }
        };
        (key, summary.into())
    }
}

#[derive(Debug)]
struct PreparationTarget {
    port_id: String,
    name: String,
}

/// Facts observed by preparation, separate from error codes or diagnostic text.
#[derive(Debug, Clone, Copy)]
pub(crate) enum PreparationFailureCause {
    SetupUnsuccessful,
    CompletionFileUnconfirmed,
}

impl PortcoveError {
    pub fn report(&self) -> FailureReport {
        FailureReport {
            code: self.code,
            message: self.message.clone(),
            details: self.details.clone(),
            presentation: Box::new(self.presentation()),
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

    pub(crate) fn with_preparation_cause(mut self, cause: PreparationFailureCause) -> Self {
        self.failure.preparation_cause = Some(cause);
        self
    }

    pub(crate) fn with_known_cause(mut self, cause: KnownFailureCause) -> Self {
        self.failure.known_cause = Some(cause);
        self
    }

    pub(crate) fn with_upstream(mut self, observation: Option<UpstreamObservation>) -> Self {
        if observation.is_some() {
            self.failure.upstream = observation;
        }
        self
    }

    /// Classify this failure for preserved-location failover from recorded facts
    /// only, never from message text.
    pub(crate) fn upstream_failure(&self) -> UpstreamFailure {
        let (status, rate_limited) = match (&self.failure.known_cause, self.failure.upstream) {
            (
                Some(KnownFailureCause::ProviderRequest {
                    status,
                    rate_limited,
                    ..
                }),
                _,
            ) => (Some(*status), *rate_limited),
            (_, Some(UpstreamObservation::Status(status))) => (Some(status), false),
            (_, Some(UpstreamObservation::Transport { .. })) => {
                return UpstreamFailure::Unavailable;
            }
            _ => (None, false),
        };
        match status {
            _ if rate_limited => UpstreamFailure::Forbidden,
            Some(401 | 403 | 407 | 429) => UpstreamFailure::Forbidden,
            Some(404 | 410) => UpstreamFailure::Unavailable,
            Some(_) => UpstreamFailure::Other,
            None if self.code == crate::ErrorCode::Verification => UpstreamFailure::Disagreement,
            None => UpstreamFailure::Other,
        }
    }

    /// The publication owner supplies its observed successful metadata commit.
    /// Failure diagnostics and optional database readback never establish it.
    pub(crate) fn mark_managed_route_committed(
        &mut self,
        install: &crate::InstallRecord,
        previous_path: &std::path::Path,
        current_confirmed: bool,
    ) {
        self.failure.mutation_state = MutationState::Committed;
        self.failure.known_cause = Some(KnownFailureCause::ManagedRouteCommitted {
            version: install.version.clone(),
            previous_path: previous_path.to_owned(),
            current_confirmed,
        });
        self.details
            .insert("committed_install_id".into(), install.id.clone());
        self.details
            .insert("committed_version".into(), install.version.clone());
        self.details
            .insert("external_files_preserved".into(), "true".into());
    }

    /// Display context from the operation's resolved definition, never diagnostics.
    pub(crate) fn with_preparation_target(mut self, port: &crate::PortDefinition) -> Self {
        let mut name: Vec<char> = redact_diagnostic_text(&port.name)
            .chars()
            .map(|character| {
                if character.is_control()
                    || matches!(character, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                {
                    ' '
                } else {
                    character
                }
            })
            .take(161)
            .collect();
        let truncated = name.len() > 160;
        name.truncate(160);
        let mut name = name.into_iter().collect::<String>().trim().to_owned();
        if truncated {
            name.push('…');
        }
        self.failure.preparation_target = Some(PreparationTarget {
            port_id: port.id.clone(),
            name,
        });
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
            ErrorCode::State
                if self.failure.phase.as_deref() == Some("preparation.interrupted") =>
            {
                (
                    "preparation_interrupted",
                    "Game preparation stopped before Portcove could confirm the result. Review the unfinished work before trying again.",
                )
            }
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
        let (key, summary) = match self.failure.preparation_cause {
            Some(PreparationFailureCause::SetupUnsuccessful) => (
                "setup_unsuccessful",
                "The setup process ended unsuccessfully.",
            ),
            Some(PreparationFailureCause::CompletionFileUnconfirmed) => (
                "setup_output_unconfirmed",
                "Setup finished, but its required completion file could not be confirmed.",
            ),
            None => (key, summary),
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
        let (key, summary) = self.failure.known_cause.as_ref().map_or_else(
            || (key, summary.to_owned()),
            KnownFailureCause::presentation,
        );
        let summary = if matches!(
            self.failure.known_cause,
            Some(KnownFailureCause::RuntimePathRequirement)
        ) && self
            .details
            .get("runtime_path_requirement")
            .map(String::as_str)
            == Some("relative-file-max-path")
        {
            "This game needs a shorter Windows installation folder for its packaged files. Choose a shorter output folder in setup options, then review the installation again.".to_owned()
        } else {
            summary
        };
        let summary: String =
            phase_label.map_or_else(|| summary.clone(), |phase| format!("{phase}: {summary}"));
        let summary = self.failure.preparation_target.as_ref().map_or_else(
            || summary.clone(),
            |target| {
                let label = if target.name.is_empty() {
                    target.port_id.clone()
                } else {
                    format!("{} ({})", target.name, target.port_id)
                };
                format!("Game preparation for {label}: {summary}")
            },
        );
        FailurePresentation {
            presentation_key: key.into(),
            summary,
            tone: if self.code == ErrorCode::Cancelled {
                FailureTone::Neutral
            } else {
                FailureTone::Error
            },
            mutation_state: self.failure.mutation_state,
            phase: self.failure.phase.clone(),
            recovery_actions,
            recovery_target: self.failure.preparation_target.as_ref().map(|target| {
                FailureRecoveryTarget::Preparation {
                    port_id: target.port_id.clone(),
                }
            }),
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

/// Redact values before JSON encoding so malformed tool text cannot damage the document.
pub fn redact_diagnostic_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                if sensitive_diagnostic_field(key) {
                    *value = serde_json::Value::String("[REDACTED]".into());
                } else {
                    redact_diagnostic_value(value);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_diagnostic_value(value);
            }
        }
        serde_json::Value::String(text) => *text = redact_diagnostic_text(text),
        _ => {}
    }
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
    let mut after = after;
    let mut prefix_len = 0;
    while let Some(tail) = after.strip_prefix("[REDACTED]") {
        prefix_len += "[REDACTED]".len();
        after = tail;
    }
    for quote in ["\\\"", "\"", "'"] {
        if let Some(value) = after.strip_prefix(quote) {
            return prefix_len
                + value
                    .find(quote)
                    .map_or(after.len(), |index| quote.len() + index + quote.len());
        }
    }
    prefix_len
        + after
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
#[path = "failure_tests.rs"]
mod tests;

#[cfg(test)]
mod upstream_classification_tests {
    use super::*;

    fn provider(status: u16, rate_limited: bool) -> PortcoveError {
        PortcoveError::network("provider").with_known_cause(KnownFailureCause::ProviderRequest {
            provider: FailureProvider::Github,
            status,
            rate_limited,
            resets_at: None,
        })
    }

    #[test]
    fn only_recorded_unavailability_permits_preserved_failover() {
        let transport = |timed_out| {
            PortcoveError::network("no connection")
                .with_upstream(Some(UpstreamObservation::Transport { timed_out }))
        };
        let bytes = |status| {
            PortcoveError::network("bytes").with_upstream(Some(UpstreamObservation::Status(status)))
        };
        for (error, expected) in [
            (provider(404, false), UpstreamFailure::Unavailable),
            (provider(410, false), UpstreamFailure::Unavailable),
            (bytes(404), UpstreamFailure::Unavailable),
            (bytes(410), UpstreamFailure::Unavailable),
            (transport(false), UpstreamFailure::Unavailable),
            (transport(true), UpstreamFailure::Unavailable),
            (provider(401, false), UpstreamFailure::Forbidden),
            (provider(403, false), UpstreamFailure::Forbidden),
            (provider(403, true), UpstreamFailure::Forbidden),
            (provider(429, false), UpstreamFailure::Forbidden),
            // A rate-limited answer is never treated as disappearance.
            (provider(404, true), UpstreamFailure::Forbidden),
            (bytes(407), UpstreamFailure::Forbidden),
            (provider(500, false), UpstreamFailure::Other),
            (bytes(502), UpstreamFailure::Other),
            (
                PortcoveError::verification("identity differs"),
                UpstreamFailure::Disagreement,
            ),
            // Message text never classifies a failure.
            (
                PortcoveError::network("HTTP status client error (404 Not Found)"),
                UpstreamFailure::Other,
            ),
            (PortcoveError::conflict("held"), UpstreamFailure::Other),
            (
                PortcoveError::new(crate::ErrorCode::Cancelled, "stopped"),
                UpstreamFailure::Other,
            ),
        ] {
            assert_eq!(error.upstream_failure(), expected, "{error:?}");
        }
        // `None` observations leave an existing fact untouched.
        assert_eq!(
            bytes(404).with_upstream(None).upstream_failure(),
            UpstreamFailure::Unavailable
        );
    }
}
