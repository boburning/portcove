import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { isRecord } from "./runtime-values.mts";
import { MaintenanceBackupDeferred } from "./maintenance-backup-reuse.mts";
import {
  MaintenanceStoreError,
  maintenanceTransfer,
  migrationStatus,
  migrate,
  queryJson,
  runSql,
  sqlLiteral,
} from "./maintenance-store.mts";

const mb = 1_000_000;
export const neonProject = "wispy-salad-36926388";
/** The production branch whose transfer the meter reads. */
export const neonBranch = "br-frosty-bar-bbaitwbu";
/** Organization that owns the metered project; named in credential diagnostics. */
const neonOrganization = "org-polished-frog-23199890";
/**
 * How long after an operation finishes the provider counter is assumed to include
 * its transfer. Neon refreshes usage roughly every 15 minutes; this is a wide margin.
 */
const meterSettleInterval = "interval '2 hours'";
/**
 * A provider message fit for retained evidence: one line, at most 200
 * characters, with the credential removed should a provider ever echo it.
 */
export function neonDiagnostic(message: string, token: string) {
  const line = message.replace(/[\r\n\t]+/gu, " ").trim();
  return (token ? line.split(token).join("[credential]") : line).slice(0, 200);
}
export const transferLimit = 5_000 * mb;
const day = 86_400_000;
export const admissionTimeout = 2 * 60 * 60 * 1000;
const sampleLifetime = 5 * 60 * 1000;
const bootstrapAllowance = 5 * mb;
const recoveryDailyForecast = 22 * mb;
const normalReserve = 2_000 * mb;
const emergencyReserve = 350 * mb;
const transitionReset = "2026-12-01T00:00:00.000Z";
const transitionAllowance = 300 * mb;
const transitionMeter: NeonMeter = {
  periodStart: "2026-11-12T21:55:18.000Z",
  resetAt: transitionReset,
  sampledAt: "2026-11-20T20:51:30.000Z",
  sampleOrigin: "november-cutover",
  transferBytes: 4_065_773_982,
  computeSeconds: 9790,
  activeSeconds: 34828,
  storageBytes: 170_606_592,
  branchTransferBytes: 4_065_773_982,
};
const transitionHost = "ep-shy-resonance-bb33lu82.c-15.us-east-1.aws.neon.tech";

export function cutoverReading(
  environment: NodeJS.ProcessEnv,
  operation: MaintenanceOperation,
  now = Date.now(),
) {
  if (
    environment.PORTCOVE_NEON_METER_TOKEN ||
    !["recovery", "recovery-catchup", "collect", "handoffs", "intake", "inspect"].includes(
      operation,
    ) ||
    environment.PGHOST?.replace(/-pooler(?=\.)/u, "").toLowerCase() !== transitionHost ||
    now < Date.parse(transitionMeter.sampledAt) ||
    now >= Date.parse(transitionReset)
  )
    return undefined;
  return transitionMeter;
}

const costs = {
  collect: 18 * mb,
  report: 70 * mb,
  handoffs: 8 * mb,
  digest: 16 * mb,
  recovery: 48 * mb,
  "recovery-catchup": 110 * mb,
  "recovery-full": 440 * mb,
  inspect: 2 * mb,
  intake: 18 * mb,
  discovery: 16 * mb,
} as const;

export type MaintenanceOperation = keyof typeof costs;

export interface NeonMeter {
  periodStart: string;
  resetAt: string;
  sampledAt: string;
  sampleOrigin?: "live" | "november-cutover";
  transferBytes: number;
  computeSeconds: number | null;
  activeSeconds: number | null;
  storageBytes: number | null;
  branchTransferBytes: number | null;
}

function asCounter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function normalizeNeonMeter(
  project: Record<string, unknown>,
  branch: Record<string, unknown>,
  sampledAt: string,
): NeonMeter {
  const owner = project.owner as { subscription_type?: unknown } | undefined;
  const periodStart = timestamp(project.consumption_period_start);
  const periodEnd = timestamp(project.consumption_period_end);
  const resetAt = project.quota_reset_at ? timestamp(project.quota_reset_at) : periodEnd;
  const transferBytes = asCounter(project.data_transfer_bytes);
  if (
    owner?.subscription_type !== "free_v3" ||
    project.id !== neonProject ||
    branch.project_id !== neonProject ||
    branch.id !== neonBranch ||
    !periodStart ||
    !periodEnd ||
    !resetAt ||
    transferBytes === null ||
    Date.parse(sampledAt) < Date.parse(periodStart) ||
    Date.parse(sampledAt) >= Date.parse(resetAt) ||
    Date.parse(resetAt) > Date.parse(periodEnd)
  )
    throw new MaintenanceStoreError(
      "Neon returned no usable current Free project transfer reading",
    );
  return {
    periodStart,
    resetAt,
    sampledAt,
    sampleOrigin: "live",
    transferBytes,
    computeSeconds: asCounter(project.compute_time_seconds),
    activeSeconds: asCounter(project.active_time_seconds),
    storageBytes: asCounter(branch.logical_size),
    branchTransferBytes: asCounter(branch.data_transfer_bytes),
  };
}

async function neonCredentialIdentity(token: string) {
  const get = async (path: string) => {
    try {
      const response = await fetch(`https://console.neon.tech/api/v2${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await response.json().catch(() => null);
      return { status: response.status, body };
    } catch (error) {
      return {
        status: 0,
        body: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  };
  const user = await get("/users/me");
  if (user.status !== 200 || !isRecord(user.body) || typeof user.body.id !== "string") {
    const message =
      isRecord(user.body) && typeof user.body.message === "string"
        ? `: ${neonDiagnostic(user.body.message, token)}`
        : "";
    const kind = [401, 403, 404].includes(user.status)
      ? "credential is not a personal key"
      : "credential identity unreadable";
    return `${kind} (users/me HTTP ${user.status}${message}); project ${neonProject} belongs to ${neonOrganization}`;
  }
  const organizations = await get("/users/me/organizations");
  const listed =
    isRecord(organizations.body) && Array.isArray(organizations.body.organizations)
      ? organizations.body.organizations
          .map((organization: unknown) =>
            isRecord(organization) && typeof organization.id === "string" ? organization.id : "",
          )
          .filter(Boolean)
      : null;
  const membership =
    listed === null
      ? `organizations unreadable (HTTP ${organizations.status})`
      : listed.includes(neonOrganization)
        ? `member of ${neonOrganization} but without access to project ${neonProject}`
        : `not a member of ${neonOrganization}`;
  return `credential belongs to Neon user ${neonDiagnostic(user.body.id, token).slice(0, 64)}, ${membership}`;
}

export async function sampleNeon(environment: NodeJS.ProcessEnv): Promise<NeonMeter> {
  const token = environment.PORTCOVE_NEON_METER_TOKEN;
  if (!token) throw new MaintenanceStoreError("Missing PORTCOVE_NEON_METER_TOKEN");
  const base = `https://console.neon.tech/api/v2/projects/${neonProject}`;
  // Each read names itself and Neon's own error message when it fails, so a
  // deferred admission records which read a credential cannot see and why.
  const read = async (name: string, suffix: string) => {
    let response: Response;
    try {
      response = await fetch(base + suffix, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new MaintenanceStoreError(
        `Neon ${name} read failed: ${neonDiagnostic(error instanceof Error ? error.message : String(error), token)}`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let message = "";
      try {
        const parsed: unknown = JSON.parse(body);
        if (isRecord(parsed) && typeof parsed.message === "string") message = parsed.message;
      } catch {
        // A non-JSON error body is not quoted.
      }
      throw new MaintenanceStoreError(
        `Neon ${name} read returned HTTP ${response.status}${message ? `: ${neonDiagnostic(message, token)}` : ""}`,
      );
    }
    try {
      const value: unknown = await response.json();
      return value;
    } catch (error) {
      throw new MaintenanceStoreError(
        `Neon ${name} read returned an unreadable body: ${neonDiagnostic(error instanceof Error ? error.message : String(error), token)}`,
      );
    }
  };
  const sampledAt = new Date().toISOString();
  // Every read finishes, so a failure report names each read that failed.
  const reads = await Promise.allSettled([
    read("project", ""),
    read("branch", `/branches/${neonBranch}`),
    read("endpoints", "/endpoints"),
  ]);
  const failed = reads.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed.length) {
    const reasons = failed.map((result) =>
      result.reason instanceof Error ? result.reason.message : String(result.reason),
    );
    // When the project is invisible to the credential, name whose credential it
    // is (opaque ids only) so the wrong key or a missing membership is evident.
    if (failed.length === reads.length && reasons.every((reason) => / HTTP 404\b/u.test(reason)))
      reasons.push(
        await neonCredentialIdentity(token).catch(() => "credential identity probe failed"),
      );
    throw new MaintenanceStoreError(reasons.join("; "));
  }
  const [projectResponse, branchResponse, endpointsResponse] = reads.map((result) =>
    result.status === "fulfilled" ? result.value : undefined,
  );
  const project = isRecord(projectResponse) && projectResponse.project;
  const branch = isRecord(branchResponse) && branchResponse.branch;
  const endpoints = isRecord(endpointsResponse) && endpointsResponse.endpoints;
  if (!isRecord(project) || !isRecord(branch) || project.effective_project_permission !== "VIEWER")
    throw new MaintenanceStoreError("Neon meter needs a project Viewer credential");
  const host = environment.PGHOST?.replace(/-pooler(?=\.)/u, "").toLowerCase();
  if (
    !Array.isArray(endpoints) ||
    !endpoints.some(
      (endpoint: unknown) =>
        isRecord(endpoint) && endpoint.host === host && endpoint.branch_id === neonBranch,
    )
  )
    throw new MaintenanceStoreError(
      "Database endpoint does not match the metered production branch",
    );
  return normalizeNeonMeter(project, branch, sampledAt);
}

export function isNeon(environment: NodeJS.ProcessEnv) {
  return /(?:^|\.)neon\.tech$/iu.test(environment.PGHOST ?? "");
}

/** The operation estimates are defaults, not measured lower bounds. Only the
 * revision-fenced discovery reader currently proves a smaller response envelope.
 * All other callers retain the default or a larger explicitly requested amount. */
export function operationReservation(
  operation: MaintenanceOperation,
  reservationBytes?: number,
  measuredDiscovery = false,
) {
  if (reservationBytes !== undefined &&
    (!Number.isSafeInteger(reservationBytes) || reservationBytes <= 0))
    throw new MaintenanceStoreError("Invalid maintenance reservation size");
  if (measuredDiscovery) {
    if (operation !== "discovery" || reservationBytes === undefined)
      throw new MaintenanceStoreError("Measured discovery admission requires a discovery response bound");
    return reservationBytes;
  }
  return Math.max(costs[operation], reservationBytes ?? 0);
}

export function policyLimits(
  meter: NeonMeter,
  operation: MaintenanceOperation,
  now: number,
  /** A reservation estimate, or a proven revision-fenced discovery bound. */
  reservationBytes?: number,
  measuredDiscovery = false,
) {
  const reservation = operationReservation(operation, reservationBytes, measuredDiscovery);
  const days = Math.max(0, Math.ceil((Date.parse(meter.resetAt) - now) / day) - 1);
  const recovery = operation.startsWith("recovery");
  const reserve =
    meter.resetAt === transitionReset
      ? emergencyReserve
      : recovery
        ? emergencyReserve
        : normalReserve;
  const scheduled = days * recoveryDailyForecast + (recovery ? 0 : costs.recovery);
  const operatingCeiling =
    meter.sampleOrigin === "november-cutover"
      ? meter.transferBytes + transitionAllowance
      : transferLimit - reserve;
  const chargeableForecast = meter.sampleOrigin === "november-cutover" && recovery ? 0 : scheduled;
  return {
    reserve_bytes: reserve,
    future_daily_recovery_bytes: scheduled,
    operation_reservation_bytes: reservation,
    reservation_basis: measuredDiscovery ? "revision-fenced-discovery" : "conservative-default-or-larger",
    ceiling_bytes: operatingCeiling - chargeableForecast - bootstrapAllowance,
    cutover_allowance_bytes: meter.sampleOrigin === "november-cutover" ? transitionAllowance : null,
    recurring_monthly_projection_bytes: 31 * (recoveryDailyForecast + costs.collect),
    development_burst_projection_bytes: 15 * costs.collect + 15 * costs.inspect,
  };
}

export class MaintenanceResourceDeferred extends MaintenanceStoreError {}
export class MaintenanceRequestCoalesced extends MaintenanceStoreError {}

export function acquireMaintenanceReservation(
  environment: NodeJS.ProcessEnv,
  input: {
    meter: NeonMeter;
    operation: MaintenanceOperation;
    request: string;
    revision?: string | undefined;
    reason: string;
    now?: number;
    executor?: boolean;
    reservationBytes?: number | undefined;
    measuredDiscovery?: boolean | undefined;
  },
) {
  const { meter, operation, request, revision, reason } = input;
  const now = input.now ?? Date.now();
  const limits = policyLimits(meter, operation, now, input.reservationBytes, input.measuredDiscovery);
  const reserved = limits.operation_reservation_bytes;
  const age = now - Date.parse(meter.sampledAt);
  const useCutover = meter.sampleOrigin === "november-cutover";
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    (!useCutover && age > sampleLifetime) ||
    now + admissionTimeout >= Date.parse(meter.resetAt)
  )
    throw new MaintenanceResourceDeferred(
      "Provider period or API sample cannot cover an operation",
    );
  const id = randomUUID();
  const period = sqlLiteral(meter.periodStart);
  const reset = sqlLiteral(meter.resetAt);
  const sampled = sqlLiteral(meter.sampledAt);
  const table = "portcove_maintenance_meta.resource_admissions";
  // Separate statements ensure the admission reads its preimage after acquiring
  // the transaction lock in READ COMMITTED. Older outstanding work remains charged.
  const status = queryJson(
    environment,
    `DO $$ BEGIN PERFORM pg_advisory_xact_lock(41290007); END $$;
    WITH balance AS (
      SELECT coalesce(sum(
        CASE WHEN (outcome = 'completed' OR (outcome = 'deferred' AND operation LIKE 'recovery%')) AND estimate_bytes IS NOT NULL
          -- The cumulative project counter already includes a completed
          -- operation's transfer once the sample was taken well after it
          -- finished, whichever client caused it. Only recent completions are
          -- still charged on top of the counter.
          THEN CASE WHEN finished_at <= ${sampled}::timestamptz - ${meterSettleInterval}
            THEN 0 ELSE greatest(estimate_bytes, least(reserved_bytes, 500000)) END
          ELSE reserved_bytes END), 0) AS unresolved,
        -- Every charge in the period, settled or not, for attribution evidence.
        coalesce(sum(
          CASE WHEN (outcome = 'completed' OR (outcome = 'deferred' AND operation LIKE 'recovery%')) AND estimate_bytes IS NOT NULL
            THEN greatest(estimate_bytes, least(reserved_bytes, 500000))
            ELSE reserved_bytes END), 0) AS charged,
        max(reported_bytes) FILTER (WHERE period_start = ${period}::timestamptz) AS high_water,
        min(reported_bytes) FILTER (WHERE period_start = ${period}::timestamptz) AS initial
      FROM ${table}
      WHERE period_start = ${period}::timestamptz OR
        (period_start < ${period}::timestamptz AND started_at + interval '2 hours' >= ${period}::timestamptz)
    ), state AS (
      SELECT EXISTS (SELECT FROM ${table} WHERE request_key = ${sqlLiteral(request)}
        AND (outcome = 'completed' OR (outcome = 'running' AND started_at > clock_timestamp() - interval '2 hours')))
        AS duplicate,
        EXISTS (SELECT FROM ${table} WHERE request_key = ${sqlLiteral(request)} AND outcome = 'completed')
        AS equivalent_completed,
        NOT EXISTS (SELECT FROM ${table}
          WHERE (period_start = ${period}::timestamptz AND reset_at <> ${reset}::timestamptz)
             OR (period_start < ${period}::timestamptz AND reset_at > ${period}::timestamptz)
             OR period_start > ${period}::timestamptz) AS period_compatible
    ), decision AS (
      SELECT *, ${meter.transferBytes} >= coalesce(high_water, 0) AND period_compatible AND
        clock_timestamp() >= ${sampled}::timestamptz AND
        (${useCutover} OR clock_timestamp() <= ${sampled}::timestamptz + interval '5 minutes') AND
        clock_timestamp() + interval '2 hours' < ${reset}::timestamptz AS valid,
        NOT duplicate AND ${meter.transferBytes} + unresolved + ${reserved} <= ${limits.ceiling_bytes} AS fits
      FROM balance, state
    ), observed AS (
      INSERT INTO ${table}
        (attempt_id, request_key, operation, source_revision, reason, period_start, reset_at, sampled_at, sample_origin,
         reported_bytes, reserved_bytes, outcome, finished_at)
      SELECT ${sqlLiteral(id)}::uuid, ${sqlLiteral(request)}, ${sqlLiteral(operation)}, ${revision ? sqlLiteral(revision) : "NULL"},
        ${sqlLiteral(reason)}, ${period}, ${reset}, ${sampled}, ${sqlLiteral(meter.sampleOrigin ?? "live")}, ${meter.transferBytes},
        CASE WHEN fits THEN ${reserved} ELSE 0 END,
        CASE WHEN fits THEN 'running' ELSE 'deferred' END, CASE WHEN NOT fits THEN clock_timestamp() END
      FROM decision WHERE valid
      RETURNING attempt_id, outcome, started_at
    )
    SELECT json_build_object('attempt_id', (SELECT attempt_id FROM observed WHERE outcome = 'running'), 'duplicate', duplicate, 'equivalent_completed', equivalent_completed,
      'started_at', (SELECT started_at FROM observed WHERE outcome = 'running'),
      'prior_meter_high_water_bytes', high_water, 'unreconciled_bytes', unresolved,
      'provider_growth_since_accounting_bytes', CASE WHEN NOT ${useCutover} THEN ${meter.transferBytes} - initial END,
      'unattributed_growth_lower_bound_bytes', CASE WHEN NOT ${useCutover} AND initial IS NOT NULL
        THEN greatest(0, ${meter.transferBytes} - initial - charged) END,
      'unattributed_exact_bytes', NULL, 'reason',
        CASE WHEN NOT period_compatible THEN 'overlapping-provider-period'
          WHEN ${meter.transferBytes} < coalesce(high_water, 0) THEN 'counter-regressed'
          WHEN duplicate THEN 'equivalent-request'
          WHEN EXISTS (SELECT FROM observed WHERE outcome = 'running') THEN 'admitted'
          ELSE 'allowance-or-sample-window' END)
    FROM decision;`,
    { executor: operation === "intake" || input.executor === true },
  ) as {
    attempt_id: string | null;
    started_at: string | null;
    duplicate: boolean;
    equivalent_completed: boolean;
    prior_meter_high_water_bytes: number | null;
    unreconciled_bytes: number;
    provider_growth_since_accounting_bytes: number | null;
    reason: string;
  };
  return {
    ...status,
    ...limits,
    meter,
    operation,
    request,
    revision,
    trigger: reason,
    remaining_bytes: useCutover ? null : transferLimit - meter.transferBytes,
    sampled_remaining_bytes: transferLimit - meter.transferBytes,
    available_after_reserves_bytes:
      limits.ceiling_bytes - meter.transferBytes - status.unreconciled_bytes,
    retry_at: meter.resetAt,
  };
}

function recordEvidence(environment: NodeJS.ProcessEnv, evidence: unknown) {
  const output = environment.PORTCOVE_MAINTENANCE_RESOURCE_EVIDENCE;
  const body = JSON.stringify(evidence);
  if (output) appendFileSync(output, `${body}\n`);
  else process.stderr.write(`${body}\n`);
}

export async function withMaintenanceAdmission<T>(
  environment: NodeJS.ProcessEnv,
  operation: MaintenanceOperation,
  /** Receives the admitted bytes and the time by which its transfer must finish. */
  callback: (bytes: number, deadline: number) => Promise<T> | T,
  options: {
    estimate?: (value: T) => number;
    request?: string | undefined;
    completed?: (value: T) => boolean;
    bootstrap?: boolean;
    executor?: boolean;
    /** Expected reservation; only an explicitly fenced discovery plan can lower the default. */
    reservationBytes?: number;
    measuredDiscovery?: boolean;
  } = {},
): Promise<T> {
  operationReservation(operation, options.reservationBytes, options.measuredDiscovery);
  if (!isNeon(environment))
    return await callback(
      operationReservation(operation, options.reservationBytes, options.measuredDiscovery),
      Number.POSITIVE_INFINITY,
    );
  const revision = environment.GITHUB_SHA ?? environment.PORTCOVE_SOURCE_REVISION;
  const run = environment.GITHUB_RUN_ID;
  const reason = [
    environment.GITHUB_EVENT_NAME ?? "local",
    environment.PORTCOVE_MAINTENANCE_PURPOSE ?? operation,
    environment.GITHUB_RUN_ATTEMPT,
  ]
    .filter(Boolean)
    .join("/");
  // A collection is committed in PostgreSQL. A backup may still fail upload
  // after local completion, so a new delivery attempt must be able to retry.
  const delivery = operation.startsWith("recovery")
    ? `:${environment.GITHUB_RUN_ATTEMPT ?? "1"}`
    : "";
  const request =
    options.request ??
    (run
      ? `github:${run}:${operation}:${revision ?? "unknown"}${delivery}`
      : `local:${randomUUID()}`);
  let meter: NeonMeter;
  try {
    meter = cutoverReading(environment, operation) ?? (await sampleNeon(environment));
  } catch (error) {
    recordEvidence(environment, {
      operation,
      request,
      revision,
      reason,
      outcome: "deferred",
      detail: error instanceof Error ? error.message : "metadata error",
      retry: "next current Free provider reading",
    });
    throw new MaintenanceResourceDeferred("Current Neon metadata is unavailable");
  }
  const status =
    operation === "intake"
      ? {
          schema_version: queryJson(
            environment,
            "SELECT coalesce(max(version), 0) FROM portcove_maintenance_meta.schema_migrations;",
            { executor: true },
          ) as number,
          pending: [],
          problems: [],
        }
      : migrationStatus(environment, undefined, options.executor);
  // One known small deployment migration can create its own admission table.
  if (
    options.bootstrap === true &&
    status.schema_version === 5 &&
    status.pending.length === 1 &&
    status.pending[0]?.version === 6 &&
    status.problems.length === 0 &&
    meter.transferBytes <= transferLimit - emergencyReserve - bootstrapAllowance
  )
    migrate(environment);
  else if (status.schema_version < 6 || status.problems.length) {
    recordEvidence(environment, {
      operation,
      request,
      revision,
      reason,
      meter,
      outcome: "deferred",
      retry: "scheduled maintenance admission migration completes",
    });
    throw new MaintenanceResourceDeferred("Maintenance admission schema is not ready");
  }
  const executor = operation === "intake" || options.executor === true;
  const admission = acquireMaintenanceReservation(environment, {
    meter,
    executor,
    operation,
    request,
    revision,
    reason,
    reservationBytes: options.reservationBytes,
    measuredDiscovery: options.measuredDiscovery,
  });
  const coalesced =
    admission.reason === "equivalent-request" &&
    admission.equivalent_completed &&
    options.request?.startsWith("github:catalog-only:");
  recordEvidence(environment, {
    ...admission,
    outcome: admission.attempt_id ? "admitted" : coalesced ? "coalesced" : "deferred",
  });
  if (coalesced) throw new MaintenanceRequestCoalesced(admission.reason);
  if (!admission.attempt_id) throw new MaintenanceResourceDeferred(admission.reason);
  let outcome = "failed";
  let estimate: number | undefined;
  const measurement = {
    host: environment.PGHOST!,
    payloadBytes: 0,
    byteLimit: Math.floor(admission.operation_reservation_bytes * 0.7),
    deadline: Math.min(
      Date.parse(admission.started_at!) + admissionTimeout,
      Date.parse(meter.resetAt) - 60_000,
    ),
  };
  try {
    const value = await maintenanceTransfer.run(measurement, () =>
      callback(admission.operation_reservation_bytes, measurement.deadline),
    );
    estimate = options.estimate?.(value) ?? 200_000 + Math.ceil(measurement.payloadBytes * 1.3);
    if (estimate !== undefined && (!Number.isSafeInteger(estimate) || estimate < 0))
      throw new MaintenanceStoreError("Invalid maintenance transfer estimate");
    outcome = options.completed?.(value) === false ? "failed" : "completed";
    return value;
  } catch (error) {
    if (operation.startsWith("recovery") && error instanceof MaintenanceBackupDeferred) {
      // This exception is produced only before any file export. All prior
      // production reads used measured SQL responses; unknown failures keep
      // their entire reservation. Retain conservative command/protocol margin.
      outcome = "deferred";
      estimate = 2_000_000 + Math.ceil(measurement.payloadBytes * 1.3);
    }
    throw error;
  } finally {
    runSql(
      environment,
      `UPDATE portcove_maintenance_meta.resource_admissions
      SET outcome = ${sqlLiteral(outcome)}, finished_at = clock_timestamp(), estimate_bytes = ${estimate ?? "NULL"}
      WHERE attempt_id = ${sqlLiteral(admission.attempt_id)}::uuid AND outcome = 'running';`,
      { executor },
    );
    recordEvidence(environment, {
      operation,
      request,
      revision,
      reason,
      outcome,
      attempt_id: admission.attempt_id,
      estimate_bytes: estimate ?? null,
      method:
        estimate === undefined
          ? "reservation; command bytes unknown"
          : "conservative logical payload with protocol allowance",
    });
  }
}

export function writeResourceProbe(environment: NodeJS.ProcessEnv, file: string) {
  return withMaintenanceAdmission(environment, "inspect", () => {
    const status = migrationStatus(environment);
    writeFileSync(file, JSON.stringify(status, null, 2) + "\n", { flag: "wx" });
    return status;
  });
}
