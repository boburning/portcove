import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
          version: "3.34.0",
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
          ? { kind: "health", schema_version: 12, version: "3.34.0", summary: {}, findings: [] }
          : {
              kind: "audit-brief",
              schema_version: 13,
              version: "3.34.0",
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
        { ...value, version: "3.34.1" },
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
