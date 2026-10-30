import { LinuxLaunchPublication } from "../apps/desktop/scripts/desktop-linux-native-session.mts";
import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runTypeScriptInNewContext as runInNewContext } from "./test-source.mts";
import { planDesktopExecution } from "./desktop-execution-plan.mts";
import { resolveDesktopSelection } from "./desktop-scenarios.mts";

const source = await readFile(
  new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
  "utf8",
);
const between = (start: string, end: string) => {
  const first = source.indexOf(start),
    last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
};

void test("Linux cover restart joins exact captured processes before fixture mutation or replacement", async () => {
  const plan = planDesktopExecution(
    resolveDesktopSelection({
      platform: "linux",
      scenarios: ["native-default-cover-cache-conditions"],
    }),
    { platform: "linux" },
  );
  assert.equal(plan.session.historySession, true);
  assert.equal(
    plan.receiptInputs.filter(
      (input) =>
        input.kind === "file" &&
        input.path === "apps/desktop/scripts/desktop-qualification-history-test.mts",
    ).length,
    1,
  );
  const restart = between("async function restartApplication(", "// Interrupt only this harness");
  for (const failure of [false, true]) {
    const calls: string[] = [];
    const inventory = { driver: { start_ticks: "7" }, processes: [{ pid: 23, start_ticks: "7" }] };
    const context = {
      process: { platform: "linux" },
      linuxSelectedSession: false,
      historySession: true,
      driver: { pid: 23 },
      driverPath: "/owned/driver",
      application: "/owned/app",
      historyInventory: inventory,
      browser: {
        quit: async () => {
          calls.push("quit");
        },
      },
      captureHistorySession: async () => {
        calls.push("capture");
        return inventory;
      },
      stopDriver: async () => {
        calls.push("stop");
      },
      waitHistorySessionExit: async () => {
        calls.push("join");
        if (failure) throw new Error("exit unknown");
        return { all_exited: true };
      },
      writeFile: async () => {
        calls.push("receipt");
      },
      artifacts: [],
      output: "/owned",
      startDriver: async (environment: unknown) => {
        assert.deepEqual(environment, { HTTPS_PROXY: "owned-refusal" });
        calls.push("start");
      },
      connect: async () => {
        calls.push("connect");
      },
      driverBrowser: () => "fresh-browser",
      assert,
      required: <T,>(value: T) => {
        assert.ok(value);
        return value;
      },
      path,
    };
    runInNewContext(`${restart}\nglobalThis.restart=restartApplication;`, context);
    const fn: unknown = Reflect.get(context, "restart");
    assert.ok(typeof fn === "function");
    const invoke = () =>
      Promise.resolve(
        Reflect.apply(fn, undefined, [
          "offline",
          async () => {
            calls.push("mutate");
          },
          { HTTPS_PROXY: "owned-refusal" },
        ]),
      );
    if (failure) {
      await assert.rejects(invoke(), /exit unknown/);
      assert.deepEqual(calls, ["capture", "quit", "stop", "join"]);
    } else {
      assert.equal(await invoke(), "fresh-browser");
      assert.deepEqual(calls, [
        "capture",
        "quit",
        "stop",
        "join",
        "receipt",
        "mutate",
        "start",
        "connect",
      ]);
    }
  }
});
async function fixture(options: { publicationError?: unknown; joinError?: unknown } = {}) {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const calls: {
    stops: number;
    writes: { file: string; bytes: string; options: { flag: string } }[];
  } = { stops: 0, writes: [] };
  const launch = () => ({
    receipt: { nonce: "owned" },
    stop: async () => {
      calls.stops++;
      await gate;
      if (Object.hasOwn(options, "joinError")) throw options.joinError;
      return { quiesced: true, nonce: `launch-${calls.stops}` };
    },
  });
  const artifacts: string[] = [];
  let committed = 0;
  const owner = new LinuxLaunchPublication({
    output: "/owned",
    artifacts,
    write: async (file, bytes, writeOptions) => {
      calls.writes.push({ file, bytes, options: writeOptions });
      if (Object.hasOwn(options, "publicationError")) throw options.publicationError;
    },
    committed: () => {
      committed++;
    },
  });
  await owner.start(async () => launch());
  return {
    owner,
    calls,
    artifacts,
    release,
    committed: () => committed,
    stopDriver: () => owner.stop(),
    startDriver: () => owner.start(async () => launch()),
  };
}

void test("watchdog and final Linux cleanup share one join publication and subsequent launches stay independent", async () => {
  const { owner, calls, release, stopDriver, startDriver } = await fixture();
  const first = stopDriver(),
    second = stopDriver();
  await assert.rejects(startDriver(), /previous Linux launch/u);
  assert.equal(calls.stops, 1);
  assert.equal(calls.writes.length, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(calls.writes.length, 1);
  assert.equal(required(calls.writes[0]).options.flag, "wx");
  assert.equal(
    required(calls.writes[0]).file,
    path.join("/owned", "linux-native-launch-1-join.json"),
  );
  assert.equal(owner.launch, undefined);
  assert.equal(object(owner.cleanup).quiesced, true);
  await startDriver();
  await Promise.all([stopDriver(), stopDriver()]);
  assert.equal(calls.stops, 2);
  assert.equal(calls.writes.length, 2);
  assert.equal(
    required(calls.writes[1]).file,
    path.join("/owned", "linux-native-launch-2-join.json"),
  );
});

for (const kind of ["publicationError", "joinError"] as const) {
  void test(`Linux cleanup shares ${kind} rejection and retains active custody`, async () => {
    for (const failure of [new Error(kind), undefined, null, false, 0, ""]) {
      const { owner, calls, artifacts, release, stopDriver } = await fixture({ [kind]: failure });
      const active = owner.launch;
      const first = stopDriver(),
        second = stopDriver();
      release();
      const results = await Promise.allSettled([first, second]);
      assert.ok(
        results.every((result) => result.status === "rejected" && result.reason === failure),
      );
      assert.equal(calls.stops, 1);
      assert.equal(calls.writes.length, kind === "publicationError" ? 1 : 0);
      assert.equal(owner.launch, active);
      assert.equal(owner.cleanup, undefined);
      assert.deepEqual(artifacts, []);
      await assert.rejects(stopDriver(), (error) => error === failure);
      assert.equal(calls.stops, 1);
    }
  });
}

void test("Linux launch ordinals advance before factories, including rejected startup", async () => {
  const { owner, release } = await fixture();
  const active = owner.launch;
  await assert.rejects(
    owner.start(async () => {
      assert.fail("Active custody must refuse factory");
    }),
    /previous Linux launch/,
  );
  assert.equal(owner.launch, active);
  assert.equal(owner.ordinal, 1);
  release();
  await owner.stop();
  const failure = new Error("factory failed");
  await assert.rejects(
    owner.start(async () => {
      assert.equal(owner.ordinal, 2);
      assert.equal(owner.cleanup, undefined);
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(owner.launch, undefined);
  await owner.start(async () => ({ receipt: {}, stop: async () => ({ quiesced: true }) }));
  assert.equal(owner.ordinal, 3);
  await owner.stop();
});

void test("Linux publication commits only after exclusive writes and before media validation", async () => {
  for (const failureAt of ["none", "before", "after"] as const) {
    const writeGate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const failure = new Error(failureAt);
    const artifacts: string[] = [];
    let driver: unknown = {};
    const owner: LinuxLaunchPublication<
      { quiesced: boolean },
      { receipt: unknown; stop(): Promise<{ quiesced: boolean }> },
      string
    > = new LinuxLaunchPublication({
      output: "/owned",
      artifacts,
      write: async (_file, bytes, options) => {
        calls.push("write");
        assert.deepEqual(JSON.parse(bytes), { quiesced: true });
        assert.equal(options.flag, "wx");
        await writeGate.promise;
      },
      beforeCommit: async (_cleanup, evidence) => {
        calls.push("before");
        assert.deepEqual(artifacts, [evidence]);
        assert.ok(owner.launch);
        assert.equal(owner.cleanup, undefined);
        assert.ok(driver);
        if (failureAt === "before") throw failure;
        return "media-observation";
      },
      committed: () => {
        calls.push("commit");
        driver = undefined;
      },
      afterCommit: async (cleanup, extra) => {
        calls.push("after");
        assert.equal(owner.cleanup, cleanup);
        assert.equal(owner.launch, undefined);
        assert.equal(driver, undefined);
        assert.equal(extra, "media-observation");
        if (failureAt === "after") throw failure;
      },
    });
    await owner.start(async () => ({ receipt: {}, stop: async () => ({ quiesced: true }) }));
    const pending = owner.stop();
    await Promise.resolve();
    assert.deepEqual(calls, ["write"]);
    assert.ok(owner.launch);
    assert.equal(owner.cleanup, undefined);
    assert.deepEqual(artifacts, []);
    writeGate.resolve();
    if (failureAt === "none") await pending;
    else await assert.rejects(pending, (error) => error === failure);
    if (failureAt === "before") {
      assert.deepEqual(calls, ["write", "before"]);
      assert.ok(driver);
      await assert.rejects(owner.stop(), (error) => error === failure);
    } else {
      assert.deepEqual(calls, ["write", "before", "commit", "after"]);
      await owner.stop(); // Committed launches are no-ops even after media rejection.
    }
    assert.equal(calls.filter((call) => call === "write").length, 1);
  }
});

void test("Linux interrupted restart refuses invalid selection, staging, preparation and nonpositive join", async () => {
  for (const failureAt of [
    "selection",
    "sibling",
    "root",
    "preparing",
    "join",
    "receipt",
  ] as const) {
    const calls: string[] = [];
    const failure = new Error(failureAt);
    const owner = new LinuxLaunchPublication({
      output: "/owned",
      artifacts: [],
      write: async (file) => {
        calls.push(file.endsWith("-restart.json") ? "receipt" : "join-receipt");
        if (file.endsWith("-restart.json") && failureAt === "receipt") throw failure;
      },
      committed: () => {
        calls.push("commit");
      },
    });
    await owner.start(async () => ({
      receipt: {},
      stop: async () => {
        calls.push("join");
        return { quiesced: failureAt !== "join" };
      },
    }));
    const invoke = () =>
      owner.interruptPreparation({
        name: "preparation",
        library: "/owned/library",
        preparationExecutable:
          failureAt === "sibling"
            ? "/owned/library/staging-other/setup"
            : failureAt === "root"
              ? "/owned/library/staging"
              : "/owned/library/staging/op/setup",
        selectedScenarios:
          failureAt === "selection"
            ? ["native-linux-interrupted-preparation", "other"]
            : ["native-linux-interrupted-preparation"],
        assertStillPreparing: async () => {
          calls.push("preparing");
          if (failureAt === "preparing") throw failure;
        },
        invalidateBrowser: () => {
          calls.push("invalidate");
        },
        start: async () => {
          calls.push("start");
        },
        connect: async () => {
          calls.push("connect");
        },
        browser: () => {
          calls.push("browser");
          return {};
        },
      });
    if (failureAt === "preparing" || failureAt === "receipt")
      await assert.rejects(invoke(), (error) => error === failure);
    else await assert.rejects(invoke(), { code: "ERR_ASSERTION" });
    assert.ok(!calls.includes("start") && !calls.includes("connect") && !calls.includes("browser"));
    if (["selection", "sibling", "root"].includes(failureAt)) assert.deepEqual(calls, []);
    if (failureAt === "preparing") assert.deepEqual(calls, ["preparing"]);
    if (failureAt === "join")
      assert.deepEqual(calls, ["preparing", "invalidate", "join", "join-receipt", "commit"]);
  }
});

function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
function object(value: unknown) {
  assert.ok(isRecord(value));
  return value;
}
function callable(value: unknown) {
  assert.ok(typeof value === "function");
  return (): Promise<unknown> => {
    const result: unknown = Reflect.apply(value, undefined, []);
    return Promise.resolve(result);
  };
}

void test("forced Linux recovery invalidates the session and requires positive join before fresh startup", async () => {
  for (const failure of [false, true]) {
    const calls: string[] = [];
    const artifacts: string[] = [];
    let browser: unknown = {
      quit() {
        throw new Error("Graceful session deletion is forbidden");
      },
    };
    const owner = new LinuxLaunchPublication({
      output: "/owned",
      artifacts,
      write: async (file, bytes, options) => {
        assert.equal(options.flag, "wx");
        assert.ok(bytes.endsWith("\n"));
        if (file.endsWith("-restart.json")) {
          calls.push("receipt");
          assert.deepEqual(object(JSON.parse(bytes)).launch_receipt, { nonce: "owned" });
        }
      },
      committed: () => {},
    });
    await owner.start(async () => ({
      receipt: { nonce: "owned" },
      stop: async () => {
        assert.equal(browser, undefined);
        calls.push("join");
        if (failure) throw new Error("join failed");
        return { quiesced: true };
      },
    }));
    const invoke = () =>
      owner.interruptPreparation({
        name: "preparation",
        preparationExecutable: "/owned/library/staging/operation/payload/setup",
        library: "/owned/library",
        selectedScenarios: ["native-linux-interrupted-preparation"],
        assertStillPreparing: async () => {
          calls.push("preparing");
        },
        invalidateBrowser: () => {
          browser = undefined;
        },
        start: async () => {
          calls.push("start");
        },
        connect: async () => {
          calls.push("connect");
        },
        browser: () => "fresh-browser",
      });
    if (failure) {
      await assert.rejects(invoke(), /join failed/);
      assert.deepEqual(calls, ["preparing", "join"]);
      assert.deepEqual(artifacts, []);
    } else {
      assert.equal(await invoke(), "fresh-browser");
      assert.deepEqual(calls, ["preparing", "join", "receipt", "start", "connect"]);
      assert.deepEqual(artifacts, [
        path.join("/owned", "linux-native-launch-1-join.json"),
        path.join("/owned", "preparation-restart.json"),
      ]);
    }
  }
});

void test("history exit distinguishes exact terminal identities from reaping, live states and uncertainty", async () => {
  const historySource = await readFile(
    new URL("../apps/desktop/scripts/desktop-qualification-history-test.mts", import.meta.url),
    "utf8",
  );
  const start = historySource.indexOf("export async function waitHistorySessionExit(");
  const end = historySource.indexOf("// The repository-level", start);
  assert.ok(start >= 0 && end > start);
  const waitSource = historySource.slice(start, end).replace("export ", "");
  const captured = {
    pid: 41,
    parent: 1,
    group: 41,
    start_ticks: "100",
    state: "S",
    executable: "/owned/application",
  };
  const zombie = { ...captured, state: "Z", executable: null };
  const other = { ...captured, pid: 42 };
  const readError = new Error("procfs identity unreadable");
  for (const observation of [
    "zombie",
    "absent",
    "reused",
    "all-absent",
    "all-reused",
    "live",
    "unknown",
    "read-error",
    "wrong-pid",
  ]) {
    let elapsed = 0;
    const context = {
      assert,
      Date: class extends Date {
        static override now() {
          return elapsed;
        }
      },
      setTimeout: (callback: () => void) => {
        elapsed += 1000;
        callback();
      },
      readHistoryProcess: async (pid: number) => {
        if (observation === "read-error") throw readError;
        if (observation === "all-absent") return null;
        if (observation === "all-reused") return { ...other, pid, state: "Z", start_ticks: "101" };
        if (pid === captured.pid) return zombie;
        if (observation === "absent") return null;
        if (observation === "reused") return { ...other, state: "Z", start_ticks: "101" };
        if (observation === "wrong-pid") return { ...zombie, pid: 99 };
        return {
          ...other,
          state: observation === "zombie" ? "Z" : observation === "unknown" ? "?" : "R",
          executable: null,
        };
      },
    };
    runInNewContext(`${waitSource}\nglobalThis.wait = waitHistorySessionExit;`, context);
    const wait: unknown = Reflect.get(context, "wait");
    assert.ok(typeof wait === "function");
    const invoke = () =>
      Promise.resolve(Reflect.apply(wait, undefined, [{ processes: [captured, other] }]));
    if (["live", "unknown"].includes(observation)) {
      await assert.rejects(invoke(), /did not exit within 5 seconds: 42/);
    } else if (observation === "read-error") {
      await assert.rejects(invoke(), (error) => error === readError);
    } else if (observation === "wrong-pid") {
      await assert.rejects(invoke(), /Expected values to be strictly equal/);
    } else {
      const result = object(await invoke());
      assert.equal(result.all_exited, true);
      assert.equal(result.all_reaped, observation.startsWith("all-"));
      assert.deepEqual(
        JSON.parse(JSON.stringify(result.unreaped_terminal)),
        observation.startsWith("all-")
          ? []
          : observation === "zombie"
            ? [
                { captured, observed: zombie },
                { captured: other, observed: { ...other, state: "Z", executable: null } },
              ]
            : [{ captured, observed: zombie }],
      );
    }
  }
});

void test("connection readiness polls scalar DOM state through rerenders with unchanged roots and budgets", async () => {
  const connectSource = between(
    "async function connect() {",
    "async function requestApplicationShutdown(",
  );
  for (const kind of [
    "ordinary",
    "bootstrap-first",
    "preferences-first",
    "bootstrap-reconnected",
    "design-fixture",
  ]) {
    const expectedRoot = kind.endsWith("-first")
      ? ".bootstrap-error"
      : kind === "design-fixture"
        ? ".design-compatibility-fixture"
        : 'nav[aria-label="Primary navigation"]';
    const queries: string[] = [];
    const budgets: number[] = [];
    const counts = new Map<string, number>();
    const browser = {
      manage: () => ({
        setTimeouts: async (timeouts: unknown) =>
          assert.deepEqual(JSON.parse(JSON.stringify(timeouts)), { script: 15000 }),
      }),
      findElements: () => {
        throw new Error("Readiness must not create stale WebElement handles");
      },
      wait: async (condition: () => Promise<boolean>, budget: number) => {
        budgets.push(budget);
        for (let attempt = 0; attempt < 3; attempt++) if (await condition()) return;
        throw new Error("Readiness did not converge");
      },
    };
    const context = {
      connectObservedDriver: async () => {},
      linuxPackagedInspector: false,
      driverBrowser: () => browser,
      bootstrapRecoverySession: kind.startsWith("bootstrap"),
      preferencesRecoverySession: kind.startsWith("preferences"),
      connectedLaunches: kind === "bootstrap-reconnected" ? 1 : 0,
      selection: {
        prerequisites: kind === "design-fixture" ? ["design-compatibility-fixture"] : [],
      },
      executionPlan: { fixtures: { acquisitionJourney: false } },
      document: {
        querySelector: (selector: string) => {
          queries.push(selector);
          const n = (counts.get(selector) ?? 0) + 1;
          counts.set(selector, n);
          if (selector === ".loading-state") return n === 1 ? {} : null;
          assert.equal(selector, expectedRoot);
          return n === 1 ? null : {};
        },
      },
      executeBrowserScript: async (_browser: unknown, callback: unknown, ...args: unknown[]) => {
        assert.ok(typeof callback === "function");
        const result: unknown = Reflect.apply(callback, undefined, args);
        assert.equal(typeof result, "boolean", "DOM nodes must stay inside the webview");
        return result;
      },
    };
    runInNewContext(`${connectSource}\nglobalThis.connect = connect;`, context);
    await callable(Reflect.get(context, "connect"))();
    assert.deepEqual(queries, [expectedRoot, expectedRoot, ".loading-state", ".loading-state"]);
    assert.deepEqual(budgets, [30000, 30000]);
    assert.equal(context.connectedLaunches, kind === "bootstrap-reconnected" ? 2 : 1);
  }
});
