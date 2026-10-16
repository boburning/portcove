import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFallowReport } from "./check-fallow-report.mjs";

import { report } from "./fallow-test-fixture.mjs";

test("accepts a clean report", () => {
  assert.deepEqual(evaluateFallowReport(report()).failures, []);
});

test("preserves dead-code/dependency and critical gates while duplication is advisory", () => {
  const failures = evaluateFallowReport(
    report({ issues: 2, duplication: 2.1, critical: 1 }),
  ).failures;
  assert.equal(failures.length, 2);
  const advisory = evaluateFallowReport(report({ duplication: 99 }));
  assert.deepEqual(advisory.failures, []);
  assert.equal(advisory.duplicationPercentage, 99);
});

test("missing data, incompatible and error envelopes cannot pass", () => {
  for (const value of [
    null,
    [],
    {},
    { check: {}, dupes: { stats: {} }, health: { summary: {} } },
    { error: true, message: "bad config", exit_code: 2 },
  ])
    assert.throws(() => evaluateFallowReport(value));
  for (const mutate of [
    (r) => {
      delete r.check.total_issues;
    },
    (r) => {
      delete r.dupes.stats.duplication_percentage;
    },
    (r) => {
      delete r.health.summary.severity_critical_count;
    },
    (r) => {
      r.kind = "audit";
    },
    (r) => {
      r.schema_version = 14;
    },
    (r) => {
      r.version = "3.34.0";
    },
    (r) => {
      delete r.gate_outcomes;
    },
    (r) => {
      r.health.findings = null;
    },
    (r) => {
      r.gate_outcomes["health-findings"].enforced = "false";
    },
    (r) => {
      r.request_outcomes = { scope: { status: "fallback" } };
    },
    (r) => {
      r.health.summary.severity_critical_count = 1;
    },
  ]) {
    const value = report();
    mutate(value);
    assert.throws(() => evaluateFallowReport(value));
  }
});

test("decision metrics reject wrong types, nonfinite, negative and fractional counts", () => {
  for (const invalid of ["0", null, false, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const value = report();
    value.check.total_issues = invalid;
    assert.throws(() => evaluateFallowReport(value), String(invalid));
  }
  for (const invalid of ["2", null, false, NaN, Infinity, -1, 101]) {
    const value = report();
    value.dupes.stats.duplication_percentage = invalid;
    assert.throws(() => evaluateFallowReport(value), String(invalid));
  }
});

test("native enforced failure is distinct from advisory native health findings", () => {
  const value = report();
  value.gate_outcomes["health-findings"] = { status: "fail", enforced: false };
  assert.deepEqual(evaluateFallowReport(value).failures, []);
  value.gate_outcomes["health-findings"].enforced = true;
  assert.match(evaluateFallowReport(value).failures[0], /enforced.*health-findings/);
});

test("warning dead-code, dependency and established boundary findings remain blocking", () => {
  for (const category of ["unused_files", "unused_dependencies", "boundary_violations"]) {
    const value = report({ issues: 1 });
    value.check[category] = [{ severity: "warn", path: "src/a.ts" }];
    assert.match(evaluateFallowReport(value).failures[0], /1 dead-code or dependency/);
  }
});
