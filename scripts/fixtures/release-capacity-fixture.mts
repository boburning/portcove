import { capacityDigest, slice4CapacityResourceDigest } from "../release-capacity.mts";
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
