import { createHash } from "node:crypto";
import { MaintenanceStoreError, runSql, sqlLiteral } from "./maintenance-store.mts";

/**
 * PostgreSQL adapter for unattended discovery collection (migration 0007).
 * Every write goes through a fenced database function that verifies the lease,
 * the restore-scoped activation generation and the expected state revision.
 */

export interface DiscoveryProviderObservation {
  provider: "github";
  provider_id: string;
  parser_version: number;
  content_sha256: string;
  repository: string;
  facts: Record<string, unknown>;
}

export type DiscoveryWatchReason =
  | "no-native-package"
  | "identity-unresolved"
  | "source-unavailable";

export interface DiscoveryWatchChange {
  provider: "github";
  provider_id: string;
  reason: DiscoveryWatchReason;
  status: "waiting" | "due" | "resolved";
  evidence_sha256: string;
  wake: string;
}

export interface DiscoveryLeaseGrant {
  revision: number;
  state: Record<string, unknown>;
  state_sha256: string;
  definition_sha256: string;
  acquisition: number;
  generation: number;
  /** Bytes the acquire read returned, for transfer accounting. */
  received_bytes?: number;
}

export interface DiscoveryLease {
  scope: string;
  attempt: string;
  token: string;
}

/** Why the store refused a write; each is a resumable boundary, never evidence about a source. */
export class DiscoveryStoreRefused extends MaintenanceStoreError {
  readonly reason: "inactive" | "leased" | "stale-writer";
  constructor(reason: DiscoveryStoreRefused["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface DiscoveryStore {
  acquire(
    lease: DiscoveryLease,
    options: { leaseSeconds: number; definition: string; sourceRevision: string; runner: string },
  ): DiscoveryLeaseGrant;
  commit(
    lease: DiscoveryLease,
    expectedRevision: number,
    options: {
      definition: string;
      leaseSeconds: number;
      state: Record<string, unknown>;
      observations: readonly DiscoveryProviderObservation[];
      watches: readonly DiscoveryWatchChange[];
      /** Lead records that changed since the last commit; each carries its numeric `id`. */
      leadRecords: readonly { id: number }[];
    },
  ): { revision: number; bytes: number };
  /** The scope's stored lead records, read after acquire. */
  loadLeadRecords(scope: string): { records: unknown[]; bytes: number };
  finish(
    lease: DiscoveryLease,
    outcome: "complete" | "partial" | "failed",
    summary: Record<string, unknown>,
  ): void;
}

export const discoveryStateDigest = (state: unknown) =>
  createHash("sha256").update(JSON.stringify(state)).digest("hex");

function classify(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/portcove-discovery-inactive/u.test(message))
    throw new DiscoveryStoreRefused(
      "inactive",
      "Discovery collection is inactive on this maintenance store",
    );
  if (/portcove-discovery-leased/u.test(message))
    throw new DiscoveryStoreRefused("leased", "Another discovery worker holds this scope's lease");
  if (/portcove-discovery-stale-writer/u.test(message))
    throw new DiscoveryStoreRefused(
      "stale-writer",
      "This discovery attempt no longer holds its lease; a newer owner or restore took over",
    );
  throw error;
}

const uuid = (value: string) => `${sqlLiteral(value)}::uuid`;

export function postgresDiscoveryStore(environment: NodeJS.ProcessEnv): DiscoveryStore {
  return {
    acquire(lease, options) {
      try {
        const output = runSql(
          environment,
          `SELECT portcove_maintenance.discovery_acquire(${sqlLiteral(lease.scope)}, ${uuid(lease.attempt)},
            ${uuid(lease.token)}, ${options.leaseSeconds}, ${sqlLiteral(options.definition)},
            ${sqlLiteral(options.sourceRevision)}, ${sqlLiteral(options.runner)})::text;`,
        ).trim();
        const grant = JSON.parse(output) as DiscoveryLeaseGrant;
        return {
          ...grant,
          revision: Number(grant.revision),
          acquisition: Number(grant.acquisition),
          received_bytes: Buffer.byteLength(output),
        };
      } catch (error) {
        return classify(error);
      }
    },
    commit(lease, expectedRevision, options) {
      const sql = `SELECT portcove_maintenance.discovery_commit(${sqlLiteral(lease.scope)},
        ${uuid(lease.attempt)}, ${uuid(lease.token)}, ${expectedRevision},
        ${sqlLiteral(options.definition)}, ${sqlLiteral(JSON.stringify(options.state))}::jsonb,
        ${options.leaseSeconds}, ${sqlLiteral(JSON.stringify(options.observations))}::jsonb,
        ${sqlLiteral(JSON.stringify(options.watches))}::jsonb,
        ${sqlLiteral(JSON.stringify(options.leadRecords))}::jsonb);`;
      try {
        const revision = Number(runSql(environment, sql, { timeoutMs: 300_000 }).trim());
        if (revision !== expectedRevision + 1)
          throw new MaintenanceStoreError("Discovery commit returned an unexpected revision");
        return { revision, bytes: Buffer.byteLength(sql) };
      } catch (error) {
        return classify(error);
      }
    },
    loadLeadRecords(scope) {
      const output = runSql(
        environment,
        `SET TRANSACTION READ ONLY;
         SELECT coalesce(json_agg(record ORDER BY lead_id), '[]')::text
           FROM portcove_maintenance.discovery_lead_records WHERE scope = ${sqlLiteral(scope)};`,
        { timeoutMs: 300_000 },
      ).trim();
      const records: unknown = JSON.parse(output);
      if (!Array.isArray(records))
        throw new MaintenanceStoreError("Malformed discovery lead records");
      return { records, bytes: Buffer.byteLength(output) };
    },
    finish(lease, outcome, summary) {
      try {
        runSql(
          environment,
          `SELECT portcove_maintenance.discovery_finish(${sqlLiteral(lease.scope)}, ${uuid(lease.attempt)},
            ${uuid(lease.token)}, ${sqlLiteral(outcome)}, ${sqlLiteral(JSON.stringify(summary))}::jsonb);`,
        );
      } catch (error) {
        classify(error);
      }
    },
  };
}

/** Read-only status export for the hosted researcher and the maintenance report. */
export function discoveryStatusQuery(limits: { attempts: number }) {
  return `SET TRANSACTION READ ONLY;
SELECT json_build_object(
  'activation', (SELECT json_build_object('active', collection_active, 'generation', collection_generation)
    FROM portcove_maintenance_meta.discovery_intake_activation),
  'scopes', coalesce((SELECT json_agg(json_build_object(
      'scope', scope, 'revision', revision, 'definition_sha256', definition_sha256,
      'state_sha256', state_sha256, 'updated_at', updated_at,
      'leased_until', lease_expires_at) ORDER BY scope COLLATE "C")
    FROM portcove_maintenance.discovery_collection_state), '[]'),
  'attempts', coalesce((SELECT json_agg(a ORDER BY a.acquisition DESC) FROM (
      SELECT attempt_id, scope, acquisition, collection_generation, source_revision, runner,
        started_at, finished_at, outcome, committed_pages, result
      FROM portcove_maintenance.discovery_collection_attempts
      ORDER BY acquisition DESC LIMIT ${limits.attempts}) a), '[]'),
  'observations', json_build_object(
    'rows', (SELECT count(*) FROM portcove_maintenance.discovery_observations),
    'subjects', (SELECT count(DISTINCT (provider, provider_id)) FROM portcove_maintenance.discovery_observations),
    'latest_attempt_new_rows', (SELECT count(*) FROM portcove_maintenance.discovery_observations o
      WHERE o.first_attempt_id = (SELECT attempt_id FROM portcove_maintenance.discovery_collection_attempts
        ORDER BY acquisition DESC LIMIT 1)),
    -- A run is every pass (attempt) with the latest attempt's runner identity.
    'latest_run_new_rows', (SELECT count(*) FROM portcove_maintenance.discovery_observations o
      JOIN portcove_maintenance.discovery_collection_attempts a ON a.attempt_id = o.first_attempt_id
      WHERE a.runner = (SELECT runner FROM portcove_maintenance.discovery_collection_attempts
        ORDER BY acquisition DESC LIMIT 1))),
  'latest_run', (SELECT json_build_object('runner', runner, 'passes', count(*),
      'committed_pages', sum(committed_pages), 'started_at', min(started_at),
      'finished_at', max(finished_at),
      'outcomes', json_agg(outcome ORDER BY acquisition))
    FROM portcove_maintenance.discovery_collection_attempts
    WHERE runner = (SELECT runner FROM portcove_maintenance.discovery_collection_attempts
      ORDER BY acquisition DESC LIMIT 1)
    GROUP BY runner),
  'watches', json_build_object(
    'by_reason', coalesce((SELECT json_object_agg(reason || ':' || status, n) FROM (
      SELECT reason, status, count(*) AS n FROM portcove_maintenance.discovery_watches
      GROUP BY reason, status) w), '{}'),
    'due', coalesce((SELECT json_agg(d) FROM (
      SELECT w.provider, w.provider_id, w.reason, w.generation, w.wake, w.updated_at,
        (SELECT o.repository FROM portcove_maintenance.discovery_observations o
          WHERE o.provider = w.provider AND o.provider_id = w.provider_id
          ORDER BY o.first_seen_at DESC LIMIT 1) AS repository
      FROM portcove_maintenance.discovery_watches w WHERE w.status = 'due'
      ORDER BY w.updated_at, w.provider_id) d), '[]'))
)::text;`;
}
