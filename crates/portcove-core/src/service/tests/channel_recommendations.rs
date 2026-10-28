use super::*;

const NATIVE_ID: &str = "fragglet-sdl-sopwith";

#[test]
fn authored_native_recommendations_agree_across_public_read_surfaces() {
    let temporary = tempfile::tempdir().unwrap();
    let service = PortcoveService::new(Library::open(temporary.path()).unwrap()).unwrap();
    let statuses = service.statuses().unwrap();
    let workspace = service.workspace_snapshot(50).unwrap();
    let recommendations = service
        .catalog
        .ports()
        .iter()
        .filter_map(|port| {
            let hint = service
                .catalog
                .listing(&port.id)
                .ok()?
                .recommended_download_channel?;
            (port.adapter == AdapterKind::NativePortable
                && port.channels.contains(&hint)
                && hint != default_channel(port))
            .then_some((&port.id, hint))
        })
        .collect::<Vec<_>>();
    assert!(
        !recommendations.is_empty(),
        "Exercise an actual authored recommendation"
    );
    for (id, hint) in recommendations {
        assert_eq!(service.status(id).unwrap().channel, hint);
        assert_eq!(
            statuses
                .iter()
                .find(|row| &row.port_id == id)
                .unwrap()
                .channel,
            hint
        );
        assert_eq!(
            workspace
                .statuses
                .iter()
                .find(|row| &row.port_id == id)
                .unwrap()
                .channel,
            hint
        );
    }
    let connection = service.library.connection().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM port_settings", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
}

fn fixture(root: &Path, recommendation: Option<ReleaseChannel>) -> PortcoveService {
    let library = Library::open(root).unwrap();
    let mut service = PortcoveService::new(library).unwrap();
    let mut document = service.catalog.authoritative_document();
    document
        .ports
        .iter_mut()
        .find(|port| port.id == NATIVE_ID)
        .unwrap()
        .channels = vec![ReleaseChannel::Stable, ReleaseChannel::Beta];
    let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    // Keep the accepted authored directory and its format fence. Rebuilding a
    // strict-only catalog above changes offered channels, not descriptive facts.
    let mut listings = service.catalog.listing_document().clone();
    listings
        .listings
        .iter_mut()
        .find(|listing| listing.id == NATIVE_ID)
        .unwrap()
        .recommended_download_channel = recommendation;
    service.replace_catalog_for_test(catalog.with_listing_document(listings).unwrap());
    service
}

#[test]
fn fresh_native_channel_recommendation_is_consistent_and_read_only() {
    let temporary = tempfile::tempdir().unwrap();
    let service = fixture(
        &temporary.path().join("library"),
        Some(ReleaseChannel::Beta),
    );
    assert_eq!(
        service.status(NATIVE_ID).unwrap().channel,
        ReleaseChannel::Beta
    );
    assert_eq!(
        service
            .statuses()
            .unwrap()
            .iter()
            .find(|status| status.port_id == NATIVE_ID)
            .unwrap()
            .channel,
        ReleaseChannel::Beta
    );
    let mut connection = service.library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    let (mut statuses, _) = service
        .library
        .statuses_from_with_metrics_and_barrier(
            &transaction,
            &[(NATIVE_ID.into(), ReleaseChannel::Stable)],
            || {},
        )
        .unwrap();
    assert_eq!(
        PortcoveService::apply_fresh_native_channel_recommendations(
            &service.catalog,
            &transaction,
            &mut statuses,
        )
        .unwrap(),
        1
    );
    assert_eq!(statuses[0].channel, ReleaseChannel::Beta);
    assert_eq!(
        transaction
            .query_row(
                "SELECT count(*) FROM port_settings WHERE port_id=?1",
                [NATIVE_ID],
                |row| row.get::<_, u64>(0),
            )
            .unwrap(),
        0
    );
    transaction.commit().unwrap();
    for hint in [None, Some(ReleaseChannel::Stable)] {
        let service = fixture(&temporary.path().join("library"), hint);
        assert_eq!(
            service.status(NATIVE_ID).unwrap().channel,
            ReleaseChannel::Stable
        );
    }
    let mut undeclared = fixture(
        &temporary.path().join("undeclared"),
        Some(ReleaseChannel::Beta),
    );
    let mut document = undeclared.catalog.authoritative_document();
    document
        .ports
        .iter_mut()
        .find(|port| port.id == NATIVE_ID)
        .unwrap()
        .channels = vec![ReleaseChannel::Stable];
    let listings = undeclared.catalog.listing_document().clone();
    undeclared.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap())
            .unwrap()
            .with_listing_document(listings)
            .unwrap(),
    );
    assert_eq!(
        undeclared.status(NATIVE_ID).unwrap().channel,
        ReleaseChannel::Stable
    );
}

#[test]
fn native_channel_recommendation_survives_location_policy_and_reopen() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("library");
    let service = fixture(&root, Some(ReleaseChannel::Beta));
    let destination = temporary.path().join("games");
    fs::create_dir(&destination).unwrap();
    let preview = service
        .preview_output_directory(NATIVE_ID, Some(&destination))
        .unwrap();
    let authorization = service
        .authorize_output_directory_change(NATIVE_ID, Some(&destination), &preview.preview_sha256)
        .unwrap();
    service
        .apply_output_directory_change(NATIVE_ID, Some(&destination), &authorization.token)
        .unwrap();
    assert_eq!(
        service.status(NATIVE_ID).unwrap().channel,
        ReleaseChannel::Beta
    );
    let reopened = fixture(&root, Some(ReleaseChannel::Stable));
    assert_eq!(
        reopened.status(NATIVE_ID).unwrap().channel,
        ReleaseChannel::Beta
    );
    assert_eq!(
        reopened
            .output_location(NATIVE_ID, None)
            .unwrap()
            .configured_output_directory,
        Some(fs::canonicalize(&destination).unwrap())
    );

    let policy_root = temporary.path().join("policy-library");
    let policy = fixture(&policy_root, Some(ReleaseChannel::Beta));
    assert_eq!(
        policy
            .set_update_policy(NATIVE_ID, UpdatePolicy::Stage)
            .unwrap()
            .channel,
        ReleaseChannel::Beta
    );
    assert_eq!(
        fixture(&policy_root, None)
            .status(NATIVE_ID)
            .unwrap()
            .channel,
        ReleaseChannel::Beta
    );

    let stable_root = temporary.path().join("older-library");
    let older = fixture(&stable_root, Some(ReleaseChannel::Beta));
    older
        .library
        .ensure_settings(NATIVE_ID, ReleaseChannel::Stable)
        .unwrap();
    assert_eq!(
        older.status(NATIVE_ID).unwrap().channel,
        ReleaseChannel::Stable
    );
    assert_eq!(
        fixture(&stable_root, Some(ReleaseChannel::Beta))
            .status(NATIVE_ID)
            .unwrap()
            .channel,
        ReleaseChannel::Stable
    );
}

#[test]
fn native_channel_footprints_include_pending_and_uninterpreted_external_records() {
    let temporary = tempfile::tempdir().unwrap();
    let service = fixture(
        &temporary.path().join("library"),
        Some(ReleaseChannel::Beta),
    );
    let connection = service.library.connection().unwrap();
    connection.execute(
        "INSERT INTO catalog_downloads(port_id,pending_id,record_json,phase,preview_sha256,activity_id)
         VALUES (?1,'fixture-pending','{}','downloaded',?2,'fixture-activity')",
        rusqlite::params![NATIVE_ID, "0".repeat(64)],
    ).unwrap();
    assert_eq!(
        service.status(NATIVE_ID).unwrap().channel,
        ReleaseChannel::Stable
    );
    connection
        .execute(
            "DELETE FROM catalog_downloads WHERE port_id=?1",
            [NATIVE_ID],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO external_runtime_registrations(port_id,record_json,retained_catalog_json,registered_at) VALUES (?1,'{}','{}',0)",
            [NATIVE_ID],
        )
        .unwrap();
    let (occupied, queries) =
        Library::port_state_footprints(&connection, &[NATIVE_ID.into()]).unwrap();
    assert_eq!(queries, 1);
    assert!(occupied.contains(NATIVE_ID));
    assert_eq!(
        connection
            .query_row(
                "SELECT record_json FROM external_runtime_registrations WHERE port_id=?1",
                [NATIVE_ID],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "{}"
    );
}

#[test]
fn retained_and_staged_rows_without_settings_keep_legacy_channel() {
    let temporary = tempfile::tempdir().unwrap();
    for staged in [false, true] {
        let service = fixture(
            &temporary.path().join(format!("library-{staged}")),
            Some(ReleaseChannel::Beta),
        );
        let record = InstallRecord {
            id: Uuid::new_v4().to_string(),
            port_id: NATIVE_ID.into(),
            version: "inert-legacy-row".into(),
            path: temporary.path().join("uninterpreted-runtime"),
            channel: ReleaseChannel::Stable,
            installed_at: Library::now(),
            verified: false,
            staged,
            artifact: ArtifactIdentity {
                asset_name: "fixture.zip".into(),
                sha256: "0".repeat(64),
                size: 1,
            },
            manifest_sha256: "0".repeat(64),
            selected_executable: temporary.path().join("uninterpreted-runtime/launcher"),
            runtime: None,
        };
        service.library.register_install(&record, false).unwrap();
        let connection = service.library.connection().unwrap();
        connection
            .execute("DELETE FROM port_settings WHERE port_id=?1", [NATIVE_ID])
            .unwrap();
        let (statuses, _) = service
            .status_rows_with_recommendations(
                &service.catalog,
                &[(NATIVE_ID.into(), ReleaseChannel::Stable)],
                false,
            )
            .unwrap();
        assert_eq!(statuses[0].channel, ReleaseChannel::Stable);
        assert_eq!(service.library.all_installs().unwrap()[0].id, record.id);
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM port_settings WHERE port_id=?1",
                    [NATIVE_ID],
                    |row| row.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
    }
}

struct FailedRelease(Mutex<Vec<ReleaseChannel>>);

#[test]
fn channel_footprint_reads_remain_batched_under_sqlite_limits() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let ids = (0..40)
        .map(|index| format!("fixture-{index}"))
        .collect::<Vec<_>>();
    for id in [&ids[0], &ids[39]] {
        library.ensure_settings(id, ReleaseChannel::Stable).unwrap();
    }
    let connection = library.connection().unwrap();
    connection
        .set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 18)
        .unwrap();
    let (occupied, queries) = Library::port_state_footprints(&connection, &ids).unwrap();
    assert_eq!(occupied, HashSet::from([ids[0].clone(), ids[39].clone()]));
    assert_eq!(queries, 7);
    assert_eq!(
        Library::port_state_footprints(&connection, &[]).unwrap(),
        (HashSet::new(), 0)
    );
}

#[async_trait::async_trait]
impl ReleaseProvider for FailedRelease {
    async fn resolve(
        &self,
        _port: &PortDefinition,
        channel: ReleaseChannel,
        _platform: Platform,
    ) -> Result<ResolvedRelease> {
        self.0.lock().unwrap().push(channel);
        Err(PortcoveError::network(
            "inert provider refusal; no request made",
        ))
    }
}

#[tokio::test]
async fn accepted_first_install_channel_survives_provider_failure_and_explicit_override() {
    let temporary = tempfile::tempdir().unwrap();
    for requested in [None, Some(ReleaseChannel::Stable)] {
        let root = temporary.path().join(format!("library-{requested:?}"));
        let mut service = fixture(&root, Some(ReleaseChannel::Beta));
        let provider = Arc::new(FailedRelease(Mutex::new(Vec::new())));
        service.releases = provider.clone();
        let chosen = requested.unwrap_or(ReleaseChannel::Beta);
        assert!(
            service
                .install(NATIVE_ID, requested, None, None, true, |_| {})
                .await
                .is_err()
        );
        assert_eq!(*provider.0.lock().unwrap(), vec![chosen]);
        assert_eq!(
            fixture(&root, None).status(NATIVE_ID).unwrap().channel,
            chosen
        );
    }
}
