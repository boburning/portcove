use super::*;
use std::collections::BTreeMap;

fn service(root: &Path) -> PortcoveService {
    PortcoveService::new(crate::Library::open(root.join("library")).unwrap()).unwrap()
}

fn write_executable(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"synthetic executable").unwrap();
    crate::permissions::normalize_archive_entry(path, false, true).unwrap();
}

fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.insert(path.clone(), fs::read(path).unwrap());
            }
        }
    }
    files
}

/// Two ordinary catalog ports whose folders adopt from the declared executable alone.
fn two_adoptable_items(service: &PortcoveService, root: &Path) -> Vec<AdoptionBatchItem> {
    let platform = Platform::current().unwrap();
    let mut items = Vec::new();
    for port in service.catalog.ports() {
        let Some(hint) = port.executable_hints.get(&platform).and_then(|h| h.first()) else {
            continue;
        };
        if port.release.provider != ReleaseSource::Github || hint.contains(['*', '?']) {
            continue;
        }
        let source = root.join(format!("existing-{}", port.id));
        write_executable(&source.join(hint));
        fs::write(source.join("readme.txt"), port.id.as_bytes()).unwrap();
        if service.preview_adoption(&source, Some(&port.id)).is_ok() {
            items.push(AdoptionBatchItem {
                source,
                port_id: port.id.clone(),
            });
            if items.len() == 2 {
                return items;
            }
        } else {
            fs::remove_dir_all(&source).unwrap();
        }
    }
    panic!("the embedded catalog has fewer than two ordinary adoptable ports here");
}

#[test]
fn one_review_and_consent_copies_every_unchanged_item_and_holds_a_changed_one() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let service = service(root);
    let items = two_adoptable_items(&service, root);

    let preview = service.preview_adoption_batch(&items).unwrap();
    assert_eq!(preview.items.len(), 2);
    assert!(!preview.original_will_be_modified);
    assert_eq!(
        preview.total_files,
        preview
            .items
            .iter()
            .map(|item| item.copy_plan.files.len())
            .sum::<usize>()
    );
    assert_eq!(
        service.preview_adoption_batch(&items).unwrap().batch_sha256,
        preview.batch_sha256,
        "review is deterministic for unchanged folders"
    );

    // The second folder changes after review: it is held, the first still copies.
    fs::write(items[1].source.join("readme.txt"), b"changed after review").unwrap();
    let originals = items
        .iter()
        .map(|item| tree(&item.source))
        .collect::<Vec<_>>();
    let authorization = service
        .authorize_adoption_batch(&items, &preview.batch_sha256)
        .unwrap();
    let result = service
        .adopt_batch(&items, &preview, &authorization.token)
        .unwrap();

    assert_eq!(result.items[0].outcome, AdoptionBatchItemOutcome::Copied);
    assert_eq!(
        result.items[0].install.as_ref().unwrap().port_id,
        items[0].port_id
    );
    assert_eq!(result.items[1].outcome, AdoptionBatchItemOutcome::Changed);
    assert!(result.items[1].install.is_none());
    assert!(service.status(&items[1].port_id).unwrap().active.is_none());
    for (item, before) in items.iter().zip(&originals) {
        assert_eq!(&tree(&item.source), before, "originals are never modified");
    }

    // The consent was single-use.
    assert!(
        service
            .adopt_batch(&items, &preview, &authorization.token)
            .is_err()
    );
}

#[test]
fn consent_binds_exactly_the_reviewed_items() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let service = service(root);
    let items = two_adoptable_items(&service, root);
    let preview = service.preview_adoption_batch(&items).unwrap();

    // A consent for one item list cannot run another.
    let only_first = &items[..1];
    let authorization = service
        .authorize_adoption_batch(&items, &preview.batch_sha256)
        .unwrap();
    assert!(
        service
            .adopt_batch(only_first, &preview, &authorization.token)
            .is_err()
    );
    // A tampered review is refused before any copy.
    let mut tampered = preview.clone();
    tampered.items[0].plan_sha256 = "0".repeat(64);
    let authorization = service
        .authorize_adoption_batch(&items, &preview.batch_sha256)
        .unwrap();
    assert!(
        service
            .adopt_batch(&items, &tampered, &authorization.token)
            .is_err()
    );
    // A forged token copies nothing.
    assert!(service.adopt_batch(&items, &preview, "ungranted").is_err());
    for item in &items {
        assert!(service.status(&item.port_id).unwrap().active.is_none());
    }
}

#[test]
fn batches_refuse_empty_duplicate_and_unreviewable_items() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let service = service(root);
    let items = two_adoptable_items(&service, root);

    assert!(service.preview_adoption_batch(&[]).is_err());
    let same_folder = vec![items[0].clone(), items[0].clone()];
    assert!(
        service
            .preview_adoption_batch(&same_folder)
            .unwrap_err()
            .message
            .contains("more than once")
    );
    let same_port = vec![
        items[0].clone(),
        AdoptionBatchItem {
            source: items[1].source.clone(),
            port_id: items[0].port_id.clone(),
        },
    ];
    assert!(
        service
            .preview_adoption_batch(&same_port)
            .unwrap_err()
            .message
            .contains("one installation per game")
    );
    // A folder that does not hold its named port refuses the whole review.
    let wrong = vec![
        items[0].clone(),
        AdoptionBatchItem {
            source: root.join("empty"),
            port_id: items[1].port_id.clone(),
        },
    ];
    fs::create_dir_all(root.join("empty")).unwrap();
    assert!(service.preview_adoption_batch(&wrong).is_err());
    let too_many = (0..=ADOPTION_BATCH_LIMIT)
        .map(|index| AdoptionBatchItem {
            source: root.join(format!("x{index}")),
            port_id: format!("p{index}"),
        })
        .collect::<Vec<_>>();
    assert!(service.preview_adoption_batch(&too_many).is_err());
}
