//! Decision schema 1 (global index binding) against decision schema 2 (exact
//! entry binding) over generated index histories.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{PolicyDocument, digest};
use crate::{Catalog, DefinitionContentIndex};

const SUBJECTS: [&str; 4] = ["decision-a", "decision-b", "decision-c", "decision-d"];

fn subject_catalog(id: &str) -> Catalog {
    Catalog::from_json(
        &json!({
            "schema_version": 1,
            "ports": [{
                "id": id,
                "name": "Decision fixture",
                "summary": "Synthetic policy decision fixture",
                "project_url": format!("https://example.invalid/{id}"),
                "support_tier": "beta",
                "channels": ["stable"],
                "platforms": ["linux-x86-64"],
                "adapter": "libultraship-portable",
                "release": {"repository": format!("fixture/{id}")},
                "executable_hints": {"linux-x86-64": ["fixture"]}
            }]
        })
        .to_string(),
    )
    .unwrap()
}

/// One published index: the exact index bytes and every content target.
#[derive(Clone)]
struct Published {
    index: Vec<u8>,
    contents: BTreeMap<String, Vec<u8>>,
}

impl Published {
    fn new(present: &BTreeMap<&'static str, u64>) -> Self {
        let mut definitions = Vec::new();
        let mut records = Vec::new();
        let mut contents = BTreeMap::new();
        for (id, revision) in present {
            let catalog = subject_catalog(id);
            let bundle =
                crate::test_fixture::indexed_catalog_bundle_at_revision(&catalog, id, *revision);
            let index: Value = serde_json::from_slice(&bundle.index).unwrap();
            definitions.extend(index["definitions"].as_array().unwrap().iter().cloned());
            records.extend(index["contents"].as_array().unwrap().iter().cloned());
            contents.extend(bundle.contents);
        }
        let template: Value = serde_json::from_slice(
            &crate::test_fixture::indexed_catalog_bundle_at_revision(
                &subject_catalog(SUBJECTS[0]),
                SUBJECTS[0],
                1,
            )
            .index,
        )
        .unwrap();
        let mut index = template;
        index["definitions"] = Value::Array(definitions);
        index["contents"] = Value::Array(records);
        Self {
            index: serde_json::to_vec(&index).unwrap(),
            contents,
        }
    }

    fn index_sha256(&self) -> String {
        digest(&self.index)
    }

    /// The subject's exact entry digest named by this index, if present.
    fn entry_sha256(&self, id: &str) -> Option<String> {
        let index = DefinitionContentIndex::parse(&self.index).unwrap();
        index
            .definitions()
            .iter()
            .find(|entry| entry.stable_id() == id)
            .map(|entry| digest(&self.contents[entry.target()]))
    }

    /// Interpret the subject only through this index, as every reader does.
    fn projection(&self, id: &str) -> Option<crate::DefinitionCatalogProjection> {
        let index = DefinitionContentIndex::parse(&self.index).unwrap();
        let indexed = index
            .definitions()
            .iter()
            .find(|entry| entry.stable_id() == id)?;
        let entry_bytes = &self.contents[indexed.target()];
        let entry = index.inspect_entry("official", id, entry_bytes).unwrap();
        let contract = &self.contents[entry.execution_contract()];
        Some(
            index
                .inspect_catalog_projection("official", id, entry_bytes, contract)
                .unwrap(),
        )
    }
}

fn decision(published: &Published, id: &str, decision_schema: u32) -> PolicyDocument {
    let index = DefinitionContentIndex::parse(&published.index).unwrap();
    let indexed = index
        .definitions()
        .iter()
        .find(|entry| entry.stable_id() == id)
        .unwrap();
    let mut document = json!({
        "policy_schema": 1,
        "namespace": "official",
        "stable_id": id,
        "policy_revision": 1,
        "grant_id": "protected-fixture-availability",
        "decision": {
            "status": "availability",
            "definition_revision": indexed.revision(),
            "index_sha256": published.index_sha256(),
            "definition_sha256": digest(&published.contents[indexed.target()]),
            "template": "libultraship-portable",
        },
    });
    if decision_schema == 2 {
        document["decision_schema"] = 2.into();
        document["decision"]
            .as_object_mut()
            .unwrap()
            .remove("index_sha256");
    }
    PolicyDocument::parse(&serde_json::to_vec(&document).unwrap()).unwrap()
}

/// Whether a reader currently relying on `current` honors `document`.
fn honored(document: &PolicyDocument, current: &Published) -> bool {
    current
        .projection(&document.stable_id)
        .is_some_and(|projection| {
            document
                .binds_projection(&projection, &current.index_sha256())
                .unwrap()
        })
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*: deterministic, so a failure names its seed.
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
}

fn history(seed: u64, steps: usize) -> Vec<Published> {
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
    let mut present = BTreeMap::from([(SUBJECTS[0], 1_u64)]);
    let mut result = vec![Published::new(&present)];
    while result.len() < steps {
        let id = SUBJECTS[rng.below(SUBJECTS.len())];
        match (present.get(id).copied(), rng.below(3)) {
            (None, _) => {
                present.insert(id, 1);
            }
            (Some(revision), 0 | 1) => {
                present.insert(id, revision + 1);
            }
            (Some(_), _) if present.len() > 1 => {
                present.remove(id);
            }
            (Some(revision), _) => {
                present.insert(id, revision + 1);
            }
        }
        result.push(Published::new(&present));
    }
    result
}

#[test]
fn schema_two_differs_from_schema_one_only_for_unrelated_index_changes() {
    let mut avoided = 0;
    let mut agreed_refusals = 0;
    for seed in 0..12 {
        let history = history(seed, 14);
        for (made, at) in history.iter().enumerate() {
            for id in SUBJECTS {
                if at.entry_sha256(id).is_none() {
                    continue;
                }
                let global = decision(at, id, 1);
                let entry = decision(at, id, 2);
                for (used, current) in history.iter().enumerate().skip(made) {
                    let by_global = honored(&global, current);
                    let by_entry = honored(&entry, current);
                    let unchanged_subject = current.entry_sha256(id) == at.entry_sha256(id);
                    let context = format!("seed {seed} subject {id} made {made} used {used}");
                    // Schema 2 is honored exactly while the current index names
                    // this subject with the same exact entry bytes.
                    assert_eq!(by_entry, unchanged_subject, "{context}");
                    // Schema 1 additionally requires the identical whole index.
                    assert_eq!(
                        by_global,
                        current.index_sha256() == at.index_sha256(),
                        "{context}"
                    );
                    assert!(!by_global || by_entry, "{context}");
                    if !unchanged_subject {
                        // Removal or revision: both schemas refuse.
                        assert!(!by_global && !by_entry, "{context}");
                        agreed_refusals += 1;
                    } else if !by_global {
                        avoided += 1;
                    }
                    // Where the subject is unchanged, the decision a schema-1
                    // publisher must re-sign for this index and the unchanged
                    // schema-2 decision are both honored: they agree.
                    if unchanged_subject {
                        assert!(honored(&decision(current, id, 1), current), "{context}");
                    }
                }
            }
        }
    }
    assert!(avoided > 0 && agreed_refusals > 0);
}

#[test]
fn schema_two_refuses_another_entry_index_or_identity() {
    let first = Published::new(&BTreeMap::from([(SUBJECTS[0], 1)]));
    let added = Published::new(&BTreeMap::from([(SUBJECTS[0], 1), (SUBJECTS[1], 1)]));
    let a = decision(&first, SUBJECTS[0], 2);
    let b = decision(&added, SUBJECTS[1], 2);
    assert!(honored(&a, &added));
    assert!(honored(&b, &added));

    // The decision is never paired with another subject's projection.
    let other = added.projection(SUBJECTS[1]).unwrap();
    assert!(!a.binds_projection(&other, &added.index_sha256()).unwrap());

    // Replay with a different entry digest for the same subject.
    let mut replayed = serde_json::to_value(&a).unwrap();
    replayed["decision"]["definition_sha256"] = added.entry_sha256(SUBJECTS[1]).unwrap().into();
    let replayed = PolicyDocument::parse(&serde_json::to_vec(&replayed).unwrap()).unwrap();
    assert!(!honored(&replayed, &added));

    // A projection interpreted from another index than the one in use.
    let stale = first.projection(SUBJECTS[0]).unwrap();
    assert!(!a.binds_projection(&stale, &added.index_sha256()).unwrap());
    assert!(a.binds_projection(&stale, &first.index_sha256()).unwrap());

    // A revised definition revision defeats it.
    let revised = Published::new(&BTreeMap::from([(SUBJECTS[0], 2), (SUBJECTS[1], 1)]));
    assert!(!honored(&a, &revised));
    // Removal leaves nothing to interpret.
    let removed = Published::new(&BTreeMap::from([(SUBJECTS[1], 1)]));
    assert!(removed.projection(SUBJECTS[0]).is_none());
    assert!(!honored(&a, &removed));
}

#[test]
fn decision_schema_is_explicit_canonical_and_isolates_newer_schemas() {
    let published = Published::new(&BTreeMap::from([(SUBJECTS[0], 1)]));
    let base = serde_json::to_value(decision(&published, SUBJECTS[0], 1)).unwrap();
    let entry = serde_json::to_value(decision(&published, SUBJECTS[0], 2)).unwrap();
    assert!(entry.get("decision_schema") == Some(&json!(2)));
    assert!(entry["decision"].get("index_sha256").is_none());
    assert!(base.get("decision_schema").is_none());
    let parse = |value: &Value| PolicyDocument::parse(&serde_json::to_vec(value).unwrap());

    // Schema 2 must not also name the global index; schema 1 must.
    let mut both = entry.clone();
    both["decision"]["index_sha256"] = published.index_sha256().into();
    assert!(parse(&both).is_err());
    // Including an explicit null: schema 2 omits the field.
    both["decision"]["index_sha256"] = Value::Null;
    assert!(parse(&both).is_err());
    let mut neither = base.clone();
    neither["decision"]
        .as_object_mut()
        .unwrap()
        .remove("index_sha256");
    assert!(parse(&neither).is_err());

    // Schema 1 is expressed only by omission; malformed values are invalid.
    for value in [
        json!(1),
        json!(0),
        json!(null),
        json!("2"),
        json!(-2),
        json!(2.5),
    ] {
        let mut malformed = entry.clone();
        malformed["decision_schema"] = value.clone();
        let error = parse(&malformed).unwrap_err();
        assert!(
            !crate::definition_capabilities::requires_newer_engine(&error),
            "{value}"
        );
    }

    // A newer schema needs a newer reader for this subject only, even when
    // its decision has a shape this reader cannot type.
    for value in [json!(3), json!(u32::MAX)] {
        let mut newer = entry.clone();
        newer["decision_schema"] = value.clone();
        newer["decision"]["entry_binding_v3"] = json!({"unknown": true});
        let error = parse(&newer).unwrap_err();
        assert!(
            crate::definition_capabilities::requires_newer_engine(&error),
            "{value}"
        );
    }

    // Revocations bind nothing and stay readable by every released reader.
    let mut revoked = base.clone();
    revoked["decision"] = json!({"status": "revoked"});
    parse(&revoked).unwrap();
    revoked["decision_schema"] = 2.into();
    assert!(parse(&revoked).is_err());

    // Managed scopes take the same binding schema.
    let mut managed = entry.clone();
    managed["policy_schema"] = 2.into();
    managed["grant_id"] = "managed-github-v1-fixture".into();
    managed["decision"]["status"] = "managed_github".into();
    managed["decision"]["repository_id"] = 1296269.into();
    managed["decision"]["artifact_hosts"] = json!(["github.com"]);
    managed["decision"]["max_redirects"] = 5.into();
    managed["decision"]["operations"] = json!(["install", "update", "prepare", "launch"]);
    parse(&managed).unwrap();
}

#[test]
fn decision_schema_two_continues_the_same_managed_authorization() {
    let published = Published::new(&BTreeMap::from([(SUBJECTS[0], 1)]));
    let mut global = serde_json::to_value(decision(&published, SUBJECTS[0], 1)).unwrap();
    global["policy_schema"] = 2.into();
    global["grant_id"] = "managed-github-v1-fixture".into();
    global["decision"]["status"] = "managed_github".into();
    global["decision"]["repository_id"] = 1296269.into();
    global["decision"]["artifact_hosts"] = json!(["github.com"]);
    global["decision"]["max_redirects"] = 5.into();
    global["decision"]["operations"] = json!(["install", "update", "prepare", "launch"]);
    let mut entry = global.clone();
    entry["policy_revision"] = 2.into();
    entry["decision_schema"] = 2.into();
    entry["decision"]
        .as_object_mut()
        .unwrap()
        .remove("index_sha256");
    let parse = |value: &Value| PolicyDocument::parse(&serde_json::to_vec(value).unwrap()).unwrap();
    // The binding form is not authority: switching it keeps retained launch
    // continuity exactly like a schema-1 rebind at a higher revision.
    assert!(parse(&entry).continues_managed_authorization(&parse(&global)));
}

#[test]
fn reader_advertises_the_entry_bound_decision_feature() {
    let features = crate::definition_capabilities::supported_definition_features();
    assert!(features.contains(&"catalog.policy-decision-v2".to_owned()));
    assert_eq!(
        crate::CapabilityDocument::current().definition_features,
        features
    );
}
