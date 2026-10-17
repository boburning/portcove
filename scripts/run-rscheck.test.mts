import assert from "node:assert/strict";
import test from "node:test";

import { assessRscheckReport, parseRscheckReport } from "./run-rscheck.mts";

void test("separates advisory findings from hard policy failures", () => {
  const assessment = assessRscheckReport({
    findings: [
      { severity: "warn", rule_id: "shape.file_complexity" },
      { severity: "deny", rule_id: "portability.absolute_literal_paths" },
    ],
  });
  assert.equal(assessment.warnings.length, 1);
  assert.equal(assessment.denies.length, 1);
});

void test("retains a structured findings report when rscheck exits two", () => {
  const report = parseRscheckReport({
    status: 2,
    stdout: JSON.stringify({
      findings: [{ severity: "deny", rule_id: "portability.absolute_literal_paths" }],
    }),
  });
  assert.equal(report.findings.length, 1);
});

void test("distinguishes an rscheck tool failure without a findings report", () => {
  assert.throws(
    () => parseRscheckReport({ status: 2, stdout: "not-json" }),
    /could not analyze the workspace \(exit 2\)/,
  );
});

void test("rejects malformed scanner finding boundaries without string coercion", () => {
  for (const value of [
    null,
    { severity: ["deny"] },
    { severity: "warn", rule_id: [] },
    { severity: "deny", message: {} },
    { severity: "deny", primary: [] },
    { severity: "deny", primary: { file: [] } },
    { severity: "warn", primary: { start: { line: {} } } },
  ]) {
    assert.throws(
      () => parseRscheckReport({ status: 1, stdout: JSON.stringify({ findings: [value] }) }),
      TypeError,
    );
  }
});
void test("retains scanner categories, optional locations, and report metadata", () => {
  const report = {
    scanner_version: "fixture",
    findings: [
      {
        severity: "warn",
        rule_id: "known",
        message: "advisory",
        primary: {
          file: "src/lib.rs",
          start: { line: 12, column: 3 },
          end: { line: 15 },
          span_kind: "source",
        },
      },
      { severity: "deny", primary: null },
      { severity: "future_category", primary: { start: null } },
    ],
  };
  const result = parseRscheckReport({ status: 2, stdout: JSON.stringify(report) });
  assert.deepEqual(result, report);
  assert.equal(assessRscheckReport(result).denies.length, 1);
  assert.equal(assessRscheckReport(result).warnings.length, 1);
});
