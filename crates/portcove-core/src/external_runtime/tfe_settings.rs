//! Conservative reader for TFE cc25205's settings parser, not a general INI API.
//! Pinned upstream parser.cpp/iniParser.cpp: comments also terminate quoted
//! values, separators are whitespace/comma/equals, empty quotes emit a token.
use std::{fs::File, io::Read};

use crate::{PortcoveError, Result, UserPreparedRuntimeSpec};

const MAX_BYTES: u64 = 1024 * 1024;
pub(super) const GOBS: [&str; 4] = ["DARK.GOB", "SOUNDS.GOB", "SPRITES.GOB", "TEXTURES.GOB"];

fn invalid() -> PortcoveError {
    PortcoveError::verification("TFE settings must select Dark Forces and immutable GameData/")
}

pub(super) fn validate_declaration(spec: &UserPreparedRuntimeSpec) -> Result<()> {
    if spec.version != "1.22.420"
        || !spec
            .required_mutable_files
            .iter()
            .any(|path| path == "settings.ini")
        || spec.executable.contains(['/', '\\'])
        || spec.source_argument_extension.is_some()
        || spec.library_user_data
        || spec
            .mutable_paths
            .iter()
            .any(|path| crate::runtime::overlaps(path, "GameData"))
    {
        return Err(PortcoveError::usage(
            "TFE settings contract requires root executable, settings.ini selector and immutable GameData without source arguments or private data binding",
        ));
    }
    Ok(())
}

pub(crate) fn check(file: &File) -> Result<()> {
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    check_bytes(&bytes)
}

pub(crate) fn check_bytes(bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 > MAX_BYTES || bytes.contains(&0) {
        return Err(invalid());
    }
    parse(bytes)
}

fn whitespace(byte: u8) -> bool {
    !(33..127).contains(&byte)
}

fn tokens(line: &[u8]) -> Result<Vec<Vec<u8>>> {
    // Bound the entire line even when the upstream reader drops a comment tail.
    if line.len() >= 4096 {
        return Err(invalid());
    }
    let comment = line
        .iter()
        .position(|byte| matches!(byte, b';' | b'#'))
        .unwrap_or(line.len());
    let line = &line[..comment];
    let start = line
        .iter()
        .position(|byte| !whitespace(*byte))
        .unwrap_or(line.len());
    let end = line
        .iter()
        .rposition(|byte| !whitespace(*byte))
        .map_or(start, |i| i + 1);
    let mut result = Vec::new();
    let mut current = Vec::new();
    let mut quoted = false;
    for &byte in &line[start..end] {
        if byte == b'"' {
            if quoted && current.is_empty() && result.len() < 3 {
                result.push(Vec::new());
            }
            quoted = !quoted;
        } else if !quoted && (whitespace(byte) || matches!(byte, b'=' | b',')) {
            if !current.is_empty() {
                if result.len() < 3 {
                    result.push(std::mem::take(&mut current));
                }
                current.clear();
            }
        } else {
            current.push(byte);
            if current.len() >= 1024 {
                return Err(invalid());
            }
        }
    }
    if quoted {
        return Err(invalid());
    }
    if !current.is_empty() && result.len() < 3 {
        result.push(current);
    }
    Ok(result)
}

fn parse(bytes: &[u8]) -> Result<()> {
    let mut section = Vec::new();
    let mut game = false;
    let mut source = false;
    for line in bytes.split(|byte| matches!(byte, b'\r' | b'\n')) {
        let tokens = tokens(line)?;
        // parseCVars copies the decoded value into tmp[256] before inspecting it.
        if section.eq_ignore_ascii_case(b"CVar")
            && let [_, value] = tokens.as_slice()
        {
            if value.len() >= 256 {
                return Err(invalid());
            }
            let mut words = value
                .split(|byte| *byte == b' ')
                .filter(|word| !word.is_empty());
            if words
                .next()
                .is_some_and(|kind| kind.eq_ignore_ascii_case(b"string"))
                && words.next().is_some_and(|word| word.len() < 2)
            {
                return Err(invalid());
            }
        }
        match tokens.as_slice() {
            [name] => {
                // Upstream strips both ends without checking brackets. Refuse
                // ambiguous/malformed sections instead of silently disagreeing.
                if name.len() < 2 || name[0] != b'[' || name[name.len() - 1] != b']' {
                    return Err(invalid());
                }
                section = name[1..name.len() - 1].to_vec();
            }
            [key, value]
                if section.eq_ignore_ascii_case(b"Game") && key.eq_ignore_ascii_case(b"game") =>
            {
                if game || !value.eq_ignore_ascii_case(b"Dark Forces") {
                    return Err(invalid());
                }
                game = true;
            }
            [key, value]
                if section.eq_ignore_ascii_case(b"Dark_Forces")
                    && key.eq_ignore_ascii_case(b"sourcePath") =>
            {
                if source || value != b"GameData/" {
                    return Err(invalid());
                }
                source = true;
            }
            _ => {} // Upstream ignores lines with more than two tokens.
        }
    }
    if !game || !source {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
#[path = "tfe_settings_tests.rs"]
mod tests;
