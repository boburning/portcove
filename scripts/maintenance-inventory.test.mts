import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { postgresFixture, postgresServer } from "./fixtures/postgres-cluster.mts";
import {
  acknowledgeDigest,
  buildDigest,
  renderDigestMarkdown,
  buildReport,
  canonicalJson,
  capabilityResult,
  collect,
  readSample,
  renderHtml,
  writeReport,
  type InventoryReport,
} from "./maintenance-inventory.mts";
import { migrate, runSql } from "./maintenance-store.mts";

const report = (setup: string) => ({
  format_version: 1,
  port_id: "x",
  routes: [
    {
      route: "managed",
      install_id: null,
      features: [
        {
          feature: "setup",
          mode: setup,
          explanation: "e",
          next_step: "n",
          action: null,
          listing_action: null,
        },
      ],
    },
  ],
  observations: [],
  detail_problems: [],
});

void test("inventory facts hash canonically and Core reports are projected without reinterpretation", () => {
  assert.equal(
    canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }),
    canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
  );
  assert.deepEqual(capabilityResult({ ok: true, report: report("automatic") }), {
    state: "managed-setup.automatic",
    explanation: {
      report_format: 1,
      routes: [
        {
          route: "managed",
          features: [{ feature: "setup", mode: "automatic", explanation: "e", next_step: "n" }],
        },
      ],
      detail_problems: [],
    },
  });
  assert.equal(
    capabilityResult({ ok: false, error: { code: "not_found", message: "unknown port id" } }).state,
    "unassessed.not_found",
  );
  assert.equal(readSample().format_version, 1);
});

void test("the static report escapes untrusted text and states unknown publication", () => {
  const page = renderHtml({
    format: "portcove-maintenance-inventory",
    format_version: 1,
    generated_at: "2026-11-11T00:00:00.000Z",
    scope: "declared-sample",
    publication: { status: "unknown", reason: "<b>none</b>" },
    unsupported_sources: [{ source: "issues", reason: "</script><script>alert(1)</script>" }],
    runs: [
      {
        source: "<i>x</i>",
        coverage: "complete",
        source_revision: "r",
        observed_count: 1,
        expected_count: 1,
        completed_at: "t",
      },
    ],
    subjects: [{ subject_key: "port:</script>", state: "s", sequence: 1, assessed_at: "t" }],
  } satisfies InventoryReport);
  assert.equal(page.match(/<\/script>/gu)?.length, 2, "only the page's own two scripts close");
  assert.doesNotMatch(page, /<b>none<\/b>|<i>x<\/i>/u);
  assert.match(page, /unknown/u);
});

const server = postgresServer();

/** A stub Core CLI answering from responses.json and logging its isolation paths. */
function stubCli(root: string) {
  const responses = path.join(root, "responses.json");
  const cli = path.join(root, "portcove-stub.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
  import { readFileSync } from "node:fs";
  import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
  import path from "node:path";
  const args = process.argv.slice(2);
  const responses = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8"));
  const preferences = process.env.PORTCOVE_PREFERENCES;
  mkdirSync(path.join(path.dirname(preferences), "diagnostics"), { recursive: true });
  const root = path.dirname(path.dirname(preferences));
  appendFileSync(${JSON.stringify(path.join(root, "isolation.log"))}, JSON.stringify([preferences, process.env.PORTCOVE_APPLICATION_RUNTIME_LOCK, args[1], realpathSync(root) === root, path.dirname(process.env.HOME) === root]) + "\\n");
  writeFileSync(path.join(path.dirname(preferences), "diagnostics", "session-01"), "simulated");
  const reply = (envelope) => { console.log(JSON.stringify({ schema_version: 88, ...envelope })); process.exitCode = envelope.ok ? 0 : 1; };
  if (args.includes("capabilities")) {
    reply({ ok: true, data: { schema_version: 88, port_capability_schema: 1 }, error: null });
  } else {
    const id = args.at(-1);
    const data = responses[id];
    if (typeof data === "string") reply({ ok: false, data: null, error: { code: data, message: "host failure" } });
    else if (data) reply({ ok: true, data, error: null });
    else reply({ ok: false, data: null, error: { code: "not_found", message: "unknown port id: " + id } });
  }
  `,
  );
  chmodSync(cli, 0o755);
  return { cli, responses };
}

void test(
  "declared records flow through Core assessment, the store and a static report",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("store");
    migrate(store.owner);
    runSql(
      store.owner,
      `CREATE ROLE collector_login LOGIN IN ROLE portcove_maintenance_collector;
       CREATE ROLE report_login LOGIN IN ROLE portcove_maintenance_report;
       CREATE ROLE executor_login LOGIN IN ROLE portcove_maintenance_executor;`,
    );
    const { cli, responses } = stubCli(fixture.root);
    const sample = path.join(fixture.root, "sample.json");
    writeFileSync(
      sample,
      JSON.stringify({ format_version: 1, ports: ["2ship2harkinian", "not-a-catalog-port"] }),
    );
    const respond = (ship: string, other?: string) =>
      writeFileSync(
        responses,
        JSON.stringify({
          "2ship2harkinian": ship === "automatic" || ship === "manual" ? report(ship) : ship,
          ...(other ? { "not-a-catalog-port": other } : {}),
        }),
      );
    const collector = store.as("collector_login");
    const history = () =>
      JSON.parse(
        runSql(
          store.owner,
          `SELECT json_agg(json_build_object('subject', subject_key, 'sequence', sequence, 'state', state, 'returns', returns_to_earlier_result)
             ORDER BY subject_key, sequence) FROM portcove_maintenance.subject_transitions;`,
        ),
      ) as { subject: string; sequence: number; state: string; returns: boolean }[];

    respond("automatic");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    assert.deepEqual(
      history().map(({ subject, state }) => [subject, state]),
      [
        ["port:2ship2harkinian", "managed-setup.automatic"],
        ["port:not-a-catalog-port", "unassessed.not_found"],
      ],
      "an identical repeated pass converges on the same assessments without new transitions",
    );
    respond("manual");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    respond("automatic");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    assert.deepEqual(
      history()
        .filter(({ subject }) => subject === "port:2ship2harkinian")
        .map(({ state, returns }) => [state, returns]),
      [
        ["managed-setup.automatic", false],
        ["managed-setup.manual", false],
        ["managed-setup.automatic", true],
      ],
    );

    // Changes-only digest: baselines are quiet, the return to an earlier result is flagged.
    const digest = buildDigest(store.as("report_login"));
    assert.deepEqual(
      digest.entries.map(({ subject_key, previous_state, state, returns_to_earlier_result }) => [
        subject_key,
        previous_state,
        state,
        returns_to_earlier_result,
      ]),
      [
        ["port:2ship2harkinian", "managed-setup.automatic", "managed-setup.manual", false],
        ["port:2ship2harkinian", "managed-setup.manual", "managed-setup.automatic", true],
      ],
    );
    assert.match(renderDigestMarkdown(digest), /returns to an earlier result/u);
    assert.throws(() => acknowledgeDigest(collector, digest, "receipt"), /permission denied/u);
    const executor = store.as("executor_login");
    const receipt = "https://github.com/boburning/portcove/issues/4129#issuecomment-1";
    assert.deepEqual(acknowledgeDigest(executor, digest, receipt), { delivered: 2 });
    assert.deepEqual(acknowledgeDigest(executor, digest, receipt), { delivered: 0 });
    assert.deepEqual(buildDigest(store.as("report_login")).entries, []);
    assert.equal(
      renderDigestMarkdown(buildDigest(store.owner)),
      "No maintenance changes since the last delivered digest.\n",
    );

    // Host failures are coverage gaps, never subject state.
    const runs = () =>
      JSON.parse(
        runSql(
          store.owner,
          `SELECT json_agg(json_build_object('source', source, 'coverage', coverage, 'observed', observed_count, 'gaps', gaps)
             ORDER BY started_at, source) FROM portcove_maintenance.collection_runs;`,
        ),
      ) as {
        source: string;
        coverage: string;
        observed: number;
        gaps: { subject_key: string; code: string }[];
      }[];
    const before = history().length;
    respond("network");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    respond("conflict", "conflict");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    respond("automatic");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    assert.equal(history().length, before, "failures and recovery create no transitions");
    assert.deepEqual(
      runs()
        .slice(-6)
        .map(({ source, coverage, observed, gaps }) => [
          source.startsWith("core-port-capabilities") ? "core" : source,
          coverage,
          observed,
          gaps.map(({ subject_key, code }) => `${subject_key}:${code}`),
        ]),
      [
        ["catalog-records", "complete", 2, []],
        ["core", "partial", 1, ["port:2ship2harkinian:network"]],
        ["catalog-records", "complete", 2, []],
        [
          "core",
          "failed",
          0,
          ["port:2ship2harkinian:conflict", "port:not-a-catalog-port:conflict"],
        ],
        ["catalog-records", "complete", 2, []],
        ["core", "complete", 2, []],
      ],
    );
    // A temporary directory reached through a symlink still yields real, isolated paths.
    const realTemporary = path.join(fixture.root, "real-tmp");
    const linkedTemporary = path.join(fixture.root, "linked-tmp");
    mkdirSync(realTemporary);
    symlinkSync(realTemporary, linkedTemporary);
    const previousTemporary = process.env.TMPDIR;
    process.env.TMPDIR = linkedTemporary;
    try {
      await collect({ cli, sample, environment: collector, runner: "fixture" });
    } finally {
      if (previousTemporary === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemporary;
    }
    // Every CLI call ran with its own preferences, diagnostics, lock and home, all removed afterwards.
    const isolation = readFileSync(path.join(fixture.root, "isolation.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as [string, string, string, boolean, boolean]);
    assert.equal(isolation.length, 8 * 3);
    assert.equal(new Set(isolation.map(([preferences]) => preferences)).size, isolation.length);
    for (const [preferences, lock, , realRoot, isolatedHome] of isolation) {
      assert.ok(
        realRoot && isolatedHome,
        `isolation root is a real path holding HOME: ${preferences}`,
      );
      assert.ok(path.isAbsolute(preferences) && path.dirname(lock) === path.dirname(preferences));
      assert.equal(
        existsSync(path.dirname(path.dirname(preferences))),
        false,
        "isolated state is removed",
      );
    }

    const reader = store.as("report_login");
    const inventory = buildReport(reader, new Date("2026-11-11T00:00:00Z"));
    assert.equal(inventory.publication.status, "unknown");
    assert.ok(inventory.unsupported_sources.some(({ source }) => source === "project"));
    assert.deepEqual(
      (inventory.runs as { source: string; coverage: string; observed_count: number }[]).map(
        ({ source, coverage, observed_count }) => [
          source.startsWith("core-port-capabilities") ? "core" : source,
          coverage,
          observed_count,
        ],
      ),
      [
        ["catalog-records", "complete", 2],
        ["core", "complete", 2],
      ],
    );
    const ship = (
      inventory.subjects as {
        subject_key: string;
        explanation: { listing_only: boolean; catalog_record_present: boolean };
        observations: { input_revision: string }[];
      }[]
    ).find(({ subject_key }) => subject_key === "port:2ship2harkinian")!;
    assert.equal(ship.explanation.catalog_record_present, true);
    assert.equal(ship.explanation.listing_only, false);
    assert.equal(ship.observations.length, 2);
    assert.equal((ship as unknown as { latest_core_run: string }).latest_core_run, "assessed");
    assert.equal(
      (ship as unknown as { identity: { game: string } }).identity.game,
      "The Legend of Zelda: Majora's Mask",
    );
    const absent = (
      inventory.subjects as {
        subject_key: string;
        explanation: { catalog_record_present: boolean };
      }[]
    ).find(({ subject_key }) => subject_key === "port:not-a-catalog-port")!;
    assert.equal(absent.explanation.catalog_record_present, false);

    const output = path.join(fixture.root, "report");
    writeReport(inventory, output);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(output, "inventory.json"), "utf8")),
      JSON.parse(JSON.stringify(inventory)),
    );
    assert.ok(existsSync(path.join(output, "index.html")));
    assert.throws(() => writeReport(inventory, output), /already exists/u);
    assert.throws(
      () => runSql(reader, "DELETE FROM portcove_maintenance.collection_runs;"),
      /permission denied/u,
      "reporting is read-only",
    );
  },
);

void test(
  "complete collection stores changes only, verifies membership and records absence",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const incremental = fixture.start("incremental");
    const direct = fixture.start("direct");
    migrate(incremental.owner);
    migrate(direct.owner);
    const { cli, responses } = stubCli(fixture.root);
    const respond = (setup: string) =>
      writeFileSync(
        responses,
        JSON.stringify({
          "2ship2harkinian": setup.startsWith(":") ? setup.slice(1) : report(setup),
        }),
      );
    const ports = ["2ship2harkinian", "not-a-catalog-port"];
    const count = (environment: NodeJS.ProcessEnv, sql: string) =>
      Number(runSql(environment, sql).trim());
    const runs = () =>
      JSON.parse(
        runSql(
          incremental.owner,
          `SELECT json_agg(json_build_object('source', split_part(source, '-', 1), 'coverage', coverage,
             'observed', observed_count, 'members', member_count,
             'rows', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id),
             'absent', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id
                          AND o.payload = portcove_maintenance.absent_payload())) ORDER BY started_at, source)
             FROM portcove_maintenance.collection_runs r;`,
        ),
      ) as {
        source: string;
        coverage: string;
        observed: number;
        members: number;
        rows: number;
        absent: number;
      }[];
    const all = (environment: NodeJS.ProcessEnv, universe: string[]) =>
      collect({ cli, all: true, ports: universe, environment, runner: "fixture", concurrency: 2 });

    respond("automatic");
    await all(incremental.owner, ports);
    await all(incremental.owner, ports);
    respond("manual");
    await all(incremental.owner, ports);
    respond("automatic");
    await all(incremental.owner, ports);
    respond(":network");
    await all(incremental.owner, ["2ship2harkinian"]);
    respond("automatic");
    await all(incremental.owner, ["2ship2harkinian"]);
    assert.deepEqual(
      runs().map(({ source, coverage, observed, members, rows, absent }) => [
        source,
        coverage,
        observed,
        members,
        rows,
        absent,
      ]),
      [
        // First pass: every subject is new.
        ["catalog", "complete", 2, 2, 2, 0],
        ["core", "complete", 2, 2, 2, 0],
        // Unchanged pass: nothing stored, membership still verified.
        ["catalog", "complete", 2, 2, 0, 0],
        ["core", "complete", 2, 2, 0, 0],
        // Core changes only for the changed port, in both directions.
        ["catalog", "complete", 2, 2, 0, 0],
        ["core", "complete", 2, 2, 1, 0],
        ["catalog", "complete", 2, 2, 0, 0],
        ["core", "complete", 2, 2, 1, 0],
        // A partial Core run never records absence; the complete catalog run does.
        ["catalog", "complete", 1, 1, 1, 1],
        ["core", "failed", 0, 0, 0, 0],
        // The next complete Core run records the absence.
        ["catalog", "complete", 1, 1, 0, 0],
        ["core", "complete", 1, 1, 1, 1],
      ],
    );

    // A declared membership that does not match retained observations is refused.
    assert.throws(
      () =>
        runSql(
          incremental.owner,
          `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at)
             VALUES ('forged', 'catalog-records', 'fixture', now());
           UPDATE portcove_maintenance.collection_runs SET coverage = 'complete', completed_at = clock_timestamp(),
             source_revision = 'r', expected_count = 2, member_count = 2, member_digest = '${"0".repeat(64)}'
             WHERE run_id = 'forged';`,
        ),
      /membership differs from its retained observations/u,
    );
    assert.throws(
      () =>
        runSql(
          incremental.owner,
          `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at) VALUES
             ('first', 'parallel', 'fixture', now()), ('second', 'parallel', 'fixture', now());`,
        ),
      /already has a collection run in progress/u,
    );

    // The verified issue and Project inventory joins canonical work to ports.
    let shipState = "OPEN";
    const issues = () =>
      Promise.resolve({
        repository: "boburning/portcove",
        observed_at: "2026-11-11T00:00:00Z",
        total: 2,
        issues: [
          {
            id: "I1",
            number: 1,
            title: "Ship",
            state: shipState,
            body: "<!-- portcove-catalog-id: 2ship2harkinian -->",
          },
          { id: "I2", number: 2, title: "Other", state: "OPEN", body: "" },
        ],
        memberships: [
          {
            project_id: "P1",
            issue_id: "I1",
            isArchived: false,
            fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
          },
        ],
      });
    const withIssues = () =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        issues,
        environment: incremental.owner,
        runner: "fixture",
      });
    await withIssues();
    await withIssues();
    shipState = "CLOSED";
    await withIssues();
    assert.deepEqual(
      runs()
        .filter(({ source }) => source === "issues")
        .map(({ coverage, members, rows }) => [coverage, members, rows]),
      [
        ["complete", 2, 2],
        ["complete", 2, 0],
        ["complete", 2, 1],
      ],
    );
    const withWork = buildReport(incremental.owner);
    assert.ok(
      !withWork.unsupported_sources.some(
        ({ source }) => source === "issues" || source === "project",
      ),
    );
    assert.equal(withWork.scope, "complete-authored-catalog");
    const shipWork = (
      withWork.subjects as {
        subject_key: string;
        work: { number: number; state: string; project: { fields: Record<string, string> }[] }[];
      }[]
    ).find(({ subject_key }) => subject_key === "port:2ship2harkinian")!.work;
    assert.deepEqual(
      shipWork.map(({ number, state, project }) => [number, state, project[0]?.fields.Status]),
      [[1, "CLOSED", "Ready"]],
    );
    assert.match(renderHtml(withWork), /#1 CLOSED · Ready/u);

    // Full and incremental assessment agree on identical final inputs.
    await all(direct.owner, ["2ship2harkinian"]);
    const current = (environment: NodeJS.ProcessEnv) =>
      runSql(
        environment,
        `SELECT json_agg(json_build_object('subject', c.subject_key, 'result', c.result_digest) ORDER BY c.subject_key)
           FROM portcove_maintenance.subject_current c WHERE c.subject_key = 'port:2ship2harkinian';`,
      ).trim();
    assert.equal(current(incremental.owner), current(direct.owner));
    assert.equal(
      count(direct.owner, "SELECT count(*) FROM portcove_maintenance.subject_transitions;"),
      1,
    );
  },
);
