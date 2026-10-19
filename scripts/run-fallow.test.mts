import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { evaluateFallowReport } from "./check-fallow-report.mts";
import { CommandFailure } from "./report-summary.mts";
import { isRecord } from "./runtime-values.mts";
import type { FallowOptions, FallowSpawn } from "./run-fallow.mts";
const fixtureIdentity = (
  overrides: Partial<ReturnType<NonNullable<FallowOptions["identity"]>>> = {},
) => ({
  head: "fixture",
  source_sha256: "test",
  dirty: false,
  target: null,
  merge_base: null,
  ...overrides,
});
import { report } from "./fallow-test-fixture.mts";
import {
  fallowArguments,
  formatFallowFailure,
  runFallow as runFallowCommand,
} from "./run-fallow.mts";

// Unit fixtures never publish into the enclosing Actions job's real summary.
const runFallow = (options: FallowOptions) => runFallowCommand({ jobSummary: null, ...options });

void test("native parser degradation cannot establish whole-Desktop qualification", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fallow-native-parse-"));
  try {
    // Maintained test runners place temp directories beneath the checkout. A
    // separate Git boundary prevents a tiny parser control importing its history.
    const init = spawnSync("git", ["init", "-b", "main"], { cwd: directory, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    writeFileSync(path.join(directory, "package.json"), '{"private":true,"type":"module"}');
    writeFileSync(path.join(directory, ".fallowrc.json"), '{"entry":["entry.ts"]}');
    const spawn: FallowSpawn = (command, args, options) => {
      const nativeArgs = [...args];
      nativeArgs[nativeArgs.indexOf("--root") + 1] = directory;
      if (readFileSync(path.join(directory, "entry.ts"), "utf8").includes("broken")) {
        const unarmed = spawnSync(
          command,
          nativeArgs.filter((arg) => arg !== "--fail-on-parse-error"),
          { ...options, cwd: directory, timeout: 30_000 },
        );
        assert.ifError(unarmed.error);
        assert.equal(unarmed.status, 0, unarmed.stderr);
        const report: unknown = JSON.parse(unarmed.stdout);
        assert.deepEqual(
          evaluateFallowReport(report).failures,
          [],
          "reproduce native opt-in contract",
        );
        assert.throws(
          () => evaluateFallowReport(report, { requireParseGate: true }),
          /not enforced/,
        );
      }
      return spawnSync(command, nativeArgs, { ...options, cwd: directory, timeout: 30_000 });
    };
    for (const state of ["parse-degraded", "unreadable", "valid"]) {
      writeFileSync(
        path.join(directory, "entry.ts"),
        state === "parse-degraded"
          ? "export const broken = ;"
          : state === "unreadable"
            ? Buffer.from([0xff, 0xfe, 0xfd])
            : 'console.log("valid");',
      );
      const result = runFallow({
        spawn,
        identity: () => fixtureIdentity(),
        evidenceDirectory: path.join(directory, state),
      });
      assert.equal(result.exitCode, state === "valid" ? 0 : 1, result.text);
      if (state === "parse-degraded")
        assert.match(result.text, /enforced Fallow gate failed: parse-error/);
      else if (state === "unreadable")
        assert.match(result.text, /required source analysis incomplete: source-read-failure/);
      else assert.match(result.text, /gate passed/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("reuse binds effective options and external coverage bytes, not normalized environment spelling", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fallow-options-"));
  const coverage = path.join(directory, "coverage.json");
  const identity = () => fixtureIdentity();
  let calls = 0;
  const spawn: FallowSpawn = (_command, _args, options) => {
    calls++;
    assert.equal(options.env?.FALLOW_PRODUCTION, undefined);
    return { status: 0, stdout: JSON.stringify(report()), stderr: "" };
  };
  try {
    writeFileSync(coverage, "{}");
    const environment = { FALLOW_COVERAGE: coverage, FALLOW_PRODUCTION: "true" };
    const first = runFallow({
      identity,
      spawn,
      environment,
      evidenceDirectory: path.join(directory, "first"),
    });
    const reuse = (environment: NodeJS.ProcessEnv) =>
      runFallow({
        identity,
        spawn,
        environment,
        reuse: first.evidenceDirectory,
        evidenceDirectory: path.join(directory, `reuse-${calls}`),
      });
    assert.equal(
      reuse({ ...environment, FALLOW_PRODUCTION: "false", FALLOW_FORMAT: "human" }).exitCode,
      0,
    );
    assert.equal(calls, 1);
    assert.throws(() => reuse({ ...environment, PORTCOVE_FALLOW_THREADS: "3" }), /reuse refused/);
    assert.throws(
      () => reuse({ ...environment, FALLOW_COVERAGE_ROOT: directory }),
      /reuse refused/,
    );
    writeFileSync(coverage, '{"changed":true}');
    assert.throws(() => reuse(environment), /reuse refused/);
    writeFileSync(coverage, "{}");
    const metadata = JSON.parse(
      readFileSync(path.join(first.evidenceDirectory, "metadata.json"), "utf8"),
    ) as { stdout: string };
    writeFileSync(metadata.stdout, "changed retained bytes");
    assert.throws(() => reuse(environment), /retained bytes changed/);
    assert.throws(() => reuse({ FALLOW_DIFF_FILE: "filtered.diff" }), /incompatible/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("Fallow child and parse failures retain raw streams with bounded diagnostics", () => {
  const evidenceDirectory = mkdtempSync(path.join(os.tmpdir(), "fallow-error-"));
  try {
    for (const [status, stderr] of [
      [2, "x".repeat(15_850)],
      [2, "界".repeat(20_000)],
      [0, "界".repeat(20_000)],
    ] as const) {
      assert.throws(
        () =>
          runFallow({
            evidenceDirectory,
            identity: () => fixtureIdentity(),
            spawn: () => ({ status, stdout: "invalid JSON", stderr }),
          }),
        (error: unknown) => {
          assert(error instanceof CommandFailure);
          assert(error.evidence.stdout && error.evidence.stderr);
          const displayed = formatFallowFailure(error);
          assert.ok(Buffer.byteLength(displayed) + 1 <= 16 * 1024);
          assert.ok(displayed.includes(error.evidence.stdout));
          assert.ok(displayed.includes(error.evidence.stderr));
          assert.equal(readFileSync(error.evidence.stderr, "utf8"), stderr);
          assert.equal(readFileSync(error.evidence.stdout, "utf8"), "invalid JSON");
          assert.match(displayed, status === 2 ? /exit 2/ : /invalid JSON/);
          assert.equal(error.failure.kind, "unknown");
          return true;
        },
      );
    }
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

void test("selective routes preserve explicit full-branch review and bounded parser work", () => {
  assert.throws(() => fallowArguments("review"), /explicit comparison base/);
  for (const threads of ["0", "-1", "2.5", "NaN", "65"])
    assert.throws(() => fallowArguments("tooling", undefined, threads));
  const args = fallowArguments("review", "origin/main", "2");
  assert.ok(args.includes("review"));
  assert.equal(args[args.indexOf("--base") + 1], "origin/main");
  assert.equal(args[args.indexOf("--gate") + 1], "new-only");
  assert.ok(!args.includes("--changed-since"));
  assert.ok(fallowArguments("css").includes("--report-only"));
});

void test("successful high duplication retains actionable results and supports exact-input reuse", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fallow-reuse-"));
  let calls = 0;
  let formats = 0;
  const identity = () => fixtureIdentity({ source_sha256: "content", dirty: true });
  const baseReport = report({ duplication: 17 });
  const value = {
    ...baseReport,
    dupes: {
      ...baseReport.dupes,
      clone_groups: [
        {
          fingerprint: "dup:example",
          instances: [
            { file: "src/a.ts", start_line: 12 },
            { file: "src/b.ts", start_line: 20 },
          ],
          line_count: 8,
        },
      ],
    },
  };
  try {
    const jobSummary = path.join(directory, "summary.md");
    const spawn: FallowSpawn = (_command, args) => {
      if (args.includes("report")) {
        formats++;
        assert.ok(args.includes("--from"), "formatting must consume retained evidence");
        return { status: 0, stdout: "Saved Fallow report\n", stderr: "" };
      }
      calls++;
      return { status: 0, stdout: JSON.stringify(value), stderr: "retained warning" };
    };
    const first = runFallow({
      evidenceDirectory: path.join(directory, "first"),
      identity,
      spawn,
      jobSummary,
    });
    assert.equal(first.exitCode, 0);
    assert.match(first.text, /17%/);
    assert.match(first.text, /dup:example/);
    assert.match(first.text, /src\/a.ts:12/);
    assert.match(first.text, /dirty true/);
    const second = runFallow({
      evidenceDirectory: path.join(directory, "second"),
      reuse: first.evidenceDirectory,
      identity,
      spawn,
      jobSummary,
    });
    assert.equal(second.exitCode, 0);
    assert.equal(calls, 1);
    assert.equal(formats, 2, "reuse may format saved evidence without analyzing again");
    assert.match(readFileSync(jobSummary, "utf8"), /Saved Fallow report/);
    assert.throws(
      () =>
        runFallow({
          reuse: first.evidenceDirectory,
          identity: () => ({ ...identity(), source_sha256: "changed" }),
          spawn,
        }),
      /reuse refused/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("analyzer status and advisory review verdict never become a quality pass", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fallow-status-"));
  const identity = () => fixtureIdentity();
  try {
    const unexplained = runFallow({
      evidenceDirectory: directory,
      identity,
      spawn: () => ({ status: 1, stdout: JSON.stringify(report()), stderr: "" }),
    });
    assert.equal(unexplained.exitCode, 1);
    assert.match(unexplained.text, /unexplained analyzer exit/);
    const review = runFallow({
      mode: "review",
      base: "origin/main",
      evidenceDirectory: path.join(directory, "review"),
      identity,
      spawn: () => ({
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          kind: "audit-brief",
          schema_version: 13,
          version: "3.34.1",
          verdict: "fail",
          changed_files_count: 3,
          base_ref: "base",
          attribution: {},
          summary: {},
        }),
      }),
    });
    assert.equal(review.exitCode, 0);
    assert.match(review.text, /advisory findings, not acceptance/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("CSS and review routes accept only their reviewed report contracts", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fallow-contract-"));
  try {
    for (const mode of ["css", "review"] as const) {
      const value =
        mode === "css"
          ? { kind: "health", schema_version: 12, version: "3.34.1", summary: {}, findings: [] }
          : {
              kind: "audit-brief",
              schema_version: 13,
              version: "3.34.1",
              verdict: "warn",
              changed_files_count: 1,
              base_ref: "base",
              attribution: {},
            };
      const run = (reportValue: unknown) =>
        runFallow({
          mode,
          base: "origin/main",
          evidenceDirectory: path.join(directory, mode),
          identity: () => fixtureIdentity(),
          spawn: () => ({ status: 0, stderr: "", stdout: JSON.stringify(reportValue) }),
        });
      assert.equal(run(value).exitCode, 0);
      for (const invalid of [
        { ...value, schema_version: value.schema_version - 1 },
        { ...value, version: "3.34.2" },
        { ...value, kind: "unknown" },
      ])
        assert.throws(() => run(invalid), /Unsupported .* report/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("secondary presentation failure preserves code failure and original evidence", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fallow-presentation-"));
  try {
    let calls = 0;
    const result = runFallow({
      evidenceDirectory: directory,
      identity: () => fixtureIdentity(),
      jobSummary: path.join(directory, "summary.md"),
      spawn: () =>
        ++calls === 1
          ? { status: 0, stdout: JSON.stringify(report({ issues: 1 })), stderr: "original" }
          : { status: 2, stdout: "", stderr: "formatter error" },
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.text, /1 dead-code or dependency/);
    assert.match(result.text, /secondary/);
    const metadata: unknown = JSON.parse(
      readFileSync(path.join(directory, "metadata.json"), "utf8"),
    );
    assert(isRecord(metadata) && typeof metadata.stderr === "string");
    assert.equal(readFileSync(metadata.stderr, "utf8"), "original");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("validated Fallow findings and failed evidence retention remain distinct failures", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fallow-verdict-"));
  try {
    const stdout = JSON.stringify(report({ issues: 1 }));
    const spawn = () => ({ status: 1, stdout, stderr: "original analyzer output" });
    const result = runFallow({
      evidenceDirectory: directory,
      spawn,
      identity: () => fixtureIdentity(),
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.text, /source\/check failure/);
    assert.match(result.text, /1 dead-code or dependency findings/);
    const blocked = path.join(directory, "not-a-directory");
    writeFileSync(blocked, "preserved");
    const combined = runFallow({
      evidenceDirectory: blocked,
      spawn,
      identity: () => fixtureIdentity(),
    });
    assert.equal(combined.exitCode, 1);
    assert.match(combined.text, /source\/check failure/);
    assert.match(combined.text, /1 dead-code or dependency findings/);
    assert.match(combined.text, /evidence-collection failure \(secondary\)/);
    const healthy = report({ issues: 1 });
    healthy.check.total_issues = 0;
    const retention = runFallow({
      evidenceDirectory: blocked,
      identity: () => fixtureIdentity(),
      spawn: () => ({ status: 0, stdout: JSON.stringify(healthy), stderr: "" }),
    });
    assert.equal(retention.exitCode, 1);
    assert.match(retention.text, /evidence-collection failure/);
    assert.doesNotMatch(retention.text, /source\/check failure/);
    assert.equal(readFileSync(blocked, "utf8"), "preserved");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("retained Fallow reuse rejects malformed metadata and changed stream bytes without analysis", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fallow-reuse-invalid-"));
  try {
    const original = runFallow({
      evidenceDirectory: path.join(directory, "original"),
      identity: fixtureIdentity,
      spawn: () => ({ status: 0, stdout: JSON.stringify(report()), stderr: "retained" }),
    });
    const metadataPath = path.join(original.evidenceDirectory, "metadata.json");
    const metadata: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert(isRecord(metadata) && typeof metadata.stderr === "string");
    const noAnalysis = () => {
      assert.fail("reuse must not run the analyzer");
    };
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, stderr: [metadata.stderr] }));
    assert.throws(
      () =>
        runFallow({
          reuse: original.evidenceDirectory,
          identity: fixtureIdentity,
          spawn: noAnalysis,
        }),
      /invalid retained metadata/,
    );
    writeFileSync(metadataPath, JSON.stringify(metadata));
    writeFileSync(metadata.stderr, "changed");
    assert.throws(
      () =>
        runFallow({
          reuse: original.evidenceDirectory,
          identity: fixtureIdentity,
          spawn: noAnalysis,
        }),
      /retained bytes changed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
