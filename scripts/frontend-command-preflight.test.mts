import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { isRecord } from "./runtime-values.mts";
import { frontendCommandPlan, probeFrontendCommand } from "./frontend-command-preflight.mts";
import { acquireDesktopVerifySession } from "./desktop-verify.mts";
import { vitePlusCommand } from "./viteplus-cli.mts";

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
async function fixture(t: TestContext, native = false) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pcv installed cli "));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, "node_modules/vite-plus");
  await mkdir(path.join(directory, "bin"), { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "vite-plus",
      version: "1.2.0",
      type: "module",
      exports: { "./package.json": "./package.json" },
      bin: { vp: native ? "bin/vp.cmd" : "bin/vp" },
    }),
  );
  const executable = path.join(directory, "bin", native ? "vp.cmd" : "vp");
  await writeFile(
    executable,
    native
      ? '@echo off\r\nif defined TAURI_SIGNING_PRIVATE_KEY exit /b 3\r\nif not "%CD%"=="%EXPECTED_CWD%" exit /b 4\r\necho vp v1.2.0\r\n'
      : '#!/usr/bin/env node\nif(process.env.TAURI_SIGNING_PRIVATE_KEY)process.exit(3);console.log("vp v1.2.0");\n',
  );
  return {
    cwd,
    executable,
    environment: {
      PATH: cwd,
      SystemRoot: process.env.SystemRoot,
      EXPECTED_CWD: cwd,
      TAURI_SIGNING_PRIVATE_KEY: "excluded",
      tauri_signing_password: "excluded",
      RETAINED: "yes",
    },
  };
}

void test("frontend probe uses the same declared installed executable as build, with finite budgets", async (t) => {
  const input = await fixture(t);
  const cli = vitePlusCommand(input.cwd);
  const receipt = probeFrontendCommand({
    ...input,
    run(command, args, config) {
      assert.equal(command, process.execPath);
      assert.equal(command, cli.command);
      assert.deepEqual(args, [...cli.args, "--version"]);
      assert.equal(config.cwd, input.cwd);
      assert.equal(config.env.TAURI_SIGNING_PRIVATE_KEY, undefined);
      assert.equal(config.env.tauri_signing_password, undefined);
      assert.equal(config.env.RETAINED, "yes");
      assert.equal(config.timeout, 10_000);
      assert.equal(config.maxBuffer, 16 * 1024);
      return { status: 0, stdout: "vp v1.2.0\r\n\nTools:\n  vite v8.3.4\n", stderr: "" };
    },
  });
  assert.equal(receipt.ready, true);
  assert.equal(receipt.observed_version, "1.2.0");
});

void test("preflight failures are retained before any native lease acquisition", async (t) => {
  const input = await fixture(t);
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
    () => ({ status: 0, stdout: "vp v1.1.0", stderr: "" }),
    () => ({ status: 1, stdout: "vp v1.2.0", stderr: "failed" }),
    () => ({ status: 0, stdout: "vp v1.2.0", stderr: "💾".repeat(20_000) }),
    () => ({ status: 0, stdout: "unexpected wrapper output\nvp v1.2.0", stderr: "" }),
  ];
  for (const [index, run] of cases.entries()) {
    const runDirectory = path.join(input.cwd, String(index));
    await mkdir(runDirectory);
    await assert.rejects(
      acquireDesktopVerifySession({
        runDirectory,
        environment: input.environment,
        selection: { selected_scenarios: [] },
        timings: [],
        probe: () => probeFrontendCommand({ ...input, run }),
        acquire: () => assert.fail("Prerequisite failure acquired lease"),
      }),
      /prerequisite failed/,
    );
    const receipt = object(
      JSON.parse(
        await readFile(path.join(runDirectory, "frontend-command-preflight.json"), "utf8"),
      ),
    );
    assert.equal(receipt.ready, false);
    assert.equal(receipt.observed_version, null);
    assert.ok(typeof receipt.stdout === "string" && typeof receipt.stderr === "string");
    assert(Buffer.byteLength(receipt.stdout) <= 16 * 1024);
    assert(Buffer.byteLength(receipt.stderr) <= 16 * 1024);
  }
});

void test("successful installed-CLI preflight is retained before session acquisition", async (t) => {
  const input = await fixture(t);
  const runDirectory = path.join(input.cwd, "ready");
  await mkdir(runDirectory);
  const result = await acquireDesktopVerifySession({
    runDirectory,
    environment: input.environment,
    selection: { selected_scenarios: [] },
    timings: [],
    probe: () => probeFrontendCommand(input),
    acquire: async () => {
      assert.equal(
        object(
          JSON.parse(
            await readFile(path.join(runDirectory, "frontend-command-preflight.json"), "utf8"),
          ),
        ).ready,
        true,
      );
      return "owned-lock";
    },
  });
  assert.equal(result.lock, "owned-lock");
  assert.equal(result.vitePlusVersion, "1.2.0");
});

void test("installed Node CLI runs with no package manager, Corepack or global vp on PATH", async (t) => {
  const input = await fixture(t);
  const plan = frontendCommandPlan(input);
  assert.equal(plan.file_available, true);
  assert.equal(plan.execution, "not-run");
  assert.equal(plan.observed_version, null);
  assert.equal(probeFrontendCommand(input).ready, true);
  await rm(input.executable);
  const missing = probeFrontendCommand(input);
  assert.equal(missing.ready, false);
  assert.equal(missing.execution, "not-run");
});

void test(
  "declared native batch executable is not incorrectly launched as JavaScript",
  { skip: process.platform !== "win32" },
  async (t) => {
    const input = await fixture(t, true);
    const cli = vitePlusCommand(input.cwd);
    assert.equal(cli.command, input.executable);
    assert.deepEqual(cli.args, []);
    assert.equal(probeFrontendCommand(input).ready, true);
  },
);

void test("missing installation refuses PATH fallback and declared escaping executables", async (t) => {
  const input = await fixture(t);
  const file = path.join(input.cwd, "node_modules/vite-plus/package.json");
  const manifest = object(JSON.parse(await readFile(file, "utf8")));
  object(manifest.bin).vp = "../../../foreign-vp";
  await writeFile(file, JSON.stringify(manifest));
  assert.throws(() => vitePlusCommand(input.cwd), /escapes/);
  assert.equal(probeFrontendCommand(input).ready, false);
});
