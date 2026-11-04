import { capacityDigest, slice4CapacityResourceDigest } from "../release-capacity.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { controllerNodeVersion } from "../controller-node-runtime.mts";

/** Preserve the dated reviewed bytes; project only its one shared Node anchor. */
export function controllerWorkflowAtCurrentNode(historical: string) {
  // Exact pre-Node proposal from main37e74171, distinct from older resource observations.
  assert.equal(
    createHash("sha256").update(historical).digest("hex"),
    "1f99d082d4d2f9865a46bbb576ee05e4acbf05a25890a09b0df6478f1c58938c",
  );
  const original = "          node-version: 24.22.2\n";
  assert.equal(historical.split(original).length, 2);
  assert.match(controllerNodeVersion, /^\d+\.\d+\.\d+$/u);
  return historical.replace(original, `          node-version: ${controllerNodeVersion}\n`);
}
// Supplied facts are fixture-scoped, never live provider enforcement evidence.
export function capacityFixture() {
  const boundary = {
    account_id: 43177418,
    repository_id: 1354613114,
    budget_id: "fixture-budget",
    configuration_generation: "fixture-r1",
    product: "Actions",
    scope: "account",
    budget_usd: 0,
    stop_usage: true,
    public_repository: true,
    runner_class: "standard-public",
    resource_policy_sha256: slice4CapacityResourceDigest,
  };
  return {
    schema_version: 1,
    ratification: {
      active: true,
      boundary_sha256: capacityDigest(boundary),
      resource_policy_sha256: slice4CapacityResourceDigest,
      selection: "slice4-d2-c6470ec28ba9addb0f70d9f86953322d835bb8c0",
    },
    boundary,
    operation: null,
    prior_operations: [],
  };
}
