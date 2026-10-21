import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { evaluateFallowReport } from "./check-fallow-report.mts";

import { report } from "./fallow-test-fixture.mts";

function requiredFixture<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

void test("Fallow report help is inert and failed reports still produce a failing exit status", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-fallow-help-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("./check-fallow-report.mts", import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, PATH: "" },
      cwd: root,
    });
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage:/u);
  assert.match(help.stdout, /reads an existing report/u);
  assert.match(help.stdout, /Example:/u);
  assert.equal(help.stderr, "");
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Usage:/u);
  const reportPath = path.join(root, "report.json");
  writeFileSync(reportPath, JSON.stringify(report({ issues: 1 })));
  const failed = run(reportPath);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Fallow quality gate failed:/u);
});

void test("accepts a clean report", () => {
  assert.deepEqual(evaluateFallowReport(report()).failures, []);
});

void test("optional unavailable history does not invalidate unrelated static qualification", () => {
  const value = {
    ...report(),
    workspace_diagnostics: [
      {
        kind: "hotspots-skipped",
        cause: "not-a-repository",
        degrades_analysis: true,
        message: "History unavailable",
      },
    ],
  };
  assert.deepEqual(evaluateFallowReport(value, { requireParseGate: true }).failures, []);
});

void test("required-source read failures and empty analysis cannot qualify with a passing parse gate", () => {
  for (const kind of ["source-read-failure", "no-source-files-analyzed"]) {
    const value = {
      ...report(),
      workspace_diagnostics: [{ kind, path: "entry.ts", degrades_analysis: true }],
    };
    assert.match(
      evaluateFallowReport(value, { requireParseGate: true }).failures.join("\n"),
      /required source analysis incomplete/,
    );
    assert.deepEqual(evaluateFallowReport(value).failures, [], "tooling findings stay advisory");
  }
});

void test("future versions and schemas require explicit compatibility review", () => {
  for (const value of [
    { ...report(), version: "3.34.2" },
    { ...report(), schema_version: 15 },
  ])
    assert.throws(() => evaluateFallowReport(value), /Unsupported Fallow report/);
});

void test("malformed request-outcome containers cannot pass as an empty request inventory", () => {
  for (const request_outcomes of [false, 0, "", []]) {
    assert.throws(
      () => evaluateFallowReport({ ...report(), request_outcomes }),
      /request_outcomes/,
    );
  }
});

void test("every own gate name retains its enforced failure", () => {
  const value = report();
  const result = evaluateFallowReport({
    ...value,
    gate_outcomes: {
      ...value.gate_outcomes,
      ["__proto__"]: { status: "fail", enforced: true },
    },
  });
  assert.deepEqual(result.failures, ["enforced Fallow gate failed: __proto__"]);
});

void test("preserves dead-code/dependency and critical gates while duplication is advisory", () => {
  const failures = evaluateFallowReport(
    report({ issues: 2, duplication: 2.1, critical: 1 }),
  ).failures;
  assert.equal(failures.length, 2);
  const advisory = evaluateFallowReport(report({ duplication: 99 }));
  assert.deepEqual(advisory.failures, []);
  assert.equal(advisory.duplicationPercentage, 99);
});

void test("missing data, incompatible and error envelopes cannot pass", () => {
  for (const value of [
    null,
    [],
    {},
    { check: {}, dupes: { stats: {} }, health: { summary: {} } },
    { error: true, message: "bad config", exit_code: 2 },
  ])
    assert.throws(() => evaluateFallowReport(value));
  for (const mutate of [
    (r: ReturnType<typeof report>) => {
      // @ts-expect-error Delete a required count to test untrusted JSON rejection.
      delete r.check.total_issues;
    },
    (r: ReturnType<typeof report>) => {
      // @ts-expect-error Delete the required duplication metric.
      delete r.dupes.stats.duplication_percentage;
    },
    (r: ReturnType<typeof report>) => {
      // @ts-expect-error Delete the required critical count.
      delete r.health.summary.severity_critical_count;
    },
    (r: ReturnType<typeof report>) => {
      r.kind = "audit";
    },
    (r: ReturnType<typeof report>) => {
      r.schema_version = 13;
    },
    (r: ReturnType<typeof report>) => {
      r.version = "3.33.1";
    },
    (r: ReturnType<typeof report>) => {
      // @ts-expect-error Remove required gate coverage.
      delete r.gate_outcomes;
    },
    (r: ReturnType<typeof report>) => {
      // @ts-expect-error Malformed wire input deliberately replaces the finding array.
      r.health.findings = null;
    },
    (r: ReturnType<typeof report>) => {
      // @ts-expect-error A string must not masquerade as an enforced boolean.
      r.gate_outcomes["health-findings"].enforced = "false";
    },
    (r: ReturnType<typeof report>) => {
      Object.assign(r, { request_outcomes: { scope: { status: "fallback" } } });
    },
    (r: ReturnType<typeof report>) => {
      r.health.summary.severity_critical_count = 1;
    },
  ]) {
    const value = report();
    mutate(value);
    assert.throws(() => evaluateFallowReport(value));
  }
});

void test("decision metrics reject wrong types, nonfinite, negative and fractional counts", () => {
  for (const invalid of ["0", null, false, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const value = report();
    // @ts-expect-error Malformed wire counts remain malformed.
    value.check.total_issues = invalid;
    assert.throws(() => evaluateFallowReport(value), String(invalid));
  }
  for (const invalid of ["2", null, false, NaN, Infinity, -1, 101]) {
    const value = report();
    // @ts-expect-error Malformed wire metrics remain malformed.
    value.dupes.stats.duplication_percentage = invalid;
    assert.throws(() => evaluateFallowReport(value), String(invalid));
  }
});

void test("native enforced failure is distinct from advisory native health findings", () => {
  const value = report();
  value.gate_outcomes["health-findings"] = { status: "fail", enforced: false };
  assert.deepEqual(evaluateFallowReport(value).failures, []);
  value.gate_outcomes["health-findings"].enforced = true;
  assert.match(
    requiredFixture(evaluateFallowReport(value).failures[0]),
    /enforced.*health-findings/,
  );
});

void test("warning dead-code, dependency and established boundary findings remain blocking", () => {
  for (const category of ["unused_files", "unused_dependencies", "boundary_violations"]) {
    const value = report({ issues: 1 });
    Object.assign(value.check, { [category]: [{ severity: "warn", path: "src/a.ts" }] });
    assert.match(
      requiredFixture(evaluateFallowReport(value).failures[0]),
      /1 dead-code or dependency/,
    );
  }
});
