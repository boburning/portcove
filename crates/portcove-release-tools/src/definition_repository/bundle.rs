use super::*;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inspection {
    publication_schema: u32,
    authority: String,
    index_sha256: String,
    files: Vec<DefinitionFile>,
    definitions: Vec<Definition>,
    scope: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    namespace: String,
    stable_id: String,
    revision: u64,
    definition_target: String,
    policy_target: String,
    policy_schema: u32,
    policy_revision: u64,
    grant_id: String,
    launch_target: Option<String>,
    launch_revision: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    index_schema: u32,
    definitions: Vec<Entry>,
    contents: Vec<Content>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    namespace: String,
    stable_id: String,
    revision: u64,
    target: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Content {
    target: String,
    sha256: String,
    length: u64,
}
fn content_path(value: &str) -> bool {
    value.len() == 76
        && value.starts_with("sha256/")
        && value.ends_with(".json")
        && value[7..71]
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
pub(super) fn inspect(root: &Path, manifest: &[u8]) -> Result<(Files, String)> {
    let report: Inspection = serde_json::from_slice(manifest)?;
    if report.publication_schema != 1
        || report.authority != "none"
        || report.scope != "inert-managed-definition-publication-inspection"
        || report.files.is_empty()
        || report.files.len() > BUNDLE_FILES
        || report.definitions.len() > 4096
    {
        return invalid("catalog inspection shape/scope/bound differs");
    }
    let files = io::tree(root, BUNDLE_FILES, BUNDLE_MAX)?;
    let actual = identities(&files);
    if report.files != actual {
        return invalid("captured catalog inspection differs from exact current bundle");
    }
    let index_bytes = files
        .get("definitions/index.json")
        .ok_or_else(|| TufRepositoryError::Invalid("catalog index absent".into()))?;
    if index_bytes.len() > 4 * 1024 * 1024 {
        return invalid("catalog index bound exceeded");
    }
    expected(index_bytes, &report.index_sha256)?;
    let index: Index = serde_json::from_slice(index_bytes)?;
    if index.index_schema != 1
        || index.definitions.len() > 4096
        || index.contents.len() > BUNDLE_FILES
        || index.definitions.len() != report.definitions.len()
    {
        return invalid("catalog index/inspection definition inventory differs");
    }
    let mut allowed = BTreeSet::from(["definitions/index.json".to_owned()]);
    let mut content = BTreeMap::new();
    for c in &index.contents {
        if !content_path(&c.target)
            || c.target[7..71] != c.sha256
            || !allowed.insert(c.target.clone())
            || c.length == 0
            || c.length > 4 * 1024 * 1024
        {
            return invalid("catalog content identity/path/bound differs");
        }
        let raw = files
            .get(&c.target)
            .ok_or_else(|| TufRepositoryError::Invalid("indexed catalog leaf absent".into()))?;
        if raw.len() as u64 != c.length {
            return invalid("indexed catalog leaf length differs");
        }
        expected(raw, &c.sha256)?;
        content.insert(c.target.clone(), c);
    }
    let entries = index
        .definitions
        .iter()
        .map(|v| ((v.namespace.as_str(), v.stable_id.as_str()), v))
        .collect::<BTreeMap<_, _>>();
    if entries.len() != index.definitions.len() {
        return invalid("catalog definition identity repeats");
    }
    let mut last = None;
    for d in &report.definitions {
        let identity = (d.namespace.as_str(), d.stable_id.as_str());
        if last.is_some_and(|v| v >= identity)
            || d.namespace != "official"
            || d.stable_id.is_empty()
            || d.stable_id.len() > 128
            || !d
                .stable_id
                .bytes()
                .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || b"-_".contains(&v))
            || d.revision == 0
            || d.policy_revision == 0
            || d.grant_id.is_empty()
            || d.grant_id.len() > 256
        {
            return invalid("catalog definition manifest identity differs");
        }
        last = Some(identity);
        let entry = entries.get(&identity).ok_or_else(|| {
            TufRepositoryError::Invalid("catalog inspection references absent definition".into())
        })?;
        if entry.revision != d.revision
            || entry.target != d.definition_target
            || !content.contains_key(&entry.target)
        {
            return invalid("catalog definition index linkage differs");
        }
        if d.policy_target != format!("policy/official/{}.json", d.stable_id)
            || !allowed.insert(d.policy_target.clone())
        {
            return invalid("catalog policy path differs");
        }
        let raw = files
            .get(&d.policy_target)
            .ok_or_else(|| TufRepositoryError::Invalid("catalog policy absent".into()))?;
        if raw.len() > 65536 {
            return invalid("catalog policy exceeds64KiB");
        }
        let policy: serde_json::Value = serde_json::from_slice(raw)?;
        for (key, want) in [
            ("namespace", serde_json::json!(d.namespace)),
            ("stable_id", serde_json::json!(d.stable_id)),
            ("policy_schema", serde_json::json!(d.policy_schema)),
            ("policy_revision", serde_json::json!(d.policy_revision)),
            ("grant_id", serde_json::json!(d.grant_id)),
        ] {
            if policy.get(key) != Some(&want) {
                return invalid("catalog policy/inspection identity differs");
            }
        }
        let decision = policy
            .get("decision")
            .ok_or_else(|| TufRepositoryError::Invalid("catalog policy decision absent".into()))?;
        for (key, want) in [
            ("definition_revision", serde_json::json!(d.revision)),
            ("index_sha256", serde_json::json!(report.index_sha256)),
            (
                "definition_sha256",
                serde_json::json!(sha(files.get(&d.definition_target).unwrap())),
            ),
        ] {
            if let Some(actual) = decision.get(key) {
                if actual != &want {
                    return invalid("catalog policy exact definition binding differs");
                }
            }
        }
        let needs_launch = matches!(d.policy_schema, 3 | 4)
            && decision.get("scoped_launch_checks") == Some(&serde_json::json!(1));
        match (&d.launch_target, d.launch_revision, needs_launch) {
            (Some(target), Some(revision), true)
                if revision > 0
                    && *target == format!("policy/official/{}.launch.json", d.stable_id) =>
            {
                if !allowed.insert(target.clone()) {
                    return invalid("catalog launch target repeats");
                }
                let bytes = files.get(target).ok_or_else(|| {
                    TufRepositoryError::Invalid("catalog launch target absent".into())
                })?;
                if bytes.len() > 65536 {
                    return invalid("catalog launch target exceeds64KiB");
                }
                let launch: serde_json::Value = serde_json::from_slice(bytes)?;
                if launch.get("namespace") != Some(&serde_json::json!("official"))
                    || launch.get("stable_id") != Some(&serde_json::json!(d.stable_id))
                    || launch.get("revision") != Some(&serde_json::json!(revision))
                    || launch.get("policy_sha256") != Some(&serde_json::json!(sha(raw)))
                {
                    return invalid("catalog launch target policy binding differs");
                }
            }
            (None, None, false) => {}
            _ => return invalid("catalog launch inventory differs from current policy"),
        }
    }
    if allowed != files.keys().cloned().collect() {
        return invalid("catalog bundle contains unreferenced/private/foreign namespace targets");
    }
    Ok((files, report.index_sha256))
}
pub(super) fn identities(files: &Files) -> Vec<DefinitionFile> {
    files
        .iter()
        .map(|(target, bytes)| DefinitionFile {
            target: target.clone(),
            bytes: bytes.len() as u64,
            sha256: sha(bytes),
        })
        .collect()
}
