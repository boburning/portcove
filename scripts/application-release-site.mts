/** Minimal bootstrap Pages policy around the maintained one-shot native
 * transport. No credential selection, durable state or scheduling lives here. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectSiteGeneration } from "./release-site-generation.mts";
import { isTerminalPagesFailure } from "./release-pages-provider.mts";
import type { createPagesProviderTransport } from "./release-pages-provider.mts";
import type { GitHubRestReader } from "./github-api.mts";

/** Same narrow provider projection used by the independently appointed initial
 * preimage. A generation marker alone cannot identify the deployment actor. */
export function readApplicationPagesState(api: GitHubRestReader) {
  const get = (suffix: string) => {
    const result = api.request("GET", `repos/boburning/portcove/${suffix}`);
    assert.equal(result.status, 200);
    return result.body;
  };
  const pages = get("pages");
  assert.ok(
    isRecord(pages) &&
      pages.html_url === "https://boburning.github.io/portcove/" &&
      pages.build_type === "workflow" &&
      pages.cname === null &&
      pages.https_enforced === true,
  );
  const deployments = get("deployments?environment=github-pages&per_page=1");
  assert.ok(Array.isArray(deployments) && deployments.length === 1);
  const deployment: unknown = deployments[0];
  assert.ok(
    isRecord(deployment) &&
      typeof deployment.id === "number" &&
      Number.isSafeInteger(deployment.id) &&
      deployment.id > 0,
  );
  assert.equal(deployment.environment, "github-pages");
  assert.ok(typeof deployment.sha === "string" && typeof deployment.ref === "string");
  const statuses = get(`deployments/${deployment.id}/statuses?per_page=1`);
  assert.ok(Array.isArray(statuses) && statuses.length === 1);
  const status: unknown = statuses[0];
  assert.ok(
    isRecord(status) &&
      status.state === "success" &&
      typeof status.id === "number" &&
      Number.isSafeInteger(status.id) &&
      status.id > 0 &&
      typeof status.log_url === "string",
  );
  return {
    deployment_id: deployment.id,
    source_commit: deployment.sha,
    ref: deployment.ref,
    environment: deployment.environment,
    status_id: status.id,
    log_url: status.log_url,
    pages: {
      html_url: pages.html_url,
      build_type: pages.build_type,
      cname: pages.cname,
      https_enforced: pages.https_enforced,
    },
  };
}

export function assertBootstrapPagesActor(
  state: ReturnType<typeof readApplicationPagesState>,
  generation: string,
  runs: readonly { id: string; control_commit: string; control_ref: string }[],
) {
  assert.match(generation, /^[a-f0-9]{64}$/u);
  assert.ok(runs.length > 0 && runs.length <= 3);
  assert.ok(
    runs.some((run) => {
      assert.match(run.id, /^[1-9][0-9]{0,15}$/u);
      assert.match(run.control_commit, /^[a-f0-9]{40}$/u);
      assert.match(
        run.control_ref,
        /^refs\/tags\/portcove-production-controller-windows-[A-Za-z0-9._-]{1,64}$/u,
      );
      return (
        (state.source_commit === run.control_commit || state.source_commit === generation) &&
        [run.control_ref, run.control_ref.slice("refs/tags/".length)].includes(state.ref) &&
        new RegExp(
          `^https://github\\.com/boburning/portcove/actions/runs/${run.id}/job/[1-9][0-9]*$`,
          "u",
        ).test(state.log_url)
      );
    }),
    "Pages deployment source/ref/log is not a registered fixed execution",
  );
}

/** Independently resolve the provider's actual prior feed actor. A log URL alone
 * is replayable: a later deployment must not borrow an older successful job.
 * Facts only; the caller must still authenticate immutable assembly and TUF. */
export function readApplicationPagesExecution(
  api: GitHubRestReader,
  state: ReturnType<typeof readApplicationPagesState>,
) {
  const match = state.log_url.match(
    /^https:\/\/github\.com\/boburning\/portcove\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/u,
  );
  assert.ok(match, "Pages actor has no canonical Actions job URL");
  const runId = Number(match[1]),
    jobId = Number(match[2]);
  assert.ok(Number.isSafeInteger(runId) && Number.isSafeInteger(jobId));
  const get = (suffix: string) => {
    const response = api.request("GET", `repos/boburning/portcove/${suffix}`);
    assert.equal(response.status, 200);
    assert.ok(isRecord(response.body));
    return response.body;
  };
  const instant = (raw: unknown) => {
    assert.ok(
      typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(raw),
    );
    const value = Date.parse(raw);
    assert.ok(Number.isFinite(value));
    return value;
  };
  const job = get(`actions/jobs/${jobId}`);
  assert.equal(job.id, jobId);
  assert.equal(job.run_id, runId);
  assert.equal(job.name, "feed");
  assert.equal(job.status, "completed");
  // A final readback failure does not undo an independently observed successful
  // Pages effect. Preserve the original aggregate result as a fact; immutable
  // assembly, actual public bytes and TUF authentication remain downstream.
  assert.ok(job.conclusion === "success" || job.conclusion === "failure");
  assert.ok(typeof job.head_sha === "string" && /^[a-f0-9]{40}$/u.test(job.head_sha));
  assert.ok(
    typeof job.run_attempt === "number" &&
      Number.isSafeInteger(job.run_attempt) &&
      job.run_attempt >= 1 &&
      job.run_attempt <= 3,
  );
  const start = instant(job.started_at),
    end = instant(job.completed_at);
  assert.ok(start <= end && end - start <= 2 * 60000, "prior feed exceeded its fixed job budget");
  // Read the original attempt, not a mutable latest rerun projection.
  const run = get(`actions/runs/${runId}/attempts/${job.run_attempt}`);
  assert.equal(run.id, runId);
  assert.equal(run.run_attempt, job.run_attempt);
  assert.equal(run.head_sha, job.head_sha);
  assert.equal(run.path, ".github/workflows/release.yml");
  assert.equal(run.event, "workflow_dispatch");
  assert.ok(
    isRecord(run.repository) &&
      run.repository.id === 1354613114 &&
      run.repository.full_name === "boburning/portcove",
  );
  assert.ok(
    isRecord(run.head_repository) &&
      run.head_repository.id === 1354613114 &&
      run.head_repository.full_name === "boburning/portcove",
  );
  assert.ok(typeof run.head_branch === "string");
  const controlRef = `refs/tags/${run.head_branch}`;
  assert.match(
    controlRef,
    /^refs\/tags\/portcove-production-controller-windows-[A-Za-z0-9._-]{1,64}$/u,
  );
  assert.ok([controlRef, run.head_branch].includes(state.ref));
  assert.ok(state.source_commit === job.head_sha || /^[a-f0-9]{64}$/u.test(state.source_commit));
  const deployment = get(`deployments/${state.deployment_id}`);
  assert.equal(deployment.id, state.deployment_id);
  assert.equal(deployment.environment, "github-pages");
  assert.equal(deployment.sha, state.source_commit);
  assert.equal(deployment.ref, state.ref);
  const statuses = api.request(
    "GET",
    `repos/boburning/portcove/deployments/${state.deployment_id}/statuses?per_page=1`,
  );
  assert.equal(statuses.status, 200);
  assert.ok(
    Array.isArray(statuses.body) && statuses.body.length === 1 && isRecord(statuses.body[0]),
  );
  const status = statuses.body[0];
  assert.equal(status.id, state.status_id);
  assert.equal(status.state, "success");
  assert.equal(status.log_url, state.log_url);
  const created = instant(deployment.created_at),
    succeeded = instant(status.created_at);
  assert.ok(
    start <= created && created <= succeeded && succeeded <= end,
    "Pages deployment is outside its claimed original feed job",
  );
  assert.deepEqual(
    readApplicationPagesState(api),
    state,
    "prior Pages actor changed during discovery",
  );
  return {
    run: { id: String(runId), control_commit: job.head_sha, control_ref: controlRef },
    attempt: job.run_attempt,
    job_id: jobId,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    deployment_created_at: deployment.created_at,
    deployed_at: status.created_at,
    authority: "none" as const,
  };
}

type Provider = Pick<
  ReturnType<typeof createPagesProviderTransport>,
  "create" | "observe" | "observeByGeneration"
>;

/** Fresh guard is invoked by the native transport AFTER OIDC acquisition.
 * Prior executed feed jobs force read-only recovery, even when status404s.
 * Public bytes and provider actor are both required after status success. */
export async function executeBootstrapPages(
  expected: {
    artifact_id: number;
    control_commit: string;
    site: unknown;
    prior_feed_execution: boolean;
    preimage: "initial" | "prior" | "desired";
  },
  options: {
    provider: Provider;
    beforeWrite: () => Promise<() => void>;
    assertPreimage: () => Promise<void>;
    publicReadback: () => Promise<{ generation: string; evidence_sha256: string }>;
    providerReadback: () => Promise<unknown>;
    wait: () => Promise<void>;
    deadline?: number;
  },
) {
  assert.ok(isRecord(expected.site) && typeof expected.site.generation === "string");
  const site = inspectSiteGeneration(expected.site, expected.site.generation);
  assert.ok(Number.isSafeInteger(expected.artifact_id) && expected.artifact_id > 0);
  assert.match(expected.control_commit, /^[a-f0-9]{40}$/u);
  assert.equal(typeof expected.prior_feed_execution, "boolean");
  assert.ok(["initial", "prior", "desired"].includes(expected.preimage));
  if (expected.preimage === "prior")
    assert.ok(
      typeof site.previous_generation === "string" &&
        /^[a-f0-9]{64}$/u.test(site.previous_generation),
      "ordinary Pages mutation requires an identified prior generation",
    );
  const deadline = options.deadline ?? performance.now() + 90000;
  const within = () =>
    assert.ok(
      Number.isFinite(deadline) && performance.now() < deadline,
      "Pages deadline exhausted; retain immutable cohort",
    );
  const identity = {
    artifact_id: expected.artifact_id,
    controller_revision: expected.control_commit,
    generation: site.generation,
  };
  let resolution = "already-public";
  if (expected.preimage !== "desired") {
    within();
    let native;
    if (expected.prior_feed_execution) {
      // Missing/unknown prior outcome is not permission for another POST.
      native = await options.provider.observeByGeneration(identity);
      resolution = "recovered-original-effect";
    } else {
      let entered = false;
      try {
        const created = await options.provider.create(identity, async () => {
          const assertFresh = await options.beforeWrite();
          await options.assertPreimage();
          within();
          assertFresh();
          entered = true;
        });
        native = await options.provider.observe({ ...identity, id: created.id });
        resolution = "new-effect";
      } catch (error) {
        if (!entered) throw error;
        // Only observation follows an ambiguous native POST, never a repeat.
        native = await options.provider.observeByGeneration(identity);
        resolution = "recovered-ambiguous-effect";
      }
    }
    for (let index = 0; native.status !== "succeed"; index++) {
      assert.ok(
        index < 12 && !isTerminalPagesFailure(native.status),
        "Pages did not settle successfully; no repost or feed replacement",
      );
      within();
      await options.wait();
      native = await options.provider.observe({ ...identity, id: native.id });
    }
  }
  within();
  const provider = await options.providerReadback();
  const readback = await options.publicReadback();
  assert.equal(readback.generation, site.generation);
  assert.match(readback.evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    await options.providerReadback(),
    provider,
    "Pages actor changed during public byte readback",
  );
  within();
  return {
    schema_version: 1,
    authority: "none",
    generation: site.generation,
    resolution,
    provider,
    public_readback: readback,
    evidence_sha256: digest({ generation: site.generation, provider, readback }),
    scope:
      "Pages status, actor and complete public bytes; installed Windows acceptance remains separate",
  };
}
