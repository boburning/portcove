use super::{
    public_history::{PublicFile, PublicHistory},
    *,
};
use futures_util::TryStreamExt;
use std::borrow::Cow;
use tough::{
    RepositoryLoader, TargetName, Transport, TransportError, TransportErrorKind, TransportStream,
    schema::{Role, Snapshot, Timestamp as TufTimestamp},
};
#[derive(Debug, Clone)]
struct PublicTransport(Arc<PublicHistory>);
#[async_trait::async_trait]
impl Transport for PublicTransport {
    async fn fetch(&self, url: url::Url) -> std::result::Result<TransportStream, TransportError> {
        if url.scheme() != "https"
            || url.host_str() != Some("catalog.invalid")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(TransportError::new(
                TransportErrorKind::UnsupportedUrlScheme,
                url.as_str(),
            ));
        }
        let file = self
            .0
            .get(url.path().trim_start_matches('/'))
            .ok_or_else(|| TransportError::new(TransportErrorKind::FileNotFound, url.as_str()))?;
        let bytes = file.read().map_err(|error| {
            TransportError::new_with_cause(TransportErrorKind::Other, url.as_str(), error)
        })?;
        Ok(Box::pin(futures_util::stream::iter([Ok(bytes.into())])))
    }
}
fn at<'a>(files: &'a Files, name: &str) -> Result<&'a Vec<u8>> {
    files.get(name).ok_or_else(|| {
        TufRepositoryError::Invalid(format!("catalog public repository file missing: {name}"))
    })
}
fn cover_approvals_from_policy(policy: &serde_json::Value) -> Result<Option<serde_json::Value>> {
    let value = policy["signed"]["targets"][portcove_listing_carrier::COMPACT_TARGET]["custom"]
        .get(super::COVER_APPROVALS_CUSTOM);
    if let Some(journal) = value {
        super::cover_approval_packets(journal)?;
    }
    Ok(value.cloned())
}

fn current_roles(files: &PublicHistory) -> Result<Files> {
    let timestamp_bytes = files.file("metadata/timestamp.json")?;
    let timestamp: Signed<TufTimestamp> = serde_json::from_slice(&timestamp_bytes)?;
    let snapshot_version = timestamp
        .signed
        .meta
        .get("snapshot.json")
        .ok_or_else(|| TufRepositoryError::Invalid("catalog prior snapshot absent".into()))?
        .version;
    let snapshot_bytes = files.file(&format!("metadata/{snapshot_version}.snapshot.json"))?;
    let snapshot: Signed<Snapshot> = serde_json::from_slice(&snapshot_bytes)?;
    if timestamp.signed.meta.len() != 1
        || timestamp.signed.spec_version != "1.0.0"
        || !timestamp.signed._extra.is_empty()
        || snapshot.signed.spec_version != "1.0.0"
        || !snapshot.signed._extra.is_empty()
        || snapshot
            .signed
            .meta
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>()
            != BTreeSet::from([
                "targets.json",
                "official-definitions.json",
                "official-policy.json",
            ])
    {
        return invalid("catalog prior metadata inventory/content differs");
    }
    let mut roles = Files::from([
        ("timestamp.json".into(), timestamp_bytes),
        ("snapshot.json".into(), snapshot_bytes),
    ]);
    for role in ["targets", "official-definitions", "official-policy"] {
        let version = snapshot.signed.meta[&format!("{role}.json")].version;
        roles.insert(
            format!("{role}.json"),
            files.file(&format!("metadata/{version}.{role}.json"))?,
        );
    }
    Ok(roles)
}
#[derive(Default)]
struct AuthenticatedTargets {
    files: Files,
    digests: BTreeMap<String, String>,
}

impl AuthenticatedTargets {
    fn historical_body<'a>(&'a self, target: &str, raw: &PublicFile) -> Result<Cow<'a, [u8]>> {
        if self
            .digests
            .get(target)
            .is_some_and(|digest| digest == raw.digest())
            && let Some(bytes) = self.files.get(target)
            && bytes.len() as u64 == raw.bytes()
        {
            return Ok(Cow::Borrowed(bytes.as_slice()));
        }
        Ok(Cow::Owned(raw.read()?))
    }
}

/// Full Tough verification of a complete catalog site. `Unsafe` expiry enforcement
/// is used only to read an already-published prior as history: signatures,
/// version floors and immutable-history checks still apply, so the publisher can
/// recover after the published timestamp lapses. New output is always `Safe`.
async fn authenticate(
    root: &[u8],
    files: &PublicHistory,
    expiration: tough::ExpirationEnforcement,
) -> Result<AuthenticatedTargets> {
    let repository = RepositoryLoader::new(
        &root,
        url::Url::parse("https://catalog.invalid/metadata/").unwrap(),
        url::Url::parse("https://catalog.invalid/targets/").unwrap(),
    )
    .transport(PublicTransport(Arc::new(files.clone())))
    .expiration_enforcement(expiration)
    .limits(tough::Limits {
        max_root_size: ROOT_MAX,
        max_targets_size: ROLE_MAX,
        max_timestamp_size: ROOT_MAX,
        max_snapshot_size: 4 * 1024 * 1024,
        max_root_updates: 32,
    })
    .load()
    .await?;
    let roles = current_roles(files)?;
    let top: Signed<Targets> = serde_json::from_slice(at(&roles, "targets.json")?)?;
    if top.signed.canonical_form()? != repository.targets().signed.canonical_form()? {
        return invalid("catalog Tough loaded different top-level Targets");
    }
    let mut logical = AuthenticatedTargets::default();
    for role in ["official-definitions", "official-policy"] {
        let signed: Signed<Targets> = serde_json::from_slice(at(&roles, &format!("{role}.json"))?)?;
        if signed.signed.spec_version != "1.0.0"
            || !signed.signed._extra.is_empty()
            || signed.signed.delegations.is_some()
        {
            return invalid("catalog prior delegated metadata has unsupported content");
        }
        top.signed
            .delegations
            .as_ref()
            .ok_or_else(|| TufRepositoryError::Invalid("catalog prior delegations absent".into()))?
            .verify_role(&signed, role)?;
        for (name, target) in &signed.signed.targets {
            io::relative(name.raw())?;
            if (role == "official-definitions"
                && !(name.raw() == "definitions/index.json" || name.raw().starts_with("sha256/")))
                || (role == "official-policy" && !name.raw().starts_with("policy/official/"))
            {
                return invalid("catalog prior target outside role scope");
            }
            let maximum = if portcove_listing_carrier::is_listing_target(name.raw()) {
                portcove_listing_carrier::MAX_BYTES as u64
            } else if name.raw() == portcove_listing_carrier::COVER_CHECKPOINT_TARGET {
                portcove_listing_carrier::COVER_CHECKPOINT_MAX as u64
            } else if name.raw().starts_with("policy/") {
                65536
            } else if name.raw() == "definitions/index.json" {
                DEFINITION_INDEX_MAX
            } else {
                DEFINITION_CONTENT_MAX
            };
            if target.length == 0 || target.length > maximum {
                return invalid("catalog prior target byte bound differs");
            }
            let stream = repository
                .read_target(&TargetName::new(name.raw())?)
                .await?
                .ok_or_else(|| {
                    TufRepositoryError::Invalid("catalog authenticated target absent".into())
                })?;
            let bytes = stream.map_ok(|b| b.to_vec()).try_concat().await?;
            let digest = sha(&bytes);
            if bytes.len() as u64 != target.length || digest != hex::encode(&target.hashes.sha256) {
                return invalid("catalog prior target hash/length differs");
            }
            logical.digests.insert(name.raw().into(), digest);
            if logical.files.insert(name.raw().into(), bytes).is_some() {
                return invalid("catalog prior target ownership overlap");
            }
            if logical.files.len() > BUNDLE_FILES
                || logical.files.values().map(|v| v.len() as u64).sum::<u64>() > BUNDLE_MAX
            {
                return invalid("catalog prior bundle bound exceeded");
            }
        }
    }
    bundle::listing_targets(&logical.files)?;
    bundle::checked_cover_checkpoint(&logical.files)?;
    Ok(logical)
}
fn validate_public_paths(files: &PublicHistory) -> Result<()> {
    for (name, file) in files.iter() {
        let valid = if let Some(n) = name.strip_prefix("metadata/") {
            n == "timestamp.json"
                || n.split_once('.').is_some_and(|(v, role)| {
                    v.parse::<u64>().is_ok_and(|v| v > 0)
                        && [
                            "root.json",
                            "targets.json",
                            "official-definitions.json",
                            "official-policy.json",
                            "snapshot.json",
                        ]
                        .contains(&role)
                })
        } else if let Some(n) = name.strip_prefix("targets/") {
            n.split_once('.').is_some_and(|(h, p)| {
                h.len() == 64
                    && h.bytes()
                        .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
                    && (p == "definitions/index.json"
                        || p.starts_with("sha256/")
                        || p.starts_with("policy/official/"))
            })
        } else {
            false
        };
        if name.starts_with("targets/")
            && name[8..]
                .split_once('.')
                .is_none_or(|(digest, _)| file.digest() != digest)
        {
            return invalid("catalog retained target hash prefix differs from actual bytes");
        }
        if !valid {
            return invalid("catalog prior tree contains foreign/private/unversioned data");
        }
    }
    Ok(())
}
pub(super) async fn inspect_prior(
    context: &Context,
    path: &Path,
) -> Result<(
    PublicHistory,
    Option<super::history_checkpoint::PreparedHistory>,
    Option<serde_json::Value>,
)> {
    let expects_thin = context.thin_history && context.history_store.is_some();
    let files = if expects_thin {
        PublicHistory::read_bounded(
            path,
            super::history_checkpoint::THIN_MAX_FILES,
            super::history_checkpoint::THIN_MAX_BYTES,
        )?
    } else {
        PublicHistory::read(path)?
    };
    validate_public_paths(&files)?;
    let logical = authenticate(
        &context.root_bytes,
        &files,
        tough::ExpirationEnforcement::Unsafe,
    )
    .await?;
    let roles = current_roles(&files)?;
    let pointer = logical.files.get(super::history_checkpoint::TARGET);
    let prior_cover = bundle::checked_cover_checkpoint(&logical.files)?;
    if context.cover_approvals.is_some()
        && (prior_cover.is_none()
            || !logical
                .files
                .contains_key(portcove_listing_carrier::COMPACT_TARGET))
    {
        return invalid(
            "catalog cover approval cannot activate compact delivery or cover checkpoint",
        );
    }
    let next_cover = bundle::checked_cover_checkpoint(&context.targets)?;
    if pointer.is_none() && (prior_cover.is_some() || next_cover.is_some()) {
        return invalid("cover observations require authenticated catalog history");
    }
    portcove_listing_carrier::check_cover_checkpoint_successor(
        prior_cover
            .as_ref()
            .map(|(bytes, sha)| (*bytes, sha.as_str())),
        next_cover
            .as_ref()
            .map(|(bytes, sha)| (*bytes, sha.as_str())),
    )
    .map_err(|error| TufRepositoryError::Invalid(error.to_string()))?;
    let thin = context.thin_history && pointer.is_some();
    let mut floors = HistoricalRevisionFloors::default();
    verify_history(context, &files, |role, targets| {
        floors.observe(&files, &logical, role, targets)
    })?;
    let top: Signed<Targets> = serde_json::from_slice(at(&roles, "targets.json")?)?;
    // The prior is history: its offline Targets keeps its key inventory check, but
    // not its lifetime window, so a late offline re-sign can still be published.
    // The new offline Targets is window-checked in load_context.
    policy::top_key_inventory(&context.root.signed, &top)?;
    if context.online_targets && at(&roles, "targets.json")? != &context.top_bytes {
        return invalid("catalog online renewal base must equal actual current Targets bytes");
    }
    if context.top.signed.version == top.signed.version
        && &context.top_bytes != at(&roles, "targets.json")?
    {
        return invalid("catalog same-version offline Targets raw envelope replacement");
    }
    if context.top.signed.version < top.signed.version
        || (context.top.signed.version == top.signed.version
            && top.signed.canonical_form()? != context.top.signed.canonical_form()?)
        || serde_json::to_value(&top.signed.delegations)?
            != serde_json::to_value(&context.top.signed.delegations)?
    {
        return invalid(
            "catalog offline Targets rollback/equivocation or unappointed delegation change",
        );
    }
    let mut cover_approvals = None;
    for role in [
        DefinitionOnlineRole::Definitions,
        DefinitionOnlineRole::Policy,
        DefinitionOnlineRole::Snapshot,
        DefinitionOnlineRole::Timestamp,
    ] {
        let value: serde_json::Value =
            serde_json::from_slice(at(&roles, &format!("{}.json", role.name()))?)?;
        if role.name() == "official-policy" {
            cover_approvals = cover_approvals_from_policy(&value)?;
        }
        let version = value["signed"]["version"]
            .as_u64()
            .ok_or_else(|| TufRepositoryError::Invalid("catalog prior version malformed".into()))?;
        if context.versions[role.index()].get() < version {
            return invalid("catalog proposed version rolls back authenticated floor");
        }
    }
    if let Some(next) = &context.cover_approvals {
        let prior_compact = at(&logical.files, portcove_listing_carrier::COMPACT_TARGET)?;
        let compact = at(&context.targets, portcove_listing_carrier::COMPACT_TARGET)?;
        if next_cover.is_none() {
            return invalid("catalog cover approval requires the active cover checkpoint");
        }
        super::check_cover_approval_successor(
            cover_approvals.as_ref(),
            next,
            prior_compact,
            prior_cover.as_ref().map(|(bytes, _)| *bytes),
            compact,
        )?;
    }
    // Hash-addressed leaves are immutable across every retained generation.
    for (name, bytes) in &logical.files {
        if name.starts_with("sha256/")
            && context.targets.get(name).is_some_and(|next| next != bytes)
        {
            return invalid("catalog immutable content changed");
        }
    }
    floors.check(&context.targets)?;
    super::history_checkpoint::check_listings(
        &context.targets,
        floors
            .legacy_listing
            .as_ref()
            .map(|(floor, body)| (floor, body.as_slice())),
        floors.compact_listing.as_ref(),
    )?;
    let history = if pointer.is_some() || context.bootstrap_history {
        let timestamp_bytes = at(&roles, "timestamp.json")?;
        let timestamp: Signed<TufTimestamp> = serde_json::from_slice(timestamp_bytes)?;
        let policy: Signed<Targets> = serde_json::from_slice(at(&roles, "official-policy.json")?)?;
        let active_files = current_immutable_inventory(context, &roles, &logical.files, &files)?;
        let file_inventory = files.identities();
        if thin && file_inventory.len() != active_files.len() + 1 {
            return invalid("thin history must carry exactly the current authenticated repository");
        }
        let input = super::history_checkpoint::BootstrapInput {
            timestamp_version: timestamp.signed.version.get(),
            timestamp_sha256: sha(timestamp_bytes),
            root_sha256: sha(&context.root_bytes),
            delegation_sha256: delegation_digest(&context.top.signed)?,
            definitions: floors
                .definitions
                .into_iter()
                .map(|((namespace, stable_id), entry)| {
                    Ok(super::history_checkpoint::DefinitionFloor {
                        namespace,
                        stable_id,
                        revision: entry["revision"].as_u64().unwrap(),
                        entry_sha256: sha(&io::canonical(&serde_json::to_vec(&entry)?)?),
                    })
                })
                .collect::<Result<Vec<_>>>()?,
            policies: floors
                .policies
                .into_iter()
                .map(
                    |(target, (revision, target_sha256))| super::history_checkpoint::PolicyFloor {
                        target,
                        revision,
                        target_sha256,
                    },
                )
                .collect(),
            legacy_listing: floors.legacy_listing.map(|(floor, _)| floor),
            compact_listing: floors.compact_listing,
            files: file_inventory
                .iter()
                .filter(|file| file.target != "metadata/timestamp.json")
                .cloned()
                .collect(),
            active_files,
        };
        let next_timestamp = context.versions[3].get();
        let next_policy = context.versions[1].get();
        let checkpoint = if let Some(pointer) = pointer {
            let store = context.history_store.as_deref().ok_or_else(|| {
                TufRepositoryError::Invalid("catalog checkpointed history requires its authenticated object store; retain the prior generation".into())
            })?;
            let verified = super::history_checkpoint::read_current(
                pointer,
                store,
                &input.root_sha256,
                &input.delegation_sha256,
                input.timestamp_version,
                policy.signed.version.get(),
            )?;
            if !thin {
                verified.verify_archive(store, &file_inventory)?;
            }
            verified.check_new(&context.targets)?;
            let readback = verified.readback(store);
            let mut prepared = verified.advance(input, next_timestamp, next_policy)?;
            prepared.readback = readback;
            prepared
        } else {
            if context.history_store.is_some() {
                return invalid(
                    "catalog history store exists without an authenticated checkpoint pointer",
                );
            }
            super::history_checkpoint::bootstrap(input, next_timestamp, next_policy)?
        };
        Some(checkpoint)
    } else if context.history_store.is_some() {
        return invalid("catalog history store exists without an authenticated checkpoint pointer");
    } else {
        None
    };
    Ok((files, history, cover_approvals))
}

fn current_immutable_inventory(
    context: &Context,
    roles: &Files,
    logical: &Files,
    history: &PublicHistory,
) -> Result<Vec<DefinitionFile>> {
    let mut names = BTreeSet::from([format!(
        "metadata/{}.root.json",
        context.root.signed.version
    )]);
    for (name, body) in roles {
        if name == "timestamp.json" {
            continue;
        }
        let envelope: serde_json::Value = serde_json::from_slice(body)?;
        let version = envelope["signed"]["version"].as_u64().ok_or_else(|| {
            TufRepositoryError::Invalid("current catalog role version is missing".into())
        })?;
        names.insert(format!("metadata/{version}.{name}"));
    }
    for (name, bytes) in logical {
        names.insert(public_target_path(name, bytes)?);
    }
    names
        .into_iter()
        .map(|name| {
            let file = history.get(&name).ok_or_else(|| {
                TufRepositoryError::Invalid(format!("current catalog file missing: {name}"))
            })?;
            Ok(DefinitionFile {
                target: name,
                bytes: file.bytes(),
                sha256: file.digest().into(),
            })
        })
        .collect()
}

fn public_identities(path: &Path) -> Result<Vec<DefinitionFile>> {
    io::inventory(
        path,
        PUBLIC_REPOSITORY_MAX_FILES,
        PUBLIC_REPOSITORY_MAX_BYTES,
    )
}

fn public_target_path(name: &str, bytes: &[u8]) -> Result<String> {
    let target = TargetName::new(name.to_owned())?;
    Ok(format!("targets/{}.{}", sha(bytes), target.raw()))
}

fn check_public_capacity(count: usize, bytes: u64) -> Result<()> {
    if count > PUBLIC_REPOSITORY_MAX_FILES || bytes > PUBLIC_REPOSITORY_MAX_BYTES {
        return invalid("catalog retained public repository bound exceeded");
    }
    Ok(())
}

fn proposed_target_floor(prior: &PublicHistory, proposed: &Files) -> Result<(usize, u64)> {
    let (mut count, mut bytes) = (0, 0);
    // Timestamp is the only mutable repository path. The signed replacement
    // and any new versioned roles are accounted for during exact assembly.
    for (name, content) in prior.iter() {
        if name != "metadata/timestamp.json" {
            count += 1;
            bytes += content.bytes();
        }
    }
    for (name, content) in proposed {
        if prior.get(&public_target_path(name, content)?).is_none() {
            count += 1;
            bytes += content.len() as u64;
        }
    }
    Ok((count, bytes))
}

pub(super) fn check_proposed_target_capacity(
    prior: &PublicHistory,
    proposed: &Files,
) -> Result<()> {
    let (count, bytes) = proposed_target_floor(prior, proposed)?;
    check_public_capacity(count, bytes)
}
pub(super) fn indexed_entries(
    bytes: &[u8],
) -> Result<BTreeMap<(String, String), serde_json::Value>> {
    let index: serde_json::Value = serde_json::from_slice(bytes)?;
    let entries = index["definitions"].as_array().ok_or_else(|| {
        TufRepositoryError::Invalid("catalog historical index definitions absent".into())
    })?;
    if entries.len() > 4096 {
        return invalid("catalog historical index definition bound exceeded");
    }
    let mut map = BTreeMap::new();
    for entry in entries {
        let namespace = entry["namespace"].as_str().ok_or_else(|| {
            TufRepositoryError::Invalid("catalog historical namespace absent".into())
        })?;
        let id = entry["stable_id"].as_str().ok_or_else(|| {
            TufRepositoryError::Invalid("catalog historical stable id absent".into())
        })?;
        if entry["revision"].as_u64().is_none_or(|v| v == 0)
            || map
                .insert((namespace.to_owned(), id.to_owned()), entry.clone())
                .is_some()
        {
            return invalid("catalog historical definition revision/identity differs");
        }
    }
    Ok(map)
}
pub(super) fn historical_policy_revision(target: &str, value: &serde_json::Value) -> Result<u64> {
    let field = if target.ends_with(".launch.json") {
        "revision"
    } else {
        "policy_revision"
    };
    value[field]
        .as_u64()
        .filter(|revision| *revision > 0)
        .ok_or_else(|| {
            TufRepositoryError::Invalid("catalog historical policy/launch revision absent".into())
        })
}

#[derive(Default)]
struct HistoricalRevisionFloors {
    definitions: BTreeMap<(String, String), serde_json::Value>,
    policies: BTreeMap<String, (u64, String)>,
    seen: BTreeSet<String>,
    listing_revisions: BTreeMap<u64, String>,
    legacy_listing: Option<(super::history_checkpoint::ListingFloor, Vec<u8>)>,
    compact_listing: Option<super::history_checkpoint::ListingFloor>,
}

impl HistoricalRevisionFloors {
    fn observe(
        &mut self,
        files: &PublicHistory,
        current: &AuthenticatedTargets,
        role: &str,
        targets: &Targets,
    ) -> Result<()> {
        let definition_role = role == "official-definitions.json";
        for (target, identity) in &targets.targets {
            if definition_role && target.raw() != "definitions/index.json" {
                continue;
            }
            if target.raw() == super::history_checkpoint::TARGET {
                continue;
            }
            if !definition_role && !target.raw().starts_with("policy/official/") {
                return invalid("catalog historical policy scope differs");
            }
            let path = format!(
                "targets/{}.{}",
                hex::encode(&identity.hashes.sha256),
                target.raw()
            );
            let raw = files.get(&path).ok_or_else(|| {
                TufRepositoryError::Invalid(format!(
                    "catalog public repository file missing: {path}"
                ))
            })?;
            let maximum = if portcove_listing_carrier::is_listing_target(target.raw()) {
                portcove_listing_carrier::MAX_BYTES
            } else if target.raw() == portcove_listing_carrier::COVER_CHECKPOINT_TARGET {
                portcove_listing_carrier::COVER_CHECKPOINT_MAX
            } else if target.raw() == "definitions/index.json" {
                DEFINITION_INDEX_MAX as usize
            } else if definition_role {
                DEFINITION_CONTENT_MAX as usize
            } else {
                65536
            };
            if raw.bytes() != identity.length
                || raw.bytes() > maximum as u64
                || raw.digest() != hex::encode(&identity.hashes.sha256)
            {
                return invalid("catalog historical target identity/bound differs");
            }
            // The physical body is immutable, but every signed reference must
            // independently agree with its measured length and digest.
            if !self.seen.insert(path) {
                continue;
            }
            if target.raw() == portcove_listing_carrier::COVER_CHECKPOINT_TARGET {
                // The current authenticated target and its direct successor
                // are validated together before a role key is used.
                continue;
            }
            let body = current.historical_body(target.raw(), raw)?;
            if portcove_listing_carrier::is_listing_target(target.raw()) {
                let listing = bundle::listing_revision(target.raw(), &body)?;
                let floor = super::history_checkpoint::ListingFloor {
                    revision: listing.revision,
                    decoded_sha256: listing.decoded_sha256,
                    withdrawn_ids: listing.withdrawn_ids,
                };
                if let Some(prior) = self
                    .listing_revisions
                    .insert(floor.revision, floor.decoded_sha256.clone())
                    && prior != floor.decoded_sha256
                {
                    return invalid("catalog retained listing carrier history equivocates");
                }
                if target.raw() == portcove_listing_carrier::COMPACT_TARGET {
                    if self
                        .compact_listing
                        .as_ref()
                        .is_none_or(|prior| prior.revision < floor.revision)
                    {
                        self.compact_listing = Some(floor);
                    }
                } else if self
                    .legacy_listing
                    .as_ref()
                    .is_none_or(|(prior, _)| prior.revision < floor.revision)
                {
                    self.legacy_listing = Some((floor, body.to_vec()));
                }
            } else if definition_role {
                for (id, entry) in indexed_entries(&body)? {
                    if let Some(old) = self.definitions.get(&id) {
                        let old_revision = old["revision"].as_u64().unwrap();
                        let new_revision = entry["revision"].as_u64().unwrap();
                        if new_revision == old_revision && old != &entry {
                            return invalid("catalog retained definition history equivocates");
                        }
                        if new_revision < old_revision {
                            continue;
                        }
                    }
                    self.definitions.insert(id, entry);
                }
            } else {
                let policy: serde_json::Value = serde_json::from_slice(&body)?;
                let revision = historical_policy_revision(target.raw(), &policy)?;
                if let Some((old_revision, old_bytes)) = self.policies.get(target.raw()) {
                    if revision == *old_revision && old_bytes != raw.digest() {
                        return invalid("catalog retained policy/launch history equivocates");
                    }
                    if revision < *old_revision {
                        continue;
                    }
                }
                self.policies
                    .insert(target.raw().into(), (revision, raw.digest().to_owned()));
            }
        }
        Ok(())
    }

    fn check(&self, new: &Files) -> Result<()> {
        let current = indexed_entries(at(new, "definitions/index.json")?)?;
        for (id, old) in &self.definitions {
            if let Some(next) = current.get(id) {
                let a = old["revision"].as_u64().unwrap();
                let b = next["revision"].as_u64().unwrap();
                if b < a || (b == a && next != old) {
                    return invalid("catalog historical definition revision rollback/equivocation");
                }
            }
        }
        for (name, (revision, bytes)) in &self.policies {
            if let Some(next) = new.get(name) {
                let value: serde_json::Value = serde_json::from_slice(next)?;
                let next_revision = historical_policy_revision(name, &value)?;
                if next_revision < *revision || (next_revision == *revision && &sha(next) != bytes)
                {
                    return invalid(
                        "catalog historical policy/launch rollback or equal-revision replacement",
                    );
                }
            }
        }
        Ok(())
    }
}
pub(super) fn check_proposed_role(
    context: &Context,
    role: DefinitionOnlineRole,
    bytes: &[u8],
) -> Result<()> {
    if context.prior.is_empty() {
        return Ok(());
    }
    let prior = current_roles(&context.prior)?;
    let old: serde_json::Value =
        serde_json::from_slice(at(&prior, &format!("{}.json", role.name()))?)?;
    let new: serde_json::Value = serde_json::from_slice(bytes)?;
    if old["signed"]["version"] == new["signed"]["version"] && old["signed"] != new["signed"] {
        return invalid("catalog same-version signed content replacement");
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssemblyConfig {
    schema_version: u32,
    context: String,
    signed_roles: String,
    output: String,
    #[serde(default)]
    history_output: Option<String>,
}
/// Keyless exact role assembly followed by Tough full target verification, with no network transport.
pub async fn assemble_definition_repository(path: &Path) -> Result<DefinitionRepositoryReport> {
    let config: AssemblyConfig = io::parse(path, CONFIG_MAX)?;
    if config.schema_version != 1 {
        return invalid("catalog assembly schema differs");
    }
    let base = path.parent().unwrap_or(Path::new("."));
    let context_path = io::resolve(base, &config.context)?;
    let context = load_context(&context_path).await?;
    let roles_path = io::resolve(base, &config.signed_roles)?;
    let roles = signing::roles(&context, &roles_path, 4)?;
    let output = io::resolve(base, &config.output)?;
    let mut inputs = context.inputs.clone();
    inputs.extend([path.to_path_buf(), roles_path]);
    io::no_overlap(&output, &inputs)?;
    let history_output = match (&context.history, config.history_output.as_deref()) {
        (Some(history), Some(path)) => {
            let directory = io::resolve(base, path)?;
            io::no_overlap(&directory, &inputs)?;
            io::no_output_overlap(&directory, &output)?;
            Some((history, directory))
        }
        (None, None) => None,
        _ => {
            return invalid(
                "catalog history assembly output requires an exact checkpoint context and path",
            );
        }
    };
    let mut files = context.prior.clone();
    files.insert(
        format!("metadata/{}.root.json", context.root.signed.version),
        &context.root_bytes,
    );
    let selected_top = signing::selected_top(&context, &roles)?;
    let top_version = context
        .next_top
        .as_ref()
        .unwrap_or(&context.top.signed)
        .version;
    let top_name = format!("metadata/{top_version}.targets.json");
    if files
        .get(&top_name)
        .is_some_and(|old| !old.matches(selected_top))
    {
        return invalid("catalog immutable Targets history replacement");
    }
    files.insert(top_name, selected_top);
    for role in [
        DefinitionOnlineRole::Definitions,
        DefinitionOnlineRole::Policy,
        DefinitionOnlineRole::Snapshot,
        DefinitionOnlineRole::Timestamp,
    ] {
        let bytes = at(&roles, &format!("{}.json", role.name()))?;
        check_proposed_role(&context, role, bytes)?;
        let name = if role == DefinitionOnlineRole::Timestamp {
            "metadata/timestamp.json".into()
        } else {
            format!(
                "metadata/{}.{}.json",
                context.versions[role.index()],
                role.name()
            )
        };
        if let Some(old) = files.get(&name)
            && role != DefinitionOnlineRole::Timestamp
            && !old.matches(bytes)
        {
            return invalid("catalog immutable metadata history replacement");
        }
        files.insert(name, bytes);
    }
    for (name, bytes) in &context.targets {
        let file = public_target_path(name, bytes)?;
        if files.get(&file).is_some_and(|v| !v.matches(bytes)) {
            return invalid("catalog immutable target replacement");
        }
        files.insert(file, bytes);
    }
    check_public_capacity(
        files.len(),
        files.iter().map(|(_, file)| file.bytes()).sum(),
    )?;
    verify_history(&context, &files, |_, _| Ok(()))?;
    let logical = authenticate(
        &context.root_bytes,
        &files,
        tough::ExpirationEnforcement::Safe,
    )
    .await?;
    if logical.files != context.targets {
        return invalid("catalog full Tough readback differs from prepared bundle");
    }
    recheck(&context)?;
    if signing::roles(&context, &inputs[inputs.len() - 1], 4)? != roles {
        return invalid("catalog signed inputs changed during assembly");
    }
    let output_exists = io::directory_exists(&output)?;
    let history_directories = if let Some((history, directory)) = &history_output {
        let store = directory.join("sha256");
        let directory_exists = io::directory_exists(directory)?;
        let store_exists = directory_exists && io::directory_exists(&store)?;
        if store_exists {
            for (name, bytes) in &history.objects {
                io::output_file_exists(&directory.join(name), bytes)?;
            }
        }
        Some((directory_exists, store, store_exists))
    } else {
        None
    };
    if output_exists && public_identities(&output)? != files.identities() {
        return invalid("catalog assembly output exists with different bytes; retain original");
    }

    // Reserve both roots using exclusive directory creation before any file writes.
    // For example, Windows can allocate a short alias only after creation.
    let mut reserved = Vec::new();
    let reserve_result = (|| -> Result<()> {
        let mut reserve = |directory: &Path| -> Result<()> {
            reserved.push(io::OutputReservation::create(directory)?);
            Ok(())
        };
        if !output_exists {
            reserve(&output)?;
        }
        io::no_overlap(&output, &inputs)?;
        if let (Some((_, directory)), Some((directory_exists, store, store_exists))) =
            (&history_output, &history_directories)
        {
            if !directory_exists {
                reserve(directory)?;
            }
            io::no_overlap(directory, &inputs)?;
            io::no_output_overlap(directory, &output)?;
            if !store_exists {
                reserve(store)?;
            }
            io::no_overlap(store, &inputs)?;
            io::no_output_overlap(store, &output)?;
            for name in ["metadata", "targets"] {
                let subtree = output.join(name);
                if io::directory_exists(&subtree)? {
                    io::no_output_overlap(store, &subtree)?;
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = reserve_result {
        io::OutputReservation::remove_all_owned(reserved);
        return Err(error);
    }

    if !output_exists {
        for (name, file) in files.iter() {
            let destination = output.join(name);
            fs::create_dir_all(destination.parent().unwrap())?;
            io::create_synced(&destination, &file.read()?)?;
        }
        if public_identities(&output)? != files.identities() {
            return invalid("catalog complete assembly retained readback differs");
        }
    }
    if let Some((history, directory)) = history_output {
        for (name, bytes) in &history.objects {
            io::write_new(&directory.join(name), bytes)?;
        }
        super::history_checkpoint::read_current(
            &history.pointer_bytes,
            &directory,
            &sha(&context.root_bytes),
            &delegation_digest(&context.top.signed)?,
            context.versions[3].get(),
            context.versions[1].get(),
        )?;
    }
    recheck(&context)?;
    repository_report(
        &files,
        &context.root_bytes,
        selected_top,
        &context.index_sha256,
        !output_exists,
    )
}

fn repository_report(
    files: &PublicHistory,
    root: &[u8],
    top: &[u8],
    index_sha256: &str,
    changed: bool,
) -> Result<DefinitionRepositoryReport> {
    let identities = files.identities();
    let repository_sha256 = sha(&serde_json::to_vec(&identities)?);
    let actual_roles = current_roles(files)?;
    let mut versions = BTreeMap::new();
    let mut expires = BTreeMap::new();
    let mut cover_approvals = None;
    for (label, name) in [
        ("targets", "targets.json"),
        ("definitions", "official-definitions.json"),
        ("policy", "official-policy.json"),
        ("snapshot", "snapshot.json"),
        ("timestamp", "timestamp.json"),
    ] {
        let signed: serde_json::Value = serde_json::from_slice(at(&actual_roles, name)?)?;
        if label == "policy" {
            cover_approvals = cover_approvals_from_policy(&signed)?;
        }
        versions.insert(
            label.into(),
            signed["signed"]["version"]
                .as_u64()
                .ok_or_else(|| {
                    TufRepositoryError::Invalid("verified metadata version absent".into())
                })?
                .to_string(),
        );
        expires.insert(
            label.into(),
            signed["signed"]["expires"]
                .as_str()
                .ok_or_else(|| {
                    TufRepositoryError::Invalid("verified metadata expiry absent".into())
                })?
                .to_owned(),
        );
    }
    Ok(DefinitionRepositoryReport {
        schema_version: 1,
        changed,
        files: identities,
        repository_sha256,
        root_sha256: sha(root),
        offline_targets_sha256: sha(top),
        timestamp_sha256: sha(at(&actual_roles, "timestamp.json")?),
        snapshot_sha256: sha(at(&actual_roles, "snapshot.json")?),
        versions,
        expires,
        cover_approvals,
        index_sha256: index_sha256.to_owned(),
        authority: "none",
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerificationConfig {
    schema_version: u32,
    #[serde(default)]
    initial_root_profile: InitialRootProfile,
    trusted_root: String,
    trusted_root_sha256: String,
    offline_targets: String,
    offline_targets_sha256: String,
    repository: String,
    #[serde(default)]
    history_store: Option<String>,
}

fn delegation_digest(top: &Targets) -> Result<String> {
    Ok(sha(&io::canonical(&serde_json::to_vec(&top.delegations)?)?))
}

/// Read-only current Tough verification of already published bytes. No signing
/// context, supplied clock, output path or private key is accepted. Historical
/// admission and exact expected inventory remain the controller's separate job.
pub async fn verify_definition_repository(path: &Path) -> Result<DefinitionRepositoryReport> {
    let config_raw = io::read(path, CONFIG_MAX)?;
    let config: VerificationConfig = serde_json::from_slice(&config_raw)?;
    if config.schema_version != 1 {
        return invalid("catalog verification schema differs");
    }
    let base = path.parent().unwrap_or(Path::new("."));
    let root_path = io::resolve(base, &config.trusted_root)?;
    let top_path = io::resolve(base, &config.offline_targets)?;
    let repository_path = io::resolve(base, &config.repository)?;
    let root_bytes = io::read(&root_path, ROOT_MAX)?;
    let top_bytes = io::read(&top_path, ROLE_MAX)?;
    expected(&root_bytes, &config.trusted_root_sha256)?;
    expected(&top_bytes, &config.offline_targets_sha256)?;
    let root: Signed<Root> = serde_json::from_slice(&root_bytes)?;
    let top: Signed<Targets> = serde_json::from_slice(&top_bytes)?;
    let now = Timestamp::now();
    policy::root(&root, now, config.initial_root_profile)?;
    policy::top(&root.signed, &top, now)?;
    let files = PublicHistory::read(&repository_path)?;
    validate_public_paths(&files)?;
    if files.file(&format!("metadata/{}.root.json", root.signed.version))? != root_bytes {
        return invalid("catalog public Root differs from pinned trust anchor");
    }
    let logical = authenticate(&root_bytes, &files, tough::ExpirationEnforcement::Safe).await?;
    let roles = current_roles(&files)?;
    if at(&roles, "targets.json")? != &top_bytes {
        return invalid("catalog public offline Targets differs from appointed bytes");
    }
    if let Some(store) = config.history_store.as_deref() {
        let store = io::resolve(base, store)?;
        let timestamp: Signed<TufTimestamp> =
            serde_json::from_slice(at(&roles, "timestamp.json")?)?;
        let policy: Signed<Targets> = serde_json::from_slice(at(&roles, "official-policy.json")?)?;
        let delegation_sha256 = delegation_digest(&top.signed)?;
        super::history_checkpoint::read_current(
            at(&logical.files, super::history_checkpoint::TARGET)?,
            &store,
            &sha(&root_bytes),
            &delegation_sha256,
            timestamp.signed.version.get(),
            policy.signed.version.get(),
        )?;
    }
    let index_sha256 = sha(at(&logical.files, "definitions/index.json")?);
    if io::read(path, CONFIG_MAX)? != config_raw
        || io::read(&root_path, ROOT_MAX)? != root_bytes
        || io::read(&top_path, ROLE_MAX)? != top_bytes
        || public_identities(&repository_path)? != files.identities()
    {
        return invalid("catalog public verification inputs changed during readback");
    }
    repository_report(&files, &root_bytes, &top_bytes, &index_sha256, false)
}

fn verify_history(
    context: &Context,
    files: &PublicHistory,
    mut visit_delegated_targets: impl FnMut(&str, &Targets) -> Result<()>,
) -> Result<()> {
    for (name, file) in files
        .iter()
        .filter(|(n, _)| n.starts_with("metadata/") && n.as_str() != "metadata/timestamp.json")
    {
        let (version, role) = name[9..].split_once('.').ok_or_else(|| {
            TufRepositoryError::Invalid("catalog metadata filename malformed".into())
        })?;
        let expected_version = version.parse::<u64>().map_err(|_| {
            TufRepositoryError::Invalid("catalog metadata filename version malformed".into())
        })?;
        let bytes = &file.read()?;
        let value: serde_json::Value = serde_json::from_slice(bytes)?;
        if value["signed"]["version"].as_u64() != Some(expected_version) {
            return invalid("catalog historical metadata version/path differs");
        }
        match role {
            "root.json" => {
                if bytes != &context.root_bytes {
                    return invalid("catalog routine history cannot introduce a different root");
                }
            }
            "targets.json" => {
                let signed: Signed<Targets> = serde_json::from_slice(bytes)?;
                context.root.signed.verify_role(&signed)?;
                if context.online_targets {
                    let ceiling = context
                        .next_top
                        .as_ref()
                        .unwrap_or(&context.top.signed)
                        .version;
                    if signed.signed.version > ceiling {
                        return invalid("catalog historical Targets exceeds current floor");
                    }
                    let mut body = signed.signed;
                    body.version = context.top.signed.version;
                    body.expires = context.top.signed.expires;
                    signing::same(&body, &context.top.signed)?;
                } else if signed.signed.version > context.top.signed.version
                    || !signed.signed.targets.is_empty()
                    || serde_json::to_value(&signed.signed.delegations)?
                        != serde_json::to_value(&context.top.signed.delegations)?
                {
                    return invalid("catalog history has unappointed offline Targets/delegation");
                }
            }
            "snapshot.json" => {
                let signed: Signed<Snapshot> = serde_json::from_slice(bytes)?;
                context.root.signed.verify_role(&signed)?;
                if context.online_targets {
                    if signed
                        .signed
                        .meta
                        .keys()
                        .map(String::as_str)
                        .collect::<BTreeSet<_>>()
                        != BTreeSet::from([
                            "targets.json",
                            "official-definitions.json",
                            "official-policy.json",
                        ])
                    {
                        return invalid("catalog historical Snapshot inventory differs");
                    }
                    for (role, identity) in signed.signed.meta {
                        let file = files
                            .get(&format!("metadata/{}.{}", identity.version, role))
                            .ok_or_else(|| {
                                TufRepositoryError::Invalid(
                                    "catalog historical Snapshot role missing".into(),
                                )
                            })?;
                        let measured =
                            signing::meta_identity(file.bytes(), file.digest(), identity.version)?;
                        signing::same(&identity, &measured)?;
                    }
                }
            }
            "official-definitions.json" | "official-policy.json" => {
                let signed: Signed<Targets> = serde_json::from_slice(bytes)?;
                context
                    .top
                    .signed
                    .delegations
                    .as_ref()
                    .unwrap()
                    .verify_role(&signed, role.trim_end_matches(".json"))?;
                visit_delegated_targets(role, &signed.signed)?;
            }
            _ => return invalid("catalog historical metadata kind differs"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod capacity_tests {
    use super::*;

    #[test]
    fn repeated_historical_target_reference_still_checks_signed_length() {
        let name = "policy/official/catalog.listings.json";
        let bytes = br#"{"listing_delivery_schema":1,"revision":1,"withdrawn_ids":[],"directory":{"format_version":11,"listings":[]}}"#;
        let path = public_target_path(name, bytes).unwrap();
        let mut files = PublicHistory::default();
        files.insert(path, bytes);
        let descriptor = |length| -> Targets {
            serde_json::from_value(serde_json::json!({
                "_type":"targets",
                "spec_version":"1.0.0",
                "version":1,
                "expires":"2030-01-01T00:00:00Z",
                "targets":{(name):{"length":length,"hashes":{"sha256":sha(bytes)}}}
            }))
            .unwrap()
        };
        let mut floors = HistoricalRevisionFloors::default();
        let role = "official-policy.json";
        let current = AuthenticatedTargets::default();
        floors
            .observe(&files, &current, role, &descriptor(bytes.len()))
            .unwrap();
        floors
            .observe(&files, &current, role, &descriptor(bytes.len()))
            .unwrap();
        let error = floors
            .observe(&files, &current, role, &descriptor(bytes.len() + 1))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("historical target identity/bound differs")
        );
    }

    #[test]
    fn historical_body_reuses_only_an_exact_authenticated_current_identity() {
        let name = "policy/official/catalog.listings.json";
        let mut inventory = PublicHistory::default();
        inventory.insert("old".into(), b"old");
        inventory.insert("current".into(), b"new");
        let targets = AuthenticatedTargets {
            files: Files::from([(name.into(), b"new".to_vec())]),
            digests: BTreeMap::from([(name.into(), sha(b"new"))]),
        };
        let live = targets
            .historical_body(name, inventory.get("current").unwrap())
            .unwrap();
        assert_eq!(&*live, b"new");
        assert!(matches!(live, Cow::Borrowed(_)));
        let archived = targets
            .historical_body(name, inventory.get("old").unwrap())
            .unwrap();
        assert_eq!(&*archived, b"old");
        assert!(matches!(archived, Cow::Owned(_)));
    }

    #[test]
    fn snapshot_descriptor_matches_measured_role_identity() {
        let bytes = b"verified role";
        let version = NonZeroU64::new(1).unwrap();
        let raw = signing::meta_identity(bytes.len() as u64, &sha(bytes), version).unwrap();
        let captured_length =
            signing::meta_identity(bytes.len() as u64 + 1, &sha(bytes), version).unwrap();
        let changed =
            signing::meta_identity(bytes.len() as u64, &sha(b"other content"), version).unwrap();
        assert!(signing::same(&raw, &captured_length).is_err());
        assert!(signing::same(&raw, &changed).is_err());
    }

    #[test]
    fn retained_bound_allows_the_observed_release_and_remains_finite() {
        // The retained public files and new descriptive target from
        // publisher run 44643025884, excluding its new signed roles.
        assert!(check_public_capacity(109, 139_099_484).is_ok());
        assert!(
            check_public_capacity(PUBLIC_REPOSITORY_MAX_FILES, PUBLIC_REPOSITORY_MAX_BYTES).is_ok()
        );
        assert!(check_public_capacity(109, PUBLIC_REPOSITORY_MAX_BYTES + 1).is_err());
        assert!(check_public_capacity(PUBLIC_REPOSITORY_MAX_FILES + 1, 139_099_484).is_err());
    }

    #[test]
    fn proposed_floor_reuses_identical_hash_addressed_bytes() {
        let name = "policy/official/catalog.listings.json";
        let existing = b"retained directory".to_vec();
        let sandbox = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let retained_target = public_target_path(name, &existing).unwrap();
        for (path, bytes) in [
            ("metadata/timestamp.json", vec![1; 10]),
            ("metadata/1.root.json", vec![2; 12]),
            (retained_target.as_str(), existing.clone()),
        ] {
            let path = sandbox.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let prior = PublicHistory::read(sandbox.path()).unwrap();
        assert_eq!(
            proposed_target_floor(&prior, &Files::from([(name.into(), existing.clone())])).unwrap(),
            (2, 12 + existing.len() as u64),
        );
        let new = b"updated directory".to_vec();
        assert_eq!(
            proposed_target_floor(&prior, &Files::from([(name.into(), new.clone())])).unwrap(),
            (3, 12 + existing.len() as u64 + new.len() as u64),
        );
    }
}
