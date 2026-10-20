import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { isRecord } from "./runtime-values.mts";
import {
  inspectPublicBuildInputIdentity,
  prepareReleasePublicBuildInputs,
} from "./release-public-build-inputs.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const revision = "a".repeat(40);
function record(value: unknown) {
  assert.ok(isRecord(value));
  return value;
}
function jsonRecord(text: string) {
  return record(JSON.parse(text));
}
function records(value: unknown) {
  assert.ok(Array.isArray(value));
  return value.map((entry: unknown) => record(entry));
}
function text(value: unknown) {
  assert.equal(typeof value, "string");
  return String(value);
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-public-build-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "configuration");
  const configurationRoot = path.join(checkout, "release-public-inputs");
  const outputRoot = path.join(root, "output");
  await mkdir(configurationRoot, { recursive: true });
  // Structurally valid inert public material, not signed-root or release evidence.
  const key = { keytype: "ed25519", scheme: "ed25519", keyval: { public: "11".repeat(32) } };
  const role = { keyids: ["fixture-public-key"], threshold: 1 };
  const material = {
    root: json({
      signatures: [{ keyid: "fixture-public-key", sig: "00".repeat(64) }],
      signed: {
        _type: "root",
        spec_version: "1.0.0",
        version: 1,
        consistent_snapshot: true,
        expires: "2030-01-01T00:00:00Z",
        keys: { "fixture-public-key": key },
        roles: { root: role, targets: role, snapshot: role, timestamp: role },
      },
    }),
    payload_public_key: Buffer.from(
      Buffer.from(
        `untrusted comment: inert fixture public key\n${Buffer.concat([Buffer.from("Ed"), Buffer.alloc(40, 1)]).toString("base64")}\n`,
      ).toString("base64"),
    ),
    packaging: await readFile(
      path.join(project, "apps/desktop/src-tauri/tauri.release-public.conf.json"),
    ),
  };
  const names = {
    root: "root.json",
    payload_public_key: "updater-public.key",
    packaging: "packaging.json",
  };
  const makeManifest = async (overrides: Record<string, unknown> = {}) => {
    for (const field of ["root", "payload_public_key", "packaging"] as const)
      await writeFile(path.join(configurationRoot, names[field]), material[field]);
    const manifest = json({
      schema_version: 1,
      repository: "boburning/portcove",
      purpose: "application-release-public-build-inputs",
      metadata_url: "https://boburning.github.io/portcove/application/metadata/",
      targets_url: "https://boburning.github.io/portcove/application/targets/",
      ...Object.fromEntries(
        Object.entries(material).map(([name, bytes]) => [
          name,
          { bytes: bytes.length, sha256: digest(bytes) },
        ]),
      ),
      ...overrides,
    });
    await writeFile(path.join(configurationRoot, "bundle.json"), manifest);
    return digest(manifest);
  };
  const expectedManifestSha256 = await makeManifest();
  const options = {
    configurationRoot,
    outputRoot,
    observedRevision: revision,
    expectedRevision: revision,
    expectedManifestSha256,
  };
  return { root, checkout, configurationRoot, outputRoot, options, material, makeManifest };
}

void test("ratified public bytes materialize the existing compile inputs and updater overlay without signing", async (t) => {
  const f = await fixture(t);
  const before = await Promise.all(
    (await readdir(f.configurationRoot))
      .sort()
      .map((name) => readFile(path.join(f.configurationRoot, name))),
  );
  const result = await prepareReleasePublicBuildInputs(f.options);
  assert.deepEqual(
    await readFile(result.environment.PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE),
    f.material.root,
  );
  const overlay = jsonRecord(
    await readFile(result.environment.PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION, "utf8"),
  );
  assert.equal(record(overlay.bundle).createUpdaterArtifacts, true);
  assert.equal(record(record(record(overlay.bundle).windows).nsis).installMode, "currentUser");
  assert.equal(
    record(record(overlay.plugins).updater).pubkey,
    f.material.payload_public_key.toString("utf8"),
  );
  assert.equal(
    result.environment.PORTCOVE_APPLICATION_UPDATE_METADATA_URL,
    "https://boburning.github.io/portcove/application/metadata/",
  );
  assert.equal(
    result.environment.PORTCOVE_APPLICATION_UPDATE_TARGETS_URL,
    "https://boburning.github.io/portcove/application/targets/",
  );
  assert.equal(result.receipt.configuration_revision, revision);
  assert.equal(result.receipt.manifest_sha256, f.options.expectedManifestSha256);
  assert.equal(result.receipt.root_sha256, digest(f.material.root));
  assert.equal(result.receipt.payload_public_key_sha256, digest(f.material.payload_public_key));
  assert.equal(result.receipt.packaging_sha256, digest(f.material.packaging));
  assert.equal(
    result.receipt.tauri_configuration_sha256,
    digest(await readFile(result.environment.PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION)),
  );
  assert.equal(result.receipt.authority, "none");
  assert.match(result.receipt.signing, /deferred.*--no-sign/);
  const repeated = await prepareReleasePublicBuildInputs(f.options);
  assert.notEqual(result.output, repeated.output);
  assert.deepEqual(result.receipt, repeated.receipt);
  assert.deepEqual(
    await Promise.all(
      (await readdir(f.configurationRoot))
        .sort()
        .map((name) => readFile(path.join(f.configurationRoot, name))),
    ),
    before,
  );
  const dev = jsonRecord(
    await readFile(path.join(project, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  assert.equal(record(dev.bundle).createUpdaterArtifacts, false);
  assert.equal(dev.plugins, undefined);
});

void test("public trust identities cannot be omitted, changed or replaced by a branch name", async (t) => {
  const f = await fixture(t);
  for (const [commit, hash] of [
    [undefined, undefined],
    ["main", f.options.expectedManifestSha256],
    [revision, "f".repeat(63)],
  ])
    assert.throws(() => inspectPublicBuildInputIdentity(commit, hash), /ratified/);
  await assert.rejects(
    prepareReleasePublicBuildInputs({ ...f.options, observedRevision: "b".repeat(40) }),
    /checkout changed/,
  );
  await assert.rejects(
    prepareReleasePublicBuildInputs({ ...f.options, expectedManifestSha256: "b".repeat(64) }),
    /manifest digest/,
  );
  await writeFile(path.join(f.configurationRoot, "updater-public.key"), "substituted public key");
  await assert.rejects(prepareReleasePublicBuildInputs(f.options), /bytes differ/);
  await assert.rejects(readdir(f.outputRoot), { code: "ENOENT" });
});

void test("catalog origins, foreign scope, hooks and additional executable or private material refuse before outputs", async (t) => {
  const f = await fixture(t);
  for (const override of [
    { metadata_url: "https://boburning.github.io/portcove/catalog/metadata/" },
    { targets_url: "https://attacker.invalid/application/targets/" },
    { repository: "foreign/repository" },
    { purpose: "catalog-build-inputs" },
    { extra_field: "ignored authority" },
  ]) {
    const expectedManifestSha256 = await f.makeManifest(override);
    await assert.rejects(
      prepareReleasePublicBuildInputs({ ...f.options, expectedManifestSha256 }),
      /scope|origins|fields/,
    );
  }
  const packaging = jsonRecord(f.material.packaging.toString("utf8"));
  packaging.build = { beforeBuildCommand: "execute-candidate-content" };
  f.material.packaging = json(packaging);
  const expectedManifestSha256 = await f.makeManifest();
  await assert.rejects(
    prepareReleasePublicBuildInputs({ ...f.options, expectedManifestSha256 }),
    /fixed updater-only overlay/,
  );
  await writeFile(path.join(f.configurationRoot, "private.key"), "must not enter public transport");
  await assert.rejects(
    prepareReleasePublicBuildInputs({ ...f.options, expectedManifestSha256 }),
    /exactly the four/,
  );
  await assert.rejects(readdir(f.outputRoot), { code: "ENOENT" });
});

void test("malformed roots, private root keys and malformed payload keys cannot become compile inputs", async (t) => {
  const f = await fixture(t);
  const originalRoot = f.material.root;
  for (const root of [
    json({ signed: {}, signatures: [] }),
    (() => {
      const root = jsonRecord(originalRoot.toString("utf8"));
      record(record(record(record(root.signed).keys)["fixture-public-key"]).keyval).private =
        "private material";
      return json(root);
    })(),
  ]) {
    f.material.root = root;
    const expectedManifestSha256 = await f.makeManifest();
    await assert.rejects(
      prepareReleasePublicBuildInputs({ ...f.options, expectedManifestSha256 }),
      /root|public verification/,
    );
  }
  f.material.root = originalRoot;
  for (const key of [
    "private key",
    Buffer.from("not a public key").toString("base64"),
    Buffer.from("untrusted comment: key\nAAAA\n").toString("base64"),
  ]) {
    f.material.payload_public_key = Buffer.from(key);
    const expectedManifestSha256 = await f.makeManifest();
    await assert.rejects(
      prepareReleasePublicBuildInputs({ ...f.options, expectedManifestSha256 }),
      /key/,
    );
  }
  await assert.rejects(readdir(f.outputRoot), { code: "ENOENT" });
});

void test("an oversized public file cannot bypass its read bound", async (t) => {
  const f = await fixture(t);
  f.material.root = Buffer.alloc(256 * 1024 + 1, " ");
  const expectedManifestSha256 = await f.makeManifest();
  await assert.rejects(
    prepareReleasePublicBuildInputs({ ...f.options, expectedManifestSha256 }),
    /bounded/,
  );
  await assert.rejects(readdir(f.outputRoot), { code: "ENOENT" });
});

void test("actual CLI reads the exact config checkout and exports build paths without a credential", async (t) => {
  const f = await fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", f.checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "core.autocrlf", "false");
  git("add", "release-public-inputs");
  git(
    "-c",
    "user.name=Public fixture",
    "-c",
    "user.email=fixture@invalid.example",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "inert public fixture",
  );
  const source = git("rev-parse", "HEAD");
  const githubEnvironment = path.join(f.root, "github-env");
  const githubOutput = path.join(f.root, "github-output");
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: "",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    PORTCOVE_APPLICATION_PUBLIC_INPUTS_REVISION: source,
    PORTCOVE_APPLICATION_PUBLIC_INPUTS_SHA256: f.options.expectedManifestSha256,
    PORTCOVE_PUBLIC_CONFIGURATION_CHECKOUT: f.checkout,
    RUNNER_TEMP: f.outputRoot,
    GITHUB_ENV: githubEnvironment,
    GITHUB_OUTPUT: githubOutput,
  };
  const script = path.join(project, "scripts/release-public-build-inputs.mts");
  const identity = spawnSync(process.execPath, [script, "--validate-identity"], {
    env,
    encoding: "utf8",
  });
  assert.equal(identity.status, 0, identity.stderr);
  assert.equal(
    await readFile(githubOutput, "utf8"),
    `revision=${source}\nmanifest_sha256=${f.options.expectedManifestSha256}\n`,
  );
  const execution = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  const receipt = jsonRecord(execution.stdout);
  assert.equal(receipt.configuration_revision, source);
  const exports = await readFile(githubEnvironment, "utf8");
  assert.match(exports, /PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE=/);
  assert.match(exports, /PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION=/);
  assert.doesNotMatch(exports, /PRIVATE|PASSWORD/);
  const refused = spawnSync(process.execPath, [script], {
    env: { ...env, TAURI_SIGNING_PRIVATE_KEY: "inert forbidden credential" },
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /must not receive signing credentials/);
});

void test("Release beta wiring pins public inputs outside candidate content, retains provenance and builds with --no-sign", async () => {
  const workflow = record(
    parse(await readFile(path.join(project, ".github/workflows/release.yml"), "utf8")),
  );
  const jobs = record(workflow.jobs);
  const identity = record(jobs.identity);
  const binding = record(
    records(identity.steps).find((step) => step.id === "public-input-identity"),
  );
  assert.match(text(binding.if), /initial-beta-win-linux/);
  assert.equal(
    record(binding.env).PORTCOVE_APPLICATION_PUBLIC_INPUTS_REVISION,
    "${{ vars.PORTCOVE_APPLICATION_PUBLIC_INPUTS_REVISION }}",
  );
  assert.equal(
    record(binding.env).PORTCOVE_APPLICATION_PUBLIC_INPUTS_SHA256,
    "${{ vars.PORTCOVE_APPLICATION_PUBLIC_INPUTS_SHA256 }}",
  );
  assert.match(text(binding.run), /--validate-identity/);
  const steps = records(record(jobs.build).steps);
  const checkout = record(
    steps.find(
      (step) =>
        step.name === "Read immutable public application configuration without executing it",
    ),
  );
  assert.equal(record(checkout.with).repository, "boburning/portcove");
  assert.equal(
    record(checkout.with).ref,
    "${{ needs.identity.outputs.public_configuration_revision }}",
  );
  assert.equal(record(checkout.with)["persist-credentials"], false);
  assert.equal(record(checkout.with)["sparse-checkout"], "release-public-inputs");
  const prepare = record(
    steps.find(
      (step) => step.name === "Prepare secret-free updater-capable public build configuration",
    ),
  );
  assert.match(text(prepare.run), /node scripts\/release-public-build-inputs\.mts$/);
  const retention = record(
    steps.find(
      (step) => step.name === "Retain exact public build inputs and configuration provenance",
    ),
  );
  assert.equal(record(retention.with)["retention-days"], 7);
  assert.equal(record(retention.with).overwrite, false);
  assert.match(
    text(record(retention.with).name),
    /matrix.label.*github.run_id.*github.run_attempt/,
  );
  const build = record(steps.find((step) => step.name === "Build desktop bundles"));
  assert.match(text(build.run), /--no-sign.*--config/);
  assert.match(text(build.run), /PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION/);
  assert.doesNotMatch(JSON.stringify(jobs.build), /secrets\.|TAURI_SIGNING_PRIVATE_KEY/);
  const packageJson = jsonRecord(
    await readFile(path.join(project, "apps/desktop/package.json"), "utf8"),
  );
  assert.equal(record(packageJson.devDependencies)["@tauri-apps/cli"], "2.12.2");
});
