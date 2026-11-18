/** Optional research observations. These records never enter Core operation eligibility. */
import { createHash } from "node:crypto";
import { observationHash } from "./upstream-observer.mts";
import { isRecord } from "./runtime-values.mts";
import { DiscoveryBudget, createDiscoveryTransport } from "./discovery-budget.mts";

export type ProgressProvider =
  | "bytematch"
  | "decompdev"
  | "frogress"
  | "project-report"
  | "project-csv";
export type ProgressMetricKind =
  | "matching-code"
  | "decompiled-code"
  | "fuzzy-similarity"
  | "linked-code"
  | "matched-functions";
export interface ProgressSource {
  repository: string;
  game_key: string;
  version: string;
  provider: ProgressProvider;
  /** Reviewed primary documentation binding this exact provider, project and edition. */
  evidence_url: string;
  methodology: string;
  opt_out?: boolean;
  /** frogress only: explicitly reviewed project/category/measure, never guessed from a badge. */
  project?: string;
  category?: string;
  measure?: string;
  metric_kind?: "matching-code" | "decompiled-code" | "linked-code";
  /** Project reports only: reviewed HTTPS report endpoint. */
  report_url?: string;
  csv?: { numerator: number; denominator: number; timestamp: number; commit: number };
  /** An existing recorded research condition; does not reverse a deferral. */
  reconsider?: { condition: string; metric: ProgressMetricKind; threshold: number };
}
export interface ProgressMetric {
  kind: ProgressMetricKind;
  /** Provider decimal token or unrounded derived ratio. Integer counts retain exact decimal strings. */
  value: string;
  numerator: string | null;
  denominator: string | null;
}
export interface ProgressRecord {
  repository: string;
  game_key: string;
  version: string;
  provider: ProgressProvider;
  source_url: string;
  evidence_url: string;
  methodology: string;
  commit: string | null;
  observed_at: string | null;
  metrics: ProgressMetric[];
  content_sha256: string;
  authority: "research-only";
}
export interface ProgressResult {
  key: string;
  source: ProgressSource;
  status: "observed" | "unavailable" | "failed" | "opted-out";
  checked_at: string;
  record?: ProgressRecord;
  reason?: string;
}
export interface ProgressCollection {
  revision: string;
  checked_at: string;
  results: ProgressResult[];
}
const https = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash;
  } catch {
    return false;
  }
};
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(v);
export function validateProgressSources(value: unknown): ProgressSource[] {
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    !Array.isArray(value.sources) ||
    value.sources.length > 128
  )
    throw new Error("Invalid bounded progress source manifest");
  const seen = new Set<string>();
  for (const row of value.sources) {
    if (
      !isRecord(row) ||
      typeof row.repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(row.repository) ||
      typeof row.game_key !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(row.game_key) ||
      typeof row.version !== "string" ||
      !/^[A-Za-z0-9_.-]{1,40}$/u.test(row.version) ||
      typeof row.provider !== "string" ||
      !["bytematch", "decompdev", "frogress", "project-report", "project-csv"].includes(
        row.provider,
      ) ||
      !https(row.evidence_url) ||
      !text(row.methodology) ||
      (row.opt_out !== undefined && typeof row.opt_out !== "boolean")
    )
      throw new Error("Progress source needs reviewed project, edition and primary evidence");
    if (
      row.provider === "frogress" &&
      (![row.project, row.category, row.measure].every(
        (v) => typeof v === "string" && /^[A-Za-z0-9_.-]{1,100}$/u.test(v),
      ) ||
        !["matching-code", "decompiled-code", "linked-code"].includes(String(row.metric_kind)))
    )
      throw new Error("Frogress source needs an exact reviewed measure");
    if (["project-report", "project-csv"].includes(row.provider) && !https(row.report_url))
      throw new Error("Project report requires a reviewed HTTPS endpoint");
    if (
      row.provider === "project-csv" &&
      (!isRecord(row.csv) ||
        ![row.csv.numerator, row.csv.denominator, row.csv.timestamp, row.csv.commit].every(
          (v) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 63,
        ))
    )
      throw new Error("CSV source needs reviewed column positions");
    if (
      row.reconsider !== undefined &&
      (!isRecord(row.reconsider) ||
        !text(row.reconsider.condition) ||
        ![
          "matching-code",
          "decompiled-code",
          "fuzzy-similarity",
          "linked-code",
          "matched-functions",
        ].includes(String(row.reconsider.metric)) ||
        typeof row.reconsider.threshold !== "number" ||
        !Number.isFinite(row.reconsider.threshold) ||
        row.reconsider.threshold < 0 ||
        row.reconsider.threshold > 100)
    )
      throw new Error(
        "Progress reconsideration needs an existing condition and exact metric threshold",
      );
    const key = progressKey(row as unknown as ProgressSource);
    if (seen.has(key)) throw new Error("Duplicate progress source identity");
    seen.add(key);
  }
  return structuredClone(value.sources) as ProgressSource[];
}
export function progressKey(source: ProgressSource) {
  const scope = {
    repository: source.repository.toLowerCase(),
    game_key: source.game_key,
    version: source.version,
    provider: source.provider,
    project: source.project ?? null,
    category: source.category ?? null,
    measure: source.measure ?? null,
    metric_kind: source.metric_kind ?? null,
    report_url: source.report_url ?? null,
    csv: source.csv ?? null,
  };
  return `progress:${source.game_key}:${observationHash(scope).slice(0, 32)}`;
}
export function progressUrl(source: ProgressSource) {
  if (source.provider === "bytematch" || source.provider === "decompdev")
    return `https://${source.provider === "bytematch" ? "bytematch.dev" : "decomp.dev"}/${source.repository}/${encodeURIComponent(source.version)}.json`;
  if (source.provider === "frogress")
    return `https://progress.deco.mp/data/${source.project}/${encodeURIComponent(source.version)}/${source.category}/?mode=latest`;
  return source.report_url!;
}
const decimal = (value: unknown, percent: boolean): string | null => {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "number" || typeof value === "string" ? String(value) : "";
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(raw) ||
    raw.length > 64 ||
    !Number.isFinite(Number(raw)) ||
    (percent && Number(raw) > 100)
  )
    throw new Error("Invalid progress metric precision/range");
  const exact = exactDecimal(raw);
  if (percent && exact.numerator > 100n * exact.denominator)
    throw new Error("Invalid progress metric precision/range");
  return raw;
};
const count = (v: unknown) => {
  if (typeof v === "number" && !Number.isSafeInteger(v))
    throw new Error("Unsafe numeric progress count");
  const raw = decimal(v, false);
  if (raw !== null && !/^\d+$/u.test(raw)) throw new Error("Fractional progress count");
  return raw;
};
function metric(
  kind: ProgressMetricKind,
  value: unknown,
  numerator: unknown,
  denominator: unknown,
): ProgressMetric | null {
  const raw = decimal(value, true),
    n = count(numerator),
    d = count(denominator);
  if (n !== null && d !== null && BigInt(n) > BigInt(d))
    throw new Error("Progress numerator exceeds denominator");
  return raw === null ? null : { kind, value: raw, numerator: n, denominator: d };
}
function measures(value: unknown): ProgressMetric[] {
  if (!isRecord(value)) throw new Error("Missing structured progress measures");
  const field = (name: string) =>
    value[name] ?? value[name.replace(/_([a-z])/gu, (_, c: string) => c.toUpperCase())];
  const definitions: [ProgressMetricKind, string, string, string][] = [
    ["matching-code", "matched_code_percent", "matched_code", "total_code"],
    ["fuzzy-similarity", "fuzzy_match_percent", "missing", "missing"],
    ["linked-code", "complete_code_percent", "complete_code", "total_code"],
    ["matched-functions", "matched_functions_percent", "matched_functions", "total_functions"],
  ];
  if (
    field("matched_functions_percent") === undefined &&
    field("matched_functions") !== undefined &&
    field("total_functions") !== undefined
  ) {
    const n = count(field("matched_functions")),
      d = count(field("total_functions"));
    if (n !== null && d !== null && BigInt(d) > 0n)
      value.matched_functions_percent = (Number(n) / Number(d)) * 100;
  }
  const result = definitions
    .map(([kind, v, n, d]) => metric(kind, field(v), field(n), field(d)))
    .filter((v): v is ProgressMetric => v !== null);
  if (!result.length) throw new Error("No attributable progress metrics");
  return result;
}
function observed(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const ms =
    typeof value === "number"
      ? value * 1000
      : typeof value === "string"
        ? /^\d+(?:\.\d+)?$/u.test(value)
          ? Number(value) * 1000
          : Date.parse(value)
        : NaN;
  if (!Number.isFinite(ms)) throw new Error("Invalid source observation clock");
  return new Date(ms).toISOString();
}
const commit = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^[a-f0-9]{40}$/u.test(v))
    throw new Error("Progress commit is not immutable");
  return v;
};
/** Untrusted JSON is data. Provider ownership and exact edition are checked before metrics. */
export function parseProgress(source: ProgressSource, body: string): ProgressRecord {
  if (Buffer.byteLength(body) > 2 * 1024 * 1024)
    throw new Error("Progress report exceeds byte cap");
  let metrics: ProgressMetric[],
    at: string | null = null,
    revision: string | null = null;
  if (source.provider === "project-csv") {
    const columns = source.csv!;
    const rows = body.trim().split(/\r?\n/u).filter(Boolean);
    if (rows.length > 20000) throw new Error("Progress CSV exceeds row cap");
    let latest = -Infinity,
      selected: string[] | undefined;
    for (const row of rows) {
      const values = row.split(",");
      if (values.length > 64 || !/^\d+$/u.test(values[columns.timestamp] ?? ""))
        throw new Error("Malformed structured progress CSV");
      const t = Number(values[columns.timestamp]);
      if (t >= latest) {
        latest = t;
        selected = values;
      }
    }
    if (!selected) throw new Error("Progress CSV has no observations");
    const n = count(selected[columns.numerator]),
      d = count(selected[columns.denominator]);
    if (n === null || d === null || BigInt(d) === 0n)
      throw new Error("Progress CSV denominator unavailable");
    const raw = (Number(n) / Number(d)) * 100;
    metrics = [metric("matching-code", raw, n, d)!];
    at = observed(latest);
    revision = commit(selected[columns.commit]);
  } else {
    let data: unknown;
    try {
      data = JSON.parse(body, (_key: string, value: unknown, context?: { source?: string }) => {
        // Node's pinned JSON reviver exposes the original token before IEEE-754 rounding.
        if (typeof value !== "number") return value;
        if (!context?.source) throw new Error("Exact numeric JSON source unavailable");
        return context.source;
      });
    } catch {
      throw new Error("Malformed progress JSON");
    }
    if (!isRecord(data)) throw new Error("Unsupported progress JSON");
    if (source.provider === "frogress") {
      const p = data[source.project!],
        v = isRecord(p) ? p[source.version] : null,
        c = isRecord(v) ? v[source.category!] : null;
      const row: unknown = Array.isArray(c) && c.length === 1 ? c[0] : null;
      if (!isRecord(row) || !isRecord(row.measures))
        throw new Error("Frogress exact edition/category unavailable");
      const n = count(row.measures[source.measure!]),
        d = count(row.measures[`${source.measure!}/total`]);
      if (n === null || d === null || BigInt(d) === 0n)
        throw new Error("Frogress exact metric unavailable");
      metrics = [metric(source.metric_kind!, (Number(n) / Number(d)) * 100, n, d)!];
      at = observed(row.timestamp);
      revision = commit(row.git_hash);
    } else {
      if (source.provider !== "project-report") {
        if (
          typeof data.owner !== "string" ||
          typeof data.repo !== "string" ||
          `${data.owner}/${data.repo}`.toLowerCase() !== source.repository.toLowerCase()
        )
          throw new Error("Progress provider repository identity mismatch");
        // Version-specific endpoints must prove that exact edition; no default substitution.
        if ((data.version ?? data.default_version) !== source.version)
          throw new Error("Progress provider edition mismatch");
      } else if (data.version !== undefined && data.version !== source.version)
        throw new Error("Project report edition mismatch");
      metrics = measures(data.measures);
      const c = isRecord(data.commit) ? data.commit : null;
      at = observed(c?.timestamp ?? data.timestamp);
      revision = commit(c?.sha ?? data.git_commit);
    }
  }
  return {
    repository: source.repository,
    game_key: source.game_key,
    version: source.version,
    provider: source.provider,
    source_url: progressUrl(source),
    evidence_url: source.evidence_url,
    methodology: source.methodology,
    commit: revision,
    observed_at: at,
    metrics,
    content_sha256: createHash("sha256").update(body).digest("hex"),
    authority: "research-only",
  };
}
export type ProgressRead = (url: string) => Promise<{ status: number; text: string }>;
/** One failed enrichment source never prevents other reviewed sources from completing. */
export async function collectProgress(
  sources: readonly ProgressSource[],
  read?: ProgressRead,
  now = new Date(),
): Promise<ProgressCollection> {
  sources = validateProgressSources({ format_version: 1, sources });
  const checked = now.toISOString();
  const opted = new Set(sources.filter((s) => s.opt_out).map((s) => s.repository.toLowerCase()));
  const budget = new DiscoveryBudget("ordinary");
  const external = createDiscoveryTransport(budget, "", undefined, { backoff: "origin" });
  const transport = read ?? (async (url: string) => external.request("GET", url));
  const results: ProgressResult[] = [];
  for (const source of sources) {
    const base = { key: progressKey(source), source, checked_at: checked };
    if (opted.has(source.repository.toLowerCase())) {
      results.push({ ...base, status: "opted-out" });
      continue;
    }
    try {
      const response = await transport(progressUrl(source));
      if (response.status !== 200) {
        results.push({
          ...base,
          status: "unavailable",
          reason: `HTTP ${response.status}; previous observation retained`,
        });
        continue;
      }
      const record = parseProgress(source, response.text);
      if (record.observed_at !== null && Date.parse(record.observed_at) > now.getTime() + 300000)
        throw new Error("Progress source clock is in the future");
      results.push({ ...base, status: "observed", record });
    } catch {
      results.push({
        ...base,
        status: "failed",
        reason: "Bounded progress read or validation failed; previous observation retained",
      });
    }
  }
  return { revision: observationHash(sources), checked_at: checked, results };
}
/** Comparison excludes polling clocks and source commit churn. Counts retain their precision. */
function exactDecimal(value: string) {
  const match = value.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu);
  if (!match) throw new Error("Invalid exact progress decimal");
  const fractional = match[2] ?? "",
    exponent = Number(match[3] ?? 0);
  if (Math.abs(exponent) > 1000) throw new Error("Progress exponent exceeds precision bound");
  const scale = fractional.length - exponent;
  return {
    numerator: BigInt(match[1]! + fractional) * (scale < 0 ? 10n ** BigInt(-scale) : 1n),
    denominator: scale > 0 ? 10n ** BigInt(scale) : 1n,
  };
}
function atLeast(value: string, threshold: number) {
  const left = exactDecimal(value),
    right = exactDecimal(String(threshold));
  return left.numerator * right.denominator >= right.numerator * left.denominator;
}
export function progressCondition(result: ProgressResult) {
  const condition = result.source.reconsider;
  const metric = result.record?.metrics.find((m) => m.kind === condition?.metric);
  if (!condition || !metric || result.status !== "observed") return null;
  const target = exactDecimal(String(condition.threshold));
  const met =
    metric.numerator !== null && metric.denominator !== null
      ? BigInt(metric.denominator) > 0n &&
        BigInt(metric.numerator) * 100n * target.denominator >=
          BigInt(metric.denominator) * target.numerator
      : atLeast(metric.value, condition.threshold);
  return {
    condition: condition.condition,
    metric: condition.metric,
    threshold: condition.threshold,
    met,
    comparability: observationHash({
      provider: result.source.provider,
      version: result.source.version,
      methodology: result.source.methodology,
      source_url: result.record!.source_url,
    }),
  };
}
export function progressDisplay(record: ProgressRecord, checkedAt: string, now = new Date()) {
  return {
    ...record,
    checked_at: checkedAt,
    freshness: now.getTime() - Date.parse(checkedAt) > 36 * 3600000 ? "stale" : "observed",
    display: record.metrics
      .map((m) => {
        if (m.denominator === "0") return `${m.kind}: unavailable (zero denominator)`;
        const incomplete =
          !atLeast(m.value, 100) ||
          (m.numerator !== null &&
            m.denominator !== null &&
            BigInt(m.numerator) < BigInt(m.denominator));
        return `${m.kind}: ${incomplete ? Math.min(99.99, Math.floor(Number(m.value) * 100) / 100) : 100}%`;
      })
      .join("; "),
    explanation:
      "Research progress does not establish a playable release, package, support or qualification.",
  };
}

/** Store/export JSON is still data: malformed optional rows disappear without affecting operations. */
export function validProgressRecord(value: unknown): value is ProgressRecord {
  if (
    !isRecord(value) ||
    typeof value.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) ||
    typeof value.game_key !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(value.game_key) ||
    typeof value.version !== "string" ||
    !/^[A-Za-z0-9_.-]{1,40}$/u.test(value.version) ||
    typeof value.provider !== "string" ||
    !["bytematch", "decompdev", "frogress", "project-report", "project-csv"].includes(
      value.provider,
    ) ||
    !https(value.source_url) ||
    !https(value.evidence_url) ||
    !text(value.methodology) ||
    value.authority !== "research-only" ||
    typeof value.content_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.content_sha256) ||
    !(
      value.observed_at === null ||
      (typeof value.observed_at === "string" && Number.isFinite(Date.parse(value.observed_at)))
    ) ||
    !Array.isArray(value.metrics) ||
    !value.metrics.length ||
    value.metrics.length > 16
  )
    return false;
  try {
    commit(value.commit);
    for (const m of value.metrics) {
      if (
        !isRecord(m) ||
        typeof m.kind !== "string" ||
        ![
          "matching-code",
          "decompiled-code",
          "fuzzy-similarity",
          "linked-code",
          "matched-functions",
        ].includes(m.kind) ||
        typeof m.value !== "string" ||
        !(m.numerator === null || typeof m.numerator === "string") ||
        !(m.denominator === null || typeof m.denominator === "string")
      )
        return false;
      metric(m.kind as ProgressMetricKind, m.value, m.numerator, m.denominator);
    }
    return true;
  } catch {
    return false;
  }
}
