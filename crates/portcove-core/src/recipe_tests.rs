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

struct World {
    _temporary: tempfile::TempDir,
    service: PortcoveService,
    profile: String,
}

fn world() -> World {
    let (temporary, service, _first) = fixture();
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
    assert_eq!(recipe.format, 1);
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
    future["format"] = serde_json::json!(2);
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
    let round_trip = w
        .service
        .export_profile_recipe("starship", &imported.id, None)
        .unwrap();
    assert_eq!(round_trip.identity_sha256, recipe.identity_sha256);
    assert_eq!(round_trip, recipe);
    // The copy has its own progress; the original profile is untouched.
    let connection = w.service.library().connection().unwrap();
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
        provider: "gamebanana".into(),
        project: "1".into(),
        file: Some("2".into()),
        version: None,
    });
    let plan = w
        .service
        .plan_recipe_import(&sealed(missing.clone()))
        .unwrap();
    assert_eq!(plan.packages[0].status, RecipeInputStatus::Acquirable);
    assert!(plan.packages[0].detail.contains("project 1, file 2"));
    // Only a complete GameBanana file reference for a bound game can be planned.
    for provider in [
        ProviderPackageRef {
            provider: "gamebanana".into(),
            project: "1".into(),
            file: None,
            version: None,
        },
        ProviderPackageRef {
            provider: "elsewhere".into(),
            project: "1".into(),
            file: Some("2".into()),
            version: None,
        },
        ProviderPackageRef {
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
    });
    let plan = w.service.plan_recipe_import(&sealed(foreign)).unwrap();
    assert!(!plan.can_apply);
    assert!(
        plan.holds
            .iter()
            .any(|hold| hold.contains("not an input this game uses"))
    );
    let mut original = recipe;
    original.originals.push(RecipeOriginal {
        requirement_id: "star-fox-64".into(),
        sha256: "c".repeat(64),
        size: 5,
    });
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
fn acquirable_detail_names_the_canonical_provider_file() {
    let w = world();
    let mut recipe = w
        .service
        .export_profile_recipe("starship", &w.profile, None)
        .unwrap();
    recipe.packages[0].sha256 = "d".repeat(64);
    recipe.packages[0].provider = Some(label("+01", "2"));
    let plan = w.service.plan_recipe_import(&sealed(recipe)).unwrap();
    assert_eq!(plan.packages[0].status, RecipeInputStatus::Acquirable);
    assert!(plan.packages[0].detail.contains("project 1, file 2"));
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
