import assert from "node:assert/strict";
import { requireNodeTestInventory } from "./node-test-inventory.mts";
import { createBrowserTraceRun } from "./browser-traces.ts";
import { isRecord, errorCode } from "./runtime-values.mts";
import type {
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { readFile, readdir, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { discoverCiPlan, qualificationMatrices, writeGithubOutputs } from "./select-ci-plan.mts";
import { parseDocument } from "yaml";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { encodeHostedEvidence, recoverHostedEvidence } from "./native-backup-evidence.mts";
import { AUDIT_STAGES } from "./audit.mts";

function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "expected fixture or source section is missing");
  return value;
}
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
void test("every CI job has a finite envelope above its declared step limits", () => {
  const settings: unknown = parseDocument(workflow, { uniqueKeys: true }).toJS();
  assert.ok(isRecord(settings) && isRecord(settings.jobs));
  for (const [name, job] of Object.entries(settings.jobs)) {
    assert.ok(isRecord(job), name);
    const budget = job["timeout-minutes"];
    assert.ok(
      typeof budget === "number" && Number.isInteger(budget) && budget > 0 && budget <= 120,
      name,
    );
    if (Array.isArray(job.steps))
      for (const step of job.steps) {
        assert.ok(isRecord(step));
        const limit = step["timeout-minutes"];
        if (limit !== undefined)
          assert.ok(
            typeof limit === "number" && limit < budget,
            `${name}: leave time for cleanup and uploads`,
          );
      }
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
void test("selective Fallow workflow has compiler custody and outer timeout headroom", async () => {
  const text = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
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
function workflowJob(job: string) {
  const settings: unknown = parseDocument(workflow, { uniqueKeys: true }).toJS();
  assert.ok(isRecord(settings) && isRecord(settings.jobs));
  const owner = settings.jobs[job];
  assert.ok(isRecord(owner) && Array.isArray(owner.steps));
  return owner;
}
function workflowStep(job: string, name: string) {
  const owner = workflowJob(job);
  assert.ok(Array.isArray(owner.steps));
  const steps: unknown[] = owner.steps;
  const step = steps.find((value) => isRecord(value) && value.name === name);
  assert.ok(
    isRecord(step) && typeof step.run === "string",
    `Missing executable step: ${job}/${name}`,
  );
  return { ...step, run: step.run };
}
function executableLines(run: string) {
  return run
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

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
  const full = requiredFixture(
    requiredFixture(workflow.split("  frontend_full:")[1]).split("  frontend:")[0],
  );
  assert.equal(full.match(/run: node scripts\/run-fallow\.mts/g)?.length, 1);
  assert.ok(full.indexOf("run-fallow.mts") < full.indexOf("pnpm browser:bootstrap"));
  assert.match(full, /name: Retain original Fallow reports\n +if: always\(\)/);
  assert.match(full, /path: work\/fallow-reports\//);
  assert.match(full, /name: fallow-full-.*\n +path: work\/fallow-reports\/\n +retention-days: 7/);
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
  const deep = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  const selected = requiredFixture(
    requiredFixture(deep.split("  fallow_analysis:")[1]).split("  audit:")[0],
  );
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
  const block = requiredFixture(
    requiredFixture(workflow.split("  frontend_full:")[1]).split(/\n  [a-zA-Z][a-zA-Z_-]*:/u)[0],
  );
  assert.match(block, /runs-on: ubuntu-22\.04/u);
  assert.match(
    block,
    /unshare --user --map-current-user --mount --pid --fork --mount-proc \/usr\/bin\/true/u,
  );
  assert.match(block, /scripts\/desktop-linux-native-session\.test\.mts/u);
  assert.doesNotMatch(block, /continue-on-error:|sysctl\s+-|apparmor_parser\s/u);
  assert.match(
    block,
    /- name: Test native compiler and shell integrations\n\s+working-directory: \.\n\s+run: node scripts\/run-viteplus\.mts run native:tools/u,
  );
});
void test("dependency lanes run actual security review without a custom age audit", () => {
  for (const name of ["fast_dependency_review", "dependency_review_full"]) {
    const block = requiredFixture(
      requiredFixture(workflow.split("  " + name + ":")[1]).split(/\n  [a-zA-Z][a-zA-Z_-]*:/u)[0],
    );
    assert.match(block, /actions\/dependency-review-action@/u);
    assert.match(block, /fail-on-severity: high/u);
    assert.doesNotMatch(
      block,
      /dependency-release-age|dependency-age|continue-on-error|minimumReleaseAge/u,
    );
  }
});
const qualificationWorkflow = await readFile(
  new URL("../.github/workflows/qualification.yml", import.meta.url),
  "utf8",
);
const nativeDesignCompatibilityWorkflow = await readFile(
  new URL("../.github/workflows/native-design-compatibility.yml", import.meta.url),
  "utf8",
);

const nativeCompatibilityRunner = await readFile(
  new URL("../apps/desktop/test/native-compatibility.mts", import.meta.url),
  "utf8",
);

void test("ordinary Linux package operation is fixed and isolated from fixture builds and broader dispatch", async () => {
  const sections = nativeDesignCompatibilityWorkflow.split(/^  (?=[a-z_]+:)/mu);
  const block = sections.find((section) => section.startsWith("linux_package_boundary:\n"));
  assert.ok(block);
  assert.match(
    block,
    /- name: Run the unchanged shipping boundary with synthetic media readiness\n        timeout-minutes: 10\n        env:\n          PORTCOVE_RETAINED_EVIDENCE_DIR: \$\{\{ runner\.temp \}\}\/pcv-package2-retained-inputs\n        run: node scripts\/run-rust-tests\.mts --guard-command node scripts\/desktop-linux-media\.mts --run/u,
  );
  assert.doesNotMatch(requiredFixture(block.split("    steps:")[0]), /\$\{\{ runner\./u);
  assert.match(block, /\$\{\{ runner\.temp \}\}\/pcv-package2-retained-inputs\/\*\*/u);
  const mediaAdapter = await readFile(
    new URL("./desktop-linux-media.mts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(mediaAdapter, /PORTCOVE_RETAINED_EVIDENCE_DIR\s*:/u);
  assert.match(mediaAdapter, /PORTCOVE_SHARED_TOOL_CACHE: toolCachePaths\(\)\.sharedRoot/u);
  assert.match(
    mediaAdapter,
    /acquireNativeSessionLock\(\{\s*workspace: root,\s*scenarios: \["native-linux-packaged-webview-boundary"\],\s*namespaceDelegation: true,/u,
  );
  assert.match(
    block,
    /if: \$\{\{ inputs\.operation == 'linux-package-boundary' && \(inputs\.runner == 'ubuntu-22\.04' \|\| inputs\.runner == 'ubuntu-24\.04'\) && !inputs\.edge_driver_proof \}\}/u,
  );
  assert.match(block, /runs-on: \$\{\{ inputs\.runner \}\}/u);
  assert.doesNotMatch(
    block,
    /VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE|--features|secrets\.|continue-on-error|sysctl|apparmor_parser/u,
  );
  assert.deepEqual(
    sections
      .filter((section) => /^\w+:\n    if:.*linux-package-boundary/mu.test(section))
      .map((section) => section.split(":")[0]),
    ["linux_package_boundary"],
  );
  assert.match(
    block,
    /desktop-linux-media\.mts --prepare[\s\S]*desktop-linux-media\.mts --build[\s\S]*desktop-linux-media\.mts --run/u,
  );
  assert.match(
    block,
    /if: \$\{\{ always\(\) && steps\.media_preparation\.outcome != 'skipped' \}\}[\s\S]*desktop-linux-media\.mts --cleanup/u,
  );
  assert.ok(
    block.indexOf("desktop-linux-namespace-preflight.mts") <
      block.indexOf("desktop-linux-media.mts --prepare"),
  );
  assert.match(block, /desktop-linux-namespace-profile\.mts --prepare/u);
  assert.match(
    block,
    /PORTCOVE_NAMESPACE_ORIGINAL_NODE.*desktop-linux-namespace-profile\.mts --cleanup/u,
  );
  assert.match(block, /!\*\*\/private-authority/u);
  assert.match(block, /!\*\*\/auth\.cookie/u);
});

void test("candidate consumer selects only existing selected, compiled and history jobs", () => {
  const jobs = nativeDesignCompatibilityWorkflow.split(/^  (?=[a-z_]+:)/mu);
  const consumers = jobs.filter((job) => /^hosted_.*\n    if:.*candidate-consumer/mu.test(job));
  assert.deepEqual(
    consumers.map((job: string) =>
      requiredFixture(requiredFixture(job.match(/^hosted_[a-z]+/u))[0]),
    ),
    ["hosted_selected", "hosted_compiled", "hosted_history"],
  );
  for (const [job, minutes, phase] of [
    [requiredFixture(consumers[0]), 60, "selected"],
    [requiredFixture(consumers[1]), 120, "compiled"],
    [requiredFixture(consumers[2]), 45, "native"],
  ] as const) {
    assert.match(job, new RegExp(`timeout-minutes: ${minutes}\\n`));
    assert.match(job, /runs-on: ubuntu-24\.04/u);
    assert.match(job, /persist-credentials: false/u);
    assert.match(job, new RegExp(`hosted-validation ${phase}\\n`));
    assert.doesNotMatch(job, /upload-artifact|actions\/cache|cache: pnpm/u);
  }
});
const desktopPackage: unknown = JSON.parse(
  await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
);
assert.ok(isRecord(desktopPackage) && isRecord(desktopPackage.scripts));
const desktopScripts = desktopPackage.scripts;
const qualityGuide = await readFile(new URL("../docs/QUALITY.md", import.meta.url), "utf8");
const windowsQualificationRunner = await readFile(
  new URL("./run-windows-qualification.ps1", import.meta.url),
  "utf8",
);

void test("reviewed hosted phases retain independent allocations, fixed commands and read-only isolation", () => {
  const source = nativeDesignCompatibilityWorkflow;
  for (const [name, limit, phase] of [
    ["hosted_selected", 60, "selected"],
    ["hosted_audit", 30, "audit"],
    ["hosted_compiled", 120, "compiled"],
    ["hosted_history", 45, "native"],
  ] as const) {
    const section = requiredFixture(
      requiredFixture(source.split(`\n  ${name}:`)[1])?.split(/\n  [a-z_]+:\n/)[0],
    );
    assert.ok(section);
    assert.match(section, new RegExp(`timeout-minutes: ${limit}`));
    assert.match(section, /runs-on: ubuntu-24\.04/);
    assert.match(section, /persist-credentials: false/);
    assert.match(section, new RegExp(`hosted-validation ${phase}`));
    assert.match(section, /emit-hosted hosted-evidence/);
    assert.doesNotMatch(
      section,
      /upload-artifact|actions\/cache|rust-cache|secrets\.|VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE/,
    );
  }
  assert.match(source, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(source, /checks: write|contents: write|pull_request_target/);
});

void test("hosted selected setup prepares the provider observed by preflight and used by selected recipes", () => {
  const selected = requiredFixture(
    requiredFixture(nativeDesignCompatibilityWorkflow.split("\n  hosted_selected:")[1]).split(
      "\n  hosted_audit:",
    )[0],
  );
  const install = selected.indexOf("run: corepack pnpm install --frozen-lockfile");
  const preflight = selected.indexOf("hosted-validation provision");
  assert.ok(install >= 0 && install < preflight);
  assert.match(
    selected,
    /working-directory: source\n        run: corepack pnpm install --frozen-lockfile/u,
  );
  assert.doesNotMatch(
    selected,
    /COREPACK_ENABLE_PROJECT_SPEC: ["']?0|COREPACK_ENABLE_NETWORK: ["']?0/u,
  );
});

void test("decoded hosted evidence recovers exact PNG bytes and rejects wrong run or missing terminal data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-hosted-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = {
    source: "a".repeat(40),
    controller: "b".repeat(40),
    base: "c".repeat(40),
    run: "42",
    attempt: "1",
    job: "hosted_history",
    phase: "native",
    binding_sha256: "d".repeat(64),
  };
  const input = path.join(root, "input");
  await mkdir(input);
  await writeFile(path.join(input, "binding.json"), JSON.stringify(expected));
  await writeFile(
    path.join(input, "execution.json"),
    JSON.stringify({ ...expected, phase: "native", exit_code: 0 }),
  );
  // Codec unit fixture, never native acceptance evidence.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTfcAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(path.join(input, "fixture.png"), png);
  await mkdir(path.join(input, "native", "library"), { recursive: true });
  await writeFile(
    path.join(input, "native", "library", "portcove.sqlite3"),
    "runtime state, not evidence",
  );
  await mkdir(path.join(input, "native", "webview"));
  await writeFile(path.join(input, "native", "webview", "Cache"), "runtime state, not evidence");
  const encoded = await encodeHostedEvidence(input);
  const decodedLog = encoded
    .split("\n")
    .map((line) => `2026-10-08T00:00:00Z ${line}`)
    .join("\n");
  const output = path.join(root, "decoded");
  assert.equal((await recoverHostedEvidence(decodedLog, output, expected)).exit_code, 0);
  assert.deepEqual(await readFile(path.join(output, "fixture.png")), png);
  assert.equal((await readdir(output)).includes("native"), false);
  for (const patch of [{ phase: "audit" }, { job: "hosted_audit" }])
    await assert.rejects(
      () =>
        recoverHostedEvidence(decodedLog, path.join(root, requiredFixture(Object.keys(patch)[0])), {
          ...expected,
          ...patch,
        }),
      /differs/,
    );
  await assert.rejects(
    () =>
      recoverHostedEvidence(decodedLog, path.join(root, "wrong-run"), { ...expected, run: "43" }),
    /run differs/,
  );
  await rm(path.join(input, "execution.json"));
  await assert.rejects(
    async () =>
      recoverHostedEvidence(
        await encodeHostedEvidence(input),
        path.join(root, "partial"),
        expected,
      ),
    /terminal/,
  );
  // Reject Windows directory junctions without requiring symlink privileges.
  // Unix retains the file-symlink rejection fixture.
  await symlink(
    process.platform === "win32" ? input : path.join(input, "fixture.png"),
    path.join(input, "linked.png"),
    process.platform === "win32" ? "junction" : "file",
  );
  await assert.rejects(() => encodeHostedEvidence(input), /links/);
});

void test("hosted evidence rejects malformed matching identities while retaining decoded failure evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosted-identity-shape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input");
  await mkdir(input);
  const identity = {
    source: "a".repeat(40),
    controller: "b".repeat(40),
    base: "c".repeat(40),
    run: "42",
    attempt: "1",
    job: "hosted_compiled",
    phase: "compiled",
    binding_sha256: "d".repeat(64),
  };
  for (const [index, patch] of [
    { source: 42 },
    { controller: null },
    { phase: 42 },
    { job: {} },
  ].entries()) {
    const malformed = { ...identity, ...patch };
    await writeFile(path.join(input, "binding.json"), JSON.stringify(malformed));
    await writeFile(
      path.join(input, "execution.json"),
      JSON.stringify({ ...malformed, exit_code: 0 }),
    );
    const destination = path.join(root, `failure-${index}`);
    await assert.rejects(
      recoverHostedEvidence(await encodeHostedEvidence(input), destination, malformed),
      /Invalid expected hosted evidence identity/u,
    );
    assert.deepEqual(
      await readFile(path.join(destination, "binding.json")),
      await readFile(path.join(input, "binding.json")),
    );
    assert.deepEqual(
      await readFile(path.join(destination, "execution.json")),
      await readFile(path.join(input, "execution.json")),
    );
  }
});

void test("hosted backup focus is manual-only, pinned, isolated and retains real evidence without billed storage", async () => {
  const source = await readFile(
    new URL("../.github/workflows/native-design-compatibility.yml", import.meta.url),
    "utf8",
  );
  assert.match(source, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(source, /^ {2}(pull_request|push|schedule|workflow_run):/m);
  assert.match(source, /^permissions:\n {2}contents: read$/m);
  assert.match(source, /runs-on: windows-2022/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /\$env:FOCUS_HEAD -ne '161e577dc48f93db98a9930853e808e22c43c7b2'/);
  assert.match(source, /git -c user.name=PortcoveQualification .* merge --no-ff --no-edit/);
  assert.match(source, /merge_head = \(git rev-parse HEAD\)/);
  assert.match(source, /merge_parents = \(git show -s --format=%P HEAD\)/);
  assert.match(source, /just desktop-verify --scenario native-backup-delete-focus --require-clean/);
  const windows = requiredFixture(
    requiredFixture(source.split("  backup_focus:\n")[1])?.split("\n  edge_driver_proof:")[0],
  );
  assert.ok(windows);
  assert.doesNotMatch(
    windows,
    /VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE|upload-artifact|rust-cache|actions\/cache|cache: pnpm/,
  );
  assert.match(
    source,
    /qualify:\n {4}if: \$\{\{ inputs\.operation == 'compatibility' && !inputs\.edge_driver_proof && inputs\.runner != 'windows-2022' \}\}/,
  );
  assert.match(
    windows,
    /^ {4}if: \$\{\{ inputs\.operation == 'compatibility' && !inputs\.edge_driver_proof && inputs\.runner == 'windows-2022' \}\}/,
  );
  assert.match(windows, /PORTCOVE_TEMP_DIR: \$\{\{ github.workspace \}\}/);
  assert.doesNotMatch(requiredFixture(windows.split("    steps:")[0]), /\$\{\{ runner\./);
  assert.match(windows, /id: native-quality-pins/);
  assert.match(windows, /node scripts\/quality-tools.mts --github-output >> \$env:GITHUB_OUTPUT/);
  assert.match(windows, /taiki-e\/install-action@a4d3f3f761dcd95cce1b72cb61cb6d1963438177/);
  assert.match(windows, /tool: \$\{\{ steps.native-quality-pins.outputs.required_prebuilt \}\}/);
  assert.ok(
    windows.indexOf("Provision existing pinned prebuilt quality tools") <
      windows.indexOf("./scripts/bootstrap-quality-tools.ps1 -Desktop"),
  );

  assert.match(source, /if: always\(\)[\s\S]*native-backup-evidence.mts emit/);
  assert.match(source, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Required evidence retention failed/);
});

function jobSection(name: string, nextName?: string) {
  const end = nextName ? `(?=^  ${nextName}:)` : "(?![\\s\\S])";
  return workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)${end}`, "m"))?.[1] ?? "";
}

void test("Windows updater rehearsal adopts manifest-pinned prebuilt tools before Desktop bootstrap", async () => {
  const rehearsal = await readFile(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
    "utf8",
  );
  const steps = rehearsal.split(/\r?\n {6}- /).slice(1);
  const readerIndex = steps.findIndex((step: string) =>
    step.startsWith("name: Read pinned Windows quality-tool versions"),
  );
  assert.ok(readerIndex >= 0, "Windows bootstrap must receive the existing prebuilt tool pins");
  const reader = requiredFixture(steps[readerIndex]);
  const prebuilt = requiredFixture(steps[readerIndex + 1]);
  const bootstrap = requiredFixture(steps[readerIndex + 2]);
  for (const step of [reader, prebuilt, bootstrap]) {
    assert.match(step, /\n {8}if: runner\.os == 'Windows'\r?\n/);
  }
  assert.match(reader, /id: windows-quality-pins\r?\n/);
  assert.match(reader, /shell: pwsh\r?\n/);
  assert.match(
    reader,
    /run: node scripts\/quality-tools\.mts --github-output >> \$env:GITHUB_OUTPUT/,
  );
  assert.match(prebuilt, /uses: taiki-e\/install-action@a4d3f3f761dcd95cce1b72cb61cb6d1963438177/);
  assert.match(
    prebuilt,
    /tool: \$\{\{ steps\.windows-quality-pins\.outputs\.required_prebuilt \}\}/,
  );
  assert.doesNotMatch(prebuilt, /checksum:|fallback:|tool: (?:just|cargo-)/);
  assert.match(
    bootstrap,
    /^name: Install pinned Windows native driver for installed NSIS renderer qualification\r?\n/,
  );
  assert.match(bootstrap, /run: \.\/scripts\/bootstrap-quality-tools\.ps1 -Desktop/);
});

void test("full frontend qualification retains native scenario contracts; ordinary CI uses selected units", () => {
  const full = requiredFixture(
    requiredFixture(workflow.split("  frontend_full:")[1]).split("  frontend:")[0],
  );
  const fast = requiredFixture(
    requiredFixture(workflow.split("  fast_frontend:")[1]).split("  fast_catalog:")[0],
  );
  assert.match(full, /desktop-scenarios\.test\.mts/);
  assert.match(full, /--context-preflight/);
  assert.match(fast, /ci-baseline\.mts frontend/);
  assert.doesNotMatch(fast, /desktop-preparation-test|test:browser|run-fallow/);
});

void test("EdgeDriver trust proof is manual, isolated, and does not launch the application", () => {
  const job = requiredFixture(
    requiredFixture(nativeDesignCompatibilityWorkflow.split("\n  edge_driver_proof:")[1])?.split(
      "\n  slice3_windows_recovery:",
    )[0],
  );
  assert.ok(job);
  assert.match(
    job,
    /if: \$\{\{ inputs\.operation == 'compatibility' && inputs\.edge_driver_proof \}\}/u,
  );
  assert.match(job, /runs-on: windows-2022/u);
  assert.match(job, /persist-credentials: false/u);
  assert.doesNotMatch(
    job,
    /upload-artifact|actions\/cache|cache:|cargo|bootstrap-quality-tools\.ps1 -Desktop|desktop-verify/u,
  );
  assert.match(job, /Test-VerifiedEdgeDriver \$downloaded \$version/u);
  assert.match(job, /Test-VerifiedEdgeDriver \$cached \$version/u);
  assert.match(job, /Test-VerifiedEdgeDriver \$cached '0\.0\.0\.0'/u);
  assert.match(job, /https:\/\/msedgedriver\.microsoft\.com/u);
  assert.match(job, /bootstrap_sha256/u);
  assert.match(job, /driver_sha256/u);
  assert.match(
    nativeDesignCompatibilityWorkflow,
    /if: \$\{\{ inputs\.operation == 'compatibility' && !inputs\.edge_driver_proof && inputs\.runner != 'windows-2022' \}\}/u,
  );
});

void test("ordinary AppImage observations use restored source and default production configuration", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
    "utf8",
  );
  const ordinary = workflow
    .split(/(?=      - name:)/u)
    .find((step) =>
      step.startsWith("      - name: Prove ordinary default-feature AppImage startup and IPC"),
    );
  assert.ok(ordinary);
  assert.match(ordinary, /if: runner\.os == 'Linux'/u);
  assert.match(
    ordinary,
    /git diff --exit-code HEAD -- Cargo\.toml Cargo\.lock apps\/desktop\/package\.json apps\/desktop\/src-tauri\/tauri\.conf\.json/u,
  );
  assert.match(
    ordinary,
    /node scripts\/run-rust-tests\.mts --guard-command pnpm --dir apps\/desktop tauri build --bundles appimage --ci/u,
  );
  assert.doesNotMatch(ordinary, /--features|--config|native-linux-packaged-webview-boundary/u);
  for (const variable of [
    "TAURI_CONFIG",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PATH",
    "APPIMAGE_EXTRACT_AND_RUN",
  ]) {
    assert.ok(ordinary.includes(`test -z "\${${variable}:-}"`));
  }
  assert.match(ordinary, /--app "\$ordinary\/Portcove\.AppImage"/u);
  assert.match(ordinary, /--scenario native-error-recovery/u);
  for (const artifact of [
    "Portcove.AppImage",
    "artifact.sha256",
    "native/*.json",
    "native/*.png",
    "native/*.log",
  ]) {
    assert.ok(workflow.includes(`work/updater-rehearsal/ordinary-appimage/${artifact}`));
  }
});

void test("native design compatibility remains explicit, isolated, and non-publishing", () => {
  assert.match(nativeDesignCompatibilityWorkflow, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(nativeDesignCompatibilityWorkflow, /^ {2}(pull_request|push|schedule):/m);
  assert.match(nativeDesignCompatibilityWorkflow, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(
    nativeDesignCompatibilityWorkflow,
    /options:\r?\n {10}- ubuntu-22\.04\r?\n {10}- ubuntu-24\.04\r?\n {10}- macos-15\r?\n {10}- macos-15-intel/,
  );
  assert.match(nativeDesignCompatibilityWorkflow, /--scenario native-design-system-compatibility/);
  assert.match(nativeDesignCompatibilityWorkflow, /test:desktop \\\r?\n {14}--app/);
  assert.doesNotMatch(nativeDesignCompatibilityWorkflow, /test:desktop -- \\/);
  assert.match(
    nativeDesignCompatibilityWorkflow,
    /--output "\$PWD\/work\/native-compatibility-evidence\/linux"/,
  );
  assert.doesNotMatch(
    nativeDesignCompatibilityWorkflow,
    /mkdir -p work\/native-compatibility-evidence\/linux/,
  );
  assert.match(nativeDesignCompatibilityWorkflow, /--features native-compatibility-qualification/);
  assert.match(nativeDesignCompatibilityWorkflow, /tauri\.native-compatibility\.conf\.json/);
  assert.doesNotMatch(nativeDesignCompatibilityWorkflow, /release|publish|deploy|schedule:/i);
  assert.match(nativeCompatibilityRunner, /createHash\("sha256"\)/);
  assert.match(nativeCompatibilityRunner, /"result\.json"/);
  assert.match(
    nativeCompatibilityRunner,
    /applicationProcess\.kill\("SIGKILL"\);[\s\S]*?await waitForApplicationExit\(5_000\)/,
  );
  assert.equal(
    desktopScripts["lint:style"],
    'stylelint --config stylelint.config.mjs --max-warnings 0 "src/**/*.css"',
  );
});

const classify = jobSection("classify", "provenance");
const provenance = jobSection("provenance", "prose_checks");
const proseChecks = jobSection("prose_checks", "fast_rust");
const fastRust = jobSection("fast_rust", "fast_rust_quality");
const fastPlatform = jobSection("fast_platform", "fast_rust_quality");
const fastRustQuality = jobSection("fast_rust_quality", "fast_frontend");
const fastFrontend = jobSection("fast_frontend", "fast_catalog");
const fastCatalog = jobSection("fast_catalog", "rust_tests");
const rustTests = jobSection("rust_tests", "rust_workspace_tests");
const rustWorkspaceTests = jobSection("rust_workspace_tests", "rust_clippy");
const rustClippy = jobSection("rust_clippy", "windows_storage");
const windowsStorage = jobSection("windows_storage", "native_rust");
void test("fixed-account cases execute on Windows in both fast and qualification plans", () => {
  for (const job of ["windows_helpers", "windows_storage"]) {
    assert.equal(workflowJob(job)["runs-on"], "windows-latest");
    assert.deepEqual(
      executableLines(
        workflowStep(job, "Test inert fixed-account setup and capability contracts on Windows").run,
      ),
      [
        "node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mts scripts/release-local-worker-accounts.test.mts scripts/release-native-account-capability.test.mts scripts/recover-local-worker-empty-setup.test.mts",
      ],
    );
  }
});
const nativeRust = jobSection("native_rust", "intel_build");
const intelBuild = jobSection("intel_build", "intel_tests");
const intelTests = jobSection("intel_tests", "rust_docs");
const rustDocs = jobSection("rust_docs", "rust");
const rust = jobSection("rust", "rust_quality_full");
const rustQuality = jobSection("rust_quality_full", "rust-quality");
const rustQualityGate = jobSection("rust-quality", "frontend_full");
const frontend = jobSection("frontend_full", "frontend");
const frontendGate = jobSection("frontend", "catalog_full");
const catalog = jobSection("catalog_full", "catalog");
const catalogGate = jobSection("catalog", "fast_dependency_review");
const fastDependencyReview = jobSection("fast_dependency_review", "dependency_review_full");
const dependencyReview = jobSection("dependency_review_full", "dependency-review");
const dependencyReviewGate = jobSection("dependency-review");

void test("runtime diagnostics retain complete Windows and Linux typed fixture evidence", () => {
  assert.match(fastRust, /runs-on: windows-latest/u);
  assert.match(
    fastRust,
    /PORTCOVE_DIAGNOSTICS_EVIDENCE_DIR: .*\/work\/runtime-diagnostics\/windows/u,
  );
  assert.match(fastRust, /rust-test-impact\.mts --workspace-run/u);
  assert.match(fastRust, /PORTCOVE_DIAGNOSTICS_SOURCE_REVISION=.*GITHUB_ENV/u);
  assert.match(
    fastRustQuality,
    /uses: \.\/\.github\/actions\/setup-rust\n\s+if: contains\(fromJSON\(needs\.classify\.outputs\.groups_json\), 'rust'\)\n\s+with:\n\s+test-fixtures: true/u,
  );
  assert.match(
    fastRust,
    /- name: Retain runtime diagnostics acceptance and latency evidence\n\s+if: always\(\)/u,
  );
  const linuxFixture = requiredFixture(
    requiredFixture(
      fastRustQuality.split(
        "      - name: Test typed runtime diagnostics and frontend admission on Linux",
      )[1],
    ).split("      - name: Retain Linux runtime diagnostics acceptance evidence")[0],
  );
  assert.match(
    linuxFixture,
    /if: contains\(fromJSON\(needs\.classify\.outputs\.groups_json\), 'rust'\)/u,
  );
  assert.match(linuxFixture, /shell: bash/u); // Bash's pipefail preserves a failed test before tee.
  assert.match(
    linuxFixture,
    /node scripts\/run-rust-tests\.mts --guard-command cargo test --locked -p portcove-cli --test runtime_diagnostics --test host_diagnostics --test desktop_host_diagnostics -- --test-threads=1 --nocapture/u,
  );
  assert.match(linuxFixture, /--test-threads=1 --nocapture 2>&1 \| tee/u);
  assert.doesNotMatch(linuxFixture, /rustc --edition|--workspace|tauri build|continue-on-error/u);
  assert.match(linuxFixture, /\/runtime-tests\.txt/u);
  assert.match(
    linuxFixture,
    /cargo test --locked -p portcove-diagnostics -- --test-threads=1 --nocapture/u,
  );
  assert.match(
    linuxFixture,
    /cargo test --locked -p portcove-core support_bundle_export -- --test-threads=1 --nocapture/u,
  );
  for (const lane of [fastRust, fastRustQuality]) {
    assert.match(lane, /checked-git\.mts rev-parse HEAD/u);
    assert.match(lane, /rustc --version --verbose/u);
    assert.match(lane, /source_sha256:hashes/u);
    for (const source of [
      "crates/portcove-diagnostics/src/lib.rs",
      "crates/portcove-diagnostics/src/sessions.rs",
      "crates/portcove-diagnostics/src/writer.rs",
      "crates/portcove-diagnostics/src/writer_tests.rs",
      "crates/portcove-diagnostics/src/events.rs",
      "crates/portcove-diagnostics/src/events_tests.rs",
      "apps/desktop/src-tauri/src/host_startup.rs",
      "crates/portcove-cli/tests/host_diagnostics.rs",
      "crates/portcove-cli/tests/desktop_host_diagnostics.rs",
      "apps/desktop/src-tauri/src/frontend_diagnostics.rs",
      "crates/portcove-core/src/runtime_diagnostics.rs",
      "crates/portcove-core/src/operation.rs",
      "crates/portcove-core/src/support_bundle.rs",
      "crates/portcove-core/src/service.rs",
      "crates/portcove-core/src/preparation_execution.rs",
      "crates/portcove-core/src/tool_process.rs",
      "crates/portcove-cli/tests/runtime_diagnostics.rs",
    ])
      assert.ok(lane.includes(source), source);
    assert.match(lane, /name: runtime-diagnostics-(?:windows|linux)-/u);
    assert.match(lane, /path: work\/runtime-diagnostics\/(?:windows|linux)\//u);
  }
  assert.match(
    fastRustQuality,
    /- name: Retain Linux runtime diagnostics acceptance evidence\n\s+if: always\(\) && contains/u,
  );
});

void test("Windows diagnostics serialize file workers without changing coverage or deadlines", () => {
  const command = requiredFixture(
    executableLines(
      workflowStep("windows_storage", "Test development diagnostics and evidence").run,
    )[0],
  )
    .trim()
    .split(/\s+/u);
  assert.ok(command);
  assert.deepEqual(command.slice(0, 9), [
    "node",
    "scripts/dev-storage.mts",
    "run",
    "--",
    "node",
    "--test",
    "--test-concurrency=1",
    "--test-timeout=30000",
    "--test-reporter=./scripts/test-duration-reporter.mts",
  ]);
  assert.deepEqual(command.slice(9), [
    "scripts/desktop-scenarios.test.mts",
    "scripts/native-compatibility.test.mts",
    "scripts/desktop-execution-plan.test.mts",
    "scripts/desktop-real-runtime.test.mts",
    "scripts/desktop-linux-native-session.test.mts",
    "scripts/desktop-linux-stop.test.mts",
    "scripts/desktop-listener-probe.test.mts",
    "scripts/desktop-verify.test.mts",
    "scripts/dev-doctor.test.mts",
    "scripts/development-capabilities.test.mts",
    "scripts/development-cli-help.test.mts",
    "scripts/development-evidence.test.mts",
    "scripts/retained-package.test.mts",
    "scripts/capture-target.test.mts",
    "scripts/handoff-evidence.test.mts",
    "scripts/native-confirmation.test.mts",
    "scripts/native-helper-dependencies.test.mts",
    "scripts/frontend-command-preflight.test.mts",
    "scripts/windows-helper-checks.test.mts",
    "scripts/heavy-rust-test-lock.test.mts",
    "scripts/local-validation.test.mts",
    "scripts/validation-evidence.test.mts",
    "scripts/native-session-lock.test.mts",
    "scripts/native-session.test.mts",
    "scripts/run-rust-tests.test.mts",
    "scripts/rust-support-cache.test.mts",
    "scripts/rust-test-impact.test.mts",
    "scripts/rust-test-tree-supervisor.test.mts",
    "scripts/tool-cache.test.mts",
    "scripts/resource-capacity.test.mts",
    "scripts/resource-command.test.mts",
  ]);
});

void test("every Node test file is included in required CI and the local quality workflow", async () => {
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  const files = (await readdir(new URL(".", import.meta.url))).filter((name: string) =>
    /\.test\.[cm]?[jt]s$/u.test(name),
  );
  requireNodeTestInventory(
    files.map((file) => `scripts/${file}`),
    workflow,
    recipes,
    windowsQualificationRunner,
    await readFile(new URL("./node-test-suites.json", import.meta.url), "utf8"),
  );
});

void test("application release records run after the maintained SemVer dependency is installed", () => {
  const installation = frontend.indexOf("args: [--frozen-lockfile]");
  const selection = frontend.indexOf("scripts/select-release-channel.test.mts");
  const coordinator = frontend.indexOf("scripts/release-coordinator.test.mts");
  const reconstruction = frontend.indexOf(
    "scripts/reconstruct-application-update-records.test.mts",
  );
  assert.ok(installation >= 0 && selection > installation);
  assert.ok(coordinator > installation);
  assert.ok(reconstruction > installation);
  assert.ok(!catalog.includes("scripts/select-release-channel.test.mts"));
  assert.ok(!catalog.includes("scripts/release-coordinator.test.mts"));
  assert.ok(!catalog.includes("scripts/reconstruct-application-update-records.test.mts"));
});

void test("selected contracts install their desktop-owned dependencies before fast contract execution", () => {
  const block = requiredFixture(
    requiredFixture(workflow.split("  fast_catalog:")[1]).split(/\n  [a-z_]+:/u)[0],
  );
  const setup = block.indexOf(
    "pnpm --filter portcove-desktop-ui install --frozen-lockfile --ignore-scripts",
  );
  const execution = block.indexOf("run: node scripts/ci-baseline.mts contracts");
  assert.ok(setup >= 0 && execution > setup);
  assert.match(block, /if: needs\.classify\.outputs\.contract_desktop == 'true'/u);
  assert.match(workflow, /contract_desktop: \$\{\{ steps\.plan\.outputs\.contract_desktop \}\}/u);
});

void test("full repository contracts run the bounded release evidence collector controls", () => {
  assert.deepEqual(
    executableLines(workflowStep("catalog_full", "Test bounded release run evidence").run),
    [
      "node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mts scripts/release-run-evidence.test.mts",
    ],
  );
});

void test("required CI keeps its cancellation and least-privilege contracts", () => {
  const document = parseDocument(workflow);
  assert.deepEqual(document.errors, []);
  const settings: unknown = document.toJS();
  assert.ok(isRecord(settings));
  assert.deepEqual(settings.permissions, { contents: "read" });
  assert.deepEqual(settings.concurrency, {
    group:
      "ci-${{ inputs.force_qualification && format('qualification-{0}', github.ref) || github.event.pull_request.number || github.ref }}",
    "cancel-in-progress": "${{ !inputs.force_qualification }}",
  });
  for (const section of [
    rustTests,
    rustWorkspaceTests,
    rustClippy,
    windowsStorage,
    nativeRust,
    intelBuild,
    intelTests,
    rustDocs,
    rustQuality,
    frontend,
    catalog,
  ]) {
    assert.notEqual(section, "");
    assert.match(section, /^ {4}needs: (?:classify|\[classify, intel_build\])$/m);
    assert.match(
      section,
      /^ {4}if: .*classify\.outputs\.mode == 'qualification'(?: && contains\(fromJSON\(needs\.classify\.outputs\.platforms_json\), 'macos-x86_64'\))?$/m,
    );
  }
  assert.match(classify, /fetch-depth: 0/);
  assert.match(classify, /node scripts\/select-ci-plan\.mts/);
  assert.match(classify, /PORTCOVE_PROSE_POLICY_ACTIVATED: "true"/);
  assert.match(classify, /PORTCOVE_FAST_VALIDATION_ACTIVATED: "true"/);
  assert.match(provenance, /node scripts\/workflow-provenance\.mts/);
  assert.match(provenance, /--observed-toolchains node/);
  assert.doesNotMatch(provenance, /pnpm\/action-setup|\.\/\.github\/actions\/setup-rust/);
  assert.match(
    provenance,
    /workflow-provenance-\$\{\{ inputs\.provenance_scope \|\| 'ci' \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(provenance, /retention-days: 7/);
  assert.match(
    rustQualityGate,
    /\[classify, provenance, prose_checks, fast_rust_quality, rust_quality_full\]/,
  );
  assert.match(rustQualityGate, /PORTCOVE_ALWAYS_RESULTS: '\{"provenance"/);
  assert.match(proseChecks, /^ {4}if: needs\.classify\.outputs\.mode == 'prose'$/m);
  assert.match(proseChecks, /actions\/setup-node@/);
  const prerequisites = proseChecks.indexOf("node scripts/check-ci-prose.mts --prerequisites");
  const install = proseChecks.indexOf("uses: voidzero-dev/setup-vp@");
  const checks = proseChecks.indexOf("node --test --test-timeout=30000");
  assert.ok(prerequisites >= 0 && install > prerequisites && checks > install);
  assert.match(
    proseChecks,
    /if: steps\.prose-prerequisites\.outputs\.frontend_dependencies == 'true'/u,
  );
  assert.match(
    proseChecks,
    /args: \[--filter, portcove-repository, --frozen-lockfile, --ignore-scripts\]/u,
  );
  assert.doesNotMatch(
    proseChecks,
    /browser:bootstrap|setup-rust|playwright install|continue-on-error/u,
  );
  assert.match(fastCatalog, /run: node scripts\/check-ci-prose\.integration\.mts/u);
  assert.match(fastCatalog, /path: work\/prose-ci-integration\//u);
  assert.match(proseChecks, /scripts\/repository-settings\.test\.mts/);
  assert.match(proseChecks, /scripts\/repository-skills\.test\.mts/);
  assert.match(proseChecks, /node scripts\/check-ci-prose\.mts/);
  for (const gate of [rust, rustQualityGate, frontendGate, catalogGate, dependencyReviewGate]) {
    assert.match(gate, /node scripts\/ci-result-gate\.mts/);
    assert.match(gate, /PORTCOVE_CLASSIFIER_RESULT/);
    assert.match(gate, /PORTCOVE_PROSE_RESULT/);
    assert.match(gate, /PORTCOVE_PLAN_GZIP_BASE64/);
    assert.match(gate, /PORTCOVE_FAST_RESULTS/);
    assert.match(gate, /PORTCOVE_TARGETED_RESULTS/);
    assert.match(gate, /PORTCOVE_QUALIFICATION_RESULTS/);
  }
  for (const fast of [fastRustQuality, fastFrontend, fastCatalog]) {
    assert.match(fast, /mode == 'fast'/);
    assert.match(fast, /runs-on: ubuntu-22\.04/);
  }
  assert.match(fastRust, /runs-on: windows-latest/);
  assert.match(fastRust, /rust-test-impact\.mts --workspace-run/);
  assert.equal(fastPlatform, "");
  assert.match(fastRustQuality, /voidzero-dev\/setup-vp@/);
  assert.match(fastRustQuality, /frontend_workspace == 'true'/);
  assert.match(fastRustQuality, /\[--frozen-lockfile\]/);
  assert.match(
    fastRustQuality,
    /\[--filter, portcove-repository, --frozen-lockfile, --ignore-scripts\]/,
  );
  assert.match(
    fastCatalog,
    /args: \[--filter, portcove-repository, --frozen-lockfile, --ignore-scripts\]/,
  );
  assert.equal(desktopScripts["format:check"], "vp -C ../.. fmt --check");
  assert.match(fastRustQuality, /frontend_tools == 'true'/);
  assert.match(fastRust, /key: fast-rust-tests-/);
  assert.doesNotMatch(fastRustQuality, /cargo clippy/);
  assert.ok(isRecord(settings.jobs));
  const qualityJob = settings.jobs.fast_rust_quality;
  assert.ok(isRecord(qualityJob) && Array.isArray(qualityJob.steps));
  const qualityCaches = qualityJob.steps.filter(
    (step: unknown) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("Swatinem/rust-cache@"),
  );
  assert.deepEqual(qualityCaches, [
    {
      uses: "Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0",
      if: "contains(fromJSON(needs.classify.outputs.groups_json), 'rust')",
      with: {
        "cache-on-failure": true,
        key: "runtime-diagnostics-linux-${{ hashFiles('Cargo.toml') }}",
      },
    },
  ]);
  assert.match(fastDependencyReview, /actions\/dependency-review-action@/);
  assert.match(fastDependencyReview, /base-ref:/);
  assert.match(fastDependencyReview, /head-ref:/);
});

void test("ordinary formatting and lint have one quality owner; deep analyzers stay in qualification", () => {
  const formatting = requiredFixture(
    requiredFixture(workflow.split("  fast_rust_quality:")[1]).split("  fast_frontend:")[0],
  );
  assert.match(formatting, /frontend_tools == 'true'/);
  assert.doesNotMatch(formatting, /format:check/);
  assert.match(formatting, /cargo fmt/);
  assert.match(formatting, /node scripts\/ci-baseline\.mts lint/);
  assert.match(formatting, /PORTCOVE_PLAN_GZIP_BASE64:/);
  assert.match(formatting, /PORTCOVE_CI_METRICS_DIR:/);
  assert.match(formatting, /ci-metrics\.mts summarize/);
  assert.doesNotMatch(formatting, /cargo clippy|lint:oxlint|run-fallow/);
  const frontend = requiredFixture(
    requiredFixture(workflow.split("  fast_frontend:")[1]).split("  fast_catalog:")[0],
  );
  assert.doesNotMatch(frontend, /format:check|pnpm lint/);
});

void test("reusable qualification is read-only, daily, and coalesces without cancelling", async () => {
  assert.match(qualificationWorkflow, /^ {2}workflow_call:\r?$/m);
  assert.match(qualificationWorkflow, /^ {2}workflow_dispatch:\r?$/m);
  assert.match(qualificationWorkflow, /cron: "17 5 \* \* \*"/);
  assert.match(qualificationWorkflow, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(
    qualificationWorkflow,
    /^concurrency:\r?\n {2}group: portcove-qualification-.*\r?\n {2}cancel-in-progress: false$/m,
  );
  assert.match(qualificationWorkflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(qualificationWorkflow, /force_qualification: true/);
  const classification = workflow.split("\n  classify:")[1];
  assert.ok(classification);
  const classifier = classification.split("\n    name:")[0];
  assert.ok(classifier);
  const requested = [...classifier.matchAll(/^ {6}([\w-]+): (read|write)$/gm)];
  assert.equal(requested.length, 3);
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  for (const [source, job] of [
    [qualificationWorkflow, "qualify"],
    [release, "qualification"],
  ] as const) {
    const callJob = source.split(`\n  ${job}:`)[1];
    assert.ok(callJob);
    const caller = callJob.split("\n    uses:")[0];
    assert.ok(caller);
    for (const [, scope, access] of requested) {
      assert.equal(access, "read");
      assert.match(caller, new RegExp(`^ {6}${scope}: ${access}$`, "m"));
    }
    assert.doesNotMatch(caller, /: write/);
  }
  assert.match(qualificationWorkflow, /jobs\.qualify\.outputs\.plan_digest/);
  assert.match(qualificationWorkflow, /provenance_scope:/);
  assert.doesNotMatch(qualificationWorkflow, /secrets:|pull_request_target|contents: write/);
  assert.match(workflow, /^ {2}workflow_call:\r?$/m);
});

void test("Linux desktop prerequisite installation is shared, bounded, and retrying", async () => {
  const deepQuality = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const updaterRehearsal = await readFile(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
    "utf8",
  );
  const packageOwnershipRehearsal = await readFile(
    new URL("../.github/workflows/linux-package-ownership-rehearsal.yml", import.meta.url),
    "utf8",
  );
  const installer = await readFile(
    new URL("./install-linux-desktop-prerequisites.sh", import.meta.url),
    "utf8",
  );
  const invocation =
    /timeout-minutes: 15\r?\n\s+run: \.\/scripts\/install-linux-desktop-prerequisites\.sh/g;

  assert.equal((workflow.match(invocation) ?? []).length, 3);
  assert.equal((deepQuality.match(invocation) ?? []).length, 1);
  assert.equal((release.match(invocation) ?? []).length, 2);
  assert.match(
    updaterRehearsal,
    /timeout-minutes: 15\r?\n\s+run: \.\/scripts\/install-linux-desktop-prerequisites\.sh --include-rpm --include-appimage-runtime/,
  );
  assert.match(
    updaterRehearsal,
    /linux_runner:\r?\n\s+description: [^\r\n]+\r?\n\s+type: choice\r?\n\s+default: ubuntu-24\.04\r?\n\s+options: \[ubuntu-22\.04, ubuntu-24\.04\]/,
  );
  assert.match(
    updaterRehearsal,
    /runs-on: \$\{\{ matrix\.label == 'linux-x86_64' && inputs\.linux_runner \|\| fromJSON\('[^']+'\)\[matrix\.label\] \}\}/,
  );
  assert.match(updaterRehearsal, /work\/updater-rehearsal\/linux-host-baseline\.txt/g);
  assert.match(
    packageOwnershipRehearsal,
    /timeout-minutes: 30\r?\n\s+run: \.\/scripts\/install-linux-desktop-prerequisites\.sh --include-rpm --install-timeout-seconds=600 --prefer-archive-mirror/,
  );
  for (const hostedWorkflow of [
    workflow,
    deepQuality,
    release,
    updaterRehearsal,
    packageOwnershipRehearsal,
  ]) {
    assert.doesNotMatch(hostedWorkflow, /sudo apt-get/);
  }
  for (const packageName of [
    "libwebkit2gtk-4.1-dev",
    "libappindicator3-dev",
    "librsvg2-dev",
    "patchelf",
    "libfuse2",
    "xvfb",
    "dbus-x11",
    "at-spi2-core",
    "util-linux",
  ]) {
    assert.ok(installer.includes(packageName), `${packageName} is missing`);
  }
  assert.match(installer, /Acquire::http::Timeout=30/);
  assert.match(installer, /Acquire::https::Timeout=30/);
  assert.match(installer, /Acquire::Retries=3/);
  assert.match(installer, /DPkg::Lock::Timeout=60/);
  assert.match(installer, /archive\.ubuntu\.com\/ubuntu/);
  assert.match(installer, /Dir::Etc::sourceparts=-/);
  assert.match(installer, /DEBIAN_FRONTEND=noninteractive/);
  assert.match(installer, /timeout --kill-after=10s/);
  assert.match(installer, /sudo -n true/);
  assert.match(installer, /privilege=\(sudo -n\)/);
  assert.match(installer, /"\$\{privilege\[@\]\}" timeout --kill-after=10s "\$deadline" env/);
  assert.doesNotMatch(installer, /timeout[^\n]*"\$\{privilege\[@\]\}"/);
  assert.match(installer, /install_deadline=3m/);
  assert.match(installer, /fallback_install_deadline=5m/);
  assert.match(
    installer,
    /install_from_current_mirror "the runner-configured mirror" 2m "\$install_deadline"/,
  );
  assert.match(
    installer,
    /install_from_current_mirror "the archive mirror fallback" 4m "\$fallback_install_deadline"/,
  );
  assert.ok(
    installer.indexOf('if install_from_current_mirror "the runner-configured mirror"') <
      installer.indexOf('echo "Retrying Linux desktop prerequisites'),
  );
  assert.match(installer, /--include-rpm\) packages\+=\(rpm\)/);
  assert.match(installer, /VERSION_ID:-} == 24\.04[\s\S]*fuse_package=libfuse2t64/);
  assert.match(installer, /--include-appimage-runtime\) packages\+=\("\$fuse_package"/);
  assert.match(installer, /usage: \$0 \[--include-rpm\]/);
});

void test("Linux package ownership rehearsal is focused and preserves managed executables", async () => {
  const rehearsal = await readFile(
    new URL("../.github/workflows/linux-package-ownership-rehearsal.yml", import.meta.url),
    "utf8",
  );
  const qualification = await readFile(
    new URL("./test-linux-package-ownership.sh", import.meta.url),
    "utf8",
  );

  assert.match(rehearsal, /^on:\r?\n {2}pull_request:\r?\n {4}paths:/m);
  assert.match(rehearsal, /^ {2}workflow_dispatch:$/m);
  for (const governedPath of [
    "apps/desktop/src-tauri/src/application_update_linux.rs",
    "apps/desktop/src-tauri/src/application_update_recovery.rs",
    "apps/desktop/src-tauri/tauri.conf.json",
    "scripts/test-linux-package-ownership.sh",
  ]) {
    assert.ok(rehearsal.includes(`- ${governedPath}`));
  }
  assert.match(rehearsal, /runs-on: ubuntu-22\.04/);
  assert.match(rehearsal, /container: fedora:44/);
  assert.match(
    rehearsal,
    /PORTCOVE_SOURCE_COMMIT: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
  assert.equal(rehearsal.match(/ref: \$\{\{ env\.PORTCOVE_SOURCE_COMMIT \}\}/g)?.length, 3);
  assert.match(rehearsal, /pnpm tauri build --bundles deb,rpm --ci/);
  assert.match(rehearsal, /pnpm\/setup@[a-f0-9]{40}/);
  assert.match(rehearsal, /install: false\s+node-version-file: \.node-version\s+cache: true/);
  assert.doesNotMatch(rehearsal, /pnpm\/action-setup|actions\/setup-node/);
  assert.match(rehearsal, /Verify pinned frontend runtime and store[\s\S]*pnpm store path/);
  assert.match(rehearsal, /pnpm install --frozen-lockfile/);
  assert.match(rehearsal, /actions\/download-artifact@/);
  assert.match(rehearsal, /test-linux-package-ownership\.sh deb/);
  assert.match(rehearsal, /test-linux-package-ownership\.sh rpm/);
  assert.match(rehearsal, /dnf --assumeyes install findutils git nodejs rpm/);
  assert.match(
    rehearsal,
    /Install Fedora qualification tools[\s\S]*actions\/checkout@[\s\S]*Verify installed RPM ownership guidance/,
  );
  assert.doesNotMatch(rehearsal, /appimage|desktop-test|e2e/iu);
  assert.match(rehearsal, /\.\/scripts\/test-linux-package-ownership\.sh/);
  assert.match(rehearsal, /retention-days: 1/);

  assert.match(qualification, /env -u APPIMAGE -u APPDIR -u DISPLAY/);
  assert.match(qualification, /--application-update-recovery eligibility/);
  assert.match(qualification, /dpkg-query --search/);
  assert.match(qualification, /rpm --query --queryformat .* --file/);
  assert.match(qualification, /dnf --assumeyes install/);
  assert.match(qualification, /\$format-owners\.txt/);
  assert.match(qualification, /hash_before.*hash_after/s);
  assert.match(
    qualification,
    /git -c safe\.directory="\$repo_root" -C "\$repo_root" rev-parse HEAD/,
  );
  assert.doesNotMatch(qualification, /safe\.directory=(?:"?\*)/);
  assert.match(qualification, /checkout_commit.*PORTCOVE_SOURCE_COMMIT/s);
  assert.match(qualification, /package_managed_files_unchanged: true/);
});

// Observe only the first reader; asynchronous scheduling is diagnostic, not a repair.
// Keep the same command, environment, SIGTERM deadline and wait-for-close cleanup.
interface ReaderStream {
  setEncoding(encoding: "utf8"): void;
  on(event: "data", handler: (chunk: string) => void): unknown;
}
interface ReaderChild {
  pid?: number | undefined;
  stdin: { end(): void };
  stdout: ReaderStream;
  stderr: ReaderStream;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "spawn", handler: () => void): unknown;
  once(event: "error", handler: (cause: Error) => void): unknown;
  once(
    event: "close",
    handler: (status: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}
interface ReaderObservation {
  representation: string;
  pid: number | null;
  spawned_ms: number | null;
  first_stderr_ms: number | null;
  closed_ms: number | null;
  deadline_reached: boolean;
  samples: ({ elapsed_ms: number; status: string[] } | { elapsed_ms: number; error: unknown })[];
  sample_scope: string;
}
interface ReaderResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: NodeJS.ErrnoException | null;
  stdout: string;
  stderr: string;
  observation: ReaderObservation;
}
interface ReaderHooks {
  spawn?: (executable: string, args: string[], options: SpawnOptions) => ReaderChild;
  readStatus?: (file: string, encoding: "utf8") => Promise<string>;
}
async function observeFirstReader(
  executable: string,
  args: string[],
  options: SpawnOptions & Pick<SpawnSyncOptions, "encoding">,
  hooks: ReaderHooks = {},
): Promise<ReaderResult> {
  const started = performance.now();
  const observation: ReaderObservation = {
    representation: "instrumented asynchronous first invocation; not original-cause proof",
    pid: null,
    spawned_ms: null,
    first_stderr_ms: null,
    closed_ms: null,
    deadline_reached: false,
    samples: [],
    sample_scope: "PID-addressed Linux State/RSS/Threads; not start identity, CPU or process tree",
  };
  return await new Promise<ReaderResult>((resolve) => {
    const { timeout, ...spawnOptions } = options;
    const child: ReaderChild = hooks.spawn
      ? hooks.spawn(executable, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(executable, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
    let error: NodeJS.ErrnoException | null = null;
    let stdout = "";
    let stderr = "";
    let sampling = false;
    let closed = false;
    const elapsed = () => performance.now() - started;
    const deadline = setTimeout(() => {
      observation.deadline_reached = true;
      error ??= Object.assign(new Error(`spawn ${executable} ETIMEDOUT`), {
        code: "ETIMEDOUT",
      });
      child.kill("SIGTERM");
    }, timeout);
    const sample = async () => {
      if (closed || sampling || observation.samples.length >= 4 || !child.pid) return;
      sampling = true;
      try {
        const body = await (hooks.readStatus ?? readFile)(`/proc/${child.pid}/status`, "utf8");
        if (closed) return;
        observation.samples.push({
          elapsed_ms: elapsed(),
          status: body.split("\n").filter((line) => /^(?:State|VmRSS|Threads):/u.test(line)),
        });
      } catch (cause) {
        if (!closed)
          observation.samples.push({
            elapsed_ms: elapsed(),
            error: isRecord(cause) ? (cause.code ?? cause.name) : undefined,
          });
      } finally {
        sampling = false;
      }
    };
    const sampler =
      process.platform === "linux"
        ? setInterval(() => {
            void sample();
          }, 250)
        : null;
    child.once("spawn", () => {
      observation.pid = child.pid ?? null;
      observation.spawned_ms = elapsed();
      if (process.platform === "linux") void sample();
    });
    // Preserve spawnSync's default 1 MiB output bound, instead of hiding overflow.
    const collect = (name: "stdout" | "stderr", chunk: string) => {
      if (name === "stderr" && observation.first_stderr_ms === null)
        observation.first_stderr_ms = elapsed();
      if (isRecord(error) && error.code === "ENOBUFS") return;
      const retained = name === "stdout" ? stdout : stderr;
      if (Buffer.byteLength(retained) + Buffer.byteLength(chunk) > 1024 * 1024) {
        error ??= Object.assign(new Error(`spawn ${executable} ENOBUFS`), { code: "ENOBUFS" });
        child.kill("SIGTERM");
        return;
      }
      if (name === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (cause) => {
      error ??= cause;
    });
    child.once("close", (status, signal) => {
      closed = true;
      clearTimeout(deadline);
      if (sampler) clearInterval(sampler);
      observation.closed_ms = elapsed();
      resolve({ status: error ? null : status, signal, error, stdout, stderr, observation });
    });
    // spawnSync sends EOF when there is no input; keep that contract here.
    child.stdin.end();
  });
}

class ReaderControlStream extends EventEmitter implements ReaderStream {
  setEncoding(_encoding: "utf8"): void {}
}
class ReaderControlChild extends EventEmitter implements ReaderChild {
  pid = 123;
  stdinEnded = false;
  killedWith: NodeJS.Signals | undefined;
  stdin = {
    end: () => {
      this.stdinEnded = true;
    },
  };
  stdout = new ReaderControlStream();
  stderr = new ReaderControlStream();
  kill(signal: NodeJS.Signals) {
    this.killedWith = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}
function readerControlChild() {
  return new ReaderControlChild();
}

for (const outcome of ["success", "failure", "spawn-error", "timeout", "overflow"]) {
  void test(`first reader observation control: ${outcome}`, async () => {
    const child = readerControlChild();
    const spawnError = Object.assign(new Error("missing owned control"), { code: "ENOENT" });
    const result = await observeFirstReader(
      "owned-control",
      ["unchanged-command"],
      { timeout: 20 },
      {
        spawn: () => {
          queueMicrotask(() => {
            if (outcome === "spawn-error") child.emit("error", spawnError);
            else child.emit("spawn");
            if (outcome === "timeout") return;
            if (outcome === "overflow") child.stdout.emit("data", "x".repeat(1024 * 1024 + 1));
            else if (outcome !== "spawn-error") {
              child.stdout.emit("data", "original-output");
              child.stderr.emit("data", "first-marker");
            }
            if (outcome !== "overflow") child.emit("close", outcome === "failure" ? 7 : 0, null);
          });
          return child;
        },
        readStatus: async () => "State:\tR (running)\nVmRSS:\t100 kB\nThreads:\t1\n",
      },
    );
    assert.ok(result.observation.closed_ms !== null);
    assert.equal(child.stdinEnded, true);
    if (outcome === "timeout" || outcome === "overflow") {
      assert.equal(child.killedWith, "SIGTERM");
      assert.ok(result.error);
      assert.equal(result.error.code, outcome === "timeout" ? "ETIMEDOUT" : "ENOBUFS");
      assert.equal(result.status, null);
      assert.equal(result.signal, "SIGTERM");
      assert.equal(result.observation.deadline_reached, outcome === "timeout");
    } else if (outcome === "spawn-error") {
      assert.equal(result.error, spawnError);
      assert.equal(result.observation.spawned_ms, null);
    } else {
      assert.equal(result.error, null);
      assert.equal(result.status, outcome === "failure" ? 7 : 0);
      assert.equal(result.stdout, "original-output");
      assert.equal(result.stderr, "first-marker");
      assert.ok(result.observation.first_stderr_ms !== null);
    }
  });
}

void test("first reader observation ignores a sample finishing after close", async () => {
  const child = readerControlChild();
  let finishSample: ((value: string) => void) | undefined;
  const result = await observeFirstReader(
    "owned-control",
    [],
    { timeout: 20 },
    {
      spawn: () => {
        queueMicrotask(() => {
          child.emit("spawn");
          child.emit("close", 0, null);
        });
        return child;
      },
      readStatus: () =>
        new Promise((resolve) => {
          finishSample = resolve;
        }),
    },
  );
  const closed = structuredClone(result.observation);
  if (process.platform === "linux") {
    assert.ok(finishSample);
    finishSample("State:\tR (running)\n");
    await Promise.resolve();
    assert.deepEqual(result.observation, closed);
  }
  assert.equal(child.killedWith, undefined);
});

// Hosted first-reader evidence in PR #2038 spent 7.2s before stderr and then
// waited in Get-Content at the old 10s deadline. Seven bounded invocations can
// take 140s, so retain another 40s for diagnostics/cleanup; no retries or product
// deadlines change. Preserve the original failure rather than calling this a
// causal repair of host disk contention.
void test(
  "repository toolchain reader exports the declared components before installation",
  { timeout: 180_000 },
  async (context) => {
    const readerTimeoutMs = 20_000;
    const setup = await readFile(
      new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
      "utf8",
    );
    const body = setup.match(
      /- name: Read repository toolchain[\s\S]*?run: \|\r?\n([\s\S]*?)(?= {4}- uses:)/,
    )?.[1];
    assert.ok(body);
    const script = body.replace(/^ {8}/gm, "");
    assert.doesNotMatch(script, /\$portcoveReaderClock\b/);
    const phaseDiagnostic = (phase: string) =>
      `[Console]::Error.WriteLine("portcove-reader-phase:${phase};elapsed_ms=$($portcoveReaderClock.ElapsedMilliseconds)")`;
    let tracedScript = script;
    for (const [line, phase] of [
      ["$config = Get-Content rust-toolchain.toml -Raw", "read-config"],
      ["$channel = $Matches[1]", "channel-parsed"],
      ["$components = ConvertFrom-Json $Matches[1] -NoEnumerate", "parse-components"],
      ['"channel=$channel" >> $env:GITHUB_OUTPUT', "write-output"],
    ] as const) {
      assert.equal(
        script.split(line).length,
        2,
        `Reader phase must have one source anchor: ${phase}`,
      );
      tracedScript = tracedScript.replace(
        line,
        `${phaseDiagnostic(phase)}\n${line}${phase === "read-config" ? `\n${phaseDiagnostic("config-read")}` : ""}`,
      );
    }
    tracedScript =
      "$portcoveReaderClock = [System.Diagnostics.Stopwatch]::StartNew()\n" +
      `[Console]::Error.WriteLine("portcove-reader-phase:started;pwsh=$($PSVersionTable.PSVersion);elapsed_ms=$($portcoveReaderClock.ElapsedMilliseconds);utc=$([DateTime]::UtcNow.ToString('o'))")\n` +
      tracedScript +
      `\n${phaseDiagnostic("completed")}\n`;
    const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-toolchain-reader-"));
    const output = path.join(directory, "github-output");
    async function runReader(fixture: string, command = tracedScript) {
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const args = ["-NoProfile", "-NonInteractive", "-Command", command];
      const options: SpawnSyncOptionsWithStringEncoding = {
        cwd: directory,
        env: { ...process.env, GITHUB_OUTPUT: output },
        encoding: "utf8",
        windowsHide: true,
        timeout: readerTimeoutMs,
      };
      const result =
        fixture === "valid-1"
          ? await observeFirstReader("pwsh", args, options)
          : spawnSync("pwsh", args, options);
      const stream = (value: string | null | undefined) => ({
        text: (value ?? "").slice(0, 8_192),
        bytes: Buffer.byteLength(value ?? "", "utf8"),
        truncated: (value ?? "").length > 8_192,
      });
      context.diagnostic(
        JSON.stringify({
          reader_fixture: fixture,
          first_invocation_observation: "observation" in result ? result.observation : null,
          observation_order: "reader-then-startup; startup is diagnostic-only",
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          os_release: os.release(),
          runner_image: process.env.ImageOS ?? null,
          runner_image_version: process.env.ImageVersion ?? null,
          started_at: startedAt,
          elapsed_ms: performance.now() - started,
          timeout_ms: readerTimeoutMs,
          status: result.status,
          signal: result.signal,
          error: result.error
            ? {
                code: errorCode(result.error),
                errno: isRecord(result.error) ? result.error.errno : undefined,
                message: result.error.message,
              }
            : null,
          stdout: stream(result.stdout),
          stderr: stream(result.stderr),
        }),
      );
      return result;
    }
    try {
      for (const [index, components] of [
        ["clippy", "rustfmt", "rust-analyzer"],
        ["rust-src", "rust-analyzer", "clippy", "rustfmt"],
      ].entries()) {
        await writeFile(
          path.join(directory, "rust-toolchain.toml"),
          `[toolchain]\nchannel = "1.98.1"\ncomponents = ${JSON.stringify(components)}\n`,
        );
        await writeFile(output, "");
        const result = await runReader(`valid-${index + 1}`);
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const phases = [
          ...result.stderr.matchAll(
            /portcove-reader-phase:([a-z-]+);(?:pwsh=[^;\r\n]+;)?elapsed_ms=(\d+)/g,
          ),
        ];
        assert.deepEqual(
          phases.map((phase) => phase[1]),
          [
            "started",
            "read-config",
            "config-read",
            "channel-parsed",
            "parse-components",
            "write-output",
            "completed",
          ],
        );
        assert.ok(
          phases.every(
            (phase, index) =>
              index === 0 || Number(phase[2]) >= Number(requiredFixture(phases[index - 1])[2]),
          ),
        );
        assert.match(result.stderr, /;utc=\d{4}-\d{2}-\d{2}T[^\r\n]+Z/);
        assert.deepEqual((await readFile(output, "utf8")).trim().split(/\r?\n/), [
          "channel=1.98.1",
          `components=${components.join(",")}`,
        ]);
      }
      for (const [index, declaration] of [
        "",
        'components = "clippy"',
        'components = ["clippy", 7]',
        'components = ["clippy", "rustfmt\\nextra=value"]',
      ].entries()) {
        await writeFile(
          path.join(directory, "rust-toolchain.toml"),
          `[toolchain]\nchannel = "1.98.1"\n${declaration}\n`,
        );
        await writeFile(output, "");
        const result = await runReader(`invalid-${index + 1}`);
        assert.ifError(result.error);
        assert.notEqual(result.status, 0, declaration);
        assert.equal(await readFile(output, "utf8"), "");
      }
    } finally {
      try {
        // Observe startup after the reader without warming its first invocation.
        // This result cannot replace the reader verdict or explain an earlier timeout.
        await runReader(
          "startup-after-reader-diagnostic-only",
          '[Console]::Error.WriteLine("portcove-startup-discriminator:entered"); ' +
            "[PSCustomObject]@{version=$PSVersionTable.PSVersion.ToString();executable=[Environment]::ProcessPath} | ConvertTo-Json -Compress",
        );
      } catch {
        // Best-effort diagnostics must preserve the original reader failure.
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);

void test("repository Rust setup provisions components before ordinary identity probes", async () => {
  const setup = await readFile(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    "utf8",
  );
  assert.match(setup, /components: \$\{\{ steps\.repository-toolchain\.outputs\.components \}\}/);
  assert.match(
    setup,
    /PORTCOVE_COMPONENTS: \$\{\{ steps\.repository-toolchain\.outputs\.components \}\}/,
  );
  const installed = setup.indexOf(
    "& rustup component list --toolchain $env:PORTCOVE_TOOLCHAIN --installed",
  );
  assert.ok(installed >= 0 && installed < setup.indexOf("& rustc --version --verbose"));
  assert.doesNotMatch(setup, /RUSTUP_TOOLCHAIN|& (?:rustc|cargo) \+/);
});

void test("Rust setup installs the repository pin instead of an unrelated stable toolchain", async () => {
  const setup = await readFile(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    "utf8",
  );
  assert.match(setup, /Get-Content rust-toolchain\.toml -Raw/);
  assert.match(setup, /toolchain: \$\{\{ steps\.repository-toolchain\.outputs\.channel \}\}/);
  assert.match(setup, /targets: \$\{\{ inputs\.targets \}\}/);
  assert.doesNotMatch(workflow, /uses: dtolnay\/rust-toolchain/);
  for (const section of [
    rustTests,
    rustWorkspaceTests,
    rustClippy,
    nativeRust,
    intelBuild,
    intelTests,
    rustDocs,
    rustQuality,
  ]) {
    assert.match(section, /uses: \.\/\.github\/actions\/setup-rust/);
  }
  assert.match(setup, /node scripts\/run-rust-tests\.mts --prepare-only/);
  assert.match(setup, /Record exact Rust toolchain and job context/);
  assert.match(setup, /rustc --version --verbose/);
  assert.match(setup, /cargo --version/);
  assert.match(setup, /github\.run_attempt/);
  assert.match(setup, /github\.sha/);
  assert.match(setup, /IsNullOrWhiteSpace\(\$env:PORTCOVE_TARGETS\)/);
  assert.match(setup, /host only/);
  assert.match(setup, /Cache state is not inferred from the attempt number/);
  for (const section of [rustTests, rustWorkspaceTests, nativeRust, intelTests, rustQuality]) {
    assert.match(section, /test-fixtures: true/);
  }
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  assert.match(recipes, /node scripts\/run-rust-tests\.mts --locked --workspace/);
});

void test("release, rehearsal and deep audit Rust callers preserve repository pin, components, targets and caches", async (t) => {
  const setup = await readFile(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    "utf8",
  );
  const toolchain = await readFile(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
  const components: unknown = JSON.parse(
    requiredFixture(toolchain.match(/^components\s*=\s*(\[[^\n]+\])/m)?.[1]),
  );
  assert.ok(Array.isArray(components));
  const componentValues: unknown[] = components;
  assert.ok(componentValues.every((value): value is string => typeof value === "string"));
  assert.deepEqual(componentValues.toSorted(), ["clippy", "rust-analyzer", "rustfmt"]);
  assert.match(setup, /Get-Content rust-toolchain\.toml -Raw/);
  assert.match(setup, /toolchain: \$\{\{ steps\.repository-toolchain\.outputs\.channel \}\}/);
  assert.match(setup, /targets: \$\{\{ inputs\.targets \}\}/);
  // Ordinary shims honor the TOML's component requirements before reporting identity.
  assert.match(setup, /& rustc --version --verbose/);
  assert.match(setup, /& cargo --version/);
  assert.doesNotMatch(setup, /RUSTUP_TOOLCHAIN|& (?:rustc|cargo) \+/);
  assert.doesNotMatch(toolchain, /^targets\s*=/m);

  function job(source: string, name: string) {
    const section = source.match(
      new RegExp(`^ {2}${name}:\\r?\\n([\\s\\S]*?)(?=^ {2}\\S|$(?![\\s\\S]))`, "m"),
    )?.[1];
    assert.ok(section, `missing ${name} job`);
    return section;
  }

  function steps(source: string, reference: string) {
    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      source.match(new RegExp(`^ {6}- uses: ${escaped}\\r?\\n(?: {8}[^\\r\\n]*\\r?\\n)*`, "gm")) ??
      []
    );
  }

  function assertHostSetup(section: string, cacheSetting?: string) {
    assert.deepEqual(steps(section, "./.github/actions/setup-rust"), [
      "      - uses: ./.github/actions/setup-rust\n",
    ]);
    assert.doesNotMatch(
      section,
      /dtolnay\/rust-toolchain|RUSTUP_TOOLCHAIN|(?:rustc|cargo) \+|rustup (?:default|override|toolchain|component|target)/,
    );
    const cache = steps(
      section,
      "Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0 # v2.9.3",
    );
    assert.deepEqual(
      cache.map((step: string) => step.replace(/^ {10}#.*\r?\n/gm, "")),
      [
        "      - uses: Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0 # v2.9.3\n" +
          (cacheSetting ? `        with:\n          ${cacheSetting}\n` : ""),
      ],
    );
    assert.ok(
      section.indexOf("uses: ./.github/actions/setup-rust") <
        section.indexOf("uses: Swatinem/rust-cache@"),
    );
  }

  for (const [file, name, cacheSetting] of [
    ["release.yml", "validate", undefined],
    ["linux-package-ownership-rehearsal.yml", "build", "key: linux-package-ownership-rehearsal"],
    ["updater-artifact-rehearsal.yml", "packages", "key: updater-artifact-rehearsal"],
    ["deep-quality.yml", "audit", "shared-key: deep-quality-ubuntu-22.04"],
  ] as const) {
    await t.test(`${file} ${name}`, async () => {
      const source = await readFile(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf8",
      );
      const section = job(source, name);
      assertHostSetup(section, cacheSetting);
      for (const replacement of [
        "      - uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c\n",
        "      - uses: ./.github/actions/setup-rust\n        with:\n          toolchain: stable\n",
        "      - uses: ./.github/actions/setup-rust\n        with:\n          targets: aarch64-unknown-linux-gnu\n",
        "      - uses: ./.github/actions/setup-rust\n        with:\n          test-fixtures: true\n",
      ]) {
        assert.throws(() =>
          assertHostSetup(
            section.replace("      - uses: ./.github/actions/setup-rust\n", replacement),
            cacheSetting,
          ),
        );
      }
      assert.throws(() =>
        assertHostSetup(
          section.replace(
            "Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0",
            "Swatinem/rust-cache@floating",
          ),
          cacheSetting,
        ),
      );
      if (cacheSetting)
        assert.throws(() =>
          assertHostSetup(section.replace(cacheSetting, "key: changed"), cacheSetting),
        );
      if (file === "release.yml") {
        for (const [crossJob, target, key] of [
          ["build", "${{ matrix.target }}", "release-${{ matrix.label }}"],
          ["build_intel", "x86_64-apple-darwin", "release-macos-x86_64"],
        ] as const) {
          const cross = job(source, crossJob);
          assert.deepEqual(steps(cross, "./.github/actions/setup-rust"), [
            `      - uses: ./.github/actions/setup-rust\n        with:\n          targets: ${target}\n`,
          ]);
          assert.match(
            cross,
            new RegExp(`shared-key: ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
          );
        }
      }
    });
  }
});

void test("Playnite qualification installs pinned workspace dependencies before its lifecycle consumer", () => {
  const setup = rustWorkspaceTests.indexOf(
    "      - name: Install pinned dependencies for Playnite transport validation\n",
  );
  const consumer = rustWorkspaceTests.indexOf(
    "      - name: Build and test the public Playnite reference consumer\n",
  );
  assert.ok(setup >= 0 && consumer > setup);
  const dependencies = rustWorkspaceTests.slice(setup, consumer);
  assert.match(
    dependencies,
    /uses: voidzero-dev\/setup-vp@68f39c78aaf39be468cabd2afb09c162574c84af/,
  );
  assert.match(dependencies, /version-file: pnpm-workspace\.yaml/);
  assert.match(dependencies, /node-version-file: \.node-version/);
  assert.match(dependencies, /args: \[--frozen-lockfile\]/);
  assert.doesNotMatch(dependencies, /--prod|--filter|--ignore-scripts|continue-on-error/);
  assert.match(rustWorkspaceTests.slice(consumer), /\.\/integrations\/playnite\/check\.ps1 -Cli/);
  assert.doesNotMatch(rustWorkspaceTests.slice(consumer), /-ContractsOnly/);
});

void test("Windows Rust keeps exhaustive parallel gates without duplicate setup", () => {
  assert.match(rustTests, /^ {4}name: rust-test \(\$\{\{ matrix\.shard \}\}\)$/m);
  assert.match(rustTests, /runs-on: windows-latest/);
  assert.match(
    rustTests,
    /shard:\s*\[\s*core-service-1,\s*core-service-2,\s*core-recovery,\s*core-other-1,\s*core-other-2,?\s*\]/,
  );
  for (const shard of [
    "service::",
    "cancellation::",
    "database::",
    "import_execution::",
    "library_move::",
  ]) {
    assert.match(rustTests, new RegExp(`"${shard.replaceAll("::", "::")}"`));
  }
  assert.match(
    rustTests,
    /"--skip", "service::", "--skip", "cancellation::", "--skip", "database::", "--skip", "import_execution::", "--skip", "library_move::"/,
  );
  assert.equal((rustTests.match(/"hash:1\/2"/g) ?? []).length, 2);
  assert.equal((rustTests.match(/"hash:2\/2"/g) ?? []).length, 2);
  assert.doesNotMatch(rustTests, /workspace-other|pnpm|cargo check|cargo fmt|cargo clippy/);

  assert.match(rustWorkspaceTests, /^ {4}name: rust-test \(workspace-other\)$/m);
  assert.match(rustWorkspaceTests, /runs-on: windows-latest/);
  assert.match(
    rustWorkspaceTests,
    /cargo nextest run --locked --workspace --exclude portcove-core/,
  );
  assert.doesNotMatch(rustWorkspaceTests, /matrix|cargo fmt|cargo clippy/);

  assert.match(rustClippy, /^ {4}name: rust-clippy$/m);
  assert.match(rustClippy, /runs-on: windows-latest/);
  assert.match(rustClippy, /cargo fmt --all -- --check/);
  assert.match(rustClippy, /cargo clippy --workspace --all-targets -- -D warnings/);
  assert.doesNotMatch(rustClippy, /cargo test|matrix/);

  assert.match(rustQuality, /runs-on: ubuntu-latest/);
  assert.match(rustQuality, /cargo clippy --workspace --all-targets -- -D warnings/);

  assert.match(windowsStorage, /^ {4}name: windows-storage$/m);
  assert.match(windowsStorage, /runs-on: windows-latest/);
  assert.match(windowsStorage, /scripts\/dev-storage\.test\.mts/);
  assert.match(windowsStorage, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.match(windowsStorage, /scripts\/windows-qualification-session\.test\.mts/);
  assert.match(windowsStorage, /\.\/scripts\/run-windows-qualification\.ps1/);
  assert.match(
    windowsStorage,
    /--test-timeout=30000 --test-reporter=\.\/scripts\/test-duration-reporter\.mts/,
  );
  assert.match(
    windowsStorage,
    /Install-PSResource -RequiredResourceFile \.config\/powershell-resources\.psd1 -Scope CurrentUser -TrustRepository/,
  );
  assert.match(windowsStorage, /run-powershell-lint\.mts/);
  assert.match(windowsStorage, /lint-tools\.integration\.mts psscriptanalyzer/);
  assert.doesNotMatch(windowsStorage, /rust-toolchain|rust-cache|cargo/);
  assert.doesNotMatch(windowsStorage, /continue-on-error/);

  assert.match(rust, /^ {4}if: always\(\)$/m);
  for (const dependency of [
    "classify",
    "prose_checks",
    "rust_tests",
    "rust_workspace_tests",
    "rust_clippy",
    "windows_storage",
    "native_rust",
    "intel_build",
    "intel_tests",
    "rust_docs",
  ])
    assert.match(rust, new RegExp(`^ {8}${dependency},?$`, "m"));
  for (const dependency of [
    "rust_tests",
    "rust_workspace_tests",
    "rust_clippy",
    "windows_storage",
    "native_rust",
    "intel_build",
    "intel_tests",
    "rust_docs",
  ])
    assert.ok(rust.includes(`"${dependency}":"` + "${{ needs." + dependency + '.result }}"'));
  assert.doesNotMatch(rust, /continue-on-error/);
});

void test("Windows analyzer acquisition retains the exact pin and both mandatory gates", (t) => {
  const body = windowsStorage.match(
    /- name: Lint PowerShell scripts\r?\n {8}shell: pwsh\r?\n {8}run: \|\r?\n([\s\S]*)/,
  )?.[1];
  assert.ok(body);
  const script = body.replace(/^ {10}/gm, "");
  assert.match(
    script,
    /Import-PowerShellDataFile -LiteralPath \.config\/powershell-resources\.psd1/,
  );
  assert.match(
    script,
    /Get-Module -ListAvailable -Name PSScriptAnalyzer \| Where-Object Version -EQ \$requiredVersion/,
  );
  assert.match(
    script,
    /Import-Module -Name PSScriptAnalyzer -RequiredVersion \$requiredVersion -Force/,
  );
  assert.doesNotMatch(script, /PSModulePath|ModuleBase|continue-on-error|SilentlyContinue/);
  const available = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (errorCode(available.error) === "ENOENT" && process.platform !== "win32") {
    t.skip("PowerShell unavailable; required Windows job executes this contract");
    return;
  }
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stdout + available.stderr);
  const mocks = `
$ErrorActionPreference = 'Stop'
$script:pin = [string](Import-PowerShellDataFile -LiteralPath .config/powershell-resources.psd1).PSScriptAnalyzer.version
$script:available = @($env:PORTCOVE_ANALYZER_VERSIONS | ConvertFrom-Json)
function Get-Module {
  param([switch]$ListAvailable, [string]$Name)
  if (-not $ListAvailable -or $Name -ne 'PSScriptAnalyzer') { throw 'unexpected module lookup' }
  $script:available | ForEach-Object { [pscustomobject]@{ Version = [version]$_ } }
}
function Install-PSResource {
  param([string]$RequiredResourceFile, [string]$Scope, [switch]$TrustRepository)
  if ($RequiredResourceFile -ne '.config/powershell-resources.psd1' -or $Scope -ne 'CurrentUser' -or -not $TrustRepository) { throw 'changed acquisition contract' }
  Write-Output 'acquire-exact-pin'
  if ($env:PORTCOVE_ANALYZER_FAILURE -eq 'acquisition') { throw 'acquisition failed' }
  $script:available = @($script:pin)
}
function Import-Module {
  param([string]$Name, [string]$RequiredVersion, [switch]$Force)
  if ($Name -ne 'PSScriptAnalyzer' -or $RequiredVersion -ne $script:pin -or -not $Force) { throw 'changed import contract' }
  Write-Output 'import-exact-pin'
  if ($script:available -notcontains $RequiredVersion -or $env:PORTCOVE_ANALYZER_FAILURE -eq 'import') { throw 'exact import failed' }
}
function node {
  param([string]$Script, [string]$Fixture)
  Write-Output "gate:$Script"
  if ($Script -eq 'scripts/run-powershell-lint.mts' -and -not $Fixture) {
    $global:LASTEXITCODE = [int]($env:PORTCOVE_ANALYZER_FAILURE -eq 'lint')
  } elseif ($Script -eq 'scripts/lint-tools.integration.mts' -and $Fixture -eq 'psscriptanalyzer') {
    $global:LASTEXITCODE = [int]($env:PORTCOVE_ANALYZER_FAILURE -eq 'fixture')
  } else { throw 'changed mandatory gate' }
}
`;
  for (const [versions, failure, acquisition, gates, success] of [
    [["1.25.0"], "", false, 2, true],
    [["1.24.0", "1.25.0", "1.26.0"], "", false, 2, true],
    [[], "", true, 2, true],
    [["1.24.0", "1.26.0"], "", true, 2, true],
    [[], "acquisition", true, 0, false],
    [["1.25.0"], "import", false, 0, false],
    [["1.25.0"], "lint", false, 1, false],
    [["1.25.0"], "fixture", false, 2, false],
  ] as const) {
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-Command", mocks + script],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          PORTCOVE_ANALYZER_VERSIONS: JSON.stringify(versions),
          PORTCOVE_ANALYZER_FAILURE: failure,
        },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.ifError(result.error);
    const context = JSON.stringify({ versions, failure }) + result.stdout + result.stderr;
    assert.equal(result.status === 0, success, context);
    assert.equal(result.stdout.includes("acquire-exact-pin"), acquisition, context);
    assert.equal((result.stdout.match(/gate:/g) ?? []).length, gates, context);
    assert.equal(result.stdout.includes("import-exact-pin"), failure !== "acquisition", context);
  }
});

void test("Windows fixture setup selects runner-owned temporary storage before compilation", async () => {
  const setup = await readFile(
    new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
    "utf8",
  );
  const selection = setup.indexOf("name: Select Windows test temporary storage");
  assert.ok(selection >= 0 && selection < setup.indexOf("name: Read repository toolchain"));
  assert.match(setup, /if: runner\.os == 'Windows' && inputs\.test-fixtures == 'true'/);
  assert.match(windowsStorage, /scripts\/ci-workflow\.test\.mts/);
});

void test(
  "Windows fixture setup exports a usable directory and rejects invalid roots without partial exports",
  { skip: process.platform !== "win32" },
  async () => {
    const { mkdtemp, mkdir, writeFile, realpath, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const setup = await readFile(
      new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
      "utf8",
    );
    const body = setup.match(
      /- name: Select Windows test temporary storage[\s\S]*?run: \|\r?\n([\s\S]*?)(?= {4}- name:)/,
    )?.[1];
    assert.ok(body);
    const script = body.replace(/^ {8}/gm, "");
    const base = path.resolve(tmpdir());
    const directory = await mkdtemp(path.join(base, "portcove-ci-temp-"));
    try {
      const selected = path.join(directory, "runner temporary files");
      const environmentFile = path.join(directory, "github-env");
      const notDirectory = path.join(directory, "file");
      await mkdir(selected);
      await writeFile(notDirectory, "fixture");
      const invoke = (command: string, env: NodeJS.ProcessEnv) =>
        spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
          env: { ...process.env, ...env },
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        });
      const selectedIdentity = await realpath(selected);
      for (const selectedPath of [selected, `${selected}${path.sep}.`]) {
        await writeFile(environmentFile, "");
        const result = invoke(script, {
          RUNNER_TEMP: selectedPath,
          GITHUB_ENV: environmentFile,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const exported = Object.fromEntries(
          (await readFile(environmentFile, "utf8"))
            .trim()
            .split(/\r?\n/)
            .map((line) => {
              const delimiter = line.indexOf("=");
              return [line.slice(0, delimiter), line.slice(delimiter + 1)];
            }),
        );
        assert.deepEqual(exported, {
          TEMP: selectedIdentity,
          TMP: selectedIdentity,
        });
        const consumer = invoke("[System.IO.Path]::GetTempPath()", exported);
        assert.ifError(consumer.error);
        assert.equal(consumer.status, 0, consumer.stderr);
        assert.equal(await realpath(consumer.stdout.trim()), selectedIdentity);
      }
      for (const invalid of [
        "",
        "relative",
        path.join(directory, "missing"),
        notDirectory,
        `${selected}\nUNEXPECTED=value`,
      ]) {
        await writeFile(environmentFile, "");
        const rejected = invoke(script, {
          RUNNER_TEMP: invalid,
          GITHUB_ENV: environmentFile,
        });
        assert.ifError(rejected.error);
        assert.notEqual(rejected.status, 0, `accepted invalid root ${JSON.stringify(invalid)}`);
        assert.equal(await readFile(environmentFile, "utf8"), "");
      }
    } finally {
      const relative = path.relative(base, directory);
      assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test("Windows qualification serializes machine-global registry fixtures with a bounded lock", () => {
  const wrapper = windowsQualificationRunner;
  assert.match(wrapper, /Local\\Portcove\.WindowsQualification\.v1/);
  assert.match(wrapper, /WaitOne\(\[TimeSpan\]::FromSeconds\(\$WaitSeconds\)\)/);
  assert.match(wrapper, /AbandonedMutexException/);
  assert.match(wrapper, /finally \{[\s\S]*ReleaseMutex\(\)[\s\S]*Dispose\(\)/);
  assert.match(
    wrapper,
    /node --test scripts\/windows-qualification-session\.integration\.test\.mts/,
  );
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
  assert.match(nativeRust, /cargo nextest run --locked --workspace/);
  assert.match(nativeRust, /--partition "\$\{\{ matrix\.partition \}\}"/);
  assert.doesNotMatch(nativeRust, /continue-on-error/);
});

void test("release qualification profile connects bounded matrices and skips only absent macOS coverage", () => {
  assert.match(
    workflow,
    /PORTCOVE_RELEASE_PROFILE: \$\{\{ inputs\.release_profile \|\| 'full' \}\}/,
  );
  assert.match(
    workflow,
    /PORTCOVE_QUALIFICATION_CALLER: \$\{\{ inputs\.qualification_caller \|\| '' \}\}/,
  );
  assert.match(workflow, /PORTCOVE_CALLER_WORKFLOW: \$\{\{ inputs\.caller_workflow \|\| '' \}\}/);
  assert.match(
    qualificationWorkflow,
    /release_profile: \$\{\{ inputs\.release_profile \|\| 'full' \}\}/,
  );
  assert.match(
    rustDocs,
    /include: \$\{\{ fromJSON\(needs\.classify\.outputs\.qualification_docs_matrix_json\) \}\}/,
  );
  for (const body of [intelBuild, intelTests])
    assert.match(
      body,
      /if: needs\.classify\.outputs\.mode == 'qualification' && contains\(fromJSON\(needs\.classify\.outputs\.platforms_json\), 'macos-x86_64'\)/,
    );
  const portability = workflow.split("  frontend_portability:")[1] ?? "";
  assert.match(
    portability,
    /if: \(needs\.classify\.outputs\.mode == 'qualification' && contains\(fromJSON\(needs\.classify\.outputs\.platforms_json\), 'macos-aarch64'\)\)/,
  );
  const beta = discoverCiPlan({
    eventName: "workflow_dispatch",
    checkoutSha: "a".repeat(40),
    forceQualification: true,
    qualificationCaller: "release",
    callerWorkflow: "release.yml",
    releaseProfile: "initial-beta-win-linux",
  });
  assert.deepEqual(
    qualificationMatrices(beta).native.map(({ platform }) => platform),
    ["linux-x86_64"],
  );
  assert.deepEqual(
    qualificationMatrices(beta).docs.map(({ platform }) => platform),
    ["linux-x86_64", "windows-x86_64"],
  );
  for (const body of [
    rustTests,
    rustWorkspaceTests,
    windowsStorage,
    nativeRust,
    rustDocs,
    rustQuality,
    frontend,
    catalog,
  ])
    assert.match(body, /if: needs\.classify\.outputs\.mode == 'qualification'/);
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
  assert.match(intelTests, /needs: \[classify, intel_build\]/);
  assert.match(intelTests, /runs-on: macos-15-intel/);
  assert.match(intelTests, /partition:\s*\[\s*"hash:1\/2",\s*"hash:2\/2",?\s*\]/);
  assert.match(
    intelTests,
    /cargo nextest run --archive-file .* --workspace-remap "\$PWD" --partition "\$\{\{ matrix\.partition \}\}"/,
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

void test("Linux Rust quality keeps its platform-specific and policy gates without pnpm", () => {
  assert.match(rustQuality, /runs-on: ubuntu-latest/);
  assert.match(rustQuality, /AQUA_ENFORCE_CHECKSUM: "true"/);
  assert.match(rustQuality, /AQUA_ENFORCE_REQUIRE_CHECKSUM: "true"/);
  assert.match(rustQuality, /aquaproj\/aqua-installer@611554c6f0137ba41c8dd15aca8bee82504ea461/);
  assert.match(rustQuality, /aqua_version: \$\{\{ steps\.aqua-version\.outputs\.version \}\}/);
  assert.match(rustQuality, /enable_aqua_install: "false"/);
  assert.doesNotMatch(
    rustQuality,
    /machine_contract|backup_directory_durability_support_is_explicit_for_the_host/,
  );
  assert.match(nativeRust, /cargo nextest run --locked --workspace/);
  assert.match(rustQuality, /cargo shear --deny-warnings/);
  assert.match(rustQuality, /node scripts\/dependency-security\.mts/);
  assert.doesNotMatch(rustQuality, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(rustQuality, /check-rust-architecture\.mts/);
  assert.match(rustQuality, /run-rscheck\.mts/);
  const bootstrap = rustQuality.indexOf("./scripts/bootstrap-quality-tools.sh");
  for (const lint of ["aqua exec -- ruff", "aqua exec -- shellcheck", "run-actionlint.mts"]) {
    assert.ok(
      rustQuality.indexOf(lint) > bootstrap,
      `${lint} must run after the aqua tools are installed`,
    );
  }
  assert.match(rustQuality, /lint-tools\.integration\.mts ruff shellcheck actionlint/);
  const desktopPrerequisites = rustQuality.indexOf(
    "./scripts/install-linux-desktop-prerequisites.sh",
  );
  assert.ok(
    desktopPrerequisites >= 0 &&
      desktopPrerequisites < rustQuality.indexOf("node scripts/check-transport-contract.mts"),
  );
  assert.match(rustQuality, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.doesNotMatch(rustQuality, /pnpm\/action-setup|pnpm install/);
  assert.doesNotMatch(rustQuality, /continue-on-error/);
});

void test("frontend keeps deterministic product gates and delegates vulnerability changes", () => {
  assert.match(frontend, /^ {4}env:\r?\n {6}npm_config_audit: "false"$/m);
  assert.match(frontend, /args: \[--frozen-lockfile\]/);
  assert.match(frontend, /Install pinned recipe runner/);
  const install = frontend.indexOf("args: [--frozen-lockfile]");
  const verify = frontend.indexOf("node scripts/run-viteplus.mts run frontend:verify");
  assert.ok(install >= 0 && verify > install);
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
  const full = requiredFixture(
    requiredFixture(workflow.split("  frontend_full:")[1]).split("  frontend:")[0],
  );
  const provision = full.indexOf("pnpm browser:bootstrap"),
    run = full.indexOf("run frontend:verify");
  assert.ok(provision >= 0 && run > provision);
  assert.match(full, /browser-traces-full/);
  assert.match(full, /work\/bt/);
  assert.doesNotMatch(full, /work\/browser-traces/);
  const jobBoundary = /\n {2}[a-zA-Z][a-zA-Z_-]*:/u;
  const fast = requiredFixture(
    requiredFixture(workflow.split("  fast_frontend:")[1]).split(jobBoundary)[0],
  );
  assert.match(fast, /browser-runtime.mts bootstrap/);
  const contributor = requiredFixture(
    requiredFixture(workflow.split("  frontend_portability:")[1]).split(jobBoundary)[0],
  );
  const contributorProvision = contributor.indexOf("pnpm --dir apps/desktop browser:bootstrap");
  assert.ok(contributorProvision >= 0);
  assert.ok(contributor.indexOf("pnpm verify:frontend") > contributorProvision);
  assert.equal(contributor.match(/run: pnpm verify:frontend/g)?.length, 1);
  assert.doesNotMatch(contributor, /run: pnpm (?:test|check|build)\b/);
  const deep = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  const audit = requiredFixture(
    requiredFixture(deep.split("  audit:")[1]).split("  local_check:")[0],
  );
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
  for (const [name, block] of [
    ["full", full],
    ["fast", fast],
    ["contributor", contributor],
  ] as const) {
    const uploadIndex = block.indexOf(`name: browser-traces-${name}-`);
    assert.ok(uploadIndex >= 0, `${name} must preserve failed browser evidence`);
    const stepStart = block.lastIndexOf("      - name:", uploadIndex);
    assert.ok(stepStart >= 0);
    const nextStep = block.indexOf("\n      - name:", uploadIndex);
    const upload = block.slice(uploadIndex, nextStep < 0 ? undefined : nextStep);
    const prefix = block.slice(stepStart, uploadIndex);
    assert.match(
      prefix,
      name === "contributor"
        ? /if: failure\(\)\r?\n +uses: actions\/upload-artifact@/
        : /if: always\(\)\r?\n +uses: actions\/upload-artifact@/,
    );
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
    assert.match(upload, /include-hidden-files: true/);
    assert.match(upload, /retention-days: 7/);
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
  const document = parseDocument(workflow, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const parsed: unknown = document.toJS();
  assert.ok(isRecord(parsed) && isRecord(parsed.jobs));
  for (const id of ["fast_frontend", "frontend_full", "frontend_portability"]) {
    const job = parsed.jobs[id];
    assert.ok(isRecord(job) && Array.isArray(job.steps));
    const upload: unknown = job.steps.find(
      (step: unknown) =>
        isRecord(step) &&
        isRecord(step.with) &&
        typeof step.with.name === "string" &&
        step.with.name.startsWith("browser-traces-"),
    );
    assert.ok(isRecord(upload) && isRecord(upload.with) && typeof upload.with.path === "string");
    const patterns = upload.with.path
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
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

void test("ordinary tooling contracts select the workflow contract and full CI retains its inventory", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const { buildValidationPlan } = await import("./validation-plan.mts");
  const file = ".github/workflows/ci.yml";
  const p = buildValidationPlan({
    changes: [{ status: "M", oldMode: "100644", newMode: "100644", oldPath: file, newPath: file }],
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });
  assert.ok(baselineContractTests(p).includes("scripts/ci-workflow.test.mts"));
  assert.match(requiredFixture(workflow.split("  catalog_full:")[1]), /ci-workflow\.test\.mts/);
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

void test("validation recipes separate routine, release, and packaged Windows contracts", async () => {
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  const routine = recipes.match(/^check: (.+)$/m)?.[1] ?? "";
  assert.match(
    routine,
    /check-rust check-ui script-lint repository-tools roadmap-check development-tools/,
  );
  assert.doesNotMatch(routine, /release-check|windows-qualification/);
  const release = recipes.match(/^release-check:\r?\n([\s\S]*?)(?=^\S)/m)?.[1] ?? "";
  assert.match(release, /check-release-metadata\.test\.mts/);
  assert.match(release, /release-package-policy\.test\.mts/);
  assert.match(release, /updater-artifact-inventory\.test\.mts/);
  assert.match(release, /reconstruct-application-update-records\.test\.mts/);
  assert.match(release, /windows-qualification-session\.test\.mts/);
  assert.doesNotMatch(release, /windows-qualification-session\.integration\.test\.mts/);
  for (const generic of [
    "ci-workflow.test.mts",
    "ci-health.test.mts",
    "test-duration-reporter.test.mts",
    "quality-tools.test.mts",
    "repository-settings.test.mts",
    "pr-conventions.test.mts",
    "dev-storage.test.mts",
  ])
    assert.doesNotMatch(release, new RegExp(generic.replaceAll(".", "\\.")));
  const windows = recipes.match(/^windows-qualification-check:\r?\n([\s\S]*?)(?=^\S)/m)?.[1] ?? "";
  assert.match(windows, /process\.platform !== 'win32'/);
  assert.match(windows, /run-windows-qualification\.ps1/);
  assert.match(catalog, /check-release-metadata\.test\.mts/);
  assert.match(catalog, /release-package-policy\.test\.mts/);
  assert.match(windowsStorage, /run-windows-qualification\.ps1/);
  const ui = recipes.match(/^check-ui: (.+)$/m)?.[1] ?? "";
  assert.equal(ui, "ui-check ui-lint-contracts");
  const auditUi = recipes.match(/^ui-check: (.+)$/m)?.[1] ?? "";
  assert.doesNotMatch(auditUi, /fmt-frontend-check/);
  const recipeBody = (name: string) =>
    recipes.match(new RegExp(`^${name}:\\r?\\n([\\s\\S]*?)(?=^\\S)`, "m"))?.[1] ?? "";
  for (const scan of [
    "fmt-frontend-check",
    "oxlint",
    "stylelint",
    "python-lint",
    "shell-lint",
    "actions-lint",
    "powershell-lint",
  ])
    assert.doesNotMatch(recipeBody(scan), /lint-tools\.integration\.mts/);
  assert.match(
    recipeBody("ui-lint-contracts"),
    /lint-tools\.integration\.mts oxfmt oxlint stylelint/,
  );
  assert.match(
    recipeBody("script-lint-contracts"),
    /lint-tools\.integration\.mts ruff shellcheck actionlint psscriptanalyzer/,
  );
  assert.match(
    recipes.match(/^script-lint: (.+)$/m)?.[1] ?? "",
    /python-lint shell-lint actions-lint powershell-lint script-lint-contracts/,
  );
});

void test("release and deep preflights require a fresh audit", async () => {
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const deep = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  const localPreflight = await readFile(
    new URL("./release-preflight.ps1", import.meta.url),
    "utf8",
  );
  assert.match(release, /just audit --fresh/);
  assert.match(release, /id: aqua-version/);
  assert.match(release, /aquaproj\/aqua-installer@611554c6f0137ba41c8dd15aca8bee82504ea461/);
  assert.match(release, /aqua_version: \$\{\{ steps\.aqua-version\.outputs\.version \}\}/);
  assert.match(release, /enable_aqua_install: "false"/);
  assert.match(deep, /just audit --fresh/);
  assert.match(deep, /id: aqua-version/);
  assert.match(deep, /aquaproj\/aqua-installer@611554c6f0137ba41c8dd15aca8bee82504ea461/);
  assert.match(deep, /aqua_version: \$\{\{ steps\.aqua-version\.outputs\.version \}\}/);
  assert.match(deep, /enable_aqua_install: "false"/);
  assert.match(localPreflight, /just audit --fresh/);
});

void test("manual deep workflow preserves fresh default with explicit bounded audit reuse", async () => {
  const deep = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  assert.match(deep, /^name: Deep audit$/m);
  assert.match(deep, /^ {2}audit:\r?$/m);
  assert.match(deep, /just audit --fresh/);
  assert.match(deep, /default: audit\r?\n {8}options: \[audit, audit-reuse, local-check, fallow\]/);
  assert.doesNotMatch(deep, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(deep, /if: always\(\) && inputs.operation != 'audit-reuse'/);
  assert.doesNotMatch(deep, /actions: read|actions: write|contents: write/);
  assert.doesNotMatch(deep, /^ {2}(?:hawk|duplicates):/m);
  assert.doesNotMatch(deep, /semdup|cargo-hawk|run-hawk|run-semdup|dead-public/i);
});

void test("live upstream health has bounded independent triggers while catalog stays offline", async () => {
  assert.doesNotMatch(catalog, /check-catalog-repositories\.mts/);
  assert.match(catalog, /check-retcomm-upstreams\.mts --offline/);
  const health = await readFile(
    new URL("../.github/workflows/upstream-health.yml", import.meta.url),
    "utf8",
  );
  assert.match(health, /schedule:\r?\n {4}- cron:/);
  assert.match(health, /workflow_dispatch:/);
  assert.match(health, /timeout-minutes: 10/);
  assert.match(health, /^permissions:\r?\n {2}contents: read$/m);
  assert.doesNotMatch(health, /pull_request_target|continue-on-error/);
  for (const trigger of ["pull_request", "push"]) {
    const section = requiredFixture(
      requiredFixture(health.split(`  ${trigger}:`)[1]).split(/^ {2}\w+:/m)[0],
    );
    for (const path of [
      "crates/portcove-core/catalog/**",
      "scripts/retcomm-psx-upstreams.json",
      "scripts/check-catalog-repositories.mts",
      "scripts/check-retcomm-upstreams.mts",
      "scripts/upstream-health-plan.mts",
      "scripts/upstream-health-inputs.mts",
      "scripts/upstream-health-monitor.mts",
      "scripts/upstream-health-*.test.mts",
      "scripts/upstream-lineage.mts",
      "scripts/observe-configured-upstream.mts",
      "scripts/release-path-safety.mts",
      "scripts/runtime-values.mts",
      "scripts/json-values.mts",
      "scripts/select-ci-plan.mts",
      ".github/upstream-health-accounting.json",
      ".node-version",
      ".github/workflows/upstream-health.yml",
    ]) {
      assert.ok(
        section.includes(`'${path}'`) || section.includes(`"${path}"`),
        `${trigger} must cover ${path}`,
      );
    }
  }
  assert.match(health, /run: node scripts\/upstream-health-plan\.mts/);
  assert.match(health, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(health, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(health, /fetch-depth: 0/);
  assert.match(health, /run: node scripts\/upstream-health-monitor\.mts/);
  assert.match(health, /HEALTH_MODE: \$\{\{ steps\.scope\.outputs\.mode \}\}/);
  assert.match(health, /HEALTH_PORT_IDS: \$\{\{ steps\.scope\.outputs\.port_ids \}\}/);
  assert.match(health, /!cancelled\(\) && steps\.monitor\.outputs\.retcomm == 'true'/);
  assert.match(
    health,
    /node scripts\/check-retcomm-upstreams\.mts --port-ids="\$RETCOMM_PORT_IDS"/,
  );
  assert.match(health, /RETCOMM_PORT_IDS: \$\{\{ steps\.monitor\.outputs\.retcomm_port_ids \}\}/);
  const document = parseDocument(health, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const parsed: unknown = document.toJS();
  assert.ok(isRecord(parsed) && isRecord(parsed.jobs));
  const job = parsed.jobs["upstream-health"];
  assert.ok(isRecord(job) && Array.isArray(job.steps));
  const steps: unknown[] = job.steps;
  const monitor = steps.find((entry) => isRecord(entry) && entry.id === "monitor");
  assert.ok(isRecord(monitor));
  assert.equal(monitor.if, "${{ !cancelled() }}");
  const step = (name: string) => {
    const entry: unknown = steps.find((value) => isRecord(value) && value.name === name);
    assert.ok(isRecord(entry) && isRecord(entry.with), `Missing workflow step: ${name}`);
    return { uses: entry.uses, if: entry.if, with: entry.with };
  };
  const restore = step("Restore main observation history");
  const save = step("Preserve trusted main observation history");
  const upload = step("Retain monitoring report");
  assert.equal(restore.uses, "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
  assert.equal(save.uses, "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
  assert.equal(restore.with.path, "work/upstream-health/checkpoint.json");
  assert.equal(save.with.path, restore.with.path);
  assert.equal(restore.with["restore-keys"], "upstream-health-history-v1-main-");
  assert.equal(save.with.key, restore.with.key);
  assert.ok(typeof save.if === "string");
  assert.match(save.if, /!cancelled\(\)/);
  assert.match(save.if, /github\.repository == 'boburning\/portcove'/);
  assert.match(save.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(save.if, /github\.event_name != 'pull_request'/);
  assert.match(save.if, /steps\.monitor\.outputs\.checkpoint_updated == 'true'/);
  assert.equal(upload.if, "${{ !cancelled() }}");
  assert.ok(typeof upload.with.path === "string");
  assert.match(upload.with.path, /work\/upstream-health\/report\.json/);
  assert.match(upload.with.path, /work\/upstream-health\/summary\.md/);
  assert.doesNotMatch(upload.with.path, /checkpoint\.json/);
  assert.equal(upload.with["retention-days"], 7);
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(release, /run: node scripts\/check-retcomm-upstreams\.mts\r?$/m);
});

void test("Rust reports slow tests, terminates hangs and retains documentation coverage", async (t) => {
  const config = await readFile(new URL("../.config/nextest.toml", import.meta.url), "utf8");
  // Parse the actual configuration consumed by nextest, using the same TOML
  // implementation already used by production nextest-equivalence selection.
  const parsed = spawnSync(
    "python",
    ["-c", "import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"],
    { input: config, encoding: "utf8", timeout: 5000, windowsHide: true },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  const document: unknown = JSON.parse(parsed.stdout);
  assert.ok(isRecord(document) && isRecord(document.profile));
  const profile = document.profile.default;
  assert.ok(isRecord(profile));
  assert.deepEqual(profile["slow-timeout"], {
    period: "5s",
    "terminate-after": 6,
    "grace-period": "0s",
  });
  assert.equal(profile.retries, 0);
  assert.equal(profile["fail-fast"], false);
  assert.equal(profile["test-threads"], 2);
  assert.equal(profile["success-output"], undefined);
  assert.equal(profile["default-filter"], undefined);
  assert.ok(Array.isArray(profile.overrides));
  const overrides: Record<string, unknown>[] = profile.overrides.map((value: unknown) => {
    assert.ok(isRecord(value));
    return value;
  });
  // Filters are execution identities, so exact values remain contractual.
  const overrideFor = (filter: string, platform?: string) => {
    const values = overrides.filter(
      (value) => value.filter === filter && (platform === undefined || value.platform === platform),
    );
    assert.equal(values.length, 1, filter);
    return requiredFixture(values[0]);
  };
  for (const filter of [
    "package(portcove-cli)",
    "package(portcove-core) & test(output_relocation::tests::)",
    "package(portcove-core) & test(cancellation::tests::)",
    "package(portcove-core) & test(definition_repository::tests::)",
    "package(portcove-core) & test(activity_diagnostics::tests::)",
    "package(portcove-core) & test(database::tests::)",
    "package(portcove-core) & test(adapter::source_conversion_tests::failed_and_cancelled_conversion_retains_logs_and_reaps_owned_processes)",
  ])
    assert.equal(overrideFor(filter)["threads-required"], 2);
  assert.equal(overrideFor("package(portcove-cli)").priority, -100);
  const argumentContracts = overrideFor("package(portcove-cli) & test(/^args::tests::/)");
  assert.deepEqual(argumentContracts, {
    filter: "package(portcove-cli) & test(/^args::tests::/)",
    priority: 100,
  });
  assert.ok(
    overrides.indexOf(argumentContracts) < overrides.indexOf(overrideFor("package(portcove-cli)")),
    "the first matching priority must run pure command contracts before CLI lifecycles",
  );
  assert.equal(
    overrideFor("package(portcove-core) & test(activity_diagnostics::tests::)").priority,
    -50,
  );
  const outputOverrides = overrides.filter((value) => value["success-output"] !== undefined);
  const windowsLifecycleFilters = [
    "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_retained_launch_withdrawal_supervises_exact_owned_child_after_reopen$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_rollback_revocation_preserves_unaffected_active_and_recovery_evidence$/))",
    "package(portcove-core) & (test(/^service::shipwright_persistence_tests::shipwright_activation_and_rollback_collect_before_replacing_working_save$/) | test(/^service::shipwright_persistence_tests::shipwright_backup_restore_keeps_the_displaced_runtime_save_in_safety_backup$/))",
    "package(portcove-core) & (test(/^import_execution::tests::late_credentials_hold_import_before_the_open_gate$/) | test(/^library_move::tests::late_credentials_hold_move_before_authority_or_destination_activation$/))",
    "package(portcove-core) & (test(/^service::tests::tfe_recovery_hold_protects_inactive_versions_and_invalidates_earlier_removal_consent$/) | test(/^service::tests::tfe_recovery_hold_survives_quarantine_reopen_and_committed_metadata_removal$/))",
    "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_rollback_withdrawal_permits_exact_retained_target$/)",
  ];
  const publicationFilters = [
    {
      filter:
        "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::managed_ordinary_artifacts_and_compatible_correction_retain_exact_contract$/)",
      platform: undefined,
    },
    {
      filter:
        "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_publication_recovery_permitted_artifact_commits_once$/)",
      platform: "x86_64-apple-darwin",
    },
  ];
  // Admit only these exact platform/filter identities. Comparing the complete
  // inventory also rejects duplicates without a separately maintained count.
  const outputIdentity = (value: Readonly<Record<string, unknown>>) =>
    JSON.stringify([value.platform ?? null, value.filter]);
  assert.deepEqual(
    outputOverrides.map(outputIdentity).sort(),
    [
      ...windowsLifecycleFilters.map((filter) => ({ platform: "x86_64-pc-windows-msvc", filter })),
      ...publicationFilters,
    ]
      .map(outputIdentity)
      .sort(),
  );
  for (const filter of windowsLifecycleFilters) {
    const override = overrideFor(filter, "x86_64-pc-windows-msvc");
    assert.equal(override.platform, "x86_64-pc-windows-msvc");
    assert.equal(override["success-output"], "immediate");
    assert.deepEqual(override["slow-timeout"], {
      period: "5s",
      "terminate-after": 12,
      "grace-period": "0s",
    });
    for (const field of ["retries", "threads-required", "priority"])
      assert.equal(override[field], undefined);
  }
  // The measured copy-start wait must fit inside an exact Windows-only outer
  // budget; it must not add output, retries, workers or priority exceptions.
  const cacheRetention = overrideFor(
    "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_cache_retention_cancellation_preserves_partial_after_worker_exit$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_cache_retention_revocation_during_copy_refuses_publication$/))",
  );
  assert.equal(cacheRetention.platform, "x86_64-pc-windows-msvc");
  assert.deepEqual(cacheRetention["slow-timeout"], {
    period: "5s",
    "terminate-after": 12,
    "grace-period": "0s",
  });
  for (const field of ["success-output", "retries", "threads-required", "priority"])
    assert.equal(cacheRetention[field], undefined);
  for (const { filter, platform } of publicationFilters) {
    const override = overrideFor(filter);
    assert.equal(override.platform, platform);
    assert.equal(override["success-output"], "immediate");
    for (const field of ["retries", "threads-required", "priority"])
      assert.equal(override[field], undefined);
  }
  for (const value of [profile, ...overrides]) {
    assert.ok(value.retries === undefined || value.retries === 0);
    assert.equal(value["on-timeout"], undefined);
    if (value !== profile) assert.equal(typeof value.filter, "string");
    const timeout: unknown = value["slow-timeout"];
    if (timeout === undefined) continue;
    assert.ok(isRecord(timeout));
    // Nextest owns duration syntax; calibrated warning/grace durations may vary.
    assert.equal(typeof timeout.period, "string");
    if (timeout["grace-period"] !== undefined)
      assert.equal(typeof timeout["grace-period"], "string");
    assert.ok(Number.isSafeInteger(timeout["terminate-after"]));
    assert.ok(typeof timeout["terminate-after"] === "number" && timeout["terminate-after"] > 0);
  }
  assert.match(rustTests, /cargo nextest run --locked @Arguments/);
  assert.doesNotMatch(rustTests + rustWorkspaceTests, /--test-threads 1/);
  assert.match(rustDocs, /cargo test --locked --workspace --exclude portcove-desktop --doc/);
  assert.match(rustDocs, /cargo test --locked -p portcove-desktop --doc/);
  assert.doesNotMatch(rustDocs, /--no-default-features|--no-deps|--exclude (?!portcove-desktop)/);
  assert.match(
    rustDocs,
    /include: \$\{\{ fromJSON\(needs\.classify\.outputs\.qualification_docs_matrix_json\) \}\}/,
  );
  const matrixRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-doc-qualification-"));
  t.after(() => rm(matrixRoot, { recursive: true, force: true }));
  for (const [releaseProfile, expected] of [
    ["full", ["linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"]],
    ["initial-beta-win-linux", ["linux-x86_64", "windows-x86_64"]],
  ] as const) {
    const selected = discoverCiPlan({
      eventName: "workflow_dispatch",
      checkoutSha: "a".repeat(40),
      forceQualification: true,
      qualificationCaller: "release",
      callerWorkflow: "release.yml",
      releaseProfile,
    });
    const output = path.join(matrixRoot, releaseProfile);
    await writeGithubOutputs(output, selected);
    const line = (await readFile(output, "utf8"))
      .split("\n")
      .find((line) => line.startsWith("qualification_docs_matrix_json="));
    assert.ok(line);
    const matrix: unknown = JSON.parse(line.slice(line.indexOf("=") + 1));
    assert.ok(Array.isArray(matrix));
    assert.deepEqual(
      matrix.map((entry: unknown) => {
        assert.ok(isRecord(entry));
        return entry.platform;
      }),
      expected,
    );
    assert.deepEqual(matrix, qualificationMatrices(selected).docs);
  }
  assert.ok(rust.includes(`"rust_docs":"` + '${{ needs.rust_docs.result }}"'));
  for (const section of [rustTests, rustWorkspaceTests, nativeRust, intelBuild, intelTests]) {
    assert.match(section, /Install pinned test runner/);
    assert.match(section, /Get-Content \.github\/quality-tools\.json/);
    assert.match(section, /Where-Object id -eq "cargo-nextest"/);
  }
  assert.doesNotMatch(rustQuality, /cargo nextest run/);
  assert.match(workflow, /CARGO_PROFILE_TEST_DEBUG: line-tables-only/);
  assert.match(workflow, /CARGO_PROFILE_DEV_DEBUG: line-tables-only/);
});

void test("deep audit evidence retains audit status without privilege changes", async () => {
  const deep = await readFile(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  const auditJob = requiredFixture(
    requiredFixture(deep.split("  audit:")[1]).split(/\n  [a-z_]+:/u)[0],
  );
  assert.match(auditJob, /runs-on: ubuntu-22\.04/u);
  assert.match(auditJob, /^    timeout-minutes: 55$/m);
  const localJob = requiredFixture(
    requiredFixture(deep.split("  local_check:")[1]).split(/\n  [a-z_]+:/u)[0],
  );
  assert.match(localJob, /^    timeout-minutes: 30$/m);
  assert.match(auditJob, /shared-key: deep-quality-ubuntu-22\.04/u);
  assert.match(auditJob, /key: quality-rscheck-binaries-v2-ubuntu-22\.04-/u);
  assert.match(deep, /id: fresh-audit/);
  assert.match(
    deep,
    /if \[\[ "\$AUDIT_OPERATION" == "audit-reuse" \]\]; then\r?\n {12}just audit\r?\n {10}else\r?\n {12}just audit --fresh\r?\n {10}fi\r?\n {10}audit_status=\$\?/,
  );
  assert.match(deep, /exit "\$audit_status"/);
  assert.match(deep, /node scripts\/deep-audit-summary\.mts --start/);
  assert.match(deep, /node scripts\/deep-audit-summary\.mts --finish "\$audit_status"/);
  assert.match(deep, /name: Summarize structured audit evidence\r?\n {8}if: always\(\)/);
  assert.match(deep, /AUDIT_OUTCOME: \$\{\{ steps\.fresh-audit\.outcome \}\}/);
  assert.match(deep, /AUDIT_EXIT_CODE: \$\{\{ steps\.fresh-audit\.outputs\.exit_code \}\}/);
  assert.match(
    deep,
    /run: node scripts\/deep-audit-summary\.mts \|\| echo "Structured audit evidence unavailable"/,
  );
  assert.match(deep, /^permissions:\r?\n {2}contents: read$/m);
  assert.doesNotMatch(deep, /continue-on-error|secrets:|schedule:|tee /);
  assert.match(deep, /PORTCOVE_AUDIT_CAPTURE: "1"/);
  assert.match(
    deep,
    /name: Export attempt-bound audit evidence\r?\n {8}id: audit-evidence\r?\n {8}if: always\(\)/,
  );
  assert.match(deep, /node scripts\/audit-evidence.mts/);
  assert.match(deep, /if: always\(\) && steps.fresh-audit.outputs.capture_available == 'true'/);
  assert.match(deep, /if: always\(\) && steps.audit-evidence.outputs.available == 'true'/);
  assert.match(deep, /uses: actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9/);
  assert.match(
    deep,
    /name: audit-evidence-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/,
  );
  assert.match(
    deep,
    /path: work\/audit-bundles\/\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}\//,
  );
  assert.match(
    deep,
    /retention-days: 7\r?\n {10}compression-level: 6\r?\n {10}if-no-files-found: error/,
  );
});

// Inert repository-health controls for the tool invoked by the live upstream workflow.

void test("native repository contracts provision pinned Rust before metadata or containment execution", () => {
  for (const section of [fastCatalog, catalog]) {
    assert.ok(section.indexOf("./.github/actions/setup-rust") >= 0);
    const contract = section.includes("scripts/ci-baseline.mts contracts")
      ? section.indexOf("scripts/ci-baseline.mts contracts")
      : section.indexOf("Verify repository and release contracts");
    assert.ok(contract > section.indexOf("./.github/actions/setup-rust"));
  }
});

void test("extracted validation evidence suite remains in hosted and repository full inventories", async () => {
  const just = await readFile(new URL("../justfile", import.meta.url), "utf8");
  assert.match(
    requiredFixture(requiredFixture(just.split("development-tools:")[1]).split("\n\n")[0]),
    /scripts\/validation-evidence\.test\.mts/u,
  );
  assert.match(
    requiredFixture(workflow.split("  catalog_full:")[1]),
    /scripts\/validation-evidence\.test\.mts/u,
  );
  assert.match(
    workflowStep("windows_storage", "Test development diagnostics and evidence").run,
    /scripts\/validation-evidence\.test\.mts/u,
  );
});

void test("hosted plans use bounded transport before checkout and retain the same qualification outputs", async () => {
  assert.doesNotMatch(workflow, /PORTCOVE_PLAN_JSON:/);
  assert.match(workflow, /plan_gzip_base64: \$\{\{ steps\.plan\.outputs\.plan_gzip_base64 \}\}/);
  assert.match(qualificationWorkflow, /jobs\.qualify\.outputs\.plan_gzip_base64/);
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    release,
    /PORTCOVE_PLAN_GZIP_BASE64: \$\{\{ needs\.qualification\.outputs\.plan_gzip_base64 \}\}/,
  );
  assert.doesNotMatch(release, /PORTCOVE_PLAN_JSON:/);
});
