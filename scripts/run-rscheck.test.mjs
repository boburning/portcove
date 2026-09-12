import assert from "node:assert/strict";
import test from "node:test";

import { assessRscheckReport, parseRscheckReport } from "./run-rscheck.mjs";

test("separates advisory findings from hard policy failures", () => {
  const assessment = assessRscheckReport({
    findings: [
      { severity: "warn", rule_id: "shape.file_complexity" },
      { severity: "deny", rule_id: "portability.absolute_literal_paths" },
    ],
  });
  assert.equal(assessment.warnings.length, 1);
  assert.equal(assessment.denies.length, 1);
});

test("retains a structured findings report when rscheck exits two", () => {
  const report = parseRscheckReport({
    status: 2,
    stdout: JSON.stringify({
      findings: [{ severity: "deny", rule_id: "portability.absolute_literal_paths" }],
    }),
  });
  assert.equal(report.findings.length, 1);
});

test("distinguishes an rscheck tool failure without a findings report", () => {
  assert.throws(
    () => parseRscheckReport({ status: 2, stdout: "not-json" }),
    /could not analyze the workspace \(exit 2\)/,
  );
});
