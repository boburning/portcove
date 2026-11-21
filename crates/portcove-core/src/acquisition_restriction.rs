//! One typed contract for restrictions on getting or managing a port.
//!
//! A restriction names the operations and the platform, release, artifact,
//! input or component it is about. Both carriers, the descriptive listing and
//! the managed definition, are evaluated here; every Core hold check delegates
//! to [`evaluate`]. Reason codes, reconsideration conditions and tracking issues
//! are descriptive only and never change a decision.
use crate::{Platform, PortcoveError, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The first listing format that carries typed restrictions.
pub(crate) const RESTRICTION_LISTING_FORMAT: u32 = 15;
const MAX_RESTRICTIONS: usize = 64;
const MAX_SCOPE_VALUES: usize = 64;

/// Core's explanation when a hold names an identity this operation can never
/// prove, such as the release package of an extracted folder.
pub(crate) const UNVERIFIABLE_IDENTITY: &str = "Install through Portcove to verify the release archive. An extracted folder cannot prove which release package it came from.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionRestriction {
    /// Stable within its carrier; the key for review and transition checks.
    pub id: String,
    pub effect: RestrictionEffect,
    pub operations: BTreeSet<RestrictedOperation>,
    #[serde(default, skip_serializing_if = "RestrictionScope::is_whole")]
    pub scope: RestrictionScope,
    /// Descriptive; required for a hold and refused for a permit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<RestrictionReason>,
    /// Player-facing explanation; required for a hold and refused for a permit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reconsider_when: Vec<ReconsiderCondition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracking_issue: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RestrictionEffect {
    Hold,
    Permit,
}

/// Removal, rollback and backup are deliberately absent: a restriction never
/// blocks removing or recovering the player's own state.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum RestrictedOperation {
    Download,
    Install,
    Update,
    Adopt,
    Activate,
    Prepare,
    RegisterExternal,
    Launch,
}

impl RestrictedOperation {
    pub const ALL: [Self; 8] = [
        Self::Download,
        Self::Install,
        Self::Update,
        Self::Adopt,
        Self::Activate,
        Self::Prepare,
        Self::RegisterExternal,
        Self::Launch,
    ];

    pub(crate) const fn from_port_action(action: crate::PortAction) -> Option<Self> {
        use crate::PortAction as A;
        match action {
            A::Install => Some(Self::Install),
            A::Update => Some(Self::Update),
            A::RegisterExternal => Some(Self::RegisterExternal),
            A::Launch => Some(Self::Launch),
            A::RemoveManaged
            | A::RemoveExternal
            | A::Rollback
            | A::BackupCreate
            | A::BackupRestore => None,
        }
    }

    // Total vocabulary maps; tested now, consumed when a carrier names these operations.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) const fn from_definition_operation(
        operation: crate::DefinitionOperation,
    ) -> Option<Self> {
        use crate::DefinitionOperation as D;
        match operation {
            D::Availability => None,
            D::Install => Some(Self::Install),
            D::RegisterExternal => Some(Self::RegisterExternal),
            D::Prepare => Some(Self::Prepare),
            D::Launch => Some(Self::Launch),
            D::Update => Some(Self::Update),
        }
    }

    // Total vocabulary maps; tested now, consumed when a carrier names these operations.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) const fn curated_operation(
        self,
    ) -> Option<crate::definition_repository::publisher_policy::CuratedArtifactOperation> {
        use crate::definition_repository::publisher_policy::CuratedArtifactOperation as C;
        match self {
            Self::Download | Self::Install | Self::Update => Some(C::Acquisition),
            Self::Activate | Self::Launch => Some(C::LocalUse),
            Self::Adopt | Self::Prepare | Self::RegisterExternal => None,
        }
    }

    /// The listing carries only download decisions until older readers have a
    /// gate: its legacy projection can express a download hold and nothing
    /// else, so a register or launch hold would vanish for them.
    const fn listing_carrier(self) -> bool {
        matches!(self, Self::Download)
    }

    const fn managed_carrier(self) -> bool {
        matches!(
            self,
            Self::Download
                | Self::Install
                | Self::Update
                | Self::Adopt
                | Self::Activate
                | Self::Prepare
        )
    }
}

/// Each empty list leaves that dimension unconstrained.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RestrictionScope {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<Platform>,
    /// Exact release versions or tags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub releases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<RestrictedArtifact>,
    /// Source catalog identity or profile ids.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<RestrictedComponent>,
}

impl RestrictionScope {
    pub fn is_whole(&self) -> bool {
        self == &Self::default()
    }

    /// Artifacts > releases > inputs = components > platforms > whole.
    fn specificity(&self) -> u8 {
        if !self.artifacts.is_empty() {
            5
        } else if !self.releases.is_empty() {
            4
        } else if !self.inputs.is_empty() || !self.components.is_empty() {
            3
        } else if !self.platforms.is_empty() {
            2
        } else {
            1
        }
    }

    /// Whether some dimension both scopes constrain has no value in common, so
    /// no subject can match both.
    fn disjoint_from(&self, other: &Self) -> bool {
        fn disjoint<T: PartialEq>(left: &[T], right: &[T]) -> bool {
            !left.is_empty() && !right.is_empty() && left.iter().all(|v| !right.contains(v))
        }
        disjoint(&self.platforms, &other.platforms)
            || disjoint(&self.releases, &other.releases)
            || disjoint(&self.artifacts, &other.artifacts)
            || disjoint(&self.inputs, &other.inputs)
            || disjoint(&self.components, &other.components)
    }

    /// Whether every subject this scope covers is also covered by `self`.
    fn covers(&self, other: &Self) -> bool {
        fn dimension<T: PartialEq>(broad: &[T], narrow: &[T]) -> bool {
            broad.is_empty() || (!narrow.is_empty() && narrow.iter().all(|v| broad.contains(v)))
        }
        dimension(&self.platforms, &other.platforms)
            && dimension(&self.releases, &other.releases)
            && dimension(&self.artifacts, &other.artifacts)
            && dimension(&self.inputs, &other.inputs)
            && dimension(&self.components, &other.components)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RestrictedArtifact {
    pub version: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RestrictedComponent {
    BundledRuntime { platform: Platform },
    ToolArtifact { id: String },
}

/// Descriptive classification of why a hold exists. Never evaluated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RestrictionReason {
    BundledGameData,
    UpstreamOwnedRoute,
    PackageFactsUnresolved,
    LegacyRightsReview,
    NoUsefulRoute,
    UpstreamProhibition,
    SafetyEvidenceMismatch,
    ThirdPartyComponentTerms,
    KnownDefectiveArtifact,
    UpstreamTransitionUnreviewed,
    /// Reader-only normalization of an untyped legacy restriction.
    LegacyUnclassified,
}

/// Descriptive condition for reconsidering a decision. Never evaluated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ReconsiderCondition {
    AttributableGrant,
    CleanUpstreamPackage,
    OwnedInputPreparation,
    PublisherChecksum,
    ReviewedSuccessorRelease,
    UpstreamRouteChange,
    OwnerReview,
}

/// What Core knows about one dimension of the subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Knowledge<T> {
    Known(T),
    /// Resolved and rechecked before any byte is used.
    Deferred,
    /// Can never be proven, as for an adopted folder.
    Unverifiable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SubjectArtifact<'a> {
    pub version: &'a str,
    pub sha256: &'a str,
    pub asset_name: Option<&'a str>,
}

/// When a decision is made. An offer may defer an identity that Core resolves
/// and checks again; a final check is the last gate before bytes are used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    Offer,
    Final,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RestrictionSubject<'a> {
    pub operation: RestrictedOperation,
    pub phase: Phase,
    pub platform: Knowledge<Platform>,
    pub release: Knowledge<&'a str>,
    pub artifact: Knowledge<SubjectArtifact<'a>>,
    pub input: Knowledge<&'a str>,
    pub component: Knowledge<&'a RestrictedComponent>,
}

impl<'a> RestrictionSubject<'a> {
    /// Every identity is resolved later, as for a status or offer view.
    pub(crate) const fn deferred(operation: RestrictedOperation) -> Self {
        Self {
            operation,
            phase: Phase::Offer,
            platform: Knowledge::Deferred,
            release: Knowledge::Deferred,
            artifact: Knowledge::Deferred,
            input: Knowledge::Deferred,
            component: Knowledge::Deferred,
        }
    }

    /// The last gate before bytes are used: nothing is deferred any more, so a
    /// hold matches an unresolved dimension and a permit does not.
    pub(crate) const fn final_check(mut self) -> Self {
        self.phase = Phase::Final;
        self
    }

    pub(crate) const fn on(mut self, platform: Platform) -> Self {
        self.platform = Knowledge::Known(platform);
        self
    }

    /// The current host, when Core runs on a supported one.
    pub(crate) fn on_current_host(self) -> Self {
        match Platform::current() {
            Ok(platform) => self.on(platform),
            Err(_) => self,
        }
    }

    /// An exact artifact also fixes its release.
    pub(crate) const fn artifact(mut self, artifact: SubjectArtifact<'a>) -> Self {
        self.release = Knowledge::Known(artifact.version);
        self.artifact = Knowledge::Known(artifact);
        self
    }

    pub(crate) const fn unverifiable_artifact(mut self) -> Self {
        self.release = Knowledge::Unverifiable;
        self.artifact = Knowledge::Unverifiable;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RestrictionCarrier {
    Managed,
    Listing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestrictionState {
    Clear,
    Held,
    Permitted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestrictionOutcome {
    pub state: RestrictionState,
    pub decision: Option<(AcquisitionRestriction, RestrictionCarrier)>,
    /// The hold matched only because a constrained identity cannot be proven.
    pub unverifiable: bool,
}

impl RestrictionOutcome {
    const CLEAR: Self = Self {
        state: RestrictionState::Clear,
        decision: None,
        unverifiable: false,
    };

    pub(crate) fn is_held(&self) -> bool {
        self.state == RestrictionState::Held
    }

    /// The held decision's player explanation, or Core's own when the
    /// restricted identity cannot be proven.
    pub(crate) fn explanation(&self) -> Option<String> {
        if !self.is_held() {
            return None;
        }
        if self.unverifiable {
            return Some(UNVERIFIABLE_IDENTITY.into());
        }
        Some(
            self.decision
                .as_ref()
                .and_then(|(decision, _)| decision.explanation.clone())
                .unwrap_or_else(|| "This operation is held for review.".into()),
        )
    }

    pub(crate) fn reason(&self) -> Option<RestrictionReason> {
        self.is_held()
            .then(|| self.decision.as_ref().and_then(|(d, _)| d.reason))
            .flatten()
    }

    /// The deciding restriction scope names exact artifacts.
    pub(crate) fn artifact_scoped(&self) -> bool {
        self.decision
            .as_ref()
            .is_some_and(|(decision, _)| !decision.scope.artifacts.is_empty())
    }

    /// The deciding restriction scope names exact releases.
    pub(crate) fn release_scoped(&self) -> bool {
        self.decision
            .as_ref()
            .is_some_and(|(decision, _)| !decision.scope.releases.is_empty())
    }

    pub(crate) fn into_result(self) -> Result<()> {
        match self.explanation() {
            Some(explanation) => Err(PortcoveError::unsupported(explanation)),
            None => Ok(()),
        }
    }
}

/// Normalized restrictions from both carriers of one port.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct EffectiveRestrictions {
    managed: Vec<AcquisitionRestriction>,
    listing: Vec<AcquisitionRestriction>,
}

pub(crate) fn effective(catalog: &crate::Catalog, port_id: &str) -> EffectiveRestrictions {
    EffectiveRestrictions {
        managed: catalog
            .port(port_id)
            .ok()
            .map(definition_restrictions)
            .unwrap_or_default(),
        listing: catalog
            .listing(port_id)
            .ok()
            .map(crate::PortListing::effective_restrictions)
            .unwrap_or_default(),
    }
}

/// The managed carrier of one definition, which may be a retained one.
pub(crate) fn definition_restrictions(port: &crate::PortDefinition) -> Vec<AcquisitionRestriction> {
    port.managed_acquisition_hold
        .as_ref()
        .map(crate::ManagedAcquisitionHold::to_restrictions)
        .unwrap_or_default()
}

pub(crate) fn evaluate(
    catalog: &crate::Catalog,
    port_id: &str,
    subject: &RestrictionSubject<'_>,
) -> RestrictionOutcome {
    effective(catalog, port_id).evaluate(subject)
}

impl EffectiveRestrictions {
    pub(crate) fn of(catalog: &crate::Catalog, port_id: &str) -> Self {
        effective(catalog, port_id)
    }

    pub(crate) fn managed_only(port: &crate::PortDefinition) -> Self {
        Self {
            managed: definition_restrictions(port),
            listing: Vec::new(),
        }
    }

    pub(crate) fn listing_only(listing: &crate::PortListing) -> Self {
        Self {
            managed: Vec::new(),
            listing: listing.effective_restrictions(),
        }
    }

    /// Any hold from either carrier wins; a permit cancels only holds from its
    /// own carrier. Trust, integrity, eligibility and revocation checks run
    /// independently and stay terminal.
    pub(crate) fn evaluate(&self, subject: &RestrictionSubject<'_>) -> RestrictionOutcome {
        let mut permitted = None;
        for (carrier, restrictions) in [
            (RestrictionCarrier::Managed, &self.managed),
            (RestrictionCarrier::Listing, &self.listing),
        ] {
            let outcome = evaluate_carrier(restrictions, subject, carrier);
            match outcome.state {
                RestrictionState::Held => return outcome,
                RestrictionState::Permitted if permitted.is_none() => permitted = Some(outcome),
                _ => {}
            }
        }
        permitted.unwrap_or(RestrictionOutcome::CLEAR)
    }

    pub(crate) fn require(&self, subject: &RestrictionSubject<'_>) -> Result<()> {
        self.evaluate(subject).into_result()
    }

    /// The explanation for a held port action on the current host.
    pub(crate) fn action_hold(&self, action: crate::PortAction) -> Option<RestrictionOutcome> {
        let operation = RestrictedOperation::from_port_action(action)?;
        let outcome = self.evaluate(&RestrictionSubject::deferred(operation).on_current_host());
        outcome.is_held().then_some(outcome)
    }

    /// Exact artifacts a permit names for this operation and platform.
    pub(crate) fn permitted_artifacts(
        &self,
        operation: RestrictedOperation,
        platform: Knowledge<Platform>,
    ) -> impl Iterator<Item = &RestrictedArtifact> {
        self.managed
            .iter()
            .chain(&self.listing)
            .filter(move |restriction| {
                restriction.effect == RestrictionEffect::Permit
                    && restriction.operations.contains(&operation)
                    && match platform {
                        Knowledge::Known(platform) => {
                            restriction.scope.platforms.is_empty()
                                || restriction.scope.platforms.contains(&platform)
                        }
                        _ => restriction.scope.platforms.is_empty(),
                    }
            })
            .flat_map(|restriction| &restriction.scope.artifacts)
    }

    /// Whether some permit for this operation names exact releases or artifacts.
    pub(crate) fn has_scoped_permit(&self, operation: RestrictedOperation) -> bool {
        self.managed.iter().chain(&self.listing).any(|restriction| {
            restriction.effect == RestrictionEffect::Permit
                && restriction.operations.contains(&operation)
                && (!restriction.scope.artifacts.is_empty()
                    || !restriction.scope.releases.is_empty())
        })
    }

    /// Whether any hold for this operation is limited to exact artifacts.
    pub(crate) fn has_artifact_holds(&self, operation: RestrictedOperation) -> bool {
        self.managed.iter().chain(&self.listing).any(|restriction| {
            restriction.effect == RestrictionEffect::Hold
                && restriction.operations.contains(&operation)
                && !restriction.scope.artifacts.is_empty()
        })
    }

    fn final_artifact(
        &self,
        operation: RestrictedOperation,
        version: &str,
        sha256: &str,
    ) -> RestrictionOutcome {
        self.evaluate(
            &RestrictionSubject::deferred(operation)
                .artifact(SubjectArtifact {
                    version,
                    sha256,
                    asset_name: None,
                })
                .final_check(),
        )
    }

    /// Any hold on this exact known artifact at its final check.
    pub(crate) fn artifact_hold(
        &self,
        operation: RestrictedOperation,
        version: &str,
        sha256: &str,
    ) -> Option<RestrictionOutcome> {
        let outcome = self.final_artifact(operation, version, sha256);
        outcome.is_held().then_some(outcome)
    }

    /// A hold that names this exact artifact, as opposed to a route-wide hold.
    /// Release selection uses it to step over an excluded package to a
    /// permitted one; route-wide holds stay with the acquisition gate.
    pub(crate) fn artifact_exclusion(
        &self,
        operation: RestrictedOperation,
        version: &str,
        sha256: &str,
    ) -> Option<RestrictionOutcome> {
        let outcome = self.final_artifact(operation, version, sha256);
        (outcome.is_held() && outcome.artifact_scoped()).then_some(outcome)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fit {
    No,
    Possible,
    Yes { unverifiable: bool },
}

impl Fit {
    fn and(self, other: Self) -> Self {
        match (self, other) {
            (Self::No, _) | (_, Self::No) => Self::No,
            (Self::Possible, _) | (_, Self::Possible) => Self::Possible,
            (Self::Yes { unverifiable: a }, Self::Yes { unverifiable: b }) => Self::Yes {
                unverifiable: a || b,
            },
        }
    }
}

fn dimension<V, T: Copy>(
    values: &[V],
    knowledge: Knowledge<T>,
    hold: bool,
    phase: Phase,
    contains: impl Fn(&V, T) -> bool,
) -> Fit {
    if values.is_empty() {
        return Fit::Yes {
            unverifiable: false,
        };
    }
    match knowledge {
        Knowledge::Known(value) if values.iter().any(|v| contains(v, value)) => Fit::Yes {
            unverifiable: false,
        },
        Knowledge::Known(_) => Fit::No,
        // Only an offer may defer; a final check treats an unresolved
        // identity like an unprovable one.
        Knowledge::Deferred if phase == Phase::Offer => Fit::Possible,
        Knowledge::Deferred if hold => Fit::Yes {
            unverifiable: false,
        },
        Knowledge::Deferred => Fit::No,
        // A hold fails closed; a permit matches only known values.
        Knowledge::Unverifiable if hold => Fit::Yes { unverifiable: true },
        Knowledge::Unverifiable => Fit::No,
    }
}

fn fit(restriction: &AcquisitionRestriction, subject: &RestrictionSubject<'_>) -> Fit {
    if !restriction.operations.contains(&subject.operation) {
        return Fit::No;
    }
    let hold = restriction.effect == RestrictionEffect::Hold;
    let phase = subject.phase;
    let scope = &restriction.scope;
    dimension(&scope.platforms, subject.platform, hold, phase, |v, p| {
        *v == p
    })
    .and(dimension(
        &scope.releases,
        subject.release,
        hold,
        phase,
        |v, r| v == r,
    ))
    .and(dimension(
        &scope.artifacts,
        subject.artifact,
        hold,
        phase,
        |v, a| {
            v.version == a.version
                && v.sha256.eq_ignore_ascii_case(a.sha256)
                && match (&v.asset_name, a.asset_name) {
                    (None, _) => true,
                    (Some(expected), Some(actual)) => expected == actual,
                    // An unnamed subject satisfies a named hold, never a named permit.
                    (Some(_), None) => hold,
                }
        },
    ))
    // No Core path resolves inputs or components yet, so even an offer
    // cannot defer them: a hold on them fails closed, a permit never matches.
    .and(dimension(
        &scope.inputs,
        subject.input,
        hold,
        Phase::Final,
        |v, i| v == i,
    ))
    .and(dimension(
        &scope.components,
        subject.component,
        hold,
        Phase::Final,
        |v, c| v == c,
    ))
}

fn evaluate_carrier(
    restrictions: &[AcquisitionRestriction],
    subject: &RestrictionSubject<'_>,
    carrier: RestrictionCarrier,
) -> RestrictionOutcome {
    // (specificity, is_hold, unverifiable, restriction)
    let mut best: Option<(u8, bool, bool, &AcquisitionRestriction)> = None;
    let mut possible_permit = 0;
    for restriction in restrictions {
        let rank = restriction.scope.specificity();
        let hold = restriction.effect == RestrictionEffect::Hold;
        match fit(restriction, subject) {
            Fit::No => {}
            Fit::Possible => {
                if !hold {
                    possible_permit = possible_permit.max(rank);
                }
            }
            Fit::Yes { unverifiable } => {
                let better = best.is_none_or(|(best_rank, best_hold, ..)| {
                    rank > best_rank || (rank == best_rank && hold && !best_hold)
                });
                if better {
                    best = Some((rank, hold, unverifiable, restriction));
                }
            }
        }
    }
    let Some((rank, hold, unverifiable, decision)) = best else {
        return RestrictionOutcome::CLEAR;
    };
    // A hold that a more specific permit may still cancel once the identity is
    // known does not withhold the offer; execution repeats with known values.
    if hold && possible_permit > rank {
        return RestrictionOutcome::CLEAR;
    }
    RestrictionOutcome {
        state: if hold {
            RestrictionState::Held
        } else {
            RestrictionState::Permitted
        },
        decision: Some((decision.clone(), carrier)),
        unverifiable: hold && unverifiable,
    }
}

/// Library status: each action a restriction holds is withdrawn exactly as a
/// route that is not offered, with its reason code attached.
pub(crate) fn assess_port_actions(catalog: &crate::Catalog, status: &mut crate::PortStatus) {
    let restrictions = effective(catalog, &status.port_id);
    for assessment in &mut status.port_actions {
        if let Some(outcome) = restrictions.action_hold(assessment.action) {
            assessment.availability = crate::PortActionAvailability::Held;
            assessment.reason = crate::PortActionReason::RouteNotOffered;
            assessment.definition = None;
            assessment.restriction = outcome.reason();
        }
    }
}

pub(crate) fn require(
    catalog: &crate::Catalog,
    port_id: &str,
    subject: &RestrictionSubject<'_>,
) -> Result<()> {
    effective(catalog, port_id).require(subject)
}

/// The legacy string older listing readers enforce: the explanation of the
/// first authored hold that names Download at any scope. Older readers are
/// therefore never less restricted than capable ones.
pub(crate) fn legacy_download_projection(restrictions: &[AcquisitionRestriction]) -> Option<&str> {
    restrictions
        .iter()
        .find(|restriction| {
            restriction.effect == RestrictionEffect::Hold
                && restriction
                    .operations
                    .contains(&RestrictedOperation::Download)
        })
        .and_then(|restriction| restriction.explanation.as_deref())
}

/// A legacy listing restriction blocks every fresh download.
pub(crate) fn normalize_legacy_listing(reason: Option<&str>) -> Vec<AcquisitionRestriction> {
    reason
        .map(|explanation| {
            vec![AcquisitionRestriction {
                id: "download".into(),
                effect: RestrictionEffect::Hold,
                operations: BTreeSet::from([RestrictedOperation::Download]),
                scope: RestrictionScope::default(),
                reason: Some(RestrictionReason::LegacyUnclassified),
                explanation: Some(explanation.into()),
                reconsider_when: Vec::new(),
                tracking_issue: None,
            }]
        })
        .unwrap_or_default()
}

impl crate::PortListing {
    /// Typed restrictions, or the normalized legacy string of an older listing.
    pub(crate) fn effective_restrictions(&self) -> Vec<AcquisitionRestriction> {
        if self.restrictions.is_empty() {
            normalize_legacy_listing(self.download_block_reason.as_deref())
        } else {
            self.restrictions.clone()
        }
    }
}

fn artifact_scope(artifacts: &[crate::ReviewedHoldArtifact]) -> RestrictionScope {
    RestrictionScope {
        artifacts: artifacts
            .iter()
            .map(|artifact| RestrictedArtifact {
                version: artifact.version.clone(),
                sha256: artifact.sha256.clone(),
                asset_name: None,
            })
            .collect(),
        ..RestrictionScope::default()
    }
}

fn hold(
    id: &str,
    operations: &[RestrictedOperation],
    scope: RestrictionScope,
    reason: RestrictionReason,
    explanation: &str,
) -> AcquisitionRestriction {
    AcquisitionRestriction {
        id: id.into(),
        effect: RestrictionEffect::Hold,
        operations: operations.iter().copied().collect(),
        scope,
        reason: Some(reason),
        explanation: Some(explanation.into()),
        reconsider_when: Vec::new(),
        tracking_issue: None,
    }
}

fn permit(
    id: String,
    operations: &[RestrictedOperation],
    scope: RestrictionScope,
) -> AcquisitionRestriction {
    AcquisitionRestriction {
        id,
        effect: RestrictionEffect::Permit,
        operations: operations.iter().copied().collect(),
        scope,
        reason: None,
        explanation: None,
        reconsider_when: Vec::new(),
        tracking_issue: None,
    }
}

impl crate::ManagedAcquisitionHold {
    /// The exact typed meaning of the legacy managed hold. The catalog
    /// generator emits only typed data that round-trips through this mapping.
    pub(crate) fn to_restrictions(&self) -> Vec<AcquisitionRestriction> {
        use RestrictedOperation as O;
        let acquisition = [O::Download, O::Install, O::Update, O::Adopt];
        if self.excluded_artifacts.is_empty() {
            let mut restrictions = vec![
                hold(
                    "acquisition",
                    &acquisition,
                    RestrictionScope::default(),
                    RestrictionReason::UpstreamTransitionUnreviewed,
                    &self.reason,
                ),
                hold(
                    "activation",
                    &[O::Activate],
                    RestrictionScope::default(),
                    RestrictionReason::UpstreamTransitionUnreviewed,
                    &self.activation_reason,
                ),
            ];
            restrictions.extend(self.reviewed_artifacts.iter().enumerate().map(
                |(index, artifact)| {
                    permit(
                        format!("reviewed-{}", index + 1),
                        &[O::Activate],
                        artifact_scope(std::slice::from_ref(artifact)),
                    )
                },
            ));
            return restrictions;
        }
        let excluded = artifact_scope(&self.excluded_artifacts);
        let mut restrictions = vec![
            hold(
                "excluded-acquisition",
                &acquisition,
                excluded.clone(),
                RestrictionReason::KnownDefectiveArtifact,
                &self.reason,
            ),
            hold(
                "excluded-activation",
                &[O::Activate],
                excluded,
                RestrictionReason::KnownDefectiveArtifact,
                &self.activation_reason,
            ),
        ];
        if !self.reviewed_artifacts.is_empty() {
            restrictions.push(permit(
                "reviewed".into(),
                &[O::Install, O::Update, O::Activate],
                artifact_scope(&self.reviewed_artifacts),
            ));
        }
        restrictions
    }
}

fn valid_text(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_slug(value: &str) -> bool {
    value.len() <= 64
        && !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// Closed validation of one carrier's restriction set.
pub(crate) fn validate(
    restrictions: &[AcquisitionRestriction],
    carrier: RestrictionCarrier,
) -> Result<()> {
    let invalid =
        |detail: &str| PortcoveError::usage(format!("invalid acquisition restriction: {detail}"));
    if restrictions.len() > MAX_RESTRICTIONS {
        return Err(invalid("too many restrictions"));
    }
    let mut ids = BTreeSet::new();
    for restriction in restrictions {
        if !valid_slug(&restriction.id) || !ids.insert(restriction.id.as_str()) {
            return Err(invalid("ids must be unique slugs"));
        }
        if restriction.operations.is_empty()
            || restriction
                .operations
                .iter()
                .any(|operation| match carrier {
                    RestrictionCarrier::Listing => !operation.listing_carrier(),
                    RestrictionCarrier::Managed => !operation.managed_carrier(),
                })
        {
            return Err(invalid("operations are empty or outside this carrier"));
        }
        match restriction.effect {
            RestrictionEffect::Hold => {
                if restriction.reason.is_none()
                    || !restriction
                        .explanation
                        .as_deref()
                        .is_some_and(|text| valid_text(text, 4096))
                {
                    return Err(invalid("a hold requires a reason and bounded explanation"));
                }
            }
            RestrictionEffect::Permit => {
                if restriction.reason.is_some() || restriction.explanation.is_some() {
                    return Err(invalid("a permit carries no reason or explanation"));
                }
            }
        }
        if restriction.tracking_issue == Some(0)
            || restriction.reconsider_when.len()
                != restriction
                    .reconsider_when
                    .iter()
                    .map(|c| *c as u8)
                    .collect::<BTreeSet<_>>()
                    .len()
        {
            return Err(invalid(
                "tracking issue or reconsideration conditions are invalid",
            ));
        }
        validate_scope(&restriction.scope).map_err(|()| invalid("scope is malformed"))?;
        // No Core path resolves inputs or components to known values yet, so a
        // permit on them could never be proven and is refused until one does.
        if restriction.effect == RestrictionEffect::Permit
            && (!restriction.scope.inputs.is_empty() || !restriction.scope.components.is_empty())
        {
            return Err(invalid("a permit cannot yet name inputs or components"));
        }
    }
    for permit in restrictions
        .iter()
        .filter(|r| r.effect == RestrictionEffect::Permit)
    {
        let holds = restrictions
            .iter()
            .filter(|r| r.effect == RestrictionEffect::Hold);
        let mut covered = false;
        for hold in holds {
            let shared = !hold.operations.is_disjoint(&permit.operations);
            if shared && hold.scope == permit.scope {
                return Err(invalid("a hold and a permit share one scope and operation"));
            }
            covered |= shared;
        }
        if !covered {
            return Err(invalid(
                "a permit must cancel part of a hold in its carrier",
            ));
        }
    }
    Ok(())
}

fn validate_scope(scope: &RestrictionScope) -> std::result::Result<(), ()> {
    fn unique<T: PartialEq>(values: &[T]) -> bool {
        values.len() <= MAX_SCOPE_VALUES
            && values
                .iter()
                .enumerate()
                .all(|(index, value)| !values[..index].contains(value))
    }
    let hex = |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
    let ok = unique(&scope.platforms)
        && unique(&scope.releases)
        && scope.releases.iter().all(|v| valid_text(v, 255))
        && unique(&scope.artifacts)
        && scope.artifacts.iter().all(|artifact| {
            valid_text(&artifact.version, 255)
                && hex(&artifact.sha256)
                && artifact.asset_name.as_deref().is_none_or(|name| {
                    valid_text(name, 255)
                        && crate::archive::validate_relative_path(name, false).is_ok()
                        && !name.contains('/')
                })
        })
        && unique(&scope.inputs)
        && scope
            .inputs
            .iter()
            .all(|v| valid_slug(v) || valid_text(v, 128))
        && unique(&scope.components)
        && scope.components.iter().all(|component| match component {
            RestrictedComponent::BundledRuntime { .. } => true,
            RestrictedComponent::ToolArtifact { id } => valid_slug(id),
        });
    ok.then_some(()).ok_or(())
}

/// A selected definition may keep or add restriction, never remove a hold or
/// permit what its baseline did not. Explanations may be reworded.
pub(crate) fn validate_transition(
    baseline: &[AcquisitionRestriction],
    candidate: &[AcquisitionRestriction],
) -> std::result::Result<(), &'static str> {
    let holds = |set: &[AcquisitionRestriction]| {
        set.iter()
            .filter(|r| r.effect == RestrictionEffect::Hold)
            .cloned()
            .collect::<Vec<_>>()
    };
    let baseline_holds = holds(baseline);
    if baseline_holds.is_empty() {
        return Ok(());
    }
    let candidate_holds = holds(candidate);
    if candidate_holds.is_empty() {
        return Err("a managed acquisition hold was removed");
    }
    let candidate_permits: Vec<_> = candidate
        .iter()
        .filter(|r| r.effect == RestrictionEffect::Permit)
        .collect();
    // A broader replacement hold is less specific, so a permit that lost to the
    // baseline hold could now win. Accept it only when no candidate permit that
    // outranks it can reach a subject the baseline hold covered.
    let kept = baseline_holds.iter().all(|hold| {
        candidate_holds.iter().any(|candidate| {
            let rank = candidate.scope.specificity();
            candidate.operations.is_superset(&hold.operations)
                && candidate.scope.covers(&hold.scope)
                && (rank >= hold.scope.specificity()
                    || candidate_permits.iter().all(|permit| {
                        permit.operations.is_disjoint(&hold.operations)
                            || permit.scope.specificity() <= rank
                            || permit.scope.disjoint_from(&hold.scope)
                    }))
        })
    });
    let permits_reviewed = candidate
        .iter()
        .filter(|r| r.effect == RestrictionEffect::Permit)
        .all(|permit| {
            baseline.iter().any(|reviewed| {
                reviewed.effect == RestrictionEffect::Permit
                    && reviewed.operations.is_superset(&permit.operations)
                    && reviewed.scope.covers(&permit.scope)
            })
        });
    if kept && permits_reviewed {
        Ok(())
    } else {
        Err("a managed acquisition hold permits an unreviewed artifact")
    }
}

#[cfg(test)]
#[path = "acquisition_restriction_tests.rs"]
mod acquisition_restriction_tests;
