import { checkDocumentLinks } from "./check-document-links.mts";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isInformationalPath } from "./validation-plan.mts";
import { vitePlusCommand } from "./viteplus-cli.mts";
import { spawnCommand } from "./dev-storage.mts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fullSha = /^[a-f0-9]{40}$/u;

function requiredSha(name: string) {
  const value = process.env[name];
  if (typeof value !== "string" || !fullSha.test(value))
    throw new Error(`${name} must be a full Git SHA`);
  return value;
}

function requiredFiles() {
  let files: unknown;
  try {
    files = JSON.parse(process.env.PORTCOVE_PROSE_FILES ?? "");
  } catch {
    throw new Error("PORTCOVE_PROSE_FILES must be valid JSON");
  }
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string"))
    throw new Error("prose file plan must be a non-empty string array");
  if (files.some((file) => !isInformationalPath(file)))
    throw new Error("prose file plan includes a machine-consumed or policy path");
  return [...new Set(files.filter((file): file is string => typeof file === "string"))].sort();
}

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--prerequisites"))
  throw new Error("Usage: check-ci-prose.mts [--prerequisites]");

const mergeBase = requiredSha("PORTCOVE_MERGE_BASE");
const head = requiredSha("PORTCOVE_HEAD_SHA");
const files = requiredFiles();
execFileSync("git", ["diff", "--check", mergeBase, head], { cwd: projectRoot, stdio: "inherit" });
const existing = files.filter((file: string) => {
  const target = path.join(projectRoot, file);
  return existsSync(target) && statSync(target).isFile();
});
const formatted = existing.filter((file: string) => file.endsWith(".md"));
if (process.argv[2] === "--prerequisites") {
  console.log(`frontend_dependencies=${formatted.length > 0}`);
} else {
  checkDocumentLinks(projectRoot, files);
  if (formatted.length > 0) {
    let cli;
    try {
      cli = vitePlusCommand(projectRoot);
    } catch (error) {
      throw new Error(
        "Prose formatting requires the pinned workspace dependencies; run pnpm install --frozen-lockfile.",
        { cause: error },
      );
    }
    const result = spawnCommand(cli.command, [...cli.args, "fmt", "--check", ...formatted], {
      cwd: projectRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  execFileSync(process.execPath, ["scripts/roadmap.mts", "check"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  console.log(
    `Validated ${files.length} informational path(s); ${existing.length} remain in the head tree.`,
  );
}
