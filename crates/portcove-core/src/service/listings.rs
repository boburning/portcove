//! Descriptive directory and actual Library membership without operational definitions.
use super::*;

impl PortcoveService {
    pub fn listing_status(&self, port_id: &str) -> Result<crate::PortListingStatus> {
        self.catalog_for_installed_fallback(port_id)?
            .listing(port_id)?;
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
        Ok(Self::assess_listing_status(status, owned, launching))
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
        self.listing_statuses_from(&catalog, &strict, raw)
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
                catalog.listing(&status.port_id)?;
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
                Ok(Self::assess_listing_status(status, has_owner, launching))
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
            status,
            actions,
        }
    }
}
