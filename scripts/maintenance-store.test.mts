import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { postgresFixture, postgresServer } from "./fixtures/postgres-cluster.mts";
import { postgresIntakeCheckpoints } from "./hosted-discovery-intake-checkpoint.mts";
import {
  backupFingerprintResponseLimit,
  backupReusingHistory,
  createBackupRecovery,
  MaintenanceBackupDeferred,
  retryBackupAdmission,
} from "./maintenance-backup-reuse.mts";
import {
  acquireMaintenanceReservation,
  cutoverReading,
  neonDiagnostic,
  normalizeNeonMeter,
  sampleNeon,
  policyLimits,
  runAdmittedMaintenance,
  MaintenanceResourceDeferred,
  type NeonMeter,
} from "./maintenance-resource-policy.mts";
import {
  backup,
  batchedStatements,
  clientEnvironment,
  connectionFromEnvironment,
  defaultMigrationDirectory,
  digestQuery,
  libpqEnvironmentFromUrl,
  maintenanceTransfer,
  migrate,
  migrationStatus,
  migrationTransaction,
  queryJson,
  planMigrations,
  portableRestoreSql,
  readMigrations,
  restore,
  runSql,
  serverInfo,
  storeDigest,
  withExportedSnapshot,
} from "./maintenance-store.mts";

void test("backup fingerprint responses fit the actual local client envelope", () => {
  const clientLimit = 64 * 1024 * 1024;
  assert.equal(backupFingerprintResponseLimit(33_600_000), 33_600_000);
  assert.equal(backupFingerprintResponseLimit(77_000_000), clientLimit - 1);
  assert.equal(backupFingerprintResponseLimit(308_000_000), clientLimit - 1);
  assert.equal(backupFingerprintResponseLimit(2_000, 1_024), 1_023);
});

void test("connection URLs become libpq environment without exposing secrets in arguments", () => {
  assert.deepEqual(
    libpqEnvironmentFromUrl(
      "postgresql://maint%40er:p%40ss@ep-x.example.test:5433/store?sslmode=require&channel_binding=require",
    ),
    {
      PGDATABASE: "store",
      PGHOST: "ep-x.example.test",
      PGPORT: "5433",
      PGUSER: "maint@er",
      PGPASSWORD: "p@ss",
      PGSSLMODE: "require",
      PGCHANNELBINDING: "require",
    },
  );
  assert.equal(libpqEnvironmentFromUrl("postgres://u@[::1]/d").PGHOST, "::1");
  assert.equal(
    libpqEnvironmentFromUrl("postgresql://u@localhost/d?host=/run/pg").PGHOST,
    "/run/pg",
  );
  assert.throws(() => libpqEnvironmentFromUrl("mysql://u@h/d"), /postgresql:\/\//u);
  assert.throws(() => libpqEnvironmentFromUrl("postgresql://u@h/"), /exactly one database/u);
  assert.throws(() => libpqEnvironmentFromUrl("postgresql://u@h/d?sslkey=/x"), /Unsupported/u);
  const environment = clientEnvironment(
    { PGDATABASE: "d" },
    { PATH: "/bin", PGPASSWORD: "inherited", PGSERVICE: "other" },
  );
  assert.equal(environment.PGPASSWORD, undefined);
  assert.equal(environment.PGSERVICE, undefined);
  assert.equal(environment.PGTZ, "UTC");
  assert.throws(() => connectionFromEnvironment("lower", {}), /invalid/u);
  assert.throws(() => connectionFromEnvironment("MISSING_URL", {}), /Set MISSING_URL/u);
});

void test("a large transaction is one query, and provider column options do not restore", () => {
  assert.equal(
    batchedStatements(["SELECT 1;", "SELECT ';\n';  ", "INSERT INTO t VALUES (1)"]),
    "SELECT 1\\;\nSELECT ';\n'\\;\nINSERT INTO t VALUES (1);",
  );
  const rendered = [
    "CREATE TABLE portcove_maintenance.assessments (assessment_id bigint);",
    "ALTER TABLE ONLY portcove_maintenance.assessments ALTER COLUMN assessment_id SET (pg_attver=29006896);",
    "ALTER TABLE ONLY portcove_maintenance.assessments ALTER COLUMN assessment_id SET (n_distinct=1);",
    "COPY portcove_maintenance.assessments (assessment_id) FROM stdin;",
    "ALTER TABLE ONLY portcove_maintenance.assessments ALTER COLUMN assessment_id SET (pg_attver=29006896);",
    "\\.",
  ].join("\n");
  assert.equal(
    portableRestoreSql(rendered),
    [
      "CREATE TABLE portcove_maintenance.assessments (assessment_id bigint);",
      "ALTER TABLE ONLY portcove_maintenance.assessments ALTER COLUMN assessment_id SET (n_distinct=1);",
      "COPY portcove_maintenance.assessments (assessment_id) FROM stdin;",
      "ALTER TABLE ONLY portcove_maintenance.assessments ALTER COLUMN assessment_id SET (pg_attver=29006896);",
      "\\.",
    ].join("\n"),
    "only the provider's exact column-version statements are dropped; COPY data is kept",
  );
});

void test("repository migrations are contiguous and the plan refuses drift or unknown versions", () => {
  const files = readMigrations();
  assert.equal(files[0]?.version, 1);
  const applied = files.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
  assert.deepEqual(planMigrations(files, []).pending, files);
  assert.deepEqual(planMigrations(files, applied), { applied, pending: [], problems: [] });
  const drifted = planMigrations(files, [{ ...applied[0]!, sha256: "0".repeat(64) }]);
  assert.deepEqual(drifted.pending, []);
  assert.match(drifted.problems.join(), /differs from the applied migration/u);
  const newer = planMigrations(files, [
    ...applied,
    { version: files.length + 1, name: "later", sha256: "1".repeat(64) },
  ]);
  assert.match(newer.problems.join(), /unknown to this checkout/u);
  assert.match(migrationTransaction(files[0]), /pg_advisory_xact_lock/u);
  assert.match(migrationTransaction(files[0]), /is not the next pending migration/u);
});

void test(
  "an explicit env file supplies only the selected database URL",
  { timeout: 150_000 },
  (context) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-maintenance-env-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, ".env.local");
    writeFileSync(
      file,
      'DATABASE_URL="postgresql://user:password@pooled.test/store?sslmode=require"\n' +
        'DATABASE_URL_UNPOOLED="postgresql://user:password@direct.test/store?sslmode=require"\n' +
        "NODE_OPTIONS=--inspect\n",
    );
    const base = { DATABASE_URL: "postgresql://user@other.test/other" };
    const pooled = connectionFromEnvironment("DATABASE_URL", base, file);
    assert.equal(pooled.PGHOST, "pooled.test");
    assert.equal(pooled.PGSSLMODE, "require");
    assert.equal(pooled.DATABASE_URL, undefined);
    assert.equal(pooled.DATABASE_URL_UNPOOLED, undefined);
    assert.equal(pooled.NODE_OPTIONS, undefined);
    assert.equal(
      connectionFromEnvironment("DATABASE_URL_UNPOOLED", {}, file).PGHOST,
      "direct.test",
    );
    assert.throws(
      () => connectionFromEnvironment("DATABASE_URL", base, file + ".missing"),
      /load/u,
    );
    assert.throws(
      () => connectionFromEnvironment("MISSING_URL", { MISSING_URL: base.DATABASE_URL }, file),
      /Set MISSING_URL/u,
    );
    writeFileSync(file, "SELECTED_DATABASE_URL=mysql://user@fixture.test/store\n");
    for (const script of ["maintenance-store.mts", "maintenance-inventory.mts"]) {
      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, script),
          script === "maintenance-store.mts" ? "status" : "handoffs",
          "--database-env-file",
          file,
          "--database-env",
          "SELECTED_DATABASE_URL",
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Maintenance database URL must use postgresql:\/\//u);
      assert.doesNotMatch(result.stdout + result.stderr, /mysql:\/\//u);
    }
  },
);

const server = postgresServer();

const hex = (digit: string) => digit.repeat(64);

/** Representative history: A -> B -> A, a pending deferral, notification state and receipts. */
const seed = `
INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at)
  VALUES ('run-1', 'catalog', 'fixture', '2026-11-01T00:00:00Z');
INSERT INTO portcove_maintenance.observations (run_id, subject_key, scope, input_revision, content_sha256, observed_at, payload)
  VALUES ('run-1', 'port:example-port', '{"platform":"windows-x86-64","route":"managed-native"}', 'commit-a', '${hex("a")}', '2026-11-01T00:00:01Z', '{"listing":"example"}');
UPDATE portcove_maintenance.collection_runs
  SET coverage = 'complete', completed_at = '2026-11-01T00:01:00Z', source_revision = 'commit-a', expected_count = 1, observed_count = 1
  WHERE run_id = 'run-1';
INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at, run_id) VALUES
  ('port:example-port', 'policy-1', '${hex("1")}', 'offered', '${hex("a")}', '{"why":"A"}', '2026-11-01T00:02:00Z', 'run-1'),
  ('port:example-port', 'policy-1', '${hex("2")}', 'held', '${hex("b")}', '{"why":"B"}', '2026-11-02T00:02:00Z', 'run-1'),
  ('port:example-port', 'policy-1', '${hex("3")}', 'offered', '${hex("a")}', '{"why":"A again"}', '2026-11-03T00:02:00Z', 'run-1');
INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id) VALUES ('port:example-port', 1, 1);
INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id) VALUES ('port:example-port', 2, 2);
INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id) VALUES ('port:example-port', 3, 3);
INSERT INTO portcove_maintenance.reconsiderations (reconsideration_id, subject_key, kind, revisit_authority, condition, created_at)
  VALUES ('deferral-1', 'port:example-port', 'intentional_deferral', 'https://github.com/boburning/portcove/issues/1', '{"until":"owner decision"}', '2026-11-03T00:00:00Z');
INSERT INTO portcove_maintenance.notifications (notification_key, subject_key, transition_sequence, created_at) VALUES
  ('digest-2', 'port:example-port', 2, '2026-11-02T00:03:00Z'),
  ('digest-3', 'port:example-port', 3, '2026-11-03T00:03:00Z');
`;

const executorSeed = `
UPDATE portcove_maintenance.notifications SET status = 'delivered', delivered_at = '2026-11-02T01:00:00Z', delivery_receipt = 'https://github.com/boburning/portcove/issues/177#issuecomment-1'
  WHERE notification_key = 'digest-2';
INSERT INTO portcove_maintenance.operations (operation_id, kind, subject_key, fence_sequence, fence_assessment_id, executor, created_at, updated_at)
  VALUES ('op-1', 'intake', 'port:example-port', 3, 3, 'hosted-discovery-intake', '2026-11-03T00:04:00Z', '2026-11-03T00:04:00Z');
UPDATE portcove_maintenance.operations SET state = 'dispatched', revision = 2 WHERE operation_id = 'op-1';
UPDATE portcove_maintenance.operations SET state = 'ambiguous', revision = 3 WHERE operation_id = 'op-1';
`;

function rejects(environment: NodeJS.ProcessEnv, sql: string, pattern: RegExp) {
  assert.throws(() => runSql(environment, sql), pattern);
}

void test(
  "ordinary maintenance report and history page preserve the full restored timeline",
  { skip: server.skip ?? false, timeout: 120_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const source = fixture.start("history").owner;
    const target = fixture.start("restored-history").owner;
    migrate(source);
    runSql(source, seed);
    runSql(
      source,
      `INSERT INTO portcove_maintenance.assessments
        (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at, run_id)
      SELECT 'port:example-port', 'policy-1', lpad(to_hex(n),64,'0'), 'held',
        lpad(to_hex(n),64,'0'), '{}'::jsonb, now(), 'run-1'
      FROM generate_series(4, 101) AS n ORDER BY n;
      INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id)
      SELECT 'port:example-port', assessment_id, assessment_id
      FROM portcove_maintenance.assessments WHERE assessment_id >= 4 ORDER BY assessment_id;`,
    );
    const snapshot = path.join(fixture.root, "history-backup");
    await backup(source, snapshot);
    restore(target, snapshot);
    const output = path.join(fixture.root, "bounded-report");
    const database = new URL(`postgresql://owner@localhost:${target.PGPORT}/postgres`);
    database.searchParams.set("host", target.PGHOST!);
    const cli = path.resolve("scripts/maintenance-inventory.mts");
    const call = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: { ...target, PORTCOVE_MAINTENANCE_DATABASE_URL: database.href },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    call("report", "--output", output);
    type HistoryEntry = { sequence: number };
    const report = JSON.parse(readFileSync(path.join(output, "inventory.json"), "utf8")) as {
      subjects: {
        subject_key: string;
        earlier_history_available: boolean;
        history: HistoryEntry[];
      }[];
    };
    const [row] = report.subjects;
    assert.ok(row);
    assert.equal(row.subject_key, "port:example-port");
    assert.equal(row.earlier_history_available, true);
    assert.deepEqual(
      row.history.map((entry) => entry.sequence),
      Array.from({ length: 12 }, (_, i) => i + 90),
    );
    const history = ["history", "--subject", row.subject_key];
    const page = JSON.parse(call(...history)) as HistoryEntry[];
    assert.deepEqual(
      page.map((entry) => entry.sequence),
      Array.from({ length: 100 }, (_, i) => 101 - i),
    );
    const next = JSON.parse(
      call(...history, "--before", String(page.at(-1)?.sequence)),
    ) as HistoryEntry[];
    assert.equal(next.length, 1);
    assert.equal(next[0]?.sequence, 1);
    assert.deepEqual(JSON.parse(call(...history, "--before", "1")), []);
  },
);

void test(
  "maintenance store guards history and survives an independent PostgreSQL restore",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const { root } = fixture;
    const source = fixture.start("source");
    const target = fixture.start("target");

    assert.equal(migrationStatus(source.owner).schema_version, 0);
    assert.deepEqual(
      migrate(source.owner).newly_applied,
      readMigrations().map(({ version }) => version),
    );
    assert.deepEqual(migrate(source.owner).newly_applied, [], "a second migrate is a no-op");
    runSql(
      source.owner,
      `CREATE ROLE collector_login LOGIN IN ROLE portcove_maintenance_collector;
       CREATE ROLE report_login LOGIN IN ROLE portcove_maintenance_report;
       CREATE ROLE executor_login LOGIN IN ROLE portcove_maintenance_executor;`,
    );
    const collector = source.as("collector_login");
    const executor = source.as("executor_login");
    runSql(collector, seed);
    runSql(executor, executorSeed);
    const journal = postgresIntakeCheckpoints(executor);
    const first = "prepared";
    const next = "attempted with 'quoted' evidence";
    const initialSlot = { port_key: "example-port", delivery: { status: first } };
    const nextSlot = { ...initialSlot, delivery: { status: "create-attempted" } };
    assert.equal(journal.load(177), null);
    assert.equal(journal.save(177, hex("a"), 0, first, null, [initialSlot]), 1);
    assert.throws(
      () => journal.save(177, hex("a"), 1, next, { body: "wrong", hash: hex("b") }, [nextSlot]),
      /advanced concurrently/u,
    );
    assert.equal(
      journal.save(177, hex("a"), 1, next, { body: first, hash: hex("b") }, [nextSlot]),
      2,
    );
    assert.deepEqual(journal.load(177), {
      revision: 2,
      request_sha256: hex("a"),
      receipt_body: next,
      previous_receipt_sha256: hex("b"),
      candidates: [nextSlot],
    });
    assert.throws(() => postgresIntakeCheckpoints(collector).load(177), /permission denied/u);

    const history: unknown = JSON.parse(
      runSql(
        source.owner,
        `SELECT json_agg(json_build_object('state', state, 'returns', returns_to_earlier_result) ORDER BY sequence)
           FROM portcove_maintenance.subject_transitions;`,
      ),
    );
    assert.deepEqual(history, [
      { state: "offered", returns: false },
      { state: "held", returns: false },
      { state: "offered", returns: true },
    ]);

    // Unchanged results and stale writers create no transition.
    rejects(
      collector,
      `INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at)
         VALUES ('port:example-port', 'policy-1', '${hex("4")}', 'offered', '${hex("a")}', '{}', now());
       INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id) VALUES ('port:example-port', 4, (SELECT max(assessment_id) FROM portcove_maintenance.assessments));`,
      /unchanged assessment/u,
    );
    rejects(
      collector,
      "INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id) VALUES ('port:example-port', 3, 2);",
      /stale maintenance state/u,
    );
    // Identical pinned inputs under one policy resolve to one assessment.
    rejects(
      collector,
      `INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at)
         VALUES ('port:example-port', 'policy-1', '${hex("1")}', 'offered', '${hex("a")}', '{}', now());`,
      /duplicate key/u,
    );
    // History, finished runs and resolved state are not rewritten.
    rejects(source.owner, "DELETE FROM portcove_maintenance.observations;", /append-only/u);
    rejects(
      source.owner,
      "UPDATE portcove_maintenance.assessments SET state = 'x';",
      /append-only/u,
    );
    rejects(
      source.owner,
      "TRUNCATE portcove_maintenance.subject_transitions CASCADE;",
      /append-only/u,
    );
    rejects(
      collector,
      `INSERT INTO portcove_maintenance.observations (run_id, subject_key, input_revision, content_sha256, observed_at, payload)
         VALUES ('run-1', 'port:other', 'r', '${hex("c")}', now(), '{}');`,
      /in-progress collection run/u,
    );
    rejects(
      collector,
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at) VALUES ('run-2', 'issues', 'fixture', now());
       UPDATE portcove_maintenance.collection_runs SET coverage = 'complete', completed_at = now(), source_revision = 'x', expected_count = 3, observed_count = 2 WHERE run_id = 'run-2';`,
      /observed 0 of 3 expected subjects/u,
    );
    rejects(
      collector,
      `UPDATE portcove_maintenance.reconsiderations SET status = 'satisfied', resolved_at = now(), resolution = '{"authority":"technically viable"}'
         WHERE reconsideration_id = 'deferral-1';`,
      /recorded authority/u,
    );
    rejects(
      collector,
      `UPDATE portcove_maintenance.reconsiderations SET status = 'withdrawn', resolved_at = now(), resolution = '{"authority":"technically viable"}'
         WHERE reconsideration_id = 'deferral-1';`,
      /recorded authority/u,
    );
    // A run's count is its retained observations, not a declaration.
    rejects(
      collector,
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at) VALUES ('run-3', 'issues', 'fixture', now());
       UPDATE portcove_maintenance.collection_runs SET coverage = 'complete', completed_at = now(), source_revision = 'x', expected_count = 500, observed_count = 500 WHERE run_id = 'run-3';`,
      /observed 0 of 500/u,
    );
    rejects(source.owner, "TRUNCATE portcove_maintenance.operations;", /append-only/u);
    // Operations: revision fencing, current-state revalidation and receipt-only recovery.
    rejects(
      executor,
      "UPDATE portcove_maintenance.operations SET state = 'completed', revision = 3 WHERE operation_id = 'op-1';",
      /stale operation revision/u,
    );
    rejects(
      executor,
      "UPDATE portcove_maintenance.operations SET state = 'abandoned', revision = 4 WHERE operation_id = 'op-1';",
      /original executor receipt/u,
    );
    rejects(
      executor,
      `INSERT INTO portcove_maintenance.operations (operation_id, kind, subject_key, fence_sequence, executor, created_at, updated_at)
         VALUES ('op-stale', 'intake', 'port:example-port', 2, 'hosted-discovery-intake', now(), now());`,
      /stale maintenance state/u,
    );
    // A plan binds the applicable assessment: the same result under new inputs invalidates it.
    runSql(
      executor,
      `INSERT INTO portcove_maintenance.operations (operation_id, kind, subject_key, fence_sequence, fence_assessment_id, executor, created_at, updated_at)
         VALUES ('op-plan', 'intake', 'port:example-port', 3, 3, 'hosted-discovery-intake', now(), now());`,
    );
    rejects(
      collector,
      "SELECT portcove_maintenance.verify_current(2, 'run-1');",
      /requires a transition/u,
    );
    runSql(
      collector,
      `INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at, run_id)
         VALUES ('port:example-port', 'policy-2', '${hex("6")}', 'offered', '${hex("a")}', '{"why":"A, new inputs"}', now(), 'run-1');
       SELECT portcove_maintenance.verify_current((SELECT max(assessment_id) FROM portcove_maintenance.assessments), 'run-1');`,
    );
    const refreshed = runSql(
      source.owner,
      "SELECT max(assessment_id) FROM portcove_maintenance.assessments;",
    ).trim();
    assert.equal(
      runSql(
        source.owner,
        `SELECT sequence || ':' || assessment_id || ':' || applicable_assessment_id
           FROM portcove_maintenance.subject_current WHERE subject_key = 'port:example-port';`,
      ).trim(),
      `3:3:${refreshed}`,
      "the material transition stays; the applicable assessment moves",
    );
    rejects(
      executor,
      "UPDATE portcove_maintenance.operations SET state = 'dispatched', revision = 2 WHERE operation_id = 'op-plan';",
      new RegExp(`operation fenced at 3 on assessment 3, current 3 on ${refreshed}`, "u"),
    );
    rejects(
      executor,
      `INSERT INTO portcove_maintenance.operations (operation_id, kind, subject_key, fence_sequence, fence_assessment_id, executor, created_at, updated_at)
         VALUES ('op-old-plan', 'intake', 'port:example-port', 3, 3, 'hosted-discovery-intake', now(), now());`,
      new RegExp(`operation bound to assessment 3, current ${refreshed}`, "u"),
    );
    const rebind = `UPDATE portcove_maintenance.operations SET fence_assessment_id = ${refreshed}, state = 'abandoned', revision = 2 WHERE operation_id = 'op-plan';`;
    rejects(executor, rebind, /permission denied/u);
    rejects(source.owner, rebind, /identity is immutable/u);
    // Limited roles.
    const report = source.as("report_login");
    assert.match(runSql(report, "SELECT count(*) FROM portcove_maintenance.observations;"), /1/u);
    rejects(
      report,
      "INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at) VALUES ('r', 's', 'x', now());",
      /permission denied/u,
    );
    rejects(
      collector,
      "UPDATE portcove_maintenance.operations SET revision = 4 WHERE operation_id = 'op-1';",
      /permission denied/u,
    );
    rejects(
      collector,
      "INSERT INTO portcove_maintenance.subject_current VALUES ('port:x', 1, 1, 'x', now());",
      /permission denied/u,
    );
    rejects(
      executor,
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at) VALUES ('r', 's', 'x', now());`,
      /permission denied/u,
    );
    rejects(
      executor,
      "SELECT 1 FROM pg_catalog.pg_class; DROP TABLE portcove_maintenance.operations;",
      /must be owner/u,
    );

    // A Core reuse binding, written by its in-progress run, travels with the backup.
    runSql(
      collector,
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at)
         VALUES ('core-run-1', 'core-port-capabilities-linux-x86-64', 'fixture', '2026-11-04T00:00:00Z');
       INSERT INTO portcove_maintenance.core_reuse_bindings
         (source, subject_key, scope_key, catalog_digest, content_sha256, run_id, read_at, visible_until)
         VALUES ('core-port-capabilities-linux-x86-64', 'port:example-port', '${hex("5")}', '${hex("6")}',
                 '${hex("7")}', 'core-run-1', '2026-11-04T00:00:00Z', 1700000000);
       UPDATE portcove_maintenance.collection_runs
          SET coverage = 'complete', completed_at = '2026-11-04T00:01:00Z', source_revision = 'commit-b',
              expected_count = 0, observed_count = 0
        WHERE run_id = 'core-run-1';`,
    );
    rejects(
      collector,
      `UPDATE portcove_maintenance.core_reuse_bindings SET scope_key = '${hex("8")}';`,
      /in-progress run/u,
    );

    // Backup from one snapshot, restore onto an independent cluster, verify everything.
    const before = storeDigest(source.owner);
    const archive = path.join(root, "backup");
    const manifest = await backup(source.owner, archive);
    assert.deepEqual(manifest.tables, before);
    const info = serverInfo(source.owner);
    assert.equal(info.server_version_num, manifest.server_version_num);
    assert.equal(info.server_major, Math.floor(manifest.server_version_num / 10_000));
    assert.ok(info.server_major >= 16);
    assert.ok(Number.isSafeInteger(info.database_size_bytes) && info.database_size_bytes > 0);
    assert.equal(manifest.schema_version, readMigrations().length);
    await assert.rejects(backup(source.owner, archive), /already exists/u);
    const altered = path.join(root, "altered");
    mkdirSync(altered);
    copyFileSync(path.join(archive, "maintenance.dump"), path.join(altered, "maintenance.dump"));
    const wrong = structuredClone(manifest);
    wrong.tables["portcove_maintenance.notifications"]!.sha256 = hex("0");
    writeFileSync(path.join(altered, "manifest.json"), JSON.stringify(wrong));
    assert.throws(
      () => restore(target.owner, altered),
      /differs from its backup: portcove_maintenance.notifications/u,
    );
    assert.match(
      runSql(
        target.owner,
        "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'portcove_maintenance%';",
      ),
      /^0$/mu,
      "a failed verification leaves no restored schema behind",
    );
    const restored = restore(target.owner, archive);
    assert.equal(restored.verified, true);
    assert.deepEqual(storeDigest(target.owner), before);
    assert.equal(
      runSql(
        target.owner,
        `SELECT scope_key || ' ' || run_id || ' ' || visible_until FROM portcove_maintenance.core_reuse_bindings;`,
      ).trim(),
      `${hex("5")} core-run-1 1700000000`,
      "the restored store keeps the binding",
    );
    rejects(
      target.owner,
      "DELETE FROM portcove_maintenance.core_reuse_bindings;",
      /never deleted/u,
    );
    assert.throws(() => restore(target.owner, archive), /already has maintenance schemas/u);
    assert.deepEqual(migrationStatus(target.owner).problems, []);

    // Guards, sequences and roles work on the restored store.
    assert.equal(
      runSql(
        target.owner,
        `SELECT portcove_maintenance.acquire_collection() > max(acquisition)
           FROM portcove_maintenance.collection_runs;`,
      ).trim(),
      "t",
      "a restored store keeps issuing newer acquisitions",
    );
    runSql(target.owner, "CREATE ROLE executor_login LOGIN IN ROLE portcove_maintenance_executor;");
    const restoredExecutor = target.as("executor_login");
    const restoredJournal = postgresIntakeCheckpoints(restoredExecutor);
    assert.throws(() => restoredJournal.load(177), /inactive on the restored maintenance store/u);
    assert.throws(
      () => restoredJournal.save(178, hex("a"), 0, first, null, [initialSlot]),
      /advanced concurrently/u,
    );

    runSql(
      restoredExecutor,
      `UPDATE portcove_maintenance.operations SET state = 'completed', revision = 4,
         receipt_reference = 'https://github.com/boburning/portcove/issues/177#issuecomment-2', receipt_sha256 = '${hex("e")}'
         WHERE operation_id = 'op-1';`,
    );
    rejects(
      restoredExecutor,
      "UPDATE portcove_maintenance.operations SET state = 'abandoned', revision = 5 WHERE operation_id = 'op-1';",
      /cannot move from completed/u,
    );
    rejects(target.owner, "DELETE FROM portcove_maintenance.subject_transitions;", /append-only/u);
    rejects(
      target.owner,
      "INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id) VALUES ('port:example-port', 3, 2);",
      /stale maintenance state/u,
    );
    runSql(
      target.owner,
      `INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at)
         VALUES ('port:example-port', 'policy-2', '${hex("5")}', 'held', '${hex("b")}', '{}', now());
       INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id) VALUES ('port:example-port', 4, (SELECT max(assessment_id) FROM portcove_maintenance.assessments));`,
    );

    // A manifest with unexpected digest fields is refused before any SQL is built.
    const injected = path.join(root, "injected");
    mkdirSync(injected);
    copyFileSync(path.join(archive, "maintenance.dump"), path.join(injected, "maintenance.dump"));
    const bad = structuredClone(manifest);
    bad.tables["portcove_maintenance.operations"]!.sha256 = "$portcove_verify$; DROP SCHEMA x; --";
    writeFileSync(path.join(injected, "manifest.json"), JSON.stringify(bad));
    assert.throws(() => restore(target.owner, injected), /unsupported format/u);

    // A tampered dump is refused before anything is restored.
    const tampered = path.join(root, "tampered");
    mkdirSync(tampered);
    copyFileSync(path.join(archive, "manifest.json"), path.join(tampered, "manifest.json"));
    writeFileSync(path.join(tampered, "maintenance.dump"), "not a dump");
    assert.throws(() => restore(target.owner, tampered), /does not match its manifest digest/u);
  },
);

void test(
  "an interrupted maintenance migration leaves no partial schema and resumes cleanly",
  { skip: server.skip ?? false, timeout: 120_000 },
  (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const { root } = fixture;
    const store = fixture.start("store");
    const migrations = path.join(root, "migrations");
    mkdirSync(migrations);
    // The role contract follows the repository schema, so the fixture carries every real migration.
    const real = readMigrations();
    for (const { version, name } of real) {
      const file = `${String(version).padStart(4, "0")}_${name}.sql`;
      copyFileSync(path.join(defaultMigrationDirectory, file), path.join(migrations, file));
    }
    const interrupted = `${String(real.length + 1).padStart(4, "0")}_interrupted.sql`;
    writeFileSync(
      path.join(migrations, interrupted),
      "CREATE TABLE portcove_maintenance.partial (id integer);\nSELECT 1 / 0;\n",
    );
    assert.throws(() => migrate(store.owner, migrations), /division by zero/u);
    const status = migrationStatus(store.owner, migrations);
    assert.equal(status.schema_version, real.length);
    assert.deepEqual(status.pending, [{ version: real.length + 1, name: "interrupted" }]);
    assert.match(
      runSql(store.owner, "SELECT to_regclass('portcove_maintenance.partial') IS NULL;"),
      /t/u,
    );

    // Schema SQL succeeds, but the final role contract cannot grant a renamed
    // function. The ledger and the function rename must roll back together.
    writeFileSync(
      path.join(migrations, interrupted),
      "ALTER FUNCTION portcove_maintenance.latest_run(text) RENAME TO interrupted_latest_run;\n",
    );
    assert.throws(() => migrate(store.owner, migrations), /latest_run.*does not exist/u);
    assert.equal(migrationStatus(store.owner, migrations).schema_version, real.length);
    assert.match(
      runSql(
        store.owner,
        "SELECT to_regprocedure('portcove_maintenance.latest_run(text)') IS NOT NULL;",
      ),
      /t/u,
    );

    writeFileSync(
      path.join(migrations, interrupted),
      "CREATE TABLE portcove_maintenance.partial (id integer);\n",
    );
    assert.deepEqual(migrate(store.owner, migrations).newly_applied, [real.length + 1]);
    assert.match(
      runSql(
        store.owner,
        "SELECT has_function_privilege('portcove_maintenance_collector', 'portcove_maintenance.latest_run(text)', 'EXECUTE');",
      ),
      /t/u,
    );
    writeFileSync(
      path.join(migrations, interrupted),
      "CREATE TABLE portcove_maintenance.changed (id integer);\n",
    );
    assert.throws(() => migrate(store.owner, migrations), /differs from the applied migration/u);
    assert.deepEqual(migrationStatus(store.owner, migrations).problems, [
      `migration ${real.length + 1} (interrupted) differs from the applied migration`,
    ]);
  },
);

function testMeter(transferBytes: number): NeonMeter {
  const now = Date.now();
  return {
    periodStart: new Date(now - 10 * 86_400_000).toISOString(),
    resetAt: new Date(now + 15 * 86_400_000).toISOString(),
    sampledAt: new Date(now - 1000).toISOString(),
    transferBytes,
    computeSeconds: 9_790,
    activeSeconds: 34_828,
    storageBytes: 170_606_592,
    branchTransferBytes: null,
  };
}

void test(
  "a receipt-only login can verify migrations and reserve handoffs through its explicit SQL role",
  { skip: server.skip ?? false },
  (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const { owner, as } = fixture.start("receipt-admission");
    migrate(owner);
    runSql(
      owner,
      "CREATE ROLE receipt_only LOGIN NOINHERIT; GRANT portcove_maintenance_executor TO receipt_only WITH INHERIT FALSE;",
    );
    const login = as("receipt_only");
    assert.throws(() => migrationStatus(login), /permission denied/u);
    assert.deepEqual(migrationStatus(login, undefined, true), migrationStatus(owner));
    const input = {
      meter: testMeter(0),
      request: "native-receipt",
      operation: "handoffs" as const,
      reason: "test",
    };
    assert.throws(() => acquireMaintenanceReservation(login, input), /permission denied/u);
    const admission = acquireMaintenanceReservation(login, { ...input, executor: true });
    assert.ok(admission.attempt_id);
    assert.equal(admission.operation_reservation_bytes, 8_000_000);
    assert.equal(
      runSql(
        owner,
        "SELECT requested_by FROM portcove_maintenance_meta.resource_admissions WHERE request_key='native-receipt';",
      ).trim(),
      "receipt_only",
    );
  },
);

void test(
  "revision-fenced discovery admission fits where its conservative default does not",
  { skip: server.skip ?? false },
  (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const { owner } = fixture.start("measured-discovery-admission");
    migrate(owner);
    const meter = testMeter(0);
    meter.transferBytes = policyLimits(meter, "discovery", Date.now()).ceiling_bytes - 5_000_000;
    const input = { meter, operation: "discovery" as const, reason: "test measured discovery" };
    const ordinary = acquireMaintenanceReservation(owner, {
      ...input,
      request: "ordinary-discovery",
      reservationBytes: 1_625_000,
    });
    assert.equal(ordinary.attempt_id, null);
    assert.equal(ordinary.operation_reservation_bytes, 16_000_000);
    const measured = acquireMaintenanceReservation(owner, {
      ...input,
      request: "measured-discovery",
      reservationBytes: 1_625_000,
      measuredDiscovery: true,
    });
    assert.ok(measured.attempt_id);
    assert.equal(measured.operation_reservation_bytes, 1_625_000);
    assert.equal(measured.ceiling_bytes, ordinary.ceiling_bytes);
    assert.equal(measured.reservation_basis, "revision-fenced-discovery");
  },
);

void test("measured discovery can reserve below the bootstrap estimate without changing recovery reserves", () => {
  const meter = testMeter(1_000_000_000);
  const now = Date.now();
  const defaultLimits = policyLimits(meter, "discovery", now, 1_625_000);
  const measuredLimits = policyLimits(meter, "discovery", now, 1_625_000, true);
  assert.equal(defaultLimits.operation_reservation_bytes, 16_000_000);
  assert.equal(measuredLimits.operation_reservation_bytes, 1_625_000);
  assert.equal(measuredLimits.reservation_basis, "revision-fenced-discovery");
  assert.equal(measuredLimits.ceiling_bytes, defaultLimits.ceiling_bytes);
  assert.equal(measuredLimits.reserve_bytes, defaultLimits.reserve_bytes);
  assert.equal(
    measuredLimits.future_daily_recovery_bytes,
    defaultLimits.future_daily_recovery_bytes,
  );
  assert.equal(
    policyLimits(meter, "discovery", now, 24_000_000).operation_reservation_bytes,
    24_000_000,
  );
  assert.equal(
    policyLimits(meter, "recovery", now, 1_625_000).operation_reservation_bytes,
    48_000_000,
  );
  for (const bad of [0, -1, Infinity, NaN, 1.5])
    assert.throws(
      () => policyLimits(meter, "discovery", now, bad, true),
      /Invalid maintenance reservation/u,
    );
  assert.throws(
    () => policyLimits(meter, "recovery", now, 1_625_000, true),
    /requires a discovery response bound/u,
  );
  assert.throws(
    () => policyLimits(meter, "discovery", now, undefined, true),
    /requires a discovery response bound/u,
  );
});

void test("Neon Free readings preserve missing dimensions and require an active period", () => {
  const sampledAt = "2026-11-20T20:43:15.000Z";
  const project = {
    id: "wispy-salad-36926388",
    owner: { subscription_type: "free_v3" },
    consumption_period_start: "2026-11-12T21:55:18Z",
    consumption_period_end: "2026-12-01T00:00:00Z",
    data_transfer_bytes: 4_065_773_982,
    compute_time_seconds: 9790,
    active_time_seconds: 34828,
  };
  const branch = { id: "br-frosty-bar-bbaitwbu", project_id: project.id, logical_size: 170606592 };
  const meter = normalizeNeonMeter(project, branch, sampledAt);
  assert.equal(meter.branchTransferBytes, null);
  assert.equal(meter.computeSeconds, 9790);
  assert.equal(policyLimits(meter, "collect", Date.parse(sampledAt)).reserve_bytes, 350_000_000);
  assert.throws(
    () => normalizeNeonMeter({ ...project, data_transfer_bytes: null }, branch, sampledAt),
    /usable/u,
  );
  assert.throws(() => normalizeNeonMeter(project, branch, "2026-12-01T00:00:00Z"), /usable/u);
});

void test("a failed Neon meter read names each failing read and Neon's reason", async (t) => {
  const token = "napi_fixture_secret";
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const answers: Record<string, () => Response> = {
    "": () => Response.json({ project: { effective_project_permission: "VIEWER" } }),
    "/branches/br-frosty-bar-bbaitwbu": () =>
      Response.json({ message: "not allowed for viewer" }, { status: 404 }),
    "/endpoints": () => Response.json({ message: `bad token ${token}\nretry` }, { status: 403 }),
  };
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    const suffix = url.slice(url.indexOf("wispy-salad-36926388") + "wispy-salad-36926388".length);
    return answers[suffix]!();
  };
  await assert.rejects(sampleNeon({ PORTCOVE_NEON_METER_TOKEN: token }), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /Neon branch read returned HTTP 404: not allowed for viewer/u);
    assert.match(message, /Neon endpoints read returned HTTP 403: bad token \[credential\] retry/u);
    assert.doesNotMatch(message, /napi_fixture_secret/u, "the credential is never retained");
    assert.doesNotMatch(
      message,
      /credential (?:belongs|is not|identity)/u,
      "no probe on partial 404",
    );
    return true;
  });
  // A read that cannot connect, or answers with an unreadable body, is named too.
  answers[""] = () => {
    throw new Error(`connect failed with ${token}`);
  };
  answers["/endpoints"] = () => new Response("not json", { status: 200 });
  await assert.rejects(sampleNeon({ PORTCOVE_NEON_METER_TOKEN: token }), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /Neon project read failed: connect failed with \[credential\]/u);
    assert.match(message, /Neon endpoints read returned an unreadable body/u);
    assert.doesNotMatch(message, /napi_fixture_secret/u);
    assert.doesNotMatch(message, /credential (?:belongs|is not|identity)/u);
    return true;
  });
  assert.equal(neonDiagnostic("x".repeat(500), ""), "x".repeat(200));
  // A project invisible to every read names whose credential it is.
  const missing = () => Response.json({ message: "project not found" }, { status: 404 });
  answers[""] = missing;
  answers["/branches/br-frosty-bar-bbaitwbu"] = missing;
  answers["/endpoints"] = missing;
  let identity: Record<string, () => Response> = {
    "/users/me": () => Response.json({ id: "user-1", email: "private@example.com" }),
    "/users/me/organizations": () => Response.json({ organizations: [{ id: "org-other" }] }),
  };
  const projectFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    const path = url.slice(url.indexOf("/api/v2") + "/api/v2".length);
    return identity[path] ? identity[path]() : projectFetch(input);
  };
  await assert.rejects(sampleNeon({ PORTCOVE_NEON_METER_TOKEN: token }), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /Neon project read returned HTTP 404: project not found/u);
    assert.match(
      message,
      /credential belongs to Neon user user-1, not a member of org-polished-frog-23199890$/u,
    );
    assert.doesNotMatch(message, /org-other/u, "unrelated memberships are not retained");
    assert.doesNotMatch(message, /private@example\.com/u, "no email is retained");
    return true;
  });
  identity["/users/me/organizations"] = () =>
    Response.json({ organizations: [{ id: "org-polished-frog-23199890" }] });
  await assert.rejects(sampleNeon({ PORTCOVE_NEON_METER_TOKEN: token }), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /member of org-polished-frog-23199890 but without access to project/u);
    return true;
  });
  identity["/users/me/organizations"] = () => new Response("", { status: 500 });
  await assert.rejects(sampleNeon({ PORTCOVE_NEON_METER_TOKEN: token }), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /user-1, organizations unreadable \(HTTP 500\)/u);
    return true;
  });
  identity["/users/me"] = () => Response.json({ message: "overloaded" }, { status: 503 });
  await assert.rejects(sampleNeon({ PORTCOVE_NEON_METER_TOKEN: token }), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /credential identity unreadable \(users\/me HTTP 503: overloaded\)/u);
    return true;
  });
  identity = {
    "/users/me": () =>
      Response.json({ message: `not allowed for org keys ${token}` }, { status: 403 }),
  };
  await assert.rejects(sampleNeon({ PORTCOVE_NEON_METER_TOKEN: token }), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(
      message,
      /credential is not a personal key \(users\/me HTTP 403: not allowed for org keys \[credential\]\)/u,
    );
    assert.doesNotMatch(message, /napi_fixture_secret/u);
    return true;
  });
});

void test(
  "shared admissions fence concurrent callers and retain crash charges",
  {
    skip: server.skip ?? false,
    timeout: 120_000,
  },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const { owner, as } = fixture.start("quota");
    migrate(owner);
    const initial = testMeter(0);
    initial.transferBytes =
      policyLimits(initial, "recovery", Date.now()).ceiling_bytes - 60_000_000;
    const attempt = (request: string) =>
      new Promise<string | null>((resolve, reject) => {
        const module = new URL("./maintenance-resource-policy.mts", import.meta.url).href;
        const code = `import { acquireMaintenanceReservation as acquire } from ${JSON.stringify(module)};
      const result = acquire(process.env, { meter: ${JSON.stringify(initial)}, operation: "recovery",
        request: ${JSON.stringify(request)}, reason: "test/concurrent" });
      process.stdout.write(JSON.stringify(result.attempt_id));`;
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: owner });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) => {
          if (status !== 0) reject(new Error(stderr));
          else resolve(JSON.parse(stdout) as string | null);
        });
      });
    const admitted = (await Promise.all([attempt("a"), attempt("b")])).find(Boolean);
    assert.ok(admitted);
    runSql(owner, "CREATE ROLE quota_executor LOGIN IN ROLE portcove_maintenance_executor;");
    const blockedUpdate = runSql(
      as("quota_executor"),
      `UPDATE portcove_maintenance_meta.resource_admissions
      SET outcome='completed', finished_at=clock_timestamp(), estimate_bytes=0 WHERE attempt_id='${admitted}'
      RETURNING attempt_id;`,
    ).trim();
    assert.equal(blockedUpdate, "", "intake cannot settle a reservation owned by collection");
    assert.equal(await attempt("new"), null, "stalled meter cannot erase the earlier charge");
    const reserve = (meter: NeonMeter, request: string) =>
      acquireMaintenanceReservation(owner, {
        meter,
        request,
        operation: "recovery",
        reason: "test",
      });
    assert.equal(
      reserve({ ...initial, transferBytes: initial.transferBytes - 1 }, "regressed").reason,
      "counter-regressed",
    );
    assert.throws(
      () => reserve({ ...initial, sampledAt: initial.periodStart }, "old"),
      /cannot cover/u,
    );
    runSql(
      owner,
      "UPDATE portcove_maintenance_meta.resource_admissions SET started_at = clock_timestamp() - interval '4 days';",
    );
    assert.equal(await attempt("after-crash"), null, "an abandoned reservation is still charged");
    assert.equal(
      reserve({ ...initial, transferBytes: 4_900_000_000 }, "denied-peak").attempt_id,
      null,
    );
    assert.equal(reserve(initial, "stale-after-denial").reason, "counter-regressed");
    const reset = {
      ...initial,
      transferBytes: 5,
      periodStart: new Date(Date.now() - 60_000).toISOString(),
    };
    assert.equal(reserve(reset, "overlap").reason, "overlapping-provider-period");
    runSql(
      owner,
      `UPDATE portcove_maintenance_meta.resource_admissions SET reset_at='${reset.periodStart}';`,
    );
    assert.ok(
      reserve(reset, "after-reset").attempt_id,
      "scheduled continuation can admit after reset",
    );
  },
);

void test(
  "a completed charge leaves the ledger once the provider counter has settled past it",
  { skip: server.skip ?? false, timeout: 120_000 },
  (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const { owner } = fixture.start("settled-charge");
    migrate(owner);
    const meter = testMeter(1_000_000_000);
    const take = (request: string) =>
      acquireMaintenanceReservation(owner, {
        meter,
        request,
        operation: "collect",
        reason: "test",
      });
    const first = take("first").attempt_id;
    assert.ok(first);
    const finish = (ago: string) =>
      runSql(
        owner,
        `UPDATE portcove_maintenance_meta.resource_admissions
          SET outcome = 'completed', estimate_bytes = 3000000000,
              finished_at = clock_timestamp() - interval '${ago}'
          WHERE attempt_id = '${first}';`,
      );
    finish("1 hour");
    assert.equal(
      take("recent").attempt_id,
      null,
      "a recent completion may not be in the counter yet, so it is still charged",
    );
    finish("3 hours");
    assert.ok(
      take("settled").attempt_id,
      "a completion the counter already includes is not charged a second time",
    );
    runSql(
      owner,
      `UPDATE portcove_maintenance_meta.resource_admissions
        SET outcome = 'failed', finished_at = clock_timestamp() - interval '3 hours',
            reserved_bytes = 3000000000, estimate_bytes = NULL
        WHERE attempt_id = '${first}';`,
    );
    assert.equal(take("uncertain").attempt_id, null, "an uncertain outcome stays fully charged");
    // A known pre-export deferral charges only measured metadata. Unknown
    // deferrals and failed exports keep their full reservation.
    runSql(
      owner,
      `UPDATE portcove_maintenance_meta.resource_admissions
        SET operation = 'recovery', outcome = 'deferred', estimate_bytes = 2000000,
            finished_at = clock_timestamp() - interval '1 hour'
        WHERE attempt_id = '${first}';`,
    );
    const measured = take("measured-preflight");
    assert.ok(measured.attempt_id);
    assert.ok(measured.unreconciled_bytes < 3_000_000_000);
    runSql(
      owner,
      `UPDATE portcove_maintenance_meta.resource_admissions
        SET estimate_bytes = NULL WHERE attempt_id = '${first}';`,
    );
    assert.equal(take("unmeasured-preflight").attempt_id, null);

    // The fixed cutover sample predates the completion, so it never settles.
    const cutover = {
      ...meter,
      sampleOrigin: "november-cutover" as const,
      sampledAt: new Date(Date.now() - 7_200_000).toISOString(),
    };
    runSql(
      owner,
      `UPDATE portcove_maintenance_meta.resource_admissions
        SET outcome = 'completed', estimate_bytes = 3000000000,
            finished_at = clock_timestamp() - interval '3 hours'
        WHERE attempt_id = '${first}';`,
    );
    assert.equal(
      acquireMaintenanceReservation(owner, {
        meter: cutover,
        request: "cutover-unsettled",
        operation: "collect",
        reason: "test",
      }).attempt_id,
      null,
      "a completion after the fixed cutover sample never settles",
    );
  },
);

void test(
  "recovery retries reserve and settle real ledger attempts without retrying uncertain transfers",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const source = fixture.start("admitted-source").owner;
    // Distinct socket paths keep scratch SQL outside the measured source envelope.
    const scratch = postgresFixture(context, server.directory!);
    const prefixDatabase = scratch.start("prefix").owner;
    const target = scratch.start("target").owner;
    migrate(source);
    runSql(
      source,
      `INSERT INTO portcove_maintenance.discovery_collection_state
      (scope, definition_sha256, revision, state, state_sha256, updated_at)
      VALUES ('primary', '${hex("a")}', 0,
        jsonb_build_object('payload', repeat('x', 25000000)), '${hex("b")}', clock_timestamp());`,
    );
    const output = path.join(fixture.root, "admitted-backup");
    const recover = createBackupRecovery({ source, prefixDatabase, target, output });
    const meter = testMeter(0);
    const reserve = (request: string, reservationBytes?: number, reading = meter) =>
      acquireMaintenanceReservation(source, {
        meter: reading,
        request,
        operation: "recovery",
        reason: "test",
        ...(reservationBytes === undefined ? {} : { reservationBytes }),
      });
    const ledger = (request: string) =>
      queryJson(
        source,
        `SELECT json_agg(
      json_build_object('outcome', outcome, 'reserved', reserved_bytes, 'estimate', estimate_bytes)
      ORDER BY started_at, attempt_id) FROM portcove_maintenance_meta.resource_admissions
      WHERE request_key = '${request}';`,
      ) as { outcome: string; reserved: number; estimate: number | null }[];
    const result = await retryBackupAdmission((bytes) =>
      runAdmittedMaintenance(source, reserve("real-recovery", bytes), recover, {
        estimate: ({ transfer }) =>
          2_000_000 +
          Math.ceil(
            1.25 *
              (transfer.history_copy_bytes +
                transfer.other_table_copy_bytes +
                transfer.row_delta_copy_bytes +
                transfer.row_delta_plan_bytes),
          ),
      }),
    );
    assert.equal(result.reused, false);
    const rows = ledger("real-recovery");
    assert.deepEqual(
      rows.map(({ outcome }) => outcome),
      ["deferred", "completed"],
    );
    assert.ok(rows[0]!.estimate! < rows[0]!.reserved);
    assert.ok(rows[1]!.reserved > rows[0]!.reserved);
    assert.equal(result.transfer.reserved_bytes, rows[1]!.reserved);
    assert.ok(rows[1]!.estimate! > 0);

    let calls = 0;
    await assert.rejects(
      retryBackupAdmission((bytes) =>
        runAdmittedMaintenance(source, reserve("uncertain", bytes), () => {
          calls++;
          throw new Error("uncertain export");
        }),
      ),
      /uncertain export/u,
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      ledger("uncertain").map(({ outcome, estimate }) => ({ outcome, estimate })),
      [{ outcome: "failed", estimate: null }],
    );

    // Leave enough for an ordinary reservation, but not for its measured larger retry.
    const ceiling = policyLimits(meter, "recovery", Date.now()).ceiling_bytes;
    const charged = rows[0]!.estimate! + rows[1]!.estimate! + ledger("uncertain")[0]!.reserved;
    const constrained = { ...meter, transferBytes: ceiling - charged - 49_000_000 };
    let exports = 0;
    await assert.rejects(
      retryBackupAdmission((bytes) =>
        runAdmittedMaintenance(source, reserve("denied-retry", bytes, constrained), () => {
          exports++;
          throw new MaintenanceBackupDeferred(60_000_000, 48_000_000);
        }),
      ),
      MaintenanceResourceDeferred,
    );
    assert.equal(exports, 1);
    assert.deepEqual(
      ledger("denied-retry").map(({ outcome, reserved }) => ({ outcome, reserved })),
      [
        { outcome: "deferred", reserved: 48_000_000 },
        { outcome: "deferred", reserved: 0 },
      ],
    );
  },
);

void test(
  "a pre-0011 portable backup restores and migrates normalized discovery hints",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const source = fixture.start("legacy").owner;
    const target = fixture.start("upgraded").owner;
    const directory = path.join(fixture.root, "legacy-migrations");
    mkdirSync(directory);
    for (const migration of readMigrations().filter(({ version }) => version <= 10)) {
      const name = `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`;
      copyFileSync(path.join(defaultMigrationDirectory, name), path.join(directory, name));
      runSql(source, migrationTransaction(migration));
    }
    assert.equal(migrationStatus(source, directory).schema_version, 10);
    runSql(source, seed);
    runSql(
      source,
      `INSERT INTO portcove_maintenance.discovery_collection_state
      (scope, definition_sha256, revision, state, state_sha256, updated_at)
      SELECT scope, '${hex("a")}', 4, state,
        encode(sha256(convert_to(state::text, 'UTF8')), 'hex'), clock_timestamp()
      FROM (VALUES
        ('primary', '{"cursor":"next","leads":{"external":{"hints":{"one":{"repo":"a/b"},"two":{"repo":"c/d"}},"checked":2}}}'::jsonb),
        ('empty', '{"leads":{"external":{"hints":{},"checked":0}}}'::jsonb),
        ('plain', '{"cursor":"unchanged"}'::jsonb)
      ) AS states(scope, state);`,
    );
    const logical = runSql(
      source,
      "SELECT jsonb_object_agg(scope, state) FROM portcove_maintenance.discovery_collection_state;",
    );
    const archive = path.join(fixture.root, "legacy-backup");
    const manifest = await backup(source, archive, directory);
    assert.equal(manifest.schema_version, 10);
    assert.equal(manifest.tables["portcove_maintenance.discovery_external_hints"], undefined);
    assert.deepEqual(manifest.tables, JSON.parse(runSql(source, digestQuery(10))));
    const restored = restore(target, archive);
    assert.equal(restored.verified, true);
    assert.equal(restored.sequences_verified, true);
    assert.deepEqual(
      restored.migrated,
      readMigrations()
        .filter(({ version }) => version > 10)
        .map(({ version }) => version),
    );
    assert.equal(restored.tables["portcove_maintenance.discovery_external_hints"]?.rows, 2);
    assert.deepEqual(
      JSON.parse(
        runSql(
          target,
          `SELECT jsonb_object_agg(scope,
        portcove_maintenance.discovery_expanded_state(scope, state))
        FROM portcove_maintenance.discovery_collection_state;`,
        ),
      ),
      JSON.parse(logical),
    );
    assert.equal(
      runSql(
        target,
        "SELECT collection_active FROM portcove_maintenance_meta.discovery_intake_activation;",
      ).trim(),
      "f",
    );
    assert.equal(
      runSql(
        target,
        "SELECT collection_generation FROM portcove_maintenance_meta.discovery_intake_activation;",
      ).trim(),
      "2",
    );
    assert.equal(
      runSql(
        target,
        "SELECT has_function_privilege('portcove_maintenance_collector', 'portcove_maintenance.discovery_acquire_compact(text,uuid,uuid,integer,text,text,text)', 'EXECUTE');",
      ).trim(),
      "f",
    );
  },
);

void test(
  "recovery reconstruction reuses history and restores current state and sequences",
  {
    skip: server.skip ?? false,
    timeout: 240_000,
  },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const source = fixture.start("source").owner;
    const prefix = fixture.start("prefix").owner;
    const target = fixture.start("scratch").owner;
    const proof = fixture.start("proof").owner;
    migrate(source);
    runSql(source, seed);
    // A large unchanged discovery state would exceed the ordinary test
    // reservation if sent again, even though its complete digest matches.
    runSql(
      source,
      `INSERT INTO portcove_maintenance.discovery_collection_state
      (scope, definition_sha256, revision, state, state_sha256, updated_at)
      VALUES ('primary', '${hex("a")}', 0, jsonb_build_object('fixture', repeat('x', 3000000)),
        '${hex("b")}', clock_timestamp());
      INSERT INTO portcove_maintenance.discovery_collection_attempts
        (attempt_id, scope, acquisition, collection_generation, source_revision, runner, started_at, finished_at, outcome)
      VALUES ('00000000-0000-4000-8000-000000000001', 'primary', 1, 1, 'test', 'test', clock_timestamp(), clock_timestamp(), 'complete');
      INSERT INTO portcove_maintenance.discovery_lead_records (scope, lead_id, record, updated_attempt_id)
      SELECT 'primary', i, jsonb_build_object('id', i, 'payload', repeat('y', 30000)),
        '00000000-0000-4000-8000-000000000001'::uuid FROM generate_series(1, 100) i;`,
    );
    const previous = path.join(fixture.root, "previous");
    await backup(source, previous);
    runSql(
      source,
      `UPDATE portcove_maintenance.discovery_lead_records
      SET record = jsonb_build_object('id', 1, 'payload', 'changed') WHERE scope = 'primary' AND lead_id = 1;
      DELETE FROM portcove_maintenance.discovery_lead_records WHERE scope = 'primary' AND lead_id = 2;
      INSERT INTO portcove_maintenance.discovery_lead_records (scope, lead_id, record, updated_attempt_id)
      VALUES ('primary', 101, '{"id":101,"payload":"new"}', '00000000-0000-4000-8000-000000000001');`,
    );
    runSql(source, executorSeed);
    runSql(
      source,
      `SELECT setval('portcove_maintenance.observations_observation_id_seq', 5000, true);
    INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at)
      VALUES ('run-2', 'catalog', 'fixture', '2026-11-03T00:00:00Z');
    INSERT INTO portcove_maintenance.observations
      (run_id, subject_key, scope, input_revision, content_sha256, observed_at, payload)
      VALUES ('run-2', 'port:example-port', '{}', 'commit-b', '${hex("b")}', '2026-11-03T00:00:01Z', '{"test":"suffix"}');`,
    );
    const output = path.join(fixture.root, "reconstructed");
    await assert.rejects(
      backupReusingHistory({ source, prefixDatabase: prefix, target, output, reservedBytes: 1 }),
      MaintenanceBackupDeferred,
    );
    runSql(
      source,
      "CREATE TABLE portcove_maintenance.unexpected(data text); INSERT INTO portcove_maintenance.unexpected VALUES (repeat('x', 10000));",
    );
    await assert.rejects(
      backupReusingHistory({
        source,
        prefixDatabase: prefix,
        target,
        output,
        reservedBytes: 5_000_000,
      }),
      /Protected table inventory/u,
    );
    runSql(source, "DROP TABLE portcove_maintenance.unexpected;");
    const recover = createBackupRecovery({
      source,
      prefixDatabase: prefix,
      target,
      previous,
      output,
    });
    let required = 0;
    await assert.rejects(recover(2_000_000), (error: unknown) => {
      if (!(error instanceof MaintenanceBackupDeferred)) return false;
      required = error.requiredBytes;
      assert.equal(error.reservedBytes, 2_000_000);
      return Number.isSafeInteger(required) && required > 2_000_000;
    });
    // Same verified local seed, fresh production snapshot, newly sized allowance.
    const result = await recover(required + 100_000);
    const measurement = {
      host: source.PGHOST!,
      payloadBytes: 0,
      byteLimit: 2_000_000,
      deadline: Date.now() + 60_000,
    };
    await maintenanceTransfer.run(measurement, () =>
      withExportedSnapshot(source, async (_snapshot, query) => {
        const response = await query("SELECT repeat('x', 10000);");
        assert.ok(response.length >= 10_000);
      }),
    );
    assert.ok(
      measurement.payloadBytes >= 10_000,
      "exported-snapshot responses are charged to admission",
    );
    assert.ok(result.transfer.history_copy_bytes > 0 && result.transfer.history_copy_bytes < 250);
    assert.ok(
      result.transfer.reused_tables.includes("portcove_maintenance.discovery_collection_state"),
    );
    assert.ok(!result.transfer.reused_tables.includes("portcove_maintenance.collection_runs"));
    assert.ok(result.transfer.estimated_payload_ceiling < 5_000_000);
    assert.deepEqual(result.transfer.row_delta_tables, [
      { table: "portcove_maintenance.discovery_lead_records", changed_or_removed_keys: 3 },
    ]);
    assert.ok(
      result.transfer.row_delta_copy_bytes > 0 && result.transfer.row_delta_copy_bytes < 1000,
    );
    assert.ok(result.transfer.row_delta_plan_bytes > 0);
    assert.equal(result.manifest.sequences?.[0]?.last_value, "5001");
    const restored = restore(proof, output);
    assert.equal(restored.sequences_verified, true);
    const reusePrefix = fixture.start("reuse-prefix").owner;
    const reused = await backupReusingHistory({
      source,
      prefixDatabase: reusePrefix,
      target,
      previous: output,
      output: path.join(fixture.root, "duplicate"),
      reservedBytes: 5_000_000,
      reuseRecent: true,
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.manifest.dump.sha256, result.manifest.dump.sha256);
    assert.equal(reused.transfer.history_copy_bytes, 0);
    assert.deepEqual(restored.tables, storeDigest(source));
    assert.equal(
      runSql(
        proof,
        "SELECT active FROM portcove_maintenance_meta.discovery_intake_activation;",
      ).trim(),
      "f",
    );
  },
);

void test("credential-free cutover is bound to one endpoint, period, and finite envelope", () => {
  const endpoint = { PGHOST: "ep-shy-resonance-bb33lu82.c-15.us-east-1.aws.neon.tech" };
  const now = Date.parse("2026-11-21T04:47:00Z");
  const meter = cutoverReading(endpoint, "recovery", now);
  assert.ok(meter);
  assert.equal(meter.sampleOrigin, "november-cutover");
  assert.equal(policyLimits(meter, "recovery", now).cutover_allowance_bytes, 300_000_000);
  assert.equal(cutoverReading(endpoint, "recovery-full", now), undefined);
  assert.equal(cutoverReading({ PGHOST: "ep-other.neon.tech" }, "recovery", now), undefined);
  assert.equal(
    cutoverReading({ ...endpoint, PORTCOVE_NEON_METER_TOKEN: "configured" }, "recovery", now),
    undefined,
  );
  assert.equal(cutoverReading(endpoint, "recovery", Date.parse(meter.resetAt)), undefined);
});

void test("expired production reservations refuse client I/O and snapshots", async () => {
  const environment = {
    PGHOST: "never-connected.invalid",
    PORTCOVE_POSTGRES_BIN: "/missing-test-bin",
  };
  await maintenanceTransfer.run(
    { host: environment.PGHOST, byteLimit: 1_000_000, payloadBytes: 0, deadline: Date.now() - 1 },
    async () => {
      assert.throws(() => runSql(environment, "SELECT 1;"), /reservation expired/u);
      await assert.rejects(
        withExportedSnapshot(environment, async () => null),
        /reservation expired/u,
      );
    },
  );
});

void test(
  "cutover admissions share their finite allowance across purposes",
  {
    skip: server.skip ?? false,
    timeout: 120_000,
  },
  (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const { owner } = fixture.start("cutover-quota");
    migrate(owner);
    const now = Date.now();
    const meter: NeonMeter = {
      ...testMeter(4_065_773_982),
      sampleOrigin: "november-cutover",
      sampledAt: new Date(now - 6_000_000).toISOString(),
      resetAt: new Date(now + 4 * 86_400_000).toISOString(),
    };
    const take = (
      request: string,
      operation: "recovery" | "recovery-catchup" | "collect" | "intake",
    ) =>
      acquireMaintenanceReservation(owner, { meter, request, operation, reason: "cutover/test" });
    assert.ok(take("routine", "recovery").attempt_id);
    assert.ok(take("collect", "collect").attempt_id);
    assert.ok(take("intake", "intake").attempt_id);
    assert.ok(take("catchup", "recovery-catchup").attempt_id);
    assert.equal(take("overflow", "recovery-catchup").attempt_id, null);
  },
);
