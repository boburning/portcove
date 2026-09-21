import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogRoot = join(root, "crates", "portcove-core", "catalog");

function run(...args) {
  return spawnSync(process.execPath, ["scripts/generate-catalog.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("current schema-2 authoring deterministically owns the embedded catalog", () => {
  const result = run("--check");
  assert.equal(result.status, 0, result.stderr);

  const current = JSON.parse(
    readFileSync(join(catalogRoot, "catalog-current-authoring.json"), "utf8"),
  );
  const embedded = JSON.parse(readFileSync(join(catalogRoot, "catalog.json"), "utf8"));
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
    assert.equal(portIds.has(contract.port_id), true, contract.id);
    assert.equal(identityIds.has(contract.profile_id), true, contract.id);
    for (const evidenceId of contract.evidence_ids) {
      assert.equal(evidenceIds.has(evidenceId), true, `${contract.id}: ${evidenceId}`);
    }
  }
});

test("semantic comparison reports every historical-to-current difference", () => {
  const result = run("--compare-historical");
  assert.equal(result.status, 0, result.stderr);
  const comparison = JSON.parse(result.stdout);
  assert.equal(typeof comparison.equal, "boolean");
  assert.match(comparison.historical_sha256, /^[0-9a-f]{64}$/u);
  assert.match(comparison.current_sha256, /^[0-9a-f]{64}$/u);
  assert.ok(Array.isArray(comparison.differences));
  assert.equal(comparison.equal, comparison.differences.length === 0);
  for (const difference of comparison.differences) assert.match(difference.path, /^\$/u);
});
