import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assemblerIdentityFixture, expected } from "./assembler-identity-fixture.mts";
import { config } from "./release-control-inputs-fixture.mts";
import { capacityDigest } from "../release-capacity.mts";
import { productionControllerWorkflow } from "../production-controller-admission.mts";
import { authenticateReleaseControlSource } from "../release-live-control-admission.mts";
import { isRecord } from "../runtime-values.mts";
import { releaseControlPhaseProfile } from "../release-control-phases.mts";
import type { ReleaseControlPhase } from "../release-control-phases.mts";
import { capacityFixture } from "./release-capacity-fixture.mts";
import { controllerOidcSubject } from "../assembler-job-identity.mts";

export function capacityDocumentFixture() {
  return {
    schema_version: 1,
    capacity: capacityFixture(),
    observation: {
      kind: "provider-ui-spending-configuration",
      operator_actor_id: 43177418,
      observed_at: "2026-01-01T00:00:00Z",
      evidence_sha256: "e".repeat(64),
    },
  };
}

export function protectionFixture(commit: string, observedAt = new Date().toISOString()) {
  const names = ["portcove-release-inputs", "portcove-release-pause"];
  const rulesets = names.flatMap((branch, index) => [
    {
      id: index * 2 + 1,
      enforcement: "active",
      conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
      rules: [{ type: "update" }],
      bypass_actors: [
        {
          actor_type: index === 0 ? "Integration" : "User",
          actor_id: index === 0 ? 202 : 43177418,
          bypass_mode: "always",
        },
      ],
    },
    {
      id: index * 2 + 2,
      enforcement: "active",
      conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
      rules: ["creation", "deletion", "non_fast_forward"].map((type) => ({ type })),
      bypass_actors: [],
    },
  ]);
  const inventory = {
    rulesets,
    branches: names.map((branch, i) => ({
      branch,
      ref: { ref: `refs/heads/${branch}`, object: { type: "commit", sha: commit } },
      effective_rules: [
        { type: "update", ruleset_id: i * 2 + 1 },
        ...["creation", "deletion", "non_fast_forward"].map((type) => ({
          type,
          ruleset_id: i * 2 + 2,
        })),
      ],
    })),
  };
  return {
    schema_version: 1,
    repository_id: 1354613114,
    observed_at: observedAt,
    coverage: "current-repository-input-branches-only",
    inventory,
    inventory_sha256: capacityDigest(inventory),
    enforcement: "uninterpreted",
    admission: "hold",
    authority: "none",
  };
}

/** Real disposable JWT signature verification over injected provider responses.
 * This is fixture evidence, never a GitHub credential or production observation. */
export function liveControlRuntimeFixture(
  observation: unknown,
  producerConfig: unknown = config,
  phase: ReleaseControlPhase = "admission",
  completeWorkflow = false,
) {
  const profile = releaseControlPhaseProfile(phase);
  const workflow = Buffer.from("inert fixed same-workflow source fixture\n");
  const policy = {
    schema_version: completeWorkflow ? 2 : 1,
    mode: completeWorkflow ? "bounded-application-release" : "admission-only",
    ...(completeWorkflow
      ? { authority_configuration_sha256: "a".repeat(64), grant_sha256: "b".repeat(64) }
      : {}),
    revision: expected.controller_revision,
    execution_ref: expected.controller_ref,
    workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
    actor_id: expected.actor_id,
  };
  const readerEnvironment =
    phase === "admission" && !completeWorkflow ? undefined : profile.reader_environment;
  const subject = controllerOidcSubject(expected.controller_ref, readerEnvironment);
  const identity = assemblerIdentityFixture(
    {
      run_attempt: "1",
      aud: profile.reader_audience,
      sub: subject,
      ...(readerEnvironment ? { environment: readerEnvironment } : {}),
    },
    {},
    { workflow: productionControllerWorkflow, job: profile.reader_name },
  );
  const handoff = {
    schema_version: 1,
    phase,
    producer: {
      workflow: productionControllerWorkflow,
      controller_revision: policy.revision,
      controller_ref: policy.execution_ref,
      run_id: expected.run_id,
      run_attempt: 1,
      job_id: 600,
      check_run_id: "888",
    },
    observation,
  };
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: policy.execution_ref,
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: policy.revision,
    GITHUB_WORKFLOW_SHA: policy.revision,
    GITHUB_WORKFLOW_REF: `boburning/portcove/${productionControllerWorkflow}@${policy.execution_ref}`,
    GITHUB_ACTOR_ID: policy.actor_id,
    GITHUB_ACTOR: "fixture",
    GITHUB_TRIGGERING_ACTOR: "fixture",
    GITHUB_RUN_ID: expected.run_id,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: profile.reader_job,
    RUNNER_ENVIRONMENT: "github-hosted",
    PORTCOVE_CONTROLLER_REVISION: policy.revision,
    PORTCOVE_CONTROLLER_REF: policy.execution_ref,
    PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify(policy),
    PORTCOVE_REVIEW_PRODUCER: JSON.stringify(producerConfig),
    PORTCOVE_TRUSTED_PROTECTION_OBSERVATION: JSON.stringify(handoff),
  };
  const observerJob: Record<string, unknown> = {
    id: 600,
    run_id: 9988,
    run_attempt: 1,
    head_sha: policy.revision,
    name: profile.observer_name,
    status: "completed",
    conclusion: "success",
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/888",
  };
  let clock = Date.now();
  const options = {
    phase,
    identity: {
      readKeys: identity.readKeys,
      transport: {
        ...identity.transport,
        spawn: ((command, args, settings) => {
          const mapped = args.map((arg) => arg.replace("/attempts/1/", "/attempts/2/"));
          const result = identity.transport.spawn(command, mapped, settings);
          const separator = result.stdout.indexOf("\r\n\r\n");
          const body: unknown = JSON.parse(result.stdout.slice(separator + 4));
          if (isRecord(body)) {
            if (body.run_attempt === 2) body.run_attempt = 1;
            if (Array.isArray(body.jobs))
              for (const job of body.jobs as unknown[]) if (isRecord(job)) job.run_attempt = 1;
          }
          return {
            ...result,
            stdout: result.stdout.slice(0, separator + 4) + JSON.stringify(body),
          };
        }) satisfies typeof identity.transport.spawn,
      },
    },
    requestToken: async (audience: string) => {
      assert.equal(audience, profile.reader_audience);
      return identity.token;
    },
    observerApi: {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        assert.equal(endpoint, "repos/boburning/portcove/actions/jobs/600");
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: structuredClone(observerJob),
        };
      },
    },
    now: () => clock,
  };
  return {
    environment,
    workflow,
    policy,
    identity,
    handoff,
    observerJob,
    options,
    create: () => authenticateReleaseControlSource(environment, workflow, options),
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}
