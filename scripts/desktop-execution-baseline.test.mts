import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import baseline, { decodeDesktopExecutionBaseline } from "./desktop-execution-baseline.mts";
import { isRecord } from "./runtime-values.mts";

const fixture = () => {
  const input: unknown = JSON.parse(
    readFileSync(new URL("./testdata/desktop-execution-baseline.json", import.meta.url), "utf8"),
  );
  assert.ok(isRecord(input));
  return input;
};

void test("compacted oracle retains the independently reviewed full JSON identity", () => {
  assert.equal(
    createHash("sha256").update(JSON.stringify(baseline)).digest("hex"),
    "5ff0451a9a941cef695f6502575870f20218511f017c7c6d1e9b49f812e48876",
  );
  assert.equal(baseline.rows.length, 222);
  assert.equal(baseline.provenance.length, 6);
  const failures = baseline.rows.filter((row) => row.selection_error);
  assert.equal(failures.length, 20);
  assert.equal(new Set(failures.map((row) => row.selection_error)).size, 8);
  assert.equal(baseline.starting_main, "a9e3db4e6cd9fd41111b58705e4fa54790eb57d7");
});

void test("changed historical outcomes and malformed dictionary references cannot establish the oracle", () => {
  for (const data of [
    { string_array: -1 },
    { string_array: 10000 },
    { string_array: 0.5 },
    { string_array: 0, extra: true },
    undefined,
  ])
    assert.throws(() => decodeDesktopExecutionBaseline({ ...fixture(), data }));
  const changed = fixture();
  assert.ok(isRecord(changed.data));
  changed.data.starting_main = "b".repeat(40);
  assert.throws(() => decodeDesktopExecutionBaseline(changed), /independently retained/);
  assert.throws(
    () => decodeDesktopExecutionBaseline({ ...fixture(), shared_string_arrays: [[42]] }),
    /string array/,
  );
  assert.throws(
    () => decodeDesktopExecutionBaseline({ ...fixture(), original_sha256: "0".repeat(64) }),
    /envelope/,
  );
});

void test("dictionary decoding retains separate mutable arrays in the original JSON tree", () => {
  const decoded = decodeDesktopExecutionBaseline(fixture());
  const arrays: string[][] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      if (value.length && value.every((item: unknown): item is string => typeof item === "string"))
        arrays.push(value);
      else for (const item of value) visit(item);
    } else if (isRecord(value)) for (const item of Object.values(value)) visit(item);
  };
  visit(decoded);
  assert.equal(arrays.length, 2760);
  assert.equal(new Set(arrays).size, arrays.length);
  const seen = new Map<string, string[]>();
  let checked = false;
  for (const entry of arrays) {
    const key = JSON.stringify(entry);
    const previous = seen.get(key);
    if (previous) {
      const original = [...entry];
      previous.push("synthetic mutation");
      assert.deepEqual(entry, original);
      checked = true;
      break;
    }
    seen.set(key, entry);
  }
  assert.equal(checked, true);
  assert.equal(
    createHash("sha256").update(JSON.stringify(baseline)).digest("hex"),
    "5ff0451a9a941cef695f6502575870f20218511f017c7c6d1e9b49f812e48876",
  );
});
