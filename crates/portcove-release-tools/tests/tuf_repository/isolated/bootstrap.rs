use super::*;

async fn initial_fixture() -> (Fixture, serde_json::Value) {
    let mut fixture = Fixture::new(false).await;
    let root = fixture.root();
    fs::copy(
        root.join("seed/metadata/1.targets.json"),
        root.join("offline-targets.json"),
    )
    .unwrap();
    fs::remove_dir_all(root.join("seed")).unwrap();
    fs::remove_dir_all(root.join("records")).unwrap();
    fs::create_dir(root.join("records")).unwrap();
    write_json(
        &root.join("records/reconstruction-manifest.json"),
        &json!({"schema_version":1,"records":[]}),
    );
    fixture
        .context
        .as_object_mut()
        .unwrap()
        .remove("previous_repository");
    fixture.context["offline_targets"] = json!("offline-targets.json");
    fixture.context["initial_bootstrap"] = json!("initial-bootstrap.json");
    for role in ["snapshot", "timestamp", "releases", "preview", "stable"] {
        fixture.context["versions"][role] = json!(1);
    }
    let versions: serde_json::Map<String, serde_json::Value> = fixture.context["versions"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.clone(), json!(value.as_u64().unwrap().to_string())))
        .collect();
    let descriptor = json!({
        "schema_version":1,"kind":"application-tuf-initial-bootstrap",
        "generated_at":fixture.context["generated_at"],
        "setup_plan_sha256":"1".repeat(64),"initial_site_preimage_sha256":"2".repeat(64),
        "root_sha256":sha256(&fs::read(fixture.root().join("trusted-root.json")).unwrap()),
        "offline_targets_sha256":sha256(&fs::read(fixture.root().join("offline-targets.json")).unwrap()),
        "payload_key_registry_sha256":sha256(&fs::read(fixture.root().join("payload.json")).unwrap()),
        "initial_records_sha256":sha256(b"[]"),"versions":versions,"expires":fixture.context["expires"],
    });
    write_json(&fixture.root().join("initial-bootstrap.json"), &descriptor);
    fixture.save_context();
    (fixture, descriptor)
}

#[tokio::test]
async fn initial_empty_feed_uses_only_offline_public_anchors_and_separate_online_roles() {
    let (fixture, _) = initial_fixture().await;
    assert!(!fixture.root().join("seed").exists());
    fixture.sign_all().await;
    let result = assemble_tuf_repository(&fixture.assembly_config())
        .await
        .unwrap();
    assert_eq!(result.records, 0);
    assert_eq!(result.publication.records_sha256, sha256(b"[]"));
    for role in ["snapshot", "timestamp", "releases", "preview", "stable"] {
        assert_eq!(result.publication.versions[role], "1");
    }
    let repository = RepositoryLoader::new(
        &fs::read(fixture.root().join("trusted-root.json")).unwrap(),
        Url::from_directory_path(result.output.join("metadata")).unwrap(),
        Url::from_directory_path(result.output.join("targets")).unwrap(),
    )
    .load()
    .await
    .unwrap();
    for name in [
        "releases/1.0.0/windows-x86_64/nsis.json",
        "channels/stable/windows-x86_64/nsis.json",
    ] {
        assert!(
            repository
                .read_target(&TargetName::new(name).unwrap())
                .await
                .unwrap()
                .is_none()
        );
    }
    assert_eq!(
        fs::read(result.output.join("metadata/1.targets.json")).unwrap(),
        fs::read(fixture.root().join("offline-targets.json")).unwrap()
    );
    assert!(
        !assemble_tuf_repository(&fixture.assembly_config())
            .await
            .unwrap()
            .changed
    );
    write_json(
        &fixture.root().join("renew-empty.json"),
        &json!({
            "schema_version":1,"generated_at":Timestamp::now().to_string(),
            "trusted_root":"trusted-root.json","previous_repository":"assembled","output":"renewed-empty",
        }),
    );
    let renewed = portcove_release_tools::tuf_repository::isolated::prepare_tuf_renewal(
        &fixture.root().join("renew-empty.json"),
    )
    .await
    .unwrap();
    let context: serde_json::Value =
        serde_json::from_slice(&fs::read(renewed.output.join("context.json")).unwrap()).unwrap();
    assert_eq!(context["versions"]["timestamp"], 2);
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(renewed.output.join("records/reconstruction-manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["records"], json!([]));
    if let Some(output) = std::env::var_os("PORTCOVE_TUF_INITIAL_QUALIFICATION_OUTPUT") {
        let output = PathBuf::from(output);
        assert!(output.is_absolute());
        fs::create_dir(&output).expect("initial public fixture export must be fresh");
        for name in [
            "context.json",
            "trusted-root.json",
            "offline-targets.json",
            "payload.json",
            "initial-bootstrap.json",
        ] {
            fs::copy(fixture.root().join(name), output.join(name)).unwrap();
        }
        for name in ["records", "envelopes"] {
            copy_public_fixture(&fixture.root().join(name), &output.join(name));
        }
        assert!(!output.join("jobs").exists());
        assert!(!output.join("seed").exists());
    }
}

#[tokio::test]
async fn initial_context_refuses_mixed_prior_missing_descriptor_and_nonempty_records() {
    let (mut fixture, descriptor) = initial_fixture().await;
    let clean = fixture.context.clone();
    for mutation in ["both", "neither", "missing", "records", "unlisted"] {
        fixture.context = clean.clone();
        match mutation {
            "both" => fixture.context["previous_repository"] = json!("not-a-prior"),
            "neither" => {
                fixture
                    .context
                    .as_object_mut()
                    .unwrap()
                    .remove("initial_bootstrap");
            }
            "missing" => fixture.context["initial_bootstrap"] = json!("missing.json"),
            "records" => {
                write_records(&fixture.root().join("records"));
            }
            "unlisted" => {
                fs::write(fixture.root().join("records/extra.json"), b"{}").unwrap();
            }
            _ => unreachable!(),
        }
        fixture.save_context();
        assert!(
            fixture.sign_with("releases", "releases").await.is_err(),
            "{mutation}"
        );
        fs::remove_dir_all(fixture.root().join("records")).unwrap();
        fs::create_dir(fixture.root().join("records")).unwrap();
        write_json(
            &fixture.root().join("records/reconstruction-manifest.json"),
            &json!({"schema_version":1,"records":[]}),
        );
        write_json(&fixture.root().join("initial-bootstrap.json"), &descriptor);
    }
}

#[tokio::test]
async fn routine_empty_records_cannot_erase_an_authenticated_historical_release() {
    let fixture = Fixture::new(false).await;
    let manifest = fixture.root().join("seed/repository-manifest.json");
    let retained = fs::read(&manifest).unwrap();
    fs::remove_dir_all(fixture.root().join("records")).unwrap();
    fs::create_dir(fixture.root().join("records")).unwrap();
    write_json(
        &fixture.root().join("records/reconstruction-manifest.json"),
        &json!({"schema_version":1,"records":[]}),
    );
    assert!(fixture.sign_with("releases", "releases").await.is_err());
    assert_eq!(fs::read(manifest).unwrap(), retained);
    assert!(!fixture.root().join("jobs/releases/role.json").exists());
}

#[tokio::test]
async fn initial_descriptor_binds_all_public_facts_and_first_generation_before_signing() {
    let (fixture, descriptor) = initial_fixture().await;
    for field in [
        "root_sha256",
        "offline_targets_sha256",
        "payload_key_registry_sha256",
        "initial_records_sha256",
        "generated_at",
        "versions",
        "expires",
        "setup_plan_sha256",
        "initial_site_preimage_sha256",
    ] {
        let mut changed = descriptor.clone();
        match field {
            "versions" => changed[field]["timestamp"] = json!("2"),
            "expires" => changed[field]["timestamp"] = json!("2099-01-01T00:00:00Z"),
            "generated_at" => changed[field] = json!("2020-01-01T00:00:00Z"),
            "setup_plan_sha256" | "initial_site_preimage_sha256" => {
                changed[field] = json!("invalid")
            }
            _ => changed[field] = json!("0".repeat(64)),
        }
        write_json(&fixture.root().join("initial-bootstrap.json"), &changed);
        assert!(
            fixture.sign_with("releases", "releases").await.is_err(),
            "{field}"
        );
    }
    write_json(&fixture.root().join("initial-bootstrap.json"), &descriptor);
    assert!(fixture.sign_with("releases", "snapshot").await.is_err());
    assert!(fixture.sign_with("releases", "releases").await.is_ok());
}
