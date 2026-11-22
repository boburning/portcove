import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRouteFitReport,
  dispositions,
  readRouteFitInputs,
  routeFitReport,
  type Disposition,
  type RouteFitInputs,
  type RouteFitReport,
} from "./catalog-route-fit.mts";
import { parseCatalogSource } from "./catalog-authoring.mts";
import {
  handoffContractVersion,
  handoffContracts,
  handoffPolicyVersion,
  handoffRegistry,
} from "./maintenance-handoffs.mts";
import { isRecord } from "./runtime-values.mts";

/**
 * The derived, read-only program cutover view for the dynamic native ports
 * program (#1422). It projects existing committed facts for operators: the
 * route-fit report (called, never re-derived), title-specific code authorities
 * found mechanically in the repository, the handoff registry and, optionally, a
 * catalog observer report. It writes nothing but an optional output file, reads
 * no network and is not a backlog or status authority: GitHub Projects and the
 * canonical issues keep planning, priority and status.
 *
 * Nothing here names a game. Authority kinds are code shapes with a detector
 * each; the identities a kind covers come from what the detector finds.
 */

export const programViewVersion = "maintenance-program-view/1";

/** Versioned denominator definitions. A change in meaning bumps the version. */
export const denominators = {
  identities: {
    version: "program-view/identities/1",
    definition: "Every catalog identity reported by route fit.",
  },
  inScope: {
    version: "program-view/in-scope/1",
    definition:
      "Catalog identities whose route-fit disposition is not excluded-scummvm (ScummVM onboarding is deferred by engine identity).",
  },
  inScopeEnrolled: {
    version: "program-view/in-scope-enrolled/1",
    definition:
      "In-scope catalog identities with an operational definition or a generated route enrollment (route-fit disposition enrolled).",
  },
  handoffClasses: {
    version: "program-view/handoff-classes/1",
    definition: "Entries of the maintenance handoff registry.",
  },
  observerSources: {
    version: "program-view/observer-sources/1",
    definition: "source_statuses entries of the supplied catalog upstream observer report.",
  },
} as const;

// ---------------------------------------------------------------------------
// Title-specific code authorities.

export interface AuthorityContext {
  /** Every catalog identity. */
  ids: ReadonlySet<string>;
  /** Operational definitions as compiled into the catalog. */
  ports: readonly unknown[];
}

export interface AuthorityFinding {
  /** Repository-relative files where the detector matched. */
  files: string[];
  /** Matched table rows, enum variants or files, by the kind's own unit. */
  entries: number;
  /** Covered identities, or null when the detector cannot derive them. */
  identities: string[] | null;
}

export interface AuthorityKind {
  kind: string;
  description: string;
  /** The code shape the detector searches, for operators and the rot check. */
  detector: string;
  /** Declared retired: the detector is expected to find nothing. */
  retired: boolean;
  /** Where identities are not derivable, which kind covers them instead. */
  covered_through?: string;
  detect(root: string, context: AuthorityContext): AuthorityFinding;
}

const coreSource = "crates/portcove-core/src";
const typesFile = `${coreSource}/types.rs`;

const toPosix = (path: string) => path.split(sep).join("/");

function walk(root: string, directory: string, accept: (path: string) => boolean): string[] {
  const absolute = join(root, directory);
  let names: string[];
  try {
    names = readdirSync(absolute).toSorted();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = `${directory}/${name}`;
    const stats = statSync(join(root, path));
    if (stats.isDirectory()) return walk(root, path, accept);
    return stats.isFile() && accept(path) ? [path] : [];
  });
}

function readText(root: string, path: string): string | undefined {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

const sorted = (values: Iterable<string>) => [...new Set(values)].toSorted();
const quotedLiterals = (text: string) =>
  [...text.matchAll(/["'`]([^"'`\n]{1,200})["'`]/gu)].map((match) => match[1]!);

function portRecords(context: AuthorityContext) {
  return context.ports.filter(
    (port): port is Record<string, unknown> => isRecord(port) && typeof port.id === "string",
  );
}

function stringsIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, into);
  else if (isRecord(value)) for (const item of Object.values(value)) stringsIn(item, into);
  return into;
}

function releaseRepository(port: Record<string, unknown>) {
  const release = port.release;
  return isRecord(release) && typeof release.repository === "string" && release.repository
    ? release.repository
    : undefined;
}

/** Text with `#[cfg(test)]`-attributed items removed (brace-matched). */
export function withoutTestItems(text: string): string {
  let result = "";
  let index = 0;
  const attribute = /#\[cfg\((?:test|any\(test[^\]]*)\)\]/gu;
  for (let match = attribute.exec(text); match; match = attribute.exec(text)) {
    if (match.index < index) continue;
    result += text.slice(index, match.index);
    const after = match.index + match[0].length;
    const semicolon = text.indexOf(";", after);
    const brace = text.indexOf("{", after);
    if (brace === -1 || (semicolon !== -1 && semicolon < brace)) {
      index = semicolon === -1 ? text.length : semicolon + 1;
    } else {
      let depth = 0;
      let end = brace;
      for (; end < text.length; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}" && --depth === 0) break;
      }
      index = end + 1;
    }
    attribute.lastIndex = index;
  }
  return result + text.slice(index);
}

/**
 * Production Rust files of Core: test-named files and directories and modules
 * declared under a test configuration attribute are excluded.
 */
function productionRustFiles(root: string): string[] {
  const files = walk(root, coreSource, (path) => path.endsWith(".rs"));
  const testNamed = (path: string) =>
    /\/(?:[a-z0-9_]*_)?(?:tests?|testdata)\//u.test(path.slice(coreSource.length)) ||
    /(?:^|[/_])tests?(?:_[a-z0-9_]+)?\.rs$/u.test(path) ||
    /(?:^|\/)test_[a-z0-9_]+\.rs$/u.test(path);
  const testModules = new Set<string>();
  for (const file of files) {
    const text = readText(root, file) ?? "";
    const base = /(?:^|\/)(?:lib|mod|main)\.rs$/u.test(file)
      ? dirname(file)
      : file.replace(/\.rs$/u, "");
    for (const match of text.matchAll(
      /#\[cfg\((?:test|any\(test[^\]]*)\)\]\s*(?:pub(?:\([a-z]+\))?\s+)?mod\s+([a-z0-9_]+)\s*;/gu,
    )) {
      testModules.add(`${base}/${match[1]}.rs`);
      testModules.add(`${base}/${match[1]}/`);
    }
  }
  return files.filter(
    (file) =>
      !testNamed(file) &&
      ![...testModules].some((module) =>
        module.endsWith("/") ? file.startsWith(module) : file === module,
      ),
  );
}

interface ParsedEnum {
  variants: { name: string; serialized: string }[];
}

const kebab = (name: string) => name.replace(/(?<!^)([A-Z])/gu, "-$1").toLowerCase();

/** Variants of a fieldless `pub enum`, with their serde names. */
function parseEnum(text: string, name: string): ParsedEnum | undefined {
  const start = text.search(new RegExp(`pub enum ${name}\\s*\\{`, "u"));
  if (start === -1) return undefined;
  const header = text.slice(Math.max(0, start - 400), start);
  const lastItem = Math.max(header.lastIndexOf("}"), header.lastIndexOf(";"));
  const attributes = header.slice(lastItem + 1);
  const renameAll = /rename_all\s*=\s*"kebab-case"/u.test(attributes);
  const open = text.indexOf("{", start);
  const close = text.indexOf("}", open);
  const body = text.slice(open + 1, close);
  const variants: ParsedEnum["variants"] = [];
  let rename: string | undefined;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const renamed = /^#\[serde\(rename\s*=\s*"([^"]+)"\)\]$/u.exec(line);
    if (renamed) rename = renamed[1];
    const variant = /^([A-Z][A-Za-z0-9]*)\s*,?$/u.exec(line);
    if (variant) {
      const variantName = variant[1]!;
      variants.push({
        name: variantName,
        serialized: rename ?? (renameAll ? kebab(variantName) : variantName),
      });
      rename = undefined;
    }
  }
  return { variants };
}

function closedEnumKind(kind: string, enumName: string, description: string): AuthorityKind {
  return {
    kind,
    description,
    detector: `\`pub enum ${enumName}\` variants in ${typesFile}`,
    retired: false,
    detect(root, context) {
      const parsed = parseEnum(readText(root, typesFile) ?? "", enumName);
      if (!parsed?.variants.length) return { files: [], entries: 0, identities: [] };
      const values = new Set(parsed.variants.map((variant) => variant.serialized));
      const identities = portRecords(context)
        .filter((port) => [...stringsIn(port)].some((value) => values.has(value)))
        .map((port) => port.id as string);
      return {
        files: [typesFile],
        entries: parsed.variants.length,
        identities: sorted(identities),
      };
    },
  };
}

/** The declared inventory of title-specific authority kinds. */
export const authorityKinds: readonly AuthorityKind[] = [
  {
    kind: "family-generator-script",
    description:
      "Catalog generator or check scripts that select their records by a literal catalog identity or a literal upstream repository of an operational definition.",
    detector:
      "scripts/catalog-*-*.mts (not tests) containing a quoted catalog identity or operational release repository",
    retired: false,
    detect(root, context) {
      const repositories = new Map<string, string[]>();
      for (const port of portRecords(context)) {
        const repository = releaseRepository(port)?.toLowerCase();
        if (repository)
          repositories.set(repository, [
            ...(repositories.get(repository) ?? []),
            port.id as string,
          ]);
      }
      const files: string[] = [];
      const identities = new Set<string>();
      for (const file of walk(
        root,
        "scripts",
        (path) => /^scripts\/catalog-[^/]+-[^/]+\.mts$/u.test(path) && !path.endsWith(".test.mts"),
      )) {
        const found = new Set<string>();
        for (const literal of quotedLiterals(readText(root, file) ?? "")) {
          if (context.ids.has(literal)) found.add(literal);
          const repository = literal
            .replace(/^https:\/\/github\.com\//u, "")
            .replace(/\.git$/u, "")
            .toLowerCase();
          for (const id of repositories.get(repository) ?? []) found.add(id);
        }
        if (found.size) {
          files.push(file);
          for (const id of found) identities.add(id);
        }
      }
      return { files, entries: files.length, identities: sorted(identities) };
    },
  },
  {
    kind: "core-title-literal",
    description:
      "Production Core Rust source that compares or binds a literal catalog identity (test modules excluded).",
    detector: `${coreSource}/**/*.rs production files containing a quoted catalog identity`,
    retired: false,
    detect(root, context) {
      const files: string[] = [];
      const identities = new Set<string>();
      for (const file of productionRustFiles(root)) {
        const text = withoutTestItems(readText(root, file) ?? "");
        const found = [...text.matchAll(/"([a-z0-9][a-z0-9-]*[a-z0-9])"/gu)]
          .map((match) => match[1]!)
          .filter((literal) => context.ids.has(literal));
        if (found.length) {
          files.push(file);
          for (const id of found) identities.add(id);
        }
      }
      return { files, entries: files.length, identities: sorted(identities) };
    },
  },
  closedEnumKind(
    "external-profile-policy",
    "ExternalProfilePolicy",
    "Closed upstream profile resolution variants for managed portable players.",
  ),
  {
    kind: "native-external-profile-module",
    description: "Per-runtime native external profile resolver modules.",
    detector: `${coreSource}/native_external_profile/*.rs`,
    retired: false,
    covered_through: "external-profile-policy",
    detect(root) {
      const files = walk(root, `${coreSource}/native_external_profile`, (path) =>
        path.endsWith(".rs"),
      );
      return { files, entries: files.length, identities: null };
    },
  },
  closedEnumKind(
    "managed-initialization",
    "ManagedInitialization",
    "Closed initialization recipes selected by a definition.",
  ),
  closedEnumKind(
    "runtime-data-policy",
    "RuntimeDataPolicy",
    "Closed handling of runtime-owned host credentials selected by a definition.",
  ),
  closedEnumKind(
    "prepared-runtime-settings-contract",
    "PreparedRuntimeSettingsContract",
    "Closed settings contracts for runtimes the player prepares.",
  ),
  closedEnumKind(
    "prepared-shared-preferences-contract",
    "PreparedSharedPreferencesContract",
    "Closed reviewed shared preference write scopes.",
  ),
  {
    kind: "provider-binding-table",
    description: "Compiled tables binding a port identity to a mod provider's game identity.",
    detector: `\`const *_BINDINGS: &[(&str, ...)]\` tables in ${coreSource}/**/*.rs`,
    retired: false,
    detect(root, context) {
      const files: string[] = [];
      const identities = new Set<string>();
      let entries = 0;
      for (const file of productionRustFiles(root)) {
        const text = readText(root, file) ?? "";
        let matched = false;
        for (const table of text.matchAll(
          /const\s+[A-Z0-9_]+_BINDINGS\s*:\s*&\[\(&str,[^\]]*\]\s*=\s*&\[([\s\S]*?)\];/gu,
        )) {
          matched = true;
          for (const row of table[1]!.matchAll(/\(\s*"([^"]+)"\s*,/gu)) {
            entries++;
            if (context.ids.has(row[1]!)) identities.add(row[1]!);
          }
        }
        if (matched) files.push(file);
      }
      return { files, entries, identities: sorted(identities) };
    },
  },
  {
    kind: "github-mod-source-table",
    description: "Compiled reviewed GitHub mod source rows keyed by runtime repository and game.",
    detector: `\`const SOURCES: &[ReviewedSource]\` rows in ${coreSource}/github_mods.rs`,
    retired: false,
    detect(root, context) {
      const file = `${coreSource}/github_mods.rs`;
      const table = /const\s+SOURCES\s*:\s*&\[ReviewedSource\]\s*=\s*&\[([\s\S]*?)\];/u.exec(
        readText(root, file) ?? "",
      );
      if (!table) return { files: [], entries: 0, identities: [] };
      const rows = [
        ...table[1]!.matchAll(
          /ReviewedSource\s*\{\s*runtime_repository:\s*"([^"]+)",\s*game:\s*"([^"]+)"/gu,
        ),
      ];
      const identities = portRecords(context)
        .filter((port) => {
          const repository = releaseRepository(port)?.toLowerCase();
          const games = stringsIn(port);
          return rows.some((row) => row[1]!.toLowerCase() === repository && games.has(row[2]!));
        })
        .map((port) => port.id as string);
      return {
        files: [file],
        entries: rows.length,
        identities: sorted(identities),
      };
    },
  },
  {
    kind: "external-mod-portals",
    description: "Reviewed per-port external mod portal bindings.",
    detector: "crates/portcove-core/catalog/external-mod-portals.json entries",
    retired: false,
    detect(root, context) {
      const file = "crates/portcove-core/catalog/external-mod-portals.json";
      const text = readText(root, file);
      if (text === undefined) return { files: [], entries: 0, identities: [] };
      const rows: unknown = parseCatalogSource(text);
      const entries = Array.isArray(rows) ? rows : [];
      const identities = entries
        .map((entry: unknown) => (isRecord(entry) ? entry.port : undefined))
        .filter((id): id is string => typeof id === "string" && context.ids.has(id));
      return {
        files: entries.length ? [file] : [],
        entries: entries.length,
        identities: sorted(identities),
      };
    },
  },
];

export interface AuthorityReport {
  kind: string;
  description: string;
  detector: string;
  state: "active" | "retired";
  declared_retired: boolean;
  count: number;
  files: string[];
  identities: string[] | null;
  covered_through?: string;
}

export function detectAuthorities(
  root: string,
  context: AuthorityContext,
  kinds: readonly AuthorityKind[] = authorityKinds,
): AuthorityReport[] {
  return kinds.map((kind) => {
    const finding = kind.detect(root, context);
    return {
      kind: kind.kind,
      description: kind.description,
      detector: kind.detector,
      state: finding.entries > 0 ? "active" : "retired",
      declared_retired: kind.retired,
      count: finding.entries,
      files: sorted(finding.files.map(toPosix)),
      identities: finding.identities,
      ...(kind.covered_through ? { covered_through: kind.covered_through } : {}),
    };
  });
}

/**
 * The inventory cannot rot silently: a detector that finds nothing must be
 * declared retired, and a kind declared retired must stay empty.
 */
export function authorityInventoryErrors(reports: readonly AuthorityReport[]): string[] {
  const errors: string[] = [];
  const kinds = new Set<string>();
  for (const report of reports) {
    if (kinds.has(report.kind)) errors.push(`Authority kind ${report.kind} is declared twice.`);
    kinds.add(report.kind);
    if (report.state === "retired" && !report.declared_retired)
      errors.push(
        `Authority kind ${report.kind} found nothing (${report.detector}) but is not declared retired; fix the detector or declare the kind retired.`,
      );
    if (report.state === "active" && report.declared_retired)
      errors.push(`Authority kind ${report.kind} is declared retired but its detector matches.`);
    if (report.covered_through && !reports.some((other) => other.kind === report.covered_through))
      errors.push(`Authority kind ${report.kind} names an unknown kind ${report.covered_through}.`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The view.

export type ProductScope = "in-scope" | "deferred-scummvm";
export const actionClasses = [
  "none",
  "retire-title-authority",
  "data-enrollment",
  "observation",
  "bytes-worker",
  "admission",
  "missing-capability",
  "upstream-condition",
  "owner-decision",
] as const;
export type ActionClass = (typeof actionClasses)[number];

const dispositionAction: Record<Exclude<Disposition, "enrolled">, ActionClass> = {
  "data-only": "data-enrollment",
  "needs-bytes-worker": "bytes-worker",
  unobserved: "observation",
  "needs-admission": "admission",
  "missing-capability": "missing-capability",
  "upstream-condition": "upstream-condition",
  "excluded-scummvm": "owner-decision",
};

export interface ProgramSubject {
  id: string;
  scope: ProductScope;
  disposition: Disposition;
  reason: string;
  family: string;
  restrictions: { declared: number; held_operations: string[] };
  /** Title-specific authority kinds that still serve this identity. */
  title_code_paths: string[];
  remaining_action: ActionClass;
}

export interface Ratio {
  numerator: number;
  denominator: { version: string; definition: string; count: number };
  ratio: number | null;
}

export interface CoverageGate extends Ratio {
  gate: string;
  passed: boolean;
  failing: { id: string; detail: string }[];
}

export type ObserverCoverage =
  | { state: "unknown"; reason: string }
  | {
      state: "reported";
      denominator: Ratio["denominator"];
      by_state: Record<"complete" | "pending" | "partial" | "unavailable" | "failed", number>;
    };

export interface ProgramView {
  format_version: 1;
  view_version: typeof programViewVersion;
  authority: "derived-read-only-projection";
  planning_authority: string;
  inputs: {
    route_fit_format_version: number;
    route_fit_observer_report: "absent" | "applied";
    handoff_policy_version: string;
    handoff_contract_version: string;
    observer_report: "absent" | "applied";
  };
  gates: { fitting: CoverageGate; retired_authority: CoverageGate };
  metrics: {
    by_disposition: {
      denominator: Ratio["denominator"];
      counts: Record<Disposition, number>;
    };
    by_family: {
      denominator: Ratio["denominator"];
      counts: Record<string, number>;
    };
    listing_only_github_packages_windows_x86_64: number;
    restricted_by_operation: {
      denominator: Ratio["denominator"];
      restricted_identities: number;
      held: Record<string, number>;
    };
    handoff_classes: {
      denominator: Ratio["denominator"];
      dispatch: Record<string, number>;
      classes: {
        kind: string;
        source: string;
        authority: string;
        dispatch: string;
        contract: boolean;
      }[];
    };
    observer_coverage: ObserverCoverage;
  };
  remaining_actions: {
    denominator: Ratio["denominator"];
    counts: Record<ActionClass, number>;
  };
  authority_kinds: AuthorityReport[];
  subjects: ProgramSubject[];
}

export interface ProgramViewInputs {
  routeFit: RouteFitReport;
  authorities: readonly AuthorityReport[];
  /** A catalog upstream observer report with `source_statuses`; absent is unknown. */
  observerReport?: unknown;
}

const denominator = (key: keyof typeof denominators, count: number) => ({
  ...denominators[key],
  count,
});

function gate(
  name: string,
  passing: number,
  count: Ratio["denominator"],
  failing: CoverageGate["failing"],
): CoverageGate {
  return {
    gate: name,
    numerator: passing,
    denominator: count,
    ratio: count.count ? Number((passing / count.count).toFixed(6)) : null,
    passed: failing.length === 0,
    failing,
  };
}

function observerCoverage(report: unknown): ObserverCoverage {
  if (report === undefined)
    return {
      state: "unknown",
      reason: "No observer report was supplied; coverage is unknown, not zero.",
    };
  if (!isRecord(report) || !Array.isArray(report.source_statuses))
    throw new Error("Observer report needs a source_statuses array.");
  const byState = {
    complete: 0,
    pending: 0,
    partial: 0,
    unavailable: 0,
    failed: 0,
  };
  for (const status of report.source_statuses) {
    if (!isRecord(status)) throw new Error("Observer report contains an invalid source status.");
    const kind = isRecord(status.coverage) ? status.coverage.kind : undefined;
    if (kind === "partial" || kind === "unavailable" || kind === "failed") byState[kind]++;
    else if (kind !== undefined)
      throw new Error(`Unknown observer coverage kind ${JSON.stringify(kind)}.`);
    else if (status.current_scope_complete === true) byState.complete++;
    else byState.pending++;
  }
  return {
    state: "reported",
    denominator: denominator("observerSources", report.source_statuses.length),
    by_state: byState,
  };
}

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Pure projection; equal inputs serialize byte-identically. */
export function programView(inputs: ProgramViewInputs): ProgramView {
  const errors = authorityInventoryErrors(inputs.authorities);
  if (errors.length) throw new Error(errors.join("\n"));
  const covering = new Map<string, string[]>();
  for (const report of inputs.authorities)
    for (const id of report.identities ?? [])
      covering.set(id, [...(covering.get(id) ?? []), report.kind]);

  const subjects = inputs.routeFit.identities
    .map((identity): ProgramSubject => {
      const scope: ProductScope =
        identity.disposition === "excluded-scummvm" ? "deferred-scummvm" : "in-scope";
      const paths = sorted(covering.get(identity.id) ?? []);
      const action: ActionClass =
        identity.disposition === "enrolled"
          ? paths.length
            ? "retire-title-authority"
            : "none"
          : dispositionAction[identity.disposition];
      return {
        id: identity.id,
        scope,
        disposition: identity.disposition,
        reason: identity.reason,
        family: `${identity.family.adapter}/${identity.family.provider}`,
        restrictions: {
          declared: identity.restrictions.length,
          held_operations: Object.keys(identity.held_operations).toSorted(),
        },
        title_code_paths: paths,
        remaining_action: action,
      };
    })
    .toSorted((left, right) => compare(left.id, right.id));

  const inScope = subjects.filter((subject) => subject.scope === "in-scope");
  const unfitted = inScope.filter((subject) => subject.disposition === "unobserved");
  const enrolled = inScope.filter((subject) => subject.disposition === "enrolled");
  const titleServed = enrolled.filter((subject) => subject.title_code_paths.length);

  const byDisposition = Object.fromEntries(dispositions.map((name) => [name, 0])) as Record<
    Disposition,
    number
  >;
  for (const subject of subjects) byDisposition[subject.disposition]++;
  const byFamily: Record<string, number> = {};
  for (const subject of subjects.toSorted((left, right) => compare(left.family, right.family)))
    byFamily[subject.family] = (byFamily[subject.family] ?? 0) + 1;
  const held: Record<string, number> = {};
  for (const operation of sorted(
    subjects.flatMap((subject) => subject.restrictions.held_operations),
  ))
    held[operation] = subjects.filter((subject) =>
      subject.restrictions.held_operations.includes(operation),
    ).length;
  const actions = Object.fromEntries(actionClasses.map((name) => [name, 0])) as Record<
    ActionClass,
    number
  >;
  for (const subject of subjects) actions[subject.remaining_action]++;
  const dispatch: Record<string, number> = {};
  for (const entry of handoffRegistry)
    dispatch[entry.dispatch] = (dispatch[entry.dispatch] ?? 0) + 1;

  return {
    format_version: 1,
    view_version: programViewVersion,
    authority: "derived-read-only-projection",
    planning_authority:
      "GitHub Projects and the canonical issues own planning, priority and status; this view is an operator projection of committed facts.",
    inputs: {
      route_fit_format_version: inputs.routeFit.format_version,
      route_fit_observer_report: inputs.routeFit.summary.observer_report,
      handoff_policy_version: handoffPolicyVersion,
      handoff_contract_version: handoffContractVersion,
      observer_report: inputs.observerReport === undefined ? "absent" : "applied",
    },
    gates: {
      fitting: gate(
        "fitting",
        inScope.length - unfitted.length,
        denominator("inScope", inScope.length),
        unfitted.map((subject) => ({ id: subject.id, detail: subject.reason })),
      ),
      retired_authority: gate(
        "retired-authority",
        enrolled.length - titleServed.length,
        denominator("inScopeEnrolled", enrolled.length),
        titleServed.map((subject) => ({
          id: subject.id,
          detail: `Served by ${subject.title_code_paths.join(", ")}.`,
        })),
      ),
    },
    metrics: {
      by_disposition: {
        denominator: denominator("identities", subjects.length),
        counts: byDisposition,
      },
      by_family: {
        denominator: denominator("identities", subjects.length),
        counts: byFamily,
      },
      listing_only_github_packages_windows_x86_64:
        inputs.routeFit.summary.listing_only_github_packages_windows_x86_64,
      restricted_by_operation: {
        denominator: denominator("identities", subjects.length),
        restricted_identities: subjects.filter((subject) => subject.restrictions.declared).length,
        held,
      },
      handoff_classes: {
        denominator: denominator("handoffClasses", handoffRegistry.length),
        dispatch,
        classes: handoffRegistry
          .map((entry) => ({
            kind: entry.kind,
            source: entry.source,
            authority: entry.authority,
            dispatch: entry.dispatch,
            contract: entry.kind in handoffContracts,
          }))
          .toSorted((left, right) => compare(left.kind, right.kind)),
      },
      observer_coverage: observerCoverage(inputs.observerReport),
    },
    remaining_actions: {
      denominator: denominator("identities", subjects.length),
      counts: actions,
    },
    authority_kinds: [...inputs.authorities].toSorted((left, right) =>
      compare(left.kind, right.kind),
    ),
    subjects,
  };
}

export function serializeProgramView(view: ProgramView): string {
  return `${JSON.stringify(view, null, 2)}\n`;
}

const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

export function renderProgramView(view: ProgramView): string {
  const row = (name: string, value: string | number) =>
    `  ${name.padEnd(48)} ${String(value).padStart(10)}`;
  const gateLine = (label: string, value: CoverageGate) =>
    `${label}: ${value.numerator}/${value.denominator.count} (${percent(value.ratio)}) [${value.denominator.version}] ${value.passed ? "passed" : `${value.failing.length} failing`}`;
  const observer = view.metrics.observer_coverage;
  return [
    `Program cutover view (${view.view_version}; read-only projection, not a planning authority)`,
    gateLine("Fitting coverage", view.gates.fitting),
    gateLine("Retired-authority coverage", view.gates.retired_authority),
    "Remaining actions:",
    ...Object.entries(view.remaining_actions.counts).map(([name, count]) => row(name, count)),
    "Title-specific authority kinds:",
    ...view.authority_kinds.map((kind) =>
      row(
        `${kind.kind} (${kind.state})`,
        `${kind.count}${kind.identities ? ` / ${kind.identities.length} ids` : ""}`,
      ),
    ),
    `Handoff classes: ${view.metrics.handoff_classes.denominator.count} (${Object.entries(
      view.metrics.handoff_classes.dispatch,
    )
      .map(([state, count]) => `${count} dispatch ${state}`)
      .join(", ")})`,
    observer.state === "unknown"
      ? "Observer coverage: unknown (no observer report supplied)"
      : `Observer coverage: ${Object.entries(observer.by_state)
          .map(([state, count]) => `${state} ${count}`)
          .join(", ")} of ${observer.denominator.count} sources`,
  ].join("\n");
}

/** Every route-fit identity appears exactly once, in id order. */
export function checkProgramView(view: ProgramView, routeFit: RouteFitReport) {
  const expected = routeFit.identities.map((identity) => identity.id).toSorted(compare);
  if (JSON.stringify(view.subjects.map((subject) => subject.id)) !== JSON.stringify(expected))
    throw new Error("Program view must list every route-fit identity exactly once, in id order.");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function readProgramViewInputs(
  repositoryRoot: string,
  options: { observations?: string; observerReport?: string } = {},
): ProgramViewInputs & { routeFitInputs: RouteFitInputs } {
  const routeFitInputs = readRouteFitInputs(repositoryRoot, options.observations);
  const routeFit = routeFitReport(routeFitInputs);
  checkRouteFitReport(routeFit, routeFitInputs.records);
  const authorities = detectAuthorities(repositoryRoot, {
    ids: new Set(routeFit.identities.map((identity) => identity.id)),
    ports: routeFitInputs.ports,
  });
  return {
    routeFitInputs,
    routeFit,
    authorities,
    ...(options.observerReport === undefined
      ? {}
      : {
          observerReport: parseCatalogSource(readFileSync(options.observerReport, "utf8")),
        }),
  };
}

const usage =
  "Usage: node scripts/maintenance-program-view.mts [--check] [--json] [--output FILE] [--observations LISTING_UPDATES.json] [--observer-report CATALOG_OBSERVER_REPORT.json]";

export function main(argv: readonly string[], repositoryRoot = root): string {
  const options = { check: false, json: false } as {
    check: boolean;
    json: boolean;
    output?: string;
    observations?: string;
    observerReport?: string;
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--json") options.json = true;
    else if (
      argument === "--output" ||
      argument === "--observations" ||
      argument === "--observer-report"
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(usage);
      const key = argument === "--observer-report" ? "observerReport" : argument.slice(2);
      options[key as "output" | "observations" | "observerReport"] = resolve(value);
    } else throw new Error(usage);
  }
  const inputs = readProgramViewInputs(repositoryRoot, options);
  const view = programView(inputs);
  checkProgramView(view, inputs.routeFit);
  const serialized = serializeProgramView(view);
  if (options.check) {
    const again = readProgramViewInputs(repositoryRoot, options);
    if (serializeProgramView(programView(again)) !== serialized)
      throw new Error("Program view is not deterministic.");
  }
  if (options.output) writeFileSync(options.output, serialized);
  return options.json ? serialized : `${renderProgramView(view)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
