import assert from "node:assert/strict";
import { isRecord } from "./runtime-values.mts";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectResourceStatus } from "./resource-status.mts";
import { writeFileSync } from "node:fs";
import { parsePressure, parseDiskStats, sampleHostObservations } from "./resource-observations.mts";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

void test("resource status CLI renders its collected I/O observation without requiring JSON", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./resource-status.mts", import.meta.url)), "--sample-seconds", "0"],
    { encoding: "utf8", timeout: 40_000, maxBuffer: 64 * 1024 },
  );
  assert.match(output, /Host I\/O: (?:recorded|unavailable); 1 sample/u);
  assert.match(output, /unregistered runners are unobserved/u);
});

void test("host I/O observations preserve counters and reject malformed or incomplete data", async () => {
  assert.deepEqual(parsePressure("some avg10=1.25 avg60=2 avg300=3 total=900\n"), {
    some: { avg10: 1.25, avg60: 2, avg300: 3, total: 900 },
  });
  assert.throws(() => parsePressure("some avg10=0"), /Incomplete/u);
  assert.throws(() => parsePressure("some avg10=NaN avg60=0 avg300=0 total=0"), /Invalid/u);
  const [disk] = parseDiskStats("8 0 sda 10 0 20 30 40 0 50 60 2 70 80");
  assert.equal(disk?.read_sectors, 20);
  assert.equal(disk?.weighted_queue_ms, 80);
  assert.throws(() => parseDiskStats("8 0 sda 1"), /Incomplete/u);
  await assert.rejects(sampleHostObservations(61), /0 to 60/u);
  const sampled = await sampleHostObservations(0);
  assert.equal(sampled.samples.length, 1);
  assert.ok(sampled.samples[0]?.observed_at);
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(sampleHostObservations(1, cancellation.signal), { name: "AbortError" });
});

void test("PID reuse is observed without reclaiming the recorded lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-status-"));
  const heavy = path.join(root, "heavy");
  const native = path.join(root, "native");
  const bytes = JSON.stringify({
    format_version: 1,
    token: "owned",
    process: { pid: 123, identity: "original" },
    child: null,
    created_at: "2026-10-09T00:00:00Z",
    workspace: "owned",
    command: "cargo test",
  });
  try {
    await mkdir(heavy);
    await writeFile(path.join(heavy, "owner.json"), bytes);
    const result = await collectResourceStatus({
      paths: { heavy, native },
      inspectIdentity: () => "reused",
    });
    assert.equal(result.resources[0]?.verification, "identity-mismatch");
    assert.equal(await readFile(path.join(heavy, "owner.json"), "utf8"), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("missing, malformed, changing and unavailable records never produce an availability claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-observations-"));
  const paths = { heavy: path.join(root, "heavy"), native: path.join(root, "native") };
  const file = path.join(paths.heavy, "owner.json");
  const owner = {
    format_version: 1,
    token: "original",
    process: { pid: 123, identity: "matching" },
    child: null,
    created_at: "2026-10-09T00:00:00Z",
  };
  try {
    assert.equal((await collectResourceStatus({ paths })).resources[0]?.verification, "unknown");
    await mkdir(paths.heavy);
    await writeFile(file, JSON.stringify(owner));
    assert.equal(
      (await collectResourceStatus({ paths, inspectIdentity: () => "matching" })).resources[0]
        ?.verification,
      "verified-live",
    );
    assert.equal(
      (await collectResourceStatus({ paths, inspectIdentity: () => null })).resources[0]
        ?.verification,
      "recorded-process-absent",
    );
    const unavailable = await collectResourceStatus({
      paths,
      inspectIdentity: () => {
        throw new Error("probe timed out");
      },
    });
    assert.equal(unavailable.resources[0]?.observation, "unavailable");
    const changed = await collectResourceStatus({
      paths,
      inspectIdentity: () => {
        writeFileSync(file, JSON.stringify({ ...owner, token: "foreign" }));
        return "matching";
      },
    });
    assert.equal(changed.resources[0]?.observation, "changed");
    assert.equal(changed.resources[0]?.verification, "unknown");
    const retainedOwner: unknown = JSON.parse(await readFile(file, "utf8"));
    assert.ok(isRecord(retainedOwner));
    assert.equal(retainedOwner.token, "foreign");
    await writeFile(file, "malformed");
    assert.equal((await collectResourceStatus({ paths })).resources[0]?.observation, "unavailable");
    await mkdir(paths.native);
    await writeFile(
      path.join(paths.native, "owner.json"),
      JSON.stringify({
        format_version: 1,
        token: "native",
        pid: 123,
        created_at: owner.created_at,
      }),
    );
    const native = (await collectResourceStatus({ paths, isProcessAlive: () => true }))
      .resources[1];
    assert.ok(native);
    assert.equal(native.verification, "unknown");
    const wrapper = native.processes?.[0];
    assert.ok(wrapper && wrapper.verification === "pid-only");
    assert.equal(wrapper.observedPresent, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("capacity observations retain their checked payload contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-capacity-status-"));
  try {
    const report = await collectResourceStatus({
      paths: { heavy: path.join(root, "heavy"), native: path.join(root, "native") },
      capacityRoot: root,
    });
    const capacity = report.resources.find((entry) => entry.resource === "host-capacity");
    assert.ok(capacity?.resource === "host-capacity" && capacity.observation === "recorded");
    assert.equal(capacity.root, root);
    assert.equal(capacity.config.slots, 2);
    assert.deepEqual(capacity.running, []);
    assert.deepEqual(capacity.queued, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
