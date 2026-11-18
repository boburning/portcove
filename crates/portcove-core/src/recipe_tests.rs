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
    long.runtime.artifact.asset_name = "x".repeat(300);
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
        byte_budget: 0,
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

    #[cfg(unix)]
    {
        let replacement = w._temporary.path().join("otherwise-matching.o2r");
        fs::write(&replacement, &original).unwrap();
        fs::remove_file(&staged).unwrap();
        std::os::unix::fs::symlink(&replacement, &staged).unwrap();
        assert!(
            w.service
                .apply_recipe_import(&reviewed, "Shared", &approval.token)
                .is_err()
        );
        assert!(!stored.exists());
        fs::remove_file(&staged).unwrap();
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
    assert_eq!(waiting.provider_checks, [input.native_id.clone()]);

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
                byte_budget: MAX_ACQUISITION_BYTES,
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
