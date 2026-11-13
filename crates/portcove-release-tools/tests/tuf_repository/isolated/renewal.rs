use super::*;
use portcove_release_tools::tuf_repository::isolated::prepare_tuf_renewal;

fn renewal_config(fixture: &Fixture, output: &str) -> PathBuf {
    let path = fixture.root().join(format!("{output}.json"));
    write_json(
        &path,
        &json!({"schema_version":1,"generated_at":Timestamp::now().to_string(),"trusted_root":"trusted-root.json","previous_repository":"seed","output":output}),
    );
    path
}

#[tokio::test]
async fn public_only_renewal_authenticates_feed_and_drives_existing_isolated_role_jobs() {
    let fixture = Fixture::new(false).await;
    // The public Pages component deliberately has no internal artifact manifest.
    fs::remove_file(fixture.root().join("seed/repository-manifest.json")).unwrap();
    let config = renewal_config(&fixture, "prepared");
    let prepared = prepare_tuf_renewal(&config).await.unwrap();
    assert_eq!(prepared.authority, "none");
    assert!(prepared.changed);
    assert!(!prepare_tuf_renewal(&config).await.unwrap().changed);
    let descriptor: serde_json::Value =
        serde_json::from_slice(&fs::read(prepared.output.join("renewal.json")).unwrap()).unwrap();
    let mut canonical = descriptor.clone();
    canonical.sort_all_objects();
    assert_eq!(
        prepared.descriptor_sha256,
        sha256(&serde_json::to_vec(&canonical).unwrap())
    );
    for role in ["snapshot", "timestamp", "releases", "preview", "stable"] {
        assert_eq!(descriptor["current_versions"][role], "1");
        assert_eq!(descriptor["next_versions"][role], "2");
        assert!(
            descriptor["next_expires"][role]
                .as_str()
                .unwrap()
                .parse::<Timestamp>()
                .unwrap()
                > descriptor["current_expires"][role]
                    .as_str()
                    .unwrap()
                    .parse::<Timestamp>()
                    .unwrap()
        );
    }
    assert_eq!(
        descriptor["current_versions"]["targets"],
        descriptor["next_versions"]["targets"]
    );
    assert_eq!(
        descriptor["current_expires"]["targets"],
        descriptor["next_expires"]["targets"]
    );
    let envelopes = fixture.root().join("renewal-envelopes");
    fs::create_dir(&envelopes).unwrap();
    for role in ["releases", "preview", "stable", "snapshot", "timestamp"] {
        let job = fixture.root().join(format!("renewal-{role}"));
        fs::create_dir(&job).unwrap();
        let private = job.join("key.der");
        fs::write(&private, &fixture.keys[role]).unwrap();
        let mut config = json!({"schema_version":1,"context":"../prepared/context.json","signing_key":"key.der","output":"role.json"});
        if ["snapshot", "timestamp"].contains(&role) {
            config["signed_roles"] = json!("../renewal-envelopes");
        }
        write_json(&job.join("config.json"), &config);
        let signed =
            sign_tuf_role(OnlineRole::parse(role).unwrap(), &job.join("config.json")).await;
        fs::remove_file(private).unwrap();
        fs::copy(
            signed.unwrap().output,
            envelopes.join(format!("{role}.json")),
        )
        .unwrap();
    }
    let assembly = fixture.root().join("renewal-assembly.json");
    write_json(
        &assembly,
        &json!({"schema_version":1,"context":"prepared/context.json","signed_roles":"renewal-envelopes","output":"renewed"}),
    );
    let result = assemble_tuf_repository(&assembly).await.unwrap();
    assert_eq!(result.records, 2);
    let publication = serde_json::to_value(&result.publication).unwrap();
    assert_eq!(publication["root_sha256"], descriptor["root_sha256"]);
    assert_eq!(
        publication["offline_targets_sha256"],
        descriptor["offline_targets_sha256"]
    );
    assert_eq!(publication["versions"], descriptor["next_versions"]);
    assert_eq!(publication["expires"], descriptor["next_expires"]);
    assert_eq!(
        publication["records_sha256"],
        descriptor["unchanged_records_sha256"]
    );
    assert_ne!(
        publication["repository_sha256"],
        descriptor["prior_repository_sha256"]
    );
    let inventory: Vec<_> = result
        .files
        .iter()
        .filter(|file| file.path != "repository-manifest.json")
        .map(|file| {
            let bytes = fs::read(result.output.join(&file.path)).unwrap();
            assert_eq!(file.sha256, sha256(&bytes));
            json!({"path":file.path,"bytes":bytes.len(),"sha256":sha256(&bytes)})
        })
        .collect();
    let mut canonical = serde_json::to_value(inventory).unwrap();
    canonical.sort_all_objects();
    assert_eq!(
        publication["repository_sha256"],
        sha256(&serde_json::to_vec(&canonical).unwrap())
    );
    let root: tough::schema::Signed<Root> =
        serde_json::from_slice(&fs::read(fixture.root().join("trusted-root.json")).unwrap())
            .unwrap();
    assert_eq!(
        fs::read(
            result
                .output
                .join(format!("metadata/{}.root.json", root.signed.version))
        )
        .unwrap(),
        fs::read(fixture.root().join("trusted-root.json")).unwrap()
    );
    let stable: serde_json::Value =
        serde_json::from_slice(&fs::read(result.output.join("metadata/2.stable.json")).unwrap())
            .unwrap();
    assert!(stable["signed"]["targets"].as_object().unwrap().is_empty());
    let cli = std::process::Command::new(release_tools_binary())
        .arg("prepare-tuf-renewal")
        .arg(config)
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
    if let Some(output) = std::env::var_os("PORTCOVE_TUF_RENEWAL_QUALIFICATION_OUTPUT") {
        let output = PathBuf::from(output);
        assert!(output.is_absolute());
        fs::create_dir(&output).expect("renewal export must be fresh");
        for name in [
            "context.json",
            "renewal.json",
            "trusted-root.json",
            "offline-targets.json",
            "payload.json",
        ] {
            fs::copy(prepared.output.join(name), output.join(name)).unwrap();
        }
        for name in ["prior", "records"] {
            copy_public_fixture(&prepared.output.join(name), &output.join(name));
        }
        copy_public_fixture(&envelopes, &output.join("envelopes"));
    }
}

#[tokio::test]
async fn renewal_refuses_untrusted_or_expired_prior_state_extra_configuration_and_changed_retry() {
    let fixture = Fixture::new(false).await;
    let config = renewal_config(&fixture, "prepared");
    let prepared = prepare_tuf_renewal(&config).await.unwrap();
    fs::write(prepared.output.join("records/unexpected.json"), "{}").unwrap();
    assert!(prepare_tuf_renewal(&config).await.is_err());
    let bad = fixture.root().join("bad-config.json");
    write_json(
        &bad,
        &json!({"schema_version":1,"generated_at":Timestamp::now().to_string(),"trusted_root":"trusted-root.json","previous_repository":"seed","output":"never","signing_key":"never-read"}),
    );
    assert!(
        prepare_tuf_renewal(&bad)
            .await
            .unwrap_err()
            .to_string()
            .contains("unknown field")
    );
    assert!(!fixture.root().join("never").exists());
    let path = fixture.root().join("seed/metadata/timestamp.json");
    let root: tough::schema::Signed<Root> =
        serde_json::from_slice(&fs::read(fixture.root().join("trusted-root.json")).unwrap())
            .unwrap();
    let mut timestamp: tough::schema::Signed<tough::schema::Timestamp> =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    timestamp.signed.expires = Timestamp::now()
        .checked_sub(Duration::from_secs(60))
        .unwrap();
    let signed = sign_fixture_role(
        &fixture,
        "timestamp",
        timestamp.signed,
        &KeyHolder::Root(root.signed),
    )
    .await;
    fs::write(path, signed).unwrap();
    let expired_config = renewal_config(&fixture, "expired");
    let error = prepare_tuf_renewal(&expired_config).await.unwrap_err();
    assert!(matches!(error, TufRepositoryError::Tough(_)), "{error}");
    assert!(!fixture.root().join("expired").exists());
}

async fn expire_prior_timestamp(fixture: &Fixture) {
    let root: tough::schema::Signed<Root> =
        serde_json::from_slice(&fs::read(fixture.root().join("trusted-root.json")).unwrap())
            .unwrap();
    let path = fixture.root().join("seed/metadata/timestamp.json");
    let mut timestamp: tough::schema::Signed<tough::schema::Timestamp> =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    timestamp.signed.expires = Timestamp::now()
        .checked_sub(Duration::from_secs(60))
        .unwrap();
    fs::write(
        path,
        sign_fixture_role(
            fixture,
            "timestamp",
            timestamp.signed,
            &KeyHolder::Root(root.signed),
        )
        .await,
    )
    .unwrap();
}

#[tokio::test]
async fn historical_online_expiry_requires_explicit_policy_and_produces_safe_fresh_repository() {
    let fixture = Fixture::with_profile(false, true).await;
    expire_prior_timestamp(&fixture).await;
    fs::remove_file(fixture.root().join("seed/repository-manifest.json")).unwrap();
    let config = renewal_config(&fixture, "historical");
    let mut request: serde_json::Value =
        serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    request["initial_root_profile"] = json!("single-owner-one-of-one-v1");
    write_json(&config, &request);
    assert!(matches!(
        prepare_tuf_renewal(&config).await.unwrap_err(),
        TufRepositoryError::Tough(_)
    ));
    assert!(!fixture.root().join("historical").exists());
    request["prior_expiration_policy"] = json!("historical-online-expired-v1");
    request["previous_reserved_versions"] = json!({"targets":1,"snapshot":9007199254740993_u64,"timestamp":9007199254740993_u64,"releases":9007199254740993_u64,"preview":9007199254740993_u64,"stable":9007199254740993_u64});
    write_json(&config, &request);
    let prepared = prepare_tuf_renewal(&config).await.unwrap();
    if let Some(output) = std::env::var_os("PORTCOVE_TUF_HISTORICAL_QUALIFICATION_OUTPUT") {
        let output = PathBuf::from(output);
        assert!(output.is_absolute());
        fs::create_dir(&output).expect("historical public export must be fresh");
        fs::copy(
            fixture.root().join("trusted-root.json"),
            output.join("trusted-root.json"),
        )
        .unwrap();
        copy_public_fixture(&fixture.root().join("seed"), &output.join("prior"));
    }
    let descriptor: serde_json::Value =
        serde_json::from_slice(&fs::read(prepared.output.join("renewal.json")).unwrap()).unwrap();
    assert_eq!(descriptor["schema_version"], 3);
    assert_eq!(
        descriptor["prior_expiration_policy"],
        "historical-online-expired-v1"
    );
    assert_eq!(descriptor["next_versions"]["timestamp"], "9007199254740994");
    for role in ["releases", "preview", "stable", "snapshot", "timestamp"] {
        let job = fixture.root().join(format!("historical-{role}"));
        fs::create_dir(&job).unwrap();
        fs::write(job.join("key.der"), &fixture.keys[role]).unwrap();
        let mut request = json!({"schema_version":1,"context":"../historical/context.json","signing_key":"key.der","output":"role.json"});
        if ["snapshot", "timestamp"].contains(&role) {
            request["signed_roles"] = json!("../envelopes");
        }
        write_json(&job.join("config.json"), &request);
        let signed = sign_tuf_role(OnlineRole::parse(role).unwrap(), &job.join("config.json"))
            .await
            .unwrap();
        fs::remove_file(job.join("key.der")).unwrap();
        fs::copy(
            signed.output,
            fixture.root().join(format!("envelopes/{role}.json")),
        )
        .unwrap();
    }
    let assembly = fixture.root().join("historical-assembly.json");
    write_json(
        &assembly,
        &json!({"schema_version":1,"context":"historical/context.json","signed_roles":"envelopes","output":"historical-assembled"}),
    );
    let assembled = assemble_tuf_repository(&assembly).await.unwrap();
    let repository = RepositoryLoader::new(
        &fs::read(fixture.root().join("trusted-root.json")).unwrap(),
        Url::from_directory_path(assembled.output.join("metadata")).unwrap(),
        Url::from_directory_path(assembled.output.join("targets")).unwrap(),
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
    // The exceptional policy never makes a newly proposed expired context admissible.
    let context_path = prepared.output.join("context.json");
    let mut context: serde_json::Value =
        serde_json::from_slice(&fs::read(&context_path).unwrap()).unwrap();
    context["expires"]["timestamp"] = json!(
        Timestamp::now()
            .checked_sub(Duration::from_secs(60))
            .unwrap()
            .to_string()
    );
    write_json(&context_path, &context);
    assert!(inspect_tuf_context(&context_path).await.is_err());
}

#[tokio::test]
async fn historical_policy_refuses_legacy_profile_and_tampered_authenticated_prior() {
    let legacy = Fixture::new(false).await;
    let config = renewal_config(&legacy, "never");
    let mut request: serde_json::Value =
        serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    request["prior_expiration_policy"] = json!("historical-online-expired-v1");
    write_json(&config, &request);
    assert!(
        prepare_tuf_renewal(&config)
            .await
            .unwrap_err()
            .to_string()
            .contains("single-owner")
    );
    assert!(!legacy.root().join("never").exists());
    let fixture = Fixture::with_profile(false, true).await;
    expire_prior_timestamp(&fixture).await;
    let config = renewal_config(&fixture, "never");
    request = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    request["initial_root_profile"] = json!("single-owner-one-of-one-v1");
    request["prior_expiration_policy"] = json!("historical-online-expired-v1");
    write_json(&config, &request);
    let timestamp = fixture.root().join("seed/metadata/timestamp.json");
    let mut tampered: serde_json::Value =
        serde_json::from_slice(&fs::read(&timestamp).unwrap()).unwrap();
    tampered["signed"]["version"] = json!(2);
    write_json(&timestamp, &tampered);
    assert!(prepare_tuf_renewal(&config).await.is_err());
    assert!(!fixture.root().join("never").exists());
}

#[tokio::test]
async fn historical_policy_never_admits_correctly_signed_expired_offline_anchors() {
    for expired_role in ["root", "targets"] {
        let fixture = Fixture::with_profile(false, true).await;
        let root_path = fixture.root().join("trusted-root.json");
        let root: tough::schema::Signed<Root> =
            serde_json::from_slice(&fs::read(&root_path).unwrap()).unwrap();
        let expired = Timestamp::now()
            .checked_sub(Duration::from_secs(60))
            .unwrap();
        if expired_role == "root" {
            let mut value = root.signed;
            value.expires = expired;
            let bytes =
                sign_fixture_role(&fixture, "root", value.clone(), &KeyHolder::Root(value)).await;
            fs::write(&root_path, &bytes).unwrap();
            fs::write(fixture.root().join("seed/metadata/1.root.json"), bytes).unwrap();
        } else {
            let target_path = fixture.root().join("seed/metadata/1.targets.json");
            let mut value: tough::schema::Signed<tough::schema::Targets> =
                serde_json::from_slice(&fs::read(&target_path).unwrap()).unwrap();
            value.signed.expires = expired;
            let bytes = sign_fixture_role(
                &fixture,
                "targets",
                value.signed,
                &KeyHolder::Root(root.signed.clone()),
            )
            .await;
            fs::write(target_path, &bytes).unwrap();
            let snapshot_path = fixture.root().join("seed/metadata/1.snapshot.json");
            let mut value: serde_json::Value =
                serde_json::from_slice(&fs::read(&snapshot_path).unwrap()).unwrap();
            value["signed"]["meta"]["targets.json"]["length"] = json!(bytes.len());
            value["signed"]["meta"]["targets.json"]["hashes"]["sha256"] = json!(sha256(&bytes));
            let value: tough::schema::Signed<tough::schema::Snapshot> =
                serde_json::from_value(value).unwrap();
            let bytes = sign_fixture_role(
                &fixture,
                "snapshot",
                value.signed,
                &KeyHolder::Root(root.signed.clone()),
            )
            .await;
            fs::write(snapshot_path, &bytes).unwrap();
            let timestamp_path = fixture.root().join("seed/metadata/timestamp.json");
            let mut value: serde_json::Value =
                serde_json::from_slice(&fs::read(&timestamp_path).unwrap()).unwrap();
            value["signed"]["meta"]["snapshot.json"]["length"] = json!(bytes.len());
            value["signed"]["meta"]["snapshot.json"]["hashes"]["sha256"] = json!(sha256(&bytes));
            let value: tough::schema::Signed<tough::schema::Timestamp> =
                serde_json::from_value(value).unwrap();
            fs::write(
                timestamp_path,
                sign_fixture_role(
                    &fixture,
                    "timestamp",
                    value.signed,
                    &KeyHolder::Root(root.signed),
                )
                .await,
            )
            .unwrap();
        }
        let config = renewal_config(&fixture, "never");
        let mut request: serde_json::Value =
            serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        request["initial_root_profile"] = json!("single-owner-one-of-one-v1");
        request["prior_expiration_policy"] = json!("historical-online-expired-v1");
        write_json(&config, &request);
        let error = prepare_tuf_renewal(&config).await.unwrap_err();
        assert!(
            error.to_string().contains("expir"),
            "{expired_role}: {error}"
        );
        assert!(!fixture.root().join("never").exists());
    }
}

#[tokio::test]
async fn native_reserved_floors_refuse_exhaustion_and_changes_to_pinned_targets() {
    let fixture = Fixture::with_profile(false, true).await;
    for (name, floor, target) in [("overflow", u64::MAX, 1_u64), ("targets", 2, 2)] {
        let config = renewal_config(&fixture, name);
        let mut request: serde_json::Value =
            serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        request["initial_root_profile"] = json!("single-owner-one-of-one-v1");
        request["previous_reserved_versions"] = json!({"targets":target,"snapshot":floor,"timestamp":floor,"releases":floor,"preview":floor,"stable":floor});
        write_json(&config, &request);
        assert!(prepare_tuf_renewal(&config).await.is_err());
        assert!(!fixture.root().join(name).exists());
    }
}
