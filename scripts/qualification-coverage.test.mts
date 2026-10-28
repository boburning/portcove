import { readWorkflow } from "./ci-workflow-fixture.mts";
import qualificationOracle from "./fixtures/windows-qualification-selection.json" with { type: "json" };
import { qualificationNextestRecipe } from "./qualification-nextest.mts";
import { discoverCiPlan } from "./select-ci-plan.mts";

import { workflowJob } from "./ci-workflow-fixture.mts";
import { qualityGuide } from "./ci-workflow-fixture.mts";
import { nativeRust } from "./ci-workflow-fixture.mts";
import { intelBuild } from "./ci-workflow-fixture.mts";
import { intelTests } from "./ci-workflow-fixture.mts";
import { rust } from "./ci-workflow-fixture.mts";
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
function isReporterStep(step: Record<string, unknown>) {
  return (
    typeof step.run === "string" &&
    step.run.split(/\r?\n/u).some((line) => {
      const statement = line.trim();
      return (
        statement.startsWith("node scripts/qualification-nextest.mts ") ||
        statement.startsWith(
          "/usr/bin/time -lp -o work/test-results/intel-resource-usage.txt node scripts/qualification-nextest.mts ",
        )
      );
    })
  );
}
const workflow = await readWorkflow(new URL("../.github/workflows/ci.yml", import.meta.url));

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

void test("macOS qualification recognizes only the maintained portability input routes", () => {
  for (const file of [
    "apps/desktop/scripts/browser-runtime.mts",
    "scripts/run-rust-tests.mts",
    "scripts/run-rust-tests.test.mts",
    "scripts/rust-test-tree-supervisor.mts",
    "scripts/rust-test-tree-supervisor.test.mts",
    "pnpm-workspace.yaml",
    "apps/desktop/src/browser/display-recovery.browser.test.tsx",
    "apps/desktop/src/browser/compact-navigation.browser.test.tsx",
    "apps/desktop/src/components/AdoptionModal.browser.test.tsx",
    "apps/desktop/src/components/Artwork.browser.test.tsx",
    "apps/desktop/src/browser/workspace-feedback-user-intent.browser.test.tsx",
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

void test("qualification reporter callers cannot change mode, partition, runtime setup or failure handling", () => {
  const spaced = editedWorkflow((jobs) => {
    for (const name of ["native_rust", "intel_tests", "rust_workspace_tests"]) {
      const caller = requiredFixture(steps(jobs[name]).find(isReporterStep));
      assert.ok(typeof caller.run === "string");
      caller.run =
        "\n# Harmless recipe annotation\n" +
        caller.run
          .split("\n")
          .map((line) => "  " + line)
          .join("\n") +
        "\n";
    }
  });
  validateQualificationCoverage(inventory, spaced);
  const wrapped = editedWorkflow((jobs) => {
    const caller = requiredFixture(steps(jobs.intel_tests).find(isReporterStep));
    assert.ok(typeof caller.run === "string");
    caller.run = caller.run.replace(
      " node scripts/qualification-nextest.mts",
      " \\\n  node scripts/qualification-nextest.mts",
    );
  });
  validateQualificationCoverage(inventory, wrapped);
  // YAML normalizes physical CRLF source; a literal CR in a run value is different.
  validateQualificationCoverage(inventory, workflow.replaceAll(/\r?\n/gu, "\r\n"));

  for (const name of ["native_rust", "intel_tests", "rust_workspace_tests"])
    for (const mutation of [
      "disabled",
      "ignored-failure",
      "wrong-mode",
      "extra-selector",
      "missing-runtime",
      "comment-only",
      "hidden-command",
      "suppressed-status",
      "split-runtime-token",
      "split-script-token",
      "non-shell-separator",
      "literal-carriage-return",
      "literal-cr-continuation",
      ...(name === "intel_tests"
        ? ["missing-accounting", "missing-host", "wrong-metrics-path", "merged-statements"]
        : []),
    ]) {
      const changed = editedWorkflow((jobs) => {
        const job = jobs[name];
        const caller = requiredFixture(steps(job).find((step) => isReporterStep(step)));
        const originalCommand = caller.run;
        assert.ok(typeof originalCommand === "string");
        if (mutation === "disabled") caller.if = false;
        if (mutation === "ignored-failure") caller["continue-on-error"] = true;
        if (mutation === "wrong-mode")
          caller.run = "node scripts/qualification-nextest.mts foreign";
        if (mutation === "extra-selector") caller.run = originalCommand + " --profile hidden";
        if (mutation === "comment-only")
          caller.run = originalCommand
            .split("\n")
            .map((line) => "# " + line)
            .join("\n");
        if (mutation === "hidden-command")
          caller.run = "if false; then\n" + originalCommand + "\nfi";
        if (mutation === "suppressed-status") caller.run = originalCommand.trim() + " || true";
        if (mutation === "non-shell-separator")
          caller.run = originalCommand.replace("node scripts/", "node\u00a0scripts/");
        if (mutation === "literal-carriage-return") caller.run = originalCommand.trimEnd() + "\r";
        if (mutation === "literal-cr-continuation")
          caller.run = originalCommand.replace("node scripts/", "node \\\r\n  scripts/");
        if (mutation === "split-runtime-token")
          caller.run = originalCommand.replace("node scripts/", "no\\\n  de scripts/");
        if (mutation === "split-script-token")
          caller.run = originalCommand.replace(
            "qualification-nextest.mts",
            "qualific\\\n  ation-nextest.mts",
          );
        if (mutation === "missing-accounting")
          caller.run = originalCommand.replace(
            "/usr/bin/time -lp -o work/test-results/intel-resource-usage.txt ",
            "",
          );
        if (mutation === "missing-host")
          caller.run = originalCommand
            .split("\n")
            .filter((line) => !line.includes("/usr/sbin/sysctl"))
            .join("\n");
        if (mutation === "merged-statements")
          caller.run = originalCommand.trim().replaceAll("\n", " ");
        if (mutation === "wrong-metrics-path")
          caller.run = originalCommand.replace(
            "-o work/test-results/intel-resource-usage.txt",
            "-o unretained-metrics.txt",
          );
        if (mutation === "missing-runtime") {
          const setup = requiredFixture(
            steps(job).find((step) => step.uses === "./.github/actions/setup-rust"),
          );
          record(setup.with)["test-fixtures"] = false;
        }
      });
      assert.throws(
        () => validateQualificationCoverage(inventory, changed),
        /Qualification/u,
        `${name}/${mutation}`,
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

void test("doctest scopes, pinned runtime and failure artifacts remain executable obligations", () => {
  for (const mutation of [
    "disabled",
    "extra-argument",
    "missing-runtime",
    "lost-artifacts",
    "success-only",
  ]) {
    const changed = editedWorkflow((jobs) => {
      const job = jobs.rust_docs;
      const caller = requiredFixture(
        steps(job).find((step) => step.run === "node scripts/qualification-rustdoc.mts workspace"),
      );
      if (mutation === "disabled") caller.if = false;
      if (mutation === "extra-argument") caller.run = String(caller.run) + " hidden";
      if (mutation === "missing-runtime") {
        const setup = requiredFixture(
          steps(job).find((step) => String(step.uses).startsWith("actions/setup-node@")),
        );
        record(setup.with)["node-version-file"] = "other-node-version";
      }
      const uploader = requiredFixture(
        steps(job).find((step) => String(step.uses).startsWith("actions/upload-artifact@")),
      );
      if (mutation === "lost-artifacts") record(uploader.with).path = "work/unrelated/";
      if (mutation === "success-only") uploader.if = "success()";
    });
    assert.throws(
      () => validateQualificationCoverage(inventory, changed),
      /Qualification/u,
      mutation,
    );
  }
  const equivalent = editedWorkflow((jobs) => {
    const uploader = requiredFixture(
      steps(jobs.rust_docs).find((step) =>
        String(step.uses).startsWith("actions/upload-artifact@"),
      ),
    );
    uploader.if = " ${{ always() }} ";
  });
  assert.doesNotThrow(() => validateQualificationCoverage(inventory, equivalent));
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
      record(jobs.rust_tests).needs = ["classify"];
    },
    (jobs) => {
      record(jobs.qualification_core_archive)["continue-on-error"] = true;
    },
    (jobs) => {
      record(record(jobs.qualification_core_archive).outputs).manifest_sha256 =
        "${{ steps.foreign.outputs.manifest_sha256 }}";
    },
    (jobs) => {
      record(record(jobs.rust_tests).env).PORTCOVE_WINDOWS_MANIFEST_SHA256 = "unbound";
    },
    (jobs) => {
      record(record(jobs.rust_tests).strategy)["fail-fast"] = true;
    },
    ...["qualification_core_archive", "rust_tests"].flatMap((id) => [
      (jobs: Record<string, unknown>) => {
        record(record(jobs[id]).env).PORTCOVE_PLAN_GZIP_BASE64 =
          "${{ needs.foreign.outputs.plan_gzip_base64 }}";
      },
      (jobs: Record<string, unknown>) => {
        record(
          requiredFixture(
            steps(jobs[id]).find((step) => step.uses === "./.github/actions/setup-rust"),
          ).with,
        )["test-fixtures"] = false;
      },
      (jobs: Record<string, unknown>) => {
        record(
          requiredFixture(
            steps(jobs[id]).find(
              (step) =>
                isRecord(step.with) &&
                typeof step.with.name === "string" &&
                step.with.name.startsWith("windows-qualification-core-"),
            ),
          ).with,
        ).name = "windows-qualification-core-${{ github.run_id }}";
      },
    ]),
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
          (step) =>
            typeof step.run === "string" &&
            step.run.startsWith("node scripts/qualification-nextest.mts native"),
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
        steps(jobs.rust_tests).find(
          (step) => typeof step.run === "string" && step.run.includes("run-qualification"),
        ),
      );
      assert.ok(typeof dispatcher.run === "string");
      dispatcher.run = dispatcher.run.replace("matrix.shard", "matrix.missing");
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

void test("qualification case reporting preserves original scopes and transitive pinned Node setup", async () => {
  assert.deepEqual(
    qualificationNextestRecipe("workspace-other", undefined, "/workspace").selected,
    qualificationOracle.workspace_other.arguments,
  );
  assert.deepEqual(qualificationNextestRecipe("native", "hash:1/1", "/workspace").selected, [
    "--locked",
    "--workspace",
    "--partition",
    "hash:1/1",
  ]);
  for (const partition of ["hash:1/2", "hash:2/2"])
    assert.deepEqual(qualificationNextestRecipe("intel", partition, "/workspace").selected, [
      "--archive-file",
      "work/intel-tests/intel-tests.tar.zst",
      "--workspace-remap",
      "/workspace",
      "--partition",
      partition,
    ]);
  const setup = await readWorkflow(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
  );
  const parsed: unknown = parseDocument(setup).toJS();
  assert.ok(isRecord(parsed) && isRecord(parsed.runs) && Array.isArray(parsed.runs.steps));
  const node = parsed.runs.steps.find(
    (step: unknown) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/setup-node@"),
  ) as unknown;
  assert.ok(isRecord(node) && isRecord(node.with));
  assert.equal(node.if, "inputs.test-fixtures == 'true'");
  assert.equal(node.with["node-version-file"], ".node-version");
  for (const name of ["rust_workspace_tests", "native_rust", "intel_tests"]) {
    const job = workflowJob(name);
    assert.equal(job["timeout-minutes"], 120);
    assert.ok(isRecord(job.env));
    assert.equal(job.env.PORTCOVE_HEAD_SHA, "${{ needs.classify.outputs.head }}");
    const steps = job.steps;
    assert.ok(Array.isArray(steps));
    const setupIndex = steps.findIndex(
      (step: unknown) => isRecord(step) && step.uses === "./.github/actions/setup-rust",
    );
    const executeIndex = steps.findIndex((step: unknown) => isRecord(step) && isReporterStep(step));
    assert.ok(setupIndex >= 0 && executeIndex > setupIndex);
    const input = steps[setupIndex] as unknown;
    assert.ok(isRecord(input) && isRecord(input.with));
    assert.equal(input.with["test-fixtures"], true);
    const retained = steps.find(
      (step: unknown) =>
        isRecord(step) && isRecord(step.with) && step.with.path === "work/test-results/",
    ) as unknown;
    assert.ok(isRecord(retained) && isRecord(retained.with));
    assert.equal(retained.if, "always()");
    assert.ok(
      typeof retained.with.name === "string" &&
        retained.with.name.includes("${{ github.run_attempt }}"),
    );
  }
});

void test("native Rust runs the full workspace on every supported Unix architecture", () => {
  assert.match(
    nativeRust,
    /^ {4}name: native-rust \(\$\{\{ matrix\.platform \}\}, \$\{\{ matrix\.partition \}\}\)$/m,
  );
  assert.match(
    nativeRust,
    /include: \$\{\{ fromJSON\(needs\.classify\.outputs\.qualification_native_matrix_json\) \}\}/,
  );
  const full = discoverCiPlan({
    eventName: "workflow_call",
    checkoutSha: "a".repeat(40),
    forceQualification: true,
  });
  assert.deepEqual(qualificationMatrices(full).native, [
    { platform: "linux-x86_64", runner: "ubuntu-22.04", partition: "hash:1/1" },
    { platform: "macos-aarch64", runner: "macos-15", partition: "hash:1/1" },
  ]);
  assert.match(nativeRust, /if: runner\.os == 'Linux'/);
  assert.match(nativeRust, /echo "TMPDIR=\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
  assert.match(nativeRust, /run: \.\/scripts\/install-linux-desktop-prerequisites\.sh/);
  assert.match(
    nativeRust,
    /node scripts\/qualification-nextest\.mts native "\$\{\{ matrix\.partition \}\}"/,
  );
  assert.doesNotMatch(nativeRust, /continue-on-error/);
});

void test("Intel tests build once and retries preserve their attempt-scoped producer chain", async () => {
  assert.match(intelBuild, /runs-on: macos-15$/m);
  assert.match(intelBuild, /targets: x86_64-apple-darwin/);
  assert.match(
    intelBuild,
    /cargo nextest archive --locked --workspace --target x86_64-apple-darwin/,
  );
  assert.match(intelBuild, /if-no-files-found: error/);
  assert.match(intelBuild, /retention-days: 1/);
  const consumer = workflowJob("intel_tests");
  assert.deepEqual(consumer.needs, ["classify", "intel_build"]);
  assert.match(intelTests, /runs-on: macos-15-intel/);
  assert.ok(isRecord(consumer.strategy) && isRecord(consumer.strategy.matrix));
  assert.deepEqual(consumer.strategy.matrix.partition, ["hash:1/2", "hash:2/2"]);
  assert.match(
    intelTests,
    /node scripts\/qualification-nextest\.mts intel "\$\{\{ matrix\.partition \}\}"/,
  );
  for (const section of [intelBuild, intelTests]) {
    assert.match(section, /name: intel-rust-tests-\$\{\{ github\.run_attempt \}\}/);
    assert.doesNotMatch(section, /continue-on-error/);
  }
  const transferGuide = await readFile(
    new URL("../docs/reference/quality-operations.md", import.meta.url),
    "utf8",
  );
  assert.match(qualityGuide, /reference\/quality-operations\.md#consumed-intel-test-transfers/);
  assert.match(
    transferGuide,
    /gh run rerun <run-id> --job <build-intel-tests-job-id> --repo boburning\/portcove/,
  );
  assert.match(transferGuide, /Do not use .*--failed.*Intel consumer/u);
  assert.match(transferGuide, /never reuse an\s+artifact from an earlier attempt/u);
  for (const job of ["intel_build", "intel_tests"])
    assert.ok(rust.includes(`"${job}":"` + "${{ needs." + job + '.result }}"'));
});
