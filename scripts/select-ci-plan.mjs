import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildValidationPlan,
  digestValidationPlan,
  fastGroups,
  proseOnlyAllowlist,
  qualificationPlatforms,
  validateValidationPlan,
} from "./validation-plan.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const fullSha = /^[a-f0-9]{40}$/u;
const regularFileMode = "100644";
const platformRunners = Object.freeze({
  "linux-x86_64": "ubuntu-22.04",
  "macos-aarch64": "macos-15",
  "macos-x86_64": "macos-15-intel",
  "windows-x86_64": "windows-latest",
});

export { proseOnlyAllowlist };

export function fastPlatformMatrix(plan) {
  if (!plan || !Array.isArray(plan.platforms)) throw new Error("validation platforms are missing");
  return plan.platforms
    .filter((platform) => platform !== "primary-host")
    .map((platform) => {
      const runner = platformRunners[platform];
      if (!runner) throw new Error(`validation platform has no runner: ${platform}`);
      return { platform, runner };
    });
}

function normalizePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`unsafe changed path: ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseRawDiff(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error("raw diff must be a Buffer");
  const fields = buffer.toString("utf8").split("\0");
  if (fields.at(-1) !== "") throw new Error("raw diff is not NUL terminated");
  fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    const match = header.match(/^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])([0-9]*)$/u);
    if (!match) throw new Error(`malformed raw diff header: ${JSON.stringify(header)}`);
    const [, oldMode, newMode, , , status, score] = match;
    const oldPath = normalizePath(fields[index++]);
    const newPath = status === "R" || status === "C" ? normalizePath(fields[index++]) : oldPath;
    if (!oldPath || !newPath) throw new Error("raw diff ended before its paths");
    changes.push({ oldMode, newMode, status, score: score || null, oldPath, newPath });
  }
  return changes;
}

function isRegularChange(change) {
  if (change.status === "A")
    return change.oldMode === "000000" && change.newMode === regularFileMode;
  if (change.status === "D")
    return change.oldMode === regularFileMode && change.newMode === "000000";
  return change.oldMode === regularFileMode && change.newMode === regularFileMode;
}

export function classifyChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0)
    return { mode: "blocked", reason: "unexplained-empty-change-set", files: [] };
  const allowed = new Set(proseOnlyAllowlist);
  const files = [...new Set(changes.flatMap((change) => [change.oldPath, change.newPath]))].sort();
  for (const change of changes) {
    if (!["A", "D", "M", "R"].includes(change.status)) {
      return { mode: "qualification", reason: `unsupported-change-status:${change.status}`, files };
    }
    if (!isRegularChange(change)) {
      return { mode: "qualification", reason: "file-type-or-mode-change", files };
    }
    if (!allowed.has(change.oldPath) || !allowed.has(change.newPath)) {
      return { mode: "fast", reason: "path-not-in-prose-allowlist", files };
    }
  }
  return { mode: "prose", reason: "reviewed-informational-prose-only", files };
}

function checkedSha(value, label) {
  if (!fullSha.test(value ?? "")) throw new Error(`${label} must be a full lowercase Git SHA`);
  return value;
}

export function discoverCiPlan(
  {
    eventName,
    baseSha,
    headSha,
    checkoutSha,
    proseOnlyEnabled = false,
    fastValidationEnabled = false,
    forceQualification = false,
  },
  runGit = (args, options = {}) => execFileSync("git", args, { cwd: projectRoot, ...options }),
) {
  const checkout = checkedSha(checkoutSha, "checkout SHA");
  if (eventName !== "pull_request") {
    const plan = buildValidationPlan({ changes: [], eventName, checkout });
    if (!forceQualification) return plan;
    const qualification = {
      ...plan,
      mode: "qualification",
      reason: "explicit-reusable-qualification",
      groups: fastGroups,
      platforms: qualificationPlatforms,
      qualification_required: true,
    };
    delete qualification.digest;
    return { ...qualification, digest: digestValidationPlan(qualification) };
  }
  try {
    const base = checkedSha(baseSha, "base SHA");
    const head = checkedSha(headSha, "head SHA");
    const mergeBase = checkedSha(
      String(runGit(["merge-base", base, head], { encoding: "utf8" })).trim(),
      "merge base",
    );
    const raw = runGit(["diff", "--raw", "-z", "--find-renames", mergeBase, head], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    const changes = parseRawDiff(raw);
    const plan = buildValidationPlan({ changes, eventName, base, mergeBase, head, checkout });
    if (plan.mode === "prose" && !proseOnlyEnabled) {
      const replacement = {
        ...plan,
        mode: "qualification",
        reason: "prose-policy-awaiting-independent-activation",
        groups: fastGroups,
        platforms: qualificationPlatforms,
        qualification_required: true,
      };
      delete replacement.digest;
      return { ...replacement, digest: digestValidationPlan(replacement) };
    }
    if (plan.mode === "fast" && !fastValidationEnabled) {
      const replacement = {
        ...plan,
        mode: "qualification",
        reason: "fast-validation-awaiting-independent-activation",
        groups: fastGroups,
        platforms: qualificationPlatforms,
        qualification_required: true,
      };
      delete replacement.digest;
      return { ...replacement, digest: digestValidationPlan(replacement) };
    }
    return plan;
  } catch (error) {
    return buildValidationPlan({
      changes: [],
      eventName,
      base: fullSha.test(baseSha ?? "") ? baseSha : null,
      head: fullSha.test(headSha ?? "") ? headSha : null,
      checkout,
      discovery: "failed",
      blockedReason: `diff-discovery-failed:${error.code ?? error.name ?? "error"}`,
    });
  }
}

export async function writeGithubOutputs(outputPath, plan) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  const fields = {
    mode: plan.mode,
    reason: plan.reason,
    files_json: JSON.stringify(plan.changed_files),
    groups_json: JSON.stringify(plan.groups),
    platforms_json: JSON.stringify(plan.platforms),
    platform_matrix_json: JSON.stringify(fastPlatformMatrix(plan)),
    qualification_required: String(plan.qualification_required),
    plan_digest: plan.digest,
    plan_json: JSON.stringify(plan),
    base: plan.identities.base ?? "",
    merge_base: plan.identities.merge_base ?? "",
    head: plan.identities.head ?? "",
    checkout: plan.identities.checkout,
  };
  if (Object.values(fields).some((value) => String(value).includes("\n"))) {
    throw new Error("CI plan outputs must remain single-line values");
  }
  await appendFile(
    outputPath,
    `${Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8",
  );
}

async function main() {
  const plan = discoverCiPlan({
    eventName: process.env.GITHUB_EVENT_NAME,
    baseSha: process.env.PORTCOVE_BASE_SHA,
    headSha: process.env.PORTCOVE_HEAD_SHA,
    checkoutSha: process.env.GITHUB_SHA,
    proseOnlyEnabled: process.env.PORTCOVE_PROSE_POLICY_ACTIVATED === "true",
    fastValidationEnabled: process.env.PORTCOVE_FAST_VALIDATION_ACTIVATED === "true",
    forceQualification: process.env.PORTCOVE_FORCE_QUALIFICATION === "true",
  });
  validateValidationPlan(plan);
  await writeGithubOutputs(process.env.GITHUB_OUTPUT, plan);
  console.log(JSON.stringify(plan, null, 2));
  if (plan.mode === "blocked") throw new Error(`CI plan is blocked: ${plan.reason}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
