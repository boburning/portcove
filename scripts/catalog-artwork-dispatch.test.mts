import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  requiredFixture,
  record,
  records,
  stringArray,
  fixtureJson,
  fixtureCatalog,
  catalogRoot,
  run,
  isolatedGenerator,
  proposalDecoderFixture,
} from "./fixtures/catalog-generator-fixtures.mts";
import type { FixtureCatalog } from "./fixtures/catalog-generator-fixtures.mts";

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

void test("explicit IGDB hero preparation retains unknown acquisition when its selected credential file is absent", () => {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-hero-dispatch-"));
  const output = join(scratch, "proposal");
  const result = run(
    "--prepare-artwork",
    join(catalogRoot, "catalog-current-authoring.json"),
    "--output-dir",
    output,
    "--credentials-file",
    join(scratch, "absent-private-credentials.json"),
    "--artwork-ids",
    "shipwright",
    "--hero-media",
    "igdb",
  );
  assert.equal(result.status, 0, result.stderr);
  const evidence = fixtureJson(readFileSync(join(output, "artwork-evidence.json"), "utf8"));
  const media = records(record(evidence.game_media).records);
  const exactPort = media.filter((item) => record(item.subject).kind === "port");
  assert.equal(exactPort.length, 2);
  assert.deepEqual(
    exactPort.map((item) => item.role),
    ["key_art", "logo"],
  );
  assert.ok(
    media.every(
      (item) => item.port_id === "shipwright" && item.reason === "identity-provider-unavailable",
    ),
  );
  assert.equal(record(evidence.provider_metrics).authentication_requests, 0);
  assert.equal(record(evidence.provider_metrics).image_requests, 0);
});
