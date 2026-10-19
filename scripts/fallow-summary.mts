import { isRecord } from "./runtime-values.mts";
import { renderBoundedSummary } from "./bounded-summary.mts";

const selectionLimit = 4;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
function diagnosticString(value: unknown): string {
  // The presentation adapter preserves JS coercion of foreign diagnostic values.
  // Evidence validation and acceptance never use this formatter.
  return String(value);
}
const text = (value: unknown, limit = 220): string => {
  const characters = Array.from(diagnosticString(value ?? "unknown"), (character: string) =>
    (character.codePointAt(0) ?? 0) < 32 ? " " : character,
  );
  return characters.length > limit
    ? `${characters.slice(0, limit).join("")}…`
    : characters.join("");
};
const location = (finding: Record<string, unknown>) =>
  `${text(finding.path ?? finding.file ?? finding.from_path)}${(finding.line ?? finding.start_line) ? `:${text(finding.line ?? finding.start_line)}` : ""}`;
const attribution = (finding: Record<string, unknown>) =>
  typeof finding.introduced === "boolean"
    ? finding.introduced
      ? "introduced"
      : "inherited"
    : "attribution unavailable";
const severity = (finding: Record<string, unknown>) =>
  `${text(finding.severity ?? finding.effective_severity ?? "severity unspecified")}${finding.severity && finding.effective_severity ? ` (effective ${text(finding.effective_severity)})` : ""}`;
const rank = (value: unknown): number => Number(value);
type SummarySection = (
  label: string,
  findings: unknown,
  describe: (finding: Record<string, unknown>) => string,
) => void;
const count = (value: unknown) => (Array.isArray(value) ? value.length : "unavailable");
const knownCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const strings = (value: unknown, limit = selectionLimit) => {
  const items = list(value);
  return `${items
    .slice(0, limit)
    .map((item) => text(item))
    .join(", ")}${items.length > limit ? `; ${items.length - limit} omitted` : ""}`;
};
const stringRows = (value: unknown) => list(value).map((value) => ({ value }));
const ranked = (value: unknown, score: (item: Record<string, unknown>) => unknown) =>
  [...list(value)].sort((a, b) => rank(score(record(b))) - rank(score(record(a))));
const complexityRank = (finding: unknown): number => {
  const item = record(finding);
  const offset = item.severity === "critical" ? 1_000_000 : 0;
  const value = item.cyclomatic ?? 0;
  // Retain the previous addition/subtraction coercion for malformed JSON metrics.
  return typeof value === "string" || Array.isArray(value)
    ? Number(`${offset}${diagnosticString(value)}`)
    : offset + rank(value);
};

function checkDetail(finding: unknown) {
  const item = record(finding);
  if (item.from_path && item.to_path)
    return `${location(item)} -> ${text(item.to_path)} (${text(item.from_zone)} -> ${text(item.to_zone)}); import ${text(item.import_specifier)}`;
  if (Array.isArray(item.files))
    return `${item.files
      .slice(0, 6)
      .map((file: unknown) => text(file))
      .join(" -> ")}${item.files.length > 6 ? `; +${item.files.length - 6} files` : ""}`;
  const identity =
    item.export_name ??
    item.type_name ??
    item.member_name ??
    item.package_name ??
    item.specifier ??
    item.name;
  return `${location(item)}${identity ? `; ${text(identity)}` : ""}`;
}

function reviewFocus(root: Record<string, unknown>, entries: string[], section: SummarySection) {
  const focus = record(root.focus);
  entries.push(
    `Focus: review-here ${count(focus.review_here)}; deprioritized ${count(focus.deprioritized)}; advisory attention, not permission to skip checks`,
  );
  const describe = (item: Record<string, unknown>) =>
    `${location(item)}; ${text(item.label)}; score ${text(record(item.score).total)}; ${text(item.reason)}${list(item.confidence).length ? `; confidence flags ${strings(item.confidence)}` : ""}`;
  section(
    "Review focus (ranked attention)",
    ranked(focus.review_here, (item) => record(item.score).total),
    describe,
  );
  section("Deprioritized units (full list in raw report)", focus.deprioritized, describe);
}

function reviewDeltas(root: Record<string, unknown>, entries: string[], section: SummarySection) {
  const deltas = record(root.deltas);
  const categories = [
    ["boundary_introduced", "New boundary edges"],
    ["cycle_introduced", "New cycles"],
    ["public_api_added", "Public exports added"],
    ["dependency_added", "Dependencies added"],
    ["dependency_major_bumped", "Major dependency changes"],
  ] as const;
  entries.push(
    `Review deltas: ${categories.map(([key, label]) => `${label}=${count(deltas[key])}`).join("; ")}`,
  );
  for (const [key, label] of categories)
    section(label, stringRows(deltas[key]), (item) => text(item.value));
}

function reviewImpact(root: Record<string, unknown>, entries: string[], section: SummarySection) {
  const impact = record(root.impact_closure);
  const paths = list(impact.affected_not_shown);
  const total = knownCount(impact.affected_count);
  const shown = Math.min(paths.length, selectionLimit);
  entries.push(
    `Impact closure: affected outside diff ${text(impact.affected_count)}; provided sorted path sample ${count(impact.affected_not_shown)}; ${total !== undefined && total >= paths.length ? `${total - shown} affected paths not shown here (${total - paths.length} absent from analyzer sample)` : "full path omissions unavailable"}; sample is not the complete affected set`,
  );
  section("Affected path sample", stringRows(impact.affected_not_shown), (item) =>
    text(item.value),
  );
  entries.push(
    `Affected directory distribution: ${count(impact.affected_by_dir)} provided; ${text(impact.affected_by_dir_omitted)} directories omitted by analyzer; each listed directory count is exact`,
  );
  section(
    "Affected directories (heaviest first)",
    ranked(impact.affected_by_dir, (item) => item.count),
    (item) => `${text(item.dir || "(repository root)")}; ${text(item.count)} files`,
  );
  section(
    "Coordination gaps (syntactic attention pointers)",
    impact.coordination_gap,
    (item) =>
      `${text(item.changed_file)} -> ${text(item.consumer_file)}; symbols ${strings(item.consumed_symbols)}; ${text(item.note)}`,
  );
  if (impact.co_change_gap !== undefined || impact.co_change_gap_count !== undefined) {
    entries.push(
      `Co-change leads: total ${text(impact.co_change_gap_count)}; provided ${count(impact.co_change_gap)}; history is not proof that the partner must change`,
    );
    section(
      "Co-change gap sample (advisory)",
      ranked(impact.co_change_gap, (item) => item.degree),
      (item) =>
        `${text(item.changed_file)} -> ${text(item.partner_file)}; degree ${text(item.degree)}; shared revisions ${text(item.shared_revisions)}; ${text(item.note)}`,
    );
  }
  if (impact.search_gap) {
    const search = record(impact.search_gap);
    entries.push(
      `Literal-search gap: ${text(search.total)} export-consumer pairs (not unique files); exports ${count(search.exports)}`,
    );
    section("Changed exports missed by literal search", search.exports, (item) => {
      const consumers = list(item.consumers);
      const total = knownCount(item.total);
      return `${location(item)}; ${text(item.export_name)}; total ${text(item.total)}; ${consumers
        .slice(0, 2)
        .map((consumer) => {
          const row = record(consumer);
          return `${text(row.consumer_file)}${row.line ? `:${text(row.line)}` : ""} ${text(row.search_visibility)}${row.search_as ? ` as ${text(row.search_as)}` : ""}`;
        })
        .join(
          "; ",
        )}; ${total !== undefined && total >= consumers.length ? total - Math.min(consumers.length, 2) : "unavailable"} consumers not shown`;
    });
  }
}

function reviewPartition(
  root: Record<string, unknown>,
  entries: string[],
  section: SummarySection,
) {
  const partition = record(root.partition);
  entries.push(
    `Review partition: units ${count(partition.units)}; dependency order ${strings(partition.order) || "unavailable"}`,
  );
  section(
    "Review module units",
    partition.units,
    (item) =>
      `${text(item.module_dir || "(repository root)")}; files ${count(item.files)}; ${strings(item.files)}`,
  );
  if (Array.isArray(partition.independent_slices)) {
    entries.push(
      `Independent slices: ${partition.independent_slices.length}; import-edge components, not separate-PR advice (generated and lockstep contracts may belong together)`,
    );
    section(
      "Independent slice sample",
      partition.independent_slices.map((modules: unknown, index) => ({ modules, index })),
      (item) =>
        `slice ${rank(item.index) + 1}; modules ${count(item.modules)}; ${strings(item.modules)}`,
    );
  } else entries.push("Independent slices not provided; no split conclusion");
  const graph = record(root.graph_facts);
  entries.push(
    `Graph facts: exports added ${text(graph.exports_added)}; API widening ${text(graph.api_width_delta)} (removed exports not represented); boundary zones from violation findings ${strings(graph.boundaries_touched) || (Array.isArray(graph.boundaries_touched) ? "none listed" : "unavailable")}`,
  );
  const ownership = record(root.ownership);
  if (root.ownership)
    entries.push(
      `Review ownership (CODEOWNERS): groups ${text(ownership.group_count)}; transitive-only ${text(ownership.transitive_only_count)}; unowned changed files ${text(ownership.unowned_direct_count)}; omitted groups ${text(ownership.groups_omitted)}`,
    );
  else entries.push("Review ownership unavailable (optional CODEOWNERS context)");
}

function workspaceDiagnostics(root: Record<string, unknown>, section: SummarySection) {
  for (const [label, container] of [
    ["workspace_diagnostics", root],
    ["check.workspace_diagnostics", record(root.check)],
    ["dead_code.workspace_diagnostics", record(root.dead_code)],
    ["health.workspace_diagnostics", record(root.health)],
    ["complexity.workspace_diagnostics", record(root.complexity)],
  ] as const)
    section(
      `Analysis diagnostics (${label}; degrading first)`,
      ranked(container.workspace_diagnostics, (item) =>
        item.kind === "source-parse-degraded" || item.kind === "no-source-files-analyzed"
          ? 2
          : item.degrades_analysis === true
            ? 1
            : 0,
      ),
      (item) =>
        `${text(item.kind)}; ${location(item)}; ${item.degrades_analysis === true ? "analysis degraded; " : ""}${item.cause ? `cause ${text(item.cause)}; ` : ""}${item.reason ? `reason ${text(item.reason)}; ` : ""}${text(item.message ?? item.error)}`,
    );
}

function healthContext(
  health: Record<string, unknown>,
  entries: string[],
  section: SummarySection,
) {
  const summary = record(health.summary);
  entries.push(
    `Health scope: files ${text(summary.files_analyzed)}; functions ${text(summary.functions_analyzed)}; above thresholds ${text(summary.functions_above_threshold)}; critical ${text(summary.severity_critical_count)}; sections ${strings(health.sections, 16) || "unavailable"}`,
    `CRAP coverage provenance: model ${text(summary.coverage_model)}; consistency ${text(summary.coverage_source_consistency)}; input ${text(summary.coverage_input_format)}; Istanbul matched functions ${text(summary.istanbul_matched)}/${text(summary.istanbul_total)}, files ${text(summary.istanbul_files_matched)}/${text(summary.istanbul_files_total)}; estimated tiers are static evidence, not executed coverage`,
    `Optional health listings: hotspots ${count(health.hotspots)}; targets ${count(health.targets)}; file scores ${count(health.file_scores)}; unavailable does not mean zero or gate failure`,
  );
  const history = record(health.hotspot_summary);
  if (health.hotspot_summary) {
    const clock = record(history.clock);
    entries.push(
      `History/churn: since ${text(history.since)}; min commits ${text(history.min_commits)}; files ${text(history.files_analyzed)}; excluded ${text(history.files_excluded)}; shallow clone ${text(history.shallow_clone)}; clock ${text(clock.source)} epoch ${text(clock.epoch_secs)} reproducible ${text(clock.reproducible)}`,
    );
  } else entries.push("History/churn unavailable (optional; not produced or unreadable)");
  const hotspots = list(health.hotspots);
  entries.push(
    Array.isArray(health.hotspots)
      ? `Health ownership: ${hotspots.filter((item) => isRecord(record(item).ownership)).length} of ${hotspots.length} supplied hotspots carry attribution; other ownership unavailable (optional)`
      : "Health ownership unavailable (optional; hotspots not produced)",
  );
  const coupling = record(health.change_coupling);
  if (health.change_coupling) {
    entries.push(
      `Hidden change coupling: total pairs ${text(coupling.total_pairs)}; supplied ${count(coupling.pairs)}; since ${text(coupling.since)}; commits analyzed/skipped ${text(coupling.commits_analyzed)}/${text(coupling.commits_skipped)}; history leads, not proof both files must change`,
    );
    section(
      "Hidden coupling pairs (strongest first, advisory)",
      ranked(coupling.pairs, (item) => item.degree),
      (item) =>
        `${text(item.path_a)} <-> ${text(item.path_b)}; degree ${text(item.degree)}; shared revisions ${text(item.shared_revisions)}; revisions ${text(item.revisions_a)}/${text(item.revisions_b)}; strong ${text(item.strong ?? "not flagged")}`,
    );
  } else entries.push("Hidden change coupling unavailable (optional history analysis)");
  const runtime = record(health.runtime_coverage);
  if (runtime.provenance) {
    const provenance = record(runtime.provenance);
    entries.push(
      `Runtime coverage provenance: ${text(provenance.data_source)}; production ${text(provenance.is_production)}; freshness days ${text(provenance.freshness_days)}; stale ${text(provenance.stale)}; untracked/unresolved ${text(provenance.untracked_ratio)}/${text(provenance.unresolved_ratio)} (context only)`,
    );
  }
}

function tokenConsumers(css: Record<string, unknown>, entries: string[], section: SummarySection) {
  if (css.token_consumers === undefined) return;
  entries.push(
    `CSS token consumer index: ${count(css.token_consumers)} tokens; counts are static lower bounds, locations are capped samples; zero consumers is not deletion proof`,
  );
  section(
    "CSS token consumers (most located consumers first)",
    ranked(css.token_consumers, (item) => item.consumer_count),
    (item) => {
      const consumers = list(item.consumers);
      const shown = Math.min(consumers.length, 2);
      const total = knownCount(item.consumer_count);
      return `${text(item.token)}; namespace ${text(item.namespace)}; definition ${text(item.definition_path)}:${text(item.definition_line)}; static lower bound ${text(item.consumer_count)}; ${shown} locations shown, ${total !== undefined && total >= consumers.length ? total - shown : "unavailable"} known locations not shown; ${consumers
        .slice(0, 2)
        .map((consumer) => `${location(record(consumer))} (${text(record(consumer).kind)})`)
        .join("; ")}`;
    },
  );
}

/**
 * Bounded presentation of the pinned fallow/types report shapes. This projection
 * does not validate evidence or decide a gate; the adapter owns those decisions.
 */
export function summarizeFallow(report: unknown, reference: string, title = "Fallow findings") {
  const root = record(report);
  const entries: string[] = [];
  const section = (
    label: string,
    findings: unknown,
    describe: (finding: Record<string, unknown>) => string,
  ) => {
    const items = list(findings);
    if (!items.length) return;
    entries.push(`${label}: ${items.length}; showing ${Math.min(items.length, selectionLimit)}`);
    for (const item of items.slice(0, selectionLimit)) entries.push(`  ${describe(record(item))}`);
    if (items.length > selectionLimit)
      entries.push(
        `  ${items.length - selectionLimit} omitted from ${label}; inspect original report`,
      );
  };
  entries.push(
    `kind ${text(root.kind ?? root.command ?? "combined/health")}; schema ${text(root.schema_version)}; Fallow ${text(root.version)}; elapsed ${text(root.elapsed_ms)}ms`,
  );
  if (root.base_ref)
    entries.push(
      `Comparison base ${text(root.base_ref)}; changed files ${text(root.changed_files_count)}; native verdict ${text(root.verdict)} (advisory review context)`,
    );
  if (root.attribution)
    for (const category of ["dead_code", "complexity", "duplication", "styling"])
      entries.push(
        `${category}: introduced ${text(record(root.attribution)[`${category}_introduced`])}; inherited ${text(record(root.attribution)[`${category}_inherited`])}`,
      );

  workspaceDiagnostics(root, section);
  const isReview =
    root.command === "audit-brief" ||
    root.kind === "audit-brief" ||
    root.kind === "review-brief" ||
    root.focus !== undefined ||
    root.impact_closure !== undefined;
  if (isReview) {
    reviewFocus(root, entries, section);
  }
  const decisions = record(root.decisions);
  if (root.decisions) {
    const truncated = record(decisions.truncated);
    entries.push(
      `Review decision availability: provided ${count(decisions.decisions)}; collapsed by analyzer ${decisions.truncated ? text(truncated.collapsed) : "0"}${decisions.truncated ? `; ${text(truncated.reason)}` : ""}; custom display cap ${selectionLimit}`,
    );
  } else if (isReview) entries.push("Review decisions unavailable; no judgment-free conclusion");
  section(
    "Review decisions (advisory; independent judgment required)",
    decisions.decisions,
    (item) =>
      `${text(item.anchor_file)}:${text(item.anchor_line)}; ${text(item.category)}; ${text(item.question)}; internal consumers ${text(item.internal_consumer_count)}; ranking blast ${text(item.blast)}; ${text(item.tradeoff)}${item.signal_id ? `; signal ${text(item.signal_id)}` : ""}`,
  );
  if (isReview) {
    reviewDeltas(root, entries, section);
    reviewImpact(root, entries, section);
    reviewPartition(root, entries, section);
  }
  if (isReview || root.test_reach !== undefined) {
    const reach = record(root.test_reach);
    entries.push(
      `Test reach (advisory static graph, not executed coverage): ${text(reach.status)}; masking ${text(reach.masking)}; changed exports ${text(reach.total)}`,
    );
    if (reach.status === "measured") {
      entries.push(
        `Reach counts: ${["direct", "transitive", "mocked-only", "none", "none-file", "framework"]
          .map((name) => `${name}=${text(record(reach.counts)[name])}`)
          .join(", ")}`,
      );
      section("Changed exports needing attention", reach.exports, (item) => {
        const known = ["direct", "transitive", "mocked-only", "none", "none-file", "framework"];
        const classification =
          typeof item.reach === "string" && known.includes(item.reach)
            ? text(item.reach)
            : `unknown ${text(item.reach)} (needs attention)`;
        return `${location(item)}; ${text(item.export_name)}; ${text(item.change)}; ${classification}`;
      });
      if (reach.exports_omitted !== undefined)
        entries.push(
          `Additional changed exports omitted by analyzer: ${text(reach.exports_omitted)}`,
        );
    } else {
      entries.push("Test reach unavailable; no clean-coverage conclusion");
    }
    if (reach.masking === "capped")
      entries.push("Mock detection capped; masking evidence incomplete");
    if (reach.e2e_runner === true)
      entries.push("End-to-end runner present; its coverage is outside static test reach");
  }
  section(
    "Diff risk (advisory; verify evidence)",
    record(root.diff_risk).findings,
    (item) =>
      `${severity(item)}; ${location(item)}; ${text(item.rule)}${item.kind ? `/${text(item.kind)}` : ""}; ${text(item.message)}; evidence ${text(item.evidence)}`,
  );
  section(
    "Guardrail changes (advisory; verify evidence)",
    root.weakening,
    (item) => `${location(item)}; ${text(item.kind)}; evidence ${text(item.evidence)}`,
  );

  const check = record(root.check ?? root.dead_code);
  if (check.total_issues !== undefined)
    entries.push(
      `Check findings: ${text(check.total_issues)} (whole-Desktop qualification includes warnings)`,
    );
  for (const [category, findings] of Object.entries(check)) {
    if (
      !Array.isArray(findings) ||
      category === "next_steps" ||
      category === "workspace_diagnostics"
    )
      continue;
    section(
      category,
      findings,
      (item) => `${severity(item)}; ${attribution(item)}; ${checkDetail(item)}`,
    );
  }

  const dupes = record(root.dupes ?? root.duplication);
  if (dupes.stats)
    entries.push(
      `Duplication: ${text(record(dupes.stats).duplication_percentage)}% (advisory; no aggregate percentage blocker)`,
    );
  section(
    "Duplicate groups (advisory)",
    dupes.clone_groups,
    (item) =>
      `${text(item.fingerprint)}; ${attribution(item)}; ${text(item.line_count)} lines/${text(item.token_count)} tokens; ${list(
        item.instances,
      )
        .slice(0, 4)
        .map((instance) => `${location(record(instance))}-${text(record(instance).end_line)}`)
        .join(
          "; ",
        )}${list(item.instances).length > 4 ? `; +${list(item.instances).length - 4} locations` : ""}${item.suggested_name ? `; suggested responsibility ${text(item.suggested_name)}` : ""}${record(list(item.instances)[0]).fragment ? `; sample ${text(record(list(item.instances)[0]).fragment, 140)}` : ""}${item.demotion_reason ? `; ${text(item.demotion_reason)}` : ""}`,
  );

  const health = record(
    root.health ?? root.complexity ?? (root.findings || root.css_analytics ? root : null),
  );
  if (Object.keys(health).length) healthContext(health, entries, section);
  section(
    "Complex functions",
    [...list(health.findings)].sort((a, b) => complexityRank(b) - complexityRank(a)),
    (item) =>
      `${severity(item)}; ${attribution(item)}; ${location(item)} ${text(item.name)}; cyclomatic ${text(item.cyclomatic)}; cognitive ${text(item.cognitive)}; ${text(item.line_count)} lines; CRAP ${text(item.crap)}; coverage ${text(item.coverage_source)}/${text(item.coverage_tier)}${item.coverage_pct !== undefined && item.coverage_pct !== null ? ` ${text(item.coverage_pct)}%` : ""}${item.inherited_from ? ` inherited from ${text(item.inherited_from)}` : ""}`,
  );
  const efficiencyAvailable = list(health.targets).some(
    (item) =>
      typeof record(item).efficiency === "number" && Number.isFinite(record(item).efficiency),
  );
  section(
    `Refactoring targets (advisory, ranked ${efficiencyAvailable ? "efficiency" : "priority; efficiency unavailable"})`,
    ranked(health.targets, (item) =>
      efficiencyAvailable ? (item.efficiency ?? -Infinity) : item.priority,
    ),
    (item) =>
      `${location(item)}; priority ${text(item.priority)}; efficiency ${text(item.efficiency)}; ${text(item.recommendation)}; effort ${text(item.effort)}; confidence ${text(item.confidence)}; ${list(
        item.factors,
      )
        .slice(0, 3)
        .map((factor) => `${text(record(factor).metric)}=${text(record(factor).value)}`)
        .join(", ")}`,
  );
  section(
    "Hotspots (advisory, ranked score)",
    [...list(health.hotspots)].sort((a, b) => rank(record(b).score) - rank(record(a).score)),
    (item) =>
      `${location(item)}; score ${text(item.score)}; commits ${text(item.commits)}; fan-in ${text(item.fan_in)}; complexity density ${text(item.complexity_density)}; owner ${text(record(item.ownership).declared_owner)}; bus factor ${text(record(item.ownership).bus_factor)}`,
  );
  section(
    "File scores (advisory, lowest maintainability first)",
    [...list(health.file_scores)].sort(
      (a, b) => rank(record(a).maintainability_index) - rank(record(b).maintainability_index),
    ),
    (item) =>
      `${location(item)}; maintainability ${text(item.maintainability_index)}; fan-in/out ${text(item.fan_in)}/${text(item.fan_out)}; cyclomatic ${text(item.total_cyclomatic)}`,
  );

  section(
    "Styling candidates (advisory; verify dynamic consumers)",
    health.styling_findings,
    (item) =>
      `${severity(item)}; ${attribution(item)}; ${location(item)}; ${text(item.code)} ${text(item.value)}${item.fix_hint ? `; ${text(item.fix_hint)}` : ""}`,
  );
  const css = record(health.css_analytics);
  tokenConsumers(css, entries, section);
  for (const category of [
    "unused_theme_tokens",
    "near_duplicate_theme_tokens",
    "unreferenced_css_classes",
    "scoped_unused",
    "unresolved_class_references",
    "raw_style_values",
    "tailwind_arbitrary_values",
  ])
    section(
      `CSS ${category} (advisory candidate)`,
      css[category],
      (item) =>
        `${location(item)}; ${text(item.token ?? item.class ?? item.value ?? list(item.classes).join(", "))}${item.nearest_token ? `; nearest ${text(record(item.nearest_token).name)}` : ""}`,
    );
  section(
    "CSS duplicate declarations (advisory)",
    css.duplicate_declaration_blocks,
    (item) =>
      `${text(item.declaration_count)} declarations; ${text(item.occurrence_count)} occurrences; ${list(
        item.occurrences,
      )
        .slice(0, 4)
        .map((item) => location(record(item)))
        .join("; ")}`,
  );
  const rules = list(css.files).flatMap((file) =>
    list(record(record(file).analytics).notable_rules).map((rule) => ({
      ...record(rule),
      path: record(file).path,
    })),
  );
  section(
    "CSS selectors (advisory, ranked complexity)",
    rules.sort((a, b) => rank(record(b).complexity) - rank(record(a).complexity)),
    (item) =>
      `${location(item)}; complexity ${text(item.complexity)}; specificity ${text(item.specificity_a)},${text(item.specificity_b)},${text(item.specificity_c)}; declarations ${text(item.declaration_count)}`,
  );
  return renderBoundedSummary(text(title, 100), entries, { reference: text(reference, 500) }).text;
}
