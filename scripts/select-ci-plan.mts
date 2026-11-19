import { catalogGuideCopyMaxBytes, decodeGuideCopyBlob } from "./catalog-guide-copy-impact.mts";
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
import { annotateChanges } from "./validation-change-proofs.mts";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectReleaseProfile } from "./release-package-policy.mts";
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

/**
 * True only for a fast pull-request run of a draft that would execute the Rust partitions itself.
 * Qualification, push, prose and reused plans never defer, and any value other than "true" for the
 * draft flag keeps the partitions.
 */
export function windowsTestsDeferred(
  plan: Pick<ValidationPlan, "mode" | "groups">,
  {
    eventName,
    draft,
    reused,
  }: { eventName: string | undefined; draft: string | undefined; reused: boolean },
) {
  return (
    eventName === "pull_request" &&
    draft === "true" &&
    plan.mode === "fast" &&
    plan.groups.includes("rust") &&
    !reused
  );
}

/**
 * The pull request's current draft state, read live so a re-run attempt started after the pull
 * request became ready sees "false" even though its event payload still says draft. Any failure
 * returns "false", which keeps the Windows partitions.
 */
export async function liveDraftState({
  eventName,
  eventPath,
  read,
}: {
  eventName: string | undefined;
  eventPath: string | undefined;
  read: (route: string) => Promise<unknown>;
}): Promise<"true" | "false"> {
  if (eventName !== "pull_request" || !eventPath) return "false";
  try {
    const { readFile } = await import("node:fs/promises");
    const event: unknown = JSON.parse(await readFile(eventPath, "utf8"));
    const number =
      isRecord(event) && isRecord(event.pull_request) ? event.pull_request.number : undefined;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return "false";
    const pull = await read(`pulls/${number}`);
    return isRecord(pull) && pull.number === number && pull.draft === true ? "true" : "false";
  } catch (error) {
    console.error(
      `Draft state unavailable; running the Windows partitions: ${errorMessage(error)}`,
    );
    return "false";
  }
}

export async function readRepositoryRoute(route: string): Promise<unknown> {
  const deadline = performance.now() + 20000;
  const { localDeveloperCredential } = await import("./github-cli.mts");
  const { createGitHubClient } = await import("./github-client.mts");
  const prefix = "repos/boburning/portcove";
  const client = await createGitHubClient({
    credential: localDeveloperCredential({ deadline }),
    deadline,
    maxBytes: 1024 * 1024,
    allowRequest: (method, url) => method === "GET" && url.pathname.startsWith(`/${prefix}/`),
  });
  return (
    await client.request({
      method: "GET",
      url: new URL(`${prefix}/${route}`, "https://api.github.com/").href,
      request: { portcove: { replay: "safe-read", attempts: 0 } },
    })
  ).data as unknown;
}

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

function testedPullRequestTarget(
  eventBase: string,
  head: string,
  checkout: string,
  runGit: CiGitRunner,
): string {
  const read = (args: string[]) => String(runGit(args, { encoding: "utf8" })).trim();
  const [commit, target, source, ...extra] = read([
    "rev-list",
    "--parents",
    "-n",
    "1",
    checkout,
  ]).split(/\s+/u);
  if (commit !== checkout || source !== head || extra.length !== 0)
    throw new Error("PR test merge does not bind the checkout and exact source parents");
  const testedTarget = checkedSha(target, "tested target SHA");
  if (testedTarget !== eventBase) {
    const sharedTarget = read(["merge-base", "--all", eventBase, testedTarget]);
    if (sharedTarget !== eventBase && sharedTarget !== testedTarget)
      throw new Error("PR test merge target is outside the event base ancestry");
  }
  return testedTarget;
}

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
  const selectedProfile = inspectReleaseProfile(releaseProfile);
  const releasePlatforms = qualificationPlatformsForProfile(selectedProfile);
  const legacyReleaseCaller =
    callerWorkflow === "release.yml" &&
    ["workflow_call", "workflow_dispatch", "push"].includes(eventName);
  const windowsApplicationCaller =
    callerWorkflow === "application-release.yml" &&
    selectedProfile === "initial-beta-windows-x86_64-v1" &&
    ["workflow_dispatch", "schedule"].includes(eventName);
  if (
    selectedProfile !== "full" &&
    (!forceQualification ||
      qualificationCaller !== "release" ||
      !(legacyReleaseCaller || windowsApplicationCaller))
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
      ...(selectedProfile !== "full" ? { release_profile: selectedProfile } : {}),
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
    const eventBase = checkedSha(baseSha, "base SHA");
    const head = checkedSha(headSha, "head SHA");
    const testMerge = eventName === "pull_request" && checkout !== head;
    const base = testMerge ? testedPullRequestTarget(eventBase, head, checkout, runGit) : eventBase;
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
        : String(runGit(["merge-base", "--all", base, head], { encoding: "utf8" })).trim(),
      "merge base",
    );
    const comparisonBase = testMerge ? base : mergeBase;
    const comparisonHead = testMerge ? checkout : head;
    const raw = runGit(["diff", "--raw", "-z", "--find-renames", comparisonBase, comparisonHead], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    const changes = annotateChanges(
      parseRawDiff(raw),
      (file) =>
        decodeGuideCopyBlob(
          runGit(["show", `${comparisonBase}:${file}`], {
            encoding: "buffer",
            maxBuffer: catalogGuideCopyMaxBytes,
          }),
        ),
      (file) =>
        decodeGuideCopyBlob(
          runGit(["show", `${comparisonHead}:${file}`], {
            encoding: "buffer",
            maxBuffer: catalogGuideCopyMaxBytes,
          }),
        ),
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
    // Only a complete frontend suite that CI will actually execute is split across browser shards.
    frontend_browser_shards: String(
      !reuse?.groups.includes("frontend") &&
        (await import("./ci-baseline.mts")).baselineBrowserShardsRequired(plan),
    ),
    // A draft pull request defers the Windows test partitions; the rust gate then fails until a
    // ready_for_review or later run executes them on the same contract.
    windows_tests_deferred: String(
      windowsTestsDeferred(plan, {
        eventName: process.env.GITHUB_EVENT_NAME,
        draft: await liveDraftState({
          eventName: process.env.GITHUB_EVENT_NAME,
          eventPath: process.env.GITHUB_EVENT_PATH,
          read: readRepositoryRoute,
        }),
        reused: Boolean(reuse?.groups.includes("rust")),
      }),
    ),
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
    plan_gzip_base64: encodeValidationPlanEnvironment(plan),
    base: plan.identities.base ?? "",
    merge_base: plan.identities.merge_base ?? "",
    head: plan.identities.head ?? "",
    checkout: plan.identities.checkout,
  };
  const outputBytes = Object.entries(fields).reduce(
    (total, [key, value]) => total + Buffer.byteLength(key + value, "utf16le"),
    0,
  );
  if (outputBytes > 1024 * 1024) throw new Error("CI plan outputs exceed GitHub UTF-16 byte limit");
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
  if (
    process.env.GITHUB_EVENT_NAME === "pull_request" &&
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim() !==
      process.env.GITHUB_SHA
  )
    throw new Error("Checked-out HEAD differs from the workflow checkout identity");
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
  const reuse = await discoverPostmergeReuse(plan, {
    event: process.env.GITHUB_EVENT_NAME,
    discoverPlan: discoverCiPlan,
  });
  const evidenceDirectory = path.join(projectRoot, "work/ci-plan");
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, "validation-plan.json"),
    JSON.stringify(plan) + "\n",
  );
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
