import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("rejects a TypeScript enum that drifts from the Rust transport schema", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "portcove-transport-"));
  try {
    const source = fs.readFileSync(path.join(root, "apps", "desktop", "src", "types.ts"), "utf8");
    const changed = source.replace('"remove_source" | ', "");
    assert.notEqual(changed, source, "drift fixture must change ActivityOperation");
    const fixture = path.join(temporary, "types.ts");
    fs.writeFileSync(fixture, changed);

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "check-transport-contract.mjs"), "--types", fixture],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ActivityOperation values differ/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
