import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
test("nested repository command chains use Corepack without global pnpm", () => {
  for (const file of ["package.json", "apps/desktop/package.json"]) {
    const scripts = JSON.parse(readFileSync(path.join(root, file), "utf8")).scripts;
    for (const command of Object.values(scripts))
      assert.doesNotMatch(command, /(?<!corepack )\bpnpm\b/u);
  }
});
test("actual build child uses only Corepack, filters signing values and propagates failure", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-corepack-"));
  try {
    const log = path.join(directory, "commands.jsonl"),
      script = path.join(directory, "stub.mjs");
    writeFileSync(
      script,
      `import fs from 'node:fs';fs.appendFileSync(process.env.PROBE_LOG,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),signing:process.env.TAURI_SIGNING_PRIVATE_KEY,public:process.env.VITE_PROBE})+'\\n');process.exit(Number(process.env.PROBE_EXIT||0));`,
    );
    const shim = path.join(directory, process.platform === "win32" ? "corepack.cmd" : "corepack");
    writeFileSync(
      shim,
      process.platform === "win32"
        ? `@"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
    const env = {
      ...process.env,
      PATH: directory + (process.platform === "win32" ? `;${process.env.SYSTEMROOT}/System32` : ""),
      PROBE_LOG: log,
      TAURI_SIGNING_PRIVATE_KEY: "must-not-reach-child",
      VITE_PROBE: "public-value",
    };
    const run = (override = {}) =>
      spawnSync(process.execPath, [path.join(root, "apps/desktop/scripts/build-frontend.mjs")], {
        env: { ...env, ...override },
        encoding: "utf8",
      });
    assert.equal(run().status, 0);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["pnpm", "typecheck"],
        ["pnpm", "exec", "vite", "build"],
      ],
    );
    assert(calls.every((call) => call.signing === undefined && call.public === "public-value"));
    assert(calls.every((call) => path.resolve(call.cwd) === path.join(root, "apps/desktop")));
    writeFileSync(log, "");
    assert.equal(run({ PROBE_EXIT: "7" }).status, 7);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
    const missing = run({
      PATH: process.platform === "win32" ? `${process.env.SYSTEMROOT}/System32` : "/nonexistent",
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /requires Corepack/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
