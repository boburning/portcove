use super::*;

use std::{fs, io::Write};

use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::{Catalog, DigestIdentity, DigestScope, Library, SourceRepresentationKind};

fn hashes(bytes: &[u8], scope: DigestScope) -> DigestIdentity {
    DigestIdentity {
        scope,
        sha1: Some(hex::encode(Sha1::digest(bytes))),
        sha256: Some(hex::encode(Sha256::digest(bytes))),
        crc32: None,
    }
}

fn catalog_with(
    profile_id: &str,
    mutate: impl FnOnce(&mut crate::SourceRepresentation),
) -> Catalog {
    let mut document = Catalog::embedded().unwrap().authoritative_document();
    let profile = document
        .source_catalog
        .as_mut()
        .unwrap()
        .identities
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .unwrap();
    let representation = profile
        .variants
        .iter_mut()
        .find(|variant| !variant.legacy_projection_only)
        .unwrap()
        .representations
        .first_mut()
        .unwrap();
    mutate(representation);
    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

fn service(catalog: Catalog) -> (tempfile::TempDir, PortcoveService) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let mut service = PortcoveService::new(library).unwrap();
    service.replace_catalog_for_test(catalog);
    (temporary, service)
}

fn exact_bios_catalog(bytes: &[u8]) -> Catalog {
    catalog_with("psx-scph-1001-bios", |representation| {
        representation.extensions = vec!["bin".into()];
        representation.kind = SourceRepresentationKind::RawFile {
            identities: vec![hashes(bytes, DigestScope::OriginalFile)],
        };
    })
}

fn profile_dir(service: &PortcoveService, profile_id: &str) -> PathBuf {
    let path = service
        .source_inbox_paths(Some(profile_id))
        .unwrap()
        .profile
        .unwrap();
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn layout_and_profile_paths_use_one_portable_namespace() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    assert!(library.source_inbox_dir().is_dir());
    assert_eq!(
        library
            .source_inbox_profile_dir("psx-scph-1001-bios")
            .unwrap(),
        library.source_inbox_dir().join("psx-scph-1001-bios")
    );
    for invalid in [
        "",
        ".",
        "..",
        "../escape",
        "two/parts",
        "two\\parts",
        "CON",
        "aux.txt",
        "Upper",
        "trail.",
        "space ",
        "a--b",
        "-start",
        "end-",
        "a:b",
        "com1",
    ] {
        assert!(
            library.source_inbox_profile_dir(invalid).is_err(),
            "{invalid}"
        );
    }

    fs::create_dir(library.source_inbox_dir().join("PSX-SCPH-1001-BIOS")).unwrap();
    let alias = library
        .source_inbox_profile_dir("psx-scph-1001-bios")
        .unwrap_err();
    assert_eq!(alias.code, crate::ErrorCode::Conflict);
}

#[cfg(unix)]
#[test]
fn profile_paths_refuse_symlink_ancestors() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let outside = temporary.path().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(
        &outside,
        library.source_inbox_dir().join("psx-scph-1001-bios"),
    )
    .unwrap();
    assert!(
        library
            .source_inbox_profile_dir("psx-scph-1001-bios")
            .is_err()
    );
}

#[test]
fn zero_one_multiple_and_registered_precedence_are_deterministic() {
    let bytes = b"synthetic exact BIOS";
    let (_temporary, service) = service(exact_bios_catalog(bytes));
    let limits = SourceDiscoveryLimits::default();
    let missing = service
        .scan_source_inbox("psx-scph-1001-bios", &limits)
        .unwrap();
    assert_eq!(missing.state, SourceInboxResolutionState::Unresolved);

    let inbox = profile_dir(&service, "psx-scph-1001-bios");
    fs::write(inbox.join("mismatch.bin"), b"wrong").unwrap();
    let mismatch = service
        .scan_source_inbox("psx-scph-1001-bios", &limits)
        .unwrap();
    assert_eq!(mismatch.state, SourceInboxResolutionState::Unresolved);
    assert_eq!(mismatch.candidates.len(), 1);
    fs::remove_file(inbox.join("mismatch.bin")).unwrap();

    let first = inbox.join("first.bin");
    fs::write(&first, bytes).unwrap();
    let exact = service
        .scan_source_inbox("psx-scph-1001-bios", &limits)
        .unwrap();
    assert_eq!(exact.state, SourceInboxResolutionState::ExactMatch);
    assert_eq!(
        exact.selected.as_ref().unwrap().path,
        fs::canonicalize(&first).unwrap()
    );
    assert!(service.library().sources().unwrap().is_empty());

    let second = inbox.join("second.bin");
    fs::write(&second, bytes).unwrap();
    let conflict = service
        .scan_source_inbox("psx-scph-1001-bios", &limits)
        .unwrap();
    assert_eq!(conflict.state, SourceInboxResolutionState::Conflict);
    assert_eq!(
        conflict
            .candidates
            .iter()
            .map(|candidate| candidate.inspection.path.clone())
            .collect::<Vec<_>>(),
        vec![
            fs::canonicalize(&first).unwrap(),
            fs::canonicalize(&second).unwrap()
        ]
    );

    service
        .register_source("psx-scph-1001-bios", &first)
        .unwrap();
    let registered = service
        .scan_source_inbox(
            "psx-scph-1001-bios",
            &SourceDiscoveryLimits {
                max_entries: 1,
                max_hash_bytes: 1,
                ..limits
            },
        )
        .unwrap();
    assert_eq!(registered.state, SourceInboxResolutionState::Registered);
    assert_eq!(registered.selected.unwrap().path, first);
    assert_eq!(registered.stats.entries_examined, 0);
}

#[test]
fn zip_members_file_sets_and_gamecube_images_use_the_shared_inspector() {
    let zip_bytes = b"synthetic archived BIOS";
    let zip_catalog = catalog_with("psx-scph-1001-bios", |representation| {
        representation.extensions = vec!["bin".into()];
        representation.kind = SourceRepresentationKind::RawFile {
            identities: vec![hashes(zip_bytes, DigestScope::NormalizedContent)],
        };
    });
    let (_temporary, zip_service) = service(zip_catalog);
    let zip_inbox = profile_dir(&zip_service, "psx-scph-1001-bios");
    let zip_path = zip_inbox.join("bios.zip");
    let mut archive = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
    archive
        .start_file("bios.bin", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(zip_bytes).unwrap();
    archive.finish().unwrap();
    let zip = zip_service
        .scan_source_inbox("psx-scph-1001-bios", &SourceDiscoveryLimits::default())
        .unwrap();
    assert_eq!(
        zip.state,
        SourceInboxResolutionState::ExactMatch,
        "{zip:#?}"
    );
    assert_eq!(
        zip.selected.unwrap().path,
        fs::canonicalize(zip_path).unwrap()
    );

    let member_bytes: [&[u8]; 3] = [b"synthetic cartridge", b"synthetic disk", b"synthetic IPL"];
    let file_set_catalog = catalog_with("g-diffuser-source-set", |representation| {
        representation.extensions = Vec::new();
        let SourceRepresentationKind::FileSet { members } = &mut representation.kind else {
            panic!("g-diffuser uses a file-set source")
        };
        for (member, bytes) in members.iter_mut().zip(member_bytes) {
            member.identities = vec![hashes(bytes, DigestScope::FileSetMember)];
        }
    });
    let (_temporary, file_set_service) = service(file_set_catalog);
    let file_set_inbox = profile_dir(&file_set_service, "g-diffuser-source-set");
    let set = file_set_inbox.join("owned-files");
    fs::create_dir(&set).unwrap();
    for (name, bytes) in [
        ("baserom.us.rev0.z64", member_bytes[0]),
        ("baserom.translated.ek.ndd", member_bytes[1]),
        ("N64DDIPLROM.n64", member_bytes[2]),
    ] {
        fs::write(set.join(name), bytes).unwrap();
    }
    let file_set = file_set_service
        .scan_source_inbox("g-diffuser-source-set", &SourceDiscoveryLimits::default())
        .unwrap();
    assert_eq!(file_set.state, SourceInboxResolutionState::ExactMatch);
    assert_eq!(
        file_set.selected.unwrap().path,
        fs::canonicalize(set).unwrap()
    );

    let disc_bytes = b"synthetic GameCube image";
    let gamecube_catalog = catalog_with("animal-crossing-gamecube", |representation| {
        representation.extensions = vec!["iso".into()];
        representation.kind = SourceRepresentationKind::GamecubeNormalizedIso {
            identities: vec![hashes(disc_bytes, DigestScope::GamecubeNormalizedIso)],
        };
    });
    let (_temporary, gamecube_service) = service(gamecube_catalog);
    let gamecube_inbox = profile_dir(&gamecube_service, "animal-crossing-gamecube");
    let disc = gamecube_inbox.join("game.iso");
    fs::write(&disc, disc_bytes).unwrap();
    let gamecube = gamecube_service
        .scan_source_inbox(
            "animal-crossing-gamecube",
            &SourceDiscoveryLimits::default(),
        )
        .unwrap();
    assert_eq!(gamecube.state, SourceInboxResolutionState::ExactMatch);
    assert_eq!(
        gamecube.selected.unwrap().path,
        fs::canonicalize(disc).unwrap()
    );
}

#[test]
fn informational_and_tool_required_candidates_are_never_registered_silently() {
    let (_temporary, service) = service(Catalog::embedded().unwrap());
    let inbox = profile_dir(&service, "opengoal-jak1-disc");
    fs::write(inbox.join("disc.iso"), b"format-only disc").unwrap();
    let informational = service
        .scan_source_inbox("opengoal-jak1-disc", &SourceDiscoveryLimits::default())
        .unwrap();
    assert_eq!(
        informational.state,
        SourceInboxResolutionState::ApprovalRequired
    );
    let error = service
        .resolve_and_register_inbox_source(
            "opengoal-jak1-disc",
            None,
            &OperationCoordinator::new("informational-inbox", None),
        )
        .unwrap_err();
    assert_eq!(error.details["inbox_state"], "approval_required");
    assert!(service.library().sources().unwrap().is_empty());

    let disc_inbox = profile_dir(&service, "mega-man-x6-psx");
    fs::write(disc_inbox.join("disc.chd"), b"not a CHD").unwrap();
    let tool_required = service
        .scan_source_inbox("mega-man-x6-psx", &SourceDiscoveryLimits::default())
        .unwrap();
    assert_eq!(tool_required.state, SourceInboxResolutionState::Incomplete);
    assert!(tool_required.selected.is_none());
    assert!(!tool_required.stats.issues.is_empty());
    assert!(service.library().sources().unwrap().is_empty());
}

#[test]
fn install_time_resolution_rechecks_and_registers_only_one_exact_match() {
    let bytes = b"install-time exact BIOS";
    let (_temporary, service) = service(exact_bios_catalog(bytes));
    let inbox = profile_dir(&service, "psx-scph-1001-bios");
    let source = inbox.join("bios.bin");
    fs::write(&source, bytes).unwrap();
    let registered = service
        .resolve_and_register_inbox_source(
            "psx-scph-1001-bios",
            None,
            &OperationCoordinator::new("install-inbox", None),
        )
        .unwrap();
    assert_eq!(registered.path, fs::canonicalize(source).unwrap());
    assert_eq!(
        service
            .library()
            .source("psx-scph-1001-bios")
            .unwrap()
            .unwrap()
            .sha256,
        registered.sha256
    );
}

#[test]
fn entry_and_hash_limits_make_uniqueness_incomplete() {
    let bytes = b"bounded exact BIOS";
    let (_temporary, service) = service(exact_bios_catalog(bytes));
    let inbox = profile_dir(&service, "psx-scph-1001-bios");
    fs::create_dir(inbox.join("nested")).unwrap();
    fs::write(inbox.join("nested/bios.bin"), bytes).unwrap();
    let depth = service
        .scan_source_inbox(
            "psx-scph-1001-bios",
            &SourceDiscoveryLimits {
                max_depth: 0,
                ..SourceDiscoveryLimits::default()
            },
        )
        .unwrap();
    assert_eq!(depth.state, SourceInboxResolutionState::Incomplete);
    assert!(
        depth
            .stats
            .limits_reached
            .contains(&SourceDiscoveryLimit::Depth)
    );

    let hash = service
        .scan_source_inbox(
            "psx-scph-1001-bios",
            &SourceDiscoveryLimits {
                max_hash_bytes: bytes.len() as u64 - 1,
                ..SourceDiscoveryLimits::default()
            },
        )
        .unwrap();
    assert_eq!(hash.state, SourceInboxResolutionState::Incomplete);
    assert!(
        hash.stats
            .limits_reached
            .contains(&SourceDiscoveryLimit::HashBytes)
    );
}
