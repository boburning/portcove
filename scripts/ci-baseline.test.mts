import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCiMetrics } from "./ci-metrics.mts";
import { buildValidationPlan } from "./validation-plan.mts";
import { discoverCiPlan } from "./select-ci-plan.mts";
import { buildPlan, classifyChanges } from "./local-validation.mts";
import { windowsHelperChecksRequired } from "./windows-helper-checks.mts";
import { nativeCompatibilitySourcePaths } from "./release-native-source-contract.mts";
import {
  baselineContractTests,
  baselineFrontendPlan,
  baselineLintPlan,
  baselineIntegrityCommands,
  baselineBootstrapTests,
  baselineTestEnvironment,
  baselineSelection,
  baselineRequiresPython,
  baselineRequiresRust,
  baselineRequiresDesktopDependencies,
} from "./ci-baseline.mts";
void test("Linux reviewer boundary edits retain protected ownership and Python contract execution", () => {
  for (const file of [
    "scripts/semantic-review-linux-supervisor.py",
    "scripts/semantic-review-linux-supervisor.test.py",
    "scripts/semantic-review-linux-supervisor.test.mts",
    "scripts/qualify-semantic-linux.mts",
  ]) {
    const plan = make([file]);
    assert.ok(plan.areas.includes("release-security"), file);
    assert.ok(
      baselineContractTests(plan).includes("scripts/semantic-review-linux-supervisor.test.mts"),
      file,
    );
    assert.ok(baselineRequiresPython(plan), file);
  }
});

void test("semantic source acquisition retains release ownership and its Python parser boundary contracts", () => {
  for (const file of [
    "scripts/release-semantic-source.mts",
    "scripts/semantic-source-git.py",
    "scripts/semantic-source-git.test.py",
    "scripts/qualify-semantic-source.mts",
  ]) {
    const plan = make([file]);
    assert.ok(plan.areas.includes("release-security"), file);
    assert.ok(
      baselineContractTests(plan).includes("scripts/release-semantic-source.test.mts"),
      file,
    );
    assert.ok(baselineRequiresPython(plan), file);
  }
});

const make = (files: string[]) =>
  buildValidationPlan({
    changes: files.map((file: string) => ({
      status: "M",
      oldMode: file.endsWith(".sh") ? "100755" : "100644",
      newMode: file.endsWith(".sh") ? "100755" : "100644",
      oldPath: file,
      newPath: file,
    })),
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });

void test("Python result helpers retain every real suite consumer and its interpreter", () => {
  const expected = [
    "scripts/python-test-results.test.mts",
    "scripts/native-linux-isolated-init.test.mts",
    "scripts/native-qualification-linux-supervisor.test.mts",
    "scripts/native-qualification-linux-transfer.test.mts",
    "scripts/native-linux-public-fuse.test.mts",
    "scripts/native-linux-public-network.test.mts",
    "scripts/native-linux-public-services.test.mts",
    "scripts/semantic-review-linux-supervisor.test.mts",
    "scripts/release-semantic-source.test.mts",
  ];
  for (const file of ["scripts/python-test-results.py", "scripts/python-test-results.mts"]) {
    const plan = make([file]);
    const selected = baselineContractTests(plan);
    for (const consumer of expected) assert.ok(selected.includes(consumer), `${file}: ${consumer}`);
    assert.ok(baselineRequiresPython(plan), file);
  }
  for (const file of expected) assert.ok(baselineRequiresPython(make([file])), file);
});

void test(
  "a stuck inner child reports its timeout and exits before the maintained outer budget",
  { timeout: 20_000 },
  (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "portcove-nested-timeout-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fixture = path.join(root, "timeout.test.mjs");
    writeFileSync(
      fixture,
      `import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
test('inner timeout keeps stderr and joins its child', () => {
  const result=spawnSync(process.execPath,['-e','console.log(process.pid); console.error("inner-ready"); setInterval(()=>{},1000)'],{encoding:'utf8',timeout:2000,killSignal:'SIGKILL',windowsHide:true});
  assert.equal(result.error?.code,'ETIMEDOUT');
  assert.match(result.stderr,/inner-ready/);
  const pid=Number(result.stdout.trim()); assert.ok(Number.isInteger(pid)&&pid>0);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  console.log('inner-timeout-reported-and-joined');
});\n`,
    );
    const env = baselineTestEnvironment();
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--test-timeout=10000", fixture], {
      encoding: "utf8",
      env,
      timeout: 15_000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /inner-timeout-reported-and-joined/);
  },
);

void test("shared diagnostics inputs keep hosted frontend and quality plans runnable", () => {
  for (const file of [
    "crates/portcove-diagnostics/Cargo.toml",
    "crates/portcove-diagnostics/src/lib.rs",
    "crates/portcove-diagnostics/src/sessions/tests.rs",
  ]) {
    const plan = make([file]);
    assert.equal(plan.fallback, null, file);
    assert.ok(plan.groups.includes("rust"), file);
    assert.ok(plan.groups.includes("rust-quality"), file);
    assert.equal(baselineSelection(plan).unknown.size, 0, file);
    assert.doesNotThrow(() => baselineLintPlan(plan), file);

    const mixed = make([file, "apps/desktop/src/App.tsx"]);
    assert.ok(
      baselineFrontendPlan(mixed).some((entry) => entry.id === "ui-build"),
      file,
    );
    assert.doesNotThrow(() => baselineLintPlan(mixed), file);
  }
});

void test("native source declarations start their cheap hosted consumer without release qualification", () => {
  const contract = "scripts/release-native-source-contract.test.mts";
  for (const source of nativeCompatibilitySourcePaths) {
    const plan = make([source]);
    assert.ok(plan.groups.includes("catalog"), source);
    assert.ok(plan.groups.includes("rust"), source);
    assert.equal(baselineContractTests(plan).filter((file) => file === contract).length, 1, source);
    assert.equal(baselineRequiresDesktopDependencies(plan), true, source);
  }
  for (const source of [
    "crates/portcove-core/src/database.rs",
    "crates/portcove-core/src/lib.rs",
  ]) {
    const plan = make([source]);
    assert.deepEqual(plan.groups, ["catalog", "rust", "rust-quality"]);
    assert.equal(plan.mode, "fast");
    assert.equal(plan.qualification_required, false);
    assert.equal(plan.areas.includes("release-security"), false);
    assert.equal(
      baselineRequiresRust(plan),
      false,
      "source declaration contracts do not compile Rust",
    );
  }
  assert.equal(
    baselineContractTests(make(["crates/portcove-core/src/source_report.rs"])).includes(contract),
    false,
  );
  assert.equal(
    baselineRequiresDesktopDependencies(make(["crates/portcove-core/src/source_report.rs"])),
    false,
  );
  assert.equal(baselineRequiresDesktopDependencies(make(["docs/README.md"])), false);
  for (const source of [
    "scripts/release-native-candidate.mts",
    "scripts/release-native-source-contract.mts",
    "scripts/release-native-source-contract.test.mts",
  ])
    assert.equal(baselineRequiresDesktopDependencies(make([source])), true, source);
  assert.equal(
    baselineRequiresDesktopDependencies(
      buildValidationPlan({
        changes: [],
        eventName: "pull_request",
        checkout: "b".repeat(40),
        discovery: "failed",
        blockedReason: "fixture",
      }),
    ),
    false,
  );
});

void test("storage metadata contracts provision pinned Rust for direct and indirect selection", () => {
  for (const file of [
    "scripts/dev-storage.mts",
    "scripts/dev-storage.test.mts",
    "justfile",
    "package.json",
  ]) {
    const plan = make([file]);
    assert.ok(baselineContractTests(plan).includes("scripts/dev-storage.test.mts"));
    assert.equal(baselineRequiresRust(plan), true);
  }
  assert.equal(baselineRequiresRust(make(["docs/README.md"])), false);
});

void test("local and hosted lint use one full stage for relevant inputs, including rename and deletion", () => {
  for (const file of [
    "apps/desktop/src/App.tsx",
    "apps/desktop/src/app.css",
    "scripts/tool.test.mjs",
    "scripts/new.ts",
    "vite.config.ts",
    ".node-version",
    "apps/desktop/stylelint.config.mjs",
    "apps/desktop/scripts/stylelint-config.mts",
    "apps/desktop/tsconfig.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "unknown/input.bin",
    "apps/desktop/assets/unmapped.bin",
  ]) {
    const plan = make([file]);
    const hosted = baselineLintPlan(plan);
    assert.ok(hosted[0]);
    assert.equal(hosted.length, 1, file);
    assert.equal(hosted[0].id, "repository-lint");
    assert.equal(hosted[0].executable, process.execPath);
    assert.deepEqual(hosted[0].args, [
      "scripts/run-viteplus.mts",
      "run",
      file.startsWith("scripts/") ? "repository:static" : "frontend:static",
    ]);
    assert.equal(path.resolve(hosted[0].cwd), process.cwd());
    assert.deepEqual(
      hosted,
      buildPlan(baselineSelection(plan), { validationPlan: plan }).filter(
        (entry) => entry.id === "repository-lint",
      ),
    );
  }
  for (const file of ["docs/QUALITY.md", "Cargo.toml"])
    assert.equal(baselineLintPlan(make([file]))[0]?.id, "oxfmt", file);
  for (const file of [
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

void test("first pushes and missing historical bases retain full lint without changed-file entries", () => {
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
    if (args[0] === "cat-file" && args[2]?.startsWith("a".repeat(40)))
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
void test("unknown ownership executes the canonical static group exactly once", () => {
  const plan = make(["unknown/input.bin"]);
  const commands = buildPlan(baselineSelection(plan), { validationPlan: plan });
  assert.equal(commands.filter((entry) => entry.args.includes("frontend:static")).length, 1);
});
void test("Playnite and handoff repairs select their cheap regressions in ordinary CI", () => {
  const tests = baselineContractTests(
    make(["integrations/playnite/check.ps1", "scripts/handoff-evidence.mts"]),
  );
  assert.ok(tests.includes("integrations/playnite/lifecycle-check.test.mts"));
  assert.ok(tests.includes("scripts/handoff-evidence.test.mts"));
});
void test("bootstrap regressions are limited to infrastructure, including old rename paths", () => {
  assert.deepEqual(baselineBootstrapTests(make(["crates/portcove-core/src/lib.rs"])), []);
  assert.deepEqual(baselineBootstrapTests(make([".github/workflows/ci.yml"])), [
    "scripts/rust-support-cache.test.mts",
  ]);
  const renamed = make(["scripts/new-runner.mjs"]);
  assert.ok(renamed.changes[0]);
  renamed.changes[0].oldPath = "scripts/run-rust-tests.mts";
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
  assert.deepEqual(baselineBootstrapTests(plan), ["scripts/rust-support-cache.test.mts"]);
});
void test("hosted contracts retain relevant script/docs/schema tests without stateful qualification", () => {
  const p = make(["scripts/run-rust-tests.mts", "docs/QUALITY.md"]);
  const tests = baselineContractTests(p);
  for (const file of [
    "scripts/run-rust-tests.test.mts",
    "scripts/heavy-rust-test-lock.test.mts",
    "scripts/repository-settings.test.mts",
  ])
    assert.ok(tests.includes(file));
  assert.ok(!tests.includes("scripts/windows-qualification-session.integration.test.mts"));
});

void test("release run evidence contracts are selected for implementation and test changes", () => {
  for (const changed of [
    "scripts/release-run-evidence.mts",
    "scripts/release-run-evidence.test.mts",
  ]) {
    const plan = make([changed]);
    assert.ok(plan.areas.includes("release-security"));
    assert.ok(plan.groups.includes("catalog"));
    assert.ok(baselineContractTests(plan).includes("scripts/release-run-evidence.test.mts"));
  }
});
void test("payload signer and held caller changes preserve release security and both connected contracts", () => {
  for (const file of [
    "scripts/release-payload-signing.mts",
    "scripts/release-payload-preparation.mts",
    "docs/qualification/application-update-production.payload-signing.yml",
    "docs/qualification/application-update-production.aggregate.yml",
  ]) {
    const plan = make([file]);
    assert.ok(plan.areas.includes("release-security"), file);
    const tests = baselineContractTests(plan);
    assert.ok(tests.includes("scripts/release-payload-signing.test.mts"), file);
    assert.ok(tests.includes("scripts/release-payload-preparation.test.mts"), file);
    const local = classifyChanges([{ status: "M", path: file }]);
    assert.ok(local.nodeTests.has("scripts/release-payload-signing.test.mts"), file);
    assert.ok(local.nodeTests.has("scripts/release-payload-preparation.test.mts"), file);
  }
});
void test("shared and unknown frontend inputs use full units; sources use the related graph", () => {
  const related = baselineFrontendPlan(make(["apps/desktop/src/App.tsx"]));
  assert.ok(
    related.findIndex((entry) => entry.id === "ui-content") <
      related.findIndex((entry) => entry.id === "ui-build"),
  );
  assert.ok(related.some((entry) => entry.id === "ui-related-tests"));
  const selected = related.find((entry) => entry.id === "ui-related-tests");
  assert.ok(selected);
  assert.deepEqual(selected.args.slice(0, 2), ["scripts/run-ui-tests.mts", "related"]);
  for (const p of [make(["apps/desktop/tsconfig.json"]), make(["unknown/new-input.bin"])]) {
    const full = baselineFrontendPlan(p);
    assert.ok(full.some((entry) => entry.id === "ui-tests"));
    assert.ok(!full.some((entry) => entry.id === "ui-related-tests"));
  }
  assert.throws(() => baselineFrontendPlan(make(["docs/QUALITY.md"])));
});

void test("selected contract tests retain cheap actual-checkout integrity", () => {
  const catalog = baselineIntegrityCommands(make(["crates/portcove-core/catalog/catalog.json"]));
  assert.ok(
    catalog.some((args) => args[0] === "scripts/generate-catalog.mts" && args[1] === "--check"),
  );
  assert.ok(
    catalog.some(
      (args) => args[0] === "scripts/check-retcomm-upstreams.mts" && args[1] === "--offline",
    ),
  );
  const docs = baselineIntegrityCommands(make(["docs/QUALITY.md"]));
  assert.ok(
    docs.some((args) => args[0] === "scripts/repository-settings.mts" && args[1] === "--validate"),
  );
  assert.ok(!docs.some((args) => args[0] === "scripts/generate-catalog.mts"));
});

void test("fixture subprocess timings cannot contaminate the hosted batch report", (t) => {
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
        'import {createCiMetrics} from "./scripts/ci-metrics.mts"; createCiMetrics().record("synthetic-failed-phase", {outcome:"failed"});',
      ],
      { cwd: new URL("..", import.meta.url), env: isolated, encoding: "utf8" },
    ),
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readdirSync(directory).length, 1, "only actual parent batch diagnostics survive");
});

void test("ordinary selected checking retains CSS correctness", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.ok(isRecord(manifest) && isRecord(manifest.scripts));
  assert.equal(manifest.scripts.check, "vp run frontend:static");
  assert.match(
    readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8"),
    /vp -C apps\/desktop run lint:style/u,
  );
  assert.deepEqual(baselineLintPlan(make(["apps/desktop/src/app.css"]))[0]?.args, [
    "scripts/run-viteplus.mts",
    "run",
    "frontend:static",
  ]);
});

void test("Python is provisioned for the effective TOML positive contracts, not ordinary prose", () => {
  assert.equal(baselineRequiresPython(make(["scripts/nextest-equivalence.mts"])), true);
  assert.equal(baselineRequiresPython(make(["scripts/ci-workflow.test.mts"])), true);
  assert.equal(baselineRequiresPython(make(["docs/QUALITY.md"])), false);
});

void test("desktop runner selects the same complete contract union in local and hosted production plans", () => {
  const file = "apps/desktop/scripts/desktop-test.mts";
  const expected = [
    "scripts/desktop-execution-plan.test.mts",
    "scripts/desktop-scenarios.test.mts",
    "scripts/desktop-verify.test.mts",
    "scripts/frontend-command-preflight.test.mts",
    "scripts/native-helper-dependencies.test.mts",
    "scripts/windows-helper-checks.test.mts",
    "scripts/development-evidence.test.mts",
    "scripts/native-session-lock.test.mts",
  ];
  const changes = [
    { status: "M", path: file },
    { status: "D", path: file },
    { status: "R100", path: "apps/desktop/scripts/renamed.mts", previousPath: file },
  ];
  for (const change of changes) {
    const local = classifyChanges([change], { fileExists: () => false });
    // Classification is shared, while Windows execution remains independently selected.
    const hosted = buildValidationPlan({
      changes: [
        {
          status: change.status,
          oldPath: file,
          newPath: change.path,
          oldMode: "100644",
          newMode: change.status === "D" ? "000000" : "100644",
        },
      ],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    const actualHosted = baselineContractTests(hosted, { fileExists: () => false });
    for (const name of expected) {
      assert.ok(local.nodeTests.has(name), `${change.status}: local ${name}`);
      assert.ok(actualHosted.includes(name), `hosted ${name}`);
    }
    const command = buildPlan(local).find((entry) => entry.id === "node-tests");
    assert.ok(command);
    for (const name of expected) assert.ok(command.args.includes(name), `execution: ${name}`);
    assert.equal(windowsHelperChecksRequired(hosted), true);
    assert.equal(local.workspaceRust, false);
  }
});

void test("semantic helper-only changes retain their actual broker consumer locally and hosted", () => {
  for (const name of ["reader", "reader-core", "reader-server", "runtime", "inputs"]) {
    const file = `scripts/release-semantic-${name}.mts`;
    for (const change of [
      { status: "M", path: file },
      { status: "D", path: file },
      { status: "R100", path: "scripts/moved-helper.mts", previousPath: file },
      { status: "R100", previousPath: "scripts/moved-helper.mts", path: file },
    ]) {
      const local = classifyChanges([change], { fileExists: () => false });
      assert.ok(
        local.nodeTests.has("scripts/release-semantic-broker.test.mts"),
        JSON.stringify(change),
      );
      const plan = buildValidationPlan({
        changes: [
          {
            status: change.status,
            oldPath: change.previousPath ?? change.path,
            newPath: change.path,
            oldMode: "100644",
            newMode: change.status === "D" ? "000000" : "100644",
          },
        ],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      assert.ok(plan.areas.includes("release-security"));
      assert.ok(
        baselineContractTests(plan, { fileExists: () => false }).includes(
          "scripts/release-semantic-broker.test.mts",
        ),
      );
    }
  }
  assert.ok(
    !classifyChanges([{ status: "M", path: "scripts/ui-test-selection.mts" }]).nodeTests.has(
      "scripts/release-semantic-broker.test.mts",
    ),
  );
});

void test("fixed controller bootstrap and shared attestation verifier retain protected release ownership", () => {
  for (const file of [
    "scripts/release-controller-tool-build.mts",
    "scripts/qualify-controller-tool-build.mts",
    ".github/workflows/controller-tool-build-fixture.yml",
    "scripts/release-controller-tools.mts",
    "scripts/release-controller-tool-admission.mts",
    "scripts/release-controller-tool-bootstrap.mts",
    "scripts/github-controller-attestation.mts",
    "docs/qualification/application-update-production.controller-tools.yml",
  ]) {
    const plan = make([file]);
    assert.ok(plan.areas.includes("release-security"), file);
    assert.ok(
      baselineContractTests(plan).includes("scripts/release-controller-tools.test.mts"),
      file,
    );
    assert.ok(
      classifyChanges([{ status: "M", path: file }]).nodeTests.has(
        "scripts/release-controller-tools.test.mts",
      ),
      file,
    );
  }
});
