import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { qualificationJobs, validateQualificationCoverage } from "./qualification-coverage.mjs";

const inventory = JSON.parse(
  await readFile(new URL("../.github/qualification-coverage.json", import.meta.url), "utf8"),
);
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("qualification inventory is nonzero and exactly covers exhaustive jobs", () => {
  const counts = validateQualificationCoverage(inventory, workflow);
  assert.ok(counts.jobs > 0);
  assert.ok(counts.platforms > 0);
  assert.equal(counts.protected_contexts, 5);
  assert.deepEqual(qualificationJobs(workflow), [...inventory.jobs].sort());
});

test("missing, extra, duplicate, or zero inventories fail closed", () => {
  assert.throws(
    () => validateQualificationCoverage({ ...inventory, jobs: [] }, workflow),
    /must be nonzero/u,
  );
  assert.throws(
    () =>
      validateQualificationCoverage({ ...inventory, jobs: [...inventory.jobs, "extra"] }, workflow),
    /mismatch/u,
  );
  assert.throws(
    () =>
      validateQualificationCoverage(
        { ...inventory, jobs: [...inventory.jobs, inventory.jobs[0]] },
        workflow,
      ),
    /duplicate/u,
  );
  assert.throws(
    () =>
      validateQualificationCoverage(
        inventory,
        workflow.replace(/  rust:\r?\n/u, "  rust_removed:\n"),
      ),
    /missing protected context/u,
  );
});
