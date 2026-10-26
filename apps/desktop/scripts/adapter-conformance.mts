import { transportValue, transportValues } from "./transport-values.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import type { PortStatus } from "../src/transport-types.generated.js";
interface ProcessOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInstallFixture, INSTALL_FIXTURE_PORT_ID } from "./desktop-install-fixture.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFINITION_FIXTURE_PORT_ID = "opengoal-jak1";

export function runSync(
  command: string,
  args: readonly string[],
  { env = process.env, timeout = 600_000 }: ProcessOptions = {},
) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  if (result.error) {
    try {
      if (result.stdout) process.stdout.write(result.stdout);
    } catch {
      // Diagnostic emission must not replace the original subprocess failure.
    }
    try {
      if (result.stderr) process.stderr.write(result.stderr);
    } catch {
      // Attempt both streams while keeping the original failure authoritative.
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status ?? "without a status"}\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function run(
  command: string,
  args: readonly string[],
  { env = process.env, timeout = 180_000 }: ProcessOptions = {},
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: unknown) => {
      assert(Buffer.isBuffer(chunk));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: unknown) => {
      assert(Buffer.isBuffer(chunk));
      stderr.push(chunk);
    });
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

export function parseCliStatuses(stdout: string, expectedSchema: number) {
  assert(
    Number.isSafeInteger(expectedSchema) && expectedSchema > 0,
    "CLI schema expectation must be a positive integer",
  );
  const response: unknown = JSON.parse(stdout);
  assert(isRecord(response), "CLI status response must be an object");
  assert.equal(
    response.schema_version,
    expectedSchema,
    "CLI status schema must match the compiled capability document",
  );
  assert.equal(response.ok, true, "CLI status response must succeed");
  assert.equal(response.error, null, "Successful CLI status must not carry an error");
  assert.equal(response.command, "status", "CLI must identify the status command");
  assert.ok(Array.isArray(response.data), "CLI status response must contain an array");
  return transportValues("status", response.data);
}

export function compareStatusSnapshots(
  stage: string,
  cliStatuses: unknown,
  desktopStatuses: unknown,
) {
  try {
    assert.deepEqual(desktopStatuses, cliStatuses);
  } catch (error) {
    throw new Error(`${stage}: CLI and Desktop status adapters diverged`, { cause: error });
  }
}

function portStatus(statuses: readonly PortStatus[], portId: string) {
  const status = statuses.find((item) => item.port_id === portId);
  assert.ok(status, `${portId} must be present in the status result`);
  return status;
}

function assertDefinitionOperation(
  status: PortStatus,
  operation: NonNullable<PortStatus["definition_operations"]>[number]["operation"],
  expected: Pick<
    NonNullable<PortStatus["definition_operations"]>[number],
    "eligibility" | "retained"
  >,
) {
  const assessment = status.definition_operations?.find((item) => item.operation === operation);
  assert.ok(assessment, `${status.port_id} must expose the ${operation} definition assessment`);
  assert.deepEqual(assessment, { operation, ...expected });
}

function digest(value: unknown) {
  const serialized = JSON.stringify(value);
  assert(serialized !== undefined);
  return createHash("sha256").update(serialized).digest("hex");
}

export function compareConsumerIdentities(before: unknown, after: unknown) {
  assert.deepEqual(after, before, "compiled consumers changed during fixture progression");
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
    "qualification-fixtures",
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

  const consumerIdentities = async () => ({
    cli: createHash("sha256")
      .update(await readFile(cli))
      .digest("hex"),
    desktop: createHash("sha256")
      .update(await readFile(desktop))
      .digest("hex"),
  });
  const builtConsumers = await consumerIdentities();

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

  const stages: {
    stage: string;
    status_count: number;
    snapshot_sha256: string;
    fixture_status: PortStatus;
    definition_status: PortStatus;
  }[] = [];
  const setDefinitionState = (action: string) =>
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
  const readStatuses = async (stage: string, schemaVersion: number) => {
    const cliOutput = await run(
      cli,
      ["--library", library, "--json", "--non-interactive", "status"],
      { env },
    );
    const cliStatuses = parseCliStatuses(cliOutput, schemaVersion);
    const envelope: unknown = JSON.parse(cliOutput);
    assert(isRecord(envelope));
    assert.throws(() =>
      parseCliStatuses(
        JSON.stringify({ ...envelope, schema_version: schemaVersion + 1 }),
        schemaVersion,
      ),
    );
    assert.throws(() =>
      parseCliStatuses(
        JSON.stringify({ ...envelope, data: [{ ...cliStatuses[0], port_id: null }] }),
        schemaVersion,
      ),
    );
    const desktopRaw: unknown = JSON.parse(
      await run(desktop, ["--portcove-adapter-conformance-statuses", library], { env }),
    );
    assert.ok(Array.isArray(desktopRaw), "Desktop status probe must return an array");
    const desktopStatuses = transportValues("status", desktopRaw);
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
    const capabilitiesResponse: unknown = JSON.parse(
      await run(cli, ["--json", "--non-interactive", "capabilities"], { env }),
    );
    assert(isRecord(capabilitiesResponse), "CLI capabilities must be an object");
    assert.equal(capabilitiesResponse.ok, true);
    assert.equal(capabilitiesResponse.command, "capabilities");
    assert.equal(capabilitiesResponse.error, null);
    const capabilities = transportValue("capabilities", capabilitiesResponse.data);
    assert.equal(
      capabilitiesResponse.schema_version,
      capabilities.schema_version,
      "CLI capability envelope and payload schemas must agree",
    );

    setDefinitionState("select");
    const initial = await readStatuses("fresh-library", capabilities.schema_version);
    assert.equal(initial.fixture.active, null);
    assert(initial.fixture.readiness);
    assert.equal(initial.fixture.readiness.launchable, false);
    assertDefinitionOperation(initial.definition, "install", {
      eligibility: { outcome: "eligible", reason: "mandatory_checks_passed" },
      retained: false,
    });

    const installed: unknown = JSON.parse(
      await run(
        cli,
        ["--library", library, "--json", "--non-interactive", "ensure", INSTALL_FIXTURE_PORT_ID],
        { env },
      ),
    );
    assert(isRecord(installed));
    assert.equal(installed.ok, true, "qualification fixture installation must succeed");
    const ready = await readStatuses("installed", capabilities.schema_version);
    assert.ok(ready.fixture.active, "installed fixture must have an active installation");
    assert(ready.fixture.readiness);
    assert.equal(ready.fixture.readiness.launchable, true);

    setDefinitionState("install");
    const retained = await readStatuses(
      "successor-definition-installed",
      capabilities.schema_version,
    );
    assert.ok(retained.definition.active, "successor definition must have an active installation");
    assertDefinitionOperation(retained.definition, "install", {
      eligibility: { outcome: "eligible", reason: "mandatory_checks_passed" },
      retained: false,
    });
    for (const operation of ["prepare", "launch"] as const)
      assertDefinitionOperation(retained.definition, operation, {
        eligibility: { outcome: "eligible", reason: "mandatory_checks_passed" },
        retained: true,
      });

    setDefinitionState("revoke");
    const revoked = await readStatuses("successor-definition-revoked", capabilities.schema_version);
    for (const operation of ["prepare", "launch"] as const)
      assertDefinitionOperation(revoked.definition, operation, {
        eligibility: { outcome: "hold", reason: "publisher_revoked" },
        retained: true,
      });
    assert(revoked.definition.readiness);
    assert.equal(revoked.definition.readiness.launchable, false);

    const managedReport = path.join(workspace, "managed-consumers.json");
    const managedEnv: NodeJS.ProcessEnv = { ...env };
    delete managedEnv.PORTCOVE_QUALIFICATION_CATALOG;
    runSync(
      process.execPath,
      [
        "scripts/run-rust-tests.mts",
        "--guard-command",
        "cargo",
        "test",
        "--locked",
        "-p",
        "portcove-core",
        "--features",
        "qualification-fixtures",
        "definition_repository::tests::publisher_policy_tests::compiled_clients::qualification_compiled_clients_consume_managed_corrections",
        "--",
        "--ignored",
        "--exact",
        "--nocapture",
      ],
      {
        env: {
          ...managedEnv,
          PORTCOVE_QUALIFICATION_CLI_PATH: cli,
          PORTCOVE_QUALIFICATION_CLI_SHA256: builtConsumers.cli,
          PORTCOVE_QUALIFICATION_DESKTOP_PATH: desktop,
          PORTCOVE_QUALIFICATION_DESKTOP_SHA256: builtConsumers.desktop,
          PORTCOVE_QUALIFICATION_CONSUMER_REPORT: managedReport,
        },
      },
    );
    const managedConsumers: unknown = JSON.parse(await readFile(managedReport, "utf8"));
    compareConsumerIdentities(builtConsumers, await consumerIdentities());

    await writeFile(
      path.join(ready.fixture.active.path, ".portcove-manifest.json"),
      "owned invalid installation manifest",
    );
    const stale = await readStatuses("invalid-installation-manifest", capabilities.schema_version);
    assert(stale.fixture.readiness);
    assert.equal(stale.fixture.readiness.launchable, false);
    assert.ok(
      stale.fixture.readiness.blockers.includes("invalid_installation"),
      "invalid manifest must produce the stable invalid_installation blocker",
    );

    const report = {
      schema_version: 3,
      consumer_sha256: builtConsumers,
      api_schema_version: capabilities.schema_version,
      managed_consumers: managedConsumers,
      fixture_port_id: INSTALL_FIXTURE_PORT_ID,
      definition_fixture_port_id: DEFINITION_FIXTURE_PORT_ID,
      assertions: {
        complete_status_parity: true,
        serialized_wrong_schema_rejected: true,
        serialized_required_field_mutation_rejected: true,
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
