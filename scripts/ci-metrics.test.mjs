import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCiMetrics, readCiMetrics } from "./ci-metrics.mjs";

test("timers preserve result/error identity and retain failed partial phases", async (t) => {
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
      .every((entry) => entry.failure.kind === "unknown"),
  );
  assert.ok(
    records
      .filter((entry) => entry.elapsed_ms !== undefined)
      .every((entry) => entry.elapsed_ms === 1),
  );
  assert.ok(records.every((entry) => entry.context.run === "12" && entry.context.attempt === "2"));
});

test("disabled or failed diagnostics never change an operation", () => {
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
  const warnings = [];
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

test("signal failures and diagnostic warning failures preserve operation outcomes", () => {
  const records = [];
  const metrics = createCiMetrics({
    environment: { PORTCOVE_CI_METRICS_DIR: os.tmpdir() },
    write: (_file, data) => records.push(JSON.parse(data)),
  });
  const result = { status: null, signal: "SIGTERM" };
  assert.equal(
    metrics.measure("signal", () => result),
    result,
  );
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

test("sync and async launch failures preserve identities and observed prerequisite evidence", async () => {
  const records = [];
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
  assert.ok(records.every((entry) => entry.failure.kind === "missing-prerequisite"));
});
