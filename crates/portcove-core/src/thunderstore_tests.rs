use super::*;
use crate::ProviderFreshness;
use crate::thunderstore::ListingFixture;
use serde_json::json;
use std::sync::{Arc, Mutex};

const WEB: &str = "https://thunderstore.io";

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

fn simple_package(owner: &str, name: &str) -> Value {
    package(
        "WEB_ROOT_PLACEHOLDER",
        owner,
        name,
        vec![version(
            "WEB_ROOT_PLACEHOLDER",
            owner,
            name,
            "1.0.0",
            "2026-11-01T00:00:00Z",
            true,
        )],
    )
}

/// A chunk of simulated packages whose canonical locations use `web`.
fn chunk(web: &str, owner: &str, names: impl IntoIterator<Item = String>) -> Value {
    let chunk = names
        .into_iter()
        .map(|name| simple_package(owner, &name))
        .collect::<Vec<_>>();
    serde_json::from_str(
        &json!(chunk)
            .to_string()
            .replace("WEB_ROOT_PLACEHOLDER", web),
    )
    .unwrap()
}

fn host_root(request: &str) -> String {
    let host = request
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(key, _)| key.eq_ignore_ascii_case("host"))
        })
        .map(|(_, value)| value.trim().to_owned())
        .unwrap();
    format!("http://{host}")
}

fn path_of(request: &str) -> String {
    request.split_whitespace().nth(1).unwrap().to_owned()
}

const UNAVAILABLE: &[u8] =
    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const MISSING: &[u8] = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

#[tokio::test]
async fn read_chunks_are_reused_and_an_outage_serves_the_last_complete_listing() {
    let calls = Arc::new(Mutex::new(0usize));
    let seen = calls.clone();
    let (root, requests, server) = crate::test_http::serve_routed_http_bytes(4, move |request| {
        let web = host_root(request);
        let path = path_of(request);
        let mut calls = seen.lock().unwrap();
        if path.ends_with("package-listing-index/") {
            *calls += 1;
            if *calls == 3 {
                return UNAVAILABLE.to_vec();
            }
        }
        listing_fixture(
            &path,
            &web,
            "zelda-64-recompiled",
            &[chunk(&web, "A", ["One".to_owned(), "Two".to_owned()])],
        )
        .unwrap()
    });
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = ThunderstoreClient::with_root(&root, Some(library)).unwrap();
    let first = client.community("zelda-64-recompiled").await.unwrap();
    assert_eq!(first.freshness, ProviderFreshness::Fresh);
    assert_eq!(first.value.len(), 2);
    let second = client.community("zelda-64-recompiled").await.unwrap();
    assert_eq!(second.freshness, ProviderFreshness::Revalidated);
    assert_eq!(second.value, first.value);
    let third = client.community("zelda-64-recompiled").await.unwrap();
    assert_eq!(
        third.freshness,
        ProviderFreshness::Stale,
        "an outage is earlier data, not empty"
    );
    assert_eq!(third.value, first.value);
    server.join().unwrap();
    let paths = requests
        .try_iter()
        .map(|request| path_of(&request))
        .collect::<Vec<_>>();
    // The content-addressed chunk is read once; later reads only check the index.
    assert_eq!(paths.len(), 4, "{paths:?}");
    assert_eq!(
        paths[0],
        "/c/zelda-64-recompiled/api/v1/package-listing-index/"
    );
    assert!(paths[1].starts_with("/listing-chunk/"));
    assert!(
        paths[2..]
            .iter()
            .all(|path| path.ends_with("/package-listing-index/"))
    );
    assert!(client.community("../x").await.is_err());
    assert!(
        client
            .project("zelda-64-recompiled", "nodash")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn an_outage_before_any_complete_read_is_an_error_not_an_empty_community() {
    let (root, _requests, server) =
        crate::test_http::serve_routed_http_bytes(1, |_| UNAVAILABLE.to_vec());
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = ThunderstoreClient::with_root(&root, Some(library)).unwrap();
    assert!(client.community("zelda-64-recompiled").await.is_err());
    server.join().unwrap();
}

// The removed single-response listing failed past `MAX_PACKAGES` (20,000) and,
// first, past its 4 MiB response bound (about 1,700 packages).
const OLD_PACKAGE_CEILING: usize = 20_000;

#[tokio::test]
async fn a_community_past_the_old_package_ceiling_is_read_completely_through_redirects() {
    let per_chunk = 1_000;
    let chunks = OLD_PACKAGE_CEILING / per_chunk + 1;
    // Built and compressed once, on the first request, for the fixture's host.
    let built = Arc::new(std::sync::OnceLock::<ListingFixture>::new());
    let (root, requests, server) = crate::test_http::serve_routed_http_bytes(
        chunks + 2,
        move |request| {
            let web = host_root(request);
            let path = path_of(request);
            let fixture = built.get_or_init(|| {
                let listing = (0..chunks)
                    .map(|index| {
                        chunk(
                            &web,
                            "A",
                            (0..per_chunk).map(move |position| {
                                format!("Mod{}", index * per_chunk + position)
                            }),
                        )
                    })
                    .collect::<Vec<_>>();
                ListingFixture::new(&web, "big", &listing)
            });
            // Thunderstore answers the index with a redirect to a blob.
            let index = format!("/c/{}/api/v1/package-listing-index/", "big");
            if path == index {
                return format!(
                    "HTTP/1.1 302 Found\r\nLocation: {web}/blob/index\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .into_bytes();
            }
            let path = if path.ends_with("blob/index") {
                index
            } else {
                path
            };
            fixture.respond(&path).unwrap()
        },
    );
    let client = ThunderstoreClient::with_root(&root, None).unwrap();
    let observed = client.community_catalog("big").await.unwrap();
    server.join().unwrap();
    let (projects, total) = observed.value;
    assert_eq!(total, chunks * per_chunk);
    assert!(total > OLD_PACKAGE_CEILING);
    assert_eq!(projects.len(), total);
    let last = format!("A-Mod{}", total - 1);
    assert!(projects.iter().any(|project| project.project_id == last));
    assert_eq!(requests.try_iter().count(), chunks + 2);
}

#[tokio::test]
async fn an_interrupted_listing_is_incomplete_and_the_next_read_continues_with_new_packages() {
    // Three chunks. The first read stops at the second chunk; meanwhile a
    // package is published, which changes only the last chunk. The next read
    // reuses the chunk it already has, reads the rest and includes the new one.
    let published = Arc::new(Mutex::new(false));
    let state = published.clone();
    let chunk_requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let log = chunk_requests.clone();
    let (root, _requests, server) = crate::test_http::serve_routed_http_bytes(6, move |request| {
        let web = host_root(request);
        let path = path_of(request);
        let mut published = state.lock().unwrap();
        let mut chunks = vec![
            chunk(&web, "A", (0..3).map(|index| format!("First{index}"))),
            chunk(&web, "A", (0..3).map(|index| format!("Second{index}"))),
            chunk(&web, "A", (0..3).map(|index| format!("Third{index}"))),
        ];
        if *published {
            chunks[2] = chunk(&web, "A", (0..4).map(|index| format!("Third{index}")));
        }
        if path.contains("listing-chunk/") {
            let mut log = log.lock().unwrap();
            log.push(path.clone());
            if log.len() == 2 {
                *published = true;
                return MISSING.to_vec();
            }
        }
        listing_fixture(&path, &web, "growing", &chunks).unwrap()
    });
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = ThunderstoreClient::with_root(&root, Some(library)).unwrap();
    let error = client.community_catalog("growing").await.unwrap_err();
    assert_eq!(
        error.details.get("inventory").map(String::as_str),
        Some("incomplete")
    );
    assert_eq!(
        error.details.get("chunks_read").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        error.details.get("chunks_total").map(String::as_str),
        Some("3")
    );
    assert!(error.details.contains_key("provider_browse_url"));
    let observed = client.community_catalog("growing").await.unwrap();
    server.join().unwrap();
    let (projects, total) = observed.value;
    assert_eq!(total, 10);
    assert!(
        projects
            .iter()
            .any(|project| project.project_id == "A-Third3")
    );
    let chunk_requests = chunk_requests.lock().unwrap();
    // First chunk once, second twice (failed, then read), new third once.
    assert_eq!(chunk_requests.len(), 4, "{chunk_requests:?}");
    assert_eq!(chunk_requests[1], chunk_requests[2]);
    assert_ne!(chunk_requests[0], chunk_requests[3]);
}

fn three_chunks(web: &str) -> Vec<Value> {
    vec![
        chunk(web, "A", (0..3).map(|index| format!("First{index}"))),
        chunk(web, "A", (0..3).map(|index| format!("Second{index}"))),
        chunk(web, "A", (0..3).map(|index| format!("Third{index}"))),
    ]
}

#[tokio::test]
async fn many_reads_of_one_community_parse_each_chunk_once() {
    // An update check over many installed packages and a browse session read
    // the same community many times; the parsed listing is reused while the
    // chunk list is unchanged.
    let (root, requests, server) = crate::test_http::serve_routed_http_bytes(24, move |request| {
        let web = host_root(request);
        listing_fixture(&path_of(request), &web, "shared", &three_chunks(&web)).unwrap()
    });
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    for _ in 0..20 {
        // A fresh client per installed package, as the update check builds them.
        let client = ThunderstoreClient::with_root(&root, Some(library.clone())).unwrap();
        assert_eq!(client.community("shared").await.unwrap().value.len(), 9);
    }
    server.join().unwrap();
    assert_eq!(library.thunderstore_listings.parses(), 3);
    let chunk_reads = requests
        .try_iter()
        .filter(|request| path_of(request).contains("listing-chunk/"))
        .count();
    assert_eq!(chunk_reads, 3);
}

#[tokio::test]
async fn a_chunk_that_disagrees_with_its_named_digest_is_refused_and_not_kept() {
    let (root, _requests, server) = crate::test_http::serve_routed_http_bytes(4, move |request| {
        let web = host_root(request);
        let path = path_of(request);
        let fixture = ListingFixture::new(&web, "forged", &three_chunks(&web));
        if path.contains("listing-chunk/") {
            // Valid, parseable data that is not the content the location names.
            return crate::thunderstore::ok_bytes(&crate::thunderstore::gzip_fixture(&chunk(
                &web,
                "B",
                ["Other".to_owned()],
            )));
        }
        fixture.respond(&path).unwrap()
    });
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = ThunderstoreClient::with_root(&root, Some(library.clone())).unwrap();
    for _ in 0..2 {
        let error = client.community_catalog("forged").await.unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
    }
    server.join().unwrap();
    let store = library
        .downloads_dir()
        .join("provider-listing-v1")
        .join("thunderstore");
    assert!(std::fs::read_dir(&store).map_or(true, |mut entries| entries.next().is_none()));
}

#[tokio::test]
async fn a_damaged_stored_chunk_is_discarded_and_read_again() {
    let (root, requests, server) = crate::test_http::serve_routed_http_bytes(8, move |request| {
        let web = host_root(request);
        listing_fixture(&path_of(request), &web, "damaged", &three_chunks(&web)).unwrap()
    });
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let read =
        |library: &Library| ThunderstoreClient::with_root(&root, Some(library.clone())).unwrap();
    assert_eq!(
        read(&library)
            .community("damaged")
            .await
            .unwrap()
            .value
            .len(),
        9
    );
    let store = library
        .downloads_dir()
        .join("provider-listing-v1")
        .join("thunderstore");
    let stored = std::fs::read_dir(&store)
        .unwrap()
        .flatten()
        .next()
        .unwrap()
        .path();
    std::fs::write(&stored, b"not the chunk").unwrap();
    // A new library handle has no parsed snapshot, so the store is consulted.
    let reopened = Library::open(temporary.path()).unwrap();
    assert_eq!(
        read(&reopened)
            .community("damaged")
            .await
            .unwrap()
            .value
            .len(),
        9
    );
    server.join().unwrap();
    let chunk_reads = requests
        .try_iter()
        .filter(|request| path_of(request).contains("listing-chunk/"))
        .count();
    // Three on the first read; only the damaged chunk again on the second.
    assert_eq!(chunk_reads, 4);
}

#[tokio::test]
async fn stored_chunks_survive_heavy_use_of_the_shared_response_cache() {
    // The first read stops at the third chunk. Many other provider responses
    // then pass through the shared conditional cache; the continuation still
    // has the first two chunks, which live in their own store.
    let chunk_requests = Arc::new(Mutex::new(0usize));
    let state = chunk_requests.clone();
    let (root, requests, server) = crate::test_http::serve_routed_http_bytes(6, move |request| {
        let web = host_root(request);
        let path = path_of(request);
        if path.contains("listing-chunk/") {
            let mut count = state.lock().unwrap();
            *count += 1;
            if *count == 3 {
                return MISSING.to_vec();
            }
        }
        listing_fixture(&path, &web, "busy", &three_chunks(&web)).unwrap()
    });
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = ThunderstoreClient::with_root(&root, Some(library.clone())).unwrap();
    let error = client.community_catalog("busy").await.unwrap_err();
    assert!(error.is_inventory_incomplete());
    // More than the shared cache's 64 MiB, so its oldest rows are pruned.
    let filler = "x".repeat(256 * 1024);
    for index in 0..300 {
        library
            .store_http_cache(
                &format!("https://other.example/{index}"),
                None,
                None,
                &filler,
            )
            .unwrap();
    }
    let observed = client.community_catalog("busy").await.unwrap();
    server.join().unwrap();
    assert_eq!(observed.value.0.len(), 9);
    let chunk_reads = requests
        .try_iter()
        .filter(|request| path_of(request).contains("listing-chunk/"))
        .count();
    // Two chunks, the failed third, and the third again: no chunk re-read.
    assert_eq!(chunk_reads, 4);
}

#[tokio::test]
async fn redirects_away_from_thunderstore_are_refused_for_the_index_and_a_chunk() {
    for redirect_chunk in [false, true] {
        let (root, _requests, server) = crate::test_http::serve_routed_http_bytes(
            if redirect_chunk { 2 } else { 1 },
            move |request| {
                let web = host_root(request);
                let path = path_of(request);
                let foreign = "HTTP/1.1 302 Found\r\nLocation: https://example.com/blob\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                if !redirect_chunk || path.contains("listing-chunk/") {
                    return foreign.as_bytes().to_vec();
                }
                listing_fixture(&path, &web, "moved", &three_chunks(&web)).unwrap()
            },
        );
        let client = ThunderstoreClient::with_root(&root, None).unwrap();
        let error = client.community_catalog("moved").await.unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification, "{error:?}");
        assert!(!error.is_inventory_incomplete());
    }
}

#[tokio::test]
async fn a_rate_limit_pauses_further_requests_and_serves_the_earlier_listing() {
    let calls = Arc::new(Mutex::new(0usize));
    let seen = calls.clone();
    let (root, requests, server) = crate::test_http::serve_routed_http_bytes(5, move |request| {
        let web = host_root(request);
        let path = path_of(request);
        if path.ends_with("package-listing-index/") {
            let mut calls = seen.lock().unwrap();
            *calls += 1;
            if *calls == 2 {
                return b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
            }
        }
        listing_fixture(&path, &web, "limited", &three_chunks(&web)).unwrap()
    });
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = ThunderstoreClient::with_root(&root, Some(library)).unwrap();
    assert_eq!(
        client.community("limited").await.unwrap().freshness,
        ProviderFreshness::Fresh
    );
    let limited = client.community("limited").await.unwrap();
    assert_eq!(limited.freshness, ProviderFreshness::Stale);
    // During the provider's stated pause no request is sent at all.
    let paused = client.community("limited").await.unwrap();
    assert_eq!(paused.freshness, ProviderFreshness::Stale);
    assert_eq!(paused.value.len(), 9);
    server.join().unwrap();
    // Index and three chunks, then the limited index; the paused read sent none.
    assert_eq!(requests.try_iter().count(), 5);
}

#[test]
fn a_chunk_naming_another_site_is_refused() {
    let http = ProviderHttp::new(None, "Thunderstore", "thunderstore.io").unwrap();
    let index =
        reqwest::Url::parse("https://thunderstore.io/c/x/api/v1/package-listing-index/").unwrap();
    let gzip = |value: Value| {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, value.to_string().as_bytes()).unwrap();
        encoder.finish().unwrap()
    };
    let accepted = parse_index(
        &gzip(json!([
            "https://ccdn.thunderstore.io/live/blob-storage/sha256/a.blob"
        ])),
        &index,
        &http,
    )
    .unwrap();
    assert_eq!(accepted.len(), 1);
    for refused in [
        json!(["https://example.com/chunk"]),
        json!(["http://ccdn.thunderstore.io/chunk"]),
        json!(["https://user@ccdn.thunderstore.io/chunk"]),
        json!([
            "https://ccdn.thunderstore.io/a",
            "https://ccdn.thunderstore.io/a"
        ]),
    ] {
        assert!(parse_index(&gzip(refused), &index, &http).is_err());
    }
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
