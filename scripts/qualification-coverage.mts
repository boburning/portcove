import { isRecord, errorMessage } from "./runtime-values.mts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedPlatforms = ["linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"];
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
    const condition = typeof job.if === "string" ? job.if : "";
    if (!/needs\.classify\.outputs\.mode == 'qualification'/u.test(condition)) continue;
    (/github\.event_name == 'pull_request'/u.test(condition) ? pullRequestJobs : jobs).push(
      current,
    );
  }
  return { jobs: jobs.sort(), pullRequestJobs: pullRequestJobs.sort() };
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

export function validateQualificationCoverage(inventory: unknown, workflow: string) {
  assertQualificationInventory(inventory);
  const declared = [...new Set(inventory.jobs)].sort();
  const declaredPullRequest = [...new Set(inventory.pull_request_jobs)].sort();
  const allDeclared = [...declared, ...declaredPullRequest];
  if (new Set(allDeclared).size !== allDeclared.length)
    throw new Error("duplicate qualification job");
  const observed = qualificationJobInventory(workflow);
  const parsedJobs = workflowJobs(workflow);
  if (
    JSON.stringify(declared) !== JSON.stringify(observed.jobs) ||
    JSON.stringify(declaredPullRequest) !== JSON.stringify(observed.pullRequestJobs)
  )
    throw new Error(
      `qualification job inventory mismatch: declared=${declared.join(",")} pull-request=${declaredPullRequest.join(",")} observed=${observed.jobs.join(",")} observed-pull-request=${observed.pullRequestJobs.join(",")}`,
    );
  for (const context of inventory.protected_contexts)
    if (!parsedJobs[context]) throw new Error(`missing protected context wrapper: ${context}`);
  if (
    JSON.stringify([...inventory.platforms].sort()) !== JSON.stringify(expectedPlatforms) ||
    expectedPlatforms.some(
      (platform) =>
        !Object.values(parsedJobs).some((job) =>
          [job.name, job.if, job["runs-on"], job.strategy].some((value) =>
            JSON.stringify(value)?.includes(platform),
          ),
        ),
    )
  )
    throw new Error("qualification platform inventory mismatch");
  if (
    JSON.stringify([...inventory.protected_contexts].sort()) !==
    JSON.stringify(expectedProtectedContexts)
  )
    throw new Error("qualification protected-context inventory mismatch");
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
