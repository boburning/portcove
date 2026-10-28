import { readWorkflow } from "./ci-workflow-fixture.mts";
import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { vitePlusCommand } from "./viteplus-cli.mts";
import { createBrowserTraceRun } from "./browser-traces.ts";
import { isRecord } from "./runtime-values.mts";

import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { parseDocument } from "yaml";
import { spawnSync } from "node:child_process";

import os from "node:os";
import path from "node:path";

import { AUDIT_STAGES } from "./audit.mts";

import {
  requiredFixture,
  workflow,
  workflowJob,
  workflowJobSource,
  workflowStep,
  rustQuality,
  frontend,
  dependencyReview,
} from "./ci-workflow-fixture.mts";

function resolveBrowserUpload(config: unknown, action: unknown, id: string) {
  assert.ok(isRecord(config) && isRecord(config.jobs));
  const job = config.jobs[id];
  assert.ok(isRecord(job) && Array.isArray(job.steps));
  const callers: unknown[] = job.steps.filter(
    (step: unknown) =>
      isRecord(step) && step.uses === "./.github/actions/retain-browser-diagnostics",
  );
  assert.equal(callers.length, 1, `${id} has one browser uploader`);
  const caller = callers[0];
  assert.ok(isRecord(caller) && isRecord(caller.with));
  assert.deepEqual(Object.keys(caller.with), ["name"]);
  assert.ok(isRecord(action) && isRecord(action.runs));
  assert.equal(action.runs.using, "composite");
  assert.ok(Array.isArray(action.runs.steps) && action.runs.steps.length === 1);
  const child: unknown = action.runs.steps[0];
  assert.ok(isRecord(child) && isRecord(child.with));
  assert.equal(child.if, "always()", "failure callers must enter the uploader child");
  assert.equal(child.with.name, "${{ inputs.name }}");
  const withValues: Record<string, unknown> = { ...child.with, name: caller.with.name };
  return {
    name: caller.name,
    if: caller.if,
    uses: child.uses,
    with: withValues,
  };
}

async function browserUploadConfiguration() {
  const action = parseDocument(
    await readWorkflow(
      new URL("../.github/actions/retain-browser-diagnostics/action.yml", import.meta.url),
    ),
    { uniqueKeys: true },
  );
  assert.deepEqual(action.errors, []);
  const config = parseDocument(workflow, { uniqueKeys: true });
  assert.deepEqual(config.errors, []);
  return { config: config.toJS() as unknown, action: action.toJS() as unknown };
}

void test("shared browser uploader preserves the original three caller contracts structurally", async () => {
  const { config, action } = await browserUploadConfiguration();
  const baseline: unknown = JSON.parse(
    await readFile(new URL("./fixtures/browser-upload-baseline.json", import.meta.url), "utf8"),
  );
  assert.ok(isRecord(baseline) && Array.isArray(baseline.rows));
  assert.equal(baseline.rows.length, 3);
  for (const row of baseline.rows) {
    assert.ok(isRecord(row) && typeof row.job === "string");
    assert.deepEqual(resolveBrowserUpload(config, action, row.job), row.step);
  }
  // Equivalent YAML layout is accepted; semantic changes must fail the oracle.
  const roundTrip: unknown = JSON.parse(JSON.stringify(config));
  assert.deepEqual(
    resolveBrowserUpload(roundTrip, action, "fast_frontend"),
    resolveBrowserUpload(config, action, "fast_frontend"),
  );
  for (const [section, key, value] of [
    ["child", "if", "success()"],
    ["child", "uses", "actions/upload-artifact@changed"],
    ["with", "path", "work/bt/**/*.trace.zip\n"],
    ["caller", "if", "success()"],
    ["callerWith", "name", "foreign-artifact"],
  ] as const) {
    const changedConfig: unknown = structuredClone(config),
      changedAction: unknown = structuredClone(action);
    assert.ok(isRecord(changedConfig) && isRecord(changedConfig.jobs));
    const job = changedConfig.jobs.fast_frontend;
    assert.ok(isRecord(job) && Array.isArray(job.steps));
    const caller: unknown = job.steps.find(
      (step: unknown) =>
        isRecord(step) && step.uses === "./.github/actions/retain-browser-diagnostics",
    );
    assert.ok(isRecord(caller) && isRecord(caller.with));
    assert.ok(
      isRecord(changedAction) &&
        isRecord(changedAction.runs) &&
        Array.isArray(changedAction.runs.steps),
    );
    const child: unknown = changedAction.runs.steps[0];
    assert.ok(isRecord(child) && isRecord(child.with));
    const target =
      section === "child"
        ? child
        : section === "with"
          ? child.with
          : section === "caller"
            ? caller
            : caller.with;
    target[key] = value;
    assert.throws(() =>
      assert.deepEqual(
        resolveBrowserUpload(changedConfig, changedAction, "fast_frontend"),
        resolveBrowserUpload(config, action, "fast_frontend"),
      ),
    );
  }
});

void test("Fallow execution provisions its pinned process-custody compiler before analysis", () => {
  const job = workflowJob("frontend_full");
  assert.ok(Array.isArray(job.steps));
  const steps: unknown[] = job.steps;
  const compiler = steps.findIndex(
    (step) => isRecord(step) && step.uses === "./.github/actions/setup-rust",
  );
  const analyzer = steps.findIndex(
    (step) => isRecord(step) && step.run === "node scripts/run-fallow.mts",
  );
  assert.ok(compiler >= 0 && analyzer > compiler);
});

void test("screenshot-only diagnostic is manual, preserves failure guards and verifies all attempt packets", async () => {
  const document = parseDocument(
    await readWorkflow(
      new URL("../.github/workflows/browser-artifact-custody.yml", import.meta.url),
    ),
    { uniqueKeys: true },
  );
  assert.deepEqual(document.errors, []);
  const config: unknown = document.toJS();
  assert.ok(isRecord(config) && isRecord(config.on) && isRecord(config.jobs));
  assert.deepEqual(Object.keys(config.on), ["workflow_dispatch"]);
  assert.deepEqual(config.permissions, { contents: "read" });
  const probe = config.jobs["screenshot-only"],
    verify = config.jobs.verify;
  assert.ok(
    isRecord(probe) &&
      isRecord(probe.strategy) &&
      isRecord(probe.strategy.matrix) &&
      Array.isArray(probe.steps),
  );
  assert.deepEqual(probe.strategy.matrix.route, ["fast", "full", "contributor"]);
  assert.equal(probe.strategy["fail-fast"], false);
  assert.equal(probe["continue-on-error"], true);
  assert.equal(probe["timeout-minutes"], 15);
  assert.ok(
    probe.steps.every(
      (step: unknown) => isRecord(step) && !Object.hasOwn(step, "continue-on-error"),
    ),
  );
  const failure: unknown = probe.steps.find(
    (step: unknown) => isRecord(step) && step.name === "Intentional screenshot-only failure",
  );
  const upload: unknown = probe.steps.find(
    (step: unknown) => isRecord(step) && step.name === "Retain screenshot-only diagnostics",
  );
  assert.ok(isRecord(failure) && isRecord(upload));
  assert.equal(
    failure.run,
    'node apps/desktop/scripts/browser-runtime.mts screenshot-only "$PROBE_ROUTE"',
  );
  assert.equal(upload.uses, "./.github/actions/retain-browser-diagnostics");
  assert.equal(
    upload.if,
    "(matrix.route != 'contributor' && always()) || (matrix.route == 'contributor' && failure())",
  );
  assert.deepEqual(upload.with, {
    name: "browser-traces-${{ matrix.route }}-${{ github.run_id }}-${{ github.run_attempt }}",
  });
  assert.ok(isRecord(verify) && Array.isArray(verify.steps));
  assert.equal(verify.needs, "screenshot-only");
  assert.equal(verify.if, "always()");
  assert.deepEqual(verify.permissions, { contents: "read", actions: "read" });
  assert.ok(!Object.hasOwn(verify, "continue-on-error"));
  const final: unknown = verify.steps.find(
    (step: unknown) =>
      isRecord(step) && step.name === "Verify all three packets and original step outcomes",
  );
  assert.ok(isRecord(final) && typeof final.run === "string");
  assert.match(final.run, /attempts\/\$GITHUB_RUN_ATTEMPT\/jobs\?per_page=100/u);
  assert.match(
    final.run,
    /browser-runtime\.mts verify-screenshot-only work\/downloaded-browser-custody/u,
  );
});

void test("selective Fallow workflow has compiler custody and outer timeout headroom", async () => {
  const text = await readWorkflow(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
  );
  const config: unknown = parseDocument(text, { uniqueKeys: true }).toJS();
  assert.ok(isRecord(config) && isRecord(config.jobs));
  const job = config.jobs.fallow_analysis;
  assert.ok(isRecord(job) && Array.isArray(job.steps));
  const steps: unknown[] = job.steps;
  const compiler = steps.findIndex(
    (step) => isRecord(step) && step.uses === "./.github/actions/setup-rust",
  );
  const analyzer = steps.findIndex(
    (step) =>
      isRecord(step) &&
      typeof step.run === "string" &&
      step.run.includes("node scripts/run-fallow.mts"),
  );
  assert.ok(compiler >= 0 && analyzer > compiler);
  assert.ok(typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] > 21);
});

void test("maintained first-party sources default to checked TypeScript", () => {
  const inventory = spawnSync("git", ["ls-files", "-z", "--", "*.js", "*.jsx", "*.mjs", "*.cjs"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.deepEqual(inventory.stdout.split("\0").filter(Boolean).sort(), [
    "apps/desktop/public/theme-bootstrap.js",
    "apps/desktop/stylelint.config.mjs",
  ]);
});

void test("selected full Fallow runs once before browser work and retains successful evidence", async () => {
  const full = workflowJobSource(workflow, "frontend_full");
  assert.equal(full.match(/run: node scripts\/run-fallow\.mts/g)?.length, 1);
  assert.ok(full.indexOf("run-fallow.mts") < full.indexOf("pnpm browser:bootstrap"));
  const owner = workflowJob("frontend_full");
  assert.ok(Array.isArray(owner.steps));
  const uploader: unknown = owner.steps.find(
    (step: unknown) => isRecord(step) && step.name === "Retain original Fallow reports",
  );
  assert.ok(isRecord(uploader) && isRecord(uploader.with));
  assert.equal(uploader.if, "always()");
  assert.equal(uploader.with.path, "work/fallow-reports/");
  assert.match(String(uploader.with.name), /^fallow-full-/u);
  assert.equal(uploader.with["retention-days"], 7);
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  const check = requiredFixture(requiredFixture(recipes.split("\nui-check:")[1]).split(/\n\S/)[0]);
  assert.equal(check.match(/run-fallow\.mts/g)?.length, 1);
  assert.ok(check.indexOf("run-fallow.mts") < check.indexOf("frontend:verify"));
  const runtime = requiredFixture(
    requiredFixture(recipes.split("\nui-runtime:")[1]).split(/\n\S/)[0],
  );
  assert.doesNotMatch(runtime, /run-fallow/);
  assert.equal(AUDIT_STAGES.filter((stage) => stage.recipe === "fallow").length, 1);
  // The graph's generated transport inputs ship in Git; tests/builds are not
  // prerequisites of static analysis in a fresh checkout.
  for (const name of [
    "transport-types.generated.d.ts",
    "transport-input-types.generated.d.ts",
    "transport-schemas.generated.json",
  ])
    assert.ok((await readFile(new URL(`../apps/desktop/src/${name}`, import.meta.url))).length > 0);
});

void test("manual Fallow assistance is isolated from exhaustive audit and retains originals", async () => {
  const deep = await readWorkflow(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
  );
  const selected = workflowJobSource(deep, "fallow_analysis");
  assert.match(selected, /if: inputs.operation == 'fallow'/);
  assert.match(selected, /fetch-depth: 0/);
  assert.match(selected, /node scripts\/run-fallow\.mts review "\$COMPARISON_BASE"/);
  assert.match(selected, /if: always\(\)/);
  assert.match(selected, /path: work\/fallow-reports\//);
  assert.match(selected, /uses: \.\/\.github\/actions\/setup-rust/);
  assert.doesNotMatch(selected, /browser:bootstrap|just audit/);
  assert.match(deep, /if: inputs.operation != 'local-check' && inputs.operation != 'fallow'/);
  assert.match(
    deep,
    /inputs.operation == 'fallow' && format\('fallow-\{0\}', github.run_id\) \|\| format\('deep-quality-\{0\}', github.ref\)/,
  );
});

void test("native frontend harness retains the qualified Linux target and a failing namespace preflight", () => {
  const block = workflowJobSource(workflow, "frontend_full");
  assert.match(block, /runs-on: ubuntu-22\.04/u);
  assert.match(
    block,
    /unshare --user --map-current-user --mount --pid --fork --mount-proc \/usr\/bin\/true/u,
  );
  assert.match(block, /scripts\/desktop-linux-native-session\.test\.mts/u);
  assert.doesNotMatch(block, /continue-on-error:|sysctl\s+-|apparmor_parser\s/u);
  const native = workflowStep("frontend_full", "Test native compiler and shell integrations");
  assert.equal(native["working-directory"], ".");
  assert.equal(native.run, "node scripts/run-viteplus.mts run native:tools");
});

void test("full frontend qualification retains native scenario contracts; ordinary CI uses selected units", () => {
  const full = workflowJobSource(workflow, "frontend_full");
  const fast = workflowJobSource(workflow, "fast_frontend");
  assert.match(full, /desktop-scenarios\.test\.mts/);
  assert.match(full, /--context-preflight/);
  assert.match(fast, /ci-baseline\.mts frontend/);
  assert.doesNotMatch(fast, /desktop-preparation-test|test:browser|run-fallow/);
});

void test("ordinary formatting and lint have one quality owner; deep analyzers stay in qualification", () => {
  const formatting = workflowJobSource(workflow, "fast_rust_quality");
  assert.match(formatting, /frontend_tools == 'true'/);
  assert.doesNotMatch(formatting, /format:check/);
  assert.match(formatting, /cargo fmt/);
  assert.match(formatting, /node scripts\/ci-baseline\.mts lint/);
  assert.match(formatting, /PORTCOVE_PLAN_GZIP_BASE64:/);
  assert.match(formatting, /PORTCOVE_CI_METRICS_DIR:/);
  assert.match(formatting, /ci-metrics\.mts summarize/);
  assert.doesNotMatch(formatting, /cargo clippy|lint:oxlint|run-fallow/);
  const frontend = workflowJobSource(workflow, "fast_frontend");
  assert.doesNotMatch(frontend, /format:check|pnpm lint/);
});

void test("frontend keeps deterministic product gates and delegates vulnerability changes", () => {
  const owner = workflowJob("frontend_full");
  assert.ok(isRecord(owner.env) && Array.isArray(owner.steps));
  assert.equal(owner.env.npm_config_audit, "false");
  const installStep = owner.steps.findIndex(
    (step: unknown) =>
      isRecord(step) && isRecord(step.with) && typeof step.with["run-install"] === "string",
  );
  const installOwner: unknown = owner.steps[installStep];
  assert.ok(
    isRecord(installOwner) &&
      isRecord(installOwner.with) &&
      typeof installOwner.with["run-install"] === "string",
  );
  assert.deepEqual(parseDocument(installOwner.with["run-install"]).toJS(), {
    args: ["--frozen-lockfile"],
  });
  assert.match(frontend, /Install pinned recipe runner/);
  const verify = owner.steps.findIndex(
    (step: unknown) =>
      isRecord(step) && step.run === "node scripts/run-viteplus.mts run frontend:verify",
  );
  assert.ok(installStep >= 0 && verify > installStep);
  assert.equal(frontend.match(/run frontend:verify/g)?.length, 1);
  assert.match(frontend, /lint-tools\.integration\.mts oxfmt oxlint stylelint/);
  assert.match(
    frontend,
    /--test-name-pattern "pnpm uses\|direct just recipes" scripts\/dev-storage\.test\.mts/,
  );
  assert.doesNotMatch(frontend, /run: pnpm (?:build|test|check)\b/);
  assert.match(frontend, /run-fallow\.mts/);
  assert.doesNotMatch(frontend, /pnpm audit/);
  assert.doesNotMatch(frontend, /continue-on-error/);

  assert.match(dependencyReview, /github\.event_name == 'pull_request'/);
  assert.match(dependencyReview, /dependency-review-action/);
  assert.match(dependencyReview, /fail-on-severity: high/);
});

void test("full frontend qualification provisions browser artifacts before composition", async () => {
  const full = workflowJobSource(workflow, "frontend_full");
  const provision = full.indexOf("pnpm browser:bootstrap"),
    run = full.indexOf("run frontend:verify");
  assert.ok(provision >= 0 && run > provision);
  assert.match(full, /browser-traces-full/);
  assert.doesNotMatch(full, /work\/browser-traces/);
  const fast = workflowJobSource(workflow, "fast_frontend");
  assert.match(fast, /browser-runtime.mts bootstrap/);
  const contributor = workflowJobSource(workflow, "frontend_portability");
  const contributorProvision = contributor.indexOf("pnpm --dir apps/desktop browser:bootstrap");
  assert.ok(contributorProvision >= 0);
  assert.ok(contributor.indexOf("pnpm verify:frontend") > contributorProvision);
  assert.equal(contributor.match(/run: pnpm verify:frontend/g)?.length, 1);
  assert.doesNotMatch(contributor, /run: pnpm (?:test|check|build)\b/);
  const deep = await readWorkflow(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
  );
  const audit = workflowJobSource(deep, "audit");
  const install = audit.indexOf("run: pnpm install --frozen-lockfile");
  const auditGates = audit.indexOf("name: Run deterministic gates and structural audit");
  assert.ok(install >= 0 && auditGates > install);
  // Deep audit starts Fallow before runtime/browser provisioning. The runtime
  // recipe owns browser prerequisites, so this does not select a second scan.
  assert.doesNotMatch(audit, /run: pnpm --dir apps\/desktop browser:bootstrap/);
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  const runtime = requiredFixture(
    requiredFixture(recipes.split("\nui-runtime:")[1]).split(/\n\S/)[0],
  );
  assert.ok(runtime.indexOf("run browser:bootstrap") < runtime.indexOf("run frontend:runtime"));
  assert.equal(requiredFixture(AUDIT_STAGES[0]).id, "fallow");
  const { config, action } = await browserUploadConfiguration();
  for (const [name, id] of [
    ["full", "frontend_full"],
    ["fast", "fast_frontend"],
    ["contributor", "frontend_portability"],
  ] as const) {
    const step = resolveBrowserUpload(config, action, id);
    assert.equal(step.if, name === "contributor" ? "failure()" : "always()");
    assert.match(String(step.with.name), new RegExp(`^browser-traces-${name}-`));
    assert.ok(typeof step.with.path === "string");
    const upload = step.with.path;
    if (name !== "contributor") {
      for (const retained of [
        ".vitest/attachments/**/*.json",
        "apps/desktop/.vitest/attachments/**/*.json",
        "outputs/slice5-cards/**/*.png",
      ])
        assert.ok(
          upload.includes(retained),
          `${name} retains successful capture metadata and images`,
        );
    }
    assert.match(upload, /work\/bt\/\*\*\/\*\.trace\.zip/);
    assert.match(upload, /\.vitest\/attachments\/failure-screenshots\/\*\*\/\*\.png/);
    assert.equal(step.with["include-hidden-files"], true);
    assert.equal(step.with["retention-days"], 7);
    assert.doesNotMatch(upload, /^ +work\/bt\r?$/m);
  }
});

void test("browser uploads select the actual trace and screenshot output layout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-browser-upload-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = createBrowserTraceRun(root);
  await mkdir(run.screenshotDirectory, { recursive: true });
  const trace = path.join(run.directory, "failure.trace.zip");
  const screenshot = path.join(run.screenshotDirectory, "failure.png");
  await writeFile(trace, "owned layout fixture, not an executed browser trace");
  await writeFile(screenshot, "owned screenshot layout fixture");
  const files = [trace, screenshot].map((file) => path.relative(root, file).replaceAll("\\", "/"));
  const producer = new URL(
    "../apps/desktop/src/components/CatalogDownload.browser.test.tsx",
    import.meta.url,
  );
  const producerSource = await readFile(producer, "utf8");
  const checkout = fileURLToPath(new URL("../", import.meta.url));
  const producerOutputs = [...producerSource.matchAll(/path: "([^"\n]+\.png)"/gu)].map((match) => {
    const output = path.resolve(path.dirname(fileURLToPath(producer)), match[1]!);
    const relative = path.relative(checkout, output).replaceAll("\\", "/");
    assert.ok(!relative.startsWith("../") && !path.isAbsolute(relative));
    return relative;
  });
  assert.equal(producerOutputs.length, 3, "retain the current rendered installation captures");
  const directories = new Set<string>();
  for (const file of globSync("apps/desktop/src/**/*.browser.test.{ts,tsx}", { cwd: checkout })) {
    const source = await readFile(path.join(checkout, file), "utf8");
    for (const match of source.matchAll(/(?:\.\.\/)+(?:work|outputs)\/[A-Za-z0-9._-]+\//gu)) {
      const directory = path.resolve(checkout, path.dirname(file), match[0]);
      const relative = path.relative(checkout, directory).replaceAll("\\", "/");
      assert.ok(!relative.startsWith("../") && !path.isAbsolute(relative), file);
      directories.add(relative);
    }
  }
  assert.ok(directories.size > 0, "discover current explicit browser output directories");
  const additional = [
    ".vitest/attachments/failure-screenshots/fixture.png",
    "apps/desktop/.vitest/attachments/failure-screenshots/fixture.png",
    ".vitest/attachments/capture-target/fixture.json",
    "apps/desktop/.vitest/attachments/capture-target/fixture.json",
    "outputs/slice5-cards/fixture.png",
    ...producerOutputs,
    ...[...directories].map((directory) => `${directory}/fixture.png`),
  ];
  for (const file of additional) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), `inert upload fixture: ${file}\n`);
  }
  const expected = new Map(
    await Promise.all(
      [...files, ...additional].map(
        async (file) =>
          [
            file,
            createHash("sha256")
              .update(await readFile(path.join(root, file)))
              .digest("hex"),
          ] as const,
      ),
    ),
  );
  const { config, action } = await browserUploadConfiguration();
  for (const id of ["fast_frontend", "frontend_full", "frontend_portability"]) {
    const upload = resolveBrowserUpload(config, action, id);
    assert.ok(typeof upload.with.path === "string");
    const patterns = upload.with.path
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    assert.equal(upload.with["include-hidden-files"], true, id);
    const resolve = (selection: readonly string[]) =>
      new Set(globSync([...selection], { cwd: root }).map((file) => file.replaceAll("\\", "/")));
    const selected = resolve(patterns);
    for (const [file, digest] of expected) {
      assert.ok(selected.has(file), `${id} does not select actual fixture output ${file}`);
      assert.equal(
        createHash("sha256")
          .update(await readFile(path.join(root, file)))
          .digest("hex"),
        digest,
        `${id} preserves selected bytes: ${file}`,
      );
    }
    const renamed = producerOutputs.map((file) => file.replace("installation-rendered/", "moved/"));
    for (const file of renamed) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "inert renamed producer output\n");
    }
    assert.ok(
      renamed.every((file) => !resolve(patterns).has(file)),
      `${id} would detect a producer directory move without uploader repair`,
    );
    for (const file of files)
      assert.ok(
        patterns.some((pattern) => path.posix.matchesGlob(file, pattern)),
        `${id} does not upload the actual output ${file}`,
      );
    const withoutScreenshots = patterns.filter(
      (pattern) => !path.posix.matchesGlob(files[1]!, pattern),
    );
    assert.ok(withoutScreenshots.some((pattern) => path.posix.matchesGlob(files[0]!, pattern)));
    assert.ok(!withoutScreenshots.some((pattern) => path.posix.matchesGlob(files[1]!, pattern)));
  }
});

for (const closeFails of [false, true]) {
  void test(`a passing run retains raw traces after ${closeFails ? "failed" : "successful"} pool shutdown`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-browser-close-control-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const run = createBrowserTraceRun(root);
    const { createVitest } = await import("vite-plus/test/node");
    const runner = await createVitest({
      root,
      config: false,
      watch: false,
      reporters: [run.reporter],
    });
    const originalExitCode = process.exitCode;
    const originalLogger = runner.logger.error;
    const diagnostics: unknown[][] = [];
    runner.logger.error = (...args: unknown[]) => {
      diagnostics.push(args);
    };
    try {
      await runner.standalone();
      await mkdir(run.directory, { recursive: true });
      const raw = path.join(run.directory, "provider.trace");
      await writeFile(raw, "pending browser trace");
      await run.reporter.onTestRunEnd?.([], [], "passed");
      const failure = new Error("owned pool-close failure control");
      let closed = false;
      // Fault injection uses the pinned runner's real close implementation.
      // Its pool is private; production code never replaces or observes it.
      Reflect.set(runner, "pool", {
        async close() {
          assert.equal(await readFile(raw, "utf8"), "pending browser trace");
          await writeFile(raw, "browser shutdown flushed its final trace chunk");
          closed = true;
          if (closeFails) throw failure;
        },
      });
      await runner.close();
      assert.equal(closed, true);
      if (closeFails) {
        assert.equal(process.exitCode, 1);
        assert.ok(diagnostics.some((args) => args.includes(failure)));
      } else {
        assert.equal(process.exitCode, originalExitCode);
        assert.deepEqual(diagnostics, []);
      }
      assert.equal(await readFile(raw, "utf8"), "browser shutdown flushed its final trace chunk");
    } finally {
      await runner.close();
      runner.logger.error = originalLogger;
      process.exitCode = originalExitCode;
    }
  });
}

void test("native recovery and Unix custody changes retain macOS no-global portability coverage", () => {
  const job = workflowJob("frontend_portability");
  assert.equal(job["runs-on"], "macos-26");
  assert.ok(typeof job.if === "string");
  const ordinaryInputs = Array.from(
    job.if.matchAll(/contains\(needs\.classify\.outputs\.files_json, '([^']+)'\)/gu),
    (match) => match[1],
  );
  assert.deepEqual(
    new Set(ordinaryInputs),
    new Set([
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
    ]),
  );
});

void test("frontend tools resolve through the pinned Vite+ bundle", async () => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.ok(isRecord(manifest) && isRecord(manifest.devDependencies) && isRecord(manifest.scripts));
  assert.equal(manifest.devDependencies["vite-plus"], "catalog:");
  for (const superseded of ["oxfmt", "oxlint", "oxlint-tsgolint", "husky", "lint-staged"])
    assert.equal(manifest.devDependencies[superseded], undefined);
  assert.equal(manifest.scripts.check, "vp run frontend:static");
  const configuration = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(configuration, /browser-package-compatibility.mts/);
  assert.match(configuration, /vp -C apps\/desktop run lint:style/);
  assert.match(configuration, /generate-transport-types.mts/);
  assert.match(configuration, /check-transport-contract.mts --ipc-only/);
  assert.equal(manifest.scripts.build, "node apps/desktop/scripts/build-frontend.mts");
});

void test("full frontend tests retain fresh unit and browser stages", async () => {
  const { default: configuration } = await import("../vite.config.ts");
  const tasks = requiredFixture(configuration.run?.tasks);
  assert.deepEqual(tasks["frontend:tests"], {
    command: ["vp run frontend:unit", "vp run frontend:browser"],
    cache: false,
  });
  const runtime = tasks["frontend:runtime"];
  assert.ok(isRecord(runtime));
  assert.deepEqual(runtime.command, [
    "vp run frontend:content",
    "vp run frontend:tests",
    "vp run frontend:build",
  ]);
  assert.equal(runtime.cache, false);
});

void test("routine checks retain architecture enforcement but make cycles optional", async () => {
  assert.doesNotMatch(rustQuality, /cargo modules/);
  assert.match(rustQuality, /node scripts\/check-rust-architecture\.mts/);
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  assert.match(
    recipes,
    /^audit \*args:\r?\n\s+\{\{storage\}\} node scripts\/audit\.mts \{\{args\}\}$/m,
  );
  assert.match(recipes, /^cycles:\r?\n.*cargo modules/m);
});

void test("full frontend tasks stop after a failed unit stage and propagate browser failures", async (t) => {
  const { default: configuration } = await import("../vite.config.ts");
  const parent = await mkdtemp(path.join(os.tmpdir(), "portcove-frontend-task-gate-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  // A synthetic parent catches accidental execution of a contributor's real tasks.
  await writeFile(path.join(parent, "package.json"), '{"private":true,"type":"module"}');
  await writeFile(path.join(parent, "pnpm-workspace.yaml"), "packages: []\n");
  await writeFile(path.join(parent, "foreign.mjs"), "process.exit(97);\n");
  const executable = JSON.stringify(process.execPath.replaceAll("\\", "/"));
  await writeFile(
    path.join(parent, "vite.config.ts"),
    `export default ${JSON.stringify({
      run: { tasks: { "frontend:tests": { command: `${executable} foreign.mjs`, cache: false } } },
    })}`,
  );
  const root = path.join(parent, "fixture");
  await mkdir(root);
  await writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  await writeFile(
    path.join(root, "leaf.mjs"),
    `
    import { appendFileSync, readFileSync } from "node:fs";
    const stage = process.argv[2];
    appendFileSync("events.txt", stage + "\\n");
    process.exit(readFileSync("failure.txt", "utf8") === stage ? 17 : 0);
  `,
  );
  await writeFile(
    path.join(root, "vite.config.ts"),
    `export default ${JSON.stringify({
      run: {
        tasks: {
          "frontend:tests": requiredFixture(configuration.run?.tasks)["frontend:tests"],
          "frontend:unit": { command: `${executable} leaf.mjs unit`, cache: false },
          "frontend:browser": { command: `${executable} leaf.mjs browser`, cache: false },
        },
      },
    })}`,
  );
  const cli = vitePlusCommand(fileURLToPath(new URL("../", import.meta.url)));
  for (const failure of ["none", "unit", "browser"]) {
    await writeFile(path.join(root, "failure.txt"), failure);
    await writeFile(path.join(root, "events.txt"), "");
    const result = spawnSync(cli.command, [...cli.args, "-C", root, "run", "frontend:tests"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status === 0, failure === "none", result.stdout + result.stderr);
    assert.equal(
      await readFile(path.join(root, "events.txt"), "utf8"),
      failure === "unit" ? "unit\n" : "unit\nbrowser\n",
    );
  }
});
