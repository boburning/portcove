use super::*;
use crate::{ActivityOperation, ActivityStatus, ActivityTargetKind, Library};
use std::time::{Duration, Instant};

#[test]
fn cancelled_runtime_materialization_preserves_original_and_previous_output() {
    for route in [
        "raw",
        "zip",
        "file-set-zip",
        "ps2-iso",
        "gamecube-iso",
        "n64",
        "n64-zip",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let output_root = temporary.path().join("runtime");
        std::fs::create_dir(&output_root).unwrap();
        let n64 = route.starts_with("n64");
        let zipped = route.ends_with("zip");
        let extension = if zipped {
            "zip"
        } else if n64 {
            "v64"
        } else {
            "iso"
        };
        let source = temporary.path().join(format!("original.{extension}"));
        let destination = output_root.join(if n64 { "game.z64" } else { "game.iso" });
        let marker = runtime_source_marker_path(&destination).unwrap();
        let mut original = vec![0x55; 2 * 1024 * 1024];
        let mut expected = original.clone();
        if n64 {
            original[..4].copy_from_slice(&[0x37, 0x80, 0x40, 0x12]);
            expected[..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
        }
        if zipped {
            let mut archive = zip::ZipWriter::new(File::create(&source).unwrap());
            archive
                .start_file(
                    if n64 { "original.v64" } else { "original.iso" },
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            archive.write_all(&original).unwrap();
            archive.finish().unwrap();
        } else {
            std::fs::write(&source, &original).unwrap();
        }
        let source_bytes = std::fs::read(&source).unwrap();
        std::fs::write(&destination, b"previous runtime source").unwrap();
        std::fs::write(&marker, b"previous marker").unwrap();
        let required =
            BTreeMap::from([("original".into(), hex::encode(Sha256::digest(&expected)))]);
        let prepare = |checkpoint: &dyn Fn() -> Result<()>| {
            if route == "file-set-zip" {
                prepare_runtime_source_set_member(
                    &source,
                    &["original.iso".into()],
                    &destination,
                    RuntimeSourceMaterialization::Copy,
                    checkpoint,
                )
            } else {
                let materialization = match route {
                    "ps2-iso" => RuntimeSourceMaterialization::Ps2Iso,
                    "gamecube-iso" => RuntimeSourceMaterialization::GamecubeIso,
                    "n64" | "n64-zip" => RuntimeSourceMaterialization::N64BigEndian,
                    _ => RuntimeSourceMaterialization::Copy,
                };
                prepare_runtime_source(
                    &source,
                    &destination,
                    materialization,
                    &required,
                    checkpoint,
                )
            }
        };
        let staged_bytes = || {
            std::fs::read_dir(&output_root)
                .unwrap()
                .map(|entry| entry.unwrap())
                .filter(|entry| entry.path() != destination && entry.path() != marker)
                .map(|entry| entry.metadata().unwrap().len())
                .sum::<u64>()
        };
        let cancelled_after = std::cell::Cell::new(0_u64);
        let error = prepare(&|| {
            let progress = staged_bytes();
            if progress > 0 && progress < expected.len() as u64 {
                cancelled_after.set(progress);
                Err(PortcoveError::new(
                    crate::ErrorCode::Cancelled,
                    "cancel after observing private copied bytes",
                ))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Cancelled, "{route}");
        assert!(cancelled_after.get() > 0, "{route}");
        assert!(cancelled_after.get() < expected.len() as u64, "{route}");
        assert_eq!(std::fs::read(&source).unwrap(), source_bytes, "{route}");
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"previous runtime source",
            "{route}"
        );
        assert_eq!(
            std::fs::read(&marker).unwrap(),
            b"previous marker",
            "{route}"
        );
        assert_eq!(
            std::fs::read_dir(&output_root).unwrap().count(),
            2,
            "{route}"
        );

        prepare(&|| Ok(())).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), expected, "{route}");
        let accepted_marker = std::fs::read(&marker).unwrap();
        prepare(&|| {
            assert_eq!(staged_bytes(), 0, "unchanged {route} must reuse its output");
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read(&marker).unwrap(), accepted_marker, "{route}");
        assert_eq!(std::fs::read(&source).unwrap(), source_bytes, "{route}");
        assert_eq!(
            std::fs::read_dir(&output_root).unwrap().count(),
            2,
            "{route}"
        );
    }
}

#[test]
fn failed_runtime_copy_removes_staging_and_preserves_previous_bytes() {
    struct FailedReader;
    impl Read for FailedReader {
        fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("injected source read failure"))
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("game.iso");
    std::fs::write(&destination, b"previous bytes").unwrap();
    let reader = std::io::Cursor::new(vec![0x55; 256 * 1024]).chain(FailedReader);
    let observed_progress = std::cell::Cell::new(false);
    let error = copy_runtime_reader(reader, &destination, 1024 * 1024, &|| {
        if std::fs::read_dir(temporary.path()).unwrap().any(|entry| {
            let entry = entry.unwrap();
            entry.path() != destination && entry.metadata().unwrap().len() > 0
        }) {
            observed_progress.set(true);
        }
        Ok(())
    })
    .unwrap_err();
    assert!(error.message.contains("injected source read failure"));
    assert!(observed_progress.get());
    assert_eq!(std::fs::read(&destination).unwrap(), b"previous bytes");
    assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 1);
}

#[test]
fn raw_disc_set_preserves_tool_cancellation_and_diagnostic_ownership() {
    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    for mode in ["failure", "wait"] {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("originals");
        let destination = temporary.path().join("runtime");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&destination).unwrap();
        let first = source.join("disc-01.chd");
        let second = source.join("disc-02.chd");
        std::fs::write(&first, b"original first disc").unwrap();
        std::fs::write(&second, b"original second disc").unwrap();
        std::fs::write(second.with_extension("conversion-mode"), mode).unwrap();
        std::fs::write(destination.join("previous.bin"), b"previous runtime").unwrap();
        let marker = runtime_source_marker_path(&destination).unwrap();
        std::fs::write(&marker, b"previous marker").unwrap();
        let quiesced = std::cell::Cell::new(0);
        let mut diagnostics = Vec::new();
        let error = prepare_runtime_source_with_tool(
            &source,
            &destination,
            RuntimeSourceMaterialization::PsxRawSet,
            &BTreeMap::new(),
            Some(&program),
            &|| {
                if mode == "wait" && second.with_extension("conversion-ready").is_file() {
                    assert_eq!(
                        quiesced.get(),
                        0,
                        "the first disc cannot authorize cleanup while the second decoder is active"
                    );
                    Err(PortcoveError::new(
                        crate::ErrorCode::Cancelled,
                        "cancel the second owned decoder after startup",
                    ))
                } else {
                    Ok(())
                }
            },
            crate::tool_process::ToolProcessObserver {
                diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                    activity_id: "raw-set-fixture",
                    phase: "preparation.extract",
                    record: &mut |capture| {
                        diagnostics.push(capture.clone());
                        Ok(())
                    },
                }),
                quiesced: Some(&mut || {
                    quiesced.set(quiesced.get() + 1);
                    Ok(())
                }),
            },
        )
        .unwrap_err();
        if mode == "wait" {
            assert_eq!(error.code, crate::ErrorCode::Cancelled);
            let child = std::fs::read_to_string(second.with_extension("conversion-child-pid"))
                .unwrap()
                .parse()
                .unwrap();
            assert!(crate::launch::process_identity(child).unwrap().is_none());
            assert!(
                !second
                    .with_extension("conversion-unexpected-completion")
                    .exists()
            );
            assert!(!second.with_extension("orphan-output").exists());
        } else {
            assert_eq!(error.details["exit_code"], "29");
        }
        assert_eq!(quiesced.get(), u32::from(cfg!(windows)));
        assert!(
            diagnostics
                .iter()
                .filter(|capture| capture.complete)
                .count()
                >= 2
        );
        assert!(diagnostics.iter().all(|capture| {
            capture.activity_id == "raw-set-fixture" && capture.phase == "preparation.extract"
        }));
        assert_eq!(std::fs::read(&first).unwrap(), b"original first disc");
        assert_eq!(std::fs::read(&second).unwrap(), b"original second disc");
        assert_eq!(
            std::fs::read(destination.join("previous.bin")).unwrap(),
            b"previous runtime"
        );
        assert_eq!(std::fs::read(&marker).unwrap(), b"previous marker");
        let retained = std::fs::read_dir(temporary.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path != &source && path != &destination && path != &marker)
            .collect::<Vec<_>>();
        // Ordinary Unix groups stop these descendants but cannot prove that no
        // helper escaped, so only the Windows job proof permits private cleanup.
        assert_eq!(retained.len(), usize::from(!cfg!(windows)));
        for path in &retained {
            assert_eq!(
                std::fs::read(path.join("disc-01.bin")).unwrap(),
                b"owned psx track"
            );
            assert!(path.join(".disc-02/disc.cue").is_file());
        }

        std::fs::write(second.with_extension("conversion-mode"), "success").unwrap();
        quiesced.set(0);
        prepare_runtime_source_with_tool(
            &source,
            &destination,
            RuntimeSourceMaterialization::PsxRawSet,
            &BTreeMap::new(),
            Some(&program),
            &|| Ok(()),
            crate::tool_process::ToolProcessObserver {
                diagnostics: None,
                quiesced: Some(&mut || {
                    quiesced.set(quiesced.get() + 1);
                    Ok(())
                }),
            },
        )
        .unwrap();
        assert_eq!(quiesced.get(), u32::from(cfg!(windows)));
        assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 2);
        for name in ["disc-01.bin", "disc-02.bin"] {
            assert_eq!(
                std::fs::read(destination.join(name)).unwrap(),
                b"owned psx track"
            );
        }
        for path in &retained {
            assert!(path.join(".disc-02/disc.cue").is_file());
        }
    }
}

#[test]
fn failed_and_cancelled_conversion_retains_logs_and_reaps_owned_processes() {
    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    for mode in ["failure", "wait"] {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let library = Library::open(root.join("library")).unwrap();
        let id = library
            .begin_activity(
                ActivityOperation::Prepare,
                ActivityTargetKind::Port,
                Some("owned"),
            )
            .unwrap()
            .id;
        let source = root.join("owned.chd");
        let destination = root.join("private.iso");
        std::fs::write(&source, b"owned source bytes").unwrap();
        std::fs::write(source.with_extension("conversion-mode"), mode).unwrap();
        let started = Instant::now();
        let error = prepare_runtime_source_with_tool(
            &source,
            &destination,
            RuntimeSourceMaterialization::Ps2Iso,
            &BTreeMap::new(),
            Some(&program),
            &|| {
                if mode == "wait" && source.with_extension("conversion-child-pid").is_file() {
                    Err(PortcoveError::new(
                        crate::ErrorCode::Cancelled,
                        "owned cancellation",
                    ))
                } else {
                    Ok(())
                }
            },
            crate::tool_process::ToolProcessObserver {
                diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                    activity_id: &id,
                    phase: "preparation.extract",
                    record: &mut |capture| library.record_activity_diagnostic(capture),
                }),
                quiesced: None,
            },
        )
        .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(
            error.code,
            if mode == "wait" {
                crate::ErrorCode::Cancelled
            } else {
                crate::ErrorCode::SourceInvalid
            }
        );
        if mode == "failure" {
            assert_eq!(error.details["exit_code"], "29");
        }
        let pid = std::fs::read_to_string(source.with_extension("conversion-pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(crate::launch::process_identity(pid).unwrap().is_none());
        if mode == "wait" {
            let child = std::fs::read_to_string(source.with_extension("conversion-child-pid"))
                .unwrap()
                .parse()
                .unwrap();
            assert!(crate::launch::process_identity(child).unwrap().is_none());
        }
        library
            .finish_activity(&id, ActivityStatus::Failed, Some("owned conversion ended"))
            .unwrap();
        let reopened = Library::open(library.root()).unwrap();
        let captures = reopened.activity_diagnostic(&id).unwrap();
        assert_eq!(captures.len(), 1);
        assert_eq!(captures[0].phase, "preparation.extract");
        assert!(captures[0].complete);
        assert!(captures[0].stdout.text.contains("owned conversion began"));
        assert!(
            captures[0]
                .stderr
                .text
                .contains("owned conversion diagnostic")
        );
        assert!(
            !serde_json::to_string(&captures)
                .unwrap()
                .contains("owned-conversion-secret")
        );
        assert!(!destination.exists());
        assert!(!runtime_source_marker_path(&destination).unwrap().exists());
        assert_eq!(std::fs::read(&source).unwrap(), b"owned source bytes");
        assert!(std::fs::read_dir(root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("private.tmp-")
        }));
        assert!(!source.with_extension("orphan-output").exists());
        assert!(
            !source
                .with_extension("conversion-unexpected-completion")
                .exists()
        );
    }
}

#[test]
fn changed_psx_runtime_track_is_rematerialized_before_reuse() {
    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("owned.chd");
    let destination = temporary.path().join("disc");
    std::fs::write(&source, b"owned source bytes").unwrap();
    let cue = b"FILE \"disc1.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n";
    let track = b"owned psx track";
    let required = BTreeMap::from([
        ("disc.cue".into(), hex::encode(sha2::Sha256::digest(cue))),
        ("disc1.bin".into(), hex::encode(sha2::Sha256::digest(track))),
    ]);

    prepare_runtime_source_with_tool(
        &source,
        &destination,
        RuntimeSourceMaterialization::PsxBinCue,
        &required,
        Some(&program),
        &|| Ok(()),
        crate::tool_process::ToolProcessObserver::default(),
    )
    .unwrap();
    let marker = std::fs::read(runtime_source_marker_path(&destination).unwrap()).unwrap();
    std::fs::write(destination.join("disc1.bin"), b"changed track").unwrap();

    prepare_runtime_source_with_tool(
        &source,
        &destination,
        RuntimeSourceMaterialization::PsxBinCue,
        &required,
        Some(&program),
        &|| Ok(()),
        crate::tool_process::ToolProcessObserver::default(),
    )
    .unwrap();

    assert_eq!(std::fs::read(destination.join("disc.cue")).unwrap(), cue);
    assert_eq!(std::fs::read(destination.join("disc1.bin")).unwrap(), track);
    assert_eq!(
        std::fs::read(runtime_source_marker_path(&destination).unwrap()).unwrap(),
        marker
    );
}
