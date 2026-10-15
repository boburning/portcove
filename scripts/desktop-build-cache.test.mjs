import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkFrontendBuildReuse,
  createFrontendBuildIdentity,
  recordFrontendBuild,
  createVerificationBuildIdentity,
  qualificationBindingFingerprint,
} from "./desktop-build-cache.mjs";

const inputFiles = [
  ".node-version",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/desktop/index.html",
  "apps/desktop/package.json",
  "apps/desktop/tsconfig.json",
  "apps/desktop/tsconfig.node.json",
  "apps/desktop/tsconfig.orchestration.json",
  "apps/desktop/vite.config.ts",
  "apps/desktop/scripts/build-frontend.mjs",
  "scripts/dev-storage.mjs",
  "scripts/tool-cache.mjs",
];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-desktop-cache-"));
  for (const directory of ["public", "scripts", "src"])
    await mkdir(path.join(root, "apps/desktop", directory), { recursive: true });
  for (const name of inputFiles) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), `${name}\n`);
  }
  await writeFile(path.join(root, "apps/desktop/src/main.ts"), "export {};\n");
  const outputDirectory = path.join(root, "apps/desktop/dist");
  await mkdir(path.join(outputDirectory, "assets"), { recursive: true });
  await writeFile(path.join(outputDirectory, "index.html"), "built\n");
  await writeFile(path.join(outputDirectory, "assets/app.js"), "bundle\n");
  return { root, outputDirectory, stampPath: path.join(root, "work/frontend.json") };
}

const identity = (root, overrides = {}) =>
  createFrontendBuildIdentity({
    root,
    packageManager: "pnpm@12.4.1",
    packageManagerVersion: "12.4.1",
    environment: { VITE_CHANNEL: "test" },
    platform: "win32",
    architecture: "x64",
    ...overrides,
  });

test("profile build provenance excludes documentation/harness changes and never treats versions as native completeness", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  for (const name of [
    "Cargo.toml",
    "Cargo.lock",
    "crates/fixture/src/lib.rs",
    "apps/desktop/src-tauri/Cargo.toml",
    "apps/desktop/src-tauri/build.rs",
    "apps/desktop/src-tauri/src/main.rs",
  ]) {
    await mkdir(path.dirname(path.join(state.root, name)), { recursive: true });
    await writeFile(path.join(state.root, name), name);
  }
  const frontendIdentity = await identity(state.root);
  const options = {
    root: state.root,
    frontendIdentity,
    frontendOutputFingerprint: "output",
    features: ["tauri/custom-protocol"],
    platform: "win32",
    environment: { SECRET_TOKEN: "must-not-appear", RUSTFLAGS: "-C opt-level=1" },
    compilerProbe: () => ({ verbose_version: "version-only", sysroot: "mutable/path" }),
  };
  const initial = await createVerificationBuildIdentity(options);
  await writeFile(path.join(state.root, "README.md"), "documentation changed");
  await writeFile(path.join(state.root, "apps/desktop/scripts/fixture.mjs"), "harness changed");
  assert.equal((await createVerificationBuildIdentity(options)).fingerprint, initial.fingerprint);
  assert.equal(initial.inventory_complete, false);
  assert.equal(initial.native_reuse.reused, false);
  assert(!JSON.stringify(initial).includes("must-not-appear"));
  for (const changed of [
    { features: ["different"] },
    { environment: { RUSTFLAGS: "-C opt-level=2" } },
    { compilerProbe: () => ({ verbose_version: "changed" }) },
  ])
    assert.notEqual(
      (await createVerificationBuildIdentity({ ...options, ...changed })).fingerprint,
      initial.fingerprint,
    );
  await writeFile(path.join(state.root, "apps/desktop/src-tauri/src/main.rs"), "product changed");
  assert.notEqual(
    (await createVerificationBuildIdentity(options)).fingerprint,
    initial.fingerprint,
  );
});

test("unchanged products do not authorize scenario reuse after effective runtime/fixture/criteria changes", () => {
  const binding = {
    productArtifacts: ["product"],
    harnessInputs: ["harness"],
    runtimeConditions: { display: "private-X11" },
    fixtureIdentities: ["fixture"],
    initialState: "empty",
    selectedRequirements: ["review"],
    selectedScenarios: ["journey"],
    acceptanceCriteria: ["visible"],
  };
  const original = qualificationBindingFingerprint(binding);
  for (const field of [
    "productArtifacts",
    "harnessInputs",
    "runtimeConditions",
    "fixtureIdentities",
    "initialState",
    "selectedRequirements",
    "selectedScenarios",
    "acceptanceCriteria",
  ])
    assert.notEqual(qualificationBindingFingerprint({ ...binding, [field]: "changed" }), original);
  assert.throws(
    () => qualificationBindingFingerprint({ ...binding, fixtureIdentities: null }),
    /incomplete/,
  );
});

test("reuses only exact frontend inputs, toolchain, environment, and output bytes", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  await mkdir(path.dirname(state.stampPath), { recursive: true });
  const first = await identity(state.root);
  assert.equal(
    (await checkFrontendBuildReuse({ identity: first, ...state })).reason,
    "missing-cache-record",
  );
  const recorded = await recordFrontendBuild({ identity: first, ...state });
  assert.equal(recorded.reused, false);
  assert.deepEqual(await checkFrontendBuildReuse({ identity: first, ...state }), {
    reused: true,
    reason: "exact-inputs-and-outputs-match",
    input_fingerprint: recorded.input_fingerprint,
    output_fingerprint: recorded.output_fingerprint,
    output_files: 2,
  });

  await writeFile(path.join(state.outputDirectory, "assets/app.js"), "tampered\n");
  assert.equal(
    (await checkFrontendBuildReuse({ identity: first, ...state })).reason,
    "frontend-output-changed",
  );
  await writeFile(path.join(state.outputDirectory, "assets/app.js"), "bundle\n");
  const changedEnvironment = await identity(state.root, {
    environment: { VITE_CHANNEL: "production" },
  });
  assert.equal(
    (await checkFrontendBuildReuse({ identity: changedEnvironment, ...state })).reason,
    "frontend-inputs-changed",
  );
});

test("input changes and linked inputs fail closed", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const first = await identity(state.root);
  await writeFile(path.join(state.root, "apps/desktop/src/main.ts"), "export const changed = 1;\n");
  assert.notEqual((await identity(state.root)).fingerprint, first.fingerprint);

  const target = path.join(state.root, "outside");
  await mkdir(target);
  await writeFile(path.join(target, "outside.ts"), "outside\n");
  await symlink(target, path.join(state.root, "apps/desktop/src/linked"), "junction");
  await assert.rejects(identity(state.root), /refuses linked input/u);
});

test("assertion-only desktop scripts preserve exact frontend reuse", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  await mkdir(path.dirname(state.stampPath), { recursive: true });
  const first = await identity(state.root);
  await recordFrontendBuild({ identity: first, ...state });

  await writeFile(
    path.join(state.root, "apps/desktop/scripts/desktop-workspace-refresh-test.mjs"),
    "assert.equal(actual, expected);\n",
  );
  const afterAssertionEdit = await identity(state.root);
  await writeFile(path.join(state.root, "README.md"), "Documentation-only change\n");
  assert.equal((await identity(state.root)).fingerprint, first.fingerprint);
  assert.equal(afterAssertionEdit.fingerprint, first.fingerprint);
  assert.equal(
    (await checkFrontendBuildReuse({ identity: afterAssertionEdit, ...state })).reused,
    true,
  );
});

for (const frontendInput of [
  "apps/desktop/src/main.ts",
  "apps/desktop/public/new-input.txt",
  "apps/desktop/index.html",
  "apps/desktop/vite.config.ts",
  "apps/desktop/package.json",
  "apps/desktop/scripts/build-frontend.mjs",
  "scripts/dev-storage.mjs",
  "scripts/tool-cache.mjs",
]) {
  test(`changing ${frontendInput} invalidates frontend reuse`, async (t) => {
    const state = await fixture();
    t.after(() => rm(state.root, { recursive: true, force: true }));
    await mkdir(path.dirname(state.stampPath), { recursive: true });
    const first = await identity(state.root);
    await recordFrontendBuild({ identity: first, ...state });

    await writeFile(path.join(state.root, frontendInput), `changed ${frontendInput}\n`);
    assert.equal(
      (await checkFrontendBuildReuse({ identity: await identity(state.root), ...state })).reason,
      "frontend-inputs-changed",
    );
  });
}

for (const viteEnvironmentFile of [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
]) {
  test(`Vite ${viteEnvironmentFile} presence invalidates frontend reuse`, async (t) => {
    const state = await fixture();
    t.after(() => rm(state.root, { recursive: true, force: true }));
    await mkdir(path.dirname(state.stampPath), { recursive: true });
    const first = await identity(state.root);
    await recordFrontendBuild({ identity: first, ...state });

    await writeFile(path.join(state.root, "apps/desktop", viteEnvironmentFile), "VITE_NEW=1\n");
    assert.equal(
      (await checkFrontendBuildReuse({ identity: await identity(state.root), ...state })).reason,
      "frontend-inputs-changed",
    );
  });
}
