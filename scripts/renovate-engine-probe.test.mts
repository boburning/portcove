import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeExtraction,
  validateGlobalConfig,
  validatePresetResult,
  validateLookupResult,
  validateCommandRecords,
  validateEngine,
  freezeProbeClock,
  validateArtifactResult,
  probeFailureSummary,
} from "./renovate-engine-probe.mts";
void test("probe failures bound oversized Unicode assertions and expose the retained raw report", () => {
  const error = Object.assign(new Error("different lock: " + "未知😀".repeat(10000)), {
    reportReference: "work/probe/failed/report.json",
  });
  const text = probeFailureSummary(error) + "\n";
  assert(Buffer.byteLength(text) <= 16 * 1024);
  assert.match(text, /Raw evidence: work\/probe\/failed\/report.json/);
  assert.match(text, /different lock/);
  assert(error.message.length > 30000);
});
void test("artifact contents normalize real Buffer results and reject ambiguous shapes", () => {
  assert.equal(
    validateArtifactResult([
      { file: { type: "addition", path: "Cargo.lock", contents: Buffer.from("lock") } },
    ]),
    "lock",
  );
  assert.throws(
    () =>
      validateArtifactResult([{ file: { type: "addition", path: "Cargo.lock", contents: {} } }]),
    /content shape/,
  );
  assert.throws(() => validateArtifactResult([{ artifactError: {} }]), /Artifact failure/);
});
void test("probe freezes both new Date and Date.now and restores the real clock", () => {
  const OriginalDate = Date,
    observedAt = "2026-10-14T15:07:26.355Z",
    restore = freezeProbeClock(observedAt);
  try {
    assert.equal(new Date().toISOString(), observedAt);
    assert.equal(Date.now(), Date.parse(observedAt));
    assert.equal(new Date("2020-01-01").getUTCFullYear(), 2020);
  } finally {
    restore();
  }
  assert.equal(Date, OriginalDate);
});
void test("probe rejects incorrect extraction, preset and Result assumptions before artifacts", () => {
  assert.throws(() => normalizeExtraction({ dependencies: [] }), /deps/);
  const deps = ["serde_json", "semver"].map((depName) => ({
    depName,
    datasource: "crate",
    currentValue: "1.0.152",
    lockedVersion: "1.0.152",
  }));
  assert.deepEqual(
    normalizeExtraction({ deps }).map((dep) => dep.packageName),
    ["serde_json", "semver"],
  );
  assert.throws(() => normalizeExtraction({ deps: [deps[0], deps[0]] }), /Duplicate/);
  assert.throws(() => validatePresetResult({ rangeStrategy: "bump" }), /config/);
  assert.deepEqual(validatePresetResult({ config: {}, visitedPresets: {} }), {});
  assert.throws(() => validateLookupResult({ updates: [] }), /Result/);
  assert.throws(() => validateLookupResult({ res: { ok: false, val: { updates: [] } } }), /Result/);
  assert.deepEqual(validateLookupResult({ res: { ok: true, val: { updates: [] } } }), []);
});
void test("command evidence cannot silently omit or accept empty records", () => {
  assert.throws(() => validateCommandRecords([]), /missing/);
  assert.throws(() => validateCommandRecords([{ msg: "Executing command", cmd: "" }]), /Empty/);
  assert.deepEqual(
    validateCommandRecords([
      { msg: "Executing command", command: "cargo update" },
      { msg: "Executing command", cmd: "cargo update --workspace" },
    ]),
    ["cargo update", "cargo update --workspace"],
  );
});
void test("engine version mismatch requires new capture instead of reusing a fixture", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "engine-version-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "99.0.0" }));
    assert.throws(
      () => validateEngine(root, { engine: { version: "44.156.3" } }),
      /fresh.*capture/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { errorMessage, isRecord } from "./runtime-values.mts";

void test("frozen probe clock retains callable Date, native constructors and subclassing", () => {
  const OriginalDate = Date;
  const observedAt = "2026-10-14T15:07:26.355Z";
  const restore = freezeProbeClock(observedAt);
  try {
    assert.equal(Date(), new OriginalDate(observedAt).toString());
    assert.equal(new Date().toISOString(), observedAt);
    assert.equal(Date.now(), OriginalDate.parse(observedAt));
    assert.equal(Date.parse("2020-01-01"), OriginalDate.parse("2020-01-01"));
    assert.equal(Date.UTC(2020, 3, 4), OriginalDate.UTC(2020, 3, 4));
    assert.equal(
      new Date(2020, 3, 4, 5, 6, 7, 8).getTime(),
      new OriginalDate(2020, 3, 4, 5, 6, 7, 8).getTime(),
    );
    assert.equal(new Date(new OriginalDate(12345)).getTime(), 12345);
    assert.ok(Number.isNaN(new Date(NaN).getTime()));
    class DerivedDate extends Date {}
    const derived = new DerivedDate(12345);
    assert.equal(derived.getTime(), 12345);
    assert.ok(derived instanceof DerivedDate && derived instanceof OriginalDate);
    assert.equal(Object.getPrototypeOf(derived), DerivedDate.prototype);
  } finally {
    restore();
  }
  assert.equal(Date, OriginalDate);
});

void test("probe failure recording preserves frozen and primitive primary failures", async () => {
  const source = stripTypeScriptTypes(
    await readFile(new URL("./renovate-engine-probe.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  const marker = source.indexOf('report.state = "failed";');
  const start = source.lastIndexOf("} catch (error) {", marker);
  const end = source.indexOf("  return { report, reference: reportPath };", marker);
  assert.ok(start >= 0 && end > start);
  const tail = source.slice(start, end);
  const readOnly = Object.defineProperty(
    new Error("read-only report reference"),
    "reportReference",
    { value: "original-evidence.json" },
  );
  const inheritedReadOnly = new Error("inherited read-only report reference");
  const inheritedPrototype: unknown = Object.create(Error.prototype, {
    reportReference: { get: () => "original-evidence.json" },
  });
  assert.ok(isRecord(inheritedPrototype));
  Object.setPrototypeOf(inheritedReadOnly, inheritedPrototype);
  for (const primary of [
    readOnly,
    inheritedReadOnly,
    Object.freeze(new Error("frozen engine failure")),
    null,
    undefined,
    false,
    0,
    "",
    Symbol("engine-failure"),
  ]) {
    const report: { state: string; failure?: string } = { state: "running" };
    let restored = 0,
      saved = 0;
    const action: unknown = runInNewContext(
      `"use strict"; (async () => {let loggerStream; try {throw primary; ${tail}})()`,
      {
        primary,
        report,
        reportPath: "owned-report.json",
        errorMessage,
        isRecord,
        restoreClock: () => {
          restored++;
        },
        save: () => {
          saved++;
        },
      },
    );
    await assert.rejects(Promise.resolve(action), (error: unknown) => error === primary);
    assert.equal(report.state, "failed");
    assert.equal(report.failure, errorMessage(primary));
    assert.equal(restored, 1);
    assert.equal(saved, 1);
  }
});
import { pathToFileURL } from "node:url";

void test("pinned engine class export retains static configuration method receivers", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "renovate-global-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modulePath = path.join(root, "global.mjs");
  writeFileSync(
    modulePath,
    `export class GlobalConfig {
    static config = {};
    static set(config) { if (this !== GlobalConfig) throw new Error("lost static receiver"); this.config = config; }
    static get() { if (this !== GlobalConfig) throw new Error("lost static receiver"); return this.config; }
  }`,
  );
  const loaded: unknown = await import(pathToFileURL(modulePath).href);
  assert.ok(isRecord(loaded));
  assert.equal(typeof loaded.GlobalConfig, "function");
  const config = validateGlobalConfig(loaded.GlobalConfig);
  config.set({ localDir: "owned-workspace", allowScripts: false });
  assert.deepEqual(config.get(), { localDir: "owned-workspace", allowScripts: false });
  config.set({ localDir: "owned-maintenance" });
  assert.deepEqual(config.get(), { localDir: "owned-maintenance" });
  for (const invalid of [null, {}, { set: () => {}, get: "not callable" }])
    assert.throws(() => validateGlobalConfig(invalid), /export required|callable/);
});
