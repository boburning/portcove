import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { observeReleaseResources } from "./release-resource-observation.mts";
import {
  slice4CapacityResources,
  slice4CapacityResourceDigest,
  capacityDigest,
} from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";

void test("resource observations reconcile current purposes and keep provider, billing and measured gaps separate", async () => {
  const [production, wake, candidate] = await Promise.all(
    ["application-update-production.yml", "application-update-wake.yml", "release.yml"].map(
      (name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url)),
    ),
  );
  assert.ok(production && wake && candidate);
  const result = observeReleaseResources(production, wake, candidate);
  assert.equal(result.accounting.application, 89);
  assert.equal(result.accounting.catalog_alternative, 40);
  assert.equal(result.accounting.policy_envelope, 100);
  assert.equal(result.policy_matches_workflow, true);
  assert.equal(result.accounting.measured_wall_seconds, null);
  assert.equal(result.accounting.account_headroom, "Unknown");
  assert.equal(result.accounting.reservation, null);
  assert.ok(
    result.jobs.every(
      (row) => row.observation_status === "Unknown" && row.observed_execution_seconds === null,
    ),
  );
  assert.equal(result.report_repair.maximum_minutes, 4);
  assert.equal(result.report_repair.included_in_controller_envelope, false);
  assert.equal(result.recommendations.aggregate_minutes, null);
  assert.equal(result.authority, "none");
  const changed: unknown = parse(production.toString("utf8"));
  assert.ok(isRecord(changed) && isRecord(changed.jobs));
  changed.jobs.native_windows = {
    name: "Held Windows addition",
    "runs-on": "windows-2022",
    "timeout-minutes": 12,
  };
  const next = observeReleaseResources(Buffer.from(stringify(changed)), wake, candidate);
  assert.equal(next.accounting.application, 101);
  assert.equal(next.policy_matches_workflow, false);
  assert.equal(next.ratification_required_for_policy_change, true);
  assert.equal(next.accounting.provider_availability, "Unknown");
  assert.equal(capacityDigest(slice4CapacityResources), slice4CapacityResourceDigest);
  const original: unknown = parse(production.toString("utf8"));
  assert.ok(isRecord(original) && isRecord(original.jobs));
  const catalog = structuredClone(original);
  assert.ok(isRecord(catalog.jobs));
  catalog.jobs.catalog_unbudgeted = { "runs-on": "ubuntu-22.04", "timeout-minutes": 100 };
  const incomplete = observeReleaseResources(Buffer.from(stringify(catalog)), wake, candidate);
  assert.equal(incomplete.accounting.catalog_alternative, null);
  assert.equal(incomplete.accounting.allocation_completeness.catalog, false);
  assert.equal(incomplete.accounting.declared_unused_allocation, null);
  assert.deepEqual(incomplete.accounting.unaccounted_catalog_jobs, ["catalog_unbudgeted"]);
  for (const replacement of [
    { "timeout-minutes": "${{ inputs.override || inputs.fast && 2 || 3 }}" },
    { strategy: { matrix: { platform: ["a", "b"] } } },
    { uses: "./.github/workflows/extra.yml" },
  ]) {
    const variant = structuredClone(original);
    assert.ok(isRecord(variant.jobs) && isRecord(variant.jobs.native_linux));
    variant.jobs.native_linux = { ...variant.jobs.native_linux, ...replacement };
    const unknown = observeReleaseResources(Buffer.from(stringify(variant)), wake, candidate);
    assert.equal(unknown.accounting.application, null);
    assert.equal(unknown.accounting.declared_unused_allocation, null);
    assert.equal(unknown.policy_matches_workflow, false);
  }
  const candidateVariant: unknown = parse(candidate.toString("utf8"));
  assert.ok(
    isRecord(candidateVariant) &&
      isRecord(candidateVariant.jobs) &&
      isRecord(candidateVariant.jobs.identity),
  );
  candidateVariant.jobs.identity["timeout-minutes"] =
    "${{ inputs.override || inputs.fast && 2 || 3 }}";
  assert.equal(
    observeReleaseResources(
      production,
      wake,
      Buffer.from(stringify(candidateVariant)),
    ).separate_candidate_and_repair_workflow.find((row) => row.key === "identity")
      ?.maximum_job_minutes,
    null,
  );
});
