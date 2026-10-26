import { validateChangedPath as normalizePath } from "./repository-path.mts";
import type { ExecFileSyncOptions } from "node:child_process";
import type {
  ValidationChange,
  ValidationChangeInput,
  ValidationPlan,
} from "./validation-plan.mts";
import { errorCode, errorMessage, isRecord } from "./runtime-values.mts";
import type { PostmergeReuseBinding } from "./postmerge-ci.mts";
import { discoverPostmergeReuse } from "./postmerge-ci.mts";
import { annotateNextest } from "./nextest-equivalence.mts";
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  windowsHelperChecksRequired,
  windowsNativeToolsRequired,
} from "./windows-helper-checks.mts";

import {
  buildValidationPlan,
  linuxRuntimeDiagnosticsRequired,
  encodeValidationPlanEnvironment,
  digestValidationPlan,
  fastGroups,
  isInformationalPath,
  qualificationPlatformsForProfile,
  validateValidationPlan,
} from "./validation-plan.mts";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const fullSha = /^[a-f0-9]{40}$/u;
export { isInformationalPath };
export { fastPlatformMatrix, qualificationMatrices } from "./validation-platforms.mts";
import { fastPlatformMatrix, qualificationMatrices } from "./validation-platforms.mts";

export function parseRawDiff(buffer: unknown): (ValidationChange & { score: string | null })[] {
  if (!Buffer.isBuffer(buffer)) throw new Error("raw diff must be a Buffer");
  const fields = buffer.toString("utf8").split("\0");
  if (fields.at(-1) !== "") throw new Error("raw diff is not NUL terminated");
  fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    if (header === undefined) throw new Error("raw diff ended before its header");
    const match = header.match(/^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])([0-9]*)$/u);
    if (!match) throw new Error(`malformed raw diff header: ${JSON.stringify(header)}`);
    const [, oldMode, newMode, , , status, score] = match;
    if (!oldMode || !newMode || !status)
      throw new Error("raw diff is missing mode or status fields");
    const oldPath = normalizePath(fields[index++]);
    const newPath = status === "R" || status === "C" ? normalizePath(fields[index++]) : oldPath;
    if (!oldPath || !newPath) throw new Error("raw diff ended before its paths");
    changes.push({ oldMode, newMode, status, score: score || null, oldPath, newPath });
  }
  return changes;
}

export function classifyChanges(changes: ValidationChangeInput[]) {
  const plan = buildValidationPlan({
    changes,
    eventName: "pull_request",
    checkout: "a".repeat(40),
  });
  return { mode: plan.mode, reason: plan.reason, files: plan.changed_files };
}

function checkedSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !fullSha.test(value))
    throw new Error(`${label} must be a full lowercase Git SHA`);
  return value;
}

interface CiDiscoveryOptions {
  eventName?: string | undefined;
  baseSha?: string | undefined;
  headSha?: string | undefined;
  checkoutSha?: string | undefined;
  proseOnlyEnabled?: boolean;
  fastValidationEnabled?: boolean;
  forceQualification?: boolean;
  releaseProfile?: string;
  qualificationCaller?: string;
  callerWorkflow?: string;
}
type CiGitRunner = (args: string[], options?: ExecFileSyncOptions) => string | Buffer;

export function discoverCiPlan(
  {
    eventName = "",
    baseSha,
    headSha,
    checkoutSha,
    proseOnlyEnabled = false,
    fastValidationEnabled = false,
    forceQualification = false,
    releaseProfile = "full",
    qualificationCaller = "",
    callerWorkflow = "",
  }: CiDiscoveryOptions,
  runGit: CiGitRunner = (args, options = {}) =>
    execFileSync("git", args, { cwd: projectRoot, ...options }),
): ValidationPlan {
  const checkout = checkedSha(checkoutSha, "checkout SHA");
  const releasePlatforms = qualificationPlatformsForProfile(releaseProfile);
  if (
    releaseProfile !== "full" &&
    (!forceQualification ||
      qualificationCaller !== "release" ||
      callerWorkflow !== "release.yml" ||
      !["workflow_call", "workflow_dispatch", "push"].includes(eventName))
  )
    throw new Error("reduced profile requires explicitly forced release reusable qualification");
  const qualify = (
    plan: ValidationPlan,
    reason = "explicit-reusable-qualification",
  ): ValidationPlan => {
    if (plan.mode === "blocked") return plan;
    const replacement: Omit<ValidationPlan, "digest"> & { digest?: string } = {
      ...plan,
      mode: "qualification",
      reason,
      groups: fastGroups,
      platforms: releasePlatforms,
      qualification_required: true,
      ...(releaseProfile === "initial-beta-win-linux" ? { release_profile: releaseProfile } : {}),
    };
    delete replacement.digest;
    return { ...replacement, digest: digestValidationPlan(replacement) };
  };
  if (forceQualification)
    return qualify(buildValidationPlan({ changes: [], eventName: "workflow_call", checkout }));
  if (!["pull_request", "push"].includes(eventName))
    return buildValidationPlan({ changes: [], eventName, checkout });
  try {
    if (eventName === "push" && (!baseSha || /^0{40}$/u.test(baseSha)))
      return buildValidationPlan({ changes: [], eventName, checkout });
    const base = checkedSha(baseSha, "base SHA");
    const head = checkedSha(headSha, "head SHA");
    if (eventName === "push") {
      // A missing historical base uses the whole baseline. A missing current
      // head, unavailable Git, or failed/truncated diff still blocks discovery.
      runGit(["cat-file", "-e", `${head}^{commit}`]);
      try {
        runGit(["cat-file", "-e", `${base}^{commit}`]);
      } catch (error) {
        if (
          !isRecord(error) ||
          typeof error.status !== "number" ||
          ![1, 128].includes(error.status)
        )
          throw error;
        return buildValidationPlan({ changes: [], eventName, checkout });
      }
    }
    const mergeBase = checkedSha(
      eventName === "push"
        ? base
        : String(runGit(["merge-base", base, head], { encoding: "utf8" })).trim(),
      "merge base",
    );
    const raw = runGit(["diff", "--raw", "-z", "--find-renames", mergeBase, head], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    const changes = annotateNextest(
      parseRawDiff(raw),
      (file) => String(runGit(["show", `${mergeBase}:${file}`], { encoding: "utf8" })),
      (file) => String(runGit(["show", `${head}:${file}`], { encoding: "utf8" })),
    );
    const plan = buildValidationPlan({ changes, eventName, base, mergeBase, head, checkout });
    if (plan.mode === "prose" && !proseOnlyEnabled) {
      return qualify(plan, "prose-policy-awaiting-independent-activation");
    }
    if (plan.mode === "fast" && !fastValidationEnabled) {
      return qualify(plan, "fast-validation-awaiting-independent-activation");
    }
    return plan;
  } catch (error) {
    return buildValidationPlan({
      changes: [],
      eventName,
      base: typeof baseSha === "string" && fullSha.test(baseSha) ? baseSha : null,
      head: typeof headSha === "string" && fullSha.test(headSha) ? headSha : null,
      checkout,
      discovery: "failed",
      blockedReason: `diff-discovery-failed:${errorCode(error) ?? (isRecord(error) && typeof error.name === "string" ? error.name : "error")}`,
    });
  }
}

export async function writeGithubOutputs(
  outputPath: string | undefined,
  plan: ValidationPlan,
  reuse: PostmergeReuseBinding | null = null,
) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  validateValidationPlan(plan);
  const { classifyChanges: classifyLocalChanges } = await import("./ordinary-validation.mts");
  const selection = classifyLocalChanges(
    plan.changes.flatMap((change) => [
      { ...change, path: change.newPath, status: change.status, previousPath: change.oldPath },
    ]),
  );
  const fields = {
    script_tools: String(selection.actionsLint || selection.shellLint || selection.pythonLint),
    reuse_json: JSON.stringify(reuse),
    reused_groups: JSON.stringify(reuse?.groups ?? []),
    contract_python: String((await import("./ci-baseline.mts")).baselineRequiresPython(plan)),
    contract_rust: String((await import("./ci-baseline.mts")).baselineRequiresRust(plan)),
    contract_desktop: String(
      (await import("./ci-baseline.mts")).baselineRequiresDesktopDependencies(plan),
    ),
    mode: plan.mode,
    frontend_workspace: String(
      plan.mode !== "prose" &&
        (selection.repositoryLint || Boolean(plan.fallback) || plan.changes.length === 0),
    ),
    windows_helpers: String(windowsHelperChecksRequired(plan)),
    native_tools: String(windowsNativeToolsRequired(plan)),
    linux_diagnostics: String(linuxRuntimeDiagnosticsRequired(plan)),
    frontend_tools: String(
      plan.mode !== "prose" &&
        (selection.repositoryLint ||
          selection.oxfmtFiles.size > 0 ||
          Boolean(plan.fallback) ||
          plan.changes.length === 0),
    ),
    reason: plan.reason,
    files_json: JSON.stringify(plan.changed_files),
    groups_json: JSON.stringify(plan.groups),
    platforms_json: JSON.stringify(plan.platforms),
    platform_matrix_json: JSON.stringify(fastPlatformMatrix(plan)),
    qualification_native_matrix_json: JSON.stringify(qualificationMatrices(plan).native),
    qualification_docs_matrix_json: JSON.stringify(qualificationMatrices(plan).docs),
    release_profile: plan.release_profile ?? "full",
    qualification_required: String(plan.qualification_required),
    plan_digest: plan.digest,
    plan_json: JSON.stringify(plan),
    plan_gzip_base64: encodeValidationPlanEnvironment(plan),
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
    releaseProfile: process.env.PORTCOVE_RELEASE_PROFILE ?? "full",
    qualificationCaller: process.env.PORTCOVE_QUALIFICATION_CALLER ?? "",
    callerWorkflow: process.env.PORTCOVE_CALLER_WORKFLOW ?? "",
  });
  validateValidationPlan(plan);
  const reuse = discoverPostmergeReuse(plan, {
    event: process.env.GITHUB_EVENT_NAME,
    discoverPlan: discoverCiPlan,
  });
  await writeGithubOutputs(process.env.GITHUB_OUTPUT, plan, reuse);
  console.log(
    reuse
      ? `Reusing tested composition from CI ${reuse.run}/a${reuse.attempt}, tree ${reuse.tree}`
      : "Executing selected ordinary obligations freshly.",
  );
  console.log(JSON.stringify(plan, null, 2));
  if (plan.mode === "blocked") throw new Error(`CI plan is blocked: ${plan.reason}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
