use super::*;
use crate::{
    ErrorCode, Library, ModPackageHold, retained_build::tests::fixture, test_http::serve_http_bytes,
};
use std::io::{Cursor, Write};

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

fn o2r(assets: &[(&str, &[u8])]) -> Vec<u8> {
    zip_bytes(assets)
}

fn json_response(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn project_body(game: u64, file_id: u64, file_name: &str, size: usize) -> String {
    serde_json::json!({
        "_sName": "HD Link", "_sVersion": "2.0", "_bIsObsolete": false,
        "_tsDateUpdated": 5, "_aGame": {"_idRow": game},
        "_aFiles": [{
            "_idRow": file_id, "_sFile": file_name, "_nFilesize": size,
            "_tsDateAdded": 4, "_sMd5Checksum": "1c5133f5d7a8d9c72af51bab03452fbb",
            "_sAvResult": "clean", "_bIsArchived": false
        }]
    })
    .to_string()
}

fn file_response(bytes: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    )
    .into_bytes();
    response.extend_from_slice(bytes);
    response
}

fn redirect() -> Vec<u8> {
    b"HTTP/1.1 302 Found\r\nLocation: /files/pack.zip\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
}

/// Serves project JSON, the `/dl` redirect and the file, in request order.
fn serve(game: u64, file_name: &str, payload: &[u8]) -> (String, crate::test_http::HttpServer) {
    let (root, _requests, server) = serve_http_bytes(vec![
        json_response(&project_body(game, 10, file_name, payload.len())),
        redirect(),
        file_response(payload),
    ]);
    (root, server)
}

struct World {
    _temporary: tempfile::TempDir,
    service: PortcoveService,
    profile: String,
}

fn world() -> World {
    let (temporary, service, _first) = fixture();
    let profile = service.ensure_default_profile("starship").unwrap().id;
    World {
        _temporary: temporary,
        service,
        profile,
    }
}

fn live_mods(w: &World) -> Vec<String> {
    let mut names = fs::read_dir(w.service.library().user_dir("starship").join("mods"))
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[tokio::test]
async fn a_reviewed_wrapper_installs_exactly_its_packages_with_provider_identity() {
    let w = world();
    let payload = zip_bytes(&[
        ("readme.txt", b"ignored"),
        ("mods/hd-link.o2r", &o2r(&[("objects/link.bin", b"hd")])),
    ]);
    let (root, server) = serve(777, "pack.zip", &payload);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let plan = w
        .service
        .plan_provider_install_with(&client, "starship", &w.profile, 42, 10)
        .await
        .unwrap();
    server.join().unwrap();
    assert_eq!(plan.members.len(), 1);
    assert_eq!(plan.members[0].file_name, "hd-link.o2r");
    assert_eq!(plan.ignored_entries, 1);
    assert_eq!(plan.download_size, payload.len() as u64);
    assert_eq!(plan.provider.project, "42");
    assert_eq!(plan.provider.file.as_deref(), Some("10"));
    assert!(
        plan.unverified_claims
            .iter()
            .any(|claim| claim.contains("MD5"))
    );
    assert!(live_mods(&w).is_empty(), "planning changes no live files");

    let authorization = w.service.authorize_provider_install(&plan).unwrap();
    let revision = w
        .service
        .apply_provider_install(&plan, &authorization.token)
        .unwrap();
    assert_eq!(revision.packages.len(), 1);
    let package = &revision.packages[0];
    assert_eq!(package.native_id, "hd-link.o2r");
    assert_eq!(package.provider.as_ref().unwrap().project, "42");
    assert_eq!(
        package.provider.as_ref().unwrap().version.as_deref(),
        Some("2.0")
    );
    assert_eq!(live_mods(&w), ["hd-link.o2r"]);
    let layout = w.service.deploy_layout("starship").unwrap();
    assert!(
        !layout.staged(&plan.plan_sha256).exists(),
        "staging cleared after apply"
    );
}

#[tokio::test]
async fn plans_report_replacements_and_asset_conflicts_against_enabled_packages() {
    let w = world();
    let scratch = tempfile::tempdir().unwrap();
    let existing = scratch.path().join("old.o2r");
    fs::write(
        &existing,
        o2r(&[("objects/link.bin", b"old"), ("a.bin", b"a")]),
    )
    .unwrap();
    w.service
        .install_mod_package("starship", &w.profile, &existing, 1)
        .unwrap();
    let payload = zip_bytes(&[("new.o2r", &o2r(&[("objects/link.bin", b"new")]))]);
    let (root, server) = serve(777, "pack.zip", &payload);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let plan = w
        .service
        .plan_provider_install_with(&client, "starship", &w.profile, 42, 10)
        .await
        .unwrap();
    server.join().unwrap();
    assert_eq!(plan.expected_revision, 2);
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].path, "objects/link.bin");
    assert_eq!(plan.conflicts[0].providers, ["old.o2r", "new.o2r"]);
    assert_eq!(plan.conflicts[0].winner, "new.o2r");
}

#[tokio::test]
async fn bytes_that_differ_from_the_plan_or_a_changed_profile_invalidate_it() {
    let w = world();
    let payload = zip_bytes(&[("hd.o2r", &o2r(&[("a.bin", b"hd")]))]);
    let (root, server) = serve(777, "pack.zip", &payload);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let plan = w
        .service
        .plan_provider_install_with(&client, "starship", &w.profile, 42, 10)
        .await
        .unwrap();
    server.join().unwrap();
    let layout = w.service.deploy_layout("starship").unwrap();
    // Altered staged bytes: the old consent cannot install different content.
    let staged_file = layout.staged(&plan.plan_sha256).join("hd.o2r");
    let original = fs::read(&staged_file).unwrap();
    fs::write(&staged_file, o2r(&[("a.bin", b"swapped")])).unwrap();
    let token = w.service.authorize_provider_install(&plan).unwrap().token;
    let error = w.service.apply_provider_install(&plan, &token).unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert!(live_mods(&w).is_empty());
    // A tampered plan fails its own digest; a consumed token cannot be reused.
    let mut forged = plan.clone();
    forged.members[0].sha256 = "e".repeat(64);
    assert!(w.service.authorize_provider_install(&forged).is_err());
    fs::write(&staged_file, &original).unwrap();
    assert!(w.service.apply_provider_install(&plan, &token).is_err());
    // A newer profile revision makes the reviewed plan stale.
    let token = w.service.authorize_provider_install(&plan).unwrap().token;
    let scratch = tempfile::tempdir().unwrap();
    let other = scratch.path().join("other.o2r");
    fs::write(&other, o2r(&[("b.bin", b"b")])).unwrap();
    w.service
        .install_mod_package("starship", &w.profile, &other, 1)
        .unwrap();
    let stale = w.service.apply_provider_install(&plan, &token).unwrap_err();
    assert_eq!(stale.code, ErrorCode::Conflict);
    assert_eq!(live_mods(&w), ["other.o2r"]);
}

#[tokio::test]
async fn candidates_from_another_game_executables_or_unsupported_types_never_plan() {
    let w = world();
    // A project bound to a different game.
    let payload = zip_bytes(&[("hd.o2r", &o2r(&[("a.bin", b"x")]))]);
    let (root, _requests, server) = serve_http_bytes(vec![json_response(&project_body(
        999,
        10,
        "pack.zip",
        payload.len(),
    ))]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let error = w
        .service
        .plan_provider_install_with(&client, "starship", &w.profile, 42, 10)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, ErrorCode::Verification);
    // A package carrying executable content is held.
    let hostile = zip_bytes(&[(
        "hd.o2r",
        &zip_bytes(&[("a.bin", b"x"), ("hook.dll", b"MZ")]),
    )]);
    let (root, server) = serve(777, "pack.zip", &hostile);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let error = w
        .service
        .plan_provider_install_with(&client, "starship", &w.profile, 42, 10)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, ErrorCode::Unsupported);
    assert!(
        error
            .message
            .contains(&format!("{:?}", ModPackageHold::ContainsExecutableContent))
    );
    // A file type that is neither a package nor a zip wrapper.
    let (root, _requests, server) =
        serve_http_bytes(vec![json_response(&project_body(777, 10, "setup.exe", 3))]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let error = w
        .service
        .plan_provider_install_with(&client, "starship", &w.profile, 42, 10)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, ErrorCode::Unsupported);
    // A port without a reviewed binding.
    let client = GameBananaClient::with_roots("http://127.0.0.1:1", None).unwrap();
    assert!(
        w.service
            .plan_provider_install_with(&client, "opengoal-jak1", &w.profile, 42, 10)
            .await
            .is_err()
    );
    assert!(live_mods(&w).is_empty());
    let _ = Library::now();
}
