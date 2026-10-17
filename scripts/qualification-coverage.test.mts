import inventory from "../.github/qualification-coverage.json" with { type: "json" };
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  qualificationJobInventory,
  qualificationJobs,
  validateQualificationCoverage,
} from "./qualification-coverage.mts";

function requiredFixture<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

void test("qualification inventory is nonzero and exactly covers exhaustive jobs", () => {
  const counts = validateQualificationCoverage(inventory, workflow);
  assert.ok(counts.jobs > 0);
  assert.ok(counts.reusable_jobs > 0);
  assert.equal(counts.pull_request_jobs, 1);
  assert.ok(counts.platforms > 0);
  assert.equal(counts.protected_contexts, 5);
  assert.deepEqual(qualificationJobInventory(workflow), {
    jobs: [...inventory.jobs].sort(),
    pullRequestJobs: [...inventory.pull_request_jobs].sort(),
  });
  assert.deepEqual(
    qualificationJobs(workflow),
    [...inventory.jobs, ...inventory.pull_request_jobs].sort(),
  );
});

void test("missing, extra, duplicate, or zero inventories fail closed", () => {
  assert.throws(
    () => validateQualificationCoverage({ ...inventory, jobs: [] }, workflow),
    /must be nonzero/u,
  );
  assert.throws(
    () => validateQualificationCoverage({ ...inventory, pull_request_jobs: [] }, workflow),
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
        { ...inventory, jobs: [...inventory.jobs, requiredFixture(inventory.jobs[0])] },
        workflow,
      ),
    /duplicate/u,
  );
  assert.throws(
    () =>
      validateQualificationCoverage(
        {
          ...inventory,
          platforms: [...inventory.platforms, requiredFixture(inventory.platforms[0])],
        },
        workflow,
      ),
    /duplicate/u,
  );
  assert.throws(
    () =>
      validateQualificationCoverage(
        { ...inventory, platforms: inventory.platforms.slice(1) },
        workflow,
      ),
    /platform inventory mismatch/u,
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
