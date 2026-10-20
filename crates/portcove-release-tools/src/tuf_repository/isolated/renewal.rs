//! Public-only renewal preparation. This module grants no signing/publication
//! authority and never reads a private key or changes any target record bytes.
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenewalConfig {
    schema_version: u32,
    generated_at: String,
    trusted_root: String,
    previous_repository: String,
    output: String,
}

#[derive(Debug, Serialize)]
pub struct RenewalReport {
    pub schema_version: u32,
    pub changed: bool,
    pub output: PathBuf,
    pub descriptor_sha256: String,
    pub context_sha256: String,
    pub files: Vec<RepositoryFileIdentity>,
    pub authority: &'static str,
}

fn canonical_bytes(mut value: serde_json::Value) -> Result<Vec<u8>, TufRepositoryError> {
    value.sort_all_objects();
    Ok(serde_json::to_vec(&value)?)
}

fn identities(files: &BTreeMap<String, Vec<u8>>) -> Vec<RepositoryFileIdentity> {
    files
        .iter()
        .map(|(path, bytes)| RepositoryFileIdentity {
            path: path.clone(),
            bytes: bytes.len() as u64,
            sha256: sha256(bytes),
        })
        .collect()
}

fn records_manifest(targets: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, TufRepositoryError> {
    let mut records = Vec::new();
    for (path, bytes) in targets {
        if path == "keys/payload.json" {
            continue;
        }
        let segments: Vec<_> = path.split('/').collect();
        let (kind, channel, version, target, package) = match segments.as_slice() {
            ["releases", version, target, package] => (
                "release",
                None,
                *version,
                *target,
                package.strip_suffix(".json").ok_or_else(|| {
                    TufRepositoryError::Invalid("release record suffix invalid".into())
                })?,
            ),
            ["channels", channel, target, package, version]
                if ["preview", "stable"].contains(channel) =>
            {
                (
                    "promotion",
                    Some(*channel),
                    version.strip_suffix(".json").ok_or_else(|| {
                        TufRepositoryError::Invalid("channel record suffix invalid".into())
                    })?,
                    *target,
                    *package,
                )
            }
            _ => return invalid("renewal record escapes maintained namespaces"),
        };
        let record = serde_json::json!({"kind":kind,"channel":channel,"path":path,"version":version,"target":target,"package":package,"bytes":bytes.len(),"sha256":sha256(bytes)});
        validate_record(&serde_json::from_value(record.clone())?)?;
        records.push(record);
    }
    canonical_envelope(&serde_json::to_vec(
        &serde_json::json!({"schema_version":1,"records":records}),
    )?)
}

fn read_prepared_output(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, TufRepositoryError> {
    if !fs::symlink_metadata(root)?.is_dir() {
        return invalid("prepared output is not a regular directory");
    }
    let fixed = BTreeSet::from([
        "context.json",
        "renewal.json",
        "trusted-root.json",
        "offline-targets.json",
        "payload.json",
        "records",
        "prior",
    ]);
    let mut seen = BTreeSet::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| TufRepositoryError::Invalid("prepared output path is not UTF-8".into()))?;
        if !fixed.contains(name.as_str()) || !seen.insert(name) {
            return invalid("prepared output has unexpected entries");
        }
    }
    if seen.iter().map(String::as_str).collect::<BTreeSet<_>>() != fixed {
        return invalid("prepared output is incomplete");
    }
    let mut files = BTreeMap::new();
    for name in fixed {
        let path = root.join(name);
        if name == "records" || name == "prior" {
            if !fs::symlink_metadata(&path)?.is_dir() {
                return invalid("prepared subtree is not a regular directory");
            }
            let mut subtree = BTreeMap::new();
            collect_tree(&path, "", &mut subtree)?;
            for (relative, bytes) in subtree {
                files.insert(format!("{name}/{relative}"), bytes);
            }
        } else {
            files.insert(
                name.into(),
                read_regular_bounded(&path, MAX_MANIFEST_BYTES, "prepared public file")?,
            );
        }
    }
    Ok(files)
}

/// The fixed caller independently ratifies the root and authenticates complete
/// current public feed/readback provenance. This routine verifies TUF itself,
/// including current expiry and all retained signed history, before returning.
/// `generated_at` is a frozen controller clock input, never an expiry override.
pub async fn prepare_tuf_renewal(config_path: &Path) -> Result<RenewalReport, TufRepositoryError> {
    let config: RenewalConfig = parse_file(config_path, "public renewal config")?;
    if config.schema_version != 1 {
        return invalid("unsupported renewal configuration schema");
    }
    let base = config_path.parent().unwrap_or_else(|| Path::new("."));
    let trusted = resolve(base, &config.trusted_root, "ratified root")?;
    let previous = resolve(base, &config.previous_repository, "published TUF component")?;
    let output = resolve(base, &config.output, "prepared renewal")?;
    ensure_no_overlap(&output, &[config_path, &trusted, &previous])?;
    let root_bytes = read_regular_bounded(&trusted, MAX_MANIFEST_BYTES, "ratified public root")?;
    let root: Signed<Root> = serde_json::from_slice(&root_bytes)?;
    inspect_public_tree(&previous, "", &mut 0)?;
    let mut prior = BTreeMap::new();
    collect_tree(&previous, "", &mut prior)?;
    // The internal artifact manifest is not a served endpoint or trust source.
    // Derive it from the complete bounded public component after snapshotting.
    prior.remove("repository-manifest.json");
    let public_prior_digest = sha256(&canonical_bytes(serde_json::to_value(identities(&prior))?)?);
    let timestamp_bytes = bytes_at(&prior, "metadata/timestamp.json")?;
    let timestamp_sha = sha256(timestamp_bytes);
    let timestamp: Signed<tough::schema::Timestamp> = serde_json::from_slice(timestamp_bytes)?;
    let snapshot_version = timestamp
        .signed
        .meta
        .get("snapshot.json")
        .ok_or_else(|| TufRepositoryError::Invalid("published snapshot missing".into()))?
        .version;
    let snapshot_bytes = bytes_at(
        &prior,
        &format!("metadata/{snapshot_version}.snapshot.json"),
    )?;
    let snapshot_sha = sha256(snapshot_bytes);
    let snapshot: Signed<Snapshot> = serde_json::from_slice(snapshot_bytes)?;
    let top_version = snapshot
        .signed
        .meta
        .get("targets.json")
        .ok_or_else(|| TufRepositoryError::Invalid("offline targets absent".into()))?
        .version;
    let top_bytes = bytes_at(&prior, &format!("metadata/{top_version}.targets.json"))?.to_vec();
    let top: Signed<Targets> = serde_json::from_slice(&top_bytes)?;
    let mut versions = [
        top.signed.version,
        snapshot.signed.version,
        timestamp.signed.version,
        NonZeroU64::MIN,
        NonZeroU64::MIN,
        NonZeroU64::MIN,
    ];
    let mut expires = [
        top.signed.expires,
        snapshot.signed.expires,
        timestamp.signed.expires,
        top.signed.expires,
        top.signed.expires,
        top.signed.expires,
    ];
    let mut targets = BTreeMap::new();
    for (name, target) in &top.signed.targets {
        targets.insert(
            name.raw().to_owned(),
            bytes_at(
                &prior,
                &format!(
                    "targets/{}.{}",
                    hex::encode(&target.hashes.sha256),
                    name.raw()
                ),
            )?
            .to_vec(),
        );
    }
    for (_, role) in DELEGATED {
        let version = snapshot
            .signed
            .meta
            .get(&format!("{}.json", role.name()))
            .ok_or_else(|| TufRepositoryError::Invalid("published role missing".into()))?
            .version;
        let signed: Signed<Targets> = serde_json::from_slice(bytes_at(
            &prior,
            &format!("metadata/{version}.{}.json", role.name()),
        )?)?;
        if signed.signed.targets.len() > MAX_RECORDS {
            return invalid("renewal target count exceeds limit");
        }
        versions[role.index()] = signed.signed.version;
        expires[role.index()] = signed.signed.expires;
        for (name, target) in signed.signed.targets {
            let bytes = bytes_at(
                &prior,
                &format!(
                    "targets/{}.{}",
                    hex::encode(&target.hashes.sha256),
                    name.raw()
                ),
            )?
            .to_vec();
            if targets.insert(name.raw().to_owned(), bytes).is_some() {
                return invalid("renewal target ownership overlaps");
            }
        }
    }
    if targets.len() > MAX_RECORDS + 1
        || targets
            .values()
            .map(|bytes| bytes.len() as u64)
            .sum::<u64>()
            > MAX_TOTAL_TARGET_BYTES + MAX_REGISTRY_BYTES
    {
        return invalid("renewal target set exceeds existing bounds");
    }
    let generated = expiration(&config.generated_at, "frozen renewal generation time")?;
    let mut next_versions = versions;
    let mut next_expires = expires;
    for (index, days) in [(1, 7), (2, 2), (3, 90), (4, 7), (5, 7)] {
        next_versions[index] = nonzero(
            versions[index].get().checked_add(1).ok_or_else(|| {
                TufRepositoryError::Invalid("online role version exhausted".into())
            })?,
            "next role",
        )?;
        next_expires[index] = generated
            .checked_add(Duration::from_secs(days * 86400))
            .map_err(|_| TufRepositoryError::Invalid("renewal time overflow".into()))?;
        if next_expires[index] <= expires[index] {
            return invalid("renewal expiry must advance its authenticated prior floor");
        }
    }
    let names = [
        "targets",
        "snapshot",
        "timestamp",
        "releases",
        "preview",
        "stable",
    ];
    let number_versions = |values: &[NonZeroU64; 6]| {
        names
            .iter()
            .zip(values)
            .map(|(name, value)| ((*name).to_owned(), serde_json::json!(value.get())))
            .collect::<serde_json::Map<_, _>>()
    };
    let string_versions = |values: &[NonZeroU64; 6]| {
        names
            .iter()
            .zip(values)
            .map(|(name, value)| ((*name).to_owned(), serde_json::json!(value.to_string())))
            .collect::<serde_json::Map<_, _>>()
    };
    let expiry_values = |values: &[Timestamp; 6]| {
        names
            .iter()
            .zip(values)
            .map(|(name, value)| ((*name).to_owned(), serde_json::json!(value.to_string())))
            .collect::<serde_json::Map<_, _>>()
    };
    let context = serde_json::json!({"schema_version":1,"generated_at":generated.to_string(),"trusted_root":"trusted-root.json","offline_targets":"offline-targets.json","payload_key_registry":"payload.json","reconstructed_records":"records","previous_repository":"prior","versions":number_versions(&next_versions),"expires":expiry_values(&next_expires)});
    if !targets.contains_key("keys/payload.json") {
        return invalid("payload registry absent");
    }
    let record_count = targets
        .len()
        .checked_sub(1)
        .ok_or_else(|| TufRepositoryError::Invalid("renewal target set is empty".into()))?;
    let record_manifest = records_manifest(&targets)?;
    let record_identities: Vec<_> = targets
        .iter()
        .filter(|(name, _)| name.as_str() != "keys/payload.json")
        .map(|(path, bytes)| RepositoryFileIdentity {
            path: path.clone(),
            bytes: bytes.len() as u64,
            sha256: sha256(bytes),
        })
        .collect();
    let descriptor = serde_json::json!({"schema_version":1,"kind":"application-tuf-metadata-renewal","generated_at":generated.to_string(),"root_sha256":sha256(&root_bytes),"offline_targets_sha256":sha256(&top_bytes),"prior_repository_sha256":public_prior_digest,"prior_timestamp_sha256":timestamp_sha,"prior_snapshot_sha256":snapshot_sha,"current_versions":string_versions(&versions),"next_versions":string_versions(&next_versions),"current_expires":expiry_values(&expires),"next_expires":expiry_values(&next_expires),"unchanged_records_sha256":sha256(&canonical_bytes(serde_json::to_value(&record_identities)?)?)});
    prior.insert(
        "repository-manifest.json".into(),
        manifest_bytes(&prior, record_count)?,
    );
    let mut files = BTreeMap::from([
        (
            "context.json".into(),
            canonical_envelope(&serde_json::to_vec(&context)?)?,
        ),
        (
            "renewal.json".into(),
            canonical_envelope(&serde_json::to_vec(&descriptor)?)?,
        ),
        ("trusted-root.json".into(), root_bytes),
        ("offline-targets.json".into(), top_bytes),
        (
            "payload.json".into(),
            targets
                .get("keys/payload.json")
                .ok_or_else(|| TufRepositoryError::Invalid("payload registry absent".into()))?
                .clone(),
        ),
        (
            "records/reconstruction-manifest.json".into(),
            record_manifest,
        ),
    ]);
    for (name, bytes) in prior {
        files.insert(format!("prior/{name}"), bytes);
    }
    for (name, bytes) in targets {
        if name != "keys/payload.json" {
            files.insert(format!("records/{name}"), bytes);
        }
    }
    let staged = Builder::new().prefix(".public-renewal-").tempdir_in(
        output
            .parent()
            .ok_or_else(|| TufRepositoryError::Invalid("renewal output parent absent".into()))?,
    )?;
    write_files(staged.path(), &files)?;
    // No valid plan/report escapes before safe-expiry Tough authentication,
    // strict frozen anchors, full history, target bytes and version-floor checks.
    let validated = load_context(&staged.path().join("context.json")).await?;
    if validated.root.signed.version != root.signed.version {
        return invalid("root identity changed during preparation");
    }
    let changed = if output.exists() {
        if read_prepared_output(&output)? != files {
            return invalid("prepared renewal output exists differently; never overwrite");
        }
        false
    } else {
        fs::rename(staged.path(), &output)?;
        true
    };
    Ok(RenewalReport {
        schema_version: 1,
        changed,
        output,
        descriptor_sha256: sha256(&canonical_bytes(descriptor)?),
        context_sha256: sha256(bytes_at(&files, "context.json")?),
        files: identities(&files),
        authority: "none",
    })
}

#[cfg(test)]
mod canonical_tests {
    use super::*;
    #[test]
    fn shared_node_and_rust_canonical_identities_do_not_depend_on_object_insertion_order() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../scripts/fixtures/release-metadata-canonical.json"
        )))
        .unwrap();
        for (input, expected) in [
            ("descriptor", "descriptor_sha256"),
            ("public_inventory", "public_inventory_sha256"),
        ] {
            assert_eq!(
                sha256(&canonical_bytes(fixture[input].clone()).unwrap()),
                fixture[expected].as_str().unwrap()
            );
        }
    }
}
