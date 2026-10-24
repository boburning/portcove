import { isRecord, errorMessage } from "./runtime-values.mts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { qualificationMatrices } from "./validation-platforms.mts";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedPlatforms = [
  "linux-x86_64",
  "macos-aarch64",
  "macos-x86_64",
  "windows-x86_64",
] as const;
const expectedProtectedContexts = [
  "catalog",
  "dependency-review",
  "frontend",
  "rust",
  "rust-quality",
];

export function workflowDefinition(workflow: string): Record<string, unknown> {
  const document = parseDocument(workflow, { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(`Invalid workflow YAML: ${document.errors[0]?.message}`);
  const value: unknown = document.toJS();
  if (!isRecord(value) || !isRecord(value.jobs)) throw new Error("Workflow jobs must be a mapping");
  return value;
}
export function workflowJobs(workflow: string): Record<string, Record<string, unknown>> {
  const value = workflowDefinition(workflow);
  if (!isRecord(value.jobs)) throw new Error("Workflow jobs must be a mapping");
  const jobs: Record<string, Record<string, unknown>> = {};
  for (const [id, job] of Object.entries(value.jobs)) {
    if (!isRecord(job)) throw new Error(`Invalid workflow job: ${id}`);
    jobs[id] = job;
  }
  return jobs;
}

export function qualificationJobInventory(workflow: string) {
  const jobs: string[] = [];
  const pullRequestJobs: string[] = [];
  for (const [current, job] of Object.entries(workflowJobs(workflow))) {
    const condition = qualificationCondition(job.if);
    if (!condition) continue;
    if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false)
      throw new Error(`Qualification job may not ignore failure: ${current}`);
    (condition === "pull-request" ? pullRequestJobs : jobs).push(current);
  }
  return { jobs: jobs.sort(), pullRequestJobs: pullRequestJobs.sort() };
}

function expression(value: unknown) {
  if (typeof value !== "string") return "";
  let quoted = false;
  let result = "";
  for (const character of value.trim().replace(/^\$\{\{|\}\}$/gu, "")) {
    if (character === "'") quoted = !quoted;
    if (quoted || !/\s/u.test(character)) result += character;
  }
  return result;
}
function binding(value: unknown) {
  return typeof value === "string" && /^\s*\$\{\{[\s\S]*\}\}\s*$/u.test(value)
    ? expression(value)
    : "";
}
const qualificationMode = "needs.classify.outputs.mode=='qualification'";
export function isQualificationOnlyCondition(value: unknown) {
  return expression(value) === qualificationMode;
}
const intelCondition = `${qualificationMode}&&contains(fromJSON(needs.classify.outputs.platforms_json),'macos-x86_64')`;
const portabilityCondition =
  "(needs.classify.outputs.mode=='qualification'&&contains(fromJSON(needs.classify.outputs.platforms_json),'macos-aarch64'))||(needs.classify.outputs.mode!='qualification'&&(contains(needs.classify.outputs.files_json,'apps/desktop/scripts/browser-runtime.mts')||contains(needs.classify.outputs.files_json,'pnpm-workspace.yaml')||contains(needs.classify.outputs.files_json,'apps/desktop/src/browser/display-recovery.browser.test.tsx')||contains(needs.classify.outputs.files_json,'apps/desktop/src/browser/compact-navigation.browser.test.tsx')||contains(needs.classify.outputs.files_json,'apps/desktop/src/components/AdoptionModal.browser.test.tsx')||contains(needs.classify.outputs.files_json,'apps/desktop/src/components/Artwork.browser.test.tsx')||contains(needs.classify.outputs.files_json,'apps/desktop/src/browser/workspace-feedback-user-intent.browser.test.tsx')))";
function qualificationCondition(value: unknown) {
  const condition = expression(value);
  if (
    condition === qualificationMode ||
    condition === intelCondition ||
    condition === portabilityCondition
  )
    return "reusable";
  if (condition === `github.event_name=='pull_request'&&${qualificationMode}`)
    return "pull-request";
  if (condition.includes("qualification")) throw new Error("Unsupported qualification condition");
  return null;
}

function qualificationAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Qualification ${message}`);
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const values: unknown[] = value;
  return values.filter((entry): entry is string => typeof entry === "string");
}
function activeSteps(job: Record<string, unknown>) {
  const steps: unknown[] = Array.isArray(job.steps) ? job.steps : [];
  return steps.filter(
    (step): step is Record<string, unknown> =>
      isRecord(step) &&
      (step.if === undefined || step.if === true || expression(step.if) === "!cancelled()") &&
      (step["continue-on-error"] === undefined || step["continue-on-error"] === false),
  );
}
function rootRun(job: Record<string, unknown>, step: Record<string, unknown>) {
  const defaults = isRecord(job.defaults) && isRecord(job.defaults.run) ? job.defaults.run : {};
  const directory = step["working-directory"] ?? defaults["working-directory"];
  const shell = step.shell ?? defaults.shell;
  return (
    (directory === undefined || directory === "." || directory === "./") &&
    (shell === undefined || shell === "bash" || shell === "pwsh" || shell === "sh")
  );
}
function requireConsumer(job: Record<string, unknown>, command: string) {
  qualificationAssert(
    activeSteps(job).some(
      (step) => rootRun(job, step) && typeof step.run === "string" && step.run.trim() === command,
    ),
    `consumer missing or disabled: ${command}`,
  );
}
function matrix(job: Record<string, unknown>) {
  return isRecord(job.strategy) && isRecord(job.strategy.matrix) ? job.strategy.matrix : {};
}
function validateMatrices(
  jobs: Record<string, Record<string, unknown>>,
  matrices: ReturnType<typeof qualificationMatrices>,
) {
  for (const [job, key] of [
    ["native_rust", "include"],
    ["rust_docs", "include"],
    ["intel_tests", "partition"],
    ["rust_tests", "shard"],
  ] as const)
    qualificationAssert(
      isDeepStrictEqual(Object.keys(matrix(jobs[job] ?? {})), [key]),
      `unsupported matrix axes/include/exclude: ${job}`,
    );
  // These tuples are independent coverage expectations, not copied from the producer at run time.
  const expectedDocs = [
    { platform: "linux-x86_64", runner: "ubuntu-22.04" },
    { platform: "macos-aarch64", runner: "macos-15" },
    { platform: "macos-x86_64", runner: "macos-15-intel" },
    { platform: "windows-x86_64", runner: "windows-latest" },
  ];
  qualificationAssert(
    isDeepStrictEqual(matrices.docs, expectedDocs) &&
      isDeepStrictEqual(matrices.native, [
        { platform: "linux-x86_64", runner: "ubuntu-22.04", partition: "hash:1/1" },
        { platform: "macos-aarch64", runner: "macos-15", partition: "hash:1/1" },
      ]),
    "platform matrix producer coverage mismatch",
  );
  const classify = jobs.classify ?? {};
  qualificationAssert(
    (classify.if === undefined || classify.if === true || expression(classify.if) === "true") &&
      (classify["continue-on-error"] === undefined || classify["continue-on-error"] === false),
    "matrix producer job disabled or ignores failure",
  );
  qualificationAssert(isRecord(classify.outputs), "classifier outputs missing");
  qualificationAssert(
    activeSteps(classify).some(
      (step) =>
        rootRun(classify, step) &&
        step.id === "plan" &&
        typeof step.run === "string" &&
        step.run.trim() === "node scripts/select-ci-plan.mts",
    ),
    "matrix producer is not executable",
  );
  for (const [id, output] of [
    ["native_rust", "qualification_native_matrix_json"],
    ["rust_docs", "qualification_docs_matrix_json"],
  ] as const) {
    const job = jobs[id] ?? {};
    qualificationAssert(
      binding(classify.outputs[output]) === `steps.plan.outputs.${output}`,
      `classifier matrix binding changed: ${output}`,
    );
    qualificationAssert(
      binding(matrix(job).include) === `fromJSON(needs.classify.outputs.${output})` &&
        binding(job["runs-on"]) === "matrix.runner",
      `platform matrix consumer binding changed: ${id}`,
    );
  }
  requireConsumer(
    jobs.native_rust ?? {},
    'cargo nextest run --locked --workspace --partition "${{ matrix.partition }}"',
  );
  requireConsumer(
    jobs.rust_docs ?? {},
    "cargo test --locked --workspace --exclude portcove-desktop --doc",
  );
  requireConsumer(jobs.rust_docs ?? {}, "cargo test --locked -p portcove-desktop --doc");
  qualificationAssert(
    isDeepStrictEqual(matrix(jobs.intel_tests ?? {}).partition, ["hash:1/2", "hash:2/2"]),
    "Intel consumer partitions missing",
  );
  qualificationAssert(
    jobs.intel_tests?.["runs-on"] === "macos-15-intel" &&
      strings(jobs.intel_tests.needs).includes("intel_build"),
    "Intel hardware or archive dependency missing",
  );
  requireConsumer(
    jobs.intel_tests ?? {},
    'cargo nextest run --archive-file work/intel-tests/intel-tests.tar.zst --workspace-remap "$PWD" --partition "${{ matrix.partition }}"',
  );
  requireConsumer(
    jobs.intel_build ?? {},
    "cargo nextest archive --locked --workspace --target x86_64-apple-darwin --archive-file intel-tests.tar.zst",
  );
  const windows = jobs.rust_tests ?? {};
  qualificationAssert(
    windows["runs-on"] === "windows-latest" &&
      isDeepStrictEqual(matrix(windows).shard, [
        "core-service-1",
        "core-service-2",
        "core-recovery",
        "core-other-1",
        "core-other-2",
      ]),
    "Windows consumer shards missing",
  );
  qualificationAssert(
    activeSteps(windows).some(
      (step) =>
        rootRun(windows, step) &&
        isRecord(step.env) &&
        binding(step.env.TEST_SHARD) === "matrix.shard" &&
        typeof step.run === "string" &&
        createHash("sha256").update(step.run).digest("hex") ===
          "12b5e234269965e931e02466c2445efc264079f55aedad2a2a504be9defb2a68",
    ),
    "Windows shard dispatch changed; review its executable partition oracle",
  );
  const portability = jobs.frontend_portability ?? {};
  qualificationAssert(
    expression(portability.if) === portabilityCondition && portability["runs-on"] === "macos-26",
    "macOS contributor route changed",
  );
  requireConsumer(portability, "pnpm verify:frontend");
}

function validateAggregates(jobs: Record<string, Record<string, unknown>>) {
  const expected: Record<string, string[]> = {
    rust: [
      "rust_tests",
      "rust_workspace_tests",
      "rust_clippy",
      "windows_storage",
      "native_rust",
      "intel_build",
      "intel_tests",
      "rust_docs",
    ],
    "rust-quality": ["rust_quality_full"],
    frontend: ["frontend_full"],
    catalog: ["catalog_full"],
    "dependency-review": ["dependency_review_full"],
  };
  for (const [context, producers] of Object.entries(expected)) {
    const job = jobs[context] ?? {};
    qualificationAssert(
      job["continue-on-error"] === undefined || job["continue-on-error"] === false,
      `aggregate may not ignore failure: ${context}`,
    );
    qualificationAssert(
      expression(job.if) ===
        (context === "dependency-review"
          ? "github.event_name=='pull_request'&&always()"
          : "always()"),
      `aggregate condition changed: ${context}`,
    );
    const dependencies = strings(job.needs);
    qualificationAssert(
      ["classify", ...producers].every((producer) => dependencies.includes(producer)),
      `aggregate dependency missing: ${context}`,
    );
    qualificationAssert(
      activeSteps(job).some((step) => {
        if (
          !rootRun(job, step) ||
          typeof step.run !== "string" ||
          step.run.trim() !== "node scripts/ci-result-gate.mts" ||
          !isRecord(step.env) ||
          step.env.PORTCOVE_GROUP !== context ||
          typeof step.env.PORTCOVE_QUALIFICATION_RESULTS !== "string"
        )
          return false;
        const results: unknown = JSON.parse(step.env.PORTCOVE_QUALIFICATION_RESULTS);
        return (
          isRecord(results) &&
          isDeepStrictEqual(Object.keys(results).sort(), [...producers].sort()) &&
          producers.every((producer) => binding(results[producer]) === `needs.${producer}.result`)
        );
      }),
      `aggregate result mapping missing: ${context}`,
    );
  }
}

export function qualificationJobs(workflow: string) {
  const observed = qualificationJobInventory(workflow);
  return [...observed.jobs, ...observed.pullRequestJobs].sort();
}

export interface QualificationInventory {
  format_version: 1;
  workflow: ".github/workflows/ci.yml";
  jobs: string[];
  pull_request_jobs: string[];
  platforms: string[];
  protected_contexts: string[];
}
export function assertQualificationInventory(
  inventory: unknown,
): asserts inventory is QualificationInventory {
  if (!isRecord(inventory) || inventory.format_version !== 1)
    throw new Error("unsupported qualification inventory");
  if (inventory.workflow !== ".github/workflows/ci.yml")
    throw new Error("qualification inventory names an unexpected workflow");
  for (const field of ["jobs", "pull_request_jobs", "platforms", "protected_contexts"] as const)
    if (!Array.isArray(inventory[field]) || inventory[field].length === 0)
      throw new Error(`qualification ${field} inventory must be nonzero`);
    else if (!inventory[field].every((value: unknown) => typeof value === "string"))
      throw new Error(`qualification ${field} inventory must contain strings`);
    else if (new Set(inventory[field]).size !== inventory[field].length)
      throw new Error(`duplicate qualification ${field} inventory entry`);
}

export function validateQualificationCoverage(
  inventory: unknown,
  workflow: string,
  matrices = qualificationMatrices({ platforms: expectedPlatforms }),
) {
  assertQualificationInventory(inventory);
  const declared = [...new Set(inventory.jobs)].sort();
  const declaredPullRequest = [...new Set(inventory.pull_request_jobs)].sort();
  const allDeclared = [...declared, ...declaredPullRequest];
  if (new Set(allDeclared).size !== allDeclared.length)
    throw new Error("duplicate qualification job");
  const observed = qualificationJobInventory(workflow);
  const parsedJobs = workflowJobs(workflow);
  qualificationAssert(
    rootRun({ defaults: workflowDefinition(workflow).defaults }, {}),
    "global execution directory or shell unsupported",
  );
  if (
    JSON.stringify(declared) !== JSON.stringify(observed.jobs) ||
    JSON.stringify(declaredPullRequest) !== JSON.stringify(observed.pullRequestJobs)
  )
    throw new Error(
      `qualification job inventory mismatch: declared=${declared.join(",")} pull-request=${declaredPullRequest.join(",")} observed=${observed.jobs.join(",")} observed-pull-request=${observed.pullRequestJobs.join(",")}`,
    );
  for (const context of inventory.protected_contexts)
    if (!parsedJobs[context]) throw new Error(`missing protected context wrapper: ${context}`);
  if (JSON.stringify([...inventory.platforms].sort()) !== JSON.stringify(expectedPlatforms))
    throw new Error("qualification platform inventory mismatch");
  if (
    JSON.stringify([...inventory.protected_contexts].sort()) !==
    JSON.stringify(expectedProtectedContexts)
  )
    throw new Error("qualification protected-context inventory mismatch");
  for (const id of allDeclared) {
    const expectedCondition =
      id === "intel_build" || id === "intel_tests"
        ? intelCondition
        : id === "frontend_portability"
          ? portabilityCondition
          : declaredPullRequest.includes(id)
            ? `github.event_name=='pull_request'&&${qualificationMode}`
            : qualificationMode;
    qualificationAssert(
      expression(parsedJobs[id]?.if) === expectedCondition,
      `producer condition does not match its platform role: ${id}`,
    );
    qualificationAssert(
      strings(parsedJobs[id]?.needs).includes("classify"),
      `classifier dependency missing: ${id}`,
    );
  }
  validateMatrices(parsedJobs, matrices);
  validateAggregates(parsedJobs);
  return {
    jobs: allDeclared.length,
    reusable_jobs: declared.length,
    pull_request_jobs: declaredPullRequest.length,
    platforms: new Set(inventory.platforms).size,
    protected_contexts: new Set(inventory.protected_contexts).size,
  };
}

async function main() {
  const inventory: unknown = JSON.parse(
    await readFile(path.join(root, ".github", "qualification-coverage.json"), "utf8"),
  );
  const workflow = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const counts = validateQualificationCoverage(inventory, workflow);
  console.log(
    `Qualification coverage verified: ${counts.reusable_jobs} reusable jobs, ${counts.pull_request_jobs} pull-request-only jobs, ${counts.platforms} platforms, ${counts.protected_contexts} protected contexts.`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
