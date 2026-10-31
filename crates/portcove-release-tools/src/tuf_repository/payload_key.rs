//! Bounded payload-key identity inspection for an explicitly appointed recovery
//! profile. No key generation, exported signature, file write or publication.
use super::*;
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use std::io::Cursor;

const PROFILE: &str = "tauri-minisign-empty-password-v1";
const KEY_MAX: u64 = 4096;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicInput {
    path: String,
    sha256: String,
    ed25519_public_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    schema_version: u32,
    profile: String,
    private_key: String,
    expected_public_key: PublicInput,
}

#[derive(Debug, Serialize)]
pub struct PayloadKeyInspectionReport {
    schema_version: u32,
    operation: &'static str,
    public_key_id: String,
    authority: &'static str,
}

fn invalid() -> TufRepositoryError {
    TufRepositoryError::Invalid("payload custody identity inspection refused".into())
}

/// The outer encoding is the repository-pinned Tauri signer's public/private
/// file format. Bound and canonicalize both encodings before library parsing.
fn decode_box(bytes: &[u8]) -> Result<(String, Vec<u8>), TufRepositoryError> {
    if bytes.is_empty() || bytes.len() as u64 > KEY_MAX {
        return Err(invalid());
    }
    let decoded = STANDARD.decode(bytes).map_err(|_| invalid())?;
    if STANDARD.encode(&decoded).as_bytes() != bytes {
        return Err(invalid());
    }
    let text = String::from_utf8(decoded).map_err(|_| invalid())?;
    let lines: Vec<_> = text.lines().collect();
    if lines.len() != 2 || !lines[0].starts_with("untrusted comment: ") || lines[0].len() > 256 {
        return Err(invalid());
    }
    let raw = STANDARD.decode(lines[1]).map_err(|_| invalid())?;
    if STANDARD.encode(&raw) != lines[1] {
        return Err(invalid());
    }
    Ok((text, raw))
}

fn public(bytes: &[u8]) -> Result<minisign::PublicKey, TufRepositoryError> {
    let (text, raw) = decode_box(bytes)?;
    if raw.len() != 42 || &raw[..2] != b"Ed" {
        return Err(invalid());
    }
    let key = minisign::PublicKeyBox::from_string(&text)
        .and_then(|value| value.into_public_key())
        .map_err(|_| invalid())?;
    if key.to_bytes() != raw {
        return Err(invalid());
    }
    Ok(key)
}

fn private(bytes: &[u8]) -> Result<minisign::SecretKey, TufRepositoryError> {
    let (text, mut raw) = decode_box(bytes)?;
    // minisign 0.10.0 SecretKey::{from_bytes,to_bytes}: Ed, Sc, B2, 32-byte
    // salt, LE u64 ops/memory limits, then encrypted key-number/key/checksum.
    // Its parser permits trailing data; require exact layout and the pinned
    // generator's 1,048,576 operations / 32MiB BEFORE invoking any KDF.
    if raw.len() != 158
        || &raw[..6] != b"EdScB2"
        || raw[38..46] != 1_048_576u64.to_le_bytes()
        || raw[46..54] != 33_554_432u64.to_le_bytes()
    {
        raw.fill(0);
        return Err(invalid());
    }
    let parsed = minisign::SecretKey::from_bytes(&raw).map_err(|_| invalid())?;
    if parsed.to_bytes() != raw {
        raw.fill(0);
        return Err(invalid());
    }
    raw.fill(0);
    // Never None: this profile has no interactive inner-password prompt.
    // Actual generation/custody still requires its separately reconciled grant.
    let key = minisign::SecretKeyBox::from_string(&text)
        .and_then(|value| value.into_secret_key(Some(String::new())))
        .map_err(|_| invalid())?;
    if key.is_encrypted() {
        return Err(invalid());
    }
    Ok(key)
}

fn correspondence(
    appointed: &minisign::PublicKey,
    secret: &minisign::SecretKey,
) -> Result<(), TufRepositoryError> {
    if minisign::PublicKey::from_secret_key(secret)
        .map_err(|_| invalid())?
        .to_bytes()
        != appointed.to_bytes()
    {
        return Err(invalid());
    }
    // Public-half extraction alone does not establish seed correspondence.
    // Keep the random, domain-separated challenge and its signature private
    // to this process; neither is returned, persisted or usable as an artifact.
    let mut challenge = b"Portcove payload custody identity inspection v1\0".to_vec();
    let mut random = [0u8; 64];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| invalid())?;
    challenge.extend_from_slice(&random);
    let signature = minisign::sign(
        Some(appointed),
        secret,
        Cursor::new(&challenge),
        Some("Portcove custody identity inspection"),
        Some("private process-local identity challenge"),
    )
    .map_err(|_| invalid())?;
    minisign::verify(
        appointed,
        &signature,
        Cursor::new(&challenge),
        true,
        false,
        false,
    )
    .map_err(|_| invalid())
}

/// Reads exactly one separately authorized private input, checks correspondence
/// to the independently pinned public file, and emits only its public identity.
pub fn inspect_existing_key(path: &Path) -> Result<PayloadKeyInspectionReport, TufRepositoryError> {
    let config: Config = serde_json::from_slice(&offline::read_input(
        path,
        MAX_CONFIG_BYTES,
        "payload inspection config",
    )?)?;
    if config.schema_version != 1 || config.profile != PROFILE {
        return Err(invalid());
    }
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let expected = &config.expected_public_key;
    if expected.sha256.len() != 64
        || !expected
            .sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
    {
        return Err(invalid());
    }
    // Validate appointed public bytes before opening private material.
    let public_bytes = offline::read_input(
        &resolve(base, &expected.path, "payload public key")?,
        KEY_MAX,
        "payload public key",
    )?;
    if sha256(&public_bytes) != expected.sha256 {
        return Err(invalid());
    }
    let appointed = public(&public_bytes)?;
    // This is the existing payload registry/shipping verifier identity, not
    // the independent checksum of its outer base64 file representation.
    let public_identity = sha256(&STANDARD.decode(&public_bytes).map_err(|_| invalid())?);
    // Also bind the raw public identity used to keep payload/TUF appointments
    // distinct across their different serialized public-key formats.
    if expected.ed25519_public_key != hex::encode(&appointed.to_bytes()[10..]) {
        return Err(invalid());
    }
    let mut material = offline::read_input(
        &resolve(base, &config.private_key, "payload private key")?,
        KEY_MAX,
        "payload private key",
    )?;
    let decoded = private(&material);
    material.fill(0);
    correspondence(&appointed, &decoded?)?;
    Ok(PayloadKeyInspectionReport {
        schema_version: 1,
        operation: "inspect-existing-payload-key",
        public_key_id: public_identity,
        authority: "none",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(password: &str) -> (Vec<u8>, Vec<u8>) {
        let pair = minisign::KeyPair::generate_encrypted_keypair(Some(password.into())).unwrap();
        (
            STANDARD
                .encode(pair.pk.to_box().unwrap().to_bytes())
                .into_bytes(),
            STANDARD
                .encode(pair.sk.to_box(None).unwrap().to_bytes())
                .into_bytes(),
        )
    }

    fn wrapped(raw: &[u8]) -> Vec<u8> {
        STANDARD
            .encode(format!(
                "untrusted comment: disposable fixture\n{}\n",
                STANDARD.encode(raw)
            ))
            .into_bytes()
    }

    #[test]
    fn payload_projection_authenticates_empty_password_and_private_public_correspondence() {
        let (public_bytes, private_bytes) = fixture("");
        let appointed = public(&public_bytes).unwrap();
        let secret = private(&private_bytes).unwrap();
        assert!(correspondence(&appointed, &secret).is_ok());
        let (other, _) = fixture("");
        assert!(correspondence(&public(&other).unwrap(), &secret).is_err());
        let (_, protected) = fixture("different-disposable-password");
        assert!(private(&protected).is_err());
        let (_, mut corrupt) = decode_box(&private_bytes).unwrap();
        corrupt[157] ^= 1;
        assert!(private(&wrapped(&corrupt)).is_err());
    }

    #[test]
    fn payload_projection_refuses_noncanonical_or_expensive_boxes_before_kdf() {
        let (_, bytes) = fixture("");
        let (_, raw) = decode_box(&bytes).unwrap();
        for index in [0usize, 2, 4, 38, 46] {
            let mut changed = raw.clone();
            changed[index] ^= 1;
            assert!(private(&wrapped(&changed)).is_err());
        }
        let mut expensive = raw.clone();
        expensive[38..46].copy_from_slice(&u64::MAX.to_le_bytes());
        expensive[46..54].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(private(&wrapped(&expensive)).is_err());
        let mut trailing = raw.clone();
        trailing.push(0);
        assert!(private(&wrapped(&trailing)).is_err());
        assert!(private(&wrapped(&raw[..157])).is_err());
        let (text, _) = decode_box(&bytes).unwrap();
        assert!(private(STANDARD.encode(format!("{text}extra line\n")).as_bytes()).is_err());
        assert!(private(b"not a base64 box").is_err());
    }

    #[test]
    fn payload_projection_does_not_trust_a_forged_embedded_public_half() {
        let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let mut raw = pair.sk.to_bytes();
        // Keep the embedded public half and key number but change the seed.
        raw[62] ^= 1;
        let forged = minisign::SecretKey::from_bytes(&raw).unwrap();
        assert!(
            minisign::PublicKey::from_secret_key(&forged)
                .unwrap()
                .to_bytes()
                == pair.pk.to_bytes()
        );
        assert!(correspondence(&pair.pk, &forged).is_err());
    }

    #[test]
    fn payload_inspection_validates_public_pin_and_profile_before_private_acquisition() {
        let root = tempfile::tempdir().unwrap();
        let (public_bytes, private_bytes) = fixture("");
        fs::write(root.path().join("public"), &public_bytes).unwrap();
        let mut config = serde_json::json!({
            "schema_version":1,"profile":PROFILE,"private_key":"missing-private",
            "expected_public_key":{"path":"public","sha256":"0".repeat(64),
                "ed25519_public_key":hex::encode(&public(&public_bytes).unwrap().to_bytes()[10..])}
        });
        let request = root.path().join("request.json");
        fs::write(&request, serde_json::to_vec(&config).unwrap()).unwrap();
        assert!(
            inspect_existing_key(&request)
                .unwrap_err()
                .to_string()
                .contains("payload custody identity inspection refused")
        );
        config["expected_public_key"]["sha256"] = sha256(&public_bytes).into();
        config["profile"] = "unknown".into();
        fs::write(&request, serde_json::to_vec(&config).unwrap()).unwrap();
        assert!(inspect_existing_key(&request).is_err());
        config["profile"] = PROFILE.into();
        config["private_key"] = "private".into();
        fs::write(root.path().join("private"), private_bytes).unwrap();
        fs::write(&request, serde_json::to_vec(&config).unwrap()).unwrap();
        let report = inspect_existing_key(&request).unwrap();
        let public_report = serde_json::to_value(report).unwrap();
        assert_eq!(public_report.as_object().unwrap().len(), 4);
        assert_eq!(
            public_report["public_key_id"],
            sha256(&STANDARD.decode(&public_bytes).unwrap())
        );
        assert_eq!(public_report["authority"], "none");
        fs::hard_link(
            root.path().join("private"),
            root.path().join("private-alias"),
        )
        .unwrap();
        assert!(inspect_existing_key(&request).is_err());
    }
}
