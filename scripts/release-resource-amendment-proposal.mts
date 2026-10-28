/** Exact source proposal only. This cannot install a workflow, appoint a job,
 * ratify resource policy or enable any execution/signing/publication gate. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseDocument, stringify } from "yaml";
import { isRecord } from "./runtime-values.mts";
import {
  slice4CapacityResources,
  slice4CapacityResourceDigest,
  capacityDigest,
} from "./release-capacity.mts";
import { observeReleaseResources } from "./release-resource-observation.mts";

export function prepareReleaseResourceAmendmentProposal(
  production: Buffer,
  wake: Buffer,
  candidate: Buffer,
) {
  assert.ok(production.length > 0 && production.length <= 512 * 1024);
  const parsed = parseDocument(production.toString("utf8"), { uniqueKeys: true });
  assert.equal(parsed.errors.length, 0);
  const raw: unknown = parsed.toJS({ maxAliasCount: 100 });
  assert.ok(isRecord(raw) && isRecord(raw.jobs));
  const jobs = raw.jobs;
  assert.ok(
    isRecord(jobs.tool_bootstrap) &&
      isRecord(jobs.tool_bootstrap_windows) &&
      isRecord(jobs.native_linux),
  );
  assert.equal(jobs.native_windows, undefined, "Do not replace an existing native job proposal");
  assert.equal(jobs.tool_bootstrap["timeout-minutes"], 4);
  assert.equal(jobs.tool_bootstrap_windows["timeout-minutes"], 4);
  assert.equal(jobs.native_linux["timeout-minutes"], 10);
  jobs.tool_bootstrap["timeout-minutes"] =
    "${{ inputs.publication_purpose == 'application' && 12 || 4 }}";
  jobs.tool_bootstrap_windows["timeout-minutes"] = 20;
  jobs.native_linux["timeout-minutes"] = 25;
  assert.ok(Array.isArray(jobs.native_linux.needs) && Array.isArray(jobs.native_linux.steps));
  assert.ok(Array.isArray(jobs.tool_bootstrap_windows.steps));
  const native = structuredClone(jobs.native_linux);
  const setup: unknown[] = jobs.tool_bootstrap_windows.steps,
    linuxNeeds: unknown[] = jobs.native_linux.needs,
    linuxSteps: unknown[] = jobs.native_linux.steps;
  assert.ok(linuxNeeds.every((name) => typeof name === "string"));
  const manager = setup.filter(
    (step) =>
      isRecord(step) && typeof step.uses === "string" && step.uses.startsWith("pnpm/action-setup@"),
  );
  assert.equal(manager.length, 1, "Reuse the original pinned public package-manager setup");
  const publicStep = (name: string) => {
    const selected = setup.filter((step: unknown) => isRecord(step) && step.name === name);
    assert.equal(selected.length, 1, "Original fixed public dependency step required");
    return structuredClone(selected[0]);
  };
  native.name = "Qualify hosted Windows installed continuity";
  native["runs-on"] = "windows-2022";
  native["timeout-minutes"] = 35;
  native.environment = "production-native-windows";
  native.needs = [...linuxNeeds, "tool_bootstrap_windows"];
  // Even installing this proposed resource source cannot activate Windows.
  // Original source/account/worker/recovery gates also remain independently held.
  native.if =
    "${{ false && needs.admission.outputs.publication_purpose == 'application' && needs.admission.outputs.classification_transport == 'fixed-job' && needs.coordinator.outputs.mode == 'release' && needs.coordinator.outputs.signing_custody != 'reused' }}";
  const first = structuredClone(linuxSteps.slice(0, 2));
  native.steps = [
    ...first,
    structuredClone(manager[0]),
    publicStep("Install only the fixed source lockfile before any role credential"),
    {
      name: "Prepare only the admitted fresh Windows runtime before original native ownership",
      shell: "pwsh",
      env: { GH_TOKEN: "${{ github.token }}", GITHUB_TOKEN: "" },
      run: "node scripts/release-controller-tool-bootstrap.mts prepare-windows-native-runtime",
    },
    {
      name: "Keep the original Windows owner through pre-sign upload and readback",
      uses: "./.github/actions/release-native-windows",
      with: { stage: "pre-sign" },
    },
    {
      name: "Wait only inside the original owner deadline and complete post-sign proof",
      uses: "./.github/actions/release-native-windows",
      with: { stage: "post-sign" },
    },
    {
      name: "Retain bounded public native lifecycle rows after success or refusal",
      if: "${{ always() }}",
      shell: "pwsh",
      run: "node scripts/release-controller-diagnostics.mts native-windows",
    },
    {
      name: "Preserve the original Windows attempt without private logs or credentials",
      if: "${{ always() }}",
      uses: "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
      with: {
        name: "trusted-native-diagnostics-windows-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/native-public-evidence-windows",
        "if-no-files-found": "error",
        overwrite: false,
        "retention-days": 7,
        "compression-level": 0,
      },
    },
  ];
  jobs.native_windows = native;
  const proposedWorkflow = Buffer.from(stringify(raw, { lineWidth: 100 })),
    observation = observeReleaseResources(proposedWorkflow, wake, candidate);
  assert.equal(observation.accounting.application, 163);
  assert.equal(observation.accounting.catalog_alternative, 40);
  assert.equal(observation.accounting.policy_envelope, 100);
  assert.equal(observation.policy_matches_workflow, false);
  const inputs = (name: string) =>
    name.includes("protection_observation") || name === "classification_writer";
  const app = observation.jobs.filter((row) => row.purposes.includes("application"));
  const minutes = (row: (typeof app)[number]) => {
    const value = row.purpose_maximum_job_minutes?.application ?? row.maximum_job_minutes;
    assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
    return value;
  };
  const digest = createHash("sha256").update(proposedWorkflow).digest("hex");
  const proposedResources = {
    ...slice4CapacityResources,
    aggregate_workflow_sha256: digest,
    input_workflow_sha256: digest,
    aggregate_job_minutes: app.filter((row) => !inputs(row.key)).map(minutes),
    input_job_minutes: app.filter((row) => inputs(row.key)).map(minutes),
    declared_job_minutes: 163,
    purpose_accounting: "mutually-exclusive-max-application163-catalog40",
    total_job_minutes: 163,
  };
  return {
    proposedWorkflow,
    proposal: {
      schema_version: 1,
      authority: "none",
      status: "PROPOSAL ONLY; NOT RATIFIED",
      effective_policy_digest: slice4CapacityResourceDigest,
      input_workflow_sha256: createHash("sha256").update(production).digest("hex"),
      proposed_workflow_sha256: digest,
      proposed_resources: proposedResources,
      proposed_resource_digest: capacityDigest(proposedResources),
      observation,
      execution:
        "Explicit false Windows job plus unchanged protected source/account/worker/recovery/sign/publication gates",
      owner_clock:
        "Both native platforms retain the existing570000ms total original clock;600000ms full signer wait cannot fit; late signer refuses; outer25/35minute caps do not extend it",
      application_only_bootstrap:
        "Fixed application12/catalog4 expression; catalog remains independent40 under effective100",
      activation:
        "Requires independently reviewed exact final workflow/source/resource/configuration and explicit policy ratification; no publication or production execution authority inferred",
    },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, "Proposal has no execution or arbitrary source options");
  const bytes = await Promise.all(
    ["application-update-production.yml", "application-update-wake.yml", "release.yml"].map(
      (name) => readFile(new URL("../.github/workflows/" + name, import.meta.url)),
    ),
  );
  const proposal = prepareReleaseResourceAmendmentProposal(bytes[0]!, bytes[1]!, bytes[2]!);
  console.log(
    JSON.stringify(
      { ...proposal.proposal, proposed_workflow_utf8: proposal.proposedWorkflow.toString("utf8") },
      null,
      2,
    ),
  );
}
