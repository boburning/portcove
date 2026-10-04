use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{
    ChildProcessClass, ChildProcessPolicy, Library, OperationCoordinator, OperationEvent,
    OperationResult, Platform, PortcoveError, Result, SourceRecord,
    adapter::{hash_file, materialize_psx_chd},
    archive::{extract_archive, validate_download_progress, validate_download_size},
};

const TOOLCHAIN_VERSION: &str = "1.0.14";

#[derive(Debug, Clone)]
pub struct PsxManagedPreparation {
    pub source: SourceRecord,
    pub bios: Option<SourceRecord>,
    pub source_paths: Vec<PathBuf>,
    pub runtime_source_directory: Option<PathBuf>,
    pub toolchain_root: PathBuf,
    pub executable_basename: String,
}

#[derive(Debug, Clone, Copy)]
struct ToolchainArtifact {
    name: &'static str,
    size: u64,
    sha256: &'static str,
}

#[derive(Debug, Serialize, Deserialize)]
struct ToolchainMarker {
    schema_version: u32,
    version: String,
    platform: Platform,
    asset_name: String,
    sha256: String,
    critical_files: Vec<ToolchainFileIdentity>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ToolchainFileIdentity {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Serialize)]
struct ManagedMarker<'a> {
    schema_version: u32,
    adapter: &'a str,
    source_sha256: &'a str,
    source_storage_sha256: &'a str,
    bios_source_sha256: Option<&'a str>,
    toolchain_version: &'a str,
}

struct DirectoryGuard(PathBuf);

impl Drop for DirectoryGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) async fn ensure_toolchain<F>(
    library: &Library,
    platform: Platform,
    parent: &OperationCoordinator,
    emit: &mut F,
) -> Result<PathBuf>
where
    F: FnMut(OperationEvent),
{
    let operation = parent.child("psx_toolchain", None);
    emit(operation.started());
    let result = ensure_toolchain_inner(library, platform, &operation, emit).await;
    emit(operation.finished(if result.is_ok() {
        OperationResult::Succeeded
    } else {
        OperationResult::Failed
    }));
    result
}

async fn ensure_toolchain_inner<F>(
    library: &Library,
    platform: Platform,
    operation: &OperationCoordinator,
    emit: &mut F,
) -> Result<PathBuf>
where
    F: FnMut(OperationEvent),
{
    let artifact = toolchain_artifact(platform)?;
    let destination = library
        .toolchains_dir()
        .join("cmake-clang-v1")
        .join(TOOLCHAIN_VERSION);
    if validate_toolchain(&destination, platform, artifact)? {
        return Ok(destination);
    }

    let operation_root = library
        .staging_dir()
        .join(format!("psx-toolchain-{}", Uuid::new_v4()));
    let guard = DirectoryGuard(operation_root.clone());
    let unpacked = operation_root.join("unpacked");
    fs::create_dir_all(&unpacked)?;
    let archive_path = operation_root.join(artifact.name);
    let url = format!(
        "https://github.com/TechnicallyComputers/retcomm-toolchains/releases/download/v{TOOLCHAIN_VERSION}/{}",
        artifact.name
    );
    let client = reqwest::Client::builder()
        .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| PortcoveError::network(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| PortcoveError::network(error.to_string()))?
        .error_for_status()
        .map_err(|error| PortcoveError::network(error.to_string()))?;
    validate_download_progress(0, artifact.size)?;
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&archive_path).await?;
    let mut completed = 0_u64;
    let mut reported = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| PortcoveError::network(error.to_string()))?;
        file.write_all(&chunk).await?;
        completed += chunk.len() as u64;
        validate_download_progress(completed, artifact.size)?;
        if completed == artifact.size || completed.saturating_sub(reported) >= 1024 * 1024 {
            emit(operation.progress("psx-toolchain-download", completed, Some(artifact.size)));
            reported = completed;
        }
    }
    if completed != reported {
        emit(operation.progress("psx-toolchain-download", completed, Some(artifact.size)));
    }
    file.flush().await?;
    drop(file);
    validate_download_size(completed, artifact.size)?;
    let (actual_sha256, actual_size) = hash_file(&archive_path)?;
    if actual_size != artifact.size || !actual_sha256.eq_ignore_ascii_case(artifact.sha256) {
        return Err(PortcoveError::verification(
            "PS1 toolchain failed its pinned artifact verification",
        )
        .detail("expected_sha256", artifact.sha256)
        .detail("actual_sha256", actual_sha256)
        .detail("expected_size", artifact.size.to_string())
        .detail("actual_size", actual_size.to_string()));
    }

    extract_archive(&archive_path, &unpacked, artifact.name, artifact.size)?;
    let pack_root = locate_pack_root(&unpacked)?;
    let critical_files = toolchain_file_identities(&pack_root, platform)?;
    let marker = ToolchainMarker {
        schema_version: 2,
        version: TOOLCHAIN_VERSION.into(),
        platform,
        asset_name: artifact.name.into(),
        sha256: artifact.sha256.into(),
        critical_files,
    };
    fs::write(
        pack_root.join(".portcove-toolchain.json"),
        serde_json::to_vec_pretty(&marker)?,
    )?;
    fs::create_dir_all(destination.parent().expect("toolchain has a parent"))?;
    if destination.exists() {
        fs::remove_dir_all(&destination)?;
    }
    crate::durability::rename_noreplace(&pack_root, &destination)?;
    if !validate_toolchain(&destination, platform, artifact)? {
        return Err(PortcoveError::verification(
            "installed PS1 toolchain did not pass its post-install checks",
        ));
    }
    drop(guard);
    Ok(destination)
}

pub(crate) fn prepare_install(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
) -> (Result<()>, bool) {
    let mut quiesced = true;
    let result = prepare_install_inner(root, preparation, operation, &mut quiesced);
    (result, quiesced)
}

fn prepare_install_inner(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
) -> Result<()> {
    operation.checkpoint()?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    if let Some(bios) = &preparation.bios {
        crate::adapter::verify_source_storage_identity(bios, "PS1 BIOS")?;
    }
    let cli = root.join("psxrecomp").join("psxrecomp_cli.py");
    let config = root.join("game.toml");
    if !cli.is_file() || !config.is_file() {
        return Err(PortcoveError::install(
            "PS1 setup package is missing its fixed psxrecomp CLI contract",
        ));
    }
    let python = toolchain_python(&preparation.toolchain_root)?;
    let primary_source = preparation.source_paths.first().ok_or_else(|| {
        PortcoveError::source("managed PS1 preparation has no verified disc source")
    })?;
    operation.checkpoint()?;
    let temporary = retained_source_workspace(root)?;
    // This existing CHD helper exposes no quiescence observer. A later builder
    // callback cannot erase its uncertainty, even on a contained platform.
    *quiesced = false;
    let cue = materialize_psx_chd(primary_source, &temporary)?;
    operation.checkpoint()?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    let config_path = crate::path::unicode(&config, "managed build config")?;
    let project_root = crate::path::unicode(root, "managed build root")?;
    let mut generate_arguments = vec![
        "generate".into(),
        "--config".into(),
        config_path.clone(),
        "--project-root".into(),
        project_root.clone(),
        "--disc".into(),
        crate::path::unicode(&cue, "managed disc")?,
    ];
    if let Some(bios) = &preparation.bios {
        generate_arguments.extend([
            "--bios".into(),
            crate::path::unicode(&bios.path, "BIOS source")?,
        ]);
    }
    generate_arguments.push("--json-progress".into());
    run_cli(
        &python,
        &cli,
        root,
        &preparation.toolchain_root,
        generate_arguments,
        operation,
        quiesced,
    )?;
    if let Some(bios) = &preparation.bios {
        crate::adapter::verify_source_storage_identity(bios, "PS1 BIOS")?;
    }
    rewrite_game_discs(&config, &preparation.source_paths)?;
    let build_dir = root.join("build-portcove");
    run_cli(
        &python,
        &cli,
        root,
        &preparation.toolchain_root,
        [
            "rebuild".into(),
            "--config".into(),
            config_path,
            "--project-root".into(),
            project_root,
            "--build-dir".into(),
            crate::path::unicode(&build_dir, "managed build directory")?,
            "--target".into(),
            "psx-runtime".into(),
            "--exe-basename".into(),
            preparation.executable_basename.clone(),
            "--no-pgo".into(),
            "--no-toolchain-download".into(),
            "--prune-after".into(),
            "build-intermediates".into(),
            "--json-progress".into(),
        ],
        operation,
        quiesced,
    )?;
    let executable = platform_executable(&build_dir, &preparation.executable_basename);
    if !executable.is_file() {
        return Err(PortcoveError::install(format!(
            "PS1 build completed without {}",
            executable.display()
        )));
    }
    let runtime_sources = if let Some(relative) = &preparation.runtime_source_directory {
        operation.checkpoint()?;
        *quiesced = false;
        materialize_runtime_raw_set(&build_dir, relative, preparation)?
    } else {
        preparation.source_paths.clone()
    };
    let runtime_config = build_dir.join("game.toml");
    prepare_runtime_config(&config, &runtime_config, &runtime_sources)?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    let prepared_disc = root.join("disc");
    if prepared_disc.is_dir() {
        fs::remove_dir_all(prepared_disc)?;
    }
    let staged_bios = root.join("psxrecomp").join("bios").join("SCPH1001.BIN");
    if staged_bios.is_file() {
        fs::remove_file(staged_bios)?;
    }
    fs::write(
        root.join(".portcove-managed.json"),
        serde_json::to_vec_pretty(&ManagedMarker {
            schema_version: 1,
            adapter: "psx-recomp-managed",
            source_sha256: &preparation.source.sha256,
            source_storage_sha256: &preparation.source.storage_sha256,
            bios_source_sha256: preparation.bios.as_ref().map(|bios| bios.sha256.as_str()),
            toolchain_version: TOOLCHAIN_VERSION,
        })?,
    )?;
    Ok(())
}

pub(crate) fn rewrite_game_discs(config: &Path, sources: &[PathBuf]) -> Result<()> {
    if sources.is_empty() {
        return Err(config_error("no verified disc sources"));
    }
    let body = fs::read_to_string(config)?;
    let (tokens, comments) = config_tokens(&body)?;
    let (header_end, field) = config_disc_field(&body, &tokens)?;
    let newline = if body.contains("\r\n") { "\r\n" } else { "\n" };
    let sources = sources
        .iter()
        .map(|source| {
            // JSON and TOML 1.0 basic strings share these escapes, except that
            // TOML also requires DEL to be escaped.
            Ok(
                serde_json::to_string(&crate::path::unicode(source, "PS1 source")?)?
                    .replace('\u{7f}', "\\u007F"),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let key = if sources.len() == 1 { "disc" } else { "discs" };
    let retained_comments = field
        .as_ref()
        .map(|(_, value)| {
            comments
                .iter()
                .filter(|comment| value.start <= comment.start && comment.end <= value.end)
                .map(|comment| &body[comment.clone()])
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut value = if sources.len() == 1 {
        sources[0].clone()
    } else {
        format!("[{newline}")
    };
    if sources.len() > 1 {
        for source in &sources {
            value.push_str(&format!("    {source},{newline}"));
        }
        for comment in &retained_comments {
            value.push_str(&format!("    {comment}{newline}"));
        }
        value.push(']');
    } else if !retained_comments.is_empty() {
        value.push_str(newline);
        value.push_str(&retained_comments.join(newline));
        // Keep the original trailing comment separate from comments that were
        // inside the replaced array; leave the original EOF/newline untouched.
        let suffix = &body[field.as_ref().expect("comments have a field").1.end..];
        if suffix.trim_start_matches([' ', '\t']).starts_with('#') {
            value.push_str(newline);
        }
    }

    // Only the key/value spans change. UTF-8, unrelated text, line endings and
    // the final newline are retained; comments within old values remain in order.
    // This is an editor for the fixed game/disc contract, not a TOML validator.
    let mut output = body.clone();
    if let Some((old_key, old_value)) = field {
        output.replace_range(old_value, &value);
        if config_key(&body, tokens_for_range(&tokens, &old_key))? != [key] {
            let replacement = match body.as_bytes()[old_key.start] {
                b'\'' => format!("'{key}'"),
                b'"' => format!("\"{key}\""),
                _ => key.to_string(),
            };
            output.replace_range(old_key, &replacement);
        }
    } else {
        let separator = if body[..header_end].ends_with('\n') {
            ""
        } else {
            newline
        };
        let ending = if header_end < body.len() || body.ends_with('\n') {
            newline
        } else {
            ""
        };
        output.insert_str(header_end, &format!("{separator}{key} = {value}{ending}"));
    }
    fs::write(config, output)?;
    Ok(())
}

#[derive(Clone, Copy, PartialEq)]
enum ConfigTokenKind {
    Text,
    String,
    Symbol(u8),
    Newline,
}

struct ConfigToken {
    kind: ConfigTokenKind,
    span: std::ops::Range<usize>,
}

fn config_error(reason: &str) -> PortcoveError {
    PortcoveError::install(format!("cannot rewrite PS1 disc configuration: {reason}"))
}

fn config_escape(body: &str, start: usize) -> Result<(usize, char)> {
    let bytes = body.as_bytes();
    let escaped = *bytes
        .get(start + 1)
        .ok_or_else(|| config_error("unfinished escape"))?;
    let simple = match escaped {
        b'b' => Some('\u{8}'),
        b't' => Some('\t'),
        b'n' => Some('\n'),
        b'f' => Some('\u{c}'),
        b'r' => Some('\r'),
        b'"' => Some('"'),
        b'\\' => Some('\\'),
        _ => None,
    };
    if let Some(character) = simple {
        return Ok((start + 2, character));
    }
    let digits = match escaped {
        b'u' => 4,
        b'U' => 8,
        _ => return Err(config_error("invalid TOML 1.0 escape")),
    };
    let end = start + 2 + digits;
    let hexadecimal = body
        .get(start + 2..end)
        .ok_or_else(|| config_error("unfinished Unicode escape"))?;
    if !hexadecimal.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(config_error("invalid Unicode escape"));
    }
    let character = u32::from_str_radix(hexadecimal, 16)
        .ok()
        .and_then(char::from_u32)
        .ok_or_else(|| config_error("invalid Unicode scalar"))?;
    Ok((end, character))
}

fn config_string_end(body: &str, start: usize) -> Result<usize> {
    let bytes = body.as_bytes();
    let quote = bytes[start];
    let multiline = bytes
        .get(start..start + 3)
        .is_some_and(|run| run == [quote; 3]);
    let mut cursor = start + if multiline { 3 } else { 1 };
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if byte == quote {
            let count = bytes[cursor..]
                .iter()
                .take_while(|byte| **byte == quote)
                .count();
            if !multiline {
                return Ok(cursor + 1);
            }
            if count >= 3 {
                if count > 5 {
                    return Err(config_error("invalid multiline string delimiter"));
                }
                return Ok(cursor + count);
            }
            cursor += count;
        } else if byte == b'\\' && quote == b'"' {
            let mut next = cursor + 1;
            while multiline
                && bytes
                    .get(next)
                    .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
            {
                next += 1;
            }
            if multiline
                && bytes
                    .get(next)
                    .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
            {
                while bytes
                    .get(next)
                    .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
                {
                    if bytes[next] == b'\r' && bytes.get(next + 1) != Some(&b'\n') {
                        return Err(config_error("invalid newline"));
                    }
                    next += 1;
                }
                cursor = next;
            } else {
                cursor = config_escape(body, cursor)?.0;
            }
        } else if byte == b'\n' || byte == b'\r' {
            if !multiline || (byte == b'\r' && bytes.get(cursor + 1) != Some(&b'\n')) {
                return Err(config_error("invalid string newline"));
            }
            cursor += if byte == b'\r' { 2 } else { 1 };
        } else {
            if matches!(byte, 0..=8 | 11..=31 | 127) {
                return Err(config_error("invalid string control character"));
            }
            cursor += 1;
        }
    }
    Err(config_error("unterminated string"))
}

type ConfigSpans = (Vec<ConfigToken>, Vec<std::ops::Range<usize>>);

fn config_tokens(body: &str) -> Result<ConfigSpans> {
    let bytes = body.as_bytes();
    let mut tokens = Vec::new();
    let mut comments = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let start = cursor;
        let kind = match bytes[cursor] {
            b' ' | b'\t' => {
                cursor += 1;
                continue;
            }
            b'\r' | b'\n' => {
                if bytes[cursor] == b'\r' {
                    if bytes.get(cursor + 1) != Some(&b'\n') {
                        return Err(config_error("invalid newline"));
                    }
                    cursor += 1;
                }
                cursor += 1;
                ConfigTokenKind::Newline
            }
            b'#' => {
                while cursor < bytes.len() && !matches!(bytes[cursor], b'\r' | b'\n') {
                    if matches!(bytes[cursor], 0..=8 | 11..=31 | 127) {
                        return Err(config_error("invalid comment control character"));
                    }
                    cursor += 1;
                }
                comments.push(start..cursor);
                continue;
            }
            b'\'' | b'"' => {
                cursor = config_string_end(body, cursor)?;
                ConfigTokenKind::String
            }
            symbol @ (b'[' | b']' | b'{' | b'}' | b'=' | b'.' | b',') => {
                cursor += 1;
                ConfigTokenKind::Symbol(symbol)
            }
            _ => {
                while cursor < bytes.len()
                    && !matches!(
                        bytes[cursor],
                        b' ' | b'\t'
                            | b'\r'
                            | b'\n'
                            | b'#'
                            | b'\''
                            | b'"'
                            | b'['
                            | b']'
                            | b'{'
                            | b'}'
                            | b'='
                            | b'.'
                            | b','
                    )
                {
                    if bytes[cursor].is_ascii_control() {
                        return Err(config_error("invalid control character"));
                    }
                    cursor += 1;
                }
                ConfigTokenKind::Text
            }
        };
        tokens.push(ConfigToken {
            kind,
            span: start..cursor,
        });
    }
    Ok((tokens, comments))
}

fn tokens_for_range<'a>(
    tokens: &'a [ConfigToken],
    span: &std::ops::Range<usize>,
) -> &'a [ConfigToken] {
    let start = tokens.partition_point(|token| token.span.start < span.start);
    let end = tokens.partition_point(|token| token.span.end <= span.end);
    &tokens[start..end]
}

fn config_key(body: &str, tokens: &[ConfigToken]) -> Result<Vec<String>> {
    let mut parts = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        if index % 2 == 1 {
            if token.kind != ConfigTokenKind::Symbol(b'.') {
                return Err(config_error("invalid dotted key"));
            }
            continue;
        }
        let text = &body[token.span.clone()];
        let part = match token.kind {
            ConfigTokenKind::Text
                if text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) =>
            {
                text.to_string()
            }
            ConfigTokenKind::String if !text.starts_with("\"\"\"") && !text.starts_with("'''") => {
                let mut part = String::new();
                let mut cursor = token.span.start + 1;
                while cursor < token.span.end - 1 {
                    if body.as_bytes()[cursor] == b'\\' && text.starts_with('"') {
                        let (next, character) = config_escape(body, cursor)?;
                        part.push(character);
                        cursor = next;
                    } else {
                        let character = body[cursor..].chars().next().expect("character in string");
                        part.push(character);
                        cursor += character.len_utf8();
                    }
                }
                part
            }
            _ => return Err(config_error("invalid key")),
        };
        parts.push(part);
    }
    if tokens.is_empty() || tokens.len().is_multiple_of(2) {
        return Err(config_error("unfinished key"));
    }
    Ok(parts)
}

type ConfigDiscField = (
    usize,
    Option<(std::ops::Range<usize>, std::ops::Range<usize>)>,
);

fn config_disc_field(body: &str, tokens: &[ConfigToken]) -> Result<ConfigDiscField> {
    let mut cursor = 0;
    let mut in_game = false;
    let mut header_end = None;
    let mut field = None;
    while cursor < tokens.len() {
        if tokens[cursor].kind == ConfigTokenKind::Newline {
            cursor += 1;
            continue;
        }
        let start = cursor;
        if tokens[cursor].kind == ConfigTokenKind::Symbol(b'[') {
            let end = tokens[cursor..]
                .iter()
                .position(|token| token.kind == ConfigTokenKind::Newline)
                .map_or(tokens.len(), |offset| cursor + offset);
            let array = tokens
                .get(cursor + 1)
                .is_some_and(|token| token.kind == ConfigTokenKind::Symbol(b'['));
            let delimiters = if array { 2 } else { 1 };
            if end <= cursor + delimiters * 2
                || !tokens[end - delimiters..end]
                    .iter()
                    .all(|token| token.kind == ConfigTokenKind::Symbol(b']'))
            {
                return Err(config_error("invalid table header"));
            }
            let key = config_key(body, &tokens[cursor + delimiters..end - delimiters])?;
            in_game = key == ["game"];
            if key.first().is_some_and(|key| key == "game")
                && key
                    .get(1)
                    .is_some_and(|key| matches!(key.as_str(), "disc" | "discs"))
            {
                return Err(config_error("disc field is a table"));
            }
            if in_game {
                if array || header_end.is_some() {
                    return Err(config_error("ambiguous game table"));
                }
                header_end = Some(tokens.get(end).map_or(body.len(), |token| token.span.end));
            }
            cursor = end;
            continue;
        }
        while cursor < tokens.len()
            && !matches!(
                tokens[cursor].kind,
                ConfigTokenKind::Symbol(b'=') | ConfigTokenKind::Newline
            )
        {
            cursor += 1;
        }
        if tokens
            .get(cursor)
            .is_none_or(|token| token.kind != ConfigTokenKind::Symbol(b'='))
        {
            return Err(config_error("missing assignment"));
        }
        let equals = cursor;
        let key = config_key(body, &tokens[start..equals])?;
        cursor += 1;
        let value_start = cursor;
        let mut nesting = Vec::new();
        while cursor < tokens.len() {
            match tokens[cursor].kind {
                ConfigTokenKind::Newline if nesting.is_empty() => break,
                ConfigTokenKind::Symbol(b'[') => nesting.push(b']'),
                ConfigTokenKind::Symbol(b'{') => nesting.push(b'}'),
                ConfigTokenKind::Symbol(close @ (b']' | b'}')) if nesting.pop() != Some(close) => {
                    return Err(config_error("mismatched value delimiter"));
                }
                _ => {}
            }
            cursor += 1;
        }
        if !nesting.is_empty() || cursor == value_start {
            return Err(config_error("unfinished value"));
        }
        if in_game
            && key
                .first()
                .is_some_and(|key| matches!(key.as_str(), "disc" | "discs"))
        {
            if key.len() != 1 || field.is_some() {
                return Err(config_error("ambiguous disc field"));
            }
            validate_disc_tokens(&tokens[value_start..cursor], key[0] == "discs")?;
            field = Some((
                tokens[start].span.start..tokens[equals - 1].span.end,
                tokens[value_start].span.start..tokens[cursor - 1].span.end,
            ));
        }
    }
    Ok((
        header_end.ok_or_else(|| config_error("missing game table"))?,
        field,
    ))
}

fn validate_disc_tokens(tokens: &[ConfigToken], plural: bool) -> Result<()> {
    if !plural {
        return if tokens.len() == 1 && tokens[0].kind == ConfigTokenKind::String {
            Ok(())
        } else {
            Err(config_error("disc must be a string"))
        };
    }
    if tokens
        .first()
        .is_none_or(|token| token.kind != ConfigTokenKind::Symbol(b'['))
        || tokens
            .last()
            .is_none_or(|token| token.kind != ConfigTokenKind::Symbol(b']'))
    {
        return Err(config_error("discs must be a string array"));
    }
    let mut expect_string = true;
    for token in &tokens[1..tokens.len() - 1] {
        match token.kind {
            ConfigTokenKind::Newline => {}
            ConfigTokenKind::String if expect_string => expect_string = false,
            ConfigTokenKind::Symbol(b',') if !expect_string => expect_string = true,
            _ => return Err(config_error("invalid disc array member")),
        }
    }
    Ok(())
}

fn prepare_runtime_config(project: &Path, runtime: &Path, sources: &[PathBuf]) -> Result<()> {
    if !runtime.is_file() {
        fs::copy(project, runtime)?;
    }
    rewrite_game_discs(runtime, sources)
}

fn materialize_runtime_raw_set(
    build_dir: &Path,
    relative: &Path,
    preparation: &PsxManagedPreparation,
) -> Result<Vec<PathBuf>> {
    let relative_text = crate::path::unicode(relative, "managed PS1 runtime source")?;
    let normalized_relative = relative_text.replace('\\', "/");
    crate::archive::validate_relative_path(&normalized_relative, false)?;
    let destination = build_dir.join(relative);
    crate::adapter::materialize_psx_cue_set(&preparation.source.path, &destination)?;

    let mut runtime_sources = Vec::with_capacity(preparation.source_paths.len());
    let mut hashes = Vec::with_capacity(preparation.source_paths.len());
    let mut total_size = 0_u64;
    for index in 0..preparation.source_paths.len() {
        let bin_filename = format!("disc-{:02}.bin", index + 1);
        let materialized = destination.join(&bin_filename);
        if !materialized.is_file() {
            return Err(PortcoveError::verification(format!(
                "managed PS1 runtime source is missing {bin_filename}"
            )));
        }
        let (sha256, size) = hash_file(&materialized)?;
        hashes.push(sha256);
        total_size = total_size.saturating_add(size);
        let cue_filename = format!("disc-{:02}.cue", index + 1);
        if !destination.join(&cue_filename).is_file() {
            return Err(PortcoveError::verification(format!(
                "managed PS1 runtime source is missing {cue_filename}"
            )));
        }
        runtime_sources.push(PathBuf::from(format!(
            "{normalized_relative}/{cue_filename}"
        )));
    }
    let aggregate = crate::adapter::aggregate_sha256(&hashes);
    if aggregate != preparation.source.sha256 || total_size != preparation.source.size {
        return Err(PortcoveError::verification(
            "managed PS1 runtime source does not match the verified disc set",
        )
        .detail("expected_sha256", &preparation.source.sha256)
        .detail("actual_sha256", aggregate)
        .detail("expected_size", preparation.source.size.to_string())
        .detail("actual_size", total_size.to_string()));
    }
    Ok(runtime_sources)
}

fn retained_source_workspace(root: &Path) -> Result<PathBuf> {
    // Disarm automatic removal before any possible native owner, including
    // unwind. The Install journal owns this directory beneath staging.
    Ok(tempfile::Builder::new()
        .prefix("psx-source-")
        .tempdir_in(root.parent().unwrap_or(root))?
        .keep())
}

fn run_cli(
    python: &Path,
    cli: &Path,
    project_root: &Path,
    toolchain_root: &Path,
    arguments: impl IntoIterator<Item = String>,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
) -> Result<()> {
    let mut command =
        ChildProcessPolicy::native_command(ChildProcessClass::ManagedBuilder, python)?;
    command
        .arg(cli)
        .args(arguments)
        .current_dir(project_root)
        .env("RETCOMM_TOOLCHAIN_DIR", toolchain_root)
        .env("PSXRECOMP_TOOLCHAIN_DIR", toolchain_root);
    let previous_quiescence = *quiesced;
    *quiesced = false;
    let mut command_quiesced = false;
    let mut captured = None;
    let output = crate::tool_process::run_tool(
        &mut command,
        &|| operation.checkpoint(),
        crate::tool_process::ToolProcessObserver {
            diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                activity_id: operation.operation_id(),
                phase: "install.ps1.builder",
                record: &mut |snapshot| {
                    captured = Some(snapshot.clone());
                    Ok(())
                },
            }),
            quiesced: Some(&mut || {
                command_quiesced = true;
                Ok(())
            }),
        },
    );
    *quiesced = previous_quiescence && command_quiesced;
    let output = output.map_err(|error| {
        if error.code == crate::ErrorCode::Launch {
            PortcoveError::install(format!("could not run PS1 builder: {error}"))
        } else {
            error
        }
    })?;
    if output.status.success() {
        return Ok(());
    }
    // Preserve the builder's stderr/stdout failure ordering while using the
    // existing bounded, redacted per-stream capture, not unbounded output().
    let captured = captured.expect("supervisor provides final builder capture");
    let mut detail = captured
        .stderr
        .text
        .lines()
        .chain(captured.stdout.text.lines())
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let mut end = detail.len().min(64 * 1024);
    while !detail.is_char_boundary(end) {
        end -= 1;
    }
    let truncated = captured.stdout.truncated || captured.stderr.truncated || end < detail.len();
    detail.truncate(end);
    Err(
        PortcoveError::install(format!("PS1 builder exited with {}", output.status))
            .detail("output_tail", detail)
            .detail("output_truncated", truncated.to_string()),
    )
}

fn toolchain_artifact(platform: Platform) -> Result<ToolchainArtifact> {
    match platform {
        Platform::WindowsX86_64 => Ok(ToolchainArtifact {
            name: "cmake-clang-v1-windows-x64.zip",
            size: 209_497_009,
            sha256: "28da9742385e7ff875b3d9311e8ed89dbdc84f27b6ecba2bc0d0acc11f6d2b4d",
        }),
        Platform::LinuxX86_64 => Ok(ToolchainArtifact {
            name: "cmake-clang-v1-linux-x64.zip",
            size: 833_435_449,
            sha256: "597c8d343a3cf02ba6f6b2ae7cf6fe2fef125dde8feff62a144e8dd3da3d484e",
        }),
        Platform::MacosX86_64 | Platform::MacosAarch64 => Ok(ToolchainArtifact {
            name: "cmake-clang-v1-macos-universal.zip",
            size: 95_921_806,
            sha256: "9db2a9b6ede4162cb19850ee1a08d01147f3ea8bc9b2eefb3ffbdf8b20d389d7",
        }),
    }
}

fn validate_toolchain(
    root: &Path,
    platform: Platform,
    artifact: ToolchainArtifact,
) -> Result<bool> {
    let marker_path = root.join(".portcove-toolchain.json");
    if !marker_path.is_file() {
        return Ok(false);
    }
    let marker: ToolchainMarker = serde_json::from_slice(&fs::read(marker_path)?)?;
    if marker.schema_version != 2
        || marker.version != TOOLCHAIN_VERSION
        || marker.platform != platform
        || marker.asset_name != artifact.name
        || !marker.sha256.eq_ignore_ascii_case(artifact.sha256)
    {
        return Ok(false);
    }
    let Ok(expected) = toolchain_file_identities(root, platform) else {
        return Ok(false);
    };
    if marker.critical_files.len() != expected.len() {
        return Ok(false);
    }
    let recorded = marker
        .critical_files
        .into_iter()
        .map(|file| (file.path, file.size, file.sha256))
        .collect::<BTreeSet<_>>();
    let actual = expected
        .into_iter()
        .map(|file| (file.path, file.size, file.sha256))
        .collect::<BTreeSet<_>>();
    Ok(recorded == actual)
}

fn toolchain_file_identities(
    root: &Path,
    _platform: Platform,
) -> Result<Vec<ToolchainFileIdentity>> {
    let paths = [
        toolchain_python(root)?,
        platform_executable(&root.join("bin"), "cmake"),
        platform_executable(&root.join("bin"), "ninja"),
        root.join("retcomm-toolchain.json"),
    ];
    let mut identities = Vec::with_capacity(paths.len());
    for path in paths {
        if !path.is_file() {
            return Err(PortcoveError::verification(format!(
                "PS1 toolchain is missing a critical file: {}",
                path.display()
            )));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| PortcoveError::verification("toolchain file escaped its root"))?
            .to_str()
            .ok_or_else(|| PortcoveError::verification("toolchain path is not Unicode"))?
            .replace('\\', "/");
        let (sha256, size) = hash_file(&path)?;
        identities.push(ToolchainFileIdentity {
            path: relative,
            size,
            sha256,
        });
    }
    identities.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(identities)
}

fn toolchain_python(root: &Path) -> Result<PathBuf> {
    let candidates = if cfg!(windows) {
        vec![root.join("python").join("python.exe")]
    } else {
        vec![
            root.join("python").join("bin").join("python3"),
            root.join("python").join("bin").join("python"),
        ]
    };
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            PortcoveError::verification("PS1 toolchain is missing its bundled Python runtime")
        })
}

fn platform_executable(root: &Path, basename: &str) -> PathBuf {
    if cfg!(windows) {
        root.join(format!("{basename}.exe"))
    } else {
        root.join(basename)
    }
}

fn locate_pack_root(unpacked: &Path) -> Result<PathBuf> {
    if unpacked.join("retcomm-toolchain.json").is_file() {
        return Ok(unpacked.to_path_buf());
    }
    let mut directories = fs::read_dir(unpacked)?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.path());
    let candidate = directories.next().ok_or_else(|| {
        PortcoveError::verification("toolchain ZIP did not contain a package root")
    })?;
    if directories.next().is_some() || !candidate.join("retcomm-toolchain.json").is_file() {
        return Err(PortcoveError::verification(
            "toolchain ZIP has an unsupported package layout",
        ));
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        thread,
        time::{Duration, Instant},
    };

    const BUILDER_FIXTURE: &str = "psx::tests::managed_builder_fixture_child";

    fn preparation_input_fixture(root: &Path, multi_disc: bool) -> PsxManagedPreparation {
        let source_path = if multi_disc {
            let directory = root.join("owned-discs");
            fs::create_dir(&directory).unwrap();
            for name in ["disc-01.chd", "disc-02.chd"] {
                fs::write(directory.join(name), name.as_bytes()).unwrap();
            }
            directory
        } else {
            let file = root.join("owned-disc.chd");
            fs::write(&file, b"inert owned disc bytes").unwrap();
            file
        };
        let (storage_sha256, storage_size) =
            crate::adapter::source_storage_identity(&source_path).unwrap();
        let source_paths =
            crate::adapter::psx_source_paths(&source_path, if multi_disc { 2 } else { 1 }).unwrap();
        PsxManagedPreparation {
            source: SourceRecord {
                profile_id: "owned-ps1-disc".into(),
                path: source_path,
                sha256: storage_sha256.clone(),
                size: storage_size,
                storage_sha256,
                storage_size,
                updated_at: Library::now(),
                observed_identity: None,
            },
            bios: None,
            source_paths,
            runtime_source_directory: None,
            toolchain_root: root.join("absent-owned-toolchain"),
            executable_basename: "owned-game".into(),
        }
    }

    fn assert_invalid_preparation_input(
        root: &Path,
        preparation: &PsxManagedPreparation,
        field: &str,
    ) {
        let staging = root.join("owned-staging");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("preserve"), b"preserve private bytes").unwrap();
        let identity = crate::adapter::source_storage_identity(&preparation.source.path).unwrap();
        let (result, quiesced) = prepare_install(
            &staging,
            preparation,
            &OperationCoordinator::new("owned-input-validation", None),
        );
        let error = result.unwrap_err();
        assert_eq!(
            error.details.get("preparation_field").map(String::as_str),
            Some(field),
            "unexpected refusal: {error:?}"
        );
        assert!(quiesced);
        assert_eq!(
            fs::read(staging.join("preserve")).unwrap(),
            b"preserve private bytes"
        );
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 1);
        assert_eq!(
            crate::adapter::source_storage_identity(&preparation.source.path).unwrap(),
            identity
        );
    }

    #[test]
    fn managed_preparation_rejects_unbound_disc_paths_before_adapter_work() {
        let temporary = tempfile::tempdir().unwrap();
        let preparation = preparation_input_fixture(temporary.path(), true);
        let foreign = temporary.path().join("foreign-disc.chd");
        fs::write(&foreign, b"foreign inert bytes").unwrap();
        let mut reversed = preparation.source_paths.clone();
        reversed.reverse();
        for paths in [vec![foreign], Vec::new(), reversed] {
            let mut invalid = preparation.clone();
            invalid.source_paths = paths;
            assert_invalid_preparation_input(temporary.path(), &invalid, "source_paths");
        }
    }

    #[test]
    fn managed_preparation_rejects_unsafe_basename_before_adapter_work() {
        let temporary = tempfile::tempdir().unwrap();
        let preparation = preparation_input_fixture(temporary.path(), false);
        for basename in ["../outside", "nested/game", "nested\\game", "", "C:game"] {
            let mut invalid = preparation.clone();
            invalid.executable_basename = basename.into();
            assert_invalid_preparation_input(temporary.path(), &invalid, "executable_basename");
        }
    }

    #[test]
    fn managed_preparation_rejects_unsafe_runtime_path_before_adapter_work() {
        let temporary = tempfile::tempdir().unwrap();
        let preparation = preparation_input_fixture(temporary.path(), false);
        for path in [
            "../outside",
            "/outside",
            "C:/outside",
            "",
            "disc/../outside",
        ] {
            let mut invalid = preparation.clone();
            invalid.runtime_source_directory = Some(path.into());
            assert_invalid_preparation_input(
                temporary.path(),
                &invalid,
                "runtime_source_directory",
            );
        }
    }

    #[test]
    fn managed_preparation_valid_disc_inputs_reach_existing_package_check() {
        for multi_disc in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let mut preparation = preparation_input_fixture(temporary.path(), multi_disc);
            for runtime in [None, Some(PathBuf::from("owned/discs"))] {
                preparation.runtime_source_directory = runtime;
                let (result, quiesced) = prepare_install(
                    temporary.path(),
                    &preparation,
                    &OperationCoordinator::new("owned-valid-input", None),
                );
                let error = result.unwrap_err();
                assert_eq!(error.code, crate::ErrorCode::Install);
                assert!(error.message.contains("fixed psxrecomp CLI contract"));
                assert!(quiesced);
            }
        }
    }

    // Execute this repository's native test binary through the production
    // builder boundary. No upstream Python, compiler, game or source is run.
    fn run_builder_fixture(root: &Path, operation: &OperationCoordinator) -> Result<()> {
        run_cli(
            &std::env::current_exe().unwrap(),
            Path::new("--exact"),
            root,
            &root.join("owned-toolchain"),
            [BUILDER_FIXTURE.into(), "--nocapture".into()],
            operation,
            &mut true,
        )
    }

    #[test]
    fn managed_builder_fixture_child() {
        let Ok(mode) = fs::read_to_string("owned-builder-mode") else {
            return;
        };
        fs::write("owned-builder-ready", std::process::id().to_string()).unwrap();
        match mode.as_str() {
            "generation" | "rebuild" => {
                // This finite fallback bounds a failing-before run and ensures
                // an assertion cannot leave a permanent owned fixture process.
                thread::sleep(Duration::from_secs(3));
                fs::write("owned-builder-completed", b"unexpected completion").unwrap();
            }
            "success" => println!("owned builder success"),
            "failure" => {
                eprintln!("owned builder failure detail");
                std::process::exit(23);
            }
            "flood-failure" | "same-stream-flood" | "clip-failure" => {
                use std::io::Write;
                let block = [b'x'; 8192];
                let blocks = if mode == "clip-failure" { 10 } else { 320 };
                for _ in 0..blocks {
                    std::io::stdout().write_all(&block).unwrap();
                }
                if mode == "same-stream-flood" {
                    println!("owned late stdout failure omitted by bounded capture");
                } else {
                    eprintln!("owned stderr after verbose stdout");
                }
                std::process::exit(23);
            }
            _ => panic!("unknown owned builder mode"),
        }
    }

    fn assert_builder_cancellation(phase: &str) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("owned-build");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("owned-builder-mode"), phase).unwrap();
        let player_source = temporary.path().join("player-source");
        fs::write(&player_source, b"unchanged external source").unwrap();
        let service =
            crate::PortcoveService::new(Library::open(temporary.path().join("library")).unwrap())
                .unwrap();
        let (activity, operation) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Library,
                None,
            )
            .unwrap();
        let observer = crate::PortcoveService::new(service.library().clone()).unwrap();
        let id = activity.id.clone();
        let ready = root.join("owned-builder-ready");
        let request = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(6);
            while !ready.is_file() {
                assert!(Instant::now() < deadline, "owned builder did not start");
                thread::sleep(Duration::from_millis(5));
            }
            observer.request_cancellation(&id).unwrap();
        });
        let started = Instant::now();
        let result = run_builder_fixture(&root, &operation);
        let elapsed = started.elapsed();
        request.join().unwrap();
        assert_eq!(
            fs::read(&player_source).unwrap(),
            b"unchanged external source"
        );
        assert!(
            operation.checkpoint().is_err(),
            "real cancellation was accepted"
        );
        println!("phase={phase} elapsed={elapsed:?} result={result:?}");
        let result = service.finish_activity(activity, result);
        assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
        assert!(
            elapsed < Duration::from_secs(2),
            "builder ignored cancellation"
        );
        assert!(!root.join("owned-builder-completed").exists());
    }

    #[test]
    fn managed_builder_generation_observes_active_cancellation() {
        assert_builder_cancellation("generation");
    }

    #[test]
    fn managed_builder_rebuild_observes_active_cancellation() {
        assert_builder_cancellation("rebuild");
    }

    #[test]
    fn managed_builder_preserves_success_and_nonzero_failure() {
        let temporary = tempfile::tempdir().unwrap();
        let operation = OperationCoordinator::new("owned-builder", None);
        fs::write(temporary.path().join("owned-builder-mode"), "success").unwrap();
        run_builder_fixture(temporary.path(), &operation).unwrap();
        fs::write(temporary.path().join("owned-builder-mode"), "failure").unwrap();
        let error = run_builder_fixture(temporary.path(), &operation).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Install);
        assert!(error.message.contains("23"));
        assert!(error.details["output_tail"].contains("owned builder failure detail"));
        assert_eq!(error.details["output_truncated"], "false");
    }

    #[test]
    fn managed_builder_pre_spawn_cancellation_preserves_prior_uncertainty() {
        let temporary = tempfile::tempdir().unwrap();
        let service =
            crate::PortcoveService::new(Library::open(temporary.path().join("library")).unwrap())
                .unwrap();
        let (activity, operation) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Port,
                Some("sample"),
            )
            .unwrap();
        service.request_cancellation(&activity.id).unwrap();
        for previous in [true, false] {
            let mut quiesced = previous;
            let result = run_cli(
                &std::env::current_exe().unwrap(),
                Path::new("--exact"),
                temporary.path(),
                temporary.path(),
                [BUILDER_FIXTURE.into(), "--nocapture".into()],
                &operation,
                &mut quiesced,
            );
            assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
            assert_eq!(quiesced, previous);
            assert!(!temporary.path().join("owned-builder-ready").exists());
        }
    }

    #[test]
    fn managed_builder_bounded_output_keeps_both_streams_and_status() {
        let temporary = tempfile::tempdir().unwrap();
        fs::write(temporary.path().join("owned-builder-mode"), "flood-failure").unwrap();
        let error = run_builder_fixture(
            temporary.path(),
            &OperationCoordinator::new("owned-builder", None),
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Install);
        assert!(error.message.contains("23"));
        assert!(error.details["output_tail"].contains("owned stderr after verbose stdout"));
        assert!(error.details["output_tail"].len() <= 64 * 1024);
    }

    #[test]
    fn managed_builder_reports_capture_and_error_detail_truncation() {
        let temporary = tempfile::tempdir().unwrap();
        let operation = OperationCoordinator::new("owned-builder", None);
        for mode in ["same-stream-flood", "clip-failure"] {
            fs::write(temporary.path().join("owned-builder-mode"), mode).unwrap();
            let error = run_builder_fixture(temporary.path(), &operation).unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Install);
            assert!(error.message.contains("23"));
            assert!(error.details["output_tail"].len() <= 64 * 1024);
            if mode == "same-stream-flood" {
                assert!(!error.details["output_tail"].contains("owned late stdout failure"));
            }
            assert_eq!(
                error.details.get("output_truncated").map(String::as_str),
                Some("true"),
                "{mode}"
            );
        }
    }

    #[test]
    fn managed_builder_workspace_survives_worker_error_and_unwind() {
        let staging = tempfile::tempdir().unwrap();
        let root = staging.path().join("payload");
        fs::create_dir(&root).unwrap();
        let workspace = retained_source_workspace(&root).unwrap();
        fs::write(workspace.join("owned-input"), b"retain across error").unwrap();
        let result = run_cli(
            Path::new("missing-owned-builder"),
            Path::new("fixed-cli"),
            &root,
            &root,
            [],
            &OperationCoordinator::new("owned-builder", None),
            &mut true,
        );
        assert_eq!(result.unwrap_err().code, crate::ErrorCode::Install);
        assert_eq!(
            fs::read(workspace.join("owned-input")).unwrap(),
            b"retain across error"
        );
        let panic = std::panic::catch_unwind(|| {
            let owned = retained_source_workspace(&root).unwrap();
            fs::write(owned.join("owned-panic-input"), b"retain on unwind").unwrap();
            panic!("owned worker unwind");
        });
        assert!(panic.is_err());
        let retained = fs::read_dir(staging.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.path().join("owned-panic-input").is_file());
        assert!(retained);
    }

    #[test]
    fn managed_builder_stops_ordinary_native_descendants() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("owned-descendant-output");
        let mut quiesced = true;
        run_cli(
            &program,
            Path::new("--setup-tree"),
            root.path(),
            root.path(),
            [marker.display().to_string(), "exit".into()],
            &OperationCoordinator::new("owned-builder", None),
            &mut quiesced,
        )
        .unwrap();
        assert_eq!(quiesced, cfg!(windows));
        thread::sleep(Duration::from_millis(1200));
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[test]
    fn managed_builder_escaped_descendant_retains_workspace_without_proof() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let staging = tempfile::tempdir().unwrap();
        let workspace = retained_source_workspace(&staging.path().join("payload")).unwrap();
        let marker = workspace.join("owned-escaped-output");
        let ready = workspace.join("owned-escaped-ready");
        let mut quiesced = true;
        run_cli(
            &program,
            Path::new("--setup-tree-escape"),
            &workspace,
            &workspace,
            [marker.display().to_string(), ready.display().to_string()],
            &OperationCoordinator::new("owned-builder", None),
            &mut quiesced,
        )
        .unwrap();
        assert!(!quiesced);
        assert!(workspace.is_dir());
        thread::sleep(Duration::from_millis(1200));
        assert!(marker.is_file());
    }

    #[test]
    fn toolchain_marker_is_bound_to_current_critical_file_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let platform = Platform::current().unwrap();
        let artifact = toolchain_artifact(platform).unwrap();
        let python = if cfg!(windows) {
            root.join("python").join("python.exe")
        } else {
            root.join("python").join("bin").join("python3")
        };
        let cmake = platform_executable(&root.join("bin"), "cmake");
        let ninja = platform_executable(&root.join("bin"), "ninja");
        for (path, bytes) in [
            (&python, b"python".as_slice()),
            (&cmake, b"cmake".as_slice()),
            (&ninja, b"ninja".as_slice()),
            (&root.join("retcomm-toolchain.json"), b"metadata".as_slice()),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let marker = ToolchainMarker {
            schema_version: 2,
            version: TOOLCHAIN_VERSION.into(),
            platform,
            asset_name: artifact.name.into(),
            sha256: artifact.sha256.into(),
            critical_files: toolchain_file_identities(root, platform).unwrap(),
        };
        fs::write(
            root.join(".portcove-toolchain.json"),
            serde_json::to_vec_pretty(&marker).unwrap(),
        )
        .unwrap();
        assert!(validate_toolchain(root, platform, artifact).unwrap());

        fs::write(&cmake, b"tampered cmake").unwrap();

        assert!(!validate_toolchain(root, platform, artifact).unwrap());
    }

    #[test]
    fn pinned_toolchains_cover_every_platform() {
        for platform in [
            Platform::WindowsX86_64,
            Platform::LinuxX86_64,
            Platform::MacosX86_64,
            Platform::MacosAarch64,
        ] {
            let artifact = toolchain_artifact(platform).unwrap();
            assert_eq!(artifact.sha256.len(), 64);
            assert!(artifact.size > 1_000_000);
        }
    }

    #[test]
    fn runtime_config_replaces_upstream_disc_paths_with_verified_chds() {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("game.toml");
        fs::write(
            &config,
            "[game]\nname = \"Example\"\ndiscs = [\n  \"/maintainer/disc1.cue\",\n  \"/maintainer/disc2.cue\",\n]\ndisc_serials = [\"ONE\", \"TWO\"]\n\n[runtime]\nwindow_title = \"Example\"\n",
        )
        .unwrap();
        let sources = [
            PathBuf::from(r"D:\ROMs\Example (Disc 1).chd"),
            PathBuf::from(r"D:\ROMs\Example (Disc 2).chd"),
        ];

        rewrite_game_discs(&config, &sources).unwrap();

        let body = fs::read_to_string(config).unwrap();
        assert!(body.contains(r#"    "D:\\ROMs\\Example (Disc 1).chd","#));
        assert!(body.contains(r#"    "D:\\ROMs\\Example (Disc 2).chd","#));
        assert!(!body.contains("/maintainer"));
        assert!(body.contains("disc_serials"));
        assert!(body.contains("[runtime]"));
    }

    #[test]
    fn runtime_config_is_seeded_when_an_upstream_build_omits_it() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("game.toml");
        let runtime = temporary.path().join("build").join("game.toml");
        fs::write(&project, "[game]\ndisc = \"maintainer.cue\"\n").unwrap();
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        let sources = [PathBuf::from(r"D:\ROMs\Game.chd")];

        prepare_runtime_config(&project, &runtime, &sources).unwrap();

        let body = fs::read_to_string(runtime).unwrap();
        assert!(body.contains(r#"disc = "D:\\ROMs\\Game.chd""#));
        assert!(!body.contains("maintainer.cue"));
    }

    #[test]
    fn runtime_config_accepts_relative_immutable_cue_descriptors() {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("game.toml");
        fs::write(
            &config,
            "[game]\ndiscs = [\n  \"maintainer-1.cue\",\n  \"maintainer-2.cue\",\n]\n",
        )
        .unwrap();
        let sources = [
            PathBuf::from("runtime-discs/disc-01.cue"),
            PathBuf::from("runtime-discs/disc-02.cue"),
        ];

        rewrite_game_discs(&config, &sources).unwrap();

        let body = fs::read_to_string(config).unwrap();
        assert!(body.contains(r#"    "runtime-discs/disc-01.cue","#));
        assert!(body.contains(r#"    "runtime-discs/disc-02.cue","#));
        assert!(!body.contains("maintainer"));
    }

    fn rewrite_config_fixture(body: &str, sources: &[&str]) -> String {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("game.toml");
        fs::write(&config, body).unwrap();
        let sources = sources.iter().map(PathBuf::from).collect::<Vec<_>>();
        rewrite_game_discs(&config, &sources).unwrap();
        fs::read_to_string(config).unwrap()
    }

    #[test]
    fn runtime_config_rewrite_handles_brackets_inside_disc_strings() {
        let body = "[game]\ndiscs = [\n  'maintainer[Disc 1].cue',\n  \"maintainer[Disc 2].cue\",\n]\ndisc_serials = ['ONE', 'TWO']\n";
        let rewritten = rewrite_config_fixture(body, &["verified/one.cue", "verified/two.cue"]);
        assert_eq!(
            rewritten,
            "[game]\ndiscs = [\n    \"verified/one.cue\",\n    \"verified/two.cue\",\n]\ndisc_serials = ['ONE', 'TWO']\n"
        );
    }

    #[test]
    fn runtime_config_rewrite_preserves_array_comments_with_brackets() {
        let body = "[game]\ndiscs = [ # ordered discs ]\n  # first ]\n  'old-one.cue', # first disc\n  \"old#two].cue\", # second disc\n] # accepted list\nname = 'Example'\n";
        let rewritten = rewrite_config_fixture(body, &["verified/one.cue", "verified/two.cue"]);
        assert_eq!(
            rewritten,
            "[game]\ndiscs = [\n    \"verified/one.cue\",\n    \"verified/two.cue\",\n    # ordered discs ]\n    # first ]\n    # first disc\n    # second disc\n] # accepted list\nname = 'Example'\n"
        );
    }

    #[test]
    fn runtime_config_rewrite_accepts_compact_and_quoted_keys() {
        for assignment in [
            "discs=['old.cue']",
            "'discs' = ['old.cue']",
            "\"di\\u0073cs\"\t=\t['old.cue']",
        ] {
            let body = format!("[game]\n{assignment} # preserved\n[runtime]\ndisc='unrelated.cue'");
            let rewritten = rewrite_config_fixture(&body, &["verified/one.cue"]);
            assert!(!rewritten.contains("old.cue"));
            assert!(rewritten.contains("\"verified/one.cue\" # preserved\n"));
            assert!(rewritten.ends_with("[runtime]\ndisc='unrelated.cue'"));
            assert!(!rewritten.contains("discs"));
        }
    }

    #[test]
    fn runtime_config_rewrite_accepts_commented_game_header() {
        let body = "[game] # selected project\nname = 'Example'\ndisc='old.cue'\n";
        assert_eq!(
            rewrite_config_fixture(body, &["verified/one.cue"]),
            "[game] # selected project\nname = 'Example'\ndisc=\"verified/one.cue\"\n"
        );
    }

    #[test]
    fn runtime_config_rewrite_accepts_spaced_and_quoted_game_headers() {
        for header in [
            " [ game ]\t",
            "['game']",
            r#"["g\u0061me"]"#,
            r#"["g\U00000061me"]"#,
        ] {
            let body = format!("{header}\ndisc = 'old.cue'\n");
            assert_eq!(
                rewrite_config_fixture(&body, &["verified/one.cue"]),
                format!("{header}\ndisc = \"verified/one.cue\"\n")
            );
        }
    }

    #[test]
    fn runtime_config_rewrite_preserves_utf8_crlf_and_unrelated_multiline_values() {
        let prefix = "# 日本語\r\n[metadata]\r\nnotes = '''\r\n[game]\r\ndisc='text, not a field'\r\n'''\r\nquoted = \"\"\"escaped \\\" ] # text\r\n[game]\r\n\"\"\"\r\n[game.extra]\r\ndisc = 'unrelated.cue'\r\n[ game ] # retained header\r\n";
        let suffix =
            " # retained field comment\r\nname = '例'\r\n[runtime]\r\nwindow_title = '原文'";
        let body = format!("{prefix}disc='old.cue'{suffix}");
        assert_eq!(
            rewrite_config_fixture(&body, &["verified/日本語.cue"]),
            format!("{prefix}disc=\"verified/日本語.cue\"{suffix}")
        );
    }

    #[test]
    fn runtime_config_rewrite_preserves_comments_when_changing_disc_count() {
        let body =
            "[game]\ndiscs = [ # list comment\n 'old.cue', # member comment\n] # closing comment\n";
        assert_eq!(
            rewrite_config_fixture(body, &["verified/one.cue"]),
            "[game]\ndisc = \"verified/one.cue\"\n# list comment\n# member comment\n # closing comment\n"
        );
        assert_eq!(
            rewrite_config_fixture(
                "[game]\ndisc = 'old.cue' # single comment",
                &["one.cue", "two.cue"]
            ),
            "[game]\ndiscs = [\n    \"one.cue\",\n    \"two.cue\",\n] # single comment"
        );
    }

    #[test]
    fn runtime_config_rewrite_rejects_ambiguous_or_unbounded_fields_without_writing() {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("game.toml");
        for body in [
            "[runtime]\ndisc='old.cue'\n",
            "[game]\ndisc='one.cue'\ndiscs=['two.cue']\n",
            "[game]\ndisc='one.cue'\n[ 'game' ]\ndisc='two.cue'\n",
            "[game]\ndisc = 42\n",
            "[game]\ndiscs = ['one.cue' 'two.cue']\n",
            "[game]\ndiscs = [\n 'unterminated.cue\n]\n",
            "[game]\ndiscs = [\n 'one.cue'\n",
            "[game]\ndisc.extra = 'not a disc field'\n",
        ] {
            fs::write(&config, body).unwrap();
            assert!(
                rewrite_game_discs(&config, &[PathBuf::from("verified.cue")]).is_err(),
                "{body}"
            );
            assert_eq!(fs::read_to_string(&config).unwrap(), body);
        }
        let body = "[game]\ndisc='old.cue'\n";
        fs::write(&config, body).unwrap();
        assert!(rewrite_game_discs(&config, &[]).is_err());
        assert_eq!(fs::read_to_string(config).unwrap(), body);
    }

    #[test]
    fn runtime_config_rewrite_seeds_missing_fields_and_is_idempotent() {
        for body in [
            "[game]",
            "[game] # EOF",
            "[game]\r\nname='例'\r\n",
            "[game]\nname='Example'\n[runtime]\ndisc='unrelated'",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let config = temporary.path().join("game.toml");
            fs::write(&config, body).unwrap();
            let sources = [PathBuf::from("verified.cue")];
            rewrite_game_discs(&config, &sources).unwrap();
            let once = fs::read_to_string(&config).unwrap();
            assert!(once.contains("disc = \"verified.cue\""));
            assert_eq!(once.ends_with('\n'), body.ends_with('\n'));
            rewrite_game_discs(&config, &sources).unwrap();
            assert_eq!(fs::read_to_string(config).unwrap(), once);
        }
    }

    #[test]
    fn runtime_config_rewrite_handles_multiline_string_delimiters_and_line_folding() {
        let body = "[metadata]\nnotes = ''''quoted' [game] disc='not a field' ''''\nfolded = \"\"\"one\\\n  two \"\"\"\n[game]\ndiscs = [\n '''old[one].cue''',\n \"\"\"old\\\n two].cue\"\"\",\n]\n";
        let rewritten = rewrite_config_fixture(body, &["verified/one.cue", "verified/two.cue"]);
        assert_eq!(
            rewritten,
            "[metadata]\nnotes = ''''quoted' [game] disc='not a field' ''''\nfolded = \"\"\"one\\\n  two \"\"\"\n[game]\ndiscs = [\n    \"verified/one.cue\",\n    \"verified/two.cue\",\n]\n"
        );
    }

    #[test]
    fn runtime_config_rewrite_escapes_del_and_keeps_comment_eof() {
        assert_eq!(
            rewrite_config_fixture("[game]\ndisc='old.cue'", &["disc\u{7f}é.cue"]),
            "[game]\ndisc=\"disc\\u007Fé.cue\""
        );
        assert_eq!(
            rewrite_config_fixture("[game]\ndiscs=[ # retained\n 'old.cue'\n]", &["new.cue"]),
            "[game]\ndisc=\"new.cue\"\n# retained"
        );
    }
}
