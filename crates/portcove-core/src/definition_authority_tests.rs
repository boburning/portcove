use super::*;
use policy::provisioning::official_catalog::{
    enable_fixture as enable_official, review_fixture as review_official,
};
use policy::provisioning::{apply_fixture, review_fixture};
use policy::provisioning::{apply_single_owner_fixture, review_single_owner_fixture};
use tough::schema::Signed;

pub(super) fn separated_fixture() -> RepositoryFixture {
    let mut fixture = RepositoryFixture::new();
    fixture.separated_roles = Some([
        Key::new(fixture._directory.path()),
        Key::new(fixture._directory.path()),
        Key::new(fixture._directory.path()),
    ]);
    fixture
}

async fn single_owner_root(fixture: &RepositoryFixture) -> Vec<u8> {
    let original: Signed<Root> = serde_json::from_slice(&fixture.root(true).await).unwrap();
    let mut root = original.signed;
    let roots = root.roles.get_mut(&RoleType::Root).unwrap();
    for id in roots.keyids.drain(1..) {
        root.keys.remove(&id);
    }
    roots.threshold = nz(1);
    SignedRole::new(
        root.clone(),
        &KeyHolder::Root(root),
        &[fixture.offline[0].source()],
        &SystemRandom::new(),
    )
    .await
    .unwrap()
    .buffer()
    .clone()
}

#[tokio::test]
async fn explicit_single_owner_bootstrap_preserves_legacy_and_existing_anchor_refusals() {
    let root = single_owner_root(&separated_fixture()).await;
    let legacy_root = separated_fixture().root(true).await;
    let (_directory, library) = library();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    assert!(review_fixture(&library, &root).is_err());
    assert!(review_single_owner_fixture(&library, &legacy_root).is_err());
    let mut unsigned: Signed<Root> = serde_json::from_slice(&root).unwrap();
    unsigned.signatures.clear();
    assert!(
        review_single_owner_fixture(&library, &serde_json::to_vec(&unsigned).unwrap()).is_err()
    );
    assert_eq!(data_version(&observer), before);

    let plan = review_single_owner_fixture(&library, &root).unwrap();
    let applied = apply_single_owner_fixture(&library, &root, &plan.expected_plan).unwrap();
    assert!(applied.changed);
    assert!(
        !apply_single_owner_fixture(&library, &root, &plan.expected_plan)
            .unwrap()
            .changed
    );
    let installed = data_version(&observer);
    let foreign = single_owner_root(&separated_fixture()).await;
    assert!(review_single_owner_fixture(&library, &foreign).is_err());
    assert!(apply_single_owner_fixture(&library, &foreign, &applied.review.expected_plan).is_err());
    assert_eq!(data_version(&observer), installed);

    let (_old_directory, old_library) = super::library();
    let old_observer = old_library.connection().unwrap();
    let old_plan = review_fixture(&old_library, &legacy_root).unwrap();
    apply_fixture(&old_library, &legacy_root, &old_plan.expected_plan).unwrap();
    let old_version = data_version(&old_observer);
    assert!(review_single_owner_fixture(&old_library, &root).is_err());
    assert!(apply_single_owner_fixture(&old_library, &root, &old_plan.expected_plan).is_err());
    assert_eq!(data_version(&old_observer), old_version);
    assert!(
        review_fixture(&old_library, &legacy_root)
            .unwrap()
            .installed
    );
}

fn data_version(connection: &rusqlite::Connection) -> i64 {
    connection
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap()
}

#[test]
fn appointed_build_reviews_its_anchor_without_automatically_installing_it() {
    let (_directory, library) = library();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    let review = library.review_definition_authority().unwrap();
    assert_eq!(review.provisioning_schema, 1);
    assert!(review.configured);
    assert!(!review.installed);
    assert_eq!(
        review.compiled_anchor_sha256.as_deref(),
        Some("748bf3e9ec10a585ea62beb6228379642de3b33d0f2d94272ce0bd42d6e35e7b")
    );
    assert_eq!(data_version(&observer), before);

    let unconfigured = review_fixture(&library, b"null").unwrap();
    assert!(!unconfigured.configured && !unconfigured.installed);
    assert!(unconfigured.compiled_anchor_sha256.is_none());
    assert!(apply_fixture(&library, b"null", &unconfigured.expected_plan).is_err());
    assert_eq!(data_version(&observer), before);
}

const OFFICIAL_SOURCE: &[u8] = br#"{"metadata_base_url":"https://catalog.invalid/metadata/","targets_base_url":"https://catalog.invalid/targets/"}"#;

#[test]
fn official_catalog_keeps_explicit_unconfigured_inputs_inert() {
    let (_directory, library) = library();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    let current = review_official(&library, b"null", b"null").unwrap();
    assert!(!current.configured && !current.enabled);
    assert!(current.expected_plan.is_none() && current.source.is_none());
    assert!(enable_official(&library, b"null", b"null", &"0".repeat(64)).is_err());
    assert_eq!(data_version(&observer), before);
}

#[tokio::test]
async fn official_catalog_appointed_defaults_require_explicit_enablement() {
    let (_directory, library) = library();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    let current = library.review_official_catalog().unwrap();
    assert!(current.configured && !current.enabled);
    let source = current.source.as_ref().unwrap();
    assert_eq!(
        source.metadata_base_url,
        "https://boburning.github.io/portcove/catalog/metadata/"
    );
    assert_eq!(
        source.targets_base_url,
        "https://boburning.github.io/portcove/catalog/targets/"
    );
    assert!(library.enable_official_catalog(&"0".repeat(64)).is_err());
    let service = PortcoveService::new(library.clone()).unwrap();
    let error = service
        .refresh_official_catalog(|_| panic!("unprovisioned catalog emitted activity"))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(data_version(&observer), before);
    assert!(!library.review_definition_authority().unwrap().installed);

    let plan = current.expected_plan.as_deref().unwrap();
    let enabled = library.enable_official_catalog(plan).unwrap();
    assert!(enabled.changed && enabled.review.enabled);
    assert!(!library.enable_official_catalog(plan).unwrap().changed);
    assert!(library.review_definition_authority().unwrap().installed);
    assert!(
        library
            .definition_selection_status()
            .unwrap()
            .selected
            .is_none()
    );
    assert!(library.activities(10).unwrap().is_empty());
}

#[tokio::test]
async fn official_catalog_requires_both_appointed_inputs_without_selecting_trust() {
    let fixture = separated_fixture();
    let root = single_owner_root(&fixture).await;
    let (_directory, library) = library();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    for (root, source) in [
        (root.as_slice(), b"null".as_slice()),
        (b"null".as_slice(), OFFICIAL_SOURCE),
    ] {
        let review = review_official(&library, root, source).unwrap();
        assert!(!review.configured && !review.enabled);
        assert!(review.expected_plan.is_none());
        assert!(enable_official(&library, root, source, &"0".repeat(64)).is_err());
    }
    assert_eq!(data_version(&observer), before);
}

#[tokio::test]
async fn official_confirmation_binds_source_library_and_existing_root_plan() {
    let fixture = separated_fixture();
    let root = single_owner_root(&fixture).await;
    let (_directory, library) = library();
    let (_other_directory, other) = super::library();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    let review = review_official(&library, &root, OFFICIAL_SOURCE).unwrap();
    assert!(review.configured && !review.enabled);
    let token = review.expected_plan.unwrap();
    let raw_authority = review_single_owner_fixture(&library, &root).unwrap();
    assert_ne!(token, raw_authority.expected_plan);
    assert!(enable_official(&other, &root, OFFICIAL_SOURCE, &token).is_err());
    assert!(
        enable_official(
            &library,
            &root,
            OFFICIAL_SOURCE,
            &raw_authority.expected_plan
        )
        .is_err()
    );
    let changed_source = br#"{"metadata_base_url":"https://other.invalid/metadata/","targets_base_url":"https://catalog.invalid/targets/"}"#;
    assert!(enable_official(&library, &root, changed_source, &token).is_err());
    let reformatted = [OFFICIAL_SOURCE, b"\n"].concat();
    assert!(enable_official(&library, &root, &reformatted, &token).is_err());
    assert_eq!(data_version(&observer), before);
    let enabled = enable_official(&library, &root, OFFICIAL_SOURCE, &token).unwrap();
    assert!(enabled.changed && enabled.review.enabled);
    let installed = data_version(&observer);
    assert_ne!(installed, before);
    for expected in [&token, enabled.review.expected_plan.as_ref().unwrap()] {
        let retry = enable_official(&library, &root, OFFICIAL_SOURCE, expected).unwrap();
        assert!(!retry.changed && retry.review.enabled);
        assert_eq!(data_version(&observer), installed);
    }
    let foreign_root = single_owner_root(&separated_fixture()).await;
    assert!(enable_official(&library, &foreign_root, OFFICIAL_SOURCE, &token).is_err());
    assert_eq!(data_version(&observer), installed);
}

#[tokio::test]
async fn official_catalog_rejects_unsafe_or_extended_sources_without_writes() {
    let fixture = separated_fixture();
    let root = single_owner_root(&fixture).await;
    let (_directory, library) = library();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    for source in [
        br#"{"metadata_base_url":"http://catalog.invalid/metadata/","targets_base_url":"https://catalog.invalid/targets/"}"#.as_slice(),
        br#"{"metadata_base_url":"https://user:secret@catalog.invalid/metadata/","targets_base_url":"https://catalog.invalid/targets/"}"#.as_slice(),
        br#"{"metadata_base_url":"https://catalog.invalid/metadata/","targets_base_url":"https://catalog.invalid/targets/","root":"caller-choice"}"#.as_slice(),
        b"{}",
        b"",
        &vec![b' '; 4097],
    ] {
        assert!(review_official(&library, &root, source).is_err());
        assert!(enable_official(&library, &root, source, &"0".repeat(64)).is_err());
        assert_eq!(data_version(&observer), before);
    }
}

#[tokio::test]
async fn official_setup_preserves_corrupt_history_refusal_without_repair() {
    let fixture = separated_fixture();
    let root = single_owner_root(&fixture).await;
    let (_directory, library) = library();
    let token = review_official(&library, &root, OFFICIAL_SOURCE)
        .unwrap()
        .expected_plan
        .unwrap();
    enable_official(&library, &root, OFFICIAL_SOURCE, &token).unwrap();
    let observer = library.connection().unwrap();
    observer
        .execute(
            "UPDATE definition_publisher_authority SET trusted_root_json='{}'",
            [],
        )
        .unwrap();
    let before = data_version(&observer);
    assert!(review_official(&library, &root, OFFICIAL_SOURCE).is_err());
    assert!(enable_official(&library, &root, OFFICIAL_SOURCE, &token).is_err());
    assert_eq!(data_version(&observer), before);
}

#[tokio::test]
async fn official_setup_does_not_replay_initial_confirmation_after_admission() {
    let fixture = separated_fixture();
    let root = single_owner_root(&fixture).await;
    let (_directory, library) = library();
    let initial = review_official(&library, &root, OFFICIAL_SOURCE)
        .unwrap()
        .expected_plan
        .unwrap();
    enable_official(&library, &root, OFFICIAL_SOURCE, &initial).unwrap();
    let key = Key::new(fixture._directory.path());
    publish(&fixture, &key, 1, &managed_github(1)).await;
    let accepted = acquire_policy(&fixture, &root, ID).await.unwrap();
    let candidate = acquire(&fixture, &root).await.unwrap();
    library
        .apply_definition_publisher_policy(&accepted, Some(&candidate))
        .unwrap();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    let floor: String = observer
        .query_row(
            "SELECT replay_floor_json FROM definition_publisher_authority",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(enable_official(&library, &root, OFFICIAL_SOURCE, &initial).is_err());
    let current = review_official(&library, &root, OFFICIAL_SOURCE).unwrap();
    let retry = enable_official(
        &library,
        &root,
        OFFICIAL_SOURCE,
        current.expected_plan.as_ref().unwrap(),
    )
    .unwrap();
    assert!(!retry.changed);
    let retained: String = observer
        .query_row(
            "SELECT replay_floor_json FROM definition_publisher_authority",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, floor);
    assert_eq!(data_version(&observer), before);
}

#[tokio::test]
async fn exact_bootstrap_and_lost_response_retries_write_only_once() {
    let fixture = separated_fixture();
    let root = fixture.root(true).await;
    let (_directory, library) = library();
    let (_other_directory, other) = super::library();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    let review = review_fixture(&library, &root).unwrap();
    assert_eq!(data_version(&observer), before);
    assert!(apply_fixture(&other, &root, &review.expected_plan).is_err());
    assert!(apply_fixture(&library, &root, &"0".repeat(64)).is_err());
    assert_eq!(data_version(&observer), before);
    let applied = apply_fixture(&library, &root, &review.expected_plan).unwrap();
    assert!(applied.changed);
    assert!(applied.review.installed);
    assert_ne!(applied.review.expected_plan, review.expected_plan);
    let installed_version = data_version(&observer);
    assert_ne!(installed_version, before);
    for expected in [&review.expected_plan, &applied.review.expected_plan] {
        let repeated = apply_fixture(&library, &root, expected).unwrap();
        assert!(!repeated.changed);
        assert_eq!(repeated.review.expected_plan, applied.review.expected_plan);
        assert_eq!(data_version(&observer), installed_version);
    }
    let foreign = separated_fixture().root(true).await;
    assert!(review_fixture(&library, &foreign).is_err());
    assert!(apply_fixture(&library, &foreign, &applied.review.expected_plan).is_err());
    observer
        .execute(
            "UPDATE definition_publisher_authority SET trusted_root_json='{}'",
            [],
        )
        .unwrap();
    let corrupt_version = data_version(&observer);
    assert!(review_fixture(&library, &root).is_err());
    assert!(apply_fixture(&library, &root, &applied.review.expected_plan).is_err());
    assert_eq!(data_version(&observer), corrupt_version);
}

#[tokio::test]
async fn bootstrap_does_not_reset_admissions_floors_or_missing_launch_baselines() {
    let fixture = separated_fixture();
    let key = Key::new(fixture._directory.path());
    let root = fixture.root_with_protected_delegation(true, true).await;
    let (_directory, library) = library();
    let bootstrap = review_fixture(&library, &root).unwrap();
    apply_fixture(&library, &root, &bootstrap.expected_plan).unwrap();
    let published = publish(&fixture, &key, 1, &managed_github(1)).await;
    assert_eq!(root, published);
    let accepted = acquire_policy(&fixture, &root, ID).await.unwrap();
    let candidate = acquire(&fixture, &root).await.unwrap();
    library
        .apply_definition_publisher_policy(&accepted, Some(&candidate))
        .unwrap();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    let established = review_fixture(&library, &root).unwrap();
    assert!(established.installed);
    assert!(apply_fixture(&library, &root, &bootstrap.expected_plan).is_err());
    assert!(
        !apply_fixture(&library, &root, &established.expected_plan)
            .unwrap()
            .changed
    );
    assert_eq!(data_version(&observer), before);
    observer
        .execute(
            "UPDATE definition_publisher_admission SET launch_assessment_revision=1",
            [],
        )
        .unwrap();
    assert!(review_fixture(&library, &root).is_err());
    assert!(apply_fixture(&library, &root, &established.expected_plan).is_err());
    observer
        .execute(
            "UPDATE definition_publisher_admission SET launch_assessment_revision=0",
            [],
        )
        .unwrap();
    observer
        .execute("DELETE FROM definition_publisher_admission", [])
        .unwrap();
    assert!(review_fixture(&library, &root).is_err());
    assert!(apply_fixture(&library, &root, &established.expected_plan).is_err());
}

#[tokio::test]
async fn malformed_unseparated_or_unsigned_roots_are_refused_without_writes() {
    let fixture = separated_fixture();
    let root = fixture.root(true).await;
    let weak = RepositoryFixture::new().root(true).await;
    let (_directory, library) = library();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    let mut unsigned: Value = serde_json::from_slice(&root).unwrap();
    unsigned["signatures"] = serde_json::json!([]);
    let unsigned = serde_json::to_vec(&unsigned).unwrap();
    let mut wrong_quorum: Value = serde_json::from_slice(&root).unwrap();
    wrong_quorum["signed"]["roles"]["root"]["threshold"] = serde_json::json!(1);
    let wrong_quorum = serde_json::to_vec(&wrong_quorum).unwrap();
    for invalid in [
        b"{}".as_slice(),
        b"",
        &vec![b' '; 1024 * 1024 + 1],
        &weak,
        &unsigned,
        &wrong_quorum,
    ] {
        assert!(review_fixture(&library, invalid).is_err());
        assert!(apply_fixture(&library, invalid, &"0".repeat(64)).is_err());
    }
    assert_eq!(data_version(&observer), before);
}

#[tokio::test]
async fn valid_retained_launch_hold_survives_superseding_grant_and_refuses_loss() {
    let fixture = separated_fixture();
    let key = Key::new(fixture._directory.path());
    let root = fixture.root(true).await;
    let (_directory, library) = library();
    let review = review_fixture(&library, &root).unwrap();
    apply_fixture(&library, &root, &review.expected_plan).unwrap();
    let mut grant = managed_github(1);
    grant["policy_schema"] = 3.into();
    grant["decision"]["scoped_launch_checks"] = 1.into();
    publish(&fixture, &key, 1, &grant).await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let policy = acquire_policy(&fixture, &root, ID).await.unwrap();
    library
        .apply_definition_publisher_policy(&policy, Some(&candidate))
        .unwrap();
    let grant_bytes = serde_json::to_vec(&grant).unwrap();
    let mut targets = metadata_targets();
    targets.push((format!("policy/official/{ID}.json"), grant_bytes.clone()));
    let document = super::launch_assessments::assessment_document(
        &hex::encode(Sha256::digest(&grant_bytes)),
        1,
        vec![serde_json::json!({
            "subject": {"version":"v1", "channel":"stable", "platform":crate::Platform::current().unwrap(),
                "artifact":{"asset_name":"ordinary.zip","sha256":"c".repeat(64),"size":42},"operation":"launch"},
            "check_id":"launch-integrity","check_input_sha256":"a".repeat(64),"revision":1,
            "decision":{"status":"held","failure_sha256":"b".repeat(64)}
        })],
    );
    let assessment = super::launch_assessments::publish_assessment_for_targets(
        &fixture, &key, &root, targets, 2, &document,
    )
    .await
    .unwrap();
    library
        .apply_definition_launch_assessment(&assessment)
        .unwrap();
    let observer = library.connection().unwrap();
    let before = data_version(&observer);
    let held = review_fixture(&library, &root).unwrap();
    assert!(
        !apply_fixture(&library, &root, &held.expected_plan)
            .unwrap()
            .changed
    );
    assert_eq!(data_version(&observer), before);
    grant["policy_revision"] = 2.into();
    publish(&fixture, &key, 3, &grant).await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let policy = acquire_policy(&fixture, &root, ID).await.unwrap();
    library
        .apply_definition_publisher_policy(&policy, Some(&candidate))
        .unwrap();
    let advanced = review_fixture(&library, &root).unwrap();
    assert_ne!(held.expected_plan, advanced.expected_plan);
    assert!(apply_fixture(&library, &root, &held.expected_plan).is_err());
    let before = data_version(&observer);
    assert!(
        !apply_fixture(&library, &root, &advanced.expected_plan)
            .unwrap()
            .changed
    );
    assert_eq!(data_version(&observer), before);
    let baseline: (String,String,String) = observer.query_row(
        "SELECT document_json,provenance_json,inventory_sha256 FROM definition_launch_assessments", [],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).unwrap();
    observer
        .execute("DELETE FROM definition_launch_assessments", [])
        .unwrap();
    assert!(review_fixture(&library, &root).is_err());
    assert!(apply_fixture(&library, &root, &advanced.expected_plan).is_err());
    // Restore only the exact test preimage to isolate decision-loss refusal.
    observer.execute("INSERT INTO definition_launch_assessments(namespace,stable_id,document_json,provenance_json,inventory_sha256) VALUES('official',?1,?2,?3,?4)",
        rusqlite::params![ID,baseline.0,baseline.1,baseline.2]).unwrap();
    assert_eq!(
        review_fixture(&library, &root).unwrap().expected_plan,
        advanced.expected_plan
    );
    observer
        .execute("DELETE FROM definition_launch_decisions", [])
        .unwrap();
    assert!(review_fixture(&library, &root).is_err());
    assert!(apply_fixture(&library, &root, &advanced.expected_plan).is_err());
}
