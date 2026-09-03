use std::{
    io::Write,
    path::{Component, Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    InstallRecord, Library, PortcoveError, PortcoveService, ReleaseChannel, Result, SourceRecord,
    UpdatePolicy,
};

/// Metadata only; content trees and original source files are never embedded.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LibraryMetadata {
    pub schema_version: u32,
    pub exported_at: i64,
    pub original_root: PathBuf,
    pub content_roots: Vec<LibraryContentRoot>,
    pub source_references: Vec<SourceRecord>,
    pub application_versions: Vec<InstallRecord>,
    pub port_settings: Vec<LibraryPortSettings>,
    pub launch_history: Vec<LibraryLaunchHistory>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LibraryContentRoot {
    pub kind: LibraryContentKind,
    pub relative_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryContentKind {
    ApplicationVersions,
    UserData,
    Backups,
    Toolchains,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LibraryPortSettings {
    pub port_id: String,
    pub channel: ReleaseChannel,
    pub update_policy: UpdatePolicy,
    pub active_install_id: Option<String>,
    pub previous_install_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LibraryLaunchHistory {
    pub port_id: String,
    pub last_launched_at: i64,
    pub successful_launches: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LibraryMetadataFile {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
}

impl PortcoveService {
    pub fn export_library_metadata(&self) -> Result<LibraryMetadata> {
        self.library().metadata_snapshot()
    }

    pub fn write_library_metadata(&self, destination: &Path) -> Result<LibraryMetadataFile> {
        crate::path::unicode(destination, "metadata export")?;
        let destination = std::path::absolute(destination)?;
        let parent = destination
            .parent()
            .ok_or_else(|| PortcoveError::usage("metadata export needs a filename"))?;
        let bytes = serde_json::to_vec_pretty(&self.export_library_metadata()?)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist_noclobber(&destination)
            .map_err(|error| PortcoveError::from(error.error))?;
        Ok(LibraryMetadataFile {
            path: destination,
            sha256: hex::encode(Sha256::digest(&bytes)),
            size: bytes.len() as u64,
        })
    }
}

impl Library {
    fn metadata_snapshot(&self) -> Result<LibraryMetadata> {
        self.metadata_for_root(&std::fs::canonicalize(self.root())?)
    }

    pub(crate) fn metadata_for_root(&self, managed_root: &Path) -> Result<LibraryMetadata> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let source_references = Self::sources_from(&transaction)?;
        let mut application_versions = Self::installs_from(&transaction)?;
        let original_root = managed_root.to_path_buf();
        application_versions.sort_by(|left, right| left.id.cmp(&right.id));
        for install in &mut application_versions {
            let absolute = crate::path::resolve_existing_ancestor(&install.path)?;
            let relative = absolute.strip_prefix(&original_root).map_err(|_| {
                PortcoveError::state(
                    "registered installation is outside the library being exported",
                )
            })?;
            install.path = PathBuf::from(portable_relative(relative)?);
            install.selected_executable =
                PathBuf::from(portable_relative(&install.selected_executable)?);
        }
        let port_settings = read_settings(&transaction)?;
        let launch_history = read_launch_history(&transaction)?;
        transaction.commit()?;
        Ok(LibraryMetadata {
            schema_version: 1,
            exported_at: Self::now(),
            original_root,
            content_roots: [
                (LibraryContentKind::ApplicationVersions, "versions"),
                (LibraryContentKind::UserData, "user"),
                (LibraryContentKind::Backups, "backups"),
                (LibraryContentKind::Toolchains, "toolchains"),
            ]
            .into_iter()
            .map(|(kind, relative_path)| LibraryContentRoot {
                kind,
                relative_path: relative_path.into(),
            })
            .collect(),
            source_references,
            application_versions,
            port_settings,
            launch_history,
        })
    }
}

fn read_settings(connection: &rusqlite::Connection) -> Result<Vec<LibraryPortSettings>> {
    let mut statement = connection.prepare("SELECT port_id, channel, update_policy, active_install_id, previous_install_id FROM port_settings ORDER BY port_id")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    rows.map(|row| {
        let (port_id, channel, policy, active_install_id, previous_install_id) = row?;
        Ok(LibraryPortSettings {
            port_id,
            channel: channel.parse()?,
            update_policy: policy.parse()?,
            active_install_id,
            previous_install_id,
        })
    })
    .collect()
}

fn read_launch_history(connection: &rusqlite::Connection) -> Result<Vec<LibraryLaunchHistory>> {
    let mut statement = connection.prepare("SELECT port_id, last_launched_at, successful_launches FROM launch_history ORDER BY port_id")?;
    let rows = statement.query_map([], |row| {
        Ok(LibraryLaunchHistory {
            port_id: row.get(0)?,
            last_launched_at: row.get(1)?,
            successful_launches: row.get(2)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

pub(crate) fn portable_relative(path: &Path) -> Result<String> {
    let parts = path
        .components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .filter(|value| !value.contains('\\'))
                .map(str::to_owned)
                .ok_or_else(|| {
                    PortcoveError::unsupported("library metadata contains a nonportable path")
                }),
            _ => Err(PortcoveError::verification(
                "library metadata requires a contained relative path",
            )),
        })
        .collect::<Result<Vec<_>>>()?;
    if parts.is_empty() {
        return Err(PortcoveError::verification(
            "library metadata contains an empty relative path",
        ));
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn metadata_preserves_active_previous_and_staged_artifact_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let service = PortcoveService::new(Library::open(temporary.path()).unwrap()).unwrap();
        for (id, digest, staged) in [
            ("old", 'a', false),
            ("active", 'b', false),
            ("staged", 'c', true),
        ] {
            let record = InstallRecord {
                id: id.into(),
                port_id: "starship".into(),
                version: id.into(),
                path: temporary.path().join("versions/starship").join(id),
                channel: ReleaseChannel::Stable,
                installed_at: 1,
                verified: true,
                staged,
                artifact: crate::ArtifactIdentity {
                    asset_name: format!("{id}.zip"),
                    sha256: digest.to_string().repeat(64),
                    size: 42,
                },
                manifest_sha256: digest.to_string().repeat(64),
                selected_executable: PathBuf::from("bin/game.exe"),
                runtime: None,
            };
            service
                .library()
                .register_install(&record, !staged)
                .unwrap();
        }
        let metadata = service.export_library_metadata().unwrap();
        let settings = &metadata.port_settings[0];
        assert_eq!(settings.active_install_id.as_deref(), Some("active"));
        assert_eq!(settings.previous_install_id.as_deref(), Some("old"));
        assert_eq!(metadata.application_versions.len(), 3);
        let staged = metadata
            .application_versions
            .iter()
            .find(|install| install.staged)
            .unwrap();
        assert_eq!(staged.id, "staged");
        assert_eq!(staged.artifact.sha256, "c".repeat(64));
        assert_eq!(staged.path.to_str().unwrap(), "versions/starship/staged");
        assert_eq!(staged.selected_executable.to_str().unwrap(), "bin/game.exe");
        let status = service
            .library()
            .status("starship", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(status.active.unwrap().id, "active");
        assert_eq!(status.previous.unwrap().id, "old");
        assert_eq!(status.staged.unwrap().id, "staged");
    }

    #[test]
    fn metadata_export_contains_references_but_no_source_bytes_and_never_overwrites() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("synthetic.z64");
        let source_bytes = b"synthetic source content is never exported";
        fs::write(&source, source_bytes).unwrap();
        let service =
            PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
        service.register_source("star-fox-64", &source).unwrap();
        service
            .library()
            .ensure_settings("starship", ReleaseChannel::Stable)
            .unwrap();
        let before = service.library().sources().unwrap();
        let metadata = service.export_library_metadata().unwrap();
        assert_eq!(
            serde_json::to_value(&metadata.source_references).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        assert_eq!(metadata.content_roots.len(), 4);
        let destination = temporary.path().join("metadata.json");
        let report = service.write_library_metadata(&destination).unwrap();
        let bytes = fs::read(&destination).unwrap();
        assert_eq!(hex::encode(Sha256::digest(&bytes)), report.sha256);
        assert!(
            !String::from_utf8_lossy(&bytes).contains(std::str::from_utf8(source_bytes).unwrap())
        );
        let parsed: LibraryMetadata = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            serde_json::to_value(&parsed.source_references).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        assert!(service.write_library_metadata(&destination).is_err());
        assert_eq!(fs::read(destination).unwrap(), bytes);
        assert_eq!(fs::read(source).unwrap(), source_bytes);
    }
}
