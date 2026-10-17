import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
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

void test("embedded listener probe preserves unexpected primitive failures and bounds allowed retries", async () => {
  const source = stripTypeScriptTypes(
    await readFile(new URL("./desktop-windows-embedded-session.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  const start = source.indexOf("async function probeOwnedListener(");
  const end = source.indexOf("export async function startEmbeddedInstalledSession", start);
  assert.ok(start >= 0 && end > start);
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
    const probes: unknown[] = [];
    const result: unknown = runInNewContext(
      `${source.slice(start, end)} probeOwnedListener(1234, 500, probes)`,
      {
        Error,
        probes,
        AbortSignal,
        fetch: () => Promise.reject(failure),
      },
      { timeout: 1000 },
    );
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
  }
});
