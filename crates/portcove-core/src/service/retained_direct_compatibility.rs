//! Bounded historical reader holds; no save conversion or adoption authority.
use super::*;

#[cfg(test)]
const ID: &str = "sonic-3-and-knuckles-recomp";
#[cfg(test)]
use crate::persistence::legacy_direct_reader as legacy_reader;
use crate::persistence::requires_fresh_direct_data_guard as requires_fresh_data_guard;
#[cfg(test)]
const LEGACY_PACKAGE: &str = "42ada10579a00d266aa08a833054ea5fea87b64eef67d268b054525fd0f6be99";

fn held(port: &PortDefinition) -> PortcoveError {
    PortcoveError::conflict(format!(
        "{} player-data compatibility is held. Preserve the creating runtime and all data; use a separate empty library for a fresh installation until its legacy transition is qualified.", port.name,
    )).with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged)
}

/// Original bytes are not player data, but only a verified regular materialized
/// source may be exempted. Case aliases, links and unreadable files remain holds.
fn require_empty_player_data(port: &PortDefinition, root: &Path) -> Result<()> {
    if !crate::persistence::ready_staged_archive(port) {
        return Err(held(port));
    }
    for relative in crate::persistence::entries(port, &[root])? {
        if port.runtime_source_filename.as_deref() == Some(relative.as_str()) {
            let path = root.join(&relative);
            refuse_symlink_ancestors(&path)?;
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    crate::persistence::require_absent_path(root, &relative)?;
                    continue;
                }
                result => {
                    result?;
                }
            }
            // Apply the same finite case-sensitive inspection boundary as
            // persistence::require_absent_path before allowing this one source.
            for (index, entry) in fs::read_dir(root)?.enumerate() {
                if index >= 4096 {
                    return Err(held(port));
                }
                let name = entry?.file_name();
                let name = crate::path::unicode(Path::new(&name), "original filename")?;
                if name.to_lowercase() == relative.to_lowercase() && name != relative {
                    return Err(held(port));
                }
            }
            let expected = port
                .runtime_source_hashes
                .get(&relative)
                .ok_or_else(|| held(port))?;
            let actual =
                crate::external_runtime::hash_stable_regular(&path, 16 * 1024 * 1024, &|| Ok(()))?;
            if actual.0 != *expected {
                return Err(held(port));
            }
        } else {
            crate::persistence::require_absent_path(root, &relative).map_err(|_| held(port))?;
        }
    }
    Ok(())
}

fn require_source_only_snapshot(port: &PortDefinition, root: &Path) -> Result<()> {
    require_empty_player_data(port, root)?;
    for (count, entry) in fs::read_dir(root)?.enumerate() {
        if count >= 4096 {
            return Err(held(port));
        }
        let name = entry?.file_name();
        let name = crate::path::unicode(Path::new(&name), "snapshot entry")?;
        if port.runtime_source_filename.as_deref() != Some(name.as_str()) {
            return Err(held(port));
        }
    }
    Ok(())
}

impl PortcoveService {
    pub(crate) fn require_direct_backup_snapshot(
        &self,
        port_id: &str,
        snapshot: &Path,
        producing_archive: Option<&str>,
        partitioned_policy: Option<&str>,
    ) -> Result<()> {
        if crate::persistence::legacy_direct_reader(port_id).is_none()
            && partitioned_policy.is_none()
        {
            if producing_archive.is_some() {
                return Err(PortcoveError::verification(
                    "backup runtime binding belongs to an unrelated identity",
                ));
            }
            return Ok(());
        }
        let installs = self
            .library
            .all_installs()?
            .into_iter()
            .filter(|install| install.port_id == port_id)
            .collect::<Vec<_>>();
        if let Some(policy) = partitioned_policy {
            if crate::archive_data::snapshot_policy(snapshot)?.as_deref() != Some(policy) {
                return Err(PortcoveError::verification(
                    "partitioned backup framing differs from its preserved coordinates",
                ));
            }
            // With no runtime, preserve this consented snapshot as opaque data.
            // It grants no fresh-install compatibility or acquisition authority.
            if installs.is_empty() {
                return Ok(());
            }
        }
        for install in installs {
            let port = self.effective_archive_data_port(&install)?;
            if port.archive_data_compatibility_v1.is_some() {
                if partitioned_policy != Some(crate::archive_data::policy_sha256(&port)?.as_str()) {
                    return Err(held(&port));
                }
                self.require_portable_runtime_unchanged(&install)?;
                crate::archive_data::require_snapshot(&port, snapshot)?;
                continue;
            }
            if partitioned_policy.is_some() {
                return Err(held(&port));
            }
            crate::archive_data::refuse_unpartitioned_snapshot(snapshot)?;
            if producing_archive.is_none() && !requires_fresh_data_guard(&port) {
                // Exact historical readers keep their byte-only administrative
                // restore contract. New bound snapshots cannot borrow it.
                continue;
            }
            self.require_portable_runtime_unchanged(&install)?;
            if producing_archive
                .is_some_and(|sha| install.artifact.sha256.eq_ignore_ascii_case(sha))
            {
                continue;
            }
            require_source_only_snapshot(&port, snapshot)?;
        }
        // Restoring canonical bytes with no runtime does not authorize creating
        // a fresh installation: its separate original-only guard still applies.
        Ok(())
    }

    /// An initialized target proves its own restore, not that shared canonical
    /// data came from the same build. Check before collecting or replacing data.
    pub(super) fn require_direct_artifact_transition(
        &self,
        from: &InstallRecord,
        to: &PortDefinition,
        artifact_sha256: &str,
        target: Option<&InstallRecord>,
    ) -> Result<()> {
        let retained = self.effective_archive_data_port(from)?;
        let effective_target = self.retained_archive_data_target(to, target)?;
        let to = &effective_target;
        if retained.id != to.id {
            return Err(held(to));
        }
        if retained.archive_data_compatibility_v1.is_some()
            || to.archive_data_compatibility_v1.is_some()
        {
            if retained.archive_data_compatibility_v1.is_none()
                || to.archive_data_compatibility_v1.is_none()
                || crate::archive_data::policy_sha256(&retained)?
                    != crate::archive_data::policy_sha256(to)?
            {
                return Err(held(to));
            }
            self.require_portable_runtime_unchanged(from)?;
            let user = self.library.user_dir(&to.id);
            crate::archive_data::entries(
                &retained,
                Some(&from.artifact.sha256),
                &self.persistence_root(&retained, &from.path)?,
                &user,
            )?;
            if let Some(target) = target {
                self.require_portable_runtime_unchanged(target)?;
                crate::archive_data::entries(
                    to,
                    Some(&target.artifact.sha256),
                    &self.persistence_root(to, &target.path)?,
                    &user,
                )?;
            }
            return Ok(());
        }
        if !(requires_fresh_data_guard(&retained) || requires_fresh_data_guard(to)) {
            return Ok(());
        }
        if from.artifact.sha256.len() == 64
            && from
                .artifact
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            && from.artifact.sha256.eq_ignore_ascii_case(artifact_sha256)
        {
            return Ok(());
        }
        let mut roots = vec![
            self.persistence_root(&retained, &from.path)?,
            self.library.user_dir(&from.port_id),
        ];
        if let Some(target) = target {
            if target.port_id != from.port_id {
                return Err(held(to));
            }
            roots.push(self.persistence_root(to, &target.path)?);
        }
        self.require_direct_empty_expansion(&retained, to, &roots)
    }

    /// Preserve the exact legacy reader, while refusing unproven canonical data
    /// before a new route is created. Retained imports carry their own receipts.
    pub(super) fn require_direct_fresh_data(&self, port: &PortDefinition) -> Result<()> {
        if port.archive_data_compatibility_v1.is_some() {
            let installs = self
                .library
                .all_installs()?
                .into_iter()
                .filter(|i| i.port_id == port.id)
                .collect::<Vec<_>>();
            let user = self.library.user_dir(&port.id);
            if installs.is_empty() {
                // Namespace names and a self-consistent backup are not historical
                // admission. Reusing populated data needs its retained creator.
                require_empty_player_data(port, &user)?;
                if crate::archive_data::has_bound_objects(&user)? {
                    return Err(held(port));
                }
            }
            for install in installs {
                let retained = self.effective_archive_data_port(&install)?;
                if retained.archive_data_compatibility_v1.is_none()
                    || crate::archive_data::policy_sha256(&retained)?
                        != crate::archive_data::policy_sha256(port)?
                {
                    return Err(held(port));
                }
            }
            crate::archive_data::require_snapshot(port, &user)?;
        } else if requires_fresh_data_guard(port) {
            require_empty_player_data(port, &self.library.user_dir(&port.id))?;
        }
        Ok(())
    }

    pub(super) fn require_direct_initial_restore(
        &self,
        port: &PortDefinition,
        install: &InstallRecord,
    ) -> Result<()> {
        self.require_direct_initial_restore_from(port, install, &self.library.user_dir(&port.id))
    }

    pub(super) fn require_direct_restore_snapshot(
        &self,
        port: &PortDefinition,
        install_root: &Path,
        snapshot: &Path,
    ) -> Result<()> {
        if !requires_fresh_data_guard(port) {
            return Ok(());
        }
        let install = self
            .psx_data_install(port, install_root)?
            .ok_or_else(|| held(port))?;
        self.require_direct_initial_restore_from(port, &install, snapshot)
    }

    fn require_direct_initial_restore_from(
        &self,
        port: &PortDefinition,
        install: &InstallRecord,
        snapshot: &Path,
    ) -> Result<()> {
        if !requires_fresh_data_guard(port) {
            return Ok(());
        }
        let creating = self.installed_port(install)?;
        let retained = self.effective_archive_data_port(install)?;
        if serde_json::to_value(&retained)? != serde_json::to_value(port)?
            && serde_json::to_value(&creating)? != serde_json::to_value(port)?
        {
            return Err(held(port));
        }
        if retained.archive_data_compatibility_v1.is_some() {
            crate::archive_data::require_snapshot(&retained, snapshot)?;
        } else if !psx_mod_data::initialized(install)? {
            require_empty_player_data(port, snapshot)?;
        }
        Ok(())
    }

    pub(super) fn require_direct_empty_expansion(
        &self,
        retained: &PortDefinition,
        to: &PortDefinition,
        roots: &[PathBuf],
    ) -> Result<()> {
        if retained.archive_data_compatibility_v1.is_some()
            || to.archive_data_compatibility_v1.is_some()
        {
            return Err(held(to)); // A new layout is a contract migration, never an additive path grant.
        }
        if retained.id == to.id
            && (requires_fresh_data_guard(retained) || requires_fresh_data_guard(to))
        {
            // Shared paths may contain build-bound states even when every added
            // thumbnail/campaign sidecar is absent. Generic expansion alone is
            // not a compatibility proof for this historical reader transition.
            for root in roots {
                require_empty_player_data(retained, root)?;
                require_empty_player_data(to, root)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_original() -> PortDefinition {
        // Real route coordinates; synthetic bytes are never game evidence.
        let mut port = Catalog::embedded().unwrap().port(ID).unwrap().clone();
        port.runtime_source_hashes.insert(
            "game.bin".into(),
            hex::encode(Sha256::digest(b"fixture original")),
        );
        port
    }

    #[test]
    fn sonic3k_common_player_data_is_not_an_empty_scope_expansion() {
        let port = synthetic_original();
        for relative in [
            "settings.ini",
            "rom-Sonic3K.cfg",
            "game.srm",
            "native_save_1.bin",
            "native_save_9.bin",
            "game.srm.campaign",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            fs::write(temporary.path().join("game.bin"), b"fixture original").unwrap();
            fs::write(
                temporary.path().join(relative),
                b"retain exact player bytes",
            )
            .unwrap();
            assert!(
                require_empty_player_data(&port, temporary.path()).is_err(),
                "{relative}"
            );
            assert_eq!(
                fs::read(temporary.path().join(relative)).unwrap(),
                b"retain exact player bytes"
            );
        }
    }

    #[test]
    fn sonic3k_source_only_empty_creation_requires_exact_original_bytes() {
        let port = synthetic_original();
        let temporary = tempfile::tempdir().unwrap();
        require_empty_player_data(&port, temporary.path()).unwrap();
        fs::write(temporary.path().join("game.bin"), b"fixture original").unwrap();
        require_empty_player_data(&port, temporary.path()).unwrap();
        fs::write(temporary.path().join("game.bin"), b"different bytes").unwrap();
        assert!(require_empty_player_data(&port, temporary.path()).is_err());
        fs::remove_file(temporary.path().join("game.bin")).unwrap();
        fs::create_dir(temporary.path().join("game.bin")).unwrap();
        assert!(require_empty_player_data(&port, temporary.path()).is_err());
    }

    #[test]
    fn sonic3k_patterns_empty_directories_and_aliases_remain_holds() {
        let mut port = synthetic_original();
        port.persistent_file_patterns
            .push(crate::PersistentFilePattern {
                prefix: "state_".into(),
                suffix: ".bin".into(),
            });
        for relative in ["settings.ini", "state_extra.bin", "GAME.SRM", "GAME.BIN"] {
            let temporary = tempfile::tempdir().unwrap();
            fs::create_dir(temporary.path().join(relative)).unwrap();
            assert!(
                require_empty_player_data(&port, temporary.path()).is_err(),
                "{relative}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn sonic3k_source_link_and_hardlink_are_not_original_authority() {
        let port = synthetic_original();
        let temporary = tempfile::tempdir().unwrap();
        let original = temporary.path().join("outside");
        fs::write(&original, b"fixture original").unwrap();
        let root = temporary.path().join("data");
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink(&original, root.join("game.bin")).unwrap();
        assert!(require_empty_player_data(&port, &root).is_err());
        fs::remove_file(root.join("game.bin")).unwrap();
        fs::hard_link(&original, root.join("game.bin")).unwrap();
        assert!(require_empty_player_data(&port, &root).is_err());
    }

    #[test]
    fn fresh_partitioned_route_allows_empty_kept_namespace_but_not_populated_data() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let port = Catalog::embedded()
            .unwrap()
            .port("super-metroid-recomp")
            .unwrap()
            .clone();
        let user = library.user_dir(&port.id);
        crate::archive_data::initialize(&port, &user).unwrap();
        service.require_direct_fresh_data(&port).unwrap();
        let bound = crate::archive_data::namespace(&port, &user)
            .unwrap()
            .join("a".repeat(64));
        fs::create_dir_all(&bound).unwrap();
        service.require_direct_fresh_data(&port).unwrap();
        fs::write(bound.join("snapshot.sav"), b"preserved progress").unwrap();
        assert!(service.require_direct_fresh_data(&port).is_err());
        assert_eq!(
            fs::read(bound.join("snapshot.sav")).unwrap(),
            b"preserved progress"
        );
        fs::remove_file(bound.join("snapshot.sav")).unwrap();
        fs::write(user.join("config.ini"), b"preserved conventional data").unwrap();
        assert!(service.require_direct_fresh_data(&port).is_err());
        assert_eq!(
            fs::read(user.join("config.ini")).unwrap(),
            b"preserved conventional data"
        );
    }

    #[test]
    fn fresh_sonic1_and_mmx2_routes_refuse_canonical_legacy_data() {
        let library_root = tempfile::tempdir().unwrap();
        let library = Library::open(library_root.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        for id in [
            "sonic-the-hedgehog-recomp",
            "mega-man-x2-snes-recomp",
            "super-metroid-recomp",
        ] {
            let mut port = crate::test_fixture::v26_diagnostic_port(id);
            let (version, hash) = legacy_reader(id).unwrap();
            port.release.provider = crate::ReleaseSource::DirectManifest;
            let release = port
                .release
                .direct
                .get_mut(&Platform::WindowsX86_64)
                .unwrap();
            release.version = version.into();
            release.sha256 = hash.into();
            assert!(!requires_fresh_data_guard(&port));
            fs::create_dir_all(library.user_dir(id)).unwrap();
            let name = if id == "sonic-the-hedgehog-recomp" {
                "native_save_1.bin"
            } else {
                "saves"
            };
            fs::write(library.user_dir(id).join(name), b"creating-version data").unwrap();
            service.require_direct_fresh_data(&port).unwrap();
            port.release
                .direct
                .get_mut(&Platform::WindowsX86_64)
                .unwrap()
                .sha256 = "a".repeat(64);
            assert!(requires_fresh_data_guard(&port));
            assert!(service.require_direct_fresh_data(&port).is_err());
            assert_eq!(
                fs::read(library.user_dir(id).join(name)).unwrap(),
                b"creating-version data"
            );
            fs::remove_file(library.user_dir(id).join(name)).unwrap();
            service.require_direct_fresh_data(&port).unwrap();
        }
    }

    #[test]
    fn sonic3k_hold_does_not_reinterpret_the_exact_legacy_reader_or_other_ports() {
        let mut port = synthetic_original();
        assert!(requires_fresh_data_guard(&port));
        port.release.provider = crate::ReleaseSource::DirectManifest;
        port.release.direct.insert(
            Platform::WindowsX86_64,
            crate::DirectReleaseSpec {
                version: "v0.5.3".into(),
                url: "https://example.invalid/fixture.zip".into(),
                size: 1,
                sha256: LEGACY_PACKAGE.into(),
                published_at: None,
            },
        );
        assert!(!requires_fresh_data_guard(&port));
        port.release
            .direct
            .get_mut(&Platform::WindowsX86_64)
            .unwrap()
            .sha256 = "0".repeat(64);
        assert!(requires_fresh_data_guard(&port));
        port.release.provider = crate::ReleaseSource::UserPrepared;
        assert!(!requires_fresh_data_guard(&port));
        port.release.provider = crate::ReleaseSource::Github;
        port.adapter = AdapterKind::NativePortable;
        assert!(!requires_fresh_data_guard(&port));
        port.id = "unrelated-fixture".into();
        assert!(!requires_fresh_data_guard(&port));
    }
}
