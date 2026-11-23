//! Signed-repository coverage for decision schema 2: a decision bound to its
//! subject's exact entry survives unrelated index changes and nothing else.

use super::*;

const SIBLING: &str = "tuf-metadata-sibling";

fn sibling_catalog() -> Catalog {
    let mut document = metadata_catalog().authoritative_document();
    let port = &mut document.ports[0];
    port.id = SIBLING.into();
    port.name = "TUF metadata sibling".into();
    port.project_url = format!("https://example.invalid/{SIBLING}");
    Catalog::from_document(document).unwrap()
}

/// Index and contents for the given `(catalog, id, definition revision)` set.
fn index_targets(subjects: &[(&Catalog, &str, u64)]) -> Vec<(String, Vec<u8>)> {
    let mut index: Option<Value> = None;
    let mut contents = Vec::new();
    for (catalog, id, revision) in subjects {
        let bundle =
            crate::test_fixture::indexed_catalog_bundle_at_revision(catalog, id, *revision);
        let next: Value = serde_json::from_slice(&bundle.index).unwrap();
        match &mut index {
            None => index = Some(next),
            Some(index) => {
                for field in ["definitions", "contents"] {
                    index[field]
                        .as_array_mut()
                        .unwrap()
                        .extend(next[field].as_array().unwrap().iter().cloned());
                }
            }
        }
        contents.extend(bundle.contents);
    }
    contents.push((
        INDEX_TARGET.into(),
        serde_json::to_vec(&index.unwrap()).unwrap(),
    ));
    contents
}

fn decision_for(
    targets: &[(String, Vec<u8>)],
    id: &str,
    policy_revision: u64,
    decision_schema: u32,
) -> Value {
    let bytes = |name: &str| &targets.iter().find(|(target, _)| target == name).unwrap().1;
    let index_bytes = bytes(INDEX_TARGET);
    let index: Value = serde_json::from_slice(index_bytes).unwrap();
    let indexed = index["definitions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["stable_id"] == id)
        .unwrap();
    let entry_bytes = bytes(indexed["target"].as_str().unwrap());
    let entry: Value = serde_json::from_slice(entry_bytes).unwrap();
    let mut document = serde_json::json!({
        "policy_schema": 1,
        "namespace": "official",
        "stable_id": id,
        "policy_revision": policy_revision,
        "grant_id": "protected-fixture-availability",
        "decision": {
            "status": "availability",
            "definition_revision": entry["revision"],
            "index_sha256": hex::encode(Sha256::digest(index_bytes)),
            "definition_sha256": hex::encode(Sha256::digest(entry_bytes)),
            "template": entry["port"]["adapter"],
        },
    });
    if decision_schema == 2 {
        document["decision_schema"] = 2.into();
        document["decision"]
            .as_object_mut()
            .unwrap()
            .remove("index_sha256");
    }
    document
}

async fn publish_set(
    fixture: &RepositoryFixture,
    key: &Key,
    version: u64,
    targets: &[(String, Vec<u8>)],
    policies: &[&Value],
) -> Vec<u8> {
    let mut targets = targets.to_vec();
    for document in policies {
        targets.push((
            format!(
                "policy/official/{}.json",
                document["stable_id"].as_str().unwrap()
            ),
            serde_json::to_vec(document).unwrap(),
        ));
    }
    fixture
        .publish_with_policy(
            &targets,
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((key, version)),
        )
        .await
}

fn selectable(library: &Library, candidate: &crate::AuthenticatedDefinitionCandidate) -> bool {
    library
        .assess_definition_candidate(candidate, "official", ID)
        .ok()
        .and_then(crate::DefinitionCandidateAvailability::into_eligible)
        .is_some_and(|eligible| {
            library
                .select_definition_candidate_fixture(eligible)
                .is_ok()
        })
}

fn retained_selection_loads(library: &Library) -> bool {
    crate::definition_candidate::selection::load_selected_definition_catalog(
        &library.connection().unwrap(),
        &metadata_catalog(),
        now_unix(),
    )
    .is_ok_and(|loaded| loaded.is_some())
}

#[tokio::test]
async fn entry_bound_decision_survives_an_unrelated_addition_unlike_the_global_binding() {
    for decision_schema in [1, 2] {
        let fixture = RepositoryFixture::new();
        let key = Key::new(fixture._directory.path());
        let sibling = sibling_catalog();
        let only = index_targets(&[(&metadata_catalog(), ID, 7)]);
        let subject = decision_for(&only, ID, 1, decision_schema);
        let root = publish_set(&fixture, &key, 1, &only, &[&subject]).await;
        let first = acquire(&fixture, &root).await.unwrap();
        let first_policy = acquire_policy(&fixture, &root, ID).await.unwrap();
        let (_directory, library) = library();
        policy::install_authority_for_test(&library, &root).unwrap();
        assert!(
            library
                .apply_definition_publisher_policy(&first_policy, Some(&first))
                .unwrap()
        );
        assert!(selectable(&library, &first));

        // Add an unrelated subject. The publisher signs only the sibling's
        // policy; the subject's policy target keeps its exact bytes.
        let added = index_targets(&[(&metadata_catalog(), ID, 7), (&sibling, SIBLING, 1)]);
        let sibling_policy = decision_for(&added, SIBLING, 1, decision_schema);
        publish_set(&fixture, &key, 2, &added, &[&subject, &sibling_policy]).await;
        let second = acquire(&fixture, &root).await.unwrap();
        let second_policy = acquire_policy(&fixture, &root, ID).await.unwrap();
        assert_eq!(
            second_policy.target_sha256_for_test(),
            first_policy.target_sha256_for_test()
        );
        assert_ne!(
            second.provenance().index_sha256,
            first.provenance().index_sha256
        );
        let admitted = library.apply_definition_publisher_policy(&second_policy, Some(&second));
        let reselected = selectable(&library, &second);
        if decision_schema == 1 {
            // Without a retained-index rebind of every subject, the global
            // binding refuses an unchanged subject.
            assert!(admitted.is_err());
            assert!(!reselected);
            continue;
        }
        admitted.unwrap();
        assert!(reselected);
        assert!(retained_selection_loads(&library));

        // A stale index below the retained floor still refuses, even though
        // its entry and the decision are unchanged.
        assert!(!selectable(&library, &first));
        // Concurrent publication ordering: the older publication's identical
        // decision bytes cannot be admitted after the newer one.
        assert!(
            library
                .apply_definition_publisher_policy(&first_policy, Some(&first))
                .is_err()
        );

        // Revising the subject's own entry defeats the unchanged decision.
        let revised = index_targets(&[(&metadata_catalog(), ID, 8), (&sibling, SIBLING, 1)]);
        publish_set(&fixture, &key, 3, &revised, &[&subject, &sibling_policy]).await;
        let third = acquire(&fixture, &root).await.unwrap();
        let third_policy = acquire_policy(&fixture, &root, ID).await.unwrap();
        assert!(
            library
                .apply_definition_publisher_policy(&third_policy, Some(&third))
                .is_err()
        );
        assert!(!selectable(&library, &third));
        // Replay against another entry: with the subject's own revision and
        // identity unchanged, only the sibling's entry digest differs.
        let mut replayed = subject.clone();
        replayed["policy_revision"] = 2.into();
        replayed["decision"]["definition_sha256"] =
            decision_for(&added, SIBLING, 1, 2)["decision"]["definition_sha256"].clone();
        let mut honest = subject.clone();
        honest["policy_revision"] = 2.into();
        assert_eq!(
            replayed["decision"]["definition_revision"],
            decision_for(&added, ID, 2, 2)["decision"]["definition_revision"]
        );
        assert_eq!(honest, decision_for(&added, ID, 2, 2));
        publish_set(&fixture, &key, 4, &added, &[&replayed, &sibling_policy]).await;
        let replay = acquire_policy(&fixture, &root, ID).await.unwrap();
        let fourth = acquire(&fixture, &root).await.unwrap();
        assert!(
            library
                .apply_definition_publisher_policy(&replay, Some(&fourth))
                .is_err()
        );
        // Positive control at the same index: the honest digest is admitted.
        publish_set(&fixture, &key, 5, &added, &[&honest, &sibling_policy]).await;
        library
            .apply_definition_publisher_policy(
                &acquire_policy(&fixture, &root, ID).await.unwrap(),
                Some(&acquire(&fixture, &root).await.unwrap()),
            )
            .unwrap();

        // Removing the subject leaves no current entry for its (otherwise
        // current, same-revision) decision.
        let removed = index_targets(&[(&sibling, SIBLING, 1)]);
        publish_set(&fixture, &key, 6, &removed, &[&honest, &sibling_policy]).await;
        let fifth = acquire(&fixture, &root).await.unwrap();
        let fifth_policy = acquire_policy(&fixture, &root, ID).await.unwrap();
        assert!(
            library
                .apply_definition_publisher_policy(&fifth_policy, Some(&fifth))
                .is_err()
        );
        assert!(!selectable(&library, &fifth));
    }
}

#[tokio::test]
async fn equal_version_publication_race_refuses_the_second_body() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let only = index_targets(&[(&metadata_catalog(), ID, 7)]);
    let subject = decision_for(&only, ID, 1, 2);
    let root = publish_set(&fixture, &key, 1, &only, &[&subject]).await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    let initial = acquire_policy(&fixture, &root, ID).await.unwrap();
    library
        .apply_definition_publisher_policy(&initial, Some(&candidate))
        .unwrap();

    // Two writers publish different bodies at the same version. Whichever a
    // client admits first, the other is equivocation, not an exact retry.
    let sibling = sibling_catalog();
    let added = index_targets(&[(&metadata_catalog(), ID, 7), (&sibling, SIBLING, 1)]);
    let sibling_policy = decision_for(&added, SIBLING, 1, 2);
    publish_set(&fixture, &key, 2, &added, &[&subject, &sibling_policy]).await;
    let winner = acquire_policy(&fixture, &root, ID).await.unwrap();
    let winner_candidate = acquire(&fixture, &root).await.unwrap();
    let mut other = sibling_policy.clone();
    other["grant_id"] = "protected-fixture-racing".into();
    publish_set(&fixture, &key, 2, &added, &[&subject, &other]).await;
    let loser = acquire_policy(&fixture, &root, ID).await.unwrap();
    assert_eq!(
        winner.target_sha256_for_test(),
        loser.target_sha256_for_test()
    );
    library
        .apply_definition_publisher_policy(&winner, Some(&winner_candidate))
        .unwrap();
    assert!(
        library
            .apply_definition_publisher_policy(&loser, Some(&winner_candidate))
            .is_err()
    );
}

#[tokio::test]
async fn stored_global_decision_keeps_its_meaning_and_upgrades_to_an_entry_binding() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let only = index_targets(&[(&metadata_catalog(), ID, 7)]);
    let global = decision_for(&only, ID, 1, 1);
    let root = publish_set(&fixture, &key, 1, &only, &[&global]).await;
    let first = acquire(&fixture, &root).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    library
        .apply_definition_publisher_policy(
            &acquire_policy(&fixture, &root, ID).await.unwrap(),
            Some(&first),
        )
        .unwrap();
    assert!(selectable(&library, &first));
    // The stored schema-1 admission row still reads with its exact old bytes.
    let stored: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT policy_json FROM definition_publisher_admission WHERE stable_id=?1",
            [ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored.as_bytes(), serde_json::to_vec(&global).unwrap());
    assert!(retained_selection_loads(&library));

    // Cutover: the publisher re-signs once at a higher policy revision.
    let entry = decision_for(&only, ID, 2, 2);
    publish_set(&fixture, &key, 2, &only, &[&entry]).await;
    let upgraded = acquire(&fixture, &root).await.unwrap();
    assert!(
        library
            .apply_definition_publisher_policy(
                &acquire_policy(&fixture, &root, ID).await.unwrap(),
                Some(&upgraded),
            )
            .unwrap()
    );
    // Like any policy revision change (including a schema-1 rebind), the
    // one-time cutover requires re-selection; the unchanged entry reselects.
    assert!(!retained_selection_loads(&library));
    assert!(selectable(&library, &upgraded));
    assert!(retained_selection_loads(&library));
    // A replayed schema-1 decision at the old revision is refused.
    publish_set(&fixture, &key, 3, &only, &[&global]).await;
    assert!(
        library
            .apply_definition_publisher_policy(
                &acquire_policy(&fixture, &root, ID).await.unwrap(),
                Some(&acquire(&fixture, &root).await.unwrap()),
            )
            .is_err()
    );

    // After the cutover, an unrelated addition needs no change to it.
    let sibling = sibling_catalog();
    let added = index_targets(&[(&metadata_catalog(), ID, 7), (&sibling, SIBLING, 1)]);
    let sibling_policy = decision_for(&added, SIBLING, 1, 2);
    publish_set(&fixture, &key, 4, &added, &[&entry, &sibling_policy]).await;
    let fourth = acquire(&fixture, &root).await.unwrap();
    library
        .apply_definition_publisher_policy(
            &acquire_policy(&fixture, &root, ID).await.unwrap(),
            Some(&fourth),
        )
        .unwrap();
    assert!(selectable(&library, &fourth));
    assert!(retained_selection_loads(&library));
}

#[tokio::test]
async fn newer_decision_schema_refuses_only_its_subject() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let sibling = sibling_catalog();
    let both = index_targets(&[(&metadata_catalog(), ID, 7), (&sibling, SIBLING, 1)]);
    let mut newer = decision_for(&both, ID, 1, 2);
    newer["decision_schema"] = 3.into();
    let sibling_policy = decision_for(&both, SIBLING, 1, 2);
    let root = publish_set(&fixture, &key, 1, &both, &[&newer, &sibling_policy]).await;
    let error = acquire_policy(&fixture, &root, ID).await.unwrap_err();
    assert!(crate::definition_capabilities::requires_newer_engine(
        &error
    ));
    let candidate = acquire(&fixture, &root).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    library
        .apply_definition_publisher_policy(
            &acquire_policy(&fixture, &root, SIBLING).await.unwrap(),
            Some(&candidate),
        )
        .unwrap();
    assert!(
        library
            .assess_definition_candidate(&candidate, "official", SIBLING)
            .unwrap()
            .into_eligible()
            .is_some()
    );
}
