import { errorMessage } from "./runtime-values.mts";
import type { Stats } from "node:fs";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import type { ValidationPlan } from "./validation-plan.mts";
import type {
  LocalChange,
  ValidationSelection,
  ValidationCommand,
} from "./ordinary-validation.mts";
import type {
  RepositoryInventory,
  ValidationRuntime,
  ValidationDomain,
} from "./validation-evidence.mts";
import type { PrerequisiteObservation } from "./dev-doctor.mts";
export type { PrerequisiteObservation } from "./dev-doctor.mts";
import { annotateNextest } from "./nextest-equivalence.mts";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveUiSelection } from "./ui-test-selection.mts";
import { fileURLToPath } from "node:url";
import { buildValidationPlan, validateValidationPlan } from "./validation-plan.mts";
import {
  validationRuntime,
  domainsForPath,
  fingerprintStage,
  receiptEnvelope,
  repositoryInventory,
  validateReceipt,
} from "./validation-evidence.mts";
import { prepareStorageScope, spawnCommand } from "./dev-storage.mts";
import { parseRawDiff } from "./select-ci-plan.mts";
import { collectSelectedPrerequisites, selectedPrerequisites } from "./dev-doctor.mts";
import { runCheckedGit } from "./checked-git.mts";
import { collectResourceStatus } from "./resource-status.mts";
import { nativeCompatibilitySourcePaths } from "./release-native-source-contract.mts";
import {
  hostedLocalCheckAuthorityPaths,
  isHostedLocalCheckScriptAuthority,
} from "./workflow-provenance.mts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const desktopRoot = path.join(projectRoot, "apps", "desktop");
import {
  classifyChanges,
  buildPlan,
  command,
  nodeTestCommand,
  uiRelatedCommand,
  formatCommand,
  selectedPlanInventory,
  executePlan,
} from "./ordinary-validation.mts";
export {
  isRepositoryLintInput,
  packagesWithDoctests,
  readDoctestPackages,
  deduplicateCommands,
  classifyChanges,
  buildPlan,
  formatCommand,
  selectedPlanInventory,
  executePlan,
} from "./ordinary-validation.mts";

interface DiscoveredLocalChange extends LocalChange {
  oldMode: string | null;
  newMode: string | null;
}
interface ComparisonIdentity {
  headSha: string;
  baseSha: string;
  mergeBase: string;
}
interface ChangeContext extends ComparisonIdentity {
  base: string;
  changes: LocalChange[];
}
interface PreflightAudit {
  stages?: readonly { id: string }[];
  local_stages?: readonly { id: string }[];
}
interface HostedRouteObservation {
  status: "eligible" | "blocked" | "unverified";
  reason?: string;
  command?: string;
  next_action?: string;
  changed?: string[];
  authority?: string;
  controller?: string;
  dispatch_ref?: string;
  dispatch_authority?: string;
}
interface PreflightOptions<A extends PreflightAudit> {
  context: ComparisonIdentity;
  plan: ValidationCommand[];
  validationPlan: ValidationPlan;
  prerequisites: PrerequisiteObservation[];
  hosted: HostedRouteObservation;
  audit?: A | null;
  platform?: string;
}
interface ReceiptExecutionOptions {
  spawn?: (
    executable: string,
    args: string[],
    options: SpawnSyncOptions,
  ) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;
  root?: string;
  inventory?: RepositoryInventory;
  runtime?: ValidationRuntime;
  receiptRoot?: string;
  fresh?: boolean;
  env?: NodeJS.ProcessEnv;
}
function git(args: string[], options: { encoding: "buffer" }): Buffer;
function git(args: string[], options?: { encoding?: "utf8" }): string;
function git(args: string[], options: { encoding?: "buffer" | "utf8" } = {}): string | Buffer {
  return options.encoding === "buffer"
    ? runCheckedGit(args, { cwd: projectRoot, encoding: "buffer" })
    : runCheckedGit(args, { cwd: projectRoot });
}

export function parseNameStatus(buffer: Buffer): LocalChange[] {
  const tokens = buffer.toString("utf8").split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    let status = tokens[index++];
    let embeddedPath = null;
    if (status?.includes("\t")) {
      [status, embeddedPath] = status.split("\t", 2);
    }
    if (!status) throw new Error("empty git name-status record");
    if (/^[RC]/.test(status)) {
      const previousPath = embeddedPath ?? tokens[index++];
      const currentPath = tokens[index++];
      if (!previousPath || !currentPath)
        throw new Error(`incomplete git rename/copy record: ${status}`);
      changes.push({ status, path: currentPath, previousPath });
    } else {
      const currentPath = embeddedPath ?? tokens[index++];
      if (!currentPath) throw new Error(`incomplete git change record: ${status}`);
      changes.push({ status, path: currentPath });
    }
  }
  return changes;
}

export function localChangesFromRaw(buffer: Buffer): DiscoveredLocalChange[] {
  return parseRawDiff(buffer).map((change) => ({
    status: change.status,
    path: change.newPath,
    previousPath: change.oldPath === change.newPath ? undefined : change.oldPath,
    oldMode: change.oldMode,
    newMode: change.newMode,
  }));
}

export function untrackedFileMode(
  stat: Pick<Stats, "isSymbolicLink" | "isFile" | "mode">,
  platform: string = process.platform,
) {
  if (stat.isSymbolicLink()) return "120000";
  if (!stat.isFile())
    throw new Error("untracked discovery contains an unsupported non-regular object");
  return platform !== "win32" && (stat.mode & 0o111) !== 0 ? "100755" : "100644";
}

export function readChangeContext(base = "origin/main") {
  const baseSha = git(["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const headSha = git(["rev-parse", "HEAD"]).trim();
  const mergeBase = git(["merge-base", "HEAD", baseSha]).trim();
  const tracked = localChangesFromRaw(
    git(["diff", "--raw", "-z", "--find-renames", mergeBase], {
      encoding: "buffer",
    }),
  );
  const untracked: DiscoveredLocalChange[] = git(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    {
      encoding: "buffer",
    },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((file: string) => ({
      status: "?",
      path: file,
      oldMode: "000000",
      newMode: untrackedFileMode(lstatSync(path.join(projectRoot, file))),
    }));
  return {
    base,
    baseSha,
    headSha,
    mergeBase,
    changes: annotateNextest(
      [...tracked, ...untracked].map((c) => ({
        ...c,
        oldPath: c.previousPath ?? c.path,
        newPath: c.path,
      })),
      (file) => git(["show", `${mergeBase}:${file}`]),
      (file: string) => readFileSync(path.join(projectRoot, file), "utf8"),
    ),
  };
}

const sorted = (values: ReadonlySet<string>) => [...values].sort();

function printPlan(
  context: ChangeContext,
  selection: ValidationSelection,
  plan: ValidationCommand[],
  validationPlan: ValidationPlan,
) {
  console.log("# Focused local validation");
  console.log(`Base: ${context.base} (${context.baseSha})`);
  console.log(`Merge base: ${context.mergeBase}`);
  console.log(`Head: ${context.headSha}`);
  console.log(`Changed paths: ${context.changes.length}`);
  console.log(`Scopes: ${sorted(selection.scopes).join(", ") || "none"}`);
  console.log(`Validation plan: ${validationPlan.mode} (${validationPlan.digest})`);
  console.log(`Validation groups: ${validationPlan.groups.join(", ") || "none"}`);
  console.log(`Qualification required: ${validationPlan.qualification_required}`);
  for (const change of context.changes) {
    const rename = change.previousPath ? ` <- ${change.previousPath}` : "";
    console.log(`- ${change.status} ${change.path}${rename}`);
  }
  console.log("Commands:");
  for (const entry of plan) {
    console.log(`- ${entry.id}: ${entry.reason}`);
    console.log(`  ${formatCommand(entry)}`);
  }
}

export function buildExecutionPreflight<A extends PreflightAudit = PreflightAudit>({
  context,
  plan,
  validationPlan,
  prerequisites,
  hosted,
  audit = null,
  platform = process.platform,
}: PreflightOptions<A>) {
  validateValidationPlan(validationPlan);
  if (
    validationPlan.discovery !== "complete" ||
    validationPlan.mode === "blocked" ||
    validationPlan.identities.head !== context.headSha ||
    validationPlan.identities.base !== context.baseSha ||
    validationPlan.identities.merge_base !== context.mergeBase ||
    validationPlan.identities.checkout !== context.headSha
  )
    throw new Error("execution preflight requires the current complete comparison");
  const observations = new Map(prerequisites.map((item) => [item.id, item]));
  const localAuditStages = audit?.local_stages ?? audit?.stages ?? [];
  const localAuditPrerequisites = audit
    ? selectedPrerequisites(
        { id: "conservative-audit", args: localAuditStages.map((stage) => stage.id) },
        platform,
      ).map((id) => observations.get(id) ?? { id, status: "unverified" })
    : [];
  const obligations = plan.map((entry) => {
    const required = selectedPrerequisites(entry, platform);
    const missing = required.filter((id) => observations.get(id)?.status !== "ok");
    return {
      id: entry.id,
      property: entry.reason,
      command: formatCommand(entry),
      cwd: entry.cwd,
      capabilities: required,
      missing,
      route:
        missing.length === 0
          ? "local"
          : hosted.status === "eligible" && !required.includes("windows-host")
            ? "hosted-local-check"
            : "blocked",
      next_action:
        missing.length === 0
          ? formatCommand(entry)
          : hosted.status === "eligible" && !required.includes("windows-host")
            ? hosted.command
            : missing
                .map((id) => observations.get(id)?.remediation ?? `establish ${id}`)
                .join("; "),
    };
  });
  return {
    format_version: 1,
    source: context.headSha,
    base: context.baseSha,
    merge_base: context.mergeBase,
    plan_digest: validationPlan.digest,
    selected_plan: selectedPlanInventory(plan),
    local_profile: "default full-debug; selected command arguments and features are authoritative",
    prerequisites,
    hosted,
    obligations,
    pre_change_audit: audit
      ? {
          ...audit,
          local_prerequisites: localAuditPrerequisites,
          missing_local_prerequisites: localAuditPrerequisites
            .filter((item) => item.status !== "ok")
            .map((item) => item.id),
        }
      : null,
    storage_scope: storageScopeForPlan(plan),
    hosted_ci: {
      groups: validationPlan.groups,
      platforms: validationPlan.platforms,
      qualification_required: validationPlan.qualification_required,
      role: "mandatory exact-head CI; not inferred from prerequisite observations or local receipts",
    },
    limits:
      "No dispatch or acceptance occurs. Fixture/build-script prerequisites, provisioning, dispatch permission and actual run readback remain execution obligations. Refresh against the complete frozen diff before qualification.",
  };
}

export function inspectHostedLocalRoute(
  context: ComparisonIdentity,
  authority?: string,
  controller?: string,
  invokeGit: (args: string[]) => string = git,
  dispatchRef?: string,
): HostedRouteObservation {
  if (!authority || !controller)
    return {
      status: "unverified",
      reason: "exact trusted authority and controller revisions not supplied",
      next_action:
        "supply --hosted-authority SHA --hosted-controller SHA from the already qualified main route",
    };
  if (![authority, controller].every((sha) => /^[a-f0-9]{40}$/u.test(sha)))
    throw new Error("hosted preflight requires exact authority and controller SHAs");
  if (invokeGit(["status", "--porcelain"]).trim())
    return { status: "blocked", reason: "hosted route requires a clean frozen source" };
  for (const revision of [authority, controller]) {
    if (invokeGit(["rev-parse", "--verify", `${revision}^{commit}`]).trim() !== revision)
      throw new Error("hosted authority revision differs from supplied identity");
    invokeGit(["merge-base", "--is-ancestor", revision, context.baseSha]);
  }
  const workflow = invokeGit(["show", `${controller}:.github/workflows/deep-quality.yml`]);
  if (
    !workflow.includes("hosted-local-check controller") ||
    !workflow.includes("hosted-local-check run")
  )
    return {
      status: "blocked",
      reason: "controller lacks the established fixed local-check route",
    };
  if (
    invokeGit(["rev-parse", `${controller}:scripts/workflow-provenance.mts`]).trim() !==
    invokeGit(["rev-parse", `${context.headSha}:scripts/workflow-provenance.mts`]).trim()
  )
    return {
      status: "blocked",
      reason:
        "candidate authority inventory differs from immutable controller; adopt the qualified controller before route diagnosis",
    };
  const changes = parseRawDiff(
    Buffer.from(
      invokeGit(["diff", "--raw", "-z", "--find-renames", authority, context.headSha]),
      "utf8",
    ),
  );
  const paths = [...new Set(changes.flatMap((change) => [change.oldPath, change.newPath]))];
  const changed = paths.filter(
    (name) =>
      hostedLocalCheckAuthorityPaths.includes(name) || isHostedLocalCheckScriptAuthority(name),
  );
  if (changed.length)
    return {
      status: "blocked",
      reason:
        "candidate changes trusted local-check authority; fixed transport cannot qualify itself",
      changed,
    };
  if (!dispatchRef)
    return {
      status: "unverified",
      reason: "GitHub dispatch requires an advertised branch or tag, not a controller SHA",
      next_action:
        "supply --hosted-ref NAME after fetching an existing branch or tag at the exact trusted controller",
    };
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(dispatchRef) || /^[a-f0-9]{40}$/iu.test(dispatchRef))
    throw new Error("--hosted-ref requires a safe branch or tag name, not a SHA");
  invokeGit(["check-ref-format", "--branch", dispatchRef]);
  const candidates = [`refs/remotes/origin/${dispatchRef}`, `refs/tags/${dispatchRef}`];
  const advertised = invokeGit(["for-each-ref", "--format=%(refname)%09%(symref)", ...candidates])
    .trim()
    .split("\n")
    .map((entry: string) => {
      const [name, symbolic = ""] = entry.split("\t");
      return { name, symbolic };
    })
    .filter((entry) => entry.name !== undefined && candidates.includes(entry.name));
  const advertisedRef = advertised[0];
  if (advertised.length !== 1 || !advertisedRef || advertisedRef.symbolic)
    return {
      status: "blocked",
      reason:
        "dispatch ref is missing, ambiguous or symbolic in the local origin branch/tag inventory",
      next_action: "fetch the existing approved named ref and resolve branch/tag ambiguity",
    };
  if (invokeGit(["rev-parse", "--verify", `${advertisedRef.name}^{commit}`]).trim() !== controller)
    return {
      status: "blocked",
      reason: "dispatch ref does not resolve to the exact trusted controller",
      next_action: "select an existing approved ref at the supplied controller SHA",
    };
  return {
    status: "eligible",
    authority,
    controller,
    dispatch_ref: dispatchRef,
    dispatch_authority:
      "not established by this local observation; dispatch and exact run readback must succeed",
    command: `gh workflow run deep-quality.yml --ref ${dispatchRef} -f operation=local-check -f source_sha=${context.headSha} -f base_sha=${context.baseSha} -f merge_base_sha=${context.mergeBase} -f controller_sha=${controller} -f authority_sha=${authority}`,
  };
}

function localStageDomains(entry: ValidationCommand): ValidationDomain[] {
  if (entry.id === "diff-check") return [];
  // These stages read live native exposure, frontend consumers, and the
  // validator/runner implementation in addition to Rust schema exports.
  if (["rust-workspace-tests", "ui-content"].includes(entry.id))
    return ["rust", "ui", "format", "development"];
  if (entry.id === "oxfmt") return ["format"];
  if (entry.id === "rustfmt" || entry.id === "dependency-policy" || entry.id.startsWith("rust-"))
    return ["rust"];
  if (entry.id.startsWith("ui-")) return ["ui"];
  if (
    [
      "actionlint",
      "lint-tool-fixtures",
      "oxlint",
      "repository-lint",
      "powershell-lint",
      "python-lint",
      "shell-lint",
    ].includes(entry.id)
  )
    return ["lint"];
  if (["transport-export", "transport-policy"].includes(entry.id))
    return ["repository", "rust", "ui"];
  if (entry.id === "playnite-contract") return ["repository"];
  if (entry.id === "node-tests") {
    const domains = new Set<ValidationDomain>();
    for (const file of entry.args.filter((argument) => /\.test\.[cm]?[jt]s$/u.test(argument))) {
      for (const domain of domainsForPath(file).domains) domains.add(domain);
      if (file === "scripts/release-native-source-contract.test.mts")
        for (const source of nativeCompatibilitySourcePaths)
          for (const domain of domainsForPath(source).domains) domains.add(domain);
    }
    return [...domains].sort();
  }
  if (entry.id.startsWith("node-syntax:")) {
    const file = entry.args.at(-1);
    return file ? [...domainsForPath(file).domains].sort() : [];
  }
  return [];
}

function localStageReusable(entry: ValidationCommand) {
  return (
    localStageDomains(entry).length > 0 &&
    !entry.id.startsWith("ui-") &&
    !["dependency-policy", "oxlint", "oxfmt", "repository-lint"].includes(entry.id)
  );
}

export function fingerprintLocalStage(
  entry: ValidationCommand,
  inventory: RepositoryInventory,
  runtime: ValidationRuntime,
) {
  if (
    entry.id === "rust-workspace-tests" &&
    (!Array.isArray(entry.rustCoverage) ||
      !entry.rustCoverage.length ||
      entry.rustCoverage.some((filter) => typeof filter !== "string" || !filter))
  )
    throw new Error("Rust receipt lacks its exact selected coverage");
  const recipe = JSON.stringify({
    rustCoverage: entry.rustCoverage,
    obligation: entry.obligation,
    executable: entry.executable === process.execPath ? "<active-node-runtime>" : entry.executable,
    args: entry.args,
    cwd: path.relative(projectRoot, entry.cwd).replaceAll("\\", "/") || ".",
  });
  const domainFingerprints = localStageDomains(entry).map((domain) =>
    fingerprintStage({ id: entry.id, recipe, domain }, inventory, runtime),
  );
  return createHash("sha256").update(JSON.stringify(domainFingerprints)).digest("hex");
}

function localReceiptPath(receiptRoot: string, entry: ValidationCommand, fingerprint: string) {
  const safeId = entry.id.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return path.join(receiptRoot, "local", safeId, `${fingerprint}.json`);
}

function readLocalReceipt(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeLocalReceipt(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  rmSync(file, { force: true });
  renameSync(temporary, file);
}

export function executePlanWithReceipts(
  plan: ValidationCommand[],
  options: ReceiptExecutionOptions = {},
) {
  const spawn = options.spawn ?? spawnCommand;
  const root = options.root ?? projectRoot;
  const reusableDomains = [...new Set(plan.filter(localStageReusable).flatMap(localStageDomains))];
  const reusableContext = reusableDomains.length
    ? {
        inventory: options.inventory ?? repositoryInventory(root),
        runtime: options.runtime ?? validationRuntime(root, { domains: reusableDomains }),
      }
    : null;
  const receiptRoot = options.receiptRoot ?? path.join(root, "work", "validation-receipts");
  const fresh = options.fresh ?? false;
  const started = Date.now();
  const timings = [];
  for (const entry of plan) {
    const reusable = localStageReusable(entry);
    const fingerprint =
      reusable && reusableContext
        ? fingerprintLocalStage(entry, reusableContext.inventory, reusableContext.runtime)
        : null;
    const receiptPath = fingerprint ? localReceiptPath(receiptRoot, entry, fingerprint) : null;
    const validation =
      receiptPath && fingerprint && !fresh
        ? validateReceipt(readLocalReceipt(receiptPath), {
            stageId: `local:${entry.id}`,
            fingerprint,
          })
        : {
            valid: false as const,
            reason: fresh ? "fresh execution required" : "stage is not reusable",
          };
    if (validation.valid) {
      console.log(
        `\n[local-check] ${entry.id}: reused matching successful receipt from ${validation.payload.originatingHead}`,
      );
      timings.push({ id: entry.id, elapsedMs: 0, status: "reused" });
      continue;
    }

    if (receiptPath) rmSync(receiptPath, { force: true });
    console.log(`\n[local-check] ${entry.id}: ${entry.reason}`);
    const stageStarted = Date.now();
    const result = spawn(entry.executable, entry.args, {
      cwd: entry.cwd,
      stdio: "inherit",
      windowsHide: true,
      env: options.env ?? process.env,
    });
    const elapsedMs = Date.now() - stageStarted;
    timings.push({ id: entry.id, elapsedMs, status: "executed" });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`${entry.id} failed with exit code ${result.status ?? "unknown"}`);
    if (
      receiptPath &&
      reusableContext &&
      fingerprintLocalStage(
        entry,
        options.inventory ?? repositoryInventory(root),
        reusableContext.runtime,
      ) !== fingerprint
    )
      throw new Error(`${entry.id} source changed during execution; successful receipt withheld`);
    if (receiptPath && reusableContext)
      writeLocalReceipt(
        receiptPath,
        receiptEnvelope({
          format: 1,
          kind: "successful-stage",
          success: true,
          stageId: `local:${entry.id}`,
          fingerprint,
          originatingHead: reusableContext.inventory.head,
          completedAt: new Date().toISOString(),
        }),
      );
    console.log(`[local-check] ${entry.id} passed in ${(elapsedMs / 1000).toFixed(1)}s`);
  }
  return { elapsedMs: Date.now() - started, timings };
}

export function requireFocusedArguments(kind: string, args: string[]) {
  const hasSelection =
    kind === "test-node"
      ? args.some((value) => /\.(?:test|integration\.test)\.(?:[cm]?[jt]s)$/.test(value))
      : kind === "test-ui-related" || kind === "test-ui"
        ? args.some((value) => /\.(?:[cm]?[jt]sx?|css)$/.test(value))
        : args.some((value: string) => !value.startsWith("-"));
  if (!args.length || !hasSelection)
    throw new Error(`${kind} requires an explicit package, filter, or test path`);
}

export function storageScopeForPlan(plan: readonly Pick<ValidationCommand, "id">[]) {
  let rust = false;
  let frontend = false;
  for (const { id } of plan) {
    if (["rustfmt", "dependency-policy", "test-rust"].includes(id) || id.startsWith("rust-"))
      rust = true;
    else if (id.startsWith("ui-") || ["oxfmt", "oxlint", "repository-lint"].includes(id))
      frontend = true;
    else if (
      !["diff-check", "node-tests", "actionlint", "shell-lint", "python-lint"].includes(id) &&
      !id.startsWith("node-syntax:")
    )
      return "all";
  }
  return rust && frontend ? "all" : rust ? "rust" : frontend ? "frontend" : "tooling";
}

function runFocusedCommand(kind: string, args: string[]) {
  requireFocusedArguments(kind, args);
  let plan;
  if (kind === "test-rust") {
    plan = [
      command(kind, "explicitly focused Rust test selection", process.execPath, [
        "scripts/run-rust-tests.mts",
        "--locked",
        ...args,
      ]),
    ];
  } else if (kind === "test-ui-related") {
    plan = [uiRelatedCommand(resolveUiSelection(args, desktopRoot, "related"))];
  } else if (kind === "test-ui") {
    const files = resolveUiSelection(args, desktopRoot);
    plan = [
      command(
        "ui-explicit-tests",
        "literal UI test files and execution reconciliation",
        process.execPath,
        ["scripts/run-ui-tests.mts", "exact", ...files],
        { cwd: projectRoot },
      ),
    ];
  } else if (kind === "test-node") {
    plan = [nodeTestCommand(args)];
  } else {
    throw new Error(`unknown focused command: ${kind}`);
  }
  executePlan(plan, { env: prepareStorageScope(storageScopeForPlan(plan)) });
}

function parseCheckArgs(args: string[]) {
  let base = "origin/main";
  let planOnly = false;
  let fresh = false;
  let preflightOnly = false;
  let asJson = false;
  let authority;
  let controller;
  let dispatchRef;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--plan") planOnly = true;
    else if (value === "--fresh") fresh = true;
    else if (value === "--preflight") preflightOnly = true;
    else if (value === "--json") asJson = true;
    else if (value === "--hosted-authority") authority = args[++index];
    else if (value === "--hosted-controller") controller = args[++index];
    else if (value === "--hosted-ref") {
      dispatchRef = args[++index];
      if (!dispatchRef || dispatchRef.startsWith("--"))
        throw new Error("--hosted-ref requires a branch or tag name");
    } else if (value === "--base") {
      const nextBase = args[++index];
      if (!nextBase) throw new Error("--base requires a Git revision");
      base = nextBase;
    } else throw new Error(`unknown local-check option: ${value}`);
  }
  if ((asJson || authority || controller || dispatchRef) && !preflightOnly)
    throw new Error("route/JSON options require --preflight");
  return { base, planOnly, fresh, preflightOnly, asJson, authority, controller, dispatchRef };
}

export async function main(
  argv = process.argv.slice(2),
  options: { readContext?: (base: string) => ChangeContext } = {},
) {
  if (argv.includes("--help")) {
    console.log(
      "usage: local-validation.mts [check [--base REV] [--plan|--preflight [--json] [--hosted-authority SHA --hosted-controller SHA --hosted-ref NAME]] [--fresh]|test-rust ARGS|test-ui FILES|test-ui-related FILES|test-node TESTS]",
    );
    return;
  }
  const [kind = "check", ...args] = argv;
  if (["test-rust", "test-ui", "test-ui-related", "test-node"].includes(kind)) {
    runFocusedCommand(kind, args);
    return;
  }
  if (kind !== "check") throw new Error(`unknown local validation command: ${kind}`);
  const { base, planOnly, fresh, preflightOnly, asJson, authority, controller, dispatchRef } =
    parseCheckArgs(args);
  const context = (options.readContext ?? readChangeContext)(base);
  const validationPlan = validateValidationPlan(
    buildValidationPlan({
      changes: context.changes.map((change) => ({
        status: change.status,
        ...(change.oldMode === undefined ? {} : { oldMode: change.oldMode }),
        ...(change.newMode === undefined ? {} : { newMode: change.newMode }),
        oldPath: change.previousPath ?? change.path,
        newPath: change.path,
        ...(change.nextest_equivalence ? { nextest_equivalence: change.nextest_equivalence } : {}),
      })),
      eventName: "pull_request",
      base: context.baseSha,
      mergeBase: context.mergeBase,
      head: context.headSha,
      checkout: context.headSha,
    }),
  );
  const selection = classifyChanges(context.changes);
  const planContext = { ...context, validationPlan };
  const plan = buildPlan(selection, planContext);
  if (preflightOnly) {
    const hosted = inspectHostedLocalRoute(context, authority, controller, undefined, dispatchRef);
    const report = {
      ...buildExecutionPreflight({
        context,
        plan,
        validationPlan,
        prerequisites: await collectSelectedPrerequisites(plan),
        hosted,
      }),
      resources: await collectResourceStatus(),
    };
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else {
      printPlan(context, selection, plan, validationPlan);
      console.log(
        `Hosted selected route: ${report.hosted.status} (${report.hosted.reason ?? "exact trusted revisions supplied; dispatch remains unproven"})`,
      );
      for (const entry of report.obligations)
        console.log(
          `${entry.id}: ${entry.route}; missing ${entry.missing.join(", ") || "none observed"}; next ${entry.next_action}`,
        );
      console.log(report.limits);
      for (const resource of report.resources.resources)
        console.log(
          `Resource ${resource.resource}: ${resource.observation}; ${resource.verification}; existing admission guard remains authoritative`,
        );
    }
    if (report.obligations.some((entry) => entry.route === "blocked")) process.exitCode = 1;
    return;
  }
  printPlan(context, selection, plan, validationPlan);
  if (planOnly) return;
  mkdirSync(path.join(projectRoot, "work"), { recursive: true });
  writeFileSync(
    path.join(projectRoot, "work/local-validation-plan.json"),
    JSON.stringify(validationPlan),
  );
  const env = prepareStorageScope(storageScopeForPlan(plan));
  const result = executePlanWithReceipts(plan, { fresh, env });
  console.log(`\nFocused local validation passed in ${(result.elapsedMs / 1000).toFixed(1)}s.`);
  if (result.elapsedMs > 120_000)
    console.warn(
      "Warm local validation exceeded the two-minute agility target; inspect the stage timings above without weakening checks.",
    );
  console.log(
    "The selected hosted validation plan remains mandatory in GitHub CI on the exact pull-request head.",
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? errorMessage(error) : error);
    process.exitCode = 1;
  }
}
