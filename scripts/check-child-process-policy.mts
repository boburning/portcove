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
    "Child-process spelling check passed: no Command::new calls found outside reviewed policy/test files. Aliases are not resolved; comments and strings can match.",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
