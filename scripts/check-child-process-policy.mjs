import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOTS = ["crates", "apps/desktop/src-tauri"];
const ALLOWED_DIRECT_COMMAND_FILES = new Set([
  "crates/portcove-core/src/process.rs",
  "crates/portcove-cli/tests/machine_contract.rs",
]);

function rustFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return rustFiles(path);
    return entry.isFile() && extname(entry.name) === ".rs" ? [path] : [];
  });
}

export function findDirectChildProcessCalls(files) {
  const violations = [];
  for (const [path, source] of files) {
    if (ALLOWED_DIRECT_COMMAND_FILES.has(path.replaceAll("\\", "/"))) continue;
    source.split(/\r?\n/u).forEach((line, index) => {
      if (/\bCommand::new\s*\(/u.test(line)) {
        violations.push({ path, line: index + 1 });
      }
    });
  }
  return violations;
}

export function main() {
  const files = SOURCE_ROOTS.flatMap((root) => rustFiles(resolve(REPOSITORY_ROOT, root))).map(
    (path) => [relative(REPOSITORY_ROOT, path), readFileSync(path, "utf8")],
  );
  const violations = findDirectChildProcessCalls(files);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `${violation.path}:${violation.line}: direct child process creation bypasses ChildProcessPolicy`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log("Child-process policy gate passed: every production child uses portcove-core policy.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
