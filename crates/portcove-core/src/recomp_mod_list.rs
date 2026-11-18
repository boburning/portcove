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
use sha2::{Digest, Sha256};

use crate::{PortcoveError, Result, game_settings::document};

pub(crate) const FILE: &str = "mods.json";
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecompList {
    Absent,
    Listed {
        enabled: Vec<String>,
        order: Vec<String>,
        enabled_list_present: bool,
        from_backup: bool,
        document: Value,
        source_sha256: [u8; 32],
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

fn read_source_bytes(user: &Path) -> Result<Option<(Vec<u8>, bool)>> {
    let primary = user.join(FILE);
    if let Some(bytes) = crate::native_mod_list::read_native_file(&primary, MAX_BYTES)? {
        return Ok(Some((bytes, false)));
    }
    Ok(
        crate::native_mod_list::read_native_file(&primary.with_extension("json.bak"), MAX_BYTES)?
            .map(|bytes| (bytes, true)),
    )
}

pub(crate) fn read(user: &Path) -> RecompList {
    let (bytes, from_backup) = match read_source_bytes(user) {
        Ok(Some(source)) => source,
        Ok(None) => return RecompList::Absent,
        Err(error) => return RecompList::Unreadable(error.to_string()),
    };
    // The runtime accepts some inputs Portcove cannot safely edit. A primary
    // rejected here may still win in the game, so hold it as unreadable.
    let parsed = match parse(&bytes) {
        Ok(parsed) => parsed,
        Err(error) => return RecompList::Unreadable(error.to_string()),
    };
    let object = parsed.as_object().expect("json_document returns an object");
    match (ids(object, "enabled_mods"), ids(object, "mod_order")) {
        (Ok(enabled), Ok(order)) => RecompList::Listed {
            enabled,
            order,
            enabled_list_present: object.contains_key("enabled_mods"),
            from_backup,
            document: parsed,
            source_sha256: Sha256::digest(&bytes).into(),
        },
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

/// Applies the lists to the observed document, keeping every other key.
/// A backup observation grants no replacement authority over the primary.
pub(crate) fn write(
    user: &Path,
    observed: RecompList,
    enabled: &[String],
    order: &[String],
) -> Result<bool> {
    let path = user.join(FILE);
    crate::path::refuse_symlink_ancestors(&path)?;
    let (mut parsed, observed_source, replace_primary) = match observed {
        RecompList::Listed {
            document,
            from_backup,
            source_sha256,
            ..
        } => (document, Some((source_sha256, from_backup)), !from_backup),
        RecompList::Absent => (Value::Object(Map::new()), None, false),
        RecompList::Unreadable(reason) => return Err(PortcoveError::conflict(reason)),
    };
    let object = parsed
        .as_object_mut()
        .expect("json_document returns an object");
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
    crate::durability::write_bytes_atomically_checked(
        &path,
        &bytes,
        replace_primary,
        None,
        || {
            let current_source = read_source_bytes(user)?
                .map(|(bytes, from_backup)| (Sha256::digest(&bytes).into(), from_backup));
            if current_source != observed_source {
                return Err(PortcoveError::conflict(
                    "The game's mod list changed during projection. Keep the current file and review the selected setup.",
                ));
            }
            Ok(())
        },
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    fn project(user: &Path, enabled: &[&str], order: &[&str]) -> Result<bool> {
        write(user, read(user), &strings(enabled), &strings(order))
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
        assert!(project(directory.path(), &["y"], &["y", "x"]).unwrap());
        assert!(!project(directory.path(), &["y"], &["y", "x"]).unwrap());
        assert!(matches!(
            read(directory.path()),
            RecompList::Listed {
                enabled_list_present: true,
                from_backup: false,
                enabled,
                order,
                ..
            } if enabled == ["y"] && order == ["y", "x"]
        ));
        let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["future"], 1);
        for bytes in [
            &b"{broken"[..],
            br#"{"enabled_mods":"x","mod_order":[]}"#,
            br#"{"mod_order":[],"mod_order":[]}"#,
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(matches!(read(directory.path()), RecompList::Unreadable(_)));
            assert!(project(directory.path(), &["z"], &["z"]).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn writing_refuses_changed_primary_or_fallback_bytes() {
        for from_backup in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let primary = directory.path().join(FILE);
            let source = if from_backup {
                primary.with_extension("json.bak")
            } else {
                primary.clone()
            };
            fs::write(&source, br#"{"enabled_mods":["on"],"mod_order":["on"]}"#).unwrap();
            let observed = read(directory.path());
            let changed = br#"{"enabled_mods":["on"],"mod_order":["on"],"from_player":true}"#;
            fs::write(&source, changed).unwrap();

            let refusal = write(
                directory.path(),
                observed,
                &strings(&["new"]),
                &strings(&["new"]),
            )
            .unwrap_err();
            assert_eq!(refusal.code, crate::ErrorCode::Conflict);
            assert_eq!(fs::read(&source).unwrap(), changed);
            if from_backup {
                assert!(!primary.exists());
            }
        }
    }

    #[test]
    fn writing_from_a_valid_fallback_preserves_its_unknown_fields_and_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let primary = directory.path().join(FILE);
        let backup = primary.with_extension("json.bak");
        let original = br#"{"enabled_mods":["on"],"mod_order":["off","on"],"future":{"v":1}}"#;
        fs::write(&backup, original).unwrap();
        assert!(matches!(
            read(directory.path()),
            RecompList::Listed {
                from_backup: true,
                ..
            }
        ));
        assert!(!project(directory.path(), &["on"], &["off", "on"]).unwrap());
        assert!(!primary.exists());

        let observed_backup = read(directory.path());
        let appearing_primary = br#"{"enabled_mods":[],"mod_order":[],"from_player":true}"#;
        fs::write(&primary, appearing_primary).unwrap();
        assert!(
            write(
                directory.path(),
                observed_backup,
                &strings(&["on"]),
                &strings(&["on"])
            )
            .is_err()
        );
        assert_eq!(fs::read(&primary).unwrap(), appearing_primary);
        assert_eq!(fs::read(&backup).unwrap(), original);
        fs::remove_file(&primary).unwrap();

        assert!(project(directory.path(), &["on"], &["on"]).unwrap());
        let document: Value = serde_json::from_slice(&fs::read(&primary).unwrap()).unwrap();
        assert_eq!(document["future"]["v"], 1);
        assert_eq!(fs::read(&backup).unwrap(), original);
        assert!(matches!(
            read(directory.path()),
            RecompList::Listed {
                from_backup: false,
                ..
            }
        ));

        fs::write(&primary, br#"{"broken": []"#).unwrap();
        assert!(matches!(read(directory.path()), RecompList::Unreadable(_)));
        assert!(project(directory.path(), &["on"], &["on"]).is_err());
        assert_eq!(fs::read(primary).unwrap(), br#"{"broken": []"#);
        assert_eq!(fs::read(backup).unwrap(), original);
    }
}
