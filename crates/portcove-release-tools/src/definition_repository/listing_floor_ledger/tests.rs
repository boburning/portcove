use super::*;

fn entry(policy_version: u64, target: &str, body: &[u8], revision: u64) -> Entry {
    Entry {
        policy_version,
        target: target.into(),
        sha256: sha(body),
        length: body.len() as u64,
        revision,
        decoded_sha256: sha(body),
        withdrawn_ids_count: 0,
        withdrawn_ids_sha256: withdrawn_digest(&BTreeSet::new()),
    }
}

fn ledger(entries: Vec<Entry>) -> Ledger {
    let mut recorder = Recorder::default();
    for entry in entries {
        recorder.reference(&entry.target, &entry.sha256, Some(entry.policy_version));
        recorder.facts(entry, true);
    }
    recorder.ledger().unwrap().0
}

#[test]
fn canonical_encoding_round_trips_and_refuses_any_other_spelling() {
    let target = portcove_listing_carrier::LEGACY_TARGET;
    let value = ledger(vec![
        entry(2, target, b"two", 2),
        entry(1, target, b"one", 1),
    ]);
    // Canonical order is by first policy version, whatever the recording order.
    assert_eq!(value.entries()[0].policy_version, 1);
    let bytes = value.encode().unwrap();
    assert_eq!(Ledger::parse(&bytes).unwrap(), value);
    let mut document: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(document["kind"], "catalog-listing-floor-ledger");
    assert!(Ledger::parse(&serde_json::to_vec(&document).unwrap()).is_err());
    document["entries"].as_array_mut().unwrap().reverse();
    let reordered = io::canonical(&serde_json::to_vec(&document).unwrap()).unwrap();
    assert!(Ledger::parse(&reordered).is_err());
    document["entries"].as_array_mut().unwrap().reverse();
    document["entries"][0]["extra"] = serde_json::json!(true);
    let extra = io::canonical(&serde_json::to_vec(&document).unwrap()).unwrap();
    assert!(Ledger::parse(&extra).is_err());
}

#[test]
fn malformed_entries_and_repeated_bodies_are_refused() {
    let target = portcove_listing_carrier::LEGACY_TARGET;
    let good = entry(1, target, b"one", 1);
    for change in [
        (|e: &mut Entry| e.policy_version = 0) as fn(&mut Entry),
        |e| e.target = "policy/official/other.json".into(),
        |e| e.sha256 = "A".repeat(64),
        |e| e.length = 0,
        |e| e.revision = 0,
        |e| e.decoded_sha256 = "0".repeat(64),
        |e| e.withdrawn_ids_sha256 = "0".repeat(64),
        |e| e.withdrawn_ids_count = 10_001,
    ] {
        let mut bad = good.clone();
        change(&mut bad);
        assert!(Ledger::from_entries(vec![bad]).is_err());
    }
    let mut again = good.clone();
    again.policy_version = 2;
    assert!(Ledger::from_entries(vec![good, again]).is_err());
}

#[test]
fn a_ledger_only_ever_extends_its_predecessor() {
    let target = portcove_listing_carrier::LEGACY_TARGET;
    let prior = ledger(vec![entry(1, target, b"one", 1)]);
    let next = ledger(vec![
        entry(1, target, b"one", 1),
        entry(2, target, b"two", 2),
    ]);
    assert!(next.extends(&prior));
    assert!(!prior.extends(&next));
    let changed = ledger(vec![
        entry(1, target, b"one", 3),
        entry(2, target, b"two", 2),
    ]);
    assert!(!changed.extends(&prior));
    let mut recorder = Recorder::default();
    recorder.reference(target, &sha(b"one"), Some(1));
    recorder.facts(entry(1, target, b"one", 3), true);
    assert!(
        next_ledger_error(&recorder, &prior).contains("does not extend its published predecessor")
    );
}

fn next_ledger_error(recorder: &Recorder, prior: &Ledger) -> String {
    next(recorder, Some(prior)).unwrap_err().to_string()
}

#[test]
fn every_named_body_needs_facts_and_a_policy_version() {
    let mut recorder = Recorder::default();
    recorder.reference(portcove_listing_carrier::LEGACY_TARGET, &sha(b"x"), Some(1));
    assert!(recorder.ledger().is_err());
    let mut recorder = Recorder::default();
    recorder.facts(
        entry(1, portcove_listing_carrier::LEGACY_TARGET, b"x", 1),
        true,
    );
    assert!(recorder.ledger().is_err());
}
