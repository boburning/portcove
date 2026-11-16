//! A bounded local observation of a candidate refused before publication.
use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    LocalBaseline, PackageShape, PackageShapeRecord, SHAPE_VERSION, ShapeVerdict,
    derivation_inputs_sha256, evaluate, withholds_release,
};
use crate::{
    Library, Platform, PortDefinition, PortcoveError, ReleaseChannel, ResolvedRelease, Result,
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
        shape_version: SHAPE_VERSION,
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
    if observation.shape_version != SHAPE_VERSION
        || observation.capability != capability
        || observation.candidate_key != candidate_key
        || observation.shape_inputs != shape_inputs(port, platform)?
        || !observation.shape.is_canonical()
    {
        return Ok(None);
    }
    let (verdict, _) = evaluate(
        port,
        platform,
        &release.asset.sha256,
        &observation.shape,
        local().as_ref(),
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
                shape_version: SHAPE_VERSION,
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
        );
        assert!(matches!(verdict, ShapeVerdict::Drifted { .. }));
        record(
            &library,
            &port,
            platform,
            &release,
            capability,
            &PackageShapeRecord {
                shape_version: SHAPE_VERSION,
                shape: Some(changed.clone()),
                provenance,
                verdict,
            },
        )
        .unwrap();
        drop(library);

        let library = Library::open(&root).unwrap();
        assert!(matches!(
            current(&library, &port, platform, &release, capability, || Some(
                local(baseline.clone())
            ))
            .unwrap(),
            Some(ShapeVerdict::Drifted {
                baseline: ShapeBaseline::Local { .. },
                ..
            })
        ));
        assert!(
            current(&library, &port, platform, &release, capability, || Some(
                local(changed)
            ))
            .unwrap()
            .is_none()
        );
        let mut unreviewed = local(baseline);
        unreviewed.record.provenance = ShapeProvenance::Unreviewed;
        assert!(
            current(&library, &port, platform, &release, capability, || Some(
                unreviewed
            ))
            .unwrap()
            .is_none()
        );
        assert!(
            current(&library, &port, platform, &release, capability, || None)
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
                || panic!("mismatched artifact")
            )
            .unwrap()
            .is_none()
        );
        port.persistent_paths.push("userdata".into());
        assert!(
            current(&library, &port, platform, &release, capability, || panic!(
                "mismatched inputs"
            ))
            .unwrap()
            .is_none()
        );
    }
}
