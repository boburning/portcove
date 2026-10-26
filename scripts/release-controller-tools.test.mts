import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, isBuiltin } from "node:module";
import {
  bundleControllerEntries,
  controllerBootstrapEnvironment,
  materializeControllerCompilerSource,
} from "./release-controller-tool-build.mts";
import {
  controllerToolAssets,
  controllerToolEntries,
  controllerToolChildren,
  controllerToolPaths,
  controllerToolPredicateType,
  windowsControllerToolPredicateType,
  inspectControllerToolArchive,
  controllerCompilerSourceAsset,
  controllerToolPlatformProfile,
  inspectControllerToolManifest,
  type ControllerToolPlatform,
} from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";
import { slice4CapacityResources } from "./release-capacity.mts";
import {
  compilerProducerPaths,
  inspectReleaseCompilerSourceClosure,
} from "./release-compiler-source-closure.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
  type ControllerToolArtifactExpected,
} from "./release-controller-tool-admission.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  assemblerIdentityFixture,
  expected as identityExpected,
} from "./fixtures/assembler-identity-fixture.mts";
import {
  verifyControllerToolBootstrapJobIdentity,
  controllerToolBootstrapProfile,
} from "./assembler-job-identity.mts";
import { launchFixedPayloadController } from "./release-controller-tool-launch.mts";
import { controllerNodeVersion } from "./controller-node-runtime.mts";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

void test("actual fixed pack keeps the marked preparation verifier after raw source and dependencies are removed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-prepared-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "candidate"),
    staged = path.join(root, "source"),
    output = path.join(root, "packed"),
    isolated = path.join(root, "isolated"),
    hooks = path.join(root, "empty-hooks"),
    gitConfig = path.join(root, "empty-gitconfig");
  for (const directory of [repository, staged, isolated, hooks]) await mkdir(directory);
  await writeFile(gitConfig, "");
  const git = (args: readonly string[], input?: string) =>
    execFileSync(
      "git",
      ["-C", repository, "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${hooks}`, ...args],
      {
        encoding: "utf8",
        input,
        windowsHide: true,
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: root,
          USERPROFILE: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: gitConfig,
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
      },
    );
  git(["init", "-q"]);
  git(["config", "user.name", "Disposable packed preparation fixture"]);
  git(["config", "user.email", "fixture@portcove.invalid"]);
  git(["config", "core.autocrlf", "false"]);
  const inputs = {
    "Cargo.toml":
      '[workspace]\nmembers = ["apps/desktop/src-tauri"]\n[workspace.package]\nversion = "0.1.0"\n',
    "apps/desktop/src-tauri/Cargo.toml":
      '[package]\nname = "portcove-desktop"\nversion.workspace = true\n',
    "Cargo.lock":
      'version = 4\n\n[[package]]\nname = "portcove-desktop"\nversion = "0.1.0"\n\n[[package]]\nname = "third-party"\nversion = "0.1.0"\nsource = "registry+https://example.invalid"\n',
    "apps/desktop/package.json": '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n',
    "apps/desktop/src-tauri/tauri.conf.json":
      '{\n  "version": "0.1.0",\n  "identifier": "fixture.example"\n}\n',
  };
  for (const [name, bytes] of Object.entries(inputs)) {
    await mkdir(path.dirname(path.join(repository, name)), { recursive: true });
    await writeFile(path.join(repository, name), bytes);
  }
  git(["add", "."]);
  git(["commit", "-qm", "Disposable source opportunity"]);
  const source = git(["rev-parse", "HEAD"]).trim();
  const sourceTree = git(["rev-parse", `${source}^{tree}`]).trim();
  const { prepareReleaseVersion } =
    await import("../apps/desktop/scripts/prepare-release-version.mts");
  const prepared = await prepareReleaseVersion(
    repository,
    {
      source_commit: source,
      reviewed_commit: source,
      base_version: "0.1.0",
      change: "patch",
      compatibility: "compatible",
    },
    ["0.1.0"],
  );
  git(["read-tree", prepared.prepared_commit]);
  const oldLock = git(["show", `${prepared.prepared_commit}:Cargo.lock`]);
  const forgedLock = oldLock.replace(
    'name = "third-party"\nversion = "0.1.0"',
    'name = "third-party"\nversion = "9.9.9"',
  );
  assert.notEqual(forgedLock, oldLock);
  const blob = git(["hash-object", "-w", "--stdin"], forgedLock).trim();
  git(["update-index", "--cacheinfo", `100644,${blob},Cargo.lock`]);
  const forgedTree = git(["write-tree"]).trim();
  const forgedRaw = git(["cat-file", "commit", prepared.prepared_commit]).replace(
    /^tree [a-f0-9]{40}/u,
    `tree ${forgedTree}`,
  );
  const forged = git(["hash-object", "-w", "-t", "commit", "--stdin"], forgedRaw).trim();

  // Synthetic entry in an existing fixed slot, not a production diagnostic API.
  // Every reached maintained module is copied unchanged, including the literal
  // lazy preparation import. The production packer/configuration is unchanged.
  const copied = new Set<string>();
  const closure: { path: string; sha256: string; bytes: number }[] = [];
  const copy = async (relative: string): Promise<void> => {
    assert.ok(!path.isAbsolute(relative) && !relative.startsWith("../"));
    if (copied.has(relative)) return;
    copied.add(relative);
    assert.ok(copied.size <= 80);
    const sourceBytes = await readFile(path.join(sourceRoot, relative));
    closure.push({ path: relative, sha256: hash(sourceBytes), bytes: sourceBytes.length });
    await mkdir(path.dirname(path.join(staged, relative)), { recursive: true });
    await writeFile(path.join(staged, relative), sourceBytes);
    const text = sourceBytes.toString("utf8");
    for (const match of text.matchAll(/\b(?:from\s*|import\s*\(\s*)["']([^"']+)["']/gu)) {
      const specifier = match[1]!;
      if (specifier.startsWith("."))
        await copy(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
      else
        assert.ok(
          isBuiltin(specifier) || specifier === "semver",
          `unexpected prepared verifier dependency: ${specifier}`,
        );
    }
  };
  await copy("scripts/linux-beta-risk-706-preparation.mts");
  // The compiler selects this authenticated adapter instead of the source runtime.
  await copy("apps/desktop/scripts/release-version-bundled-runtime.mts");
  assert.ok(copied.has("apps/desktop/scripts/prepare-release-version.mts"));
  const desktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  await cp(
    path.dirname(desktop.resolve("semver/package.json")),
    path.join(staged, "node_modules/semver"),
    { recursive: true },
  );
  await mkdir(path.join(staged, "scripts"), { recursive: true });
  for (const name of [
    ...controllerToolEntries,
    "production-controller-admission-cli",
    ...controllerToolChildren.map((file) => path.posix.basename(file, ".mts")),
  ])
    await writeFile(
      path.join(staged, "scripts", `${name}.mts`),
      name === "release-publication-controller"
        ? 'export { inspectRiskVersionPreparation706 } from "./linux-beta-risk-706-preparation.mts";\n'
        : "export {};\n",
    );
  await bundleControllerEntries(staged, output);
  const packed = path.join(isolated, "release-publication-controller.bundle.mjs");
  await copyFile(path.join(output, "scripts/release-publication-controller.bundle.mjs"), packed);
  assert.equal(path.relative(root, staged), "source");
  await rm(staged, { recursive: true, force: true });
  assert.deepEqual(await readdir(isolated), ["release-publication-controller.bundle.mjs"]);
  assert.ok(!(await readdir(root)).includes("source"));
  t.diagnostic(
    JSON.stringify({
      scope: "synthetic fixed entry through actual production packer; no finalizer or approval",
      source,
      source_tree: sourceTree,
      prepared_commit: prepared.prepared_commit,
      forged_commit: forged,
      packed_sha256: hash(await readFile(packed)),
      closure: closure.sort((a, b) => a.path.localeCompare(b.path)),
    }),
  );
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {execFileSync} from 'node:child_process';
    const {inspectRiskVersionPreparation706}=await import(${JSON.stringify(pathToFileURL(packed).href)});
    const read=(args)=>execFileSync('git',['-C',${JSON.stringify(repository)},'-c','core.fsmonitor=false','-c',${JSON.stringify(`core.hooksPath=${hooks}`)},...args],{encoding:'utf8',windowsHide:true,timeout:15000});
    const valid=await inspectRiskVersionPreparation706(${JSON.stringify(prepared.prepared_commit)},read);
    assert.deepEqual(valid,${JSON.stringify({ source_commit: prepared.source_commit, source_tree: sourceTree, prepared_commit: prepared.prepared_commit, prepared_tree: prepared.prepared_tree, version: prepared.version, intent_sha256: prepared.intent_sha256 })});
    assert.equal(await inspectRiskVersionPreparation706(${JSON.stringify(source)},read),null);
    await assert.rejects(()=>inspectRiskVersionPreparation706(${JSON.stringify(forged)},read),/prepared|version|differ/u);
    process.stdout.write('packed-verifier-positive-and-forged-refusal');
  `,
    ],
    {
      cwd: isolated,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 128 * 1024,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: root,
        USERPROFILE: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/u);
  assert.equal(child.stdout, "packed-verifier-positive-and-forged-refusal");
});
void test("complete job composite has fixed worker syntax, exclusive key transport and settled outputs", async () => {
  const bytes = await readFile(
      path.join(sourceRoot, ".github/actions/release-controller-job/action.yml"),
      "utf8",
    ),
    parsed = parseDocument(bytes);
  assert.deepEqual(parsed.errors, []);
  const action: unknown = parsed.toJS();
  assert.ok(isRecord(action) && isRecord(action.runs));
  assert.equal(action.runs.using, "composite");
  assert.ok(Array.isArray(action.runs.steps));
  const steps: unknown[] = action.runs.steps;
  assert.equal(steps.length, 6);
  const pump = steps[1];
  assert.ok(isRecord(pump) && isRecord(pump.with));
  assert.equal(pump.uses, "./.github/actions/release-controller-transport");
  assert.equal(pump.with.role_key, "${{ inputs.role_key }}");
  for (const step of [steps[0], steps[2]]) {
    assert.ok(isRecord(step) && typeof step.run === "string");
    const source = step.run.match(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE\s*$/u)?.[1];
    assert.ok(source, "actual fixed parent launch/settlement module must be present");
    const checked = spawnSync(process.execPath, ["--check", "--input-type=module"], {
      input: source,
      encoding: "utf8",
      timeout: 5000,
      env: { SystemRoot: process.env.SystemRoot },
    });
    assert.equal(checked.status, 0, checked.stderr);
    assert.ok(isRecord(step.env));
    assert.deepEqual(Object.keys(step.env).sort(), [
      "PORTCOVE_JOB_OPERATION",
      "PORTCOVE_JOB_PHASE",
    ]);
  }
  assert.ok(isRecord(steps[3]));
  assert.equal(
    steps[3].run,
    'node scripts/release-controller-job-output.mts "$PORTCOVE_JOB_OPERATION"',
  );
  const diagnostics = steps[4],
    upload = steps[5];
  assert.ok(isRecord(diagnostics) && isRecord(upload) && isRecord(upload.with));
  assert.equal(diagnostics.if, "${{ always() }}");
  assert.equal(upload.if, "${{ always() }}");
  assert.equal(upload.with["retention-days"], 7);
  assert.equal(upload.with.overwrite, false);
  assert.equal(
    upload.with.path,
    "${{ runner.temp }}/controller-public-evidence-${{ inputs.phase }}",
  );
  assert.doesNotMatch(
    bytes,
    /sudo|\.vhd|create-github-app-token|PORTCOVE_CONTROL_APP_TOKEN|continue-on-error/u,
  );
});
void test("fixed source launcher loads without node_modules and rejects arbitrary entries or imported custody before acquisition", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-tool-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copied = new Set<string>();
  const copy = async (relative: string): Promise<void> => {
    if (copied.has(relative)) return;
    copied.add(relative);
    assert.ok(copied.size < 100);
    const text = await readFile(path.join(sourceRoot, relative), "utf8");
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
    for (const match of text.matchAll(/\bfrom\s+["']([^"']+)["']/gu)) {
      const specifier = match[1]!;
      if (specifier.startsWith("."))
        await copy(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
      else assert.ok(isBuiltin(specifier), `launcher dependency must be builtin: ${specifier}`);
    }
  };
  await copy("scripts/release-controller-tool-launch.mts");
  await copy("scripts/release-controller-job-bootstrap.mts");
  await copy("scripts/release-controller-job-output.mts");
  await copy("scripts/release-controller-diagnostics.mts");
  const child = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-controller-tool-launch.mts")],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(child.status, 2);
  assert.match(child.stderr, /fixed verified-tool payload launcher refused/);
  assert.doesNotMatch(child.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  const fixedJob = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-controller-job-bootstrap.mts"), "root"],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(fixedJob.status, 1, fixedJob.stderr);
  assert.match(fixedJob.stderr, /fixed complete controller job refused/);
  assert.doesNotMatch(fixedJob.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  for (const raw of [{}, { entry: "arbitrary.mjs", tools: { artifact: {}, bundle: {} } }])
    await assert.rejects(launchFixedPayloadController(raw, root), /fields differ/);
  await assert.rejects(
    launchFixedPayloadController(
      {
        configuration: {},
        native_locators: [],
        signer_identity: {},
        tools: { artifact: {}, bundle: {} },
      },
      root,
    ),
  );
  assert.deepEqual((await readdir(root)).sort(), ["scripts"]);
});
void test("actual pinned pack bundles fixed CLIs including semver; isolated execution needs no runtime node_modules", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-tools-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await bundleControllerEntries(sourceRoot, root);
  for (const name of controllerToolAssets) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await copyFile(path.join(sourceRoot, name), path.join(root, name));
  }
  const { requiredContextsFromConfigs } = await import("./pr-delivery.mts");
  assert.deepEqual(
    requiredContextsFromConfigs(
      JSON.parse(await readFile(path.join(root, ".github/repository-ruleset.json"), "utf8")),
      JSON.parse(await readFile(path.join(root, ".github/qualification-coverage.json"), "utf8")),
    ).sort(),
    ["catalog", "dependency-review", "frontend", "rust", "rust-quality"].sort(),
    "actual isolated controller tool root must contain the policies consumed by admission",
  );
  await writeFile(
    path.join(root, ".github/workflows/release-reviewed-inputs.yml"),
    "fixture workflow bytes; no active reviewed-input workflow claimed",
  );
  assert.deepEqual((await readdir(root)).sort(), [
    ".github",
    "apps",
    "deny.toml",
    "release",
    "scripts",
  ]);
  assert.deepEqual(
    await readFile(path.join(root, "deny.toml")),
    await readFile(new URL("../deny.toml", import.meta.url)),
    "isolated controller carries the exact fixed scanner policy",
  );
  for (const [name, workflow, args] of [
    ["production-controller-admission", "application-update-production.yml", []],
    ["release-reviewed-inputs", "release-reviewed-inputs.yml", ["admission"]],
  ] as const) {
    const bytes = await readFile(path.join(root, ".github/workflows", workflow));
    const revision = "a".repeat(40),
      ref = "refs/tags/portcove-production-controller-fixture";
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", `${name}.bundle.mjs`), ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
        env: {
          PATH: path.dirname(process.execPath),
          SystemRoot: process.env.SystemRoot,
          GITHUB_ACTIONS: "true",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_API_URL: "https://api.github.com",
          GITHUB_REPOSITORY: "boburning/portcove",
          GITHUB_REPOSITORY_ID: "1354613114",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF: ref,
          GITHUB_REF_TYPE: "tag",
          GITHUB_REF_PROTECTED: "true",
          GITHUB_SHA: revision,
          GITHUB_WORKFLOW_SHA: revision,
          GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/${workflow}@${ref}`,
          GITHUB_ACTOR: "fixture",
          GITHUB_ACTOR_ID: "1122",
          GITHUB_TRIGGERING_ACTOR: "fixture",
          GITHUB_RUN_ID: "9988",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_JOB: "admission",
          RUNNER_ENVIRONMENT: "github-hosted",
          PORTCOVE_CONTROLLER_REVISION: revision,
          PORTCOVE_CONTROLLER_REF: ref,
          PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify({
            schema_version: 1,
            mode: "admission-only",
            execution_ref: ref,
            revision,
            workflow_sha256: hash(bytes),
            actor_id: "1122",
          }),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const observed: unknown = JSON.parse(result.stdout);
    assert.ok(isRecord(observed));
    assert.equal(observed.run_id, "9988");
  }
  const ready = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-control-ready.bundle.mjs")],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(ready.status, 2);
  assert.match(ready.stderr, /fixed reader readiness refused/);
  const context = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-signing-controller.bundle.mjs")],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(context.status, 2, context.stderr);
  assert.match(context.stderr, /fixed payload\/context controller refused/);
  assert.doesNotMatch(context.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  const budget = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const worker=await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/release-payload-preparation.bundle.mjs")).href)});
    const original=worker.payloadSigningPhaseDeadline();
    worker.tightenPayloadSigningPhaseDeadline(original-1000);
    worker.tightenPayloadSigningPhaseDeadline(original+1000);
    assert.equal(worker.payloadSigningPhaseDeadline(),original-1000);
    assert.throws(()=>worker.tightenPayloadSigningPhaseDeadline(-1),/deadline/);
    process.stdout.write('deadline-kept');
  `,
    ],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(budget.status, 0, budget.stderr);
  assert.equal(budget.stdout, "deadline-kept");
  const publication = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-publication-controller.bundle.mjs")],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(publication.status, 1, publication.stderr);
  assert.match(publication.stderr, /fixed publication controller refused/);
  assert.doesNotMatch(publication.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  const site = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-site-controller.bundle.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      env: { SystemRoot: process.env.SystemRoot },
    },
  );
  assert.equal(site.status, 1, site.stderr);
  assert.match(site.stderr, /fixed site upload bridge refused/);
  assert.doesNotMatch(site.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  const semantic = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from 'node:assert/strict';
      try { import.meta.resolve('semver'); throw Error('unexpected package visibility'); }
      catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
      const bundle = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/release-coordinator-driver.bundle.mjs")).href)});
      const latest = {draft:false, tag_name:'v1.0.0-beta.10', published_at:'2026-10-20T00:00:00.000Z'};
      const older = {draft:false, tag_name:'v1.0.0-beta.9', published_at:'2026-10-19T00:00:00.000Z'};
      assert.deepEqual(bundle.selectCoordinatorPublicationBaseline([older, latest], ['1.0.0-beta.9', '1.0.0-beta.10']), {release:latest,version:'1.0.0-beta.10'});
      process.stdout.write('semantic-version-compared');
    `,
    ],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(semantic.status, 0, semantic.stderr);
  assert.equal(semantic.stdout, "semantic-version-compared");
  const driver = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-coordinator-driver.bundle.mjs")],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(driver.status, 1);
  assert.match(driver.stderr, /usage: release-coordinator-driver/u);
  const tuf = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-tuf-controller.bundle.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      env: { SystemRoot: process.env.SystemRoot },
    },
  );
  assert.equal(tuf.status, 1, tuf.stderr);
  assert.match(tuf.stderr, /fixed TUF role controller refused/);
  assert.doesNotMatch(tuf.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  const job = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-controller-job.bundle.mjs")],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(job.status, 1, job.stderr);
  assert.match(job.stderr, /fixed controller job refused/);
  assert.doesNotMatch(job.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  const keyChannel = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-role-key-channel.bundle.mjs")],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(keyChannel.status, 1, keyChannel.stderr);
  assert.match(keyChannel.stderr, /isolated role key handoff refused/);
  assert.doesNotMatch(keyChannel.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  const jobAbi = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m=await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/release-controller-job.bundle.mjs")).href)}); if(typeof m.runConfiguredFixedControllerJob!== 'function') throw Error('fixed job ABI missing'); await m.runConfiguredFixedControllerJob('root',1).then(()=>{throw Error('arbitrary role accepted')},e=>{if(!/fixed complete-controller job/.test(e.message))throw e}); process.stdout.write('fixed-job-ABI');`,
    ],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(jobAbi.status, 0, jobAbi.stderr);
  assert.equal(jobAbi.stdout, "fixed-job-ABI");
  assert.deepEqual(controllerToolEntries, [
    "production-controller-admission",
    "release-control-ready",
    "release-reviewed-inputs",
    "release-payload-preparation",
    "release-signing-controller",
    "release-role-key-channel",
    "release-coordinator-driver",
    "release-publication-controller",
    "release-site-controller",
    "release-tuf-controller",
    "release-controller-job",
    "release-hosted-native-runner",
    "release-hosted-native-worker",
    "release-native-keyless-assembly",
  ]);
});
void test("bootstrap environment excludes ambient credentials, wrappers, npm hooks and caches", () => {
  const env = controllerBootstrapEnvironment("/owned/home", "/owned/target");
  assert.equal(env.CARGO_TARGET_DIR, "/owned/target");
  assert.equal(env.HOME, "/owned/home");
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "TAURI_SIGNING_PRIVATE_KEY",
    "NODE_OPTIONS",
    "NPM_CONFIG_USERCONFIG",
    "RUSTC_WRAPPER",
    "AWS_SECRET_ACCESS_KEY",
  ])
    assert.equal(Object.hasOwn(env, key), false);
});
void test("actual pinned pack inlines dynamic cycles and preserves Unicode module URLs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-tools-unicode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    output = path.join(root, "output");
  await mkdir(path.join(source, "scripts"), { recursive: true });
  await writeFile(
    path.join(source, "scripts/imported.mts"),
    'const label = "😀é"; export const location = import.meta.url; export {label}; export async function check(){return (await import("./cycle.mts")).echo((await import("./dynamic.mts")).read())};\n',
  );
  await writeFile(
    path.join(source, "scripts/dynamic.mts"),
    'export function read(){return globalThis.opaqueLabel ?? "😀é"};\n',
  );
  await writeFile(
    path.join(source, "scripts/cycle.mts"),
    'import {label} from "./imported.mts"; export function echo(value){return value===label?value:"bad"};\n',
  );
  for (const name of [
    ...controllerToolEntries,
    "production-controller-admission-cli",
    ...controllerToolChildren.map((file) => path.posix.basename(file, ".mts")),
  ])
    await writeFile(
      path.join(source, "scripts", `${name}.mts`),
      'import {location,check} from "./imported.mts"; export {location}; console.log(JSON.stringify({location,label:await check(),entry:import.meta.url}));\n',
    );
  await bundleControllerEntries(source, output);
  await rm(source, { recursive: true });
  for (const file of [
    ...controllerToolEntries.map((name) => `scripts/${name}.bundle.mjs`),
    ...controllerToolChildren,
  ]) {
    const bundle = path.join(output, file);
    const result = spawnSync(process.execPath, [bundle], {
      cwd: output,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
      env: { SystemRoot: process.env.SystemRoot },
    });
    assert.equal(result.status, 0, result.stderr);
    const value: unknown = JSON.parse(result.stdout);
    assert.ok(isRecord(value));
    assert.equal(value.label, "😀é");
    assert.equal(fileURLToPath(String(value.location)), path.join(output, "scripts/imported.mts"));
    assert.equal(fileURLToPath(String(value.entry)), bundle);
  }
});
void test("ordinary Linux tool build fixture uses actual source and fresh public build without production credentials", async () => {
  const text = await readFile(
    new URL("../.github/workflows/controller-tool-build-fixture.yml", import.meta.url),
    "utf8",
  );
  const document = parseDocument(text, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const parsed: unknown = document.toJS();
  assert.ok(isRecord(parsed));
  assert.deepEqual(parsed.permissions, { contents: "read" });
  assert.equal(document.getIn(["jobs", "fixture", "runs-on"]), "ubuntu-22.04");
  assert.equal(document.getIn(["jobs", "fixture", "timeout-minutes"]), 15);
  assert.equal(document.getIn(["jobs", "windows-tools", "runs-on"]), "windows-2022");
  assert.equal(document.getIn(["jobs", "windows-tools", "timeout-minutes"]), 15);
  const windowsSteps = document.getIn(["jobs", "windows-tools", "steps"]);
  assert.ok(windowsSteps);
  assert.match(text, /node scripts\/qualify-controller-tools-windows\.mts/u);
  assert.match(text, /FIXTURE_SOURCE_SHA: \$\{\{ github.sha \}\}/u);
  assert.match(text, /qualify-controller-tool-build\.mts/u);
  assert.match(text, /--frozen-lockfile --ignore-scripts --ignore-pnpmfile/u);
  assert.match(text, /retention-days: 7/u);
  assert.match(text, /overwrite: false/u);
  assert.doesNotMatch(
    text,
    /id-token|attestations:|secrets\.|environment:|actions\/cache|trusted-controller-tools-/u,
  );
  const source = await readFile(
    new URL("./qualify-controller-tool-build.mts", import.meta.url),
    "utf8",
  );
  assert.match(source, /await buildControllerTools\(source, buildWork, expected\)/u);
  assert.match(source, /actual-rust-refusal-smoke/u);
  assert.match(source, /production_tool_acceptance: "not-established"/u);
  assert.ok(isRecord(parsed.on));
  for (const event of ["pull_request", "push"]) {
    const trigger = parsed.on[event];
    assert.ok(isRecord(trigger) && Array.isArray(trigger.paths));
    for (const scope of ["crates/portcove-cli/**", "crates/portcove-core/**"])
      assert.ok(trigger.paths.includes(scope));
  }
  const buildSource = await readFile(
    new URL("./release-controller-tool-build.mts", import.meta.url),
    "utf8",
  );
  const argumentsSource = buildSource.match(
    /runResourceCommand\(\s*"rust",\s*"cargo",\s*(\[[\s\S]*?\])/u,
  )?.[1];
  assert.ok(argumentsSource);
  assert.deepEqual(JSON.parse(argumentsSource.replace(/,(\s*\])$/u, "$1")), [
    "build",
    "--locked",
    "--profile",
    "controller-tools",
    "-p",
    "portcove-release-tools",
    "-p",
    "portcove-cli",
  ]);
  assert.equal(controllerToolPlatformProfile("linux-x86_64").suffix, "");
  assert.equal(controllerToolPlatformProfile("windows-x86_64").suffix, ".exe");
});
void test("fresh bootstrap OIDC profile authenticates numeric job and refuses wrong job, source, attempt and expiry", async () => {
  const expected = { ...identityExpected, audience: "portcove-controller-tool-bootstrap" };
  const make = (patch: Record<string, unknown> = {}) =>
    assemblerIdentityFixture(
      { aud: expected.audience, ...patch },
      {},
      {
        workflow: ".github/workflows/application-update-production.yml",
        job: "Prepare trusted application controller tools",
      },
    );
  const f = make();
  assert.equal((await verifyControllerToolBootstrapJobIdentity(f.token, expected, f)).job_id, 501);
  for (const patch of [{ exp: 1 }, { run_attempt: "9" }, { workflow_sha: "b".repeat(40) }]) {
    const bad = make(patch);
    await assert.rejects(verifyControllerToolBootstrapJobIdentity(bad.token, expected, bad));
  }
  const other = assemblerIdentityFixture({ aud: expected.audience });
  await assert.rejects(verifyControllerToolBootstrapJobIdentity(other.token, expected, other));
});

void test("Windows bootstrap binds distinct audience, issuer, current numeric job and observed runner label", async () => {
  const selected = controllerToolBootstrapProfile("windows-x86_64");
  const expected = { ...identityExpected, audience: selected.audience };
  const make = (
    patch: Record<string, unknown> = {},
    labels: readonly string[] = ["windows-2022"],
  ) =>
    assemblerIdentityFixture(
      { aud: expected.audience, ...patch },
      {},
      {
        workflow: ".github/workflows/application-update-production.yml",
        job: selected.job,
        labels,
      },
    );
  const good = make();
  assert.equal(
    (await verifyControllerToolBootstrapJobIdentity(good.token, expected, good, "windows-x86_64"))
      .job_id,
    501,
  );
  for (const bad of [
    make({ iss: "https://other.invalid" }),
    make({ aud: "portcove-controller-tool-bootstrap" }),
    make({ sha: "b".repeat(40) }),
    make({}, ["ubuntu-22.04"]),
  ])
    await assert.rejects(
      verifyControllerToolBootstrapJobIdentity(bad.token, expected, bad, "windows-x86_64"),
    );
  const wrongJob = assemblerIdentityFixture(
    { aud: expected.audience },
    {},
    {
      workflow: ".github/workflows/application-update-production.yml",
      job: controllerToolBootstrapProfile().job,
      labels: ["windows-2022"],
    },
  );
  await assert.rejects(
    verifyControllerToolBootstrapJobIdentity(wrongJob.token, expected, wrongJob, "windows-x86_64"),
  );
  await assert.rejects(verifyControllerToolBootstrapJobIdentity(good.token, expected, good));
});

void test("bootstrap generates complete compiler source bytes from the exact clean Git source and never overwrites", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-compiler-asset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    tools = path.join(root, "tools");
  await mkdir(path.join(source, "scripts"), { recursive: true });
  await mkdir(tools);
  await writeFile(path.join(source, "scripts", "compiler.mts"), "inert source\n");
  const git = (args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8", timeout: 10000 }).trim();
  git(["init", "--quiet"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const expected = { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) };
  const identity = await materializeControllerCompilerSource(source, tools, expected);
  const bytes = await readFile(path.join(tools, controllerCompilerSourceAsset));
  assert.equal(identity.bytes, bytes.length);
  assert.equal(identity.sha256, hash(bytes));
  const closure = inspectReleaseCompilerSourceClosure(
    JSON.parse(bytes.toString("utf8")) as unknown,
  );
  assert.equal(closure.source_commit, expected.commit);
  assert.equal(closure.source_tree, expected.tree);
  assert.equal(closure.paths.length, compilerProducerPaths.length);
  assert.equal(
    closure.paths.find((item) => item.path === "scripts")?.entry?.sha,
    git(["rev-parse", "HEAD:scripts"]),
  );
  assert.equal(closure.paths.find((item) => item.path === ".cargo")?.entry, null);
  await assert.rejects(materializeControllerCompilerSource(source, tools, expected), /EEXIST/u);
  assert.ok(bytes.equals(await readFile(path.join(tools, controllerCompilerSourceAsset))));
  await writeFile(path.join(source, "scripts", "compiler.mts"), "changed source\n");
  const refused = path.join(root, "refused");
  await mkdir(refused);
  await assert.rejects(
    materializeControllerCompilerSource(source, refused, expected),
    /changed|dirty/u,
  );
  assert.deepEqual(await readdir(refused), []);
});

function fixture(
  closureChange: Record<string, unknown> = {},
  platform: ControllerToolPlatform = "linux-x86_64",
) {
  const profile = controllerToolPlatformProfile(platform);
  const windows = platform === "windows-x86_64";
  const producerProfile = controllerToolBootstrapProfile(platform);
  const bytes = new Map(
    profile.paths.map((name) => [name, Buffer.from(`inert tool fixture ${name}`)]),
  );
  bytes.set(
    controllerCompilerSourceAsset,
    Buffer.from(
      JSON.stringify({
        schema_version: 1,
        source_commit: "a".repeat(40),
        source_tree: "b".repeat(40),
        paths: compilerProducerPaths.map((filename) => ({ path: filename, entry: null })),
        ...closureChange,
      }),
    ),
  );
  const manifest = {
    schema_version: profile.schema_version,
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    platform,
    node_version: controllerNodeVersion,
    bundler: "vite-plus@1.3.0",
    tauri_cli_version: "2.12.2",
    files: [...bytes].map(([name, content]) => ({
      path: name,
      bytes: content.length,
      sha256: hash(content),
    })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const archive = createAuditZip([["manifest.json", manifestBytes], ...bytes]);
  const bundleArchive = createAuditZip([
    [
      windows ? "controller-tools-windows-attestation.json" : "controller-tools-attestation.json",
      "synthetic fixture; not a protected attestation",
    ],
  ]);
  const expected: ControllerToolArtifactExpected = {
    ...(windows ? { platform: "windows-x86_64" as const } : {}),
    controller_revision: manifest.source_commit,
    source_tree: manifest.source_tree,
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    run_id: "9988",
    run_attempt: 1,
    artifact_id: 99,
    sha256: hash(archive),
  };
  const bundle = { artifact_id: 100, sha256: hash(bundleArchive) };
  const workflow = ".github/workflows/application-update-production.yml";
  const run = {
    id: 9988,
    run_attempt: 1,
    head_sha: expected.controller_revision,
    path: workflow,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const artifact = (id: number, data: Buffer, kind: string) => ({
    id,
    name: `${kind}-9988-1`,
    digest: `sha256:${hash(data)}`,
    size_in_bytes: data.length,
    expired: false,
    workflow_run: {
      id: 9988,
      head_sha: expected.controller_revision,
      repository_id: 1354613114,
      head_repository_id: 1354613114,
    },
  });
  const artifactName = windows ? "trusted-controller-tools-windows" : "trusted-controller-tools";
  const toolArtifact = artifact(99, archive, artifactName),
    bundleArtifact = artifact(100, bundleArchive, `${artifactName}-attestation`);
  const producer = { run_id: "9988", run_attempt: 1, job_id: 501, check_run_id: "777" };
  const job = {
    id: 501,
    run_id: 9988,
    run_attempt: 1,
    head_sha: expected.controller_revision,
    name: producerProfile.job,
    labels: [...(producerProfile.labels ?? [])],
    status: "completed",
    conclusion: "success",
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
  };
  const predicate = {
    schema_version: windows ? 2 : 1,
    ...(windows ? { platform: "windows-x86_64" } : {}),
    role: "fixed-controller-tools",
    repository: "boburning/portcove",
    repository_id: 1354613114,
    controller: {
      revision: expected.controller_revision,
      tree: expected.source_tree,
      ref: expected.controller_ref,
      workflow,
    },
    producer,
    artifact: { id: 99, bytes: archive.length, sha256: expected.sha256 },
    manifest_sha256: hash(manifestBytes),
    manifest,
    compile_acceptance: "not-established",
    authority: "none",
  };
  const certificate = {
    issuer: "https://token.actions.githubusercontent.com",
    sourceRepositoryIdentifier: "1354613114",
    sourceRepositoryURI: "https://github.com/boburning/portcove",
    buildSignerURI: `https://github.com/boburning/portcove/${workflow}@${expected.controller_ref}`,
    buildSignerDigest: expected.controller_revision,
    sourceRepositoryDigest: expected.controller_revision,
    sourceRepositoryRef: expected.controller_ref,
    runnerEnvironment: "github-hosted",
    runInvocationURI: "https://github.com/boburning/portcove/actions/runs/9988/attempts/1",
  };
  const verified = [
    {
      verificationResult: {
        signature: { certificate },
        verifiedTimestamps: [{ timestamp: "injected-boundary-only" }],
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: windows ? windowsControllerToolPredicateType : controllerToolPredicateType,
          subject: [
            {
              name: windows ? "controller-tools-windows-manifest" : "controller-tools-manifest",
              digest: { sha256: hash(manifestBytes) },
            },
          ],
          predicate,
        },
      },
    },
  ];
  const calls: string[] = [];
  const options = {
    api: {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        calls.push(endpoint);
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: endpoint.includes("/git/commits/")
            ? { sha: expected.controller_revision, tree: { sha: expected.source_tree } }
            : endpoint.includes("/artifacts/")
              ? endpoint.endsWith("/99")
                ? toolArtifact
                : bundleArtifact
              : endpoint.includes("/jobs/")
                ? job
                : run,
        };
      },
    },
    download: (endpoint: string) => (endpoint.endsWith("/99/zip") ? archive : bundleArchive),
    spawn: ((_command, args) => {
      assert.equal(args[0], "attestation");
      assert.ok(args.includes("--deny-self-hosted-runners"));
      assert.ok(
        args.includes(windows ? windowsControllerToolPredicateType : controllerToolPredicateType),
      );
      return { status: 0, stdout: JSON.stringify(verified), stderr: "" };
    }) satisfies NonNullable<NonNullable<Parameters<typeof receiveControllerTools>[3]>["spawn"]>,
  };
  return {
    bytes,
    manifest,
    archive,
    expected,
    bundle,
    options,
    job,
    predicate,
    certificate,
    calls,
  };
}
void test("opaque fixture tool archive requires exact complete inventory and refuses links, omissions, aliases and changed bytes", () => {
  const f = fixture();
  assert.equal(
    inspectControllerToolArchive(f.archive, f.manifest).files.size,
    controllerToolPaths.length + 1,
  );
  for (const archive of [
    createAuditZip([
      [
        "manifest.json",
        JSON.stringify({
          ...f.manifest,
          node_version: controllerNodeVersion.replace(/\d+$/u, (patch) =>
            String(Number(patch) + 1),
          ),
        }),
      ],
      ...f.bytes,
    ]),
    createAuditZip([["manifest.json", JSON.stringify(f.manifest)]]),
    createAuditZip([["../manifest.json", "x"]]),
    createAuditZip([["manifest.json", JSON.stringify(f.manifest)], ...f.bytes, ["extra", "x"]]),
    createAuditZip([
      ["manifest.json", JSON.stringify(f.manifest)],
      ...[...f.bytes].map(([name, bytes]) => [name, bytes, { attributes: 0xa1ff0000 }] as const),
    ]),
  ])
    assert.throws(() => inspectControllerToolArchive(archive, f.manifest));
  assert.throws(() =>
    inspectControllerToolArchive(f.archive, { ...f.manifest, source_tree: "f".repeat(40) }),
  );
  for (const patch of [
    { source_commit: "c".repeat(40) },
    { source_tree: "d".repeat(40) },
    { paths: [] },
  ]) {
    const wrong = fixture(patch);
    assert.throws(
      () => inspectControllerToolArchive(wrong.archive, wrong.manifest),
      /compiler source/u,
    );
  }
});
void test("Windows tools require explicit platform selection and exact executable inventory; legacy consumers stay closed", () => {
  const windows = fixture({}, "windows-x86_64");
  const linux = fixture();
  const selected = { ...windows.manifest, platform: "windows-x86_64" as const };
  const inspected = inspectControllerToolArchive(windows.archive, selected);
  assert.equal(inspected.manifest.platform, "windows-x86_64");
  for (const filename of [
    "node.exe",
    "portcove.exe",
    "portcove-release-tools.exe",
    "tauri-driver.exe",
    "pnpm.exe",
  ])
    assert.ok(inspected.files.has(`bin/${filename}`));
  assert.ok(!inspected.files.has("bin/native-linux-tree-reaper"));
  assert.throws(() =>
    inspectControllerToolArchive(windows.archive, {
      source_commit: selected.source_commit,
      source_tree: selected.source_tree,
    }),
  );
  assert.throws(() => inspectControllerToolManifest(windows.manifest));
  assert.throws(() => inspectControllerToolArchive(linux.archive, selected));
  assert.throws(() =>
    inspectControllerToolManifest({ ...windows.manifest, schema_version: 2 }, "windows-x86_64"),
  );
  for (const replacement of ["bin/node.exe", controllerCompilerSourceAsset]) {
    const changed = [...windows.bytes].map(
      ([name, bytes]) => [name, name === replacement ? Buffer.from("changed") : bytes] as const,
    );
    assert.throws(() =>
      inspectControllerToolArchive(
        createAuditZip([["manifest.json", JSON.stringify(windows.manifest)], ...changed]),
        selected,
      ),
    );
  }
  assert.throws(() => controllerToolPlatformProfile("windows-arm64" as ControllerToolPlatform));
});
void test("Core CLI and native WebDriver are mandatory content; changed or missing bytes refuse", () => {
  const f = fixture();
  for (const tool of ["bin/portcove", "bin/tauri-driver"]) {
    assert.ok(controllerToolPaths.includes(tool));
    assert.deepEqual(
      inspectControllerToolArchive(f.archive, f.manifest).files.get(tool),
      f.bytes.get(tool),
    );
    for (const files of [
      [...f.bytes].filter(([name]) => name !== tool),
      [...f.bytes].map(
        ([name, bytes]) =>
          [name, name === tool ? Buffer.from("substituted candidate executable") : bytes] as const,
      ),
    ])
      assert.throws(() =>
        inspectControllerToolArchive(
          createAuditZip([["manifest.json", JSON.stringify(f.manifest)], ...files]),
          f.manifest,
        ),
      );
  }
});
void test("tool acquisition retains the phase deadline before outputs and after provider reads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-tools-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  let clock = 1000;
  t.mock.method(performance, "now", () => clock);
  await assert.rejects(
    receiveControllerTools(root, f.expected, f.bundle, { ...f.options, deadline: 999 }),
    /phase deadline/,
  );
  assert.deepEqual(await readdir(root), []);
  let calls = 0;
  await assert.rejects(
    receiveControllerTools(root, f.expected, f.bundle, {
      ...f.options,
      deadline: 2000,
      api: {
        request(method, endpoint) {
          calls++;
          const result = f.options.api.request(method, endpoint);
          clock = 2001;
          return result;
        },
      },
    }),
    /controller tool verification refused; retain/,
  );
  assert.equal(calls, 1);
  const [partial] = await readdir(root);
  assert.ok(partial);
  assert.equal(
    (await readFile(path.join(root, partial, "refusal.json"), "utf8")).includes(
      '"phase":"provider-before"',
    ),
    true,
  );
  await assert.rejects(readdir(path.join(root, partial, "tools")));
});

void test("injected verification boundary materializes exact bytes only after signed association and provider custody; never claims production", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-tools-receiver-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const result = await receiveControllerTools(root, f.expected, f.bundle, f.options);
  await assert.rejects(verifiedControllerToolPaths(result), /actual same-process/);
  await assert.rejects(verifiedControllerToolPaths(structuredClone(result)), /actual same-process/);
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.compile_acceptance, "not-established");
  assert.equal(result.authority, "none");
  assert.equal(f.calls.length, 12);
  for (const [name, bytes] of f.bytes)
    assert.deepEqual(await readFile(path.join(result.tools, name)), bytes);
  for (const fault of ["source", "attempt", "job", "predicate", "certificate"] as const) {
    const g = fixture();
    if (fault === "source") g.job.head_sha = "c".repeat(40);
    if (fault === "attempt") g.job.run_attempt = 2;
    if (fault === "job")
      g.job.check_run_url = "https://api.github.com/repos/boburning/portcove/check-runs/501";
    if (fault === "predicate") g.predicate.producer.job_id = 999;
    if (fault === "certificate") g.certificate.sourceRepositoryIdentifier = "1";
    const before = new Set(await readdir(root));
    await assert.rejects(receiveControllerTools(root, g.expected, g.bundle, g.options));
    const [newRoot] = (await readdir(root)).filter((name) => !before.has(name));
    await assert.rejects(readdir(path.join(root, newRoot!, "tools")));
  }
});
void test("Windows receiver binds its signed platform, producer, label, issuer and opaque source before materialization", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "windows-tool-receiver-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture({}, "windows-x86_64");
  const result = await receiveControllerTools(root, f.expected, f.bundle, f.options);
  assert.equal(result.evidence_scope, "injected-provider");
  await assert.rejects(verifiedControllerToolPaths(result), /actual same-process/u);
  assert.deepEqual(
    await readFile(path.join(result.tools, "bin/node.exe")),
    f.bytes.get("bin/node.exe"),
  );
  for (const fault of [
    "platform",
    "job",
    "label",
    "issuer",
    "source",
    "legacy-selection",
  ] as const) {
    const g = fixture({}, "windows-x86_64");
    if (fault === "platform") g.predicate.platform = "linux-x86_64";
    if (fault === "job") g.job.name = "Prepare trusted application controller tools";
    if (fault === "label") g.job.labels = ["ubuntu-22.04"];
    if (fault === "issuer") g.certificate.issuer = "https://other.invalid";
    if (fault === "source") g.predicate.controller.revision = "c".repeat(40);
    const before = new Set(await readdir(root));
    const expected = { ...g.expected };
    if (fault === "legacy-selection") delete expected.platform;
    await assert.rejects(receiveControllerTools(root, expected, g.bundle, g.options));
    const created = (await readdir(root)).filter((name) => !before.has(name));
    assert.equal(created.length, 1);
    await assert.rejects(readdir(path.join(root, created[0]!, "tools")));
  }
});

void test("the receiver dependency closure loads without npm packages before any role credential", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-receiver-no-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    "release-controller-tool-admission",
    "release-controller-tools",
    "controller-node-runtime",
    "release-compiler-source-closure",
    "github-controller-attestation",
    "assembler-job-identity",
    "production-controller-admission",
    "release-control-phases",
    "github-api",
    "release-readonly-child-environment",
    "release-coordinator-deadline",
    "github-binary",
    "runtime-values",
    "bounded-zip",
  ];
  for (const file of files)
    await copyFile(path.join(sourceRoot, "scripts", `${file}.mts`), path.join(root, `${file}.mts`));
  const code = `import {receiveControllerTools} from './release-controller-tool-admission.mts'; try { await receiveControllerTools('/unused',{},{}); process.exitCode=99; } catch { console.log('fixed input refused without dependencies'); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    env: { SystemRoot: process.env.SystemRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixed input refused without dependencies/);
});

void test("held bootstrap separates compilation from isolated attestation and never activates role credentials", async () => {
  const text = await readFile(
    new URL(
      "../docs/qualification/application-update-production.controller-tools.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const document = parseDocument(text, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  assert.equal(document.getIn(["jobs", "tool_bootstrap", "if"]), "${{ false }}");
  assert.equal(document.getIn(["jobs", "tool_attest", "if"]), "${{ false }}");
  assert.equal(
    document.getIn(["jobs", "tool_bootstrap", "name"]),
    "Prepare trusted application controller tools",
  );
  assert.equal(
    document.getIn(["jobs", "tool_bootstrap", "permissions", "attestations"]),
    undefined,
  );
  assert.equal(document.getIn(["jobs", "tool_attest", "permissions", "attestations"]), "write");
  assert.doesNotMatch(text, /secrets\.|actions\/cache@|permission-administration/);
  const parsed: unknown = document.toJS();
  assert.ok(isRecord(parsed) && isRecord(parsed.jobs));
  const attester = JSON.stringify(parsed.jobs.tool_attest);
  assert.doesNotMatch(attester, /pnpm|cargo|checkout@/);
  assert.match(text, /retention-days: 7/);
  assert.match(text, /overwrite: false/);
});

void test("installed bootstrap clears inherited GitHub credentials only for compilation", async () => {
  const text = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
    "utf8",
  );
  const document = parseDocument(text, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const raw: unknown = document.toJS();
  assert.ok(isRecord(raw) && isRecord(raw.env) && isRecord(raw.jobs));
  assert.equal(raw.env.GH_TOKEN, "${{ github.token }}");
  assert.ok(isRecord(raw.jobs.tool_bootstrap) && Array.isArray(raw.jobs.tool_bootstrap.steps));
  const steps: unknown[] = raw.jobs.tool_bootstrap.steps;
  const build = steps.filter(
    (step) =>
      isRecord(step) && step.run === "node scripts/release-controller-tool-bootstrap.mts build",
  );
  assert.equal(build.length, 1);
  assert.ok(isRecord(build[0]) && isRecord(build[0].env));
  assert.equal(build[0].env.GH_TOKEN, "");
  assert.equal(build[0].env.GITHUB_TOKEN, "");
  const binding = steps.filter(
    (step) =>
      isRecord(step) &&
      step.run === "node scripts/release-controller-tool-bootstrap.mts bind-upload",
  );
  assert.equal(binding.length, 1);
  assert.ok(isRecord(binding[0]) && isRecord(binding[0].env));
  assert.equal(binding[0].env.GH_TOKEN, "${{ github.token }}");
  assert.equal(document.getIn(["jobs", "tool_bootstrap", "timeout-minutes"]), 4);
  const workflowSha = createHash("sha256").update(text).digest("hex");
  assert.equal(slice4CapacityResources.aggregate_workflow_sha256, workflowSha);
  assert.equal(slice4CapacityResources.input_workflow_sha256, workflowSha);
  assert.equal(
    await readFile(
      new URL("../docs/qualification/application-update-production.complete.yml", import.meta.url),
      "utf8",
    ),
    text,
  );
});
