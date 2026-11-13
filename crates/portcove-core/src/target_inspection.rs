//! Per-target route offering for maintenance (#4129), without a library.
//!
//! For each requested port and explicit target platform this reports what the
//! catalog itself decides: whether the managed and external routes are offered,
//! through the same predicate that builds a library's action table, plus the
//! catalog's acquisition hold, download restriction and provider-resolution
//! needs. Anything a host or library decides — definition trust eligibility,
//! installed state, readiness and native evidence — is reported as unknown,
//! never as another host's result relabelled for this target.
use schemars::JsonSchema;
use serde::Serialize;

use crate::definition_eligibility::{PortAction, PortActionReason, RouteHolding, route_exclusion};
use crate::{Catalog, Platform, PortcoveError, Result};

/// Every target platform Core can represent.
pub const INSPECTABLE_PLATFORMS: [Platform; 4] = [
    Platform::WindowsX86_64,
    Platform::LinuxX86_64,
    Platform::MacosX86_64,
    Platform::MacosAarch64,
];

/// At most this many ports per request; a caller batches beyond it.
pub const MAX_INSPECTED_PORTS: usize = 4096;

/// The Core that produced a report, so maintenance binds results to exact inputs.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct CoreProducer {
    /// Source revision recorded at build time (`PORTCOVE_SOURCE_REVISION`); absent
    /// when the build did not record one, which leaves the binding unverified.
    pub source_revision: Option<&'static str>,
    /// Cargo features compiled into Core that can change catalog or archive behavior.
    pub features: Vec<&'static str>,
    /// SHA-256 of the `catalog.json` compiled into this binary.
    pub embedded_catalog_sha256: String,
    /// SHA-256 of the `listings.json` compiled in and merged into that catalog.
    pub embedded_listings_sha256: String,
    /// True when a qualification build replaced the compiled catalog at runtime;
    /// the digests above then describe bytes that were not used.
    pub catalog_override: bool,
}

impl CoreProducer {
    pub fn current() -> Self {
        let mut features = Vec::new();
        if cfg!(feature = "qualification-fixtures") {
            features.push("qualification-fixtures");
        }
        if cfg!(feature = "archive-fuzzing") {
            features.push("archive-fuzzing");
        }
        Self {
            source_revision: option_env!("PORTCOVE_SOURCE_REVISION")
                .filter(|revision| !revision.is_empty()),
            features,
            embedded_catalog_sha256: crate::catalog::embedded_catalog_sha256(),
            embedded_listings_sha256: crate::catalog::listings::embedded_listings_sha256(),
            catalog_override: cfg!(feature = "qualification-fixtures")
                && std::env::var_os("PORTCOVE_QUALIFICATION_CATALOG").is_some(),
        }
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TargetInspection {
    pub format_version: u32,
    pub producer: CoreProducer,
    /// What this report decides and what it leaves to a host and library.
    pub scope: &'static str,
    pub platforms: Vec<Platform>,
    pub ports: Vec<PortTargetInspection>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CatalogPresence {
    /// An operational catalog definition exists.
    Operational,
    /// Only a directory listing exists; no route is managed.
    ListingOnly,
    /// Neither exists in this catalog.
    NotFound,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PortTargetInspection {
    pub port_id: String,
    pub presence: CatalogPresence,
    /// Platforms the definition declares, or the listing's descriptive ones.
    pub declared_platforms: Vec<Platform>,
    /// The catalog's reviewed hold on fresh managed acquisition, if any.
    pub acquisition_hold: Option<String>,
    /// The listing's reviewed restriction on fresh self-service downloads, if any.
    pub download_restriction: Option<String>,
    pub targets: Vec<TargetRoutes>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TargetRoutes {
    pub platform: Platform,
    pub routes: Vec<TargetRoute>,
    /// Whether the managed route must resolve a provider release on this target.
    pub provider_resolution_required: bool,
    /// Decided by a library's trust state, never by the catalog alone.
    pub definition_eligibility: Unassessed,
    /// Decided by an installation on a host, never by the catalog alone.
    pub readiness: Unassessed,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TargetRoute {
    pub action: PortAction,
    pub offered: bool,
    pub reason: Option<PortActionReason>,
}

/// A fact this inspection deliberately does not decide.
#[derive(Debug, Clone, Copy, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Unassessed {
    Unknown,
}

/// Route offering for `port_ids` (every listed port when empty) on each of
/// `platforms` (every inspectable platform when empty), for a fresh library.
pub fn inspect_targets(
    catalog: &Catalog,
    port_ids: &[String],
    platforms: &[Platform],
) -> Result<TargetInspection> {
    let platforms: Vec<Platform> = if platforms.is_empty() {
        INSPECTABLE_PLATFORMS.to_vec()
    } else {
        let mut unique = Vec::new();
        for &platform in platforms {
            if !unique.contains(&platform) {
                unique.push(platform);
            }
        }
        unique
    };
    let ids: Vec<String> = if port_ids.is_empty() {
        let mut ids: Vec<String> = catalog
            .listings()
            .iter()
            .map(|listing| listing.id.clone())
            .chain(catalog.ports().iter().map(|port| port.id.clone()))
            .collect();
        ids.sort();
        ids.dedup();
        ids
    } else {
        if port_ids.len() > MAX_INSPECTED_PORTS {
            return Err(PortcoveError::usage(format!(
                "inspect at most {MAX_INSPECTED_PORTS} ports per request"
            )));
        }
        let mut ids = Vec::new();
        for id in port_ids {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        ids
    };
    if ids.len() > MAX_INSPECTED_PORTS {
        return Err(PortcoveError::usage(format!(
            "inspect at most {MAX_INSPECTED_PORTS} ports per request"
        )));
    }
    let ports = ids
        .into_iter()
        .map(|id| inspect_port(catalog, id, &platforms))
        .collect();
    Ok(TargetInspection {
        format_version: 1,
        producer: CoreProducer::current(),
        scope: "catalog route offering per target for a fresh library; definition trust, installed state, readiness and native evidence are not assessed",
        platforms,
        ports,
    })
}

fn inspect_port(
    catalog: &Catalog,
    port_id: String,
    platforms: &[Platform],
) -> PortTargetInspection {
    let listing = catalog.listing(&port_id).ok();
    let download_restriction = listing.and_then(|listing| listing.download_block_reason.clone());
    let Ok(port) = catalog.port(&port_id) else {
        return PortTargetInspection {
            presence: if listing.is_some() {
                CatalogPresence::ListingOnly
            } else {
                CatalogPresence::NotFound
            },
            declared_platforms: listing
                .map(|listing| listing.platforms.clone())
                .unwrap_or_default(),
            acquisition_hold: None,
            download_restriction,
            targets: Vec::new(),
            port_id,
        };
    };
    let held = crate::managed_runtime_policy::acquisition_hold(catalog, &port_id).is_some();
    let targets = platforms
        .iter()
        .map(|&platform| TargetRoutes {
            platform,
            routes: [PortAction::Install, PortAction::RegisterExternal]
                .into_iter()
                .map(|action| {
                    // A reviewed acquisition hold withdraws fresh managed acquisition,
                    // exactly as it does in a library's action table.
                    let reason = if held && crate::managed_runtime_policy::hold_withdraws(action) {
                        Some(PortActionReason::RouteNotOffered)
                    } else {
                        route_exclusion(port, RouteHolding::default(), platform, action)
                    };
                    TargetRoute {
                        action,
                        offered: reason.is_none(),
                        reason,
                    }
                })
                .collect(),
            provider_resolution_required:
                crate::managed_runtime_policy::requires_provider_resolution_on(port, platform),
            definition_eligibility: Unassessed::Unknown,
            readiness: Unassessed::Unknown,
        })
        .collect();
    PortTargetInspection {
        presence: CatalogPresence::Operational,
        declared_platforms: port.platforms.clone(),
        acquisition_hold: crate::managed_runtime_policy::acquisition_hold_reason(catalog, &port_id)
            .map(str::to_owned),
        download_restriction,
        targets,
        port_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalog_port_is_inspected_on_every_target_without_a_library() {
        let catalog = Catalog::embedded().unwrap();
        let report = inspect_targets(&catalog, &[], &[]).unwrap();
        assert_eq!(report.platforms, INSPECTABLE_PLATFORMS.to_vec());
        assert!(report.ports.len() >= catalog.ports().len());
        for port in catalog.ports() {
            let inspected = report
                .ports
                .iter()
                .find(|entry| entry.port_id == port.id)
                .unwrap();
            assert!(matches!(inspected.presence, CatalogPresence::Operational));
            assert_eq!(inspected.targets.len(), INSPECTABLE_PLATFORMS.len());
            for target in &inspected.targets {
                // The same predicate and hold as a fresh library's action table.
                for route in &target.routes {
                    let expected = if inspected.acquisition_hold.is_some()
                        && crate::managed_runtime_policy::hold_withdraws(route.action)
                    {
                        Some(PortActionReason::RouteNotOffered)
                    } else {
                        route_exclusion(
                            port,
                            RouteHolding::default(),
                            target.platform,
                            route.action,
                        )
                    };
                    assert_eq!(route.reason, expected);
                    assert_eq!(route.offered, expected.is_none());
                }
                // A route is never offered on a platform the definition does not declare.
                if !port.platforms.contains(&target.platform) {
                    assert!(target.routes.iter().all(|route| !route.offered));
                }
            }
        }
    }

    #[test]
    fn unknown_and_listing_only_ports_are_reported_without_routes() {
        let catalog = Catalog::embedded().unwrap();
        let report = inspect_targets(
            &catalog,
            &["definitely-not-a-port".into()],
            &[Platform::LinuxX86_64, Platform::LinuxX86_64],
        )
        .unwrap();
        assert_eq!(report.platforms, vec![Platform::LinuxX86_64]);
        assert!(matches!(
            report.ports[0].presence,
            CatalogPresence::NotFound
        ));
        assert!(report.ports[0].targets.is_empty());
        if let Some(listing) = catalog
            .listings()
            .iter()
            .find(|listing| catalog.port(&listing.id).is_err())
        {
            let report = inspect_targets(&catalog, std::slice::from_ref(&listing.id), &[]).unwrap();
            assert!(matches!(
                report.ports[0].presence,
                CatalogPresence::ListingOnly
            ));
            assert!(report.ports[0].targets.is_empty());
        }
    }

    #[test]
    fn a_catalog_acquisition_hold_withdraws_install_as_in_the_library() {
        let catalog = Catalog::embedded().unwrap();
        let Some(port) = catalog
            .ports()
            .iter()
            .find(|port| port.managed_acquisition_hold.is_some())
        else {
            return;
        };
        let report = inspect_targets(&catalog, std::slice::from_ref(&port.id), &[]).unwrap();
        let inspected = &report.ports[0];
        assert!(inspected.acquisition_hold.is_some());
        for target in &inspected.targets {
            let install = target
                .routes
                .iter()
                .find(|route| route.action == PortAction::Install)
                .unwrap();
            assert!(!install.offered);
            assert_eq!(install.reason, Some(PortActionReason::RouteNotOffered));
        }
    }

    #[test]
    fn the_report_names_the_producing_core() {
        let catalog = Catalog::embedded().unwrap();
        let producer = inspect_targets(&catalog, &["x".into()], &[])
            .unwrap()
            .producer;
        assert_eq!(producer.embedded_catalog_sha256.len(), 64);
        assert_eq!(producer.embedded_listings_sha256.len(), 64);
        assert_ne!(
            producer.embedded_catalog_sha256,
            producer.embedded_listings_sha256
        );
        if !cfg!(feature = "qualification-fixtures") {
            assert!(!producer.catalog_override);
        }
        assert!(
            producer
                .embedded_catalog_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        );
        assert_eq!(
            producer.features.contains(&"qualification-fixtures"),
            cfg!(feature = "qualification-fixtures")
        );
    }

    #[test]
    fn requests_beyond_the_bound_are_refused() {
        let catalog = Catalog::embedded().unwrap();
        // The bound applies to the request as given, before duplicates collapse.
        let repeated = vec!["x".to_string(); MAX_INSPECTED_PORTS + 1];
        assert!(inspect_targets(&catalog, &repeated, &[]).is_err());
        let ids: Vec<String> = (0..=MAX_INSPECTED_PORTS)
            .map(|i| format!("port-{i}"))
            .collect();
        assert!(inspect_targets(&catalog, &ids, &[]).is_err());
    }
}
