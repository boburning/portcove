import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { frontendCommandPlan, probeFrontendCommand } from "./frontend-command-preflight.mjs";
import { acquireDesktopVerifySession } from "./desktop-verify.mjs";

const options = {
  cwd: path.resolve("apps/desktop"),
  packageManager: "pnpm@12.8.1",
  environment: {
    PATH: "private-path",
    TAURI_SIGNING_PRIVATE_KEY: "excluded",
    tauri_signing_password: "excluded",
    RETAINED: "yes",
  },
};
test("frontend probe uses the build command, cwd, filtered environment and finite budgets", () => {
  const receipt = probeFrontendCommand({
    ...options,
    run(command, args, config) {
      assert.equal(command, "pnpm");
      assert.deepEqual(args, ["--version"]);
      assert.equal(config.cwd, options.cwd);
      assert.deepEqual(config.env, { PATH: "private-path", RETAINED: "yes" });
      assert.equal(config.timeout, 10_000);
      assert.equal(config.maxBuffer, 16 * 1024);
      return { status: 0, stdout: "12.8.1\r\n", stderr: "" };
    },
  });
  assert.equal(receipt.ready, true);
  assert.equal(receipt.observed_version, "12.8.1");
});
test("preflight failure receipt precedes lease acquisition for every rejected observation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-prerequisite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    },
    () => {
      throw Object.assign(new Error("buffer"), { code: "ENOBUFS", stdout: "x".repeat(40_000) });
    },
    () => ({ status: 0, stdout: "11.0.0", stderr: "" }),
    () => ({ status: 1, stdout: "12.8.1", stderr: "failed" }),
    () => ({ status: 0, stdout: "12.8.1", stderr: "💾".repeat(20_000) }),
  ];
  for (const [index, run] of cases.entries()) {
    const runDirectory = path.join(directory, String(index));
    await mkdir(runDirectory);
    await assert.rejects(
      acquireDesktopVerifySession({
        runDirectory,
        environment: options.environment,
        packageManager: options.packageManager,
        selection: { selected_scenarios: [] },
        timings: [],
        probe: (input) => probeFrontendCommand({ ...input, run }),
        acquire: () => assert.fail("Prerequisite failure acquired a lease"),
      }),
      /prerequisite failed/,
    );
    const receipt = JSON.parse(
      await readFile(path.join(runDirectory, "frontend-command-preflight.json"), "utf8"),
    );
    assert.equal(receipt.ready, false);
    assert.equal(receipt.observed_version, null);
    assert(Buffer.byteLength(receipt.stdout) <= 16 * 1024);
    assert(Buffer.byteLength(receipt.stderr) <= 16 * 1024);
  }
});
test("successful preflight is retained before acquiring the session", async (t) => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "pcv-ready-"));
  t.after(() => rm(runDirectory, { recursive: true, force: true }));
  const result = await acquireDesktopVerifySession({
    runDirectory,
    environment: options.environment,
    packageManager: options.packageManager,
    selection: { selected_scenarios: [] },
    timings: [],
    probe: (input) =>
      probeFrontendCommand({ ...input, run: () => ({ status: 0, stdout: "12.8.1", stderr: "" }) }),
    acquire: async () => {
      assert.equal(
        JSON.parse(
          await readFile(path.join(runDirectory, "frontend-command-preflight.json"), "utf8"),
        ).ready,
        true,
      );
      return "owned-lock";
    },
  });
  assert.equal(result.lock, "owned-lock");
  assert.equal(result.packageManagerVersion, "12.8.1");
});
test(
  "actual Windows batch shim in a spaced PATH works without Corepack or cached tool state",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pcv pnpm shim "));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      path.join(directory, "pnpm.cmd"),
      '@echo off\r\nif defined TAURI_SIGNING_PRIVATE_KEY exit /b 3\r\nif not "%CD%"=="%EXPECTED_CWD%" exit /b 4\r\necho 12.8.1\r\n',
    );
    const input = {
      ...options,
      cwd: directory,
      environment: {
        PATH: directory,
        PATHEXT: ".EXE;.CMD;.BAT",
        TAURI_SIGNING_PRIVATE_KEY: "excluded",
        EXPECTED_CWD: directory,
        SystemRoot: process.env.SystemRoot,
      },
    };
    const plan = frontendCommandPlan(input);
    assert.equal(plan.file_available, true);
    assert.equal(plan.execution, "not-run");
    assert.equal(plan.observed_version, null);
    assert.equal(probeFrontendCommand(input).ready, true);
    await rm(path.join(directory, "pnpm.cmd"));
    assert.equal(probeFrontendCommand(input).ready, false);
  },
);
