use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD};
use minisign::KeyPair;
use portcove_release_tools::{VerificationError, decode_tauri_public_key, verify_artifact};
use sha2::{Digest, Sha256};

struct Fixture {
    _directory: tempfile::TempDir,
    artifact: PathBuf,
    signature: PathBuf,
    public_key: PathBuf,
    hash: String,
    bytes: u64,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        // Span several verification buffers and include non-text executable bytes.
        let payload: Vec<u8> = (0..180_321).map(|index| (index % 251) as u8).collect();
        let keys = KeyPair::generate_unencrypted_keypair().unwrap();
        let signature = minisign::sign(None, &keys.sk, Cursor::new(&payload), None, None).unwrap();
        let artifact = directory.path().join("payload");
        let signature_path = directory.path().join("payload.sig");
        let public_key = directory.path().join("public.key");
        fs::write(&artifact, &payload).unwrap();
        fs::write(&signature_path, STANDARD.encode(signature.to_string())).unwrap();
        fs::write(
            &public_key,
            STANDARD.encode(keys.pk.to_box().unwrap().to_string()),
        )
        .unwrap();
        Self {
            artifact,
            signature: signature_path,
            public_key,
            hash: hex::encode(Sha256::digest(&payload)),
            bytes: payload.len() as u64,
            _directory: directory,
        }
    }

    fn verify(&self) -> Result<portcove_release_tools::VerifiedArtifact, VerificationError> {
        verify_artifact(
            &self.artifact,
            &self.signature,
            &self.public_key,
            &self.hash,
            self.bytes,
        )
    }
}

#[test]
fn verifies_tauri_wrapped_signature_over_all_payload_bytes() {
    let fixture = Fixture::new();
    let result = fixture.verify().unwrap();
    assert_eq!(result.sha256, fixture.hash);
    assert_eq!(result.bytes, fixture.bytes);
    let decoded_key = decode_tauri_public_key(&fixture.public_key).unwrap();
    assert_eq!(
        result.public_key_sha256,
        hex::encode(Sha256::digest(decoded_key.as_bytes()))
    );
    assert!(result.signature_verified);
}

#[test]
fn rejects_changed_payload_even_when_inventory_hash_is_recomputed() {
    let mut fixture = Fixture::new();
    let mut payload = fs::read(&fixture.artifact).unwrap();
    payload[90_000] ^= 1;
    fs::write(&fixture.artifact, &payload).unwrap();
    assert!(matches!(
        fixture.verify(),
        Err(VerificationError::HashMismatch)
    ));
    fixture.hash = hex::encode(Sha256::digest(&payload));
    assert!(matches!(
        fixture.verify(),
        Err(VerificationError::Signature(_))
    ));
}

#[test]
fn rejects_wrong_key_missing_corrupt_and_oversized_signature() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    fs::copy(&other.public_key, &fixture.public_key).unwrap();
    assert!(matches!(
        fixture.verify(),
        Err(VerificationError::Signature(_))
    ));
    fs::remove_file(&fixture.signature).unwrap();
    assert!(matches!(fixture.verify(), Err(VerificationError::Io(_))));
    fs::write(&fixture.signature, b"not base64!").unwrap();
    assert!(matches!(fixture.verify(), Err(VerificationError::Encoding)));
    fs::write(&fixture.signature, vec![b'A'; 16 * 1024 + 1]).unwrap();
    assert!(matches!(fixture.verify(), Err(VerificationError::TooLarge)));
}

#[test]
fn rejects_wrong_length_invalid_identity_and_non_file_input() {
    let mut fixture = Fixture::new();
    fixture.bytes += 1;
    assert!(matches!(
        fixture.verify(),
        Err(VerificationError::LengthMismatch)
    ));
    fixture.bytes = 0;
    assert!(matches!(
        fixture.verify(),
        Err(VerificationError::InvalidIdentity)
    ));
    fixture.bytes = 2 * 1024 * 1024 * 1024 + 1;
    assert!(matches!(
        fixture.verify(),
        Err(VerificationError::InvalidIdentity)
    ));
    fixture.bytes = 180_321;
    fixture.hash = "not a hash".into();
    assert!(matches!(
        fixture.verify(),
        Err(VerificationError::InvalidIdentity)
    ));
    fixture.hash = "a".repeat(64);
    fixture.artifact = fixture._directory.path().to_path_buf();
    assert!(matches!(
        fixture.verify(),
        Err(VerificationError::UnsafeFile)
    ));
}

#[cfg(unix)]
#[test]
fn rejects_linked_payloads() {
    let mut fixture = Fixture::new();
    let link = fixture._directory.path().join("linked");
    std::os::unix::fs::symlink(&fixture.artifact, &link).unwrap();
    fixture.artifact = link;
    assert!(matches!(
        fixture.verify(),
        Err(VerificationError::UnsafeFile)
    ));
}
