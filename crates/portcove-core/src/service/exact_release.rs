use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::ExactReleaseSelection;

/// A read-only preview of saving one release as this port's maintenance target.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExactReleaseReview {
    pub selection: ExactReleaseSelection,
    pub review_sha256: String,
}

impl PortcoveService {
    pub async fn review_exact_release(
        &self,
        port_id: &str,
        version: &str,
    ) -> Result<ExactReleaseReview> {
        self.review_exact_release_for_status(port_id, version, &self.status(port_id)?)
            .await
    }

    pub async fn pin_exact_release(
        &self,
        port_id: &str,
        version: &str,
        expected_review: &str,
    ) -> Result<PortStatus> {
        validate_reviewed_fingerprint("exact release", expected_review)?;
        let _operation = self.library.try_lock_port(port_id, "pin-exact-release")?;
        let status = self.status(port_id)?;
        let review = self
            .review_exact_release_for_status(port_id, version, &status)
            .await?;
        if review.review_sha256 != expected_review {
            return Err(PortcoveError::conflict(
                "the selected release or library settings changed; review the exact release again",
            ));
        }
        self.library
            .set_exact_release(port_id, status.channel, Some(&review.selection))?;
        self.status(port_id)
    }

    pub fn clear_exact_release(&self, port_id: &str) -> Result<PortStatus> {
        let _operation = self.library.try_lock_port(port_id, "clear-exact-release")?;
        let status = self.status(port_id)?;
        if status.exact_release.is_some() {
            self.library
                .set_exact_release(port_id, status.channel, None)?;
        }
        self.status(port_id)
    }

    /// Availability of the managed release chooser in this library and platform.
    /// The exact observation and confirmation repeat all acquisition guards.
    pub fn can_review_exact_release(&self, port_id: &str) -> Result<bool> {
        let status = self.status(port_id)?;
        Ok(self.exact_release_context(port_id, &status).is_ok())
    }

    fn exact_release_context(
        &self,
        port_id: &str,
        status: &PortStatus,
    ) -> Result<(&PortDefinition, Platform)> {
        let port = self.catalog.port(port_id)?;
        let platform = Platform::current()?;
        self.require_managed_runtime_ownership(status)?;
        self.require_definition_operation(
            &self.catalog,
            port,
            DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
        )?;
        crate::managed_runtime_policy::require_acquisition_available(&self.catalog, port_id)?;
        let scope = crate::definition_repository::publisher_policy::acquisition_scope(
            &self.library,
            &self.catalog,
            port_id,
        )?;
        crate::release::require_exact_release_route(
            port,
            status.channel,
            platform,
            port.release.provider,
            scope.as_ref(),
        )?;
        Ok((port, platform))
    }

    async fn review_exact_release_for_status(
        &self,
        port_id: &str,
        version: &str,
        status: &PortStatus,
    ) -> Result<ExactReleaseReview> {
        let (port, platform) = self.exact_release_context(port_id, status)?;
        let selection = self
            .releases
            .review_exact(port, status.channel, platform, None, version)
            .await?;
        selection.require_context(port, status.channel, platform, None)?;
        if selection.version != version {
            return Err(PortcoveError::verification(
                "the observed release differs from the requested version",
            ));
        }
        if let Some(variant) = Self::saved_package_variant(port, status.channel, platform, status)?
        {
            selection.require_saved_variant(port, &variant)?;
        }
        let review_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
            "Portcove save exact release preference v1",
            self.library.identity()?,
            crate::installed_contract::InstalledContract::capture(&self.catalog, port_id)?,
            (
                &status.active,
                &status.staged,
                &status.exact_release,
                status.update_policy,
            ),
            &selection,
        ))?);
        Ok(ExactReleaseReview {
            selection,
            review_sha256,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    const PORT: &str = "diablo-devilutionx";

    struct Releases {
        release_id: AtomicU64,
    }

    fn observed(channel: ReleaseChannel, version: &str) -> ResolvedRelease {
        ResolvedRelease {
            version: version.into(),
            channel,
            asset: crate::ReleaseAsset {
                name: "game.zip".into(),
                size: 42,
                sha256: "a".repeat(64),
                url: "https://example.invalid/game.zip".into(),
            },
            published_at: None,
            uploader_continuity: None,
        }
    }

    #[async_trait::async_trait]
    impl crate::ReleaseProvider for Releases {
        async fn resolve(
            &self,
            _port: &PortDefinition,
            channel: ReleaseChannel,
            _platform: Platform,
        ) -> Result<ResolvedRelease> {
            Ok(observed(channel, "v2.0.0"))
        }

        async fn review_exact(
            &self,
            port: &PortDefinition,
            channel: ReleaseChannel,
            platform: Platform,
            _scope: Option<&crate::DefinitionAcquisitionScope>,
            version: &str,
        ) -> Result<ExactReleaseSelection> {
            let release = observed(channel, version);
            Ok(ExactReleaseSelection {
                port_id: port.id.clone(),
                channel,
                platform,
                version: release.version,
                filename: release.asset.name,
                size: release.asset.size,
                sha256: release.asset.sha256,
                identity: crate::ExactReleaseIdentity::Github {
                    repository_id: 1,
                    release_id: self.release_id.load(Ordering::SeqCst),
                    asset_id: 5,
                    commit_sha1: "a".repeat(40),
                },
            })
        }

        async fn resolve_exact(
            &self,
            port: &PortDefinition,
            channel: ReleaseChannel,
            platform: Platform,
            scope: Option<&crate::DefinitionAcquisitionScope>,
            pin: &ExactReleaseSelection,
        ) -> Result<crate::ScopedResolvedRelease> {
            if &self
                .review_exact(port, channel, platform, scope, &pin.version)
                .await?
                != pin
            {
                return Err(PortcoveError::verification(
                    "the fixture release identity changed",
                ));
            }
            crate::ScopedResolvedRelease::legacy(observed(channel, &pin.version))
                .for_selection(port, platform, channel)
        }
    }

    #[tokio::test]
    async fn exact_history_review_and_current_check_share_the_saved_preference() {
        let root = tempfile::tempdir().unwrap();
        let provider = Arc::new(Releases {
            release_id: AtomicU64::new(3),
        });
        let library = Library::open(root.path()).unwrap();
        let service = PortcoveService::with_provider(library, provider.clone()).unwrap();
        let preview = service.review_exact_release(PORT, "v1.0.0").await.unwrap();
        provider.release_id.store(4, Ordering::SeqCst);
        assert!(
            service
                .pin_exact_release(PORT, "v1.0.0", &preview.review_sha256)
                .await
                .is_err()
        );
        assert!(service.status(PORT).unwrap().exact_release.is_none());
        let preview = service.review_exact_release(PORT, "v1.0.0").await.unwrap();
        let status = service
            .pin_exact_release(PORT, "v1.0.0", &preview.review_sha256)
            .await
            .unwrap();
        assert_eq!(status.exact_release.as_ref(), Some(&preview.selection));
        assert_eq!(
            service
                .set_channel(PORT, status.channel)
                .unwrap()
                .exact_release
                .as_ref(),
            Some(&preview.selection)
        );
        drop(service);

        let reopened = Library::open(root.path()).unwrap();
        let service = PortcoveService::with_provider(reopened, provider.clone()).unwrap();
        assert_eq!(
            service.status(PORT).unwrap().exact_release,
            Some(preview.selection)
        );
        let check = service.check_update(PORT).await.unwrap();
        assert_eq!(check.release.version, "v1.0.0");
        assert_eq!(check.channel_latest_version.as_deref(), Some("v2.0.0"));
        provider.release_id.store(6, Ordering::SeqCst);
        assert!(service.check_update(PORT).await.is_err());
        assert!(
            service
                .clear_exact_release(PORT)
                .unwrap()
                .exact_release
                .is_none()
        );
        assert_eq!(
            service.check_update(PORT).await.unwrap().release.version,
            "v2.0.0"
        );
    }

    #[test]
    fn exact_history_channel_change_and_metadata_reader_fence() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        let pin = ExactReleaseSelection {
            port_id: PORT.into(),
            channel: ReleaseChannel::Stable,
            platform: Platform::WindowsX86_64,
            version: "v1.0.0".into(),
            filename: "game.zip".into(),
            size: 42,
            sha256: "a".repeat(64),
            identity: crate::ExactReleaseIdentity::DirectManifest,
        };
        library
            .set_exact_release(PORT, ReleaseChannel::Stable, Some(&pin))
            .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let exported = service.export_library_metadata().unwrap();
        assert_eq!(exported.schema_version, 13);
        assert_eq!(exported.port_settings[0].exact_release.as_ref(), Some(&pin));
        library.set_channel(PORT, ReleaseChannel::Beta).unwrap();
        let status = library.status(PORT, ReleaseChannel::Stable).unwrap();
        assert_eq!(status.channel, ReleaseChannel::Beta);
        assert!(status.exact_release.is_none());
        assert!(
            library
                .set_exact_release(PORT, ReleaseChannel::Stable, Some(&pin))
                .is_err()
        );
    }
}
