import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeExtraction,
  validatePresetResult,
  validateLookupResult,
  validateCommandRecords,
  validateEngine,
  freezeProbeClock,
  validateArtifactResult,
} from "./renovate-engine-probe.mjs";
test("artifact contents normalize real Buffer results and reject ambiguous shapes", () => {
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
test("probe freezes both new Date and Date.now and restores the real clock", () => {
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
test("probe rejects incorrect extraction, preset and Result assumptions before artifacts", () => {
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
test("command evidence cannot silently omit or accept empty records", () => {
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
test("engine version mismatch requires new capture instead of reusing a fixture", () => {
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
