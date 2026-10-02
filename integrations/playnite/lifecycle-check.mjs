import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createInstallFixture,
  INSTALL_FIXTURE_PORT_ID,
  INSTALL_REFRESH_FIXTURE_PORT_ID,
} from "../../apps/desktop/scripts/desktop-install-fixture.mjs";

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
const cli = path.join(root, "target", "debug", "portcove.exe");
const DEFINITION_FIXTURE_PORT_ID = "opengoal-jak1";

export function run(command, args, { env = process.env, timeout = 600_000, echo = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let timedOut = false;
    let settled = false;
    let closeTimer;
    let timer;
    const finish = (action, value) => {
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

async function editRelease(catalogPath, portId, changes) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const definition = catalog.ports.find((value) => value.id === portId);
  assert.ok(definition, `${portId} must exist in the qualification catalog`);
  const releases = Object.values(definition.release.direct);
  assert.equal(releases.length, 1, "qualification fixture must expose one platform release");
  Object.assign(releases[0], changes);
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

async function checkReviewedExternal(cli, library, catalogPath, workspace, env) {
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
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const definition = structuredClone(
    catalog.ports.find((value) => value.id === "wave-race-64-recomp"),
  );
  assert.ok(definition, "existing user-prepared adapter must be available to the fixture");
  Object.assign(definition, {
    id: port,
    name: "Owned external consent fixture",
    source_profile: "star-fox-64",
    presentation: null,
  });
  definition.executable_hints = { "windows-x86-64": ["game.exe"] };
  definition.release.user_prepared["windows-x86-64"] = {
    version: "fixture-v1",
    archive_name: "owned.zip",
    archive_size: bytes.length,
    archive_sha256: createHash("sha256").update(bytes).digest("hex"),
    executable: "game.exe",
    immutable_tree_sha256: tree,
    source_argument_extension: "z64",
    mutable_paths: ["player.save"],
  };
  catalog.ports.push(definition);
  const sourceBinding = structuredClone(
    catalog.source_catalog.contracts.find((value) => value.profile_id === "star-fox-64"),
  );
  assert.ok(sourceBinding, "fixture source profile must have an authoritative contract");
  sourceBinding.port_id = port;
  sourceBinding.id = `${port}-game-source`;
  catalog.source_catalog.contracts.push(sourceBinding);
  const publish = () => writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await publish();
  const invoke = (...args) =>
    run(cli, ["--library", library, "--json", "--non-interactive", "external", ...args], {
      env,
      echo: false,
    });
  const read = async (...args) => JSON.parse(await invoke(...args)).data;
  const status = async () =>
    JSON.parse(
      await run(cli, ["--library", library, "--json", "status", port], { env, echo: false }),
    ).data;
  const preview = await read("preview", port, folder);
  await assert.rejects(
    invoke("register", port, folder, "--expected-preview", preview.preview_sha256),
    /confirmation|--yes/u,
  );
  assert.equal(
    (await status()).external_runtime ?? null,
    null,
    "declined noninteractive consent cannot register",
  );
  definition.release.user_prepared["windows-x86-64"].version = "fixture-v2";
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
  definition.release.user_prepared["windows-x86-64"].version = "fixture-v1";
  await publish();
  const registered = await read(
    "register",
    port,
    folder,
    "--expected-preview",
    preview.preview_sha256,
    "--yes",
  );
  assert.equal((await status()).external_runtime.id, registered.id);
  const original = path.join(workspace, "owned original.n64");
  await writeFile(original, "synthetic original source");
  await run(cli, ["--library", library, "--json", "source", "register", "star-fox-64", original], {
    env,
    echo: false,
  });
  const blocked = await status();
  assert.equal(blocked.readiness.source, "current");
  assert.equal(blocked.readiness.required_source_extension, "z64");
  assert.equal(blocked.readiness.launchable, false);
  assert.deepEqual(blocked.readiness.blockers, ["incompatible_source"]);
  assert.equal(
    blocked.port_actions.find((action) => action.action === "launch").availability,
    "waiting",
  );
  assert.match(
    await run(cli, ["--library", library, "status", port], { env, echo: false }),
    /requires uncompressed \.z64 original file/u,
  );
  await run(contract, ["qualification-source-guidance", cli, library, port, original], { env });
  assert.equal(await readFile(original, "utf8"), "synthetic original source");
  const removal = await read("removal-preview", port);
  assert.equal(removal.external_files_will_be_preserved, true);
  assert.equal((await status()).external_runtime.id, registered.id, "removal preview is read-only");
  await assert.rejects(
    invoke("remove", port, "--expected-preview", "0".repeat(64), "--yes"),
    /conflict/u,
  );
  assert.equal(
    (await status()).external_runtime.id,
    registered.id,
    "stale CLI removal preserves the registration",
  );
  await read("remove", port, "--expected-preview", removal.preview_sha256, "--yes");
  const replacement = await read("register", port, folder, "--yes");
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
    (await status()).external_runtime.id,
    replacement.id,
    "replaced registration invalidates old consent",
  );
  await read("remove", port, "--yes");
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
  await run("cargo", [
    "build",
    "--locked",
    "--quiet",
    "-p",
    "portcove-cli",
    "--features",
    "portcove-core/qualification-fixtures",
  ]);

  const workspace = await mkdtemp(path.join(os.tmpdir(), "portcove-playnite-lifecycle-"));
  let fixture;
  let primaryFailure;

  try {
    const output = path.join(workspace, "fixture");
    const library = path.join(workspace, "library");
    await mkdir(output);
    fixture = await createInstallFixture({ root, output, holdFirstDownload: true });
    const env = {
      ...process.env,
      PORTCOVE_PREFERENCES: path.join(workspace, "preferences.json"),
      PORTCOVE_QUALIFICATION_CATALOG: fixture.catalogPath,
    };
    const identity = JSON.parse(
      await run(cli, ["--library", library, "--json", "--non-interactive", "library", "identity"], {
        env,
        echo: false,
      }),
    ).data.id;
    const phase = (mode, port, ...rest) =>
      run(contract, [mode, cli, library, port, identity, ...rest], { env });
    await checkReviewedExternal(cli, library, fixture.catalogPath, workspace, env);
    const setDefinitionState = (action) =>
      run(
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

    await phase("qualification-library-busy", INSTALL_REFRESH_FIXTURE_PORT_ID);
    await phase("qualification-concurrency", INSTALL_REFRESH_FIXTURE_PORT_ID);
    assert.equal(fixture.requests.length, 1, "conflict cannot start a competing artifact download");
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
      .find((line) => line.startsWith("REAL_MEASUREMENT "));
    assert.ok(measurementLine, "compiled client must emit the real-CLI measurement record");
    const measurement = JSON.parse(measurementLine.slice("REAL_MEASUREMENT ".length));
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
      else throw new Error("The isolated lifecycle fixture could not be completely removed.");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
