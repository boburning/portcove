import { errorCode } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { vitePlusCommand } from "./viteplus-cli.mts";
import {
  combineTransportSchemas,
  renderTransportTypes,
  renderCatalogValues,
} from "../apps/desktop/scripts/generate-transport-types.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps", "desktop");

void test("described unconstrained values remain unknown without rewriting explicit object schemas", async () => {
  const schema = {
    item: {
      type: "object",
      required: ["value", "description", "record"],
      properties: {
        value: { description: "A saved scalar or a missing value." },
        description: { type: "string" },
        record: {
          type: "object",
          description: "An actual object.",
          additionalProperties: { type: "string" },
        },
      },
    },
  };
  const before = JSON.stringify(schema);
  const rendered = await renderTransportTypes(schema);
  assert.match(rendered, /value: unknown;/u);
  assert.match(rendered, /description: string;/u);
  assert.match(rendered, /\[k: string\]: string;/u);
  assert.equal(JSON.stringify(schema), before);
});

void test("schema composition rejects conflicting definitions and external references", async () => {
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

void test(
  "one batched frontend compiler invocation rejects every maintained transport drift",
  { timeout: 150_000 },
  () => {
    const work = path.join(root, "work");
    fs.mkdirSync(work, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(work, "transport-compiler-"));
    let completed = false;
    try {
      const types = path.join(desktop, "src", "types").replaceAll("\\", "/");
      const fixture = path.join(temporary, "fixture.ts");
      const config = path.join(temporary, "tsconfig.json");
      fs.writeFileSync(
        path.join(temporary, "vite.config.mjs"),
        "export default { lint: { ignorePatterns: [] } };\n",
      );
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
      const compiler = vitePlusCommand(root);
      let compilerInvocations = 0;
      function compile(source: string) {
        compilerInvocations += 1;
        fs.writeFileSync(fixture, source);
        const result = spawnSync(
          compiler.command,
          [
            ...compiler.args,
            "lint",
            "--type-aware",
            "--type-check",
            "--tsconfig",
            config,
            "--no-ignore",
            "-A",
            "all",
            "--format",
            "unix",
            fixture,
          ],
          {
            cwd: temporary,
            encoding: "utf8",
            // The measured cold Windows compile exceeded 20 seconds under shared load.
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          },
        );
        // Keep compiler evidence before asserting: cleanup must not mask its failure.
        fs.writeFileSync(
          path.join(temporary, `compiler-${compilerInvocations}.json`),
          JSON.stringify(
            {
              status: result.status,
              signal: result.signal,
              pid: result.pid,
              error: result.error && {
                message: result.error.message,
                code: errorCode(result.error),
              },
              stdout: result.stdout,
              stderr: result.stderr,
            },
            null,
            2,
          ),
        );
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
          source:
            'const badHostCasing: LaunchResult = { process_id: null, session_id: "session" };',
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
          new RegExp(`fixture\\.ts:${failureLine + index}:\\d+:.*TS\\d+`),
          `Compiler did not reject ${fixtureCase.name}`,
        );
      }
      assert.doesNotMatch(invalid.stdout + invalid.stderr, /Cannot find module|excessively deep/);
      assert.equal(
        compilerInvocations,
        2,
        "expected one positive and one batched negative compile",
      );
      completed = true;
    } finally {
      if (completed)
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      else console.error(`Transport compiler failure retained at ${temporary}`);
    }
  },
);

void test("schema composition refuses malformed inventories without asserting Rust-owned contents", () => {
  for (const value of [
    null,
    [],
    { root: null },
    { root: { $defs: [] } },
    { root: { $defs: { Value: null } } },
  ])
    assert.throws(() => combineTransportSchemas(value), /Transport schema/);
});

void test("schema composition preserves own prototype-named roots and definitions and detects their conflicts", () => {
  const schemas: unknown = JSON.parse(
    '{"__proto__":{"type":"string"},"normal":{"type":"object","$defs":{"__proto__":{"type":"number"},"constructor":{"type":"boolean"}}}}',
  );
  const combined = combineTransportSchemas(schemas);
  assert(Object.hasOwn(combined.properties, "__proto__"));
  assert(combined.required.includes("__proto__"));
  assert(Object.hasOwn(combined.$defs, "__proto__"));
  assert.deepEqual(combined.$defs.__proto__, { type: "number" });
  assert.deepEqual(combined.$defs.constructor, { type: "boolean" });
  const conflict: unknown = JSON.parse(
    '{"first":{"$defs":{"__proto__":{"type":"string"}}},"second":{"$defs":{"__proto__":{"type":"number"}}}}',
  );
  assert.throws(() => combineTransportSchemas(conflict), /disagree about __proto__/);
});

void test("small catalog inventories consume Core enums and reject incomplete schemas", () => {
  const schemas = {
    catalog: {
      $defs: {
        Platform: { enum: ["windows-x86-64"] as string[] },
        ReleaseChannel: { enum: ["stable"] },
        InstallationMethod: { enum: ["portable-package"] },
      },
    },
  };
  const rendered = renderCatalogValues(schemas);
  assert.ok(Buffer.byteLength(rendered) < 2048);
  assert.match(rendered, /windows-x86-64/);
  const next = structuredClone(schemas);
  next.catalog.$defs.Platform.enum.push("test-future-platform");
  assert.match(renderCatalogValues(next), /test-future-platform/);
  assert.doesNotMatch(rendered, /test-future-platform/);
  delete (next.catalog.$defs as Partial<typeof next.catalog.$defs>).Platform;
  assert.throws(() => renderCatalogValues(next), /unique string enum/);
});
