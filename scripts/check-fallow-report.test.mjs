import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFallowReport } from "./check-fallow-report.mjs";

function report({ issues = 0, duplication = 0, critical = 0 } = {}) {
  return {
    check: { total_issues: issues },
    dupes: { stats: { duplication_percentage: duplication } },
    health: { summary: { average_maintainability: 82, severity_critical_count: critical } },
  };
}

test("accepts a clean report", () => {
  assert.deepEqual(evaluateFallowReport(report()).failures, []);
});

test("preserves every existing frontend gate", () => {
  const failures = evaluateFallowReport(report({ issues: 2, duplication: 2.1, critical: 1 })).failures;
  assert.equal(failures.length, 3);
});
