//! Finite dependency order from the sealed CMake/Ninja configuration.
//! This is planning evidence, never permission to execute a command or retry.
use crate::{OperationCoordinator, PortcoveError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

const MAX_GRAPH_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EDGES: usize = 10_000;
const MAX_LINE_BYTES: usize = 128 * 1024;
const MAX_DEPTH: usize = 128;
const MAX_GRAPH_TOKENS: usize = 100_000;
const BATCH_EDGES: usize = 16;

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CompilePlan {
    graph_sha256: String,
    rules_sha256: String,
    runtime: String,
    batches: Vec<Vec<String>>,
}

impl CompilePlan {
    pub(super) fn batch_count(&self) -> usize {
        self.batches.len()
    }
    pub(super) fn batch(&self, index: usize) -> Result<&[String]> {
        self.batches
            .get(index)
            .map(Vec::as_slice)
            .ok_or_else(|| refused("unknown compile batch"))
    }
}

struct Edge {
    outputs: Vec<String>,
    dependencies: Vec<String>,
    rule: String,
}

pub(super) fn derive(
    root: &Path,
    executable: &str,
    operation: &OperationCoordinator,
) -> Result<CompilePlan> {
    operation.checkpoint()?;
    let build = root.join("build-portcove");
    let graph =
        crate::external_runtime::read_stable_metadata(&build.join("build.ninja"), MAX_GRAPH_BYTES)?;
    let rules = crate::external_runtime::read_stable_metadata(
        &build.join("CMakeFiles/rules.ninja"),
        MAX_GRAPH_BYTES,
    )?;
    let text = std::str::from_utf8(&graph).map_err(|_| refused("non-UTF8 graph"))?;
    let rules_text = std::str::from_utf8(&rules).map_err(|_| refused("non-UTF8 rules"))?;
    // This bounded adapter consumes the single-file CMake graph. Never silently
    // omit another dependency file or dynamic dependency authority.
    for line in logical_lines(rules_text, &|| operation.checkpoint())? {
        if statement(line.trim_start(), "build").is_some()
            || statement(line.trim_start(), "include").is_some()
            || statement(line.trim_start(), "subninja").is_some()
            || binding(&line).is_some_and(|(name, _)| name == "dyndep")
        {
            return Err(refused("unsupported rules dependency graph"));
        }
    }
    let runtime = if cfg!(windows) {
        format!("{executable}.exe")
    } else {
        executable.to_owned()
    };
    crate::archive::validate_relative_path(&runtime, false)?;
    let batches = parse(text, root, &build, &runtime, &|| operation.checkpoint())?;
    operation.checkpoint()?;
    Ok(CompilePlan {
        graph_sha256: hex::encode(Sha256::digest(&graph)),
        rules_sha256: hex::encode(Sha256::digest(&rules)),
        runtime,
        batches,
    })
}

fn refused(reason: &str) -> PortcoveError {
    PortcoveError::verification(format!("PS1 bounded compile plan refused: {reason}"))
}

fn binding(line: &str) -> Option<(&str, &str)> {
    let (name, value) = line.trim().split_once('=')?;
    Some((name.trim(), value.trim()))
}

fn statement<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let suffix = line.strip_prefix(name)?;
    suffix
        .starts_with(' ')
        .then(|| suffix.trim_start_matches(' '))
}

fn logical_lines(text: &str, checkpoint: &dyn Fn() -> Result<()>) -> Result<Vec<String>> {
    let mut lines = Vec::new();
    let mut logical = String::new();
    for physical in text.lines() {
        checkpoint()?;
        if logical.len().saturating_add(physical.len()) > MAX_LINE_BYTES {
            return Err(refused("rules line limit"));
        }
        logical.push_str(if logical.is_empty() {
            physical
        } else {
            physical.trim_start()
        });
        if logical
            .bytes()
            .rev()
            .take_while(|byte| *byte == b'$')
            .count()
            % 2
            == 1
        {
            logical.pop();
        } else {
            lines.push(std::mem::take(&mut logical));
        }
    }
    if !logical.is_empty() {
        return Err(refused("unfinished rules line"));
    }
    Ok(lines)
}

fn parse(
    text: &str,
    root: &Path,
    build: &Path,
    runtime: &str,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Vec<Vec<String>>> {
    if text.len() as u64 > MAX_GRAPH_BYTES {
        return Err(refused("graph byte limit"));
    }
    let build_coordinate = PathBuf::from(ninja_coordinate(&crate::path::unicode(
        build,
        "Ninja build root",
    )?));
    let root_coordinate = PathBuf::from(ninja_coordinate(&crate::path::unicode(
        root,
        "Ninja payload root",
    )?));
    let workdir = format!(
        "{}/",
        crate::path::unicode(&build_coordinate, "Ninja build root")?.replace('\\', "/")
    );
    let mut edges = Vec::new();
    let mut owners = BTreeMap::new();
    let mut logical = String::new();
    let mut include_seen = false;
    let mut workdir_seen = false;
    let mut total_tokens = 0_usize;
    let mut expanded_bytes = 0_u64;
    for physical in text.lines() {
        checkpoint()?;
        if logical.len().saturating_add(physical.len()) > MAX_LINE_BYTES {
            return Err(refused("graph line limit"));
        }
        logical.push_str(if logical.is_empty() {
            physical
        } else {
            physical.trim_start()
        });
        let dollars = logical
            .bytes()
            .rev()
            .take_while(|byte| *byte == b'$')
            .count();
        if dollars % 2 == 1 {
            logical.pop();
            continue;
        }
        let line = std::mem::take(&mut logical);
        let trimmed = line.trim();
        if let Some(("cmake_ninja_workdir", value)) = binding(trimmed) {
            if workdir_seen || tokens(value, "")? != [workdir.clone()] {
                return Err(refused("build working coordinate changed"));
            }
            workdir_seen = true;
        }
        if statement(trimmed, "subninja").is_some()
            || binding(trimmed).is_some_and(|(name, _)| name == "dyndep")
        {
            return Err(refused("unsupported dependency source"));
        }
        if let Some(include) = statement(trimmed, "include") {
            if include_seen || include != "CMakeFiles/rules.ninja" {
                return Err(refused("unexpected include"));
            }
            include_seen = true;
        }
        let Some(body) = statement(&line, "build") else {
            continue;
        };
        if edges.len() >= MAX_EDGES {
            return Err(refused("edge limit"));
        }
        let tokens = tokens(body, if workdir_seen { &workdir } else { "" })?;
        total_tokens = total_tokens.saturating_add(tokens.len());
        expanded_bytes = expanded_bytes
            .saturating_add(tokens.iter().map(|token| token.len() as u64).sum::<u64>());
        if total_tokens > MAX_GRAPH_TOKENS || expanded_bytes > MAX_GRAPH_BYTES {
            return Err(refused("expanded graph budget"));
        }
        if tokens.iter().filter(|token| token.as_str() == ":").count() != 1 {
            return Err(refused("invalid build separators"));
        }
        let colon = tokens
            .iter()
            .position(|token| token == ":")
            .ok_or_else(|| refused("missing build rule"))?;
        let rule = tokens
            .get(colon + 1)
            .ok_or_else(|| refused("missing rule name"))?
            .clone();
        if rule.is_empty() || matches!(rule.as_str(), ":" | "|" | "||") {
            return Err(refused("invalid rule name"));
        }
        let outputs = tokens[..colon]
            .iter()
            .filter(|token| token.as_str() != "|")
            .map(|token| coordinate(token, &build_coordinate))
            .collect::<Result<Vec<_>>>()?;
        if outputs.is_empty() {
            return Err(refused("no edge output"));
        }
        let dependencies = tokens[colon + 2..]
            .iter()
            .filter(|token| !matches!(token.as_str(), "|" | "||"))
            // CMake uses the existing build directory as an order-only leaf.
            // It may be a dependency, never an executable/output coordinate.
            .map(|token| {
                if token == "." {
                    Ok(token.clone())
                } else {
                    coordinate(token, &build_coordinate)
                }
            })
            .collect::<Result<Vec<_>>>()?;
        for output in &outputs {
            // Real commands may produce files only inside this owned payload.
            if rule != "phony" {
                let path = build_coordinate.join(output);
                if !path.starts_with(&root_coordinate) {
                    return Err(refused("output outside payload"));
                }
            }
            if let Some(prior) = owners.insert(output.clone(), edges.len()) {
                if prior != edges.len() {
                    return Err(refused("duplicate output producer"));
                }
            }
        }
        edges.push(Edge {
            outputs,
            dependencies,
            rule,
        });
    }
    if !logical.is_empty() || !include_seen {
        return Err(refused("unfinished or incomplete graph"));
    }
    let selected = *owners
        .get("psx-runtime")
        .ok_or_else(|| refused("missing selected runtime"))?;
    if edges[selected].rule != "phony" || edges[selected].dependencies != [runtime] {
        return Err(refused("selected runtime alias changed"));
    }
    if !owners.contains_key(runtime) {
        return Err(refused("missing runtime producer"));
    }
    let mut states = vec![0_u8; edges.len()];
    let mut ordered = Vec::new();
    visit(
        selected,
        0,
        &edges,
        &owners,
        &mut states,
        &mut ordered,
        checkpoint,
    )?;
    if ordered.is_empty() {
        return Err(refused("empty compile closure"));
    }
    Ok(ordered
        .chunks(BATCH_EDGES)
        .map(<[String]>::to_vec)
        .collect())
}

fn coordinate(value: &str, build: &Path) -> Result<String> {
    if value.is_empty() || value.starts_with('-') || value.contains(['\0', '\n', '\r']) {
        return Err(refused("invalid target coordinate"));
    }
    let normalized = ninja_coordinate(value);
    let path = PathBuf::from(&normalized);
    if path.components().any(|part| {
        matches!(
            part,
            std::path::Component::ParentDir | std::path::Component::CurDir
        )
    }) {
        return Err(refused("non-normal target coordinate").detail("coordinate", value));
    }
    if path.is_absolute() {
        if let Ok(relative) = path.strip_prefix(build) {
            return crate::path::unicode(relative, "relative Ninja target")
                .map(|value| value.replace('\\', "/"));
        }
    }
    Ok(normalized)
}

fn ninja_coordinate(value: &str) -> String {
    #[cfg(windows)]
    {
        let value = value.replace('\\', "/");
        if let Some(tail) = value.strip_prefix("//?/UNC/") {
            return format!("//{tail}");
        }
        return value.strip_prefix("//?/").unwrap_or(&value).to_owned();
    }
    #[cfg(not(windows))]
    value.to_owned()
}

fn visit(
    index: usize,
    depth: usize,
    edges: &[Edge],
    owners: &BTreeMap<String, usize>,
    states: &mut [u8],
    ordered: &mut Vec<String>,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    if depth > MAX_DEPTH {
        return Err(refused("dependency depth limit"));
    }
    if states[index] == 2 {
        return Ok(());
    }
    if states[index] == 1 {
        return Err(refused("dependency cycle"));
    }
    states[index] = 1;
    let edge = &edges[index];
    for dependency in &edge.dependencies {
        if let Some(owner) = owners.get(dependency) {
            visit(
                *owner,
                depth + 1,
                edges,
                owners,
                states,
                ordered,
                checkpoint,
            )?;
        }
    }
    if edge.rule != "phony" {
        if matches!(
            edge.rule.as_str(),
            "CLEAN" | "HELP" | "RERUN_CMAKE" | "VERIFY_GLOBS"
        ) {
            return Err(refused("maintenance command in selected closure"));
        }
        ordered.push(edge.outputs[0].clone());
    }
    states[index] = 2;
    Ok(())
}

fn tokens(body: &str, workdir: &str) -> Result<Vec<String>> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut retained_bytes = 0_usize;
    let mut chars = body.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '$' => match chars.next().ok_or_else(|| refused("unfinished escape"))? {
                escaped @ ('$' | ':' | ' ') => word.push(escaped),
                first => {
                    let braced = first == '{';
                    let mut variable = if braced {
                        String::new()
                    } else {
                        first.to_string()
                    };
                    while chars
                        .peek()
                        .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
                    {
                        variable.push(chars.next().unwrap());
                    }
                    if (braced && chars.next() != Some('}'))
                        || variable != "cmake_ninja_workdir"
                        || workdir.is_empty()
                    {
                        return Err(refused("unsupported graph variable"));
                    }
                    if retained_bytes
                        .saturating_add(word.len())
                        .saturating_add(workdir.len())
                        > MAX_LINE_BYTES
                    {
                        return Err(refused("expanded line budget"));
                    }
                    word.push_str(workdir);
                }
            },
            ':' | '|' | ' ' | '\t' => {
                if !word.is_empty() {
                    retained_bytes = retained_bytes.saturating_add(word.len());
                    result.push(std::mem::take(&mut word));
                }
                if character == ':' {
                    result.push(":".into());
                }
                if character == '|' {
                    if chars.peek() == Some(&'@') {
                        return Err(refused("validation dependencies are not admitted"));
                    }
                    result.push(
                        if chars.peek() == Some(&'|') {
                            chars.next();
                            "||"
                        } else {
                            "|"
                        }
                        .into(),
                    );
                }
            }
            _ => word.push(character),
        }
        if retained_bytes.saturating_add(word.len()) > MAX_LINE_BYTES {
            return Err(refused("expanded line budget"));
        }
    }
    if !word.is_empty() {
        result.push(word);
    }
    if result.len() > 10_000 {
        return Err(refused("edge token limit"));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// Explicit read-only compatibility observation; never credits old outputs.
    #[test]
    #[ignore = "requires an explicitly selected retained CMake graph"]
    fn compile_plan_observes_explicit_retained_graph_without_execution() {
        let root = std::env::var_os("PORTCOVE_PSX_PLAN_READBACK_ROOT")
            .expect("explicit graph root required");
        let root = std::fs::canonicalize(root).unwrap();
        let executable = std::env::var("PORTCOVE_PSX_PLAN_READBACK_EXECUTABLE")
            .expect("explicit executable basename required");
        let operation = OperationCoordinator::new("read-only-retained-graph-format", None);
        let plan = derive(&root, &executable, &operation).unwrap();
        assert!(!plan.batches.is_empty());
        assert!(
            plan.batches
                .iter()
                .all(|batch| !batch.is_empty() && batch.len() <= BATCH_EDGES)
        );
        eprintln!(
            "Read-only graph format: batches={}, selected command edges={}; no commands executed",
            plan.batches.len(),
            plan.batches.iter().map(Vec::len).sum::<usize>()
        );
    }
    fn graph(body: &str) -> String {
        format!("include CMakeFiles/rules.ninja\n{body}\nbuild psx-runtime: phony game.exe\n")
    }
    #[test]
    fn compile_plan_orders_complete_selected_closure_and_bounds_batches() {
        let root = tempfile::tempdir().unwrap();
        let build = root.path().join("build");
        let mut body = "build directory_order: phony || .\nbuild setup | setup: CUSTOM_COMMAND || directory_order\n".to_owned();
        for index in 0..35 {
            body.push_str(&format!(
                "build object{index}.o: C_COMPILER source{index}.c || setup\n"
            ));
        }
        body.push_str(&format!(
            "build game.exe: LINK {}\nbuild unrelated: CUSTOM_COMMAND\n",
            (0..35)
                .map(|index| format!("object{index}.o"))
                .collect::<Vec<_>>()
                .join(" ")
        ));
        let batches = parse(&graph(&body), root.path(), &build, "game.exe", &|| Ok(())).unwrap();
        assert_eq!(
            batches.iter().map(Vec::len).collect::<Vec<_>>(),
            [16, 16, 5]
        );
        let ordered = batches.concat();
        assert_eq!(ordered.first().unwrap(), "setup");
        assert_eq!(ordered.last().unwrap(), "game.exe");
        assert_eq!(ordered.iter().collect::<BTreeSet<_>>().len(), 37);
        assert!(!ordered.iter().any(|target| target == "unrelated"));
    }
    #[test]
    fn compile_plan_refuses_incomplete_unsafe_and_cyclic_graphs() {
        let root = tempfile::tempdir().unwrap();
        let build = root.path().join("build");
        for body in [
            "build game.exe: LINK a\nbuild a: CUSTOM_COMMAND game.exe",
            "build game.exe: LINK\nbuild game.exe: LINK",
            "subninja extra.ninja\nbuild game.exe: LINK",
            "build ../foreign: LINK\nbuild game.exe: LINK",
            "build game.exe: LINK $unknown",
            "build game.exe: RERUN_CMAKE",
        ] {
            assert!(
                parse(&graph(body), root.path(), &build, "game.exe", &|| Ok(())).is_err(),
                "{body}"
            );
        }
        let text = graph("build game.exe: LINK");
        assert!(
            parse(&text, root.path(), &build, "game.exe", &|| Err(refused(
                "cancelled"
            )))
            .is_err()
        );
    }
    #[test]
    fn compile_plan_preserves_escaped_spaces_colons_and_dollars() {
        assert_eq!(
            tokens("object$ file: C source$:file dollar$$file", "").unwrap(),
            ["object file", ":", "C", "source:file", "dollar$file"]
        );
        assert!(tokens("${cmake_ninja_workdir}object", &"x".repeat(MAX_LINE_BYTES)).is_err());
    }

    #[test]
    fn compile_plan_refuses_validation_and_dynamic_dependency_authority() {
        let root = tempfile::tempdir().unwrap();
        let build = root.path().join("build");
        let validation = graph(
            "build validator: CUSTOM_COMMAND\nbuild object: C source |@ validator\nbuild game.exe: LINK object",
        );
        assert!(parse(&validation, root.path(), &build, "game.exe", &|| Ok(())).is_err());
        for binding in ["dyndep=dd", "dyndep  = dd", "dyndep = $\n  dd"] {
            let dynamic = graph(&format!(
                "build object: C source\n  {binding}\nbuild game.exe: LINK object"
            ));
            assert!(parse(&dynamic, root.path(), &build, "game.exe", &|| Ok(())).is_err());
            let payload = root.path().join("payload");
            std::fs::create_dir_all(payload.join("build-portcove/CMakeFiles")).unwrap();
            let runtime = if cfg!(windows) { "game.exe" } else { "game" };
            std::fs::write(payload.join("build-portcove/build.ninja"), format!("include CMakeFiles/rules.ninja\nbuild {runtime}: LINK\nbuild psx-runtime: phony {runtime}\n")).unwrap();
            std::fs::write(
                payload.join("build-portcove/CMakeFiles/rules.ninja"),
                format!("rule LINK\n  command = not-executed\n  {binding}\n"),
            )
            .unwrap();
            assert!(
                derive(
                    &std::fs::canonicalize(&payload).unwrap(),
                    "game",
                    &OperationCoordinator::new("inert-plan", None)
                )
                .is_err()
            );
        }
    }
}
