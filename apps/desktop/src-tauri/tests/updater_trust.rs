//! Disposable TUF design fixtures, not a production updater or signer.
//! Every test generates fresh keys and operates only inside temporary directories.

mod updater_trust_support;

use std::collections::BTreeSet;
use std::fs;

use futures_util::TryStreamExt;
use portcove_desktop::application_update::{
    ApplicationChannel, CandidateState, InstallOwner, InstalledApplicationContext,
};
use portcove_desktop::application_update_repository::{
    CandidateLoadError, select_repository_candidate,
};
use portcove_desktop::application_update_trust::{
    TrustedRepositoryError, TrustedRepositoryRequest, load_trusted_repository,
};
use tough::TargetName;
use tough::error::Error;
use tough::schema::RoleType;
use updater_trust_support::{Fixture, Key, expiration, nz};
use url::Url;

fn installed_context() -> InstalledApplicationContext {
    InstalledApplicationContext {
        current_version: "0.3.0".into(),
        target: "windows-x86_64".into(),
        os: "windows".into(),
        os_version: "10.0.26200".into(),
        architecture: "x86_64".into(),
        execution_context: "native".into(),
        package_kind: "nsis".into(),
        install_owner: InstallOwner::Portcove,
        product_id: "portcove-desktop".into(),
        capabilities: BTreeSet::from(["host-api-1".into()]),
        cli_protocol: 1,
        catalog_format: 2,
        library_schema: 1,
        library_write_schema: 1,
        lock_protocol: "library-lock-v1".into(),
    }
}

#[tokio::test]
async fn rotation_survives_one_lost_offline_key_and_revokes_old_online_key() {
    let f = Fixture::new().await;
    let old = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&old, &old, &f.offline).await;
    f.publish(&trusted, &f.online, 1, expiration()).await;
    f.load(&trusted).await.unwrap();
    let stolen_timestamp = fs::read(f.metadata.join("timestamp.json")).unwrap();

    let replacement = Key::new(f.directory.path()).await;
    let replacement_offline = [
        Key::new(f.directory.path()).await,
        f.offline[1].clone(),
        f.offline[2].clone(),
    ];
    let new = f.root(2, &replacement_offline, &replacement).await;
    // One offline key is unavailable. The remaining two satisfy the old and new quorum.
    let bridge = f.sign_root(&new, &old, &f.offline[1..]).await;
    fs::write(f.metadata.join("2.root.json"), &bridge).unwrap();
    f.publish(&bridge, &replacement, 2, expiration()).await;
    let updated = f.load(&trusted).await.unwrap();
    assert_eq!(updated.root().signed.version, nz(2));

    fs::write(f.metadata.join("timestamp.json"), stolen_timestamp).unwrap();
    assert!(
        matches!(
            f.load(&bridge).await,
            Err(Error::VerifyMetadata {
                role: RoleType::Timestamp,
                ..
            })
        ),
        "revoked online signatures must fail"
    );
}

#[tokio::test]
async fn root_rotation_requires_both_quorums_and_all_intermediate_bridges() {
    let f = Fixture::new().await;
    let old = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&old, &old, &f.offline).await;
    let replacement = [
        Key::new(f.directory.path()).await,
        Key::new(f.directory.path()).await,
        Key::new(f.directory.path()).await,
    ];
    let new_online = Key::new(f.directory.path()).await;
    let middle = f.root(2, &replacement, &new_online).await;
    let latest = f.root(3, &replacement, &new_online).await;
    let mut union = old.clone();
    union.keys.extend(middle.keys.clone());
    union
        .roles
        .get_mut(&tough::schema::RoleType::Root)
        .unwrap()
        .keyids
        .extend(middle.roles[&tough::schema::RoleType::Root].keyids.clone());
    let signers: Vec<_> = f.offline.iter().chain(&replacement).cloned().collect();
    let bridge = f.sign_root(&middle, &union, &signers).await;
    let current = f.sign_root(&latest, &middle, &replacement).await;
    fs::write(f.metadata.join("3.root.json"), &current).unwrap();
    f.publish(&current, &new_online, 3, expiration()).await;

    // Rotate the online key too: an old client cannot authenticate current metadata
    // until it receives the continuous root chain (a version jump is insufficient).
    assert!(f.load(&trusted).await.is_err());
    fs::write(f.metadata.join("2.root.json"), &bridge).unwrap();
    assert_eq!(f.load(&trusted).await.unwrap().root().signed.version, nz(3));

    let only_new = f.sign_root(&middle, &middle, &replacement).await;
    fs::write(f.metadata.join("2.root.json"), only_new).unwrap();
    assert!(
        f.load(&trusted).await.is_err(),
        "new keys cannot appoint themselves"
    );
    let only_old = f.sign_root(&middle, &old, &f.offline).await;
    fs::write(f.metadata.join("2.root.json"), only_old).unwrap();
    assert!(
        f.load(&trusted).await.is_err(),
        "new root must also meet its own quorum"
    );
}

#[tokio::test]
async fn one_compromised_root_key_or_lost_quorum_cannot_replace_trust() {
    let f = Fixture::new().await;
    let root = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&root, &root, &f.offline).await;
    f.publish(&trusted, &f.online, 1, expiration()).await;
    let malicious = f.root(2, &f.offline, &f.online).await;
    let single_signature = f.sign_root(&malicious, &root, &f.offline[..1]).await;
    fs::write(f.metadata.join("2.root.json"), single_signature).unwrap();
    assert!(f.load(&trusted).await.is_err());
    // Losing two keys leaves the same insufficient quorum. There is no bypass.
    let online_only = f
        .sign_root(&malicious, &root, std::slice::from_ref(&f.online))
        .await;
    fs::write(f.metadata.join("2.root.json"), online_only).unwrap();
    assert!(f.load(&trusted).await.is_err());
}

#[tokio::test]
async fn persisted_metadata_rejects_replay_and_expiry_without_touching_user_data() {
    let f = Fixture::new().await;
    let root = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&root, &root, &f.offline).await;
    let user_data = f.directory.path().join("newer-save.bin");
    fs::write(&user_data, b"newer user data").unwrap();
    f.publish(&trusted, &f.online, 1, expiration()).await;
    let timestamp = fs::read(f.metadata.join("timestamp.json")).unwrap();
    let snapshot = fs::read(f.metadata.join("snapshot.json")).unwrap();
    let targets = fs::read(f.metadata.join("targets.json")).unwrap();
    let state = f.directory.path().join("trusted-state");
    fs::create_dir(&state).unwrap();
    f.publish(&trusted, &f.online, 2, expiration()).await;
    f.load_persisted(&trusted, &state).await.unwrap();
    fs::write(f.metadata.join("timestamp.json"), timestamp).unwrap();
    assert!(matches!(
        f.load_persisted(&trusted, &state).await,
        Err(TrustedRepositoryError::Authentication(error))
            if matches!(*error, Error::OlderMetadata {
                role: RoleType::Timestamp,
                ..
            })
    ));

    for role in ["timestamp.json", "snapshot.json", "targets.json"] {
        fs::remove_file(state.join("metadata").join(role)).unwrap();
    }
    fs::write(f.metadata.join("snapshot.json"), snapshot).unwrap();
    fs::write(f.metadata.join("targets.json"), targets).unwrap();
    assert!(matches!(
        f.load_persisted(&trusted, &state).await,
        Err(TrustedRepositoryError::InvalidState(message))
            if message == "timestamp metadata is below or differs from its replay floor"
    ));
    f.publish(
        &trusted,
        &f.online,
        3,
        "2000-01-01T00:00:00Z".parse().unwrap(),
    )
    .await;
    let expired = f.load_persisted(&trusted, &state).await;
    assert!(
        matches!(
        expired,
        Err(TrustedRepositoryError::Authentication(ref error))
            if matches!(error.as_ref(), Error::ExpiredMetadata {
                role: RoleType::Timestamp,
                ..
            })
        ),
        "{expired:?}"
    );
    assert_eq!(fs::read(user_data).unwrap(), b"newer user data");
}

#[tokio::test]
async fn failed_refresh_persists_rotated_root_for_the_next_restart() {
    let f = Fixture::new().await;
    let old = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&old, &old, &f.offline).await;
    f.publish(&trusted, &f.online, 1, expiration()).await;
    let state = f.directory.path().join("host-trust-after-failure");
    let first = f.load_persisted(&trusted, &state).await.unwrap();
    assert_eq!(first.versions.root, 1);
    assert_eq!(first.versions.timestamp, 1);

    let replacement_online = Key::new(f.directory.path()).await;
    let current = f.root(2, &f.offline, &replacement_online).await;
    let bridge = f.sign_root(&current, &old, &f.offline).await;
    fs::write(f.metadata.join("2.root.json"), &bridge).unwrap();
    f.publish(&bridge, &replacement_online, 2, expiration())
        .await;
    let valid_timestamp = fs::read(f.metadata.join("timestamp.json")).unwrap();
    fs::write(f.metadata.join("timestamp.json"), b"not signed metadata").unwrap();
    assert!(matches!(
        f.load_persisted(&trusted, &state).await,
        Err(TrustedRepositoryError::Authentication(_))
    ));

    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(state.join("trust-state.json")).unwrap()).unwrap();
    assert_eq!(persisted["root"]["version"], 2);

    fs::remove_file(f.metadata.join("2.root.json")).unwrap();
    fs::write(f.metadata.join("timestamp.json"), valid_timestamp).unwrap();
    let restarted = f.load_persisted(&trusted, &state).await.unwrap();
    assert_eq!(restarted.versions.root, 2);
    assert_eq!(restarted.versions.timestamp, 2);
}

#[tokio::test]
async fn failed_initial_root_refresh_retains_bootstrap_root_for_retry() {
    let f = Fixture::new().await;
    let old = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&old, &old, &f.offline).await;
    f.publish(&trusted, &f.online, 1, expiration()).await;

    let replacement = [
        Key::new(f.directory.path()).await,
        Key::new(f.directory.path()).await,
        Key::new(f.directory.path()).await,
    ];
    let replacement_online = Key::new(f.directory.path()).await;
    let next = f.root(2, &replacement, &replacement_online).await;
    let self_appointed = f.sign_root(&next, &next, &replacement).await;
    fs::write(f.metadata.join("2.root.json"), self_appointed).unwrap();

    let state = f.directory.path().join("host-trust-initial-root-failure");
    assert!(matches!(
        f.load_persisted(&trusted, &state).await,
        Err(TrustedRepositoryError::Authentication(error))
            if matches!(*error, Error::VerifyMetadata {
                role: RoleType::Root,
                ..
            })
    ));
    assert!(state.join("metadata/root.json").is_file());

    fs::remove_file(f.metadata.join("2.root.json")).unwrap();
    let retried = f.load_persisted(&trusted, &state).await.unwrap();
    assert_eq!(retried.versions.root, 1);
}

#[tokio::test]
async fn greatest_accepted_time_rejects_clock_regression() {
    let f = Fixture::new().await;
    let root = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&root, &root, &f.offline).await;
    f.publish(&trusted, &f.online, 1, expiration()).await;
    let state = f.directory.path().join("host-trust-clock");
    f.load_persisted(&trusted, &state).await.unwrap();

    let state_path = state.join("trust-state.json");
    let mut persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    persisted["greatest_accepted_time"] = "2999-01-01T00:00:00Z".into();
    fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap()).unwrap();

    assert!(matches!(
        f.load_persisted(&trusted, &state).await,
        Err(TrustedRepositoryError::ClockRegression { .. })
    ));
}

#[tokio::test]
async fn host_loader_refuses_untrusted_source_schemes_before_state_mutation() {
    let f = Fixture::new().await;
    let root = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&root, &root, &f.offline).await;
    let refused_state = f.directory.path().join("refused-network-state");
    assert!(matches!(
        load_trusted_repository(TrustedRepositoryRequest {
            bundled_root: &trusted,
            metadata_base_url: Url::parse("http://updates.invalid/metadata/").unwrap(),
            targets_base_url: Url::parse("http://updates.invalid/targets/").unwrap(),
            state_directory: &refused_state,
        })
        .await,
        Err(TrustedRepositoryError::InvalidSource(_))
    ));
    assert!(!refused_state.exists());
}

#[tokio::test]
async fn retained_body_hash_rejects_equal_version_equivocation_without_tuf_cache() {
    let f = Fixture::new().await;
    let root = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&root, &root, &f.offline).await;
    let expires = expiration();
    f.publish_target(&trusted, &f.online, 1, expires, b"first target")
        .await;
    let state = f.directory.path().join("host-trust-equivocation");
    f.load_persisted(&trusted, &state).await.unwrap();

    for role in ["timestamp.json", "snapshot.json", "targets.json"] {
        fs::remove_file(state.join("metadata").join(role)).unwrap();
    }
    f.publish_target(&trusted, &f.online, 1, expires, b"different target")
        .await;
    assert!(matches!(
        f.load_persisted(&trusted, &state).await,
        Err(TrustedRepositoryError::InvalidState(message))
            if message == "timestamp metadata is below or differs from its replay floor"
    ));
}

#[tokio::test]
async fn process_guard_allows_only_one_check_for_the_same_state() {
    let f = Fixture::new().await;
    let root = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&root, &root, &f.offline).await;
    f.publish(&trusted, &f.online, 1, expiration()).await;
    let state = f.directory.path().join("host-trust-concurrent");

    let (left, right) = tokio::join!(
        f.load_persisted(&trusted, &state),
        f.load_persisted(&trusted, &state)
    );
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    assert!(
        matches!(left, Err(TrustedRepositoryError::Busy))
            || matches!(right, Err(TrustedRepositoryError::Busy))
    );
}

#[tokio::test]
async fn release_record_tampering_is_rejected_before_consumption() {
    let f = Fixture::new().await;
    let root = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&root, &root, &f.offline).await;
    f.publish(&trusted, &f.online, 1, expiration()).await;
    let repo = f.load(&trusted).await.unwrap();
    let name = TargetName::new("release.json").unwrap();
    let bytes = repo
        .read_target(&name)
        .await
        .unwrap()
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    assert!(!bytes.is_empty());
    let mut tampered = bytes.concat();
    tampered[0] ^= 1;
    fs::write(f.targets.join("release.json"), tampered).unwrap();
    let stream = repo.read_target(&name).await.unwrap().unwrap();
    let failure = stream.try_collect::<Vec<_>>().await.unwrap_err();
    // Streaming errors retain the digest mismatch inside the transport wrapper.
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(&failure);
    let mut hash_mismatch = false;
    while let Some(error) = cause {
        hash_mismatch |= matches!(
            error.downcast_ref::<Error>(),
            Some(Error::HashMismatch { .. })
        );
        cause = error.source();
    }
    assert!(hash_mismatch, "expected a hash mismatch: {failure}");
}

#[tokio::test]
async fn candidate_loader_refuses_top_level_update_records() {
    let f = Fixture::new().await;
    let root = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&root, &root, &f.offline).await;
    f.publish_named_target(
        &trusted,
        &f.online,
        1,
        expiration(),
        "channels/stable/windows-x86_64/nsis/1.0.0.json",
        b"{}",
    )
    .await;
    let state = f.directory.path().join("candidate-top-level-trust");
    let repo = f.load_persisted(&trusted, &state).await.unwrap();

    let error =
        select_repository_candidate(&repo, ApplicationChannel::Stable, &installed_context())
            .await
            .unwrap_err();
    assert!(matches!(
        error,
        CandidateLoadError::InvalidIndex(message)
            if message.contains("top-level targets must delegate")
    ));
}

#[tokio::test]
async fn channel_role_requires_its_own_key_and_authenticates_separate_promotion_bytes() {
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use tough::editor::RepositoryEditor;
    use tough::schema::{PathPattern, PathSet};

    let f = Fixture::new().await;
    let root = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&root, &root, &f.offline).await;
    let release = Key::new(f.directory.path()).await;
    let promotion = Key::new(f.directory.path()).await;
    let root_path = f.directory.path().join("delegation-root.json");
    fs::write(&root_path, &trusted).unwrap();
    let registry_name = "keys/payload.json";
    let release_name = "releases/1.0.0/windows-x86_64/nsis.json";
    let promotion_name = "channels/stable/windows-x86_64/nsis/1.0.0.json";
    let unrelated_promotion_name = "channels/stable/linux-x86_64/appimage/2.0.0.json";
    let registry_path = f.targets.join(registry_name);
    let release_path = f.targets.join(release_name);
    let promotion_path = f.targets.join(promotion_name);
    let unrelated_promotion_path = f.targets.join(unrelated_promotion_name);
    fs::create_dir_all(registry_path.parent().unwrap()).unwrap();
    fs::create_dir_all(release_path.parent().unwrap()).unwrap();
    fs::create_dir_all(promotion_path.parent().unwrap()).unwrap();
    fs::create_dir_all(unrelated_promotion_path.parent().unwrap()).unwrap();
    fs::write(&registry_path, b"fixture payload key registry").unwrap();
    let release_bytes = serde_json::to_vec(&json!({
        "schema_version": 1,
        "version": "1.0.0",
        "source_commit": "a".repeat(40),
        "source_tree": "b".repeat(40),
        "qualified_run": {
            "workflow": "release.yml",
            "workflow_commit": "e".repeat(40),
            "run_id": 42,
            "attempt": 1,
            "inventory_sha256": "f".repeat(64)
        },
        "target": "windows-x86_64",
        "os": "windows",
        "architecture": "x86_64",
        "execution_context": "native",
        "package": { "kind": "nsis", "owner": "portcove", "product_id": "portcove-desktop" },
        "artifact": {
            "url": "https://github.com/boburning/portcove/releases/download/v1.0.0/Portcove.exe",
            "sha256": "c".repeat(64),
            "bytes": 1024,
            "tauri_signature": "fixture-signature",
            "payload_key_id": "d".repeat(64)
        },
        "compatibility": {
            "minimum_os_version": "10.0.19045",
            "required_capabilities": ["host-api-1"],
            "cli_protocol": { "min": 1, "max": 1 },
            "catalog_formats": [2],
            "library": {
                "read": { "min": 1, "max": 1 },
                "write_schema": 1,
                "lock_protocol": "library-lock-v1"
            }
        },
        "evidence_ids": ["ci-run-42", "windows-package-42"]
    }))
    .unwrap();
    fs::write(&release_path, &release_bytes).unwrap();
    let promotion_bytes = serde_json::to_vec(&json!({
        "schema_version": 1,
        "channel": "stable",
        "target": "windows-x86_64",
        "package": "nsis",
        "version": "1.0.0",
        "release_path": release_name,
        "release_sha256": hex::encode(Sha256::digest(&release_bytes)),
        "eligible": true,
        "production_eligible": true,
        "withdrawn": false,
        "reason": null,
        "required_bridge": null
    }))
    .unwrap();
    fs::write(&promotion_path, &promotion_bytes).unwrap();
    fs::write(
        &unrelated_promotion_path,
        b"ignored unrelated package record",
    )
    .unwrap();
    let mut editor = RepositoryEditor::new(root_path).await.unwrap();
    editor
        .targets_version(nz(1))
        .unwrap()
        .targets_expires(expiration())
        .unwrap()
        .snapshot_version(nz(1))
        .snapshot_expires(expiration())
        .timestamp_version(nz(1))
        .timestamp_expires(expiration());
    editor
        .delegate_role(
            "stable",
            &[promotion.source()],
            PathSet::Paths(vec![
                PathPattern::new(promotion_name).unwrap(),
                PathPattern::new(unrelated_promotion_name).unwrap(),
            ]),
            true,
            nz(1),
            expiration(),
            nz(1),
        )
        .await
        .unwrap();
    editor
        .delegate_role(
            "releases",
            &[release.source()],
            PathSet::Paths(vec![PathPattern::new(release_name).unwrap()]),
            true,
            nz(1),
            expiration(),
            nz(1),
        )
        .await
        .unwrap();
    let (_, registry_target) = RepositoryEditor::build_target(&registry_path)
        .await
        .unwrap();
    editor.add_target(registry_name, registry_target).unwrap();
    editor
        .sign_targets_editor(&[f.online.source()])
        .await
        .unwrap()
        .change_delegated_targets("releases")
        .unwrap()
        .targets_version(nz(1))
        .unwrap()
        .targets_expires(expiration())
        .unwrap();
    let (_, release_target) = RepositoryEditor::build_target(&release_path).await.unwrap();
    editor.add_target(release_name, release_target).unwrap();
    match editor.sign_targets_editor(&[f.online.source()]).await {
        Err(error) => assert!(
            matches!(error, Error::SigningKeysNotFound { .. }),
            "{error}"
        ),
        Ok(_) => panic!("top-level targets key must not sign the release role"),
    }
    editor
        .sign_targets_editor(&[release.source()])
        .await
        .unwrap()
        .change_delegated_targets("stable")
        .unwrap()
        .targets_version(nz(1))
        .unwrap()
        .targets_expires(expiration())
        .unwrap();
    let (_, promotion_target) = RepositoryEditor::build_target(&promotion_path)
        .await
        .unwrap();
    editor.add_target(promotion_name, promotion_target).unwrap();
    let (_, unrelated_promotion_target) = RepositoryEditor::build_target(&unrelated_promotion_path)
        .await
        .unwrap();
    editor
        .add_target(unrelated_promotion_name, unrelated_promotion_target)
        .unwrap();
    match editor.sign_targets_editor(&[release.source()]).await {
        Err(error) => assert!(
            matches!(error, Error::SigningKeysNotFound { .. }),
            "{error}"
        ),
        Ok(_) => panic!("release key must not sign the promotion role"),
    }
    editor
        .sign_targets_editor(&[promotion.source()])
        .await
        .unwrap()
        .change_delegated_targets("targets")
        .unwrap()
        .targets_version(nz(1))
        .unwrap()
        .targets_expires(expiration())
        .unwrap();
    editor
        .sign(&[f.online.source()])
        .await
        .unwrap()
        .write(&f.metadata)
        .await
        .unwrap();
    let state = f.directory.path().join("candidate-trust");
    let repo = f.load_persisted(&trusted, &state).await.unwrap();
    let selection =
        select_repository_candidate(&repo, ApplicationChannel::Stable, &installed_context())
            .await
            .unwrap();
    assert_eq!(selection.state, CandidateState::UpdateAvailable);
    assert_eq!(selection.candidate.unwrap().release.version, "1.0.0");
}
