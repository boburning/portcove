import { renderBoundedSummary } from "./bounded-summary.mts";

const selectionLimit = 4;
const list = (value) => (Array.isArray(value) ? value : []);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const text = (value, limit = 220) => {
  const characters = Array.from(String(value ?? "unknown"), (character: string) =>
    character.codePointAt(0) < 32 ? " " : character,
  );
  return characters.length > limit
    ? `${characters.slice(0, limit).join("")}…`
    : characters.join("");
};
const location = (finding) =>
  `${text(finding.path ?? finding.file ?? finding.from_path)}${(finding.line ?? finding.start_line) ? `:${text(finding.line ?? finding.start_line)}` : ""}`;
const attribution = (finding) =>
  typeof finding.introduced === "boolean"
    ? finding.introduced
      ? "introduced"
      : "inherited"
    : "attribution unavailable";
const severity = (finding) =>
  `${text(finding.severity ?? finding.effective_severity ?? "severity unspecified")}${finding.severity && finding.effective_severity ? ` (effective ${text(finding.effective_severity)})` : ""}`;
const complexityRank = (finding) =>
  (record(finding).severity === "critical" ? 1_000_000 : 0) + (record(finding).cyclomatic ?? 0);

function checkDetail(finding) {
  const item = record(finding);
  if (item.from_path && item.to_path)
    return `${location(item)} -> ${text(item.to_path)} (${text(item.from_zone)} -> ${text(item.to_zone)}); import ${text(item.import_specifier)}`;
  if (Array.isArray(item.files))
    return `${item.files
      .slice(0, 6)
      .map((file) => text(file))
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

/**
 * Bounded presentation of the pinned fallow/types report shapes. This projection
 * does not validate evidence or decide a gate; the adapter owns those decisions.
 */
export function summarizeFallow(report, reference, title = "Fallow findings") {
  const root = record(report);
  const entries = [];
  const section = (label, findings, describe) => {
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
        `${category}: introduced ${text(root.attribution[`${category}_introduced`])}; inherited ${text(root.attribution[`${category}_inherited`])}`,
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
      `Duplication: ${text(dupes.stats.duplication_percentage)}% (advisory; no aggregate percentage blocker)`,
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
        )}${list(item.instances).length > 4 ? `; +${list(item.instances).length - 4} locations` : ""}${item.suggested_name ? `; suggested responsibility ${text(item.suggested_name)}` : ""}${record(list(item.instances)[0]).fragment ? `; sample ${text(record(item.instances[0]).fragment, 140)}` : ""}${item.demotion_reason ? `; ${text(item.demotion_reason)}` : ""}`,
  );

  const health = record(
    root.health ?? root.complexity ?? (root.findings || root.css_analytics ? root : null),
  );
  section(
    "Complex functions",
    [...list(health.findings)].sort((a, b) => complexityRank(b) - complexityRank(a)),
    (item) =>
      `${severity(item)}; ${attribution(item)}; ${location(item)} ${text(item.name)}; cyclomatic ${text(item.cyclomatic)}; cognitive ${text(item.cognitive)}; ${text(item.line_count)} lines`,
  );
  section(
    "Refactoring targets (advisory, ranked priority)",
    [...list(health.targets)].sort((a, b) => record(b).priority - record(a).priority),
    (item) =>
      `${location(item)}; priority ${text(item.priority)}; ${text(item.recommendation)}; effort ${text(item.effort)}; confidence ${text(item.confidence)}; ${list(
        item.factors,
      )
        .slice(0, 3)
        .map((factor) => `${text(factor.metric)}=${text(factor.value)}`)
        .join(", ")}`,
  );
  section(
    "Hotspots (advisory, ranked score)",
    [...list(health.hotspots)].sort((a, b) => record(b).score - record(a).score),
    (item) =>
      `${location(item)}; score ${text(item.score)}; commits ${text(item.commits)}; fan-in ${text(item.fan_in)}; complexity density ${text(item.complexity_density)}; owner ${text(item.ownership?.declared_owner)}; bus factor ${text(item.ownership?.bus_factor)}`,
  );
  section(
    "File scores (advisory, lowest maintainability first)",
    [...list(health.file_scores)].sort(
      (a, b) => record(a).maintainability_index - record(b).maintainability_index,
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
        `${location(item)}; ${text(item.token ?? item.class ?? item.value ?? list(item.classes).join(", "))}${item.nearest_token ? `; nearest ${text(item.nearest_token.name)}` : ""}`,
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
    list(record(file).analytics?.notable_rules).map((rule) => ({
      ...record(rule),
      path: record(file).path,
    })),
  );
  section(
    "CSS selectors (advisory, ranked complexity)",
    rules.sort((a, b) => b.complexity - a.complexity),
    (item) =>
      `${location(item)}; complexity ${text(item.complexity)}; specificity ${text(item.specificity_a)},${text(item.specificity_b)},${text(item.specificity_c)}; declarations ${text(item.declaration_count)}`,
  );
  section(
    "Review decisions (advisory; independent judgment required)",
    root.decisions?.decisions,
    (item) =>
      `${text(item.anchor_file)}:${text(item.anchor_line)}; ${text(item.category)}; ${text(item.question)}; blast ${text(item.blast)}; ${text(item.tradeoff)}`,
  );
  return renderBoundedSummary(text(title, 100), entries, { reference: text(reference, 500) }).text;
}
