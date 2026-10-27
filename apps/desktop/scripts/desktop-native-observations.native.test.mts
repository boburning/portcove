import { spawnSync } from "node:child_process";
import { probeOwnedListener } from "./desktop-windows-embedded-session.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readNativeSessionObservation } from "./desktop-owned-native-session.mts";
import {
  recordInstalledUpdateFailure,
  hashFile,
  verifyInstalledUpdateStaging,
} from "./desktop-installed-update-harness.mts";
import type { InstalledUpdateFailure } from "./desktop-installed-update-harness.mts";

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
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as processes from "node:child_process";
const [moduleUrl, application, output] = process.argv.slice(1);
const seleniumUrl = pathToFileURL(createRequire(moduleUrl).resolve("selenium-webdriver")).href;
const selenium = await import(seleniumUrl);
const commands = [], fetches = [], connections = [];
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
class Builder {
  disableEnvironmentOverrides(){return this}
  usingServer(value){connections.push(value);return this}
  withCapabilities(value){assert.equal(value.browserName,"tauri");assert.equal(value["wdio:tauriServiceOptions"].windowLabel,"main");return this}
  build(){return Promise.resolve({controlled:true})}
}
const {default: originalSeleniumDefault, ...originalSelenium} = selenium;
mock.module(seleniumUrl, {namedExports:{...originalSelenium,Builder},defaultExport:{...originalSeleniumDefault,Builder}});
assert.equal((await import("node:child_process")).spawn, spawn);
assert.equal((await import("node:child_process")).execFileSync, execFileSync);
assert.equal((await import(seleniumUrl)).Builder, Builder);
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
  assert.match(session.statusProbes[0].error,/controlled readiness delay/);
  assert.equal(session.statusProbes[1].status,200);
  assert.ok(session.startupComplete);assert.equal(session.listener.ready,true);
  assert.deepEqual(fetches,[connections[0]+"/status",connections[0]+"/status"]);
  native.exitCode=0;
  assert.deepEqual(await session.close(),{forced:false,exit_code:0,signal:null});session=null;
  assert.deepEqual(commands,["SnapshotApplication","ApplicationListener","ApplicationListener","SnapshotApplication","StopApplication","Wait"]);
  process.stdout.write("controlled-host-connection-and-cleanup");
} finally {
  native.exitCode=0;if(session) await session.close();
  Object.defineProperty(process,"platform",platform);
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
