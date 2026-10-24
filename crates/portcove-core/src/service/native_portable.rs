//! Generic package ownership through the existing managed version lifecycle.
use super::*;

impl PortcoveService {
    /// A new artifact cannot silently reinterpret retained player-data locations.
    /// Ports needing data migration keep their current runtime until supported.
    pub(super) fn require_portable_transition(
        &self,
        from: &InstallRecord,
        to: &PortDefinition,
    ) -> Result<()> {
        let retained = self.installed_port(from)?;
        if retained.adapter != AdapterKind::NativePortable
            && to.adapter != AdapterKind::NativePortable
        {
            return Ok(());
        }
        let platform = Platform::current()?;
        if retained.adapter != to.adapter
            || retained.persistent_paths != to.persistent_paths
            || retained.persistent_file_patterns != to.persistent_file_patterns
            || retained.runtime_subdirectory != to.runtime_subdirectory
            || retained.launch_from_install_root != to.launch_from_install_root
            || retained.executable_hints.get(&platform) != to.executable_hints.get(&platform)
            || retained.user_data_environment != to.user_data_environment
        {
            return Err(PortcoveError::conflict(
                "The new package changes how this installation stores or locates player data. Keep the current version and use upstream instructions until a supported data migration is available. Your installation and files have been preserved.",
            ).with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged));
        }
        Ok(())
    }

    pub(super) fn require_portable_runtime_unchanged(&self, install: &InstallRecord) -> Result<()> {
        let port = self.installed_port(install)?;
        if port.adapter != AdapterKind::NativePortable {
            return Ok(());
        }
        let qualification = self.installed_mutability_qualification(install)?;
        let report =
            Installer::new(self.library.clone())?.verify_managed(install, &qualification)?;
        if !report.valid {
            return Err(PortcoveError::conflict(
                "Portable runtime files changed or unrecognized files were added. Keep this version and move your additions to a backed-up location before updating, switching versions or removing it. Review the reported paths; Portcove will not overwrite or delete them.",
            ).detail("failures", serde_json::to_string(&report.failures)?)
                .with_known_cause(crate::failure::KnownFailureCause::PortableRuntimeModified {
                    directory: install.path.clone(),
                    failures: report.failures,
                }));
        }
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::Duration,
    };

    struct Provider(Mutex<ResolvedRelease>);
    #[async_trait::async_trait]
    impl ReleaseProvider for Provider {
        async fn resolve(
            &self,
            _port: &PortDefinition,
            channel: ReleaseChannel,
            _platform: Platform,
        ) -> Result<ResolvedRelease> {
            let mut release = self.0.lock().unwrap().clone();
            release.channel = channel;
            Ok(release)
        }
    }
    struct Server {
        origin: String,
        bytes: Arc<Mutex<Vec<u8>>>,
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }
    impl Server {
        fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let content = bytes.clone();
            let stopped = stop.clone();
            let worker = thread::spawn(move || {
                while !stopped.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            // Windows can inherit the polling listener's mode.
                            // Finish the bounded request before replying: an early
                            // response/close can reset a still-arriving request.
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_write_timeout(Some(Duration::from_secs(5)))
                                .unwrap();
                            let mut request = [0_u8; 8192];
                            let deadline = std::time::Instant::now() + Duration::from_secs(5);
                            let mut used = 0;
                            loop {
                                let remaining = deadline
                                    .checked_duration_since(std::time::Instant::now())
                                    .expect("fixture request deadline");
                                stream.set_read_timeout(Some(remaining)).unwrap();
                                let read = stream.read(&mut request[used..]).unwrap();
                                assert!(read > 0, "fixture request ended before its headers");
                                used += read;
                                if request[..used].windows(4).any(|part| part == b"\r\n\r\n") {
                                    break;
                                }
                                assert!(used < request.len(), "fixture request exceeds bound");
                            }
                            let body = content.lock().unwrap().clone();
                            let header = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            stream.write_all(header.as_bytes()).unwrap();
                            stream.write_all(&body).unwrap();
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(error) => panic!("{error}"),
                    }
                }
            });
            Self {
                origin,
                bytes,
                stop,
                worker: Some(worker),
            }
        }
        fn release(&self, version: &str, revision: u8) -> ResolvedRelease {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            zip.start_file("game.exe", zip::write::SimpleFileOptions::default())
                .unwrap();
            let mut program = vec![revision; 128];
            program[..2].copy_from_slice(b"MZ");
            zip.write_all(&program).unwrap();
            zip.start_file("package.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&[revision]).unwrap();
            let bytes = zip.finish().unwrap().into_inner();
            let sha256 = hex::encode(Sha256::digest(&bytes));
            *self.bytes.lock().unwrap() = bytes.clone();
            ResolvedRelease {
                version: version.into(),
                channel: ReleaseChannel::Stable,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "game-windows-x64.zip".into(),
                    url: format!("{}/package.zip", self.origin),
                    size: bytes.len() as u64,
                    sha256,
                },
            }
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            self.worker.take().unwrap().join().unwrap();
        }
    }
    fn catalog() -> Catalog {
        Catalog::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[{"id":"portable-fixture","name":"Portable fixture","summary":"Generic upstream setup","project_url":"https://github.com/example/game","support_tier":"beta","channels":["stable","beta"],"platforms":["windows-x86-64"],"adapter":"native-portable","release":{"repository":"example/game","asset_hints":{"windows-x86-64":["windows","x64"]}},"executable_hints":{"windows-x86-64":["game.exe"]},"persistent_paths":["data","saves","mods","settings.ini"]}]}"#).unwrap()
    }
    fn build_service(library: Library, provider: Arc<Provider>) -> PortcoveService {
        let mut service = PortcoveService::with_provider(library, provider).unwrap();
        service.catalog = catalog();
        service
    }
    #[tokio::test]
    async fn portable_update_rebuild_staging_and_rollback_preserve_declared_data() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let service = build_service(library, provider.clone());
        let first = service
            .install("portable-fixture", None, None, None, true, |_| {})
            .await
            .unwrap();
        for (path, content) in [
            ("data/original.rom", b"original".as_slice()),
            ("saves/progress.sav", b"progress"),
            ("mods/player.mod", b"mod"),
            ("settings.ini", b"settings"),
        ] {
            let destination = first.path.join(path);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::write(destination, content).unwrap();
        }
        assert!(!first.path.join(LAUNCH_MARKER).exists());
        *provider.0.lock().unwrap() = server.release("v2", 2);
        assert!(
            service
                .check_update("portable-fixture")
                .await
                .unwrap()
                .update_available
        );
        let second = service
            .update("portable-fixture", None, None, true, |_| {})
            .await
            .unwrap();
        assert_ne!(second.id, first.id);
        assert!(first.path.exists());
        for path in [
            "data/original.rom",
            "saves/progress.sav",
            "mods/player.mod",
            "settings.ini",
        ] {
            assert_eq!(
                fs::read(first.path.join(path)).unwrap(),
                fs::read(second.path.join(path)).unwrap()
            );
        }
        // Rebuilt tag: changed archive identity is an update even without a new version string.
        *provider.0.lock().unwrap() = server.release("v2", 3);
        assert!(
            service
                .check_update("portable-fixture")
                .await
                .unwrap()
                .update_available
        );
        let rebuilt = service
            .update("portable-fixture", None, None, false, |_| {})
            .await
            .unwrap();
        assert!(rebuilt.staged);
        assert_eq!(
            service
                .status("portable-fixture")
                .unwrap()
                .active
                .unwrap()
                .id,
            second.id
        );
        let active = service.activate_staged("portable-fixture").unwrap();
        assert_eq!(active.id, rebuilt.id);
        let restored = service.rollback("portable-fixture").unwrap();
        assert_eq!(restored.id, second.id);
        assert_eq!(
            fs::read(restored.path.join("saves/progress.sav")).unwrap(),
            b"progress"
        );
        assert_eq!(
            service.status("portable-fixture").unwrap().update_policy,
            UpdatePolicy::Notify
        );
    }
    #[tokio::test]
    async fn changed_runtime_unknown_files_and_failed_update_keep_usable_previous_version() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider.clone());
        let first = service
            .install("portable-fixture", None, None, None, true, |_| {})
            .await
            .unwrap();
        *provider.0.lock().unwrap() = server.release("v2", 2);
        fs::write(first.path.join("unknown-player-file"), b"keep").unwrap();
        let error = service
            .update("portable-fixture", None, None, true, |_| {})
            .await
            .unwrap_err();
        assert!(error.message.contains("unrecognized files"));
        assert_eq!(
            error.presentation().presentation_key,
            "portable_runtime_modified"
        );
        assert!(error.presentation().summary.contains("Back up"));
        assert!(service.preview_removal("portable-fixture").is_err());
        assert_eq!(
            service
                .status("portable-fixture")
                .unwrap()
                .active
                .unwrap()
                .id,
            first.id
        );
        fs::rename(
            first.path.join("unknown-player-file"),
            temporary.path().join("preserved-player-file"),
        )
        .unwrap();
        struct Interrupt;
        impl LifecycleFaultInjector for Interrupt {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == LifecycleFaultPoint::InstallPublished {
                    Err(PortcoveError::state(
                        "fixture interruption after publication",
                    ))
                } else {
                    Ok(())
                }
            }
        }
        service.faults = Arc::new(Interrupt);
        assert!(
            service
                .update("portable-fixture", None, None, true, |_| {})
                .await
                .is_err()
        );
        assert_eq!(
            service
                .status("portable-fixture")
                .unwrap()
                .active
                .unwrap()
                .id,
            first.id
        );
        let recovered = build_service(library, provider);
        recovered.recover_pending_operations().unwrap();
        assert_eq!(
            recovered
                .status("portable-fixture")
                .unwrap()
                .active
                .unwrap()
                .id,
            first.id
        );
        recovered
            .update("portable-fixture", None, None, true, |_| {})
            .await
            .unwrap();
        assert_eq!(
            fs::read(temporary.path().join("preserved-player-file")).unwrap(),
            b"keep"
        );
        assert!(first.path.join("game.exe").exists());
    }

    #[tokio::test]
    async fn retained_portable_contract_checks_all_runtime_files_and_refuses_data_reinterpretation()
    {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library, provider.clone());
        let first = service
            .install("portable-fixture", None, None, None, true, |_| {})
            .await
            .unwrap();
        fs::write(first.path.join("package.txt"), b"locally modified").unwrap();
        let qualification = service.installed_mutability_qualification(&first).unwrap();
        assert!(
            Installer::new(service.library.clone())
                .unwrap()
                .verify_critical(&first, &qualification)
                .is_err()
        );
        assert!(
            service
                .update("portable-fixture", None, None, true, |_| {})
                .await
                .is_err()
        );
        fs::write(first.path.join("package.txt"), [1]).unwrap();
        fs::create_dir_all(first.path.join("saves")).unwrap();
        fs::write(first.path.join("saves/progress.sav"), b"keep progress").unwrap();
        *provider.0.lock().unwrap() = server.release("v2", 2);
        let mut document = serde_json::to_value(catalog().document()).unwrap();
        document["ports"][0]["persistent_paths"] =
            serde_json::json!(["Save", "data", "mods", "settings.ini"]);
        service.catalog = Catalog::from_json(&document.to_string()).unwrap();
        let failure = service
            .update("portable-fixture", None, None, true, |_| {})
            .await
            .unwrap_err();
        assert!(failure.message.contains("player data"));
        assert_eq!(
            failure.presentation().presentation_key,
            "portable_data_contract_changed"
        );
        assert_eq!(
            service
                .status("portable-fixture")
                .unwrap()
                .active
                .unwrap()
                .id,
            first.id
        );
        assert_eq!(
            fs::read(first.path.join("saves/progress.sav")).unwrap(),
            b"keep progress"
        );
    }

    #[tokio::test]
    async fn portable_platform_hints_and_post_stage_refusal_preserve_current_state() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library, provider.clone());
        let first = service
            .install("portable-fixture", None, None, None, true, |_| {})
            .await
            .unwrap();
        fs::create_dir_all(first.path.join("saves")).unwrap();
        fs::write(first.path.join("saves/progress.sav"), b"keep progress").unwrap();
        service.catalog =
            Catalog::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[]}"#).unwrap();
        service
            .collect_active_user_data_if_launched("portable-fixture")
            .unwrap();
        assert_eq!(
            fs::read(
                service
                    .library
                    .user_dir("portable-fixture")
                    .join("saves/progress.sav")
            )
            .unwrap(),
            b"keep progress"
        );
        let mut document = serde_json::to_value(catalog().document()).unwrap();
        document["ports"][0]["platforms"] = serde_json::json!(["windows-x86-64", "linux-x86-64"]);
        document["ports"][0]["executable_hints"]["linux-x86-64"] = serde_json::json!(["game"]);
        document["ports"][0]["release"]["asset_hints"]["linux-x86-64"] =
            serde_json::json!(["linux", "x64"]);
        service.catalog = Catalog::from_json(&document.to_string()).unwrap();
        *provider.0.lock().unwrap() = server.release("v2", 2);
        let staged = service
            .update("portable-fixture", None, None, false, |_| {})
            .await
            .unwrap();
        assert!(staged.staged);
        fs::write(
            first.path.join("unknown-player-file"),
            b"preserve this addition",
        )
        .unwrap();
        let failure = service
            .activate_staged("portable-fixture")
            .unwrap_err()
            .report();
        assert_eq!(
            failure.presentation.presentation_key,
            "portable_runtime_modified"
        );
        assert_ne!(
            failure.presentation.mutation_state,
            crate::MutationState::NoChanges
        );
        let state = service.status("portable-fixture").unwrap();
        assert_eq!(state.active.unwrap().id, first.id);
        assert_eq!(state.staged.unwrap().id, staged.id);
        assert_eq!(
            fs::read(first.path.join("unknown-player-file")).unwrap(),
            b"preserve this addition"
        );
        fs::remove_file(first.path.join("unknown-player-file")).unwrap();
        let second = service.activate_staged("portable-fixture").unwrap();
        assert_eq!(second.id, staged.id);
        assert_eq!(
            fs::read(second.path.join("saves/progress.sav")).unwrap(),
            b"keep progress"
        );
        document["ports"][0]["executable_hints"]["windows-x86-64"] =
            serde_json::json!(["different.exe"]);
        service.catalog = Catalog::from_json(&document.to_string()).unwrap();
        *provider.0.lock().unwrap() = server.release("v3", 3);
        let failure = service
            .update("portable-fixture", None, None, true, |_| {})
            .await
            .unwrap_err();
        assert_eq!(
            failure.presentation().presentation_key,
            "portable_data_contract_changed"
        );
        assert_eq!(
            service
                .status("portable-fixture")
                .unwrap()
                .active
                .unwrap()
                .id,
            second.id
        );
    }

    #[tokio::test]
    async fn failure_after_activation_reports_the_committed_version_and_recovers_without_reversal()
    {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider.clone());
        let first = service
            .install("portable-fixture", None, None, None, true, |_| {})
            .await
            .unwrap();
        fs::create_dir_all(first.path.join("data")).unwrap();
        fs::write(
            first.path.join("data/original.rom"),
            b"authorized synthetic original",
        )
        .unwrap();
        *provider.0.lock().unwrap() = server.release("v2", 2);
        struct Interrupt;
        impl LifecycleFaultInjector for Interrupt {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == LifecycleFaultPoint::ActivationMetadataCommitted {
                    Err(PortcoveError::state(
                        "fixture interruption after activation",
                    ))
                } else {
                    Ok(())
                }
            }
        }
        service.faults = Arc::new(Interrupt);
        assert!(
            service
                .update("portable-fixture", None, None, true, |_| {})
                .await
                .is_err()
        );
        let committed = service.status("portable-fixture").unwrap().active.unwrap();
        assert_eq!(committed.version, "v2");
        assert_ne!(committed.id, first.id);
        assert_eq!(
            fs::read(committed.path.join("data/original.rom")).unwrap(),
            b"authorized synthetic original"
        );
        let recovered = build_service(library, provider);
        recovered.recover_pending_operations().unwrap();
        assert_eq!(
            recovered
                .status("portable-fixture")
                .unwrap()
                .active
                .unwrap()
                .id,
            committed.id
        );
        assert_eq!(
            fs::read(first.path.join("data/original.rom")).unwrap(),
            b"authorized synthetic original"
        );
    }
}
