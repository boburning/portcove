import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
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

void test("measured resource amendment remains concrete, complete and unratified under effective100", async () => {
  const proposal = JSON.parse(
    await readFile(
      new URL(
        "../docs/qualification/slice4-resource-amendment-proposal-2026-10-29.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    status: string;
    authority: string;
    source_scope: { current_workflow_sha256: string; current_policy_sha256: string };
    proposed_policy: {
      application_minutes: number;
      catalog_alternative_minutes: number;
      hard_cap_minutes: number;
    };
    jobs: { job: string; effective_minutes: number | null; proposed_minutes: number }[];
    allocations: Record<string, Record<string, number>>;
    prepared_source: {
      proposed_workflow_sha256: string;
      proposed_resource_digest: string;
      effective_policy_digest: string;
    };
    historical_proposal: { path: string; sha256: string; application_minutes: number };
  };
  assert.equal(proposal.status, "PROPOSAL ONLY; NOT RATIFIED");
  assert.equal(proposal.authority, "none");
  const constraint = (
    proposal as unknown as {
      windows_owner_constraint: {
        effective_total_milliseconds: number;
        full_signing_job_maximum_milliseconds: number;
        job_ceiling_does_not_extend_owner: boolean;
        full_signing_wait_fit: string;
      };
    }
  ).windows_owner_constraint;
  assert.equal(constraint.effective_total_milliseconds, 570000);
  assert.equal(constraint.full_signing_job_maximum_milliseconds, 600000);
  assert.equal(constraint.job_ceiling_does_not_extend_owner, true);
  assert.match(constraint.full_signing_wait_fit, /^Unknown/u);
  const linux = (
    proposal as unknown as {
      linux_owner_constraint: {
        effective_total_milliseconds: number;
        full_signing_job_maximum_milliseconds: number;
        job_ceiling_does_not_extend_owner: boolean;
        full_signing_wait_fit: string;
      };
    }
  ).linux_owner_constraint;
  assert.equal(linux.effective_total_milliseconds, 570000);
  assert.equal(linux.full_signing_job_maximum_milliseconds, 600000);
  assert.equal(linux.job_ceiling_does_not_extend_owner, true);
  assert.match(linux.full_signing_wait_fit, /^Unknown/u);

  assert.equal(slice4CapacityResources.total_job_minutes, 100);
  assert.equal(proposal.proposed_policy.application_minutes, 165);
  assert.equal(proposal.proposed_policy.hard_cap_minutes, 165);
  assert.equal(proposal.proposed_policy.catalog_alternative_minutes, 40);
  assert.equal(proposal.allocations.tool_bootstrap_windows?.build_tools, 6);
  assert.equal(proposal.allocations.tool_bootstrap_windows?.total, 22);
  const historical = await readFile(
    new URL("../" + proposal.historical_proposal.path, import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(historical).digest("hex"),
    proposal.historical_proposal.sha256,
  );
  assert.equal(proposal.historical_proposal.application_minutes, 163);
  const originalProposal: unknown = JSON.parse(historical.toString("utf8"));
  assert.ok(isRecord(originalProposal) && isRecord(originalProposal.proposed_policy));
  assert.equal(originalProposal.proposed_policy.application_minutes, 163);
  assert.equal(proposal.prepared_source.effective_policy_digest, slice4CapacityResourceDigest);
  const workflow = await readFile(
      new URL("../.github/workflows/application-update-production.yml", import.meta.url),
    ),
    actual = parse(workflow.toString()) as { jobs: Record<string, { "timeout-minutes": number }> };
  assert.deepEqual(
    proposal.jobs.map((row) => row.job).sort(),
    [
      ...Object.keys(actual.jobs).filter((name) => !name.startsWith("catalog_")),
      "native_windows",
      "wake",
    ].sort(),
  );
  assert.equal(
    proposal.jobs.reduce((sum, row) => sum + row.proposed_minutes, 0),
    165,
  );
  for (const row of proposal.jobs) {
    assert.equal(
      row.effective_minutes,
      row.job === "wake" ? 1 : (actual.jobs[row.job]?.["timeout-minutes"] ?? null),
    );
    assert.ok(Number.isSafeInteger(row.proposed_minutes) && row.proposed_minutes > 0);
  }
  for (const allocation of Object.values(proposal.allocations))
    assert.equal(
      Object.entries(allocation)
        .filter(([name]) => name !== "total")
        .reduce((sum, [, value]) => sum + value, 0),
      allocation.total,
    );
  assert.equal(
    proposal.source_scope.current_workflow_sha256,
    createHash("sha256").update(workflow).digest("hex"),
  );
  assert.equal(
    proposal.source_scope.current_policy_sha256,
    createHash("sha256")
      .update(await readFile(new URL("./release-capacity.mts", import.meta.url)))
      .digest("hex"),
  );
});

void test("complete source amendment projects application165/catalog40 without activating policy or native execution", async () => {
  const { prepareReleaseResourceAmendmentProposal: prepare } =
      await import("./release-resource-amendment-proposal.mts"),
    {
      protectedWindowsNativeRuntimePreparationExecutionAuthorized,
      prepareAdmittedWindowsNativeRuntime,
    } = await import("./release-windows-bootstrap-runtime.mts");
  const [production, wake, candidate] = await Promise.all(
    ["application-update-production.yml", "application-update-wake.yml", "release.yml"].map(
      (name) => readFile(new URL("../.github/workflows/" + name, import.meta.url)),
    ),
  );
  assert.ok(production && wake && candidate);
  const original = Buffer.from(production),
    result = prepare(production, wake, candidate);
  assert.ok(production.equals(original));
  assert.equal(result.proposal.authority, "none");
  assert.equal(result.proposal.status, "PROPOSAL ONLY; NOT RATIFIED");
  assert.equal(result.proposal.observation.accounting.application, 165);
  assert.equal(result.proposal.observation.accounting.catalog_alternative, 40);
  assert.equal(result.proposal.observation.accounting.policy_envelope, 100);
  assert.equal(slice4CapacityResources.total_job_minutes, 100);
  assert.equal(result.proposal.proposed_resources.total_job_minutes, 165);
  assert.equal(
    result.proposal.proposed_resource_digest,
    capacityDigest(result.proposal.proposed_resources),
  );
  assert.equal(result.proposal.proposed_resources.paid_fallback, false);
  assert.equal(result.proposal.proposed_resources.shared_cache, false);
  const proposed: unknown = parse(result.proposedWorkflow.toString());
  assert.ok(
    isRecord(proposed) &&
      isRecord(proposed.jobs) &&
      isRecord(proposed.jobs.native_windows) &&
      isRecord(proposed.jobs.tool_bootstrap) &&
      isRecord(proposed.jobs.tool_bootstrap_windows),
  );
  assert.equal(
    proposed.jobs.tool_bootstrap["timeout-minutes"],
    "${{ inputs.publication_purpose == 'application' && 12 || 4 }}",
  );
  assert.equal(proposed.jobs.tool_bootstrap_windows["timeout-minutes"], 22);
  const current: unknown = parse(production.toString());
  assert.ok(isRecord(current) && isRecord(current.jobs));
  const amendedTimeouts: Record<string, number | string> = {
    tool_bootstrap: "${{ inputs.publication_purpose == 'application' && 12 || 4 }}",
    tool_bootstrap_windows: 22,
    native_linux: 25,
  };
  for (const [key, job] of Object.entries(current.jobs))
    if (Object.hasOwn(amendedTimeouts, key)) {
      assert.ok(isRecord(job));
      assert.deepEqual(proposed.jobs[key], { ...job, "timeout-minutes": amendedTimeouts[key] });
    } else
      assert.deepEqual(
        proposed.jobs[key],
        job,
        `Unchanged job ${key} must retain its original authority and bounds`,
      );
  const receipt: unknown = JSON.parse(
    await readFile(
      new URL(
        "../docs/qualification/slice4-resource-amendment-proposal-2026-10-29.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.ok(isRecord(receipt) && isRecord(receipt.prepared_source) && Array.isArray(receipt.jobs));
  assert.equal(
    receipt.prepared_source.proposed_workflow_sha256,
    createHash("sha256").update(result.proposedWorkflow).digest("hex"),
  );
  assert.equal(
    receipt.prepared_source.proposed_resource_digest,
    result.proposal.proposed_resource_digest,
  );
  for (const row of receipt.jobs) {
    assert.ok(isRecord(row) && typeof row.job === "string");
    if (row.job === "wake") continue;
    const projected = result.proposal.observation.jobs.find((job) => job.key === row.job);
    assert.ok(projected);
    assert.equal(
      row.proposed_minutes,
      projected.purpose_maximum_job_minutes?.application ?? projected.maximum_job_minutes,
    );
  }
  const native = proposed.jobs.native_windows;
  assert.equal(native["timeout-minutes"], 35);
  assert.equal(native["runs-on"], "windows-2022");
  assert.equal(native.environment, "production-native-windows");
  assert.match(String(native.if), /^\$\{\{ false &&/u);
  assert.ok(Array.isArray(native.needs) && native.needs.includes("tool_bootstrap_windows"));
  assert.ok(Array.isArray(native.steps));
  const runtime = native.steps.findIndex(
      (step: unknown) =>
        isRecord(step) &&
        step.run ===
          "node scripts/release-controller-tool-bootstrap.mts prepare-windows-native-runtime",
    ),
    pre = native.steps.findIndex(
      (step: unknown) => isRecord(step) && isRecord(step.with) && step.with.stage === "pre-sign",
    );
  assert.ok(runtime > 0 && pre > runtime);
  const stages = native.steps.filter(
    (step: unknown) => isRecord(step) && step.uses === "./.github/actions/release-native-windows",
  );
  assert.equal(stages.length, 2);
  assert.equal(protectedWindowsNativeRuntimePreparationExecutionAuthorized, false);
  await assert.rejects(
    prepareAdmittedWindowsNativeRuntime(),
    /Protected Windows runtime preparation remains held/u,
  );
  const changed: unknown = parse(production.toString());
  assert.ok(isRecord(changed) && isRecord(changed.jobs) && isRecord(changed.jobs.tool_bootstrap));
  changed.jobs.tool_bootstrap["timeout-minutes"] = 5;
  assert.throws(() => prepare(Buffer.from(stringify(changed)), wake, candidate));
  changed.jobs.tool_bootstrap["timeout-minutes"] = 4;
  changed.jobs.native_windows = {};
  assert.throws(() => prepare(Buffer.from(stringify(changed)), wake, candidate), /Do not replace/u);
});

void test("measured proposal preserves exact component scopes and the older maximum without upgrading unknown acceptance", async () => {
  const receipt: unknown = JSON.parse(
    await readFile(
      new URL(
        "../docs/qualification/slice4-resource-amendment-proposal-2026-10-29.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.ok(
    isRecord(receipt) &&
      isRecord(receipt.build_contingency) &&
      Array.isArray(receipt.observations) &&
      Array.isArray(receipt.jobs),
  );
  const reserve = receipt.build_contingency;
  const older: unknown = receipt.observations.find(
    (row: unknown) => isRecord(row) && row.run === "40712543303/1",
  );
  const latest: unknown = receipt.observations.find(
    (row: unknown) => isRecord(row) && row.run === "40819727118/1",
  );
  assert.ok(
    isRecord(older) &&
      isRecord(latest) &&
      isRecord(latest.windows_tool_build_observation) &&
      isRecord(latest.linux_tool_build_observation) &&
      isRecord(latest.linux_actual_checkout),
  );
  assert.equal(older.windows_builder_milliseconds, 250842);
  assert.equal(reserve.older_maximum_observed_milliseconds, older.windows_builder_milliseconds);
  assert.equal(latest.windows_tool_build_observation.elapsed_milliseconds, 204095);
  assert.equal(
    reserve.latest_observed_milliseconds,
    latest.windows_tool_build_observation.elapsed_milliseconds,
  );
  assert.equal(reserve.latest_complete_phase_milliseconds, 203778);
  assert.equal(reserve.proposed_allowance_milliseconds, 360000);
  assert.equal(reserve.reserve_above_observed_maximum_milliseconds, 360000 - 250842);
  assert.equal(reserve.other_phase_allocations_reduced, false);
  assert.equal(latest.linux_tool_build_observation.elapsed_milliseconds, 144450);
  assert.equal(latest.linux_actual_checkout.commit, "301b3552f0523bd5e649a3df740f833d9c354ab9");
  assert.deepEqual(latest.linux_commit_parents, [
    "bd4074c6e7bf4a12a2cdca720da5743a68acf0f2",
    "1a11fa878c946092d7d76643bafd008608b25db6",
  ]);
  assert.equal(latest.windows_runtime_helper_milliseconds, 56359);
  assert.equal(latest.windows_runtime_installer_interval_milliseconds, 56305 - 1016);
  assert.equal(latest.windows_source_preparation_milliseconds, 22415);
  assert.equal(latest.windows_dependency_preparation_milliseconds, 148552);
  assert.equal(latest.retained_json_archive_member_count, 40);
  assert.equal(latest.aggregate_component_seconds, 258 + 531);
  assert.ok(
    receipt.jobs.every((row: unknown) => isRecord(row) && row.observed_protected_seconds === null),
  );
});
