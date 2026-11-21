import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { postgresFixture, postgresServer } from "./fixtures/postgres-cluster.mts";
import { postgresIntakeCheckpoints } from "./hosted-discovery-intake-checkpoint.mts";
import { backupReusingHistory, MaintenanceBackupDeferred } from "./maintenance-backup-reuse.mts";
import {
  acquireMaintenanceReservation,
  cutoverReading,
  normalizeNeonMeter,
  policyLimits,
  type NeonMeter,
} from "./maintenance-resource-policy.mts";
import {
  backup,
  batchedStatements,
  clientEnvironment,
  connectionFromEnvironment,
  defaultMigrationDirectory,
  libpqEnvironmentFromUrl,
  maintenanceTransfer,
  migrate,
  migrationStatus,
  migrationTransaction,
  planMigrations,
  portableRestoreSql,
  readMigrations,
  restore,
  runSql,
  serverInfo,
  storeDigest,
  withExportedSnapshot,
} from "./maintenance-store.mts";

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

    writeFileSync(
      path.join(migrations, interrupted),
      "CREATE TABLE portcove_maintenance.partial (id integer);\n",
    );
    assert.deepEqual(migrate(store.owner, migrations).newly_applied, [real.length + 1]);
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
    const previous = path.join(fixture.root, "previous");
    await backup(source, previous);
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
    const result = await backupReusingHistory({
      source,
      prefixDatabase: prefix,
      target,
      previous,
      output,
      reservedBytes: 5_000_000,
    });
    assert.ok(result.transfer.history_copy_bytes > 0 && result.transfer.history_copy_bytes < 250);
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
