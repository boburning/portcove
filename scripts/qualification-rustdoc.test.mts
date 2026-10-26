import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parseRustdocOutcomes } from "./rustdoc-outcomes.mts";
import { qualificationRustdocRecipe, runQualificationRustdoc } from "./qualification-rustdoc.mts";

const fixture = (name: string) =>
  readFileSync(new URL("./fixtures/rustdoc-outcomes/" + name + ".jsonl", import.meta.url), "utf8");
// Retained Rust1.99.1 observations; only the failure fixture's disposable path was normalized.
const merged = fixture("merged");
const failed = fixture("failed");
const records = (raw: string) =>
  raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const encode = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const zero = encode([
  { type: "suite", event: "started", test_count: 0 },
  {
    type: "suite",
    event: "ok",
    passed: 0,
    failed: 0,
    ignored: 0,
    measured: 0,
    filtered_out: 0,
    exec_time: 0.001,
  },
]);

void test("documentation recipes retain both original independent Cargo scopes", () => {
  assert.deepEqual(qualificationRustdocRecipe("workspace"), [
    "test",
    "--locked",
    "--workspace",
    "--exclude",
    "portcove-desktop",
    "--doc",
  ]);
  assert.deepEqual(qualificationRustdocRecipe("desktop"), [
    "test",
    "--locked",
    "-p",
    "portcove-desktop",
    "--doc",
  ]);
  assert.throws(() => qualificationRustdocRecipe("native"), /documentation scope/u);
});

void test("real merged doctest identities reconcile without counting compilation as execution", () => {
  const report = parseRustdocOutcomes(merged);
  assert.equal(report.complete, true);
  assert.equal(report.discovered, 8);
  assert.equal(report.selected, 8);
  assert.equal(report.executed, 6);
  assert.equal(report.skipped, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.observed_suites, 4);
  assert.equal(new Set(report.cases.map((entry) => entry.identity)).size, 8);
  assert.deepEqual(report.phases, [
    { total_seconds: 2.166249026, compilation_seconds: 2.109089419 },
    { total_seconds: 0.340493866, compilation_seconds: 0.312142619 },
  ]);
  for (const entry of report.cases.filter((entry) => entry.outcome === "skipped")) {
    assert.equal(entry.duration_ms, null);
    assert.equal(entry.skip_reason, null);
  }
});

void test("real assertion failure, compile-fail and should-panic results preserve native semantics", () => {
  const report = parseRustdocOutcomes(failed);
  assert.equal(report.complete, true);
  assert.equal(report.discovered, 5);
  assert.equal(report.executed, 4);
  assert.equal(report.skipped, 1);
  assert.equal(report.failed, 1);
  assert.match(
    report.cases.find((entry) => entry.outcome === "failed")?.failure ?? "",
    /retained original failure/u,
  );
  assert.equal(
    report.cases.find((entry) => entry.identity.endsWith("(line 10)"))?.outcome,
    "passed",
  );
  assert.equal(
    report.cases.find((entry) => entry.identity.endsWith("(line 13)"))?.outcome,
    "passed",
  );
});

void test("only an explicit native zero suite proves zero available doctests", () => {
  assert.equal(parseRustdocOutcomes(zero).complete, true);
  assert.equal(parseRustdocOutcomes(zero).executed, 0);
  assert.equal(parseRustdocOutcomes("").complete, false);
  const filtered = records(zero);
  filtered[1]!.filtered_out = 1;
  assert.equal(parseRustdocOutcomes(encode(filtered)).complete, false);
});

void test("duplicate document names across merged suites and ordinary libtest names are refused", () => {
  assert.equal(parseRustdocOutcomes(merged + merged).complete, false);
  assert.equal(
    parseRustdocOutcomes(merged.replaceAll("a/src/lib.rs - (line 1)", "same_name")).complete,
    false,
  );
});

void test("non-string outcome tags cannot impersonate native libtest events", () => {
  const malformed = records(failed);
  malformed.find((row) => row.type === "test" && row.event === "failed")!.event = ["failed"];
  assert.equal(parseRustdocOutcomes(encode(malformed)).complete, false);
});

void test("missing, contradictory, unbounded and unknown protocol observations remain incomplete", () => {
  const mutations: ((rows: Record<string, unknown>[]) => void)[] = [
    (rows) => {
      rows.pop();
      rows.pop();
    },
    (rows) => {
      rows[0]!.test_count = 16_385;
    },
    (rows) => {
      rows.find((row) => row.event === "ok" && row.type === "test")!.exec_time = -1;
    },
    (rows) => {
      rows.find((row) => row.event === "ok" && row.type === "test")!.exec_time = 1e308;
    },
    (rows) => {
      rows.find((row) => row.type === "suite" && row.event === "ok")!.passed = 9;
    },
    (rows) => {
      rows.find((row) => row.type === "suite" && row.event === "ok")!.event = "failed";
    },
    (rows) => {
      rows.find((row) => row.type === "test" && row.event === "ok")!.event = "unknown";
    },
    (rows) => {
      rows.find((row) => row.type === "report")!.compilation_time = 999;
    },
    (rows) => {
      rows.splice(1, 0, { type: "suite", event: "started", test_count: 1 });
    },
  ];
  for (const mutate of mutations) {
    const rows = records(merged);
    mutate(rows);
    const report = parseRustdocOutcomes(encode(rows));
    assert.equal(report.complete, false);
    assert.equal(report.discovered, null);
  }
  assert.equal(parseRustdocOutcomes(merged + "not json\n").complete, false);
  assert.equal(parseRustdocOutcomes(" ".repeat(1024 * 1024) + "{}").complete, false);
  assert.match(parseRustdocOutcomes(" ".repeat(32 * 1024 * 1024 + 1)).failure ?? "", /byte limit/u);
});

function context(t: TestContext, raw: string, status = 0) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "portcove-rustdoc-report-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(path.join(cwd, ".node-version"), process.versions.node + "\n");
  writeFileSync(path.join(cwd, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.99.1"\n');
  const environment = { PORTCOVE_HEAD_SHA: "a".repeat(40), GITHUB_RUN_ID: "123" };
  const calls: { command: string; args: string[]; bootstrap: string | undefined }[] = [];
  const dependencies = {
    cwd,
    environment,
    spawnSync(command: string, args: string[]) {
      const stdout =
        command === "git"
          ? args[0] === "status"
            ? ""
            : "b".repeat(40)
          : command === "rustc"
            ? "rustc 1.99.1 (fixture)\nrelease: 1.99.1"
            : "cargo 1.99.1 (fixture)";
      return { status: 0, stdout };
    },
    publishRaw() {},
    spawn(command: string, args: string[], options: SpawnOptions) {
      calls.push({ command, args, bootstrap: options?.env?.RUSTC_BOOTSTRAP });
      return spawn(
        process.execPath,
        [
          "-e",
          "if(process.env.RUSTC_BOOTSTRAP!=='-1')process.exit(77);process.stdout.write(" +
            JSON.stringify(raw) +
            ",()=>process.stderr.write('original stderr\\n',()=>process.exit(" +
            String(status) +
            ")))",
        ],
        options,
      );
    },
  };
  const packet = () => {
    const directory = path.join(cwd, "work/test-results");
    return path.join(directory, readdirSync(directory)[0]!);
  };
  const receipt = () =>
    JSON.parse(readFileSync(path.join(packet(), "receipt.json"), "utf8")) as Record<
      string,
      unknown
    >;
  return { cwd, dependencies, calls, packet, receipt };
}

void test("actual child captures stream bytes, source/checkout and isolated stable environment", async (t) => {
  const ctx = context(t, merged);
  const before = { ...ctx.dependencies.environment };
  assert.equal(await runQualificationRustdoc("workspace", ctx.dependencies), 0);
  assert.deepEqual(ctx.dependencies.environment, before);
  assert.equal(ctx.calls[0]?.command, "cargo");
  assert.equal(ctx.calls[0]?.bootstrap, "-1");
  assert.deepEqual(ctx.calls[0]?.args, [
    ...qualificationRustdocRecipe("workspace"),
    "--",
    "--format=json",
    "-Zunstable-options",
    "--report-time",
  ]);
  const report = ctx.receipt();
  assert.equal(report.source, "a".repeat(40));
  assert.equal(report.checkout, "b".repeat(40));
  assert.equal(report.complete, true);
  assert.equal(report.executed, 6);
  assert.equal(report.native_status, 0);
  assert.equal(readFileSync(path.join(ctx.packet(), "stdout.jsonl"), "utf8"), merged);
  assert.equal(readFileSync(path.join(ctx.packet(), "stderr.txt"), "utf8"), "original stderr\n");
  assert.equal(report.stdout_sha256, createHash("sha256").update(merged).digest("hex"));
  assert.equal((report.child_environment as Record<string, unknown>).RUSTC_BOOTSTRAP, "-1");
});

void test("native failure remains primary even if receipt publication fails", async (t) => {
  const ctx = context(t, failed, 101);
  assert.equal(
    await runQualificationRustdoc("workspace", {
      ...ctx.dependencies,
      publishReceipt() {
        throw new Error("injected receipt failure");
      },
    }),
    101,
  );
  assert.equal(readFileSync(path.join(ctx.packet(), "stdout.jsonl"), "utf8"), failed);
  assert.match(readFileSync(path.join(ctx.packet(), "stderr.txt"), "utf8"), /original stderr/u);
});

void test("complete failing suite observations cannot establish whole-recipe completion", async (t) => {
  const ctx = context(t, failed, 101);
  assert.equal(await runQualificationRustdoc("workspace", ctx.dependencies), 101);
  assert.equal(ctx.receipt().complete, false);
  assert.equal(ctx.receipt().stream_complete, true);
  assert.equal(ctx.receipt().scope_complete, false);
  assert.equal(ctx.receipt().discovered, null);
  assert.equal(ctx.receipt().observed_discovered, 5);
  assert.equal(ctx.receipt().native_status, 101);
  assert.equal(ctx.receipt().failed, 1);
});

void test("passing prefix suites followed by a later Cargo failure retain unknown full discovery", async (t) => {
  const ctx = context(t, merged, 101);
  assert.equal(await runQualificationRustdoc("workspace", ctx.dependencies), 101);
  const report = ctx.receipt();
  assert.equal(report.complete, false);
  assert.equal(report.scope_complete, false);
  assert.equal(report.stream_complete, true);
  assert.equal(report.discovered, null);
  assert.equal(report.selected, null);
  assert.equal(report.observed_discovered, 8);
  assert.equal(report.executed, 6);
  assert.equal(report.failed, 0);
  assert.equal(report.native_status, 101);
});

void test("empty, incomplete and contradictory successful children cannot produce a passing wrapper", async (t) => {
  for (const raw of ["", encode(records(merged).slice(0, -2)), failed]) {
    const ctx = context(t, raw);
    assert.equal(await runQualificationRustdoc("desktop", ctx.dependencies), 1);
    assert.equal(ctx.receipt().complete, false);
  }
});

void test("a raw output sink failure cannot replace the original native failure", async (t) => {
  const ctx = context(t, failed, 101);
  assert.equal(
    await runQualificationRustdoc("workspace", {
      ...ctx.dependencies,
      publishRaw() {
        throw new Error("injected output failure");
      },
    }),
    101,
  );
  assert.equal(ctx.receipt().complete, false);
  assert.match(String(ctx.receipt().reporting_failure), /injected output failure/u);
  assert.equal(readFileSync(path.join(ctx.packet(), "stdout.jsonl"), "utf8"), failed);
});

void test("explicit zero Desktop observations remain distinct from successful compilation alone", async (t) => {
  const ctx = context(t, zero);
  assert.equal(await runQualificationRustdoc("desktop", ctx.dependencies), 0);
  assert.equal(ctx.receipt().discovered, 0);
  assert.equal(ctx.receipt().executed, 0);
});

void test("successful native execution still refuses a lost receipt or bootstrap override", async (t) => {
  const ctx = context(t, merged);
  assert.equal(
    await runQualificationRustdoc("workspace", {
      ...ctx.dependencies,
      publishReceipt() {
        throw new Error("injected receipt failure");
      },
    }),
    1,
  );
  await assert.rejects(
    runQualificationRustdoc("workspace", {
      ...ctx.dependencies,
      environment: { RUSTC_BOOTSTRAP: "1" },
    }),
    /bootstrap overrides/u,
  );
  assert.equal(ctx.calls.length, 1);
});

void test("invalid UTF-8 retains original bytes and their digest without a complete report", async (t) => {
  const ctx = context(t, "");
  assert.equal(
    await runQualificationRustdoc("workspace", {
      ...ctx.dependencies,
      spawn(_command, _args, options) {
        return spawn(
          process.execPath,
          ["-e", "process.stdout.write(Buffer.from([255]),()=>process.exit(0))"],
          options,
        );
      },
    }),
    1,
  );
  const raw = readFileSync(path.join(ctx.packet(), "stdout.jsonl"));
  assert.deepEqual(raw, Buffer.from([255]));
  assert.equal(ctx.receipt().stdout_sha256, createHash("sha256").update(raw).digest("hex"));
  assert.match(String(ctx.receipt().reporting_failure), /UTF-8/u);
});

void test("stream caps retain a bounded prefix, drain the child and preserve its original failure", async (t) => {
  const ctx = context(t, "");
  assert.equal(
    await runQualificationRustdoc("workspace", {
      ...ctx.dependencies,
      spawn(_command, _args, options) {
        return spawn(
          process.execPath,
          ["-e", "process.stdout.write(Buffer.alloc(32*1024*1024+17,32),()=>process.exit(7))"],
          options,
        );
      },
    }),
    7,
  );
  const report = ctx.receipt();
  assert.equal(report.complete, false);
  assert.equal(report.native_status, 7);
  assert.equal(report.observed_stdout_bytes, 32 * 1024 * 1024 + 17);
  assert.equal(report.retained_stdout_bytes, 32 * 1024 * 1024);
  assert.equal(statSync(path.join(ctx.packet(), "stdout.jsonl")).size, 32 * 1024 * 1024);
  assert.match(String(report.reporting_failure), /byte limit/u);
});

void test("a process observation error cannot replace a known original native failure", async (t) => {
  const ctx = context(t, failed, 101);
  const start = ctx.dependencies.spawn;
  assert.equal(
    await runQualificationRustdoc("workspace", {
      ...ctx.dependencies,
      spawn(command, args, options) {
        const child = start(command, args, options);
        queueMicrotask(() =>
          child.emit("error", new Error("injected process observation failure")),
        );
        return child;
      },
    }),
    101,
  );
  assert.equal(ctx.receipt().native_status, 101);
  assert.equal(ctx.receipt().complete, false);
  assert.match(String(ctx.receipt().process_error), /injected process observation failure/u);
});
