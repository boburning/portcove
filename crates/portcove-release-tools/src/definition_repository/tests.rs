use super::*;
use crate::tuf_repository::{offline, offline_key};
use serde_json::json;
fn json_file(root: &Path, name: &str, value: serde_json::Value) -> PathBuf {
    let path = root.join(name);
    fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    path
}
struct Fixture {
    directory: tempfile::TempDir,
    context: PathBuf,
    roles: PathBuf,
}
impl Fixture {
    async fn new() -> Self {
        Self::new_with_profile(InitialRootProfile::LegacyTwoOfThreeV1).await
    }

    async fn new_with_profile(profile: InitialRootProfile) -> Self {
        Self::with_root_lifetime(profile, 3600).await
    }
    async fn with_root_lifetime(profile: InitialRootProfile, root_seconds: u64) -> Self {
        let appointed = |mut value: serde_json::Value| {
            if profile == InitialRootProfile::SingleOwnerOneOfOneV1 {
                value["initial_root_profile"] = json!(profile);
            }
            value
        };
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let at = Timestamp::now().to_string();
        let expires = Timestamp::now()
            .checked_add(Duration::from_secs(3600))
            .unwrap()
            .to_string();
        let root_expires = Timestamp::now()
            .checked_add(Duration::from_secs(root_seconds))
            .unwrap()
            .to_string();
        let mut public = vec![];
        for index in 0..8 {
            let config = json_file(
                root,
                &format!("key-{index}.json"),
                json!({"schema_version":1,"output_directory":format!("key-{index}")}),
            );
            offline_key::create_one_key(&config).await.unwrap();
            let bytes = fs::read(root.join(format!("key-{index}/public.json"))).unwrap();
            public.push(json!({"path":format!("key-{index}/public.json"),"sha256":sha(&bytes)}));
        }
        let prepare = json_file(
            root,
            "prepare-root.json",
            appointed(
                json!({"schema_version":1,"generated_at":at,"expires":root_expires,"root_public_keys":public[..profile.root_keys()],"targets_public_key":public[3],"snapshot_public_key":public[4],"timestamp_public_key":public[5],"output":"root-unsigned.json"}),
            ),
        );
        let proposal = offline::prepare_initial_root(&prepare).unwrap();
        let mut previous = "root-unsigned.json".to_owned();
        for index in 0..profile.threshold() {
            let output = format!("root-signed-{index}.json");
            let config = json_file(
                root,
                &format!("root-sign-{index}.json"),
                appointed(
                    json!({"schema_version":1,"generated_at":at,"root":previous,"signed_body_sha256":proposal.signed_body_sha256,"signing_key":format!("key-{index}/private.pk8"),"output":output}),
                ),
            );
            offline::sign_initial_root(&config).await.unwrap();
            previous = output;
        }
        let config = json_file(
            root,
            "final-root.json",
            appointed(
                json!({"schema_version":1,"generated_at":at,"root":previous,"signed_body_sha256":proposal.signed_body_sha256,"output":"root.json"}),
            ),
        );
        offline::finalize_initial_root(&config).unwrap();
        let root_bytes = fs::read(root.join("root.json")).unwrap();
        let top_config = json_file(
            root,
            "top-config.json",
            appointed(
                json!({"schema_version":1,"generated_at":at,"trusted_root":"root.json","trusted_root_sha256":sha(&root_bytes),"delegated_public_keys":{"definitions":public[6],"policy":public[7]},"version":1,"expires":expires,"signing_key":"key-3/private.pk8","output":"targets.json"}),
            ),
        );
        sign_offline_definition_targets(&top_config).await.unwrap();
        let bundle = root.join("bundle");
        fs::create_dir_all(bundle.join("definitions")).unwrap();
        fs::create_dir_all(bundle.join("sha256")).unwrap();
        fs::create_dir_all(bundle.join("policy/official")).unwrap();
        let leaf = b"{\"fixture\":\"inert bytes; not semantic acceptance\"}";
        let leaf_sha = sha(leaf);
        let leaf_target = format!("sha256/{leaf_sha}.json");
        fs::write(bundle.join(&leaf_target), leaf).unwrap();
        let index=serde_json::to_vec(&json!({"index_schema":1,"definitions":[{"namespace":"official","stable_id":"fixture","revision":1,"target":leaf_target}],"contents":[{"target":leaf_target,"sha256":leaf_sha,"length":leaf.len()}]})).unwrap();
        fs::write(bundle.join("definitions/index.json"), &index).unwrap();
        let policy = json!({"policy_schema":2,"namespace":"official","stable_id":"fixture","policy_revision":1,"grant_id":"fixture-grant","decision":{"status":"managed_github","definition_revision":1,"index_sha256":sha(&index),"definition_sha256":leaf_sha}});
        fs::write(
            bundle.join("policy/official/fixture.json"),
            serde_json::to_vec(&policy).unwrap(),
        )
        .unwrap();
        let files = io::tree(&bundle, BUNDLE_FILES, BUNDLE_MAX).unwrap();
        let inspection = json!({"publication_schema":1,"authority":"none","index_sha256":sha(&index),"files":bundle::identities(&files),"definitions":[{"namespace":"official","stable_id":"fixture","revision":1,"definition_target":leaf_target,"policy_target":"policy/official/fixture.json","policy_schema":2,"policy_revision":1,"grant_id":"fixture-grant","launch_target":null,"launch_revision":null}],"scope":"inert-managed-definition-publication-inspection"});
        let manifest = json_file(root, "inspection.json", inspection);
        let top_bytes = fs::read(root.join("targets.json")).unwrap();
        let context = json_file(
            root,
            "context.json",
            appointed(
                json!({"schema_version":1,"generated_at":at,"trusted_root":"root.json","trusted_root_sha256":sha(&root_bytes),"offline_targets":"targets.json","offline_targets_sha256":sha(&top_bytes),"prepared_bundle":"bundle","inspection":"inspection.json","inspection_sha256":sha(&fs::read(manifest).unwrap()),"previous_repository":null,"versions":{"definitions":1,"policy":1,"snapshot":1,"timestamp":1},"expires":{"definitions":expires,"policy":expires,"snapshot":expires,"timestamp":expires}}),
            ),
        );
        let roles = root.join("roles");
        fs::create_dir(&roles).unwrap();
        Self {
            directory,
            context,
            roles,
        }
    }
    fn root(&self) -> &Path {
        self.directory.path()
    }
    fn sign_config(&self, role: DefinitionOnlineRole) -> PathBuf {
        let index = match role {
            DefinitionOnlineRole::Targets => 3,
            DefinitionOnlineRole::Definitions => 6,
            DefinitionOnlineRole::Policy => 7,
            DefinitionOnlineRole::Snapshot => 4,
            DefinitionOnlineRole::Timestamp => 5,
        };
        let mut value = json!({"schema_version":1,"context":"context.json","signing_key":format!("key-{index}/private.pk8"),"output":format!("{}/{}.json",self.roles.file_name().unwrap().to_str().unwrap(),role.name())});
        if matches!(
            role,
            DefinitionOnlineRole::Snapshot | DefinitionOnlineRole::Timestamp
        ) {
            value["signed_roles"] = json!(self.roles.file_name().unwrap().to_str().unwrap());
        }
        json_file(self.root(), &format!("{}-config.json", role.name()), value)
    }
    async fn sign_all(&self) {
        for role in [
            DefinitionOnlineRole::Definitions,
            DefinitionOnlineRole::Policy,
            DefinitionOnlineRole::Snapshot,
            DefinitionOnlineRole::Timestamp,
        ] {
            let report = sign_definition_role(role, &self.sign_config(role))
                .await
                .unwrap();
            assert_eq!(report.authority, "none");
        }
    }
    fn assembly(&self, output: &str) -> PathBuf {
        json_file(
            self.root(),
            "assembly.json",
            json!({"schema_version":1,"context":"context.json","signed_roles":self.roles.file_name().unwrap().to_str().unwrap(),"output":output}),
        )
    }
    fn context_value(&self) -> serde_json::Value {
        serde_json::from_slice(&fs::read(&self.context).unwrap()).unwrap()
    }
    fn set_context(&self, value: serde_json::Value) {
        fs::write(&self.context, serde_json::to_vec(&value).unwrap()).unwrap()
    }
}
#[tokio::test]
async fn appointed_single_owner_catalog_signs_assembles_and_verifies_without_implicit_downgrade() {
    let fixture = Fixture::new_with_profile(InitialRootProfile::SingleOwnerOneOfOneV1).await;
    let context = fixture.context_value();
    let mut implicit = context.clone();
    implicit
        .as_object_mut()
        .unwrap()
        .remove("initial_root_profile");
    fixture.set_context(implicit);
    assert!(
        sign_definition_role(
            DefinitionOnlineRole::Definitions,
            &fixture.sign_config(DefinitionOnlineRole::Definitions)
        )
        .await
        .is_err()
    );
    assert!(!fixture.roles.join("official-definitions.json").exists());
    fixture.set_context(context);
    fixture.sign_all().await;
    let assembled = assemble_definition_repository(&fixture.assembly("published"))
        .await
        .unwrap();
    let mut verification = json!({
        "schema_version":1,
        "trusted_root":"root.json","trusted_root_sha256":assembled.root_sha256,
        "offline_targets":"targets.json","offline_targets_sha256":assembled.offline_targets_sha256,
        "repository":"published"
    });
    let path = json_file(
        fixture.root(),
        "verify-single-owner.json",
        verification.clone(),
    );
    assert!(verify_definition_repository(&path).await.is_err());
    verification["initial_root_profile"] = json!(InitialRootProfile::SingleOwnerOneOfOneV1);
    json_file(fixture.root(), "verify-single-owner.json", verification);
    let verified = verify_definition_repository(&path).await.unwrap();
    assert_eq!(verified.repository_sha256, assembled.repository_sha256);
    assert!(!verified.changed);
}

#[tokio::test]
async fn catalog_four_isolated_roles_and_zero_key_assembly_have_exact_tough_readback() {
    let fixture = Fixture::new().await;
    fixture.sign_all().await;
    let config = fixture.assembly("repository");
    let report = assemble_definition_repository(&config).await.unwrap();
    assert!(report.changed);
    assert_eq!(report.authority, "none");
    assert_eq!(report.versions.len(), 5);
    assert!(report.versions.values().all(|v| v == "1"));
    assert_eq!(report.expires.len(), 5);
    assert_eq!(
        report.root_sha256,
        sha(&fs::read(fixture.root().join("root.json")).unwrap())
    );
    assert_eq!(
        report.offline_targets_sha256,
        sha(&fs::read(fixture.root().join("targets.json")).unwrap())
    );
    assert_eq!(
        report.timestamp_sha256,
        sha(&fs::read(fixture.roles.join("timestamp.json")).unwrap())
    );
    assert_eq!(
        report.snapshot_sha256,
        sha(&fs::read(fixture.roles.join("snapshot.json")).unwrap())
    );
    assert!(
        report
            .files
            .iter()
            .all(|v| !v.target.contains("application") && !v.target.contains("payload"))
    );
    assert!(
        !assemble_definition_repository(&config)
            .await
            .unwrap()
            .changed
    );
    // Assembly remains callable after all private keys are removed from its environment.
    for index in 0..8 {
        fs::rename(
            fixture.root().join(format!("key-{index}/private.pk8")),
            fixture.root().join(format!("retained-private-{index}.pk8")),
        )
        .unwrap();
    }
    assert!(
        !assemble_definition_repository(&config)
            .await
            .unwrap()
            .changed
    );
    let top: Signed<Targets> =
        serde_json::from_slice(&fs::read(fixture.root().join("targets.json")).unwrap()).unwrap();
    let roles = top.signed.delegations.unwrap().roles;
    assert_eq!(
        roles.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(),
        ["official-definitions", "official-policy"]
    );
}

#[tokio::test]
async fn catalog_online_targets_two_renewals_preserve_authority_history_and_require_explicit_prior()
{
    let mut fixture =
        Fixture::with_root_lifetime(InitialRootProfile::SingleOwnerOneOfOneV1, 300 * 86400).await;
    let original_context = fixture.context_value();
    let refused = sign_definition_role(
        DefinitionOnlineRole::Targets,
        &fixture.sign_config(DefinitionOnlineRole::Targets),
    )
    .await
    .unwrap_err();
    assert!(refused.to_string().contains("explicit online renewal"));
    let mut invalid = original_context.clone();
    invalid["top_level_targets_profile"] = json!("online-unchanged-authority-v1");
    fixture.set_context(invalid);
    assert!(
        sign_definition_role(
            DefinitionOnlineRole::Targets,
            &fixture.sign_config(DefinitionOnlineRole::Targets)
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("authenticated prior")
    );
    fixture.set_context(original_context.clone());
    fixture.sign_all().await;
    assemble_definition_repository(&fixture.assembly("generation-1"))
        .await
        .unwrap();
    let old_top = fs::read(fixture.root().join("generation-1/metadata/1.targets.json")).unwrap();
    let old_snapshot =
        fs::read(fixture.root().join("generation-1/metadata/1.snapshot.json")).unwrap();
    let start = original_context["generated_at"]
        .as_str()
        .unwrap()
        .parse::<Timestamp>()
        .unwrap();
    let mut base_top = "targets.json".to_owned();
    for version in 2..=3 {
        let mut context = original_context.clone();
        let at = start.checked_add(Duration::from_secs(version)).unwrap();
        context["generated_at"] = json!(at.to_string());
        context["top_level_targets_profile"] = json!("online-unchanged-authority-v1");
        context["previous_repository"] = json!(format!("generation-{}", version - 1));
        context["offline_targets"] = json!(base_top);
        context["offline_targets_sha256"] =
            json!(sha(&fs::read(fixture.root().join(&base_top)).unwrap()));
        for role in ["definitions", "policy", "snapshot", "timestamp"] {
            context["versions"][role] = json!(version);
            context["expires"][role] = json!(
                at.checked_add(Duration::from_secs(3600))
                    .unwrap()
                    .to_string()
            );
        }
        fixture.set_context(context);
        fixture.roles = fixture.root().join(format!("roles-{version}"));
        fs::create_dir(&fixture.roles).unwrap();
        sign_definition_role(
            DefinitionOnlineRole::Targets,
            &fixture.sign_config(DefinitionOnlineRole::Targets),
        )
        .await
        .unwrap();
        // A correctly signed but altered delegation is not a renewal.
        let top_path = fixture.roles.join("targets.json");
        let exact = fs::read(&top_path).unwrap();
        let mut changed: Signed<Targets> = serde_json::from_slice(&exact).unwrap();
        changed.signed.delegations.as_mut().unwrap().roles[0].terminating = false;
        let root: Signed<Root> =
            serde_json::from_slice(&fs::read(fixture.root().join("root.json")).unwrap()).unwrap();
        let private: Box<dyn tough::key_source::KeySource> =
            Box::new(tough::key_source::LocalKeySource {
                path: fixture.root().join("key-3/private.pk8"),
            });
        let signed = tough::editor::signed::SignedRole::new(
            changed.signed,
            &tough::schema::KeyHolder::Root(root.signed),
            &[private],
            &aws_lc_rs::rand::SystemRandom::new(),
        )
        .await
        .unwrap();
        fs::write(&top_path, signed.buffer()).unwrap();
        assert!(
            signing::roles(
                &load_context(&fixture.context).await.unwrap(),
                &fixture.roles,
                2
            )
            .unwrap_err()
            .to_string()
            .contains("delegation")
        );
        fs::write(&top_path, &exact).unwrap();
        fixture.sign_all().await;
        let output = format!("generation-{version}");
        let report = assemble_definition_repository(&fixture.assembly(&output))
            .await
            .unwrap();
        assert_eq!(report.versions["targets"], version.to_string());
        assert_eq!(report.offline_targets_sha256, sha(&exact));
        let readback = assemble_definition_repository(&fixture.assembly(&output))
            .await
            .unwrap();
        assert!(!readback.changed);
        assert_eq!(readback.repository_sha256, report.repository_sha256);
        assert_eq!(
            fs::read(fixture.root().join(&output).join("metadata/1.targets.json")).unwrap(),
            old_top
        );
        assert_eq!(
            fs::read(
                fixture
                    .root()
                    .join(&output)
                    .join("metadata/1.snapshot.json")
            )
            .unwrap(),
            old_snapshot
        );
        if version == 3 {
            assert_eq!(
                fs::read(fixture.root().join(&output).join("metadata/2.targets.json")).unwrap(),
                fs::read(fixture.root().join("generation-2/metadata/2.targets.json")).unwrap()
            );
        }
        base_top = format!("{output}/metadata/{version}.targets.json");
    }
}

#[tokio::test]
async fn catalog_read_only_public_verification_does_not_reopen_generation_or_keys() {
    let fixture = Fixture::new().await;
    fixture.sign_all().await;
    let assembled = assemble_definition_repository(&fixture.assembly("published"))
        .await
        .unwrap();
    let original = io::tree(&fixture.root().join("published"), 65536, 128 * 1024 * 1024).unwrap();
    let mut historical = fixture.context_value();
    historical["generated_at"] = json!(
        Timestamp::now()
            .checked_sub(Duration::from_secs(601))
            .unwrap()
            .to_string()
    );
    fixture.set_context(historical);
    assert!(
        assemble_definition_repository(&fixture.assembly("forbidden-reassembly"))
            .await
            .is_err()
    );
    assert!(!fixture.root().join("forbidden-reassembly").exists());
    for index in 0..8 {
        fs::remove_dir_all(fixture.root().join(format!("key-{index}"))).unwrap();
    }
    let config_value = json!({
        "schema_version":1,
        "trusted_root":"root.json",
        "trusted_root_sha256":assembled.root_sha256,
        "offline_targets":"targets.json",
        "offline_targets_sha256":assembled.offline_targets_sha256,
        "repository":"published"
    });
    let config = json_file(fixture.root(), "verify-public.json", config_value.clone());
    let verified = verify_definition_repository(&config).await.unwrap();
    assert!(!verified.changed);
    assert_eq!(verified.authority, "none");
    assert_eq!(verified.files, assembled.files);
    assert_eq!(verified.repository_sha256, assembled.repository_sha256);
    assert_eq!(verified.index_sha256, assembled.index_sha256);
    assert_eq!(verified.versions, assembled.versions);
    assert_eq!(verified.expires, assembled.expires);
    assert_eq!(
        io::tree(&fixture.root().join("published"), 65536, 128 * 1024 * 1024).unwrap(),
        original
    );
    for field in ["generated_at", "signing_key", "output"] {
        let mut changed = config_value.clone();
        changed[field] = json!("not-an-admitted-verification-input");
        let invalid = json_file(fixture.root(), "invalid-verify.json", changed);
        assert!(verify_definition_repository(&invalid).await.is_err());
    }
    let target = verified
        .files
        .iter()
        .find(|file| file.target.starts_with("targets/"))
        .unwrap();
    fs::write(
        fixture.root().join("published").join(&target.target),
        b"tampered",
    )
    .unwrap();
    assert!(verify_definition_repository(&config).await.is_err());
}
#[tokio::test]
async fn catalog_manifest_tamper_and_extra_file_refuse_before_missing_key_read() {
    let fixture = Fixture::new().await;
    let path = fixture.sign_config(DefinitionOnlineRole::Definitions);
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["signing_key"] = json!("never-present.pk8");
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    fs::write(
        fixture.root().join("bundle/private.pk8"),
        b"not a credential fixture",
    )
    .unwrap();
    let failure = sign_definition_role(DefinitionOnlineRole::Definitions, &path)
        .await
        .unwrap_err()
        .to_string();
    assert!(failure.contains("inspection differs"), "{failure}");
    assert!(!fixture.roles.join("official-definitions.json").exists());
}
#[tokio::test]
async fn catalog_wrong_role_key_and_changed_signed_role_refuse() {
    let fixture = Fixture::new().await;
    let path = fixture.sign_config(DefinitionOnlineRole::Definitions);
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["signing_key"] = json!("key-7/private.pk8");
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(
        sign_definition_role(DefinitionOnlineRole::Definitions, &path)
            .await
            .unwrap_err()
            .to_string()
            .contains("appointed")
    );
    fixture.sign_all().await;
    let target = fixture.roles.join("official-definitions.json");
    let mut signed: serde_json::Value =
        serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    signed["signed"]["version"] = json!(2);
    fs::write(target, serde_json::to_vec(&signed).unwrap()).unwrap();
    assert!(
        assemble_definition_repository(&fixture.assembly("refused"))
            .await
            .is_err()
    );
    assert!(!fixture.root().join("refused").exists());
}
#[tokio::test]
async fn catalog_prior_floor_expiry_and_equal_version_changed_content_refuse() {
    let fixture = Fixture::new().await;
    fixture.sign_all().await;
    assemble_definition_repository(&fixture.assembly("previous"))
        .await
        .unwrap();
    let mut context = fixture.context_value();
    context["previous_repository"] = json!("previous");
    context["versions"]["definitions"] = json!(0);
    fixture.set_context(context.clone());
    assert!(load_context(&fixture.context).await.is_err());
    context["versions"]["definitions"] = json!(1);
    context["expires"]["definitions"] = json!(
        Timestamp::now()
            .checked_add(Duration::from_secs(1800))
            .unwrap()
            .to_string()
    );
    fixture.set_context(context);
    let error = sign_definition_role(
        DefinitionOnlineRole::Definitions,
        &fixture.sign_config(DefinitionOnlineRole::Definitions),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("same-version"), "{error}");
    let mut context = fixture.context_value();
    context["expires"]["timestamp"] = json!(
        Timestamp::now()
            .checked_add(Duration::from_secs(86401))
            .unwrap()
            .to_string()
    );
    fixture.set_context(context);
    assert!(load_context(&fixture.context).await.is_err());
}
#[tokio::test]
async fn catalog_output_never_overwrites_and_existing_assembly_remains_exact() {
    let fixture = Fixture::new().await;
    fixture.sign_all().await;
    fs::write(fixture.root().join("collision"), b"retain original").unwrap();
    assert!(
        assemble_definition_repository(&fixture.assembly("collision"))
            .await
            .is_err()
    );
    assert_eq!(
        fs::read(fixture.root().join("collision")).unwrap(),
        b"retain original"
    );
    let mut context = fixture.context_value();
    context
        .as_object_mut()
        .unwrap()
        .remove("previous_repository");
    fixture.set_context(context);
    assert!(load_context(&fixture.context).await.is_err());
}
#[test]
fn catalog_role_parser_rejects_application_roles_and_public_paths_refuse_traversal() {
    for role in [
        "releases",
        "preview",
        "stable",
        "root",
        "official-definitions/../root",
    ] {
        assert!(DefinitionOnlineRole::parse(role).is_err());
    }
    for value in [
        "../private",
        "application/../metadata",
        "keys/payload.json\\secret",
        "/absolute",
        "policy/official/a.json:stream",
    ] {
        assert!(io::relative(value).is_err());
    }
}

#[tokio::test]
async fn authenticated_catalog_prior_advances_without_erasing_immutable_history() {
    let mut fixture = Fixture::new().await;
    fixture.sign_all().await;
    let first = assemble_definition_repository(&fixture.assembly("generation-one"))
        .await
        .unwrap();
    let mut context = fixture.context_value();
    context["previous_repository"] = json!("generation-one");
    for role in ["definitions", "policy", "snapshot", "timestamp"] {
        context["versions"][role] = json!(2);
    }
    fixture.set_context(context);
    fixture.roles = fixture.root().join("roles-two");
    fs::create_dir(&fixture.roles).unwrap();
    fixture.sign_all().await;
    let next = assemble_definition_repository(&fixture.assembly("generation-two"))
        .await
        .unwrap();
    let files = next
        .files
        .iter()
        .map(|v| v.target.as_str())
        .collect::<BTreeSet<_>>();
    for old in first
        .files
        .iter()
        .filter(|v| v.target != "metadata/timestamp.json")
    {
        assert!(files.contains(old.target.as_str()));
    }
    assert!(files.contains("metadata/2.snapshot.json"));
    assert!(files.contains("metadata/1.snapshot.json"));
    assert_ne!(first.repository_sha256, next.repository_sha256);
}

#[tokio::test]
async fn physical_root_key_alias_cannot_supply_a_second_catalog_quorum_member() {
    use aws_lc_rs::signature::Ed25519KeyPair;
    use tough::schema::Role;
    let fixture = Fixture::new().await;
    let mut root: Signed<Root> =
        serde_json::from_slice(&fs::read(fixture.root().join("root.json")).unwrap()).unwrap();
    let original = root.signed.roles[&tough::schema::RoleType::Root].keyids[0].clone();
    let removed = root.signed.roles[&tough::schema::RoleType::Root].keyids[1].clone();
    let mut alias = serde_json::to_value(&root.signed.keys[&original]).unwrap();
    alias["alias"] = json!("same physical key, different TUF id");
    let alias: tough::schema::key::Key = serde_json::from_value(alias).unwrap();
    let alias_id = alias.key_id().unwrap();
    assert_ne!(original, alias_id);
    root.signed.keys.remove(&removed);
    root.signed.keys.insert(alias_id.clone(), alias);
    root.signed
        .roles
        .get_mut(&tough::schema::RoleType::Root)
        .unwrap()
        .keyids[1] = alias_id.clone();
    let key =
        Ed25519KeyPair::from_pkcs8(&fs::read(fixture.root().join("key-0/private.pk8")).unwrap())
            .unwrap();
    let sig = hex::encode(key.sign(&root.signed.canonical_form().unwrap()).as_ref());
    root.signatures=serde_json::from_value(json!([{"keyid":hex::encode(original.as_ref()),"sig":sig},{"keyid":hex::encode(alias_id.as_ref()),"sig":sig}])).unwrap();
    // Control: ordinary signature verification sees two distinct valid TUF IDs.
    root.signed.verify_role(&root).unwrap();
    let error = policy::root(
        &root,
        Timestamp::now(),
        InitialRootProfile::LegacyTwoOfThreeV1,
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("without aliases"), "{error}");
}
#[tokio::test]
async fn physical_delegated_key_alias_cannot_cross_catalog_roles() {
    use tough::{
        editor::signed::SignedRole,
        key_source::LocalKeySource,
        schema::{KeyHolder, RoleType},
    };
    let fixture = Fixture::new().await;
    let root: Signed<Root> =
        serde_json::from_slice(&fs::read(fixture.root().join("root.json")).unwrap()).unwrap();
    let mut top: Signed<Targets> =
        serde_json::from_slice(&fs::read(fixture.root().join("targets.json")).unwrap()).unwrap();
    let d = top.signed.delegations.as_mut().unwrap();
    let original = d.roles[0].keyids[0].clone();
    let removed = d.roles[1].keyids[0].clone();
    let mut alias = serde_json::to_value(&d.keys[&original]).unwrap();
    alias["keyval"]["alias"] = json!("cross-role same physical key");
    let alias: tough::schema::key::Key = serde_json::from_value(alias).unwrap();
    let alias_id = alias.key_id().unwrap();
    assert_ne!(original, alias_id);
    d.keys.remove(&removed);
    d.keys.insert(alias_id.clone(), alias);
    d.roles[1].keyids = vec![alias_id];
    let signed = SignedRole::new(
        top.signed,
        &KeyHolder::Root(root.signed.clone()),
        &[Box::new(LocalKeySource {
            path: fixture.root().join("key-3/private.pk8"),
        }) as Box<dyn tough::key_source::KeySource>],
        &aws_lc_rs::rand::SystemRandom::new(),
    )
    .await
    .unwrap();
    root.signed.verify_role(signed.signed()).unwrap();
    assert_eq!(
        signed.signed().signatures[0].keyid,
        root.signed.roles[&RoleType::Targets].keyids[0]
    );
    let error = policy::top(&root.signed, signed.signed(), Timestamp::now())
        .unwrap_err()
        .to_string();
    assert!(error.contains("without aliases"), "{error}");
}
#[tokio::test]
async fn same_version_valid_offline_targets_reencoding_preserves_prior_history() {
    let fixture = Fixture::new().await;
    fixture.sign_all().await;
    assemble_definition_repository(&fixture.assembly("original-repository"))
        .await
        .unwrap();
    let original = fs::read(
        fixture
            .root()
            .join("original-repository/metadata/1.targets.json"),
    )
    .unwrap();
    let mut reencoded = original.clone();
    reencoded.extend_from_slice(b" \n");
    let parsed: Signed<Targets> = serde_json::from_slice(&reencoded).unwrap();
    let root: Signed<Root> =
        serde_json::from_slice(&fs::read(fixture.root().join("root.json")).unwrap()).unwrap();
    root.signed.verify_role(&parsed).unwrap();
    fs::write(fixture.root().join("targets.json"), &reencoded).unwrap();
    let mut context = fixture.context_value();
    context["offline_targets_sha256"] = json!(sha(&reencoded));
    context["previous_repository"] = json!("original-repository");
    fixture.set_context(context);
    let error = load_context(&fixture.context)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("raw envelope replacement"), "{error}");
    assert_eq!(
        fs::read(
            fixture
                .root()
                .join("original-repository/metadata/1.targets.json")
        )
        .unwrap(),
        original
    );
}

fn replace_bundle_revision(fixture: &Fixture, revision: u64) {
    let bundle = fixture.root().join("bundle");
    let mut index: serde_json::Value =
        serde_json::from_slice(&fs::read(bundle.join("definitions/index.json")).unwrap()).unwrap();
    index["definitions"][0]["revision"] = json!(revision);
    let index = serde_json::to_vec(&index).unwrap();
    fs::write(bundle.join("definitions/index.json"), &index).unwrap();
    let policy_path = bundle.join("policy/official/fixture.json");
    let mut policy: serde_json::Value =
        serde_json::from_slice(&fs::read(&policy_path).unwrap()).unwrap();
    policy["policy_revision"] = json!(revision);
    policy["decision"]["definition_revision"] = json!(revision);
    policy["decision"]["index_sha256"] = json!(sha(&index));
    fs::write(policy_path, serde_json::to_vec(&policy).unwrap()).unwrap();
    let mut report: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.root().join("inspection.json")).unwrap()).unwrap();
    report["index_sha256"] = json!(sha(&index));
    report["definitions"][0]["revision"] = json!(revision);
    report["definitions"][0]["policy_revision"] = json!(revision);
    report["files"] = serde_json::to_value(bundle::identities(
        &io::tree(&bundle, BUNDLE_FILES, BUNDLE_MAX).unwrap(),
    ))
    .unwrap();
    let raw = serde_json::to_vec(&report).unwrap();
    fs::write(fixture.root().join("inspection.json"), &raw).unwrap();
    let mut context = fixture.context_value();
    context["inspection_sha256"] = json!(sha(&raw));
    fixture.set_context(context);
}
#[tokio::test]
async fn deletion_then_reintroduction_cannot_erase_authenticated_catalog_revision_floor() {
    let mut fixture = Fixture::new().await;
    replace_bundle_revision(&fixture, 5);
    let original_bundle =
        io::tree(&fixture.root().join("bundle"), BUNDLE_FILES, BUNDLE_MAX).unwrap();
    let original_manifest = fs::read(fixture.root().join("inspection.json")).unwrap();
    fixture.sign_all().await;
    assemble_definition_repository(&fixture.assembly("revision-five"))
        .await
        .unwrap();
    for name in original_bundle.keys() {
        fs::remove_file(fixture.root().join("bundle").join(name)).unwrap();
    }
    let empty_index =
        serde_json::to_vec(&json!({"index_schema":1,"definitions":[],"contents":[]})).unwrap();
    fs::write(
        fixture.root().join("bundle/definitions/index.json"),
        &empty_index,
    )
    .unwrap();
    let files = io::tree(&fixture.root().join("bundle"), BUNDLE_FILES, BUNDLE_MAX).unwrap();
    let empty_manifest=serde_json::to_vec(&json!({"publication_schema":1,"authority":"none","index_sha256":sha(&empty_index),"files":bundle::identities(&files),"definitions":[],"scope":"inert-managed-definition-publication-inspection"})).unwrap();
    fs::write(fixture.root().join("inspection.json"), &empty_manifest).unwrap();
    let mut context = fixture.context_value();
    context["inspection_sha256"] = json!(sha(&empty_manifest));
    context["previous_repository"] = json!("revision-five");
    for role in ["definitions", "policy", "snapshot", "timestamp"] {
        context["versions"][role] = json!(2);
    }
    fixture.set_context(context);
    fixture.roles = fixture.root().join("roles-empty");
    fs::create_dir(&fixture.roles).unwrap();
    fixture.sign_all().await;
    assemble_definition_repository(&fixture.assembly("removed-current"))
        .await
        .unwrap();
    for (name, bytes) in original_bundle {
        fs::write(fixture.root().join("bundle").join(name), bytes).unwrap();
    }
    fs::write(fixture.root().join("inspection.json"), original_manifest).unwrap();
    replace_bundle_revision(&fixture, 1);
    let mut context = fixture.context_value();
    context["previous_repository"] = json!("removed-current");
    for role in ["definitions", "policy", "snapshot", "timestamp"] {
        context["versions"][role] = json!(3);
    }
    fixture.set_context(context);
    let failure = load_context(&fixture.context)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        failure.contains("historical definition revision rollback"),
        "{failure}"
    );
    assert!(!fixture.root().join("reintroduced").exists());
}

fn replace_listing_directory(fixture: &Fixture, revision: u64) {
    let target = "policy/official/catalog.listings.json";
    let listings = (0..40).map(|index| json!({"id":format!("listing-{index}"),"name":format!("Listing {index} revision {revision}"),"summary":"x".repeat(2000),"project_url":"https://example.invalid/project","availability":"source-only"})).collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&json!({"listing_delivery_schema":1,"revision":revision,"withdrawn_ids":[],"directory":{"format_version":1,"listings":listings}})).unwrap();
    assert!(bytes.len() > 65536);
    fs::write(fixture.root().join("bundle").join(target), &bytes).unwrap();
    let files = io::tree(&fixture.root().join("bundle"), BUNDLE_FILES, BUNDLE_MAX).unwrap();
    let mut report: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.root().join("inspection.json")).unwrap()).unwrap();
    report["publication_schema"] = json!(2);
    report["scope"] = json!("inert-catalog-publication-inspection");
    report["listings"] = json!({"target":target,"revision":revision,"sha256":sha(&bytes),"listing_count":40,"withdrawn_count":0});
    report["files"] = json!(bundle::identities(&files));
    let report = serde_json::to_vec(&report).unwrap();
    fs::write(fixture.root().join("inspection.json"), &report).unwrap();
    let mut context = fixture.context_value();
    context["inspection_sha256"] = json!(sha(&report));
    fixture.set_context(context);
}

#[tokio::test]
async fn descriptive_directory_large_targets_correct_and_read_back_without_revision_reset() {
    let mut fixture = Fixture::new().await;
    replace_listing_directory(&fixture, 1);
    fixture.sign_all().await;
    assemble_definition_repository(&fixture.assembly("listing-first"))
        .await
        .unwrap();
    replace_listing_directory(&fixture, 2);
    let mut context = fixture.context_value();
    context["previous_repository"] = json!("listing-first");
    for role in ["definitions", "policy", "snapshot", "timestamp"] {
        context["versions"][role] = json!(2);
    }
    fixture.set_context(context);
    fixture.roles = fixture.root().join("listing-roles-two");
    fs::create_dir(&fixture.roles).unwrap();
    fixture.sign_all().await;
    assemble_definition_repository(&fixture.assembly("listing-second"))
        .await
        .unwrap();
    replace_listing_directory(&fixture, 1);
    let mut context = fixture.context_value();
    context["previous_repository"] = json!("listing-second");
    for role in ["definitions", "policy", "snapshot", "timestamp"] {
        context["versions"][role] = json!(3);
    }
    fixture.set_context(context);
    let failure = load_context(&fixture.context)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        failure.contains("historical policy/launch rollback"),
        "{failure}"
    );
}

#[tokio::test]
async fn descriptive_inspection_rejects_extra_or_false_summaries() {
    let fixture = Fixture::new().await;
    replace_listing_directory(&fixture, 1);
    let manifest = fs::read(fixture.root().join("inspection.json")).unwrap();
    let report: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
    for (field, value) in [
        ("sha256", json!("0".repeat(64))),
        ("listing_count", json!(39)),
        ("operations", json!(["install"])),
    ] {
        let mut changed = report.clone();
        changed["listings"][field] = value;
        assert!(
            bundle::inspect(
                &fixture.root().join("bundle"),
                &serde_json::to_vec(&changed).unwrap()
            )
            .is_err()
        );
    }
}
