import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogRoot = join(root, "crates", "portcove-core", "catalog");

test("schema-2 migration is deterministic and preserves the frozen schema-1 projection", () => {
  const result = spawnSync(process.execPath, ["scripts/migrate-catalog-schema2.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const legacy = JSON.parse(
    readFileSync(join(catalogRoot, "catalog-schema1-fixture.json"), "utf8"),
  );
  const migrated = JSON.parse(readFileSync(join(catalogRoot, "catalog.json"), "utf8"));
  assert.equal(migrated.schema_version, 2);
  assert.equal("source_profiles" in migrated, false);
  assert.equal(migrated.source_catalog.identities.length, legacy.source_profiles.length + 3);
  assert.equal(migrated.ports.length, legacy.ports.length + 3);
  assert.equal(
    migrated.source_catalog.contracts.length,
    legacy.ports.reduce(
      (count, port) =>
        count + Number(Boolean(port.source_profile)) + Number(Boolean(port.bios_source_profile)),
      0,
    ) + 3,
  );

  const profile = (id) => migrated.source_catalog.identities.find((item) => item.id === id);
  const contract = (portId) =>
    migrated.source_catalog.contracts.find(
      (item) => item.port_id === portId && item.role === "game",
    );
  assert.deepEqual(
    profile("ghostship-source")
      .variants.slice(1)
      .map((item) => item.id),
    ["super-mario-64-us", "super-mario-64-jp"],
  );
  assert.deepEqual(contract("lighthouse").supported_variant_ids, [
    "usa-rev0",
    "usa-rev1",
    "pal-rev0",
    "japan-rev0",
  ]);
  assert.deepEqual(contract("starship").supported_variant_ids, ["usa-1-0", "usa-1-1"]);
  for (const portId of [
    "ghostship",
    "lighthouse",
    "banjo-recomp",
    "shipwright",
    "2ship2harkinian",
    "zelda64-recomp",
    "starship",
  ]) {
    assert.equal(contract(portId).supported_variant_ids.includes("legacy-accepted"), false);
  }
  assert.deepEqual(contract("snap64-recomp").supported_variant_ids, ["usa-rev0"]);
  assert.equal(profile("pokemon-snap").variants[0].representations[0].kind, "canonical-n64");
  assert.deepEqual(contract("cvlod-recomp").supported_variant_ids, ["north-america"]);
  assert.equal(
    profile("castlevania-legacy-of-darkness").variants[0].representations[0].kind,
    "canonical-n64",
  );
  assert.deepEqual(contract("super-mario-bros-remastered").supported_variant_ids, [
    "europe",
    "world",
  ]);
  assert.equal(profile("super-mario-bros-nes").variants.length, 2);
  assert.equal(profile("super-mario-bros-nes").variants[0].representations[0].kind, "raw-file");
  assert.equal(
    profile("super-mario-bros-nes").variants[0].representations[0].identities[0].scope,
    "original-file",
  );
  const smbRemastered = migrated.ports.find((port) => port.id === "super-mario-bros-remastered");
  assert.deepEqual(smbRemastered.channels, ["stable"]);
  assert.equal(smbRemastered.release.provider, "direct-manifest");
  assert.equal(smbRemastered.release.direct["windows-x86-64"].size, 76214255);
  assert.equal(smbRemastered.release.direct["linux-x86-64"].size, 69254798);
  assert.equal(migrated.source_catalog.qualification.length, 3);
  assert.equal(
    migrated.source_catalog.qualification.every(
      (record) => record.scope.port_id === "snap64-recomp",
    ),
    true,
  );
});
