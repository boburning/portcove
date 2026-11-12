//! The native enabled-mods list of the reviewed libultraship mod menu.
//!
//! Source observations (no native run): Shipwright 9.2.3
//! (`cb71e22a79bc5d1f688fa881795bbd93094895fc`, `soh/soh/Enhancements/mod_menu.cpp`,
//! unchanged in this respect in 9.3.1 `f0599f96`; the catalog follows the latest
//! release, so a later upstream change to this list must be re-reviewed)
//! keeps the enabled mods and their order in the `gSettings.EnabledMods` CVar of
//! `shipofharkinian.json`, `|`-separated, keyed by file name without its last
//! extension. At startup every `.o2r`/`.otr` under `mods` that the list does not
//! name is appended and enabled, and listed names without a file are dropped.
//! Archives are added in list order, and libultraship `fdcaf633`
//! (`src/ship/resource/archive/ArchiveManager.cpp`) maps each asset to the
//! archive added last, so the last listed mod wins. That matches Portcove's
//! `asset-override` ordering. A config that fails to parse is replaced with an
//! empty one by libultraship, so this module never writes a document it could
//! not parse.
//!
//! Consequences Portcove relies on: a disabled package must be absent from the
//! mods folder (the menu cannot keep it disabled across a restart), and the
//! revision's order is effective only once it is written into this list.
use std::{fs, path::Path};

use serde_json::Value;

use crate::{PortcoveError, Result, game_settings::document};

const SEPARATOR: char = '|';
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
/// Characters a libultraship list entry or a Windows file name cannot carry.
const UNLISTABLE: &[char] = &['|', '<', '>', '"', '?', '*'];

/// Where one reviewed port keeps its native enabled-mods list.
#[derive(Debug, Clone, Copy)]
pub(crate) struct NativeListContract {
    /// Relative to the port's canonical user directory; one of its declared
    /// persistent paths, so it is parked and restored with the profile.
    pub config: &'static str,
    pub key: &'static [&'static str],
}

pub(crate) fn contract(port_id: &str) -> Option<NativeListContract> {
    match port_id {
        "shipwright" => Some(NativeListContract {
            config: "shipofharkinian.json",
            key: &["CVars", "gSettings", "EnabledMods"],
        }),
        // The generic fixture port used by tests declares the same contract.
        #[cfg(test)]
        "starship" => Some(NativeListContract {
            config: "starship.cfg.json",
            key: &["CVars", "gSettings", "EnabledMods"],
        }),
        _ => None,
    }
}

/// The loader's identity for a package file: its name without the last extension.
pub(crate) fn native_name(file_name: &str) -> &str {
    file_name
        .rsplit_once('.')
        .map_or(file_name, |(stem, _)| stem)
}

/// Refuses a file name the native list cannot carry unambiguously.
pub(crate) fn require_listable(file_name: &str) -> Result<()> {
    if native_name(file_name).is_empty() || file_name.contains(UNLISTABLE) {
        return Err(PortcoveError::conflict(
            "the game's mod list cannot name this package file; rename it before installing",
        )
        .detail("package", file_name));
    }
    Ok(())
}

/// Whether the loader treats two package file names as the same mod.
pub(crate) fn same_mod(a: &str, b: &str) -> bool {
    native_name(a).to_lowercase() == native_name(b).to_lowercase()
}

/// Two different package files the loader would treat as the same mod: equal
/// names without extension, compared without case because Windows folders are
/// case-insensitive.
pub(crate) fn identity_collision<'a>(
    file_names: impl IntoIterator<Item = &'a str>,
) -> Option<(String, String)> {
    let mut seen = std::collections::BTreeMap::<String, &str>::new();
    for name in file_names {
        let key = native_name(name).to_lowercase();
        if let Some(previous) = seen.get(&key)
            && *previous != name
        {
            return Some(((*previous).to_owned(), name.to_owned()));
        }
        seen.insert(key, name);
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeList {
    /// No configuration yet; the loader will enable present files by path order.
    Absent,
    /// The configuration exists but has no list entry.
    Unlisted,
    Listed(Vec<String>),
    /// Unreadable or ambiguous; never rewritten.
    Unreadable(String),
}

fn split(value: &str) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    value.split(SEPARATOR).map(str::to_owned).collect()
}

fn key(contract: &NativeListContract) -> Vec<String> {
    contract.key.iter().map(|part| (*part).to_owned()).collect()
}

fn parse(bytes: &[u8], contract: &NativeListContract) -> Result<Value> {
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(PortcoveError::conflict(
            "the game's configuration exceeds the size Portcove reads",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| PortcoveError::conflict("the game's configuration is not UTF-8"))?;
    let parsed = document::json_document(text)?;
    document::refuse_json_aliases(&parsed, &key(contract))?;
    Ok(parsed)
}

pub(crate) fn read(user: &Path, contract: &NativeListContract) -> NativeList {
    let path = user.join(contract.config);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return NativeList::Absent,
        Err(error) => return NativeList::Unreadable(error.to_string()),
    };
    let parsed = match parse(&bytes, contract) {
        Ok(parsed) => parsed,
        Err(error) => return NativeList::Unreadable(error.to_string()),
    };
    let mut value = &parsed;
    for part in contract.key {
        let Some(object) = value.as_object() else {
            return NativeList::Unreadable("the configuration has an unexpected shape".into());
        };
        match object.get(*part) {
            Some(child) => value = child,
            None => return NativeList::Unlisted,
        }
    }
    match value.as_str() {
        Some(text) => NativeList::Listed(split(text)),
        None => NativeList::Unreadable("the mod list entry is not text".into()),
    }
}

/// Writes `names` as the native list, preserving every other key. A config that
/// cannot be parsed is left untouched and reported, since the loader would
/// discard it anyway and Portcove must not lose the player's other settings.
/// Returns whether the file changed.
pub(crate) fn write(user: &Path, contract: &NativeListContract, names: &[String]) -> Result<bool> {
    for name in names {
        if name.is_empty() || name.contains(UNLISTABLE) {
            return Err(
                PortcoveError::conflict("the game's mod list cannot name this package")
                    .detail("package", name),
            );
        }
    }
    let path = user.join(contract.config);
    crate::path::refuse_symlink_ancestors(&path)?;
    let mut parsed = match fs::read(&path) {
        Ok(bytes) => parse(&bytes, contract)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Value::Object(Default::default())
        }
        Err(error) => return Err(error.into()),
    };
    let wanted = names.join(&SEPARATOR.to_string());
    let (leaf, parents) = contract.key.split_last().expect("non-empty key");
    let mut parent = &mut parsed;
    for part in parents {
        parent = parent
            .as_object_mut()
            .ok_or_else(|| {
                PortcoveError::conflict("the game's configuration has an unexpected shape")
            })?
            .entry((*part).to_owned())
            .or_insert_with(|| Value::Object(Default::default()));
    }
    let object = parent.as_object_mut().ok_or_else(|| {
        PortcoveError::conflict("the game's configuration has an unexpected shape")
    })?;
    match object.get(*leaf) {
        Some(Value::String(current)) if *current == wanted => return Ok(false),
        Some(Value::String(_)) | None => {}
        Some(_) => {
            return Err(PortcoveError::conflict(
                "the game's mod list entry is not text; it was left unchanged",
            ));
        }
    }
    object.insert((*leaf).to_owned(), Value::String(wanted));
    let mut bytes = serde_json::to_vec_pretty(&parsed)?;
    bytes.push(b'\n');
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)?;
    }
    crate::durability::write_bytes_atomically(&path, &bytes, true)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHIP: NativeListContract = NativeListContract {
        config: "shipofharkinian.json",
        key: &["CVars", "gSettings", "EnabledMods"],
    };

    #[test]
    fn native_identity_is_the_name_without_its_last_extension() {
        assert_eq!(native_name("hd-link.o2r"), "hd-link");
        assert_eq!(native_name("a.b.otr"), "a.b");
        assert_eq!(
            identity_collision(["Link.o2r", "link.otr"]),
            Some(("Link.o2r".into(), "link.otr".into()))
        );
        assert_eq!(identity_collision(["a.o2r", "b.o2r", "a.o2r"]), None);
        assert!(require_listable("a|b.o2r").is_err());
        assert!(require_listable("what?.o2r").is_err());
        assert!(require_listable(".o2r").is_err());
        assert!(require_listable("fine name.o2r").is_ok());
    }

    #[test]
    fn writing_preserves_unknown_keys_and_reads_back_in_order() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(read(directory.path(), &SHIP), NativeList::Absent);
        fs::write(
            directory.path().join(SHIP.config),
            br#"{"CVars":{"gSettings":{"Volume":{"Master":40}},"gCosmetics":{"x":1}},"Window":{"Width":800}}"#,
        )
        .unwrap();
        assert_eq!(read(directory.path(), &SHIP), NativeList::Unlisted);
        let names = vec!["b".to_owned(), "a".to_owned()];
        assert!(write(directory.path(), &SHIP, &names).unwrap());
        assert!(!write(directory.path(), &SHIP, &names).unwrap());
        assert_eq!(read(directory.path(), &SHIP), NativeList::Listed(names));
        let value: Value =
            serde_json::from_slice(&fs::read(directory.path().join(SHIP.config)).unwrap()).unwrap();
        assert_eq!(value["CVars"]["gSettings"]["EnabledMods"], "b|a");
        assert_eq!(value["CVars"]["gSettings"]["Volume"]["Master"], 40);
        assert_eq!(value["CVars"]["gCosmetics"]["x"], 1);
        assert_eq!(value["Window"]["Width"], 800);
        assert!(write(directory.path(), &SHIP, &[]).unwrap());
        assert_eq!(
            read(directory.path(), &SHIP),
            NativeList::Listed(Vec::new())
        );
    }

    #[test]
    fn a_missing_config_gets_only_the_list() {
        let directory = tempfile::tempdir().unwrap();
        write(directory.path(), &SHIP, &["m".to_owned()]).unwrap();
        let value: Value =
            serde_json::from_slice(&fs::read(directory.path().join(SHIP.config)).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"CVars":{"gSettings":{"EnabledMods":"m"}}})
        );
    }

    #[test]
    fn unreadable_or_ambiguous_configs_are_never_rewritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SHIP.config);
        for bytes in [
            &b"{not json"[..],
            br#"{"CVars":{"gSettings":{"EnabledMods":"a"}},"CVars":{}}"#,
            br#"{"CVars":{"gSettings.EnabledMods":"a","gSettings":{}}}"#,
            br#"{"CVars":{"gSettings":"flat"}}"#,
            br#"{"CVars":{"gSettings":{"EnabledMods":3}}}"#,
        ] {
            fs::write(&path, bytes).unwrap();
            let before = fs::read(&path).unwrap();
            let _ = write(directory.path(), &SHIP, &["x".to_owned()]);
            assert_eq!(fs::read(&path).unwrap(), before);
        }
        fs::write(&path, b"{not json").unwrap();
        assert!(matches!(
            read(directory.path(), &SHIP),
            NativeList::Unreadable(_)
        ));
        fs::write(&path, br#"{"CVars":{"gSettings":"flat"}}"#).unwrap();
        assert!(matches!(
            read(directory.path(), &SHIP),
            NativeList::Unreadable(_)
        ));
        assert!(write(directory.path(), &SHIP, &["a|b".to_owned()]).is_err());
    }
}
