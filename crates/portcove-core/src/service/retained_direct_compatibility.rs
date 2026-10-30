//! Three bounded historical reader holds; no save conversion or adoption authority.
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

impl PortcoveService {
    /// Preserve the exact legacy reader, while refusing unproven canonical data
    /// before a new route is created. Retained imports carry their own receipts.
    pub(super) fn require_direct_fresh_data(&self, port: &PortDefinition) -> Result<()> {
        if requires_fresh_data_guard(port) {
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
        let retained = self.installed_port(install)?;
        if serde_json::to_value(&retained)? != serde_json::to_value(port)? {
            return Err(held(port));
        }
        if !psx_mod_data::initialized(install)? {
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
        if retained.id == to.id && requires_fresh_data_guard(to) {
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
    fn fresh_sonic1_and_mmx2_routes_refuse_canonical_legacy_data() {
        let library_root = tempfile::tempdir().unwrap();
        let library = Library::open(library_root.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        for id in ["sonic-the-hedgehog-recomp", "mega-man-x2-snes-recomp"] {
            let mut port = Catalog::embedded().unwrap().port(id).unwrap().clone();
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
