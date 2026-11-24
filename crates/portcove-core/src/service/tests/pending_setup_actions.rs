use super::*;

/// The whole-library read observes pending manual setups once per pass; a
/// single-port read observes its own row. Both must assess every action alike.
#[test]
fn batched_pending_setup_observation_matches_per_port_assessment() {
    let temporary = tempfile::tempdir().unwrap();
    let service = PortcoveService::new(Library::open(temporary.path()).unwrap()).unwrap();
    let pending = service
        .catalog
        .ports()
        .iter()
        .find(|port| port.release.provider != ReleaseSource::UserPrepared)
        .unwrap()
        .id
        .clone();
    let actions = |statuses: &[PortStatus], id: &str| {
        serde_json::to_value(
            &statuses
                .iter()
                .find(|status| status.port_id == id)
                .unwrap()
                .port_actions,
        )
        .unwrap()
    };
    let before = service.statuses().unwrap();
    service
        .library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO catalog_downloads(port_id,pending_id,record_json,phase,preview_sha256,activity_id)
             VALUES (?1,'fixture-pending','{}','downloaded',?2,'fixture-activity')",
            rusqlite::params![pending, "0".repeat(64)],
        )
        .unwrap();
    let statuses = service.statuses().unwrap();
    assert_eq!(statuses.len(), service.catalog.ports().len());
    for status in &statuses {
        let single = service.status(&status.port_id).unwrap();
        assert_eq!(
            serde_json::to_value(&status.port_actions).unwrap(),
            serde_json::to_value(&single.port_actions).unwrap(),
            "{}",
            status.port_id
        );
        let held = status.port_actions.iter().filter(|assessment| {
            matches!(
                assessment.action,
                PortAction::Install | PortAction::RegisterExternal | PortAction::Update
            )
        });
        if status.port_id == pending {
            assert_ne!(actions(&statuses, &pending), actions(&before, &pending));
            for assessment in held {
                assert_eq!(assessment.availability, PortActionAvailability::NotOffered);
                assert_eq!(assessment.reason, PortActionReason::RouteNotOffered);
                assert!(assessment.definition.is_none());
            }
        } else {
            assert_eq!(
                actions(&statuses, &status.port_id),
                actions(&before, &status.port_id)
            );
        }
    }
}

/// The transactional workspace read observes the same pending setup and holds
/// the same acquisition actions for an operational port.
#[test]
fn workspace_snapshot_holds_acquisition_for_a_pending_setup_port() {
    let temporary = tempfile::tempdir().unwrap();
    let service = PortcoveService::new(Library::open(temporary.path()).unwrap()).unwrap();
    let port = service
        .catalog
        .ports()
        .iter()
        .find(|port| {
            port.release.provider != ReleaseSource::UserPrepared
                && service.catalog.listing(&port.id).is_ok_and(|listing| {
                    !crate::catalog::listings::has_verified_source_editions(listing)
                })
        })
        .unwrap();
    let record = crate::PendingSetupRecord {
        format_version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        port_id: port.id.clone(),
        listing: service.catalog.listing(&port.id).unwrap().clone(),
        path: temporary.path().join("pending"),
        state: crate::PendingSetupState::Downloaded,
        artifact: crate::CatalogDownloadCandidate {
            release_id: 7.into(),
            asset_id: 11.into(),
            release_tag: "v1".into(),
            release_url: "https://github.com/owner/game/releases/tag/v1".into(),
            name: "game.zip".into(),
            size: 1,
            download_url: "https://github.com/owner/game/releases/download/v1/game.zip".into(),
            sha256: None,
            can_extract: true,
        },
        archive_sha256: "0".repeat(64),
        downloaded_at: "2026-11-23T00:00:00Z".into(),
        reason: None,
        progress: None,
    };
    service
        .library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO catalog_downloads(port_id,pending_id,record_json,phase,preview_sha256,activity_id)
             VALUES (?1,?2,?3,'downloaded',?4,?5)",
            rusqlite::params![
                record.port_id,
                record.id,
                serde_json::to_string(&record).unwrap(),
                "0".repeat(64),
                uuid::Uuid::new_v4().to_string()
            ],
        )
        .unwrap();
    let snapshot = service.workspace_snapshot(10).unwrap();
    // Reading maps the legacy record to its read-time stage; identity is unchanged.
    assert_eq!(
        snapshot
            .pending_setups
            .iter()
            .map(|pending| (&pending.id, &pending.port_id))
            .collect::<Vec<_>>(),
        [(&record.id, &record.port_id)]
    );
    let status = snapshot
        .statuses
        .iter()
        .find(|status| status.port_id == port.id)
        .unwrap();
    let held = status
        .port_actions
        .iter()
        .filter(|assessment| {
            matches!(
                assessment.action,
                PortAction::Install | PortAction::RegisterExternal | PortAction::Update
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(held.len(), 3);
    for assessment in held {
        assert_eq!(assessment.availability, PortActionAvailability::NotOffered);
        assert_eq!(assessment.reason, PortActionReason::RouteNotOffered);
        assert!(assessment.definition.is_none());
    }
    assert_eq!(
        serde_json::to_value(&status.port_actions).unwrap(),
        serde_json::to_value(service.status(&port.id).unwrap().port_actions).unwrap()
    );
}
