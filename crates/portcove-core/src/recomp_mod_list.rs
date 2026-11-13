//! The Recomp runtime's own enabled-mods file, `mods.json`.
//!
//! Source observations (no native run; N64ModernRuntime `df7e820d`,
//! `librecomp/src/mods.cpp`): `mods.json` holds `{"enabled_mods": [...],
//! "mod_order": [...]}` of native mod IDs. `enabled_mods` lists only mods the
//! player enabled; `mod_order` is the load and precedence order (callbacks and
//! entry hooks run in that order, return hooks in reverse). Present mods missing
//! from `mod_order` are placed before known ones, and a new ID is enabled unless
//! its manifest says otherwise, so a disabled package must stay out of the mods
//! folder for a profile to stay clean.
//!
//! Like the Ship list, only the profile's own IDs are rewritten: IDs the player
//! added keep their place in `mod_order` and their enabled state, other keys are
//! kept, and a file that cannot be read is never rewritten.
use std::{collections::BTreeSet, fs, path::Path};

use serde_json::{Map, Value};

use crate::{PortcoveError, Result, game_settings::document};

pub(crate) const FILE: &str = "mods.json";
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecompList {
    Absent,
    Listed {
        enabled: Vec<String>,
        order: Vec<String>,
    },
    Unreadable(String),
}

fn ids(object: &Map<String, Value>, key: &str) -> std::result::Result<Vec<String>, String> {
    match object.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("`{key}` must list text IDs"))
            })
            .collect(),
        Some(_) => Err(format!("`{key}` must be a list")),
    }
}

fn parse(bytes: &[u8]) -> Result<Value> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(PortcoveError::conflict(
            "the game's mod list exceeds the size Portcove reads",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| PortcoveError::conflict("the game's mod list is not UTF-8"))?;
    document::json_document(text)
}

pub(crate) fn read(user: &Path) -> RecompList {
    let bytes = match fs::read(user.join(FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return RecompList::Absent,
        Err(error) => return RecompList::Unreadable(error.to_string()),
    };
    let parsed = match parse(&bytes) {
        Ok(parsed) => parsed,
        Err(error) => return RecompList::Unreadable(error.message),
    };
    let object = parsed.as_object().expect("json_document returns an object");
    match (ids(object, "enabled_mods"), ids(object, "mod_order")) {
        (Ok(enabled), Ok(order)) => RecompList::Listed { enabled, order },
        (Err(reason), _) | (_, Err(reason)) => RecompList::Unreadable(reason),
    }
}

/// The new lists: the profile's own IDs (`managed`) take the revision's order in
/// their existing slots and the revision's enabled state; the player's IDs keep
/// their place and state. Extra profile IDs follow, in the revision's order.
pub(crate) fn merged(
    existing_enabled: &[String],
    existing_order: &[String],
    managed: &BTreeSet<String>,
    wanted_order: &[String],
    wanted_enabled: &BTreeSet<String>,
) -> (Vec<String>, Vec<String>) {
    let mut wanted = wanted_order.iter();
    let mut order = Vec::new();
    for id in existing_order {
        if managed.contains(id) {
            if let Some(next) = wanted.next() {
                order.push(next.clone());
            }
        } else {
            order.push(id.clone());
        }
    }
    order.extend(wanted.cloned());
    let enabled = existing_enabled
        .iter()
        .filter(|id| !managed.contains(*id))
        .cloned()
        .chain(
            wanted_order
                .iter()
                .filter(|id| wanted_enabled.contains(*id))
                .cloned(),
        )
        .collect();
    (enabled, order)
}

/// Writes the lists, keeping every other key. Never rewrites a file it could not
/// read. Returns whether the file changed.
pub(crate) fn write(user: &Path, enabled: &[String], order: &[String]) -> Result<bool> {
    let path = user.join(FILE);
    crate::path::refuse_symlink_ancestors(&path)?;
    let mut parsed = match fs::read(&path) {
        Ok(bytes) => parse(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Object(Map::new()),
        Err(error) => return Err(error.into()),
    };
    let object = parsed
        .as_object_mut()
        .expect("json_document returns an object");
    for key in ["enabled_mods", "mod_order"] {
        if object.get(key).is_some_and(|value| !value.is_array()) {
            return Err(PortcoveError::conflict(
                "the game's mod list has an unexpected shape; it was left unchanged",
            ));
        }
    }
    let as_value =
        |items: &[String]| Value::Array(items.iter().cloned().map(Value::String).collect());
    let next_enabled = as_value(enabled);
    let next_order = as_value(order);
    if object.get("enabled_mods") == Some(&next_enabled)
        && object.get("mod_order") == Some(&next_order)
    {
        return Ok(false);
    }
    object.insert("enabled_mods".into(), next_enabled);
    object.insert("mod_order".into(), next_order);
    let mut bytes = serde_json::to_vec_pretty(&parsed)?;
    bytes.push(b'\n');
    fs::create_dir_all(user)?;
    crate::durability::write_bytes_atomically(&path, &bytes, true)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn only_the_profiles_ids_move_and_the_players_keep_place_and_state() {
        let managed = ["a", "b", "c"].map(String::from).into_iter().collect();
        let wanted_enabled = ["c", "a"].map(String::from).into_iter().collect();
        let (enabled, order) = merged(
            &strings(&["mine", "a", "b"]),
            &strings(&["a", "mine", "b", "theirs"]),
            &managed,
            &strings(&["c", "a"]),
            &wanted_enabled,
        );
        // `c` and `a` take the two managed slots; `b` (disabled, removed) leaves.
        assert_eq!(order, strings(&["c", "mine", "a", "theirs"]));
        assert_eq!(enabled, strings(&["mine", "c", "a"]));
        // A profile mod the list has never named follows, in the revision's order.
        let (_, order) = merged(
            &[],
            &strings(&["mine"]),
            &managed,
            &strings(&["a"]),
            &wanted_enabled,
        );
        assert_eq!(order, strings(&["mine", "a"]));
    }

    #[test]
    fn writing_keeps_other_keys_and_unreadable_files_are_never_rewritten() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(read(directory.path()), RecompList::Absent);
        let path = directory.path().join(FILE);
        fs::write(
            &path,
            br#"{"enabled_mods":["x"],"mod_order":["x"],"future":1}"#,
        )
        .unwrap();
        assert!(write(directory.path(), &strings(&["y"]), &strings(&["y", "x"])).unwrap());
        assert!(!write(directory.path(), &strings(&["y"]), &strings(&["y", "x"])).unwrap());
        assert_eq!(
            read(directory.path()),
            RecompList::Listed {
                enabled: strings(&["y"]),
                order: strings(&["y", "x"])
            }
        );
        let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["future"], 1);
        for bytes in [
            &b"{broken"[..],
            br#"{"enabled_mods":"x","mod_order":[]}"#,
            br#"{"mod_order":[],"mod_order":[]}"#,
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(matches!(read(directory.path()), RecompList::Unreadable(_)));
            let _ = write(directory.path(), &strings(&["z"]), &strings(&["z"]));
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }
}
