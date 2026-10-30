//! Generic package ownership through the existing managed version lifecycle.
use super::*;

fn portable_data_change() -> PortcoveError {
    PortcoveError::conflict(
        "The new package changes how this installation stores or locates player data. Keep the current version and use upstream instructions until a supported data migration is available. Your installation and files have been preserved.",
    ).with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged)
}

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
        self.require_portable_transition_to(from, to, None)
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
        self.require_portable_transition_to(from, &self.installed_port(previous)?, Some(previous))
    }

    fn require_portable_transition_to(
        &self,
        from: &InstallRecord,
        to: &PortDefinition,
        retained_rollback: Option<&InstallRecord>,
    ) -> Result<()> {
        let retained = self.installed_port(from)?;
        if retained.adapter != AdapterKind::NativePortable
            && to.adapter != AdapterKind::NativePortable
            && !crate::persistence::ready_staged_archive(&retained)
            && !crate::persistence::ready_staged_archive(to)
            && !retained.n64_runtime_at_executable_parent
            && !to.n64_runtime_at_executable_parent
        {
            return Ok(());
        }
        let platform = Platform::current()?;
        if retained.adapter != to.adapter
            || retained.n64_runtime_at_executable_parent != to.n64_runtime_at_executable_parent
            || crate::persistence::ready_staged_archive(&retained)
                != crate::persistence::ready_staged_archive(to)
            || retained.mod_package_policy != to.mod_package_policy
            || retained.persistent_file_patterns != to.persistent_file_patterns
            || retained.runtime_subdirectory != to.runtime_subdirectory
            || retained.windows_temp_directory != to.windows_temp_directory
            || retained.launch_from_install_root != to.launch_from_install_root
            || retained.executable_hints.get(&platform) != to.executable_hints.get(&platform)
            || retained.launch_arguments != to.launch_arguments
            || retained.launch_environment != to.launch_environment
            || retained.user_data_environment != to.user_data_environment
            || retained.source_profile != to.source_profile
            || retained.runtime_source_set != to.runtime_source_set
            || retained.runtime_source_filename != to.runtime_source_filename
            || retained.runtime_source_materialization != to.runtime_source_materialization
            || retained.runtime_source_hashes != to.runtime_source_hashes
            || retained.source_environment != to.source_environment
            || (retained.setup_marker != to.setup_marker
                && !(retained.setup_marker.is_none()
                    && crate::preparation::has_manual_marker(to)
                    && crate::preparation::validate_manual_marker(to).is_ok())
                && !(retained_rollback.is_some()
                    && crate::preparation::has_manual_marker(&retained)
                    && to.setup_marker.is_none()))
        {
            return Err(portable_data_change());
        }
        if crate::preparation::source::native(&retained) {
            let installer = Installer::new(self.library.clone())?;
            if installer.retained_preparation_mode(from)?
                == Some(crate::PreparationMode::SourceOnly)
            {
                // Registered originals cannot replace the source authority sealed
                // into this installation, including a same-profile edition change.
                crate::preparation::source::require_publication(&self.library, from, None)
                    .map_err(|_| portable_data_change())?;
                if let Some(previous) = retained_rollback {
                    if installer.retained_preparation_mode(previous)?
                        != Some(crate::PreparationMode::SourceOnly)
                    {
                        return Err(portable_data_change());
                    }
                    crate::preparation::source::require_publication(&self.library, previous, None)
                        .map_err(|_| portable_data_change())?;
                }
            }
        }
        if retained.persistent_paths != to.persistent_paths {
            if let Some(previous) = retained_rollback
                && to
                    .persistent_paths
                    .iter()
                    .all(|path| retained.persistent_paths.contains(path))
            {
                // The same empty-path proof protects a smaller retained scope in reverse.
                self.require_empty_persistence_expansion(previous, &retained, Some(from))?;
            } else {
                self.require_empty_persistence_expansion(from, to, retained_rollback)?;
            }
        }
        Ok(())
    }

    pub(super) fn require_portable_target_transition(
        &self,
        from: &InstallRecord,
        target: &InstallRecord,
    ) -> Result<()> {
        let to = self.installed_port(target)?;
        self.require_portable_transition(from, &to)?;
        let retained = self.installed_port(from)?;
        if crate::preparation::source::native(&retained)
            && Installer::new(self.library.clone())?.retained_preparation_mode(from)?
                == Some(crate::PreparationMode::SourceOnly)
        {
            if Installer::new(self.library.clone())?.retained_preparation_mode(target)?
                != Some(crate::PreparationMode::SourceOnly)
            {
                return Err(portable_data_change());
            }
            crate::preparation::source::require_publication(&self.library, target, None)
                .map_err(|_| portable_data_change())?;
        }
        if crate::persistence::ready_staged_archive(&retained)
            && crate::persistence::ready_staged_archive(&to)
            && retained.persistent_paths != to.persistent_paths
        {
            self.require_empty_persistence_expansion(from, &to, Some(target))?;
        }
        Ok(())
    }

    fn require_empty_persistence_expansion(
        &self,
        from: &InstallRecord,
        to: &PortDefinition,
        target: Option<&InstallRecord>,
    ) -> Result<()> {
        let installer = Installer::new(self.library.clone())?;
        let catalog = installer
            .retained_catalog(from)?
            .ok_or_else(portable_data_change)?;
        let retained = catalog.port(&from.port_id)?;
        if !crate::persistence::ready_staged_archive(retained)
            || !crate::persistence::ready_staged_archive(to)
            || !retained
                .persistent_paths
                .iter()
                .all(|path| to.persistent_paths.contains(path))
        {
            return Err(portable_data_change());
        }
        self.persistence_contract_for_install(from)?;
        // Inactive copies must also retain a usable, unexpanded restore contract.
        self.preflight_psx_mod_restores(&from.port_id, &self.library.user_dir(&from.port_id))?;
        let added = to
            .persistent_paths
            .iter()
            .filter(|path| !retained.persistent_paths.contains(path))
            .collect::<Vec<_>>();
        if added.is_empty() {
            return Err(portable_data_change());
        }
        for path in &added {
            let key = path.to_lowercase();
            for other in &to.persistent_paths {
                if *path == other {
                    continue;
                }
                let other = other.to_lowercase();
                if Path::new(&key).starts_with(&other) || Path::new(&other).starts_with(&key) {
                    return Err(portable_data_change().detail("path", path.as_str()));
                }
            }
        }
        let platform = Platform::current()?;
        let original = InstallQualification::from_port(retained, platform)?;
        let mut expanded = retained.clone();
        expanded.persistent_paths.clone_from(&to.persistent_paths);
        let candidate = InstallQualification::from_port(&expanded, platform)?;
        if !installer.permits_additive_mutability(from, &original, &candidate)? {
            return Err(portable_data_change());
        }
        let mut roots = vec![
            self.persistence_root(retained, &from.path)?,
            self.library.user_dir(&from.port_id),
        ];
        if let Some(target) = target {
            let target_catalog = installer
                .retained_catalog(target)?
                .ok_or_else(portable_data_change)?;
            let target_port = target_catalog.port(&target.port_id)?;
            if target.port_id != from.port_id || target_port.persistent_paths != to.persistent_paths
            {
                return Err(portable_data_change());
            }
            self.persistence_contract_for_install(target)?;
            roots.push(self.persistence_root(target_port, &target.path)?);
        }
        self.require_direct_empty_expansion(retained, to, &roots)?;
        for path in added {
            for root in &roots {
                crate::persistence::require_absent_path(root, path).map_err(|error| {
                    error.with_known_cause(
                        crate::failure::KnownFailureCause::PortableDataContractChanged,
                    )
                })?;
            }
        }
        Ok(())
    }

    /// Backups must not silently omit unclaimed output in an inactive copy.
    pub(super) fn require_generated_cache_outputs_unchanged(&self, port_id: &str) -> Result<()> {
        for install in self.library.all_installs()? {
            if install.port_id == port_id {
                self.require_generated_cache_install_unchanged(&install)?;
            }
        }
        Ok(())
    }

    pub(super) fn require_generated_cache_install_unchanged(
        &self,
        install: &InstallRecord,
    ) -> Result<()> {
        // An absent runtime has no output to omit. Ordinary canonical backups
        // remain available for historical records whose payload no longer exists.
        if matches!(fs::symlink_metadata(&install.path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(());
        }
        if self.installed_port(install)?.adapter == AdapterKind::GeneratedCache {
            self.require_portable_runtime_unchanged(install)?;
        }
        Ok(())
    }

    pub(super) fn require_portable_runtime_unchanged(&self, install: &InstallRecord) -> Result<()> {
        let port = self.installed_port(install)?;
        if port.adapter != AdapterKind::NativePortable
            && port.adapter != AdapterKind::GeneratedCache
            && !crate::persistence::ready_staged_archive(&port)
            && !port.n64_runtime_at_executable_parent
        {
            return Ok(());
        }
        if port.adapter == AdapterKind::GeneratedCache
            && Installer::new(self.library.clone())?
                .retained_catalog(install)?
                .is_none()
        {
            return Err(PortcoveError::verification(
                "Generated-cache maintenance requires its exact retained contract; preserve this runtime and all player data for review",
            ));
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
    use crate::Adapter;
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
    impl Server {
        fn release_with_nested_data(
            &self,
            version: &str,
            revision: u8,
            folder: &str,
        ) -> ResolvedRelease {
            let mut release = self.release_in_folder(version, revision, folder, "game.exe");
            let mut content = self.bytes.lock().unwrap();
            let mut zip =
                zip::ZipWriter::new_append(std::io::Cursor::new(content.clone())).unwrap();
            zip.start_file(
                format!("{folder}assets/package-data.bin"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(&[revision]).unwrap();
            *content = zip.finish().unwrap().into_inner();
            release.asset.size = content.len() as u64;
            release.asset.sha256 = hex::encode(Sha256::digest(&*content));
            release
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            self.worker.take().unwrap().join().unwrap();
        }
    }
    fn catalog() -> Catalog {
        Catalog::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[{"id":"portable-fixture","name":"Portable fixture","summary":"Generic upstream setup","project_url":"https://github.com/example/game","support_tier":"beta","channels":["stable","beta"],"platforms":["windows-x86-64"],"adapter":"native-portable","release":{"repository":"example/game","asset_hints":{"windows-x86-64":["windows","x64"]}},"executable_hints":{"windows-x86-64":["game.exe"]},"persistent_paths":["data","saves","mods","settings.ini"],"persistent_file_patterns":[{"prefix":"shot_","suffix":".png"},{"prefix":"vram_","suffix":".png"}]}]}"#).unwrap()
    }
    fn build_service(library: Library, provider: Arc<Provider>) -> PortcoveService {
        let mut service = PortcoveService::with_provider(library, provider).unwrap();
        service.catalog = catalog();
        service
    }

    fn native_temp_catalog() -> Catalog {
        let mut document = serde_json::to_value(catalog().authoritative_document()).unwrap();
        document["ports"][0]["windows_runtime_path_policy"] =
            serde_json::json!("relative-file-max-path");
        document["ports"][0]["windows_temp_directory"] = serde_json::json!("temp");
        document["ports"][0]["persistent_paths"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("temp"));
        Catalog::from_json(&document.to_string()).unwrap()
    }

    #[tokio::test]
    async fn adoption_preserves_native_temp_interpretation_in_both_directions() {
        const ID: &str = "portable-fixture";
        for creating_has_temp in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let mut service = PortcoveService::with_provider(library.clone(), provider).unwrap();
            let mut creating =
                serde_json::to_value(native_temp_catalog().authoritative_document()).unwrap();
            if !creating_has_temp {
                creating["ports"][0]["windows_temp_directory"] = serde_json::Value::Null;
            }
            let creating = Catalog::from_json(&creating.to_string()).unwrap();
            service.replace_catalog_for_test(creating.clone());
            let first = service
                .install(ID, None, None, None, true, |_| {})
                .await
                .unwrap();
            let external = temporary.path().join("external");
            fs::create_dir(&external).unwrap();
            fs::copy(first.path.join("game.exe"), external.join("game.exe")).unwrap();
            let original = fs::read(external.join("game.exe")).unwrap();
            let mut changed = serde_json::to_value(creating.authoritative_document()).unwrap();
            changed["ports"][0]["windows_temp_directory"] = if creating_has_temp {
                serde_json::Value::Null
            } else {
                serde_json::json!("temp")
            };
            service.replace_catalog_for_test(Catalog::from_json(&changed.to_string()).unwrap());
            let preview = service.preview_adoption(&external, Some(ID)).unwrap();
            let consent = service
                .authorize_adoption(&external, Some(ID), &preview.plan_sha256)
                .unwrap();
            assert!(service.adopt(&external, Some(ID), &consent.token).is_err());
            assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
            assert_eq!(fs::read(external.join("game.exe")).unwrap(), original);
            service.replace_catalog_for_test(creating);
            let preview = service.preview_adoption(&external, Some(ID)).unwrap();
            let consent = service
                .authorize_adoption(&external, Some(ID), &preview.plan_sha256)
                .unwrap();
            let adopted = service.adopt(&external, Some(ID), &consent.token).unwrap();
            assert_eq!(service.status(ID).unwrap().active.unwrap().id, adopted.id);
            assert_eq!(fs::read(external.join("game.exe")).unwrap(), original);
        }
    }

    #[tokio::test]
    async fn no_active_native5_activation_rechecks_canonical_data_after_staging() {
        const ID: &str = "portable-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = PortcoveService::with_provider(library.clone(), provider).unwrap();
        service.replace_catalog_for_test(native_temp_catalog());
        let staged = service
            .install(ID, None, None, None, false, |_| {})
            .await
            .unwrap();
        assert!(service.status(ID).unwrap().active.is_none());
        fs::create_dir_all(library.user_dir(ID).join("temp")).unwrap();
        fs::write(
            library.user_dir(ID).join("temp/witness.bin"),
            b"unproven legacy bytes",
        )
        .unwrap();
        assert!(service.activate_staged(ID).is_err());
        assert!(service.status(ID).unwrap().active.is_none());
        assert!(staged.path.is_dir());
        assert!(!staged.path.join("temp").exists());
        assert_eq!(
            fs::read(library.user_dir(ID).join("temp/witness.bin")).unwrap(),
            b"unproven legacy bytes"
        );
        assert!(
            service
                .install(ID, None, None, None, true, |_| {})
                .await
                .is_err()
        );
        let id = Uuid::new_v4().to_string();
        let mut journal = LifecycleOperation::new(&id, LifecycleOperationKind::Install, ID);
        journal.install = Some(staged.clone());
        journal.activate = true;
        journal.phase = LifecyclePhase::PayloadPublished;
        journal.paths.staging = Some(library.staging_dir().join(&id));
        journal.paths.final_path = Some(staged.path.clone());
        fs::create_dir_all(journal.paths.staging.as_ref().unwrap()).unwrap();
        let store = OperationStore::new(library.clone());
        store.put(&mut journal).unwrap();
        assert!(
            crate::recovery::recover_published_install(&service, &store, &mut journal).is_err()
        );
        assert!(store.get(&id).unwrap().is_some());
        assert!(service.status(ID).unwrap().active.is_none());
        drop(service);
        let mut reopened = PortcoveService::new(library.clone()).unwrap();
        reopened.replace_catalog_for_test(native_temp_catalog());
        assert!(
            crate::recovery::recover_published_install(&reopened, &store, &mut journal).is_err()
        );
        assert!(reopened.status(ID).unwrap().active.is_none());
        assert!(staged.path.is_dir());
        assert_eq!(
            fs::read(library.user_dir(ID).join("temp/witness.bin")).unwrap(),
            b"unproven legacy bytes"
        );
    }

    #[tokio::test]
    async fn removed_native4_data_cannot_be_reinterpreted_as_a_new_native5_temp_namespace() {
        const ID: &str = "portable-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service =
            PortcoveService::with_provider(library.clone(), provider.clone()).unwrap();
        let new = native_temp_catalog();
        let mut old = serde_json::to_value(new.authoritative_document()).unwrap();
        old["ports"][0]["windows_temp_directory"] = serde_json::Value::Null;
        service.replace_catalog_for_test(Catalog::from_json(&old.to_string()).unwrap());
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        fs::create_dir(first.path.join("temp")).unwrap();
        fs::write(
            first.path.join("temp/witness.bin"),
            b"old data is not Windows TEMP",
        )
        .unwrap();
        let preview = service.preview_removal(ID).unwrap();
        let consent = service
            .authorize_removal(ID, &preview.preview_sha256)
            .unwrap();
        service.remove(ID, &consent.token).unwrap();
        assert!(service.status(ID).unwrap().active.is_none());
        service.replace_catalog_for_test(new);
        *provider.0.lock().unwrap() = server.release("v2", 2);
        assert!(
            service
                .install(ID, None, None, None, true, |_| {})
                .await
                .is_err()
        );
        assert!(service.status(ID).unwrap().active.is_none());
        assert_eq!(
            fs::read(library.user_dir(ID).join("temp/witness.bin")).unwrap(),
            b"old data is not Windows TEMP"
        );
    }

    #[tokio::test]
    async fn native5_temp_bytes_follow_owned_wrapper_update_backup_rollback_and_removal() {
        const ID: &str = "portable-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(
            server.release_in_folder("v1", 1, "Game-v1/", "game.exe"),
        )));
        let mut service =
            PortcoveService::with_provider(library.clone(), provider.clone()).unwrap();
        let catalog = native_temp_catalog();
        service.replace_catalog_for_test(catalog.clone());
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let port = catalog.port(ID).unwrap();
        let readonly = crate::adapter::standard(AdapterKind::NativePortable)
            .launch_spec(&library, port, Platform::WindowsX86_64, &first.path, None)
            .unwrap();
        assert!(!first.path.join("Game-v1/temp").exists());
        assert_eq!(readonly.environment["TEMP"], "temp");
        let prepared = service.prepare_launch(ID, None).unwrap();
        assert!(prepared.working_directory.join("temp").is_dir());
        fs::write(
            prepared.working_directory.join("temp/witness.bin"),
            b"owned temporary bytes",
        )
        .unwrap();
        let backup = service.create_backup(ID).unwrap();
        assert_eq!(
            fs::read(backup.path.join("data/temp/witness.bin")).unwrap(),
            b"owned temporary bytes"
        );
        *provider.0.lock().unwrap() = server.release_in_folder("v2", 2, "Game-v2/", "game.exe");
        service.update(ID, None, None, false, |_| {}).await.unwrap();
        let second = service.activate_staged(ID).unwrap();
        assert_eq!(
            fs::read(second.path.join("Game-v2/temp/witness.bin")).unwrap(),
            b"owned temporary bytes"
        );
        fs::write(
            second.path.join("Game-v2/temp/witness.bin"),
            b"newest temporary bytes",
        )
        .unwrap();
        let previous = service.rollback(ID).unwrap();
        assert_eq!(previous.id, first.id);
        assert_eq!(
            fs::read(previous.path.join("Game-v1/temp/witness.bin")).unwrap(),
            b"newest temporary bytes"
        );
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
        service
            .restore_backup(ID, &backup.id, &consent.token)
            .unwrap();
        assert_eq!(
            fs::read(previous.path.join("Game-v1/temp/witness.bin")).unwrap(),
            b"owned temporary bytes"
        );
        let mut changed = serde_json::to_value(catalog.authoritative_document()).unwrap();
        changed["ports"][0]["windows_temp_directory"] = serde_json::json!("different-temp");
        *changed["ports"][0]["persistent_paths"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap() = serde_json::json!("different-temp");
        service.replace_catalog_for_test(Catalog::from_json(&changed.to_string()).unwrap());
        *provider.0.lock().unwrap() = server.release("v3", 3);
        assert!(service.update(ID, None, None, true, |_| {}).await.is_err());
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        assert_eq!(
            fs::read(previous.path.join("Game-v1/temp/witness.bin")).unwrap(),
            b"owned temporary bytes"
        );
        let preview = service.preview_removal(ID).unwrap();
        let consent = service
            .authorize_removal(ID, &preview.preview_sha256)
            .unwrap();
        service.remove(ID, &consent.token).unwrap();
        assert!(!first.path.exists());
        assert_eq!(
            fs::read(library.user_dir(ID).join("temp/witness.bin")).unwrap(),
            b"owned temporary bytes"
        );
        // With no active creating contract, preserved bytes alone cannot grant
        // the new installation authority to interpret this namespace as TEMP.
        service.replace_catalog_for_test(catalog);
        assert!(
            service
                .install(ID, None, None, None, true, |_| {})
                .await
                .is_err()
        );
        assert!(service.status(ID).unwrap().active.is_none());
        assert_eq!(
            fs::read(library.user_dir(ID).join("temp/witness.bin")).unwrap(),
            b"owned temporary bytes"
        );
    }

    #[tokio::test]
    async fn native5_rejects_publisher_temp_members_before_runtime_publication() {
        for member in ["temp/immutable.bin", "TEMP/immutable.bin", "temp"] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let release = server.release_with_files(
                "v1",
                1,
                "",
                "game.exe",
                &[(member, b"publisher file".as_slice())],
            );
            let provider = Arc::new(Provider(Mutex::new(release)));
            let mut service = PortcoveService::with_provider(library, provider).unwrap();
            service.replace_catalog_for_test(native_temp_catalog());
            assert!(
                service
                    .install("portable-fixture", None, None, None, true, |_| {})
                    .await
                    .is_err(),
                "{member}"
            );
            assert!(service.status("portable-fixture").unwrap().active.is_none());
        }
    }

    #[tokio::test]
    async fn n64_executable_parent_preserves_preplay_data_across_versioned_wrappers() {
        const ID: &str = "portable-fixture";
        const PROFILE: &str = "owned-n64-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        // First-party inert big-endian header/payload, never commercial data.
        let mut owned = [0_u8; 32];
        owned[..4].copy_from_slice(b"\x80\x37\x12\x40");
        let source = temporary.path().join("owned.z64");
        fs::write(&source, owned).unwrap();
        let digest = hex::encode(Sha256::digest(owned));
        let mut document = serde_json::to_value(catalog().authoritative_document()).unwrap();
        document["source_profiles"] = serde_json::json!([{
            "id":PROFILE,"label":"Owned inert N64 fixture","kind":"file",
            "accepted_extensions":["z64"],"accepted_sha256":[digest]
        }]);
        let port = &mut document["ports"][0];
        port["adapter"] = serde_json::json!("n64-recomp-portable");
        port["portable_marker"] = serde_json::json!(true);
        port["n64_runtime_at_executable_parent"] = serde_json::json!(true);
        port["source_profile"] = serde_json::json!(PROFILE);
        port["runtime_source_filename"] = serde_json::json!("owned.z64");
        port["runtime_source_materialization"] = serde_json::json!("n64-big-endian");
        port["runtime_source_hashes"] = serde_json::json!({"owned.z64":digest});
        port["persistent_paths"] =
            serde_json::json!(["data", "saves", "mods", "settings.ini", "owned.z64"]);
        let catalog = Catalog::from_json(&document.to_string()).unwrap();
        let port = catalog.port(ID).unwrap().clone();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(
            server.release_with_nested_data("v1", 1, "Game-v1/"),
        )));
        let mut service =
            PortcoveService::with_provider(library.clone(), provider.clone()).unwrap();
        service.replace_catalog_for_test(catalog.clone());
        service.register_source(PROFILE, &source).unwrap();
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let first_root = first.path.join("Game-v1");
        fs::create_dir_all(library.user_dir(ID)).unwrap();
        fs::write(
            library.user_dir(ID).join("settings.ini"),
            b"older canonical settings",
        )
        .unwrap();
        fs::write(first_root.join("settings.ini"), b"choice before first Play").unwrap();
        fs::create_dir_all(first_root.join("saves")).unwrap();
        fs::write(first_root.join("saves/progress"), b"preplay progress").unwrap();
        fs::create_dir_all(first_root.join("mods")).unwrap();
        fs::write(
            first_root.join("mods/custom.rtz"),
            b"player mod before Play",
        )
        .unwrap();
        let launch = service
            .prepare_launch_for_install(&port, &first, None, None)
            .unwrap();
        assert_eq!(launch.working_directory, first_root);
        assert_eq!(fs::read(first_root.join("owned.z64")).unwrap(), owned);
        assert!(first_root.join("portable.txt").is_file());
        assert_eq!(
            fs::read(first_root.join("settings.ini")).unwrap(),
            b"choice before first Play"
        );
        assert_eq!(
            fs::read(library.user_dir(ID).join("saves/progress")).unwrap(),
            b"preplay progress"
        );
        // Exercise the retained-contract classifier inside verify_critical,
        // not only the service's pre-collection verifier.
        let installer = Installer::new(library.clone()).unwrap();
        let qualification =
            InstallQualification::from_port(&port, Platform::WindowsX86_64).unwrap();
        installer.verify_critical(&first, &qualification).unwrap();
        fs::write(first_root.join("assets/package-data.bin"), [9]).unwrap();
        let tampered = installer
            .verify_critical(&first, &qualification)
            .unwrap_err();
        assert!(tampered.details["failures"].contains("assets/package-data.bin"));
        assert!(!first.path.join(LAUNCH_MARKER).exists());
        fs::write(first_root.join("assets/package-data.bin"), [1]).unwrap();
        fs::write(first_root.join("settings.ini"), b"choice before first Play").unwrap();
        fs::create_dir_all(first_root.join("saves")).unwrap();
        fs::write(first_root.join("saves/progress"), b"preplay progress").unwrap();
        let stamp = std::time::UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_700);
        fs::OpenOptions::new()
            .write(true)
            .open(first_root.join("settings.ini"))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(stamp))
            .unwrap();
        assert!(!first.path.join(LAUNCH_MARKER).exists());
        let backup = service.create_backup(ID).unwrap();
        assert_eq!(
            fs::read(backup.path.join("data/settings.ini")).unwrap(),
            b"choice before first Play"
        );
        *provider.0.lock().unwrap() = server.release_with_nested_data("v2", 2, "Game-v2/");
        let update = service.update(ID, None, None, false, |_| {}).await.unwrap();
        assert!(update.staged);
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        // Replay an interrupted activation only after current retained-data
        // collection and restoration, including writes made after staging.
        let staged = service.status(ID).unwrap().staged.unwrap();
        fs::write(first_root.join("saves/progress"), b"progress after staging").unwrap();
        let operation_id = Uuid::new_v4().to_string();
        let mut journal = crate::operation::LifecycleOperation::new(
            &operation_id,
            crate::operation::LifecycleOperationKind::Install,
            ID,
        );
        journal.install = Some(staged.clone());
        journal.activate = true;
        journal.phase = crate::operation::LifecyclePhase::PayloadPublished;
        journal.paths.staging = Some(library.staging_dir().join(&operation_id));
        journal.paths.final_path = Some(staged.path.clone());
        fs::create_dir_all(journal.paths.staging.as_ref().unwrap()).unwrap();
        let store = OperationStore::new(library.clone());
        store.put(&mut journal).unwrap();
        crate::recovery::recover_published_install(&service, &store, &mut journal).unwrap();
        let second = service.status(ID).unwrap().active.unwrap();
        assert_eq!(second.id, staged.id);
        assert!(store.get(&journal.id).unwrap().is_none());
        let second_root = second.path.join("Game-v2");
        assert_eq!(
            fs::read(second_root.join("settings.ini")).unwrap(),
            b"choice before first Play"
        );
        assert_eq!(
            fs::metadata(second_root.join("settings.ini"))
                .unwrap()
                .modified()
                .unwrap(),
            stamp
        );
        assert_eq!(fs::read(second_root.join("owned.z64")).unwrap(), owned);
        assert_eq!(
            fs::read(second_root.join("saves/progress")).unwrap(),
            b"progress after staging"
        );
        assert!(!second.path.join("Game-v1").exists());
        assert_eq!(
            fs::read(second_root.join("assets/package-data.bin")).unwrap(),
            [2]
        );
        let mut restarted = PortcoveService::with_provider(library, provider.clone()).unwrap();
        restarted.replace_catalog_for_test(catalog);
        let retained = restarted.installed_port(&second).unwrap();
        assert!(retained.n64_runtime_at_executable_parent);
        let launch = restarted
            .prepare_launch_for_install(&retained, &second, None, None)
            .unwrap();
        assert_eq!(launch.working_directory, second_root);
        fs::write(second_root.join("saves/progress"), b"latest progress").unwrap();
        let previous = restarted.rollback(ID).unwrap();
        assert_eq!(previous.id, first.id);
        assert_eq!(
            fs::read(first_root.join("saves/progress")).unwrap(),
            b"latest progress"
        );
        assert_eq!(
            fs::read(first_root.join("mods/custom.rtz")).unwrap(),
            b"player mod before Play"
        );
        // Old/unproven data is compared additively before any first-Play restore,
        // backup or removal; neither conflicting copy can silently win.
        fs::remove_file(first.path.join(PSX_DATA_RECEIPT)).unwrap();
        fs::write(
            first_root.join("settings.ini"),
            b"unproven runtime settings",
        )
        .unwrap();
        fs::write(
            restarted.library.user_dir(ID).join("settings.ini"),
            b"keep canonical settings",
        )
        .unwrap();
        let removal_preview = restarted.preview_removal(ID).unwrap();
        let removal_consent = restarted
            .authorize_removal(ID, &removal_preview.preview_sha256)
            .unwrap();
        for error in [
            restarted.create_backup(ID).unwrap_err(),
            restarted.remove(ID, &removal_consent.token).unwrap_err(),
            restarted
                .prepare_launch_for_install(&retained, &first, None, None)
                .unwrap_err(),
        ] {
            assert!(error.message.contains("unlaunched runtime data differs"));
        }
        assert_eq!(
            fs::read(first_root.join("settings.ini")).unwrap(),
            b"unproven runtime settings"
        );
        assert_eq!(
            fs::read(restarted.library.user_dir(ID).join("settings.ini")).unwrap(),
            b"keep canonical settings"
        );
        assert_eq!(restarted.status(ID).unwrap().active.unwrap().id, first.id);
        assert!(
            OperationStore::new(restarted.library.clone())
                .all()
                .unwrap()
                .is_empty()
        );
        // Deliberate fixture preservation/retry; product code never deletes a conflict.
        fs::remove_file(restarted.library.user_dir(ID).join("settings.ini")).unwrap();
        restarted
            .prepare_launch_for_install(&retained, &first, None, None)
            .unwrap();
        let mut legacy = retained;
        legacy.n64_runtime_at_executable_parent = false;
        assert!(
            restarted
                .require_portable_transition(&previous, &legacy)
                .is_err()
        );
        fs::write(first_root.join("unreviewed-addon.bin"), b"keep this copy").unwrap();
        let error = restarted
            .update(ID, None, None, true, |_| {})
            .await
            .unwrap_err();
        assert_eq!(
            error.presentation().presentation_key,
            "portable_runtime_modified"
        );
        assert!(error.details["failures"].contains("unreviewed-addon.bin"));
        assert_eq!(
            fs::read(first_root.join("unreviewed-addon.bin")).unwrap(),
            b"keep this copy"
        );
        assert_eq!(restarted.status(ID).unwrap().active.unwrap().id, first.id);
        assert!(!previous.path.join(LAUNCH_MARKER).exists());
        let fresh_library = Library::open(temporary.path().join("fresh")).unwrap();
        let mut fresh = PortcoveService::with_provider(fresh_library, provider).unwrap();
        fresh.replace_catalog_for_test(restarted.catalog.clone());
        fresh.register_source(PROFILE, &source).unwrap();
        let newest = fresh
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        assert_eq!(newest.version, "v2");
        assert!(newest.path.join("Game-v2/game.exe").is_file());
        // Preparing launch never executes the inert player or publishes Play.
        assert!(!newest.path.join(LAUNCH_MARKER).exists());
        let newest_root = newest.path.join("Game-v2");
        fs::create_dir_all(newest_root.join("saves")).unwrap();
        fs::write(
            newest_root.join("saves/before-removal"),
            b"keep unlaunched save",
        )
        .unwrap();
        fs::write(
            newest_root.join("settings.ini"),
            b"keep unlaunched settings",
        )
        .unwrap();
        fs::create_dir_all(newest_root.join("mods")).unwrap();
        fs::write(newest_root.join("mods/custom.rtz"), b"keep unlaunched mod").unwrap();
        let preview = fresh.preview_removal(ID).unwrap();
        let consent = fresh
            .authorize_removal(ID, &preview.preview_sha256)
            .unwrap();
        fresh.remove(ID, &consent.token).unwrap();
        assert!(!newest.path.exists());
        for (relative, expected) in [
            ("saves/before-removal", b"keep unlaunched save".as_slice()),
            ("settings.ini", b"keep unlaunched settings"),
            ("mods/custom.rtz", b"keep unlaunched mod"),
        ] {
            assert_eq!(
                fs::read(fresh.library.user_dir(ID).join(relative)).unwrap(),
                expected
            );
        }
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
        let started = std::time::Instant::now();
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
        eprintln!(
            "Native portable profile fixture ready: {:?}",
            started.elapsed()
        );
        let first = service
            .install(ID, Some(ReleaseChannel::Beta), None, None, true, |_| {})
            .await
            .unwrap();
        eprintln!(
            "Native portable profile initial install complete: {:?}",
            started.elapsed()
        );
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
        eprintln!(
            "Native portable profile backup complete: {:?}",
            started.elapsed()
        );
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
        eprintln!(
            "Native portable profile update staged: {:?}",
            started.elapsed()
        );
        assert!(update.staged);
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        let second = service.activate_staged(ID).unwrap();
        eprintln!(
            "Native portable profile activation complete: {:?}",
            started.elapsed()
        );
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
        eprintln!(
            "Native portable profile rollback complete: {:?}",
            started.elapsed()
        );
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
        eprintln!(
            "Native portable profile interrupted import refused: {:?}",
            started.elapsed()
        );
        let fresh_library = Library::open(temporary.path().join("fresh-library")).unwrap();
        let fresh = PortcoveService::with_provider(fresh_library, provider).unwrap();
        let newest = fresh
            .install(ID, Some(ReleaseChannel::Beta), None, None, true, |_| {})
            .await
            .unwrap();
        eprintln!(
            "Native portable profile fresh install complete: {:?}",
            started.elapsed()
        );
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
                .prepare_retained_install_data(&staged)
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
                .require_portable_transition_to(&first, to, Some(&staged))
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
        let started = std::time::Instant::now();
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
        eprintln!("Ready staged fixture ready: {:?}", started.elapsed());
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let root = first.path.join("mc2-win64-v0.1.3");
        eprintln!(
            "Ready staged fixture initial install complete: {:?}",
            started.elapsed()
        );
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
        eprintln!(
            "Ready staged fixture backup complete: {:?}",
            started.elapsed()
        );
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
        eprintln!(
            "Ready staged fixture successor staged: {:?}",
            started.elapsed()
        );
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        let second = service.activate_staged(ID).unwrap();
        eprintln!(
            "Ready staged fixture successor activated: {:?}",
            started.elapsed()
        );
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
        eprintln!(
            "Ready staged fixture launch preparation complete: {:?}",
            started.elapsed()
        );
        assert_eq!(
            fs::read(library.user_dir(ID).join("options.cfg")).unwrap(),
            b"deliberate successor choice"
        );
        // Preparation returns a specification; no fixture executable is run.
        assert!(!second.path.join(LAUNCH_MARKER).exists());
        let restored = service.rollback(ID).unwrap();
        eprintln!(
            "Ready staged fixture runtime rollback complete: {:?}",
            started.elapsed()
        );
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
        eprintln!(
            "Ready staged fixture unknown-file update refused: {:?}",
            started.elapsed()
        );
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
    async fn prelaunch_preserving_archives_raw_activation_refuses_before_acquisition() {
        for id in [
            "alariq-mc2",
            "crash-team-racing-ctr-native",
            "road-rash-64-recompiled",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let mut document = Catalog::embedded().unwrap().authoritative_document();
            if id == "road-rash-64-recompiled" {
                let port = document
                    .ports
                    .iter_mut()
                    .find(|port| port.id == id)
                    .unwrap();
                port.n64_runtime_at_executable_parent = true;
                port.portable_marker = true;
                if let Some(root) = port.runtime_subdirectory.take() {
                    let prefix = format!("{root}/");
                    port.persistent_paths = port
                        .persistent_paths
                        .iter()
                        .map(|path| path.strip_prefix(&prefix).unwrap().to_owned())
                        .collect();
                }
            }
            let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
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
        fs::write(install.path.join("shot_00001.png"), b"prelaunch capture").unwrap();
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
        assert_eq!(
            fs::read(library.user_dir("portable-fixture").join("shot_00001.png")).unwrap(),
            b"prelaunch capture"
        );
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
            ("shot_00001.png", b"screenshot"),
            ("vram_00001.png", b"VRAM capture"),
        ] {
            let destination = first.path.join(path);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::write(destination, content).unwrap();
        }
        assert!(!first.path.join(LAUNCH_MARKER).exists());
        let backup = service.create_backup("portable-fixture").unwrap();
        for name in ["shot_00001.png", "vram_00001.png"] {
            assert_eq!(
                fs::read(backup.path.join("data").join(name)).unwrap(),
                fs::read(first.path.join(name)).unwrap()
            );
        }
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
            "shot_00001.png",
            "vram_00001.png",
        ] {
            assert_eq!(
                fs::read(first.path.join(path)).unwrap(),
                fs::read(second.path.join(path)).unwrap()
            );
        }
        fs::write(second.path.join("shot_00002.png"), b"current capture").unwrap();
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
        for (name, expected) in [
            ("shot_00001.png", b"screenshot".as_slice()),
            ("vram_00001.png", b"VRAM capture"),
            ("shot_00002.png", b"current capture"),
        ] {
            assert_eq!(fs::read(active.path.join(name)).unwrap(), expected);
            assert_eq!(fs::read(restored.path.join(name)).unwrap(), expected);
        }
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

    fn ready_persistence_catalog(expanded: bool, distinct_baseline: bool) -> Catalog {
        let mut document = serde_json::to_value(catalog().authoritative_document()).unwrap();
        document["ports"][0]["adapter"] = serde_json::json!("staged-source-portable");
        if expanded {
            document["ports"][0]["persistent_paths"]
                .as_array_mut()
                .unwrap()
                .extend([
                    serde_json::json!("campaign.dat"),
                    serde_json::json!("campaign.tmp"),
                ]);
        }
        if distinct_baseline {
            document["ports"][0]["summary"] = serde_json::json!("Successor package fixture");
        }
        let catalog = Catalog::from_json(&document.to_string()).unwrap();
        assert!(crate::persistence::ready_staged_archive(
            catalog.port("portable-fixture").unwrap()
        ));
        catalog
    }

    fn sonic3k_compatibility_fixture(legacy: bool) -> Catalog {
        // Synthetic package with the historical reader selector, not game data.
        let catalog = ready_persistence_catalog(!legacy, !legacy);
        let mut document = serde_json::to_value(catalog.authoritative_document()).unwrap();
        document["ports"][0]["id"] = serde_json::json!("sonic-3-and-knuckles-recomp");
        document["ports"][0]["channels"] = serde_json::json!(["stable"]);
        if legacy {
            document["ports"][0]["release"] = serde_json::json!({
                "provider": "direct-manifest", "direct": { "windows-x86-64": {
                    "version": "v0.5.3", "url": "https://example.invalid/legacy.zip", "size": 1,
                    "sha256": "42ada10579a00d266aa08a833054ea5fea87b64eef67d268b054525fd0f6be99"
                }}
            });
        }
        Catalog::from_json(&document.to_string()).unwrap()
    }

    #[tokio::test]
    async fn sonic3k_expansion_refuses_populated_common_data_and_preserves_legacy_play_contract() {
        const ID: &str = "sonic-3-and-knuckles-recomp";
        for canonical in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let mut service = build_service(library.clone(), provider.clone());
            service.replace_catalog_for_test(sonic3k_compatibility_fixture(true));
            let old = service
                .install(ID, None, None, None, true, |_| {})
                .await
                .unwrap();
            let manifest = fs::read(old.path.join(".portcove-manifest.json")).unwrap();
            let receipt = fs::read(old.path.join(PSX_DATA_RECEIPT)).unwrap();
            let root = if canonical {
                library.user_dir(ID)
            } else {
                old.path.clone()
            };
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("settings.ini"), b"preserve common legacy data").unwrap();
            service.replace_catalog_for_test(sonic3k_compatibility_fixture(false));
            *provider.0.lock().unwrap() = server.release("v2", 2);
            let failure = service
                .update(ID, None, None, false, |_| {})
                .await
                .unwrap_err();
            assert_eq!(
                failure.presentation().presentation_key,
                "portable_data_contract_changed"
            );
            assert_eq!(service.status(ID).unwrap().active.unwrap().id, old.id);
            assert_eq!(
                fs::read(root.join("settings.ini")).unwrap(),
                b"preserve common legacy data"
            );
            assert_eq!(
                fs::read(old.path.join(".portcove-manifest.json")).unwrap(),
                manifest
            );
            assert_eq!(fs::read(old.path.join(PSX_DATA_RECEIPT)).unwrap(), receipt);
            assert!(!root.join("campaign.dat").exists());
            service
                .require_direct_fresh_data(&service.installed_port(&old).unwrap())
                .unwrap();
        }
    }

    #[tokio::test]
    async fn sonic3k_fresh_creation_and_recovery_refuse_unproven_canonical_data() {
        const ID: &str = "sonic-3-and-knuckles-recomp";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v2", 2))));
        let mut service = build_service(library.clone(), provider);
        service.replace_catalog_for_test(sonic3k_compatibility_fixture(false));
        fs::create_dir_all(library.user_dir(ID)).unwrap();
        fs::write(
            library.user_dir(ID).join("settings.ini"),
            b"unknown creating runtime",
        )
        .unwrap();
        assert!(
            service
                .install(ID, None, None, None, true, |_| {})
                .await
                .is_err()
        );
        assert!(library.all_installs().unwrap().is_empty());
        fs::remove_file(library.user_dir(ID).join("settings.ini")).unwrap();
        let staged = service
            .install(ID, None, None, None, false, |_| {})
            .await
            .unwrap();
        // An attacker or interrupted/manual copy cannot acquire creating-runtime
        // authority from a launch marker or a new manifest alone.
        let receipt = staged.path.join(PSX_DATA_RECEIPT);
        if receipt.exists() {
            fs::remove_file(&receipt).unwrap();
        }
        fs::write(staged.path.join(LAUNCH_MARKER), b"").unwrap();
        fs::write(
            library.user_dir(ID).join("settings.ini"),
            b"unknown creating runtime",
        )
        .unwrap();
        assert!(service.prepare_retained_install_data(&staged).is_err());
        assert!(service.activate_staged(ID).is_err());
        assert!(!receipt.exists());
        assert!(!staged.path.join("settings.ini").exists());
        assert_eq!(
            fs::read(library.user_dir(ID).join("settings.ini")).unwrap(),
            b"unknown creating runtime"
        );
        assert!(service.status(ID).unwrap().active.is_none());
    }

    #[tokio::test]
    async fn sonic3k_backup_restore_cannot_initialize_unknown_data_but_retains_established_restore()
    {
        const ID: &str = "sonic-3-and-knuckles-recomp";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v2", 2))));
        let mut service = build_service(library.clone(), provider);
        service.replace_catalog_for_test(sonic3k_compatibility_fixture(false));
        let current = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let port = service.installed_port(&current).unwrap();
        service.restore_user_data_to(&port, &current.path).unwrap();
        let receipt = fs::read(current.path.join(PSX_DATA_RECEIPT)).unwrap();
        fs::create_dir_all(library.user_dir(ID)).unwrap();
        fs::write(
            library.user_dir(ID).join("settings.ini"),
            b"established bytes",
        )
        .unwrap();
        fs::write(current.path.join("settings.ini"), b"established bytes").unwrap();
        let backup = service.create_backup(ID).unwrap();
        fs::write(library.user_dir(ID).join("settings.ini"), b"newer bytes").unwrap();
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
        service
            .restore_backup(ID, &backup.id, &consent.token)
            .unwrap();
        assert_eq!(
            fs::read(current.path.join("settings.ini")).unwrap(),
            b"established bytes"
        );
        assert_eq!(
            fs::read(current.path.join(PSX_DATA_RECEIPT)).unwrap(),
            receipt
        );
        // Remove only the task fixture's initialization authority. The next
        // restore must refuse BEFORE canonical publication or runtime writes.
        fs::remove_file(current.path.join(PSX_DATA_RECEIPT)).unwrap();
        fs::write(
            library.user_dir(ID).join("settings.ini"),
            b"preserve canonical",
        )
        .unwrap();
        fs::write(current.path.join("settings.ini"), b"preserve runtime").unwrap();
        assert!(
            service
                .require_psx_restore_preflight(ID, &backup.path.join("data"))
                .is_err()
        );
        assert!(service.synchronize_restored_user_data(ID).is_err());
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
        assert!(
            service
                .restore_backup(ID, &backup.id, &consent.token)
                .is_err()
        );
        assert_eq!(
            fs::read(library.user_dir(ID).join("settings.ini")).unwrap(),
            b"preserve canonical"
        );
        assert_eq!(
            fs::read(current.path.join("settings.ini")).unwrap(),
            b"preserve runtime"
        );
        assert!(!current.path.join(PSX_DATA_RECEIPT).exists());
    }

    #[tokio::test]
    async fn empty_ready_persistence_expansion_preserves_preplay_data_and_committed_recovery() {
        const ID: &str = "portable-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider.clone());
        let original_catalog = crate::test_fixture::admitted_indexed_catalog(
            &ready_persistence_catalog(false, false),
            ID,
        );
        let expanded_catalog = crate::test_fixture::admitted_indexed_catalog(
            &ready_persistence_catalog(true, true),
            ID,
        );
        crate::definition_candidate::selection::trust_catalog_selection_for_test(
            &library,
            &original_catalog,
            ID,
        );
        service.replace_catalog_for_test(original_catalog.clone());
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let manifest = fs::read(first.path.join(".portcove-manifest.json")).unwrap();
        let receipt = fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap();
        fs::write(first.path.join("settings.ini"), b"before first Play").unwrap();
        crate::definition_candidate::selection::trust_catalog_selection_for_test(
            &library,
            &expanded_catalog,
            ID,
        );
        library
            .restore_retained_definition_admission(
                original_catalog.definition_selection(ID).unwrap(),
                original_catalog.definition_snapshot(ID).unwrap(),
                "previous",
            )
            .unwrap();
        service.replace_catalog_for_test(expanded_catalog.clone());
        *provider.0.lock().unwrap() = server.release("v2", 2);
        let staged = service.update(ID, None, None, false, |_| {}).await.unwrap();
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        fs::write(first.path.join("settings.ini"), b"latest after staging").unwrap();
        struct Interrupt;
        impl LifecycleFaultInjector for Interrupt {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == LifecycleFaultPoint::ActivationMetadataCommitted {
                    Err(PortcoveError::state(
                        "fixture interruption after committed expansion",
                    ))
                } else {
                    Ok(())
                }
            }
        }
        service.faults = Arc::new(Interrupt);
        assert!(service.activate_staged(ID).is_err());
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, staged.id);
        fs::write(staged.path.join("campaign.dat"), b"newly owned progress").unwrap();
        service.faults = Arc::new(NoLifecycleFaults);
        service.recover_pending_operations().unwrap();
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, staged.id);
        assert_eq!(
            fs::read(staged.path.join("settings.ini")).unwrap(),
            b"latest after staging"
        );
        assert_eq!(
            fs::read(staged.path.join("campaign.dat")).unwrap(),
            b"newly owned progress"
        );
        assert_eq!(
            fs::read(first.path.join(".portcove-manifest.json")).unwrap(),
            manifest
        );
        assert_eq!(
            fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap(),
            receipt
        );
        assert!(!first.path.join("campaign.dat").exists());
        assert_eq!(
            service
                .installed_port(&first)
                .unwrap()
                .persistent_paths
                .len(),
            4
        );
        assert_eq!(
            service
                .installed_port(&staged)
                .unwrap()
                .persistent_paths
                .len(),
            6
        );
        let backup = service.create_backup(ID).unwrap();
        assert_eq!(
            fs::read(backup.path.join("data/campaign.dat")).unwrap(),
            b"newly owned progress"
        );
        assert!(service.rollback(ID).is_err());
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, staged.id);
        fs::write(staged.path.join("campaign.dat"), b"later runtime progress").unwrap();
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
        struct RestoreInterrupt;
        impl LifecycleFaultInjector for RestoreInterrupt {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == LifecycleFaultPoint::RestoreVersionSynchronized {
                    Err(PortcoveError::state(
                        "fixture interruption during retained-version data sync",
                    ))
                } else {
                    Ok(())
                }
            }
        }
        service.faults = Arc::new(RestoreInterrupt);
        assert!(
            service
                .restore_backup(ID, &backup.id, &consent.token)
                .is_err()
        );
        service = build_service(library.clone(), provider.clone());
        service.replace_catalog_for_test(expanded_catalog.clone());
        service.recover_pending_operations().unwrap();
        assert_eq!(
            fs::read(staged.path.join("campaign.dat")).unwrap(),
            b"newly owned progress"
        );
        assert_eq!(
            fs::read(library.user_dir(ID).join("campaign.dat")).unwrap(),
            b"newly owned progress"
        );
        assert!(!first.path.join("campaign.dat").exists());
        assert_eq!(
            fs::read(first.path.join(".portcove-manifest.json")).unwrap(),
            manifest
        );
        assert_eq!(
            fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap(),
            receipt
        );
        // A future otherwise-identical catalog must hold inactive scope expansion.
        service.replace_catalog_for_test(ready_persistence_catalog(true, false));
        let refusal = service
            .preview_backup_action(ID, &backup.id, crate::BackupAction::Restore)
            .unwrap_err();
        assert_eq!(refusal.code, crate::ErrorCode::Conflict);
        assert_eq!(refusal.details.get("install_id"), Some(&first.id));
        assert_eq!(
            fs::read(library.user_dir(ID).join("campaign.dat")).unwrap(),
            b"newly owned progress"
        );
        assert!(!first.path.join("campaign.dat").exists());
        // Historical transfer authority works without adopting the widened live scope.
        service.replace_catalog_for_test(expanded_catalog);
        for (install, role) in [(&first, "previous"), (&staged, "active")] {
            let retained = service.installed_catalog(install).unwrap();
            assert_eq!(
                library
                    .retained_definition_admission_role(retained.definition_selection(ID).unwrap(),)
                    .unwrap(),
                Some(role)
            );
        }
        let metadata = temporary.path().join("export.json");
        service.write_library_metadata(&metadata).unwrap();
        let imported = temporary.path().join("imported");
        let plan =
            PortcoveService::plan_library_import(&metadata, library.root(), &imported).unwrap();
        assert!(
            PortcoveService::import_library(
                &metadata,
                library.root(),
                &imported,
                &plan.plan_sha256
            )
            .unwrap()
            .completed
        );
        let imported_library = Library::open(&imported).unwrap();
        let imported_service =
            PortcoveService::with_provider(imported_library.clone(), provider).unwrap();
        let imported_first = imported_library
            .all_installs()
            .unwrap()
            .into_iter()
            .find(|i| i.id == first.id)
            .unwrap();
        let imported_active = imported_library
            .status(ID, ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap();
        assert_eq!(
            imported_service
                .installed_port(&imported_first)
                .unwrap()
                .persistent_paths
                .len(),
            4
        );
        assert_eq!(
            imported_service
                .installed_port(&imported_active)
                .unwrap()
                .persistent_paths
                .len(),
            6
        );
        assert!(!imported_first.path.join("campaign.dat").exists());
        assert_eq!(
            fs::read(imported_active.path.join("campaign.dat")).unwrap(),
            b"newly owned progress"
        );
    }

    #[tokio::test]
    async fn empty_retained_scope_roundtrip_preserves_current_data_and_transfer_authority() {
        const ID: &str = "portable-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider.clone());
        let original_catalog = crate::test_fixture::admitted_indexed_catalog(
            &ready_persistence_catalog(false, false),
            ID,
        );
        let expanded_catalog = crate::test_fixture::admitted_indexed_catalog(
            &ready_persistence_catalog(true, true),
            ID,
        );
        crate::definition_candidate::selection::trust_catalog_selection_for_test(
            &library,
            &original_catalog,
            ID,
        );
        service.replace_catalog_for_test(original_catalog.clone());
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        crate::definition_candidate::selection::trust_catalog_selection_for_test(
            &library,
            &expanded_catalog,
            ID,
        );
        library
            .restore_retained_definition_admission(
                original_catalog.definition_selection(ID).unwrap(),
                original_catalog.definition_snapshot(ID).unwrap(),
                "previous",
            )
            .unwrap();
        service.replace_catalog_for_test(expanded_catalog.clone());
        *provider.0.lock().unwrap() = server.release("v2", 2);
        let second = service.update(ID, None, None, true, |_| {}).await.unwrap();
        let retained = [&first, &second].map(|install| {
            (
                fs::read(install.path.join(".portcove-manifest.json")).unwrap(),
                fs::read(install.path.join(PSX_DATA_RECEIPT)).unwrap(),
            )
        });
        fs::write(
            second.path.join("settings.ini"),
            b"latest before first Play",
        )
        .unwrap();
        assert!(!second.path.join(LAUNCH_MARKER).exists());
        let status = service.status(ID).unwrap();
        assert_eq!(
            status
                .port_actions
                .iter()
                .find(|a| a.action == PortAction::Rollback)
                .unwrap()
                .availability,
            PortActionAvailability::Allowed
        );
        assert_eq!(service.rollback(ID).unwrap().id, first.id);
        assert_eq!(
            fs::read(first.path.join("settings.ini")).unwrap(),
            b"latest before first Play"
        );
        fs::write(first.path.join(LAUNCH_MARKER), b"1").unwrap();
        fs::write(
            first.path.join("settings.ini"),
            b"current older-copy choice",
        )
        .unwrap();
        assert_eq!(service.rollback(ID).unwrap().id, second.id);
        assert_eq!(
            fs::read(second.path.join("settings.ini")).unwrap(),
            b"current older-copy choice"
        );
        assert_eq!(service.rollback(ID).unwrap().id, first.id);
        let backup = service.create_backup(ID).unwrap();
        fs::write(first.path.join("settings.ini"), b"newer than backup").unwrap();
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
        struct Interrupt;
        impl LifecycleFaultInjector for Interrupt {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == LifecycleFaultPoint::RestoreVersionSynchronized {
                    Err(PortcoveError::state(
                        "fixture interruption after retained-scope rollback",
                    ))
                } else {
                    Ok(())
                }
            }
        }
        service.faults = Arc::new(Interrupt);
        assert!(
            service
                .restore_backup(ID, &backup.id, &consent.token)
                .is_err()
        );
        service = build_service(library.clone(), provider.clone());
        service.replace_catalog_for_test(expanded_catalog.clone());
        service.recover_pending_operations().unwrap();
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        assert_eq!(
            fs::read(first.path.join("settings.ini")).unwrap(),
            b"current older-copy choice"
        );
        for (install, (manifest, receipt)) in [&first, &second].into_iter().zip(&retained) {
            assert_eq!(
                fs::read(install.path.join(".portcove-manifest.json")).unwrap(),
                *manifest
            );
            assert_eq!(
                fs::read(install.path.join(PSX_DATA_RECEIPT)).unwrap(),
                *receipt
            );
            assert!(!install.path.join("campaign.dat").exists());
        }
        let metadata = temporary.path().join("export.json");
        service.write_library_metadata(&metadata).unwrap();
        let imported = temporary.path().join("imported");
        let plan =
            PortcoveService::plan_library_import(&metadata, library.root(), &imported).unwrap();
        assert!(
            PortcoveService::import_library(
                &metadata,
                library.root(),
                &imported,
                &plan.plan_sha256,
            )
            .unwrap()
            .completed
        );
        let imported_library = Library::open(&imported).unwrap();
        let mut imported_service = build_service(imported_library.clone(), provider);
        imported_service.replace_catalog_for_test(expanded_catalog);
        assert_eq!(imported_service.rollback(ID).unwrap().id, second.id);
        let active = imported_library
            .status(ID, ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap();
        assert_eq!(
            fs::read(active.path.join("settings.ini")).unwrap(),
            b"current older-copy choice"
        );
        assert!(!imported_library.user_dir(ID).join("campaign.dat").exists());
        assert_eq!(
            imported_service
                .installed_port(&active)
                .unwrap()
                .persistent_paths
                .len(),
            6
        );
        let old = imported_library
            .all_installs()
            .unwrap()
            .into_iter()
            .find(|i| i.id == first.id)
            .unwrap();
        assert_eq!(
            imported_service
                .installed_port(&old)
                .unwrap()
                .persistent_paths
                .len(),
            4
        );
    }

    #[tokio::test]
    async fn empty_retained_scope_switch_rechecks_each_actual_root_after_preview() {
        const ID: &str = "portable-fixture";
        for larger_active in [true, false] {
            for location in ["active", "canonical", "target"] {
                let temporary = tempfile::tempdir().unwrap();
                let library = Library::open(temporary.path().join("library")).unwrap();
                let server = Server::new();
                let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
                let mut service = build_service(library.clone(), provider.clone());
                service.replace_catalog_for_test(ready_persistence_catalog(false, false));
                service
                    .install(ID, None, None, None, true, |_| {})
                    .await
                    .unwrap();
                service.replace_catalog_for_test(ready_persistence_catalog(true, true));
                *provider.0.lock().unwrap() = server.release("v2", 2);
                service.update(ID, None, None, true, |_| {}).await.unwrap();
                if !larger_active {
                    service.rollback(ID).unwrap();
                }
                let status = service.status(ID).unwrap();
                assert_eq!(
                    status
                        .port_actions
                        .iter()
                        .find(|a| a.action == PortAction::Rollback)
                        .unwrap()
                        .availability,
                    PortActionAvailability::Allowed
                );
                let active = status.active.unwrap();
                let target = status.previous.unwrap();
                let root = match location {
                    "active" => active.path.clone(),
                    "canonical" => library.user_dir(ID),
                    _ => target.path.clone(),
                };
                fs::create_dir_all(&root).unwrap();
                fs::write(root.join("campaign.dat"), b"preserve after preview").unwrap();
                fs::write(
                    active.path.join("settings.ini"),
                    b"do not collect on refusal",
                )
                .unwrap();
                let canonical_before = fs::read(library.user_dir(ID).join("settings.ini")).ok();
                let before = crate::test_fixture::library_file_snapshot(&library);
                let held = service.status(ID).unwrap();
                assert_eq!(
                    held.port_actions
                        .iter()
                        .find(|a| a.action == PortAction::Rollback)
                        .unwrap()
                        .availability,
                    PortActionAvailability::Held
                );
                assert_eq!(crate::test_fixture::library_file_snapshot(&library), before);
                assert!(service.rollback(ID).is_err(), "{larger_active} {location}");
                assert_eq!(
                    library
                        .status(ID, ReleaseChannel::Stable)
                        .unwrap()
                        .active
                        .unwrap()
                        .id,
                    active.id
                );
                assert_eq!(
                    fs::read(root.join("campaign.dat")).unwrap(),
                    b"preserve after preview"
                );
                assert_eq!(
                    fs::read(library.user_dir(ID).join("settings.ini")).ok(),
                    canonical_before
                );
            }
        }
    }

    #[tokio::test]
    async fn empty_retained_scope_rollback_preserves_authority_and_alias_refusals() {
        const ID: &str = "portable-fixture";
        for case in [
            "empty-directory",
            "case-alias",
            "active-manifest",
            "target-manifest",
            "target-runtime",
            "target-companion",
            "missing-target-authority",
            "inactive-scope",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let mut service = build_service(library.clone(), provider.clone());
            service.replace_catalog_for_test(ready_persistence_catalog(false, false));
            let mut first = service
                .install(ID, None, None, None, true, |_| {})
                .await
                .unwrap();
            service.replace_catalog_for_test(ready_persistence_catalog(true, true));
            *provider.0.lock().unwrap() = server.release("v2", 2);
            let second = service.update(ID, None, None, true, |_| {}).await.unwrap();
            assert_eq!(
                service
                    .status(ID)
                    .unwrap()
                    .port_actions
                    .iter()
                    .find(|a| a.action == PortAction::Rollback)
                    .unwrap()
                    .availability,
                PortActionAvailability::Allowed,
                "baseline before {case}",
            );
            fs::write(
                second.path.join("settings.ini"),
                b"preserve uncollected choice",
            )
            .unwrap();
            match case {
                "empty-directory" => fs::create_dir(second.path.join("campaign.dat")).unwrap(),
                "case-alias" => fs::write(second.path.join("Campaign.dat"), b"case alias").unwrap(),
                "active-manifest" => {
                    fs::write(second.path.join(".portcove-manifest.json"), b"tampered").unwrap()
                }
                "target-manifest" => {
                    fs::write(first.path.join(".portcove-manifest.json"), b"tampered").unwrap()
                }
                "target-runtime" => {
                    fs::write(first.path.join("game.exe"), b"changed executable").unwrap()
                }
                "target-companion" => {
                    fs::write(first.path.join("package.txt"), b"changed package member").unwrap()
                }
                "missing-target-authority" => {
                    let manifest = first.path.join(".portcove-manifest.json");
                    let mut value: serde_json::Value =
                        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
                    assert!(
                        value
                            .as_object_mut()
                            .unwrap()
                            .remove("retained_contract")
                            .is_some()
                    );
                    value["schema_version"] = serde_json::json!(5);
                    let bytes = serde_json::to_vec(&value).unwrap();
                    fs::write(&manifest, &bytes).unwrap();
                    first.manifest_sha256 = hex::encode(Sha256::digest(&bytes));
                    library.update_install_manifest(&first).unwrap();
                    fs::write(
                        first.path.join(PSX_DATA_RECEIPT),
                        serde_json::to_vec(&serde_json::json!({"schema_version":1,"port_id":ID,
                            "install_id":first.id,"manifest_sha256":first.manifest_sha256}))
                        .unwrap(),
                    )
                    .unwrap();
                    assert!(
                        Installer::new(library.clone())
                            .unwrap()
                            .retained_catalog(&first)
                            .unwrap()
                            .is_none()
                    );
                    service.replace_catalog_for_test(ready_persistence_catalog(false, false));
                }
                _ => service.replace_catalog_for_test(ready_persistence_catalog(true, false)),
            }
            let before = fs::read(library.user_dir(ID).join("settings.ini")).ok();
            let receipts =
                [&first, &second].map(|i| fs::read(i.path.join(PSX_DATA_RECEIPT)).unwrap());
            assert!(service.rollback(ID).is_err(), "{case}");
            assert_eq!(
                library
                    .status(ID, ReleaseChannel::Stable)
                    .unwrap()
                    .active
                    .unwrap()
                    .id,
                second.id
            );
            assert_eq!(
                fs::read(second.path.join("settings.ini")).unwrap(),
                b"preserve uncollected choice"
            );
            assert_eq!(
                fs::read(library.user_dir(ID).join("settings.ini")).ok(),
                before
            );
            for (install, receipt) in [&first, &second].into_iter().zip(&receipts) {
                assert_eq!(
                    fs::read(install.path.join(PSX_DATA_RECEIPT)).unwrap(),
                    *receipt
                );
            }
        }
    }

    #[tokio::test]
    async fn receipt_governed_additive_projection_refuses_before_canonical_mutation() {
        const ID: &str = "portable-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider);
        service.replace_catalog_for_test(ready_persistence_catalog(false, false));
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let receipt = fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap();
        fs::write(first.path.join(LAUNCH_MARKER), b"1").unwrap();
        fs::create_dir_all(library.user_dir(ID)).unwrap();
        fs::write(
            library.user_dir(ID).join("campaign.dat"),
            b"canonical-only progress",
        )
        .unwrap();
        service.replace_catalog_for_test(ready_persistence_catalog(true, false));
        assert_eq!(
            service
                .installed_mutability_port(&first)
                .unwrap()
                .persistent_paths
                .len(),
            6
        );
        let failure = service
            .collect_user_data_from_install(ID, &first.path)
            .unwrap_err();
        assert_eq!(
            failure.presentation().presentation_key,
            "portable_data_contract_changed"
        );
        assert_eq!(
            fs::read(library.user_dir(ID).join("campaign.dat")).unwrap(),
            b"canonical-only progress"
        );
        assert_eq!(
            fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap(),
            receipt
        );
        assert!(!first.path.join("campaign.dat").exists());
        assert!(
            service
                .require_psx_restore_preflight(ID, &library.user_dir(ID))
                .is_err()
        );
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
    }

    #[tokio::test]
    async fn staged_empty_expansion_rechecks_each_data_root_and_pending_recovery() {
        const ID: &str = "portable-fixture";
        for location in ["active", "canonical", "staged"] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let mut service = build_service(library.clone(), provider.clone());
            service.replace_catalog_for_test(ready_persistence_catalog(false, false));
            let first = service
                .install(ID, None, None, None, true, |_| {})
                .await
                .unwrap();
            service.replace_catalog_for_test(ready_persistence_catalog(true, true));
            *provider.0.lock().unwrap() = server.release("v2", 2);
            let staged = service.update(ID, None, None, false, |_| {}).await.unwrap();
            let root = match location {
                "active" => first.path.clone(),
                "canonical" => library.user_dir(ID),
                _ => staged.path.clone(),
            };
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("campaign.dat"), b"preserve post-stage addition").unwrap();
            assert!(
                service.update(ID, None, None, false, |_| {}).await.is_err(),
                "stage-only retry: {location}"
            );
            assert!(service.activate_staged(ID).is_err(), "{location}");
            assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
            assert_eq!(
                fs::read(root.join("campaign.dat")).unwrap(),
                b"preserve post-stage addition"
            );
            let mut operation = LifecycleOperation::new(
                Uuid::new_v4().to_string(),
                LifecycleOperationKind::Activate,
                ID,
            );
            operation.install = Some(staged.clone());
            let store = OperationStore::new(library.clone());
            store.put(&mut operation).unwrap();
            assert!(
                crate::recovery::recover_activation(&service, &store, &mut operation).is_err(),
                "{location}"
            );
            assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
            assert_eq!(service.status(ID).unwrap().staged.unwrap().id, staged.id);
            assert_eq!(
                fs::read(root.join("campaign.dat")).unwrap(),
                b"preserve post-stage addition"
            );
            assert!(!store.all().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn empty_expansion_refuses_existing_canonical_data_and_immutable_members() {
        const ID: &str = "portable-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider.clone());
        service.replace_catalog_for_test(ready_persistence_catalog(false, false));
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let receipt = fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap();
        service.replace_catalog_for_test(ready_persistence_catalog(true, true));
        *provider.0.lock().unwrap() = server.release("v2", 2);
        fs::create_dir_all(library.user_dir(ID)).unwrap();
        fs::write(library.user_dir(ID).join("campaign.dat"), []).unwrap();
        let failure = service
            .update(ID, None, None, false, |_| {})
            .await
            .unwrap_err();
        assert_eq!(
            failure.presentation().presentation_key,
            "portable_data_contract_changed"
        );
        assert_eq!(
            fs::read(library.user_dir(ID).join("campaign.dat")).unwrap(),
            b""
        );
        assert_eq!(
            fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap(),
            receipt
        );
        assert_eq!(library.all_installs().unwrap().len(), 1);
        fs::remove_file(library.user_dir(ID).join("campaign.dat")).unwrap();
        let mut to = service.catalog.port(ID).unwrap().clone();
        to.persistent_paths.push("game.exe".into());
        // Missing packaged bytes must not turn their names into adoptable data.
        fs::remove_file(first.path.join("game.exe")).unwrap();
        assert!(service.require_portable_transition(&first, &to).is_err());
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
    }

    #[tokio::test]
    async fn empty_expansion_and_data_sync_refuse_missing_active_or_inactive_authority() {
        const ID: &str = "portable-fixture";
        for active in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let mut service = build_service(library.clone(), provider.clone());
            service.replace_catalog_for_test(ready_persistence_catalog(false, false));
            let mut first = service
                .install(ID, None, None, None, active, |_| {})
                .await
                .unwrap();
            let old_port = service.installed_port(&first).unwrap();
            service
                .restore_user_data_to(&old_port, &first.path)
                .unwrap();
            let manifest = first.path.join(".portcove-manifest.json");
            let mut value: serde_json::Value =
                serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
            assert!(
                value
                    .as_object_mut()
                    .unwrap()
                    .remove("retained_contract")
                    .is_some()
            );
            // A supported pre-contract envelope, not a malformed format-6 document.
            value["schema_version"] = serde_json::json!(5);
            let bytes = serde_json::to_vec(&value).unwrap();
            fs::write(&manifest, &bytes).unwrap();
            first.manifest_sha256 = hex::encode(Sha256::digest(&bytes));
            library.update_install_manifest(&first).unwrap();
            assert!(
                Installer::new(library.clone())
                    .unwrap()
                    .retained_catalog(&first)
                    .unwrap()
                    .is_none()
            );
            let receipt = serde_json::to_vec(&serde_json::json!({
                "schema_version":1,"port_id":ID,"install_id":first.id,
                "manifest_sha256":first.manifest_sha256
            }))
            .unwrap();
            fs::write(first.path.join(PSX_DATA_RECEIPT), &receipt).unwrap();
            service.replace_catalog_for_test(ready_persistence_catalog(true, true));
            fs::create_dir_all(library.user_dir(ID)).unwrap();
            fs::write(
                library.user_dir(ID).join("campaign.dat"),
                b"preserve unknown-scope data",
            )
            .unwrap();
            let to = service.catalog.port(ID).unwrap().clone();
            assert!(
                service
                    .require_empty_persistence_expansion(&first, &to, None)
                    .is_err()
            );
            assert!(
                service
                    .collect_user_data_from_install(ID, &first.path)
                    .is_err()
            );
            assert!(
                service
                    .require_psx_restore_preflight(ID, &library.user_dir(ID))
                    .is_err()
            );
            if !active {
                // An independent fresh copy can exist, but cannot authorize that old copy.
                *provider.0.lock().unwrap() = server.release("v2", 2);
                let current = service
                    .install(ID, None, None, None, true, |_| {})
                    .await
                    .unwrap();
                let mut next = service.installed_port(&current).unwrap();
                next.persistent_paths.push("future.dat".into());
                assert!(
                    service
                        .require_portable_transition(&current, &next)
                        .is_err()
                );
            }
            assert_eq!(
                fs::read(library.user_dir(ID).join("campaign.dat")).unwrap(),
                b"preserve unknown-scope data"
            );
            assert!(!first.path.join("campaign.dat").exists());
            assert_eq!(fs::read(&manifest).unwrap(), bytes);
            assert_eq!(
                fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap(),
                receipt
            );
        }
    }

    #[tokio::test]
    async fn empty_expansion_checks_the_actual_reused_target_before_data_restoration() {
        const ID: &str = "portable-fixture";
        for populated in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let release = server.release("v2", 2);
            let provider = Arc::new(Provider(Mutex::new(release.clone())));
            let mut service = build_service(library.clone(), provider.clone());
            service.replace_catalog_for_test(ready_persistence_catalog(true, true));
            let target = service
                .install(ID, None, None, None, false, |_| {})
                .await
                .unwrap();
            let target_port = service.installed_port(&target).unwrap();
            service
                .restore_user_data_to(&target_port, &target.path)
                .unwrap();
            let receipt = fs::read(target.path.join(PSX_DATA_RECEIPT)).unwrap();
            service.replace_catalog_for_test(ready_persistence_catalog(false, false));
            *provider.0.lock().unwrap() = server.release("v1", 1);
            let active = service
                .install(ID, None, None, None, true, |_| {})
                .await
                .unwrap();
            fs::write(active.path.join("settings.ini"), b"latest active settings").unwrap();
            if populated {
                fs::write(
                    target.path.join("campaign.dat"),
                    b"preserve retained target edit",
                )
                .unwrap();
            }
            service.replace_catalog_for_test(ready_persistence_catalog(true, true));
            *provider.0.lock().unwrap() = release;
            let result = service.install(ID, None, None, None, true, |_| {}).await;
            if populated {
                assert!(result.is_err());
                assert_eq!(service.status(ID).unwrap().active.unwrap().id, active.id);
                assert_eq!(
                    fs::read(target.path.join("campaign.dat")).unwrap(),
                    b"preserve retained target edit"
                );
                assert_eq!(
                    fs::read(target.path.join(PSX_DATA_RECEIPT)).unwrap(),
                    receipt
                );
                assert!(!library.user_dir(ID).join("campaign.dat").exists());
            } else {
                assert_eq!(result.unwrap().id, target.id);
                assert_eq!(service.status(ID).unwrap().active.unwrap().id, target.id);
                assert_eq!(
                    fs::read(target.path.join("settings.ini")).unwrap(),
                    b"latest active settings"
                );
            }
        }
    }

    #[tokio::test]
    async fn fresh_empty_expansion_refusal_retains_published_stage_and_rejects_retry() {
        const ID: &str = "portable-fixture";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider.clone());
        service.replace_catalog_for_test(ready_persistence_catalog(false, false));
        let first = service
            .install(ID, None, None, None, true, |_| {})
            .await
            .unwrap();
        let manifest = fs::read(first.path.join(".portcove-manifest.json")).unwrap();
        let receipt = fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap();
        fs::write(first.path.join("settings.ini"), b"preserve current choice").unwrap();
        service.replace_catalog_for_test(ready_persistence_catalog(true, true));
        let mut release = server.release("v2", 2);
        {
            let mut content = server.bytes.lock().unwrap();
            let mut zip =
                zip::ZipWriter::new_append(std::io::Cursor::new(content.clone())).unwrap();
            zip.start_file("campaign.dat", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"authenticated package default").unwrap();
            *content = zip.finish().unwrap().into_inner();
            release.asset.size = content.len() as u64;
            release.asset.sha256 = hex::encode(Sha256::digest(&*content));
        }
        *provider.0.lock().unwrap() = release;
        let failure = service
            .update(ID, None, None, false, |_| {})
            .await
            .unwrap_err();
        assert_eq!(
            failure.presentation().presentation_key,
            "portable_data_contract_changed"
        );
        let state = service.status(ID).unwrap();
        let staged = state.staged.unwrap();
        assert_eq!(failure.details["staged_install_id"], staged.id);
        assert_eq!(state.active.unwrap().id, first.id);
        assert_eq!(
            service
                .installed_port(&staged)
                .unwrap()
                .persistent_paths
                .len(),
            6
        );
        assert_eq!(
            fs::read(staged.path.join("campaign.dat")).unwrap(),
            b"authenticated package default"
        );
        assert!(!first.path.join("campaign.dat").exists());
        assert!(!library.user_dir(ID).join("campaign.dat").exists());
        assert_eq!(
            fs::read(first.path.join("settings.ini")).unwrap(),
            b"preserve current choice"
        );
        assert_eq!(
            fs::read(first.path.join(".portcove-manifest.json")).unwrap(),
            manifest
        );
        assert_eq!(
            fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap(),
            receipt
        );
        assert!(service.update(ID, None, None, false, |_| {}).await.is_err());
        assert!(service.activate_staged(ID).is_err());
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
        assert_eq!(service.status(ID).unwrap().staged.unwrap().id, staged.id);
        assert_eq!(
            fs::read(staged.path.join("campaign.dat")).unwrap(),
            b"authenticated package default"
        );
    }

    #[tokio::test]
    async fn native_publication_recovery_preserves_retained_contracts_and_current_data() {
        for case in [
            "compatible",
            "data",
            "executable",
            "environment",
            "active-bytes",
            "target-bytes",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let server = Server::new();
            let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
            let mut service = build_service(library.clone(), provider);
            let first = service
                .install("portable-fixture", None, None, None, true, |_| {})
                .await
                .unwrap();
            let mut document = service.catalog.authoritative_document().clone();
            let port = &mut document.ports[0];
            match case {
                "data" => port.persistent_paths = vec!["other.ini".into()],
                "executable" => {
                    port.executable_hints
                        .insert(Platform::WindowsX86_64, vec!["other.exe".into()]);
                }
                "environment" => {
                    port.launch_environment
                        .insert("PROFILE".into(), "another".into());
                }
                _ => {}
            }
            service.replace_catalog_for_test(
                Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
            );
            let target = Installer::new(library.clone())
                .unwrap()
                .install(
                    InstallRequest {
                        port_id: "portable-fixture".into(),
                        release: server.release_in_folder(
                            "v2",
                            2,
                            "",
                            if case == "executable" {
                                "other.exe"
                            } else {
                                "game.exe"
                            },
                        ),
                        output_root: library.versions_dir().join("portable-fixture"),
                        activate: false,
                        managed: None,
                        qualification: InstallQualification::from_catalog(
                            &service.catalog,
                            "portable-fixture",
                            Platform::WindowsX86_64,
                        )
                        .unwrap(),
                    },
                    &OperationCoordinator::new("native-recovery-target", None),
                    |_| {},
                )
                .await
                .unwrap();
            // A historical journal can still request immediate activation.
            let id = Uuid::new_v4().to_string();
            let mut journal =
                LifecycleOperation::new(&id, LifecycleOperationKind::Install, "portable-fixture");
            journal.install = Some(target.clone());
            journal.activate = true;
            journal.phase = LifecyclePhase::PayloadPublished;
            journal.paths.staging = Some(library.staging_dir().join(&id));
            journal.paths.final_path = Some(target.path.clone());
            fs::create_dir_all(journal.paths.staging.as_ref().unwrap()).unwrap();
            let store = OperationStore::new(library.clone());
            store.put(&mut journal).unwrap();
            fs::write(first.path.join("settings.ini"), b"edited after staging").unwrap();
            let canonical = library.user_dir("portable-fixture").join("settings.ini");
            fs::create_dir_all(canonical.parent().unwrap()).unwrap();
            fs::write(&canonical, b"previous canonical").unwrap();
            if case == "active-bytes" {
                fs::write(first.path.join("game.exe"), b"modified active").unwrap();
            }
            if case == "target-bytes" {
                fs::write(target.path.join("game.exe"), b"modified target").unwrap();
            }
            let manifest = fs::read(target.path.join(".portcove-manifest.json")).unwrap();
            let result = crate::recovery::recover_published_install(&service, &store, &mut journal);
            let active = service.status("portable-fixture").unwrap().active.unwrap();
            if case == "compatible" {
                result.unwrap();
                assert_eq!(active.id, target.id);
                assert_eq!(
                    fs::read(target.path.join("settings.ini")).unwrap(),
                    b"edited after staging"
                );
                assert_eq!(fs::read(&canonical).unwrap(), b"edited after staging");
                assert!(store.get(&id).unwrap().is_none());
                crate::recovery::recover_published_install(&service, &store, &mut journal).unwrap();
            } else {
                assert!(result.is_err(), "{case}");
                assert_eq!(active.id, first.id, "{case}");
                assert_eq!(
                    fs::read(&canonical).unwrap(),
                    b"previous canonical",
                    "{case}"
                );
                assert!(!target.path.join("settings.ini").exists(), "{case}");
                assert!(store.get(&id).unwrap().is_some(), "{case}");
            }
            assert_eq!(
                fs::read(first.path.join("settings.ini")).unwrap(),
                b"edited after staging",
                "{case}"
            );
            assert_eq!(
                fs::read(target.path.join(".portcove-manifest.json")).unwrap(),
                manifest,
                "{case}"
            );
            assert!(first.path.is_dir() && target.path.is_dir());
        }
    }

    async fn installs_with_retained_scopes(
        service: &mut PortcoveService,
        library: &Library,
        server: &Server,
        provider: &Provider,
        expand: bool,
    ) -> (InstallRecord, InstallRecord, ResolvedRelease) {
        let first_release = provider.0.lock().unwrap().clone();
        let first = service
            .install("portable-fixture", None, None, None, false, |_| {})
            .await
            .unwrap();
        let mut document = serde_json::to_value(catalog().authoritative_document()).unwrap();
        // Provider/presentation changes must not reinterpret the old receipt.
        document["ports"][0]["summary"] = serde_json::json!("Second package fixture");
        if expand {
            document["ports"][0]["persistent_paths"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!("campaign.dat"));
        }
        service.replace_catalog_for_test(Catalog::from_json(&document.to_string()).unwrap());
        *provider.0.lock().unwrap() = server.release("v2", 2);
        let second = service
            .install("portable-fixture", None, None, None, true, |_| {})
            .await
            .unwrap();
        assert!(
            library
                .install_by_artifact("portable-fixture", &first.artifact.sha256, None)
                .unwrap()
                .is_some()
        );
        fs::create_dir_all(library.user_dir("portable-fixture")).unwrap();
        (first, second, first_release)
    }

    #[tokio::test]
    async fn artifact_reuse_checks_the_actual_retained_data_contract_before_collection() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider.clone());
        let (first, second, first_release) =
            installs_with_retained_scopes(&mut service, &library, &server, &provider, true).await;
        let manifest = fs::read(first.path.join(".portcove-manifest.json")).unwrap();
        let receipt = first.path.join(PSX_DATA_RECEIPT);
        assert!(!receipt.try_exists().unwrap());
        fs::write(
            second.path.join("campaign.dat"),
            b"current runtime campaign",
        )
        .unwrap();
        fs::write(
            library.user_dir("portable-fixture").join("campaign.dat"),
            b"canonical campaign",
        )
        .unwrap();
        *provider.0.lock().unwrap() = first_release;
        let failure = service
            .install("portable-fixture", None, None, None, true, |_| {})
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
        assert_eq!(
            fs::read(second.path.join("campaign.dat")).unwrap(),
            b"current runtime campaign"
        );
        assert_eq!(
            fs::read(library.user_dir("portable-fixture").join("campaign.dat")).unwrap(),
            b"canonical campaign"
        );
        assert_eq!(
            fs::read(first.path.join(".portcove-manifest.json")).unwrap(),
            manifest
        );
        assert!(!receipt.try_exists().unwrap());
        assert!(!first.path.join("campaign.dat").exists());
    }

    #[tokio::test]
    async fn pending_activation_recovery_checks_the_actual_retained_data_contract() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider.clone());
        let (first, second, _) =
            installs_with_retained_scopes(&mut service, &library, &server, &provider, true).await;
        let manifest = fs::read(first.path.join(".portcove-manifest.json")).unwrap();
        let receipt = first.path.join(PSX_DATA_RECEIPT);
        assert!(!receipt.try_exists().unwrap());
        fs::write(
            second.path.join("campaign.dat"),
            b"current runtime campaign",
        )
        .unwrap();
        fs::write(
            library.user_dir("portable-fixture").join("campaign.dat"),
            b"canonical campaign",
        )
        .unwrap();
        library.register_install(&first, false).unwrap();
        let mut operation = LifecycleOperation::new(
            Uuid::new_v4().to_string(),
            LifecycleOperationKind::Activate,
            "portable-fixture",
        );
        operation.install = Some(first.clone());
        let store = OperationStore::new(library.clone());
        store.put(&mut operation).unwrap();
        let failure =
            crate::recovery::recover_activation(&service, &store, &mut operation).unwrap_err();
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
        assert_eq!(
            service
                .status("portable-fixture")
                .unwrap()
                .staged
                .unwrap()
                .id,
            first.id
        );
        assert_eq!(
            fs::read(second.path.join("campaign.dat")).unwrap(),
            b"current runtime campaign"
        );
        assert_eq!(
            fs::read(library.user_dir("portable-fixture").join("campaign.dat")).unwrap(),
            b"canonical campaign"
        );
        assert_eq!(
            fs::read(first.path.join(".portcove-manifest.json")).unwrap(),
            manifest
        );
        assert!(!receipt.try_exists().unwrap());
        assert!(!first.path.join("campaign.dat").exists());
    }

    #[tokio::test]
    async fn artifact_reuse_with_unchanged_retained_data_contract_still_activates() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = Server::new();
        let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
        let mut service = build_service(library.clone(), provider.clone());
        let (first, second, first_release) =
            installs_with_retained_scopes(&mut service, &library, &server, &provider, false).await;
        let port = service.installed_port(&second).unwrap();
        service
            .prepare_launch_for_install(&port, &second, None, None)
            .unwrap();
        fs::write(second.path.join("settings.ini"), b"latest player choice").unwrap();
        *provider.0.lock().unwrap() = first_release;
        let reused = service
            .install("portable-fixture", None, None, None, true, |_| {})
            .await
            .unwrap();
        assert_eq!(reused.id, first.id);
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
            fs::read(first.path.join("settings.ini")).unwrap(),
            b"latest player choice"
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
