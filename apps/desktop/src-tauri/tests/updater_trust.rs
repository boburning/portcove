//! Disposable TUF design fixtures, not a production updater or signer.
//! Every test generates fresh keys and operates only inside temporary directories.

mod updater_trust_support;

use std::fs;

use futures_util::TryStreamExt;
use tough::error::Error;
use tough::schema::RoleType;
use tough::{RepositoryLoader, TargetName};
use updater_trust_support::{Fixture, Key, expiration, nz};

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
    let state = f.directory.path().join("trusted-state");
    fs::create_dir(&state).unwrap();
    f.publish(&trusted, &f.online, 2, expiration()).await;
    RepositoryLoader::new(&trusted, f.metadata_url(), f.targets_url())
        .datastore(&state)
        .load()
        .await
        .unwrap();
    fs::write(f.metadata.join("timestamp.json"), timestamp).unwrap();
    assert!(matches!(
        RepositoryLoader::new(&trusted, f.metadata_url(), f.targets_url())
            .datastore(&state)
            .load()
            .await,
        Err(Error::OlderMetadata {
            role: RoleType::Timestamp,
            ..
        })
    ));
    f.publish(
        &trusted,
        &f.online,
        3,
        "2000-01-01T00:00:00Z".parse().unwrap(),
    )
    .await;
    assert!(matches!(
        f.load(&trusted).await,
        Err(Error::ExpiredMetadata {
            role: RoleType::Timestamp,
            ..
        })
    ));
    assert_eq!(fs::read(user_data).unwrap(), b"newer user data");
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
    assert!(matches!(
        stream.try_collect::<Vec<_>>().await,
        Err(Error::HashMismatch { .. })
    ));
}

#[tokio::test]
async fn channel_role_requires_its_own_key_and_authenticates_separate_promotion_bytes() {
    use tough::editor::RepositoryEditor;
    use tough::schema::{PathPattern, PathSet};

    let f = Fixture::new().await;
    let root = f.root(1, &f.offline, &f.online).await;
    let trusted = f.sign_root(&root, &root, &f.offline).await;
    let promotion = Key::new(f.directory.path()).await;
    let root_path = f.directory.path().join("delegation-root.json");
    fs::write(&root_path, &trusted).unwrap();
    let record = f.targets.join("stable.json");
    fs::write(
        &record,
        br#"{"release":"1.0.0","eligible":true,"fixture":true}"#,
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
            PathSet::Paths(vec![PathPattern::new("stable.json").unwrap()]),
            true,
            nz(1),
            expiration(),
            nz(1),
        )
        .await
        .unwrap();
    editor
        .sign_targets_editor(&[f.online.source()])
        .await
        .unwrap()
        .change_delegated_targets("stable")
        .unwrap()
        .targets_version(nz(1))
        .unwrap()
        .targets_expires(expiration())
        .unwrap()
        .add_target_path(&record)
        .await
        .unwrap();
    match editor.sign_targets_editor(&[f.online.source()]).await {
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
    let repo = f.load(&trusted).await.unwrap();
    let name = TargetName::new("stable.json").unwrap();
    let verified = repo
        .read_target(&name)
        .await
        .unwrap()
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap()
        .concat();
    assert_eq!(verified, fs::read(record).unwrap());
}
