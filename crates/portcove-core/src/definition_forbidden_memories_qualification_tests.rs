//! Explicit disposable assessment of the #141 producer admission boundary.
//! This neither provisions production authority nor executes upstream payloads.

use super::*;

const PORT: &str = "yu-gi-oh-forbidden-memories-recompiled";
const REPOSITORY_ID: u64 = 1_339_885_631;

#[tokio::test]
#[ignore = "explicit owned Forbidden Memories producer admission assessment"]
async fn qualification_assesses_forbidden_memories_producer_library() {
    assert!(
        std::env::var_os("PORTCOVE_QUALIFICATION_CATALOG").is_none(),
        "producer admission assessment must use the production embedded catalog"
    );
    let root = PathBuf::from(
        std::env::var_os("PORTCOVE_QUALIFICATION_FORBIDDEN_MEMORIES_LIBRARY")
            .expect("explicit fresh fixture library is required"),
    );
    assert!(root.is_absolute(), "fixture library must be absolute");
    // Never attach fixture publisher authority to an existing player library.
    fs::create_dir(&root).expect("fixture library must be a new directory");
    let library = Library::open(&root).unwrap();
    let authored = Catalog::embedded().unwrap();
    let original_port = serde_json::to_value(authored.port(PORT).unwrap()).unwrap();
    assert_eq!(
        original_port["release"]["repository"],
        "Unchiga/YuGiOhForbiddenMemoriesRecomp"
    );
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let mut targets = repository_targets_for(&authored, PORT);
    let mut document = availability_for(&targets, PORT, 1);
    document["policy_schema"] = serde_json::json!(2);
    document["grant_id"] = serde_json::json!("managed-github-v1-forbidden-memories-fixture");
    document["decision"]["status"] = serde_json::json!("managed_github");
    document["decision"]["repository_id"] = serde_json::json!(REPOSITORY_ID);
    document["decision"]["artifact_hosts"] =
        serde_json::json!(["github.com", "release-assets.githubusercontent.com"]);
    document["decision"]["max_redirects"] = serde_json::json!(5);
    document["decision"]["operations"] =
        serde_json::json!(["install", "update", "prepare", "launch"]);
    targets.push((
        format!("policy/official/{PORT}.json"),
        serde_json::to_vec(&document).unwrap(),
    ));
    let trusted_root = fixture
        .publish_with_policy(
            &targets,
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((&key, 1)),
        )
        .await;
    let candidate = acquire(&fixture, &trusted_root).await.unwrap();
    let admission = acquire_policy(&fixture, &trusted_root, PORT).await.unwrap();
    policy::install_authority_for_test(&library, &trusted_root).unwrap();
    let refusal = library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap_err();
    assert_eq!(refusal.code, crate::ErrorCode::Unsupported);
    assert_eq!(
        refusal.message,
        "managed GitHub scope does not authorize auxiliary runtime or toolchain acquisition"
    );
    let selected = library.definition_selection_status().unwrap();
    assert!(selected.selected.is_none());
    let service = PortcoveService::new(library.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(service.catalog().port(PORT).unwrap()).unwrap(),
        original_port,
        "fixture admission must preserve the production selector and declaration"
    );
    assert!(
        policy::acquisition_scope(&library, service.catalog(), PORT)
            .unwrap()
            .is_none()
    );
    fs::write(
        root.join("producer-fixture-refusal.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "qualification_only": true,
            "port_id": PORT,
            "repository_id": REPOSITORY_ID,
            "outcome": "not_admitted",
            "reason": refusal.message,
            "trusted_root_sha256": hex::encode(Sha256::digest(&trusted_root)),
            "selected": selected.selected,
            "unchanged_port": original_port,
        }))
        .unwrap(),
    )
    .unwrap();
}
