import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogRoot = join(root, "crates", "portcove-core", "catalog");

test("schema-2 catalog is the deterministic complete projection of the frozen schema-1 fixture", () => {
  const result = spawnSync(process.execPath, ["scripts/migrate-catalog-schema2.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const legacy = JSON.parse(readFileSync(join(catalogRoot, "catalog-schema1-fixture.json"), "utf8"));
  const migrated = JSON.parse(readFileSync(join(catalogRoot, "catalog.json"), "utf8"));
  assert.equal(migrated.schema_version, 2);
  assert.equal("source_profiles" in migrated, false);
  assert.equal(migrated.source_catalog.identities.length, legacy.source_profiles.length);
  assert.equal(migrated.ports.length, legacy.ports.length);
  assert.equal(
    migrated.source_catalog.contracts.length,
    legacy.ports.reduce(
      (count, port) => count + Number(Boolean(port.source_profile)) + Number(Boolean(port.bios_source_profile)),
      0,
    ),
  );
});
