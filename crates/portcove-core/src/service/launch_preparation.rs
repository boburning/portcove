//! Read-only managed launch inputs followed by explicit preparation.
//!
//! Observed inputs describe checked facts, not authority to mutate or spawn.
//! The supervisor retains its port lock and operation checkpoints; preparation
//! still rechecks the executable and source after mutating saves/adapter data.

use std::path::Path;

use crate::{
    Adapter, Catalog, DefinitionOperation, InstallQualification, InstallRecord, Installer,
    OperationCoordinator, Platform, PortDefinition, PortcoveError, Result, SourceRecord,
    definition_eligibility::DefinitionOperationContext, operation::LifecycleFaultPoint,
};

use super::{LAUNCH_MARKER, PortcoveService};

pub(super) struct ManagedLaunchInputs {
    catalog: Catalog,
    qualification: InstallQualification,
    source: Option<SourceRecord>,
    bios: Option<SourceRecord>,
}

impl PortcoveService {
    pub(crate) fn managed_launch_context(
        &self,
        identity: Option<&crate::DefinitionSelectionIdentity>,
        active: &InstallRecord,
    ) -> Result<DefinitionOperationContext> {
        let mut context = DefinitionOperationContext::observed(
            DefinitionOperation::Launch,
            true,
            active.verified,
        );
        if let Some(identity) = identity
            && crate::definition_repository::publisher_policy::launch_assessment::requires_subject(
                &self.library.connection()?,
                identity,
            )?
        {
            context.launch_subject = Some(crate::install::verified_launch_subject(active)?);
        }
        Ok(context)
    }

    pub(super) fn observe_managed_launch_inputs(
        &self,
        port: &PortDefinition,
        active: &InstallRecord,
        source_override: Option<&Path>,
        operation: Option<&OperationCoordinator>,
    ) -> Result<ManagedLaunchInputs> {
        if port.id != active.port_id {
            return Err(PortcoveError::verification(
                "launch installation belongs to another port",
            ));
        }
        let catalog = self.installed_catalog(active)?;
        let port = catalog.port(&active.port_id)?;
        self.require_installed_shared_preferences(active)?;
        self.require_ghostship_install_data_compatibility(active, None)?;
        let qualification = self.installed_mutability_qualification(active)?;
        let checkpoint = || operation.map_or(Ok(()), OperationCoordinator::checkpoint);
        checkpoint()?;
        crate::runtime::require_ready(port, Platform::current()?, active)?;
        checkpoint()?;
        self.managed_install_root(&port.id, &active.path)?;
        crate::preparation::require_manual_setup(port, active)?;
        checkpoint()?;
        let executable =
            Installer::new(self.library.clone())?.verify_critical(active, &qualification)?;
        crate::runtime_path_policy::check_executable(port, Platform::current()?, &executable)?;
        checkpoint()?;
        let source = if let Some(path) = source_override {
            let profile_id = port.source_profile.as_deref().ok_or_else(|| {
                PortcoveError::usage(format!("{} does not accept a source override", port.name))
            })?;
            let source = Some(
                crate::source_inspection::inspect_with_checkpoint(
                    &catalog,
                    profile_id,
                    path,
                    &checkpoint,
                )?
                .require_admitted_record()?,
            );
            checkpoint()?;
            source
        } else if let Some(profile) = &port.source_profile {
            if self.library.source(profile)?.is_some() {
                Some(self.verified_source_record_with_checkpoint(&catalog, profile, &checkpoint)?)
            } else {
                None
            }
        } else {
            None
        };
        let bios = if port.adapter == crate::AdapterKind::PsxRecompManaged {
            let bios = crate::psx::verified_launch_bios(&self.library, port, active, &checkpoint)?;
            if let Some(bios) = &bios {
                Self::verify_source_record_with_checkpoint(&catalog, bios, &checkpoint)?;
            }
            bios
        } else {
            None
        };
        for (source, role) in [
            (source.as_ref(), crate::PortSourceRole::Game),
            (bios.as_ref(), crate::PortSourceRole::Bios),
        ] {
            if let Some(source) = source {
                crate::source_inspection::require_launch_source_compatibility(
                    &catalog,
                    &port.id,
                    source,
                    role,
                    (&active.version, &active.artifact.sha256),
                )?;
            }
        }
        self.require_definition_operation(
            &catalog,
            port,
            self.managed_launch_context(catalog.definition_selection(&port.id), active)?,
        )?;
        if crate::preparation::managed_install(port, active) {
            self.validate_preparation_receipt(port, active, source.as_ref())?;
            if !Installer::new(self.library.clone())?
                .verify_managed(active, &qualification)?
                .valid
            {
                return Err(PortcoveError::verification(
                    "prepared game data changed; repair or prepare it again",
                ));
            }
        }
        Ok(ManagedLaunchInputs {
            catalog,
            qualification,
            source,
            bios,
        })
    }

    pub(super) fn prepare_launch_for_install(
        &self,
        port: &PortDefinition,
        active: &InstallRecord,
        source_override: Option<&Path>,
        operation: Option<&OperationCoordinator>,
    ) -> Result<crate::LaunchSpec> {
        let ManagedLaunchInputs {
            catalog,
            qualification,
            source,
            bios,
        } = self.observe_managed_launch_inputs(port, active, source_override, operation)?;
        let port = catalog.port(&active.port_id)?;
        let checkpoint = || operation.map_or(Ok(()), OperationCoordinator::checkpoint);
        if active.path.join(LAUNCH_MARKER).is_file()
            || crate::persistence::collect_before_first_launch(port)
        {
            self.collect_user_data_from(port, &active.path)?;
            checkpoint()?;
        }
        self.prepare_ghostship_legacy_archive(active)?;
        checkpoint()?;
        self.restore_user_data_to(port, &active.path)?;
        checkpoint()?;
        self.recheck_launch_bios(&catalog, port, active, bios.as_ref(), &checkpoint)?;
        let selected_executable =
            Installer::new(self.library.clone())?.verify_critical(active, &qualification)?;
        checkpoint()?;
        let mut spec = crate::adapter::standard(port.adapter).prepare_launch_with_executable(
            crate::LaunchSpecRequest {
                library: &self.library,
                port,
                platform: Platform::current()?,
                install_root: &active.path,
                selected_executable: &selected_executable,
                source: source.as_ref().map(|record| record.path.as_path()),
                source_record: source.as_ref(),
            },
            &checkpoint,
        )?;
        if active.port_id == "ghostship" && active.version == "2.0.0" && !spec.arguments.is_empty()
        {
            return Err(PortcoveError::verification(
                "prepared legacy launch must use zero added arguments",
            ));
        }
        if active.port_id == "ghostship" && active.version == "2.0.0" {
            // The pinned Windows runtime uses CWD and ignores SHIP_HOME.
            spec.environment.remove("SHIP_HOME");
            self.require_ghostship_legacy_runtime_archive(active, &spec.working_directory)?;
        }
        self.faults.check(LifecycleFaultPoint::SourcePrepared)?;
        checkpoint()?;
        if let Some(source) = &source {
            Self::verify_source_record_with_checkpoint(&catalog, source, &checkpoint)?;
        }
        checkpoint()?;
        self.recheck_launch_bios(&catalog, port, active, bios.as_ref(), &checkpoint)?;
        self.refresh_upstream_setup_manifest(port, active, &spec.working_directory)?;
        crate::preparation::require_manual_setup(port, active)?;
        checkpoint()?;
        Ok(spec)
    }
    fn recheck_launch_bios(
        &self,
        catalog: &Catalog,
        port: &PortDefinition,
        active: &InstallRecord,
        observed: Option<&SourceRecord>,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        if port.adapter != crate::AdapterKind::PsxRecompManaged {
            return Ok(());
        }
        let current = crate::psx::verified_launch_bios(&self.library, port, active, checkpoint)?;
        if serde_json::to_value(&current)? != serde_json::to_value(observed)? {
            return Err(PortcoveError::conflict(
                "registered PS1 BIOS changed during launch preparation",
            ));
        }
        if let Some(bios) = observed {
            Self::verify_source_record_with_checkpoint(catalog, bios, checkpoint)?;
            let current =
                crate::psx::verified_launch_bios(&self.library, port, active, &|| Ok(()))?;
            if serde_json::to_value(&current)? != serde_json::to_value(observed)? {
                return Err(PortcoveError::conflict(
                    "registered PS1 BIOS changed during launch preparation",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check_source_cancellation_in_second_pass(route: &str) {
        use sha2::{Digest, Sha256};
        use std::{
            fs,
            io::Write,
            sync::{
                Arc,
                atomic::{AtomicBool, Ordering},
                mpsc,
            },
            thread,
            time::Duration,
        };

        let temporary = tempfile::tempdir().unwrap();
        let library = crate::Library::open(temporary.path().join("library")).unwrap();
        let service = Arc::new(PortcoveService::new(library.clone()).unwrap());
        let files = [
            ("baserom.us.rev0.z64", vec![0x55; 2 * 1024 * 1024]),
            ("baserom.translated.ek.ndd", b"expansion".to_vec()),
            ("N64DDIPLROM.n64", b"ipl".to_vec()),
        ];
        let profile_id = if route == "raw" {
            "psx-scph-1001-bios"
        } else {
            "g-diffuser-source-set"
        };
        let mut document = service.catalog().authoritative_document();
        let profile = document
            .source_catalog
            .as_mut()
            .unwrap()
            .identities
            .iter_mut()
            .find(|profile| profile.id == profile_id)
            .unwrap();
        for variant in profile
            .variants
            .iter_mut()
            .filter(|variant| !variant.legacy_projection_only)
        {
            for representation in &mut variant.representations {
                match &mut representation.kind {
                    crate::SourceRepresentationKind::RawFile { identities } => {
                        *identities = vec![crate::DigestIdentity {
                            scope: crate::DigestScope::OriginalFile,
                            sha1: None,
                            sha256: Some(hex::encode(Sha256::digest(&files[0].1))),
                            crc32: None,
                        }];
                    }
                    crate::SourceRepresentationKind::FileSet { members } => {
                        for (member, (_, bytes)) in members.iter_mut().zip(&files) {
                            member.identities = vec![crate::DigestIdentity {
                                scope: crate::DigestScope::FileSetMember,
                                sha1: None,
                                sha256: Some(hex::encode(Sha256::digest(bytes))),
                                crc32: None,
                            }];
                        }
                    }
                    _ => {}
                }
            }
        }
        let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let path = temporary.path().join(if route == "zip" {
            "original.zip"
        } else if route == "raw" {
            "bios.bin"
        } else {
            "original"
        });
        if route == "zip" {
            let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            for (name, bytes) in &files {
                writer
                    .start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        } else if route == "directory" {
            fs::create_dir(&path).unwrap();
            for (name, bytes) in &files {
                fs::write(path.join(name), bytes).unwrap();
            }
        } else {
            fs::write(&path, &files[0].1).unwrap();
        }
        let registered = crate::source_inspection::inspect(&catalog, profile_id, &path)
            .unwrap()
            .require_admitted_record()
            .unwrap();
        library.register_source(&registered).unwrap();
        // This also catches the former CHD-storage prepass on file-set directories.
        PortcoveService::verify_source_record_with_checkpoint(&catalog, &registered, &|| Ok(()))
            .unwrap();
        let original = if route == "directory" {
            path.join(files[0].0)
        } else {
            path.clone()
        };
        let original_bytes = fs::read(&original).unwrap();
        let baseline = serde_json::to_value(library.source(profile_id).unwrap()).unwrap();
        let (activity, operation) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Launch,
                crate::ActivityTargetKind::Source,
                Some(profile_id),
            )
            .unwrap();
        let operation_id = activity.id.clone();
        let (entered, observed) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let (finished, completion) = mpsc::channel();
        let health_profile = catalog.source_profile(profile_id).unwrap().clone();
        let health_record = registered.clone();
        let worker_service = Arc::clone(&service);
        let worker_library = library.clone();
        let worker_id = operation_id.clone();
        let worker = thread::spawn(move || {
            let stopped = AtomicBool::new(false);
            crate::source_file::HASH_READ_OBSERVER.with(|observer| {
                *observer.borrow_mut() = Some(Box::new(move |bytes| {
                    if !stopped.swap(true, Ordering::SeqCst) {
                        entered.send(bytes).unwrap();
                        released.recv_timeout(Duration::from_secs(10)).unwrap();
                    }
                }))
            });
            let result = PortcoveService::verify_source_record_with_checkpoint(
                &catalog,
                &registered,
                &|| {
                    operation.checkpoint()?;
                    // Observe the durable request without a wall-clock-dependent cache wait.
                    if crate::cancellation::cancellation_state(&worker_library, &worker_id)?
                        .is_some_and(|state| state.requested)
                    {
                        return Err(PortcoveError::new(
                            crate::ErrorCode::Cancelled,
                            "cancelled during source inspection",
                        ));
                    }
                    Ok(())
                },
            );
            crate::source_file::HASH_READ_OBSERVER.with(|observer| observer.borrow_mut().take());
            let result = worker_service.finish_activity(activity, result);
            finished.send(result.unwrap_err().code).unwrap();
        });
        let read_bytes = observed.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(
            read_bytes > 0 && read_bytes < files[0].1.len() as u64,
            "{route}"
        );
        service.request_cancellation(&operation_id).unwrap();
        assert!(
            completion.try_recv().is_err(),
            "worker must remain owned while blocked: {route}"
        );
        assert_eq!(
            serde_json::to_value(library.source(profile_id).unwrap()).unwrap(),
            baseline
        );
        release.send(()).unwrap();
        assert_eq!(
            completion.recv_timeout(Duration::from_secs(10)).unwrap(),
            crate::ErrorCode::Cancelled,
            "{route}"
        );
        worker.join().unwrap();
        assert_eq!(
            serde_json::to_value(library.source(profile_id).unwrap()).unwrap(),
            baseline
        );
        let original = if route == "directory" {
            path.join(files[0].0)
        } else {
            path.clone()
        };
        assert_eq!(fs::read(&original).unwrap(), original_bytes);
        assert!(library.launch_sessions().unwrap().is_empty());
        if route == "directory" {
            fs::OpenOptions::new()
                .write(true)
                .open(&original)
                .unwrap()
                .set_len(512 * 1024 * 1024 + 1)
                .unwrap();
            assert_eq!(
                crate::adapter::inspect_source_health(&health_profile, &health_record),
                crate::SourceHealth::Changed
            );
        }
    }

    #[test]
    fn raw_source_cancellation_reaches_second_verification_pass() {
        check_source_cancellation_in_second_pass("raw");
    }

    #[test]
    fn directory_source_cancellation_reaches_second_verification_pass() {
        check_source_cancellation_in_second_pass("directory");
    }

    #[test]
    fn zip_source_cancellation_reaches_second_verification_pass() {
        check_source_cancellation_in_second_pass("zip");
    }

    #[test]
    fn managed_bios_checkpoint_recheck_rejects_changed_registration_and_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, catalog, install, bios) = crate::psx::bios_launch_fixture(temporary.path());
        let service = PortcoveService::new(library.clone()).unwrap();
        let port = catalog.port(&install.port_id).unwrap();
        service
            .recheck_launch_bios(&catalog, port, &install, Some(&bios), &|| Ok(()))
            .unwrap();
        let mut stale = bios.clone();
        stale.updated_at += 1;
        library.register_source(&stale).unwrap();
        let error = service
            .recheck_launch_bios(&catalog, port, &install, Some(&bios), &|| Ok(()))
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        library.register_source(&bios).unwrap();
        let calls = std::cell::Cell::new(0);
        service
            .recheck_launch_bios(&catalog, port, &install, Some(&bios), &|| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap();
        let final_checkpoint = calls.get();
        calls.set(0);
        let checkpoint = || {
            calls.set(calls.get() + 1);
            // Change registration at the measured final admission checkpoint.
            if calls.get() == final_checkpoint {
                library.register_source(&stale)?;
            }
            Ok(())
        };
        assert!(
            service
                .recheck_launch_bios(&catalog, port, &install, Some(&bios), &checkpoint)
                .is_err()
        );
        assert_eq!(calls.get(), final_checkpoint);
        library.register_source(&bios).unwrap();
        let changed = std::cell::Cell::new(false);
        let checkpoint = || {
            if !changed.replace(true) {
                std::fs::write(&bios.path, b"changed at launch checkpoint")?;
            }
            Ok(())
        };
        assert!(
            service
                .recheck_launch_bios(&catalog, port, &install, Some(&bios), &checkpoint)
                .is_err()
        );
        assert_eq!(
            std::fs::read(&bios.path).unwrap(),
            b"changed at launch checkpoint"
        );
    }
}
