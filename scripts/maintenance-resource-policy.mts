import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
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
export const transferLimit = 5_000 * mb;
const day = 86_400_000;
const admissionTimeout = 2 * 60 * 60 * 1000;
const sampleLifetime = 5 * 60 * 1000;
const bootstrapAllowance = 5 * mb;
const recoveryDailyForecast = 22 * mb;
const normalReserve = 2_000 * mb;
const emergencyReserve = 350 * mb;
const transitionReset = "2026-12-01T00:00:00.000Z";

const costs = {
  collect: 18 * mb,
  report: 70 * mb,
  handoffs: 8 * mb,
  digest: 16 * mb,
  recovery: 48 * mb,
  "recovery-full": 440 * mb,
  inspect: 2 * mb,
  intake: 18 * mb,
} as const;

export type MaintenanceOperation = keyof typeof costs;

export interface NeonMeter {
  periodStart: string;
  resetAt: string;
  sampledAt: string;
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
    branch.id !== "br-frosty-bar-bbaitwbu" ||
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
    transferBytes,
    computeSeconds: asCounter(project.compute_time_seconds),
    activeSeconds: asCounter(project.active_time_seconds),
    storageBytes: asCounter(branch.logical_size),
    branchTransferBytes: asCounter(branch.data_transfer_bytes),
  };
}

export async function sampleNeon(environment: NodeJS.ProcessEnv): Promise<NeonMeter> {
  const token = environment.PORTCOVE_NEON_METER_TOKEN;
  if (!token) throw new MaintenanceStoreError("Missing PORTCOVE_NEON_METER_TOKEN");
  const base = `https://console.neon.tech/api/v2/projects/${neonProject}`;
  const read = async (suffix: string) => {
    const response = await fetch(base + suffix, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new MaintenanceStoreError(`Neon metadata returned HTTP ${response.status}`);
    return await response.json();
  };
  const sampledAt = new Date().toISOString();
  const [{ project }, { branch }, { endpoints }] = await Promise.all([
    read(""),
    read("/branches/br-frosty-bar-bbaitwbu"),
    read("/endpoints"),
  ]);
  if (project?.effective_project_permission !== "VIEWER")
    throw new MaintenanceStoreError("Neon meter needs a project Viewer credential");
  const host = environment.PGHOST?.replace(/-pooler(?=\.)/u, "").toLowerCase();
  if (
    !Array.isArray(endpoints) ||
    !endpoints.some(
      (endpoint) => endpoint.host === host && endpoint.branch_id === "br-frosty-bar-bbaitwbu",
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

export function policyLimits(meter: NeonMeter, operation: MaintenanceOperation, now: number) {
  const days = Math.max(0, Math.ceil((Date.parse(meter.resetAt) - now) / day) - 1);
  const recovery = operation === "recovery" || operation === "recovery-full";
  const reserve =
    meter.resetAt === transitionReset
      ? emergencyReserve
      : recovery
        ? emergencyReserve
        : normalReserve;
  const scheduled = days * recoveryDailyForecast + (recovery ? 0 : costs.recovery);
  return {
    reserve_bytes: reserve,
    future_daily_recovery_bytes: scheduled,
    operation_reservation_bytes: costs[operation],
    ceiling_bytes: transferLimit - reserve - scheduled - bootstrapAllowance,
    recurring_monthly_projection_bytes: 31 * (recoveryDailyForecast + costs.collect),
    development_burst_projection_bytes: 15 * costs.collect + 15 * costs.inspect,
  };
}

export class MaintenanceResourceDeferred extends MaintenanceStoreError {}

export function acquireMaintenanceReservation(
  environment: NodeJS.ProcessEnv,
  input: {
    meter: NeonMeter;
    operation: MaintenanceOperation;
    request: string;
    revision?: string;
    reason: string;
    now?: number;
  },
) {
  const { meter, operation, request, revision, reason } = input;
  const now = input.now ?? Date.now();
  const limits = policyLimits(meter, operation, now);
  const age = now - Date.parse(meter.sampledAt);
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > sampleLifetime ||
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
        CASE WHEN outcome = 'completed' AND estimate_bytes IS NOT NULL
          THEN greatest(estimate_bytes, least(reserved_bytes, 500000))
          ELSE reserved_bytes END), 0) AS unresolved,
        max(reported_bytes) FILTER (WHERE period_start = ${period}::timestamptz) AS high_water,
        min(reported_bytes) FILTER (WHERE period_start = ${period}::timestamptz) AS initial
      FROM ${table}
      WHERE period_start = ${period}::timestamptz OR
        (period_start < ${period}::timestamptz AND started_at + interval '2 hours' >= ${period}::timestamptz)
    ), request AS (
      SELECT EXISTS (SELECT FROM ${table} WHERE request_key = ${sqlLiteral(request)}
        AND (outcome = 'completed' OR (outcome = 'running' AND started_at > clock_timestamp() - interval '2 hours')))
        AS duplicate
    ), admitted AS (
      INSERT INTO ${table}
        (attempt_id, request_key, operation, source_revision, reason, period_start, reset_at, sampled_at, reported_bytes, reserved_bytes)
      SELECT ${sqlLiteral(id)}::uuid, ${sqlLiteral(request)}, ${sqlLiteral(operation)}, ${revision ? sqlLiteral(revision) : "NULL"},
        ${sqlLiteral(reason)}, ${period}, ${reset}, ${sampled}, ${meter.transferBytes}, ${costs[operation]}
      FROM balance, request
      WHERE NOT duplicate
        AND ${meter.transferBytes} >= coalesce(high_water, 0)
        AND clock_timestamp() BETWEEN ${sampled}::timestamptz AND ${sampled}::timestamptz + interval '5 minutes'
        AND clock_timestamp() + interval '2 hours' < ${reset}::timestamptz
        AND ${meter.transferBytes} + unresolved + ${costs[operation]} <= ${limits.ceiling_bytes}
      RETURNING attempt_id
    )
    SELECT json_build_object('attempt_id', (SELECT attempt_id FROM admitted), 'duplicate', duplicate,
      'prior_meter_high_water_bytes', high_water, 'unreconciled_bytes', unresolved,
      'provider_growth_since_accounting_bytes', ${meter.transferBytes} - initial,
      'unattributed_growth_lower_bound_bytes', CASE WHEN initial IS NOT NULL
        THEN greatest(0, ${meter.transferBytes} - initial - unresolved) END,
      'unattributed_exact_bytes', NULL, 'reason',
        CASE WHEN duplicate THEN 'equivalent-request'
          WHEN ${meter.transferBytes} < coalesce(high_water, 0) THEN 'counter-regressed'
          WHEN EXISTS (SELECT FROM admitted) THEN 'admitted'
          ELSE 'allowance-or-sample-window' END)
    FROM balance, request;`,
  ) as {
    attempt_id: string | null;
    duplicate: boolean;
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
    remaining_bytes: transferLimit - meter.transferBytes,
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
  callback: (bytes: number) => Promise<T> | T,
  options: {
    estimate?: (value: T) => number;
    request?: string;
    completed?: (value: T) => boolean;
  } = {},
): Promise<T> {
  if (!isNeon(environment)) return await callback(costs[operation]);
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
    meter = await sampleNeon(environment);
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
  const status = migrationStatus(environment);
  // One known small deployment migration can create its own admission table.
  if (
    operation !== "intake" &&
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
  const admission = acquireMaintenanceReservation(environment, {
    meter,
    operation,
    request,
    revision,
    reason,
  });
  recordEvidence(environment, {
    ...admission,
    outcome: admission.attempt_id ? "admitted" : "deferred",
  });
  if (!admission.attempt_id) throw new MaintenanceResourceDeferred(admission.reason);
  let outcome = "failed";
  let estimate: number | undefined;
  try {
    const measurement = {
      host: environment.PGHOST!,
      payloadBytes: 0,
      byteLimit: Math.floor(admission.operation_reservation_bytes * 0.7),
    };
    const value = await maintenanceTransfer.run(measurement, () =>
      callback(admission.operation_reservation_bytes),
    );
    estimate = options.estimate?.(value) ?? 200_000 + Math.ceil(measurement.payloadBytes * 1.3);
    if (estimate !== undefined && (!Number.isSafeInteger(estimate) || estimate < 0))
      throw new MaintenanceStoreError("Invalid maintenance transfer estimate");
    outcome = options.completed?.(value) === false ? "failed" : "completed";
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === "MaintenanceBackupDeferred") outcome = "deferred";
    throw error;
  } finally {
    runSql(
      environment,
      `UPDATE portcove_maintenance_meta.resource_admissions
      SET outcome = ${sqlLiteral(outcome)}, finished_at = clock_timestamp(), estimate_bytes = ${estimate ?? "NULL"}
      WHERE attempt_id = ${sqlLiteral(admission.attempt_id)}::uuid AND outcome = 'running';`,
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
