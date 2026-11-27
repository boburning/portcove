use super::*;
use crate::{ErrorCode, retained_build::tests::fixture};
use std::{fs, io::Write, path::Path};

fn o2r(dir: &Path, name: &str, assets: &[(&str, &[u8])]) -> std::path::PathBuf {
    let path = dir.join(name);
    let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    for (entry, bytes) in assets {
        writer
            .start_file(*entry, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
    path
}

const SAMPLE_ORIGINAL: &[u8] = &[0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4, 5, 6, 7, 8];

struct World {
    _temporary: tempfile::TempDir,
    service: PortcoveService,
    profile: String,
}

fn world() -> World {
    let (temporary, service, _first) = fixture();
    let original = temporary.path().join("input.z64");
    fs::write(&original, SAMPLE_ORIGINAL).unwrap();
    service.register_source("star-fox-64", &original).unwrap();
    let profile = service.ensure_default_profile("starship").unwrap().id;
    let scratch = temporary.path().join("scratch");
    fs::create_dir_all(&scratch).unwrap();
    let package = o2r(&scratch, "hd-link.o2r", &[("objects/link.bin", b"hd")]);
    service
        .install_mod_package("starship", &profile, &package, 1)
        .unwrap();
    World {
        _temporary: temporary,
        service,
        profile,
    }
}

fn bytes(recipe: &ProfileRecipe) -> Vec<u8> {
    serde_json::to_vec_pretty(recipe).unwrap()
}

fn sealed(mut recipe: ProfileRecipe) -> ProfileRecipe {
    recipe.identity_sha256 = identity(&recipe).unwrap();
    recipe
}

#[test]
fn export_carries_identity_only_and_states_what_it_cannot_reproduce() {
    let w = world();
    let recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    assert_eq!(recipe.format, RECIPE_FORMAT);
    assert_eq!(recipe.packages.len(), 1);
    assert_eq!(recipe.packages[0].native_id, "hd-link.o2r");
    let json = String::from_utf8(bytes(&recipe)).unwrap();
    // No private machine paths, install IDs, profile identity or save group leak.
    let root = w._temporary.path().display().to_string();
    assert!(!json.contains(&root), "no private path");
    assert!(!json.contains(&w.profile), "no local profile identity");
    assert!(!json.contains("install_id") && !json.contains("selected_executable"));
    assert!(recipe.uncaptured.iter().any(|line| line.contains("saves")));
    assert!(
        recipe
            .uncaptured
            .iter()
            .any(|line| line.contains("original game files"))
    );
    // The first revision (clean setup) exports with no packages.
    let clean = w
        .service
        .export_profile_recipe("starship", &w.profile, Some(1))
        .unwrap();
    assert!(clean.packages.is_empty());
    assert_ne!(clean.identity_sha256, recipe.identity_sha256);
}

#[test]
fn exports_without_format_two_fields_keep_the_legacy_note_and_digest() {
    let (_temporary, service, _install) = fixture();
    let profile = service.ensure_default_profile("starship").unwrap();
    let recipe = service
        .export_profile_recipe("starship", &profile.id, None)
        .unwrap();

    assert_eq!(recipe.format, LEGACY_RECIPE_FORMAT);
    assert!(recipe.originals.is_empty());
    assert_eq!(
        recipe.uncaptured[0],
        "original game files are never included; originals are referenced by content identity only"
    );
    assert_eq!(ProfileRecipe::inspect(&bytes(&recipe)).unwrap(), recipe);
}

#[test]
fn inspection_accepts_exported_bytes_and_rejects_malformed_or_forged_recipes() {
    let w = world();
    let recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    assert_eq!(ProfileRecipe::inspect(&bytes(&recipe)).unwrap(), recipe);

    let mut changed = recipe.clone();
    changed.packages[0].sha256 = "e".repeat(64);
    assert!(
        ProfileRecipe::inspect(&bytes(&changed)).is_err(),
        "digest binds content"
    );
    let mut future = serde_json::to_value(&recipe).unwrap();
    future["format"] = serde_json::json!(RECIPE_FORMAT_WITH_PROVIDER_BINDINGS + 1);
    assert_eq!(
        ProfileRecipe::inspect(future.to_string().as_bytes())
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    let mut extra = serde_json::to_value(&recipe).unwrap();
    extra["script"] = serde_json::json!("rm -rf /");
    assert!(ProfileRecipe::inspect(extra.to_string().as_bytes()).is_err());
    // A field unknown to a nested identity type is not silently dropped: the
    // digest would still match, so inspection must refuse it explicitly.
    let mut nested = serde_json::to_value(&recipe).unwrap();
    nested["runtime"]["artifact"]["url"] = serde_json::json!("https://evil.example/x.exe");
    assert!(ProfileRecipe::inspect(nested.to_string().as_bytes()).is_err());
    // A duplicate key would let different readers see different recipes.
    let text = String::from_utf8(bytes(&recipe)).unwrap();
    let duplicated = text.replacen('{', r#"{"port_id":"bogus","#, 1);
    assert!(ProfileRecipe::inspect(duplicated.as_bytes()).is_err());
    // The CLI output envelope is accepted, and duplicates inside it are refused.
    let envelope = format!(r#"{{"schema_version":1,"data":{text}}}"#);
    assert_eq!(
        ProfileRecipe::inspect_document(envelope.as_bytes()).unwrap(),
        recipe
    );
    let hidden = format!(r#"{{"schema_version":1,"data":{duplicated}}}"#);
    assert!(ProfileRecipe::inspect_document(hidden.as_bytes()).is_err());
    assert!(ProfileRecipe::inspect(b"{not json").is_err());
    assert!(
        ProfileRecipe::inspect(&vec![b' '; 300 * 1024]).is_err(),
        "bounded"
    );

    for bad in ["../../x", "/etc/passwd", "a/b.o2r", ".hidden", "x.o2r."] {
        let mut hostile = recipe.clone();
        hostile.packages[0].native_id = bad.into();
        hostile.orderings.clear();
        assert!(
            ProfileRecipe::inspect(&bytes(&sealed(hostile))).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn dependency_conflicts_and_cycles_are_refused_with_concrete_reasons() {
    let w = world();
    let recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    let package = |id: &str, requires: &[&str]| RecipePackage {
        native_id: id.into(),
        native_version: None,
        provider: None,
        sha256: "a".repeat(64),
        size: 1,
        enabled: true,
        requires: requires.iter().map(|r| r.to_string()).collect(),
        provider_requires: Vec::new(),
    };
    let mut missing = recipe.clone();
    missing.packages = vec![package("a.o2r", &["b.o2r"])];
    missing.orderings.clear();
    let error = ProfileRecipe::inspect(&bytes(&sealed(missing))).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    let mut cycle = recipe.clone();
    cycle.packages = vec![package("a.o2r", &["b.o2r"]), package("b.o2r", &["a.o2r"])];
    cycle.orderings.clear();
    let error = ProfileRecipe::inspect(&bytes(&sealed(cycle))).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(error.message.contains("cycle"));
    let mut ok = recipe;
    ok.packages = vec![package("a.o2r", &["b.o2r"]), package("b.o2r", &[])];
    ok.orderings.clear();
    ProfileRecipe::inspect(&bytes(&sealed(ok))).unwrap();
}

#[test]
fn exact_identity_round_trips_into_a_new_profile_when_every_input_exists() {
    let w = world();
    w.service
        .set_profile_update_policy(
            "starship",
            &w.profile,
            crate::ProfileUpdatePolicy::AutomaticEligible,
        )
        .unwrap();
    let recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    let inspected = ProfileRecipe::inspect(&bytes(&recipe)).unwrap();
    let plan = w.service.plan_recipe_import(&inspected).unwrap();
    assert!(plan.can_apply, "{:?}", plan.holds);
    assert_eq!(plan.runtime.status, RecipeInputStatus::Available);
    assert_eq!(plan.packages[0].status, RecipeInputStatus::Available);
    let token = w
        .service
        .authorize_recipe_import(&plan, "From recipe")
        .unwrap()
        .token;
    let imported = w
        .service
        .apply_recipe_import(&plan, "From recipe", &token)
        .unwrap();
    assert!(!imported.is_default);
    assert_ne!(imported.id, w.profile);
    assert_eq!(
        imported.intent.update_policy,
        crate::ProfileUpdatePolicy::ReviewUpdates
    );
    let round_trip = w
        .service
        .export_profile_recipe("starship", &imported.id, None)
        .unwrap();
    assert_eq!(round_trip.identity_sha256, recipe.identity_sha256);
    assert_eq!(round_trip, recipe);
    // The copy has its own progress; the original profile is untouched.
    let connection = w.service.library().connection().unwrap();
    let original = profile::profile_by_id(&connection, "starship", &w.profile).unwrap();
    assert_eq!(
        original.intent.update_policy,
        crate::ProfileUpdatePolicy::AutomaticEligible
    );
    let a = profile::current_revision(&connection, "starship", &w.profile).unwrap();
    let b = profile::current_revision(&connection, "starship", &imported.id).unwrap();
    assert_ne!(a.save_group, b.save_group);
    assert_eq!(a.revision, 2);
    assert!(
        w.service
            .apply_recipe_import(&plan, "From recipe", &token)
            .is_err(),
        "consent is single use"
    );
}

#[test]
fn missing_changed_or_foreign_inputs_hold_the_plan_and_change_nothing() {
    let w = world();
    let recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    // A package whose bytes are not in the store (provider-sourced or local).
    let mut missing = recipe.clone();
    missing.packages[0].sha256 = "d".repeat(64);
    let plan = w
        .service
        .plan_recipe_import(&sealed(missing.clone()))
        .unwrap();
    assert!(!plan.can_apply);
    assert_eq!(plan.packages[0].status, RecipeInputStatus::Unavailable);
    missing.packages[0].provider = Some(ProviderPackageRef {
        binding: None,
        provider: "gamebanana".into(),
        project: "1".into(),
        file: Some("2".into()),
        version: None,
    });
    let plan = w
        .service
        .plan_recipe_import(&sealed(missing.clone()))
        .unwrap();
    assert_eq!(plan.packages[0].status, RecipeInputStatus::Unavailable);
    assert!(plan.packages[0].detail.contains("project 1, file 2"));
    assert!(
        plan.packages[0]
            .detail
            .contains("availability has not been verified")
    );
    // Only a complete GameBanana file reference for a bound game can be planned.
    for provider in [
        ProviderPackageRef {
            binding: None,
            provider: "gamebanana".into(),
            project: "1".into(),
            file: None,
            version: None,
        },
        ProviderPackageRef {
            binding: None,
            provider: "elsewhere".into(),
            project: "1".into(),
            file: Some("2".into()),
            version: None,
        },
        ProviderPackageRef {
            binding: None,
            provider: "gamebanana".into(),
            project: "../1".into(),
            file: Some("2".into()),
            version: None,
        },
    ] {
        let mut unplannable = missing.clone();
        unplannable.packages[0].provider = Some(provider);
        let held = w.service.plan_recipe_import(&sealed(unplannable)).unwrap();
        assert_eq!(held.packages[0].status, RecipeInputStatus::Unavailable);
        assert!(!held.can_apply);
    }
    let token = w.service.authorize_recipe_import(&plan, "x").unwrap().token;
    assert_eq!(
        w.service
            .apply_recipe_import(&plan, "x", &token)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    // A different runtime build.
    let mut other_runtime = recipe.clone();
    other_runtime.runtime.artifact.sha256 = "b".repeat(64);
    let plan = w
        .service
        .plan_recipe_import(&sealed(other_runtime))
        .unwrap();
    assert!(!plan.can_apply && plan.install_id.is_none());
    // A different platform.
    let mut platform = recipe.clone();
    platform.runtime.platform = if Platform::current().unwrap() == Platform::WindowsX86_64 {
        Platform::LinuxX86_64
    } else {
        Platform::WindowsX86_64
    };
    let plan = w.service.plan_recipe_import(&sealed(platform)).unwrap();
    assert!(plan.holds.iter().any(|hold| hold.contains("platform")));
    // An original that is not registered.
    // An original requirement another game uses is not trusted as this game's.
    let mut foreign = recipe.clone();
    foreign.originals.push(RecipeOriginal {
        requirement_id: "ocarina-of-time".into(),
        sha256: "c".repeat(64),
        size: 5,
        storage: recipe.originals[0].storage.clone(),
    });
    let plan = w.service.plan_recipe_import(&sealed(foreign)).unwrap();
    assert!(!plan.can_apply);
    assert!(
        plan.holds
            .iter()
            .any(|hold| hold.contains("not an input this game uses"))
    );
    let mut original = recipe;
    original.originals[0].sha256 = "c".repeat(64);
    original.originals[0].size = 5;
    let plan = w.service.plan_recipe_import(&sealed(original)).unwrap();
    assert_eq!(plan.originals[0].status, RecipeInputStatus::Unavailable);
    // Nothing was created by any of the above.
    assert_eq!(
        w.service
            .profile_inventory("starship")
            .unwrap()
            .profiles
            .len(),
        1
    );
}

#[test]
fn inputs_changing_after_review_invalidate_the_plan() {
    let w = world();
    let recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    let plan = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(plan.can_apply);
    let token = w
        .service
        .authorize_recipe_import(&plan, "Late")
        .unwrap()
        .token;
    // The package bytes disappear from the store between review and apply.
    let layout = crate::profile_deploy::Layout::for_user(&w.service.library().user_dir("starship"));
    fs::remove_file(layout.package(&recipe.packages[0].sha256, &recipe.packages[0].native_id))
        .unwrap();
    let error = w
        .service
        .apply_recipe_import(&plan, "Late", &token)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(
        w.service
            .profile_inventory("starship")
            .unwrap()
            .profiles
            .len(),
        1
    );
}

#[test]
fn constructed_recipes_are_held_to_the_same_rules_as_inspected_ones() {
    let w = world();
    let recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    // A directly constructed recipe cannot skip the format gate.
    let mut future = recipe.clone();
    future.format = 99;
    let future = sealed(future);
    assert_eq!(
        w.service.plan_recipe_import(&future).unwrap_err().code,
        ErrorCode::Unsupported
    );
    // Names that alias on case-insensitive filesystems are refused.
    let mut aliased = recipe.clone();
    let mut second = aliased.packages[0].clone();
    second.native_id = second.native_id.to_ascii_uppercase();
    aliased.packages.push(second);
    aliased.orderings.clear();
    assert!(ProfileRecipe::inspect(&bytes(&sealed(aliased))).is_err());
    // Oversized identity text is refused.
    let mut long = recipe;
    long.runtime.artifact.asset_name = "x".repeat(MAX_TEXT + 1);
    assert!(ProfileRecipe::inspect(&bytes(&sealed(long))).is_err());
}

fn label(project: &str, file: &str) -> ProviderPackageRef {
    ProviderPackageRef {
        binding: None,
        provider: "gamebanana".into(),
        project: project.into(),
        file: Some(file.into()),
        version: None,
    }
}

fn import(w: &World, recipe: ProfileRecipe, name: &str) -> (RecipeImportPlan, Profile) {
    let plan = w.service.plan_recipe_import(&sealed(recipe)).unwrap();
    assert!(plan.can_apply, "{:?}", plan.holds);
    let token = w
        .service
        .authorize_recipe_import(&plan, name)
        .unwrap()
        .token;
    let imported = w.service.apply_recipe_import(&plan, name, &token).unwrap();
    (plan, imported)
}

#[test]
fn a_recipe_keeps_only_provider_labels_this_library_recorded_for_the_same_bytes() {
    let w = world();
    // The library records a provider label for its package, as a provider install does.
    let connection = w.service.library().connection().unwrap();
    let current = profile::current_revision(&connection, "starship", &w.profile).unwrap();
    let mut packages = current.packages.clone();
    packages[0].provider = Some(label("1", "2"));
    w.service
        .create_profile_revision(
            "starship",
            &w.profile,
            &crate::ProfileRevisionRequest {
                expected_revision: current.revision,
                packages: Some(packages),
                ..Default::default()
            },
        )
        .unwrap();
    let recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    assert_eq!(recipe.packages[0].provider, Some(label("1", "2")));

    // Exactly the recorded label is kept and the identity round-trips.
    let (_, kept) = import(&w, recipe.clone(), "Kept");
    let round_trip = w
        .service
        .export_profile_recipe("starship", &kept.id, None)
        .unwrap();
    assert_eq!(round_trip.identity_sha256, recipe.identity_sha256);

    // A recipe without a label never gains one.
    let mut unlabelled = recipe.clone();
    unlabelled.packages[0].provider = None;
    let unlabelled = sealed(unlabelled);
    let (_, plain) = import(&w, unlabelled.clone(), "Plain");
    let round_trip = w
        .service
        .export_profile_recipe("starship", &plain.id, None)
        .unwrap();
    assert_eq!(round_trip.identity_sha256, unlabelled.identity_sha256);

    // A different label for the same bytes is dropped, not substituted, and the
    // reviewed plan says so.
    let mut relabelled = recipe.clone();
    relabelled.packages[0].provider = Some(label("9", "9"));
    let (plan, other) = import(&w, relabelled, "Relabelled");
    assert!(plan.packages[0].detail.contains("does not keep it"));
    let connection = w.service.library().connection().unwrap();
    let revision = profile::current_revision(&connection, "starship", &other.id).unwrap();
    assert_eq!(
        revision.packages[0].provider, None,
        "update checks never follow a label the recipe supplied"
    );
}

#[test]
fn unverified_acquisition_names_the_canonical_provider_file() {
    let w = world();
    let mut recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    recipe.packages[0].sha256 = "d".repeat(64);
    recipe.packages[0].provider = Some(label("+01", "2"));
    let plan = w.service.plan_recipe_import(&sealed(recipe)).unwrap();
    assert_eq!(plan.packages[0].status, RecipeInputStatus::Unavailable);
    assert!(plan.packages[0].detail.contains("project 1, file 2"));
    assert!(
        plan.packages[0]
            .detail
            .contains("availability has not been verified")
    );
}

#[test]
fn a_recipe_enabling_two_packages_the_game_loads_as_one_mod_is_held() {
    let w = world();
    let mut recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    let mut twin = recipe.packages[0].clone();
    twin.native_id = "HD-LINK.otr".into();
    recipe.packages.push(twin);
    recipe.orderings.clear();
    let plan = w.service.plan_recipe_import(&sealed(recipe)).unwrap();
    assert!(!plan.can_apply);
    assert!(
        plan.holds.iter().any(|hold| hold.contains("same mod")),
        "{:?}",
        plan.holds
    );
}

fn v1_recipe(mut recipe: ProfileRecipe) -> ProfileRecipe {
    recipe.format = LEGACY_RECIPE_FORMAT;
    for original in &mut recipe.originals {
        original.storage = None;
    }
    sealed(recipe)
}

#[test]
fn recipe_replays_the_exact_original_after_the_default_representation_changes() {
    let w = world();
    let port = "starship";
    let requirement = "star-fox-64";
    let profile = w
        .service
        .copy_profile(port, &w.profile, "Raw original")
        .unwrap();
    let original = w.service.library().source(requirement).unwrap().unwrap();
    let zipped = o2r(
        w._temporary.path(),
        "compressed.zip",
        &[("input.z64", SAMPLE_ORIGINAL)],
    );
    let new_default = w.service.register_source(requirement, &zipped).unwrap();
    assert_eq!(new_default.sha256, original.sha256);
    assert_ne!(new_default.storage_sha256, original.storage_sha256);

    let recipe = w
        .service
        .export_profile_recipe(port, &profile.id, None)
        .unwrap();
    assert_eq!(recipe.format, RECIPE_FORMAT);
    assert_eq!(
        recipe.originals[0].storage.as_ref().unwrap().sha256,
        original.storage_sha256
    );
    assert!(
        !String::from_utf8(bytes(&recipe))
            .unwrap()
            .contains("input.z64")
    );
    let exact = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(exact.can_apply, "{:?}", exact.holds);
    assert_eq!(
        exact.verified_originals,
        [profile::bind_original(requirement, &original)]
    );
    let token = w
        .service
        .authorize_recipe_import(&exact, "Imported")
        .unwrap()
        .token;
    let imported = w
        .service
        .apply_recipe_import(&exact, "Imported", &token)
        .unwrap();
    let revision = w
        .service
        .profile_revisions(port, &imported.id)
        .unwrap()
        .remove(0);
    assert_eq!(revision.originals, exact.verified_originals);

    let legacy = v1_recipe(recipe.clone());
    assert!(
        !String::from_utf8(bytes(&legacy))
            .unwrap()
            .contains("storage")
    );
    assert_eq!(ProfileRecipe::inspect(&bytes(&legacy)).unwrap(), legacy);
    let ambiguous = w.service.plan_recipe_import(&legacy).unwrap();
    assert!(!ambiguous.can_apply);
    assert!(
        ambiguous.originals[0]
            .detail
            .contains("more than one saved representation")
    );

    // Format 2 already supported mod state with content-only originals.
    let mut earlier_format_two = legacy.clone();
    earlier_format_two.format = 2;
    let earlier_format_two = sealed(earlier_format_two);
    let earlier_format_two = ProfileRecipe::inspect(&bytes(&earlier_format_two)).unwrap();
    let earlier_plan = w.service.plan_recipe_import(&earlier_format_two).unwrap();
    assert!(!earlier_plan.can_apply);
    assert_eq!(earlier_plan.originals, ambiguous.originals);

    fs::write(&original.path, [0u8; SAMPLE_ORIGINAL.len()]).unwrap();
    let changed = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(!changed.can_apply);
    assert!(
        changed.originals[0]
            .detail
            .contains("missing, changed or no longer accepted")
    );
    let legacy_still_ambiguous = w.service.plan_recipe_import(&legacy).unwrap();
    assert!(
        legacy_still_ambiguous.originals[0]
            .detail
            .contains("more than one saved representation")
    );
}

#[test]
fn a_legacy_plan_notice_is_stale_when_the_only_matching_representation_changes() {
    let w = world();
    let port = "starship";
    let requirement = "star-fox-64";
    let recipe = v1_recipe(
        w.service
            .export_profile_recipe(port, &w.profile, None)
            .unwrap(),
    );
    let first_plan = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(first_plan.can_apply);
    let token = w
        .service
        .authorize_recipe_import(&first_plan, "Imported")
        .unwrap()
        .token;

    let preview = w.service.preview_source_removal(requirement).unwrap();
    let removal = w
        .service
        .authorize_source_removal(requirement, &preview.preview_sha256)
        .unwrap();
    w.service
        .remove_source(requirement, &removal.token)
        .unwrap();
    let zipped = o2r(
        w._temporary.path(),
        "compressed.zip",
        &[("input.z64", SAMPLE_ORIGINAL)],
    );
    w.service.register_source(requirement, &zipped).unwrap();

    let second_plan = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(second_plan.can_apply);
    assert_ne!(first_plan.plan_sha256, second_plan.plan_sha256);
    assert_eq!(
        w.service
            .apply_recipe_import(&first_plan, "Imported", &token)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
}

#[test]
fn a_recipe_cannot_omit_original_files_required_by_its_runtime() {
    let w = world();
    let mut recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    recipe.originals.clear();
    let held = w.service.plan_recipe_import(&sealed(recipe)).unwrap();
    assert!(!held.can_apply);
    assert!(
        held.originals[0]
            .detail
            .contains("does not identify the original")
    );
}

#[test]
fn reviewed_provider_bytes_join_a_recipe_only_after_the_final_exact_approval() {
    use crate::provider_install::{ProviderInstallMode, digest};

    let w = world();
    let mut recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    let provider = label("1", "2");
    recipe.packages[0].provider = Some(provider.clone());
    let recipe = sealed(recipe);
    let input = &recipe.packages[0];
    let layout = w.service.deploy_layout("starship").unwrap();
    let stored = layout.package(&input.sha256, &input.native_id);
    let original = fs::read(&stored).unwrap();
    fs::remove_file(&stored).unwrap();
    let mut provider_plan = crate::ProviderInstallPlan {
        port_id: "starship".into(),
        profile_id: w.profile.clone(),
        expected_revision: 2,
        review_nonce: None,
        provider: provider.clone(),
        project_name: "Reviewed fixture".into(),
        file: crate::ProviderFileCandidate {
            file_id: "2".into(),
            file_name: "fixture.zip".into(),
            size: input.size,
            added_at: 1,
            download_url: "https://gamebanana.com/dl/2".into(),
            claimed_md5: None,
            archived: false,
            status_unknown: None,
            claimed_scan: None,
            thunderstore_dependencies: None,
        },
        download_sha256: input.sha256.clone(),
        download_size: input.size,
        members: vec![crate::PlanMember {
            file_name: input.native_id.clone(),
            sha256: input.sha256.clone(),
            size: input.size,
            asset_count: 1,
            runs_code: Vec::new(),
        }],
        wrappers: Vec::new(),
        ignored_entries: 0,
        replaces: Vec::new(),
        conflicts: Vec::new(),
        conflicts_truncated: false,
        unverified_claims: Vec::new(),
        plan_sha256: String::new(),
    };
    provider_plan.plan_sha256 = digest(&provider_plan).unwrap();
    let stage = ProviderInstallMode::Recipe {
        identity: &recipe.identity_sha256,
        install_id: None,
    }
    .staging(&layout, &provider_plan.plan_sha256);
    fs::create_dir_all(&stage).unwrap();
    let staged = stage.join(&input.native_id);
    fs::write(&staged, &original).unwrap();
    let acquisitions = [RecipeAcquisitionPlan {
        recipe_identity_sha256: recipe.identity_sha256.clone(),
        native_id: input.native_id.clone(),
        provider_plan,
    }];

    assert!(!w.service.plan_recipe_import(&recipe).unwrap().can_apply);
    let reviewed = w
        .service
        .plan_recipe_import_with_acquisitions(&recipe, &acquisitions)
        .unwrap();
    assert!(reviewed.can_apply, "{:?}", reviewed.holds);
    assert!(!stored.exists());
    let connection = w.service.library().connection().unwrap();
    let setup_count = profile::profile_count(&connection, "starship").unwrap();
    let approval = w
        .service
        .authorize_recipe_import(&reviewed, "Shared")
        .unwrap();

    w.service
        .discard_recipe_acquisition(&acquisitions[0])
        .unwrap();
    assert!(!stage.exists());
    assert!(!stored.exists());
    assert!(
        w.service
            .apply_recipe_import(&reviewed, "Shared", &approval.token)
            .is_err()
    );
    assert_eq!(
        profile::profile_count(&connection, "starship").unwrap(),
        setup_count
    );
    drop(connection);

    fs::create_dir_all(&stage).unwrap();
    fs::write(&staged, &original).unwrap();
    let approval = w
        .service
        .authorize_recipe_import(&reviewed, "Shared")
        .unwrap();
    fs::write(&staged, vec![0u8; original.len()]).unwrap();
    let changed = w
        .service
        .apply_recipe_import(&reviewed, "Shared", &approval.token)
        .unwrap_err();
    assert_eq!(changed.code, ErrorCode::Conflict);
    assert!(!stored.exists());
    // A step whose bytes no longer match leaves the review, so the next plan
    // shows the package as missing instead of offering it as ready again.
    assert!(!stage.exists());
    fs::create_dir_all(&stage).unwrap();

    #[cfg(unix)]
    {
        let replacement = w._temporary.path().join("otherwise-matching.o2r");
        fs::write(&replacement, &original).unwrap();
        std::os::unix::fs::symlink(&replacement, &staged).unwrap();
        assert!(
            w.service
                .apply_recipe_import(&reviewed, "Shared", &approval.token)
                .is_err()
        );
        assert!(!stored.exists());
        assert!(!stage.exists());
        fs::create_dir_all(&stage).unwrap();
        assert_eq!(fs::read(replacement).unwrap(), original);
    }
    fs::write(&staged, &original).unwrap();
    // Simulate interruption after durable package publication but before the
    // setup transaction. The staged bytes are still available for a fresh review.
    w.service
        .library()
        .consume_authorization(
            &approval.token,
            ACTION,
            &target(&reviewed, "Shared").unwrap(),
            &reviewed.plan_sha256,
        )
        .unwrap();
    publish_acquired_package(&layout, input, &staged).unwrap();
    assert_eq!(fs::read(&stored).unwrap(), original);
    assert!(stage.exists());
    let connection = w.service.library().connection().unwrap();
    assert_eq!(
        profile::profile_count(&connection, "starship").unwrap(),
        setup_count
    );
    drop(connection);
    let resumed = w
        .service
        .plan_recipe_import_with_acquisitions(&recipe, &acquisitions)
        .unwrap();
    assert_eq!(resumed.plan_sha256, reviewed.plan_sha256);
    let approval = w
        .service
        .authorize_recipe_import(&resumed, "Shared")
        .unwrap();
    let imported = w
        .service
        .apply_recipe_import(&resumed, "Shared", &approval.token)
        .unwrap();
    let history = w
        .service
        .profile_revisions("starship", &imported.id)
        .unwrap();
    assert_eq!(history[0].packages[0].provider.as_ref(), Some(&provider));
    assert_eq!(fs::read(stored).unwrap(), original);
    assert!(!stage.exists());
    let source = w.service.profile_revisions("starship", &w.profile).unwrap();
    assert_ne!(history[0].save_group, source[1].save_group);
}

#[test]
fn consented_staged_nrm_import_uses_the_exact_recipe_runtime_while_an_older_build_is_selected() {
    use crate::provider_install::{ProviderInstallMode, digest};
    let port = "zelda64-recomp";
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let platform = crate::Platform::current().unwrap();
    let catalog = crate::Catalog::from_json(&serde_json::json!({
        "schema_version": 1,
        "ports": [{
            "id": port, "name": "Synthetic Recomp test",
            "summary": "Retained runtime recipe fixture.",
            "project_url": "https://github.com/Zelda64Recomp/Zelda64Recomp",
            "support_tier": "beta", "channels": ["stable"], "platforms": [platform],
            "adapter": "n64-recomp-portable",
            "release": {"repository": "Zelda64Recomp/Zelda64Recomp"},
            "executable_hints": {(serde_json::to_value(platform).unwrap().as_str().unwrap()): ["fixture.exe"]},
            "persistent_paths": ["mods", "mods.json", "mod_config"]
        }]
    }).to_string()).unwrap();
    let old = crate::retained_build::tests::install_fixture_port(
        &library,
        &catalog,
        port,
        "older",
        "v1.2.1",
        b"older runtime",
        true,
    );
    let service = PortcoveService::new_read_only(library).unwrap();
    let default = service.ensure_default_profile(port).unwrap();
    let modern = crate::retained_build::tests::install_fixture_port(
        service.library(),
        &catalog,
        port,
        "newer",
        "v1.2.2",
        b"newer runtime",
        true,
    );
    let mut recipe = service
        .export_profile_recipe(port, &default.id, None)
        .unwrap();
    service.library().rollback(port).unwrap();
    assert!(service.optional_deploy_layout(port).unwrap().is_none());
    assert_eq!(
        service
            .library()
            .status(port, crate::ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap()
            .id,
        old.id
    );

    let manifest = br#"{"game_id":"mm","id":"fixture_code","display_name":"Fixture Code","version":"1.0.0","authors":["fixture"],"minimum_recomp_version":"1.2.2"}"#;
    let name = "fixture_code.nrm";
    let package = o2r(
        temporary.path(),
        name,
        &[
            ("mod.json", manifest),
            ("mod_binary.bin", b"\0"),
            ("mod_syms.bin", b"\0"),
        ],
    );
    let bytes = fs::read(&package).unwrap();
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let size = bytes.len() as u64;
    let provider = ProviderPackageRef {
        provider: "thunderstore".into(),
        binding: None,
        project: "Fixture-Code".into(),
        file: Some("1.0.0".into()),
        version: Some("1.0.0".into()),
    };
    recipe.packages.push(RecipePackage {
        native_id: name.into(),
        native_version: Some("1.0.0".into()),
        provider: Some(provider.clone()),
        sha256: sha256.clone(),
        size,
        enabled: true,
        requires: Vec::new(),
        provider_requires: Vec::new(),
    });
    let recipe = sealed(recipe);
    let file = crate::ProviderFileCandidate {
        file_id: provider.file.clone().unwrap(),
        file_name: "provider.zip".into(),
        size,
        added_at: 1,
        download_url: "https://thunderstore.io/package/download/Fixture/Code/1.0.0/".into(),
        claimed_md5: None,
        archived: false,
        status_unknown: None,
        claimed_scan: None,
        thunderstore_dependencies: Some(Vec::new()),
    };
    let mut provider_plan = crate::ProviderInstallPlan {
        port_id: port.into(),
        profile_id: default.id.clone(),
        expected_revision: 3,
        review_nonce: None,
        provider: provider.clone(),
        project_name: "Fixture code".into(),
        file: file.clone(),
        download_sha256: sha256.clone(),
        download_size: size,
        members: vec![crate::PlanMember {
            file_name: name.into(),
            sha256: sha256.clone(),
            size,
            asset_count: 0,
            runs_code: vec![crate::RecompExecution::RecompiledCode],
        }],
        wrappers: vec![crate::ProviderWrapper {
            provider,
            file,
            download_sha256: sha256.clone(),
            download_size: size,
            members: BTreeMap::from([(name.into(), sha256.clone())]),
        }],
        ignored_entries: 0,
        replaces: Vec::new(),
        conflicts: Vec::new(),
        conflicts_truncated: false,
        unverified_claims: Vec::new(),
        plan_sha256: String::new(),
    };
    provider_plan.plan_sha256 = digest(&provider_plan).unwrap();
    let layout = service.layout_for_install(&modern).unwrap().unwrap();
    let directory = ProviderInstallMode::Recipe {
        identity: &recipe.identity_sha256,
        install_id: Some(&modern.id),
    }
    .staging(&layout, &provider_plan.plan_sha256);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(name), bytes).unwrap();
    let acquired = RecipeAcquisitionPlan {
        recipe_identity_sha256: recipe.identity_sha256.clone(),
        native_id: name.into(),
        provider_plan,
    };
    let plan = service
        .plan_recipe_import_with_acquisitions(&recipe, &[acquired])
        .unwrap();
    assert!(plan.can_apply, "{:?}", plan.holds);
    assert_eq!(plan.install_id.as_deref(), Some(modern.id.as_str()));
    assert_eq!(plan.code_approval.len(), 1);
    assert!(
        service
            .authorize_recipe_import(&plan, "Imported code")
            .is_err()
    );
    let authorization = service
        .authorize_recipe_import_allowing_code(&plan, "Imported code")
        .unwrap();
    let imported = service
        .apply_recipe_import(&plan, "Imported code", &authorization.token)
        .unwrap();
    let revisions = service.profile_revisions(port, &imported.id).unwrap();
    assert_eq!(revisions[0].build.install_id, modern.id);
    assert_eq!(revisions[0].packages[0].sha256, sha256);
    assert!(service.optional_deploy_layout(port).unwrap().is_none());
}

#[tokio::test]
async fn recipe_acquisition_uses_the_recipes_runtime_instead_of_the_reference_setup() {
    use crate::provider_client::ProviderClient;
    use crate::provider_install::ProviderInstallMode;

    let w = world();
    let service = &w.service;
    let port = "starship";
    let mut recipe = service
        .export_profile_recipe(port, &w.profile, None)
        .unwrap();
    recipe.packages[0].provider = Some(label("1", "2"));
    let recipe = sealed(recipe);
    let input = &recipe.packages[0];

    let reference = service.copy_profile(port, &w.profile, "Reference").unwrap();
    let other = crate::retained_build::tests::install(
        service.library(),
        "reference-build",
        b"another retained runtime",
        false,
    );
    service
        .create_profile_revision(
            port,
            &reference.id,
            &crate::ProfileRevisionRequest {
                expected_revision: reference.current_revision,
                install_id: Some(other.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    // The reference's installation identity changed outside the setup. The
    // runtime named in the recipe still exists and still verifies.
    service
        .library()
        .connection()
        .unwrap()
        .execute(
            "UPDATE installs SET artifact_sha256=?1 WHERE id=?2",
            (&"e".repeat(64), &other.id),
        )
        .unwrap();

    let layout = service.deploy_layout(port).unwrap();
    let stored = layout.package(&input.sha256, &input.native_id);
    let package = fs::read(&stored).unwrap();
    fs::remove_file(&stored).unwrap();
    let waiting = service.plan_recipe_import(&recipe).unwrap();
    assert!(!waiting.can_apply);
    assert_eq!(waiting.runtime.status, RecipeInputStatus::Available);
    assert_eq!(waiting.packages[0].status, RecipeInputStatus::Unavailable);
    assert_eq!(
        waiting.provider_checks.as_slice(),
        std::slice::from_ref(&input.native_id)
    );

    let wrapped = o2r(
        w._temporary.path(),
        "reviewed.zip",
        &[(input.native_id.as_str(), &package)],
    );
    let wrapper = fs::read(wrapped).unwrap();
    let response = |content_type: &str, bytes: &[u8]| {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        )
        .into_bytes();
        response.extend_from_slice(bytes);
        response
    };
    let project = serde_json::to_vec(&serde_json::json!({
        "_sName": "Reviewed fixture", "_aGame": {"_idRow": 777},
        "_tsDateUpdated": 3, "_bIsObsolete": false,
        "_aFiles": [{
            "_idRow": 2, "_sFile": "reviewed.zip", "_nFilesize": wrapper.len(),
            "_tsDateAdded": 2, "_bIsArchived": false,
        }],
    }))
    .unwrap();
    let (base, _requests, server) = crate::test_http::serve_http_bytes(vec![
        response("application/json", &project),
        b"HTTP/1.1 302 Found\r\nLocation: /files/reviewed.zip\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        response("application/zip", &wrapper),
    ]);
    let client = crate::GameBananaClient::with_roots(&base, None).unwrap();
    let client = ProviderClient::gamebanana(&client, port).unwrap();
    let normal = service
        .plan_provider_install_in_mode(
            &client,
            port,
            &reference.id,
            "1",
            "2",
            ProviderInstallMode::Reviewed,
        )
        .await
        .unwrap_err();
    assert_eq!(normal.code, ErrorCode::Conflict);
    let provider_plan = service
        .plan_provider_install_in_mode(
            &client,
            port,
            &reference.id,
            "1",
            "2",
            ProviderInstallMode::Recipe {
                identity: &recipe.identity_sha256,
                install_id: waiting.install_id.as_deref(),
            },
        )
        .await
        .unwrap();
    server.join().unwrap();
    let reviewed = service
        .plan_recipe_import_with_acquisitions(
            &recipe,
            &[RecipeAcquisitionPlan {
                recipe_identity_sha256: recipe.identity_sha256.clone(),
                native_id: input.native_id.clone(),
                provider_plan,
            }],
        )
        .unwrap();
    assert!(reviewed.can_apply, "{:?}", reviewed.holds);
    assert_eq!(reviewed.install_id, waiting.install_id);
    assert_ne!(reviewed.install_id.as_deref(), Some(other.id.as_str()));
    assert!(!stored.exists());
}

#[test]
fn exported_recipe_files_round_trip_through_the_bounded_reader() {
    let w = world();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("setup.json");
    let expected = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    w.service
        .write_profile_recipe("starship", &w.profile, &path)
        .unwrap();
    assert_eq!(ProfileRecipe::read_file(&path).unwrap(), expected);
    assert!(ProfileRecipe::read_file(directory.path()).is_err());
    let oversize = std::io::repeat(b' ').take((MAX_RECIPE_BYTES + 1) as u64);
    assert!(ProfileRecipe::read_document(oversize).is_err());
}

#[test]
fn authorizing_code_rejects_an_edited_approval_list_with_the_original_digest() {
    let w = world();
    let recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    let mut plan = w.service.plan_recipe_import(&recipe).unwrap();
    plan.code_approval = ["first", "second"]
        .iter()
        .map(|name| RecipeCodeApproval {
            native_id: format!("{name}.nrm"),
            sha256: "a".repeat(64),
            runs: vec![crate::RecompExecution::RecompiledCode],
        })
        .collect();
    plan.plan_sha256 = import_plan_digest(&plan).unwrap();
    assert!(
        w.service
            .authorize_recipe_import_allowing_code(&plan, "Shared")
            .is_ok()
    );

    plan.code_approval.pop();
    let error = w
        .service
        .authorize_recipe_import_allowing_code(&plan, "Shared")
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
}

/// Records staged steps as a review would after staging each of them.
fn record(
    service: &PortcoveService,
    recipe: &ProfileRecipe,
    acquisitions: &[RecipeAcquisitionPlan],
) {
    for acquisition in acquisitions {
        service
            .record_recipe_step(recipe, &acquisition.native_id, &acquisition.provider_plan)
            .unwrap();
    }
}

/// Adds `count` more packages to the world's default setup in one draft.
fn grow_setup(w: &World, count: usize) {
    let port = "starship";
    let connection = w.service.library().connection().unwrap();
    let current = profile::current_revision(&connection, port, &w.profile).unwrap();
    drop(connection);
    let scratch = w._temporary.path().join(format!("grow-{count}"));
    fs::create_dir_all(&scratch).unwrap();
    let local_files = (0..count)
        .map(|index| {
            let name = format!("grown-{index:04}.o2r");
            let asset = format!("objects/grown/{index:04}");
            let path = o2r(&scratch, &name, &[(asset.as_str(), b"grown")]);
            let review = w
                .service
                .plan_local_mod_package(port, &w.profile, &path, current.revision)
                .unwrap();
            crate::profile_deploy::LocalModDraftFile {
                path,
                expected_plan_sha256: review.plan_sha256,
            }
        })
        .collect();
    let edits = crate::ModSetupEdits {
        packages: vec![],
        order: None,
        local_files,
    };
    w.service
        .apply_mod_setup_draft(port, &w.profile, current.revision, &[], &edits, false)
        .unwrap();
}

/// Adds `count` exact packages to the world's default setup by placing their
/// bytes in the package store and saving one revision, as an earlier review
/// would have left them. Faster than `grow_setup`, which reviews each file as a
/// draft (that path has its own tests); use it where the setup is only the
/// starting state.
fn stored_setup(w: &World, count: usize) {
    let port = "starship";
    let layout = w.service.deploy_layout(port).unwrap();
    let current = w
        .service
        .profile_revisions(port, &w.profile)
        .unwrap()
        .pop()
        .unwrap();
    let scratch = w._temporary.path().join(format!("stored-{count}"));
    fs::create_dir_all(&scratch).unwrap();
    let mut packages = current.packages.clone();
    for index in 0..count {
        let name = format!("grown-{index:04}.o2r");
        let asset = format!("objects/grown/{index:04}");
        let bytes = fs::read(o2r(&scratch, &name, &[(asset.as_str(), b"grown")])).unwrap();
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let stored = layout.package(&sha256, &name);
        fs::create_dir_all(stored.parent().unwrap()).unwrap();
        fs::write(&stored, &bytes).unwrap();
        packages.push(crate::ResolvedPackage {
            native_id: name,
            native_version: None,
            provider: None,
            sha256,
            size: bytes.len() as u64,
            enabled: true,
            requires: Vec::new(),
            provider_requires: Vec::new(),
        });
    }
    w.service
        .create_profile_revision(
            port,
            &w.profile,
            &crate::ProfileRevisionRequest {
                expected_revision: current.revision,
                packages: Some(packages),
                ..Default::default()
            },
        )
        .unwrap();
}

/// A recipe whose packages after the first `stored` are all missing locally
/// and each staged privately as its own reviewed provider file.
fn staged_recipe(w: &World, stored: usize) -> (ProfileRecipe, Vec<RecipeAcquisitionPlan>) {
    use crate::provider_install::{ProviderInstallMode, digest};
    let mut recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    for (index, package) in recipe.packages.iter_mut().enumerate().skip(stored) {
        package.provider = Some(label(&(1000 + index).to_string(), "2"));
    }
    let recipe = sealed(recipe);
    let layout = w.service.deploy_layout("starship").unwrap();
    let acquisitions = recipe
        .packages
        .iter()
        .skip(stored)
        .map(|input| {
            let stored = layout.package(&input.sha256, &input.native_id);
            let bytes = fs::read(&stored).unwrap();
            fs::remove_file(&stored).unwrap();
            let provider = input.provider.clone().unwrap();
            let mut provider_plan = crate::ProviderInstallPlan {
                port_id: "starship".into(),
                profile_id: w.profile.clone(),
                expected_revision: 2,
                review_nonce: None,
                provider,
                project_name: "Reviewed fixture".into(),
                file: crate::ProviderFileCandidate {
                    file_id: "2".into(),
                    file_name: "fixture.zip".into(),
                    size: input.size,
                    added_at: 1,
                    download_url: "https://gamebanana.com/dl/2".into(),
                    claimed_md5: None,
                    archived: false,
                    status_unknown: None,
                    claimed_scan: None,
                    thunderstore_dependencies: None,
                },
                download_sha256: input.sha256.clone(),
                download_size: input.size,
                members: vec![crate::PlanMember {
                    file_name: input.native_id.clone(),
                    sha256: input.sha256.clone(),
                    size: input.size,
                    asset_count: 1,
                    runs_code: Vec::new(),
                }],
                wrappers: Vec::new(),
                ignored_entries: 0,
                replaces: Vec::new(),
                conflicts: Vec::new(),
                conflicts_truncated: false,
                unverified_claims: Vec::new(),
                plan_sha256: String::new(),
            };
            provider_plan.plan_sha256 = digest(&provider_plan).unwrap();
            let stage = ProviderInstallMode::Recipe {
                identity: &recipe.identity_sha256,
                install_id: None,
            }
            .staging(&layout, &provider_plan.plan_sha256);
            fs::create_dir_all(&stage).unwrap();
            fs::write(stage.join(&input.native_id), bytes).unwrap();
            RecipeAcquisitionPlan {
                recipe_identity_sha256: recipe.identity_sha256.clone(),
                native_id: input.native_id.clone(),
                provider_plan,
            }
        })
        .collect();
    (recipe, acquisitions)
}

#[test]
fn recipe_acquisitions_past_the_former_thirty_two_file_bound_resume_and_apply() {
    for missing in [33, 512] {
        let w = world();
        grow_setup(&w, missing);
        let (recipe, acquisitions) = staged_recipe(&w, 1);
        assert_eq!(acquisitions.len(), missing);
        let waiting = w.service.plan_recipe_import(&recipe).unwrap();
        assert_eq!(waiting.provider_checks.len(), missing);
        assert!(!waiting.can_apply);

        // Interrupted after the first half was staged and recorded: reopening
        // the recipe resumes with exactly those steps instead of the prefix again.
        let (done, rest) = acquisitions.split_at(missing / 2);
        record(&w.service, &recipe, done);
        let resumed = w.service.plan_recipe_import(&recipe).unwrap();
        assert_eq!(resumed.staging.acquisitions.len(), done.len());
        assert_eq!(resumed.provider_checks.len(), rest.len());
        assert_eq!(
            resumed.provider_checks,
            rest.iter()
                .map(|item| item.native_id.clone())
                .collect::<Vec<_>>()
        );

        record(&w.service, &recipe, rest);
        let ready = w.service.plan_recipe_import(&recipe).unwrap();
        assert!(ready.can_apply, "{:?}", ready.holds);
        assert_eq!(ready.staging.acquisitions.len(), missing);
        let token = w
            .service
            .authorize_recipe_import(&ready, "Shared")
            .unwrap()
            .token;
        let imported = w
            .service
            .apply_recipe_import(&ready, "Shared", &token)
            .unwrap();
        let history = w
            .service
            .profile_revisions("starship", &imported.id)
            .unwrap();
        assert_eq!(history[0].packages.len(), missing + 1);
        // The completed review leaves no record to resume.
        assert!(
            w.service
                .recorded_recipe_staging(&recipe)
                .unwrap()
                .acquisitions
                .is_empty()
        );
    }
}

#[test]
fn a_staged_step_that_changed_leaves_the_review_instead_of_repeating_as_ready() {
    let w = world();
    grow_setup(&w, 3);
    let (recipe, acquisitions) = staged_recipe(&w, 1);
    record(&w.service, &recipe, &acquisitions);
    let reviewed = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(reviewed.can_apply, "{:?}", reviewed.holds);
    let layout = w.service.deploy_layout("starship").unwrap();
    let changed = &acquisitions[1];
    let staged = crate::provider_install::ProviderInstallMode::Recipe {
        identity: &recipe.identity_sha256,
        install_id: None,
    }
    .staging(&layout, &changed.provider_plan.plan_sha256)
    .join(&changed.native_id);
    // Same size, different bytes: only the full check at apply can see it.
    let size = fs::metadata(&staged).unwrap().len() as usize;
    fs::write(&staged, vec![0u8; size]).unwrap();
    let token = w
        .service
        .authorize_recipe_import(&reviewed, "Shared")
        .unwrap()
        .token;
    let refused = w
        .service
        .apply_recipe_import(&reviewed, "Shared", &token)
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Conflict);
    // The next review shows that one package as missing; the others stay ready.
    let next = w.service.plan_recipe_import(&recipe).unwrap();
    assert_eq!(
        next.provider_checks.as_slice(),
        std::slice::from_ref(&changed.native_id)
    );
    assert_eq!(next.staging.acquisitions.len(), acquisitions.len() - 1);
}

#[test]
fn a_setup_past_the_former_package_bounds_round_trips_through_recipe_import() {
    for extra in [512, 1999] {
        let w = world();
        stored_setup(&w, extra);
        let source = w
            .service
            .profile_revisions("starship", &w.profile)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(source.packages.len(), extra + 1);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("setup.json");
        w.service
            .write_profile_recipe("starship", &w.profile, &path)
            .unwrap();
        let recipe = ProfileRecipe::read_file(&path).unwrap();
        assert_eq!(recipe.packages.len(), extra + 1);
        let (_, imported) = import(&w, recipe, "Copy");
        let copied = w
            .service
            .profile_revisions("starship", &imported.id)
            .unwrap();
        assert_eq!(copied[0].packages, source.packages);
        assert_eq!(copied[0].orderings, source.orderings);
    }
}

#[test]
fn a_recipe_beyond_the_shared_capacity_is_refused_on_inspection() {
    let w = world();
    let mut recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    let template = recipe.packages[0].clone();
    recipe.packages = (0..=crate::setup_capacity::MAX_SETUP_PACKAGES)
        .map(|index| RecipePackage {
            native_id: format!("mod-{index}.o2r"),
            enabled: false,
            ..template.clone()
        })
        .collect();
    recipe.orderings.clear();
    let recipe = sealed(recipe);
    assert_eq!(
        ProfileRecipe::inspect(&bytes(&recipe)).unwrap_err().code,
        ErrorCode::Verification
    );
}

/// Bytes under a directory, recursively.
fn tree_bytes(path: &Path) -> u64 {
    fs::read_dir(path).map_or(0, |entries| {
        entries
            .flatten()
            .map(|entry| {
                let metadata = entry.metadata().unwrap();
                if metadata.is_dir() {
                    tree_bytes(&entry.path())
                } else {
                    metadata.len()
                }
            })
            .sum()
    })
}

/// A recipe whose packages after the first are all members of ONE staged
/// provider plan, as a shared closure stages them. Only the first member is
/// recorded; the rest are found by reuse.
fn shared_closure_recipe(w: &World) -> (ProfileRecipe, crate::ProviderInstallPlan) {
    use crate::provider_install::{ProviderInstallMode, digest};
    let mut recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    for package in recipe.packages.iter_mut().skip(1) {
        package.provider = Some(label("1", "2"));
    }
    let recipe = sealed(recipe);
    let layout = w.service.deploy_layout("starship").unwrap();
    let members = recipe.packages.iter().skip(1).collect::<Vec<_>>();
    let mut provider_plan = crate::ProviderInstallPlan {
        port_id: "starship".into(),
        profile_id: w.profile.clone(),
        expected_revision: 2,
        review_nonce: None,
        provider: label("1", "2"),
        project_name: "Shared closure fixture".into(),
        file: crate::ProviderFileCandidate {
            file_id: "2".into(),
            file_name: "fixture.zip".into(),
            size: 1,
            added_at: 1,
            download_url: "https://gamebanana.com/dl/2".into(),
            claimed_md5: None,
            archived: false,
            status_unknown: None,
            claimed_scan: None,
            thunderstore_dependencies: None,
        },
        download_sha256: "d".repeat(64),
        download_size: 1,
        members: members
            .iter()
            .map(|input| crate::PlanMember {
                file_name: input.native_id.clone(),
                sha256: input.sha256.clone(),
                size: input.size,
                asset_count: 1,
                runs_code: Vec::new(),
            })
            .collect(),
        wrappers: Vec::new(),
        ignored_entries: 0,
        replaces: Vec::new(),
        conflicts: Vec::new(),
        conflicts_truncated: false,
        unverified_claims: Vec::new(),
        plan_sha256: String::new(),
    };
    provider_plan.plan_sha256 = digest(&provider_plan).unwrap();
    let stage = ProviderInstallMode::Recipe {
        identity: &recipe.identity_sha256,
        install_id: None,
    }
    .staging(&layout, &provider_plan.plan_sha256);
    fs::create_dir_all(&stage).unwrap();
    for input in members {
        let stored = layout.package(&input.sha256, &input.native_id);
        fs::rename(&stored, stage.join(&input.native_id)).unwrap();
    }
    (recipe, provider_plan)
}

#[tokio::test]
async fn a_shared_closure_costs_its_plan_once_in_records_and_the_review() {
    let w = world();
    let members = 300;
    grow_setup(&w, members);
    let (recipe, provider_plan) = shared_closure_recipe(&w);
    let first = recipe.packages[1].native_id.clone();
    w.service
        .record_recipe_step(&recipe, &first, &provider_plan)
        .unwrap();
    let waiting = w.service.plan_recipe_import(&recipe).unwrap();
    assert_eq!(waiting.staging.acquisitions.len(), 1);
    assert_eq!(waiting.provider_checks.len(), members - 1);

    // Every other member is staged by reuse: no download, no plan copy.
    let batch = w
        .service
        .acquire_recipe_packages(&waiting, &w.profile)
        .await
        .unwrap();
    assert_eq!(batch.failure, None);
    assert_eq!(batch.acquired.len(), members - 1);
    let ready = batch.plan;
    assert!(ready.can_apply, "{:?}", ready.holds);
    assert!(ready.provider_checks.is_empty());
    assert_eq!(ready.staging.acquisitions.len(), members);
    assert_eq!(ready.staging.provider_plans.len(), 1);

    // Linear, not quadratic: the plan once plus a small reference per member,
    // in the review that crosses IPC and in the durable records.
    let plan_bytes = serde_json::to_vec(&provider_plan).unwrap().len() as u64;
    let per_member = 512;
    let review_bytes = serde_json::to_vec(&ready).unwrap().len() as u64;
    let without_staging = {
        let mut copy = ready.clone();
        copy.staging = RecipeStaging::default();
        serde_json::to_vec(&copy).unwrap().len() as u64
    };
    assert!(
        review_bytes - without_staging <= plan_bytes + per_member * members as u64,
        "review staging {} bytes for a {plan_bytes}-byte plan",
        review_bytes - without_staging
    );
    let records = w
        .service
        .acquisition_records("starship", &recipe.identity_sha256);
    assert!(
        tree_bytes(&records) <= plan_bytes + per_member * members as u64,
        "records {} bytes for a {plan_bytes}-byte plan",
        tree_bytes(&records)
    );

    // A restart resumes the same review from the records.
    let resumed = w.service.plan_recipe_import(&recipe).unwrap();
    assert_eq!(resumed.staging.acquisitions.len(), members);
    assert_eq!(
        resumed.staging.provider_plans.as_slice(),
        std::slice::from_ref(&provider_plan)
    );
    assert_eq!(resumed.plan_sha256, ready.plan_sha256);
    let token = w
        .service
        .authorize_recipe_import(&resumed, "Shared")
        .unwrap()
        .token;
    let imported = w
        .service
        .apply_recipe_import(&resumed, "Shared", &token)
        .unwrap();
    let history = w
        .service
        .profile_revisions("starship", &imported.id)
        .unwrap();
    assert_eq!(history[0].packages.len(), members + 1);
}

#[test]
fn a_review_past_its_working_set_budget_is_refused_by_name() {
    let refused = require_review_budget(MAX_RECIPE_REVIEW_BYTES + 1).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Unsupported);
    assert!(
        refused.message.contains("review budget"),
        "{}",
        refused.message
    );
    require_review_budget(MAX_RECIPE_REVIEW_BYTES).unwrap();
}

#[test]
fn a_recorded_review_survives_staging_pruning_while_it_is_resumed() {
    let w = world();
    grow_setup(&w, 3);
    let (recipe, acquisitions) = staged_recipe(&w, 1);
    record(&w.service, &recipe, &acquisitions);
    let layout = w.service.deploy_layout("starship").unwrap();
    let recipe_root = layout.store().join("recipe-staged");
    let review = recipe_root.join(&recipe.identity_sha256);
    let day_and_more = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 60 * 60);
    let age_everything = || {
        for entry in fs::read_dir(&review).unwrap().flatten() {
            set_directory_modified(&entry.path(), day_and_more);
        }
        set_directory_modified(&review, day_and_more);
    };

    // Paused for more than a day, then reopened: reopening refreshes it before
    // any later staging prunes, so nothing is downloaded again.
    age_everything();
    let reopened = w.service.plan_recipe_import(&recipe).unwrap();
    assert_eq!(reopened.staging.acquisitions.len(), acquisitions.len());
    w.service.prune_recipe_reviews(&recipe_root);
    w.service.prune_staged(&review);
    assert_eq!(
        w.service
            .plan_recipe_import(&recipe)
            .unwrap()
            .staging
            .acquisitions
            .len(),
        acquisitions.len()
    );

    // Not reopened, while another recipe stages: a review with recorded steps
    // is kept as resumable work.
    age_everything();
    w.service.prune_recipe_reviews(&recipe_root);
    assert!(review.exists());

    // An abandoned review without records is pruned as before.
    let abandoned = recipe_root.join("a".repeat(64));
    fs::create_dir_all(abandoned.join("plan")).unwrap();
    set_directory_modified(&abandoned, day_and_more);
    w.service.prune_recipe_reviews(&recipe_root);
    assert!(!abandoned.exists());
}

#[test]
fn a_review_in_the_earlier_full_copy_shape_reads_and_asks_for_a_fresh_review() {
    let w = world();
    grow_setup(&w, 3);
    let (recipe, acquisitions) = staged_recipe(&w, 1);
    record(&w.service, &recipe, &acquisitions);
    let reviewed = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(reviewed.can_apply, "{:?}", reviewed.holds);
    assert!(!reviewed.staging.acquisitions.is_empty());

    // The shape reviews and CLI plan files had before plans were held once:
    // every acquisition carries its own copy of its provider plan.
    let mut earlier = serde_json::to_value(&reviewed).unwrap();
    let object = earlier.as_object_mut().unwrap();
    object.remove("provider_plans");
    object["acquisitions"] = serde_json::Value::Array(
        reviewed
            .staging
            .acquisitions
            .iter()
            .map(|reference| {
                serde_json::to_value(RecipeAcquisitionPlan {
                    recipe_identity_sha256: recipe.identity_sha256.clone(),
                    native_id: reference.native_id.clone(),
                    provider_plan: reviewed
                        .staging
                        .plan(&reference.plan_sha256)
                        .unwrap()
                        .clone(),
                })
                .unwrap()
            })
            .collect(),
    );
    let earlier_bytes = serde_json::to_vec(&earlier).unwrap();
    earlier["plan_sha256"] = hex::encode(sha2::Sha256::digest(&earlier_bytes)).into();

    let read: RecipeImportPlan = serde_json::from_value(earlier).unwrap();
    assert_eq!(read.staging.acquisitions, reviewed.staging.acquisitions);
    let mut plans = read.staging.provider_plans.clone();
    let mut expected = reviewed.staging.provider_plans.clone();
    plans.sort_by(|a, b| a.plan_sha256.cmp(&b.plan_sha256));
    expected.sort_by(|a, b| a.plan_sha256.cmp(&b.plan_sha256));
    assert_eq!(plans, expected);
    // Its digest covered the earlier shape, so approval needs a fresh review.
    let error = w
        .service
        .apply_recipe_import(&read, "Copy", "unused")
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict, "{error:?}");
    assert!(
        error.message.contains("review the recipe again"),
        "{error:?}"
    );
    // The fresh review of the same recipe is the current one.
    assert_eq!(
        w.service.plan_recipe_import(&recipe).unwrap().plan_sha256,
        reviewed.plan_sha256
    );
}

#[test]
fn a_chain_of_requirements_is_staged_dependants_first() {
    let w = world();
    grow_setup(&w, 4);
    let mut recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    // grown-0000 requires grown-0001, which requires grown-0002, and so on:
    // a closure install stores them dependency-first, so the recipe and its
    // provider checks list them in that order.
    let chain = (0..4)
        .map(|index| format!("grown-{index:04}.o2r"))
        .collect::<Vec<_>>();
    for pair in chain.windows(2) {
        let required = recipe
            .packages
            .iter()
            .find(|package| package.native_id == pair[1])
            .unwrap()
            .clone();
        let dependant = recipe
            .packages
            .iter_mut()
            .find(|package| package.native_id == pair[0])
            .unwrap();
        dependant.provider_requires = vec![crate::ProviderRequirement {
            provider: label("1", &pair[1]),
            members: [(required.native_id.clone(), required.sha256.clone())].into(),
        }];
    }
    let checks = chain.iter().rev().cloned().collect::<Vec<_>>();
    // The root goes first; its plan stages the whole chain, so every
    // requirement after it is reused instead of downloaded again inside
    // each dependant's closure (n downloads, not n(n+1)/2).
    assert_eq!(dependants_first(&recipe, &checks), chain);
    // Unrelated packages keep their order, and a cycle cannot drop any.
    let unrelated = vec!["hd-link.o2r".to_owned(), chain[0].clone()];
    assert_eq!(dependants_first(&recipe, &unrelated), unrelated);
    let first = chain[0].clone();
    let last = chain[3].clone();
    let tail = recipe
        .packages
        .iter()
        .find(|package| package.native_id == first)
        .unwrap()
        .clone();
    recipe
        .packages
        .iter_mut()
        .find(|package| package.native_id == last)
        .unwrap()
        .provider_requires = vec![crate::ProviderRequirement {
        provider: label("1", &first),
        members: [(tail.native_id.clone(), tail.sha256.clone())].into(),
    }];
    let mut cyclic = dependants_first(&recipe, &checks);
    cyclic.sort();
    let mut expected = checks.clone();
    expected.sort();
    assert_eq!(cyclic, expected);
}

#[test]
fn a_dangling_plan_reference_is_refused_and_a_tampered_plan_record_is_dropped() {
    let w = world();
    grow_setup(&w, 3);
    let (recipe, acquisitions) = staged_recipe(&w, 1);
    record(&w.service, &recipe, &acquisitions);
    let reviewed = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(reviewed.can_apply, "{:?}", reviewed.holds);

    // A review whose reference names no plan (as an edited IPC copy could)
    // is refused even with a digest recomputed to match it.
    let mut dangling = reviewed.clone();
    dangling.staging.provider_plans.remove(0);
    dangling.plan_sha256 = import_plan_digest(&dangling).unwrap();
    let error = w
        .service
        .apply_recipe_import(&dangling, "Dangling", "unused")
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict, "{error:?}");
    assert!(
        error.message.contains("names no provider review"),
        "{error:?}"
    );

    // A plan record edited on disk no longer matches its digest: it is
    // dropped, never trusted, and its package is offered for checking again.
    let records = w
        .service
        .acquisition_records("starship", &recipe.identity_sha256);
    let tampered = acquisitions[0].provider_plan.plan_sha256.clone();
    let path = records.join("plans").join(format!("{tampered}.json"));
    let mut plan: crate::ProviderInstallPlan =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    plan.project_name.push_str(" (edited)");
    fs::write(&path, serde_json::to_vec(&plan).unwrap()).unwrap();
    let resumed = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(!resumed.can_apply);
    assert!(
        resumed.provider_checks.contains(&acquisitions[0].native_id),
        "{:?}",
        resumed.provider_checks
    );
    assert!(
        resumed
            .staging
            .provider_plans
            .iter()
            .all(|plan| plan.plan_sha256 != tampered)
    );
}

/// A recipe whose packages after the first are missing from the package store
/// and offered by their own GameBanana files, with the responses that serve
/// them in order (project, download redirect, file).
fn served_recipe(w: &World, missing: usize) -> (ProfileRecipe, Vec<Vec<u8>>) {
    grow_setup(w, missing);
    let mut recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    for (index, package) in recipe.packages.iter_mut().enumerate().skip(1) {
        package.provider = Some(label(
            &(100 + index).to_string(),
            &(200 + index).to_string(),
        ));
    }
    let recipe = sealed(recipe);
    let layout = w.service.deploy_layout("starship").unwrap();
    let response = |content_type: &str, bytes: &[u8]| {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        )
        .into_bytes();
        response.extend_from_slice(bytes);
        response
    };
    let mut responses = Vec::new();
    for (index, package) in recipe.packages.iter().enumerate().skip(1) {
        let stored = layout.package(&package.sha256, &package.native_id);
        let bytes = fs::read(&stored).unwrap();
        fs::remove_file(&stored).unwrap();
        let name = format!("wrapper-{index}.zip");
        let wrapper = fs::read(o2r(
            w._temporary.path(),
            &name,
            &[(package.native_id.as_str(), &bytes)],
        ))
        .unwrap();
        let project = serde_json::to_vec(&serde_json::json!({
            "_sName": format!("Served fixture {index}"), "_aGame": {"_idRow": 777},
            "_tsDateUpdated": 3, "_bIsObsolete": false,
            "_aFiles": [{
                "_idRow": 200 + index, "_sFile": name, "_nFilesize": wrapper.len(),
                "_tsDateAdded": 2, "_bIsArchived": false,
            }],
        }))
        .unwrap();
        responses.push(response("application/json", &project));
        responses.push(
            format!("HTTP/1.1 302 Found\r\nLocation: /files/{name}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes(),
        );
        responses.push(response("application/zip", &wrapper));
    }
    (recipe, responses)
}

#[tokio::test]
async fn a_review_budget_refusal_while_acquiring_keeps_earlier_progress() {
    // The size of each staged plan, measured on an identical review.
    let plan_bytes = {
        let w = world();
        let (recipe, responses) = served_recipe(&w, 2);
        let (root, _requests, server) = crate::test_http::serve_http_bytes(responses);
        let _served = crate::GameBananaClient::serve_library_clients_from(&root);
        let waiting = w.service.plan_recipe_import(&recipe).unwrap();
        let batch = w
            .service
            .acquire_recipe_packages(&waiting, &w.profile)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(batch.failure, None);
        assert!(batch.plan.can_apply, "{:?}", batch.plan.holds);
        batch
            .plan
            .staging
            .provider_plans
            .iter()
            .map(|plan| serde_json::to_vec(plan).unwrap().len())
            .collect::<Vec<_>>()
    };
    assert_eq!(plan_bytes.len(), 2);

    // A budget with room for the first plan but not both.
    let w = world();
    let (recipe, responses) = served_recipe(&w, 2);
    let (root, _requests, server) = crate::test_http::serve_http_bytes(responses);
    let _served = crate::GameBananaClient::serve_library_clients_from(&root);
    let waiting = w.service.plan_recipe_import(&recipe).unwrap();
    let batch = {
        let _budget = override_review_budget(plan_bytes[0] + plan_bytes[1] - 64);
        w.service
            .acquire_recipe_packages(&waiting, &w.profile)
            .await
            .unwrap()
    };
    server.join().unwrap();
    let first = recipe.packages[1].native_id.clone();
    let second = recipe.packages[2].native_id.clone();
    assert_eq!(batch.acquired.as_slice(), std::slice::from_ref(&first));
    let failure = batch.failure.unwrap();
    assert_eq!(failure.native_id, second);
    assert!(failure.message.contains("review budget"), "{failure:?}");
    assert_eq!(batch.plan.staging.acquisitions.len(), 1);
    assert_eq!(
        batch.plan.provider_checks.as_slice(),
        std::slice::from_ref(&second)
    );

    // The staged step was recorded: reopening the recipe resumes with it.
    let resumed = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(resumed.staging.contains(&first));
    assert_eq!(resumed.provider_checks, [second]);
}

#[test]
fn reviewing_and_applying_a_large_recipe_reads_the_port_history_once_not_per_package() {
    let w = world();
    let packages = 300;
    grow_setup(&w, packages);
    let recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    let revisions = w
        .service
        .profile_revisions("starship", &w.profile)
        .unwrap()
        .len();
    let decoded = |run: &dyn Fn()| {
        profile::DECODED_RECORDS.with(|count| count.set(0));
        run();
        profile::DECODED_RECORDS.with(std::cell::Cell::get)
    };
    // Provider evidence for every package comes from one pass over the
    // port's history, so the records read follow the history, not the
    // number of packages times the history.
    let bound = 4 * revisions + 16;
    let plan = std::cell::RefCell::new(None);
    let reviewed = decoded(&|| {
        *plan.borrow_mut() = Some(w.service.plan_recipe_import(&recipe).unwrap());
    });
    assert!(
        reviewed <= bound,
        "{reviewed} records for {packages} packages"
    );
    let plan = plan.into_inner().unwrap();
    assert!(plan.can_apply, "{:?}", plan.holds);
    let token = w
        .service
        .authorize_recipe_import(&plan, "Copy")
        .unwrap()
        .token;
    let applied = decoded(&|| {
        w.service
            .apply_recipe_import(&plan, "Copy", &token)
            .unwrap();
    });
    assert!(
        applied <= 2 * bound,
        "{applied} records for {packages} packages"
    );
}

#[test]
fn the_digest_scan_finds_a_digest_wherever_a_substring_search_would() {
    let digest = "ab".repeat(32);
    let wanted = std::collections::HashSet::from([digest.as_str()]);
    assert!(profile::names_any_digest(
        &format!("{{\"sha256\":\"{digest}\"}}"),
        &wanted
    ));
    // Inside a longer hex run, as `instr` would also match.
    assert!(profile::names_any_digest(&format!("0{digest}1"), &wanted));
    assert!(!profile::names_any_digest(&"ab".repeat(31), &wanted));
    assert!(!profile::names_any_digest(&"cd".repeat(40), &wanted));
}
