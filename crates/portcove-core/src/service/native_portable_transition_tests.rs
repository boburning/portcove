// Controlled schema-3 predecessor transitions. No upstream program is executed.
fn transition_fixture_catalogs(
    id: &str,
    original: &[u8],
    predecessor: &ResolvedRelease,
) -> (Catalog, Catalog) {
    let target = compatible_archive_fixture_catalog(
        Catalog::embedded().unwrap().port(id).unwrap().clone(),
        original,
    );
    let mut old = crate::test_fixture::v26_diagnostic_port(id);
    old.runtime_source_hashes = target.port(id).unwrap().runtime_source_hashes.clone();
    let direct = old
        .release
        .direct
        .get_mut(&Platform::WindowsX86_64)
        .unwrap();
    direct.version = predecessor.version.clone();
    direct.sha256 = predecessor.asset.sha256.clone();
    direct.size = predecessor.asset.size;
    // The injected provider supplies loopback bytes; the authoring fixture keeps
    // the ordinary production HTTPS Direct contract rather than a fixture grant.
    direct.url = "https://example.invalid/controlled-predecessor.zip".into();
    let mut contract = crate::test_fixture::v26_diagnostic_contract(id);
    contract
        .applicability
        .push(crate::SourceContractApplicability {
            upstream_ref: predecessor.version.clone(),
            artifact_sha256: Some(predecessor.asset.sha256.clone()),
        });
    let mut document = serde_json::to_value(target.authoritative_document()).unwrap();
    let index = document["ports"]
        .as_array()
        .unwrap()
        .iter()
        .position(|p| p["id"] == id)
        .unwrap();
    document["ports"][index] = serde_json::to_value(old).unwrap();
    let index = document["source_catalog"]["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .position(|p| p["port_id"] == id)
        .unwrap();
    document["source_catalog"]["contracts"][index] = serde_json::to_value(contract).unwrap();
    let creating = Catalog::from_json(&document.to_string()).unwrap();
    let mut document = serde_json::to_value(target.authoritative_document()).unwrap();
    let index = document["ports"]
        .as_array()
        .unwrap()
        .iter()
        .position(|p| p["id"] == id)
        .unwrap();
    document["ports"][index]["archive_data_transition_v1"] = serde_json::json!({
        "predecessor_archive_sha256":predecessor.asset.sha256,
        "creating_contract_sha256":crate::archive_data_transition::creating_fingerprint(&creating,id).unwrap()
    });
    (creating, Catalog::from_json(&document.to_string()).unwrap())
}

async fn assert_reviewed_archive_transition(
    id: &str,
    fault: Option<LifecycleFaultPoint>,
    tamper_previous: bool,
    partial_cleanup: bool,
) {
    let started = std::time::Instant::now();
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let server = Server::new();
    let (executable, settings, snapshot, sram) = match id {
        "mega-man-x2-snes-recomp" => (
            "MegaManX2SNESRecomp.exe",
            "config.ini",
            "saves/save1.sav",
            None,
        ),
        "sonic-the-hedgehog-recomp" => (
            "SonicTheHedgehogRecomp.exe",
            "settings.ini",
            "native_save_1.bin",
            None,
        ),
        "super-metroid-recomp" => (
            "SuperMetroidSNESRecomp.exe",
            "config.ini",
            "saves/save1.sav",
            Some("saves/save.srm"),
        ),
        _ => panic!("undeclared transition consumer"),
    };
    let old_release = server.release_in_folder("controlled-predecessor", 1, "", executable);
    let original = b"lawful original fixture for reviewed predecessor data transition";
    let (creating, target) = transition_fixture_catalogs(id, original, &old_release);
    let definition = serde_json::to_vec(&target.authoritative_document()).unwrap();
    let provider = Arc::new(Provider(Mutex::new(old_release)));
    let mut service = build_service(library.clone(), provider.clone());
    service.replace_catalog_for_test(creating.clone());
    let source = temporary.path().join(if id.starts_with("sonic-") {
        "source.bin"
    } else {
        "source.sfc"
    });
    fs::write(&source, original).unwrap();
    service
        .register_source(
            creating.port(id).unwrap().source_profile.as_ref().unwrap(),
            &source,
        )
        .unwrap();
    let first = service
        .install(id, None, None, None, true, |_| {})
        .await
        .unwrap();
    service.prepare_launch(id, None).unwrap();
    fs::write(first.path.join(settings), b"latest player settings").unwrap();
    fs::create_dir_all(first.path.join(snapshot).parent().unwrap()).unwrap();
    fs::write(first.path.join(snapshot), b"predecessor host snapshot").unwrap();
    if let Some(sram) = sram {
        fs::write(first.path.join(sram), b"guest SRAM progress").unwrap();
    }
    // Stale canonical leaves removed by the initialized active runtime must not
    // reappear when the new data coordinates are created.
    let deleted = if id.starts_with("sonic-") {
        "native_save_9.bin"
    } else {
        "saves/deleted.sav"
    };
    fs::create_dir_all(library.user_dir(id).join(deleted).parent().unwrap()).unwrap();
    fs::write(library.user_dir(id).join(deleted), b"stale deleted state").unwrap();
    if !id.starts_with("sonic-") {
        fs::write(
            library.user_dir(id).join("keybinds.ini"),
            b"stale deleted settings",
        )
        .unwrap();
    }
    let old_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(first.path.join(".portcove-manifest.json")).unwrap())
            .unwrap();
    let old_program = fs::read(first.path.join(executable)).unwrap();
    service.replace_catalog_for_test(target.clone());
    *provider.0.lock().unwrap() = server.release_in_folder("controlled-next", 2, "", executable);
    let review = service.plan_game_update(id, false).await.unwrap();
    assert!(review.data_transition.is_some());
    assert!(
        review
            .plan
            .preservation_notices
            .iter()
            .any(|notice| notice.contains("first update"))
    );
    assert!(
        service
            .apply_game_update(id, false, "missing consent", |_| {})
            .await
            .is_err()
    );
    let consent = service
        .authorize_game_update(id, false, &review.plan_sha256)
        .await
        .unwrap();
    let consent = if fault.is_none() && id == "mega-man-x2-snes-recomp" {
        fs::write(first.path.join(settings), b"changed after review").unwrap();
        assert!(
            service
                .apply_game_update(id, false, &consent.token, |_| {})
                .await
                .is_err()
        );
        assert_eq!(
            service.status(id).unwrap().active.unwrap().manifest_sha256,
            first.manifest_sha256
        );
        fs::write(first.path.join(settings), b"latest player settings").unwrap();
        let review = service.plan_game_update(id, false).await.unwrap();
        service
            .authorize_game_update(id, false, &review.plan_sha256)
            .await
            .unwrap()
    } else {
        consent
    };
    struct FailTransition {
        point: LifecycleFaultPoint,
        fired: AtomicBool,
    }
    impl LifecycleFaultInjector for FailTransition {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == self.point && !self.fired.swap(true, Ordering::SeqCst) {
                return Err(PortcoveError::state(
                    "controlled archive transition interruption",
                ));
            }
            Ok(())
        }
    }
    if let Some(point) = fault {
        service.faults = Arc::new(FailTransition {
            point,
            fired: AtomicBool::new(false),
        });
    }
    let result = service
        .apply_game_update(id, false, &consent.token, |_| {})
        .await;
    if fault.is_some() {
        assert!(result.is_err(), "{fault:?}");
        assert_eq!(OperationStore::new(library.clone()).all().unwrap().len(), 1);
        // Recovery uses its captured authority after catalog drift.
        let mut drift = serde_json::to_value(target.authoritative_document()).unwrap();
        let index = drift["ports"]
            .as_array()
            .unwrap()
            .iter()
            .position(|p| p["id"] == id)
            .unwrap();
        drift["ports"][index]["archive_data_compatibility_v1"]["contract_id"] =
            serde_json::json!("unrelated-future-policy");
        service.replace_catalog_for_test(Catalog::from_json(&drift.to_string()).unwrap());
        service.faults = Arc::new(NoLifecycleFaults);
        if partial_cleanup {
            let journal = OperationStore::new(library.clone())
                .all()
                .unwrap()
                .remove(0);
            assert_eq!(journal.phase, LifecyclePhase::CleanupPending);
            let previous = journal.paths.quarantine.as_ref().unwrap();
            // Simulate interruption after recursive deletion of one legitimate
            // leaf, with its original siblings still present.
            fs::remove_file(previous.join(deleted)).unwrap();
        }
        if tamper_previous {
            let journal = OperationStore::new(library.clone())
                .all()
                .unwrap()
                .remove(0);
            let previous = journal.paths.quarantine.as_ref().unwrap();
            let changed = previous.join("preserve-new-player-file");
            fs::write(&changed, b"unexpected player data after interruption").unwrap();
            service.recover_pending_operations().unwrap();
            assert_eq!(OperationStore::new(library.clone()).all().unwrap().len(), 1);
            assert_eq!(
                fs::read(&changed).unwrap(),
                b"unexpected player data after interruption"
            );
            fs::remove_file(changed).unwrap();
        }
        service.recover_pending_operations().unwrap();
        service.replace_catalog_for_test(target.clone());
    } else {
        assert!(result.unwrap().staged);
    }
    assert!(
        OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    let admitted = service.status(id).unwrap().active.unwrap();
    assert_eq!(admitted.id, first.id);
    let effective = service.effective_archive_data_port(&admitted).unwrap();
    if fault.is_none() {
        let old_target = creating.port(id).unwrap();
        let mapped_target = service.retained_archive_data_target(old_target, Some(&admitted)).unwrap();
        let mut expected_target = old_target.clone();
        expected_target.archive_data_compatibility_v1 = effective.archive_data_compatibility_v1.clone();
        assert_eq!(serde_json::to_value(&mapped_target).unwrap(), serde_json::to_value(&expected_target).unwrap(), "data admission cannot hide any supplied target field");
        let mut changed = old_target.clone();
        changed.mod_package_policy = Some(crate::ModPackagePolicy::VersionedPackagesV1);
        assert!(service.require_portable_transition_to(&admitted, &changed, Some(&admitted)).is_err(), "admitted data mapping cannot hide a changed mod ownership contract");
        let mut changed = old_target.clone();
        changed.launch_arguments.push("changed-execution-contract".into());
        assert!(service.require_portable_transition_to(&admitted, &changed, Some(&admitted)).is_err(), "admitted data mapping cannot hide changed execution arguments");
    }
    let mapped = crate::archive_data::entries(
        &effective,
        Some(&first.artifact.sha256),
        &first.path,
        &library.user_dir(id),
    )
    .unwrap();
    assert!(
        !mapped
            .iter()
            .any(|entry| entry.relative == deleted && entry.canonical.exists())
    );
    if !id.starts_with("sonic-") {
        assert!(!library.user_dir(id).join("keybinds.ini").exists());
    }
    assert_eq!(
        fs::read(library.user_dir(id).join(settings)).unwrap(),
        b"latest player settings"
    );
    assert_eq!(
        fs::read(first.path.join(snapshot)).unwrap(),
        b"predecessor host snapshot"
    );
    let mut admitted_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(first.path.join(".portcove-manifest.json")).unwrap())
            .unwrap();
    assert_eq!(admitted_manifest["schema_version"], 8);
    assert_eq!(
        admitted_manifest["retained_contract"],
        old_manifest["retained_contract"]
    );
    admitted_manifest
        .as_object_mut()
        .unwrap()
        .remove("archive_data_admission");
    admitted_manifest["schema_version"] = old_manifest["schema_version"].clone();
    assert_eq!(
        admitted_manifest, old_manifest,
        "creating/source/execution/artifact/member authority stays exact"
    );
    assert_eq!(fs::read(first.path.join(executable)).unwrap(), old_program);
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(first.path.join(PSX_DATA_RECEIPT)).unwrap()).unwrap();
    assert_eq!(receipt["schema_version"], 2);
    assert_eq!(receipt["manifest_sha256"], admitted.manifest_sha256);
    let staged = if fault.is_some() {
        let plan = service.plan_game_update(id, false).await.unwrap();
        assert!(plan.data_transition.is_none());
        let consent = service
            .authorize_game_update(id, false, &plan.plan_sha256)
            .await
            .unwrap();
        service
            .apply_game_update(id, false, &consent.token, |_| {})
            .await
            .unwrap()
    } else {
        service.status(id).unwrap().staged.unwrap()
    };
    assert_eq!(service.status(id).unwrap().active.unwrap().id, first.id);
    if fault.is_none() {
        service
            .set_update_policy(id, UpdatePolicy::Automatic)
            .unwrap();
        let result = service.reconcile(id, |_| {}).await.unwrap();
        assert_eq!(result.action, ReconcileAction::Staged);
        assert_eq!(result.policy, UpdatePolicy::Automatic);
        assert_eq!(service.status(id).unwrap().active.unwrap().id, first.id);
    }
    let second = service.activate_staged(id).unwrap();
    assert_eq!(second.id, staged.id);
    assert_eq!(
        fs::read(second.path.join(settings)).unwrap(),
        b"latest player settings"
    );
    assert!(!second.path.join(snapshot).exists());
    if let Some(sram) = sram {
        assert_eq!(
            fs::read(second.path.join(sram)).unwrap(),
            b"guest SRAM progress"
        );
    }
    let rolled = service.rollback(id).unwrap();
    assert_eq!(rolled.id, first.id);
    assert_eq!(
        fs::read(rolled.path.join(snapshot)).unwrap(),
        b"predecessor host snapshot"
    );
    if fault.is_none() && id == "mega-man-x2-snes-recomp" {
        let receipt_path = rolled.path.join(PSX_DATA_RECEIPT);
        let receipt = fs::read(&receipt_path).unwrap();
        let mut downgraded: serde_json::Value = serde_json::from_slice(&receipt).unwrap();
        downgraded["schema_version"] = serde_json::json!(1);
        fs::write(&receipt_path, serde_json::to_vec(&downgraded).unwrap()).unwrap();
        assert!(
            service.collect_user_data(id).is_err(),
            "an old completion receipt cannot grant the new mapping"
        );
        fs::remove_file(&receipt_path).unwrap();
        assert!(
            service.collect_user_data(id).is_err(),
            "a missing receipt cannot grant the new mapping"
        );
        fs::write(receipt_path, receipt).unwrap();
    }
    let backup = service.create_backup(id).unwrap();
    assert!(backup.path.is_dir());
    assert_eq!(
        serde_json::to_vec(&service.catalog.authoritative_document()).unwrap(),
        definition
    );
    assert_eq!(fs::read(source).unwrap(), original);
    eprintln!(
        "{}",
        serde_json::json!({"kind":"compiled-core-reviewed-predecessor-transition","port_id":id,"fault":format!("{fault:?}"),"outcome":"passed","duration_ms":started.elapsed().as_millis()})
    );
}

#[tokio::test]
async fn reviewed_archive_transition_mmx2_populated_install() {
    assert_reviewed_archive_transition("mega-man-x2-snes-recomp", None, false, false).await;
}
#[tokio::test]
async fn reviewed_archive_transition_sonic_populated_install() {
    assert_reviewed_archive_transition("sonic-the-hedgehog-recomp", None, false, false).await;
}
#[tokio::test]
async fn reviewed_archive_transition_super_metroid_populated_install() {
    assert_reviewed_archive_transition("super-metroid-recomp", None, false, false).await;
}

macro_rules! archive_transition_fault_case {
    ($name:ident,$point:ident) => {
        #[tokio::test]
        async fn $name() {
            assert_reviewed_archive_transition(
                "mega-man-x2-snes-recomp",
                Some(LifecycleFaultPoint::$point),
                false,
                false,
            )
            .await;
        }
    };
}
archive_transition_fault_case!(
    reviewed_archive_transition_recovers_prepared,
    ArchiveDataTransitionPrepared
);
archive_transition_fault_case!(
    reviewed_archive_transition_recovers_manifest_published,
    ArchiveDataManifestPublished
);
archive_transition_fault_case!(
    reviewed_archive_transition_recovers_manifest_recorded,
    ArchiveDataManifestRecorded
);
archive_transition_fault_case!(
    reviewed_archive_transition_recovers_receipt_fenced,
    ArchiveDataReceiptFenced
);
archive_transition_fault_case!(
    reviewed_archive_transition_recovers_canonical_quarantined,
    ArchiveDataCanonicalQuarantined
);
archive_transition_fault_case!(
    reviewed_archive_transition_recovers_canonical_published,
    ArchiveDataCanonicalPublished
);
archive_transition_fault_case!(
    reviewed_archive_transition_recovers_committed,
    ArchiveDataTransitionCommitted
);

#[tokio::test]
async fn reviewed_archive_transition_preserves_changed_quarantined_data() {
    assert_reviewed_archive_transition(
        "mega-man-x2-snes-recomp",
        Some(LifecycleFaultPoint::ArchiveDataCanonicalPublished),
        true,
        false,
    )
    .await;
}

#[tokio::test]
async fn reviewed_archive_transition_resumes_partial_cleanup() {
    assert_reviewed_archive_transition(
        "mega-man-x2-snes-recomp",
        Some(LifecycleFaultPoint::ArchiveDataCleanupStarted),
        false,
        true,
    )
    .await;
}
#[tokio::test]
async fn reviewed_archive_transition_preserves_changed_cleanup_survivor() {
    assert_reviewed_archive_transition(
        "mega-man-x2-snes-recomp",
        Some(LifecycleFaultPoint::ArchiveDataCleanupStarted),
        true,
        true,
    )
    .await;
}
