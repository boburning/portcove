import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedPlatforms = ["linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"];
const expectedProtectedContexts = [
  "catalog",
  "dependency-review",
  "frontend",
  "rust",
  "rust-quality",
];

export function qualificationJobInventory(workflow) {
  const jobs = [];
  const pullRequestJobs = [];
  let current = null;
  let body = [];
  const flush = () => {
    if (!current) return;
    const condition = body.find((line) => /^ {4}if:/u.test(line)) ?? "";
    if (!/needs\.classify\.outputs\.mode == 'qualification'/u.test(condition)) return;
    (/github\.event_name == 'pull_request'/u.test(condition) ? pullRequestJobs : jobs).push(
      current,
    );
  };
  for (const line of workflow.split(/\r?\n/u)) {
    const match = /^  ([a-z][a-z0-9_]+):$/u.exec(line);
    if (match) {
      flush();
      current = match[1];
      body = [];
    } else if (current) body.push(line);
  }
  flush();
  return { jobs: jobs.sort(), pullRequestJobs: pullRequestJobs.sort() };
}

export function qualificationJobs(workflow) {
  const observed = qualificationJobInventory(workflow);
  return [...observed.jobs, ...observed.pullRequestJobs].sort();
}

export function validateQualificationCoverage(inventory, workflow) {
  if (inventory?.format_version !== 1) throw new Error("unsupported qualification inventory");
  if (inventory.workflow !== ".github/workflows/ci.yml")
    throw new Error("qualification inventory names an unexpected workflow");
  for (const field of ["jobs", "pull_request_jobs", "platforms", "protected_contexts"])
    if (!Array.isArray(inventory[field]) || inventory[field].length === 0)
      throw new Error(`qualification ${field} inventory must be nonzero`);
    else if (new Set(inventory[field]).size !== inventory[field].length)
      throw new Error(`duplicate qualification ${field} inventory entry`);
  const declared = [...new Set(inventory.jobs)].sort();
  const declaredPullRequest = [...new Set(inventory.pull_request_jobs)].sort();
  const allDeclared = [...declared, ...declaredPullRequest];
  if (new Set(allDeclared).size !== allDeclared.length)
    throw new Error("duplicate qualification job");
  const observed = qualificationJobInventory(workflow);
  if (
    JSON.stringify(declared) !== JSON.stringify(observed.jobs) ||
    JSON.stringify(declaredPullRequest) !== JSON.stringify(observed.pullRequestJobs)
  )
    throw new Error(
      `qualification job inventory mismatch: declared=${declared.join(",")} pull-request=${declaredPullRequest.join(",")} observed=${observed.jobs.join(",")} observed-pull-request=${observed.pullRequestJobs.join(",")}`,
    );
  for (const context of inventory.protected_contexts)
    if (!workflow.includes(`\n  ${context}:`))
      throw new Error(`missing protected context wrapper: ${context}`);
  if (
    JSON.stringify([...inventory.platforms].sort()) !== JSON.stringify(expectedPlatforms) ||
    expectedPlatforms.some((platform) => !workflow.includes(platform))
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
  const inventory = JSON.parse(
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
    console.error(error.message);
    process.exitCode = 1;
  });
}
