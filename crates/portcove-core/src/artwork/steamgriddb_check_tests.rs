use std::{cell::RefCell, collections::VecDeque};

use super::*;
use crate::ArtworkProvider;

/// Answers provider requests in order and the image host with one fixed status.
struct Scripted {
    api: RefCell<VecDeque<(u16, Option<&'static str>, String)>>,
    image_status: u16,
    /// Per-probe statuses used before `image_status`; 0 is a transport error.
    image_statuses: RefCell<VecDeque<u16>>,
    paths: RefCell<Vec<String>>,
    images: RefCell<Vec<(String, u64)>>,
}

impl Scripted {
    fn new(responses: Vec<(u16, String)>, image_status: u16) -> Self {
        Self {
            api: RefCell::new(
                responses
                    .into_iter()
                    .map(|(status, body)| (status, None, body))
                    .collect(),
            ),
            image_status,
            image_statuses: RefCell::new(VecDeque::new()),
            paths: RefCell::new(Vec::new()),
            images: RefCell::new(Vec::new()),
        }
    }
}

impl SteamGridDbTransport for Scripted {
    fn get(&self, path_and_query: &str, key: &str) -> Result<TransportResponse> {
        assert_eq!(key, KEY);
        self.paths.borrow_mut().push(path_and_query.to_owned());
        let (status, retry_after, body) = self
            .api
            .borrow_mut()
            .pop_front()
            .expect("an unexpected provider request");
        if status == 0 {
            return Err(SteamGridDbFailure::Unavailable.into());
        }
        Ok(TransportResponse {
            status,
            retry_after: retry_after.map(str::to_owned),
            body: body.into_bytes(),
        })
    }

    fn fetch_image(&self, url: &str, max_bytes: u64) -> Result<TransportResponse> {
        self.images.borrow_mut().push((url.to_owned(), max_bytes));
        let status = self
            .image_statuses
            .borrow_mut()
            .pop_front()
            .unwrap_or(self.image_status);
        if status == 0 {
            return Err(SteamGridDbFailure::Unavailable.into());
        }
        Ok(TransportResponse {
            status,
            retry_after: None,
            body: Vec::new(),
        })
    }
}

const KEY: &str = "0123456789abcdef0123456789abcdef";

fn page(page: u64, total: u64, ids: &[u64]) -> (u16, String) {
    (
        200,
        serde_json::json!({
            "success": true,
            "page": page,
            "total": total,
            "limit": 50,
            "data": ids.iter().map(|id| serde_json::json!({"id": id, "url": "ignored"})).collect::<Vec<_>>(),
        })
        .to_string(),
    )
}

fn subject(
    asset_id: u64,
    game_id: u64,
    role: DestinationArtworkRole,
    size: (u32, u32),
) -> CheckSubject {
    CheckSubject {
        asset_sha256: format!("{asset_id:064x}"),
        attribution: ArtworkAttribution {
            provider: ArtworkProvider::Steamgriddb,
            asset_id,
            game_id,
            role,
            author_name: "Artist".into(),
            author_steam64: None,
            source_url: format!("https://cdn2.steamgriddb.com/grid/{asset_id}.png"),
            fetched_at: 1,
        },
        image: Some((size.0, size.1, ArtworkImageFormat::Png)),
        last_checked_at: None,
    }
}

fn portrait(asset_id: u64, game_id: u64) -> CheckSubject {
    subject(
        asset_id,
        game_id,
        DestinationArtworkRole::PortraitCover,
        (600, 900),
    )
}

fn control(cancelled: &dyn Fn() -> bool) -> CheckControl<'_> {
    CheckControl {
        pace: Duration::ZERO,
        deadline: None,
        cancelled,
    }
}

fn run(transport: &Scripted, subjects: Vec<CheckSubject>) -> SteamGridDbListingReport {
    check_listings(transport, KEY, subjects, control(&|| false), 42)
}

/// The listing outcome flattened for compact assertions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum L {
    Listed,
    NotListed,
    Unknown,
}

fn outcome(
    report: &SteamGridDbListingReport,
    index: usize,
) -> (L, Option<SteamGridDbUnknownReason>, SteamGridDbSourceStatus) {
    let image = &report.images[index];
    let (listing, reason) = match image.listing {
        SteamGridDbListingResult::Listed => (L::Listed, None),
        SteamGridDbListingResult::NotListed => (L::NotListed, None),
        SteamGridDbListingResult::Unknown { reason } => (L::Unknown, Some(reason)),
    };
    (listing, reason, image.source)
}

use SteamGridDbSourceStatus as S;
use SteamGridDbUnknownReason as R;

#[test]
fn an_exhaustive_listing_separates_listed_from_not_listed_and_probes_only_absent_images() {
    let first: Vec<u64> = (1..=50).collect();
    let transport = Scripted::new(vec![page(0, 52, &first), page(1, 52, &[51, 52])], 404);
    let report = run(&transport, vec![portrait(51, 7), portrait(99, 7)]);
    assert_eq!(report.checked_at, 42);
    assert_eq!(report.stopped, None);
    assert_eq!(outcome(&report, 0), (L::Listed, None, S::NotChecked));
    assert_eq!(outcome(&report, 1), (L::NotListed, None, S::Gone));
    // Both records share one listing, read by fixed facts with every flag set to any.
    assert_eq!(
        *transport.paths.borrow(),
        [0, 1].map(|page| format!(
            "/grids/game/7?dimensions=600x900&mimes=image/png&types=static&nsfw=any&humor=any&epilepsy=any&limit=50&page={page}"
        ))
    );
    assert_eq!(
        *transport.images.borrow(),
        [("https://cdn2.steamgriddb.com/grid/99.png".to_owned(), 1)]
    );
}

#[test]
fn a_still_served_image_is_reported_as_not_listed_but_served() {
    let transport = Scripted::new(vec![page(0, 1, &[5])], 200);
    let report = run(&transport, vec![portrait(6, 7)]);
    assert_eq!(outcome(&report, 0), (L::NotListed, None, S::Served));
}

#[test]
fn unreadable_or_inconsistent_listings_are_unknown_and_never_probed() {
    let missing_id = (
        200,
        serde_json::json!({"success": true, "page": 0, "total": 2, "limit": 50,
            "data": [{"id": 1}, {"identifier": 2}]})
        .to_string(),
    );
    let no_total = (
        200,
        serde_json::json!({"success": true, "page": 0, "limit": 50, "data": []}).to_string(),
    );
    let no_data = (
        200,
        serde_json::json!({"success": true, "page": 0, "total": 0, "limit": 50}).to_string(),
    );
    let wrong_page = page(3, 1, &[1]);
    let wrong_limit = (
        200,
        serde_json::json!({"success": true, "page": 0, "total": 1, "limit": 20, "data": [{"id": 1}]})
            .to_string(),
    );
    let failed = (
        200,
        serde_json::json!({"success": false, "page": 0, "total": 0, "limit": 50, "data": []})
            .to_string(),
    );
    for (responses, reason) in [
        // A page short of `total` asks for the next; an empty one ends an incomplete listing.
        (
            vec![page(0, 3, &[1, 2]), page(1, 3, &[])],
            R::IncompleteListing,
        ),
        (
            vec![page(0, 3, &[1, 2]), page(1, 3, &[2])],
            R::IncompleteListing,
        ),
    ] {
        let transport = Scripted::new(responses, 404);
        let report = run(&transport, vec![portrait(9, 7)]);
        assert_eq!(
            outcome(&report, 0),
            (L::Unknown, Some(reason), S::NotChecked)
        );
    }
    for (response, reason) in [
        (missing_id, R::IncompleteListing),
        (no_total, R::InvalidResponse),
        (no_data, R::InvalidResponse),
        (wrong_page, R::InvalidResponse),
        (wrong_limit, R::InvalidResponse),
        (failed, R::InvalidResponse),
        ((502, String::new()), R::Unavailable),
        ((400, String::new()), R::InvalidResponse),
    ] {
        let transport = Scripted::new(vec![response], 404);
        let report = run(&transport, vec![portrait(9, 7)]);
        assert_eq!(
            outcome(&report, 0),
            (L::Unknown, Some(reason), S::NotChecked)
        );
        assert!(transport.images.borrow().is_empty());
    }
}

#[test]
fn a_changing_total_or_repeated_ids_across_pages_is_incomplete() {
    let first: Vec<u64> = (1..=50).collect();
    for second in [page(1, 53, &[51, 52, 53]), page(1, 52, &[50, 51])] {
        let transport = Scripted::new(vec![page(0, 52, &first), second], 404);
        let report = run(&transport, vec![portrait(99, 7)]);
        assert_eq!(
            outcome(&report, 0),
            (L::Unknown, Some(R::IncompleteListing), S::NotChecked)
        );
    }
}

#[test]
fn a_missing_game_is_unknown_not_withdrawn_but_its_source_is_probed() {
    let not_found = (
        404,
        r#"{"success":false,"status":404,"errors":["Game not found"]}"#.to_owned(),
    );
    let transport = Scripted::new(vec![not_found], 200);
    let report = run(&transport, vec![portrait(9, 7)]);
    assert_eq!(
        outcome(&report, 0),
        (L::Unknown, Some(R::GameNotFound), S::Served)
    );
}

#[test]
fn a_rate_limit_stops_the_check_and_keeps_groups_already_read() {
    let transport = Scripted::new(vec![page(0, 1, &[1]), (429, String::new())], 404);
    transport.api.borrow_mut()[1].1 = Some("30");
    let report = run(
        &transport,
        vec![portrait(2, 7), portrait(3, 8), portrait(4, 9)],
    );
    assert_eq!(
        report.stopped,
        Some(SteamGridDbCheckStop::RateLimited {
            retry_after_seconds: Some(30)
        })
    );
    // Game 7 was read completely; its result stands, but no probe runs after a stop.
    assert_eq!(outcome(&report, 0), (L::NotListed, None, S::NotChecked));
    for index in [1, 2] {
        assert_eq!(
            outcome(&report, index),
            (L::Unknown, Some(R::CheckStopped), S::NotChecked)
        );
    }
    assert_eq!(transport.paths.borrow().len(), 2);
    assert!(transport.images.borrow().is_empty());
}

#[test]
fn a_rejected_key_stops_the_check() {
    let transport = Scripted::new(vec![(401, String::new())], 404);
    let report = run(&transport, vec![portrait(2, 7)]);
    assert_eq!(report.stopped, Some(SteamGridDbCheckStop::KeyRejected));
    assert_eq!(
        outcome(&report, 0),
        (L::Unknown, Some(R::CheckStopped), S::NotChecked)
    );
}

#[test]
fn an_image_server_rate_limit_also_stops_the_check() {
    let transport = Scripted::new(vec![page(0, 1, &[999]), page(0, 1, &[999])], 429);
    let report = run(&transport, vec![portrait(2, 7), portrait(3, 8)]);
    assert!(matches!(
        report.stopped,
        Some(SteamGridDbCheckStop::RateLimited { .. })
    ));
    assert_eq!(outcome(&report, 0), (L::NotListed, None, S::Unknown));
    assert_eq!(outcome(&report, 1), (L::NotListed, None, S::NotChecked));
    assert_eq!(transport.images.borrow().len(), 1);
}

#[test]
fn listings_longer_than_one_check_reads_are_unknown() {
    let transport = Scripted::new(vec![page(0, 1001, &[1])], 404);
    let report = run(&transport, vec![portrait(2, 7)]);
    assert_eq!(
        outcome(&report, 0),
        (L::Unknown, Some(R::TooManyImages), S::NotChecked)
    );
    assert_eq!(transport.paths.borrow().len(), 1);
}

#[test]
fn the_request_budget_bounds_a_whole_check() {
    let groups = MAX_CHECK_API_REQUESTS as u64 + 5;
    let transport = Scripted::new(
        (0..MAX_CHECK_API_REQUESTS)
            .map(|_| page(0, 1, &[1]))
            .collect(),
        200,
    );
    let subjects = (0..groups).map(|game| portrait(1, game + 1)).collect();
    let report = run(&transport, subjects);
    assert_eq!(
        transport.paths.borrow().len(),
        MAX_CHECK_API_REQUESTS as usize
    );
    assert!(
        report.images[..MAX_CHECK_API_REQUESTS as usize]
            .iter()
            .all(|image| image.listing == SteamGridDbListingResult::Listed)
    );
    assert!(
        report.images[MAX_CHECK_API_REQUESTS as usize..]
            .iter()
            .all(|image| {
                image.listing
                    == SteamGridDbListingResult::Unknown {
                        reason: R::RequestLimit,
                    }
            })
    );
}

#[test]
fn roles_map_to_their_collection_and_undocumented_sizes_list_the_whole_collection() {
    // Groups are read in a fixed order: grids before heroes.
    let transport = Scripted::new(vec![page(0, 1, &[2]), page(0, 1, &[1])], 404);
    let mut jpeg_hero = subject(1, 7, DestinationArtworkRole::HeroBanner, (1920, 620));
    jpeg_hero.image = Some((1920, 620, ArtworkImageFormat::Jpeg));
    let odd_landscape = subject(2, 7, DestinationArtworkRole::LandscapeCover, (500, 250));
    let report = run(&transport, vec![jpeg_hero, odd_landscape]);
    assert!(
        report
            .images
            .iter()
            .all(|image| image.listing == SteamGridDbListingResult::Listed)
    );
    let paths = transport.paths.borrow();
    assert!(paths.contains(
        &"/heroes/game/7?dimensions=1920x620&mimes=image/jpeg&types=static&nsfw=any&humor=any&epilepsy=any&limit=50&page=0".to_owned()
    ));
    assert!(paths.contains(
        &"/grids/game/7?mimes=image/png&types=static&nsfw=any&humor=any&epilepsy=any&limit=50&page=0".to_owned()
    ));
}

#[test]
fn an_empty_library_needs_no_key_and_makes_no_request() {
    let report = check_stored_listings(Vec::new(), 5, &|| false).unwrap();
    assert_eq!(
        report,
        SteamGridDbListingReport {
            checked_at: 5,
            images: Vec::new(),
            stopped: None,
        }
    );
}

#[test]
fn answers_after_the_first_page_never_read_as_a_missing_game() {
    let first: Vec<u64> = (1..=50).collect();
    for (status, expected) in [
        (404, Some(R::IncompleteListing)),
        (502, Some(R::Unavailable)),
        (0, Some(R::Unavailable)),
    ] {
        let transport = Scripted::new(vec![page(0, 60, &first), (status, String::new())], 200);
        let report = run(&transport, vec![portrait(99, 7)]);
        assert_eq!(outcome(&report, 0), (L::Unknown, expected, S::NotChecked));
        assert_eq!(report.stopped, None);
    }
    for status in [401, 403] {
        let transport = Scripted::new(vec![page(0, 60, &first), (status, String::new())], 200);
        let report = run(&transport, vec![portrait(99, 7)]);
        assert_eq!(report.stopped, Some(SteamGridDbCheckStop::KeyRejected));
        assert_eq!(
            outcome(&report, 0),
            (L::Unknown, Some(R::CheckStopped), S::NotChecked)
        );
    }
}

#[test]
fn page_shape_limits_are_enforced() {
    let too_many: Vec<u64> = (1..=51).collect();
    let duplicate_within_page = page(0, 2, &[4, 4]);
    for (response, reason) in [
        (page(0, 51, &too_many), R::InvalidResponse),
        (duplicate_within_page, R::IncompleteListing),
        (page(0, 0, &[1]), R::IncompleteListing),
    ] {
        let transport = Scripted::new(vec![response], 404);
        let report = run(&transport, vec![portrait(9, 7)]);
        assert_eq!(
            outcome(&report, 0),
            (L::Unknown, Some(reason), S::NotChecked)
        );
    }
}

#[test]
fn exact_page_multiples_need_no_extra_request() {
    for pages in [1_u64, 2, 20] {
        let total = pages * 50;
        let responses = (0..pages)
            .map(|index| {
                let ids: Vec<u64> = (index * 50 + 1..=index * 50 + 50).collect();
                page(index, total, &ids)
            })
            .collect();
        let transport = Scripted::new(responses, 404);
        let report = run(&transport, vec![portrait(total, 7)]);
        assert_eq!(outcome(&report, 0), (L::Listed, None, S::NotChecked));
        assert_eq!(transport.paths.borrow().len() as u64, pages);
    }
}

#[test]
fn consecutive_unreachable_listings_stop_the_check() {
    let transport = Scripted::new(vec![(503, String::new()), (0, String::new())], 200);
    let report = run(
        &transport,
        vec![portrait(1, 7), portrait(2, 8), portrait(3, 9)],
    );
    assert_eq!(report.stopped, Some(SteamGridDbCheckStop::Unavailable));
    assert_eq!(
        outcome(&report, 0),
        (L::Unknown, Some(R::Unavailable), S::NotChecked)
    );
    assert_eq!(
        outcome(&report, 1),
        (L::Unknown, Some(R::Unavailable), S::NotChecked)
    );
    assert_eq!(
        outcome(&report, 2),
        (L::Unknown, Some(R::CheckStopped), S::NotChecked)
    );
    assert_eq!(transport.paths.borrow().len(), 2);

    // One unreachable listing between readable ones does not stop the check.
    let transport = Scripted::new(
        vec![(503, String::new()), page(0, 1, &[2]), (503, String::new())],
        200,
    );
    let report = run(
        &transport,
        vec![portrait(1, 7), portrait(2, 8), portrait(3, 9)],
    );
    assert_eq!(report.stopped, None);
    assert_eq!(outcome(&report, 1), (L::Listed, None, S::NotChecked));
}

#[test]
fn a_budget_exhausted_mid_listing_keeps_only_ids_it_saw() {
    let ids: Vec<u64> = (1..=50).collect();
    let groups = MAX_CHECK_API_REQUESTS as u64 - 1;
    let mut responses: Vec<_> = (0..groups).map(|_| page(0, 1, &[1])).collect();
    responses.push(page(0, 100, &ids));
    let transport = Scripted::new(responses, 200);
    let mut subjects: Vec<_> = (0..groups).map(|game| portrait(1, game + 1)).collect();
    // The last group's listing never completes: an image seen on its first page
    // is listed, one not seen is unknown, and neither counts as attempted.
    subjects.push(portrait(5, 10_000));
    subjects.push(portrait(99, 10_000));
    let report = run(&transport, subjects);
    let seen = groups as usize;
    assert_eq!(outcome(&report, seen), (L::Listed, None, S::NotChecked));
    assert_eq!(
        outcome(&report, seen + 1),
        (L::Unknown, Some(R::RequestLimit), S::NotChecked)
    );
    assert!(!report.images[seen].attempted && !report.images[seen + 1].attempted);
    assert!(report.images[0].attempted);
}

#[test]
fn source_probes_classify_answers_and_respect_their_budget() {
    let probes = MAX_CHECK_SOURCE_PROBES as usize;
    let transport = Scripted::new(vec![page(0, 1, &[999])], 200);
    *transport.image_statuses.borrow_mut() = [410, 403, 503, 0, 200].into_iter().collect();
    let mut subjects: Vec<_> = (1..=probes as u64 + 2).map(|id| portrait(id, 7)).collect();
    subjects[0].attribution.source_url = "https://example.com/1.png".into();
    let report = run(&transport, subjects);
    // A source outside the image host is never requested.
    assert_eq!(outcome(&report, 0), (L::NotListed, None, S::Unknown));
    let statuses: Vec<_> = report.images[1..6]
        .iter()
        .map(|image| image.source)
        .collect();
    assert_eq!(
        statuses,
        [S::Gone, S::Unknown, S::Unknown, S::Unknown, S::Served]
    );
    assert_eq!(transport.images.borrow().len(), probes);
    assert_eq!(report.images[probes + 1].source, S::Unknown);
    assert!(
        transport
            .images
            .borrow()
            .iter()
            .all(|(url, max)| url.starts_with("https://cdn2.steamgriddb.com/") && *max == 1)
    );
}

#[test]
fn an_empty_narrowed_listing_is_corroborated_by_the_unfiltered_one() {
    let narrowed = "/grids/game/7?dimensions=600x900&mimes=image/png&types=static&nsfw=any&humor=any&epilepsy=any&limit=50&page=0";
    let unfiltered = "/grids/game/7?types=static&nsfw=any&humor=any&epilepsy=any&limit=50&page=0";
    // The only image of its size and format is gone, and others remain listed.
    let transport = Scripted::new(vec![page(0, 0, &[]), page(0, 2, &[3, 4])], 404);
    let report = run(&transport, vec![portrait(9, 7)]);
    assert_eq!(outcome(&report, 0), (L::NotListed, None, S::Gone));
    assert_eq!(*transport.paths.borrow(), [narrowed, unfiltered]);
    // SteamGridDB lists nothing at all for the game and role: absence proves nothing.
    let transport = Scripted::new(vec![page(0, 0, &[]), page(0, 0, &[])], 404);
    let report = run(&transport, vec![portrait(9, 7)]);
    assert_eq!(
        outcome(&report, 0),
        (L::Unknown, Some(R::EmptyListing), S::Gone)
    );
    // The unfiltered listing still shows it, so it is listed.
    let transport = Scripted::new(vec![page(0, 0, &[]), page(0, 2, &[9, 4])], 404);
    let report = run(&transport, vec![portrait(9, 7)]);
    assert_eq!(outcome(&report, 0), (L::Listed, None, S::NotChecked));
    // An unverified corroboration keeps its own reason.
    let transport = Scripted::new(vec![page(0, 0, &[]), (502, String::new())], 404);
    let report = run(&transport, vec![portrait(9, 7)]);
    assert_eq!(
        outcome(&report, 0),
        (L::Unknown, Some(R::Unavailable), S::NotChecked)
    );
}

#[test]
fn an_empty_unnarrowed_listing_is_unknown_without_a_second_request() {
    let mut without_facts = portrait(9, 7);
    without_facts.image = None;
    let transport = Scripted::new(vec![page(0, 0, &[])], 404);
    let report = run(&transport, vec![without_facts]);
    assert_eq!(
        outcome(&report, 0),
        (L::Unknown, Some(R::EmptyListing), S::Gone)
    );
    assert_eq!(transport.paths.borrow().len(), 1);
    assert_eq!(report.images[0].listing_total, Some(0));
}

#[test]
fn ids_seen_on_unverified_listings_are_still_listed() {
    let unreadable_entry = (
        200,
        serde_json::json!({"success": true, "page": 0, "total": 2, "limit": 50,
            "data": [{"id": 1}, {"identifier": 2}]})
        .to_string(),
    );
    let transport = Scripted::new(vec![unreadable_entry], 404);
    let report = run(&transport, vec![portrait(1, 7), portrait(2, 7)]);
    assert_eq!(outcome(&report, 0), (L::Listed, None, S::NotChecked));
    assert_eq!(
        outcome(&report, 1),
        (L::Unknown, Some(R::IncompleteListing), S::NotChecked)
    );
    // Too many images to verify, but the first page still shows it.
    let transport = Scripted::new(vec![page(0, 1001, &[5])], 404);
    let report = run(&transport, vec![portrait(5, 7), portrait(6, 7)]);
    assert_eq!(outcome(&report, 0), (L::Listed, None, S::NotChecked));
    assert_eq!(
        outcome(&report, 1),
        (L::Unknown, Some(R::TooManyImages), S::NotChecked)
    );
    assert_eq!(report.images[0].listing_total, Some(1001));
}

#[test]
fn attempted_marks_groups_this_run_concluded() {
    // Game 7 is unreachable, game 8 rejects the key, game 9 is never reached.
    let transport = Scripted::new(vec![(503, String::new()), (401, String::new())], 404);
    let report = run(
        &transport,
        vec![portrait(1, 7), portrait(2, 8), portrait(3, 9)],
    );
    assert_eq!(report.stopped, Some(SteamGridDbCheckStop::KeyRejected));
    assert_eq!(
        report
            .images
            .iter()
            .map(|image| image.attempted)
            .collect::<Vec<_>>(),
        [true, true, false]
    );
}

#[test]
fn the_stalest_groups_are_listed_and_probed_first() {
    let mut recent = portrait(1, 1);
    recent.last_checked_at = Some(100);
    let mut older = portrait(2, 2);
    older.last_checked_at = Some(50);
    let never = portrait(3, 3);
    let transport = Scripted::new(
        vec![page(0, 1, &[99]), page(0, 1, &[99]), page(0, 1, &[99])],
        404,
    );
    let report = run(&transport, vec![recent, older, never]);
    let games: Vec<String> = transport
        .paths
        .borrow()
        .iter()
        .map(|path| path.split('?').next().unwrap().to_owned())
        .collect();
    assert_eq!(games, ["/grids/game/3", "/grids/game/2", "/grids/game/1"]);
    let probed: Vec<String> = transport
        .images
        .borrow()
        .iter()
        .map(|(url, _)| url.clone())
        .collect();
    assert_eq!(
        probed,
        [3, 2, 1].map(|id| format!("https://cdn2.steamgriddb.com/grid/{id}.png"))
    );
    // Results stay in subject order.
    assert_eq!(report.images[0].attribution.asset_id, 1);
}

#[test]
fn cancellation_and_the_deadline_stop_before_the_next_request() {
    let transport = Scripted::new(Vec::new(), 404);
    let report = check_listings(&transport, KEY, vec![portrait(1, 7)], control(&|| true), 0);
    assert_eq!(report.stopped, Some(SteamGridDbCheckStop::Cancelled));
    assert!(transport.paths.borrow().is_empty());
    assert!(!report.images[0].attempted);

    let transport = Scripted::new(Vec::new(), 404);
    let report = check_listings(
        &transport,
        KEY,
        vec![portrait(1, 7)],
        CheckControl {
            pace: Duration::ZERO,
            deadline: Some(Instant::now()),
            cancelled: &|| false,
        },
        0,
    );
    assert_eq!(report.stopped, Some(SteamGridDbCheckStop::TimeLimit));
    assert!(transport.paths.borrow().is_empty());

    // A cancel between the listing and the probe stops before the probe.
    let calls = std::cell::Cell::new(0);
    let cancel_after_listing = || {
        calls.set(calls.get() + 1);
        calls.get() > 1
    };
    let transport = Scripted::new(vec![page(0, 1, &[99])], 404);
    let report = check_listings(
        &transport,
        KEY,
        vec![portrait(1, 7)],
        control(&cancel_after_listing),
        0,
    );
    assert_eq!(report.stopped, Some(SteamGridDbCheckStop::Cancelled));
    assert_eq!(outcome(&report, 0), (L::NotListed, None, S::NotChecked));
    assert!(transport.images.borrow().is_empty());
}

/// Owner-authorized live exercise of the report-only check (#527, 2026-11-13):
/// real picker candidates are treated as stored images, plus one ID that is not
/// in the listing, and the hardened listing must classify both. Nothing is written.
#[test]
#[ignore = "live SteamGridDB call; requires an authorized key"]
fn steamgriddb_live_listing_check() {
    let key = "proxyinjectedplaceholder00000000";
    let games = search_games(&HttpTransport, key, "Celeste").unwrap();
    let game = games[0].id;
    let mut subjects = Vec::new();
    for role in [
        DestinationArtworkRole::PortraitCover,
        DestinationArtworkRole::HeroBanner,
    ] {
        let candidate = role_candidates(&HttpTransport, key, game, role)
            .unwrap()
            .into_iter()
            .next()
            .expect("no candidates");
        let mut stored = subject(
            candidate.id,
            game,
            role,
            (candidate.width, candidate.height),
        );
        stored.attribution.source_url = candidate.url;
        subjects.push(stored);
    }
    let mut absent = subject(
        u64::MAX / 2,
        game,
        DestinationArtworkRole::PortraitCover,
        (600, 900),
    );
    absent.attribution.source_url =
        "https://cdn2.steamgriddb.com/grid/00000000000000000000000000000000.png".into();
    subjects.push(absent);
    let report = check_listings(
        &HttpTransport,
        key,
        subjects,
        CheckControl {
            pace: CHECK_PACE,
            deadline: None,
            cancelled: &|| false,
        },
        0,
    );
    for image in &report.images {
        eprintln!(
            "live check: {} {:?} -> {:?} {:?} {:?}",
            image.attribution.asset_id,
            image.attribution.role,
            image.listing,
            image.listing_total,
            image.source
        );
    }
    assert_eq!(report.stopped, None);
    assert_eq!(outcome(&report, 0).0, L::Listed);
    assert_eq!(outcome(&report, 1).0, L::Listed);
    assert_eq!(outcome(&report, 2), (L::NotListed, None, S::Gone));
}
