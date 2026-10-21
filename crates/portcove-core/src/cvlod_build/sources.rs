//! Closed source acquisition and assembly facts, never supplied by definitions.
use super::super::{BuildArchive, FileIdentity, copy_verified, digest, inventory};
use crate::{PortcoveError, ReleaseAsset, Result};
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const MANIFEST: &str = include_str!("sources.json");
const SDK_MANIFEST: &str = include_str!("sdk-sources.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format_version: u32,
    components: Vec<Component>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Archive {
    name: String,
    url: String,
    size: u64,
    sha256: String,
    root: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Component {
    key: String,
    #[serde(default)]
    mount: String,
    repository: String,
    #[serde(default)]
    commit: String,
    #[serde(default)]
    tree: String,
    #[serde(default)]
    official_release: Option<OfficialRelease>,
    archive: Option<Archive>,
    files: usize,
    bytes: u64,
    inventory_sha256: String,
    #[serde(default)]
    raw_files: Vec<RawFile>,
    #[serde(default)]
    omitted: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    path: String,
    size: u64,
    sha256: String,
    git_blob: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OfficialRelease {
    tag: String,
    release_id: u64,
    authentication: String,
}

/// Only this module can produce a download request, from embedded fixed facts.
pub(crate) struct Blob {
    pub(crate) asset: ReleaseAsset,
    pub(crate) relative: PathBuf,
}

pub(super) fn identity() -> String {
    digest(format!("{MANIFEST}\n{SDK_MANIFEST}").as_bytes())
}

fn components() -> Result<Vec<Component>> {
    let manifest: Manifest = serde_json::from_str(MANIFEST)?;
    if manifest.format_version != 1 || manifest.components.len() != 34 {
        return Err(PortcoveError::verification(
            "CVLoD fixed source manifest differs",
        ));
    }
    Ok(manifest.components)
}

pub(crate) fn blobs() -> Result<Vec<Blob>> {
    let mut blobs = Vec::new();
    let mut destinations = std::collections::BTreeSet::new();
    for component in components()? {
        crate::archive::validate_relative_path(&component.key, false)?;
        if component.archive.is_some() {
            continue;
        }
        if component.raw_files.len() != component.files {
            return Err(PortcoveError::verification(
                "CVLoD raw source closure differs",
            ));
        }
        for file in component.raw_files {
            crate::archive::validate_relative_path(&file.path, false)?;
            let relative = Path::new("raw").join(&component.key).join(&file.path);
            if !file.path.is_ascii()
                || file.size > 64 * 1024 * 1024
                || file.git_blob.len() != 40
                || file.sha256.len() != 64
                || !destinations.insert(relative.to_string_lossy().to_ascii_lowercase())
            {
                return Err(PortcoveError::verification(
                    "CVLoD raw source identity differs",
                ));
            }
            blobs.push(Blob {
                asset: ReleaseAsset {
                    name: format!("{}-{}.blob", component.key, blobs.len()),
                    url: format!(
                        "https://raw.githubusercontent.com/{}/{}/{}",
                        component.repository, component.commit, file.path
                    ),
                    size: file.size,
                    sha256: file.sha256,
                },
                relative,
            });
        }
    }
    if blobs.len() != 1454 {
        return Err(PortcoveError::verification(
            "CVLoD raw download inventory differs",
        ));
    }
    Ok(blobs)
}

pub(super) fn raw_roots(work: &Path) -> Result<Vec<PathBuf>> {
    Ok(components()?
        .into_iter()
        .filter(|c| c.archive.is_none())
        .map(|c| work.join("raw").join(c.key))
        .collect())
}

fn root(work: &Path, component: &Component, archives: &[BuildArchive]) -> Result<PathBuf> {
    if let Some(expected) = &component.archive {
        let archive = archives
            .iter()
            .find(|a| a.name == expected.name)
            .ok_or_else(|| PortcoveError::verification("CVLoD fixed archive is missing"))?;
        if archive.url != expected.url
            || archive.size != expected.size
            || archive.sha256 != expected.sha256
            || archive.root != expected.root
        {
            return Err(PortcoveError::verification(
                "CVLoD fixed archive identity differs",
            ));
        }
        Ok(work
            .join(archive.name.trim_end_matches(".zip"))
            .join(archive.root))
    } else {
        Ok(work.join("raw").join(&component.key))
    }
}

fn provenance_valid(component: &Component) -> bool {
    match &component.official_release {
        Some(release) => {
            component.key == "component-03"
                && component.repository == "microsoft/DirectXShaderCompiler"
                && component.commit.is_empty()
                && component.tree.is_empty()
                && release.tag == "v1.7.2308"
                && release.release_id == 116_120_982
                && release.authentication == "official-release-transport-and-measured-sha256"
                && component.archive.as_ref().is_some_and(|archive| {
                    let expected = super::pipeline::DXC;
                    archive.name == expected.name
                        && archive.url == expected.url
                        && archive.sha256 == expected.sha256
                        && archive.size == expected.size
                        && archive.root == expected.root
                })
        }
        None => {
            component.key != "component-03"
                && component.commit.len() == 40
                && component.tree.len() == 40
                && component
                    .commit
                    .bytes()
                    .chain(component.tree.bytes())
                    .all(|b| b.is_ascii_hexdigit())
        }
    }
}

fn verify_component(
    root: &Path,
    component: &Component,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Vec<FileIdentity>> {
    let files = inventory(root, checkpoint)?;
    if !provenance_valid(component)
        || files.len() != component.files
        || files.iter().map(|f| f.size).sum::<u64>() != component.bytes
        || digest(&serde_json::to_vec(&files)?) != component.inventory_sha256
    {
        return Err(PortcoveError::verification(
            "CVLoD source component differs from its reviewed acquisition identity",
        )
        .detail("component", &component.key));
    }
    // Omitted entries are provenance only. They are never downloaded or copied.
    let _omission_count = component.omitted.len();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cvlod_dxc_release_identity_cannot_be_claimed_as_a_git_tree_or_other_asset() {
        let manifest: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
        let original = manifest["components"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["key"] == "component-03")
            .unwrap();
        let component: Component = serde_json::from_value(original.clone()).unwrap();
        assert!(provenance_valid(&component));
        assert_eq!(component.files, 20);
        for (pointer, value) in [
            ("/commit", serde_json::json!("0".repeat(40))),
            ("/tree", serde_json::json!("0".repeat(40))),
            ("/repository", serde_json::json!("rt64/dxc-bin")),
            ("/official_release/release_id", serde_json::json!(86363916)),
            (
                "/official_release/authentication",
                serde_json::json!("verified-git-tree"),
            ),
            ("/archive/sha256", serde_json::json!("0".repeat(64))),
        ] {
            let mut changed = original.clone();
            if pointer == "/commit" || pointer == "/tree" {
                changed[pointer.trim_start_matches('/')] = value;
            } else {
                *changed.pointer_mut(pointer).unwrap() = value;
            }
            assert!(
                !provenance_valid(&serde_json::from_value(changed).unwrap()),
                "{pointer}"
            );
        }
        let mut false_git = original.clone();
        false_git
            .as_object_mut()
            .unwrap()
            .remove("official_release");
        false_git["commit"] = serde_json::json!("0".repeat(40));
        false_git["tree"] = serde_json::json!("0".repeat(40));
        assert!(!provenance_valid(
            &serde_json::from_value(false_git).unwrap()
        ));
    }
}

pub(super) fn assemble(
    work: &Path,
    archives: &[BuildArchive],
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<PathBuf> {
    let project = work.join("project");
    crate::path::refuse_symlink_ancestors(&project)?;
    fs::create_dir(&project)?;
    let mut mounted = std::collections::BTreeSet::new();
    for component in components()? {
        if !component.mount.is_empty() {
            crate::archive::validate_relative_path(&component.mount, true)?;
        }
        if !mounted.insert(component.mount.to_ascii_lowercase()) {
            return Err(PortcoveError::verification("CVLoD source mount collides"));
        }
        let source = root(work, &component, archives)?;
        let files = verify_component(&source, &component, checkpoint)?;
        let target = project.join(&component.mount);
        crate::path::refuse_symlink_ancestors(&target)?;
        fs::create_dir_all(&target)?;
        for file in &files {
            let destination = target.join(&file.path);
            copy_verified(&source.join(&file.path), &destination, checkpoint)?;
        }
        if inventory(&source, checkpoint)? != files {
            return Err(PortcoveError::verification(
                "CVLoD source changed during assembly",
            ));
        }
    }
    Ok(project)
}

pub(super) fn sdk_roots(
    work: &Path,
    archives: &[BuildArchive],
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<std::collections::BTreeMap<String, PathBuf>> {
    let components: Vec<Component> = serde_json::from_str(SDK_MANIFEST)?;
    if components.len() != 4 {
        return Err(PortcoveError::verification(
            "CVLoD SDK source closure differs",
        ));
    }
    let mut roots = std::collections::BTreeMap::new();
    for component in components {
        let root = root(work, &component, archives)?;
        verify_component(&root, &component, checkpoint)?;
        roots.insert(component.key, root);
    }
    Ok(roots)
}
