/**
 * Portable PostgreSQL storage for the #4129 maintenance application.
 *
 * Uses only standard PostgreSQL client tools (psql, pg_dump, pg_restore) and
 * reviewed SQL migrations, so the same commands run against any PostgreSQL 16+
 * host and any generic runner. Connection secrets come from a named environment
 * variable and reach the client tools through libpq environment variables, never
 * through command-line arguments or output.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const defaultMigrationDirectory = path.join(
  scriptDirectory,
  "maintenance-store",
  "migrations",
);
export const roleContractPath = path.join(scriptDirectory, "maintenance-store", "roles.sql");
export const defaultDatabaseEnvironment = "PORTCOVE_MAINTENANCE_DATABASE_URL";
export const backupFormat = "portcove-maintenance-backup";
export const backupFormatVersion = 1;
const dumpFileName = "maintenance.dump";
const manifestFileName = "manifest.json";
const maintenanceSchemas = ["portcove_maintenance", "portcove_maintenance_meta"] as const;
// Arbitrary constant shared by every maintenance migrator; serializes migrations per database.
const migrationLockKey = 4129_0001;
const toolTimeoutMs = 120_000;
const dumpTimeoutMs = 600_000;
const outputLimitBytes = 64 * 1024 * 1024;

/** Ordered tables and their deterministic, collation-independent row order. */
export const storeTables = [
  ["portcove_maintenance_meta.schema_migrations", "version"],
  ["portcove_maintenance.collection_runs", 'run_id COLLATE "C"'],
  ["portcove_maintenance.observations", "observation_id"],
  ["portcove_maintenance.assessments", "assessment_id"],
  ["portcove_maintenance.subject_current", 'subject_key COLLATE "C"'],
  ["portcove_maintenance.subject_transitions", 'subject_key COLLATE "C", sequence'],
  ["portcove_maintenance.reconsiderations", 'reconsideration_id COLLATE "C"'],
  ["portcove_maintenance.notifications", 'notification_key COLLATE "C"'],
  ["portcove_maintenance.operations", 'operation_id COLLATE "C"'],
] as const;

const queryParameters = new Map([
  ["host", "PGHOST"],
  ["port", "PGPORT"],
  ["sslmode", "PGSSLMODE"],
  ["sslrootcert", "PGSSLROOTCERT"],
  ["channel_binding", "PGCHANNELBINDING"],
  ["application_name", "PGAPPNAME"],
  ["connect_timeout", "PGCONNECT_TIMEOUT"],
  ["options", "PGOPTIONS"],
  ["target_session_attrs", "PGTARGETSESSIONATTRS"],
]);

export class MaintenanceStoreError extends Error {}

/** Translate a PostgreSQL connection URL into libpq environment variables. */
export function libpqEnvironmentFromUrl(value: string): Record<string, string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MaintenanceStoreError(
      "Maintenance database URL is not a valid postgresql:// URL (use ?host= for a socket path)",
    );
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:")
    throw new MaintenanceStoreError("Maintenance database URL must use postgresql://");
  if (url.hash)
    throw new MaintenanceStoreError("Maintenance database URL must not have a fragment");
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!database || database.includes("/") || database.includes("=") || database.includes("://"))
    throw new MaintenanceStoreError("Maintenance database URL must name exactly one database");
  const environment: Record<string, string> = { PGDATABASE: database };
  if (url.hostname) environment.PGHOST = url.hostname.replace(/^\[(.*)\]$/u, "$1");
  if (url.port) environment.PGPORT = url.port;
  if (url.username) environment.PGUSER = decodeURIComponent(url.username);
  if (url.password) environment.PGPASSWORD = decodeURIComponent(url.password);
  for (const [key, setting] of url.searchParams) {
    const variable = queryParameters.get(key);
    if (!variable)
      throw new MaintenanceStoreError(`Unsupported maintenance database URL parameter: ${key}`);
    environment[variable] = setting;
  }
  return environment;
}

/** Child environment: inherited PG* settings are replaced, output is deterministic. */
export function clientEnvironment(
  connection: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, setting] of Object.entries(base))
    if (!key.startsWith("PG") && setting !== undefined) environment[key] = setting;
  return {
    ...environment,
    ...connection,
    PGTZ: "UTC",
    PGDATESTYLE: "ISO",
    PGCLIENTENCODING: "UTF8",
    PGCONNECT_TIMEOUT: connection.PGCONNECT_TIMEOUT ?? "15",
  };
}

export function connectionFromEnvironment(
  name: string,
  base: NodeJS.ProcessEnv = process.env,
  envFile?: string,
): NodeJS.ProcessEnv {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name))
    throw new MaintenanceStoreError("Database environment variable name is invalid");
  let value = base[name];
  if (envFile !== undefined) {
    try {
      value = parseEnv(readFileSync(envFile, "utf8"))[name];
    } catch {
      throw new MaintenanceStoreError("Could not load the maintenance database environment file");
    }
  }
  if (!value?.trim()) {
    const source = envFile === undefined ? "" : " in the database environment file";
    throw new MaintenanceStoreError(`Set ${name}${source} to the maintenance database URL`);
  }
  // The URL itself never reaches a child process; only its libpq translation does.
  const rest = { ...base };
  delete rest[name];
  return clientEnvironment(libpqEnvironmentFromUrl(value.trim()), rest);
}

function toolPath(name: "psql" | "pg_dump" | "pg_restore", base: NodeJS.ProcessEnv) {
  const directory = base.PORTCOVE_POSTGRES_BIN?.trim();
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  return directory ? path.join(directory, executable) : executable;
}

function bounded(text: string) {
  const trimmed = text.trim();
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed;
}

function runTool(
  name: "psql" | "pg_dump" | "pg_restore",
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  options: { input?: string; timeoutMs?: number } = {},
) {
  const result = spawnSync(toolPath(name, environment), args, {
    env: environment,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? toolTimeoutMs,
    maxBuffer: outputLimitBytes,
    windowsHide: true,
  });
  if (result.error) throw new MaintenanceStoreError(`${name} failed: ${result.error.message}`);
  if (result.signal) throw new MaintenanceStoreError(`${name} stopped by ${result.signal}`);
  if (result.status !== 0)
    throw new MaintenanceStoreError(`${name} exited ${result.status}: ${bounded(result.stderr)}`);
  return result.stdout;
}

const psqlBase = ["-X", "-q", "-v", "ON_ERROR_STOP=1"] as const;

/** Run SQL in one transaction and return unaligned tuples-only output. */
export function runSql(environment: NodeJS.ProcessEnv, sql: string) {
  return runTool(
    "psql",
    [...psqlBase, "-A", "-t", "--single-transaction", "-f", "-"],
    environment,
    {
      input: sql,
    },
  );
}

function queryJson(environment: NodeJS.ProcessEnv, sql: string): unknown {
  const output = runSql(environment, sql).trim();
  try {
    return JSON.parse(output);
  } catch {
    throw new MaintenanceStoreError("PostgreSQL returned malformed JSON");
  }
}

export interface MigrationFile {
  version: number;
  name: string;
  sha256: string;
  sql: string;
}

/** Read migrations; line endings are normalized so every checkout hashes alike. */
export function readMigrations(directory = defaultMigrationDirectory): MigrationFile[] {
  const migrations = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((file) => {
      const match = /^(\d{4})_([a-z0-9_]+)\.sql$/u.exec(file);
      if (!match) throw new MaintenanceStoreError(`Unexpected migration file name: ${file}`);
      const sql = readFileSync(path.join(directory, file), "utf8").replaceAll("\r\n", "\n");
      return {
        version: Number(match[1]),
        name: match[2] ?? "",
        sha256: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    });
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1)
      throw new MaintenanceStoreError(
        `Maintenance migrations must be contiguous from 0001; found ${String(migration.version).padStart(4, "0")}`,
      );
  });
  if (!migrations.length) throw new MaintenanceStoreError("No maintenance migrations found");
  return migrations;
}

export interface AppliedMigration {
  version: number;
  name: string;
  sha256: string;
}

export interface MigrationPlan {
  applied: AppliedMigration[];
  pending: MigrationFile[];
  problems: string[];
}

/** Compare the database ledger with repository migrations without writing. */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  const problems: string[] = [];
  applied.forEach((row, index) => {
    const file = files[index];
    if (row.version !== index + 1)
      problems.push(`ledger is not contiguous at version ${row.version}`);
    else if (!file)
      problems.push(`database has migration ${row.version} (${row.name}) unknown to this checkout`);
    else if (file.name !== row.name || file.sha256 !== row.sha256)
      problems.push(`migration ${row.version} (${row.name}) differs from the applied migration`);
  });
  return {
    applied: [...applied],
    pending: problems.length ? [] : files.slice(applied.length),
    problems,
  };
}

const ledgerBootstrap = `
CREATE SCHEMA IF NOT EXISTS portcove_maintenance_meta;
CREATE TABLE IF NOT EXISTS portcove_maintenance_meta.schema_migrations (
  version integer PRIMARY KEY CHECK (version >= 1),
  name text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
`;

function readLedger(environment: NodeJS.ProcessEnv): AppliedMigration[] {
  const exists = queryJson(
    environment,
    "SELECT to_json(to_regclass('portcove_maintenance_meta.schema_migrations') IS NOT NULL);",
  );
  if (exists !== true) return [];
  const rows = queryJson(
    environment,
    `SELECT coalesce(json_agg(json_build_object('version', version, 'name', name, 'sha256', sha256)
       ORDER BY version), '[]'::json) FROM portcove_maintenance_meta.schema_migrations;`,
  );
  if (!Array.isArray(rows)) throw new MaintenanceStoreError("Migration ledger is malformed");
  return rows as AppliedMigration[];
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** One migration, its ledger row and its preconditions commit atomically or not at all. */
export function migrationTransaction(migration: MigrationFile) {
  return `SELECT pg_advisory_xact_lock(${migrationLockKey});
${ledgerBootstrap}
DO $portcove_guard$
BEGIN
  IF (SELECT coalesce(max(version), 0) FROM portcove_maintenance_meta.schema_migrations) <> ${migration.version - 1} THEN
    RAISE EXCEPTION 'maintenance migration ${migration.version} is not the next pending migration';
  END IF;
END
$portcove_guard$;
${migration.sql}
INSERT INTO portcove_maintenance_meta.schema_migrations (version, name, sha256)
  VALUES (${migration.version}, ${sqlLiteral(migration.name)}, ${sqlLiteral(migration.sha256)});
`;
}

function roleContract() {
  return `SELECT pg_advisory_xact_lock(${migrationLockKey});\n${readFileSync(roleContractPath, "utf8").replaceAll("\r\n", "\n")}`;
}

export function migrationStatus(
  environment: NodeJS.ProcessEnv,
  directory = defaultMigrationDirectory,
) {
  const plan = planMigrations(readMigrations(directory), readLedger(environment));
  return {
    schema_version: plan.applied.at(-1)?.version ?? 0,
    applied: plan.applied.map(({ version, name }) => ({ version, name })),
    pending: plan.pending.map(({ version, name }) => ({ version, name })),
    problems: plan.problems,
  };
}

/** Apply pending migrations one transaction at a time, then the role contract. */
export function migrate(environment: NodeJS.ProcessEnv, directory = defaultMigrationDirectory) {
  const plan = planMigrations(readMigrations(directory), readLedger(environment));
  if (plan.problems.length)
    throw new MaintenanceStoreError(`Refusing to migrate: ${plan.problems.join("; ")}`);
  const applied: number[] = [];
  for (const migration of plan.pending) {
    runSql(environment, migrationTransaction(migration));
    applied.push(migration.version);
  }
  if (plan.applied.length || plan.pending.length) runSql(environment, roleContract());
  return { ...migrationStatus(environment, directory), newly_applied: applied };
}

export type StoreDigest = Record<string, { rows: number; sha256: string }>;

/** Settings that make row text identical on every host; applied inside the digest's transaction. */
const digestSettings =
  "SET LOCAL TimeZone = 'UTC'; SET LOCAL DateStyle = 'ISO, MDY'; SET LOCAL IntervalStyle = 'postgres'; SET LOCAL extra_float_digits = 1;";

function digestExpression() {
  const fields = storeTables.map(
    ([table, order]) =>
      `${sqlLiteral(table)}, (SELECT json_build_object('rows', count(*), 'sha256', encode(sha256(convert_to(coalesce(string_agg(t::text, E'\\n' ORDER BY ${order}), ''), 'UTF8')), 'hex')) FROM ${table} t)`,
  );
  return `json_build_object(${fields.join(",\n  ")})`;
}

export function digestQuery() {
  return `${digestSettings}\nSELECT ${digestExpression()};`;
}

/** Raises inside the restore transaction when restored content differs from the manifest. */
export function restoreVerification(tables: StoreDigest) {
  return `${digestSettings}
DO $portcove_verify$
DECLARE
  actual jsonb := (SELECT ${digestExpression()})::jsonb;
  expected jsonb := ${sqlLiteral(JSON.stringify(tables))}::jsonb;
  mismatched text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO mismatched
    FROM (SELECT jsonb_object_keys(actual) AS name UNION SELECT jsonb_object_keys(expected)) names
    WHERE actual -> name IS DISTINCT FROM expected -> name;
  IF mismatched IS NOT NULL THEN
    RAISE EXCEPTION 'Restored store differs from its backup: %', mismatched;
  END IF;
END
$portcove_verify$;
`;
}

/** Deterministic per-table row counts and content digests of the whole store. */
export function storeDigest(environment: NodeJS.ProcessEnv): StoreDigest {
  return queryJson(environment, digestQuery()) as StoreDigest;
}

function sha256File(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** A psql session that holds one exported snapshot while pg_dump reads it. */
async function withExportedSnapshot<T>(
  environment: NodeJS.ProcessEnv,
  action: (snapshot: string, query: (sql: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  const child = spawn(toolPath("psql", environment), [...psqlBase, "-A", "-t", "-f", "-"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const marker = `portcove-maintenance-${process.pid}-${Date.now()}`;
  let stdout = "";
  let stderr = "";
  let waiting: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
  let exited: Error | undefined;
  const fail = (error: Error) => {
    exited ??= error;
    waiting?.reject(error);
    waiting = undefined;
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    const end = stdout.indexOf(`${marker}\n`);
    if (end >= 0 && waiting) {
      const output = stdout.slice(0, end);
      stdout = stdout.slice(end + marker.length + 1);
      waiting.resolve(output);
      waiting = undefined;
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk;
  });
  child.on("error", (error) => fail(new MaintenanceStoreError(`psql failed: ${error.message}`)));
  child.stdin.on("error", (error) =>
    fail(new MaintenanceStoreError(`psql session closed: ${error.message}`)),
  );
  child.on("exit", (code, signal) =>
    fail(new MaintenanceStoreError(`psql session ended (${signal ?? code}): ${bounded(stderr)}`)),
  );
  const timer = setTimeout(() => child.kill(), dumpTimeoutMs);
  const query = (sql: string) =>
    new Promise<string>((resolve, reject) => {
      if (exited) return reject(exited);
      waiting = { resolve, reject };
      child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  try {
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    const snapshot = (await query("SELECT pg_export_snapshot();")).trim();
    if (!/^[0-9A-Fa-f-]+$/u.test(snapshot))
      throw new MaintenanceStoreError("PostgreSQL returned a malformed snapshot identifier");
    const result = await action(snapshot, query);
    await query("COMMIT;");
    return result;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

export interface BackupManifest {
  format: typeof backupFormat;
  format_version: typeof backupFormatVersion;
  created_at: string;
  server_version_num: number;
  schema_version: number;
  migrations: AppliedMigration[];
  dump: { file: string; sha256: string; bytes: number };
  tables: StoreDigest;
}

/** Back up both maintenance schemas, without ownership or privileges, from one snapshot. */
export async function backup(
  environment: NodeJS.ProcessEnv,
  output: string,
  directory = defaultMigrationDirectory,
) {
  const status = migrationStatus(environment, directory);
  if (status.problems.length || status.pending.length || !status.schema_version)
    throw new MaintenanceStoreError("Back up only a store migrated to this checkout's schema");
  if (existsSync(output))
    throw new MaintenanceStoreError(`Backup destination already exists: ${output}`);
  mkdirSync(path.dirname(output), { recursive: true });
  // Written beside the destination and renamed only when complete: a failure leaves no partial backup.
  const staging = mkdtempSync(`${output}.partial-`);
  try {
    const manifest = await writeBackup(environment, staging);
    renameSync(staging, output);
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function writeBackup(environment: NodeJS.ProcessEnv, output: string) {
  const dumpPath = path.join(output, dumpFileName);
  const { tables, serverVersion } = await withExportedSnapshot(
    environment,
    async (snapshot, query) => {
      const tables = JSON.parse((await query(digestQuery())).trim()) as StoreDigest;
      const serverVersion = Number((await query("SHOW server_version_num;")).trim());
      runTool(
        "pg_dump",
        [
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          `--snapshot=${snapshot}`,
          ...maintenanceSchemas.map((schema) => `--schema=${schema}`),
          `--file=${dumpPath}`,
        ],
        environment,
        { timeoutMs: dumpTimeoutMs },
      );
      return { tables, serverVersion };
    },
  );
  const migrations = readLedger(environment);
  const ledger = tables["portcove_maintenance_meta.schema_migrations"];
  if (ledger?.rows !== migrations.length)
    throw new MaintenanceStoreError("Migration ledger changed during backup");
  const manifest: BackupManifest = {
    format: backupFormat,
    format_version: backupFormatVersion,
    created_at: new Date().toISOString(),
    server_version_num: serverVersion,
    schema_version: migrations.at(-1)?.version ?? 0,
    migrations,
    dump: {
      file: dumpFileName,
      sha256: sha256File(dumpPath),
      bytes: readFileSync(dumpPath).byteLength,
    },
    tables,
  };
  writeFileSync(path.join(output, manifestFileName), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  return manifest;
}

/** Exactly the store's tables, each with an integer row count and a SHA-256 digest. */
function validTableDigests(tables: unknown): tables is StoreDigest {
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) return false;
  const entries: [string, unknown][] = Object.entries(tables);
  return (
    entries.length === storeTables.length &&
    storeTables.every(([table]) => Object.hasOwn(tables, table)) &&
    entries.every(
      ([, digest]) =>
        typeof digest === "object" &&
        digest !== null &&
        Object.keys(digest).length === 2 &&
        Number.isSafeInteger((digest as { rows?: unknown }).rows) &&
        (digest as { rows: number }).rows >= 0 &&
        /^[0-9a-f]{64}$/u.test(String((digest as { sha256?: unknown }).sha256)),
    )
  );
}

export function readBackupManifest(input: string): BackupManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path.join(input, manifestFileName), "utf8"));
  } catch {
    throw new MaintenanceStoreError("Backup manifest is missing or malformed");
  }
  const value = manifest as Partial<BackupManifest>;
  if (
    value.format !== backupFormat ||
    value.format_version !== backupFormatVersion ||
    value.dump?.file !== dumpFileName ||
    !/^[0-9a-f]{64}$/u.test(value.dump.sha256 ?? "") ||
    !Array.isArray(value.migrations) ||
    !validTableDigests(value.tables)
  )
    throw new MaintenanceStoreError("Backup manifest has an unsupported format");
  return value as BackupManifest;
}

/**
 * Restore into a database with no maintenance schemas, reapply the role
 * contract and verify every table digest against the manifest.
 */
export function restore(
  environment: NodeJS.ProcessEnv,
  input: string,
  directory = defaultMigrationDirectory,
) {
  const manifest = readBackupManifest(input);
  const dumpPath = path.join(input, manifest.dump.file);
  if (sha256File(dumpPath) !== manifest.dump.sha256)
    throw new MaintenanceStoreError("Backup dump does not match its manifest digest");
  const plan = planMigrations(readMigrations(directory), manifest.migrations);
  if (plan.problems.length)
    throw new MaintenanceStoreError(`Backup schema is incompatible: ${plan.problems.join("; ")}`);
  const existing = queryJson(
    environment,
    `SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname IN (${maintenanceSchemas.map(sqlLiteral).join(", ")});`,
  );
  if (existing !== 0)
    throw new MaintenanceStoreError(
      "Restore target already has maintenance schemas; use an empty database",
    );
  // pg_restore renders the dump as SQL; psql then applies it, the role contract and the
  // verification in one transaction, so a failed verification leaves the target unchanged.
  const work = mkdtempSync(path.join(os.tmpdir(), "portcove-maintenance-restore-"));
  try {
    const script = path.join(work, "restore.sql");
    const verification = path.join(work, "verify.sql");
    const roles = path.join(work, "roles.sql");
    runTool(
      "pg_restore",
      ["--no-owner", "--no-privileges", "--exit-on-error", `--file=${script}`, dumpPath],
      environment,
      { timeoutMs: dumpTimeoutMs },
    );
    writeFileSync(roles, roleContract());
    writeFileSync(verification, restoreVerification(manifest.tables));
    // Verify against the backup's own schema, then bring it to this checkout's schema.
    const migrations = plan.pending.map((migration) => {
      const file = path.join(work, `migration-${migration.version}.sql`);
      writeFileSync(file, migrationTransaction(migration));
      return ["-f", file];
    });
    runTool(
      "psql",
      [
        ...psqlBase,
        "--single-transaction",
        "-f",
        script,
        "-f",
        verification,
        ...migrations.flat(),
        "-f",
        roles,
      ],
      environment,
      { timeoutMs: dumpTimeoutMs },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return {
    verified: true,
    schema_version: manifest.schema_version,
    migrated: plan.pending.map(({ version }) => version),
    tables: storeDigest(environment),
  };
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new MaintenanceStoreError(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

const usage = `usage: node scripts/maintenance-store.mts <command> [options]

commands:
  status    report applied, pending and drifted migrations
  migrate   apply pending migrations and the limited-role contract
  digest    print per-table row counts and content digests
  backup    --output DIR   write maintenance.dump and manifest.json to a new DIR
  restore   --input DIR    restore a backup into a database without maintenance schemas

options:
  --database-env NAME   environment variable holding the database URL (default ${defaultDatabaseEnvironment})
  --database-env-file PATH   read that variable from an env file
  --migrations DIR      migration directory (default: the repository migrations)

PORTCOVE_POSTGRES_BIN optionally names the directory holding psql, pg_dump and pg_restore.`;

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return command ? 0 : 2;
  }
  const environmentName = option(args, "--database-env") ?? defaultDatabaseEnvironment;
  const envFile = option(args, "--database-env-file");
  const directory = path.resolve(option(args, "--migrations") ?? defaultMigrationDirectory);
  const output = option(args, "--output");
  const input = option(args, "--input");
  if (args.length)
    throw new MaintenanceStoreError(`Unexpected arguments: ${args.join(" ")}\n${usage}`);
  const environment = connectionFromEnvironment(environmentName, process.env, envFile);
  let result: unknown;
  if (command === "status") result = migrationStatus(environment, directory);
  else if (command === "migrate") result = migrate(environment, directory);
  else if (command === "digest") result = storeDigest(environment);
  else if (command === "backup") {
    if (!output) throw new MaintenanceStoreError("backup requires --output DIR");
    result = await backup(environment, path.resolve(output), directory);
  } else if (command === "restore") {
    if (!input) throw new MaintenanceStoreError("restore requires --input DIR");
    result = restore(environment, path.resolve(input), directory);
  } else throw new MaintenanceStoreError(`Unknown command: ${command}\n${usage}`);
  console.log(JSON.stringify(result, null, 2));
  return command === "status" && (result as { problems: string[] }).problems.length ? 1 : 0;
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
