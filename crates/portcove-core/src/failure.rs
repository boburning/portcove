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
    pub(crate) catalog_fallback: Option<crate::CatalogFallbackCode>,
    upstream: Option<UpstreamObservation>,
    /// Set where a connection was interrupted, stalled or starved: the
    /// network failed, not the requested content.
    transient_transport: bool,
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
    /// Timeouts, and connect failures with a concrete socket-level cause.
    /// Proxy-tunnel and TLS failures also surface as connect errors but carry
    /// no such cause, so they never count as upstream disappearance.
    pub(crate) fn from_reqwest(error: &reqwest::Error) -> Option<Self> {
        if error.is_timeout() {
            return Some(Self::Transport { timed_out: true });
        }
        (error.is_connect() && socket_unreachable(error))
            .then_some(Self::Transport { timed_out: false })
    }
}

fn socket_unreachable(error: &(dyn std::error::Error + 'static)) -> bool {
    use std::io::ErrorKind;
    std::iter::successors(Some(error), |error| error.source()).any(|error| {
        error.downcast_ref::<std::io::Error>().is_some_and(|io| {
            matches!(
                io.kind(),
                ErrorKind::ConnectionRefused
                    | ErrorKind::ConnectionReset
                    | ErrorKind::ConnectionAborted
                    | ErrorKind::TimedOut
                    | ErrorKind::HostUnreachable
                    | ErrorKind::NetworkUnreachable
            )
        })
    })
}

/// Facts attached at the refusing domain branch, never recovered from diagnostics.
#[derive(Debug)]
pub(crate) enum KnownFailureCause {
    /// No operating-system secure credential store is available on this host.
    CredentialStoreUnavailable,
    /// The secure credential store exists but is locked or refused access.
    CredentialStoreLocked,
    HostLocalCredential {
        path: std::path::PathBuf,
    },
    RecordedUploaderHold,
    /// An exact release review, pin or saved pin was refused for a reason the
    /// player can act on.
    ExactRelease(crate::release::ExactReleaseRefusal),
    PackageShapeDrift,
    CatalogValidity,
    CatalogReplay,
    OriginalEmbeddedInRuntime,
    NewerLibrary,
    IncompleteLibrary,
    Busy,
    CancellationUnavailable,
    OperationInterrupted,
    /// A waiting setup's retained download could not be read right now, for
    /// example while another program had it open. Nothing was recorded.
    RetainedDownloadUnreadable,
    RequiredRuntimeUnverified,
    LaunchArgumentsUnsupported,
    SourceChanged,
    AmbiguousAdoption,
    StaleRemoval,
    PortableRuntimeModified {
        directory: std::path::PathBuf,
        failures: Vec<String>,
    },
    PortableDataContractChanged,
    #[cfg(any(test, windows))]
    SettingsDefaultsConflict,
    #[cfg(any(test, windows))]
    SettingsDefaultsUnverified,
    /// A reviewed settings change no longer matches the current file or
    /// installation, so Core refused it before taking custody.
    #[cfg(any(test, windows))]
    SettingsReviewStale,
    /// Two copies of a settings file a newer version newly carries differ, so
    /// Core cannot tell which to keep. `other` is the saved copy, or the new
    /// version's copy when `other_is_saved` is false.
    AppendedSettingsDiverged {
        file: String,
        installed: std::path::PathBuf,
        other: std::path::PathBuf,
        other_is_saved: bool,
    },
    /// Something other than an ordinary settings file of at most 16 MiB is at
    /// a newly declared settings file path.
    AppendedSettingsPathBlocked {
        path: std::path::PathBuf,
    },
    ManagedRouteCommitted {
        version: String,
        previous_path: std::path::PathBuf,
        current_confirmed: bool,
    },
    NativeModListReview,
    RestoreRecovery,
    BackupDeletionRecovery,
    TfePreparationRecovery {
        directory: std::path::PathBuf,
    },
    DestinationCapacity,
    /// The operating system reported a full drive or quota while writing.
    StorageFull,
    MetadataExportExists,
    ArchiveLimit,
    UnicodePath,
    RuntimePathRequirement,
    OpenSurgeUserDataPath,
    /// The package is not a LIVE or PIRS package in the read-only STFS layout.
    UnsupportedStfs,
    /// The STFS package is a different game or content type than the port requires.
    StfsPackageMismatch {
        found: String,
        expected: Vec<String>,
    },
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
    GithubDeviceCodeExpired,
    GithubDeviceAuthorizationDenied,
    ProviderRequest {
        provider: FailureProvider,
        status: u16,
        rate_limited: bool,
        resets_at: Option<i64>,
    },
    /// The provider already reported this client's allowance used up, or asked it
    /// to wait, so Core did not send the request. Nothing was learned about the
    /// requested resource.
    ProviderAllowanceExhausted {
        provider: FailureProvider,
        resets_at: Option<i64>,
        /// The provider asked the client to wait (a secondary limit or throttle)
        /// rather than reporting its primary allowance spent.
        throttled: bool,
        /// Whether the provider reported `resets_at`, or Portcove estimated it.
        reset_reported: bool,
        /// Whose allowance: signed in (per account) or anonymous (per network
        /// address). `None` when the failure does not say.
        signed_in: Option<bool>,
    },
    /// A provider listing the decision depends on was read only in part this
    /// time (a page budget, a partial listing or a mixed-time snapshot): the
    /// work continues from where it stopped on the next attempt. Incomplete
    /// is never an absent release, package or file. Always temporary, and it
    /// waits until `resets_at` when the provider stated one.
    InventoryIncomplete {
        provider: FailureProvider,
        /// What was being listed, such as `release history`.
        inventory: &'static str,
        /// Pages or chunks already read and kept for the next attempt.
        read: u64,
        /// Pages or chunks the provider listed, when it said.
        total: Option<u64>,
        resets_at: Option<i64>,
        /// A provider allowance or throttle cut the listing short, so work that
        /// shares that allowance waits too (a bulk update check defers the rest
        /// rather than sending them).
        rate_limited: bool,
    },
}

/// Whether a failure means a provider allowance or throttle stopped the request,
/// as opposed to an answer about the requested resource.
pub(crate) fn is_rate_limited(error: &PortcoveError) -> bool {
    matches!(
        error.known_cause(),
        Some(
            KnownFailureCause::ProviderRequest {
                rate_limited: true,
                ..
            } | KnownFailureCause::ProviderAllowanceExhausted { .. }
                | KnownFailureCause::InventoryIncomplete {
                    rate_limited: true,
                    ..
                }
        )
    )
}

/// The release provider whose allowance or throttle stopped this request.
pub(crate) fn rate_limited_provider(error: &PortcoveError) -> Option<crate::ReleaseSource> {
    let provider = match error.known_cause()? {
        KnownFailureCause::ProviderRequest {
            provider,
            rate_limited: true,
            ..
        }
        | KnownFailureCause::ProviderAllowanceExhausted { provider, .. }
        | KnownFailureCause::InventoryIncomplete {
            provider,
            rate_limited: true,
            ..
        } => *provider,
        _ => return None,
    };
    Some(match provider {
        FailureProvider::Github => crate::ReleaseSource::Github,
        FailureProvider::Gitlab => crate::ReleaseSource::Gitlab,
        // Not a release provider: no update-check allowance to defer.
        FailureProvider::Thunderstore => return None,
    })
}

/// The failure of an item that was not sent because `cause` already stopped the
/// same provider allowance. `None` when `cause` is not a rate limit.
pub(crate) fn deferred_after(cause: &PortcoveError) -> Option<PortcoveError> {
    let (provider, resets_at, throttled, reset_reported, signed_in) = match cause.known_cause()? {
        KnownFailureCause::ProviderRequest {
            provider,
            rate_limited: true,
            resets_at,
            ..
        } => (
            *provider,
            *resets_at,
            cause.details.get("rate_remaining").map(String::as_str) != Some("0"),
            resets_at.is_some(),
            cause
                .details
                .get("rate_limit_credential")
                .map(|credential| credential == "authenticated"),
        ),
        KnownFailureCause::ProviderAllowanceExhausted {
            provider,
            resets_at,
            throttled,
            reset_reported,
            signed_in,
        } => (
            *provider,
            *resets_at,
            *throttled,
            *reset_reported,
            *signed_in,
        ),
        // A listing a rate limit cut short keeps the stopping request's details.
        KnownFailureCause::InventoryIncomplete {
            provider,
            resets_at,
            rate_limited: true,
            ..
        } => (
            *provider,
            *resets_at,
            cause.details.get("rate_remaining").map(String::as_str) != Some("0"),
            resets_at.is_some(),
            cause
                .details
                .get("rate_limit_credential")
                .map(|credential| credential == "authenticated"),
        ),
        _ => return None,
    };
    let mut error = PortcoveError::network(
        "Not sent: the provider's request allowance stopped an earlier request in the same batch.",
    )
    .with_known_cause(KnownFailureCause::ProviderAllowanceExhausted {
        provider,
        resets_at,
        throttled,
        reset_reported,
        signed_in,
    })
    .detail("rate_limit_deferred", "true");
    for key in [
        "rate_limit",
        "rate_remaining",
        "rate_reset",
        "retry_after",
        "rate_limit_credential",
    ] {
        if let Some(value) = cause.details.get(key) {
            error.details.insert(key.into(), value.clone());
        }
    }
    Some(error)
}

/// A provider reset instant (Unix seconds) as RFC 3339, for presentation.
fn reset_time(resets_at: Option<i64>) -> Option<String> {
    resets_at
        .and_then(|seconds| time::OffsetDateTime::from_unix_timestamp(seconds).ok())
        .and_then(|time| {
            time.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
}

fn reset_sentence(resets_at: Option<i64>) -> String {
    reset_time(resets_at).map_or_else(String::new, |time| {
        format!(" The provider reported a reset time of {time}.")
    })
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum FailureProvider {
    Github,
    Gitlab,
    Thunderstore,
}

impl FailureProvider {
    fn name(self) -> &'static str {
        match self {
            Self::Github => "GitHub",
            Self::Gitlab => "GitLab",
            Self::Thunderstore => "Thunderstore",
        }
    }
}

/// Detail key every incomplete provider listing carries, shared by the
/// GitHub, GitLab and Thunderstore readers.
pub(crate) const INVENTORY_INCOMPLETE_DETAIL: &str = "inventory";

/// An incomplete provider listing: typed cause plus the shared details.
pub(crate) fn inventory_incomplete(
    provider: FailureProvider,
    inventory: &'static str,
    read: u64,
    total: Option<u64>,
) -> PortcoveError {
    let mut error = PortcoveError::network(format!(
        "the {} {inventory} was read only in part; trying again continues where it stopped",
        provider.name()
    ))
    .detail(INVENTORY_INCOMPLETE_DETAIL, "incomplete")
    .detail("inventory_read", read.to_string());
    if let Some(total) = total {
        error = error.detail("inventory_total", total.to_string());
    }
    error.with_known_cause(KnownFailureCause::InventoryIncomplete {
        provider,
        inventory,
        read,
        total,
        resets_at: None,
        rate_limited: false,
    })
}

/// An incomplete provider listing caused by `cause`, a request that did not
/// complete. The cause's details (status facts, `retry_after`) are kept, its
/// message becomes the `cause` detail, and any wait it states (a rate-limit
/// reset or `Retry-After`) becomes the listing's own `resets_at`, so the
/// retry schedule still honors it.
pub(crate) fn inventory_incomplete_after(
    provider: FailureProvider,
    inventory: &'static str,
    read: u64,
    total: Option<u64>,
    cause: PortcoveError,
) -> PortcoveError {
    let temporary = cause.temporary_cause();
    let resets_at = temporary.and_then(|(_, reset)| reset);
    // A throttle or spent allowance stays one, so work sharing that allowance waits.
    let limited = is_rate_limited(&cause)
        || temporary.is_some_and(|(kind, _)| kind == crate::TemporaryCause::RateLimited);
    let mut error = inventory_incomplete(provider, inventory, read, total)
        .detail("cause", cause.message.clone());
    for (name, value) in cause.details {
        error.details.entry(name).or_insert(value);
    }
    if let Some(KnownFailureCause::InventoryIncomplete {
        resets_at: reset,
        rate_limited,
        ..
    }) = error.failure.known_cause.as_mut()
    {
        *reset = resets_at;
        *rate_limited = limited;
    }
    error
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
            Self::CredentialStoreUnavailable => (
                "credential_store_unavailable",
                "This device has no secure credential storage that Portcove can use, so Portcove can't read or save the credential this task needs. On Linux, sign in to a desktop session where a keyring service such as GNOME Keyring or KWallet is running, then try again.",
            ),
            Self::CredentialStoreLocked => (
                "credential_store_locked",
                "Secure credential storage on this device is locked or refused access, so Portcove can't read or save the credential this task needs. Unlock it or allow access, for example to your login keyring or keychain, then try again.",
            ),
            Self::RecordedUploaderHold => (
                "recorded_uploader_hold",
                "Portcove couldn't confirm the uploader for this version. Check for updates to find a version Portcove can confirm.",
            ),
            Self::PackageShapeDrift => (
                "package_shape_drift",
                "This release changed some of the files or folders Portcove checks before installing. It is waiting for review. You can still use an installed version.",
            ),
            Self::CatalogValidity => (
                "catalog_validity_rejected",
                "The signed catalog sequence or validity period was not accepted. Check the system clock and obtain a current catalog from its configured source.",
            ),
            Self::CatalogReplay => (
                "catalog_replay_rejected",
                "This catalog revision has already been seen or is older than the recorded revision. Check for a newer catalog; do not reset the library's trust history.",
            ),
            Self::OriginalEmbeddedInRuntime => (
                "original_embedded_in_runtime",
                "This runtime already contains prepared game data. Prepare another runtime to use a different original.",
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
            Self::RetainedDownloadUnreadable => (
                "retained_download_unreadable",
                "Portcove couldn’t read the downloaded files right now, so your setup wasn’t changed. Close any program that might be using them, then try again.",
            ),
            Self::RequiredRuntimeUnverified => (
                "required_runtime_unverified",
                "This installation's required runtime could not be verified. Review its runtime requirements and current installation; use an offered compatible update or repair when available.",
            ),
            Self::LaunchArgumentsUnsupported => (
                "launch_arguments_unsupported",
                "This launch uses a fixed set of arguments. Run it again without extra arguments.",
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
                        "Package files changed or went missing, or unrecognized programs, scripts or libraries were added. This operation stopped and preserved the current files. Back up your changes to a separate folder, then restore changed or missing package files from the accepted package and move the added programs, scripts or libraries before reviewing and trying again. Declared player data is handled separately. A preserved unknown file is not automatically safe to add to a replacement.\nInstallation: {}\nAffected package paths:\n{}{}",
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
            #[cfg(any(test, windows))]
            Self::SettingsDefaultsConflict => (
                "settings_defaults_conflict",
                "Your settings and the new version’s defaults changed in different ways. Portcove kept your settings and the new defaults. You can keep using the installed version while the update waits.",
            ),
            #[cfg(any(test, windows))]
            Self::SettingsReviewStale => (
                "settings_review_stale",
                "This settings file changed after you reviewed it, so your changes weren’t saved. Read the settings again, then review your changes.",
            ),
            #[cfg(any(test, windows))]
            Self::SettingsDefaultsUnverified => (
                "settings_defaults_unverified",
                "Portcove couldn’t verify the settings defaults for both versions. The update is waiting. Keep using the installed version until verified defaults are available.",
            ),
            Self::AppendedSettingsDiverged {
                file,
                installed,
                other,
                other_is_saved,
            } => {
                let (where_other, other_label) = if *other_is_saved {
                    ("your saved settings", "Saved copy")
                } else {
                    ("the new version", "New version's copy")
                };
                return (
                    "appended_settings_diverged",
                    format!(
                        "The settings file {file} is different in the version you're using now and in {where_other}, so Portcove can't tell which one to keep. Both copies were kept. Delete the copy you don't want, then try again.\nCopy in the version you're using now: {}\n{other_label}: {}",
                        installed.display(),
                        other.display()
                    ),
                );
            }
            Self::AppendedSettingsPathBlocked { path } => {
                return (
                    "appended_settings_path_blocked",
                    format!(
                        "Portcove can't carry over this game's settings because the item at this settings file location is not an ordinary settings file, or is larger than 16 MB. Nothing there was changed. Move that item out of the folder, then try again.\nLocation: {}",
                        path.display()
                    ),
                );
            }
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
            Self::NativeModListReview => (
                "native_mod_list_review",
                "Review the enabled mods and their dependencies in Setups and mods before playing again.",
            ),
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
            Self::ExactRelease(refusal) => return refusal.presentation(),
            Self::MetadataExportExists => (
                "metadata_export_exists",
                "Portcove kept the existing file. Choose a new filename to export library information.",
            ),
            Self::DestinationCapacity => (
                "destination_space_insufficient",
                "The prepared files cannot fit in the available destination space. Free space or select a suitable destination, then review the operation again.",
            ),
            Self::InventoryIncomplete {
                provider,
                inventory,
                read,
                total,
                ..
            } => {
                let progress = total.map_or_else(
                    || format!(" ({read} parts read)"),
                    |total| format!(" ({read} of {total} parts read)"),
                );
                return (
                    "inventory_incomplete",
                    format!(
                        "Portcove read only part of the {} {inventory} this time{progress}. Nothing was concluded from the missing part, and Portcove will try again from where it stopped.",
                        provider.name()
                    ),
                );
            }
            Self::StorageFull => (
                "storage_full",
                "The drive ran out of free space before Portcove finished. Free up space on that drive, then review the action again.",
            ),
            Self::ArchiveLimit => (
                "archive_safety_limit",
                "The archive exceeds a supported extraction safety limit. Obtain a supported package; do not bypass the limit or use its partially extracted files.",
            ),
            Self::UnicodePath => (
                "path_not_representable",
                "Portcove can’t read this file or folder name correctly. Choose a location with a valid Unicode name so Portcove can identify the exact files.",
            ),
            Self::OpenSurgeUserDataPath => (
                "opensurge_user_data_path_unsupported",
                "Open Surge can save to the wrong folder when this Windows library path contains characters outside basic Latin. Use a library path with only basic Latin characters for this game.",
            ),
            Self::RuntimePathRequirement => (
                "runtime_path_requirement",
                "This game port needs a shorter installation folder using basic Latin characters. Choose a folder such as C:\\Games\\Portcove in setup options, then review the installation again. Review the original-file location too when the runtime uses it directly.",
            ),
            Self::UnsupportedStfs => (
                "stfs_format_unsupported",
                "This source is not a supported Xbox 360 package. Select the original LIVE or PIRS package for this game and review the source again.",
            ),
            Self::StfsPackageMismatch { found, expected } => {
                return (
                    "stfs_package_mismatch",
                    format!(
                        "This package is for a different game or is not the full game ({found}; needs {}). Select the original game package.",
                        expected.join(" or ")
                    ),
                );
            }
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
            Self::GithubDeviceCodeExpired => (
                "github_device_code_expired",
                "The GitHub sign-in code expired. Choose Sign in with GitHub to get a new code.",
            ),
            Self::GithubDeviceAuthorizationDenied => (
                "github_device_authorization_denied",
                "GitHub sign-in was cancelled. Choose Sign in with GitHub to try again.",
            ),
            Self::ProviderRequest {
                provider,
                status,
                rate_limited,
                resets_at,
            } => {
                let provider = provider.name();
                if *status == 401 {
                    return (
                        "provider_sign_in_rejected",
                        format!(
                            "{provider} rejected the API sign-in (HTTP 401). Review the configured credentials or use anonymous access where supported."
                        ),
                    );
                }
                if *rate_limited {
                    let reset = reset_sentence(*resets_at);
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
            Self::ProviderAllowanceExhausted {
                provider,
                resets_at,
                throttled,
                reset_reported,
                signed_in,
            } => {
                let provider = provider.name();
                let cause = match (throttled, signed_in) {
                    (true, _) => format!("{provider} asked Portcove to wait before more requests"),
                    (false, Some(true)) => format!(
                        "The {provider} request allowance for your signed-in account is used up"
                    ),
                    (false, Some(false)) => format!(
                        "The {provider} request allowance for anonymous requests from this network is used up"
                    ),
                    (false, None) => format!("The {provider} request allowance is used up"),
                };
                let reset = reset_time(*resets_at);
                let next = match (reset, reset_reported) {
                    (Some(time), true) => format!("Resets: {time}. Try again after then."),
                    (Some(time), false) => format!(
                        "Resets: about {time} (estimated by Portcove). Try again after then."
                    ),
                    (None, _) => "The reset time is unknown. Try again later.".to_owned(),
                };
                return (
                    "provider_rate_limited",
                    format!(
                        "{cause}, so Portcove did not send this request and nothing changed. {next}"
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
    /// The deferral this failure represents for an update check, when a provider
    /// allowance or throttle stopped it rather than an answer about the game.
    pub fn update_check_deferral(&self) -> Option<crate::UpdateCheckDeferral> {
        match self.known_cause()? {
            KnownFailureCause::ProviderRequest {
                rate_limited: true,
                resets_at,
                ..
            } => Some(crate::UpdateCheckDeferral {
                resets_at: *resets_at,
                reset_reported: resets_at.is_some(),
            }),
            KnownFailureCause::ProviderAllowanceExhausted {
                resets_at,
                reset_reported,
                ..
            } => Some(crate::UpdateCheckDeferral {
                resets_at: *resets_at,
                reset_reported: *reset_reported && resets_at.is_some(),
            }),
            // The reset of a cut-short listing is the provider's stated wait.
            KnownFailureCause::InventoryIncomplete {
                resets_at,
                rate_limited: true,
                ..
            } => Some(crate::UpdateCheckDeferral {
                resets_at: *resets_at,
                reset_reported: resets_at.is_some(),
            }),
            _ => None,
        }
    }

    pub fn report(&self) -> FailureReport {
        let mut details = self.details.clone();
        if let Some(code) = self.catalog_fallback() {
            details.insert("catalog_fallback_code".into(), code.as_str().into());
        }
        FailureReport {
            code: self.code,
            message: self.message.clone(),
            details,
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

    pub(crate) fn known_cause(&self) -> Option<&KnownFailureCause> {
        self.failure.known_cause.as_ref()
    }

    /// Whether a provider listing stopped before its end; the item asked for
    /// is not known to be absent.
    pub(crate) fn is_inventory_incomplete(&self) -> bool {
        matches!(
            self.failure.known_cause,
            Some(KnownFailureCause::InventoryIncomplete { .. })
        )
    }

    pub(crate) fn is_recorded_uploader_hold(&self) -> bool {
        matches!(
            self.failure.known_cause,
            Some(KnownFailureCause::RecordedUploaderHold)
        )
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

    pub(crate) fn upstream_observation(&self) -> Option<UpstreamObservation> {
        self.failure.upstream
    }

    /// Marks a transport interruption (reset, early close, stall or starved
    /// connection). Temporary classification is opt-in: an unmarked
    /// network-coded error without a status stays lasting.
    pub(crate) fn transient_transport(mut self) -> Self {
        self.failure.transient_transport = true;
        self
    }

    pub(crate) fn is_transient_transport(&self) -> bool {
        self.failure.transient_transport
    }

    /// A network-coded failure while reading a body that recorded no status is
    /// an interrupted body (temporary); limit and parse failures keep their
    /// own lasting codes.
    pub(crate) fn mark_interrupted_body(self) -> Self {
        if self.code == crate::ErrorCode::Network && self.failure.upstream.is_none() {
            self.transient_transport()
        } else {
            self
        }
    }

    /// The one conversion for a failed HTTP exchange: it records the
    /// transport observation, and marks connection interruptions (resets,
    /// early closes, a body cut off mid-stream, stalls, DNS/TLS/connect
    /// failures) temporary. Builder, redirect-policy and status errors stay
    /// lasting; a status is recorded separately by the caller.
    ///
    /// Body errors: reqwest reports a body stream that ends early as a decode
    /// error ("error decoding response body"), so `is_decode` here is a
    /// truncated body and stays temporary. A body that arrives complete but is
    /// not the expected document is never converted here: Portcove reads the
    /// bytes and parses them with its own code, whose unmarked failure stays
    /// lasting. Do not pass errors from `Response::json`/`text` to this
    /// conversion, which cannot tell such a malformed body from a cut-off one.
    pub(crate) fn from_transport(error: &reqwest::Error) -> Self {
        let converted = Self::network(error.to_string())
            .with_upstream(UpstreamObservation::from_reqwest(error));
        if error.is_builder() || error.is_redirect() || error.is_status() {
            converted
        } else {
            converted.transient_transport()
        }
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
            (Some(KnownFailureCause::ProviderAllowanceExhausted { .. }), _) => (None, true),
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
        // A credential store that could not be used before anything changed has
        // a device step in its summary; there is no operation state to review.
        let nothing_to_review = self.failure.mutation_state == MutationState::NoChanges
            && matches!(
                self.failure.known_cause,
                Some(
                    KnownFailureCause::CredentialStoreUnavailable
                        | KnownFailureCause::CredentialStoreLocked
                )
            );
        for action in [
            RecoveryAction::ReviewCurrentState,
            RecoveryAction::ViewTechnicalDetails,
        ] {
            if action == RecoveryAction::ReviewCurrentState && nothing_to_review {
                continue;
            }
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

    fn allowance_refusal(
        resets_at: Option<i64>,
        throttled: bool,
        reset_reported: bool,
        signed_in: Option<bool>,
    ) -> PortcoveError {
        PortcoveError::network("not sent").with_known_cause(
            KnownFailureCause::ProviderAllowanceExhausted {
                provider: FailureProvider::Github,
                resets_at,
                throttled,
                reset_reported,
                signed_in,
            },
        )
    }

    #[test]
    fn allowance_refusal_copy_names_whose_allowance_and_how_the_reset_is_known() {
        let summary = |error: PortcoveError| error.presentation().summary;
        let account = summary(allowance_refusal(Some(1_600), false, true, Some(true)));
        assert!(account.starts_with("The GitHub request allowance for your signed-in account"));
        assert!(
            account.contains("Resets: 1970-01-01T00:26:40Z. "),
            "{account}"
        );
        let anonymous = summary(allowance_refusal(Some(1_600), false, false, Some(false)));
        assert!(anonymous.contains("anonymous requests from this network"));
        assert!(anonymous.contains("Resets: about 1970-01-01T00:26:40Z (estimated by Portcove)."));
        let unknown = summary(allowance_refusal(None, false, false, None));
        assert!(unknown.starts_with("The GitHub request allowance is used up"));
        assert!(unknown.contains("The reset time is unknown."));
        let throttled = summary(allowance_refusal(None, true, false, Some(true)));
        assert!(throttled.starts_with("GitHub asked Portcove to wait"));
        for text in [account, anonymous, unknown, throttled] {
            assert!(!text.contains("computer"), "{text}");
            assert!(!text.contains("waited"), "{text}");
        }
    }

    #[test]
    fn update_check_deferral_reports_a_reset_only_when_the_provider_stated_it() {
        let deferral = |error: PortcoveError| error.update_check_deferral().unwrap();
        // A provider answer with a reset states it.
        let answered = deferral(PortcoveError::network("limited").with_known_cause(
            KnownFailureCause::ProviderRequest {
                provider: FailureProvider::Github,
                status: 403,
                rate_limited: true,
                resets_at: Some(1_600),
            },
        ));
        assert_eq!(
            (answered.resets_at, answered.reset_reported),
            (Some(1_600), true)
        );
        // A provider answer without a reset: unknown, not reported.
        let unstated = PortcoveError::network("limited").with_known_cause(
            KnownFailureCause::ProviderRequest {
                provider: FailureProvider::Github,
                status: 429,
                rate_limited: true,
                resets_at: None,
            },
        );
        let unstated = deferral(unstated);
        assert_eq!((unstated.resets_at, unstated.reset_reported), (None, false));
        // A local refusal keeps whether the provider reported its time.
        let reported = deferral(allowance_refusal(Some(1_600), false, true, None));
        assert_eq!(
            (reported.resets_at, reported.reset_reported),
            (Some(1_600), true)
        );
        let estimated = deferral(allowance_refusal(Some(1_600), true, false, None));
        assert_eq!(
            (estimated.resets_at, estimated.reset_reported),
            (Some(1_600), false)
        );
        // "Reported" never stands without a time.
        let timeless = deferral(allowance_refusal(None, false, true, None));
        assert_eq!((timeless.resets_at, timeless.reset_reported), (None, false));
        // A deferred item inherits whose allowance stopped the batch.
        let stopped = provider(403, true)
            .detail("rate_remaining", "0")
            .detail("rate_limit_credential", "authenticated");
        let follower = deferred_after(&stopped).unwrap();
        assert!(matches!(
            follower.known_cause(),
            Some(KnownFailureCause::ProviderAllowanceExhausted {
                signed_in: Some(true),
                throttled: false,
                ..
            })
        ));
        // Not a rate limit: no deferral.
        assert!(provider(404, false).update_check_deferral().is_none());
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
        // Only concrete socket-level causes classify a connect failure.
        #[derive(Debug)]
        struct Wrapped(std::io::Error);
        impl std::fmt::Display for Wrapped {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("wrapped")
            }
        }
        impl std::error::Error for Wrapped {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        for (kind, expected) in [
            (std::io::ErrorKind::ConnectionRefused, true),
            (std::io::ErrorKind::NetworkUnreachable, true),
            (std::io::ErrorKind::TimedOut, true),
            // Proxy tunnel and TLS failures surface without a socket cause.
            (std::io::ErrorKind::Other, false),
            (std::io::ErrorKind::InvalidData, false),
            (std::io::ErrorKind::PermissionDenied, false),
        ] {
            assert_eq!(
                super::socket_unreachable(&Wrapped(std::io::Error::from(kind))),
                expected,
                "{kind:?}"
            );
        }
        // `None` observations leave an existing fact untouched.
        assert_eq!(
            bytes(404).with_upstream(None).upstream_failure(),
            UpstreamFailure::Unavailable
        );
    }
}
