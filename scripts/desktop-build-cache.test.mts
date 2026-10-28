import type { FrontendBuildIdentityOptions } from "./desktop-build-cache.mts";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFrontendBuildIdentity,
  observeFrontendBuild,
  createVerificationBuildIdentity,
} from "./desktop-build-cache.mts";

const inputFiles = [
  ".node-version",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/desktop/index.html",
  "apps/desktop/package.json",
  "apps/desktop/tsconfig.json",
  "tsconfig.base.json",
  "apps/desktop/vite.config.ts",
  "apps/desktop/scripts/build-frontend.mts",
  "apps/desktop/scripts/production-css.mts",
  "scripts/viteplus-cli.mts",
  "scripts/dev-storage.mts",
  "scripts/development-scratch.mts",
  "scripts/node-test-suites.mts",
  "scripts/node-test-suites.json",
  "scripts/tool-cache.mts",
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

const identity = (root: string, overrides: Partial<FrontendBuildIdentityOptions> = {}) =>
  createFrontendBuildIdentity({
    root,
    packageManager: "pnpm@12.4.1",
    vitePlusVersion: "1.2.0",
    environment: { VITE_CHANNEL: "test" },
    platform: "win32",
    architecture: "x64",
    ...overrides,
  });

void test("profile build provenance excludes documentation/harness changes and never treats versions as native completeness", async (t) => {
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

void test("frontend output observations bind bytes without granting reuse or fresh acceptance", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const first = await identity(state.root);
  const observed = await observeFrontendBuild({ identity: first, ...state });
  assert.equal(observed.execution_owner, "vite-task");
  assert.equal(observed.output_files, 2);
  assert.equal(observed.input_fingerprint, first.fingerprint);
  assert.equal(Object.hasOwn(observed, "reused"), false);
  await writeFile(path.join(state.outputDirectory, "assets/app.js"), "tampered");
  assert.notEqual(
    (await observeFrontendBuild({ identity: first, ...state })).output_fingerprint,
    observed.output_fingerprint,
  );
  await rm(state.outputDirectory, { recursive: true });
  await assert.rejects(observeFrontendBuild({ identity: first, ...state }), /ENOENT/u);
});

void test("input changes and linked inputs fail closed", async (t) => {
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

void test("assertion-only desktop scripts preserve frontend product observations", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const first = await identity(state.root);

  await writeFile(
    path.join(state.root, "apps/desktop/scripts/desktop-workspace-refresh-test.mts"),
    "assert.equal(actual, expected);\n",
  );
  const afterAssertionEdit = await identity(state.root);
  await writeFile(path.join(state.root, "README.md"), "Documentation-only change\n");
  assert.equal((await identity(state.root)).fingerprint, first.fingerprint);
  assert.equal(afterAssertionEdit.fingerprint, first.fingerprint);
  await writeFile(path.join(state.root, "scripts/browser-traces.ts"), "reporting changed");
  assert.equal((await identity(state.root)).fingerprint, first.fingerprint);
});

for (const frontendInput of [
  "apps/desktop/src/main.ts",
  "apps/desktop/public/new-input.txt",
  "apps/desktop/index.html",
  "apps/desktop/vite.config.ts",
  "apps/desktop/package.json",
  "apps/desktop/scripts/build-frontend.mts",
  "apps/desktop/scripts/production-css.mts",
  "scripts/dev-storage.mts",
  "scripts/development-scratch.mts",
  "scripts/node-test-suites.mts",
  "scripts/node-test-suites.json",
  "scripts/tool-cache.mts",
]) {
  void test(`changing ${frontendInput} changes the frontend observation`, async (t) => {
    const state = await fixture();
    t.after(() => rm(state.root, { recursive: true, force: true }));
    const first = await identity(state.root);

    await writeFile(path.join(state.root, frontendInput), `changed ${frontendInput}\n`);
    assert.notEqual((await identity(state.root)).fingerprint, first.fingerprint);
  });
}

for (const viteEnvironmentFile of [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
]) {
  void test(`Vite ${viteEnvironmentFile} presence changes the frontend observation`, async (t) => {
    const state = await fixture();
    t.after(() => rm(state.root, { recursive: true, force: true }));
    const first = await identity(state.root);

    await writeFile(path.join(state.root, "apps/desktop", viteEnvironmentFile), "VITE_NEW=1\n");
    assert.notEqual((await identity(state.root)).fingerprint, first.fingerprint);
  });
}
