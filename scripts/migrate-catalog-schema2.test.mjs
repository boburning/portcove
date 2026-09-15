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
  assert.equal(migrated.source_catalog.identities.length, legacy.source_profiles.length + 4);
  assert.equal(migrated.ports.length, legacy.ports.length + 4);
  assert.equal(
    migrated.source_catalog.contracts.length,
    legacy.ports.reduce(
      (count, port) =>
        count + Number(Boolean(port.source_profile)) + Number(Boolean(port.bios_source_profile)),
      0,
    ) + 4,
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
  assert.deepEqual(contract("diddy-kong-racing-golden-balloon").supported_variant_ids, [
    "usa-rev1",
    "europe-rev1",
  ]);
  assert.deepEqual(
    profile("diddy-kong-racing-golden-balloon").variants.map((item) => item.id),
    ["usa-rev1", "europe-rev1"],
  );
  const goldenBalloon = migrated.ports.find(
    (port) => port.id === "diddy-kong-racing-golden-balloon",
  );
  assert.deepEqual(goldenBalloon.platforms, ["windows-x86-64"]);
  assert.equal(goldenBalloon.runtime_subdirectory, "GoldenBalloon");
  assert.deepEqual(goldenBalloon.runtime_mutable_paths, [
    "mdkr64.log",
    "mdkr64.prev.log",
    "mdkr64-online-failure.txt",
  ]);
  assert.deepEqual(
    goldenBalloon.runtime_mutable_paths.map(
      (relative) => `${goldenBalloon.runtime_subdirectory}/${relative}`,
    ),
    [
      "GoldenBalloon/mdkr64.log",
      "GoldenBalloon/mdkr64.prev.log",
      "GoldenBalloon/mdkr64-online-failure.txt",
    ],
  );
  assert.equal(goldenBalloon.launch_environment.MDKR_APP_PREFS_DIR, ".");
  assert.deepEqual(goldenBalloon.launch_arguments, ["--rom", "dkr-v80.z64"]);
  assert.deepEqual(contract("star-fox-enhanced").supported_variant_ids, ["usa-v1-0"]);
  const starFoxProfile = profile("star-fox-enhanced-usa-v1-0");
  assert.deepEqual(
    starFoxProfile.variants.map((item) => item.id),
    ["usa-v1-0"],
  );
  assert.deepEqual(starFoxProfile.variants[0].representations[0].identities, [
    {
      scope: "normalized-content",
      sha1: "1f5355534ccfaf26ae6c8f055f3e4768f9d72a7e",
      sha256: "3857b5294ea8f7468849437bb2d8271564e8a0ff30774622e9c872bcbd53a84d",
      crc32: null,
    },
  ]);
  const starFoxEnhanced = migrated.ports.find((port) => port.id === "star-fox-enhanced");
  assert.deepEqual(starFoxEnhanced.platforms, ["windows-x86-64"]);
  assert.deepEqual(starFoxEnhanced.channels, ["beta"]);
  assert.equal(starFoxEnhanced.adapter, "staged-source-portable");
  assert.deepEqual(starFoxEnhanced.release.asset_hints["windows-x86-64"], [
    "StarFoxEnhanced-",
    "windows-x64.zip",
  ]);
  assert.equal(starFoxEnhanced.runtime_source_filename, "Star Fox (USA).sfc");
  assert.equal(starFoxEnhanced.runtime_source_materialization, "copy");
  assert.equal(starFoxEnhanced.source_environment, "STARFOX_RETAIL_ROM");
  assert.deepEqual(starFoxEnhanced.runtime_mutable_paths, ["Starfox-Assets.BIN.tmp"]);
  assert.deepEqual(starFoxEnhanced.persistent_paths, [
    "Star Fox (USA).sfc",
    "Starfox-Assets.BIN",
    "starfox-ex.srm",
    "pregame.cfg",
    "input-bindings.cfg",
    "hud-layout.cfg",
    "states",
    "Starfox-MSU1.PAK",
  ]);
  assert.equal(migrated.source_catalog.qualification.length, 3);
  assert.equal(
    migrated.source_catalog.qualification.every(
      (record) => record.scope.port_id === "snap64-recomp",
    ),
    true,
  );
});
