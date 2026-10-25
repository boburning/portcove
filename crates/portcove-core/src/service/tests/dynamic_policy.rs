use super::*;
use crate::ReleaseAsset;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Provider {
    release: ResolvedRelease,
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl ReleaseProvider for Provider {
    async fn resolve(
        &self,
        _: &PortDefinition,
        _: ReleaseChannel,
        _: Platform,
    ) -> Result<ResolvedRelease> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.release.clone())
    }
}

#[tokio::test]
async fn unscoped_dynamic_policy_review_rechecks_provider_before_installation() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let id = "wave-race-64-racewave46";
    let observed = ResolvedRelease {
        version: "v2".into(),
        channel: ReleaseChannel::Stable,
        published_at: None,
        asset: ReleaseAsset {
            name: "RaceWave46-Windows-x64-v2.zip".into(),
            url: "https://upstream.invalid/runtime.zip".into(),
            sha256: "ab".repeat(32),
            size: 42,
        },
    };
    let provider = Arc::new(Provider {
        release: observed.clone(),
        calls: AtomicUsize::new(0),
    });
    let mut service = PortcoveService::with_provider(library.clone(), provider.clone()).unwrap();
    let mut document = service.catalog.authoritative_document();
    let port = document
        .ports
        .iter_mut()
        .find(|port| port.id == id)
        .unwrap();
    port.release.provider = crate::ReleaseSource::Github;
    port.release.direct.clear();
    port.release.repository = "official/project".into();
    port.release.asset_hints.insert(
        Platform::WindowsX86_64,
        vec!["RaceWave46-Windows-x64-".into(), ".zip".into()],
    );
    service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    let mut forged: ResolvedRelease =
        serde_json::from_slice(&serde_json::to_vec(&observed).unwrap()).unwrap();
    forged.version = "client-supplied-version".into();
    let operation = OperationCoordinator::new("dynamic-client-plan", None);
    let mut emit = |_| {};
    let failure = service
        .apply_resolved_release(
            service.catalog.port(id).unwrap(),
            library.status(id, ReleaseChannel::Stable).unwrap(),
            InstallOverrides {
                source: None,
                bios: None,
                output_directory: None,
            },
            forged,
            ReleaseIntent {
                activate: true,
                shared_preferences: None,
            },
            &mut OperationReporter {
                operation: &operation,
                emit: &mut emit,
            },
        )
        .await
        .unwrap_err();
    assert!(
        failure.message.contains("reviewed release changed"),
        "{failure}"
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert!(library.all_installs().unwrap().is_empty());
    assert_eq!(fs::read_dir(library.staging_dir()).unwrap().count(), 0);
}
