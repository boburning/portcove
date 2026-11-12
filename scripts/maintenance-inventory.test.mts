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
  publicationFacts,
  assessmentSubject,
  hostPlatform,
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
import type { UpstreamInput } from "./maintenance-upstream.mts";
import type { HostedRequestStatus, HostedStatusAll } from "./hosted-discovery-intake.mts";
import { GitHubApiError } from "./github-operation.mts";
import { migrate, runSql } from "./maintenance-store.mts";
import { readOpenHandoffs, recordHandoffOperations } from "./maintenance-handoffs.mts";
import {
  catalog as catalogFixture,
  checkpoint,
  exception,
  keyOf,
  progress,
  scope,
} from "./fixtures/upstream-checkpoint-fixture.mts";

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
  assert.equal(
    canonicalJson({ a: undefined, b: [undefined, 1] }),
    JSON.stringify({ b: [null, 1] }),
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

void test("definition publication compares main with the appointed location without claiming verification", () => {
  const inspection = {
    index_sha256: "f".repeat(64),
    definitions: [
      {
        namespace: "official",
        stable_id: "example",
        revision: 1,
        definition_target: "sha256/x.json",
      },
    ],
  };
  const fact = (published_status: number | null) =>
    publicationFacts({ inspection, published_status }).facts.get("definition:official/example") as
      | { published: string; site: { status: string } }
      | undefined;
  assert.deepEqual([fact(404)?.published, fact(404)?.site.status], ["not-published", "absent"]);
  // A present site says nothing about an individual definition.
  assert.deepEqual(
    [fact(200)?.published, fact(200)?.site.status],
    ["unknown", "metadata-present-unverified"],
  );
  // Anything else is a gap, never a fact.
  assert.equal(fact(503), undefined);
  assert.deepEqual(
    publicationFacts({ inspection, published_status: null }).gaps.map(({ code }) => code),
    ["unreachable"],
  );
  assert.throws(() => publicationFacts({ inspection: {}, published_status: 404 }), /Unsupported/u);
  assert.throws(
    () =>
      publicationFacts({
        inspection: { index_sha256: "f", definitions: [{ namespace: "../x", stable_id: "y" }] },
        published_status: 404,
      }),
    /Unsupported definition identity/u,
  );
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
          `SELECT json_agg(json_build_object('subject', split_part(subject_key, '@', 1), 'sequence', sequence, 'state', state, 'returns', returns_to_earlier_result)
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
    const shipSubject = assessmentSubject("2ship2harkinian", hostPlatform());
    const digest = buildDigest(store.as("report_login"));
    assert.deepEqual(
      digest.entries.map(({ subject_key, previous_state, state, returns_to_earlier_result }) => [
        subject_key,
        previous_state,
        state,
        returns_to_earlier_result,
      ]),
      [
        [shipSubject, "managed-setup.automatic", "managed-setup.manual", false],
        [shipSubject, "managed-setup.manual", "managed-setup.automatic", true],
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
        port_key: string;
        explanation: { listing_only: boolean; catalog_record_present: boolean };
        observations: { input_revision: string }[];
      }[]
    ).find(({ port_key }) => port_key === "port:2ship2harkinian")!;
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
        port_key: string;
        explanation: { catalog_record_present: boolean };
      }[]
    ).find(({ port_key }) => port_key === "port:not-a-catalog-port")!;
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
        port_key: string;
        work: { number: number; state: string; project: { fields: Record<string, string> }[] }[];
      }[]
    ).find(({ port_key }) => port_key === "port:2ship2harkinian")!.work;
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
           FROM portcove_maintenance.subject_current c WHERE c.subject_key LIKE 'port:2ship2harkinian@%';`,
      ).trim();
    assert.equal(current(incremental.owner), current(direct.owner));
    assert.equal(
      count(direct.owner, "SELECT count(*) FROM portcove_maintenance.subject_transitions;"),
      1,
    );
  },
);

void test(
  "each host platform keeps its own assessment history, gaps and latest run",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("platforms");
    migrate(store.owner);
    const { cli, responses } = stubCli(fixture.root);
    const ports = ["2ship2harkinian", "not-a-catalog-port"];
    const on = (platform: string, ship: unknown) => {
      writeFileSync(responses, JSON.stringify({ "2ship2harkinian": ship }));
      return collect({
        cli,
        all: true,
        ports,
        platform,
        environment: store.owner,
        runner: "fixture",
      });
    };
    // Identical Core results on alternating hosts: no spurious transitions or notifications.
    await on("linux-x86-64", report("automatic"));
    await on("windows-x86-64", report("automatic"));
    await on("linux-x86-64", report("automatic"));
    assert.equal(
      runSql(store.owner, "SELECT count(*) FROM portcove_maintenance.subject_transitions;").trim(),
      "4",
      "one baseline per port and platform",
    );
    assert.equal(
      runSql(store.owner, "SELECT count(*) FROM portcove_maintenance.notifications;").trim(),
      "0",
    );
    // The latest Core run (Windows, partial) is not the alphabetically first source.
    await on("windows-x86-64", "network");
    const inventory = buildReport(store.owner);
    const status = (inventory.subjects as { subject_key: string; latest_core_run: string }[]).map(
      ({ subject_key, latest_core_run }) => [subject_key, latest_core_run],
    );
    assert.deepEqual(status, [
      ["port:2ship2harkinian@linux-x86-64", "assessed"],
      ["port:2ship2harkinian@windows-x86-64", "gap"],
      ["port:not-a-catalog-port@linux-x86-64", "assessed"],
      ["port:not-a-catalog-port@windows-x86-64", "assessed"],
    ]);
  },
);

void test(
  "release health records coverage, quiet recurrence and needs-attention conditions",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("health");
    migrate(store.owner);
    const { cli, responses } = stubCli(fixture.root);
    writeFileSync(responses, JSON.stringify({ "2ship2harkinian": report("automatic") }));
    const health =
      (occurrences: number, stale: string[] = []) =>
      () =>
        Promise.resolve({
          revision: `upstream-health-run:${occurrences}`,
          report: {
            format_version: 1,
            authority:
              "upstream-monitoring-only; no acquisition, artifact, lineage or publication authority",
            inventory: {
              total_ports: 1 + stale.length,
              fresh_complete_port_ids: ["2ship2harkinian"],
              fresh_partial_port_ids: [],
              stale_port_ids: stale,
              unmonitored_port_ids: [],
            },
            known_conditions: [
              {
                key: "k1",
                classification: "unclassified-or-actionable",
                accounted_for: false,
                port_id: "2ship2harkinian",
                operation: "observe-availability",
                rule: "provider-redirect",
                occurrences,
              },
            ],
          },
        });
    const collectWith = (releaseHealth: ReturnType<typeof health>) =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        releaseHealth,
        environment: store.owner,
        runner: "fixture",
      });
    await collectWith(health(1));
    await collectWith(health(2));
    await collectWith(health(3, ["mdk-sdl-nemo22"]));
    const healthRuns = JSON.parse(
      runSql(
        store.owner,
        `SELECT json_agg(json_build_object('coverage', coverage, 'expected', expected_count, 'observed', observed_count,
           'rows', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id),
           'gaps', jsonb_array_length(gaps)) ORDER BY started_at)
           FROM portcove_maintenance.collection_runs r WHERE source = 'release-health';`,
      ),
    ) as { coverage: string; expected: number; observed: number; rows: number; gaps: number }[];
    assert.deepEqual(
      healthRuns.map(({ coverage, expected, observed, rows, gaps }) => [
        coverage,
        expected,
        observed,
        rows,
        gaps,
      ]),
      [
        ["complete", 1, 1, 1, 0],
        // A routine recurrence is the same fact: nothing stored.
        ["complete", 1, 1, 0, 0],
        // A stale port is a gap and makes the run partial.
        ["partial", 2, 1, 0, 1],
      ],
    );
    await collect({
      cli,
      all: true,
      ports: ["2ship2harkinian"],
      publication: () =>
        Promise.resolve({
          inspection: {
            index_sha256: "f".repeat(64),
            definitions: [{ namespace: "official", stable_id: "example", revision: 1 }],
          },
          published_status: 404,
        }),
      environment: store.owner,
      runner: "fixture",
    });
    const inventory = buildReport(store.owner);
    assert.ok(!inventory.unsupported_sources.some(({ source }) => source === "release-health"));
    assert.ok(
      !inventory.unsupported_sources.some(({ source }) => source === "definition-publication"),
    );
    assert.equal(inventory.publication.status, "observed");
    assert.match(
      inventory.publication.reason,
      /definition:official\/example revision 1 on main; published: not-published \(appointed site absent\)/u,
    );
    // An unclassifiable probe keeps the last known facts and records a failed run with a gap.
    await collect({
      cli,
      all: true,
      ports: ["2ship2harkinian"],
      publication: () =>
        Promise.resolve({
          inspection: {
            index_sha256: "f".repeat(64),
            definitions: [{ namespace: "official", stable_id: "example", revision: 1 }],
          },
          published_status: 503,
        }),
      environment: store.owner,
      runner: "fixture",
    });
    const afterOutage = buildReport(store.owner);
    assert.match(afterOutage.publication.reason, /published: not-published/u);
    assert.match(
      runSql(
        store.owner,
        "SELECT coverage || ':' || (gaps -> 0 ->> 'code') FROM portcove_maintenance.collection_runs WHERE source = 'definition-publication' ORDER BY started_at DESC LIMIT 1;",
      ),
      /failed:http-503/u,
    );
    assert.match(renderHtml(inventory), /provider-redirect \(observe-availability\)/u);
  },
);

void test(
  "upstream observations record coverage, quiet recurrence, attention and failed reads",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("upstream");
    migrate(store.owner);
    const { cli, responses } = stubCli(fixture.root);
    writeFileSync(responses, JSON.stringify({ "2ship2harkinian": report("automatic") }));
    // The observer maps its own catalog: the assessed port shares a source key with "alpha".
    const observerCatalog = {
      ports: [
        { id: "2ship2harkinian", channels: ["stable"], release: { repository: "owner/alpha" } },
        catalogFixture.ports[2]!,
      ],
    };
    const observed = (sources: Record<string, unknown>, run: number) => () =>
      Promise.resolve({
        revision: `upstream-observer-run:${run}`,
        config_sha256: scope,
        checkpoint: checkpoint(sources, 9),
        catalog: observerCatalog,
      });
    const collectWith = (upstream: () => Promise<UpstreamInput>) =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        upstream,
        environment: store.owner,
        runner: "fixture",
      });
    const complete = (overrides = {}) => ({
      [keyOf("owner/alpha")]: progress("owner/alpha", ["2ship2harkinian"], overrides),
      [keyOf("owner/gamma")]: progress("owner/gamma", ["gamma"]),
    });
    await collectWith(observed(complete(), 1));
    // Only per-observation clocks and progress moved: nothing is stored.
    await collectWith(
      observed(
        complete({
          attempted_sequence: 9,
          freshness_observed_at: "2026-11-10T16:00:00.000Z",
          next_due_at: "2026-11-10T22:00:00.000Z",
        }),
        2,
      ),
    );
    // An exception is a changed fact; a never-completed source is a gap.
    await collectWith(
      observed(
        {
          [keyOf("owner/alpha")]: progress("owner/alpha", ["2ship2harkinian"], {
            exception_key: exception,
            exception_rule: "repository-unavailable",
          }),
          [keyOf("owner/gamma")]: progress("owner/gamma", [], {
            completed_scope_sha256: null,
            last_complete_facts_sha256: null,
          }),
        },
        3,
      ),
    );
    // A reset scope is a per-port gap; the stored exception facts stay current.
    await collectWith(
      observed(
        complete({
          completed_scope_sha256: null,
          exception_key: exception,
          exception_rule: "repository-unavailable",
        }),
        4,
      ),
    );
    // A failed read observes nothing; the prior facts stay current.
    await collectWith(() => Promise.reject(new Error("artifact download refused")));
    const runs = JSON.parse(
      runSql(
        store.owner,
        `SELECT json_agg(json_build_object('coverage', coverage, 'expected', expected_count, 'observed', observed_count,
           'rows', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id),
           'gaps', (SELECT coalesce(json_agg(g ->> 'code'), '[]') FROM jsonb_array_elements(gaps) g)) ORDER BY started_at)
           FROM portcove_maintenance.collection_runs r WHERE source = 'upstream-observations';`,
      ),
    ) as {
      coverage: string;
      expected: number | null;
      observed: number;
      rows: number;
      gaps: string[];
    }[];
    assert.deepEqual(
      runs.map(({ coverage, expected, observed: count, rows, gaps }) => [
        coverage,
        expected,
        count,
        rows,
        gaps,
      ]),
      [
        ["complete", 2, 2, 2, []],
        ["complete", 2, 2, 0, []],
        ["partial", 2, 1, 1, ["unobserved"]],
        ["partial", 2, 1, 0, ["scope-changed"]],
        ["failed", null, 0, 0, ["unavailable"]],
      ],
    );
    const inventory = buildReport(store.owner);
    assert.ok(
      !inventory.unsupported_sources.some(({ source }) => source === "upstream-observations"),
    );
    const subject = inventory.subjects[0] as {
      upstream: { sources: { exception_rule: string }[] } | null;
      latest_upstream_gap: { code: string } | null;
    };
    assert.equal(subject.upstream?.sources[0]?.exception_rule, "repository-unavailable");
    // Per-port gaps come from the latest run that did not fail.
    assert.equal(subject.latest_upstream_gap?.code, "scope-changed");
    const page = renderHtml(inventory);
    assert.match(page, /upstream observer exception: repository-unavailable \(owner\/alpha\)/u);
    assert.match(
      page,
      /owner\/alpha: facts ffffffffffff, last change [^;"]+; latest attempt failed: unavailable; previous checkpoint: scope-changed/u,
    );
    // The failed attempt stays in the source table with its own source-level gap.
    assert.match(page, /source:upstream-observer-checkpoint: unavailable/u);
  },
);

void test(
  "hosted intake records requests, quiet recurrence, attention, gaps and failed reads",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("hosted");
    migrate(store.owner);
    const { cli, responses } = stubCli(fixture.root);
    writeFileSync(responses, JSON.stringify({ "2ship2harkinian": report("automatic") }));
    const hold = {
      http_status: 404,
      resume:
        "Use owner process dispatch when the exact repository ID and primary evidence are accessible.",
    };
    const slot = (issue: number | null, overrides = {}) => ({
      candidate_index: 0,
      port_key: "example-game",
      repository_id: 7,
      upstream: "https://github.com/owner/example-game",
      delivery_status: issue ? "delivered" : "prepared",
      linked_issue: issue,
      existing: false,
      hold: null,
      ...overrides,
    });
    // Each request exactly as the executor's status() reports it, clocks included.
    const request = (id: number, observed: string, overrides = {}): HostedRequestStatus => ({
      request_comment: id,
      receipt_comment: id + 1,
      reconciles: null,
      body_request_comment: id,
      status: "complete",
      candidates: 1,
      delivered: 1,
      existing: 0,
      held: 0,
      pending: 0,
      full_doctor_required: false,
      doctor: null,
      last_error: null,
      observed_at: observed,
      slots: [slot(id === 10 ? 1 : null)],
      withdrawn: false,
      superseded_by: [],
      ...overrides,
    });
    const requests = (observed: string) => [
      request(10, observed),
      request(20, observed, {
        status: "blocked",
        delivered: 0,
        pending: 1,
        reconciles: 5,
        last_error: { code: "operation_failed", message: `stopped at ${observed}` },
      }),
      request(30, observed, {
        status: "blocked",
        withdrawn: true,
        delivered: 0,
        pending: 1,
        last_error: { code: "operation_failed", message: "withdrawn by the owner" },
      }),
      request(40, observed, {
        status: "complete_with_holds",
        delivered: 0,
        held: 1,
        pending: 1,
        slots: [slot(null, { hold })],
      }),
    ];
    const queue = (comments: number) => ({
      node_id: "I177",
      comments,
      updated_at: `2026-11-11T0${comments}:00:00Z`,
      comments_sha256: String(comments).repeat(64).slice(0, 64),
    });
    const issues = () =>
      Promise.resolve({
        repository: "boburning/portcove",
        observed_at: "2026-11-11T00:00:00Z",
        total: 1,
        issues: [{ id: "I1", number: 1, title: "Example", state: "OPEN", body: "" }],
        memberships: [
          {
            project_id: "P1",
            issue_id: "I1",
            isArchived: false,
            fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
          },
        ],
      });
    const collectWith = (hostedIntake: () => Promise<HostedStatusAll>) =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        issues,
        hostedIntake,
        environment: store.owner,
        runner: "fixture",
      });
    await collectWith(() =>
      Promise.resolve({ queue: queue(1), requests: requests("2026-11-10T00:00:00Z") }),
    );
    // Only receipt clocks, messages and the queue revision moved: nothing is stored.
    await collectWith(() =>
      Promise.resolve({ queue: queue(2), requests: requests("2026-11-11T00:00:00Z") }),
    );
    // A new request is a fact; a request the executor cannot validate is a gap.
    await collectWith(() =>
      Promise.resolve({
        queue: queue(3),
        requests: [
          ...requests("2026-11-11T00:00:00Z").filter(
            ({ request_comment }) => request_comment !== 20,
          ),
          {
            request_comment: 20,
            withdrawn: false,
            superseded_by: [],
            error: { code: "operation_failed", message: "Retained delivery state is incomplete" },
          },
          request(50, "2026-11-11T00:00:00Z", { status: "submitted", receipt_comment: null }),
        ],
      }),
    );
    // Drift and unavailable reads observe nothing; the prior facts stay current.
    await collectWith(() =>
      Promise.reject(new GitHubApiError("inventory_changed", "Hosted request queue changed")),
    );
    await collectWith(() => Promise.reject(new Error("credential unavailable")));
    const runs = JSON.parse(
      runSql(
        store.owner,
        `SELECT json_agg(json_build_object('coverage', coverage, 'expected', expected_count, 'observed', observed_count,
           'revision', source_revision,
           'rows', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id),
           'gaps', (SELECT coalesce(json_agg(g ->> 'subject_key' || ':' || (g ->> 'code')), '[]') FROM jsonb_array_elements(gaps) g)) ORDER BY started_at)
           FROM portcove_maintenance.collection_runs r WHERE source = 'hosted-intake';`,
      ),
    ) as {
      coverage: string;
      expected: number | null;
      observed: number;
      revision: string;
      rows: number;
      gaps: string[];
    }[];
    assert.deepEqual(
      runs.map(({ coverage, expected, observed, rows, gaps }) => [
        coverage,
        expected,
        observed,
        rows,
        gaps,
      ]),
      [
        ["complete", 4, 4, 4, []],
        ["complete", 4, 4, 0, []],
        ["partial", 5, 4, 1, ["intake:20:invalid-receipt"]],
        ["failed", null, 0, 0, ["source:hosted-intake-queue:inventory-changed"]],
        ["failed", null, 0, 0, ["source:hosted-intake-queue:unavailable"]],
      ],
    );
    assert.equal(
      runs[0]!.revision,
      `hosted-intake:I177:1@2026-11-11T01:00:00Z#sha256:${"1".repeat(64)}`,
    );
    const inventory = buildReport(store.owner);
    assert.ok(!inventory.unsupported_sources.some(({ source }) => source === "hosted-intake"));
    assert.deepEqual(
      inventory.hosted_intake?.map(({ subject_key, issues: work }) => [subject_key, work]),
      [
        ["intake:10", [{ number: 1, state: "OPEN", status: "Ready" }]],
        ["intake:20", []],
        ["intake:30", []],
        ["intake:40", []],
        ["intake:50", []],
      ],
      "a failed read and an invalid request keep the last known facts",
    );
    // Per-request gaps come from the latest run that did not fail.
    assert.deepEqual(
      inventory.hosted_intake?.map(({ subject_key, latest_gap }) => [subject_key, latest_gap]),
      [
        ["intake:10", null],
        ["intake:20", "invalid-receipt"],
        ["intake:30", null],
        ["intake:40", null],
        ["intake:50", null],
      ],
    );
    const page = renderHtml(inventory);
    assert.match(page, /latest attempt failed: unavailable; previous read: invalid-receipt/u);
    assert.doesNotMatch(page, /latest read: /u);
    assert.match(
      page,
      /hosted intake blocked: operation_failed \(receipt comment 21; reconciles request 5\)/u,
    );
    assert.match(page, /hosted intake held candidates \(receipt comment 41\): Use owner process/u);
    assert.doesNotMatch(page, /receipt comment 31/u, "a withdrawn request is never attention");
    assert.match(page, /#1 OPEN · Ready/u);
    assert.match(page, /source:hosted-intake-queue: unavailable/u);
  },
);

void test(
  "handoffs plan once, stay quiet, clear and abandon only after complete runs, and refuse stale fences",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("handoffs");
    migrate(store.owner);
    runSql(
      store.owner,
      `CREATE ROLE collector_login LOGIN IN ROLE portcove_maintenance_collector;
       CREATE ROLE report_login LOGIN IN ROLE portcove_maintenance_report;
       CREATE ROLE executor_login LOGIN IN ROLE portcove_maintenance_executor;`,
    );
    const collector = store.as("collector_login");
    const executor = store.as("executor_login");
    const reader = store.as("report_login");
    const { cli, responses } = stubCli(fixture.root);
    const respond = (ship: unknown) =>
      writeFileSync(responses, JSON.stringify({ "2ship2harkinian": ship }));
    const slot = (overrides = {}) => ({
      candidate_index: 0,
      port_key: "example-game",
      repository_id: 7,
      upstream: "https://github.com/owner/example-game",
      delivery_status: "prepared",
      linked_issue: null,
      existing: false,
      hold: null,
      ...overrides,
    });
    const request = (id: number, overrides = {}): HostedRequestStatus => ({
      request_comment: id,
      receipt_comment: id + 1,
      reconciles: null,
      body_request_comment: id,
      status: "complete",
      candidates: 1,
      delivered: 1,
      existing: 0,
      held: 0,
      pending: 0,
      full_doctor_required: false,
      doctor: null,
      last_error: null,
      observed_at: "2026-11-11T00:00:00Z",
      slots: [slot()],
      withdrawn: false,
      superseded_by: [],
      ...overrides,
    });
    const blocked = (id: number) =>
      request(id, {
        status: "blocked",
        delivered: 0,
        pending: 1,
        last_error: { code: "operation_failed", message: "stopped" },
      });
    const held = (id: number, resume: string) =>
      request(id, {
        status: "complete_with_holds",
        delivered: 0,
        held: 1,
        slots: [slot({ hold: { http_status: 404, resume } })],
      });
    let comments = 0;
    const queue = () => ({
      node_id: "I177",
      comments: ++comments,
      updated_at: "2026-11-11T00:00:00Z",
      comments_sha256: "c".repeat(64),
    });
    const collectWith = (requests: HostedRequestStatus[] | Error, platform = "linux-x86-64") =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        platform,
        hostedIntake: () =>
          requests instanceof Error
            ? Promise.reject(requests)
            : Promise.resolve({ queue: queue(), requests }),
        environment: collector,
        runner: "fixture",
      });
    const states = () =>
      JSON.parse(
        runSql(
          store.owner,
          `SELECT coalesce(json_agg(json_build_object('subject', t.subject_key, 'sequence', t.sequence, 'state', t.state,
             'returns', t.returns_to_earlier_result) ORDER BY t.subject_key COLLATE "C", t.sequence), '[]')
             FROM portcove_maintenance.subject_transitions t WHERE starts_with(t.subject_key, 'handoff:');`,
        ),
      ) as { subject: string; sequence: number; state: string; returns: boolean }[];
    const operations = () =>
      JSON.parse(
        runSql(
          store.owner,
          `SELECT coalesce(json_agg(json_build_object('id', operation_id, 'kind', kind, 'state', state, 'fence', fence_sequence,
             'revision', revision, 'executor', executor, 'receipt', receipt_reference, 'receipt_sha256', receipt_sha256)
             ORDER BY operation_id COLLATE "C"), '[]') FROM portcove_maintenance.operations;`,
        ),
      ) as {
        id: string;
        kind: string;
        state: string;
        fence: number;
        revision: number;
        executor: string;
        receipt: string | null;
        receipt_sha256: string | null;
      }[];
    const rowCounts = () =>
      runSql(
        store.owner,
        `SELECT (SELECT count(*) FROM portcove_maintenance.assessments) || '/' ||
                (SELECT count(*) FROM portcove_maintenance.subject_transitions) || '/' ||
                (SELECT count(*) FROM portcove_maintenance.notifications) || '/' ||
                (SELECT count(*) FROM portcove_maintenance.operations);`,
      ).trim();
    const blockedKey = "handoff:hosted-intake-blocked:intake:20";
    const heldKey = "handoff:hosted-intake-holds:intake:40";

    // A handoff appears: one needs-attention transition and notification; one planned operation.
    respond(report("automatic"));
    await collectWith([request(10), blocked(20), held(40, "first resume")]);
    assert.deepEqual(
      states().map(({ subject, sequence, state }) => [subject, sequence, state]),
      [
        [blockedKey, 1, "needs-attention"],
        [heldKey, 1, "needs-attention"],
      ],
      "a request that never needed attention gets no handoff row",
    );
    assert.throws(() => recordHandoffOperations(reader), /permission denied/u);
    assert.throws(() => recordHandoffOperations(collector), /permission denied/u);
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 2, open: 2 });
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 0, open: 2 });
    assert.deepEqual(
      operations().map(({ id, kind, state, fence, revision, executor: name, receipt }) => [
        id,
        kind,
        state,
        fence,
        revision,
        name,
        receipt,
      ]),
      [
        [
          "handoff.hosted-intake-blocked.intake:20.1",
          "handoff.hosted-intake-blocked",
          "planned",
          1,
          1,
          "hosted-discovery-intake.yml",
          null,
        ],
        [
          "handoff.hosted-intake-holds.intake:40.1",
          "handoff.hosted-intake-holds",
          "planned",
          1,
          1,
          "hosted-discovery-intake.yml",
          null,
        ],
      ],
    );

    // An unchanged rerun records nothing new, and a replayed record plans nothing.
    const settled = rowCounts();
    await collectWith([request(10), blocked(20), held(40, "first resume")]);
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 0, open: 2 });
    assert.equal(rowCounts(), settled);

    // Partial and failed runs never clear, even when the condition looks resolved.
    await collectWith([
      request(10),
      request(20),
      {
        request_comment: 40,
        withdrawn: false,
        superseded_by: [],
        error: { code: "operation_failed", message: "incomplete" },
      },
    ]);
    await collectWith(new Error("credential unavailable"));
    assert.equal(states().length, 2, "a partial or failed run neither clears nor records");
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 0, open: 2 });

    // A complete run without the condition clears it, and the stale plan is abandoned.
    await collectWith([request(10), request(20), held(40, "first resume")]);
    assert.deepEqual(
      states()
        .filter(({ subject }) => subject === blockedKey)
        .map(({ sequence, state }) => [sequence, state]),
      [
        [1, "needs-attention"],
        [2, "clear"],
      ],
    );
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 1, planned: 0, open: 1 });
    const abandoned = operations().find(
      ({ id }) => id === "handoff.hosted-intake-blocked.intake:20.1",
    )!;
    assert.deepEqual(
      [abandoned.state, abandoned.revision, abandoned.receipt, abandoned.receipt_sha256],
      ["abandoned", 2, null, null],
    );

    // A changed condition supersedes the earlier plan; a return is flagged as one.
    await collectWith([request(10), blocked(20), held(40, "second resume")]);
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 1, planned: 2, open: 2 });
    assert.deepEqual(
      states()
        .filter(({ sequence }) => sequence > 1)
        .map(({ subject, sequence, state, returns }) => [subject, sequence, state, returns]),
      [
        [blockedKey, 2, "clear", false],
        [blockedKey, 3, "needs-attention", true],
        [heldKey, 2, "needs-attention", false],
      ],
    );
    assert.deepEqual(
      operations().map(({ id, state, fence }) => [id, state, fence]),
      [
        ["handoff.hosted-intake-blocked.intake:20.1", "abandoned", 1],
        ["handoff.hosted-intake-blocked.intake:20.3", "planned", 3],
        ["handoff.hosted-intake-holds.intake:40.1", "abandoned", 1],
        ["handoff.hosted-intake-holds.intake:40.2", "planned", 2],
      ],
    );

    // A restored or stale worker cannot plan at an earlier fence or revive a superseded plan.
    assert.throws(
      () =>
        runSql(
          executor,
          `INSERT INTO portcove_maintenance.operations (operation_id, kind, subject_key, fence_sequence, executor, created_at, updated_at)
             VALUES ('handoff.hosted-intake-holds.intake:40.1x', 'handoff.hosted-intake-holds', '${heldKey}', 1,
                     'hosted-discovery-intake.yml', now(), now());`,
        ),
      /stale maintenance state/u,
    );
    assert.throws(
      () =>
        runSql(
          executor,
          `UPDATE portcove_maintenance.operations SET state = 'planned', revision = revision + 1
             WHERE operation_id = 'handoff.hosted-intake-holds.intake:40.1';`,
        ),
      /cannot move from abandoned to planned/u,
    );

    // Core owns its assessment: a Core change is a reported transition, never a handoff.
    const steady = [request(10), blocked(20), held(40, "second resume")];
    respond(report("manual"));
    await collectWith(steady);
    respond(report("automatic"));
    await collectWith(steady, "windows-x86-64");
    assert.equal(
      runSql(
        store.owner,
        `SELECT state FROM portcove_maintenance.subject_transitions
           WHERE subject_key = 'port:2ship2harkinian@linux-x86-64' ORDER BY sequence DESC LIMIT 1;`,
      ).trim(),
      "managed-setup.manual",
    );
    assert.ok(
      states().every(({ subject }) => /^handoff:hosted-intake-(blocked|holds):/u.test(subject)),
      "Core transitions create no handoff",
    );

    // A kind no longer in the registry (here, an older store's row) clears only on a
    // complete handoff source run.
    const retiredKey = "handoff:retired-kind:port:2ship2harkinian@linux-x86-64";
    runSql(
      store.owner,
      `INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at)
         VALUES ('${retiredKey}', 'maintenance-handoffs/0', '${"1".repeat(64)}', 'needs-attention', '${"2".repeat(64)}',
                 '{"handoff": "retired-kind"}', now());
       INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id)
         SELECT subject_key, 1, assessment_id FROM portcove_maintenance.assessments WHERE subject_key = '${retiredKey}';`,
    );
    await collectWith(new Error("credential unavailable"));
    assert.deepEqual(
      states()
        .filter(({ subject }) => subject === retiredKey)
        .map(({ state }) => state),
      ["needs-attention"],
    );
    await collectWith(steady);
    assert.deepEqual(
      states()
        .filter(({ subject }) => subject === retiredKey)
        .map(({ state }) => state),
      ["needs-attention", "clear"],
    );

    const inventory = buildReport(reader);
    assert.ok(
      !(inventory.subjects as { subject_key: string }[]).some(({ subject_key }) =>
        subject_key.startsWith("handoff:"),
      ),
      "handoffs are not inventory subjects",
    );
    assert.deepEqual(
      inventory.handoffs?.map(({ subject_key, operation }) => [
        subject_key,
        operation?.operation_id ?? null,
      ]),
      [
        [blockedKey, "handoff.hosted-intake-blocked.intake:20.3"],
        [heldKey, "handoff.hosted-intake-holds.intake:40.2"],
      ],
    );
    const page = renderHtml(inventory);
    assert.match(page, /<th>Next action<\/th>/u);
    assert.match(
      page,
      /gh workflow run hosted-discovery-intake\.yml --ref main -f mode=process\. Authority: owner-only\. Dispatch disabled: /u,
    );
    assert.match(page, /operation handoff\.hosted-intake-holds\.intake:40\.2 planned at fence 2/u);
    assert.match(page, /"next_actions":\[\]/u);
    // The changes-only digest carries handoff transitions with the registry action.
    const digest = buildDigest(reader);
    assert.ok(digest.entries.some(({ subject_key }) => subject_key === heldKey));
    assert.match(
      renderDigestMarkdown(digest),
      /`handoff:hosted-intake-holds:intake:40`: none → needs-attention; next action: Resume the held candidates/u,
    );
    assert.deepEqual(
      readOpenHandoffs(reader).map(({ subject_key }) => subject_key),
      [blockedKey, heldKey],
    );
  },
);
