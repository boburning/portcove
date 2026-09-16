import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireHeavyRustTestLock } from "./heavy-rust-test-lock.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export async function runRustTests(args, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const runSync = dependencies.spawnSync ?? spawnSync;
  const start = dependencies.spawn ?? spawn;
  const acquireLock = dependencies.acquireLock ?? acquireHeavyRustTestLock;
  const base = path.resolve(
    dependencies.tempRoot ?? environment.RUNNER_TEMP ?? environment.PORTCOVE_TEMP_DIR ?? tmpdir(),
  );
  const directory = mkdtempSync(path.join(base, "portcove-host-tool-fixture-"));
  const relative = path.relative(base, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Fixture escaped its temporary root");
  const executable = path.join(directory, process.platform === "win32" ? "probe.exe" : "probe");
  const prepareOnly = args.length === 1 && args[0] === "--prepare-only";
  let retained = false;
  let lock = null;
  try {
    if (!prepareOnly) {
      lock = await acquireLock({ workspace: root, command: `cargo nextest run ${args.join(" ")}` });
    }
    const compiled = runSync(
      "rustc",
      [
        "--crate-name",
        "portcove_host_tool_fixture",
        path.join(root, "crates/portcove-core/src/testdata/host_tool_probe.rs.txt"),
        "-o",
        executable,
      ],
      { stdio: "inherit", windowsHide: true },
    );
    if (compiled.error) throw compiled.error;
    if (compiled.status !== 0) throw new Error("Host-tool fixture compilation failed");
    if (prepareOnly) {
      if (!environment.GITHUB_ENV) throw new Error("--prepare-only requires GITHUB_ENV");
      appendFileSync(environment.GITHUB_ENV, `PORTCOVE_HOST_TOOL_FIXTURE=${executable}\n`);
      retained = true; // The runner owns cleanup after all test steps finish.
      return 0;
    }
    const tested = start("cargo", ["nextest", "run", ...args], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...environment,
        ...lock.childEnvironment,
        PORTCOVE_HOST_TOOL_FIXTURE: executable,
      },
    });
    const completed = waitForChild(tested);
    try {
      await lock.registerChild(tested);
    } catch (error) {
      tested.kill();
      await completed.catch(() => {});
      throw error;
    }
    return await completed;
  } finally {
    if (lock) await lock.release();
    if (!retained) rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  try {
    process.exitCode = await runRustTests(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();
