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
            return Err(crate::release::ExactReleaseRefusal::ReviewChanged.attach(
                PortcoveError::conflict(
                    "the selected release or library settings changed; review the exact release again",
                ),
            ));
        }
        self.library
            .set_exact_release(port_id, status.channel, Some(&review.selection))
            .map_err(|error| {
                if error.code == crate::ErrorCode::Conflict {
                    crate::release::ExactReleaseRefusal::ReviewChanged.attach(error)
                } else {
                    error
                }
            })?;
        self.status(port_id)
    }

    pub fn clear_exact_release(&self, port_id: &str) -> Result<PortStatus> {
        let _operation = self.library.try_lock_port(port_id, "clear-exact-release")?;
        let status = self.status(port_id)?;
        // Follow also clears a pin Core cannot use, which is its only remedy.
        if status.exact_release.is_some() || status.exact_release_hold.is_some() {
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
        if let Some(hold) = &status.exact_release_hold {
            return Err(hold.refusal(port_id));
        }
        self.require_managed_runtime_ownership(status)?;
        self.require_definition_operation(
            &self.catalog,
            port,
            DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
        )?;
        crate::managed_runtime_policy::require_acquisition_available(&self.catalog, port_id)
            .map_err(crate::release::ExactReleaseRefusal::held)?;
        crate::acquisition_restriction::require(
            &self.catalog,
            port_id,
            &crate::acquisition_restriction::RestrictionSubject::deferred(
                crate::acquisition_restriction::RestrictedOperation::Install,
            )
            .on(platform),
        )
        .map_err(crate::release::ExactReleaseRefusal::held)?;
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
        // The same final artifact gate that install and update apply, so a held
        // package is explained at review instead of after it is pinned.
        crate::managed_runtime_policy::require_artifact_available(
            &self.catalog,
            port_id,
            &selection.version,
            &selection.sha256,
        )
        .map_err(crate::release::ExactReleaseRefusal::held)?;
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

    const OTHER: &str = "shipwright";

    fn manifest_pin(port_id: &str, channel: ReleaseChannel) -> ExactReleaseSelection {
        ExactReleaseSelection {
            port_id: port_id.into(),
            channel,
            platform: Platform::WindowsX86_64,
            version: "v1.0.0".into(),
            filename: "game.zip".into(),
            size: 42,
            sha256: "a".repeat(64),
            identity: crate::ExactReleaseIdentity::DirectManifest,
        }
    }

    fn install(id: &str, channel: ReleaseChannel, root: &std::path::Path) -> InstallRecord {
        InstallRecord {
            id: id.into(),
            port_id: PORT.into(),
            version: id.into(),
            path: root.join(id),
            channel,
            installed_at: Library::now(),
            verified: true,
            staged: false,
            artifact: crate::ArtifactIdentity::default(),
            manifest_sha256: String::new(),
            selected_executable: std::path::PathBuf::new(),
            runtime: None,
        }
    }

    fn store_raw_pin(library: &Library, port_id: &str, raw: &str) {
        library
            .ensure_settings(port_id, ReleaseChannel::Stable)
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE port_settings SET exact_release_json=?2 WHERE port_id=?1",
                rusqlite::params![port_id, raw],
            )
            .unwrap();
    }

    fn presentation_key(error: &PortcoveError) -> String {
        error.report().presentation.presentation_key
    }

    #[test]
    fn activation_that_changes_the_channel_ends_the_pin() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        let pin = manifest_pin(PORT, ReleaseChannel::Stable);
        library
            .set_exact_release(PORT, ReleaseChannel::Stable, Some(&pin))
            .unwrap();

        // Same channel: the pin is still the target.
        library
            .register_install(&install("one", ReleaseChannel::Stable, root.path()), true)
            .unwrap();
        let status = library.status(PORT, ReleaseChannel::Stable).unwrap();
        assert_eq!(status.exact_release.as_ref(), Some(&pin));
        // Staging another channel's build does not change the port's channel.
        library
            .register_install(&install("two", ReleaseChannel::Beta, root.path()), false)
            .unwrap();
        let status = library.status(PORT, ReleaseChannel::Stable).unwrap();
        assert_eq!(status.channel, ReleaseChannel::Stable);
        assert_eq!(status.exact_release.as_ref(), Some(&pin));

        // Activation onto another channel clears the pin with the channel change.
        library
            .register_install(&install("three", ReleaseChannel::Beta, root.path()), true)
            .unwrap();
        let status = library.status(PORT, ReleaseChannel::Stable).unwrap();
        assert_eq!(status.channel, ReleaseChannel::Beta);
        assert!(status.exact_release.is_none());
        assert!(status.exact_release_hold.is_none());
    }

    #[tokio::test]
    async fn one_unusable_pin_holds_only_its_port_and_follow_clears_it() {
        let root = tempfile::tempdir().unwrap();
        let provider = Arc::new(Releases {
            release_id: AtomicU64::new(3),
        });
        let library = Library::open(root.path()).unwrap();
        let other_pin = manifest_pin(OTHER, ReleaseChannel::Stable);
        library
            .set_exact_release(OTHER, ReleaseChannel::Stable, Some(&other_pin))
            .unwrap();
        store_raw_pin(&library, PORT, "{not a pin");
        let service = PortcoveService::with_provider(library.clone(), provider).unwrap();

        // Every status read still succeeds; only PORT reports a hold.
        let statuses = service.statuses().unwrap();
        let held = statuses.iter().find(|s| s.port_id == PORT).unwrap();
        assert!(held.exact_release.is_none());
        assert_eq!(
            held.exact_release_hold.as_ref().unwrap().reason,
            crate::ExactReleaseHoldReason::Unreadable
        );
        let other = statuses.iter().find(|s| s.port_id == OTHER).unwrap();
        assert_eq!(other.exact_release.as_ref(), Some(&other_pin));
        assert!(other.exact_release_hold.is_none());
        assert!(
            statuses
                .iter()
                .filter(|s| s.port_id != PORT)
                .all(|s| s.exact_release_hold.is_none())
        );

        // An unusable pin never silently becomes channel following.
        let refused = service.check_update(PORT).await.unwrap_err();
        assert_eq!(presentation_key(&refused), "exact_release_unreadable");
        assert!(service.review_exact_release(PORT, "v1.0.0").await.is_err());

        // Export carries the stored text unchanged and keeps the other pin.
        let exported = service.export_library_metadata().unwrap();
        assert_eq!(exported.schema_version, 13);
        let settings = |id: &str| {
            exported
                .port_settings
                .iter()
                .find(|settings| settings.port_id == id)
                .unwrap()
        };
        assert!(settings(PORT).exact_release.is_none());
        assert_eq!(
            settings(PORT).held_exact_release.as_deref(),
            Some("{not a pin")
        );
        assert_eq!(settings(OTHER).exact_release.as_ref(), Some(&other_pin));
        assert!(settings(OTHER).held_exact_release.is_none());

        // Follow is the remedy and restores ordinary channel checks.
        let followed = service.clear_exact_release(PORT).unwrap();
        assert!(followed.exact_release.is_none());
        assert!(followed.exact_release_hold.is_none());
        assert_eq!(
            service.check_update(PORT).await.unwrap().release.version,
            "v2.0.0"
        );
        assert_eq!(
            service.status(OTHER).unwrap().exact_release,
            Some(other_pin)
        );
    }

    #[test]
    fn a_pin_for_another_channel_is_held_not_dropped() {
        let root = tempfile::tempdir().unwrap();
        let library = Library::open(root.path()).unwrap();
        let stale = manifest_pin(PORT, ReleaseChannel::Stable);
        store_raw_pin(&library, PORT, &serde_json::to_string(&stale).unwrap());
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE port_settings SET channel='beta' WHERE port_id=?1",
                [PORT],
            )
            .unwrap();
        let status = library.status(PORT, ReleaseChannel::Stable).unwrap();
        assert_eq!(status.channel, ReleaseChannel::Beta);
        let hold = status.exact_release_hold.unwrap();
        assert_eq!(hold.reason, crate::ExactReleaseHoldReason::ChannelMismatch);
        assert!(hold.detail.contains("different port or channel"));
        let refusal = hold.refusal(PORT);
        assert_eq!(presentation_key(&refusal), "exact_release_channel_changed");
        assert!(
            !refusal
                .report()
                .presentation
                .summary
                .contains("different port or channel")
        );
    }

    #[tokio::test]
    async fn a_pin_and_a_different_requested_channel_explain_the_remedy() {
        let root = tempfile::tempdir().unwrap();
        let provider = Arc::new(Releases {
            release_id: AtomicU64::new(3),
        });
        let library = Library::open(root.path()).unwrap();
        let service = PortcoveService::with_provider(library, provider).unwrap();
        let preview = service.review_exact_release(PORT, "v1.0.0").await.unwrap();
        let status = service
            .pin_exact_release(PORT, "v1.0.0", &preview.review_sha256)
            .await
            .unwrap();
        let port = service.catalog.port(PORT).unwrap();
        let refused = service
            .resolve_release_for_status(
                port,
                ReleaseChannel::Beta,
                preview.selection.platform,
                &status,
            )
            .await
            .unwrap_err();
        assert_eq!(presentation_key(&refused), "exact_release_channel_differs");
        assert_eq!(
            refused.details.get("pinned_channel").map(String::as_str),
            Some("stable")
        );
        // A stale review explains itself rather than reporting a generic conflict.
        let stale = service
            .pin_exact_release(PORT, "v1.0.0", &preview.review_sha256)
            .await
            .unwrap_err();
        assert_eq!(presentation_key(&stale), "exact_release_review_changed");
    }

    #[tokio::test]
    async fn review_explains_a_held_artifact_and_permits_others() {
        let root = tempfile::tempdir().unwrap();
        let provider = Arc::new(Releases {
            release_id: AtomicU64::new(3),
        });
        let library = Library::open(root.path()).unwrap();
        let mut service = PortcoveService::with_provider(library, provider).unwrap();
        // Exact exclusions are authored only for GitHub staged-source or
        // managed PSX routes; choose one the same way the policy tests do.
        let mut document = service.catalog.authoritative_document();
        let platform = Platform::current().unwrap();
        let port = document
            .ports
            .iter_mut()
            .find(|port| {
                port.adapter == crate::AdapterKind::StagedSourcePortable
                    && port.release.provider == crate::ReleaseSource::Github
                    && port.managed_acquisition_hold.is_none()
                    && port.release.curated.is_empty()
                    && port.release.managed_build.is_empty()
                    && port.platforms.contains(&platform)
            })
            .unwrap();
        let held = port.id.clone();
        port.managed_acquisition_hold = Some(crate::ManagedAcquisitionHold {
            reason: "This package is known to corrupt saves.".into(),
            activation_reason: "This package is known to corrupt saves.".into(),
            reviewed_artifacts: Vec::new(),
            excluded_artifacts: vec![crate::ReviewedHoldArtifact {
                version: "v1.0.0".into(),
                sha256: "a".repeat(64),
            }],
        });
        service.replace_catalog_for_test(
            crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );

        let refused = service
            .review_exact_release(&held, "v1.0.0")
            .await
            .unwrap_err();
        assert_eq!(presentation_key(&refused), "exact_release_held");
        assert!(
            refused
                .report()
                .presentation
                .summary
                .contains("This package is known to corrupt saves.")
        );
        assert!(service.status(&held).unwrap().exact_release.is_none());

        // A different package of the same port is not held and can be pinned.
        let preview = service.review_exact_release(&held, "v1.1.0").await.unwrap();
        let status = service
            .pin_exact_release(&held, "v1.1.0", &preview.review_sha256)
            .await
            .unwrap();
        assert_eq!(status.exact_release, Some(preview.selection));
    }
}
