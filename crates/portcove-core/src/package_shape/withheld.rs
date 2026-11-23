//! A bounded local observation of a candidate refused before publication.
use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    COMPONENT_RULES_VERSION, LocalBaseline, PackageShape, PackageShapeRecord, ShapeVerdict,
    derivation_inputs_sha256, evaluate, readable_shape_version, withholds_release,
};
use crate::{
    ArtifactIdentity, Library, Platform, PortDefinition, PortcoveError, ReleaseChannel,
    ResolvedRelease, Result, ScopedResolvedRelease,
};

const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Observation {
    shape_version: u32,
    capability: u32,
    candidate_key: String,
    shape_inputs: String,
    shape: PackageShape,
}

fn observation_path(
    library: &Library,
    port: &PortDefinition,
    platform: Platform,
    channel: ReleaseChannel,
) -> Result<PathBuf> {
    let scope = serde_json::to_vec(&(&port.id, platform, channel))?;
    Ok(library
        .root()
        .join("package-shape-observations")
        .join(hex::encode(Sha256::digest(scope)) + ".json"))
}

fn candidate_key(release: &ResolvedRelease) -> Result<Option<String>> {
    let asset = &release.asset;
    if asset.sha256.len() != 64 || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let identity = serde_json::to_vec(&(
        &release.version,
        &asset.name,
        asset.size,
        asset.sha256.to_ascii_lowercase(),
        &asset.url,
    ))?;
    Ok(Some(hex::encode(Sha256::digest(identity))))
}

fn shape_inputs(port: &PortDefinition, platform: Platform) -> Result<String> {
    let platform = serde_json::to_value(platform)?;
    derivation_inputs_sha256(
        &serde_json::to_value(port)?,
        platform
            .as_str()
            .ok_or_else(|| PortcoveError::state("invalid shape observation platform"))?,
    )
}

pub(crate) fn record(
    library: &Library,
    port: &PortDefinition,
    platform: Platform,
    release: &ResolvedRelease,
    capability: u32,
    record: &PackageShapeRecord,
) -> Result<()> {
    let (Some(candidate_key), Some(shape)) = (candidate_key(release)?, record.shape.as_ref())
    else {
        return Ok(());
    };
    let observation = Observation {
        shape_version: COMPONENT_RULES_VERSION,
        capability,
        candidate_key,
        shape_inputs: shape_inputs(port, platform)?,
        shape: shape.clone(),
    };
    let bytes = serde_json::to_vec(&observation)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(PortcoveError::state(
            "package shape observation exceeds storage limit",
        ));
    }
    let path = observation_path(library, port, platform, release.channel)?;
    crate::path::refuse_symlink_ancestors(&path)?;
    let parent = path
        .parent()
        .ok_or_else(|| PortcoveError::state("package shape observation has no parent"))?;
    fs::create_dir_all(parent)?;
    crate::path::refuse_symlink_ancestors(&path)?;
    crate::durability::write_bytes_atomically(&path, &bytes, true)
}

pub(crate) fn current(
    library: &Library,
    port: &PortDefinition,
    platform: Platform,
    release: &ResolvedRelease,
    capability: u32,
    resolution: Option<&ScopedResolvedRelease>,
    local: impl FnOnce() -> Option<LocalBaseline>,
) -> Result<Option<ShapeVerdict>> {
    let Some(candidate_key) = candidate_key(release)? else {
        return Ok(None);
    };
    let path = observation_path(library, port, platform, release.channel)?;
    if !path.try_exists()? {
        return Ok(None);
    }
    crate::path::refuse_symlink_ancestors(&path)?;
    let observation: Observation =
        serde_json::from_slice(&crate::path::read_bounded_regular(&path, MAX_BYTES)?)?;
    if !readable_shape_version(observation.shape_version)
        || observation.capability != capability
        || observation.candidate_key != candidate_key
        || observation.shape_inputs != shape_inputs(port, platform)?
        || !observation.shape.is_canonical()
    {
        return Ok(None);
    }
    let artifact = ArtifactIdentity {
        asset_name: release.asset.name.clone(),
        sha256: release.asset.sha256.clone(),
        size: release.asset.size,
    };
    let reviewed_layout = crate::package_layout::layout_for_acquisition(
        port,
        platform,
        // A plain cached offer or a different resolution cannot supply this proof.
        resolution
            .filter(|proof| {
                &proof.release == release
                    && proof
                        .scope
                        .as_ref()
                        .is_none_or(|scope| scope.require_current().is_ok())
            })
            .map(|proof| (proof, &artifact)),
    );
    let (verdict, _) = evaluate(
        port,
        platform,
        &release.asset.sha256,
        &observation.shape,
        local().as_ref(),
        reviewed_layout,
    );
    Ok(withholds_release(&verdict).then_some(verdict))
}

pub(crate) fn refusal(
    port: &PortDefinition,
    release: &ResolvedRelease,
    verdict: &ShapeVerdict,
) -> PortcoveError {
    PortcoveError::verification(format!(
        "{} {} is waiting for review because the package layout changed",
        port.name, release.version
    ))
    .with_known_cause(crate::failure::KnownFailureCause::PackageShapeDrift)
    .detail("version", &release.version)
    .detail("artifact_sha256", &release.asset.sha256)
    .detail(
        "package_shape_verdict",
        serde_json::to_string(verdict).unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_shape::{ShapeBaseline, ShapeProvenance, ShapeUnknownReason};

    fn local(shape: PackageShape) -> LocalBaseline {
        LocalBaseline {
            install_id: "local-install".into(),
            version: "1.0.0".into(),
            sha256: "a".repeat(64),
            record: PackageShapeRecord {
                shape_version: COMPONENT_RULES_VERSION,
                shape: Some(shape),
                provenance: ShapeProvenance::Reviewed,
                verdict: ShapeVerdict::Unknown {
                    baseline: None,
                    reason: ShapeUnknownReason::NoBaseline,
                    unknown: Vec::new(),
                    detail: None,
                },
            },
        }
    }

    #[test]
    fn the_retained_observation_is_recomputed_for_the_exact_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let library = Library::open(&root).unwrap();
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("zelda64-recomp")
            .unwrap()
            .clone();
        port.id = "shape-observation-fixture".into();
        port.reviewed_package_layouts.clear();
        let platform = Platform::WindowsX86_64;
        let capability = crate::package_shape::enforcement_capability(port.adapter).unwrap();
        let release = ResolvedRelease {
            version: "2.0.0".into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: crate::ReleaseAsset {
                name: "game.zip".into(),
                sha256: "b".repeat(64),
                size: 50,
                url: "https://example.invalid/game.zip".into(),
            },
            uploader_continuity: None,
        };
        let baseline = PackageShape {
            programs: Some(vec!["game.exe".into()]),
            ..PackageShape::default()
        };
        let changed = PackageShape {
            programs: Some(vec!["game.exe".into(), "updater.exe".into()]),
            ..PackageShape::default()
        };
        let (verdict, provenance) = evaluate(
            &port,
            platform,
            &release.asset.sha256,
            &changed,
            Some(&local(baseline.clone())),
            None,
        );
        assert!(matches!(verdict, ShapeVerdict::Drifted { .. }));
        record(
            &library,
            &port,
            platform,
            &release,
            capability,
            &PackageShapeRecord {
                shape_version: COMPONENT_RULES_VERSION,
                shape: Some(changed.clone()),
                provenance,
                verdict,
            },
        )
        .unwrap();
        drop(library);

        let library = Library::open(&root).unwrap();
        assert!(matches!(
            current(
                &library,
                &port,
                platform,
                &release,
                capability,
                None,
                || Some(local(baseline.clone()))
            )
            .unwrap(),
            Some(ShapeVerdict::Drifted {
                baseline: ShapeBaseline::Local { .. },
                ..
            })
        ));
        assert!(
            current(
                &library,
                &port,
                platform,
                &release,
                capability,
                None,
                || Some(local(changed))
            )
            .unwrap()
            .is_none()
        );
        let mut unreviewed = local(baseline);
        unreviewed.record.provenance = ShapeProvenance::Unreviewed;
        assert!(
            current(
                &library,
                &port,
                platform,
                &release,
                capability,
                None,
                || Some(unreviewed)
            )
            .unwrap()
            .is_none()
        );
        assert!(
            current(
                &library,
                &port,
                platform,
                &release,
                capability,
                None,
                || None
            )
            .unwrap()
            .is_none()
        );

        let mut replacement = release.clone();
        replacement.asset.sha256 = "c".repeat(64);
        assert!(
            current(
                &library,
                &port,
                platform,
                &replacement,
                capability,
                None,
                || panic!("mismatched artifact")
            )
            .unwrap()
            .is_none()
        );
        port.persistent_paths.push("userdata".into());
        assert!(
            current(
                &library,
                &port,
                platform,
                &release,
                capability,
                None,
                || panic!("mismatched inputs")
            )
            .unwrap()
            .is_none()
        );
    }
    #[test]
    fn prepared_openmohaa_shape_ignores_the_retained_preview9_raw_program_hold() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog
            .port("medal-of-honor-allied-assault-openmohaa")
            .unwrap();
        let platform = Platform::LinuxX86_64;
        let release = ResolvedRelease {
            version: "v0.82.1".into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: crate::ReleaseAsset {
                name: "openmohaa-v0.82.1-linux-amd64.zip".into(),
                url: "https://github.com/openmoh/openmohaa/releases/download/v0.82.1/openmohaa-v0.82.1-linux-amd64.zip".into(),
                sha256: "57692d057a684afb7f7e91a61fcd8c062b29ab1b639f27453830084a88cd653c".into(),
                size: 16_999_314,
            },
            uploader_continuity: None,
        };
        // Exact local refusal captured from Preview.9's first managed install.
        let legacy = br#"{"shape_version":1,"capability":38,"candidate_key":"4a1a7e7fc2d212a919587f699d0cec5370798068e8d47f4ee3dcae2556591671","shape_inputs":"6cc87014969f9fb4ca9314236e0ca595ca1b2d98ee0441e4b006eac946a47841","shape":{"programs":[],"top_directories":[],"config_files":[]}}"#;
        let old: Observation = serde_json::from_slice(legacy).unwrap();
        assert_eq!(
            candidate_key(&release).unwrap().as_deref(),
            Some(old.candidate_key.as_str())
        );
        let (raw_verdict, _) = evaluate(
            port,
            platform,
            &release.asset.sha256,
            &old.shape,
            None,
            None,
        );
        assert!(withholds_release(&raw_verdict));
        let path = observation_path(&library, port, platform, release.channel).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, legacy).unwrap();
        assert!(
            current(
                &library,
                port,
                platform,
                &release,
                old.capability,
                None,
                || None
            )
            .unwrap()
            .is_none()
        );
        assert_eq!(fs::read(&path).unwrap(), legacy);

        let new_drift = PackageShape {
            programs: Some(vec![
                "launch_openmohaa_base".into(),
                "omohaaded".into(),
                "openmohaa".into(),
            ]),
            ..old.shape
        };
        let (verdict, provenance) = evaluate(
            port,
            platform,
            &release.asset.sha256,
            &new_drift,
            None,
            None,
        );
        assert!(withholds_release(&verdict));
        record(
            &library,
            port,
            platform,
            &release,
            old.capability,
            &PackageShapeRecord {
                shape_version: COMPONENT_RULES_VERSION,
                shape: Some(new_drift),
                provenance,
                verdict,
            },
        )
        .unwrap();
        assert!(
            current(
                &library,
                port,
                platform,
                &release,
                old.capability,
                None,
                || None
            )
            .unwrap()
            .is_some()
        );
    }
}
