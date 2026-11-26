//! Synthetic fixture identities for the mechanism evidence suites (#8555).
//!
//! Each port here is selected by its declared adapter and route facts only.
//! None of the identities below may appear in non-test Core, CLI or Desktop
//! host sources or `scripts/`; `identities_are_test_only` enforces that, so passing suites prove
//! the mechanism and not a title-specific branch.
use std::{
    collections::BTreeMap,
    io::Write as _,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde_json::{Value, json};

use crate::{Catalog, Platform};

pub(crate) const SETUP_PORT: &str = "mechanism-fixture-upstream-setup";
pub(crate) const SETUP_REPOSITORY: &str = "mechanism-fixture/upstream-setup";
pub(crate) const SETUP_PROFILE: &str = "mechanism-fixture-upstream-setup-disc";
pub(crate) const DISC_PORT: &str = "mechanism-fixture-referenced-disc";
pub(crate) const DISC_REPOSITORY: &str = "mechanism-fixture/referenced-disc";
pub(crate) const DISC_PROFILE: &str = "mechanism-fixture-referenced-disc-original";

/// Marker the owned setup probe writes on success (its default `jak1` game
/// path); the port declares it as data, nothing in production names it.
pub(crate) const SETUP_MARKER: &str = "data/out/jak1/iso/0COMMON.TXT";
/// Where the setup fixture keeps player progress.
pub(crate) const SETUP_SAVE: &str = "player/saves/slot1.sav";
/// Files the probe reads to choose its behavior; part of the package.
pub(crate) const SETUP_MODE_FILE: &str = "owned-setup-mode";

pub(crate) const RELEASES: &str = "src/testdata/mechanism-fixture-releases.json";

const DESKTOP: [Platform; 2] = [Platform::WindowsX86_64, Platform::LinuxX86_64];

pub(crate) fn platform_key(platform: Platform) -> String {
    serde_json::to_value(platform)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}

fn program(name: &str, platform: Platform) -> String {
    if platform == Platform::WindowsX86_64 {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// Declared desktop platforms: Windows and Linux, plus the host when a
/// developer runs the suites elsewhere.
pub(crate) fn platforms() -> Vec<Platform> {
    let mut platforms = DESKTOP.to_vec();
    let host = Platform::current().unwrap();
    if !platforms.contains(&host) {
        platforms.push(host);
    }
    platforms
}

fn asset_token(platform: Platform) -> &'static str {
    match platform {
        Platform::WindowsX86_64 => "windows-x64",
        Platform::LinuxX86_64 => "linux-x64",
        Platform::MacosX86_64 => "macos-x64",
        Platform::MacosAarch64 => "macos-arm64",
    }
}

pub(crate) fn setup_asset_name(platform: Platform) -> String {
    format!("mechanism-setup-{}.zip", asset_token(platform))
}

pub(crate) fn disc_asset_name(platform: Platform) -> String {
    format!("mechanism-disc-{}.zip", asset_token(platform))
}

pub(crate) fn game_program(platform: Platform) -> String {
    program("game", platform)
}

pub(crate) fn setup_program(platform: Platform) -> String {
    program("extractor", platform)
}

pub(crate) fn disc_player_program(platform: Platform) -> String {
    program("player", platform)
}

fn per_platform(value: impl Fn(Platform) -> Value) -> Value {
    Value::Object(
        platforms()
            .into_iter()
            .map(|platform| (platform_key(platform), value(platform)))
            .collect(),
    )
}

/// One catalog that holds both mechanism ports and their source contracts.
pub(crate) fn document() -> Value {
    let evidence = ["mechanism-fixture-evidence"];
    json!({
        "schema_version": 2,
        "source_catalog": {
            "evidence": [{
                "id": "mechanism-fixture-evidence", "role": "byte_identity",
                "authority": "Synthetic mechanism fixture", "authority_ref": "mechanism-fixture-1",
                "reviewed_at": "2026-11-22", "claim": "Owned synthetic mechanism input",
                "immutable_url": "https://example.invalid/fixtures/mechanism-v1"
            }],
            "identities": [
                {
                    "id": SETUP_PROFILE, "label": "Owned upstream-validated fixture disc",
                    "kind": "optical-disc",
                    "variants": [{ "id": "fixture-1", "title": "Owned upstream-validated fixture disc",
                        "representations": [{ "id": "fixture-validator", "extensions": ["iso", "chd"],
                            "kind": "pinned-validator", "validator_contract_id": "mechanism-fixture-validator",
                            "evidence_ids": evidence }],
                        "evidence_ids": evidence }]
                },
                {
                    "id": DISC_PROFILE, "label": "Owned referenced fixture disc", "kind": "file",
                    "variants": [{ "id": "fixture-1", "title": "Owned referenced fixture disc",
                        "representations": [{ "id": "informational-extension", "extensions": ["iso", "rvz"],
                            "kind": "informational-extension",
                            "evidence_gap": "Synthetic fixture admitted by extension.",
                            "evidence_ids": evidence }],
                        "evidence_ids": evidence }],
                    "evidence_gap": "Synthetic fixture admitted by extension."
                }
            ],
            "contracts": [
                {
                    "id": "mechanism-fixture-setup-game", "port_id": SETUP_PORT, "role": "game",
                    "profile_id": SETUP_PROFILE, "admission_mode": "enforced",
                    "validator_contract_id": "mechanism-fixture-validator",
                    "evidence_ids": evidence, "authority_ref": "mechanism-fixture-1",
                    "reviewed_at": "2026-11-22",
                    "immutable_review_url": "https://example.invalid/fixtures/mechanism-v1"
                },
                {
                    "id": "mechanism-fixture-disc-game", "port_id": DISC_PORT, "role": "game",
                    "profile_id": DISC_PROFILE, "admission_mode": "informational",
                    "evidence_ids": evidence, "authority_ref": "mechanism-fixture-1",
                    "reviewed_at": "2026-11-22",
                    "immutable_review_url": "https://example.invalid/fixtures/mechanism-v1",
                    "evidence_gap": "Synthetic fixture admitted by extension."
                }
            ],
            "validators": [{ "id": "mechanism-fixture-validator", "tool_id": "owned-fixture-setup",
                "protocol_version": "fixture-1", "evidence_ids": evidence }]
        },
        "ports": [
            {
                "id": SETUP_PORT, "name": "Mechanism fixture: upstream-managed setup",
                "summary": "Synthetic upstream-managed setup mechanism fixture",
                "project_url": "https://example.invalid/fixtures/mechanism-setup",
                "support_tier": "stable", "channels": ["stable"], "platforms": platforms(),
                "adapter": "upstream-managed-setup",
                "release": { "repository": SETUP_REPOSITORY },
                "source_profile": SETUP_PROFILE, "runtime_source_filename": "source.iso",
                "runtime_source_materialization": "ps2-iso",
                "setup_executable_hints": per_platform(|platform| json!([setup_program(platform)])),
                "setup_arguments": ["--owned-preparation"],
                "setup_marker": SETUP_MARKER,
                "setup_output_paths": ["data/out"],
                "launch_arguments": [],
                "executable_hints": per_platform(|platform| json!([game_program(platform)])),
                "runtime_mutable_paths": ["data/log"],
                "persistent_paths": ["player/saves"],
                "presentation": { "installation_method": "upstream-setup", "source_requirements": [{
                    "role": "game", "profile_id": SETUP_PROFILE, "label": "Owned upstream-validated fixture disc",
                    "verification": "upstream-validator" }], "saves_and_settings": "portcove-managed" }
            },
            {
                "id": DISC_PORT, "name": "Mechanism fixture: referenced disc",
                "summary": "Synthetic referenced-disc mechanism fixture",
                "project_url": "https://example.invalid/fixtures/mechanism-disc",
                "support_tier": "stable", "channels": ["stable"], "platforms": platforms(),
                "adapter": "referenced-disc",
                "release": { "repository": DISC_REPOSITORY },
                "source_profile": DISC_PROFILE,
                "executable_hints": per_platform(|platform| json!([disc_player_program(platform)])),
                "persistent_paths": ["saves", "config.json"],
                "presentation": { "installation_method": "referenced-disc", "source_requirements": [{
                    "role": "game", "profile_id": DISC_PROFILE, "label": "Owned referenced fixture disc",
                    "verification": "catalog-rules" }], "saves_and_settings": "portcove-managed" }
            }
        ]
    })
}

pub(crate) fn catalog_from(document: &Value) -> Catalog {
    Catalog::from_json(&serde_json::to_string(document).unwrap()).unwrap()
}

pub(crate) fn catalog() -> Catalog {
    catalog_from(&document())
}

/// Mutable access to one fixture port in a catalog document.
pub(crate) fn port_mut<'a>(document: &'a mut Value, id: &str) -> &'a mut Value {
    document["ports"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|port| port["id"] == id)
        .unwrap()
}

/// Recorded synthetic release lists, keyed by the fixture member name.
pub(crate) fn release_lists() -> BTreeMap<String, Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(RELEASES);
    let value: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    value
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, _)| !key.starts_with('_'))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// The recorded release list the service suites serve, decoys included:
/// installer, builder, debug and source archives are refused by their typed
/// role on every adapter (#8602), and mobile, console, other-host and
/// checksum files by host or form.
pub(crate) fn served_releases(member: &str) -> Value {
    release_lists()[member].clone()
}

/// Each non-game asset the member's recorded releases publish (installer,
/// builder, debug build, source archive, checksum list, mobile or console
/// package), renamed for this host where it names a desktop platform. The
/// recorded decoys name Windows; on another host they would be refused by
/// host before their role mattered, so each decoy is offered for this host.
/// Returns `(tag, asset)` pairs with each release's own asset metadata.
pub(crate) fn same_host_decoys(member: &str) -> Vec<(String, Value)> {
    let host = asset_token(Platform::current().unwrap());
    let games = DESKTOP
        .iter()
        .flat_map(|platform| [setup_asset_name(*platform), disc_asset_name(*platform)])
        .collect::<Vec<_>>();
    let mut decoys = Vec::<(String, Value)>::new();
    for release in release_lists()[member].as_array().unwrap() {
        let tag = release["tag_name"].as_str().unwrap();
        for asset in release["assets"].as_array().unwrap() {
            let name = asset["name"].as_str().unwrap();
            if games.iter().any(|game| game == name) {
                continue;
            }
            let renamed = name.replace(asset_token(Platform::WindowsX86_64), host);
            if decoys
                .iter()
                .any(|(_, decoy)| decoy["name"] == renamed.as_str())
            {
                continue;
            }
            let mut decoy = asset.clone();
            decoy["name"] = json!(renamed);
            decoys.push((tag.to_owned(), decoy));
        }
    }
    decoys
}

/// One package served by [`ReleaseServer`] for `tag` and `asset`.
pub(crate) struct ServedPackage {
    pub(crate) tag: String,
    pub(crate) asset: String,
    pub(crate) bytes: Vec<u8>,
    /// Serve bytes that differ from the advertised digest.
    pub(crate) corrupt: bool,
}

pub(crate) fn zip(entries: &[(String, Vec<u8>, bool)]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes, executable) in entries {
        zip.start_file(
            name.as_str(),
            zip::write::SimpleFileOptions::default().unix_permissions(if *executable {
                0o755
            } else {
                0o644
            }),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// Inert player package for the referenced-disc fixture.
pub(crate) fn disc_package(version: &str, platform: Platform) -> Vec<u8> {
    zip(&[
        (
            disc_player_program(platform),
            format!("inert referenced-disc player {version}").into_bytes(),
            true,
        ),
        ("README.txt".into(), b"inert fixture".to_vec(), false),
    ])
}

/// Upstream setup package: an inert game, the owned native setup probe and
/// the probe's mode file.
pub(crate) fn setup_package(
    version: &str,
    platform: Platform,
    probe: &Path,
    mode: &str,
) -> Vec<u8> {
    zip(&[
        (
            game_program(platform),
            format!("inert upstream-setup game {version}").into_bytes(),
            true,
        ),
        (setup_program(platform), std::fs::read(probe).unwrap(), true),
        (SETUP_MODE_FILE.into(), mode.as_bytes().to_vec(), false),
    ])
}

fn http(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

/// A local GitHub-shaped provider: the recorded synthetic release list with
/// its download URLs rewritten to this origin and each served package's
/// digest and size bound to the bytes actually served.
pub(crate) struct ReleaseServer {
    pub(crate) root: String,
    pub(crate) requests: Arc<Mutex<Vec<String>>>,
    _received: std::sync::mpsc::Receiver<String>,
    _server: crate::test_http::HttpServer,
}

impl ReleaseServer {
    pub(crate) fn start(repository: &str, member: &str, packages: Vec<ServedPackage>) -> Self {
        Self::start_with_releases(repository, served_releases(member), packages)
    }

    pub(crate) fn start_with_releases(
        repository: &str,
        releases: Value,
        packages: Vec<ServedPackage>,
    ) -> Self {
        let repository = repository.to_owned();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let root_cell = Arc::new(Mutex::new(String::new()));
        let root_for_server = root_cell.clone();
        let (root, received, server) =
            crate::test_http::serve_routed_http_bytes(64, move |request: &str| {
                let path = request
                    .split_ascii_whitespace()
                    .nth(1)
                    .unwrap()
                    .split('?')
                    .next()
                    .unwrap()
                    .trim_start_matches('/')
                    .to_owned();
                recorded.lock().unwrap().push(path.clone());
                let root = root_for_server.lock().unwrap().clone();
                if path == format!("repos/{repository}") {
                    return http(
                        "200 OK",
                        "application/json",
                        json!({"id": 7, "archived": false}).to_string().as_bytes(),
                    );
                }
                if path == format!("repos/{repository}/releases") {
                    let mut releases = releases.clone();
                    for release in releases.as_array_mut().unwrap() {
                        let tag = release["tag_name"].as_str().unwrap().to_owned();
                        for asset in release["assets"].as_array_mut().unwrap() {
                            let name = asset["name"].as_str().unwrap().to_owned();
                            asset["browser_download_url"] = json!(format!(
                                "{root}/{repository}/releases/download/{tag}/{name}"
                            ));
                            if let Some(package) = packages
                                .iter()
                                .find(|package| package.tag == tag && package.asset == name)
                            {
                                asset["size"] = json!(package.bytes.len());
                                asset["digest"] = json!(format!(
                                    "sha256:{}",
                                    crate::signed_catalog::digest(&package.bytes)
                                ));
                            }
                        }
                    }
                    return http(
                        "200 OK",
                        "application/json",
                        releases.to_string().as_bytes(),
                    );
                }
                if let Some(package) = packages.iter().find(|package| {
                    path == format!(
                        "{repository}/releases/download/{}/{}",
                        package.tag, package.asset
                    )
                }) {
                    let mut bytes = package.bytes.clone();
                    if package.corrupt {
                        let last = bytes.len() - 1;
                        bytes[last] ^= 0xff;
                    }
                    return http("200 OK", "application/octet-stream", &bytes);
                }
                http("404 Not Found", "text/plain", b"")
            });
        *root_cell.lock().unwrap() = root.clone();
        Self {
            root,
            requests,
            _received: received,
            _server: server,
        }
    }

    pub(crate) fn provider(&self) -> Arc<crate::GithubReleaseProvider> {
        Arc::new(crate::GithubReleaseProvider::with_api_root(self.root.clone()).unwrap())
    }

    pub(crate) fn downloads(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|path| path.split('/').any(|segment| segment == "download"))
            .cloned()
            .collect()
    }
}

/// `path` in one comparable form: the nearest existing ancestor resolved by
/// the platform, the remaining components appended. On Windows this removes
/// the difference between verbatim (`\\?\`) and plain drive prefixes and
/// between short (8.3) and long names, so paths compare by identity rather
/// than spelling.
pub(crate) fn canonical(path: &Path) -> PathBuf {
    assert!(path.is_absolute(), "{path:?} is not absolute");
    let mut existing = path;
    let mut rest = Vec::new();
    while !existing.exists() {
        rest.push(existing.file_name().unwrap().to_owned());
        existing = existing.parent().unwrap();
    }
    let mut resolved = std::fs::canonicalize(existing).unwrap();
    resolved.extend(rest.iter().rev());
    resolved
}

/// Whether `path` is `root` or inside it, compared by [`canonical`] form.
pub(crate) fn within(path: &Path, root: &Path) -> bool {
    canonical(path).starts_with(canonical(root))
}

/// A file's bytes and length, read back for "never modified" comparisons.
pub(crate) fn file_identity(path: &Path) -> (Vec<u8>, u64, std::time::SystemTime) {
    let metadata = std::fs::metadata(path).unwrap();
    (
        std::fs::read(path).unwrap(),
        metadata.len(),
        metadata.modified().unwrap(),
    )
}

/// Every regular file under `root`, relative and component-normalized, with
/// its bytes.
pub(crate) fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, current: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        let Ok(entries) = std::fs::read_dir(current) else {
            return;
        };
        for entry in entries {
            let path = entry.unwrap().path();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            if metadata.is_dir() {
                visit(root, &path, out);
            } else if metadata.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .components()
                    .collect::<PathBuf>();
                out.insert(relative, std::fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}

#[test]
fn fixture_catalog_declares_each_mechanism_by_data() {
    let catalog = catalog();
    let setup = catalog.port(SETUP_PORT).unwrap();
    assert_eq!(setup.adapter, crate::AdapterKind::UpstreamManagedSetup);
    assert!(crate::preparation::managed(setup));
    let disc = catalog.port(DISC_PORT).unwrap();
    assert_eq!(disc.adapter, crate::AdapterKind::ReferencedDisc);
    assert!(platforms().contains(&Platform::current().unwrap()));
}

/// The fixture identities must not be named by production code or scripts:
/// any branch on them would make the suites prove a title, not a mechanism.
#[test]
fn identities_are_test_only() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repository = manifest.parent().unwrap().parent().unwrap();
    let allowed = [
        "mechanism_fixtures.rs",
        "upstream_managed_setup_mechanism_tests.rs",
        "referenced_disc_mechanism_tests.rs",
        "selection_equivalence.rs",
        "selection_equivalence_exceptions.txt",
        "mechanism-fixture-releases.json",
    ];
    let needles = [
        SETUP_PORT,
        SETUP_REPOSITORY,
        SETUP_PROFILE,
        DISC_PORT,
        DISC_REPOSITORY,
        DISC_PROFILE,
        "mechanism-fixture",
    ];
    let mut offenders = Vec::new();
    for root in [
        manifest.join("src"),
        repository.join("crates").join("portcove-cli").join("src"),
        repository
            .join("apps")
            .join("desktop")
            .join("src-tauri")
            .join("src"),
        repository.join("scripts"),
    ] {
        let mut pending = vec![root];
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(&directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                if allowed.contains(&name.as_str()) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                if needles.iter().any(|needle| text.contains(needle)) {
                    offenders.push(path);
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "mechanism fixture identities named outside the suites: {offenders:?}"
    );
}
