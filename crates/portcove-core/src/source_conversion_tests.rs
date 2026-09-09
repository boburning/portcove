use super::*;
use crate::{ActivityOperation, ActivityStatus, ActivityTargetKind, Library};
use std::time::{Duration, Instant};

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
            Some(crate::tool_process::ToolDiagnosticSink {
                activity_id: &id,
                phase: "preparation.extract",
                record: &mut |capture| library.record_activity_diagnostic(capture),
            }),
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
        std::thread::sleep(Duration::from_millis(1100));
        assert!(!source.with_extension("orphan-output").exists());
        assert!(
            !source
                .with_extension("conversion-unexpected-completion")
                .exists()
        );
    }
}
