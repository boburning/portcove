use std::{
    fs::{self, File},
    path::Path,
};

use flate2::read::GzDecoder;
use futures_util::StreamExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{
    InstallRecord, Library, OperationEvent, PortcoveError, PsxManagedPreparation, ResolvedRelease,
    Result,
    adapter::{hash_file, walk_files},
};

#[derive(Debug, Clone)]
pub struct InstallRequest {
    pub port_id: String,
    pub release: ResolvedRelease,
    pub activate: bool,
    pub managed: Option<PsxManagedPreparation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VerificationReport {
    pub install_id: String,
    pub checked_files: u64,
    pub valid: bool,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstallManifest {
    schema_version: u32,
    port_id: String,
    version: String,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestFile {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone)]
pub struct Installer {
    library: Library,
    client: reqwest::Client,
}

struct OperationRootGuard<'a>(&'a Path);

impl Drop for OperationRootGuard<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.0);
    }
}

impl Installer {
    pub fn new(library: Library) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        Ok(Self { library, client })
    }

    pub async fn install<F>(&self, request: InstallRequest, mut emit: F) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        let safe_version = safe_component(&request.release.version);
        let destination = self
            .library
            .versions_dir()
            .join(&request.port_id)
            .join(&safe_version);
        if destination.exists() {
            return Err(PortcoveError::conflict(format!(
                "version {} already exists for {}",
                request.release.version, request.port_id
            )));
        }
        emit(OperationEvent::Started {
            operation: "install".into(),
            port_id: Some(request.port_id.clone()),
        });
        let operation_id = Uuid::new_v4().to_string();
        let operation_root = self.library.staging_dir().join(&operation_id);
        let payload_root = operation_root.join("payload");
        fs::create_dir_all(&payload_root)?;
        let _operation_guard = OperationRootGuard(&operation_root);
        self.write_journal(&operation_root, "created", &request)?;
        let download_path = operation_root.join(&request.release.asset.name);
        if let Err(error) = self
            .download(&request.release, &download_path, &mut emit)
            .await
        {
            let _ = self.write_journal(&operation_root, "download_failed", &request);
            return Err(error);
        }
        self.write_journal(&operation_root, "downloaded", &request)?;
        let (actual_hash, _) = hash_file(&download_path)?;
        if !actual_hash.eq_ignore_ascii_case(&request.release.asset.sha256) {
            return Err(PortcoveError::verification(
                "downloaded asset failed SHA-256 verification",
            )
            .detail("expected", request.release.asset.sha256.clone())
            .detail("actual", actual_hash));
        }
        emit(OperationEvent::Message {
            level: "info".into(),
            message: "SHA-256 verified".into(),
        });
        let asset_name = request.release.asset.name.clone();
        let extraction_path = download_path.clone();
        let extraction_root = payload_root.clone();
        tokio::task::spawn_blocking(move || {
            extract_asset(&extraction_path, &extraction_root, &asset_name)
        })
        .await
        .map_err(|error| PortcoveError::install(error.to_string()))??;
        self.write_journal(&operation_root, "extracted", &request)?;
        if let Some(preparation) = request.managed.clone() {
            emit(OperationEvent::Message {
                level: "info".into(),
                message: "Generating and compiling the verified PS1 source".into(),
            });
            let managed_root = payload_root.clone();
            tokio::task::spawn_blocking(move || {
                crate::psx::prepare_install(&managed_root, &preparation)
            })
            .await
            .map_err(|error| PortcoveError::install(error.to_string()))??;
            self.write_journal(&operation_root, "managed_prepared", &request)?;
        }
        let manifest = build_manifest(&request.port_id, &request.release.version, &payload_root)?;
        fs::write(
            payload_root.join(".portcove-manifest.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
        fs::create_dir_all(
            destination
                .parent()
                .expect("version directory has a parent"),
        )?;
        if destination.exists() {
            fs::remove_dir_all(&operation_root)?;
            return Err(PortcoveError::conflict(format!(
                "version {} was installed by another operation",
                request.release.version
            )));
        } else {
            fs::rename(&payload_root, &destination)?;
            fs::remove_dir_all(&operation_root)?;
        }
        let install = InstallRecord {
            id: operation_id,
            port_id: request.port_id,
            version: request.release.version,
            path: destination,
            channel: request.release.channel,
            installed_at: Library::now(),
            verified: true,
            staged: !request.activate,
        };
        self.library.register_install(&install, request.activate)?;
        emit(OperationEvent::Finished {
            operation: "install".into(),
            success: true,
        });
        Ok(install)
    }

    async fn download<F>(
        &self,
        release: &ResolvedRelease,
        destination: &Path,
        emit: &mut F,
    ) -> Result<()>
    where
        F: FnMut(OperationEvent),
    {
        let response = self
            .client
            .get(&release.asset.url)
            .send()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?
            .error_for_status()
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        let total = response
            .content_length()
            .or(Some(release.asset.size))
            .filter(|value| *value > 0);
        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(destination).await?;
        let mut completed = 0_u64;
        let mut reported = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| PortcoveError::network(error.to_string()))?;
            file.write_all(&chunk).await?;
            completed += chunk.len() as u64;
            if total.is_some_and(|total| completed == total)
                || completed.saturating_sub(reported) >= 1024 * 1024
            {
                emit(OperationEvent::Progress {
                    phase: "download".into(),
                    completed,
                    total,
                });
                reported = completed;
            }
        }
        if completed != reported {
            emit(OperationEvent::Progress {
                phase: "download".into(),
                completed,
                total,
            });
        }
        file.flush().await?;
        Ok(())
    }

    fn write_journal(&self, root: &Path, phase: &str, request: &InstallRequest) -> Result<()> {
        let value = serde_json::json!({
            "schema_version": 1,
            "phase": phase,
            "port_id": request.port_id,
            "version": request.release.version,
            "updated_at": Library::now()
        });
        fs::write(
            root.join("operation.json"),
            serde_json::to_vec_pretty(&value)?,
        )?;
        Ok(())
    }

    pub fn verify(&self, install: &InstallRecord) -> Result<VerificationReport> {
        let manifest_path = install.path.join(".portcove-manifest.json");
        let manifest: InstallManifest =
            serde_json::from_slice(&fs::read(&manifest_path).map_err(|_| {
                PortcoveError::verification(format!("manifest is missing for {}", install.port_id))
            })?)?;
        let mut failures = Vec::new();
        for file in &manifest.files {
            let candidate = install.path.join(&file.path);
            if !candidate.starts_with(&install.path) || !candidate.is_file() {
                failures.push(format!("missing: {}", file.path));
                continue;
            }
            let (sha256, size) = hash_file(&candidate)?;
            if size != file.size || sha256 != file.sha256 {
                failures.push(format!("changed: {}", file.path));
            }
        }
        Ok(VerificationReport {
            install_id: install.id.clone(),
            checked_files: manifest.files.len() as u64,
            valid: failures.is_empty(),
            failures,
        })
    }

    pub fn create_manifest(&self, port_id: &str, version: &str, root: &Path) -> Result<()> {
        let manifest = build_manifest(port_id, version, root)?;
        fs::write(
            root.join(".portcove-manifest.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
        Ok(())
    }
}

fn build_manifest(port_id: &str, version: &str, root: &Path) -> Result<InstallManifest> {
    let mut files = Vec::new();
    for path in walk_files(root)? {
        if path.file_name().and_then(|value| value.to_str()) == Some(".portcove-manifest.json") {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| PortcoveError::state("manifest path escaped install root"))?;
        let (sha256, size) = hash_file(&path)?;
        files.push(ManifestFile {
            path: relative.to_string_lossy().replace('\\', "/"),
            size,
            sha256,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(InstallManifest {
        schema_version: 1,
        port_id: port_id.into(),
        version: version.into(),
        files,
    })
}

fn extract_asset(source: &Path, destination: &Path, asset_name: &str) -> Result<()> {
    let lower = asset_name.to_ascii_lowercase();
    if lower.ends_with(".zip") {
        extract_zip(source, destination)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        extract_tar_gz(source, destination)
    } else if lower.ends_with(".exe") || lower.ends_with(".appimage") {
        let target = destination.join(asset_name);
        fs::copy(source, &target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&target)?.permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&target, permissions)?;
        }
        Ok(())
    } else {
        Err(PortcoveError::unsupported(format!(
            "unsupported package format: {asset_name}"
        )))
    }
}

fn extract_zip(source: &Path, destination: &Path) -> Result<()> {
    let file = File::open(source)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| PortcoveError::install(error.to_string()))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| PortcoveError::install(error.to_string()))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| PortcoveError::verification("ZIP contains an unsafe path"))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(PortcoveError::verification(
                "ZIP symbolic links are not allowed",
            ));
        }
        let output = destination.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
        } else {
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut target = File::create(&output)?;
            std::io::copy(&mut entry, &mut target)?;
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&output, fs::Permissions::from_mode(mode & 0o777))?;
            }
        }
    }
    Ok(())
}

fn extract_tar_gz(source: &Path, destination: &Path) -> Result<()> {
    let decoder = GzDecoder::new(File::open(source)?);
    let mut archive = tar::Archive::new(decoder);
    for entry in archive
        .entries()
        .map_err(|error| PortcoveError::install(error.to_string()))?
    {
        let mut entry = entry.map_err(|error| PortcoveError::install(error.to_string()))?;
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            return Err(PortcoveError::verification("TAR links are not allowed"));
        }
        if !entry
            .unpack_in(destination)
            .map_err(|error| PortcoveError::install(error.to_string()))?
        {
            return Err(PortcoveError::verification("TAR contains an unsafe path"));
        }
    }
    Ok(())
}

fn safe_component(value: &str) -> String {
    let normalized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = normalized.trim_matches(['.', '-', '_']);
    if trimmed.is_empty() {
        "release".into()
    } else {
        trimmed.chars().take(96).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_paths_are_sanitized() {
        assert_eq!(safe_component("v1.2.3"), "v1.2.3");
        assert_eq!(safe_component("../../bad tag"), "bad-tag");
    }

    #[tokio::test]
    async fn install_refuses_to_trust_a_preexisting_version_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        fs::create_dir_all(library.versions_dir().join("sample/v1")).unwrap();
        let installer = Installer::new(library).unwrap();
        let request = InstallRequest {
            port_id: "sample".into(),
            release: ResolvedRelease {
                version: "v1".into(),
                channel: crate::ReleaseChannel::Stable,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "sample.zip".into(),
                    url: "https://invalid.example/sample.zip".into(),
                    size: 1,
                    sha256: "0".repeat(64),
                },
            },
            activate: true,
            managed: None,
        };

        let error = installer.install(request, |_| {}).await.unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
    }

    #[tokio::test]
    async fn failed_download_cleans_staging_for_a_retry() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let installer = Installer::new(library.clone()).unwrap();
        let request = InstallRequest {
            port_id: "sample".into(),
            release: ResolvedRelease {
                version: "v1".into(),
                channel: crate::ReleaseChannel::Stable,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "sample.zip".into(),
                    url: format!("http://{address}/sample.zip"),
                    size: 1,
                    sha256: "0".repeat(64),
                },
            },
            activate: true,
            managed: None,
        };

        let error = installer.install(request, |_| {}).await.unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        server.join().unwrap();
        assert_eq!(fs::read_dir(library.staging_dir()).unwrap().count(), 0);
    }
}
