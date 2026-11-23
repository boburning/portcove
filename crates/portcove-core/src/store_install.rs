//! Read-only detection of game folders that Steam, GOG and Epic installed on
//! this computer. Detected folders are search suggestions only: they are not
//! saved game-file folders, source registrations or setup intent, and nothing
//! here writes, moves or deletes anything inside a store's folder.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{PortcoveError, PortcoveService, Result, game_file_root::path_key};

#[cfg(test)]
#[path = "store_install_tests.rs"]
mod tests;

/// Largest store metadata file read (Steam VDF/ACF, Epic manifest). Real
/// files are a few kilobytes; a larger one is reported as unreadable.
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
/// Directory entries examined in one manifest directory for the suggestion
/// list. The ownership check reads every entry.
const MAX_MANIFEST_DIRECTORY_ENTRIES: usize = 16_384;
/// Installs reported in one detection.
const MAX_INSTALLS: usize = 4_096;
/// Characters kept from a store title.
const MAX_TITLE_CHARS: usize = 256;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum GameStore {
    Steam,
    Gog,
    Epic,
}

/// One game folder a store installed, as the store's own metadata records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StoreGameInstall {
    pub store: GameStore,
    /// Stable store product identity when the installation metadata supplies one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
    /// The store's title for the game; a label, never an identity.
    pub title: String,
    /// Canonical existing folder.
    pub path: PathBuf,
    /// The saved game-file folder at exactly this path, when there is one.
    pub saved_root_id: Option<String>,
    /// Reviewed search hint. The source profile still verifies the actual files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_folder: Option<StoreOriginalFolder>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StoreOriginalFolder {
    pub profile_id: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StoreGameInstalls {
    /// The stores this host's metadata was read for. A store missing here was
    /// not checked, which is different from having no games installed.
    pub checked_stores: Vec<GameStore>,
    pub installs: Vec<StoreGameInstall>,
    /// Store entries left out because their metadata was unreadable, malformed,
    /// unsafe or named a folder that does not exist.
    pub skipped_entries: u32,
    /// Whether a detection bound stopped the list early.
    pub limited: bool,
}

/// One installed game recorded in the Windows registry by GOG.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredStoreInstall {
    pub title: String,
    pub path: PathBuf,
    pub product_id: Option<String>,
}

/// Every GOG install record the host could read, and how many it could not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegisteredStoreInstalls {
    pub installs: Vec<RegisteredStoreInstall>,
    /// Records that exist but could not be read. Any such record means the
    /// store's install locations are not completely known.
    pub unread_records: u32,
}

impl From<Vec<RegisteredStoreInstall>> for RegisteredStoreInstalls {
    fn from(installs: Vec<RegisteredStoreInstall>) -> Self {
        Self {
            installs,
            unread_records: 0,
        }
    }
}

/// Host facts behind store detection. Production reads the registry and
/// default locations; tests supply fixture folders.
pub trait StoreInstallHost: Send + Sync {
    /// Steam client folders (each normally holds `steamapps`).
    fn steam_client_roots(&self) -> Vec<PathBuf>;
    /// GOG installs recorded in the Windows registry, all of them.
    fn gog_registered_installs(&self) -> RegisteredStoreInstalls;
    /// Epic Games Launcher manifest folders holding `*.item` files.
    fn epic_manifest_dirs(&self) -> Vec<PathBuf>;
    /// The stores this host can read.
    fn checked_stores(&self) -> Vec<GameStore> {
        vec![GameStore::Steam, GameStore::Gog, GameStore::Epic]
    }
}

/// Reads no store. Unit-test services default to it so they never read the
/// machine's real store metadata.
#[cfg(test)]
pub(crate) struct NoStoreInstallHost;

#[cfg(test)]
impl StoreInstallHost for NoStoreInstallHost {
    fn steam_client_roots(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    fn gog_registered_installs(&self) -> RegisteredStoreInstalls {
        RegisteredStoreInstalls::default()
    }

    fn epic_manifest_dirs(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    fn checked_stores(&self) -> Vec<GameStore> {
        Vec::new()
    }
}

/// The host a new service uses.
pub(crate) fn default_host() -> std::sync::Arc<dyn StoreInstallHost> {
    #[cfg(test)]
    {
        std::sync::Arc::new(NoStoreInstallHost)
    }
    #[cfg(not(test))]
    {
        std::sync::Arc::new(SystemStoreInstallHost)
    }
}

/// A reviewed hint for one source identity and store product. Shipped with the
/// application alongside its original-file definitions.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoreOriginalLayout {
    store: GameStore,
    product_id: String,
    profile_id: String,
    relative_directory: Option<String>,
    required_directories: Vec<String>,
}

fn parse_store_original_layouts(document: &str) -> Result<Vec<StoreOriginalLayout>> {
    let rows: Vec<StoreOriginalLayout> = serde_json::from_str(document)?;
    let mut identities = BTreeSet::new();
    if rows.len() > 1024 {
        return Err(PortcoveError::verification(
            "store original layouts exceed their row limit",
        ));
    }
    for row in &rows {
        if row.store == GameStore::Epic
            || product_number(&row.product_id)
                .is_none_or(|number| number.to_string() != row.product_id)
            || row.profile_id.is_empty()
            || row.profile_id.len() > 128
            || !row
                .profile_id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || !identities.insert((row.store, &row.product_id, &row.profile_id))
            || row.required_directories.len() > 16
        {
            return Err(PortcoveError::verification(
                "invalid or duplicate store original layout",
            ));
        }
        for directory in row
            .relative_directory
            .iter()
            .chain(&row.required_directories)
        {
            crate::archive::validate_relative_path(directory, false)?;
        }
    }
    Ok(rows)
}

fn embedded_store_original_layouts() -> &'static [StoreOriginalLayout] {
    static LAYOUTS: OnceLock<Vec<StoreOriginalLayout>> = OnceLock::new();
    LAYOUTS.get_or_init(|| {
        parse_store_original_layouts(include_str!("../catalog/store-original-layouts.json"))
            .unwrap_or_else(|error| {
                tracing::error!(message = %error, "could not load bundled store original layouts");
                Vec::new()
            })
    })
}

/// What a suggestion listing found. Ownership decisions never use it; see
/// [`store_folder_ownership`].
#[derive(Debug, Default)]
struct Detection<'a> {
    report: StoreGameInstalls,
    seen: BTreeMap<String, Option<usize>>,
    requested_profile: Option<String>,
    layouts: &'a [StoreOriginalLayout],
}

impl Detection<'_> {
    fn skip(&mut self) {
        self.report.skipped_entries = self.report.skipped_entries.saturating_add(1);
    }

    fn add(&mut self, store: GameStore, title: &str, path: &Path, product_id: Option<String>) {
        let candidate = original_folder(
            self.layouts,
            store,
            product_id.as_deref(),
            path,
            self.requested_profile.as_deref(),
        );
        let Some(path) = existing_folder(path) else {
            self.skip();
            return;
        };
        let Ok(text) = crate::path::unicode(&path, "store install") else {
            self.skip();
            return;
        };
        let key = path_key(&text);
        if let Some(index) = self.seen.get(&key) {
            if let Some(row) = index.and_then(|index| self.report.installs.get_mut(index))
                && row.store == store
                && row.product_id != product_id
            {
                row.product_id = None;
                row.original_folder = None;
            }
            return;
        }
        if self.report.installs.len() >= MAX_INSTALLS {
            self.seen.insert(key, None);
            self.report.limited = true;
            return;
        }
        let title = clean_title(title)
            .or_else(|| {
                path.file_name()
                    .and_then(|name| clean_title(&name.to_string_lossy()))
            })
            .unwrap_or_default();
        self.seen.insert(key, Some(self.report.installs.len()));
        self.report.installs.push(StoreGameInstall {
            store,
            product_id,
            title,
            path,
            saved_root_id: None,
            original_folder: candidate,
        });
    }
}

fn detect_for_profile(host: &dyn StoreInstallHost, profile_id: Option<&str>) -> Detection<'static> {
    detect_with_layouts(host, profile_id, embedded_store_original_layouts())
}

fn detect_with_layouts<'a>(
    host: &dyn StoreInstallHost,
    profile_id: Option<&str>,
    layouts: &'a [StoreOriginalLayout],
) -> Detection<'a> {
    let mut detection = Detection {
        requested_profile: profile_id.map(str::to_owned),
        layouts,
        ..Detection::default()
    };
    detection.report.checked_stores = host.checked_stores();
    detect_steam(host, &mut detection);
    let gog = host.gog_registered_installs();
    detection.report.skipped_entries = detection
        .report
        .skipped_entries
        .saturating_add(gog.unread_records);
    for install in gog.installs {
        detection.add(
            GameStore::Gog,
            &install.title,
            &install.path,
            install.product_id,
        );
    }
    for directory in host.epic_manifest_dirs() {
        detect_epic(&directory, &mut detection);
    }
    detection.report.installs.sort_by(|left, right| {
        left.title
            .to_lowercase()
            .cmp(&right.title.to_lowercase())
            .then(left.store.cmp(&right.store))
            .then(left.path.cmp(&right.path))
    });
    detection
}

/// Every Steam library this host's Steam clients record.
#[derive(Debug, Default)]
struct SteamLibraries {
    /// Canonical `steamapps` folders, kept as resolved so a linked or
    /// differently cased folder is still read and protected as itself.
    libraries: Vec<PathBuf>,
    /// Listed libraries whose folder does not exist (an emptied or removed
    /// library). Nothing there can hold the player's files.
    missing: u32,
    /// Library lists or listed folders that could not be read, so some
    /// library locations are unknown.
    unread: Vec<PathBuf>,
}

/// Read every client's library list. Default client locations are often
/// simply absent; a library Steam lists but that cannot be read stays unknown.
fn steam_libraries(host: &dyn StoreInstallHost) -> SteamLibraries {
    let mut found = SteamLibraries::default();
    let mut library_keys = BTreeSet::new();
    let mut push = |path: &Path, listed: bool, found: &mut SteamLibraries| {
        let steamapps = path.join("steamapps");
        match folder_state(&steamapps) {
            FolderState::Present(steamapps) => {
                if library_keys.insert(path_key(&steamapps.to_string_lossy())) {
                    found.libraries.push(steamapps);
                }
            }
            FolderState::Absent if listed => found.missing = found.missing.saturating_add(1),
            FolderState::Absent => {}
            FolderState::Unreadable => found.unread.push(steamapps),
        }
    };
    // A client found through two locations (or a link) is read once, so its
    // listed libraries are neither reread nor counted twice.
    let mut client_keys = BTreeSet::new();
    for root in host.steam_client_roots() {
        let key = std::fs::canonicalize(&root).map_or_else(
            |_| path_key(&root.to_string_lossy()),
            |canonical| path_key(&canonical.to_string_lossy()),
        );
        if !client_keys.insert(key) {
            continue;
        }
        push(&root, false, &mut found);
        let folders = root.join("steamapps").join("libraryfolders.vdf");
        match std::fs::symlink_metadata(&folders) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                found.unread.push(folders);
                continue;
            }
            Ok(_) => {}
        }
        match read_text(&folders).and_then(|text| steam_library_paths(&text)) {
            Some(paths) => {
                for library in paths {
                    push(&library, true, &mut found);
                }
            }
            None => found.unread.push(folders),
        }
    }
    found
}

fn detect_steam(host: &dyn StoreInstallHost, detection: &mut Detection<'_>) {
    let found = steam_libraries(host);
    let unread = u32::try_from(found.unread.len()).unwrap_or(u32::MAX);
    detection.report.skipped_entries = detection
        .report
        .skipped_entries
        .saturating_add(found.missing)
        .saturating_add(unread);
    let libraries = found.libraries;
    for steamapps in libraries {
        for manifest in manifest_files(&steamapps, detection, steam_manifest_name) {
            let Some(text) = read_text(&manifest) else {
                detection.skip();
                continue;
            };
            let Some((title, installdir, app_id)) = steam_app_manifest(&text) else {
                detection.skip();
                continue;
            };
            if !single_normal_component(&installdir) {
                detection.skip();
                continue;
            }
            detection.add(
                GameStore::Steam,
                &title,
                &steamapps.join("common").join(installdir),
                app_id
                    .filter(|id| {
                        manifest
                            .file_stem()
                            .and_then(|name| name.to_str())
                            .and_then(|name| name.strip_prefix("appmanifest_"))
                            .and_then(product_number)
                            == Some(*id)
                    })
                    .map(|id| id.to_string()),
            );
        }
    }
}

fn detect_epic(directory: &Path, detection: &mut Detection<'_>) {
    for manifest in manifest_files(directory, detection, |name| name.ends_with(".item")) {
        let Some(item) = read_text(&manifest)
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        else {
            detection.skip();
            continue;
        };
        if item
            .get("bIsIncompleteInstall")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            detection.skip();
            continue;
        }
        let (Some(title), Some(location)) = (
            item.get("DisplayName").and_then(serde_json::Value::as_str),
            item.get("InstallLocation")
                .and_then(serde_json::Value::as_str),
        ) else {
            detection.skip();
            continue;
        };
        let token = |field| {
            item.get(field)
                .and_then(serde_json::Value::as_str)
                .filter(|text| {
                    !text.is_empty()
                        && text.len() <= 128
                        && text.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                        })
                })
        };
        let product_id = token("CatalogNamespace")
            .zip(token("CatalogItemId"))
            .map(|(namespace, item)| format!("{namespace}:{item}"));
        detection.add(GameStore::Epic, title, Path::new(location), product_id);
    }
}

/// Bounded, sorted regular files whose names `accept` admits.
fn manifest_files(
    directory: &Path,
    detection: &mut Detection<'_>,
    accept: impl Fn(&str) -> bool,
) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= MAX_MANIFEST_DIRECTORY_ENTRIES {
            detection.report.limited = true;
            break;
        }
        let Ok(entry) = entry else {
            detection.skip();
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if accept(&name.to_ascii_lowercase()) {
            files.push(entry.path());
        }
    }
    files.sort();
    files
}

fn read_text(path: &Path) -> Option<String> {
    let bytes = crate::path::read_bounded_regular(path, MAX_METADATA_BYTES).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    Some(
        text.strip_prefix('\u{feff}')
            .map(str::to_owned)
            .unwrap_or(text),
    )
}

/// What reading one store-recorded location established.
enum FolderState {
    /// It exists; the canonical path.
    Present(PathBuf),
    /// Nothing exists there.
    Absent,
    /// It could not be resolved (a relative record, a permission or device
    /// error), so where it really is stays unknown.
    Unreadable,
}

fn folder_state(path: &Path) -> FolderState {
    if !path.is_absolute() {
        return FolderState::Unreadable;
    }
    match std::fs::canonicalize(path) {
        Ok(canonical) => FolderState::Present(canonical),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => FolderState::Absent,
        Err(_) => FolderState::Unreadable,
    }
}

/// An absolute path to an existing folder, canonicalized.
fn existing_folder(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    std::fs::metadata(&canonical)
        .ok()?
        .is_dir()
        .then_some(canonical)
}

fn single_normal_component(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !name.contains(['/', '\\', ':'])
}

fn clean_title(title: &str) -> Option<String> {
    let cleaned = title
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_TITLE_CHARS)
        .collect::<String>();
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_owned())
}

/// Tokens of Valve's KeyValues text: quoted strings and braces.
#[derive(Debug, PartialEq, Eq)]
enum VdfToken {
    Text(String),
    Open,
    Close,
}

fn vdf_tokens(text: &str) -> Option<Vec<VdfToken>> {
    let mut tokens = Vec::new();
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '{' => tokens.push(VdfToken::Open),
            '}' => tokens.push(VdfToken::Close),
            '"' => {
                let mut value = String::new();
                loop {
                    match characters.next()? {
                        '"' => break,
                        '\\' => match characters.next()? {
                            'n' => value.push('\n'),
                            't' => value.push('\t'),
                            other => value.push(other),
                        },
                        other => value.push(other),
                    }
                }
                tokens.push(VdfToken::Text(value));
            }
            '/' if characters.peek() == Some(&'/') => {
                for next in characters.by_ref() {
                    if next == '\n' {
                        break;
                    }
                }
            }
            character if character.is_whitespace() => {}
            _ => return None,
        }
    }
    Some(tokens)
}

/// Key/value string pairs with their nesting depth (1 = inside the root block).
fn vdf_pairs(tokens: &[VdfToken]) -> Option<Vec<(usize, String, String)>> {
    let mut pairs = Vec::new();
    let mut depth = 0_usize;
    let mut index = 0;
    while index < tokens.len() {
        match &tokens[index] {
            VdfToken::Open => depth += 1,
            VdfToken::Close => depth = depth.checked_sub(1)?,
            VdfToken::Text(key) => match tokens.get(index + 1) {
                Some(VdfToken::Text(value)) => {
                    pairs.push((depth, key.clone(), value.clone()));
                    index += 1;
                }
                Some(VdfToken::Open) => {}
                _ => return None,
            },
        }
        index += 1;
    }
    (depth == 0).then_some(pairs)
}

/// Library folders listed by Steam's `libraryfolders.vdf`, in both the
/// current (`"path"` inside numbered blocks) and the older (numbered string
/// values) layouts.
/// `None` when the file is not a readable library list.
fn steam_library_paths(text: &str) -> Option<Vec<PathBuf>> {
    let pairs = vdf_tokens(text).and_then(|tokens| vdf_pairs(&tokens))?;
    let paths = pairs
        .into_iter()
        .filter(|(depth, key, _)| {
            (*depth == 2 && key.eq_ignore_ascii_case("path"))
                || (*depth == 1 && !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .map(|(_, _, value)| PathBuf::from(value))
        .collect();
    Some(paths)
}

/// `(name, installdir)` from a Steam `appmanifest_*.acf`.
fn product_number(text: &str) -> Option<u64> {
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>().ok().filter(|id| *id != 0)
}

fn steam_app_manifest(text: &str) -> Option<(String, String, Option<u64>)> {
    let tokens = vdf_tokens(text)?;
    let pairs = vdf_pairs(&tokens)?;
    let field = |name: &str| {
        pairs
            .iter()
            .find(|(depth, key, _)| *depth == 1 && key.eq_ignore_ascii_case(name))
            .map(|(_, _, value)| value.clone())
    };
    let installdir = field("installdir").filter(|value| !value.is_empty())?;
    let mut ids = pairs
        .iter()
        .filter(|(depth, key, _)| *depth == 1 && key.eq_ignore_ascii_case("appid"));
    let id = ids.next().and_then(|(_, _, value)| product_number(value));
    let unique_directory = pairs
        .iter()
        .filter(|(depth, key, _)| *depth == 1 && key.eq_ignore_ascii_case("installdir"))
        .count()
        == 1;
    let app_id = if ids.next().is_none() && unique_directory && single_app_state(&tokens) {
        id
    } else {
        None
    };
    Some((field("name").unwrap_or_default(), installdir, app_id))
}

fn single_app_state(tokens: &[VdfToken]) -> bool {
    let [
        VdfToken::Text(name),
        VdfToken::Open,
        body @ ..,
        VdfToken::Close,
    ] = tokens
    else {
        return false;
    };
    if !name.eq_ignore_ascii_case("AppState") {
        return false;
    }
    let mut depth = 1;
    for token in body {
        match token {
            VdfToken::Open => depth += 1,
            VdfToken::Close => depth -= 1,
            VdfToken::Text(_) => {}
        }
        if depth == 0 {
            return false;
        }
    }
    depth == 1
}

fn original_folder(
    layouts: &[StoreOriginalLayout],
    store: GameStore,
    product_id: Option<&str>,
    install_path: &Path,
    requested_profile: Option<&str>,
) -> Option<StoreOriginalFolder> {
    let product_id = product_id?;
    let mut matching = layouts.iter().filter(|row| {
        row.store == store
            && row.product_id == product_id
            && requested_profile.is_none_or(|profile| profile == row.profile_id)
    });
    let layout = matching.next()?;
    // Anthologies only produce an original-folder hint after the player has
    // selected a specific source profile.
    if matching.next().is_some() {
        return None;
    }
    let directory = install_path.join(layout.relative_directory.as_deref().unwrap_or(""));
    crate::path::refuse_symlink_ancestors(&directory).ok()?;
    let install = existing_folder(install_path)?;
    let path = existing_folder(&directory)?;
    if !inside(&path, &install) {
        return None;
    }
    for name in &layout.required_directories {
        let required = path.join(name);
        crate::path::refuse_symlink_ancestors(&required).ok()?;
        if !required.is_dir() {
            return None;
        }
    }
    Some(StoreOriginalFolder {
        profile_id: layout.profile_id.clone(),
        path,
    })
}

fn inside(path: &Path, folder: &Path) -> bool {
    crate::game_file_root::key_inside(path, &path_key(&folder.to_string_lossy()))
}

fn store_name(store: GameStore) -> &'static str {
    match store {
        GameStore::Steam => "Steam",
        GameStore::Gog => "GOG",
        GameStore::Epic => "Epic",
    }
}

/// The nearest ancestor (or `path` itself) named `steamapps`, compared
/// case-insensitively: Steam keeps every library's games there, so a Move from
/// it is refused even when Steam's own metadata could not be read.
fn steamapps_ancestor(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|ancestor| {
            ancestor
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("steamapps"))
        })
        .map(Path::to_path_buf)
}

/// A suggested folder that would make a poor search root or contains this
/// library: a filesystem root, the home folder, or an ancestor of `library`.
fn unsuitable_suggestion(path: &Path, library: &Path, home: Option<&Path>) -> bool {
    path.parent().is_none() || home == Some(path) || inside(library, path)
}

impl PortcoveService {
    /// Game folders Steam, GOG and Epic installed on this computer, read from
    /// the stores' own metadata. Reads only; failures leave a shorter list.
    pub fn store_game_installs(&self) -> Result<StoreGameInstalls> {
        self.store_game_installs_with_profile(None)
    }

    /// Query a selected game's original profile, including store bundles that
    /// contain more than one game's data. A hint still does not admit the files.
    pub fn store_game_installs_for_profile(&self, profile_id: &str) -> Result<StoreGameInstalls> {
        self.catalog().source_profile(profile_id)?;
        self.store_game_installs_with_profile(Some(profile_id))
    }

    fn store_game_installs_with_profile(
        &self,
        profile_id: Option<&str>,
    ) -> Result<StoreGameInstalls> {
        let mut report = detect_for_profile(self.store_install_host(), profile_id).report;
        let library = std::fs::canonicalize(self.library().root())
            .unwrap_or_else(|_| self.library().root().to_path_buf());
        let home = directories::BaseDirs::new()
            .and_then(|base| std::fs::canonicalize(base.home_dir()).ok());
        let before = report.installs.len();
        report
            .installs
            .retain(|install| !unsuitable_suggestion(&install.path, &library, home.as_deref()));
        report.skipped_entries = report
            .skipped_entries
            .saturating_add(u32::try_from(before - report.installs.len()).unwrap_or(u32::MAX));
        let roots = self.library().game_file_roots()?;
        for install in &mut report.installs {
            if install.original_folder.as_ref().is_some_and(|original| {
                self.catalog().source_profile(&original.profile_id).is_err()
            }) {
                install.original_folder = None;
            }
            let key = path_key(&install.path.to_string_lossy());
            install.saved_root_id = roots
                .iter()
                .find(|root| path_key(&root.path.to_string_lossy()) == key)
                .map(|root| root.id.clone());
        }
        Ok(report)
    }

    /// Refuse to remove files from a folder a store installed, or a folder
    /// that contains one: the store's game would lose them. `path` is
    /// canonical. A Move is allowed only when every store this host reads was
    /// read completely and none of them covers `path`.
    pub(crate) fn refuse_store_install_move(&self, profile_id: &str, path: &Path) -> Result<()> {
        match store_folder_ownership(self.store_install_host(), path) {
            StoreFolderOwnership::NotStoreOwned => Ok(()),
            StoreFolderOwnership::StoreOwned {
                store,
                folder,
                evidence,
            } => {
                let store_name = store_name(store);
                // A folder recognized only by its `steamapps` name may not be
                // Steam's, so its message does not claim a Steam game.
                let message = match evidence {
                    OwnershipEvidence::StoreRecord => format!(
                        "These files are part of a game {store_name} installed. Moving them would break that game; copy them into Portcove or use them where they are."
                    ),
                    OwnershipEvidence::SteamappsName => "These files are in a folder named steamapps, where Steam keeps its games. Moving them could break a Steam game; copy them into Portcove or use them where they are.".to_owned(),
                };
                Err(PortcoveError::conflict(message)
                    .detail("profile_id", profile_id)
                    .detail("store_ownership", "store_owned")
                    .detail("store", store_name)
                    .detail("store_folder", folder.display().to_string()))
            }
            StoreFolderOwnership::Undetermined { unread } => {
                let mut stores = unread.iter().map(|(store, _)| *store).collect::<Vec<_>>();
                stores.dedup();
                let names = store_list(&stores);
                let (_, first) = &unread[0];
                Err(PortcoveError::conflict(format!(
                    "Portcove could not read every game location {names} recorded, so it cannot confirm these files are safe to move. Copy them into Portcove or use them where they are."
                ))
                .detail("profile_id", profile_id)
                .detail("store_ownership", "not_checked")
                .detail(
                    "unchecked_stores",
                    stores
                        .iter()
                        .map(|store| store_name(*store))
                        .collect::<Vec<_>>()
                        .join(","),
                )
                .detail("unread_record", first)
                .detail("unread_records", unread.len().to_string()))
            }
        }
    }
}

/// How a store's claim on a path was established.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OwnershipEvidence {
    /// The store's own install records name the folder.
    StoreRecord,
    /// A folder on the path is named `steamapps`; Steam keeps every game in
    /// one, so this needs no metadata.
    SteamappsName,
}

/// Whether one selected file or folder belongs to a store, decided only from
/// complete evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StoreFolderOwnership {
    /// Every store this host reads was read completely, and none of them
    /// installed into, under or around the path.
    NotStoreOwned,
    /// The path is inside, or contains, a folder a store installed.
    StoreOwned {
        store: GameStore,
        folder: PathBuf,
        evidence: OwnershipEvidence,
    },
    /// No record covers the path, but some records could not be read, so
    /// ownership is not yet known. Never treated as permission.
    Undetermined {
        /// Each unread record's store and location (a file, folder or
        /// registry key), in reading order. Never empty.
        unread: Vec<(GameStore, String)>,
    },
}

/// Decide whether a Move of `path` (canonical) could remove a store's files.
/// Unlike the suggestion list, this reads every record with no count bound:
/// each record is checked and dropped, so memory stays flat. Only a store this
/// host can read is consulted; one it cannot read has no records here.
pub(crate) fn store_folder_ownership(
    host: &dyn StoreInstallHost,
    path: &Path,
) -> StoreFolderOwnership {
    if let Some(folder) = steamapps_ancestor(path) {
        return StoreFolderOwnership::StoreOwned {
            store: GameStore::Steam,
            folder,
            evidence: OwnershipEvidence::SteamappsName,
        };
    }
    let covers = |folder: &Path| inside(path, folder) || inside(folder, path);
    let owned = |store, folder: PathBuf| StoreFolderOwnership::StoreOwned {
        store,
        folder,
        evidence: OwnershipEvidence::StoreRecord,
    };
    let mut unread = Vec::<(GameStore, String)>::new();
    let stores = host.checked_stores();
    if stores.contains(&GameStore::Steam) {
        let found = steam_libraries(host);
        if let Some(folder) = found.libraries.iter().find(|folder| covers(folder)) {
            return owned(GameStore::Steam, folder.clone());
        }
        for steamapps in &found.libraries {
            if let Some(folder) = record_ownership(
                GameStore::Steam,
                steamapps,
                steam_manifest_name,
                |text| steam_install_location(steamapps, text),
                &covers,
                &mut unread,
            ) {
                return owned(GameStore::Steam, folder);
            }
        }
        unread.extend(
            found
                .unread
                .iter()
                .map(|location| (GameStore::Steam, location.display().to_string())),
        );
    }
    if stores.contains(&GameStore::Gog) {
        let records = host.gog_registered_installs();
        for install in records.installs {
            match folder_state(&install.path) {
                FolderState::Present(folder) if covers(&folder) => {
                    return owned(GameStore::Gog, folder);
                }
                FolderState::Present(_) | FolderState::Absent => {}
                FolderState::Unreadable => {
                    unread.push((GameStore::Gog, install.path.display().to_string()));
                }
            }
        }
        if records.unread_records > 0 {
            unread.push((
                GameStore::Gog,
                format!("{} registry records", records.unread_records),
            ));
        }
    }
    if stores.contains(&GameStore::Epic) {
        for directory in host.epic_manifest_dirs() {
            if let Some(folder) = record_ownership(
                GameStore::Epic,
                &directory,
                |name| name.ends_with(".item"),
                epic_install_location,
                &covers,
                &mut unread,
            ) {
                return owned(GameStore::Epic, folder);
            }
        }
    }
    if unread.is_empty() {
        StoreFolderOwnership::NotStoreOwned
    } else {
        StoreFolderOwnership::Undetermined { unread }
    }
}

/// Read every record file in `directory` whose lowercased name `accept`
/// admits, returning the first recorded location that `covers` matches.
/// `location` turns one record's text into its install location, or `None`
/// when the record cannot be understood. An unreadable listing, file or
/// location is added to `unread`; a missing folder or record is not.
fn record_ownership(
    store: GameStore,
    directory: &Path,
    accept: impl Fn(&str) -> bool,
    location: impl Fn(&str) -> Option<PathBuf>,
    covers: &dyn Fn(&Path) -> bool,
    unread: &mut Vec<(GameStore, String)>,
) -> Option<PathBuf> {
    let mut unreadable = |location: &Path| {
        unread.push((store, location.display().to_string()));
    };
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => {
            unreadable(directory);
            return None;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            unreadable(directory);
            continue;
        };
        let name = entry.file_name();
        if !name
            .to_str()
            .is_some_and(|name| accept(&name.to_ascii_lowercase()))
        {
            continue;
        }
        let record = entry.path();
        if std::fs::symlink_metadata(&record)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            // Removed while listing.
            continue;
        }
        let Some(path) = read_text(&record).and_then(|text| location(&text)) else {
            unreadable(&record);
            continue;
        };
        match folder_state(&path) {
            FolderState::Present(folder) if covers(&folder) => return Some(folder),
            FolderState::Present(_) | FolderState::Absent => {}
            FolderState::Unreadable => unreadable(&record),
        }
    }
    None
}

/// An Epic `*.item` manifest's install location. An unfinished install still
/// belongs to Epic.
fn epic_install_location(text: &str) -> Option<PathBuf> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .get("InstallLocation")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
}

/// A Steam app manifest's game folder. Steam keeps it in `common`, but that
/// entry may be a link to a folder elsewhere.
fn steam_install_location(steamapps: &Path, text: &str) -> Option<PathBuf> {
    let (_, installdir, _) = steam_app_manifest(text)?;
    single_normal_component(&installdir).then(|| steamapps.join("common").join(installdir))
}

fn steam_manifest_name(name: &str) -> bool {
    name.starts_with("appmanifest_") && name.ends_with(".acf")
}

/// "Steam", "Steam and GOG", "Steam, GOG and Epic".
fn store_list(stores: &[GameStore]) -> String {
    let names = stores
        .iter()
        .map(|store| store_name(*store))
        .collect::<Vec<_>>();
    match names.as_slice() {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Default locations and, on Windows, the stores' registry records.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemStoreInstallHost;

impl StoreInstallHost for SystemStoreInstallHost {
    fn checked_stores(&self) -> Vec<GameStore> {
        if cfg!(windows) {
            vec![GameStore::Steam, GameStore::Gog, GameStore::Epic]
        } else {
            vec![GameStore::Steam]
        }
    }

    fn steam_client_roots(&self) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        #[cfg(windows)]
        {
            roots.extend(windows::steam_registry_roots());
            for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
                if let Some(folder) = std::env::var_os(variable) {
                    roots.push(PathBuf::from(folder).join("Steam"));
                }
            }
        }
        #[cfg(not(windows))]
        if let Some(base) = directories::BaseDirs::new() {
            let home = base.home_dir();
            if cfg!(target_os = "macos") {
                roots.push(home.join("Library/Application Support/Steam"));
            } else {
                roots.push(home.join(".steam/steam"));
                roots.push(home.join(".local/share/Steam"));
                roots.push(home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"));
            }
        }
        roots
    }

    fn gog_registered_installs(&self) -> RegisteredStoreInstalls {
        #[cfg(windows)]
        {
            windows::gog_registered_installs()
        }
        #[cfg(not(windows))]
        {
            RegisteredStoreInstalls::default()
        }
    }

    fn epic_manifest_dirs(&self) -> Vec<PathBuf> {
        #[cfg(windows)]
        {
            std::env::var_os("ProgramData")
                .map(|data| {
                    vec![
                        PathBuf::from(data)
                            .join("Epic")
                            .join("EpicGamesLauncher")
                            .join("Data")
                            .join("Manifests"),
                    ]
                })
                .unwrap_or_default()
        }
        #[cfg(not(windows))]
        {
            Vec::new()
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::{
        ffi::c_void,
        path::PathBuf,
        ptr::{null, null_mut},
    };

    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS},
        System::Registry::{
            HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, RRF_RT_REG_SZ,
            RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW,
        },
    };

    use super::{RegisteredStoreInstall, RegisteredStoreInstalls, product_number};

    /// Registry key names are at most 255 characters (a Windows limit).
    const MAX_NAME_UNITS: usize = 256;
    /// Largest string value read; a path or title is far smaller.
    const MAX_VALUE_BYTES: u32 = 64 * 1024;

    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: this wrapper owns one successfully opened key.
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open(parent: HKEY, path: &str, view: u32) -> Option<Key> {
        open_status(parent, path, view).ok()
    }

    /// The key, or the status Windows returned for it.
    fn open_status(parent: HKEY, path: &str, view: u32) -> Result<Key, u32> {
        let path = wide(path);
        let mut key: HKEY = null_mut();
        // SAFETY: the name is null terminated and `key` is a live output slot.
        let status = unsafe { RegOpenKeyExW(parent, path.as_ptr(), 0, KEY_READ | view, &mut key) };
        if status == ERROR_SUCCESS {
            Ok(Key(key))
        } else {
            Err(status)
        }
    }

    /// Whether a value exists at all, whatever its type or size.
    fn value_exists(key: &Key, name: &str) -> bool {
        let name = wide(name);
        let mut bytes = 0_u32;
        // SAFETY: the name is null terminated; null data asks only for the size.
        let status = unsafe {
            RegGetValueW(
                key.0,
                null(),
                name.as_ptr(),
                windows_sys::Win32::System::Registry::RRF_RT_ANY,
                null_mut(),
                null_mut(),
                &mut bytes,
            )
        };
        status != ERROR_FILE_NOT_FOUND
    }

    fn string(key: &Key, name: &str) -> Option<String> {
        let name = wide(name);
        let mut bytes = 0_u32;
        // SAFETY: the name is null terminated; null data asks only for the size.
        let status = unsafe {
            RegGetValueW(
                key.0,
                null(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                null_mut(),
                null_mut(),
                &mut bytes,
            )
        };
        if status != ERROR_SUCCESS || !(2..=MAX_VALUE_BYTES).contains(&bytes) {
            return None;
        }
        let mut value = vec![0_u16; bytes as usize / 2];
        // SAFETY: `value` has the capacity Windows reported and every pointer
        // stays live for the call.
        let status = unsafe {
            RegGetValueW(
                key.0,
                null(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                null_mut(),
                value.as_mut_ptr().cast::<c_void>(),
                &mut bytes,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        value.truncate(bytes as usize / 2);
        while value.last() == Some(&0) {
            value.pop();
        }
        String::from_utf16(&value)
            .ok()
            .filter(|value| !value.is_empty())
    }

    pub(super) fn steam_registry_roots() -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if let Some(key) = open(HKEY_CURRENT_USER, "Software\\Valve\\Steam", 0)
            && let Some(path) = string(&key, "SteamPath")
        {
            roots.push(PathBuf::from(path.replace('/', "\\")));
        }
        if let Some(key) = open(
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\Valve\\Steam",
            KEY_WOW64_32KEY,
        ) && let Some(path) = string(&key, "InstallPath")
        {
            roots.push(PathBuf::from(path));
        }
        roots
    }

    /// Every game key under GOG's registry list. A key that exists but cannot
    /// be read, or whose install path cannot be read, is counted as unread so
    /// an incomplete list is never mistaken for a complete one.
    pub(super) fn gog_registered_installs() -> RegisteredStoreInstalls {
        let mut result = RegisteredStoreInstalls::default();
        let games = match open_status(
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\GOG.com\\Games",
            KEY_WOW64_32KEY,
        ) {
            Ok(games) => games,
            Err(ERROR_FILE_NOT_FOUND) => return result,
            Err(_) => {
                result.unread_records = 1;
                return result;
            }
        };
        let mut unread = || result.unread_records = result.unread_records.saturating_add(1);
        let mut installs = Vec::new();
        // Enumeration ends only when Windows reports no more keys.
        for index in 0_u32.. {
            let mut name = vec![0_u16; MAX_NAME_UNITS];
            let mut length = name.len() as u32;
            // SAFETY: `games` is open and the buffer and its length match.
            let status = unsafe {
                RegEnumKeyExW(
                    games.0,
                    index,
                    name.as_mut_ptr(),
                    &mut length,
                    null(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                break;
            }
            if status != ERROR_SUCCESS {
                unread();
                continue;
            }
            name.truncate(length as usize);
            let Ok(name) = String::from_utf16(&name) else {
                unread();
                continue;
            };
            let game = match open_status(games.0, &name, KEY_WOW64_32KEY) {
                Ok(game) => game,
                // Removed while listing.
                Err(ERROR_FILE_NOT_FOUND) => continue,
                Err(_) => {
                    unread();
                    continue;
                }
            };
            match string(&game, "path") {
                Some(path) => installs.push(RegisteredStoreInstall {
                    title: string(&game, "gameName").unwrap_or_default(),
                    path: PathBuf::from(path),
                    product_id: product_number(&name).map(|id| id.to_string()),
                }),
                // A key with no install path records no folder.
                None if !value_exists(&game, "path") => {}
                None => unread(),
            }
        }
        result.installs = installs;
        result
    }
}
