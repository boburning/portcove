#[cfg(unix)]
#[test]
fn psx_bin_cue_uncertain_tool_failure_retains_staging() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source.chd");
    let destination = temporary.path().join("runtime");
    std::fs::create_dir(&destination).unwrap();
    std::fs::write(destination.join("previous.bin"), b"keep runtime").unwrap();
    std::fs::write(&source, b"original source").unwrap();
    let mut quiesced = false;
    let result = materialize_psx_bin_cue(
        &source,
        &destination,
        Some(Path::new("/usr/bin/false")),
        &|| Ok(()),
        crate::tool_process::ToolProcessObserver {
            diagnostics: None,
            quiesced: Some(&mut || {
                quiesced = true;
                Ok(())
            }),
        },
    );
    assert!(result.is_err());
    assert!(!quiesced);
    assert!(std::fs::read_dir(temporary.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".portcove-psx-")
    }));
    assert_eq!(
        std::fs::read(destination.join("previous.bin")).unwrap(),
        b"keep runtime"
    );
}
