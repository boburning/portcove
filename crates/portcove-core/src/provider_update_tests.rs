use super::*;
use crate::GameBananaClient;
use crate::test_http::serve_http_bytes;
use crate::{ProfileRevisionRequest, ResolvedPackage, retained_build::tests::fixture};

fn json_response(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn project(version: &str, files: &[u64]) -> Vec<u8> {
    json_response(
        &serde_json::json!({
            "_sName": "HD Link", "_sVersion": version, "_bIsObsolete": false,
            "_tsDateUpdated": 5, "_aGame": {"_idRow": 777},
            "_aFiles": files.iter().map(|id| serde_json::json!({
                "_idRow": id, "_sFile": format!("pack-{id}.zip"), "_nFilesize": 10,
                "_tsDateAdded": id, "_bIsArchived": false
            })).collect::<Vec<_>>()
        })
        .to_string(),
    )
}

fn world() -> (tempfile::TempDir, PortcoveService, String) {
    let (temporary, service, _first) = fixture();
    let profile = service.ensure_default_profile("starship").unwrap().id;
    let package = |id: &str, project: &str, file: &str| ResolvedPackage {
        native_id: id.into(),
        native_version: None,
        provider: Some(ProviderPackageRef {
            provider: "gamebanana".into(),
            project: project.into(),
            file: Some(file.into()),
            version: Some("2.0".into()),
        }),
        sha256: "c".repeat(64),
        size: 10,
        enabled: true,
        requires: Vec::new(),
    };
    let request = ProfileRevisionRequest {
        expected_revision: 1,
        packages: Some(vec![
            package("a.o2r", "42", "10"),
            package("local.o2r", "", "0"),
        ]),
        orderings: Some(Vec::new()),
        ..Default::default()
    };
    let mut request = request;
    // A package without provider coordinates is ignored.
    request.packages.as_mut().unwrap()[1].provider = None;
    service
        .create_profile_revision("starship", &profile, &request)
        .unwrap();
    (temporary, service, profile)
}

async fn observe(responses: Vec<Vec<u8>>) -> Vec<ProviderUpdateObservation> {
    let (temporary, service, profile) = world();
    let (root, _requests, server) = serve_http_bytes(responses);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let observations = service
        .check_provider_updates_with(&client, "starship", &profile)
        .await
        .unwrap();
    server.join().unwrap();
    drop(temporary);
    observations
}

#[tokio::test]
async fn an_unchanged_project_is_current_and_local_packages_are_ignored() {
    let observations = observe(vec![project("2.0", &[10])]).await;
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].native_id, "a.o2r");
    assert_eq!(observations[0].state, ProviderUpdateState::Current);
    assert!(!observations[0].version_changed);
}

#[tokio::test]
async fn a_new_file_under_an_unchanged_version_is_reported_and_ordered() {
    let observations = observe(vec![project("2.0", &[10, 13, 11])]).await;
    let update = &observations[0];
    assert_eq!(update.state, ProviderUpdateState::NewerFiles);
    assert!(!update.version_changed, "same label, different bytes");
    let ids = update
        .newer_files
        .iter()
        .map(|f| f.file_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        ["11", "13"],
        "several candidates stay an ambiguous choice"
    );
    // A changed label is reported separately from file identity.
    let observations = observe(vec![project("3.0", &[10, 11])]).await;
    assert!(observations[0].version_changed);
}

#[tokio::test]
async fn a_removed_installed_file_and_an_outage_are_distinct_from_current() {
    let removed = observe(vec![project("2.0", &[9])]).await;
    assert_eq!(removed[0].state, ProviderUpdateState::InstalledFileRemoved);
    let outage = observe(vec![
        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec(),
    ])
    .await;
    assert_eq!(outage[0].state, ProviderUpdateState::Unavailable);
    assert!(outage[0].reason.is_some());
    assert!(
        outage[0].newer_files.is_empty(),
        "an outage never claims no update"
    );
}

#[tokio::test]
async fn an_obsolete_project_is_called_out_even_when_the_file_is_current() {
    let body = serde_json::json!({
        "_sName": "HD Link", "_sVersion": "2.0", "_bIsObsolete": true,
        "_tsDateUpdated": 5, "_aGame": {"_idRow": 777},
        "_aFiles": [{"_idRow": 10, "_sFile": "pack-10.zip", "_nFilesize": 10,
            "_tsDateAdded": 10, "_bIsArchived": false}]
    })
    .to_string();
    let observations = observe(vec![json_response(&body)]).await;
    assert_eq!(observations[0].state, ProviderUpdateState::Current);
    assert!(
        observations[0]
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("obsolete"))
    );
}

#[tokio::test]
async fn an_incomplete_file_list_is_unavailable_not_removed() {
    // The installed file's record cannot be read (no size): coverage is
    // incomplete, so "removed" or "current" cannot be concluded.
    let body = serde_json::json!({
        "_sName": "HD Link", "_sVersion": "2.0", "_bIsObsolete": false,
        "_tsDateUpdated": 5, "_aGame": {"_idRow": 777},
        "_aFiles": [{"_idRow": 10, "_sFile": "pack-10.zip",
            "_tsDateAdded": 10, "_bIsArchived": false}]
    })
    .to_string();
    let observations = observe(vec![json_response(&body)]).await;
    assert_eq!(observations[0].state, ProviderUpdateState::Unavailable);
    assert!(
        observations[0]
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("could not read"))
    );
}

#[tokio::test]
async fn an_unreadable_installed_identity_is_reported_not_dropped() {
    let (temporary, service, profile) = world();
    let connection = service.library().connection().unwrap();
    let current = crate::profile::current_revision(&connection, "starship", &profile).unwrap();
    let mut packages = current.packages.clone();
    packages[0].provider.as_mut().unwrap().file = Some("not-a-number".into());
    service
        .create_profile_revision(
            "starship",
            &profile,
            &ProfileRevisionRequest {
                expected_revision: current.revision,
                packages: Some(packages),
                ..Default::default()
            },
        )
        .unwrap();
    let (root, _requests, server) = serve_http_bytes(Vec::new());
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let observations = service
        .check_provider_updates_with(&client, "starship", &profile)
        .await
        .unwrap();
    drop(server);
    drop(temporary);
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].state, ProviderUpdateState::Unavailable);
}
