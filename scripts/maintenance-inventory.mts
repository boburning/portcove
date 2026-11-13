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
  batchedStatements,
  connectionFromEnvironment,
  defaultDatabaseEnvironment,
  runSql,
} from "./maintenance-store.mts";
import { portCatalogMarkers, portKeyMarkers } from "./roadmap-issue.mts";
import { explicitBlockerFields } from "./roadmap-qualification.mts";
import {
  issueReconsiderations,
  reconsiderationSql,
  targetReconsiderations,
} from "./maintenance-reconsiderations.mts";
import { buildUniverse, type UniverseEntry } from "./maintenance-universe.mts";
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
import type { GitHubCredential } from "./github-client.mts";
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
    "Not collected; collect --all --publication reads the definitions committed on main.",
  ],
  [
    "definition-delivery",
    "Not collected; collect --all --delivery verifies the appointed definition location through Core.",
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

/** Bump when `capabilityResult` changes how a Core report becomes a state or explanation. */
export const capabilityProjectionVersion = 1;

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
  /** Null when a selective run reused the subject's unchanged Core result without calling Core. */
  capabilities: CapabilityObservation | null;
}

/** A selective run must follow a full read under the same key no older than this. */
export const fullReassessmentDays = 7;

/** Repository paths whose content defines what Core computes (code, embedded catalog, toolchain). */
export const coreSemanticPaths = [
  "crates",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "vendor",
];

/**
 * The Core semantics a run reads under: the Git object IDs of everything the
 * binary is built from, the producer's compiled catalog identity and
 * features, the API schema, projection, platform and isolation. Equal keys
 * mean the same code and data; the binary digest is deliberately excluded,
 * because every rebuild changes it.
 */
export function coreReuseKey(input: {
  trees: Readonly<Record<string, string>>;
  producer: Pick<CoreProducer, "features" | "embedded_catalog_sha256" | "embedded_listings_sha256">;
  apiSchema: number;
  platform: string;
}) {
  return sha256(
    canonicalJson({
      trees: input.trees,
      features: [...input.producer.features].sort(),
      embedded_catalog_sha256: input.producer.embedded_catalog_sha256,
      embedded_listings_sha256: input.producer.embedded_listings_sha256,
      api: input.apiSchema,
      projection: capabilityProjectionVersion,
      platform: input.platform,
      isolation: isolationScope,
    }),
  );
}

/**
 * Whether a catalog observation became visible between two times: Core shows
 * clock-dated observations only once their `observed_at` (seconds) has passed,
 * so its output can change with no input changing. Any such value in the
 * window forces a full read. Conservative: every `observed_at` counts.
 */
export function clockWindowCrossed(
  documents: readonly unknown[],
  afterSeconds: number,
  nowSeconds: number,
) {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value && typeof value === "object")
      return Object.entries(value).some(
        ([key, item]) =>
          (key === "observed_at" &&
            typeof item === "number" &&
            item > afterSeconds &&
            item <= nowSeconds) ||
          visit(item),
      );
    return false;
  };
  return documents.some(visit);
}

/** The latest Core run of a source and the latest full read under a key, as the store holds them. */
export interface ReuseHistory {
  latest: { coverage: string; reuse_key: string | null } | null;
  full_started_at: string | null;
}

/**
 * Plans a Core run. Selective reuse needs every condition; otherwise the run
 * is full and says why. A subject is reused only when its Core result and its
 * catalog fact are unchanged members of the decided baselines.
 */
export function planReassessment(input: {
  requested: "full" | "changed";
  reuseKey: string | null;
  history: ReuseHistory | null;
  now: Date;
  clockCrossed: (afterSeconds: number) => boolean;
  subjects: readonly { key: string; catalogDigest: string }[];
  catalogMembers: ReadonlyMap<string, string>;
  coreMembers: ReadonlyMap<string, string>;
}): { reassessment: Reassessment; reused: Set<string>; reason: string } {
  const full = (reason: string) => ({
    reassessment: { mode: "full" as const, reuseKey: input.reuseKey },
    reused: new Set<string>(),
    reason,
  });
  if (input.requested === "full") return full("full read requested");
  if (input.reuseKey === null)
    return full(
      "the Core build's source binding is not verified, so its semantics cannot be keyed",
    );
  const latest = input.history?.latest;
  if (!latest || latest.coverage !== "complete" || latest.reuse_key !== input.reuseKey)
    return full("the latest Core run is not a complete read under the same key");
  const fullAt = input.history?.full_started_at ? Date.parse(input.history.full_started_at) : NaN;
  if (!Number.isFinite(fullAt) || input.now.getTime() - fullAt > fullReassessmentDays * 86_400_000)
    return full(`no full read under this key within ${fullReassessmentDays} days`);
  if (input.clockCrossed(Math.floor(fullAt / 1000)))
    return full("a clock-dated catalog observation became visible since the last full read");
  const reused = new Set(
    input.subjects
      .filter(
        ({ key, catalogDigest }) =>
          input.coreMembers.has(key) && input.catalogMembers.get(key) === catalogDigest,
      )
      .map(({ key }) => key),
  );
  return reused.size
    ? {
        reassessment: { mode: "selective", reuseKey: input.reuseKey },
        reused,
        reason: `${reused.size} unchanged subjects reused under the same Core semantics`,
      }
    : full("no subject is unchanged under the same key");
}

/** The authored catalog fact of one subject, as stored by `catalog-records`. */
export function catalogFactOf(
  subject: Pick<CollectedSubject, "record" | "operational" | "qualification">,
) {
  return {
    authored_record: subject.record,
    operational_definition: subject.operational,
    scoped_qualification: subject.qualification,
  };
}

/** A Core run's reassessment: every subject read, or unchanged subjects reused under one key. */
export interface Reassessment {
  mode: "full" | "selective";
  /** The Core semantics this run read under; reuse is valid only under the same key. */
  reuseKey: string | null;
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
  /** The configured roadmap Project's node ID: the only Project whose Status records holds and deferrals. */
  roadmap_project_id?: string | undefined;
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
        // Present only on an open issue that records explicit fields, so other issues' facts are unchanged.
        ...(() => {
          const fields = issue.state === "OPEN" ? explicitBlockerFields(issue.body) : null;
          return fields ? { reconsideration: fields } : {};
        })(),
      },
    ]),
  );
}

/**
 * The issue and Project collector's own credential, read from the named variable so
 * that it can differ from the credential the other sources read (`GH_TOKEN`). It never
 * falls back to another credential. The variable is removed from this process's
 * environment once read, so no child process (Core CLI, Git, psql) inherits it.
 */
export function takeIssueCredential(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): GitHubCredential {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name))
    throw new MaintenanceStoreError("--issues-token-env must name an environment variable");
  const token = environment[name]?.trim();
  delete environment[name];
  if (!token)
    throw new MaintenanceStoreError(`Set ${name} to the issue and Project read credential`);
  return { kind: "explicit", token };
}

/**
 * The maintained, completeness-verified issue and Project inventory, read-only. Without
 * an explicit credential it uses the local developer credential like the other sources.
 */
export async function readIssueInventory(credential?: GitHubCredential): Promise<IssueInventory> {
  const { RoadmapClient, validateConfig } = await import("./roadmap.mts");
  const { createRoadmapRequestScope } = await import("./roadmap-capacity-continuation.mts");
  const config = validateConfig(
    JSON.parse(readFileSync(path.join(repositoryRoot, ".github", "roadmap.json"), "utf8")),
  );
  const client = await RoadmapClient.connect(
    config,
    createRoadmapRequestScope({
      allowMutations: false,
      ...(credential ? { credential } : {}),
      ghCommand: process.env.PORTCOVE_ROADMAP_GH,
    }),
  );
  const inventory = await client.repositoryIssues({ projectMemberships: true });
  // The configured Project number, as the roadmap doctor resolves it: one read,
  // unaffected by other Projects the credential can see.
  const roadmap = await client.projectDetails(client.projectNumber(undefined));
  if (roadmap.title !== config.project.title)
    throw new MaintenanceStoreError("The configured roadmap Project's identity did not match");
  return {
    roadmap_project_id: roadmap.id,
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
}

const definitionIdentity = /^[a-z0-9][a-z0-9-]{0,63}$/u;

function definitionKey(definition: Record<string, unknown>, origin: string) {
  const namespace = definition.namespace;
  const id = definition.stable_id;
  if (
    typeof namespace !== "string" ||
    typeof id !== "string" ||
    !definitionIdentity.test(namespace) ||
    !definitionIdentity.test(id)
  )
    throw new MaintenanceStoreError(`Unsupported definition identity in the ${origin}`);
  return `definition:${namespace}/${id}`;
}

/**
 * The definitions committed on main, per identity. What the appointed
 * location serves is a separate source (`definition-delivery`), read only
 * through Core's client verification: an HTTP status never says a definition
 * is or is not published.
 */
export function publicationFacts(observation: PublicationObservation) {
  const definitions = observation.inspection.definitions;
  if (!Array.isArray(definitions) || typeof observation.inspection.index_sha256 !== "string")
    throw new MaintenanceStoreError("Unsupported definition publication inspection");
  const facts = new Map<string, unknown>();
  for (const definition of definitions as Record<string, unknown>[])
    facts.set(definitionKey(definition, "publication inspection"), {
      main: {
        index_sha256: observation.inspection.index_sha256,
        revision: definition.revision ?? null,
        definition_target: definition.definition_target ?? null,
        policy_target: definition.policy_target ?? null,
        policy_revision: definition.policy_revision ?? null,
        launch_revision: definition.launch_revision ?? null,
      },
    });
  return { facts, gaps: [] as SourceGap[], expected: definitions.length };
}

/** Core's read-only client verification of the appointed definition location. */
export interface DefinitionDeliveryInspection {
  format_version: 1;
  metadata_base_url: string | null;
  serving:
    | "verified"
    | "not_served"
    | "incomplete"
    | "unreachable"
    | "expired"
    | "verification_failed"
    | "not_configured";
  reason: string | null;
  provenance: { index_sha256: string; timestamp_version: number } | null;
  definitions: {
    namespace: string;
    stable_id: string;
    revision: number;
    target: string;
    sha256: string | null;
    length: number | null;
  }[];
}

const deliveryServing = new Set([
  "verified",
  "not_served",
  "incomplete",
  "unreachable",
  "expired",
  "verification_failed",
  "not_configured",
]);

function isDeliveryInspection(value: unknown): value is DefinitionDeliveryInspection {
  if (!value || typeof value !== "object") return false;
  const inspection = value as Record<string, unknown>;
  const provenance = inspection.provenance as Record<string, unknown> | null;
  return (
    inspection.format_version === 1 &&
    typeof inspection.serving === "string" &&
    deliveryServing.has(inspection.serving) &&
    (inspection.reason === null || typeof inspection.reason === "string") &&
    Array.isArray(inspection.definitions) &&
    (inspection.serving === "verified"
      ? !!provenance &&
        typeof provenance.index_sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(provenance.index_sha256) &&
        Number.isSafeInteger(provenance.timestamp_version)
      : provenance === null && inspection.definitions.length === 0) &&
    (inspection.definitions as Record<string, unknown>[]).every(
      (definition) =>
        Number.isSafeInteger(definition.revision) &&
        typeof definition.target === "string" &&
        definition.target.length <= 512 &&
        (definition.sha256 === null ||
          (typeof definition.sha256 === "string" && /^[0-9a-f]{64}$/u.test(definition.sha256))) &&
        (definition.length === null || Number.isSafeInteger(definition.length)),
    )
  );
}

/** Reads what the appointed location serves through Core's client trust path. */
export async function readDefinitionDelivery(cli: string): Promise<DefinitionDeliveryInspection> {
  const envelope = await isolatedCli(cli, ["catalog", "inspect-definition-delivery"]);
  if (!envelope.ok || !isDeliveryInspection(envelope.data))
    throw new MaintenanceStoreError(
      "Core could not inspect definition delivery, or used an unsupported format",
    );
  return envelope.data;
}

/**
 * Verified published definitions per identity. Only a verified read records
 * facts; any other serving status (not served, unreachable, expired, failed
 * verification) is that run's gap, so the last verified publication stays
 * current and is never erased by a 404 or an outage. A verified read is
 * complete: a definition it no longer indexes is withdrawn.
 */
export function deliveryFacts(inspection: DefinitionDeliveryInspection) {
  if (!isDeliveryInspection(inspection))
    throw new MaintenanceStoreError("Unsupported definition delivery inspection");
  if (inspection.serving !== "verified")
    return {
      revision: `definition-delivery;serving=${inspection.serving}`,
      facts: new Map<string, unknown>(),
      expected: null,
      gaps: [
        {
          subject_key: "source:definition-delivery",
          code: inspection.serving,
          message:
            `The appointed location was not verified; the last verified publication stays current. ${inspection.reason ?? ""}`
              .trim()
              .slice(0, 1000),
        },
      ] as SourceGap[],
    };
  const facts = new Map<string, unknown>();
  for (const definition of inspection.definitions) {
    const key = definitionKey(definition, "delivery inspection");
    if (facts.has(key)) throw new MaintenanceStoreError(`Duplicate published definition ${key}`);
    facts.set(key, {
      published: {
        revision: definition.revision,
        target: definition.target,
        sha256: definition.sha256,
        length: definition.length,
      },
    });
  }
  return {
    revision: `definition-delivery;serving=verified;index-sha256=${inspection.provenance!.index_sha256};timestamp=${inspection.provenance!.timestamp_version}`,
    facts,
    expected: facts.size,
    gaps: [] as SourceGap[],
  };
}

/** One port's Core-owned route offering per target platform, for a fresh library. */
export interface TargetRoutesFact {
  presence: string;
  declared_platforms: string[];
  acquisition_hold: string | null;
  download_restriction: string | null;
  targets: {
    platform: string;
    routes: { action: string; offered: boolean; reason: string | null }[];
    provider_resolution_required: boolean;
    definition_eligibility: string;
    readiness: string;
    /** Core's match of recorded qualification to the catalog-offered artifact. */
    qualification: {
      state: string;
      /** Upstream refs Core found qualified by applicable lifecycle or hands-on evidence. */
      qualified_refs: string[];
      /** Whether the evidence names the route it exercised; today always `unrecorded`. */
      evidence_route: string;
      known_failure: boolean;
      offered_artifact: { state: string; route?: string; upstream_ref?: string };
      scopes: { applicability: string; upstream_ref: string; check_version: string }[];
      legacy_coverage: string[];
    };
  }[];
}

/**
 * Core's library-free per-target inspection (`catalog inspect-targets`) for
 * exactly the collected ports. Core decides every route; this only keys the
 * result by `port:<id>` and keeps Core's own unknowns.
 */
/** The producing Core's build identity, as Core reports it. */
export interface CoreProducer {
  source_revision: string | null;
  features: string[];
  embedded_catalog_sha256: string;
  embedded_listings_sha256: string;
  catalog_override: boolean;
}

export async function readTargetRoutes(
  cli: string,
  ids: readonly string[],
): Promise<{ facts: Map<string, TargetRoutesFact>; producer: CoreProducer | null }> {
  const requested = [...new Set(ids)];
  const wanted = new Set(requested);
  const facts = new Map<string, TargetRoutesFact>();
  let producer: CoreProducer | null = null;
  // Bounded batches keep every command line far below Windows' 32,767-character limit.
  for (let start = 0; start < requested.length; start += targetBatchSize) {
    const batch = requested.slice(start, start + targetBatchSize);
    const envelope = await isolatedCli(cli, [
      "catalog",
      "inspect-targets",
      ...batch.flatMap((id) => ["--port", id]),
    ]);
    const data = envelope.data as
      | { format_version?: unknown; ports?: unknown; producer?: unknown }
      | undefined;
    if (!envelope.ok || data?.format_version !== 2 || !Array.isArray(data.ports))
      throw new MaintenanceStoreError(
        "Core target inspection is unavailable or uses an unsupported format",
      );
    // One binary answers every batch; an older Core reports no producer. A recorded
    // revision that is not a Git object ID is treated as unrecorded.
    if (isCoreProducer(data.producer))
      producer = {
        ...data.producer,
        source_revision:
          data.producer.source_revision !== null &&
          /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(data.producer.source_revision)
            ? data.producer.source_revision
            : null,
      };
    for (const entry of data.ports as unknown[]) {
      const { port_id, ...fact } = (entry ?? {}) as { port_id?: unknown };
      if (typeof port_id !== "string" || !wanted.has(port_id) || facts.has(`port:${port_id}`))
        throw new MaintenanceStoreError(
          "Core target inspection returned a port that was not requested or was repeated",
        );
      if (!isTargetRoutesFact(fact))
        throw new MaintenanceStoreError(
          `Core target inspection returned an unsupported entry for ${port_id}`,
        );
      facts.set(`port:${port_id}`, fact);
    }
  }
  if (facts.size !== wanted.size)
    throw new MaintenanceStoreError("Core target inspection did not cover every collected port");
  return { facts, producer };
}

function isCoreProducer(value: unknown): value is CoreProducer {
  const producer = value as Partial<CoreProducer> | null;
  return (
    !!producer &&
    (producer.source_revision === null || typeof producer.source_revision === "string") &&
    Array.isArray(producer.features) &&
    producer.features.every((feature) => typeof feature === "string") &&
    typeof producer.embedded_catalog_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(producer.embedded_catalog_sha256) &&
    typeof producer.embedded_listings_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(producer.embedded_listings_sha256) &&
    typeof producer.catalog_override === "boolean"
  );
}

/** Ports per Core call: at most ~200 short IDs, far below any platform's command-line limit. */
const targetBatchSize = 200;

function isTargetRoutesFact(value: unknown): value is TargetRoutesFact {
  const fact = value as Partial<TargetRoutesFact>;
  const text = (item: unknown) => item === null || typeof item === "string";
  return (
    typeof fact.presence === "string" &&
    Array.isArray(fact.declared_platforms) &&
    fact.declared_platforms.every((platform) => typeof platform === "string") &&
    text(fact.acquisition_hold) &&
    text(fact.download_restriction) &&
    Array.isArray(fact.targets) &&
    fact.targets.every(
      (target) =>
        typeof target?.platform === "string" &&
        Array.isArray(target.routes) &&
        target.routes.every(
          (route) =>
            typeof route?.action === "string" &&
            typeof route.offered === "boolean" &&
            text(route.reason),
        ) &&
        typeof target.qualification?.state === "string" &&
        Array.isArray(target.qualification.qualified_refs) &&
        target.qualification.qualified_refs.every((value) => typeof value === "string") &&
        typeof target.qualification.evidence_route === "string" &&
        typeof target.qualification.known_failure === "boolean" &&
        typeof target.qualification.offered_artifact?.state === "string" &&
        Array.isArray(target.qualification.scopes) &&
        target.qualification.scopes.every(
          (scope) =>
            typeof scope?.applicability === "string" &&
            typeof scope.upstream_ref === "string" &&
            typeof scope.check_version === "string",
        ) &&
        Array.isArray(target.qualification.legacy_coverage) &&
        target.qualification.legacy_coverage.every((value) => typeof value === "string"),
    )
  );
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
    return {
      inspection: envelope.data as PublicationObservation["inspection"],
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

/** A source's changes-only baseline: its latest finished run and that run's present members. */
export interface SourceBaseline {
  run: string | null;
  members: ReadonlyMap<string, string>;
}

/** The latest Core run of a source and its latest full read under one reuse key. */
function reuseHistory(environment: NodeJS.ProcessEnv, source: string, key: string): ReuseHistory {
  return parseJson(
    runSql(
      environment,
      `SELECT json_build_object(
         'latest', (SELECT json_build_object('coverage', coverage, 'reuse_key', reuse_key)
                      FROM portcove_maintenance.collection_runs
                     WHERE run_id = portcove_maintenance.latest_run(${literal(source)})),
         'full_started_at', (SELECT max(started_at) FROM portcove_maintenance.collection_runs
                              WHERE source = ${literal(source)} AND coverage = 'complete'
                                AND reassessment = 'full' AND reuse_key = ${literal(key)}));`,
    ).trim(),
    "maintenance reuse history",
  ) as ReuseHistory;
}

/** Latest present content digest per subject, as of the source's latest finished run. */
function latestMembers(environment: NodeJS.ProcessEnv, source: string): SourceBaseline {
  const value = parseJson(
    runSql(
      environment,
      `SELECT json_build_object('run', b.run, 'members', coalesce((
           SELECT json_agg(json_build_object('subject', m.subject_key, 'digest', m.content_sha256))
             FROM portcove_maintenance.run_members(b.run) m), '[]'))
         FROM (SELECT portcove_maintenance.latest_run(${literal(source)}) AS run) b;`,
    ).trim(),
    "latest maintenance members",
  ) as { run: string | null; members: { subject: string; digest: string }[] };
  return {
    run: value.run,
    members: new Map(value.members.map(({ subject, digest }) => [subject, digest])),
  };
}

/**
 * The budget for the one collection transaction. A first complete collection
 * against a remote host writes every subject; later changes-only runs are small.
 */
const collectionTimeoutMs = 15 * 60_000;

/** A database-ordered ticket, taken before any external read of a collection. */
export function acquireCollection(environment: NodeJS.ProcessEnv) {
  const ticket = Number(
    runSql(environment, "SELECT portcove_maintenance.acquire_collection();").trim(),
  );
  if (!Number.isSafeInteger(ticket) || ticket < 1)
    throw new MaintenanceStoreError("The maintenance store issued no collection acquisition");
  return ticket;
}

/** The store refused the collection: a newer collection of a source already finished. */
export const staleCollectionPattern = /stale maintenance collection for /u;
/** Another run finished after the changes-only baseline was read. */
export const baselineChangedPattern = /maintenance baseline changed for /u;

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
  /** The ticket taken before external reads; omitted, the store admits at insert time. */
  acquisition?: number | undefined;
  platform: string;
  subjects: CollectedSubject[];
  /** How the Core run was taken; full when omitted. */
  reassessment?: Reassessment;
  latest?: {
    catalog: ReadonlyMap<string, string>;
    core: ReadonlyMap<string, string>;
    issues?: ReadonlyMap<string, string>;
    releaseHealth?: ReadonlyMap<string, string>;
    upstream?: ReadonlyMap<string, string>;
    hostedIntake?: ReadonlyMap<string, string>;
    publication?: ReadonlyMap<string, string>;
    delivery?: ReadonlyMap<string, string>;
    targets?: ReadonlyMap<string, string>;
  };
  /**
   * The producing Core's build identity. With it, assessments bind the source
   * revision, compiled catalog and features, and the host assessment's source
   * binding is verified only when that revision is the collected checkout.
   */
  producer?: CoreProducer | null;
  /** Whether Core's sources (crates, Cargo manifest and lock) were clean in the checkout. */
  coreSourceClean?: boolean;
  /**
   * The latest finished run of each source when `latest` was read. The store
   * refuses the transaction if any of them changed, so the diff stays exact.
   */
  baseline?: Readonly<Record<string, string | null>>;
  publication?: {
    revision: string;
    facts: ReadonlyMap<string, unknown>;
    gaps: { subject_key: string; code: string; message: string }[];
    /** Null when the read failed before any definition was counted. */
    expected: number | null;
  };
  /** Verified published definitions; any gap fails the run and keeps prior facts current. */
  delivery?: {
    revision: string;
    location: string | null;
    facts: ReadonlyMap<string, unknown>;
    gaps: SourceGap[];
    expected: number | null;
  };
  releaseHealth?: {
    revision: string;
    /** The report could not be read: a failed run, prior facts stay current. */
    failed?: boolean;
    expected: number | null;
    facts: ReadonlyMap<string, unknown>;
    gaps: { subject_key: string; code: string; message: string }[];
  };
  upstream?: UpstreamObservation;
  hostedIntake?: HostedIntakeObservation;
  /** Core's per-target route offering, bound to the same Core binary as the assessments. */
  targets?: {
    facts: ReadonlyMap<string, unknown>;
    expected: number;
    failure?: SourceGap;
  };
  issues?: {
    repository: string;
    observedAt: string;
    facts: ReadonlyMap<string, unknown>;
    /** The roadmap Project whose Status records holds and deferrals; without it none are derived. */
    roadmapProjectId?: string | undefined;
    /** The inventory could not be read completely: a failed run, prior facts stay current. */
    failure?: SourceGap;
  };
}) {
  const token = randomUUID();
  const acquisition =
    input.acquisition === undefined ? "DEFAULT" : String(Math.trunc(input.acquisition));
  const coreSource = coreSourceName(input.platform);
  const catalogRun = `catalog-records:${input.revision.slice(0, 12)}:${token}`;
  const coreRun = `${coreSource}:${input.cliSha256.slice(0, 12)}:${token}`;
  // The binary and its recorded source bind through the verifying run's revision.
  // The policy names only this projection of Core's report: the assessment input is
  // Core's own output, so any change in Core behavior is a new input and a new
  // assessment, while a rebuild with identical behavior writes no new rows.
  // Verified only for a clean checkout's own revision, the compiled catalog and no
  // behavior-changing features; otherwise the build's claim stays a claim. The run
  // carries it, so the verifying run states it even when no observation changed.
  const sourceBinding =
    input.producer?.source_revision === input.revision &&
    input.coreSourceClean === true &&
    !input.producer.catalog_override &&
    input.producer.features.length === 0
      ? "verified"
      : "unverified";
  const coreRevision = `cli-sha256:${input.cliSha256}${
    input.producer
      ? `;source=${input.producer.source_revision ?? "unrecorded"};producer-sha256=${sha256(canonicalJson(input.producer)).slice(0, 16)};binding=${sourceBinding}`
      : ""
  }`;
  const policy = `port-capabilities;api=${input.apiSchema};projection=${capabilityProjectionVersion}`;
  const lines = [
    // Freshness checks below must see runs committed while this transaction waited
    // for its locks, whatever the server or role default isolation is.
    "SET TRANSACTION ISOLATION LEVEL READ COMMITTED;",
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
           ...(input.delivery ? ["definition-delivery"] : []),
           ...(input.targets ? ["core-target-routes"] : []),
         ]),
       ]
         .sort()
         .map(literal)
         .join(", ")}]) AS source ORDER BY source;`,
    // Under the locks: the changes-only diff still matches each source's latest run.
    ...Object.entries(input.baseline ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([source, run]) =>
          `SELECT portcove_maintenance.expect_baseline(${literal(source)}, ${run === null ? "NULL" : literal(run)});`,
      ),
    `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at, acquisition) VALUES
      (${literal(catalogRun)}, 'catalog-records', ${literal(input.runner)}, ${literal(input.revision)}, ${literal(input.startedAt)}, ${acquisition});`,
    `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at, acquisition,
        reassessment, reuse_key, reused_count) VALUES
      (${literal(coreRun)}, ${literal(coreSource)}, ${literal(input.runner)}, ${literal(coreRevision)}, ${literal(input.startedAt)}, ${acquisition},
       ${literal(input.reassessment?.mode ?? "full")}, ${input.reassessment?.reuseKey ? literal(input.reassessment.reuseKey) : "NULL"},
       ${input.subjects.filter(({ capabilities }) => capabilities === null).length});`,
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
    const catalogFact = catalogFactOf(subject);
    const catalogDigest = sha256(canonicalJson(catalogFact));
    catalogFacts.set(key, {
      digest: catalogDigest,
      scope: { source: "catalog-records" },
      revision: input.revision,
      payload: catalogFact,
    });
    const capabilityFact = subject.capabilities;
    if (capabilityFact === null) {
      // Reused: an unchanged member under the same Core semantics and catalog fact.
      // No observation, assessment, transition or verification; verified_at stays
      // at the last real Core read.
      const baseline = input.latest?.core.get(key);
      if (
        input.mode !== "all" ||
        input.reassessment?.mode !== "selective" ||
        baseline === undefined ||
        input.latest?.catalog.get(key) !== catalogDigest
      )
        throw new MaintenanceStoreError(`The reuse decision for ${key} no longer holds; rerun`);
      coreFacts.set(key, {
        digest: baseline,
        scope: { source: coreSource, reused: true },
        revision: coreRevision,
        payload: null,
      });
      continue;
    }
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
        cli_source_binding: sourceBinding,
      },
      revision: coreRevision,
      payload: capabilityFact,
    });
    // Core results are per host platform, so is the assessment history.
    const assessed = assessmentSubject(subject.id, input.platform);
    const result = capabilityResult(capabilityFact);
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
      `INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id, verified_run_id)
        SELECT a.subject_key, coalesce(c.sequence, 0) + 1, a.assessment_id, ${literal(coreRun)}
          FROM portcove_maintenance.assessments a
          LEFT JOIN portcove_maintenance.subject_current c ON c.subject_key = a.subject_key
          WHERE a.subject_key = ${literal(assessed)} AND a.policy_version = ${literal(policy)} AND a.input_digest = ${literal(inputDigest)}
            AND c.result_digest IS DISTINCT FROM a.result_digest;`,
      // The same result under new policy or inputs: current provenance and verification
      // move to this assessment and run, with no transition or notification.
      `SELECT portcove_maintenance.verify_current(a.assessment_id, ${literal(coreRun)})
          FROM portcove_maintenance.assessments a
          JOIN portcove_maintenance.subject_current c ON c.subject_key = a.subject_key
          WHERE a.subject_key = ${literal(assessed)} AND a.policy_version = ${literal(policy)} AND a.input_digest = ${literal(inputDigest)}
            AND c.result_digest = a.result_digest
            AND (c.applicable_assessment_id <> a.assessment_id OR c.verified_run_id IS DISTINCT FROM ${literal(coreRun)});`,
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
    issueRevision = input.issues.failure
      ? "issues-project:unavailable"
      : `issues-sha256:${sha256(canonicalJson([...input.issues.facts]))}`;
    lines.push(
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at, acquisition) VALUES
        (${literal(issueRun)}, 'issues-project', ${literal(input.runner)}, ${literal(issueRevision)}, ${literal(input.startedAt)}, ${acquisition});`,
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
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at, acquisition) VALUES
        (${literal(healthRun)}, 'release-health', ${literal(input.runner)}, ${literal(input.releaseHealth.revision)}, ${literal(input.startedAt)}, ${acquisition});`,
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
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at, acquisition) VALUES
        (${literal(upstreamRun)}, 'upstream-observations', ${literal(input.runner)}, ${literal(input.upstream.revision)}, ${literal(input.startedAt)}, ${acquisition});`,
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
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at, acquisition) VALUES
        (${literal(hostedRun)}, 'hosted-intake', ${literal(input.runner)}, ${literal(input.hostedIntake.revision)}, ${literal(input.startedAt)}, ${acquisition});`,
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
      input.issues.failure ? "failed" : "complete",
      input.issues.failure ? [input.issues.failure] : [],
      issueFactsByKey,
      input.latest?.issues,
      input.issues.failure ? null : issueFactsByKey.size,
    ]);
  if (input.releaseHealth)
    runs.push([
      healthRun,
      input.releaseHealth.revision,
      input.releaseHealth.failed
        ? "failed"
        : input.releaseHealth.gaps.length
          ? "partial"
          : "complete",
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
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at, acquisition) VALUES
        (${literal(publicationRun)}, 'definition-publication', ${literal(input.runner)}, ${literal(input.publication.revision)}, ${literal(input.startedAt)}, ${acquisition});`,
    );
    for (const [key, payload] of input.publication.facts)
      publicationFactsByKey.set(key, {
        digest: sha256(canonicalJson(payload)),
        scope: { source: "definition-publication", bundle: "release/catalog-publication/bundle" },
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
  const deliveryRun = `definition-delivery:${token}`;
  if (input.delivery) {
    if (input.mode !== "all")
      throw new MaintenanceStoreError("Definition-delivery collection requires --all");
    lines.push(
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at, acquisition) VALUES
        (${literal(deliveryRun)}, 'definition-delivery', ${literal(input.runner)}, ${literal(input.delivery.revision)}, ${literal(input.startedAt)}, ${acquisition});`,
    );
    const deliveryFactsByKey = new Map<string, Fact>();
    for (const [key, payload] of input.delivery.facts)
      deliveryFactsByKey.set(key, {
        digest: sha256(canonicalJson(payload)),
        scope: {
          source: "definition-delivery",
          location: input.delivery.location,
          verification: "core-client",
        },
        revision: input.delivery.revision,
        payload,
      });
    runs.push([
      deliveryRun,
      input.delivery.revision,
      input.delivery.gaps.length ? "failed" : "complete",
      input.delivery.gaps,
      deliveryFactsByKey,
      input.latest?.delivery,
      input.delivery.gaps.length ? null : input.delivery.expected,
    ]);
  }
  const targetsRun = `core-target-routes:${input.cliSha256.slice(0, 12)}:${token}`;
  if (input.targets) {
    if (input.mode !== "all")
      throw new MaintenanceStoreError("Target-route collection requires --all");
    lines.push(
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, source_revision, started_at, acquisition) VALUES
        (${literal(targetsRun)}, 'core-target-routes', ${literal(input.runner)}, ${literal(coreRevision)}, ${literal(input.startedAt)}, ${acquisition});`,
    );
    const targetFacts = new Map<string, Fact>();
    for (const [key, payload] of input.targets.facts)
      targetFacts.set(key, {
        digest: sha256(canonicalJson(payload)),
        scope: { source: "core-target-routes", policy, isolation: "fresh-library" },
        revision: coreRevision,
        payload,
      });
    runs.push([
      targetsRun,
      coreRevision,
      input.targets.failure ? "failed" : "complete",
      input.targets.failure ? [input.targets.failure] : [],
      targetFacts,
      input.latest?.targets,
      input.targets.failure ? null : input.targets.expected,
    ]);
  }
  const sourceOf = new Map([
    [targetsRun, "core-target-routes"],
    [publicationRun, "definition-publication"],
    [deliveryRun, "definition-delivery"],
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
    // Holds and deferrals follow only a complete read of their owning source.
    // Without the roadmap Project's identity no Status is attributable, so nothing changes.
    if (input.issues && !input.issues.failure && input.issues.roadmapProjectId)
      lines.push(
        ...reconsiderationSql({
          source: "issues-project",
          run: issueRun,
          ...issueReconsiderations(input.issues.facts, input.issues.roadmapProjectId),
        }),
      );
    if (input.targets && !input.targets.failure)
      lines.push(
        ...reconsiderationSql({
          source: "core-target-routes",
          run: targetsRun,
          conditions: targetReconsiderations(input.targets.facts),
        }),
      );
  }
  // The two session settings run as their own statements first: the server parses a
  // batched query whole, so a setting inside it could not govern the literals after it.
  // Everything else is one query, so a remote host costs one round trip, not one per statement.
  const [isolation, quoting, ...statements] = lines;
  return `${isolation}\n${quoting}\n${batchedStatements(statements)}`;
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

/** One source's per-subject or whole-source gap. */
export interface SourceGap {
  subject_key: string;
  code: string;
  message: string;
}

/** A source read as a typed outcome, so one source's failure cannot discard another's facts. */
async function sourceOutcome<T>(
  read: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

const failedSource = (subject_key: string, message: string): SourceGap => ({
  subject_key,
  code: "unavailable",
  message: `The source could not be read completely; prior facts stay current. ${message}`.slice(
    0,
    1000,
  ),
});

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
  /** With `all`, also read what the appointed definition location serves, verified by Core. */
  delivery?: boolean | ((cli: string) => Promise<DefinitionDeliveryInspection>) | undefined;
  /**
   * `changed` (with `all` and `targets`) reuses subjects whose Core semantics and
   * catalog fact are unchanged since a recent full read; `full` (default) reads all.
   */
  reassess?: "full" | "changed" | undefined;
  /** With `all`, also collect Core's per-target route offering for the collected ports. */
  targets?:
    | boolean
    | ((
        cli: string,
        ids: readonly string[],
      ) => Promise<{ facts: ReadonlyMap<string, unknown>; producer: CoreProducer | null }>)
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
  const apiSchema = capabilities.schema_version;
  const coreSourceClean =
    git(["status", "--porcelain", "--", "crates", "Cargo.toml", "Cargo.lock"]).trim() === "";
  const platform = options.platform ?? hostPlatform();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(platform))
    throw new MaintenanceStoreError("Invalid platform label");
  // Freshness is the database's order of this ticket, never this runner's clock.
  const acquisition = acquireCollection(options.environment);
  const startedAt = new Date().toISOString();
  if (options.targets && !options.all)
    throw new MaintenanceStoreError("Target-route collection requires --all");
  // Read first: the producer identity keys any reuse of Core results.
  const targetsRead = options.targets
    ? await sourceOutcome(() =>
        (typeof options.targets === "function" ? options.targets : readTargetRoutes)(
          options.cli,
          ids,
        ),
      )
    : undefined;
  const requested = options.reassess ?? "full";
  if (requested === "changed" && (!options.all || !options.targets))
    throw new MaintenanceStoreError("--reassess changed requires --all and --targets");
  const authored = ids.map((id) => ({
    id,
    record: committedRecord(revision, id),
    operational: definitions.ids.has(id),
    qualification: definitions.qualification.filter((record) => record.scope?.port_id === id),
  }));
  const producer = targetsRead?.ok ? targetsRead.value.producer : null;
  const bindingVerified =
    producer?.source_revision === revision &&
    coreSourceClean &&
    !producer.catalog_override &&
    producer.features.length === 0;
  const reuseKey =
    producer && bindingVerified
      ? coreReuseKey({
          trees: Object.fromEntries(
            coreSemanticPaths.map((entry) => {
              const object = spawnSync(
                "git",
                ["rev-parse", "--verify", "--quiet", `${revision}:${entry}`],
                {
                  cwd: repositoryRoot,
                  encoding: "utf8",
                },
              );
              return [entry, object.status === 0 ? object.stdout.trim() : "absent"];
            }),
          ),
          producer,
          apiSchema,
          platform,
        })
      : null;
  const coreSource = coreSourceName(platform);
  const decidedBaseline =
    requested === "changed"
      ? {
          catalog: latestMembers(options.environment, "catalog-records"),
          core: latestMembers(options.environment, coreSource),
        }
      : undefined;
  const plan = planReassessment({
    requested,
    reuseKey,
    history:
      reuseKey === null || requested === "full"
        ? null
        : reuseHistory(options.environment, coreSource, reuseKey),
    now: new Date(),
    clockCrossed: (afterSeconds) =>
      clockWindowCrossed(
        ["catalog.json", "listings.json"].map((file): unknown =>
          JSON.parse(git(["show", `${revision}:crates/portcove-core/catalog/${file}`])),
        ),
        afterSeconds,
        Math.floor(Date.now() / 1000),
      ),
    subjects: authored.map((subject) => ({
      key: `port:${subject.id}`,
      catalogDigest: sha256(canonicalJson(catalogFactOf(subject))),
    })),
    catalogMembers: decidedBaseline?.catalog.members ?? new Map(),
    coreMembers: decidedBaseline?.core.members ?? new Map(),
  });
  const subjects: CollectedSubject[] = await mapBounded(
    authored,
    options.concurrency ?? 4,
    async (subject) => ({
      ...subject,
      capabilities: plan.reused.has(`port:${subject.id}`)
        ? null
        : await coreCapabilities(options.cli, subject.id),
    }),
  );
  const mode = options.all ? "all" : "sample";
  if (options.issues && !options.all)
    throw new MaintenanceStoreError("Issue collection requires --all");
  // Each source fails alone: its run records the gap and every other source still lands.
  const issueRead = options.issues ? await sourceOutcome(options.issues) : undefined;
  const issueInventory = issueRead?.ok ? issueRead.value : undefined;
  if (options.releaseHealth && !options.all)
    throw new MaintenanceStoreError("Release-health collection requires --all");
  const healthRead = options.releaseHealth
    ? await sourceOutcome(async () => {
        const report = await options.releaseHealth!();
        return { revision: report.revision, ...releaseHealthFacts(report.report) };
      })
    : undefined;
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
  const publicationRead = options.publication
    ? await sourceOutcome(() =>
        (typeof options.publication === "function" ? options.publication : readPublication)(
          options.cli,
          revision,
        ),
      )
    : undefined;
  if (options.delivery && !options.all)
    throw new MaintenanceStoreError("Definition-delivery collection requires --all");
  const deliveryRead = options.delivery
    ? await sourceOutcome(async () => {
        const inspection = await (
          typeof options.delivery === "function" ? options.delivery : readDefinitionDelivery
        )(options.cli);
        return { location: inspection.metadata_base_url, ...deliveryFacts(inspection) };
      })
    : undefined;
  const record = (baseline?: Map<string, SourceBaseline>) => {
    const members = (source: string) => baseline?.get(source)?.members ?? new Map<string, string>();
    return collectionSql({
      mode,
      acquisition,
      revision,
      cliSha256,
      apiSchema,
      runner: options.runner ?? process.env.PORTCOVE_MAINTENANCE_RUNNER?.trim() ?? "generic",
      startedAt,
      platform,
      subjects,
      reassessment: plan.reassessment,
      ...(issueRead
        ? {
            issues: issueRead.ok
              ? {
                  repository: issueRead.value.repository,
                  observedAt: issueRead.value.observed_at,
                  facts: issueFacts(issueRead.value),
                  roadmapProjectId: issueRead.value.roadmap_project_id,
                }
              : {
                  repository: "",
                  observedAt: "",
                  facts: new Map(),
                  failure: failedSource("source:issues-project", issueRead.message),
                },
          }
        : {}),
      ...(healthRead
        ? {
            releaseHealth: healthRead.ok
              ? healthRead.value
              : {
                  revision: "release-health:unavailable",
                  failed: true,
                  expected: null,
                  facts: new Map(),
                  gaps: [failedSource("source:release-health-report", healthRead.message)],
                },
          }
        : {}),
      ...(upstream ? { upstream } : {}),
      ...(hostedIntake ? { hostedIntake } : {}),
      ...(targetsRead?.ok ? { producer: targetsRead.value.producer, coreSourceClean } : {}),
      ...(targetsRead
        ? {
            targets: targetsRead.ok
              ? { facts: targetsRead.value.facts, expected: targetsRead.value.facts.size }
              : {
                  facts: new Map(),
                  expected: 0,
                  failure: failedSource("source:core-target-routes", targetsRead.message),
                },
          }
        : {}),
      ...(publicationRead
        ? {
            publication: publicationRead.ok
              ? {
                  revision,
                  ...publicationFacts(publicationRead.value),
                }
              : {
                  revision: `${revision}+inspection:unavailable`,
                  facts: new Map(),
                  expected: null,
                  gaps: [failedSource("source:definition-publication", publicationRead.message)],
                },
          }
        : {}),
      ...(deliveryRead
        ? {
            delivery: deliveryRead.ok
              ? deliveryRead.value
              : {
                  revision: "definition-delivery;inspection=unavailable",
                  location: null,
                  facts: new Map(),
                  expected: null,
                  gaps: [failedSource("source:definition-delivery", deliveryRead.message)],
                },
          }
        : {}),
      ...(baseline
        ? {
            baseline: Object.fromEntries([...baseline].map(([source, { run }]) => [source, run])),
            latest: {
              catalog: members("catalog-records"),
              core: members(coreSourceName(platform)),
              ...(issueRead ? { issues: members("issues-project") } : {}),
              ...(healthRead ? { releaseHealth: members("release-health") } : {}),
              ...(upstream ? { upstream: members("upstream-observations") } : {}),
              ...(hostedIntake ? { hostedIntake: members("hosted-intake") } : {}),
              ...(publicationRead ? { publication: members("definition-publication") } : {}),
              ...(deliveryRead ? { delivery: members("definition-delivery") } : {}),
              ...(targetsRead ? { targets: members("core-target-routes") } : {}),
            },
          }
        : {}),
    });
  };
  const sources = [
    "catalog-records",
    coreSourceName(platform),
    ...(issueRead ? ["issues-project"] : []),
    ...(healthRead ? ["release-health"] : []),
    ...(upstream ? ["upstream-observations"] : []),
    ...(hostedIntake ? ["hosted-intake"] : []),
    ...(publicationRead ? ["definition-publication"] : []),
    ...(deliveryRead ? ["definition-delivery"] : []),
    ...(targetsRead ? ["core-target-routes"] : []),
  ];
  // A changes-only diff is exact only against the baseline the store still holds;
  // if another run finished meanwhile, reread it. External reads are not repeated.
  for (let attempt = 1; ; attempt++) {
    const baseline =
      mode === "all"
        ? new Map(sources.map((source) => [source, latestMembers(options.environment, source)]))
        : undefined;
    // Reuse was decided against these baselines; another run in between voids it.
    if (
      plan.reused.size &&
      (baseline?.get("catalog-records")?.run !== decidedBaseline?.catalog.run ||
        baseline?.get(coreSource)?.run !== decidedBaseline?.core.run)
    )
      throw new MaintenanceStoreError(
        "A newer maintenance collection finished while reuse was being decided; this one replaced nothing. Rerun.",
      );
    try {
      runSql(options.environment, record(baseline), { timeoutMs: collectionTimeoutMs });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (staleCollectionPattern.test(message))
        throw new MaintenanceStoreError(
          `A newer maintenance collection finished first; this one replaced nothing. ${message.slice(0, 1000)}`,
        );
      if (attempt < 3 && baselineChangedPattern.test(message)) continue;
      throw error;
    }
  }
  return {
    mode,
    revision,
    reassessment: {
      requested,
      mode: plan.reassessment.mode,
      reuse_key: plan.reassessment.reuseKey,
      reused: plan.reused.size,
      reason: plan.reason,
    },
    cli_sha256: cliSha256,
    subjects: subjects.length,
    issues: issueInventory?.issues.length ?? null,
    /** Sources whose read failed alone; their runs record the gap and prior facts stay current. */
    failed_sources: [
      ...(issueRead && !issueRead.ok ? ["issues-project"] : []),
      ...(healthRead && !healthRead.ok ? ["release-health"] : []),
      ...(upstream?.failed ? ["upstream-observations"] : []),
      ...(hostedIntake?.failed ? ["hosted-intake"] : []),
      ...(publicationRead && !publicationRead.ok ? ["definition-publication"] : []),
      ...(deliveryRead && !deliveryRead.ok ? ["definition-delivery"] : []),
      ...(targetsRead && !targetsRead.ok ? ["core-target-routes"] : []),
    ],
    /** What the appointed location served this time; not served or an outage erases nothing. */
    delivery: deliveryRead?.ok
      ? {
          serving: deliveryRead.value.gaps[0]?.code ?? "verified",
          published: deliveryRead.value.facts.size,
        }
      : deliveryRead
        ? { serving: "inspection-unavailable", published: 0 }
        : null,
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
      ({ capabilities: fact }) =>
        fact !== null && !fact.ok && !subjectScopedRefusals.has(fact.error?.code ?? ""),
    ).length,
  };
}

const corePrefix = "core-port-capabilities-";

const reportQuery = `WITH latest_issue AS (
    SELECT DISTINCT ON (o.subject_key) o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'issues-project' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.acquisition DESC, o.observation_id DESC
  ), present_issue AS (
    SELECT payload FROM latest_issue WHERE payload <> portcove_maintenance.absent_payload()
  ), latest_health AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'release-health' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.acquisition DESC, o.observation_id DESC
  ), latest_upstream AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'upstream-observations' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.acquisition DESC, o.observation_id DESC
  ), latest_targets AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'core-target-routes' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.acquisition DESC, o.observation_id DESC
  ), latest_hosted AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'hosted-intake' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.acquisition DESC, o.observation_id DESC
  ), latest_catalog AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      WHERE r.source = 'catalog-records' AND r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.acquisition DESC, o.observation_id DESC
  ), core_latest AS (
    -- The latest finished Core run of each host platform.
    SELECT DISTINCT ON (source) source, substring(source FROM ${corePrefix.length + 1}) AS platform,
           run_id, member_digest, gaps
      FROM portcove_maintenance.collection_runs
      WHERE source LIKE '${corePrefix}%' AND coverage <> 'in_progress'
      ORDER BY source, acquisition DESC
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
              ORDER BY acquisition DESC LIMIT 1) hr
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
              ORDER BY o.subject_key, r.acquisition DESC, o.observation_id DESC) p
      WHERE p.payload <> portcove_maintenance.absent_payload()),
  -- Last verified publication only: a run that did not verify records no facts.
  -- A withdrawal (absent after a verified read) stays visible as such.
  'delivery', (SELECT coalesce(json_agg(json_build_object('definition', d.subject_key, 'facts', d.payload)
        ORDER BY d.subject_key), '[]')
      FROM (SELECT DISTINCT ON (o.subject_key) o.subject_key, o.payload
              FROM portcove_maintenance.observations o
              JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
              WHERE r.source = 'definition-delivery' AND r.coverage = 'complete'
              ORDER BY o.subject_key, r.acquisition DESC, o.observation_id DESC) d),
  'delivery_verified', (SELECT json_build_object('run_id', run_id, 'source_revision', source_revision,
        'completed_at', completed_at)
      FROM portcove_maintenance.collection_runs
      WHERE source = 'definition-delivery' AND coverage = 'complete'
      ORDER BY acquisition DESC LIMIT 1),
  'universe_inputs', json_build_object(
    'records', (SELECT coalesce(json_agg(lc.payload -> 'authored_record' ORDER BY lc.subject_key), '[]')
                  FROM latest_catalog lc
                 WHERE lc.payload <> portcove_maintenance.absent_payload()
                   AND jsonb_typeof(lc.payload -> 'authored_record') = 'object'),
    'issues', (SELECT coalesce(json_object_agg('issue:' || (i.payload ->> 'number'), i.payload), '{}')
                 FROM present_issue i),
    'intake', (SELECT coalesce(json_object_agg(h.subject_key, h.payload), '{}')
                 FROM latest_hosted h WHERE h.payload <> portcove_maintenance.absent_payload())),
  -- Every pending condition, and the most recent resolutions as history.
  'reconsiderations', (SELECT coalesce(json_agg(x ORDER BY x.status <> 'pending', x.resolved_at DESC NULLS FIRST, x.reconsideration_id), '[]')
      FROM (SELECT reconsideration_id, subject_key, kind, status, revisit_authority, condition, created_at,
                   resolved_at, resolution
              FROM portcove_maintenance.reconsiderations
             WHERE status = 'pending'
            UNION ALL
            (SELECT reconsideration_id, subject_key, kind, status, revisit_authority, condition, created_at,
                    resolved_at, resolution
               FROM portcove_maintenance.reconsiderations
              WHERE status <> 'pending' ORDER BY resolved_at DESC LIMIT 200)) x),
  -- Per source: the latest attempt and the latest read that did not fail.
  -- A serving observation (verified, or a typed not-served, incomplete or expired
  -- result) observes the source; an outage or a failed tool does not.
  'freshness', (SELECT coalesce(json_agg(json_build_object('source', f.source, 'attempted_at', f.attempted_at,
        'last_good_at', f.last_good_at, 'observed_at', f.observed_at) ORDER BY f.source), '[]')
      FROM (SELECT source, max(completed_at) AS attempted_at,
                   max(completed_at) FILTER (WHERE coverage IN ('complete', 'partial')) AS last_good_at,
                   max(completed_at) FILTER (WHERE coverage IN ('complete', 'partial')
                     OR (coverage = 'failed' AND gaps -> 0 ->> 'code' IN ('not_served', 'incomplete', 'expired')))
                     AS observed_at
              FROM portcove_maintenance.collection_runs
             WHERE coverage <> 'in_progress' GROUP BY source) f),
  'generation', (SELECT coalesce(max(acquisition), 0) FROM portcove_maintenance.collection_runs
      WHERE coverage <> 'in_progress'),
  'runs', (SELECT coalesce(json_agg(r ORDER BY r.source, r.acquisition DESC), '[]') FROM (
      SELECT DISTINCT ON (source) source, run_id, runner, source_revision, started_at, acquisition, completed_at, coverage,
             reassessment, reused_count,
             expected_count, observed_count, gaps, member_count, member_digest
        FROM portcove_maintenance.collection_runs WHERE coverage <> 'in_progress' ORDER BY source, acquisition DESC) r),
  'unassessed_gaps', (SELECT coalesce(json_agg(json_build_object('subject_key', g.subject_key || '@' || g.platform,
        'port_key', g.subject_key, 'platform', g.platform, 'code', g.code, 'message', g.message)
        ORDER BY g.platform, g.subject_key), '[]')
      FROM core_gap g
      WHERE NOT EXISTS (SELECT 1 FROM assessed a WHERE a.port_key = g.subject_key AND a.platform = g.platform)),
  'subjects', (SELECT coalesce(json_agg(s ORDER BY s.subject_key), '[]') FROM (
      SELECT c.subject_key, c.port_key, c.platform, c.sequence, a.state, a.policy_version, a.input_digest,
        a.assessed_at, a.explanation,
        -- Last material transition, separate from the latest applicable assessment and verification.
        c.updated_at AS changed_at, c.updated_at, c.assessment_id AS transition_assessment_id,
        c.applicable_assessment_id AS assessment_id, c.verified_at, c.verified_run_id,
        -- The binary, source and binding of the run that last verified this subject.
        (SELECT r.source_revision FROM portcove_maintenance.collection_runs r
          WHERE r.run_id = c.verified_run_id) AS verified_by,
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
                   ORDER BY r.source, r.acquisition DESC, ob.observation_id DESC) o) AS observations,
        EXISTS (SELECT 1 FROM core_member m WHERE m.platform = c.platform AND m.subject_key = c.port_key)
          AS in_latest_core_run,
        (SELECT json_build_object('code', g.code, 'message', g.message) FROM core_gap g
          WHERE g.platform = c.platform AND g.subject_key = c.port_key LIMIT 1) AS latest_core_gap,
        lc.payload = portcove_maintenance.absent_payload() AS removed,
        (SELECT CASE WHEN h.payload = portcove_maintenance.absent_payload() THEN NULL ELSE h.payload END
           FROM latest_health h WHERE h.subject_key = c.port_key) AS release_health,
        (SELECT g ->> 'code' FROM (
            SELECT gaps FROM portcove_maintenance.collection_runs
              WHERE source = 'release-health' AND coverage NOT IN ('in_progress', 'failed')
              ORDER BY acquisition DESC LIMIT 1) hr
           CROSS JOIN LATERAL jsonb_array_elements(hr.gaps) g
           WHERE g ->> 'subject_key' = c.port_key LIMIT 1) AS latest_health_gap,
        (SELECT CASE WHEN u.payload = portcove_maintenance.absent_payload() THEN NULL ELSE u.payload END
           FROM latest_upstream u WHERE u.subject_key = c.port_key) AS upstream,
        (SELECT CASE WHEN t.payload = portcove_maintenance.absent_payload() THEN NULL ELSE t.payload END
           FROM latest_targets t WHERE t.subject_key = c.port_key) AS target_routes,
        (SELECT g FROM (
            SELECT gaps FROM portcove_maintenance.collection_runs
              WHERE source = 'upstream-observations' AND coverage NOT IN ('in_progress', 'failed')
              ORDER BY acquisition DESC LIMIT 1) ur
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
        JOIN portcove_maintenance.assessments a ON a.assessment_id = c.applicable_assessment_id
        LEFT JOIN latest_catalog lc ON lc.subject_key = c.port_key) s)
);`;

export interface InventoryReport {
  format: "portcove-maintenance-inventory";
  format_version: typeof inventoryFormatVersion;
  generated_at: string;
  /**
   * The newest finished collection acquisition the report reflects. A report
   * never replaces one with a greater generation, whatever the clocks say.
   */
  generation: number;
  scope: "declared-sample" | "complete-authored-catalog";
  /**
   * Every known game and implementation from canonical identities, with their
   * relationships as edges. Absent from reports made before #4129's universe.
   */
  universe?: UniverseEntry[];
  publication: {
    status: "unknown" | "observed";
    reason: string;
    /** What the appointed location served at the latest read, separate from what was last verified. */
    serving?: PublicationServing | null;
    definitions?: PublicationEntry[];
  };
  unsupported_sources: { source: string; reason: string }[];
  runs: unknown[];
  /** Per source: when it was last attempted and last read successfully, aged against this report. */
  freshness?: SourceFreshness[];
  subjects: unknown[];
  unassessed_gaps?: { subject_key: string; code: string; message: string }[];
  /** Latest facts per `intake:<request>`, with linked issues joined to issue facts. */
  hosted_intake?: HostedIntakeEntry[];
  /** Open executor handoffs with their registry entry and newest open operation; dispatch is disabled. */
  handoffs?: OpenHandoff[];
  /** Pending holds and deferrals with their revisit authority, then the latest resolutions. */
  reconsiderations?: ReconsiderationEntry[];
}

export interface ReconsiderationEntry {
  reconsideration_id: string;
  subject_key: string;
  kind: string;
  status: "pending" | "satisfied" | "withdrawn";
  revisit_authority: string;
  condition: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  resolution: Record<string, unknown> | null;
  /**
   * For a pending deferral: linked port assessments that changed since it was
   * recorded. Shown for its authority to reconsider; never applied automatically.
   */
  technical_changes?: { subject_key: string; state: string; changed_at: string }[];
}

/** Adds, to each pending deferral, the linked assessments that changed after it. */
export function deferralChanges(
  entries: readonly ReconsiderationEntry[],
  subjects: readonly {
    subject_key: string;
    state?: string;
    changed_at?: string;
    work?: { number?: number }[];
  }[],
): ReconsiderationEntry[] {
  return entries.map((entry) => {
    const issue = /^issue:([1-9][0-9]*)$/u.exec(entry.subject_key)?.[1];
    if (entry.kind !== "intentional_deferral" || entry.status !== "pending" || !issue) return entry;
    const since = Date.parse(entry.created_at);
    return {
      ...entry,
      technical_changes: subjects
        .filter(
          (subject) =>
            (subject.work ?? []).some(({ number }) => String(number) === issue) &&
            typeof subject.changed_at === "string" &&
            Date.parse(subject.changed_at) > since,
        )
        .map(({ subject_key, state, changed_at }) => ({
          subject_key,
          state: state ?? "unknown",
          changed_at: changed_at!,
        })),
    };
  });
}

/**
 * What a subject's Core assessment depends on and what would reassess it.
 * Every complete run re-reads Core for every port, but only a change in one of
 * these inputs records a new assessment; only a changed result records a
 * transition. A rebuild with the same output, a failed run, or a port Core
 * could not read in a partial run records neither.
 */
export const reassessmentTriggers = [
  "its catalog fact changes (authored record, operational definition or scoped qualification at the pinned revision)",
  "Core's output for the port changes (embedded catalog and listings, Core code, catalog-wide hold policy, or clock-dated recommendation observations)",
  "the assessment policy changes (Core API schema or projection version)",
] as const;

export interface SubjectReassessment {
  depends_on: string[];
  /** When the catalog fact last changed: its latest changes-only observation. */
  catalog_changed_at: string | null;
  /** When Core's output for this port and platform last changed. */
  core_output_changed_at: string | null;
  /**
   * The latest of the catalog change, the Core output change and the
   * assessment time. Assessments are deduplicated by input, so after inputs
   * return to an earlier value the assessment time alone would be too early.
   */
  inputs_unchanged_since: string | null;
  /** The latest Core run that re-read the subject and found the same inputs. */
  last_verified_at: string | null;
}

/** Derives a subject's reassessment basis from its stored provenance and observations. */
export function subjectReassessment(subject: {
  platform?: string | null;
  assessed_at?: string | null;
  verified_at?: string | null;
  observations?: { source: string; observed_at: string }[] | null;
}): SubjectReassessment {
  const observed = (source: string) =>
    (subject.observations ?? []).find((observation) => observation.source === source)
      ?.observed_at ?? null;
  const core = subject.platform ? coreSourceName(subject.platform) : null;
  return {
    depends_on: ["catalog-records", ...(core ? [core] : []), "assessment policy"],
    catalog_changed_at: observed("catalog-records"),
    core_output_changed_at: core ? observed(core) : null,
    inputs_unchanged_since:
      [observed("catalog-records"), core ? observed(core) : null, subject.assessed_at ?? null]
        .filter(
          (value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)),
        )
        .sort((left, right) => Date.parse(left) - Date.parse(right))
        .at(-1) ?? null,
    last_verified_at: subject.verified_at ?? null,
  };
}

/** A source older than this, relative to the report, is flagged stale (the schedule is daily). */
export const staleSourceHours = 36;

/**
 * Sources whose only good read is a verified one: any other outcome (such as
 * nothing served yet) is recorded as a failed run with its reason. Their
 * freshness is their latest serving observation (verified, not served,
 * incomplete or expired); an outage or failed tool is not one. The source's own
 * section shows what was last verified.
 */
const verifiedOnlySources = new Set(["definition-delivery"]);

export interface SourceFreshness {
  source: string;
  attempted_at: string | null;
  /** The latest complete or partial read; failed reads never refresh it. */
  last_good_at: string | null;
  /** Hours from the last good read to this report's generation; null when never read. */
  age_hours: number | null;
  /** The latest typed serving observation, for verified-only sources. */
  observed_at: string | null;
  /** Hours from that observation to this report's generation. */
  observation_age_hours: number | null;
  /** Only a verified read counts as good; freshness is the latest serving observation. */
  verified_only: boolean;
  stale: boolean;
}

/** Ages each source's last good read against the report's own generation time. */
export function sourceFreshness(
  rows: readonly {
    source: string;
    attempted_at: string | null;
    last_good_at: string | null;
    observed_at?: string | null;
  }[],
  generatedAt: Date,
): SourceFreshness[] {
  const hours = (value: string | null) => {
    const time = value === null ? Number.NaN : Date.parse(value);
    return Number.isFinite(time)
      ? Math.max(0, Math.round(((generatedAt.getTime() - time) / 3_600_000) * 10) / 10)
      : null;
  };
  return rows.map(({ source, attempted_at, last_good_at, observed_at = null }) => {
    const age_hours = hours(last_good_at);
    const observation_age_hours = hours(observed_at);
    const verified_only = verifiedOnlySources.has(source);
    const freshest = verified_only ? observation_age_hours : age_hours;
    return {
      source,
      attempted_at,
      last_good_at,
      age_hours,
      observed_at,
      observation_age_hours,
      verified_only,
      stale: freshest === null || freshest > staleSourceHours,
    };
  });
}

export interface PublicationServing {
  /** `verified`, or why the latest read did not verify (not served, unreachable, ...). */
  status: string;
  observed_at: string | null;
  /** The latest run that verified the appointed location, if any ever did. */
  last_verified_at: string | null;
  last_verified_revision: string | null;
}

export interface PublicationEntry {
  definition: string;
  /** Main facts (`{ main }`) from the committed bundle, when observed. */
  facts: unknown;
  /** Last verified published facts; never cleared by a failed or unserved read. */
  published: unknown;
  comparison:
    | "published-matches-main"
    | "published-differs-from-main"
    | "never-verified-published"
    | "published-withdrawn"
    | "published-not-on-main"
    | "main-unobserved";
}

const revisionLabel = (value: unknown) =>
  typeof value === "number" || typeof value === "string" ? String(value) : "none";

type MainDefinition = { main?: { revision?: unknown; definition_target?: unknown } };
type PublishedDefinitionFact = { published?: { revision?: unknown; target?: unknown } };

/** Joins main and last verified publication per definition; titles never join. */
export function publicationEntries(
  main: readonly { definition: string; facts: unknown }[],
  published: readonly { definition: string; facts: unknown }[],
  mainObserved: boolean,
): PublicationEntry[] {
  const mainByKey = new Map(main.map(({ definition, facts }) => [definition, facts]));
  const publishedByKey = new Map(published.map(({ definition, facts }) => [definition, facts]));
  const withdrawn = (facts: unknown) =>
    (facts as { absent?: unknown } | undefined)?.absent === true;
  const entries: PublicationEntry[] = [];
  for (const definition of [...new Set([...mainByKey.keys(), ...publishedByKey.keys()])].sort()) {
    const onMain = mainByKey.get(definition) as MainDefinition | undefined;
    const servedFacts = publishedByKey.get(definition);
    // Gone from main and withdrawn from the location: nothing left to compare.
    if (!onMain && withdrawn(servedFacts)) continue;
    const served = withdrawn(servedFacts)
      ? undefined
      : (servedFacts as PublishedDefinitionFact | undefined);
    const comparison: PublicationEntry["comparison"] = !onMain
      ? mainObserved
        ? "published-not-on-main"
        : "main-unobserved"
      : withdrawn(servedFacts)
        ? "published-withdrawn"
        : !served
          ? "never-verified-published"
          : onMain.main?.revision === served.published?.revision &&
              onMain.main?.definition_target === served.published?.target
            ? "published-matches-main"
            : "published-differs-from-main";
    entries.push({ definition, facts: onMain ?? null, published: served ?? null, comparison });
  }
  return entries;
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
    generation: number;
    universe_inputs: {
      records: Parameters<typeof buildUniverse>[0]["records"];
      issues: Record<string, unknown>;
      intake: Record<string, unknown>;
    };
    runs: unknown[];
    freshness: {
      source: string;
      attempted_at: string | null;
      last_good_at: string | null;
      observed_at: string | null;
    }[];
    subjects: unknown[];
    unassessed_gaps: { subject_key: string; code: string; message: string }[];
    publication: { definition: string; facts: unknown }[];
    delivery: { definition: string; facts: unknown }[];
    delivery_verified: { run_id: string; source_revision: string; completed_at: string } | null;
    hosted_intake: HostedIntakeEntry[];
    handoffs: unknown;
    reconsiderations: ReconsiderationEntry[];
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
  // Once read, the source is observed: a later failed read shows as that run's gap,
  // while the last verified facts stay current.
  const issuesObserved = (data.runs as { source: string; coverage: string }[]).some(
    ({ source }) => source === "issues-project",
  );
  const latestRun = (source: string) =>
    (
      data.runs as {
        source: string;
        coverage: string;
        completed_at: string | null;
        gaps?: { code: string }[];
      }[]
    ).find((run) => run.source === source);
  // A failed bundle read keeps the last main facts current; the reason names that read.
  const latestPublicationRun = latestRun("definition-publication");
  const latestDeliveryRun = latestRun("definition-delivery");
  // A complete run that found no committed definitions is an observation, not an unknown.
  const mainObserved = !!(data.publication.length || latestPublicationRun?.coverage === "complete");
  const serving: PublicationServing | null = latestDeliveryRun
    ? {
        status:
          latestDeliveryRun.coverage === "complete"
            ? "verified"
            : (latestDeliveryRun.gaps?.map(({ code }) => code).join(", ") ?? "unknown"),
        observed_at: latestDeliveryRun.completed_at,
        last_verified_at: data.delivery_verified?.completed_at ?? null,
        last_verified_revision: data.delivery_verified?.source_revision ?? null,
      }
    : null;
  const publication = publicationEntries(data.publication, data.delivery, mainObserved);
  const mainNote =
    latestPublicationRun && latestPublicationRun.coverage !== "complete"
      ? ` (latest main read failed: ${latestPublicationRun.gaps?.map(({ code }) => code).join(", ") ?? "unknown"})`
      : "";
  const servingNote = serving
    ? `; appointed location at the latest read: ${serving.status}${
        serving.last_verified_at
          ? `, last verified ${serving.last_verified_at}`
          : ", never verified"
      }`
    : "; appointed location not read";
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
    generation: data.generation,
    scope: catalogScope,
    universe: buildUniverse({
      records: data.universe_inputs.records,
      issues: new Map(Object.entries(data.universe_inputs.issues)),
      intake: new Map(Object.entries(data.universe_inputs.intake)),
      definitions: publication.map(({ definition }) => definition),
      catalogComplete: catalogScope === "complete-authored-catalog",
    }),
    publication:
      mainObserved || serving
        ? {
            status: "observed",
            reason:
              (publication.length
                ? publication
                    .map(({ definition, facts, published, comparison }) => {
                      const main = (facts as MainDefinition | null)?.main;
                      const served = (published as PublishedDefinitionFact | null)?.published;
                      return `${definition}: ${comparison} (main revision ${revisionLabel(main?.revision)}, last verified published revision ${revisionLabel(served?.revision)})`;
                    })
                    .join("; ")
                : mainObserved
                  ? "observed: no committed definitions"
                  : "main not observed") +
              mainNote +
              servingNote,
            serving,
            definitions: publication,
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
      .filter(([source]) => !(mainObserved && source === "definition-publication"))
      .filter(([source]) => !(serving && source === "definition-delivery"))
      .map(([source, reason]) => ({ source, reason })),
    runs: data.runs,
    freshness: sourceFreshness(data.freshness, now),
    subjects: subjects.map((subject) => {
      const target = subject.identity?.target_key;
      return {
        ...subject,
        reassessment: subjectReassessment(subject as Parameters<typeof subjectReassessment>[0]),
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
    reconsiderations: deferralChanges(
      data.reconsiderations,
      data.subjects as Parameters<typeof deferralChanges>[1],
    ),
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
function sourceAge(report: InventoryReport, source: string) {
  const entry = report.freshness?.find((value) => value.source === source);
  if (!entry) return "";
  if (entry.verified_only) {
    const observed =
      entry.observation_age_hours === null
        ? "no serving observation yet"
        : `latest serving observation ${entry.observation_age_hours} h ago`;
    const verified =
      entry.age_hours === null ? "no verified read yet" : `last verified ${entry.age_hours} h ago`;
    return `<span${entry.stale ? ' class="unknown"' : ""}>${escapeHtml(`${verified}; ${observed}`)}${entry.stale ? " (stale)" : ""}</span>`;
  }
  if (entry.age_hours === null) return '<span class="unknown">never read successfully</span>';
  const age = `${entry.age_hours} h`;
  return entry.stale ? `<span class="unknown">${escapeHtml(age)} (stale)</span>` : escapeHtml(age);
}

/** Report and data age: when this report was made, and the oldest last good source read. */
function freshnessSummary(report: InventoryReport) {
  const entries = report.freshness ?? [];
  if (!entries.length) return "";
  const stale = entries.filter(({ stale: value }) => value).map(({ source }) => source);
  const ages = entries.flatMap(({ age_hours, verified_only }) =>
    verified_only || age_hours === null ? [] : [age_hours],
  );
  const oldest = ages.length ? Math.max(...ages) : null;
  return `<p>Data age: the oldest last good source read (excluding verified-only sources such as definition-delivery, aged by their serving observation) is ${
    oldest === null ? "unknown" : escapeHtml(`${oldest} h`)
  } before this report. ${
    stale.length
      ? `<span class="unknown">Stale (over ${staleSourceHours} h, or never read): ${escapeHtml(stale.join(", "))}.</span> Their last known facts stay current.`
      : `Every source was read within ${staleSourceHours} h.`
  }</p>`;
}

function publicationSection(report: InventoryReport) {
  const serving = report.publication.serving;
  const definitions = report.publication.definitions ?? [];
  if (!serving && !definitions.length) return "";
  const target = (value: unknown, field: "main" | "published") => {
    const facts = (value as Record<string, Record<string, unknown>> | null)?.[field];
    if (!facts) return "none";
    return `revision ${escapeHtml(revisionLabel(facts.revision))} <code>${escapeHtml(field === "main" ? facts.definition_target : facts.target)}</code>`;
  };
  return `<h2>Definition publication</h2>
<p>Main is what the repository commits; published is the last content Core verified at the appointed location as a client would. ${
    serving
      ? `Latest read: <span class="${serving.status === "verified" ? "" : "unknown"}">${escapeHtml(serving.status)}</span> at ${escapeHtml(serving.observed_at ?? "unknown")}; last verified: ${escapeHtml(serving.last_verified_at ?? "never")}. A read that did not verify changes nothing published.`
      : "The appointed location has not been read."
  }</p>
<table><thead><tr><th>Definition</th><th>Comparison</th><th>Main</th><th>Last verified published</th></tr></thead><tbody>
${definitions
  .map(
    (entry) =>
      `<tr><td>${escapeHtml(entry.definition)}</td><td>${escapeHtml(entry.comparison)}</td><td>${target(entry.facts, "main")}</td><td>${target(entry.published, "published")}</td></tr>`,
  )
  .join("\n")}
</tbody></table>`;
}

function reconsiderationSection(report: InventoryReport) {
  const entries = report.reconsiderations ?? [];
  if (!entries.length) return "";
  const condition = (entry: ReconsiderationEntry) => {
    const value = entry.condition;
    const resume =
      typeof value.resume_condition === "string"
        ? `Resume condition: ${value.resume_condition}`
        : value.source === "issues-project"
          ? "No explicit resume condition recorded on the issue."
          : "";
    const hold = typeof value.acquisition_hold === "string" ? value.acquisition_hold : "";
    return [hold, typeof value.blocker === "string" ? `Blocker: ${value.blocker}` : "", resume]
      .filter(Boolean)
      .map(escapeHtml)
      .join("<br>");
  };
  return `<h2>Holds and deferrals</h2>
<p>Recorded by their owners: Project Status Deferred or Blocked on an open issue, and reviewed catalog acquisition holds. Only the named authority reconsiders a deferral; a technical change is shown for that authority and never lifts it.</p>
<table><thead><tr><th>Subject</th><th>Kind</th><th>Status</th><th>Condition</th><th>Revisit authority</th><th>Since</th><th>Technical changes since</th></tr></thead><tbody>
${entries
  .map(
    (entry) =>
      `<tr><td>${escapeHtml(entry.subject_key)}</td><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(entry.status)}${
        entry.resolved_at
          ? ` ${escapeHtml(entry.resolved_at)} (${escapeHtml(entry.resolution?.outcome ?? "")})`
          : ""
      }</td><td>${condition(entry)}</td><td>${escapeHtml(entry.revisit_authority)}</td><td>${escapeHtml(entry.created_at)}</td><td>${
        (entry.technical_changes ?? [])
          .map(
            (change) =>
              `${escapeHtml(change.subject_key)}: ${escapeHtml(change.state)} at ${escapeHtml(change.changed_at)}`,
          )
          .join("<br>") ||
        (entry.kind === "intentional_deferral" && entry.status === "pending" ? "none observed" : "")
      }</td></tr>`,
  )
  .join("\n")}
</tbody></table>`;
}

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

/**
 * Core's per-target offering in words: the managed or external route per
 * platform, the reviewed hold or restriction, and Core's own unknowns.
 */
export function targetSummary(fact: TargetRoutesFact | null | undefined) {
  if (!fact) return null;
  if (fact.presence !== "operational")
    return `${fact.presence.replaceAll("_", " ")}; no route offered`;
  const offered = fact.targets.flatMap(({ platform, routes }) =>
    routes
      .filter(({ offered: yes }) => yes)
      .map(
        ({ action }) =>
          `${action === "install" ? "managed install" : "external registration"} on ${platform}`,
      ),
  );
  return [
    offered.length ? offered.join(", ") : "no route offered on any inspected platform",
    fact.acquisition_hold ? `held: ${fact.acquisition_hold}` : "",
    fact.download_restriction ? `download restricted: ${fact.download_restriction}` : "",
    "trust eligibility and readiness not assessed",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Core's qualification state per target in words. Core decides every state
 * and applicability; this only words them and keeps unknown codes verbatim.
 */
export function qualificationSummary(fact: TargetRoutesFact | null | undefined) {
  if (!fact || fact.presence !== "operational") return null;
  const parts: string[] = [];
  let routeUnrecorded = false;
  for (const { platform, qualification } of fact.targets) {
    if (!qualification) continue;
    const refs = qualification.qualified_refs.join(", ");
    const statement =
      qualification.state === "offered_artifact_qualified"
        ? `qualified for the offered artifact ${refs} on ${platform}`
        : qualification.state === "reviewed_binding_qualified"
          ? `qualified for reviewed release ${refs} on ${platform} only if the provider resolves it`
          : qualification.state === "structural_only"
            ? `structural checks only on ${platform}`
            : qualification.state === "applicable_not_passed"
              ? `evidence recorded for what is offered on ${platform}, none passed`
              : qualification.state === "historical_only"
                ? `historical qualification only on ${platform}`
                : qualification.state === "unqualified"
                  ? ""
                  : `${qualification.state} on ${platform}`;
    if (
      statement &&
      qualification.state !== "historical_only" &&
      qualification.evidence_route === "unrecorded"
    )
      routeUnrecorded = true;
    if (statement) parts.push(statement.replace(/ {2,}/gu, " "));
    if (qualification.known_failure) parts.push(`known failure recorded on ${platform}`);
    if (qualification.legacy_coverage.length)
      parts.push(
        `legacy port-wide coverage (${qualification.legacy_coverage.join(", ")}) on ${platform}, not artifact-bound`,
      );
  }
  if (routeUnrecorded) parts.push("evidence does not record which route it exercised");
  return parts.length ? parts.join("; ") : "no recorded qualification";
}

/**
 * The report page's subject filter, as plain JavaScript source: the page embeds
 * exactly this text, and tests evaluate the same text. It decides only what is
 * shown; every value comes from the report.
 */
export const subjectFilterSource = `function subjectRowText(subject) {
  return [subject.subject_key, subject.name, subject.game, subject.target_key,
    ...(subject.alternatives || []), subject.state, String(subject.sequence ?? ""),
    subject.verified_at, subject.changed_at, subject.latest_core_run,
    ...(subject.work || []), subject.inputs, subject.upstream, subject.offered, subject.qualified,
    subject.latest_health_gap, ...(subject.attention || []), ...(subject.next_actions || []),
    subject.latest_core_gap ? subject.latest_core_gap.code : ""]
    .filter((value) => typeof value === "string" && value).join(" ").toLowerCase();
}
function subjectNeedsAttention(subject) {
  return Boolean((subject.attention || []).length || subject.port_health_gap ||
    (subject.next_actions || []).length || subject.latest_core_gap);
}
function subjectMatches(subject, filters, generatedAt) {
  const text = subjectRowText(subject);
  for (const token of (filters.text || "").toLowerCase().split(/\\s+/u).filter(Boolean))
    if (!text.includes(token)) return false;
  if (filters.platform && !String(subject.subject_key).endsWith("@" + filters.platform)) return false;
  if (filters.state && subject.state !== filters.state) return false;
  if (filters.attention && !subjectNeedsAttention(subject)) return false;
  if (filters.changedWithinDays) {
    const changed = Date.parse(subject.changed_at);
    const since = Date.parse(generatedAt) - filters.changedWithinDays * 86400000;
    if (!(changed >= since)) return false;
  }
  return true;
}`;

/** A self-contained, searchable page; data is embedded as escaped JSON, never as markup. */
export function renderHtml(report: InventoryReport) {
  // The page embeds only what it renders; inventory.json keeps every explanation.
  const upstreamAttempt = failedAttempt(report, "upstream-observations");
  const healthAttempt = failedAttempt(report, "release-health");
  const view = {
    subjects: (report.subjects as Record<string, unknown>[]).map(
      ({
        subject_key,
        port_key,
        state,
        sequence,
        verified_at,
        changed_at,
        latest_core_gap,
        latest_core_run,
        work,
        identity,
        alternatives,
        release_health,
        latest_health_gap,
        upstream,
        latest_upstream_gap,
        target_routes,
        reassessment,
      }) => ({
        inputs: (() => {
          const value = reassessment as SubjectReassessment | undefined;
          if (!value) return null;
          return [
            `catalog fact changed ${value.catalog_changed_at ?? "never observed"}`,
            `Core output changed ${value.core_output_changed_at ?? "never observed"}`,
            `inputs unchanged since ${value.inputs_unchanged_since ?? "never"}`,
          ].join("; ");
        })(),
        offered: targetSummary(target_routes as TargetRoutesFact | null | undefined),
        qualified: qualificationSummary(target_routes as TargetRoutesFact | null | undefined),
        attention: [
          ...(attentionConditions(release_health) as { rule?: string; operation?: string }[]).map(
            ({ rule, operation }) => `${rule ?? "unknown"} (${operation ?? "unknown"})`,
          ),
          ...upstreamAttention(upstream, latest_upstream_gap),
        ],
        // A failed latest read is visible; per-port gaps come from the latest read that did not fail.
        latest_health_gap:
          [
            healthAttempt ? `latest read failed: ${healthAttempt}` : "",
            typeof latest_health_gap === "string"
              ? `${healthAttempt ? "previous read" : "latest read"}: ${latest_health_gap}`
              : "",
          ]
            .filter(Boolean)
            .join("; ") || null,
        next_actions: nextActions(report, port_key, subject_key),
        // A source-wide failed read is shown, but only a per-port gap needs this port's attention.
        port_health_gap: typeof latest_health_gap === "string" ? latest_health_gap : null,
        upstream: upstreamSummary(upstream, latest_upstream_gap, upstreamAttempt),
        subject_key,
        name: (identity as { name?: string } | undefined)?.name ?? null,
        game: (identity as { game?: string } | undefined)?.game ?? null,
        target_key: (identity as { target_key?: string } | undefined)?.target_key ?? null,
        alternatives,
        state,
        sequence,
        verified_at,
        changed_at,
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
    generated_at: report.generated_at,
    unassessed_gaps: report.unassessed_gaps ?? [],
    universe: (report.universe ?? []).map(
      ({ key, kind, name, game, target_key, port_keys, relations, identity_gap }) => ({
        key,
        kind,
        label: [name, game].filter(Boolean).join(" — "),
        target_key,
        port_keys,
        relations: relations.map(({ type, key: related }) => `${type} ${related}`),
        identity_gap,
      }),
    ),
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
<p>Core assessments come from a fully isolated CLI run on the collecting host; the CLI binary is bound by digest, and each Core run's revision states whether its build source is verified (<code>binding=verified</code>) or only claimed.</p>
${freshnessSummary(report)}
<h2>Sources</h2>
<table><thead><tr><th>Source</th><th>Coverage</th><th>Revision</th><th>Observed</th><th>Completed</th><th>Age of last good read</th><th>Gaps</th></tr></thead><tbody>
${(report.runs as Record<string, unknown>[])
  .map(
    (run) =>
      `<tr><td>${escapeHtml(run.source)}</td><td>${escapeHtml(run.coverage)}${
        run.reassessment === "selective"
          ? ` (selective: ${escapeHtml(run.reused_count)} unchanged subjects reused, not re-read by Core)`
          : ""
      }</td><td><code>${escapeHtml(run.source_revision)}</code></td><td>${escapeHtml(run.observed_count)} of ${escapeHtml(run.expected_count ?? "unknown")} declared</td><td>${escapeHtml(run.completed_at)}</td><td>${sourceAge(report, String(run.source))}</td><td>${(Array.isArray(run.gaps) ? (run.gaps as { subject_key: string; code: string }[]) : []).map((gap) => `${escapeHtml(gap.subject_key)}: ${escapeHtml(gap.code)}`).join("<br>")}</td></tr>`,
  )
  .join("\n")}
${report.unsupported_sources
  .map(
    (source) =>
      `<tr><td>${escapeHtml(source.source)}</td><td class="unknown">unknown</td><td colspan="5">${escapeHtml(source.reason)}</td></tr>`,
  )
  .join("\n")}
</tbody></table>
${publicationSection(report)}
${reconsiderationSection(report)}
${hostedIntakeSection(report)}
<p>Next actions are executor handoffs. Disabled: ${escapeHtml(disabledCapabilities.join("; "))}.</p>
<h2>Games and implementations</h2>
<p>Every known port, implementation identity, issue-only implementation, intake request and definition. Related entries are linked, never merged; names are labels, not identity.</p>
<label for="universe-search">Search games and implementations</label>
<input id="universe-search" type="search" placeholder="Name, game, port key or identity">
<table><thead><tr><th>Identity</th><th>Kind</th><th>Name and game</th><th>Port keys</th><th>Related</th></tr></thead><tbody id="universe"></tbody></table>
<h2>Subjects</h2>
<p>Every complete run re-reads Core for every port. A port is reassessed, recording a new assessment, only when ${reassessmentTriggers.map(escapeHtml).join("; or ")}. Only a changed result records a change; a rebuild with the same output, a failed run, or a port Core could not read in a partial run records nothing. "Last verified" is the latest run that re-read the port and found the same inputs.</p>
<form id="filters" role="search" onsubmit="return false">
<label for="search">Search every column</label>
<input id="search" type="search" placeholder="Port, game, issue, upstream, offering, attention or action">
<label for="platform">Platform</label>
<select id="platform"><option value="">All platforms</option></select>
<label for="state">Core assessment</label>
<select id="state"><option value="">All states</option></select>
<label for="changed">Last changed</label>
<select id="changed"><option value="">Any time</option><option value="1">Within a day of this report</option><option value="7">Within 7 days</option><option value="30">Within 30 days</option></select>
<label><input id="attention" type="checkbox"> Needs attention or has a next action</label>
</form>
<p id="shown" aria-live="polite"></p>
<table><thead><tr><th>Subject</th><th>Name and game</th><th>Alternatives</th><th>Core assessment</th><th>Changes</th><th>Last verified</th><th>Last changed</th><th>Inputs last changed</th><th>Latest Core run</th><th>Work</th><th>Upstream</th><th>Offered for a fresh library</th><th>Qualification for the offered artifact (Core)</th><th>Needs attention</th><th>Next action</th></tr></thead><tbody id="subjects"></tbody></table>
<script id="inventory" type="application/json">${embedded}</script>
<script>
const report = JSON.parse(document.getElementById("inventory").textContent);
const body = document.getElementById("subjects");
${subjectFilterSource}
const allSubjects = [...report.subjects, ...(report.unassessed_gaps ?? []).map((gap) => ({ subject_key: gap.subject_key, state: "unknown", sequence: 0, verified_at: "never", changed_at: "never", latest_core_gap: gap }))];
for (const [id, values] of [
  ["platform", [...new Set(allSubjects.map((subject) => String(subject.subject_key).split("@")[1]).filter(Boolean))].sort()],
  ["state", [...new Set(allSubjects.map((subject) => subject.state).filter(Boolean))].sort()],
]) {
  const select = document.getElementById(id);
  for (const value of values) select.add(new Option(value, value));
}
function currentFilters() {
  return {
    text: document.getElementById("search").value.trim(),
    platform: document.getElementById("platform").value,
    state: document.getElementById("state").value,
    changedWithinDays: Number(document.getElementById("changed").value) || 0,
    attention: document.getElementById("attention").checked,
  };
}
function render() {
  body.replaceChildren();
  const filters = currentFilters();
  let shown = 0;
  for (const subject of allSubjects) {
    if (!subjectMatches(subject, filters, report.generated_at)) continue;
    shown += 1;
    const row = body.insertRow();
    const gap = subject.latest_core_gap
      ? "not assessed: " + subject.latest_core_gap.code
      : subject.latest_core_run === "assessed" ? "assessed"
      : subject.latest_core_run === "removed" ? "removed from the catalog" : "not in latest run";
    for (const value of [subject.subject_key, [subject.name, subject.game].filter(Boolean).join(" — "), (subject.alternatives ?? []).join(", "), subject.state, String(subject.sequence), subject.verified_at, subject.changed_at, subject.inputs || "not observed", gap, (subject.work ?? []).join("; ") || "no linked issue observed", subject.upstream || "not observed", subject.offered || "not observed", subject.qualified || "not observed", [subject.latest_health_gap ? "health not fresh: " + subject.latest_health_gap : "", ...(subject.attention ?? [])].filter(Boolean).join("; "), (subject.next_actions ?? []).join("; ")])
      row.insertCell().textContent = value;
  }
  document.getElementById("shown").textContent = shown + " of " + allSubjects.length + " subjects shown.";
}
document.getElementById("filters").addEventListener("input", render);
document.getElementById("filters").addEventListener("change", render);
render();
const universe = document.getElementById("universe");
function renderUniverse(filter) {
  universe.replaceChildren();
  const entries = report.universe ?? [];
  for (const entry of entries) {
    const text = [entry.key, entry.label, entry.target_key, entry.identity_gap, ...entry.port_keys, ...entry.relations].join(" ").toLowerCase();
    if (filter && !text.includes(filter)) continue;
    const row = universe.insertRow();
    for (const value of [entry.key, entry.kind, entry.label || "unnamed", entry.port_keys.join(", "), [...entry.relations, ...(entry.identity_gap ? ["identity unknown: " + entry.identity_gap] : [])].join("; ")])
      row.insertCell().textContent = value;
  }
  if (!entries.length) universe.insertRow().insertCell().textContent = "No identities observed yet.";
  else if (!universe.rows.length) universe.insertRow().insertCell().textContent = "No identity matches this search.";
}
document.getElementById("universe-search").addEventListener("input", (event) => renderUniverse(event.target.value.trim().toLowerCase()));
renderUniverse("");
</script>
</body>
</html>
`;
}

/** Writes inventory.json and index.html atomically into a new directory. */
export function writeReport(
  report: InventoryReport,
  output: string,
  /** The report this one supersedes; a late producer of an older generation is refused. */
  previous?: string,
) {
  if (existsSync(output))
    throw new MaintenanceStoreError(`Report destination already exists: ${output}`);
  if (previous) {
    const priorFile = path.join(previous, "inventory.json");
    if (!existsSync(priorFile))
      throw new MaintenanceStoreError(`The previous report has no inventory.json: ${previous}`);
    const prior = parseJson(readFileSync(priorFile, "utf8"), "previous maintenance report") as {
      format?: unknown;
      generation?: unknown;
    };
    if (prior.format !== "portcove-maintenance-inventory")
      throw new MaintenanceStoreError("The previous report is not a maintenance inventory");
    const generation = typeof prior.generation === "number" ? prior.generation : 0;
    if (generation > report.generation)
      throw new MaintenanceStoreError(
        `The previous report reflects newer collections (generation ${generation} > ${report.generation}); it is kept`,
      );
  }
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
                                       --issues-token-env NAME (with --issues) reads that collector's
                                       credential from NAME instead of GH_TOKEN, never falling back;
                                       --targets (with --all) adds Core's per-target route
                                       offering for a fresh library (catalog inspect-targets);
                                       --release-health (with --all) adds the latest scheduled
                                       main upstream-health report, bound by run and digest;
                                       --upstream (with --all) adds the newest retained upstream
                                       observer checkpoint snapshot from a completed schedule or
                                       push main run, bound by run, source and artifact digest;
                                       --hosted-intake (with --all) adds every #177 hosted-intake
                                       request through the executor's read-only status, bound by
                                       the #177 revision and a digest of every comment;
                                       --publication (with --all) adds the definitions committed
                                       on main; --delivery (with --all) adds what the appointed
                                       definition location serves, verified by Core as a client
                                       would (catalog inspect-definition-delivery);
                                       --reassess changed (with --all and --targets) reuses
                                       unchanged Core results under the same Core semantics
                                       after a full read within 7 days; full (default) reads all
  report --output DIR [--previous DIR]  write inventory.json and index.html to a new DIR; with
                                       --previous, refuse if that report reflects newer collections
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

PORTCOVE_MAINTENANCE_RUNNER optionally names the runner recorded with each collection run.`;

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return command ? 0 : 2;
  }
  const databaseEnvironment = option(args, "--database-env") ?? defaultDatabaseEnvironment;
  const environment = connectionFromEnvironment(databaseEnvironment);
  // Core CLI, Git and libpq children receive only the libpq translation, never the URL.
  delete process.env[databaseEnvironment];
  const cli = option(args, "--cli");
  const sample = option(args, "--sample");
  const output = option(args, "--output");
  const previous = option(args, "--previous");
  const digestFile = option(args, "--digest");
  const receipt = option(args, "--receipt");
  const concurrency = option(args, "--concurrency");
  const reassess = option(args, "--reassess");
  if (reassess !== undefined && reassess !== "full" && reassess !== "changed")
    throw new MaintenanceStoreError("--reassess must be full or changed");
  const issuesTokenEnvironment = option(args, "--issues-token-env");
  const allIndex = args.indexOf("--all");
  const all = allIndex >= 0;
  if (all) args.splice(allIndex, 1);
  const targetsIndex = args.indexOf("--targets");
  const targets = targetsIndex >= 0;
  if (targets) args.splice(targetsIndex, 1);
  const deliveryIndex = args.indexOf("--delivery");
  const delivery = deliveryIndex >= 0;
  if (delivery) args.splice(deliveryIndex, 1);
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
  if (issuesTokenEnvironment !== undefined && (!issues || command !== "collect"))
    throw new MaintenanceStoreError("--issues-token-env applies only to collect --issues");
  if (previous !== undefined && command !== "report")
    throw new MaintenanceStoreError("--previous applies only to report");
  if (args.length)
    throw new MaintenanceStoreError(`Unexpected arguments: ${args.join(" ")}\n${usage}`);
  if (command === "collect") {
    if (!cli) throw new MaintenanceStoreError("collect requires --cli PATH");
    const issueCredential =
      issuesTokenEnvironment === undefined
        ? undefined
        : takeIssueCredential(issuesTokenEnvironment);
    console.log(
      JSON.stringify(
        await collect({
          cli: path.resolve(cli),
          sample,
          all,
          concurrency: concurrency === undefined ? undefined : Number(concurrency),
          issues: issues ? () => readIssueInventory(issueCredential) : undefined,
          releaseHealth: releaseHealth ? readReleaseHealth : undefined,
          upstream: upstreamSource ? () => readUpstreamObservations(committedBytes) : undefined,
          hostedIntake: hostedSource ? readHostedIntake : undefined,
          publication: publication || undefined,
          delivery: delivery || undefined,
          targets: targets || undefined,
          reassess,
          environment,
        }),
        null,
        2,
      ),
    );
  } else if (command === "report") {
    if (!output) throw new MaintenanceStoreError("report requires --output DIR");
    const report = buildReport(environment);
    writeReport(report, path.resolve(output), previous ? path.resolve(previous) : undefined);
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
