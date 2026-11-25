import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MaintenanceStoreError,
  backup,
  digestQuery,
  dumpTimeoutMs,
  maintenanceSchemas,
  migrationStatus,
  outputLimitBytes,
  portableRestoreSql,
  psqlBase,
  queryJson,
  readBackupManifest,
  restore,
  restoreVerification,
  runTool,
  sequenceStateQuery,
  sqlLiteral,
  storeTables,
  storeSequences,
  withExportedSnapshot,
  type StoreDigest,
  type SequenceState,
} from "./maintenance-store.mts";

const history = [
  ["observations", "observation_id"],
  ["assessments", "assessment_id"],
] as const;

const schema = "portcove_maintenance";
const activation = "portcove_maintenance_meta.discovery_intake_activation";
/** Explicit primary keys of large discovery tables. These keys identify rows,
 * while the digest covers the entire row including its mutable columns. */
const discoveryDeltaTables = [
  { table: schema + ".discovery_lead_records", key: "jsonb_build_array(t.scope, t.lead_id)::text" },
  { table: schema + ".discovery_external_hints", key: "jsonb_build_array(t.scope, t.hint_key)::text" },
  { table: schema + ".discovery_observations", key: "jsonb_build_array(t.provider, t.provider_id, t.parser_version, t.content_sha256)::text" },
] as const;
type DeltaTable = (typeof discoveryDeltaTables)[number];
type RowDelta = { table: DeltaTable; keys: string[] };

/** Reserve the trailing newline in the local psql stdout response. */
export function backupFingerprintResponseLimit(maximum: number, clientLimit = outputLimitBytes) {
  return Math.min(maximum, clientLimit - 1);
}

function fingerprintSql(table: DeltaTable, maximum: number) {
  return `WITH fingerprints AS (
    SELECT coalesce(jsonb_object_agg(${table.key}, encode(sha256(convert_to(t::text, 'UTF8')), 'hex')), '{}'::jsonb) AS value
    FROM ${table.table} t
  ) SELECT CASE WHEN octet_length(value::text) <= ${maximum} THEN value ELSE 'null'::jsonb END FROM fingerprints;`;
}

function deltaSql(table: DeltaTable, local: string, maximum: number) {
  return `WITH local AS (
    SELECT key, value AS sha FROM jsonb_each_text(${sqlLiteral(local)}::jsonb)
  ), remote AS (
    SELECT ${table.key} AS key, encode(sha256(convert_to(t::text, 'UTF8')), 'hex') AS sha,
      octet_length(t::text)::bigint * 2 + 100 AS bytes FROM ${table.table} t
  ), changed AS (
    SELECT coalesce(l.key, r.key) AS key, coalesce(r.bytes, 0) AS bytes
    FROM local l FULL JOIN remote r USING (key) WHERE l.sha IS DISTINCT FROM r.sha
  ), plan AS (
    SELECT coalesce(jsonb_agg(key ORDER BY key COLLATE "C"), '[]'::jsonb) AS keys,
      coalesce(sum(bytes), 0) AS bytes FROM changed
  ) SELECT CASE WHEN octet_length(keys::text) <= ${maximum}
    AND bytes + octet_length(keys::text) < (SELECT coalesce(sum(bytes), 0) FROM remote)
    THEN keys ELSE 'null'::jsonb END FROM plan;`;
}

function deltaPredicate(delta: RowDelta, local: boolean) {
  return `${local ? "NOT " : ""}(${sqlLiteral(JSON.stringify(delta.keys))}::jsonb ? (${delta.table.key}))`;
}

const copySettings =
  "SET DateStyle = 'ISO, MDY'; SET TimeZone = 'UTC'; SET IntervalStyle = 'postgres'; SET extra_float_digits = 1;";

export class MaintenanceBackupDeferred extends MaintenanceStoreError {
  override name = "MaintenanceBackupDeferred";
  readonly requiredBytes: number;
  readonly reservedBytes: number;
  constructor(requiredBytes: number, reservedBytes: number) {
    super(`Backup payload ceiling ${requiredBytes} exceeds its ${reservedBytes}-byte reservation`);
    this.requiredBytes = requiredBytes;
    this.reservedBytes = reservedBytes;
  }
}

export interface BackupTransfer {
  reserved_bytes: number;
  estimated_payload_ceiling: number;
  history_copy_bytes: number;
  /** Measured uncompressed local COPY data, suitable as an estimate for the small-table dump. */
  other_table_copy_bytes: number;
  /** Tables restored locally after matching the production snapshot digest. */
  reused_tables: string[];
  row_delta_tables: { table: string; changed_or_removed_keys: number }[];
  row_delta_copy_bytes: number;
  row_delta_plan_bytes: number;
  method: "logical-copy-payload-plus-unmeasured-postgresql-and-tls-overhead";
}

function historyPrefix(index: number, through?: string) {
  const [name, id] = history[index]!;
  const table = `${schema}.${name}`;
  return `SELECT json_build_object(
    'through', coalesce(max(${id}), 0)::text,
    'rows', count(*),
    'sha256', encode(sha256(convert_to(coalesce(string_agg(t::text, E'\\n' ORDER BY ${id}), ''), 'UTF8')), 'hex'))
    FROM ${table} t${through === undefined ? "" : ` WHERE ${id} <= ${through}`};`;
}

function copyTo(
  environment: NodeJS.ProcessEnv,
  selection: string,
  file: string,
  snapshot?: string,
) {
  const transaction =
    snapshot === undefined
      ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
      : `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT ${sqlLiteral(snapshot)};`;
  runTool("psql", psqlBase, environment, {
    input: `${transaction}\n${copySettings}\n\\copy (${selection}) TO ${sqlLiteral(file)}\nCOMMIT;\n`,
    timeoutMs: dumpTimeoutMs,
  });
}

/** Bound transfer before fetching data, from the same snapshot that supplies it. */
function exportCeiling(
  through: readonly string[], reused: ReadonlySet<string>, deltas: readonly RowDelta[], planBytes: number,
) {
  const sources = [...storeTables.map(([table]) => table), activation]
    .filter((table) => !reused.has(table))
    .map((table) => {
      const index = history.findIndex(([name]) => table === `${schema}.${name}`);
      const delta = deltas.find((entry) => entry.table.table === table);
      const where = delta ? ` WHERE ${deltaPredicate(delta, false)}`
        : index < 0 ? "" : ` WHERE ${history[index]![1]} > ${through[index]}`;
      // Allow for text COPY escaping, row framing and query/transport overhead.
      return `(SELECT coalesce(sum(octet_length(t::text)::bigint * 2 + 100), 0) FROM ${table} t${where})`;
    });
  return `SELECT ${2_000_000 + planBytes} + ${sources.join(" + ")};`;
}

/**
 * Use a verified ordinary dump as a prefix cache. Every output is itself an
 * ordinary complete backup. Production supplies changed tables and the
 * history suffixes whose prefixes matched in the same snapshot. Tables with
 * identical verified local and production digests are loaded locally instead.
 * A mismatch falls back to transferring that table, subject to the same cap.
 */
interface BackupReuseOptions {
  source: NodeJS.ProcessEnv;
  prefixDatabase: NodeJS.ProcessEnv;
  target: NodeJS.ProcessEnv;
  previous?: string | undefined;
  output: string;
  reservedBytes: number;
  reuseRecent?: boolean;
}

/** A retry may reuse only a seed restored by this invocation into its own
 * scratch database. No caller-provided manifest or remote cache is trusted. */
export function createBackupRecovery(options: Omit<BackupReuseOptions, "reservedBytes">) {
  let seed: { base: ReturnType<typeof readBackupManifest> | undefined; localTables: StoreDigest | undefined } | undefined;
  return (reservedBytes: number) => backupPrepared({ ...options, reservedBytes }, () => {
    if (!seed) {
      const previous = options.previous;
      const base = previous ? readBackupManifest(previous) : undefined;
      const localTables = previous ? restore(options.prefixDatabase, previous).tables : undefined;
      seed = { base, localTables };
    }
    return seed;
  });
}

export function backupReusingHistory({ reservedBytes, ...options }: BackupReuseOptions) {
  return createBackupRecovery(options)(reservedBytes);
}

async function backupPrepared(options: BackupReuseOptions, prepareSeed: () => {
  base: ReturnType<typeof readBackupManifest> | undefined;
  localTables: StoreDigest | undefined;
}) {
  const { source, prefixDatabase, target, previous, output, reservedBytes } = options;
  if (existsSync(output)) throw new MaintenanceStoreError("Backup destination already exists");
  for (const environment of [prefixDatabase, target]) {
    if (environment.PGHOST?.startsWith("/") !== true)
      throw new MaintenanceStoreError("Recovery scratch databases must use a local Unix socket");
    if (environment.PGOPTIONS || environment.PGSERVICE)
      throw new MaintenanceStoreError(
        "Recovery scratch databases must use a direct local connection",
      );
  }
  if (
    prefixDatabase.PGHOST === target.PGHOST &&
    prefixDatabase.PGPORT === target.PGPORT &&
    prefixDatabase.PGDATABASE === target.PGDATABASE
  )
    throw new MaintenanceStoreError("Recovery scratch databases must be distinct");
  const status = migrationStatus(source);
  if (status.problems.length || status.pending.length || !status.schema_version)
    throw new MaintenanceStoreError("Back up only a store migrated to this checkout's schema");

  // Reuse the actual local restore proof on a preflight retry; the current
  // production snapshot is always compared again before copying any rows.
  const { base, localTables } = prepareSeed();
  const work = mkdtempSync(path.join(os.tmpdir(), "portcove-maintenance-reuse-"));
  try {
    const dump = path.join(work, "store.dump");
    const suffixes = history.map(([name]) => path.join(work, `${name}-suffix.tsv`));
    const prefixes = history.map(([name]) => path.join(work, `${name}-prefix.tsv`));
    const local = history.map((_, index) =>
      previous
        ? (queryJson(prefixDatabase, `${copySettings}\n${historyPrefix(index)}`) as {
            through: string;
          })
        : undefined,
    );
    const captured = await withExportedSnapshot(source, async (snapshot, query) => {
      await query(copySettings);
      const expected = [...storeTables.map(([table]) => table), activation].sort();
      const exportedTables = JSON.parse(
        await query(`SELECT coalesce(json_agg(n.nspname || '.' || c.relname), '[]')
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN (${maintenanceSchemas.map(sqlLiteral).join(", ")}) AND c.relkind IN ('r','p','f','m');`),
      ) as string[];
      if (JSON.stringify(exportedTables.sort()) !== JSON.stringify(expected))
        throw new MaintenanceStoreError(
          "Protected table inventory differs from the recovery contract",
        );
      const through: string[] = [];
      for (const [index, prefix] of local.entries()) {
        if (!prefix || !/^[0-9]+$/u.test(prefix.through)) {
          through.push("0");
          continue;
        }
        const observed: unknown = JSON.parse(await query(historyPrefix(index, prefix.through)));
        through.push(JSON.stringify(observed) === JSON.stringify(prefix) ? prefix.through : "0");
      }
      const tables = JSON.parse(await query(digestQuery())) as StoreDigest;
      const reusedTables = new Set<string>();
      for (const [table] of storeTables) {
        if (history.some(([name]) => table === `${schema}.${name}`)) continue;
        const local = localTables?.[table], remote = tables[table];
        if (local && remote && local.rows === remote.rows && local.sha256 === remote.sha256)
          reusedTables.add(table);
      }
      if (
        options.reuseRecent &&
        base?.sequences &&
        Date.now() >= Date.parse(base.created_at) &&
        Date.now() - Date.parse(base.created_at) < 20 * 60 * 60 * 1000
      ) {
        const matches = storeTables.every(
          ([table]) =>
            table.endsWith(".resource_admissions") ||
            (tables[table]?.rows === base.tables[table]?.rows &&
              tables[table]?.sha256 === base.tables[table]?.sha256),
        );
        const state = JSON.parse(await query(sequenceStateQuery)) as SequenceState;
        if (matches && JSON.stringify(state) === JSON.stringify(base.sequences))
          return { reused: true as const };
      }
      // Exchange only changed keys; the local fingerprint map is sent to the
      // server, not downloaded from it. Fall back to a full table when the
      // metadata cannot fit or would cost more than the table itself.
      const deltas: RowDelta[] = [];
      let planBytes = 0;
      const metadataAllowance = Math.floor(reservedBytes * 0.7);
      for (const table of discoveryDeltaTables) {
        if (!localTables?.[table.table]?.rows || reusedTables.has(table.table)) continue;
        const remaining = Math.min(metadataAllowance - planBytes, reservedBytes - 2_000_000 - planBytes);
        if (remaining <= 0) break;
        const localLimit = backupFingerprintResponseLimit(remaining);
        const local = queryJson(
          prefixDatabase,
          `${copySettings}\n${fingerprintSql(table, localLimit)}`,
        );
        if (local === null) continue;
        const encoded = JSON.stringify(local);
        const output = (await query(deltaSql(table, encoded, remaining))).trim();
        planBytes += Buffer.byteLength(output);
        const keys: unknown = JSON.parse(output);
        if (keys === null) continue;
        if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string"))
          throw new MaintenanceStoreError("Malformed discovery row delta");
        deltas.push({ table, keys: keys as string[] });
      }
      const estimated = Number((await query(exportCeiling(through, reusedTables, deltas, planBytes))).trim());
      if (!Number.isSafeInteger(estimated) || estimated < 0)
        throw new MaintenanceStoreError("Invalid backup payload estimate");
      if (estimated > reservedBytes)
        throw new MaintenanceBackupDeferred(estimated, reservedBytes);
      runTool(
        "pg_dump",
        [
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          `--snapshot=${snapshot}`,
          ...maintenanceSchemas.map((name) => `--schema=${name}`),
          ...history.map(([name]) => `--exclude-table-data=${schema}.${name}`),
          ...[...reusedTables].map((table) => `--exclude-table-data=${table}`),
          ...deltas.map(({ table }) => `--exclude-table-data=${table.table}`),
          `--file=${dump}`,
        ],
        source,
        { timeoutMs: dumpTimeoutMs },
      );
      for (const [index, [name, id]] of history.entries())
        copyTo(
          source,
          `SELECT * FROM ${schema}.${name} WHERE ${id} > ${through[index]} ORDER BY ${id}`,
          suffixes[index]!,
          snapshot,
        );
      for (const delta of deltas)
        copyTo(source, `SELECT t.* FROM ${delta.table.table} t WHERE ${deltaPredicate(delta, false)}`,
          path.join(work, `${delta.table.table}-delta.tsv`), snapshot);
      // Sequences are not MVCC. Sample after COPY so values are at least as new
      // as all included rows, even if another collector took tickets meanwhile.
      const state = JSON.parse(await query(sequenceStateQuery)) as SequenceState;
      return { reused: false as const, tables, through, estimated, state, reusedTables, deltas, planBytes };
    });
    if (captured.reused)
      return {
        reused: true,
        manifest: base!,
        transfer: {
          reserved_bytes: reservedBytes,
          estimated_payload_ceiling: 2_000_000,
          history_copy_bytes: 0,
          other_table_copy_bytes: 0,
          reused_tables: [],
          row_delta_tables: [],
          row_delta_copy_bytes: 0,
          row_delta_plan_bytes: 0,
          method: "logical-copy-payload-plus-unmeasured-postgresql-and-tls-overhead",
        } satisfies BackupTransfer,
      };
    const scripts = ["pre-data", "data", "post-data"].map((section) => {
      const file = path.join(work, `${section}.sql`);
      runTool(
        "pg_restore",
        [
          "--no-owner",
          "--no-privileges",
          "--exit-on-error",
          `--section=${section}`,
          `--file=${file}`,
          dump,
        ],
        target,
        { timeoutMs: dumpTimeoutMs },
      );
      if (section === "pre-data")
        writeFileSync(file, portableRestoreSql(readFileSync(file, "utf8")));
      return file;
    });
    const load = history.flatMap(([name, id], index) => {
      const through = captured.through[index]!;
      const files = [suffixes[index]!];
      if (through !== "0") {
        copyTo(
          prefixDatabase,
          `SELECT * FROM ${schema}.${name} WHERE ${id} <= ${through} ORDER BY ${id}`,
          prefixes[index]!,
        );
        files.unshift(prefixes[index]!);
      }
      return files.flatMap((file) => ["-c", `\\copy ${schema}.${name} FROM ${sqlLiteral(file)}`]);
    });
    // Load matching complete tables from the verified local prefix. The target
    // restore still checks the full production digest before committing.
    for (const [table, order] of storeTables) {
      if (!captured.reusedTables.has(table)) continue;
      const file = path.join(work, `${table}-local.tsv`);
      copyTo(prefixDatabase, `SELECT * FROM ${table} ORDER BY ${order}`, file);
      load.push("-c", `\\copy ${table} FROM ${sqlLiteral(file)}`);
    }
    for (const delta of captured.deltas) {
      const table = delta.table.table;
      const file = path.join(work, `${table}-unchanged.tsv`);
      copyTo(prefixDatabase, `SELECT t.* FROM ${table} t WHERE ${deltaPredicate(delta, true)}`, file);
      for (const part of [file, path.join(work, `${table}-delta.tsv`)])
        load.push("-c", `\\copy ${table} FROM ${sqlLiteral(part)}`);
    }
    const setSequences = captured.state
      .map(({ last_value, is_called }, index) => {
        if (!/^[1-9][0-9]*$/u.test(last_value) || typeof is_called !== "boolean")
          throw new MaintenanceStoreError("Invalid recovery sequence state");
        return `SELECT setval('${schema}.${storeSequences[index]}', ${last_value}, ${is_called});`;
      })
      .join("\n");
    runTool(
      "psql",
      [
        ...psqlBase,
        "--single-transaction",
        "-f",
        scripts[0]!,
        "-f",
        scripts[1]!,
        ...load,
        "-c",
        setSequences,
        "-f",
        scripts[2]!,
        "-c",
        restoreVerification(captured.tables),
      ],
      target,
      { timeoutMs: dumpTimeoutMs },
    );
    const manifest = await backup(target, output);
    const transfer: BackupTransfer = {
      reserved_bytes: reservedBytes,
      estimated_payload_ceiling: captured.estimated,
      history_copy_bytes: suffixes.reduce((bytes, file) => bytes + statSync(file).size, 0),
      // SQL rendering includes sequence statements and headers. It approximates COPY bytes.
      other_table_copy_bytes: statSync(scripts[1]!).size,
      reused_tables: [...captured.reusedTables].sort(),
      row_delta_tables: captured.deltas.map(({ table, keys }) => ({ table: table.table, changed_or_removed_keys: keys.length })),
      row_delta_copy_bytes: captured.deltas.reduce((bytes, { table }) => bytes + statSync(path.join(work, `${table.table}-delta.tsv`)).size, 0),
      row_delta_plan_bytes: captured.planBytes,
      method: "logical-copy-payload-plus-unmeasured-postgresql-and-tls-overhead",
    };
    return { manifest, transfer, reused: false };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
