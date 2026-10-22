//! Setup-owned references to existing, exact managed installations.
//!
//! References add retention to the library's installation authority. They neither
//! select original game files nor authorize a download, launch, or new runtime.
use std::{collections::BTreeMap, path::PathBuf, sync::atomic::Ordering};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ArtifactIdentity, DefinitionSelectionIdentity, ErrorCode, InstallRecord, Installer, Library,
    Platform, PortcoveError, PortcoveService, Result, RuntimeIdentity,
    operation::LifecycleFaultPoint,
};

#[cfg(test)]
#[path = "retained_build_tests.rs"]
mod tests;

pub(crate) const MAX_REFERENCES: usize = 4096;
const MAX_REFERENCE_BYTES: usize = 64 * 1024;

/// Immutable identity only. Paths, version labels, and active selection are not keys.
/// `runtime: None` means no separately identified bundled loader/runtime; the
/// selected executable and installed contract still bind an integrated loader.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetainedBuildIdentity {
    pub install_id: String,
    pub port_id: String,
    pub artifact: ArtifactIdentity,
    pub manifest_sha256: String,
    pub selected_executable: PathBuf,
    pub runtime: Option<RuntimeIdentity>,
    pub installed_contract_sha256: String,
    pub definition: Option<DefinitionSelectionIdentity>,
    pub platform: Platform,
}

impl RetainedBuildIdentity {
    pub(crate) fn matches_install(&self, install: &InstallRecord) -> bool {
        self.install_id == install.id
            && self.port_id == install.port_id
            && self.artifact == install.artifact
            && self.manifest_sha256 == install.manifest_sha256
            && self.selected_executable == install.selected_executable
            && self.runtime == install.runtime
    }
}

/// One binding per (port, setup). The caller supplies a stable opaque setup ID,
/// never its display name, source-contract ID, installation path, or active slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetainedBuildReference {
    pub id: String,
    pub setup_id: String,
    /// Monotonic binding revision, including same-build rebindings. Wall-clock
    /// timestamps alone cannot invalidate approvals after an A-to-B-to-A change.
    pub revision: u64,
    pub build: RetainedBuildIdentity,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RetainedBuildAvailability {
    Verified,
    Missing,
    Changed,
    Held,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RetainedBuildGap {
    pub code: ErrorCode,
    pub message: String,
    pub details: BTreeMap<String, String>,
}

impl From<PortcoveError> for RetainedBuildGap {
    fn from(error: PortcoveError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            details: error.details,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RetainedBuild {
    pub install: InstallRecord,
    pub active: bool,
    pub previous: bool,
    pub identity: Option<RetainedBuildIdentity>,
    pub availability: RetainedBuildAvailability,
    pub gap: Option<RetainedBuildGap>,
    pub retained_by: Vec<String>,
}

/// A verified observation, not permission to launch. Consumers must use the
/// ordinary locked launch/preparation paths and recheck their current holds.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RetainedBuildResolution {
    pub reference: RetainedBuildReference,
    pub availability: RetainedBuildAvailability,
    pub install: Option<InstallRecord>,
    pub gap: Option<RetainedBuildGap>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RetainedBuildInventory {
    pub port_id: String,
    pub builds: Vec<RetainedBuild>,
    pub references: Vec<RetainedBuildResolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RetainedBuildBindingPreview {
    pub setup_id: String,
    pub build: RetainedBuildIdentity,
    pub previous: Option<RetainedBuildReference>,
    pub preview_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RetainedBuildRemovalPreview {
    pub reference: RetainedBuildReference,
    pub preview_sha256: String,
}

impl PortcoveService {
    pub fn retained_builds(&self, port_id: &str) -> Result<RetainedBuildInventory> {
        validate_identifier(port_id, "port ID")?;
        let connection = self.library.connection()?;
        let references = references_from(&connection)?;
        let (active, previous): (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT active_install_id, previous_install_id FROM port_settings WHERE port_id=?1",
                [port_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or_default();
        let mut builds = Vec::new();
        for install in Library::installs_from(&connection)?
            .into_iter()
            .filter(|i| i.port_id == port_id)
        {
            let checked = self.check_retained_build(&install);
            let (identity, availability, gap) = match checked {
                Ok(identity) => (Some(identity), RetainedBuildAvailability::Verified, None),
                Err(error) => (None, availability_for_error(&error), Some(error.into())),
            };
            builds.push(RetainedBuild {
                active: active.as_deref() == Some(&install.id),
                previous: previous.as_deref() == Some(&install.id),
                retained_by: references
                    .iter()
                    .filter(|r| r.build.install_id == install.id)
                    .map(|r| r.setup_id.clone())
                    .collect(),
                install,
                identity,
                availability,
                gap,
            });
        }
        let references = references
            .into_iter()
            .filter(|r| r.build.port_id == port_id)
            .map(|reference| self.resolve_build_reference(reference))
            .collect::<Result<_>>()?;
        Ok(RetainedBuildInventory {
            port_id: port_id.into(),
            builds,
            references,
        })
    }

    pub fn resolve_retained_build(
        &self,
        port_id: &str,
        setup_id: &str,
    ) -> Result<RetainedBuildResolution> {
        let reference = reference_from(&self.library.connection()?, port_id, setup_id)?
            .ok_or_else(|| PortcoveError::not_found("setup has no retained-build reference"))?;
        self.resolve_build_reference(reference)
    }

    fn resolve_build_reference(
        &self,
        reference: RetainedBuildReference,
    ) -> Result<RetainedBuildResolution> {
        let install = Library::install_by_id(
            &self.library.connection()?,
            Some(&reference.build.install_id),
        )?;
        let result = match install.as_ref() {
            None => Err(PortcoveError::not_found(
                "referenced installation record is missing",
            )),
            Some(install) if !reference.build.matches_install(install) => {
                Err(PortcoveError::verification(
                    "referenced installation identity changed; no other build was selected",
                ))
            }
            Some(install) => self.check_retained_build(install).and_then(|identity| {
                if identity == reference.build {
                    Ok(())
                } else {
                    Err(PortcoveError::verification(
                        "referenced definition or runtime binding changed",
                    ))
                }
            }),
        };
        let (availability, gap) = match result {
            Ok(()) => (RetainedBuildAvailability::Verified, None),
            Err(error) => (availability_for_error(&error), Some(error.into())),
        };
        Ok(RetainedBuildResolution {
            reference,
            availability,
            install: (availability == RetainedBuildAvailability::Verified)
                .then_some(install)
                .flatten(),
            gap,
        })
    }

    fn check_retained_build(&self, install: &InstallRecord) -> Result<RetainedBuildIdentity> {
        if !install.verified {
            return Err(PortcoveError::verification(
                "installation has not been accepted as verified",
            ));
        }
        if !install.path.try_exists()?
            || !install.path.join(".portcove-manifest.json").try_exists()?
        {
            return Err(PortcoveError::not_found(
                "exact retained build or manifest is missing",
            ));
        }
        crate::output_root::validate_install_path(&self.library, &install.port_id, &install.path)?;
        let identity = crate::install::retained_build_identity_for_install(install)?;
        let installer = Installer::new(self.library.clone())?;
        let catalog = installer.retained_catalog(install)?.ok_or_else(|| {
            PortcoveError::unsupported("installation has no retained exact definition contract")
        })?;
        let qualification =
            self.installed_mutability_qualification_for_platform(install, identity.platform)?;
        let report = installer.verify_managed(install, &qualification)?;
        if !report.valid {
            let missing = report
                .failures
                .iter()
                .all(|failure| failure.starts_with("missing:"));
            return Err(PortcoveError::new(
                if missing {
                    ErrorCode::NotFound
                } else {
                    ErrorCode::Verification
                },
                "exact retained build failed immutable verification",
            )
            .detail("install_id", &install.id)
            .detail("failures", report.failures.join(", ")));
        }
        self.require_retained_build_permission(&installer, install, &catalog)?;
        Ok(identity)
    }

    fn require_retained_build_permission(
        &self,
        installer: &Installer,
        install: &InstallRecord,
        catalog: &crate::Catalog,
    ) -> Result<()> {
        installer.require_curated_operation(
            install,
            crate::definition_repository::publisher_policy::CuratedArtifactOperation::LocalUse,
        )?;
        self.require_definition_operation(
            catalog,
            catalog.port(&install.port_id)?,
            self.managed_launch_context(catalog.definition_selection(&install.port_id), install)?,
        )
    }

    pub fn preview_retained_build_binding(
        &self,
        port_id: &str,
        setup_id: &str,
        install_id: &str,
    ) -> Result<RetainedBuildBindingPreview> {
        validate_identifier(setup_id, "setup ID")?;
        let connection = self.library.connection()?;
        require_idle(&connection, port_id)?;
        let install = Library::install_by_id(&connection, Some(install_id))?
            .filter(|install| install.port_id == port_id)
            .ok_or_else(|| {
                PortcoveError::not_found("exact installation ID is not registered for this port")
            })?;
        let build = self.check_retained_build(&install)?;
        let previous = reference_from(&connection, port_id, setup_id)?;
        let preview_sha256 = digest(&(setup_id, &build, &previous))?;
        Ok(RetainedBuildBindingPreview {
            setup_id: setup_id.into(),
            build,
            previous,
            preview_sha256,
        })
    }

    pub fn authorize_retained_build_binding(
        &self,
        port_id: &str,
        setup_id: &str,
        install_id: &str,
        expected_preview: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_retained_build_binding(port_id, setup_id, install_id)?;
        require_preview(&preview.preview_sha256, expected_preview)?;
        self.library.issue_authorization(
            "bind_retained_build",
            &target(port_id, setup_id)?,
            expected_preview,
        )
    }

    pub fn bind_retained_build(
        &self,
        port_id: &str,
        setup_id: &str,
        install_id: &str,
        token: &str,
    ) -> Result<RetainedBuildReference> {
        let _guard = self.library.try_lock_port(port_id, "bind-retained-build")?;
        let mut reviewed = None;
        self.library.consume_authorization_with_state(
            token,
            "bind_retained_build",
            &target(port_id, setup_id)?,
            || {
                let preview = self.preview_retained_build_binding(port_id, setup_id, install_id)?;
                let fingerprint = preview.preview_sha256.clone();
                reviewed = Some(preview);
                Ok(fingerprint)
            },
        )?;
        let preview = reviewed
            .ok_or_else(|| PortcoveError::state("retained-build review was not consumed"))?;
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_idle(&transaction, port_id)?;
        if reference_from(&transaction, port_id, setup_id)? != preview.previous {
            return Err(PortcoveError::conflict(
                "setup reference changed after review",
            ));
        }
        // Serialize the final current-policy decision with durable publication.
        // Policy admissions use this same SQLite writer boundary. The port lock
        // already protects ordinary managed byte changes during verification.
        let install = Library::install_by_id(&transaction, Some(install_id))?
            .ok_or_else(|| PortcoveError::conflict("referenced installation disappeared"))?;
        let installer = Installer::new(self.library.clone())?;
        let catalog = installer.retained_catalog(&install)?.ok_or_else(|| {
            PortcoveError::conflict("referenced installation lost its retained contract")
        })?;
        self.require_retained_build_permission(&installer, &install, &catalog)?;
        let now = Library::now();
        let reference = RetainedBuildReference {
            id: preview
                .previous
                .as_ref()
                .map_or_else(|| uuid::Uuid::new_v4().to_string(), |r| r.id.clone()),
            setup_id: setup_id.into(),
            build: preview.build,
            revision: preview
                .previous
                .as_ref()
                .map_or(Some(1), |r| r.revision.checked_add(1))
                .ok_or_else(|| {
                    PortcoveError::state("retained-build reference revision exhausted")
                })?,
            created_at: preview.previous.as_ref().map_or(now, |r| r.created_at),
            updated_at: preview
                .previous
                .as_ref()
                .map_or(now, |r| now.max(r.updated_at)),
        };
        write_reference(&transaction, &reference)?;
        self.reference_publication_checkpoint()?;
        transaction.commit()?;
        self.reference_committed(&reference)?;
        Ok(reference)
    }

    pub fn preview_retained_build_removal(
        &self,
        port_id: &str,
        setup_id: &str,
    ) -> Result<RetainedBuildRemovalPreview> {
        let connection = self.library.connection()?;
        require_idle(&connection, port_id)?;
        let reference = reference_from(&connection, port_id, setup_id)?
            .ok_or_else(|| PortcoveError::not_found("setup has no retained-build reference"))?;
        let preview_sha256 = digest(&reference)?;
        Ok(RetainedBuildRemovalPreview {
            reference,
            preview_sha256,
        })
    }

    pub fn authorize_retained_build_removal(
        &self,
        port_id: &str,
        setup_id: &str,
        expected_preview: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_retained_build_removal(port_id, setup_id)?;
        require_preview(&preview.preview_sha256, expected_preview)?;
        self.library.issue_authorization(
            "remove_retained_build",
            &target(port_id, setup_id)?,
            expected_preview,
        )
    }

    /// Removes metadata only. Missing/held bytes do not prevent explicit release
    /// of a reference; active sessions and unfinished lifecycle work still do.
    pub fn remove_retained_build_reference(
        &self,
        port_id: &str,
        setup_id: &str,
        token: &str,
    ) -> Result<RetainedBuildReference> {
        let _guard = self
            .library
            .try_lock_port(port_id, "remove-retained-build-reference")?;
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_idle(&transaction, port_id)?;
        let reference = reference_from(&transaction, port_id, setup_id)?
            .ok_or_else(|| PortcoveError::not_found("setup has no retained-build reference"))?;
        self.library.consume_authorization(
            token,
            "remove_retained_build",
            &target(port_id, setup_id)?,
            &digest(&reference)?,
        )?;
        transaction.execute(
            "DELETE FROM retained_build_references WHERE id=?1",
            [&reference.id],
        )?;
        self.reference_publication_checkpoint()?;
        transaction.commit()?;
        self.reference_committed(&reference)?;
        Ok(reference)
    }

    fn reference_publication_checkpoint(&self) -> Result<()> {
        self.check_lifecycle_fault(LifecycleFaultPoint::RetainedBuildBeforeCommit)?;
        if self.cancellation_requested.load(Ordering::SeqCst) {
            return Err(PortcoveError::new(
                ErrorCode::Cancelled,
                "reference change cancelled before publication",
            ));
        }
        Ok(())
    }

    fn reference_committed(&self, reference: &RetainedBuildReference) -> Result<()> {
        self.check_lifecycle_fault(LifecycleFaultPoint::RetainedBuildCommitted)
            .map_err(|mut error| {
                error.failure.mutation_state = crate::MutationState::Committed;
                error
                    .details
                    .insert("reference_id".into(), reference.id.clone());
                error
                    .details
                    .insert("setup_id".into(), reference.setup_id.clone());
                error
            })
    }
}

fn availability_for_error(error: &PortcoveError) -> RetainedBuildAvailability {
    if error.details.contains_key("definition_reason")
        || error.details.contains_key("curated_artifact_reason")
    {
        return RetainedBuildAvailability::Held;
    }
    match error.code {
        ErrorCode::NotFound => RetainedBuildAvailability::Missing,
        ErrorCode::Verification => RetainedBuildAvailability::Changed,
        ErrorCode::Conflict => RetainedBuildAvailability::Held,
        _ => RetainedBuildAvailability::Unavailable,
    }
}

fn target(port_id: &str, setup_id: &str) -> Result<String> {
    validate_identifier(port_id, "port ID")?;
    validate_identifier(setup_id, "setup ID")?;
    Ok(serde_json::to_string(&(port_id, setup_id))?)
}

fn digest(value: &impl Serialize) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

fn require_preview(actual: &str, expected: &str) -> Result<()> {
    if actual != expected {
        return Err(PortcoveError::conflict(
            "retained-build reference changed after preview; review it again",
        ));
    }
    Ok(())
}

fn validate_identifier(value: &str, name: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    {
        return Err(PortcoveError::usage(format!(
            "{name} must be a stable 1–128 character identifier (letters, digits, -, _, ., :)"
        )));
    }
    Ok(())
}

pub(crate) fn validate_reference(reference: &RetainedBuildReference) -> Result<()> {
    validate_identifier(&reference.setup_id, "setup ID")?;
    validate_identifier(&reference.build.port_id, "port ID")?;
    validate_identifier(&reference.build.install_id, "installation ID")?;
    if uuid::Uuid::parse_str(&reference.id).is_err()
        || reference.revision == 0
        || reference.created_at < 0
        || reference.updated_at < reference.created_at
        || [
            &reference.build.artifact.sha256,
            &reference.build.manifest_sha256,
            &reference.build.installed_contract_sha256,
        ]
        .iter()
        .any(|hash| hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()))
        || serde_json::to_vec(reference)?.len() > MAX_REFERENCE_BYTES
    {
        return Err(PortcoveError::verification(
            "retained-build reference has an invalid or oversized identity",
        ));
    }
    crate::portability::portable_relative(&reference.build.selected_executable)?;
    Ok(())
}

pub(crate) fn migrate(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE retained_build_references (
        id TEXT PRIMARY KEY NOT NULL,
        port_id TEXT NOT NULL,
        setup_id TEXT NOT NULL,
        install_id TEXT NOT NULL REFERENCES installs(id) ON DELETE RESTRICT,
        reference_json TEXT NOT NULL CHECK(length(reference_json) <= 65536),
        UNIQUE(port_id, setup_id)
    ); CREATE INDEX retained_build_install ON retained_build_references(install_id);",
    )?;
    Ok(())
}

pub(crate) fn references_from(connection: &Connection) -> Result<Vec<RetainedBuildReference>> {
    let mut statement = connection.prepare(
        "SELECT id, port_id, setup_id, install_id, reference_json FROM retained_build_references ORDER BY port_id, setup_id LIMIT 4097")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut references = Vec::new();
    for row in rows {
        let (id, port_id, setup_id, install_id, json) = row?;
        if json.len() > MAX_REFERENCE_BYTES || references.len() >= MAX_REFERENCES {
            return Err(PortcoveError::state(
                "retained-build reference inventory exceeds its bound",
            ));
        }
        let reference: RetainedBuildReference = serde_json::from_str(&json)?;
        validate_reference(&reference)?;
        if reference.id != id
            || reference.setup_id != setup_id
            || reference.build.port_id != port_id
            || reference.build.install_id != install_id
        {
            return Err(PortcoveError::verification(
                "retained-build reference differs from its stored binding",
            ));
        }
        references.push(reference);
    }
    Ok(references)
}

fn reference_from(
    connection: &Connection,
    port_id: &str,
    setup_id: &str,
) -> Result<Option<RetainedBuildReference>> {
    target(port_id, setup_id)?;
    Ok(references_from(connection)?
        .into_iter()
        .find(|r| r.build.port_id == port_id && r.setup_id == setup_id))
}

pub(crate) fn restore_references(
    connection: &Connection,
    references: &[RetainedBuildReference],
) -> Result<()> {
    for reference in references {
        write_reference(connection, reference)?;
    }
    Ok(())
}

fn write_reference(connection: &Connection, reference: &RetainedBuildReference) -> Result<()> {
    validate_reference(reference)?;
    let install = Library::install_by_id(connection, Some(&reference.build.install_id))?
        .ok_or_else(|| {
            PortcoveError::conflict("referenced installation is no longer registered")
        })?;
    if !reference.build.matches_install(&install) || !install.verified {
        return Err(PortcoveError::conflict(
            "referenced installation changed before metadata publication",
        ));
    }
    let count: usize = connection.query_row(
        "SELECT count(*) FROM retained_build_references",
        [],
        |row| row.get(0),
    )?;
    if count >= MAX_REFERENCES
        && reference_from(connection, &reference.build.port_id, &reference.setup_id)?.is_none()
    {
        return Err(PortcoveError::state(
            "retained-build reference limit reached",
        ));
    }
    connection.execute(
        "INSERT INTO retained_build_references(id, port_id, setup_id, install_id, reference_json)
        VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(port_id, setup_id) DO UPDATE SET
        id=excluded.id, install_id=excluded.install_id, reference_json=excluded.reference_json",
        params![
            reference.id,
            reference.build.port_id,
            reference.setup_id,
            reference.build.install_id,
            serde_json::to_string(reference)?
        ],
    )?;
    Ok(())
}

fn require_idle(connection: &Connection, port_id: &str) -> Result<()> {
    let pending: Option<String> = connection
        .query_row(
            "SELECT id FROM lifecycle_operations WHERE port_id=?1 LIMIT 1",
            [port_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = pending {
        return Err(PortcoveError::conflict(
            "unfinished lifecycle work must recover before changing retained-build references",
        )
        .detail("operation_id", id));
    }
    Ok(())
}

pub(crate) fn require_no_references(connection: &Connection, port_id: &str) -> Result<()> {
    let mut statement = connection.prepare(
        "SELECT setup_id FROM retained_build_references WHERE port_id=?1
         OR install_id IN (SELECT id FROM installs WHERE port_id=?1) ORDER BY setup_id",
    )?;
    let setups = statement
        .query_map([port_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if !setups.is_empty() {
        return Err(PortcoveError::conflict("managed builds are retained by setups; explicitly remove their references before cleanup")
            .detail("port_id", port_id).detail("setup_ids", setups.join(", ")));
    }
    Ok(())
}

pub(crate) fn require_unchanged_install(
    connection: &Connection,
    install: &InstallRecord,
) -> Result<()> {
    for reference in references_from(connection)?
        .iter()
        .filter(|r| r.build.install_id == install.id)
    {
        if !reference.build.matches_install(install) {
            return Err(PortcoveError::conflict(
                "cannot replace the exact identity of a referenced build",
            )
            .detail("setup_id", &reference.setup_id)
            .detail("install_id", &install.id));
        }
    }
    Ok(())
}

pub(crate) fn require_unreferenced_install(
    connection: &Connection,
    install_id: &str,
) -> Result<()> {
    let setup: Option<String> = connection
        .query_row(
            "SELECT setup_id FROM retained_build_references WHERE install_id=?1 LIMIT 1",
            [install_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(setup) = setup {
        return Err(PortcoveError::conflict("referenced exact build cannot refresh its manifest; explicitly remove its setup reference first")
            .detail("setup_id", setup).detail("install_id", install_id));
    }
    Ok(())
}
