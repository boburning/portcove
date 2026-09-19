import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  combineTransportSchemas,
  renderTransportTypes,
} from "../apps/desktop/scripts/generate-transport-types.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps", "desktop");
const require = createRequire(path.join(desktop, "package.json"));

test("schema composition rejects conflicting definitions and external references", async () => {
  const first = { type: "object", $defs: { Value: { type: "string" } } };
  assert.throws(
    () =>
      combineTransportSchemas({
        first,
        second: { ...first, $defs: { Value: { type: "number" } } },
      }),
    /disagree about Value/,
  );
  await assert.rejects(
    renderTransportTypes({
      remote: { $ref: "https://example.invalid/forbidden-schema" },
    }),
  );
  await assert.rejects(renderTransportTypes({ local: { $ref: "file:///forbidden-schema.json" } }));
});

test("one batched frontend compiler invocation rejects every maintained transport drift", () => {
  const work = path.join(root, "work");
  fs.mkdirSync(work, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(work, "transport-compiler-"));
  try {
    const types = path.join(desktop, "src", "types").replaceAll("\\", "/");
    const fixture = path.join(temporary, "fixture.ts");
    const config = path.join(temporary, "tsconfig.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        files: [fixture],
      }),
    );
    const prelude = `import type { InstallRecord, PortStatus, SourceDiscoveryRequest, SourceInspectionReport, OperationEvent, BootstrapStatus, InstallInput, LaunchResult, DesktopEventPayloads } from ${JSON.stringify(types)};
declare const install: InstallRecord;
declare const status: PortStatus;
declare const bootstrap: BootstrapStatus;
declare const inspection: NonNullable<SourceInspectionReport["inspection"]>;
const installRequest: InstallInput = { portId: "port", stage: false };
const request: SourceDiscoveryRequest = { roots: ["owned/source"], profile_ids: [] };
const nullable: PortStatus = { ...status, active: null };
const valid: InstallRecord = { ...install, artifact: { ...install.artifact, size: 2 } };
const libraryChanged: DesktopEventPayloads["portcove://library-changed"] = null;
`;
    const packagePath = require.resolve("typescript/package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const compiler = path.resolve(path.dirname(packagePath), packageJson.bin.tsc);
    let compilerInvocations = 0;
    function compile(source) {
      compilerInvocations += 1;
      fs.writeFileSync(fixture, source);
      const result = spawnSync(process.execPath, [compiler, "--project", config], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      assert.ifError(result.error);
      return result;
    }
    const valid = compile(prelude);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    const failureLine = prelude.split("\n").length;
    const cases = [
      {
        name: "missing optional-host field",
        source:
          "const { error, ...missingError } = bootstrap; const badHostPresence: BootstrapStatus = missingError;",
      },
      {
        name: "wrong host field casing",
        source: 'const badHostCasing: LaunchResult = { process_id: null, session_id: "session" };',
      },
      {
        name: "wrong request scalar",
        source: 'const badRequest: InstallInput = { portId: "port", stage: "false" };',
      },
      {
        name: "wrong nested scalar",
        source:
          'const badScalar: InstallRecord = { ...install, artifact: { ...install.artifact, size: "2" } };',
      },
      {
        name: "unexpected null",
        source: "const badNull: InstallRecord = { ...install, selected_executable: null };",
      },
      {
        name: "missing required field",
        source:
          "const { active, ...missingActive } = status; const badPresence: PortStatus = missingActive;",
      },
      {
        name: "wrong array member",
        source:
          'const badArray: NonNullable<SourceInspectionReport["inspection"]> = { ...inspection, components: ["component"] };',
      },
      {
        name: "wrong enum member",
        source: 'const badEnum: InstallRecord = { ...install, channel: "invented" };',
      },
      {
        name: "wrong union branch",
        source:
          'const badUnion: OperationEvent = { schema_version: 2, operation_id: "test", parent_operation_id: null, target: null, sequence: 1, timestamp_ms: 1, operation: "test", type: "progress", result: "succeeded" };',
      },
      {
        name: "invented unit-event content",
        source:
          'const badLibraryEvent: DesktopEventPayloads["portcove://library-changed"] = "changed";',
      },
      {
        name: "wrong event payload",
        source:
          'const badNotice: DesktopEventPayloads["portcove://application-update-notice"] = { revision: "1", notice: null };',
      },
    ];

    const invalid = compile(prelude + cases.map(({ source }) => source).join("\n") + "\n");
    assert.notEqual(invalid.status, 0, "Compiler accepted every invalid transport fixture");
    for (const [index, fixtureCase] of cases.entries()) {
      assert.match(
        invalid.stdout,
        new RegExp(`fixture\\.ts\\(${failureLine + index},\\d+\\): error TS\\d+`),
        `Compiler did not reject ${fixtureCase.name}`,
      );
    }
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /Cannot find module|excessively deep/);
    assert.equal(compilerInvocations, 2, "expected one positive and one batched negative compile");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
