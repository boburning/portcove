import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChangeCouplingReport,
  FocusMap,
  ImpactClosureFacts,
  PartitionFacts,
  ReviewDeltas,
  TokenConsumers,
} from "fallow/types";
import { summarizeFallow } from "./fallow-summary.mts";

void test("native decision truncation stays distinct from the presentation cap", () => {
  const summary = summarizeFallow(
    {
      kind: "audit-brief",
      decisions: {
        decisions: Array.from({ length: 6 }, (_, index) => ({
          signal_id: `signal-${index}`,
          anchor_file: "owner.ts",
          question: "Verify contract",
        })),
        truncated: { collapsed: 9, reason: "Native maximum decisions" },
      },
    },
    "brief.json",
  );
  assert.match(
    summary,
    /provided 6; collapsed by analyzer 9; Native maximum decisions; custom display cap 4/,
  );
  assert.match(summary, /2 omitted from Review decisions/);
  assert.match(
    summarizeFallow({ kind: "audit-brief" }, "missing.json"),
    /Review decisions unavailable/,
  );
});

void test("combined projection makes checks, duplicate identity and complexity actionable", () => {
  const summary = summarizeFallow(
    {
      kind: "combined",
      schema_version: "1",
      version: "3.34.1",
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
    "Fallow 3.34.1",
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
      version: "3.34.1",
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

void test("pinned brief shapes lead with focus and retain exact impact totals beside samples", () => {
  const focus: FocusMap = {
    review_here: [
      {
        file: "leaf.ts",
        score: { fan_io: 1, risk_zone: 0, change_shape: 0, total: 1 },
        label: "review-here",
        reason: "Local change",
      },
      {
        file: "owner.ts",
        score: { fan_io: 8, risk_zone: 2, change_shape: 3, total: 13 },
        label: "review-here",
        reason: "Shared contract",
        confidence: ["re-export-indirection"],
      },
    ],
    deprioritized: Array.from({ length: 6 }, (_, index) => ({
      file: `mechanical-${index}.ts`,
      score: { fan_io: 0, risk_zone: 0, change_shape: 0, total: 0 },
      label: "not-prioritized",
      reason: "Mechanical leaf",
    })),
  };
  const deltas: ReviewDeltas = {
    boundary_introduced: ["shared->feature"],
    cycle_introduced: ["a.ts,b.ts"],
    public_api_added: ["src/index.ts::owner"],
    dependency_added: ["package.json::new-library"],
    dependency_major_bumped: ["package.json::existing@1->2"],
  };
  const impact: ImpactClosureFacts = {
    affected_count: 80,
    affected_not_shown: Array.from(
      { length: 6 },
      (_, index) => `first-directory/consumer-${index}.ts`,
    ),
    affected_by_dir: [
      { dir: "quiet", count: 20 },
      { dir: "heavy", count: 40 },
      { dir: "other", count: 8 },
      { dir: "small", count: 5 },
      { dir: "end", count: 3 },
      { dir: "final", count: 2 },
    ],
    affected_by_dir_omitted: 2,
    coordination_gap: [
      {
        changed_file: "owner.ts",
        consumer_file: "outside.ts",
        consumed_symbols: ["renamedOwner"],
        note: "Syntactic attention pointer",
      },
    ],
    co_change_gap_count: 12,
    co_change_gap: Array.from({ length: 10 }, (_, index) => ({
      changed_file: "owner.ts",
      partner_file: `partner-${index}.ts`,
      degree: 1 - index / 100,
      shared_revisions: 20 - index,
      note: "History lead only",
    })),
    search_gap: {
      total: 1,
      exports: [
        {
          file: "owner.ts",
          export_name: "owner",
          line: 4,
          total: 1,
          consumers: [
            {
              consumer_file: "renamed.ts",
              line: 8,
              search_visibility: "renamed",
              search_as: "localOwner",
            },
          ],
        },
      ],
    },
  };
  const partition: PartitionFacts = {
    units: [
      { module_dir: "definitions", files: ["owner.ts"] },
      { module_dir: "app", files: ["leaf.ts"] },
    ],
    order: ["definitions", "app"],
    independent_slices: [["definitions"], ["app"]],
  };
  const report = {
    command: "audit-brief",
    focus,
    deltas,
    impact_closure: impact,
    partition,
    graph_facts: {
      exports_added: 1,
      api_width_delta: 1,
      boundaries_touched: ["shared", "feature"],
    },
    dead_code: { unused_exports: [{ path: "unrelated.ts", export_name: "old" }] },
  };
  const before = structuredClone(report);
  const summary = summarizeFallow(report, "brief.json");
  for (const expected of [
    "Focus: review-here 2; deprioritized 6",
    "owner.ts; review-here; score 13; Shared contract; confidence flags re-export-indirection",
    "2 omitted from Deprioritized units",
    "New boundary edges=1",
    "Public exports added=1",
    "Dependencies added=1",
    "Major dependency changes=1",
    "package.json::existing@1->2",
    "affected outside diff 80; provided sorted path sample 6; 76 affected paths not shown here (74 absent from analyzer sample)",
    "sample is not the complete affected set",
    "6 provided; 2 directories omitted by analyzer",
    "owner.ts -> outside.ts; symbols renamedOwner",
    "Co-change leads: total 12; provided 10",
    "history is not proof that the partner must change",
    "6 omitted from Co-change gap sample",
    "owner.ts:4; owner; total 1; renamed.ts:8 renamed as localOwner",
    "Review partition: units 2; dependency order definitions, app",
    "Independent slices: 2; import-edge components, not separate-PR advice",
    "Graph facts: exports added 1; API widening 1 (removed exports not represented)",
    "Review ownership unavailable",
  ])
    assert.ok(summary.includes(expected), expected);
  assert.ok(summary.indexOf("owner.ts; review-here") < summary.indexOf("leaf.ts; review-here"));
  assert.ok(summary.indexOf("heavy; 40 files") < summary.indexOf("quiet; 20 files"));
  assert.ok(summary.indexOf("Focus:") < summary.indexOf("unrelated.ts"));
  assert.ok(!summary.includes("consumer-4.ts"));
  assert.deepEqual(report, before);
  assert.doesNotMatch(summary, /(?:gate passed|quality passed)/i);
});

void test("analysis diagnostics use actual top-level and nested locations without hiding degradation", () => {
  const summary = summarizeFallow(
    {
      kind: "combined",
      workspace_diagnostics: [
        {
          kind: "excluded-by-default-ignore",
          path: "generated",
          message: "Expected generated exclusion",
        },
        {
          kind: "hotspots-skipped",
          cause: "not-a-repository",
          path: ".",
          message: "Run inside a repository",
          degrades_analysis: true,
        },
      ],
      check: {
        workspace_diagnostics: [
          {
            kind: "plugin-config-unreadable",
            path: "vite.config.ts",
            reason: "dynamic-argument",
            message: "Name the config entries",
            degrades_analysis: true,
          },
        ],
      },
      health: {
        workspace_diagnostics: [
          {
            kind: "ownership-unavailable",
            path: "CODEOWNERS",
            cause: "codeowners-parse-failed",
            message: "Fix the owner declaration",
            degrades_analysis: true,
          },
        ],
      },
    },
    "diagnostics.json",
  );
  for (const expected of [
    "Analysis diagnostics (workspace_diagnostics; degrading first): 2",
    "hotspots-skipped; .; analysis degraded; cause not-a-repository; Run inside a repository",
    "check.workspace_diagnostics",
    "reason dynamic-argument; Name the config entries",
    "health.workspace_diagnostics",
    "cause codeowners-parse-failed; Fix the owner declaration",
  ])
    assert.ok(summary.includes(expected), expected);
  assert.ok(summary.indexOf("hotspots-skipped") < summary.indexOf("excluded-by-default-ignore"));
  assert.doesNotMatch(summary, /(?:gate passed|quality passed)/i);
});

void test("parse and empty-source diagnostics outrank optional limits and review guidance survives global truncation", () => {
  const report = {
    command: "audit-brief",
    workspace_diagnostics: [
      ...Array.from({ length: 6 }, (_, index) => ({
        kind: "hotspots-skipped",
        path: ".",
        cause: "not-a-repository",
        message: `Optional history ${index}`,
        degrades_analysis: true,
      })),
      {
        kind: "source-parse-degraded",
        path: "broken.ts",
        message: "Parse syntax failure at source",
        degrades_analysis: true,
      },
      {
        kind: "no-source-files-analyzed",
        path: "empty",
        message: "No source candidates reached analysis",
        degrades_analysis: true,
      },
    ],
    focus: {
      review_here: [
        {
          file: "focus-owner.ts",
          score: { total: 12 },
          label: "review-here",
          reason: "Review the owning contract",
        },
      ],
      deprioritized: [],
    },
    decisions: {
      decisions: [
        {
          signal_id: "public-contract",
          anchor_file: "decision-owner.ts",
          anchor_line: 7,
          category: "public-api",
          question: "Does the new API belong here?",
          internal_consumer_count: 3,
          blast: 14,
          tradeoff: "Widens the supported surface",
        },
      ],
    },
    check: Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [
        `unused_category_${index}`,
        Array.from({ length: 10 }, (_, line) => ({
          path: `bulk-${index}-${line}.ts`,
          export_name: "x".repeat(200),
          line,
        })),
      ]),
    ),
  };
  const before = structuredClone(report);
  const summary = summarizeFallow(report, "large.json");
  for (const expected of [
    "source-parse-degraded; broken.ts; analysis degraded; Parse syntax failure at source",
    "no-source-files-analyzed; empty; analysis degraded; No source candidates reached analysis",
    "4 omitted from Analysis diagnostics",
    "focus-owner.ts; review-here; score 12",
    "Does the new API belong here?",
    "internal consumers 3; ranking blast 14",
    "Raw evidence: large.json",
  ])
    assert.ok(summary.includes(expected), expected);
  assert.ok(summary.indexOf("Parse syntax failure") < summary.indexOf("Optional history 0"));
  assert.ok(summary.indexOf("focus-owner.ts") < summary.indexOf("decision-owner.ts"));
  assert.ok(summary.indexOf("decision-owner.ts") < summary.indexOf("bulk-0-0.ts"));
  assert.match(summary, /Findings: \d+; shown: \d+; omitted: [1-9]\d*/);
  assert.ok(Buffer.byteLength(summary) <= 16 * 1024);
  assert.deepEqual(report, before);
});

void test("health distinguishes optional context and estimated coverage from observations", () => {
  const coupling: ChangeCouplingReport = {
    since: "12 months",
    commits_analyzed: 60,
    commits_skipped: 3,
    total_pairs: 9,
    thresholds: {
      max_files_per_commit: 20,
      min_revisions: 5,
      min_shared_revisions: 3,
      min_degree: 0.5,
      strong_degree: 0.8,
    },
    pairs: [
      {
        path_a: "contract.ts",
        path_b: "configuration.ts",
        revisions_a: 10,
        revisions_b: 10,
        shared_revisions: 9,
        degree: 0.9,
        strong: true,
      },
    ],
  };
  const report = {
    health: {
      sections: ["complexity", "hotspots", "change-coupling", "targets"],
      summary: {
        files_analyzed: 20,
        functions_analyzed: 80,
        functions_above_threshold: 2,
        severity_critical_count: 0,
        coverage_model: "estimated",
        coverage_source_consistency: "mixed",
      },
      hotspot_summary: {
        since: "6 months",
        min_commits: 5,
        files_analyzed: 18,
        files_excluded: 2,
        shallow_clone: true,
        clock: { source: "head_commit", epoch_secs: 1792400000, reproducible: true },
      },
      findings: [
        {
          path: "estimated.ts",
          name: "read",
          line: 2,
          cyclomatic: 25,
          cognitive: 9,
          severity: "high",
          line_count: 30,
          crap: 29,
          coverage_source: "estimated_component_inherited",
          coverage_tier: "high",
          inherited_from: "View.tsx",
        },
        {
          path: "measured.ts",
          name: "write",
          line: 3,
          cyclomatic: 20,
          cognitive: 8,
          severity: "moderate",
          line_count: 25,
          crap: 30,
          coverage_source: "istanbul",
          coverage_tier: "partial",
          coverage_pct: 40,
        },
      ],
      targets: [
        {
          path: "expensive.ts",
          priority: 90,
          efficiency: 30,
          effort: "high",
          confidence: "high",
          recommendation: "Review shared responsibility",
        },
        {
          path: "quick.ts",
          priority: 50,
          efficiency: 50,
          effort: "low",
          confidence: "high",
          recommendation: "Reuse existing helper",
        },
      ],
      change_coupling: coupling,
    },
  };
  const before = structuredClone(report);
  const summary = summarizeFallow(report, "health.json");
  for (const expected of [
    "files 20; functions 80; above thresholds 2; critical 0",
    "model estimated; consistency mixed",
    "estimated tiers are static evidence, not executed coverage",
    "hotspots unavailable; targets 2; file scores unavailable",
    "History/churn: since 6 months; min commits 5; files 18; excluded 2; shallow clone true",
    "clock head_commit epoch 1792400000 reproducible true",
    "Health ownership unavailable",
    "coverage estimated_component_inherited/high inherited from View.tsx",
    "coverage istanbul/partial 40%",
    "quick.ts; priority 50; efficiency 50",
    "expensive.ts; priority 90; efficiency 30",
    "total pairs 9; supplied 1; since 12 months; commits analyzed/skipped 60/3",
    "contract.ts <-> configuration.ts; degree 0.9; shared revisions 9; revisions 10/10; strong true",
    "history leads, not proof both files must change",
  ])
    assert.ok(summary.includes(expected), expected);
  assert.ok(summary.indexOf("quick.ts") < summary.indexOf("expensive.ts"));
  assert.deepEqual(report, before);
  const unavailable = summarizeFallow({ health: { summary: {} } }, "missing.json");
  assert.match(unavailable, /History\/churn unavailable/);
  assert.match(unavailable, /Hidden change coupling unavailable/);
  assert.match(unavailable, /targets unavailable/);
  assert.doesNotMatch(unavailable, /(?:gate failed|gate passed|quality passed)/i);
});

void test("CSS consumer projection uses located lower bounds and exposes both sample caps", () => {
  const tokens: TokenConsumers[] = Array.from({ length: 6 }, (_, index) => ({
    token: `--color-pc-${index}`,
    namespace: "color",
    definition_path: "src/styles/tokens.css",
    definition_line: index + 3,
    consumer_count: index === 0 ? 0 : index + 5,
    consumers:
      index === 0
        ? []
        : Array.from({ length: 3 }, (_, line) => ({
            path: `src/component-${index}.tsx`,
            line: line + 10,
            kind: line === 0 ? "theme-var" : "utility",
          })),
  }));
  const before = structuredClone(tokens);
  const summary = summarizeFallow({ css_analytics: { token_consumers: tokens } }, "css.json");
  for (const expected of [
    "CSS token consumer index: 6 tokens",
    "zero consumers is not deletion proof",
    "--color-pc-5; namespace color; definition src/styles/tokens.css:8; static lower bound 10; 2 locations shown, 8 known locations not shown",
    "src/component-5.tsx:10 (theme-var)",
    "src/component-5.tsx:11 (utility)",
    "2 omitted from CSS token consumers",
  ])
    assert.ok(summary.includes(expected), expected);
  assert.ok(!summary.includes("component-5.tsx:12"));
  assert.deepEqual(tokens, before);
  const zero = summarizeFallow({ css_analytics: { token_consumers: [tokens[0]] } }, "zero.json");
  assert.match(zero, /static lower bound 0; 0 locations shown, 0 known locations not shown/);
  assert.match(zero, /zero consumers is not deletion proof/);
});
