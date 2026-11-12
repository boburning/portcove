/**
 * Read-only maintenance inventory path for #4129 (checkpoint 2).
 *
 * Canonical records at one pinned repository revision and the maintained Core
 * `port-capabilities` assessment are persisted to the maintenance store, then
 * rendered as static JSON and HTML. Nothing outside the store is mutated, and
 * no support, admission or publication claim is made: unavailable facts are
 * reported as unknown with their reason.
 */
import { execFile, spawnSync } from "node:child_process";
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
import { portCatalogMarkers, portKeyMarkers } from "./roadmap-issue.mts";
import {
  attentionConditions,
  readReleaseHealth,
  releaseHealthFacts,
  type ReleaseHealthInput,
} from "./maintenance-release-health.mts";
import {
  readUpstreamObservations,
  upstreamAttention,
  upstreamObservation,
  upstreamSummary,
  type UpstreamInput,
  type UpstreamObservation,
} from "./maintenance-upstream.mts";
import {
  hostedIntakeAttention,
  hostedIntakeObservation,
  hostedIntakeSummary,
  readHostedIntake,
  type HostedIntakeObservation,
} from "./maintenance-hosted-intake.mts";
import type { HostedStatusAll } from "./hosted-discovery-intake.mts";
import {
  disabledCapabilities,
  handoffCollectionSql,
  handoffEntry,
  handoffGuidance,
  handoffRegistry,
  hostedIntakeHandoffs,
  nextAction,
  openHandoffs,
  openHandoffsSql,
  parseHandoffSubject,
  readOpenHandoffs,
  recordHandoffOperations,
  releaseHealthHandoffs,
  renderHandoffs,
  upstreamHandoffs,
  withoutHandoff,
  type HandoffCondition,
  type HandoffSource,
  type OpenHandoff,
} from "./maintenance-handoffs.mts";

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
  [
    "hosted-intake",
    "Not collected; collect --all --hosted-intake reads #177 through the executor's read-only status.",
  ],
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
  // JSON.stringify semantics: undefined object members are omitted, undefined items become null.
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
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

/** A file's exact bytes at a commit; fails when the commit or path is unavailable locally. */
function committedBytes(revision: string, file: string) {
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new MaintenanceStoreError("Invalid commit identity");
  const result = spawnSync("git", ["show", `${revision}:${file}`], {
    cwd: repositoryRoot,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new MaintenanceStoreError(
      `${file} at ${revision} is unavailable in this checkout: ${String(
        result.stderr ?? result.error?.message ?? "",
      )
        .trim()
        .slice(0, 500)}`,
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
async function isolatedCli(cli: string, args: string[]) {
  // Core refuses paths below a symlink (macOS /var, a linked TMPDIR) and diagnostics
  // would then fall back to the platform directory, so the root is a resolved real path.
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "portcove-inventory-"));
  try {
    const library = path.join(root, "library");
    const home = path.join(root, "home");
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        execFile(
          cli,
          ["--library", library, "--json", ...args],
          {
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
          },
          (error, stdout, stderr) => {
            if (error && (error.killed || error.signal || typeof error.code !== "number"))
              reject(new MaintenanceStoreError(`portcove ${args[0]} did not finish`));
            else resolve({ status: error ? (error.code as number) : 0, stdout, stderr });
          },
        );
      },
    );
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
export async function coreCapabilities(cli: string, id: string): Promise<CapabilityObservation> {
  const envelope = await isolatedCli(cli, ["port-capabilities", id]);
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

export function hostPlatform() {
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

/** The fields of the maintained issue inventory this source reads. */
export interface IssueInventory {
  repository: string;
  observed_at: string;
  total: number;
  issues: readonly {
    id: string;
    number: number;
    title: string;
    state: string;
    body?: string;
    blockedBy?: { nodes: readonly { number: number; state: string }[] };
  }[];
  memberships: readonly {
    project_id: string;
    issue_id: string;
    isArchived: boolean;
    fieldValues: unknown;
  }[];
}

/** Single-select Project field values by field name, as GitHub reports them. */
function projectFields(fieldValues: unknown) {
  const values = fieldValues as { nodes?: unknown[]; pageInfo?: { hasNextPage?: unknown } } | null;
  if (values?.pageInfo?.hasNextPage !== false && values?.pageInfo !== undefined)
    throw new MaintenanceStoreError(
      "Project field values are truncated; the issue inventory is incomplete",
    );
  const nodes = values?.nodes ?? [];
  const fields: Record<string, string> = {};
  for (const node of nodes) {
    const value = node as { name?: unknown; field?: { name?: unknown } };
    if (typeof value.name === "string" && typeof value.field?.name === "string")
      fields[value.field.name] = value.name;
  }
  return fields;
}

/** Issue facts without bodies: state, Project placement, blockers and canonical port markers. */
export function issueFacts(inventory: IssueInventory) {
  if (inventory.total !== inventory.issues.length)
    throw new MaintenanceStoreError("Issue inventory is incomplete");
  const memberships = new Map<string, IssueInventory["memberships"][number][]>();
  for (const membership of inventory.memberships)
    memberships.set(membership.issue_id, [
      ...(memberships.get(membership.issue_id) ?? []),
      membership,
    ]);
  return new Map(
    inventory.issues.map((issue) => [
      `issue:${issue.number}`,
      {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        catalog_ids: [...new Set(portCatalogMarkers(issue.body))].sort(),
        port_keys: [...new Set(portKeyMarkers(issue.body))].sort(),
        blocked_by: (issue.blockedBy?.nodes ?? [])
          .map(({ number, state }) => ({ number, state }))
          .sort((left, right) => left.number - right.number),
        project: (memberships.get(issue.id) ?? [])
          .map(({ project_id, isArchived, fieldValues }) => ({
            project_id,
            archived: isArchived,
            fields: projectFields(fieldValues),
          }))
          .sort((left, right) => (left.project_id < right.project_id ? -1 : 1)),
      },
    ]),
  );
}

/** The maintained, completeness-verified issue and Project inventory, read-only. */
export async function readIssueInventory(): Promise<IssueInventory> {
  const { RoadmapClient, validateConfig } = await import("./roadmap.mts");
  const { createRoadmapRequestScope } = await import("./roadmap-capacity-continuation.mts");
  const config = validateConfig(
    JSON.parse(readFileSync(path.join(repositoryRoot, ".github", "roadmap.json"), "utf8")),
  );
  const client = await RoadmapClient.connect(
    config,
    createRoadmapRequestScope({
      allowMutations: false,
      ghCommand: process.env.PORTCOVE_ROADMAP_GH,
    }),
  );
  const inventory = await client.repositoryIssues({ projectMemberships: true });
  return {
    repository: inventory.repository,
    observed_at: inventory.observed_at,
    total: inventory.evidence.total ?? -1,
    issues: inventory.issues,
    memberships: inventory.project_memberships ?? [],
  };
}

/** The appointed official metadata location (docs/DEFINITION-DELIVERY.md). */
export const officialMetadataLocation = "https://boburning.github.io/portcove/catalog/metadata/";

export interface PublicationObservation {
  /** Core's inspection of the publication bundle exported from the pinned revision. */
  inspection: { index_sha256?: unknown; definitions?: unknown };
  /** HTTP status of the appointed timestamp metadata, or null when unreachable. */
  published_status: number | null;
}

const definitionIdentity = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * Main versus published facts per definition identity. One site probe says
 * nothing about an individual definition: an absent site (HTTP 404) means no
 * definition is published, and a present site leaves each definition unknown
 * until its published index is read and verified. Any other probe result is a
 * collection gap, never a fact.
 */
export function publicationFacts(observation: PublicationObservation) {
  const definitions = observation.inspection.definitions;
  if (!Array.isArray(definitions) || typeof observation.inspection.index_sha256 !== "string")
    throw new MaintenanceStoreError("Unsupported definition publication inspection");
  const site =
    observation.published_status === 404
      ? "absent"
      : observation.published_status === 200
        ? "metadata-present-unverified"
        : null;
  if (site === null)
    return {
      facts: new Map<string, unknown>(),
      gaps: [
        {
          subject_key: "site:official-metadata",
          code:
            observation.published_status === null
              ? "unreachable"
              : `http-${observation.published_status}`,
          message:
            "The appointed metadata location could not be classified; the last known facts stay current.",
        },
      ],
      expected: definitions.length,
    };
  const facts = new Map<string, unknown>();
  for (const definition of definitions as Record<string, unknown>[]) {
    const namespace = definition.namespace;
    const id = definition.stable_id;
    if (
      typeof namespace !== "string" ||
      typeof id !== "string" ||
      !definitionIdentity.test(namespace) ||
      !definitionIdentity.test(id)
    )
      throw new MaintenanceStoreError(
        "Unsupported definition identity in the publication inspection",
      );
    facts.set(`definition:${namespace}/${id}`, {
      main: {
        index_sha256: observation.inspection.index_sha256,
        revision: definition.revision ?? null,
        definition_target: definition.definition_target ?? null,
        policy_target: definition.policy_target ?? null,
        policy_revision: definition.policy_revision ?? null,
        launch_revision: definition.launch_revision ?? null,
      },
      site: { status: site, timestamp_http_status: observation.published_status },
      published: site === "absent" ? "not-published" : "unknown",
    });
  }
  return { facts, gaps: [], expected: definitions.length };
}

/** Inspect the bundle exactly as committed at the revision, and probe the appointed location. */
export async function readPublication(
  cli: string,
  revision: string,
): Promise<PublicationObservation> {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "portcove-publication-"));
  try {
    const bundle = "release/catalog-publication/bundle";
    const archive = spawnSync("git", ["archive", "--format=tar", revision, bundle], {
      cwd: repositoryRoot,
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (archive.status !== 0)
      throw new MaintenanceStoreError(
        `The publication bundle could not be exported from ${revision}: ${String(
          archive.stderr ?? archive.error?.message ?? "",
        )
          .trim()
          .slice(0, 2000)}`,
      );
    const extract = spawnSync("tar", ["-x", "-C", root], {
      input: archive.stdout,
      timeout: 60_000,
    });
    if (extract.status !== 0)
      throw new MaintenanceStoreError("The committed publication bundle could not be exported");
    const envelope = await isolatedCli(cli, [
      "catalog",
      "inspect-definition-publication",
      path.join(root, bundle),
    ]);
    if (!envelope.ok)
      throw new MaintenanceStoreError("Core could not inspect the publication bundle");
    let status: number | null = null;
    try {
      // Node's fetch does not use HTTPS_PROXY; on proxy-only runners this probe is a gap.
      const response = await fetch(`${officialMetadataLocation}timestamp.json`, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      status = response.status;
    } catch {
      status = null;
    }
    return {
      inspection: envelope.data as PublicationObservation["inspection"],
      published_status: status,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const absentPayload = { absent: true };
type Fact = { digest: string; scope: unknown; revision: string; payload: unknown };

/** sha256 over sorted `subject \t digest` lines; the database recomputes the same value. */
export function membershipDigest(members: ReadonlyMap<string, string>) {
  return sha256(
    [...members]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, digest]) => `${key}\t${digest}`)
      .join("\n"),
  );
}

/** Latest present content digest per subject from finished runs of one source. */
function latestMembers(environment: NodeJS.ProcessEnv, source: string, startedAt: string) {
  const rows = parseJson(
    runSql(
      environment,
      `SELECT coalesce(json_agg(json_build_object('subject', subject_key, 'digest', content_sha256, 'absent', absent)), '[]')
         FROM (SELECT DISTINCT ON (o.subject_key) o.subject_key, o.content_sha256,
                      o.payload = portcove_maintenance.absent_payload() AS absent
                 FROM portcove_maintenance.observations o
                 JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
                WHERE r.source = ${literal(source)} AND r.coverage <> 'in_progress'
                  AND r.started_at <= ${literal(startedAt)}::timestamptz
                ORDER BY o.subject_key, r.started_at DESC, o.observation_id DESC) latest;`,
    ).trim(),
    "latest maintenance members",
  ) as { subject: string; digest: string; absent: boolean }[];
  return new Map(
    rows.filter(({ absent }) => !absent).map(({ subject, digest }) => [subject, digest]),
  );
}

/**
 * One transaction: the catalog and Core runs, their observations, assessments and
 * transitions. In `all` mode a source stores only changed subjects plus absences
 * from a complete run, and declares its membership for the database to verify.
 */
export function collectionSql(input: {
  mode: "sample" | "all";
  revision: string;
  cliSha256: string;
  apiSchema: number;
  runner: string;
  startedAt: string;
  platform: string;
  subjects: CollectedSubject[];
  latest?: {
    catalog: ReadonlyMap<string, string>;
    core: ReadonlyMap<string, string>;
    issues?: ReadonlyMap<string, string>;
    releaseHealth?: ReadonlyMap<string, string>;
    upstream?: ReadonlyMap<string, string>;
    hostedIntake?: ReadonlyMap<string, string>;
    publication?: ReadonlyMap<string, string>;
  };
  publication?: {
    revision: string;
    facts: ReadonlyMap<string, unknown>;
    gaps: { subject_key: string; code: string; message: string }[];
    expected: number;
  };
  releaseHealth?: {
    revision: string;
    expected: number;
    facts: ReadonlyMap<string, unknown>;
    gaps: { subject_key: string; code: string; message: string }[];
  };
  upstream?: UpstreamObservation;
  hostedIntake?: HostedIntakeObservation;
  issues?: { repository: string; observedAt: string; facts: ReadonlyMap<string, unknown> };
}) {
  const token = randomUUID();
  const coreSource = coreSourceName(input.platform);
  const catalogRun = `catalog-records:${input.revision.slice(0, 12)}:${token}`;
  const coreRun = `${coreSource}:${input.cliSha256.slice(0, 12)}:${token}`;
  const coreRevision = `cli-sha256:${input.cliSha256}`;
  const policy = `port-capabilities;api=${input.apiSchema};cli-sha256=${input.cliSha256}`;
  const lines = [
    // Quoting below must never depend on server or role settings.
    "SET LOCAL standard_conforming_strings = on;",
    // Collectors of the same source are serialized; locks are taken in one order.
    `SELECT pg_advisory_xact_lock(hashtext('portcove-maintenance-source:' || source))
       FROM unnest(ARRAY[${[
         ...new Set([
           "catalog-records",
           coreSource,
           ...(input.issues ? ["issues-project"] : []),
           ...(input.releaseHealth ? ["release-health"] : []),
           ...(input.upstream ? ["upstream-observations"] : []),
           ...(input.hostedIntake ? ["hosted-intake"] : []),
           ...(input.publication ? ["definition-publication"] : []),
         ]),
       ]
         .sort()
         .map(literal)
         .join(", ")}]) AS source ORDER BY source;`,
    `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at) VALUES
      (${literal(catalogRun)}, 'catalog-records', ${literal(input.runner)}, ${literal(input.revision)}, ${literal(input.startedAt)}),
      (${literal(coreRun)}, ${literal(coreSource)}, ${literal(input.runner)}, ${literal(coreRevision)}, ${literal(input.startedAt)});`,
  ];
  const observe = (run: string, key: string, fact: Fact) =>
    lines.push(
      `INSERT INTO portcove_maintenance.observations (run_id, subject_key, scope, input_revision, content_sha256, observed_at, payload) VALUES
        (${literal(run)}, ${literal(key)}, ${jsonLiteral(fact.scope)}, ${literal(fact.revision)}, ${literal(fact.digest)}, statement_timestamp(), ${jsonLiteral(fact.payload)});`,
    );
  const catalogFacts = new Map<string, Fact>();
  const coreFacts = new Map<string, Fact>();
  const gaps: { subject_key: string; code: string; message: string }[] = [];
  for (const subject of input.subjects) {
    const key = `port:${subject.id}`;
    const catalogFact = {
      authored_record: subject.record,
      operational_definition: subject.operational,
      scoped_qualification: subject.qualification,
    };
    const catalogDigest = sha256(canonicalJson(catalogFact));
    catalogFacts.set(key, {
      digest: catalogDigest,
      scope: { source: "catalog-records" },
      revision: input.revision,
      payload: catalogFact,
    });
    const capabilityFact = subject.capabilities;
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
    const capabilityDigest = sha256(canonicalJson(capabilityFact));
    coreFacts.set(key, {
      digest: capabilityDigest,
      scope: {
        source: coreSource,
        host_platform: input.platform,
        isolation: isolationScope,
        cli_source_binding: "unverified",
      },
      revision: coreRevision,
      payload: capabilityFact,
    });
    // Core results are per host platform, so is the assessment history.
    const assessed = assessmentSubject(subject.id, input.platform);
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
        VALUES (${literal(assessed)}, ${literal(policy)}, ${literal(inputDigest)}, ${literal(result.state)}, ${literal(resultDigest)}, ${jsonLiteral(explanation)}, statement_timestamp(), ${literal(coreRun)})
        ON CONFLICT (subject_key, policy_version, input_digest) DO NOTHING;`,
      `INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id)
        SELECT a.subject_key, coalesce(c.sequence, 0) + 1, a.assessment_id
          FROM portcove_maintenance.assessments a
          LEFT JOIN portcove_maintenance.subject_current c ON c.subject_key = a.subject_key
          WHERE a.subject_key = ${literal(assessed)} AND a.policy_version = ${literal(policy)} AND a.input_digest = ${literal(inputDigest)}
            AND c.result_digest IS DISTINCT FROM a.result_digest;`,
      // Changes-only: a transition after the subject's baseline is a pending notification.
      `INSERT INTO portcove_maintenance.notifications (notification_key, subject_key, transition_sequence, created_at)
        SELECT 'transition:' || replace(t.subject_key, '@', '.') || ':' || t.sequence, t.subject_key, t.sequence, statement_timestamp()
          FROM portcove_maintenance.subject_transitions t
          JOIN portcove_maintenance.subject_current c ON c.subject_key = t.subject_key AND c.sequence = t.sequence
          WHERE t.subject_key = ${literal(assessed)} AND t.sequence > 1
        ON CONFLICT (notification_key) DO NOTHING;`,
    );
  }
  const issueFactsByKey = new Map<string, Fact>();
  const issueRun = `issues-project:${token}`;
  let issueRevision = "";
  if (input.issues) {
    if (input.mode !== "all") throw new MaintenanceStoreError("Issue collection requires --all");
    issueRevision = `issues-sha256:${sha256(canonicalJson([...input.issues.facts]))}`;
    lines.push(
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at) VALUES
        (${literal(issueRun)}, 'issues-project', ${literal(input.runner)}, ${literal(issueRevision)}, ${literal(input.startedAt)});`,
    );
    for (const [key, payload] of input.issues.facts)
      issueFactsByKey.set(key, {
        digest: sha256(canonicalJson(payload)),
        scope: {
          source: "issues-project",
          repository: input.issues.repository,
          observed_at: input.issues.observedAt,
        },
        revision: issueRevision,
        payload,
      });
  }
  const healthFacts = new Map<string, Fact>();
  const healthRun = `release-health:${token}`;
  if (input.releaseHealth) {
    if (input.mode !== "all")
      throw new MaintenanceStoreError("Release-health collection requires --all");
    lines.push(
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at) VALUES
        (${literal(healthRun)}, 'release-health', ${literal(input.runner)}, ${literal(input.releaseHealth.revision)}, ${literal(input.startedAt)});`,
    );
    for (const [key, payload] of input.releaseHealth.facts)
      healthFacts.set(key, {
        digest: sha256(canonicalJson(payload)),
        scope: { source: "release-health" },
        revision: input.releaseHealth.revision,
        payload,
      });
  }
  const upstreamFactsByKey = new Map<string, Fact>();
  const upstreamRun = `upstream-observations:${token}`;
  if (input.upstream) {
    if (input.mode !== "all")
      throw new MaintenanceStoreError("Upstream-observation collection requires --all");
    lines.push(
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at) VALUES
        (${literal(upstreamRun)}, 'upstream-observations', ${literal(input.runner)}, ${literal(input.upstream.revision)}, ${literal(input.startedAt)});`,
    );
    for (const [key, payload] of input.upstream.facts)
      upstreamFactsByKey.set(key, {
        digest: sha256(canonicalJson(payload)),
        scope: { source: "upstream-observations", config_sha256: input.upstream.config_sha256 },
        revision: input.upstream.revision,
        payload,
      });
  }
  const hostedFacts = new Map<string, Fact>();
  const hostedRun = `hosted-intake:${token}`;
  if (input.hostedIntake) {
    if (input.mode !== "all")
      throw new MaintenanceStoreError("Hosted-intake collection requires --all");
    lines.push(
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at) VALUES
        (${literal(hostedRun)}, 'hosted-intake', ${literal(input.runner)}, ${literal(input.hostedIntake.revision)}, ${literal(input.startedAt)});`,
    );
    for (const [key, payload] of input.hostedIntake.facts)
      hostedFacts.set(key, {
        digest: sha256(canonicalJson(payload)),
        scope: { source: "hosted-intake", issue: 177 },
        revision: input.hostedIntake.revision,
        payload,
      });
  }
  const expected = input.subjects.length;
  const coreCoverage = !gaps.length ? "complete" : gaps.length === expected ? "failed" : "partial";
  const runs: [
    string,
    string,
    string,
    unknown[],
    Map<string, Fact>,
    ReadonlyMap<string, string> | undefined,
    number | null,
  ][] = [
    [catalogRun, input.revision, "complete", [], catalogFacts, input.latest?.catalog, expected],
    [coreRun, coreRevision, coreCoverage, gaps, coreFacts, input.latest?.core, expected],
  ];
  if (input.issues)
    runs.push([
      issueRun,
      issueRevision,
      "complete",
      [],
      issueFactsByKey,
      input.latest?.issues,
      issueFactsByKey.size,
    ]);
  if (input.releaseHealth)
    runs.push([
      healthRun,
      input.releaseHealth.revision,
      input.releaseHealth.gaps.length ? "partial" : "complete",
      input.releaseHealth.gaps,
      healthFacts,
      input.latest?.releaseHealth,
      input.releaseHealth.expected,
    ]);
  if (input.upstream)
    runs.push([
      upstreamRun,
      input.upstream.revision,
      input.upstream.failed ? "failed" : input.upstream.gaps.length ? "partial" : "complete",
      input.upstream.gaps,
      upstreamFactsByKey,
      input.latest?.upstream,
      input.upstream.expected,
    ]);
  if (input.hostedIntake)
    runs.push([
      hostedRun,
      input.hostedIntake.revision,
      input.hostedIntake.failed
        ? "failed"
        : input.hostedIntake.gaps.length
          ? "partial"
          : "complete",
      input.hostedIntake.gaps,
      hostedFacts,
      input.latest?.hostedIntake,
      input.hostedIntake.expected,
    ]);
  const publicationRun = `definition-publication:${token}`;
  if (input.publication) {
    const publicationFactsByKey = new Map<string, Fact>();
    lines.push(
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at) VALUES
        (${literal(publicationRun)}, 'definition-publication', ${literal(input.runner)}, ${literal(input.publication.revision)}, ${literal(input.startedAt)});`,
    );
    for (const [key, payload] of input.publication.facts)
      publicationFactsByKey.set(key, {
        digest: sha256(canonicalJson(payload)),
        scope: { source: "definition-publication", location: officialMetadataLocation },
        revision: input.publication.revision,
        payload,
      });
    runs.push([
      publicationRun,
      input.publication.revision,
      input.publication.gaps.length ? "failed" : "complete",
      input.publication.gaps,
      publicationFactsByKey,
      input.latest?.publication,
      input.publication.expected,
    ]);
  }
  const sourceOf = new Map([
    [publicationRun, "definition-publication"],
    [catalogRun, "catalog-records"],
    [coreRun, coreSource],
    [issueRun, "issues-project"],
    [healthRun, "release-health"],
    [upstreamRun, "upstream-observations"],
    [hostedRun, "hosted-intake"],
  ]);
  for (const [run, revision, coverage, runGaps, facts, latest, runExpected] of runs) {
    let membership = "";
    if (input.mode === "all") {
      const members = new Map([...facts].map(([key, fact]) => [key, fact.digest]));
      for (const [key, fact] of facts)
        if (latest?.get(key) !== fact.digest) observe(run, key, fact);
      // Only a complete run may say that a previously present subject is gone.
      if (coverage === "complete")
        for (const key of latest?.keys() ?? [])
          if (!facts.has(key))
            observe(run, key, {
              digest: sha256(canonicalJson(absentPayload)),
              scope: { source: sourceOf.get(run) },
              revision,
              payload: absentPayload,
            });
      membership = `, member_count = ${members.size}, member_digest = ${literal(membershipDigest(members))}`;
    } else for (const [key, fact] of facts) observe(run, key, fact);
    lines.push(
      `UPDATE portcove_maintenance.collection_runs SET coverage = ${literal(coverage)}, completed_at = clock_timestamp(),
         source_revision = ${literal(revision)}, expected_count = ${runExpected ?? "NULL"}, gaps = ${jsonLiteral(runGaps)}${membership}
         WHERE run_id = ${literal(run)};`,
    );
  }
  // Handoffs follow only a complete run of their source over the complete universe:
  // a partial or failed run neither records nor clears attention. Core has no handoff.
  if (input.mode === "all") {
    const complete = new Map<HandoffSource, { run: string; conditions: HandoffCondition[] }>();
    if (input.releaseHealth && !input.releaseHealth.gaps.length)
      complete.set("release-health", {
        run: healthRun,
        conditions: releaseHealthHandoffs(input.releaseHealth.facts),
      });
    if (input.upstream && !input.upstream.failed && !input.upstream.gaps.length)
      complete.set("upstream-observations", {
        run: upstreamRun,
        conditions: upstreamHandoffs(input.upstream.facts),
      });
    if (input.hostedIntake && !input.hostedIntake.failed && !input.hostedIntake.gaps.length)
      complete.set("hosted-intake", {
        run: hostedRun,
        conditions: hostedIntakeHandoffs(input.hostedIntake.facts),
      });
    for (const entry of handoffRegistry) {
      const source = complete.get(entry.source);
      if (source)
        lines.push(
          ...handoffCollectionSql({
            kind: entry.kind,
            run: source.run,
            conditions: source.conditions.filter(({ kind }) => kind === entry.kind),
          }),
        );
    }
    // A kind no longer in the registry clears on any complete handoff source run.
    const first = [...complete.values()][0];
    if (first) lines.push(...handoffCollectionSql({ retired: true, run: first.run }));
  }
  return lines.join("\n");
}

export const coreSourceName = (platform: string) => `${corePrefix}${platform}`;

/** The assessed subject: one port on one host platform. */
export const assessmentSubject = (id: string, platform: string) => `port:${id}@${platform}`;

/** Every authored port ID committed at the revision. */
function committedPortIds(revision: string) {
  return git(["ls-tree", "--name-only", revision, "--", "crates/portcove-core/catalog/ports/"])
    .split("\n")
    .map((line) => path.posix.basename(line.trim()))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => portIdPattern.test(id))
    .sort();
}

async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  action: (item: T) => Promise<R>,
) {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !failed) {
        const index = next++;
        try {
          results[index] = await action(items[index]!);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}

export async function collect(options: {
  cli: string;
  sample?: string | undefined;
  all?: boolean | undefined;
  /** With `all`, the authored universe; defaults to every record committed at HEAD. */
  ports?: readonly string[] | undefined;
  concurrency?: number | undefined;
  /** With `all`, also collect the verified issue and Project inventory. */
  issues?: (() => Promise<IssueInventory>) | undefined;
  /** With `all`, also compare committed definitions with the appointed published location. */
  publication?:
    | boolean
    | ((cli: string, revision: string) => Promise<PublicationObservation>)
    | undefined;
  /** With `all`, also collect the latest scheduled release-health report. */
  releaseHealth?: (() => Promise<ReleaseHealthInput>) | undefined;
  /** With `all`, also collect the newest retained upstream observer checkpoint. */
  upstream?: (() => Promise<UpstreamInput>) | undefined;
  /** With `all`, also collect every #177 hosted-intake request through the executor's status. */
  hostedIntake?: (() => Promise<HostedStatusAll>) | undefined;
  /** Host platform label; defaults to this host. Fixtures use it to model other hosts. */
  platform?: string | undefined;
  environment: NodeJS.ProcessEnv;
  runner?: string | undefined;
}) {
  const revision = git(["rev-parse", "HEAD"]).trim();
  const ids = options.all
    ? (options.ports ?? committedPortIds(revision))
    : readSample(options.sample).ports;
  const definitions = committedOperationalDefinition(revision);
  const cliSha256 = sha256(readFileSync(options.cli));
  const envelope = await isolatedCli(options.cli, ["capabilities"]);
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
  const platform = options.platform ?? hostPlatform();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(platform))
    throw new MaintenanceStoreError("Invalid platform label");
  const subjects = await mapBounded(ids, options.concurrency ?? 4, async (id) => ({
    id,
    record: committedRecord(revision, id),
    operational: definitions.ids.has(id),
    qualification: definitions.qualification.filter((record) => record.scope?.port_id === id),
    capabilities: await coreCapabilities(options.cli, id),
  }));
  const mode = options.all ? "all" : "sample";
  if (options.issues && !options.all)
    throw new MaintenanceStoreError("Issue collection requires --all");
  const issueInventory = options.issues ? await options.issues() : undefined;
  if (options.releaseHealth && !options.all)
    throw new MaintenanceStoreError("Release-health collection requires --all");
  const health = options.releaseHealth ? await options.releaseHealth() : undefined;
  const healthFacts = health ? releaseHealthFacts(health.report) : undefined;
  if (options.upstream && !options.all)
    throw new MaintenanceStoreError("Upstream-observation collection requires --all");
  const upstream = options.upstream ? await upstreamObservation(options.upstream) : undefined;
  if (options.hostedIntake && !options.all)
    throw new MaintenanceStoreError("Hosted-intake collection requires --all");
  const hostedIntake = options.hostedIntake
    ? await hostedIntakeObservation(options.hostedIntake)
    : undefined;
  if (options.publication && !options.all)
    throw new MaintenanceStoreError("Publication collection requires --all");
  const publicationObserved = options.publication
    ? await (typeof options.publication === "function" ? options.publication : readPublication)(
        options.cli,
        revision,
      )
    : undefined;
  runSql(
    options.environment,
    collectionSql({
      mode,
      revision,
      cliSha256,
      apiSchema: capabilities.schema_version,
      runner: options.runner ?? process.env.PORTCOVE_MAINTENANCE_RUNNER?.trim() ?? "generic",
      startedAt,
      platform,
      subjects,
      ...(issueInventory
        ? {
            issues: {
              repository: issueInventory.repository,
              observedAt: issueInventory.observed_at,
              facts: issueFacts(issueInventory),
            },
          }
        : {}),
      ...(health && healthFacts
        ? { releaseHealth: { revision: health.revision, ...healthFacts } }
        : {}),
      ...(upstream ? { upstream } : {}),
      ...(hostedIntake ? { hostedIntake } : {}),
      ...(publicationObserved
        ? {
            publication: {
              revision: `${revision}+published-status:${publicationObserved.published_status ?? "unreachable"}`,
              ...publicationFacts(publicationObserved),
            },
          }
        : {}),
      ...(mode === "all"
        ? {
            latest: {
              catalog: latestMembers(options.environment, "catalog-records", startedAt),
              core: latestMembers(options.environment, coreSourceName(platform), startedAt),
              ...(issueInventory
                ? { issues: latestMembers(options.environment, "issues-project", startedAt) }
                : {}),
              ...(health
                ? { releaseHealth: latestMembers(options.environment, "release-health", startedAt) }
                : {}),
              ...(upstream
                ? {
                    upstream: latestMembers(
                      options.environment,
                      "upstream-observations",
                      startedAt,
                    ),
                  }
                : {}),
              ...(hostedIntake
                ? { hostedIntake: latestMembers(options.environment, "hosted-intake", startedAt) }
                : {}),
              ...(publicationObserved
                ? {
                    publication: latestMembers(
                      options.environment,
                      "definition-publication",
                      startedAt,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    }),
  );
  return {
    mode,
    revision,
    cli_sha256: cliSha256,
    subjects: subjects.length,
    issues: issueInventory?.issues.length ?? null,
    upstream: upstream
      ? {
          revision: upstream.revision,
          coverage: upstream.failed ? "failed" : upstream.gaps.length ? "partial" : "complete",
          facts: upstream.facts.size,
          gaps: upstream.gaps.length,
        }
      : null,
    hosted_intake: hostedIntake
      ? {
          revision: hostedIntake.revision,
          coverage: hostedIntake.failed
            ? "failed"
            : hostedIntake.gaps.length
              ? "partial"
              : "complete",
          requests: hostedIntake.expected,
          facts: hostedIntake.facts.size,
          gaps: hostedIntake.gaps.length,
        }
      : null,
    core_gaps: subjects.filter(
      ({ capabilities: fact }) => !fact.ok && !subjectScopedRefusals.has(fact.error?.code ?? ""),
    ).length,
  };
}

const corePrefix = "core-port-capabilities-";

const reportQuery = `WITH latest_issue AS (
    SELECT DISTINCT ON (o.subject_key) o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'issues-project' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.started_at DESC, o.observation_id DESC
  ), present_issue AS (
    SELECT payload FROM latest_issue WHERE payload <> portcove_maintenance.absent_payload()
  ), latest_health AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'release-health' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.started_at DESC, o.observation_id DESC
  ), latest_upstream AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'upstream-observations' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.started_at DESC, o.observation_id DESC
  ), latest_hosted AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'hosted-intake' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.started_at DESC, o.observation_id DESC
  ), latest_catalog AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'catalog-records' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.started_at DESC, o.observation_id DESC
  ), core_latest AS (
    -- The latest finished Core run of each host platform.
    SELECT DISTINCT ON (source) source, substring(source FROM ${corePrefix.length + 1}) AS platform,
           run_id, member_digest, gaps
      FROM portcove_maintenance.collection_runs
      WHERE source LIKE '${corePrefix}%' AND coverage <> 'in_progress'
      ORDER BY source, started_at DESC
  ), core_member AS (
    SELECT cl.platform, m.subject_key
      FROM core_latest cl CROSS JOIN LATERAL portcove_maintenance.run_members(cl.run_id) m
      WHERE cl.member_digest IS NOT NULL
    UNION ALL
    SELECT cl.platform, o.subject_key
      FROM core_latest cl JOIN portcove_maintenance.observations o ON o.run_id = cl.run_id
      WHERE cl.member_digest IS NULL
  ), core_gap AS (
    SELECT cl.platform, g ->> 'subject_key' AS subject_key, g ->> 'code' AS code, g ->> 'message' AS message
      FROM core_latest cl CROSS JOIN LATERAL jsonb_array_elements(cl.gaps) g
  ), assessed AS (
    SELECT c.*, split_part(c.subject_key, '@', 1) AS port_key, split_part(c.subject_key, '@', 2) AS platform
      FROM portcove_maintenance.subject_current c
      WHERE NOT starts_with(c.subject_key, 'handoff:')
  )
SELECT json_build_object(
  'handoffs', ${openHandoffsSql},
  'hosted_intake', (SELECT coalesce(json_agg(json_build_object('subject_key', h.subject_key, 'facts', h.payload,
        'latest_gap', (SELECT g ->> 'code' FROM (
            SELECT gaps FROM portcove_maintenance.collection_runs
              WHERE source = 'hosted-intake' AND coverage NOT IN ('in_progress', 'failed')
              ORDER BY started_at DESC LIMIT 1) hr
           CROSS JOIN LATERAL jsonb_array_elements(hr.gaps) g
           WHERE g ->> 'subject_key' = h.subject_key LIMIT 1),
        'issues', (SELECT coalesce(json_agg(json_build_object('number', (i.payload ->> 'number')::integer,
                     'state', i.payload ->> 'state', 'status', i.payload -> 'project' -> 0 -> 'fields' ->> 'Status')
                     ORDER BY (i.payload ->> 'number')::integer), '[]')
                     FROM present_issue i
                     WHERE (i.payload ->> 'number')::bigint IN (
                       SELECT (s ->> 'linked_issue')::bigint FROM jsonb_array_elements(h.payload -> 'slots') s
                        WHERE jsonb_typeof(s -> 'linked_issue') = 'number')))
        ORDER BY (h.payload ->> 'request_comment')::bigint), '[]')
      FROM latest_hosted h WHERE h.payload <> portcove_maintenance.absent_payload()),
  'publication', (SELECT coalesce(json_agg(json_build_object('definition', p.subject_key, 'facts', p.payload)
        ORDER BY p.subject_key), '[]')
      FROM (SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
              FROM portcove_maintenance.observations o
              JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
              WHERE r.source = 'definition-publication' AND r.coverage <> 'in_progress'
              ORDER BY o.subject_key, r.started_at DESC, o.observation_id DESC) p
      WHERE p.payload <> portcove_maintenance.absent_payload()),
  'runs', (SELECT coalesce(json_agg(r ORDER BY r.source, r.started_at DESC), '[]') FROM (
      SELECT DISTINCT ON (source) source, run_id, runner, source_revision, started_at, completed_at, coverage,
             expected_count, observed_count, gaps, member_count, member_digest
        FROM portcove_maintenance.collection_runs WHERE coverage <> 'in_progress' ORDER BY source, started_at DESC) r),
  'unassessed_gaps', (SELECT coalesce(json_agg(json_build_object('subject_key', g.subject_key || '@' || g.platform,
        'port_key', g.subject_key, 'platform', g.platform, 'code', g.code, 'message', g.message)
        ORDER BY g.platform, g.subject_key), '[]')
      FROM core_gap g
      WHERE NOT EXISTS (SELECT 1 FROM assessed a WHERE a.port_key = g.subject_key AND a.platform = g.platform)),
  'subjects', (SELECT coalesce(json_agg(s ORDER BY s.subject_key), '[]') FROM (
      SELECT c.subject_key, c.port_key, c.platform, c.sequence, c.updated_at, a.state, a.policy_version, a.input_digest,
        a.assessed_at, a.explanation,
        (SELECT json_agg(json_build_object('sequence', t.sequence, 'state', t.state, 'recorded_at', t.recorded_at,
                 'returns_to_earlier_result', t.returns_to_earlier_result) ORDER BY t.sequence)
           FROM portcove_maintenance.subject_transitions t WHERE t.subject_key = c.subject_key) AS history,
        (SELECT json_agg(json_build_object('source', o.source, 'run_id', o.run_id, 'input_revision', o.input_revision,
                 'scope', o.scope, 'observed_at', o.observed_at, 'content_sha256', o.content_sha256,
                 'absent', o.payload = portcove_maintenance.absent_payload()) ORDER BY o.source)
           FROM (SELECT DISTINCT ON (r.source) r.source, ob.*
                   FROM portcove_maintenance.observations ob
                   JOIN portcove_maintenance.collection_runs r ON r.run_id = ob.run_id
                   WHERE ob.subject_key = c.port_key AND r.coverage <> 'in_progress'
                     AND (r.source = 'catalog-records' OR r.source = '${corePrefix}' || c.platform)
                   ORDER BY r.source, r.started_at DESC, ob.observation_id DESC) o) AS observations,
        EXISTS (SELECT 1 FROM core_member m WHERE m.platform = c.platform AND m.subject_key = c.port_key)
          AS in_latest_core_run,
        (SELECT json_build_object('code', g.code, 'message', g.message) FROM core_gap g
          WHERE g.platform = c.platform AND g.subject_key = c.port_key LIMIT 1) AS latest_core_gap,
        lc.payload = portcove_maintenance.absent_payload() AS removed,
        (SELECT CASE WHEN h.payload = portcove_maintenance.absent_payload() THEN NULL ELSE h.payload END
           FROM latest_health h WHERE h.subject_key = c.port_key) AS release_health,
        (SELECT g ->> 'code' FROM (
            SELECT gaps FROM portcove_maintenance.collection_runs
              WHERE source = 'release-health' AND coverage <> 'in_progress'
              ORDER BY started_at DESC LIMIT 1) hr
           CROSS JOIN LATERAL jsonb_array_elements(hr.gaps) g
           WHERE g ->> 'subject_key' = c.port_key LIMIT 1) AS latest_health_gap,
        (SELECT CASE WHEN u.payload = portcove_maintenance.absent_payload() THEN NULL ELSE u.payload END
           FROM latest_upstream u WHERE u.subject_key = c.port_key) AS upstream,
        (SELECT g FROM (
            SELECT gaps FROM portcove_maintenance.collection_runs
              WHERE source = 'upstream-observations' AND coverage NOT IN ('in_progress', 'failed')
              ORDER BY started_at DESC LIMIT 1) ur
           CROSS JOIN LATERAL jsonb_array_elements(ur.gaps) g
           WHERE g ->> 'subject_key' = c.port_key LIMIT 1) AS latest_upstream_gap,
        json_build_object(
          'name', lc.payload -> 'authored_record' -> 'listing' ->> 'name',
          'game', lc.payload -> 'authored_record' -> 'listing' ->> 'original_game_title',
          'platforms', lc.payload -> 'authored_record' -> 'listing' -> 'platforms',
          'operational_definition', lc.payload -> 'operational_definition',
          'target_key', lc.payload -> 'authored_record' -> 'upstream_lineage' ->> 'target_key',
          'lineage', (SELECT coalesce(json_agg(json_build_object('relationship', d ->> 'relationship',
                        'outcome', d ->> 'outcome', 'related_port', d -> 'related_port' ->> 'id')), '[]')
                        FROM jsonb_array_elements(coalesce(lc.payload -> 'authored_record' -> 'upstream_lineage' -> 'decisions', '[]')) d),
          'qualification', (SELECT coalesce(json_agg(json_build_object('platform', q -> 'scope' ->> 'platform',
                        'outcome', q ->> 'outcome', 'check_version', q -> 'scope' ->> 'check_version',
                        'artifact_sha256', q -> 'scope' ->> 'artifact_sha256')), '[]')
                        FROM jsonb_array_elements(coalesce(lc.payload -> 'scoped_qualification', '[]')) q)
        ) AS identity,
        (SELECT coalesce(json_agg(json_build_object('number', (i.payload ->> 'number')::integer,
                   'state', i.payload ->> 'state', 'title', i.payload ->> 'title',
                   'project', i.payload -> 'project', 'blocked_by', i.payload -> 'blocked_by',
                   'canonical', (i.payload ->> 'number') = (lc.payload -> 'authored_record' -> 'listing' ->> 'issue_number'))
                 ORDER BY (i.payload ->> 'number')::integer), '[]')
           FROM present_issue i
           WHERE i.payload -> 'catalog_ids' ? substring(c.port_key FROM 6)
              OR (i.payload ->> 'number') = (lc.payload -> 'authored_record' -> 'listing' ->> 'issue_number')) AS work
        FROM assessed c
        JOIN portcove_maintenance.assessments a ON a.assessment_id = c.assessment_id
        LEFT JOIN latest_catalog lc ON lc.subject_key = c.port_key) s)
);`;

export interface InventoryReport {
  format: "portcove-maintenance-inventory";
  format_version: typeof inventoryFormatVersion;
  generated_at: string;
  scope: "declared-sample" | "complete-authored-catalog";
  publication: {
    status: "unknown" | "observed";
    reason: string;
    definitions?: { definition: string; facts: unknown }[];
  };
  unsupported_sources: { source: string; reason: string }[];
  runs: unknown[];
  subjects: unknown[];
  unassessed_gaps?: { subject_key: string; code: string; message: string }[];
  /** Latest facts per `intake:<request>`, with linked issues joined to issue facts. */
  hosted_intake?: HostedIntakeEntry[];
  /** Open executor handoffs with their registry entry and newest open operation; dispatch is disabled. */
  handoffs?: OpenHandoff[];
}

export interface HostedIntakeEntry {
  subject_key: string;
  facts: unknown;
  /** This request's gap code in the latest run that was not `failed`, if any. */
  latest_gap?: string | null;
  issues: { number: number; state: string | null; status: string | null }[];
}

export function buildReport(environment: NodeJS.ProcessEnv, now = new Date()): InventoryReport {
  const data = JSON.parse(runSql(environment, reportQuery).trim()) as {
    runs: unknown[];
    subjects: unknown[];
    unassessed_gaps: { subject_key: string; code: string; message: string }[];
    publication: { definition: string; facts: unknown }[];
    hosted_intake: HostedIntakeEntry[];
    handoffs: unknown;
  };
  // Membership-verified catalog runs cover every authored record at their revision.
  const catalogScope = (data.runs as { source: string; member_digest: string | null }[]).some(
    ({ source, member_digest }) => source === "catalog-records" && member_digest !== null,
  )
    ? "complete-authored-catalog"
    : "declared-sample";
  const subjects = data.subjects as {
    subject_key: string;
    port_key: string;
    in_latest_core_run?: boolean;
    latest_core_gap?: { code: string; message: string } | null;
    removed?: boolean | null;
    identity?: { target_key?: string | null };
  }[];
  // Alternatives: other implementations sharing the authored lineage target key.
  const byTarget = new Map<string, string[]>();
  for (const subject of subjects) {
    const target = subject.identity?.target_key;
    if (target && !(byTarget.get(target) ?? []).includes(subject.port_key))
      byTarget.set(target, [...(byTarget.get(target) ?? []), subject.port_key]);
  }
  const issuesObserved = (data.runs as { source: string; coverage: string }[]).some(
    ({ source, coverage }) => source === "issues-project" && coverage === "complete",
  );
  // The last known facts stay current through a failed probe; the reason names that probe.
  const latestPublicationRun = (
    data.runs as { source: string; coverage: string; gaps?: { code: string }[] }[]
  ).find(({ source }) => source === "definition-publication");
  // A complete run that found no committed definitions is an observation, not an unknown.
  const publicationRun =
    data.publication.length || latestPublicationRun?.coverage === "complete"
      ? latestPublicationRun
      : undefined;
  const probeNote =
    latestPublicationRun && latestPublicationRun.coverage !== "complete"
      ? ` (latest probe not classified: ${latestPublicationRun.gaps?.map(({ code }) => code).join(", ") ?? "unknown"})`
      : "";
  const healthObserved = (data.runs as { source: string }[]).some(
    ({ source }) => source === "release-health",
  );
  const upstreamObserved = (data.runs as { source: string }[]).some(
    ({ source }) => source === "upstream-observations",
  );
  const hostedObserved = (data.runs as { source: string }[]).some(
    ({ source }) => source === "hosted-intake",
  );
  return {
    format: "portcove-maintenance-inventory",
    format_version: inventoryFormatVersion,
    generated_at: now.toISOString(),
    scope: catalogScope,
    publication: publicationRun
      ? {
          status: "observed",
          reason:
            (data.publication.length
              ? data.publication
                  .map(({ definition, facts }) => {
                    const value = facts as {
                      main?: { revision?: unknown };
                      site?: { status?: unknown };
                      published?: unknown;
                    };
                    return `${definition} revision ${String(value.main?.revision)} on main; published: ${String(value.published)} (appointed site ${String(value.site?.status)})`;
                  })
                  .join("; ")
              : "observed: no committed definitions") + probeNote,
          definitions: data.publication,
        }
      : {
          status: "unknown",
          reason: unsupportedSources.find(([source]) => source === "definition-publication")![1],
        },
    unsupported_sources: unsupportedSources
      .filter(([source]) => !(issuesObserved && (source === "issues" || source === "project")))
      .filter(([source]) => !(healthObserved && source === "release-health"))
      .filter(([source]) => !(upstreamObserved && source === "upstream-observations"))
      .filter(([source]) => !(hostedObserved && source === "hosted-intake"))
      .filter(([source]) => !(publicationRun && source === "definition-publication"))
      .map(([source, reason]) => ({ source, reason })),
    runs: data.runs,
    subjects: subjects.map((subject) => {
      const target = subject.identity?.target_key;
      return {
        ...subject,
        alternatives: target
          ? (byTarget.get(target) ?? []).filter((key) => key !== subject.port_key)
          : [],
        latest_core_gap: subject.latest_core_gap ?? null,
        // Gap and membership both come from this subject's own platform's latest Core run.
        latest_core_run: subject.removed
          ? "removed"
          : subject.latest_core_gap
            ? "gap"
            : subject.in_latest_core_run === true
              ? "assessed"
              : "not-included",
      };
    }),
    unassessed_gaps: data.unassessed_gaps,
    ...(hostedObserved ? { hosted_intake: data.hosted_intake } : {}),
    handoffs: openHandoffs(data.handoffs),
  };
}

const escapeHtml = (value: unknown) =>
  String(value).replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);

/** "Next action" texts for the open handoffs of these source subjects. */
function nextActions(report: InventoryReport, ...sources: unknown[]) {
  return (report.handoffs ?? [])
    .filter(({ source_subject }) => sources.includes(source_subject))
    .map((handoff) => `${handoff.kind}: ${nextAction(handoff)}`);
}

/**
 * The source-level gap codes of a source's latest run when that run failed.
 * Per-subject gaps then come from the latest run that did not fail.
 */
function failedAttempt(report: InventoryReport, name: string) {
  const run = (
    report.runs as { source: string; coverage: string; gaps?: { code: string }[] }[]
  ).find(({ source }) => source === name);
  return run?.coverage === "failed"
    ? (run.gaps ?? []).map(({ code }) => code).join(", ") || "unknown"
    : null;
}

/** Hosted-intake requests with their linked work and the executor's own attention conditions. */
function hostedIntakeSection(report: InventoryReport) {
  if (!report.hosted_intake) return "";
  const attempt = failedAttempt(report, "hosted-intake");
  return `<h2>Hosted intake</h2>
<table><thead><tr><th>Request</th><th>State</th><th>Linked work</th><th>Needs attention</th><th>Next action</th></tr></thead><tbody>
${report.hosted_intake
  .map(({ subject_key, facts, issues, latest_gap: gap }) => {
    const work = issues
      .map(
        ({ number, state, status }) =>
          `#${number} ${state ?? "unknown"}${status ? ` · ${status}` : ""}`,
      )
      .join("; ");
    return `<tr><td>${escapeHtml(subject_key)}</td><td>${escapeHtml(
      [
        hostedIntakeSummary(facts),
        attempt ? `latest attempt failed: ${attempt}` : "",
        gap ? `${attempt ? "previous read" : "latest read"}: ${gap}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    )}</td><td>${escapeHtml(work || "no linked issue observed")}</td><td>${escapeHtml(
      hostedIntakeAttention(facts).join("; "),
    )}</td><td>${escapeHtml(nextActions(report, subject_key).join("; "))}</td></tr>`;
  })
  .join("\n")}
</tbody></table>`;
}

/** A self-contained, searchable page; data is embedded as escaped JSON, never as markup. */
export function renderHtml(report: InventoryReport) {
  // The page embeds only what it renders; inventory.json keeps every explanation.
  const upstreamAttempt = failedAttempt(report, "upstream-observations");
  const view = {
    subjects: (report.subjects as Record<string, unknown>[]).map(
      ({
        subject_key,
        port_key,
        state,
        sequence,
        assessed_at,
        latest_core_gap,
        latest_core_run,
        work,
        identity,
        alternatives,
        release_health,
        latest_health_gap,
        upstream,
        latest_upstream_gap,
      }) => ({
        attention: [
          ...(attentionConditions(release_health) as { rule?: string; operation?: string }[]).map(
            ({ rule, operation }) => `${rule ?? "unknown"} (${operation ?? "unknown"})`,
          ),
          ...upstreamAttention(upstream, latest_upstream_gap),
        ],
        latest_health_gap,
        next_actions: nextActions(report, port_key, subject_key),
        upstream: upstreamSummary(upstream, latest_upstream_gap, upstreamAttempt),
        subject_key,
        name: (identity as { name?: string } | undefined)?.name ?? null,
        game: (identity as { game?: string } | undefined)?.game ?? null,
        target_key: (identity as { target_key?: string } | undefined)?.target_key ?? null,
        alternatives,
        state,
        sequence,
        assessed_at,
        latest_core_gap,
        latest_core_run,
        work: Array.isArray(work)
          ? (
              work as {
                number: number;
                state: string;
                canonical: boolean;
                project: { fields: Record<string, string> }[];
              }[]
            ).map(
              ({ number, state: issueState, canonical, project }) =>
                `#${number}${canonical ? " (canonical)" : ""} ${issueState}${project[0]?.fields.Status ? ` · ${project[0].fields.Status}` : ""}`,
            )
          : [],
      }),
    ),
    unassessed_gaps: report.unassessed_gaps ?? [],
  };
  const embedded = JSON.stringify(view).replace(/</gu, "\\u003c");
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
${hostedIntakeSection(report)}
<p>Next actions are executor handoffs. Disabled: ${escapeHtml(disabledCapabilities.join("; "))}.</p>
<h2>Subjects</h2>
<label for="search">Search</label>
<input id="search" type="search" placeholder="Port ID or state">
<table><thead><tr><th>Subject</th><th>Name and game</th><th>Alternatives</th><th>Core assessment</th><th>Changes</th><th>Assessed</th><th>Latest Core run</th><th>Work</th><th>Upstream</th><th>Needs attention</th><th>Next action</th></tr></thead><tbody id="subjects"></tbody></table>
<script id="inventory" type="application/json">${embedded}</script>
<script>
const report = JSON.parse(document.getElementById("inventory").textContent);
const body = document.getElementById("subjects");
function render(filter) {
  body.replaceChildren();
  for (const subject of [...report.subjects, ...(report.unassessed_gaps ?? []).map((gap) => ({ subject_key: gap.subject_key, state: "unknown", sequence: 0, assessed_at: "never", latest_core_gap: gap }))]) {
    const text = [subject.subject_key, subject.state, subject.name, subject.game, subject.target_key].join(" ").toLowerCase();
    if (filter && !text.includes(filter)) continue;
    const row = body.insertRow();
    const gap = subject.latest_core_gap
      ? "not assessed: " + subject.latest_core_gap.code
      : subject.latest_core_run === "assessed" ? "assessed"
      : subject.latest_core_run === "removed" ? "removed from the catalog" : "not in latest run";
    for (const value of [subject.subject_key, [subject.name, subject.game].filter(Boolean).join(" — "), (subject.alternatives ?? []).join(", "), subject.state, String(subject.sequence), subject.assessed_at, gap, (subject.work ?? []).join("; ") || "no linked issue observed", subject.upstream || "not observed", [subject.latest_health_gap ? "health not fresh: " + subject.latest_health_gap : "", ...(subject.attention ?? [])].filter(Boolean).join("; "), (subject.next_actions ?? []).join("; ")])
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

export interface DigestEntry {
  notification_key: string;
  subject_key: string;
  sequence: number;
  previous_state: string | null;
  state: string;
  returns_to_earlier_result: boolean;
  recorded_at: string;
  /** The recorded handoff condition for a `handoff:` subject; null otherwise. */
  handoff_condition?: unknown;
}

/** Pending changes-only notifications; an unchanged subject never appears here. */
export function buildDigest(environment: NodeJS.ProcessEnv) {
  const entries = parseJson(
    runSql(
      environment,
      `SELECT coalesce(json_agg(json_build_object('notification_key', n.notification_key, 'subject_key', n.subject_key,
          'sequence', t.sequence, 'previous_state', p.state, 'state', t.state,
          'returns_to_earlier_result', t.returns_to_earlier_result, 'recorded_at', t.recorded_at,
          'handoff_condition', CASE WHEN starts_with(n.subject_key, 'handoff:') THEN a.explanation -> 'condition' END)
          ORDER BY t.recorded_at, n.subject_key COLLATE "C"), '[]')
         FROM portcove_maintenance.notifications n
         JOIN portcove_maintenance.subject_transitions t
           ON t.subject_key = n.subject_key AND t.sequence = n.transition_sequence
         JOIN portcove_maintenance.assessments a ON a.assessment_id = t.assessment_id
         LEFT JOIN portcove_maintenance.subject_transitions p
           ON p.subject_key = t.subject_key AND p.sequence = t.sequence - 1
        WHERE n.status = 'pending';`,
    ).trim(),
    "maintenance digest",
  ) as DigestEntry[];
  return { format: "portcove-maintenance-digest", format_version: 1, entries };
}

export function renderDigestMarkdown(digest: ReturnType<typeof buildDigest>) {
  if (!digest.entries.length) return "No maintenance changes since the last delivered digest.\n";
  const line = (entry: DigestEntry) => {
    const handoff = parseHandoffSubject(entry.subject_key);
    const registered = handoff && handoffEntry(handoff.kind);
    const action =
      handoff && entry.state === "needs-attention"
        ? `; next action: ${registered ? handoffGuidance(registered, entry.handoff_condition ?? null).action : "unregistered handoff kind"} (dispatch disabled)`
        : "";
    return `- \`${entry.subject_key}\`: ${entry.previous_state ?? "none"} → ${entry.state}${entry.returns_to_earlier_result ? " (returns to an earlier result)" : ""}${action}`;
  };
  return `${digest.entries.length} maintenance change${digest.entries.length === 1 ? "" : "s"}:\n\n${digest.entries.map(line).join("\n")}\n`;
}

/** Writes digest.json and digest.md to a new directory; marks nothing delivered. */
export function writeDigest(digest: ReturnType<typeof buildDigest>, output: string) {
  if (existsSync(output))
    throw new MaintenanceStoreError(`Digest destination already exists: ${output}`);
  mkdirSync(path.dirname(output), { recursive: true });
  const staging = mkdtempSync(`${output}.partial-`);
  try {
    writeFileSync(path.join(staging, "digest.json"), `${JSON.stringify(digest, null, 2)}\n`);
    writeFileSync(path.join(staging, "digest.md"), renderDigestMarkdown(digest));
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Records delivery of exactly the digest's notifications against the delivering
 * executor's own receipt (for example the issue-comment URL it created). Only
 * still-pending notifications change; a replay with the same receipt is a no-op.
 */
export function acknowledgeDigest(
  environment: NodeJS.ProcessEnv,
  digest: ReturnType<typeof buildDigest>,
  receipt: string,
) {
  if (!/^\S{1,500}$/u.test(receipt))
    throw new MaintenanceStoreError("Delivery receipt must be one reference");
  const keys = digest.entries.map(({ notification_key }) => notification_key);
  if (!keys.length) return { delivered: 0 };
  const delivered = runSql(
    environment,
    `SET LOCAL standard_conforming_strings = on;
     WITH updated AS (
       UPDATE portcove_maintenance.notifications SET status = 'delivered', delivered_at = clock_timestamp(),
         delivery_receipt = ${literal(receipt)}
        WHERE status = 'pending' AND notification_key IN (${keys.map(literal).join(", ")})
        RETURNING 1)
     SELECT count(*) FROM updated;`,
  ).trim();
  return { delivered: Number(delivered) };
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
  collect --cli PATH [--sample FILE | --all] [--concurrency N]
                                       read the declared sample (or, with --all, every authored
                                       port) at the checkout's HEAD and the Core port-capabilities
                                       assessment into the store; --all stores changes only;
                                       --issues (with --all) adds the verified issue and Project
                                       inventory through the maintained read-only roadmap collector;
                                       --release-health (with --all) adds the latest scheduled
                                       main upstream-health report, bound by run and digest;
                                       --upstream (with --all) adds the newest retained upstream
                                       observer checkpoint snapshot from a completed schedule or
                                       push main run, bound by run, source and artifact digest;
                                       --hosted-intake (with --all) adds every #177 hosted-intake
                                       request through the executor's read-only status, bound by
                                       the #177 revision and a digest of every comment
  report --output DIR                  write inventory.json and index.html to a new DIR
  digest --output DIR                  write the pending changes-only digest (digest.json, digest.md)
  acknowledge --digest FILE --receipt REF
                                       record delivery of that digest's notifications against the
                                       delivering executor's receipt (executor role)
  handoffs [--json]                    list open executor handoffs with their registry entry and
                                       open operation (read-only; dispatch is disabled)
  handoffs --record                    plan one operation per open handoff at its current fence and
                                       abandon planned operations whose handoff moved on (executor
                                       role, local store only; never dispatches)

options:
  --database-env NAME   environment variable holding the database URL (default ${defaultDatabaseEnvironment})
  --database-env-file PATH   read that variable from an env file

PORTCOVE_MAINTENANCE_RUNNER optionally names the runner recorded with each collection run.`;

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return command ? 0 : 2;
  }
  const environment = connectionFromEnvironment(
    option(args, "--database-env") ?? defaultDatabaseEnvironment,
    process.env,
    option(args, "--database-env-file"),
  );
  const cli = option(args, "--cli");
  const sample = option(args, "--sample");
  const output = option(args, "--output");
  const digestFile = option(args, "--digest");
  const receipt = option(args, "--receipt");
  const concurrency = option(args, "--concurrency");
  const allIndex = args.indexOf("--all");
  const all = allIndex >= 0;
  if (all) args.splice(allIndex, 1);
  const publicationIndex = args.indexOf("--publication");
  const publication = publicationIndex >= 0;
  if (publication) args.splice(publicationIndex, 1);
  const healthIndex = args.indexOf("--release-health");
  const releaseHealth = healthIndex >= 0;
  if (releaseHealth) args.splice(healthIndex, 1);
  const upstreamIndex = args.indexOf("--upstream");
  const upstreamSource = upstreamIndex >= 0;
  if (upstreamSource) args.splice(upstreamIndex, 1);
  const hostedIndex = args.indexOf("--hosted-intake");
  const hostedSource = hostedIndex >= 0;
  if (hostedSource) args.splice(hostedIndex, 1);
  const flag = (name: string) => {
    const index = args.indexOf(name);
    if (index >= 0) args.splice(index, 1);
    return index >= 0;
  };
  const json = flag("--json");
  const record = flag("--record");
  const issuesIndex = args.indexOf("--issues");
  const issues = issuesIndex >= 0;
  if (issues) args.splice(issuesIndex, 1);
  if (all && sample) throw new MaintenanceStoreError("--all and --sample are exclusive");
  if (concurrency !== undefined && !/^[1-9][0-9]?$/u.test(concurrency))
    throw new MaintenanceStoreError("--concurrency must be 1-99");
  if ((json || record) && command !== "handoffs")
    throw new MaintenanceStoreError("--json and --record apply only to handoffs");
  if (args.length)
    throw new MaintenanceStoreError(`Unexpected arguments: ${args.join(" ")}\n${usage}`);
  if (command === "collect") {
    if (!cli) throw new MaintenanceStoreError("collect requires --cli PATH");
    console.log(
      JSON.stringify(
        await collect({
          cli: path.resolve(cli),
          sample,
          all,
          concurrency: concurrency === undefined ? undefined : Number(concurrency),
          issues: issues ? readIssueInventory : undefined,
          releaseHealth: releaseHealth ? readReleaseHealth : undefined,
          upstream: upstreamSource ? () => readUpstreamObservations(committedBytes) : undefined,
          hostedIntake: hostedSource ? readHostedIntake : undefined,
          publication: publication || undefined,
          environment,
        }),
        null,
        2,
      ),
    );
  } else if (command === "report") {
    if (!output) throw new MaintenanceStoreError("report requires --output DIR");
    const report = buildReport(environment);
    writeReport(report, path.resolve(output));
    console.log(
      JSON.stringify({ output: path.resolve(output), subjects: report.subjects.length }, null, 2),
    );
  } else if (command === "digest") {
    if (!output) throw new MaintenanceStoreError("digest requires --output DIR");
    const digest = buildDigest(environment);
    writeDigest(digest, path.resolve(output));
    console.log(
      JSON.stringify({ output: path.resolve(output), changes: digest.entries.length }, null, 2),
    );
  } else if (command === "acknowledge") {
    if (!digestFile || !receipt)
      throw new MaintenanceStoreError("acknowledge requires --digest FILE and --receipt REF");
    const digest = parseJson(
      readFileSync(path.resolve(digestFile), "utf8"),
      "digest",
    ) as ReturnType<typeof buildDigest>;
    if (digest.format !== "portcove-maintenance-digest" || !Array.isArray(digest.entries))
      throw new MaintenanceStoreError("Unsupported digest file");
    console.log(JSON.stringify(acknowledgeDigest(environment, digest, receipt), null, 2));
  } else if (command === "handoffs") {
    if (record && json) throw new MaintenanceStoreError("handoffs takes --json or --record");
    if (record) console.log(JSON.stringify(recordHandoffOperations(environment), null, 2));
    else {
      const handoffs = readOpenHandoffs(environment);
      if (json)
        console.log(
          JSON.stringify(
            {
              format: "portcove-maintenance-handoffs",
              format_version: 1,
              dispatch: "disabled",
              disabled: disabledCapabilities,
              without_handoff: withoutHandoff.map(([source, reason]) => ({ source, reason })),
              handoffs,
            },
            null,
            2,
          ),
        );
      else process.stdout.write(renderHandoffs(handoffs));
    }
  } else throw new MaintenanceStoreError(`Unknown command: ${command}\n${usage}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof MaintenanceStoreError ? error.message : error);
      process.exitCode = 1;
    },
  );
}
