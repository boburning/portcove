//! Disposable fixture keys only. Each creation process generates one key;
//! every signing process receives one private-key pathname. Production use
//! requires independently authorized initial custody setup.
use super::*;
use portcove_release_tools::initial_root_profile::InitialRootProfile;
use std::process::{Command, Output};
use tough::schema::{Role, Signed};

struct Ceremony {
    directory: tempfile::TempDir,
    keys: Vec<TestKey>,
    public: Vec<serde_json::Value>,
    generated: Timestamp,
    profile: InitialRootProfile,
}

impl Ceremony {
    async fn new() -> Self {
        Self::with_profile(InitialRootProfile::LegacyTwoOfThreeV1).await
    }

    async fn with_profile(profile: InitialRootProfile) -> Self {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("tmp")).unwrap();
        let mut fixture = Self {
            directory,
            keys: Vec::new(),
            public: Vec::new(),
            generated: Timestamp::now(),
            profile,
        };
        for index in 0..9 {
            let output = format!("custodian-{index}");
            let report = fixture.success(
                "create-offline-key",
                &fixture.config(
                    &format!("create-{index}.json"),
                    &json!({"schema_version":1,"output_directory":output}),
                ),
            );
            let filename = format!("{output}/public.json");
            let bytes = fs::read(fixture.root().join(&filename)).unwrap();
            assert_eq!(report["public_key_sha256"], sha256(&bytes));
            assert!(report.get("private_key_sha256").is_none());
            let key = TestKey(fixture.root().join(&output).join("private.pk8"));
            assert_eq!(
                serde_json::from_slice::<tough::schema::key::Key>(&bytes).unwrap(),
                key.source().as_sign().await.unwrap().tuf_key()
            );
            fixture.keys.push(key);
            fixture
                .public
                .push(json!({"path":filename,"sha256":sha256(&bytes)}));
        }
        fixture
    }

    fn root(&self) -> &Path {
        self.directory.path()
    }
    fn future(&self, days: u64) -> String {
        self.generated
            .checked_add(Duration::from_secs(days * 86400))
            .unwrap()
            .to_string()
    }
    fn config(&self, name: &str, value: &serde_json::Value) -> PathBuf {
        let path = self.root().join(name);
        fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        path
    }
    fn command(&self) -> Command {
        let mut child = Command::new(env!("CARGO_BIN_EXE_portcove-release-tools"));
        child.current_dir(self.root()).env_clear();
        for name in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(name) {
                child.env(name, value);
            }
        }
        for name in ["TEMP", "TMP", "TMPDIR"] {
            child.env(name, self.root().join("tmp"));
        }
        child
    }
    fn cli(&self, command: &str, config: &Path) -> Output {
        self.command().arg(command).arg(config).output().unwrap()
    }
    fn success(&self, command: &str, config: &Path) -> serde_json::Value {
        let result = self.cli(command, config);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice(&result.stdout).unwrap()
    }
    fn refuse(&self, command: &str, value: serde_json::Value, name: &str) {
        let output = value["output"].as_str().map(|name| self.root().join(name));
        let config = self.config(name, &value);
        let result = self.cli(command, &config);
        assert!(
            !result.status.success(),
            "unexpected success: {}",
            String::from_utf8_lossy(&result.stdout)
        );
        if let Some(output) = output {
            assert!(!output.exists());
        }
    }
    fn proposal(&self) -> serde_json::Value {
        let count = if self.profile == InitialRootProfile::SingleOwnerOneOfOneV1 {
            1
        } else {
            3
        };
        self.appointed(json!({"schema_version":1,"generated_at":self.generated.to_string(),"expires":self.future(300),
            "root_public_keys":&self.public[..count],"targets_public_key":self.public[3],
            "snapshot_public_key":self.public[4],"timestamp_public_key":self.public[5],"output":"proposal.json"}))
    }
    fn appointed(&self, mut value: serde_json::Value) -> serde_json::Value {
        if self.profile == InitialRootProfile::SingleOwnerOneOfOneV1 {
            value["initial_root_profile"] = json!(self.profile);
        }
        value
    }
    fn partial(&self, input: &str, body: &str, key: usize, output: &str) -> serde_json::Value {
        self.appointed(
            json!({"schema_version":1,"generated_at":self.generated.to_string(),"root":input,
            "signed_body_sha256":body,"signing_key":self.keys[key].0,"output":output}),
        )
    }
    fn finalize(&self, input: &str, body: &str, output: &str) -> serde_json::Value {
        self.appointed(
            json!({"schema_version":1,"generated_at":self.generated.to_string(),"root":input,
            "signed_body_sha256":body,"output":output}),
        )
    }
    fn prepare(&self) -> String {
        let result = self.success(
            "prepare-offline-root",
            &self.config("prepare.json", &self.proposal()),
        );
        assert_eq!(result["root_quorum"], false);
        let body = result["signed_body_sha256"].as_str().unwrap().to_owned();
        let first = self.success(
            "sign-offline-root",
            &self.config(
                "sign-first.json",
                &self.partial("proposal.json", &body, 0, "partial-one.json"),
            ),
        );
        assert_eq!(
            first["root_quorum"],
            self.profile == InitialRootProfile::SingleOwnerOneOfOneV1
        );
        let complete = if self.profile == InitialRootProfile::LegacyTwoOfThreeV1 {
            let second = self.success(
                "sign-offline-root",
                &self.config(
                    "sign-second.json",
                    &self.partial("partial-one.json", &body, 1, "partial-two.json"),
                ),
            );
            assert_eq!(second["root_quorum"], true);
            "partial-two.json"
        } else {
            "partial-one.json"
        };
        self.success(
            "finalize-offline-root",
            &self.config(
                "finalize.json",
                &self.finalize(complete, &body, "root-final.json"),
            ),
        );
        body
    }
    fn targets(&self) -> serde_json::Value {
        let bytes=serde_json::to_vec(&json!({"schema_version":1,"keys":[{"id":sha256(PAYLOAD_PUBLIC_KEY),"tauri_public_key":STANDARD.encode(PAYLOAD_PUBLIC_KEY)}]})).unwrap();
        fs::write(self.root().join("payload.json"), &bytes).unwrap();
        self.appointed(json!({"schema_version":1,"generated_at":self.generated.to_string(),"trusted_root":"root-final.json",
            "trusted_root_sha256":sha256(&fs::read(self.root().join("root-final.json")).unwrap()),
            "payload_key_registry":"payload.json","payload_key_registry_sha256":sha256(&bytes),
            "delegated_public_keys":{"releases":self.public[6],"preview":self.public[7],"stable":self.public[8]},
            "version":1,"expires":self.future(60),"signing_key":self.keys[3].0,"output":"offline-targets.json"}))
    }
}

#[tokio::test]
async fn offline_ceremony_actual_single_key_cli_then_five_separate_jobs_bootstrap_with_tough() {
    let fixture = Ceremony::new().await;
    prove_bootstrap(fixture).await;
}

#[tokio::test]
async fn explicitly_appointed_single_owner_cli_and_five_role_bootstrap_refuse_implicit_downgrade() {
    let fixture = Ceremony::with_profile(InitialRootProfile::SingleOwnerOneOfOneV1).await;
    prove_bootstrap(fixture).await;
}

async fn prove_bootstrap(fixture: Ceremony) {
    let body = fixture.prepare();
    let read_root = |name| {
        serde_json::from_slice::<Signed<Root>>(&fs::read(fixture.root().join(name)).unwrap())
            .unwrap()
    };
    let partial = read_root("partial-one.json");
    let threshold = if fixture.profile == InitialRootProfile::SingleOwnerOneOfOneV1 {
        1
    } else {
        2
    };
    assert_eq!(
        partial.signed.roles[&RoleType::Root].threshold.get(),
        threshold
    );
    assert_eq!(partial.signatures.len(), 1);
    assert_eq!(partial.signed.verify_role(&partial).is_ok(), threshold == 1);
    let complete = read_root("root-final.json");
    complete.signed.verify_role(&complete).unwrap();
    assert_eq!(
        complete.signed.canonical_form().unwrap(),
        partial.signed.canonical_form().unwrap()
    );
    assert_eq!(sha256(&complete.signed.canonical_form().unwrap()), body);
    assert_eq!(complete.signatures.len(), threshold as usize);

    fixture.success(
        "sign-offline-targets",
        &fixture.config("targets-config.json", &fixture.targets()),
    );
    fs::create_dir(fixture.root().join("records")).unwrap();
    fixture.config(
        "records/reconstruction-manifest.json",
        &json!({"schema_version":1,"records":[]}),
    );
    let expires = json!({"targets":fixture.future(60),"releases":fixture.future(60),"preview":fixture.future(6),"stable":fixture.future(6),"snapshot":fixture.future(6),"timestamp":fixture.future(1)});
    let versions =
        json!({"targets":1,"releases":1,"preview":1,"stable":1,"snapshot":1,"timestamp":1});
    let mut context = fixture.appointed(json!({"schema_version":1,"generated_at":fixture.generated.to_string(),"trusted_root":"root-final.json",
        "offline_targets":"offline-targets.json","payload_key_registry":"payload.json","reconstructed_records":"records",
        "initial_bootstrap":"initial.json","versions":versions,"expires":expires}));
    let descriptor = |root: &str| {
        json!({"schema_version":1,"kind":"application-tuf-initial-bootstrap","generated_at":fixture.generated.to_string(),
        "setup_plan_sha256":"1".repeat(64),"initial_site_preimage_sha256":"2".repeat(64),
        "root_sha256":sha256(&fs::read(fixture.root().join(root)).unwrap()),
        "offline_targets_sha256":sha256(&fs::read(fixture.root().join("offline-targets.json")).unwrap()),
        "payload_key_registry_sha256":sha256(&fs::read(fixture.root().join("payload.json")).unwrap()),
        "initial_records_sha256":sha256(b"[]"),"expires":expires,
        "versions":{"targets":"1","releases":"1","preview":"1","stable":"1","snapshot":"1","timestamp":"1"}})
    };
    let incomplete = if threshold == 1 {
        "proposal.json"
    } else {
        "partial-one.json"
    };
    fixture.config("initial.json", &descriptor(incomplete));
    context["trusted_root"] = json!(incomplete);
    let path = fixture.config("context.json", &context);
    assert!(!fixture.cli("inspect-tuf-bootstrap", &path).status.success());
    context["trusted_root"] = json!("root-final.json");
    fixture.config("initial.json", &descriptor("root-final.json"));
    fixture.config("context.json", &context);
    if threshold == 1 {
        let mut implicit = context.clone();
        implicit
            .as_object_mut()
            .unwrap()
            .remove("initial_root_profile");
        fixture.config("context.json", &implicit);
        assert!(!fixture.cli("inspect-tuf-bootstrap", &path).status.success());

        // A duplicate inventory is still malformed when the appointed key
        // genuinely signs the changed body. Refuse the shape, not just an
        // invalid signature or a stale bootstrap-descriptor hash.
        let mut duplicate = read_root("root-final.json").signed;
        let role = duplicate.roles.get_mut(&RoleType::Root).unwrap();
        role.keyids.push(role.keyids[0].clone());
        let signed_duplicate = SignedRole::new(
            duplicate.clone(),
            &KeyHolder::Root(duplicate),
            &[fixture.keys[0].source()],
            &SystemRandom::new(),
        )
        .await
        .unwrap();
        fs::write(
            fixture.root().join("duplicate-root-ids.json"),
            signed_duplicate.buffer(),
        )
        .unwrap();
        let mut duplicate_context = context.clone();
        duplicate_context["trusted_root"] = json!("duplicate-root-ids.json");
        fixture.config("initial.json", &descriptor("duplicate-root-ids.json"));
        fixture.config("context.json", &duplicate_context);
        let refused = fixture.cli("inspect-tuf-bootstrap", &path);
        assert!(!refused.status.success());
        assert!(String::from_utf8_lossy(&refused.stderr).contains("initial Root profile"));
        assert!(!fixture.root().join("envelopes").exists());
        assert!(!fixture.root().join("jobs").exists());
        fixture.config("initial.json", &descriptor("root-final.json"));
        fixture.config("context.json", &context);
    }
    fixture.success("inspect-tuf-bootstrap", &path);

    fs::create_dir(fixture.root().join("envelopes")).unwrap();
    fs::create_dir(fixture.root().join("jobs")).unwrap();
    for (role, index) in [
        ("releases", 6),
        ("preview", 7),
        ("stable", 8),
        ("snapshot", 4),
        ("timestamp", 5),
    ] {
        let job = fixture.root().join("jobs").join(role);
        fs::create_dir(&job).unwrap();
        fs::copy(&fixture.keys[index].0, job.join("one-key.der")).unwrap();
        let mut config = json!({"schema_version":1,"context":"../../context.json","signing_key":"one-key.der","output":"role.json"});
        if ["snapshot", "timestamp"].contains(&role) {
            config["signed_roles"] = json!("../../envelopes");
        }
        fixture.config(&format!("jobs/{role}/config.json"), &config);
        let result = fixture
            .command()
            .args(["sign-tuf-role", role])
            .arg(job.join("config.json"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            fs::read_dir(&job)
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "der"))
                .count(),
            1
        );
        fs::copy(
            job.join("role.json"),
            fixture
                .root()
                .join("envelopes")
                .join(format!("{role}.json")),
        )
        .unwrap();
    }
    let assembly=fixture.config("assemble.json",&json!({"schema_version":1,"context":"context.json","signed_roles":"envelopes","output":"assembled"}));
    fixture.success("assemble-tuf", &assembly);
    let repository = RepositoryLoader::new(
        &fs::read(fixture.root().join("root-final.json")).unwrap(),
        Url::from_directory_path(fixture.root().join("assembled/metadata")).unwrap(),
        Url::from_directory_path(fixture.root().join("assembled/targets")).unwrap(),
    )
    .load()
    .await
    .unwrap();
    assert!(
        repository
            .read_target(&TargetName::new("keys/payload.json").unwrap())
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        fs::read(fixture.root().join("assembled/metadata/1.targets.json")).unwrap(),
        fs::read(fixture.root().join("offline-targets.json")).unwrap()
    );
}

#[tokio::test]
async fn single_owner_requires_explicit_profile_exact_body_sole_signer_and_new_outputs() {
    let fixture = Ceremony::with_profile(InitialRootProfile::SingleOwnerOneOfOneV1).await;
    let mut implicit = fixture.proposal();
    implicit
        .as_object_mut()
        .unwrap()
        .remove("initial_root_profile");
    fixture.refuse("prepare-offline-root", implicit, "implicit-proposal.json");
    let mut aliased = fixture.proposal();
    aliased["targets_public_key"] = aliased["root_public_keys"][0].clone();
    fixture.refuse("prepare-offline-root", aliased, "aliased-role.json");
    let body = fixture.prepare();
    fixture.refuse(
        "sign-offline-root",
        fixture.partial("proposal.json", &body, 3, "wrong-role.json"),
        "wrong-role-config.json",
    );
    fixture.refuse(
        "finalize-offline-root",
        fixture.finalize("proposal.json", &body, "unsigned-final.json"),
        "unsigned-config.json",
    );
    fixture.refuse(
        "sign-offline-root",
        fixture.partial("partial-one.json", &body, 0, "extra-signature.json"),
        "extra-signature-config.json",
    );
    fixture.refuse(
        "finalize-offline-root",
        fixture.finalize("partial-one.json", &"0".repeat(64), "changed-body.json"),
        "changed-body-config.json",
    );
    let mut wrong_profile = fixture.finalize("partial-one.json", &body, "wrong-profile.json");
    wrong_profile["initial_root_profile"] = json!(InitialRootProfile::LegacyTwoOfThreeV1);
    fixture.refuse(
        "finalize-offline-root",
        wrong_profile,
        "wrong-profile-config.json",
    );
    let retained = fs::read(fixture.root().join("root-final.json")).unwrap();
    let result = fixture.cli(
        "finalize-offline-root",
        &fixture.config(
            "reuse-config.json",
            &fixture.finalize("partial-one.json", &body, "root-final.json"),
        ),
    );
    assert!(!result.status.success());
    assert_eq!(
        fs::read(fixture.root().join("root-final.json")).unwrap(),
        retained
    );
}

#[tokio::test]
async fn offline_ceremony_refuses_duplicate_signers_body_changes_wrong_roles_and_output_reuse() {
    let fixture = Ceremony::new().await;
    let body = fixture.prepare();
    fixture.refuse(
        "sign-offline-root",
        fixture.partial("partial-one.json", &body, 0, "duplicate-output.json"),
        "duplicate-config.json",
    );
    fixture.refuse(
        "sign-offline-root",
        fixture.partial("partial-one.json", &body, 3, "wrong-role-output.json"),
        "wrong-role-config.json",
    );
    fixture.refuse(
        "finalize-offline-root",
        fixture.finalize("partial-one.json", &body, "partial-final.json"),
        "partial-final-config.json",
    );
    let mut partial: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.root().join("partial-one.json")).unwrap())
            .unwrap();
    partial["signed"]["expires"] = json!(fixture.future(299));
    fixture.config("changed-body.json", &partial);
    fixture.refuse(
        "sign-offline-root",
        fixture.partial("changed-body.json", &body, 1, "changed-output.json"),
        "changed-config.json",
    );
    let mut partial: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.root().join("partial-one.json")).unwrap())
            .unwrap();
    let signature = partial["signatures"][0].clone();
    partial["signatures"]
        .as_array_mut()
        .unwrap()
        .push(signature);
    fixture.config("duplicate-envelope.json", &partial);
    fixture.refuse(
        "finalize-offline-root",
        fixture.finalize("duplicate-envelope.json", &body, "duplicate-final.json"),
        "duplicate-final-config.json",
    );
    partial["signatures"].as_array_mut().unwrap().truncate(1);
    partial["signatures"][0]["sig"] = json!("00".repeat(64));
    fixture.config("bad-signature.json", &partial);
    fixture.refuse(
        "sign-offline-root",
        fixture.partial("bad-signature.json", &body, 1, "bad-signature-output.json"),
        "bad-signature-config.json",
    );
    let mut proposal: Signed<Root> =
        serde_json::from_slice(&fs::read(fixture.root().join("proposal.json")).unwrap()).unwrap();
    proposal
        .signed
        .roles
        .get_mut(&RoleType::Root)
        .unwrap()
        .threshold = std::num::NonZeroU64::MIN;
    let weak_body = sha256(&proposal.signed.canonical_form().unwrap());
    fixture.config("weak-root.json", &serde_json::to_value(proposal).unwrap());
    fixture.refuse(
        "sign-offline-root",
        fixture.partial("weak-root.json", &weak_body, 0, "weak-output.json"),
        "weak-config.json",
    );
    fixture.refuse(
        "sign-offline-root",
        fixture.partial("proposal.json", &body, 8, "unknown-output.json"),
        "unknown-config.json",
    );
    let mut targets = fixture.targets();
    targets["delegated_public_keys"]["preview"] = fixture.public[6].clone();
    fixture.refuse("sign-offline-targets", targets, "duplicate-delegate.json");
    let mut targets = fixture.targets();
    targets["delegated_public_keys"]["releases"]["sha256"] = json!("0".repeat(64));
    fixture.refuse("sign-offline-targets", targets, "changed-public-key.json");
    let mut targets = fixture.targets();
    targets["signing_key"] = json!(fixture.keys[0].0);
    fixture.refuse("sign-offline-targets", targets, "wrong-target-key.json");
    let mut targets = fixture.targets();
    targets["delegated_public_keys"]["releases"] = fixture.public[0].clone();
    fixture.refuse("sign-offline-targets", targets, "root-delegation.json");
    let mut targets = fixture.targets();
    targets["version"] = json!(2);
    fixture.refuse("sign-offline-targets", targets, "renewal-refused.json");
    let mut proposal = fixture.proposal();
    let private = json!({"keytype":"ed25519","scheme":"ed25519","keyval":{"public":"00".repeat(32),"private":"must-not-serialize"}});
    let bytes = serde_json::to_vec(&private).unwrap();
    fs::write(fixture.root().join("not-public.json"), &bytes).unwrap();
    proposal["root_public_keys"][0] = json!({"path":"not-public.json","sha256":sha256(&bytes)});
    proposal["output"] = json!("private-field-output.json");
    fixture.refuse(
        "prepare-offline-root",
        proposal,
        "private-field-config.json",
    );
    let mut hidden: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.root().join("proposal.json")).unwrap()).unwrap();
    let key = hidden["signed"]["keys"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    key["keyval"]["private"] = json!("must-not-serialize");
    fixture.config("hidden-private-root.json", &hidden);
    fixture.refuse(
        "sign-offline-root",
        fixture.partial(
            "hidden-private-root.json",
            &body,
            0,
            "hidden-private-output.json",
        ),
        "hidden-private-config.json",
    );
    let mut envelope: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.root().join("partial-two.json")).unwrap())
            .unwrap();
    envelope["unexpected_private_material"] = json!("must-not-retain");
    fixture.config("extra-envelope.json", &envelope);
    fixture.refuse(
        "finalize-offline-root",
        fixture.finalize("extra-envelope.json", &body, "extra-envelope-output.json"),
        "extra-envelope-config.json",
    );
    for (name, pointer, value) in [
        ("wrong-keytype", "/keytype", json!("rsa")),
        ("wrong-scheme", "/scheme", json!("rsassa-pss-sha256")),
        ("short-public", "/keyval/public", json!("00")),
        ("uppercase-public", "/keyval/public", json!("AB".repeat(32))),
    ] {
        let mut public: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture.root().join("custodian-0/public.json")).unwrap(),
        )
        .unwrap();
        *public.pointer_mut(pointer).unwrap() = value;
        let bytes = serde_json::to_vec(&public).unwrap();
        let filename = format!("{name}.json");
        fs::write(fixture.root().join(&filename), &bytes).unwrap();
        let mut proposal = fixture.proposal();
        proposal["root_public_keys"][0] = json!({"path":filename,"sha256":sha256(&bytes)});
        proposal["output"] = json!(format!("{name}-output.json"));
        fixture.refuse(
            "prepare-offline-root",
            proposal,
            &format!("{name}-config.json"),
        );
    }
    let complete: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.root().join("partial-two.json")).unwrap())
            .unwrap();
    let raw = serde_json::to_string(&complete).unwrap();
    let duplicate = raw.replacen("\"version\":1", "\"version\":1,\"version\":1", 1);
    assert_ne!(duplicate, raw);
    fs::write(fixture.root().join("duplicate-root-field.json"), duplicate).unwrap();
    fixture.refuse(
        "finalize-offline-root",
        fixture.finalize(
            "duplicate-root-field.json",
            &body,
            "duplicate-root-field-output.json",
        ),
        "duplicate-root-field-config.json",
    );
    let before = fs::read(fixture.root().join("root-final.json")).unwrap();
    let result = fixture.cli(
        "finalize-offline-root",
        &fixture.config(
            "reuse.json",
            &fixture.finalize("partial-two.json", &body, "root-final.json"),
        ),
    );
    assert!(!result.status.success());
    assert_eq!(
        fs::read(fixture.root().join("root-final.json")).unwrap(),
        before
    );
}

#[tokio::test]
async fn offline_ceremony_refuses_oversize_and_aliased_inputs_without_output() {
    let fixture = Ceremony::new().await;
    let oversized = fixture.root().join("oversize.json");
    fs::write(&oversized, vec![b' '; 65537]).unwrap();
    assert!(
        !fixture
            .cli("prepare-offline-root", &oversized)
            .status
            .success()
    );
    let mut proposal = fixture.proposal();
    proposal["root_public_keys"][0]["path"] = json!("oversize.json");
    proposal["output"] = json!("oversize-output.json");
    fixture.refuse("prepare-offline-root", proposal, "oversize-config.json");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            fixture.root().join("custodian-0/public.json"),
            fixture.root().join("linked.json"),
        )
        .unwrap();
        let mut proposal = fixture.proposal();
        proposal["root_public_keys"][0]["path"] = json!("linked.json");
        proposal["output"] = json!("link-output.json");
        fixture.refuse("prepare-offline-root", proposal, "link-config.json");
        fs::hard_link(
            fixture.root().join("custodian-0/public.json"),
            fixture.root().join("hardlinked.json"),
        )
        .unwrap();
        let mut proposal = fixture.proposal();
        proposal["output"] = json!("hardlink-output.json");
        fixture.refuse("prepare-offline-root", proposal, "hardlink-config.json");
    }
}

#[tokio::test]
async fn offline_ceremony_single_key_creation_refuses_reuse_and_additional_inputs() {
    let fixture = Ceremony::new().await;
    let existing = fixture.root().join("custodian-0/private.pk8");
    let before = fs::read(&existing).unwrap();
    let reuse = fixture.config(
        "reuse-key.json",
        &json!({"schema_version":1,"output_directory":"custodian-0"}),
    );
    assert!(!fixture.cli("create-offline-key", &reuse).status.success());
    assert_eq!(fs::read(existing).unwrap(), before);
    let extra = fixture.config("extra-key.json", &json!({"schema_version":1,"output_directory":"extra-key","other_private_key":fixture.keys[0].0}));
    assert!(!fixture.cli("create-offline-key", &extra).status.success());
    assert!(!fixture.root().join("extra-key").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(fixture.root().join("custodian-0"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(fixture.root().join("custodian-0/private.pk8"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
