import assert from "node:assert/strict";
import test from "node:test";
import { comparisonFixture } from "../apps/desktop/src/features/recommendations/comparison-test-fixture.ts";
import {
  transportValue,
  transportValues,
  checkTransportSchemas,
} from "../apps/desktop/scripts/transport-values.mts";

const about = {
  description: "owned fixture",
  license: "MIT",
  product: "Portcove",
  repository: "https://example.invalid/owned",
  version: "1.2.3",
};
void test("all current Rust Core and host output schemas load under the actual Node validator", () => {
  assert(checkTransportSchemas() > 100);
});
void test("validated values preserve identity and metadata without coercion, defaults, or removal", () => {
  const value = { ...about, retained_metadata: { owned: true } };
  const before = structuredClone(value);
  assert.equal(transportValue("about", value), value);
  assert.deepEqual(value, before);
  assert.deepEqual(transportValues("about", [value]), [value]);
});
void test("wrong scalar, missing required, malformed collection and foreign contract values are refused", () => {
  const { version: _version, ...missing } = about;
  for (const value of [
    null,
    [],
    missing,
    { ...about, version: 3 },
    { ...about, version: ["1.2.3"] },
  ]) {
    const before = structuredClone(value);
    assert.throws(() => transportValue("about", value), /Invalid about transport/);
    assert.deepEqual(value, before);
  }
  assert.throws(() => transportValues("about", about), /transport collection/);
  assert.throws(
    () => transportValues("about", [about, { invalid: true }]),
    /Invalid about transport/,
  );
  assert.throws(() => transportValue("status", about), /Invalid status transport/);
});

void test("Rust schema numeric and enum constraints remain active", () => {
  const limits = {
    max_entries: 10,
    max_depth: 2,
    max_file_bytes: 100,
    max_hash_bytes: 1000,
    max_candidates: 5,
  };
  assert.equal(transportValue("source_discovery_limits", limits), limits);
  for (const max_depth of [-1, 1.5, "2", null])
    assert.throws(
      () => transportValue("source_discovery_limits", { ...limits, max_depth }),
      /Invalid source_discovery_limits/,
    );
  assert.equal(transportValue("source_discovery_limit", "depth"), "depth");
  assert.throws(
    () => transportValue("source_discovery_limit", "invented"),
    /Invalid source_discovery_limit/,
  );
  assert.throws(() => {
    // @ts-expect-error A foreign schema key is intentionally sent across the runtime boundary.
    return transportValue("unregistered_contract", limits);
  }, /Missing Rust transport schema/);
});

void test("Rust uint16 recommendation fields preserve integer bounds without coercion", () => {
  const raw: unknown = comparisonFixture();
  const base = transportValue("game_comparison", raw);
  const assessment = base.assessment;
  assert.ok(assessment, "fixture must exercise actual recommendation dimensions");
  const withValue = (field: string, scalar: unknown) => ({
    ...base,
    assessment: {
      ...assessment,
      candidates: assessment.candidates.map((candidate) => ({
        ...candidate,
        dimensions: candidate.dimensions.map((dimension) => ({ ...dimension, [field]: scalar })),
      })),
    },
  });
  for (const field of ["strength_permille", "weight_percent"]) {
    for (const scalar of [0, 65535]) {
      const value = withValue(field, scalar);
      assert.equal(transportValue("game_comparison", value), value);
    }
    for (const scalar of [-1, 65536, 1.5, "1000", null]) {
      const value = withValue(field, scalar);
      const before = structuredClone(value);
      assert.throws(() => transportValue("game_comparison", value), /Invalid game_comparison/);
      assert.deepEqual(value, before);
    }
  }
});
