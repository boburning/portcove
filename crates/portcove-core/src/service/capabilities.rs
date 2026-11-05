//! Inert presentation of existing operation owners. Never a plan or an action grant.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ListingAction, ListingActionAssessment, PortAction, PortActionAssessment,
    PortActionAvailability, PortStatus,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityMode {
    Automatic,
    Manual,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityFeature {
    Setup,
    OriginalFiles,
    Launch,
    Updates,
    Settings,
    Backup,
    Restore,
    PreviousVersion,
    Gameplay,
    Controls,
    Audio,
    Performance,
    SaveCompatibility,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortCapabilityFeature {
    pub feature: CapabilityFeature,
    /// Management mode, separate from prerequisites and evidence of successful use.
    pub mode: CapabilityMode,
    pub explanation: String,
    pub next_step: String,
    pub action: Option<PortActionAssessment>,
    pub listing_action: Option<ListingActionAssessment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortCapabilityRoute {
    pub route: String,
    pub install_id: Option<String>,
    pub features: Vec<PortCapabilityFeature>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortCapabilityReport {
    pub format_version: u32,
    pub port_id: String,
    pub routes: Vec<PortCapabilityRoute>,
    /// Matching observations are enriched only on a focused request. Absence is untested.
    pub observations: Vec<crate::RecommendationEvidence>,
    pub protection: Option<crate::PlayerDataProtection>,
    pub settings: Option<crate::GameSettingsView>,
    pub source_readiness: Option<crate::LaunchReadiness>,
    /// Optional detail failures are local to this report, never action refusals.
    pub detail_problems: Vec<String>,
    pub advisory_state: String,
    pub advisories: Vec<super::advisories::PortCapabilityNotice>,
    pub setup_guide: Option<crate::ManualSetupGuide>,
    pub pending_setup: Option<super::PendingSetupState>,
}

fn action_feature(
    status: &PortStatus,
    feature: CapabilityFeature,
    action: PortAction,
) -> PortCapabilityFeature {
    let matches = status
        .port_actions
        .iter()
        .filter(|a| a.action == action)
        .collect::<Vec<_>>();
    let assessment = (matches.len() == 1).then(|| *matches[0]);
    let mode = match assessment.map(|a| a.availability) {
        Some(PortActionAvailability::Allowed | PortActionAvailability::Waiting) => {
            CapabilityMode::Automatic
        }
        Some(PortActionAvailability::Held | PortActionAvailability::NotOffered) => {
            CapabilityMode::Unavailable
        }
        None => CapabilityMode::Unknown,
    };
    PortCapabilityFeature {
        feature,
        mode,
        explanation: "Current operation assessment; execution rechecks its requirements.".into(),
        next_step: "Review this operation's requirements and any current refusal.".into(),
        action: assessment,
        listing_action: None,
    }
}

fn simple(
    feature: CapabilityFeature,
    mode: CapabilityMode,
    explanation: &str,
    next_step: &str,
) -> PortCapabilityFeature {
    PortCapabilityFeature {
        feature,
        mode,
        explanation: explanation.into(),
        next_step: next_step.into(),
        action: None,
        listing_action: None,
    }
}

impl PortCapabilityReport {
    /// Cheap, pure projection used by workspace rendering: no reads, hashing or provider calls.
    pub(crate) fn from_status(status: &PortStatus, actions: &[ListingActionAssessment]) -> Self {
        use CapabilityFeature as F;
        use CapabilityMode as M;
        let selected = status
            .external_runtime
            .as_ref()
            .is_some_and(|r| r.user_selected.is_some());
        let install_id = status
            .active
            .as_ref()
            .map(|i| i.id.clone())
            .or_else(|| status.external_runtime.as_ref().map(|i| i.id.clone()));
        let mut routes = vec![];
        for (route, action) in [
            ("managed", PortAction::Install),
            ("accepted-external", PortAction::RegisterExternal),
        ] {
            routes.push(PortCapabilityRoute {
                route: route.into(),
                install_id: None,
                features: vec![action_feature(status, F::Setup, action)],
            });
        }
        let attach = actions
            .iter()
            .filter(|a| a.action == ListingAction::AttachExisting)
            .collect::<Vec<_>>();
        let mut setup = simple(
            F::Setup,
            M::Unknown,
            "Explicit non-owning selection of a prepared executable.",
            "Follow upstream preparation, select your executable, then review registration.",
        );
        if attach.len() == 1 {
            setup.mode = if attach[0].allowed {
                M::Manual
            } else {
                M::Unavailable
            };
            setup.listing_action = Some(attach[0].clone());
        }
        routes.push(PortCapabilityRoute { route: "existing-copy".into(), install_id: None, features: vec![setup,
            simple(F::Updates, M::Manual, "Updates are handled by you or upstream.", "Follow the upstream update instructions."),
            simple(F::Backup, M::Unavailable, "Portcove does not collect backups of this external copy. This says nothing about the game's ability to save.", "Protect external saved data using the upstream instructions.")] });
        let mut features = vec![
            action_feature(status, F::Launch, PortAction::Launch),
            action_feature(status, F::Updates, PortAction::Update),
            action_feature(status, F::Backup, PortAction::BackupCreate),
            action_feature(status, F::Restore, PortAction::BackupRestore),
            action_feature(status, F::PreviousVersion, PortAction::Rollback),
            simple(
                F::OriginalFiles,
                M::Unknown,
                "Source checking depends on this installation's actual input contract.",
                "Review the current game-file assessments and upstream requirements.",
            ),
            simple(
                F::Settings,
                M::Unknown,
                "Optional settings require a matching retained installation contract and current configuration.",
                "Open game settings to check this installation.",
            ),
        ];
        if let Some(assessment) = status
            .readiness
            .as_ref()
            .and_then(|r| r.source_assessment.as_ref())
        {
            let source = features
                .iter_mut()
                .find(|r| r.feature == F::OriginalFiles)
                .expect("source row exists");
            source.mode = if matches!(
                assessment.contract,
                crate::SourceContractResult::Supported { .. }
            ) {
                M::Automatic
            } else {
                M::Unknown
            };
            source.explanation = "The current source assessment is included with this report. Review its identity, health and admission separately in Game files; it is not a gameplay observation.".into();
        }
        if status.external_runtime.is_some() {
            features[1].mode = M::Manual;
            features[1].explanation =
                "This external installation and its updates remain yours to manage.".into();
            features[1].next_step =
                "Follow upstream instructions; review any executable change before relinking."
                    .into();
            features[2].mode = M::Unavailable;
            features[2].explanation = "External saved data is not backed up by Portcove; the game may still save normally.".into();
            features[2].next_step =
                "Review external save locations and protect them separately.".into();
        }
        for feature in [
            F::Gameplay,
            F::Controls,
            F::Audio,
            F::Performance,
            F::SaveCompatibility,
        ] {
            features.push(simple(feature, M::Unknown, "No matching observation is established by this summary.", "Review scoped evidence when available; ordinary actions retain their own eligibility."));
        }
        routes.push(PortCapabilityRoute {
            route: if selected {
                "user-selected"
            } else if status.external_runtime.is_some() {
                "accepted-external"
            } else if status.active.is_some() {
                "installed"
            } else {
                "not-installed"
            }
            .into(),
            install_id,
            features,
        });
        Self {
            format_version: 1,
            port_id: status.port_id.clone(),
            routes,
            observations: vec![],
            protection: None,
            settings: None,
            source_readiness: status.readiness.clone(),
            detail_problems: vec![],
            advisory_state: "missing".into(),
            advisories: vec![],
            setup_guide: None,
            pending_setup: None,
        }
    }

    pub(super) fn add_setup_context(
        &mut self,
        listing: &crate::PortListing,
        pending: Option<&super::PendingSetupRecord>,
    ) {
        self.setup_guide = listing.manual_setup.clone();
        self.pending_setup = pending.map(|p| p.state);
        let mut setup = simple(
            CapabilityFeature::Setup,
            CapabilityMode::Unknown,
            "Upstream package availability is checked separately; instructions do not grant acquisition or execution.",
            "Review the project instructions and current package options.",
        );
        if listing.manual_setup.is_some() || listing.setup_url.is_some() {
            setup.mode = CapabilityMode::Manual;
            setup.explanation = "Reviewed upstream instructions are available; preparation and updates remain upstream-owned.".into();
            setup.next_step = format!(
                "Review upstream setup at {}",
                listing
                    .setup_url
                    .as_deref()
                    .unwrap_or(listing.project_url.as_str())
            );
        }
        if let Some(reason) = &listing.download_block_reason {
            setup.explanation = format!("Fresh downloads are restricted: {reason}");
        }
        if let Some(pending) = pending {
            setup.mode = CapabilityMode::Manual;
            setup.explanation = match pending.state {
                super::PendingSetupState::Downloaded => "Downloaded; continue setup by reviewing the prepared executable. Nothing has been run by the download.".into(),
                super::PendingSetupState::AttentionRequired => pending.reason.clone().unwrap_or_else(|| "This saved download needs attention before continuing setup.".into()),
            };
            setup.next_step = if pending.state == super::PendingSetupState::Downloaded {
                "Continue setup"
            } else {
                "Review download"
            }
            .into();
        }
        self.routes.insert(
            self.routes.len().saturating_sub(1),
            PortCapabilityRoute {
                route: "upstream-setup".into(),
                install_id: None,
                features: vec![setup],
            },
        );
    }
}

impl super::PortcoveService {
    /// Focused read; optional detail failures never change operation eligibility.
    pub fn port_capabilities(&self, port_id: &str) -> crate::Result<PortCapabilityReport> {
        let status = self.listing_status(port_id)?;
        let mut report = status
            .capabilities
            .clone()
            .unwrap_or_else(|| PortCapabilityReport::from_status(&status.status, &status.actions));
        let catalog = self.catalog_for_installed_fallback(port_id)?;
        if let Ok(port) = catalog.port(port_id) {
            // These exact-scope records remain historical until an environment/edition/route
            // context is selected by the recommendation owner. Never refresh its history here.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            report.observations = crate::game_recommendations::normalize(port, now).evidence;
        }
        report.add_advisories(catalog.listing(port_id)?, &status.status);
        if status.status.active.is_some() {
            match self.list_backups(port_id) {
                Ok(inventory) => {
                    if let Some(current) = report.routes.last_mut() {
                        for (feature, assessment) in [
                            (CapabilityFeature::Backup, inventory.create_assessment),
                            (CapabilityFeature::Restore, inventory.restore_assessment),
                        ] {
                            if let Some(row) = current
                                .features
                                .iter_mut()
                                .find(|row| row.feature == feature)
                            {
                                row.action = Some(assessment);
                                row.mode = match assessment.availability {
                                    PortActionAvailability::Allowed
                                    | PortActionAvailability::Waiting => CapabilityMode::Automatic,
                                    _ => CapabilityMode::Unavailable,
                                };
                            }
                        }
                    }
                    report.protection = inventory.protection;
                }
                Err(error) => report.detail_problems.push(error.message),
            }
            match self.get_game_settings(port_id) {
                Ok(settings) => {
                    if let Some(row) = report.routes.last_mut().and_then(|r| {
                        r.features
                            .iter_mut()
                            .find(|f| f.feature == CapabilityFeature::Settings)
                    }) {
                        row.mode = if settings.available {
                            CapabilityMode::Automatic
                        } else {
                            CapabilityMode::Unavailable
                        };
                        row.explanation = settings.reason.clone().unwrap_or_else(|| "Settings capability is available; each file reports whether configuration has been initialized.".into());
                    }
                    report.settings = Some(settings);
                }
                Err(error) => report.detail_problems.push(error.message),
            }
        }
        let after = self.listing_status(port_id)?;
        // A focused read must not combine optional details with a replacement installation.
        if serde_json::to_value(&status.status)? != serde_json::to_value(&after.status)?
            || report.pending_setup != after.capabilities.as_ref().and_then(|r| r.pending_setup)
        {
            return Err(crate::PortcoveError::conflict(
                "installation changed while capability details were read; refresh this entry",
            ));
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status() -> PortStatus {
        serde_json::from_value(json!({ "port_id": "fixture", "channel": "stable", "update_policy": "notify", "active": null, "previous": null, "staged": null,
            "port_actions": [{ "action": "install", "availability": "held", "reason": "definition_ineligible", "definition": { "outcome": "hold", "reason": "authenticated_integrity_required" } },
                { "action": "launch", "availability": "allowed", "reason": "available" }]
        })).unwrap()
    }

    #[test]
    fn capability_report_preserves_independent_routes_and_refusals_without_io() {
        let status = status();
        let before = serde_json::to_value(&status).unwrap();
        let actions = vec![ListingActionAssessment {
            action: ListingAction::AttachExisting,
            allowed: true,
            reason: None,
        }];
        let report = PortCapabilityReport::from_status(&status, &actions);
        assert_eq!(
            report.routes[0].features[0].mode,
            CapabilityMode::Unavailable
        );
        assert_eq!(
            report.routes[0].features[0].action.unwrap().definition,
            status.port_actions[0].definition
        );
        assert_eq!(report.routes[2].features[0].mode, CapabilityMode::Manual);
        assert_eq!(report.routes[3].features[0].mode, CapabilityMode::Automatic);
        assert!(report.observations.is_empty());
        assert_eq!(serde_json::to_value(status).unwrap(), before);
    }

    #[test]
    fn capability_advisory_failure_and_future_versions_do_not_change_launch() {
        let status = status();
        let mut listing: crate::PortListing = serde_json::from_value(json!({"id":"fixture", "name":"Fixture", "summary":"Fixture", "project_url":"https://example.com/fixture"})).unwrap();
        for value in [
            json!({ "format_version": 2 }),
            json!({ "format_version": 1, "records": "wrong" }),
        ] {
            listing.compatibility = Some(value);
            let mut report = PortCapabilityReport::from_status(&status, &[]);
            report.add_advisories(&listing, &status);
            assert_ne!(report.advisory_state, "available");
            assert_eq!(report.routes[3].features[0].mode, CapabilityMode::Automatic);
            let document = crate::CatalogListingDocument {
                format_version: 7,
                listings: vec![listing.clone()],
            };
            document.validate().unwrap();
            let legacy = document.export_format(6).unwrap();
            assert!(legacy.listings[0].compatibility.is_none());
            let mut wrong_version = document.clone();
            wrong_version.format_version = 6;
            assert!(wrong_version.validate().is_err());
        }
    }

    #[test]
    fn legacy_export_keeps_real_acquisition_restrictions() {
        let listing: crate::PortListing = serde_json::from_value(json!({"id":"fixture", "name":"Fixture", "summary":"Fixture", "project_url":"https://example.com/fixture", "download_block_reason":"No accepted original-input route.", "compatibility":{"format_version":2}})).unwrap();
        let document = crate::CatalogListingDocument {
            format_version: 7,
            listings: vec![listing],
        };
        for version in [5, 6, 7] {
            let export = document.export_format(version).unwrap();
            assert_eq!(
                export.listings[0].download_block_reason,
                document.listings[0].download_block_reason
            );
            assert_eq!(export.listings[0].compatibility.is_some(), version == 7);
        }
    }
}
