import { spawnSync } from "node:child_process";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";
import { probeOwnedListener } from "./desktop-windows-embedded-session.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OwnedNativeSession,
  assertNativeApplicationInventory,
  readNativeSessionObservation,
} from "./desktop-owned-native-session.mts";
import type { NativeManagedGame, NativeProcessSnapshot } from "./desktop-owned-native-session.mts";
import type { LaunchSessionRecord } from "../src/transport-types.generated.d.ts";
import {
  recordInstalledUpdateFailure,
  hashFile,
  verifyInstalledUpdateStaging,
} from "./desktop-installed-update-harness.mts";
import type { InstalledUpdateFailure } from "./desktop-installed-update-harness.mts";

void test("native acquisition binds the connected GUI and admits only its exact Core-recorded supervisor", () => {
  const driver = { pid: 10, path: process.execPath, started_filetime: "100" };
  const application = { pid: 11, path: path.resolve("owned-desktop.exe"), started_filetime: "200" };
  const supervisor = { ...application, pid: 12, started_filetime: "134375515263942076" };
  const game: NativeManagedGame = {
    executable: path.resolve("owned-library/versions/fixture/artifact/game.exe"),
    installation: {
      id: "owned-installation",
      port_id: "owned-fixture",
      path: path.resolve("owned-library/versions/fixture/artifact"),
    },
  };
  const record: LaunchSessionRecord = {
    id: "owned-session",
    port_id: game.installation.port_id,
    install_id: game.installation.id,
    install_root: game.installation.path,
    owner_kind: "managed",
    supervisor_pid: supervisor.pid,
    supervisor_identity: `windows-filetime:${supervisor.started_filetime}`,
    child_pid: 13,
    child_identity: "windows-filetime:400",
    phase: "running",
    outcome: null,
    exit_code: null,
    message: null,
    started_at: 1,
    updated_at: 1,
    finished_at: null,
  };
  const connected: NativeProcessSnapshot = {
    captured_at: "owned-connection",
    driver,
    application_pid: application.pid,
    processes: [application],
  };
  const owner = new OwnedNativeSession();
  owner.beginLaunch();
  owner.driver = driver;
  owner.bindApplication(connected, application.path);
  assert.deepEqual(owner.requireApplication(connected), application);
  const live = { ...connected, application_pid: null, processes: [application, supervisor] };
  const original = structuredClone(live);
  assertNativeApplicationInventory(live, owner.requireApplication(live), game, [record]);
  assert.deepEqual(live, original, "Qualification must retain the complete captured descendants");
  // Published completion is not process-exit evidence; an exact supervisor can still be leaving.
  assertNativeApplicationInventory(live, application, game, [
    { ...record, phase: "collecting", outcome: "succeeded", finished_at: 2 },
  ]);
  for (const changed of [
    { supervisor_pid: supervisor.pid + 1 },
    { supervisor_identity: "windows-filetime:134375515263942077" },
    { supervisor_identity: null },
    { port_id: "other-port" },
    { install_id: "other-installation" },
    { install_root: path.resolve("foreign-library/versions/fixture/artifact") },
    { owner_kind: "external" as const },
  ]) {
    assert.throws(() =>
      assertNativeApplicationInventory(live, application, game, [{ ...record, ...changed }]),
    );
  }
  assert.throws(() => assertNativeApplicationInventory(live, application, game, []));
  assert.throws(() => assertNativeApplicationInventory(live, application, undefined, [record]));
  assert.throws(() =>
    assertNativeApplicationInventory(
      {
        ...live,
        processes: [...live.processes, { ...application, pid: 14, started_filetime: "500" }],
      },
      application,
      game,
      [record],
    ),
  );
  assert.throws(() =>
    assertNativeApplicationInventory({ ...live, processes: [supervisor] }, application, game, [
      record,
    ]),
  );
  assert.throws(() =>
    assertNativeApplicationInventory(
      { ...live, processes: [{ ...application, started_filetime: "201" }, supervisor] },
      application,
      game,
      [record],
    ),
  );
  assert.throws(() =>
    assertNativeApplicationInventory(
      { ...live, processes: [...live.processes, supervisor] },
      application,
      game,
      [record],
    ),
  );
  assert.throws(() => owner.bindApplication(live, application.path));
  assert.throws(() =>
    owner.requireApplication({ ...live, driver: { ...driver, started_filetime: "101" } }),
  );
  owner.game = game;
  const nextGame: NativeManagedGame = {
    executable: path.resolve("owned-library/versions/fixture/next-artifact/game.exe"),
    installation: {
      ...game.installation,
      id: "next-installation",
      path: path.resolve("owned-library/versions/fixture/next-artifact"),
    },
  };
  const nextRecord = {
    ...record,
    install_id: nextGame.installation.id,
    install_root: nextGame.installation.path,
  };
  assert.throws(() => assertNativeApplicationInventory(live, application, nextGame, [record]));
  assertNativeApplicationInventory(live, application, nextGame, [nextRecord]);
  const leaving = { ...supervisor, pid: 15, started_filetime: "134375515263942075" };
  const afterActivation = { ...live, processes: [...live.processes, leaving] };
  const priorRecord: LaunchSessionRecord = {
    ...record,
    supervisor_pid: leaving.pid,
    supervisor_identity: `windows-filetime:${leaving.started_filetime}`,
    phase: "collecting",
    outcome: "succeeded",
  };
  assertNativeApplicationInventory(
    afterActivation,
    application,
    nextGame,
    [nextRecord, priorRecord],
    [game],
  );
  assert.throws(() =>
    assertNativeApplicationInventory(afterActivation, application, nextGame, [
      nextRecord,
      priorRecord,
    ]),
  );
  assert.throws(() =>
    assertNativeApplicationInventory(
      afterActivation,
      application,
      nextGame,
      [nextRecord, { ...priorRecord, outcome: null }],
      [game],
    ),
  );
  assert.throws(() =>
    assertNativeApplicationInventory(
      afterActivation,
      application,
      nextGame,
      [nextRecord, { ...priorRecord, supervisor_identity: "windows-filetime:134375515263942074" }],
      [game],
    ),
  );
  owner.games = [game];
  const missingOutcome = { ...priorRecord };
  Reflect.deleteProperty(missingOutcome, "outcome");
  assert.throws(() =>
    assertNativeApplicationInventory(
      afterActivation,
      application,
      nextGame,
      [nextRecord, missingOutcome],
      [game],
    ),
  );
  owner.beginLaunch();
  assert.equal(owner.application, undefined);
  assert.equal(owner.game, undefined);
  assert.deepEqual(owner.games, []);
  assert.throws(() => owner.requireApplication(live));
});

void test("native process observations reject malformed identities without issuing process actions", () => {
  const process = { pid: 42, path: globalThis.process.execPath, started_filetime: "123" };
  const snapshot = {
    captured_at: new Date().toISOString(),
    driver: process,
    application_pid: 43,
    processes: [process],
    metadata: { retained: true },
  };
  assert.deepEqual(readNativeSessionObservation("Snapshot", snapshot), snapshot);
  assert.deepEqual(
    readNativeSessionObservation("SnapshotDriver", {
      ...snapshot,
      application_pid: null,
      processes: [],
    }).processes,
    [],
  );
  for (const driver of [
    null,
    { ...process, pid: 0 },
    { ...process, pid: 1.5 },
    { ...process, path: "relative.exe" },
    { ...process, started_filetime: 123 },
    { ...process, started_filetime: "invalid" },
  ]) {
    assert.throws(() => readNativeSessionObservation("Snapshot", { ...snapshot, driver }));
  }
  assert.throws(() => readNativeSessionObservation("Snapshot", { ...snapshot, processes: [null] }));
  assert.throws(() => readNativeSessionObservation("SnapshotApplication", snapshot));
  const application = readNativeSessionObservation("SnapshotApplication", {
    ...snapshot,
    root_kind: "direct-application",
    executable_sha256: "a".repeat(64),
  });
  assert.equal(application.root_kind, "direct-application");
  const survivors = { method: "captured-application-survivors", terminated_survivors: [43] };
  assert.deepEqual(readNativeSessionObservation("StopApplication", survivors), survivors);
  assert.throws(() => readNativeSessionObservation("StopDriver", survivors));
  assert.deepEqual(readNativeSessionObservation("ApplicationListener", { ready: false }), {
    ready: false,
  });
  const listener = {
    ready: true,
    pid: 42,
    address: "127.0.0.1",
    port: 12345,
    started_filetime: "123",
  };
  assert.deepEqual(readNativeSessionObservation("ApplicationListener", listener), listener);
  for (const change of [{ address: "0.0.0.0" }, { port: 65536 }, { pid: 0 }, { ready: "true" }]) {
    assert.throws(() =>
      readNativeSessionObservation("ApplicationListener", { ...listener, ...change }),
    );
  }
  assert.throws(() =>
    readNativeSessionObservation("Wait", { exited_at: "now", observed_processes: -1, wait_ms: 5 }),
  );
  assert.throws(() =>
    readNativeSessionObservation("RequestClose", {
      requested_at: "now",
      application_pid: 42,
      started_filetime: "123",
      method: "identity-bound-native-main-window-close-request",
      message_sent: false,
    }),
  );
});

void test("installed update staging reads actual checked artifact bytes and retains primitive failures", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-installed-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const application = path.join(directory, "app");
  const staged = path.join(directory, "candidate");
  await writeFile(application, "old app");
  await writeFile(staged, "candidate app");
  const initial = await hashFile(application),
    candidate = await hashFile(staged);
  const manifest = path.join(directory, "staging.json");
  const receipt = {
    phase: "verified",
    candidate: { release: { version: "2.0.0", artifact: { bytes: candidate.bytes } } },
  };
  await writeFile(manifest, JSON.stringify(receipt));
  const options = {
    stagingRoot: directory,
    payloadName: "candidate",
    candidateSha: candidate.sha256,
    candidateVersion: "2.0.0",
    application,
    initialSha: initial.sha256,
  };
  assert.deepEqual(await verifyInstalledUpdateStaging(options), candidate);
  await writeFile(staged, "altered bytes!");
  await assert.rejects(verifyInstalledUpdateStaging(options));
  await writeFile(
    path.join(directory, "helper-failure.json"),
    JSON.stringify({ phase: "helper-refused", extra: { retained: true } }),
  );
  const failures: [unknown, string][] = [
    ...[null, undefined, false, 0, ""].map((failure): [unknown, string] => [
      failure,
      String(failure),
    ]),
    [{ stack: "owned non-Error stack" }, "owned non-Error stack"],
    [{ stack: 0 }, "0"],
  ];
  for (const [failure, expected] of failures) {
    const report: InstalledUpdateFailure = { phase: "started", failure: null };
    await recordInstalledUpdateFailure(report, failure, path.join(directory, "helper-marker.json"));
    assert.equal(report.phase, "failed");
    assert.equal(report.failure, expected);
    assert.deepEqual(report.helper_failure, { phase: "helper-refused", extra: { retained: true } });
  }
});

void test("embedded listener probe preserves unexpected primitive failures and bounds allowed retries", async (context) => {
  for (const failure of [
    null,
    undefined,
    false,
    0,
    "",
    new Error("unexpected"),
    Object.assign(new Error("timeout"), { name: "TimeoutError" }),
    { name: "AbortError" },
  ]) {
    const probes: Parameters<typeof probeOwnedListener>[2] = [];
    const transport = context.mock.method(
      globalThis,
      "fetch",
      (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
        assert.equal(input, "http://127.0.0.1:1234/status");
        assert.ok(options?.signal instanceof AbortSignal);
        return Promise.reject(failure);
      },
    );
    const result = probeOwnedListener(1234, 500, probes);
    if (
      failure !== null &&
      typeof failure === "object" &&
      "name" in failure &&
      ["TimeoutError", "AbortError"].includes(String(failure.name))
    )
      assert.equal(await result, undefined);
    else
      await assert.rejects(
        async () => {
          await result;
        },
        (error: unknown) => Object.is(error, failure),
      );
    assert.equal(probes.length, 1);
    assert.ok(probes[0]?.finished_at);
    transport.mock.restore();
  }
});

void test(
  "actual embedded connection invokes the owned listener probe and retains cleanup",
  { timeout: 30_000 },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "embedded-host-contract-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const application = path.join(directory, "inert-application.exe");
    await writeFile(application, "inert controlled input");
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--input-type=module",
        "--eval",
        String.raw`
import assert from "node:assert/strict";
import { mock } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks, isBuiltin } from "node:module";
import * as processes from "node:child_process";
const [moduleUrl, application, output] = process.argv.slice(1);
const seleniumUrl = "portcove-test:owned-listener-selenium";
const commands = [], fetches = [], seleniumParents = [];
const builderSource = [
 "import assert from 'node:assert/strict'; export const connections=[];",
 "export class Builder {",
 "disableEnvironmentOverrides(){return this}",
 "usingServer(value){connections.push(value);return this}",
 "withCapabilities(value){assert.equal(value.browserName,'tauri');assert.equal(value['wdio:tauriServiceOptions'].windowLabel,'main');return this}",
 "build(){return Promise.resolve({controlled:true})}",
 "}",
].join("\n");
const hooks = registerHooks({
 resolve(specifier, context, next) {
  if(specifier === seleniumUrl) return {url:seleniumUrl,shortCircuit:true};
  if(specifier === "selenium-webdriver" && context.parentURL === moduleUrl) {
   seleniumParents.push(context.parentURL); return {url:seleniumUrl,shortCircuit:true};
  }
  if(!isBuiltin(specifier) && !specifier.startsWith("file:") && !specifier.startsWith(".") && !specifier.startsWith("/")) throw new Error("PACKAGE_IMPORT_REFUSED: "+specifier);
  return next(specifier,context);
 },
 load(url,context,next) {
  if(url === seleniumUrl) return {format:"module",source:builderSource,shortCircuit:true};
  if(url.toLowerCase().includes("/node_modules/")) throw new Error("PACKAGE_FILE_REFUSED");
  return next(url,context);
 },
});
await assert.rejects(import("portcove-forbidden-package-probe"),/PACKAGE_IMPORT_REFUSED/);
const {connections} = await import(seleniumUrl);
const native = Object.assign(new EventEmitter(), {pid: 42, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough()});
const expectedSha = createHash("sha256").update(readFileSync(application)).digest("hex");
const spawn = (file, args, options) => {
  assert.equal(file, application); assert.deepEqual(args, []); assert.equal(options.windowsHide, true);
  setImmediate(() => native.emit("spawn")); return native;
};
const execFileSync = (file, args) => {
  assert.equal(file, "pwsh"); const mode = args[args.indexOf("-Mode")+1]; commands.push(mode);
  if(mode === "SnapshotApplication") {
    assert.equal(args[args.indexOf("-ExpectedParentProcessId")+1], String(process.pid));
    assert.equal(args[args.indexOf("-ExpectedApplicationSha256")+1], expectedSha);
    return JSON.stringify({root_kind:"direct-application",executable_sha256:expectedSha,captured_at:new Date().toISOString(),driver:{pid:42,path:application,started_filetime:"123"},application_pid:42,processes:[{pid:42,path:application,started_filetime:"123"}]});
  }
  if(mode === "ApplicationListener") return JSON.stringify({ready:true,pid:42,address:"127.0.0.1",port:Number(args[args.indexOf("-Port")+1]),started_filetime:"123"});
  if(mode === "StopApplication") return JSON.stringify({method:"captured-application-survivors",terminated_survivors:[]});
  if(mode === "Wait") return JSON.stringify({exited_at:new Date().toISOString(),observed_processes:1,wait_ms:0});
  assert.fail("Unexpected native mutation command: "+mode);
};
const {default: originalProcessDefault, ...originalProcesses} = processes;
mock.module("node:child_process", {namedExports:{...originalProcesses,spawn,execFileSync},defaultExport:{...originalProcessDefault,spawn,execFileSync}});
assert.equal((await import("node:child_process")).spawn, spawn);
assert.equal((await import("node:child_process")).execFileSync, execFileSync);
assert.equal(typeof (await import(seleniumUrl)).Builder, "function");
globalThis.fetch = async (url, options) => {
  fetches.push(url); assert.ok(options.signal instanceof AbortSignal);
  if(fetches.length === 1) throw Object.assign(new Error("controlled readiness delay"),{name:"TimeoutError"});
  return new Response("{}",{status:200});
};
const platform = Object.getOwnPropertyDescriptor(process,"platform");
Object.defineProperty(process,"platform",{configurable:true,value:"win32"});
let session;
try {
  const api = await import(moduleUrl); session = await api.startEmbeddedInstalledSession(application, output);
  assert.deepEqual(await session.connect(), {controlled:true});
  assert.equal(fetches.length,2); assert.equal(session.statusProbes.length,2);
  assert.deepEqual(seleniumParents,[moduleUrl]);
  assert.match(session.statusProbes[0].error,/controlled readiness delay/);
  assert.equal(session.statusProbes[1].status,200);
  assert.ok(session.startupComplete);assert.equal(session.listener.ready,true);
  assert.deepEqual(fetches,[connections[0]+"/status",connections[0]+"/status"]);
  native.exitCode=0;
  assert.deepEqual(await session.close(),{forced:false,exit_code:0,signal:null});session=null;
  assert.deepEqual(commands,["SnapshotApplication","ApplicationListener","ApplicationListener","SnapshotApplication","StopApplication","Wait"]);
  process.stdout.write("controlled-host-connection-and-cleanup");
} finally {
  try { native.exitCode=0;if(session) await session.close(); }
  finally { Object.defineProperty(process,"platform",platform); hooks.deregister(); }
}
`,
        new URL("./desktop-windows-embedded-session.mts", import.meta.url).href,
        application,
        directory,
      ],
      { env: environment, encoding: "utf8", timeout: 20_000, maxBuffer: 512 * 1024 },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(child.stdout, "controlled-host-connection-and-cleanup");
  },
);

async function assertFinalCustody(Session: typeof OwnedNativeSession) {
  for (const positive of [false, true]) {
    const session = new Session();
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
    const release = () =>
      session.releaseResources({
        closeFixtures: async () => {
          calls.push("install-close", "origin-close");
        },
        releaseLock: async () => {
          calls.push("release");
        },
      });
    if (positive) {
      await release();
      assert.deepEqual(
        calls,
        ["install-close", "origin-close", "release"],
        "FIXTURE_BEFORE_LEASE_RELEASE",
      );
    } else {
      await assert.rejects(release, /Positive current owned/, "MISSING_CUSTODY_REFUSAL");
      assert.deepEqual(calls, [], "Unproven exit cannot close fixtures or release its lease");
      assert.equal(
        session.inventory,
        "current.json",
        "Failed custody remains retained for the real caller",
      );
    }
  }
}
void test("Windows final custody gate retains failed current exit without fixture or lease release", async () => {
  await assertFinalCustody(OwnedNativeSession);
});

function assertLaunchAdmission(Session: typeof OwnedNativeSession) {
  for (const result of ["admission-refused", "factory-refused", "started"] as const) {
    const session = new Session();
    session.beginLaunch();
    session.driver = { pid: 2, path: "C:\\fixture\\driver.exe", started_filetime: "200" };
    session.inventory = "former.json";
    session.cleanup = {
      stopped: { method: "observed-child-exit", exit_code: 0 },
      exited: { observed_processes: 4, exited_at: "2026-10-20T00:00:00Z", wait_ms: 1 },
      snapshot: "former.json",
    };
    const former = session.requireQuiescence(),
      calls: string[] = [];
    const admissionFailure = new Error("admission refused"),
      factoryFailure = new Error("replacement spawn failed"),
      created = { exact: "new driver" };
    const begin = session.beginLaunch.bind(session);
    session.beginLaunch = () => {
      calls.push("begin");
      begin();
    };
    const start = () =>
      session.startLaunch({
        admit: () => {
          calls.push("admission");
          if (result === "admission-refused") throw admissionFailure;
        },
        create: () => {
          calls.push("factory");
          assert.throws(
            () => session.requireQuiescence(),
            /Current owned launch identity/,
            "INVALIDATE_BEFORE_FACTORY",
          );
          if (result === "factory-refused") throw factoryFailure;
          return created;
        },
      });
    if (result === "started") assert.equal(start(), created, "SYNCHRONOUS_FACTORY_IDENTITY");
    else
      assert.throws(
        start,
        (error) => error === (result === "admission-refused" ? admissionFailure : factoryFailure),
        "ADMISSION_FAILURE_IDENTITY",
      );
    if (result === "admission-refused") {
      assert.deepEqual(calls, ["admission"], "ADMISSION_BEFORE_REPLACEMENT");
      assert.equal(session.requireQuiescence(), former);
    } else {
      assert.deepEqual(calls, ["admission", "begin", "factory"]);
      assert.throws(() => session.requireQuiescence(), /Current owned launch identity/);
    }
  }
}
void test("Windows admission refusal preserves former exit proof until a replacement spawn is attempted", () => {
  assertLaunchAdmission(OwnedNativeSession);
});

async function assertStrictRestart(Session: typeof OwnedNativeSession) {
  for (const acquisition of [false, true])
    for (const refusesExit of [true, false]) {
      const session = new Session();
      session.beginLaunch();
      session.driver = { pid: 2, path: process.execPath, started_filetime: "200" };
      session.inventory = "owned.json";
      const events: string[] = [];
      const joined = session.requireQuiescence.bind(session);
      session.requireQuiescence = () => {
        events.push("join");
        return joined();
      };
      const reconnected = { exact: "browser" },
        name = acquisition ? "acquisition-2.0.0" : "published-move-repeat";
      const execute = () =>
        session.restart({
          capture: async () => {
            events.push("capture", "validate");
          },
          close: async () => {
            events.push("quit");
          },
          stop: () => {
            events.push("stop");
            if (!refusesExit)
              session.cleanup = {
                stopped: { method: "observed-child-exit", exit_code: 0 },
                exited: { observed_processes: 4, exited_at: "2026-10-20T00:00:00Z", wait_ms: 1 },
                snapshot: "owned.json",
              };
          },
          publish: async (proof) => {
            assert.equal(proof, session.cleanup);
            events.push("publish");
            assert.ok(name);
          },
          prepare: async () => {
            events.push("callback");
          },
          start: async () => {
            events.push("start");
          },
          connect: async () => {
            events.push("connect");
          },
          browser: () => reconnected,
        });
      if (refusesExit) {
        await assert.rejects(execute, /Positive current owned/, "RESTART_REQUIRES_QUIESCENCE");
        assert.deepEqual(
          events,
          ["capture", "validate", "quit", "stop", "join"],
          "RESTART_STOP_JOIN_ORDER",
        );
      } else {
        assert.equal(await execute(), reconnected, "RESTART_BROWSER_IDENTITY");
        assert.deepEqual(
          events,
          [
            "capture",
            "validate",
            "quit",
            "stop",
            "join",
            "publish",
            "callback",
            "start",
            "connect",
          ],
          "RESTART_COMPLETE_ORDER",
        );
      }
    }
}
void test("publication repeat callback requires the complete owned native quiescence join", async () => {
  await assertStrictRestart(OwnedNativeSession);
});

void test("owned restart preserves each exact phase failure and never starts later work", async () => {
  for (const withPreparation of [true, false]) {
    const order = [
      "capture",
      "quit",
      "stop",
      "join",
      "publish",
      "prepare",
      "start",
      "connect",
      "browser",
    ].filter((phase) => withPreparation || phase !== "prepare");
    for (const failAt of [...order, undefined]) {
      const session = new OwnedNativeSession();
      session.beginLaunch();
      session.driver = { pid: 2, path: process.execPath, started_filetime: "200" };
      session.inventory = "current.json";
      const events: string[] = [],
        failure = new Error(`exact phase failure: ${failAt}`),
        result = { exact: "browser" };
      const phase = (name: string) => {
        events.push(name);
        if (name === failAt) throw failure;
      };
      const originalJoin = session.requireQuiescence.bind(session);
      session.requireQuiescence = () => {
        phase("join");
        return originalJoin();
      };
      const run = () =>
        session.restart({
          capture: async () => {
            phase("capture");
          },
          close: async () => {
            phase("quit");
          },
          stop: () => {
            phase("stop");
            session.cleanup = {
              stopped: { method: "observed-child-exit", exit_code: 0 },
              exited: { observed_processes: 4, exited_at: "2026-10-20T00:00:00Z", wait_ms: 1 },
              snapshot: "current.json",
            };
          },
          publish: async (proof) => {
            phase("publish");
            assert.equal(proof, session.cleanup);
          },
          prepare: withPreparation
            ? async () => {
                phase("prepare");
              }
            : undefined,
          start: async () => {
            phase("start");
          },
          connect: async () => {
            phase("connect");
          },
          browser: () => {
            phase("browser");
            return result;
          },
        });
      if (failAt)
        await assert.rejects(run, (error) => error === failure, "RESTART_PHASE_FAILURE_IDENTITY");
      else assert.equal(await run(), result);
      assert.deepEqual(
        events,
        failAt ? order.slice(0, order.indexOf(failAt) + 1) : order,
        "RESTART_FAIL_CLOSED_PHASE_ORDER",
      );
    }
  }
});

void test("whole native custody owner rejects removed admission, proof and restart gates", () => {
  const entry = new URL("./desktop-owned-native-session.mts", import.meta.url);
  const program = (oracle: (Session: typeof OwnedNativeSession) => unknown, mutation = "") => `
    const actual = await import(entry); const Subject = class extends actual.OwnedNativeSession {};
    ${mutation}
    await (${oracle.toString()})(Subject);
  `;
  for (const oracle of [assertFinalCustody, assertLaunchAdmission, assertStrictRestart]) {
    runDesktopModuleFixture(entry, program(oracle));
    runDesktopModuleFixture(entry, program(oracle), {
      exportName: "OwnedNativeSession",
      variant: "aliased",
    });
  }
  const controls: [
    typeof assertLaunchAdmission | typeof assertFinalCustody | typeof assertStrictRestart,
    string,
    string,
  ][] = [
    [
      assertLaunchAdmission,
      "Subject.prototype.startLaunch=function({create}){this.beginLaunch();return create();};",
      "ADMISSION_FAILURE_IDENTITY",
    ],
    [
      assertLaunchAdmission,
      "Subject.prototype.startLaunch=function({admit,create}){admit();return create();};",
      "INVALIDATE_BEFORE_FACTORY",
    ],
    [
      assertLaunchAdmission,
      "Subject.prototype.startLaunch=function({admit,create}){this.beginLaunch();admit();return create();};",
      "ADMISSION_BEFORE_REPLACEMENT",
    ],
    [
      assertLaunchAdmission,
      "Subject.prototype.startLaunch=function(input){actual.OwnedNativeSession.prototype.startLaunch.call(this,input);return {};};",
      "SYNCHRONOUS_FACTORY_IDENTITY",
    ],
    [
      assertFinalCustody,
      "Subject.prototype.releaseResources=async function({closeFixtures,releaseLock}){await closeFixtures();await releaseLock();};",
      "MISSING_CUSTODY_REFUSAL",
    ],
    [
      assertFinalCustody,
      "Subject.prototype.releaseResources=async function({closeFixtures,releaseLock}){this.requireQuiescence();await releaseLock();await closeFixtures();};",
      "FIXTURE_BEFORE_LEASE_RELEASE",
    ],
    [
      assertStrictRestart,
      "Subject.prototype.restart=async function(x){await x.capture();await x.close();x.stop();await x.publish(this.cleanup);if(x.prepare)await x.prepare();await x.start();await x.connect();return x.browser();};",
      "RESTART_REQUIRES_QUIESCENCE",
    ],
    [
      assertStrictRestart,
      "Subject.prototype.restart=async function(x){await x.capture();await x.close();x.stop();await x.publish(this.cleanup);this.requireQuiescence();if(x.prepare)await x.prepare();await x.start();await x.connect();return x.browser();};",
      "RESTART_STOP_JOIN_ORDER",
    ],
    [
      assertStrictRestart,
      "Subject.prototype.restart=function(x){return actual.OwnedNativeSession.prototype.restart.call(this,{...x,publish:async()=>{}});};",
      "RESTART_COMPLETE_ORDER",
    ],
    [
      assertStrictRestart,
      "Subject.prototype.restart=function(x){return actual.OwnedNativeSession.prototype.restart.call(this,{...x,connect:async()=>{}});};",
      "RESTART_COMPLETE_ORDER",
    ],
    [
      assertStrictRestart,
      "Subject.prototype.restart=async function(x){await actual.OwnedNativeSession.prototype.restart.call(this,x);return {};};",
      "RESTART_BROWSER_IDENTITY",
    ],
  ];
  for (const [oracle, mutation, marker] of controls)
    assert.throws(
      () => runDesktopModuleFixture(entry, program(oracle, mutation)),
      (error) => error instanceof assert.AssertionError && error.message.includes(marker),
      marker,
    );
});
