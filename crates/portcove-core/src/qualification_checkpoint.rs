//! Opt-in instrumented-build observations at existing durable boundaries.
//! Receipts are observations, never operation or process-signal authority.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    PortcoveError, Result,
    operation::{LifecycleFaultInjector, LifecycleFaultPoint},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Checkpoint {
    LaunchReadyToSpawn,
    InstallPrepared,
    InstallPublished,
    RestorePrepared,
    RestorePublished,
    LibraryMovePublished,
    LibraryImportPublished,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Control {
    format_version: u32,
    nonce: String,
    library_root: PathBuf,
    checkpoint: Checkpoint,
    expires_unix_ms: u64,
}

struct Observer {
    root: PathBuf,
}

pub(crate) fn faults(root: &Path) -> Arc<dyn LifecycleFaultInjector> {
    Arc::new(Observer { root: root.into() })
}

impl LifecycleFaultInjector for Observer {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        let checkpoint = match point {
            LifecycleFaultPoint::LaunchReadyToSpawn => Checkpoint::LaunchReadyToSpawn,
            LifecycleFaultPoint::InstallPrepared => Checkpoint::InstallPrepared,
            LifecycleFaultPoint::InstallPublished => Checkpoint::InstallPublished,
            LifecycleFaultPoint::RestorePrepared => Checkpoint::RestorePrepared,
            LifecycleFaultPoint::RestorePublished => Checkpoint::RestorePublished,
            _ => return Ok(()),
        };
        observe(&self.root, checkpoint)
    }
}

fn now_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| value.as_millis().try_into().ok())
        .ok_or_else(|| PortcoveError::state("qualification clock is unavailable"))
}

pub(crate) fn observe(root: &Path, checkpoint: Checkpoint) -> Result<()> {
    let Some(control) = std::env::var_os("PORTCOVE_QUALIFICATION_CHECKPOINT") else {
        return Ok(());
    };
    observe_at(
        root,
        checkpoint,
        Path::new(&control),
        Duration::from_secs(120),
    )
}

fn observe_at(
    root: &Path,
    checkpoint: Checkpoint,
    control_path: &Path,
    budget: Duration,
) -> Result<()> {
    if !control_path.is_absolute()
        || control_path
            .file_name()
            .is_none_or(|name| name != "armed.json")
        || control_path.parent().and_then(Path::file_name)
            != Some(std::ffi::OsStr::new(".qualification-lifecycle"))
    {
        return Err(PortcoveError::verification(
            "qualification control path is not admitted",
        ));
    }
    crate::path::refuse_symlink_ancestors(control_path)?;
    // Disarming removes only this file after independently proven host exit.
    if fs::symlink_metadata(control_path)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(());
    }
    let bytes = crate::path::read_bounded_regular(control_path, 4096)?;
    let control: Control = serde_json::from_slice(&bytes)?;
    let nonce = uuid::Uuid::parse_str(&control.nonce)
        .map_err(|_| PortcoveError::verification("qualification nonce is invalid"))?;
    if control.format_version != 1
        || nonce.to_string() != control.nonce
        || !control.library_root.is_absolute()
    {
        return Err(PortcoveError::verification(
            "qualification control is invalid",
        ));
    }
    crate::path::refuse_symlink_ancestors(root)?;
    crate::path::refuse_symlink_ancestors(&control.library_root)?;
    let root = fs::canonicalize(root)?;
    if control.checkpoint != checkpoint || fs::canonicalize(&control.library_root)? != root {
        return Ok(());
    }
    let started = Instant::now();
    let now = now_ms()?;
    let remaining = control
        .expires_unix_ms
        .checked_sub(now)
        .filter(|remaining| *remaining > 0 && *remaining <= 300_000)
        .ok_or_else(|| {
            PortcoveError::verification("qualification control expired or exceeds its finite bound")
        })?;
    let budget = budget.min(Duration::from_millis(remaining));
    let deadline = now.saturating_add(u64::try_from(budget.as_millis()).unwrap_or(u64::MAX));
    let parent = control_path.parent().expect("validated control parent");
    let marker = parent.join(format!("entered-{}.json", control.nonce));
    let release = parent.join(format!("release-{}.txt", control.nonce));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker)?;
    serde_json::to_writer(
        &mut file,
        &serde_json::json!({
            "format_version": 1,
            "nonce": control.nonce,
            "checkpoint": checkpoint,
            "library_root": root,
            "process_id": std::process::id(),
            "entered_unix_ms": now,
            "deadline_unix_ms": deadline,
            "control_sha256": hex::encode(Sha256::digest(&bytes)),
        }),
    )?;
    file.flush()?;
    file.sync_all()?;
    while started.elapsed() < budget {
        match fs::symlink_metadata(&release) {
            Ok(_) => {
                crate::path::refuse_symlink_ancestors(&release)?;
                let value = crate::path::read_bounded_regular(&release, 64)?;
                if value != control.nonce.as_bytes() {
                    return Err(PortcoveError::verification(
                        "qualification release nonce changed",
                    ));
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err(PortcoveError::state(
        "qualification checkpoint timed out; preserve the observation and recovery state",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, String) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("library");
        fs::create_dir(&root).unwrap();
        let controls = temporary.path().join(".qualification-lifecycle");
        fs::create_dir(&controls).unwrap();
        let nonce = uuid::Uuid::new_v4().to_string();
        let control = controls.join("armed.json");
        fs::write(
            &control,
            serde_json::to_vec(&serde_json::json!({
                "format_version": 1,
                "nonce": nonce,
                "library_root": fs::canonicalize(&root).unwrap(),
                "checkpoint": "install_prepared",
                "expires_unix_ms": now_ms().unwrap() + 30_000,
            }))
            .unwrap(),
        )
        .unwrap();
        (temporary, root, control, nonce)
    }

    #[test]
    fn unrelated_point_and_library_cannot_claim_checkpoint() {
        let (temporary, root, control, _) = fixture();
        observe_at(&root, Checkpoint::RestorePrepared, &control, Duration::ZERO).unwrap();
        let other = temporary.path().join("other");
        fs::create_dir(&other).unwrap();
        observe_at(
            &other,
            Checkpoint::InstallPrepared,
            &control,
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(fs::read_dir(control.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn matched_timeout_retains_actual_marker_and_collision_never_overwrites() {
        let (_temporary, root, control, nonce) = fixture();
        assert!(observe_at(&root, Checkpoint::InstallPrepared, &control, Duration::ZERO).is_err());
        let marker = control
            .parent()
            .unwrap()
            .join(format!("entered-{nonce}.json"));
        let original = fs::read(&marker).unwrap();
        let receipt: serde_json::Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(receipt["process_id"], std::process::id());
        assert_eq!(receipt["checkpoint"], "install_prepared");
        assert_eq!(receipt["nonce"], nonce);
        assert!(observe_at(&root, Checkpoint::InstallPrepared, &control, Duration::ZERO).is_err());
        assert_eq!(fs::read(marker).unwrap(), original);
    }

    #[test]
    fn explicit_release_requires_matching_nonce() {
        for (checkpoint, matching) in [
            (Checkpoint::InstallPrepared, false),
            (Checkpoint::InstallPrepared, true),
            (Checkpoint::LaunchReadyToSpawn, false),
            (Checkpoint::LaunchReadyToSpawn, true),
        ] {
            let (_temporary, root, control, nonce) = fixture();
            let mut selected: serde_json::Value =
                serde_json::from_slice(&fs::read(&control).unwrap()).unwrap();
            selected["checkpoint"] = serde_json::to_value(checkpoint).unwrap();
            fs::write(&control, serde_json::to_vec(&selected).unwrap()).unwrap();
            fs::write(
                control
                    .parent()
                    .unwrap()
                    .join(format!("release-{nonce}.txt")),
                if matching {
                    nonce.as_str()
                } else {
                    "wrong-nonce"
                },
            )
            .unwrap();
            // Marker fsync is part of this harness wait on Windows. Keep a finite
            // disk-tolerant budget without changing the instrumented observer.
            let result = observe_at(&root, checkpoint, &control, Duration::from_secs(15));
            assert_eq!(result.is_ok(), matching, "{checkpoint:?}: {result:?}");
        }
    }

    #[test]
    fn malformed_or_expired_controls_cannot_become_a_pass() {
        for bytes in [
            b"not-json".to_vec(),
            vec![b'x'; 4097],
            serde_json::to_vec(&serde_json::json!({
                "format_version": 1,
                "nonce": uuid::Uuid::new_v4().to_string(),
                "library_root": "relative",
                "checkpoint": "install_prepared",
                "expires_unix_ms": 0,
            }))
            .unwrap(),
        ] {
            let (_temporary, root, control, _) = fixture();
            fs::write(&control, bytes).unwrap();
            assert!(
                observe_at(&root, Checkpoint::InstallPrepared, &control, Duration::ZERO).is_err()
            );
        }
        for (key, invalid) in [
            ("expires_unix_ms", serde_json::json!(0)),
            (
                "expires_unix_ms",
                serde_json::json!(now_ms().unwrap() + 600_000),
            ),
            ("format_version", serde_json::json!(2)),
            ("nonce", serde_json::json!("../not-a-nonce")),
            ("checkpoint", serde_json::json!("unreviewed_boundary")),
            ("unknown_permission", serde_json::json!(true)),
        ] {
            let (_temporary, root, control, _) = fixture();
            let mut value: serde_json::Value =
                serde_json::from_slice(&fs::read(&control).unwrap()).unwrap();
            value[key] = invalid;
            fs::write(&control, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(
                observe_at(&root, Checkpoint::InstallPrepared, &control, Duration::ZERO).is_err()
            );
        }
    }
}
