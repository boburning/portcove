use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ActivityOperation, ActivityTargetKind, AdapterKind, AdapterRegistry, PortcoveError,
    PortcoveService, Result, SourceRecord,
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceRelinkPlan {
    pub original: SourceRecord,
    pub replacement: SourceRecord,
    pub preview_sha256: String,
}

impl PortcoveService {
    /// Validate a new location without changing the registration or either source.
    pub fn plan_source_relink(&self, profile_id: &str, path: &Path) -> Result<SourceRelinkPlan> {
        let original = self.library().source(profile_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
        })?;
        let profile = self.catalog().source_profile(profile_id)?;
        let replacement = AdapterRegistry
            .get(AdapterKind::ReferencedDisc)
            .validate_source(profile, path)?;
        if original.sha256 != replacement.sha256 || original.size != replacement.size {
            return Err(
                PortcoveError::source("relink requires the same validated source content")
                    .detail("profile_id", profile_id),
            );
        }
        // Validation time is deliberately excluded: applying the plan rehashes
        // the source and records that new validation time.
        let preview_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&(
            &original,
            profile,
            &replacement.path,
            &replacement.sha256,
            replacement.size,
            &replacement.storage_sha256,
            replacement.storage_size,
        ))?));
        Ok(SourceRelinkPlan {
            original,
            replacement,
            preview_sha256,
        })
    }

    pub fn relink_source(
        &self,
        profile_id: &str,
        path: &Path,
        expected_preview_sha256: &str,
    ) -> Result<SourceRecord> {
        let activity = self.library().begin_activity(
            ActivityOperation::RegisterSource,
            ActivityTargetKind::Source,
            Some(profile_id),
        )?;
        let result = (|| {
            let _guards = self.lock_source_dependents(profile_id, None)?;
            let plan = self.plan_source_relink(profile_id, path)?;
            if plan.preview_sha256 != expected_preview_sha256 {
                return Err(PortcoveError::conflict(
                    "source registration or replacement changed after the relink plan",
                ));
            }
            self.library().register_source(&plan.replacement)?;
            Ok(plan.replacement)
        })();
        self.finish_activity(activity, result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ErrorCode, Library};
    use std::{fs, path::PathBuf};

    fn fixture() -> (tempfile::TempDir, PortcoveService, PathBuf, PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let original = temporary.path().join("original.z64");
        let replacement = temporary.path().join("relocated.z64");
        fs::write(&original, b"synthetic source fixture").unwrap();
        fs::copy(&original, &replacement).unwrap();
        let service =
            PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
        service.register_source("star-fox-64", &original).unwrap();
        (temporary, service, original, replacement)
    }

    #[test]
    fn relink_plan_is_read_only_and_apply_works_with_an_unavailable_old_location() {
        let (_temporary, service, original, replacement) = fixture();
        let before = service.library().source("star-fox-64").unwrap().unwrap();
        let plan = service
            .plan_source_relink("star-fox-64", &replacement)
            .unwrap();
        assert_eq!(
            service
                .library()
                .source("star-fox-64")
                .unwrap()
                .unwrap()
                .path,
            before.path
        );
        assert_eq!(
            fs::read(&original).unwrap(),
            fs::read(&replacement).unwrap()
        );
        fs::remove_file(&original).unwrap(); // Simulate an unavailable old disk.
        let result = service
            .relink_source("star-fox-64", &replacement, &plan.preview_sha256)
            .unwrap();
        assert_eq!(result.path, replacement);
        assert_eq!(result.sha256, before.sha256);
        service.verify_source("star-fox-64").unwrap();
    }

    #[test]
    fn relink_rejects_changed_content_and_stale_registration_without_writing() {
        let (temporary, service, original, replacement) = fixture();
        let plan = service
            .plan_source_relink("star-fox-64", &replacement)
            .unwrap();
        fs::write(&replacement, b"different synthetic source").unwrap();
        let error = service
            .relink_source("star-fox-64", &replacement, &plan.preview_sha256)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceInvalid);
        assert_eq!(
            service
                .library()
                .source("star-fox-64")
                .unwrap()
                .unwrap()
                .path,
            original
        );
        fs::copy(&original, &replacement).unwrap();
        let third = temporary.path().join("third.z64");
        fs::copy(&original, &third).unwrap();
        service.register_source("star-fox-64", &third).unwrap();
        let error = service
            .relink_source("star-fox-64", &replacement, &plan.preview_sha256)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(
            service
                .library()
                .source("star-fox-64")
                .unwrap()
                .unwrap()
                .path,
            third
        );
    }

    #[test]
    fn source_changes_conflict_with_a_dependent_port_and_another_source_writer() {
        let (_temporary, service, original, replacement) = fixture();
        let plan = service
            .plan_source_relink("star-fox-64", &replacement)
            .unwrap();
        let port = service
            .catalog()
            .ports()
            .iter()
            .find(|port| port.source_profile.as_deref() == Some("star-fox-64"))
            .unwrap();
        let guard = service
            .library()
            .try_lock_port(&port.id, "synthetic-running-game")
            .unwrap();
        assert_eq!(
            service
                .register_source("star-fox-64", &replacement)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            service
                .relink_source("star-fox-64", &replacement, &plan.preview_sha256)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        drop(guard);
        let _writer = service.library().try_lock_source("star-fox-64").unwrap();
        assert_eq!(
            service
                .register_source("star-fox-64", &replacement)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            service
                .library()
                .source("star-fox-64")
                .unwrap()
                .unwrap()
                .path,
            original
        );
    }
}
