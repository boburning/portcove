use std::{
    fmt,
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use rusqlite::params;
use uuid::Uuid;

#[cfg(test)]
thread_local! {
    static ALL_READ_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

use crate::{
    ActivityRecord, InstallRecord, Library, OperationEvent, OperationEventKind, OperationResult,
    OperationTarget, OutputRelocationPlan, PortcoveError, Result, SourceImportPlan, database,
};

pub(crate) mod acquisition;
pub(crate) mod publication;

pub const OPERATION_EVENT_SCHEMA_VERSION: u32 = 3;

#[cfg(test)]
pub(crate) fn reset_all_read_count() {
    ALL_READ_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn all_read_count() -> usize {
    ALL_READ_COUNT.with(std::cell::Cell::get)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecycleOperationKind {
    Install,
    AcquireUpdate,
    Prepare,
    Adopt,
    Remove,
    Restore,
    DeleteBackup,
    Activate,
    Relocate,
    ImportSource,
    GhostshipRecovery,
}

impl fmt::Display for LifecycleOperationKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Install => "install",
            Self::AcquireUpdate => "acquire_update",
            Self::Prepare => "prepare",
            Self::Adopt => "adopt",
            Self::Remove => "remove",
            Self::Restore => "restore",
            Self::DeleteBackup => "delete_backup",
            Self::Activate => "activate",
            Self::Relocate => "relocate",
            Self::ImportSource => "import_source",
            Self::GhostshipRecovery => "ghostship_recovery",
        })
    }
}

impl FromStr for LifecycleOperationKind {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        let kind = match value {
            "install" => Some(Self::Install),
            "acquire_update" => Some(Self::AcquireUpdate),
            "prepare" => Some(Self::Prepare),
            "adopt" => Some(Self::Adopt),
            "remove" => Some(Self::Remove),
            "restore" => Some(Self::Restore),
            "delete_backup" => Some(Self::DeleteBackup),
            "activate" => Some(Self::Activate),
            "relocate" => Some(Self::Relocate),
            "import_source" => Some(Self::ImportSource),
            "ghostship_recovery" => Some(Self::GhostshipRecovery),
            _ => None,
        };
        kind.ok_or_else(|| {
            PortcoveError::state(format!("unknown lifecycle operation kind: {value}"))
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecyclePhase {
    Preparing,
    Prepared,
    PayloadPublished,
    MetadataCommitted,
    CleanupPending,
}

impl fmt::Display for LifecyclePhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Preparing => "preparing",
            Self::Prepared => "prepared",
            Self::PayloadPublished => "payload_published",
            Self::MetadataCommitted => "metadata_committed",
            Self::CleanupPending => "cleanup_pending",
        })
    }
}

impl FromStr for LifecyclePhase {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "preparing" => Ok(Self::Preparing),
            "prepared" => Ok(Self::Prepared),
            "payload_published" => Ok(Self::PayloadPublished),
            "metadata_committed" => Ok(Self::MetadataCommitted),
            "cleanup_pending" => Ok(Self::CleanupPending),
            _ => Err(PortcoveError::state(format!(
                "unknown lifecycle operation phase: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct LifecyclePaths {
    pub staging: Option<PathBuf>,
    pub final_path: Option<PathBuf>,
    pub quarantine: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub(crate) struct LifecycleOperation {
    pub id: String,
    pub kind: LifecycleOperationKind,
    pub port_id: String,
    pub phase: LifecyclePhase,
    pub paths: LifecyclePaths,
    pub install: Option<InstallRecord>,
    pub update_acquisition: Option<acquisition::AcquisitionJournal>,
    pub relocation: Option<OutputRelocationPlan>,
    pub source_import: Option<SourceImportPlan>,
    pub preparation: Option<crate::PreparationPlan>,
    pub ghostship_recovery: Option<crate::ghostship_data_store::GhostshipRecoveryIntent>,
    pub backup_deletion: Option<crate::ghostship_data_store::BackupDeletionBinding>,
    /// `Some(true)` is durable proof that no setup process from this operation
    /// can still own the private tree. `None` is legacy or non-preparation state.
    pub preparation_process_quiesced: Option<bool>,
    /// Exact registration replaced only by a verified, separately published
    /// native runtime. Absent for ordinary installs and earlier journals.
    pub external_registration_sha256: Option<String>,
    /// Exact installation identities retained through removal database deletion.
    pub removal_installs: Option<Vec<InstallRecord>>,
    pub original_paths: Vec<PathBuf>,
    pub activate: bool,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl LifecycleOperation {
    /// Codec-level family discrimination. Path and transition rules remain with
    /// the checked family, never inferred by a caller from an optional payload.
    pub(crate) fn validate_family(&self) -> Result<()> {
        use LifecycleOperationKind::*;
        if (self.install.is_some()
            && !matches!(
                self.kind,
                Install | Adopt | Prepare | Activate | GhostshipRecovery
            ))
            || (self.relocation.is_some() != (self.kind == Relocate))
            || (self.source_import.is_some() != (self.kind == ImportSource))
            || (self.preparation.is_some() && self.kind != Prepare)
            || (self.preparation_process_quiesced.is_some()
                && !matches!(self.kind, Prepare | Install))
            || (self.removal_installs.is_some() && self.kind != Remove)
            || (matches!(self.kind, Install | Adopt | Prepare)
                && matches!(
                    self.phase,
                    LifecyclePhase::Prepared
                        | LifecyclePhase::PayloadPublished
                        | LifecyclePhase::MetadataCommitted
                )
                && self.install.is_none())
            || (self.kind == Activate
                && (self.install.is_none()
                    || !matches!(
                        self.phase,
                        LifecyclePhase::Preparing | LifecyclePhase::MetadataCommitted
                    )))
        {
            return Err(PortcoveError::state(
                "lifecycle journal has a missing or foreign family payload",
            ));
        }
        validate_external_replacement(
            self.kind,
            self.activate,
            self.external_registration_sha256.as_deref(),
        )?;
        validate_private_family(
            self.kind,
            &self.port_id,
            self.ghostship_recovery.is_some(),
            self.backup_deletion.is_some(),
        )
    }

    pub fn new(
        id: impl Into<String>,
        kind: LifecycleOperationKind,
        port_id: impl Into<String>,
    ) -> Self {
        let now = Library::now();
        Self {
            id: id.into(),
            kind,
            port_id: port_id.into(),
            phase: LifecyclePhase::Preparing,
            paths: LifecyclePaths {
                staging: None,
                final_path: None,
                quarantine: None,
            },
            install: None,
            update_acquisition: None,
            relocation: None,
            source_import: None,
            preparation: None,
            ghostship_recovery: None,
            backup_deletion: None,
            preparation_process_quiesced: None,
            external_registration_sha256: None,
            removal_installs: None,
            original_paths: Vec::new(),
            activate: false,
            last_error: None,
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct OperationStore {
    library: Library,
}

impl OperationStore {
    pub fn new(library: Library) -> Self {
        Self { library }
    }

    pub fn put(&self, operation: &mut LifecycleOperation) -> Result<()> {
        operation.validate_family()?;
        acquisition::validate_journal(&self.library, operation)?;
        operation.updated_at = Library::now();
        for path in operation
            .paths
            .staging
            .iter()
            .chain(operation.paths.final_path.iter())
            .chain(operation.paths.quarantine.iter())
            .chain(operation.original_paths.iter())
        {
            crate::path::unicode(path, "lifecycle")?;
        }
        let install_json = operation
            .install
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let relocation_json = operation
            .relocation
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let source_import_json = operation
            .source_import
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let removal_installs_json = operation
            .removal_installs
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let original_paths_json = serde_json::to_string(&operation.original_paths)?;
        let preparation_json = operation
            .preparation
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let ghostship_recovery_json = operation
            .ghostship_recovery
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let backup_deletion_json = operation
            .backup_deletion
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let update_acquisition_json = operation
            .update_acquisition
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let mut connection = database::connect(self.library.root())?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        acquisition::require_capacity(&transaction, operation, update_acquisition_json.as_deref())?;
        if operation.kind != LifecycleOperationKind::AcquireUpdate {
            crate::ghostship_data_store::invalidate(&transaction, &operation.port_id)?;
        }
        transaction.execute(
            "INSERT INTO lifecycle_operations(
               id, kind, port_id, phase, staging_path, final_path, quarantine_path,
               install_json, relocation_json, source_import_json, original_paths_json, activate, last_error, created_at, updated_at, preparation_json,
               preparation_process_quiesced, ghostship_recovery_json, backup_deletion_json, external_registration_sha256, update_acquisition_json, removal_installs_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
             ON CONFLICT(id) DO UPDATE SET
               kind=excluded.kind,
               port_id=excluded.port_id,
               phase=excluded.phase,
               staging_path=excluded.staging_path,
               final_path=excluded.final_path,
               quarantine_path=excluded.quarantine_path,
               install_json=excluded.install_json,
                relocation_json=excluded.relocation_json,
                source_import_json=excluded.source_import_json,
               original_paths_json=excluded.original_paths_json,
               preparation_json=excluded.preparation_json,
               preparation_process_quiesced=excluded.preparation_process_quiesced,
               ghostship_recovery_json=excluded.ghostship_recovery_json,
               backup_deletion_json=excluded.backup_deletion_json,
               external_registration_sha256=excluded.external_registration_sha256,
               update_acquisition_json=excluded.update_acquisition_json,
               removal_installs_json=excluded.removal_installs_json,
               activate=excluded.activate,
               last_error=excluded.last_error,
               updated_at=excluded.updated_at",
            params![
                operation.id,
                operation.kind.to_string(),
                operation.port_id,
                operation.phase.to_string(),
                path_string(operation.paths.staging.as_ref())?,
                path_string(operation.paths.final_path.as_ref())?,
                path_string(operation.paths.quarantine.as_ref())?,
                install_json,
                relocation_json,
                source_import_json,
                original_paths_json,
                operation.activate as i64,
                operation.last_error,
                operation.created_at,
                operation.updated_at,
                preparation_json,
                operation.preparation_process_quiesced.map(i64::from),
                ghostship_recovery_json,
                backup_deletion_json,
                operation.external_registration_sha256,
                update_acquisition_json,
                removal_installs_json,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        database::connect(self.library.root())?
            .execute("DELETE FROM lifecycle_operations WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn all(&self) -> Result<Vec<LifecycleOperation>> {
        #[cfg(test)]
        ALL_READ_COUNT.with(|count| count.set(count.get() + 1));
        self.read(None)
    }

    pub fn get(&self, id: &str) -> Result<Option<LifecycleOperation>> {
        Ok(self.read(Some(id))?.pop())
    }

    /// Observation only: complete enumeration can contain undecodable rows.
    /// This inventory must never authorize recovery, cleanup or mutation.
    pub(crate) fn diagnostic_inventory(&self) -> Result<DiagnosticInventory> {
        #[cfg(test)]
        ALL_READ_COUNT.with(|count| count.set(count.get() + 1));
        let connection = database::connect(self.library.root())?;
        let mut statement = connection.prepare(&format!(
            "{LIFECYCLE_COLUMNS} ORDER BY created_at, rowid LIMIT 4097"
        ))?;
        let mut rows = statement.query([])?;
        let mut decoded = Vec::new();
        let mut problems = Vec::new();
        let mut enumerated_rows = 0;
        let mut acquisition_owners = std::collections::HashSet::new();
        while let Some(row) = rows.next()? {
            enumerated_rows += 1;
            if enumerated_rows > 4096 {
                return Err(PortcoveError::state(
                    "journal diagnostic enumeration exceeds 4096 rows; coverage is incomplete and requires review",
                ));
            }
            let rowid: i64 = row.get(22)?;
            let result = match StoredLifecycleRow::from_row(row) {
                Ok(raw) => raw.decode(&self.library),
                Err(error)
                    if matches!(
                        error,
                        rusqlite::Error::InvalidColumnType(..)
                            | rusqlite::Error::FromSqlConversionFailure(..)
                            | rusqlite::Error::IntegralValueOutOfRange(..)
                            | rusqlite::Error::Utf8Error(..)
                    ) =>
                {
                    Err(RowFailure::at(
                        crate::JournalValidationStage::Columns,
                        error.into(),
                    ))
                }
                Err(error) => return Err(error.into()),
            };
            let failure = match result {
                Ok(operation) => {
                    // Reuse the same pure cross-row owner rule as the status inventory.
                    let inventory_failure = if let Some(payload) = &operation.update_acquisition {
                        acquisition::validate_inventory_owner(
                            &operation.id,
                            &operation.port_id,
                            &payload.view,
                            acquisition_owners.len(),
                            acquisition_owners.contains(&operation.port_id),
                        )
                        .err()
                        .map(|error| {
                            RowFailure::at(
                                crate::JournalValidationStage::AcquisitionInventory,
                                error,
                            )
                        })
                    } else {
                        None
                    };
                    if let Some(failure) = inventory_failure {
                        Some(failure)
                    } else {
                        if operation.update_acquisition.is_some() {
                            acquisition_owners.insert(operation.port_id.clone());
                        }
                        decoded.push(operation);
                        None
                    }
                }
                Err(failure) => Some(failure),
            };
            if let Some(failure) = failure {
                let Some(stage) = failure.stage else {
                    return Err(failure.error);
                };
                problems.push(crate::JournalRowProblem {
                    rowid,
                    operation_id: observed_token(row, 0).filter(|id| Uuid::parse_str(id).is_ok()),
                    operation_kind: observed_token(row, 1)
                        .filter(|kind| kind.parse::<LifecycleOperationKind>().is_ok()),
                    port_id: observed_token(row, 2),
                    stage,
                    reason: diagnostic_reason(stage).into(),
                });
            }
        }
        let related_assessments_complete = problems.is_empty();
        Ok(DiagnosticInventory {
            report: crate::JournalDiagnostics {
                enumeration_complete: true,
                enumerated_rows,
                decoded_rows: decoded.len(),
                related_assessments_complete,
                problems,
            },
            decoded,
        })
    }

    fn read(&self, id: Option<&str>) -> Result<Vec<LifecycleOperation>> {
        let connection = database::connect(self.library.root())?;
        let where_or_order = if id.is_some() {
            "WHERE id=?1"
        } else {
            "ORDER BY created_at, rowid"
        };
        let mut statement = connection.prepare(&format!("{LIFECYCLE_COLUMNS} {where_or_order}"))?;
        statement
            .query_map(rusqlite::params_from_iter(id), StoredLifecycleRow::from_row)?
            .map(|row| row?.decode(&self.library).map_err(|failure| failure.error))
            .collect()
    }
}

const LIFECYCLE_COLUMNS: &str = "SELECT id, kind, port_id, phase, staging_path, final_path, quarantine_path,
                    install_json, relocation_json, source_import_json, original_paths_json, activate, last_error, created_at, updated_at, preparation_json,
                    preparation_process_quiesced, ghostship_recovery_json, backup_deletion_json, external_registration_sha256, update_acquisition_json, removal_installs_json, rowid
             FROM lifecycle_operations";

/// Codec-checked observations, not a complete trusted operation inventory.
/// Only the read-only repair report consumes this type. No mutation adapter exists.
pub(crate) struct DiagnosticInventory {
    pub(crate) decoded: Vec<LifecycleOperation>,
    pub(crate) report: crate::JournalDiagnostics,
}

fn observed_token(row: &rusqlite::Row<'_>, column: usize) -> Option<String> {
    let rusqlite::types::ValueRef::Text(bytes) = row.get_ref(column).ok()? else {
        return None;
    };
    let token = std::str::from_utf8(bytes).ok()?;
    (!token.is_empty()
        && token.len() <= 128
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))
    .then(|| token.to_owned())
}

fn diagnostic_reason(stage: crate::JournalValidationStage) -> &'static str {
    use crate::JournalValidationStage::*;
    match stage {
        Columns => "journal columns have unsupported types or encoding",
        Kind => "operation kind is not recognized by this version",
        Phase => "operation phase is not recognized by this version",
        Payload => "journal payload is malformed, unsupported or exceeds its decoding bound",
        Family => "lifecycle journal has a missing or foreign family payload",
        Acquisition => {
            "acquisition journal validation refused its recorded ownership, paths or intent"
        }
        AcquisitionInventory => "acquisition inventory has duplicate or over-bound owners",
    }
}

/// Raw SQLite values are interpreted once for both strict reads and observation.
struct StoredLifecycleRow {
    id: String,
    kind: String,
    port_id: String,
    phase: String,
    staging_path: Option<String>,
    final_path: Option<String>,
    quarantine_path: Option<String>,
    install_json: Option<String>,
    relocation_json: Option<String>,
    source_import_json: Option<String>,
    original_paths_json: String,
    activate: i64,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
    preparation_json: Option<String>,
    preparation_process_quiesced: Option<i64>,
    ghostship_recovery_json: Option<String>,
    backup_deletion_json: Option<String>,
    external_registration_sha256: Option<String>,
    update_acquisition_json: Option<String>,
    removal_installs_json: Option<String>,
}

impl StoredLifecycleRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            kind: row.get(1)?,
            port_id: row.get(2)?,
            phase: row.get(3)?,
            staging_path: row.get(4)?,
            final_path: row.get(5)?,
            quarantine_path: row.get(6)?,
            install_json: row.get(7)?,
            relocation_json: row.get(8)?,
            source_import_json: row.get(9)?,
            original_paths_json: row.get(10)?,
            activate: row.get(11)?,
            last_error: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
            preparation_json: row.get(15)?,
            preparation_process_quiesced: row.get(16)?,
            ghostship_recovery_json: row.get(17)?,
            backup_deletion_json: row.get(18)?,
            external_registration_sha256: row.get(19)?,
            update_acquisition_json: row.get(20)?,
            removal_installs_json: row.get(21)?,
        })
    }

    fn decode(self, library: &Library) -> std::result::Result<LifecycleOperation, RowFailure> {
        let Self {
            id,
            kind,
            port_id,
            phase,
            staging_path,
            final_path,
            quarantine_path,
            install_json,
            relocation_json,
            source_import_json,
            original_paths_json,
            activate,
            last_error,
            created_at,
            updated_at,
            preparation_json,
            preparation_process_quiesced,
            ghostship_recovery_json,
            backup_deletion_json,
            external_registration_sha256,
            update_acquisition_json,
            removal_installs_json,
        } = self;
        let kind = kind
            .parse()
            .map_err(|e| RowFailure::at(crate::JournalValidationStage::Kind, e))?;
        let phase = phase
            .parse()
            .map_err(|e| RowFailure::at(crate::JournalValidationStage::Phase, e))?;

        let operation = LifecycleOperation {
            id,
            kind,
            port_id,
            phase,
            paths: LifecyclePaths {
                staging: staging_path.map(PathBuf::from),
                final_path: final_path.map(PathBuf::from),
                quarantine: quarantine_path.map(PathBuf::from),
            },
            install: install_json
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|e| RowFailure::at(crate::JournalValidationStage::Payload, e.into()))?,
            relocation: relocation_json
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|e| RowFailure::at(crate::JournalValidationStage::Payload, e.into()))?,
            source_import: source_import_json
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|e| RowFailure::at(crate::JournalValidationStage::Payload, e.into()))?,
            removal_installs: removal_installs_json
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|e| RowFailure::at(crate::JournalValidationStage::Payload, e.into()))?,
            original_paths: serde_json::from_str(&original_paths_json)
                .map_err(|e| RowFailure::at(crate::JournalValidationStage::Payload, e.into()))?,
            preparation: preparation_json
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|e| RowFailure::at(crate::JournalValidationStage::Payload, e.into()))?,
            preparation_process_quiesced: preparation_process_quiesced.map(|value| value != 0),
            external_registration_sha256,
            update_acquisition: acquisition::decode_journal(update_acquisition_json.as_deref())
                .map_err(|e| RowFailure::at(crate::JournalValidationStage::Payload, e))?,
            ghostship_recovery: ghostship_recovery_json
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|e| RowFailure::at(crate::JournalValidationStage::Payload, e.into()))?,
            backup_deletion: backup_deletion_json
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|e| RowFailure::at(crate::JournalValidationStage::Payload, e.into()))?,
            activate: activate != 0,
            last_error,
            created_at,
            updated_at,
        };
        operation
            .validate_family()
            .map_err(|e| RowFailure::at(crate::JournalValidationStage::Family, e))?;
        acquisition::validate_journal(library, &operation).map_err(|e| {
            if matches!(
                e.code,
                crate::ErrorCode::Verification
                    | crate::ErrorCode::Conflict
                    | crate::ErrorCode::Usage
            ) {
                RowFailure::at(crate::JournalValidationStage::Acquisition, e)
            } else {
                RowFailure {
                    stage: None,
                    error: e,
                }
            }
        })?;
        Ok(operation)
    }
}

struct RowFailure {
    stage: Option<crate::JournalValidationStage>,
    error: PortcoveError,
}
impl RowFailure {
    fn at(stage: crate::JournalValidationStage, error: PortcoveError) -> Self {
        Self {
            stage: Some(stage),
            error,
        }
    }
}

fn validate_external_replacement(
    kind: LifecycleOperationKind,
    activate: bool,
    expected: Option<&str>,
) -> Result<()> {
    if let Some(expected) = expected
        && (kind != LifecycleOperationKind::Install
            || !activate
            || expected.len() != 64
            || !expected
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    {
        return Err(PortcoveError::state(
            "external replacement journal has an invalid owner or registration identity",
        ));
    }
    Ok(())
}

fn validate_private_family(
    kind: LifecycleOperationKind,
    port_id: &str,
    ghostship: bool,
    deletion: bool,
) -> Result<()> {
    if ghostship != (kind == LifecycleOperationKind::GhostshipRecovery)
        || (deletion && kind != LifecycleOperationKind::DeleteBackup)
        || (ghostship && port_id != "ghostship")
    {
        return Err(PortcoveError::state(
            "lifecycle journal has a missing or foreign recovery-family payload",
        ));
    }
    Ok(())
}

fn path_string(path: Option<&PathBuf>) -> Result<Option<String>> {
    path.map(|path| crate::path::unicode(path, "lifecycle"))
        .transpose()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecycleFaultPoint {
    #[cfg(test)]
    RecoveryInventoried,
    PreparationJournaled,
    PreparationCopied,
    PreparationToolCompleted,
    PreparationOutputsValidated,
    PreparationPrepared,
    PreparationPublished,
    PreparationRegistered,
    GhostshipRecoveryJournaled,
    GhostshipRecoverySafetyRecorded,
    GhostshipRecoverySafetyPublished,
    GhostshipRecoveryDataStaged,
    GhostshipRecoveryPrepared,
    GhostshipRecoveryBeforePublication,
    GhostshipRecoveryPayloadPublished,
    GhostshipRecoveryCanonicalQuarantined,
    GhostshipRecoveryCanonicalPublished,
    GhostshipRecoveryPublicationRecorded,
    GhostshipRecoveryMetadataCommitted,
    GhostshipRecoveryCleanup,
    #[cfg(test)]
    SourceVerificationCaptured,
    SourcePrepared,
    LaunchReadyToSpawn,
    LaunchChildStarted,
    LaunchCollecting,
    InstallPrepared,
    InstallReadyToPublish,
    UpdateArchiveCopyStarted,
    InstallPrivateCleanup,
    InstallPrivateCleanupJournalRemoval,
    InstallPublished,
    InstallMetadataCommitted,
    AdoptionCopied,
    AdoptionPrivateCleanup,
    AdoptionPrepared,
    AdoptionPublished,
    AdoptionMetadataCommitted,
    RemovalQuarantined,
    RemovalMetadataCommitted,
    RemovalCleanup,
    RetainedBuildBeforeCommit,
    RetainedBuildCommitted,
    RestoreManifestRecordLoaded,
    RestoreAuthorized,
    RestorePrepared,
    RestorePublished,
    RestoreVersionSynchronized,
    BackupStagingCreated,
    BackupDataCopied,
    BackupManifestSynced,
    BackupStagingKept,
    BackupPublished,
    DeleteBackupPrepared,
    DeleteBackupQuarantined,
    DeleteBackupDeleting,
    DeleteBackupDeleted,
    DeleteBackupMetadataCommitted,
    ActivationMetadataCommitted,
    RelocationJournaled,
    RelocationCopyStarted,
    RelocationCopied,
    RelocationPrepared,
    RelocationPublicationPrepared,
    RelocationPublished,
    RelocationMetadataCommitted,
    RelocationCleanupCompleted,
    SourceImportJournaled,
    SourceImportCopyStarted,
    SourceImportCopied,
    SourceImportVerified,
    SourceImportPublicationPrepared,
    SourceImportBeforePublicationRecorded,
    SourceImportBeforePublicationOwnershipRecorded,
    SourceImportPublished,
    SourceImportRegistered,
    SourceImportOriginalQuarantined,
    SourceImportDeleteAttempt,
    SourceImportCleanupCompleted,
}

pub(crate) trait LifecycleFaultInjector: Send + Sync {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()>;
}

#[derive(Debug, Default)]
pub(crate) struct NoLifecycleFaults;

impl LifecycleFaultInjector for NoLifecycleFaults {
    fn check(&self, _point: LifecycleFaultPoint) -> Result<()> {
        Ok(())
    }
}

/// Core-owned identity and ordering for one durable or transient operation.
///
/// Clones share one sequence. Child operations receive their own identity and
/// sequence while retaining the parent's ID for correlation.
#[derive(Debug, Clone)]
pub struct OperationCoordinator {
    operation_id: String,
    parent_operation_id: Option<String>,
    operation: String,
    target: Option<OperationTarget>,
    next_sequence: Arc<AtomicU64>,
    cancellation: Option<Arc<crate::cancellation::CancellationScope>>,
    observed_at: Instant,
    durable_activity: bool,
}

impl OperationCoordinator {
    pub fn new(operation: impl Into<String>, target: Option<OperationTarget>) -> Self {
        Self {
            operation_id: Uuid::new_v4().to_string(),
            parent_operation_id: None,
            operation: operation.into(),
            target,
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: None,
            observed_at: Instant::now(),
            durable_activity: false,
        }
    }

    pub fn from_activity(activity: &ActivityRecord) -> Self {
        Self {
            operation_id: activity.id.clone(),
            parent_operation_id: None,
            operation: activity.operation.to_string(),
            target: activity.target_id.as_ref().map(|id| OperationTarget {
                kind: activity.target_kind,
                id: id.clone(),
            }),
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: None,
            observed_at: Instant::now(),
            durable_activity: true,
        }
    }

    pub(crate) fn resume(
        operation_id: impl Into<String>,
        operation: impl Into<String>,
        target: Option<OperationTarget>,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            parent_operation_id: None,
            operation: operation.into(),
            target,
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: None,
            observed_at: Instant::now(),
            durable_activity: false,
        }
    }

    pub fn child(&self, operation: impl Into<String>, target: Option<OperationTarget>) -> Self {
        Self {
            operation_id: Uuid::new_v4().to_string(),
            parent_operation_id: Some(self.operation_id.clone()),
            operation: operation.into(),
            target,
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: self.cancellation.clone(),
            observed_at: Instant::now(),
            durable_activity: false,
        }
    }

    pub(crate) fn cancellable(
        library: &Library,
        activity: &ActivityRecord,
        owner: &str,
    ) -> Result<Self> {
        let mut operation = Self::from_activity(activity);
        operation.cancellation = Some(Arc::new(crate::cancellation::CancellationScope::begin(
            library, activity, owner,
        )?));
        Ok(operation)
    }

    pub(crate) fn resume_cancellation(&mut self, library: &Library) -> Result<()> {
        self.cancellation = Some(Arc::new(crate::cancellation::CancellationScope::resume(
            library,
            &self.operation_id,
        )?));
        Ok(())
    }

    pub(crate) fn checkpoint(&self) -> Result<()> {
        self.cancellation
            .as_ref()
            .map_or(Ok(()), |scope| scope.checkpoint())
    }

    pub(crate) fn begin_publication(&self) -> Result<()> {
        self.cancellation
            .as_ref()
            .map_or(Ok(()), |scope| scope.begin_publication())
    }

    pub(crate) async fn interruptible<T>(
        &self,
        future: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        match &self.cancellation {
            Some(scope) => scope.interruptible(future).await,
            None => future.await,
        }
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn started(&self) -> OperationEvent {
        self.event(OperationEventKind::Started)
    }

    pub fn source_candidate(&self, candidate: &crate::SourceRecord) -> OperationEvent {
        self.event(OperationEventKind::SourceCandidate {
            profile_id: candidate.profile_id.clone(),
            path: candidate.path.clone(),
            sha256: candidate.sha256.clone(),
            size: candidate.size,
        })
    }

    pub fn progress(
        &self,
        phase: impl Into<String>,
        completed: u64,
        total: Option<u64>,
    ) -> OperationEvent {
        self.event(OperationEventKind::Progress {
            phase: phase.into(),
            phase_id: None,
            unit: None,
            completed,
            total,
        })
    }

    /// Producer-owned semantics. A full progress range is never a terminal result.
    pub fn progress_with_unit(
        &self,
        phase_id: impl Into<String>,
        unit: crate::ProgressUnit,
        completed: u64,
        total: Option<u64>,
    ) -> OperationEvent {
        let phase_id = phase_id.into();
        self.event(OperationEventKind::Progress {
            phase: phase_id.clone(),
            phase_id: Some(phase_id),
            unit: Some(unit),
            completed,
            total,
        })
    }

    pub fn message(&self, level: impl Into<String>, message: impl Into<String>) -> OperationEvent {
        self.event(OperationEventKind::Message {
            level: level.into(),
            message: message.into(),
        })
    }

    pub fn finished(&self, result: OperationResult) -> OperationEvent {
        self.event(OperationEventKind::Finished { result })
    }

    pub(crate) fn observe_release(&self, release: &str, install_id: Option<&str>) {
        tracing::debug!(
            component = "operation",
            observation = "event",
            phase = "resolved",
            operation_id = self.operation_id.as_str(),
            activity_id = self.durable_activity.then_some(self.operation_id.as_str()),
            operation = self.operation.as_str(),
            release,
            install_id,
            elapsed_ms = self
                .observed_at
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        );
    }

    pub(crate) fn observe_phase(&self, phase: &'static str) {
        tracing::debug!(
            component = "operation",
            observation = "event",
            operation_id = self.operation_id.as_str(),
            parent_operation_id = self.parent_operation_id.as_deref(),
            activity_id = self.durable_activity.then_some(self.operation_id.as_str()),
            operation = self.operation.as_str(),
            phase,
            elapsed_ms = self
                .observed_at
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        );
    }

    fn event(&self, event: OperationEventKind) -> OperationEvent {
        let event = OperationEvent {
            schema_version: OPERATION_EVENT_SCHEMA_VERSION,
            operation_id: self.operation_id.clone(),
            parent_operation_id: self.parent_operation_id.clone(),
            sequence: self.next_sequence.fetch_add(1, Ordering::Relaxed),
            timestamp_ms: now_millis(),
            operation: self.operation.clone(),
            target: self.target.clone(),
            event,
        };
        // One instrumentation owner for Desktop and CLI. Operation events stay
        // best effort; only existing activity/outcome/capture writes own truth.
        let observation = match &event.event {
            OperationEventKind::Started => Some(("started", None)),
            OperationEventKind::Progress {
                phase,
                completed: 0,
                ..
            } => Some((phase.as_str(), None)),
            OperationEventKind::Finished { result } => Some((
                "finished",
                Some(match result {
                    OperationResult::Succeeded => "succeeded",
                    OperationResult::Failed => "failed",
                    OperationResult::Cancelled => "cancelled",
                }),
            )),
            _ => None,
        };
        if let Some((phase, result)) = observation {
            tracing::debug!(
                component = "operation",
                observation = "event",
                operation_id = event.operation_id.as_str(),
                parent_operation_id = event.parent_operation_id.as_deref(),
                activity_id = self.durable_activity.then_some(event.operation_id.as_str()),
                event_schema_version = event.schema_version,
                sequence = event.sequence,
                operation = event.operation.as_str(),
                port_id = event
                    .target
                    .as_ref()
                    .filter(|target| target.kind == crate::ActivityTargetKind::Port)
                    .map(|target| target.id.as_str()),
                phase,
                observed_result = result,
                elapsed_ms = self
                    .observed_at
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
            );
        }
        event
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use crate::{ActivityOperation, ActivityStatus, ActivityTargetKind};

    use super::*;

    fn activity() -> ActivityRecord {
        ActivityRecord {
            liveness: None,
            id: "durable-activity".into(),
            operation: ActivityOperation::Install,
            target_kind: ActivityTargetKind::Port,
            target_id: Some("lighthouse".into()),
            status: ActivityStatus::Running,
            message: None,
            failure: None,
            started_at: 1,
            finished_at: None,
            cancellation: None,
        }
    }

    #[test]
    fn durable_activity_identity_and_sequence_are_reused() {
        let operation = OperationCoordinator::from_activity(&activity());

        let started = operation.started();
        let progress = operation.progress("download", 4, Some(8));
        let finished = operation.finished(OperationResult::Succeeded);

        assert_eq!(started.operation_id, "durable-activity");
        assert_eq!(started.target.unwrap().id, "lighthouse");
        assert_eq!(started.sequence, 0);
        assert_eq!(progress.sequence, 1);
        assert_eq!(finished.sequence, 2);
    }

    #[test]
    fn overlapping_and_nested_operations_remain_independently_ordered() {
        let first = OperationCoordinator::new("first", None);
        let second = OperationCoordinator::new("second", None);
        let child = first.child("nested", None);

        let events = [
            second.started(),
            child.started(),
            first.started(),
            second.finished(OperationResult::Failed),
            child.finished(OperationResult::Succeeded),
            first.finished(OperationResult::Succeeded),
        ];

        assert_ne!(first.operation_id(), second.operation_id());
        assert_eq!(
            events[1].parent_operation_id.as_deref(),
            Some(first.operation_id())
        );
        assert_eq!(events[0].sequence, 0);
        assert_eq!(events[3].sequence, 1);
        assert_eq!(events[1].sequence, 0);
        assert_eq!(events[4].sequence, 1);
        assert_eq!(events[2].sequence, 0);
        assert_eq!(events[5].sequence, 1);
    }
}

#[cfg(test)]
mod progress_semantics_tests {
    use super::*;
    #[test]
    fn producer_semantics_roundtrip_and_legacy_progress_remains_unitless() {
        let coordinator = OperationCoordinator::new("install", None);
        let event =
            coordinator.progress_with_unit("download", crate::ProgressUnit::Bytes, 4, Some(8));
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["unit"], "bytes");
        assert_eq!(value["phase_id"], "download");
        let mut renamed = value.clone();
        renamed["phase"] = "Different display wording".into();
        let decoded: OperationEvent = serde_json::from_value(renamed).unwrap();
        assert!(matches!(
            decoded.event,
            OperationEventKind::Progress {
                unit: Some(crate::ProgressUnit::Bytes),
                ..
            }
        ));
        let legacy = serde_json::to_value(coordinator.progress("download", 4, Some(8))).unwrap();
        assert!(legacy.get("unit").is_none());
        assert!(legacy.get("phase_id").is_none());
    }
}
