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
    /// Recorded qualification matched to the artifact the catalog offers here.
    pub qualification: TargetQualification,
    /// The upstream listing download a fresh library refuses on this target
    /// because managed Install is offered here. A library's own registrations,
    /// pending setup or definition hold can still keep the download.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listing_download_refusal: Option<crate::CatalogDownloadRefusal>,
}

/// Recorded Portcove qualification for one target, matched to the artifact the
/// catalog offers there. Evidence never carries over to another artifact,
/// source variant, platform or check version; check versions are reported,
/// not ranked.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TargetQualification {
    pub state: TargetQualificationState,
    /// Upstream refs whose applicable lifecycle or hands-on evidence passed.
    pub qualified_refs: Vec<String>,
    /// Recorded scopes do not name the route or operation that produced them:
    /// the check version is the only operation discriminator, so a qualified
    /// state never says the offered route itself was exercised.
    pub evidence_route: EvidenceRoute,
    /// A known failure is recorded for a scope that applies to what is offered.
    pub known_failure: bool,
    pub offered_artifact: OfferedArtifact,
    pub scopes: Vec<TargetQualificationScope>,
    /// Port-wide historical coverage; never bound to an artifact or source.
    pub legacy_coverage: Vec<LegacyCoverage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRoute {
    Unrecorded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TargetQualificationState {
    /// Passed lifecycle or hands-on evidence for the exact artifact the catalog offers.
    OfferedArtifactQualified,
    /// Passed lifecycle or hands-on evidence for a reviewed release binding; it
    /// applies only when the provider resolves exactly that release, which this
    /// report never does.
    ReviewedBindingQualified,
    /// Only structural checks passed for what is offered: not a lifecycle claim.
    StructuralOnly,
    /// Evidence applies to what is offered, but none of it passed (for example
    /// only a known failure, or results not run).
    ApplicableNotPassed,
    /// Evidence exists, but none of it applies to what is offered.
    HistoricalOnly,
    Unqualified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum OfferedArtifact {
    /// The catalog pins the artifact this route acquires or registers.
    Fixed {
        route: PortAction,
        upstream_ref: String,
        artifact_sha256: String,
    },
    /// The release is known only after provider resolution.
    ProviderResolved {
        route: PortAction,
    },
    /// The player selects the runtime; the catalog names no artifact.
    UserSelected {
        route: PortAction,
    },
    NoneOffered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScopeApplicability {
    OfferedArtifact,
    OtherArtifact,
    ReviewedReleaseBinding,
    UnboundRelease,
    NoCatalogArtifact,
    RouteNotOffered,
    SourceScopeWithdrawn,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TargetQualificationScope {
    pub applicability: ScopeApplicability,
    pub contract_id: String,
    pub variant: Option<crate::SourceIdentity>,
    pub upstream_ref: String,
    pub artifact_sha256: String,
    pub check_version: String,
    pub assessment: crate::SourceQualificationAssessment,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LegacyCoverage {
    AutomatedTested,
    ManuallyValidated,
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
        format_version: 2,
        producer: CoreProducer::current(),
        scope: "catalog route offering and recorded qualification matched to the catalog-offered artifact per target for a fresh library; providers are not resolved, and definition trust, installed state and readiness are not assessed",
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
        .map(|&platform| {
            let routes: Vec<TargetRoute> = [PortAction::Install, PortAction::RegisterExternal]
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
                .collect();
            let qualification = target_qualification(catalog, port, platform, &routes);
            let listing_download_refusal = routes
                .iter()
                .any(|route| route.action == PortAction::Install && route.offered)
                .then_some(crate::CatalogDownloadRefusal::ManagedRoute);
            TargetRoutes {
                platform,
                routes,
                provider_resolution_required:
                    crate::managed_runtime_policy::requires_provider_resolution_on(port, platform),
                definition_eligibility: Unassessed::Unknown,
                readiness: Unassessed::Unknown,
                qualification,
                listing_download_refusal,
            }
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

/// The artifact the catalog offers on this target, from the first offered route.
fn offered_artifact(
    port: &crate::PortDefinition,
    platform: Platform,
    routes: &[TargetRoute],
) -> OfferedArtifact {
    let offered = |action| {
        routes
            .iter()
            .any(|route| route.action == action && route.offered)
    };
    if offered(PortAction::Install) {
        return match port.release.provider {
            crate::ReleaseSource::DirectManifest => {
                match crate::providers::resolve_direct(
                    port,
                    crate::ReleaseChannel::Stable,
                    platform,
                ) {
                    Ok(release) => OfferedArtifact::Fixed {
                        route: PortAction::Install,
                        upstream_ref: release.version,
                        artifact_sha256: release.asset.sha256,
                    },
                    Err(_) => OfferedArtifact::NoneOffered,
                }
            }
            crate::ReleaseSource::Github | crate::ReleaseSource::Gitlab => {
                OfferedArtifact::ProviderResolved {
                    route: PortAction::Install,
                }
            }
            crate::ReleaseSource::UserPrepared => OfferedArtifact::NoneOffered,
        };
    }
    if offered(PortAction::RegisterExternal)
        && let Some(runtime) = port.release.user_prepared.get(&platform)
    {
        return if runtime.trust.is_accepted_package() {
            OfferedArtifact::Fixed {
                route: PortAction::RegisterExternal,
                upstream_ref: runtime.version.clone(),
                artifact_sha256: runtime.archive_sha256.to_ascii_lowercase(),
            }
        } else {
            OfferedArtifact::UserSelected {
                route: PortAction::RegisterExternal,
            }
        };
    }
    OfferedArtifact::NoneOffered
}

// Structural, lifecycle and hands-on results stay separate: only lifecycle or
// hands-on evidence qualifies; a structural check alone is reported as such.
fn passed_evidence(scope: &TargetQualificationScope) -> bool {
    [
        scope.assessment.automated_lifecycle,
        scope.assessment.hands_on,
    ]
    .contains(&crate::QualificationEvidenceState::Passed)
}

fn applicable_scope(scope: &TargetQualificationScope) -> bool {
    matches!(
        scope.applicability,
        ScopeApplicability::OfferedArtifact | ScopeApplicability::ReviewedReleaseBinding
    )
}

/// The target state from its scopes: the strongest applicable claim first.
fn qualification_state(scopes: &[TargetQualificationScope]) -> TargetQualificationState {
    let applicable_passed = |applicability| {
        scopes
            .iter()
            .any(|scope| scope.applicability == applicability && passed_evidence(scope))
    };
    if applicable_passed(ScopeApplicability::OfferedArtifact) {
        TargetQualificationState::OfferedArtifactQualified
    } else if applicable_passed(ScopeApplicability::ReviewedReleaseBinding) {
        TargetQualificationState::ReviewedBindingQualified
    } else if scopes.iter().any(|scope| {
        applicable_scope(scope)
            && scope.assessment.structural_check == crate::QualificationEvidenceState::Passed
    }) {
        TargetQualificationState::StructuralOnly
    } else if scopes.iter().any(applicable_scope) {
        TargetQualificationState::ApplicableNotPassed
    } else if scopes.is_empty() {
        TargetQualificationState::Unqualified
    } else {
        TargetQualificationState::HistoricalOnly
    }
}

/// Matches each recorded qualification scope of this port and platform to the
/// offered artifact, using Core's exact-scope rule and reviewed release bindings.
fn target_qualification(
    catalog: &Catalog,
    port: &crate::PortDefinition,
    platform: Platform,
    routes: &[TargetRoute],
) -> TargetQualification {
    use crate::{QualificationEvidenceState as Evidence, SourceVariantScope};
    let offered_artifact = offered_artifact(port, platform, routes);
    let mut scopes: Vec<TargetQualificationScope> = Vec::new();
    if let Some(source) = catalog.source_catalog() {
        let mut distinct: Vec<&crate::SourceEvidenceScope> = Vec::new();
        for record in source
            .qualification
            .iter()
            .filter(|record| record.scope.port_id == port.id && record.scope.platform == platform)
        {
            if !distinct.contains(&&record.scope) {
                distinct.push(&record.scope);
            }
        }
        for scope in distinct {
            let records: Vec<_> = source
                .qualification
                .iter()
                .filter(|record| record.scope == *scope)
                .collect();
            let variant = match &scope.variant {
                SourceVariantScope::Exact { identity } => Some(identity.clone()),
                SourceVariantScope::Unspecified => None,
            };
            let contract = scope.contract_id.as_deref().and_then(|id| {
                source
                    .contracts
                    .iter()
                    .find(|contract| contract.id == id && contract.port_id == port.id)
            });
            let current = contract
                .and_then(|contract| source.current_source_identities(contract).ok())
                .zip(variant.as_ref())
                .is_some_and(|(identities, variant)| identities.contains(variant));
            let upstream_ref = scope.upstream_ref.clone().unwrap_or_default();
            let artifact_sha256 = scope
                .artifact_sha256
                .clone()
                .unwrap_or_default()
                .to_ascii_lowercase();
            let applicability = match (&offered_artifact, contract) {
                (_, Some(_)) if !current => ScopeApplicability::SourceScopeWithdrawn,
                (_, None) => ScopeApplicability::SourceScopeWithdrawn,
                (OfferedArtifact::NoneOffered, _) => ScopeApplicability::RouteNotOffered,
                (
                    OfferedArtifact::Fixed {
                        upstream_ref: offered_ref,
                        artifact_sha256: offered_sha256,
                        ..
                    },
                    _,
                ) => {
                    // Digests compare without case; the record keeps its own spelling.
                    let same_artifact = scope
                        .artifact_sha256
                        .as_deref()
                        .is_some_and(|sha256| sha256.eq_ignore_ascii_case(offered_sha256));
                    let candidate = crate::SourceEvidenceScope {
                        upstream_ref: Some(offered_ref.clone()),
                        ..scope.clone()
                    };
                    if same_artifact && records.iter().any(|record| record.applies_to(&candidate)) {
                        ScopeApplicability::OfferedArtifact
                    } else {
                        ScopeApplicability::OtherArtifact
                    }
                }
                (OfferedArtifact::UserSelected { .. }, _) => ScopeApplicability::NoCatalogArtifact,
                (OfferedArtifact::ProviderResolved { .. }, Some(contract)) => {
                    if contract.reviewed_binding_covers(&upstream_ref, &artifact_sha256) {
                        ScopeApplicability::ReviewedReleaseBinding
                    } else {
                        ScopeApplicability::UnboundRelease
                    }
                }
            };
            let mut evidence_ids: Vec<String> = records
                .iter()
                .flat_map(|record| record.evidence_ids.iter().cloned())
                .collect();
            evidence_ids.sort();
            evidence_ids.dedup();
            scopes.push(TargetQualificationScope {
                applicability,
                contract_id: scope.contract_id.clone().unwrap_or_default(),
                variant,
                upstream_ref,
                artifact_sha256,
                check_version: scope.check_version.clone().unwrap_or_default(),
                assessment: source.assess_qualification(scope),
                evidence_ids,
            });
        }
    }
    let key = |scope: &TargetQualificationScope| {
        (
            scope.contract_id.clone(),
            scope.variant.as_ref().map(|variant| {
                (
                    variant.game_id.clone(),
                    variant.variant_id.clone(),
                    variant.representation_id.clone(),
                )
            }),
            scope.upstream_ref.clone(),
            scope.artifact_sha256.clone(),
            scope.check_version.clone(),
        )
    };
    scopes.sort_by_key(key);
    let state = qualification_state(&scopes);
    let passed = |scope: &&TargetQualificationScope| passed_evidence(scope);
    let applicable = |scope: &&TargetQualificationScope| applicable_scope(scope);
    let mut qualified_refs: Vec<String> = scopes
        .iter()
        .filter(applicable)
        .filter(|scope| passed(scope))
        .map(|scope| scope.upstream_ref.clone())
        .collect();
    qualified_refs.sort();
    qualified_refs.dedup();
    let known_failure = scopes
        .iter()
        .filter(applicable)
        .any(|scope| scope.assessment.known_failure == Evidence::Failed);
    let mut legacy_coverage = Vec::new();
    if port.automated_tested_platforms.contains(&platform) {
        legacy_coverage.push(LegacyCoverage::AutomatedTested);
    }
    if port.manually_validated_platforms.contains(&platform) {
        legacy_coverage.push(LegacyCoverage::ManuallyValidated);
    }
    TargetQualification {
        state,
        qualified_refs,
        evidence_route: EvidenceRoute::Unrecorded,
        known_failure,
        offered_artifact,
        scopes,
        legacy_coverage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows_qualification(report: &TargetInspection, port: &str) -> TargetQualification {
        report
            .ports
            .iter()
            .find(|entry| entry.port_id == port)
            .unwrap()
            .targets
            .iter()
            .find(|target| target.platform == Platform::WindowsX86_64)
            .unwrap()
            .qualification
            .clone()
    }

    #[test]
    fn provider_ports_qualify_only_through_their_reviewed_release_bindings() {
        let catalog = Catalog::embedded().unwrap();
        let report = inspect_targets(
            &catalog,
            &["f-zero-snes-recomp".into(), "dkc3-recomp".into()],
            &[Platform::WindowsX86_64, Platform::LinuxX86_64],
        )
        .unwrap();
        assert_eq!(report.format_version, 2);
        let fzero = windows_qualification(&report, "f-zero-snes-recomp");
        assert_eq!(
            fzero.offered_artifact,
            OfferedArtifact::ProviderResolved {
                route: PortAction::Install
            }
        );
        assert_eq!(
            fzero.state,
            TargetQualificationState::ReviewedBindingQualified
        );
        assert_eq!(fzero.qualified_refs, ["v1.8.3"]);
        // The evidence never says which route produced it.
        assert_eq!(fzero.evidence_route, EvidenceRoute::Unrecorded);
        assert!(!fzero.known_failure);
        // Each check version is its own claim, reported side by side.
        assert_eq!(
            fzero
                .scopes
                .iter()
                .map(|scope| (scope.applicability, scope.check_version.as_str()))
                .collect::<Vec<_>>(),
            [
                (
                    ScopeApplicability::ReviewedReleaseBinding,
                    "fzero-managed-path-policy-startup-persistence-v2"
                ),
                (
                    ScopeApplicability::ReviewedReleaseBinding,
                    "fzero-managed-startup-persistence-v1"
                ),
            ]
        );
        let dkc3 = windows_qualification(&report, "dkc3-recomp");
        assert_eq!(
            dkc3.state,
            TargetQualificationState::ReviewedBindingQualified
        );
        assert!(dkc3.known_failure);
        // Another platform never inherits Windows evidence.
        let linux = &report.ports[0]
            .targets
            .iter()
            .find(|target| target.platform == Platform::LinuxX86_64)
            .unwrap()
            .qualification;
        assert!(linux.scopes.is_empty());
        assert_eq!(linux.state, TargetQualificationState::Unqualified);
    }

    #[test]
    fn a_pinned_artifact_qualifies_only_with_evidence_for_that_exact_artifact() {
        let catalog = Catalog::embedded().unwrap();
        let source = catalog.source_catalog().unwrap();
        let record = source
            .qualification
            .iter()
            .find(|record| record.scope.port_id == "f-zero-snes-recomp")
            .unwrap();
        let mut port = catalog.port("f-zero-snes-recomp").unwrap().clone();
        port.release.provider = crate::ReleaseSource::DirectManifest;
        port.channels = vec![crate::ReleaseChannel::Stable];
        let pin = |sha256: &str| crate::DirectReleaseSpec {
            version: record.scope.upstream_ref.clone().unwrap(),
            url: "https://example.invalid/f-zero.zip".into(),
            size: 1,
            sha256: sha256.to_ascii_uppercase(),
            published_at: None,
        };
        let install = [TargetRoute {
            action: PortAction::Install,
            offered: true,
            reason: None,
        }];
        port.release.direct.insert(
            Platform::WindowsX86_64,
            pin(record.scope.artifact_sha256.as_deref().unwrap()),
        );
        let exact = target_qualification(&catalog, &port, Platform::WindowsX86_64, &install);
        assert_eq!(
            exact.state,
            TargetQualificationState::OfferedArtifactQualified
        );
        assert!(
            exact
                .scopes
                .iter()
                .all(|scope| scope.applicability == ScopeApplicability::OfferedArtifact)
        );
        // A different pinned artifact keeps the evidence visible but never qualified.
        port.release
            .direct
            .insert(Platform::WindowsX86_64, pin(&"0".repeat(64)));
        let other = target_qualification(&catalog, &port, Platform::WindowsX86_64, &install);
        assert_eq!(other.state, TargetQualificationState::HistoricalOnly);
        assert!(other.qualified_refs.is_empty());
        // A known failure on another artifact is not this target's failure.
        assert!(!other.known_failure);
        assert!(
            other
                .scopes
                .iter()
                .all(|scope| scope.applicability == ScopeApplicability::OtherArtifact)
        );
        // No offered route: the evidence applies to nothing offered.
        let withdrawn = [TargetRoute {
            action: PortAction::Install,
            offered: false,
            reason: Some(PortActionReason::RouteNotOffered),
        }];
        let none = target_qualification(&catalog, &port, Platform::WindowsX86_64, &withdrawn);
        assert_eq!(none.offered_artifact, OfferedArtifact::NoneOffered);
        assert_eq!(none.state, TargetQualificationState::HistoricalOnly);
        // A release policy admits sources for any release, but qualifies none.
        let contract = source
            .contracts
            .iter()
            .find(|contract| Some(&contract.id) == record.scope.contract_id.as_ref())
            .unwrap();
        assert!(!contract.reviewed_binding_covers("unreviewed", &"0".repeat(64)));
    }

    #[test]
    fn the_state_names_the_strongest_applicable_claim_and_never_overstates() {
        use crate::QualificationEvidenceState as Evidence;
        let scope =
            |applicability, lifecycle, structural, known_failure| TargetQualificationScope {
                applicability,
                contract_id: "c".into(),
                variant: None,
                upstream_ref: "v1".into(),
                artifact_sha256: "a".repeat(64),
                check_version: "check".into(),
                assessment: crate::SourceQualificationAssessment {
                    structural_check: structural,
                    automated_lifecycle: lifecycle,
                    hands_on: Evidence::Missing,
                    known_failure,
                },
                evidence_ids: Vec::new(),
            };
        use ScopeApplicability::*;
        use TargetQualificationState as State;
        let cases = [
            (vec![], State::Unqualified),
            (
                vec![scope(
                    OtherArtifact,
                    Evidence::Passed,
                    Evidence::Passed,
                    Evidence::Missing,
                )],
                State::HistoricalOnly,
            ),
            (
                vec![scope(
                    OfferedArtifact,
                    Evidence::Missing,
                    Evidence::Passed,
                    Evidence::Missing,
                )],
                State::StructuralOnly,
            ),
            // Applicable evidence that never passed is not "historical".
            (
                vec![scope(
                    ReviewedReleaseBinding,
                    Evidence::Missing,
                    Evidence::Missing,
                    Evidence::Failed,
                )],
                State::ApplicableNotPassed,
            ),
            (
                vec![
                    scope(
                        ReviewedReleaseBinding,
                        Evidence::Passed,
                        Evidence::Missing,
                        Evidence::Missing,
                    ),
                    scope(
                        OfferedArtifact,
                        Evidence::Passed,
                        Evidence::Missing,
                        Evidence::Missing,
                    ),
                ],
                State::OfferedArtifactQualified,
            ),
        ];
        for (scopes, expected) in cases {
            assert_eq!(qualification_state(&scopes), expected, "{scopes:?}");
        }
    }

    #[test]
    fn every_qualification_record_appears_once_and_the_report_is_deterministic() {
        let catalog = Catalog::embedded().unwrap();
        let first = inspect_targets(&catalog, &[], &[]).unwrap();
        let second = inspect_targets(&catalog, &[], &[]).unwrap();
        let first_json = serde_json::to_string(&first).unwrap();
        assert_eq!(first_json, serde_json::to_string(&second).unwrap());
        assert!(!first_json.contains("observed_at"));
        let source = catalog.source_catalog().unwrap();
        for record in &source.qualification {
            let matches = first
                .ports
                .iter()
                .filter(|port| port.port_id == record.scope.port_id)
                .flat_map(|port| port.targets.iter())
                .filter(|target| target.platform == record.scope.platform)
                .flat_map(|target| target.qualification.scopes.iter())
                .filter(|scope| {
                    Some(&scope.contract_id) == record.scope.contract_id.as_ref()
                        && Some(&scope.check_version) == record.scope.check_version.as_ref()
                        && Some(&scope.upstream_ref) == record.scope.upstream_ref.as_ref()
                })
                .count();
            assert!(matches >= 1, "{record:?} is reported");
        }
    }

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

    #[test]
    fn each_target_reports_the_listing_download_a_managed_install_replaces() {
        let catalog = Catalog::embedded().unwrap();
        let report = inspect_targets(
            &catalog,
            &[
                "wave-race-64-recomp".into(),
                "dkc2-recomp".into(),
                "open-nectar-pikmin".into(),
            ],
            &[Platform::WindowsX86_64, Platform::LinuxX86_64],
        )
        .unwrap();
        let refusal = |port: &str, platform| {
            report
                .ports
                .iter()
                .find(|entry| entry.port_id == port)
                .unwrap()
                .targets
                .iter()
                .find(|target| target.platform == platform)
                .unwrap()
                .listing_download_refusal
        };
        let managed = Some(crate::CatalogDownloadRefusal::ManagedRoute);
        assert_eq!(
            refusal("wave-race-64-recomp", Platform::WindowsX86_64),
            managed
        );
        assert_eq!(refusal("wave-race-64-recomp", Platform::LinuxX86_64), None);
        // Prepared-player routes and held acquisition offer no Install to replace it.
        assert_eq!(refusal("dkc2-recomp", Platform::WindowsX86_64), None);
        assert_eq!(refusal("open-nectar-pikmin", Platform::WindowsX86_64), None);
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(
            json["ports"][0]["targets"][0]["listing_download_refusal"],
            "managed-route"
        );
        assert!(
            json["ports"][0]["targets"][1]
                .get("listing_download_refusal")
                .is_none()
        );
    }
}
