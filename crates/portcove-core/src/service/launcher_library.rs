//! Read-only inventory of another launcher's library (#249).
//!
//! The inventory never writes to the selected launcher data or its installations. Each
//! entry only names the existing reviewed adoption route; launcher metadata, version
//! labels, selected executables and mod records stay untrusted hints.
use super::*;
use std::path::Component;

/// Formats inspected at GitHub Launcher `6e62a967cb37a2106b0420dc47375ee83cac41d3`.
pub const GITHUB_LAUNCHER_FORMAT_REVISION: &str = "6e62a967cb37a2106b0420dc47375ee83cac41d3";
/// Formats inspected at Quiver v3.5.1 `66c45cbe2779818791948c7bd769d388e3a47b44`.
pub const QUIVER_FORMAT_REVISION: &str = "66c45cbe2779818791948c7bd769d388e3a47b44";

const LIBRARY_FILE_LIMIT: u64 = 8 * 1024 * 1024;
const SETTINGS_FILE_LIMIT: u64 = 1024 * 1024;
const MOD_SIDECAR_LIMIT: u64 = 1024 * 1024;
const HINT_FILE_LIMIT: u64 = 4096;
const HINT_TEXT_LIMIT: usize = 260;
const ENTRY_LIMIT: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum LauncherKind {
    GithubLauncher,
    Quiver,
}

impl LauncherKind {
    fn format_revision(self) -> &'static str {
        match self {
            Self::GithubLauncher => GITHUB_LAUNCHER_FORMAT_REVISION,
            Self::Quiver => QUIVER_FORMAT_REVISION,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum LauncherAppsRootOrigin {
    /// `AppsPath` from the launcher's `settings.json`.
    Settings,
    /// The launcher's default `Apps` folder beside its data.
    Default,
    /// The folder the player supplied for this inspection.
    Override,
    /// `settings.json` could not be read, so folder-name entries stay unresolved.
    Unresolved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum LauncherEntryStatus {
    /// Exactly one catalog port matches; review it with the existing adoption command.
    ReadyToReview,
    /// More than one catalog port matches these files; the player chooses with `--port`.
    Ambiguous,
    /// No catalog port uses this upstream repository.
    NotInCatalog,
    /// The catalog port matches, but its declared executable is not in this folder.
    UnrecognizedFiles,
    /// The catalog port matches, but this installation cannot be copied into Portcove.
    AdoptionUnsupported,
    /// The launcher lists this entry, but no installation folder is present.
    NotInstalled,
    /// The entry names an unsafe or unusable location; it was not inspected.
    UnsafePath,
    /// An earlier entry already names the same installation.
    Duplicate,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LauncherEntryHints {
    /// `preferredVersion` from the launcher library. Untrusted label.
    pub preferred_version: Option<String>,
    /// First line of `version.txt` in the installation. Untrusted label.
    pub installed_version_label: Option<String>,
    /// First line of `selected_executable.txt`. Portcove uses its own declared executable.
    pub selected_executable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LauncherModInventory {
    /// Records in `.quiver-mods.json`; they are inventoried, never activated.
    pub records: usize,
    pub providers: Vec<String>,
    /// False when the sidecar exists but could not be read within limits.
    pub readable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LauncherLibraryEntry {
    /// Zero-based position across the launcher library's entry arrays.
    pub index: usize,
    pub name: String,
    /// `github`, `gitlab`, `codeberg` or `manual`, as the launcher interprets the entry.
    pub repository_source: String,
    pub repository: String,
    pub folder_name: String,
    /// Resolved installation folder, when the entry names a safe absolute location.
    pub install_path: Option<PathBuf>,
    /// True when `installPath` was explicit rather than apps folder plus folder name.
    pub explicit_install_path: bool,
    pub status: LauncherEntryStatus,
    /// Catalog ports whose reviewed upstream repository matches this entry.
    pub candidate_port_ids: Vec<String>,
    /// Catalog ports whose declared executable was found in the installation.
    pub detected_port_ids: Vec<String>,
    /// Declared saves/configuration present in the installation for a single match.
    pub user_data_paths: Vec<PathBuf>,
    pub hints: LauncherEntryHints,
    pub mods: Option<LauncherModInventory>,
    pub explanation: String,
    /// Port to pass to the existing reviewed `adopt --port` for `install_path`.
    /// Absent unless exactly one copyable catalog port was detected.
    pub adopt_port_id: Option<String>,
    /// Earlier entry naming the same installation folder for a different app.
    pub shares_folder_with: Option<usize>,
    /// Launcher settings for this app that Portcove does not carry over.
    pub not_carried_over: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LauncherLibrarySkippedEntry {
    pub index: usize,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LauncherLibraryInventory {
    pub launcher: LauncherKind,
    /// Upstream source revision whose library format this reader implements.
    pub format_revision: String,
    pub data_root: PathBuf,
    pub library_file: PathBuf,
    /// True when only the launcher's legacy `games.json` was present.
    pub legacy_library_file: bool,
    pub apps_root: Option<PathBuf>,
    pub apps_root_origin: LauncherAppsRootOrigin,
    pub entries: Vec<LauncherLibraryEntry>,
    pub skipped_entries: Vec<LauncherLibrarySkippedEntry>,
    /// Inspection reads only; launcher data and installations stay untouched.
    pub original_will_be_modified: bool,
    /// Content fingerprint of this inventory, excluding this field.
    pub inventory_sha256: String,
}

#[derive(Deserialize)]
struct LauncherSettings {
    // Only the apps folder is read; tokens and other settings are never retained.
    #[serde(rename = "AppsPath", default)]
    apps_path: Option<String>,
}

#[derive(Deserialize)]
struct QuiverModsDocument {
    #[serde(default)]
    mods: Vec<QuiverModRecord>,
}

#[derive(Deserialize)]
struct QuiverModRecord {
    #[serde(default)]
    provider: Option<String>,
}

struct RawEntry {
    index: usize,
    name: String,
    source: String,
    repository: String,
    folder_name: String,
    install_path: Option<String>,
    preferred_version: Option<String>,
    not_carried_over: Vec<String>,
}

impl PortcoveService {
    /// Read-only inventory of a GitHub Launcher or Quiver library.
    ///
    /// `data_root` holds the launcher's `apps.json` (or legacy `games.json`) and
    /// `settings.json`. `apps_root` replaces the launcher's apps folder when it moved.
    pub fn inspect_launcher_library(
        &self,
        launcher: LauncherKind,
        data_root: &Path,
        apps_root: Option<&Path>,
    ) -> Result<LauncherLibraryInventory> {
        crate::path::unicode(data_root, "launcher data folder")?;
        if !data_root.is_absolute() {
            return Err(PortcoveError::usage(
                "launcher data folder must be an absolute path",
            ));
        }
        crate::path::refuse_symlink_ancestors(data_root)?;
        if !data_root.is_dir() {
            return Err(PortcoveError::not_found(format!(
                "launcher data folder is not a directory: {}",
                data_root.display()
            )));
        }
        let (library_file, legacy_library_file) = library_file(data_root)?;
        let bytes = crate::path::read_bounded_regular(&library_file, LIBRARY_FILE_LIMIT)?;
        let (raw_entries, mut skipped_entries) = parse_library(launcher, &bytes)?;
        let (apps_root, apps_root_origin) = match apps_root {
            Some(path) => {
                crate::path::unicode(path, "launcher apps folder")?;
                if !path.is_absolute() {
                    return Err(PortcoveError::usage(
                        "launcher apps folder must be an absolute path",
                    ));
                }
                (Some(path.to_path_buf()), LauncherAppsRootOrigin::Override)
            }
            None => settings_apps_root(data_root),
        };
        let platform = Platform::current()?;
        let mut entries = Vec::with_capacity(raw_entries.len());
        let mut seen_instances = std::collections::BTreeMap::<String, usize>::new();
        let mut seen_paths = std::collections::BTreeMap::<PathBuf, usize>::new();
        for raw in raw_entries {
            if raw.repository.trim().is_empty() && raw.folder_name.trim().is_empty() {
                skipped_entries.push(LauncherLibrarySkippedEntry {
                    index: raw.index,
                    reason: "entry names neither a repository nor a folder".into(),
                });
                continue;
            }
            let instance = format!(
                "{}:{}:{}",
                raw.source,
                normalized_repository(&raw.repository)
                    .unwrap_or_else(|| raw.repository.trim().to_ascii_lowercase()),
                raw.folder_name.trim().to_ascii_lowercase()
            );
            let mut entry =
                self.inspect_launcher_entry(launcher, raw, apps_root.as_deref(), platform);
            let path_key = entry.install_path.as_deref().map(normalized_key);
            if let Some(earlier) = seen_instances.get(&instance).copied() {
                // The same app listed again: the launcher itself keeps only one.
                entry.status = LauncherEntryStatus::Duplicate;
                entry.explanation =
                    format!("Entry {earlier} already lists this app; review that entry.");
                entry.adopt_port_id = None;
            } else {
                seen_instances.insert(instance, entry.index);
                // A different app naming the same folder keeps its own result, so a
                // match is never hidden behind an earlier unmatched entry.
                if let Some(key) = path_key {
                    if let Some(earlier) = seen_paths.get(&key).copied() {
                        entry.shares_folder_with = Some(earlier);
                        entry.explanation.push_str(&format!(
                            " Entry {earlier} also names this folder; only one copy is needed."
                        ));
                    } else {
                        seen_paths.insert(key, entry.index);
                    }
                }
            }
            entries.push(entry);
        }
        let mut inventory = LauncherLibraryInventory {
            launcher,
            format_revision: launcher.format_revision().into(),
            data_root: data_root.to_path_buf(),
            library_file,
            legacy_library_file,
            apps_root,
            apps_root_origin,
            entries,
            skipped_entries,
            original_will_be_modified: false,
            inventory_sha256: String::new(),
        };
        inventory.inventory_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&inventory)?));
        Ok(inventory)
    }

    fn inspect_launcher_entry(
        &self,
        launcher: LauncherKind,
        raw: RawEntry,
        apps_root: Option<&Path>,
        platform: Platform,
    ) -> LauncherLibraryEntry {
        let mut entry = LauncherLibraryEntry {
            index: raw.index,
            name: raw.name,
            repository_source: raw.source,
            repository: bounded_hint(&raw.repository),
            folder_name: bounded_hint(&raw.folder_name),
            install_path: None,
            explicit_install_path: false,
            status: LauncherEntryStatus::UnsafePath,
            candidate_port_ids: Vec::new(),
            detected_port_ids: Vec::new(),
            user_data_paths: Vec::new(),
            hints: LauncherEntryHints {
                preferred_version: raw.preferred_version.map(|text| bounded_hint(&text)),
                installed_version_label: None,
                selected_executable: None,
            },
            mods: None,
            explanation: String::new(),
            adopt_port_id: None,
            shares_folder_with: None,
            not_carried_over: raw.not_carried_over,
        };
        entry.candidate_port_ids =
            self.repository_candidates(&entry.repository_source, &raw.repository);
        let path =
            match resolve_install_path(raw.install_path.as_deref(), &raw.folder_name, apps_root) {
                Ok((path, explicit)) => {
                    entry.explicit_install_path = explicit;
                    path
                }
                Err(reason) => {
                    entry.explanation = reason;
                    return entry;
                }
            };
        entry.install_path = Some(path.clone());
        if crate::path::refuse_symlink_ancestors(&path).is_err() {
            entry.explanation =
                "The installation folder is reached through a symbolic link, so it was not inspected.".into();
            return entry;
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                entry.explanation = "The installation path is not a folder.".into();
                return entry;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                entry.status = LauncherEntryStatus::NotInstalled;
                entry.explanation =
                    "The launcher lists this app, but its installation folder is missing. If the apps folder moved, inspect again with its new location.".into();
                return entry;
            }
            Err(error) => {
                entry.explanation = format!("The installation folder could not be read: {error}");
                return entry;
            }
        }
        entry.hints.installed_version_label = read_hint(&path.join("version.txt"));
        entry.hints.selected_executable = read_hint(&path.join("selected_executable.txt"));
        if launcher == LauncherKind::Quiver {
            entry.mods = read_quiver_mods(&path);
        }
        self.classify_launcher_entry(&mut entry, &path, platform);
        entry
    }

    fn repository_candidates(&self, source: &str, repository: &str) -> Vec<String> {
        let provider = match source {
            "github" => ReleaseSource::Github,
            "gitlab" => ReleaseSource::Gitlab,
            _ => return Vec::new(),
        };
        let Some(repository) = normalized_repository(repository) else {
            return Vec::new();
        };
        self.catalog
            .ports()
            .iter()
            .filter(|port| {
                port.release.provider == provider
                    && normalized_repository(&port.release.repository).as_deref()
                        == Some(repository.as_str())
            })
            .map(|port| port.id.clone())
            .collect()
    }

    fn classify_launcher_entry(
        &self,
        entry: &mut LauncherLibraryEntry,
        path: &Path,
        platform: Platform,
    ) {
        if entry.candidate_port_ids.is_empty() {
            entry.status = LauncherEntryStatus::NotInCatalog;
            entry.explanation = if entry.repository.trim().is_empty() {
                "This app has no upstream repository, so Portcove cannot match it to a catalog port.".into()
            } else {
                "No catalog port uses this upstream repository.".into()
            };
            return;
        }
        let mut refusals = Vec::new();
        for id in &entry.candidate_port_ids {
            let Ok(port) = self.catalog.port(id) else {
                continue;
            };
            if !port.platforms.contains(&platform) {
                refusals.push(format!("{id} has no catalog route for this platform"));
                continue;
            }
            if port.release.provider == ReleaseSource::UserPrepared {
                refusals.push(format!("{id} uses external registration instead of a copy"));
                continue;
            }
            if self.detect_adoption_ports(path, Some(id)).is_ok() {
                entry.detected_port_ids.push(id.clone());
            }
        }
        match entry.detected_port_ids.as_slice() {
            [] if !refusals.is_empty() && refusals.len() == entry.candidate_port_ids.len() => {
                entry.status = LauncherEntryStatus::AdoptionUnsupported;
                entry.explanation = format!("{}.", refusals.join("; "));
            }
            [] => {
                entry.status = LauncherEntryStatus::UnrecognizedFiles;
                entry.explanation = "The upstream repository matches, but the catalog's declared executable is not in this folder. The files may be modified, incomplete or for another platform.".into();
            }
            [id] => {
                let id = id.clone();
                let port = self.catalog.port(&id).expect("detected port is cataloged");
                let refusal = Self::refuse_shipwright_adoption(port)
                    .and_then(|()| crate::runtime_data_policy::refuse_adoption(port));
                if let Err(error) = refusal {
                    entry.status = LauncherEntryStatus::AdoptionUnsupported;
                    entry.explanation = error.message;
                    return;
                }
                entry.user_data_paths = present_user_data(port, path, platform);
                entry.status = LauncherEntryStatus::ReadyToReview;
                entry.explanation = "Review the copy plan before Portcove copies this installation. The launcher's copy stays untouched.".into();
                entry.adopt_port_id = Some(id);
            }
            _ => {
                entry.status = LauncherEntryStatus::Ambiguous;
                entry.explanation = "Several catalog ports match these files. Choose the one this installation is for.".into();
            }
        }
    }
}

fn library_file(data_root: &Path) -> Result<(PathBuf, bool)> {
    let current = data_root.join("apps.json");
    if fs::symlink_metadata(&current).is_ok() {
        return Ok((current, false));
    }
    let legacy = data_root.join("games.json");
    if fs::symlink_metadata(&legacy).is_ok() {
        return Ok((legacy, true));
    }
    Err(PortcoveError::not_found(format!(
        "no apps.json or games.json was found in {}; choose the launcher's data folder",
        data_root.display()
    )))
}

fn settings_apps_root(data_root: &Path) -> (Option<PathBuf>, LauncherAppsRootOrigin) {
    let default = || {
        (
            Some(data_root.join("Apps")),
            LauncherAppsRootOrigin::Default,
        )
    };
    let settings = data_root.join("settings.json");
    if fs::symlink_metadata(&settings).is_err() {
        return default();
    }
    let Ok(bytes) = crate::path::read_bounded_regular(&settings, SETTINGS_FILE_LIMIT) else {
        return (None, LauncherAppsRootOrigin::Unresolved);
    };
    match serde_json::from_slice::<LauncherSettings>(without_bom(&bytes)) {
        Ok(LauncherSettings {
            apps_path: Some(path),
        }) if !path.trim().is_empty() => {
            let path = PathBuf::from(path.trim());
            if local_absolute(&path) {
                (Some(path), LauncherAppsRootOrigin::Settings)
            } else {
                (None, LauncherAppsRootOrigin::Unresolved)
            }
        }
        Ok(_) => default(),
        Err(_) => (None, LauncherAppsRootOrigin::Unresolved),
    }
}

fn parse_library(
    launcher: LauncherKind,
    bytes: &[u8],
) -> Result<(Vec<RawEntry>, Vec<LauncherLibrarySkippedEntry>)> {
    let root: serde_json::Value = serde_json::from_slice(without_bom(bytes)).map_err(|error| {
        PortcoveError::source(format!("the launcher library is not valid JSON: {error}"))
    })?;
    let mut arrays = Vec::new();
    match &root {
        serde_json::Value::Array(items) => arrays.push(items),
        serde_json::Value::Object(object) => {
            for key in ["apps", "standard", "experimental", "custom"] {
                match object.get(key) {
                    Some(serde_json::Value::Array(items)) => arrays.push(items),
                    Some(serde_json::Value::Null) | None => {}
                    Some(_) => {
                        return Err(PortcoveError::source(format!(
                            "the launcher library's `{key}` value is not a list"
                        )));
                    }
                }
            }
            if arrays.is_empty() {
                return Err(PortcoveError::unsupported(
                    "the launcher library has no apps list Portcove recognizes",
                ));
            }
        }
        _ => {
            return Err(PortcoveError::unsupported(
                "the launcher library has no apps list Portcove recognizes",
            ));
        }
    }
    let total = arrays.iter().map(|items| items.len()).sum::<usize>();
    if total > ENTRY_LIMIT {
        return Err(PortcoveError::unsupported(format!(
            "the launcher library lists {total} entries; Portcove inspects at most {ENTRY_LIMIT}"
        )));
    }
    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    for (index, item) in arrays.into_iter().flatten().enumerate() {
        match raw_entry(launcher, index, item) {
            Ok(entry) => entries.push(entry),
            Err(reason) => skipped.push(LauncherLibrarySkippedEntry { index, reason }),
        }
    }
    Ok((entries, skipped))
}

fn raw_entry(
    launcher: LauncherKind,
    index: usize,
    item: &serde_json::Value,
) -> std::result::Result<RawEntry, String> {
    let object = item
        .as_object()
        .ok_or_else(|| "entry is not an object".to_owned())?;
    let text = |key: &str| -> std::result::Result<Option<String>, String> {
        match object.get(key) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(serde_json::Value::String(value)) => Ok(Some(value.clone())),
            Some(_) => Err(format!("`{key}` is not text")),
        }
    };
    let repository = text("repository")?.unwrap_or_default();
    let source = match launcher {
        // GitHub Launcher only resolves GitHub repositories.
        LauncherKind::GithubLauncher => "github".to_owned(),
        LauncherKind::Quiver => match text("repositorySource")?
            .map(|source| source.trim().to_ascii_lowercase())
            .as_deref()
        {
            None | Some("") | Some("github") => "github".to_owned(),
            Some("gitlab") => "gitlab".to_owned(),
            Some("codeberg") => "codeberg".to_owned(),
            Some(other) => {
                return Err(format!("repository source `{other}` is not supported"));
            }
        },
    };
    let source = if repository.trim().is_empty() {
        "manual".to_owned()
    } else {
        source
    };
    Ok(RawEntry {
        index,
        name: bounded_hint(&text("name")?.unwrap_or_default()),
        source,
        repository,
        folder_name: text("folderName")?.unwrap_or_default(),
        install_path: text("installPath")?.filter(|path| !path.trim().is_empty()),
        preferred_version: text("preferredVersion")?.filter(|value| !value.trim().is_empty()),
        not_carried_over: [
            ("linuxCustomLaunchCommand", "custom launch command"),
            ("linuxRunner", "Linux runner"),
            ("linuxPrefixPath", "Wine prefix"),
            ("linuxProtonPath", "Proton path"),
        ]
        .into_iter()
        .filter(|(key, _)| {
            object
                .get(*key)
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
        })
        .map(|(_, label)| label.to_owned())
        .collect(),
    })
}

fn resolve_install_path(
    explicit: Option<&str>,
    folder_name: &str,
    apps_root: Option<&Path>,
) -> std::result::Result<(PathBuf, bool), String> {
    if let Some(explicit) = explicit {
        let path = PathBuf::from(explicit.trim());
        if !local_absolute(&path) {
            return Err(
                "The launcher's installPath is not an absolute folder on a local drive, so Portcove did not inspect it.".into(),
            );
        }
        if path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err("The launcher's installPath contains `..`; it was not inspected.".into());
        }
        return Ok((path, true));
    }
    let folder = folder_name.trim();
    let mut components = Path::new(folder).components();
    let single = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    ) && !folder.contains(['/', '\\', ':']);
    if !single {
        return Err(
            "The launcher's folder name is empty or is not a single folder; it was not inspected."
                .into(),
        );
    }
    let Some(apps_root) = apps_root else {
        return Err(
            "The launcher's apps folder is unknown. Inspect again with the apps folder location."
                .into(),
        );
    };
    Ok((apps_root.join(folder), false))
}

/// Metadata paths must name a local drive: network shares and device paths are
/// never contacted on the launcher's say-so.
fn local_absolute(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    match path.components().next() {
        Some(Component::Prefix(prefix)) => {
            matches!(prefix.kind(), std::path::Prefix::Disk(_))
        }
        Some(Component::RootDir) => !cfg!(windows),
        _ => false,
    }
}

fn without_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

fn normalized_repository(repository: &str) -> Option<String> {
    let mut value = repository.trim();
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "https://gitlab.com/",
        "http://gitlab.com/",
    ] {
        if value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix) {
            value = &value[prefix.len()..];
        }
    }
    let value = value.trim_end_matches('/');
    let value = value.strip_suffix(".git").unwrap_or(value);
    (value.contains('/') && !value.contains("://")).then(|| value.to_ascii_lowercase())
}

fn normalized_key(path: &Path) -> PathBuf {
    // Windows and default macOS volumes compare folder names case-insensitively.
    if cfg!(any(windows, target_os = "macos")) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

fn bounded_hint(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_control())
        .take(HINT_TEXT_LIMIT)
        .collect()
}

fn read_hint(path: &Path) -> Option<String> {
    let bytes = crate::path::read_bounded_regular(path, HINT_FILE_LIMIT).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| bounded_hint(line))
}

fn read_quiver_mods(install: &Path) -> Option<LauncherModInventory> {
    let sidecar = install.join(".quiver-mods.json");
    fs::symlink_metadata(&sidecar).ok()?;
    let unreadable = LauncherModInventory {
        records: 0,
        providers: Vec::new(),
        readable: false,
    };
    let Ok(bytes) = crate::path::read_bounded_regular(&sidecar, MOD_SIDECAR_LIMIT) else {
        return Some(unreadable);
    };
    let Ok(document) = serde_json::from_slice::<QuiverModsDocument>(without_bom(&bytes)) else {
        return Some(unreadable);
    };
    let providers = document
        .mods
        .iter()
        .filter_map(|record| record.provider.as_deref())
        .map(bounded_hint)
        .filter(|provider| !provider.is_empty())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    Some(LauncherModInventory {
        records: document.mods.len(),
        providers,
        readable: true,
    })
}

fn present_user_data(port: &PortDefinition, install: &Path, platform: Platform) -> Vec<PathBuf> {
    let Ok(qualification) = InstallQualification::from_port(port, platform) else {
        return Vec::new();
    };
    let Ok(executable) = crate::install::resolve_declared_executable(install, &qualification)
    else {
        return Vec::new();
    };
    let persistent_root = qualification.persistence_root(install, &executable);
    let prefix = persistent_root
        .strip_prefix(install)
        .map(Path::to_path_buf)
        .unwrap_or_default();
    crate::persistence::entries(port, &[&persistent_root])
        .unwrap_or_default()
        .into_iter()
        .filter(|relative| persistent_root.join(relative).exists())
        .map(|relative| prefix.join(relative))
        .collect()
}

#[cfg(test)]
#[path = "launcher_library_tests.rs"]
mod tests;
