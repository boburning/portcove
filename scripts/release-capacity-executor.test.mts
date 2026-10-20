import assert from "node:assert/strict";
import test from "node:test";
import { capacityExecutorIdentity, refreshCapacityExecutor } from "./release-capacity-executor.mts";

void test("serialized job claims or a copied kind cannot create an executor session", async () => {
  const imported = Object.freeze({ kind: "authenticated-capacity-executor" as const });
  assert.throws(() => capacityExecutorIdentity(imported), /actual fresh executor/u);
  await assert.rejects(refreshCapacityExecutor(imported), /imported executor/u);
});
