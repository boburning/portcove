import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "./runtime-values.mts";
import {
  qualificationNextestRecipe,
  qualificationNextestSelection,
  runQualificationNextest,
} from "./qualification-nextest.mts";
import oracle from "./fixtures/nextest-inventory-baseline.json" with { type: "json" };
import pins from "../.github/quality-tools.json" with { type: "json" };
import type { NextestSkipRoute } from "./nextest-skip-routes.mts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/nextest-outcomes/${name}`, import.meta.url), "utf8");
const complete = () => JSON.parse(fixture("inventory.json")) as unknown;
function selected(name = "passed") {
  const value = complete();
  assert.ok(isRecord(value) && isRecord(value["rust-suites"]));
  const suite = Object.values(value["rust-suites"])[0];
  assert.ok(isRecord(suite) && isRecord(suite.testcases));
  for (const [testName, entry] of Object.entries(suite.testcases)) {
    assert.ok(isRecord(entry));
    if (testName !== name && entry.ignored === false)
      entry["filter-match"] = { status: "mismatch", reason: "expression" };
  }
  return value;
}
function directory(t: TestContext) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pcv-qualification-outcomes-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, ".github"));
  writeFileSync(path.join(cwd, ".node-version"), process.versions.node);
  writeFileSync(path.join(cwd, ".github", "quality-tools.json"), JSON.stringify(pins));
  return cwd;
}
function record(value: unknown) {
  assert.ok(isRecord(value));
  return value;
}
function packet(cwd: string) {
  const base = path.join(cwd, "work", "test-results");
  const entries = readdirSync(base);
  assert.equal(entries.length, 1);
  const output = path.join(base, entries[0]!);
  return {
    output,
    receipt: record(JSON.parse(readFileSync(path.join(output, "receipt.json"), "utf8"))),
  };
}
function nativeControl(
  cwd: string,
  options: {
    status?: number;
    inventory?: unknown;
    complete?: unknown;
    version?: string;
    discoveryStatus?: number;
    stdout?: string;
    report?: (text: string) => void;
    head?: string;
    diagnostic?: (text: string) => void;
    receiptFailure?: boolean;
    skipRoutes?: readonly NextestSkipRoute[];
  } = {},
) {
  const calls: string[][] = [];
  const records: string[] = [];
  const invoke = () =>
    runQualificationNextest("workspace-other", undefined, {
      cwd,
      skipRoutes: options.skipRoutes ?? [
        {
          package: "portcove-nextest-protocol",
          test: "ignored",
          source: "crates/portcove-nextest-protocol/src/lib.rs",
          platforms: ["linux", "darwin", "win32"],
          reason: "controlled native ignored fixture",
          category: "explicit-acceptance",
        },
      ],
      environment: {
        PORTCOVE_HEAD_SHA: options.head ?? "b".repeat(40),
        GITHUB_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "12",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: "fixture",
      },
      report: options.report ?? ((text) => records.push(text)),
      ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
      ...(options.receiptFailure
        ? {
            publishReceipt() {
              throw new Error("fixture receipt unavailable");
            },
          }
        : {}),
      spawnSync(command, args) {
        calls.push([command, ...args]);
        if (command === "git") return { status: 0, stdout: "a".repeat(40) + "\n" };
        if (args[0] === "--version")
          return {
            status: 0,
            stdout: options.version ?? "cargo-nextest 0.9.100 (7e6129fe2 2025-07-07)\n",
          };
        if (args[1] === "list")
          return {
            status: options.discoveryStatus ?? 0,
            stdout: JSON.stringify(
              args.includes("-E")
                ? (options.complete ?? complete())
                : (options.inventory ?? selected()),
            ),
          };
        assert.equal(args[1], "run");
        return { status: options.status ?? 0, stdout: options.stdout ?? fixture("passed.jsonl") };
      },
    });
  return { calls, records, invoke };
}

void test("qualification recipes preserve the three frozen commands without new profiles or selectors", () => {
  const cwd = "/owned/workspace";
  assert.equal(
    "cargo nextest run " +
      qualificationNextestRecipe("workspace-other", undefined, cwd).selected.join(" "),
    oracle.commands[0],
  );
  assert.equal(
    "cargo nextest run " + qualificationNextestRecipe("native", "hash:1/1", cwd).selected.join(" "),
    oracle.commands[1]!.replace('"${{ matrix.partition }}"', "hash:1/1"),
  );
  for (const partition of ["hash:1/2", "hash:2/2"])
    assert.equal(
      "cargo nextest run " + qualificationNextestRecipe("intel", partition, cwd).selected.join(" "),
      oracle.commands[2]!.replace('"$PWD"', cwd).replace('"${{ matrix.partition }}"', partition),
    );
  for (const [mode, partition] of [
    ["other", undefined],
    ["workspace-other", "hash:1/1"],
    ["native", "hash:1/2"],
    ["intel", "hash:3/3"],
    ["intel", undefined],
  ])
    assert.throws(() => qualificationNextestRecipe(mode!, partition, cwd));
});

void test("qualification selection refuses empty, foreign and mutated binary inventories", () => {
  assert.equal(qualificationNextestSelection(complete(), selected()).outcomes.selected.size, 1);
  assert.equal(qualificationNextestSelection(complete(), selected()).compiledCount, 3);
  for (const id of ["empty", "ignored-only", "truncated-count", "wrong-binary-identity"])
    assert.throws(() =>
      qualificationNextestSelection(complete(), oracle.cases.find((item) => item.id === id)!.input),
    );
  const changed = selected();
  const suite = record(Object.values(record(record(changed)["rust-suites"]))[0]);
  suite.kind = "bin";
  assert.throws(() => qualificationNextestSelection(complete(), changed), /binary metadata/u);
  suite["package-name"] = "foreign";
  assert.throws(() => qualificationNextestSelection(complete(), changed), /escaped/u);
});

void test("qualification keeps original execution argv and records complete, selected and original outcomes", (t) => {
  const cwd = directory(t),
    control = nativeControl(cwd);
  assert.equal(control.invoke(), 0);
  assert.deepEqual(control.calls.at(-1), [
    "cargo-nextest",
    "nextest",
    "run",
    "--locked",
    "--workspace",
    "--exclude",
    "portcove-core",
    "--message-format",
    "libtest-json-plus",
    "--message-format-version",
    "0.1",
  ]);
  assert.deepEqual(
    control.calls.filter((args) => args[2] === "list").map((args) => args.slice(3)),
    [
      [
        "--locked",
        "--workspace",
        "--exclude",
        "portcove-core",
        "-E",
        "all()",
        "--message-format",
        "json",
      ],
      ["--locked", "--workspace", "--exclude", "portcove-core", "--message-format", "json"],
    ],
  );
  const { output, receipt } = packet(cwd);
  assert.equal(receipt.status, 0);
  assert.equal(receipt.native_status, 0);
  assert.equal(receipt.complete, true);
  assert.equal(
    readFileSync(path.join(output, "selected-inventory.stdout"), "utf8"),
    JSON.stringify(selected()),
  );
  const outcomes = readFileSync(path.join(output, "outcomes.log"), "utf8");
  assert.ok(outcomes.startsWith(fixture("passed.jsonl")));
  const observed = control.records.find((line) => line.startsWith("Rust test case observation: "));
  assert.ok(observed);
  const value = record(JSON.parse(observed.slice("Rust test case observation: ".length)));
  assert.equal(value.source, "b".repeat(40));
  assert.equal(value.checkout, "a".repeat(40));
  assert.equal(value.run, "12");
  assert.equal(value.outcome, "passed");
  assert.equal(
    record(JSON.parse(readFileSync(path.join(output, "request.json"), "utf8"))).profile,
    "default",
  );
});

void test("qualification preserves native failure and refuses incomplete or contradictory success", (t) => {
  for (const [status, inventory, stdout, expected] of [
    [100, selected("failing"), fixture("failing.jsonl"), 100],
    [0, selected("failing"), fixture("failing.jsonl"), 1],
    [0, selected(), "", 1],
  ] as const) {
    const cwd = directory(t),
      control = nativeControl(cwd, { status, inventory, stdout });
    assert.equal(control.invoke(), expected);
    assert.equal(packet(cwd).receipt.native_status, status);
    assert.equal(packet(cwd).receipt.complete, false);
  }
});

void test("failed discovery, empty selection and wrong tool/runtime pins never start tests", (t) => {
  for (const options of [
    { discoveryStatus: 77 },
    { inventory: oracle.cases.find((item) => item.id === "empty")!.input },
    { version: "cargo-nextest 0.9.101 (other)" },
  ]) {
    const cwd = directory(t),
      control = nativeControl(cwd, options);
    assert.equal(control.invoke(), options.discoveryStatus ?? 1);
    assert.ok(!control.calls.some((args) => args[2] === "run"));
    assert.equal(packet(cwd).receipt.complete, false);
  }
  const cwd = directory(t);
  writeFileSync(path.join(cwd, ".node-version"), "0.0.0");
  const control = nativeControl(cwd);
  assert.equal(control.invoke(), 1);
  assert.equal(control.calls.length, 0);
});

void test("manual qualification binds an empty classifier head to actual checkout and rejects malformed labels", (t) => {
  const cwd = directory(t),
    control = nativeControl(cwd, { head: "" });
  assert.equal(control.invoke(), 0);
  const line = control.records.find((text) => text.startsWith("Rust test case observation: "));
  assert.ok(line);
  assert.equal(
    record(JSON.parse(line.slice("Rust test case observation: ".length))).source,
    "a".repeat(40),
  );
  for (const head of [" ", "malformed", "g".repeat(40)]) {
    const bad = nativeControl(directory(t), { head });
    assert.equal(bad.invoke(), 1);
    assert.ok(!bad.calls.some((args) => args[2] === "run"));
  }
});

void test("qualification reporting failure retains native failure through receipt and diagnostic failures", (t) => {
  for (const status of [0, 100]) {
    for (const receiptFailure of [false, true]) {
      const cwd = directory(t);
      let diagnosticCalls = 0;
      const control = nativeControl(cwd, {
        status,
        receiptFailure,
        diagnostic() {
          diagnosticCalls++;
          throw new Error("fixture stderr unavailable");
        },
        report(text) {
          if (!text.startsWith("Rust qualification selection observation: "))
            throw new Error("fixture report unavailable");
        },
      });
      assert.equal(control.invoke(), status || 1);
      assert.ok(diagnosticCalls > 0);
      if (!receiptFailure) {
        assert.equal(packet(cwd).receipt.native_status, status);
        assert.equal(packet(cwd).receipt.complete, false);
      }
    }
  }
});

void test("successful native execution cannot pass when its receipt and diagnostic publication fail", (t) => {
  const cwd = directory(t);
  let diagnostics = 0;
  const control = nativeControl(cwd, {
    receiptFailure: true,
    diagnostic() {
      diagnostics++;
      throw new Error("fixture stderr unavailable");
    },
  });
  assert.equal(control.invoke(), 1);
  assert.ok(diagnostics > 0);
  assert.ok(control.calls.some((args) => args[2] === "run"));
  assert.ok(control.records.some((text) => text.startsWith("Rust test execution inventory: ")));
});

void test("qualification CLI runtime closure loads without repository packages or package installation", (t) => {
  const cwd = directory(t);
  for (const name of [
    "qualification-nextest.mts",
    "nextest-skip-routes.mts",
    "nextest-outcomes.mts",
    "runtime-values.mts",
    "report-summary.mts",
    "bounded-summary.mts",
    "fallow-summary.mts",
  ])
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), path.join(cwd, name));
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const api=await import(process.argv[1]); if(typeof api.runQualificationNextest!=="function") process.exit(1);',
      pathToFileURL(path.join(cwd, "qualification-nextest.mts")).href,
    ],
    { cwd, encoding: "utf8", timeout: 30000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
});

void test("unexpected ignored cases fail qualification after preserving original native execution", (t) => {
  for (const status of [0, 17]) {
    const cwd = directory(t);
    const control = nativeControl(cwd, { status, skipRoutes: [] });
    assert.equal(control.invoke(), status || 1);
    assert.equal(control.calls.at(-1)?.[2], "run");
    const retained = packet(cwd);
    assert.equal(retained.receipt.native_status, status);
    assert.equal(retained.receipt.complete, false);
    assert.match(String(retained.receipt.failure), /Unregistered Rust skip/u);
    const skips: unknown = JSON.parse(
      readFileSync(path.join(retained.output, "skip-routes.json"), "utf8"),
    );
    assert.ok(isRecord(skips) && Array.isArray(skips.errors) && skips.errors.length === 1);
  }
});
