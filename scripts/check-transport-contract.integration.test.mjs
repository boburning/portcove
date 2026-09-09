import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("rejects nested scalar drift against the compiled Rust serialization contract", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "portcove-transport-"));
  try {
    const schemas = JSON.parse(fs.readFileSync(path.join(root, "apps", "desktop", "src", "transport-schemas.generated.json"), "utf8"));
    assert.equal(schemas.status.$defs.ArtifactIdentity.properties.size.type, "integer");
    schemas.status.$defs.ArtifactIdentity.properties.size.type = "string";
    const fixture = path.join(temporary, "schemas.json");
    fs.writeFileSync(fixture, JSON.stringify(schemas, null, 2) + "\n");

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "check-transport-contract.mjs"), "--types", fixture],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Generated transport schemas differ/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
