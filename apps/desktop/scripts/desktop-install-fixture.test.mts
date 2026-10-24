import { isRecord, errorCode } from "../../../scripts/runtime-values.mts";
import type {
  CompletionParityObservations,
  CompletionReportDiagnostics,
} from "./desktop-selected-setup-completion-test.mts";
import assert from "node:assert/strict";
import { assertOwnedSelectedSetupPath } from "./desktop-source-dialog-test.mts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as scheduleRealTime } from "node:timers";
import { setTimeout as waitRealTime } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { test, vi } from "vite-plus/test";
import { Session, WebDriver } from "selenium-webdriver";
import {
  createInstallFixture,
  INSTALL_FIXTURE_PORT_ID,
  INSTALL_REFRESH_FIXTURE_PORT_ID,
} from "./desktop-install-fixture.mts";
import { installScenarios, selectInstallTheme } from "./desktop-install-test.mts";
import { runInNewContext } from "node:vm";
import {
  assertCompletionCoreParity,
  retainCompletionReport,
  selectedSetupCompletionScenario,
} from "./desktop-selected-setup-completion-test.mts";
import { run as runLifecycleCommand } from "../../../integrations/playnite/lifecycle-check.mts";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("owned fixture path checks accept Core's extended spelling and reject a different path", () => {
  const expected = path.join(root, "owned-source-fixture");
  if (process.platform === "win32") assertOwnedSelectedSetupPath(`\\\\?\\${expected}`, expected);
  assertOwnedSelectedSetupPath(expected, expected);
  assert.throws(() => assertOwnedSelectedSetupPath(`\\\\?\\${expected}-other`, expected));
  if (process.platform !== "win32")
    assert.throws(() => assertOwnedSelectedSetupPath(`${expected.toUpperCase()}`, expected));
});

for (const mismatch of [null, "updated_at", "sha256", "missing", "empty", "extra"]) {
  test(`completion parity uses current full source records: ${mismatch ?? "matching"}`, async () => {
    const initial = [{ id: "owned-source", sha256: "a".repeat(64), updated_at: 1605 }];
    const completed =
      mismatch === "missing"
        ? undefined
        : mismatch === "empty"
          ? []
          : [{ ...firstItem(initial), updated_at: 1613 }];
    if (mismatch === "extra")
      present(completed).push({ ...firstItem(present(completed)), id: "unexpected-source" });
    const cliSources = structuredClone(completed);
    if (mismatch === "updated_at") firstItem(present(cliSources)).updated_at = 1605;
    if (mismatch === "sha256") firstItem(present(cliSources)).sha256 = "b".repeat(64);
    const observations: CompletionParityObservations = { sources: initial };
    const prepared = { readiness: "ready" };
    const reads: string[] = [];
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
    assert.equal(firstItem(initial).updated_at, 1605);
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
    assert.ok(fixture.sourceJourney);
    assert.ok(fixture.sourceJourney.reviewPort);
    const setup = object(fixture.port);
    const archive = gunzipSync(fixture.artifact);
    const size = Number.parseInt(
      archive.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(),
      8,
    );
    assert.deepEqual(archive.subarray(512, 512 + size), executable);
    assert.ok(fixture.artifact.length > 1024 * 1024);
    assert.deepEqual(setup.setup_arguments, [
      "--owned-preparation",
      "--owned-fixture-mode",
      "success",
    ]);
    assert.equal(setup.runtime_source_materialization, "n64-big-endian");
    assert.equal(setup.runtime_source_filename, "source.z64");
    assert.ok(
      strings(setup.setup_output_paths).some((prefix) =>
        text(setup.setup_marker).startsWith(`${prefix}/`),
      ),
    );
    assert.deepEqual(
      fixture.sourceJourney.game.subarray(0, 4),
      Buffer.from([0x80, 0x37, 0x12, 0x40]),
    );
    assert.equal(fixture.sourceJourney.game.length % 4, 0);
    assert.equal(
      path.dirname(fixture.sourceJourney.gamePath),
      path.join(fixture.sourceJourney.directory, "next-batch"),
    );
    assert.equal(path.dirname(fixture.sourceJourney.biosPath), fixture.sourceJourney.directory);
    assert.notDeepEqual(fixture.sourceJourney.game, fixture.sourceJourney.replacement);
    assert.deepEqual(
      await readFile(fixture.sourceJourney.gameBefore),
      await readFile(fixture.sourceJourney.gamePath),
    );
    const catalog = await readFixtureCatalog(fixture.catalogPath);
    const alternative = catalog.ports.find(
      (item) => item.id === fixture.sourceJourney?.reviewPort?.id,
    );
    assert.ok(alternative, "Independent review choice must have its own catalog identity");
    assert.equal(alternative.source_profile, fixture.port.source_profile);
    assert.equal(
      new Set(catalog.source_catalog.contracts.map((item) => item.id)).size,
      catalog.source_catalog.contracts.length,
      "Fixture source contracts must have unique identities",
    );
    for (const item of [fixture.port, alternative]) {
      const contracts = catalog.source_catalog.contracts.filter(
        (contract) =>
          contract.port_id === item.id &&
          contract.role === "game" &&
          contract.profile_id === item.source_profile,
      );
      assert.equal(
        contracts.length,
        1,
        "Every declared game source needs exactly one schema-2 contract",
      );
    }
    const identity = catalog.source_catalog.identities.find(
      (item) => item.id === fixture.port.source_profile,
    );
    assert.ok(identity);
    const variant = object(firstItem(array(identity.variants)));
    const representation = object(firstItem(array(variant.representations)));
    assert.deepEqual(representation.extensions, ["z64"]);
    assert.equal(
      object(firstItem(array(representation.identities))).sha256,
      createHash("sha256").update(fixture.sourceJourney.game).digest("hex"),
    );
    assert.match(text(identity.evidence_gap), /No upstream|no upstream/i);
    await assert.rejects(
      // @ts-expect-error Incomplete upgrade inputs must still refuse completion publication first.
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
  const registered: string[] = [];
  // @ts-expect-error Deliberately omit execution dependencies: an unselected scenario must not consume them.
  await selectedSetupCompletionScenario({
    scenario: async (id: string) => {
      registered.push(id);
    },
  });
  assert.deepEqual(registered, ["native-selected-setup-completion"]);
});

test("completion report retains the original error across artifact and fallback-log failures", async () => {
  const original = new Error("original journey failure");
  const artifactFailure = new Error("report storage failure");
  for (const brokenLog of [false, true]) {
    const report: { failure: { message: string } } & CompletionReportDiagnostics = {
      failure: { message: original.message },
    };
    const artifacts: string[] = [],
      logged: unknown[] = [];
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
    assert.equal(
      object(object(object(firstItem(logged)).report).failure).message,
      original.message,
    );
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
  const artifacts: string[] = [];
  const report = { failure: original.message };
  let saved: unknown;
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

test("completion report preserves explicit primitive failures including undefined", async () => {
  for (const failure of [false, 0, "", null, undefined]) {
    for (const brokenStorage of [false, true]) {
      await assert.rejects(
        retainCompletionReport({
          file: "owned-report.json",
          report: {},
          artifacts: [],
          failure,
          write: () =>
            brokenStorage
              ? Promise.reject(new Error("secondary storage failure"))
              : Promise.resolve(),
          log: () => {},
        }),
        (error) => Object.is(error, failure),
      );
    }
    await assert.rejects(
      retainCompletionReport({
        file: "owned-report.json",
        report: {},
        artifacts: [],
        write: () => Promise.reject(failure),
        log: () => {},
      }),
      (error) => Object.is(error, failure),
    );
  }
});

test("completion scenario retains primitive bootstrap IPC failures after checking original inputs", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "portcove-completion-rejection-"));
  const tool = path.join(output, "inert-tool");
  await writeFile(tool, "inert fixture bytes; never executed");
  const fixture = await createInstallFixture({
    root,
    output,
    completionJourney: true,
    preparationTool: tool,
    revision: "a".repeat(40),
  });
  const browser = new WebDriver(new Session("completion-refusal-control", {}), {
    execute: async () => assert.fail("First IPC refusal must precede browser commands"),
  });
  try {
    for (const [index, failure] of [false, 0, "", null, undefined].entries()) {
      const reportDirectory = path.join(output, `failure-${index}`);
      await mkdir(reportDirectory);
      const artifacts: string[] = [];
      let failedCommand: string | undefined;
      await assert.rejects(
        selectedSetupCompletionScenario({
          browser,
          fixture,
          output: reportDirectory,
          artifacts,
          library: path.join(output, "library"),
          cli: process.execPath,
          invoke: (name) => {
            failedCommand = name;
            return Promise.reject(failure);
          },
          scenario: async (_name: string, execute: () => Promise<void>) => execute(),
          restartApplication: async () => assert.fail("Failed IPC must stop restart"),
          chooseGameFileFolder: async () => assert.fail("Failed IPC must stop picker"),
        }),
        (error) => Object.is(error, failure),
      );
      assert.equal(failedCommand, "get_bootstrap_status");
      const file = path.join(reportDirectory, "selected-setup-completion.json");
      const report: unknown = JSON.parse(await readFile(file, "utf8"));
      assert.equal(object(report).original_inputs_preserved, true);
      assert.equal(object(object(report).failure).message, String(failure));
      assert.deepEqual(artifacts, [file]);
    }
  } finally {
    await fixture.close();
    await rm(output, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => unknown, message: string) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const ready = await predicate();
    if (Date.now() >= deadline) throw new Error(message);
    if (ready) return;
    await waitRealTime(20);
  }
}

interface OwnedProcesses {
  parent: number;
  descendant: number;
}
async function readOwnedProcesses(marker: string): Promise<OwnedProcesses> {
  const raw = object(JSON.parse(await readFile(marker, "utf8")));
  assert.ok(typeof raw.parent === "number" && Number.isInteger(raw.parent) && raw.parent > 0);
  assert.ok(
    typeof raw.descendant === "number" && Number.isInteger(raw.descendant) && raw.descendant > 0,
  );
  return { parent: raw.parent, descendant: raw.descendant };
}

async function waitForProcessExit(pid: number) {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (errorCode(error) === "ESRCH") return true;
      throw error;
    }
  }, "owned descendant process survived lifecycle timeout cleanup");
}

function killIfAlive(pid: number | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

async function captureCleanupFailure(failures: unknown[], action: () => unknown) {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}

async function readOwnedProcessesIfPresent(marker: string) {
  try {
    return await readOwnedProcesses(marker);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function throwFixtureFailures(failures: unknown[], message = "Timeout fixture cleanup failed") {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

async function cleanUpTimeoutFixture(
  output: string,
  marker: string,
  owned: OwnedProcesses | undefined,
) {
  const failures: unknown[] = [];
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
    const catalog = await readFixtureCatalog(fixture.catalogPath);
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
    assert.equal(releaseFor(port).url, fixture.url);
    assert.equal(releaseFor(refreshPort).url, fixture.url);
    assert.equal(releaseFor(refreshPort).sha256, releaseFor(port).sha256);
    assert.equal(port.source_profile, undefined);
    assert.equal(refreshPort.source_profile, undefined);

    const controller = new AbortController();
    const first = await fetch(fixture.url, { signal: controller.signal });
    const reader = present(first.body).getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(
      () => fixture.requests[0]?.connection_closed,
      "cancelled fixture connection did not close",
    );
    assert.equal(firstItem(fixture.requests).completed, false);
    assert.ok(firstItem(fixture.requests).bytes_sent < fixture.artifact.length);

    const retry = Buffer.from(await (await fetch(fixture.url)).arrayBuffer());
    assert.equal(createHash("sha256").update(retry).digest("hex"), releaseFor(port).sha256);
    assert.equal(present(fixture.requests[1]).completed, true);
    assert.equal(present(fixture.requests[1]).bytes_sent, fixture.artifact.length);

    const published = await fixture.publishRelease(INSTALL_FIXTURE_PORT_ID, {
      version: "2.0.0-fixture",
      publishedAt: "2026-09-16T02:00:00Z",
      seed: 0x24300002,
    });
    const updatedCatalog = await readFixtureCatalog(fixture.catalogPath);
    const updatedPort = updatedCatalog.ports.find((item) => item.id === INSTALL_FIXTURE_PORT_ID);
    const updatedRelease = releaseFor(present(updatedPort));
    assert.equal(updatedRelease.version, published.version);
    assert.equal(updatedRelease.url, published.url);
    assert.equal(updatedRelease.sha256, published.sha256);
    assert.notEqual(updatedRelease.sha256, releaseFor(port).sha256);
    assert.equal(
      createHash("sha256")
        .update(await readFile(fixture.artifactPath))
        .digest("hex"),
      published.sha256,
    );
    const upgraded = Buffer.from(await (await fetch(published.url)).arrayBuffer());
    assert.equal(createHash("sha256").update(upgraded).digest("hex"), published.sha256);
    assert.equal(present(fixture.requests[2]).completed, true);
    const original = Buffer.from(await (await fetch(fixture.url)).arrayBuffer());
    assert.equal(
      createHash("sha256").update(original).digest("hex"),
      releaseFor(refreshPort).sha256,
    );
    assert.equal(present(fixture.requests[3]).completed, true);
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
    const reader = present(first.body).getReader();
    await reader.read();
    assert.equal(firstItem(fixture.requests).bytes_sent, 1024 * 1024);
    // Advance beyond the entire old 75ms/chunk download. This must remain
    // incomplete regardless of the time taken by consumer CLI readbacks.
    await vi.advanceTimersByTimeAsync(6_000);
    assert.equal(firstItem(fixture.requests).completed, false);
    assert.equal(firstItem(fixture.requests).bytes_sent, 1024 * 1024);
    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(
      () => firstItem(fixture.requests).connection_closed,
      "held download did not close after cancellation",
    );
    const retry = Buffer.from(await (await fetch(fixture.url)).arrayBuffer());
    assert.deepEqual(retry, fixture.artifact);
    assert.equal(present(fixture.requests[1]).completed, true);
  } finally {
    controller.abort();
    vi.useRealTimers();
    await fixture.close();
    await rm(output, { recursive: true, force: true });
  }
});

for (const theme of ["dark", "light"] as const)
  test(`staged layouts select the current scoped ${theme} radio through WebDriver`, async () => {
    const selectors: string[] = [];
    let clicks = 0;
    const document = { documentElement: { dataset: { theme: "system" } } };
    const browser = new WebDriver(new Session(`staged-theme-${theme}`, {}), {
      execute: async (command) => {
        const parameters: unknown = command.getParameters();
        assert.ok(isRecord(parameters));
        switch (command.getName()) {
          case "findElement": {
            assert.equal(typeof parameters.value, "string");
            const selector = String(parameters.value);
            const expected = [
              '//nav//button[contains(., "Settings")]',
              'nav[aria-label="Settings categories"] button[aria-controls="settings-appearance"]',
              `//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio" and normalize-space(.)="${theme === "dark" ? "Dark" : "Light"}"]`,
            ];
            assert.equal(selector, expected[selectors.length]);
            selectors.push(selector);
            return { ELEMENT: `theme-control-${selectors.length}` };
          }
          case "clickElement":
            clicks++;
            if (clicks === 3) document.documentElement.dataset.theme = theme;
            return;
          case "executeScript": {
            assert.equal(typeof parameters.script, "string");
            const result: unknown = runInNewContext(
              `(function(){${String(parameters.script)}})()`,
              {
                document,
              },
            );
            return result;
          }
          default:
            assert.fail(`Unexpected staged theme command: ${command.getName()}`);
        }
      },
    });
    await selectInstallTheme(browser, theme);
    assert.equal(selectors.length, 3);
    assert.equal(clicks, 3);
    assert.equal(document.documentElement.dataset.theme, theme);
  });

test("unselected install scenarios do not require an initialized fixture", async () => {
  const registered: string[] = [];
  // @ts-expect-error Deliberately omit execution dependencies when all registered scenarios are skipped.
  await installScenarios({
    scenario: async (id: string) => {
      registered.push(id);
    },
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

    let owned: OwnedProcesses | undefined;
    let primaryFailure;
    let cleanupFailure;
    let timer;
    let expire: (() => void) | undefined;
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
          (error: unknown) => {
            observationFinished = true;
            return error;
          },
        );
      timer.mockRestore();
      await waitFor(async () => {
        owned = await readOwnedProcessesIfPresent(marker);
        return Boolean(owned);
      }, "owned descendant did not become ready within the existing startup bound");
      assert.ok(owned);
      assert.ok(Number.isInteger(owned.parent) && Number.isInteger(owned.descendant));
      process.kill(owned.parent, 0);
      process.kill(owned.descendant, 0);
      assert.ok(expire);
      assert.equal(typeof expire, "function", "execution timeout must remain armed at 250ms");
      const startedAt = Date.now();
      expire();
      const timeoutFailure = await timedOut;
      if (timeoutFailure) throwFixtureFailures([timeoutFailure]);
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

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
function strings(value: unknown): string[] {
  return array(value).map(text);
}
function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function firstItem<T>(values: readonly T[]): T {
  return present(values[0]);
}
async function readFixtureCatalog(file: string) {
  const raw = object(JSON.parse(await readFile(file, "utf8"))),
    source = object(raw.source_catalog);
  const ports = array(raw.ports).map((entry) => {
    const port = object(entry),
      release = object(port.release);
    const direct = Object.fromEntries(
      Object.entries(release.direct === undefined ? {} : object(release.direct)).map(
        ([platform, value]) => {
          const item = object(value);
          return [
            platform,
            {
              ...item,
              url: text(item.url),
              sha256: text(item.sha256),
              version: text(item.version),
            },
          ];
        },
      ),
    );
    return {
      ...port,
      id: text(port.id),
      name: text(port.name),
      adapter: port.adapter,
      source_profile: port.source_profile,
      platforms: strings(port.platforms),
      release: { ...release, provider: release.provider, direct },
    };
  });
  const contracts = array(source.contracts).map((entry) => {
    const item = object(entry);
    return {
      ...item,
      id: text(item.id),
      port_id: text(item.port_id),
      role: item.role,
      profile_id: item.profile_id,
    };
  });
  const identities = array(source.identities).map((entry) => {
    const item = object(entry);
    return { ...item, id: text(item.id), variants: item.variants, evidence_gap: item.evidence_gap };
  });
  return { ...raw, ports, source_catalog: { ...source, contracts, identities } };
}
function releaseFor(port: Awaited<ReturnType<typeof readFixtureCatalog>>["ports"][number]) {
  return present(port.release.direct[firstItem(port.platforms)]);
}
