import assert from "node:assert/strict";
import test from "node:test";
import { checkContextualDoctor } from "./checkout-context.mjs";

const snapshot = () => ({
  root: "/checkout",
  head: "a".repeat(40),
  catalog_sha256: "catalog",
  configuration_sha256: "config",
  input_dirty: false,
});
test("guarded mismatches stop before network checks", async () => {
  let calls = 0;
  const check = async () => {
    calls++;
  };
  await assert.rejects(
    checkContextualDoctor({ capture: snapshot, expectedHead: "b".repeat(40), check }),
    /Checkout mismatch/,
  );
  await assert.rejects(
    checkContextualDoctor({
      capture: () => ({ ...snapshot(), input_dirty: true }),
      expectedHead: "a".repeat(40),
      check,
    }),
    /modified/,
  );
  await assert.rejects(
    checkContextualDoctor({ capture: snapshot, expectedHead: "bad", check }),
    /full lowercase/,
  );
  assert.equal(calls, 0);
});
test("head, catalog or configuration changes invalidate success", async () => {
  for (const change of [
    { head: "b".repeat(40) },
    { catalog_sha256: "new" },
    { configuration_sha256: "new" },
    { input_dirty: true },
  ]) {
    let reads = 0;
    await assert.rejects(
      checkContextualDoctor({
        capture: () => ({ ...snapshot(), ...(reads++ ? change : {}) }),
        check: async () => "passed",
      }),
      /changed during/,
    );
  }
  assert.equal(
    (await checkContextualDoctor({ capture: snapshot, check: async () => 42 })).result,
    42,
  );
});
