//! T-LEDGER (#1422): history verification over a simulated history of
//! thousands of publications gives identical outcomes whether every listing
//! body is served or only the window plus the listing-floor ledger.
use super::*;
use crate::definition_repository::history_checkpoint::{ListingFloor, check_listings};
use crate::definition_repository::listing_floor_ledger::{Entry, Recorder, withdrawn_digest};
use portcove_listing_carrier::{COMPACT_TARGET, LEGACY_TARGET};
use serde_json::json;

const PUBLICATIONS: u64 = 3_000;

fn legacy(revision: u64, withdrawn: &[String], label: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "listing_delivery_schema": 1,
        "revision": revision,
        "withdrawn_ids": withdrawn,
        "directory": {"format_version": 11, "listings": [{"id": "row", "name": label}]},
    }))
    .unwrap()
}

/// A compact carrier of the legacy document, as compact activation requires:
/// at a shared revision both carriers decode to the same bytes.
fn compact(revision: u64, withdrawn: &[String], label: &str, level: u32) -> Vec<u8> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use flate2::write::GzEncoder;
    use std::io::Write as _;
    let decoded = legacy(revision, withdrawn, label);
    let mut gzip = GzEncoder::new(Vec::new(), flate2::Compression::new(level));
    gzip.write_all(&decoded).unwrap();
    serde_json::to_vec(&json!({
        "carrier": portcove_listing_carrier::COMPACT_CARRIER,
        "decoded_bytes": decoded.len(),
        "decoded_sha256": sha(&decoded),
        "gzip_base64": STANDARD.encode(gzip.finish().unwrap()),
    }))
    .unwrap()
}

/// One signed `official-policy` version: the listing bodies it names.
#[derive(Clone)]
struct Publication {
    version: u64,
    bodies: Vec<(&'static str, Vec<u8>)>,
}

/// Legacy only, then compact beside legacy (activation), then compact only
/// (the cutover). A listing change roughly every third publication, the rest
/// renewals; one withdrawal; compact re-encodings at an unchanged revision.
fn history() -> Vec<Publication> {
    carriers(false, 1)
}

/// The same history, except that after version 2,500 compact is withdrawn
/// and legacy alone continues (a legacy-only return).
fn legacy_return() -> Vec<Publication> {
    carriers(true, 2)
}

/// `step` spaces listing revisions; a gap leaves unused lower revisions that
/// a forged ledger entry could claim without equivocating.
fn carriers(legacy_returns: bool, step: u64) -> Vec<Publication> {
    let legacy_named = |version: u64| version <= 2_500 || legacy_returns;
    let compact_named = |version: u64| version > 1_500 && (version <= 2_500 || !legacy_returns);
    let mut publications = Vec::new();
    let mut revision = 1;
    let mut withdrawn: Vec<String> = Vec::new();
    let mut legacy_body = legacy(revision, &withdrawn, "r1");
    let mut compact_body: Option<Vec<u8>> = None;
    for version in 1..=PUBLICATIONS {
        let changed = version % 3 == 0;
        if version == 1_200 {
            withdrawn.push("withdrawn-row".into());
        }
        if changed || version == 1_200 {
            revision += step;
            let label = format!("r{revision}");
            if legacy_named(version) {
                legacy_body = legacy(revision, &withdrawn, &label);
            }
            if compact_named(version) {
                compact_body = Some(compact(revision, &withdrawn, &label, 6));
            }
        } else if version == 1_501 {
            // Compact activation beside legacy at a new shared revision.
            revision += step;
            legacy_body = legacy(revision, &withdrawn, &format!("r{revision}"));
            compact_body = Some(compact(revision, &withdrawn, &format!("r{revision}"), 6));
        } else if version % 97 == 0
            && let Some(body) = compact_body.as_mut()
        {
            // Same decoded document, different bytes: equal revision, same floor.
            *body = compact(revision, &withdrawn, &format!("r{revision}"), 9);
        }
        let mut bodies = Vec::new();
        if legacy_named(version) {
            bodies.push((LEGACY_TARGET, legacy_body.clone()));
        }
        if compact_named(version)
            && let Some(body) = &compact_body
        {
            bodies.push((COMPACT_TARGET, body.clone()));
        }
        publications.push(Publication { version, bodies });
    }
    publications
}

fn descriptor(publication: &Publication) -> Targets {
    let targets = publication
        .bodies
        .iter()
        .map(|(target, body)| {
            (
                (*target).to_owned(),
                json!({"length": body.len(), "hashes": {"sha256": sha(body)}}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    serde_json::from_value(json!({
        "_type": "targets",
        "spec_version": "1.0.0",
        "version": publication.version,
        "expires": "2030-01-01T00:00:00Z",
        "targets": targets,
    }))
    .unwrap()
}

fn tree(publications: &[Publication], served: impl Fn(&str, &[u8]) -> bool) -> PublicHistory {
    let mut files = PublicHistory::default();
    for publication in publications {
        for (target, body) in &publication.bodies {
            if served(target, body) {
                files.insert(public_target_path(target, body).unwrap(), body);
            }
        }
    }
    files
}

/// What every later check consumes. Equal summaries mean equal outcomes.
#[derive(Debug, PartialEq, Eq)]
struct Outcome {
    listing_revisions: BTreeMap<u64, String>,
    legacy: Option<(ListingFloor, Vec<u8>)>,
    compact: Option<ListingFloor>,
    ledger: Vec<u8>,
}

/// `verify_history`'s traversal: metadata file names in lexical order.
fn verify(
    publications: &[Publication],
    files: &PublicHistory,
    ledger: Option<&Ledger>,
) -> Result<(Outcome, HistoricalRevisionFloors)> {
    let mut floors = HistoricalRevisionFloors {
        ledger: ledger.cloned(),
        ..Default::default()
    };
    let mut ordered = publications.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|publication| {
        format!("metadata/{}.official-policy.json", publication.version)
    });
    let current = AuthenticatedTargets::default();
    for publication in ordered {
        floors.observe(
            files,
            &current,
            "official-policy.json",
            publication.version,
            &descriptor(publication),
        )?;
    }
    floors.check_ledger_floors()?;
    let (ledger, _) = listing_floor_ledger::next(&floors.recorder, ledger)?;
    Ok((
        Outcome {
            listing_revisions: floors.listing_revisions.clone(),
            legacy: floors.legacy_listing.clone(),
            compact: floors.compact_listing.clone(),
            ledger,
        },
        floors,
    ))
}

fn listings(floors: &HistoricalRevisionFloors, proposal: &[(&str, Vec<u8>)]) -> Result<()> {
    let proposal = proposal
        .iter()
        .map(|(target, body)| ((*target).to_owned(), body.clone()))
        .collect::<Files>();
    check_listings(
        &proposal,
        floors
            .legacy_listing
            .as_ref()
            .map(|(floor, body)| (floor, body.as_slice())),
        floors.compact_listing.as_ref(),
    )
}

/// The minimum the verifier needs: the newest body of each listing target.
fn newest_only(publications: &[Publication]) -> BTreeSet<(String, String)> {
    let mut newest = BTreeMap::<&str, (u64, String)>::new();
    for publication in publications {
        for (target, body) in &publication.bodies {
            let revision = bundle::listing_revision(target, body).unwrap().revision;
            let slot = newest.entry(target).or_insert((0, String::new()));
            if revision > slot.0 {
                *slot = (revision, sha(body));
            }
        }
    }
    newest
        .into_iter()
        .map(|(target, (_, digest))| (target.to_owned(), digest))
        .collect()
}

/// Which bodies a simulated served tree keeps.
type Served<'a> = Box<dyn Fn(&str, &[u8]) -> bool + 'a>;

fn message<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("expected a refusal"),
        Err(error) => error.to_string(),
    }
}

#[test]
fn ledger_and_window_verify_thousands_of_publications_identically() {
    let publications = history();
    let complete = tree(&publications, |_, _| true);
    let (all, all_floors) = verify(&publications, &complete, None).unwrap();
    let backfill = Ledger::parse(&all.ledger).unwrap();
    // One entry per distinct body, every one derived from bytes.
    assert_eq!(backfill.len(), complete.len());
    assert!(backfill.len() > 1_000, "{}", backfill.len());

    let keep = newest_only(&publications);
    let window = tree(&publications, |target, body| {
        keep.contains(&(target.to_owned(), sha(body)))
    });
    assert_eq!(window.len(), 2);
    // Without the ledger a pruned body stops verification, exactly as today.
    assert!(
        message(verify(&publications, &window, None)).contains("public repository file missing")
    );
    let (pruned, pruned_floors) = verify(&publications, &window, Some(&backfill)).unwrap();
    assert_eq!(pruned, all);

    // A revision bump with every withdrawal is admitted identically in both
    // modes, whether the rules in force need the last legacy bytes beside
    // compact (before the #8619 cutover) or compact alone (after it).
    let withdrawn = vec!["withdrawn-row".to_owned()];
    let floor = all.compact.as_ref().unwrap().revision;
    let (_, last_legacy) = all.legacy.clone().unwrap();
    let next = compact(floor + 1, &withdrawn, "next", 6);
    let mut admitted = 0;
    for proposal in [
        vec![(COMPACT_TARGET, next.clone())],
        vec![(LEGACY_TARGET, last_legacy), (COMPACT_TARGET, next)],
    ] {
        let a = listings(&all_floors, &proposal).map_err(|error| error.to_string());
        assert_eq!(
            a,
            listings(&pruned_floors, &proposal).map_err(|e| e.to_string())
        );
        admitted += usize::from(a.is_ok());
    }
    assert!(admitted > 0);
    // Rollback, equal-revision replacement, a forgotten withdrawal and a
    // legacy return below the compact floor: refused identically.
    for proposal in [
        vec![(COMPACT_TARGET, compact(floor - 1, &withdrawn, "old", 6))],
        vec![(COMPACT_TARGET, compact(floor, &withdrawn, "other", 6))],
        vec![(COMPACT_TARGET, compact(floor + 1, &[], "forgot", 6))],
        vec![(LEGACY_TARGET, legacy(floor, &withdrawn, "return"))],
    ] {
        let a = message(listings(&all_floors, &proposal));
        let b = message(listings(&pruned_floors, &proposal));
        assert_eq!(a, b);
    }
    // The same proposals with the retained legacy bytes beside them.
    let (_, last_legacy) = all.legacy.clone().unwrap();
    for (revision, ids, label) in [
        (floor - 1, withdrawn.clone(), "old"),
        (floor, withdrawn.clone(), "other"),
        (floor + 1, vec![], "forgot"),
    ] {
        let proposal = vec![
            (LEGACY_TARGET, last_legacy.clone()),
            (COMPACT_TARGET, compact(revision, &ids, label, 6)),
        ];
        assert_eq!(
            message(listings(&all_floors, &proposal)),
            message(listings(&pruned_floors, &proposal))
        );
    }
}

#[test]
fn historical_equivocation_is_refused_with_or_without_its_bodies() {
    let mut publications = history();
    // An equivocating signed body: an old revision with different content.
    let target = publications[999].bodies[0].0;
    let original = bundle::listing_revision(target, &publications[999].bodies[0].1).unwrap();
    let forged = legacy(original.revision, &[], "equivocation");
    publications[1_099].bodies[0] = (target, forged.clone());
    // The honest record of every body's facts, as if each had been read.
    let mut recorder = Recorder::default();
    for publication in &publications {
        for (target, body) in &publication.bodies {
            let facts = bundle::listing_revision(target, body).unwrap();
            recorder.reference(target, &sha(body), Some(publication.version));
            recorder.facts(
                Entry {
                    policy_version: publication.version,
                    target: (*target).into(),
                    sha256: sha(body),
                    length: body.len() as u64,
                    revision: facts.revision,
                    decoded_sha256: facts.decoded_sha256,
                    withdrawn_ids_count: facts.withdrawn_ids.len() as u64,
                    withdrawn_ids_sha256: withdrawn_digest(&facts.withdrawn_ids),
                },
                true,
            );
        }
    }
    let ledger = recorder.ledger().unwrap().0;
    let keep = newest_only(&publications);
    let modes: [(&str, Served<'_>); 3] = [
        ("all bodies", Box::new(|_, _| true)),
        (
            "forgery served",
            Box::new(|_, body| body == forged.as_slice()),
        ),
        (
            "window only",
            Box::new(|target, body| keep.contains(&(target.to_owned(), sha(body)))),
        ),
    ];
    for (mode, served) in modes {
        let files = tree(&publications, served);
        let failure = message(verify(&publications, &files, Some(&ledger)));
        assert!(failure.contains("history equivocates"), "{mode}: {failure}");
    }
}

#[test]
fn falsified_or_incomplete_ledgers_fail_closed_or_cannot_lower_a_floor() {
    let publications = history();
    let complete = tree(&publications, |_, _| true);
    let (all, _) = verify(&publications, &complete, None).unwrap();
    let ledger = Ledger::parse(&all.ledger).unwrap();
    let keep = newest_only(&publications);
    let window = tree(&publications, |target, body| {
        keep.contains(&(target.to_owned(), sha(body)))
    });
    let edit = |change: &dyn Fn(&mut Vec<Entry>)| {
        let mut entries = ledger.entries().to_vec();
        change(&mut entries);
        let mut recorder = Recorder::default();
        for entry in entries {
            recorder.reference(&entry.target, &entry.sha256, Some(entry.policy_version));
            recorder.facts(entry, true);
        }
        recorder.ledger().unwrap().0
    };

    // A dropped entry: the pruned body is simply missing.
    let dropped = edit(&|entries| {
        entries.remove(10);
    });
    assert!(message(verify(&publications, &window, Some(&dropped))).contains("file missing"));
    // An entry without a signed descriptor never extends into the next ledger.
    let extra = edit(&|entries| {
        let mut entry = entries[0].clone();
        entry.sha256 = "0".repeat(64);
        entry.decoded_sha256 = "0".repeat(64);
        entries.push(entry);
    });
    assert!(message(verify(&publications, &window, Some(&extra))).contains("does not extend"),);
    // A length that differs from the signed descriptor.
    let length = edit(&|entries| entries[10].length += 1);
    assert!(
        message(verify(&publications, &window, Some(&length)))
            .contains("historical target identity/bound differs")
    );
    // A changed fact is caught while its body is still served.
    // A pruned compact entry rewritten to an older, consistent revision.
    let first_compact = ledger
        .entries()
        .iter()
        .position(|entry| entry.target == COMPACT_TARGET)
        .unwrap();
    let lowered = edit(&|entries| {
        entries[first_compact].revision = entries[0].revision;
        entries[first_compact].decoded_sha256 = entries[0].decoded_sha256.clone();
    });
    assert!(message(verify(&publications, &complete, Some(&lowered))).contains("does not extend"));
    // Once pruned, a lowered entry cannot lower any floor: the newest bodies
    // are served and set every floor.
    let (outcome, _) = verify(&publications, &window, Some(&lowered)).unwrap();
    assert_eq!(
        (&outcome.legacy, &outcome.compact),
        (&all.legacy, &all.compact)
    );
    // A pruned entry raised above the served floor fails closed.
    let raised = edit(&|entries| entries[10].revision = 1_000_000);
    assert!(
        message(verify(&publications, &window, Some(&raised)))
            .contains("newest listing body is outside the served tree")
    );
    // Pruning the newest body itself fails closed even with its entry: it is
    // also the body the latest signed policy version names.
    let without_newest = tree(&publications, |_, _| false);
    assert!(
        message(verify(&publications, &without_newest, Some(&ledger)))
            .contains("body is outside the served tree")
    );
}

/// Distinct bodies of one target, oldest first, with their facts.
fn bodies_of(publications: &[Publication], target: &str) -> Vec<(Vec<u8>, u64, String)> {
    let mut bodies: Vec<(Vec<u8>, u64, String)> = Vec::new();
    for publication in publications {
        for (named, body) in &publication.bodies {
            if *named == target && bodies.last().is_none_or(|(last, _, _)| last != body) {
                let facts = bundle::listing_revision(target, body).unwrap();
                bodies.push((body.clone(), facts.revision, facts.decoded_sha256));
            }
        }
    }
    bodies
}

/// F1: a writer without a signing key deletes the newest body of a listing
/// target that is no longer current, serves an older body still named by
/// signed metadata, and lowers the deleted body's ledger entry to that older
/// body's facts so every unsigned floor stays consistent. The body the latest
/// signed policy version names must be served, so the attack is refused; the
/// honest window that serves it still prunes everything else.
fn latest_named_body_is_required(publications: &[Publication], stale: &str, current: &str) {
    let complete = tree(publications, |_, _| true);
    let (all, _) = verify(publications, &complete, None).unwrap();
    let ledger = Ledger::parse(&all.ledger).unwrap();
    // The target that is no longer current: its last body is its latest named.
    let last = publications.last().unwrap();
    assert!(last.bodies.iter().all(|(target, _)| *target != stale));
    assert!(last.bodies.iter().any(|(target, _)| *target == current));
    let stale_bodies = bodies_of(publications, stale);
    let (newest, newest_revision, _) = stale_bodies.last().unwrap().clone();
    // Compact re-encodings share a revision; the older body has a lower one.
    let (older, older_revision, _) = stale_bodies
        .iter()
        .rev()
        .find(|(_, revision, _)| *revision < newest_revision)
        .unwrap()
        .clone();
    // A lower revision no body uses, so the forged entry cannot equivocate.
    let forged_revision = older_revision - 1;
    assert!(!all.listing_revisions.contains_key(&forged_revision));
    let current_newest = bodies_of(publications, current).pop().unwrap().0;

    // Positive: only the latest named bodies (plus an older pinned body) are
    // served; every other body is pruned and verified from the ledger.
    let honest = tree(publications, |_, body| {
        body == newest.as_slice() || body == older.as_slice() || body == current_newest.as_slice()
    });
    assert_eq!(honest.len(), 3);
    let (outcome, _) = verify(publications, &honest, Some(&ledger)).unwrap();
    assert_eq!(outcome, all);

    // The attack: the newest stale body is deleted and its entry lowered.
    let attacked = tree(publications, |_, body| {
        body == older.as_slice() || body == current_newest.as_slice()
    });
    let mut recorder = Recorder::default();
    for mut entry in ledger.entries().iter().cloned() {
        if entry.target == stale && entry.sha256 == sha(&newest) {
            entry.revision = forged_revision;
        }
        recorder.reference(&entry.target, &entry.sha256, Some(entry.policy_version));
        recorder.facts(entry, true);
    }
    let lowered = recorder.ledger().unwrap().0;
    let failure = message(verify(publications, &attacked, Some(&lowered)));
    assert!(
        failure.contains(&format!(
            "latest signed {stale} body is outside the served tree"
        )),
        "{failure}"
    );
    // Also refused with the honest ledger: the latest named body is required.
    let failure = message(verify(publications, &attacked, Some(&ledger)));
    assert!(
        failure.contains("body is outside the served tree"),
        "{failure}"
    );
}

#[test]
fn a_lowered_entry_cannot_replace_the_latest_legacy_body_after_the_cutover() {
    latest_named_body_is_required(&carriers(false, 2), LEGACY_TARGET, COMPACT_TARGET);
}

#[test]
fn a_lowered_entry_cannot_replace_the_latest_compact_body_after_a_legacy_return() {
    latest_named_body_is_required(&legacy_return(), COMPACT_TARGET, LEGACY_TARGET);
}
