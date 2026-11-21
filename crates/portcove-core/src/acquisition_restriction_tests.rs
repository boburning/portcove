use super::*;
use crate::{Catalog, Platform, PortAction};
use serde_json::json;

const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn restriction(value: serde_json::Value) -> AcquisitionRestriction {
    serde_json::from_value(value).unwrap()
}

fn whole_download_hold() -> AcquisitionRestriction {
    restriction(json!({
        "id": "download", "effect": "hold", "operations": ["download"],
        "reason": "bundled-game-data", "explanation": "Sibling packages bundle game data."
    }))
}

fn artifact_permit(sha256: &str) -> AcquisitionRestriction {
    restriction(json!({
        "id": "reviewed", "effect": "permit", "operations": ["download"],
        "scope": {"artifacts": [{"version": "v1", "sha256": sha256}]}
    }))
}

fn known<'a>(operation: RestrictedOperation, sha256: &'a str) -> RestrictionSubject<'a> {
    RestrictionSubject::deferred(operation)
        .on(Platform::WindowsX86_64)
        .artifact(SubjectArtifact {
            version: "v1",
            sha256,
            asset_name: Some("game.zip"),
        })
}

fn listing_set(restrictions: Vec<AcquisitionRestriction>) -> EffectiveRestrictions {
    EffectiveRestrictions {
        managed: Vec::new(),
        listing: restrictions,
    }
}

#[test]
fn the_wire_shape_is_closed_and_omits_a_whole_scope() {
    let hold = whole_download_hold();
    let encoded = serde_json::to_value(&hold).unwrap();
    assert!(encoded.get("scope").is_none());
    assert_eq!(encoded["operations"], json!(["download"]));
    for invalid in [
        json!({"id":"x","effect":"hold","operations":["remove"],"reason":"bundled-game-data","explanation":"x"}),
        json!({"id":"x","effect":"hold","operations":["download"],"reason":"bundled-game-data","explanation":"x","grant":true}),
        json!({"id":"x","effect":"hold","operations":["download"],"scope":{"platforms":["windows-x86-64"],"edition":"x"},"reason":"bundled-game-data","explanation":"x"}),
        json!({"id":"x","effect":"hold","operations":["download"],"scope":{"components":[{"kind":"other","id":"x"}]},"reason":"bundled-game-data","explanation":"x"}),
        json!({"id":"x","effect":"hold","operations":["download"],"reason":"reviewed-asset-scope","explanation":"x"}),
    ] {
        assert!(serde_json::from_value::<AcquisitionRestriction>(invalid).is_err());
    }
}

#[test]
fn validation_refuses_wrong_carriers_incomplete_holds_and_ungrounded_permits() {
    let listing = RestrictionCarrier::Listing;
    let managed = RestrictionCarrier::Managed;
    validate(&[whole_download_hold(), artifact_permit(SHA_A)], listing).unwrap();
    let mut install = whole_download_hold();
    install.operations.insert(RestrictedOperation::Install);
    assert!(validate(std::slice::from_ref(&install), listing).is_err());
    validate(std::slice::from_ref(&install), managed).unwrap();
    let mut launch = whole_download_hold();
    launch.operations = BTreeSet::from([RestrictedOperation::Launch]);
    assert!(validate(std::slice::from_ref(&launch), managed).is_err());
    // Older listing readers can only see a download hold, so the listing
    // carries nothing else until they have a gate.
    assert!(validate(std::slice::from_ref(&launch), listing).is_err());
    launch.operations = BTreeSet::from([RestrictedOperation::RegisterExternal]);
    assert!(validate(std::slice::from_ref(&launch), listing).is_err());
    // A permit on an identity Core never resolves could never be proven.
    for scope in [
        json!({"inputs": ["source-profile"]}),
        json!({"components": [{"kind": "tool-artifact", "id": "tool"}]}),
    ] {
        let mut unprovable = artifact_permit(SHA_A);
        unprovable.scope = serde_json::from_value(scope.clone()).unwrap();
        assert!(validate(&[whole_download_hold(), unprovable], listing).is_err());
        let mut scoped_hold = whole_download_hold();
        scoped_hold.scope = serde_json::from_value(scope).unwrap();
        validate(&[scoped_hold], listing).unwrap();
    }

    let mut missing = whole_download_hold();
    missing.reason = None;
    assert!(validate(&[missing], listing).is_err());
    let mut missing = whole_download_hold();
    missing.explanation = Some(" padded ".into());
    assert!(validate(&[missing], listing).is_err());
    let mut explained = artifact_permit(SHA_A);
    explained.reason = Some(RestrictionReason::BundledGameData);
    assert!(validate(&[whole_download_hold(), explained], listing).is_err());
    // Data cannot grant through a permit that cancels no hold.
    assert!(validate(&[artifact_permit(SHA_A)], listing).is_err());
    let mut unrelated = artifact_permit(SHA_A);
    unrelated.operations = BTreeSet::from([RestrictedOperation::Launch]);
    assert!(validate(&[whole_download_hold(), unrelated], listing).is_err());
    let mut same_scope = artifact_permit(SHA_A);
    same_scope.scope = RestrictionScope::default();
    assert!(validate(&[whole_download_hold(), same_scope], listing).is_err());
    let duplicate = whole_download_hold();
    assert!(validate(&[whole_download_hold(), duplicate], listing).is_err());
    assert!(
        validate(
            &[whole_download_hold(), artifact_permit("not-a-digest")],
            listing
        )
        .is_err()
    );
    let mut legacy = whole_download_hold();
    legacy.reason = Some(RestrictionReason::LegacyUnclassified);
    validate(&[legacy], listing).unwrap();
}

#[test]
fn the_most_specific_decision_wins_and_a_hold_wins_a_tie() {
    let restrictions = listing_set(vec![whole_download_hold(), artifact_permit(SHA_A)]);
    let reviewed = restrictions.evaluate(&known(RestrictedOperation::Download, SHA_A));
    assert_eq!(reviewed.state, RestrictionState::Permitted);
    let sibling = restrictions.evaluate(&known(RestrictedOperation::Download, SHA_B));
    assert!(sibling.is_held());
    assert_eq!(
        sibling.explanation().as_deref(),
        Some("Sibling packages bundle game data.")
    );
    assert_eq!(sibling.reason(), Some(RestrictionReason::BundledGameData));

    let mut exact_hold = artifact_permit(SHA_A);
    exact_hold.id = "excluded".into();
    exact_hold.effect = RestrictionEffect::Hold;
    exact_hold.reason = Some(RestrictionReason::KnownDefectiveArtifact);
    exact_hold.explanation = Some("Known defective.".into());
    let tie = listing_set(vec![artifact_permit(SHA_A), exact_hold]);
    assert!(
        tie.evaluate(&known(RestrictedOperation::Download, SHA_A))
            .is_held()
    );
}

#[test]
fn a_hold_from_either_carrier_wins_over_a_permit_from_the_other() {
    let restrictions = EffectiveRestrictions {
        managed: vec![restriction(json!({
            "id": "acquisition", "effect": "hold", "operations": ["download", "install"],
            "reason": "upstream-transition-unreviewed", "explanation": "Held for review."
        }))],
        listing: vec![whole_download_hold(), artifact_permit(SHA_A)],
    };
    let outcome = restrictions.evaluate(&known(RestrictedOperation::Download, SHA_A));
    assert!(outcome.is_held());
    assert_eq!(outcome.explanation().as_deref(), Some("Held for review."));
    assert_eq!(
        outcome.decision.map(|(_, carrier)| carrier),
        Some(RestrictionCarrier::Managed)
    );
}

#[test]
fn unknown_coverage_defers_offers_and_fails_closed_on_unprovable_identities() {
    let mut exact = artifact_permit(SHA_A);
    exact.id = "excluded".into();
    exact.effect = RestrictionEffect::Hold;
    exact.operations = BTreeSet::from([RestrictedOperation::Install, RestrictedOperation::Adopt]);
    exact.reason = Some(RestrictionReason::KnownDefectiveArtifact);
    exact.explanation = Some("Known defective.".into());
    let managed = EffectiveRestrictions {
        managed: vec![exact],
        listing: Vec::new(),
    };
    let deferred = RestrictionSubject::deferred(RestrictedOperation::Install);
    assert_eq!(managed.evaluate(&deferred).state, RestrictionState::Clear);
    let adopted = RestrictionSubject::deferred(RestrictedOperation::Adopt).unverifiable_artifact();
    let outcome = managed.evaluate(&adopted);
    assert!(outcome.is_held() && outcome.unverifiable);
    assert_eq!(
        outcome.explanation().as_deref(),
        Some(UNVERIFIABLE_IDENTITY)
    );
    assert!(
        managed
            .evaluate(&known(RestrictedOperation::Install, SHA_A))
            .is_held()
    );
    assert!(
        !managed
            .evaluate(&known(RestrictedOperation::Install, SHA_B))
            .is_held()
    );

    // A possible permit keeps the offer; the decision repeats on known bytes.
    let listing = listing_set(vec![whole_download_hold(), artifact_permit(SHA_A)]);
    let offer = RestrictionSubject::deferred(RestrictedOperation::Download);
    assert_eq!(listing.evaluate(&offer).state, RestrictionState::Clear);
    // A permit never matches an identity that cannot be proven.
    let unproven =
        RestrictionSubject::deferred(RestrictedOperation::Download).unverifiable_artifact();
    assert!(listing.evaluate(&unproven).is_held());
    // Without a permit, a whole hold withholds the offer at once.
    let whole = listing_set(vec![whole_download_hold()]);
    assert!(whole.evaluate(&offer).is_held());
}

#[test]
fn removal_recovery_and_unnamed_operations_stay_available() {
    let restrictions = EffectiveRestrictions {
        managed: vec![restriction(json!({
            "id": "acquisition", "effect": "hold", "operations": ["download", "install", "update"],
            "reason": "upstream-transition-unreviewed", "explanation": "Held."
        }))],
        listing: vec![whole_download_hold()],
    };
    for action in [
        PortAction::Launch,
        PortAction::RegisterExternal,
        PortAction::RemoveManaged,
        PortAction::RemoveExternal,
        PortAction::Rollback,
        PortAction::BackupCreate,
        PortAction::BackupRestore,
    ] {
        assert!(restrictions.action_hold(action).is_none(), "{action:?}");
    }
    assert!(restrictions.action_hold(PortAction::Install).is_some());
    assert!(restrictions.action_hold(PortAction::Update).is_some());
    let launch = listing_set(vec![restriction(json!({
        "id": "launch", "effect": "hold", "operations": ["launch"],
        "reason": "upstream-prohibition", "explanation": "Launch is held."
    }))]);
    assert!(launch.action_hold(PortAction::Launch).is_some());
}

#[test]
fn operation_maps_are_total_and_never_name_removal_or_recovery() {
    use crate::DefinitionOperation as D;
    use crate::definition_repository::publisher_policy::CuratedArtifactOperation as C;
    for action in [
        PortAction::Install,
        PortAction::RegisterExternal,
        PortAction::Launch,
        PortAction::RemoveManaged,
        PortAction::RemoveExternal,
        PortAction::Rollback,
        PortAction::BackupCreate,
        PortAction::BackupRestore,
        PortAction::Update,
    ] {
        let mapped = RestrictedOperation::from_port_action(action);
        assert_eq!(
            mapped.is_some(),
            matches!(
                action,
                PortAction::Install
                    | PortAction::Update
                    | PortAction::RegisterExternal
                    | PortAction::Launch
            )
        );
    }
    for operation in [
        D::Availability,
        D::Install,
        D::RegisterExternal,
        D::Prepare,
        D::Launch,
        D::Update,
    ] {
        assert_eq!(
            RestrictedOperation::from_definition_operation(operation).is_none(),
            operation == D::Availability
        );
    }
    for operation in RestrictedOperation::ALL {
        let expected = match operation {
            RestrictedOperation::Download
            | RestrictedOperation::Install
            | RestrictedOperation::Update => Some(C::Acquisition),
            RestrictedOperation::Activate | RestrictedOperation::Launch => Some(C::LocalUse),
            _ => None,
        };
        assert_eq!(operation.curated_operation(), expected);
    }
}

#[test]
fn legacy_listing_projection_is_the_first_download_hold_at_any_scope() {
    let mut scoped = whole_download_hold();
    scoped.id = "windows".into();
    scoped.scope.platforms = vec![Platform::WindowsX86_64];
    scoped.explanation = Some("Windows packages are held.".into());
    let restrictions = [artifact_permit(SHA_A), scoped, whole_download_hold()];
    assert_eq!(
        legacy_download_projection(&restrictions),
        Some("Windows packages are held.")
    );
    assert_eq!(legacy_download_projection(&[]), None);
    let normalized = normalize_legacy_listing(Some("Legacy reason."));
    assert_eq!(
        normalized[0].reason,
        Some(RestrictionReason::LegacyUnclassified)
    );
    assert_eq!(
        legacy_download_projection(&normalized),
        Some("Legacy reason.")
    );
}

fn legacy_hold(excluded: bool) -> crate::ManagedAcquisitionHold {
    let artifact = |sha: &str| crate::ReviewedHoldArtifact {
        version: "v1".into(),
        sha256: sha.into(),
    };
    crate::ManagedAcquisitionHold {
        reason: "Held.".into(),
        activation_reason: "Not reviewed.".into(),
        reviewed_artifacts: vec![artifact(SHA_A)],
        excluded_artifacts: if excluded {
            vec![artifact(SHA_B)]
        } else {
            Vec::new()
        },
    }
}

#[test]
fn normalized_managed_holds_are_valid_and_keep_their_meaning() {
    for excluded in [false, true] {
        let restrictions = legacy_hold(excluded).to_restrictions();
        validate(&restrictions, RestrictionCarrier::Managed).unwrap();
        let set = EffectiveRestrictions {
            managed: restrictions,
            listing: Vec::new(),
        };
        let reviewed = set.evaluate(&known(RestrictedOperation::Activate, SHA_A));
        assert!(!reviewed.is_held());
        assert_eq!(
            set.evaluate(&RestrictionSubject::deferred(RestrictedOperation::Install))
                .is_held(),
            !excluded
        );
    }
}

#[test]
fn the_loader_accepts_only_changes_that_keep_or_add_restriction() {
    let baseline = vec![whole_download_hold(), artifact_permit(SHA_A)];
    validate_transition(&baseline, &baseline).unwrap();
    let mut reworded = baseline.clone();
    reworded[0].explanation = Some("Reworded.".into());
    validate_transition(&baseline, &reworded).unwrap();
    let mut added = baseline.clone();
    added.push(restriction(json!({
        "id": "launch", "effect": "hold", "operations": ["launch"],
        "reason": "upstream-prohibition", "explanation": "Launch is held."
    })));
    validate_transition(&baseline, &added).unwrap();
    validate_transition(&baseline, &baseline[..1]).unwrap();

    assert_eq!(
        validate_transition(&baseline, &[]),
        Err("a managed acquisition hold was removed")
    );
    let mut narrowed = baseline.clone();
    narrowed[0].scope.platforms = vec![Platform::WindowsX86_64];
    assert!(validate_transition(&baseline, &narrowed).is_err());
    let mut fewer = baseline.clone();
    fewer[0].operations = BTreeSet::from([RestrictedOperation::Launch]);
    assert!(validate_transition(&baseline, &fewer).is_err());
    let mut widened = baseline.clone();
    widened.push(artifact_permit(SHA_B));
    widened[2].id = "other".into();
    assert!(validate_transition(&baseline, &widened).is_err());
    let mut broader_permit = baseline.clone();
    broader_permit[1].scope = RestrictionScope {
        platforms: vec![Platform::WindowsX86_64],
        ..RestrictionScope::default()
    };
    assert!(validate_transition(&baseline, &broader_permit).is_err());
}

/// A test-only copy of the decisions Core made before typed restrictions.
mod legacy_reference {
    use crate::ManagedAcquisitionHold as Hold;

    fn matches(artifacts: &[crate::ReviewedHoldArtifact], version: &str, sha256: &str) -> bool {
        artifacts
            .iter()
            .any(|a| a.version == version && a.sha256.eq_ignore_ascii_case(sha256))
    }

    pub fn acquisition(hold: Option<&Hold>) -> Option<String> {
        hold.filter(|hold| hold.excluded_artifacts.is_empty())
            .map(|hold| hold.reason.clone())
    }

    pub fn artifact(hold: Option<&Hold>, version: &str, sha256: &str) -> Option<String> {
        hold.filter(|hold| matches(&hold.excluded_artifacts, version, sha256))
            .map(|hold| hold.reason.clone())
    }

    pub fn adoption(hold: Option<&Hold>) -> Option<String> {
        hold.filter(|hold| !hold.excluded_artifacts.is_empty())
            .map(|_| super::UNVERIFIABLE_IDENTITY.to_owned())
    }

    pub fn activation(hold: Option<&Hold>, version: &str, sha256: &str) -> Option<String> {
        let hold = hold?;
        if !matches(&hold.excluded_artifacts, version, sha256)
            && (!hold.excluded_artifacts.is_empty()
                || matches(&hold.reviewed_artifacts, version, sha256))
        {
            return None;
        }
        Some(hold.activation_reason.clone())
    }
}

#[derive(Clone, Copy, Debug)]
enum Case<'a> {
    Deferred,
    Unverifiable,
    /// A listed package without a published digest: its release is known.
    Release(&'a str),
    Known(&'a str, &'a str),
}

/// Every migrated row, platform, operation and artifact-knowledge case that a
/// Core call site can produce decides exactly as before, with the same text.
#[test]
fn migration_is_behavior_preserving() {
    use RestrictedOperation as O;
    let catalog = Catalog::embedded().unwrap();
    let managed: Vec<_> = catalog
        .ports()
        .iter()
        .filter(|port| port.managed_acquisition_hold.is_some())
        .map(|port| port.id.clone())
        .collect();
    let listed: Vec<_> = catalog
        .listings()
        .iter()
        .filter(|listing| listing.download_block_reason.is_some())
        .map(|listing| listing.id.clone())
        .collect();
    assert_eq!(managed.len(), 5, "managed holds");
    assert_eq!(listed.len(), 152, "listing restrictions");
    for listing in catalog.listings() {
        // Every row is typed; none relies on reader normalization.
        assert_eq!(
            listing.restrictions.is_empty(),
            listing.download_block_reason.is_none(),
            "{}",
            listing.id
        );
        assert!(
            listing
                .restrictions
                .iter()
                .all(|r| r.reason != Some(RestrictionReason::LegacyUnclassified)),
            "{}",
            listing.id
        );
    }
    let mut compared = 0_usize;
    for id in managed.iter().chain(&listed) {
        let hold = catalog
            .port(id)
            .ok()
            .and_then(|port| port.managed_acquisition_hold.as_ref());
        let listing_reason = catalog
            .listing(id)
            .ok()
            .and_then(|listing| listing.download_block_reason.clone());
        let mut cases = vec![
            Case::Deferred,
            Case::Unverifiable,
            Case::Release("v0.0.0-unseen"),
            Case::Known("v0.0.0-unseen", SHA_A),
        ];
        for artifact in hold.iter().flat_map(|hold| {
            hold.reviewed_artifacts
                .iter()
                .chain(&hold.excluded_artifacts)
        }) {
            cases.push(Case::Known(&artifact.version, &artifact.sha256));
        }
        let restrictions = EffectiveRestrictions::of(&catalog, id);
        let platforms = [
            Knowledge::Known(Platform::WindowsX86_64),
            Knowledge::Known(Platform::LinuxX86_64),
            Knowledge::Known(Platform::MacosX86_64),
            Knowledge::Known(Platform::MacosAarch64),
            Knowledge::Deferred,
        ];
        for platform in platforms {
            for operation in RestrictedOperation::ALL {
                for case in &cases {
                    let legacy = match (operation, *case) {
                        (O::Download, Case::Deferred | Case::Release(_)) => {
                            legacy_reference::acquisition(hold).or(listing_reason.clone())
                        }
                        (O::Download, Case::Known(version, sha)) => {
                            legacy_reference::acquisition(hold)
                                .or(listing_reason.clone())
                                .or(legacy_reference::artifact(hold, version, sha))
                        }
                        (O::Install | O::Update, Case::Deferred | Case::Release(_)) => {
                            legacy_reference::acquisition(hold)
                        }
                        (O::Install | O::Update, Case::Known(version, sha)) => {
                            legacy_reference::acquisition(hold)
                                .or(legacy_reference::artifact(hold, version, sha))
                        }
                        (O::Adopt, Case::Unverifiable) => {
                            legacy_reference::acquisition(hold).or(legacy_reference::adoption(hold))
                        }
                        (O::Activate, Case::Known(version, sha)) => {
                            legacy_reference::activation(hold, version, sha)
                        }
                        (O::Prepare | O::RegisterExternal | O::Launch, _) => None,
                        // No Core call site evaluates these combinations.
                        _ => continue,
                    };
                    let mut subject = RestrictionSubject::deferred(operation);
                    subject.platform = platform;
                    match *case {
                        Case::Deferred => {}
                        Case::Unverifiable => subject = subject.unverifiable_artifact(),
                        Case::Release(tag) => subject.release = Knowledge::Known(tag),
                        Case::Known(version, sha256) => {
                            subject = subject.artifact(SubjectArtifact {
                                version,
                                sha256,
                                asset_name: Some("package.zip"),
                            })
                        }
                    }
                    // The phase each Core call site uses: offers and status
                    // views defer; downloaded bytes, the install artifact gate,
                    // activation and adoption are final.
                    let phases: &[bool] = match (operation, *case) {
                        (O::Activate | O::Adopt, _) => &[true],
                        (_, Case::Known(..)) => &[false, true],
                        (O::Prepare | O::RegisterExternal | O::Launch, _) => &[false, true],
                        _ => &[false],
                    };
                    for &final_phase in phases {
                        let subject = if final_phase {
                            subject.final_check()
                        } else {
                            subject
                        };
                        let typed = restrictions.evaluate(&subject).explanation();
                        assert_eq!(
                            typed, legacy,
                            "{id} {platform:?} {operation:?} {case:?} final={final_phase}"
                        );
                        compared += 1;
                    }
                }
            }
        }
        // The retained wrapper entry points agree with their previous bodies.
        assert_eq!(
            crate::managed_runtime_policy::acquisition_hold_reason(&catalog, id),
            legacy_reference::acquisition(hold),
            "{id}"
        );
        assert_eq!(
            crate::managed_runtime_policy::require_adoption_available(&catalog, id)
                .err()
                .map(|error| error.message),
            legacy_reference::adoption(hold),
            "{id}"
        );
        // The install flow runs the acquisition gate and then the final
        // artifact gate; together they decide exactly as before.
        for case in &cases {
            if let Case::Known(version, sha) = *case {
                assert_eq!(
                    crate::managed_runtime_policy::require_acquisition_available(&catalog, id)
                        .and_then(|()| {
                            crate::managed_runtime_policy::require_artifact_available(
                                &catalog, id, version, sha,
                            )
                        })
                        .err()
                        .map(|error| error.message),
                    legacy_reference::acquisition(hold)
                        .or(legacy_reference::artifact(hold, version, sha)),
                    "{id} {version}"
                );
            }
        }
    }
    assert!(compared > 157 * 5 * 8, "{compared}");
}

#[test]
fn an_unseen_identity_gains_a_scoped_permit_through_data_alone() {
    let catalog = Catalog::embedded().unwrap();
    let mut directory = catalog.listing_document().clone();
    let listing = directory
        .listings
        .iter_mut()
        .find(|listing| {
            listing.download_block_reason.is_some() && catalog.port(&listing.id).is_err()
        })
        .unwrap();
    let id = listing.id.clone();
    listing.restrictions.push(restriction(json!({
        "id": "fixture-reviewed-package", "effect": "permit", "operations": ["download"],
        "scope": {"artifacts": [{"version": "fixture-v1", "sha256": SHA_A, "asset_name": "fixture.zip"}]}
    })));
    let changed = catalog.clone().with_listing_document(directory).unwrap();
    let restrictions = EffectiveRestrictions::of(&changed, &id);
    let offer =
        RestrictionSubject::deferred(RestrictedOperation::Download).on(Platform::WindowsX86_64);
    assert!(!restrictions.evaluate(&offer).is_held());
    let bytes = |sha256| {
        RestrictionSubject::deferred(RestrictedOperation::Download).artifact(SubjectArtifact {
            version: "fixture-v1",
            sha256,
            asset_name: Some("fixture.zip"),
        })
    };
    assert_eq!(
        restrictions.evaluate(&bytes(SHA_A)).state,
        RestrictionState::Permitted
    );
    assert!(restrictions.evaluate(&bytes(SHA_B)).is_held());
    // Older readers still see the whole legacy hold.
    let legacy = changed.listing_document().export_format(14).unwrap();
    let exported = legacy.listings.iter().find(|l| l.id == id).unwrap();
    assert!(exported.restrictions.is_empty());
    assert_eq!(
        exported.download_block_reason,
        catalog.listing(&id).unwrap().download_block_reason
    );
}

#[test]
fn a_format_14_reader_refuses_typed_restrictions_and_a_diverging_legacy_string() {
    let catalog = Catalog::embedded().unwrap();
    let document = catalog.listing_document().clone();
    assert_eq!(document.format_version, RESTRICTION_LISTING_FORMAT);
    let mut older = document.clone();
    older.format_version = 14;
    let error = older.validate().unwrap_err();
    assert!(
        error.message.contains("listing format 15"),
        "{}",
        error.message
    );
    let exported = document.export_format(14).unwrap();
    assert!(exported.listings.iter().all(|l| l.restrictions.is_empty()));
    assert_eq!(
        exported
            .listings
            .iter()
            .filter(|l| l.download_block_reason.is_some())
            .count(),
        document
            .listings
            .iter()
            .filter(|l| l.download_block_reason.is_some())
            .count()
    );
    let mut diverging = document.clone();
    let listing = diverging
        .listings
        .iter_mut()
        .find(|listing| !listing.restrictions.is_empty())
        .unwrap();
    listing.download_block_reason = Some("A weaker or different legacy text.".into());
    assert!(diverging.validate().is_err());
    let mut untyped = document;
    let listing = untyped
        .listings
        .iter_mut()
        .find(|listing| !listing.restrictions.is_empty())
        .unwrap();
    listing.restrictions.clear();
    assert!(untyped.validate().is_err());
}

#[test]
fn library_status_withholds_only_the_named_actions_with_their_reason() {
    let temporary = tempfile::tempdir().unwrap();
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    let service = crate::PortcoveService::new(library).unwrap();
    let status = service.status("open-nectar-pikmin").unwrap();
    for assessment in &status.port_actions {
        let named = matches!(assessment.action, PortAction::Install | PortAction::Update);
        assert_eq!(
            assessment.restriction,
            named.then_some(RestrictionReason::UpstreamTransitionUnreviewed),
            "{:?}",
            assessment.action
        );
        if named {
            assert_eq!(assessment.availability, crate::PortActionAvailability::Held);
            assert_eq!(assessment.reason, crate::PortActionReason::RouteNotOffered);
        }
    }
    // An exact-artifact hold leaves fresh acquisition offered until the bytes are known.
    let status = service.status("super-metroid-recomp").unwrap();
    assert!(status.port_actions.iter().all(|a| a.restriction.is_none()));
}

#[test]
fn target_inspection_reports_a_scoped_permit_as_an_offered_download() {
    let catalog = Catalog::embedded().unwrap();
    let id = catalog
        .listings()
        .iter()
        .find(|listing| {
            listing.download_block_reason.is_some() && catalog.port(&listing.id).is_err()
        })
        .unwrap()
        .id
        .clone();
    let before = crate::inspect_targets(&catalog, std::slice::from_ref(&id), &[]).unwrap();
    assert!(before.ports[0].download_restriction.is_some());
    let mut directory = catalog.listing_document().clone();
    let listing = directory.listings.iter_mut().find(|l| l.id == id).unwrap();
    listing.restrictions.push(restriction(json!({
        "id": "fixture-reviewed-package", "effect": "permit", "operations": ["download"],
        "scope": {"artifacts": [{"version": "fixture-v1", "sha256": SHA_A}]}
    })));
    let changed = catalog.clone().with_listing_document(directory).unwrap();
    let after = crate::inspect_targets(&changed, std::slice::from_ref(&id), &[]).unwrap();
    assert!(after.ports[0].download_restriction.is_none());
    for port in catalog
        .ports()
        .iter()
        .filter(|port| port.managed_acquisition_hold.is_some())
    {
        let inspected =
            crate::inspect_targets(&catalog, std::slice::from_ref(&port.id), &[]).unwrap();
        assert_eq!(
            inspected.ports[0].acquisition_hold,
            crate::managed_runtime_policy::acquisition_hold_reason(&catalog, &port.id),
        );
    }
}

#[test]
fn an_unresolvable_permit_never_opens_a_hold_at_offer_or_final() {
    let mut permit = artifact_permit(SHA_A);
    permit.scope = serde_json::from_value(json!({"inputs": ["source-profile"]})).unwrap();
    let listing = listing_set(vec![whole_download_hold(), permit]);
    let offer = RestrictionSubject::deferred(RestrictedOperation::Download);
    assert!(listing.evaluate(&offer).is_held());
    let bytes = known(RestrictedOperation::Download, SHA_B).final_check();
    assert!(listing.evaluate(&bytes).is_held());

    // A platform permit decides an offer only once the host is known, and the
    // final check never defers it.
    let mut windows = artifact_permit(SHA_A);
    windows.scope = RestrictionScope {
        platforms: vec![Platform::WindowsX86_64],
        ..RestrictionScope::default()
    };
    let listing = listing_set(vec![whole_download_hold(), windows]);
    assert!(
        listing
            .evaluate(&RestrictionSubject::deferred(RestrictedOperation::Download).final_check())
            .is_held()
    );
    assert!(
        !listing
            .evaluate(
                &RestrictionSubject::deferred(RestrictedOperation::Download)
                    .on(Platform::WindowsX86_64)
                    .final_check()
            )
            .is_held()
    );
}

#[test]
fn the_final_artifact_gate_refuses_any_hold_not_only_exact_ones() {
    let managed = EffectiveRestrictions {
        managed: vec![
            restriction(json!({
                "id": "acquisition", "effect": "hold", "operations": ["install"],
                "reason": "upstream-transition-unreviewed", "explanation": "Held."
            })),
            restriction(json!({
                "id": "reviewed", "effect": "permit", "operations": ["install"],
                "scope": {"artifacts": [{"version": "v1", "sha256": SHA_A}]}
            })),
        ],
        listing: Vec::new(),
    };
    validate(&managed.managed, RestrictionCarrier::Managed).unwrap();
    assert!(
        managed
            .artifact_hold(RestrictedOperation::Install, "v1", SHA_B)
            .is_some()
    );
    assert!(
        managed
            .artifact_hold(RestrictedOperation::Install, "v1", SHA_A)
            .is_none()
    );
    // Release selection still distinguishes an exact exclusion from a route hold.
    assert!(
        managed
            .artifact_exclusion(RestrictedOperation::Install, "v1", SHA_B)
            .is_none()
    );
}

#[test]
fn a_broader_replacement_hold_cannot_let_an_existing_permit_win() {
    let hold_install = |id: &str, scope: serde_json::Value| {
        restriction(json!({
            "id": id, "effect": "hold", "operations": ["install"], "scope": scope,
            "reason": "known-defective-artifact", "explanation": "Held."
        }))
    };
    let whole = || {
        restriction(json!({
            "id": "whole", "effect": "hold", "operations": ["install"],
            "reason": "upstream-transition-unreviewed", "explanation": "Held."
        }))
    };
    let release_permit = restriction(json!({
        "id": "release", "effect": "permit", "operations": ["install"],
        "scope": {"releases": ["v1"]}
    }));
    let baseline = vec![
        whole(),
        hold_install(
            "exact",
            json!({"artifacts": [{"version": "v1", "sha256": SHA_A}]}),
        ),
        release_permit.clone(),
    ];
    let mut swapped = whole();
    swapped.id = "exact".into();
    let candidate = vec![whole(), swapped, release_permit.clone()];
    assert!(validate_transition(&baseline, &candidate).is_err());
    validate_transition(&baseline, &baseline).unwrap();
    // A replacement that no outranking permit can reach stays acceptable.
    let mut elsewhere = release_permit;
    elsewhere.scope = RestrictionScope {
        artifacts: vec![RestrictedArtifact {
            version: "v1".into(),
            sha256: SHA_B.into(),
            asset_name: None,
        }],
        ..RestrictionScope::default()
    };
    let baseline = vec![
        whole(),
        hold_install(
            "exact",
            json!({"artifacts": [{"version": "v1", "sha256": SHA_A}]}),
        ),
        elsewhere.clone(),
    ];
    let mut swapped = whole();
    swapped.id = "exact".into();
    validate_transition(&baseline, &[whole(), swapped, elsewhere]).unwrap();
}
