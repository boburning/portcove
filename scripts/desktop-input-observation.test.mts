import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTypeScriptInNewContext as runInNewContext } from "./test-source.mts";
import { fileIdentity } from "./development-evidence.mts";
import {
  retainEvidenceInput,
  verifyConsumedInputs,
  readPrelaunchCustody,
} from "./retained-evidence.mts";

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
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const inputs =");
  const end = source.indexOf("let installFixture;", start);
  assert.ok(start >= 0 && end > start, "Read the actual production input/metadata block");
  const result = await runInNewContext(
    `(async()=>{${source.slice(start, end)}return { inputs, runnerMetadata };})()`,
    {
      custody,
      values: { "run-metadata": metadata },
      root: fileURLToPath(new URL("../", import.meta.url)),
      path,
      fileIdentity,
      readFile,
      captureDesktopReceiptInputs: () => assert.fail("Existing custody must be reused"),
    },
  );
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
