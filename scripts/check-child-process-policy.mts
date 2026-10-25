import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOTS = ["crates", "apps/desktop/src-tauri"];
const ALLOWED_DIRECT_COMMAND_FILES = new Set([
  "crates/portcove-core/src/process.rs",
  "crates/portcove-cli/tests/machine_contract.rs",
  // Extracted integration/namespace controls must launch independent children
  // to test the policy itself. These are exact test modules, not production adapters.
  "crates/portcove-cli/tests/machine_contract/source_discovery.rs",
  "crates/portcove-core/src/tool_process/linux_tests.rs",
  // The std-only writer test launches itself to verify the cross-process lease.
  "apps/desktop/src-tauri/src/diagnostics_writer_tests.rs",
  // Exact owned host/adapter subprocess and cross-process lease fixtures.
  "crates/portcove-cli/tests/desktop_host_diagnostics.rs",
  "crates/portcove-cli/tests/host_diagnostics.rs",
  "crates/portcove-cli/tests/machine_contract/human_presentation.rs",
  "crates/portcove-cli/tests/machine_contract/preparation.rs",
  "crates/portcove-core/src/definition_publication_connected_tests.rs",
  "crates/portcove-diagnostics/src/writer_tests.rs",
  // Temporary repository/compiled-client qualification, never production adapters.
  "crates/portcove-release-tools/tests/tuf_repository/isolated/renewal.rs",
  "crates/portcove-release-tools/tests/tuf_repository/isolated.rs",
  "crates/portcove-release-tools/tests/tuf_repository/offline.rs",
  "apps/desktop/src-tauri/src/application_update_process_environment_tests.rs",
]);

function rustFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return rustFiles(path);
    return entry.isFile() && extname(entry.name) === ".rs" ? [path] : [];
  });
}

export function findDirectChildProcessCalls(
  files: readonly (readonly [path: string, source: string])[],
) {
  const violations: { path: string; line: number }[] = [];
  for (const [path, source] of files) {
    if (ALLOWED_DIRECT_COMMAND_FILES.has(path.replaceAll("\\", "/"))) continue;
    // Supplemental spelling check, not Rust name resolution. Whitespace may
    // span lines; aliases are not resolved and comments/strings can match.
    for (const match of source.matchAll(/\bCommand\s*::\s*new\s*\(/gu)) {
      // This exact namespace constructs a CLI parser, not a child process.
      // Other namespaces (including other::clap) remain conservatively checked.
      if (/(?:^|[^A-Za-z0-9_:])clap\s*::\s*$/u.test(source.slice(0, match.index))) continue;
      violations.push({ path, line: source.slice(0, match.index).split(/\r?\n/u).length });
    }
  }
  return violations;
}

export function main() {
  const files = SOURCE_ROOTS.flatMap((root) => rustFiles(resolve(REPOSITORY_ROOT, root))).map(
    (path) => [relative(REPOSITORY_ROOT, path), readFileSync(path, "utf8")] as const,
  );
  const violations = findDirectChildProcessCalls(files);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `${violation.path}:${violation.line}: direct Command::new spelling outside reviewed policy/test files; inspect ChildProcessPolicy use`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    "Child-process spelling check passed: no process Command::new calls found outside reviewed policy/test files. Exact clap::Command constructors are parser builders; aliases are not resolved, and comments and strings can match.",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
