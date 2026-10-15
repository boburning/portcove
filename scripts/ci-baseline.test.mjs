import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCiMetrics } from "./ci-metrics.mjs";
import { buildValidationPlan } from "./validation-plan.mjs";
import { discoverCiPlan } from "./select-ci-plan.mjs";
import { buildPlan } from "./local-validation.mjs";
import {
  baselineContractTests,
  baselineFrontendPlan,
  baselineLintPlan,
  baselineIntegrityCommands,
  baselineBootstrapTests,
  baselineTestEnvironment,
  baselineSelection,
} from "./ci-baseline.mjs";
const make = (files) =>
  buildValidationPlan({
    changes: files.map((file) => ({
      status: "M",
      oldMode: "100644",
      newMode: "100644",
      oldPath: file,
      newPath: file,
    })),
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });

test("local and hosted lint use one full stage for relevant inputs, including rename and deletion", () => {
  for (const file of [
    "apps/desktop/src/App.tsx",
    "apps/desktop/src/app.css",
    "scripts/tool.test.mjs",
    "scripts/new.ts",
    "vite.config.ts",
    ".node-version",
    "apps/desktop/stylelint.config.mjs",
    "apps/desktop/tsconfig.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "unknown/input.bin",
    "apps/desktop/assets/unmapped.bin",
  ]) {
    const plan = make([file]);
    const hosted = baselineLintPlan(plan);
    assert.equal(hosted.length, 1, file);
    assert.equal(hosted[0].id, "repository-lint");
    assert.equal(hosted[0].executable, "corepack");
    assert.deepEqual(hosted[0].args, ["pnpm", "check"]);
    assert.equal(path.resolve(hosted[0].cwd), process.cwd());
    assert.deepEqual(
      hosted,
      buildPlan(baselineSelection(plan), { validationPlan: plan }).filter(
        (entry) => entry.id === "repository-lint",
      ),
    );
  }
  for (const file of [
    "docs/QUALITY.md",
    "crates/portcove-core/src/lib.rs",
    "apps/desktop/public/logo.png",
    "apps/desktop/src/artwork.png",
  ])
    assert.deepEqual(baselineLintPlan(make([file])), [], file);
  const changes = [
    {
      status: "R100",
      oldPath: "scripts/old.mjs",
      newPath: "docs/old.md",
      oldMode: "100644",
      newMode: "100644",
    },
    {
      status: "D",
      oldPath: "apps/desktop/src/old.tsx",
      newPath: "apps/desktop/src/old.tsx",
      oldMode: "100644",
      newMode: "000000",
    },
  ];
  for (const change of changes) {
    const plan = buildValidationPlan({
      changes: [change],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    assert.equal(baselineLintPlan(plan).length, 1, change.status);
  }
  assert.equal(baselineLintPlan(make(["scripts/a.mjs", "apps/desktop/src/App.tsx"])).length, 1);
});

test("first pushes and missing historical bases retain full lint without changed-file entries", () => {
  const options = {
    eventName: "push",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    checkoutSha: "b".repeat(40),
    fastValidationEnabled: true,
    proseOnlyEnabled: true,
  };
  const first = discoverCiPlan({ ...options, baseSha: "0".repeat(40) }, () =>
    assert.fail("first push needs no historical Git reads"),
  );
  const missing = discoverCiPlan(options, (args) => {
    if (args[0] === "cat-file" && args[2].startsWith("a".repeat(40)))
      throw Object.assign(new Error("missing base"), { status: 128 });
    return Buffer.alloc(0);
  });
  for (const plan of [first, missing]) {
    assert.deepEqual(plan.changes, []);
    assert.equal(plan.fallback, null);
    assert.equal(plan.groups.length, 5);
    const local = buildPlan(baselineSelection(plan), { validationPlan: plan }).filter(
      (entry) => entry.id === "repository-lint",
    );
    assert.equal(local.length, 1);
    assert.deepEqual(baselineLintPlan(plan), local);
  }
});
test("Playnite and handoff repairs select their cheap regressions in ordinary CI", () => {
  const tests = baselineContractTests(
    make(["integrations/playnite/check.ps1", "scripts/handoff-evidence.mjs"]),
  );
  assert.ok(tests.includes("integrations/playnite/lifecycle-check.test.mjs"));
  assert.ok(tests.includes("scripts/handoff-evidence.test.mjs"));
});
test("bootstrap regressions are limited to infrastructure, including old rename paths", () => {
  assert.deepEqual(baselineBootstrapTests(make(["crates/portcove-core/src/lib.rs"])), []);
  assert.deepEqual(baselineBootstrapTests(make([".github/workflows/ci.yml"])), [
    "scripts/rust-support-cache.test.mjs",
  ]);
  const renamed = make(["scripts/new-runner.mjs"]);
  renamed.changes[0].oldPath = "scripts/run-rust-tests.mjs";
  renamed.changes[0].status = "R100";
  // Rebuild the validated plan so its digest and discovery stay coherent.
  const plan = buildValidationPlan({
    changes: renamed.changes,
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });
  assert.deepEqual(baselineBootstrapTests(plan), ["scripts/rust-support-cache.test.mjs"]);
});
test("hosted contracts retain relevant script/docs/schema tests without stateful qualification", () => {
  const p = make(["scripts/run-rust-tests.mjs", "docs/QUALITY.md"]);
  const tests = baselineContractTests(p);
  for (const file of [
    "scripts/run-rust-tests.test.mjs",
    "scripts/heavy-rust-test-lock.test.mjs",
    "scripts/repository-settings.test.mjs",
  ])
    assert.ok(tests.includes(file));
  assert.ok(!tests.includes("scripts/windows-qualification-session.integration.test.mjs"));
});

test("release run evidence contracts are selected for implementation and test changes", () => {
  for (const changed of [
    "scripts/release-run-evidence.mjs",
    "scripts/release-run-evidence.test.mjs",
  ]) {
    const plan = make([changed]);
    assert.ok(plan.areas.includes("release-security"));
    assert.ok(plan.groups.includes("catalog"));
    assert.ok(baselineContractTests(plan).includes("scripts/release-run-evidence.test.mjs"));
  }
});
test("shared and unknown frontend inputs use full units; sources use the related graph", () => {
  const related = baselineFrontendPlan(make(["apps/desktop/src/App.tsx"]));
  assert.ok(
    related.findIndex((entry) => entry.id === "ui-copy") <
      related.findIndex((entry) => entry.id === "ui-build"),
  );
  assert.ok(related.some((entry) => entry.id === "ui-related-tests"));
  assert.deepEqual(related.find((entry) => entry.id === "ui-related-durations").args, [
    "scripts/check-vitest-durations.mjs",
    "work/ui-related-tests.json",
    "--full-suite-on-empty",
  ]);
  for (const p of [make(["apps/desktop/tsconfig.json"]), make(["unknown/new-input.bin"])]) {
    const full = baselineFrontendPlan(p);
    assert.ok(full.some((entry) => entry.id === "ui-tests"));
    assert.ok(!full.some((entry) => entry.id === "ui-related-tests"));
  }
  assert.throws(() => baselineFrontendPlan(make(["docs/QUALITY.md"])));
});

test("selected contract tests retain cheap actual-checkout integrity", () => {
  const catalog = baselineIntegrityCommands(make(["crates/portcove-core/catalog/catalog.json"]));
  assert.ok(
    catalog.some((args) => args[0] === "scripts/generate-catalog.mjs" && args[1] === "--check"),
  );
  assert.ok(
    catalog.some(
      (args) => args[0] === "scripts/check-retcomm-upstreams.mjs" && args[1] === "--offline",
    ),
  );
  const docs = baselineIntegrityCommands(make(["docs/QUALITY.md"]));
  assert.ok(
    docs.some((args) => args[0] === "scripts/repository-settings.mjs" && args[1] === "--validate"),
  );
  assert.ok(!docs.some((args) => args[0] === "scripts/generate-catalog.mjs"));
});

test("fixture subprocess timings cannot contaminate the hosted batch report", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-fixture-timing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    PORTCOVE_CI_METRICS_DIR: directory,
    GITHUB_RUN_ID: "actual-run",
  };
  const metrics = createCiMetrics({ environment });
  const isolated = baselineTestEnvironment(environment);
  assert.equal(isolated.GITHUB_RUN_ID, "actual-run");
  assert.equal(environment.PORTCOVE_CI_METRICS_DIR, directory);
  const child = metrics.measure("repository-contract-tests", () =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {createCiMetrics} from "./scripts/ci-metrics.mjs"; createCiMetrics().record("synthetic-failed-phase", {outcome:"failed"});',
      ],
      { cwd: new URL("..", import.meta.url), env: isolated, encoding: "utf8" },
    ),
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readdirSync(directory).length, 1, "only actual parent batch diagnostics survive");
});
