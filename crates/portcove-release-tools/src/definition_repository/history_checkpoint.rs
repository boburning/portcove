//! Bounded, content-addressed checkpoint records. The small pointer is read only
//! from the current authenticated official-policy delegation. Large active
//! summaries and immutable archive segments live outside the legacy TUF tree.
use super::*;

pub(super) const TARGET: &str = "policy/official/catalog.history-checkpoint.json";
const POINTER_MAX: usize = 4 * 1024;
const CHECKPOINT_MAX: u64 = 2 * 1024 * 1024;
const SEGMENT_MAX: u64 = 1024 * 1024;
const FLOOR_LIMIT: usize = 8_192;
const SEGMENT_FILE_LIMIT: usize = 2_048;
const ACTIVE_FILE_LIMIT: usize = 4_096;
pub(super) const THIN_MAX_FILES: usize = ACTIVE_FILE_LIMIT + 1;
pub(super) const THIN_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Every publication links one segment and one checkpoint to the previous
/// chain, so roughly 2,048 publications reach this bound. There is no bounded
/// rebase yet: reaching it stops publication before signing (the last good
/// publication stays served). This is a documented activation precondition.
const SEGMENT_CHAIN_LIMIT: usize = 4_096;
const CHAIN_METADATA_MAX: u64 = 64 * 1024 * 1024;
const CHAIN_BOUND_REACHED: &str = "catalog history chain reached its verification bound; \
publication stops before signing and the last good publication stays served until a bounded \
checkpoint rebase exists";
const ROOT_ROTATED: &str = "catalog history checkpoint was made under a different trusted root; \
publication stops before signing until root rotation with checkpointed history is defined";
const PATH_LIMIT: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ObjectIdentity {
    bytes: u64,
    sha256: String,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyPointer {
    checkpoint_schema: u32,
    policy_revision: u64,
    active: ObjectIdentity,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DefinitionFloor {
    pub(super) namespace: String,
    pub(super) stable_id: String,
    pub(super) revision: u64,
    pub(super) entry_sha256: String,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PolicyFloor {
    pub(super) target: String,
    pub(super) revision: u64,
    pub(super) target_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ListingFloor {
    pub(super) revision: u64,
    pub(super) decoded_sha256: String,
    pub(super) withdrawn_ids: BTreeSet<String>,
}

pub(super) fn check_listings(
    proposal: &Files,
    prior_legacy: Option<(&ListingFloor, &[u8])>,
    prior_compact: Option<&ListingFloor>,
) -> Result<()> {
    use portcove_listing_carrier::{COMPACT_TARGET, LEGACY_TARGET};

    let next = super::bundle::listing_targets(proposal)?;
    // After a reviewed return to legacy-only delivery the retained legacy floor
    // can exceed the last compact floor; every successor must exceed both.
    let floor = [prior_compact, prior_legacy.map(|(legacy, _)| legacy)]
        .into_iter()
        .flatten()
        .max_by_key(|floor| floor.revision);
    if let Some(prior) = prior_compact {
        // Returning to legacy-only delivery keeps every compact reader's replay
        // floor and authenticated withdrawals: the legacy successor must exceed
        // both carriers' revisions and retain every compact withdrawal.
        let (carrier, withdrawals) = match (&next.compact, &next.legacy) {
            (Some(compact), _) => ("compact", &compact.withdrawn_ids),
            (None, Some(legacy)) => {
                if floor.is_some_and(|floor| legacy.revision <= floor.revision) {
                    return invalid(
                        "catalog legacy-only listing return must exceed the compact revision",
                    );
                }
                ("legacy", &legacy.withdrawn_ids)
            }
            (None, None) => {
                return invalid("catalog compact listing cannot be withdrawn without a carrier");
            }
        };
        if !prior.withdrawn_ids.is_subset(withdrawals) {
            return invalid(if carrier == "compact" {
                "catalog compact listing removed an authenticated historical withdrawal"
            } else {
                "catalog legacy-only listing return removed an authenticated compact withdrawal"
            });
        }
    }
    if let Some(next_legacy) = next.legacy.as_ref().filter(|_| next.compact.is_some()) {
        let Some((legacy, prior)) = prior_legacy else {
            return invalid("catalog compact publication needs authenticated legacy history");
        };
        if legacy.decoded_sha256 != next_legacy.decoded_sha256 {
            if prior_compact.is_none()
                || floor.is_some_and(|floor| next_legacy.revision <= floor.revision)
            {
                return invalid(
                    "catalog compact publication must preserve its last legacy listing bytes",
                );
            }
            let (compact, _) = portcove_listing_carrier::decode(&proposal[COMPACT_TARGET])
                .map_err(|error| TufRepositoryError::Invalid(error.to_string()))?;
            super::bundle::check_legacy_successor(prior, &proposal[LEGACY_TARGET], &compact)?;
        }
    }
    if let Some(floor) = floor
        && next
            .compact
            .as_ref()
            .or(next.legacy.as_ref())
            .is_some_and(|next| {
                next.revision < floor.revision
                    || (next.revision == floor.revision
                        && next.decoded_sha256 != floor.decoded_sha256)
            })
    {
        return invalid(if prior_compact.is_none() && next.compact.is_none() {
            "catalog historical policy/launch rollback or equal-revision replacement"
        } else {
            "catalog historical listing revision rollback/equivocation"
        });
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActiveCheckpoint {
    checkpoint_schema: u32,
    covered_timestamp_version: u64,
    covered_timestamp_sha256: String,
    root_sha256: String,
    delegation_sha256: String,
    /// Immutable previous active object, when already checkpointed.
    parent: Option<ObjectIdentity>,
    tip: ObjectIdentity,
    /// Bound current metadata and target identities at the covered generation.
    /// These establish an incremental suffix without retaining the full archive.
    active_files: Vec<DefinitionFile>,
    /// The greatest observed revision and exact body for every tracked subject.
    definitions: Vec<DefinitionFloor>,
    policies: Vec<PolicyFloor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy_listing: Option<ListingFloor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    compact_listing: Option<ListingFloor>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InventorySegment {
    checkpoint_schema: u32,
    through_timestamp_version: u64,
    through_timestamp_sha256: String,
    previous: Option<ObjectIdentity>,
    /// Immutable catalog-relative files added in this segment. Earlier files
    /// are represented by previous segments, not repeated in a signer input.
    files: Vec<DefinitionFile>,
}

fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn identity_valid(value: &ObjectIdentity, limit: u64) -> bool {
    (1..=limit).contains(&value.bytes) && digest_valid(&value.sha256)
}

fn read_object<T>(store: &Path, identity: &ObjectIdentity, limit: u64) -> Result<T>
where
    T: serde::de::DeserializeOwned + Serialize,
{
    if !identity_valid(identity, limit) {
        return invalid("catalog history object identity exceeds its bound");
    }
    let path = store
        .join("sha256")
        .join(format!("{}.json", identity.sha256));
    io::ancestry(path.parent().unwrap())?;
    let raw = io::read(&path, identity.bytes)?;
    if raw.len() as u64 != identity.bytes || sha(&raw) != identity.sha256 {
        return invalid("catalog history object differs from its authenticated identity");
    }
    let decoded = serde_json::from_slice(&raw)?;
    if serde_json::to_vec(&decoded)? != raw {
        return invalid("catalog history object is not canonical");
    }
    Ok(decoded)
}

fn subject(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn validate_floors(checkpoint: &ActiveCheckpoint) -> Result<()> {
    if checkpoint.definitions.len() > FLOOR_LIMIT || checkpoint.policies.len() > FLOOR_LIMIT {
        return invalid("catalog history active floor exceeds its entry bound");
    }
    let mut previous_definition = None;
    for floor in &checkpoint.definitions {
        let subject_key = (floor.namespace.as_str(), floor.stable_id.as_str());
        if !subject(&floor.namespace)
            || !subject(&floor.stable_id)
            || floor.revision == 0
            || !digest_valid(&floor.entry_sha256)
            || previous_definition.is_some_and(|previous| previous >= subject_key)
        {
            return invalid("catalog history definition floor identity differs");
        }
        previous_definition = Some(subject_key);
    }
    for floor in [&checkpoint.legacy_listing, &checkpoint.compact_listing]
        .into_iter()
        .flatten()
    {
        if floor.revision == 0 || !digest_valid(&floor.decoded_sha256) {
            return invalid("catalog history listing floor identity differs");
        }
    }
    if let Some(compact) = &checkpoint.compact_listing
        && checkpoint.legacy_listing.as_ref().is_none_or(|legacy| {
            compact.revision < legacy.revision
                || (compact.revision == legacy.revision && compact != legacy)
                || !legacy.withdrawn_ids.is_subset(&compact.withdrawn_ids)
        })
    {
        return invalid("catalog checkpoint listing carrier continuity differs");
    }
    let mut previous_policy = None;
    for floor in &checkpoint.policies {
        io::relative(&floor.target)?;
        if !floor.target.starts_with("policy/official/")
            || !floor.target.ends_with(".json")
            || floor.target == TARGET
            || floor.revision == 0
            || !digest_valid(&floor.target_sha256)
            || previous_policy.is_some_and(|previous| previous >= floor.target.as_str())
        {
            return invalid("catalog history policy floor identity differs");
        }
        previous_policy = Some(floor.target.as_str());
    }
    Ok(())
}

fn validate_segment(segment: &InventorySegment, active: &ActiveCheckpoint) -> Result<()> {
    if segment.checkpoint_schema != 1
        || segment.through_timestamp_version != active.covered_timestamp_version
        || segment.through_timestamp_sha256 != active.covered_timestamp_sha256
        || segment
            .previous
            .as_ref()
            .is_some_and(|previous| !identity_valid(previous, SEGMENT_MAX))
        || segment.files.is_empty()
        || segment.files.len() > SEGMENT_FILE_LIMIT
    {
        return invalid("catalog history segment differs from its checkpoint or bound");
    }
    let mut previous = None;
    let mut total = 0;
    for file in &segment.files {
        io::relative(&file.target)?;
        let immutable = if let Some(versioned) = file.target.strip_prefix("metadata/") {
            versioned.split_once('.').is_some_and(|(version, role)| {
                version.parse::<NonZeroU64>().is_ok()
                    && matches!(
                        role,
                        "root.json"
                            | "targets.json"
                            | "snapshot.json"
                            | "official-definitions.json"
                            | "official-policy.json"
                    )
            })
        } else if let Some(addressed) = file.target.strip_prefix("targets/") {
            addressed.split_once('.').is_some_and(|(digest, logical)| {
                digest == file.sha256
                    && (logical == "definitions/index.json"
                        || logical.starts_with("sha256/")
                        || logical.starts_with("policy/official/"))
            })
        } else {
            false
        };
        if !immutable
            || file.target.len() > PATH_LIMIT
            || file.bytes == 0
            || !digest_valid(&file.sha256)
            || previous.is_some_and(|previous| previous >= file.target.as_str())
        {
            return invalid("catalog history segment file identity differs");
        }
        total = u64::checked_add(total, file.bytes)
            .filter(|total| *total <= PUBLIC_REPOSITORY_MAX_BYTES)
            .ok_or_else(|| {
                TufRepositoryError::Invalid("catalog history segment exceeds its byte bound".into())
            })?;
        previous = Some(file.target.as_str());
    }
    Ok(())
}

pub(super) struct PreparedHistory {
    pub(super) pointer_bytes: Vec<u8>,
    pub(super) objects: Files,
    pub(super) readback: Vec<(PathBuf, u64, String)>,
}

pub(super) struct BootstrapInput {
    pub(super) timestamp_version: u64,
    pub(super) timestamp_sha256: String,
    pub(super) root_sha256: String,
    pub(super) delegation_sha256: String,
    pub(super) definitions: Vec<DefinitionFloor>,
    pub(super) policies: Vec<PolicyFloor>,
    pub(super) legacy_listing: Option<ListingFloor>,
    pub(super) compact_listing: Option<ListingFloor>,
    pub(super) files: Vec<DefinitionFile>,
    pub(super) active_files: Vec<DefinitionFile>,
}

fn append_object<T: Serialize>(
    objects: &mut Files,
    value: &T,
    limit: u64,
) -> Result<ObjectIdentity> {
    let raw = serde_json::to_vec(value)?;
    let identity = ObjectIdentity {
        bytes: raw.len() as u64,
        sha256: sha(&raw),
    };
    if !identity_valid(&identity, limit) {
        return invalid("catalog history object exceeds its byte capacity");
    }
    objects.insert(format!("sha256/{}.json", identity.sha256), raw);
    Ok(identity)
}

pub(super) fn bootstrap(
    input: BootstrapInput,
    next_timestamp: u64,
    next_policy: u64,
) -> Result<PreparedHistory> {
    prepare(input, next_timestamp, next_policy, None, None)
}

fn prepare(
    input: BootstrapInput,
    next_timestamp: u64,
    next_policy: u64,
    parent: Option<ObjectIdentity>,
    predecessor_tip: Option<ObjectIdentity>,
) -> Result<PreparedHistory> {
    if input.timestamp_version.checked_add(1) != Some(next_timestamp) || next_policy == 0 {
        return invalid("catalog history checkpoint requires an exact successor generation");
    }
    let mut objects = Files::new();
    let mut active = ActiveCheckpoint {
        checkpoint_schema: 1,
        covered_timestamp_version: input.timestamp_version,
        covered_timestamp_sha256: input.timestamp_sha256,
        root_sha256: input.root_sha256,
        delegation_sha256: input.delegation_sha256,
        parent,
        active_files: input.active_files,
        tip: ObjectIdentity {
            bytes: 0,
            sha256: String::new(),
        },
        definitions: input.definitions,
        policies: input.policies,
        legacy_listing: input.legacy_listing,
        compact_listing: input.compact_listing,
    };
    validate_floors(&active)?;
    validate_active_files(&active)?;
    let mut previous = predecessor_tip;
    for files in input.files.chunks(SEGMENT_FILE_LIMIT) {
        let segment = InventorySegment {
            checkpoint_schema: 1,
            through_timestamp_version: active.covered_timestamp_version,
            through_timestamp_sha256: active.covered_timestamp_sha256.clone(),
            previous,
            files: files.to_vec(),
        };
        validate_segment(&segment, &active)?;
        previous = Some(append_object(&mut objects, &segment, SEGMENT_MAX)?);
    }
    if input.files.is_empty() {
        return invalid("catalog history requires an immutable generation suffix");
    }
    active.tip = previous.ok_or_else(|| {
        TufRepositoryError::Invalid(
            "catalog history bootstrap requires an immutable inventory".into(),
        )
    })?;
    let identity = append_object(&mut objects, &active, CHECKPOINT_MAX)?;
    let pointer = PolicyPointer {
        checkpoint_schema: 1,
        policy_revision: next_policy,
        active: identity,
    };
    Ok(PreparedHistory {
        pointer_bytes: serde_json::to_vec(&pointer)?,
        objects,
        readback: vec![],
    })
}

/// The caller has already obtained `pointer_bytes` through current authenticated
/// TUF, and passes that verified chain's root, delegation and role versions.
pub(super) fn read_current(
    pointer_bytes: &[u8],
    store: &Path,
    root_sha256: &str,
    delegation_sha256: &str,
    timestamp_version: u64,
    policy_version: u64,
) -> Result<VerifiedHistory> {
    if pointer_bytes.len() > POINTER_MAX {
        return invalid("catalog history pointer exceeds its byte bound");
    }
    let pointer: PolicyPointer = serde_json::from_slice(pointer_bytes)?;
    if pointer.checkpoint_schema != 1
        || pointer.policy_revision != policy_version
        || serde_json::to_vec(&pointer)? != pointer_bytes
    {
        return invalid("catalog history pointer contradicts the current policy role");
    }
    let active: ActiveCheckpoint = read_object(store, &pointer.active, CHECKPOINT_MAX)?;
    if active.checkpoint_schema == 1 && active.root_sha256 != root_sha256 {
        return invalid(ROOT_ROTATED);
    }
    if active.checkpoint_schema != 1
        || active.delegation_sha256 != delegation_sha256
        || !digest_valid(&active.covered_timestamp_sha256)
        || active.covered_timestamp_version == 0
        || active.covered_timestamp_version.checked_add(1) != Some(timestamp_version)
        || active.parent.as_ref().is_some_and(|parent| {
            !identity_valid(parent, CHECKPOINT_MAX) || parent == &pointer.active
        })
    {
        return invalid("catalog history checkpoint contradicts its authority or generation");
    }
    validate_floors(&active)?;
    validate_active_files(&active)?;
    let tip = read_object(store, &active.tip, SEGMENT_MAX)?;
    validate_segment(&tip, &active)?;
    Ok(VerifiedHistory {
        active,
        identity: pointer.active,
    })
}

fn validate_active_files(active: &ActiveCheckpoint) -> Result<()> {
    if active.active_files.len() > ACTIVE_FILE_LIMIT {
        return invalid("catalog history active file inventory exceeds its bound");
    }
    // An active inventory uses the exact same immutable key rules as a segment.
    for chunk in active.active_files.chunks(SEGMENT_FILE_LIMIT) {
        validate_segment(
            &InventorySegment {
                checkpoint_schema: 1,
                through_timestamp_version: active.covered_timestamp_version,
                through_timestamp_sha256: active.covered_timestamp_sha256.clone(),
                previous: None,
                files: chunk.to_vec(),
            },
            active,
        )?;
    }
    if !active
        .active_files
        .windows(2)
        .all(|pair| pair[0].target < pair[1].target)
    {
        return invalid("catalog history active file inventory is unordered");
    }
    Ok(())
}

pub(super) struct VerifiedHistory {
    active: ActiveCheckpoint,
    identity: ObjectIdentity,
}

impl VerifiedHistory {
    pub(super) fn readback(&self, store: &Path) -> Vec<(PathBuf, u64, String)> {
        [&self.identity, &self.active.tip]
            .into_iter()
            .map(|identity| {
                (
                    store
                        .join("sha256")
                        .join(format!("{}.json", identity.sha256)),
                    identity.bytes,
                    identity.sha256.clone(),
                )
            })
            .collect()
    }

    /// Authenticate the archived object chain before keyless publication,
    /// comparing every claimed historical identity with physical SHA-256.
    pub(super) fn verify_archive(&self, store: &Path, actual: &[DefinitionFile]) -> Result<()> {
        self.verify_archive_within(store, actual, SEGMENT_CHAIN_LIMIT, CHAIN_METADATA_MAX)
    }

    fn verify_archive_within(
        &self,
        store: &Path,
        actual: &[DefinitionFile],
        object_limit: usize,
        byte_limit: u64,
    ) -> Result<()> {
        let actual: BTreeMap<_, _> = actual
            .iter()
            .map(|file| (file.target.as_str(), file))
            .collect();
        let mut next = Some(self.active.tip.clone());
        let mut seen = BTreeSet::new();
        let mut maximum_version = self.active.covered_timestamp_version;
        let mut budget = byte_limit;
        while let Some(object) = next.take() {
            if seen.len() >= object_limit || object.bytes > budget {
                return invalid(CHAIN_BOUND_REACHED);
            }
            if !seen.insert(object.sha256.clone()) {
                return invalid("catalog history segment chain repeats an object");
            }
            budget -= object.bytes;
            let segment: InventorySegment = read_object(store, &object, SEGMENT_MAX)?;
            if segment.through_timestamp_version == 0
                || segment.through_timestamp_version > maximum_version
                || maximum_version - segment.through_timestamp_version > 1
                || !digest_valid(&segment.through_timestamp_sha256)
            {
                return invalid("catalog history segment continuity differs");
            }
            for file in &segment.files {
                if actual.get(file.target.as_str()) != Some(&file) {
                    return invalid(
                        "catalog history segment names a missing or changed immutable file",
                    );
                }
            }
            maximum_version = segment.through_timestamp_version;
            next = segment.previous;
        }
        let mut parent = self.active.parent.clone();
        let mut version = self.active.covered_timestamp_version;
        while let Some(object) = parent.take() {
            if seen.len() >= object_limit || object.bytes > budget {
                return invalid(CHAIN_BOUND_REACHED);
            }
            if !seen.insert(object.sha256.clone()) {
                return invalid("catalog history checkpoint parent chain repeats an object");
            }
            budget -= object.bytes;
            let previous: ActiveCheckpoint = read_object(store, &object, CHECKPOINT_MAX)?;
            if previous.checkpoint_schema != 1
                || previous.covered_timestamp_version.checked_add(1) != Some(version)
                || previous.root_sha256 != self.active.root_sha256
                || previous.delegation_sha256 != self.active.delegation_sha256
                || !seen.contains(&previous.tip.sha256)
            {
                return invalid("catalog history checkpoint parent linkage differs");
            }
            version = previous.covered_timestamp_version;
            parent = previous.parent;
        }
        Ok(())
    }

    pub(super) fn check_new(&self, new: &Files) -> Result<()> {
        let index = new.get("definitions/index.json").ok_or_else(|| {
            TufRepositoryError::Invalid("catalog proposed definition index is absent".into())
        })?;
        let index = super::repository::indexed_entries(index)?;
        for floor in &self.active.definitions {
            if let Some(record) = index.get(&(floor.namespace.clone(), floor.stable_id.clone())) {
                let revision = record["revision"].as_u64().unwrap();
                let digest = sha(&io::canonical(&serde_json::to_vec(record)?)?);
                if revision < floor.revision
                    || (revision == floor.revision && digest != floor.entry_sha256)
                {
                    return invalid("catalog checkpointed definition rollback or equivocation");
                }
            }
        }
        if let Some(floor) = &self.active.legacy_listing
            && let Some(bytes) = new.get(portcove_listing_carrier::LEGACY_TARGET)
        {
            let listing =
                super::bundle::listing_revision(portcove_listing_carrier::LEGACY_TARGET, bytes)?;
            if listing.revision < floor.revision
                || (listing.revision == floor.revision
                    && listing.decoded_sha256 != floor.decoded_sha256)
            {
                return invalid("catalog checkpointed legacy listing rollback or equivocation");
            }
        }
        for floor in &self.active.policies {
            if let Some(bytes) = new.get(&floor.target) {
                if portcove_listing_carrier::is_listing_target(&floor.target) {
                    let listing = super::bundle::listing_revision(&floor.target, bytes)?;
                    if listing.revision < floor.revision
                        || (listing.revision == floor.revision
                            && listing.decoded_sha256 != floor.target_sha256)
                    {
                        return invalid("catalog checkpointed listing rollback or equivocation");
                    }
                    continue;
                }
                let value: serde_json::Value = serde_json::from_slice(bytes)?;
                let revision =
                    super::repository::historical_policy_revision(&floor.target, &value)?;
                if revision < floor.revision
                    || (revision == floor.revision && sha(bytes) != floor.target_sha256)
                {
                    return invalid("catalog checkpointed policy rollback or equivocation");
                }
            }
        }
        Ok(())
    }

    pub(super) fn advance(
        self,
        mut current: BootstrapInput,
        next_timestamp: u64,
        next_policy: u64,
    ) -> Result<PreparedHistory> {
        if self.active.root_sha256 != current.root_sha256 {
            return invalid(ROOT_ROTATED);
        }
        if self.active.covered_timestamp_version.checked_add(1) != Some(current.timestamp_version)
            || self.active.delegation_sha256 != current.delegation_sha256
        {
            return invalid("catalog history checkpoint successor is discontinuous");
        }
        let prior_files: BTreeMap<_, _> = self
            .active
            .active_files
            .iter()
            .map(|file| (file.target.as_str(), file))
            .collect();
        current.files.clear();
        for file in &current.active_files {
            match prior_files.get(file.target.as_str()) {
                Some(expected) if *expected != file => {
                    return invalid("catalog history active immutable identity changed");
                }
                Some(_) => {}
                None => current.files.push(file.clone()),
            }
        }
        let mut definitions: BTreeMap<_, _> = self
            .active
            .definitions
            .into_iter()
            .map(|floor| ((floor.namespace.clone(), floor.stable_id.clone()), floor))
            .collect();
        for floor in current.definitions {
            let key = (floor.namespace.clone(), floor.stable_id.clone());
            if definitions.get(&key).is_some_and(|prior| {
                floor.revision < prior.revision
                    || (floor.revision == prior.revision
                        && floor.entry_sha256 != prior.entry_sha256)
            }) {
                return invalid("catalog history definition revision rollback or equivocation");
            }
            definitions.insert(key, floor);
        }
        current.definitions = definitions.into_values().collect();
        let mut policies: BTreeMap<_, _> = self
            .active
            .policies
            .into_iter()
            .map(|floor| (floor.target.clone(), floor))
            .collect();
        for floor in current.policies {
            if policies.get(&floor.target).is_some_and(|prior| {
                floor.revision < prior.revision
                    || (floor.revision == prior.revision
                        && floor.target_sha256 != prior.target_sha256)
            }) {
                return invalid("catalog history policy revision rollback or equivocation");
            }
            policies.insert(floor.target.clone(), floor);
        }
        for carrier in [
            portcove_listing_carrier::LEGACY_TARGET,
            portcove_listing_carrier::COMPACT_TARGET,
        ] {
            if let Some(old) = policies.remove(carrier) {
                let known = if carrier == portcove_listing_carrier::LEGACY_TARGET {
                    &current.legacy_listing
                } else {
                    &current.compact_listing
                };
                if known.as_ref().is_none_or(|next| {
                    next.revision < old.revision
                        || (next.revision == old.revision
                            && next.decoded_sha256 != old.target_sha256)
                }) {
                    return invalid(
                        "catalog checkpoint listing migration requires its authenticated retained carrier",
                    );
                }
            }
        }
        current.policies = policies.into_values().collect();
        for (previous, next) in [
            (&self.active.legacy_listing, &mut current.legacy_listing),
            (&self.active.compact_listing, &mut current.compact_listing),
        ] {
            if let Some(previous) = previous {
                if next.as_ref().is_some_and(|next| {
                    next.revision < previous.revision
                        || (next.revision == previous.revision && next != previous)
                        || (self.active.compact_listing.is_some()
                            && !previous.withdrawn_ids.is_subset(&next.withdrawn_ids))
                }) {
                    return invalid("catalog history checkpoint listing rollback or equivocation");
                }
                if next.is_none() {
                    if self.active.compact_listing.is_some() {
                        return invalid(
                            "catalog history checkpoint listing requires its authenticated retained carriers",
                        );
                    }
                    *next = Some(previous.clone());
                }
            }
        }
        prepare(
            current,
            next_timestamp,
            next_policy,
            Some(self.identity),
            Some(self.active.tip),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_file(version: u64) -> DefinitionFile {
        DefinitionFile {
            target: format!("metadata/{version}.snapshot.json"),
            bytes: 150,
            sha256: format!("{:064x}", version),
        }
    }

    fn chain_input(root: &str, version: u64, active_files: Vec<DefinitionFile>) -> BootstrapInput {
        BootstrapInput {
            timestamp_version: version,
            timestamp_sha256: "c".repeat(64),
            root_sha256: root.into(),
            delegation_sha256: "b".repeat(64),
            definitions: vec![],
            policies: vec![],
            legacy_listing: None,
            compact_listing: None,
            files: active_files.clone(),
            active_files,
        }
    }

    fn store_objects(store: &Path, prepared: &PreparedHistory) {
        fs::create_dir_all(store.join("sha256")).unwrap();
        for (name, body) in &prepared.objects {
            fs::write(store.join(name), body).unwrap();
        }
    }

    /// Bootstraps at timestamp 45 and advances `publications` times, returning
    /// the current verified checkpoint and every archived immutable file.
    fn checkpoint_chain(
        store: &Path,
        root: &str,
        publications: u64,
    ) -> (VerifiedHistory, Vec<DefinitionFile>) {
        let mut files = vec![snapshot_file(45)];
        let mut prepared = bootstrap(chain_input(root, 45, files.clone()), 46, 41).unwrap();
        store_objects(store, &prepared);
        for step in 0..publications {
            let version = 46 + step;
            let verified = read_current(
                &prepared.pointer_bytes,
                store,
                root,
                &"b".repeat(64),
                version,
                41 + step,
            )
            .unwrap();
            files.push(snapshot_file(version));
            prepared = verified
                .advance(
                    chain_input(root, version, files.clone()),
                    version + 1,
                    42 + step,
                )
                .unwrap();
            store_objects(store, &prepared);
        }
        let verified = read_current(
            &prepared.pointer_bytes,
            store,
            root,
            &"b".repeat(64),
            46 + publications,
            41 + publications,
        )
        .unwrap();
        (verified, files)
    }

    #[test]
    fn reaching_the_chain_bound_stops_publication_with_an_explicit_error() {
        let directory = tempfile::tempdir().unwrap();
        let root = "a".repeat(64);
        // Three advances: four segments plus three parent checkpoints.
        let (verified, files) = checkpoint_chain(directory.path(), &root, 3);
        verified.verify_archive(directory.path(), &files).unwrap();
        verified
            .verify_archive_within(directory.path(), &files, 7, CHAIN_METADATA_MAX)
            .unwrap();
        for (objects, bytes) in [(6, CHAIN_METADATA_MAX), (3, CHAIN_METADATA_MAX), (7, 1_024)] {
            let error = verified
                .verify_archive_within(directory.path(), &files, objects, bytes)
                .unwrap_err()
                .to_string();
            assert!(error.contains(CHAIN_BOUND_REACHED), "{error}");
        }
        // Each publication adds one segment and one parent, so the production
        // bound admits only a finite number of publications without a rebase.
        assert_eq!(SEGMENT_CHAIN_LIMIT, 4_096);
    }

    #[test]
    fn a_root_rotation_stops_checkpointed_publication_explicitly() {
        let directory = tempfile::tempdir().unwrap();
        let root = "a".repeat(64);
        let rotated = "f".repeat(64);
        let mut files = vec![snapshot_file(45)];
        let prepared = bootstrap(chain_input(&root, 45, files.clone()), 46, 41).unwrap();
        store_objects(directory.path(), &prepared);
        let error = read_current(
            &prepared.pointer_bytes,
            directory.path(),
            &rotated,
            &"b".repeat(64),
            46,
            41,
        )
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains(ROOT_ROTATED), "{error}");
        let verified = read_current(
            &prepared.pointer_bytes,
            directory.path(),
            &root,
            &"b".repeat(64),
            46,
            41,
        )
        .unwrap();
        files.push(snapshot_file(46));
        let error = verified
            .advance(chain_input(&rotated, 46, files), 47, 42)
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains(ROOT_ROTATED), "{error}");
    }

    #[test]
    fn bootstrap_binds_a_small_active_index_to_immutable_segment_bytes() {
        let root = "a".repeat(64);
        let appointment = "b".repeat(64);
        let timestamp = "c".repeat(64);
        let input = BootstrapInput {
            timestamp_version: 45,
            timestamp_sha256: timestamp,
            root_sha256: root.clone(),
            delegation_sha256: appointment.clone(),
            definitions: vec![DefinitionFloor {
                namespace: "official".into(),
                stable_id: "fixture".into(),
                revision: 2,
                entry_sha256: "d".repeat(64),
            }],
            policies: vec![],
            legacy_listing: None,
            compact_listing: None,
            active_files: vec![],
            files: vec![DefinitionFile {
                target: "metadata/45.snapshot.json".into(),
                bytes: 150,
                sha256: "e".repeat(64),
            }],
        };
        let prepared = bootstrap(input, 46, 41).unwrap();
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("sha256")).unwrap();
        for (name, body) in &prepared.objects {
            fs::write(directory.path().join(name), body).unwrap();
        }
        let read = |ts, role| {
            read_current(
                &prepared.pointer_bytes,
                directory.path(),
                &root,
                &appointment,
                ts,
                role,
            )
        };
        read(46, 41).unwrap();
        assert!(read(45, 41).is_err());
        assert!(read(46, 42).is_err());
        let pointer: PolicyPointer = serde_json::from_slice(&prepared.pointer_bytes).unwrap();
        let active: ActiveCheckpoint =
            read_object(directory.path(), &pointer.active, CHECKPOINT_MAX).unwrap();
        fs::write(
            directory
                .path()
                .join("sha256")
                .join(format!("{}.json", active.tip.sha256)),
            b"x",
        )
        .unwrap();
        assert!(read(46, 41).is_err());
    }
}
