import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { combineTransportSchemas, renderTransportTypes } from "../apps/desktop/scripts/generate-transport-types.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps", "desktop");
const require = createRequire(path.join(desktop, "package.json"));

test("schema composition rejects conflicting definitions and external references", async () => {
  const first = { type: "object", $defs: { Value: { type: "string" } } };
  assert.throws(() => combineTransportSchemas({ first, second: { ...first, $defs: { Value: { type: "number" } } } }), /disagree about Value/);
  await assert.rejects(renderTransportTypes({ remote: { $ref: "https://example.invalid/forbidden-schema" } }));
  await assert.rejects(renderTransportTypes({ local: { $ref: "file:///forbidden-schema.json" } }));
});

test("the frontend compiler rejects real nested, nullable, optional, array and union drift", () => {
  const work = path.join(root, "work");
  fs.mkdirSync(work, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(work, "transport-compiler-"));
  try {
    const types = path.join(desktop, "src", "types").replaceAll("\\", "/");
    const fixture = path.join(temporary, "fixture.ts");
    const config = path.join(temporary, "tsconfig.json");
    fs.writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" }, files: [fixture] }));
    const prelude = `import type { InstallRecord, PortStatus, SourceDiscoveryRequest, SourceInspectionReport, OperationEvent } from ${JSON.stringify(types)};
declare const install: InstallRecord;
declare const status: PortStatus;
declare const inspection: NonNullable<SourceInspectionReport["inspection"]>;
const request: SourceDiscoveryRequest = { roots: ["owned/source"], profile_ids: [] };
const nullable: PortStatus = { ...status, active: null };
const valid: InstallRecord = { ...install, artifact: { ...install.artifact, size: 2 } };
`;
    const packagePath = require.resolve("typescript/package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const compiler = path.resolve(path.dirname(packagePath), packageJson.bin.tsc);
    function compile(source) {
      fs.writeFileSync(fixture, source);
      const result = spawnSync(process.execPath, [compiler, "--project", config], { cwd: root, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true });
      assert.ifError(result.error);
      return result;
    }
    const valid = compile(prelude);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    const cases = [
      'const badScalar: InstallRecord = { ...install, artifact: { ...install.artifact, size: "2" } };',
      'const badNull: InstallRecord = { ...install, selected_executable: null };',
      'const { active, ...missingActive } = status; const badPresence: PortStatus = missingActive;',
      'const badArray: NonNullable<SourceInspectionReport["inspection"]> = { ...inspection, components: ["component"] };',
      'const badEnum: InstallRecord = { ...install, channel: "invented" };',
      'const badUnion: OperationEvent = { schema_version: 2, operation_id: "test", parent_operation_id: null, target: null, sequence: 1, timestamp_ms: 1, operation: "test", type: "progress", result: "succeeded" };',
    ];
    for (const source of cases) {
      const invalid = compile(prelude + source + "\n");
      assert.notEqual(invalid.status, 0, `Compiler accepted ${source}`);
      assert.match(invalid.stdout, /fixture\.ts\(8,\d+\): error TS\d+/);
      assert.doesNotMatch(invalid.stdout + invalid.stderr, /Cannot find module|excessively deep/);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
