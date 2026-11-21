use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use super::*;

use crate::{
    Library, LoaderContractRef, ProfileRevision, RecompCompanionMemberV1, RecompCompanionRole,
    RetainedBuildIdentity, profile,
};

const MAX_PLAN_BYTES: u64 = 256 * 1024;

/// A private, inert acquisition reviewed against one exact retained setup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GithubCompoundPlan {
    pub profile_id: String,
    pub profile_revision: u64,
    pub profile_revision_sha256: String,
    pub build: RetainedBuildIdentity,
    pub loader: LoaderContractRef,
    pub runtime_version: String,
    pub repository: String,
    pub repository_id: u64,
    pub release_id: u64,
    pub release_tag: String,
    pub asset_id: u64,
    pub wrapper_sha256: String,
    pub wrapper_bytes: u64,
    pub members: BTreeMap<String, RecompCompanionMemberV1>,
}

/// An affirmative choice for every host library in a specific plan. This
/// receipt cannot authorize an ordinary package or a later compound release.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GithubCompoundConsent {
    pub plan_sha256: String,
    pub native_libraries: BTreeMap<String, String>,
}

impl GithubCompoundPlan {
    pub fn sha256(&self) -> Result<String> {
        Ok(hex::encode(Sha256::digest(serde_json::to_vec(self)?)))
    }
}

fn load_revision(library: &Library, port: &str, profile: &str) -> Result<ProfileRevision> {
    profile::current_revision(&library.connection()?, port, profile)
}

fn install_for_plan(library: &Library, revision: &ProfileRevision) -> Result<crate::InstallRecord> {
    Library::install_by_id(&library.connection()?, Some(&revision.build.install_id))?
        .filter(|install| revision.build.matches_install(install))
        .ok_or_else(|| PortcoveError::conflict("the reviewed retained installation changed"))
}

fn check_revision(plan: &GithubCompoundPlan, revision: &ProfileRevision) -> Result<()> {
    if revision.profile_id != plan.profile_id
        || revision.revision != plan.profile_revision
        || revision.digest != plan.profile_revision_sha256
        || revision.build != plan.build
        || revision
            .loader
            .as_ref()
            .is_some_and(|loader| loader != &plan.loader)
    {
        return Err(PortcoveError::conflict("the reviewed setup changed"));
    }
    Ok(())
}

fn check_runtime(installed: &str, review: &RecompCompoundReview) -> Result<()> {
    let runtime =
        crate::recomp_mod::version_parts(installed.trim_start_matches('v')).ok_or_else(|| {
            PortcoveError::unsupported("the retained runtime version cannot be checked")
        })?;
    for item in &review.mods {
        let minimum =
            crate::recomp_mod::version_parts(&item.minimum_runtime_version).ok_or_else(|| {
                PortcoveError::verification("the mod runtime requirement is unsupported")
            })?;
        if runtime < minimum {
            return Err(PortcoveError::unsupported(
                "the retained runtime is older than this mod requires",
            ));
        }
    }
    Ok(())
}

fn storage(library: &Library, port_id: &str) -> Result<PathBuf> {
    if !crate::profile::valid_native_id(port_id)
        || !port_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(PortcoveError::usage("invalid compound custody port ID"));
    }
    Ok(library
        .user_dir(port_id)
        .join(crate::profile_deploy::STORE)
        .join("compound-intake"))
}

fn bounded_digest(path: &Path, expected_sha256: &str, expected_bytes: u64) -> Result<()> {
    let (sha256, size) =
        crate::external_runtime::hash_stable_regular(path, expected_bytes, &|| Ok(()))?;
    if size != expected_bytes || sha256 != expected_sha256 {
        return Err(PortcoveError::verification(
            "private compound package bytes changed",
        ));
    }
    Ok(())
}

fn verify_files(path: &Path, plan: &GithubCompoundPlan) -> Result<()> {
    if !(1..=MAX_WRAPPER_BYTES).contains(&plan.wrapper_bytes)
        || plan.members.is_empty()
        || plan.members.len() > crate::mod_package::MAX_MEMBERS
        || plan
            .members
            .values()
            .try_fold(0u64, |total, member| {
                if !(1..=recomp_companion_review::MAX_MEMBER_BYTES).contains(&member.size) {
                    return None;
                }
                total
                    .checked_add(member.size)
                    .filter(|bytes| *bytes <= MAX_WRAPPER_BYTES)
            })
            .is_none()
    {
        return Err(PortcoveError::verification(
            "private compound plan exceeds the reviewed file bounds",
        ));
    }
    crate::path::refuse_symlink_ancestors(path)?;
    bounded_digest(
        &path.join("wrapper.zip"),
        &plan.wrapper_sha256,
        plan.wrapper_bytes,
    )?;
    let member_root = path.join("members");
    crate::path::refuse_symlink_ancestors(&member_root)?;
    let mut count = 0;
    for entry in fs::read_dir(&member_root)? {
        let entry = entry?;
        let name = entry.file_name();
        let member = name
            .to_str()
            .and_then(|name| plan.members.get(name))
            .ok_or_else(|| PortcoveError::verification("unexpected private compound member"))?;
        bounded_digest(&entry.path(), &member.sha256, member.size)?;
        count += 1;
    }
    if count != plan.members.len() {
        return Err(PortcoveError::verification(
            "a private compound member is missing",
        ));
    }
    Ok(())
}

fn read_plan(path: &Path, digest: &str) -> Result<GithubCompoundPlan> {
    crate::path::refuse_symlink_ancestors(path)?;
    let plan: GithubCompoundPlan = serde_json::from_slice(&crate::path::read_bounded_regular(
        &path.join("plan.json"),
        MAX_PLAN_BYTES,
    )?)?;
    if plan.sha256()? != digest {
        return Err(PortcoveError::verification(
            "private compound plan identity changed",
        ));
    }
    verify_files(path, &plan)?;
    Ok(plan)
}

fn verify_wrapper(
    path: &Path,
    plan: &GithubCompoundPlan,
    source: ReviewedSource,
    layout: CompanionLayout,
) -> Result<()> {
    if plan.repository_id != source.repository_id
        || plan.repository != source.repository
        || plan.build.platform != layout.platform
        || plan.release_id == 0
        || plan.asset_id == 0
        || plan.release_tag.is_empty()
    {
        return Err(PortcoveError::verification(
            "private compound plan differs from the retained reviewed source",
        ));
    }
    let staged = recomp_companion_review::stage(
        &path.join("wrapper.zip"),
        plan.wrapper_bytes,
        &plan.wrapper_sha256,
        source.game,
        layout,
        source.companions,
    )?;
    check_runtime(&plan.runtime_version, &staged.review)?;
    if reviewed_members(layout, &staged)? != plan.members {
        return Err(PortcoveError::verification(
            "private compound member inventory does not come from the exact wrapper",
        ));
    }
    Ok(())
}

fn assert_plan_digest(digest: &str) -> Result<()> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(PortcoveError::usage(
            "an exact compound plan SHA-256 is required",
        ));
    }
    Ok(())
}

fn exact_consent(plan: &GithubCompoundPlan, consent: &GithubCompoundConsent) -> Result<()> {
    let required = plan
        .members
        .iter()
        .filter(|(_, member)| member.role != RecompCompanionRole::Nrm)
        .map(|(name, member)| (name.clone(), member.sha256.clone()))
        .collect::<BTreeMap<_, _>>();
    if required.is_empty()
        || consent.plan_sha256 != plan.sha256()?
        || consent.native_libraries != required
    {
        return Err(PortcoveError::conflict(
            "explicit consent must cover every exact host library in this plan",
        ));
    }
    Ok(())
}

fn copy_member(source: &Path, target: &Path) -> Result<()> {
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    std::io::copy(&mut fs::File::open(source)?, &mut output)?;
    output.sync_all()?;
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or_else(|| {
        PortcoveError::state("the private compound receipt directory is missing")
    })?)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist_noclobber(path).map_err(|error| error.error)?;
    Ok(())
}

fn publish_plan(
    root: &Path,
    plan: &GithubCompoundPlan,
    staged: &recomp_companion_review::StagedCompoundReview,
) -> Result<()> {
    crate::path::refuse_symlink_ancestors(root)?;
    fs::create_dir_all(root)?;
    let digest = plan.sha256()?;
    let destination = root.join(&digest);
    if destination.try_exists()? {
        return read_plan(&destination, &digest).map(|_| ());
    }
    let pending = tempfile::tempdir_in(root)?;
    let members = pending.path().join("members");
    fs::create_dir(&members)?;
    copy_member(&staged.wrapper, &pending.path().join("wrapper.zip"))?;
    for (name, source) in &staged.members {
        copy_member(source, &members.join(name))?;
    }
    let bytes = serde_json::to_vec(plan)?;
    if bytes.len() as u64 > MAX_PLAN_BYTES {
        return Err(PortcoveError::usage(
            "the exact compound plan exceeds its size limit",
        ));
    }
    write_new(&pending.path().join("plan.json"), &bytes)?;
    verify_files(pending.path(), plan)?;
    crate::durability::sync_publication(&members)?;
    crate::durability::sync_publication(pending.path())?;
    fs::rename(pending.path(), &destination)?;
    crate::durability::sync_publication(root)?;
    Ok(())
}

fn reviewed_members(
    layout: CompanionLayout,
    staged: &recomp_companion_review::StagedCompoundReview,
) -> Result<BTreeMap<String, RecompCompanionMemberV1>> {
    let primary_name = format!(
        "{}{}",
        layout.declared_library,
        if layout.platform == Platform::WindowsX86_64 {
            ".dll"
        } else {
            ".so"
        }
    );
    let mut members = BTreeMap::new();
    for item in &staged.review.mods {
        members.insert(
            format!("{}.nrm", item.native_id),
            RecompCompanionMemberV1 {
                size: item.size,
                sha256: item.sha256.clone(),
                role: RecompCompanionRole::Nrm,
            },
        );
    }
    for item in &staged.review.companions {
        members.insert(
            item.file_name.clone(),
            RecompCompanionMemberV1 {
                size: item.bytes,
                sha256: item.sha256.clone(),
                role: if item.file_name == primary_name {
                    RecompCompanionRole::PrimaryLibrary
                } else {
                    RecompCompanionRole::BundledLibrary
                },
            },
        );
    }
    if members.len() != staged.members.len() || !members.contains_key(&primary_name) {
        return Err(PortcoveError::verification(
            "the reviewed compound member inventory differs",
        ));
    }
    Ok(members)
}

fn publish_consent(
    root: &Path,
    plan: &GithubCompoundPlan,
    consent: &GithubCompoundConsent,
) -> Result<()> {
    exact_consent(plan, consent)?;
    let path = root.join("consent.json");
    let bytes = serde_json::to_vec(consent)?;
    if path.try_exists()? {
        if crate::path::read_bounded_regular(&path, MAX_PLAN_BYTES)? != bytes {
            return Err(PortcoveError::verification(
                "stored compound consent differs",
            ));
        }
        return Ok(());
    }
    write_new(&path, &bytes)?;
    crate::durability::sync_publication(root)?;
    Ok(())
}

impl PortcoveService {
    /// Acquire and review an immutable public ZIP for the platform of a retained
    /// setup. Publication is limited to private intake; gameplay is unaffected.
    pub async fn prepare_github_compound_plan(
        &self,
        port_id: &str,
        profile_id: &str,
        expected_revision: u64,
        release_id: u64,
        asset_id: u64,
        release_tag: &str,
    ) -> Result<GithubCompoundPlan> {
        let revision = load_revision(self.library(), port_id, profile_id)?;
        if revision.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "the reviewed setup revision changed",
            ));
        }
        let loader = self
            .profile_loader_binding(&revision.build, revision.loader.as_ref(), true)?
            .filter(|loader| loader == &ModEngine::N64Recomp.reference())
            .ok_or_else(|| PortcoveError::unsupported("a retained Recomp loader is required"))?;
        let install = install_for_plan(self.library(), &revision)?;
        let retained = crate::install::retained_catalog_for_install(&install)?
            .ok_or_else(|| PortcoveError::unsupported("retained runtime catalog is unavailable"))?;
        let port = retained.port(port_id)?;
        let (source, layout, selected_tag, staged) = self
            .stage_github_mod_archive(
                port,
                revision.build.platform,
                release_id,
                asset_id,
                Some(release_tag),
                None,
            )
            .await?;
        check_runtime(&install.version, &staged.review)?;
        let members = reviewed_members(layout, &staged)?;
        let plan = GithubCompoundPlan {
            profile_id: revision.profile_id.clone(),
            profile_revision: revision.revision,
            profile_revision_sha256: revision.digest.clone(),
            build: revision.build.clone(),
            loader,
            runtime_version: install.version,
            repository: source.repository.into(),
            repository_id: source.repository_id,
            release_id,
            release_tag: selected_tag,
            asset_id,
            wrapper_sha256: staged.review.archive_sha256.clone(),
            wrapper_bytes: staged.review.archive_bytes,
            members,
        };
        let library = self.library().clone();
        tokio::task::spawn_blocking(move || {
            let port_id = &plan.build.port_id;
            let _lock = library.try_lock_port(port_id, "stage-compound-mod-package")?;
            let current = load_revision(&library, port_id, &plan.profile_id)?;
            check_revision(&plan, &current)?;
            install_for_plan(&library, &current)?;
            library.prepare_user_directory(port_id, &|| Ok(()))?;
            publish_plan(&storage(&library, port_id)?, &plan, &staged)?;
            Ok(plan)
        })
        .await
        .map_err(|_| PortcoveError::state("compound custody worker stopped"))?
    }

    /// Verify the exact pending custody record after process restart. No bytes
    /// are acquired from the provider during this read.
    pub fn read_github_compound_plan(
        &self,
        port_id: &str,
        plan_digest: &str,
    ) -> Result<GithubCompoundPlan> {
        assert_plan_digest(plan_digest)?;
        let root = storage(self.library(), port_id)?.join(plan_digest);
        let plan = read_plan(&root, plan_digest)?;
        if plan.build.port_id != port_id {
            return Err(PortcoveError::verification(
                "compound plan escaped its port",
            ));
        }
        let connection = self.library().connection()?;
        profile::profile_by_id(&connection, port_id, &plan.profile_id)?;
        let revision =
            profile::revision_by_number(&connection, &plan.profile_id, plan.profile_revision)?;
        check_revision(&plan, &revision)?;
        let install = install_for_plan(self.library(), &revision)?;
        if install.version != plan.runtime_version
            || self
                .profile_loader_binding(&revision.build, Some(&plan.loader), true)?
                .as_ref()
                != Some(&plan.loader)
        {
            return Err(PortcoveError::conflict(
                "the admitted runtime or loader changed",
            ));
        }
        let retained = crate::install::retained_catalog_for_install(&install)?
            .ok_or_else(|| PortcoveError::unsupported("retained runtime catalog is unavailable"))?;
        let source = reviewed_source(retained.port(port_id)?)
            .ok_or_else(|| PortcoveError::unsupported("retained compound source is unavailable"))?;
        let layout = source
            .companions
            .iter()
            .copied()
            .find(|layout| layout.platform == revision.build.platform)
            .ok_or_else(|| {
                PortcoveError::unsupported("retained companion layout is unavailable")
            })?;
        verify_wrapper(&root, &plan, source, layout)?;
        Ok(plan)
    }

    /// Read a historical choice only when its retained build and stored files
    /// still match. A future activation must separately match the current setup
    /// and its exact consent before touching native files.
    pub fn verify_github_compound_consent(
        &self,
        port_id: &str,
        plan_digest: &str,
    ) -> Result<GithubCompoundConsent> {
        let plan = self.read_github_compound_plan(port_id, plan_digest)?;
        let path = storage(self.library(), port_id)?
            .join(plan_digest)
            .join("consent.json");
        let consent: GithubCompoundConsent =
            serde_json::from_slice(&crate::path::read_bounded_regular(&path, MAX_PLAN_BYTES)?)?;
        exact_consent(&plan, &consent)?;
        Ok(consent)
    }

    /// Persist explicit consent in private custody. No setup revision, code
    /// approval for ordinary NRMs or native mod directory is updated.
    pub fn record_github_compound_consent(
        &self,
        port_id: &str,
        consent: &GithubCompoundConsent,
    ) -> Result<()> {
        assert_plan_digest(&consent.plan_sha256)?;
        let root = storage(self.library(), port_id)?.join(&consent.plan_sha256);
        let _lock = self
            .library()
            .try_lock_port(port_id, "record-compound-mod-consent")?;
        let plan = self.read_github_compound_plan(port_id, &consent.plan_sha256)?;
        let revision = load_revision(self.library(), port_id, &plan.profile_id)?;
        check_revision(&plan, &revision)?;
        let install = install_for_plan(self.library(), &revision)?;
        if install.version != plan.runtime_version
            || self
                .profile_loader_binding(&revision.build, Some(&plan.loader), true)?
                .as_ref()
                != Some(&plan.loader)
        {
            return Err(PortcoveError::conflict(
                "the admitted runtime or loader changed",
            ));
        }
        publish_consent(&root, &plan, consent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compound_consent_is_neither_a_wrapper_hash_nor_an_nrm_choice() {
        let (_temporary, _service, install) = crate::retained_build::tests::fixture();
        let build = crate::install::retained_build_identity_for_install(&install).unwrap();
        let plan = GithubCompoundPlan {
            profile_id: "fixture".into(),
            profile_revision: 1,
            profile_revision_sha256: "f".repeat(64),
            build,
            loader: ModEngine::N64Recomp.reference(),
            runtime_version: "1.2.2".into(),
            repository: "Owner/Mod".into(),
            repository_id: 1,
            release_id: 2,
            release_tag: "v1".into(),
            asset_id: 3,
            wrapper_sha256: "a".repeat(64),
            wrapper_bytes: 256,
            members: BTreeMap::from([
                (
                    "mod.nrm".into(),
                    RecompCompanionMemberV1 {
                        size: 10,
                        sha256: "b".repeat(64),
                        role: RecompCompanionRole::Nrm,
                    },
                ),
                (
                    "mod.dll".into(),
                    RecompCompanionMemberV1 {
                        size: 30,
                        sha256: "c".repeat(64),
                        role: RecompCompanionRole::PrimaryLibrary,
                    },
                ),
            ]),
        };
        let root = tempfile::tempdir().unwrap();
        let mut oversized = plan.clone();
        oversized.wrapper_bytes = MAX_WRAPPER_BYTES + 1;
        let err = verify_files(root.path(), &oversized).unwrap_err();
        assert!(err.to_string().contains("exceeds the reviewed file bounds"));
        let choice = GithubCompoundConsent {
            plan_sha256: plan.sha256().unwrap(),
            native_libraries: BTreeMap::from([("mod.dll".into(), "c".repeat(64))]),
        };
        assert!(exact_consent(&plan, &choice).is_ok());
        let wrapper_only = GithubCompoundConsent {
            plan_sha256: plan.wrapper_sha256.clone(),
            ..choice.clone()
        };
        assert!(exact_consent(&plan, &wrapper_only).is_err());
        let nrm_only = GithubCompoundConsent {
            native_libraries: BTreeMap::from([("mod.nrm".into(), "b".repeat(64))]),
            ..choice.clone()
        };
        assert!(exact_consent(&plan, &nrm_only).is_err());
        let mut successor = plan;
        successor.members.get_mut("mod.dll").unwrap().sha256 = "d".repeat(64);
        assert!(exact_consent(&successor, &choice).is_err());
    }

    #[test]
    #[ignore = "requires verified upstream ZIP fixtures in PORTCOVE_TEST_COMPOUND_WRAPPERS"]
    fn genuine_companion_successor_requires_its_own_choice_and_survives_reopen() {
        let root = PathBuf::from(std::env::var_os("PORTCOVE_TEST_COMPOUND_WRAPPERS").unwrap());
        let (_temporary, _service, install) = crate::retained_build::tests::fixture();
        let build = crate::install::retained_build_identity_for_install(&install).unwrap();
        let private = tempfile::tempdir().unwrap();
        let source = SOURCES[0];
        for layout in source.companions {
            let build = RetainedBuildIdentity {
                platform: layout.platform,
                ..build.clone()
            };
            let verify = |asset_id, release_id, tag: &str, bytes, digest: &str| {
                let staged = recomp_companion_review::stage(
                    &root.join(format!("{asset_id}.zip")),
                    bytes,
                    digest,
                    source.game,
                    *layout,
                    source.companions,
                )
                .unwrap();
                assert_eq!(staged.review.mods.len(), 6);
                assert_eq!(staged.review.companions.len(), 2);
                assert!(check_runtime("1.0.0", &staged.review).is_err());
                assert!(check_runtime("1.2.2", &staged.review).is_ok());
                let plan = GithubCompoundPlan {
                    profile_id: "fixture".into(),
                    profile_revision: 1,
                    profile_revision_sha256: "a".repeat(64),
                    build: build.clone(),
                    loader: ModEngine::N64Recomp.reference(),
                    runtime_version: "1.2.2".into(),
                    repository: source.repository.into(),
                    repository_id: source.repository_id,
                    release_id,
                    release_tag: tag.into(),
                    asset_id,
                    wrapper_sha256: digest.into(),
                    wrapper_bytes: bytes,
                    members: reviewed_members(*layout, &staged).unwrap(),
                };
                publish_plan(private.path(), &plan, &staged).unwrap();
                let key = plan.sha256().unwrap();
                let path = private.path().join(&key);
                drop(staged);
                assert_eq!(read_plan(&path, &key).unwrap(), plan);
                let consent = GithubCompoundConsent {
                    plan_sha256: key,
                    native_libraries: plan
                        .members
                        .iter()
                        .filter(|(_, member)| member.role != RecompCompanionRole::Nrm)
                        .map(|(name, member)| (name.clone(), member.sha256.clone()))
                        .collect(),
                };
                let mut incomplete = consent.clone();
                incomplete.native_libraries.pop_first();
                assert!(publish_consent(&path, &plan, &incomplete).is_err());
                assert!(!path.join("consent.json").exists());
                (plan, consent, path)
            };
            let (old, consent, old_path) = verify(
                319816241,
                262724936,
                "v0.9.5",
                23814109,
                "a7e360e1e01f680316803e729e23e75f54f4d4169b254a28338ba1dc7297ba84",
            );
            let (new, new_consent, new_path) = verify(
                337279656,
                274707236,
                "v0.9.5a",
                23239098,
                "0725c897f7f04eaff8f40447da25a7eb0b0dd2b4e1b74d1919b5097f4157216a",
            );
            assert!(
                old.members
                    .iter()
                    .filter(|(_, member)| member.role == RecompCompanionRole::Nrm)
                    .all(|(name, member)| new.members.get(name) == Some(member))
            );
            assert_ne!(consent.native_libraries, new_consent.native_libraries);
            publish_consent(&old_path, &old, &consent).unwrap();
            assert!(publish_consent(&new_path, &new, &consent).is_err());
            publish_consent(&new_path, &new, &new_consent).unwrap();
            let reloaded: GithubCompoundConsent =
                serde_json::from_slice(&fs::read(new_path.join("consent.json")).unwrap()).unwrap();
            exact_consent(
                &read_plan(&new_path, &reloaded.plan_sha256).unwrap(),
                &reloaded,
            )
            .unwrap();
            verify_wrapper(&new_path, &new, source, *layout).unwrap();
            let mut wrong_source = new.clone();
            wrong_source.repository_id += 1;
            assert!(verify_wrapper(&new_path, &wrong_source, source, *layout).is_err());
            let mut forged = new.clone();
            forged
                .members
                .get_mut(new_consent.native_libraries.keys().next().unwrap())
                .unwrap()
                .sha256 = "f".repeat(64);
            let error = verify_wrapper(&new_path, &forged, source, *layout).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("does not come from the exact wrapper")
            );
            let name = new_consent.native_libraries.keys().next().unwrap();
            fs::write(new_path.join("members").join(name), b"changed").unwrap();
            assert!(read_plan(&new_path, &new_consent.plan_sha256).is_err());
            assert_eq!(read_plan(&old_path, &consent.plan_sha256).unwrap(), old);
        }
    }
}
