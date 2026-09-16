import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInstallFixture, INSTALL_FIXTURE_PORT_ID } from "./desktop-install-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function runSync(command, args, { env = process.env, timeout = 600_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status ?? "without a status"}\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function run(command, args, { env = process.env, timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errors = Buffer.concat(stderr).toString("utf8").trim();
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${timeout}ms`));
        return;
      }
      if (status !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${status ?? "without a status"}\n${errors || output}`,
          ),
        );
        return;
      }
      resolve(output);
    });
  });
}

export function parseCliStatuses(stdout) {
  const response = JSON.parse(stdout);
  assert.equal(response.ok, true, "CLI status response must succeed");
  assert.equal(response.command, "status", "CLI must identify the status command");
  assert.ok(Array.isArray(response.data), "CLI status response must contain an array");
  return response.data;
}

export function compareStatusSnapshots(stage, cliStatuses, desktopStatuses) {
  try {
    assert.deepEqual(desktopStatuses, cliStatuses);
  } catch (error) {
    throw new Error(`${stage}: CLI and Desktop status adapters diverged`, { cause: error });
  }
}

function fixtureStatus(statuses) {
  const status = statuses.find((item) => item.port_id === INSTALL_FIXTURE_PORT_ID);
  assert.ok(status, `${INSTALL_FIXTURE_PORT_ID} must be present in the status result`);
  return status;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
    },
  });
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const cli = path.join(root, "target", "debug", `portcove${executableSuffix}`);
  const desktop = path.join(root, "target", "debug", `portcove-desktop${executableSuffix}`);
  runSync("cargo", [
    "build",
    "--locked",
    "--quiet",
    "-p",
    "portcove-cli",
    "--features",
    "portcove-core/qualification-fixtures",
  ]);
  runSync("cargo", [
    "build",
    "--locked",
    "--quiet",
    "-p",
    "portcove-desktop",
    "--features",
    "qualification-fixtures",
  ]);

  const workspace = await mkdtemp(path.join(os.tmpdir(), "portcove-adapter-conformance-"));
  const fixtureOutput = path.join(workspace, "fixture");
  const library = path.join(workspace, "library");
  await mkdir(fixtureOutput);
  const fixture = await createInstallFixture({ root, output: fixtureOutput });
  const env = {
    ...process.env,
    PORTCOVE_PREFERENCES: path.join(workspace, "preferences.json"),
    PORTCOVE_QUALIFICATION_CATALOG: fixture.catalogPath,
  };
  const stages = [];
  const readStatuses = async (stage) => {
    const cliStatuses = parseCliStatuses(
      await run(cli, ["--library", library, "--json", "--non-interactive", "status"], { env }),
    );
    const desktopStatuses = JSON.parse(
      await run(desktop, ["--portcove-adapter-conformance-statuses", library], { env }),
    );
    assert.ok(Array.isArray(desktopStatuses), "Desktop status probe must return an array");
    compareStatusSnapshots(stage, cliStatuses, desktopStatuses);
    const selected = fixtureStatus(cliStatuses);
    stages.push({
      stage,
      status_count: cliStatuses.length,
      snapshot_sha256: digest(cliStatuses),
      fixture_status: selected,
    });
    return selected;
  };

  try {
    const initial = await readStatuses("fresh-library");
    assert.equal(initial.active, null);
    assert.equal(initial.readiness.launchable, false);

    const installed = JSON.parse(
      await run(
        cli,
        ["--library", library, "--json", "--non-interactive", "ensure", INSTALL_FIXTURE_PORT_ID],
        { env },
      ),
    );
    assert.equal(installed.ok, true, "qualification fixture installation must succeed");
    const ready = await readStatuses("installed");
    assert.ok(ready.active, "installed fixture must have an active installation");
    assert.equal(ready.readiness.launchable, true);

    await writeFile(
      path.join(ready.active.path, ".portcove-manifest.json"),
      "owned invalid installation manifest",
    );
    const stale = await readStatuses("invalid-installation-manifest");
    assert.equal(stale.readiness.launchable, false);
    assert.ok(
      stale.readiness.blockers.includes("invalid_installation"),
      "invalid manifest must produce the stable invalid_installation blocker",
    );

    const report = {
      schema_version: 1,
      fixture_port_id: INSTALL_FIXTURE_PORT_ID,
      assertions: {
        complete_status_parity: true,
        isolated_install_reached_launchable: true,
        invalid_manifest_rejected: true,
      },
      stages,
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) await writeFile(path.resolve(values.output), serialized, { flag: "wx" });
    process.stdout.write(serialized);
  } finally {
    await fixture.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
