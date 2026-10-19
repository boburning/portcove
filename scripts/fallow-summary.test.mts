import assert from "node:assert/strict";
import test from "node:test";
import { summarizeFallow } from "./fallow-summary.mts";

void test("combined projection makes checks, duplicate identity and complexity actionable", () => {
  const summary = summarizeFallow(
    {
      kind: "combined",
      schema_version: "1",
      version: "3.34.0",
      elapsed_ms: 100,
      check: {
        total_issues: 4,
        unused_exports: [
          {
            path: "scripts/owner.mts",
            line: 7,
            export_name: "unusedOwner",
            effective_severity: "warn",
            introduced: true,
          },
        ],
        unused_dependencies: [
          { path: "package.json", line: 2, package_name: "unused-package", introduced: false },
        ],
        boundary_violations: [
          {
            from_path: "src/shared/view.ts",
            to_path: "src/features/data.ts",
            from_zone: "shared",
            to_zone: "features",
            line: 3,
            import_specifier: "../features/data",
            effective_severity: "error",
          },
        ],
        circular_dependencies: [
          { files: ["scripts/first.mts", "scripts/second.mts", "scripts/first.mts"] },
        ],
      },
      dupes: {
        stats: { duplication_percentage: 9 },
        clone_groups: [
          {
            fingerprint: "stable-group-id",
            introduced: false,
            line_count: 12,
            token_count: 80,
            instances: [
              { file: "scripts/one.mts", start_line: 4, end_line: 16 },
              { file: "scripts/two.mts", start_line: 8, end_line: 20 },
            ],
          },
        ],
      },
      health: {
        findings: [
          {
            path: "src/operation.ts",
            line: 14,
            name: "finishOperation",
            severity: "critical",
            effective_severity: "error",
            cyclomatic: 66,
            cognitive: 74,
            line_count: 200,
          },
        ],
      },
    },
    "work/report.json",
  );
  for (const expected of [
    "Raw evidence: work/report.json",
    "Fallow 3.34.0",
    "warn; introduced",
    "scripts/owner.mts:7; unusedOwner",
    "inherited; package.json:2; unused-package",
    "src/shared/view.ts:3 -> src/features/data.ts",
    "shared -> features",
    "scripts/first.mts -> scripts/second.mts",
    "9% (advisory",
    "stable-group-id; inherited",
    "scripts/one.mts:4-16",
    "scripts/two.mts:8-20",
    "critical (effective error)",
    "finishOperation; cyclomatic 66; cognitive 74",
  ])
    assert.ok(summary.includes(expected), expected);
});

void test("audit brief retains introduced/inherited context and reviewer questions", () => {
  const summary = summarizeFallow(
    {
      kind: "review-brief",
      command: "review",
      schema_version: "1",
      version: "3.34.0",
      base_ref: "origin/main",
      changed_files_count: 5,
      verdict: "pass",
      attribution: {
        dead_code_introduced: 1,
        dead_code_inherited: 11,
        complexity_introduced: 0,
        complexity_inherited: 3,
        duplication_introduced: 1,
        duplication_inherited: 6,
        styling_introduced: 0,
        styling_inherited: 2,
      },
      dead_code: {
        unused_files: [
          { path: "scripts/unreachable.mts", effective_severity: "error", introduced: true },
        ],
      },
      decisions: {
        decisions: [
          {
            anchor_file: "scripts/adapter.mts",
            anchor_line: 27,
            category: "boundary",
            question: "Does this consumer belong to the existing owner?",
            blast: 14,
            tradeoff: "One owner versus adapter coupling",
          },
        ],
      },
    },
    "review.json",
  );
  for (const expected of [
    "Comparison base origin/main; changed files 5",
    "advisory review context",
    "dead_code: introduced 1; inherited 11",
    "duplication: introduced 1; inherited 6",
    "scripts/unreachable.mts",
    "independent judgment required",
    "scripts/adapter.mts:27",
    "Does this consumer belong",
    "blast 14",
  ])
    assert.ok(summary.includes(expected), expected);
});

void test("existing health sections rank targets, churn and coupling without mutating input", () => {
  const report = {
    health: {
      targets: [
        { path: "less.ts", priority: 2 },
        {
          path: "owner.ts",
          priority: 40,
          recommendation: "Extract parser boundary",
          effort: "medium",
          confidence: "high",
          factors: [{ metric: "fan_in", value: 16 }],
        },
      ],
      hotspots: [
        { path: "quiet.ts", score: 1 },
        {
          path: "churn.ts",
          score: 70,
          commits: 41,
          fan_in: 9,
          complexity_density: 0.8,
          ownership: { declared_owner: "tooling", bus_factor: 1 },
        },
      ],
      file_scores: [
        { path: "healthy.ts", maintainability_index: 99 },
        {
          path: "coupled.ts",
          maintainability_index: 20,
          fan_in: 11,
          fan_out: 23,
          total_cyclomatic: 140,
        },
      ],
    },
  };
  const before = structuredClone(report);
  const summary = summarizeFallow(report, "combined.json");
  assert.ok(summary.indexOf("owner.ts") < summary.indexOf("less.ts"));
  assert.ok(summary.indexOf("churn.ts") < summary.indexOf("quiet.ts"));
  assert.ok(summary.indexOf("coupled.ts") < summary.indexOf("healthy.ts"));
  for (const expected of [
    "Extract parser boundary",
    "fan_in=16",
    "commits 41; fan-in 9",
    "owner tooling; bus factor 1",
    "fan-in/out 11/23",
  ])
    assert.ok(summary.includes(expected), expected);
  assert.deepEqual(report, before);
});

void test("dedicated CSS projection identifies candidates without claiming deletion proof", () => {
  const summary = summarizeFallow(
    {
      findings: [],
      css_analytics: {
        unused_theme_tokens: [{ token: "--color-retired", path: "src/theme.css", line: 3 }],
        near_duplicate_theme_tokens: [
          {
            token: "--color-card",
            path: "src/theme.css",
            line: 4,
            nearest_token: { name: "--color-surface" },
          },
        ],
        unreferenced_css_classes: [
          { class: "conditional-class", path: "src/legacy.module.css", line: 8 },
        ],
        duplicate_declaration_blocks: [
          {
            declaration_count: 5,
            occurrence_count: 2,
            occurrences: [
              { path: "src/theme.css", line: 10 },
              { path: "src/dialog.css", line: 20 },
            ],
          },
        ],
        files: [
          {
            path: "src/theme.css",
            analytics: {
              notable_rules: [
                {
                  line: 40,
                  complexity: 12,
                  specificity_a: 0,
                  specificity_b: 5,
                  specificity_c: 1,
                  declaration_count: 7,
                },
              ],
            },
          },
        ],
      },
      styling_findings: [
        {
          path: "src/view.tsx",
          line: 12,
          code: "raw-color",
          value: "#ff0000",
          effective_severity: "warning",
          fix_hint: "Verify semantic token",
          introduced: false,
        },
      ],
    },
    "css.json",
  );
  for (const expected of [
    "advisory; verify dynamic consumers",
    "src/view.tsx:12; raw-color #ff0000",
    "Verify semantic token",
    "--color-retired",
    "nearest --color-surface",
    "conditional-class",
    "5 declarations; 2 occurrences",
    "src/dialog.css:20",
    "src/theme.css:40; complexity 12; specificity 0,5,1",
  ])
    assert.ok(summary.includes(expected), expected);
});

void test("per-category selection and UTF-8 byte cap keep large reports bounded", () => {
  const report: { check: Record<string, { path: string; export_name: string; line: number }[]> } = {
    check: {},
  };
  for (let category = 0; category < 80; category++)
    report.check[`category_${category}`] = Array.from({ length: 10 }, (_, line) => ({
      path: "🦀".repeat(1000),
      export_name: "名".repeat(1000),
      line,
    }));
  const summary = summarizeFallow(report, "raw.json");
  assert.ok(Buffer.byteLength(summary) <= 16 * 1024);
  assert.match(summary, /6 omitted from category_0/);
  assert.match(summary, /Findings: \d+; shown: \d+; omitted: [1-9]\d*/);
  assert.ok(!summary.includes("\uFFFD"));
  assert.equal(Buffer.from(summary).toString("utf8"), summary);
  assert.match(summary, /Raw evidence: raw.json/);
});

void test("projection tolerates unavailable optional sections without asserting a pass", () => {
  for (const report of [
    null,
    {},
    {
      check: { unused_files: [null] },
      health: { hotspots: [null], file_scores: [null], targets: [null] },
    },
  ]) {
    const summary = summarizeFallow(report, "raw.json");
    assert.doesNotMatch(summary, /(?:gate passed|quality passed)/i);
    assert.match(summary, /Raw evidence: raw.json/);
  }
});

void test("review exposes capped static test reach and bounded guardrail evidence", () => {
  const summary = summarizeFallow(
    {
      kind: "audit-brief",
      test_reach: {
        status: "measured",
        masking: "capped",
        total: 9,
        counts: { direct: 1, transitive: 2, "mocked-only": 6 },
        exports: Array.from({ length: 6 }, (_, index) => ({
          file: `scripts/owner-${index}.mts`,
          line: 3,
          export_name: "recover",
          change: "modified",
          reach: index === 0 ? "future-class" : "mocked-only",
        })),
        exports_omitted: 3,
        e2e_runner: true,
      },
      weakening: [
        { file: "scripts/owner.test.mts", kind: "test-weakened", evidence: "test cases: 2 -> 1" },
      ],
      diff_risk: {
        findings: [
          {
            path: "scripts/owner.test.mts",
            line: 8,
            rule: "weakened-tests",
            severity: "warn",
            message: "A test was removed",
            evidence: "test cases: 2 -> 1",
          },
        ],
      },
    },
    "review.json",
  );
  for (const expected of [
    "advisory static graph, not executed coverage",
    "direct=1, transitive=2, mocked-only=6",
    "scripts/owner-0.mts:3; recover; modified; unknown future-class (needs attention)",
    "2 omitted from Changed exports needing attention",
    "Additional changed exports omitted by analyzer: 3",
    "Mock detection capped; masking evidence incomplete",
    "End-to-end runner present; its coverage is outside static test reach",
    "Guardrail changes (advisory; verify evidence)",
    "Diff risk (advisory; verify evidence)",
    "scripts/owner.test.mts:8; weakened-tests",
    "evidence test cases: 2 -> 1",
    "Raw evidence: review.json",
  ])
    assert.ok(summary.includes(expected), expected);
  assert.ok(!summary.includes("scripts/owner-4.mts"));
  assert.doesNotMatch(summary, /(?:gate passed|quality passed)/i);
});

void test("missing or unavailable test reach never presents zero as clean coverage", () => {
  for (const test_reach of [
    undefined,
    null,
    {},
    { status: "no-tests", total: 0, exports: [] },
    { status: "future-status", total: 0 },
  ]) {
    const summary = summarizeFallow({ kind: "audit-brief", test_reach }, "review.json");
    assert.match(summary, /Test reach unavailable; no clean-coverage conclusion/);
    assert.doesNotMatch(summary, /Reach counts:|(?:gate passed|quality passed)/i);
  }
});

void test("critical functions remain visible ahead of noncritical bulk and snippets stay on one line", () => {
  const summary = summarizeFallow(
    {
      health: {
        findings: [
          ...Array.from({ length: 8 }, (_, index) => ({
            path: `large-${index}.ts`,
            cyclomatic: 90,
            severity: "high",
          })),
          {
            path: "critical-owner.ts",
            name: "recover",
            line: 31,
            cyclomatic: 60,
            severity: "critical",
          },
        ],
      },
      dupes: {
        clone_groups: [
          {
            fingerprint: "parser-clone",
            instances: [
              {
                file: "scripts/parser.mts",
                start_line: 8,
                end_line: 12,
                fragment: "const parser = createParser();\nreturn parser.read();",
              },
            ],
          },
        ],
      },
    },
    "report.json",
  );
  assert.ok(summary.indexOf("critical-owner.ts") < summary.indexOf("large-0.ts"));
  assert.match(summary, /sample const parser = createParser\(\); return parser.read\(\);/);
  assert.match(summary, /5 omitted from Complex functions/);
});
