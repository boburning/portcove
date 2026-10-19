//! Closed preparation interpretation for the reviewed Ghostship 2.0.0 package.
//! The admitted definition remains unchanged and independently hash-bound.

use crate::{
    AdapterKind, InstallRecord, Platform, PortDefinition, PortcoveError, Result,
    RuntimeSourceMaterialization, SourceRecord,
};

pub(super) const GENERATED: &str = "prepared-game-data/sm64.o2r";
pub(super) const ORIGINAL: &str = "baserom.us.z64";
pub(super) const EXECUTABLE_SHA256: &str =
    "2063529579d27d98953613147e0d53e2cde3ed4e783a8f2f51a43afbbd8b4c24";

pub(super) fn generated_path(root: &std::path::Path) -> std::path::PathBuf {
    // GENERATED is a portable manifest name. Native no-replace publication
    // passes an extended Windows path directly to MoveFileExW, which must not
    // receive the manifest's forward slash in its destination buffer.
    root.join("prepared-game-data").join("sm64.o2r")
}

pub(super) fn require_no_binary_importer(root: &std::path::Path) -> Result<()> {
    let path = root.join("default.sav");
    crate::path::refuse_symlink_ancestors(&path)?;
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(PortcoveError::conflict(
            "legacy runtime cannot consume an unqualified binary save importer; preserve default.sav and JSON saves for reviewed recovery",
        )),
    }
}

pub(super) fn require_discovery_layout(
    bundle: &crate::AdoptionCopyPlan,
    working: &crate::AdoptionCopyPlan,
) -> Result<()> {
    let is_rom = |path: &std::path::Path| {
        path.components().count() == 1
            && path.extension().is_some_and(|extension| extension == "z64")
    };
    let discovered = working
        .files
        .iter()
        .filter(|file| is_rom(&file.relative_path))
        .collect::<Vec<_>>();
    if bundle.files.iter().any(|file| is_rom(&file.relative_path))
        || discovered.len() != 1
        || discovered[0].relative_path != std::path::Path::new(ORIGINAL)
    {
        return Err(PortcoveError::verification(
            "legacy bootstrap requires exactly one verified CWD lowercase-z64 original and none in its executable bundle",
        ));
    }
    Ok(())
}

pub(super) fn execution_contract(
    port: &PortDefinition,
    install: &InstallRecord,
    host: Platform,
) -> Result<PortDefinition> {
    require_path(&install.path)?;
    if host != Platform::WindowsX86_64
        || port.id != "ghostship"
        || port.adapter != AdapterKind::LibultrashipPortable
        || port.source_profile.as_deref() != Some("ghostship-source")
        || install.port_id != port.id
        || install.version != "2.0.0"
        || install.artifact.asset_name != "Mary-Celeste-Alfa-Win64.zip"
        || install.artifact.sha256
            != "a49f4c791377fcc611264b8920f2c3254b3ab25747c2a59da9305c32f92a6d3f"
        || install.artifact.size != 21_561_620
        || !install
            .selected_executable
            .to_str()
            .is_some_and(|path| path.eq_ignore_ascii_case("Ghostship.exe"))
        || port.runtime_subdirectory.is_some()
        || !port.setup_output_paths.is_empty()
        || port.setup_marker.is_some()
        || !port.setup_executable_hints.is_empty()
        || !port.setup_arguments.is_empty()
        || !port.runtime_source_set.is_empty()
        || !port.persistent_file_patterns.is_empty()
        || !port.launch_arguments.is_empty()
    {
        return Err(PortcoveError::unsupported(
            "legacy bootstrap requires the exact reviewed Ghostship 2.0.0 Windows package and admitted source contract",
        ));
    }
    let mut execution = port.clone();
    execution.runtime_source_filename = Some(ORIGINAL.into());
    execution.runtime_source_materialization = Some(RuntimeSourceMaterialization::N64BigEndian);
    execution.setup_executable_hints = std::collections::BTreeMap::from([(
        host,
        vec![crate::path::unicode(
            &install.selected_executable,
            "legacy executable",
        )?],
    )]);
    execution.setup_marker = Some(GENERATED.into());
    execution.setup_output_paths = vec![GENERATED.into()];
    super::validate_output_contract(&execution)?;
    Ok(execution)
}

pub(super) fn require_path(path: &std::path::Path) -> Result<()> {
    // The exact extractor uses FindFirstFileA/PathFindExtensionA. It has no
    // reviewed Unicode or long-path contract; the copied ROM name is fixed.
    if !path
        .to_str()
        .is_some_and(|path| path.len() < 260 && path.bytes().all(|byte| (32..=126).contains(&byte)))
    {
        return Err(PortcoveError::unsupported(
            "Ghostship 2.0.0 requires a printable ASCII runtime path shorter than MAX_PATH",
        ));
    }
    Ok(())
}

pub(super) fn require_source(source: &SourceRecord) -> Result<()> {
    if source.profile_id != "ghostship-source"
        || source.size != 8_388_608
        || source.sha256 != "17ce077343c6133f8c9f2d6d6d9a4ab62c8cd2aa57c40aea1f490b4c8bb21d91"
        || source.storage_sha256 != source.sha256
        || source.storage_size != source.size
    {
        return Err(PortcoveError::source(
            "legacy bootstrap requires the reviewed exact Super Mario 64 USA big-endian original",
        ));
    }
    Ok(())
}

pub(super) fn validate_plan(
    plan: &super::PreparationPlan,
    port: &PortDefinition,
) -> Result<PortDefinition> {
    if plan.format_version != 2
        || plan.inputs.options.mode != super::PreparationMode::Ghostship200Legacy
        || plan.port_id != port.id
        || plan.inputs.options.target != plan.inputs.host
        || plan.inputs.setup_tool.sha256 != EXECUTABLE_SHA256
        || plan.inputs.setup_tool.size != 11_533_312
        || plan.inputs.conversion_tool.is_some()
    {
        return Err(PortcoveError::verification(
            "legacy preparation plan has an invalid closed interpretation",
        ));
    }
    require_source(&plan.inputs.source)?;
    execution_contract(port, &plan.inputs.install, plan.inputs.host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn generated_archive_uses_native_components_for_atomic_no_replace_publication() {
        let temporary = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temporary.path()).unwrap();
        let private = root.join("legacy-user-data");
        let payload = root.join("payload");
        std::fs::create_dir(&private).unwrap();
        std::fs::create_dir(&payload).unwrap();
        let source = private.join("sm64.o2r");
        let destination = generated_path(&payload);
        std::fs::create_dir(destination.parent().unwrap()).unwrap();
        std::fs::write(&source, b"inert generated archive").unwrap();
        crate::durability::rename_noreplace(&source, &destination).unwrap();
        assert!(!source.exists());
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"inert generated archive"
        );
        std::fs::write(&source, b"must not replace accepted output").unwrap();
        assert!(crate::durability::rename_noreplace(&source, &destination).is_err());
        assert_eq!(
            std::fs::read(&source).unwrap(),
            b"must not replace accepted output"
        );
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"inert generated archive"
        );
    }

    #[test]
    fn binary_importer_is_refused_before_fresh_setup_or_archive_reuse_without_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        require_no_binary_importer(root).unwrap();
        std::fs::create_dir(root.join("saves")).unwrap();
        std::fs::write(root.join("saves/save_0.json"), b"retained player data").unwrap();
        std::fs::write(root.join("default.sav"), b"unqualified importer").unwrap();
        let before = crate::library_transfer::reviewed_tree(root).unwrap();
        assert!(require_no_binary_importer(root).is_err());
        assert_eq!(
            crate::library_transfer::reviewed_tree(root).unwrap(),
            before
        );
        std::fs::remove_file(root.join("default.sav")).unwrap();
        std::fs::create_dir(root.join("default.sav")).unwrap();
        assert!(require_no_binary_importer(root).is_err());
        assert!(root.join("default.sav").is_dir());
    }

    #[test]
    fn discovery_requires_one_resolvable_original_without_duplicate_bundle_discovery() {
        let temporary = tempfile::tempdir().unwrap();
        let bundle = temporary.path().join("bundle");
        let working = temporary.path().join("working");
        std::fs::create_dir(&bundle).unwrap();
        std::fs::create_dir(&working).unwrap();
        let snapshot =
            |root: &std::path::Path| crate::library_transfer::reviewed_tree(root).unwrap();
        assert!(require_discovery_layout(&snapshot(&bundle), &snapshot(&working)).is_err());
        std::fs::write(
            working.join(ORIGINAL),
            b"inert identity, not an admitted original",
        )
        .unwrap();
        require_discovery_layout(&snapshot(&bundle), &snapshot(&working)).unwrap();
        std::fs::write(bundle.join(ORIGINAL), b"duplicate discovery").unwrap();
        assert!(require_discovery_layout(&snapshot(&bundle), &snapshot(&working)).is_err());
        std::fs::remove_file(bundle.join(ORIGINAL)).unwrap();
        std::fs::write(working.join("another.z64"), b"ambiguous discovery").unwrap();
        assert!(require_discovery_layout(&snapshot(&bundle), &snapshot(&working)).is_err());
    }

    #[test]
    fn legacy_contract_is_closed_to_one_artifact_and_preserves_the_admitted_definition() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("ghostship").unwrap();
        let original = serde_json::to_value(port).unwrap();
        let install = InstallRecord {
            id: "inert".into(),
            port_id: "ghostship".into(),
            version: "2.0.0".into(),
            path: "E:/fixture/Ghostship".into(),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 0,
            verified: true,
            staged: false,
            artifact: crate::ArtifactIdentity {
                asset_name: "Mary-Celeste-Alfa-Win64.zip".into(),
                sha256: "a49f4c791377fcc611264b8920f2c3254b3ab25747c2a59da9305c32f92a6d3f".into(),
                size: 21_561_620,
            },
            runtime: None,
            manifest_sha256: "0".repeat(64),
            selected_executable: "Ghostship.exe".into(),
        };
        let execution = execution_contract(port, &install, Platform::WindowsX86_64).unwrap();
        assert_eq!(execution.setup_output_paths, [GENERATED]);
        assert!(execution.setup_arguments.is_empty());
        assert_eq!(execution.persistent_paths, port.persistent_paths);
        assert_eq!(serde_json::to_value(port).unwrap(), original);
        for changed in [
            InstallRecord {
                version: "3.0.0".into(),
                ..install.clone()
            },
            InstallRecord {
                selected_executable: "other.exe".into(),
                ..install.clone()
            },
            InstallRecord {
                artifact: crate::ArtifactIdentity {
                    sha256: "0".repeat(64),
                    ..install.artifact.clone()
                },
                ..install.clone()
            },
        ] {
            assert!(execution_contract(port, &changed, Platform::WindowsX86_64).is_err());
        }
        assert!(execution_contract(port, &install, Platform::LinuxX86_64).is_err());
        let mut changed = port.clone();
        changed.launch_arguments.push("--unreviewed".into());
        assert!(execution_contract(&changed, &install, Platform::WindowsX86_64).is_err());
        let mut changed = port.clone();
        changed.setup_output_paths.push("sm64.o2r".into());
        assert!(execution_contract(&changed, &install, Platform::WindowsX86_64).is_err());
    }

    #[test]
    fn legacy_narrow_path_preconditions_match_the_ansi_extractor() {
        require_path(std::path::Path::new(
            "E:/fixture with spaces/baserom.us.z64",
        ))
        .unwrap();
        assert!(require_path(std::path::Path::new("E:/\u{e9}/baserom.us.z64")).is_err());
        assert!(require_path(std::path::Path::new(&"a".repeat(260))).is_err());
        assert!(require_path(std::path::Path::new("E:/bad\npath")).is_err());
    }
}
