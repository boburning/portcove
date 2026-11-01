//! Read-only setup choices over one saved registration. A profile association is
//! not compatibility, and an informational contract is not exact admission.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    CatalogAdmissionMode, PortOperationGuard, PortSourceRole, PortcoveError, PortcoveService,
    Result, SourceAdmission, SourceClassification, SourceHealth, SourceInspectionReport,
    SourceRecord,
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceRegistrationReference {
    pub profile_id: String,
    pub reference_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceReuseCompatibility {
    ListedIdentity,
    Potential,
    Incompatible,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceReuseApplication {
    pub port_id: String,
    pub port_name: String,
    pub role: PortSourceRole,
    pub contract_id: String,
    pub compatibility: SourceReuseCompatibility,
    pub can_review_setup: bool,
    pub summary: String,
    pub additional_checks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceReuseReview {
    pub reference: SourceRegistrationReference,
    pub registration: SourceRecord,
    pub inspection: SourceInspectionReport,
    pub applications: Vec<SourceReuseApplication>,
}

impl PortcoveService {
    /// Reinspect without replacing the saved baseline or touching originals.
    pub fn review_source_reuse(&self, profile_id: &str) -> Result<SourceReuseReview> {
        let inspection = self.inspect_registered_source(profile_id)?;
        let registration = inspection.registered.clone().ok_or_else(|| {
            PortcoveError::state("source reuse inspection omitted the saved registration")
        })?;
        let profile = self.catalog().source_profile(profile_id)?;
        let contracts = inspection
            .applications
            .iter()
            .map(|app| Ok((&app.contract, self.catalog().port(&app.port_id)?)))
            .collect::<Result<Vec<_>>>()?;
        let reference_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&(
            "Portcove registered source setup reference v1",
            self.library().identity_record()?,
            &registration,
            profile,
            contracts,
        ))?));
        // Do not publish a reference to a registration changed during the read.
        if serde_json::to_value(self.library().source(profile_id)?)?
            != serde_json::to_value(Some(&registration))?
        {
            return Err(PortcoveError::conflict(
                "The saved game-file location changed. Check it again before reviewing setup.",
            ));
        }
        // This setup reference selects original game data. BIOS selection keeps
        // its existing separate slot and verification/consent path.
        let applications = inspection
            .applications
            .iter()
            .filter(|app| app.role == PortSourceRole::Game)
            .map(|app| application_review(&inspection, app))
            .collect();
        Ok(SourceReuseReview {
            reference: SourceRegistrationReference {
                profile_id: profile_id.into(),
                reference_sha256,
            },
            registration,
            inspection,
            applications,
        })
    }

    /// Hold the existing source lock through a checked setup operation. No new
    /// consent, registration, execution or save ownership is granted by this guard.
    pub fn lock_source_reuse(
        &self,
        port_id: &str,
        reference: &SourceRegistrationReference,
        selected_path: Option<&std::path::Path>,
    ) -> Result<PortOperationGuard> {
        let guard = self.library().try_lock_source(&reference.profile_id)?;
        let review = self.review_source_reuse(&reference.profile_id)?;
        if review.reference.reference_sha256 != reference.reference_sha256 {
            return Err(PortcoveError::conflict(
                "The saved game files or their requirements changed. Review setup again.",
            ));
        }
        if let Some(path) = selected_path {
            if std::fs::canonicalize(path)? != std::fs::canonicalize(&review.registration.path)? {
                return Err(PortcoveError::conflict(
                    "The selected location differs from the saved-source review. Repair its location or review the new selection separately.",
                ));
            }
        }
        if self.catalog().port(port_id)?.source_profile.as_deref()
            != Some(reference.profile_id.as_str())
        {
            return Err(PortcoveError::source(
                "These saved files cannot be reused for this integration. Check its required edition and repair or select the game-file location.",
            ));
        }
        let application = review
            .applications
            .iter()
            .find(|app| app.port_id == port_id && app.role == PortSourceRole::Game)
            .ok_or_else(|| {
                PortcoveError::source(
                    "These files have no original-game contract for the selected integration.",
                )
            })?;
        if !application.can_review_setup {
            return Err(PortcoveError::source(application.summary.clone()));
        }
        Ok(guard)
    }
}

fn application_review(
    inspection: &SourceInspectionReport,
    app: &crate::SourceApplicationInspection,
) -> SourceReuseApplication {
    let compatibility = match inspection
        .inspection
        .as_ref()
        .map(|i| &i.assessment.classification)
    {
        _ if inspection.health != SourceHealth::Current => SourceReuseCompatibility::Unavailable,
        Some(SourceClassification::Recognized { identity }) => {
            if app
                .contract
                .supported_variant_ids
                .contains(&identity.variant_id)
            {
                SourceReuseCompatibility::ListedIdentity
            } else {
                SourceReuseCompatibility::Incompatible
            }
        }
        Some(SourceClassification::Ambiguous { .. }) => SourceReuseCompatibility::Unavailable,
        _ => SourceReuseCompatibility::Potential,
    };
    let admitted = inspection
        .inspection
        .as_ref()
        .is_some_and(|i| matches!(i.assessment.admission, SourceAdmission::Admitted { .. }));
    let mut additional_checks = Vec::new();
    if app.contract.admission_mode == CatalogAdmissionMode::Informational {
        additional_checks.push("This integration retains informational source admission; a listed identity does not remove its legacy evidence gap.".into());
    }
    if compatibility == SourceReuseCompatibility::Potential {
        additional_checks.push("Confirm the required edition, region, revision and complete input during setup; compatibility has not been established.".into());
    }
    if app.contract.validator_contract_id.is_some() {
        additional_checks.push(
            "The integration's required input validator must still pass during preparation.".into(),
        );
    }
    additional_checks.push("Review this integration's platform, release, preparation and any other required files. This source check does not install or qualify the game.".into());
    let mut summary = match compatibility {
        SourceReuseCompatibility::ListedIdentity => "The observed edition is listed by this integration's source contract.",
        SourceReuseCompatibility::Potential => "These files are associated with this integration; compatible input is not yet confirmed.",
        SourceReuseCompatibility::Incompatible => "This edition is not listed for this integration. Choose its supported edition instead.",
        SourceReuseCompatibility::Unavailable => "The saved files are missing, changed, unreadable or ambiguous. Check or repair their location before setup.",
    }.to_string();
    if compatibility == SourceReuseCompatibility::Incompatible {
        let expected = inspection
            .expected_identity
            .iter()
            .flat_map(|profile| &profile.variants)
            .filter(|variant| app.contract.supported_variant_ids.contains(&variant.id))
            .map(|variant| {
                format!(
                    "{} {} {}",
                    variant.title,
                    variant.region.as_deref().unwrap_or(""),
                    variant.revision.as_deref().unwrap_or("")
                )
            })
            .collect::<Vec<_>>();
        if !expected.is_empty() {
            summary.push_str(&format!(" Required: {}.", expected.join("; ")));
        }
    }
    SourceReuseApplication {
        port_id: app.port_id.clone(),
        port_name: app.port_name.clone(),
        role: app.role,
        contract_id: app.contract.id.clone(),
        compatibility,
        can_review_setup: admitted
            && matches!(
                compatibility,
                SourceReuseCompatibility::ListedIdentity | SourceReuseCompatibility::Potential
            ),
        summary,
        additional_checks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Catalog, ErrorCode, Library};
    use std::{fs, path::PathBuf};

    fn fixture(variant: &str) -> (tempfile::TempDir, PortcoveService, PathBuf) {
        let started = std::time::Instant::now();
        eprintln!("source reuse fixture: begin");
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("controlled.z64");
        let bytes = b"\x80\x37\x12\x40controlled inert source identity fixture";
        fs::write(&path, bytes).unwrap();
        let mut service =
            PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
        eprintln!(
            "source reuse fixture: service opened at {:?}",
            started.elapsed()
        );
        let mut document =
            serde_json::to_value(service.catalog().authoritative_document()).unwrap();
        let profile = document["source_catalog"]["identities"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|p| p["id"] == "majoras-mask")
            .unwrap();
        let selected = profile["variants"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|v| v["id"] == variant)
            .unwrap();
        selected["representations"][0]["identities"][0]["sha1"] =
            hex::encode(sha1::Sha1::digest(bytes)).into();
        eprintln!(
            "source reuse fixture: parsing catalog at {:?}",
            started.elapsed()
        );
        service.replace_catalog_for_test(Catalog::from_json(&document.to_string()).unwrap());
        eprintln!(
            "source reuse fixture: catalog ready at {:?}",
            started.elapsed()
        );
        service.register_source("majoras-mask", &path).unwrap();
        eprintln!(
            "source reuse fixture: registered at {:?}",
            started.elapsed()
        );
        (temporary, service, path)
    }

    #[test]
    fn listed_identity_is_distinct_from_informational_admission_and_read_preserves_baseline() {
        let (_temporary, service, _) = fixture("ntsc-u-1-0");
        let before =
            serde_json::to_value(service.library().source("majoras-mask").unwrap()).unwrap();
        let review = service.review_source_reuse("majoras-mask").unwrap();
        for port in ["2ship2harkinian", "zelda64-recomp"] {
            let app = review
                .applications
                .iter()
                .find(|a| a.port_id == port)
                .unwrap();
            assert_eq!(app.compatibility, SourceReuseCompatibility::ListedIdentity);
            assert!(app.can_review_setup);
            assert!(
                app.additional_checks
                    .iter()
                    .any(|s| s.contains("informational"))
            );
        }
        assert_eq!(
            serde_json::to_value(service.library().source("majoras-mask").unwrap()).unwrap(),
            before
        );
        assert_eq!(
            service
                .review_source_reuse("majoras-mask")
                .unwrap()
                .reference
                .reference_sha256,
            review.reference.reference_sha256
        );
    }

    #[test]
    fn shared_profile_does_not_admit_gamecube_into_zelda64() {
        let (_temporary, service, _) = fixture("ntsc-u-gamecube");
        let review = service.review_source_reuse("majoras-mask").unwrap();
        let app = review
            .applications
            .iter()
            .find(|a| a.port_id == "zelda64-recomp")
            .unwrap();
        assert_eq!(app.compatibility, SourceReuseCompatibility::Incompatible);
        assert!(!app.can_review_setup);
        assert!(
            service
                .lock_source_reuse("zelda64-recomp", &review.reference, None)
                .is_err()
        );
        let _guard = service
            .lock_source_reuse("2ship2harkinian", &review.reference, None)
            .unwrap();
    }

    #[test]
    fn moved_identical_repair_expires_reference_and_changed_bytes_cannot_rebaseline() {
        let (temporary, service, path) = fixture("ntsc-u-1-0");
        let review = service.review_source_reuse("majoras-mask").unwrap();
        let moved = temporary.path().join("moved.z64");
        fs::rename(&path, &moved).unwrap();
        assert!(
            service
                .review_source_reuse("majoras-mask")
                .unwrap()
                .applications
                .iter()
                .all(|a| !a.can_review_setup)
        );
        let plan = service.plan_source_relink("majoras-mask", &moved).unwrap();
        service
            .relink_source("majoras-mask", &moved, &plan.preview_sha256)
            .unwrap();
        assert_eq!(
            service
                .lock_source_reuse("zelda64-recomp", &review.reference, None)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let fresh = service.review_source_reuse("majoras-mask").unwrap();
        assert_eq!(fresh.registration.sha256, review.registration.sha256);
        assert!(
            fresh
                .applications
                .iter()
                .find(|a| a.port_id == "zelda64-recomp")
                .unwrap()
                .can_review_setup
        );
        fs::write(&moved, b"\x80\x37\x12\x40substituted controlled bytes").unwrap();
        assert!(
            service
                .lock_source_reuse("zelda64-recomp", &fresh.reference, None)
                .is_err()
        );
        assert_eq!(
            service
                .library()
                .source("majoras-mask")
                .unwrap()
                .unwrap()
                .sha256,
            review.registration.sha256
        );
    }

    #[test]
    fn checked_reuse_keeps_existing_source_lock_until_operation_settles() {
        let (_temporary, service, path) = fixture("ntsc-u-1-0");
        let review = service.review_source_reuse("majoras-mask").unwrap();
        let guard = service
            .lock_source_reuse("zelda64-recomp", &review.reference, None)
            .unwrap();
        assert_eq!(
            service
                .register_source("majoras-mask", &path)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        drop(guard);
        service.register_source("majoras-mask", &path).unwrap();
    }

    #[test]
    fn another_role_profile_or_override_cannot_be_substituted_for_original_reuse() {
        let (temporary, service, path) = fixture("ntsc-u-1-0");
        let review = service.review_source_reuse("majoras-mask").unwrap();
        assert!(
            review
                .applications
                .iter()
                .all(|app| app.role == PortSourceRole::Game)
        );
        assert!(
            service
                .lock_source_reuse("shipwright", &review.reference, None)
                .is_err()
        );
        let other = temporary.path().join("other.z64");
        fs::copy(&path, &other).unwrap();
        assert!(
            service
                .lock_source_reuse("zelda64-recomp", &review.reference, Some(&other))
                .is_err()
        );
        let _guard = service
            .lock_source_reuse("zelda64-recomp", &review.reference, Some(&path))
            .unwrap();
    }

    #[test]
    fn identical_registration_in_another_library_does_not_reuse_the_old_reference() {
        let (temporary, service, _) = fixture("ntsc-u-1-0");
        let review = service.review_source_reuse("majoras-mask").unwrap();
        let other_library = Library::open(temporary.path().join("other-library")).unwrap();
        other_library.register_source(&review.registration).unwrap();
        let mut other = PortcoveService::new(other_library).unwrap();
        other.replace_catalog_for_test(service.catalog().clone());
        assert_ne!(
            other
                .review_source_reuse("majoras-mask")
                .unwrap()
                .reference
                .reference_sha256,
            review.reference.reference_sha256
        );
        assert_eq!(
            other
                .lock_source_reuse("zelda64-recomp", &review.reference, None)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }
}
