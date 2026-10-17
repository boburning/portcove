import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function record(value: unknown) {
  assert.ok(isRecord(value));
  return value;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

void test("live Rust schemas and desktop command/event exposure match checked-in consumers", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "check-transport-contract.mts")],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /desktop command\/event exposure match Rust/);
  if (process.platform === "win32")
    assert.match(result.stdout, /Headless Desktop contracts match the compiled native host/);
});

for (const contract of ["core", "desktop", "events"] as const)
  void test(`rejects ${contract} drift against its compiled Rust serialization contract`, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "portcove-transport-"));
    try {
      const filename = {
        core: "transport-schemas.generated.json",
        desktop: "transport-host-output.generated.json",
        events: "transport-host-events.generated.json",
      }[contract];
      const raw: unknown = JSON.parse(
        fs.readFileSync(path.join(root, "apps", "desktop", "src", filename), "utf8"),
      );
      const schemas = record(raw);
      if (contract === "core") {
        const size = record(
          record(record(record(record(schemas.status).$defs).ArtifactIdentity).properties).size,
        );
        assert.equal(size.type, "integer");
        size.type = "string";
      } else if (contract === "desktop") {
        const bootstrap = record(schemas.bootstrap_status);
        assert.ok(Array.isArray(bootstrap.required));
        const names: unknown[] = bootstrap.required;
        assert.ok(names.includes("error"));
        bootstrap.required = names.filter((name) => name !== "error");
      } else {
        assert.equal(record(schemas["portcove://library-changed"]).type, "null");
        record(schemas["portcove://library-changed"]).type = "string";
      }
      const fixture = path.join(temporary, "schemas.json");
      fs.writeFileSync(fixture, JSON.stringify(schemas, null, 2) + "\n");

      const result = spawnSync(
        process.execPath,
        [
          path.join(root, "scripts", "check-transport-contract.mts"),
          contract === "core"
            ? "--types"
            : contract === "desktop"
              ? "--host-types"
              : "--host-events",
          fixture,
        ],
        { cwd: root, encoding: "utf8" },
      );

      assert.equal(result.status, 1);
      assert.match(result.stderr, /Generated transport schemas differ/);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
