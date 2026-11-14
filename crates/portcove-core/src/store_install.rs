//! Read-only detection of game folders that Steam, GOG and Epic installed on
//! this computer. Detected folders are search suggestions only: they are not
//! saved game-file folders, source registrations or setup intent, and nothing
//! here writes, moves or deletes anything inside a store's folder.

use std::{
    collections::BTreeSet,
    path::{Component, Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{PortcoveError, PortcoveService, Result, game_file_root::path_key};

#[cfg(test)]
#[path = "store_install_tests.rs"]
mod tests;

/// Largest store metadata file read (Steam VDF/ACF, Epic manifest).
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
/// Steam libraries considered across every client root.
const MAX_STEAM_LIBRARIES: usize = 64;
/// Directory entries examined in one manifest directory.
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
    /// The store's title for the game; a label, never an identity.
    pub title: String,
    /// Canonical existing folder.
    pub path: PathBuf,
    /// The saved game-file folder at exactly this path, when there is one.
    pub saved_root_id: Option<String>,
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
}

/// Host facts behind store detection. Production reads the registry and
/// default locations; tests supply fixture folders.
pub trait StoreInstallHost: Send + Sync {
    /// Steam client folders (each normally holds `steamapps`).
    fn steam_client_roots(&self) -> Vec<PathBuf>;
    /// GOG installs recorded in the Windows registry.
    fn gog_registered_installs(&self) -> Vec<RegisteredStoreInstall>;
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

    fn gog_registered_installs(&self) -> Vec<RegisteredStoreInstall> {
        Vec::new()
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

/// What a detection found, including folders that must never lose files
/// through a Move even when no single install names them.
#[derive(Debug, Default)]
struct Detection {
    report: StoreGameInstalls,
    protected: Vec<(GameStore, PathBuf)>,
    seen: BTreeSet<String>,
}

impl Detection {
    fn skip(&mut self) {
        self.report.skipped_entries = self.report.skipped_entries.saturating_add(1);
    }

    fn add(&mut self, store: GameStore, title: &str, path: &Path) {
        let Some(path) = existing_folder(path) else {
            self.skip();
            return;
        };
        let Ok(text) = crate::path::unicode(&path, "store install") else {
            self.skip();
            return;
        };
        if !self.seen.insert(path_key(&text)) {
            return;
        }
        // Protect the folder from a Move even past the listing bound.
        self.protected.push((store, path.clone()));
        if self.report.installs.len() >= MAX_INSTALLS {
            self.report.limited = true;
            return;
        }
        let title = clean_title(title)
            .or_else(|| {
                path.file_name()
                    .and_then(|name| clean_title(&name.to_string_lossy()))
            })
            .unwrap_or_default();
        self.report.installs.push(StoreGameInstall {
            store,
            title,
            path,
            saved_root_id: None,
        });
    }
}

fn detect(host: &dyn StoreInstallHost) -> Detection {
    let mut detection = Detection::default();
    detection.report.checked_stores = host.checked_stores();
    detect_steam(host, &mut detection);
    for install in host.gog_registered_installs() {
        detection.add(GameStore::Gog, &install.title, &install.path);
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

fn detect_steam(host: &dyn StoreInstallHost, detection: &mut Detection) {
    // Canonical `steamapps` folders, kept as resolved so a linked or
    // differently cased folder is still read and protected as itself.
    let mut libraries = Vec::<PathBuf>::new();
    let mut library_keys = BTreeSet::new();
    // `listed` libraries come from Steam's own list, so a bad entry counts as
    // skipped; default client locations are often simply absent.
    let mut push_library = |path: &Path, listed: bool, detection: &mut Detection| {
        let Some(steamapps) = existing_folder(&path.join("steamapps")) else {
            if listed {
                detection.skip();
            }
            return;
        };
        if !library_keys.insert(path_key(&steamapps.to_string_lossy())) {
            return;
        }
        if libraries.len() >= MAX_STEAM_LIBRARIES {
            detection.report.limited = true;
            return;
        }
        libraries.push(steamapps);
    };
    for root in host.steam_client_roots() {
        push_library(&root, false, detection);
        let folders = root.join("steamapps").join("libraryfolders.vdf");
        if !folders.exists() {
            continue;
        }
        match read_text(&folders) {
            Some(text) => {
                for library in steam_library_paths(&text) {
                    push_library(&library, true, detection);
                }
            }
            None => detection.skip(),
        }
    }
    for steamapps in libraries {
        detection
            .protected
            .push((GameStore::Steam, steamapps.clone()));
        for manifest in manifest_files(&steamapps, detection, |name| {
            name.starts_with("appmanifest_") && name.ends_with(".acf")
        }) {
            let Some(text) = read_text(&manifest) else {
                detection.skip();
                continue;
            };
            let Some((title, installdir)) = steam_app_manifest(&text) else {
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
            );
        }
    }
}

fn detect_epic(directory: &Path, detection: &mut Detection) {
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
        detection.add(GameStore::Epic, title, Path::new(location));
    }
}

/// Bounded, sorted regular files whose names `accept` admits.
fn manifest_files(
    directory: &Path,
    detection: &mut Detection,
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
fn vdf_pairs(text: &str) -> Option<Vec<(usize, String, String)>> {
    let tokens = vdf_tokens(text)?;
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
fn steam_library_paths(text: &str) -> Vec<PathBuf> {
    let Some(pairs) = vdf_pairs(text) else {
        return Vec::new();
    };
    pairs
        .into_iter()
        .filter(|(depth, key, _)| {
            (*depth == 2 && key.eq_ignore_ascii_case("path"))
                || (*depth == 1 && !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .map(|(_, _, value)| PathBuf::from(value))
        .collect()
}

/// `(name, installdir)` from a Steam `appmanifest_*.acf`.
fn steam_app_manifest(text: &str) -> Option<(String, String)> {
    let pairs = vdf_pairs(text)?;
    let field = |name: &str| {
        pairs
            .iter()
            .find(|(depth, key, _)| *depth == 1 && key.eq_ignore_ascii_case(name))
            .map(|(_, _, value)| value.clone())
    };
    let installdir = field("installdir").filter(|value| !value.is_empty())?;
    Some((field("name").unwrap_or_default(), installdir))
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
fn unsuitable_suggestion(path: &Path, library: &Path) -> bool {
    path.parent().is_none()
        || directories::BaseDirs::new().is_some_and(|base| {
            std::fs::canonicalize(base.home_dir()).is_ok_and(|home| home == path)
        })
        || inside(library, path)
}

impl PortcoveService {
    /// Game folders Steam, GOG and Epic installed on this computer, read from
    /// the stores' own metadata. Reads only; failures leave a shorter list.
    pub fn store_game_installs(&self) -> Result<StoreGameInstalls> {
        let mut report = detect(self.store_install_host()).report;
        let library = std::fs::canonicalize(self.library().root())
            .unwrap_or_else(|_| self.library().root().to_path_buf());
        let before = report.installs.len();
        report
            .installs
            .retain(|install| !unsuitable_suggestion(&install.path, &library));
        report.skipped_entries = report
            .skipped_entries
            .saturating_add(u32::try_from(before - report.installs.len()).unwrap_or(u32::MAX));
        let roots = self.library().game_file_roots()?;
        for install in &mut report.installs {
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
    /// canonical. Store folders whose metadata could not be read are only
    /// protected through the `steamapps` folder name.
    pub(crate) fn refuse_store_install_move(&self, profile_id: &str, path: &Path) -> Result<()> {
        let found = steamapps_ancestor(path)
            .map(|folder| (GameStore::Steam, folder))
            .or_else(|| {
                detect(self.store_install_host())
                    .protected
                    .into_iter()
                    .find(|(_, folder)| inside(path, folder) || inside(folder, path))
            });
        let Some((store, folder)) = found else {
            return Ok(());
        };
        let store_name = store_name(store);
        Err(PortcoveError::conflict(format!(
            "These files are part of a game {store_name} installed. Moving them would break that game; copy them into Portcove or use them where they are."
        ))
        .detail("profile_id", profile_id)
        .detail("store", store_name)
        .detail("store_folder", folder.display().to_string()))
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

    fn gog_registered_installs(&self) -> Vec<RegisteredStoreInstall> {
        #[cfg(windows)]
        {
            windows::gog_registered_installs()
        }
        #[cfg(not(windows))]
        {
            Vec::new()
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
        Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS},
        System::Registry::{
            HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, RRF_RT_REG_SZ,
            RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW,
        },
    };

    use super::RegisteredStoreInstall;

    const MAX_SUBKEYS: u32 = 4_096;
    const MAX_NAME_UNITS: usize = 256;
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
        let path = wide(path);
        let mut key: HKEY = null_mut();
        // SAFETY: the name is null terminated and `key` is a live output slot.
        let status = unsafe { RegOpenKeyExW(parent, path.as_ptr(), 0, KEY_READ | view, &mut key) };
        (status == ERROR_SUCCESS).then_some(Key(key))
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

    pub(super) fn gog_registered_installs() -> Vec<RegisteredStoreInstall> {
        let Some(games) = open(
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\GOG.com\\Games",
            KEY_WOW64_32KEY,
        ) else {
            return Vec::new();
        };
        let mut installs = Vec::new();
        for index in 0..MAX_SUBKEYS {
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
                continue;
            }
            name.truncate(length as usize);
            let Ok(name) = String::from_utf16(&name) else {
                continue;
            };
            let Some(game) = open(games.0, &name, KEY_WOW64_32KEY) else {
                continue;
            };
            if let Some(path) = string(&game, "path") {
                installs.push(RegisteredStoreInstall {
                    title: string(&game, "gameName").unwrap_or_default(),
                    path: PathBuf::from(path),
                });
            }
        }
        installs
    }
}
