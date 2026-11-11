import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { registerDisposableDirectory } from "./fixtures/disposable-directory.mts";
import {
  backup,
  clientEnvironment,
  connectionFromEnvironment,
  defaultMigrationDirectory,
  libpqEnvironmentFromUrl,
  migrate,
  migrationStatus,
  migrationTransaction,
  planMigrations,
  readMigrations,
  restore,
  runSql,
  storeDigest,
} from "./maintenance-store.mts";

const prerequisite = "PostgreSQL server prerequisite unavailable";

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

function postgresServerDirectory() {
  if (process.platform === "win32") return { skip: `${prerequisite}: Linux/macOS cluster fixture` };
  if (process.getuid?.() === 0) return { skip: `${prerequisite}: initdb refuses the root user` };
  const configured = process.env.PORTCOVE_POSTGRES_BIN?.trim();
  const candidates = configured
    ? [configured]
    : existsSync("/usr/lib/postgresql")
      ? readdirSync("/usr/lib/postgresql")
          .filter((name) => /^\d+$/u.test(name) && Number(name) >= 16)
          .sort((left, right) => Number(right) - Number(left))
          .map((name) => `/usr/lib/postgresql/${name}/bin`)
      : [];
  const directory = candidates.find((candidate) => existsSync(path.join(candidate, "initdb")));
  return directory
    ? { directory }
    : { skip: `${prerequisite}: PostgreSQL 16+ server binaries not found` };
}

const server = postgresServerDirectory();
let nextPort = 15_400 + (process.pid % 400) * 2;

function run(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${path.basename(binary)} ${args.join(" ")}\n${result.stderr}`);
}

/** A disposable PostgreSQL cluster on a private Unix socket. */
function cluster(fixture: { root: string; stops: (() => void)[] }, name: string) {
  const { root } = fixture;
  const bin = server.directory!;
  const data = path.join(root, name);
  const port = nextPort++;
  run(path.join(bin, "initdb"), [
    "-D",
    data,
    "-U",
    "owner",
    "--auth=trust",
    "--no-locale",
    "-E",
    "UTF8",
  ]);
  run(path.join(bin, "pg_ctl"), [
    "-D",
    data,
    "-l",
    `${data}.log`,
    "-w",
    "-o",
    `-k ${root} -c listen_addresses= -p ${port}`,
    "start",
  ]);
  fixture.stops.push(() =>
    run(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]),
  );
  const as = (user: string) =>
    clientEnvironment(
      libpqEnvironmentFromUrl(`postgresql://${user}@localhost/postgres?host=${root}&port=${port}`),
      { ...process.env, PORTCOVE_POSTGRES_BIN: bin },
    );
  return { owner: as("owner"), as };
}

function fixtureRoot(context: TestContext) {
  // Short path: Unix socket paths are limited to about 100 bytes.
  const root = mkdtempSync(path.join(os.tmpdir(), "pcm-"));
  const stops: (() => void)[] = [];
  // Servers stop before their data directories are removed.
  registerDisposableDirectory(context, root, {
    drain() {
      const failures: unknown[] = [];
      for (const stop of stops.splice(0))
        try {
          stop();
        } catch (error) {
          failures.push(error);
        }
      if (failures.length) throw new AggregateError(failures, "PostgreSQL fixture did not stop");
    },
  });
  return { root, stops };
}

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
INSERT INTO portcove_maintenance.operations (operation_id, kind, subject_key, fence_sequence, executor, created_at, updated_at)
  VALUES ('op-1', 'intake', 'port:example-port', 3, 'hosted-discovery-intake', '2026-11-03T00:04:00Z', '2026-11-03T00:04:00Z');
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
    const fixture = fixtureRoot(context);
    const { root } = fixture;
    const source = cluster(fixture, "source");
    const target = cluster(fixture, "target");

    assert.equal(migrationStatus(source.owner).schema_version, 0);
    assert.deepEqual(migrate(source.owner).newly_applied, [1]);
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
    assert.equal(manifest.schema_version, 1);
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
    runSql(target.owner, "CREATE ROLE executor_login LOGIN IN ROLE portcove_maintenance_executor;");
    const restoredExecutor = target.as("executor_login");
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
    const fixture = fixtureRoot(context);
    const { root } = fixture;
    const store = cluster(fixture, "store");
    const migrations = path.join(root, "migrations");
    mkdirSync(migrations);
    copyFileSync(
      path.join(defaultMigrationDirectory, "0001_maintenance_history.sql"),
      path.join(migrations, "0001_maintenance_history.sql"),
    );
    writeFileSync(
      path.join(migrations, "0002_interrupted.sql"),
      "CREATE TABLE portcove_maintenance.partial (id integer);\nSELECT 1 / 0;\n",
    );
    assert.throws(() => migrate(store.owner, migrations), /division by zero/u);
    const status = migrationStatus(store.owner, migrations);
    assert.equal(status.schema_version, 1);
    assert.deepEqual(status.pending, [{ version: 2, name: "interrupted" }]);
    assert.match(
      runSql(store.owner, "SELECT to_regclass('portcove_maintenance.partial') IS NULL;"),
      /t/u,
    );

    writeFileSync(
      path.join(migrations, "0002_interrupted.sql"),
      "CREATE TABLE portcove_maintenance.partial (id integer);\n",
    );
    assert.deepEqual(migrate(store.owner, migrations).newly_applied, [2]);
    writeFileSync(
      path.join(migrations, "0002_interrupted.sql"),
      "CREATE TABLE portcove_maintenance.changed (id integer);\n",
    );
    assert.throws(() => migrate(store.owner, migrations), /differs from the applied migration/u);
    assert.deepEqual(migrationStatus(store.owner, migrations).problems, [
      "migration 2 (interrupted) differs from the applied migration",
    ]);
  },
);
