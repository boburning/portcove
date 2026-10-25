import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { observeDesktopHarnessInputs } from "./native-helper-dependencies.mts";
import baseline from "./fixtures/desktop-input-observation-baseline.json" with { type: "json" };
import { fileIdentity } from "./development-evidence.mts";
import {
  retainEvidenceInput,
  verifyConsumedInputs,
  readPrelaunchCustody,
} from "./retained-evidence.mts";

for (const control of baseline.cases)
  void test(`input observation preserves pre-change oracle: ${control.id}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pcv-input-oracle-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const [name, bytes] of Object.entries(baseline.files)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
    const output = path.join(root, "output");
    await mkdir(output);
    const captured = await fileIdentity(path.join(root, "bound-input.json"));
    const custody = control.custody ? { inputs: [captured] } : null;
    const before = structuredClone(custody?.inputs ?? null);
    let runMetadata: string | undefined;
    if (control.metadata !== undefined) {
      runMetadata = path.join(root, `${control.id}.json`);
      await writeFile(runMetadata, control.metadata);
    }
    if (control.relative) runMetadata = "relative.json";
    if (control.missing) runMetadata = path.join(root, "missing.json");
    let actual: Record<string, unknown>;
    try {
      const observed = await observeDesktopHarnessInputs({
        custody,
        capture: {
          root,
          values: { app: process.execPath },
          plan: {
            receiptInputs: [{ kind: "file", path: "bound-input.json" }],
            selection: { selected_scenarios: [] },
          },
          output,
          revision: "a".repeat(40),
          // Match the original oracle's isolated file-capture boundary. Separate
          // helper tests execute the default production dependency validator.
          validate: async () => [],
        },
        runMetadata,
      });
      actual = {
        outcome: "success",
        inputs: observed.inputs.map((input) => ({
          ...input,
          path: path.relative(root, input.path).replaceAll("\\", "/"),
        })),
        runnerMetadata: observed.runnerMetadata,
        custody_first_input_reused: custody ? observed.inputs[0] === captured : null,
      };
    } catch (error) {
      assert.ok(error instanceof Error);
      const code = Reflect.get(error, "code") ?? null;
      actual = {
        outcome: "failure",
        name: error.name,
        code,
        message: code === "ENOENT" ? "missing metadata file" : error.message,
      };
    }
    assert.deepEqual(custody?.inputs ?? null, before);
    assert.deepEqual({ ...actual, custody_unchanged: true }, control.expected);
  });

void test("runner metadata stays an observation without contaminating prelaunch custody", async (t) => {
  // Retained custody deliberately refuses the disposable TMP/TEMP roots supplied
  // by dev-storage. Keep this owned fixture outside those cleanup roots.
  const parent = path.join(os.homedir(), ".portcove-test-fixtures");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(parent, "pcv-input-observation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "bound-input.json");
  const metadata = path.join(directory, "runner-metadata.json");
  await writeFile(file, '{"bound":true}\n');
  await writeFile(metadata, '{"source_state":{"clean":true}}\n');
  const captured = await retainEvidenceInput({ root: path.join(directory, "retained"), file });
  const custody = { inputs: [captured] };
  const declared = [...custody.inputs];
  const result = await observeDesktopHarnessInputs({
    custody,
    capture: {
      root: fileURLToPath(new URL("../", import.meta.url)),
      values: { app: process.execPath },
      plan: { receiptInputs: [], selection: { selected_scenarios: [] } },
      output: directory,
      revision: "a".repeat(40),
      validate: async () => assert.fail("Existing custody must be reused"),
    },
    runMetadata: metadata,
  });
  assert.deepEqual(
    custody.inputs,
    declared,
    "Observation cannot enlarge the verified launch inventory",
  );
  assert.ok(
    isRecord(result) &&
      Array.isArray(result.inputs) &&
      isRecord(result.runnerMetadata) &&
      isRecord(result.runnerMetadata.source_state),
  );
  assert.equal(result.inputs.length, 2);
  assert.equal(result.inputs[0], captured);
  assert.deepEqual(result.inputs[1], await fileIdentity(metadata));
  assert.equal(result.runnerMetadata.source_state.clean, true);
  await verifyConsumedInputs(custody.inputs);
  await writeFile(file, '{"bound":null}\n');
  await assert.rejects(
    verifyConsumedInputs(custody.inputs),
    /Live execution input changed after capture/u,
    "Copying the observation list must preserve the actual byte guard",
  );
});

void test("prelaunch custody preserves diagnostic metadata and rejects malformed typed identities", async (t) => {
  const parent = path.join(os.homedir(), ".portcove-test-fixtures");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(parent, "pcv-custody-shape-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "owned-source");
  await writeFile(file, "owned custody bytes");
  const captured = await retainEvidenceInput({ root: path.join(directory, "retained"), file });
  const timestamp = new Date().toISOString();
  const manifest = {
    format_version: 1,
    root: directory,
    revision: "a".repeat(40),
    pre_import_for: "apps/desktop/scripts/desktop-test.mts",
    selected_scenarios: [],
    execution_started_at: timestamp,
    created_at: timestamp,
    observation: { retained: "raw metadata" },
    inputs: [
      {
        ...captured,
        role: "owned-source",
        observation: { reason: "diagnostic" },
        retained: { ...captured.retained, observation: "retained diagnostic" },
      },
    ],
  };
  const manifestFile = path.join(directory, "prelaunch.json");
  const options = {
    root: directory,
    revision: manifest.revision,
    plan: { receiptInputs: [{ kind: "file" as const, path: "owned-source" }] },
    values: {},
    selectedScenarios: [],
    deadlineMs: 60_000,
  };
  await writeFile(manifestFile, JSON.stringify(manifest));
  const observed = await readPrelaunchCustody(manifestFile, options);
  assert.deepEqual(Reflect.get(observed, "observation"), manifest.observation);
  const input = observed.inputs[0];
  assert.ok(input);
  assert.deepEqual(Reflect.get(input, "observation"), manifest.inputs[0]?.observation);
  assert.equal(Reflect.get(input.retained, "observation"), "retained diagnostic");
  const changes: Record<string, unknown>[] = [
    { ...manifest, execution_started_at: 2026 },
    { ...manifest, created_at: [timestamp] },
    {
      ...manifest,
      inputs: [
        {
          ...manifest.inputs[0],
          retained: { ...captured.retained, bytes: String(captured.bytes) },
        },
      ],
    },
    {
      ...manifest,
      inputs: [
        { ...manifest.inputs[0], retained: { ...captured.retained, sha256: [captured.sha256] } },
      ],
    },
  ];
  for (const changed of changes) {
    await writeFile(manifestFile, JSON.stringify(changed));
    await assert.rejects(readPrelaunchCustody(manifestFile, options), /timing|declaration/u);
    assert.equal(await readFile(file, "utf8"), "owned custody bytes");
    await verifyConsumedInputs([captured]);
  }
});
