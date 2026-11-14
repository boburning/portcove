//! Withdrawal slice 2b (#527): the two-signal rule, eviction, restore and
//! transfer of withdrawn provider images.

use super::*;
use crate::artwork_store::{
    Applied, ListingObservation, WITHDRAWAL_WAIT_SECONDS as DAY, WithdrawalChange,
    apply_listing_check, listing_checks,
};
use crate::{
    ArtworkProvider::Steamgriddb, DestinationArtworkRole as Role, SteamGridDbCheckEffect as Effect,
    SteamGridDbListingResult as Listing, SteamGridDbSourceStatus as Source,
};

fn choose_provider(service: &PortcoveService, revision: u64) -> crate::ArtworkState {
    let port = service.artwork_port("zelda64-recomp").unwrap();
    service
        .choose_fetched_artwork(
            &port,
            ArtworkSlot::Cover,
            42,
            provider_candidate(
                7,
                Role::PortraitCover,
                12,
                24,
                "image/png",
                encoded(12, 24, image::ImageFormat::Png),
            ),
            revision,
        )
        .unwrap()
}

/// A recorded check whose only image is not listed and whose probe answered `source`.
fn absent(service: &PortcoveService, source: Source) -> crate::SteamGridDbListingReport {
    service
        .run_listing_check(&|| false, |subjects, now| {
            let mut report = prepared_report(&subjects, Listing::NotListed, true, now);
            report.images[0].source = source;
            Ok(report)
        })
        .unwrap()
}

fn cover(service: &PortcoveService) -> crate::ArtworkState {
    service
        .artwork("zelda64-recomp", ArtworkSlot::Cover)
        .unwrap()
}

#[test]
fn a_withdrawal_needs_a_second_signal_from_the_observation_being_applied() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let sha = choose_provider(&service, 0).selection.unwrap().sha256;
    let connection = service.library().connection().unwrap();
    let apply = |result: &str, source, dates, now| {
        let revision = listing_checks(&connection, Steamgriddb).unwrap()[0].revision;
        apply_listing_check(
            &connection,
            Steamgriddb,
            &sha,
            7,
            Some(revision),
            &ListingObservation {
                result,
                unknown_reason: (result == "unknown").then_some("empty_listing"),
                total: Some(3),
                source,
                server_dates: dates,
            },
            now,
        )
        .unwrap()
    };
    let unchanged = Applied::Recorded(WithdrawalChange::Unchanged);
    let withdrawn = Applied::Recorded(WithdrawalChange::Withdrawn);
    let t0 = 2_000_000_000;
    // A `gone` answered beside an empty listing proves nothing, and a later
    // absence without a probe of its own cannot borrow it.
    assert_eq!(apply("unknown", Some("gone"), None, t0), unchanged);
    assert_eq!(
        apply("not_listed", None, Some((t0, t0 + 5)), t0 + 10),
        unchanged
    );
    let row = listing_checks(&connection, Steamgriddb).unwrap().remove(0);
    assert_eq!(
        (row.not_listed_since, row.not_listed_since_server),
        (Some(t0 + 10), Some(t0 + 5))
    );
    // 24 hours by one clock only is not enough, and neither is a missing date.
    assert_eq!(
        apply(
            "not_listed",
            None,
            Some((t0 + 4 + DAY, t0 + DAY + 9)),
            t0 + 10 + DAY
        ),
        unchanged
    );
    assert_eq!(
        apply(
            "not_listed",
            None,
            Some((t0 + 5 + DAY, t0 + 5 + DAY)),
            t0 + 9 + DAY
        ),
        unchanged
    );
    assert_eq!(apply("not_listed", None, None, t0 + 20 + DAY), unchanged);
    // Unknown never confirms, even with a `gone` probe.
    assert_eq!(
        apply(
            "unknown",
            Some("gone"),
            Some((t0 + 2 * DAY, t0 + 2 * DAY)),
            t0 + 2 * DAY
        ),
        unchanged
    );
    // Both clocks past 24 hours: the second verified absence confirms it once.
    assert_eq!(
        apply(
            "not_listed",
            None,
            Some((t0 + 5 + DAY, t0 + 6 + DAY)),
            t0 + 10 + DAY
        ),
        withdrawn
    );
    assert_eq!(
        apply(
            "not_listed",
            Some("gone"),
            Some((t0 + 3 * DAY, t0 + 3 * DAY)),
            t0 + 3 * DAY
        ),
        unchanged
    );
    let withdrawals = crate::artwork_store::asset_withdrawals(&connection, &sha).unwrap();
    assert_eq!(withdrawals.len(), 1);
    assert_eq!(
        (
            withdrawals[0].1.withdrawn_at,
            withdrawals[0].1.signal.as_str()
        ),
        (t0 + 10 + DAY, "absent_again")
    );
    // An observed listing deletes it and both absence clocks.
    assert_eq!(
        apply("listed", None, None, t0 + 4 * DAY),
        Applied::Recorded(WithdrawalChange::Cleared)
    );
    let row = listing_checks(&connection, Steamgriddb).unwrap().remove(0);
    assert_eq!(
        (row.not_listed_since, row.not_listed_since_server),
        (None, None)
    );
    assert!(
        crate::artwork_store::asset_withdrawals(&connection, &sha)
            .unwrap()
            .is_empty()
    );
    // A `gone` probe in the same check confirms even a first absence.
    assert_eq!(
        apply("not_listed", Some("gone"), None, t0 + 5 * DAY),
        withdrawn
    );
    // A row recorded before server dates were kept catches up on its next
    // absence, and the wait then runs from that date.
    connection
        .execute(
            "UPDATE artwork_provider_listing_checks SET not_listed_since_server=NULL",
            [],
        )
        .unwrap();
    connection
        .execute("DELETE FROM artwork_provider_withdrawals", [])
        .unwrap();
    let late = t0 + 9 * DAY;
    assert_eq!(
        apply("not_listed", None, Some((late, late)), late),
        unchanged
    );
    assert_eq!(
        listing_checks(&connection, Steamgriddb).unwrap()[0].not_listed_since_server,
        Some(late)
    );
    assert_eq!(
        apply(
            "not_listed",
            None,
            Some((late + DAY, late + DAY)),
            late + DAY
        ),
        withdrawn
    );
}

#[test]
fn a_confirmed_withdrawal_removes_a_provider_only_copy_and_keeps_the_choice() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let chosen = choose_provider(&service, 0);
    let sha = chosen.selection.clone().unwrap().sha256;
    service
        .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, chosen.choice.revision)
        .unwrap();
    let original = crate::artwork::original_path(service.library(), &sha).unwrap();
    let thumbnail = crate::artwork::thumbnail_path(service.library(), &sha).unwrap();
    assert!(original.exists() && thumbnail.exists());

    // A served image that is not listed is only a first absence.
    let report = absent(&service, Source::Served);
    assert_eq!(report.images[0].effect, Effect::None);
    assert_eq!(cover(&service).availability, ArtworkAvailability::Available);

    let report = absent(&service, Source::Gone);
    assert!(report.recorded);
    assert_eq!(report.images[0].effect, Effect::Removed);
    assert_eq!(
        (
            report.removed,
            report.removal_deferred,
            report.removal_failed
        ),
        (1, 0, 0)
    );
    assert!(!original.exists() && !thumbnail.exists());
    let state = cover(&service);
    assert_eq!(state.availability, ArtworkAvailability::Unavailable);
    assert_eq!(
        state.reason.as_deref(),
        Some(crate::artwork::EVICTED_REASON)
    );
    assert_eq!(
        state.resolved_source,
        ArtworkResolvedSource::GeneratedFallback
    );
    assert_eq!(state.choice, chosen.choice);
    assert_eq!(state.attribution, chosen.attribution);
    assert_eq!(state.evicted_at, Some(report.checked_at));
    assert_eq!(
        state.provider_listing[0].withdrawn_at,
        Some(report.checked_at)
    );
    assert_eq!(
        state.provider_listing[0].withdrawal_signal,
        Some(crate::ArtworkWithdrawalSignal::Gone)
    );
    // Steam and thumbnails see the same: nothing is handed out.
    let handoff = service
        .destination_artwork("zelda64-recomp", Role::PortraitCover)
        .unwrap();
    assert_eq!(
        handoff.content,
        crate::DestinationArtworkContent::Unavailable {
            reason: crate::DestinationArtworkUnavailableReason::SelectedOriginalUnavailable
        }
    );
    let error = service
        .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, chosen.choice.revision)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::NotFound);

    // Listed again: the withdrawal goes, the copy stays removed until chosen.
    let report = service
        .run_listing_check(&|| false, |subjects, now| {
            Ok(prepared_report(&subjects, Listing::Listed, true, now))
        })
        .unwrap();
    assert_eq!(report.images[0].effect, Effect::ListedAgain);
    let state = cover(&service);
    assert_eq!(
        state.reason.as_deref(),
        Some(crate::artwork::EVICTED_LISTED_AGAIN_REASON)
    );
    assert_eq!(state.provider_listing[0].withdrawn_at, None);

    // Choosing it again downloads and restores the copy.
    let restored = choose_provider(&service, state.choice.revision);
    assert_eq!(restored.availability, ArtworkAvailability::Available);
    assert_eq!(restored.evicted_at, None);
    assert!(original.exists());
}

#[test]
fn the_players_own_import_is_never_removed() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let chosen = choose_provider(&service, 0);
    let sha = chosen.selection.clone().unwrap().sha256;
    // The player imports the same bytes, which makes the asset their own.
    let source = temp.path().join("cover.png");
    fs::write(&source, encoded(12, 24, image::ImageFormat::Png)).unwrap();
    service
        .import_artwork(
            "zelda64-recomp",
            ArtworkSlot::Cover,
            &source,
            chosen.choice.revision,
        )
        .unwrap();
    let report = absent(&service, Source::Gone);
    assert_eq!(report.images[0].effect, Effect::Withdrawn);
    assert_eq!(report.removed, 0);
    assert!(
        crate::artwork::original_path(service.library(), &sha)
            .unwrap()
            .exists()
    );
    let state = cover(&service);
    assert_eq!(state.availability, ArtworkAvailability::Available);
    assert_eq!(state.evicted_at, None);
    assert!(state.provider_listing[0].withdrawn_at.is_some());
}

#[test]
fn a_held_copy_stays_hidden_blocks_transfer_and_a_failed_restore_changes_nothing() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let service = open_service(&root);
    let chosen = choose_provider(&service, 0);
    let sha = chosen.selection.clone().unwrap().sha256;
    let original = crate::artwork::original_path(service.library(), &sha).unwrap();
    // Something other than a regular file in its place cannot be deleted.
    fs::remove_file(&original).unwrap();
    fs::create_dir(&original).unwrap();
    let report = absent(&service, Source::Gone);
    assert_eq!(report.images[0].effect, Effect::Removed);
    assert_eq!(
        (
            report.removed,
            report.removal_deferred,
            report.removal_failed
        ),
        (0, 0, 1)
    );
    assert_eq!(
        cover(&service).availability,
        ArtworkAvailability::Unavailable
    );
    // A transfer never carries it: the export and the move stop with a next step.
    let error = service
        .write_library_metadata(&temp.path().join("export.json"))
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert!(error.message.contains("couldn't finish removing 1 image"));
    assert!(
        service
            .plan_library_move(&temp.path().join("moved"))
            .is_err()
    );
    // Restoring cannot publish over it, and changes nothing when it fails.
    let connection = service.library().connection().unwrap();
    let before = crate::artwork_store::snapshot(&connection).unwrap();
    let port = service.artwork_port("zelda64-recomp").unwrap();
    assert!(
        service
            .choose_fetched_artwork(
                &port,
                ArtworkSlot::Cover,
                42,
                provider_candidate(
                    7,
                    Role::PortraitCover,
                    12,
                    24,
                    "image/png",
                    encoded(12, 24, image::ImageFormat::Png),
                ),
                chosen.choice.revision,
            )
            .is_err()
    );
    assert_eq!(crate::artwork_store::snapshot(&connection).unwrap(), before);
    assert!(cover(&service).evicted_at.is_some());
    // Once the obstacle is gone, the next export finishes the removal.
    fs::remove_dir(&original).unwrap();
    fs::write(&original, b"stale").unwrap();
    let written = service
        .write_library_metadata(&temp.path().join("export.json"))
        .unwrap();
    assert!(!original.exists());
    let exported: crate::LibraryMetadata =
        serde_json::from_slice(&fs::read(&written.path).unwrap()).unwrap();
    assert_eq!(exported.schema_version, 10);
}

#[test]
fn evicted_artwork_moves_and_imports_without_its_original() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    let service = open_service(&root);
    let chosen = choose_provider(&service, 0);
    absent(&service, Source::Gone);
    let metadata = service.export_library_metadata().unwrap();
    let artwork = metadata.artwork.clone().unwrap();
    assert_eq!(artwork.evicted_assets.len(), 1);
    assert_eq!(artwork.withdrawals.len(), 1);
    // An older reader contract cannot carry it.
    let mut older = metadata.clone();
    older.schema_version = 9;
    let catalogs = crate::library_import::PortabilityCatalogs::from_root(&older, &root).unwrap();
    assert!(crate::library_import::validate_metadata(&older, &catalogs).is_err());

    let export = temp.path().join("export.json");
    service.write_library_metadata(&export).unwrap();
    let destination = temp.path().join("destination");
    let plan = service.plan_library_move(&destination).unwrap();
    drop(service);
    PortcoveService::move_library(&root, &destination, &plan.plan_sha256).unwrap();
    let moved = open_service(&destination);
    let state = cover(&moved);
    assert!(state.evicted_at.is_some());
    assert_eq!(state.choice, chosen.choice);
    assert_eq!(state.availability, ArtworkAvailability::Unavailable);
    drop(moved);

    let imported = temp.path().join("imported");
    let plan = PortcoveService::plan_library_import(&export, &destination, &imported).unwrap();
    PortcoveService::import_library(&export, &destination, &imported, &plan.plan_sha256).unwrap();
    let imported = open_service(&imported);
    let state = cover(&imported);
    assert!(state.evicted_at.is_some());
    assert_eq!(
        state.reason.as_deref(),
        Some(crate::artwork::EVICTED_REASON)
    );
    // Restoring in the imported library works like anywhere else.
    let restored = choose_provider(&imported, state.choice.revision);
    assert_eq!(restored.availability, ArtworkAvailability::Available);
}

#[test]
fn removed_originals_no_longer_count_against_storage() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let chosen = choose_provider(&service, 0);
    let asset = chosen.selection.unwrap();
    absent(&service, Source::Gone);
    let connection = service.library().connection().unwrap();
    let (stored, live): (u64, u64) = connection
        .query_row(
            "SELECT COALESCE(SUM(byte_size),0),COALESCE(SUM(CASE WHEN sha256 IN (SELECT asset_sha256 FROM artwork_evicted_assets) THEN 0 ELSE byte_size END),0) FROM artwork_assets",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((stored, live), (asset.byte_size, 0));
    // Restoring is checked like a new import, and fits.
    crate::artwork_store::check_capacity(&connection, &asset).unwrap();
}

#[test]
fn a_prepared_check_holds_no_lease_and_records_into_no_other_library() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let service = open_service(&root);
    choose_provider(&service, 0);
    let prepared = service.prepare_steamgriddb_listing_check().unwrap();
    // The network phase keeps no library in use: another process could take
    // the library exclusively once this service is gone.
    drop(service);
    drop(
        crate::library_access::LibraryLease::with_access(
            &root,
            crate::library_access::LibraryAccess::Exclusive,
        )
        .unwrap(),
    );
    let checked = prepared
        .check_with(|subjects, now| {
            let mut report = prepared_report(&subjects, Listing::NotListed, true, now);
            report.images[0].source = Source::Gone;
            Ok(report)
        })
        .unwrap();
    // Another library never receives it.
    let other = open_service(&temp.path().join("other"));
    let report = other.record_steamgriddb_listings(checked, &|| false);
    assert!(!report.recorded);
    assert_eq!(report.images[0].effect, Effect::None);
    let reopened = open_service(&root);
    assert_eq!(cover(&reopened).evicted_at, None);
}

#[test]
fn removals_are_bounded_per_call_and_the_rest_are_deferred() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let cover_sha = choose_provider(&service, 0).selection.unwrap().sha256;
    let port = service.artwork_port("zelda64-recomp").unwrap();
    let detail_sha = service
        .choose_fetched_artwork(
            &port,
            ArtworkSlot::Detail,
            42,
            provider_candidate(
                8,
                Role::HeroBanner,
                40,
                20,
                "image/png",
                encoded(40, 20, image::ImageFormat::Png),
            ),
            0,
        )
        .unwrap()
        .selection
        .unwrap()
        .sha256;
    let report = service
        .run_listing_check(&|| false, |subjects, now| {
            let mut report = prepared_report(&subjects, Listing::NotListed, true, now);
            for image in &mut report.images {
                image.source = Source::Gone;
            }
            Ok(report)
        })
        .unwrap();
    assert_eq!(report.removed, 2);
    // Copies that came back on disk are removed again, one per call here.
    for sha in [&cover_sha, &detail_sha] {
        fs::write(
            crate::artwork::original_path(service.library(), sha).unwrap(),
            b"stale",
        )
        .unwrap();
    }
    let _guard = service.library().try_lock_artwork().unwrap();
    let counts =
        crate::artwork_eviction::complete_pending_evictions(service.library(), Some(1)).unwrap();
    assert_eq!((counts.removed, counts.deferred, counts.failed), (1, 1, 0));
    let counts =
        crate::artwork_eviction::complete_pending_evictions(service.library(), Some(1)).unwrap();
    assert_eq!((counts.removed, counts.deferred, counts.failed), (1, 0, 0));
}
