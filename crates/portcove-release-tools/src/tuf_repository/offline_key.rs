//! Single-key initial creation and read-only recovery identity inspection.
use super::*;
use aws_lc_rs::{rand::SystemRandom, signature::Ed25519KeyPair};
use std::{fs::OpenOptions, io::Write};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    schema_version: u32,
    output_directory: String,
}

#[derive(Serialize)]
pub struct KeyReport {
    schema_version: u32,
    operation: &'static str,
    public_key_id: String,
    public_key_sha256: String,
    private_file: &'static str,
    public_file: &'static str,
    authority: &'static str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InspectionConfig {
    schema_version: u32,
    private_key: String,
    expected_public_key: offline::PublicKeyInput,
}

#[derive(Serialize)]
pub struct KeyInspectionReport {
    schema_version: u32,
    operation: &'static str,
    public_key_id: String,
    authority: &'static str,
}

/// Read-only recovery inspection against an independently appointed public key.
/// Does not generate keys, sign, write files, or establish custody/role authority.
pub async fn inspect_existing_key(path: &Path) -> Result<KeyInspectionReport, TufRepositoryError> {
    let config: InspectionConfig = serde_json::from_slice(&offline::read_input(
        path,
        MAX_CONFIG_BYTES,
        "key inspection config",
    )?)?;
    if config.schema_version != 1 {
        return offline::invalid("key inspection schema differs");
    }
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    // Validate the pinned public input before opening any private material.
    let expected = offline::public_key(base, &config.expected_public_key)?;
    let private = offline::read_input(
        &resolve(base, &config.private_key, "existing private key")?,
        MAX_CONFIG_BYTES,
        "existing private key",
    )?;
    let source = key(Arc::from(private));
    let projected = source
        .as_sign()
        .await
        .map_err(|_| TufRepositoryError::Invalid("existing private key cannot be parsed".into()))?
        .tuf_key();
    if projected != expected {
        return offline::invalid("existing private key differs from appointed public key");
    }
    Ok(KeyInspectionReport {
        schema_version: 1,
        operation: "inspect-existing-tuf-key",
        public_key_id: hex::encode(expected.key_id()?.as_ref()),
        authority: "none",
    })
}

/// Creates a fresh directory with one private PKCS8 and one public TUF JSON file.
/// Production invocation/custody is independently authorized initial setup.
pub async fn create_one_key(path: &Path) -> Result<KeyReport, TufRepositoryError> {
    let config: Config = serde_json::from_slice(&offline::read_input(
        path,
        MAX_CONFIG_BYTES,
        "one-key config",
    )?)?;
    if config.schema_version != 1 {
        return offline::invalid("one-key setup schema differs");
    }
    let output = resolve(
        path.parent().unwrap_or_else(|| Path::new(".")),
        &config.output_directory,
        "one-key output directory",
    )?;
    let parent = output
        .parent()
        .ok_or_else(|| TufRepositoryError::Invalid("one-key output has no parent".into()))?;
    for ancestor in parent.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata = fs::symlink_metadata(ancestor)?;
        if metadata.file_type().is_symlink() {
            return offline::invalid("one-key output ancestry contains links");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return offline::invalid("one-key output ancestry contains reparse points");
            }
        }
    }
    #[cfg(unix)]
    let directory = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let directory = fs::DirBuilder::new();
    directory.create(&output)?;
    // No retry/cleanup: failed or partial output remains explicit custody material.
    let private = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| TufRepositoryError::Invalid("one-key generation failed".into()))?;
    let source = key(Arc::from(private.as_ref()));
    let public = source
        .as_sign()
        .await
        .map_err(|_| TufRepositoryError::Invalid("generated key projection failed".into()))?
        .tuf_key();
    let mut public_bytes = serde_json::to_vec_pretty(&public)?;
    public_bytes.push(b'\n');
    for (name, bytes) in [
        ("private.pk8", private.as_ref()),
        ("public.json", public_bytes.as_slice()),
    ] {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(output.join(name))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if offline::read_input(
            &output.join(name),
            MAX_CONFIG_BYTES,
            "one-key output readback",
        )? != bytes
        {
            return offline::invalid("one-key output readback differs");
        }
    }
    #[cfg(unix)]
    {
        fs::File::open(&output)?.sync_all()?;
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(KeyReport {
        schema_version: 1,
        operation: "initial-one-key-creation",
        public_key_id: hex::encode(public.key_id()?.as_ref()),
        public_key_sha256: sha256(&public_bytes),
        private_file: "private.pk8",
        public_file: "public.json",
        authority: "none",
    })
}
