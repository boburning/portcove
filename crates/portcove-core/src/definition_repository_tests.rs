use std::{
    collections::HashMap,
    fs,
    num::NonZeroU64,
    path::{Path, PathBuf},
};

use aws_lc_rs::{rand::SystemRandom, signature::Ed25519KeyPair};
use jiff::Timestamp;
use reqwest::Url;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tough::{
    FilesystemTransport, TargetName,
    editor::{RepositoryEditor, signed::PathExists, signed::SignedRole},
    key_source::{KeySource, LocalKeySource},
    schema::{KeyHolder, PathPattern, PathSet, RoleKeys, RoleType, Root, Target},
};

use crate::definition_eligibility::DefinitionOperationContext;
use crate::{
    Catalog, CatalogOrigin, DefinitionEligibilityOutcome, DefinitionEligibilityReason,
    DefinitionOperation, DefinitionPublisherObservation, DefinitionPublisherStatus, ErrorCode,
    Library,
    test_fixture::{indexed_catalog_bundle, post_client_catalog},
};

use super::{
    DEFINITION_ROLE_PATHS, DefinitionHttpsTransport, DefinitionReplayDisposition,
    DefinitionRepositorySource, INDEX_TARGET, acquire_with_transport,
};

fn nz(value: u64) -> NonZeroU64 {
    NonZeroU64::new(value).unwrap()
}

fn later() -> Timestamp {
    Timestamp::now()
        .checked_add(std::time::Duration::from_secs(86_400))
        .unwrap()
}

fn earlier() -> Timestamp {
    Timestamp::new(0, 0).unwrap()
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn publisher(
    candidate: &super::AuthenticatedDefinitionCandidate,
    stable_id: &str,
    status: DefinitionPublisherStatus,
) -> DefinitionPublisherObservation {
    DefinitionPublisherObservation::for_test(candidate, "official", stable_id, status).unwrap()
}

#[derive(Clone)]
struct Key(PathBuf);

impl Key {
    fn new(directory: &Path) -> Self {
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let file = tempfile::NamedTempFile::new_in(directory).unwrap();
        let (_, path) = file.keep().unwrap();
        fs::write(&path, document.as_ref()).unwrap();
        Self(path)
    }

    fn source(&self) -> Box<dyn KeySource> {
        Box::new(LocalKeySource {
            path: self.0.clone(),
        })
    }
}

struct RepositoryFixture {
    _directory: TempDir,
    offline: [Key; 3],
    online: Key,
    definitions: Key,
    root_path: PathBuf,
    source: PathBuf,
    metadata: PathBuf,
    targets: PathBuf,
}

impl RepositoryFixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let offline = [
            Key::new(directory.path()),
            Key::new(directory.path()),
            Key::new(directory.path()),
        ];
        let online = Key::new(directory.path());
        let definitions = Key::new(directory.path());
        let root_path = directory.path().join("trusted-root.json");
        let source = directory.path().join("source");
        let metadata = directory.path().join("metadata");
        let targets = directory.path().join("targets");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&metadata).unwrap();
        fs::create_dir(&targets).unwrap();
        Self {
            _directory: directory,
            offline,
            online,
            definitions,
            root_path,
            source,
            metadata,
            targets,
        }
    }

    async fn root(&self, consistent_snapshot: bool) -> Vec<u8> {
        let mut root = Root {
            spec_version: "1.0.0".into(),
            consistent_snapshot,
            version: nz(1),
            expires: later(),
            keys: HashMap::new(),
            roles: HashMap::new(),
            _extra: HashMap::new(),
        };
        let mut root_ids = Vec::new();
        for key in &self.offline {
            let public = key.source().as_sign().await.unwrap().tuf_key();
            let id = public.key_id().unwrap();
            root_ids.push(id.clone());
            root.keys.insert(id, public);
        }
        root.roles.insert(
            RoleType::Root,
            RoleKeys {
                keyids: root_ids,
                threshold: nz(2),
                _extra: HashMap::new(),
            },
        );
        let public = self.online.source().as_sign().await.unwrap().tuf_key();
        let id = public.key_id().unwrap();
        root.keys.insert(id.clone(), public);
        for role in [RoleType::Targets, RoleType::Snapshot, RoleType::Timestamp] {
            root.roles.insert(
                role,
                RoleKeys {
                    keyids: vec![id.clone()],
                    threshold: nz(1),
                    _extra: HashMap::new(),
                },
            );
        }
        let keys = self
            .offline
            .iter()
            .take(2)
            .map(Key::source)
            .collect::<Vec<_>>();
        let signed = SignedRole::new(
            root.clone(),
            &KeyHolder::Root(root),
            &keys,
            &SystemRandom::new(),
        )
        .await
        .unwrap();
        let bytes = signed.buffer().clone();
        fs::write(&self.root_path, &bytes).unwrap();
        bytes
    }

    async fn publish(
        &self,
        targets: &[(String, Vec<u8>)],
        consistent_snapshot: bool,
        role_paths: &[&str],
        expires: Timestamp,
    ) -> Vec<u8> {
        let root = self.root(consistent_snapshot).await;
        let mut inputs = Vec::new();
        for (name, bytes) in targets {
            let path = self.source.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            inputs.push((TargetName::new(name).unwrap(), path));
        }
        let paths = role_paths
            .iter()
            .map(|path| PathPattern::new(*path).unwrap())
            .collect();
        let mut editor = RepositoryEditor::new(&self.root_path).await.unwrap();
        editor
            .targets_version(nz(1))
            .unwrap()
            .targets_expires(expires)
            .unwrap()
            .snapshot_version(nz(1))
            .snapshot_expires(expires)
            .timestamp_version(nz(1))
            .timestamp_expires(expires)
            .delegate_role(
                "official-definitions",
                &[self.definitions.source()],
                PathSet::Paths(paths),
                true,
                nz(1),
                expires,
                nz(1),
            )
            .await
            .unwrap()
            .sign_targets_editor(&[self.online.source()])
            .await
            .unwrap()
            .change_delegated_targets("official-definitions")
            .unwrap();
        for (name, path) in &inputs {
            editor
                .add_target(name.clone(), Target::from_path(path).await.unwrap())
                .unwrap();
        }
        editor
            .targets_version(nz(1))
            .unwrap()
            .targets_expires(expires)
            .unwrap()
            .sign_targets_editor(&[self.definitions.source()])
            .await
            .unwrap()
            .change_delegated_targets("targets")
            .unwrap();
        editor
            .targets_version(nz(1))
            .unwrap()
            .targets_expires(expires)
            .unwrap();
        let signed = editor.sign(&[self.online.source()]).await.unwrap();
        signed.write(&self.metadata).await.unwrap();
        for (name, path) in &inputs {
            signed
                .copy_target(path, &self.targets, PathExists::Fail, Some(name))
                .await
                .unwrap();
        }
        root
    }

    fn metadata_url(&self) -> Url {
        Url::from_directory_path(&self.metadata).unwrap()
    }

    fn targets_url(&self) -> Url {
        Url::from_directory_path(&self.targets).unwrap()
    }

    fn published_target(&self, name: &str, bytes: &[u8], consistent: bool) -> PathBuf {
        if consistent {
            self.targets
                .join(format!("{}.{}", hex::encode(Sha256::digest(bytes)), name))
        } else {
            self.targets.join(name)
        }
    }
}

fn repository_targets() -> (String, Vec<(String, Vec<u8>)>) {
    let catalog = Catalog::embedded().unwrap();
    let port_id = catalog.ports()[0].id.clone();
    (port_id.clone(), repository_targets_for(&catalog, &port_id))
}

fn repository_targets_for(catalog: &Catalog, port_id: &str) -> Vec<(String, Vec<u8>)> {
    let bundle = indexed_catalog_bundle(catalog, port_id);
    let mut targets = vec![(INDEX_TARGET.to_owned(), bundle.index)];
    targets.extend(bundle.contents);
    targets
}

fn select_candidate(
    library: &Library,
    candidate: &super::AuthenticatedDefinitionCandidate,
    port_id: &str,
) {
    library
        .install_definition_policy_for_test(
            candidate,
            "official",
            port_id,
            7,
            "official-fixture-grant",
            DefinitionPublisherStatus::Scoped,
        )
        .unwrap();
    let eligible = library
        .assess_definition_candidate(candidate, "official", port_id)
        .unwrap()
        .into_eligible()
        .unwrap();
    library.select_definition_candidate(eligible).unwrap();
}

async fn acquire(
    fixture: &RepositoryFixture,
    root: &[u8],
) -> crate::Result<super::AuthenticatedDefinitionCandidate> {
    acquire_with_transport(
        root,
        fixture.metadata_url(),
        fixture.targets_url(),
        FilesystemTransport,
    )
    .await
}

#[test]
fn public_source_requires_credential_free_https_bases() {
    let source = DefinitionRepositorySource::new(
        "https://definitions.example/metadata",
        "https://definitions.example/targets/",
    )
    .unwrap();
    assert_eq!(
        source.metadata_base_url(),
        "https://definitions.example/metadata/"
    );
    assert!(
        DefinitionRepositorySource::new("http://example.test/", "https://example.test/").is_err()
    );
    assert!(
        DefinitionRepositorySource::new("https://user@example.test/", "https://example.test/")
            .is_err()
    );
    assert!(
        DefinitionRepositorySource::new(
            "https://example.test/?token=secret",
            "https://example.test/"
        )
        .is_err()
    );
    assert!(
        DefinitionRepositorySource::new(
            &format!("https://example.test/{}", "a".repeat(4096)),
            "https://example.test/"
        )
        .is_err()
    );
    let transport = DefinitionHttpsTransport::new(&source).unwrap();
    assert!(
        transport.accepts(&Url::parse("https://definitions.example/metadata/1.root.json").unwrap())
    );
    assert!(
        !transport.accepts(
            &Url::parse("https://definitions.example/metadata-escape/1.root.json").unwrap()
        )
    );
}

#[tokio::test]
async fn authenticated_candidate_projects_a_definition_published_after_the_client() {
    let fixture = RepositoryFixture::new();
    let (port_id, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;

    let candidate = acquire(&fixture, &root).await.unwrap();
    let projection = candidate
        .inspect_catalog_projection("official", &port_id)
        .unwrap();
    assert_eq!(projection.entry().revision(), 7);
    assert_eq!(projection.catalog().port(&port_id).unwrap().id, port_id);
    assert_eq!(candidate.provenance().root_version, 1);
    assert_eq!(candidate.provenance().definitions_version, 1);
    assert_eq!(candidate.provenance().index_sha256.len(), 64);
    for digest in [
        &candidate.provenance().root_sha256,
        &candidate.provenance().timestamp_sha256,
        &candidate.provenance().snapshot_sha256,
        &candidate.provenance().targets_sha256,
        &candidate.provenance().definitions_sha256,
    ] {
        assert_eq!(digest.len(), 64);
        assert!(digest.bytes().all(|value| value.is_ascii_hexdigit()));
    }
}

#[tokio::test]
async fn composed_availability_returns_only_a_scoped_fresh_candidate_proof() {
    let fixture = RepositoryFixture::new();
    let (port_id, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();

    let available = candidate
        .evaluate_availability(
            "official",
            &port_id,
            None,
            &publisher(&candidate, &port_id, DefinitionPublisherStatus::Scoped),
        )
        .unwrap();
    assert_eq!(
        available.eligibility().outcome,
        DefinitionEligibilityOutcome::Eligible
    );
    let eligible = available.into_eligible().unwrap();
    assert_eq!(
        eligible.replay_disposition(),
        DefinitionReplayDisposition::Initial
    );
    assert_eq!(eligible.replay_floor(), &candidate.replay_floor());
    assert_eq!(eligible.provenance(), candidate.provenance());
    assert_eq!(
        eligible.publisher().status(),
        DefinitionPublisherStatus::Scoped
    );
    assert_eq!(eligible.publisher().policy_revision(), 1);
    assert_eq!(eligible.publisher().grant_id(), Some("test-official-grant"));
    assert_eq!(
        eligible.projection().catalog().port(&port_id).unwrap().id,
        port_id
    );

    let safe_unscoped =
        DefinitionPublisherObservation::unscoped(&candidate, "official", &port_id).unwrap();
    assert_eq!(
        safe_unscoped.root_sha256(),
        candidate.provenance().root_sha256
    );
    assert_eq!(safe_unscoped.namespace(), "official");
    assert_eq!(safe_unscoped.stable_id(), port_id);
    assert_eq!(safe_unscoped.policy_revision(), 0);
    assert_eq!(safe_unscoped.grant_id(), None);
    assert_eq!(safe_unscoped.status(), DefinitionPublisherStatus::Unscoped);

    for (publisher_status, outcome, reason) in [
        (
            DefinitionPublisherStatus::Unscoped,
            DefinitionEligibilityOutcome::Escalate,
            DefinitionEligibilityReason::PublisherScopeRequired,
        ),
        (
            DefinitionPublisherStatus::Revoked,
            DefinitionEligibilityOutcome::Hold,
            DefinitionEligibilityReason::PublisherRevoked,
        ),
    ] {
        let assessment = candidate
            .evaluate_availability_at(
                "official",
                &port_id,
                None,
                &publisher(&candidate, &port_id, publisher_status),
                now_unix(),
            )
            .unwrap();
        assert_eq!(assessment.eligibility().outcome, outcome);
        assert_eq!(assessment.eligibility().reason, reason);
        assert!(assessment.into_eligible().is_none());
    }

    let stale = candidate
        .evaluate_availability_at(
            "official",
            &port_id,
            None,
            &publisher(&candidate, &port_id, DefinitionPublisherStatus::Scoped),
            now_unix() + 172_800,
        )
        .unwrap();
    assert_eq!(
        stale.eligibility().reason,
        DefinitionEligibilityReason::MetadataStale
    );
    assert!(stale.into_eligible().is_none());

    let mismatched_policy = candidate
        .evaluate_availability_at(
            "official",
            "different-port",
            None,
            &publisher(&candidate, &port_id, DefinitionPublisherStatus::Scoped),
            now_unix(),
        )
        .unwrap_err();
    assert_eq!(mismatched_policy.code, ErrorCode::Conflict);

    let other_fixture = RepositoryFixture::new();
    let (_, other_targets) = repository_targets();
    let other_root = other_fixture
        .publish(&other_targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let other_candidate = acquire(&other_fixture, &other_root).await.unwrap();
    let cross_repository = other_candidate
        .evaluate_availability_at(
            "official",
            &port_id,
            None,
            &publisher(&candidate, &port_id, DefinitionPublisherStatus::Scoped),
            now_unix(),
        )
        .unwrap_err();
    assert_eq!(cross_repository.code, ErrorCode::Conflict);
}

#[tokio::test]
async fn composed_availability_binds_replay_without_consuming_or_repairing_the_floor() {
    let fixture = RepositoryFixture::new();
    let (port_id, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let mut candidate = acquire(&fixture, &root).await.unwrap();
    let floor = candidate.replay_floor();

    let retry = candidate
        .evaluate_availability_at(
            "official",
            &port_id,
            Some(&floor),
            &publisher(&candidate, &port_id, DefinitionPublisherStatus::Scoped),
            now_unix(),
        )
        .unwrap()
        .into_eligible()
        .unwrap();
    assert_eq!(
        retry.replay_disposition(),
        DefinitionReplayDisposition::ExactRetry
    );

    let mut newer_floor = floor.clone();
    newer_floor.snapshot_version += 1;
    newer_floor.snapshot_sha256 = "a".repeat(64);
    let replay = candidate
        .evaluate_availability_at(
            "official",
            &port_id,
            Some(&newer_floor),
            &publisher(&candidate, &port_id, DefinitionPublisherStatus::Scoped),
            now_unix(),
        )
        .unwrap();
    assert_eq!(
        replay.eligibility().reason,
        DefinitionEligibilityReason::MetadataReplay
    );
    assert!(replay.into_eligible().is_none());
    assert_eq!(newer_floor.snapshot_version, 2);

    let mut malformed = floor.clone();
    malformed.snapshot_sha256 = "not-a-digest".into();
    let error = candidate
        .evaluate_availability_at(
            "official",
            &port_id,
            Some(&malformed),
            &publisher(&candidate, &port_id, DefinitionPublisherStatus::Scoped),
            now_unix(),
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::State);

    candidate.provenance.timestamp_version += 1;
    candidate.provenance.timestamp_sha256 = "c".repeat(64);
    let advance = candidate
        .evaluate_availability_at(
            "official",
            &port_id,
            Some(&floor),
            &publisher(&candidate, &port_id, DefinitionPublisherStatus::Scoped),
            now_unix(),
        )
        .unwrap()
        .into_eligible()
        .unwrap();
    assert_eq!(
        advance.replay_disposition(),
        DefinitionReplayDisposition::Advance
    );
}

#[tokio::test]
async fn library_selection_persists_the_exact_candidate_and_floor_together() {
    let fixture = RepositoryFixture::new();
    let (port_id, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let temporary = TempDir::new().unwrap();
    let library = Library::open(temporary.path()).unwrap();

    let initial = library.definition_selection_status().unwrap();
    assert_eq!(initial.revision, 0);
    assert!(initial.selected.is_none());
    assert!(initial.replay_floor.is_none());
    let unscoped = library
        .assess_definition_candidate(&candidate, "official", &port_id)
        .unwrap();
    assert_eq!(
        unscoped.eligibility().reason,
        DefinitionEligibilityReason::PublisherScopeRequired
    );
    assert!(unscoped.into_eligible().is_none());

    library
        .install_definition_policy_for_test(
            &candidate,
            "official",
            &port_id,
            7,
            "official-fixture-grant",
            DefinitionPublisherStatus::Scoped,
        )
        .unwrap();
    let eligible = library
        .assess_definition_candidate(&candidate, "official", &port_id)
        .unwrap()
        .into_eligible()
        .unwrap();
    let selected = library.select_definition_candidate(eligible).unwrap();
    assert_eq!(selected.revision, 1);
    assert_eq!(selected.replay_floor, Some(candidate.replay_floor()));
    let identity = selected.selected.unwrap();
    assert_eq!(identity.namespace, "official");
    assert_eq!(identity.stable_id, port_id);
    assert_eq!(identity.definition_revision, 7);
    assert_eq!(identity.policy_revision, 7);
    assert_eq!(identity.grant_id, "official-fixture-grant");
    assert_eq!(
        identity.repository_root_sha256,
        candidate.provenance().root_sha256
    );

    let exact_retry = library
        .assess_definition_candidate(&candidate, "official", &port_id)
        .unwrap()
        .into_eligible()
        .unwrap();
    assert_eq!(
        exact_retry.replay_disposition(),
        DefinitionReplayDisposition::ExactRetry
    );
    assert_eq!(
        library
            .select_definition_candidate(exact_retry)
            .unwrap()
            .revision,
        1,
        "an exact retry must not manufacture a new selection revision"
    );

    drop(library);
    let reopened = Library::open(temporary.path()).unwrap();
    assert_eq!(reopened.definition_selection_status().unwrap().revision, 1);
    let active_json: String = reopened
        .connection()
        .unwrap()
        .query_row(
            "SELECT active_json FROM definition_selection_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let stored: Value = serde_json::from_str(&active_json).unwrap();
    assert!(
        stored["snapshot"]["index_json"]
            .as_str()
            .unwrap()
            .contains('\n')
    );

    let mut changed = stored;
    changed["definition_revision"] = 8.into();
    reopened
        .connection()
        .unwrap()
        .execute(
            "UPDATE definition_selection_state SET active_json=?1 WHERE singleton=1",
            [serde_json::to_string(&changed).unwrap()],
        )
        .unwrap();
    let error = reopened.definition_selection_status().unwrap_err();
    assert_eq!(error.code, ErrorCode::State);
    reopened
        .connection()
        .unwrap()
        .execute(
            "UPDATE definition_selection_state SET active_json=?1 WHERE singleton=1",
            [active_json],
        )
        .unwrap();
    assert_eq!(reopened.definition_selection_status().unwrap().revision, 1);
}

#[tokio::test]
async fn selected_post_client_definition_loads_as_the_active_catalog() {
    let fixture = RepositoryFixture::new();
    let baseline = Catalog::embedded().unwrap();
    let (catalog, port_id) = post_client_catalog();
    let targets = repository_targets_for(&catalog, &port_id);
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let temporary = TempDir::new().unwrap();
    let library = Library::open(temporary.path()).unwrap();

    select_candidate(&library, &candidate, &port_id);
    let selection = library
        .definition_selection_status()
        .unwrap()
        .selected
        .unwrap();
    let (loaded, provenance) = library.load_catalog().unwrap();

    assert_eq!(provenance.origin, CatalogOrigin::DefinitionSelected);
    assert_eq!(library.catalog_status().unwrap().provenance, provenance);
    assert!(provenance.expires_at.is_some());
    assert!(provenance.fallback_reasons.is_empty());
    assert_eq!(
        serde_json::to_value(loaded.authoritative_document()).unwrap(),
        serde_json::to_value(catalog.authoritative_document()).unwrap()
    );
    assert!(loaded.port(&port_id).is_ok());
    assert!(loaded.definition_snapshot(&port_id).is_some());
    assert_eq!(loaded.definition_selection(&port_id), Some(&selection));
    let retained =
        crate::installed_contract::InstalledContract::capture(&loaded, &port_id).unwrap();
    let retained_value = serde_json::to_value(&retained).unwrap();
    assert_eq!(retained_value["format"], 3);
    assert_eq!(
        retained_value["admission"],
        serde_json::to_value(&selection).unwrap()
    );
    let restored = retained.catalog(&port_id).unwrap();
    assert_eq!(restored.definition_selection(&port_id), Some(&selection));
    assert_eq!(
        serde_json::to_vec(
            &crate::installed_contract::InstalledContract::capture(&restored, &port_id).unwrap()
        )
        .unwrap(),
        serde_json::to_vec(&retained).unwrap()
    );
    for (label, segments, replacement) in [
        (
            "admission.stable_id",
            &["admission", "stable_id"][..],
            Value::String("changed".into()),
        ),
        (
            "admission.definition_revision",
            &["admission", "definition_revision"][..],
            Value::from(999),
        ),
        (
            "admission.repository_root_sha256",
            &["admission", "repository_root_sha256"][..],
            Value::String("changed".into()),
        ),
        (
            "admission.provenance.index_sha256",
            &["admission", "provenance", "index_sha256"][..],
            Value::String("changed".into()),
        ),
        (
            "admission.grant_id",
            &["admission", "grant_id"][..],
            Value::String("INVALID".into()),
        ),
        (
            "admission.policy_revision",
            &["admission", "policy_revision"][..],
            Value::from(0),
        ),
        (
            "admission.provenance.timestamp_version",
            &["admission", "provenance", "timestamp_version"][..],
            Value::from(0),
        ),
        (
            "admission.provenance.earliest_expiration",
            &["admission", "provenance", "earliest_expiration"][..],
            Value::String("invalid".into()),
        ),
    ] {
        let mut changed = retained_value.clone();
        let mut target = &mut changed;
        for segment in segments {
            target = target.get_mut(segment).unwrap();
        }
        *target = replacement;
        let decoded: crate::installed_contract::InstalledContract =
            serde_json::from_value(changed).unwrap();
        assert!(
            decoded.catalog(&port_id).is_err(),
            "accepted tampered {label}"
        );
    }
    for (label, segments) in [
        ("admission.unknown", &["admission"][..]),
        (
            "admission.provenance.unknown",
            &["admission", "provenance"][..],
        ),
    ] {
        let mut changed = retained_value.clone();
        let mut target = &mut changed;
        for segment in segments {
            target = target.get_mut(segment).unwrap();
        }
        target
            .as_object_mut()
            .unwrap()
            .insert("unknown".into(), Value::Bool(true));
        assert!(
            serde_json::from_value::<crate::installed_contract::InstalledContract>(changed)
                .is_err(),
            "accepted unknown field at {label}"
        );
    }
    for port in baseline.ports() {
        assert_eq!(
            serde_json::to_value(loaded.port(&port.id).unwrap()).unwrap(),
            serde_json::to_value(port).unwrap()
        );
    }
}

#[tokio::test]
async fn operation_assessment_distinguishes_stale_retained_launch_and_revocation() {
    let fixture = RepositoryFixture::new();
    let (catalog, port_id) = post_client_catalog();
    let targets = repository_targets_for(&catalog, &port_id);
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let temporary = TempDir::new().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    select_candidate(&library, &candidate, &port_id);
    let selection = library
        .definition_selection_status()
        .unwrap()
        .selected
        .unwrap();

    for (operation, retained) in [
        (DefinitionOperation::Install, false),
        (DefinitionOperation::Prepare, true),
        (DefinitionOperation::Launch, true),
    ] {
        assert_eq!(
            library
                .assess_definition_operation(
                    &selection,
                    DefinitionOperationContext::observed(operation, retained, true),
                )
                .unwrap()
                .outcome,
            DefinitionEligibilityOutcome::Eligible
        );
    }

    let mut stale = selection.clone();
    stale.provenance.earliest_expiration = "1970-01-01T00:00:00Z".into();
    assert_eq!(
        library
            .assess_definition_operation(
                &stale,
                DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
            )
            .unwrap()
            .reason,
        DefinitionEligibilityReason::MetadataStale
    );
    assert_eq!(
        library
            .assess_definition_operation(
                &stale,
                DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true),
            )
            .unwrap()
            .outcome,
        DefinitionEligibilityOutcome::Eligible
    );

    library
        .install_definition_policy_for_test(
            &candidate,
            "official",
            &port_id,
            7,
            "official-fixture-grant",
            DefinitionPublisherStatus::Revoked,
        )
        .unwrap();
    assert_eq!(
        library
            .assess_definition_operation(
                &selection,
                DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true),
            )
            .unwrap()
            .reason,
        DefinitionEligibilityReason::PublisherRevoked
    );
}

#[tokio::test]
async fn out_of_scope_selected_definition_falls_back_without_hiding_ports() {
    let fixture = RepositoryFixture::new();
    let baseline = Catalog::embedded().unwrap();
    let (catalog, port_id) = post_client_catalog();
    let mut document = catalog.authoritative_document();
    document
        .ports
        .iter_mut()
        .find(|port| port.id != port_id)
        .unwrap()
        .summary
        .push_str(" changed outside the selected scope");
    let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    let targets = repository_targets_for(&catalog, &port_id);
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let temporary = TempDir::new().unwrap();
    let library = Library::open(temporary.path()).unwrap();

    select_candidate(&library, &candidate, &port_id);
    let (loaded, provenance) = library.load_catalog().unwrap();

    assert_eq!(provenance.origin, CatalogOrigin::Embedded);
    assert!(loaded.port(&port_id).is_err());
    assert!(provenance.fallback_reasons.iter().any(|reason| {
        reason.contains("selected definition changes catalog state outside its scope")
    }));
    assert_eq!(library.catalog_status().unwrap().provenance, provenance);
    assert_eq!(
        serde_json::to_value(loaded.authoritative_document()).unwrap(),
        serde_json::to_value(baseline.authoritative_document()).unwrap()
    );
}

#[tokio::test]
async fn revoked_selected_definition_falls_back_to_the_existing_catalog() {
    let fixture = RepositoryFixture::new();
    let (catalog, port_id) = post_client_catalog();
    let targets = repository_targets_for(&catalog, &port_id);
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let temporary = TempDir::new().unwrap();
    let library = Library::open(temporary.path()).unwrap();

    select_candidate(&library, &candidate, &port_id);
    library
        .install_definition_policy_for_test(
            &candidate,
            "official",
            &port_id,
            8,
            "official-fixture-grant",
            DefinitionPublisherStatus::Revoked,
        )
        .unwrap();
    let (loaded, provenance) = library.load_catalog().unwrap();

    assert_eq!(provenance.origin, CatalogOrigin::Embedded);
    assert!(loaded.port(&port_id).is_err());
    assert!(
        provenance
            .fallback_reasons
            .iter()
            .any(|reason| reason.contains("publisher policy changed"))
    );
}

#[tokio::test]
async fn stale_or_corrupt_selected_definition_falls_back_visibly() {
    let fixture = RepositoryFixture::new();
    let (catalog, port_id) = post_client_catalog();
    let targets = repository_targets_for(&catalog, &port_id);
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let temporary = TempDir::new().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    select_candidate(&library, &candidate, &port_id);

    let active_json: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT active_json FROM definition_selection_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut stale: Value = serde_json::from_str(&active_json).unwrap();
    stale["provenance"]["earliest_expiration"] = "1970-01-01T00:00:00Z".into();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE definition_selection_state SET active_json=?1 WHERE singleton=1",
            [serde_json::to_string(&stale).unwrap()],
        )
        .unwrap();
    let (loaded, provenance) = library.load_catalog().unwrap();
    assert_eq!(provenance.origin, CatalogOrigin::Embedded);
    assert!(loaded.port(&port_id).is_err());
    assert!(
        provenance
            .fallback_reasons
            .iter()
            .any(|reason| reason.contains("metadata expired before selection committed"))
    );

    let mut corrupt: Value = serde_json::from_str(&active_json).unwrap();
    corrupt["snapshot"]["contract_json"] = "{}".into();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE definition_selection_state SET active_json=?1 WHERE singleton=1",
            [serde_json::to_string(&corrupt).unwrap()],
        )
        .unwrap();
    let (loaded, provenance) = library.load_catalog().unwrap();
    assert_eq!(provenance.origin, CatalogOrigin::Embedded);
    assert!(loaded.port(&port_id).is_err());
    assert!(!provenance.fallback_reasons.is_empty());
    assert!(library.definition_selection_status().is_err());
}

#[tokio::test]
async fn selection_rechecks_policy_replay_and_atomic_commit_state() {
    let fixture = RepositoryFixture::new();
    let (port_id, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let mut candidate = acquire(&fixture, &root).await.unwrap();
    let temporary = TempDir::new().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    library
        .install_definition_policy_for_test(
            &candidate,
            "official",
            &port_id,
            1,
            "official-fixture-grant",
            DefinitionPublisherStatus::Scoped,
        )
        .unwrap();

    let interrupted = library
        .assess_definition_candidate(&candidate, "official", &port_id)
        .unwrap()
        .into_eligible()
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_definition_selection
             BEFORE UPDATE ON definition_selection_state
             BEGIN SELECT RAISE(ABORT, 'synthetic interruption'); END;",
        )
        .unwrap();
    assert!(library.select_definition_candidate(interrupted).is_err());
    let unchanged = library.definition_selection_status().unwrap();
    assert_eq!(unchanged.revision, 0);
    assert!(unchanged.selected.is_none());
    assert!(unchanged.replay_floor.is_none());
    library
        .connection()
        .unwrap()
        .execute("DROP TRIGGER reject_definition_selection", [])
        .unwrap();

    let initial = library
        .assess_definition_candidate(&candidate, "official", &port_id)
        .unwrap()
        .into_eligible()
        .unwrap();
    library.select_definition_candidate(initial).unwrap();
    let old_retry = library
        .assess_definition_candidate(&candidate, "official", &port_id)
        .unwrap()
        .into_eligible()
        .unwrap();

    candidate.provenance.timestamp_version += 1;
    candidate.provenance.timestamp_sha256 = "c".repeat(64);
    let advance = library
        .assess_definition_candidate(&candidate, "official", &port_id)
        .unwrap()
        .into_eligible()
        .unwrap();
    assert_eq!(
        advance.replay_disposition(),
        DefinitionReplayDisposition::Advance
    );
    let advanced = library.select_definition_candidate(advance).unwrap();
    assert_eq!(advanced.revision, 2);
    assert!(advanced.can_rollback);
    assert_eq!(advanced.replay_floor, Some(candidate.replay_floor()));

    let replay_error = library.select_definition_candidate(old_retry).unwrap_err();
    assert_eq!(replay_error.code, ErrorCode::Verification);
    assert_eq!(library.definition_selection_status().unwrap(), advanced);

    let pending = library
        .assess_definition_candidate(&candidate, "official", &port_id)
        .unwrap()
        .into_eligible()
        .unwrap();
    library
        .install_definition_policy_for_test(
            &candidate,
            "official",
            &port_id,
            2,
            "official-fixture-grant",
            DefinitionPublisherStatus::Revoked,
        )
        .unwrap();
    let policy_error = library.select_definition_candidate(pending).unwrap_err();
    assert_eq!(policy_error.code, ErrorCode::Conflict);
    assert_eq!(library.definition_selection_status().unwrap(), advanced);
}

#[tokio::test]
async fn replay_evaluation_rejects_downgrade_and_same_version_equivocation() {
    let fixture = RepositoryFixture::new();
    let (_, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();

    assert_eq!(
        candidate.evaluate_replay(None).unwrap(),
        DefinitionReplayDisposition::Initial
    );
    let floor = candidate.replay_floor();
    assert_eq!(
        candidate.evaluate_replay(Some(&floor)).unwrap(),
        DefinitionReplayDisposition::ExactRetry
    );

    let mut newer_floor = floor.clone();
    newer_floor.snapshot_version += 1;
    newer_floor.snapshot_sha256 = "a".repeat(64);
    let downgrade = candidate.evaluate_replay(Some(&newer_floor)).unwrap_err();
    assert_eq!(downgrade.code, ErrorCode::Verification);
    assert_eq!(downgrade.details["role"], "snapshot");
    assert_eq!(downgrade.details["accepted_version"], "2");
    assert_eq!(downgrade.details["candidate_version"], "1");

    let mut replaced = floor;
    replaced.definitions_sha256 = "b".repeat(64);
    let equivocation = candidate.evaluate_replay(Some(&replaced)).unwrap_err();
    assert_eq!(equivocation.code, ErrorCode::Verification);
    assert_eq!(equivocation.details["role"], "official-definitions");
    assert_eq!(equivocation.details["version"], "1");

    let mut replaced_index = candidate.replay_floor();
    replaced_index.index_sha256 = "d".repeat(64);
    let index_equivocation = candidate
        .evaluate_replay(Some(&replaced_index))
        .unwrap_err();
    assert_eq!(index_equivocation.code, ErrorCode::Verification);
    assert_eq!(
        index_equivocation.message,
        "definition index changed without a delegated metadata version advance"
    );
}

#[tokio::test]
async fn replay_evaluation_allows_independent_monotonic_metadata_advance() {
    let fixture = RepositoryFixture::new();
    let (_, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let mut candidate = acquire(&fixture, &root).await.unwrap();
    let floor = candidate.replay_floor();

    candidate.provenance.timestamp_version += 1;
    candidate.provenance.timestamp_sha256 = "c".repeat(64);
    assert_eq!(
        candidate.evaluate_replay(Some(&floor)).unwrap(),
        DefinitionReplayDisposition::Advance
    );

    candidate.provenance.timestamp_sha256 = "not-a-digest".into();
    let corrupt = candidate.evaluate_replay(Some(&floor)).unwrap_err();
    assert_eq!(corrupt.code, ErrorCode::State);
    assert_eq!(corrupt.details["identity"], "timestamp");
}

#[tokio::test]
async fn unsupported_sibling_does_not_block_a_supported_definition() {
    let fixture = RepositoryFixture::new();
    let (port_id, mut targets) = repository_targets();
    let supported_entry = targets
        .iter()
        .find(|(name, _)| name.starts_with("sha256/"))
        .map(|(_, bytes)| bytes.clone())
        .unwrap();
    let index = targets
        .iter_mut()
        .find(|(name, _)| name == INDEX_TARGET)
        .unwrap();
    let mut incompatible: Value = serde_json::from_slice(&supported_entry).unwrap();
    incompatible["stable_id"] = "future-incompatible".into();
    incompatible["revision"] = 8.into();
    incompatible["port"]["id"] = "future-incompatible".into();
    incompatible["required_capabilities"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "template":"future-template","minimum_version":1,"maximum_version":1
        }));
    let incompatible = serde_json::to_vec_pretty(&incompatible).unwrap();
    let digest = hex::encode(Sha256::digest(&incompatible));
    let target = format!("sha256/{digest}.json");
    let mut index_value: Value = serde_json::from_slice(&index.1).unwrap();
    index_value["definitions"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "namespace":"official","stable_id":"future-incompatible","revision":8,"target":target
        }));
    index_value["contents"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "target":target,"sha256":digest,"length":incompatible.len()
        }));
    index.1 = serde_json::to_vec_pretty(&index_value).unwrap();
    targets.push((target, incompatible));
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;

    let candidate = acquire(&fixture, &root).await.unwrap();
    assert!(
        candidate
            .inspect_catalog_projection("official", &port_id)
            .is_ok()
    );
    let error = candidate
        .inspect_catalog_projection("official", "future-incompatible")
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);

    let unsupported = candidate
        .evaluate_availability(
            "official",
            "future-incompatible",
            None,
            &publisher(
                &candidate,
                "future-incompatible",
                DefinitionPublisherStatus::Scoped,
            ),
        )
        .unwrap();
    assert_eq!(
        unsupported.eligibility().reason,
        DefinitionEligibilityReason::EngineCapabilityRequired
    );
    assert!(unsupported.into_eligible().is_none());
    assert!(
        candidate
            .evaluate_availability_at(
                "official",
                &port_id,
                None,
                &publisher(&candidate, &port_id, DefinitionPublisherStatus::Scoped),
                now_unix(),
            )
            .unwrap()
            .into_eligible()
            .is_some()
    );
}

#[tokio::test]
async fn tampered_or_missing_content_is_refused() {
    for remove in [false, true] {
        let fixture = RepositoryFixture::new();
        let (_, targets) = repository_targets();
        let root = fixture
            .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
            .await;
        let (name, bytes) = targets
            .iter()
            .find(|(name, _)| name.starts_with("sha256/"))
            .unwrap();
        let path = fixture.published_target(name, bytes, true);
        if remove {
            fs::remove_file(path).unwrap();
        } else {
            fs::write(path, b"tampered").unwrap();
        }
        let error = acquire(&fixture, &root).await.unwrap_err();
        assert_eq!(
            error.code,
            if remove {
                ErrorCode::Network
            } else {
                ErrorCode::Verification
            },
            "{}",
            error.message
        );
    }
}

#[tokio::test]
async fn delegation_scope_and_consistent_snapshots_are_mandatory() {
    let (_, targets) = repository_targets();
    let fixture = RepositoryFixture::new();
    let root = fixture.publish(&targets, true, &["*"], later()).await;
    let scope_error = acquire(&fixture, &root).await.unwrap_err();
    assert_eq!(scope_error.code, ErrorCode::Verification);

    let fixture = RepositoryFixture::new();
    let root = fixture
        .publish(&targets, false, &DEFINITION_ROLE_PATHS, later())
        .await;
    let snapshot_error = acquire(&fixture, &root).await.unwrap_err();
    assert_eq!(snapshot_error.code, ErrorCode::Verification);
}

#[tokio::test]
async fn expired_metadata_is_refused_as_verification_failure() {
    let fixture = RepositoryFixture::new();
    let (_, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, earlier())
        .await;
    let error = acquire(&fixture, &root).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert!(error.message.contains("expired"));
}

#[tokio::test]
async fn authenticated_index_length_is_bounded_before_download() {
    let fixture = RepositoryFixture::new();
    let oversized = vec![b' '; super::MAX_INDEX_BYTES + 1];
    let targets = vec![(INDEX_TARGET.to_owned(), oversized)];
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let error = acquire(&fixture, &root).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert!(error.message.contains("byte bound"), "{}", error.message);
}

#[tokio::test]
async fn index_and_tuf_target_metadata_must_agree_before_content_reads() {
    let fixture = RepositoryFixture::new();
    let (_, mut targets) = repository_targets();
    let index = targets
        .iter_mut()
        .find(|(name, _)| name == INDEX_TARGET)
        .unwrap();
    let mut value: Value = serde_json::from_slice(&index.1).unwrap();
    let length = value["contents"][0]["length"].as_u64().unwrap();
    value["contents"][0]["length"] = (length + 1).into();
    index.1 = serde_json::to_vec_pretty(&value).unwrap();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;

    let error = acquire(&fixture, &root).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert!(
        error.message.contains("metadata disagree"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn caller_supplied_root_is_bounded_before_repository_access() {
    let fixture = RepositoryFixture::new();
    let oversized = vec![0; super::MAX_ROOT_BYTES + 1];
    let error = acquire(&fixture, &oversized).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert!(error.message.contains("root exceeds"), "{}", error.message);
}
