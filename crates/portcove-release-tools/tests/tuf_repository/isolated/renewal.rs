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
    let cli = std::process::Command::new(env!("CARGO_BIN_EXE_portcove-release-tools"))
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
