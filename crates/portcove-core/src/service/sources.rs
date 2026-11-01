//! Source observation, registration, verification and reference removal.
//! Mutation paths retain their source/dependent locks and reread consent-bound
//! state under those locks; removing a registration never removes player bytes.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{
    ActivityOperation, ActivityTargetKind, Catalog, Library, PortcoveError, Result, SourceHealth,
    SourceRecord, SourceRemovalPreview, SourceVerification,
};

use super::PortcoveService;

impl PortcoveService {
    pub fn register_source(&self, profile_id: &str, path: &Path) -> Result<SourceRecord> {
        self.register_source_checked(profile_id, path, None)
    }

    /// Inspect selected source bytes without registering them or changing their baseline.
    pub fn inspect_source(&self, profile_id: &str, path: &Path) -> Result<crate::SourceInspection> {
        crate::source_inspection::inspect(&self.catalog, profile_id, path)
    }

    /// Inspect explicitly selected bytes and attach the active catalog's complete
    /// expected identity, dependent contracts, evidence, applicability, and
    /// qualification context without registering or modifying anything.
    pub fn inspect_source_report(
        &self,
        profile_id: &str,
        path: &Path,
    ) -> Result<crate::SourceInspectionReport> {
        let inspection = self.inspect_source(profile_id, path)?;
        crate::source_report::available_report(&self.catalog, None, inspection)
    }

    /// Inspect paths offered by a host intake surface without registering,
    /// copying, moving, deleting, or installing anything.
    pub fn inspect_source_intake(
        &self,
        profile_id: &str,
        paths: &[PathBuf],
    ) -> Result<crate::SourceIntakeInspection> {
        self.catalog.source_profile(profile_id)?;
        let static_result =
            |state_code: &str, summary: &str, next_action: &str| crate::SourceIntakeInspection {
                schema_version: crate::SOURCE_INTAKE_INSPECTION_SCHEMA_VERSION,
                profile_id: profile_id.to_owned(),
                input_count: paths.len(),
                state_code: state_code.to_owned(),
                summary: summary.to_owned(),
                next_action: next_action.to_owned(),
                report: None,
                problem: None,
            };
        if paths.is_empty() {
            return Ok(static_result(
                "no_paths",
                "No game files were offered for inspection.",
                "Choose one file or one source folder, then check it again.",
            ));
        }
        if paths.len() != 1 {
            return Ok(static_result(
                "multiple_paths",
                "Portcove cannot determine one source from multiple dropped paths.",
                "Choose one file or one source folder that contains the complete required set.",
            ));
        }
        match self.inspect_source_report(profile_id, &paths[0]) {
            Ok(report) => Ok(crate::SourceIntakeInspection {
                schema_version: crate::SOURCE_INTAKE_INSPECTION_SCHEMA_VERSION,
                profile_id: profile_id.to_owned(),
                input_count: 1,
                state_code: report.state_code.clone(),
                summary: report.summary.clone(),
                next_action: report.next_action.clone(),
                report: Some(report),
                problem: None,
            }),
            Err(error) => {
                let state_code = match error.code {
                    crate::ErrorCode::NotFound => "source_missing",
                    crate::ErrorCode::Usage
                    | crate::ErrorCode::Unsupported
                    | crate::ErrorCode::SourceInvalid => "unsupported_shape",
                    _ => "source_could_not_be_checked",
                };
                Ok(crate::SourceIntakeInspection {
                    schema_version: crate::SOURCE_INTAKE_INSPECTION_SCHEMA_VERSION,
                    profile_id: profile_id.to_owned(),
                    input_count: 1,
                    state_code: state_code.to_owned(),
                    summary: match state_code {
                        "source_missing" => "The selected game files could not be found.",
                        "unsupported_shape" => {
                            "The selected path is not a supported shape for this game."
                        }
                        _ => "The selected game files could not be checked.",
                    }
                    .to_owned(),
                    next_action: "Choose the expected file or source folder and check it again."
                        .to_owned(),
                    report: None,
                    problem: Some(crate::source_report::problem_from_error(&error)),
                })
            }
        }
    }

    /// Inspect the registered source and preserve missing/unreadable states as a
    /// machine-readable report. The saved baseline and source bytes are unchanged.
    pub fn inspect_registered_source(
        &self,
        profile_id: &str,
    ) -> Result<crate::SourceInspectionReport> {
        self.catalog.source_profile(profile_id)?;
        let registered = self.library.source(profile_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
        })?;
        crate::source_report::registered_report(&self.catalog, registered)
    }

    pub(crate) fn inspect_source_record(
        &self,
        profile_id: &str,
        path: &Path,
    ) -> Result<SourceRecord> {
        self.inspect_source(profile_id, path)?
            .require_admitted_record()
    }

    pub fn register_source_with_digest(
        &self,
        profile_id: &str,
        path: &Path,
        expected_sha256: &str,
    ) -> Result<SourceRecord> {
        if expected_sha256.len() != 64
            || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(PortcoveError::usage(
                "source acceptance requires the reviewed SHA-256",
            ));
        }
        self.register_source_checked(profile_id, path, Some(expected_sha256))
    }

    fn register_source_checked(
        &self,
        profile_id: &str,
        path: &Path,
        expected_sha256: Option<&str>,
    ) -> Result<SourceRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::RegisterSource,
            ActivityTargetKind::Source,
            Some(profile_id),
        )?;
        let result = (|| {
            let _guards = self.lock_source_dependents(profile_id, None)?;
            let source = self.inspect_source_record(profile_id, path)?;
            if expected_sha256.is_some_and(|expected| !source.sha256.eq_ignore_ascii_case(expected))
            {
                return Err(PortcoveError::conflict(
                    "source changed after discovery; review it again",
                ));
            }
            self.library.register_source(&source)?;
            Ok(source)
        })();
        self.finish_activity(activity, result)
    }

    pub(crate) fn lock_source_dependents(
        &self,
        profile_id: &str,
        already_locked: Option<&str>,
    ) -> Result<Vec<crate::PortOperationGuard>> {
        let mut guards = vec![self.library.try_lock_source(profile_id)?];
        let mut ports: Vec<_> = self
            .catalog
            .ports()
            .iter()
            .filter(|port| {
                port.source_profile.as_deref() == Some(profile_id)
                    || port.bios_source_profile.as_deref() == Some(profile_id)
            })
            .map(|port| port.id.as_str())
            .collect();
        ports.sort_unstable();
        guards.extend(
            ports
                .into_iter()
                .filter(|id| Some(*id) != already_locked)
                .map(|id| self.library.try_lock_port(id, "change-source-reference"))
                .collect::<Result<Vec<_>>>()?,
        );
        Ok(guards)
    }

    pub fn preview_source_removal(&self, profile_id: &str) -> Result<SourceRemovalPreview> {
        let source = self.library.source(profile_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
        })?;
        let mut dependent_port_ids = self
            .catalog
            .ports()
            .iter()
            .filter(|port| {
                port.source_profile.as_deref() == Some(profile_id)
                    || port.bios_source_profile.as_deref() == Some(profile_id)
            })
            .map(|port| port.id.clone())
            .collect::<Vec<_>>();
        dependent_port_ids.sort();
        let mut installed_dependent_port_ids = Vec::new();
        for port_id in &dependent_port_ids {
            if self.status(port_id)?.active.is_some() {
                installed_dependent_port_ids.push(port_id.clone());
            }
        }
        Ok(SourceRemovalPreview {
            preview_sha256: source_removal_fingerprint(
                &source,
                &dependent_port_ids,
                &installed_dependent_port_ids,
            )?,
            source,
            dependent_port_ids,
            installed_dependent_port_ids,
        })
    }

    pub fn authorize_source_removal(
        &self,
        profile_id: &str,
        expected_preview_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_source_removal(profile_id)?;
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "the source or its installed dependents changed after the removal preview",
            )
            .detail("profile_id", profile_id));
        }
        self.library
            .issue_authorization("remove_source", profile_id, &preview.preview_sha256)
    }

    pub fn remove_source(
        &self,
        profile_id: &str,
        authorization_token: &str,
    ) -> Result<SourceRemovalPreview> {
        let activity = self.library.begin_activity(
            ActivityOperation::RemoveSource,
            ActivityTargetKind::Source,
            Some(profile_id),
        )?;
        let result = (|| {
            let _guards = self.lock_source_dependents(profile_id, None)?;
            let locked_preview = self.preview_source_removal(profile_id).map_err(|error| {
                if error.code == crate::ErrorCode::NotFound {
                    PortcoveError::conflict("the registered source was removed after its preview")
                        .detail("profile_id", profile_id)
                } else {
                    error
                }
            })?;
            self.library.consume_authorization(
                authorization_token,
                "remove_source",
                profile_id,
                &locked_preview.preview_sha256,
            )?;
            if !self.library.remove_source(profile_id)? {
                return Err(PortcoveError::conflict(
                    "the registered source was removed concurrently",
                )
                .detail("profile_id", profile_id));
            }
            Ok(locked_preview)
        })();
        self.finish_activity(activity, result)
    }

    pub fn verify_source(&self, profile_id: &str) -> Result<SourceVerification> {
        self.verify_source_untracked(profile_id)
    }

    fn verify_source_untracked(&self, profile_id: &str) -> Result<SourceVerification> {
        let registered = self.library.source(profile_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
        })?;
        #[cfg(test)]
        self.check_lifecycle_fault(
            crate::operation::LifecycleFaultPoint::SourceVerificationCaptured,
        )?;
        let inspection =
            crate::source_report::registered_report(&self.catalog, registered.clone())?;
        require_current_admitted_inspection(&inspection)?;
        Ok(SourceVerification {
            profile_id: registered.profile_id,
            path: registered.path,
            sha256: registered.sha256,
            size: registered.size,
            storage_sha256: registered.storage_sha256,
            storage_size: registered.storage_size,
            registered_at: registered.updated_at,
            verified_at: Library::now(),
            inspection,
        })
    }

    pub(crate) fn verify_source_record(&self, registered: &SourceRecord) -> Result<()> {
        crate::source_inspection::verify_registered(&self.catalog, registered)
    }

    pub(super) fn verified_source_record(&self, profile_id: &str) -> Result<SourceRecord> {
        let registered = self.library.source(profile_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
        })?;
        self.verify_source_record(&registered)?;
        Ok(registered)
    }

    pub(super) fn verified_original_for_setup(
        &self,
        port: &crate::PortDefinition,
    ) -> Result<SourceRecord> {
        let profile_id = port
            .source_profile
            .as_deref()
            .ok_or_else(|| PortcoveError::state("original-file setup requires a source profile"))?;
        let registered = self.library.source(profile_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
        })?;
        let assessment = crate::source_inspection::verify_registered_assessment_with_checkpoint(
            &self.catalog,
            &registered,
            &|| Ok(()),
        )?;
        self.require_original_setup_compatibility(port, &assessment.classification)?;
        Ok(registered)
    }

    pub(super) fn verified_source_record_with_checkpoint(
        &self,
        catalog: &Catalog,
        profile_id: &str,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<SourceRecord> {
        let registered = self.library.source(profile_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
        })?;
        Self::verify_source_record_with_checkpoint(catalog, &registered, checkpoint)?;
        Ok(registered)
    }

    pub(super) fn verify_source_record_with_checkpoint(
        catalog: &Catalog,
        registered: &SourceRecord,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        let profile_id = &registered.profile_id;
        // File sets retain the inspector's member-based aggregate identity
        // for directories (and the original container digest for ZIPs). The
        // generic basename storage digest is a different identity and cannot
        // preflight them. The inspector below checks content AND storage.
        if matches!(
            catalog.source_profile(profile_id)?.kind,
            crate::SourceKind::RelativeFileSet | crate::SourceKind::FileSet
        ) {
            return crate::source_inspection::verify_registered_with_checkpoint(
                catalog, registered, checkpoint,
            );
        }
        let (storage_sha256, storage_size) =
            crate::adapter::source_storage_identity_with_checkpoint(&registered.path, checkpoint)?;
        if storage_sha256 != registered.storage_sha256 || storage_size != registered.storage_size {
            return Err(PortcoveError::source(format!(
                "source changed since registration: {}",
                registered.path.display()
            ))
            .detail("profile_id", profile_id)
            .detail("recorded_storage_sha256", &registered.storage_sha256)
            .detail("actual_storage_sha256", storage_sha256)
            .detail("recorded_storage_size", registered.storage_size.to_string())
            .detail("actual_storage_size", storage_size.to_string()));
        }
        checkpoint()?;
        crate::source_inspection::verify_registered_with_checkpoint(
            catalog, registered, checkpoint,
        )?;
        checkpoint()?;
        Ok(())
    }
}

fn require_current_admitted_inspection(report: &crate::SourceInspectionReport) -> Result<()> {
    if let Some(problem) = &report.problem {
        return Err(PortcoveError::source(problem.message.clone())
            .detail("profile_id", &report.profile_id)
            .detail("inspection_state", &report.state_code));
    }
    let registered = report
        .registered
        .as_ref()
        .ok_or_else(|| PortcoveError::state("registered source inspection omitted its baseline"))?;
    let inspection = report.inspection.as_ref().ok_or_else(|| {
        PortcoveError::state("available source inspection omitted its observed facts")
    })?;
    if report.health != SourceHealth::Current {
        let actual_content = inspection.observed_digests.iter().find(|digest| {
            digest.algorithm == crate::SourceDigestAlgorithm::Sha256
                && digest.scope != crate::DigestScope::OriginalContainer
        });
        let actual_storage = inspection
            .observed_digests
            .iter()
            .find(|digest| {
                digest.algorithm == crate::SourceDigestAlgorithm::Sha256
                    && digest.scope == crate::DigestScope::OriginalContainer
            })
            .or_else(|| {
                inspection.observed_digests.iter().find(|digest| {
                    digest.algorithm == crate::SourceDigestAlgorithm::Sha256
                        && digest.scope == crate::DigestScope::OriginalFile
                })
            });
        return Err(PortcoveError::source(format!(
            "source changed since registration: {}",
            registered.path.display()
        ))
        .detail("profile_id", &report.profile_id)
        .detail("recorded_sha256", &registered.sha256)
        .detail(
            "actual_sha256",
            actual_content.map_or("", |digest| digest.value.as_str()),
        )
        .detail("recorded_size", registered.size.to_string())
        .detail(
            "actual_size",
            actual_content.map_or_else(String::new, |digest| digest.size.to_string()),
        )
        .detail("recorded_storage_sha256", &registered.storage_sha256)
        .detail(
            "actual_storage_sha256",
            actual_storage.map_or("", |digest| digest.value.as_str()),
        )
        .detail("recorded_storage_size", registered.storage_size.to_string())
        .detail(
            "actual_storage_size",
            actual_storage.map_or_else(String::new, |digest| digest.size.to_string()),
        )
        .detail("inspection_state", &report.state_code));
    }
    if !matches!(
        inspection.assessment.admission,
        crate::SourceAdmission::Admitted { .. }
    ) {
        return Err(PortcoveError::source(inspection.message.clone())
            .detail("profile_id", &report.profile_id)
            .detail("inspection_state", &report.state_code));
    }
    Ok(())
}

fn source_removal_fingerprint(
    source: &SourceRecord,
    dependent_port_ids: &[String],
    installed_dependent_port_ids: &[String],
) -> Result<String> {
    let path = crate::path::unicode(&source.path, "source")?;
    let encoded = serde_json::to_vec(&(
        source.profile_id.as_str(),
        path,
        source.sha256.as_str(),
        source.size,
        source.storage_sha256.as_str(),
        source.storage_size,
        source.updated_at,
        dependent_port_ids,
        installed_dependent_port_ids,
    ))?;
    Ok(hex::encode(Sha256::digest(encoded)))
}
