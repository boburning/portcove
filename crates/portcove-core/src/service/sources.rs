//! Source observation, registration, verification and reference removal.
//! Mutation paths retain their source/dependent locks and reread consent-bound
//! state under those locks; removing a registration never removes player bytes.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{
    ActivityOperation, ActivityTargetKind, Catalog, ErrorCode, Library, PortcoveError, Result,
    SourceHealth, SourceRecord, SourceRemovalPreview, SourceVerification,
};

use super::PortcoveService;

/// Saved originals read per database page while looking for a fallback.
const SAVED_N64_ORIGINAL_PAGE: i64 = 16;

/// A cheap check before hashing: the saved file is still a readable regular
/// file of its recorded stored size.
fn saved_original_available(source: &SourceRecord) -> bool {
    std::fs::metadata(&source.path).is_ok_and(|metadata| {
        metadata.is_file()
            && metadata.len() == source.storage_size
            && std::fs::File::open(&source.path).is_ok()
    })
}

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
                "No original game files were selected.",
                "Choose one file or one game files folder, then check it again.",
            ));
        }
        if paths.len() != 1 {
            return Ok(static_result(
                "multiple_paths",
                "Choose one file or folder to check.",
                "Choose one file or one game files folder containing all the required files.",
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
                            "The selected file or folder cannot be checked for this game."
                        }
                        _ => "The selected game files could not be checked.",
                    }
                    .to_owned(),
                    next_action:
                        "Choose the required file or game files folder and check it again."
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
                self.library.forget_game_file_observation(path);
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
        release: Option<(&str, &str)>,
        checkpoint: &dyn Fn() -> Result<()>,
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
            checkpoint,
        )?;
        self.require_original_for_release(
            port,
            &registered,
            &assessment.classification,
            release,
            checkpoint,
        )?;
        Ok(registered)
    }

    pub(super) fn require_original_for_release(
        &self,
        port: &crate::PortDefinition,
        source: &SourceRecord,
        classification: &crate::SourceClassification,
        release: Option<(&str, &str)>,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        if let Some(release) = release
            && crate::source_inspection::verify_n64_release_input(
                &self.catalog,
                &port.id,
                Some(source),
                release,
                checkpoint,
            )?
            .is_some()
            && self
                .catalog
                .n64_legacy_migrations(&source.profile_id)
                .next()
                .is_some()
        {
            return Ok(());
        }
        self.require_original_setup_compatibility(port, classification)
    }

    pub(super) fn require_retained_n64_release_input(
        &self,
        install: &crate::InstallRecord,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        // Publication recovery can be checking a verified payload whose path
        // is not yet in the library. Older builds without retained policy do
        // not inherit a new input restriction from the current catalog.
        let Some(catalog) =
            crate::Installer::new(self.library.clone())?.retained_catalog(install)?
        else {
            return Ok(());
        };
        let release = (install.version.as_str(), install.artifact.sha256.as_str());
        let Some((profile_id, _)) =
            crate::source_inspection::n64_release_input(&catalog, &install.port_id, release)
        else {
            return Ok(());
        };
        let source = match self.pinned_original(&install.port_id, profile_id, &install.id)? {
            Some(binding) => Some(self.registered_profile_original(&binding)?),
            None if catalog.n64_legacy_migrations(profile_id).next().is_some() => {
                self.resolve_saved_n64_original(
                    &catalog,
                    &install.port_id,
                    profile_id,
                    release,
                    checkpoint,
                )?;
                return Ok(());
            }
            None => self.library.source(profile_id)?,
        };
        crate::source_inspection::verify_n64_release_input(
            &catalog,
            &install.port_id,
            source.as_ref(),
            release,
            checkpoint,
        )
        .map(|_| ())
    }

    pub(super) fn resolve_saved_n64_original(
        &self,
        catalog: &Catalog,
        port_id: &str,
        profile_id: &str,
        release: (&str, &str),
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<SourceRecord> {
        let mut budget = crate::source_inspection::n64_input_hash_budget(checkpoint);
        let mut verify = |source: &SourceRecord| {
            checkpoint()?;
            crate::source_inspection::verify_saved_n64_original(
                catalog,
                port_id,
                source,
                release,
                &mut budget,
            )
        };
        let is_candidate_failure = |error: &PortcoveError| {
            matches!(
                error.code,
                ErrorCode::NotFound
                    | ErrorCode::State
                    | ErrorCode::SourceInvalid
                    | ErrorCode::Verification
            )
        };
        let current = self.library.source(profile_id)?;
        let current_error = match &current {
            Some(source) => match verify(source) {
                Ok(()) => return Ok(source.clone()),
                Err(error) if is_candidate_failure(&error) => error,
                Err(error) => return Err(error),
            },
            None => {
                PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
                    .detail("profile_id", profile_id)
            }
        };
        // Every saved original is considered, a page at a time. Missing or
        // resized files are skipped before hashing, and the shared hash budget
        // bounds the work: exhausting it reports an unfinished check rather
        // than the absence of a usable original.
        let mut matching = None;
        let mut after = None::<String>;
        loop {
            let page = crate::source_instances::list_page(
                &self.library.connection()?,
                profile_id,
                after.as_deref(),
                SAVED_N64_ORIGINAL_PAGE,
            )?;
            let Some((last, _)) = page.last() else {
                break;
            };
            after = Some(last.clone());
            for (_, candidate) in page {
                if current.as_ref().is_some_and(|current| {
                    current.sha256 == candidate.sha256
                        && current.storage_sha256 == candidate.storage_sha256
                        && current.path == candidate.path
                }) || !saved_original_available(&candidate)
                {
                    continue;
                }
                match verify(&candidate) {
                    Ok(()) if matching.is_some() => return Err(PortcoveError::conflict(
                        "Several saved originals match this release. Choose the original you want to use.",
                    ).detail("profile_id", profile_id)),
                    Ok(()) => matching = Some(candidate),
                    Err(error) if is_candidate_failure(&error) => {}
                    Err(error) if error.details.get("scan_limit").map(String::as_str) == Some("hash_bytes") => {
                        return Err(PortcoveError::state(
                            "Portcove couldn't finish checking your other saved originals for this release. Try again, or choose the original you want to use.",
                        )
                        .detail("profile_id", profile_id)
                        .detail("saved_originals", "not_checked"));
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        matching.ok_or(current_error)
    }

    pub(super) fn uses_migrated_n64_original(
        &self,
        catalog: &Catalog,
        port: &crate::PortDefinition,
    ) -> bool {
        port.adapter == crate::AdapterKind::N64RecompPortable
            && port.source_profile.as_deref().is_some_and(|profile| {
                catalog.n64_legacy_migrations(profile).next().is_some()
                    || self.catalog.n64_legacy_migrations(profile).next().is_some()
            })
    }

    pub(super) fn has_saved_n64_original_to_recheck(
        &self,
        port: &crate::PortDefinition,
        install_id: Option<&str>,
        healthy_default: Option<&SourceRecord>,
    ) -> Result<bool> {
        let Some(profile) = port.source_profile.as_deref() else {
            return Ok(false);
        };
        if let Some(install_id) = install_id
            && let Some(binding) = self.pinned_original(&port.id, profile, install_id)?
        {
            return Ok(saved_original_available(
                &self.registered_profile_original(&binding)?,
            ));
        }
        let mut after = None::<String>;
        loop {
            let page = crate::source_instances::list_page(
                &self.library.connection()?,
                profile,
                after.as_deref(),
                SAVED_N64_ORIGINAL_PAGE,
            )?;
            let Some((last, _)) = page.last() else {
                return Ok(false);
            };
            after = Some(last.clone());
            if page.iter().any(|(_, candidate)| {
                healthy_default.is_none_or(|current| {
                    current.sha256 != candidate.sha256
                        || current.storage_sha256 != candidate.storage_sha256
                        || current.path != candidate.path
                }) && saved_original_available(candidate)
            }) {
                return Ok(true);
            }
        }
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::{
        CatalogEvidenceRole, InstallRecord, N64RecompOriginalInput, OperationCoordinator,
        SourceRepresentationKind,
    };

    #[test]
    fn migrated_n64_setup_uses_the_release_input_and_preserves_the_legacy_original() {
        const PORT: &str = "harvest-moon-64-recomp";
        const PROFILE: &str = "harvest-moon-64";
        let directory = tempfile::tempdir().unwrap();
        let older_path = directory.path().join("older.z64");
        let newer_path = directory.path().join("newer.z64");
        let older_bytes = [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 0];
        let newer_bytes = [0x80, 0x37, 0x12, 0x40, 0xa1, 0xb2, 0xc3, 0];
        std::fs::write(&older_path, older_bytes).unwrap();
        std::fs::write(&newer_path, newer_bytes).unwrap();

        let mut document = Catalog::embedded().unwrap().authoritative_document();
        let sources = document.source_catalog.as_mut().unwrap();
        let profile = sources
            .identities
            .iter_mut()
            .find(|profile| profile.id == PROFILE)
            .unwrap();
        let SourceRepresentationKind::CanonicalN64 { identities } =
            &mut profile.variants[0].representations[0].kind
        else {
            panic!("fixture requires a canonical legacy original");
        };
        identities[0].sha256 = Some(hex::encode(Sha256::digest(older_bytes)));
        let retained = Catalog::from_document(document.clone()).unwrap();
        let sources = document.source_catalog.as_mut().unwrap();
        let evidence = sources
            .evidence
            .iter()
            .find(|item| item.role == CatalogEvidenceRole::UpstreamSupport)
            .unwrap()
            .id
            .clone();
        let contract = sources
            .contracts
            .iter_mut()
            .find(|contract| contract.port_id == PORT)
            .unwrap();
        let artifact = "a".repeat(64);
        let other_artifact = "b".repeat(64);
        contract.evidence_ids.push(evidence);
        contract.n64_recomp_inputs_v1.push(N64RecompOriginalInput {
            upstream_ref: "current".into(),
            artifact_sha256: artifact.clone(),
            game_id: "harvest_moon_64".into(),
            rom_xxh3_64: "922d8d44f9f2e9a9".into(),
        });
        let migrated = Catalog::from_document(document).unwrap();
        let mut service =
            PortcoveService::new(Library::open(directory.path().join("library")).unwrap()).unwrap();
        service.replace_catalog_for_test(retained.clone());
        let older = service.register_source(PROFILE, &older_path).unwrap();
        assert!(service.inspect_source_record(PROFILE, &newer_path).is_err());

        let install =
            crate::test_fixture::register_qualification_install(service.library(), &retained, PORT);
        service.replace_catalog_for_test(migrated.clone());
        let artwork_profile =
            |catalog: &Catalog, active: InstallRecord, registered: &SourceRecord| {
                let channel = active.channel;
                let mut status = service.library().status(PORT, channel).unwrap();
                status.active = Some(active);
                service
                    .with_launch_readiness(
                        catalog,
                        catalog.port(PORT).unwrap(),
                        status,
                        &HashMap::from([(PROFILE.into(), registered.clone())]),
                        &mut HashMap::new(),
                        Ok(&Some(catalog.clone())),
                    )
                    .unwrap()
                    .readiness
                    .unwrap()
                    .active_game_source_profile
            };
        assert_eq!(
            artwork_profile(&retained, install.clone(), &older).as_deref(),
            Some(PROFILE)
        );
        let mut exact_release = install.clone();
        exact_release.version = "current".into();
        exact_release.artifact.sha256 = artifact.clone();
        assert_eq!(artwork_profile(&migrated, exact_release, &older), None);
        let port = service.catalog().port(PORT).unwrap();
        assert!(
            !service
                .has_saved_n64_original_to_recheck(port, None, Some(&older))
                .unwrap()
        );
        let operation = OperationCoordinator::new("n64-release-migration", None);
        let _guard = service.library().try_lock_port(PORT, "install").unwrap();
        for release in [
            ("current", other_artifact.as_str()),
            ("older", artifact.as_str()),
        ] {
            assert_eq!(
                service
                    .validate_and_remember_source(port, Some(&newer_path), release, &operation)
                    .unwrap_err()
                    .code,
                ErrorCode::SourceInvalid,
            );
            assert_eq!(
                service.library().source(PROFILE).unwrap().unwrap().sha256,
                older.sha256
            );
        }
        let newer = service
            .validate_and_remember_source(
                port,
                Some(&newer_path),
                ("current", &artifact),
                &operation,
            )
            .unwrap()
            .unwrap();
        assert_ne!(newer.sha256, older.sha256);
        assert_eq!(artwork_profile(&retained, install, &newer), None);
        assert!(
            service
                .has_saved_n64_original_to_recheck(port, None, Some(&newer))
                .unwrap()
        );

        assert_eq!(
            service.library().source(PROFILE).unwrap().unwrap().sha256,
            newer.sha256
        );
        assert_eq!(
            service
                .verified_original_for_setup(port, Some(("older", &other_artifact)), &|| Ok(()),)
                .unwrap_err()
                .code,
            ErrorCode::SourceInvalid,
        );
        for catalog in [&retained, &migrated] {
            let restored = service
                .resolve_saved_n64_original(
                    catalog,
                    PORT,
                    PROFILE,
                    ("older", &other_artifact),
                    &|| Ok(()),
                )
                .unwrap();
            assert_eq!(restored.sha256, older.sha256);
        }
        assert_eq!(
            service
                .resolve_saved_n64_original(
                    &migrated,
                    PORT,
                    PROFILE,
                    ("current", &artifact),
                    &|| Ok(())
                )
                .unwrap()
                .sha256,
            newer.sha256,
        );
        assert_eq!(std::fs::read(&older_path).unwrap(), older_bytes);
        assert_eq!(std::fs::read(&newer_path).unwrap(), newer_bytes);
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
