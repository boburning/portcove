import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function qualificationJobs(workflow) {
  const jobs = [];
  let current = null;
  let body = [];
  const flush = () => {
    if (current && /mode == 'qualification'/u.test(body.join("\n"))) jobs.push(current);
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
  return jobs.sort();
}

export function validateQualificationCoverage(inventory, workflow) {
  if (inventory?.format_version !== 1) throw new Error("unsupported qualification inventory");
  if (inventory.workflow !== ".github/workflows/ci.yml")
    throw new Error("qualification inventory names an unexpected workflow");
  for (const field of ["jobs", "platforms", "protected_contexts"])
    if (!Array.isArray(inventory[field]) || inventory[field].length === 0)
      throw new Error(`qualification ${field} inventory must be nonzero`);
  const declared = [...new Set(inventory.jobs)].sort();
  if (declared.length !== inventory.jobs.length) throw new Error("duplicate qualification job");
  const observed = qualificationJobs(workflow);
  if (JSON.stringify(declared) !== JSON.stringify(observed))
    throw new Error(
      `qualification job inventory mismatch: declared=${declared.join(",")} observed=${observed.join(",")}`,
    );
  for (const context of inventory.protected_contexts)
    if (!workflow.includes(`\n  ${context}:`))
      throw new Error(`missing protected context wrapper: ${context}`);
  return {
    jobs: declared.length,
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
    `Qualification coverage verified: ${counts.jobs} jobs, ${counts.platforms} platforms, ${counts.protected_contexts} protected contexts.`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
