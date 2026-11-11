import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { postgresFixture, postgresServer } from "./fixtures/postgres-cluster.mts";
import {
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

void test(
  "declared records flow through Core assessment, the store and a static report",
  { skip: server.skip ?? false, timeout: 240_000 },
  (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("store");
    migrate(store.owner);
    runSql(
      store.owner,
      `CREATE ROLE collector_login LOGIN IN ROLE portcove_maintenance_collector;
       CREATE ROLE report_login LOGIN IN ROLE portcove_maintenance_report;`,
    );
    const responses = path.join(fixture.root, "responses.json");
    const cli = path.join(fixture.root, "portcove-stub.mjs");
    writeFileSync(
      cli,
      `#!${process.execPath}
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const responses = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8"));
if (args.includes("capabilities")) {
  console.log(JSON.stringify({ schema_version: 88, ok: true, data: { schema_version: 88, port_capability_schema: 1 }, error: null }));
} else {
  const id = args.at(-1);
  const data = responses[id];
  console.log(JSON.stringify(data
    ? { schema_version: 88, ok: true, data, error: null }
    : { schema_version: 88, ok: false, data: null, error: { code: "not_found", message: "unknown port id: " + id } }));
}
`,
    );
    chmodSync(cli, 0o755);
    const sample = path.join(fixture.root, "sample.json");
    writeFileSync(
      sample,
      JSON.stringify({ format_version: 1, ports: ["2ship2harkinian", "not-a-catalog-port"] }),
    );
    const respond = (setup: string) =>
      writeFileSync(responses, JSON.stringify({ "2ship2harkinian": report(setup) }));
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
    collect({ cli, sample, environment: collector, runner: "fixture" });
    collect({ cli, sample, environment: collector, runner: "fixture" });
    assert.deepEqual(
      history().map(({ subject, state }) => [subject, state]),
      [
        ["port:2ship2harkinian", "managed-setup.automatic"],
        ["port:not-a-catalog-port", "unassessed.not_found"],
      ],
      "an identical repeated pass converges on the same assessments without new transitions",
    );
    respond("manual");
    collect({ cli, sample, environment: collector, runner: "fixture" });
    respond("automatic");
    collect({ cli, sample, environment: collector, runner: "fixture" });
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

    const reader = store.as("report_login");
    const inventory = buildReport(reader, new Date("2026-11-11T00:00:00Z"));
    assert.equal(inventory.publication.status, "unknown");
    assert.ok(inventory.unsupported_sources.some(({ source }) => source === "project"));
    assert.deepEqual(
      (inventory.runs as { source: string; coverage: string; observed_count: number }[]).map(
        ({ source, coverage, observed_count }) => [source, coverage, observed_count],
      ),
      [
        ["catalog-records", "complete", 2],
        ["core-port-capabilities", "complete", 2],
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
