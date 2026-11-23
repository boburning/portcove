import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readCatalogSource } from "./catalog-authoring.mts";
import { sceneCoverage } from "./artwork-operations.mts";
import {
  checkShapeTable,
  coreComponentRulesVersion,
  coreShapeVersion,
  derivationInputsDigest,
  entriesDigest,
  pruneTable,
  recordEntry,
  reviewedArtifacts,
  serializeTable,
  tablePath as shapeTablePath,
} from "./package-shape-baselines.mts";
import type { ShapeEntry, ShapeTable } from "./package-shape-baselines.mts";

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
    fixtureJson(readFileSync(join(fixture.catalogs, "catalog-fixture-input.json"))),
  );
  input.ports.push({ ...requiredFixture(input.ports[0]), id: "unreviewed-fixture-port" });
  writeFileSync(join(fixture.catalogs, "catalog-fixture-input.json"), JSON.stringify(input));
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
    `${JSON.stringify(fixtureJson(readFileSync(join(fixture.catalogs, "catalog-fixture-input.json"))), null, 2)}\n`,
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
  const input = join(catalogRoot, "catalog.json");
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

void test("current versioned authoring deterministically owns the embedded catalog", () => {
  const result = run("--check");
  assert.equal(result.status, 0, result.stderr);

  // The embedded catalog is a pure projection of the authored per-port sources.
  const current = fixtureCatalog(
    fixtureJson(JSON.stringify(readCatalogSource(catalogRoot).catalog)),
  );
  const embedded = fixtureJson(readFileSync(join(catalogRoot, "catalog.json"), "utf8"));
  assert.deepEqual(embedded, current);
  assert.equal(current.schema_version, 3);
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
  const accepted = readFileSync(join(fixture.catalogs, "catalog-fixture-input.json"));
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
    assert.deepEqual(readFileSync(join(fixture.catalogs, "catalog-fixture-input.json")), accepted);
    if (mode === "ordinary") {
      assert.equal(record(evidence.provider_metrics).game_requests, 0);
      assert.equal(record(evidence.provider_metrics).authentication_requests, 0);
    }
    assert.equal(record(evidence.provider_metrics).image_requests, 0);
    assert.equal(typeof evidence.accepted_artwork_context_sha256, "string");
    assert.notEqual(evidence.accepted_artwork_context_sha256, evidence.accepted_catalog_sha256);
  }
});

// Generated reviewed package shapes (#5359): the offline --check refuses a stale table.
const shapeCatalog = () =>
  record(JSON.parse(readFileSync(join(catalogRoot, "catalog.json"), "utf8")));
const shapeTableText = () => readFileSync(shapeTablePath, "utf8");
const firstShapeEntry = (table: ShapeTable) => {
  const entry = table.entries[0];
  assert.ok(entry, "the committed table has entries");
  return entry;
};

void test("the committed package shape table is current for the catalog and Core", () => {
  assert.deepEqual(checkShapeTable(shapeTableText(), shapeCatalog(), coreShapeVersion()), []);
});

void test("only the declared Linux portable data route changes its shape derivation digest", () => {
  const port = (shapeCatalog().ports as Record<string, unknown>[]).find(
    (candidate) => candidate.id === "nicholas-ochoa-opensc2k",
  );
  assert.ok(port);
  const withoutPortableData = { ...port };
  delete withoutPortableData.linux_portable_data_directory;
  assert.notEqual(
    derivationInputsDigest(port, "linux-x86-64"),
    derivationInputsDigest(withoutPortableData, "linux-x86-64"),
  );
  assert.equal(
    derivationInputsDigest(port, "windows-x86-64"),
    derivationInputsDigest(withoutPortableData, "windows-x86-64"),
  );
});

void test("package shape check refuses a digest the catalog no longer marks as reviewed", () => {
  const catalog = shapeCatalog();
  const entry = firstShapeEntry(JSON.parse(shapeTableText()) as ShapeTable);
  for (const contract of record(catalog.source_catalog).contracts as Record<string, unknown>[])
    if (contract.port_id === entry.port_id)
      contract.applicability = (contract.applicability as Record<string, unknown>[]).filter(
        (row) => row.artifact_sha256 !== entry.sha256,
      );
  const problems = checkShapeTable(shapeTableText(), catalog, coreShapeVersion());
  assert.ok(
    problems.some((problem) => problem.includes("no longer marks this digest as reviewed")),
    problems.join("\n"),
  );
});

void test("package shape check refuses a removed route, hand edits and a new derivation", () => {
  const table = JSON.parse(shapeTableText()) as ShapeTable;
  const entry = firstShapeEntry(table);
  const catalog = shapeCatalog();
  catalog.ports = (catalog.ports as Record<string, unknown>[]).filter(
    (port) => port.id !== entry.port_id,
  );
  assert.ok(
    checkShapeTable(shapeTableText(), catalog, coreShapeVersion()).some((problem) =>
      problem.includes("no longer in the catalog"),
    ),
  );
  const edited = structuredClone(table);
  firstShapeEntry(edited).shape.programs.push("zz-hand-added.exe");
  assert.ok(
    checkShapeTable(
      `${JSON.stringify(edited, null, 2)}\n`,
      shapeCatalog(),
      coreShapeVersion(),
    ).some((problem) => problem.includes("entries_sha256")),
  );
  assert.ok(
    checkShapeTable(shapeTableText(), shapeCatalog(), coreShapeVersion() + 1).some((problem) =>
      problem.includes("re-derive every entry"),
    ),
  );
  const unsorted = structuredClone(table);
  firstShapeEntry(unsorted).shape.config_files.unshift("zz.ini");
  unsorted.entries_sha256 = entriesDigest(unsorted.entries);
  assert.ok(
    checkShapeTable(
      `${JSON.stringify(unsorted, null, 2)}\n`,
      shapeCatalog(),
      coreShapeVersion(),
    ).some((problem) => problem.includes("not strictly sorted")),
  );
});

void test("recording a package shape requires a reviewed artifact and keeps canonical order", () => {
  const catalog = shapeCatalog();
  const table = JSON.parse(shapeTableText()) as ShapeTable;
  const { version: _version, reviewed_by: _reviewed, ...derived } = firstShapeEntry(table);
  assert.equal(
    recordEntry(shapeTableText(), catalog, coreShapeVersion(), derived),
    shapeTableText(),
  );
  assert.throws(
    () =>
      recordEntry(shapeTableText(), catalog, coreShapeVersion(), {
        ...derived,
        sha256: "f".repeat(64),
      }),
    /not a reviewed catalog artifact/u,
  );
  // A CLI built before a catalog edit reports the old derivation inputs.
  const port = (catalog.ports as Record<string, unknown>[]).find(
    (candidate) => candidate.id === derived.port_id,
  );
  assert.ok(port);
  port.persistent_paths = [...(port.persistent_paths as string[]), "new-state.ini"];
  assert.throws(
    () => recordEntry(shapeTableText(), catalog, coreShapeVersion(), derived),
    /rebuild the CLI/u,
  );
  assert.throws(
    () =>
      recordEntry(shapeTableText(), shapeCatalog(), coreShapeVersion(), {
        ...derived,
        derivation_inputs_sha256: "absent",
      }),
    /rebuild the CLI/u,
  );
  const reviewed = reviewedArtifacts(catalog);
  assert.ok(reviewed.every((artifact) => /^[0-9a-f]{64}$/u.test(artifact.sha256)));
  assert.equal(serializeTable(table.entries, coreShapeVersion(), reviewed), shapeTableText());
});

void test("package shape check flags changed derivation inputs and prune repairs offline", () => {
  const table = JSON.parse(shapeTableText()) as ShapeTable;
  const entry = firstShapeEntry(table);
  const catalog = shapeCatalog();
  const port = (catalog.ports as Record<string, unknown>[]).find(
    (candidate) => candidate.id === entry.port_id,
  );
  assert.ok(port);
  port.persistent_paths = [...(port.persistent_paths as string[]), "new-state.ini"];
  assert.ok(
    checkShapeTable(shapeTableText(), catalog, coreShapeVersion()).some((problem) =>
      problem.includes("catalog facts the shape derivation reads changed"),
    ),
  );
  const pruned = pruneTable(shapeTableText(), catalog, coreShapeVersion());
  assert.equal(pruned.removed.length, 1);
  assert.match(pruned.removed[0] ?? "", /derivation inputs changed/u);
  assert.deepEqual(checkShapeTable(pruned.text, catalog, coreShapeVersion()), []);
  assert.equal((JSON.parse(pruned.text) as ShapeTable).entries.length, table.entries.length - 1);
  // A current table is unchanged by pruning.
  const current = pruneTable(shapeTableText(), shapeCatalog(), coreShapeVersion());
  assert.deepEqual(current, { text: shapeTableText(), removed: [] });
});

void test("package shape prune drops unreviewed digests and adopts the catalog version", () => {
  const table = JSON.parse(shapeTableText()) as ShapeTable;
  const entry = firstShapeEntry(table);
  const catalog = shapeCatalog();
  for (const contract of record(catalog.source_catalog).contracts as Record<string, unknown>[])
    for (const row of (contract.applicability ?? []) as Record<string, unknown>[])
      if (contract.port_id === entry.port_id && row.artifact_sha256 === entry.sha256)
        row.upstream_ref = "relabelled";
  const relabelled = pruneTable(shapeTableText(), catalog, coreShapeVersion());
  assert.deepEqual(relabelled.removed, []);
  assert.deepEqual(checkShapeTable(relabelled.text, catalog, coreShapeVersion()), []);
  for (const contract of record(catalog.source_catalog).contracts as Record<string, unknown>[])
    if (contract.port_id === entry.port_id)
      contract.applicability = ((contract.applicability ?? []) as Record<string, unknown>[]).filter(
        (row) => row.artifact_sha256 !== entry.sha256,
      );
  const pruned = pruneTable(shapeTableText(), catalog, coreShapeVersion());
  assert.match(pruned.removed.join("\n"), /digest no longer reviewed/u);
  assert.deepEqual(checkShapeTable(pruned.text, catalog, coreShapeVersion()), []);
  // A derivation that also changes the component rules resets the table.
  const reset = pruneTable(
    shapeTableText(),
    shapeCatalog(),
    coreShapeVersion() + 1,
    coreShapeVersion() + 1,
  );
  assert.equal(reset.removed.length, table.entries.length);
  assert.equal((JSON.parse(reset.text) as ShapeTable).entries.length, 0);
});

// Shape version 2 (#8569): players with machine and digest; version 1 entries stay valid.
const asVersionOne = (entry: ShapeEntry): ShapeEntry => {
  const { player_candidates: _players, ...rest } = entry;
  return { ...rest, shape_version: 1 };
};

void test("package shape entries record version 2 players and version 1 entries stay valid", () => {
  const table = JSON.parse(shapeTableText()) as ShapeTable;
  assert.equal(coreShapeVersion(), 2);
  assert.equal(coreComponentRulesVersion(), 1);
  assert.equal(table.shape_version, coreShapeVersion());
  for (const entry of table.entries) {
    assert.equal(entry.shape_version, 2);
    assert.ok(entry.player_candidates?.length, `${entry.port_id} ${entry.platform}`);
    for (const player of entry.player_candidates ?? []) {
      assert.ok(entry.shape.programs.includes(player.path));
      assert.match(player.machine, /^(pe|elf32|elf64|macho)-/u);
    }
  }
  const reviewed = reviewedArtifacts(shapeCatalog());
  // One entry still at version 1 beside version 2 entries.
  const mixed = serializeTable(
    [asVersionOne(firstShapeEntry(table)), ...table.entries.slice(1)],
    coreShapeVersion(),
    reviewed,
  );
  assert.deepEqual(checkShapeTable(mixed, shapeCatalog(), coreShapeVersion()), []);
  assert.deepEqual(pruneTable(mixed, shapeCatalog(), coreShapeVersion()), {
    text: mixed,
    removed: [],
  });
  // A table written before per-entry versions prunes to version 1 entries.
  const legacy = {
    ...table,
    shape_version: 1,
    entries: table.entries.map((entry) => {
      const { shape_version: _version, ...rest } = asVersionOne(entry);
      return rest;
    }),
  };
  const converted = pruneTable(JSON.stringify(legacy), shapeCatalog(), coreShapeVersion());
  assert.deepEqual(converted.removed, []);
  assert.deepEqual(checkShapeTable(converted.text, shapeCatalog(), coreShapeVersion()), []);
  const convertedTable = JSON.parse(converted.text) as ShapeTable;
  assert.equal(convertedTable.shape_version, coreShapeVersion());
  assert.ok(convertedTable.entries.every((entry) => entry.shape_version === 1));
  assert.ok(convertedTable.entries.every((entry) => entry.player_candidates === undefined));
  // Recording re-derives one entry at version 2 and keeps the version 1 rest.
  const { version: _v, reviewed_by: _r, ...derived } = firstShapeEntry(table);
  const rerecorded = JSON.parse(
    recordEntry(converted.text, shapeCatalog(), coreShapeVersion(), derived),
  ) as ShapeTable;
  const versions = rerecorded.entries.map((entry) => entry.shape_version);
  assert.equal(versions.filter((version) => version === 2).length, 1);
  assert.equal(versions.filter((version) => version === 1).length, table.entries.length - 1);
});

void test("package shape check refuses missing, foreign or noncanonical players", () => {
  const table = JSON.parse(shapeTableText()) as ShapeTable;
  const reviewed = reviewedArtifacts(shapeCatalog());
  const problemsWith = (edit: (entry: ShapeEntry) => ShapeEntry) =>
    checkShapeTable(
      serializeTable(
        [edit(structuredClone(firstShapeEntry(table))), ...table.entries.slice(1)],
        coreShapeVersion(),
        reviewed,
      ),
      shapeCatalog(),
      coreShapeVersion(),
    ).join("\n");
  const player = (entry: ShapeEntry) => {
    const first = entry.player_candidates?.[0];
    assert.ok(first);
    return first;
  };
  assert.match(
    problemsWith(({ player_candidates: _players, ...entry }) => entry),
    /player_candidates are missing/u,
  );
  assert.match(
    problemsWith((entry) => ({ ...entry, shape_version: 1 })),
    /need derivation version 2/u,
  );
  assert.match(
    problemsWith((entry) => ({ ...entry, shape_version: 0 })),
    /outside 1\.\.2/u,
  );
  assert.match(
    problemsWith((entry) => {
      player(entry).path = "overlay_toolchain/not-a-program.exe";
      return entry;
    }),
    /not one of the shape's programs/u,
  );
  assert.match(
    problemsWith((entry) => {
      player(entry).sha256 = player(entry).sha256.toUpperCase();
      return entry;
    }),
    /64 lowercase hex/u,
  );
  assert.match(
    problemsWith((entry) => {
      player(entry).machine = "PE X86";
      return entry;
    }),
    /noncanonical machine/u,
  );
  const { version: _v, reviewed_by: _r, ...derived } = firstShapeEntry(table);
  const { player_candidates: _players, ...withoutPlayers } = derived;
  assert.throws(
    () => recordEntry(shapeTableText(), shapeCatalog(), coreShapeVersion(), withoutPlayers),
    /player_candidates are missing/u,
  );
});

void test("the scene workset distinguishes catalog, provider, and unobserved scopes", () => {
  const subject = { kind: "original" as const, game_id: "game", source_edition_id: "one" };
  const original = { id: "game", source_editions: [{ id: "one" }, { id: "two" }] };
  const direct = { kind: "port" as const, port_id: "main-port" };
  const accepted = {
    ports: [
      {
        id: "main-port",
        presentation: {
          original_game: original,
          media: [
            {
              role: "header",
              subject,
              sha256: "a".repeat(64),
              igdb: { game_id: 20, image_id: "catalogheader" },
            },
            {
              role: "screenshot",
              subject: direct,
              sha256: "b".repeat(64),
              igdb: { game_id: 11, image_id: "goneshot" },
            },
          ],
        },
      },
      { id: "retained-listing", presentation: { original_game: original } },
    ],
  };
  const preparation = {
    catalog: {
      ports: [
        {
          id: "main-port",
          presentation: { original_game: { id: "game", source_editions: [{ id: "three" }] } },
        },
        {
          id: "candidate",
          presentation: {
            media: [
              {
                role: "screenshot",
                subject: { kind: "port", port_id: "candidate" },
                sha256: "c".repeat(64),
                igdb: { game_id: 30, image_id: "proposedshot" },
              },
            ],
          },
        },
      ],
    },
    gone_image_ids: ["goneshot", "neveradmitted"],
    records: [
      {
        port_id: "main-port",
        role: "header" as const,
        subject: direct,
        provider_game_id: 11,
        reason: "provider-role-empty",
      },
      {
        port_id: "retained-listing",
        role: "header" as const,
        subject,
        provider_game_id: 21,
        reason: "media-provider-unavailable-or-incomplete",
      },
      {
        port_id: "candidate",
        role: "screenshot" as const,
        subject: { kind: "port" as const, port_id: "candidate" },
        provider_game_id: 30,
        reason: "existing-scene-retained",
        withdrawn_image_ids: ["neveradmitted"],
      },
    ],
  };
  const rows = sceneCoverage(accepted, preparation);
  const main = rows.filter((row) => row.port_id === "main-port");
  assert.equal(main.length, 8);
  assert.deepEqual(
    main.map((row) => row.state),
    ["missing", "withdrawn", "conflicting", "unknown", "unknown", "unknown", "unknown", "unknown"],
  );
  assert.deepEqual(main[1]?.withdrawn_image_ids, ["goneshot"]);
  assert.deepEqual(main[2]?.admitted_image_ids, ["catalogheader"]);
  assert.deepEqual(main[2]?.provider_game_ids, [20, 21]);
  const candidate = rows.find((row) => row.port_id === "candidate" && row.role === "screenshot");
  assert.equal(candidate?.state, "proposed");
  assert.deepEqual(candidate?.proposed_image_ids, ["proposedshot"]);
  assert.deepEqual(candidate?.withdrawn_image_ids, ["neveradmitted"]);
  assert.deepEqual(candidate?.admitted_image_ids, []);
  const listing = rows.find(
    (row) => row.port_id === "retained-listing" && row.subject.kind === "port",
  );
  assert.equal(listing?.state, "unknown");
  assert.deepEqual(listing?.reasons, ["outside-proposal-input"]);
  assert.deepEqual(
    sceneCoverage(accepted, preparation, ["retained-listing"]),
    rows.filter((row) => row.port_id === "retained-listing"),
  );
  assert.equal(sceneCoverage(accepted, { ...preparation, records: [] })[2]?.state, "admitted");
});
