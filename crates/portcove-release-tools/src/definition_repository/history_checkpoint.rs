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
    /// The greatest observed revision and exact body for every tracked subject.
    definitions: Vec<DefinitionFloor>,
    policies: Vec<PolicyFloor>,
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
}

pub(super) struct BootstrapInput {
    pub(super) timestamp_version: u64,
    pub(super) timestamp_sha256: String,
    pub(super) root_sha256: String,
    pub(super) delegation_sha256: String,
    pub(super) definitions: Vec<DefinitionFloor>,
    pub(super) policies: Vec<PolicyFloor>,
    pub(super) files: Vec<DefinitionFile>,
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
        parent: None,
        tip: ObjectIdentity {
            bytes: 0,
            sha256: String::new(),
        },
        definitions: input.definitions,
        policies: input.policies,
    };
    validate_floors(&active)?;
    let mut previous = None;
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
) -> Result<()> {
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
    if active.checkpoint_schema != 1
        || active.root_sha256 != root_sha256
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
    let tip = read_object(store, &active.tip, SEGMENT_MAX)?;
    validate_segment(&tip, &active)
}

#[cfg(test)]
mod tests {
    use super::*;

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
