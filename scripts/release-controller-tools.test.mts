import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";
import {
  bundleControllerEntries,
  controllerBootstrapEnvironment,
  materializeControllerCompilerSource,
} from "./release-controller-tool-build.mts";
import {
  controllerToolAssets,
  controllerToolEntries,
  controllerToolPaths,
  controllerToolPredicateType,
  inspectControllerToolArchive,
  controllerCompilerSourceAsset,
} from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";
import {
  compilerProducerPaths,
  inspectReleaseCompilerSourceClosure,
} from "./release-compiler-source-closure.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  assemblerIdentityFixture,
  expected as identityExpected,
} from "./fixtures/assembler-identity-fixture.mts";
import { verifyControllerToolBootstrapJobIdentity } from "./assembler-job-identity.mts";
import { launchFixedPayloadController } from "./release-controller-tool-launch.mts";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
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
  const child = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-controller-tool-launch.mts")],
    { cwd: root, encoding: "utf8", timeout: 5000, env: { SystemRoot: process.env.SystemRoot } },
  );
  assert.equal(child.status, 2);
  assert.match(child.stderr, /fixed verified-tool payload launcher refused/);
  assert.doesNotMatch(child.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
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
  await writeFile(
    path.join(root, ".github/workflows/release-reviewed-inputs.yml"),
    "fixture workflow bytes; no active reviewed-input workflow claimed",
  );
  assert.deepEqual((await readdir(root)).sort(), [".github", "apps", "release", "scripts"]);
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
  assert.equal(context.status, 2);
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
  assert.equal(
    (
      await readFile(path.join(root, "scripts/release-reviewed-inputs.bundle.mjs"), "utf8")
    ).includes("semver"),
    true,
  );
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
void test("actual pinned AST rewrite preserves Unicode before imported module URLs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-tools-unicode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    output = path.join(root, "output");
  await mkdir(path.join(source, "scripts"), { recursive: true });
  await writeFile(
    path.join(source, "scripts/imported.mts"),
    'const label = "😀é"; export const location = import.meta.url; export {label};\n',
  );
  for (const name of controllerToolEntries)
    await writeFile(
      path.join(source, "scripts", `${name}.mts`),
      'import {location,label} from "./imported.mts"; console.log(JSON.stringify({location,label,entry:import.meta.url}));\n',
    );
  await bundleControllerEntries(source, output);
  for (const name of controllerToolEntries) {
    const bundle = path.join(output, "scripts", `${name}.bundle.mjs`);
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
});
void test("fresh bootstrap OIDC profile authenticates numeric job and refuses wrong job, source, attempt and expiry", async () => {
  const make = (patch: Record<string, unknown> = {}) =>
    assemblerIdentityFixture(
      patch,
      {},
      {
        workflow: ".github/workflows/application-update-production.yml",
        job: "Prepare trusted application controller tools",
      },
    );
  const f = make();
  assert.equal(
    (await verifyControllerToolBootstrapJobIdentity(f.token, identityExpected, f)).job_id,
    501,
  );
  for (const patch of [{ exp: 1 }, { run_attempt: "9" }, { workflow_sha: "b".repeat(40) }]) {
    const bad = make(patch);
    await assert.rejects(
      verifyControllerToolBootstrapJobIdentity(bad.token, identityExpected, bad),
    );
  }
  const other = assemblerIdentityFixture();
  await assert.rejects(
    verifyControllerToolBootstrapJobIdentity(other.token, identityExpected, other),
  );
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

function fixture(closureChange: Record<string, unknown> = {}) {
  const bytes = new Map(
    controllerToolPaths.map((name) => [name, Buffer.from(`inert tool fixture ${name}`)]),
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
    schema_version: 2,
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    platform: "linux-x86_64",
    node_version: "24.22.0",
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
    ["controller-tools-attestation.json", "synthetic fixture; not a protected attestation"],
  ]);
  const expected = {
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
  const toolArtifact = artifact(99, archive, "trusted-controller-tools"),
    bundleArtifact = artifact(100, bundleArchive, "trusted-controller-tools-attestation");
  const producer = { run_id: "9988", run_attempt: 1, job_id: 501, check_run_id: "777" };
  const job = {
    id: 501,
    run_id: 9988,
    run_attempt: 1,
    head_sha: expected.controller_revision,
    name: "Prepare trusted application controller tools",
    status: "completed",
    conclusion: "success",
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
  };
  const predicate = {
    schema_version: 1,
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
          predicateType: controllerToolPredicateType,
          subject: [{ name: "controller-tools-manifest", digest: { sha256: hash(manifestBytes) } }],
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

void test("the receiver dependency closure loads without npm packages before any role credential", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-receiver-no-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    "release-controller-tool-admission",
    "release-controller-tools",
    "release-compiler-source-closure",
    "github-controller-attestation",
    "assembler-job-identity",
    "production-controller-admission",
    "release-control-phases",
    "github-api",
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
