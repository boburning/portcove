use std::{fs, io::Cursor, path::Path};

use crate::{ArtworkAvailability, ArtworkSlot, Library, LibraryContentKind, PortcoveService};

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
    PortcoveService::new(Library::open(root).unwrap()).unwrap()
}

#[test]
fn choices_are_per_slot_and_reset_cache_and_retirement_are_separate() {
    let temp = tempfile::tempdir().unwrap();
    let service = open_service(&temp.path().join("library"));
    let png = image_file(temp.path(), "cover.png", image::ImageFormat::Png);
    let jpeg = image_file(temp.path(), "detail.jpg", image::ImageFormat::Jpeg);
    let original = fs::read(&png).unwrap();
    let cover = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Cover, &png, 0)
        .unwrap();
    let detail = service
        .import_artwork("zelda64-recomp", ArtworkSlot::Detail, &jpeg, 0)
        .unwrap();
    assert_eq!(cover.availability, ArtworkAvailability::Available);
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
    assert_eq!(
        reopened
            .artwork("zelda64-recomp", ArtworkSlot::Cover)
            .unwrap()
            .availability,
        ArtworkAvailability::Available
    );
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
    assert!(crate::library_import::validate_metadata(&metadata, service.catalog()).is_err());
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
    for name in ["a", "b"] {
        fs::File::create(cache.join(format!("{}.png", name.repeat(64))))
            .unwrap()
            .set_len(40 * 1024 * 1024)
            .unwrap();
    }
    assert_eq!(
        service
            .artwork_thumbnail("zelda64-recomp", ArtworkSlot::Cover, 1)
            .unwrap()
            .png,
        expected
    );
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
