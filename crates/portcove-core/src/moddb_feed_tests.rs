use super::*;

const SAMPLE: &str = include_str!("testdata/moddb-arcane-dimensions.rss.xml");
const FILES_PAGE: &str = "https://www.moddb.com/mods/arcane-dimensions/downloads";
const SELF_LINK: &str = "https://www.moddb.com/mods/arcane-dimensions/downloads/feed/rss.xml";

fn scope() -> FeedScope {
    FeedScope::for_page(FILES_PAGE).unwrap()
}

#[test]
fn feed_addresses_derive_only_from_a_declared_files_collection() {
    let scope = scope();
    assert_eq!(
        scope.feed,
        "https://rss.moddb.com/mods/arcane-dimensions/downloads/feed/rss.xml"
    );
    assert_eq!(scope.self_link, SELF_LINK);
    for page in [
        "https://www.moddb.com/games/openxcom/mods",
        "https://rss.moddb.com/mods/arcane-dimensions/downloads",
        "https://www.moddb.com/mods/arcane-dimensions/downloads/",
        "https://www.moddb.com/mods/Arcane/downloads",
        "https://user@www.moddb.com/mods/arcane-dimensions/downloads",
        "http://www.moddb.com/mods/arcane-dimensions/downloads",
    ] {
        assert!(FeedScope::for_page(page).is_none(), "{page}");
    }
    assert!(FeedScope::for_page("https://www.moddb.com/games/openxcom/downloads").is_some());
}

#[test]
fn observed_moddb_wire_keeps_plain_attributed_file_notices() {
    assert_eq!(ATTRIBUTION, "Mod DB - Game Development");
    let notices = parse_files(SAMPLE.as_bytes(), &scope()).unwrap();
    assert_eq!(notices.len(), 2);
    assert_eq!(notices[0].source_id, "downloads213833");
    assert_eq!(notices[0].title, "AD 1.8.1 Map Variables");
    assert_eq!(
        notices[0].published_at.as_deref(),
        Some("2021-05-12T12:50:58Z")
    );
    assert_eq!(notices[1].source_id, "downloads205019");
    assert_eq!(
        notices[1].page_url,
        format!("{FILES_PAGE}/arcane-dimensions-150")
    );
}

#[test]
fn absent_dates_stay_unknown_and_valid_empty_feeds_are_distinct_from_errors() {
    let without_date = SAMPLE.replace("<pubDate>Wed, 12 May 2021 12:50:58 +0000</pubDate>", "");
    assert!(
        parse_files(without_date.as_bytes(), &scope()).unwrap()[0]
            .published_at
            .is_none()
    );
    let empty = format!("{}</channel></rss>", SAMPLE.split_once("<item>").unwrap().0);
    assert!(parse_files(empty.as_bytes(), &scope()).unwrap().is_empty());
    assert!(parse_files(b"", &scope()).is_err());
    assert!(parse_files(b"<html><body>Service unavailable</body></html>", &scope()).is_err());
}

#[test]
fn rejects_external_entities_renamed_feeds_duplicate_bindings_and_wrong_file_paths() {
    let item_url = format!("{FILES_PAGE}/arcane-dimensions-150");
    for changed in [
        SAMPLE.replace("Arcane Dimensions 1.50", "&other;"),
        SAMPLE.replace(
            "<rss ",
            "<!DOCTYPE rss SYSTEM 'https://example.invalid/local'><rss ",
        ),
        SAMPLE.replace("<rss ", "<?download https://example.invalid/no?><rss "),
        SAMPLE.replace(SELF_LINK, "https://rss.moddb.com/downloads/feed/rss.xml"),
        SAMPLE.replace(FILES_PAGE, "https://www.moddb.com/mods/other/downloads"),
        SAMPLE.replace(&item_url, &format!("{FILES_PAGE}/../arcane-dimensions-150")),
        SAMPLE.replace(
            &item_url,
            &format!("{FILES_PAGE}/arcane-dimensions-150?download=1"),
        ),
        SAMPLE.replace(&item_url, "https://media.moddb.com/arcane-dimensions.zip"),
        SAMPLE.replace("downloads205019", "downloads213833"),
        SAMPLE.replace("downloads205019", "download205019"),
        SAMPLE.replace("isPermaLink=\"false\"", "isPermaLink=\"true\""),
        SAMPLE.replace(
            "<title>Arcane Dimensions 1.50</title>",
            "<title>inner<fake/>text</title>",
        ),
        SAMPLE.replace(
            "<title>Arcane Dimensions 1.50</title>",
            "<title>one</title><title>two</title>",
        ),
        SAMPLE.replace("Wed, 12 May 2021 12:50:58 +0000", "unknown date"),
    ] {
        assert!(
            parse_files(changed.as_bytes(), &scope()).is_err(),
            "{changed}"
        );
    }
}

#[test]
fn enforces_byte_depth_entry_and_field_limits_without_network() {
    assert!(parse_files(&vec![b' '; MAX_BODY_BYTES + 1], &scope()).is_err());
    let nested = format!(
        "{}{}",
        "<level>".repeat(MAX_DEPTH),
        "</level>".repeat(MAX_DEPTH)
    );
    let deep = SAMPLE.replace("</channel>", &format!("{nested}</channel>"));
    assert!(parse_files(deep.as_bytes(), &scope()).is_err());
    let entries = "<item><title>Demo</title><link>https://www.moddb.com/mods/arcane-dimensions/downloads/demo</link><guid isPermaLink=\"false\">downloads1</guid></item>";
    let too_many = SAMPLE.replace(
        "</channel>",
        &format!("{}</channel>", entries.repeat(MAX_NOTICES)),
    );
    assert_eq!(
        parse_files(too_many.as_bytes(), &scope()),
        Err("Mod DB RSS item count exceeds its bound")
    );
    let wide = SAMPLE.replace("Arcane Dimensions 1.50", &"s".repeat(MAX_FIELD_BYTES + 1));
    assert!(parse_files(wide.as_bytes(), &scope()).is_err());
}
