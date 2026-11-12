use std::cell::RefCell;

use super::*;

/// Records every request and answers with a fixed response.
struct Fixture {
    status: u16,
    retry_after: Option<&'static str>,
    body: String,
    requests: RefCell<Vec<(String, String)>>,
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
            body: self.body.clone().into_bytes(),
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
