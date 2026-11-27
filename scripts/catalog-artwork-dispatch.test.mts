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

import { checkedAuthoredPort, projectAuthoredPort } from "./catalog-authoring.mts";

void test("generator fixture retains an exact authored unresolved review without publishing it", () => {
  const id = "alexbeav-kings-field-recomp";
  const fixture = isolatedGenerator();
  const original = checkedAuthoredPort(
    fixtureJson(readFileSync(join(catalogRoot, "ports", `${id}.json`))),
    id,
  );
  const retained = checkedAuthoredPort(
    fixtureJson(readFileSync(join(fixture.catalogs, "ports", `${id}.json`))),
    id,
  );
  assert.equal(original.original_game_review?.disposition, "unresolved");
  assert.equal(original.listing.original_game, undefined);
  assert.equal(retained.listing.id, original.listing.id);
  assert.equal(retained.integration?.source_profile, original.integration?.source_profile);
  assert.deepEqual(retained.original_game_review, original.original_game_review);
  const projected = requiredFixture(projectAuthoredPort(retained));
  assert.equal(Object.hasOwn(projected, "original_game_review"), false);
  assert.equal(projected.presentation?.original_game, undefined);
  assert.deepEqual(
    projected,
    requiredFixture(
      fixtureCatalog(fixtureJson(readFileSync(join(catalogRoot, "catalog.json")))).ports.find(
        (port) => port.id === id,
      ),
    ),
  );
});

type EditExpected = { port_ids: string[]; source_profile_ids: string[]; approve?: boolean };

// Each case must fail for its own reason, not an earlier unrelated refusal.
const refusals: Record<string, RegExp> = {
  "missing additive port": /Review independent compatibility fixture before generation/,
  "missing frozen profile": /Review independent compatibility fixture before generation/,
  "duplicate actual port": /Authored port filename and stable listing ID must agree/,
  "duplicate actual profile": /source_catalog\.identities contains duplicate ids/,
  "duplicate expected": /port_ids: nonempty unique IDs required/,
  "legacy overlap": /port_ids: overlaps frozen legacy IDs/,
  "unsorted expected": /port_ids: keep IDs in ascending order/,
  "unknown fixture key": /expected only explicit identity lists/,
  "empty expected": /source_profile_ids: nonempty unique IDs required/,
  "invalid expected ID": /port_ids: nonempty unique IDs required/,
};

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
      expected.port_ids.sort();
    },
  ],
  [
    "unsorted expected",
    null,
    (expected: EditExpected) => {
      expected.port_ids.reverse();
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
    const inputPath = join(fixture.catalogs, "catalog-fixture-input.json");
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
      assert.match(String(result.stderr), refusals[name]!, name);
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
  assert.deepEqual(
    fixture.processes.map(({ repository_authoring }) => repository_authoring),
    [false, true, true],
  );
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
  assert.deepEqual(
    records(artwork.records).map((item) => item.failure),
    [true, true],
  );
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
    join(catalogRoot, "catalog.json"),
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
    join(catalogRoot, "catalog.json"),
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
  const gameMedia = record(evidence.game_media);
  const media = records(gameMedia.records);
  const coverage = records(gameMedia.coverage);
  assert.ok(coverage.every((item) => item.port_id === "shipwright"));
  const exactCoverage = coverage.filter((item) => record(item.subject).kind === "port");
  assert.deepEqual(
    exactCoverage.map((item) => [item.role, item.provider, item.state]),
    [
      ["key_art", "igdb", "unknown"],
      ["logo", "igdb", "unknown"],
      ["header", "igdb", "unknown"],
      ["screenshot", "igdb", "unknown"],
    ],
  );
  const exactPort = media.filter((item) => record(item.subject).kind === "port");
  assert.deepEqual(
    exactPort.map((item) => item.role),
    ["key_art", "logo", "header", "screenshot"],
  );
  assert.ok(
    media.every(
      (item) => item.port_id === "shipwright" && item.reason === "identity-provider-unavailable",
    ),
  );
  assert.equal(record(evidence.provider_metrics).authentication_requests, 0);
  assert.equal(record(evidence.provider_metrics).image_requests, 0);
});

void test("hero preparation retains reviewed directory media for a managed listing", () => {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-managed-media-dispatch-"));
  const output = join(scratch, "proposal");
  const result = run(
    "--prepare-artwork",
    join(catalogRoot, "catalog.json"),
    "--output-dir",
    output,
    "--credentials-file",
    join(scratch, "absent-private-credentials.json"),
    "--artwork-ids",
    "tomba-recompiled",
    "--hero-media",
    "igdb",
  );
  assert.equal(result.status, 0, result.stderr);
  const evidence = fixtureJson(readFileSync(join(output, "artwork-evidence.json"), "utf8"));
  const details = record(evidence.game_media);
  const original = (entry: Record<string, unknown>) =>
    record(entry.subject).source_edition_id === "tomba-playstation";
  const coverage = records(details.coverage).filter(original);
  const header = coverage.find((item) => item.role === "header");
  assert.equal(header?.state, "admitted");
  assert.deepEqual(header?.provider_game_ids, [4097]);
  const observed = records(details.records).filter(original);
  assert.equal(observed.find((item) => item.role === "header")?.reason, "existing-scene-retained");
  const logo = observed.find((item) => item.role === "logo");
  assert.equal(logo?.reason, "identity-provider-unavailable");
  assert.equal(record(evidence.provider_metrics).authentication_requests, 0);
  assert.match(String(details.accepted_media_context_sha256), /^[a-f0-9]{64}$/u);
});

void test("full artwork preparation checks typed scenes through the listing validator", () => {
  const id = "tomba-recompiled";
  const authored = checkedAuthoredPort(
    fixtureJson(readFileSync(join(catalogRoot, "ports", `${id}.json`))),
    id,
  );
  const asset = requiredFixture(
    records(authored.listing.media).find((item) => item.role === "header"),
  );
  const fixture = proposalDecoderFixture(0, false, "--prepare-proposal", undefined, {
    portId: id,
    asset,
  });
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  const strict = fixtureCatalog(
    fixtureJson(readFileSync(join(fixture.output, "catalog-proposal.json"))),
  );
  const strictPort = requiredFixture(strict.ports.find((port) => port.id === id));
  assert.equal(record(strictPort.presentation).media, undefined);
  const bytes = readFileSync(join(fixture.output, "listing-media-proposal.json"));
  const directory = record(fixtureJson(bytes));
  assert.equal(records(directory.listings)[0]?.id, id);
  assert.deepEqual(records(directory.listings)[0]?.media, [asset]);
  const evidence = record(fixtureJson(readFileSync(join(fixture.output, "artwork-evidence.json"))));
  const check = record(record(evidence.game_media).listing_check);
  assert.equal(check.input_sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(fixture.processes.filter((item) => record(item).listings === true).length, 1);
});
