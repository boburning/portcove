export function report({ issues = 0, duplication = 0, critical = 0 } = {}) {
  return {
    kind: "combined",
    schema_version: 14,
    version: "3.37.0",
    gate_outcomes: {
      "parse-error": { status: "pass", enforced: true },
      "error-severity-findings": { status: "pass", enforced: false },
      "health-findings": { status: "pass", enforced: false },
    },
    check: { total_issues: issues },
    dupes: { stats: { duplication_percentage: duplication }, clone_groups: [] },
    health: {
      summary: {
        average_maintainability: 82,
        severity_critical_count: critical,
      },
      findings: Array.from({ length: critical }, () => ({
        severity: "critical",
        path: "src/critical.ts",
        line: 1,
        name: "critical",
      })),
    },
  };
}
