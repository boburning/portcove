import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";

interface PythonCase {
  id: string;
  kind: "test" | "fixture" | "subtest";
  status: "passed" | "failed" | "error" | "skipped" | "expected-failure" | "unexpected-success";
  reason: string | null;
  additional_outcomes: { status: string; reason: string }[];
  duration_ms: number | null;
}
interface PythonReport {
  format_version: 1;
  runner: "python-unittest";
  platform: string;
  python: string;
  source: string;
  source_sha256: string;
  reporter_sha256: string;
  selected: string[];
  tests_run: number;
  suite_exit_status: number;
  exit_status: number;
  incomplete_reason: string | null;
  duration_ms: number;
  cases: PythonCase[];
}

const reporter = fileURLToPath(new URL("./python-test-results.py", import.meta.url));
const sha256 = (filename: string) =>
  createHash("sha256").update(readFileSync(filename)).digest("hex");
const duration = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function readPythonReport(text: string, suite: string, status: number | null): PythonReport {
  assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024, "Python report exceeds byte limit");
  const value: unknown = JSON.parse(text);
  assert.ok(isRecord(value), "Python report must be an object");
  assert.equal(value.format_version, 1);
  assert.equal(value.runner, "python-unittest");
  assert.equal(value.source, path.resolve(suite));
  assert.equal(value.source_sha256, sha256(suite));
  assert.equal(value.reporter_sha256, sha256(reporter));
  assert.equal(value.exit_status, status, "Python report must preserve suite exit status");
  assert.ok(status === 0 || status === 1, "Python suite did not complete normally");
  assert.ok(value.suite_exit_status === 0 || value.suite_exit_status === 1);
  assert.ok(
    value.incomplete_reason === null ||
      (typeof value.incomplete_reason === "string" &&
        Buffer.byteLength(value.incomplete_reason) <= 4096),
  );
  assert.equal(status, value.suite_exit_status || (value.incomplete_reason ? 1 : 0));
  assert.equal(
    value.platform,
    process.platform,
    "Python report must retain the executing platform",
  );
  assert.ok(typeof value.python === "string" && value.python.length > 0);
  assert.ok(duration(value.duration_ms));
  assert.ok(
    Array.isArray(value.selected) && value.selected.length > 0 && value.selected.length <= 2048,
  );
  const selected: unknown[] = value.selected;
  assert.ok(selected.every((id) => typeof id === "string" && id.length > 0));
  assert.equal(new Set(selected).size, selected.length);
  assert.ok(Number.isSafeInteger(value.tests_run) && Number(value.tests_run) >= 0);
  assert.ok(Array.isArray(value.cases) && value.cases.length > 0 && value.cases.length <= 2048);
  const cases: unknown[] = value.cases;
  const statuses = [
    "passed",
    "failed",
    "error",
    "skipped",
    "expected-failure",
    "unexpected-success",
  ];
  for (const item of cases) {
    assert.ok(isRecord(item));
    assert.ok(typeof item.id === "string" && item.id.length > 0);
    assert.ok(["test", "fixture", "subtest"].includes(String(item.kind)));
    assert.ok(statuses.includes(String(item.status)));
    assert.ok(
      item.reason === null ||
        (typeof item.reason === "string" && Buffer.byteLength(item.reason) <= 4096),
    );
    assert.ok(item.kind === "test" ? duration(item.duration_ms) : item.duration_ms === null);
    assert.ok(Array.isArray(item.additional_outcomes) && item.additional_outcomes.length <= 16);
    const additional: unknown[] = item.additional_outcomes;
    assert.ok(
      additional.every(
        (entry) =>
          isRecord(entry) &&
          statuses.includes(String(entry.status)) &&
          typeof entry.reason === "string" &&
          Buffer.byteLength(entry.reason) <= 4096,
      ),
    );
    if (item.kind === "test")
      assert.ok(selected.includes(item.id), "Executed Python case was not selected");
  }
  const completed = cases.filter((item) => isRecord(item) && item.kind === "test");
  if (value.incomplete_reason === null) assert.equal(completed.length, value.tests_run);
  const completedIds = new Set(completed.map((item) => isRecord(item) && item.id));
  assert.equal(completedIds.size, completed.length);
  const missing = selected.filter((id) => !completedIds.has(id));
  assert.ok(
    value.incomplete_reason !== null ||
      missing.every((id) =>
        cases.some((item) => {
          if (
            !isRecord(item) ||
            item.kind !== "fixture" ||
            !["error", "skipped"].includes(String(item.status))
          )
            return false;
          if (item.id === "setUpModule (_portcove_contract)") return true;
          const owner = /^setUpClass \(_portcove_contract\.(.+)\)$/u.exec(String(item.id));
          return (
            owner !== null &&
            typeof id === "string" &&
            id.slice(0, id.lastIndexOf(".")) === owner[1]
          );
        }),
      ),
    "Unexecuted Python selections require their own class/module setup failure or skip",
  );
  const failed = (item: unknown): boolean =>
    isRecord(item) &&
    (["failed", "error", "unexpected-success"].includes(String(item.status)) ||
      (Array.isArray(item.additional_outcomes) && item.additional_outcomes.some(failed)));
  if (value.incomplete_reason === null)
    assert.equal(
      cases.some(failed),
      value.suite_exit_status === 1,
      "Python suite status contradicts case outcomes",
    );
  return value as unknown as PythonReport;
}

/** Join inner results to their outer Node case; human unittest output stays visible. */
export function runPythonSuite(
  suite: URL | string,
  context: Pick<TestContext, "name" | "diagnostic">,
  timeout = 30_000,
): PythonReport {
  assert.ok(
    Number.isSafeInteger(timeout) && timeout > 0,
    "Python suite timeout must be a positive finite integer",
  );
  const filename = suite instanceof URL ? fileURLToPath(suite) : path.resolve(suite);
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-S", "-B", reporter, filename],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: 3 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.stderr) context.diagnostic(result.stderr.trim());
  let report: PythonReport;
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    report = readPythonReport(result.stdout, filename, result.status);
  } catch (error) {
    throw new Error(
      `Python reporting incomplete; original status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? "none"}`,
      { cause: error },
    );
  }
  for (const item of report.cases)
    context.diagnostic(
      `Python case: ${JSON.stringify({ outer: context.name, source: report.source, source_sha256: report.source_sha256, platform: report.platform, ...item })}`,
    );
  context.diagnostic(
    `Python inventory: ${JSON.stringify({ outer: context.name, runner: report.runner, source: report.source, source_sha256: report.source_sha256, reporter_sha256: report.reporter_sha256, platform: report.platform, python: report.python, selected: report.selected, tests_run: report.tests_run, suite_exit_status: report.suite_exit_status, exit_status: report.exit_status, incomplete_reason: report.incomplete_reason, duration_ms: report.duration_ms })}`,
  );
  assert.equal(
    report.incomplete_reason,
    null,
    `Python reporting incomplete; original suite status=${report.suite_exit_status}; process status=${result.status}; ${report.incomplete_reason}`,
  );
  assert.equal(
    result.status,
    0,
    `Python suite failed; original status=${result.status}\n${result.stderr}`,
  );
  return report;
}
