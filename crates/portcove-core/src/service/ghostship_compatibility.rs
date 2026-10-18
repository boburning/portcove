//! Exact historical Ghostship reader hold; this is not a save converter.

use std::{fs, io::ErrorKind};

use crate::{PortcoveError, Result, path::refuse_symlink_ancestors};

use super::PortcoveService;

impl PortcoveService {
    pub(crate) fn require_ghostship_data_compatibility(
        &self,
        port_id: &str,
        target_version: &str,
        active_version: Option<&str>,
    ) -> Result<()> {
        if port_id != "ghostship" || target_version != "2.0.0" {
            return Ok(());
        }
        let held = |reason: &str| {
            PortcoveError::conflict(format!(
                "Ghostship 2.0.0 data compatibility is held: {reason}. Keep the current \
                 installation and user data; a reviewed pre-transition data recovery route \
                 is required before using this legacy runtime (Portcove #53)"
            ))
        };
        // O2R and settings transitions also remain unqualified for this exact
        // pair. Absence of save files cannot turn that transition into a pass.
        if active_version == Some("3.0.0") {
            return Err(held(
                "the older runtime cannot read schema-2 saves and generated O2R compatibility is not established",
            ));
        }
        // Installation history can disappear after removal. Inspect the shared
        // SHIP_HOME data as well, before any mutation or old-reader execution.
        let user = self.library.user_dir(port_id);
        for name in [
            "save_0.json",
            "save_1.json",
            "save_2.json",
            "save_3.json",
            "global.json",
        ] {
            let path = user.join("saves").join(name);
            refuse_symlink_ancestors(&path)
                .map_err(|_| held("save data contains an unsafe path"))?;
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(_) => return Err(held("save data is unreadable")),
                Ok(_) => {}
            }
            let bytes = crate::path::read_bounded_regular(&path, 1024 * 1024)
                .map_err(|_| held("save data is not a bounded readable regular file"))?;
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| held("save data is malformed"))?;
            if value.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
                return Err(held(
                    "the save version is unsupported by the schema-1 reader",
                ));
            }
        }
        let archive = user.join("sm64.o2r");
        refuse_symlink_ancestors(&archive).map_err(|_| held("generated O2R has an unsafe path"))?;
        match fs::symlink_metadata(&archive) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err(held("generated O2R is unreadable")),
            Ok(_) => Err(held(
                "the retained generated O2R has no reviewed legacy-reader compatibility proof",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Library;

    #[test]
    fn ghostship_legacy_reader_checks_each_save_after_install_history_is_lost() {
        for name in [
            "save_0.json",
            "save_1.json",
            "save_2.json",
            "save_3.json",
            "global.json",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path()).unwrap();
            let path = library.user_dir("ghostship").join("saves").join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let service = PortcoveService::new(library).unwrap();
            for bytes in [
                br#"{"version":2}"#.as_slice(),
                b"{",
                b"{}",
                br#"{"version":"1"}"#,
            ] {
                fs::write(&path, bytes).unwrap();
                assert!(
                    service
                        .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                        .is_err()
                );
                assert_eq!(fs::read(&path).unwrap(), bytes);
            }
            fs::write(&path, br#"{"version":1}"#).unwrap();
            service
                .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                .unwrap();
        }
    }

    #[test]
    fn ghostship_legacy_reader_holds_unbounded_nonregular_and_unproven_data() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let user = library.user_dir("ghostship");
        let saves = user.join("saves");
        fs::create_dir_all(&saves).unwrap();
        let service = PortcoveService::new(library).unwrap();
        let path = saves.join("global.json");
        fs::create_dir(&path).unwrap();
        assert!(
            service
                .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                .is_err()
        );
        fs::remove_dir(&path).unwrap();
        fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(
            service
                .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                .is_err()
        );
        fs::remove_file(path).unwrap();
        let archive = user.join("sm64.o2r");
        fs::write(&archive, b"unproven producer identity").unwrap();
        assert!(
            service
                .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                .is_err()
        );
        assert_eq!(fs::read(archive).unwrap(), b"unproven producer identity");
        service
            .require_ghostship_data_compatibility("ghostship", "3.0.0", None)
            .unwrap();
        service
            .require_ghostship_data_compatibility("lighthouse", "2.0.0", None)
            .unwrap();
    }
}
