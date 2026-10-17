import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(
  new URL("../apps/desktop/scripts/desktop-test.mjs", import.meta.url),
  "utf8",
);
const between = (start, end) => {
  const first = source.indexOf(start),
    last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
};
const stop = between("async function stopDriver()", "function stopBackupFocusDriver()");
const start = between("async function startDriver(", "async function captureSelectedDriverLaunch(");

function fixture({ publicationError, joinError } = {}) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = { stops: 0, writes: [] };
  const launch = () => ({
    child: { exitCode: null, stdout: { on() {} }, stderr: { on() {} }, on() {} },
    ready: async () => {},
    stop: async () => {
      calls.stops++;
      await gate;
      if (joinError) throw joinError;
      return { quiesced: true, nonce: `launch-${calls.stops}` };
    },
  });
  const context = {
    assert,
    path: path.posix,
    output: "/owned",
    artifacts: [],
    linuxSelectedSession: true,
    linuxPackagedInspector: false,
    linuxLaunch: launch(),
    linuxLaunchCount: 1,
    linuxStop: undefined,
    linuxCleanup: undefined,
    driver: {},
    writeFile: async (file, bytes, options) => {
      calls.writes.push({ file, bytes, options });
      if (publicationError) throw publicationError;
    },
    admission: { verify: async () => {}, assertReady() {} },
    custody: null,
    ownedSession: { beginLaunch() {} },
    port: 4444,
    values: { driver: "/driver", "native-driver": "/native-driver" },
    driverEnvironment: () => ({}),
    launchLinuxNativeSession: async () => launch(),
    captureSelectedDriverLaunch: async () => {},
    historySession: false,
    driverReady: async () => true,
    setTimeout: (callback) => callback(),
  };
  runInNewContext(
    `${stop}\n${start}\nglobalThis.stopDriver=stopDriver;globalThis.startDriver=startDriver;`,
    context,
  );
  return { context, calls, release };
}

test("watchdog and final Linux cleanup share one join publication and subsequent launches stay independent", async () => {
  const { context, calls, release } = fixture();
  const first = context.stopDriver(),
    second = context.stopDriver();
  await assert.rejects(context.startDriver(), /previous Linux launch/u);
  assert.equal(calls.stops, 1);
  assert.equal(calls.writes.length, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].options.flag, "wx");
  assert.equal(calls.writes[0].file, "/owned/linux-native-launch-1-join.json");
  assert.equal(context.linuxLaunch, undefined);
  assert.equal(context.linuxCleanup.quiesced, true);
  await context.startDriver();
  await Promise.all([context.stopDriver(), context.stopDriver()]);
  assert.equal(calls.stops, 2);
  assert.equal(calls.writes.length, 2);
  assert.equal(calls.writes[1].file, "/owned/linux-native-launch-2-join.json");
});

for (const kind of ["publicationError", "joinError"]) {
  test(`Linux cleanup shares ${kind} rejection and retains active custody`, async () => {
    const failure = new Error(kind);
    const { context, calls, release } = fixture({ [kind]: failure });
    const active = context.linuxLaunch;
    const first = context.stopDriver(),
      second = context.stopDriver();
    release();
    const results = await Promise.allSettled([first, second]);
    assert.ok(results.every((result) => result.status === "rejected" && result.reason === failure));
    assert.equal(calls.stops, 1);
    assert.equal(calls.writes.length, kind === "publicationError" ? 1 : 0);
    assert.equal(context.linuxLaunch, active);
    assert.equal(context.linuxCleanup, undefined);
    assert.deepEqual(context.artifacts, []);
    await assert.rejects(context.stopDriver(), (error) => error === failure);
    assert.equal(calls.stops, 1);
  });
}
