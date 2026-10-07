import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as scheduleRealTime } from "node:timers";
import { setTimeout as waitRealTime } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { test, vi } from "vitest";
import {
  createInstallFixture,
  INSTALL_FIXTURE_PORT_ID,
  INSTALL_REFRESH_FIXTURE_PORT_ID,
} from "./desktop-install-fixture.mjs";
import { installScenarios } from "./desktop-install-test.mjs";
import {
  assertCompletionCoreParity,
  retainCompletionReport,
  selectedSetupCompletionScenario,
} from "./desktop-selected-setup-completion-test.mjs";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
import { run as runLifecycleCommand } from "../../../integrations/playnite/lifecycle-check.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

for (const mismatch of [null, "updated_at", "sha256", "missing", "empty", "extra"]) {
  test(`completion parity uses current full source records: ${mismatch ?? "matching"}`, async () => {
    const initial = [{ id: "owned-source", sha256: "a".repeat(64), updated_at: 1605 }];
    const completed =
      mismatch === "missing"
        ? undefined
        : mismatch === "empty"
          ? []
          : [{ ...initial[0], updated_at: 1613 }];
    if (mismatch === "extra") completed.push({ ...completed[0], id: "unexpected-source" });
    const cliSources = structuredClone(completed);
    if (mismatch === "updated_at") cliSources[0].updated_at = 1605;
    if (mismatch === "sha256") cliSources[0].sha256 = "b".repeat(64);
    const observations = { sources: initial };
    const prepared = { readiness: "ready" };
    const reads = [];
    const comparison = assertCompletionCoreParity({
      read: async (command) => {
        reads.push(command);
        return completed;
      },
      core: (args) => {
        if (args[0] === "status") {
          assert.deepEqual(args, ["status", "owned-port"]);
          return prepared;
        }
        assert.deepEqual(args, ["source", "list"]);
        return cliSources;
      },
      portId: "owned-port",
      prepared,
      observations,
    });
    if (mismatch) await assert.rejects(comparison, { code: "ERR_ASSERTION" });
    else await comparison;
    assert.deepEqual(reads, ["get_sources"]);
    assert.deepEqual(observations.completed_sources, completed);
    assert.deepEqual(observations.sources, initial);
    assert.equal(observations.sources[0].updated_at, 1605);
  });
}

test("completion fixture pins the owned executable, valid synthetic source and isolated setup contract", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "portcove-completion-contract-"));
  const tool = path.join(output, "probe.bin");
  const executable = Buffer.from("owned fixture contract bytes; not executed");
  await writeFile(tool, executable);
  const fixture = await createInstallFixture({
    root,
    output,
    completionJourney: true,
    preparationTool: tool,
    revision: "a".repeat(40),
    holdFirstDownload: true,
  });
  try {
    const archive = gunzipSync(fixture.artifact);
    const size = Number.parseInt(
      archive.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(),
      8,
    );
    assert.deepEqual(archive.subarray(512, 512 + size), executable);
    assert.ok(fixture.artifact.length > 1024 * 1024);
    assert.deepEqual(fixture.port.setup_arguments, [
      "--owned-preparation",
      "--owned-fixture-mode",
      "success",
    ]);
    assert.equal(fixture.port.runtime_source_materialization, "n64-big-endian");
    assert.equal(fixture.port.runtime_source_filename, "source.z64");
    assert.ok(
      fixture.port.setup_output_paths.some((prefix) =>
        fixture.port.setup_marker.startsWith(`${prefix}/`),
      ),
    );
    assert.deepEqual(
      fixture.sourceJourney.game.subarray(0, 4),
      Buffer.from([0x80, 0x37, 0x12, 0x40]),
    );
    assert.equal(fixture.sourceJourney.game.length % 4, 0);
    assert.notDeepEqual(fixture.sourceJourney.game, fixture.sourceJourney.replacement);
    assert.deepEqual(
      await readFile(fixture.sourceJourney.gameBefore),
      await readFile(fixture.sourceJourney.gamePath),
    );
    const catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
    const identity = catalog.source_catalog.identities.find(
      (item) => item.id === fixture.port.source_profile,
    );
    assert.deepEqual(identity.variants[0].representations[0].extensions, ["z64"]);
    assert.equal(
      identity.variants[0].representations[0].identities[0].sha256,
      createHash("sha256").update(fixture.sourceJourney.game).digest("hex"),
    );
    assert.match(identity.evidence_gap, /No upstream|no upstream/i);
    await assert.rejects(
      fixture.publishRelease(fixture.port.id, {}),
      /cannot publish inert upgrades/,
    );
  } finally {
    await fixture.close();
    await rm(output, { recursive: true, force: true });
  }
});

test("completion fixture refuses missing tool inputs and mixed discovery selection before serving", async () => {
  await assert.rejects(
    createInstallFixture({ root, output: root, completionJourney: true }),
    /absolute owned preparation tool/,
  );
  await assert.rejects(
    createInstallFixture({
      root,
      output: root,
      completionJourney: true,
      preparationTool: "relative",
    }),
    /absolute owned preparation tool/,
  );
  await assert.rejects(
    createInstallFixture({ root, output: root, sourceJourney: true, completionJourney: true }),
    /separate isolated selections/,
  );
  const registered = [];
  await selectedSetupCompletionScenario({ scenario: async (id) => registered.push(id) });
  assert.deepEqual(registered, ["native-selected-setup-completion"]);
});

test.runIf(process.platform === "win32")(
  "Windows owned probe explicit mode works in empty isolated cwd and preserves the legacy mode route",
  async () => {
    const output = await mkdtemp(path.join(tmpdir(), "portcove-probe-mode-"));
    try {
      const tool = path.join(output, process.platform === "win32" ? "probe.exe" : "probe");
      const compiled = spawnCommand(
        "rustc",
        [
          "--crate-name",
          "portcove_probe_mode_contract",
          path.join(root, "crates/portcove-core/src/testdata/host_tool_probe.rs.txt"),
          "-o",
          tool,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 30_000 },
      );
      assert.equal(compiled.error, undefined);
      assert.equal(compiled.status, 0, compiled.stderr);
      for (const [name, args, legacy, succeeds, marker] of [
        ["explicit", ["--owned-fixture-mode", "success"], null, true, true],
        ["default", [], null, true, false],
        ["legacy", [], "success", true, true],
        ["missing-marker", ["--owned-fixture-mode", "missing-marker"], null, true, false],
        ["failure", ["--owned-fixture-mode", "failure"], null, false, true],
        ["missing-mode", ["--owned-fixture-mode"], null, false, false],
        ["unsupported", ["--owned-fixture-mode", "invented"], null, false, false],
        [
          "duplicate",
          ["--owned-fixture-mode", "success", "--owned-fixture-mode", "success"],
          null,
          false,
          false,
        ],
      ]) {
        const cwd = path.join(output, name);
        await mkdir(cwd);
        if (legacy) await writeFile(path.join(cwd, "owned-setup-mode"), legacy);
        const result = spawnCommand(tool, ["--owned-preparation", ...args], {
          cwd,
          env: { ...process.env, SHIP_HOME: cwd },
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
        });
        assert.equal(result.error, undefined, name);
        assert.equal(result.status === 0, succeeds, `${name}: ${result.stderr}`);
        if (marker)
          assert.equal(
            await readFile(path.join(cwd, "data/out/jak1/iso/0COMMON.TXT"), "utf8"),
            "owned validated output",
          );
        else
          await assert.rejects(readFile(path.join(cwd, "data/out/jak1/iso/0COMMON.TXT")), {
            code: "ENOENT",
          });
      }
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
);

test("completion report retains the original error across artifact and fallback-log failures", async () => {
  const original = new Error("original journey failure");
  const artifactFailure = new Error("report storage failure");
  for (const brokenLog of [false, true]) {
    const report = { failure: { message: original.message } },
      artifacts = [],
      logged = [];
    await assert.rejects(
      retainCompletionReport({
        file: "owned-report.json",
        report,
        artifacts,
        failure: original,
        write: async () => {
          throw artifactFailure;
        },
        log: (value) => {
          logged.push(JSON.parse(value));
          if (brokenLog) throw new Error("fallback unavailable");
        },
      }),
      (error) => error === original,
    );
    assert.deepEqual(artifacts, []);
    assert.equal(logged[0].report.failure.message, original.message);
    assert.equal(report.artifact_write_failure, String(artifactFailure));
    assert.equal(Boolean(report.fallback_log_failure), brokenLog);
  }
  await assert.rejects(
    retainCompletionReport({
      file: "owned-report.json",
      report: {},
      artifacts: [],
      write: async () => {
        throw artifactFailure;
      },
      log: () => {},
    }),
    (error) => error === artifactFailure,
  );
  const artifacts = [],
    report = { failure: original.message };
  let saved;
  await assert.rejects(
    retainCompletionReport({
      file: "owned-report.json",
      report,
      artifacts,
      failure: original,
      write: async (file, bytes, options) => {
        assert.equal(file, "owned-report.json");
        assert.equal(options.flag, "wx");
        saved = JSON.parse(bytes);
      },
    }),
    (error) => error === original,
  );
  assert.deepEqual(saved, report);
  assert.deepEqual(artifacts, ["owned-report.json"]);
});

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const ready = await predicate();
    if (Date.now() >= deadline) throw new Error(message);
    if (ready) return;
    await waitRealTime(20);
  }
}

async function readOwnedProcesses(marker) {
  return JSON.parse(await readFile(marker, "utf8"));
}

async function waitForProcessExit(pid) {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }, "owned descendant process survived lifecycle timeout cleanup");
}

function killIfAlive(pid) {
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function captureCleanupFailure(failures, action) {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}

async function readOwnedProcessesIfPresent(marker) {
  try {
    return await readOwnedProcesses(marker);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function throwFixtureFailures(failures, message = "Timeout fixture cleanup failed") {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

async function cleanUpTimeoutFixture(output, marker, owned) {
  const failures = [];
  await captureCleanupFailure(failures, async () => {
    owned ??= await readOwnedProcessesIfPresent(marker);
  });
  for (const pid of [owned?.descendant, owned?.parent]) {
    await captureCleanupFailure(failures, () => {
      killIfAlive(pid);
    });
  }
  await captureCleanupFailure(failures, () => rm(output, { recursive: true, force: true }));
  throwFixtureFailures(failures);
}

test("fixture failures preserve the original assertion and independent cleanup evidence", () => {
  const primary = new Error("readiness failed");
  const cleanup = new Error("owned process cleanup failed");
  assert.throws(
    () => throwFixtureFailures([primary]),
    (error) => error === primary,
  );
  assert.throws(
    () => throwFixtureFailures([primary, cleanup], "Assertion and cleanup failed"),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.equal(error.message, "Assertion and cleanup failed");
      return true;
    },
  );
});

test("install fixture is isolated, pinned, interruptible, and retryable", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "portcove-install-fixture-"));
  const fixture = await createInstallFixture({ root, output });
  try {
    const catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
    const port = catalog.ports.find((item) => item.id === INSTALL_FIXTURE_PORT_ID);
    const refreshPort = catalog.ports.find((item) => item.id === INSTALL_REFRESH_FIXTURE_PORT_ID);
    assert.ok(port);
    assert.ok(refreshPort);
    assert.notEqual(port.id, refreshPort.id);
    assert.notEqual(port.name, refreshPort.name);
    assert.equal(port.adapter, "n64-recomp-portable");
    assert.equal(refreshPort.adapter, "libultraship-portable");
    assert.notEqual(port.adapter, refreshPort.adapter);
    assert.equal(port.release.provider, "direct-manifest");
    assert.equal(port.release.direct[port.platforms[0]].url, fixture.url);
    assert.equal(refreshPort.release.direct[refreshPort.platforms[0]].url, fixture.url);
    assert.equal(
      refreshPort.release.direct[refreshPort.platforms[0]].sha256,
      port.release.direct[port.platforms[0]].sha256,
    );
    assert.equal(port.source_profile, undefined);
    assert.equal(refreshPort.source_profile, undefined);

    const controller = new AbortController();
    const first = await fetch(fixture.url, { signal: controller.signal });
    const reader = first.body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(
      () => fixture.requests[0]?.connection_closed,
      "cancelled fixture connection did not close",
    );
    assert.equal(fixture.requests[0].completed, false);
    assert.ok(fixture.requests[0].bytes_sent < fixture.artifact.length);

    const retry = Buffer.from(await (await fetch(fixture.url)).arrayBuffer());
    assert.equal(
      createHash("sha256").update(retry).digest("hex"),
      port.release.direct[port.platforms[0]].sha256,
    );
    assert.equal(fixture.requests[1].completed, true);
    assert.equal(fixture.requests[1].bytes_sent, fixture.artifact.length);

    const published = await fixture.publishRelease(INSTALL_FIXTURE_PORT_ID, {
      version: "2.0.0-fixture",
      publishedAt: "2026-09-16T02:00:00Z",
      seed: 0x24300002,
    });
    const updatedCatalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
    const updatedPort = updatedCatalog.ports.find((item) => item.id === INSTALL_FIXTURE_PORT_ID);
    const updatedRelease = updatedPort.release.direct[updatedPort.platforms[0]];
    assert.equal(updatedRelease.version, published.version);
    assert.equal(updatedRelease.url, published.url);
    assert.equal(updatedRelease.sha256, published.sha256);
    assert.notEqual(updatedRelease.sha256, port.release.direct[port.platforms[0]].sha256);
    assert.equal(
      createHash("sha256")
        .update(await readFile(fixture.artifactPath))
        .digest("hex"),
      published.sha256,
    );
    const upgraded = Buffer.from(await (await fetch(published.url)).arrayBuffer());
    assert.equal(createHash("sha256").update(upgraded).digest("hex"), published.sha256);
    assert.equal(fixture.requests[2].completed, true);
    const original = Buffer.from(await (await fetch(fixture.url)).arrayBuffer());
    assert.equal(
      createHash("sha256").update(original).digest("hex"),
      refreshPort.release.direct[refreshPort.platforms[0]].sha256,
    );
    assert.equal(fixture.requests[3].completed, true);
  } finally {
    await fixture.close();
  }
});

test("held install download cannot outrun delayed conflict and cancellation checks", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "portcove-held-install-fixture-"));
  const fixture = await createInstallFixture({ root, output, holdFirstDownload: true });
  const controller = new AbortController();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const first = await fetch(fixture.url, { signal: controller.signal });
    const reader = first.body.getReader();
    await reader.read();
    assert.equal(fixture.requests[0].bytes_sent, 1024 * 1024);
    // Advance beyond the entire old 75ms/chunk download. This must remain
    // incomplete regardless of the time taken by consumer CLI readbacks.
    await vi.advanceTimersByTimeAsync(6_000);
    assert.equal(fixture.requests[0].completed, false);
    assert.equal(fixture.requests[0].bytes_sent, 1024 * 1024);
    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(
      () => fixture.requests[0].connection_closed,
      "held download did not close after cancellation",
    );
    const retry = Buffer.from(await (await fetch(fixture.url)).arrayBuffer());
    assert.deepEqual(retry, fixture.artifact);
    assert.equal(fixture.requests[1].completed, true);
  } finally {
    controller.abort();
    vi.useRealTimers();
    await fixture.close();
    await rm(output, { recursive: true, force: true });
  }
});

test("unselected install scenarios do not require an initialized fixture", async () => {
  const registered = [];
  await installScenarios({
    scenario: async (id) => registered.push(id),
  });
  assert.deepEqual(registered, [
    "install-progress-cancellation",
    "install-commit-refresh-recovery",
    "native-staged-update-composition",
  ]);
});

test.runIf(process.platform === "win32")(
  "lifecycle timeout terminates a ready descendant process tree within a second bound",
  async () => {
    const output = await mkdtemp(path.join(tmpdir(), "portcove-lifecycle-timeout-"));
    const marker = path.join(output, "descendant.pid");
    const descendant = [
      'const { writeFileSync, renameSync } = require("node:fs");',
      'const temporary = process.argv[1] + ".tmp";',
      "writeFileSync(temporary, JSON.stringify({ parent: process.ppid, descendant: process.pid }));",
      "renameSync(temporary, process.argv[1]);",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const child = [
      'const { spawn } = require("node:child_process");',
      // Deliberately exceed the execution timeout: startup is a distinct prerequisite.
      `setTimeout(() => spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { stdio: "ignore" }), 350);`,
      "setInterval(() => {}, 1000);",
    ].join(" ");

    let owned;
    let primaryFailure;
    let cleanupFailure;
    let timer;
    let expire;
    let timedOut;
    let observationFinished = false;
    let executionExpired = false;
    try {
      // Hold only the first execution deadline until readiness. The secondary
      // close bound and all child processes keep their real timers.
      timer = vi.spyOn(globalThis, "setTimeout").mockImplementationOnce((callback, delay) => {
        assert.equal(delay, 250);
        expire = () => {
          if (executionExpired || observationFinished) return;
          executionExpired = true;
          callback();
        };
        return scheduleRealTime(() => {}, 5_000);
      });
      timedOut = assert
        .rejects(
          runLifecycleCommand(process.execPath, ["-e", child, marker], {
            echo: false,
            timeout: 250,
          }),
          /timed out after 250ms/,
        )
        .then(
          () => {
            observationFinished = true;
          },
          (error) => {
            observationFinished = true;
            return error;
          },
        );
      timer.mockRestore();
      await waitFor(async () => {
        owned = await readOwnedProcessesIfPresent(marker);
        return Boolean(owned);
      }, "owned descendant did not become ready within the existing startup bound");
      assert.ok(Number.isInteger(owned.parent) && Number.isInteger(owned.descendant));
      process.kill(owned.parent, 0);
      process.kill(owned.descendant, 0);
      assert.equal(typeof expire, "function", "execution timeout must remain armed at 250ms");
      const startedAt = Date.now();
      expire();
      const timeoutFailure = await timedOut;
      if (timeoutFailure) throw timeoutFailure;
      assert.ok(Date.now() - startedAt < 8_000, "timeout path exceeded its secondary bound");
      await waitForProcessExit(owned.descendant);
      await waitForProcessExit(owned.parent);
    } catch (error) {
      primaryFailure = error;
    } finally {
      timer?.mockRestore();
      try {
        expire?.();
        await cleanUpTimeoutFixture(output, marker, owned);
        const timeoutFailure = await timedOut;
        if (timeoutFailure !== primaryFailure) assert.ifError(timeoutFailure);
      } catch (error) {
        cleanupFailure = error;
      }
    }
    throwFixtureFailures(
      [primaryFailure, cleanupFailure].filter(Boolean),
      "Timeout assertion and its independent cleanup both failed",
    );
  },
  30_000,
);
