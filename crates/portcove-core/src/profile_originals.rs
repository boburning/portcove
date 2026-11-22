//! Select or relink admitted original game files without rebasing other setups.

use std::path::{Path, PathBuf};

use rusqlite::TransactionBehavior;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Catalog, InstallRecord, Library, OriginalBinding, PortcoveError, PortcoveService,
    ProfileRevision, ProfileRevisionRequest, Result, SourceProfile, SourceRecord, profile,
    source_instances,
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProfileOriginalInstance {
    pub instance_id: String,
    pub binding: OriginalBinding,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProfileOriginalReview {
    pub source_profile: SourceProfile,
    pub current_instance_id: String,
    pub current_path: Option<PathBuf>,
    pub embedded: bool,
    /// Other saved instances whose current bytes the retained contract admits.
    pub instances: Vec<ProfileOriginalInstance>,
}

impl PortcoveService {
    pub fn profile_original_instances(
        &self,
        port_id: &str,
        profile_id: &str,
        requirement_id: &str,
    ) -> Result<Vec<ProfileOriginalInstance>> {
        let current = profile::current_revision(&self.library.connection()?, port_id, profile_id)?;
        let (catalog, install) =
            self.profile_original_contract(port_id, &current, requirement_id)?;
        self.require_selectable_original(&catalog, &install)?;
        self.registered_original_instances(requirement_id)
    }

    pub fn review_profile_original(
        &self,
        port_id: &str,
        profile_id: &str,
        expected_revision: u64,
        requirement_id: &str,
    ) -> Result<ProfileOriginalReview> {
        let current = profile::current_revision(&self.library.connection()?, port_id, profile_id)?;
        if current.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "the setup changed after review; review the original it uses again",
            ));
        }
        let binding = current
            .originals
            .iter()
            .find(|binding| binding.requirement_id == requirement_id)
            .ok_or_else(|| source_required(requirement_id))?;
        let (catalog, install) =
            self.profile_original_contract(port_id, &current, requirement_id)?;
        let embedded = crate::preparation::self_contained_launch(
            &self.library,
            catalog.port(port_id)?,
            &install,
        );
        let current_instance_id = source_instances::identity(binding)?;
        let current_path = source_instances::find(
            &self.library.connection()?,
            requirement_id,
            &current_instance_id,
        )?
        .map(|source| source.path);
        let instances = if embedded {
            Vec::new()
        } else {
            source_instances::list(&self.library.connection()?, requirement_id)?
                .into_iter()
                .filter(|(instance_id, source)| {
                    instance_id != &current_instance_id
                        && crate::source_inspection::verify_registered(&catalog, source).is_ok()
                })
                .map(registered_instance)
                .collect()
        };
        Ok(ProfileOriginalReview {
            source_profile: catalog.source_profile(requirement_id)?.clone(),
            current_instance_id,
            current_path,
            embedded,
            instances,
        })
    }

    fn registered_original_instances(
        &self,
        requirement_id: &str,
    ) -> Result<Vec<ProfileOriginalInstance>> {
        source_instances::list(&self.library.connection()?, requirement_id)
            .map(|records| records.into_iter().map(registered_instance).collect())
    }

    pub fn select_profile_original(
        &self,
        port_id: &str,
        profile_id: &str,
        expected_revision: u64,
        requirement_id: &str,
        instance_id: &str,
    ) -> Result<ProfileRevision> {
        let _source = self.library.try_lock_source(requirement_id)?;
        let _port = self
            .library
            .try_lock_port(port_id, "select-profile-original")?;
        let connection = self.library.connection()?;
        let profile = profile::profile_by_id(&connection, port_id, profile_id)?;
        let current =
            profile::revision_by_number(&connection, profile_id, profile.current_revision)?;
        if current.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "the setup changed after review; choose its original game files again",
            ));
        }
        if profile.is_default {
            return Err(PortcoveError::conflict(
                "Default uses the game's saved original. Copy the setup to choose a different original for it.",
            ));
        }
        let (catalog, install) =
            self.profile_original_contract(port_id, &current, requirement_id)?;
        self.require_selectable_original(&catalog, &install)?;
        let source = source_instances::find(&connection, requirement_id, instance_id)?
            .ok_or_else(|| source_required(requirement_id))?;
        crate::source_inspection::verify_registered(&catalog, &source)?;
        let binding = profile::bind_original(requirement_id, &source);
        if current.originals.contains(&binding) {
            return Ok(current);
        }
        self.create_profile_revision_with_original_locked(
            port_id,
            profile_id,
            &ProfileRevisionRequest {
                expected_revision,
                ..Default::default()
            },
            Some(binding),
        )
    }

    /// Relinking changes only the exact instance's saved location. A different
    /// original must be admitted and explicitly selected in a new revision.
    pub fn relink_profile_original(
        &self,
        port_id: &str,
        profile_id: &str,
        expected_revision: u64,
        requirement_id: &str,
        path: &Path,
    ) -> Result<ProfileOriginalInstance> {
        let _source = self.lock_source_dependents(requirement_id, Some(port_id))?;
        let _port = self
            .library
            .try_lock_port(port_id, "relink-profile-original")?;
        let mut connection = self.library.connection()?;
        let current = profile::current_revision(&connection, port_id, profile_id)?;
        if current.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "the setup changed after review; review the original it uses again",
            ));
        }
        let binding = current
            .originals
            .iter()
            .find(|binding| binding.requirement_id == requirement_id)
            .ok_or_else(|| source_required(requirement_id))?;
        let (catalog, _) = self.profile_original_contract(port_id, &current, requirement_id)?;
        let actual = crate::source_inspection::inspect(&catalog, requirement_id, path)?
            .require_admitted_record()?;
        require_original_bytes(binding, &actual)?;
        let instance_id = source_instances::identity(binding)?;
        let mut registered = source_instances::find(&connection, requirement_id, &instance_id)?
            .unwrap_or_else(|| {
                let mut recovered = actual.clone();
                if binding.observed_identity_sha256.is_none() {
                    // A migrated binding may predate observed variant facts.
                    // Keep its original identity after inspecting these bytes.
                    recovered.observed_identity = None;
                }
                recovered
            });
        if profile::bind_original(requirement_id, &registered) != *binding {
            return Err(PortcoveError::source(
                "the replacement does not match the setup's saved original identity",
            ));
        }
        registered.path = actual.path;
        registered.updated_at = Library::now();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if Library::source_from(&transaction, requirement_id)?
            .is_some_and(|source| profile::bind_original(requirement_id, &source) == *binding)
        {
            Library::write_source(&transaction, &registered)?;
        } else {
            source_instances::record(&transaction, &registered)?;
        }
        transaction.commit()?;
        Ok(ProfileOriginalInstance {
            instance_id,
            binding: binding.clone(),
            path: registered.path,
        })
    }

    pub(crate) fn pinned_original(
        &self,
        port_id: &str,
        requirement_id: &str,
        install_id: &str,
    ) -> Result<Option<OriginalBinding>> {
        let connection = self.library.connection()?;
        let Some((profile_id, revision)) = profile::selection(&connection, port_id)? else {
            return Ok(None);
        };
        if profile::profile_by_id(&connection, port_id, &profile_id)?.is_default {
            return Ok(None);
        }
        let revision = profile::revision_by_number(&connection, &profile_id, revision)?;
        if revision.build.install_id != install_id {
            return Ok(None);
        }
        revision
            .originals
            .into_iter()
            .find(|binding| binding.requirement_id == requirement_id)
            .map(Some)
            .ok_or_else(|| source_required(requirement_id))
    }

    /// Artwork based on the default registration is valid only when the active
    /// setup uses that exact original. An unreadable selection supplies no proof.
    pub(crate) fn launch_uses_default_original(
        &self,
        port_id: &str,
        install_id: &str,
        default: &SourceRecord,
    ) -> bool {
        match self.pinned_original(port_id, &default.profile_id, install_id) {
            Ok(None) => true,
            Ok(Some(binding)) => {
                require_original_bytes(&binding, default).is_ok()
                    && self
                        .registered_profile_original(&binding)
                        .is_ok_and(|pinned| pinned.path == default.path)
            }
            Err(_) => false,
        }
    }

    pub(crate) fn registered_profile_original(
        &self,
        binding: &OriginalBinding,
    ) -> Result<SourceRecord> {
        source_instances::find(
            &self.library.connection()?,
            &binding.requirement_id,
            &source_instances::identity(binding)?,
        )?
        .ok_or_else(|| source_required(&binding.requirement_id))
    }

    fn profile_original_contract(
        &self,
        port_id: &str,
        revision: &ProfileRevision,
        requirement_id: &str,
    ) -> Result<(Catalog, InstallRecord)> {
        let install = Library::install_by_id(
            &self.library.connection()?,
            Some(&revision.build.install_id),
        )?
        .filter(|install| revision.build.matches_install(install))
        .ok_or_else(|| PortcoveError::not_found("the setup's exact installation is unavailable"))?;
        if crate::install::retained_build_identity_for_install(&install)? != revision.build {
            return Err(PortcoveError::verification(
                "the setup's retained original-game-file contract has changed",
            ));
        }
        let catalog = self.installed_catalog(&install)?;
        if catalog.port(port_id)?.source_profile.as_deref() != Some(requirement_id) {
            return Err(PortcoveError::unsupported(
                "this original game file requirement cannot be selected for the setup",
            ));
        }
        Ok((catalog, install))
    }

    fn require_selectable_original(
        &self,
        catalog: &Catalog,
        install: &InstallRecord,
    ) -> Result<()> {
        let port = catalog.port(&install.port_id)?;
        if crate::preparation::self_contained_launch(&self.library, port, install) {
            return Err(PortcoveError::unsupported(
                "this installed runtime already contains prepared game data. Prepare another runtime with a different original before using it in a setup.",
            )
            .detail("reason", "original_embedded_in_runtime")
            .detail("install_id", &install.id)
            .with_known_cause(crate::failure::KnownFailureCause::OriginalEmbeddedInRuntime));
        }
        Ok(())
    }
}

fn registered_instance((instance_id, source): (String, SourceRecord)) -> ProfileOriginalInstance {
    ProfileOriginalInstance {
        instance_id,
        binding: profile::bind_original(&source.profile_id, &source),
        path: source.path,
    }
}

/// Paths and a later catalogue observation can change. The selected content
/// and the storage representation must still match the original binding.
pub(crate) fn require_original_bytes(
    binding: &OriginalBinding,
    source: &SourceRecord,
) -> Result<()> {
    if source.profile_id != binding.requirement_id
        || source.sha256 != binding.sha256
        || source.size != binding.size
        || source.storage_sha256 != binding.storage_sha256
        || source.storage_size != binding.storage_size
    {
        return Err(PortcoveError::source(
            "these files differ from the setup's saved original. Relink the matching files or choose another saved original for the setup.",
        )
        .detail("requirement_id", &binding.requirement_id));
    }
    Ok(())
}

/// Checks the saved representation without applying a newer catalogue's admission
/// rules to file-backed instances. Ordinary launch still uses its retained contract.
pub(crate) fn storage_status(
    catalog: &Catalog,
    source: &SourceRecord,
) -> crate::OriginalAvailability {
    use crate::OriginalAvailability::{Changed, Missing, Verified};
    let Ok(metadata) = source.path.metadata() else {
        return Missing;
    };
    if !metadata.is_file() {
        return if crate::source_inspection::verify_registered(catalog, source).is_ok() {
            Verified
        } else {
            Changed
        };
    }
    if metadata.len() != source.storage_size {
        return Changed;
    }
    let mut budget = crate::source_file::HashBudget {
        checkpoint: None,
        operation: None,
        limit: source.storage_size,
        hashed: 0,
        max_zip_entries: 0,
    };
    match crate::source_file::read_raw_identity(
        &source.path,
        metadata.len(),
        source.storage_size,
        &mut budget,
    ) {
        Ok(identity)
            if identity.storage_sha256 == source.storage_sha256
                && identity.storage_size == source.storage_size =>
        {
            Verified
        }
        _ => Changed,
    }
}

fn source_required(requirement_id: &str) -> PortcoveError {
    PortcoveError::not_found(
        "this setup's original game files are unavailable. Relink the saved original or choose another saved original for the setup.",
    )
    .detail("requirement_id", requirement_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ErrorCode, OriginalAvailability, retained_build::tests::fixture};
    use std::fs;

    fn rom(marker: u8) -> [u8; 12] {
        [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4, 5, 6, 7, marker]
    }

    #[test]
    fn setup_originals_survive_registration_rescan_and_verified_relink() {
        let (temporary, service, install) = fixture();
        let port = "starship";
        let requirement = "star-fox-64";
        let first = temporary.path().join("first.z64");
        let second = temporary.path().join("second.z64");
        fs::write(&first, rom(8)).unwrap();
        fs::write(&second, rom(9)).unwrap();
        let admitted_first = service.register_source(requirement, &first).unwrap();
        let default = service.ensure_default_profile(port).unwrap();
        let a = service
            .copy_profile(port, &default.id, "First setup")
            .unwrap();
        let b = service
            .copy_profile(port, &default.id, "Second setup")
            .unwrap();
        let admitted_second = service.register_source(requirement, &second).unwrap();
        assert_ne!(admitted_first.sha256, admitted_second.sha256);
        assert!(service.launch_uses_default_original(port, &install.id, &admitted_second));
        let instances = service
            .profile_original_instances(port, &b.id, requirement)
            .unwrap();
        assert_eq!(instances.len(), 2);
        let review = service
            .review_profile_original(port, &b.id, 1, requirement)
            .unwrap();
        assert!(!review.embedded);
        assert_eq!(review.instances.len(), 1);
        assert_eq!(review.instances[0].binding.sha256, admitted_second.sha256);
        assert_eq!(
            review.current_path,
            Some(std::path::absolute(&first).unwrap())
        );
        assert_eq!(
            review.current_instance_id,
            source_instances::identity(&profile::bind_original(requirement, &admitted_first))
                .unwrap()
        );
        fs::remove_file(&second).unwrap();
        let review = service
            .review_profile_original(port, &b.id, 1, requirement)
            .unwrap();
        assert!(review.instances.is_empty());
        fs::write(&second, rom(9)).unwrap();
        let instance = instances
            .iter()
            .find(|instance| instance.binding.sha256 == admitted_second.sha256)
            .unwrap();

        service.activate_profile(port, &b.id).unwrap();
        assert!(!service.launch_uses_default_original(port, &install.id, &admitted_second));
        let revised = service
            .select_profile_original(port, &b.id, 1, requirement, &instance.instance_id)
            .unwrap();
        assert_eq!(revised.revision, 2);
        assert_eq!(revised.originals, [instance.binding.clone()]);
        assert_eq!(
            service
                .review_profile_original(port, &b.id, 1, requirement)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            service
                .pinned_original(port, requirement, &install.id)
                .unwrap(),
            Some(instance.binding.clone())
        );
        assert!(service.launch_uses_default_original(port, &install.id, &admitted_second));
        assert_eq!(
            service
                .select_profile_original(port, &b.id, 1, requirement, &instance.instance_id)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let root = service.library().root().to_path_buf();
        drop(service);
        let service = PortcoveService::new(Library::open(root).unwrap()).unwrap();
        let a_revision = service
            .profile_revisions(port, &a.id)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(a_revision.originals[0].sha256, admitted_first.sha256);
        let saved = service
            .profile_revisions(port, &b.id)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(saved, revised);

        let relocated = temporary.path().join("relocated.z64");
        fs::rename(&second, &relocated).unwrap();
        let inventory = service.profile_inventory(port).unwrap();
        let b_status = inventory
            .profiles
            .iter()
            .find(|view| view.profile.id == b.id)
            .unwrap();
        assert_eq!(
            b_status.originals[0].availability,
            OriginalAvailability::Missing
        );
        let error = service
            .relink_profile_original(port, &b.id, revised.revision, requirement, &first)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceInvalid);
        let relinked = service
            .relink_profile_original(port, &b.id, revised.revision, requirement, &relocated)
            .unwrap();
        assert_eq!(relinked.binding, instance.binding);
        assert_eq!(relinked.instance_id, instance.instance_id);
        assert_eq!(relinked.path, std::path::absolute(&relocated).unwrap());
        assert_eq!(service.profile_revisions(port, &b.id).unwrap().len(), 2);

        let registered = service
            .registered_profile_original(&relinked.binding)
            .unwrap();
        crate::source_inspection::verify_registered(service.catalog(), &registered).unwrap();
        fs::write(&relocated, rom(10)).unwrap();
        let inventory = service.profile_inventory(port).unwrap();
        let current = inventory
            .profiles
            .iter()
            .find(|view| view.profile.id == b.id)
            .unwrap();
        assert_eq!(
            current.originals[0].availability,
            OriginalAvailability::Changed
        );
        assert_eq!(
            crate::source_inspection::verify_registered(service.catalog(), &registered)
                .unwrap_err()
                .code,
            ErrorCode::SourceInvalid
        );
        let first_retained = service
            .registered_profile_original(&a_revision.originals[0])
            .unwrap();
        crate::source_inspection::verify_registered(service.catalog(), &first_retained).unwrap();
    }

    #[test]
    fn original_review_requires_the_exact_retained_contract() {
        let (_temporary, service, _install) = fixture();
        let default = service.ensure_default_profile("starship").unwrap();
        let mut revision = service
            .profile_revisions("starship", &default.id)
            .unwrap()
            .remove(0);
        revision.build.installed_contract_sha256 = "0".repeat(64);
        assert!(
            service
                .profile_original_contract("starship", &revision, "star-fox-64")
                .unwrap_err()
                .message
                .contains("retained original-game-file contract has changed")
        );
    }

    #[test]
    fn explicit_source_removal_forgets_only_the_removed_instance_and_can_relink_by_identity() {
        let (temporary, service, install) = fixture();
        let port = "starship";
        let requirement = "star-fox-64";
        let first = temporary.path().join("first.z64");
        let second = temporary.path().join("second.z64");
        fs::write(&first, rom(8)).unwrap();
        fs::write(&second, rom(9)).unwrap();
        let first_source = service.register_source(requirement, &first).unwrap();
        let second_source = service.register_source(requirement, &second).unwrap();
        let binding = profile::bind_original(requirement, &second_source);
        let default = service.ensure_default_profile(port).unwrap();
        let setup = service
            .copy_profile(port, &default.id, "Saved original")
            .unwrap();
        service.activate_profile(port, &setup.id).unwrap();

        let preview = service.preview_source_removal(requirement).unwrap();
        let authorization = service
            .authorize_source_removal(requirement, &preview.preview_sha256)
            .unwrap();
        service
            .remove_source(requirement, &authorization.token)
            .unwrap();

        assert!(service.library().source(requirement).unwrap().is_none());
        assert_eq!(fs::read(&second).unwrap(), rom(9));
        assert_eq!(
            service
                .pinned_original(port, requirement, &install.id)
                .unwrap(),
            Some(binding.clone())
        );
        assert!(service.registered_profile_original(&binding).is_err());
        assert!(
            service
                .registered_profile_original(&profile::bind_original(requirement, &first_source))
                .is_ok()
        );
        let inventory = service.profile_inventory(port).unwrap();
        let saved = inventory
            .profiles
            .iter()
            .find(|view| view.profile.id == setup.id)
            .unwrap();
        assert_eq!(
            saved.originals[0].availability,
            OriginalAvailability::Missing
        );
        assert_eq!(saved.originals[0].binding, binding);
        let restored = service
            .relink_profile_original(
                port,
                &setup.id,
                saved.revision.revision,
                requirement,
                &second,
            )
            .unwrap();
        assert_eq!(restored.binding, binding);
        assert!(service.library().source(requirement).unwrap().is_none());
        assert_eq!(
            service.registered_profile_original(&binding).unwrap().path,
            restored.path
        );
    }
}
