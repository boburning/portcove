import { createHash } from "node:crypto";
import {
  MaintenanceStoreError,
  outputLimitBytes,
  runSql,
  sqlLiteral,
} from "./maintenance-store.mts";
import { isRecord } from "./runtime-values.mts";

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
  /** Digest of the stored compact continuation, before normalized hint hydration. */
  state_sha256: string;
  definition_sha256: string;
  acquisition: number;
  generation: number;
  /** Bytes the acquire read returned, for transfer accounting. */
  received_bytes?: number;
  /**
   * Set when the caller's known revision, generation and definition still match:
   * the store omitted the state and lead records, which the caller already holds.
   */
  unchanged?: true;
}

/** A committed revision the caller still holds in full, state and lead records. */
export interface DiscoveryKnownRevision {
  revision: number;
  generation: number;
  definition: string;
  /** The attempt whose commit produced this revision; unique across restores. */
  attempt: string;
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
    options: {
      leaseSeconds: number;
      definition: string;
      sourceRevision: string;
      runner: string;
      known?: DiscoveryKnownRevision;
    },
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
  ): { revision: number; bytes: number; received_bytes?: number };
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

/** Snapshot the serialized hints so in-place mutations by the collector cannot
 * alter the comparison baseline. Missing external state represents no hints. */
function hintBaseline(state: Record<string, unknown>) {
  const leads = isRecord(state.leads) ? state.leads : undefined;
  const external = isRecord(leads?.external) ? leads.external : undefined;
  if (external && !isRecord(external.hints))
    throw new MaintenanceStoreError("Missing complete external hints");
  return new Map(Object.entries(external?.hints ?? {}).map(([key, hint]) => [key, JSON.stringify(hint)]));
}

export function externalHintDelta(
  before: ReadonlyMap<string, string>,
  state: Record<string, unknown>,
) {
  const after = hintBaseline(state);
  const compact = { ...state };
  if (isRecord(state.leads) && isRecord(state.leads.external)) {
    const { hints: _hints, ...external } = state.leads.external;
    compact.leads = { ...state.leads, external };
  }
  return {
    compact,
    after,
    changed: Object.fromEntries([...after].filter(([key, hint]) => before.get(key) !== hint)
      .map(([key, hint]) => [key, JSON.parse(hint) as unknown])),
    removed: [...before.keys()].filter((key) => !after.has(key)),
  };
}

// Only these reviewed table/column pairs may participate in seed reads.
const seedTables = {
  hints: { table: "discovery_external_hints", key: "hint_key", value: "hint" },
  leads: { table: "discovery_lead_records", key: "lead_id", value: "record" },
} as const;
type SeedRowKind = keyof typeof seedTables;

/** Local PostgreSQL computes fingerprints from the actual seed values, using
 * the same jsonb serialization as production. The seed is not authoritative:
 * changed/new rows come from production and absent keys are removed. */
function loadSeedRows(
  environment: NodeJS.ProcessEnv,
  seed: NodeJS.ProcessEnv,
  scope: string,
  kind: SeedRowKind,
  pageBytes: number,
): SeedRows | null {
  if (!seed.PGHOST?.startsWith("/") || seed.PGHOST === environment.PGHOST &&
    seed.PGPORT === environment.PGPORT && seed.PGDATABASE === environment.PGDATABASE ||
    seed.PGOPTIONS || seed.PGSERVICE)
    throw new MaintenanceStoreError("Discovery seed must be an independent local database");
  const { table, key, value } = seedTables[kind];
  const relation = "portcove_maintenance." + table;
  let local: string;
  try {
    local = runSql(seed, `SET TRANSACTION READ ONLY;
    WITH rows AS (
      SELECT coalesce(jsonb_object_agg(${key}::text, jsonb_build_object(
        'value', ${value}, 'sha', encode(sha256(convert_to(${value}::text, 'UTF8')), 'hex')
      )), '{}'::jsonb) AS data FROM ${relation} WHERE scope = ${sqlLiteral(scope)}
    ) SELECT CASE WHEN octet_length(data::text) <= ${pageBytes} THEN data ELSE 'null'::jsonb END FROM rows;`).trim();
  } catch {
    // An optional local seed cannot suppress an authoritative complete read.
    return null;
  }
  const cached: unknown = JSON.parse(local);
  if (cached === null) return null;
  if (!isRecord(cached)) throw new MaintenanceStoreError("Malformed local seed rows");
  const hashes: Record<string, string> = Object.create(null);
  const rows: Record<string, unknown> = Object.create(null);
  for (const [id, row] of Object.entries(cached)) {
    if (!isRecord(row) || !isRecord(row.value) || typeof row.sha !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha))
      throw new MaintenanceStoreError("Malformed local seed fingerprint");
    hashes[id] = row.sha;
    rows[id] = row.value;
  }
  return { hashes, rows };
}

type SeedRows = { hashes: Record<string, string>; rows: Record<string, unknown> };

/** Use exactly the same delta expression for the measurement and the read. */
function seededDeltaSql(scope: string, kind: SeedRowKind, hashes: Record<string, string>) {
  const { table, key, value } = seedTables[kind];
  return `WITH local AS (SELECT key, value AS sha FROM jsonb_each_text(${sqlLiteral(JSON.stringify(hashes))}::jsonb)),
    remote AS (
      SELECT ${key}::text AS key, ${value} AS value,
        encode(sha256(convert_to(${value}::text, 'UTF8')), 'hex') AS sha
      FROM portcove_maintenance.${table} WHERE scope = ${sqlLiteral(scope)}
    )
    SELECT jsonb_build_object(
      'changed', coalesce(jsonb_object_agg(r.key, r.value) FILTER (WHERE r.key IS NOT NULL), '{}'::jsonb),
      'removed', coalesce(jsonb_agg(l.key) FILTER (WHERE r.key IS NULL), '[]'::jsonb)
    ) AS data FROM local l FULL JOIN remote r USING (key) WHERE l.sha IS DISTINCT FROM r.sha`;
}

export interface DiscoverySeedPlan {
  scope: string;
  revision: number;
  generation: number;
  definition: string;
  compactBytes: number;
  hintsBytes: number;
  leadsBytes: number;
  hints: SeedRows;
  leads: SeedRows;
}

/** Read only byte counts and a revision fence, not actual production payloads.
 * Both delta estimates and the fence are derived in one MVCC statement. */
export function measureDiscoverySeed(
  environment: NodeJS.ProcessEnv,
  seed: NodeJS.ProcessEnv,
  scope: string,
  pageBytes = Math.floor(outputLimitBytes / 2),
): DiscoverySeedPlan | null {
  const hints = loadSeedRows(environment, seed, scope, "hints", pageBytes);
  const leads = loadSeedRows(environment, seed, scope, "leads", pageBytes);
  if (!hints || !leads) return null;
  const raw = runSql(environment, `SET TRANSACTION READ ONLY;
    SELECT coalesce((SELECT jsonb_build_object(
      'revision', s.revision, 'generation', a.collection_generation,
      'definition', s.definition_sha256, 'compactBytes', octet_length(s.state::text),
      'hintsBytes', (SELECT octet_length(data::text) FROM (${seededDeltaSql(scope, "hints", hints.hashes)}) h),
      'leadsBytes', (SELECT octet_length(data::text) FROM (${seededDeltaSql(scope, "leads", leads.hashes)}) l)
    ) FROM portcove_maintenance.discovery_collection_state s
      CROSS JOIN portcove_maintenance_meta.discovery_intake_activation a
      WHERE s.scope = ${sqlLiteral(scope)}), 'null'::jsonb)::text;`,
    { timeoutMs: 300_000 }).trim();
  const plan: unknown = JSON.parse(raw);
  if (plan === null) return null;
  if (!isRecord(plan) || typeof plan.definition !== "string" ||
    ![plan.revision, plan.generation, plan.compactBytes, plan.hintsBytes, plan.leadsBytes]
      .every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0))
    throw new MaintenanceStoreError("Malformed discovery seed measurement");
  if (Number(plan.hintsBytes) > pageBytes || Number(plan.leadsBytes) > pageBytes ||
      Number(plan.compactBytes) > pageBytes) return null;
  return {
    scope, revision: Number(plan.revision), generation: Number(plan.generation),
    definition: plan.definition, compactBytes: Number(plan.compactBytes),
    hintsBytes: Number(plan.hintsBytes), leadsBytes: Number(plan.leadsBytes), hints, leads,
  };
}

export function readSeededDiscoveryRows(
  environment: NodeJS.ProcessEnv,
  seed: NodeJS.ProcessEnv,
  scope: string,
  kind: SeedRowKind,
  pageBytes: number,
  planned?: SeedRows,
): { rows: Record<string, unknown>; bytes: number } | null {
  const baseline = planned ?? loadSeedRows(environment, seed, scope, kind, pageBytes);
  if (!baseline) return null;
  const rows = Object.assign(Object.create(null) as Record<string, unknown>, baseline.rows);
  const output = runSql(environment, `SET TRANSACTION READ ONLY;
    SELECT CASE WHEN octet_length(data::text) <= ${pageBytes} THEN data ELSE 'null'::jsonb END
    FROM (${seededDeltaSql(scope, kind, baseline.hashes)}) delta;`, { timeoutMs: 300_000 }).trim();
  const delta: unknown = JSON.parse(output);
  if (delta === null) return null;
  if (!isRecord(delta) || !isRecord(delta.changed) || !Array.isArray(delta.removed) ||
    delta.removed.some((id) => typeof id !== "string"))
    throw new MaintenanceStoreError("Malformed production discovery delta");
  for (const id of delta.removed as string[]) delete rows[id];
  for (const [id, row] of Object.entries(delta.changed)) rows[id] = row;
  return { rows: Object.fromEntries(Object.entries(rows)), bytes: Buffer.byteLength(output) };
}

function loadExternalHints(environment: NodeJS.ProcessEnv, scope: string, pageBytes: number) {
  const rows: Record<string, unknown> = Object.create(null);
  let bytes = 0;
  let after: string | undefined;
  for (;;) {
    const output = runSql(environment, `SET TRANSACTION READ ONLY;
      WITH ordered AS (
        SELECT hint_key, hint, sum(octet_length(hint::text) + octet_length(to_jsonb(hint_key)::text) + 16)
          OVER (ORDER BY hint_key COLLATE "C") AS running
        FROM portcove_maintenance.discovery_external_hints WHERE scope = ${sqlLiteral(scope)}
          ${after === undefined ? "" : `AND hint_key COLLATE "C" > ${sqlLiteral(after)} COLLATE "C"`}
      ) SELECT coalesce(json_agg(json_build_array(hint_key, hint) ORDER BY hint_key COLLATE "C"), '[]')::text
      FROM ordered WHERE running <= ${pageBytes} OR hint_key = (SELECT min(hint_key COLLATE "C") FROM ordered);`,
      { timeoutMs: 300_000 }).trim();
    bytes += Buffer.byteLength(output);
    const page: unknown = JSON.parse(output);
    if (!Array.isArray(page)) throw new MaintenanceStoreError("Malformed discovery hints");
    if (!page.length) return { rows: Object.fromEntries(Object.entries(rows)), bytes };
    for (const row of page) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || !isRecord(row[1]) ||
        after !== undefined && Buffer.compare(Buffer.from(row[0]), Buffer.from(after)) <= 0)
        throw new MaintenanceStoreError("Discovery hints are not ordered by key");
      after = row[0];
      rows[after] = row[1];
    }
  }
}

function attachExternalHints(state: Record<string, unknown>, hints: Record<string, unknown>) {
  if (isRecord(state.leads) && isRecord(state.leads.external))
    state.leads.external.hints = hints;
  else if (Object.keys(hints).length)
    throw new MaintenanceStoreError("Discovery hints have no external continuation");
}

type DiscoveryHydrationFence = {
  lease: DiscoveryLease;
  revision: number;
  generation: number;
  plan?: DiscoverySeedPlan;
};

/** Revalidate ownership after independent paged or seeded reads. */
function verifyHydrationFence(
  environment: NodeJS.ProcessEnv,
  fence: DiscoveryHydrationFence,
) {
  const { lease, revision, generation } = fence;
  const output = runSql(environment, `SET TRANSACTION READ ONLY;
    SELECT EXISTS (SELECT 1 FROM portcove_maintenance.discovery_collection_state s
      CROSS JOIN portcove_maintenance_meta.discovery_intake_activation a
      WHERE s.scope = ${sqlLiteral(lease.scope)} AND s.revision = ${revision}
        AND s.lease_token = ${uuid(lease.token)} AND s.lease_generation = ${generation}
        AND a.collection_active AND a.collection_generation = ${generation}
        AND s.lease_expires_at > clock_timestamp())::text;`).trim();
  if (output !== "true")
    throw new DiscoveryStoreRefused("stale-writer", "Discovery lease or revision moved during hydration");
  return Buffer.byteLength(output);
}

export function postgresDiscoveryStore(
  environment: NodeJS.ProcessEnv,
  /** Bytes per lead-record page; half of one client command's output by default. */
  pageBytes = Math.floor(outputLimitBytes / 2),
  seed?: NodeJS.ProcessEnv,
  plan?: DiscoverySeedPlan,
): DiscoveryStore {
  // Per-adapter cache, never an independent authority. Only an exact confirmed
  // acquisition/commit can establish the baseline for the next delta.
  const baselines = new Map<string, {
    revision: number;
    attempt: string;
    generation: number;
    definition: string;
    hints: Map<string, string>;
  }>();
  const active = new Map<string, { attempt: string; generation: number; token: string }>();
  if (plan && !seed) throw new MaintenanceStoreError("A measured discovery plan requires a seed");
  let pendingPlan = plan;
  const hydration = new Map<string, DiscoveryHydrationFence>();
  return {
    acquire(lease, options) {
      try {
        const { known } = options;
        const planned = pendingPlan?.scope === lease.scope ? pendingPlan : undefined;
        if (planned) pendingPlan = undefined;
        hydration.delete(lease.scope);
        const args = `${sqlLiteral(lease.scope)}, ${uuid(lease.attempt)}, ${uuid(lease.token)},
          ${options.leaseSeconds}, ${sqlLiteral(options.definition)},
          ${sqlLiteral(options.sourceRevision)}, ${sqlLiteral(options.runner)}`;
        const output = runSql(
          environment,
          planned
            ? `SELECT portcove_maintenance.discovery_acquire_planned(${args}, ${planned.revision},
                ${planned.generation}, ${sqlLiteral(planned.definition)}, ${planned.compactBytes})::text;`
            : known
            ? `SELECT portcove_maintenance.discovery_acquire_known(${args},
                 ${known.revision}, ${known.generation}, ${sqlLiteral(known.definition)},
                 ${uuid(known.attempt)})::text;`
            : `SELECT portcove_maintenance.discovery_acquire_seeded(${args})::text;`,
        ).trim();
        const grant = JSON.parse(output) as DiscoveryLeaseGrant;
        const revision = Number(grant.revision);
        const generation = Number(grant.generation);
        const fence: DiscoveryHydrationFence = {
          lease, revision, generation, ...(planned ? { plan: planned } : {}),
        };
        let received = Buffer.byteLength(output);
        if (!grant.unchanged) {
          try {
            const incremental = seed
              ? readSeededDiscoveryRows(
                  environment, seed, lease.scope, "hints",
                  planned?.hintsBytes ?? pageBytes, planned?.hints,
                )
              : null;
            if (planned && !incremental)
              throw new DiscoveryStoreRefused("stale-writer", "Measured hint delta no longer fits; replan before reading");
            const hints = incremental ?? loadExternalHints(environment, lease.scope, pageBytes);
            received += hints.bytes;
            attachExternalHints(grant.state, hints.rows);
            received += verifyHydrationFence(environment, fence);
            hydration.set(lease.scope, fence);
          } catch (error) {
            // Only the current owner may close a lease; preserve the original
            // hydration error if a newer writer already took ownership.
            baselines.delete(lease.scope);
            active.delete(lease.scope);
            hydration.delete(lease.scope);
            try {
              runSql(environment, `SELECT portcove_maintenance.discovery_finish(${sqlLiteral(lease.scope)}, ${uuid(lease.attempt)}, ${uuid(lease.token)}, 'failed', '{}'::jsonb);`);
            } catch (finishError) {
              if (!/portcove-discovery-stale-writer/u.test(String(finishError)))
                throw new MaintenanceStoreError(`Discovery hydration failed: ${String(error)}; cleanup failed: ${String(finishError)}`);
            }
            throw error;
          }
        }
        const previous = baselines.get(lease.scope);
        active.set(lease.scope, { attempt: lease.attempt, generation, token: lease.token });
        if (grant.unchanged) {
          if (previous && known && previous.revision === revision &&
            previous.generation === generation && previous.attempt === known.attempt &&
            previous.definition === known.definition)
            baselines.set(lease.scope, { ...previous, attempt: lease.attempt });
          else baselines.delete(lease.scope);
        } else {
          baselines.set(lease.scope, { revision, generation, attempt: lease.attempt,
            definition: grant.definition_sha256, hints: hintBaseline(grant.state ?? {}) });
        }
        return {
          ...grant,
          state: grant.state ?? {},
          revision: Number(grant.revision),
          acquisition: Number(grant.acquisition),
          generation: Number(grant.generation),
          received_bytes: received,
        };
      } catch (error) {
        return classify(error);
      }
    },
    commit(lease, expectedRevision, options) {
      const previous = baselines.get(lease.scope);
      const current = active.get(lease.scope);
      const eligible = previous && current && previous.attempt === lease.attempt &&
        current.attempt === lease.attempt && current.token === lease.token &&
        previous.generation === current.generation && previous.revision === expectedRevision;
      const delta = eligible ? externalHintDelta(previous.hints, options.state) : undefined;
      const nextHints = delta?.after ?? hintBaseline(options.state);
      const functionName = delta ? "discovery_commit_hint_delta" : "discovery_commit";
      const sql = `SELECT portcove_maintenance.${functionName}(${sqlLiteral(lease.scope)},
        ${uuid(lease.attempt)}, ${uuid(lease.token)}, ${expectedRevision},
        ${sqlLiteral(options.definition)}, ${sqlLiteral(JSON.stringify(delta?.compact ?? options.state))}::jsonb,
        ${options.leaseSeconds}, ${sqlLiteral(JSON.stringify(options.observations))}::jsonb,
        ${sqlLiteral(JSON.stringify(options.watches))}::jsonb,
        ${sqlLiteral(JSON.stringify(options.leadRecords))}::jsonb${delta ? `,
        ${sqlLiteral(JSON.stringify(delta.changed))}::jsonb, ${sqlLiteral(JSON.stringify(delta.removed))}::jsonb` : ""});`;
      try {
        const output = runSql(environment, sql, { timeoutMs: 300_000 });
        const revision = Number(output.trim());
        if (revision !== expectedRevision + 1)
          throw new MaintenanceStoreError("Discovery commit returned an unexpected revision");
        if (hydration.get(lease.scope)?.lease.token === lease.token)
          hydration.delete(lease.scope);
        if (current && current.attempt === lease.attempt && current.token === lease.token)
          baselines.set(lease.scope, { revision, attempt: lease.attempt, generation: current.generation,
            definition: options.definition, hints: nextHints });
        else baselines.delete(lease.scope);
        return {
          revision,
          bytes: Buffer.byteLength(sql),
          received_bytes: Buffer.byteLength(output),
        };
      } catch (error) {
        baselines.delete(lease.scope);
        return classify(error);
      }
    },
    loadLeadRecords(scope) {
      const fence = hydration.get(scope);
      hydration.delete(scope);
      const measured = fence?.plan;
      const verify = () => {
        if (!fence) return 0;
        try {
          return verifyHydrationFence(environment, fence);
        } catch (error) {
          baselines.delete(scope);
          active.delete(scope);
          throw error;
        }
      };
      const incremental = seed && readSeededDiscoveryRows(environment, seed, scope, "leads",
        measured?.leadsBytes ?? pageBytes, measured?.leads);
      if (measured && !incremental) {
        baselines.delete(scope);
        active.delete(scope);
        throw new DiscoveryStoreRefused("stale-writer", "Measured lead delta no longer fits; replan before reading");
      }
      if (incremental) return {
        records: Object.entries(incremental.rows).sort(([a], [b]) => Number(a) - Number(b)).map(([, row]) => row),
        bytes: incremental.bytes + verify(),
      };
      // Read in pages by key, so the stored lead set is bounded by the database
      // rather than by one client read.
      const records: unknown[] = [];
      let bytes = 0;
      let after = 0;
      for (;;) {
        const output = runSql(
          environment,
          `SET TRANSACTION READ ONLY;
           WITH ordered AS (
             SELECT lead_id, record,
               sum(octet_length(record::text)) OVER (ORDER BY lead_id) AS running
             FROM portcove_maintenance.discovery_lead_records
             WHERE scope = ${sqlLiteral(scope)} AND lead_id > ${after})
           SELECT coalesce(json_agg(record ORDER BY lead_id), '[]')::text FROM ordered
           WHERE running <= ${pageBytes} OR lead_id = (SELECT min(lead_id) FROM ordered);`,
          { timeoutMs: 300_000 },
        ).trim();
        bytes += Buffer.byteLength(output);
        const page: unknown = JSON.parse(output);
        if (!Array.isArray(page))
          throw new MaintenanceStoreError("Malformed discovery lead records");
        if (page.length === 0) return { records, bytes: bytes + verify() };
        for (const record of page) records.push(record);
        const last: unknown = page.at(-1);
        const id = isRecord(last) ? Number(last.id) : Number.NaN;
        if (!Number.isSafeInteger(id) || id <= after)
          throw new MaintenanceStoreError("Discovery lead records are not ordered by id");
        after = id;
      }
    },
    finish(lease, outcome, summary) {
      if (hydration.get(lease.scope)?.lease.token === lease.token)
        hydration.delete(lease.scope);
      if (active.get(lease.scope)?.token === lease.token)
        active.delete(lease.scope);
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

/**
 * A consistent read-only copy of one scope's stored state and lead records,
 * taken without a lease. The records are read in pages, so the state revision
 * is read before and after; a commit in between makes the copy `moved`, and the
 * caller reads again.
 */
export function readDiscoverySnapshot(
  environment: NodeJS.ProcessEnv,
  scope: string,
  pageBytes = Math.floor(outputLimitBytes / 2),
):
  | { outcome: "empty"; bytes: number }
  | { outcome: "moved"; bytes: number }
  | {
      outcome: "read";
      revision: number;
      state: Record<string, unknown>;
      records: unknown[];
      bytes: number;
    } {
  const revisionOf = () => {
    const output = runSql(
      environment,
      `SET TRANSACTION READ ONLY;
       SELECT json_build_object(
         'revision', coalesce((SELECT revision FROM portcove_maintenance.discovery_collection_state
           WHERE scope = ${sqlLiteral(scope)}), 0),
         'generation', (SELECT collection_generation
           FROM portcove_maintenance_meta.discovery_intake_activation))::text;`,
    ).trim();
    const fence: unknown = JSON.parse(output);
    if (!isRecord(fence) || !Number.isSafeInteger(fence.revision) ||
        !Number.isSafeInteger(fence.generation))
      throw new MaintenanceStoreError("Malformed discovery snapshot fence");
    return {
      revision: Number(fence.revision),
      generation: Number(fence.generation),
      bytes: Buffer.byteLength(output),
    };
  };
  const before = revisionOf();
  if (before.revision === 0) return { outcome: "empty", bytes: before.bytes };
  const stateOutput = runSql(
    environment,
    `SET TRANSACTION READ ONLY;
     SELECT json_build_object('revision', revision, 'state', state)::text
     FROM portcove_maintenance.discovery_collection_state WHERE scope = ${sqlLiteral(scope)};`,
    { timeoutMs: 300_000 },
  ).trim();
  const hints = loadExternalHints(environment, scope, pageBytes);
  const loaded = postgresDiscoveryStore(environment, pageBytes).loadLeadRecords(scope);
  const after = revisionOf();
  const bytes = before.bytes + Buffer.byteLength(stateOutput) + hints.bytes + loaded.bytes + after.bytes;
  const row: unknown = JSON.parse(stateOutput);
  if (after.revision !== before.revision || after.generation !== before.generation)
    return { outcome: "moved", bytes };
  if (!isRecord(row) || !isRecord(row.state))
    throw new MaintenanceStoreError("Malformed stored discovery state");
  if (Number(row.revision) !== before.revision)
    return { outcome: "moved", bytes };
  attachExternalHints(row.state, hints.rows);
  return {
    outcome: "read",
    revision: before.revision,
    state: row.state,
    records: loaded.records,
    bytes,
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
