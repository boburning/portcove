import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkFrontendBuildReuse,
  createFrontendBuildIdentity,
  recordFrontendBuild,
} from "./desktop-build-cache.mjs";

const inputFiles = [
  ".node-version",
  "apps/desktop/index.html",
  "apps/desktop/package.json",
  "apps/desktop/pnpm-lock.yaml",
  "apps/desktop/pnpm-workspace.yaml",
  "apps/desktop/stylelint.config.mjs",
  "apps/desktop/tsconfig.json",
  "apps/desktop/tsconfig.node.json",
  "apps/desktop/vite.config.ts",
];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-desktop-cache-"));
  for (const directory of ["assets", "public", "scripts", "src"])
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
