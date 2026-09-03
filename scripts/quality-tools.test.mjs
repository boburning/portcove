import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  findStaleConsumerPins,
  githubOutputs,
  validateQualityManifest,
} from "./quality-tools.mjs";

const manifest = JSON.parse(await readFile(new URL("../.github/quality-tools.json", import.meta.url)));

test("quality manifest owns exact unique pins and workflow outputs", () => {
  assert.doesNotThrow(() => validateQualityManifest(manifest));
  assert.deepEqual(githubOutputs(manifest), {
    required_prebuilt: "just@1.58.0,cargo-shear@1.13.4,cargo-deny@0.20.2,cargo-modules@0.27.0",
    required_all: "just@1.58.0,cargo-shear@1.13.4,cargo-deny@0.20.2,cargo-modules@0.27.0,rscheck-cli@0.1.0",
    rscheck_spec: "rscheck-cli@0.1.0",
    semdup_spec: "semdup@0.2.0",
    hawk_version: "0.1.13",
    hawk_rust: "1.98.0",
  });
});

test("stale consumer detection rejects copied current or divergent pins", () => {
  assert.deepEqual(findStaleConsumerPins(manifest, { clean: "tool: ${{ steps.pins.outputs.required }}" }), []);
  assert.deepEqual(findStaleConsumerPins(manifest, { stale: "tool: cargo-deny@0.20.2,cargo-deny@0.19.0" }), [
    "stale:1 duplicates cargo-deny pin 0.20.2",
    "stale:1 duplicates cargo-deny pin 0.19.0",
  ]);
  assert.deepEqual(findStaleConsumerPins(manifest, { copied: "cargo +1.98.0 hawk --version" }), [
    "copied:1 duplicates cargo-hawk pin 1.98.0",
  ]);
});
