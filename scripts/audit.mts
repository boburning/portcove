import { errorCode } from "./runtime-values.mts";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateQualificationBinding, validateValidationPlan } from "./validation-plan.mts";
import { discoverCiPlan, parseRawDiff } from "./select-ci-plan.mts";
import { validateQualificationCoverage } from "./qualification-coverage.mts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const AUDIT_STAGES = Object.freeze([
  { id: "fallow", recipe: "fallow", domain: "ui", reusable: false },
  { id: "frontend-static", recipe: "ui-static", domain: "format", reusable: false },
  { id: "rust", recipe: "check-rust", domain: "rust", reusable: true },
  { id: "ui", recipe: "ui-runtime", domain: "ui", reusable: false },
  { id: "script-lint", recipe: "script-lint", domain: "lint", reusable: true },
  {
    id: "repository-tooling",
    recipe: "repository-tools",
    domain: "repository",
    reusable: true,
  },
  { id: "roadmap", recipe: "roadmap-check", domain: "roadmap", reusable: true },
  {
    id: "development-tools",
    recipe: "development-tools",
    domain: "development",
    reusable: true,
  },
  {
    id: "dependency-policy",
    recipe: "deny",
    domain: "rust",
    reusable: false,
    reason: "dependency and advisory state is externally mutable",
  },
  { id: "rscheck", recipe: "rscheck", domain: "rscheck", reusable: true },
  {
    id: "release-unit",
    recipe: "release-check",
    domain: "release",
    reusable: true,
  },
  {
    id: "windows-qualification",
    recipe: "windows-qualification-check",
    domain: "release",
    reusable: false,
    platforms: ["win32"],
    reason: "packaged Windows and machine-global state must be observed each audit",
  },
]);

export const RELEASE_AUDIT_STAGE_IDS = Object.freeze([
  "dependency-policy",
  "rscheck",
  "release-unit",
]);

// This selector, recipes and dependency inputs remain absent. Maintained hosted
// routing can delegate unchanged product suites only when the complete hosted
// plan still requires every qualification group/platform; it cannot omit them.
const transitionPaths = new Set([
  "scripts/local-validation.mts",
  "scripts/local-validation.test.mts",
  "scripts/rust-test-impact.mts",
  "scripts/rust-test-impact.test.mts",
  ".config/rust-test-impact.json",
  "scripts/dev-storage.mts",
  "scripts/dev-storage.test.mts",
  "scripts/validation-plan.mts",
  "scripts/validation-plan.test.mts",
  "scripts/select-ci-plan.mts",
  "scripts/select-ci-plan.test.mts",
  "scripts/ci-workflow.test.mts",
  ".github/workflows/ci.yml",
  "docs/QUALITY.md",
  "docs/DEVELOPMENT-TOOLS.md",
  "docs/DEVELOPMENT-STORAGE.md",
]);
export const TRANSITION_AUDIT_STAGE_IDS = Object.freeze([
  "frontend-static",
  "script-lint",
  "repository-tooling",
  "development-tools",
  "dependency-policy",
  "release-unit",
]);

export function selectTransitionAudit({ inventory, validationPlan, changes, workingTreeStatus }) {
  validateValidationPlan(validationPlan);
  if (
    validationPlan.discovery !== "complete" ||
    validationPlan.mode === "blocked" ||
    validationPlan.identities.checkout !== inventory?.head ||
    validationPlan.identities.head !== inventory?.head ||
    !Array.isArray(changes) ||
    changes.length === 0
  )
    throw new Error("transition audit lacks an exact complete source diff");
  if (validationPlan.qualification_required) {
    // The plan module is eligible to change, so its own constants/validators
    // cannot establish complete coverage. This preserved authority is excluded
    // from transition eligibility together with its validator and result gates.
    const coverage = JSON.parse(
      readFileSync(path.join(projectRoot, ".github/qualification-coverage.json"), "utf8"),
    );
    validateQualificationCoverage(
      coverage,
      readFileSync(path.join(projectRoot, coverage.workflow), "utf8"),
    );
    if (
      validationPlan.mode !== "qualification" ||
      JSON.stringify([...validationPlan.groups].sort()) !==
        JSON.stringify([...coverage.protected_contexts].sort()) ||
      JSON.stringify([...validationPlan.platforms].sort()) !==
        JSON.stringify([...coverage.platforms].sort())
    ) {
      throw new Error("transition plan omitted preserved qualification coverage");
    }
    validateQualificationBinding({
      plan: validationPlan,
      digest: validationPlan.digest,
      checkout: inventory.head,
    });
  }
  const paths = [...new Set(changes.flatMap((change) => [change.oldPath, change.newPath]))].sort();
  if (JSON.stringify(paths) !== JSON.stringify([...validationPlan.changed_files].sort()))
    throw new Error("transition audit diff inventory does not match the hosted plan");
  if (!Array.isArray(inventory.files)) throw new Error("transition audit lacks a file inventory");
  if (typeof workingTreeStatus !== "string")
    throw new Error("transition audit lacks Git worktree status");
  const clean =
    workingTreeStatus.trim() === "" &&
    inventory.files.length > 0 &&
    inventory.files.every(
      (file) =>
        !file.untracked &&
        file.kind === "file" &&
        file.headBlob === file.indexBlob &&
        (file.indexBlob === file.gitBlob || file.indexBlob === file.canonicalTextBlob) &&
        file.headMode === file.indexMode,
    );
  const eligible =
    validationPlan.qualification_required &&
    clean &&
    changes.length > 0 &&
    changes.every(
      (change) =>
        change.status === "M" &&
        change.oldPath === change.newPath &&
        change.oldMode === "100644" &&
        change.newMode === "100644" &&
        transitionPaths.has(change.newPath),
    );
  if (
    eligible &&
    changes.some((change) => !inventory.files.some((file) => file.path === change.newPath))
  )
    throw new Error("transition audit is missing a changed file from its inventory");
  return {
    profile: eligible ? "transition" : "complete",
    reason: eligible
      ? "clean local-policy diff; complete hosted qualification remains required"
      : "non-qualification, mixed, dirty, unknown or authority-changing inputs require the complete audit",
    stages: eligible
      ? AUDIT_STAGES.filter((stage) => TRANSITION_AUDIT_STAGE_IDS.includes(stage.id))
      : AUDIT_STAGES,
  };
}

export function auditStagesForProfile(profile = "complete") {
  if (profile === "complete") return AUDIT_STAGES;
  if (profile === "release")
    return AUDIT_STAGES.filter((stage) => RELEASE_AUDIT_STAGE_IDS.includes(stage.id));
  if (profile === "transition")
    throw new Error("transition profile requires complete diff discovery");
  throw new Error(`unknown audit profile: ${profile}`);
}

import {
  receiptFormat,
  repositoryInventory,
  auditRuntime,
  fingerprintStage,
  fingerprintInputs,
  receiptEnvelope,
  validateReceipt,
} from "./validation-evidence.mts";
export {
  domainsForPath,
  parseIndex,
  canonicalTextBlob,
  assertNoSplitIndex,
  repositoryInventory,
  auditRuntime,
  fingerprintInputs,
  fingerprintStage,
  receiptEnvelope,
  validateReceipt,
} from "./validation-evidence.mts";

function stageReceiptPath(receiptRoot: string, stage, fingerprint) {
  return path.join(receiptRoot, "stages", stage.id, `${fingerprint}.json`);
}

function readReceipt(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  rmSync(file, { force: true });
  renameSync(temporary, file);
}

export function planAudit(options = {}) {
  const root = options.root ?? projectRoot;
  const stages = options.stages ?? AUDIT_STAGES;
  const inventory = options.inventory ?? repositoryInventory(root);
  const runtime = options.runtime ?? auditRuntime(root);
  const receiptRoot = options.receiptRoot ?? path.join(root, "work", "validation-receipts");
  const fresh = options.fresh ?? false;
  return {
    head: inventory.head,
    profile: options.profile ?? "complete",
    receiptRoot,
    inventory,
    runtime,
    stages: stages
      .filter((stage) => !stage.platforms || stage.platforms.includes(runtime.platform))
      .map((stage) => {
        const fingerprint = fingerprintStage(stage, inventory, runtime);
        if (!stage.reusable)
          return {
            ...stage,
            fingerprint,
            action: "run",
            rationale: stage.reason,
          };
        if (fresh)
          return {
            ...stage,
            fingerprint,
            action: "run",
            rationale: "--fresh requires execution",
          };
        const receiptPath = stageReceiptPath(receiptRoot, stage, fingerprint);
        const validation = validateReceipt(readReceipt(receiptPath), {
          stageId: stage.id,
          fingerprint,
        });
        return validation.valid
          ? {
              ...stage,
              fingerprint,
              action: "reuse",
              rationale: `matching successful receipt from ${validation.payload.originatingHead}`,
              prior: validation.payload,
            }
          : {
              ...stage,
              fingerprint,
              action: "run",
              rationale:
                validation.reason === "missing receipt"
                  ? "no successful receipt matches the complete fingerprint"
                  : validation.reason,
            };
      }),
  };
}

function displayPlan(plan) {
  console.log(`# Portcove audit plan`);
  console.log(`Head: ${plan.head}`);
  console.log(`Profile: ${plan.profile ?? "complete"}`);
  for (const stage of plan.stages)
    console.log(
      `- ${stage.id}: ${stage.action} (${stage.rationale}); fingerprint ${stage.fingerprint}`,
    );
}

export function executeAudit(plan, options = {}) {
  let captureAvailable = false;
  if (options.captureHosted) {
    try {
      (options.captureInputs ?? captureHostedAuditInputs)(plan, options.root ?? projectRoot);
      captureAvailable = true;
    } catch (error) {
      console.warn(
        `[audit] Original input capture unavailable (${/^[A-Z0-9_]+$/.test(errorCode(error)) ? errorCode(error) : "capture-failed"}); audit stages still execute`,
      );
    }
  }
  const execute =
    options.execute ??
    ((stage) =>
      spawnSync("just", [stage.recipe], {
        cwd: options.root ?? projectRoot,
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          ...(stage.id === "dependency-policy" && options.scan706Path
            ? { PORTCOVE_706_SCAN_RECEIPT: options.scan706Path }
            : {}),
        },
      }));
  const clock = options.clock ?? (() => Date.now());
  const results = [];

  for (const stage of plan.stages) {
    if (stage.action === "reuse") {
      results.push({
        id: stage.id,
        recipe: stage.recipe,
        status: "reused",
        fingerprint: stage.fingerprint,
        originatingHead: stage.prior.originatingHead,
        durationMs: stage.prior.durationMs,
        rationale: stage.rationale,
      });
      console.log(`\n[audit] ${stage.id}: reused (${stage.rationale})`);
      continue;
    }

    const receiptPath = stageReceiptPath(plan.receiptRoot, stage, stage.fingerprint);
    if (stage.reusable) rmSync(receiptPath, { force: true });
    console.log(`\n[audit] ${stage.id}: running just ${stage.recipe} (${stage.rationale})`);
    const started = clock();
    let execution;
    try {
      execution = execute(stage);
    } catch (error) {
      execution = { status: null, error };
    }
    const durationMs = Math.max(0, clock() - started);
    const passed = !execution?.error && execution?.status === 0;
    const result = {
      id: stage.id,
      recipe: stage.recipe,
      status: passed ? "passed" : "failed",
      fingerprint: stage.fingerprint,
      originatingHead: plan.head,
      durationMs,
      rationale: stage.rationale,
      ...(passed ? {} : { exitCode: execution?.status ?? null }),
    };
    results.push(result);
    if (passed && stage.reusable) {
      const payload = {
        format: receiptFormat,
        kind: "successful-stage",
        success: true,
        stageId: stage.id,
        recipe: stage.recipe,
        fingerprint: stage.fingerprint,
        originatingHead: plan.head,
        durationMs,
        completedAt: new Date().toISOString(),
      };
      writeJsonAtomic(receiptPath, receiptEnvelope(payload));
    }
    console.log(
      `[audit] ${stage.id}: ${passed ? "passed" : "failed"} in ${(durationMs / 1000).toFixed(1)}s`,
    );
  }

  const success = results.every((result) => result.status !== "failed");
  const reportPayload = {
    format: receiptFormat,
    kind: "audit-run",
    profile: plan.profile ?? "complete",
    head: plan.head,
    success,
    originalExitCode: success ? 0 : 1,
    completedAt: new Date().toISOString(),
    stages: results,
  };
  writeJsonAtomic(
    path.join(
      plan.receiptRoot,
      "audits",
      `${plan.head}${plan.profile && plan.profile !== "complete" ? `.${plan.profile}` : ""}.json`,
    ),
    receiptEnvelope(reportPayload),
  );
  return { success, results, report: reportPayload, captureAvailable };
}

export function captureHostedAuditInputs(plan, root = projectRoot) {
  const identity = hostedAuditIdentity(root);
  if (identity.source !== plan.head) throw new Error("Audit input capture source mismatch");
  const captureFile = path.join(
    process.env.RUNNER_TEMP,
    `audit-inputs-${identity.run}-${identity.attempt}.json`,
  );
  rmSync(captureFile, { force: true });
  writeJsonAtomic(
    captureFile,
    receiptEnvelope({
      format: 1,
      kind: "audit-inputs",
      head: plan.head,
      profile: plan.profile,
      identity,
      capturedAt: new Date().toISOString(),
      stageInputs: Object.fromEntries(
        plan.stages.map((stage) => [
          stage.id,
          fingerprintInputs(stage, plan.inventory, plan.runtime),
        ]),
      ),
    }),
  );
}

export function hostedAuditIdentity(root = projectRoot) {
  const identity = {
    repository: process.env.GITHUB_REPOSITORY,
    source: process.env.GITHUB_SHA,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    workflowDigest: createHash("sha256")
      .update(readFileSync(path.join(root, ".github/workflows/deep-quality.yml")))
      .digest("hex"),
  };
  if (
    identity.repository !== "boburning/portcove" ||
    !/^[a-f0-9]{40}$/.test(identity.source) ||
    !/^[a-f0-9]{40}$/.test(identity.workflowSha) ||
    !/^[1-9][0-9]{0,12}$/.test(identity.run) ||
    !/^[1-9][0-9]{0,12}$/.test(identity.attempt)
  )
    throw new Error("Invalid hosted audit identity");
  return identity;
}

function parseArguments(argv) {
  let fresh = false;
  let planOnly = false;
  let profile = "complete";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--fresh") fresh = true;
    else if (argument === "--plan") planOnly = true;
    else if (argument === "--profile") {
      profile = argv[++index];
      if (!profile) throw new Error("--profile requires complete, release or transition");
    } else if (argument === "--help")
      return { help: true, fresh: false, planOnly: false, profile: "complete" };
    else throw new Error(`unknown audit option: ${argument}`);
  }
  if (fresh && planOnly) throw new Error("--fresh and --plan cannot be combined");
  if (profile !== "transition") auditStagesForProfile(profile);
  return { help: false, fresh, planOnly, profile };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log("usage: audit.mts [--plan|--fresh] [--profile complete|release|transition]");
    console.log("  --plan   report stage execution/reuse without running or writing receipts");
    console.log("  --fresh  ignore receipts and execute every applicable stage");
    console.log("  --profile release  delegate source/platform coverage to qualification");
    console.log(
      "  --profile transition  fresh local-policy checks with complete exact-head hosted coverage",
    );
    return;
  }
  let selection;
  let inventory;
  if (options.profile === "transition") {
    inventory = repositoryInventory(projectRoot);
    const base = String(
      execFileSync("git", ["rev-parse", "origin/main"], { cwd: projectRoot }),
    ).trim();
    const validationPlan = discoverCiPlan({
      eventName: "pull_request",
      baseSha: base,
      headSha: inventory.head,
      checkoutSha: inventory.head,
      fastValidationEnabled: true,
      proseOnlyEnabled: true,
    });
    validateValidationPlan(validationPlan);
    if (validationPlan.discovery !== "complete" || validationPlan.mode === "blocked")
      throw new Error("transition audit lacks complete hosted discovery");
    const changes = parseRawDiff(
      execFileSync(
        "git",
        [
          "diff",
          "--raw",
          "-z",
          "--find-renames",
          validationPlan.identities.merge_base,
          inventory.head,
        ],
        { cwd: projectRoot },
      ),
    );
    const workingTreeStatus = String(
      execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: projectRoot,
      }),
    );
    selection = selectTransitionAudit({ inventory, validationPlan, changes, workingTreeStatus });
    console.log(`Transition selection: ${selection.reason}`);
  } else selection = { profile: options.profile, stages: auditStagesForProfile(options.profile) };
  let plan = planAudit({
    fresh: options.profile === "transition" || options.fresh,
    stages: selection.stages,
    profile: selection.profile,
    ...(inventory ? { inventory } : {}),
  });
  if (options.planOnly) {
    displayPlan(plan);
    return;
  }
  if (!options.fresh && options.profile !== "transition") {
    const { discoverAuditReceipts, describeAuditReuse } = await import("./audit-reuse.mts");
    const reuse = discoverAuditReceipts(plan);
    console.log(describeAuditReuse(reuse));
    plan = planAudit({ stages: selection.stages, profile: selection.profile });
  }
  displayPlan(plan);
  const scan706Path = path.join(
    projectRoot,
    "work",
    "linux-beta-risk-706",
    `audit-${Date.now()}.json`,
  );
  const result = executeAudit(plan, {
    captureHosted: process.env.PORTCOVE_AUDIT_CAPTURE === "1",
    scan706Path,
  });
  const { developmentSecurity, describeDevelopmentSecurity } =
    await import("./dependency-security.mts");
  const scan = JSON.parse(readFileSync(scan706Path, "utf8"));
  const decision = developmentSecurity(
    scan,
    readFileSync(path.join(projectRoot, "deny.toml"), "utf8"),
  );
  if (scan.head !== plan.head) throw new Error("dependency scan source mismatch");
  console.log(describeDevelopmentSecurity(decision));
  if (options.profile === "release") {
    const { releaseSecurity } = await import("./linux-beta-risk-706.mts");
    const releaseDecision = releaseSecurity(projectRoot, scan);
    writeJsonAtomic(`${scan706Path}.release.json`, releaseDecision);
  }
  if (process.env.PORTCOVE_AUDIT_CAPTURE === "1" && process.env.GITHUB_OUTPUT) {
    try {
      appendFileSync(process.env.GITHUB_OUTPUT, `capture_available=${result.captureAvailable}\n`);
    } catch {
      console.warn(
        "[audit] Input capture step output unavailable; artifact export remains disabled",
      );
    }
  }
  if (!result.success) {
    const failed = result.results
      .filter((entry) => entry.status === "failed")
      .map((entry) => entry.id);
    if (failed.length === 1 && failed[0] === "dependency-policy" && decision.policyPassed) {
      writeJsonAtomic(`${scan706Path}.decision.json`, decision);
      writeJsonAtomic(
        path.join(
          plan.receiptRoot,
          "audits",
          `${plan.head}${plan.profile && plan.profile !== "complete" ? `.${plan.profile}` : ""}.json`,
        ),
        receiptEnvelope({ ...result.report, policyDecision: decision }),
      );
      console.log(
        `Audit raw result FAILED; ${describeDevelopmentSecurity(decision)} Original scan exit ${scan.exitCode}; ${scan706Path}`,
      );
      return;
    }
    throw new Error(`audit failed after all independent stages completed: ${failed.join(", ")}`);
  }
  console.log(
    selection.profile === "complete"
      ? "\nPortcove audit passed."
      : `\nPortcove ${selection.profile} audit passed; complete exact-head hosted qualification remains required.`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
