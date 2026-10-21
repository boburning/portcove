//! Disposable crypto/consumer qualification. No production trust override or publisher grant.
use super::super::publisher_policy as policy;
use super::*;
use serde_json::json;
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn put(root: &Path, name: &str, value: Value) -> PathBuf {
    let file = root.join(name);
    fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    file
}
async fn public_key(root: &Path, key: &Key, name: &str) -> Value {
    let value = key.source().as_sign().await.unwrap().tuf_key();
    let file = put(root, name, serde_json::to_value(value).unwrap());
    json!({"path":file,"sha256":digest(&fs::read(&file).unwrap())})
}
fn qualified_tool(name: &str) -> PathBuf {
    let file = PathBuf::from(std::env::var(name).expect("explicit qualified binary required"));
    assert!(file.is_absolute());
    let meta = fs::symlink_metadata(&file).unwrap();
    assert!(meta.is_file() && !meta.is_symlink() && meta.len() <= 128 * 1024 * 1024);
    let expected = std::env::var(format!("{name}_SHA256")).unwrap();
    assert_eq!(digest(&fs::read(&file).unwrap()), expected);
    file
}
fn command(tool: &Path, args: &[&str], root: &Path) -> Value {
    let stdout = tempfile::NamedTempFile::new_in(root).unwrap();
    let stderr = tempfile::NamedTempFile::new_in(root).unwrap();
    let mut command = Command::new(tool);
    command
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("TMP", root)
        .env("TEMP", root)
        .stdin(Stdio::null())
        .stdout(stdout.reopen().unwrap())
        .stderr(stderr.reopen().unwrap());
    if let Some(system) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system);
    }
    let mut child = command.spawn().unwrap();
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(20)
            || stdout.as_file().metadata().unwrap().len() > 4 * 1024 * 1024
            || stderr.as_file().metadata().unwrap().len() > 65536
        {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("fixed disposable tool exceeded bounded capture/time");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let read = |file: &tempfile::NamedTempFile, maximum: u64| {
        let mut raw = vec![];
        file.reopen()
            .unwrap()
            .take(maximum + 1)
            .read_to_end(&mut raw)
            .unwrap();
        assert!(raw.len() as u64 <= maximum);
        raw
    };
    let out = read(&stdout, 4 * 1024 * 1024);
    let err = read(&stderr, 65536);
    assert!(status.success(), "{}", String::from_utf8_lossy(&err));
    serde_json::from_slice(&out).unwrap()
}

#[tokio::test]
#[ignore = "requires hash-pinned actual Core CLI and release-tools binaries; run explicitly after one maintained build"]
async fn actual_cli_four_role_publication_and_core_policy_correction() {
    let cli = qualified_tool("PORTCOVE_DEFINITION_CLI");
    let tool = qualified_tool("PORTCOVE_DEFINITION_RELEASE_TOOLS");
    let mut fixture = RepositoryFixture::new();
    fixture.separated_roles = Some(std::array::from_fn(|_| Key::new(fixture._directory.path())));
    let root_bytes = fixture.root(true).await;
    let root = fixture._directory.path();
    let delegated_policy = Key::new(root);
    let definitions_key = public_key(root, &fixture.definitions, "definitions-public.json").await;
    let policy_key = public_key(root, &delegated_policy, "policy-public.json").await;
    let now = Timestamp::now().to_string();
    let expires = Timestamp::now()
        .checked_add(Duration::from_secs(3600))
        .unwrap()
        .to_string();
    let separated = fixture.separated_roles.as_ref().unwrap();
    let top_config = put(
        root,
        "top-config.json",
        json!({"schema_version":1,"generated_at":now,
        "trusted_root":fixture.root_path,"trusted_root_sha256":digest(&root_bytes),
        "delegated_public_keys":{"definitions":definitions_key,"policy":policy_key},
        "version":1,"expires":expires,"signing_key":separated[0].0,"output":"offline-targets.json"}),
    );
    command(
        &tool,
        &[
            "sign-offline-definition-targets",
            top_config.to_str().unwrap(),
        ],
        root,
    );
    let top = fs::read(root.join("offline-targets.json")).unwrap();
    let (catalog, id) = post_client_catalog();
    let targets = repository_targets_for(&catalog, &id);
    let mut policy_document = publisher_policy_tests::availability_for(&targets, &id, 1);
    let bundle = root.join("bundle");
    for (name, bytes) in &targets {
        let file = bundle.join(name);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, bytes).unwrap();
    }
    fs::create_dir_all(bundle.join("policy/official")).unwrap();
    let policy_path = bundle.join(format!("policy/official/{id}.json"));
    let library_directory = tempfile::tempdir().unwrap();
    let library = Library::open(library_directory.path()).unwrap();
    let mut previous: Option<PathBuf> = None;
    let mut old_floor = None;
    for version in 1..=2 {
        if version == 2 {
            policy_document["policy_revision"] = json!(2);
            policy_document["decision"] = json!({"status":"revoked"});
        }
        fs::write(&policy_path, serde_json::to_vec(&policy_document).unwrap()).unwrap();
        let unopened = root.join("unopened-library");
        let inspected = command(
            &cli,
            &[
                "--library",
                unopened.to_str().unwrap(),
                "--json",
                "catalog",
                "inspect-definition-publication",
                bundle.to_str().unwrap(),
            ],
            root,
        );
        assert!(!unopened.exists());
        assert_eq!(inspected["data"]["authority"], "none");
        assert_eq!(
            inspected["data"]["definitions"].as_array().unwrap().len(),
            1
        );
        let inspection = put(
            root,
            &format!("inspection-{version}.json"),
            inspected["data"].clone(),
        );
        let context = put(
            root,
            &format!("context-{version}.json"),
            json!({"schema_version":1,"generated_at":now,
            "trusted_root":fixture.root_path,"trusted_root_sha256":digest(&root_bytes),
            "offline_targets":"offline-targets.json","offline_targets_sha256":digest(&top),
            "prepared_bundle":"bundle","inspection":inspection,"inspection_sha256":digest(&fs::read(&inspection).unwrap()),
            "previous_repository":previous,"versions":{"definitions":version,"policy":version,"snapshot":version,"timestamp":version},
            "expires":{"definitions":expires,"policy":expires,"snapshot":expires,"timestamp":expires}}),
        );
        let roles = root.join(format!("roles-{version}"));
        fs::create_dir(&roles).unwrap();
        for (role, key) in [
            ("official-definitions", &fixture.definitions),
            ("official-policy", &delegated_policy),
            ("snapshot", &separated[1]),
            ("timestamp", &separated[2]),
        ] {
            let config = put(
                root,
                &format!("{role}-{version}.json"),
                json!({"schema_version":1,"context":context,
                    "signing_key":key.0,"output":roles.join(format!("{role}.json")),
                    // Only dependent roles accept this field.
                }),
            );
            if role == "snapshot" || role == "timestamp" {
                let mut value: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
                value["signed_roles"] = json!(roles);
                fs::write(&config, serde_json::to_vec(&value).unwrap()).unwrap();
            }
            command(
                &tool,
                &["sign-definition-role", role, config.to_str().unwrap()],
                root,
            );
        }
        let repository = root.join(format!("repository-{version}"));
        let assembly = put(
            root,
            &format!("assembly-{version}.json"),
            json!({"schema_version":1,"context":context,"signed_roles":roles,"output":repository}),
        );
        let report = command(
            &tool,
            &["assemble-definition-repository", assembly.to_str().unwrap()],
            root,
        );
        assert_eq!(report["authority"], "none");
        assert_eq!(report["versions"]["policy"], version.to_string());
        if let Some(prior) = &previous {
            let old = fs::read(prior.join("metadata/1.official-policy.json")).unwrap();
            assert_eq!(
                old,
                fs::read(repository.join("metadata/1.official-policy.json")).unwrap()
            );
        }
        let metadata = Url::from_directory_path(repository.join("metadata")).unwrap();
        let target_url = Url::from_directory_path(repository.join("targets")).unwrap();
        let candidate = acquire_with_transport(
            &root_bytes,
            metadata.clone(),
            target_url.clone(),
            FilesystemTransport,
        )
        .await
        .unwrap();
        assert_eq!(
            candidate
                .inspect_catalog_projection("official", &id)
                .unwrap()
                .catalog()
                .port(&id)
                .unwrap()
                .id,
            id
        );
        assert_eq!(
            candidate.evaluate_replay(old_floor.as_ref()).unwrap(),
            if version == 1 {
                DefinitionReplayDisposition::Initial
            } else {
                DefinitionReplayDisposition::Advance
            }
        );
        let admitted = policy::acquire_with_transport(
            &root_bytes,
            metadata,
            target_url,
            FilesystemTransport,
            "official",
            &id,
        )
        .await
        .unwrap();
        if version == 1 {
            // Authenticated signatures do not provision publisher authority.
            assert!(
                library
                    .apply_definition_publisher_policy(&admitted, Some(&candidate))
                    .is_err()
            );
            policy::install_authority_for_test(&library, &root_bytes).unwrap();
        }
        library
            .apply_definition_publisher_policy(&admitted, Some(&candidate))
            .unwrap();
        let assessed = library
            .assess_definition_candidate(&candidate, "official", &id)
            .unwrap();
        assert_eq!(
            assessed.eligibility().outcome,
            if version == 1 {
                DefinitionEligibilityOutcome::Eligible
            } else {
                DefinitionEligibilityOutcome::Hold
            }
        );
        if version == 2 {
            assert_eq!(
                assessed.eligibility().reason,
                DefinitionEligibilityReason::PublisherRevoked
            );
        }
        old_floor = Some(candidate.replay_floor());
        // Hash-bound content tampering is refused by the actual Core consumer.
        let leaf = &targets[1].1;
        let target = repository.join(format!("targets/{}.{}", digest(leaf), targets[1].0));
        fs::write(&target, b"substituted").unwrap();
        assert!(
            acquire_with_transport(
                &root_bytes,
                Url::from_directory_path(repository.join("metadata")).unwrap(),
                Url::from_directory_path(repository.join("targets")).unwrap(),
                FilesystemTransport
            )
            .await
            .is_err()
        );
        fs::write(target, leaf).unwrap();
        previous = Some(repository);
    }
    assert_eq!(qualified_tool("PORTCOVE_DEFINITION_CLI"), cli);
    assert_eq!(qualified_tool("PORTCOVE_DEFINITION_RELEASE_TOOLS"), tool);
    eprintln!(
        "disposable actual CLI/signers/Tough/Core correction; no hosted or production publisher authority"
    );
}
