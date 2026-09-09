//! Disposable TUF design fixtures, not a production updater or signer.
//! Every test generates fresh keys and operates only inside temporary directories.

mod updater_trust_support;

use std::fs;

use futures_util::TryStreamExt;
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
    let new = f.root(2, &f.offline, &replacement).await;
    // One offline key is unavailable. The remaining two satisfy the old and new quorum.
    let bridge = f.sign_root(&new, &old, &f.offline[1..]).await;
    fs::write(f.metadata.join("2.root.json"), &bridge).unwrap();
    f.publish(&bridge, &replacement, 2, expiration()).await;
    let updated = f.load(&trusted).await.unwrap();
    assert_eq!(updated.root().signed.version, nz(2));

    fs::write(f.metadata.join("timestamp.json"), stolen_timestamp).unwrap();
    assert!(
        f.load(&bridge).await.is_err(),
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
    let middle = f.root(2, &replacement, &f.online).await;
    let latest = f.root(3, &replacement, &f.online).await;
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
    f.publish(&current, &f.online, 3, expiration()).await;

    // Rotate the online key too: an old client cannot authenticate current metadata
    // until it receives the continuous root chain (a version jump is insufficient).
    assert_eq!(f.load(&trusted).await.unwrap().root().signed.version, nz(1));
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
    f.publish(&trusted, &f.online, 2, expiration()).await;
    RepositoryLoader::new(&trusted, f.metadata_url(), f.targets_url())
        .datastore(&state)
        .load()
        .await
        .unwrap();
    fs::write(f.metadata.join("timestamp.json"), timestamp).unwrap();
    assert!(
        RepositoryLoader::new(&trusted, f.metadata_url(), f.targets_url())
            .datastore(&state)
            .load()
            .await
            .is_err()
    );
    f.publish(
        &trusted,
        &f.online,
        3,
        "2000-01-01T00:00:00Z".parse().unwrap(),
    )
    .await;
    assert!(f.load(&trusted).await.is_err());
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
    fs::write(f.targets.join("release.json"), b"untrusted replacement").unwrap();
    let stream = repo.read_target(&name).await.unwrap().unwrap();
    assert!(stream.try_collect::<Vec<_>>().await.is_err());
}
