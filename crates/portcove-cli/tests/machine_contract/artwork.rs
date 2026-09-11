use super::*;

#[test]
fn artwork_cli_preserves_choices_and_requires_explicit_unused_removal() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let source = temporary.path().join("owned image.png");
    // Owned one-pixel RGB fixture, with no external artwork or decoder dependency.
    let encoded = "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c639008580000018c0109b8393fda0000000049454e44ae426082";
    let bytes = (0..encoded.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&encoded[offset..offset + 2], 16).unwrap())
        .collect::<Vec<_>>();
    std::fs::write(&source, &bytes).unwrap();
    let imported = portcove(
        &library,
        &[
            "--json",
            "artwork",
            "import",
            "zelda64-recomp",
            source.to_str().unwrap(),
            "--expected-revision",
            "0",
        ],
    );
    assert!(
        imported.status.success(),
        "{}",
        String::from_utf8_lossy(&imported.stdout)
    );
    let imported = json_stdout(&imported);
    assert_eq!(imported["schema_version"], 47);
    assert_eq!(imported["command"], "artwork.import");
    assert_eq!(imported["data"]["choice"]["revision"], 1);
    let id = imported["data"]["choice"]["asset_sha256"].as_str().unwrap();
    let stale = portcove(
        &library,
        &[
            "--json",
            "artwork",
            "reset",
            "zelda64-recomp",
            "--expected-revision",
            "0",
        ],
    );
    assert!(!stale.status.success());
    assert_eq!(json_stdout(&stale)["error"]["code"], "conflict");
    assert!(
        portcove(&library, &["--json", "artwork", "clear-cache"])
            .status
            .success()
    );
    let shown = json_stdout(&portcove(
        &library,
        &["--json", "artwork", "show", "zelda64-recomp"],
    ));
    assert_eq!(shown["data"]["choice"], imported["data"]["choice"]);
    assert!(
        portcove(
            &library,
            &[
                "--json",
                "artwork",
                "reset",
                "zelda64-recomp",
                "--expected-revision",
                "1"
            ]
        )
        .status
        .success()
    );
    let denied = portcove(
        &library,
        &[
            "--json",
            "--non-interactive",
            "artwork",
            "remove-unused",
            id,
        ],
    );
    assert!(!denied.status.success());
    assert!(library.join("artwork").join(id).is_file());
    assert!(
        portcove(
            &library,
            &[
                "--json",
                "--non-interactive",
                "artwork",
                "remove-unused",
                id,
                "--yes"
            ]
        )
        .status
        .success()
    );
    assert!(!library.join("artwork").join(id).exists());
    assert_eq!(std::fs::read(source).unwrap(), bytes);
}
