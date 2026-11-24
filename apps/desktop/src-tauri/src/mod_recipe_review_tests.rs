use crate::desktop_contract::RecipeImportReview;
use portcove_core::{
    ArtifactIdentity, ErrorCode, Library, LoaderContractRef, Platform, PortcoveService,
    ProfileRecipe, RecipeCodeApproval, RecipeImportPlan, RecipeInputPlan, RecipeInputStatus,
    RecipeModSetting, RecipeModSettingValue, RecipePackage, RecipeRuntime, RecompExecution,
};
use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

fn sealed_plan(format: u32) -> RecipeImportPlan {
    let numeric_values = [
        Number::from_f64(2048.0).unwrap(),
        Number::from(2048),
        Number::from(9_007_199_254_740_993_u64),
        Number::from_f64(-0.0).unwrap(),
        Number::from_f64(0.125).unwrap(),
        Number::from(u64::MAX),
        Number::from(i64::MIN),
    ];
    let mut settings = numeric_values
        .into_iter()
        .enumerate()
        .map(|(index, value)| RecipeModSetting {
            native_id: "numbers.nrm".into(),
            package_sha256: "a".repeat(64),
            option_id: format!("option_{index}"),
            value: RecipeModSettingValue::Number(value),
        })
        .collect::<Vec<_>>();
    settings.push(RecipeModSetting {
        native_id: "numbers.nrm".into(),
        package_sha256: "a".repeat(64),
        option_id: "choice".into(),
        value: RecipeModSettingValue::Choice("Classic".into()),
    });
    if format == 1 {
        settings.clear();
    }
    let mut recipe = ProfileRecipe {
        format,
        port_id: "zelda64-recomp".into(),
        runtime: RecipeRuntime {
            artifact: ArtifactIdentity {
                asset_name: "fixture-runtime.zip".into(),
                sha256: "b".repeat(64),
                size: 9_007_199_254_740_993,
            },
            runtime: None,
            definition: None,
            installed_contract_sha256: "c".repeat(64),
            platform: Platform::WindowsX86_64,
        },
        loader: Some(LoaderContractRef {
            id: "n64-recomp".into(),
            version: "1".into(),
        }),
        originals: Vec::new(),
        packages: vec![RecipePackage {
            native_id: "numbers.nrm".into(),
            native_version: Some("1.0.0".into()),
            provider: None,
            sha256: "a".repeat(64),
            size: 1,
            enabled: true,
            requires: Vec::new(),
            provider_requires: Vec::new(),
        }],
        orderings: Vec::new(),
        settings,
        uncaptured: vec!["fixture identity only".into()],
        identity_sha256: String::new(),
    };
    // Match the established Core seals; the transport must not replace them.
    recipe.identity_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&recipe).unwrap()));
    let mut plan = RecipeImportPlan {
        recipe,
        runtime: RecipeInputPlan {
            name: "fixture-runtime.zip".into(),
            status: RecipeInputStatus::Available,
            detail: "fixture only".into(),
        },
        install_id: Some("fixture-install".into()),
        originals: Vec::new(),
        verified_originals: Vec::new(),
        packages: Vec::new(),
        staging: Default::default(),
        provider_checks: Vec::new(),
        code_approval: vec![RecipeCodeApproval {
            native_id: "numbers.nrm".into(),
            sha256: "a".repeat(64),
            runs: vec![RecompExecution::RecompiledCode],
        }],
        holds: Vec::new(),
        can_apply: true,
        plan_sha256: String::new(),
    };
    plan.plan_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&plan).unwrap()));
    plan
}

#[test]
fn recipe_review_preserves_historical_seals_and_exact_numeric_display() {
    for format in [1, 2, 3] {
        let plan = sealed_plan(format);
        let original = serde_json::to_string(&plan).unwrap();
        let review = RecipeImportReview::new(plan.clone()).unwrap();
        assert_eq!(review.serialized_plan, original);
        if format == 1 {
            assert!(review.setting_values.is_empty());
        } else {
            assert_eq!(
                review.setting_values,
                [
                    "2048.0",
                    "2048",
                    "9007199254740993",
                    "-0.0",
                    "0.125",
                    "18446744073709551615",
                    "-9223372036854775808",
                    "Classic",
                ]
            );
        }
        // The outer IPC JSON encodes the plan as a string, not JavaScript numbers.
        let envelope: Value =
            serde_json::from_str(&serde_json::to_string(&review).unwrap()).unwrap();
        let serialized_plan = envelope["serialized_plan"].as_str().unwrap();
        let decoded = RecipeImportReview::decode(serialized_plan).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), original);
        assert_eq!(decoded.recipe.identity_sha256, plan.recipe.identity_sha256);
        assert_eq!(decoded.plan_sha256, plan.plan_sha256);
        assert_eq!(decoded.recipe.runtime.artifact.size, 9_007_199_254_740_993);
        assert_eq!(
            ProfileRecipe::inspect(&serde_json::to_vec(&decoded.recipe).unwrap()).unwrap(),
            plan.recipe
        );
    }
}

#[test]
fn edited_serialized_recipe_review_still_requires_existing_core_integrity_and_consent() {
    let temporary = tempfile::tempdir().unwrap();
    let service =
        PortcoveService::new_read_only(Library::open(temporary.path().join("library")).unwrap())
            .unwrap();
    let review = RecipeImportReview::new(sealed_plan(3)).unwrap();
    let decoded = RecipeImportReview::decode(&review.serialized_plan).unwrap();
    assert_eq!(
        service
            .authorize_recipe_import(&decoded, "Imported")
            .unwrap_err()
            .code,
        ErrorCode::Usage
    );
    service
        .authorize_recipe_import_allowing_code(&decoded, "Imported")
        .unwrap();

    let changed = review
        .serialized_plan
        .replacen(r#""value":2048.0"#, r#""value":2049.0"#, 1);
    assert_ne!(changed, review.serialized_plan);
    let edited = RecipeImportReview::decode(&changed).unwrap();
    assert_eq!(
        service
            .authorize_recipe_import_allowing_code(&edited, "Imported")
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        ProfileRecipe::inspect(&serde_json::to_vec(&edited.recipe).unwrap())
            .unwrap_err()
            .code,
        ErrorCode::Verification
    );
    assert!(RecipeImportReview::decode("not JSON").is_err());
}

#[test]
fn the_display_copy_carries_no_provider_plans_and_the_serialized_plan_carries_each_once() {
    let mut plan = sealed_plan(3);
    let provider_plan = portcove_core::ProviderInstallPlan {
        port_id: "zelda64-recomp".into(),
        profile_id: "review".into(),
        review_nonce: None,
        expected_revision: 1,
        provider: portcove_core::ProviderPackageRef {
            binding: None,
            provider: "gamebanana".into(),
            project: "1".into(),
            file: Some("2".into()),
            version: None,
        },
        project_name: "Shared closure display fixture".into(),
        file: portcove_core::ProviderFileCandidate {
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
        members: Vec::new(),
        wrappers: Vec::new(),
        ignored_entries: 0,
        replaces: Vec::new(),
        conflicts: Vec::new(),
        conflicts_truncated: false,
        unverified_claims: Vec::new(),
        plan_sha256: "e".repeat(64),
    };
    plan.staging.provider_plans.push(provider_plan);
    plan.staging.acquisitions = ["first.nrm", "second.nrm"]
        .into_iter()
        .map(|native_id| portcove_core::RecipeAcquisitionRef {
            native_id: native_id.into(),
            plan_sha256: "e".repeat(64),
        })
        .collect();
    let review = RecipeImportReview::new(plan.clone()).unwrap();
    assert!(review.plan.staging.provider_plans.is_empty());
    assert_eq!(review.plan.staging.acquisitions, plan.staging.acquisitions);
    let envelope = serde_json::to_string(&review).unwrap();
    assert_eq!(
        envelope.matches("Shared closure display fixture").count(),
        1,
        "the plan crosses IPC once, inside the serialized plan"
    );
    let decoded = RecipeImportReview::decode(&review.serialized_plan).unwrap();
    assert_eq!(decoded.staging, plan.staging);
}
