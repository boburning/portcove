use super::*;
use portcove_release_tools::tuf_repository::{
    TufRepositoryError,
    isolated::{OnlineRole, RoleReport, assemble_tuf_repository, sign_tuf_role},
};

struct Fixture {
    directory: tempfile::TempDir,
    context: serde_json::Value,
    keys: HashMap<&'static str, Vec<u8>>,
}

fn write_json(path: &Path, value: &serde_json::Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

fn empty_stable(records: &Path) {
    let path = records.join("reconstruction-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["records"]
        .as_array_mut()
        .unwrap()
        .retain(|record| {
            if record["channel"] == "stable" {
                fs::remove_file(records.join(record["path"].as_str().unwrap())).unwrap();
                false
            } else {
                true
            }
        });
    write_json(&path, &manifest);
}

fn export_public_fixture(fixture: &Fixture) {
    if let Some(output) = std::env::var_os("PORTCOVE_TUF_ISOLATED_QUALIFICATION_OUTPUT") {
        let output = PathBuf::from(output);
        assert!(output.is_absolute());
        fs::create_dir(&output).expect("qualification export must be fresh");
        // Fixed public allowlist only: never copy the fixture root, jobs,
        // bootstrap configuration, or any private key material.
        for name in ["context.json", "trusted-root.json", "payload.json"] {
            fs::copy(fixture.root().join(name), output.join(name)).unwrap();
        }
        for name in ["records", "seed", "envelopes"] {
            copy_public_fixture(&fixture.root().join(name), &output.join(name));
        }
    }
}

impl Fixture {
    async fn new(populated_seed: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let offline = [
            TestKey::generate(root, "root1.der"),
            TestKey::generate(root, "root2.der"),
            TestKey::generate(root, "root3.der"),
        ];
        let names = [
            "targets",
            "snapshot",
            "timestamp",
            "releases",
            "preview",
            "stable",
        ];
        let role_keys: Vec<_> = names
            .iter()
            .map(|name| TestKey::generate(root, &format!("{name}.der")))
            .collect();
        write_root(root, &offline, &role_keys[..3]).await;
        let records = root.join("records");
        fs::create_dir(&records).unwrap();
        write_records(&records);
        if !populated_seed {
            empty_stable(&records);
        }
        write_json(
            &root.join("payload.json"),
            &json!({"schema_version":1,"keys":[{"id":sha256(PAYLOAD_PUBLIC_KEY),"tauri_public_key":STANDARD.encode(PAYLOAD_PUBLIC_KEY)}]}),
        );
        let now = Timestamp::now();
        let future = |days: u64| {
            now.checked_add(Duration::from_secs(days * 86400))
                .unwrap()
                .to_string()
        };
        let bootstrap = json!({"schema_version":2,"generated_at":now.to_string(),"trusted_root":"trusted-root.json",
            "reconstructed_records":"records","payload_key_registry":"payload.json","output":"seed",
            "keys":{"targets":"targets.der","snapshot":"snapshot.der","timestamp":"timestamp.der","releases":"releases.der","preview":"preview.der","stable":"stable.der"},
            "versions":{"targets":1,"snapshot":1,"timestamp":1,"releases":1,"preview":1,"stable":1},
            "expires":{"targets":future(60),"snapshot":future(6),"timestamp":future(1),"releases":future(60),"preview":future(6),"stable":future(6)}});
        write_json(&root.join("bootstrap.json"), &bootstrap);
        build_tuf_repository(&root.join("bootstrap.json"))
            .await
            .unwrap();
        if populated_seed {
            empty_stable(&records);
        }
        let mut context = bootstrap.clone();
        let object = context.as_object_mut().unwrap();
        object.remove("keys");
        object.remove("output");
        context["schema_version"] = json!(1);
        context["offline_targets"] = json!("seed/metadata/1.targets.json");
        context["previous_repository"] = json!("seed");
        for role in &names[1..] {
            context["versions"][role] = json!(2);
        }
        let mut keys = HashMap::new();
        for (name, key) in names.into_iter().zip(&role_keys) {
            if name != "targets" {
                keys.insert(name, fs::read(&key.0).unwrap());
            }
            fs::remove_file(&key.0).unwrap();
        }
        for key in offline {
            fs::remove_file(&key.0).unwrap();
        }
        fs::create_dir(root.join("envelopes")).unwrap();
        fs::create_dir(root.join("jobs")).unwrap();
        let fixture = Self {
            directory,
            context,
            keys,
        };
        fixture.save_context();
        fixture
    }

    fn root(&self) -> &Path {
        self.directory.path()
    }
    fn save_context(&self) {
        write_json(&self.root().join("context.json"), &self.context);
    }

    async fn sign_with(
        &self,
        role: &str,
        key_role: &str,
    ) -> Result<RoleReport, TufRepositoryError> {
        let job = self.root().join("jobs").join(role);
        fs::create_dir_all(&job).unwrap();
        let private = job.join("key.der");
        fs::write(&private, &self.keys[key_role]).unwrap();
        let mut config = json!({"schema_version":1,"context":"../../context.json","signing_key":"key.der","output":"role.json"});
        if ["snapshot", "timestamp"].contains(&role) {
            config["signed_roles"] = json!("../../envelopes");
        }
        write_json(&job.join("config.json"), &config);
        let result =
            sign_tuf_role(OnlineRole::parse(role).unwrap(), &job.join("config.json")).await;
        fs::remove_file(private).unwrap();
        if let Ok(report) = &result {
            fs::copy(
                &report.output,
                self.root().join("envelopes").join(format!("{role}.json")),
            )
            .unwrap();
        }
        result
    }

    async fn sign_all(&self) {
        for role in ["releases", "preview", "stable", "snapshot", "timestamp"] {
            self.sign_with(role, role).await.unwrap();
        }
    }

    fn assembly_config(&self) -> PathBuf {
        let path = self.root().join("assemble.json");
        write_json(
            &path,
            &json!({"schema_version":1,"context":"context.json","signed_roles":"envelopes","output":"assembled"}),
        );
        path
    }

    fn add_version(&self) {
        let additional = tempfile::tempdir_in(self.root()).unwrap();
        write_version_records(additional.path(), "1.1.0");
        empty_stable(additional.path());
        let path = self.root().join("records/reconstruction-manifest.json");
        let mut current: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let next: serde_json::Value = serde_json::from_slice(
            &fs::read(additional.path().join("reconstruction-manifest.json")).unwrap(),
        )
        .unwrap();
        for record in next["records"].as_array().unwrap() {
            let relative = record["path"].as_str().unwrap();
            let destination = self.root().join("records").join(relative);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::copy(additional.path().join(relative), destination).unwrap();
            current["records"]
                .as_array_mut()
                .unwrap()
                .push(record.clone());
        }
        write_json(&path, &current);
    }
}

#[tokio::test]
async fn single_role_jobs_then_keyless_assembly_preserve_offline_bytes_history_and_retry() {
    let mut fixture = Fixture::new(false).await;
    fixture.add_version();
    let before = fs::read(fixture.root().join("seed/metadata/1.targets.json")).unwrap();
    fixture.sign_all().await;
    export_public_fixture(&fixture);
    let stable: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.root().join("envelopes/stable.json")).unwrap())
            .unwrap();
    assert!(stable["signed"]["targets"].as_object().unwrap().is_empty());
    assert_eq!(stable["signatures"].as_array().unwrap().len(), 1);
    let retry = fixture.sign_with("releases", "releases").await.unwrap();
    assert!(!retry.changed);
    let assembled = assemble_tuf_repository(&fixture.assembly_config())
        .await
        .unwrap();
    assert!(assembled.changed);
    assert_eq!(assembled.records, 4);
    assert_eq!(
        fs::read(assembled.output.join("metadata/1.targets.json")).unwrap(),
        before
    );
    assert!(
        !assemble_tuf_repository(&fixture.assembly_config())
            .await
            .unwrap()
            .changed
    );
    let repository = RepositoryLoader::new(
        &fs::read(fixture.root().join("trusted-root.json")).unwrap(),
        Url::from_directory_path(assembled.output.join("metadata")).unwrap(),
        Url::from_directory_path(assembled.output.join("targets")).unwrap(),
    )
    .load()
    .await
    .unwrap();
    for version in ["1.0.0", "1.1.0"] {
        let name = TargetName::new(format!("releases/{version}/windows-x86_64/nsis.json")).unwrap();
        let bytes = repository
            .read_target(&name)
            .await
            .unwrap()
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap()
            .concat();
        assert_eq!(
            bytes,
            fs::read(fixture.root().join("records").join(name.raw())).unwrap()
        );
    }
    // Both new commands use the compiled ordinary tool, not a test key facade.
    let invalid_role = std::process::Command::new(env!("CARGO_BIN_EXE_portcove-release-tools"))
        .args(["sign-tuf-role", "targets", "not-a-config.json"])
        .output()
        .unwrap();
    assert!(!invalid_role.status.success());
    assert!(
        String::from_utf8(invalid_role.stderr)
            .unwrap()
            .contains("only the five")
    );
    let cli = std::process::Command::new(env!("CARGO_BIN_EXE_portcove-release-tools"))
        .arg("assemble-tuf")
        .arg(fixture.assembly_config())
        .output()
        .unwrap();
    assert!(
        cli.status.success(),
        "{}",
        String::from_utf8_lossy(&cli.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&cli.stdout).unwrap()["changed"],
        false
    );
    // A subsequent routine generation can consume the retained-history output,
    // preserving both older signed generations byte for byte.
    fixture.context["previous_repository"] = json!("assembled");
    for role in ["releases", "preview", "stable", "snapshot", "timestamp"] {
        fixture.context["versions"][role] = json!(3);
    }
    fixture.save_context();
    let envelopes = fixture.root().join("renewal-envelopes");
    fs::create_dir(&envelopes).unwrap();
    for role in ["releases", "preview", "stable", "snapshot", "timestamp"] {
        let job = fixture.root().join(format!("renewal-{role}"));
        fs::create_dir(&job).unwrap();
        let private = job.join("key.der");
        fs::write(&private, &fixture.keys[role]).unwrap();
        let mut config = json!({"schema_version":1,"context":"../context.json","signing_key":"key.der","output":"role.json"});
        if ["snapshot", "timestamp"].contains(&role) {
            config["signed_roles"] = json!("../renewal-envelopes");
        }
        write_json(&job.join("config.json"), &config);
        let signed =
            sign_tuf_role(OnlineRole::parse(role).unwrap(), &job.join("config.json")).await;
        fs::remove_file(private).unwrap();
        let signed = signed.unwrap();
        fs::copy(signed.output, envelopes.join(format!("{role}.json"))).unwrap();
    }
    let config = fixture.root().join("renewal-assemble.json");
    write_json(
        &config,
        &json!({"schema_version":1,"context":"context.json","signed_roles":"renewal-envelopes","output":"renewed"}),
    );
    let renewed = assemble_tuf_repository(&config).await.unwrap();
    for file in assembled.files.iter().filter(|file| {
        file.path != "metadata/timestamp.json" && file.path != "repository-manifest.json"
    }) {
        assert_eq!(
            fs::read(renewed.output.join(&file.path)).unwrap(),
            fs::read(assembled.output.join(&file.path)).unwrap(),
            "{}",
            file.path
        );
    }
    assert!(renewed.output.join("metadata/1.snapshot.json").is_file());
    assert!(renewed.output.join("metadata/2.snapshot.json").is_file());
    assert!(renewed.output.join("metadata/3.snapshot.json").is_file());
}

#[tokio::test]
async fn refuses_wrong_role_key_and_mutated_signed_inputs_before_next_signer() {
    let fixture = Fixture::new(false).await;
    let error = fixture
        .sign_with("releases", "timestamp")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("does not belong"));
    assert!(!fixture.root().join("jobs/releases/role.json").exists());
    for role in ["releases", "preview", "stable", "snapshot"] {
        fixture.sign_with(role, role).await.unwrap();
    }
    // Whitespace preserves the role signature but changes the signed snapshot's
    // exact input binding; timestamp may not bless a mixed generation.
    let release = fixture.root().join("envelopes/releases.json");
    let saved = fs::read(&release).unwrap();
    fs::write(&release, [saved.as_slice(), b" "].concat()).unwrap();
    assert!(
        fixture
            .sign_with("timestamp", "timestamp")
            .await
            .unwrap_err()
            .to_string()
            .contains("content/version/expiry")
    );
    fs::write(&release, &saved).unwrap();
    fixture.sign_with("timestamp", "timestamp").await.unwrap();
    let preview = fs::read(fixture.root().join("envelopes/preview.json")).unwrap();
    fs::write(fixture.root().join("envelopes/stable.json"), preview).unwrap();
    assert!(
        assemble_tuf_repository(&fixture.assembly_config())
            .await
            .is_err()
    );
    assert!(!fixture.root().join("assembled").exists());
    let mut changed: serde_json::Value = serde_json::from_slice(&saved).unwrap();
    changed["signed"]["version"] = json!(500);
    fs::write(&release, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(fixture.sign_with("snapshot", "snapshot").await.is_err());
}

#[tokio::test]
async fn refuses_expiry_version_floor_release_history_changes_and_extra_key_configuration() {
    let mut fixture = Fixture::new(false).await;
    let original = fixture.context.clone();
    fixture.context["versions"]["releases"] = json!(1);
    fixture.save_context();
    assert!(
        fixture
            .sign_with("releases", "releases")
            .await
            .unwrap_err()
            .to_string()
            .contains("authenticated prior floor")
    );
    fixture.context = original.clone();
    fixture.context["expires"]["timestamp"] = json!(
        Timestamp::now()
            .checked_add(Duration::from_secs(4 * 86400))
            .unwrap()
            .to_string()
    );
    fixture.save_context();
    assert!(
        fixture
            .sign_with("timestamp", "timestamp")
            .await
            .unwrap_err()
            .to_string()
            .contains("allowed window")
    );
    fixture.context = original;
    fixture.save_context();
    let records = fixture.root().join("records/reconstruction-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&records).unwrap()).unwrap();
    let release = &mut manifest["records"][0];
    let path = fixture
        .root()
        .join("records")
        .join(release["path"].as_str().unwrap());
    let mut bytes = fs::read(&path).unwrap();
    bytes.push(b' ');
    fs::write(&path, &bytes).unwrap();
    release["sha256"] = json!(sha256(&bytes));
    release["bytes"] = json!(bytes.len());
    write_json(&records, &manifest);
    assert!(
        fixture
            .sign_with("releases", "releases")
            .await
            .unwrap_err()
            .to_string()
            .contains("immutable published release history")
    );
    let bad = fixture.root().join("bad-keyless.json");
    write_json(
        &bad,
        &json!({"schema_version":1,"context":"missing","signed_roles":"missing","output":"never","signing_key":"never-read"}),
    );
    assert!(
        assemble_tuf_repository(&bad)
            .await
            .unwrap_err()
            .to_string()
            .contains("unknown field")
    );
    for name in ["root", "targets", "payload", "other"] {
        assert!(OnlineRole::parse(name).is_err());
    }
}

#[tokio::test]
async fn empty_stable_is_only_renewal_and_never_promotes_or_erases_authenticated_stable() {
    let populated = Fixture::new(true).await;
    assert!(
        populated
            .sign_with("stable", "stable")
            .await
            .unwrap_err()
            .to_string()
            .contains("empty prior Stable")
    );
    let fixture = Fixture::new(false).await;
    let source = tempfile::tempdir_in(fixture.root()).unwrap();
    write_records(source.path());
    let manifest_path = fixture.root().join("records/reconstruction-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let promotion: serde_json::Value = serde_json::from_slice::<serde_json::Value>(
        &fs::read(source.path().join("reconstruction-manifest.json")).unwrap(),
    )
    .unwrap()["records"][2]
        .clone();
    let name = promotion["path"].as_str().unwrap();
    let path = fixture.root().join("records").join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::copy(source.path().join(name), path).unwrap();
    manifest["records"].as_array_mut().unwrap().push(promotion);
    write_json(&manifest_path, &manifest);
    assert!(
        fixture
            .sign_with("stable", "stable")
            .await
            .unwrap_err()
            .to_string()
            .contains("cannot add or promote")
    );
}

#[tokio::test]
async fn correctly_signed_expired_prior_state_requires_separate_recovery() {
    let fixture = Fixture::new(false).await;
    let root: tough::schema::Signed<Root> =
        serde_json::from_slice(&fs::read(fixture.root().join("trusted-root.json")).unwrap())
            .unwrap();
    let path = fixture.root().join("seed/metadata/timestamp.json");
    let mut timestamp: tough::schema::Signed<tough::schema::Timestamp> =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    timestamp.signed.expires = Timestamp::now()
        .checked_sub(Duration::from_secs(60))
        .unwrap();
    let private = fixture.root().join("expired-timestamp.der");
    fs::write(&private, &fixture.keys["timestamp"]).unwrap();
    let expired = SignedRole::new(
        timestamp.signed,
        &KeyHolder::Root(root.signed),
        &[key(private.clone())],
        &SystemRandom::new(),
    )
    .await
    .unwrap();
    fs::remove_file(private).unwrap();
    fs::write(&path, expired.buffer()).unwrap();
    // Keep the retained public inventory exact, so the refusal must come from
    // Tough's expiration check rather than an unrelated manifest mismatch.
    let manifest_path = fixture.root().join("seed/repository-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let entry = manifest["files"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["path"] == "metadata/timestamp.json")
        .unwrap();
    entry["bytes"] = json!(expired.buffer().len());
    entry["sha256"] = json!(sha256(expired.buffer()));
    write_json(&manifest_path, &manifest);
    let error = fixture.sign_with("releases", "releases").await.unwrap_err();
    assert!(matches!(error, TufRepositoryError::Tough(_)), "{error}");
    assert!(
        error.to_string().to_lowercase().contains("expired"),
        "{error}"
    );
    assert!(!fixture.root().join("jobs/releases/role.json").exists());
}

#[tokio::test]
async fn public_artifacts_refuse_extra_private_files_before_signing_or_assembly() {
    let fixture = Fixture::new(false).await;
    let unexpected = fixture.root().join("seed/another-role.der");
    fs::write(&unexpected, "not a public repository input").unwrap();
    assert!(
        fixture
            .sign_with("releases", "releases")
            .await
            .unwrap_err()
            .to_string()
            .contains("non-public file")
    );
    fs::remove_file(unexpected).unwrap();
    fixture.sign_all().await;
    fs::write(
        fixture.root().join("envelopes/private.der"),
        "not an envelope",
    )
    .unwrap();
    assert!(
        assemble_tuf_repository(&fixture.assembly_config())
            .await
            .is_err()
    );
    assert!(!fixture.root().join("assembled").exists());
}
