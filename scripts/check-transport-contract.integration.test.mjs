import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const contract of ["core", "desktop"]) test(`rejects ${contract} drift against its compiled Rust serialization contract`, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "portcove-transport-"));
  try {
    const filename = contract === "core" ? "transport-schemas.generated.json" : "transport-host-output.generated.json";
    const schemas = JSON.parse(fs.readFileSync(path.join(root, "apps", "desktop", "src", filename), "utf8"));
    if (contract === "core") {
      assert.equal(schemas.status.$defs.ArtifactIdentity.properties.size.type, "integer");
      schemas.status.$defs.ArtifactIdentity.properties.size.type = "string";
    } else {
      assert.ok(schemas.bootstrap_status.required.includes("error"));
      schemas.bootstrap_status.required = schemas.bootstrap_status.required.filter(name => name !== "error");
    }
    const fixture = path.join(temporary, "schemas.json");
    fs.writeFileSync(fixture, JSON.stringify(schemas, null, 2) + "\n");

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "check-transport-contract.mjs"), contract === "core" ? "--types" : "--host-types", fixture],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Generated transport schemas differ/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
