import { spawnSync } from "node:child_process";
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
