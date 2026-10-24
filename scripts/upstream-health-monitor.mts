import { appendFile, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, errorCode } from "./runtime-values.mts";
import {
  collectRepositoryHealth,
  estimateHealthRequests,
  readHealthLineage,
  isHealthObservationHistory,
  isHealthIncidentHistory,
  type HealthOptions,
} from "./check-catalog-repositories.mts";
import { healthCatalogPortHash } from "./upstream-health-inputs.mts";
import {
  classifyHealthConditions,
  conditionEvidence,
  observedSpan,
} from "./upstream-health-triage.mts";
import { observationHash } from "./upstream-observer.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { withCheckpointLock } from "./observe-configured-upstream.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "boburning/portcove";
const workflow = ".github/workflows/upstream-health.yml";
const mainRef = "refs/heads/main";
const checkpointBytes = 16 * 1024 * 1024;
const maximumPorts = 4096;
const maximumObservations = 8192;
export const healthFreshnessMs = 24 * 60 * 60 * 1000;

type Collection = Awaited<ReturnType<typeof collectRepositoryHealth>>;
type Observation = Collection["observations"][number];
type PortHealth = Collection["port_health"][number];
type Incident = PortHealth["canonical_incidents"][number];
type IncidentHistory = Pick<
  PortHealth,
  "port_id" | "health_contract_sha256" | "canonical_incidents"
>;
type CatalogPort = Record<string, unknown> & { id: string };
type Catalog = Record<string, unknown> & { ports: CatalogPort[] };

export interface HealthExecution {
  actions: boolean;
  repository: string;
  ref: string;
  workflow_ref: string;
  event: string;
  source_commit: string;
  run_id: string;
  run_attempt: string;
}

export interface HealthMonitorScope {
  mode: "full" | "affected" | "none";
  port_ids: string[];
}

interface PortAttempt {
  port_id: string;
  health_contract_sha256: string;
  policy_sha256: string;
  attempted_at: string;
  scheduling_attempted_at: string | null;
  collection_status: "complete" | "partial";
}

interface HealthCheckpoint {
  format_version: 1;
  authority: "upstream-observation-history-only";
  repository: typeof repository;
  ref: typeof mainRef;
  workflow: typeof workflow;
  execution: HealthExecution;
  updated_at: string;
  attempts: PortAttempt[];
  observations: Observation[];
  port_health: PortHealth[];
  incident_history: IncidentHistory[];
}

interface MonitorReport {
  format_version: 1;
  authority: string;
  execution: HealthExecution;
  previous_checkpoint: string;
  batch: {
    requested_port_ids: string[];
    selected_port_ids: string[];
    deferred_port_ids: string[];
    oversized_port_ids: string[];
  };
  inventory: {
    total_ports: number;
    freshness_ms: number;
    assessed_this_run_port_ids: string[];
    unassessed_this_run_port_ids: string[];
    fresh_complete_port_ids: string[];
    fresh_partial_port_ids: string[];
    stale_port_ids: string[];
    unmonitored_port_ids: string[];
  };
  known_conditions: (Incident & {
    observed_this_run: boolean;
    changed_in_this_run: boolean;
    freshness: "fresh" | "stale";
    latest_collection_status: "complete" | "partial";
  })[];
  collection: Collection;
}

interface MonitorOptions extends Omit<HealthOptions, "portIds" | "previousReport"> {
  execution: HealthExecution;
  scope: HealthMonitorScope;
  policySha256: string;
  collect?: typeof collectRepositoryHealth;
  estimate?: (
    input: unknown,
    portIds: string[],
    accounting?: unknown,
  ) => {
    conservative_requests: number;
    hard_ceiling: number;
    status: string;
  };
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function clock(value: unknown, now: number): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && parsed <= now;
}

export function isTrustedHealthExecution(execution: HealthExecution): boolean {
  return (
    execution.actions === true &&
    execution.repository === repository &&
    execution.ref === mainRef &&
    execution.workflow_ref === `${repository}/${workflow}@${mainRef}` &&
    ["push", "schedule", "workflow_dispatch"].includes(execution.event) &&
    typeof execution.source_commit === "string" &&
    /^[a-f0-9]{40}$/u.test(execution.source_commit) &&
    typeof execution.run_id === "string" &&
    /^[1-9][0-9]{0,23}$/u.test(execution.run_id) &&
    typeof execution.run_attempt === "string" &&
    /^[1-9][0-9]{0,7}$/u.test(execution.run_attempt)
  );
}

function catalogPorts(input: unknown): asserts input is Catalog {
  if (
    !isRecord(input) ||
    !Array.isArray(input.ports) ||
    input.ports.length > maximumPorts ||
    input.ports.some(
      (port: unknown) =>
        !isRecord(port) ||
        typeof port.id !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(port.id),
    ) ||
    new Set(input.ports.map((port: CatalogPort) => port.id)).size !== input.ports.length
  )
    throw new Error("Monitoring requires a bounded catalog with unique port identities");
}

function validateCheckpoint(value: unknown, now: number): HealthCheckpoint | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    value.authority !== "upstream-observation-history-only" ||
    value.repository !== repository ||
    value.ref !== mainRef ||
    value.workflow !== workflow ||
    !isRecord(value.execution) ||
    !isTrustedHealthExecution(value.execution as unknown as HealthExecution) ||
    !clock(value.updated_at, now) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > maximumPorts ||
    !Array.isArray(value.observations) ||
    value.observations.length > maximumObservations ||
    !Array.isArray(value.port_health) ||
    value.port_health.length > maximumPorts ||
    !Array.isArray(value.incident_history) ||
    value.incident_history.length > maximumPorts ||
    Buffer.byteLength(JSON.stringify(value)) > checkpointBytes
  )
    throw new Error("Monitoring checkpoint has invalid identity, schema, time or resource bounds");
  const completion = Date.parse(value.updated_at);
  const ids = new Set<string>();
  for (const attempt of value.attempts) {
    if (
      !isRecord(attempt) ||
      typeof attempt.port_id !== "string" ||
      ids.has(attempt.port_id) ||
      !hash(attempt.health_contract_sha256) ||
      !hash(attempt.policy_sha256) ||
      !clock(attempt.attempted_at, completion) ||
      (attempt.scheduling_attempted_at !== null &&
        !clock(attempt.scheduling_attempted_at, Date.parse(attempt.attempted_at))) ||
      !["complete", "partial"].includes(String(attempt.collection_status))
    )
      throw new Error("Monitoring checkpoint contains an invalid port attempt");
    ids.add(attempt.port_id);
  }
  const observationKeys = new Set<string>();
  for (const observation of value.observations) {
    if (
      !isRecord(observation) ||
      !isHealthObservationHistory(observation, completion) ||
      !Array.isArray(observation.port_ids) ||
      observation.port_ids.length > maximumPorts ||
      observation.port_ids.some((id: unknown) => typeof id !== "string") ||
      new Set(observation.port_ids).size !== observation.port_ids.length ||
      !["reachable", "unknown"].includes(String(observation.status))
    )
      throw new Error("Monitoring checkpoint contains an invalid observation");
    const key = locationKey(observation);
    if (observationKeys.has(key)) throw new Error("Monitoring checkpoint repeats an observation");
    observationKeys.add(key);
  }
  const healthIds = new Set<string>();
  for (const port of value.port_health) {
    if (
      !isRecord(port) ||
      typeof port.port_id !== "string" ||
      healthIds.has(port.port_id) ||
      !ids.has(port.port_id) ||
      !hash(port.health_contract_sha256) ||
      !Array.isArray(port.canonical_incidents) ||
      port.canonical_incidents.length > 512 ||
      port.canonical_incidents.some(
        (incident: unknown) =>
          !isRecord(incident) ||
          !isHealthIncidentHistory(incident, completion) ||
          incident.port_id !== port.port_id,
      )
    )
      throw new Error("Monitoring checkpoint contains invalid incident history");
    healthIds.add(port.port_id);
  }
  if (healthIds.size !== ids.size)
    throw new Error("Monitoring checkpoint is missing port incident history");
  const historyIds = new Set<string>();
  const incidentKeys = new Set<string>();
  for (const port of value.incident_history) {
    if (
      !isRecord(port) ||
      typeof port.port_id !== "string" ||
      historyIds.has(port.port_id) ||
      !ids.has(port.port_id) ||
      !hash(port.health_contract_sha256) ||
      !Array.isArray(port.canonical_incidents) ||
      port.canonical_incidents.length > 512
    )
      throw new Error("Monitoring checkpoint contains invalid retained incident history");
    const incidents: unknown[] = port.canonical_incidents;
    for (const incident of incidents) {
      if (!isHealthIncidentHistory(incident, completion) || incident.port_id !== port.port_id)
        throw new Error("Monitoring checkpoint contains invalid retained incident history");
      if (incidentKeys.has(incident.key))
        throw new Error("Monitoring checkpoint repeats a retained incident");
      incidentKeys.add(incident.key);
    }
    historyIds.add(port.port_id);
  }
  if (incidentKeys.size > maximumObservations)
    throw new Error("Monitoring checkpoint exceeds its incident-history bound");
  return value as unknown as HealthCheckpoint;
}

function locationKey(location: unknown): string {
  if (!isRecord(location)) throw new Error("Invalid monitoring location");
  return observationHash({
    provider: location.provider,
    repository: location.repository,
    release_ref: location.release_ref ?? null,
    unlocated_port_ids: location.provider === "unlocated-historical" ? location.port_ids : null,
  });
}

function requestedIds(catalog: Catalog, scope: HealthMonitorScope): string[] {
  const ids = catalog.ports.map((port) => port.id);
  if (
    !["full", "affected", "none"].includes(scope.mode) ||
    !Array.isArray(scope.port_ids) ||
    new Set(scope.port_ids).size !== scope.port_ids.length ||
    scope.port_ids.some((id) => !ids.includes(id)) ||
    (scope.mode === "none" && scope.port_ids.length !== 0) ||
    (scope.mode === "affected" && scope.port_ids.length === 0)
  )
    throw new Error("Monitoring scope must identify unique current catalog ports");
  return scope.mode === "full" ? ids : scope.port_ids;
}

export async function advanceHealthMonitor(
  input: unknown,
  previousCheckpoint: unknown,
  {
    execution,
    scope,
    policySha256,
    collect = collectRepositoryHealth,
    estimate = estimateHealthRequests,
    now = Date.now,
    ...healthOptions
  }: MonitorOptions,
) {
  catalogPorts(input);
  if (!hash(policySha256)) throw new Error("Monitoring policy hash is required");
  const started = now();
  const previous = validateCheckpoint(previousCheckpoint, started);
  const requested = requestedIds(input, scope);
  // Validate the entire inventory and policy before selecting any network work.
  estimate(input, [], healthOptions.reviewedAccounting);
  const attempts = new Map(previous?.attempts.map((attempt) => [attempt.port_id, attempt]) ?? []);
  const currentHashes = new Map(
    input.ports.map((port) => [
      port.id,
      healthCatalogPortHash(input, port.id, healthOptions.lineageRecords ?? []),
    ]),
  );
  const applicable = (id: string) => {
    const attempt = attempts.get(id);
    return attempt &&
      attempt.health_contract_sha256 === currentHashes.get(id) &&
      attempt.policy_sha256 === policySha256
      ? attempt
      : undefined;
  };
  const due = requested
    .filter((id) => {
      if (execution.event !== "push" || !isTrustedHealthExecution(execution)) return true;
      const attempt = applicable(id);
      return (
        !attempt ||
        attempt.collection_status === "partial" ||
        started - Date.parse(attempt.attempted_at) >= healthFreshnessMs
      );
    })
    .sort((left, right) => {
      const age = (id: string) => {
        const clock = applicable(id)?.scheduling_attempted_at;
        return clock ? Date.parse(clock) : 0;
      };
      return age(left) - age(right) || left.localeCompare(right);
    });
  const selected: string[] = [];
  const oversized: string[] = [];
  for (const id of due) {
    const plan = estimate(input, [...selected, id], healthOptions.reviewedAccounting);
    if (plan.status === "admitted" && plan.conservative_requests <= plan.hard_ceiling)
      selected.push(id);
    else {
      const single = estimate(input, [id], healthOptions.reviewedAccounting);
      if (single.status !== "admitted" || single.conservative_requests > single.hard_ceiling)
        oversized.push(id);
    }
  }
  const selectedSet = new Set(selected);
  // This is a historical comparison envelope, never a current full-inventory result.
  const comparison =
    previous === null
      ? null
      : {
          format_version: 3,
          authority: "historical-comparison-only",
          completed_at: previous.updated_at,
          observations: previous.observations.filter((observation) =>
            observation.port_ids.some((id) => selectedSet.has(id)),
          ),
          port_health: previous.incident_history.filter((port) => selectedSet.has(port.port_id)),
        };
  const collection = await collect(input, {
    ...healthOptions,
    now,
    portIds: selected,
    previousReport: comparison,
  });
  const completed = now();
  if (!clock(collection.completed_at, completed))
    throw new Error("Monitoring returned an invalid completion clock");
  const currentIds = new Set(input.ports.map((port) => port.id));
  const freshObservations = new Map(
    collection.observations.map((observation) => [locationKey(observation), observation]),
  );
  const retainedObservations = (previous?.observations ?? []).filter(
    (observation) =>
      !freshObservations.has(locationKey(observation)) &&
      observation.port_ids.some((id) => currentIds.has(id) && !selectedSet.has(id)),
  );
  const history = [...retainedObservations, ...collection.observations];
  const portHealth = [
    ...(previous?.port_health ?? []).filter(
      (port) => currentIds.has(port.port_id) && !selectedSet.has(port.port_id),
    ),
    ...collection.port_health,
  ];
  // Inconclusive attempts replace current conditions, but cannot resolve a
  // previous condition. Keep that comparison history separate from this run's
  // current incident list until recovery or replacement of the observed scope.
  const incidentHistory = new Map(
    (previous?.incident_history ?? [])
      .filter((port) => currentIds.has(port.port_id))
      .map((port) => [port.port_id, port]),
  );
  const resolved = new Set([
    ...collection.resolved_incidents,
    ...collection.assessment_recovered_incidents,
  ]);
  for (const health of collection.port_health) {
    const currentLocations = new Map(
      collection.observations
        .filter((record) => record.port_ids.includes(health.port_id))
        .map((record) => [locationKey(record), record.observation_contract_sha256]),
    );
    const retained = (incidentHistory.get(health.port_id)?.canonical_incidents ?? []).filter(
      (incident) =>
        !resolved.has(incident.key) &&
        currentLocations.get(
          locationKey({
            provider: incident.provider,
            repository: incident.location,
            release_ref: incident.release_ref,
            port_ids: [incident.port_id],
          }),
        ) === incident.observation_contract_sha256,
    );
    const incidents = new Map(retained.map((incident) => [incident.key, incident]));
    for (const incident of health.canonical_incidents) incidents.set(incident.key, incident);
    incidentHistory.set(health.port_id, {
      port_id: health.port_id,
      health_contract_sha256: health.health_contract_sha256,
      canonical_incidents: [...incidents.values()],
    });
  }
  const collectedHealth = new Map(collection.port_health.map((port) => [port.port_id, port]));
  for (const id of selected) {
    const health = collectedHealth.get(id);
    if (!health || health.health_contract_sha256 !== currentHashes.get(id))
      throw new Error("Monitoring collection omitted or changed a selected port contract");
    const locations = collection.observations.filter((record) => record.port_ids.includes(id));
    const whollyDeferred =
      locations.length > 0 &&
      locations.every(
        (record) =>
          !record.attempted &&
          !record.metadata_reused &&
          ["budget", "rate-limit"].includes(record.reason ?? ""),
      );
    attempts.set(id, {
      port_id: id,
      health_contract_sha256: currentHashes.get(id)!,
      policy_sha256: policySha256,
      attempted_at: collection.completed_at,
      // Deferred tails must get a turn before recently attempted ports when
      // wall-clock or provider limits stop a request-admitted batch early.
      scheduling_attempted_at: whollyDeferred
        ? (applicable(id)?.scheduling_attempted_at ?? null)
        : collection.completed_at,
      collection_status: health.collection_status,
    });
  }
  const latestAttempts = [...attempts.values()].filter((attempt) =>
    currentIds.has(attempt.port_id),
  );
  const inventory = {
    total_ports: input.ports.length,
    freshness_ms: healthFreshnessMs,
    assessed_this_run_port_ids: selected,
    unassessed_this_run_port_ids: input.ports
      .map((port) => port.id)
      .filter((id) => !selectedSet.has(id)),
    fresh_complete_port_ids: [] as string[],
    fresh_partial_port_ids: [] as string[],
    stale_port_ids: [] as string[],
    unmonitored_port_ids: [] as string[],
  };
  for (const port of input.ports) {
    const attempt = applicable(port.id);
    if (!attempt) inventory.unmonitored_port_ids.push(port.id);
    else if (completed - Date.parse(attempt.attempted_at) > healthFreshnessMs)
      inventory.stale_port_ids.push(port.id);
    else if (attempt.collection_status === "complete")
      inventory.fresh_complete_port_ids.push(port.id);
    else inventory.fresh_partial_port_ids.push(port.id);
  }
  const candidate: HealthCheckpoint = {
    format_version: 1,
    authority: "upstream-observation-history-only",
    repository,
    ref: mainRef,
    workflow,
    execution,
    updated_at: collection.completed_at,
    attempts: latestAttempts,
    observations: history,
    port_health: portHealth,
    incident_history: [...incidentHistory.values()],
  };
  if (
    history.length > maximumObservations ||
    Buffer.byteLength(JSON.stringify(candidate)) > checkpointBytes
  )
    throw new Error("Monitoring history exceeds its explicit retention bound");
  const checkpoint = isTrustedHealthExecution(execution)
    ? validateCheckpoint(candidate, completed)
    : null;
  const report: MonitorReport = {
    format_version: 1,
    authority:
      "upstream-monitoring-only; no acquisition, artifact, lineage or publication authority",
    execution,
    previous_checkpoint:
      previous === null ? "absent; comparison unavailable" : "validated main observation history",
    batch: {
      requested_port_ids: requested,
      selected_port_ids: selected,
      deferred_port_ids: due.filter((id) => !selectedSet.has(id)),
      oversized_port_ids: oversized,
    },
    inventory,
    known_conditions: portHealth.flatMap((port) => {
      const attempt = applicable(port.port_id);
      if (!attempt) return [];
      return port.canonical_incidents.map((incident) => ({
        ...incident,
        observed_this_run: selectedSet.has(port.port_id),
        changed_in_this_run: selectedSet.has(port.port_id) && incident.notify,
        freshness:
          completed - Date.parse(attempt.attempted_at) > healthFreshnessMs ? "stale" : "fresh",
        latest_collection_status: attempt.collection_status,
      }));
    }),
    collection,
  };
  return {
    checkpoint,
    report,
    summary: renderHealthMonitorSummary(report),
    exitCode: collection.collection_status === "complete" && oversized.length === 0 ? 0 : 1,
    retcomm_port_ids: input.ports
      .filter((port) => selectedSet.has(port.id) && port.adapter === "psx-recomp-managed")
      .map((port) => port.id),
  };
}

function cell(value: string | number | boolean | null | undefined): string {
  return String(value ?? "unknown")
    .replace(/[\r\n\t|`<>]/gu, " ")
    .slice(0, 300);
}

export function renderHealthMonitorSummary(report: MonitorReport): string {
  const { collection, inventory, batch } = report;
  const triage = classifyHealthConditions(report.known_conditions);
  const { routine, ordered: incidents, changed, continuing } = triage;

  const lines = [
    "## Upstream health observation",
    "",
    `Collection: **${cell(collection.collection_status)}**. ${batch.selected_port_ids.length}/${inventory.total_ports} ports assessed in this run; ${batch.deferred_port_ids.length} deferred by the batch budget.`,
    "",
    `Tracked conditions: **${changed.length} new or changed**, **${continuing.length} continuing**, **${collection.resolved_incidents.length} endpoint recoveries**, **${collection.assessment_recovered_incidents.length} metadata assessments recovered**. A completed observation does not establish installability or accepted artifact bytes.`,
    "",
    `Inventory history: ${inventory.fresh_complete_port_ids.length} recent complete collections; ${inventory.fresh_partial_port_ids.length} recent partial attempts; ${inventory.stale_port_ids.length} stale; ${inventory.unmonitored_port_ids.length} without applicable observations. Freshness window: 24 hours.`,
    "",
    `Requests: ${collection.consumed.requests}/${collection.request_plan.conservative_requests} planned; hard ceiling ${collection.request_plan.hard_ceiling}. Observation records: ${collection.request_plan.observation_records}/${collection.request_plan.observation_ceiling}. ${report.previous_checkpoint}.`,
  ];
  if (incidents.length)
    lines.push(
      "",
      `Exception visibility: ${triage.stale} stale, ${triage.partial} with partial collection, and ${triage.retained} not observed in this run among ${incidents.length} displayed conditions (categories overlap).`,
      "First/last clocks and occurrence counts reflect separate observations, not continuous downtime, trusted bytes, or an authorization to change an installation hold.",
    );

  if (routine.length)
    lines.push(
      "",
      `${routine.length} routine provider metadata conditions are retained separately in JSON; destination availability and accepted bytes remain unverified.`,
    );
  if (incidents.length) {
    lines.push(
      "",
      "| Port / observed source | Failed rule / assessment | Recurrence | Evidence state | Recovery or follow-up |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const incident of incidents.slice(0, 20)) {
      const scope = `${cell(incident.port_id)} / ${cell(incident.provider)}:${cell(incident.location)}${incident.release_ref === null ? "" : ` @${cell(incident.release_ref)}`}`;
      const assessment = `${cell(incident.rule)} (HTTP ${cell(incident.http_status)}); ${cell(incident.classification)}; ${incident.accounted_for ? "accounted metadata" : "unaccounted"}`;
      const recurrence = `first ${cell(incident.first_seen)}; ${cell(incident.occurrences)} observation(s); ${cell(observedSpan(incident))} observed span`;
      const evidence = `${incident.changed_in_this_run ? "New/changed" : "Continuing"}; ${cell(conditionEvidence(incident))}; last ${cell(incident.observed_at)}`;
      const next = `${cell(incident.resume_condition)}${incident.retry_at ? `; retry after ${cell(incident.retry_at)}` : ""}`;
      lines.push(`| ${scope} | ${assessment} | ${recurrence} | ${evidence} | ${next} |`);
    }
    if (incidents.length > 20)
      lines.push(
        "",
        `${incidents.length - 20} additional conditions are retained in the JSON report.`,
      );
    lines.push(
      "",
      "Platforms/variants, usable fallbacks, accepted bytes and operational holds are unassessed by this location-only monitor. Follow Core policy and accepted artifact evidence before taking action.",
    );
  }

  if (batch.oversized_port_ids.length)
    lines.push(
      "",
      `**A single port exceeds the collection budget:** ${batch.oversized_port_ids.map(cell).join(", ")}. Its obligations remain unassessed.`,
    );
  if (!batch.selected_port_ids.length)
    lines.push(
      "",
      "No live upstream requests were selected. Existing history is not a fresh inventory observation.",
    );
  return `${lines.join("\n")}\n`;
}

async function boundedJson(filename: string, maximum: number, optional = false): Promise<unknown> {
  const safe = await assertOwnedUnlinkedPath(root, filename, "monitor input");
  let handle;
  try {
    handle = await open(
      safe,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum)
      throw new Error("Monitoring input exceeds its regular-file bound");
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, null);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > maximum) throw new Error("Monitoring input grew beyond its bound");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch (error) {
    if (optional && errorCode(error) === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicJson(filename: string, value: unknown): Promise<void> {
  const destination = await assertOwnedUnlinkedPath(
    path.join(root, "work"),
    filename,
    "monitor output",
  );
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > checkpointBytes)
    throw new Error("Monitoring output exceeds its byte bound");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.next`;
  try {
    await writeFile(temporary, `${content}\n`, { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function executionFromEnvironment(): HealthExecution {
  return {
    actions: process.env.GITHUB_ACTIONS === "true",
    repository: process.env.GITHUB_REPOSITORY ?? "local",
    ref: process.env.GITHUB_REF ?? "local",
    workflow_ref: process.env.GITHUB_WORKFLOW_REF ?? "local",
    event: process.env.GITHUB_EVENT_NAME ?? "local",
    source_commit: process.env.GITHUB_SHA ?? "unknown",
    run_id: process.env.GITHUB_RUN_ID ?? "local",
    run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
  };
}

async function main(): Promise<void> {
  if (process.argv.length !== 2)
    throw new Error("upstream-health-monitor accepts fixed workflow environment only");
  const workRoot = path.join(root, "work");
  await assertOwnedUnlinkedPath(root, workRoot, "monitor work directory");
  await mkdir(workRoot, { recursive: true });
  const directory = path.join(root, "work/upstream-health");
  await assertOwnedUnlinkedPath(workRoot, directory, "monitor directory");
  await mkdir(directory, { recursive: true });
  const checkpoint = path.join(directory, "checkpoint.json");
  const reportPath = path.join(directory, "report.json");
  const summaryPath = path.join(directory, "summary.md");
  const execution = executionFromEnvironment();
  await withCheckpointLock(checkpoint, async () => {
    try {
      const mode = process.env.HEALTH_MODE;
      if (mode !== "full" && mode !== "affected" && mode !== "none")
        throw new Error("Missing monitor scope");
      const policy = await boundedJson(
        path.join(root, ".github/upstream-health-accounting.json"),
        1024 * 1024,
      );
      const catalog = await boundedJson(
        path.join(root, "crates/portcove-core/catalog/catalog.json"),
        4 * 1024 * 1024,
      );
      const result = await advanceHealthMonitor(
        catalog,
        await boundedJson(checkpoint, checkpointBytes, true),
        {
          execution,
          scope: { mode, port_ids: (process.env.HEALTH_PORT_IDS ?? "").split(",").filter(Boolean) },
          policySha256: observationHash(policy),
          reviewedAccounting: policy,
          lineageRecords: await readHealthLineage(catalog),
          githubToken: process.env.GITHUB_TOKEN,
        },
      );
      // A saved checkpoint is historical comparison evidence, including failures.
      // PR diagnostics never mutate the trusted main checkpoint.
      if (result.checkpoint) await atomicJson(checkpoint, result.checkpoint);
      await atomicJson(reportPath, result.report);
      await assertOwnedUnlinkedPath(path.join(root, "work"), summaryPath, "monitor summary");
      await writeFile(summaryPath, result.summary);
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(process.env.GITHUB_STEP_SUMMARY, result.summary);
      if (process.env.GITHUB_OUTPUT)
        await appendFile(
          process.env.GITHUB_OUTPUT,
          `retcomm=${result.retcomm_port_ids.length > 0}\nretcomm_port_ids=${result.retcomm_port_ids.join(",")}\ncheckpoint_updated=${result.checkpoint !== null}\n`,
        );
      console.log(result.summary);
      process.exitCode = result.exitCode;
    } catch (error) {
      await atomicJson(reportPath, {
        format_version: 1,
        authority: "upstream-monitoring-only",
        execution,
        collection_status: "failed",
        observed_at: new Date().toISOString(),
        reason:
          "Coordinator, input or state validation failed; prior checkpoint remains historical evidence",
      });
      const failureSummary =
        "## Upstream health observation\n\n**Collection failed.** Input, checkpoint or coordinator validation failed. Current upstream state is unassessed; prior checkpoint observations remain historical. Inspect the retained JSON report and failed step.\n";
      await assertOwnedUnlinkedPath(workRoot, summaryPath, "monitor failure summary");
      await writeFile(summaryPath, failureSummary);
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(process.env.GITHUB_STEP_SUMMARY, failureSummary);
      throw error;
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      "Upstream health monitoring failed; retained report and prior history require inspection.",
    );
    process.exitCode = 1;
  });
