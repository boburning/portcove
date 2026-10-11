import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Fixed declarations and inert validator/provider controls measure the generator,
// independently of live catalog counts. No upstream executable or network runs.
function fixture(mode = "success", failAt = "input") {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-proposal-costs-"));
  const scripts = join(scratch, "scripts");
  const catalogs = join(scratch, "crates", "portcove-core", "catalog");
  mkdirSync(scripts);
  mkdirSync(catalogs, { recursive: true });
  copyFileSync(
    join(root, "scripts", "generate-catalog.mjs"),
    join(scripts, "generate-catalog.mjs"),
  );
  const catalog = {
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
    join(scripts, "inspect-igdb-artwork.mjs"),
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
        "scripts/generate-catalog.mjs",
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

function receipt(f, name) {
  return JSON.parse(readFileSync(join(f.output, "proposal-checks", `${name}-process.json`)));
}

function assertInputsPreserved(f) {
  assert.deepEqual(readFileSync(f.source), f.accepted);
  assert.deepEqual(readFileSync(join(f.catalogs, "catalog.json")), f.accepted);
  assert.deepEqual(readFileSync(f.proposal), f.input);
}

test("proposal costs measure waiting with a monotonic clock and preserve exact three-check receipts", () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(join(f.output, "proposal-evidence.json")));
  assert.equal(report.format_version, 1);
  assert.equal(report.compatibility_fixture_review.status, "matched");
  assert.deepEqual(Object.keys(report.checks), ["accepted", "input", "output"]);
  const costs = report.preparation_costs;
  assert.equal(costs.clock, "process.hrtime.bigint");
  assert.match(costs.elapsed_boundary, /Includes subprocess\/provider waiting; not CPU time/u);
  assert.deepEqual(
    costs.phases.map(({ phase }) => phase),
    [
      "validator_capture",
      "accepted_declarations",
      "input_declarations",
      "artwork_preparation",
      "output_preparation_and_declarations",
      "compatibility_review",
    ],
  );
  assert.ok(costs.phases.every(({ elapsed_ms }) => Number.isFinite(elapsed_ms) && elapsed_ms > 0));
  assert.equal(
    costs.elapsed_ms,
    costs.phases.reduce((sum, p) => sum + p.elapsed_ms, 0),
  );
  assert.ok(costs.elapsed_ms >= 317, "elapsed includes all validator and artwork waiting");
  assert.ok(costs.phases.find((p) => p.phase === "artwork_preparation").elapsed_ms >= 17);
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
  assert.match(costs.scope, /reuse counts do not establish time saved/u);
  const artwork = JSON.parse(readFileSync(join(f.output, "artwork-evidence.json")));
  assert.deepEqual(artwork.metrics, { reused: 2, original_reused: 0 });
  assert.equal(artwork.provider_metrics.game_requests, 0);
  for (const name of ["accepted", "input", "output"]) {
    const bytes = readFileSync(join(f.output, "proposal-checks", `${name}.json`));
    const checked = report.checks[name];
    assert.equal(checked.input_sha256, hash(bytes));
    assert.equal(checked.input_bytes, bytes.length);
    assert.equal(checked.validator_artifact_sha256, hash(readFileSync(f.cli)));
    const process = receipt(f, name);
    assert.equal(process.status, 0);
    assert.ok(process.elapsed_ms >= 100);
    assert.match(process.elapsed_boundary, /around validator spawnSync, including waiting/u);
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
]) {
  test(`${mode} at ${failAt} retains measured attempt and stops without fabricated later phase costs`, () => {
    const f = fixture(mode, failAt);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    const process = receipt(f, failAt);
    assert.ok(Number.isFinite(process.elapsed_ms) && process.elapsed_ms >= 100);
    if (mode === "timeout") {
      assert.equal(process.error_code, "ETIMEDOUT");
      assert.equal(process.signal, "SIGTERM");
    } else if (mode === "refusal") {
      assert.equal(process.status, 7);
      assert.match(process.stderr_tail, /inert declaration refusal/u);
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

test("retry refuses existing output without replacing prior measured failure evidence", () => {
  const f = fixture("refusal", "input");
  assert.notEqual(f.run().status, 0);
  const path = join(f.output, "proposal-checks", "input-process.json");
  const retained = readFileSync(path);
  const retry = f.run();
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /EEXIST/u);
  assert.deepEqual(readFileSync(path), retained);
  assertInputsPreserved(f);
});
