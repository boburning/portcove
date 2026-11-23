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
