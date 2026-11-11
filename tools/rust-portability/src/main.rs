//! Repository-only portability policy for Rust source. This tool does not
//! execute, compile, expand macros, or resolve symbols in the files it checks.
mod policy;

use proc_macro2::Span;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use syn::visit::Visit;

fn main() -> ExitCode {
    match check(Path::new(".")) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(error) => {
            eprintln!("Rust portability check could not complete: {error}");
            ExitCode::from(2)
        }
    }
}

fn check(root: &Path) -> Result<bool, Box<dyn Error>> {
    let files = source_files(root)?;
    let mut denied = 0;
    for file in &files {
        let name = file
            .to_str()
            .ok_or_else(|| format!("Non-UTF-8 Rust source path: {file:?}"))?;
        let source = fs::read_to_string(root.join(file))
            .map_err(|error| format!("Cannot read {name}: {error}"))?;
        let syntax = syn::parse_file(&source).map_err(|error| {
            format!("Cannot parse {name}:{}: {error}", error.span().start().line)
        })?;
        let mut visitor = Paths {
            file: name,
            denied: 0,
        };
        visitor.visit_file(&syntax);
        denied += visitor.denied;
    }
    println!(
        "Rust portability checked {} files, {denied} blocking finding(s).",
        files.len()
    );
    Ok(denied == 0)
}

fn git(root: &Path, args: &[&str]) -> Result<String, Box<dyn Error>> {
    let output = Command::new("git").current_dir(root).args(args).output()?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args[0],
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn source_files(root: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    if !matches!(
        git(root, &["rev-parse", "--show-prefix"])?.as_str(),
        "\n" | "\r\n"
    ) {
        return Err("Rust portability must run from the Git repository root".into());
    }
    let output = git(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            "crates",
            "apps/desktop/src-tauri",
        ],
    )?;
    let Some(inventory) = output.strip_suffix('\0') else {
        return Err("Missing or malformed Git source inventory".into());
    };
    let mut files = Vec::new();
    for name in inventory.split('\0') {
        let file = Path::new(name);
        if file.extension().is_none_or(|extension| extension != "rs") {
            continue;
        }
        // A tracked path can be absent during a working-tree deletion or rename.
        match root.join(file).symlink_metadata() {
            Ok(metadata) if metadata.is_file() => files.push(file.to_owned()),
            Ok(_) => return Err(format!("Rust source must be a regular file: {name}").into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!("Cannot inspect {name}: {error}").into()),
        }
    }
    files.sort_unstable();
    files.dedup();
    if files.is_empty() {
        return Err("No Rust source files found in the Git source inventory".into());
    }
    Ok(files)
}

struct Paths<'a> {
    file: &'a str,
    denied: usize,
}

impl<'ast> Visit<'ast> for Paths<'_> {
    fn visit_lit_str(&mut self, literal: &'ast syn::LitStr) {
        let value = literal.value();
        if absolute_path(&value) && !policy::allows(self.file, &value) {
            self.denied += 1;
            let span: Span = literal.span();
            let loc = span.start();
            eprintln!(
                "{}:{}:{}: portability.absolute_literal_paths: {value:?}",
                self.file,
                loc.line,
                loc.column + 1
            );
        }
    }
}

// Evaluate spelling independent of the host so Windows paths are caught on Linux
// and Unix paths on Windows. Preserve rscheck's non-filesystem route and pattern
// exceptions; file-specific ambiguous strings go in policy.rs.
fn absolute_path(value: &str) -> bool {
    match value.as_bytes() {
        [letter, b':', b'\\' | b'/', ..] if letter.is_ascii_alphabetic() => true,
        [b'\\', b'\\', ..] => {
            value
                .split('\\')
                .filter(|segment| !segment.is_empty())
                .take(2)
                .count()
                == 2
        }
        [b'/', ..] => {
            !["//", "/*", "/api/", "/graphql", "/oauth/", "/v1/", "/v2/"]
                .iter()
                .any(|prefix| value.starts_with(prefix))
                && value != "/"
                && !["://", "/{", "/:", "?", "#"]
                    .iter()
                    .any(|marker| value.contains(marker))
                && !value.ends_with("/$")
        }
        _ => false,
    }
}
