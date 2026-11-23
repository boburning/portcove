use super::*;
use crate::{ProviderFreshness, test_http::serve_http};
use serde_json::json;

const WEB: &str = "https://thunderstore.io";

fn ok_json(body: &str, headers: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

// Shapes captured from the live community listing on November 12, 2026 (values
// synthetic).
fn version(web: &str, owner: &str, name: &str, number: &str, created: &str, active: bool) -> Value {
    json!({
        "name": name,
        "full_name": format!("{owner}-{name}-{number}"),
        "version_number": number,
        "dependencies": ["Other-Api-1.0.0"],
        "download_url": format!("{web}/package/download/{owner}/{name}/{number}/"),
        "downloads": 3,
        "date_created": created,
        "is_active": active,
        "file_size": 1234,
    })
}

fn package(web: &str, owner: &str, name: &str, versions: Vec<Value>) -> Value {
    json!({
        "name": name,
        "full_name": format!("{owner}-{name}"),
        "owner": owner,
        "package_url": format!("{web}/c/zelda-64-recompiled/p/{owner}/{name}/"),
        "date_updated": "2026-11-10T00:00:00Z",
        "is_deprecated": false,
        "versions": versions,
    })
}

#[test]
fn listings_bind_package_identity_versions_and_canonical_downloads() {
    let listing = json!([
        package(
            WEB,
            "Owner",
            "Timer",
            vec![
                version(WEB, "Owner", "Timer", "1.1.0", "2026-11-02T00:00:00Z", true),
                version(WEB, "Owner", "Timer", "1.0.0", "2026-11-01T00:00:00Z", true),
                version(
                    WEB,
                    "Owner",
                    "Timer",
                    "0.9.0",
                    "2026-10-01T00:00:00Z",
                    false
                ),
            ]
        ),
        // A record whose download location is not canonical is not a candidate.
        package(
            WEB,
            "Owner",
            "Elsewhere",
            vec![{
                let mut v = version(
                    WEB,
                    "Owner",
                    "Elsewhere",
                    "1.0.0",
                    "2026-11-01T00:00:00Z",
                    true,
                );
                v["download_url"] = json!("https://example.com/evil.zip");
                v
            }]
        ),
        // Identities that are not plain names are dropped.
        package(WEB, "Own/er", "Bad", vec![]),
    ]);
    let projects = parse_listing(&listing, "zelda-64-recompiled", WEB).unwrap();
    assert_eq!(projects.len(), 2);
    let timer = &projects[0];
    assert_eq!(timer.project_id, "Owner-Timer");
    assert_eq!(timer.provider, PROVIDER);
    assert_eq!(timer.game_id.as_deref(), Some("zelda-64-recompiled"));
    assert_eq!(
        timer.version.as_deref(),
        Some("1.1.0"),
        "the newest active version"
    );
    assert_eq!(timer.files.len(), 3);
    assert_eq!(timer.files[0].file_name, "Owner-Timer-1.1.0.zip");
    assert_eq!(
        timer.files[0].download_url,
        "https://thunderstore.io/package/download/Owner/Timer/1.1.0/"
    );
    assert!(
        timer.files[2].archived,
        "an inactive version is not offered"
    );
    assert!(timer.files[0].claimed_md5.is_none());
    assert_eq!(
        timer.files[0].thunderstore_dependencies.as_deref(),
        Some(
            &[ThunderstoreDependency {
                namespace: "Other".into(),
                package: "Api".into(),
                version: "1.0.0".into(),
            }][..]
        )
    );
    let elsewhere = &projects[1];
    assert!(elsewhere.files.is_empty());
    assert_eq!(
        elsewhere.unreadable_files, 1,
        "an unreadable version is counted"
    );
    assert!(parse_listing(&json!({}), "c", WEB).is_err());
}

#[test]
fn incomplete_dependency_observations_make_the_version_unreadable() {
    let mut value = version(WEB, "Owner", "Timer", "1.0.0", "2026-11-01T00:00:00Z", true);
    value["dependencies"] = json!([]);
    assert_eq!(
        parse_version(&value, "Owner", "Timer", WEB)
            .unwrap()
            .thunderstore_dependencies,
        Some(vec![])
    );
    for dependencies in [
        Value::Null,
        json!(["Other-Api-1.0.0", "Other-Api-latest"]),
        json!(["Other/Api-Dependency-1.0.0"]),
        json!(vec!["Other-Api-1.0.0"; MAX_DEPENDENCIES + 1]),
    ] {
        value["dependencies"] = dependencies;
        assert!(parse_version(&value, "Owner", "Timer", WEB).is_none());
    }
}

#[test]
fn resolves_only_exact_provider_dependencies_in_dependency_order() {
    let package_with = |name: &str, dependencies: &[&str]| {
        let mut file = version(WEB, "Owner", name, "1.0.0", "2026-11-01T00:00:00Z", true);
        file["dependencies"] = json!(dependencies);
        package(WEB, "Owner", name, vec![file])
    };
    let source = [
        package_with("Main", &["Owner-B-1.0.0", "Owner-C-1.0.0"]),
        package_with("B", &["Owner-Shared-1.0.0"]),
        package_with("C", &["Owner-Shared-1.0.0"]),
        package_with("Shared", &[]),
    ];
    let resolve = |source: &[Value]| {
        let listing = parse_listing(&json!(source), "c", WEB).unwrap();
        resolve_dependencies(&listing, "Owner-Main", "1.0.0").map(|files| {
            files
                .into_iter()
                .map(|(project, _)| project.project_id.clone())
                .collect::<Vec<_>>()
        })
    };
    assert_eq!(
        resolve(&source).unwrap(),
        ["Owner-Shared", "Owner-B", "Owner-C", "Owner-Main"]
    );

    let mut missing = source.clone();
    missing[0]["versions"][0]["dependencies"] = json!(["Owner-Shared-1.1.0"]);
    assert_eq!(
        resolve(&missing).unwrap_err().code,
        crate::ErrorCode::NotFound
    );
    let mut cyclic = source.clone();
    cyclic[3]["versions"][0]["dependencies"] = json!(["Owner-Main-1.0.0"]);
    assert_eq!(
        resolve(&cyclic).unwrap_err().code,
        crate::ErrorCode::Conflict
    );
    let mut conflicting = source.clone();
    conflicting[2]["versions"][0]["dependencies"] = json!(["Owner-Shared-1.1.0"]);
    assert_eq!(
        resolve(&conflicting).unwrap_err().details["other_version"],
        "1.0.0"
    );
    let mut duplicate = source.to_vec();
    duplicate.push(source[3].clone());
    assert_eq!(
        resolve(&duplicate).unwrap_err().code,
        crate::ErrorCode::Verification
    );
}

#[test]
fn browsing_pages_the_listing_without_claiming_a_page_is_everything() {
    let listing = json!(
        (0..45)
            .map(|i| {
                let name = format!("Mod{i}");
                package(
                    WEB,
                    "A",
                    &name,
                    vec![version(
                        WEB,
                        "A",
                        &name,
                        "1.0.0",
                        "2026-11-01T00:00:00Z",
                        true,
                    )],
                )
            })
            .collect::<Vec<_>>()
    );
    let projects = parse_listing(&listing, "c", WEB).unwrap();
    let first = page_of(projects.clone(), 1, 20);
    assert_eq!(first.projects.len(), 20);
    assert_eq!(first.total, 45);
    assert!(!first.complete);
    let last = page_of(projects.clone(), 3, 20);
    assert_eq!(last.projects.len(), 5);
    assert_eq!(last.projects[0].project_id, "A-Mod40");
    assert!(last.complete);
    assert!(page_of(projects, 9, 20).projects.is_empty());
}

#[tokio::test]
async fn the_listing_is_read_conditionally_and_falls_back_to_earlier_data_on_outage() {
    let (root, requests, server) = serve_http(vec![
        ok_json("[]", "Last-Modified: Thu, 12 Nov 2026 13:54:50 GMT\r\n"),
        "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".into(),
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    ]);
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = ThunderstoreClient::with_root(&root, Some(library)).unwrap();
    let first = client.community("zelda-64-recompiled").await.unwrap();
    assert_eq!(first.freshness, ProviderFreshness::Fresh);
    assert!(first.value.is_empty());
    let second = client.community("zelda-64-recompiled").await.unwrap();
    assert_eq!(second.freshness, ProviderFreshness::Revalidated);
    let third = client.community("zelda-64-recompiled").await.unwrap();
    assert_eq!(
        third.freshness,
        ProviderFreshness::Stale,
        "an outage is earlier data, not empty"
    );
    server.join().unwrap();
    let requests = requests.try_iter().collect::<Vec<_>>();
    assert!(requests[0].starts_with("GET /c/zelda-64-recompiled/api/v1/package/ "));
    assert!(
        requests[1]
            .to_ascii_lowercase()
            .contains("if-modified-since")
    );
    assert!(client.community("../x").await.is_err());
    assert!(
        client
            .project("zelda-64-recompiled", "nodash")
            .await
            .is_err()
    );
}

#[test]
fn only_reviewed_communities_are_bound() {
    assert_eq!(
        thunderstore_community("zelda64-recomp"),
        Some("zelda-64-recompiled")
    );
    assert_eq!(thunderstore_community("shipwright"), None);
}

#[test]
fn thunderstore_flags_distinguish_absent_null_malformed_and_boolean() {
    use crate::ProviderStatusUnknown::{Malformed, Null, Omitted};
    for (raw, expected, flag) in [
        (None, Some(Omitted), false),
        (Some(Value::Null), Some(Null), false),
        (Some(json!("false")), Some(Malformed), false),
        (Some(json!(true)), None, true),
        (Some(json!(false)), None, false),
    ] {
        let mut candidate = version(WEB, "Owner", "Timer", "1.0.0", "2026-11-02T00:00:00Z", true);
        let mut project = package(WEB, "Owner", "Timer", Vec::new());
        if let Some(raw) = raw {
            candidate["is_active"] = raw.clone();
            project["is_deprecated"] = raw;
        } else {
            candidate.as_object_mut().unwrap().remove("is_active");
            project.as_object_mut().unwrap().remove("is_deprecated");
        }
        project["versions"] = json!([candidate]);
        let listing = parse_listing(&json!([project]), "zelda-64-recompiled", WEB).unwrap();
        let parsed = &listing[0];
        assert_eq!(parsed.status_unknown, expected);
        assert_eq!(parsed.obsolete, flag);
        assert_eq!(parsed.files[0].status_unknown, expected);
        assert_eq!(parsed.files[0].archived, !flag);
    }
}

fn closure_listing(packages: &[(String, Vec<String>)]) -> Vec<ProviderProject> {
    let source = packages
        .iter()
        .map(|(name, dependencies)| {
            let mut file = version(WEB, "Owner", name, "1.0.0", "2026-11-01T00:00:00Z", true);
            file["dependencies"] = json!(
                dependencies
                    .iter()
                    .map(|dependency| format!("Owner-{dependency}-1.0.0"))
                    .collect::<Vec<_>>()
            );
            package(WEB, "Owner", name, vec![file])
        })
        .collect::<Vec<_>>();
    parse_listing(&json!(source), "c", WEB).unwrap()
}

#[test]
fn closures_past_the_former_sixty_four_package_bound_resolve_completely() {
    for size in [65, 500] {
        // A modpack naming every package directly, past the former per-version
        // limit of 128 direct requirements when large enough.
        let mut packages = (0..size)
            .map(|index| (format!("Dep{index}"), Vec::new()))
            .collect::<Vec<_>>();
        packages.push((
            "Pack".into(),
            (0..size).map(|index| format!("Dep{index}")).collect(),
        ));
        let listing = closure_listing(&packages);
        let files = resolve_dependencies(&listing, "Owner-Pack", "1.0.0").unwrap();
        assert_eq!(files.len(), size + 1);
        assert_eq!(files.last().unwrap().0.project_id, "Owner-Pack");

        // A chain as deep as the closure is wide: requirements come first.
        let chain = (0..size)
            .map(|index| {
                let requires = (index + 1 < size)
                    .then(|| format!("Link{}", index + 1))
                    .into_iter()
                    .collect();
                (format!("Link{index}"), requires)
            })
            .collect::<Vec<_>>();
        let listing = closure_listing(&chain);
        let files = resolve_dependencies(&listing, "Owner-Link0", "1.0.0").unwrap();
        assert_eq!(files.len(), size);
        assert_eq!(files[0].0.project_id, format!("Owner-Link{}", size - 1));
        assert_eq!(files.last().unwrap().0.project_id, "Owner-Link0");

        // A cycle closing at the far end is still found.
        let mut cyclic = chain.clone();
        cyclic.last_mut().unwrap().1 = vec!["Link0".into()];
        let listing = closure_listing(&cyclic);
        assert_eq!(
            resolve_dependencies(&listing, "Owner-Link0", "1.0.0")
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );

        // A requirement the listing does not offer is an explicit failure that
        // names it, never an empty remainder of the closure.
        let mut incomplete = chain.clone();
        incomplete.pop();
        let listing = closure_listing(&incomplete);
        let missing = resolve_dependencies(&listing, "Owner-Link0", "1.0.0").unwrap_err();
        assert_eq!(missing.code, crate::ErrorCode::NotFound);
        assert_eq!(
            missing.details["project"],
            format!("Owner-Link{}", size - 1)
        );
    }
}

#[test]
fn a_closure_larger_than_one_setup_is_refused_with_the_setup_capacity() {
    let capacity = crate::setup_capacity::MAX_SETUP_PACKAGES;
    let mut packages = (0..capacity)
        .map(|index| (format!("Dep{index}"), Vec::new()))
        .collect::<Vec<_>>();
    packages.push((
        "Pack".into(),
        (0..capacity).map(|index| format!("Dep{index}")).collect(),
    ));
    let listing = closure_listing(&packages);
    let refused = resolve_dependencies(&listing, "Owner-Pack", "1.0.0").unwrap_err();
    assert_eq!(refused.code, crate::ErrorCode::Unsupported);
    assert_eq!(refused.details["setup_capacity"], capacity.to_string());
}
