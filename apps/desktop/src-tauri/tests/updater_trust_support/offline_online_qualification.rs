//! Explicit consumption of public producer output after private-store teardown.

use super::*;
use std::path::PathBuf;

#[tokio::test]
#[ignore = "explicit retained disposable offline/online producer packet"]
async fn qualification_host_consumes_offline_bootstrap_online_generations() {
    let root = PathBuf::from(
        std::env::var_os("PORTCOVE_TUF_ONLINE_QUALIFICATION_OUTPUT")
            .expect("explicit producer packet required"),
    );
    assert!(root.is_absolute());
    let teardown: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("producer-teardown.json")).unwrap()).unwrap();
    assert_eq!(teardown["removed"], true);
    assert_eq!(teardown["qualification_only"], true);
    assert!(!Path::new(teardown["private_store"].as_str().unwrap()).exists());
    for variable in [
        "TAURI_SIGNING_PRIVATE_KEY",
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ] {
        assert!(
            std::env::var_os(variable).is_none(),
            "consumer must not inherit signing material"
        );
    }
    let state = root.join("consumer-state");
    fs::create_dir(&state).expect("consumer state must be fresh");
    let trusted = fs::read(root.join("trusted-root.json")).unwrap();
    let mut observations = Vec::new();
    let mut refusals = Vec::new();
    for (target, package) in [("windows-x86_64", "nsis"), ("linux-x86_64", "appimage")] {
        let state = state.join(target);
        let mut context = installed_context();
        context.current_version = "0.3.0".into();
        context.target = target.into();
        context.package_kind = package.into();
        if package == "appimage" {
            context.os = "linux".into();
            context.os_version = "6.1.0".into();
            context.execution_context = "user-owned-appimage".into();
        }
        for (generation, version) in [(1, "1.0.0"), (2, "1.1.0"), (3, "1.2.0")] {
            let output = root.join(format!("online-{generation}"));
            let repository = load_trusted_repository(TrustedRepositoryRequest {
                bundled_root: &trusted,
                metadata_base_url: Url::from_directory_path(output.join("metadata")).unwrap(),
                targets_base_url: Url::from_directory_path(output.join("targets")).unwrap(),
                state_directory: &state,
            })
            .await
            .unwrap();
            assert_eq!(repository.versions.targets, 1);
            assert_eq!(repository.versions.timestamp, generation);
            for channel in [ApplicationChannel::Preview, ApplicationChannel::Stable] {
                let selected = select_repository_candidate(&repository, channel, &context)
                    .await
                    .unwrap();
                assert_eq!(selected.selection.state, CandidateState::UpdateAvailable);
                assert!(selected.selection.reasons.is_empty());
                assert_eq!(
                    selected.selection.candidate.unwrap().release.version,
                    version
                );
                assert!(selected.payload_key.is_some());
                observations.push(serde_json::json!({"generation":generation,"version":version,"target":target,"package":package,"channel":channel,"targets_version":1}));
            }
        }
        let old = root.join("online-1");
        let refused = load_trusted_repository(TrustedRepositoryRequest {
            bundled_root: &trusted,
            metadata_base_url: Url::from_directory_path(old.join("metadata")).unwrap(),
            targets_base_url: Url::from_directory_path(old.join("targets")).unwrap(),
            state_directory: &state,
        })
        .await
        .unwrap_err();
        assert_eq!(refused.failure_kind(), TrustedRepositoryFailureKind::Stale);
        refusals.push(serde_json::json!({"target":target,"replayed_generation":1,"retained_generation":3,"error":refused.to_string()}));
        assert_consumer_rejected_timestamp_replay(ApplicationUpdateFreshSelectionError::Candidate(
            CandidateLoadError::Trust(refused),
        ));
    }
    fs::write(root.join("consumer-observations.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "qualification_only":true,"private_store_absence_observed":true,
        "observations":observations,"refusals":refusals,"replay_refused_for_both_contexts":true,
        "limits":"Rust host consumer fixture on Windows; Linux context is synthetic, no runtime/package/publication proof"
    })).unwrap()).unwrap();
}
