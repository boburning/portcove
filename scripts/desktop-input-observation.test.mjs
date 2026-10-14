import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { fileIdentity } from "./development-evidence.mjs";
import { retainEvidenceInput, verifyConsumedInputs } from "./retained-evidence.mjs";

test("runner metadata stays an observation without contaminating prelaunch custody", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-input-observation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "bound-input.json");
  const metadata = path.join(directory, "runner-metadata.json");
  await writeFile(file, '{"bound":true}\n');
  await writeFile(metadata, '{"source_state":{"clean":true}}\n');
  const captured = await retainEvidenceInput({ root: path.join(directory, "retained"), file });
  const custody = { inputs: [captured] };
  const declared = [...custody.inputs];
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mjs", import.meta.url),
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
