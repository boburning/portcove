import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeSync } from "node:fs";
import pins from "../.config/rust-coverage.json" with { type: "json" };
import {
  validateRustCoveragePins,
  rustCoverageCommands,
  rustCoverageDiscovery,
  rustCoverageOutcomes,
  rustBranchCoverage,
  publishRustCoverage,
  rustCoverageBuildPrefix,
} from "./rust-coverage.mts";

void test("Rust coverage refuses widened boundaries and mutable compiler channels", () => {
  assert.equal(validateRustCoveragePins(pins), pins);
  for (const change of [
    { toolchain: "nightly" },
    { compiler_release: "1.99.1" },
    { compiler_commit: "short" },
    { target: "x86_64-unknown-linux-gnu" },
    { package: "portcove-desktop" },
    { test_filter: "" },
    { module: "../outside.rs" },
  ])
    assert.throws(() => validateRustCoveragePins({ ...pins, ...change }), /bounded Rust/u);
  const commands = rustCoverageCommands(validateRustCoveragePins(pins), "/fresh/packet");
  assert.deepEqual(
    commands.map(({ name }) => name),
    ["discovery", "tests", "report"],
  );
  for (const { args } of commands) {
    assert.equal(args[0], "run");
    assert.equal(args[1], pins.toolchain);
    assert.ok(args.includes("--locked"));
    assert.ok(args.includes("--offline"));
    assert.equal(args[args.indexOf("--package") + 1], "portcove-core");
    assert.equal(args[args.indexOf("--target") + 1], pins.target);
    for (const forbidden of [
      "--all-features",
      "--no-default-features",
      "--features",
      "--workspace",
      "--ignore-run-fail",
      "install",
    ])
      assert.ok(!args.includes(forbidden));
  }
  assert.ok(commands[0]!.args.includes("--branch"));
  assert.ok(commands[1]!.args.includes("--test-threads=2"));
  assert.ok(!commands[0]!.args.includes("--no-clean"));
  // Pinned cargo-llvm-cov makes --no-report imply no-clean and refuses both flags.
  assert.ok(!commands[1]!.args.includes("--no-clean"));
  assert.deepEqual(
    commands.map(({ timeout_ms }) => timeout_ms),
    [1800000, 300000, 300000],
  );
});

void test("coverage builds use a fresh child of a short existing ordinary target, avoiding Windows linker paths", () => {
  assert.equal(rustCoverageBuildPrefix("C:\\target"), "C:\\target\\rcov-");
  assert.throws(() => rustCoverageBuildPrefix("relative-target"), /absolute/u);
  assert.throws(
    () => rustCoverageBuildPrefix("C:\\" + "long-directory\\".repeat(8)),
    /short existing/u,
  );
});

void test("coverage publication failures preserve the original native status even with broken diagnostics", () => {
  for (const status of [0, 23, 124]) {
    const result = {
      exit_status: status,
      complete: status === 0,
      failure: status === 0 ? null : "original native failure",
    };
    const observed = publishRustCoverage(
      result,
      () => {
        writeSync(-1, "receipt");
      },
      () => {
        throw new Error("broken stderr");
      },
    );
    assert.equal(observed, status || 1);
    assert.equal(result.complete, false);
    assert.match(result.failure!, /Coverage publication failed/u);
    if (status) assert.match(result.failure!, /original native failure/u);
  }
  const result = { exit_status: 23, complete: false, failure: "original native failure" };
  assert.equal(
    publishRustCoverage(
      result,
      () => {
        throw new Error("broken stdout");
      },
      () => {},
    ),
    23,
  );
});

void test("Rust discovery rejects empty, missing, duplicate and out-of-scope selections", () => {
  const listing = "path::one: test\npath::two: test\n\n2 tests, 0 benchmarks\n";
  assert.deepEqual(rustCoverageDiscovery(listing, "path::"), ["path::one", "path::two"]);
  for (const raw of [
    "",
    "0 tests, 0 benchmarks",
    listing.replace("2 tests", "3 tests"),
    listing.replace("path::two", "other::two"),
    listing.replace("path::two", "path::one"),
    listing.replace("0 benchmarks", "1 benchmark"),
    listing + "unknown output\n",
  ])
    assert.throws(() => rustCoverageDiscovery(raw, "path::"));
});

const events = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");
const results = [
  { type: "suite", event: "started", test_count: 2 },
  { type: "test", event: "started", name: "path::one" },
  { type: "test", event: "ok", name: "path::one", exec_time: 0.25 },
  { type: "test", event: "started", name: "path::two" },
  { type: "test", event: "failed", name: "path::two", stdout: "original assertion" },
  { type: "suite", event: "failed", passed: 1, failed: 1, ignored: 0 },
];
void test("Rust outcomes preserve native failure and require one terminal observation per selected case", () => {
  const selected = ["path::one", "path::two"];
  const measured = rustCoverageOutcomes(events(results), selected);
  assert.deepEqual(measured, [
    { name: "path::one", outcome: "ok", seconds: 0.25 },
    { name: "path::two", outcome: "failed", seconds: null },
  ]);
  for (const rows of [
    results.slice(0, -1),
    [...results.slice(0, -1), results[2], results.at(-1)],
    results.map((row) => ({ ...row, name: "other::case" })),
    [...results.slice(0, -1), { type: "suite", event: "ok", passed: 2, failed: 0, ignored: 0 }],
    [...results.slice(0, -1), { type: "suite", event: "ok", passed: 1, failed: 1, ignored: 0 }],
  ])
    assert.throws(() => rustCoverageOutcomes(events(rows), selected));
  assert.throws(() => rustCoverageOutcomes("{truncated", selected), SyntaxError);
});

void test("Rust ignored cases remain explicit rather than becoming executed passes", () => {
  assert.deepEqual(
    rustCoverageOutcomes(
      events([
        { type: "suite", event: "started", test_count: 1 },
        { type: "test", event: "ignored", name: "path::ignored" },
        { type: "suite", event: "ok", passed: 0, failed: 0, ignored: 1 },
      ]),
      ["path::ignored"],
    ),
    [{ name: "path::ignored", outcome: "ignored", seconds: null }],
  );
});

void test("Rust coverage requires a measured source file and actual branch counters", () => {
  const filename = fileURLToPath(new URL("../crates/portcove-core/src/path.rs", import.meta.url));
  const summary = {
    branches: { count: 2, covered: 1 },
    lines: { count: 5, covered: 3 },
    functions: { count: 2, covered: 1 },
    regions: { count: 4, covered: 2 },
  };
  const file = { filename, summary, branches: [[10, 2, 10, 15, 3, 0, 0, 0, 4]] };
  const report = { type: "llvm.coverage.json.export", data: [{ files: [file] }] };
  assert.deepEqual(rustBranchCoverage(report, filename), file);
  for (const changed of [
    { ...report, type: "unknown" },
    { ...report, data: [] },
    { ...report, data: [{ files: [file, file] }] },
    { ...report, data: [{ files: [{ ...file, filename: filename + ".other" }] }] },
    { ...report, data: [{ files: [{ ...file, branches: [] }] }] },
    { ...report, data: [{ files: [{ ...file, branches: [[10, 2, 10, 15, -1, 0]] }] }] },
    {
      ...report,
      data: [{ files: [{ ...file, summary: { ...summary, branches: { count: 0, covered: 0 } } }] }],
    },
    {
      ...report,
      data: [{ files: [{ ...file, summary: { ...summary, lines: { count: 1, covered: 2 } } }] }],
    },
  ])
    assert.throws(() => rustBranchCoverage(changed, filename));
});

void test("Rust coverage CLI refuses extra arguments before optional native tool inspection", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./rust-coverage.mts", import.meta.url)), "--all"],
    { encoding: "utf8", timeout: 20000, windowsHide: true },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixed opt-in preset/u);
});
