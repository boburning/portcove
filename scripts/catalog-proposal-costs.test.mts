import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isRecord } from "./runtime-values.mts";
import { authoringRecordFromPort } from "./catalog-authoring.mts";
import { readFixtureModuleClosure } from "./fixtures/module-closure.mts";
function requiredFixture<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null, "Required fixture value missing");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  const values: unknown[] = value;
  return values.map(record);
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  if (typeof value !== "string") throw new Error("Expected text");
  return value;
}
function number(value: unknown): number {
  assert.equal(typeof value, "number");
  if (typeof value !== "number") throw new Error("Expected number");
  return value;
}
function fixtureJson(bytes: string | Buffer) {
  const value: unknown = JSON.parse(bytes.toString());
  return record(value);
}
interface NamedFixture extends Record<string, unknown> {
  id: string;
}
interface FixtureCatalog {
  schema_version: number;
  ports: NamedFixture[];
  source_catalog: Record<"identities" | "contracts" | "validators" | "evidence", NamedFixture[]> & {
    qualification: Record<string, unknown>[];
  };
}
function catalogFixture(value: unknown): FixtureCatalog {
  function assertCatalog(value: unknown): asserts value is FixtureCatalog {
    const catalog = record(value);
    number(catalog.schema_version);
    for (const port of records(catalog.ports)) text(port.id);
    const source = record(catalog.source_catalog);
    for (const key of ["identities", "contracts", "validators", "evidence"])
      for (const item of records(source[key])) text(item.id);
    records(source.qualification);
  }
  assertCatalog(value);
  return value;
}
function sourceTable(value: unknown) {
  const table = record(value);
  return {
    ...table,
    identities: records(table.identities),
    evidence: records(table.evidence),
    qualification: records(table.qualification),
  };
}
function declarationReview(value: unknown) {
  const review = record(value),
    tables = record(review.source_tables);
  const side = (value: unknown) => {
    const part = record(value),
      refs = record(part.source_record_refs);
    return {
      ...part,
      port: part.port,
      source_record_refs: {
        ...refs,
        identities: array(refs.identities),
        qualification: array(refs.qualification).map(number),
      },
    };
  };
  return {
    ...review,
    cases: records(review.cases).map((item) => ({
      ...item,
      port_id: text(item.port_id),
      reasons: item.reasons,
      unchanged_port_fields: item.unchanged_port_fields,
      adapter_references: item.adapter_references,
      before: side(item.before),
      after: side(item.after),
      checks: record(item.checks),
    })),
    source_tables: { before: sourceTable(tables.before), after: sourceTable(tables.after) },
    adapter_references: review.adapter_references,
    scope: text(review.scope),
    unmeasured: review.unmeasured,
  };
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const generatorModules = readFixtureModuleClosure(root, [
  "scripts/generate-catalog.mts",
  "scripts/runtime-values.mts",
  "scripts/catalog-authoring.mts",
  "scripts/catalog-authoring-inspector.mts",
  "scripts/upstream-lineage.mts",
]).modules;

// Fixed declarations and inert validator/provider controls measure the generator,
// independently of live catalog counts. No upstream executable or network runs.
function fixture(
  context: TestContext,
  mode = "success",
  failAt = "input",
  declarations: (catalog: FixtureCatalog) => void = () => {},
) {
  const scratch = disposableDirectory(context, join(tmpdir(), "portcove-proposal-costs-"));
  const scripts = join(scratch, "scripts");
  const catalogs = join(scratch, "crates", "portcove-core", "catalog");
  mkdirSync(scripts);
  mkdirSync(catalogs, { recursive: true });
  for (const module of generatorModules) {
    const destination = join(scratch, module.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, module.bytes);
  }
  const catalog: FixtureCatalog = {
    schema_version: 2,
    ports: [
      { id: "frozen-port", name: "Frozen" },
      { id: "added-port", name: "Added" },
    ],
    source_catalog: {
      identities: [{ id: "frozen-source" }, { id: "added-source" }],
      contracts: [],
      validators: [],
      evidence: [],
      qualification: [],
    },
  };
  declarations(catalog);
  for (const port of catalog.ports) {
    port.name ??= port.id;
    port.summary ??= "An inert proposal fixture.";
    port.project_url ??= `https://example.org/${port.id}`;
  }
  const { ports, ...shared } = catalog;
  mkdirSync(join(catalogs, "ports"));
  writeFileSync(join(catalogs, "catalog-shared.json"), JSON.stringify(shared));
  for (const [index, port] of ports.entries())
    writeFileSync(
      join(catalogs, "ports", `${port.id}.json`),
      JSON.stringify(authoringRecordFromPort(port, index)),
    );
  const accepted = Buffer.from(JSON.stringify(catalog));
  const input = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  const source = join(catalogs, "catalog-current-authoring.json");
  writeFileSync(source, accepted);
  writeFileSync(join(catalogs, "catalog.json"), accepted);
  writeFileSync(
    join(catalogs, "catalog-schema1-fixture.json"),
    JSON.stringify({
      ports: [{ id: "frozen-port" }],
      source_profiles: [{ id: "frozen-source" }],
    }),
  );
  writeFileSync(
    join(catalogs, "catalog-legacy-additions-fixture.json"),
    JSON.stringify({
      port_ids: ["added-port"],
      source_profile_ids: ["added-source"],
    }),
  );
  const proposal = join(scratch, "input.json");
  writeFileSync(proposal, input);
  const cli = join(scratch, "inert-validator");
  writeFileSync(cli, "inert first-party validator fixture; never executed");
  writeFileSync(
    join(scripts, "inspect-igdb-artwork.mts"),
    `
    import {readFileSync} from 'node:fs';
    export function readArtworkInput(path) {
      const bytes=readFileSync(path); return {bytes,document:JSON.parse(bytes)};
    }
    export function readArtworkJson(path) {return JSON.parse(readFileSync(path));}
    export function createCoreImageValidator() {throw new Error('reuse needs no image decoder');}
    export function createIgdbInspector() {
      return {providerMetrics:{authentication_requests:0,game_requests:0,image_requests:0}};
    }
    export async function prepareCatalogArtwork(input) {
      // Simulate provider wait on the controlled monotonic clock.
      globalThis.fixtureClock += 17000000n;
      return {catalog:input,records:[],metrics:{reused:2,original_reused:0}};
    }
    export async function prepareCatalogGameMedia() {
      throw new Error('proposal cost fixtures do not request game media');
    }
    export function reconcileCatalogArtworkWithdrawals() {
      throw new Error('proposal cost fixtures do not reconcile game media');
    }
  `,
  );
  const preload = join(scratch, "inert-process-control.mjs");
  writeFileSync(
    preload,
    `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {readFileSync} from 'node:fs';
    import {basename} from 'node:path';
    import {createHash} from 'node:crypto';
    globalThis.fixtureClock=0n;
    process.hrtime.bigint=()=>{globalThis.fixtureClock+=1000000n;return globalThis.fixtureClock;};
    let wall=1000000;Date.now=()=>wall-=10000;
    cp.spawnSync=(_artifact,args)=>{
      if (!args.includes('inspect-proposal')) throw new Error('unexpected subprocess');
      globalThis.fixtureClock+=100000000n;
      const bytes=readFileSync(args.at(-1));
      const selected=basename(args.at(-1),'.json')===process.env.COST_FAIL_AT;
      const mode=selected?process.env.COST_MODE:'success';
      const data={format_version:1,input_sha256:createHash('sha256').update(bytes).digest('hex'),input_bytes:bytes.length,ports:[]};
      if(mode==='hash')data.input_sha256='0'.repeat(64);
      if(mode==='bytes')data.input_bytes++;
      if(mode==='refusal')return {status:7,signal:null,stdout:'',stderr:'inert declaration refusal'};
      if(mode==='timeout')return {status:null,signal:'SIGTERM',error:{code:'ETIMEDOUT'},stdout:'',stderr:'inert timeout'};
      return {status:0,signal:null,stdout:JSON.stringify({data}),stderr:''};
    };
    syncBuiltinESMExports();
  `,
  );
  const output = join(scratch, "output");
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        "scripts/generate-catalog.mts",
        "--prepare-proposal",
        proposal,
        "--validator-cli",
        cli,
        "--output-dir",
        output,
      ],
      {
        cwd: scratch,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, COST_MODE: mode, COST_FAIL_AT: failAt },
      },
    );
  return { run, output, source, catalogs, proposal, accepted, input, cli };
}

function receipt(f: ReturnType<typeof fixture>, name: string) {
  return fixtureJson(readFileSync(join(f.output, "proposal-checks", `${name}-process.json`)));
}

function assertInputsPreserved(f: ReturnType<typeof fixture>) {
  assert.deepEqual(readFileSync(f.source), f.accepted);
  assert.deepEqual(readFileSync(join(f.catalogs, "catalog.json")), f.accepted);
  assert.deepEqual(readFileSync(f.proposal), f.input);
}

void test("proposal costs measure waiting with a monotonic clock and preserve exact three-check receipts", (context) => {
  const f = fixture(context);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = fixtureJson(readFileSync(join(f.output, "proposal-evidence.json")));
  assert.equal(report.format_version, 1);
  assert.equal(record(report.compatibility_fixture_review).status, "matched");
  assert.deepEqual(Object.keys(record(report.checks)), ["accepted", "input", "output"]);
  const costs = record(report.preparation_costs);
  const phases = records(costs.phases).map((phase) => ({
    ...phase,
    phase: text(phase.phase),
    elapsed_ms: number(phase.elapsed_ms),
  }));
  assert.equal(costs.clock, "process.hrtime.bigint");
  assert.match(
    text(costs.elapsed_boundary),
    /Includes subprocess\/provider waiting; not CPU time/u,
  );
  assert.deepEqual(
    phases.map(({ phase }) => phase),
    [
      "validator_capture",
      "accepted_declarations",
      "input_declarations",
      "artwork_preparation",
      "output_preparation_and_declarations",
      "compatibility_review",
    ],
  );
  assert.ok(phases.every(({ elapsed_ms }) => Number.isFinite(elapsed_ms) && elapsed_ms > 0));
  assert.equal(
    costs.elapsed_ms,
    phases.reduce((sum, p) => sum + p.elapsed_ms, 0),
  );
  assert.ok(number(costs.elapsed_ms) >= 317, "elapsed includes all validator and artwork waiting");
  assert.ok(
    requiredFixture(phases.find((p) => p.phase === "artwork_preparation")).elapsed_ms >= 17,
  );
  assert.deepEqual(costs.unmeasured, [
    "authoring",
    "engineering",
    "interventions",
    "CPU",
    "comparative_baseline",
    "speedup",
  ]);
  assert.equal(costs.artwork_metrics, "artwork-evidence.json#/metrics");
  assert.equal(costs.provider_metrics, "artwork-evidence.json#/provider_metrics");
  assert.match(text(costs.scope), /reuse counts do not establish time saved/u);
  const artwork = fixtureJson(readFileSync(join(f.output, "artwork-evidence.json")));
  assert.deepEqual(artwork.metrics, { reused: 2, original_reused: 0 });
  assert.equal(record(artwork.provider_metrics).game_requests, 0);
  for (const name of ["accepted", "input", "output"]) {
    const bytes = readFileSync(join(f.output, "proposal-checks", `${name}.json`));
    const checked = record(record(report.checks)[name]);
    assert.equal(checked.input_sha256, hash(bytes));
    assert.equal(checked.input_bytes, bytes.length);
    assert.equal(checked.validator_artifact_sha256, hash(readFileSync(f.cli)));
    const process = receipt(f, name);
    assert.equal(process.status, 0);
    assert.ok(number(process.elapsed_ms) >= 100);
    assert.match(text(process.elapsed_boundary), /around validator spawnSync, including waiting/u);
  }
  assert.deepEqual(readFileSync(join(f.output, "catalog-proposal.json")), f.input);
  assertInputsPreserved(f);
});

for (const [mode, failAt, expected] of [
  ["refusal", "accepted", /Core refused accepted catalog declarations/u],
  ["refusal", "input", /Core refused input catalog declarations/u],
  ["timeout", "input", /Core refused input catalog declarations/u],
  ["hash", "input", /does not identify the checked input/u],
  ["bytes", "output", /does not identify the checked input/u],
] as const) {
  void test(`${mode} at ${failAt} retains measured attempt and stops without fabricated later phase costs`, (context) => {
    const f = fixture(context, mode, failAt);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    const process = receipt(f, failAt);
    assert.ok(Number.isFinite(process.elapsed_ms) && number(process.elapsed_ms) >= 100);
    if (mode === "timeout") {
      assert.equal(process.error_code, "ETIMEDOUT");
      assert.equal(process.signal, "SIGTERM");
    } else if (mode === "refusal") {
      assert.equal(process.status, 7);
      assert.match(text(process.stderr_tail), /inert declaration refusal/u);
    } else assert.equal(process.status, 0, "successful process is distinct from refused identity");
    assert.equal(existsSync(join(f.output, "proposal-evidence.json")), false);
    assert.equal(existsSync(join(f.output, "catalog-proposal.json")), false);
    if (failAt !== "output")
      assert.equal(existsSync(join(f.output, "proposal-checks", "output-process.json")), false);
    if (failAt === "accepted")
      assert.equal(existsSync(join(f.output, "proposal-checks", "input-process.json")), false);
    assertInputsPreserved(f);
  });
}

void test("retry refuses existing output without replacing prior measured failure evidence", (context) => {
  const f = fixture(context, "refusal", "input");
  assert.notEqual(f.run().status, 0);
  const path = join(f.output, "proposal-checks", "input-process.json");
  const retained = readFileSync(path);
  const retry = f.run();
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /EEXIST/u);
  assert.deepEqual(readFileSync(path), retained);
  assertInputsPreserved(f);
});

void test("proposal cases retain changed and shared-source declarations without claiming reusable qualification", (context) => {
  const f = fixture(context, "success", "input", (catalog) => {
    requiredFixture(catalog.ports[0]).adapter = "shared-fixture-adapter";
    requiredFixture(catalog.ports[1]).adapter = "shared-fixture-adapter";
    catalog.source_catalog.contracts = [
      {
        id: "frozen-contract",
        port_id: "frozen-port",
        profile_id: "frozen-source",
        evidence_ids: ["shared-evidence"],
      },
      {
        id: "added-contract",
        port_id: "added-port",
        profile_id: "frozen-source",
        evidence_ids: ["shared-evidence"],
      },
    ];
    catalog.source_catalog.evidence = [{ id: "shared-evidence", claim: "old scoped declaration" }];
    catalog.source_catalog.qualification = [
      { scope: { port_id: "frozen-port" }, kind: "fixture", outcome: "unknown" },
    ];
  });
  const proposed = catalogFixture(fixtureJson(readFileSync(f.proposal)));
  requiredFixture(proposed.ports[1]).persistent_paths = ["saves"];
  requiredFixture(proposed.source_catalog.evidence[0]).claim = "corrected scoped declaration";
  requiredFixture(proposed.source_catalog.qualification[0]).outcome = "failed";
  writeFileSync(f.proposal, JSON.stringify(proposed));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = fixtureJson(readFileSync(join(f.output, "proposal-evidence.json")));
  const review = declarationReview(report.declaration_cases);
  assert.deepEqual(
    review.cases.map((item) => item.port_id),
    ["added-port", "frozen-port"],
  );
  const added = requiredFixture(review.cases[0]),
    frozen = requiredFixture(review.cases[1]);
  assert.deepEqual(added.reasons, ["port-declaration", "source-record-relationship"]);
  assert.deepEqual(frozen.reasons, ["source-record-relationship"]);
  assert.deepEqual(frozen.before.port, frozen.after.port);
  assert.deepEqual(frozen.unchanged_port_fields, [
    "adapter",
    "id",
    "name",
    "project_url",
    "summary",
  ]);
  assert.deepEqual(added.unchanged_port_fields, [
    "adapter",
    "id",
    "name",
    "project_url",
    "summary",
  ]);
  assert.equal(
    requiredFixture(
      review.source_tables.after.qualification[
        requiredFixture(frozen.after.source_record_refs.qualification[0])
      ],
    ).outcome,
    "failed",
  );
  assert.equal(
    requiredFixture(review.source_tables.after.evidence[0]).claim,
    "corrected scoped declaration",
  );
  assert.deepEqual(added.adapter_references, ["shared-fixture-adapter"]);
  assert.deepEqual(review.adapter_references, [
    { adapter: "shared-fixture-adapter", accepted_port_ids: ["added-port", "frozen-port"] },
  ]);
  assert.equal(frozen.checks.output, null, "the inert inspector did not report this port");
  assert.match(review.scope, /not validation impact, capability fit or reusable qualification/u);
  assert.deepEqual(review.unmeasured, [
    "new engineering",
    "application/harness changes",
    "interventions",
    "maintenance execution",
    "work eliminated",
    "comparative savings",
  ]);
  assert.equal(
    record(report.preparation_costs).scope,
    "Observed preparation only; reuse counts do not establish time saved or delivery improvement.",
  );
  assert.deepEqual(readFileSync(f.source), f.accepted);
});

for (const [label, edit, expected] of [
  [
    "identity correction",
    (catalog: FixtureCatalog) => {
      requiredFixture(catalog.source_catalog.identities[0]).label = "corrected";
    },
    ["frozen-port"],
  ],
  [
    "validator correction",
    (catalog: FixtureCatalog) => {
      requiredFixture(catalog.source_catalog.validators[0]).protocol_version = "changed";
    },
    ["frozen-port"],
  ],
  [
    "qualification only",
    (catalog: FixtureCatalog) => {
      requiredFixture(catalog.source_catalog.qualification[0]).outcome = "failed";
    },
    ["added-port"],
  ],
  [
    "unreferenced evidence",
    (catalog: FixtureCatalog) => {
      catalog.source_catalog.evidence.push({ id: "unrelated", claim: "not used" });
    },
    [],
  ],
  [
    "removed port",
    (catalog: FixtureCatalog) => {
      catalog.ports.shift();
      catalog.source_catalog.contracts.shift();
    },
    ["frozen-port"],
  ],
  ["unchanged batch", () => {}, []],
] as const) {
  void test(`declaration relationship cases distinguish ${label} from unrelated ports`, (context) => {
    const f = fixture(context, "success", "input", (catalog: FixtureCatalog) => {
      catalog.source_catalog.contracts = [
        {
          id: "frozen-contract",
          port_id: "frozen-port",
          profile_id: "frozen-source",
          validator_contract_id: "validator",
        },
      ];
      catalog.source_catalog.validators = [{ id: "validator", protocol_version: "original" }];
      catalog.source_catalog.qualification = [
        { scope: { port_id: "added-port" }, outcome: "unknown" },
      ];
    });
    const proposed = catalogFixture(fixtureJson(readFileSync(f.proposal)));
    edit(proposed);
    writeFileSync(f.proposal, JSON.stringify(proposed));
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const report = fixtureJson(readFileSync(join(f.output, "proposal-evidence.json")));
    assert.deepEqual(
      declarationReview(report.declaration_cases).cases.map((item) => item.port_id),
      expected,
    );
    if (label === "removed port") {
      const removed = requiredFixture(declarationReview(report.declaration_cases).cases[0]);
      assert.equal(removed.after.port, null);
      assert.deepEqual(removed.unchanged_port_fields, []);
    }
    assert.deepEqual(readFileSync(f.source), f.accepted);
  });
}

void test("many shared references retain exact records with linear report growth", (context) => {
  const sizes: number[] = [];
  for (const count of [16, 128]) {
    const originalClaim = "retained scoped claim ".repeat(3200);
    const f = fixture(context, "success", "input", (catalog: FixtureCatalog) => {
      catalog.ports = Array.from({ length: count }, (_, index) => ({
        id: `port-${index}`,
        adapter: "shared-adapter",
        source_profile: "frozen-source",
      }));
      requiredFixture(catalog.source_catalog.identities[0]).evidence_ids = ["shared-evidence"];
      catalog.source_catalog.evidence = [{ id: "shared-evidence", claim: originalClaim }];
      catalog.source_catalog.qualification = catalog.ports.map((port) => ({
        scope: { port_id: port.id },
        outcome: "unknown",
      }));
    });
    const proposed = catalogFixture(fixtureJson(readFileSync(f.proposal)));
    requiredFixture(proposed.source_catalog.evidence[0]).claim =
      text(requiredFixture(proposed.source_catalog.evidence[0]).claim) + " correction";
    writeFileSync(f.proposal, JSON.stringify(proposed));
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const review = declarationReview(
      fixtureJson(readFileSync(join(f.output, "proposal-evidence.json"))).declaration_cases,
    );
    assert.equal(review.cases.length, count);
    assert.deepEqual(review.adapter_references, [
      { adapter: "shared-adapter", accepted_port_ids: catalogPortIds(count).sort() },
    ]);
    for (const item of review.cases) {
      for (const side of ["before", "after"] as const) {
        const table = review.source_tables[side];
        const identity = table.identities.find(
          (record) => record.id === requiredFixture(item[side].source_record_refs.identities[0]),
        );
        const evidence = table.evidence.find(
          (record) =>
            record.id === requiredFixture(array(requiredFixture(identity).evidence_ids)[0]),
        );
        assert.equal(
          requiredFixture(evidence).claim,
          originalClaim + (side === "after" ? " correction" : ""),
        );
        const [ordinal] = item[side].source_record_refs.qualification;
        assert.equal(
          record(requiredFixture(table.qualification[requiredFixture(ordinal)]).scope).port_id,
          item.port_id,
        );
      }
    }
    const size = Buffer.byteLength(JSON.stringify(review));
    assert.ok(
      size < originalClaim.length * 2 + count * 2500 + 10000,
      `shared records amplified output to ${size} bytes`,
    );
    sizes.push(size);
  }
  assert.ok(requiredFixture(sizes[1]) - requiredFixture(sizes[0]) < (128 - 16) * 2500);
});

function catalogPortIds(count: number) {
  return Array.from({ length: count }, (_, index) => `port-${index}`);
}
