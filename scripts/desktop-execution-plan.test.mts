import {
  nativeHelperDependencies,
  nativeHelperRegistryPath,
  nativeHelperSharedSources,
  captureDesktopReceiptInputs,
  observeDesktopHarnessInputs,
} from "./native-helper-dependencies.mts";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { verifyConsumedInputs } from "./retained-evidence.mts";
import os from "node:os";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runTypeScriptInNewContext as runInNewContext } from "./test-source.mts";
import { fileIdentity } from "./development-evidence.mts";
import { planDesktopExecution, nativeTransportReceiptSources } from "./desktop-execution-plan.mts";
import { resolveDesktopSelection, desktopHarnessDeadlineMs } from "./desktop-scenarios.mts";
import { buildDesktopVerifyPlan } from "./desktop-verify.mts";
import { runOwnedFixtureJourneys } from "../apps/desktop/scripts/desktop-owned-fixture-journeys.mts";
import { OwnedNativeSession } from "../apps/desktop/scripts/desktop-owned-native-session.mts";
import baseline from "./desktop-execution-baseline.mts";
import type { DesktopSelection } from "./desktop-scenarios.mts";
type KnownGap = DesktopSelection["known_gaps"][number];
import type { OwnedFixtureJourneys } from "../apps/desktop/scripts/desktop-owned-fixture-journeys.mts";
const executableNames = {
  app: "baseline-app.exe",
  driver: "baseline-driver.exe",
  "native-driver": "baseline-native-driver.exe",
  "preparation-cli": "baseline-cli.exe",
  "preparation-tool": "baseline-tool.exe",
};

void test("native review presentation dependency is retained once for every platform and profile", () => {
  const dependency = "apps/desktop/scripts/desktop-review-presentation.mts";
  assert.equal(nativeTransportReceiptSources.filter((source) => source === dependency).length, 1);
  for (const platform of ["win32", "linux", "darwin"] as const)
    for (const profile of ["smoke", "presentation", "full"])
      assert.equal(
        planDesktopExecution(resolveDesktopSelection({ platform, profile }), {
          platform,
        }).receiptInputs.filter((input) => input.kind === "file" && input.path === dependency)
          .length,
        1,
        `${platform}/${profile}`,
      );
});

void test("native display identity dependency retains the exact helper consumed by preparation", async () => {
  const preparation = new URL(
    "../apps/desktop/scripts/desktop-preparation-test.mts",
    import.meta.url,
  );
  const executed = stripTypeScriptTypes(await readFile(preparation, "utf8"), { mode: "strip" });
  const identityImport = executed.match(
    /import\s*\{\s*gameTitle,\s*gameIdentityLabel\s*\}\s*from\s*["']([^"']+)["']/u,
  );
  assert.ok(identityImport?.[1], "Preparation must use the shared display identity contract");
  const dependency = new URL(identityImport[1], preparation);
  const expected = "apps/desktop/src/port-identity.ts";
  assert.equal(
    fileURLToPath(dependency),
    fileURLToPath(new URL(`../${expected}`, import.meta.url)),
  );
  assert.equal(nativeTransportReceiptSources.filter((source) => source === expected).length, 1);
  // Preparation is statically imported even for smoke. Capture its actual pure
  // identity dependency once for every platform/profile, without widening build
  // features or treating captured source as proof that a journey executed.
  for (const platform of ["win32", "linux", "darwin"] as const)
    for (const profile of ["smoke", "presentation", "full"])
      assert.equal(
        planDesktopExecution(resolveDesktopSelection({ platform, profile }), {
          platform,
        }).receiptInputs.filter((input) => input.kind === "file" && input.path === expected).length,
        1,
      );
});

void test("Windows final custody gate retains failed current exit without fixture or lease release", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
    "utf8",
  );
  const first = source.indexOf("async function releaseNativeResources()");
  const last = source.indexOf("async function retainNativeCustody(", first);
  assert.ok(first >= 0 && last > first);
  assert.match(
    source.slice(source.lastIndexOf("  } finally {")),
    /await releaseNativeResources\(\);/,
  );
  for (const positive of [false, true]) {
    const session = new OwnedNativeSession();
    session.beginLaunch();
    session.driver = { pid: 2, path: "C:\\fixture\\driver.exe", started_filetime: "200" };
    session.inventory = "current.json";
    if (positive)
      session.cleanup = {
        stopped: { method: "observed-child-exit", exit_code: 0 },
        exited: { observed_processes: 4, exited_at: "2026-10-20T00:00:00Z", wait_ms: 1 },
        snapshot: "current.json",
      };
    const calls: string[] = [];
    const retained = new Error("retained runner");
    const release = callable(
      runInNewContext(`${source.slice(first, last)}; releaseNativeResources`, {
        process: { platform: "win32" },
        identityBoundSession: true,
        ownedSession: session,
        installFixture: {
          close: async () => {
            calls.push("install-close");
          },
        },
        originFixture: {
          close: async () => {
            calls.push("origin-close");
          },
        },
        nativeLock: {
          release: async () => {
            calls.push("release");
          },
        },
        retainNativeCustody: async (error: unknown) => {
          assert.match(String(error), /Positive current owned/);
          calls.push("retain");
          throw retained;
        },
      }),
    );
    if (positive) {
      await release();
      assert.deepEqual(calls, ["install-close", "origin-close", "release"]);
    } else {
      await assert.rejects(
        async () => release(),
        (error: unknown) => error === retained,
      );
      assert.deepEqual(calls, ["retain"]);
    }
  }
});

void test("Windows admission refusal preserves former exit proof until a replacement spawn is attempted", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
    "utf8",
  );
  const first = source.indexOf("async function startDriver(");
  const last = source.indexOf("async function captureSelectedDriverLaunch(", first);
  assert.ok(first >= 0 && last > first);
  for (const admissionRefuses of [true, false]) {
    const session = new OwnedNativeSession();
    session.beginLaunch();
    session.driver = { pid: 2, path: "C:\\fixture\\driver.exe", started_filetime: "200" };
    session.inventory = "former.json";
    session.cleanup = {
      stopped: { method: "observed-child-exit", exit_code: 0 },
      exited: { observed_processes: 4, exited_at: "2026-10-20T00:00:00Z", wait_ms: 1 },
      snapshot: "former.json",
    };
    const former = session.requireQuiescence();
    const calls: string[] = [];
    const refused = new Error("admission refused");
    const spawnFailure = new Error("replacement spawn failed");
    const begin = session.beginLaunch.bind(session);
    session.beginLaunch = () => {
      calls.push("begin");
      begin();
    };
    const start = callable(
      runInNewContext(`${source.slice(first, last)}; startDriver`, {
        assert,
        linuxPackagedInspector: false,
        linuxSelectedSession: false,
        nativeAccount: undefined,
        admission: {
          verify: async () => {
            calls.push("verify");
          },
          assertReady: () => {
            calls.push("admission");
            if (admissionRefuses) throw refused;
          },
        },
        custody: undefined,
        ownedSession: session,
        port: 4444,
        nativeDriverPath: "/native-driver",
        driverPath: "/driver",
        process: { platform: "win32" },
        driverEnvironment: () => ({}),
        spawn: () => {
          calls.push("spawn");
          throw spawnFailure;
        },
      }),
    );
    await assert.rejects(
      async () => start(),
      (error: unknown) => error === (admissionRefuses ? refused : spawnFailure),
    );
    if (admissionRefuses) {
      assert.deepEqual(calls, ["verify", "admission"]);
      assert.equal(session.requireQuiescence(), former);
    } else {
      assert.deepEqual(calls, ["verify", "admission", "begin", "spawn"]);
      assert.throws(() => session.requireQuiescence(), /Current owned launch identity/);
    }
  }
});

void test("Windows retained custody keeps its hold even when failure evidence cannot be published", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
    "utf8",
  );
  const first = source.indexOf("async function retainNativeCustody(");
  const last = source.indexOf("async function stopDriver()", first);
  assert.ok(first >= 0 && last > first);
  const calls: string[] = [];
  const holding = new Error("injected retained hold");
  class HoldPromise {
    constructor() {
      return Promise.reject(holding);
    }
  }
  const retain = callable(
    runInNewContext(`${source.slice(first, last)}; retainNativeCustody`, {
      process: { exitCode: 0 },
      path,
      output: "/owned",
      cleanupName: "fixture",
      ownedSession: {},
      errorMessage: String,
      writeFile: async () => {
        calls.push("publish");
        throw new Error("disk failure");
      },
      console: {
        error: () => {
          calls.push("report");
        },
      },
      setInterval: () => {
        calls.push("hold");
      },
      Promise: HoldPromise,
    }),
  );
  await assert.rejects(
    async () => retain(new Error("Wait failed")),
    (error: unknown) => error === holding,
  );
  assert.deepEqual(calls, ["publish", "report", "report", "hold"]);
});

void test("native interface enlargement retains its exact assertion source without changing ordinary profiles", () => {
  const id = "native-interface-size";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.equal(
    plan.receiptInputs.filter(
      (input) =>
        input.kind !== "executable" &&
        receiptFilePath(input) === "apps/desktop/scripts/desktop-interface-size-test.mts",
    ).length,
    1,
  );
  for (const profile of ["smoke", "presentation", "full"])
    assert.ok(
      !resolveDesktopSelection({ profile, platform: "win32" }).selected_scenarios.includes(id),
    );
  assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform: "linux" }));
});

void test("real prepared runtimes use production builds and positive owned closure", () => {
  const id = "native-real-prepared-runtime";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "real-prepared-runtime");
  assert.equal(plan.fixtures.owned, true);
  assert.deepEqual(plan.build.cliFeatures, []);
  assert.deepEqual(plan.build.qualificationFeatures, []);
  assert.ok(
    plan.receiptInputs.some(
      (input) => input.kind === "file" && input.path === "scripts/desktop-real-runtime-inputs.mts",
    ),
  );
  assert.ok(
    plan.receiptInputs.some(
      (input) =>
        input.kind === "file" &&
        input.path === "apps/desktop/scripts/desktop-real-runtime-test.mts",
    ),
  );
  assert.ok(
    plan.receiptInputs.some(
      (input) => input.kind === "executable" && input.name === "preparation-cli",
    ),
  );
  assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform: "linux" }));
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "empty-library"], platform: "win32" }),
    /standalone/,
  );
});

void test("publication interruption is standalone, instrumented and positively supervised", () => {
  const id = "native-host-publication-recovery";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.deepEqual(selection.setup_scenarios, []);
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "host-publication");
  assert.deepEqual(plan.build.cliFeatures, ["portcove-core/qualification-fixtures"]);
  assert.equal(plan.fixtures.install, true);
  assert.equal(plan.fixtures.owned, true);
  assert.equal(plan.fixtures.holdFirstDownload, false);
  assert.deepEqual(plan.build.qualificationFeatures, ["qualification-fixtures"]);
  assert.equal(desktopHarnessDeadlineMs(selection), 720_000);
  assert.ok(
    plan.receiptInputs.some(
      (input) =>
        input.kind === "file" &&
        input.path === "apps/desktop/scripts/desktop-host-publication-test.mts",
    ),
  );
  assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform: "linux" }));
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "empty-library"], platform: "win32" }),
    /standalone/,
  );
});

void test("selected completion captures and verifies its serialized focus observer source", async (t) => {
  const source = "apps/desktop/scripts/desktop-completion-focus.mts";
  for (const platform of ["win32", "linux"] as const) {
    const plan = planDesktopExecution(
      resolveDesktopSelection({ scenarios: ["native-selected-setup-completion"], platform }),
      { platform },
    );
    assert.equal(
      plan.receiptInputs.filter((input) => input.kind === "file" && input.path === source).length,
      1,
    );
  }
  // Retained custody must stay outside disposable TMP/TEMP roots from dev-storage.
  const parent = path.join(os.homedir(), ".portcove-test-fixtures");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(parent, "portcove-focus-custody-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, source);
  await mkdir(path.dirname(file), { recursive: true });
  const original = await readFile(new URL(`../${source}`, import.meta.url));
  await writeFile(file, original);
  const output = path.join(directory, "output");
  await mkdir(output);
  const inputs = await captureDesktopReceiptInputs({
    root: directory,
    values: { app: process.execPath },
    plan: {
      receiptInputs: [
        { kind: "executable", name: "app" },
        { kind: "file", path: source },
      ],
      selection: { selected_scenarios: ["native-selected-setup-completion"] },
    },
    output,
    revision: "a".repeat(40),
    retainedRoot: path.join(directory, "retained"),
    // Isolate source custody; the native-helper suite checks the full declaration graph.
    validate: async () => [],
  });
  const retained = inputs.map((input) => {
    assert.ok("retained" in input);
    return input;
  });
  await verifyConsumedInputs(retained);
  const changed = Buffer.from(original);
  changed[0] = changed[0] === 65 ? 66 : 65;
  await writeFile(file, changed);
  await assert.rejects(
    verifyConsumedInputs(retained),
    /Live execution input changed after capture/u,
  );
  await writeFile(file, original);
  await verifyConsumedInputs(retained);
});

void test("Linux origin qualification is explicit, standalone and feature scoped", () => {
  const id = "native-linux-webview-origin-boundary";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "linux" });
  const plan = planDesktopExecution(selection, { platform: "linux" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(plan.build.qualificationFeatures, ["native-compatibility-qualification"]);
  assert.deepEqual(plan.build.cliFeatures, []);
  assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform: "win32" }));
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "empty-library"], platform: "linux" }),
    /standalone/,
  );
  for (const profile of ["smoke", "full"]) {
    const ordinary = resolveDesktopSelection({ profile, platform: "linux" });
    assert.ok(!ordinary.selected_scenarios.includes(id));
    assert.ok(
      !planDesktopExecution(ordinary, { platform: "linux" }).build.qualificationFeatures.includes(
        "native-compatibility-qualification",
      ),
    );
  }
});

void test("hash continuation routes only the isolated selected-setup fixture with positive closure", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-saved-folder-hash-resume"],
    platform: "win32",
  });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.deepEqual(selection.setup_scenarios, []);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "saved-folder-hash-resume");
  assert.equal(plan.fixtures.hashResumeJourney, true);
  assert.equal(plan.fixtures.sourceJourney, true);
  assert.equal(plan.fixtures.completionJourney, false);
  assert.equal(plan.fixtures.holdFirstDownload, false);
  assert.deepEqual(familyMembers(plan, "selected-setup"), [
    { id: "native-saved-folder-hash-resume", role: "selected" },
  ]);
  assert.deepEqual(familyMembers(plan, "preparation"), []);
  assert.ok(
    plan.receiptInputs.some(
      (item) => item.path === "apps/desktop/scripts/desktop-source-dialog-test.mts",
    ),
  );
  for (const platform of ["linux", "darwin"] as const)
    assert.throws(
      () => resolveDesktopSelection({ scenarios: ["native-saved-folder-hash-resume"], platform }),
      /requires Windows/,
    );
  assert.throws(
    () =>
      resolveDesktopSelection({
        scenarios: ["native-saved-folder-hash-resume", "native-selected-setup-completion"],
        platform: "win32",
      }),
    /standalone/,
  );
});

void test("execution planning preserves the independently reviewed pre-change oracle", () => {
  assert.equal(baseline.starting_main, "a9e3db4e6cd9fd41111b58705e4fa54790eb57d7");
  assert.equal(baseline.rows.length, 222);
  for (const row of baseline.rows) {
    if (row.selection_error) {
      // Keep the historical rejection bytes intact. #244 now admits only these
      // two exact Linux opt-ins, with the existing fixture and deadline contract.
      const linuxOptIn =
        row.platform === "linux" &&
        row.options.scenarios?.length === 1 &&
        ["native-selected-setup-completion", "native-saved-folder-selected-setup"].includes(
          row.options.scenarios[0] ?? "",
        );
      if (linuxOptIn) {
        const selection = resolveDesktopSelection({
          ...row.options,
          platform: baselinePlatform(row.platform),
        });
        assert.deepEqual(selection.selected_scenarios, row.options.scenarios);
        assert.deepEqual(selection.setup_scenarios, []);
        assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
        const plan = planDesktopExecution(selection, { platform: baselinePlatform(row.platform) });
        assert.ok(plan.build.cliFeatures.includes("portcove-core/qualification-fixtures"));
        continue;
      }
      assert.throws(
        () => resolveDesktopSelection({ ...row.options, platform: baselinePlatform(row.platform) }),
        {
          message:
            row.options.scenarios?.length === 1 &&
            ["native-selected-setup-completion", "native-saved-folder-selected-setup"].includes(
              row.options.scenarios[0] ?? "",
            )
              ? `${row.options.scenarios[0]} requires Windows or Linux`
              : row.selection_error,
        },
      );
      continue;
    }
    assert(
      row.selection &&
        row.harness_admission &&
        row.serialized_verify_plan &&
        row.initial_receipt_inputs,
    );
    const selection = resolveDesktopSelection({
      ...row.options,
      platform: baselinePlatform(row.platform),
    });
    // Preserve the frozen oracle. This new opt-in scenario was absent from its
    // inventory and remains excluded from every historical execution.
    const historicalSelection = <Value extends { excluded_scenarios: readonly string[] }>(
      value: Value,
    ) => ({
      ...value,
      excluded_scenarios: value.excluded_scenarios.filter(
        (id) =>
          ![
            "native-controller-api-fallback",
            "native-linux-webview-origin-boundary",
            "native-preliminary-source-review",
            "native-saved-folder-hash-resume",
            "native-preliminary-selected-setup",
            "native-linux-packaged-webview-boundary",
            "native-direct-preparation-recovery",
            "native-late-listener-disposal",
            "native-host-publication-recovery",
            "native-real-prepared-runtime",
            "native-linux-interrupted-preparation",
            "native-rejected-listener-registration",
            "native-interface-size",
            "native-library-layout",
            "native-update-acquisition-lifecycle",
          ].includes(id),
      ),
    });
    assert.ok(!selection.selected_scenarios.includes("native-preliminary-source-review"));
    assert.ok(selection.excluded_scenarios.includes("native-preliminary-source-review"));
    assert.ok(!selection.selected_scenarios.includes("native-saved-folder-hash-resume"));
    assert.ok(selection.excluded_scenarios.includes("native-saved-folder-hash-resume"));
    assert.ok(!selection.selected_scenarios.includes("native-update-acquisition-lifecycle"));
    assert.ok(selection.excluded_scenarios.includes("native-update-acquisition-lifecycle"));
    assert.deepEqual(historicalSelection(selection), row.selection);
    const plan = planDesktopExecution(selection, { platform: baselinePlatform(row.platform) });
    assert.deepEqual(historicalSelection(plan.selection), row.selection);
    // Frozen oracle retains every historical input. Registry additions and
    // deduplication affect receipt identities only, never dispatch/acceptance.
    const actualInputs = plan.receiptInputs.map((input) =>
      input.kind === "executable" ? executableName(input.name) : receiptFilePath(input),
    );
    for (const historical of row.initial_receipt_inputs)
      assert(actualInputs.includes(historical.replace(/\.mjs$/u, ".mts")), historical);
    for (const added of actualInputs.filter(
      (file) =>
        !row.initial_receipt_inputs.some(
          (historical) => historical.replace(/\.mjs$/u, ".mts") === file,
        ),
    ))
      assert(
        Object.hasOwn(nativeHelperDependencies, added) ||
          nativeHelperSharedSources.includes(added) ||
          nativeTransportReceiptSources.some((source) => source === added) ||
          added === "apps/desktop/scripts/browser-script.mts" ||
          added === "apps/desktop/scripts/browser-readiness.mts" ||
          added === "apps/desktop/scripts/native-enlargement.mts" ||
          (added === "apps/desktop/scripts/desktop-completion-focus.mts" &&
            selection.selected_scenarios.includes("native-selected-setup-completion")) ||
          added === "scripts/native-readiness.mts" ||
          added === "scripts/acceptance-packet.mts" ||
          added === "apps/desktop/scripts/desktop-listener-lifetime-test.mts" ||
          (added === "apps/desktop/scripts/desktop-listener-lifetime-probe.mts" &&
            actualInputs.includes("apps/desktop/scripts/desktop-listener-lifetime-test.mts")) ||
          added === nativeHelperRegistryPath,
        added,
      );
    assert.equal(new Set(actualInputs).size, actualInputs.length);

    if (!row.harness_admission.error) {
      const expectedSession = structuredClone(row.harness_admission);
      // Preserve the historical oracle while requiring positive cleanup for
      // #1168's owned retained-data backup creation journey on Windows.
      if (
        row.platform === "win32" &&
        selection.selected_scenarios.includes("native-reviewed-backup-restore-and-delete")
      ) {
        expectedSession.identityBoundSession = true;
        expectedSession.cleanupName = "backup-review";
      }
      // The retained oracle stays immutable; #244 deliberately adds positive
      // owned exit proof to the completion journey through the existing owner.
      if (selection.selected_scenarios.includes("native-selected-setup-completion")) {
        expectedSession.identityBoundSession = true;
        if (expectedSession.cleanupName === "backup-focus")
          expectedSession.cleanupName = "selected-setup-completion";
      }
      // #1168's retained rollback witness also requires the existing positive
      // exit owner. This intentional delta does not rewrite historical bytes.
      if (
        row.platform === "win32" &&
        selection.selected_scenarios.includes("native-retained-contract-repair-state")
      ) {
        expectedSession.identityBoundSession = true;
        if (expectedSession.cleanupName === "backup-focus")
          expectedSession.cleanupName = "retained-contract-repair";
      }
      // Current-update review uses the same positive Windows exit owner.
      // Keep the historical oracle unchanged and state the intentional delta.
      if (
        row.platform === "win32" &&
        selection.selected_scenarios.includes("native-game-update-review")
      ) {
        expectedSession.identityBoundSession = true;
        if (expectedSession.cleanupName === "backup-focus")
          expectedSession.cleanupName = "game-update-review";
      }
      // Source-reference removal adds positive Windows custody through the existing
      // owner. Preserve the oracle and restore explicit backup-focus name priority.
      if (
        row.platform === "win32" &&
        selection.selected_scenarios.includes("native-reviewed-source-reference-removal")
      ) {
        expectedSession.identityBoundSession = true;
        if (
          expectedSession.cleanupName === "backup-focus" &&
          !selection.selected_scenarios.includes("native-backup-delete-focus")
        )
          expectedSession.cleanupName = "source-reference-removal";
      }
      // Steam batch adds Windows custody without rewriting historical oracle bytes
      // or displacing any existing cleanup name, including explicit backup focus.
      if (
        row.platform === "win32" &&
        selection.selected_scenarios.includes("native-reviewed-steam-batch-add")
      ) {
        expectedSession.identityBoundSession = true;
        if (
          expectedSession.cleanupName === "backup-focus" &&
          !selection.selected_scenarios.includes("native-backup-delete-focus")
        )
          expectedSession.cleanupName = "steam-batch";
      }
      assert.deepEqual(plan.session, expectedSession);
    }
    assert.deepEqual(plan.build.cliFeatures, row.serialized_verify_plan.cli_features);
    assert.deepEqual(
      plan.build.qualificationFeatures,
      row.serialized_verify_plan.qualification_features,
    );
    assert.deepEqual(
      plan.fixtureFamilies.filter((entry) => entry.family).map((entry) => entry.family),
      baseline.dispatch.families.filter(
        (f) => f !== "preparation" || selection.prerequisites.includes("owned-fixture"),
      ),
    );
    assert(Object.isFrozen(plan));
    assert(Object.isFrozen(plan.selection.selected_scenarios));
    if (row.platform === process.platform) {
      const actual = buildDesktopVerifyPlan({
        selection,
        paths: { output_root: "<output>", target_directory: "<target>" },
        drivers: null,
        source: { revision: "<source>" },
        packages: [],
        frontendCommand: undefined,
      });
      const expected = {
        ...structuredClone(row.serialized_verify_plan),
        harness_deadline_ms: desktopHarnessDeadlineMs(selection),
      }; // Deliberately retained pre-change deadline owner.
      // This prerequisite now runs before lease/build; preserve the old oracle.
      Reflect.deleteProperty(actual, "frontend_command");
      // Admission metadata is independently checked by the current runner tests.
      Reflect.deleteProperty(actual, "required_output_resources");
      expected.phases = [
        "workspace-package-preflight",
        "desktop-doctor",
        "frontend-command-preflight",
        ...(expected.phases.includes("scenario-context-preflight")
          ? ["scenario-context-preflight"]
          : []),
        ...(expected.qualification_features.some(
          (feature: string) => feature === "qualification-fixtures",
        )
          ? ["checkpoint-feature-inventory", "checkpoint-feature-tests"]
          : []),
        ...expected.phases.filter(
          (phase) =>
            ![
              "workspace-package-preflight",
              "desktop-doctor",
              "scenario-context-preflight",
            ].includes(phase),
        ),
      ];
      assert.deepEqual(historicalSelection(actual), expected);
    }
  }
});

void test("library browsing receipts bind every confirmation helper exactly once", () => {
  const plan = planDesktopExecution(
    resolveDesktopSelection({
      scenarios: ["native-library-browsing-context"],
      platform: "win32",
    }),
  );
  for (const name of [
    "desktop-native-confirmation.mts",
    "native-confirmation.ps1",
    "native-window-discovery.ps1",
  ])
    assert.equal(
      plan.receiptInputs.filter((input) => input.path === `apps/desktop/scripts/${name}`).length,
      1,
    );
  for (const row of baseline.rows.filter((row) => !row.selection_error)) {
    const inputs = planDesktopExecution(
      resolveDesktopSelection({ ...row.options, platform: baselinePlatform(row.platform) }),
    ).receiptInputs;
    if (inputs.some((input) => input.path === "apps/desktop/scripts/native-confirmation.ps1"))
      assert.equal(
        inputs.filter((input) => input.path === "apps/desktop/scripts/native-window-discovery.ps1")
          .length,
        1,
      );
  }
});

void test("setup-only requirements and membership belong to the execution plan", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-reviewed-installed-game-removal"],
    platform: "win32",
  });
  assert(selection.setup_scenarios.length > 0);
  const plan = planDesktopExecution(selection);
  assert.equal(plan.fixtures.owned, true);
  const preparation = familyMembers(plan, "preparation");
  for (const id of selection.setup_scenarios)
    assert(preparation.some((m) => m.id === id && m.role === "setup"));
  const copy = structuredClone(selection);
  planDesktopExecution(selection);
  assert.deepEqual(selection, copy);
});

void test("selected setup completion requires identity-bound positive exit evidence", () => {
  const completion = planDesktopExecution(
    resolveDesktopSelection({ scenarios: ["native-selected-setup-completion"], platform: "win32" }),
  );
  assert.equal(completion.session.identityBoundSession, true);
  assert.equal(completion.session.cleanupName, "selected-setup-completion");
  assert.equal(desktopHarnessDeadlineMs(completion.selection), 180000);
  const discovery = planDesktopExecution(
    resolveDesktopSelection({
      scenarios: ["native-saved-folder-selected-setup"],
      platform: "win32",
    }),
  );
  assert.equal(discovery.session.identityBoundSession, false);
});

void test("preliminary review is isolated and retains positive cleanup without setup execution", () => {
  const id = "native-preliminary-source-review";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.equal(plan.fixtures.preliminaryJourney, true);
  assert.equal(plan.fixtures.completionJourney, false);
  assert.deepEqual(plan.build.cliFeatures, ["portcove-core/qualification-fixtures"]);
  assert.deepEqual(plan.build.qualificationFeatures, ["qualification-fixtures"]);
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "preliminary-source-review");
  assert.equal(desktopHarnessDeadlineMs(selection), 180000);
  assert.equal(
    plan.receiptInputs.filter((input) => input.path?.endsWith("desktop-source-dialog-test.mts"))
      .length,
    1,
  );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "empty-library"], platform: "win32" }),
    /standalone/,
  );
  assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform: "linux" }), /Windows/);
});

void test("game-update review binds Windows cleanup without first-play or wider deadlines", () => {
  for (const platform of ["win32", "linux"] as const) {
    const selection = resolveDesktopSelection({
      scenarios: ["native-game-update-review"],
      platform,
    });
    const plan = planDesktopExecution(selection, { platform });
    assert.equal(plan.session.identityBoundSession, platform === "win32");
    assert.equal(
      plan.session.cleanupName,
      platform === "win32" ? "game-update-review" : "backup-focus",
    );
    assert.deepEqual(selection.setup_scenarios, []);
    assert.equal(desktopHarnessDeadlineMs(selection), 180000);
  }
});

void test("direct preparation recovery qualification is opt-in with positive identity cleanup", () => {
  const plan = planDesktopExecution(
    resolveDesktopSelection({
      scenarios: ["native-direct-preparation-recovery"],
      platform: "win32",
    }),
  );
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "direct-preparation-recovery");
  assert.ok(
    plan.fixtureFamilies.some(
      (entry) =>
        entry.family === "preparation" &&
        entry.members?.some((member) => member.id === "native-direct-preparation-recovery"),
    ),
  );
  assert.deepEqual(plan.selection.setup_scenarios, []);
  assert.throws(
    () =>
      resolveDesktopSelection({
        scenarios: ["native-direct-preparation-recovery", "empty-library"],
        platform: "win32",
      }),
    /standalone/,
  );
});

for (const id of ["native-late-listener-disposal", "native-rejected-listener-registration"])
  void test(`${id} binds its imported probe and positive final cleanup`, () => {
    const plan = planDesktopExecution(
      resolveDesktopSelection({ scenarios: [id], platform: "win32" }),
    );
    assert.equal(plan.session.identityBoundSession, true);
    assert.equal(
      plan.session.cleanupName,
      id === "native-late-listener-disposal"
        ? "late-listener-disposal"
        : "rejected-listener-registration",
    );
    assert.ok(
      plan.fixtureFamilies.some(
        (entry) =>
          entry.family === "preparation" && entry.members?.some((member) => member.id === id),
      ),
    );
    assert.ok(
      plan.receiptInputs.some(
        (input) => input.path === "apps/desktop/scripts/desktop-listener-lifetime-test.mts",
      ),
    );
    assert.ok(plan.selection.prerequisites.includes("native-dialog"));
    assert.ok(plan.selection.host_resources.includes("native-dialog"));
    if (id === "native-rejected-listener-registration")
      for (const source of ["pnpm-workspace.yaml", "patches/@tauri-apps__api@2.12.4.patch"])
        assert.ok(
          plan.receiptInputs.some((input) => input.kind === "file" && input.path === source),
        );
  });

void test("backup review requires identity-bound Windows cleanup within its lifecycle deadline", () => {
  for (const platform of ["win32", "linux"] as const) {
    const selection = resolveDesktopSelection({
      scenarios: ["native-reviewed-backup-restore-and-delete"],
      platform,
    });
    const plan = planDesktopExecution(selection, { platform });
    assert.equal(plan.session.identityBoundSession, platform === "win32");
    assert.equal(plan.session.cleanupName, platform === "win32" ? "backup-review" : "backup-focus");
    assert.equal(desktopHarnessDeadlineMs(selection), 600000);
  }
});

void test("source-reference removal adds Windows custody without changing builds or setup", () => {
  const id = "native-reviewed-source-reference-removal";
  for (const platform of ["win32", "linux"] as const) {
    const selection = resolveDesktopSelection({ scenarios: [id], platform });
    const plan = planDesktopExecution(selection, { platform });
    assert.deepEqual(selection.selected_scenarios, [id]);
    assert.deepEqual(selection.setup_scenarios, ["native-preparation-review-and-play"]);
    assert.equal(plan.session.identityBoundSession, platform === "win32");
    assert.equal(
      plan.session.cleanupName,
      platform === "win32" ? "source-reference-removal" : "backup-focus",
    );
    assert.deepEqual(plan.build.cliFeatures, []);
    assert.deepEqual(plan.build.qualificationFeatures, []);
    assert.equal(plan.fixtures.owned, true);
    assert.ok(selection.prerequisites.includes("native-dialog"));
    assert.ok(selection.host_resources.includes("native-dialog"));
    assert.equal(desktopHarnessDeadlineMs(selection), 180000);
  }
  for (const [other, cleanupName] of [
    ["native-reviewed-backup-restore-and-delete", "backup-review"],
    ["native-game-update-review", "game-update-review"],
    ["native-retained-contract-repair-state", "retained-contract-repair"],
    ["native-backup-delete-focus", "backup-focus"],
  ] as const) {
    for (const scenarios of [
      [id, other],
      [other, id],
    ]) {
      const plan = planDesktopExecution(resolveDesktopSelection({ scenarios, platform: "win32" }), {
        platform: "win32",
      });
      assert.equal(plan.session.identityBoundSession, true);
      assert.equal(plan.session.cleanupName, cleanupName);
    }
  }
});

void test("Steam batch adds Windows custody without changing builds, setup or cleanup priorities", () => {
  const id = "native-reviewed-steam-batch-add";
  for (const platform of ["win32", "linux"] as const) {
    const selection = resolveDesktopSelection({ scenarios: [id], platform });
    const plan = planDesktopExecution(selection, { platform });
    assert.deepEqual(selection.selected_scenarios, [id]);
    assert.deepEqual(selection.setup_scenarios, []);
    assert.equal(plan.session.identityBoundSession, platform === "win32");
    assert.equal(plan.session.cleanupName, platform === "win32" ? "steam-batch" : "backup-focus");
    assert.deepEqual(plan.build.cliFeatures, []);
    assert.deepEqual(plan.build.qualificationFeatures, ["qualification-fixtures"]);
    assert.equal(plan.fixtures.owned, true);
    assert.equal(plan.fixtures.steam, true);
    assert.deepEqual(selection.prerequisites, [
      "desktop",
      "owned-fixture",
      "native-dialog",
      "steam-fixture",
    ]);
    assert.deepEqual(selection.host_resources, [
      "native-desktop",
      "keyboard-pointer",
      "native-dialog",
    ]);
    assert.equal(desktopHarnessDeadlineMs(selection), 180000);
  }
  for (const [other, cleanupName] of [
    ["native-reviewed-backup-restore-and-delete", "backup-review"],
    ["native-game-update-review", "game-update-review"],
    ["native-retained-contract-repair-state", "retained-contract-repair"],
    ["native-reviewed-source-reference-removal", "source-reference-removal"],
    ["native-backup-delete-focus", "backup-focus"],
  ] as const) {
    for (const scenarios of [
      [id, other],
      [other, id],
    ]) {
      const plan = planDesktopExecution(resolveDesktopSelection({ scenarios, platform: "win32" }), {
        platform: "win32",
      });
      assert.equal(plan.session.identityBoundSession, true);
      assert.equal(plan.session.cleanupName, cleanupName);
    }
  }
});

void test("qualified reviews and a running setup restart reject missing or foreign native identities", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function validateBackupFocusInventory(");
  const end = source.indexOf("function captureBackupFocusCleanup(", start);
  assert(start >= 0 && end > start);
  for (const { scenario, outcome = "passed", requireQualified = false } of [
    { scenario: "native-host-publication-recovery" },
    { scenario: "native-real-prepared-runtime" },
    { scenario: "native-reviewed-backup-restore-and-delete" },
    { scenario: "native-reviewed-source-reference-removal" },
    { scenario: "native-reviewed-steam-batch-add" },
    { scenario: "native-preliminary-source-review" },
    { scenario: "native-late-listener-disposal" },
    { scenario: "native-rejected-listener-registration" },
    { scenario: "native-selected-setup-completion", outcome: "running", requireQualified: true },
  ]) {
    const validate = callable(
      runInNewContext(`${source.slice(start, end)}; validateBackupFocusInventory`, {
        assert,
        path,
        performance,
        executionPlan: { fixtures: { acquisitionJourney: false } },
        savedLibraryRecoverySession: false,
        checks: [{ scenario, outcome }],
        application: "/owned/app.exe",
        nativeDriverPath: "/owned/driver.exe",
      }),
    );
    const entries = [
      { path: "/owned/app.exe" },
      { path: "/owned/driver.exe" },
      { path: "/owned/msedgewebview2.exe" },
    ];
    validate({ processes: entries }, requireQualified);
    for (let missing = 0; missing < entries.length; missing++) {
      assert.throws(() =>
        validate({ processes: entries.filter((_, i) => i !== missing) }, requireQualified),
      );
    }
    assert.throws(() =>
      validate(
        { processes: [{ path: "/foreign/app.exe" }, ...entries.slice(1)] },
        requireQualified,
      ),
    );
    if (
      scenario === "native-reviewed-source-reference-removal" ||
      scenario === "native-reviewed-steam-batch-add"
    ) {
      assert.throws(() =>
        validate({ processes: [entries[0], { path: "/foreign/driver.exe" }, entries[2]] }),
      );
      assert.throws(() => validate({ processes: [...entries, entries[0]] }));
      assert.throws(() => validate({ processes: [...entries, entries[1]] }));
    }
  }
});

void test("retained rollback repair requires identity-bound cleanup without changing its deadline", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-retained-contract-repair-state"],
    platform: "win32",
  });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "retained-contract-repair");
  assert.equal(desktopHarnessDeadlineMs(selection), 180000);
});

void test("retained rollback Linux coverage keeps its existing portable session", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-retained-contract-repair-state"],
    platform: "linux",
  });
  const plan = planDesktopExecution(selection, { platform: "linux" });
  assert.deepEqual(selection.selected_scenarios, ["native-retained-contract-repair-state"]);
  assert.equal(plan.session.identityBoundSession, false);
  assert.equal(plan.session.cleanupName, "backup-focus");
  assert.equal(desktopHarnessDeadlineMs(selection), 180000);
});

void test("coordinator consumes supplied order and obtains browser at each invocation", async () => {
  const plan = planDesktopExecution(
    resolveDesktopSelection({ profile: "full", platform: "win32" }),
  );
  const trace = ["workspaceRefreshScenario", "qualificationHistoryScenario"];
  let browser = "first";
  let confirmationCalls = 0;
  const context = {
    invoke() {},
    scenario() {},
    library: "library",
    output: "output",
    artifacts: [],
    inputs: [],
    installFixture: {},
    restartApplication() {},
    cli: "cli",
    tool: "tool",
    interruptApplication() {},
    closeApplication() {},
    captureLivePreparation() {},
    chooseOwnedLibrary() {},
    chooseGameFileFolder() {},
  };
  const runtime = {
    context: () => ({ ...context, browser }),
    recordKnownGap: (gap: KnownGap) => trace.push("gap:" + gap.scenario),
    confirmNative: () => {
      confirmationCalls++;
      return () => {};
    },
  };
  const journeys: OwnedFixtureJourneys<
    ReturnType<typeof runtime.context>,
    ReturnType<typeof runtime.confirmNative>
  > = {
    install: async (c) => {
      assert.equal(c.browser, "first");
      trace.push("install");
      browser = "replacement";
    },
    selectedSetup: async (c) => {
      assert.equal(c.browser, "replacement");
      trace.push("selected-setup");
    },
    selectedSetupCompletion: async (c) => {
      assert.equal(c.browser, "replacement");
      assert.equal(c.restartApplication, context.restartApplication);
      assert.equal(c.chooseGameFileFolder, context.chooseGameFileFolder);
      trace.push("selected-setup-completion");
    },
    preparation: async (c) => {
      assert.equal(c.browser, "replacement");
      assert.equal(c.cli, "cli");
      assert.equal(c.tool, "tool");
      assert.equal(c.chooseOwnedLibrary, context.chooseOwnedLibrary);
      trace.push("preparation");
    },
  };
  await runOwnedFixtureJourneys({ plan, runtime }, journeys);
  trace.push("native-repeated-library-reload");
  assert.deepEqual(trace, [
    baseline.dispatch.before.split(" then ")[0],
    baseline.dispatch.before.split(" then ")[1],
    ...baseline.dispatch.families,
    baseline.dispatch.after,
  ]);
  assert.equal(confirmationCalls, 1);
  // A supplied order must be consumed verbatim, never recreated from selection.
  const reversed = { fixtureFamilies: [...plan.fixtureFamilies].reverse() };
  const reversedTrace: string[] = [];
  const dispatch = (name: keyof typeof journeys) => async () => reversedTrace.push(name);
  const handlers = {
    install: dispatch("install"),
    selectedSetup: dispatch("selectedSetup"),
    selectedSetupCompletion: dispatch("selectedSetupCompletion"),
    preparation: dispatch("preparation"),
  };
  await runOwnedFixtureJourneys({ plan: reversed, runtime }, handlers);
  assert.deepEqual(reversedTrace, [
    "preparation",
    "selectedSetupCompletion",
    "selectedSetup",
    "install",
  ]);
});

void test("coordinator preserves gap position and leaves attempt attribution to its caller", async () => {
  const selection = resolveDesktopSelection({ scenarios: ["empty-library"], platform: "win32" });
  const plan = planDesktopExecution(selection);
  const calls: ({ id: string; action: () => unknown } | KnownGap)[] = [];
  const runtime = {
    context: () => ({
      scenario: (id: string, action: () => unknown) => calls.push({ id, action }),
    }),
    confirmNative: () => assert.fail("No preparation consent"),
    recordKnownGap: (gap: KnownGap) => calls.push(gap),
  };
  const journeys: OwnedFixtureJourneys<
    ReturnType<typeof runtime.context>,
    ReturnType<typeof runtime.confirmNative>
  > = {
    install: async (c) =>
      c.scenario("install-progress-cancellation", () =>
        assert.fail("Attempt owner must gate this"),
      ),
    selectedSetup: async () => {},
    selectedSetupCompletion: async () => {},
    preparation: async () => assert.fail("No owned prerequisite"),
  };
  await runOwnedFixtureJourneys({ plan, runtime }, journeys);
  const first = calls[0];
  assert(first && "id" in first);
  assert.equal(first.id, "install-progress-cancellation");
  await assert.rejects(
    runOwnedFixtureJourneys(
      { plan: { fixtureFamilies: [{ family: "unknown" }] }, runtime },
      journeys,
    ),
    /Unknown owned fixture family/,
  );
});

void test("harness hashes preserved inputs and the current planner/coordinator bytes", async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const selection = resolveDesktopSelection({ profile: "smoke", platform: process.platform });
  const values = Object.fromEntries(
    Object.keys(executableNames).map((name) => [name, process.execPath]),
  );
  const output = await mkdtemp(path.join(os.tmpdir(), "pcv-harness-inputs-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const { inputs } = await observeDesktopHarnessInputs({
    custody: null,
    capture: {
      root,
      values: { ...values, app: process.execPath },
      plan: planDesktopExecution(selection),
      output,
      revision: "a".repeat(40),
    },
  });
  const expectedFiles = planDesktopExecution(selection).receiptInputs.map((input) =>
    input.kind === "file" ? path.join(root, input.path) : process.execPath,
  );
  expectedFiles.push(
    ...[
      "scripts/desktop-execution-plan.mts",
      "apps/desktop/scripts/desktop-owned-fixture-journeys.mts",
      "apps/desktop/scripts/desktop-owned-ipc-probe.mts",
    ].map((file: string) => path.join(root, file)),
  );
  assert(Array.isArray(inputs));
  const capturedInputs: unknown[] = inputs;
  assert.equal(capturedInputs.length, expectedFiles.length);
  for (const [index, file] of expectedFiles.entries())
    assert.deepEqual(capturedInputs[index], await fileIdentity(file));
});

void test("preliminary selected setup is standalone, identity-bound and excluded from historical runs", () => {
  const id = "native-preliminary-selected-setup";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.equal(plan.fixtures.preliminaryJourney, true);
  assert.equal(plan.fixtures.preliminarySetupJourney, true);
  assert.equal(plan.fixtures.sourceJourney, true);
  assert.equal(plan.fixtures.completionJourney, false);
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(plan.session.cleanupName, "preliminary-selected-setup");
  assert.equal(desktopHarnessDeadlineMs(selection), 180000);
  assert.equal(
    plan.receiptInputs.filter((input) => input.path?.endsWith("desktop-source-dialog-test.mts"))
      .length,
    1,
  );
  assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform: "linux" }), /Windows/);
  assert.throws(
    () =>
      resolveDesktopSelection({
        scenarios: [id, "native-preliminary-source-review"],
        platform: "win32",
      }),
    /standalone/,
  );
});

function baselinePlatform(value: string): NodeJS.Platform {
  if (value === "win32" || value === "linux" || value === "darwin") return value;
  assert.fail(`Unexpected baseline platform ${value}`);
}
function executableName(name: string) {
  const entry = Object.entries(executableNames).find(([key]) => key === name);
  assert(entry);
  return entry[1];
}
function familyMembers(plan: ReturnType<typeof planDesktopExecution>, family: string) {
  const entry = plan.fixtureFamilies.find((item) => item.family === family);
  assert(entry?.members);
  return entry.members;
}
function callable(value: unknown) {
  assert(typeof value === "function");
  return (...args: unknown[]): unknown => Reflect.apply(value, undefined, args);
}

function receiptFilePath(input: import("./native-helper-dependencies.mts").ReceiptInput) {
  assert(input.kind === "file");
  return input.path;
}

void test("main journey dispatch permits smoke without setup inputs but rejects selected missing inputs", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const selectedFixtureFamilies =");
  const end = source.indexOf(
    '    if (selection.selected_scenarios.includes("native-repeated-library-reload"))',
    start,
  );
  assert.ok(start >= 0 && end > start, "read the production dispatch and input guards");
  const run = async (selection: DesktopSelection) => {
    const executionPlan = planDesktopExecution(selection);
    const noop = async () => {};
    const calls: string[] = [];
    await runInNewContext(`(async()=>{${source.slice(start, end)}})()`, {
      runOwnedFixtureJourneys,
      executionPlan,
      driverBrowser: () => ({}),
      invoke: noop,
      scenario: noop,
      library: "owned-library",
      output: "owned-output",
      artifacts: [],
      inputs: [],
      installFixture: {},
      restartApplication: noop,
      values: {},
      interruptApplication: noop,
      closeApplication: noop,
      captureLivePreparation: noop,
      process: { platform: "win32" },
      nativeGameFileFolderPicker: () => undefined,
      application: "inert.exe",
      ownedSession: {},
      nativeConfirmation: () => undefined,
      checks: [],
      required: (value: unknown) => {
        assert.ok(value !== null && value !== undefined, "Required scenario input missing");
        return value;
      },
      installScenarios: async () => {
        calls.push("install");
      },
      selectedSetupScenario: () => assert.fail("Selected setup must validate missing CLI first"),
      selectedSetupCompletionScenario: () =>
        assert.fail("Selected completion must validate missing CLI first"),
      preparationScenarios: () =>
        assert.fail("Selected preparation must validate missing CLI first"),
    });
    return calls;
  };
  assert.deepEqual(await run(resolveDesktopSelection({ profile: "smoke", platform: "win32" })), [
    "install",
  ]);
  for (const id of [
    "native-saved-folder-selected-setup",
    "native-selected-setup-completion",
    "native-preparation-review-and-play",
  ])
    await assert.rejects(
      run(resolveDesktopSelection({ scenarios: [id], platform: "win32" })),
      /Required scenario input missing/,
    );
});

void test("Linux interruption is standalone, production-featured and retains namespace source custody", () => {
  const id = "native-linux-interrupted-preparation";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "linux" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  const plan = planDesktopExecution(selection, { platform: "linux" });
  assert.deepEqual(plan.build.qualificationFeatures, []);
  assert.deepEqual(plan.build.cliFeatures, []);
  for (const name of ["desktop-linux-native-session.mts", "native-linux-init.mts"])
    assert.ok(plan.receiptInputs.some((input) => input.path === `apps/desktop/scripts/${name}`));
  assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform: "win32" }), /Linux/);
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "empty-library"], platform: "linux" }),
    /standalone/,
  );
  for (const profile of ["smoke", "full"])
    assert.ok(
      !resolveDesktopSelection({ profile, platform: "linux" }).selected_scenarios.includes(id),
    );
});

void test("publication repeat callback requires the complete owned native quiescence join", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function restartApplication(");
  const end = source.indexOf("// Interrupt only this harness", start);
  assert.ok(start >= 0 && end > start);
  for (const acquisition of [false, true])
    for (const refusesExit of [false, true]) {
      const events: string[] = [];
      const exitFailure = new Error("owned native inventory has not fully exited");
      const restart = callable(
        runInNewContext(`${source.slice(start, end)}; restartApplication`, {
          linuxSelectedSession: false,
          savedLibraryRecoverySession: false,
          cleanupName: "host-publication",
          hostPublicationSession: !acquisition,
          executionPlan: { fixtures: { acquisitionJourney: acquisition } },
          preferencesRecoverySession: false,
          assert,
          required: (value: unknown) => value,
          output: "/owned/output",
          path,
          artifacts: [],
          browser: {
            quit: async () => {
              events.push("quit");
            },
          },
          captureBackupFocusCleanup: () => {
            events.push("capture");
            return "/owned/inventory.json";
          },
          readFile: async () => "{}",
          readNativeProcessSnapshot: (value: unknown) => value,
          validateBackupFocusInventory: () => {
            events.push("validate");
          },
          stopBackupFocusDriver: () => {
            events.push("stop");
          },
          ownedSession: {
            requireQuiescence: () => {
              events.push("join");
              if (refusesExit) throw exitFailure;
              return {};
            },
          },
          startDriver: async () => {
            events.push("start");
          },
          connect: async () => {
            events.push("connect");
          },
          driverBrowser: () => ({}),
          writeFile: async () => {},
        }),
      );
      const execute = async () =>
        restart(acquisition ? "acquisition-2.0.0" : "published-move-repeat", async () => {
          events.push("callback");
        });
      if (refusesExit) {
        await assert.rejects(execute(), (error) => error === exitFailure);
        assert.deepEqual(events, ["capture", "validate", "quit", "stop", "join"]);
      } else {
        await execute();
        assert.deepEqual(events, [
          "capture",
          "validate",
          "quit",
          "stop",
          "join",
          "callback",
          "start",
          "connect",
        ]);
      }
    }
});

void test("publication redirected backup containment accepts Windows path aliases and rejects escapes", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-host-publication-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("    move.result.redirected_write = redirectedWrite;");
  const end = source.indexOf("    await assertIdentity(newer);", start);
  assert.ok(start >= 0 && end > start);
  const guard = source.slice(start, end);
  const destination = String.raw`E:\owned\published-move-destination`;
  const child = path.win32.join(destination, "backups", "port", "backup-id");
  const run = async (root: string, candidate: string, canonicalCandidate = candidate) => {
    const observations: string[] = [];
    const move = { result: {} };
    await runInNewContext(`(async()=>{${guard}})()`, {
      assert,
      path: path.win32,
      destination: root,
      redirectedWrite: { path: candidate },
      move,
      realpath: async (value: string) => {
        observations.push(value);
        return value === root ? root : canonicalCandidate;
      },
    });
    assert.deepEqual(observations, [root, candidate]);
    return move;
  };
  for (const root of [destination, path.win32.toNamespacedPath(destination)]) {
    for (const candidate of [child, path.win32.toNamespacedPath(child)]) await run(root, candidate);
    for (const candidate of [
      destination,
      String.raw`E:\owned\published-move-destination-other\backup`,
      String.raw`E:\owned\outside\backup`,
      String.raw`H:\outside\backup`,
    ]) {
      for (const value of [candidate, path.win32.toNamespacedPath(candidate)])
        await assert.rejects(run(root, value));
    }
    await assert.rejects(run(root, child, String.raw`H:\outside\backup`));
  }
});

void test("publication import readback derives the expected payload from physical Windows aliases", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-host-publication-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("    const exportedRelative = path.relative(");
  const end = source.indexOf("    await writeFile(importedSave,", start);
  assert.ok(start >= 0 && end > start);
  const guard = source.slice(start, end);
  const destination = String.raw`E:\owned\published-move-destination`;
  const importRoot = String.raw`E:\owned\published-import-destination`;
  const suffix = path.win32.join("versions", "port", "payload");
  const child = path.win32.join(destination, suffix);
  const imported = path.win32.toNamespacedPath(path.win32.join(importRoot, suffix));
  const run = async (exported: string, actual = imported) =>
    runInNewContext(`(async()=>{${guard}})()`, {
      assert,
      path: path.win32,
      destination,
      importRoot,
      exportedInstallation: { path: exported },
      importedInstallation: { path: actual },
      realpath: async (value: string) => value,
      samePath: (a: string, b: string) =>
        path.win32.toNamespacedPath(a).toLowerCase() ===
        path.win32.toNamespacedPath(b).toLowerCase(),
    });
  await run(child);
  await run(path.win32.toNamespacedPath(child));
  for (const escaped of [
    destination,
    String.raw`E:\owned\published-move-destination-other\payload`,
    String.raw`H:\outside\payload`,
  ])
    await assert.rejects(run(escaped));
  await assert.rejects(run(child, String.raw`E:\owned\wrong-import\payload`));
});

void test("native enlargement observations bind their statically imported helper exactly once", () => {
  const helper = "apps/desktop/scripts/native-enlargement.mts";
  for (const platform of ["win32", "linux", "darwin"] as const)
    for (const profile of ["smoke", "presentation", "full"])
      assert.equal(
        planDesktopExecution(resolveDesktopSelection({ platform, profile }), {
          platform,
        }).receiptInputs.filter((input) => input.kind === "file" && input.path === helper).length,
        1,
        platform + "/" + profile,
      );
});

void test("listener callback bytes follow their owning scenario source exactly once", () => {
  const parent = "apps/desktop/scripts/desktop-listener-lifetime-test.mts";
  const helper = "apps/desktop/scripts/desktop-listener-lifetime-probe.mts";
  for (const platform of ["win32", "linux", "darwin"] as const)
    for (const options of [
      { profile: "smoke" },
      { profile: "presentation" },
      { profile: "full" },
      { scenarios: ["native-late-listener-disposal"] },
      { scenarios: ["native-rejected-listener-registration"] },
    ]) {
      if ("scenarios" in options && platform !== "win32") {
        assert.throws(
          () => resolveDesktopSelection({ ...options, platform }),
          /Operation listener qualification requires one standalone Windows scenario/u,
        );
        continue;
      }
      const inputs = planDesktopExecution(resolveDesktopSelection({ ...options, platform }), {
        platform,
      }).receiptInputs;
      const parentIndex = inputs.findIndex(
        (input) => input.kind === "file" && input.path === parent,
      );
      const helpers = inputs.filter((input) => input.kind === "file" && input.path === helper);
      assert.equal(helpers.length, parentIndex < 0 ? 0 : 1);
      if (parentIndex >= 0) assert.equal(inputs[parentIndex + 1]?.path, helper);
    }
});

void test("acquisition qualification is isolated, builds the owned probe and passes real native authority only to its install journey", async () => {
  for (const platform of ["linux", "darwin"] as const)
    assert.throws(
      () =>
        resolveDesktopSelection({ scenarios: ["native-update-acquisition-lifecycle"], platform }),
      /standalone Windows/,
    );
  assert.throws(
    () =>
      resolveDesktopSelection({
        scenarios: ["native-update-acquisition-lifecycle", "keyboard-layout"],
        platform: "win32",
      }),
    /standalone Windows/,
  );
  const selection = resolveDesktopSelection({
    scenarios: ["native-update-acquisition-lifecycle"],
    platform: "win32",
  });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.deepEqual(selection.setup_scenarios, ["install-commit-refresh-recovery"]);
  assert.equal(plan.fixtures.acquisitionJourney, true);
  assert.equal(plan.fixtures.install, true);
  assert.equal(plan.fixtures.owned, true);
  assert.equal(plan.fixtures.completionJourney, false);
  assert.equal(plan.session.identityBoundSession, true);
  assert.equal(desktopHarnessDeadlineMs(selection), 720_000);
  assert.ok(
    plan.receiptInputs.some(
      (input) =>
        input.kind === "file" &&
        input.path === "crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
    ),
  );
  const marker = { capture() {}, observe() {} };
  const confirm = () => {};
  let called = false;
  await runOwnedFixtureJourneys(
    {
      plan,
      runtime: {
        context: () => ({
          browser: "owned",
          invoke() {},
          scenario() {},
          library: "owned-library",
          output: "owned-output",
          artifacts: [],
          inputs: [],
          installFixture: {},
          restartApplication() {},
          ownedGameProcess: marker,
        }),
        confirmNative: () => confirm,
        recordKnownGap: () =>
          assert.fail("No acceptance gaps may be substituted for this scenario"),
      },
    },
    {
      install: async (context) => {
        called = true;
        assert.equal(context.ownedGameProcess, marker);
        assert.equal(context.confirmNative, confirm);
      },
      selectedSetup: async () => {},
      selectedSetupCompletion: async () => {},
      preparation: async () => {},
    },
  );
  assert.equal(called, true);
});
