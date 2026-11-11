/**
 * Read-only maintenance inventory path for #4129 (checkpoint 2).
 *
 * Canonical records at one pinned repository revision and the maintained Core
 * `port-capabilities` assessment are persisted to the maintenance store, then
 * rendered as static JSON and HTML. Nothing outside the store is mutated, and
 * no support, admission or publication claim is made: unavailable facts are
 * reported as unknown with their reason.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MaintenanceStoreError,
  connectionFromEnvironment,
  defaultDatabaseEnvironment,
  runSql,
} from "./maintenance-store.mts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const defaultSamplePath = path.join(
  repositoryRoot,
  "scripts",
  "maintenance-store",
  "sample-v1.json",
);
export const inventoryFormatVersion = 1;
const portIdPattern = /^[a-z0-9][a-z0-9-]{0,127}$/u;

/** Declared sources the store cannot yet observe, with the exact reason. */
export const unsupportedSources = [
  ["issues", "No maintained export of full issue rows; doctor retains counts only."],
  ["project", "No maintained export of Project item field values."],
  ["upstream-observations", "Observer checkpoints are cache-only and not yet joined."],
  ["release-health", "Monitor history is cache-only and not yet joined."],
  ["hosted-intake", "Receipts exist only as issue comments; no aggregated export."],
  [
    "definition-publication",
    "No maintained comparison of main with the published definition site.",
  ],
] as const;

export interface InventorySample {
  format_version: 1;
  ports: string[];
}

export function readSample(file = defaultSamplePath): InventorySample {
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<InventorySample>;
  if (
    value.format_version !== 1 ||
    !Array.isArray(value.ports) ||
    !value.ports.length ||
    value.ports.length > 200 ||
    !value.ports.every((id) => typeof id === "string" && portIdPattern.test(id)) ||
    new Set(value.ports).size !== value.ports.length
  )
    throw new MaintenanceStoreError("Inventory sample must list 1-200 unique port IDs (format 1)");
  return value as InventorySample;
}

/** Stable JSON: object keys sorted, so equal facts hash equally on every host. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

function git(args: string[]) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new MaintenanceStoreError(
      `git ${args[0]} failed: ${result.stderr?.trim() ?? result.error?.message}`,
    );
  return result.stdout;
}

/** An authored record exactly as committed at the pinned revision; null only when the path is absent. */
function committedRecord(revision: string, id: string): unknown {
  const file = `crates/portcove-core/catalog/ports/${id}.json`;
  if (!git(["ls-tree", "--name-only", revision, "--", file]).trim()) return null;
  return parseJson(git(["show", `${revision}:${file}`]), `authored record ${id}`);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MaintenanceStoreError(`${what} is not valid JSON`);
  }
}

function committedOperationalDefinition(revision: string) {
  const catalog = JSON.parse(
    git(["show", `${revision}:crates/portcove-core/catalog/catalog.json`]),
  ) as {
    ports: { id: string }[];
    source_catalog?: { qualification?: { scope?: { port_id?: string } }[] };
  };
  return {
    ids: new Set(catalog.ports.map((port) => port.id)),
    qualification: catalog.source_catalog?.qualification ?? [],
  };
}

export interface CapabilityObservation {
  ok: boolean;
  report?: unknown;
  error?: { code: string; message: string };
}

/** Core refusals that describe the port itself; any other failure is a collection gap. */
export const subjectScopedRefusals: ReadonlySet<string> = new Set(["not_found"]);

export const isolationScope = "fresh-empty-library-preferences-diagnostics-lock";

/**
 * Run the CLI with its own empty library, preferences, diagnostics and runtime
 * lock (the CLI's maintained isolation overrides), so a collection never
 * touches or rotates the maintainer's real Portcove state.
 */
function isolatedCli(cli: string, args: string[]) {
  // Core refuses paths below a symlink (macOS /var, a linked TMPDIR) and diagnostics
  // would then fall back to the platform directory, so the root is a resolved real path.
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "portcove-inventory-"));
  try {
    const library = path.join(root, "library");
    const home = path.join(root, "home");
    const result = spawnSync(cli, ["--library", library, "--json", ...args], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        PORTCOVE_PREFERENCES: path.join(root, "config", "preferences.json"),
        PORTCOVE_APPLICATION_RUNTIME_LOCK: path.join(root, "config", "runtime.lock"),
        // Defence in depth on Linux and macOS: a platform-directory fallback also stays
        // inside the root. Windows resolves known folders without these variables, so
        // there isolation rests on the two overrides above preparing successfully.
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_STATE_HOME: path.join(home, "state"),
        APPDATA: path.join(home, "roaming"),
        LOCALAPPDATA: path.join(home, "local"),
      },
    });
    if (result.error || result.signal)
      throw new MaintenanceStoreError(`portcove ${args[0]} did not finish`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new MaintenanceStoreError(
        `portcove ${args[0]} output is not valid JSON (exit ${result.status}): ${result.stderr.trim().slice(0, 2000)}`,
      );
    }
    const envelope = parsed as {
      ok?: unknown;
      data?: unknown;
      error?: { code?: unknown; message?: unknown } | null;
    };
    if (typeof envelope.ok !== "boolean" || envelope.ok !== (result.status === 0))
      throw new MaintenanceStoreError(`portcove ${args[0]} returned an inconsistent envelope`);
    return envelope;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The maintained Core assessment, read with fully isolated host state. */
export function coreCapabilities(cli: string, id: string): CapabilityObservation {
  const envelope = isolatedCli(cli, ["port-capabilities", id]);
  return envelope.ok
    ? { ok: true, report: envelope.data }
    : {
        ok: false,
        error: {
          code: typeof envelope.error?.code === "string" ? envelope.error.code : "unknown",
          message: typeof envelope.error?.message === "string" ? envelope.error.message : "",
        },
      };
}

interface Feature {
  feature: string;
  mode: string;
  explanation: string;
  next_step: string;
}
interface Route {
  route: string;
  features: Feature[];
}

/** Project Core's report without reinterpreting it: routes, features, modes and Core's own words. */
export function capabilityResult(observation: CapabilityObservation) {
  if (!observation.ok)
    return {
      state: `unassessed.${observation.error?.code ?? "unknown"}`,
      explanation: { error: observation.error },
    };
  const report = observation.report as {
    format_version: number;
    routes: Route[];
    detail_problems: string[];
  };
  const routes = report.routes.map((route) => ({
    route: route.route,
    features: route.features.map(({ feature, mode, explanation, next_step }) => ({
      feature,
      mode,
      explanation,
      next_step,
    })),
  }));
  const managedSetup =
    routes
      .find((route) => route.route === "managed")
      ?.features.find((feature) => feature.feature === "setup")?.mode ?? "unknown";
  return {
    state: `managed-setup.${managedSetup}`,
    explanation: {
      report_format: report.format_version,
      routes,
      detail_problems: report.detail_problems,
    },
  };
}

function hostPlatform() {
  const arch = process.arch === "x64" ? "x86-64" : process.arch;
  return `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform}-${arch}`;
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const jsonLiteral = (value: unknown) => `${literal(canonicalJson(value))}::jsonb`;

export interface CollectedSubject {
  id: string;
  record: unknown;
  operational: boolean;
  qualification: unknown[];
  capabilities: CapabilityObservation;
}

/** One transaction: two collection runs, their observations, assessments and transitions. */
export function collectionSql(input: {
  revision: string;
  cliSha256: string;
  apiSchema: number;
  runner: string;
  startedAt: string;
  platform: string;
  subjects: CollectedSubject[];
}) {
  const token = randomUUID();
  const catalogRun = `catalog-records:${input.revision.slice(0, 12)}:${token}`;
  const coreRun = `core-port-capabilities:${input.cliSha256.slice(0, 12)}:${token}`;
  const policy = `port-capabilities;api=${input.apiSchema};cli-sha256=${input.cliSha256}`;
  const lines = [
    // Quoting below must never depend on server or role settings.
    "SET LOCAL standard_conforming_strings = on;",
    `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at) VALUES
      (${literal(catalogRun)}, 'catalog-records', ${literal(input.runner)}, ${literal(input.revision)}, ${literal(input.startedAt)}),
      (${literal(coreRun)}, 'core-port-capabilities', ${literal(input.runner)}, ${literal(`cli-sha256:${input.cliSha256}`)}, ${literal(input.startedAt)});`,
  ];
  const gaps: { subject_key: string; code: string; message: string }[] = [];
  for (const subject of input.subjects) {
    const key = `port:${subject.id}`;
    const catalogFact = {
      authored_record: subject.record,
      operational_definition: subject.operational,
      scoped_qualification: subject.qualification,
    };
    const capabilityFact = subject.capabilities;
    const catalogDigest = sha256(canonicalJson(catalogFact));
    const capabilityDigest = sha256(canonicalJson(capabilityFact));
    lines.push(
      `INSERT INTO portcove_maintenance.observations (run_id, subject_key, scope, input_revision, content_sha256, observed_at, payload) VALUES
        (${literal(catalogRun)}, ${literal(key)}, ${jsonLiteral({ source: "catalog-records" })}, ${literal(input.revision)}, ${literal(catalogDigest)}, statement_timestamp(), ${jsonLiteral(catalogFact)});`,
    );
    if (!capabilityFact.ok && !subjectScopedRefusals.has(capabilityFact.error?.code ?? "")) {
      // A host, network or lock failure says nothing about the port: no observation,
      // assessment or transition, and the Core run reports the gap.
      gaps.push({
        subject_key: key,
        code: capabilityFact.error?.code ?? "unknown",
        message: capabilityFact.error?.message ?? "",
      });
      continue;
    }
    lines.push(
      `INSERT INTO portcove_maintenance.observations (run_id, subject_key, scope, input_revision, content_sha256, observed_at, payload) VALUES
        (${literal(coreRun)}, ${literal(key)}, ${jsonLiteral({ source: "core-port-capabilities", host_platform: input.platform, isolation: isolationScope, cli_source_binding: "unverified" })}, ${literal(`cli-sha256:${input.cliSha256}`)}, ${literal(capabilityDigest)}, statement_timestamp(), ${jsonLiteral(capabilityFact)});`,
    );
    const result = capabilityResult(subject.capabilities);
    const explanation = {
      ...result.explanation,
      host_platform: input.platform,
      listing_only: subject.record !== null && !subject.operational,
      catalog_record_present: subject.record !== null,
    };
    const inputDigest = sha256(
      canonicalJson({ catalogDigest, capabilityDigest, platform: input.platform }),
    );
    const resultDigest = sha256(canonicalJson({ state: result.state, explanation }));
    lines.push(
      `INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at, run_id)
        VALUES (${literal(key)}, ${literal(policy)}, ${literal(inputDigest)}, ${literal(result.state)}, ${literal(resultDigest)}, ${jsonLiteral(explanation)}, statement_timestamp(), ${literal(coreRun)})
        ON CONFLICT (subject_key, policy_version, input_digest) DO NOTHING;`,
      `INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id)
        SELECT a.subject_key, coalesce(c.sequence, 0) + 1, a.assessment_id
          FROM portcove_maintenance.assessments a
          LEFT JOIN portcove_maintenance.subject_current c ON c.subject_key = a.subject_key
          WHERE a.subject_key = ${literal(key)} AND a.policy_version = ${literal(policy)} AND a.input_digest = ${literal(inputDigest)}
            AND c.result_digest IS DISTINCT FROM a.result_digest;`,
    );
  }
  const expected = input.subjects.length;
  const coreCoverage = !gaps.length ? "complete" : gaps.length === expected ? "failed" : "partial";
  for (const [run, revision, coverage, runGaps] of [
    [catalogRun, input.revision, "complete", []],
    [coreRun, `cli-sha256:${input.cliSha256}`, coreCoverage, gaps],
  ] as const)
    lines.push(
      `UPDATE portcove_maintenance.collection_runs SET coverage = ${literal(coverage)}, completed_at = clock_timestamp(),
         source_revision = ${literal(revision)}, expected_count = ${expected}, gaps = ${jsonLiteral(runGaps)}
         WHERE run_id = ${literal(run)};`,
    );
  return lines.join("\n");
}

export function collect(options: {
  cli: string;
  sample?: string | undefined;
  environment: NodeJS.ProcessEnv;
  runner?: string | undefined;
}) {
  const sample = readSample(options.sample);
  const revision = git(["rev-parse", "HEAD"]).trim();
  const definitions = committedOperationalDefinition(revision);
  const cliSha256 = sha256(readFileSync(options.cli));
  const envelope = isolatedCli(options.cli, ["capabilities"]);
  const capabilities = envelope.data as
    | { schema_version?: unknown; port_capability_schema?: unknown }
    | undefined;
  if (
    !envelope.ok ||
    capabilities?.port_capability_schema !== 1 ||
    typeof capabilities.schema_version !== "number"
  )
    throw new MaintenanceStoreError(
      "portcove capabilities are unavailable or use an unsupported port capability schema",
    );
  const startedAt = new Date().toISOString();
  const subjects = sample.ports.map((id) => ({
    id,
    record: committedRecord(revision, id),
    operational: definitions.ids.has(id),
    qualification: definitions.qualification.filter((record) => record.scope?.port_id === id),
    capabilities: coreCapabilities(options.cli, id),
  }));
  runSql(
    options.environment,
    collectionSql({
      revision,
      cliSha256,
      apiSchema: capabilities.schema_version,
      runner: options.runner ?? process.env.PORTCOVE_MAINTENANCE_RUNNER?.trim() ?? "generic",
      startedAt,
      platform: hostPlatform(),
      subjects,
    }),
  );
  return {
    revision,
    cli_sha256: cliSha256,
    subjects: subjects.length,
    core_gaps: subjects.filter(
      ({ capabilities: fact }) => !fact.ok && !subjectScopedRefusals.has(fact.error?.code ?? ""),
    ).length,
  };
}

const reportQuery = `SELECT json_build_object(
  'runs', (SELECT coalesce(json_agg(r ORDER BY r.source, r.started_at DESC), '[]') FROM (
      SELECT DISTINCT ON (source) source, run_id, runner, source_revision, started_at, completed_at, coverage,
             expected_count, observed_count, gaps
        FROM portcove_maintenance.collection_runs ORDER BY source, started_at DESC) r),
  'subjects', (SELECT coalesce(json_agg(s ORDER BY s.subject_key), '[]') FROM (
      SELECT c.subject_key, c.sequence, c.updated_at, a.state, a.policy_version, a.input_digest, a.assessed_at, a.explanation,
        (SELECT json_agg(json_build_object('sequence', t.sequence, 'state', t.state, 'recorded_at', t.recorded_at,
                 'returns_to_earlier_result', t.returns_to_earlier_result) ORDER BY t.sequence)
           FROM portcove_maintenance.subject_transitions t WHERE t.subject_key = c.subject_key) AS history,
        (SELECT json_agg(json_build_object('source', o.scope ->> 'source', 'run_id', o.run_id, 'input_revision', o.input_revision,
                 'scope', o.scope, 'observed_at', o.observed_at, 'content_sha256', o.content_sha256) ORDER BY o.scope ->> 'source')
           FROM (SELECT DISTINCT ON (scope ->> 'source') * FROM portcove_maintenance.observations
                   WHERE subject_key = c.subject_key ORDER BY scope ->> 'source', observed_at DESC) o) AS observations
        FROM portcove_maintenance.subject_current c
        JOIN portcove_maintenance.assessments a ON a.assessment_id = c.assessment_id) s)
);`;

export interface InventoryReport {
  format: "portcove-maintenance-inventory";
  format_version: typeof inventoryFormatVersion;
  generated_at: string;
  scope: "declared-sample";
  publication: { status: "unknown"; reason: string };
  unsupported_sources: { source: string; reason: string }[];
  runs: unknown[];
  subjects: unknown[];
  unassessed_gaps?: { subject_key: string; code: string; message: string }[];
}

/** Gaps of the latest Core run, by subject: the current state there is not freshly assessed. */
function latestCoreGaps(runs: unknown[]) {
  const core = (
    runs as { source: string; gaps?: { subject_key: string; code: string; message: string }[] }[]
  ).find(({ source }) => source === "core-port-capabilities");
  return new Map(
    (core?.gaps ?? []).map(({ subject_key, code, message }) => [subject_key, { code, message }]),
  );
}

export function buildReport(environment: NodeJS.ProcessEnv, now = new Date()): InventoryReport {
  const data = JSON.parse(runSql(environment, reportQuery).trim()) as {
    runs: unknown[];
    subjects: unknown[];
  };
  const gaps = latestCoreGaps(data.runs);
  const latestCoreRun = (data.runs as { source: string; run_id: string }[]).find(
    ({ source }) => source === "core-port-capabilities",
  )?.run_id;
  const subjects = data.subjects as {
    subject_key: string;
    observations?: { source: string; run_id: string }[] | null;
  }[];
  return {
    format: "portcove-maintenance-inventory",
    format_version: inventoryFormatVersion,
    generated_at: now.toISOString(),
    scope: "declared-sample",
    publication: {
      status: "unknown",
      reason: unsupportedSources.find(([source]) => source === "definition-publication")![1],
    },
    unsupported_sources: unsupportedSources.map(([source, reason]) => ({ source, reason })),
    runs: data.runs,
    subjects: subjects.map((subject) => {
      const gap = gaps.get(subject.subject_key);
      const assessedNow = subject.observations?.some(
        (observation) =>
          observation.source === "core-port-capabilities" && observation.run_id === latestCoreRun,
      );
      return {
        ...subject,
        latest_core_gap: gap ?? null,
        latest_core_run: gap ? "gap" : assessedNow ? "assessed" : "not-included",
      };
    }),
    unassessed_gaps: [...gaps]
      .filter(([key]) => !subjects.some((subject) => subject.subject_key === key))
      .map(([subject_key, gap]) => ({ subject_key, ...gap })),
  };
}

const escapeHtml = (value: unknown) =>
  String(value).replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);

/** A self-contained, searchable page; data is embedded as escaped JSON, never as markup. */
export function renderHtml(report: InventoryReport) {
  const embedded = JSON.stringify(report).replace(/</gu, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portcove maintenance inventory</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0 auto; max-width: 72rem; padding: 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #8884; padding: .4rem; text-align: left; vertical-align: top; }
.unknown { color: #b26b00; }
input { width: 100%; padding: .5rem; font: inherit; }
</style>
</head>
<body>
<h1>Portcove maintenance inventory</h1>
<p>Generated ${escapeHtml(report.generated_at)}. Scope: ${escapeHtml(report.scope)} (not the complete inventory).
Published delivery: <span class="unknown">${escapeHtml(report.publication.status)}</span> — ${escapeHtml(report.publication.reason)}</p>
<p>Core assessments come from a fully isolated CLI run on the collecting host; the CLI binary is bound by digest and its build source is <span class="unknown">unverified</span>.</p>
<h2>Sources</h2>
<table><thead><tr><th>Source</th><th>Coverage</th><th>Revision</th><th>Observed</th><th>Completed</th><th>Gaps</th></tr></thead><tbody>
${(report.runs as Record<string, unknown>[])
  .map(
    (run) =>
      `<tr><td>${escapeHtml(run.source)}</td><td>${escapeHtml(run.coverage)}</td><td><code>${escapeHtml(run.source_revision)}</code></td><td>${escapeHtml(run.observed_count)} of ${escapeHtml(run.expected_count ?? "unknown")} declared</td><td>${escapeHtml(run.completed_at)}</td><td>${(Array.isArray(run.gaps) ? (run.gaps as { subject_key: string; code: string }[]) : []).map((gap) => `${escapeHtml(gap.subject_key)}: ${escapeHtml(gap.code)}`).join("<br>")}</td></tr>`,
  )
  .join("\n")}
${report.unsupported_sources
  .map(
    (source) =>
      `<tr><td>${escapeHtml(source.source)}</td><td class="unknown">unknown</td><td colspan="4">${escapeHtml(source.reason)}</td></tr>`,
  )
  .join("\n")}
</tbody></table>
<h2>Subjects</h2>
<label for="search">Search</label>
<input id="search" type="search" placeholder="Port ID or state">
<table><thead><tr><th>Subject</th><th>Core assessment</th><th>Changes</th><th>Assessed</th><th>Latest Core run</th></tr></thead><tbody id="subjects"></tbody></table>
<script id="inventory" type="application/json">${embedded}</script>
<script>
const report = JSON.parse(document.getElementById("inventory").textContent);
const body = document.getElementById("subjects");
function render(filter) {
  body.replaceChildren();
  for (const subject of [...report.subjects, ...(report.unassessed_gaps ?? []).map((gap) => ({ subject_key: gap.subject_key, state: "unknown", sequence: 0, assessed_at: "never", latest_core_gap: gap }))]) {
    const text = (subject.subject_key + " " + subject.state).toLowerCase();
    if (filter && !text.includes(filter)) continue;
    const row = body.insertRow();
    const gap = subject.latest_core_gap
      ? "not assessed: " + subject.latest_core_gap.code
      : subject.latest_core_run === "assessed" ? "assessed" : "not in latest run";
    for (const value of [subject.subject_key, subject.state, String(subject.sequence), subject.assessed_at, gap])
      row.insertCell().textContent = value;
  }
}
document.getElementById("search").addEventListener("input", (event) => render(event.target.value.trim().toLowerCase()));
render("");
</script>
</body>
</html>
`;
}

/** Writes inventory.json and index.html atomically into a new directory. */
export function writeReport(report: InventoryReport, output: string) {
  if (existsSync(output))
    throw new MaintenanceStoreError(`Report destination already exists: ${output}`);
  mkdirSync(path.dirname(output), { recursive: true });
  const staging = mkdtempSync(`${output}.partial-`);
  try {
    writeFileSync(path.join(staging, "inventory.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.join(staging, "index.html"), renderHtml(report));
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new MaintenanceStoreError(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

const usage = `usage: node scripts/maintenance-inventory.mts <command> [options]

commands:
  collect --cli PATH [--sample FILE]   read the declared sample at the checkout's HEAD and the
                                       Core port-capabilities assessment into the store
  report --output DIR                  write inventory.json and index.html to a new DIR

options:
  --database-env NAME   environment variable holding the database URL (default ${defaultDatabaseEnvironment})

PORTCOVE_MAINTENANCE_RUNNER optionally names the runner recorded with each collection run.`;

export function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return command ? 0 : 2;
  }
  const environment = connectionFromEnvironment(
    option(args, "--database-env") ?? defaultDatabaseEnvironment,
  );
  const cli = option(args, "--cli");
  const sample = option(args, "--sample");
  const output = option(args, "--output");
  if (args.length)
    throw new MaintenanceStoreError(`Unexpected arguments: ${args.join(" ")}\n${usage}`);
  if (command === "collect") {
    if (!cli) throw new MaintenanceStoreError("collect requires --cli PATH");
    console.log(JSON.stringify(collect({ cli: path.resolve(cli), sample, environment }), null, 2));
  } else if (command === "report") {
    if (!output) throw new MaintenanceStoreError("report requires --output DIR");
    const report = buildReport(environment);
    writeReport(report, path.resolve(output));
    console.log(
      JSON.stringify({ output: path.resolve(output), subjects: report.subjects.length }, null, 2),
    );
  } else throw new MaintenanceStoreError(`Unknown command: ${command}\n${usage}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof MaintenanceStoreError ? error.message : error);
    process.exitCode = 1;
  }
}
