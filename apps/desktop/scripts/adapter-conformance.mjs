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
const DEFINITION_FIXTURE_PORT_ID = "opengoal-jak1";

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

function portStatus(statuses, portId) {
  const status = statuses.find((item) => item.port_id === portId);
  assert.ok(status, `${portId} must be present in the status result`);
  return status;
}

function assertDefinitionOperation(status, operation, expected) {
  const assessment = status.definition_operations?.find((item) => item.operation === operation);
  assert.ok(assessment, `${status.port_id} must expose the ${operation} definition assessment`);
  assert.deepEqual(assessment, { operation, ...expected });
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
  const setDefinitionState = (action) =>
    runSync(
      "cargo",
      [
        "test",
        "--locked",
        "-p",
        "portcove-core",
        "--features",
        "qualification-fixtures",
        "definition_repository::tests::qualification_adapter_conformance_definition_state",
        "--",
        "--ignored",
        "--exact",
        "--nocapture",
      ],
      {
        env: {
          ...env,
          PORTCOVE_QUALIFICATION_LIBRARY: library,
          PORTCOVE_QUALIFICATION_DEFINITION_PORT: DEFINITION_FIXTURE_PORT_ID,
          PORTCOVE_QUALIFICATION_DEFINITION_ACTION: action,
        },
      },
    );
  const readStatuses = async (stage) => {
    const cliStatuses = parseCliStatuses(
      await run(cli, ["--library", library, "--json", "--non-interactive", "status"], { env }),
    );
    const desktopStatuses = JSON.parse(
      await run(desktop, ["--portcove-adapter-conformance-statuses", library], { env }),
    );
    assert.ok(Array.isArray(desktopStatuses), "Desktop status probe must return an array");
    compareStatusSnapshots(stage, cliStatuses, desktopStatuses);
    const selected = portStatus(cliStatuses, INSTALL_FIXTURE_PORT_ID);
    const definition = portStatus(cliStatuses, DEFINITION_FIXTURE_PORT_ID);
    stages.push({
      stage,
      status_count: cliStatuses.length,
      snapshot_sha256: digest(cliStatuses),
      fixture_status: selected,
      definition_status: definition,
    });
    return { definition, fixture: selected };
  };

  try {
    setDefinitionState("select");
    const initial = await readStatuses("fresh-library");
    assert.equal(initial.fixture.active, null);
    assert.equal(initial.fixture.readiness.launchable, false);
    assertDefinitionOperation(initial.definition, "install", {
      eligibility: { outcome: "eligible", reason: "mandatory_checks_passed" },
      retained: false,
    });

    const installed = JSON.parse(
      await run(
        cli,
        ["--library", library, "--json", "--non-interactive", "ensure", INSTALL_FIXTURE_PORT_ID],
        { env },
      ),
    );
    assert.equal(installed.ok, true, "qualification fixture installation must succeed");
    const ready = await readStatuses("installed");
    assert.ok(ready.fixture.active, "installed fixture must have an active installation");
    assert.equal(ready.fixture.readiness.launchable, true);

    setDefinitionState("install");
    const retained = await readStatuses("successor-definition-installed");
    assert.ok(retained.definition.active, "successor definition must have an active installation");
    assertDefinitionOperation(retained.definition, "install", {
      eligibility: { outcome: "eligible", reason: "mandatory_checks_passed" },
      retained: false,
    });
    for (const operation of ["prepare", "launch"])
      assertDefinitionOperation(retained.definition, operation, {
        eligibility: { outcome: "eligible", reason: "mandatory_checks_passed" },
        retained: true,
      });

    setDefinitionState("revoke");
    const revoked = await readStatuses("successor-definition-revoked");
    for (const operation of ["prepare", "launch"])
      assertDefinitionOperation(revoked.definition, operation, {
        eligibility: { outcome: "hold", reason: "publisher_revoked" },
        retained: true,
      });
    assert.equal(revoked.definition.readiness.launchable, false);

    await writeFile(
      path.join(ready.fixture.active.path, ".portcove-manifest.json"),
      "owned invalid installation manifest",
    );
    const stale = await readStatuses("invalid-installation-manifest");
    assert.equal(stale.fixture.readiness.launchable, false);
    assert.ok(
      stale.fixture.readiness.blockers.includes("invalid_installation"),
      "invalid manifest must produce the stable invalid_installation blocker",
    );

    const report = {
      schema_version: 2,
      fixture_port_id: INSTALL_FIXTURE_PORT_ID,
      definition_fixture_port_id: DEFINITION_FIXTURE_PORT_ID,
      assertions: {
        complete_status_parity: true,
        successor_install_assessment_observed: true,
        retained_prepare_and_launch_assessments_observed: true,
        revoked_definition_hold_reason_observed: true,
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
