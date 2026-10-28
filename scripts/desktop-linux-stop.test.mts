import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runTypeScriptInNewContext as runInNewContext } from "./test-source.mts";

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
const stop = between("async function stopDriver()", "function stopBackupFocusDriver()");
const start = between("async function startDriver(", "async function captureSelectedDriverLaunch(");

function fixture(options: { publicationError?: unknown; joinError?: unknown } = {}) {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const calls: {
    stops: number;
    writes: { file: string; bytes: string; options: { flag: string } }[];
  } = { stops: 0, writes: [] };
  const launch = () => ({
    child: { exitCode: null, stdout: { on() {} }, stderr: { on() {} }, on() {} },
    ready: async () => {},
    stop: async () => {
      calls.stops++;
      await gate;
      if (Object.hasOwn(options, "joinError")) throw options.joinError;
      return { quiesced: true, nonce: `launch-${calls.stops}` };
    },
  });
  const artifacts: string[] = [];
  const context = {
    assert,
    AccountDriverView: class {},
    path: path.posix,
    output: "/owned",
    artifacts,
    linuxSelectedSession: true,
    linuxBinding: undefined,
    linuxPackagedInspector: false,
    linuxLaunch: launch(),
    linuxLaunchCount: 1,
    linuxStop: undefined,
    linuxCleanup: undefined,
    driver: {},
    writeFile: async (file: string, bytes: string, writeOptions: { flag: string }) => {
      calls.writes.push({ file, bytes, options: writeOptions });
      if (Object.hasOwn(options, "publicationError")) throw options.publicationError;
    },
    admission: { verify: async () => {}, assertReady() {} },
    custody: null,
    ownedSession: { beginLaunch() {} },
    port: 4444,
    driverPath: "/driver",
    nativeDriverPath: "/native-driver",
    required,
    driverEnvironment: () => ({}),
    launchLinuxNativeSession: async () => launch(),
    captureSelectedDriverLaunch: async () => {},
    historySession: false,
    driverReady: async () => true,
    setTimeout: (callback: () => void) => callback(),
  };
  runInNewContext(
    `${stop}\n${start}\nglobalThis.stopDriver=stopDriver;globalThis.startDriver=startDriver;`,
    context,
  );
  const stopDriver = callable(Reflect.get(context, "stopDriver"));
  const startDriver = callable(Reflect.get(context, "startDriver"));
  return { context, calls, release, stopDriver, startDriver };
}

void test("watchdog and final Linux cleanup share one join publication and subsequent launches stay independent", async () => {
  const { context, calls, release, stopDriver, startDriver } = fixture();
  const first = stopDriver(),
    second = stopDriver();
  await assert.rejects(startDriver(), /previous Linux launch/u);
  assert.equal(calls.stops, 1);
  assert.equal(calls.writes.length, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(calls.writes.length, 1);
  assert.equal(required(calls.writes[0]).options.flag, "wx");
  assert.equal(required(calls.writes[0]).file, "/owned/linux-native-launch-1-join.json");
  assert.equal(context.linuxLaunch, undefined);
  assert.equal(object(Reflect.get(context, "linuxCleanup")).quiesced, true);
  await startDriver();
  await Promise.all([stopDriver(), stopDriver()]);
  assert.equal(calls.stops, 2);
  assert.equal(calls.writes.length, 2);
  assert.equal(required(calls.writes[1]).file, "/owned/linux-native-launch-2-join.json");
});

for (const kind of ["publicationError", "joinError"] as const) {
  void test(`Linux cleanup shares ${kind} rejection and retains active custody`, async () => {
    for (const failure of [new Error(kind), undefined, null, false, 0, ""]) {
      const { context, calls, release, stopDriver } = fixture({ [kind]: failure });
      const active = context.linuxLaunch;
      const first = stopDriver(),
        second = stopDriver();
      release();
      const results = await Promise.allSettled([first, second]);
      assert.ok(
        results.every((result) => result.status === "rejected" && result.reason === failure),
      );
      assert.equal(calls.stops, 1);
      assert.equal(calls.writes.length, kind === "publicationError" ? 1 : 0);
      assert.equal(context.linuxLaunch, active);
      assert.equal(context.linuxCleanup, undefined);
      assert.deepEqual(context.artifacts, []);
      await assert.rejects(stopDriver(), (error) => error === failure);
      assert.equal(calls.stops, 1);
    }
  });
}

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
  const interruption = between(
    "async function interruptLinuxPreparation(",
    "async function closeApplication(",
  );
  for (const failure of [false, true]) {
    const calls: string[] = [];
    const context = {
      assert,
      path: path.posix,
      process: { platform: "linux" },
      selection: { selected_scenarios: ["native-linux-interrupted-preparation"] },
      library: "/owned/library",
      output: "/owned",
      artifacts: [] as string[],
      linuxSelectedSession: true,
      linuxLaunch: { receipt: { nonce: "owned" } },
      linuxCleanup: undefined as { quiesced: boolean } | undefined,
      browser: {
        quit: () => {
          throw new Error("Graceful session deletion is forbidden");
        },
      },
      required,
      stopDriver: async () => {
        assert.equal(Reflect.get(context, "browser"), undefined);
        calls.push("join");
        if (failure) throw new Error("join failed");
        context.linuxCleanup = { quiesced: true };
      },
      writeFile: async () => {
        calls.push("receipt");
      },
      startDriver: async () => {
        calls.push("start");
      },
      connect: async () => {
        calls.push("connect");
      },
      driverBrowser: () => "fresh-browser",
    };
    runInNewContext(`${interruption}\nglobalThis.interrupt = interruptLinuxPreparation;`, context);
    const fn: unknown = Reflect.get(context, "interrupt");
    assert.ok(typeof fn === "function");
    const invoke = () =>
      Promise.resolve(
        Reflect.apply(fn, undefined, [
          "preparation",
          "/owned/library/staging/operation/payload/setup",
          async () => {
            calls.push("preparing");
          },
        ]),
      );
    if (failure) {
      await assert.rejects(invoke(), /join failed/);
      assert.deepEqual(calls, ["preparing", "join"]);
      assert.deepEqual(context.artifacts, []);
    } else {
      assert.equal(await invoke(), "fresh-browser");
      assert.deepEqual(calls, ["preparing", "join", "receipt", "start", "connect"]);
      assert.deepEqual(context.artifacts, ["/owned/preparation-restart.json"]);
    }
  }
});
