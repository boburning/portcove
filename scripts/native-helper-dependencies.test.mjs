import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  expandNativeHelperInputs,
  nativeHelperDependencies,
  nativeHelperFiles,
  nativeHelperSourceDependencies,
  validateNativeHelperDependencies,
  nativeHelperRoots,
  captureDesktopReceiptInputs,
} from "./native-helper-dependencies.mjs";
import { planDesktopExecution } from "./desktop-execution-plan.mjs";
import { resolveDesktopSelection } from "./desktop-scenarios.mjs";
import { fileIdentity, writeEvidence } from "./development-evidence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = "apps/desktop/scripts/";
test("actual declarations cover wrappers and every transitive conditional helper", async () => {
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

test("native wrapper imports reject added dynamic URLs and unregistered local modules", () => {
  const file = prefix + "desktop-native-confirmation.mjs";
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

test("production capture retains partial failed evidence before any native acquisition", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-missing-helper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = {
    receiptInputs: expandNativeHelperInputs([
      { kind: "executable", name: "app" },
      { kind: "file", path: prefix + "desktop-test.mjs" },
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
  const receipt = JSON.parse(await readFile(path.join(output, "evidence.json"), "utf8"));
  assert.equal(receipt.format_version, 2);
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.qualification_complete, false);
  assert(receipt.inputs.length > 1);
  assert(!receipt.inputs.some((input) => input.path === missing));
  assert.equal(receipt.executable.sha256, (await fileIdentity(process.execPath)).sha256);
  for (const input of receipt.inputs) assert.deepEqual(input, await fileIdentity(input.path));
  const failure = JSON.parse(
    await readFile(path.join(output, "input-capture-failure.json"), "utf8"),
  );
  assert.equal(failure.failed_path, missing);
  assert.equal(failure.complete, false);
  assert(failure.captured_inputs < failure.declared_inputs);
  const harness = await readFile(path.join(root, prefix + "desktop-test.mjs"), "utf8");
  assert(
    harness.indexOf("await captureDesktopReceiptInputs") <
      harness.indexOf("await acquireNativeSessionLock"),
  );
});
test("declaration check rejects undeclared, dynamic, inline and escaping imports", async (t) => {
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
test("pre-launch helper bytes are deduplicated and survive failed format-2 receipts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-helper-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = planDesktopExecution(
    resolveDesktopSelection({ scenarios: ["native-external-runtime-review"], platform: "win32" }),
  );
  const selected = plan.receiptInputs.filter((input) =>
    Object.hasOwn(nativeHelperDependencies, input.path),
  );
  assert.equal(selected.length, Object.keys(nativeHelperDependencies).length);
  const expanded = expandNativeHelperInputs([...selected, ...selected]);
  assert.equal(new Set(expanded.map((input) => input.path)).size, expanded.length);
  const inputs = await Promise.all(
    expanded.map((input) => fileIdentity(path.join(root, input.path))),
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
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.format_version, 2);
  assert.equal(receipt.outcome, "failed");
  assert.deepEqual(receipt.inputs, inputs);
});
