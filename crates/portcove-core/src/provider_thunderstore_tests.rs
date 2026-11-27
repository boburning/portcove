//! Thunderstore through the shared provider lifecycle: a community-bound Recomp
//! game, packages named by their manifests, and code that waits for consent.
use std::{
    fs,
    io::{Cursor, Write},
    sync::{Arc, Mutex},
};

use crate::{
    Library, PortcoveService, ProviderUpdateState, ThunderstoreClient,
    provider_auto_update::ProviderAutoUpdateOutcome, provider_client::ProviderClient,
    retained_build::tests::install_port, test_http::serve_routed_http_bytes,
};

const PORT: &str = "zelda64-recomp";
const COMMUNITY: &str = "zelda-64-recompiled";

fn nrm(id: &str, code: bool) -> Vec<u8> {
    nrm_with(id, code.then_some(b"\x01".as_slice()))
}

fn nrm_with(id: &str, code: Option<&[u8]>) -> Vec<u8> {
    let manifest = serde_json::to_vec(&serde_json::json!({
        "game_id": "mm", "id": id, "display_name": "Timer", "version": "1.0.0",
        "authors": ["someone"], "minimum_recomp_version": "1.2.0",
    }))
    .unwrap();
    let mut entries: Vec<(&str, &[u8])> = vec![("mod.json", &manifest), ("textures/a.png", b"png")];
    if let Some(code) = code {
        entries.push(("mod_binary.bin", code));
        entries.push(("mod_syms.bin", b"\0"));
    }
    zip_bytes(&entries)
}

fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// The Thunderstore package zip: a manifest, an icon and the `.nrm` inside.
fn wrapper(name: &str, version: &str, dependencies: &[&str], members: &[(&str, &[u8])]) -> Vec<u8> {
    let manifest = serde_json::to_vec(&serde_json::json!({
        "name": name, "version_number": version, "dependencies": dependencies,
    }))
    .unwrap();
    let mut entries = vec![("manifest.json", manifest.as_slice()), ("icon.png", b"png")];
    entries.extend_from_slice(members);
    zip_bytes(&entries)
}

fn package_zip(version: &str, file_name: &str, nrm: &[u8]) -> Vec<u8> {
    wrapper("Timer", version, &[], &[(file_name, nrm)])
}

/// Versions offered by the fake community: (version, created, zip bytes).
type Versions = Arc<Mutex<Vec<(String, String, Vec<u8>)>>>;

fn serve(
    versions: Versions,
    dependency: Option<Vec<u8>>,
) -> (
    String,
    std::sync::mpsc::Receiver<String>,
    crate::test_http::HttpServer,
) {
    let (root, requests, server) = serve_routed_http_bytes(64, move |request| {
        let host = request
            .lines()
            .find_map(|line| {
                line.strip_prefix("Host: ")
                    .or_else(|| line.strip_prefix("host: "))
            })
            .unwrap_or("")
            .trim()
            .to_owned();
        let web = format!("http://{host}");
        let path = request.split_whitespace().nth(1).unwrap_or("");
        let dependency_url = format!("{web}/package/download/Tools/Shared/2.1.0/");
        let versions = versions.lock().unwrap();
        if path == format!("/c/{COMMUNITY}/api/v1/package-listing-index/")
            || path.contains("listing-chunk/")
        {
            let mut listing = vec![serde_json::json!({
                "name": "Timer", "full_name": "Owner-Timer", "owner": "Owner",
                "date_updated": "2026-11-10T00:00:00Z", "is_deprecated": false,
                "versions": versions.iter().map(|(version, created, bytes)| serde_json::json!({
                    "name": "Timer", "full_name": format!("Owner-Timer-{version}"),
                    "version_number": version, "dependencies": if dependency.is_some() { vec!["Tools-Shared-2.1.0"] } else { vec![] },
                    "download_url": format!("{web}/package/download/Owner/Timer/{version}/"),
                    "date_created": created, "is_active": true, "file_size": bytes.len(),
                })).collect::<Vec<_>>(),
            })];
            if let Some(bytes) = &dependency {
                listing.push(serde_json::json!({
                    "name": "Shared", "full_name": "Tools-Shared", "owner": "Tools",
                    "date_updated": "2026-11-10T00:00:00Z", "is_deprecated": false,
                    "versions": [{
                        "name": "Shared", "full_name": "Tools-Shared-2.1.0",
                        "version_number": "2.1.0", "dependencies": [],
                        "download_url": dependency_url,
                        "date_created": "2026-11-10T00:00:00Z", "is_active": true,
                        "file_size": bytes.len(),
                    }],
                }));
            }
            return crate::thunderstore::listing_fixture(
                path,
                &web,
                COMMUNITY,
                &[serde_json::json!(listing)],
            )
            .expect("a current listing chunk");
        }
        if format!("{web}{path}") == dependency_url
            && let Some(bytes) = &dependency
        {
            let mut response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .into_bytes();
            response.extend_from_slice(bytes);
            return response;
        }
        for (version, _, bytes) in versions.iter() {
            if path == format!("/package/download/Owner/Timer/{version}/") {
                // Thunderstore redirects to its content host; here, the same host.
                return format!(
                    "HTTP/1.1 302 Found\r\nLocation: /cdn/Owner-Timer-{version}.zip\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .into_bytes();
            }
            if path == format!("/cdn/Owner-Timer-{version}.zip") {
                let mut response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    bytes.len()
                )
                .into_bytes();
                response.extend_from_slice(bytes);
                return response;
            }
        }
        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
    });
    (root, requests, server)
}

struct World {
    _temporary: tempfile::TempDir,
    service: PortcoveService,
    profile: String,
    client: ProviderClient,
    versions: Versions,
    // The routed fixture stops answering once its request receiver is dropped.
    _requests: std::sync::mpsc::Receiver<String>,
    _server: crate::test_http::HttpServer,
}

fn world() -> World {
    world_with_dependency(None)
}

fn world_with_dependency(dependency: Option<Vec<u8>>) -> World {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    install_port(&library, PORT, "first", b"recomp runtime", true);
    let service = PortcoveService::new_read_only(library).unwrap();
    let profile = service.ensure_default_profile(PORT).unwrap().id;
    let versions: Versions = Arc::new(Mutex::new(vec![(
        "1.0.0".into(),
        "2026-11-01T00:00:00Z".into(),
        wrapper(
            "Timer",
            "1.0.0",
            if dependency.is_some() {
                &["Tools-Shared-2.1.0"]
            } else {
                &[]
            },
            &[("timer.nrm", &nrm("speed_timer", false))],
        ),
    )]));
    let (root, requests, server) = serve(versions.clone(), dependency);
    let client = ProviderClient::Thunderstore {
        client: ThunderstoreClient::with_root(&root, None).unwrap(),
        community: COMMUNITY.into(),
    };
    World {
        _temporary: temporary,
        service,
        profile,
        client,
        versions,
        _requests: requests,
        _server: server,
    }
}

fn live(w: &World) -> Vec<String> {
    let mut names = fs::read_dir(w.service.library().user_dir(PORT).join("mods"))
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_else(|_| Vec::new());
    names.sort();
    names
}

#[tokio::test]
async fn a_thunderstore_package_installs_by_manifest_id_and_its_update_is_discovered() {
    let w = world();
    let page = w
        .service
        .browse_provider_mods_via(&w.client, PORT, 1)
        .await
        .unwrap();
    assert_eq!(page.provider, "thunderstore");
    assert_eq!(page.page.projects[0].project_id, "Owner-Timer");

    let plan = w
        .service
        .plan_provider_install_via(&w.client, PORT, &w.profile, "Owner-Timer", "1.0.0")
        .await
        .unwrap();
    assert_eq!(plan.provider.provider, "thunderstore");
    assert_eq!(plan.provider.version.as_deref(), Some("1.0.0"));
    assert_eq!(
        plan.members.len(),
        1,
        "the manifest and icon are not packages"
    );
    assert_eq!(
        plan.members[0].file_name, "speed_timer.nrm",
        "named by its manifest ID"
    );
    assert!(plan.members[0].runs_code.is_empty());
    let token = w.service.authorize_provider_install(&plan).unwrap().token;
    let revision = w.service.apply_provider_install(&plan, &token).unwrap();
    assert_eq!(revision.packages[0].native_id, "speed_timer.nrm");
    assert_eq!(live(&w), ["speed_timer.nrm"]);

    // A later version is discovered by its publish date.
    w.versions.lock().unwrap().push((
        "1.1.0".into(),
        "2026-11-05T00:00:00Z".into(),
        package_zip("1.1.0", "timer.nrm", &nrm("speed_timer", false)),
    ));
    let observations = w
        .service
        .check_provider_updates_via(&w.client, PORT, &w.profile)
        .await
        .unwrap();
    assert_eq!(observations[0].state, ProviderUpdateState::NewerFiles);
    assert_eq!(observations[0].newer_files[0].file_id, "1.1.0");
}

#[tokio::test]
async fn code_from_thunderstore_needs_explicit_consent_and_never_updates_unattended() {
    let w = world();
    // Already named by its manifest ID, as many published packages are.
    w.versions.lock().unwrap()[0].2 =
        package_zip("1.0.0", "speed_timer.nrm", &nrm("speed_timer", true));
    let plan = w
        .service
        .plan_provider_install_via(&w.client, PORT, &w.profile, "Owner-Timer", "1.0.0")
        .await
        .unwrap();
    assert_eq!(
        plan.members[0].runs_code,
        [crate::RecompExecution::RecompiledCode]
    );
    let error = w.service.authorize_provider_install(&plan).unwrap_err();
    assert!(error.message.contains("runs its own code"), "{error:?}");
    assert!(live(&w).is_empty(), "nothing was installed");
    let token = w
        .service
        .authorize_provider_install_allowing_code(&plan)
        .unwrap()
        .token;
    w.service.apply_provider_install(&plan, &token).unwrap();
    assert_eq!(live(&w), ["speed_timer.nrm"]);

    // A newer version is new code: the unattended pass holds it.
    w.service
        .set_profile_update_policy(
            PORT,
            &w.profile,
            crate::ProfileUpdatePolicy::AutomaticEligible,
        )
        .unwrap();
    w.versions.lock().unwrap().push((
        "1.1.0".into(),
        "2026-11-05T00:00:00Z".into(),
        package_zip(
            "1.1.0",
            "timer.nrm",
            &nrm_with("speed_timer", Some(b"\x02")),
        ),
    ));
    let results = w
        .service
        .run_eligible_provider_updates_via(&w.client, PORT)
        .await
        .unwrap();
    let outcome = &results.first().expect("one result").outcome;
    assert!(
        matches!(outcome, ProviderAutoUpdateOutcome::Held { reason } if reason.contains("runs its own code")),
        "{outcome:?}"
    );
    assert_eq!(live(&w), ["speed_timer.nrm"]);
}

#[tokio::test]
async fn recomp_plans_compare_no_asset_entries_and_unattended_updates_take_the_newest_version() {
    let w = world();
    let plan = w
        .service
        .plan_provider_install_via(&w.client, PORT, &w.profile, "Owner-Timer", "1.0.0")
        .await
        .unwrap();
    let token = w.service.authorize_provider_install(&plan).unwrap().token;
    w.service.apply_provider_install(&plan, &token).unwrap();
    w.service
        .set_profile_update_policy(
            PORT,
            &w.profile,
            crate::ProfileUpdatePolicy::AutomaticEligible,
        )
        .unwrap();
    // 2.0.0, then a 1.x backport published later: the highest version wins.
    for (version, created, marker) in [
        ("1.1.0", "2026-11-05T00:00:00Z", "b"),
        ("2.0.0", "2026-11-06T00:00:00Z", "c"),
        ("1.5.0", "2026-11-07T00:00:00Z", "d"),
    ] {
        let bytes = zip_bytes(&[
            ("mod.json", &serde_json::to_vec(&serde_json::json!({
                "game_id": "mm", "id": "speed_timer", "display_name": "Timer", "version": "1.0.0",
                "authors": ["someone"], "minimum_recomp_version": "1.2.0",
            })).unwrap()),
            ("textures/a.png", marker.as_bytes()),
        ]);
        w.versions.lock().unwrap().push((
            version.into(),
            created.into(),
            package_zip(version, "timer.nrm", &bytes),
        ));
    }
    // An enabled Recomp mod's entries (mod.json and so on) are not conflicts.
    let plan = w
        .service
        .plan_provider_install_via(&w.client, PORT, &w.profile, "Owner-Timer", "1.1.0")
        .await
        .unwrap();
    assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
    assert_eq!(plan.members[0].asset_count, 0);
    w.service.discard_provider_install(&plan).unwrap();
    // Two newer versions of one line: the newest is applied.
    let results = w
        .service
        .run_eligible_provider_updates_via(&w.client, PORT)
        .await
        .unwrap();
    assert!(
        matches!(&results[0].outcome, ProviderAutoUpdateOutcome::Applied { file_id, .. } if file_id == "2.0.0"),
        "{:?}",
        results[0].outcome
    );
}

#[test]
fn a_backport_published_after_a_newer_release_is_not_an_update() {
    let client = ProviderClient::Thunderstore {
        client: ThunderstoreClient::with_root("http://127.0.0.1:9", None).unwrap(),
        community: COMMUNITY.into(),
    };
    let file = |version: &str, added_at: i64| crate::ProviderFileCandidate {
        file_id: version.into(),
        file_name: format!("Owner-Timer-{version}.zip"),
        size: 1,
        added_at,
        download_url: String::new(),
        claimed_md5: None,
        archived: false,
        status_unknown: None,
        claimed_scan: None,
        thunderstore_dependencies: None,
    };
    let installed = file("2.0.0", 10);
    assert!(!client.newer_than(&file("1.9.1", 20), "2.0.0", Some(&installed)));
    assert!(client.newer_than(&file("2.0.1", 20), "2.0.0", Some(&installed)));
    // No longer listed: only a higher version number counts.
    assert!(client.newer_than(&file("2.1.0", 1), "2.0.0", None));
    assert!(!client.newer_than(&file("1.0.0", 99), "2.0.0", None));
}

#[tokio::test]
async fn a_plan_stripped_of_its_code_marking_cannot_install_code_without_consent() {
    let w = world();
    w.versions.lock().unwrap()[0].2 = package_zip("1.0.0", "timer.nrm", &nrm("speed_timer", true));
    let plan = w
        .service
        .plan_provider_install_via(&w.client, PORT, &w.profile, "Owner-Timer", "1.0.0")
        .await
        .unwrap();
    let mut forged = plan.clone();
    forged.members[0].runs_code.clear();
    forged.plan_sha256 = crate::provider_install::digest(&forged).unwrap();
    // Even with the reviewed bytes staged under the forged plan, apply inspects
    // them again and refuses code no one allowed.
    let layout = w.service.deploy_layout(PORT).unwrap();
    let forged_dir = layout.staged(&forged.plan_sha256);
    fs::create_dir_all(&forged_dir).unwrap();
    for entry in fs::read_dir(layout.staged(&plan.plan_sha256)).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), forged_dir.join(entry.file_name())).unwrap();
    }
    let token = w.service.authorize_provider_install(&forged).unwrap().token;
    let error = w
        .service
        .apply_provider_install(&forged, &token)
        .unwrap_err();
    assert!(error.message.contains("runs its own code"), "{error:?}");
    assert!(live(&w).is_empty(), "nothing was installed");
}

#[tokio::test]
async fn allowing_code_on_a_plan_without_code_installs_it_as_a_plain_review() {
    let w = world();
    let plan = w
        .service
        .plan_provider_install_via(&w.client, PORT, &w.profile, "Owner-Timer", "1.0.0")
        .await
        .unwrap();
    assert!(
        plan.members
            .iter()
            .all(|member| member.runs_code.is_empty())
    );
    let token = w
        .service
        .authorize_provider_install_allowing_code(&plan)
        .unwrap()
        .token;
    w.service.apply_provider_install(&plan, &token).unwrap();
    assert_eq!(live(&w), ["speed_timer.nrm"]);
}

#[tokio::test]
async fn reviewed_thunderstore_closure_requires_all_exact_wrapper_members() {
    let dependency = wrapper(
        "Shared",
        "2.1.0",
        &[],
        &[
            ("first.nrm", &nrm("shared_first", false)),
            ("second.nrm", &nrm("shared_second", true)),
        ],
    );
    let w = world_with_dependency(Some(dependency));
    let plan = w
        .service
        .plan_provider_install_via(&w.client, PORT, &w.profile, "Owner-Timer", "1.0.0")
        .await
        .unwrap();
    assert!(live(&w).is_empty());
    assert_eq!(plan.wrappers.len(), 2);
    assert_eq!(plan.wrappers[0].provider.project, "Tools-Shared");
    assert_eq!(plan.wrappers[0].members.len(), 2);
    assert_eq!(plan.wrappers[1].provider.project, "Owner-Timer");
    let mut old_client_round_trip = plan.clone();
    old_client_round_trip.wrappers.clear();
    old_client_round_trip.file.thunderstore_dependencies = None;
    assert!(
        w.service
            .authorize_provider_install_allowing_code(&old_client_round_trip)
            .is_err()
    );

    let mut legacy_root = old_client_round_trip;
    let root = &plan.wrappers[1];
    legacy_root
        .members
        .retain(|member| root.members.contains_key(&member.file_name));
    assert_eq!(legacy_root.members.len(), 1);
    legacy_root.plan_sha256 = crate::provider_install::digest(&legacy_root).unwrap();
    let legacy_token = w
        .service
        .authorize_provider_install_allowing_code(&legacy_root)
        .unwrap()
        .token;
    let refused = w
        .service
        .apply_provider_install(&legacy_root, &legacy_token)
        .unwrap_err();
    assert!(refused.message.contains("wrapper set is incomplete"));
    assert!(live(&w).is_empty());
    assert!(
        w.service.authorize_provider_install(&plan).is_err(),
        "a dependency runs code"
    );

    let token = w
        .service
        .authorize_provider_install_allowing_code(&plan)
        .unwrap()
        .token;
    let revision = w.service.apply_provider_install(&plan, &token).unwrap();
    assert_eq!(
        live(&w),
        ["shared_first.nrm", "shared_second.nrm", "speed_timer.nrm"]
    );
    let source = w._temporary.path().join("speed_timer.nrm");
    fs::copy(
        w.service
            .library()
            .user_dir(PORT)
            .join("mods")
            .join("speed_timer.nrm"),
        &source,
    )
    .unwrap();
    let revision = w
        .service
        .install_mod_package(PORT, &w.profile, &source, revision.revision)
        .unwrap();
    let timer = revision
        .packages
        .iter()
        .find(|package| package.native_id == "speed_timer.nrm")
        .unwrap();
    assert_eq!(timer.provider.as_ref(), Some(&plan.wrappers[1].provider));
    assert_eq!(
        timer.provider_requires[0].provider,
        plan.wrappers[0].provider
    );
    assert_eq!(timer.provider_requires[0].members, plan.wrappers[0].members);
    assert!(
        w.service
            .set_mod_package_enabled(
                PORT,
                &w.profile,
                "shared_second.nrm",
                false,
                revision.revision,
            )
            .is_err()
    );
    let recipe = w
        .service
        .export_profile_recipe(PORT, &w.profile, None)
        .unwrap();
    assert_eq!(recipe.format, 2);
    assert_eq!(
        crate::ProfileRecipe::inspect_document(&serde_json::to_vec(&recipe).unwrap()).unwrap(),
        recipe
    );
    let mut omitted = recipe
        .packages
        .iter()
        .find(|package| package.native_id == "speed_timer.nrm")
        .unwrap()
        .clone();
    omitted.provider = None;
    omitted.provider_requires.clear();
    assert!(matches!(
        crate::profile::ProviderEvidenceIndex::read(
            &w.service.library().connection().unwrap(),
            PORT,
            [&omitted],
        )
        .unwrap()
        .evidence(&omitted, None),
        crate::profile::ProviderEvidence::RequirementsDiffer
    ));
    let mut masquerading_as_v1 = serde_json::to_value(&recipe).unwrap();
    masquerading_as_v1["format"] = serde_json::json!(1);
    let error =
        crate::ProfileRecipe::inspect_document(&serde_json::to_vec(&masquerading_as_v1).unwrap())
            .unwrap_err();
    assert!(
        error.message.contains("requirements need recipe format 2"),
        "{error:?}"
    );
    let remove = |revision: &crate::ProfileRevision| {
        let mut packages = revision.packages.clone();
        packages.retain(|package| package.native_id != "shared_first.nrm");
        let mut orderings = revision.orderings.clone();
        for order in &mut orderings {
            order.native_ids.retain(|id| id != "shared_first.nrm");
        }
        w.service.create_profile_revision(
            PORT,
            &w.profile,
            &crate::ProfileRevisionRequest {
                expected_revision: revision.revision,
                packages: Some(packages),
                orderings: Some(orderings),
                ..Default::default()
            },
        )
    };
    assert!(remove(&revision).is_err());
    assert_eq!(
        live(&w),
        ["shared_first.nrm", "shared_second.nrm", "speed_timer.nrm"]
    );

    let disabled = w
        .service
        .set_mod_package_enabled(
            PORT,
            &w.profile,
            "speed_timer.nrm",
            false,
            revision.revision,
        )
        .unwrap();
    assert!(remove(&disabled).is_ok());
}

#[tokio::test]
async fn a_thunderstore_wrapper_disclosing_an_unlisted_requirement_has_no_review() {
    let w = world();
    w.versions.lock().unwrap()[0].2 = wrapper(
        "Timer",
        "1.0.0",
        &["Tools-Shared-2.1.0"],
        &[("timer.nrm", &nrm("speed_timer", false))],
    );
    let error = w
        .service
        .plan_provider_install_via(&w.client, PORT, &w.profile, "Owner-Timer", "1.0.0")
        .await
        .unwrap_err();
    assert!(
        error.message.contains("manifest does not match"),
        "{error:?}"
    );
    assert!(live(&w).is_empty());
}

#[tokio::test]
async fn automatic_thunderstore_updates_stage_only_the_root_of_an_exact_retained_graph() {
    let dependency = wrapper(
        "Shared",
        "2.1.0",
        &[],
        &[
            ("first.nrm", &nrm("shared_first", false)),
            ("second.nrm", &nrm("shared_second", true)),
        ],
    );
    let w = world_with_dependency(Some(dependency));
    let prior = w
        .service
        .plan_provider_install_via(&w.client, PORT, &w.profile, "Owner-Timer", "1.0.0")
        .await
        .unwrap();
    let token = w
        .service
        .authorize_provider_install_allowing_code(&prior)
        .unwrap()
        .token;
    let current = w.service.apply_provider_install(&prior, &token).unwrap();
    w.service
        .set_profile_update_policy(
            PORT,
            &w.profile,
            crate::ProfileUpdatePolicy::AutomaticEligible,
        )
        .unwrap();
    w._requests.try_iter().for_each(drop);

    let asset_manifest = serde_json::to_vec(&serde_json::json!({
        "game_id": "mm", "id": "speed_timer", "display_name": "Timer", "version": "1.1.0",
        "authors": ["someone"], "minimum_recomp_version": "1.2.0",
    }))
    .unwrap();
    let asset_update = zip_bytes(&[
        ("mod.json", &asset_manifest),
        ("textures/a.png", b"new texture"),
    ]);
    w.versions.lock().unwrap().push((
        "1.1.0".into(),
        "2026-11-05T00:00:00Z".into(),
        wrapper(
            "Timer",
            "1.1.0",
            &["Tools-Shared-2.1.0"],
            &[("timer.nrm", &asset_update)],
        ),
    ));
    let first = current
        .packages
        .iter()
        .find(|member| member.native_id == "shared_first.nrm")
        .unwrap();
    let layout = w.service.deploy_layout(PORT).unwrap();
    let stored = layout.package(&first.sha256, &first.native_id);
    let exact = fs::read(&stored).unwrap();
    fs::write(&stored, b"changed").unwrap();
    let held = w
        .service
        .run_eligible_provider_updates_via(&w.client, PORT)
        .await
        .unwrap();
    assert!(held.iter().any(|update| {
        matches!(&update.outcome, ProviderAutoUpdateOutcome::Held { reason } if reason.contains("required Thunderstore package"))
    }), "{held:?}");
    assert!(
        !w._requests
            .try_iter()
            .any(|request| request.contains("/package/download/"))
    );
    fs::write(stored, exact).unwrap();

    let updates = w
        .service
        .run_eligible_provider_updates_via(&w.client, PORT)
        .await
        .unwrap();
    assert!(updates.iter().any(|update| {
        matches!(&update.outcome, ProviderAutoUpdateOutcome::Applied { file_id, .. } if file_id == "1.1.0")
    }), "{updates:?}");
    let requests = w._requests.try_iter().collect::<Vec<_>>();
    assert!(
        requests
            .iter()
            .any(|request| request.contains("/package/download/Owner/Timer/1.1.0/"))
    );
    assert!(
        !requests
            .iter()
            .any(|request| request.contains("/package/download/Tools/Shared/"))
    );
    let next = crate::profile::current_revision(
        &w.service.library().connection().unwrap(),
        PORT,
        &w.profile,
    )
    .unwrap();
    for member in current
        .packages
        .iter()
        .filter(|member| member.native_id.starts_with("shared_"))
    {
        assert!(next.packages.contains(member));
    }
    let previous_root = current
        .packages
        .iter()
        .find(|member| member.native_id == "speed_timer.nrm")
        .unwrap();
    let next_root = next
        .packages
        .iter()
        .find(|member| member.native_id == "speed_timer.nrm")
        .unwrap();
    assert_ne!(previous_root.sha256, next_root.sha256);
    assert_eq!(previous_root.provider_requires, next_root.provider_requires);

    w.versions.lock().unwrap().push((
        "1.2.0".into(),
        "2026-11-06T00:00:00Z".into(),
        wrapper(
            "Timer",
            "1.2.0",
            &["Tools-Shared-2.1.0"],
            &[("timer.nrm", &nrm("speed_timer", true))],
        ),
    ));
    let updates = w
        .service
        .run_eligible_provider_updates_via(&w.client, PORT)
        .await
        .unwrap();
    assert!(updates.iter().any(|update| {
        matches!(&update.outcome, ProviderAutoUpdateOutcome::Held { reason } if reason.contains("runs its own code"))
    }), "{updates:?}");
    assert!(
        !w._requests
            .try_iter()
            .any(|request| request.contains("/package/download/Tools/Shared/"))
    );
}
