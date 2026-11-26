//! T-LEDGER end to end: signed fixture publications maintain the ledger, and
//! a prior whose old listing body is pruned still advances only with it.
use super::*;

fn advance(fixture: &mut Fixture, previous: &str, version: u64, ledger: Option<Option<&str>>) {
    let mut context = fixture.context_value();
    context["previous_repository"] = json!(previous);
    for role in ["definitions", "policy", "snapshot", "timestamp"] {
        context["versions"][role] = json!(version);
    }
    match ledger {
        Some(prior) => context["listing_floor_ledger"] = json!({ "prior": prior }),
        None => {
            context
                .as_object_mut()
                .unwrap()
                .remove("listing_floor_ledger");
        }
    }
    fixture.set_context(context);
    fixture.roles = fixture.root().join(format!("roles-{version}"));
    fs::create_dir_all(&fixture.roles).unwrap();
}

async fn publish(
    fixture: &Fixture,
    output: &str,
    ledger: Option<&str>,
) -> DefinitionRepositoryReport {
    fixture.sign_all().await;
    let mut config = json!({"schema_version":1,"context":"context.json","signed_roles":fixture.roles.file_name().unwrap().to_str().unwrap(),"output":output});
    if let Some(ledger) = ledger {
        config["listing_floor_ledger_output"] = json!(ledger);
    }
    let path = json_file(fixture.root(), &format!("assembly-{output}.json"), config);
    assemble_definition_repository(&path).await.unwrap()
}

fn listing_body(repository: &Path, bytes_of_revision: &[u8]) -> PathBuf {
    repository.join(format!(
        "targets/{}.{}",
        sha(bytes_of_revision),
        portcove_listing_carrier::LEGACY_TARGET
    ))
}

fn copy_tree(from: &Path, to: &Path) {
    for file in io::inventory(from, 4096, 64 * 1024 * 1024).unwrap() {
        let destination = to.join(&file.target);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(from.join(&file.target), destination).unwrap();
    }
}

async fn history(fixture: &Fixture, repository: &str, ledger: Option<&str>) -> serde_json::Value {
    let root = fs::read(fixture.root().join("root.json")).unwrap();
    let top = fs::read(fixture.root().join("targets.json")).unwrap();
    let mut config = json!({"schema_version":1,"trusted_root":"root.json","trusted_root_sha256":sha(&root),"offline_targets":"targets.json","offline_targets_sha256":sha(&top),"repository":repository});
    if let Some(ledger) = ledger {
        config["listing_floor_ledger"] = json!({ "prior": ledger });
    }
    let path = json_file(
        fixture.root(),
        &format!("history-{repository}.json"),
        config,
    );
    let mut report = serde_json::to_value(verify_definition_history(&path).await.unwrap()).unwrap();
    report
        .as_object_mut()
        .unwrap()
        .remove("listing_floor_ledger");
    report
        .as_object_mut()
        .unwrap()
        .remove("listing_bodies_served");
    report
}

#[tokio::test]
async fn publications_maintain_the_ledger_and_advance_over_a_pruned_prior_only_with_it() {
    let mut fixture = Fixture::new().await;
    let listing = fixture
        .root()
        .join("bundle")
        .join(portcove_listing_carrier::LEGACY_TARGET);
    replace_listing_directory(&fixture, 1);
    let first = fs::read(&listing).unwrap();
    let report = publish(&fixture, "p1", None).await;
    assert!(report.listing_floor_ledger.is_none());

    // A ledger needs a complete retained prior and no history checkpoint.
    advance(&mut fixture, "p1", 2, Some(None));
    let mut context = fixture.context_value();
    context["bootstrap_history"] = json!(true);
    fixture.set_context(context);
    let failure = load_context(&fixture.context)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        failure.contains("needs a complete retained prior"),
        "{failure}"
    );
    let mut context = fixture.context_value();
    context.as_object_mut().unwrap().remove("bootstrap_history");
    fixture.set_context(context);

    // The one-time backfill reads every retained body.
    advance(&mut fixture, "p1", 2, Some(None));
    replace_listing_directory(&fixture, 2);
    let second = fs::read(&listing).unwrap();
    let report = publish(&fixture, "p2", Some("ledger-2.json")).await;
    let ledger = report.listing_floor_ledger.unwrap();
    assert_eq!(
        (
            ledger.entries,
            ledger.prior_entries,
            ledger.verified_from_bodies
        ),
        (1, 0, 1)
    );
    let ledger_2 = fs::read(fixture.root().join("ledger-2.json")).unwrap();
    assert_eq!(sha(&ledger_2), ledger.sha256);

    advance(&mut fixture, "p2", 3, Some(Some("ledger-2.json")));
    replace_listing_directory(&fixture, 3);
    let third = fs::read(&listing).unwrap();
    let report = publish(&fixture, "p3", Some("ledger-3.json")).await;
    let ledger = report.listing_floor_ledger.unwrap();
    assert_eq!((ledger.entries, ledger.prior_entries), (2, 1));
    let ledger_3 = fs::read(fixture.root().join("ledger-3.json")).unwrap();
    assert!(ledger_3.len() > ledger_2.len());

    // Prune the oldest body from a copy of the published prior.
    let p3 = fixture.root().join("p3");
    let pruned = fixture.root().join("p3-pruned");
    copy_tree(&p3, &pruned);
    fs::remove_file(listing_body(&pruned, &first)).unwrap();
    assert!(listing_body(&pruned, &second).exists() && listing_body(&pruned, &third).exists());

    // History verification is identical with the body or with its entry.
    let complete = history(&fixture, "p3", None).await;
    assert_eq!(
        history(&fixture, "p3-pruned", Some("ledger-3.json")).await,
        complete
    );
    assert_eq!(
        history(&fixture, "p3", Some("ledger-3.json")).await,
        complete
    );

    // Without the ledger the pruned prior stops publication, exactly as today.
    advance(&mut fixture, "p3-pruned", 4, None);
    let failure = load_context(&fixture.context)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        failure.contains("public repository file missing"),
        "{failure}"
    );
    // A ledger that does not cover the pruned body is no help either.
    advance(&mut fixture, "p3-pruned", 4, Some(None));
    let failure = load_context(&fixture.context)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        failure.contains("public repository file missing"),
        "{failure}"
    );

    advance(&mut fixture, "p3-pruned", 4, Some(Some("ledger-3.json")));
    replace_listing_directory(&fixture, 4);
    let report = publish(&fixture, "p4", Some("ledger-4.json")).await;
    let ledger = report.listing_floor_ledger.unwrap();
    assert_eq!(
        (
            ledger.entries,
            ledger.prior_entries,
            ledger.verified_from_ledger
        ),
        (3, 2, 1)
    );
    // The window still refuses a rollback below the newest served body.
    advance(&mut fixture, "p4", 5, Some(Some("ledger-4.json")));
    replace_listing_directory(&fixture, 2);
    let failure = load_context(&fixture.context)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(failure.contains("rollback"), "{failure}");
}
