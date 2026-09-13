import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { proseOnlyAllowlist } from "./select-ci-plan.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fullSha = /^[a-f0-9]{40}$/u;

function requiredSha(name) {
  const value = process.env[name];
  if (!fullSha.test(value ?? "")) throw new Error(`${name} must be a full Git SHA`);
  return value;
}

function requiredFiles() {
  let files;
  try {
    files = JSON.parse(process.env.PORTCOVE_PROSE_FILES ?? "");
  } catch {
    throw new Error("PORTCOVE_PROSE_FILES must be valid JSON");
  }
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string"))
    throw new Error("prose file plan must be a non-empty string array");
  const allowed = new Set(proseOnlyAllowlist);
  if (files.some((file) => !allowed.has(file)))
    throw new Error("prose file plan left the allowlist");
  return [...new Set(files)].sort();
}

const mergeBase = requiredSha("PORTCOVE_MERGE_BASE");
const head = requiredSha("PORTCOVE_HEAD_SHA");
const files = requiredFiles();
execFileSync("git", ["diff", "--check", mergeBase, head], { cwd: projectRoot, stdio: "inherit" });
const existing = files.filter((file) => {
  const target = path.join(projectRoot, file);
  return existsSync(target) && statSync(target).isFile();
});
if (existing.length > 0)
  execFileSync(process.execPath, ["scripts/run-oxfmt.mjs", "--check", ...existing], {
    cwd: projectRoot,
    stdio: "inherit",
  });
execFileSync(process.execPath, ["scripts/roadmap.mjs", "check"], {
  cwd: projectRoot,
  stdio: "inherit",
});
console.log(
  `Validated ${files.length} allowlisted prose path(s); ${existing.length} remain in the head tree.`,
);
