//! Loader admission for exact managed installations. The retained definition,
//! executable, platform and release series must agree with a versioned adapter.
use std::{
    borrow::Cow,
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

/// Package and native-state behavior implemented by Core. A family is usable
/// only when an admitted definition and its exact runtime select the contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ModEngine {
    Libultraship,
    N64Recomp,
}

impl ModEngine {
    pub(crate) fn package_extensions(self) -> &'static [&'static str] {
        match self {
            Self::Libultraship => &["o2r", "otr"],
            Self::N64Recomp => &["nrm"],
        }
    }

    pub(crate) fn reference(self) -> LoaderContractRef {
        LoaderContractRef {
            id: match self {
                Self::Libultraship => "libultraship",
                Self::N64Recomp => "n64-recomp",
            }
            .into(),
            version: "1".into(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ReviewedLoader {
    pub engine: ModEngine,
    adapter: AdapterKind,
    repository: Cow<'static, str>,
    minimum: [u16; 3],
    pub settings_file: Cow<'static, str>,
    pub native_game: Option<Cow<'static, str>>,
    platforms: Cow<'static, [Platform]>,
}

impl ReviewedLoader {
    /// Only this upstream declares the built-in NRM under the reviewed game ID.
    pub(crate) fn recomp_builtins(&self) -> &'static [&'static str] {
        let official = self.repository.eq_ignore_ascii_case(&RECOMP.repository)
            && self.native_game == RECOMP.native_game;
        if official {
            &["mm_recomp_dpad_builtin"]
        } else {
            &[]
        }
    }
}

const SHIP: ReviewedLoader = ReviewedLoader {
    engine: ModEngine::Libultraship,
    adapter: AdapterKind::LibultrashipPortable,
    repository: Cow::Borrowed("HarbourMasters/Shipwright"),
    minimum: [9, 2, 3],
    settings_file: Cow::Borrowed("shipofharkinian.json"),
    native_game: None,
    platforms: Cow::Borrowed(&[Platform::WindowsX86_64, Platform::LinuxX86_64]),
};

const RECOMP: ReviewedLoader = ReviewedLoader {
    engine: ModEngine::N64Recomp,
    adapter: AdapterKind::N64RecompPortable,
    repository: Cow::Borrowed("Zelda64Recomp/Zelda64Recomp"),
    minimum: [1, 2, 2],
    settings_file: Cow::Borrowed("mods.json"),
    native_game: Some(Cow::Borrowed("mm")),
    platforms: Cow::Borrowed(&[
        Platform::WindowsX86_64,
        Platform::LinuxX86_64,
        Platform::MacosX86_64,
        Platform::MacosAarch64,
    ]),
};

#[cfg(test)]
const STARSHIP_FIXTURE: ReviewedLoader = ReviewedLoader {
    settings_file: Cow::Borrowed("starship.cfg.json"),
    ..SHIP
};

/// Historical bindings used by setup readers and journals that carry only a
/// port ID. All native behavior comes from the same engine as runtime admission.
pub(crate) fn legacy_loader(port_id: &str) -> Option<&'static ReviewedLoader> {
    match port_id {
        "shipwright" => Some(&SHIP),
        "zelda64-recomp" => Some(&RECOMP),
        #[cfg(test)]
        "starship" => Some(&STARSHIP_FIXTURE),
        _ => None,
    }
}

fn definition_matches(loader: &ReviewedLoader, port: &PortDefinition) -> bool {
    port.adapter == loader.adapter
        && port.release.provider == ReleaseSource::Github
        && port
            .release
            .repository
            .eq_ignore_ascii_case(&loader.repository)
        && ["mods", loader.settings_file.as_ref()]
            .iter()
            .all(|expected| {
                port.persistent_paths
                    .iter()
                    .any(|path| path.as_str() == *expected)
            })
}

fn authored_loader(port: &PortDefinition) -> Option<ReviewedLoader> {
    let binding = port.mod_loader.as_ref()?;
    let engine = match port.adapter {
        AdapterKind::LibultrashipPortable if binding.native_game.is_none() => {
            ModEngine::Libultraship
        }
        AdapterKind::N64RecompPortable
            if binding.settings_file == "mods.json"
                && binding.native_game.as_ref().is_some_and(|game| {
                    !game.is_empty()
                        && game.len() <= 128
                        && game
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
                }) =>
        {
            ModEngine::N64Recomp
        }
        _ => return None,
    };
    if binding.contract != engine.reference()
        || binding.settings_file.is_empty()
        || !binding.settings_file.ends_with(".json")
        || !binding
            .settings_file
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || binding.platforms.is_empty()
        || binding
            .platforms
            .iter()
            .enumerate()
            .any(|(index, platform)| {
                !port.platforms.contains(platform)
                    || binding.platforms[..index].contains(platform)
                    || !port
                        .executable_hints
                        .get(platform)
                        .is_some_and(|hints| !hints.is_empty())
            })
    {
        return None;
    }
    let loader = ReviewedLoader {
        engine,
        adapter: port.adapter,
        repository: Cow::Owned(binding.repository.clone()),
        minimum: stable_version(&binding.minimum_version)?,
        settings_file: Cow::Owned(binding.settings_file.clone()),
        native_game: binding.native_game.clone().map(Cow::Owned),
        platforms: Cow::Owned(binding.platforms.clone()),
    };
    definition_matches(&loader, port).then_some(loader)
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    if port.mod_loader.is_some() && authored_loader(port).is_none() {
        return Err(
            PortcoveError::verification("invalid native mod loader contract")
                .detail("port_id", &port.id),
        );
    }
    Ok(())
}

pub(crate) fn configured_loader(port: &PortDefinition) -> Option<ReviewedLoader> {
    if port.mod_loader.is_some() {
        return authored_loader(port);
    }
    let loader = legacy_loader(&port.id)?;
    #[cfg(test)]
    if port.id == "starship" {
        return Some(loader.clone());
    }
    definition_matches(loader, port).then(|| loader.clone())
}

/// Returns the engine the current definition can offer on the given platform.
pub(crate) fn definition_loader(
    port: &PortDefinition,
    platform: Platform,
) -> Option<ReviewedLoader> {
    let loader = configured_loader(port)?;
    #[cfg(test)]
    if port.mod_loader.is_none() && port.id == "starship" {
        return Some(loader);
    }
    (port.platforms.contains(&platform) && loader.platforms.contains(&platform)).then_some(loader)
}

/// A runtime successor can extend support, while saved state and incomplete
/// native writes retain the same interpretation on previously admitted targets.
pub(crate) fn validate_successor(previous: &PortDefinition, next: &PortDefinition) -> Result<()> {
    let Some(previous_loader) = configured_loader(previous) else {
        return Ok(());
    };
    let compatible = configured_loader(next).is_some_and(|loader| {
        loader.engine == previous_loader.engine
            && loader
                .repository
                .eq_ignore_ascii_case(&previous_loader.repository)
            && loader.settings_file == previous_loader.settings_file
            && loader.native_game == previous_loader.native_game
            && loader.minimum == previous_loader.minimum
            && previous_loader
                .platforms
                .iter()
                .all(|platform| loader.platforms.contains(platform))
    });
    if !compatible || (previous.mod_loader.is_some() && next.mod_loader.is_none()) {
        return Err(PortcoveError::verification(
            "a definition successor changes the established native mod loader bindings",
        )
        .detail("port_id", &previous.id));
    }
    Ok(())
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
    version[0] == loader.minimum[0]
        && version >= loader.minimum
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

pub(crate) fn installed_loader(
    install: &InstallRecord,
    build: &RetainedBuildIdentity,
) -> Result<Option<ReviewedLoader>> {
    #[cfg(test)]
    if install.port_id == "starship" {
        return Ok(Some(STARSHIP_FIXTURE.clone()));
    }
    let Some(catalog) = crate::install::retained_catalog_for_install(install)? else {
        return Ok(None);
    };
    let port = catalog.port(&install.port_id)?;
    let Some(loader) = definition_loader(port, build.platform) else {
        return Ok(None);
    };
    Ok((install.runtime.is_none()
        && contract_matches(
            &loader,
            port,
            build.platform,
            &build.selected_executable,
            &install.version,
        ))
    .then_some(loader))
}

pub(crate) fn require_contract(
    install: &InstallRecord,
    build: &RetainedBuildIdentity,
    declared: Option<&LoaderContractRef>,
    needs_loader: bool,
) -> Result<Option<ReviewedLoader>> {
    let derived = installed_loader(install, build)?;
    if (needs_loader && derived.is_none())
        || declared.is_some_and(|declared| {
            !derived
                .as_ref()
                .is_some_and(|loader| *declared == loader.engine.reference())
        })
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
    loader: &ReviewedLoader,
) -> Result<()> {
    let Some(game) = loader.native_game.as_deref() else {
        return Ok(());
    };
    let mut enabled = BTreeMap::new();
    for package in revision.packages.iter().filter(|package| package.enabled) {
        let inspected = inspect_retained_recomp(layout, package, game)?;
        enabled.insert(inspected.native_id.clone(), inspected);
    }
    validate_recomp_versions(
        &enabled,
        runtime.strip_prefix('v').unwrap_or(runtime),
        loader.recomp_builtins(),
    )
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
    builtins: &[&str],
) -> Result<()> {
    validate_recomp_versions_allowing_missing(enabled, runtime, builtins, None)
}

fn validate_recomp_versions_allowing_missing(
    enabled: &BTreeMap<String, RecompModInspection>,
    runtime: &str,
    builtins: &[&str],
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
                    .or(match (builtins.contains(&name), runtime, name) {
                        // The official v1.2.2 source embeds this exact NRM.
                        // Later builds with no verified version still satisfy
                        // unconstrained built-in dependencies below.
                        (true, "1.2.2", "mm_recomp_dpad_builtin") => Some("1.0.0"),
                        _ => None,
                    }),
            };
            if let Some(available) = available {
                if let Some(required) = &dependency.minimum_version {
                    minimum(available, required, id, &dependency.id)?;
                }
            } else if builtins.contains(&dependency.id.as_str()) {
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
    fn install_for_loader(&self, build: &RetainedBuildIdentity) -> Result<InstallRecord> {
        Library::install_by_id(&self.library.connection()?, Some(&build.install_id))?
            .filter(|install| build.matches_install(install))
            .ok_or_else(|| {
                PortcoveError::conflict("the installed runtime changed; review the setup again")
            })
    }

    pub(crate) fn layout_for_install(&self, install: &InstallRecord) -> Result<Option<Layout>> {
        if crate::install::retained_catalog_for_install(install)?.is_none() {
            return Ok(None);
        }
        let build = crate::install::retained_build_identity_for_install(install)?;
        Ok(installed_loader(install, &build)?.map(|loader| {
            Layout::for_user(&self.library.user_dir(&install.port_id)).with_loader(loader)
        }))
    }

    pub(crate) fn layout_for_revision(&self, revision: &ProfileRevision) -> Result<Option<Layout>> {
        let install = self.install_for_loader(&revision.build)?;
        let needs_loader = revision.packages.iter().any(|package| package.enabled);
        let loader = require_contract(
            &install,
            &revision.build,
            revision.loader.as_ref(),
            needs_loader,
        )?;
        Ok(loader.map(|loader| {
            Layout::for_user(&self.library.user_dir(&revision.build.port_id)).with_loader(loader)
        }))
    }

    pub(crate) fn require_layout_for_revision(&self, revision: &ProfileRevision) -> Result<Layout> {
        self.layout_for_revision(revision)?.ok_or_else(|| {
            PortcoveError::unsupported("the selected build has no reviewed mod loader")
        })
    }

    /// Resolves a writer's loader choice from the already verified install.
    pub(crate) fn profile_loader_binding(
        &self,
        build: &RetainedBuildIdentity,
        declared: Option<&LoaderContractRef>,
        needs_loader: bool,
    ) -> Result<Option<LoaderContractRef>> {
        let install = self.install_for_loader(build)?;
        Ok(require_contract(&install, build, declared, needs_loader)?
            .map(|loader| loader.engine.reference()))
    }

    /// Reviews the enabled set that an exact package replacement would publish.
    pub(crate) fn review_recomp_changes<'a>(
        &self,
        layout: &Layout,
        current: &ProfileRevision,
        staged: impl IntoIterator<Item = &'a RecompModInspection>,
        missing_local: Option<(&str, &[String])>,
    ) -> Result<()> {
        use crate::native_mod_list::native_name;
        let staged = staged.into_iter().collect::<Vec<_>>();
        let replaces = |inspection: &RecompModInspection, package: &ResolvedPackage| {
            inspection
                .native_id
                .eq_ignore_ascii_case(native_name(&package.native_id))
        };
        let mut retained = current
            .packages
            .iter()
            .filter(|package| package.enabled && !staged.iter().any(|item| replaces(item, package)))
            .peekable();
        let mut replacements = staged
            .iter()
            .copied()
            .filter(|inspection| {
                current
                    .packages
                    .iter()
                    .all(|package| package.enabled || !replaces(inspection, package))
            })
            .peekable();
        if retained.peek().is_none() && replacements.peek().is_none() {
            return Ok(());
        }
        let install = self.install_for_loader(&current.build)?;
        let Some(loader) =
            require_contract(&install, &current.build, current.loader.as_ref(), true)?
        else {
            return Ok(());
        };
        let Some(game) = loader.native_game.as_deref() else {
            return Ok(());
        };
        let mut enabled = BTreeMap::new();
        for package in retained {
            let inspection = inspect_retained_recomp(layout, package, game)?;
            enabled.insert(inspection.native_id.clone(), inspection);
        }
        for inspection in replacements {
            if inspection.game_id != game {
                return Err(PortcoveError::verification(
                    "the mod was reviewed for a different native game",
                )
                .detail("game", &inspection.game_id));
            }
            enabled.insert(inspection.native_id.clone(), inspection.clone());
        }
        let runtime = install
            .version
            .strip_prefix('v')
            .unwrap_or(&install.version);
        validate_recomp_versions_allowing_missing(
            &enabled,
            runtime,
            loader.recomp_builtins(),
            missing_local,
        )
        .map_err(|error| error.detail("review_stage", RECOMP_DEPENDENCY_REVIEW))
    }

    pub(crate) fn require_revision_loader(&self, revision: &ProfileRevision) -> Result<()> {
        if revision.packages.iter().any(|package| package.enabled) {
            let install = self.install_for_loader(&revision.build)?;
            if let Some(loader) =
                require_contract(&install, &revision.build, revision.loader.as_ref(), true)?
            {
                let layout = Layout::for_user(&self.library.user_dir(&revision.build.port_id));
                require_recomp_versions(&layout, revision, &install.version, &loader)?;
            }
        }
        Ok(())
    }

    /// Launch consumes the exact installation selected by the runtime owner.
    pub(crate) fn require_selected_loader_for_install(
        &self,
        install: &InstallRecord,
    ) -> Result<()> {
        self.require_no_switch_journal(&install.port_id)?;
        self.optional_deploy_layout(&install.port_id)?;
        let connection = self.library.connection()?;
        let Some((profile_id, number)) = profile::selection(&connection, &install.port_id)? else {
            return Ok(());
        };
        let revision = profile::revision_by_number(&connection, &profile_id, number)?;
        if revision.build.install_id != install.id
            && (self.layout_for_revision(&revision)?.is_some()
                || self.layout_for_install(install)?.is_some())
        {
            return Err(PortcoveError::conflict(
                "the selected setup and launch runtime differ; finish applying the setup before playing",
            ));
        }
        if revision.packages.iter().any(|package| package.enabled) {
            let build = crate::install::retained_build_identity_for_install(install)?;
            if let Some(loader) = require_contract(install, &build, revision.loader.as_ref(), true)?
            {
                let layout = Layout::for_user(&self.library.user_dir(&install.port_id));
                require_recomp_versions(&layout, &revision, &install.version, &loader)?;
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
        let old_runtime =
            validate_recomp_versions(&enabled, "1.2.1", RECOMP.recomp_builtins()).unwrap_err();
        assert_eq!(old_runtime.details["requires"], "game runtime");
        let old_library =
            validate_recomp_versions(&enabled, "1.2.2", RECOMP.recomp_builtins()).unwrap_err();
        assert_eq!(old_library.details["requires"], "library");
        assert_eq!(old_library.details["minimum_version"], "2.0.0");

        let library = enabled.get_mut("library").unwrap();
        library.native_version = "2.0.0-local".into();
        assert!(validate_recomp_versions(&enabled, "1.2.2", RECOMP.recomp_builtins()).is_ok());
        enabled
            .get_mut("library")
            .unwrap()
            .dependencies
            .push(crate::RecompDependency {
                id: "addon".into(),
                minimum_version: None,
            });
        let cycle =
            validate_recomp_versions(&enabled, "1.2.2", RECOMP.recomp_builtins()).unwrap_err();
        assert!(cycle.message.contains("cycle"));
        enabled.remove("library");
        let missing =
            validate_recomp_versions(&enabled, "1.2.2", RECOMP.recomp_builtins()).unwrap_err();
        assert_eq!(missing.details["requires"], "library");

        let mut addon = inspection("addon", "1.1.0", "1.2.2");
        addon.dependencies.push(crate::RecompDependency {
            id: "mm_recomp_dpad_builtin".into(),
            minimum_version: Some("1.0.0".into()),
        });
        let mut enabled = BTreeMap::from([("addon".into(), addon)]);
        assert!(validate_recomp_versions(&enabled, "1.2.2", RECOMP.recomp_builtins()).is_ok());
        assert!(
            validate_recomp_versions(&enabled, "1.2.3", RECOMP.recomp_builtins())
                .unwrap_err()
                .message
                .contains("built-in")
        );
        enabled.get_mut("addon").unwrap().dependencies[0].minimum_version = None;
        assert!(validate_recomp_versions(&enabled, "1.2.3", RECOMP.recomp_builtins()).is_ok());
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
    fn a_new_port_uses_its_authored_loader_for_ordinary_successors() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("shipwright").unwrap().clone();
        port.id = "unseen-compatible-libultraship".into();
        port.release.repository = "reviewed-upstream/new-port".into();
        let binding = port.mod_loader.as_mut().unwrap();
        binding.repository.clone_from(&port.release.repository);
        binding.settings_file = "new-port.json".into();
        port.persistent_paths
            .retain(|path| path != "shipofharkinian.json");
        port.persistent_paths.push("new-port.json".into());
        validate(&port).unwrap();

        let platform = Platform::WindowsX86_64;
        let loader = definition_loader(&port, platform).unwrap();
        assert_eq!(loader.engine, ModEngine::Libultraship);
        assert_eq!(loader.settings_file, "new-port.json");
        assert!(contract_matches(
            &loader,
            &port,
            platform,
            Path::new("soh.exe"),
            "v9.5.1"
        ));
        assert!(definition_loader(&port, Platform::MacosAarch64).is_none());

        let mut wrong_upstream = port.clone();
        wrong_upstream.release.repository = "other-publisher/new-port".into();
        assert!(validate(&wrong_upstream).is_err());
        assert!(definition_loader(&wrong_upstream, platform).is_none());

        let mut incompatible = port.clone();
        incompatible.mod_loader.as_mut().unwrap().settings_file = "other.json".into();
        incompatible.persistent_paths.push("other.json".into());
        validate(&incompatible).unwrap();
        assert!(validate_successor(&port, &incompatible).is_err());

        let mut unbound = port.clone();
        unbound.mod_loader = None;
        assert!(definition_loader(&unbound, platform).is_none());
        assert!(validate_successor(&port, &unbound).is_err());
    }

    #[test]
    fn equal_port_ids_do_not_carry_loader_admission_to_other_builds() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut ship = catalog.port("shipwright").unwrap().clone();
        let executable = Path::new("soh.exe");
        let windows = Platform::WindowsX86_64;
        let matches = |port: &PortDefinition, platform, executable: &Path, release: &str| {
            definition_loader(port, platform).is_some_and(|loader| {
                contract_matches(&loader, port, platform, executable, release)
            })
        };
        assert!(matches(&ship, windows, executable, "v9.3.1"));
        assert!(matches(&ship, windows, executable, "v9.4.0"));
        assert!(!matches(&ship, windows, executable, "v9.2.2"));
        assert!(!matches(&ship, windows, executable, "v10.0.0"));
        assert!(!matches(&ship, windows, executable, "v9.4.0-rc.1"));
        assert!(!matches(&ship, windows, Path::new("other.exe"), "v9.3.1"));
        assert!(!matches(
            &ship,
            Platform::MacosAarch64,
            executable,
            "v9.3.1"
        ));

        ship.release.repository = "someone/Shipwright".into();
        assert!(!matches(&ship, windows, executable, "v9.3.1"));
    }
}
