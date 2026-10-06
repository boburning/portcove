import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { createInstallFixture } from "../apps/desktop/scripts/desktop-install-fixture.mjs";
import { fileIdentity } from "./development-evidence.mjs";
import { toolCachePaths } from "./tool-cache.mjs";
import {
  createExternalRuntimeFixture,
  externalFixtureTreeDigest,
  externalRuntimePickerObservation,
  externalRuntimeReviewScenario,
} from "../apps/desktop/scripts/desktop-external-runtime-test.mjs";
import { nativePreparedRuntimePicker } from "../apps/desktop/scripts/desktop-native-confirmation.mjs";
import {
  verifyNormalPackageEvidence,
  assertOwnedBoundaryRequests,
  normalPackageBoundaryScenario,
} from "../apps/desktop/scripts/desktop-main-webview-boundary.mjs";
import { assertSteamEntryContext } from "../apps/desktop/scripts/desktop-context-contract.mjs";
import { OwnedNativeSession } from "../apps/desktop/scripts/desktop-owned-native-session.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  librarySwitchRecoverySelection,
  prepareLibrarySwitchRecoveryFixture,
} from "../apps/desktop/scripts/desktop-library-switch-recovery-test.mjs";
import {
  bootstrapRecoveryEnvironment,
  bootstrapRecoverySelection,
  prepareBootstrapRecoveryFixture,
  preferencesRecoverySelection,
  preparePreferencesRecoveryFixture,
} from "../apps/desktop/scripts/desktop-bootstrap-recovery-test.mjs";
import {
  catalogReport,
  desktopHarnessDeadlineMs,
  desktopScenarioById,
  DESKTOP_PROFILES,
  DESKTOP_SCENARIOS,
  resolveDesktopSelection,
} from "./desktop-scenarios.mjs";

test("external fixture contracts execute without installed native-driver dependencies", async (t) => {
  // Storage guards can put os.tmpdir() inside an installed workspace. Keep this
  // small module fixture outside its dependency ancestry and prove resolution fails.
  const isolation = path.join(toolCachePaths().sharedRoot, "node-contracts");
  await mkdir(isolation, { recursive: true });
  const root = await mkdtemp(path.join(isolation, "native-contract-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = path.join(root, "apps", "desktop", "scripts");
  const output = path.join(root, "output");
  await mkdir(modules, { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await mkdir(output);
  for (const file of [
    "apps/desktop/scripts/desktop-external-runtime-test.mjs",
    "scripts/development-evidence.mjs",
  ])
    await copyFile(file, path.join(root, file));
  const consumer = path.join(modules, "consumer.mjs");
  await writeFile(
    consumer,
    `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import path from "node:path";
    assert.throws(() => import.meta.resolve("selenium-webdriver"), { code: "ERR_MODULE_NOT_FOUND" });
    const { createExternalRuntimeFixture, externalFixtureTreeDigest } =
      await import("./desktop-external-runtime-test.mjs");
    const fixture = await createExternalRuntimeFixture(process.argv[2]);
    const files = new Map(await Promise.all(["game.exe", "unknown-save.bin"].map(async name =>
      [name, await readFile(path.join(fixture.directory, name))])));
    assert.equal(fixture.port.release.user_prepared["windows-x86-64"].immutable_tree_sha256,
      externalFixtureTreeDigest(files));
    assert.equal(fixture.identities.length, 3);
    console.log("dependency-free fixture contracts passed");
  `,
  );
  const result = spawnSync(process.execPath, [consumer, output], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dependency-free fixture contracts passed/);
});

test("external runtime qualification is standalone and keeps a source-free inert tree", async (t) => {
  const id = "native-external-runtime-review";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, [
    "desktop",
    "native-dialog",
    "external-runtime-fixture",
  ]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
  assert.deepEqual(desktopScenarioById.get(id).platforms, ["win32"]);
  assert.equal(desktopScenarioById.get(id).qualification_only, true);
  for (const platform of ["linux", "darwin"])
    assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform }), /requires Windows/);
  assert.throws(() => resolveDesktopSelection({ scenarios: [id, "empty-library"] }), /standalone/);
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-external-runtime-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await createExternalRuntimeFixture(output);
  const document = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
  assert.equal(document.ports.length, 1);
  assert.deepEqual(document.source_catalog, {
    evidence: [],
    identities: [],
    contracts: [],
    validators: [],
  });
  assert.equal(document.ports[0].source_profile, undefined);
  const spec = document.ports[0].release.user_prepared["windows-x86-64"];
  const files = new Map(
    await Promise.all(
      ["game.exe", "unknown-save.bin"].map(async (name) => [
        name,
        await readFile(path.join(fixture.directory, name)),
      ]),
    ),
  );
  assert.equal(spec.immutable_tree_sha256, externalFixtureTreeDigest(files));
  files.set("unknown-save.bin", Buffer.from("different unknown save"));
  assert.notEqual(spec.immutable_tree_sha256, externalFixtureTreeDigest(files));
  assert.equal(fixture.identities.length, 3);
  for (const identity of fixture.identities)
    assert.equal((await fileIdentity(identity.path)).sha256, identity.sha256);
  await assert.rejects(createExternalRuntimeFixture(output), /EEXIST/);
  await assert.rejects(createExternalRuntimeFixture("relative"), /absolute/);
});

test("external tree hash is ordered, byte-sensitive and refuses unsafe path declarations", () => {
  const first = new Map([
    ["z.bin", Buffer.from("z")],
    ["a.bin", Buffer.from("a")],
  ]);
  assert.equal(
    externalFixtureTreeDigest(first),
    externalFixtureTreeDigest(new Map([...first].reverse())),
  );
  const changed = new Map(first);
  changed.set("a.bin", Buffer.from("aa"));
  assert.notEqual(externalFixtureTreeDigest(first), externalFixtureTreeDigest(changed));
  assert.throws(() => externalFixtureTreeDigest(new Map([["../outside", Buffer.from("x")]])));
});

test("external picker observation leaves immutable Tauri internals untouched and preserves failures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-picker-unmodified-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const refused of [false, true]) {
    const output = path.join(root, refused ? "refused" : "cancelled");
    await mkdir(output);
    const fixture = await createExternalRuntimeFixture(output);
    const original = () => {};
    const internals = Object.freeze({ invoke: original });
    const failure = new Error("original owned helper failure");
    let chosen = 0;
    const browser = {
      executeScript: () => {
        throw new Error("Unexpected internal instrumentation");
      },
      wait: async () => {},
      findElement: (locator) => ({
        click: async () => {
          if (locator.value.includes("Choose game folder")) chosen++;
        },
        sendKeys: async () => {},
        isEnabled: async () => true,
      }),
    };
    const action = externalRuntimePickerObservation({
      browser,
      By: { xpath: (value) => ({ value }), id: (value) => ({ value }) },
      Key: { chord: (...keys) => keys.join(""), CONTROL: "control", BACK_SPACE: "backspace" },
      until: { elementLocated: (locator) => locator },
      fixture,
      observePicker: async () => {
        assert.equal(chosen, 1);
        if (refused) throw failure;
        return { cancelled: true };
      },
    });
    if (refused) await assert.rejects(action, (error) => error === failure);
    else assert.equal((await action).cancelled, true);
    assert.equal(internals.invoke, original);
  }
});

test("external runtime journey retains a failed dispatcher picker phase before later actions", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-picker-phase-failure-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const failure = new Error("Original owned picker phase failed");
  const artifacts = [];
  await assert.rejects(
    externalRuntimeReviewScenario({
      output,
      By: { xpath: (value) => ({ value }) },
      artifacts,
      fixture: await createExternalRuntimeFixture(output),
      pickerObservation: Promise.reject(failure),
      invoke: () => {
        throw new Error("Later native actions must not run after failed picker cancellation");
      },
    }),
    (error) => error === failure,
  );
  const reportPath = path.join(output, "external-runtime-review.json");
  assert.deepEqual(artifacts, [reportPath]);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.error, String(failure));
  assert.deepEqual(report.steps, []);
});

test(
  "picker observation refuses stale launch identities and directory input before UI enumeration",
  { skip: process.platform !== "win32" },
  async (t) => {
    const output = await mkdtemp(path.join(os.tmpdir(), "portcove-picker-identity-"));
    t.after(() => rm(output, { recursive: true, force: true }));
    const script = path
      .resolve("apps/desktop/scripts/native-confirmation.ps1")
      .replaceAll("'", "''");
    for (const kind of ["stale-time", "wrong-image", "directory-input", "outside-prepared"]) {
      const helper = path.join(output, `${kind}.ps1`);
      const extra =
        kind === "directory-input"
          ? "-DirectoryPath $PSScriptRoot"
          : kind === "outside-prepared"
            ? "-PreparedRuntimeDirectory $PSScriptRoot"
            : "";
      await writeFile(
        helper,
        `
$ErrorActionPreference = 'Stop'
$owned = [Diagnostics.Process]::GetCurrentProcess()
$image = $owned.MainModule.FileName
$expectedImage = ${kind === "wrong-image" ? "'C:\\not-the-owned-driver.exe'" : "$image"}
$filetime = ${kind === "stale-time" ? "'1'" : "$owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()"}
try {
    & '${script}' -DriverProcessId $PID -ApplicationPath $image -ObservePicker -ExpectedDriverPath $expectedImage -ExpectedDriverStartedFiletime $filetime -ObservationPath (Join-Path $PSScriptRoot '${kind}.json') ${extra}
    exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`,
        { flag: "wx" },
      );
      const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", helper], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        kind === "directory-input"
          ? /Parameter set cannot be resolved/
          : kind === "outside-prepared"
            ? /exact regular owned fixture directory/
            : /Captured picker driver identity changed/,
      );
      await assert.rejects(stat(path.join(output, `${kind}.json`)), /ENOENT/);
    }
  },
);

test(
  "prepared runtime picker refuses a different directory before obtaining a driver",
  { skip: process.platform !== "win32" },
  async (t) => {
    const output = await mkdtemp(path.join(os.tmpdir(), "portcove-prepared-input-"));
    t.after(() => rm(output, { recursive: true, force: true }));
    const input = nativePreparedRuntimePicker({
      output,
      getDriverIdentity: () => {
        throw new Error("Driver must not be observed for rejected input");
      },
      artifacts: [],
    });
    await assert.rejects(
      input("refused-selection", output),
      /Expected values to be strictly equal/,
    );
  },
);

test("preferences recovery is standalone and preserves a malformed original before repair", async (t) => {
  const id = "native-startup-preferences-recovery";
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.equal(preferencesRecoverySelection(selection, "win32"), true);
  for (const platform of ["linux", "darwin"])
    assert.throws(() => preferencesRecoverySelection(selection, platform), /requires Windows/);
  assert.throws(() => resolveDesktopSelection({ scenarios: [id, "empty-library"] }), /standalone/);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop"]);
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-preferences-recovery-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await preparePreferencesRecoveryFixture(output);
  const original = await readFile(fixture.preferencesBefore);
  assert.throws(() => JSON.parse(original), SyntaxError);
  assert.deepEqual(await readFile(fixture.preferences), original);
  assert.deepEqual(await readFile(fixture.marker), await readFile(fixture.markerBefore));
  const repaired = Buffer.from(
    JSON.stringify({ format_version: 1, library_root: fixture.selectedRoot }),
  );
  await writeFile(fixture.preferences, repaired);
  await assert.rejects(preparePreferencesRecoveryFixture(output), { code: "EEXIST" });
  assert.deepEqual(await readFile(fixture.preferencesBefore), original);
  assert.deepEqual(await readFile(fixture.preferences), repaired);
});

test("library switch recovery refuses unsupported hosts and mixed setup before launch", () => {
  const selection = resolveDesktopSelection({ scenarios: ["native-library-switch-recovery"] });
  assert.equal(librarySwitchRecoverySelection(selection, "win32"), true);
  for (const platform of ["linux", "darwin"])
    assert.throws(() => librarySwitchRecoverySelection(selection, platform), /requires Windows/);
  assert.throws(() =>
    librarySwitchRecoverySelection({ ...selection, setup_scenarios: ["empty-library"] }, "win32"),
  );
  assert.throws(
    () =>
      resolveDesktopSelection({ scenarios: ["native-library-switch-recovery", "empty-library"] }),
    /standalone/,
  );
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "native-dialog"]);
  assert.ok(selection.host_resources.includes("native-dialog"));
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-library-switch-recovery"));
  assert.equal(desktopHarnessDeadlineMs(selection), 3 * 60_000);
});

test("future library fixture has a real SQLite ledger and cannot reseed a saved choice", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-library-switch-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await prepareLibrarySwitchRecoveryFixture(output);
  const bytes = await readFile(fixture.futureDatabase);
  assert.equal(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
  const database = new DatabaseSync(fixture.futureDatabase, { readOnly: true });
  try {
    assert.deepEqual(
      database
        .prepare("SELECT version, applied_at FROM schema_migrations")
        .all()
        .map((row) => ({ ...row })),
      [{ version: 999, applied_at: 0 }],
    );
  } finally {
    database.close();
  }
  assert.deepEqual(await readFile(fixture.futureDatabase), bytes);
  assert.equal(
    JSON.parse(await readFile(fixture.preferences, "utf8")).library_root,
    fixture.currentRoot,
  );
  const recovered = Buffer.from(
    JSON.stringify({ format_version: 1, library_root: fixture.healthyRoot }),
  );
  await writeFile(fixture.preferences, recovered);
  await assert.rejects(prepareLibrarySwitchRecoveryFixture(output), { code: "EEXIST" });
  assert.deepEqual(await readFile(fixture.preferences), recovered);
  assert.deepEqual(await readFile(fixture.futureDatabase), bytes);
  for (const marker of ["currentMarker", "futureMarker"])
    assert.deepEqual(await readFile(fixture[marker]), await readFile(fixture.before[marker]));
});

test("startup recovery refuses unsupported host and mixed setup before launch", () => {
  const selection = {
    selected_scenarios: ["native-startup-library-recovery"],
    setup_scenarios: [],
  };
  assert.equal(bootstrapRecoverySelection(selection, "win32"), true);
  for (const platform of ["linux", "darwin"])
    assert.throws(() => bootstrapRecoverySelection(selection, platform), /requires Windows/);
  assert.throws(() =>
    bootstrapRecoverySelection({ ...selection, setup_scenarios: ["empty-library"] }, "win32"),
  );
  assert.throws(() =>
    bootstrapRecoverySelection(
      { ...selection, selected_scenarios: [...selection.selected_scenarios, "empty-library"] },
      "win32",
    ),
  );
});

test("startup fixture child cannot inherit case aliases that mask saved selection", () => {
  const inherited = {
    ...process.env,
    PORTCOVE_LIBRARY: "masked-saved-selection",
    Portcove_Library: "masked-mixed-selection",
    portcove_library: "masked-lower-selection",
    PORTCOVE_PREFERENCES: "owned-preferences",
  };
  const environment = bootstrapRecoveryEnvironment(inherited);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify({library:process.env.PORTCOVE_LIBRARY,preferences:process.env.PORTCOVE_PREFERENCES}))",
    ],
    { env: environment, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { preferences: "owned-preferences" });
  assert.deepEqual(
    Object.keys(environment).filter((key) => key.toUpperCase() === "PORTCOVE_LIBRARY"),
    [],
  );
  assert.equal(inherited.PORTCOVE_LIBRARY, "masked-saved-selection");
  assert.equal(inherited.Portcove_Library, "masked-mixed-selection");
  assert.equal(inherited.portcove_library, "masked-lower-selection");
});

test("initial saved target is a regular file and reseeding cannot overwrite a recovered choice", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-startup-recovery-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await prepareBootstrapRecoveryFixture(output);
  assert.ok((await stat(fixture.invalidRoot)).isFile());
  assert.ok((await stat(fixture.selectedRoot)).isDirectory());
  const before = await readFile(fixture.preferencesBefore);
  assert.equal(JSON.parse(before).library_root, fixture.invalidRoot);
  assert.deepEqual(await readFile(fixture.invalidRoot), await readFile(fixture.invalidBefore));
  const recovered = Buffer.from(
    JSON.stringify({ format_version: 1, library_root: fixture.selectedRoot }),
  );
  await writeFile(fixture.preferences, recovered);
  await assert.rejects(prepareBootstrapRecoveryFixture(output), { code: "EEXIST" });
  assert.deepEqual(await readFile(fixture.preferences), recovered);
  assert.deepEqual(await readFile(fixture.preferencesBefore), before);
});

test("initial startup recovery remains a standalone opt-in native picker route", () => {
  const id = "native-startup-library-recovery";
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "native-dialog"]);
  assert.ok(selection.host_resources.includes("native-dialog"));
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  assert.throws(() => resolveDesktopSelection({ scenarios: [id, "empty-library"] }), /standalone/);
  assert.equal(desktopHarnessDeadlineMs(selection), 3 * 60_000);
});

test("cancelled navigation permits only observed GETs and never popup or execution traffic", () => {
  const request = { method: "GET", path: "/untrusted", phase: "navigation-http" };
  assertOwnedBoundaryRequests([]);
  assertOwnedBoundaryRequests([request]);
  for (const invalid of [
    { ...request, method: "POST" },
    { ...request, path: "/untrusted/popup" },
    { ...request, path: "/untrusted/executed-marker" },
    { ...request, path: "/", phase: "frame-csp" },
    { ...request, phase: "main-controls" },
  ])
    assert.throws(() => assertOwnedBoundaryRequests([invalid]));
});

test("owned frame CSP requires a trusted enforced event and removes its frame/listener/timer", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-frame-boundary-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const library = path.resolve("work", "frame-boundary-library");
  const url = "http://tauri.localhost/";
  const valid = {
    isTrusted: true,
    effectiveDirective: "frame-src",
    disposition: "enforce",
    blockedURI: "owned-frame",
    documentURI: url,
    originalPolicy: "default-src 'self'",
  };
  async function run(events, { changedContext = false, failSetup = false } = {}) {
    const output = await mkdtemp(path.join(outputRoot, "case-"));
    const listeners = new Set();
    const timers = new Set();
    const frames = [];
    let attempts = 0;
    let appended = false;
    const invoke = async (command) => {
      if (command === "get_locale_preference")
        throw new Error("Contract fixture stops after frame guard");
      if (command === "set_locale_preference") return { ok: true, value: null };
      if (command.startsWith("open_"))
        return {
          ok: false,
          error: {
            code: command === "open_external_url" ? "usage" : "not_found",
            message:
              command === "open_external_url"
                ? "only reviewed project, artwork source and GitHub sign-in links may be opened"
                : "unknown source evidence id: portcove-boundary-unknown-evidence",
          },
        };
      if (command.includes("boundary")) return { ok: false, error: `command ${command} not found` };
      return command === "get_bootstrap_status"
        ? {
            ok: true,
            value: {
              ready: true,
              error: null,
              library_root: library,
              generation: appended && changedContext ? 2 : 1,
              selection: { root: library, source: "environment" },
            },
          }
        : { ok: true, value: { id: "owned-library", root: library } };
    };
    let scriptCalls = 0;
    const browser = {
      getCurrentUrl: async () => url,
      manage: () => ({ setTimeouts: async () => {} }),
      executeScript: async () => (++scriptCalls === 1 ? {} : [url]),
      executeAsyncScript: (callback, attempted) => {
        if (attempted === undefined) return {};
        return new Promise((resolve) => {
          const document = {
            createElement: (tag) => {
              assert.equal(tag, "iframe");
              const frame = {
                isConnected: false,
                remove() {
                  this.isConnected = false;
                },
              };
              frames.push(frame);
              return frame;
            },
            addEventListener: (type, handler) => {
              assert.equal(type, "securitypolicyviolation");
              listeners.add(handler);
            },
            removeEventListener: (type, handler) => {
              assert.equal(type, "securitypolicyviolation");
              listeners.delete(handler);
            },
            body: {
              append(frame) {
                appended = true;
                attempts++;
                assert.equal(frame.src, attempted);
                if (failSetup) throw new Error("Owned fixture append failed");
                frame.isConnected = true;
                for (const event of events)
                  for (const listener of [...listeners]) {
                    const wrongOrigin = new URL(attempted);
                    wrongOrigin.port = String(
                      Number(wrongOrigin.port) === 65535 ? 1 : Number(wrongOrigin.port) + 1,
                    );
                    listener({
                      ...event,
                      blockedURI:
                        event.blockedURI === "owned-frame"
                          ? attempted
                          : event.blockedURI === "wrong-origin"
                            ? wrongOrigin.href
                            : event.blockedURI === "wrong-path"
                              ? new URL("/other", attempted).href
                              : event.blockedURI,
                    });
                  }
                // Advance the fixture's virtual deadline, without a real wait.
                for (const timer of [...timers]) timer();
              },
            },
          };
          runInNewContext(
            `(${callback.toString()})(attempted, done)`,
            {
              URL,
              document,
              attempted,
              done: resolve,
              setTimeout: (handler, milliseconds) => {
                assert.equal(milliseconds, 9000);
                timers.add(handler);
                return handler;
              },
              clearTimeout: (handler) => timers.delete(handler),
            },
            { timeout: 1000 },
          );
        });
      },
    };
    let error;
    try {
      await normalPackageBoundaryScenario({
        browser,
        invoke,
        library,
        output,
        artifacts: [],
        packageEvidence: { fixture: true },
      });
    } catch (caught) {
      if (caught.message !== "Contract fixture stops after frame guard") error = caught;
    }
    const observations = JSON.parse(
      await readFile(path.join(output, "normal-package-boundary.json")),
    );
    assert.equal(attempts, 1);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].isConnected, false);
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0);
    return { observations, error };
  }
  const wrong = [
    { ...valid, isTrusted: false },
    { ...valid, disposition: "report" },
    { ...valid, effectiveDirective: "script-src" },
    { ...valid, blockedURI: "wrong-origin" },
    { ...valid, blockedURI: "wrong-path" },
    { ...valid, blockedURI: "inline" },
  ];
  const positive = await run([...wrong, valid]);
  assert.equal(positive.error, undefined);
  assert.equal(new URL(positive.observations.cspFrame.attempted).hostname, "127.0.0.1");
  assert.equal(new URL(positive.observations.cspFrame.attempted).pathname, "/");
  assert.deepEqual(positive.observations.cspFrame.after, positive.observations.cspFrame.before);
  for (const events of [[], ...wrong.map((event) => [event])]) {
    const rejected = await run(events);
    assert.match(rejected.error.message, /enforced owned-frame CSP refusal/);
    assert.equal(rejected.observations.cspFrame.refusal.observed, false);
    assert.equal(rejected.observations.cspFrame.refusal.frameRemoved, true);
  }
  assert.match(
    (await run([valid], { changedContext: true })).error.message,
    /preserve main and library context/,
  );
  const setupFailure = await run([], { failSetup: true });
  assert.match(setupFailure.error.message, /enforced owned-frame CSP refusal/);
  assert.equal(setupFailure.observations.cspFrame.refusal.reason, "frame-setup-failed");
});

test("reviewed link refusals require guard errors and preserve the ready native context", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-link-boundary-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const library = path.resolve("work", "link-boundary-library");
  const status = {
    ready: true,
    error: null,
    library_root: library,
    generation: 1,
    selection: { root: library, source: "environment" },
  };
  async function run({
    refusal,
    contextChange,
    identityChange,
    identityRoot = library,
    urlChange,
  } = {}) {
    const output = await mkdtemp(path.join(outputRoot, "case-"));
    const calls = [];
    let refused = false;
    const observations = {};
    const invoke = async (command, args) => {
      calls.push({ command, args });
      if (command === "set_locale_preference") return { ok: true, value: null };
      if (command === "create_boundary_windows")
        throw new Error("Contract fixture stops after link guards");
      if (command === "get_bootstrap_status")
        return { ok: true, value: { ...status, ...(refused ? contextChange : {}) } };
      if (command === "get_library_identity")
        return {
          ok: true,
          value: { id: "owned-library", root: identityRoot, ...(refused ? identityChange : {}) },
        };
      refused = true;
      return (
        refusal ?? {
          ok: false,
          error: {
            code: command === "open_external_url" ? "usage" : "not_found",
            message:
              command === "open_external_url"
                ? "only reviewed project, artwork source and GitHub sign-in links may be opened"
                : "unknown source evidence id: portcove-boundary-unknown-evidence",
          },
        }
      );
    };
    await normalPackageBoundaryScenario({
      browser: {
        getCurrentUrl: async () => (refused && urlChange) || "http://tauri.localhost/",
        manage: () => ({ setTimeouts: async () => {} }),
        executeScript: async () => ({}),
        executeAsyncScript: async () => ({}),
      },
      invoke,
      library,
      output,
      artifacts: [],
      packageEvidence: { fixture: true },
    }).catch((error) => {
      if (error.message !== "Contract fixture stops after link guards") throw error;
    });
    Object.assign(
      observations,
      JSON.parse(await readFile(path.join(output, "normal-package-boundary.json"))),
    );
    return { calls, observations };
  }
  const { calls, observations } = await run();
  assert.equal(observations.reviewedLinkRefusals.length, 2);
  assert.deepEqual(
    calls.filter(({ command }) => command.startsWith("open_")),
    [
      {
        command: "open_external_url",
        args: { url: "https://unreviewed.portcove.invalid/boundary" },
      },
      {
        command: "open_source_evidence",
        args: { evidenceId: "portcove-boundary-unknown-evidence" },
      },
    ],
  );
  for (const refusal of [
    { ok: true, value: null },
    { ok: false, error: "command open_external_url not found" },
    { ok: false, error: { code: "usage" } },
    { ok: false, error: { code: "state", message: "library unavailable" } },
    {
      ok: false,
      error: { code: "unsupported", message: "source evidence requires catalog schema 2" },
    },
  ])
    await assert.rejects(run({ refusal }));
  for (const contextChange of [
    { ready: false },
    { generation: 2 },
    { library_root: path.resolve("work", "other-library") },
    { selection: { root: library, source: "saved" } },
  ])
    await assert.rejects(run({ contextChange }));
  await assert.rejects(run({ identityChange: { id: "other-library" } }));
  await assert.rejects(run({ identityChange: { root: path.resolve("work", "other-library") } }));
  await assert.rejects(run({ urlChange: "https://unreviewed.portcove.invalid/boundary" }));
  if (process.platform === "win32") {
    const namespaced = await run({ identityRoot: path.toNamespacedPath(library) });
    assert.equal(namespaced.observations.reviewedLinkRefusals.length, 2);
    assert.ok(namespaced.observations.reviewedLinkRefusals.every((record) => record.after));
    await assert.rejects(
      run({ identityRoot: path.toNamespacedPath(path.resolve("work", "other-library")) }),
    );
  }
});

test("ordinary package boundary is isolated and rejects stale or substituted evidence", async (t) => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-normal-package-webview-boundary"],
  });
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop"]);
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-normal-package-webview-boundary"));
  const work = path.resolve("work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "normal-package-contract-"));
  t.after(async () => {
    assert.equal(path.dirname(root), work);
    await rm(root, { recursive: true });
  });
  await mkdir(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
  const configuration = [];
  for (const name of ["tauri.conf.json", "tauri.windows.conf.json", "Cargo.toml"]) {
    const file = path.join(root, "apps/desktop/src-tauri", name);
    await writeFile(file, "owned configuration fixture");
    configuration.push(await fileIdentity(file));
  }
  const installerPath = path.join(root, "installer.exe");
  await writeFile(installerPath, "owned package fixture");
  const installer = await fileIdentity(installerPath);
  const executable = { sha256: "a".repeat(64) };
  const receiptPath = path.join(root, "installer-evidence.json");
  await writeFile(
    receiptPath,
    JSON.stringify({
      phase: "complete",
      details: {
        installer_sha256: installer.sha256,
        installed_executable_sha256: executable.sha256,
        application_responding: true,
        persistent_data_preserved: true,
        managed_files_removed: true,
        registration_removed: true,
        application_exit_code: 0,
      },
    }),
  );
  const manifest = {
    revision: "b".repeat(40),
    build_command: ["corepack", "pnpm", "tauri", "build", "--bundles", "nsis"],
    qualification_features: [],
    configuration,
    installer,
    installer_evidence: await fileIdentity(receiptPath),
  };
  const manifestPath = path.join(root, "package.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await verifyNormalPackageEvidence(manifestPath, manifest.revision, executable, root);
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, "c".repeat(40), executable, root),
    /source must match/,
  );
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, { sha256: "d".repeat(64) }, root),
  );
  await writeFile(installerPath, "substituted package");
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, executable, root),
    /input changed/,
  );
  await writeFile(installerPath, "owned package fixture");
  const originalReceipt = await readFile(receiptPath, "utf8");
  await writeFile(receiptPath, originalReceipt.replace('"complete"', '"failed"'));
  manifest.installer_evidence = await fileIdentity(receiptPath);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, executable, root),
  );
  await mkdir(path.join(root, "installed"));
  const installedPath = path.join(root, "installed", "portcove-desktop.exe");
  await writeFile(installedPath, "owned installed executable");
  const installedExecutable = await fileIdentity(installedPath);
  const ready = {
    phase: "current_installed_boundary_ready",
    details: {
      installer_sha256: installer.sha256,
      installed_executable_sha256: installedExecutable.sha256,
      installed_executable_path: installedPath,
      install_root: path.dirname(installedPath),
      registration_path:
        "Microsoft.PowerShell.Core\\Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PortcoveFixture",
      uninstall_registration_count: 1,
      application_responding: true,
      application_exit_code: 0,
      persistent_data_preserved: true,
    },
  };
  manifest.execution_context = "current-installed";
  const bindReady = async (receipt) => {
    await writeFile(receiptPath, JSON.stringify(receipt));
    manifest.installer_evidence = await fileIdentity(receiptPath);
    await writeFile(manifestPath, JSON.stringify(manifest));
  };
  await bindReady(ready);
  const verified = await verifyNormalPackageEvidence(
    manifestPath,
    manifest.revision,
    installedExecutable,
    root,
  );
  assert.equal(verified.execution_context, "current-installed");
  for (const [field, value] of [
    ["uninstall_registration_count", 0],
    ["uninstall_registration_count", 2],
    [
      "registration_path",
      ready.details.registration_path.replace("HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE"),
    ],
    ["installed_executable_path", path.join(root, "copied.exe")],
    ["install_root", root],
    ["application_responding", false],
    ["application_exit_code", 1],
    ["persistent_data_preserved", false],
  ]) {
    await bindReady({ ...ready, details: { ...ready.details, [field]: value } });
    await assert.rejects(
      verifyNormalPackageEvidence(manifestPath, manifest.revision, installedExecutable, root),
      `${field} must refuse current-installed credit`,
    );
  }
  await bindReady({ ...ready, phase: "complete" });
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, installedExecutable, root),
    "Post-uninstall evidence must not claim a current installation",
  );
  await bindReady(ready);
  await writeFile(installedPath, "changed after installation");
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, installedExecutable, root),
    "Changed installed bytes must fail even when the manifest still matches",
  );
});

test("desktop scenario catalog is nonempty, unique, and fully profiled", () => {
  assert.ok(DESKTOP_SCENARIOS.length > 0);
  assert.equal(new Set(DESKTOP_SCENARIOS.map((item) => item.id)).size, DESKTOP_SCENARIOS.length);
  for (const [profile, ids] of Object.entries(DESKTOP_PROFILES)) {
    assert.ok(ids.length > 0, profile);
    assert.equal(new Set(ids).size, ids.length, profile);
    for (const id of ids)
      assert.ok(
        DESKTOP_SCENARIOS.some((item) => item.id === id),
        `${profile}: ${id}`,
      );
  }
  for (const item of catalogReport()) {
    if (item.id === "native-repeated-library-reload" || item.qualification_only) continue;
    assert.ok(item.profiles.length > 0, item.id);
    for (const dependency of item.dependencies) {
      const dependencyIndex = DESKTOP_SCENARIOS.findIndex(
        (candidate) => candidate.id === dependency,
      );
      const itemIndex = DESKTOP_SCENARIOS.findIndex((candidate) => candidate.id === item.id);
      assert.ok(dependencyIndex >= 0, `${item.id}: missing dependency ${dependency}`);
      assert.ok(dependencyIndex < itemIndex, `${item.id}: dependency must execute first`);
      assert.equal(DESKTOP_SCENARIOS[dependencyIndex].runnable, true, dependency);
    }
  }
});

test("smoke includes isolated install cancellation and committed-refresh recovery", () => {
  const selection = resolveDesktopSelection();
  assert.equal(selection.profile, "smoke");
  assert.ok(selection.selected_scenarios.includes("keyboard-layout"));
  assert.ok(selection.selected_scenarios.includes("install-progress-cancellation"));
  assert.ok(selection.selected_scenarios.includes("install-commit-refresh-recovery"));
  assert.ok(selection.prerequisites.includes("install-fixture"));
  assert.deepEqual(selection.known_gaps, []);
});

test("live default-cover observation remains opt-in without fixtures or offline profiles", () => {
  for (const id of ["native-default-cover-display", "native-default-cover-cache-conditions"]) {
    for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
    const selection = resolveDesktopSelection({ scenarios: [id] });
    assert.deepEqual(selection.selected_scenarios, [id]);
    assert.deepEqual(selection.setup_scenarios, []);
    assert.deepEqual(selection.prerequisites, ["desktop"]);
    assert.ok(desktopHarnessDeadlineMs(selection) > 180_000);
  }
});

test("exact selections are deduplicated and returned in catalog order", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["accessibility", "keyboard-layout", "accessibility"],
  });
  assert.equal(selection.profile, null);
  assert.deepEqual(selection.selected_scenarios, ["keyboard-layout", "accessibility"]);
  assert.deepEqual(selection.setup_scenarios, []);
});

test("signed artwork correction is an isolated opt-in consumer proof", () => {
  const id = "native-artwork-catalog-correction";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture", "native-dialog"]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
});

test("design compatibility stays exact-selection-only and requests its isolated fixture", () => {
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-design-system-compatibility"));
  const selection = resolveDesktopSelection({
    scenarios: ["native-design-system-compatibility"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-design-system-compatibility"]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.ok(selection.prerequisites.includes("design-compatibility-fixture"));
});

test("live host interruption selects its own fixture without synthetic recovery setup", () => {
  const id = "native-host-interrupted-preparation";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture"]);
  assert.ok(selection.host_resources.includes("native-desktop"));
});

test("minimized live preparation is one opt-in bounded Windows scenario", () => {
  const id = "native-minimized-preparation-continuity";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture"]);
  assert.ok(selection.host_resources.includes("native-desktop"));
  assert.ok(selection.host_resources.includes("keyboard-pointer"));
  assert.deepEqual(desktopScenarioById.get(id).platforms, ["win32"]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
});

test("ordinary preparation close stays isolated from forced and minimized cases", () => {
  const id = "native-closed-preparation-recovery";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture"]);
  assert.deepEqual(desktopScenarioById.get(id).platforms, ["win32"]);
  assert.equal(desktopScenarioById.get(id).qualification_only, true);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "native-host-interrupted-preparation"] }),
    /one exact standalone scenario/,
  );
});

test("replacement identity failure cannot reuse the former host's exit receipt", () => {
  const session = new OwnedNativeSession();
  session.driver = { pid: 1 };
  session.inventory = "former-host-inventory";
  session.cleanup = { exited: { observed_processes: 3 } };
  const previous = session.requireQuiescence();
  session.beginLaunch(); // Called before spawning the replacement.
  // Spawn succeeded; its subsequent identity capture failed.
  assert.equal(session.cleanup, undefined, "Final cleanup cannot take an old-success shortcut");
  assert.equal(session.inventory, undefined);
  assert.throws(() => session.requireQuiescence(), /Current owned launch identity/);
  assert.equal(previous.exited.observed_processes, 3, "Former receipt stays preserved separately");
  session.driver = { pid: 2 };
  assert.throws(() => session.requireQuiescence(), /Current owned exit inventory/);
  session.inventory = "replacement-host-inventory";
  assert.throws(() => session.requireQuiescence(), /Positive current owned/);
  session.cleanup = { exited: { observed_processes: 4 } };
  assert.equal(session.requireQuiescence().exited.observed_processes, 4);
});

test("focused lifecycle selection resolves setup without claiming it", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-reviewed-installed-game-removal"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-reviewed-installed-game-removal"]);
  assert.deepEqual(selection.setup_scenarios, [
    "native-preparation-review-and-play",
    "native-reviewed-backup-restore-and-delete",
  ]);
  assert.ok(selection.prerequisites.includes("owned-fixture"));
  assert.ok(selection.host_resources.includes("native-dialog"));
});

test("fixture-only reviews select without first-play while continuity keeps its setup", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-reviewed-steam-entry-add-and-remove"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-reviewed-steam-entry-add-and-remove"]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.ok(selection.prerequisites.includes("owned-fixture"));
  assert.ok(selection.prerequisites.includes("steam-fixture"));
  assert.ok(selection.host_resources.includes("native-dialog"));
  for (const id of ["native-game-update-review", "native-reviewed-backup-restore-and-delete"])
    assert.deepEqual(resolveDesktopSelection({ scenarios: [id] }).setup_scenarios, [], id);
  assert.deepEqual(
    resolveDesktopSelection({ scenarios: ["native-game-return-continuity"] }).setup_scenarios,
    ["native-preparation-review-and-play"],
  );
  assert.ok(
    resolveDesktopSelection({ profile: "full" }).selected_scenarios.includes(
      "native-preparation-review-and-play",
    ),
  );
});

test("staged native composition installs its isolated fixture before review", () => {
  const selection = resolveDesktopSelection({ scenarios: ["native-staged-update-composition"] });
  assert.deepEqual(selection.selected_scenarios, ["native-staged-update-composition"]);
  assert.deepEqual(selection.setup_scenarios, ["install-commit-refresh-recovery"]);
  assert.ok(selection.prerequisites.includes("install-fixture"));
});

test("missing Steam review context fails without loading Selenium", () => {
  const context = {
    browser: {},
    invoke: async () => {},
    scenario: async () => {},
    output: "<negative-fixture>",
    artifacts: [],
    command: () => {},
    seed: async () => {},
    confirmNative: async () => {},
  };
  assert.throws(
    () => assertSteamEntryContext(context),
    /Steam review scenario requires context\.open/,
  );
});

test("selection rejects ambiguity, unknown IDs, and invalid reload requests", () => {
  assert.throws(
    () => resolveDesktopSelection({ profile: "smoke", scenarios: ["accessibility"] }),
    /cannot be combined/,
  );
  assert.throws(() => resolveDesktopSelection({ profile: "unknown" }), /Unknown desktop profile/);
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["missing"] }),
    /Unknown desktop scenario/,
  );
  const install = resolveDesktopSelection({ scenarios: ["install-progress-cancellation"] });
  assert.deepEqual(install.selected_scenarios, ["install-progress-cancellation"]);
  assert.ok(install.prerequisites.includes("install-fixture"));
  const refresh = resolveDesktopSelection({ scenarios: ["install-commit-refresh-recovery"] });
  assert.deepEqual(refresh.selected_scenarios, ["install-commit-refresh-recovery"]);
  assert.deepEqual(refresh.setup_scenarios, []);
  assert.ok(refresh.prerequisites.includes("install-fixture"));
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["native-repeated-library-reload"] }),
    /requires --reload-cycles/,
  );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["accessibility"], reloadCycles: 2 }),
    /requires --scenario/,
  );
});

test("reload is opt-in for restart and full profiles", () => {
  assert.ok(
    !resolveDesktopSelection({ profile: "restart" }).selected_scenarios.includes(
      "native-repeated-library-reload",
    ),
  );
  assert.ok(
    resolveDesktopSelection({ profile: "restart", reloadCycles: 3 }).selected_scenarios.includes(
      "native-repeated-library-reload",
    ),
  );
});

test("large lifecycle profiles receive a bounded profile-scale watchdog", () => {
  assert.equal(
    desktopHarnessDeadlineMs(resolveDesktopSelection({ profile: "presentation" })),
    180_000,
  );
  assert.equal(desktopHarnessDeadlineMs(resolveDesktopSelection({ profile: "full" })), 600_000);
});

test("backup success-focus acceptance is isolated and exact-selection-only", () => {
  const id = "native-backup-delete-focus";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture", "native-dialog"]);
  assert.deepEqual(selection.host_resources, [
    "native-desktop",
    "keyboard-pointer",
    "native-dialog",
  ]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
});

test("saved-folder selected setup stays standalone and opt-in", () => {
  const id = "native-saved-folder-selected-setup";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "install-fixture", "owned-fixture"]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
  for (const profile of ["smoke", "full"])
    assert.ok(
      !resolveDesktopSelection({ profile, platform: "win32" }).selected_scenarios.includes(id),
    );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "keyboard-layout"], platform: "win32" }),
    /standalone/,
  );
  assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform: "linux" }), /Windows/);
});

test("selected setup identities admit both replacements only in the opt-in catalog", async (t) => {
  const root = path.resolve(import.meta.dirname, "..");
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-selected-setup-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await createInstallFixture({
    root,
    output,
    sourceJourney: true,
    revision: "a".repeat(40),
  });
  t.after(() => fixture.close());
  const catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
  const owned = fixture.sourceJourney;
  assert.equal(owned.game.length, owned.replacement.length);
  assert.notDeepEqual(owned.game, owned.replacement);
  for (const [name, original] of [
    ["gamePath", "gameBefore"],
    ["biosPath", "biosBefore"],
  ])
    assert.deepEqual(await readFile(owned[name]), await readFile(owned[original]));
  const identities = catalog.source_catalog.identities.filter((item) =>
    owned.profiles.includes(item.id),
  );
  assert.deepEqual(
    identities.map((item) => item.variants.length),
    [2, 1],
  );
  const expectedHashes = await Promise.all(
    [owned.gameBefore, owned.gameReplacement].map(
      async (file) => (await fileIdentity(file)).sha256,
    ),
  );
  assert.deepEqual(
    identities[0].variants.map((item) => item.representations[0].identities[0].sha256),
    expectedHashes,
  );
  for (const port of [fixture.port, fixture.refreshPort]) {
    const contract = catalog.source_catalog.contracts.find(
      (item) => item.port_id === port.id && item.role === "game",
    );
    assert.deepEqual(contract.supported_variant_ids, ["inert-0", "inert-1"]);
    assert.equal(contract.admission_mode, "enforced");
    assert.ok(contract.immutable_review_url.includes("a".repeat(40)));
    for (const requirement of port.presentation.source_requirements) {
      const sourceContract = catalog.source_catalog.contracts.find(
        (item) => item.port_id === port.id && item.role === requirement.role,
      );
      assert.equal(sourceContract.admission_mode, "enforced");
      assert.equal(sourceContract.validator_contract_id, null);
      assert.equal(requirement.verification, "catalog-identity");
    }
  }
  assert.equal(fixture.port.adapter, "libultraship-portable");
  assert.equal(fixture.refreshPort.adapter, "psx-recomp-managed");
  assert.equal(fixture.refreshPort.bios_source_profile, owned.profiles[1]);
  assert.equal(fixture.requests.length, 0);
  const ordinaryOutput = await mkdtemp(path.join(os.tmpdir(), "portcove-ordinary-install-"));
  t.after(() => rm(ordinaryOutput, { recursive: true, force: true }));
  const ordinary = await createInstallFixture({ root, output: ordinaryOutput });
  t.after(() => ordinary.close());
  assert.equal(ordinary.sourceJourney, null);
  assert.equal(ordinary.port.source_profile, undefined);
  assert.equal(ordinary.refreshPort.bios_source_profile, undefined);
  const original = JSON.parse(
    await readFile(path.join(root, "crates/portcove-core/catalog/catalog.json"), "utf8"),
  );
  const ordinaryCatalog = JSON.parse(await readFile(ordinary.catalogPath, "utf8"));
  assert.deepEqual(ordinaryCatalog.source_catalog, original.source_catalog);
});
