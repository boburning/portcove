//! Shadow package-shape verdicts recorded by real installs (#5359 phase 1).
//! Inert fixtures only; nothing is executed.
use super::*;
use crate::package_shape::{
    InstalledShapeStatus, ShapeBaseline, ShapeComponent, ShapeProvenance, ShapeUnknownReason,
    ShapeVerdict,
};
use std::io::{Read as _, Write as _};

fn serve_archive(members: &[&str]) -> (crate::ReleaseAsset, std::thread::JoinHandle<()>) {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for member in members {
        writer
            .start_file(*member, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(member.as_bytes()).unwrap();
    }
    let bytes = writer.finish().unwrap().into_inner();
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let size = bytes.len() as u64;
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        )
        .unwrap();
        stream.write_all(&bytes).unwrap();
    });
    (
        crate::ReleaseAsset {
            name: "sample.zip".into(),
            url: format!("http://{address}/sample.zip"),
            size,
            sha256,
        },
        server,
    )
}

async fn install(installer: &Installer, library: &Library, version: &str, members: &[&str]) {
    let (asset, server) = serve_archive(members);
    let request = InstallRequest {
        port_id: "sample".into(),
        output_root: library.versions_dir().join("sample"),
        release: ResolvedRelease {
            version: version.into(),
            channel: crate::ReleaseChannel::Stable,
            published_at: None,
            asset,
        },
        activate: true,
        managed: None,
        qualification: InstallQualification::test("sample-game.exe"),
    };
    installer
        .install(request, &OperationCoordinator::new("install", None), |_| {})
        .await
        .unwrap();
    server.join().unwrap();
}

fn recorded(installer: &Installer, version: &str) -> crate::package_shape::PackageShapeRecord {
    installer
        .installed_package_shapes("sample")
        .unwrap()
        .into_iter()
        .find(|install| install.version == version)
        .and_then(|install| install.record)
        .unwrap()
}

#[tokio::test]
async fn installs_record_their_shape_and_a_shadow_verdict_without_refusing_drift() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let installer = Installer::new(library.clone()).unwrap();
    let reviewed = ["sample-game.exe", "data/level.dat", "config.ini"];
    install(&installer, &library, "v1", &reviewed).await;
    let first = recorded(&installer, "v1");
    assert_eq!(first.provenance, ShapeProvenance::Unreviewed);
    assert!(
        matches!(
            first.verdict,
            ShapeVerdict::Unknown {
                reason: crate::package_shape::ShapeUnknownReason::NoBaseline,
                ..
            }
        ),
        "{:?}",
        first.verdict
    );
    let shape = first.shape.as_ref().unwrap();
    assert_eq!(
        shape.programs.as_deref(),
        Some(&["sample-game.exe".to_owned()][..])
    );
    assert_eq!(
        shape.config_files.as_deref(),
        Some(&["config.ini".to_owned()][..])
    );

    // Same shape, new data: compatible with the active install's local shape.
    install(
        &installer,
        &library,
        "v2",
        &[
            "sample-game.exe",
            "data/level.dat",
            "data/new.dat",
            "config.ini",
        ],
    )
    .await;
    let second = recorded(&installer, "v2");
    assert!(
        matches!(
            &second.verdict,
            ShapeVerdict::Compatible {
                baseline: ShapeBaseline::Local { version, .. }
            } if version == "v1"
        ),
        "{:?}",
        second.verdict
    );
    // The local baseline was itself unreviewed, so nothing is inherited.
    assert_eq!(second.provenance, ShapeProvenance::Unreviewed);

    // A new program and a removed configuration are drift, recorded only.
    install(
        &installer,
        &library,
        "v3",
        &["sample-game.exe", "updater.exe", "data/level.dat"],
    )
    .await;
    let third = recorded(&installer, "v3");
    let ShapeVerdict::Drifted { changes, .. } = &third.verdict else {
        panic!("expected drift, got {:?}", third.verdict);
    };
    let components = changes
        .iter()
        .map(|change| change.component)
        .collect::<Vec<_>>();
    assert_eq!(
        components,
        [ShapeComponent::Programs, ShapeComponent::ConfigFiles]
    );
    let shapes = installer.installed_package_shapes("sample").unwrap();
    assert_eq!(shapes.len(), 3);
    assert!(
        shapes
            .iter()
            .any(|install| install.active && install.version == "v3")
    );
}

fn install_record(library: &Library, version: &str) -> InstallRecord {
    Library::installs_from(&library.connection().unwrap())
        .unwrap()
        .into_iter()
        .find(|install| install.port_id == "sample" && install.version == version)
        .unwrap()
}

/// Rewrite an installation's manifest and return a record bound to the new bytes.
fn rewrite_manifest(
    install: &InstallRecord,
    edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
) -> InstallRecord {
    let path = install.path.join(".portcove-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    edit(manifest.as_object_mut().unwrap());
    let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
    fs::write(&path, &bytes).unwrap();
    let mut rewritten = install.clone();
    rewritten.manifest_sha256 = hex::encode(Sha256::digest(&bytes));
    rewritten
}

#[tokio::test]
async fn a_failed_shape_derivation_is_recorded_and_never_refuses_the_install() {
    let temporary = tempfile::tempdir().unwrap();
    crate::package_shape::limit_derivation_under(temporary.path());
    let library = Library::open(temporary.path().join("library")).unwrap();
    let installer = Installer::new(library.clone()).unwrap();
    install(
        &installer,
        &library,
        "v1",
        &["sample-game.exe", "data/level.dat", "config.ini"],
    )
    .await;
    let record = recorded(&installer, "v1");
    assert!(record.shape.is_none());
    assert_eq!(record.provenance, ShapeProvenance::Unreviewed);
    assert!(
        matches!(
            &record.verdict,
            ShapeVerdict::Unknown {
                reason: ShapeUnknownReason::ObservationFailed,
                detail: Some(_),
                ..
            }
        ),
        "{:?}",
        record.verdict
    );
    verified_manifest(&install_record(&library, "v1")).unwrap();
}

#[tokio::test]
async fn an_unverifiable_active_manifest_is_no_local_baseline_and_never_refuses_the_install() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let installer = Installer::new(library.clone()).unwrap();
    install(
        &installer,
        &library,
        "v1",
        &["sample-game.exe", "config.ini"],
    )
    .await;
    let first = install_record(&library, "v1");
    let manifest = first.path.join(".portcove-manifest.json");
    let mut bytes = fs::read(&manifest).unwrap();
    bytes.push(b' ');
    fs::write(&manifest, bytes).unwrap();
    assert!(
        installer
            .local_shape_baseline("sample", Platform::WindowsX86_64)
            .is_err()
    );

    // Different bytes, so the new release has its own storage key.
    install(
        &installer,
        &library,
        "v2",
        &["sample-game.exe", "config.ini", "data/new.dat"],
    )
    .await;
    let second = recorded(&installer, "v2");
    assert!(
        matches!(
            second.verdict,
            ShapeVerdict::Unknown {
                reason: ShapeUnknownReason::NoBaseline,
                ..
            }
        ),
        "{:?}",
        second.verdict
    );
    let shapes = installer.installed_package_shapes("sample").unwrap();
    let unverifiable = shapes
        .iter()
        .find(|install| install.version == "v1")
        .unwrap();
    assert_eq!(
        unverifiable.status,
        InstalledShapeStatus::ManifestUnverifiable
    );
    assert!(unverifiable.record.is_none() && unverifiable.detail.is_some());
    let current = shapes
        .iter()
        .find(|install| install.version == "v2")
        .unwrap();
    assert_eq!(current.status, InstalledShapeStatus::Recorded);
}

#[tokio::test]
async fn a_record_from_a_newer_portcove_never_makes_the_manifest_unreadable() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let installer = Installer::new(library.clone()).unwrap();
    install(
        &installer,
        &library,
        "v1",
        &["sample-game.exe", "config.ini"],
    )
    .await;
    let original = install_record(&library, "v1");
    let mut known = serde_json::to_value(recorded(&installer, "v1")).unwrap();
    let future = serde_json::json!({
        "shape_version": crate::package_shape::SHAPE_VERSION,
        "shape": { "programs": ["sample-game.exe"], "future_part": ["x"] },
        "provenance": "future_provenance",
        "verdict": {
            "status": "future_status",
            "baseline": { "source": "future_source" },
            "reason": "future_reason",
            "unknown": ["future_component"]
        },
        "future_field": true
    });
    let rewritten = rewrite_manifest(&original, |manifest| {
        manifest.insert("package_shape".into(), future.clone());
    });
    let manifest = verified_manifest(&rewritten).unwrap();
    assert_eq!(manifest.package_shape.as_ref(), Some(&future));
    assert!(crate::package_shape::stored_record(&future).is_none());
    // Rewrites, such as an archive-data admission, carry the record verbatim.
    assert_eq!(
        serde_json::to_value(&manifest).unwrap()["package_shape"],
        future
    );
    assert!(
        installer
            .local_shape_baseline("sample", Platform::WindowsX86_64)
            .is_err(),
        "the registered digest still names the original bytes"
    );

    // An added shape part alone is tolerated within the same derivation version.
    known["shape"]["future_part"] = serde_json::json!(["x"]);
    let rewritten = rewrite_manifest(&original, |manifest| {
        manifest.insert("package_shape".into(), known.clone());
    });
    let manifest = verified_manifest(&rewritten).unwrap();
    assert!(
        crate::package_shape::stored_record(manifest.package_shape.as_ref().unwrap()).is_some()
    );

    // Another derivation version is no record.
    let mut other = known.clone();
    other["shape_version"] = serde_json::json!(crate::package_shape::SHAPE_VERSION + 1);
    assert!(crate::package_shape::stored_record(&other).is_none());
}

#[tokio::test]
async fn a_manifest_without_a_shape_reads_as_no_record() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let installer = Installer::new(library.clone()).unwrap();
    install(&installer, &library, "v1", &["sample-game.exe"]).await;
    let rewritten = rewrite_manifest(&install_record(&library, "v1"), |manifest| {
        assert!(manifest.remove("package_shape").is_some());
    });
    let manifest = verified_manifest(&rewritten).unwrap();
    assert!(manifest.package_shape.is_none());
    assert!(
        !serde_json::to_value(&manifest)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("package_shape")
    );
}
