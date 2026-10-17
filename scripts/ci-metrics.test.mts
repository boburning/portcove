import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCiMetrics, readCiMetrics } from "./ci-metrics.mts";

void test("timers preserve result/error identity and retain failed partial phases", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-metrics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 0;
  const metrics = createCiMetrics({
    environment: {
      PORTCOVE_CI_METRICS_DIR: directory,
      GITHUB_RUN_ID: "12",
      GITHUB_RUN_ATTEMPT: "2",
    },
    now: () => time++,
  });
  const result = { status: 7 };
  assert.equal(
    metrics.measure("tests", () => result),
    result,
  );
  const failure = new Error("original");
  assert.throws(
    () =>
      metrics.measure("contracts", () => {
        throw failure;
      }),
    (error) => error === failure,
  );
  await assert.rejects(
    metrics.measureAsync("admission", async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  metrics.record("cache", { cache_outcome: "unknown" });
  const { records } = readCiMetrics(directory);
  assert.equal(records.length, 4);
  assert.equal(records.filter((entry) => entry.outcome === "failed").length, 3);
  assert.ok(
    records
      .filter((entry) => entry.outcome === "failed")
      .every((entry) => entry.failure?.kind === "unknown"),
  );
  assert.ok(
    records
      .filter((entry) => entry.elapsed_ms !== undefined)
      .every((entry) => entry.elapsed_ms === 1),
  );
  assert.ok(records.every((entry) => entry.context.run === "12" && entry.context.attempt === "2"));
});

void test("disabled or failed diagnostics never change an operation", () => {
  let writes = 0;
  const disabled = createCiMetrics({
    environment: {},
    write: () => {
      writes++;
    },
  });
  assert.equal(
    disabled.measure("one", () => 42),
    42,
  );
  assert.equal(writes, 0);
  const warnings: string[] = [];
  const metrics = createCiMetrics({
    environment: { PORTCOVE_CI_METRICS_DIR: os.tmpdir() },
    write: () => {
      throw Object.assign(new Error("disk"), { code: "EIO" });
    },
    warn: (message) => warnings.push(message),
  });
  assert.equal(
    metrics.measure("two", () => 43),
    43,
  );
  assert.equal(warnings.length, 1);
});

void test("signal failures and diagnostic warning failures preserve operation outcomes", () => {
  const records: unknown[] = [];
  const metrics = createCiMetrics({
    environment: { PORTCOVE_CI_METRICS_DIR: os.tmpdir() },
    write: (_file, data) => records.push(JSON.parse(data)),
  });
  const result = { status: null, signal: "SIGTERM" };
  assert.equal(
    metrics.measure("signal", () => result),
    result,
  );
  assert.ok(isRecord(records[0]) && isRecord(records[0].failure));
  assert.equal(records[0].outcome, "failed");
  assert.equal(records[0].failure.kind, "unknown");
  const broken = createCiMetrics({
    environment: { PORTCOVE_CI_METRICS_DIR: os.tmpdir() },
    write: () => {
      throw new Error("disk");
    },
    warn: () => {
      throw new Error("warning sink");
    },
  });
  assert.equal(
    broken.measure("success", () => 44),
    44,
  );
  const failure = new Error("command");
  assert.throws(
    () =>
      broken.measure("failure", () => {
        throw failure;
      }),
    (error) => error === failure,
  );
});

void test("sync and async launch failures preserve identities and observed prerequisite evidence", async () => {
  const records: unknown[] = [];
  const metrics = createCiMetrics({
    environment: { PORTCOVE_CI_METRICS_DIR: os.tmpdir() },
    write: (_file, data) => records.push(JSON.parse(data)),
  });
  const error = Object.assign(new Error("missing"), { code: "ENOENT", syscall: "spawn tool" });
  const result = { status: null, error };
  assert.equal(
    metrics.measure("startup", () => result),
    result,
  );
  await assert.rejects(
    metrics.measureAsync("startup", async () => {
      throw error;
    }),
    (caught) => caught === error,
  );
  assert.ok(
    records.every(
      (entry) =>
        isRecord(entry) && isRecord(entry.failure) && entry.failure.kind === "missing-prerequisite",
    ),
  );
});

void test("timing reports reject malformed context and optional measurements before claiming observations", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-metrics-shape-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  createCiMetrics({ environment: { PORTCOVE_CI_METRICS_DIR: directory } }).record("fixture");
  const name = readdirSync(directory)[0];
  assert.ok(name);
  const file = path.join(directory, name);
  const original: unknown = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(isRecord(original));
  for (const mutation of [
    { context: true },
    { context: { job: 42 } },
    { outcome: "accepted" },
    { failure: { kind: 7 } },
    { selected_tests: -1 },
    { complete_tests: 1.5 },
    { groups: ["core", 42] },
  ]) {
    writeFileSync(file, JSON.stringify({ ...original, ...mutation }));
    assert.throws(() => readCiMetrics(directory), /Invalid CI timing report/u);
  }
});

void test("malformed plan metadata stays unknown without changing operation results", () => {
  const records: unknown[] = [];
  const metrics = createCiMetrics({
    environment: {
      PORTCOVE_CI_METRICS_DIR: os.tmpdir(),
      PORTCOVE_PLAN_JSON: JSON.stringify({ identities: { head: { forged: true } }, mode: 42 }),
      PORTCOVE_HEAD_SHA: "observed-head",
    },
    write: (_file, data) => records.push(JSON.parse(data)),
  });
  assert.equal(
    metrics.measure("identity", () => 42),
    42,
  );
  assert.ok(isRecord(records[0]) && isRecord(records[0].context));
  assert.equal(records[0].context.source, "observed-head");
  assert.equal(records[0].context.mode, null);
});
