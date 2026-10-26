import assert from "node:assert/strict";
import type { StoragePaths } from "../../scripts/dev-storage.mts";
import type {
  HeavyRustLock,
  HeavyRustLockOptions,
  HeavyRustMetadata,
} from "../../scripts/heavy-rust-test-lock.mts";
import type {
  DirectReleaseSpec,
  TransportOutputs,
} from "../../apps/desktop/src/transport-types.generated.d.ts";
import { isRecord } from "../../scripts/runtime-values.mts";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getPaths, prepareStorageScope } from "../../scripts/dev-storage.mts";
import { runRustTests } from "../../scripts/run-rust-tests.mts";
import { acquireHeavyRustTestLock } from "../../scripts/heavy-rust-test-lock.mts";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createInstallFixture,
  INSTALL_FIXTURE_PORT_ID,
  INSTALL_REFRESH_FIXTURE_PORT_ID,
} from "../../apps/desktop/scripts/desktop-install-fixture.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contract = path.join(
  root,
  "integrations",
  "playnite",
  "tests",
  "bin",
  "Release",
  "Portcove.ContractTests.exe",
);
const DEFINITION_FIXTURE_PORT_ID = "opengoal-jak1";

export function cargoPhaseArguments(phase: string | undefined, action?: string) {
  if (phase === "cli-build" && action === undefined)
    return [
      "build",
      "--locked",
      "--quiet",
      "-p",
      "portcove-cli",
      "--features",
      "portcove-core/qualification-fixtures",
    ];
  if (
    phase === "definition-state" &&
    action !== undefined &&
    ["select", "install", "revoke"].includes(action)
  )
    return [
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
    ];
  throw new Error("Unknown Playnite Cargo phase");
}

export function lifecyclePaths(
  layout: Pick<StoragePaths, "target_directory" | "temporary_directory">,
) {
  assert.ok(layout.target_directory, "Rust storage must resolve a target directory");
  return {
    cli: path.join(layout.target_directory, "debug", "portcove.exe"),
    temporary: layout.temporary_directory,
  };
}

type CargoGuard = (
  args: string[],
  options: { environment: NodeJS.ProcessEnv; tempRoot?: string },
) => Promise<number>;
export async function runCargoPhase(
  phase: string | undefined,
  action: string | undefined,
  environment: NodeJS.ProcessEnv,
  guard: CargoGuard = runRustTests,
) {
  cargoPhaseArguments(phase, action);
  assert.ok(phase);
  const code = await guard(
    [
      "--guard-command",
      process.execPath,
      fileURLToPath(import.meta.url),
      "--cargo-phase",
      phase,
      ...(action === undefined ? [] : [action]),
    ],
    {
      environment,
      ...(environment.PORTCOVE_TEMP_DIR === undefined
        ? {}
        : { tempRoot: environment.PORTCOVE_TEMP_DIR }),
    },
  );
  if (code !== 0)
    throw new Error(
      `Guarded Playnite ${phase} failed (${code}); retain its guard/closure diagnostics`,
    );
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  echo?: boolean;
}
interface CargoExecutionOptions {
  environment?: NodeJS.ProcessEnv;
  acquire?: (
    metadata: HeavyRustMetadata,
    options: HeavyRustLockOptions,
  ) => Promise<Pick<HeavyRustLock, "inherited" | "release">>;
  execute?: (command: string, args: string[], options: RunOptions) => Promise<unknown>;
}
export async function executeCargoPhase(
  phase: string | undefined,
  action: string | undefined,
  {
    environment = process.env,
    acquire = acquireHeavyRustTestLock,
    execute = run,
  }: CargoExecutionOptions = {},
) {
  const args = cargoPhaseArguments(phase, action);
  if (!environment.PORTCOVE_HEAVY_RUST_LOCK_TOKEN)
    throw new Error("Cargo phases require the existing Heavy Rust guard");
  const lease = await acquire(
    { workspace: root, command: `Playnite ${phase}` },
    {
      inheritedToken: environment.PORTCOVE_HEAVY_RUST_LOCK_TOKEN,
    },
  );
  if (!lease.inherited) throw new Error("Cargo phase did not inherit validated admission");
  try {
    await execute("cargo", args, { env: environment });
  } finally {
    await lease.release(); // Existing inherited lease release is a no-op; the parent owns closure.
  }
}

export function run(
  command: string,
  args: string[],
  { env = process.env, timeout = 600_000, echo = true }: RunOptions = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: unknown) => {
      assert.ok(Buffer.isBuffer(chunk), "unencoded child stdout must contain buffers");
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: unknown) => {
      assert.ok(Buffer.isBuffer(chunk), "unencoded child stderr must contain buffers");
      stderr.push(chunk);
    });
    let timedOut = false;
    let settled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = <Value,>(action: (value: Value) => void, value: Value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      action(value);
    };
    timer = setTimeout(() => {
      timedOut = true;
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      const termination = spawnSync(
        path.join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { cwd: root, windowsHide: true, encoding: "utf8", timeout: 5_000 },
      );
      if (termination.error || termination.status !== 0) child.kill();
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(
          reject,
          new Error(
            `${command} timed out after ${timeout}ms and its owned process tree did not close within 5000ms`,
          ),
        );
      }, 5_000);
    }, timeout);
    child.once("error", (error) => {
      finish(reject, error);
    });
    child.once("close", (status) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errors = Buffer.concat(stderr).toString("utf8").trim();
      if (timedOut) {
        finish(reject, new Error(`${command} timed out after ${timeout}ms`));
        return;
      }
      if (status !== 0) {
        finish(
          reject,
          new Error(`${command} exited ${status ?? "without a status"}\n${errors || output}`),
        );
        return;
      }
      if (output && echo) process.stdout.write(`${output}\n`);
      finish(resolve, output);
    });
  });
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "qualification catalog field must be an object");
  return value;
}
function objects(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "qualification catalog field must be an array");
  const entries: unknown[] = value;
  return entries.map(object);
}
function envelope(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return object(value).data;
}
async function editRelease(
  catalogPath: string,
  portId: string,
  changes: Partial<DirectReleaseSpec>,
) {
  const catalog = object(JSON.parse(await readFile(catalogPath, "utf8")));
  const definition = objects(catalog.ports).find((value) => value.id === portId);
  assert.ok(definition, `${portId} must exist in the qualification catalog`);
  const releases = Object.values(object(object(definition.release).direct));
  assert.equal(releases.length, 1, "qualification fixture must expose one platform release");
  Object.assign(object(releases[0]), changes);
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

async function checkReviewedExternal(
  cli: string,
  library: string,
  catalogPath: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
) {
  const { transportValue } = await import("../../apps/desktop/scripts/transport-values.mts");
  const port = "external-consent-fixture";
  const folder = path.join(workspace, "player-owned external 雪");
  await mkdir(folder);
  const bytes = Buffer.from("Owned external registration fixture; never executed.");
  await writeFile(path.join(folder, "game.exe"), bytes);
  await writeFile(path.join(folder, "player.save"), "owned player data");
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  const tree = createHash("sha256")
    .update("portcove-external-tree-v1\n")
    .update("game.exe")
    .update(Buffer.from([0]))
    .update(size)
    .update(createHash("sha256").update(bytes).digest())
    .digest("hex");
  const catalog = object(JSON.parse(await readFile(catalogPath, "utf8")));
  const ports = objects(catalog.ports);
  const definition = structuredClone(ports.find((value) => value.id === "wave-race-64-recomp"));
  assert.ok(definition, "existing user-prepared adapter must be available to the fixture");
  Object.assign(definition, {
    id: port,
    name: "Owned external consent fixture",
    source_profile: "star-fox-64",
    presentation: null,
  });
  definition.executable_hints = { "windows-x86-64": ["game.exe"] };
  const prepared = object(object(definition.release).user_prepared);
  const preparedRelease = {
    version: "fixture-v1",
    archive_name: "owned.zip",
    archive_size: bytes.length,
    archive_sha256: createHash("sha256").update(bytes).digest("hex"),
    executable: "game.exe",
    immutable_tree_sha256: tree,
    source_argument_extension: "z64",
    mutable_paths: ["player.save"],
  };
  prepared["windows-x86-64"] = preparedRelease;
  ports.push(definition);
  catalog.ports = ports;
  const sourceCatalog = object(catalog.source_catalog);
  const contracts = objects(sourceCatalog.contracts);
  const sourceBinding = structuredClone(
    contracts.find((value) => value.profile_id === "star-fox-64"),
  );
  assert.ok(sourceBinding, "fixture source profile must have an authoritative contract");
  sourceBinding.port_id = port;
  sourceBinding.id = `${port}-game-source`;
  contracts.push(sourceBinding);
  sourceCatalog.contracts = contracts;
  const publish = () => writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await publish();
  const invoke = (...args: string[]) =>
    run(cli, ["--library", library, "--json", "--non-interactive", "external", ...args], {
      env,
      echo: false,
    });
  const read = async <Contract extends keyof TransportOutputs>(
    contract: Contract,
    ...args: string[]
  ) => transportValue(contract, envelope(await invoke(...args)));
  const status = async () =>
    transportValue(
      "status",
      envelope(
        await run(cli, ["--library", library, "--json", "status", port], { env, echo: false }),
      ),
    );
  const preview = await read("external_runtime_preview", "preview", port, folder);
  await assert.rejects(
    invoke("register", port, folder, "--expected-preview", preview.preview_sha256),
    /confirmation|--yes/u,
  );
  assert.equal(
    (await status()).external_runtime ?? null,
    null,
    "declined noninteractive consent cannot register",
  );
  preparedRelease.version = "fixture-v2";
  await publish();
  await assert.rejects(
    invoke("register", port, folder, "--expected-preview", preview.preview_sha256, "--yes"),
    /conflict/u,
  );
  assert.equal(
    (await status()).external_runtime ?? null,
    null,
    "CLI must not replace the caller's stale consent with a fresh digest",
  );
  preparedRelease.version = "fixture-v1";
  await publish();
  const registered = await read(
    "external_runtime_record",
    "register",
    port,
    folder,
    "--expected-preview",
    preview.preview_sha256,
    "--yes",
  );
  assert.equal((await status()).external_runtime?.id, registered.id);
  const original = path.join(workspace, "owned original.n64");
  // Exercise incompatible source format after structural N64 admission, rather
  // than failing earlier on an invalid byte-order header. These are synthetic
  // bytes, not an original game or gameplay qualification.
  const originalBytes = Buffer.alloc(64);
  originalBytes.set([0x40, 0x12, 0x37, 0x80]);
  originalBytes.write("synthetic original source", 4, "ascii");
  await writeFile(original, originalBytes);
  await run(cli, ["--library", library, "--json", "source", "add", "star-fox-64", original], {
    env,
    echo: false,
  });
  const blocked = await status();
  assert.ok(blocked.readiness, "external fixture must expose readiness");
  assert.ok(blocked.port_actions, "external fixture must expose port actions");
  // Extension readiness does not qualify uninstalled source content.
  assert.equal(blocked.readiness.source, "not_checked");
  assert.equal(blocked.readiness.required_source_extension, "z64");
  assert.equal(blocked.readiness.launchable, false);
  assert.deepEqual(blocked.readiness.blockers, ["incompatible_source"]);
  assert.equal(
    blocked.port_actions.find((action) => action.action === "launch")?.availability,
    "waiting",
  );
  assert.match(
    await run(cli, ["--library", library, "status", port], { env, echo: false }),
    /requires uncompressed \.z64 original file/u,
  );
  await run(contract, ["qualification-source-guidance", cli, library, port, original], { env });
  assert.deepEqual(await readFile(original), originalBytes);
  const removal = await read("external_runtime_removal_preview", "removal-preview", port);
  assert.equal(removal.external_files_will_be_preserved, true);
  assert.equal(
    (await status()).external_runtime?.id,
    registered.id,
    "removal preview is read-only",
  );
  await assert.rejects(
    invoke("remove", port, "--expected-preview", "0".repeat(64), "--yes"),
    /conflict/u,
  );
  assert.equal(
    (await status()).external_runtime?.id,
    registered.id,
    "stale CLI removal preserves the registration",
  );
  envelope(await invoke("remove", port, "--expected-preview", removal.preview_sha256, "--yes"));
  const replacement = await read("external_runtime_record", "register", port, folder, "--yes");
  assert.notEqual(
    replacement.id,
    registered.id,
    "legacy omitted-option registration remains supported",
  );
  await assert.rejects(
    invoke("remove", port, "--expected-preview", removal.preview_sha256, "--yes"),
    /conflict/u,
  );
  assert.equal(
    (await status()).external_runtime?.id,
    replacement.id,
    "replaced registration invalidates old consent",
  );
  envelope(await invoke("remove", port, "--yes"));
  assert.equal(
    (await status()).external_runtime ?? null,
    null,
    "legacy registration-only removal remains supported",
  );
  assert.deepEqual(await readFile(path.join(folder, "game.exe")), bytes);
  assert.equal(await readFile(path.join(folder, "player.save"), "utf8"), "owned player data");
  process.stdout.write(
    "PASS actual CLI external preview/register/remove consent binding and external-file preservation\n",
  );
}

async function main() {
  if (process.platform !== "win32")
    throw new Error("Playnite lifecycle qualification requires Windows.");
  const { transportValue } = await import("../../apps/desktop/scripts/transport-values.mts");
  const environment = prepareStorageScope("rust");
  const { cli, temporary } = lifecyclePaths(getPaths("rust"));
  const workspace = await mkdtemp(path.join(temporary, "portcove-playnite-lifecycle-"));
  let fixture;
  let primaryFailure;

  try {
    await runCargoPhase("cli-build", undefined, environment);
    const output = path.join(workspace, "fixture");
    const library = path.join(workspace, "library");
    await mkdir(output);
    fixture = await createInstallFixture({ root, output, holdFirstDownload: true });
    const env = {
      ...environment,
      PORTCOVE_PREFERENCES: path.join(workspace, "preferences.json"),
      PORTCOVE_QUALIFICATION_CATALOG: fixture.catalogPath,
    };
    const identity = transportValue(
      "library_identity",
      envelope(
        await run(
          cli,
          ["--library", library, "--json", "--non-interactive", "library", "identity"],
          {
            env,
            echo: false,
          },
        ),
      ),
    ).id;
    const phase = (mode: string, port: string, ...rest: string[]) =>
      run(contract, [mode, cli, library, port, identity, ...rest], { env });
    await checkReviewedExternal(cli, library, fixture.catalogPath, workspace, env);
    const setDefinitionState = (action: string) =>
      runCargoPhase("definition-state", action, {
        ...env,
        PORTCOVE_QUALIFICATION_LIBRARY: library,
        PORTCOVE_QUALIFICATION_DEFINITION_PORT: DEFINITION_FIXTURE_PORT_ID,
        PORTCOVE_QUALIFICATION_DEFINITION_ACTION: action,
      });

    await phase("qualification-library-busy", INSTALL_REFRESH_FIXTURE_PORT_ID);
    await phase("qualification-concurrency", INSTALL_REFRESH_FIXTURE_PORT_ID);
    assert.equal(fixture.requests.length, 1, "conflict cannot start a competing artifact download");
    assert.ok(fixture.requests[0]);
    assert.equal(fixture.requests[0].completed, false, "cancellation must precede full delivery");
    assert.equal(
      fixture.requests[0].bytes_sent,
      1024 * 1024,
      "real download stays held at its progress handshake",
    );
    await phase("qualification-install", INSTALL_REFRESH_FIXTURE_PORT_ID, "1.0.0-fixture");
    await editRelease(fixture.catalogPath, INSTALL_REFRESH_FIXTURE_PORT_ID, {
      version: "2.0.0-bad-checksum",
      sha256: "1".repeat(64),
      published_at: "2026-09-16T01:30:00Z",
    });
    await phase(
      "qualification-failure",
      INSTALL_REFRESH_FIXTURE_PORT_ID,
      "1.0.0-fixture",
      "verification",
    );
    await fixture.publishRelease(INSTALL_REFRESH_FIXTURE_PORT_ID, {
      version: "2.0.0-fixture",
      publishedAt: "2026-09-16T02:30:00Z",
      seed: 0x24310002,
    });
    await phase("qualification-update", INSTALL_REFRESH_FIXTURE_PORT_ID, "2.0.0-fixture");

    await phase("qualification-install", INSTALL_FIXTURE_PORT_ID, "1.0.0-fixture");

    await editRelease(fixture.catalogPath, INSTALL_FIXTURE_PORT_ID, {
      version: "2.0.0-bad-checksum",
      sha256: "0".repeat(64),
      published_at: "2026-09-16T01:00:00Z",
    });
    await phase("qualification-failure", INSTALL_FIXTURE_PORT_ID, "1.0.0-fixture", "verification");

    await fixture.publishRelease(INSTALL_FIXTURE_PORT_ID, {
      version: "2.0.0-fixture",
      publishedAt: "2026-09-16T02:00:00Z",
      seed: 0x24300002,
    });
    await phase("qualification-update", INSTALL_FIXTURE_PORT_ID, "2.0.0-fixture");

    await editRelease(fixture.catalogPath, INSTALL_FIXTURE_PORT_ID, {
      version: "3.0.0-missing",
      url: fixture.url.replace(/[^/]+$/, "missing-artifact.tar.gz"),
      sha256: "f".repeat(64),
      published_at: "2026-09-16T03:00:00Z",
    });
    await phase("qualification-failure", INSTALL_FIXTURE_PORT_ID, "2.0.0-fixture", "network");

    await fixture.publishRelease(INSTALL_FIXTURE_PORT_ID, {
      version: "3.0.0-fixture",
      publishedAt: "2026-09-16T04:00:00Z",
      seed: 0x24300003,
    });
    await phase("qualification-update", INSTALL_FIXTURE_PORT_ID, "3.0.0-fixture");

    await setDefinitionState("select");
    await setDefinitionState("install");
    await phase("qualification-definition", DEFINITION_FIXTURE_PORT_ID);
    await setDefinitionState("revoke");
    await phase("qualification-definition-revoked", DEFINITION_FIXTURE_PORT_ID);

    // Prove discovery and installed-state refresh do not depend on the artifact server.
    await fixture.close();
    fixture = null;
    const measurementOutput = await phase("qualification-measurement", INSTALL_FIXTURE_PORT_ID);
    const measurementLine = measurementOutput
      .split(/\r?\n/u)
      .find((line: string) => line.startsWith("REAL_MEASUREMENT "));
    assert.ok(measurementLine, "compiled client must emit the real-CLI measurement record");
    const measurement: unknown = JSON.parse(measurementLine.slice("REAL_MEASUREMENT ".length));
    await phase("qualification-remove", INSTALL_REFRESH_FIXTURE_PORT_ID);

    const report = {
      schema_version: 1,
      assertions: {
        compiled_client_used_real_cli: true,
        stable_identity_across_install_and_updates: true,
        progress_and_durable_activity_observed: true,
        busy_library_read_failed_closed: true,
        busy_port_and_cancellation_fail_closed: true,
        checksum_and_missing_artifact_preserved_active_version: true,
        recovery_updates_succeeded: true,
        two_distinct_adapter_shapes_managed_through_public_client: true,
        revoked_selected_definition_failed_closed: true,
        reviewed_managed_removal_preserved_saves: true,
      },
      fixture_ports: [INSTALL_FIXTURE_PORT_ID, INSTALL_REFRESH_FIXTURE_PORT_ID],
      definition_fixture_port: DEFINITION_FIXTURE_PORT_ID,
      consumer_measurement: measurement,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    let cleanupFailed = false;
    if (fixture) {
      try {
        await fixture.close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (primaryFailure) {
      process.stderr.write(`Retained failed Playnite lifecycle fixture: ${workspace}\n`);
    } else {
      try {
        await rm(workspace, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      if (primaryFailure)
        process.stderr.write("Fixture cleanup also failed after the primary error.\n");
      // The primary failure is rethrown above; only a successful journey reaches this branch.
      // oxlint-disable-next-line no-unsafe-finally
      else throw new Error("The isolated lifecycle fixture could not be completely removed.");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--cargo-phase") {
    if (!process.env.PORTCOVE_HEAVY_RUST_LOCK_TOKEN || process.argv.length > 5)
      throw new Error("Cargo phases require the existing Heavy Rust guard");
    await executeCargoPhase(process.argv[3], process.argv[4]);
  } else {
    if (process.argv.length !== 2) throw new Error("Unexpected lifecycle arguments");
    await main();
  }
}
