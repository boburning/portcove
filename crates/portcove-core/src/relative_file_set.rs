//! Exact relative-file intake, separate from historical basename matching.
use crate::{PortcoveError, RelativeSourceMemberIdentity, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(crate) const MAX_MEMBERS: usize = 256;
const MAX_MEMBER_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

pub(crate) fn validate(members: &[RelativeSourceMemberIdentity]) -> Result<()> {
    if members.is_empty() || members.len() > MAX_MEMBERS {
        return Err(PortcoveError::usage(
            "relative file set needs 1 to 256 exact members",
        ));
    }
    let mut names = BTreeMap::new();
    let mut ids = BTreeSet::new();
    let mut total = 0_u64;
    for member in members {
        let (_, key) = crate::archive::validate_relative_path(&member.path, false)?;
        if member.id.is_empty()
            || !ids.insert(&member.id)
            || member.path.contains('\\')
            || member.size == 0
            || member.size > MAX_MEMBER_BYTES
            || member.sha256.len() != 64
            || !member.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || names.insert(key, false).is_some()
        {
            return Err(PortcoveError::usage(
                "relative file set has an invalid or colliding member",
            ));
        }
        total = total
            .checked_add(member.size)
            .ok_or_else(|| PortcoveError::usage("relative file set size overflow"))?;
    }
    if total > MAX_TOTAL_BYTES {
        return Err(PortcoveError::unsupported(
            "relative file set exceeds 512 MiB expanded bytes",
        ));
    }
    namespace(&names)
}

fn namespace(names: &BTreeMap<String, bool>) -> Result<()> {
    for name in names.keys() {
        let mut parent = Path::new(name).parent();
        while let Some(path) = parent {
            if names.get(&path.to_string_lossy().replace('\\', "/")) == Some(&false) {
                return Err(PortcoveError::verification(
                    "relative source contains a file/directory collision",
                ));
            }
            parent = path.parent();
        }
    }
    Ok(())
}

enum Input {
    Directory {
        root: PathBuf,
        files: BTreeMap<String, PathBuf>,
    },
    Zip {
        checked: crate::source_zip::CheckedSourceZip,
        names: BTreeMap<String, usize>,
    },
}

pub(crate) struct ReadLimits {
    pub max_entries: u32,
    pub max_depth: u32,
    pub max_file_bytes: u64,
    pub entries: u32,
}

impl Default for ReadLimits {
    fn default() -> Self {
        Self {
            max_entries: 4096,
            max_depth: 64,
            max_file_bytes: crate::source_zip::MAX_CONTAINER_BYTES,
            entries: 0,
        }
    }
}

fn scan_limit(name: &str) -> PortcoveError {
    PortcoveError::unsupported(format!("relative source discovery {name} limit reached"))
        .detail("scan_limit", name)
}

impl ReadLimits {
    fn entry(&mut self, name: &str, size: u64) -> Result<()> {
        if self.entries >= self.max_entries {
            return Err(scan_limit("entries"));
        }
        self.entries += 1;
        if name.split('/').count().saturating_sub(1) > self.max_depth as usize {
            return Err(scan_limit("depth"));
        }
        if size > self.max_file_bytes.min(MAX_MEMBER_BYTES) {
            return Err(scan_limit("file_size"));
        }
        Ok(())
    }
}

fn directory_files(
    root: &Path,
    limits: &mut ReadLimits,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<BTreeMap<String, PathBuf>> {
    let mut files = BTreeMap::new();
    let mut names = BTreeSet::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        checkpoint()?;
        crate::path::refuse_symlink_ancestors(&directory)?;
        for entry in fs::read_dir(directory)? {
            checkpoint()?;
            let entry = entry?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| PortcoveError::state("relative source escaped its root"))?;
            let relative = relative
                .to_str()
                .ok_or_else(|| PortcoveError::unsupported("relative source names must be Unicode"))?
                .replace('\\', "/");
            let metadata = fs::symlink_metadata(&path)?;
            limits.entry(
                &relative,
                if metadata.is_file() {
                    metadata.len()
                } else {
                    0
                },
            )?;
            crate::path::refuse_symlink_ancestors(&path)?;
            let (_, key) = crate::archive::validate_relative_path(&relative, metadata.is_dir())?;
            if !names.insert(key.clone()) {
                return Err(PortcoveError::verification(
                    "relative source has case-colliding names",
                ));
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                files.insert(key, path);
            } else {
                return Err(PortcoveError::verification(
                    "relative source has a special entry",
                ));
            }
        }
    }
    Ok(files)
}

impl Input {
    fn size(&mut self, name: &str) -> Result<u64> {
        match self {
            Self::Directory { files, .. } => Ok(fs::metadata(
                files.get(&name.to_ascii_lowercase()).ok_or_else(|| {
                    PortcoveError::source("required relative source member is missing")
                })?,
            )?
            .len()),
            Self::Zip { checked, names } => {
                let index = *names.get(&name.to_ascii_lowercase()).ok_or_else(|| {
                    PortcoveError::source("required relative source member is missing")
                })?;
                Ok(checked
                    .archive
                    .by_index(index)
                    .map_err(|error| {
                        PortcoveError::source(format!("invalid source ZIP entry: {error}"))
                    })?
                    .size())
            }
        }
    }
    fn open(path: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<Self> {
        Self::open_progress(
            path,
            4096,
            &mut ReadLimits::default(),
            checkpoint,
            &mut |_| checkpoint(),
        )
    }

    fn open_progress(
        path: &Path,
        maximum_entries: usize,
        limits: &mut ReadLimits,
        checkpoint: &dyn Fn() -> Result<()>,
        progress: &mut dyn FnMut(u64) -> Result<()>,
    ) -> Result<Self> {
        checkpoint()?;
        crate::path::refuse_symlink_ancestors(path)?;
        let metadata = fs::symlink_metadata(path)?;
        if metadata.is_dir() {
            let root = fs::canonicalize(path)?;
            let files = directory_files(&root, limits, checkpoint)?;
            return Ok(Self::Directory { root, files });
        }
        if !metadata.is_file()
            || path
                .extension()
                .is_none_or(|ext| !ext.eq_ignore_ascii_case("zip"))
        {
            return Err(PortcoveError::source(
                "select the original data directory or ZIP",
            ));
        }
        if metadata.len() > limits.max_file_bytes {
            return Err(scan_limit("file_size"));
        }
        let mut checked = crate::source_zip::open(
            fs::File::open(path)?,
            crate::source_zip::MAX_CONTAINER_BYTES.min(limits.max_file_bytes),
            maximum_entries.min(limits.max_entries as usize),
            progress,
        )
        .map_err(|error| {
            if error.details.contains_key("maximum_entries") {
                scan_limit("entries")
            } else {
                error
            }
        })?;
        let mut names = BTreeMap::new();
        let mut namespace_entries = BTreeMap::new();
        for index in 0..checked.archive.len() {
            checkpoint()?;
            let entry = checked.archive.by_index(index).map_err(|error| {
                PortcoveError::source(format!("invalid source ZIP entry: {error}"))
            })?;
            let name = entry.name().map_err(|error| {
                PortcoveError::source(format!("invalid source ZIP name: {error}"))
            })?;
            let (_, key) = crate::archive::validate_relative_path(&name, entry.is_dir())?;
            limits.entry(
                name.trim_end_matches('/'),
                if entry.is_dir() { 0 } else { entry.size() },
            )?;
            let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
            if !matches!(kind, 0 | 0o100000 | 0o040000)
                || (kind == 0o040000 && !entry.is_dir())
                || namespace_entries
                    .insert(key.clone(), entry.is_dir())
                    .is_some()
            {
                return Err(PortcoveError::verification(
                    "source ZIP has a link, special entry or colliding name",
                ));
            }
            if !entry.is_dir() {
                names.insert(key, index);
            }
        }
        namespace(&namespace_entries)?;
        Ok(Self::Zip { checked, names })
    }

    fn read(
        &mut self,
        member: &RelativeSourceMemberIdentity,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<Vec<u8>> {
        checkpoint()?;
        let bytes = match self {
            Self::Directory { root, files } => {
                crate::path::refuse_symlink_ancestors(root)?;
                let path = files
                    .get(&member.path.to_ascii_lowercase())
                    .ok_or_else(|| {
                        PortcoveError::source(format!(
                            "required original data is missing: {}",
                            member.path
                        ))
                    })?;
                crate::external_runtime::read_single_link_metadata(path, member.size)?
            }
            Self::Zip { checked, names } => {
                let index = *names
                    .get(&member.path.to_ascii_lowercase())
                    .ok_or_else(|| {
                        PortcoveError::source(format!(
                            "required original ZIP member is missing: {}",
                            member.path
                        ))
                    })?;
                let entry = checked.archive.by_index(index).map_err(|error| {
                    PortcoveError::source(format!("invalid source ZIP entry: {error}"))
                })?;
                if entry.size() != member.size {
                    return Err(PortcoveError::source(
                        "original ZIP member has the wrong size",
                    ));
                }
                let mut bytes = Vec::new();
                let mut reader = entry.take(member.size + 1);
                let mut buffer = [0; 128 * 1024];
                loop {
                    checkpoint()?;
                    let count = reader.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                bytes
            }
        };
        checkpoint()?;
        if bytes.len() as u64 != member.size
            || !hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(&member.sha256)
        {
            return Err(PortcoveError::source(format!(
                "original data does not match the checked identity: {}",
                member.path
            )));
        }
        Ok(bytes)
    }
}

fn record(
    profile_id: &str,
    path: &Path,
    members: &[RelativeSourceMemberIdentity],
    input: &Input,
) -> crate::SourceRecord {
    let mut ordered = members.iter().collect::<Vec<_>>();
    ordered.sort_unstable_by(|left, right| left.id.cmp(&right.id));
    let mut digest = Sha256::new();
    digest.update(b"portcove-relative-file-set-v1\0");
    for member in ordered {
        let path = member.path.to_ascii_lowercase();
        digest.update((member.id.len() as u64).to_be_bytes());
        digest.update(member.id.as_bytes());
        digest.update((path.len() as u64).to_be_bytes());
        digest.update(path.as_bytes());
        digest.update(member.size.to_be_bytes());
        digest.update(member.sha256.to_ascii_lowercase().as_bytes());
    }
    let aggregate = hex::encode(digest.finalize());
    let size = members.iter().map(|member| member.size).sum();
    let (storage_sha256, storage_size) = match input {
        Input::Directory { .. } => (aggregate.clone(), size),
        Input::Zip { checked, .. } => (checked.storage_sha256.clone(), checked.storage_size),
    };
    crate::SourceRecord {
        profile_id: profile_id.into(),
        path: path.into(),
        sha256: aggregate,
        size,
        storage_sha256,
        storage_size,
        updated_at: crate::Library::now(),
        observed_identity: None,
    }
}

/// Compatibility health uses the same exact paths and hashes, without interpreting
/// a relative member as a basename. Schema-2 inspection also checks declared sizes.
pub(crate) fn validate_profile(
    profile: &crate::SourceProfile,
    path: &Path,
) -> Result<crate::SourceRecord> {
    let mut input = Input::open(path, &|| Ok(()))?;
    let mut members = Vec::new();
    for member in &profile.members {
        let ([name], [sha256]) = (
            member.accepted_filenames.as_slice(),
            member.accepted_sha256.as_slice(),
        ) else {
            return Err(PortcoveError::usage(
                "relative source requires one path and SHA256 per member",
            ));
        };
        members.push(RelativeSourceMemberIdentity {
            id: member.id.clone(),
            path: name.clone(),
            size: input.size(name)?,
            sha256: sha256.clone(),
        });
    }
    validate(&members)?;
    for member in &members {
        input.read(member, &|| Ok(()))?;
    }
    Ok(record(&profile.id, path, &members, &input))
}

pub(crate) fn inspect(
    catalog: &crate::Catalog,
    profile_id: &str,
    path: &Path,
) -> Result<crate::SourceInspection> {
    inspect_with_checkpoint(catalog, profile_id, path, &|| Ok(()))
}

pub(crate) fn inspect_with_checkpoint(
    catalog: &crate::Catalog,
    profile_id: &str,
    path: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<crate::SourceInspection> {
    let mut budget = crate::source_file::HashBudget {
        operation: None,
        limit: u64::MAX,
        hashed: 0,
        max_zip_entries: 4096,
    };
    inspect_with_limits_and_checkpoint(
        catalog,
        profile_id,
        path,
        &mut budget,
        &mut ReadLimits::default(),
        checkpoint,
    )
}

pub(crate) fn inspect_with_limits(
    catalog: &crate::Catalog,
    profile_id: &str,
    path: &Path,
    budget: &mut crate::source_file::HashBudget,
    limits: &mut ReadLimits,
) -> Result<crate::SourceInspection> {
    inspect_with_limits_and_checkpoint(catalog, profile_id, path, budget, limits, &|| Ok(()))
}

fn inspect_with_limits_and_checkpoint(
    catalog: &crate::Catalog,
    profile_id: &str,
    path: &Path,
    budget: &mut crate::source_file::HashBudget,
    limits: &mut ReadLimits,
    external_checkpoint: &dyn Fn() -> Result<()>,
) -> Result<crate::SourceInspection> {
    let profile = catalog
        .source_catalog()
        .and_then(|source| {
            source
                .identities
                .iter()
                .find(|profile| profile.id == profile_id)
        })
        .ok_or_else(|| PortcoveError::source("relative source profile is missing"))?;
    let operation = budget.operation.clone();
    let checkpoint = || {
        external_checkpoint()?;
        if let Some(operation) = &operation {
            operation.checkpoint()?;
        }
        Ok(())
    };
    let mut input = Input::open_progress(
        path,
        budget.max_zip_entries,
        limits,
        &checkpoint,
        &mut |bytes| {
            budget.reserve(bytes)?;
            budget.hashed += bytes;
            checkpoint()
        },
    )?;
    let mut candidates = Vec::new();
    let mut first_mismatch = None;
    for variant in profile
        .variants
        .iter()
        .filter(|variant| !variant.legacy_projection_only)
    {
        for representation in &variant.representations {
            let crate::SourceRepresentationKind::RelativeFileSet { members } = &representation.kind
            else {
                continue;
            };
            validate(members)?;
            let observation = (|| -> Result<Vec<crate::ObservedSourceComponent>> {
                let mut components = Vec::new();
                for member in members {
                    budget.reserve(member.size)?;
                    budget.hashed += member.size;
                    input.read(member, &checkpoint)?;
                    components.push(crate::ObservedSourceComponent {
                        id: member.id.clone(),
                        kind: crate::SourceComponentKind::FileSetMember,
                        name: Some(member.path.clone()),
                        digests: vec![crate::ObservedSourceDigest {
                            algorithm: crate::SourceDigestAlgorithm::Sha256,
                            scope: crate::DigestScope::FileSetMember,
                            value: member.sha256.clone(),
                            size: member.size,
                        }],
                        size: member.size,
                        track_count: None,
                        volume_id: None,
                    });
                }
                Ok(components)
            })();
            match observation {
                Ok(components) => candidates.push((
                    crate::SourceIdentity {
                        game_id: profile_id.into(),
                        variant_id: variant.id.clone(),
                        representation_id: representation.id.clone(),
                    },
                    components,
                    record(profile_id, path, members, &input),
                )),
                Err(error) if error.code == crate::ErrorCode::SourceInvalid => {
                    if first_mismatch.is_none() {
                        first_mismatch = Some(error);
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }
    if candidates.len() != 1 {
        if candidates.is_empty()
            && let Some(error) = first_mismatch
        {
            return Err(error);
        }
        return Err(PortcoveError::source(
            "relative source must match exactly one identity",
        ));
    }
    let (identity, components, record) = candidates.remove(0);
    let mut digests = vec![crate::ObservedSourceDigest {
        algorithm: crate::SourceDigestAlgorithm::Sha256,
        scope: crate::DigestScope::NormalizedContent,
        value: record.sha256.clone(),
        size: record.size,
    }];
    if matches!(input, Input::Zip { .. }) {
        digests.push(crate::ObservedSourceDigest {
            algorithm: crate::SourceDigestAlgorithm::Sha256,
            scope: crate::DigestScope::OriginalContainer,
            value: record.storage_sha256.clone(),
            size: record.storage_size,
        });
    }
    Ok(crate::SourceInspection {
        profile_id: profile_id.into(),
        path: path.into(),
        observed_digests: digests,
        archive_member_name: None,
        components,
        validator: None,
        assessment: crate::SourceAssessment {
            health: crate::SourceHealth::NotBaselined,
            classification: crate::SourceClassification::Recognized { identity },
            contract: crate::SourceContractResult::NotEvaluated,
            admission: crate::SourceAdmission::Admitted {
                mode: crate::SourceAdmissionMode::ExactIdentity,
            },
            evidence: Vec::new(),
        },
        record: Some(record),
        message: "Original data matches the exact relative file set".into(),
    })
}

pub(crate) fn materialize(
    port: &crate::PortDefinition,
    source: &crate::SourceRecord,
    directory: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let facts = source.observed_identity.as_ref().ok_or_else(|| {
        PortcoveError::verification("relative runtime data needs checked source facts")
    })?;
    facts.validate_for_record(source)?;
    let mut members = Vec::new();
    for target in &port.runtime_source_set {
        let [name] = target.source_filenames.as_slice() else {
            return Err(PortcoveError::verification(
                "relative runtime target needs one exact source path",
            ));
        };
        if target.destination != format!("GameData/{name}")
            || target.materialization != crate::RuntimeSourceMaterialization::Copy
        {
            return Err(PortcoveError::verification(
                "relative runtime target changed its fixed GameData destination",
            ));
        }
        let component = facts
            .components
            .iter()
            .find(|component| {
                component
                    .name
                    .as_deref()
                    .is_some_and(|path| path.eq_ignore_ascii_case(name))
            })
            .ok_or_else(|| {
                PortcoveError::verification("relative runtime target lacks a checked component")
            })?;
        let hash = port
            .runtime_source_hashes
            .get(&target.destination)
            .ok_or_else(|| {
                PortcoveError::verification("relative runtime target lacks its exact SHA256")
            })?;
        if !component.digests.iter().any(|digest| {
            digest.algorithm == crate::SourceDigestAlgorithm::Sha256
                && digest.scope == crate::DigestScope::FileSetMember
                && digest.size == component.size
                && digest.value.eq_ignore_ascii_case(hash)
        }) {
            return Err(PortcoveError::verification(
                "relative runtime target differs from the checked original",
            ));
        }
        members.push(RelativeSourceMemberIdentity {
            id: component.id.clone(),
            path: name.clone(),
            size: component.size,
            sha256: hash.clone(),
        });
    }
    validate(&members)?;
    if members.len() != facts.components.len() {
        return Err(PortcoveError::verification(
            "relative runtime targets omit checked source components",
        ));
    }
    let mut input = Input::open(&source.path, checkpoint)?;
    let actual = record(&source.profile_id, &source.path, &members, &input);
    if actual.sha256 != source.sha256
        || actual.size != source.size
        || actual.storage_sha256 != source.storage_sha256
        || actual.storage_size != source.storage_size
    {
        return Err(PortcoveError::verification(
            "relative source changed after review",
        ));
    }
    crate::path::refuse_symlink_ancestors(directory)?;
    let destination = directory.join("GameData");
    let reusable = verify_cache(&members, &destination, checkpoint)?;
    if reusable {
        // The marker or directory name never substitutes for current source bytes.
        for member in &members {
            input.read(member, checkpoint)?;
        }
        return Ok(());
    }
    let staging_root = crate::managed_tfe::staging_root(directory)?;
    let staging = tempfile::Builder::new()
        .prefix("original-data-")
        .tempdir_in(&staging_root)?;
    for member in &members {
        let bytes = input.read(member, checkpoint)?;
        let target = staging.path().join(&member.path);
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| PortcoveError::state("relative runtime target has no parent"))?,
        )?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        output.write_all(&bytes)?;
        output.sync_all()?;
    }
    if !verify_cache(&members, staging.path(), checkpoint)? {
        return Err(PortcoveError::verification(
            "staged original data changed before publication",
        ));
    }
    checkpoint()?;
    // Repeat the safe namespace check before replacement; unexpected player files
    // or links are retained for recovery instead of being silently removed.
    verify_cache(&members, &destination, checkpoint)?;
    let backup = staging_root.join(format!("previous-data-{}", uuid::Uuid::new_v4()));
    let had_destination = destination.exists();
    if had_destination {
        crate::durability::rename_noreplace(&destination, &backup)?;
        if let Err(error) = verify_cache(&members, &backup, checkpoint).and_then(|_| checkpoint()) {
            if let Err(restore) = crate::durability::rename_noreplace(&backup, &destination) {
                return Err(PortcoveError::state(format!(
                    "TFE preparation stopped; preserve captured data at {}: {error}; restore: {restore}",
                    backup.display()
                )));
            }
            return Err(error);
        }
    }
    if let Err(error) = crate::durability::rename_noreplace(staging.path(), &destination) {
        if had_destination
            && let Err(restore) = crate::durability::rename_noreplace(&backup, &destination)
        {
            return Err(PortcoveError::state(format!(
                "TFE data publication failed; preserve temporary recovery data at {}: {error}; restore: {restore}",
                backup.display()
            )));
        }
        return Err(error);
    }
    // Retain captured data, including anything another process added after the
    // last namespace scan. Preparation never recursively deletes this backup.
    crate::durability::sync_publication(directory)
}

fn verify_cache(
    members: &[RelativeSourceMemberIdentity],
    root: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<bool> {
    crate::path::refuse_symlink_ancestors(root)?;
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_dir() => {
            return Err(PortcoveError::verification(
                "generated GameData is not a safe directory; preserve it for recovery",
            ));
        }
        Ok(_) => {}
    }
    let expected = members
        .iter()
        .map(|member| (member.path.to_ascii_lowercase(), member))
        .collect::<BTreeMap<_, _>>();
    let mut pending = vec![root.to_path_buf()];
    let mut seen = BTreeSet::new();
    let mut count = 0;
    while let Some(directory) = pending.pop() {
        checkpoint()?;
        for entry in fs::read_dir(directory)? {
            count += 1;
            if count > MAX_MEMBERS * 2 {
                return Err(PortcoveError::verification(
                    "generated GameData has unexpected contents; preserve it for recovery",
                ));
            }
            let entry = entry?;
            let path = entry.path();
            crate::path::refuse_symlink_ancestors(&path)?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| PortcoveError::state("GameData escaped its root"))?;
            let (_, key) = crate::archive::validate_relative_path(
                &relative.to_string_lossy().replace('\\', "/"),
                entry.file_type()?.is_dir(),
            )?;
            if !seen.insert(key.clone()) {
                return Err(PortcoveError::verification(
                    "generated GameData contains colliding names; preserve it for recovery",
                ));
            }
            if entry.file_type()?.is_dir() {
                if !expected
                    .keys()
                    .any(|name| name.starts_with(&format!("{key}/")))
                {
                    return Err(PortcoveError::verification(
                        "generated GameData contains an unexpected directory; preserve it for recovery",
                    ));
                }
                pending.push(path);
            } else if !entry.file_type()?.is_file() || !expected.contains_key(&key) {
                return Err(PortcoveError::verification(
                    "generated GameData contains an unexpected file; preserve it for recovery",
                ));
            }
        }
    }
    let mut valid = true;
    for member in members {
        checkpoint()?;
        let path = root.join(&member.path);
        if !path.try_exists()? {
            valid = false;
            continue;
        }
        // Read up to the per-member safety bound, so corrupt private data can be
        // recreated while linked or unsafe files continue to refuse replacement.
        let bytes = crate::external_runtime::read_single_link_metadata(&path, MAX_MEMBER_BYTES)?;
        valid &= bytes.len() as u64 == member.size
            && hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(&member.sha256);
    }
    Ok(valid)
}

pub(crate) fn check_runtime(
    port: &crate::PortDefinition,
    directory: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let root = directory.join("GameData");
    let mut members = Vec::new();
    for (index, target) in port.runtime_source_set.iter().enumerate() {
        let [path] = target.source_filenames.as_slice() else {
            return Err(PortcoveError::verification(
                "relative runtime source path is ambiguous",
            ));
        };
        let sha256 = port
            .runtime_source_hashes
            .get(&target.destination)
            .ok_or_else(|| PortcoveError::verification("relative runtime identity is missing"))?;
        let size = fs::metadata(root.join(path))?.len();
        members.push(RelativeSourceMemberIdentity {
            id: format!("member-{index}"),
            path: path.clone(),
            size,
            sha256: sha256.clone(),
        });
    }
    validate(&members)?;
    if !verify_cache(&members, &root, checkpoint)? {
        return Err(PortcoveError::verification(
            "prepared original data changed before launch; prepare it again",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Catalog, RuntimeSourceMaterialization, RuntimeSourceTarget};

    fn members() -> Vec<RelativeSourceMemberIdentity> {
        [
            ("dark-gob", "DARK.GOB", b"original gob".as_slice()),
            (
                "agent-menu",
                "LFD/AGENTMNU.LFD",
                b"original companion".as_slice(),
            ),
        ]
        .into_iter()
        .map(|(id, path, bytes)| RelativeSourceMemberIdentity {
            id: id.into(),
            path: path.into(),
            size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(bytes)),
        })
        .collect()
    }

    fn catalog() -> Catalog {
        Catalog::from_json(&serde_json::json!({
            "schema_version":2,"ports":[],"source_catalog":{"evidence":[],"contracts":[],"validators":[],
                "identities":[{"id":"relative-fixture","label":"Exact relative fixture","kind":"file-set","evidence_gap":null,
                    "variants":[{"id":"fixture-edition","title":"Inert fixture","region":null,"revision":null,"product_codes":[],
                        "representations":[{"id":"relative-files","extensions":[],"kind":"relative-file-set","members":members()}]}]}]}
        }).to_string()).unwrap()
    }

    fn original(root: &Path) {
        fs::create_dir(root.join("LFD")).unwrap();
        fs::write(root.join("DARK.GOB"), b"original gob").unwrap();
        fs::write(root.join("LFD/AGENTMNU.LFD"), b"original companion").unwrap();
        fs::write(root.join("unrelated.ini"), b"never staged").unwrap();
    }

    fn port() -> crate::PortDefinition {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("dkc3-recomp")
            .unwrap()
            .clone();
        port.runtime_source_set = members()
            .iter()
            .map(|member| RuntimeSourceTarget {
                source_filenames: vec![member.path.clone()],
                destination: format!("GameData/{}", member.path),
                materialization: RuntimeSourceMaterialization::Copy,
            })
            .collect();
        port.runtime_source_hashes = members()
            .iter()
            .map(|member| (format!("GameData/{}", member.path), member.sha256.clone()))
            .collect();
        port
    }

    fn zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut archive = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, bytes) in files {
            archive
                .start_file(
                    *name,
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            archive.write_all(bytes).unwrap();
        }
        archive.finish().unwrap();
    }

    #[test]
    fn exact_directory_and_zip_have_equal_content_and_distinct_storage_identity() {
        let root = tempfile::tempdir().unwrap();
        original(root.path());
        let archive = root.path().join("original.zip");
        zip(
            &archive,
            &[
                ("DARK.GOB", b"original gob"),
                ("LFD/AGENTMNU.LFD", b"original companion"),
                ("unrelated.ini", b"never staged"),
            ],
        );
        let directory = inspect(&catalog(), "relative-fixture", root.path())
            .unwrap()
            .require_admitted_record()
            .unwrap();
        let zipped = inspect(&catalog(), "relative-fixture", &archive)
            .unwrap()
            .require_admitted_record()
            .unwrap();
        assert_eq!(directory.sha256, zipped.sha256);
        assert_eq!(directory.size, zipped.size);
        assert_ne!(directory.storage_sha256, zipped.storage_sha256);
        assert_eq!(zipped.observed_identity.unwrap().components.len(), 2);
        assert_eq!(
            validate_profile(
                catalog().source_profile("relative-fixture").unwrap(),
                root.path()
            )
            .unwrap()
            .sha256,
            directory.sha256
        );
    }

    #[test]
    fn wrong_basename_missing_or_changed_companion_never_satisfies_relative_member() {
        let root = tempfile::tempdir().unwrap();
        original(root.path());
        fs::rename(
            root.path().join("LFD/AGENTMNU.LFD"),
            root.path().join("AGENTMNU.LFD"),
        )
        .unwrap();
        assert!(inspect(&catalog(), "relative-fixture", root.path()).is_err());
        fs::write(root.path().join("LFD/AGENTMNU.LFD"), b"changed companion").unwrap();
        assert!(inspect(&catalog(), "relative-fixture", root.path()).is_err());
        let archive = root.path().join("wrong.zip");
        zip(
            &archive,
            &[
                ("DARK.GOB", b"original gob"),
                ("AGENTMNU.LFD", b"original companion"),
            ],
        );
        assert!(inspect(&catalog(), "relative-fixture", &archive).is_err());
    }

    #[test]
    fn hostile_zip_names_and_namespace_collisions_refuse() {
        for bad in [
            "../outside",
            "C:/outside",
            "LFD/file:stream",
            "LFD/CON",
            "LFD/../AGENTMNU.LFD",
            "LFD/agentmnu.lfd",
            "LFD",
        ] {
            let root = tempfile::tempdir().unwrap();
            let archive = root.path().join("unsafe.zip");
            zip(
                &archive,
                &[
                    ("DARK.GOB", b"original gob"),
                    ("LFD/AGENTMNU.LFD", b"original companion"),
                    (bad, b"extra"),
                ],
            );
            assert!(
                inspect(&catalog(), "relative-fixture", &archive).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn generated_copies_are_checked_on_reuse_and_unrelated_files_are_not_staged() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let runtime = root.path().join("runtime");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&runtime).unwrap();
        original(&source);
        let record = inspect(&catalog(), "relative-fixture", &source)
            .unwrap()
            .require_admitted_record()
            .unwrap();
        materialize(&port(), &record, &runtime, &|| Ok(())).unwrap();
        assert!(!runtime.join("GameData/unrelated.ini").exists());
        fs::write(
            runtime.join("GameData/LFD/AGENTMNU.LFD"),
            b"corrupt private cache",
        )
        .unwrap();
        fs::write(
            runtime.join("matching-source-marker.json"),
            b"same admitted source",
        )
        .unwrap();
        materialize(&port(), &record, &runtime, &|| Ok(())).unwrap();
        assert_eq!(
            fs::read(runtime.join("GameData/LFD/AGENTMNU.LFD")).unwrap(),
            b"original companion"
        );
        check_runtime(&port(), &runtime, &|| Ok(())).unwrap();
        fs::write(runtime.join("GameData/player-file.dat"), b"retain me").unwrap();
        assert!(materialize(&port(), &record, &runtime, &|| Ok(())).is_err());
        assert_eq!(
            fs::read(runtime.join("GameData/player-file.dat")).unwrap(),
            b"retain me"
        );
        assert_eq!(
            fs::read(source.join("unrelated.ini")).unwrap(),
            b"never staged"
        );
    }

    #[test]
    fn interrupted_preparation_does_not_publish_partial_data() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let runtime = root.path().join("runtime");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&runtime).unwrap();
        original(&source);
        let record = inspect(&catalog(), "relative-fixture", &source)
            .unwrap()
            .require_admitted_record()
            .unwrap();
        let cancel = || {
            let staged = runtime.join(".tfe-preparation");
            if staged.exists()
                && fs::read_dir(staged)?
                    .filter_map(std::result::Result::ok)
                    .any(|entry| entry.path().join("DARK.GOB").exists())
            {
                Err(PortcoveError::conflict(
                    "synthetic cancellation after first staged member",
                ))
            } else {
                Ok(())
            }
        };
        assert!(materialize(&port(), &record, &runtime, &cancel).is_err());
        assert!(!runtime.join("GameData").exists());
        materialize(&port(), &record, &runtime, &|| Ok(())).unwrap();
        check_runtime(&port(), &runtime, &|| Ok(())).unwrap();
    }

    #[test]
    fn changed_original_and_linked_cache_refuse_without_replacement() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let runtime = root.path().join("runtime");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&runtime).unwrap();
        original(&source);
        let record = inspect(&catalog(), "relative-fixture", &source)
            .unwrap()
            .require_admitted_record()
            .unwrap();
        materialize(&port(), &record, &runtime, &|| Ok(())).unwrap();
        fs::write(source.join("DARK.GOB"), b"changed original").unwrap();
        assert!(materialize(&port(), &record, &runtime, &|| Ok(())).is_err());
        assert_eq!(
            fs::read(runtime.join("GameData/DARK.GOB")).unwrap(),
            b"original gob"
        );
        fs::hard_link(
            runtime.join("GameData/DARK.GOB"),
            root.path().join("held-original"),
        )
        .unwrap();
        assert!(materialize(&port(), &record, &runtime, &|| Ok(())).is_err());
        assert_eq!(
            fs::read(root.path().join("held-original")).unwrap(),
            b"original gob"
        );
    }

    #[test]
    fn traversal_bounds_and_discovery_hash_budget_are_enforced() {
        for path in [
            "../DARK.GOB",
            "/DARK.GOB",
            "LFD/CON",
            "LFD/file:stream",
            "LFD\\AGENTMNU.LFD",
        ] {
            let mut set = members();
            set[1].path = path.into();
            assert!(validate(&set).is_err(), "{path}");
        }
        let mut set = members();
        set[1].path = "dark.gob".into();
        assert!(validate(&set).is_err());
        let root = tempfile::tempdir().unwrap();
        original(root.path());
        let mut budget = crate::source_file::HashBudget {
            operation: None,
            limit: 1,
            hashed: 0,
            max_zip_entries: 16,
        };
        assert!(
            inspect_with_limits(
                &catalog(),
                "relative-fixture",
                root.path(),
                &mut budget,
                &mut ReadLimits::default()
            )
            .is_err()
        );
        assert!(budget.hashed <= budget.limit);
    }

    #[test]
    fn relative_record_is_sha256_for_one_member_and_order_independent() {
        let root = tempfile::tempdir().unwrap();
        original(root.path());
        let input = Input::open(root.path(), &|| Ok(())).unwrap();
        let mut set = members();
        let first = record("fixture", root.path(), &set, &input);
        set.reverse();
        assert_eq!(
            first.sha256,
            record("fixture", root.path(), &set, &input).sha256
        );
        let single = record("fixture", root.path(), &set[..1], &input);
        assert_eq!(single.sha256.len(), 64);
        assert!(single.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(single.sha256, set[0].sha256);
        set[0].path = "different/path".into();
        assert_ne!(
            single.sha256,
            record("fixture", root.path(), &set[..1], &input).sha256
        );
    }

    #[test]
    fn caller_limits_bound_directory_and_zip_before_member_reads() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("data");
        fs::create_dir(&source).unwrap();
        original(&source);
        let archive = root.path().join("data.zip");
        zip(
            &archive,
            &[
                ("DARK.GOB", b"original gob"),
                ("LFD/AGENTMNU.LFD", b"original companion"),
            ],
        );
        for (path, entries, depth, file_bytes, expected) in [
            (&source, 1, 64, u64::MAX, "entries"),
            (&source, 4096, 0, u64::MAX, "depth"),
            (&source, 4096, 64, 1, "file_size"),
            (&archive, 1, 64, u64::MAX, "entries"),
            (&archive, 4096, 0, u64::MAX, "depth"),
            (&archive, 4096, 64, 1, "file_size"),
        ] {
            let mut budget = crate::source_file::HashBudget {
                operation: None,
                limit: u64::MAX,
                hashed: 0,
                max_zip_entries: 4096,
            };
            let mut limits = ReadLimits {
                max_entries: entries,
                max_depth: depth,
                max_file_bytes: file_bytes,
                entries: 0,
            };
            let error = inspect_with_limits(
                &catalog(),
                "relative-fixture",
                path,
                &mut budget,
                &mut limits,
            )
            .unwrap_err();
            assert_eq!(
                error.details.get("scan_limit").map(String::as_str),
                Some(expected),
                "{}",
                error.message
            );
            assert!(limits.entries <= limits.max_entries);
            if path == &source {
                assert_eq!(budget.hashed, 0);
            }
        }
    }

    #[test]
    fn capture_interruption_and_racing_destination_preserve_every_directory() {
        for occupied in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join("source");
            let runtime = root.path().join("runtime");
            fs::create_dir(&source).unwrap();
            fs::create_dir(&runtime).unwrap();
            original(&source);
            let record = inspect(&catalog(), "relative-fixture", &source)
                .unwrap()
                .require_admitted_record()
                .unwrap();
            materialize(&port(), &record, &runtime, &|| Ok(())).unwrap();
            fs::write(runtime.join("GameData/DARK.GOB"), b"corrupt private copy").unwrap();
            let injected = std::cell::Cell::new(false);
            let interrupt = || {
                let captured = fs::read_dir(runtime.join(".tfe-preparation"))?
                    .filter_map(std::result::Result::ok)
                    .find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with("previous-data-")
                    });
                if let Some(captured) = captured
                    && !injected.replace(true)
                {
                    fs::write(
                        captured.path().join("late-player-file"),
                        b"preserve captured player data",
                    )?;
                    if occupied {
                        fs::create_dir(runtime.join("GameData"))?;
                        fs::write(
                            runtime.join("GameData/new-player-file"),
                            b"preserve racing destination",
                        )?;
                    }
                    return Err(PortcoveError::conflict(
                        "synthetic interruption after capture",
                    ));
                }
                Ok(())
            };
            assert!(materialize(&port(), &record, &runtime, &interrupt).is_err());
            assert!(injected.get());
            let retained = if occupied {
                assert_eq!(
                    fs::read(runtime.join("GameData/new-player-file")).unwrap(),
                    b"preserve racing destination"
                );
                fs::read_dir(runtime.join(".tfe-preparation"))
                    .unwrap()
                    .filter_map(std::result::Result::ok)
                    .find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with("previous-data-")
                    })
                    .unwrap()
                    .path()
            } else {
                runtime.join("GameData")
            };
            assert_eq!(
                fs::read(retained.join("late-player-file")).unwrap(),
                b"preserve captured player data"
            );
            assert_eq!(
                fs::read(retained.join("DARK.GOB")).unwrap(),
                b"corrupt private copy"
            );
        }
    }
}
