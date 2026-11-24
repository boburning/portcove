use super::*;
use serde_json::json;

#[test]
fn reviewed_engines_and_platforms_are_exact() {
    let catalog = crate::Catalog::embedded().unwrap();
    let mut port = catalog.port("quake-vkquake").unwrap().clone();
    assert_eq!(
        source(&port, Platform::WindowsX86_64),
        Some(QuakeEngine::VkQuake)
    );
    assert_eq!(
        source(&port, Platform::LinuxX86_64),
        Some(QuakeEngine::VkQuake)
    );
    assert_eq!(source(&port, Platform::MacosAarch64), None);
    // The engine comes from the definition's own declaration.
    let mut other_provider = port.clone();
    other_provider.release.provider = crate::ReleaseSource::Gitlab;
    assert_eq!(source(&other_provider, Platform::WindowsX86_64), None);
    port.mod_sources.clear();
    assert_eq!(source(&port, Platform::WindowsX86_64), None);
    let ironwail = catalog.port("quake-ironwail").unwrap();
    assert_eq!(
        source(ironwail, Platform::LinuxX86_64),
        Some(QuakeEngine::Ironwail)
    );
}

#[test]
fn requests_bind_scope_query_order_and_limits() {
    let url = endpoint(Some(" boss-map "), 1).unwrap();
    let pairs = url.query_pairs().collect::<BTreeMap<_, _>>();
    assert_eq!(
        url.origin().ascii_serialization(),
        "https://www.quaddicted.com"
    );
    assert_eq!(url.path(), "/api/v1/");
    assert_eq!(pairs["q"], format!("{FILTER} +filenames_txt:*boss\\-map*"));
    // One lookahead row beyond the 24 shown establishes whether more exist.
    assert_eq!(pairs["rows"], "25");
    assert_eq!(pairs["start"], "24");
    assert_eq!(pairs["sort"], "release_date_dt DESC, sha256 ASC");
    assert!(url.as_str().contains("%2Btags"));
    assert!(endpoint(Some("foo OR *:*"), 0).is_err());
}

// The removed client limit stopped browsing at page 20.
const OLD_LAST_PAGE: u32 = 20;

#[test]
fn pages_past_the_old_twentieth_page_stay_reachable() {
    for page in [OLD_LAST_PAGE, OLD_LAST_PAGE + 1, 10 * OLD_LAST_PAGE] {
        let url = endpoint(None, page).unwrap();
        let pairs = url.query_pairs().collect::<BTreeMap<_, _>>();
        assert_eq!(pairs["start"], (page as usize * PAGE_SIZE).to_string());
    }
}

#[test]
fn more_results_follow_the_provider_lookahead_not_a_page_number() {
    let rows = |count: usize| json!(vec![Value::Null; count]);
    for page in [0, OLD_LAST_PAGE, 10 * OLD_LAST_PAGE] {
        // A lookahead row means another page exists, even at the old last page.
        let more = project(&rows(PAGE_SIZE + 1), QuakeEngine::VkQuake, page).unwrap();
        assert!(more.may_have_more);
        // The lookahead row is not shown or counted on this page.
        assert_eq!(more.unreadable_rows, PAGE_SIZE);
        // A page that ends exactly at 24 rows is the provider's last page.
        let exact = project(&rows(PAGE_SIZE), QuakeEngine::VkQuake, page).unwrap();
        assert!(!exact.may_have_more);
    }
}

fn documented_row(sha: &str) -> Value {
    json!({
        "sha256": sha.repeat(64),
        "bytes": 900,
        "tags": ["title=Prepared map", "filename=prepared.zip", "game=quake",
            "game_mode=singleplayer", "release_date=2026-05-02", "author=Mapper",
            "type=map", "bsp_format=bsp2", "startmap=mapname", "depends=('example>=1.0')",
            "commandline=-game example"],
        "urls": ["https://www.quaddicted.com/filebase/prepared.zip",
            "https://user@www.quaddicted.com/filebase/refused.zip",
            "https://unreviewed.example/hidden.zip"],
        "notes": ["Requires a modern engine with increased limits."],
        "install": {"extract": "{base}/example", "extractmapping": {"/": "/"}}
    })
}

#[test]
fn provider_metadata_is_inert_and_compatibility_requires_independent_evidence() {
    let row = documented_row("a");
    let page = project(&json!([row]), QuakeEngine::VkQuake, 0).unwrap();
    let entry = &page.entries[0];
    assert_eq!(page.attribution, "Quaddicted");
    assert_eq!(entry.claimed_sha256, "a".repeat(64));
    assert_eq!(entry.claimed_bytes, Some(900));
    assert_eq!(entry.source_urls.len(), 1);
    assert_eq!(entry.engine_requirements, ["bsp_format=bsp2"]);
    assert_eq!(
        entry.engine_compatibility,
        QuaddictedEngineCompatibility::Unverified
    );
    assert_eq!(
        entry.install_notes.extract.as_deref(),
        Some("{base}/example")
    );
    assert_eq!(entry.install_notes.extract_mapping["/"], "/");
    assert_eq!(entry.install_notes.command_line, ["-game example"]);
    assert_eq!(entry.install_notes.dependencies, ["('example>=1.0')"]);
    assert_eq!(entry.provider_notes.len(), 1);

    let mut other = documented_row("b");
    other["tags"]
        .as_array_mut()
        .unwrap()
        .push(json!("requires_engine=ironwail"));
    assert_eq!(
        project(&json!([other]), QuakeEngine::VkQuake, 0)
            .unwrap()
            .entries[0]
            .engine_compatibility,
        QuaddictedEngineCompatibility::DeclaresAnotherRequiredEngine
    );
}

#[test]
fn malformed_duplicate_and_off_scope_rows_make_the_page_partial() {
    let mut unrelated = documented_row("e");
    unrelated["tags"] = json!(["game=quake2", "game_mode=singleplayer"]);
    let page = project(
        &json!([documented_row("a"), documented_row("a"), {"sha256":"bad"},
        unrelated, documented_row("b")]),
        QuakeEngine::Ironwail,
        0,
    )
    .unwrap();
    assert_eq!(page.unreadable_rows, 4);
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].claimed_sha256, "b".repeat(64));
    assert!(!page.may_have_more);
    assert!(project(&json!({"results":[]}), QuakeEngine::Ironwail, 0).is_err());
    assert!(
        project(
            &json!(vec![Value::Null; PAGE_SIZE + 2]),
            QuakeEngine::Ironwail,
            0
        )
        .is_err()
    );
}
