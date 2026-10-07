use super::*;

#[test]
fn artwork_cli_keeps_cover_and_detail_independent_through_the_local_lifecycle() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("two slot library");
    // Two owned one-pixel RGB PNGs with different pixels and content identities.
    let fixtures = [
        (
            "cover image.png",
            "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c639008580000018c0109b8393fda0000000049454e44ae426082",
        ),
        (
            "detail image.png",
            "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c631068f80000022401816f91e4640000000049454e44ae426082",
        ),
    ];
    let images = fixtures.map(|(name, encoded)| {
        let bytes = (0..encoded.len())
            .step_by(2)
            .map(|offset| u8::from_str_radix(&encoded[offset..offset + 2], 16).unwrap())
            .collect::<Vec<_>>();
        let path = temporary.path().join(name);
        std::fs::write(&path, &bytes).unwrap();
        (path, bytes)
    });
    let run = |args: &[&str]| {
        // Every command opens the same library in a fresh compiled CLI process.
        let output = portcove(&library, args);
        assert!(output.status.success(), "{args:?}: {output:?}");
        let document = json_stdout(&output);
        assert_eq!(document["ok"], true, "{args:?}: {document}");
        document["data"].clone()
    };
    let show = |slot: &str| {
        run(&[
            "--json",
            "artwork",
            "show",
            "zelda64-recomp",
            "--slot",
            slot,
        ])
    };
    let refuse = |args: &[&str], code: &str| {
        let output = portcove(&library, args);
        assert!(!output.status.success(), "{args:?}: {output:?}");
        let document = json_stdout(&output);
        assert_eq!(document["ok"], false);
        assert_eq!(document["error"]["code"], code, "{args:?}: {document}");
    };
    let defaults = [show("cover"), show("detail")];
    let mut choices = [Value::Null, Value::Null];
    for (index, slot) in ["cover", "detail"].into_iter().enumerate() {
        choices[index] = run(&[
            "--json",
            "artwork",
            "import",
            "zelda64-recomp",
            images[index].0.to_str().unwrap(),
            "--slot",
            slot,
            "--expected-revision",
            "0",
        ]);
        assert_eq!(choices[index]["choice"]["slot"], slot);
        assert_eq!(choices[index]["choice"]["revision"], 1);
        assert_eq!(choices[index]["availability"], "available");
        assert_eq!(choices[index]["resolved_source"]["kind"], "local_import");
    }
    let ids = choices
        .each_ref()
        .map(|state| state["choice"]["asset_sha256"].as_str().unwrap().to_owned());
    assert_ne!(ids[0], ids[1]);
    for (index, id) in ids.iter().enumerate() {
        assert_eq!(choices[index]["resolved_source"]["asset_sha256"], *id);
        assert_eq!(
            std::fs::read(library.join("artwork").join(id)).unwrap(),
            images[index].1
        );
    }
    // Advance Detail alone: a Cover revision must not authorize a Detail edit.
    choices[1] = run(&[
        "--json",
        "artwork",
        "import",
        "zelda64-recomp",
        images[1].0.to_str().unwrap(),
        "--slot",
        "detail",
        "--expected-revision",
        "1",
    ]);
    assert_eq!(choices[1]["choice"]["revision"], 2);
    assert_eq!(choices[1]["choice"]["asset_sha256"], ids[1]);
    assert_eq!(show("cover"), choices[0]);

    let malformed = temporary.path().join("truncated replacement.png");
    std::fs::write(&malformed, &images[0].1[..33]).unwrap();
    for (index, slot, revision, stale_revision) in [(0, "cover", "1", "0"), (1, "detail", "2", "1")]
    {
        let attempts = [
            (
                vec![
                    "--json",
                    "artwork",
                    "import",
                    "zelda64-recomp",
                    malformed.to_str().unwrap(),
                    "--slot",
                    slot,
                    "--expected-revision",
                    revision,
                ],
                "verification",
            ),
            (
                vec![
                    "--json",
                    "artwork",
                    "import",
                    "zelda64-recomp",
                    images[1 - index].0.to_str().unwrap(),
                    "--slot",
                    slot,
                    "--expected-revision",
                    stale_revision,
                ],
                "conflict",
            ),
            (
                vec![
                    "--json",
                    "artwork",
                    "reset",
                    "zelda64-recomp",
                    "--slot",
                    slot,
                    "--expected-revision",
                    stale_revision,
                ],
                "conflict",
            ),
        ];
        for (args, code) in attempts {
            refuse(&args, code);
            for (other, other_slot) in ["cover", "detail"].into_iter().enumerate() {
                assert_eq!(show(other_slot), choices[other]);
                assert_eq!(
                    std::fs::read(library.join("artwork").join(&ids[other])).unwrap(),
                    images[other].1
                );
            }
        }
    }
    let cleared = run(&["--json", "artwork", "clear-cache"]);
    assert_eq!(cleared["removed_files"], 2);
    assert!(cleared["removed_bytes"].as_u64().unwrap() > 0);
    for (index, slot) in ["cover", "detail"].into_iter().enumerate() {
        assert_eq!(show(slot), choices[index]);
        let streamed = portcove(
            &library,
            &[
                "--jsonl",
                "artwork",
                "show",
                "zelda64-recomp",
                "--slot",
                slot,
            ],
        );
        assert!(streamed.status.success(), "{streamed:?}");
        let streamed = json_stdout(&streamed);
        assert_eq!(streamed["type"], "result");
        assert_eq!(streamed["command"], "artwork.show");
        assert_eq!(streamed["data"], choices[index]);
    }
    // Missing originals affect availability, never the durable choice or the
    // other slot. Restore exactly the retained bytes, without importing again.
    for (index, slot) in ["cover", "detail"].into_iter().enumerate() {
        let original = library.join("artwork").join(&ids[index]);
        std::fs::remove_file(&original).unwrap();
        let unavailable = show(slot);
        assert_eq!(unavailable["availability"], "unavailable");
        assert_eq!(unavailable["choice"], choices[index]["choice"]);
        assert_eq!(unavailable["selection"], choices[index]["selection"]);
        assert_eq!(unavailable["resolved_source"]["kind"], "generated_fallback");
        assert_eq!(
            unavailable["generated_fallback"],
            defaults[index]["generated_fallback"]
        );
        assert_eq!(show(["detail", "cover"][index]), choices[1 - index]);
        std::fs::write(original, &images[index].1).unwrap();
        assert_eq!(show(slot), choices[index]);
    }
    let reset = run(&[
        "--json",
        "artwork",
        "reset",
        "zelda64-recomp",
        "--slot",
        "cover",
        "--expected-revision",
        "1",
    ]);
    assert_eq!(reset["choice"]["revision"], 2);
    assert!(reset["choice"]["asset_sha256"].is_null());
    // The current real catalog may provide a Cover default; never fetch it.
    assert_eq!(reset["resolved_source"], defaults[0]["resolved_source"]);
    assert_eq!(
        reset["generated_fallback"],
        defaults[0]["generated_fallback"]
    );
    assert_eq!(show("detail"), choices[1]);
    let unused = run(&["--json", "artwork", "unused"]);
    assert_eq!(unused.as_array().unwrap().len(), 1);
    assert_eq!(unused[0]["sha256"], ids[0]);
    refuse(
        &[
            "--json",
            "--non-interactive",
            "artwork",
            "remove-unused",
            &ids[1],
            "--yes",
        ],
        "conflict",
    );
    refuse(
        &[
            "--json",
            "--non-interactive",
            "artwork",
            "remove-unused",
            &ids[0],
        ],
        "usage",
    );
    for (index, id) in ids.iter().enumerate() {
        assert_eq!(
            std::fs::read(library.join("artwork").join(id)).unwrap(),
            images[index].1
        );
    }
    run(&[
        "--json",
        "--non-interactive",
        "artwork",
        "remove-unused",
        &ids[0],
        "--yes",
    ]);
    assert!(!library.join("artwork").join(&ids[0]).exists());
    assert_eq!(show("cover"), reset);
    assert_eq!(show("detail"), choices[1]);
    assert_eq!(
        std::fs::read(library.join("artwork").join(&ids[1])).unwrap(),
        images[1].1
    );
    assert!(
        run(&["--json", "artwork", "unused"])
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(std::fs::read(malformed).unwrap(), images[0].1[..33]);
    for (path, bytes) in images {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

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
    let fallback = json_stdout(&portcove(
        &library,
        &["--json", "artwork", "show", "zelda64-recomp"],
    ));
    // The consumer default follows the real catalog; adding a cover must not
    // invalidate local-choice and cleanup assertions or require a live fetch.
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let mapping = catalog
        .port("zelda64-recomp")
        .unwrap()
        .presentation
        .as_ref()
        .unwrap()
        .artwork
        .as_ref();
    if let Some(mapping) = mapping {
        assert_eq!(fallback["data"]["resolved_source"]["kind"], "igdb_cover");
        assert_eq!(
            fallback["data"]["resolved_source"]["artwork"],
            serde_json::to_value(mapping).unwrap()
        );
    } else {
        assert_eq!(
            fallback["data"]["resolved_source"]["kind"],
            "generated_fallback"
        );
    }
    assert_eq!(fallback["data"]["choice"]["revision"], 0);
    assert!(fallback["data"]["choice"]["asset_sha256"].is_null());
    assert_eq!(fallback["data"]["generated_fallback"]["style_version"], 1);
    assert_eq!(fallback["data"]["generated_fallback"]["initials"], "Z6");
    assert!(
        fallback["data"]["generated_fallback"]["identity"]
            .as_str()
            .is_some_and(|identity| identity.len() == 64)
    );
    assert!(
        fallback["data"]["generated_fallback"]["palette_index"]
            .as_u64()
            .is_some_and(|palette| palette < 6)
    );
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
    assert_eq!(imported["schema_version"], 57);
    assert_eq!(imported["command"], "artwork.import");
    assert_eq!(imported["data"]["choice"]["revision"], 1);
    let id = imported["data"]["choice"]["asset_sha256"].as_str().unwrap();
    assert_eq!(imported["data"]["resolved_source"]["kind"], "local_import");
    assert_eq!(imported["data"]["resolved_source"]["asset_sha256"], id);
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
    let reset = portcove(
        &library,
        &[
            "--json",
            "artwork",
            "reset",
            "zelda64-recomp",
            "--expected-revision",
            "1",
        ],
    );
    assert!(reset.status.success());
    let reset = json_stdout(&reset);
    assert_eq!(
        reset["data"]["resolved_source"],
        fallback["data"]["resolved_source"]
    );
    assert_eq!(
        reset["data"]["generated_fallback"],
        fallback["data"]["generated_fallback"]
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
