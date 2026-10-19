import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { TestContext } from "node:test";
import type { Socket } from "node:net";
import type { ArtworkCatalog, ArtworkPreparationOptions } from "./inspect-igdb-artwork.mts";
import { isRecord } from "./runtime-values.mts";
import { fileURLToPath, pathToFileURL } from "node:url";

function rejectedReason(result: PromiseRejectedResult): unknown {
  return result.reason;
}
function requiredFixture<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null, "Required fixture value is missing");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected fixture object");
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "Expected fixture array");
  const items: unknown[] = value;
  return items.map(record);
}
function stringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  const items: unknown[] = value;
  return items.map(text);
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  if (typeof value !== "string") throw new Error("Expected fixture text");
  return value;
}
function fixtureJson(bytes: string | Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString());
  return record(value);
}
interface FixtureRecord extends Record<string, unknown> {
  id: string;
}
interface FixturePort extends FixtureRecord {
  release?: Record<string, unknown>;
  presentation?: Record<string, unknown> | null;
  executable_hints?: Record<string, unknown>;
}
interface FixtureCatalog extends ArtworkCatalog {
  ports: FixturePort[];
  source_catalog: Record<
    "identities" | "contracts" | "validators" | "evidence",
    FixtureRecord[]
  > & {
    qualification: Record<string, unknown>[];
  };
}
function differenceRecords(value: unknown) {
  return records(value).map((item) => ({ ...item, path: text(item.path) }));
}
function comparisonReport(value: unknown) {
  const report = record(value);
  const changes = record(report.proposal_changes);
  return {
    ...report,
    differences: differenceRecords(report.differences),
    proposal_changes: {
      ...changes,
      ports: records(changes.ports).map((port) => {
        const groups = record(port.changes);
        return {
          ...port,
          port_id: text(port.port_id),
          action: text(port.action),
          name_before: port.name_before,
          name_after: port.name_after,
          changes: {
            source: differenceRecords(groups.source),
            execution: differenceRecords(groups.execution),
            persistence: differenceRecords(groups.persistence),
            other: differenceRecords(groups.other),
          },
        };
      }),
      source_records: records(changes.source_records),
      order_changes: records(changes.order_changes),
    },
  };
}
function fixtureCatalog(value: unknown): FixtureCatalog {
  function assertCatalog(value: unknown): asserts value is FixtureCatalog {
    const catalog = record(value);
    for (const port of records(catalog.ports)) {
      text(port.id);
      for (const field of ["release", "presentation", "executable_hints"])
        if (port[field] !== undefined && !(field === "presentation" && port[field] === null))
          record(port[field]);
    }
    const source = record(catalog.source_catalog);
    for (const field of ["identities", "contracts", "validators", "evidence"])
      for (const item of records(source[field])) text(item.id);
    records(source.qualification);
  }
  assertCatalog(value);
  return value;
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogRoot = join(root, "crates", "portcove-core", "catalog");

function run(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/generate-catalog.mts", ...args], {
    cwd: root,
    encoding: "utf8",
    // Complete historical comparisons exceed Node's default 1 MiB capture.
    maxBuffer: 4 * 1024 * 1024,
  });
}

function isolatedGenerator() {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-generator-dispatch-"));
  mkdirSync(join(scratch, "scripts"));
  for (const name of [
    "generate-catalog.mts",
    "inspect-igdb-artwork.mts",
    "runtime-values.mts",
    "catalog-authoring.mts",
    "maintainer-config.mts",
  ])
    copyFileSync(join(root, "scripts", name), join(scratch, "scripts", name));
  const catalogs = join(scratch, "crates", "portcove-core", "catalog");
  mkdirSync(catalogs, { recursive: true });
  for (const name of [
    "catalog-current-authoring.json",
    "catalog-schema2-migration-fixture.json",
    "catalog-schema1-fixture.json",
    "catalog-legacy-additions-fixture.json",
  ])
    copyFileSync(join(catalogRoot, name), join(catalogs, name));
  return {
    scratch,
    catalogs,
    run: (...args: string[]) =>
      spawnSync(process.execPath, ["scripts/generate-catalog.mts", ...args], {
        cwd: scratch,
        encoding: "utf8",
      }),
  };
}

void test("ordinary generation refuses an unreviewed identity before replacing embedded bytes", () => {
  const fixture = isolatedGenerator();
  const output = join(fixture.catalogs, "catalog.json");
  const original = readFileSync(join(catalogRoot, "catalog.json"));
  writeFileSync(output, original);
  const input = fixtureCatalog(
    fixtureJson(readFileSync(join(fixture.catalogs, "catalog-current-authoring.json"))),
  );
  input.ports.push({ ...requiredFixture(input.ports[0]), id: "unreviewed-fixture-port" });
  writeFileSync(join(fixture.catalogs, "catalog-current-authoring.json"), JSON.stringify(input));
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /compatibility fixture.*unreviewed-fixture-port/u);
  assert.deepEqual(readFileSync(output), original);
});

function proposalDecoderFixture(
  images = 0,
  failInitialization = false,
  mode = "--prepare-proposal",
  editInput?: (input: FixtureCatalog, catalogs: string) => void,
) {
  const fixture = isolatedGenerator();
  if (editInput) {
    const path = join(fixture.catalogs, "catalog-current-authoring.json");
    const input = fixtureCatalog(fixtureJson(readFileSync(path)));
    editInput(input, fixture.catalogs);
    writeFileSync(path, JSON.stringify(input));
  }
  const helper = join(fixture.scratch, "scripts", "inspect-igdb-artwork.mts");
  copyFileSync(helper, join(fixture.scratch, "scripts", "real-artwork.mts"));
  writeFileSync(
    helper,
    `
    export { readArtworkJson, readArtworkInput } from './real-artwork.mts';
    import { createCoreImageValidator as actualValidator } from './real-artwork.mts';
    import { appendFileSync, readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    export function createCoreImageValidator(cli, root) {
      appendFileSync(process.env.FIXTURE_FACTORY_LOG, JSON.stringify({cli,
        sha256:createHash('sha256').update(readFileSync(cli)).digest('hex')})+'\\n');
      if(process.env.FIXTURE_FAIL_INITIALIZATION==='yes') throw new Error('inert initialization failure');
      return actualValidator(cli, root);
    }
    export function createIgdbInspector(_credentials, validateImage) {
      return {validateImage,providerMetrics:{authentication_requests:0,game_requests:0,image_requests:0}};
    }
    export async function prepareCatalogArtwork(input, {validateImage}) {
      const records=[];
      for(let i=0;i<Number(process.env.FIXTURE_IMAGES);i++) {
        try { records.push(validateImage(Buffer.from('inert image '+i))); }
        catch { records.push({failure:true}); }
      }
      return {catalog:input,records,metrics:{}};
    }
  `,
  );
  const cli = join(fixture.scratch, "selected-cli");
  const original = Buffer.from("inert first-party validator fixture");
  writeFileSync(cli, original);
  const preload = join(fixture.scratch, "process fixture #% ü.mjs");
  writeFileSync(
    preload,
    `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    let calls=0;
    cp.spawnSync=(artifact,args)=>{
      const bytes=readFileSync(args.at(-1));
      const sha256=createHash('sha256').update(bytes).digest('hex');
      const inspection=args.includes('inspect-proposal');
      appendFileSync(process.env.FIXTURE_PROCESS_LOG,JSON.stringify({artifact,inspection})+'\\n');
      if(++calls===1 && inspection)writeFileSync(process.env.FIXTURE_SELECTED_CLI,'selected file changed after capture');
      const data=inspection?{format_version:1,input_sha256:sha256,input_bytes:bytes.length,ports:[]}
        :{selection:{sha256,byte_size:bytes.length,width:1,height:1,format:'jpeg'}};
      return {status:0,signal:null,stdout:JSON.stringify({data}),stderr:''};
    };
    syncBuiltinESMExports();
  `,
  );
  const output = join(fixture.scratch, "output");
  const factoryLog = join(fixture.scratch, "factory.log");
  const processLog = join(fixture.scratch, "process.log");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      "scripts/generate-catalog.mts",
      mode,
      join(fixture.catalogs, "catalog-current-authoring.json"),
      "--validator-cli",
      cli,
      "--output-dir",
      output,
    ],
    {
      cwd: fixture.scratch,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        FIXTURE_SELECTED_CLI: cli,
        FIXTURE_IMAGES: String(images),
        FIXTURE_FAIL_INITIALIZATION: failInitialization ? "yes" : "no",
        FIXTURE_FACTORY_LOG: factoryLog,
        FIXTURE_PROCESS_LOG: processLog,
      },
    },
  );
  return {
    result,
    output,
    catalogs: fixture.catalogs,
    original,
    cli,
    factories: existsSync(factoryLog)
      ? readFileSync(factoryLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => fixtureJson(line))
      : [],
    processes: existsSync(processLog)
      ? readFileSync(processLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => fixtureJson(line))
      : [],
  };
}

void test("unreviewed proposal identities report required fixture review without editing expectations", () => {
  // Test generic bookkeeping with independently fixed identities, not the live
  // catalog count. Live accepted-catalog and frozen equality checks are separate.
  const expectedBytes = Buffer.from(
    JSON.stringify({ port_ids: ["added-port"], source_profile_ids: ["added-source"] }),
  );
  const fixture = proposalDecoderFixture(0, false, "--prepare-proposal", (input, catalogs) => {
    input.ports = [
      { id: "frozen-port", name: "Frozen fixture" },
      { id: "added-port", name: "Reviewed fixture" },
      { id: "unreviewed-proposal-port", name: "Unreviewed fixture" },
    ];
    input.source_catalog = {
      identities: [{ id: "frozen-source" }],
      contracts: [],
      validators: [],
      evidence: [],
      qualification: [],
    };
    writeFileSync(
      join(catalogs, "catalog-schema1-fixture.json"),
      JSON.stringify({
        ports: [{ id: "frozen-port" }],
        source_profiles: [{ id: "frozen-source" }],
      }),
    );
    writeFileSync(join(catalogs, "catalog-legacy-additions-fixture.json"), expectedBytes);
  });
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.equal(fixture.processes.filter(({ inspection }) => inspection).length, 3);
  const report = fixtureJson(readFileSync(join(fixture.output, "proposal-evidence.json")));
  assert.deepEqual(
    record(report.declaration_cases).cases,
    [],
    "unreviewed identity bookkeeping is not a declaration change against the same accepted fixture",
  );
  assert.match(
    text(record(report.declaration_cases).scope),
    /not validation impact, capability fit or reusable qualification/u,
  );
  const review = record(report.compatibility_fixture_review);
  assert.equal(review.status, "requires-review");
  assert.deepEqual(record(record(review.collections).port_ids).unreviewed_ids, [
    "unreviewed-proposal-port",
  ]);
  assert.deepEqual(record(record(review.collections).source_profile_ids).missing_expected_ids, [
    "added-source",
  ]);
  assert.equal(record(record(review.collections).port_ids).expected_count, 2);
  assert.deepEqual(
    readFileSync(join(fixture.catalogs, "catalog-legacy-additions-fixture.json")),
    expectedBytes,
  );
  assert.equal(review.fixture_sha256, createHash("sha256").update(expectedBytes).digest("hex"));
});

type EditExpected = { port_ids: string[]; source_profile_ids: string[]; approve?: boolean };
for (const [name, editInput, editExpected] of [
  [
    "missing additive port",
    (input: FixtureCatalog) => {
      input.ports = input.ports.filter(({ id }) => id !== "dkc3-recomp");
    },
  ],
  [
    "missing frozen profile",
    (input: FixtureCatalog) => {
      input.source_catalog.identities.shift();
    },
  ],
  [
    "duplicate actual port",
    (input: FixtureCatalog) => {
      input.ports.push(requiredFixture(input.ports[0]));
    },
  ],
  [
    "duplicate actual profile",
    (input: FixtureCatalog) => {
      input.source_catalog.identities.push(requiredFixture(input.source_catalog.identities[0]));
    },
  ],
  [
    "duplicate expected",
    null,
    (expected: EditExpected) => {
      expected.port_ids.push(requiredFixture(expected.port_ids[0]));
    },
  ],
  [
    "legacy overlap",
    null,
    (expected: EditExpected) => {
      expected.port_ids.push("shipwright");
    },
  ],
  [
    "unknown fixture key",
    null,
    (expected: EditExpected) => {
      expected.approve = true;
    },
  ],
  [
    "empty expected",
    null,
    (expected: EditExpected) => {
      expected.source_profile_ids = [];
    },
  ],
  [
    "invalid expected ID",
    null,
    (expected: EditExpected) => {
      expected.port_ids[0] = "../escape";
    },
  ],
] as const) {
  void test(`compatibility bookkeeping refuses ${name} without replacing output`, () => {
    const fixture = isolatedGenerator();
    const output = join(fixture.catalogs, "catalog.json");
    const before = readFileSync(join(catalogRoot, "catalog.json"));
    writeFileSync(output, before);
    const inputPath = join(fixture.catalogs, "catalog-current-authoring.json");
    const expectedPath = join(fixture.catalogs, "catalog-legacy-additions-fixture.json");
    if (editInput) {
      const input = fixtureCatalog(fixtureJson(readFileSync(inputPath)));
      editInput(input);
      writeFileSync(inputPath, JSON.stringify(input));
    }
    if (editExpected) {
      const expectedRaw = fixtureJson(readFileSync(expectedPath));
      const expected: EditExpected = {
        port_ids: stringArray(expectedRaw.port_ids),
        source_profile_ids: stringArray(expectedRaw.source_profile_ids),
      };
      editExpected(expected);
      writeFileSync(expectedPath, JSON.stringify(expected));
    }
    for (const args of [[], ["--check"]]) {
      const result = fixture.run(...args);
      assert.notEqual(result.status, 0, name);
      assert.deepEqual(readFileSync(output), before);
    }
  });
}

for (const missing of [true, false]) {
  void test(`compatibility bookkeeping refuses ${missing ? "missing" : "malformed"} expectations`, () => {
    const fixture = isolatedGenerator();
    const expected = join(fixture.catalogs, "catalog-legacy-additions-fixture.json");
    if (missing) renameSync(expected, `${expected}.retained`);
    else writeFileSync(expected, "{");
    const output = join(fixture.catalogs, "catalog.json");
    const before = readFileSync(join(catalogRoot, "catalog.json"));
    writeFileSync(output, before);
    for (const args of [[], ["--check"]]) {
      assert.notEqual(fixture.run(...args).status, 0);
      assert.deepEqual(readFileSync(output), before);
    }
  });
}

void test("reuse-only full proposal retains declaration checks without initializing an unused decoder", () => {
  const fixture = proposalDecoderFixture();
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.equal(fixture.factories.length, 0);
  assert.equal(existsSync(join(fixture.output, "scratch")), false);
  assert.equal(fixture.processes.length, 3);
  assert.ok(fixture.processes.every(({ inspection }) => inspection));
  const evidence = fixtureJson(readFileSync(join(fixture.output, "proposal-evidence.json")));
  const expected = createHash("sha256").update(fixture.original).digest("hex");
  for (const receipt of Object.values(record(evidence.checks)))
    assert.equal(record(receipt).validator_artifact_sha256, expected);
});

void test("needed decoder snapshots the captured validator once and retains each image receipt", () => {
  const fixture = proposalDecoderFixture(2);
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.equal(fixture.factories.length, 1);
  assert.equal(
    requiredFixture(fixture.factories[0]).sha256,
    createHash("sha256").update(fixture.original).digest("hex"),
  );
  assert.notEqual(requiredFixture(fixture.factories[0]).cli, fixture.cli);
  assert.equal(fixture.processes.filter(({ inspection }) => inspection).length, 3);
  assert.equal(fixture.processes.filter(({ inspection }) => !inspection).length, 2);
  const scratch = join(fixture.output, "scratch");
  const roots = readdirSync(scratch);
  assert.equal(roots.length, 1);
  for (const ordinal of ["1", "2"]) {
    const receipt = fixtureJson(
      readFileSync(join(scratch, requiredFixture(roots[0]), ordinal, "validation-process.json")),
    );
    assert.equal(receipt.status, 0);
    assert.equal(
      record(receipt).validator_artifact_sha256,
      requiredFixture(fixture.factories[0]).sha256,
    );
  }
});

void test("decoder initialization failure is retained by existing artwork handling without repeated initialization", () => {
  const fixture = proposalDecoderFixture(2, true);
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.equal(fixture.factories.length, 1);
  assert.equal(fixture.processes.length, 3);
  const artwork = fixtureJson(readFileSync(join(fixture.output, "artwork-evidence.json")));
  assert.deepEqual(artwork.records, [{ failure: true }, { failure: true }]);
});

void test("artwork-only mode retains its eager selected-tool snapshot boundary", () => {
  const fixture = proposalDecoderFixture(0, false, "--prepare-artwork");
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.equal(fixture.factories.length, 1);
  assert.equal(requiredFixture(fixture.factories[0]).cli, fixture.cli);
  assert.ok(existsSync(join(fixture.output, "scratch")));
  assert.equal(fixture.processes.length, 0);
});

function compareProposal(before: FixtureCatalog, after: FixtureCatalog) {
  const fixture = isolatedGenerator();
  writeFileSync(
    join(fixture.catalogs, "catalog-schema2-migration-fixture.json"),
    JSON.stringify(before),
  );
  writeFileSync(join(fixture.catalogs, "catalog-current-authoring.json"), JSON.stringify(after));
  const result = fixture.run("--compare-historical");
  assert.equal(result.status, 0, result.stderr);
  return comparisonReport(fixtureJson(result.stdout));
}

function proposalFixture(): FixtureCatalog {
  return {
    schema_version: 2,
    ports: ["first", "second"].map((id) => ({
      id,
      name: `Port ${id}`,
      source_profile: "shared-source",
      release: { repository: "fixture/shared" },
      executable_hints: { "linux-x86-64": ["game"] },
      persistent_paths: ["saves"],
    })),
    source_catalog: {
      identities: [{ id: "shared-source", label: "Shared source", variants: [] }],
      contracts: [],
      evidence: [],
      validators: [],
      qualification: [],
    },
  };
}

void test("proposal identity report separates insertion from unchanged shared-repository siblings", () => {
  const before = proposalFixture();
  const after = structuredClone(before);
  after.ports.unshift({ ...requiredFixture(after.ports[0]), id: "new", name: "New port" });
  const report = compareProposal(before, after);
  assert.ok(report.differences.some((change) => change.path === "$.ports[0].id"));
  assert.deepEqual(
    report.proposal_changes.ports.map(({ port_id, action, name_after }) => ({
      port_id,
      action,
      name_after,
    })),
    [{ port_id: "new", action: "added", name_after: "New port" }],
  );
  assert.deepEqual(report.proposal_changes.order_changes, [
    {
      collection: "ports",
      before: ["first", "second"],
      after: ["new", "first", "second"],
    },
  ]);
  assert.deepEqual(report.proposal_changes.source_records, []);
  assert.deepEqual(compareProposal(before, after), report);
});

void test("proposal identity report retains exact source execution persistence and unclassified changes", () => {
  const before = proposalFixture();
  const after = structuredClone(before);
  const port = requiredFixture(after.ports[1]);
  port.source_profile = "replacement-source";
  requiredFixture(port.executable_hints)["linux-x86-64"] = ["replacement"];
  port.persistent_paths = ["replacement-saves"];
  requiredFixture(port.release).user_prepared = {
    "linux-x86-64": { mutable_paths: ["player-data"] },
  };
  port.summary = "Changed description";
  requiredFixture(after.source_catalog.identities[0]).label = "Changed shared source";
  const report = compareProposal(before, after);
  const change = requiredFixture(report.proposal_changes.ports[0]);
  assert.equal(change.port_id, "second");
  assert.equal(change.name_before, "Port second");
  assert.equal(change.name_after, "Port second");
  assert.deepEqual(change.changes.source, [
    { path: "$.source_profile", before: "shared-source", after: "replacement-source" },
  ]);
  assert.deepEqual(requiredFixture(change.changes.execution[0]), {
    path: "$.executable_hints.linux-x86-64[0]",
    before: "game",
    after: "replacement",
  });
  assert.ok(change.changes.persistence.some((item) => item.path === "$.persistent_paths[0]"));
  assert.ok(
    change.changes.persistence.some(
      (item) => item.path === "$.release.user_prepared.linux-x86-64.mutable_paths",
    ),
  );
  assert.ok(change.changes.other.some((item) => item.path === "$.summary"));
  assert.deepEqual(report.proposal_changes.source_records, [
    {
      collection: "source_catalog.identities",
      id: "shared-source",
      action: "modified",
      label_before: "Shared source",
      label_after: "Changed shared source",
      differences: [{ path: "$.label", before: "Shared source", after: "Changed shared source" }],
    },
  ]);
});

void test("proposal identity report preserves removals ordering and hostile identities without merging them", () => {
  const before = proposalFixture();
  for (const id of ["__proto__", "constructor"])
    before.ports.push({ ...requiredFixture(before.ports[0]), id, name: id });
  const after = structuredClone(before);
  after.ports.shift();
  after.ports.reverse();
  requiredFixture(after.ports.find((port) => port.id === "__proto__")).launch_arguments = [
    "--reviewed",
  ];
  after.source_catalog.identities = [];
  const report = compareProposal(before, after);
  assert.deepEqual(
    report.proposal_changes.ports.map(({ port_id, action }) => ({ port_id, action })),
    [
      { port_id: "first", action: "removed" },
      { port_id: "__proto__", action: "modified" },
    ],
  );
  assert.equal(requiredFixture(report.proposal_changes.ports[0]).name_after, null);
  assert.deepEqual(requiredFixture(report.proposal_changes.ports[1]).changes.execution, [
    { path: "$.launch_arguments", after: ["--reviewed"] },
  ]);
  assert.equal(requiredFixture(report.proposal_changes.source_records[0]).action, "removed");
  assert.deepEqual(
    report.proposal_changes.order_changes.map((item) => item.collection),
    ["ports", "source_catalog.identities"],
  );
  const ordered = structuredClone(before);
  ordered.ports.reverse();
  const reorder = compareProposal(before, ordered).proposal_changes;
  assert.deepEqual(reorder.ports, []);
  assert.equal(reorder.order_changes.length, 1);
});

void test("proposal identity report refuses duplicate historical identities instead of losing a record", () => {
  const before = proposalFixture();
  const after = structuredClone(before);
  before.source_catalog.validators = [{ id: "validator" }, { id: "validator" }];
  const fixture = isolatedGenerator();
  writeFileSync(
    join(fixture.catalogs, "catalog-schema2-migration-fixture.json"),
    JSON.stringify(before),
  );
  writeFileSync(join(fixture.catalogs, "catalog-current-authoring.json"), JSON.stringify(after));
  const result = fixture.run("--compare-historical");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /source_catalog.validators has a missing or duplicate record identity/,
  );
  assert.equal(result.stdout, "");
});

void test("proposal identity report keeps added empty own fields and exact null values", () => {
  const before = proposalFixture();
  const after = structuredClone(before);
  Object.defineProperty(requiredFixture(after.ports[0]), "__proto__", {
    value: {},
    enumerable: true,
  });
  requiredFixture(after.ports[0]).source_profile = null;
  const change = requiredFixture(compareProposal(before, after).proposal_changes.ports[0]);
  assert.deepEqual(change.changes.other, [{ path: "$.__proto__", after: {} }]);
  assert.deepEqual(change.changes.source, [
    { path: "$.source_profile", before: "shared-source", after: null },
  ]);
});

void test("proposal identity report leaves similarly named unknown presentation fields unclassified", () => {
  const before = proposalFixture();
  const after = structuredClone(before);
  requiredFixture(after.ports[0]).presentation = {
    source_requirements: [],
    saves_and_settings: "external_user_owned",
    source_requirements_extra: "unclassified source wording",
    saves_and_settings_extra: "unclassified persistence wording",
  };
  const change = requiredFixture(compareProposal(before, after).proposal_changes.ports[0]);
  assert.deepEqual(
    change.changes.source.map((item) => item.path),
    ["$.presentation.source_requirements"],
  );
  assert.deepEqual(
    change.changes.persistence.map((item) => item.path),
    ["$.presentation.saves_and_settings"],
  );
  assert.deepEqual(
    change.changes.other.map((item) => item.path),
    ["$.presentation.saves_and_settings_extra", "$.presentation.source_requirements_extra"],
  );
});

void test("semantic diff retains own fields colliding with Object.prototype", () => {
  const fixture = isolatedGenerator();
  const currentPath = join(fixture.catalogs, "catalog-current-authoring.json");
  const before = readFileSync(currentPath, "utf8");
  writeFileSync(join(fixture.catalogs, "catalog-schema2-migration-fixture.json"), before);
  const current = fixtureJson(before);
  for (const [key, value] of Object.entries(
    fixtureJson('{"__proto__":{},"constructor":{},"toString":{}}'),
  ))
    Object.defineProperty(current, key, { value, enumerable: true });
  writeFileSync(currentPath, JSON.stringify(current));
  const result = fixture.run("--compare-historical");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixtureJson(result.stdout).differences, [
    { path: "$.__proto__", after: {} },
    { path: "$.constructor", after: {} },
    { path: "$.toString", after: {} },
  ]);
});

void test("malformed generator mode arguments refuse before embedded catalog writes", () => {
  const fixture = isolatedGenerator();
  const embedded = join(fixture.catalogs, "catalog.json");
  const retained = "retained embedded catalog sentinel";
  writeFileSync(embedded, retained);
  for (const args of [
    ["--prepare-proposal=input.json", "--validator-cli", "cli", "--output-dir", "out"],
    ["--prepare-artwork=input.json"],
    ["--unexpected"],
    ["--check", "--unexpected"],
    ["--compare-historical", "--check"],
  ]) {
    const result = fixture.run(...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(readFileSync(embedded, "utf8"), retained);
  }
  const ordinary = fixture.run();
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(
    readFileSync(embedded, "utf8"),
    `${JSON.stringify(fixtureJson(readFileSync(join(fixture.catalogs, "catalog-current-authoring.json"))), null, 2)}\n`,
  );
});

void test("full proposal preparation cannot combine with ordinary catalog writes or checks", () => {
  const result = run("--prepare-proposal", "unused.json", "--check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot.*check|cannot.*combine/i);
  for (const flag of ["--apply", "--sign", "--publisher-grant", "--prepare-proposal"]) {
    const refused = run("--prepare-proposal", "unused.json", flag, "untrusted");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Unknown or repeated proposal option/);
  }
});

void test("captured proposal bytes remain exact after the caller path changes", async () => {
  const { readArtworkInput } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-proposal-bytes-"));
  const path = join(scratch, "input.json");
  const original = Buffer.from('{ "name": "é", "duplicate": 1, "duplicate": 2 }\n');
  writeFileSync(path, original);
  const captured = readArtworkInput(path);
  writeFileSync(path, '{"replacement":true}');
  assert.deepEqual(captured.bytes, original);
  assert.equal(record(captured.document).name, "é");
  assert.equal(record(captured.document).duplicate, 2);
  // Core receives the captured duplicate-key bytes, not JSON.stringify's loss.
  assert.match(captured.bytes.toString(), /"duplicate": 1, "duplicate": 2/);
});

void test("full preparation requires an explicit validator and preserves prior output and authoring", () => {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-proposal-refusal-"));
  const input = join(catalogRoot, "catalog-current-authoring.json");
  const before = readFileSync(input);
  const output = join(scratch, "output");
  const missing = run("--prepare-proposal", input, "--output-dir", output);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--validator-cli requires a value/);
  assert.equal(existsSync(output), false);
  mkdirSync(output);
  writeFileSync(join(output, "retained.txt"), "retained interruption evidence");
  const refused = run(
    "--prepare-proposal",
    input,
    "--validator-cli",
    join(scratch, "absent"),
    "--output-dir",
    output,
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /EEXIST/);
  assert.equal(
    readFileSync(join(output, "retained.txt"), "utf8"),
    "retained interruption evidence",
  );
  assert.deepEqual(readFileSync(input), before);
});

void test("current schema-2 authoring deterministically owns the embedded catalog", () => {
  const result = run("--check");
  assert.equal(result.status, 0, result.stderr);

  const current = fixtureCatalog(
    fixtureJson(readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8")),
  );
  const embedded = fixtureJson(readFileSync(join(catalogRoot, "catalog.json"), "utf8"));
  assert.deepEqual(embedded, current);
  assert.equal(current.schema_version, 2);
  assert.equal("source_profiles" in current, false);

  const portIds = new Set(current.ports.map((port) => port.id));
  const identityIds = new Set(current.source_catalog.identities.map((identity) => identity.id));
  const evidenceIds = new Set(current.source_catalog.evidence.map((evidence) => evidence.id));
  assert.equal(portIds.size, current.ports.length);
  assert.equal(identityIds.size, current.source_catalog.identities.length);
  assert.equal(evidenceIds.size, current.source_catalog.evidence.length);
  for (const contract of current.source_catalog.contracts) {
    assert.equal(portIds.has(text(contract.port_id)), true, contract.id);
    assert.equal(identityIds.has(text(contract.profile_id)), true, contract.id);
    for (const evidenceId of stringArray(contract.evidence_ids)) {
      assert.equal(evidenceIds.has(evidenceId), true, `${contract.id}: ${evidenceId}`);
    }
  }
});

void test("semantic comparison reports every historical-to-current difference", () => {
  const result = run("--compare-historical");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const comparison = fixtureJson(result.stdout);
  assert.equal(typeof comparison.equal, "boolean");
  assert.match(text(comparison.historical_sha256), /^[0-9a-f]{64}$/u);
  assert.match(text(comparison.current_sha256), /^[0-9a-f]{64}$/u);
  assert.ok(Array.isArray(comparison.differences));
  assert.equal(comparison.equal, comparison.differences.length === 0);
  for (const difference of records(comparison.differences))
    assert.match(text(difference.path), /^\$/u);
});

void test("artwork batches reject numeric port identities rather than coercing them into stable IDs", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  await assert.rejects(
    prepareCatalogArtwork(
      // @ts-expect-error Numeric IDs deliberately represent malformed authoring input.
      { ports: [{ id: 7, name: "Numeric identity" }] },
      { acceptedCatalog: { ports: [] } },
    ),
    /unique stable port ids/,
  );
});

void test("artwork proposal batches reuse accepted choices and separately prove identity and bytes", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const accepted: ArtworkCatalog = {
    ports: [
      {
        id: "accepted",
        name: "Accepted",
        project_url: "https://example.org/accepted",
        presentation: {
          artwork: {
            game_id: 1,
            cover_id: 2,
            image_id: "co1",
            image_sha256: "a".repeat(64),
            game_slug: "accepted",
            match_kind: "port",
          },
        },
      },
    ],
  };
  const catalog = structuredClone(accepted);
  catalog.ports.push({
    id: "new-port",
    name: "New Port",
    project_url: "https://example.org/new",
    release: { version: "2" },
  });
  const before = structuredClone(catalog);
  const queries: (number | null)[] = [];
  const result = await prepareCatalogArtwork(catalog, {
    acceptedCatalog: accepted,
    identities: {
      "new-port": {
        port: {
          game_id: 3,
          slug: "new-port",
          names: ["New Port"],
          evidence_url: "https://example.org/new",
        },
      },
    },
    inspectGame: async (identity) => {
      queries.push(identity.game_id);
      return [{ id: 3, slug: "new-port", name: "New Port", cover: { id: 4, image_id: "co2" } }];
    },
    inspectImage: async () => ({
      sha256: "b".repeat(64),
      bytes: 1024,
      width: 264,
      height: 374,
      format: "jpeg",
      validator: "portcove-core",
    }),
  });
  assert.deepEqual(catalog, before);
  assert.deepEqual(queries, [3]);
  assert.equal(requiredFixture(result.records[0]).reason, "accepted-mapping-reused");
  assert.equal(requiredFixture(result.records[1]).reason, "exact-port-cover");
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[1]).presentation).artwork)
      .game_id,
    3,
  );
  assert.deepEqual(
    requiredFixture(result.catalog.ports[1]).release,
    requiredFixture(before.ports[1]).release,
  );
  assert.equal(result.metrics.reused, 1);
  assert.equal(result.metrics.selected, 1);
});

void test("coverless port falls through to exact original; ambiguous and failed images remain nonblocking", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const target = (game_id: number, slug: string) => ({
    game_id,
    slug,
    names: [slug],
    evidence_url: "https://example.org/facts",
  });
  const catalog = {
    ports: ["original", "ambiguous", "failed"].map((id) => ({
      id,
      name: id,
      project_url: `https://example.org/${id}`,
    })),
  };
  const result = await prepareCatalogArtwork(catalog, {
    acceptedCatalog: { ports: [] },
    identities: {
      original: { port: target(1, "port"), underlying_game: target(2, "original") },
      ambiguous: { port: target(3, "ambiguous") },
      failed: { port: target(4, "failed") },
    },
    inspectGame: async ({ game_id, slug }) => {
      const game = {
        id: game_id,
        name: slug,
        slug,
        cover: game_id === 1 ? null : { id: game_id, image_id: `co${game_id}` },
      };
      return game_id === 3 ? [game, game] : [game];
    },
    inspectImage: async (image_id) => {
      if (image_id === "co4") throw new Error("provider unavailable");
      return {
        sha256: "c".repeat(64),
        bytes: 100,
        width: 264,
        height: 374,
        format: "jpeg",
        validator: "portcove-core",
      };
    },
  });
  assert.equal(requiredFixture(result.records[0]).reason, "exact-original-game-cover");
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork)
      .match_kind,
    "underlying-game",
  );
  assert.equal(requiredFixture(result.records[1]).reason, "generated-fallback");
  assert.equal(
    requiredFixture(requiredFixture(result.records[1]).exceptions[0]).reason,
    "identity-not-unique",
  );
  assert.equal(
    requiredFixture(requiredFixture(result.records[2]).exceptions[0]).reason,
    "image-unavailable-or-invalid",
  );
  assert.equal(result.metrics.fallback, 2);
});

void test("the entire accepted cover inventory survives a routine executable release without lookup", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const accepted = fixtureCatalog(
    fixtureJson(readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8")),
  );
  const input = structuredClone(accepted);
  requiredFixture(requiredFixture(input.ports[0]).release).version = "ordinary-successor";
  const result = await prepareCatalogArtwork(input, {
    acceptedCatalog: accepted,
    inspectGame: () => assert.fail("unchanged accepted artwork must not search"),
    inspectImage: () => assert.fail("unchanged accepted artwork must not download"),
  });
  const mapped = accepted.ports.filter((port) => port.presentation?.artwork);
  const unmapped = accepted.ports.filter((port) => !port.presentation?.artwork);
  assert.equal(result.metrics.reused, mapped.length);
  assert.equal(result.metrics.fallback, unmapped.length);
  assert.deepEqual(
    result.records.filter((record) => record.mapping).map((record) => record.port_id),
    mapped.map((port) => port.id),
  );
  assert.deepEqual(
    result.records
      .filter((record) => record.reason === "generated-fallback")
      .map((record) => record.port_id),
    unmapped.map((port) => port.id),
  );
  assert.deepEqual(result.catalog, input);
});

void test("another port can reuse a uniquely accepted original-game asset without merging port identities", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const mapping = {
    game_id: 2,
    cover_id: 3,
    image_id: "co2",
    image_sha256: "a".repeat(64),
    game_slug: "original",
    match_kind: "underlying-game",
  };
  const accepted: ArtworkCatalog = {
    ports: [
      {
        id: "first-port",
        name: "First",
        project_url: "https://example.org/first",
        presentation: { artwork: mapping },
      },
    ],
  };
  const input = {
    ports: [
      {
        id: "second-port",
        name: "Second",
        project_url: "https://example.org/second",
        source_profile: "distinct-contract",
      },
    ],
  };
  const result = await prepareCatalogArtwork(input, {
    acceptedCatalog: accepted,
    identities: {
      "second-port": {
        underlying_game: {
          game_id: 2,
          slug: "original",
          names: ["Original"],
          evidence_url: "https://example.org/original-facts",
        },
      },
    },
    inspectGame: async (identity) => {
      assert.equal(identity.project_url, "https://example.org/second");
      return [];
    },
    inspectImage: () => assert.fail("accepted original bytes need no repeated download"),
  });
  assert.equal(requiredFixture(result.records[0]).reason, "accepted-original-game-reused");
  assert.equal(result.metrics.original_reused, 1);
  assert.equal(result.metrics.game_queries, 1);
  assert.equal(requiredFixture(result.catalog.ports[0]).id, "second-port");
  assert.equal(requiredFixture(result.catalog.ports[0]).source_profile, "distinct-contract");
  assert.deepEqual(
    requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork,
    mapping,
  );
});

void test("ordinary names require exact attributable project evidence, including shared repositories", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const catalog = {
    ports: [
      { id: "one", name: "One", project_url: "https://github.com/Owner/Shared" },
      { id: "two", name: "Two", project_url: "https://github.com/Owner/Shared" },
      { id: "collision", name: "Collision", project_url: "https://github.com/Owner/Other" },
      { id: "custom-port", name: "Custom", project_url: "https://github.com/Owner/Shared" },
    ],
  };
  const queries: Parameters<NonNullable<ArtworkPreparationOptions["inspectGame"]>>[0][] = [];
  const result = await prepareCatalogArtwork(catalog, {
    acceptedCatalog: { ports: [] },
    inspectGame: async (identity) => {
      queries.push(identity);
      return [
        {
          id: identity.names[0] === "One" ? 1 : 2,
          name: requiredFixture(identity.names[0]),
          slug: requiredFixture(identity.names[0]).toLowerCase(),
          websites: [
            {
              url:
                identity.names[0] === "Custom"
                  ? "https://github.com:444/owner/shared/"
                  : "https://github.com/owner/shared/",
            },
          ],
          cover: { id: 3, image_id: "co3" },
        },
      ];
    },
    inspectImage: async () => ({
      sha256: "a".repeat(64),
      bytes: 100,
      width: 264,
      height: 374,
      format: "jpeg",
      validator: "portcove-core",
    }),
  });
  assert.equal(queries.length, 4);
  assert.ok(queries.every((identity) => identity.game_id === null));
  assert.deepEqual(
    result.records.map((record) => record.reason),
    ["exact-port-cover", "exact-port-cover", "generated-fallback", "generated-fallback"],
  );
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork)
      .game_id,
    1,
  );
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[1]).presentation).artwork)
      .game_id,
    2,
  );
  assert.equal(result.metrics.image_queries, 1);
  assert.equal(
    requiredFixture(requiredFixture(result.records[2]).exceptions[0]).reason,
    "identity-mismatch",
  );
  assert.equal(
    requiredFixture(requiredFixture(result.records[3]).exceptions[0]).reason,
    "identity-mismatch",
  );
});

void test("original-game name lookup requires platform and edition evidence and refuses truncated results", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const input = {
    ports: [{ id: "original", name: "Port", project_url: "https://example.org/port" }],
  };
  const identities = {
    original: {
      underlying_game: {
        names: ["Original"],
        platform_ids: [4],
        evidence_url: "https://example.org/source-facts",
      },
    },
  };
  const setup = (games: unknown): ArtworkPreparationOptions => ({
    acceptedCatalog: { ports: [] },
    identities,
    inspectGame: async (identity) => (identity.kind === "port" ? [] : games),
    inspectImage: async () => ({
      sha256: "b".repeat(64),
      bytes: 100,
      width: 264,
      height: 374,
      format: "jpeg",
      validator: "portcove-core",
    }),
  });
  const base = {
    id: 1,
    slug: "original",
    name: "Original",
    platforms: [4],
    cover: { id: 3, image_id: "co3" },
  };
  const observed = await prepareCatalogArtwork(
    input,
    setup([base, { ...base, id: 2, platforms: [6], version_title: "Remaster", version_parent: 1 }]),
  );
  assert.equal(requiredFixture(observed.records[0]).reason, "exact-original-game-cover");
  assert.equal(
    requiredFixture(
      requiredFixture(requiredFixture(observed.catalog.ports[0]).presentation).artwork,
    ).game_id,
    1,
  );
  const truncated = await prepareCatalogArtwork(
    input,
    setup(Array.from({ length: 21 }, (_, i) => ({ ...base, id: i + 1 }))),
  );
  assert.equal(requiredFixture(truncated.records[0]).reason, "generated-fallback");
  assert.equal(
    requiredFixture(requiredFixture(truncated.records[0]).exceptions[1]).reason,
    "identity-query-incomplete",
  );
});

void test("provider requests use fixed origins, bounded metadata and safe strings; auth failure is attempted once", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-provider-contract-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(
    privateFile,
    JSON.stringify({ client_id: "fixture-id", client_secret: "fixture-secret" }),
  );
  const calls: { url: string; options: RequestInit }[] = [];
  const provider = createIgdbInspector(
    privateFile,
    () => assert.fail("metadata test must not decode"),
    async (url, options) => {
      calls.push({ url, options });
      return new Response(url.includes("oauth2") ? '{"access_token":"fixture-token"}' : "[]");
    },
  );
  await provider.inspectGame({
    names: ['Port"; fields *;'],
    project_url: "https://example.org/port",
    evidence_url: "https://example.org/port",
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://id.twitch.tv/oauth2/token", "https://api.igdb.com/v4/games"],
  );
  assert.ok(calls.every((call) => call.options.redirect === "error"));
  assert.ok(text(requiredFixture(calls[1]).options.body).includes('name ~ "Port\\"; fields *;"'));
  assert.ok(text(requiredFixture(calls[1]).options.body).endsWith("limit 21;"));
  assert.equal(provider.providerMetrics.authentication_requests, 1);
  assert.equal(provider.providerMetrics.game_requests, 1);
  const denied = createIgdbInspector(
    privateFile,
    () => {},
    async () => new Response("fixture-secret", { status: 403 }),
  );
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      denied.inspectGame({
        game_id: 1,
        slug: "port",
        names: ["Port"],
        evidence_url: "https://example.org/port",
      }),
      /authentication unavailable/,
    );
  assert.equal(denied.providerMetrics.authentication_requests, 1);
  assert.equal(denied.providerMetrics.game_requests, 0);
  const oversized = createIgdbInspector(
    privateFile,
    () => {},
    async (url) =>
      new Response(url.includes("oauth2") ? '{"access_token":"fixture-token"}' : "[]", {
        headers: url.includes("oauth2") ? {} : { "content-length": String(1024 * 1024 + 1) },
      }),
  );
  await assert.rejects(
    oversized.inspectGame({
      game_id: 1,
      slug: "port",
      names: ["Port"],
      evidence_url: "https://example.org/port",
    }),
    /byte contract/,
  );
});

void test("malformed nested provider responses reject only that cover and the actual batch continues", async () => {
  const { prepareCatalogArtwork, createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-malformed-provider-"));
  const credentials = join(scratch, "private-fixture.json");
  writeFileSync(credentials, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  for (const invalid of [
    { websites: [null] },
    { alternative_names: [null] },
    { platforms: ["invalid"] },
    { slug: 123 },
    { slug: ["valid-slug"] },
    { cover: { id: 3, image_id: 123 } },
    { cover: { id: 3, image_id: ["co3"] } },
  ]) {
    const transport = createIgdbInspector(
      credentials,
      () => ({ width: 12, height: 24, format: "jpeg", validator: "portcove-core" }),
      async (url, options) => {
        if (url.includes("oauth2")) return new Response('{"access_token":"fixture"}');
        if (url.includes("images.igdb.com"))
          return new Response(
            readFileSync(join(root, "apps/desktop/scripts/testdata/catalog-artwork-red.jpg")),
            { headers: { "content-type": "image/jpeg" } },
          );
        const good = text(options.body).includes('"Good"');
        return new Response(
          JSON.stringify([
            {
              id: good ? 2 : 1,
              name: good ? "Good" : "Bad",
              slug: good ? "good" : "bad",
              websites: [{ url: good ? "https://example.org/good" : "https://example.org/bad" }],
              cover: { id: 3, image_id: "co3" },
              ...(good ? {} : invalid),
            },
          ]),
        );
      },
    );
    const result = await prepareCatalogArtwork(
      {
        ports: [
          { id: "bad", name: "Bad", project_url: "https://example.org/bad" },
          { id: "good", name: "Good", project_url: "https://example.org/good" },
        ],
      },
      { ...transport, acceptedCatalog: { ports: [] } },
    );
    assert.equal(requiredFixture(result.records[0]).reason, "generated-fallback");
    assert.equal(
      requiredFixture(requiredFixture(result.records[0]).exceptions[0]).reason,
      invalid.cover ? "no-usable-cover" : "identity-response-invalid",
    );
    assert.equal(requiredFixture(result.records[1]).reason, "exact-port-cover");
    assert.equal(transport.providerMetrics.authentication_requests, 1);
    assert.equal(transport.providerMetrics.game_requests, 2);
    assert.equal(transport.providerMetrics.image_requests, 1);
  }
});

void test("wrong editions and invalid declarations never reach image acquisition", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const result = await prepareCatalogArtwork(
    { ports: [{ id: "port", name: "Port" }] },
    {
      acceptedCatalog: { ports: [] },
      identities: {
        port: {
          port: {
            game_id: 1,
            slug: "expected",
            names: ["Expected"],
            evidence_url: "https://example.org/facts",
          },
          underlying_game: {
            game_id: 2,
            slug: 'unsafe"; fields *;',
            names: ["Original"],
            evidence_url: "https://example.org/facts",
          },
        },
      },
      inspectGame: async () => [
        { id: 9, slug: "expected", name: "Expected", cover: { id: 3, image_id: "co3" } },
      ],
      inspectImage: () => assert.fail("wrong or unsafe identity cannot download"),
    },
  );
  assert.deepEqual(
    requiredFixture(result.records[0]).exceptions.map((item) => item.reason),
    ["identity-mismatch", "identity-declaration-invalid"],
  );
  assert.equal(requiredFixture(result.records[0]).reason, "generated-fallback");
});

void test("an unavailable explicit refresh retains permitted accepted metadata", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const accepted = fixtureCatalog(
    fixtureJson(readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8")),
  );
  const port = requiredFixture(accepted.ports[0]);
  const mapping = record(requiredFixture(port.presentation).artwork);
  const result = await prepareCatalogArtwork(
    { ...accepted, ports: [port] },
    {
      acceptedCatalog: accepted,
      refreshPortIds: [port.id],
      identities: {
        [port.id]: {
          port: {
            game_id: mapping.game_id,
            slug: mapping.game_slug,
            names: [port.name],
            evidence_url: port.project_url,
          },
        },
      },
      inspectGame: async () => {
        throw new Error("temporary outage");
      },
      inspectImage: () => assert.fail("unavailable identity cannot download"),
    },
  );
  assert.deepEqual(requiredFixture(result.catalog.ports[0]), port);
  assert.equal(
    requiredFixture(result.records[0]).reason,
    "accepted-mapping-retained-after-unavailable-refresh",
  );
  assert.equal(record(requiredFixture(result.records[0]).checks).live_refresh_passed, false);
});

async function capturedArtworkRefresh({
  status = 410,
  imageId = "coexisting",
  fault,
}: { status?: number; imageId?: string; fault?: string } = {}) {
  const { prepareCatalogArtwork, createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-refresh-"));
  const credentials = join(scratch, "private-fixture.json");
  writeFileSync(credentials, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  const mapping = {
    game_id: 101,
    cover_id: 202,
    image_id: "coexisting",
    image_sha256: "a".repeat(64),
    game_slug: "refresh-probe",
    match_kind: "port",
  };
  const accepted: ArtworkCatalog = {
    ports: [
      {
        id: "refresh-probe",
        name: "Refresh Probe",
        project_url: "https://example.org/refresh-probe",
        presentation: { artwork: mapping },
      },
    ],
  };
  const games: {
    id: number;
    name: string;
    slug: string;
    cover?: { id: number; image_id: string };
  }[] = [
    {
      id: 101,
      name: "Refresh Probe",
      slug: "refresh-probe",
      cover: { id: 202, image_id: imageId },
    },
  ];
  const requests: string[] = [];
  let decodes = 0;
  const inspector = createIgdbInspector(
    credentials,
    () => {
      decodes++;
      return { width: 12, height: 24, format: "jpeg", validator: "portcove-core" };
    },
    async (url: string, options: RequestInit) => {
      requests.push(url);
      assert.equal(options.redirect, "error");
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json({ access_token: "fixture" }, { status: fault === "auth" ? 403 : 200 });
      if (url === "https://api.igdb.com/v4/games")
        return Response.json(
          games.filter((game) => text(options.body).includes(`id = ${game.id};`)),
          {
            status: fault === "identity-gone" ? 410 : 200,
          },
        );
      assert.ok(
        /^https:\/\/images\.igdb\.com\/igdb\/image\/upload\/t_cover_big\/[a-z0-9]+\.jpg$/.test(url),
      );
      if (fault === "network") throw new Error("fixture network failure");
      return new Response(
        readFileSync(join(root, "apps/desktop/scripts/testdata/catalog-artwork-red.jpg")),
        {
          status: url.endsWith("/coexisting.jpg")
            ? status
            : imageId === "coexisting"
              ? 200
              : status,
          headers: { "content-type": "image/jpeg" },
        },
      );
    },
  );
  const options: ArtworkPreparationOptions & {
    identities: Record<string, { port?: unknown; underlying_game?: unknown }>;
  } = {
    ...inspector,
    acceptedCatalog: accepted,
    refreshPortIds: ["refresh-probe"],
    identities: {
      "refresh-probe": {
        port: {
          game_id: 101,
          slug: "refresh-probe",
          names: ["Refresh Probe"],
          evidence_url: "https://example.org/refresh-probe",
        },
      },
    },
  };
  return {
    accepted,
    games,
    requests,
    options,
    inspector,
    decodes: () => decodes,
    run: (input = accepted) => prepareCatalogArtwork(input, options),
  };
}

void test("a confirmed Gone response for the accepted image chooses generated fallback", async () => {
  const fixture = await capturedArtworkRefresh();
  const before = structuredClone(fixture.accepted);
  const result = await fixture.run();
  assert.equal(
    requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork,
    undefined,
  );
  assert.equal(requiredFixture(result.records[0]).reason, "generated-fallback");
  assert.deepEqual(requiredFixture(requiredFixture(result.records[0]).exceptions[0]), {
    kind: "port",
    reason: "image-gone",
    resume:
      "Correct the exact identity or asset fact, or retry after a confirmed provider/environment change.",
    image_id: "coexisting",
    http_status: 410,
  });
  assert.equal(requiredFixture(result.records[0]).mapping, null);
  assert.equal(result.metrics.fallback, 1);
  assert.equal(result.metrics.reused, 0);
  assert.equal(fixture.inspector.providerMetrics.image_bytes, 0);
  assert.deepEqual(fixture.accepted, before);
  assert.equal(fixture.decodes(), 0);
});

for (const status of [404, 503, 429]) {
  void test(`HTTP${status} retains permitted accepted artwork metadata`, async () => {
    const fixture = await capturedArtworkRefresh({ status });
    const before = structuredClone(fixture.accepted);
    const result = await fixture.run();
    assert.deepEqual(result.catalog, before);
    assert.deepEqual(fixture.accepted, before);
    assert.equal(
      requiredFixture(result.records[0]).reason,
      "accepted-mapping-retained-after-unavailable-refresh",
    );
    assert.equal(fixture.decodes(), 0);
  });
}

void test("an unchanged accepted mapping makes no source-health claim or provider request", async () => {
  const fixture = await capturedArtworkRefresh();
  fixture.options.refreshPortIds = [];
  const result = await fixture.run();
  assert.deepEqual(result.catalog, fixture.accepted);
  assert.equal(requiredFixture(result.records[0]).reason, "accepted-mapping-reused");
  assert.equal(fixture.requests.length, 0);
});

void test("Gone for a different candidate image cannot withdraw accepted artwork", async () => {
  const fixture = await capturedArtworkRefresh({ imageId: "codifferent" });
  const result = await fixture.run();
  assert.deepEqual(result.catalog, fixture.accepted);
  assert.equal(fixture.decodes(), 0);
  assert.equal(
    requiredFixture(result.records[0]).reason,
    "accepted-mapping-retained-after-unavailable-refresh",
  );
});

for (const fault of ["auth", "network", "identity-gone"]) {
  void test(`${fault} failure does not establish Gone for an accepted image`, async () => {
    const fixture = await capturedArtworkRefresh({ fault });
    const result = await fixture.run();
    assert.deepEqual(result.catalog, fixture.accepted);
    assert.ok(
      requiredFixture(result.records[0]).exceptions.every((item) => item.reason !== "image-gone"),
    );
    assert.equal(fixture.decodes(), 0);
  });
}

void test("unclassified status properties and another image's Gone error cannot withdraw metadata", async () => {
  const fixture = await capturedArtworkRefresh({ imageId: "codifferent" });
  const unrelated = await fixture.inspector
    .inspectImage("codifferent")
    .catch((error: unknown) => error);
  for (const error of [
    Object.assign(new Error("IGDB image is gone."), { status: 410, image_id: "coexisting" }),
    unrelated,
  ]) {
    requiredFixture(requiredFixture(fixture.games[0]).cover).image_id = "coexisting";
    fixture.options.inspectImage = async () => {
      throw error;
    };
    const result = await fixture.run();
    assert.deepEqual(result.catalog, fixture.accepted);
    assert.equal(
      requiredFixture(requiredFixture(result.records[0]).exceptions[0]).reason,
      "image-unavailable-or-invalid",
    );
  }
});

for (const refreshedFirst of [true, false]) {
  void test(`same-image accepted references fall back with refreshed entry ${refreshedFirst ? "first" : "last"}`, async () => {
    const fixture = await capturedArtworkRefresh();
    const reused = {
      ...structuredClone(requiredFixture(fixture.accepted.ports[0])),
      id: "reused",
      name: "Reused",
    };
    fixture.accepted.ports = refreshedFirst
      ? [...fixture.accepted.ports, reused]
      : [reused, ...fixture.accepted.ports];
    const before = structuredClone(fixture.accepted);
    const result = await fixture.run();
    assert.ok(result.catalog.ports.every((port) => !requiredFixture(port.presentation).artwork));
    assert.ok(
      result.records.every(
        (record) => record.reason === "generated-fallback" && record.mapping === null,
      ),
    );
    assert.ok(
      result.records.every((record) =>
        record.exceptions.some(
          (item) => item.image_id === "coexisting" && item.http_status === 410,
        ),
      ),
    );
    assert.deepEqual(fixture.accepted, before);
    assert.deepEqual(result.metrics, {
      ports: 2,
      reused: 0,
      original_reused: 0,
      selected: 0,
      fallback: 2,
      game_queries: 1,
      image_queries: 1,
      image_bytes: 0,
    });
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.inspector.providerMetrics.image_requests, 1);
    assert.equal(fixture.decodes(), 0);
  });
}

for (const refreshedFirst of [true, false]) {
  void test(`accepted original-game reuse cannot restore Gone with refreshed entry ${refreshedFirst ? "first" : "last"}`, async () => {
    const fixture = await capturedArtworkRefresh();
    const original = {
      game_id: 102,
      game_slug: "original",
      cover_id: 203,
      image_id: "coexisting",
      image_sha256: "b".repeat(64),
      match_kind: "underlying-game",
    };
    fixture.accepted.ports.push({ id: "accepted-original", presentation: { artwork: original } });
    fixture.games.push(
      { id: 102, slug: "original", name: "Original", cover: { id: 203, image_id: "coexisting" } },
      { id: 103, slug: "new", name: "New" },
    );
    fixture.options.identities.new = {
      port: { game_id: 103, slug: "new", names: ["New"], evidence_url: "https://example.org/new" },
      underlying_game: {
        game_id: 102,
        slug: "original",
        names: ["Original"],
        evidence_url: "https://example.org/original",
      },
    };
    const added = { id: "new", name: "New", project_url: "https://example.org/new" };
    const refreshed = requiredFixture(fixture.accepted.ports[0]);
    const before = structuredClone(fixture.accepted);
    const result = await fixture.run({
      ports: refreshedFirst ? [refreshed, added] : [added, refreshed],
    });
    assert.ok(result.catalog.ports.every((port) => !port.presentation?.artwork));
    assert.ok(
      result.records.every(
        (record) => record.reason === "generated-fallback" && record.mapping === null,
      ),
    );
    assert.ok(
      result.records.every((record) =>
        record.exceptions.some(
          (item) => item.image_id === "coexisting" && item.http_status === 410,
        ),
      ),
    );
    assert.deepEqual(fixture.accepted, before);
    assert.equal(result.metrics.selected, 0);
    assert.equal(result.metrics.original_reused, 0);
    assert.equal(result.metrics.reused, 0);
    assert.equal(result.metrics.fallback, 2);
    assert.equal(result.metrics.image_queries, 1);
    assert.equal(fixture.inspector.providerMetrics.image_requests, 1);
    assert.equal(fixture.decodes(), 0);
  });
}

void test("Gone for the port cover still permits a checked exact original-game replacement", async () => {
  const fixture = await capturedArtworkRefresh();
  fixture.games.push({
    id: 102,
    slug: "original",
    name: "Original",
    cover: { id: 203, image_id: "coreplacement" },
  });
  requiredFixture(fixture.options.identities["refresh-probe"]).underlying_game = {
    game_id: 102,
    slug: "original",
    names: ["Original"],
    evidence_url: "https://example.org/original",
  };
  const before = structuredClone(fixture.accepted);
  const result = await fixture.run();
  const bytes = readFileSync(join(root, "apps/desktop/scripts/testdata/catalog-artwork-red.jpg"));
  const { createHash } = await import("node:crypto");
  assert.equal(requiredFixture(result.records[0]).reason, "exact-original-game-cover");
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork)
      .image_id,
    "coreplacement",
  );
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork)
      .match_kind,
    "underlying-game",
  );
  assert.equal(
    requiredFixture(requiredFixture(requiredFixture(result.catalog.ports[0]).presentation).artwork)
      .image_sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(requiredFixture(requiredFixture(result.records[0]).exceptions[0]).http_status, 410);
  assert.equal(
    record(record(requiredFixture(result.records[0]).checks).content).bytes,
    bytes.length,
  );
  assert.equal(result.metrics.image_bytes, bytes.length);
  assert.equal(fixture.inspector.providerMetrics.image_bytes, bytes.length);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 2);
  assert.equal(fixture.decodes(), 1);
  assert.deepEqual(fixture.accepted, before);
});

void test("Gone observations still consume the existing finite image-request budget", async () => {
  const fixture = await capturedArtworkRefresh();
  for (let request = 0; request < 400; request++)
    await assert.rejects(fixture.inspector.inspectImage("coexisting"), /image is gone/);
  await assert.rejects(fixture.inspector.inspectImage("coexisting"), /image budget reached/);
  assert.equal(fixture.requests.length, 400);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 400);
  assert.equal(fixture.inspector.providerMetrics.image_bytes, 0);
  assert.equal(fixture.decodes(), 0);
});

void test("a successful HTTP image exceeding its remaining byte budget retains accepted metadata", async () => {
  const fixture = await capturedArtworkRefresh({ status: 200 });
  fixture.options.inspectImage = (imageId) => fixture.inspector.inspectImage(imageId, 1);
  const result = await fixture.run();
  assert.deepEqual(result.catalog, fixture.accepted);
  assert.equal(
    requiredFixture(requiredFixture(result.records[0]).exceptions[0]).reason,
    "image-unavailable-or-invalid",
  );
  assert.equal(fixture.inspector.providerMetrics.image_requests, 1);
  assert.equal(fixture.decodes(), 0);
});

const lifecycleIdentity = {
  game_id: 101,
  slug: "probe",
  names: ["Probe"],
  evidence_url: "https://example.org/probe",
};

function lifecycleCredentials() {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-response-lifecycle-"));
  const file = join(scratch, "private-fixture.json");
  writeFileSync(file, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  return file;
}

async function boundedLifecycleResult<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned response cleanup did not settle.")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const spec of [
  { name: "OAuth status", route: "token", status: 403, error: /authentication unavailable/ },
  { name: "OAuth length", route: "token", status: 200, length: 65537, error: /byte contract/ },
  { name: "metadata429", route: "games", status: 429, retry: "1", error: /identity request/ },
  { name: "metadata503", route: "games", status: 503, error: /identity request/ },
  {
    name: "metadata batch refusal",
    route: "games",
    status: 429,
    retry: "900",
    error: /identity request/,
    refusesNext: true,
  },
  { name: "metadata length", route: "games", status: 200, length: 1048577, error: /byte contract/ },
  { name: "image Gone", route: "image", status: 410, error: /image is gone/ },
  { name: "image status", route: "image", status: 503, error: /image unavailable/ },
  {
    name: "image MIME",
    route: "image",
    status: 200,
    mime: "text/plain",
    error: /image unavailable/,
  },
  { name: "image length", route: "image", status: 200, length: 4096, error: /byte contract/ },
  { name: "image streaming limit", route: "image", status: 200, error: /byte contract/ },
]) {
  void test(`provider response lifecycle closes unfinished ${spec.name} before request timeout`, async () => {
    const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
    const sockets = new Set<Socket>();
    let selectedResponse: Response | undefined;
    let closeTransfer = () => {};
    const closed = new Promise<void>((resolve) => {
      closeTransfer = resolve;
    });
    const routes: string[] = [];
    const server = createServer((request, response) => {
      const route = (request.url ?? "").slice(1);
      routes.push(route);
      if (route !== spec.route) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ access_token: "fixture" }));
        return;
      }
      response.on("close", closeTransfer);
      response.writeHead(spec.status, {
        "Content-Type": spec.mime ?? (route === "image" ? "image/jpeg" : "application/json"),
        ...(spec.retry ? { "Retry-After": spec.retry } : {}),
        ...(spec.length ? { "Content-Length": String(spec.length) } : {}),
      });
      response.flushHeaders();
      // The transfer deliberately stays incomplete; cleanup must not drain it.
      response.write(Buffer.alloc(2048, 0x65));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const origin = `http://127.0.0.1:${String(record(server.address()).port)}`;
      const inspector = createIgdbInspector(
        lifecycleCredentials(),
        () => assert.fail("refused response must not reach the decoder"),
        async (url, options) => {
          assert.equal(options.redirect, "error");
          assert.equal(requiredFixture(options.signal).aborted, false);
          const route =
            url === "https://id.twitch.tv/oauth2/token"
              ? "token"
              : url === "https://api.igdb.com/v4/games"
                ? "games"
                : "image";
          const response = await fetch(`${origin}/${route}`, options);
          if (route === spec.route) selectedResponse = response;
          return response;
        },
      );
      await assert.rejects(
        spec.route === "image"
          ? inspector.inspectImage("coprobe", 1024)
          : inspector.inspectGame(lifecycleIdentity),
        spec.error,
      );
      // Observe cancellation before test-owned socket teardown can supply it.
      await boundedLifecycleResult(closed);
      assert.equal(requiredFixture(requiredFixture(selectedResponse).body).locked, false);
      assert.equal(requiredFixture(selectedResponse).bodyUsed, true);
      if (spec.refusesNext) {
        await assert.rejects(inspector.inspectGame(lifecycleIdentity), /batch deadline reached/);
        assert.deepEqual(routes, ["token", "games"]);
      }
      if (spec.name === "image streaming limit") {
        // Fetch may split the server's write: account for the consumed chunks,
        // stopping as soon as the remaining budget is exceeded.
        assert.ok(inspector.providerMetrics.image_bytes > 1024);
        assert.ok(inspector.providerMetrics.image_bytes <= 2048);
      } else assert.equal(inspector.providerMetrics.image_bytes, 0);
      assert.equal(
        inspector.providerMetrics.authentication_requests,
        spec.route === "image" ? 0 : 1,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

for (const refusal of ["status", "length", "streaming"]) {
  for (const cancellation of ["resolve", "reject", "throw", "pending"]) {
    void test(`provider response lifecycle retains ${refusal} failure with ${cancellation} cancellation`, async () => {
      const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
      let cancellations = 0;
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2));
          },
          cancel() {
            cancellations++;
            if (cancellation === "reject") return Promise.reject(new Error("cleanup failure"));
            if (cancellation === "throw") throw new Error("cleanup failure");
            if (cancellation === "pending") return new Promise(() => {});
          },
        }),
        {
          status: refusal === "status" ? 503 : 200,
          headers: {
            "Content-Type": "image/jpeg",
            ...(refusal === "length" ? { "Content-Length": "2" } : {}),
          },
        },
      );
      const inspector = createIgdbInspector(
        lifecycleCredentials(),
        () => assert.fail("refused response must not reach the decoder"),
        async () => response,
      );
      await assert.rejects(boundedLifecycleResult(inspector.inspectImage("coprobe", 1)), {
        message:
          refusal === "status" ? "IGDB image unavailable." : "Response exceeds its byte contract.",
      });
      assert.equal(cancellations, 1);
      assert.equal(requiredFixture(response.body).locked, false);
      assert.equal(inspector.providerMetrics.image_requests, 1);
      assert.equal(inspector.providerMetrics.image_bytes, refusal === "streaming" ? 2 : 0);
    });
  }
}

void test("provider response lifecycle releases an aborted reader without changing its error", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const primary = new DOMException("fixture request aborted", "AbortError");
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(primary);
      },
    }),
    { headers: { "Content-Type": "image/jpeg" } },
  );
  const inspector = createIgdbInspector(
    lifecycleCredentials(),
    () => assert.fail("aborted response must not decode"),
    async () => response,
  );
  await assert.rejects(inspector.inspectImage("coprobe"), (error) => error === primary);
  assert.equal(requiredFixture(response.body).locked, false);
  assert.equal(inspector.providerMetrics.image_bytes, 0);
});

void test("provider response lifecycle preserves consumed JSON and exact image bytes", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const bytes = readFileSync(join(root, "apps/desktop/scripts/testdata/catalog-artwork-red.jpg"));
  const responses = [
    Response.json({ access_token: "fixture" }),
    Response.json([]),
    new Response(bytes, { headers: { "Content-Type": "image/jpeg" } }),
  ];
  let requests = 0;
  let decodes = 0;
  const inspector = createIgdbInspector(
    lifecycleCredentials(),
    (value) => {
      decodes++;
      assert.deepEqual(value, bytes);
      return { width: 12, height: 24, format: "jpeg", validator: "portcove-core" };
    },
    async () => requiredFixture(responses[requests++]),
  );
  assert.deepEqual(await inspector.inspectGame(lifecycleIdentity), []);
  const image = await inspector.inspectImage("coprobe");
  assert.equal(image.bytes, bytes.length);
  assert.equal(image.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(decodes, 1);
  assert.equal(requests, 3);
  assert.ok(
    responses.every((response) => response.bodyUsed && !requiredFixture(response.body).locked),
  );
  assert.equal(inspector.providerMetrics.authentication_requests, 1);
  assert.equal(inspector.providerMetrics.game_requests, 1);
  assert.equal(inspector.providerMetrics.image_bytes, bytes.length);
});

void test("provider response lifecycle preserves malformed JSON and missing-body failures", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const response = new Response("{");
  const inspector = createIgdbInspector(
    lifecycleCredentials(),
    () => assert.fail("invalid response must not decode"),
    async () => response,
  );
  const failure = await inspector.inspectGame(lifecycleIdentity).catch((error: unknown) => error);
  assert.ok(failure instanceof SyntaxError);
  await assert.rejects(inspector.inspectGame(lifecycleIdentity), (error) => error === failure);
  assert.equal(inspector.providerMetrics.authentication_requests, 1);
  assert.equal(requiredFixture(response.body).locked, false);
  const empty = createIgdbInspector(
    lifecycleCredentials(),
    () => assert.fail("missing response must not decode"),
    async () => new Response(null, { headers: { "Content-Type": "image/jpeg" } }),
  );
  await assert.rejects(empty.inspectImage("coprobe"), /byte contract/);
});

const providerClockStart = Date.UTC(2026, 9, 3, 8);

async function flushProviderTimers(context: TestContext) {
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(0);
  await new Promise((resolve) => setImmediate(resolve));
}

async function capturedMetadataBackoff(
  context: TestContext,
  {
    status = 429,
    retryAfter = "2",
    responseDelay = 0,
  }: { status?: number; retryAfter?: string | null; responseDelay?: number } = {},
) {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-metadata-backoff-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(privateFile, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: providerClockStart });
  const calls: number[] = [];
  const inspector = createIgdbInspector(
    privateFile,
    () => assert.fail("metadata must not decode"),
    async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(requiredFixture(options.signal).aborted, false);
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json({ access_token: "fixture" });
      assert.equal(url, "https://api.igdb.com/v4/games");
      calls.push(Date.now());
      if (calls.length === 1) context.mock.timers.tick(responseDelay);
      return Response.json([], {
        status: calls.length === 1 ? status : 200,
        headers: calls.length === 1 && retryAfter !== null ? { "Retry-After": retryAfter } : {},
      });
    },
  );
  const request = (id: number) =>
    inspector.inspectGame({
      game_id: id,
      slug: `probe-${id}`,
      names: [`Probe ${id}`],
      evidence_url: "https://example.org/probe",
    });
  const first = request(101).catch((error: unknown) => error);
  await flushProviderTimers(context);
  await first;
  return { inspector, calls, request };
}

for (const [status, retryAfter] of [
  [429, "2"],
  [503, "2"],
  [429, new Date(providerClockStart + 2000).toUTCString()],
  [503, "Saturday, 03-Oct-26 08:00:02 GMT"],
  [429, "Sat Oct  3 08:00:02 2026"],
  [503, "Sat Oct 03 08:00:02 2026"],
] as const) {
  void test(`metadata${status} honors Retry-After ${retryAfter}`, async (context) => {
    const fixture = await capturedMetadataBackoff(context, { status, retryAfter });
    const next = fixture.request(102);
    await flushProviderTimers(context);
    context.mock.timers.tick(300);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1, "request must not escape at the ordinary300ms floor");
    context.mock.timers.tick(1699);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1, "request must not escape before the full provider pause");
    context.mock.timers.tick(1);
    await flushProviderTimers(context);
    await next;
    assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 2000]);
    assert.equal(fixture.inspector.providerMetrics.game_requests, 2);
    assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
  });
}

void test("HTTP-date metadata backoff preserves UTC semantics across process timezones", (context) => {
  const env = { ...process.env };
  // The outer runner marks its workers; a new independent runner must not
  // inherit that marker and silently refuse recursive discovery.
  delete env.NODE_TEST_CONTEXT;
  for (const [timezone, offset] of [
    ["Etc/UTC", 0],
    ["America/New_York", 240],
    ["Asia/Tokyo", -540],
    ["Pacific/Kiritimati", -840],
    ["Asia/Kathmandu", -345],
  ] as const) {
    // A fresh process prevents timezone changes from affecting other tests.
    // Observe the actual timezone so an ignored TZ cannot manufacture coverage.
    const verifyTimezone = `import assert from "node:assert/strict"; assert.equal(new Date("2026-10-03T08:00:00Z").getTimezoneOffset(), ${offset});`;
    const result = spawnSync(
      process.execPath,
      [
        `--import=data:text/javascript,${encodeURIComponent(verifyTimezone)}`,
        "--test",
        "--test-timeout=30000",
        "--test-reporter=spec",
        "--test-name-pattern=^(metadata.*honors Retry-After|unusable or elapsed Retry-After|Retry-After beyond the finite batch budget)",
        "scripts/generate-catalog.test.mts",
      ],
      { cwd: root, env: { ...env, TZ: timezone }, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.error, undefined, `${timezone}: ${result.error}`);
    assert.equal(result.status, 0, `${timezone}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /metadata429 honors Retry-After Sat Oct  3 08:00:02 2026/);
    assert.match(result.stdout, /unusable or elapsed Retry-After Sat Oct  3 07:59:59 2026/);
    assert.match(
      result.stdout,
      /Retry-After beyond the finite batch budget.*Sat Oct 03 08:15:01 2026/,
    );
    const passed = result.stdout.match(/ℹ pass (\d+)/);
    assert.ok(passed, `${timezone}: child must report executed tests`);
    context.diagnostic(
      `${timezone}: ${requiredFixture(passed[1])} selected cases passed; observed offset ${offset}`,
    );
  }
});

for (const retryAfter of [
  null,
  "invalid",
  "-1",
  "1.5",
  "0",
  "Sat, 03 Oct 0030 08:00:00 GMT",
  "Sat Oct  3 08:00:00 0030",
  "Tue, 31 Nov 2026 08:00:00 GMT",
  "Tuesday, 31-Nov-26 08:00:00 GMT",
  "Tue Nov 31 08:00:00 2026",
  "Saturday, 03-Oct-76 08:00:01 GMT",
  "Sat Oct  3 07:59:59 2026",
  new Date(providerClockStart - 1000).toUTCString(),
]) {
  void test(`unusable or elapsed Retry-After ${retryAfter} preserves the metadata rate floor`, async (context) => {
    const fixture = await capturedMetadataBackoff(context, { retryAfter });
    const next = fixture.request(102);
    await flushProviderTimers(context);
    context.mock.timers.tick(299);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1);
    context.mock.timers.tick(1);
    await flushProviderTimers(context);
    await next;
    assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 300]);
    assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
  });
}

void test("successful metadata ignores Retry-After and preserves ordinary pacing", async (context) => {
  const fixture = await capturedMetadataBackoff(context, { status: 200, retryAfter: "900" });
  const next = fixture.request(102);
  await flushProviderTimers(context);
  context.mock.timers.tick(300);
  await flushProviderTimers(context);
  await next;
  assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 300]);
});

void test("Retry-After seconds start when the unavailable response arrives", async (context) => {
  const fixture = await capturedMetadataBackoff(context, { responseDelay: 500 });
  const next = fixture.request(102);
  await flushProviderTimers(context);
  context.mock.timers.tick(1999);
  await flushProviderTimers(context);
  assert.equal(fixture.calls.length, 1);
  context.mock.timers.tick(1);
  await flushProviderTimers(context);
  await next;
  assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 2500]);
});

void test("deadline expiry while a metadata wait resolves does not count or send a request", async (context) => {
  const fixture = await capturedMetadataBackoff(context);
  const next = fixture.request(102).catch((error: unknown) => error);
  await flushProviderTimers(context);
  context.mock.timers.tick(15 * 60 * 1000);
  await flushProviderTimers(context);
  assert.match(text(record(await next).message), /batch deadline/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.inspector.providerMetrics.game_requests, 1);
});

void test("metadata pacing preserves the800request cap without repeated authentication", async (context) => {
  const fixture = await capturedMetadataBackoff(context, { retryAfter: null });
  for (let request = 1; request < 799; request++) {
    const next = fixture.request(101 + request);
    await flushProviderTimers(context);
    context.mock.timers.tick(300);
    await flushProviderTimers(context);
    await next;
  }
  const last = Promise.allSettled([fixture.request(900), fixture.request(901)]);
  await flushProviderTimers(context);
  context.mock.timers.tick(300);
  await flushProviderTimers(context);
  const results = await last;
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(
    text(
      record(
        rejectedReason(requiredFixture(results.find((result) => result.status === "rejected"))),
      ).message,
    ),
    /metadata budget/,
  );
  await assert.rejects(fixture.request(901), /metadata budget/);
  assert.equal(fixture.calls.length, 800);
  assert.equal(fixture.inspector.providerMetrics.game_requests, 800);
  assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
});

void test("metadata backoff uses the existing batch cancellation signal", async (context) => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-metadata-cancel-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(privateFile, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  let requests = 0;
  const inspector = createIgdbInspector(
    privateFile,
    () => assert.fail("metadata must not decode"),
    async (url) => {
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json({ access_token: "fixture" });
      assert.equal(url, "https://api.igdb.com/v4/games");
      requests++;
      return Response.json([], { status: 503, headers: { "Retry-After": "600" } });
    },
  );
  const identity = {
    game_id: 101,
    slug: "probe",
    names: ["Probe"],
    evidence_url: "https://example.org/probe",
  };
  await assert.rejects(inspector.inspectGame(identity), /identity request unavailable/);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  let waitSignals = 0;
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    if (milliseconds <= 15000) return timeout(milliseconds);
    waitSignals++;
    return controller.signal;
  });
  const pending = inspector.inspectGame(identity);
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(waitSignals, 1);
  assert.equal(requests, 1);
  assert.equal(inspector.providerMetrics.game_requests, 1);
  assert.equal(inspector.providerMetrics.authentication_requests, 1);
});

void test("over-budget metadata backoff retains accepted mappings and leaves authoring input unchanged", async (context) => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const fixture = await capturedMetadataBackoff(context, { retryAfter: "900" });
  const accepted: ArtworkCatalog = {
    ports: [
      {
        id: "probe",
        name: "Probe",
        project_url: "https://example.org/probe",
        presentation: {
          artwork: {
            game_id: 101,
            cover_id: 202,
            image_id: "coexisting",
            image_sha256: "a".repeat(64),
            game_slug: "probe",
            match_kind: "port",
          },
        },
      },
    ],
  };
  const before = structuredClone(accepted);
  const result = await prepareCatalogArtwork(accepted, {
    ...fixture.inspector,
    acceptedCatalog: accepted,
    refreshPortIds: ["probe"],
    identities: {
      probe: {
        port: {
          game_id: 101,
          slug: "probe",
          names: ["Probe"],
          evidence_url: "https://example.org/probe",
        },
      },
    },
  });
  assert.deepEqual(result.catalog, accepted);
  assert.deepEqual(accepted, before);
  assert.equal(
    requiredFixture(result.records[0]).reason,
    "accepted-mapping-retained-after-unavailable-refresh",
  );
  assert.equal(record(requiredFixture(result.records[0]).checks).live_refresh_passed, false);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 0);
});

for (const retryAfter of [
  "900",
  "901",
  "9".repeat(200),
  "9007199254740991",
  "Thursday, 01-Jan-60 08:00:00 GMT",
  "Saturday, 03-Oct-76 08:00:00 GMT",
  "Sat Oct  3 08:15:00 2026",
  "Sat Oct 03 08:15:01 2026",
  new Date(providerClockStart + 901000).toUTCString(),
]) {
  void test(`Retry-After beyond the finite batch budget refuses another metadata request: ${retryAfter.slice(0, 40)}`, async (context) => {
    const fixture = await capturedMetadataBackoff(context, { retryAfter });
    const next = fixture.request(102).then(
      () => assert.fail("over-budget pause cannot send"),
      (error: unknown) => error,
    );
    await flushProviderTimers(context);
    context.mock.timers.tick(300);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1);
    assert.match(text(record(await next).message), /batch deadline/);
    assert.equal(Date.now(), providerClockStart + 300, "no unbounded sleep");
    assert.equal(fixture.inspector.providerMetrics.game_requests, 1);
    assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
  });
}

void test("ordinary generator prepares one complete retained batch and refuses output overwrite", () => {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-artwork-generator-"));
  const output = join(scratch, "proposal");
  const before = readFileSync(join(catalogRoot, "catalog.json"), "utf8");
  const args = [
    "--prepare-artwork",
    join(catalogRoot, "catalog-current-authoring.json"),
    "--output-dir",
    output,
    // This zero-request control must never discover the maintainer's account.
    "--credentials-file",
    join(scratch, "intentionally-unavailable-credentials.json"),
  ];
  const generated = run(...args);
  assert.equal(generated.status, 0, generated.stderr);
  const evidence = fixtureJson(readFileSync(join(output, "artwork-evidence.json"), "utf8"));
  const accepted = fixtureCatalog(fixtureJson(before));
  assert.deepEqual(
    records(evidence.records).map((record) => record.port_id),
    accepted.ports.map((port) => port.id),
  );
  assert.deepEqual(evidence.differences, []);
  assert.equal(record(evidence.provider_metrics).authentication_requests, 0);
  assert.equal(record(evidence.provider_metrics).game_requests, 0);
  assert.equal(record(evidence.provider_metrics).image_requests, 0);
  writeFileSync(join(output, "preservation-marker"), "keep");
  const repeated = run(...args);
  assert.notEqual(repeated.status, 0);
  assert.equal(readFileSync(join(output, "preservation-marker"), "utf8"), "keep");
  assert.equal(readFileSync(join(catalogRoot, "catalog.json"), "utf8"), before);
});

void test("artwork preparation widens replaced artwork while retaining authoring metadata", async () => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const input = {
    schema_version: 2,
    custom: { retained: true },
    ports: [
      {
        id: "typed-artwork",
        name: "Typed artwork",
        custom: "retained",
        presentation: { artwork: null, summary: "retained" },
      },
    ],
  };
  const result = await prepareCatalogArtwork(input, {});
  const port = requiredFixture(result.catalog.ports[0]);
  assert.ok(port);
  // @ts-expect-error Preparation may remove null or replace it with a checked mapping.
  const originalLiteral: null = port.presentation?.artwork;
  assert.equal(originalLiteral, undefined);
  const imageId: string | undefined = port.presentation?.artwork?.image_id;
  assert.equal(imageId, undefined);
  assert.deepEqual(result.catalog.custom, input.custom);
  assert.equal(port.custom, "retained");
  assert.equal(port.presentation?.summary, "retained");
  assert.equal(requiredFixture(input.ports[0])?.presentation.artwork, null);
});
