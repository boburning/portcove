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
    #[serde(default)]
    listings: Option<ListingIdentity>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListingIdentity {
    target: String,
    revision: u64,
    sha256: String,
    listing_count: usize,
    withdrawn_count: usize,
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
#[derive(Debug, PartialEq, Eq)]
pub(super) struct ListingRevision {
    pub revision: u64,
    pub decoded_sha256: String,
    listing_count: usize,
    pub withdrawn_ids: BTreeSet<String>,
}

pub(super) fn listing_revision(target: &str, raw: &[u8]) -> Result<ListingRevision> {
    if !portcove_listing_carrier::is_listing_target(target)
        || raw.is_empty()
        || raw.len() > portcove_listing_carrier::MAX_BYTES
    {
        return invalid("listing target outside its byte bound");
    }
    if target == portcove_listing_carrier::COMPACT_TARGET {
        let (decoded, decoded_sha256) = portcove_listing_carrier::decode(raw)
            .map_err(|error| TufRepositoryError::Invalid(error.to_string()))?;
        let summary: CompactListingSummary<'_> = serde_json::from_slice(&decoded)?;
        if summary.listing_delivery_schema != 1
            || !(1..=9_007_199_254_740_991).contains(&summary.revision)
            || summary
                .directory
                .listings
                .iter()
                .any(|row| row.get().len() > portcove_listing_carrier::MAX_COMPACT_RECORD_BYTES)
        {
            return invalid("compact listing summary differs");
        }
        return Ok(ListingRevision {
            revision: summary.revision,
            decoded_sha256,
            listing_count: summary.directory.listings.len(),
            withdrawn_ids: collect_listing_withdrawals(
                summary.withdrawn_ids.iter().map(|id| Some(id.as_str())),
            )?,
        });
    }
    let document: serde_json::Value = serde_json::from_slice(raw)?;
    let revision = document["revision"]
        .as_u64()
        .filter(|n| (1..=9_007_199_254_740_991).contains(n));
    let listing_count = document["directory"]["listings"]
        .as_array()
        .map(Vec::len)
        .filter(|n| *n <= 10000);
    let withdrawn_ids = listing_withdrawals(&document)?;
    match (
        document["listing_delivery_schema"].as_u64(),
        revision,
        listing_count,
    ) {
        (Some(1), Some(revision), Some(listing_count)) => Ok(ListingRevision {
            revision,
            decoded_sha256: sha(raw),
            listing_count,
            withdrawn_ids,
        }),
        _ => invalid("listing summary differs"),
    }
}

#[derive(Deserialize)]
struct CompactListingSummary<'a> {
    listing_delivery_schema: u32,
    revision: u64,
    #[serde(deserialize_with = "portcove_listing_carrier::bounded_entries")]
    withdrawn_ids: Vec<String>,
    #[serde(borrow)]
    directory: CompactListingSummaryDirectory<'a>,
}

#[derive(Deserialize)]
struct CompactListingSummaryDirectory<'a> {
    #[serde(borrow, deserialize_with = "portcove_listing_carrier::bounded_entries")]
    listings: Vec<&'a serde_json::value::RawValue>,
}

fn listing_withdrawals(document: &serde_json::Value) -> Result<BTreeSet<String>> {
    let Some(list) = document["withdrawn_ids"]
        .as_array()
        .filter(|ids| ids.len() <= 10000)
    else {
        return invalid("listing withdrawal inventory differs");
    };
    collect_listing_withdrawals(list.iter().map(serde_json::Value::as_str))
}

fn collect_listing_withdrawals<'a>(
    entries: impl IntoIterator<Item = Option<&'a str>>,
) -> Result<BTreeSet<String>> {
    let mut ids = BTreeSet::new();
    for id in entries {
        let Some(id) = id.filter(|value| !value.is_empty() && value.len() <= 128) else {
            return invalid("listing withdrawal identity differs");
        };
        if !ids.insert(id.to_owned()) {
            return invalid("listing withdrawal identity repeats");
        }
    }
    Ok(ids)
}

/// An older reader remains on its verified directory. A new safety withdrawal
/// may remove only the listed identities, without replacing other legacy facts.
pub(super) fn check_legacy_withdrawal(prior: &[u8], proposal: &[u8]) -> Result<()> {
    let mut expected: serde_json::Value = serde_json::from_slice(prior)?;
    let proposal: serde_json::Value = serde_json::from_slice(proposal)?;
    let prior_ids = listing_withdrawals(&expected)?;
    let next_ids = listing_withdrawals(&proposal)?;
    if !prior_ids.is_subset(&next_ids) || prior_ids == next_ids {
        return invalid("legacy listing replacement must add a safety withdrawal");
    }
    let Some(listings) = expected["directory"]["listings"].as_array_mut() else {
        return invalid("legacy listing withdrawal directory differs");
    };
    listings.retain(|row| !row["id"].as_str().is_some_and(|id| next_ids.contains(id)));
    expected["withdrawn_ids"] = proposal["withdrawn_ids"].clone();
    expected["revision"] = proposal["revision"].clone();
    if expected != proposal {
        return invalid("legacy listing withdrawal changes other facts");
    }
    Ok(())
}

pub(super) struct ListingTargets {
    pub legacy: Option<ListingRevision>,
    pub compact: Option<ListingRevision>,
}

pub(super) fn checked_cover_checkpoint(files: &Files) -> Result<Option<(&[u8], String)>> {
    use portcove_listing_carrier::{COMPACT_TARGET, COVER_CHECKPOINT_TARGET, LEGACY_TARGET};
    let Some(cover) = files.get(COVER_CHECKPOINT_TARGET) else {
        return Ok(None);
    };
    let active = [COMPACT_TARGET, LEGACY_TARGET]
        .into_iter()
        .find_map(|target| files.get(target).map(|bytes| (target, bytes)))
        .ok_or_else(|| {
            TufRepositoryError::Invalid("cover checkpoint has no active listing".into())
        })?;
    let listing = listing_revision(active.0, active.1)?;
    portcove_listing_carrier::check_cover_checkpoint(cover, &listing.decoded_sha256)
        .map_err(|error| TufRepositoryError::Invalid(error.to_string()))?;
    Ok(Some((cover, listing.decoded_sha256)))
}

pub(super) fn listing_targets(files: &Files) -> Result<ListingTargets> {
    let inspect = |name: &str| {
        files
            .get(name)
            .map(|raw| listing_revision(name, raw))
            .transpose()
    };
    let legacy = inspect(portcove_listing_carrier::LEGACY_TARGET)?;
    let compact = inspect(portcove_listing_carrier::COMPACT_TARGET)?;
    if let Some(compact) = &compact {
        let prior = legacy.as_ref().ok_or_else(|| {
            TufRepositoryError::Invalid(
                "compact listing requires its retained legacy target".into(),
            )
        })?;
        if compact.revision < prior.revision
            || (compact.revision == prior.revision && compact != prior)
            || !prior.withdrawn_ids.is_subset(&compact.withdrawn_ids)
        {
            return invalid("listing carrier revision or equivalent decoded identity differs");
        }
    }
    Ok(ListingTargets { legacy, compact })
}

pub(super) fn inspect(root: &Path, manifest: &[u8]) -> Result<(Files, String)> {
    let report: Inspection = serde_json::from_slice(manifest)?;
    if !matches!(
        (
            report.publication_schema,
            report.listings.is_some(),
            report.scope.as_str()
        ),
        (1, false, "inert-managed-definition-publication-inspection")
            | (2, true, "inert-catalog-publication-inspection")
    ) || report.authority != "none"
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
    if index_bytes.len() as u64 > DEFINITION_INDEX_MAX {
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
    if checked_cover_checkpoint(&files)?.is_some() {
        allowed.insert(portcove_listing_carrier::COVER_CHECKPOINT_TARGET.into());
    }
    let listing_targets = listing_targets(&files)?;
    let active_listings = if let Some(compact) = &listing_targets.compact {
        allowed.insert(portcove_listing_carrier::COMPACT_TARGET.into());
        allowed.insert(portcove_listing_carrier::LEGACY_TARGET.into());
        Some((portcove_listing_carrier::COMPACT_TARGET, compact))
    } else {
        listing_targets.legacy.as_ref().map(|legacy| {
            allowed.insert(portcove_listing_carrier::LEGACY_TARGET.into());
            (portcove_listing_carrier::LEGACY_TARGET, legacy)
        })
    };
    match (&report.listings, active_listings) {
        (None, None) => {}
        (Some(listings), Some((target, active)))
            if listings.target == target
                && listings.sha256 == sha(&files[target])
                && listings.revision == active.revision
                && listings.listing_count == active.listing_count
                && listings.withdrawn_count == active.withdrawn_ids.len() => {}
        _ => return invalid("listing target/inspection identity differs"),
    }
    let mut content = BTreeMap::new();
    for c in &index.contents {
        if !content_path(&c.target)
            || c.target[7..71] != c.sha256
            || !allowed.insert(c.target.clone())
            || c.length == 0
            || c.length > DEFINITION_CONTENT_MAX
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
            || !content
                .get(&entry.target)
                .is_some_and(|target| target.length <= DEFINITION_INDEX_MAX)
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
            if let Some(actual) = decision.get(key)
                && actual != &want
            {
                return invalid("catalog policy exact definition binding differs");
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
