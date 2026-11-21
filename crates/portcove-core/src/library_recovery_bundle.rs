//! Recovery bundle planning is independent of library move and activation.

use std::{
    fs,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod execution;
pub use execution::{LibraryRecoveryBundle, LibraryRecoveryProgress, LibraryRecoveryRestorePlan};

use crate::{
    LibraryContentKind, LibraryMetadata, LibraryTreePlan, PortcoveError, PortcoveService, Result,
    library_import::{PortabilityCatalogs, validate_metadata},
    library_transfer::{LibraryTransferPurpose, plan_portable_content, require_transfer_idle},
};

/// Content in one verified managed root. This count does not claim that an
/// unmanaged game writes its saves into the library.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryRecoveryCoverage {
    pub kind: LibraryContentKind,
    pub relative_path: String,
    pub directories: usize,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryRecoveryExclusion {
    ExternalInstallations,
    ExternalOriginalsAndBios,
    ExternalSaves,
    UnknownSaveLocations,
    HostCredentials,
}

/// A read-only observation. A creator must acquire the exclusive source lease
/// and recompute this binding before copying the identified trees.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryRecoveryBundlePlan {
    pub source_root: PathBuf,
    pub destination_root: PathBuf,
    pub source_library_id: String,
    pub coverage: Vec<LibraryRecoveryCoverage>,
    pub exclusions: Vec<LibraryRecoveryExclusion>,
    pub required_bytes: u64,
    pub available_bytes: u64,
    pub plan_sha256: String,
}

impl PortcoveService {
    /// Preview a new bundle destination. No authority moves to the destination.
    pub fn plan_library_recovery_bundle(
        &self,
        destination: &Path,
    ) -> Result<LibraryRecoveryBundlePlan> {
        let (plan, _, _) = prepare(self, destination, Creation::New)?;
        require_capacity(&plan)?;
        Ok(plan)
    }
}

enum Creation {
    New,
    Continuing,
}

fn prepare(
    service: &PortcoveService,
    destination: &Path,
    creation: Creation,
) -> Result<(
    LibraryRecoveryBundlePlan,
    LibraryMetadata,
    Vec<LibraryTreePlan>,
)> {
    let source_root = fs::canonicalize(service.library().root())?;
    let destination_root =
        crate::library_transfer::transfer_destination(&source_root, destination)?;
    execution::refuse_staging_path(&destination_root)?;
    require_transfer_idle(service.library(), LibraryTransferPurpose::RecoveryBundle)?;
    let source_library_id = service.library().identity()?;
    if matches!(creation, Creation::New) {
        execution::require_no_interrupted_creation(
            &source_root,
            &source_library_id,
            &destination_root,
        )?;
    }
    let metadata = service.export_library_metadata()?;
    let catalogs = PortabilityCatalogs::from_root(&metadata, &source_root)?;
    validate_metadata(&metadata, &catalogs)?;
    let content = plan_portable_content(&metadata, &source_root)?;
    let coverage = content
        .iter()
        .map(|tree| LibraryRecoveryCoverage {
            kind: tree.kind,
            relative_path: tree.relative_path.clone(),
            directories: tree.copy.directories.len(),
            files: tree.copy.files.len(),
            bytes: tree.copy.total_bytes,
        })
        .collect::<Vec<_>>();
    let exclusions = vec![
        LibraryRecoveryExclusion::ExternalInstallations,
        LibraryRecoveryExclusion::ExternalOriginalsAndBios,
        LibraryRecoveryExclusion::ExternalSaves,
        LibraryRecoveryExclusion::UnknownSaveLocations,
        LibraryRecoveryExclusion::HostCredentials,
    ];
    let metadata_bytes = serde_json::to_vec_pretty(&metadata)?.len() as u64;
    if metadata_bytes > execution::MAX_METADATA_BYTES {
        return Err(PortcoveError::unsupported(
            "recovery bundle metadata exceeds the supported import size",
        ));
    }
    let required_bytes = coverage
        .iter()
        .try_fold(metadata_bytes, |sum, root| sum.checked_add(root.bytes))
        .and_then(|bytes| bytes.checked_add(64 * 1024 * 1024))
        .ok_or_else(|| PortcoveError::state("recovery bundle capacity estimate overflowed"))?;
    let parent = destination_root
        .parent()
        .ok_or_else(|| PortcoveError::usage("recovery bundle destination needs a parent"))?;
    let available_bytes = fs4::available_space(parent)?;
    let mut plan = LibraryRecoveryBundlePlan {
        source_root,
        destination_root,
        source_library_id,
        coverage,
        exclusions,
        required_bytes,
        available_bytes,
        plan_sha256: String::new(),
    };
    plan.plan_sha256 = plan_sha256(&plan, &metadata, &content)?;
    Ok((plan, metadata, content))
}

fn require_capacity(plan: &LibraryRecoveryBundlePlan) -> Result<()> {
    if plan.available_bytes < plan.required_bytes {
        return Err(PortcoveError::state(
            "destination has insufficient free space for a verified recovery bundle",
        )
        .detail("required_bytes", plan.required_bytes.to_string())
        .detail("available_bytes", plan.available_bytes.to_string()));
    }
    Ok(())
}

fn plan_sha256(
    plan: &LibraryRecoveryBundlePlan,
    metadata: &LibraryMetadata,
    content: &[LibraryTreePlan],
) -> Result<String> {
    // Time of observation and measured free space can change without touching
    // the data or the reviewed destination. Apply still checks capacity anew.
    let mut metadata = metadata.clone();
    metadata.exported_at = 0;
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        "portcove-library-recovery-bundle-plan-v1",
        &plan.source_root,
        &plan.destination_root,
        &plan.source_library_id,
        metadata,
        content,
        &plan.exclusions,
    ))?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_binds_managed_content_and_destination_without_opening_a_destination() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let destination = workspace.path().join("recovery-copy");
        let service = PortcoveService::new(crate::Library::open(&source).unwrap()).unwrap();
        let user = source.join("user");
        fs::create_dir_all(&user).unwrap();
        fs::write(user.join("progress.bin"), b"first").unwrap();

        let plan = service.plan_library_recovery_bundle(&destination).unwrap();
        assert_eq!(
            plan.source_library_id,
            service.library().identity().unwrap()
        );
        assert!(
            plan.exclusions
                .contains(&LibraryRecoveryExclusion::HostCredentials)
        );
        let root = plan
            .coverage
            .iter()
            .find(|root| root.kind == LibraryContentKind::UserData)
            .unwrap();
        assert_eq!((root.files, root.bytes), (1, 5));
        assert!(!destination.exists());
        assert_eq!(
            plan.plan_sha256,
            service
                .plan_library_recovery_bundle(&destination)
                .unwrap()
                .plan_sha256
        );
        let other_destination = workspace.path().join("another-recovery-copy");
        assert_ne!(
            plan.plan_sha256,
            service
                .plan_library_recovery_bundle(&other_destination)
                .unwrap()
                .plan_sha256
        );

        fs::write(user.join("progress.bin"), b"later").unwrap();
        assert_ne!(
            plan.plan_sha256,
            service
                .plan_library_recovery_bundle(&destination)
                .unwrap()
                .plan_sha256
        );
        assert!(
            service
                .plan_library_recovery_bundle(&source.join("nested-copy"))
                .is_err()
        );
        assert!(!destination.exists());
    }

    #[test]
    fn refuses_a_credential_inside_the_managed_inventory() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let destination = workspace.path().join("recovery-copy");
        let service = PortcoveService::new(crate::Library::open(&source).unwrap()).unwrap();
        let user = source.join("user");
        fs::create_dir_all(&user).unwrap();
        let credential = user.join("retroachievements.credentials");
        fs::write(&credential, b"synthetic fixture").unwrap();

        assert!(service.plan_library_recovery_bundle(&destination).is_err());
        assert!(credential.is_file());
        assert!(!destination.exists());
    }

    #[test]
    fn holds_a_recovery_plan_with_a_portcove_installation_outside_the_library() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let external = workspace.path().join("managed-output");
        let destination = workspace.path().join("recovery-copy");
        let service = PortcoveService::new(crate::Library::open(&source).unwrap()).unwrap();
        fs::create_dir(&external).unwrap();
        service
            .library()
            .register_install(
                &crate::InstallRecord {
                    id: "externally-located-build".into(),
                    port_id: "starship".into(),
                    version: "fixture".into(),
                    path: external,
                    channel: crate::ReleaseChannel::Stable,
                    installed_at: 1,
                    verified: true,
                    staged: false,
                    artifact: crate::ArtifactIdentity {
                        asset_name: "fixture.zip".into(),
                        sha256: "a".repeat(64),
                        size: 1,
                    },
                    runtime: None,
                    manifest_sha256: "a".repeat(64),
                    selected_executable: PathBuf::from("game"),
                },
                true,
            )
            .unwrap();

        let error = service
            .plan_library_recovery_bundle(&destination)
            .unwrap_err();
        assert_eq!(error.details["install_id"], "externally-located-build");
        assert!(!destination.exists());
    }
}
