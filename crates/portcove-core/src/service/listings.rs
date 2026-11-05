//! Descriptive directory and actual Library membership without operational definitions.
use super::*;

mod recommendations;

impl PortcoveService {
    /// Read-only OS handoff eligibility from the same bounded display projection as the workspace.
    pub fn is_reviewed_resource_url(&self, url: &str) -> Result<bool> {
        if url.len() > 4096
            || url.trim() != url
            || url.chars().any(char::is_control)
            || !reqwest::Url::parse(url).is_ok_and(|parsed| {
                parsed.scheme() == "https"
                    && parsed.host_str().is_some()
                    && parsed.username().is_empty()
                    && parsed.password().is_none()
            })
        {
            return Ok(false);
        }
        // Retain strict project/artwork links even if a separate directory corrects its own display.
        if self.catalog.ports().iter().any(|port| {
            port.project_url == url
                || repository_updates_url(&port.project_url).as_deref() == Some(url)
                || crate::game_recommendations::normalize(port, u64::MAX)
                    .evidence
                    .iter()
                    .any(|record| record.source == url)
                || port
                    .presentation
                    .as_ref()
                    .and_then(|presentation| presentation.artwork.as_ref())
                    .is_some_and(|artwork| {
                        url == format!("https://www.igdb.com/games/{}", artwork.game_slug)
                    })
        }) || self
            .catalog
            .listings()
            .iter()
            .any(|listing| listing_resource_url(listing, url))
        {
            return Ok(true);
        }
        let projected = self
            .catalog_with_registered_listings(self.catalog.clone(), &self.library.connection()?)?;
        Ok(projected
            .listings()
            .iter()
            .any(|listing| listing_resource_url(listing, url)))
    }

    pub fn listing_status(&self, port_id: &str) -> Result<crate::PortListingStatus> {
        let catalog = self.catalog_for_installed_fallback(port_id)?;
        let listing = catalog.listing(port_id)?;
        let status = self.status(port_id)?;
        let owned = self
            .library
            .all_installs()?
            .iter()
            .any(|install| install.port_id == port_id);
        let launching = self
            .library
            .launch_sessions()?
            .iter()
            .any(|session| session.port_id == port_id && session.outcome.is_none());
        let mut projected = Self::assess_listing_status(status, owned, launching);
        let pending = self.pending_setups()?;
        if let Some(report) = projected.capabilities.as_mut() {
            report.add_setup_context(listing, pending.iter().find(|p| p.port_id == port_id));
        }
        Ok(projected)
    }

    pub fn listing_statuses(&self) -> Result<Vec<crate::PortListingStatus>> {
        let catalog = self
            .catalog_with_registered_listings(self.catalog.clone(), &self.library.connection()?)?;
        let strict = self.statuses()?;
        let ports = catalog
            .listings()
            .iter()
            .map(|listing| (listing.id.clone(), ReleaseChannel::Stable))
            .collect::<Vec<_>>();
        let raw = self.library.statuses_with_metrics(&ports)?.0;
        self.listing_statuses_from(&catalog, &strict, raw, &self.pending_setups()?)
    }

    pub(super) fn catalog_with_registered_listings(
        &self,
        catalog: Catalog,
        connection: &rusqlite::Connection,
    ) -> Result<Catalog> {
        let mut document = catalog.listing_document().clone();
        let mut budget = 8 * 1024 * 1024;
        for id in Library::external_runtime_port_ids_from(connection)? {
            if document.listings.iter().any(|listing| listing.id == id) {
                continue;
            }
            let Some((_, retained)) = self
                .library
                .external_runtime_with_port_bounded(&id, &mut budget)?
            else {
                continue;
            };
            // Retaining display identity preserves the user's Library entry;
            // it does not restore a retired managed installation definition.
            document.listings.push(retained.listing(&id)?.clone());
        }
        for pending in Self::pending_setups_from(connection)? {
            if !document
                .listings
                .iter()
                .any(|listing| listing.id == pending.port_id)
            {
                document.listings.push(pending.listing);
            }
        }
        catalog.with_projected_listing_document(document)
    }

    pub(super) fn listing_statuses_from(
        &self,
        catalog: &Catalog,
        strict: &[PortStatus],
        raw: Vec<PortStatus>,
        pending: &[crate::PendingSetupRecord],
    ) -> Result<Vec<crate::PortListingStatus>> {
        let strict = strict
            .iter()
            .map(|status| (status.port_id.as_str(), status))
            .collect::<HashMap<_, _>>();
        let owned = self
            .library
            .all_installs()?
            .into_iter()
            .map(|install| install.port_id)
            .collect::<HashSet<_>>();
        let launching = self
            .library
            .launch_sessions()?
            .into_iter()
            .filter(|session| session.outcome.is_none())
            .map(|session| session.port_id)
            .collect::<HashSet<_>>();
        raw.into_iter()
            .map(|status| {
                let listing = catalog.listing(&status.port_id)?;
                let status = if let Some(status) = strict.get(status.port_id.as_str()) {
                    (**status).clone()
                } else if status
                    .external_runtime
                    .as_ref()
                    .is_some_and(|record| record.user_selected.is_none())
                {
                    self.status(&status.port_id)?
                } else {
                    self.with_rollback_assessment(self.with_user_selected_readiness(status))
                };
                let has_owner = owned.contains(&status.port_id);
                let launching = launching.contains(&status.port_id);
                let mut projected = Self::assess_listing_status(status, has_owner, launching);
                if let Some(report) = projected.capabilities.as_mut() {
                    report.add_setup_context(
                        listing,
                        pending.iter().find(|p| p.port_id == projected.port_id),
                    );
                }
                Ok(projected)
            })
            .collect()
    }

    fn assess_listing_status(
        status: PortStatus,
        has_managed_owner: bool,
        launching: bool,
    ) -> crate::PortListingStatus {
        use crate::ListingAction;
        let selected = status
            .external_runtime
            .as_ref()
            .is_some_and(|record| record.user_selected.is_some());
        let registered = status.external_runtime.is_some();
        let attach_reason = if has_managed_owner {
            "This port has a Portcove-managed installation. Keep that installation or explicitly remove it before selecting another route."
        } else if registered {
            "This port already has an external registration. Edit its selected executable or remove its registration before choosing another."
        } else {
            "Close the game and resolve its pending launch before selecting an installation."
        };
        let available =
            |action: ListingAction, allowed: bool, reason: &str| crate::ListingActionAssessment {
                action,
                allowed,
                reason: (!allowed).then(|| reason.to_owned()),
            };
        let actions = vec![
            available(
                ListingAction::AttachExisting,
                !has_managed_owner && !registered && !launching,
                attach_reason,
            ),
            available(
                ListingAction::RelinkExisting,
                selected && !has_managed_owner && !launching,
                "Relinking requires a user-selected registration with no active launch.",
            ),
            available(
                ListingAction::Launch,
                status
                    .readiness
                    .as_ref()
                    .is_some_and(|readiness| readiness.launchable)
                    && !launching,
                "The registered installation is not ready to launch, or a launch is already active.",
            ),
            available(
                ListingAction::RemoveRegistration,
                registered && !has_managed_owner && !launching,
                "Registration removal requires an external installation with no active launch.",
            ),
        ];
        crate::PortListingStatus {
            port_id: status.port_id.clone(),
            capabilities: Some(crate::PortCapabilityReport::from_status(&status, &actions)),
            status,
            actions,
        }
    }
}

fn listing_resource_url(listing: &crate::PortListing, url: &str) -> bool {
    listing.project_url == url
        || [
            Some(listing.project_url.as_str()),
            listing.release_url.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter_map(repository_updates_url)
        .any(|reviewed| reviewed == url)
        || super::advisories::reviewed_advisory_url(listing, url)
        || [
            listing.release_url.as_deref(),
            listing.setup_url.as_deref(),
            listing
                .manual_setup
                .as_ref()
                .and_then(|guide| guide.help_url.as_deref()),
        ]
        .into_iter()
        .flatten()
        .any(|reviewed| reviewed == url)
        || listing.media.iter().any(|media| {
            [
                media.url.as_str(),
                media.source_url.as_str(),
                media.rights_url.as_str(),
            ]
            .contains(&url)
        })
        || listing.artwork.as_ref().is_some_and(|artwork| {
            url == format!("https://www.igdb.com/games/{}", artwork.game_slug)
        })
}

/// A single navigation destination derived from a reviewed repository identity.
/// This does not authorize repository descendants, acquisition or execution.
fn repository_updates_url(value: &str) -> Option<String> {
    if value.len() > 4096 || value.trim() != value || value.chars().any(char::is_control) {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let parts = url
        .path()
        .trim_end_matches('/')
        .strip_prefix('/')?
        .split('/')
        .collect::<Vec<_>>();
    let component = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    };
    let (project, suffix) = match url.host_str()? {
        "github.com" if parts.len() >= 2 && (parts.len() == 2 || parts[2] == "releases") => {
            (&parts[..2], "/releases")
        }
        "gitlab.com" => {
            let end = parts
                .iter()
                .position(|part| *part == "-")
                .unwrap_or(parts.len());
            if end < 2 || (end < parts.len() && parts.get(end + 1) != Some(&"releases")) {
                return None;
            }
            (&parts[..end], "/-/releases")
        }
        _ => return None,
    };
    if !project.iter().all(|part| component(part)) {
        return None;
    }
    let repository = project.last()?;
    let repository = repository.strip_suffix(".git").unwrap_or(repository);
    if !component(repository) {
        return None;
    }
    Some(format!(
        "https://{}/{}/{repository}{suffix}",
        url.host_str()?,
        project[..project.len() - 1].join("/")
    ))
}

#[cfg(test)]
mod resource_url_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repository_update_handoff_is_one_canonical_reviewed_destination() {
        let temporary = tempfile::tempdir().unwrap();
        let mut service =
            PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
        let listings = [
            (
                "github-project",
                "https://github.com/owner/game.git",
                Some("https://github.com/owner/game/releases/tag/v1"),
            ),
            (
                "gitlab-project",
                "https://gitlab.com/group/subgroup/game.git",
                Some("https://gitlab.com/group/subgroup/game/-/releases/v2"),
            ),
            (
                "release-only",
                "https://example.org/project",
                Some("https://github.com/owner/packager/releases/tag/v3"),
            ),
        ]
        .into_iter()
        .map(|(id, project, release)| {
            serde_json::from_value(json!({
                "id":id,"name":"Reviewed repository", "summary":"Navigation fixture.",
                "project_url":project,"release_url":release,"platforms":[],"availability":"unknown"
            }))
            .unwrap()
        })
        .collect();
        service.catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#)
            .unwrap()
            .with_listing_document(crate::CatalogListingDocument {
                format_version: 1,
                listings,
            })
            .unwrap();
        for url in [
            "https://github.com/owner/game/releases",
            "https://gitlab.com/group/subgroup/game/-/releases",
            "https://github.com/owner/packager/releases",
        ] {
            assert!(service.is_reviewed_resource_url(url).unwrap(), "{url}");
        }
        for url in [
            "https://github.com/foreign/game/releases",
            "https://github.com/owner/another-game/releases",
            "https://github.com/owner/game/releases?redirect=elsewhere",
            "https://github.com/owner/game/releases#changed",
            "https://github.com/owner/game/releases/latest",
            "https://github.com/owner/game/releases/download/v2/game.exe",
            "https://github.com/owner/game/issues",
            "https://gitlab.com/group/foreign/game/-/releases",
            "https://gitlab.com/group/subgroup/game/-/releases/v3",
            "https://github.com.evil.example/owner/game/releases",
            "https://player:secret@github.com/owner/game/releases",
            "https://github.com:8443/owner/game/releases",
        ] {
            assert!(!service.is_reviewed_resource_url(url).unwrap(), "{url}");
        }
        for source in [
            "http://github.com/owner/game",
            "https://player:secret@github.com/owner/game",
            "https://github.com:8443/owner/game",
            "https://github.com.evil.example/owner/game",
            "https://github.com/owner/game/blob/main/README.md",
            "https://gitlab.com/group/game/-/blob/main/README.md",
            " https://github.com/owner/game",
            "https://github.com/owner/game\n",
            "https://github.com/owner/game/releases/\u{85}",
        ] {
            assert!(repository_updates_url(source).is_none(), "{source}");
        }
        assert!(
            repository_updates_url(&format!(
                "https://github.com/owner/game/releases?note={}",
                "🎮".repeat(2000)
            ))
            .is_none()
        );
    }

    #[test]
    fn handoff_accepts_only_exact_reviewed_current_listing_and_media_resources() {
        let temporary = tempfile::tempdir().unwrap();
        let mut service =
            PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
        let image_url = format!(
            "https://raw.githubusercontent.com/owner/media/{}/image.png",
            "a".repeat(40)
        );
        let listing: crate::PortListing = serde_json::from_value(json!({
            "id":"resource-fixture", "name":"Resource fixture", "summary":"Reviewed descriptive links only.",
            "project_url":"https://example.com/project", "release_url":"https://example.com/releases/v1",
            "setup_url":"https://example.com/setup",
            "manual_setup":{"steps":[{"title":"Read setup", "instruction":"Use upstream instructions."}],"warnings":[],"help_url":"https://example.com/manual"},
            "media":[{"id":"image", "role":"screenshot", "subject":{"kind":"port","port_id":"resource-fixture"},
                "caption":"A synthetic image fixture.", "url":image_url, "sha256":"b".repeat(64), "width":640, "height":360,
                "attribution":"Fixture author", "source_url":"https://example.com/image/source", "license":"CC0-1.0", "rights_url":"https://example.com/image/rights"}]
        })).unwrap();
        service.catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#)
            .unwrap()
            .with_listing_document(crate::CatalogListingDocument {
                format_version: 3,
                listings: vec![listing],
            })
            .unwrap();
        for url in [
            "https://example.com/project",
            "https://example.com/releases/v1",
            "https://example.com/setup",
            "https://example.com/manual",
            image_url.as_str(),
            "https://example.com/image/source",
            "https://example.com/image/rights",
        ] {
            assert!(service.is_reviewed_resource_url(url).unwrap(), "{url}");
        }
        for url in [
            "http://example.com/project",
            "file:///tmp/image.png",
            "javascript:alert(1)",
            "https://user:password@example.com/project",
            "https://example.com.evil/project",
            "https://example.com/project?redirect=elsewhere",
            "https://example.com/other",
            "https://example.com/image/rights#changed",
            " https://example.com/project",
        ] {
            assert!(!service.is_reviewed_resource_url(url).unwrap(), "{url}");
        }
    }
}
