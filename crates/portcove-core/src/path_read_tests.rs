//! Coverage-guided controls for the production bounded metadata reader.
use std::fs;

use crate::{ErrorCode, path::read_bounded_regular};

#[test]
fn bounded_regular_read_accepts_exact_limit_and_empty_files() {
    let temporary = tempfile::tempdir().unwrap();
    let file = temporary.path().join("metadata.json");
    let bytes = b"owned metadata";
    fs::write(&file, bytes).unwrap();
    assert_eq!(
        read_bounded_regular(&file, bytes.len() as u64).unwrap(),
        bytes
    );
    assert_eq!(fs::read(&file).unwrap(), bytes);
    fs::write(&file, []).unwrap();
    assert_eq!(read_bounded_regular(&file, 0).unwrap(), b"");
}

#[test]
fn bounded_regular_read_refuses_oversized_nonregular_and_missing_inputs() {
    let temporary = tempfile::tempdir().unwrap();
    let file = temporary.path().join("metadata.json");
    let bytes = b"owned metadata";
    fs::write(&file, bytes).unwrap();
    let oversized = read_bounded_regular(&file, bytes.len() as u64 - 1).unwrap_err();
    assert_eq!(oversized.code, ErrorCode::Verification);
    assert_eq!(
        oversized
            .details
            .get("bounded_regular_oversize")
            .map(String::as_str),
        Some("true")
    );
    assert_eq!(fs::read(&file).unwrap(), bytes);
    let nonregular = read_bounded_regular(temporary.path(), 1024).unwrap_err();
    assert_eq!(nonregular.code, ErrorCode::Verification);
    assert!(!nonregular.details.contains_key("bounded_regular_oversize"));
    assert!(read_bounded_regular(&temporary.path().join("missing.json"), 1024).is_err());
}
