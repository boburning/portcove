use std::cell::RefCell;

use super::*;

/// Records every request and answers with a fixed response.
struct Fixture {
    status: u16,
    retry_after: Option<&'static str>,
    body: String,
    requests: RefCell<Vec<(String, String)>>,
    /// Image host answer: status, Retry-After and body.
    image: (u16, Option<&'static str>, Vec<u8>),
    images: RefCell<Vec<String>>,
}

impl Fixture {
    fn ok(body: serde_json::Value) -> Self {
        Self::status(200, body.to_string())
    }

    fn status(status: u16, body: String) -> Self {
        Self {
            status,
            retry_after: None,
            body,
            requests: RefCell::new(Vec::new()),
            image: (200, None, Vec::new()),
            images: RefCell::new(Vec::new()),
        }
    }
}

impl SteamGridDbTransport for Fixture {
    fn get(&self, path_and_query: &str, key: &str) -> Result<TransportResponse> {
        self.requests
            .borrow_mut()
            .push((path_and_query.to_owned(), key.to_owned()));
        Ok(TransportResponse {
            status: self.status,
            retry_after: self.retry_after.map(str::to_owned),
            date: None,
            body: self.body.clone().into_bytes(),
        })
    }

    fn fetch_image(&self, url: &str, _max_bytes: u64) -> Result<TransportResponse> {
        self.images.borrow_mut().push(url.to_owned());
        Ok(TransportResponse {
            status: self.image.0,
            retry_after: self.image.1.map(str::to_owned),
            date: None,
            body: self.image.2.clone(),
        })
    }
}

const KEY: &str = "0123456789abcdef0123456789abcdef";

fn image(id: u64, overrides: serde_json::Value) -> serde_json::Value {
    let mut value = serde_json::json!({
        "id": id,
        "score": 3,
        "style": "alternate",
        "width": 600,
        "height": 900,
        "nsfw": false,
        "humor": false,
        "epilepsy": false,
        "mime": "image/png",
        "url": format!("https://cdn2.steamgriddb.com/grid/{id}.png"),
        "thumb": format!("https://cdn2.steamgriddb.com/thumb/{id}.png"),
        "author": {"name": "Artist", "steam64": "76561198000000000", "avatar": "x"}
    });
    if let (Some(base), Some(extra)) = (value.as_object_mut(), overrides.as_object()) {
        for (field, replacement) in extra {
            base.insert(field.clone(), replacement.clone());
        }
    }
    value
}

#[test]
fn search_encodes_the_term_and_uses_only_the_fixed_api_path() {
    let fixture = Fixture::ok(serde_json::json!({
        "success": true,
        "data": [
            {"id": 7, "name": " Example Game ", "verified": true, "types": ["steam"]},
            {"id": 0, "name": "invalid"},
            {"id": 8, "name": "   "}
        ]
    }));
    let games = search_games(&fixture, KEY, "Zelda: Ocarina / 64").unwrap();
    assert_eq!(
        games,
        vec![SteamGridDbGame {
            id: 7,
            name: "Example Game".into(),
            verified: true
        }]
    );
    let requests = fixture.requests.borrow().clone();
    assert_eq!(
        requests[0].0,
        "/search/autocomplete/Zelda%3A%20Ocarina%20%2F%2064"
    );
    assert_eq!(requests[0].1, KEY);
    for rejected in ["  ", ".", "..", " ... "] {
        assert_eq!(
            search_games(&fixture, KEY, rejected).unwrap_err().code,
            crate::ErrorCode::Usage,
            "{rejected:?}"
        );
    }
    assert_eq!(fixture.requests.borrow().len(), 1);
}

#[test]
fn candidates_request_safe_static_filters_and_drop_unexpected_entries() {
    let fixture = Fixture::ok(serde_json::json!({
        "success": true,
        "page": 0,
        "total": 6,
        "data": [
            image(1, serde_json::json!({})),
            image(2, serde_json::json!({"nsfw": true})),
            image(3, serde_json::json!({"mime": "image/webp"})),
            image(4, serde_json::json!({"url": "https://evil.example/4.png"})),
            image(5, serde_json::json!({"thumb": "http://cdn2.steamgriddb.com/5.png"})),
            image(6, serde_json::json!({"width": 0})),
            {"id": 9, "unexpected": true}
        ]
    }));
    let candidates =
        role_candidates(&fixture, KEY, 42, DestinationArtworkRole::PortraitCover).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].id, 1);
    assert_eq!(candidates[0].role, DestinationArtworkRole::PortraitCover);
    assert_eq!(candidates[0].author.name, "Artist");
    let path = fixture.requests.borrow()[0].0.clone();
    assert!(path.starts_with("/grids/game/42?dimensions=600x900"));
    for filter in [
        "types=static",
        "nsfw=false",
        "humor=false",
        "epilepsy=false",
        "mimes=image/png,image/jpeg",
        "limit=50",
    ] {
        assert!(path.contains(filter), "{path} lacks {filter}");
    }
}

#[test]
fn hero_and_landscape_use_their_own_collections_and_dimensions() {
    let fixture = Fixture::ok(serde_json::json!({"success": true, "data": []}));
    role_candidates(&fixture, KEY, 5, DestinationArtworkRole::HeroBanner).unwrap();
    role_candidates(&fixture, KEY, 5, DestinationArtworkRole::LandscapeCover).unwrap();
    let requests = fixture.requests.borrow();
    assert!(
        requests[0]
            .0
            .starts_with("/heroes/game/5?dimensions=1920x620")
    );
    assert!(
        requests[1]
            .0
            .starts_with("/grids/game/5?dimensions=460x215,920x430")
    );
    assert!(role_candidates(&fixture, KEY, 0, DestinationArtworkRole::HeroBanner).is_err());
}

#[test]
fn provider_failures_map_to_explicit_player_outcomes() {
    for (status, code) in [
        (401, crate::ErrorCode::Usage),
        (403, crate::ErrorCode::Usage),
        (404, crate::ErrorCode::NotFound),
        (500, crate::ErrorCode::Network),
        (418, crate::ErrorCode::Verification),
    ] {
        let fixture = Fixture::status(status, "{}".into());
        let error = search_games(&fixture, KEY, "game").unwrap_err();
        assert_eq!(error.code, code, "status {status}");
        assert!(!error.message.contains(KEY));
    }
    let mut limited = Fixture::status(429, "{}".into());
    limited.retry_after = Some("30");
    let error = search_games(&limited, KEY, "game").unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Network);
    assert_eq!(
        error.details.get("retry_after_seconds").map(String::as_str),
        Some("30")
    );
    for body in ["not json", r#"{"success": false, "errors": ["x"]}"#] {
        let fixture = Fixture::status(200, body.into());
        assert_eq!(
            search_games(&fixture, KEY, "game").unwrap_err().code,
            crate::ErrorCode::Verification
        );
    }
    let oversized = Fixture::status(200, " ".repeat(MAX_RESPONSE_BYTES + 1));
    assert_eq!(
        search_games(&oversized, KEY, "game").unwrap_err().code,
        crate::ErrorCode::Verification
    );
}

#[test]
fn keys_are_validated_without_echoing_them() {
    for invalid in ["", "short", "has space in it 0123456", &"a".repeat(129)] {
        let error = validate_key(invalid).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Usage);
        if !invalid.is_empty() {
            assert!(!error.message.contains(invalid));
        }
    }
    assert_eq!(validate_key(&format!("  {KEY}\n")).unwrap(), KEY);
}

#[test]
fn image_urls_must_be_https_on_the_steamgriddb_cdn() {
    assert!(is_image_url("https://cdn2.steamgriddb.com/grid/1.png"));
    for rejected in [
        "http://cdn2.steamgriddb.com/grid/1.png",
        "https://cdn2.steamgriddb.com:8443/grid/1.png",
        "https://user@cdn2.steamgriddb.com/grid/1.png",
        "https://www.steamgriddb.com/grid/1.png",
        "https://cdn2.steamgriddb.com.evil.example/1.png",
        "not a url",
    ] {
        assert!(!is_image_url(rejected), "{rejected}");
    }
}

fn listing() -> Fixture {
    Fixture::ok(serde_json::json!({
        "success": true,
        "data": [image(1, serde_json::json!({})), image(2, serde_json::json!({"author": {"name": " \u{7}Artist Two "}}))]
    }))
}

#[test]
fn chosen_candidates_are_reresolved_and_fetched_without_the_key() {
    let mut fixture = listing();
    fixture.image = (200, None, vec![1, 2, 3]);
    let fetched =
        fetch_candidate(&fixture, KEY, 42, DestinationArtworkRole::PortraitCover, 2).unwrap();
    assert_eq!(fetched.candidate.id, 2);
    assert_eq!(fetched.candidate.author.name, "Artist Two");
    assert_eq!(fetched.bytes, vec![1, 2, 3]);
    // One authorized listing request to the API origin, one key-free image fetch.
    assert_eq!(fixture.requests.borrow().len(), 1);
    assert_eq!(
        fixture.images.borrow().as_slice(),
        ["https://cdn2.steamgriddb.com/grid/2.png"]
    );
}

#[test]
fn vanished_candidates_are_not_found_without_an_image_request() {
    let fixture = listing();
    let error =
        fetch_candidate(&fixture, KEY, 42, DestinationArtworkRole::PortraitCover, 9).unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::NotFound);
    assert!(fixture.images.borrow().is_empty());
    let mut rejected = Fixture::status(401, "{}".into());
    rejected.image = (200, None, vec![1]);
    assert_eq!(
        fetch_candidate(&rejected, KEY, 42, DestinationArtworkRole::PortraitCover, 1)
            .unwrap_err()
            .code,
        crate::ErrorCode::Usage
    );
    assert!(rejected.images.borrow().is_empty());
}

#[test]
fn image_host_failures_map_to_explicit_outcomes() {
    for (status, retry, body, code) in [
        (404, None, vec![1], crate::ErrorCode::NotFound),
        (429, Some("12"), vec![], crate::ErrorCode::Network),
        (503, None, vec![], crate::ErrorCode::Network),
        (302, None, vec![], crate::ErrorCode::Verification),
        (200, None, vec![], crate::ErrorCode::Verification),
        (
            200,
            None,
            vec![0; crate::artwork_image::MAX_ORIGINAL_BYTES as usize + 1],
            crate::ErrorCode::Verification,
        ),
    ] {
        let mut fixture = listing();
        fixture.image = (status, retry, body);
        let error = fetch_candidate(&fixture, KEY, 42, DestinationArtworkRole::PortraitCover, 1)
            .unwrap_err();
        assert_eq!(error.code, code, "status {status}");
        if status == 429 {
            assert_eq!(
                error.details.get("retry_after_seconds").map(String::as_str),
                Some("12")
            );
        }
        assert!(!error.message.contains(KEY));
    }
}

#[test]
fn previews_are_cdn_only_key_free_and_reencoded_locally() {
    let png = {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            60,
            90,
            image::Rgb([1, 2, 3]),
        ));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, image::ImageFormat::Jpeg)
            .unwrap();
        bytes.into_inner()
    };
    let mut fixture = Fixture::status(500, String::new());
    fixture.image = (200, None, png);
    let preview = preview(&fixture, "https://cdn2.steamgriddb.com/thumb/1.jpg").unwrap();
    assert!(preview.starts_with(b"\x89PNG"));
    assert!(
        fixture.requests.borrow().is_empty(),
        "no API request or key"
    );
    assert_eq!(
        preview_error(&fixture, "https://evil.example/1.png"),
        crate::ErrorCode::Usage
    );
    for (status, body, code) in [
        (404, vec![1], crate::ErrorCode::NotFound),
        (429, vec![], crate::ErrorCode::Network),
        (
            200,
            vec![0; MAX_PREVIEW_BYTES + 1],
            crate::ErrorCode::Verification,
        ),
        (200, vec![0; 16], crate::ErrorCode::Unsupported),
    ] {
        let mut fixture = Fixture::status(500, String::new());
        fixture.image = (status, None, body);
        let code_seen = preview_error(&fixture, "https://cdn2.steamgriddb.com/thumb/2.png");
        assert!(
            code_seen == code || (status == 200 && code_seen == crate::ErrorCode::Verification),
            "status {status}: {code_seen:?}"
        );
    }
}

fn preview_error(fixture: &Fixture, url: &str) -> crate::ErrorCode {
    preview(fixture, url).unwrap_err().code
}

#[test]
fn author_names_are_bounded_clean_and_never_empty() {
    assert_eq!(author_name("  Name\n  "), "Name");
    assert_eq!(author_name("\u{1b}\u{7}  "), UNKNOWN_AUTHOR);
    assert_eq!(author_name(&"x".repeat(150)).chars().count(), 100);
}

/// Owner-authorized live exercise (#527, 2026-11-12). Run explicitly with
/// `cargo test -p portcove-core steamgriddb_live -- --ignored`; the session's
/// proxy supplies the owner's key, so the placeholder below is replaced in transit.
#[test]
#[ignore = "live SteamGridDB call; requires an authorized key"]
fn steamgriddb_live_search_and_candidates() {
    let key = "proxyinjectedplaceholder00000000";
    let games = search_games(&HttpTransport, key, "Super Mario 64").unwrap();
    assert!(!games.is_empty(), "no games returned");
    eprintln!(
        "live search: {} games; first id {}",
        games.len(),
        games[0].id
    );
    for role in [
        DestinationArtworkRole::PortraitCover,
        DestinationArtworkRole::LandscapeCover,
        DestinationArtworkRole::HeroBanner,
    ] {
        let candidates = role_candidates(&HttpTransport, key, games[0].id, role).unwrap();
        eprintln!("live {role:?}: {} candidates", candidates.len());
        for candidate in &candidates {
            assert!(is_image_url(&candidate.url) && is_image_url(&candidate.thumb));
            assert!(matches!(
                candidate.mime.as_str(),
                "image/png" | "image/jpeg"
            ));
        }
    }
}

/// Owner-authorized live exercise of the choose fetch path (#527, 2026-11-12):
/// re-resolve one candidate per role and fetch it from the CDN without the key,
/// then check that the shared decode matches the listing. No library is written.
#[test]
#[ignore = "live SteamGridDB call; requires an authorized key"]
fn steamgriddb_live_fetch_matches_listing() {
    let key = "proxyinjectedplaceholder00000000";
    let games = search_games(&HttpTransport, key, "Super Mario 64").unwrap();
    for role in [
        DestinationArtworkRole::PortraitCover,
        DestinationArtworkRole::HeroBanner,
    ] {
        let listed = role_candidates(&HttpTransport, key, games[0].id, role).unwrap();
        let first = listed.first().expect("no candidates");
        let fetched = fetch_candidate(&HttpTransport, key, games[0].id, role, first.id).unwrap();
        let decoded = crate::artwork_image::decode(&fetched.bytes).unwrap();
        eprintln!(
            "live fetch {role:?}: image {} {} bytes {}x{} {:?}",
            first.id,
            fetched.bytes.len(),
            decoded.width,
            decoded.height,
            decoded.format
        );
        assert_eq!(
            (decoded.width, decoded.height),
            (fetched.candidate.width, fetched.candidate.height)
        );
        let local = preview(&HttpTransport, &first.thumb).unwrap();
        eprintln!("live preview {role:?}: {} PNG bytes", local.len());
        assert!(local.starts_with(b"\x89PNG"));
    }
}
