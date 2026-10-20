//! Exact stock SMB1R 1.1-stable write scope. No environment changes or data seeding.
use crate::{PortcoveError, Result, UserPreparedRuntimeSpec};

pub(super) fn validate(spec: &UserPreparedRuntimeSpec) -> Result<()> {
    if spec.version != "1.1-stable"
        || spec.archive_name != "Windows.zip"
        || spec.archive_size != 76_214_255
        || spec.archive_sha256 != "164f5160b7b73f161b956fa1470813c8e21fa92424f94c8889de46111a59c109"
        || spec.executable != "SMB1R.exe"
        || spec.immutable_tree_sha256
            != "a8cb5667881f64dead389d8e8dd821bd4787f2b345156953d645f27412398b6a"
        || spec.source_argument_extension.is_some()
        || spec.library_user_data
        || !spec.mutable_paths.is_empty()
        || !spec.required_mutable_files.is_empty()
        || spec.settings_contract.is_some()
    {
        return Err(PortcoveError::verification(
            "shared game data requires the exact reviewed stock SMB1R Windows artifact",
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn resolve() -> Result<crate::SharedPreferencesReview> {
    use crate::{
        AcceptedSharedPreferencesBinding, PreparedSharedPreferencesContract,
        SharedPreferencesReview,
    };
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| {
            PortcoveError::verification("SMB1R requires an existing absolute APPDATA directory")
        })?;
    if !base.is_absolute() || !super::check_path(&base, true)? {
        return Err(PortcoveError::verification(
            "SMB1R requires an existing safe absolute APPDATA directory",
        ));
    }
    let root = std::fs::canonicalize(base)?;
    let path = root.join("SMB1R");
    let present = super::check_path(&path, true)?;
    check_shared_tree(&path)?;
    Ok(SharedPreferencesReview {
        binding: AcceptedSharedPreferencesBinding {
            contract: PreparedSharedPreferencesContract::Smb1r11Windows,
            account_sid_sha256: super::account_sid_sha256()?,
            path,
        },
        present,
        local_fallback_path: None,
        local_fallback_present: false,
    })
}

/// Inspect mutable metadata only. A nested junction, symlink or hard link would
/// let the game write outside the separately acknowledged directory.
#[cfg(any(windows, test))]
fn check_shared_tree(root: &std::path::Path) -> Result<()> {
    if !super::check_path(root, true)? {
        return Ok(());
    }
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    let mut entries = 0_usize;
    while let Some((directory, depth)) = pending.pop() {
        if depth >= 32 || !super::check_path(&directory, true)? {
            return Err(PortcoveError::verification(
                "SMB1R shared directory changed or exceeds its metadata depth budget",
            ));
        }
        for entry in std::fs::read_dir(&directory)? {
            entries += 1;
            if entries > 65_536 {
                return Err(PortcoveError::verification(
                    "SMB1R shared directory exceeds its metadata entry budget",
                ));
            }
            let entry = entry?;
            let path = entry.path();
            let directory = entry.file_type()?.is_dir();
            vanilla_entry(root, &path, directory)?;
            if !super::check_path(&path, directory)? {
                return Err(PortcoveError::verification(
                    "SMB1R shared directory changed during metadata inspection",
                ));
            }
            if directory {
                pending.push((path, depth + 1));
            }
        }
    }
    Ok(())
}

/// Existing optional imports can execute Godot constructors or scenes even when
/// mods are disabled. This route admits vanilla generated assets only; it never
/// removes, rewrites or silently adopts those player-owned inputs.
#[cfg(any(windows, test))]
fn vanilla_entry(root: &std::path::Path, path: &std::path::Path, directory: bool) -> Result<()> {
    let invalid = || {
        PortcoveError::verification(
            "SMB1R vanilla route refuses imported levels, blueprints, custom characters, extra resource packs and Godot loader metadata; move these unreviewed inputs elsewhere manually, preserving their files",
        )
    };
    let parts = path
        .strip_prefix(root)
        .map_err(|_| invalid())?
        .components()
        .map(|part| {
            part.as_os_str()
                .to_str()
                .map(str::to_ascii_lowercase)
                .ok_or_else(invalid)
        })
        .collect::<Result<Vec<_>>>()?;
    let name = parts
        .last()
        .ok_or_else(invalid)?
        .trim_end_matches(['.', ' ']);
    if [".remap", ".import", ".uid"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
    {
        return Err(invalid());
    }
    match parts.first().map(String::as_str) {
        Some("custom_characters" | "custom_levels" | "level_packs" | "blueprints")
            if !directory =>
        {
            return Err(invalid());
        }
        Some("resource_packs") => {
            if parts.len() > 1 && parts[1] != "baseassets" {
                return Err(invalid());
            }
            if !directory
                && !(parts.len() == 3 && name == "pack_info.json")
                && !name.ends_with(".png")
            {
                return Err(invalid());
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn original_at(root: &std::path::Path) -> Result<bool> {
    use sha2::{Digest, Sha256};
    if !super::check_path(root, true)? {
        return Ok(false);
    }
    let path = root.join("baserom.nes");
    if !super::check_path(&path, false)? {
        return Ok(false);
    }
    if std::fs::symlink_metadata(&path)?.len() != 40_976 {
        return Ok(false);
    }
    let bytes = super::super::read_stable_metadata(&path, 40_976)?;
    // Strict reviewed subset of the selected release's normalized ROM protocol.
    // Do not accept another header, trailing bytes, or an unrelated normalized input.
    Ok(bytes.len() == 40_976
        && hex::encode(Sha256::digest(&bytes))
            == "0b3d9e1f01ed1668205bab34d6c82b0e281456e137352e4f36a9b2cfa3b66dea")
}

#[cfg(any(windows, test))]
fn settings_at(root: &std::path::Path) -> Result<()> {
    if !super::check_path(root, true)? {
        return Ok(());
    }
    let path = root.join("settings.cfg");
    if !super::check_path(&path, false)? {
        return Ok(());
    }
    data_only_settings(&super::super::read_stable_metadata(&path, 1024 * 1024)?)
}

#[cfg(any(windows, test))]
fn unsafe_settings() -> PortcoveError {
    PortcoveError::verification(
        "SMB1R settings.cfg must contain bounded ordinary data without Godot object or resource constructors, using only the BaseAssets resource pack; review the external file manually",
    )
}

/// Constructor-free subset of the selected ConfigFile writer. Section and key
/// syntax is parsed separately from values: Godot's simple section parser does
/// not use the value lexer's quote/comment rules. Never evaluate upstream syntax.
#[cfg(any(windows, test))]
fn data_only_settings(bytes: &[u8]) -> Result<()> {
    if bytes.len() > 1024 * 1024 {
        return Err(unsafe_settings());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| unsafe_settings())?;
    SettingsParser {
        bytes: text.strip_prefix('\u{feff}').unwrap_or(text).as_bytes(),
        at: 0,
        units: 0,
    }
    .document()
}

#[cfg(any(windows, test))]
struct SettingsParser<'a> {
    bytes: &'a [u8],
    at: usize,
    units: usize,
}

#[cfg(any(windows, test))]
impl SettingsParser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }
    fn advance(&mut self) -> Result<u8> {
        let byte = self.peek().ok_or_else(unsafe_settings)?;
        self.at += 1;
        if !byte.is_ascii_whitespace() {
            self.units += 1;
            if self.units > 65_536 {
                return Err(unsafe_settings());
            }
        }
        Ok(byte)
    }
    fn require(&mut self, byte: u8) -> Result<()> {
        if self.advance()? != byte {
            return Err(unsafe_settings());
        }
        Ok(())
    }
    fn horizontal(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r')) {
            self.at += 1;
        }
    }
    fn comment(&mut self) {
        while self.peek().is_some_and(|b| b != b'\n') {
            self.at += 1;
        }
    }
    fn trivia(&mut self) {
        loop {
            while self.peek().is_some_and(|b| b.is_ascii_whitespace()) {
                self.at += 1;
            }
            if self.peek() != Some(b';') {
                break;
            }
            self.comment();
        }
    }
    fn line_end(&mut self) -> Result<()> {
        self.horizontal();
        if self.peek() == Some(b';') {
            self.comment();
        }
        if !matches!(self.peek(), None | Some(b'\n')) {
            return Err(unsafe_settings());
        }
        Ok(())
    }
    fn name(byte: u8) -> bool {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
    }
    fn document(mut self) -> Result<()> {
        let mut section = Vec::new();
        loop {
            self.trivia();
            if self.peek().is_none() {
                return Ok(());
            }
            if self.peek() == Some(b'[') {
                self.advance()?;
                let start = self.at;
                while self.peek().is_some_and(Self::name) {
                    self.advance()?;
                }
                if self.at == start {
                    return Err(unsafe_settings());
                }
                section = self.bytes[start..self.at].to_vec();
                self.require(b']')?;
            } else {
                let start = self.at;
                while self.peek().is_some_and(Self::name) {
                    self.advance()?;
                }
                if self.at == start {
                    return Err(unsafe_settings());
                }
                let resource_packs =
                    section == b"visuals" && &self.bytes[start..self.at] == b"resource_packs";
                self.horizontal();
                self.require(b'=')?;
                if resource_packs {
                    self.base_pack()?;
                } else {
                    self.value(0)?;
                }
            }
            self.line_end()?;
        }
    }
    fn base_pack(&mut self) -> Result<()> {
        self.trivia();
        self.require(b'[')?;
        self.trivia();
        let start = self.at;
        self.string()?;
        if &self.bytes[start..self.at] != br#""BaseAssets""# {
            return Err(unsafe_settings());
        }
        self.trivia();
        self.require(b']')
    }
    fn string(&mut self) -> Result<()> {
        self.require(b'"')?;
        loop {
            let byte = self.peek().ok_or_else(unsafe_settings)?;
            self.at += 1;
            match byte {
                b'"' => return Ok(()),
                b'\\' => {
                    let escape = self.peek().ok_or_else(unsafe_settings)?;
                    self.at += 1;
                    match escape {
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {}
                        b'u' | b'U' => {
                            for _ in 0..if escape == b'u' { 4 } else { 6 } {
                                if !self.peek().is_some_and(|b| b.is_ascii_hexdigit()) {
                                    return Err(unsafe_settings());
                                }
                                self.at += 1;
                            }
                        }
                        _ => return Err(unsafe_settings()),
                    }
                }
                0..=31 | 127 => return Err(unsafe_settings()),
                _ => {}
            }
        }
    }
    fn value(&mut self, depth: usize) -> Result<()> {
        if depth >= 32 {
            return Err(unsafe_settings());
        }
        self.trivia();
        match self.peek() {
            Some(b'"') => self.string(),
            Some(b'[' | b'{') => {
                let open = self.advance()?;
                let close = if open == b'[' { b']' } else { b'}' };
                self.trivia();
                while self.peek() != Some(close) {
                    self.value(depth + 1)?;
                    if open == b'{' {
                        self.trivia();
                        self.require(b':')?;
                        self.value(depth + 1)?;
                    }
                    self.trivia();
                    if self.peek() == Some(close) {
                        break;
                    }
                    self.require(b',')?;
                    self.trivia();
                }
                self.require(close)
            }
            Some(b't' | b'f' | b'n') => {
                let word: &[u8] = match self.peek() {
                    Some(b't') => b"true",
                    Some(b'f') => b"false",
                    _ => b"null",
                };
                for &byte in word {
                    self.require(byte)?;
                }
                Ok(())
            }
            Some(b'-' | b'+' | b'0'..=b'9') => {
                if matches!(self.peek(), Some(b'-' | b'+')) {
                    self.advance()?;
                }
                self.digits()?;
                if self.peek() == Some(b'.') {
                    self.advance()?;
                    self.digits()?;
                }
                if matches!(self.peek(), Some(b'e' | b'E')) {
                    self.advance()?;
                    if matches!(self.peek(), Some(b'-' | b'+')) {
                        self.advance()?;
                    }
                    self.digits()?;
                }
                Ok(())
            }
            _ => Err(unsafe_settings()),
        }
    }
    fn digits(&mut self) -> Result<()> {
        let start = self.at;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.advance()?;
        }
        if self.at == start {
            return Err(unsafe_settings());
        }
        Ok(())
    }
}

pub(crate) fn original_ready(
    spec: &UserPreparedRuntimeSpec,
    root: &std::path::Path,
) -> Result<bool> {
    if spec.shared_preferences != Some(crate::PreparedSharedPreferencesContract::Smb1r11Windows) {
        return Ok(true);
    }
    #[cfg(any(windows, test))]
    {
        settings_at(root)?;
        original_at(root)
    }
    #[cfg(not(any(windows, test)))]
    {
        let _ = root;
        Err(PortcoveError::unsupported(
            "SMB1R shared original requires Windows",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn smb_shared_preferences_rejects_changed_artifact_arguments_and_environment() {
        let spec: UserPreparedRuntimeSpec = serde_json::from_value(serde_json::json!({
            "version":"1.1-stable", "archive_name":"Windows.zip", "archive_size":76214255,
            "archive_sha256":"164f5160b7b73f161b956fa1470813c8e21fa92424f94c8889de46111a59c109",
            "executable":"SMB1R.exe", "immutable_tree_sha256":"a8cb5667881f64dead389d8e8dd821bd4787f2b345156953d645f27412398b6a",
            "shared_preferences":"smb1r-1.1-stable-windows"
        })).unwrap();
        validate(&spec).unwrap();
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("dkc3-recomp")
            .unwrap()
            .clone();
        port.launch_arguments = vec!["--disable-mods".into()];
        port.launch_environment.clear();
        super::super::validate_route(&port, crate::Platform::WindowsX86_64, &spec).unwrap();
        port.launch_environment
            .insert("SNESRECOMP_NO_LAUNCHER".into(), "1".into());
        assert!(
            super::super::validate_route(&port, crate::Platform::WindowsX86_64, &spec).is_err()
        );
        port.launch_environment.clear();
        port.launch_arguments.push("--main-pack".into());
        assert!(
            super::super::validate_route(&port, crate::Platform::WindowsX86_64, &spec).is_err()
        );
        for (field, value) in [
            ("archive_sha256", serde_json::json!("f".repeat(64))),
            ("immutable_tree_sha256", serde_json::json!("f".repeat(64))),
            ("mutable_paths", serde_json::json!(["portable.txt"])),
            ("source_argument_extension", serde_json::json!("nes")),
            ("library_user_data", serde_json::json!(true)),
        ] {
            let mut changed = serde_json::to_value(&spec).unwrap();
            changed[field] = value;
            assert!(validate(&serde_json::from_value(changed).unwrap()).is_err());
        }
    }

    #[test]
    fn vanilla_shared_inputs_refuse_executable_overrides_but_preserve_generated_data() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for relative in [
            "resource_packs/BaseAssets/Sprites/Small.png",
            "resource_packs/BaseAssets/pack_info.json",
            "saves/player.json",
            "logs/latest.log",
        ] {
            vanilla_entry(root, &root.join(relative), false).unwrap();
        }
        for relative in [
            "custom_levels/autosaves",
            "blueprints",
            "custom_characters",
            "level_packs",
        ] {
            vanilla_entry(root, &root.join(relative), true).unwrap();
        }
        for relative in [
            "resource_packs/Custom",
            "resource_packs/BaseAssets/Sprites/Small.json",
            "resource_packs/BaseAssets/CharacterInfo.json",
            "resource_packs/BaseAssets/Small.png.REMAP",
            "nested/config.IMPORT",
            "nested/id.UID",
            "custom_characters/Mario/LifeIcon.json",
            "custom_levels/autosaves/level",
            "level_packs/custom.zip",
            "blueprints/any-extension",
        ] {
            assert!(
                vanilla_entry(root, &root.join(relative), false).is_err(),
                "{relative}"
            );
        }
        std::fs::create_dir_all(root.join("custom_levels/autosaves")).unwrap();
        let file = root.join("custom_levels/autosaves/level");
        std::fs::write(&file, b"retained import").unwrap();
        assert!(check_shared_tree(root).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"retained import");
    }

    #[test]
    fn shared_original_is_never_seeded_and_refuses_wrong_size_bytes_and_links() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("SMB1R");
        assert!(!original_at(&root).unwrap());
        assert!(!root.exists());
        std::fs::create_dir(&root).unwrap();
        let file = root.join("baserom.nes");
        for bytes in [vec![0; 40_975], vec![0; 40_976], vec![0; 40_977]] {
            std::fs::write(&file, &bytes).unwrap();
            assert!(!original_at(&root).unwrap());
            assert_eq!(std::fs::read(&file).unwrap(), bytes);
        }
        std::fs::hard_link(&file, root.join("alias")).unwrap();
        assert!(original_at(&root).is_err());
    }

    #[test]
    fn shared_directory_refuses_nested_aliases_without_owning_mutable_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("SMB1R");
        check_shared_tree(&root).unwrap();
        assert!(!root.exists());
        std::fs::create_dir_all(root.join("saves")).unwrap();
        let save = root.join("saves/player.json");
        std::fs::write(&save, b"player data").unwrap();
        check_shared_tree(&root).unwrap();
        std::fs::write(&save, b"ordinary edit").unwrap();
        check_shared_tree(&root).unwrap();
        std::fs::hard_link(&save, directory.path().join("outside")).unwrap();
        assert!(check_shared_tree(&root).is_err());
        assert_eq!(std::fs::read(&save).unwrap(), b"ordinary edit");
    }

    #[test]
    fn settings_admit_selected_writer_data_but_never_variant_constructors() {
        data_only_settings(
            br#"; Object(Resource()) is inert in a comment
[keyboard]
up=["W", "Up", 12, "0,-1"]
[video]
fullscreen=true
scale=1.5
selection={
; a multiline ordinary writer dictionary
"name": "Resource(\"res://not-loaded.gd\")", "character": [0, null]}
[visuals]
resource_packs=["BaseAssets"]
"#,
        )
        .unwrap();
        for unsafe_text in [
            "[visuals]\nresource_packs=[\"BaseAssets\", \"Custom\"]",
            "[visuals]\nresource_packs=[\"../outside\"]",
            "[visuals]\nresource_packs=[]",
            "[visuals]\nresource_packs=[\"BaseAssets\"]\nresource_packs=[\"Custom\"]",
            "[;]x=Resource(\"user://candidate.tres\")\n]",
            "[\"]x=Resource(\"user://candidate.tres\")\n\"]",
            "[s]x=Resource(\"user://candidate.tres\")",
            "[s]\nx=1 y=Resource(\"x\")",
            "[s]\nx=Object(InputEventKey,\"script\":Resource(\"res://x.gd\"))",
            "[s]\nx=[{\"nested\":ExtResource(\"uid://x\")}]",
            "[s]\nx=Array[Object]([])",
            "[s]\nx=Resource ; comment\n(\"user://x.tres\")",
            "[s]\nx=\"unfinished",
            "[s]\nx=[}",
            "[s]\nx=/*comment*/Resource(\"x\")",
        ] {
            assert!(
                data_only_settings(unsafe_text.as_bytes()).is_err(),
                "{unsafe_text}"
            );
        }
        assert!(data_only_settings(&vec![b' '; 1024 * 1024 + 1]).is_err());
        assert!(
            data_only_settings(format!("{}{}", "[".repeat(33), "]".repeat(33)).as_bytes()).is_err()
        );
        assert!(data_only_settings(&vec![b'a'; 65_537]).is_err());
    }
}
