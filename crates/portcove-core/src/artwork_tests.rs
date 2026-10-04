use std::{fs, io::Cursor, path::Path};

use crate::{
    ArtworkAvailability, ArtworkResolvedSource, ArtworkSlot, Library, LibraryContentKind,
    PortcoveService,
};

fn image_file(root: &Path, name: &str, format: image::ImageFormat) -> std::path::PathBuf {
    let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        12,
        24,
        image::Rgb([24, 80, 160]),
    ));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, format).unwrap();
    let path = root.join(name);
    fs::write(&path, bytes.into_inner()).unwrap();
    path
}

fn open_service(root: &Path) -> PortcoveService {
    let library = crate::test_fixture::phase("artwork fixture: open library", || {
        Library::open(root).unwrap()
    });
    let mut service = crate::test_fixture::phase("artwork fixture: open service", || {
        PortcoveService::new(library).unwrap()
    });
    // Local-choice/fallback fixtures explicitly need a port without a default.
    // Real catalog coverage can grow without changing this test precondition.
    let mut document = service.catalog().authoritative_document().clone();
    document
        .ports
        .iter_mut()
        .find(|port| port.id == "zelda64-recomp")
        .unwrap()
        .presentation
        .as_mut()
        .unwrap()
        .artwork = None;
    let catalog =
        crate::test_fixture::phase("artwork fixture: validate presentation catalog", || {
            crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
        });
    service.replace_catalog_for_test(catalog);
    service
}

#[test]
fn generated_fallback_is_core_owned_stable_and_independent_per_slot() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let service = open_service(&root);
    let cover = service
        .artwork("zelda64-recomp", ArtworkSlot::Cover)
        .unwrap();
    let detail = service
        .artwork("zelda64-recomp", ArtworkSlot::Detail)
        .unwrap();
    let crate::GeneratedArtworkFallback {
        identity,
        style_version,
        initials,
        palette_index,
    } = &cover.generated_fallback;
    assert_eq!(
        cover.resolved_source,
        ArtworkResolvedSource::GeneratedFallback
    );
    assert_eq!(identity.len(), 64);
    assert_eq!(*style_version, 1);
    assert_eq!(initials, "Z6");
    assert!(*palette_index < 6);
    assert_ne!(cover.generated_fallback, detail.generated_fallback);
    drop(service);
    assert_eq!(
        open_service(&root)
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .generated_fallback,
        cover.generated_fallback
    );
}

#[test]
fn verified_shipwright_mapping_is_the_cover_default_and_keeps_local_override_authority() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let cover = service.artwork("shipwright", ArtworkSlot::Cover).unwrap();
    let ArtworkResolvedSource::IgdbCover { artwork, cache_id } = &cover.resolved_source else {
        panic!("the reviewed catalog cover should resolve through IGDB");
    };
    assert_eq!((artwork.game_id, artwork.cover_id), (194694, 287780));
    assert_eq!(artwork.image_id, "co661w");
    assert_eq!(cache_id.len(), 64);
    assert_eq!(cover.availability, ArtworkAvailability::Available);
    assert_eq!(
        service
            .artwork("shipwright", ArtworkSlot::Detail)
            .unwrap()
            .resolved_source,
        ArtworkResolvedSource::GeneratedFallback
    );
    let png = image_file(temp.path(), "owned.png", image::ImageFormat::Png);
    let selected = service
        .import_artwork("shipwright", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    assert!(matches!(
        selected.resolved_source,
        ArtworkResolvedSource::LocalImport { .. }
    ));
    assert_eq!(
        service
            .reset_artwork("shipwright", ArtworkSlot::Cover, 1)
            .unwrap()
            .resolved_source,
        cover.resolved_source
    );
}

#[test]
fn artwork_only_catalog_correction_preserves_installed_port_contract() {
    let original = crate::Catalog::embedded()
        .unwrap()
        .port("shipwright")
        .unwrap()
        .clone();
    let mut corrected = original.clone();
    corrected
        .presentation
        .as_mut()
        .unwrap()
        .artwork
        .as_mut()
        .unwrap()
        .image_id = "co9999".into();
    crate::signed_catalog::validate_installed_port_contract(&corrected, &original).unwrap();
}

#[test]
#[ignore = "manual live CDN qualification; run explicitly when network access is available"]
fn live_igdb_shipwright_cover_fetches_and_reuses_bounded_thumbnail() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let first = service
        .artwork_thumbnail("shipwright", ArtworkSlot::Cover, 0)
        .unwrap();
    assert!(first.png.starts_with(b"\x89PNG\r\n\x1a\n"));
    let ArtworkResolvedSource::IgdbCover { artwork, .. } = service
        .artwork("shipwright", ArtworkSlot::Cover)
        .unwrap()
        .resolved_source
    else {
        panic!("expected the catalog mapping")
    };
    let cache = service
        .library()
        .root()
        .join("artwork-cache")
        .join(format!("{}.jpg", artwork.image_sha256));
    assert_eq!(
        crate::signed_catalog::digest(&fs::read(&cache).unwrap()),
        artwork.image_sha256
    );
    let other = image_file(temp.path(), "other.jpg", image::ImageFormat::Jpeg);
    fs::copy(&other, &cache).unwrap();
    assert_eq!(
        service
            .artwork_thumbnail("shipwright", ArtworkSlot::Cover, 0)
            .unwrap()
            .png,
        first.png
    );
    assert_eq!(
        crate::signed_catalog::digest(&fs::read(&cache).unwrap()),
        artwork.image_sha256
    );
    assert_eq!(service.clear_artwork_cache().unwrap().removed_files, 1);
}

#[test]
fn choices_are_per_slot_and_reset_cache_and_retirement_are_separate() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let jpeg = image_file(temp.path(), "detail.jpg", image::ImageFormat::Jpeg);
    let original = fs::read(&png).unwrap();
    let fallback = service
        .artwork("zelda64-recomp", ArtworkSlot::Cover)
        .unwrap()
        .generated_fallback;
    let cover = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    let detail = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Detail, &jpeg, 0)
        .unwrap();
    assert_eq!(cover.availability, ArtworkAvailability::Available);
    assert_eq!(
        cover.resolved_source,
        ArtworkResolvedSource::LocalImport {
            asset_sha256: cover.choice.asset_sha256.clone().unwrap()
        }
    );
    assert_ne!(cover.choice.asset_sha256, detail.choice.asset_sha256);
    let thumbnail = service
        .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
        .unwrap();
    assert_eq!(&thumbnail.png[..8], b"\x89PNG\r\n\x1a\n");
    service
        .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Detail, 1)
        .unwrap();
    let before = service.export_library_metadata().unwrap().artwork;
    assert_eq!(service.clear_artwork_cache().unwrap().removed_files, 2);
    assert_eq!(service.export_library_metadata().unwrap().artwork, before);
    assert_eq!(
        service
            .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
            .unwrap()
            .png,
        thumbnail.png
    );
    assert_eq!(fs::read(&png).unwrap(), original);
    let cover_id = cover.choice.asset_sha256.unwrap();
    assert!(service.remove_unused_local_artwork(&cover_id).is_err());
    let reset = service
        .reset_artwork("zelda64-recomp", ArtworkSlot::Cover, 1)
        .unwrap();
    assert_eq!(reset.choice.revision, 2);
    assert_eq!(reset.availability, ArtworkAvailability::Fallback);
    assert_eq!(
        reset.resolved_source,
        ArtworkResolvedSource::GeneratedFallback
    );
    assert_eq!(reset.generated_fallback, fallback);
    assert_eq!(
        service
            .artwork("zelda64-recomp", ArtworkSlot::Detail)
            .unwrap()
            .choice,
        detail.choice
    );
    assert_eq!(service.unused_local_artwork().unwrap().len(), 1);
    assert!(
        crate::artwork::original_path(service.library(), &cover_id)
            .unwrap()
            .is_file()
    );
    service.remove_unused_local_artwork(&cover_id).unwrap();
    assert!(service.unused_local_artwork().unwrap().is_empty());
    assert_eq!(fs::read(&png).unwrap(), original);
}

#[test]
fn imported_thumbnail_is_reused_without_a_second_decode_and_regenerates_after_clear() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let before = crate::artwork_image::decode_count();
    let selected = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    assert_eq!(crate::artwork_image::decode_count(), before + 1);
    let first = service
        .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
        .unwrap();
    assert_eq!(crate::artwork_image::decode_count(), before + 1);
    assert_eq!(first.asset_sha256, selected.choice.asset_sha256.unwrap());
    assert_eq!(first.choice_revision, selected.choice.revision);

    service.clear_artwork_cache().unwrap();
    let regenerated = service
        .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
        .unwrap();
    assert_eq!(regenerated.png, first.png);
    assert_eq!(crate::artwork_image::decode_count(), before + 2);
}

#[test]
fn failed_import_thumbnail_publication_preserves_committed_choice_and_regeneration() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let cache_root = service.library().root().join("artwork-cache");
    fs::write(&cache_root, b"cache obstruction").unwrap();
    let selected = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    assert_eq!(selected.availability, ArtworkAvailability::Available);
    assert_eq!(selected.choice.revision, 1);
    assert_eq!(
        service
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .choice,
        selected.choice
    );
    fs::remove_file(cache_root).unwrap();
    let thumbnail = service
        .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
        .unwrap();
    assert_eq!(
        thumbnail.asset_sha256,
        selected.choice.asset_sha256.unwrap()
    );
    assert!(!thumbnail.png.is_empty());
}

#[test]
fn malformed_oversized_animated_and_stale_replacements_preserve_the_choice() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let original = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    let invalid = temp.path().join("active.svg");
    fs::write(&invalid, b"<svg onload='alert(1)' />").unwrap();
    let oversized = temp.path().join("huge.png");
    fs::File::create(&oversized)
        .unwrap()
        .set_len(crate::artwork_image::MAX_ORIGINAL_BYTES + 1)
        .unwrap();
    let mut animated = fs::read(&png).unwrap();
    let mut chunk = Vec::from(&b"acTL"[..]);
    chunk.extend(1_u32.to_be_bytes());
    chunk.extend(0_u32.to_be_bytes());
    let crc = crc32fast::hash(&chunk);
    let mut encoded = Vec::from(8_u32.to_be_bytes());
    encoded.extend(chunk);
    encoded.extend(crc.to_be_bytes());
    animated.splice(33..33, encoded);
    let animation = temp.path().join("animated.png");
    fs::write(&animation, animated).unwrap();
    for path in [&invalid, &oversized, &animation] {
        assert!(
            service
                .import_artwork("zelda64-recomp", ArtworkSlot::Cover, path, 1)
                .is_err()
        );
    }
    assert!(
        service
            .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
            .is_err()
    );
    assert!(
        service
            .reset_artwork("zelda64-recomp", ArtworkSlot::Cover, 0)
            .is_err()
    );
    assert!(
        service
            .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 0)
            .is_err()
    );
    assert_eq!(
        service
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .choice,
        original.choice
    );
    assert_eq!(
        service
            .export_library_metadata()
            .unwrap()
            .artwork
            .unwrap()
            .assets
            .len(),
        1
    );
}

#[test]
fn unavailable_originals_retain_preference_and_do_not_block_other_library_reads() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let service = open_service(&root);
    let selected = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    let original = crate::artwork::original_path(
        service.library(),
        selected.choice.asset_sha256.as_deref().unwrap(),
    )
    .unwrap();
    let bytes = fs::read(&original).unwrap();
    fs::write(&original, b"changed local data").unwrap();
    let unavailable = service
        .artwork("zelda64-recomp", ArtworkSlot::Cover)
        .unwrap();
    assert_eq!(unavailable.availability, ArtworkAvailability::Unavailable);
    assert_eq!(unavailable.choice, selected.choice);
    assert!(matches!(
        unavailable.resolved_source,
        ArtworkResolvedSource::GeneratedFallback
    ));
    assert!(
        service
            .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
            .is_err()
    );
    assert!(!service.statuses().unwrap().is_empty());
    fs::remove_file(&original).unwrap();
    drop(service);
    let reopened = open_service(&root);
    assert_eq!(
        reopened
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .choice,
        selected.choice
    );
    assert!(!reopened.statuses().unwrap().is_empty());
    fs::write(original, bytes).unwrap();
    let restored = reopened
        .artwork("zelda64-recomp", ArtworkSlot::Cover)
        .unwrap();
    assert_eq!(restored.availability, ArtworkAvailability::Available);
    assert!(matches!(
        restored.resolved_source,
        ArtworkResolvedSource::LocalImport { .. }
    ));
}

#[test]
fn an_artwork_writer_does_not_take_the_game_operation_lock() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let art = service.library().try_lock_artwork().unwrap();
    let game = service
        .library()
        .try_lock_port("zelda64-recomp", "owned-test")
        .unwrap();
    assert!(
        service
            .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
            .is_err()
    );
    drop(art);
    service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    drop(game);
}

#[test]
fn version_three_import_preserves_choices_originals_and_rebuilds_disposable_thumbnails() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let service = open_service(&root);
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let selected = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    let export = temp.path().join("export.json");
    service.write_library_metadata(&export).unwrap();
    let destination = temp.path().join("imported");
    let plan = PortcoveService::plan_library_import(&export, &root, &destination).unwrap();
    assert_eq!(plan.metadata.schema_version, 3);
    assert!(
        plan.content
            .iter()
            .any(|tree| tree.kind == LibraryContentKind::LocalArtwork)
    );
    assert!(
        !plan
            .content
            .iter()
            .any(|tree| tree.relative_path.contains("cache"))
    );
    PortcoveService::import_library(&export, &root, &destination, &plan.plan_sha256).unwrap();
    let imported = open_service(&destination);
    assert_eq!(
        imported
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .choice,
        selected.choice
    );
    assert!(
        !imported
            .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
            .unwrap()
            .png
            .is_empty()
    );
    assert!(png.is_file());
}

#[test]
fn legacy_metadata_cannot_smuggle_new_artwork_and_new_payloads_are_decoded_before_publication() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let service = open_service(&root);
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    let mut metadata = service.export_library_metadata().unwrap();
    metadata.schema_version = 2;
    metadata
        .content_roots
        .retain(|root| root.kind != LibraryContentKind::LocalArtwork);
    assert!(
        crate::library_import::validate_metadata(
            &metadata,
            &crate::library_import::PortabilityCatalogs::from_catalog(service.catalog().clone())
        )
        .is_err()
    );
    metadata.schema_version = 3;
    metadata.content_roots.push(crate::LibraryContentRoot {
        kind: LibraryContentKind::LocalArtwork,
        relative_path: "artwork".into(),
    });
    metadata.artwork.as_mut().unwrap().assets[0].width = 10;
    let export = temp.path().join("forged.json");
    fs::write(&export, serde_json::to_vec(&metadata).unwrap()).unwrap();
    let destination = temp.path().join("destination");
    let plan = PortcoveService::plan_library_import(&export, &root, &destination).unwrap();
    assert!(
        PortcoveService::import_library(&export, &root, &destination, &plan.plan_sha256).is_err()
    );
    assert!(Library::open(&destination).is_err());
}

#[test]
fn interrupted_publication_is_tracked_without_replacing_the_previous_choice() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let path = service.library().root().join("artwork");
    fs::write(&path, b"unexpected retained entry").unwrap();
    assert!(
        service
            .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
            .is_err()
    );
    assert_eq!(
        service
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .choice
            .revision,
        0
    );
    let unused = service.unused_local_artwork().unwrap();
    assert_eq!(unused.len(), 1);
    assert_eq!(fs::read(&path).unwrap(), b"unexpected retained entry");
    fs::remove_file(&path).unwrap();
    service
        .remove_unused_local_artwork(&unused[0].sha256)
        .unwrap();
    assert!(service.unused_local_artwork().unwrap().is_empty());
    // Cache faults do not prevent selecting a validated original.
    fs::write(
        service.library().root().join("artwork-cache"),
        b"retained cache obstruction",
    )
    .unwrap();
    let choice = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    assert_eq!(choice.availability, ArtworkAvailability::Available);
    assert!(
        service
            .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
            .is_err()
    );
    assert!(!service.statuses().unwrap().is_empty());
}

#[test]
fn corrupted_thumbnails_are_rebuilt_and_cache_capacity_is_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let selected = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    let expected = service
        .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
        .unwrap()
        .png;
    let cache = service.library().root().join("artwork-cache");
    let selected_cache = cache.join(format!("{}.png", selected.choice.asset_sha256.unwrap()));
    fs::write(&selected_cache, b"corrupt cached data").unwrap();
    // Exceed the total cache capacity with individually permitted entries.
    // Oversized files are unexpected inventory, not ordinary eviction input.
    for index in 0..65 {
        fs::File::create(cache.join(format!("{index:064x}.png")))
            .unwrap()
            .set_len(crate::artwork_image::MAX_THUMBNAIL_BYTES)
            .unwrap();
    }
    assert_eq!(
        service
            .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
            .unwrap()
            .png,
        expected
    );
    assert!(!cache.join(format!("{:064x}.png", 0)).exists());
    assert!(!cache.join(format!("{:064x}.png", 1)).exists());
    assert!(cache.join(format!("{:064x}.png", 64)).exists());
    let cleared = service.clear_artwork_cache().unwrap();
    assert!(cleared.removed_bytes <= 64 * 1024 * 1024);
    assert_eq!(
        service
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .availability,
        ArtworkAvailability::Available
    );
}

#[test]
fn decoded_dimensions_are_bounded_before_pixel_allocation() {
    let temp = tempfile::tempdir().unwrap();
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    for (width, height) in [(8193_u32, 1_u32), (4096, 4096)] {
        let mut bytes = fs::read(&png).unwrap();
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        let checksum = crc32fast::hash(&bytes[12..29]);
        bytes[29..33].copy_from_slice(&checksum.to_be_bytes());
        assert!(crate::artwork_image::decode(&bytes).is_err());
    }
}

#[test]
fn legacy_metadata_imports_execute_without_manufacturing_artwork() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    let service = open_service(&root);
    for version in [1, 2] {
        let mut metadata = service.export_library_metadata().unwrap();
        metadata.schema_version = version;
        metadata.artwork = None;
        metadata.content_roots.retain(|root| {
            root.kind != LibraryContentKind::LocalArtwork
                && (version != 1 || root.kind != LibraryContentKind::SourceInbox)
        });
        let export = temp.path().join(format!("version-{version}.json"));
        fs::write(&export, serde_json::to_vec(&metadata).unwrap()).unwrap();
        let destination = temp.path().join(format!("destination-{version}"));
        let plan = PortcoveService::plan_library_import(&export, &root, &destination).unwrap();
        PortcoveService::import_library(&export, &root, &destination, &plan.plan_sha256).unwrap();
        assert_eq!(
            open_service(&destination)
                .artwork("zelda64-recomp", ArtworkSlot::Cover)
                .unwrap()
                .availability,
            ArtworkAvailability::Fallback
        );
    }
}

#[test]
fn managed_move_preserves_artwork_and_excludes_cached_payloads() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    let destination = temp.path().join("destination");
    let service = open_service(&root);
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let choice = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap()
        .choice;
    service
        .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
        .unwrap();
    let plan = service.plan_library_move(&destination).unwrap();
    drop(service);
    PortcoveService::move_library(&root, &destination, &plan.plan_sha256).unwrap();
    assert!(!destination.join("artwork-cache").exists());
    let moved = open_service(&destination);
    assert_eq!(
        moved
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .choice,
        choice
    );
    assert!(
        !moved
            .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
            .unwrap()
            .png
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn artwork_symlinks_cannot_redirect_import_cache_or_original_removal() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let bytes = fs::read(&png).unwrap();
    let link = temp.path().join("redirect.png");
    symlink(&png, &link).unwrap();
    assert!(
        service
            .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &link, 0)
            .is_err()
    );
    let choice = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap()
        .choice;
    let id = choice.asset_sha256.unwrap();
    service
        .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
        .unwrap();
    let cache = service
        .library()
        .root()
        .join("artwork-cache")
        .join(format!("{id}.png"));
    fs::remove_file(&cache).unwrap();
    symlink(&png, &cache).unwrap();
    assert!(service.clear_artwork_cache().is_err());
    assert!(
        service
            .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
            .is_err()
    );
    let original = crate::artwork::original_path(service.library(), &id).unwrap();
    fs::remove_file(&original).unwrap();
    symlink(&png, &original).unwrap();
    service
        .reset_artwork("zelda64-recomp", ArtworkSlot::Cover, 1)
        .unwrap();
    assert!(service.remove_unused_local_artwork(&id).is_err());
    assert_eq!(fs::read(&png).unwrap(), bytes);
}

#[test]
fn local_inventory_capacity_includes_unfinished_imports() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let connection = service.library().connection().unwrap();
    for index in 0..64 {
        let asset = crate::LocalArtworkAsset {
            sha256: format!("{index:064x}"),
            original_name: "reserved.png".into(),
            format: crate::ArtworkImageFormat::Png,
            byte_size: crate::artwork_image::MAX_ORIGINAL_BYTES,
            width: 1,
            height: 1,
            imported_at: 1,
        };
        crate::artwork_store::write_asset(&connection, &asset).unwrap();
    }
    let failed = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap_err();
    assert_eq!(failed.code, crate::ErrorCode::Conflict);
    assert_eq!(service.unused_local_artwork().unwrap().len(), 64);
    service
        .remove_unused_local_artwork(&format!("{:064x}", 0))
        .unwrap();
    service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
}

#[test]
fn transfer_review_rejects_untracked_artwork_payloads_before_copying() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    let service = open_service(&root);
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    let unexpected = root.join("artwork/untracked.txt");
    fs::write(&unexpected, b"retain this unexpected file").unwrap();
    let export = temp.path().join("metadata.json");
    service.write_library_metadata(&export).unwrap();
    let destination = temp.path().join("destination");
    assert!(service.plan_library_move(&destination).is_err());
    assert!(PortcoveService::plan_library_import(&export, &root, &destination).is_err());
    assert!(!destination.exists());
    assert_eq!(
        fs::read(unexpected).unwrap(),
        b"retain this unexpected file"
    );
}

#[test]
fn interrupted_original_staging_retries_once_or_is_explicitly_retired() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let bytes = fs::read(&png).unwrap();
    let id = crate::signed_catalog::digest(&bytes);
    // Reserve the inventory using the real failure path, before any payload copy.
    let originals = service.library().root().join("artwork");
    fs::write(&originals, b"obstruction").unwrap();
    assert!(
        service
            .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
            .is_err()
    );
    fs::remove_file(&originals).unwrap();
    let staged = crate::artwork_ingestion::staging_path(service.library(), &id).unwrap();
    fs::create_dir_all(staged.parent().unwrap()).unwrap();
    fs::write(&staged, &bytes[..bytes.len() / 2]).unwrap();
    service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    assert!(!staged.exists());
    assert_eq!(fs::read(originals.join(&id)).unwrap(), bytes);
    assert_eq!(fs::read_dir(staged.parent().unwrap()).unwrap().count(), 0);
    service
        .reset_artwork("zelda64-recomp", ArtworkSlot::Cover, 1)
        .unwrap();
    fs::remove_file(originals.join(&id)).unwrap();
    fs::write(&staged, b"changed incomplete copy").unwrap();
    assert!(
        service
            .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 2)
            .is_err()
    );
    assert_eq!(fs::read(&staged).unwrap(), b"changed incomplete copy");
    service.remove_unused_local_artwork(&id).unwrap();
    assert!(!staged.exists());
    assert!(service.unused_local_artwork().unwrap().is_empty());
    assert_eq!(fs::read(png).unwrap(), bytes);
}

#[test]
fn interrupted_thumbnail_staging_can_be_cleared_or_rebuilt_without_losing_choice() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let selected = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap()
        .choice;
    let pending = service
        .library()
        .root()
        .join("artwork-cache/pending-thumbnail");
    fs::create_dir_all(pending.parent().unwrap()).unwrap();
    fs::write(&pending, b"incomplete thumbnail").unwrap();
    // Import already populated its disposable cache; clear removes it and the
    // interrupted pending file together.
    assert_eq!(service.clear_artwork_cache().unwrap().removed_files, 2);
    fs::write(&pending, b"another incomplete thumbnail").unwrap();
    assert!(
        !service
            .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
            .unwrap()
            .png
            .is_empty()
    );
    assert!(!pending.exists());
    assert_eq!(
        service
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .choice,
        selected
    );
}

#[test]
fn oversized_published_thumbnail_is_retained_as_an_unexpected_cache_entry() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let selected = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap()
        .choice;
    let cache = service
        .library()
        .root()
        .join("artwork-cache")
        .join(format!("{}.png", selected.asset_sha256.as_ref().unwrap()));
    let oversized = vec![0_u8; crate::artwork_image::MAX_THUMBNAIL_BYTES as usize + 1];
    fs::write(&cache, &oversized).unwrap();
    let error = service.clear_artwork_cache().unwrap_err();
    assert!(error.message.contains("unexpected entry"), "{error}");
    assert_eq!(fs::read(&cache).unwrap(), oversized);
    fs::write(&cache, &oversized[..oversized.len() - 1]).unwrap();
    let cleared = service.clear_artwork_cache().unwrap();
    assert_eq!(cleared.removed_files, 1);
    assert_eq!(
        cleared.removed_bytes,
        crate::artwork_image::MAX_THUMBNAIL_BYTES
    );
    assert!(!cache.exists());
    assert_eq!(
        service
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .choice,
        selected
    );
}

#[test]
fn transient_cover_failure_backs_off_without_erasing_the_choice() {
    use std::{cell::Cell, time::Instant};
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let before = service.artwork("shipwright", ArtworkSlot::Cover).unwrap();
    let ArtworkResolvedSource::IgdbCover { artwork, .. } = &before.resolved_source else {
        panic!("mapped cover");
    };
    let requests = Cell::new(0);
    let now = Instant::now();
    for _ in 0..3 {
        let error = crate::artwork::igdb_thumbnail_with_fetch(
            service.library(),
            artwork,
            0,
            |_| panic!("failure cannot publish"),
            || {
                requests.set(requests.get() + 1);
                Err(crate::artwork::IgdbFetchFailure {
                    error: crate::PortcoveError::network("temporary cover outage"),
                    retryable: true,
                })
            },
            || now,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert_eq!(error.message, "temporary cover outage");
    }
    assert_eq!(
        serde_json::to_value(service.artwork("shipwright", ArtworkSlot::Cover).unwrap()).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    assert_eq!(
        requests.get(),
        1,
        "one request within the transient backoff window"
    );
}

// Backoff protocol fixtures need a mapped cover, not reviewed real-title data.
// The default-cover and installed-contract cases above keep the embedded catalog.
fn backoff_catalog() -> crate::Catalog {
    crate::Catalog::from_json(
        &serde_json::json!({
            "schema_version": 2,
            "source_catalog": {
                "identities": [], "contracts": [], "validators": [],
                "evidence": [], "qualification": []
            },
            "ports": [{
                "id": "artwork-backoff-fixture",
                "name": "Artwork backoff fixture",
                "summary": "Synthetic cover request protocol fixture",
                "project_url": "https://example.invalid/artwork-backoff",
                "support_tier": "beta",
                "channels": ["stable"],
                "platforms": ["linux-x86-64"],
                "adapter": "libultraship-portable",
                "release": {"repository": "fixture/artwork-backoff"},
                "executable_hints": {"linux-x86-64": ["fixture"]},
                "presentation": {
                    "installation_method": "portable-package",
                    "source_requirements": [],
                    "saves_and_settings": "portcove-managed",
                    "artwork": {
                        "game_id": 17, "cover_id": 31,
                        "image_id": "fixturecover", "image_sha256": "a".repeat(64),
                        "game_slug": "artwork-backoff-fixture", "match_kind": "port"
                    }
                }
            }]
        })
        .to_string(),
    )
    .unwrap()
}

#[test]
fn backoff_catalog_is_self_contained_and_uses_real_mapping_validation() {
    let catalog = backoff_catalog();
    let port = catalog.port("artwork-backoff-fixture").unwrap();
    assert_eq!(catalog.ports().len(), 1);
    assert!(port.source_profile.is_none());
    let source = catalog.source_catalog().unwrap();
    assert!(source.identities.is_empty());
    assert!(source.contracts.is_empty());
    assert!(source.validators.is_empty());
    assert!(source.evidence.is_empty());
    assert!(source.qualification.is_empty());
    let artwork = port
        .presentation
        .as_ref()
        .unwrap()
        .artwork
        .as_ref()
        .unwrap();
    assert_eq!((artwork.game_id, artwork.cover_id), (17, 31));
    assert_eq!(artwork.image_id, "fixturecover");
    let original = serde_json::to_value(catalog.authoritative_document()).unwrap();
    let mut unknown = original.clone();
    unknown["ports"][0]["presentation"]["artwork"]["untrusted_provider"] = true.into();
    assert!(crate::Catalog::from_json(&unknown.to_string()).is_err());
    let mut invalid = original;
    invalid["ports"][0]["presentation"]["artwork"]["image_id"] = "../outside".into();
    assert!(crate::Catalog::from_json(&invalid.to_string()).is_err());
}

fn backoff_fixture(root: &Path) -> (PortcoveService, crate::IgdbArtwork, Vec<u8>) {
    let mut service = PortcoveService::new(Library::open(root.join("library")).unwrap()).unwrap();
    service.replace_catalog_for_test(backoff_catalog());
    let cover = service
        .artwork("artwork-backoff-fixture", ArtworkSlot::Cover)
        .unwrap();
    let ArtworkResolvedSource::IgdbCover { mut artwork, .. } = cover.resolved_source else {
        panic!("mapped cover");
    };
    let bytes = fs::read(image_file(root, "cover.jpg", image::ImageFormat::Jpeg)).unwrap();
    artwork.image_sha256 = crate::signed_catalog::digest(&bytes);
    (service, artwork, bytes)
}

fn transient_cover_error() -> crate::artwork::IgdbFetchFailure {
    crate::artwork::IgdbFetchFailure {
        error: crate::PortcoveError::network("temporary cover outage"),
        retryable: true,
    }
}

fn cover_with_fetch(
    service: &PortcoveService,
    artwork: &crate::IgdbArtwork,
    now: std::time::Instant,
    fetch: impl FnOnce() -> std::result::Result<Vec<u8>, crate::artwork::IgdbFetchFailure>,
) -> crate::Result<crate::ArtworkThumbnail> {
    crate::artwork::igdb_thumbnail_with_fetch(
        service.library(),
        artwork,
        0,
        |bytes| {
            let cache = service.library().root().join("artwork-cache");
            fs::create_dir_all(&cache)?;
            fs::write(cache.join(format!("{}.jpg", artwork.image_sha256)), bytes)?;
            Ok(())
        },
        fetch,
        || now,
    )
}

#[test]
fn cover_backoff_expires_from_completion_and_success_recovers() {
    use std::{
        cell::Cell,
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let (service, artwork, bytes) = backoff_fixture(temp.path());
    let start = Instant::now();
    let clock = Cell::new(start);
    let requests = Cell::new(0);
    crate::artwork::igdb_thumbnail_with_fetch(
        service.library(),
        &artwork,
        0,
        |_| panic!("no publication"),
        || {
            requests.set(1);
            clock.set(start + Duration::from_secs(15));
            Err(transient_cover_error())
        },
        || clock.get(),
    )
    .unwrap_err();
    cover_with_fetch(&service, &artwork, start + Duration::from_secs(44), || {
        requests.set(2);
        Ok(bytes.clone())
    })
    .unwrap_err();
    assert_eq!(requests.get(), 1);
    let thumbnail = cover_with_fetch(&service, &artwork, start + Duration::from_secs(45), || {
        requests.set(2);
        Ok(bytes)
    })
    .unwrap();
    assert_eq!(requests.get(), 2);
    assert!(!thumbnail.png.is_empty());
    assert_eq!(thumbnail.choice_revision, 0);
    let cached = cover_with_fetch(&service, &artwork, start + Duration::from_secs(46), || {
        panic!("cached success needs no request")
    })
    .unwrap();
    assert_eq!(cached.png, thumbnail.png);
}

#[test]
fn validated_cover_cache_precedes_backoff_and_clear_permits_retry() {
    use std::time::Instant;
    let temp = tempfile::tempdir().unwrap();
    let (service, artwork, bytes) = backoff_fixture(temp.path());
    let now = Instant::now();
    cover_with_fetch(&service, &artwork, now, || Err(transient_cover_error())).unwrap_err();
    let cache = service.library().root().join("artwork-cache");
    fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join(format!("{}.jpg", artwork.image_sha256)), &bytes).unwrap();
    assert!(
        !cover_with_fetch(&service, &artwork, now, || panic!(
            "valid bytes precede retained outage"
        ))
        .unwrap()
        .png
        .is_empty()
    );
    assert_eq!(service.clear_artwork_cache().unwrap().removed_files, 1);
    assert!(cover_with_fetch(&service, &artwork, now, || Ok(bytes)).is_ok());
}

#[test]
fn cover_backoff_isolated_by_library_image_and_content_identity() {
    use std::{cell::Cell, time::Instant};
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let (service, artwork, _) = backoff_fixture(first.path());
    let (other, _, _) = backoff_fixture(second.path());
    let now = Instant::now();
    let requests = Cell::new(0);
    let failure = || {
        requests.set(requests.get() + 1);
        Err(transient_cover_error())
    };
    cover_with_fetch(&service, &artwork, now, failure).unwrap_err();
    cover_with_fetch(&service, &artwork, now, failure).unwrap_err();
    assert_eq!(requests.get(), 1);
    cover_with_fetch(&other, &artwork, now, failure).unwrap_err();
    let mut different_image = artwork.clone();
    different_image.image_id.push('a');
    cover_with_fetch(&service, &different_image, now, failure).unwrap_err();
    let mut different_content = artwork.clone();
    different_content.image_sha256 = "0".repeat(64);
    cover_with_fetch(&service, &different_content, now, failure).unwrap_err();
    assert_eq!(requests.get(), 4);
    service.clear_artwork_cache().unwrap();
    cover_with_fetch(&service, &artwork, now, failure).unwrap_err();
    cover_with_fetch(&other, &artwork, now, failure).unwrap_err();
    assert_eq!(
        requests.get(),
        5,
        "clearing one library preserves another's backoff"
    );
}

#[test]
fn permanent_integrity_publication_and_detailed_failures_are_not_cached() {
    use std::{cell::Cell, time::Instant};
    let temp = tempfile::tempdir().unwrap();
    let (service, artwork, bytes) = backoff_fixture(temp.path());
    let now = Instant::now();
    let requests = Cell::new(0);
    for (code, retryable, detailed) in [
        (crate::ErrorCode::Network, false, false),
        (crate::ErrorCode::Verification, true, false),
        (crate::ErrorCode::State, false, false),
        (crate::ErrorCode::Network, true, true),
    ] {
        for _ in 0..2 {
            let error = cover_with_fetch(&service, &artwork, now, || {
                requests.set(requests.get() + 1);
                let mut error = crate::PortcoveError::new(code, "uncached failure");
                if detailed {
                    error = error.detail("context", "preserved");
                }
                Err(crate::artwork::IgdbFetchFailure { error, retryable })
            })
            .unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(error.details.contains_key("context"), detailed);
        }
    }
    assert_eq!(requests.get(), 8);
    for _ in 0..2 {
        let error = cover_with_fetch(&service, &artwork, now, || {
            requests.set(requests.get() + 1);
            Ok(b"not the accepted JPEG".to_vec())
        })
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
    }
    for _ in 0..2 {
        let error = crate::artwork::igdb_thumbnail_with_fetch(
            service.library(),
            &artwork,
            0,
            |_| Err(crate::PortcoveError::conflict("stale choice")),
            || {
                requests.set(requests.get() + 1);
                Ok(bytes.clone())
            },
            || now,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
    }
    assert_eq!(requests.get(), 12);
    assert!(cover_with_fetch(&service, &artwork, now, || Ok(bytes)).is_ok());
}

#[test]
fn concurrent_cover_failures_share_one_request_without_holding_registry() {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        time::Instant,
    };
    let temp = tempfile::tempdir().unwrap();
    let (service, artwork, _) = backoff_fixture(temp.path());
    let now = Instant::now();
    let requests = AtomicUsize::new(0);
    let (started, waiting) = mpsc::channel();
    let (release, released) = mpsc::channel();
    std::thread::scope(|scope| {
        let service = &service;
        let artwork = &artwork;
        let requests = &requests;
        let first = scope.spawn(move || {
            cover_with_fetch(service, artwork, now, || {
                requests.fetch_add(1, Ordering::SeqCst);
                started.send(()).unwrap();
                released.recv().unwrap();
                Err(transient_cover_error())
            })
        });
        waiting.recv().unwrap();
        let second = scope.spawn(|| {
            cover_with_fetch(service, artwork, now, || {
                requests.fetch_add(1, Ordering::SeqCst);
                Err(transient_cover_error())
            })
        });
        release.send(()).unwrap();
        assert_eq!(
            first.join().unwrap().unwrap_err().code,
            crate::ErrorCode::Network
        );
        assert_eq!(
            second.join().unwrap().unwrap_err().code,
            crate::ErrorCode::Network
        );
    });
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

#[test]
fn clearing_cover_backoff_detaches_in_flight_failure() {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        time::Instant,
    };
    let temp = tempfile::tempdir().unwrap();
    let (service, artwork, _) = backoff_fixture(temp.path());
    let now = Instant::now();
    let requests = AtomicUsize::new(0);
    let (started, waiting) = mpsc::channel();
    let (release, released) = mpsc::channel();
    std::thread::scope(|scope| {
        let service = &service;
        let artwork = &artwork;
        let requests = &requests;
        let first = scope.spawn(move || {
            cover_with_fetch(service, artwork, now, || {
                requests.fetch_add(1, Ordering::SeqCst);
                started.send(()).unwrap();
                released.recv().unwrap();
                Err(transient_cover_error())
            })
        });
        waiting.recv().unwrap();
        service.clear_artwork_cache().unwrap();
        cover_with_fetch(service, artwork, now, || {
            requests.fetch_add(1, Ordering::SeqCst);
            Err(crate::artwork::IgdbFetchFailure {
                error: crate::PortcoveError::network("new outage"),
                retryable: true,
            })
        })
        .unwrap_err();
        release.send(()).unwrap();
        first.join().unwrap().unwrap_err();
    });
    let error = cover_with_fetch(&service, &artwork, now, || {
        panic!("old in-flight completion cannot replace new state")
    })
    .unwrap_err();
    assert_eq!(error.message, "new outage");
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[test]
fn cover_request_registry_is_bounded_and_never_evicts_active_requests() {
    let mut registry = crate::artwork::IgdbRequests::default();
    let key = |index| {
        (
            std::path::PathBuf::from("isolated fixture"),
            "durable fixture identity".to_owned(),
            format!("image{index}"),
            "0".repeat(64),
        )
    };
    let mut active = (0..256)
        .map(|index| registry.request(key(index)).unwrap())
        .collect::<Vec<_>>();
    assert!(std::sync::Arc::ptr_eq(
        &active[0],
        &registry.request(key(0)).unwrap()
    ));
    assert_eq!(
        registry.request(key(256)).unwrap_err().code,
        crate::ErrorCode::Conflict
    );
    active.pop();
    assert!(registry.request(key(256)).is_ok());
    assert!(std::sync::Arc::ptr_eq(
        &active[0],
        &registry.request(key(0)).unwrap()
    ));
}

#[test]
fn only_transient_http_cover_statuses_receive_backoff() {
    for code in [408, 429, 500, 502, 503, 504, 599] {
        assert!(crate::artwork::igdb_status_retryable(
            reqwest::StatusCode::from_u16(code).unwrap()
        ));
    }
    for code in [200, 301, 400, 401, 403, 404, 410, 422] {
        assert!(!crate::artwork::igdb_status_retryable(
            reqwest::StatusCode::from_u16(code).unwrap()
        ));
    }
}

#[test]
fn new_library_at_same_path_does_not_inherit_cover_backoff() {
    let temp = tempfile::tempdir().unwrap();
    let (service, artwork, _) = backoff_fixture(temp.path());
    let old_identity = service.library().identity_record().unwrap();
    let now = std::time::Instant::now();
    cover_with_fetch(&service, &artwork, now, || Err(transient_cover_error())).unwrap_err();
    drop(service);
    fs::remove_dir_all(&old_identity.root).unwrap();
    let (replacement, same_artwork, bytes) = backoff_fixture(temp.path());
    let new_identity = replacement.library().identity_record().unwrap();
    assert_eq!(old_identity.root, new_identity.root);
    assert_ne!(old_identity.id, new_identity.id);
    assert_eq!(artwork.image_sha256, same_artwork.image_sha256);
    assert!(
        cover_with_fetch(&replacement, &same_artwork, now, || Ok(bytes)).is_ok(),
        "new durable identity must make its own first request"
    );
}

#[test]
fn cover_backoff_and_clear_share_canonical_library_alias_identity() {
    use std::{cell::Cell, time::Instant};
    let temp = tempfile::tempdir().unwrap();
    let (service, artwork, _) = backoff_fixture(temp.path());
    fs::create_dir(temp.path().join("alias")).unwrap();
    let alias =
        PortcoveService::new(Library::open(temp.path().join("alias/../library")).unwrap()).unwrap();
    assert_eq!(
        service.library().identity_record().unwrap(),
        alias.library().identity_record().unwrap()
    );
    let requests = Cell::new(0);
    let now = Instant::now();
    let failure = || {
        requests.set(requests.get() + 1);
        Err(transient_cover_error())
    };
    cover_with_fetch(&service, &artwork, now, failure).unwrap_err();
    cover_with_fetch(&alias, &artwork, now, failure).unwrap_err();
    assert_eq!(requests.get(), 1);
    alias.clear_artwork_cache().unwrap();
    cover_with_fetch(&service, &artwork, now, failure).unwrap_err();
    assert_eq!(requests.get(), 2);
}
