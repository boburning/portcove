import { isRecord } from "./runtime-values.mts";
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return (value as unknown[]).map(record);
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
import { checkNodeSource } from "./check-node-source.mts";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { verifyConsumedInputs } from "./retained-evidence.mts";
import {
  expandNativeHelperInputs,
  nativeHelperDependencies,
  nativeHelperFiles,
  nativeHelperSourceDependencies,
  validateNativeHelperDependencies,
  nativeHelperRoots,
  nativeHelperSharedSources,
  captureDesktopReceiptInputs,
} from "./native-helper-dependencies.mts";
import { planDesktopExecution, nativeTransportReceiptSources } from "./desktop-execution-plan.mts";
import { resolveDesktopSelection } from "./desktop-scenarios.mts";
import { fileIdentity, writeEvidence } from "./development-evidence.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = "apps/desktop/scripts/";
void test("native TypeScript dependencies follow erased versus executed imports", () => {
  const file = prefix + "desktop-native-confirmation.mts";
  assert.deepEqual(
    nativeHelperSourceDependencies(file, 'import type { Input } from "./check-only.mts";'),
    [],
  );
  for (const source of [
    'import { value } from "./unregistered.mts";',
    'import { type Input } from "./unregistered.mts";',
    'import("./unregistered.mts");',
    "new URL(dynamicPath, import.meta.url);",
    "enum RuntimeTransform { Unsupported }",
  ])
    assert.throws(() => nativeHelperSourceDependencies(file, source));
});
void test("GTK picker runtime imports are explicit and its source is a captured native input", async () => {
  const file = prefix + "native-linux-folder-picker.py";
  const source = await readFile(path.join(root, file), "utf8");
  assert.deepEqual(nativeHelperSourceDependencies(file, source), []);
  assert.ok(nativeHelperFiles(nativeHelperRoots).includes(file));
  for (const extra of [
    "\nimport foreign_helper\n",
    "\nfrom .foreign import picker\n",
    "\n__import__('foreign')\n",
    "\nexec('import foreign')\n",
  ])
    assert.throws(
      () => nativeHelperSourceDependencies(file, source + extra),
      /Unsupported|Undeclared/,
    );
});
void test("actual declarations cover wrappers and every transitive conditional helper", async () => {
  await validateNativeHelperDependencies({ root });
  const files = nativeHelperFiles(nativeHelperRoots);
  assert.equal(files.length, Object.keys(nativeHelperDependencies).length);
  for (const name of [
    "native-process-tree.ps1",
    "native-window-discovery.ps1",
    "native-confirmation.ps1",
    "native-session.ps1",
    "native-startup-observation.ps1",
  ])
    assert(files.includes(prefix + name));
});

void test("native wrapper imports reject added dynamic URLs and unregistered local modules", () => {
  const file = prefix + "desktop-native-confirmation.mts";
  const literal = 'new URL("./native-confirmation.ps1", import.meta.url);';
  for (const extra of [
    "new URL(helperVariable, import.meta.url)",
    'new URL("./" + helperVariable, import.meta.url)',
    'import { extra } from "./unregistered-helper.mjs";',
    'import "./unregistered-helper.mjs";',
    'import "../outside.mjs";',
    'export { extra } from "../outside.mjs";',
    'import "/outside.mjs";',
    'import "C:/outside.mjs";',
    'import "file:///outside.mjs";',
    "await import(variable)",
  ])
    assert.throws(
      () => nativeHelperSourceDependencies(file, literal + extra),
      /Unsupported|Undeclared|Escaping/,
    );
});

void test("production capture retains partial failed evidence before any native acquisition", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-missing-helper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = {
    receiptInputs: expandNativeHelperInputs([
      { kind: "executable", name: "app" },
      { kind: "file", path: prefix + "desktop-test.mts" },
    ]),
    selection: { selected_scenarios: ["native-fixture"] },
  };
  for (const input of plan.receiptInputs.filter((input) => input.kind === "file")) {
    const destination = path.join(directory, input.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, input.path), destination);
  }
  const missing = path.join(directory, prefix + "native-window-discovery.ps1");
  await rm(missing);
  const output = path.join(directory, "failed");
  await mkdir(output);
  await assert.rejects(
    captureDesktopReceiptInputs({
      root: directory,
      values: { app: process.execPath },
      plan,
      output,
      revision: "a".repeat(40),
    }),
    /ENOENT/,
  );
  const receipt = record(JSON.parse(await readFile(path.join(output, "evidence.json"), "utf8")));
  assert.equal(receipt.format_version, 2);
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.qualification_complete, false);
  const captured = records(receipt.inputs);
  assert(captured.length > 1);
  assert(!captured.some((input) => input.path === missing));
  assert.equal(record(receipt.executable).sha256, (await fileIdentity(process.execPath)).sha256);
  for (const input of captured) assert.deepEqual(input, await fileIdentity(text(input.path)));
  const failure = record(
    JSON.parse(await readFile(path.join(output, "input-capture-failure.json"), "utf8")),
  );
  assert.equal(failure.failed_path, missing);
  assert.equal(failure.complete, false);
  assert(
    typeof failure.captured_inputs === "number" && typeof failure.declared_inputs === "number",
  );
  assert(failure.captured_inputs < failure.declared_inputs);
  const harness = await readFile(path.join(root, prefix + "desktop-test.mts"), "utf8");
  assert(
    harness.indexOf("await captureDesktopReceiptInputs") <
      harness.indexOf("await acquireNativeSessionLock"),
  );
});
void test("declaration check rejects undeclared, dynamic, inline and escaping imports", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-helper-deps-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, prefix), { recursive: true });
  const file = prefix + "fixture.ps1";
  const registry = { [file]: [] };
  for (const source of [
    ". (Join-Path $PSScriptRoot 'undeclared.ps1')",
    ". $dynamic",
    "if ($true) { . $dynamic }",
    ". (Join-Path $PSScriptRoot '../escape.ps1')",
  ]) {
    await writeFile(path.join(directory, file), source);
    await assert.rejects(
      validateNativeHelperDependencies({ root: directory, registry }),
      /mismatch|Unsupported|Escaping/,
    );
  }
  await rm(path.join(directory, file));
  await assert.rejects(validateNativeHelperDependencies({ root: directory, registry }), /ENOENT/);
  assert.throws(
    () => nativeHelperFiles([prefix + "fixture.ps1"], { [file]: ["../escape.ps1"] }),
    /Unsafe/,
  );
  assert.throws(
    () =>
      nativeHelperSourceDependencies(
        prefix + "fixture.mjs",
        'new URL("../escape.ps1", import.meta.url)',
        registry,
      ),
    /Escaping/,
  );
});
void test("pre-launch helper bytes are deduplicated and survive failed format-2 receipts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-helper-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = planDesktopExecution(
    resolveDesktopSelection({ scenarios: ["native-external-runtime-review"], platform: "win32" }),
  );
  const selected = plan.receiptInputs.filter(
    (input) => input.kind === "file" && Object.hasOwn(nativeHelperDependencies, input.path),
  );
  assert.equal(selected.length, Object.keys(nativeHelperDependencies).length);
  const expanded = expandNativeHelperInputs([...selected, ...selected]);
  assert.equal(new Set(expanded.map((input) => input.path)).size, expanded.length);
  const inputs = await Promise.all(
    expanded.map((input) => {
      assert.ok(input.kind === "file");
      return fileIdentity(path.join(root, input.path));
    }),
  );
  for (const input of inputs)
    assert.equal(
      input.sha256,
      createHash("sha256")
        .update(await readFile(input.path))
        .digest("hex"),
    );
  const executable = process.execPath;
  const receiptPath = path.join(directory, "evidence.json");
  await writeEvidence(directory, {
    revision: "a".repeat(40),
    executable,
    checks: [{ scenario: "helper-failure", outcome: "failed" }],
    setupChecks: [],
    artifacts: [],
    inputs,
    method: "unit-fixture",
    context: {},
  });
  const receipt = record(JSON.parse(await readFile(receiptPath, "utf8")));
  assert.equal(receipt.format_version, 2);
  assert.equal(receipt.outcome, "failed");
  assert.deepEqual(receipt.inputs, inputs);
});

void test("native parser accepts erasable types and rejects runtime transformations without executing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-typescript-"));
  const file = path.join(root, "fixture.mts");
  try {
    await writeFile(file, "const value: string = 'valid'; throw new Error('must not execute');");
    assert.doesNotThrow(() => checkNodeSource(file));
    await writeFile(file, "enum Invalid { A }");
    assert.throws(() => checkNodeSource(file), { code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" });
    await writeFile(file, "const value: = 'invalid';");
    assert.throws(() => checkNodeSource(file), { code: "ERR_INVALID_TYPESCRIPT_SYNTAX" });
    await writeFile(file, "const duplicate = 1; const duplicate = 2;");
    assert.throws(() => checkNodeSource(file), /already been declared/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("native receipts include the admission runtime and containment reproduction sources", () => {
  const plan = planDesktopExecution(
    resolveDesktopSelection({ scenarios: ["native-external-runtime-review"], platform: "win32" }),
  );
  const files = new Set(
    plan.receiptInputs.filter((input) => input.kind === "file").map((input) => input.path),
  );
  for (const file of [
    "resource-command.mts",
    "resource-capacity.mts",
    "resource-paths.mts",
    "fallow-source.mts",
    "run-rust-tests.mts",
    "rust-support-cache.mts",
    "ci-metrics.mts",
    "validation-plan.mts",
    "nextest-equivalence.mts",
    "report-summary.mts",
    "bounded-summary.mts",
    "fallow-summary.mts",
    "heavy-rust-test-lock.mts",
    "process-lock.mts",
    "tool-cache.mts",
    "rust-test-tree-supervisor.mts",
    "fixtures/windows-process-tree-supervisor.rs.txt",
    "fixtures/linux-process-tree-reaper.rs.txt",
  ])
    assert.ok(files.has(`scripts/${file}`), `Missing trusted verifier source ${file}`);
});

void test("missing admission source retains failed capture and resource mutation refuses consumption", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-resource-custody-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = {
    receiptInputs: expandNativeHelperInputs([
      { kind: "executable", name: "app" },
      { kind: "file", path: prefix + "desktop-test.mts" },
    ]),
    selection: { selected_scenarios: ["native-fixture"] },
  };
  for (const input of plan.receiptInputs) {
    if (input.kind !== "file") continue;
    const destination = path.join(directory, input.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, input.path), destination);
  }
  const source = path.join(directory, "scripts/resource-command.mts");
  const retained = path.join(directory, "resource-command-retained.mts");
  await copyFile(source, retained);
  const identity = await fileIdentity(source);
  const observed = {
    ...identity,
    retained: await fileIdentity(retained),
    binding: "live-path-checked-cooperative" as const,
  };
  await verifyConsumedInputs([observed]);
  const changed = await readFile(source);
  changed[0] = changed[0] === 65 ? 66 : 65;
  await writeFile(source, changed);
  await assert.rejects(
    verifyConsumedInputs([observed]),
    /Live execution input changed after capture/,
  );
  await rm(source);
  const output = path.join(directory, "failed");
  await mkdir(output);
  await assert.rejects(
    captureDesktopReceiptInputs({
      root: directory,
      values: { app: process.execPath },
      plan,
      output,
      revision: "a".repeat(40),
    }),
    /ENOENT/,
  );
  const failure: unknown = JSON.parse(
    await readFile(path.join(output, "input-capture-failure.json"), "utf8"),
  );
  assert.ok(
    failure !== null &&
      typeof failure === "object" &&
      "failed_path" in failure &&
      "complete" in failure,
  );
  assert.equal(failure.failed_path, source);
  assert.equal(failure.complete, false);
});

void test("native receipt capture binds schema validation and reproduction inputs for every harness selection", async (t) => {
  const preparation = new URL(
    "../apps/desktop/scripts/desktop-preparation-test.mts",
    import.meta.url,
  );
  const executed = stripTypeScriptTypes(await readFile(preparation, "utf8"), { mode: "strip" });
  const identityImport = [
    ...executed.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gu),
  ].find((match) => match[1]?.split(",").some((name) => name.trim() === "gameTitle"))?.[2];
  assert.ok(
    identityImport,
    "The actual preparation caller must execute the display-identity import",
  );
  assert.equal(
    fileURLToPath(new URL(identityImport, preparation)),
    path.join(root, "apps/desktop/src/port-identity.ts"),
  );
  const expected = [
    "apps/desktop/scripts/desktop-scenario-state.mts",
    "apps/desktop/scripts/transport-values.mts",
    "apps/desktop/src/port-identity.ts",
    "apps/desktop/src/transport-schemas.generated.json",
    "apps/desktop/src/transport-host-output.generated.json",
    "apps/desktop/package.json",
    "pnpm-lock.yaml",
  ];
  assert.deepEqual(nativeTransportReceiptSources, expected);
  // Metrics now decodes the admission plan through these already-loaded verifier sources.
  expected.push("scripts/validation-plan.mts", "scripts/nextest-equivalence.mts");
  for (const selection of [
    resolveDesktopSelection({ profile: "smoke", platform: "win32" }),
    resolveDesktopSelection({
      scenarios: ["native-reviewed-source-reference-removal"],
      platform: "win32",
    }),
    resolveDesktopSelection({
      scenarios: ["native-saved-folder-selected-setup"],
      platform: "linux",
    }),
  ]) {
    const plan = planDesktopExecution(selection);
    for (const source of expected)
      assert.equal(
        plan.receiptInputs.filter((input) => input.kind === "file" && input.path === source).length,
        1,
        source,
      );
  }
  // Retained custody must stay outside disposable TMP/TEMP roots from dev-storage.
  const parent = path.join(os.homedir(), ".portcove-test-fixtures");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(parent, "pcv-transport-custody-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const source of expected) {
    const destination = path.join(directory, source);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, source), destination);
  }
  const output = path.join(directory, "output");
  await mkdir(output);
  const receiptInputs = [
    { kind: "executable", name: "app" } as const,
    ...expected.map((source) => ({ kind: "file" as const, path: source })),
  ];
  const options = {
    root: directory,
    values: { app: process.execPath },
    plan: { receiptInputs, selection: { selected_scenarios: ["native-fixture"] } },
    output,
    revision: "a".repeat(40),
    retainedRoot: path.join(directory, "retained"),
    // This fixture isolates capture/verification; separate tests execute the full native helper declaration validator.
    validate: async () => [],
  };
  const inputs = await captureDesktopReceiptInputs(options);
  const retained = inputs.map((input) => {
    assert("retained" in input);
    return input;
  });
  await verifyConsumedInputs(retained);
  for (const source of expected) {
    const file = path.join(directory, source);
    const original = await readFile(file);
    const changed = Buffer.from(original);
    changed[0] = changed[0] === 65 ? 66 : 65;
    await writeFile(file, changed);
    await assert.rejects(
      verifyConsumedInputs(retained),
      /Live execution input changed after capture/,
      source,
    );
    await writeFile(file, original);
    await verifyConsumedInputs(retained);
  }
  const missing = path.join(directory, "apps/desktop/src/transport-host-output.generated.json");
  await rm(missing);
  await assert.rejects(captureDesktopReceiptInputs(options), /ENOENT/);
  const failure = record(
    JSON.parse(await readFile(path.join(output, "input-capture-failure.json"), "utf8")),
  );
  assert.equal(failure.complete, false);
  assert.equal(failure.failed_path, missing);
  const receipt = record(JSON.parse(await readFile(path.join(output, "evidence.json"), "utf8")));
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.qualification_complete, false);
});

void test("shared capture preflight is retained by helper and execution-plan custody", () => {
  const source = "apps/desktop/test/capture-target.ts";
  assert.ok(nativeHelperSharedSources.includes(source));
  const selection = resolveDesktopSelection({ scenarios: ["keyboard-layout"], platform: "win32" });
  const plan = planDesktopExecution(selection, { platform: "win32" });
  assert.ok(plan.receiptInputs.some((input) => input.kind === "file" && input.path === source));
});
