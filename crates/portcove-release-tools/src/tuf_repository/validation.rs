use super::*;

pub(super) fn read_regular_bounded(
    path: &Path,
    maximum: u64,
    label: &str,
) -> Result<Vec<u8>, TufRepositoryError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| TufRepositoryError::Invalid(format!("{label} is unavailable: {error}")))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > maximum {
        return Err(TufRepositoryError::Invalid(format!(
            "{label} must be a bounded regular file"
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > maximum {
        return Err(TufRepositoryError::Invalid(format!(
            "{label} changed outside its byte limit while reading"
        )));
    }
    Ok(bytes)
}

pub(super) fn resolve(
    base: &Path,
    value: &str,
    label: &str,
) -> Result<PathBuf, TufRepositoryError> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(TufRepositoryError::Invalid(format!(
            "{label} path is invalid"
        )));
    }
    let path = Path::new(value);
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    })
}

pub(super) fn nonzero(value: u64, label: &str) -> Result<NonZeroU64, TufRepositoryError> {
    NonZeroU64::new(value)
        .ok_or_else(|| TufRepositoryError::Invalid(format!("{label} version must be positive")))
}

pub(super) fn expiration(value: &str, label: &str) -> Result<Timestamp, TufRepositoryError> {
    value.parse().map_err(|_| {
        TufRepositoryError::Invalid(format!("{label} expiration must be an RFC 3339 timestamp"))
    })
}

pub(super) fn expiry_window(
    generated_at: Timestamp,
    now: Timestamp,
    expires: Timestamp,
    maximum: Duration,
    label: &str,
) -> Result<(), TufRepositoryError> {
    let maximum = generated_at.checked_add(maximum).map_err(|_| {
        TufRepositoryError::Invalid("repository expiration window overflowed".into())
    })?;
    if expires <= generated_at || expires <= now || expires > maximum {
        return Err(TufRepositoryError::Invalid(format!(
            "{label} expiration is outside its allowed window"
        )));
    }
    Ok(())
}

pub(super) fn validate_root_contract(
    root: &Root,
    generated_at: Timestamp,
    now: Timestamp,
    signing_key_ids: &[Vec<u8>; 6],
) -> Result<(), TufRepositoryError> {
    if !root.consistent_snapshot {
        return Err(TufRepositoryError::Invalid(
            "trusted root must require consistent snapshots".into(),
        ));
    }
    expiry_window(
        generated_at,
        now,
        root.expires,
        Duration::from_secs(365 * 86_400),
        "root",
    )?;
    let root_role = root
        .roles
        .get(&RoleType::Root)
        .ok_or_else(|| TufRepositoryError::Invalid("trusted root omits the root role".into()))?;
    let root_keys: BTreeSet<_> = root_role.keyids.iter().collect();
    if root_role.threshold.get() != 2 || root_keys.len() < 3 {
        return Err(TufRepositoryError::Invalid(
            "trusted root needs at least three keys and a two-signature quorum".into(),
        ));
    }
    let mut online_keys = BTreeSet::new();
    for (role, expected_key_id) in [
        (RoleType::Targets, &signing_key_ids[0]),
        (RoleType::Snapshot, &signing_key_ids[1]),
        (RoleType::Timestamp, &signing_key_ids[2]),
    ] {
        let keys = root.roles.get(&role).ok_or_else(|| {
            TufRepositoryError::Invalid(format!("trusted root omits the {role} role"))
        })?;
        if keys.threshold != NonZeroU64::MIN || keys.keyids.len() != 1 {
            return Err(TufRepositoryError::Invalid(format!(
                "trusted root {role} must use one key with threshold one"
            )));
        }
        let identity = &keys.keyids[0];
        if identity.as_ref() != expected_key_id.as_slice() {
            return Err(TufRepositoryError::Invalid(format!(
                "configured {role} key differs from the trusted root"
            )));
        }
        if root_keys.contains(identity) || !online_keys.insert(identity) {
            return Err(TufRepositoryError::Invalid(
                "trusted root roles must use distinct offline and online keys".into(),
            ));
        }
    }
    Ok(())
}

fn safe_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

pub(super) fn target_path(value: &str) -> Result<(), TufRepositoryError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 512
        || value.contains('\\')
        || path.is_absolute()
        || path.components().any(|component| {
            !matches!(component, Component::Normal(_))
                || component
                    .as_os_str()
                    .to_str()
                    .is_none_or(|segment| !safe_path_segment(segment))
        })
    {
        return Err(TufRepositoryError::Invalid(format!(
            "unsafe reconstructed target path: {value}"
        )));
    }
    Ok(())
}

pub(super) fn lowercase_sha256(value: &str, label: &str) -> Result<(), TufRepositoryError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(TufRepositoryError::Invalid(format!(
            "{label} must be a lowercase SHA-256"
        )));
    }
    Ok(())
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(super) fn consistent_target_files(
    logical: &BTreeMap<String, Vec<u8>>,
) -> BTreeMap<String, Vec<u8>> {
    logical
        .iter()
        .map(|(path, bytes)| (format!("{}.{}", sha256(bytes), path), bytes.clone()))
        .collect()
}

pub(super) fn validate_payload_registry(bytes: &[u8]) -> Result<(), TufRepositoryError> {
    let registry: PayloadKeyRegistry = serde_json::from_slice(bytes)?;
    if registry.schema_version != 1 || registry.keys.is_empty() || registry.keys.len() > 16 {
        return Err(TufRepositoryError::Invalid(
            "payload-key registry has an invalid schema or key count".into(),
        ));
    }
    let mut identities = BTreeSet::new();
    for key in registry.keys {
        lowercase_sha256(&key.id, "payload-key identity")?;
        if !identities.insert(key.id.clone()) {
            return Err(TufRepositoryError::Invalid(
                "payload-key registry contains duplicate identities".into(),
            ));
        }
        let decoded = STANDARD.decode(&key.tauri_public_key).map_err(|_| {
            TufRepositoryError::Invalid("payload public key is not valid base64".into())
        })?;
        if decoded.is_empty() || decoded.len() > 16 * 1024 || sha256(&decoded) != key.id {
            return Err(TufRepositoryError::Invalid(
                "payload public-key identity does not match its bytes".into(),
            ));
        }
        let text = std::str::from_utf8(&decoded)
            .map_err(|_| TufRepositoryError::Invalid("payload public key is not UTF-8".into()))?;
        let mut lines = text.lines();
        if !lines
            .next()
            .is_some_and(|line| line.starts_with("untrusted comment: "))
            || lines.next().is_none_or(str::is_empty)
            || lines.next().is_some()
            || PublicKey::decode(text).is_err()
        {
            return Err(TufRepositoryError::Invalid(
                "payload public key is not a canonical Minisign public-key file".into(),
            ));
        }
    }
    Ok(())
}

pub(super) async fn validate_distinct_signing_keys(
    keys: &[Arc<[u8]>; 6],
) -> Result<[Vec<u8>; 6], TufRepositoryError> {
    let mut identities = BTreeSet::new();
    let mut ordered = Vec::with_capacity(keys.len());
    for key_bytes in keys {
        let public = key(key_bytes.clone())
            .as_sign()
            .await
            .map_err(|_| TufRepositoryError::Invalid("TUF signing key is invalid".into()))?
            .tuf_key();
        if !matches!(public, tough::schema::key::Key::Ed25519 { .. }) {
            return Err(TufRepositoryError::Invalid(
                "TUF signing keys must be PKCS#8 Ed25519 keys".into(),
            ));
        }
        let identity = public.key_id()?.to_vec();
        if !identities.insert(identity.clone()) {
            return Err(TufRepositoryError::Invalid(
                "TUF signing roles must use distinct keys".into(),
            ));
        }
        ordered.push(identity);
    }
    ordered
        .try_into()
        .map_err(|_| TufRepositoryError::Invalid("six TUF signing keys are required".into()))
}

pub(super) fn validate_record(
    record: &RecordIdentity,
) -> Result<DelegatedRole, TufRepositoryError> {
    target_path(&record.path)?;
    lowercase_sha256(&record.sha256, "record identity")?;
    if record.bytes == 0 || record.bytes > MAX_RECORD_BYTES {
        return Err(TufRepositoryError::Invalid(format!(
            "record has an invalid byte length: {}",
            record.path
        )));
    }
    for (value, label) in [
        (&record.version, "version"),
        (&record.target, "target"),
        (&record.package, "package"),
    ] {
        if !safe_path_segment(value) {
            return Err(TufRepositoryError::Invalid(format!(
                "record {label} is invalid"
            )));
        }
    }
    let (role, expected_path) = match (record.kind.as_str(), record.channel.as_deref()) {
        ("release", None) => (
            DelegatedRole::Releases,
            format!(
                "releases/{}/{}/{}.json",
                record.version, record.target, record.package
            ),
        ),
        ("promotion", Some("preview")) => (
            DelegatedRole::Preview,
            format!(
                "channels/preview/{}/{}/{}.json",
                record.target, record.package, record.version
            ),
        ),
        ("promotion", Some("stable")) => (
            DelegatedRole::Stable,
            format!(
                "channels/stable/{}/{}/{}.json",
                record.target, record.package, record.version
            ),
        ),
        _ => {
            return Err(TufRepositoryError::Invalid(format!(
                "record role and path disagree: {}",
                record.path
            )));
        }
    };
    if record.path != expected_path {
        return Err(TufRepositoryError::Invalid(format!(
            "record identity does not match its target path: {}",
            record.path
        )));
    }
    Ok(role)
}

#[derive(Debug, Clone)]
struct MemoryKeySource {
    bytes: Arc<[u8]>,
}

#[async_trait::async_trait]
impl KeySource for MemoryKeySource {
    async fn as_sign(
        &self,
    ) -> Result<Box<dyn tough::sign::Sign>, Box<dyn std::error::Error + Send + Sync + 'static>>
    {
        Ok(Box::new(tough::sign::parse_keypair(&self.bytes)?))
    }

    async fn write(
        &self,
        _value: &str,
        _key_id_hex: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync + 'static>> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "in-memory signing keys are read-only",
        )
        .into())
    }
}

pub(super) fn key(bytes: Arc<[u8]>) -> Box<dyn KeySource> {
    Box::new(MemoryKeySource { bytes })
}

pub(super) fn collect_tree(
    root: &Path,
    prefix: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), TufRepositoryError> {
    let mut total_bytes = files.values().map(|bytes| bytes.len() as u64).sum();
    collect_tree_inner(root, prefix, files, 0, &mut total_bytes)
}

pub(super) fn collect_tree_inner(
    root: &Path,
    prefix: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
    depth: usize,
    total_bytes: &mut u64,
) -> Result<(), TufRepositoryError> {
    if depth > MAX_REPOSITORY_DEPTH {
        return Err(TufRepositoryError::Invalid(
            "repository tree exceeds its directory-depth limit".into(),
        ));
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| {
            TufRepositoryError::Invalid("repository output contains a non-UTF-8 path".into())
        })?;
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(TufRepositoryError::Invalid(format!(
                "repository output contains a link: {relative}"
            )));
        }
        if metadata.is_dir() {
            collect_tree_inner(&entry.path(), &relative, files, depth + 1, total_bytes)?;
        } else if metadata.is_file() {
            if files.len() >= MAX_REPOSITORY_FILES
                || metadata.len() > MAX_REPOSITORY_BYTES
                || total_bytes
                    .checked_add(metadata.len())
                    .is_none_or(|bytes| bytes > MAX_REPOSITORY_BYTES)
            {
                return Err(TufRepositoryError::Invalid(
                    "repository tree exceeds its file or byte limit".into(),
                ));
            }
            let remaining = MAX_REPOSITORY_BYTES - *total_bytes;
            let mut bytes = Vec::with_capacity(metadata.len().min(remaining) as usize);
            fs::File::open(entry.path())?
                .take(remaining + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > remaining {
                return Err(TufRepositoryError::Invalid(
                    "repository tree exceeds its file or byte limit".into(),
                ));
            }
            *total_bytes += bytes.len() as u64;
            files.insert(relative, bytes);
        } else {
            return Err(TufRepositoryError::Invalid(format!(
                "repository output contains an unsupported entry: {relative}"
            )));
        }
    }
    Ok(())
}

pub(super) fn report_files(root: &Path) -> Result<Vec<RepositoryFileIdentity>, TufRepositoryError> {
    let mut files = BTreeMap::new();
    collect_tree(root, "", &mut files)?;
    Ok(files
        .into_iter()
        .map(|(path, bytes)| RepositoryFileIdentity {
            path,
            bytes: bytes.len() as u64,
            sha256: sha256(&bytes),
        })
        .collect())
}

pub(super) struct ExpectedRepository<'a> {
    pub(super) trusted_root: &'a [u8],
    pub(super) targets: &'a BTreeMap<String, Vec<u8>>,
    pub(super) versions: &'a [NonZeroU64; 6],
    pub(super) expirations: &'a [Timestamp; 6],
    pub(super) record_count: usize,
    pub(super) root_version: NonZeroU64,
    pub(super) signing_key_ids: &'a [Vec<u8>; 6],
}

fn validate_delegations(
    targets: &tough::schema::Targets,
    expected_targets: &BTreeMap<String, Vec<u8>>,
    versions: &[NonZeroU64; 6],
    expirations: &[Timestamp; 6],
    signing_key_ids: &[Vec<u8>; 6],
) -> Result<(), TufRepositoryError> {
    let delegations = targets.delegations.as_ref().ok_or_else(|| {
        TufRepositoryError::Invalid("existing repository has no delegated roles".into())
    })?;
    let expected_delegated_keys: BTreeSet<_> = signing_key_ids[3..].iter().cloned().collect();
    let delegated_keys: BTreeSet<_> = delegations.keys.keys().map(|key| key.to_vec()).collect();
    if delegated_keys != expected_delegated_keys {
        return Err(TufRepositoryError::Invalid(
            "existing delegated key inventory differs".into(),
        ));
    }
    let delegated_names: BTreeSet<_> = delegations
        .roles
        .iter()
        .map(|role| role.name.as_str())
        .collect();
    if delegated_names != BTreeSet::from(["releases", "preview", "stable"]) {
        return Err(TufRepositoryError::Invalid(
            "existing delegated-role inventory differs".into(),
        ));
    }
    for (role, index) in [
        (DelegatedRole::Releases, 3usize),
        (DelegatedRole::Preview, 4usize),
        (DelegatedRole::Stable, 5usize),
    ] {
        let delegated = delegations
            .roles
            .iter()
            .find(|candidate| candidate.name == role.name())
            .and_then(|candidate| candidate.targets.as_ref())
            .ok_or_else(|| {
                TufRepositoryError::Invalid(format!(
                    "existing repository has no loaded {} role",
                    role.name()
                ))
            })?;
        let role_definition = delegations
            .roles
            .iter()
            .find(|candidate| candidate.name == role.name())
            .ok_or_else(|| {
                TufRepositoryError::Invalid(format!(
                    "existing repository has no {} role definition",
                    role.name()
                ))
            })?;
        let expected_patterns: BTreeSet<_> = {
            let exact: BTreeSet<_> = expected_targets
                .keys()
                .filter(|path| match role {
                    DelegatedRole::Releases => path.starts_with("releases/"),
                    DelegatedRole::Preview => path.starts_with("channels/preview/"),
                    DelegatedRole::Stable => path.starts_with("channels/stable/"),
                })
                .cloned()
                .collect();
            if exact.is_empty() {
                BTreeSet::from([role.placeholder_pattern().to_owned()])
            } else {
                exact
            }
        };
        let actual_patterns: BTreeSet<_> = match &role_definition.paths {
            PathSet::Paths(patterns) => patterns
                .iter()
                .map(|pattern| pattern.value().to_owned())
                .collect(),
            PathSet::PathHashPrefixes(_) => {
                return Err(TufRepositoryError::Invalid(format!(
                    "existing {} role uses unexpected hashed paths",
                    role.name()
                )));
            }
        };
        if role_definition.threshold != NonZeroU64::MIN
            || !role_definition.terminating
            || role_definition.keyids.len() != 1
            || role_definition.keyids[0].as_ref() != signing_key_ids[index].as_slice()
            || actual_patterns != expected_patterns
        {
            return Err(TufRepositoryError::Invalid(format!(
                "existing {} delegation policy differs",
                role.name()
            )));
        }
        if delegated.signed.version != versions[index]
            || delegated.signed.expires != expirations[index]
        {
            return Err(TufRepositoryError::Invalid(format!(
                "existing {} version or expiration differs",
                role.name()
            )));
        }
        let signed_names: BTreeSet<_> = delegated
            .signed
            .targets
            .keys()
            .map(|name| name.raw().to_owned())
            .collect();
        let expected_names: BTreeSet<_> = expected_targets
            .keys()
            .filter(|path| match role {
                DelegatedRole::Releases => path.starts_with("releases/"),
                DelegatedRole::Preview => path.starts_with("channels/preview/"),
                DelegatedRole::Stable => path.starts_with("channels/stable/"),
            })
            .cloned()
            .collect();
        if signed_names != expected_names {
            return Err(TufRepositoryError::Invalid(format!(
                "existing {} target inventory differs",
                role.name()
            )));
        }
    }
    Ok(())
}

pub(super) async fn validate_existing_repository(
    output: &Path,
    expected: ExpectedRepository<'_>,
) -> Result<(), TufRepositoryError> {
    let ExpectedRepository {
        trusted_root,
        targets: expected_targets,
        versions,
        expirations,
        record_count,
        root_version,
        signing_key_ids,
    } = expected;
    if !fs::symlink_metadata(output)?.is_dir() {
        return Err(TufRepositoryError::Invalid(
            "existing repository output is not a directory".into(),
        ));
    }
    let targets_root = output.join("targets");
    let metadata_root = output.join("metadata");
    let published_root = read_regular_bounded(
        &metadata_root.join(format!("{root_version}.root.json")),
        MAX_MANIFEST_BYTES,
        "published trusted root",
    )?;
    if published_root != trusted_root {
        return Err(TufRepositoryError::Invalid(
            "published trusted root differs from the configured root".into(),
        ));
    }
    let manifest_bytes = read_regular_bounded(
        &output.join("repository-manifest.json"),
        MAX_MANIFEST_BYTES,
        "repository manifest",
    )?;
    let manifest: RepositoryManifest = serde_json::from_slice(&manifest_bytes)?;
    let mut files_without_manifest = report_files(output)?;
    files_without_manifest.retain(|file| file.path != "repository-manifest.json");
    if manifest.schema_version != 1
        || manifest.records != record_count
        || manifest.files != files_without_manifest
    {
        return Err(TufRepositoryError::Invalid(
            "existing repository manifest does not match its files".into(),
        ));
    }
    let mut metadata_files = BTreeMap::new();
    collect_tree(&metadata_root, "", &mut metadata_files)?;
    let expected_metadata_files = BTreeSet::from([
        format!("{root_version}.root.json"),
        format!("{}.targets.json", versions[0]),
        format!("{}.snapshot.json", versions[1]),
        "timestamp.json".to_owned(),
        format!("{}.releases.json", versions[3]),
        format!("{}.preview.json", versions[4]),
        format!("{}.stable.json", versions[5]),
    ]);
    if metadata_files.keys().cloned().collect::<BTreeSet<_>>() != expected_metadata_files {
        return Err(TufRepositoryError::Invalid(
            "existing repository metadata inventory differs".into(),
        ));
    }
    let mut target_files = BTreeMap::new();
    collect_tree(&targets_root, "", &mut target_files)?;
    if target_files != consistent_target_files(expected_targets) {
        return Err(TufRepositoryError::Invalid(
            "existing repository target bytes differ from the requested immutable build".into(),
        ));
    }
    let repository = RepositoryLoader::new(
        &trusted_root,
        Url::from_directory_path(&metadata_root).map_err(|_| {
            TufRepositoryError::Invalid("repository metadata path is invalid".into())
        })?,
        Url::from_directory_path(&targets_root)
            .map_err(|_| TufRepositoryError::Invalid("repository target path is invalid".into()))?,
    )
    .load()
    .await?;
    for (path, expected) in expected_targets {
        let target = repository
            .read_target(&TargetName::new(path.clone())?)
            .await?
            .ok_or_else(|| {
                TufRepositoryError::Invalid(format!(
                    "existing signed repository omits target {path}"
                ))
            })?
            .try_collect::<Vec<_>>()
            .await?
            .concat();
        if &target != expected {
            return Err(TufRepositoryError::Invalid(format!(
                "existing signed target differs from its input: {path}"
            )));
        }
    }
    let targets = &repository.targets().signed;
    let top_level_names: BTreeSet<_> = targets
        .targets
        .keys()
        .map(|name| name.raw().to_owned())
        .collect();
    if top_level_names != BTreeSet::from(["keys/payload.json".to_owned()]) {
        return Err(TufRepositoryError::Invalid(
            "existing top-level targets inventory differs".into(),
        ));
    }
    if targets.version != versions[0] || targets.expires != expirations[0] {
        return Err(TufRepositoryError::Invalid(
            "existing top-level targets version or expiration differs".into(),
        ));
    }
    if repository.snapshot().signed.version != versions[1]
        || repository.snapshot().signed.expires != expirations[1]
        || repository.timestamp().signed.version != versions[2]
        || repository.timestamp().signed.expires != expirations[2]
    {
        return Err(TufRepositoryError::Invalid(
            "existing snapshot or timestamp version or expiration differs".into(),
        ));
    }
    validate_delegations(
        targets,
        expected_targets,
        versions,
        expirations,
        signing_key_ids,
    )?;
    Ok(())
}

pub(super) fn ensure_no_overlap(output: &Path, inputs: &[&Path]) -> Result<(), TufRepositoryError> {
    let parent = output.parent().ok_or_else(|| {
        TufRepositoryError::Invalid("repository output needs a parent directory".into())
    })?;
    fs::create_dir_all(parent)?;
    let parent = parent.canonicalize()?;
    let resolved_output = parent.join(output.file_name().ok_or_else(|| {
        TufRepositoryError::Invalid("repository output needs a file name".into())
    })?);
    for input in inputs {
        let input = input.canonicalize()?;
        if resolved_output.starts_with(&input) || input.starts_with(&resolved_output) {
            return Err(TufRepositoryError::Invalid(
                "repository output must not overlap an input".into(),
            ));
        }
    }
    Ok(())
}
