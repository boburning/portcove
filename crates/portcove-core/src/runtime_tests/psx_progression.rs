//! First-party provider, disc decoder and builder fixtures; no game is run.
use super::*;
use crate::{ChildProcessClass, ChildProcessPolicy, GithubReleaseProvider};

#[test]
fn unchanged_psx_definition_completes_provider_install_and_update_with_registered_inputs() {
    let started = std::time::Instant::now();
    // Isolate host-tool discovery in a child, never mutate the test host's PATH.
    let root = tempfile::tempdir().unwrap();
    let tool = root.path().join(if cfg!(windows) {
        "chdman.exe"
    } else {
        "chdman"
    });
    let source = root.path().join("selected_disc_probe.rs");
    fs::write(
        &source,
        include_str!("../testdata/selected_disc_probe.rs.txt"),
    )
    .unwrap();
    let mut compiler =
        ChildProcessPolicy::native_command(ChildProcessClass::ManagedBuilder, "rustc").unwrap();
    assert!(
        compiler
            .args(["--edition=2024"])
            .arg(source)
            .arg("-o")
            .arg(&tool)
            .status()
            .unwrap()
            .success()
    );
    eprintln!("PSX progression decoder compiled: {:?}", started.elapsed());
    crate::permissions::normalize_archive_entry(&tool, false, true).unwrap();
    fs::write(root.path().join("mode"), b"success").unwrap();
    let mut child = ChildProcessPolicy::native_command(
        ChildProcessClass::HostTool,
        std::env::current_exe().unwrap(),
    )
    .unwrap();
    let paths = std::env::join_paths(std::iter::once(root.path().to_path_buf()).chain(
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
    ))
    .unwrap();
    assert!(
        child
            .args([
                "--exact",
                "service::runtime_tests::psx_progression::owned_progression_fixture",
                "--ignored",
                "--nocapture"
            ])
            .env("PATH", paths)
            .env("PORTCOVE_OWNED_PROGRESSION", root.path())
            .status()
            .unwrap()
            .success()
    );
}

fn fixture_catalog(first: &ReleaseAsset, platform: Platform) -> Catalog {
    let key = serde_json::to_value(platform)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let executable = if cfg!(windows) { "Owned.exe" } else { "Owned" };
    let evidence = serde_json::json!({"id":"owned-evidence","role":"byte_identity","authority":"First-party fixture","authority_ref":"owned-v1","reviewed_at":"2026-10-24","claim":"Inert original identities, no gameplay","immutable_url":"https://example.invalid/owned-v1"});
    let mut contracts = Vec::new();
    for (role, profile) in [("game", "owned-disc"), ("bios", "owned-bios")] {
        contracts.push(serde_json::json!({"id":format!("owned-{role}"),"port_id":"owned-psx","role":role,"profile_id":profile,"admission_mode":"enforced","supported_variant_ids":["fixture"],"evidence_ids":["owned-evidence"],"authority_ref":"owned-v1","reviewed_at":"2026-10-24","immutable_review_url":"https://example.invalid/owned-v1","applicability":[{"upstream_ref":"v1.0.0","artifact_sha256":first.sha256}]}));
    }
    Catalog::from_json(&serde_json::json!({
        "schema_version":2,
        "ports":[{"id":"owned-psx","name":"Owned PSX fixture","summary":"Inert progression fixture","project_url":"https://example.invalid/owned","support_tier":"beta","channels":["stable"],"platforms":[platform],"adapter":"psx-recomp-managed","release":{"provider":"github","repository":"owned/fixture","asset_hints":{(key.clone()):["owned-", if cfg!(windows) {"-windows-x64.zip"} else {"-linux-x64.zip"}]}},"source_profile":"owned-disc","bios_source_profile":"owned-bios","executable_hints":{(key):[executable]},"runtime_subdirectory":"build-portcove","persistent_paths":["saves","settings.toml","mods"]}],
        "source_catalog":{"evidence":[evidence],"identities":[
            {"id":"owned-disc","label":"Owned optical bytes","kind":"optical-disc","variants":[{"id":"fixture","title":"Owned fixture","representations":[{"id":"track","kind":"optical-track-set","extensions":["chd"],"track_counts":[1],"identities":[{"scope":"psx-normalized-track-set","sha256":hex::encode(Sha256::digest(b"owned psx track"))}],"evidence_ids":["owned-evidence"]}],"evidence_ids":["owned-evidence"]}]},
            {"id":"owned-bios","label":"Owned inert BIOS","kind":"file","variants":[{"id":"fixture","title":"Owned fixture","representations":[{"id":"raw","kind":"raw-file","extensions":["bin"],"identities":[{"scope":"original-file","sha256":hex::encode(Sha256::digest(b"owned inert bios"))}],"evidence_ids":["owned-evidence"]}],"evidence_ids":["owned-evidence"]}]}
        ],"contracts":contracts,"validators":[],"qualification":[]}
    }).to_string()).unwrap()
}

fn kit(version: &str) -> Vec<u8> {
    archive(&[
        ("owned-progression-kit", b"first-party fixture"),
        ("owned-bundled-version", version.as_bytes()),
        ("psxrecomp/psxrecomp_cli.py", b"inert; the first-party toolchain probe handles this file"),
        ("psxrecomp/bios/SCPH1001.toml", b"[program]\nrom = 'bios/SCPH1001.BIN'\n[recompiler]\nout_stem = 'SCPH1001'\n"),
        ("game.toml", b"[game]\nname = 'Owned'\ndisc = 'disc.cue'\n[recompiler]\nbios_config = 'psxrecomp/bios/SCPH1001.toml'\n"),
    ])
}

fn service(
    library: Library,
    catalog: &Catalog,
    asset: &ReleaseAsset,
    version: &str,
) -> (PortcoveService, crate::test_http::HttpServer) {
    let payload = serde_json::json!([{"tag_name":version,"draft":false,"prerelease":false,"published_at":null,"assets":[{"name":asset.name,"browser_download_url":asset.url,"size":asset.size,"digest":format!("sha256:{}",asset.sha256)}]}]);
    let response = |body: &str| {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    };
    let (url, _, server) = crate::test_http::serve_http(vec![
        response("{\"archived\":false}"),
        response(&payload.to_string()),
    ]);
    let provider = GithubReleaseProvider::with_api_root(url).unwrap();
    let mut service = PortcoveService::with_provider(library, Arc::new(provider)).unwrap();
    service.replace_catalog_for_test(catalog.clone());
    (service, server)
}

#[tokio::test]
#[ignore = "isolated first-party provider, codec and builder control; invoked by parent"]
async fn owned_progression_fixture() {
    let started = std::time::Instant::now();
    let root = PathBuf::from(std::env::var_os("PORTCOVE_OWNED_PROGRESSION").unwrap());
    let platform = Platform::current().unwrap();
    let suffix = if cfg!(windows) {
        "windows-x64.zip"
    } else {
        "linux-x64.zip"
    };
    let names = [
        format!("owned-1.0.0-{suffix}"),
        format!("owned-1.0.1-{suffix}"),
    ];
    let bytes = [kit("1.0"), kit("2.0")];
    let archives = Archives::new(names.iter().cloned().zip(bytes.iter().cloned()).collect());
    let assets = [0, 1].map(|i| {
        let mut a = asset(&names[i], &bytes[i]);
        a.url = format!("{}/{}", archives.url, names[i]);
        a
    });
    let catalog = fixture_catalog(&assets[0], platform);
    let unchanged_definition = serde_json::to_value(catalog.authoritative_document()).unwrap();
    let source = root.join("owned.chd");
    let mut header = vec![0; 156];
    header[..8].copy_from_slice(b"MComprHD");
    header[8..12].copy_from_slice(&124_u32.to_be_bytes());
    header[12..16].copy_from_slice(&5_u32.to_be_bytes());
    header[32..40].copy_from_slice(&4096_u64.to_be_bytes());
    header[40..48].copy_from_slice(&124_u64.to_be_bytes());
    header[56..60].copy_from_slice(&512_u32.to_be_bytes());
    fs::write(&source, &header).unwrap();
    let bios = root.join("owned.bin");
    fs::write(&bios, b"owned inert bios").unwrap();
    let probe = crate::test_fixture::build_probe(&root);
    let library = Library::open(root.join("library")).unwrap();
    crate::psx::owned_toolchain_fixture(
        &library.toolchains_dir().join("cmake-clang-v1/1.0.14"),
        &probe,
    );
    let (first, server) = service(library.clone(), &catalog, &assets[0], "v1.0.0");
    // Historical applicability does not grant unknown edition/BIOS admission.
    let mut unknown = header.clone();
    unknown[100] = 4;
    fs::write(&source, &unknown).unwrap();
    assert!(first.register_source("owned-disc", &source).is_err());
    assert!(library.source("owned-disc").unwrap().is_none());
    assert_eq!(fs::read(&source).unwrap(), unknown);
    fs::write(&source, &header).unwrap();
    fs::write(&bios, b"unknown bios").unwrap();
    assert!(first.register_source("owned-bios", &bios).is_err());
    assert!(library.source("owned-bios").unwrap().is_none());
    assert_eq!(fs::read(&bios).unwrap(), b"unknown bios");
    fs::write(&bios, b"owned inert bios").unwrap();
    let registered = first.register_source("owned-disc", &source).unwrap();
    let registered_bios = first.register_source("owned-bios", &bios).unwrap();
    let old = first
        .install("owned-psx", None, None, None, true, |_| {})
        .await
        .unwrap();
    server.join().unwrap();
    assert_eq!(old.version, "v1.0.0");
    eprintln!(
        "PSX progression N installed and prepared: {:?}",
        started.elapsed()
    );
    let old_runtime = old.path.join("build-portcove");
    fs::create_dir(old_runtime.join("saves")).unwrap();
    fs::write(
        old_runtime.join("saves/owned.sav"),
        b"current progress before first Play",
    )
    .unwrap();
    fs::write(old_runtime.join("settings.toml"), b"player choices").unwrap();
    fs::write(
        old_runtime.join("mods/state.toml"),
        b"player selected old package",
    )
    .unwrap();
    first
        .set_update_policy("owned-psx", crate::UpdatePolicy::Stage)
        .unwrap();
    drop(first);
    for changed in ["disc", "bios"] {
        if changed == "disc" {
            fs::write(&source, &unknown).unwrap();
        } else {
            fs::write(&bios, b"changed registered bios").unwrap();
        }
        let (refused, server) = service(library.clone(), &catalog, &assets[1], "v1.0.1");
        assert!(
            refused
                .install("owned-psx", None, None, None, true, |_| {})
                .await
                .is_err()
        );
        server.join().unwrap();
        assert_eq!(
            refused.status("owned-psx").unwrap().active.unwrap().id,
            old.id
        );
        assert_eq!(library.all_installs().unwrap().len(), 1);
        if changed == "disc" {
            assert_eq!(fs::read(&source).unwrap(), unknown);
            fs::write(&source, &header).unwrap();
        } else {
            assert_eq!(fs::read(&bios).unwrap(), b"changed registered bios");
            fs::write(&bios, b"owned inert bios").unwrap();
        }
    }
    eprintln!(
        "PSX progression changed input refusals complete: {:?}",
        started.elapsed()
    );
    let (next, server) = service(library.clone(), &catalog, &assets[1], "v1.0.1");
    let result = next.reconcile("owned-psx", |_| {}).await.unwrap();
    server.join().unwrap();
    assert_eq!(result.action, crate::ReconcileAction::Staged);
    eprintln!("PSX progression N+1 staged: {:?}", started.elapsed());
    assert_eq!(next.status("owned-psx").unwrap().active.unwrap().id, old.id);
    let updated = next.activate_staged("owned-psx").unwrap();
    assert_eq!(updated.version, "v1.0.1");
    assert!(next.verify("owned-psx").unwrap().valid);
    eprintln!(
        "PSX progression N+1 activated and verified: {:?}",
        started.elapsed()
    );
    for (file, expected) in [
        (
            "saves/owned.sav",
            b"current progress before first Play".as_slice(),
        ),
        ("settings.toml", b"player choices"),
        ("mods/state.toml", b"player selected old package"),
    ] {
        assert_eq!(
            fs::read(updated.path.join("build-portcove").join(file)).unwrap(),
            expected
        );
    }
    for version in ["1.0", "2.0"] {
        assert!(
            updated
                .path
                .join(format!(
                    "build-portcove/mods/packages/bundled/{version}/package.toml"
                ))
                .is_file()
        );
    }
    assert_eq!(
        serde_json::to_value(library.source("owned-disc").unwrap().unwrap()).unwrap(),
        serde_json::to_value(&registered).unwrap()
    );
    assert_eq!(
        serde_json::to_value(library.source("owned-bios").unwrap().unwrap()).unwrap(),
        serde_json::to_value(&registered_bios).unwrap()
    );
    assert_eq!(
        serde_json::to_value(catalog.authoritative_document()).unwrap(),
        unchanged_definition
    );
    assert_eq!(fs::read(&source).unwrap(), header);
    assert_eq!(fs::read(&bios).unwrap(), b"owned inert bios");
    assert!(!old.path.join(".portcove-launched").exists());
    // Fresh installation after N+1 uses exactly the same definition and inputs.
    let fresh_library = Library::open(root.join("fresh-library")).unwrap();
    crate::psx::owned_toolchain_fixture(
        &fresh_library.toolchains_dir().join("cmake-clang-v1/1.0.14"),
        &probe,
    );
    let (fresh, server) = service(fresh_library, &catalog, &assets[1], "v1.0.1");
    fresh.register_source("owned-disc", &source).unwrap();
    fresh.register_source("owned-bios", &bios).unwrap();
    assert_eq!(
        fresh
            .install("owned-psx", None, None, None, true, |_| {})
            .await
            .unwrap()
            .version,
        "v1.0.1"
    );
    server.join().unwrap();
    eprintln!(
        "PSX progression fresh N+1 installed: {:?}",
        started.elapsed()
    );
}
