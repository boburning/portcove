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
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let at = Timestamp::now().to_string();
        let expires = Timestamp::now()
            .checked_add(Duration::from_secs(3600))
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
            json!({"schema_version":1,"generated_at":at,"expires":expires,"root_public_keys":public[..3],"targets_public_key":public[3],"snapshot_public_key":public[4],"timestamp_public_key":public[5],"output":"root-unsigned.json"}),
        );
        let proposal = offline::prepare_initial_root(&prepare).unwrap();
        let mut previous = "root-unsigned.json".to_owned();
        for index in 0..2 {
            let output = format!("root-signed-{index}.json");
            let config = json_file(
                root,
                &format!("root-sign-{index}.json"),
                json!({"schema_version":1,"generated_at":at,"root":previous,"signed_body_sha256":proposal.signed_body_sha256,"signing_key":format!("key-{index}/private.pk8"),"output":output}),
            );
            offline::sign_initial_root(&config).await.unwrap();
            previous = output;
        }
        let config = json_file(
            root,
            "final-root.json",
            json!({"schema_version":1,"generated_at":at,"root":previous,"signed_body_sha256":proposal.signed_body_sha256,"output":"root.json"}),
        );
        offline::finalize_initial_root(&config).unwrap();
        let root_bytes = fs::read(root.join("root.json")).unwrap();
        let top_config = json_file(
            root,
            "top-config.json",
            json!({"schema_version":1,"generated_at":at,"trusted_root":"root.json","trusted_root_sha256":sha(&root_bytes),"delegated_public_keys":{"definitions":public[6],"policy":public[7]},"version":1,"expires":expires,"signing_key":"key-3/private.pk8","output":"targets.json"}),
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
            json!({"schema_version":1,"generated_at":at,"trusted_root":"root.json","trusted_root_sha256":sha(&root_bytes),"offline_targets":"targets.json","offline_targets_sha256":sha(&top_bytes),"prepared_bundle":"bundle","inspection":"inspection.json","inspection_sha256":sha(&fs::read(manifest).unwrap()),"previous_repository":null,"versions":{"definitions":1,"policy":1,"snapshot":1,"timestamp":1},"expires":{"definitions":expires,"policy":expires,"snapshot":expires,"timestamp":expires}}),
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
        "targets",
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
    let error = policy::root(&root, Timestamp::now())
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
