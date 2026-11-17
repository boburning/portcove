//! Loader admission for exact managed installations. The retained definition,
//! executable, platform and release series must agree with a compiled adapter.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use crate::{
    AdapterKind, InstallRecord, Library, LoaderContractRef, Platform, PortDefinition,
    PortcoveError, PortcoveService, ProfileRevision, RecompModInspection, ReleaseSource,
    ResolvedPackage, Result, RetainedBuildIdentity, profile,
    profile_deploy::{Layout, live_package_path},
    recomp_mod::version_parts,
};

pub(crate) const RECOMP_DEPENDENCY_REVIEW: &str = "recomp_dependencies";

struct ReviewedLoader {
    id: &'static str,
    adapter: AdapterKind,
    repository: &'static str,
    minimum: [u16; 3],
    settings_file: &'static str,
    platforms: &'static [Platform],
}

const SHIP: ReviewedLoader = ReviewedLoader {
    id: "libultraship",
    adapter: AdapterKind::LibultrashipPortable,
    repository: "HarbourMasters/Shipwright",
    minimum: [9, 2, 3],
    settings_file: "shipofharkinian.json",
    platforms: &[Platform::WindowsX86_64, Platform::LinuxX86_64],
};

const RECOMP: ReviewedLoader = ReviewedLoader {
    id: "n64-recomp",
    adapter: AdapterKind::N64RecompPortable,
    repository: "Zelda64Recomp/Zelda64Recomp",
    minimum: [1, 2, 2],
    settings_file: "mods.json",
    platforms: &[
        Platform::WindowsX86_64,
        Platform::LinuxX86_64,
        Platform::MacosX86_64,
        Platform::MacosAarch64,
    ],
};

fn reviewed(port_id: &str) -> Option<&'static ReviewedLoader> {
    match port_id {
        "shipwright" => Some(&SHIP),
        "zelda64-recomp" => Some(&RECOMP),
        _ => None,
    }
}

fn stable_version(tag: &str) -> Option<[u16; 3]> {
    let tag = tag.strip_prefix('v').unwrap_or(tag);
    let mut parts = tag.split('.');
    let mut parsed = [0u16; 3];
    for value in &mut parsed {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        *value = part.parse().ok()?;
    }
    parts.next().is_none().then_some(parsed)
}

fn contract_matches(
    loader: &ReviewedLoader,
    port: &PortDefinition,
    platform: Platform,
    executable: &Path,
    release: &str,
) -> bool {
    let Some(version) = stable_version(release) else {
        return false;
    };
    port.adapter == loader.adapter
        && port.release.provider == ReleaseSource::Github
        && port
            .release
            .repository
            .eq_ignore_ascii_case(loader.repository)
        && port.platforms.contains(&platform)
        && loader.platforms.contains(&platform)
        && version[0] == loader.minimum[0]
        && version >= loader.minimum
        && ["mods", loader.settings_file].iter().all(|expected| {
            port.persistent_paths
                .iter()
                .any(|path| path.as_str() == *expected)
        })
        && port.executable_hints.get(&platform).is_some_and(|hints| {
            executable.file_name().is_some_and(|name| {
                hints.iter().any(|hint| {
                    Path::new(hint)
                        .file_name()
                        .is_some_and(|expected| name.eq_ignore_ascii_case(expected))
                })
            })
        })
}

fn contract(
    install: &InstallRecord,
    build: &RetainedBuildIdentity,
) -> Result<Option<LoaderContractRef>> {
    #[cfg(test)]
    if install.port_id == "starship" {
        return Ok(Some(LoaderContractRef {
            id: "libultraship".into(),
            version: "1".into(),
        }));
    }
    let Some(loader) = reviewed(&install.port_id) else {
        return Ok(None);
    };
    let Some(catalog) = crate::install::retained_catalog_for_install(install)? else {
        return Ok(None);
    };
    let port = catalog.port(&install.port_id)?;
    Ok((install.runtime.is_none()
        && contract_matches(
            loader,
            port,
            build.platform,
            &build.selected_executable,
            &install.version,
        ))
    .then(|| LoaderContractRef {
        id: loader.id.into(),
        version: "1".into(),
    }))
}

fn require_contract(
    install: &InstallRecord,
    build: &RetainedBuildIdentity,
    declared: Option<&LoaderContractRef>,
    needs_loader: bool,
) -> Result<Option<LoaderContractRef>> {
    let derived = contract(install, build)?;
    if (needs_loader && derived.is_none())
        || declared.is_some_and(|declared| Some(declared) != derived.as_ref())
    {
        return Err(PortcoveError::unsupported(
            "this setup's mods need a reviewed loader. Choose a compatible game build before using them",
        )
        .detail("port_id", &build.port_id)
        .detail("version", &install.version)
        .detail("platform", format!("{:?}", build.platform)));
    }
    Ok(derived)
}

fn require_recomp_versions(
    layout: &Layout,
    revision: &ProfileRevision,
    runtime: &str,
    game: &str,
) -> Result<()> {
    let mut enabled = BTreeMap::new();
    for package in revision.packages.iter().filter(|package| package.enabled) {
        let inspected = inspect_retained_recomp(layout, package, game)?;
        enabled.insert(inspected.native_id.clone(), inspected);
    }
    validate_recomp_versions(&enabled, runtime.strip_prefix('v').unwrap_or(runtime), game)
}

fn inspect_retained_recomp(
    layout: &Layout,
    package: &ResolvedPackage,
    game: &str,
) -> Result<RecompModInspection> {
    let stored = layout.package(&package.sha256, &package.native_id);
    let path = if stored.try_exists()? {
        stored
    } else {
        live_package_path(layout, &package.native_id)?
    };
    let inspected = crate::inspect_recomp_mod(&path, game)?;
    if inspected.sha256 != package.sha256
        || inspected.size != package.size
        || package.native_id != format!("{}.nrm", inspected.native_id)
        || inspected.holds.contains(&crate::RecompModHold::OtherGame)
    {
        return Err(PortcoveError::verification(
            "the exact mod bytes or their native identity changed; review the package again",
        )
        .detail("package", &package.native_id));
    }
    Ok(inspected)
}

pub(crate) fn validate_recomp_versions(
    enabled: &BTreeMap<String, RecompModInspection>,
    runtime: &str,
    game: &str,
) -> Result<()> {
    validate_recomp_versions_allowing_missing(enabled, runtime, game, None)
}

fn validate_recomp_versions_allowing_missing(
    enabled: &BTreeMap<String, RecompModInspection>,
    runtime: &str,
    game: &str,
    missing_local: Option<(&str, &[String])>,
) -> Result<()> {
    fn minimum(current: &str, required: &str, owner: &str, subject: &str) -> Result<()> {
        if version_parts(current).is_some_and(|current| {
            version_parts(required).is_some_and(|required| current >= required)
        }) {
            return Ok(());
        }
        Err(PortcoveError::unsupported(
            "a mod requires a newer compatible version. Review the required version before continuing",
        )
        .detail("mod", owner)
        .detail("requires", subject)
        .detail("minimum_version", required)
        .detail("selected_version", current))
    }

    fn visit<'a>(
        id: &'a str,
        enabled: &'a BTreeMap<String, RecompModInspection>,
        visiting: &mut BTreeSet<&'a str>,
        done: &mut BTreeSet<&'a str>,
    ) -> Result<()> {
        if done.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err(PortcoveError::conflict(
                "the enabled mods form a dependency cycle. Turn off the affected mods or install compatible versions",
            )
            .detail("mod", id));
        }
        for dependency in &enabled[id].dependencies {
            if enabled.contains_key(&dependency.id) {
                visit(&dependency.id, enabled, visiting, done)?;
            }
        }
        visiting.remove(id);
        done.insert(id);
        Ok(())
    }

    for (id, inspection) in enabled {
        minimum(
            runtime,
            &inspection.minimum_runtime_version,
            id,
            "game runtime",
        )?;
        for dependency in &inspection.dependencies {
            let available = match dependency.id.as_str() {
                "." => Some(inspection.native_version.as_str()),
                "*" => Some(runtime),
                name => enabled
                    .get(name)
                    .map(|mod_info| mod_info.native_version.as_str())
                    .or(match (game, runtime, name) {
                        // The official v1.2.2 source embeds this exact NRM.
                        // Later builds with no verified version still satisfy
                        // unconstrained built-in dependencies below.
                        ("mm", "1.2.2", "mm_recomp_dpad_builtin") => Some("1.0.0"),
                        _ => None,
                    }),
            };
            if let Some(available) = available {
                if let Some(required) = &dependency.minimum_version {
                    minimum(available, required, id, &dependency.id)?;
                }
            } else if crate::native_mod_list::recomp_builtins(game)
                .contains(&dependency.id.as_str())
            {
                if let Some(required) = &dependency.minimum_version
                    && version_parts(required) != Some([0, 0, 0])
                {
                    return Err(PortcoveError::unsupported(
                        "this mod requires a version of a built-in mod that this build does not report",
                    )
                    .detail("mod", id)
                    .detail("requires", &dependency.id)
                    .detail("minimum_version", required));
                }
            } else if !missing_local.is_some_and(|(local_id, missing)| {
                local_id == id
                    && missing
                        .iter()
                        .any(|name| crate::native_mod_list::native_name(name) == dependency.id)
            }) {
                return Err(PortcoveError::conflict(
                    "a required native mod is missing or disabled. Install or enable it before continuing",
                )
                .detail("mod", id)
                .detail("requires", &dependency.id));
            }
        }
    }
    // The reviewed runtime's required-version check excludes optional
    // dependencies. Their ordering effects stay in the native loader.
    let mut visiting = BTreeSet::new();
    let mut done = BTreeSet::new();
    for id in enabled.keys() {
        visit(id, enabled, &mut visiting, &mut done)?;
    }
    Ok(())
}

impl PortcoveService {
    /// Resolves a writer's loader choice from the already verified install.
    pub(crate) fn profile_loader_binding(
        &self,
        build: &RetainedBuildIdentity,
        declared: Option<&LoaderContractRef>,
        needs_loader: bool,
    ) -> Result<Option<LoaderContractRef>> {
        let install = Library::install_by_id(&self.library.connection()?, Some(&build.install_id))?
            .filter(|install| build.matches_install(install))
            .ok_or_else(|| {
                PortcoveError::conflict("the installed runtime changed; review the setup again")
            })?;
        require_contract(&install, build, declared, needs_loader)
    }

    /// Reviews the enabled set that an exact package replacement would publish.
    pub(crate) fn review_recomp_changes<'a>(
        &self,
        layout: &Layout,
        current: &ProfileRevision,
        staged: impl IntoIterator<Item = &'a RecompModInspection>,
        missing_local: Option<(&str, &[String])>,
    ) -> Result<()> {
        use crate::native_mod_list::{native_name, recomp_game};

        let Some(game) = recomp_game(&current.build.port_id) else {
            return Ok(());
        };
        let staged = staged.into_iter().collect::<Vec<_>>();
        let replaces = |inspection: &RecompModInspection, package: &ResolvedPackage| {
            inspection
                .native_id
                .eq_ignore_ascii_case(native_name(&package.native_id))
        };
        let mut enabled = BTreeMap::new();
        for package in current
            .packages
            .iter()
            .filter(|package| package.enabled && !staged.iter().any(|item| replaces(item, package)))
        {
            let inspection = inspect_retained_recomp(layout, package, game)?;
            enabled.insert(inspection.native_id.clone(), inspection);
        }
        for inspection in staged {
            if current
                .packages
                .iter()
                .all(|package| package.enabled || !replaces(inspection, package))
            {
                enabled.insert(inspection.native_id.clone(), inspection.clone());
            }
        }
        if enabled.is_empty() {
            return Ok(());
        }
        let install =
            Library::install_by_id(&self.library.connection()?, Some(&current.build.install_id))?
                .filter(|install| current.build.matches_install(install))
                .ok_or_else(|| {
                    PortcoveError::conflict("the installed runtime changed; review the setup again")
                })?;
        require_contract(&install, &current.build, current.loader.as_ref(), true)?;
        let runtime = install
            .version
            .strip_prefix('v')
            .unwrap_or(&install.version);
        validate_recomp_versions_allowing_missing(&enabled, runtime, game, missing_local)
            .map_err(|error| error.detail("review_stage", RECOMP_DEPENDENCY_REVIEW))
    }

    pub(crate) fn require_revision_loader(&self, revision: &ProfileRevision) -> Result<()> {
        if revision.packages.iter().any(|package| package.enabled) {
            self.profile_loader_binding(&revision.build, revision.loader.as_ref(), true)?;
            if let Some(game) = crate::native_mod_list::recomp_game(&revision.build.port_id) {
                let install = Library::install_by_id(
                    &self.library.connection()?,
                    Some(&revision.build.install_id),
                )?
                .ok_or_else(|| {
                    PortcoveError::not_found("the exact runtime is no longer installed")
                })?;
                let layout = Layout::for_user(&self.library.user_dir(&revision.build.port_id));
                require_recomp_versions(&layout, revision, &install.version, game)?;
            }
        }
        Ok(())
    }

    /// Launch consumes the exact installation selected by the runtime owner.
    pub(crate) fn require_selected_loader_for_install(
        &self,
        install: &InstallRecord,
    ) -> Result<()> {
        if reviewed(&install.port_id).is_none() {
            return Ok(());
        }
        let connection = self.library.connection()?;
        let Some((profile_id, number)) = profile::selection(&connection, &install.port_id)? else {
            return Ok(());
        };
        let revision = profile::revision_by_number(&connection, &profile_id, number)?;
        if revision.packages.iter().any(|package| package.enabled) {
            let build = crate::install::retained_build_identity_for_install(install)?;
            require_contract(install, &build, revision.loader.as_ref(), true)?;
            if let Some(game) = crate::native_mod_list::recomp_game(&install.port_id) {
                let layout = Layout::for_user(&self.library.user_dir(&install.port_id));
                require_recomp_versions(&layout, &revision, &install.version, game)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspection(id: &str, version: &str, runtime: &str) -> RecompModInspection {
        RecompModInspection {
            file_name: format!("{id}.nrm"),
            sha256: "a".repeat(64),
            size: 1,
            native_id: id.into(),
            native_version: version.into(),
            display_name: id.into(),
            game_id: "mm".into(),
            minimum_runtime_version: runtime.into(),
            authors: Vec::new(),
            dependencies: Vec::new(),
            optional_dependencies: Vec::new(),
            native_libraries: BTreeMap::new(),
            enabled_by_default: true,
            has_settings: false,
            execution: Vec::new(),
            holds: Vec::new(),
        }
    }

    #[test]
    fn the_native_runtime_and_required_versions_are_checked_before_use() {
        let mut addon = inspection("addon", "1.1.0", "1.2.2");
        addon.dependencies.push(crate::RecompDependency {
            id: "library".into(),
            minimum_version: Some("2.0.0".into()),
        });
        addon.optional_dependencies.push(crate::RecompDependency {
            id: "optional".into(),
            minimum_version: Some("9.9.9".into()),
        });
        let mut enabled = BTreeMap::from([
            ("addon".into(), addon),
            ("library".into(), inspection("library", "1.9.0", "1.0.0")),
        ]);
        let old_runtime = validate_recomp_versions(&enabled, "1.2.1", "mm").unwrap_err();
        assert_eq!(old_runtime.details["requires"], "game runtime");
        let old_library = validate_recomp_versions(&enabled, "1.2.2", "mm").unwrap_err();
        assert_eq!(old_library.details["requires"], "library");
        assert_eq!(old_library.details["minimum_version"], "2.0.0");

        let library = enabled.get_mut("library").unwrap();
        library.native_version = "2.0.0-local".into();
        assert!(validate_recomp_versions(&enabled, "1.2.2", "mm").is_ok());
        enabled
            .get_mut("library")
            .unwrap()
            .dependencies
            .push(crate::RecompDependency {
                id: "addon".into(),
                minimum_version: None,
            });
        let cycle = validate_recomp_versions(&enabled, "1.2.2", "mm").unwrap_err();
        assert!(cycle.message.contains("cycle"));
        enabled.remove("library");
        let missing = validate_recomp_versions(&enabled, "1.2.2", "mm").unwrap_err();
        assert_eq!(missing.details["requires"], "library");

        let mut addon = inspection("addon", "1.1.0", "1.2.2");
        addon.dependencies.push(crate::RecompDependency {
            id: "mm_recomp_dpad_builtin".into(),
            minimum_version: Some("1.0.0".into()),
        });
        let mut enabled = BTreeMap::from([("addon".into(), addon)]);
        assert!(validate_recomp_versions(&enabled, "1.2.2", "mm").is_ok());
        assert!(
            validate_recomp_versions(&enabled, "1.2.3", "mm")
                .unwrap_err()
                .message
                .contains("built-in")
        );
        enabled.get_mut("addon").unwrap().dependencies[0].minimum_version = None;
        assert!(validate_recomp_versions(&enabled, "1.2.3", "mm").is_ok());
    }

    #[test]
    fn a_setup_writer_cannot_override_the_resolved_loader() {
        let (_temporary, service, _) = crate::retained_build::tests::fixture();
        let profile = service.ensure_default_profile("starship").unwrap();
        let initial = service.profile_revisions("starship", &profile.id).unwrap();
        assert_eq!(initial[0].loader.as_ref().unwrap().id, "libultraship");
        let error = service
            .create_profile_revision(
                "starship",
                &profile.id,
                &crate::ProfileRevisionRequest {
                    expected_revision: profile.current_revision,
                    loader: Some(LoaderContractRef {
                        id: "another-loader".into(),
                        version: "1".into(),
                    }),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert_eq!(
            service.profile_revisions("starship", &profile.id).unwrap(),
            initial
        );
    }

    #[test]
    fn equal_port_ids_do_not_carry_loader_admission_to_other_builds() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut ship = catalog.port("shipwright").unwrap().clone();
        let executable = Path::new("soh.exe");
        let windows = Platform::WindowsX86_64;
        assert!(contract_matches(
            &SHIP, &ship, windows, executable, "v9.3.1"
        ));
        assert!(contract_matches(
            &SHIP, &ship, windows, executable, "v9.4.0"
        ));
        assert!(!contract_matches(
            &SHIP, &ship, windows, executable, "v9.2.2"
        ));
        assert!(!contract_matches(
            &SHIP, &ship, windows, executable, "v10.0.0"
        ));
        assert!(!contract_matches(
            &SHIP,
            &ship,
            windows,
            executable,
            "v9.4.0-rc.1"
        ));
        assert!(!contract_matches(
            &SHIP,
            &ship,
            windows,
            Path::new("other.exe"),
            "v9.3.1"
        ));
        assert!(!contract_matches(
            &SHIP,
            &ship,
            Platform::MacosAarch64,
            executable,
            "v9.3.1"
        ));

        ship.release.repository = "someone/Shipwright".into();
        assert!(!contract_matches(
            &SHIP, &ship, windows, executable, "v9.3.1"
        ));
    }
}
