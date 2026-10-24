import inventory from "../.github/qualification-coverage.json" with { type: "json" };
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseDocument, stringify } from "yaml";
import { isRecord } from "./runtime-values.mts";
import { qualificationMatrices } from "./validation-platforms.mts";

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

void test("macOS qualification recognizes only the maintained native keyboard input routes", () => {
  for (const file of [
    "pnpm-workspace.yaml",
    "apps/desktop/src/browser/display-recovery.browser.test.tsx",
    "apps/desktop/src/browser/compact-navigation.browser.test.tsx",
    "apps/desktop/src/components/AdoptionModal.browser.test.tsx",
  ]) {
    const changed = editedWorkflow((jobs) => {
      const job = record(jobs.frontend_portability);
      assert.ok(typeof job.if === "string" && job.if.includes(file));
      job.if = job.if.replace(file, "unowned-neighbor");
    });
    assert.throws(
      () => validateQualificationCoverage(inventory, changed),
      /Unsupported qualification condition/u,
    );
  }
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

void test("qualification structure is independent of YAML layout and rejects comment-only or duplicate jobs", () => {
  const reformatted = stringify(parseDocument(workflow).toJS(), { indent: 4 });
  assert.deepEqual(
    validateQualificationCoverage(inventory, reformatted),
    validateQualificationCoverage(inventory, workflow),
  );
  assert.deepEqual(
    qualificationJobInventory(
      "# phantom:\n#   if: needs.classify.outputs.mode == 'qualification'\njobs: {}",
    ),
    { jobs: [], pullRequestJobs: [] },
  );
  assert.throws(
    () => qualificationJobInventory("jobs:\n  duplicate: {}\n  duplicate: {}\n"),
    /Invalid workflow YAML/,
  );
  const withoutRust = parseDocument(workflow);
  withoutRust.setIn(["jobs", "removed_rust"], withoutRust.getIn(["jobs", "rust"]));
  withoutRust.deleteIn(["jobs", "rust"]);
  assert.throws(
    () => validateQualificationCoverage(inventory, `${withoutRust.toString()}\n#  rust:\n`),
    /missing protected context/,
  );
});

function record(value: unknown) {
  assert.ok(isRecord(value));
  return value;
}
function editedWorkflow(edit: (jobs: Record<string, unknown>) => void) {
  const settings: unknown = parseDocument(workflow).toJS();
  const root = record(settings);
  edit(record(root.jobs));
  return stringify(root, { indent: 4 });
}
function steps(job: unknown) {
  const values = record(job).steps;
  assert.ok(Array.isArray(values));
  const entries: unknown[] = values;
  return entries.map(record);
}

void test("disabled expressions, missing consumer partitions and fake platform labels cannot satisfy qualification", () => {
  const mutations: ((jobs: Record<string, unknown>) => void)[] = [
    (jobs) => {
      record(jobs.classify).if = false;
    },
    (jobs) => {
      record(jobs.classify)["continue-on-error"] = true;
    },
    (jobs) => {
      record(jobs.native_rust).defaults = {
        run: { "working-directory": "fixtures/empty-workspace" },
      };
    },
    (jobs) => {
      const plan = requiredFixture(steps(jobs.classify).find((step) => step.id === "plan"));
      plan.shell = "echo {0}";
    },
    (jobs) => {
      record(record(record(jobs.rust_tests).strategy).matrix).exclude = [
        { shard: "core-service-1" },
      ];
    },
    (jobs) => {
      record(record(record(jobs.intel_tests).strategy).matrix).exclude = [
        { partition: "hash:1/2" },
      ];
    },
    (jobs) => {
      record(record(record(jobs.native_rust).strategy).matrix).exclude = [
        { platform: "linux-x86_64" },
      ];
    },
    (jobs) => {
      record(record(record(jobs.rust_docs).strategy).matrix).exclude = [
        { platform: "windows-x86_64" },
      ];
    },
    (jobs) => {
      record(jobs.catalog_full).if = "needs.classify.outputs.mode == 'qual ification'";
    },
    (jobs) => {
      record(jobs.catalog_full).if = "false && needs.classify.outputs.mode == 'qualification'";
    },
    (jobs) => {
      record(jobs.catalog_full)["continue-on-error"] = true;
    },
    (jobs) => {
      record(record(jobs.native_rust).strategy).matrix = {
        include: [{ platform: "linux-x86_64" }, { platform: "macos-aarch64" }],
      };
    },
    (jobs) => {
      record(record(record(jobs.intel_tests).strategy).matrix).partition = ["hash:1/2"];
    },
    (jobs) => {
      record(record(record(jobs.rust_tests).strategy).matrix).shard = [
        "core-service-1",
        "core-service-2",
        "core-recovery",
        "core-other-1",
      ];
    },
    (jobs) => {
      record(jobs.native_rust)["runs-on"] = "ubuntu-22.04";
    },
    (jobs) => {
      const consumer = requiredFixture(
        steps(jobs.native_rust).find(
          (step) => typeof step.run === "string" && step.run.startsWith("cargo nextest run"),
        ),
      );
      consumer.if = false;
    },
    (jobs) => {
      record(record(jobs.classify).outputs).qualification_native_matrix_json =
        "${{ steps.plan.outputs.qualification_docs_matrix_json }}";
    },
    (jobs) => {
      record(record(jobs.classify).outputs).qualification_native_matrix_json =
        "steps.plan.outputs.qualification_native_matrix_json";
    },
    (jobs) => {
      const dispatcher = requiredFixture(
        steps(jobs.rust_tests).find((step) => isRecord(step.env) && "TEST_SHARD" in step.env),
      );
      assert.ok(typeof dispatcher.run === "string");
      dispatcher.run = dispatcher.run.replace('"core-service-1" {', '"never-selected" {');
    },
  ];
  for (const mutate of mutations)
    assert.throws(
      () => validateQualificationCoverage(inventory, editedWorkflow(mutate)),
      /[Qq]ualification/,
    );
  const matrices = qualificationMatrices({
    platforms: ["linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"],
  });
  assert.throws(
    () =>
      validateQualificationCoverage(inventory, workflow, {
        ...matrices,
        native: matrices.native.slice(1),
      }),
    /producer coverage/,
  );
  assert.throws(
    () =>
      validateQualificationCoverage(inventory, workflow, {
        ...matrices,
        docs: matrices.docs.slice(1),
      }),
    /producer coverage/,
  );
});

void test("protected aggregates require their real producer dependencies and matching result bindings", () => {
  for (const mutation of [
    (jobs: Record<string, unknown>) => {
      const job = record(jobs.rust);
      assert.ok(Array.isArray(job.needs));
      const values: unknown[] = job.needs;
      job.needs = values.filter((id) => id !== "native_rust");
    },
    (jobs: Record<string, unknown>) => {
      const gate = requiredFixture(
        steps(jobs.rust).find((step) => step.run === "node scripts/ci-result-gate.mts"),
      );
      record(gate.env).PORTCOVE_QUALIFICATION_RESULTS =
        '{"rust_tests":"${{ needs.rust_tests.result }}"}';
    },
    (jobs: Record<string, unknown>) => {
      record(jobs.rust).if = false;
    },
  ])
    assert.throws(
      () => validateQualificationCoverage(inventory, editedWorkflow(mutation)),
      /aggregate/,
    );
});

void test("folded and explicitly wrapped supported conditions preserve qualification meaning", () => {
  const equivalent = editedWorkflow((jobs) => {
    record(jobs.catalog_full).if = "${{\n needs.classify.outputs.mode\n == 'qualification'\n}}";
  });
  assert.deepEqual(
    validateQualificationCoverage(inventory, equivalent),
    validateQualificationCoverage(inventory, workflow),
  );
});

void test("qualification conditions remain bound to each producer's platform role", () => {
  for (const [consumer, donor] of [
    ["native_rust", "intel_tests"],
    ["rust_docs", "intel_build"],
    ["catalog_full", "intel_tests"],
    ["intel_build", "catalog_full"],
    ["intel_tests", "native_rust"],
    ["frontend_portability", "catalog_full"],
  ]) {
    assert.ok(consumer && donor);
    const swapped = editedWorkflow((jobs) => {
      const target = record(jobs[consumer]);
      const replacement = record(jobs[donor]).if;
      assert.notEqual(target.if, replacement);
      target.if = replacement;
    });
    assert.throws(() => validateQualificationCoverage(inventory, swapped), /[Qq]ualification/);
  }
});

void test("protected aggregates cannot ignore their own failed result", () => {
  for (const context of inventory.protected_contexts) {
    const ignored = editedWorkflow((jobs) => {
      record(jobs[context])["continue-on-error"] = true;
    });
    assert.throws(() => validateQualificationCoverage(inventory, ignored), /aggregate/);
  }
});
