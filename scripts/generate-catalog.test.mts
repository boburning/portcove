import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  requiredFixture,
  record,
  stringArray,
  text,
  fixtureJson,
  fixtureCatalog,
  catalogRoot,
  run,
  isolatedGenerator,
} from "./fixtures/catalog-generator-fixtures.mts";

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

void test("proposal artwork retains accepted listing covers without widening operational authority", () => {
  const fixture = isolatedGenerator();
  // Materialize the operational fixture before adding a separately authored
  // listing. Invoke directly below so the historical fixture sync cannot erase it.
  assert.equal(fixture.run().status, 0);
  const accepted = readFileSync(join(fixture.catalogs, "catalog-current-authoring.json"));
  const mapping = {
    game_id: 987654321,
    cover_id: 576176,
    image_id: "cocckw",
    image_sha256: "a".repeat(64),
    game_slug: "accepted-original",
    match_kind: "underlying-game",
  };
  const listing = {
    id: "accepted-listing",
    name: "Accepted Listing",
    summary: "Reviewed listing before managed adoption.",
    project_url: "https://example.org/accepted-listing",
    artwork: mapping,
  };
  writeFileSync(
    join(fixture.catalogs, "ports", `${listing.id}.json`),
    JSON.stringify({ format_version: 1, listing }),
  );
  const input = fixtureCatalog(fixtureJson(accepted));
  const promoted = { ...listing, presentation: { artwork: mapping } };
  delete (promoted as Record<string, unknown>).artwork;
  input.ports.push(promoted);
  const proposal = join(fixture.scratch, "proposal.json");
  const identities = join(fixture.scratch, "identities.json");
  writeFileSync(
    identities,
    JSON.stringify({
      [listing.id]: {
        underlying_game: {
          game_id: 987654321,
          slug: "accepted-original",
          names: ["Accepted Original"],
          evidence_url: "https://example.org/original-identity",
        },
      },
    }),
  );
  for (const mode of [
    "ordinary",
    "changed-project",
    "refresh",
    "changed-source",
    "declared-original",
  ]) {
    const candidate = structuredClone(input);
    const last = requiredFixture(candidate.ports.at(-1));
    if (mode === "changed-project") last.project_url = "https://example.org/different-project";
    if (mode === "changed-source" || mode === "declared-original")
      last.source_profile = "new-source";
    writeFileSync(proposal, JSON.stringify(candidate));
    const output = join(fixture.scratch, mode);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/generate-catalog.mts",
        "--prepare-artwork",
        proposal,
        "--output-dir",
        output,
        "--credentials-file",
        join(fixture.scratch, "absent-provider-credentials.json"),
        "--artwork-ids",
        listing.id,
        ...(mode === "refresh" ? ["--refresh-artwork", listing.id] : []),
        ...(mode === "declared-original" ? ["--identities", identities] : []),
      ],
      { cwd: fixture.scratch, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const evidence = fixtureJson(readFileSync(join(output, "artwork-evidence.json")));
    const records = evidence.records;
    assert.ok(Array.isArray(records));
    const observation = record(
      records.find((value: unknown) => record(value).port_id === listing.id),
    );
    const prepared = fixtureCatalog(
      fixtureJson(readFileSync(join(output, "catalog-proposal.json"))),
    );
    if (mode === "ordinary" || mode === "declared-original" || mode === "refresh") {
      assert.deepEqual(prepared, candidate);
      assert.equal(
        observation.reason,
        mode === "ordinary"
          ? "accepted-mapping-reused"
          : mode === "refresh"
            ? "accepted-mapping-retained-after-unavailable-refresh"
            : "accepted-original-game-reused",
      );
    } else {
      assert.notEqual(observation.reason, "accepted-mapping-reused");
      assert.equal(requiredFixture(prepared.ports.at(-1)).presentation?.artwork, undefined);
    }
    assert.deepEqual(
      readFileSync(join(fixture.catalogs, "catalog-current-authoring.json")),
      accepted,
    );
    if (mode === "ordinary") {
      assert.equal(record(evidence.provider_metrics).game_requests, 0);
      assert.equal(record(evidence.provider_metrics).authentication_requests, 0);
    }
    assert.equal(record(evidence.provider_metrics).image_requests, 0);
    assert.equal(typeof evidence.accepted_artwork_context_sha256, "string");
    assert.notEqual(evidence.accepted_artwork_context_sha256, evidence.accepted_catalog_sha256);
  }
});
