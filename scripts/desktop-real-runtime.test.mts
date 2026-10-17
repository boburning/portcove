import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { parseRealRuntimeInput, runtimeMutable } from "./desktop-real-runtime-inputs.mts";

function input() {
  return {
    format_version: 1,
    source: path.join(os.tmpdir(), "owned-original.Z64"),
    packages: ["wave-race-64-recomp", "wave-race-64-racewave46"].map((port_id) => ({
      port_id,
      archive: path.join(os.tmpdir(), `${port_id}.zip`),
      directory: path.join(os.tmpdir(), port_id),
    })),
  };
}

void test("real runtime manifest selects both distinct retained routes without definition overrides", () => {
  assert.deepEqual(parseRealRuntimeInput(input()), input());
  const duplicate = input();
  duplicate.packages[1] = { ...duplicate.packages[0]! };
  assert.throws(() => parseRealRuntimeInput(duplicate));
  const incomplete = input();
  incomplete.packages.pop();
  assert.throws(() => parseRealRuntimeInput(incomplete));
  assert.throws(() => parseRealRuntimeInput({ ...input(), catalog_override: "unreviewed.json" }));
  const relative = input();
  relative.source = "relative-original.z64";
  assert.throws(() => parseRealRuntimeInput(relative));
  const replacement = input();
  replacement.packages[0]!.port_id = "unreviewed-other-game";
  assert.throws(() => parseRealRuntimeInput(replacement));
});

void test("mutable file accounting uses declared complete path components", () => {
  assert.equal(runtimeMutable(".runtime/wave/saved.dat", [".runtime"]), true);
  assert.equal(runtimeMutable("SAVES\\owned.bin", ["saves"]), true);
  assert.equal(runtimeMutable("general.json", ["general.json"]), true);
  assert.equal(runtimeMutable(".runtime-other/unknown.dll", [".runtime"]), false);
  assert.equal(runtimeMutable("general.json.bak", ["general.json"]), false);
  assert.equal(runtimeMutable("WaveRace64Recompiled.exe", [".runtime"]), false);
});
