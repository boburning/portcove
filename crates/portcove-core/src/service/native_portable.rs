//! Generic package ownership through the existing managed version lifecycle.
use super::*;

impl PortcoveService {
    /// Resolve only the registered managed copy's retained setup coordinates.
    /// Returning a directory grants no helper execution or external ownership.
    pub fn manual_setup_directory(&self, port_id: &str, install_id: &str) -> Result<PathBuf> {
        let _lock = self.library.try_lock_port(port_id, "open-manual-setup")?;
        let active = self.status(port_id)?.active.ok_or_else(|| {
            PortcoveError::conflict("The installation changed. Refresh before opening setup.")
        })?;
        if active.id != install_id {
            return Err(PortcoveError::conflict(
                "The installation changed. Refresh before opening setup.",
            ));
        }
        let port = self.installed_port(&active)?;
        if !crate::preparation::has_manual_marker(&port) {
            return Err(PortcoveError::usage(
                "This installation has no manual setup folder.",
            ));
        }
        self.managed_install_root(port_id, &active.path)?;
        let root = crate::runtime::working_root(&port, &active);
        crate::path::refuse_symlink_ancestors(&root)?;
        if !fs::symlink_metadata(&root)?.is_dir() {
            return Err(PortcoveError::verification(
                "The setup directory is unavailable.",
            ));
        }
        Ok(root)
    }

    /// A new artifact cannot silently reinterpret retained player-data locations.
    /// Ports needing data migration keep their current runtime until supported.
    pub(super) fn require_portable_transition(
        &self,
        from: &InstallRecord,
        to: &PortDefinition,
    ) -> Result<()> {
        self.require_portable_transition_to(from, to, false)
    }

    pub(super) fn require_portable_rollback_transition(
        &self,
        from: &InstallRecord,
        previous: &InstallRecord,
    ) -> Result<()> {
        if from.port_id != previous.port_id {
            return Err(PortcoveError::verification(
                "rollback target belongs to another port",
            ));
        }
        self.require_portable_transition_to(from, &self.installed_port(previous)?, true)
    }

    fn require_portable_transition_to(
        &self,
        from: &InstallRecord,
        to: &PortDefinition,
        retained_rollback: bool,
    ) -> Result<()> {
        let retained = self.installed_port(from)?;
        if retained.adapter != AdapterKind::NativePortable
            && to.adapter != AdapterKind::NativePortable
            && !crate::persistence::ready_staged_archive(&retained)
            && !crate::persistence::ready_staged_archive(to)
        {
            return Ok(());
        }
        let platform = Platform::current()?;
        if retained.adapter != to.adapter
            || crate::persistence::ready_staged_archive(&retained)
                != crate::persistence::ready_staged_archive(to)
            || retained.persistent_paths != to.persistent_paths
            || retained.mod_package_policy != to.mod_package_policy
            || retained.persistent_file_patterns != to.persistent_file_patterns
            || retained.runtime_subdirectory != to.runtime_subdirectory
            || retained.launch_from_install_root != to.launch_from_install_root
            || retained.executable_hints.get(&platform) != to.executable_hints.get(&platform)
            || retained.launch_arguments != to.launch_arguments
            || retained.launch_environment != to.launch_environment
            || retained.user_data_environment != to.user_data_environment
            || retained.source_profile != to.source_profile
            || retained.runtime_source_filename != to.runtime_source_filename
            || retained.runtime_source_materialization != to.runtime_source_materialization
            || retained.runtime_source_hashes != to.runtime_source_hashes
            || retained.source_environment != to.source_environment
            || (retained.setup_marker != to.setup_marker
                && !(retained.setup_marker.is_none()
                    && crate::preparation::has_manual_marker(to)
                    && crate::preparation::validate_manual_marker(to).is_ok())
                && !(retained_rollback
                    && crate::preparation::has_manual_marker(&retained)
                    && to.setup_marker.is_none()))
        {
            return Err(PortcoveError::conflict(
                "The new package changes how this installation stores or locates player data. Keep the current version and use upstream instructions until a supported data migration is available. Your installation and files have been preserved.",
            ).with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged));
        }
        Ok(())
    }

    pub(super) fn require_portable_runtime_unchanged(&self, install: &InstallRecord) -> Result<()> {
        let port = self.installed_port(install)?;
        if port.adapter != AdapterKind::NativePortable
            && !crate::persistence::ready_staged_archive(&port)
        {
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
            self.release_in_folder(version, revision, "", "game.exe")
        }
        fn release_in_folder(
            &self,
            version: &str,
            revision: u8,
            folder: &str,
            program_name: &str,
        ) -> ResolvedRelease {
            self.release_with_files(version, revision, folder, program_name, &[])
        }
        fn release_with_files(
            &self,
            version: &str,
            revision: u8,
            folder: &str,
            program_name: &str,
            files: &[(&str, &[u8])],
        ) -> ResolvedRelease {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            zip.start_file(
                format!("{folder}{program_name}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            let mut program = vec![revision; 128];
            program[..2].copy_from_slice(b"MZ");
            zip.write_all(&program).unwrap();
            zip.start_file(
                format!("{folder}package.txt"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(&[revision]).unwrap();
            if !folder.is_empty() {
                zip.start_file(
                    format!("{folder}data/textures/100.txm"),
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
                zip.write_all(&[revision]).unwrap();
            }
            for (path, bytes) in files {
                zip.start_file(
                    format!("{folder}{path}"),
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
                zip.write_all(bytes).unwrap();
            }
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
    async fn manual_setup_progress_uses_retained_wrapper_and_never_runs_a_helper() {
        const ID: &str = "portable-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(
            server.release_in_folder("1", 1, "v1/", "game.exe"),
        )));
        let mut service = build_service(library.clone(), provider.clone());
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let mut document = serde_json::to_value(catalog().authoritative_document()).unwrap();
        document["ports"][0]["setup_marker"] = serde_json::json!("data/extract-info.json");
        let next_catalog = Catalog::from_json(&document.to_string()).unwrap();
        service.replace_catalog_for_test(next_catalog.clone());
        // Current catalog additions do not rewrite the old installation's contract.
        assert!(!service.status(ID).unwrap().readiness.unwrap().pending_setup);
        assert!(service.manual_setup_directory(ID, &first.id).is_err());
        fs::write(
            first.path.join("v1/data/owned"),
            b"prepared before first Play",
        )
        .unwrap();
        *provider.0.lock().unwrap() = server.release_in_folder("2", 2, "v2/", "game.exe");
        service.update(ID, None, None, false, |_| {}).await.unwrap();
        let second = service.activate_staged(ID).unwrap();
        let root = second.path.join("v2");
        assert_eq!(
            fs::read(root.join("data/owned")).unwrap(),
            b"prepared before first Play"
        );
        assert_eq!(
            service.manual_setup_directory(ID, &second.id).unwrap(),
            root
        );
        assert!(service.manual_setup_directory(ID, &first.id).is_err());
        let port = next_catalog.port(ID).unwrap();
        let marker = root.join("data/extract-info.json");
        let assert_pending = |service: &PortcoveService| {
            let readiness = service.status(ID).unwrap().readiness.unwrap();
            assert!(readiness.pending_setup);
            assert!(!readiness.launchable);
            assert!(
                readiness
                    .blockers
                    .contains(&LaunchBlocker::PreparationRequired)
            );
            let error = service
                .prepare_launch_for_install(port, &second, None, None)
                .unwrap_err();
            assert_eq!(error.details["path"], marker.display().to_string());
        };
        assert_pending(&service);
        for invalid in [b"".as_slice(), b"{", b"[]", b"null", &vec![b' '; 65537]] {
            fs::write(&marker, invalid).unwrap();
            assert_pending(&service);
        }
        fs::remove_file(&marker).unwrap();
        let other = temporary.path().join("separate.json");
        fs::write(&other, b"{\"disc\":\"inert fixture\"}").unwrap();
        fs::hard_link(&other, &marker).unwrap();
        assert_pending(&service);
        fs::remove_file(&marker).unwrap();
        // Model upstream's atomic completion publication without executing it.
        let pending = root.join("data/extract-info.json.partial");
        fs::write(&pending, b"{\"disc\":\"inert fixture\",\"data_format\":1}").unwrap();
        assert_pending(&service);
        fs::rename(&pending, &marker).unwrap();
        let restarted = build_service(library.clone(), provider.clone());
        let readiness = restarted.status(ID).unwrap().readiness.unwrap();
        assert!(!readiness.pending_setup);
        assert!(readiness.launchable);
        let spec = restarted
            .prepare_launch_for_install(port, &second, None, None)
            .unwrap();
        assert_eq!(spec.working_directory, root);
        assert!(!second.path.join(LAUNCH_MARKER).exists());
        fs::remove_file(&marker).unwrap();
        assert_pending(&restarted);
        let mut changed = port.clone();
        changed.setup_marker = Some("data/another.json".into());
        assert!(
            restarted
                .require_portable_transition(&second, &changed)
                .is_err()
        );
        changed.setup_marker = None;
        assert!(
            restarted
                .require_portable_transition(&second, &changed)
                .is_err()
        );
        // Runtime rollback retains historical semantics and carries current data.
        assert_eq!(restarted.rollback(ID).unwrap().id, first.id);
        assert_eq!(
            fs::read(first.path.join("v1/data/owned")).unwrap(),
            b"prepared before first Play"
        );
    }

    #[tokio::test]
    async fn ready_archive_profile_times_survive_update_backup_and_runtime_rollback() {
        const ID: &str = "infinite-undiscovery-doc-haz";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release_in_folder(
            "v1.0.0-rc1",
            1,
            "",
            "InfiniteUndiscoveryRecomp.exe",
        ))));
        let service = PortcoveService::with_provider(library.clone(), provider.clone()).unwrap();
        let first = service
            .install(ID, Some(ReleaseChannel::Beta), None, None, true, |_| {})
            .await
            .unwrap();
        let relative = "USA/assets/disc1/owned-original.bin";
        let original = first.path.join(relative);
        fs::create_dir_all(original.parent().unwrap()).unwrap();
        fs::write(&original, b"inert owned data, not retail content").unwrap();
        let stamp = std::time::UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_700);
        fs::OpenOptions::new()
            .write(true)
            .open(&original)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(stamp))
            .unwrap();
        fs::write(first.path.join("setup.json"), b"selected USA profile").unwrap();
        fs::create_dir_all(first.path.join("USA/saves")).unwrap();
        fs::write(first.path.join("USA/saves/progress"), b"before first Play").unwrap();
        fs::create_dir_all(first.path.join("USA/cache")).unwrap();
        fs::write(
            first.path.join("USA/cache/runtime.toml"),
            b"user runtime settings",
        )
        .unwrap();
        fs::create_dir_all(first.path.join("USA/shaders")).unwrap();
        fs::write(
            first.path.join("USA/shaders/old-cache"),
            b"old shader cache",
        )
        .unwrap();
        assert!(!first.path.join(LAUNCH_MARKER).exists());
        let backup = service.create_backup(ID).unwrap();
        assert_eq!(
            fs::metadata(backup.path.join("data").join(relative))
                .unwrap()
                .modified()
                .unwrap(),
            stamp
        );
        assert!(!backup.path.join("data/USA/shaders").exists());
        *provider.0.lock().unwrap() =
            server.release_in_folder("v1.0.0-rc2", 2, "", "InfiniteUndiscoveryRecomp.exe");
        let update = service.update(ID, None, None, false, |_| {}).await.unwrap();
        assert!(update.staged);
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        let second = service.activate_staged(ID).unwrap();
        assert_eq!(
            fs::read(second.path.join(relative)).unwrap(),
            b"inert owned data, not retail content"
        );
        assert_eq!(
            fs::metadata(second.path.join(relative))
                .unwrap()
                .modified()
                .unwrap(),
            stamp
        );
        assert_eq!(
            fs::read(second.path.join("USA/cache/runtime.toml")).unwrap(),
            b"user runtime settings"
        );
        assert!(!second.path.join("USA/shaders/old-cache").exists());
        fs::write(second.path.join("USA/saves/progress"), b"newest progress").unwrap();
        let previous = service.rollback(ID).unwrap();
        assert_eq!(previous.id, first.id);
        assert_eq!(
            fs::read(previous.path.join("USA/saves/progress")).unwrap(),
            b"newest progress"
        );
        assert_eq!(
            fs::metadata(previous.path.join(relative))
                .unwrap()
                .modified()
                .unwrap(),
            stamp
        );
        fs::create_dir_all(previous.path.join("USA/.iu-install-partial")).unwrap();
        fs::write(
            previous.path.join("USA/.iu-install-partial/recover"),
            b"interrupted import",
        )
        .unwrap();
        let error = service
            .update(ID, None, None, true, |_| {})
            .await
            .unwrap_err();
        assert_eq!(
            error.presentation().presentation_key,
            "portable_runtime_modified"
        );
        assert!(error.details["failures"].contains("USA/.iu-install-partial/recover"));
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, previous.id);
        assert_eq!(
            fs::read(previous.path.join("USA/.iu-install-partial/recover")).unwrap(),
            b"interrupted import"
        );
        // No package executable, original media wizard or game is run.
        assert!(!previous.path.join(LAUNCH_MARKER).exists());
        let fresh_library = Library::open(temporary.path().join("fresh-library")).unwrap();
        let fresh = PortcoveService::with_provider(fresh_library, provider).unwrap();
        let newest = fresh
            .install(ID, Some(ReleaseChannel::Beta), None, None, true, |_| {})
            .await
            .unwrap();
        assert_eq!(newest.version, "v1.0.0-rc2");
        assert!(!newest.path.join(relative).exists());
        assert!(!newest.path.join(LAUNCH_MARKER).exists());
    }

    fn raw_copy_fixture_catalog(owned: &[u8]) -> Catalog {
        // Preserve the authored route while admitting only first-party inert
        // bytes in this private schema-1 source authority, never a retail ROM.
        const ID: &str = "crash-team-racing-ctr-native";
        const PROFILE: &str = "ctr-native-ntsc-u-raw-bin";
        let embedded = Catalog::embedded().unwrap();
        assert_eq!(
            embedded.source_profile(PROFILE).unwrap().accepted_sha1,
            ["1bb785082def3fe25f6b46be06d4eaf33c5bc772"]
        );
        let port = embedded.port(ID).unwrap().clone();
        Catalog::from_json(&serde_json::json!({
            "schema_version":1,
            "source_profiles":[{"id":PROFILE,"label":"Your USA retail raw Crash Team Racing BIN","kind":"file","accepted_extensions":["bin"],"accepted_sha256":[hex::encode(Sha256::digest(owned))]}],
            "ports":[port]
        }).to_string()).unwrap()
    }

    #[tokio::test]
    async fn exact_raw_source_route_carries_memcards_and_holds_build_local_states() {
        const ID: &str = "crash-team-racing-ctr-native";
        const PROFILE: &str = "ctr-native-ntsc-u-raw-bin";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("owned.bin");
        let owned = b"first-party inert raw source fixture, never retail bytes";
        fs::write(&source, owned).unwrap();
        let catalog = raw_copy_fixture_catalog(owned);
        let port = catalog.port(ID).unwrap().clone();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release_in_folder(
            "beta-7.1",
            1,
            "ctr-native-beta-7_1-windows-x86/",
            "ctr_native.exe",
        ))));
        let mut service =
            PortcoveService::with_provider(library.clone(), provider.clone()).unwrap();
        service.replace_catalog_for_test(catalog);
        service.register_source(PROFILE, &source).unwrap();
        let first = service
            .install(ID, Some(ReleaseChannel::Beta), None, None, true, |_| {})
            .await
            .unwrap();
        let root = first.path.join("ctr-native-beta-7_1-windows-x86");
        // Explicit launch preparation copies the admitted raw source; it does
        // not run the package or establish that Play completed.
        let prepared = service
            .prepare_launch_for_install(&port, &first, None, None)
            .unwrap();
        assert_eq!(prepared.working_directory, root);
        assert_eq!(fs::read(root.join("assets/ctr-u.bin")).unwrap(), owned);
        fs::create_dir_all(root.join("memcards/slot0")).unwrap();
        fs::write(root.join("memcards/slot0/normal-save"), b"current progress").unwrap();
        fs::write(root.join("SCREENSHOT.BMP"), b"owned capture").unwrap();
        fs::write(root.join("Crash Team Racing.log"), b"old log").unwrap();
        fs::create_dir_all(root.join("debug/states")).unwrap();
        let state = root.join("debug/states/quick.ctrstates");
        fs::write(&state, b"same-build memory snapshot").unwrap();
        let error = service
            .prepare_launch_for_install(&port, &first, None, None)
            .unwrap_err();
        assert!(error.details["failures"].contains("debug/states/quick.ctrstates"));
        let error = service
            .update(ID, None, None, false, |_| {})
            .await
            .unwrap_err();
        assert_eq!(
            error.presentation().presentation_key,
            "portable_runtime_modified"
        );
        assert!(error.details["failures"].contains("debug/states/quick.ctrstates"));
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        let preserved = temporary.path().join("preserved-same-build-state");
        fs::copy(&state, &preserved).unwrap();
        assert_eq!(fs::read(&preserved).unwrap(), fs::read(&state).unwrap());
        fs::remove_file(&state).unwrap();
        service
            .prepare_launch_for_install(&port, &first, None, None)
            .unwrap();
        *provider.0.lock().unwrap() = server.release_in_folder(
            "beta-7.2",
            2,
            "ctr-native-beta-7_2-windows-x86/",
            "ctr_native.exe",
        );
        let update = service.update(ID, None, None, false, |_| {}).await.unwrap();
        assert!(update.staged);
        let next = service.activate_staged(ID).unwrap();
        let next_root = next.path.join("ctr-native-beta-7_2-windows-x86");
        assert_eq!(
            fs::read(next_root.join("memcards/slot0/normal-save")).unwrap(),
            b"current progress"
        );
        assert_eq!(fs::read(next_root.join("assets/ctr-u.bin")).unwrap(), owned);
        assert_eq!(
            fs::read(next_root.join("SCREENSHOT.BMP")).unwrap(),
            b"owned capture"
        );
        assert!(!next_root.join("Crash Team Racing.log").exists());
        assert!(!next_root.join("debug/states/quick.ctrstates").exists());
        fs::write(
            next_root.join("memcards/slot0/normal-save"),
            b"newest progress",
        )
        .unwrap();
        let old = service.rollback(ID).unwrap();
        assert_eq!(old.id, first.id);
        assert_eq!(
            fs::read(root.join("memcards/slot0/normal-save")).unwrap(),
            b"newest progress"
        );
        assert_eq!(fs::read(preserved).unwrap(), b"same-build memory snapshot");
        assert!(!first.path.join(LAUNCH_MARKER).exists());
        let fresh_library = Library::open(temporary.path().join("fresh-library")).unwrap();
        let mut fresh = PortcoveService::with_provider(fresh_library, provider).unwrap();
        fresh.replace_catalog_for_test(service.catalog.clone());
        fresh.register_source(PROFILE, &source).unwrap();
        let newest = fresh
            .install(ID, Some(ReleaseChannel::Beta), None, None, true, |_| {})
            .await
            .unwrap();
        assert_eq!(newest.version, "beta-7.2");
        fresh
            .prepare_launch_for_install(&port, &newest, None, None)
            .unwrap();
        assert_eq!(
            fs::read(
                newest
                    .path
                    .join("ctr-native-beta-7_2-windows-x86/assets/ctr-u.bin")
            )
            .unwrap(),
            owned
        );
        assert!(!newest.path.join(LAUNCH_MARKER).exists());
    }

    #[tokio::test]
    async fn versioned_ready_mods_keep_current_data_and_both_package_versions_through_restore() {
        const ID: &str = "versioned-mod-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release_with_files(
            "1",
            1,
            "",
            "game.exe",
            &[
                ("mods/packages/bundled/1.0/manifest.toml", b"old default"),
                ("mods/state.toml", b"old initial state"),
            ],
        ))));
        let mut service =
            PortcoveService::with_provider(library.clone(), provider.clone()).unwrap();
        let catalog = crate::test_fixture::versioned_mod_catalog();
        service.replace_catalog_for_test(catalog.clone());
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let write = |root: &Path, path: &str, bytes: &[u8]| {
            fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            fs::write(root.join(path), bytes).unwrap();
        };
        write(&first.path, "settings.ini", b"before Play");
        write(&first.path, "saves/current.sav", b"current progress");
        write(&first.path, "mods/state.toml", b"selected old version");
        write(
            &first.path,
            "mods/packages/imported/2.0/code.dll",
            b"untrusted player mod",
        );
        write(&first.path, "cache/code.dll", b"old generated code");
        let backup = service.create_backup(ID).unwrap();
        assert!(!first.path.join(LAUNCH_MARKER).exists());
        assert!(!backup.path.join("data/cache").exists());
        assert_eq!(
            fs::read(backup.path.join("data/mods/packages/imported/2.0/code.dll")).unwrap(),
            b"untrusted player mod"
        );
        *provider.0.lock().unwrap() = server.release_with_files(
            "2",
            2,
            "",
            "game.exe",
            &[
                (
                    "mods/packages/bundled/2.0/manifest.toml",
                    b"successor default",
                ),
                ("mods/state.toml", b"successor initial state"),
                ("cache/code.dll", b"new generated code"),
            ],
        );
        let staged = service.update(ID, None, None, false, |_| {}).await.unwrap();
        assert!(staged.staged);
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        let second = service.activate_staged(ID).unwrap();
        assert_eq!(
            fs::read(second.path.join("mods/state.toml")).unwrap(),
            b"selected old version"
        );
        for path in [
            "mods/packages/bundled/1.0/manifest.toml",
            "mods/packages/bundled/2.0/manifest.toml",
            "mods/packages/imported/2.0/code.dll",
        ] {
            assert!(second.path.join(path).is_file(), "{path}");
        }
        assert_eq!(
            fs::read(second.path.join("cache/code.dll")).unwrap(),
            b"new generated code"
        );
        fs::remove_file(second.path.join("mods/state.toml")).unwrap();
        write(&second.path, "saves/current.sav", b"latest progress");
        let restored = service.rollback(ID).unwrap();
        assert_eq!(restored.id, first.id);
        assert!(!first.path.join("mods/state.toml").exists());
        assert_eq!(
            fs::read(first.path.join("saves/current.sav")).unwrap(),
            b"latest progress"
        );
        assert!(
            first
                .path
                .join("mods/packages/bundled/2.0/manifest.toml")
                .is_file()
        );
        assert_eq!(
            fs::read(first.path.join("cache/code.dll")).unwrap(),
            b"old generated code"
        );
        // A conflict in ANY retained runtime refuses the explicit backup restore
        // before publishing its older canonical snapshot or changing current saves.
        write(
            &second.path,
            "mods/packages/bundled/1.0/manifest.toml",
            b"conflicting retained package",
        );
        let restore = || {
            let preview = service
                .preview_backup_action(ID, &backup.id, crate::BackupAction::Restore)
                .unwrap();
            let consent = service
                .authorize_backup_action(
                    ID,
                    &backup.id,
                    crate::BackupAction::Restore,
                    &preview.preview_sha256,
                )
                .unwrap();
            service.restore_backup(ID, &backup.id, &consent.token)
        };
        let error = restore().unwrap_err();
        assert!(error.message.contains("Mod packages need review"));
        assert!(error.details["destination_path"].contains("mods"));
        assert_eq!(
            fs::read(first.path.join("saves/current.sav")).unwrap(),
            b"latest progress"
        );
        assert_eq!(
            fs::read(library.user_dir(ID).join("saves/current.sav")).unwrap(),
            b"latest progress"
        );
        write(
            &second.path,
            "mods/packages/bundled/1.0/manifest.toml",
            b"old default",
        );
        restore().unwrap();
        assert_eq!(
            fs::read(first.path.join("saves/current.sav")).unwrap(),
            b"current progress"
        );
        assert_eq!(
            fs::read(second.path.join("saves/current.sav")).unwrap(),
            b"current progress"
        );
        assert!(
            second
                .path
                .join("mods/packages/bundled/2.0/manifest.toml")
                .is_file()
        );
        assert!(!first.path.join(LAUNCH_MARKER).exists());
    }

    #[tokio::test]
    async fn versioned_ready_mods_refuse_conflicts_and_implicit_contract_transitions() {
        const ID: &str = "versioned-mod-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release_with_files(
            "1",
            1,
            "",
            "game.exe",
            &[("mods/packages/bundled/1.0/manifest.toml", b"original")],
        ))));
        let mut service =
            PortcoveService::with_provider(library.clone(), provider.clone()).unwrap();
        let catalog = crate::test_fixture::versioned_mod_catalog();
        service.replace_catalog_for_test(catalog.clone());
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        fs::write(first.path.join("settings.ini"), b"keep choices").unwrap();
        *provider.0.lock().unwrap() = server.release_with_files(
            "2",
            2,
            "",
            "game.exe",
            &[(
                "mods/packages/bundled/1.0/manifest.toml",
                b"changed same version",
            )],
        );
        service.update(ID, None, None, false, |_| {}).await.unwrap();
        let error = service.activate_staged(ID).unwrap_err();
        assert!(error.message.contains("Mod packages need review"));
        assert!(error.details["source_path"].contains("mods"));
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        assert_eq!(
            fs::read(first.path.join("mods/packages/bundled/1.0/manifest.toml")).unwrap(),
            b"original"
        );
        assert_eq!(
            fs::read(first.path.join("settings.ini")).unwrap(),
            b"keep choices"
        );
        let staged = service.status(ID).unwrap().staged.unwrap();
        assert!(
            service
                .prepare_recovered_psx_activation(&staged)
                .unwrap_err()
                .message
                .contains("Mod packages need review")
        );
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        // Historical copies without a receipt use content-only package equality,
        // but must still refuse conflicting root state before adding any package.
        service.create_backup(ID).unwrap();
        fs::remove_file(first.path.join(PSX_DATA_RECEIPT)).unwrap();
        let packaged = first.path.join("mods/packages/bundled/1.0/manifest.toml");
        fs::OpenOptions::new()
            .write(true)
            .open(&packaged)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_001)),
            )
            .unwrap();
        service.collect_active_user_data_if_launched(ID).unwrap();
        fs::write(first.path.join("mods/state.toml"), b"unproven selection").unwrap();
        fs::write(
            library.user_dir(ID).join("mods/state.toml"),
            b"canonical selection",
        )
        .unwrap();
        assert!(service.collect_active_user_data_if_launched(ID).is_err());
        assert_eq!(
            fs::read(library.user_dir(ID).join("mods/state.toml")).unwrap(),
            b"canonical selection"
        );
        let mut changed = catalog.authoritative_document();
        changed.ports[0].mod_package_policy = None;
        let changed = Catalog::from_json(&serde_json::to_string(&changed).unwrap()).unwrap();
        let to = changed.port(ID).unwrap();
        assert!(service.require_portable_transition(&first, to).is_err());
        assert!(
            service
                .require_portable_transition_to(&first, to, true)
                .is_err()
        );
        // Current catalog changes do not reinterpret a retained runtime.
        service.replace_catalog_for_test(changed);
        assert!(
            service
                .installed_port(&first)
                .unwrap()
                .mod_package_policy
                .is_some()
        );
    }

    #[tokio::test]
    async fn ready_staged_archive_preserves_preplay_data_and_successor_cache_defaults() {
        const ID: &str = "alariq-mc2";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release_in_folder(
            "v0.1.3",
            1,
            "mc2-win64-v0.1.3/",
            "mc2.exe",
        ))));
        let service = PortcoveService::with_provider(library.clone(), provider.clone()).unwrap();
        let port = service.catalog.port(ID).unwrap();
        assert!(crate::persistence::ready_staged_archive(port));
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let root = first.path.join("mc2-win64-v0.1.3");
        assert!(psx_mod_data::initialized(&first).unwrap());
        fs::write(root.join("options.cfg"), b"before first Play").unwrap();
        fs::create_dir_all(root.join("data/multiplayer")).unwrap();
        fs::write(root.join("data/multiplayer/custom.var"), b"custom variant").unwrap();
        fs::write(
            root.join("data/textures/100.txm"),
            b"old generated texture cache",
        )
        .unwrap();
        fs::write(
            root.join("tmp.fit"),
            b"interrupted disposable variant decode",
        )
        .unwrap();
        assert!(!first.path.join(LAUNCH_MARKER).exists());
        let backup = service.create_backup(ID).unwrap();
        assert_eq!(
            fs::read(backup.path.join("data/options.cfg")).unwrap(),
            b"before first Play"
        );
        assert!(!backup.path.join("data/data/textures").exists());
        fs::write(root.join("options.cfg"), b"updated after backup").unwrap();
        *provider.0.lock().unwrap() =
            server.release_in_folder("v0.1.4", 2, "mc2-win64-v0.1.4/", "mc2.exe");
        let staged = service.update(ID, None, None, false, |_| {}).await.unwrap();
        assert!(staged.staged);
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        let second = service.activate_staged(ID).unwrap();
        let second_root = second.path.join("mc2-win64-v0.1.4");
        assert_eq!(
            fs::read(second_root.join("options.cfg")).unwrap(),
            b"updated after backup"
        );
        assert_eq!(
            fs::read(second_root.join("data/multiplayer/custom.var")).unwrap(),
            b"custom variant"
        );
        assert_eq!(
            fs::read(second_root.join("data/textures/100.txm")).unwrap(),
            [2]
        );
        assert!(!second_root.join("tmp.fit").exists());
        fs::write(
            second_root.join("options.cfg"),
            b"deliberate successor choice",
        )
        .unwrap();
        let spec = service
            .prepare_launch_for_install(port, &second, None, None)
            .unwrap();
        assert_eq!(spec.working_directory, second_root);
        assert_eq!(
            fs::read(library.user_dir(ID).join("options.cfg")).unwrap(),
            b"deliberate successor choice"
        );
        // Preparation returns a specification; no fixture executable is run.
        assert!(!second.path.join(LAUNCH_MARKER).exists());
        let restored = service.rollback(ID).unwrap();
        assert_eq!(restored.id, first.id);
        assert_eq!(
            fs::read(root.join("options.cfg")).unwrap(),
            b"deliberate successor choice"
        );
        assert_eq!(
            fs::read(root.join("data/textures/100.txm")).unwrap(),
            b"old generated texture cache"
        );
        fs::write(root.join("unknown-player-file"), b"preserve separately").unwrap();
        assert!(
            service
                .preview_removal(ID)
                .unwrap_err()
                .message
                .contains("unrecognized files")
        );
        assert!(service.update(ID, None, None, true, |_| {}).await.is_err());
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        assert_eq!(
            fs::read(root.join("unknown-player-file")).unwrap(),
            b"preserve separately"
        );
    }

    #[tokio::test]
    async fn ready_staged_archive_without_restore_proof_preserves_canonical_and_conflicting_data() {
        const ID: &str = "alariq-mc2";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release_in_folder(
            "v0.1.3",
            1,
            "mc2-win64-v0.1.3/",
            "mc2.exe",
        ))));
        let service = PortcoveService::with_provider(library.clone(), provider).unwrap();
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let root = first.path.join("mc2-win64-v0.1.3");
        fs::remove_file(first.path.join(PSX_DATA_RECEIPT)).unwrap();
        let user = library.user_dir(ID);
        fs::create_dir_all(&user).unwrap();
        fs::write(user.join("options.cfg"), b"canonical choices").unwrap();
        fs::write(user.join("orgprefs.cfg"), b"canonical only").unwrap();
        fs::write(root.join("options.cfg"), b"unproven runtime choices").unwrap();
        assert!(
            service
                .collect_active_user_data_if_launched(ID)
                .unwrap_err()
                .message
                .contains("unlaunched runtime data differs")
        );
        assert_eq!(
            fs::read(user.join("options.cfg")).unwrap(),
            b"canonical choices"
        );
        assert_eq!(
            fs::read(root.join("options.cfg")).unwrap(),
            b"unproven runtime choices"
        );
        // Preserve the conflicting copy separately, then permit additive collection.
        fs::rename(
            root.join("options.cfg"),
            temporary.path().join("preserved-options.cfg"),
        )
        .unwrap();
        service.collect_active_user_data_if_launched(ID).unwrap();
        assert_eq!(
            fs::read(user.join("orgprefs.cfg")).unwrap(),
            b"canonical only"
        );
        assert!(!psx_mod_data::initialized(&first).unwrap());
    }

    #[tokio::test]
    async fn ready_staged_archive_raw_activation_refuses_before_acquisition() {
        for id in ["alariq-mc2", "crash-team-racing-ctr-native"] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let catalog = Catalog::embedded().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let error = Installer::new(library.clone())
                .unwrap()
                .install(
                    InstallRequest {
                        port_id: id.into(),
                        release: ResolvedRelease {
                            version: "v0.1.3".into(),
                            channel: ReleaseChannel::Stable,
                            published_at: None,
                            asset: crate::ReleaseAsset {
                                name: "mc2-win64-v0.1.3.zip".into(),
                                url: format!(
                                    "http://{}/fixture.zip",
                                    listener.local_addr().unwrap()
                                ),
                                size: 42,
                                sha256: "ab".repeat(32),
                            },
                        },
                        output_root: library.versions_dir().join(id),
                        activate: true,
                        managed: None,
                        qualification: InstallQualification::from_catalog(
                            &catalog,
                            id,
                            Platform::WindowsX86_64,
                        )
                        .unwrap(),
                    },
                    &OperationCoordinator::new("ready-archive-raw", None),
                    |_| {},
                )
                .await
                .unwrap_err();
            assert!(error.message.contains("preflight before activation"));
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
            assert!(OperationStore::new(library).all().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn ready_staged_archive_recovery_refuses_changed_data_coordinates_before_collection() {
        for (id, program, relative) in [
            ("alariq-mc2", "mc2.exe", "options.cfg"),
            (
                "crash-team-racing-ctr-native",
                "ctr_native.exe",
                "memcards/slot0/progress",
            ),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release_in_folder(
                "v0.1.3",
                1,
                "mc2-win64-v0.1.3/",
                program,
            ))));
            let mut service = PortcoveService::with_provider(library.clone(), provider).unwrap();
            if id == "crash-team-racing-ctr-native" {
                let owned = b"inert recovery source";
                service.replace_catalog_for_test(raw_copy_fixture_catalog(owned));
                let source = temporary.path().join("owned.bin");
                fs::write(&source, owned).unwrap();
                service
                    .register_source("ctr-native-ntsc-u-raw-bin", &source)
                    .unwrap();
            }
            let first = service
                .install(
                    id,
                    if id == "crash-team-racing-ctr-native" {
                        Some(ReleaseChannel::Beta)
                    } else {
                        None
                    },
                    None,
                    None,
                    true,
                    |_| {},
                )
                .await
                .unwrap();
            let user = library.user_dir(id);
            fs::create_dir_all(user.join(relative).parent().unwrap()).unwrap();
            fs::write(user.join(relative), b"reviewed canonical").unwrap();
            let local = first.path.join("mc2-win64-v0.1.3").join(relative);
            fs::create_dir_all(local.parent().unwrap()).unwrap();
            fs::write(&local, b"uncollected current settings").unwrap();
            let mut document = service.catalog.authoritative_document().clone();
            document
                .ports
                .iter_mut()
                .find(|p| p.id == id)
                .unwrap()
                .persistent_paths = if id == "crash-team-racing-ctr-native" {
                vec!["assets/ctr-u.bin".into(), "different.cfg".into()]
            } else {
                vec!["different.cfg".into()]
            };
            let changed = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
            let new = Installer::new(library.clone())
                .unwrap()
                .install(
                    InstallRequest {
                        port_id: id.into(),
                        release: server.release_in_folder(
                            "v0.1.4",
                            2,
                            "mc2-win64-v0.1.4/",
                            program,
                        ),
                        output_root: library.versions_dir().join(id),
                        activate: false,
                        managed: None,
                        qualification: InstallQualification::from_catalog(
                            &changed,
                            id,
                            Platform::WindowsX86_64,
                        )
                        .unwrap(),
                    },
                    &OperationCoordinator::new("changed-coordinate-stage", None),
                    |_| {},
                )
                .await
                .unwrap();
            let operation_id = Uuid::new_v4().to_string();
            let mut journal = crate::operation::LifecycleOperation::new(
                &operation_id,
                crate::operation::LifecycleOperationKind::Install,
                id,
            );
            journal.install = Some(new.clone());
            journal.activate = true;
            journal.phase = crate::operation::LifecyclePhase::PayloadPublished;
            journal.paths.staging = Some(library.staging_dir().join(&operation_id));
            journal.paths.final_path = Some(new.path.clone());
            fs::create_dir_all(journal.paths.staging.as_ref().unwrap()).unwrap();
            let store = OperationStore::new(library.clone());
            store.put(&mut journal).unwrap();
            let error = crate::recovery::recover_published_install(&service, &store, &mut journal)
                .unwrap_err();
            assert!(
                error
                    .message
                    .contains("changes how this installation stores"),
                "{error}"
            );
            assert_eq!(
                fs::read(user.join(relative)).unwrap(),
                b"reviewed canonical"
            );
            assert_eq!(fs::read(local).unwrap(), b"uncollected current settings");
            assert_eq!(service.status(id).unwrap().active.unwrap().id, first.id);
            assert!(first.path.is_dir() && new.path.is_dir());
            assert!(store.get(&journal.id).unwrap().is_some());
            assert!(!new.path.join(PSX_DATA_RECEIPT).exists());
        }
    }

    fn register_external_copy(service: &PortcoveService, root: &Path) -> ExternalRuntimeRecord {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("game.exe"), b"untouched external executable").unwrap();
        fs::write(root.join("save.dat"), b"external player progress").unwrap();
        let record = ExternalRuntimeRecord {
            user_selected: Some(crate::UserSelectedLaunch {
                arguments: Vec::new(),
            }),
            id: Uuid::new_v4().to_string(),
            port_id: "portable-fixture".into(),
            path: root.to_owned(),
            executable: root.join("game.exe"),
            version: "user-managed".into(),
            platform: Platform::current().unwrap(),
            archive_sha256: String::new(),
            immutable_tree_sha256: String::new(),
            registered_at: Library::now(),
            retained_definition: None,
            shared_preferences: None,
        };
        let retained = Catalog::for_user_selected_listing(
            service.catalog.listing("portable-fixture").unwrap().clone(),
        )
        .unwrap();
        service
            .library
            .register_external_runtime(&record, &retained)
            .unwrap();
        record
    }

    async fn route_authorization(service: &PortcoveService) -> crate::DestructiveAuthorization {
        let review = service
            .preview_managed_route_change("portable-fixture", None, None)
            .await
            .unwrap();
        assert!(review.permitted, "{:?}", review.reason);
        assert!(review.external_files_will_be_preserved);
        assert!(!review.external_data_will_be_copied);
        service
            .authorize_managed_route_change("portable-fixture", None, None, &review.preview_sha256)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn route_change_publishes_separate_runtime_preserving_external_files_and_policy() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let service = build_service(library.clone(), provider);
        let old = register_external_copy(&service, &temporary.path().join("external"));
        let output = temporary.path().join("separate-managed-output");
        service
            .set_output_directory("portable-fixture", &output)
            .unwrap();
        library
            .set_update_policy(
                "portable-fixture",
                UpdatePolicy::Stage,
                ReleaseChannel::Stable,
            )
            .unwrap();
        let authorization = route_authorization(&service).await;
        // A normal install remains forbidden even though its proposal can be read.
        assert!(service.plan_game_install("portable-fixture").await.is_err());
        assert!(
            service
                .install("portable-fixture", None, None, None, true, |_| {})
                .await
                .is_err()
        );
        let result = service
            .change_to_managed_runtime("portable-fixture", None, None, &authorization.token, |_| {})
            .await
            .unwrap();
        assert_eq!(result.previous_registration.id, old.id);
        assert!(result.external_files_preserved);
        assert_ne!(result.installation.path, old.path);
        assert!(
            result
                .installation
                .path
                .starts_with(fs::canonicalize(&output).unwrap())
        );
        assert!(!result.installation.path.join("save.dat").exists());
        assert_eq!(
            fs::read(old.path.join("save.dat")).unwrap(),
            b"external player progress"
        );
        let status = library
            .status("portable-fixture", ReleaseChannel::Stable)
            .unwrap();
        assert!(status.external_runtime.is_none());
        assert_eq!(status.active.unwrap().id, result.installation.id);
        assert_eq!(status.update_policy, UpdatePolicy::Stage);
        assert!(
            service
                .change_to_managed_runtime(
                    "portable-fixture",
                    None,
                    None,
                    &authorization.token,
                    |_| {}
                )
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn route_change_crash_recovery_preserves_precommit_registration_and_reports_committed_state()
     {
        for point in [
            LifecycleFaultPoint::InstallPublished,
            LifecycleFaultPoint::InstallMetadataCommitted,
        ] {
            struct Interrupt(LifecycleFaultPoint);
            impl LifecycleFaultInjector for Interrupt {
                fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                    if point == self.0 {
                        Err(PortcoveError::state("synthetic route interruption"))
                    } else {
                        Ok(())
                    }
                }
            }
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let mut service = build_service(library.clone(), provider.clone());
            let old = register_external_copy(&service, &temporary.path().join("external"));
            service
                .set_output_directory("portable-fixture", &temporary.path().join("managed-output"))
                .unwrap();
            let authorization = route_authorization(&service).await;
            service.faults = Arc::new(Interrupt(point));
            let error = service
                .change_to_managed_runtime(
                    "portable-fixture",
                    None,
                    None,
                    &authorization.token,
                    |_| {},
                )
                .await
                .unwrap_err();
            let status = library
                .status("portable-fixture", ReleaseChannel::Stable)
                .unwrap();
            if point == LifecycleFaultPoint::InstallPublished {
                assert_eq!(status.external_runtime.unwrap().id, old.id);
                assert!(status.active.is_none());
            } else {
                assert!(status.external_runtime.is_none());
                assert_eq!(status.active.unwrap().version, "v1");
                assert_eq!(
                    error.presentation().mutation_state,
                    crate::MutationState::Committed
                );
                assert_eq!(
                    error.presentation().presentation_key,
                    "managed_route_committed"
                );
            }
            let recovered = build_service(library.clone(), provider);
            recovered.recover_pending_operations().unwrap();
            recovered.recover_pending_operations().unwrap();
            let status = library
                .status("portable-fixture", ReleaseChannel::Stable)
                .unwrap();
            assert!(
                status.external_runtime.is_none(),
                "remaining journals: {:?}",
                OperationStore::new(library.clone()).all().unwrap()
            );
            assert_eq!(status.active.unwrap().version, "v1");
            assert!(OperationStore::new(library).all().unwrap().is_empty());
            assert_eq!(
                fs::read(old.path.join("save.dat")).unwrap(),
                b"external player progress"
            );
        }
    }

    #[tokio::test]
    async fn route_change_refuses_changed_registration_new_core_data_and_unowned_output() {
        for change in ["registration", "data", "unowned-output"] {
            struct ChangeBeforeCommit {
                library: Library,
                change: &'static str,
            }
            impl LifecycleFaultInjector for ChangeBeforeCommit {
                fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                    if point == LifecycleFaultPoint::InstallPublished {
                        if self.change == "data" {
                            let directory = self.library.user_dir("portable-fixture");
                            fs::create_dir_all(&directory)?;
                            fs::write(directory.join("retained-save"), b"keep old Core data")?;
                        } else if self.change == "unowned-output" {
                            let root = self
                                .library
                                .output_roots()?
                                .into_iter()
                                .find(|root| root.port_id == "portable-fixture")
                                .unwrap();
                            fs::write(
                                root.path.join("unrelated-player-file"),
                                b"keep unrelated output",
                            )?;
                        } else {
                            self.library.connection()?.execute("UPDATE external_runtime_registrations SET record_json=json_set(record_json,'$.registered_at',registered_at+1) WHERE port_id='portable-fixture'", [])?;
                        }
                    }
                    Ok(())
                }
            }
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let mut service = build_service(library.clone(), provider.clone());
            let old = register_external_copy(&service, &temporary.path().join("external"));
            let output = temporary.path().join("managed-output");
            service
                .set_output_directory("portable-fixture", &output)
                .unwrap();
            let authorization = route_authorization(&service).await;
            service.faults = Arc::new(ChangeBeforeCommit {
                library: library.clone(),
                change,
            });
            assert!(
                service
                    .change_to_managed_runtime(
                        "portable-fixture",
                        None,
                        None,
                        &authorization.token,
                        |_| {}
                    )
                    .await
                    .is_err()
            );
            let status = library
                .status("portable-fixture", ReleaseChannel::Stable)
                .unwrap();
            assert!(status.active.is_none());
            assert_eq!(status.external_runtime.unwrap().id, old.id);
            let recovered = build_service(library.clone(), provider);
            // Recovery returns a report with the held journal; it must not retire
            // the changed registration or reinterpret newly appeared Core data.
            recovered.recover_pending_operations().unwrap();
            assert!(
                library
                    .status("portable-fixture", ReleaseChannel::Stable)
                    .unwrap()
                    .active
                    .is_none()
            );
            assert!(
                !OperationStore::new(library.clone())
                    .all()
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                fs::read(old.path.join("save.dat")).unwrap(),
                b"external player progress"
            );
            if change == "data" {
                assert_eq!(
                    fs::read(library.user_dir("portable-fixture").join("retained-save")).unwrap(),
                    b"keep old Core data"
                );
            } else if change == "unowned-output" {
                assert_eq!(
                    fs::read(output.join("unrelated-player-file")).unwrap(),
                    b"keep unrelated output"
                );
            }
        }
    }

    #[tokio::test]
    async fn route_change_sql_failure_rolls_back_registration_retirement_and_recovers() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let service = build_service(library.clone(), provider.clone());
        let old = register_external_copy(&service, &temporary.path().join("external"));
        let authorization = route_authorization(&service).await;
        library.connection().unwrap().execute_batch("CREATE TRIGGER refuse_test_install BEFORE INSERT ON installs BEGIN SELECT RAISE(ABORT, 'synthetic metadata failure'); END;").unwrap();
        let error = service
            .change_to_managed_runtime("portable-fixture", None, None, &authorization.token, |_| {})
            .await
            .unwrap_err();
        assert!(error.message.contains("synthetic metadata failure"));
        let status = library
            .status("portable-fixture", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(status.external_runtime.unwrap().id, old.id);
        assert!(status.active.is_none());
        library
            .connection()
            .unwrap()
            .execute_batch("DROP TRIGGER refuse_test_install;")
            .unwrap();
        let recovered = build_service(library.clone(), provider);
        recovered.recover_pending_operations().unwrap();
        assert!(
            library
                .status("portable-fixture", ReleaseChannel::Stable)
                .unwrap()
                .active
                .is_some()
        );
        assert_eq!(
            fs::read(old.path.join("save.dat")).unwrap(),
            b"external player progress"
        );
    }

    #[tokio::test]
    async fn route_change_review_rejects_overlap_retained_data_and_changed_release_consent() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let service = build_service(library.clone(), provider.clone());
        let old = register_external_copy(&service, &temporary.path().join("external"));
        assert!(
            service
                .preview_managed_route_change(
                    "portable-fixture",
                    None,
                    Some(&old.path.join("another-copy"))
                )
                .await
                .is_err()
        );
        let data = library.user_dir("portable-fixture");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("old-save"), b"retained data").unwrap();
        let review = service
            .preview_managed_route_change("portable-fixture", None, None)
            .await
            .unwrap();
        assert!(!review.permitted);
        assert!(review.reason.unwrap().contains("saved data"));
        assert!(
            service
                .authorize_managed_route_change(
                    "portable-fixture",
                    None,
                    None,
                    &review.preview_sha256
                )
                .await
                .is_err()
        );
        // The player deliberately preserves the file outside the Core store.
        fs::rename(
            data.join("old-save"),
            temporary.path().join("preserved-old-save"),
        )
        .unwrap();
        let authorization = route_authorization(&service).await;
        *provider.0.lock().unwrap() = server.release("v2", 2);
        assert!(
            service
                .change_to_managed_runtime(
                    "portable-fixture",
                    None,
                    None,
                    &authorization.token,
                    |_| {}
                )
                .await
                .is_err()
        );
        assert!(
            OperationStore::new(library.clone())
                .all()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            library
                .status("portable-fixture", ReleaseChannel::Stable)
                .unwrap()
                .external_runtime
                .unwrap()
                .id,
            old.id
        );
        assert_eq!(
            fs::read(temporary.path().join("preserved-old-save")).unwrap(),
            b"retained data"
        );
    }

    #[tokio::test]
    async fn route_change_cancellation_preserves_registration_without_publication() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let service = build_service(library.clone(), provider);
        let old = register_external_copy(&service, &temporary.path().join("external"));
        let authorization = route_authorization(&service).await;
        let error = service
            .change_to_managed_runtime(
                "portable-fixture",
                None,
                None,
                &authorization.token,
                |event| {
                    if matches!(event.event, crate::OperationEventKind::Started) {
                        service.request_cancellation(&event.operation_id).unwrap();
                    }
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        let status = library
            .status("portable-fixture", ReleaseChannel::Stable)
            .unwrap();
        assert!(status.active.is_none());
        assert_eq!(status.external_runtime.unwrap().id, old.id);
        assert!(OperationStore::new(library).all().unwrap().is_empty());
        assert_eq!(
            fs::read(old.path.join("save.dat")).unwrap(),
            b"external player progress"
        );
    }

    #[tokio::test]
    async fn route_change_keeps_successful_commit_when_finishing_fails_after_active_state_changes()
    {
        struct FinishFailure(Library);
        impl LifecycleFaultInjector for FinishFailure {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == LifecycleFaultPoint::InstallMetadataCommitted {
                    // A disposable database fault changes the later readback and
                    // makes activity finalization fail after successful publication.
                    // It never removes either runtime's files.
                    self.0.connection()?.execute_batch(
                        "UPDATE port_settings SET active_install_id=NULL WHERE port_id='portable-fixture';
                         UPDATE activity_history SET cancellation_phase='preparing' WHERE operation='install' AND status='running';
                         CREATE TRIGGER refuse_test_route_finish BEFORE UPDATE OF cancellation_phase ON activity_history
                         WHEN NEW.cancellation_phase='finishing'
                         BEGIN SELECT RAISE(FAIL, 'synthetic post-publication finish failure'); END;"
                    )?;
                }
                Ok(())
            }
        }
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider);
        let old = register_external_copy(&service, &temporary.path().join("external"));
        let authorization = route_authorization(&service).await;
        service.faults = Arc::new(FinishFailure(library.clone()));
        let error = service
            .change_to_managed_runtime("portable-fixture", None, None, &authorization.token, |_| {})
            .await
            .unwrap_err();
        assert!(
            error
                .message
                .contains("synthetic post-publication finish failure"),
            "{error:?}"
        );
        assert_eq!(
            error.presentation().mutation_state,
            crate::MutationState::Committed
        );
        assert_eq!(
            error.details.get("committed_version").map(String::as_str),
            Some("v1")
        );
        assert!(error.presentation().summary.contains("was activated"));
        assert!(
            error
                .presentation()
                .summary
                .contains("current active state is not confirmed")
        );
        let status = library
            .status("portable-fixture", ReleaseChannel::Stable)
            .unwrap();
        assert!(status.active.is_none());
        assert!(status.external_runtime.is_none());
        let installs = library.all_installs().unwrap();
        assert_eq!(installs.len(), 1);
        assert!(installs[0].path.join("game.exe").is_file());
        assert!(OperationStore::new(library).all().unwrap().is_empty());
        assert_eq!(
            fs::read(old.path.join("save.dat")).unwrap(),
            b"external player progress"
        );
    }

    #[tokio::test]
    async fn route_change_keeps_known_commit_when_database_readback_is_unavailable() {
        struct InterruptReadback(PathBuf);
        impl LifecycleFaultInjector for InterruptReadback {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == LifecycleFaultPoint::InstallMetadataCommitted {
                    // Only this disposable fixture's closed database is moved.
                    // Keep the bytes and make reconnect fail until restored below.
                    fs::rename(
                        self.0.join("portcove.sqlite3"),
                        self.0.join("preserved.sqlite3"),
                    )?;
                    fs::create_dir(self.0.join("portcove.sqlite3"))?;
                    return Err(PortcoveError::state(
                        "synthetic loss of database access after commit",
                    ));
                }
                Ok(())
            }
        }
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider.clone());
        let old = register_external_copy(&service, &temporary.path().join("external"));
        let authorization = route_authorization(&service).await;
        service.faults = Arc::new(InterruptReadback(library.root().to_owned()));
        let result = service
            .change_to_managed_runtime("portable-fixture", None, None, &authorization.token, |_| {})
            .await;
        fs::remove_dir(library.root().join("portcove.sqlite3")).unwrap();
        fs::rename(
            library.root().join("preserved.sqlite3"),
            library.root().join("portcove.sqlite3"),
        )
        .unwrap();
        let error = result.unwrap_err();
        assert_eq!(
            error.presentation().mutation_state,
            crate::MutationState::Committed
        );
        assert_eq!(
            error.details.get("committed_version").map(String::as_str),
            Some("v1")
        );
        assert!(error.presentation().summary.contains("was activated"));
        assert!(
            error
                .presentation()
                .summary
                .contains("current active state is not confirmed")
        );
        let recovered = build_service(library.clone(), provider);
        recovered.recover_pending_operations().unwrap();
        assert_eq!(
            library
                .status("portable-fixture", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .version,
            "v1"
        );
        assert_eq!(
            fs::read(old.path.join("save.dat")).unwrap(),
            b"external player progress"
        );
    }
    #[tokio::test]
    async fn restore_review_safety_copy_matches_collection_and_filesystem_case_rules() {
        for changed_case in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let service = build_service(library.clone(), provider);
            let install = service
                .install("portable-fixture", None, None, None, true, |_| {})
                .await
                .unwrap();
            fs::write(install.path.join("settings.ini"), b"backed up settings").unwrap();
            let backup = service.create_backup("portable-fixture").unwrap();
            fs::remove_file(install.path.join("settings.ini")).unwrap();
            let user = library.user_dir("portable-fixture");
            if changed_case {
                fs::rename(user.join("settings.ini"), user.join("case-change.tmp")).unwrap();
                fs::rename(user.join("case-change.tmp"), user.join("Settings.ini")).unwrap();
            }
            let canonical_name = if changed_case {
                "Settings.ini"
            } else {
                "settings.ini"
            };
            let distinct_coordinate = !user.join("settings.ini").exists();
            let preview = service
                .preview_backup_action("portable-fixture", &backup.id, BackupAction::Restore)
                .unwrap();
            assert!(preview.current_user_data_exists);
            assert_eq!(preview.safety_backup_will_be_created, distinct_coordinate);
            assert_eq!(
                fs::read(user.join(canonical_name)).unwrap(),
                b"backed up settings"
            );
            let authorization = service
                .authorize_backup_action(
                    "portable-fixture",
                    &backup.id,
                    BackupAction::Restore,
                    &preview.preview_sha256,
                )
                .unwrap();
            let result = service
                .restore_backup("portable-fixture", &backup.id, &authorization.token)
                .unwrap();
            assert_eq!(result.safety_backup.is_some(), distinct_coordinate);
            if let Some(safety) = result.safety_backup {
                assert_eq!(
                    fs::read(safety.path.join("data").join(canonical_name)).unwrap(),
                    b"backed up settings"
                );
            }
            assert_eq!(
                fs::read(install.path.join("settings.ini")).unwrap(),
                b"backed up settings"
            );
        }
    }

    #[tokio::test]
    async fn restore_review_collects_runtime_progress_after_consent_and_keeps_a_safety_backup() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let service = build_service(library.clone(), provider);
        let install = service
            .install("portable-fixture", None, None, None, true, |_| {})
            .await
            .unwrap();
        fs::write(install.path.join("settings.ini"), b"old saved choices").unwrap();
        let backup = service.create_backup("portable-fixture").unwrap();
        let user = library.user_dir("portable-fixture");
        fs::remove_dir_all(&user).unwrap();
        fs::write(install.path.join("settings.ini"), b"new prelaunch choices").unwrap();
        let preview = service
            .preview_backup_action("portable-fixture", &backup.id, BackupAction::Restore)
            .unwrap();
        assert!(preview.current_user_data_exists && preview.safety_backup_will_be_created);
        assert!(
            !user.exists(),
            "preview must not collect or create canonical data"
        );
        assert!(
            service
                .restore_backup("portable-fixture", &backup.id, "invalid consent")
                .is_err()
        );
        assert!(!user.exists(), "failed consent must not collect data");
        let authorization = service
            .authorize_backup_action(
                "portable-fixture",
                &backup.id,
                BackupAction::Restore,
                &preview.preview_sha256,
            )
            .unwrap();
        let result = service
            .restore_backup("portable-fixture", &backup.id, &authorization.token)
            .unwrap();
        assert_eq!(
            fs::read(result.safety_backup.unwrap().path.join("data/settings.ini")).unwrap(),
            b"new prelaunch choices"
        );
        assert_eq!(
            fs::read(user.join("settings.ini")).unwrap(),
            b"old saved choices"
        );
        assert_eq!(
            fs::read(install.path.join("settings.ini")).unwrap(),
            b"old saved choices"
        );
        assert!(!install.path.join(LAUNCH_MARKER).exists());
    }

    #[tokio::test]
    async fn restore_review_abandons_a_stale_prepared_copy_before_recovery_can_publish_it() {
        struct ChangeDuringPreparation {
            path: PathBuf,
        }
        impl LifecycleFaultInjector for ChangeDuringPreparation {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == LifecycleFaultPoint::RestorePrepared {
                    fs::write(&self.path, b"changed during restore preparation")?;
                }
                Ok(())
            }
        }
        for change in ["runtime", "canonical"] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let mut service = build_service(library.clone(), provider.clone());
            let install = service
                .install("portable-fixture", None, None, None, true, |_| {})
                .await
                .unwrap();
            fs::write(install.path.join("settings.ini"), b"old backup choices").unwrap();
            let backup = service.create_backup("portable-fixture").unwrap();
            fs::write(install.path.join("settings.ini"), b"current choices").unwrap();
            let user = library.user_dir("portable-fixture");
            let path = if change == "runtime" {
                install.path.join("settings.ini")
            } else {
                user.join("settings.ini")
            };
            let preview = service
                .preview_backup_action("portable-fixture", &backup.id, BackupAction::Restore)
                .unwrap();
            let authorization = service
                .authorize_backup_action(
                    "portable-fixture",
                    &backup.id,
                    BackupAction::Restore,
                    &preview.preview_sha256,
                )
                .unwrap();
            service.faults = Arc::new(ChangeDuringPreparation { path: path.clone() });
            let error = service
                .restore_backup("portable-fixture", &backup.id, &authorization.token)
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Conflict);
            assert_eq!(
                fs::read(&path).unwrap(),
                b"changed during restore preparation"
            );
            assert!(
                OperationStore::new(library.clone())
                    .all()
                    .unwrap()
                    .is_empty()
            );
            assert!(
                service
                    .list_backups("portable-fixture")
                    .unwrap()
                    .backups
                    .iter()
                    .any(|row| fs::read(row.path.join("data/settings.ini")).unwrap()
                        == b"current choices")
            );
            let recovered = build_service(library.clone(), provider);
            recovered.recover_pending_operations().unwrap();
            assert_eq!(
                fs::read(&path).unwrap(),
                b"changed during restore preparation"
            );
            assert!(
                OperationStore::new(library.clone())
                    .all()
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[tokio::test]
    async fn restore_review_refuses_changed_runtime_canonical_or_active_identity_before_collection()
    {
        for change in ["runtime", "canonical", "active"] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let service = build_service(library.clone(), provider);
            let mut install = service
                .install("portable-fixture", None, None, None, true, |_| {})
                .await
                .unwrap();
            fs::write(install.path.join("settings.ini"), b"backup choices").unwrap();
            let backup = service.create_backup("portable-fixture").unwrap();
            fs::write(install.path.join("settings.ini"), b"new runtime choices").unwrap();
            let user = library.user_dir("portable-fixture");
            let preview = service
                .preview_backup_action("portable-fixture", &backup.id, BackupAction::Restore)
                .unwrap();
            let authorization = service
                .authorize_backup_action(
                    "portable-fixture",
                    &backup.id,
                    BackupAction::Restore,
                    &preview.preview_sha256,
                )
                .unwrap();
            match change {
                "runtime" => {
                    fs::write(install.path.join("settings.ini"), b"changed after review").unwrap()
                }
                "canonical" => {
                    fs::write(user.join("settings.ini"), b"changed canonical after review").unwrap()
                }
                _ => {
                    install.installed_at += 1;
                    library.register_install(&install, true).unwrap();
                }
            }
            let canonical_before = fs::read(user.join("settings.ini")).unwrap();
            let runtime_before = fs::read(install.path.join("settings.ini")).unwrap();
            let error = service
                .restore_backup("portable-fixture", &backup.id, &authorization.token)
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Conflict);
            assert_eq!(
                fs::read(user.join("settings.ini")).unwrap(),
                canonical_before
            );
            assert_eq!(
                fs::read(install.path.join("settings.ini")).unwrap(),
                runtime_before
            );
            assert!(
                OperationStore::new(library.clone())
                    .all()
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                service
                    .list_backups("portable-fixture")
                    .unwrap()
                    .backups
                    .len(),
                1
            );
        }
    }

    #[tokio::test]
    async fn first_portable_play_preparation_preserves_edits_before_any_child_runs() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let service = build_service(library.clone(), provider);
        let install = service
            .install("portable-fixture", None, None, None, true, |_| {})
            .await
            .unwrap();
        fs::create_dir_all(library.user_dir("portable-fixture")).unwrap();
        fs::write(
            library.user_dir("portable-fixture").join("settings.ini"),
            b"original settings",
        )
        .unwrap();
        service
            .restore_user_data_to(
                service.catalog.port("portable-fixture").unwrap(),
                &install.path,
            )
            .unwrap();
        fs::write(
            install.path.join("settings.ini"),
            b"deliberate prelaunch settings",
        )
        .unwrap();
        fs::create_dir_all(install.path.join("saves")).unwrap();
        fs::write(
            install.path.join("saves/before-play.sav"),
            b"prelaunch data",
        )
        .unwrap();
        let spec = service
            .prepare_launch_for_install(
                service.catalog.port("portable-fixture").unwrap(),
                &install,
                None,
                None,
            )
            .unwrap();
        assert_eq!(spec.executable, install.path.join("game.exe"));
        assert_eq!(
            fs::read(library.user_dir("portable-fixture").join("settings.ini")).unwrap(),
            b"deliberate prelaunch settings"
        );
        assert_eq!(
            fs::read(install.path.join("settings.ini")).unwrap(),
            b"deliberate prelaunch settings"
        );
        assert_eq!(
            fs::read(
                library
                    .user_dir("portable-fixture")
                    .join("saves/before-play.sav")
            )
            .unwrap(),
            b"prelaunch data"
        );
        assert!(!install.path.join(LAUNCH_MARKER).exists());
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
    async fn portable_launch_coordinates_cannot_reinterpret_retained_player_data() {
        for changed_field in ["launch_arguments", "launch_environment"] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let mut service = build_service(library, provider.clone());
            let mut document = serde_json::to_value(catalog().document()).unwrap();
            document["ports"][0]["launch_arguments"] = serde_json::json!(["--data-dir", "data"]);
            document["ports"][0]["launch_environment"] =
                serde_json::json!({ "GAME_DATA_DIR": "data" });
            service.catalog = Catalog::from_json(&document.to_string()).unwrap();
            let first = service
                .install("portable-fixture", None, None, None, true, |_| {})
                .await
                .unwrap();
            fs::create_dir_all(first.path.join("data")).unwrap();
            fs::write(first.path.join("data/progress.sav"), b"keep progress").unwrap();
            *provider.0.lock().unwrap() = server.release("v2", 2);
            let second = service
                .update("portable-fixture", None, None, true, |_| {})
                .await
                .unwrap();
            assert_eq!(second.version, "v2");
            assert_eq!(
                fs::read(second.path.join("data/progress.sav")).unwrap(),
                b"keep progress"
            );

            document["ports"][0][changed_field] = if changed_field == "launch_arguments" {
                serde_json::json!(["--data-dir", "another-data-directory"])
            } else {
                serde_json::json!({ "GAME_DATA_DIR": "another-data-directory" })
            };
            service.catalog = Catalog::from_json(&document.to_string()).unwrap();
            *provider.0.lock().unwrap() = server.release("v3", 3);
            let failure = service
                .update("portable-fixture", None, None, true, |_| {})
                .await
                .unwrap_err();
            assert_eq!(
                failure.presentation().presentation_key,
                "portable_data_contract_changed",
                "{changed_field}"
            );
            let state = service.status("portable-fixture").unwrap();
            assert_eq!(state.active.unwrap().id, second.id, "{changed_field}");
            assert!(state.staged.is_none(), "{changed_field}");
            assert_eq!(
                fs::read(second.path.join("data/progress.sav")).unwrap(),
                b"keep progress"
            );
            assert_eq!(fs::read(second.path.join("package.txt")).unwrap(), [2]);
            assert!(first.path.join("game.exe").exists());
        }
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
