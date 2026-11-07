/** Minimal bootstrap Pages policy around the maintained one-shot native
 * transport. No credential selection, durable state or scheduling lives here. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import { fixedReleaseReaderToken } from "./release-readonly-child-environment.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectSiteGeneration } from "./release-site-generation.mts";
import { immutableApplicationBootstrap } from "./application-release-run.mts";
import type {
  createPagesProviderTransport,
  PagesDeploymentIdentity,
} from "./release-pages-provider.mts";
import type { GitHubMetadataResponse } from "./github-operation.mts";

export async function createApplicationFeedReader(token: string, originalDeadline: number) {
  const deadline = Math.min(originalDeadline, coordinatorCommandDeadline() ?? Infinity);
  const base = "/repos/boburning/portcove/";
  const allowed = (url: URL) => {
    const suffix = url.pathname.slice(base.length);
    if (suffix === "deployments")
      return [
        "?environment=github-pages&per_page=1",
        "?environment=github-pages&per_page=2",
        "?environment=github-pages&per_page=3",
      ].includes(url.search);
    if (/^deployments\/[1-9][0-9]*\/statuses$/u.test(suffix)) return url.search === "?per_page=1";
    return (
      !url.search &&
      (suffix === "pages" ||
        /^deployments\/[1-9][0-9]*$/u.test(suffix) ||
        /^actions\/(?:jobs\/[1-9][0-9]*|runs\/[1-9][0-9]*\/attempts\/[1-3])$/u.test(suffix) ||
        /^git\/ref\/tags\/(?:portcove-production-candidate-(?:[a-f0-9]{40}|[a-f0-9]{64})|v[0-9][A-Za-z0-9.+-]{1,127})$/u.test(
          suffix,
        ))
    );
  };
  const { createGitHubClient } = await import("./github-client.mts");
  let expected: string | undefined;
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline,
    requestTimeoutMs: 30000,
    maxBytes: 8 * 1024 ** 2,
    allowRequest(method, url) {
      assertTrustedDirectNode("fixed application Pages observation");
      return method === "GET" && url.href === expected;
    },
  });
  return async (endpoint: string): Promise<GitHubMetadataResponse> => {
    const url = new URL(endpoint, "https://api.github.com/");
    if (
      url.origin !== "https://api.github.com" ||
      !url.pathname.startsWith(base) ||
      url.username ||
      url.password ||
      url.hash ||
      !allowed(url)
    )
      throw new Error("application feed observation route differs");
    expected = url.href;
    const response = await client.request(`GET ${url.pathname}${url.search}`, {
      request: { portcove: { replay: "once", attempts: 0 } },
    });
    return { status: response.status, headers: new Map(), body: response.data as unknown };
  };
}

export async function readActualApplicationPagesState(
  deadline = performance.now() + 120000,
  admission?: FeedAdmission,
  recoverInitialBootstrap = false,
) {
  const read = await createApplicationFeedReader(fixedReleaseReaderToken(), deadline);
  return readApplicationPagesStateAsync(read, admission, recoverInitialBootstrap);
}

export function applicationPagesIntent(
  generation: string,
  runId: string,
  attempt: number,
  artifactId: number,
  continuationSource?: string,
) {
  const execution = { generation, run_id: runId, run_attempt: attempt, artifact_id: artifactId };
  return {
    repository_id: 1354613114,
    site_url: "https://boburning.github.io/portcove/",
    ...execution,
    build_version: continuationSource ?? generation,
  };
}

type PagesRead<T> = Generator<string, T, GitHubMetadataResponse>;

function* readPagesResponse(suffix: string): PagesRead<GitHubMetadataResponse> {
  return yield `repos/boburning/portcove/${suffix}`;
}

async function readPagesAsync<T>(
  read: (endpoint: string) => Promise<GitHubMetadataResponse>,
  requests: PagesRead<T>,
) {
  let step = requests.next();
  while (!step.done) step = requests.next(await read(step.value));
  return step.value;
}

/** Same narrow provider projection used by the independently appointed initial
 * preimage. A generation marker alone cannot identify the deployment actor. */
export type FeedAdmission = {
  run_id: string;
  run_attempt: number;
  source: string;
  ref: string;
  selection: "serving" | "current";
  deployment_id?: number;
} & ({ role?: undefined; job_id?: undefined } | { role: "site-publication"; job_id: number });

export function readApplicationPagesStateAsync(
  read: (endpoint: string) => Promise<GitHubMetadataResponse>,
  admission?: FeedAdmission,
  recoverInitialBootstrap = false,
) {
  return readPagesAsync(read, applicationPagesState(admission, recoverInitialBootstrap));
}

function* applicationPagesState(admission?: FeedAdmission, recoverInitialBootstrap = false) {
  function* get(suffix: string): PagesRead<unknown> {
    const result = yield* readPagesResponse(suffix);
    assert.equal(result.status, 200);
    return result.body;
  }
  const pages = yield* get("pages");
  assert.ok(
    isRecord(pages) &&
      pages.html_url === "https://boburning.github.io/portcove/" &&
      pages.build_type === "workflow" &&
      pages.cname === null &&
      pages.https_enforced === true,
  );
  const verifyRecoveryPreimage = recoverInitialBootstrap && admission?.selection !== "current";
  const servingIndex = admission?.selection === "serving" ? 1 : 0;
  const limit = servingIndex + 1 + Number(verifyRecoveryPreimage);
  const deployments = yield* get(`deployments?environment=github-pages&per_page=${limit}`);
  assert.ok(Array.isArray(deployments) && deployments.length === limit);
  function* actor(raw: unknown) {
    assert.ok(
      isRecord(raw) &&
        typeof raw.id === "number" &&
        Number.isSafeInteger(raw.id) &&
        raw.id > 0 &&
        raw.environment === "github-pages" &&
        typeof raw.sha === "string" &&
        typeof raw.ref === "string",
    );
    const statuses = yield* get(`deployments/${raw.id}/statuses?per_page=1`);
    assert.ok(Array.isArray(statuses) && statuses.length === 1);
    const status: unknown = statuses[0];
    assert.ok(
      isRecord(status) &&
        typeof status.id === "number" &&
        Number.isSafeInteger(status.id) &&
        status.id > 0 &&
        typeof status.log_url === "string",
    );
    return {
      deployment: { id: raw.id, sha: raw.sha, ref: raw.ref, environment: raw.environment },
      raw,
      status: {
        id: status.id,
        log_url: status.log_url,
        state: status.state,
        environment: status.environment,
      },
    };
  }
  const current = yield* actor(deployments[0]);
  let selected = current;
  if (admission) {
    const { deployment, raw, status } = current;
    const match = status.log_url.match(
      /^https:\/\/github\.com\/boburning\/portcove\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/u,
    );
    assert.ok(
      match?.[1] === admission.run_id &&
        Number.isSafeInteger(Number(match[2])) &&
        (admission.job_id === undefined || Number(match[2]) === admission.job_id) &&
        deployment.sha === admission.source &&
        [admission.ref, admission.ref.slice("refs/tags/".length)].includes(deployment.ref) &&
        (admission.deployment_id === undefined || admission.deployment_id === deployment.id) &&
        raw.task === "deploy" &&
        isRecord(raw.payload) &&
        Object.keys(raw.payload).length === 0 &&
        isRecord(raw.performed_via_github_app) &&
        raw.performed_via_github_app.slug === "github-actions" &&
        status.state === "in_progress" &&
        status.environment === "github-pages",
      "latest Pages deployment is not this job's active environment admission",
    );
    const job = yield* get(`actions/jobs/${match[2]}`);
    assert.ok(
      isRecord(job) &&
        job.id === Number(match[2]) &&
        job.run_id === Number(admission.run_id) &&
        job.run_attempt === admission.run_attempt &&
        job.head_sha === admission.source &&
        job.head_branch === admission.ref.slice("refs/tags/".length) &&
        job.name ===
          (admission.role === "site-publication"
            ? "Publish authenticated application site"
            : "feed") &&
        job.status === "in_progress" &&
        job.html_url === status.log_url,
      "Pages environment admission job identity differs",
    );
    if (admission.selection === "serving") {
      selected = yield* actor(deployments[limit - 1]);
      assert.notEqual(selected.deployment.id, deployment.id);
    }
  }
  if (verifyRecoveryPreimage) {
    const original = immutableApplicationBootstrap;
    const prior = servingIndex ? yield* actor(deployments[servingIndex]) : current;
    assert.equal(prior.deployment.id, original.admission_id);
    assert.equal(prior.deployment.sha, original.assembly.control_commit);
    assert.equal(prior.deployment.ref, original.assembly.control_ref.slice("refs/tags/".length));
    assert.equal(prior.status.id, original.failed_admission_status_id);
    assert.equal(prior.status.state, "failure");
    assert.equal(
      prior.status.log_url,
      `https://github.com/boburning/portcove/actions/runs/${original.assembly.run_id}/job/${original.feed_job_id}`,
    );
    if (!admission) selected = yield* actor(deployments[limit - 1]);
    assert.notEqual(selected.deployment.id, prior.deployment.id);
  }
  const { deployment, status } = selected;
  if (admission?.selection !== "current") assert.equal(status.state, "success");
  return {
    deployment_id: deployment.id,
    ...(admission ? { admission_id: current.deployment.id } : {}),
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
  state: Awaited<ReturnType<typeof readApplicationPagesStateAsync>>,
  generation: string,
  runs: readonly { id: string; control_commit: string; control_ref: string }[],
) {
  assert.match(generation, /^[a-f0-9]{64}$/u);
  assert.ok(runs.length > 0);
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
  read: (endpoint: string) => Promise<GitHubMetadataResponse>,
  state: Awaited<ReturnType<typeof readApplicationPagesStateAsync>>,
  currentRecovery?: { run_id: string; run_attempt: number; source: string; ref: string },
) {
  return readPagesAsync(read, applicationPagesExecution(state, currentRecovery));
}

function* applicationPagesExecution(
  state: Awaited<ReturnType<typeof readApplicationPagesStateAsync>>,
  currentRecovery?: { run_id: string; run_attempt: number; source: string; ref: string },
) {
  const match = state.log_url.match(
    /^https:\/\/github\.com\/boburning\/portcove\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/u,
  );
  assert.ok(match, "Pages actor has no canonical Actions job URL");
  const runId = Number(match[1]),
    jobId = Number(match[2]);
  assert.ok(Number.isSafeInteger(runId) && Number.isSafeInteger(jobId));
  function* get(suffix: string): PagesRead<Record<string, unknown>> {
    const response = yield* readPagesResponse(suffix);
    assert.equal(response.status, 200);
    assert.ok(isRecord(response.body));
    return response.body;
  }
  const instant = (raw: unknown) => {
    assert.ok(
      typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(raw),
    );
    const value = Date.parse(raw);
    assert.ok(Number.isFinite(value));
    return value;
  };
  const job = yield* get(`actions/jobs/${jobId}`);
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
  const recovery =
    Array.isArray(job.steps) &&
    job.steps.some(
      (step) =>
        isRecord(step) &&
        step.name === "Reconcile initial application Pages deployment" &&
        step.status === "completed" &&
        step.conclusion === "success",
    );
  assert.ok(
    start <= end && end - start <= (recovery ? 16 : 2) * 60000,
    "prior feed exceeded its fixed job budget",
  );
  // Read the original attempt, not a mutable latest rerun projection.
  const run = yield* get(`actions/runs/${runId}/attempts/${job.run_attempt}`);
  assert.equal(run.id, runId);
  assert.equal(run.run_attempt, job.run_attempt);
  assert.equal(run.head_sha, job.head_sha);
  assert.equal(run.path, ".github/workflows/application-release.yml");
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
  const activeRecovery =
    recovery &&
    currentRecovery?.run_id === String(runId) &&
    currentRecovery.run_attempt === job.run_attempt &&
    currentRecovery.source === job.head_sha &&
    currentRecovery.ref === controlRef &&
    run.status === "in_progress";
  assert.match(
    controlRef,
    /^refs\/tags\/portcove-production-controller-windows-[A-Za-z0-9._-]{1,64}$/u,
  );
  assert.ok([controlRef, run.head_branch].includes(state.ref));
  assert.ok(state.source_commit === job.head_sha || /^[a-f0-9]{64}$/u.test(state.source_commit));
  const deployment = yield* get(`deployments/${state.deployment_id}`);
  assert.equal(deployment.id, state.deployment_id);
  assert.equal(deployment.environment, "github-pages");
  assert.equal(deployment.sha, state.source_commit);
  assert.equal(deployment.ref, state.ref);
  const statuses = yield* readPagesResponse(
    `deployments/${state.deployment_id}/statuses?per_page=1`,
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
  const duringJob = start <= created && created <= succeeded && succeeded <= end;
  if (!duringJob) {
    // Actions creates its environment admission before starting the job and
    // can publish the final status after the job has completed.
    const app = deployment.performed_via_github_app;
    assert.ok(
      deployment.task === "deploy" &&
        isRecord(deployment.payload) &&
        Object.keys(deployment.payload).length === 0 &&
        isRecord(app) &&
        app.id === 15368 &&
        app.slug === "github-actions" &&
        deployment.sha === job.head_sha &&
        job.head_branch === run.head_branch &&
        job.conclusion === "success" &&
        job.html_url === state.log_url &&
        status.target_url === state.log_url &&
        status.environment === "github-pages" &&
        status.deployment_url ===
          `https://api.github.com/repos/boburning/portcove/deployments/${state.deployment_id}` &&
        (run.status === "completed" || activeRecovery) &&
        instant(run.run_started_at) <= created &&
        created <= start &&
        start <= succeeded &&
        (activeRecovery || Math.max(end, succeeded) <= instant(run.updated_at)),
      "Pages deployment is outside its claimed original feed job or Actions admission",
    );
  }
  assert.deepEqual(
    yield* applicationPagesState(),
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
  "create" | "status" | "cancel"
>;

type PriorPagesEffect = {
  identity: PagesDeploymentIdentity;
  qualified_native_id: boolean;
  continuation?: { build_version: string; beforeCancel: () => Promise<void> };
};

/** A prior opaque effect may be followed only by an appointed continuation
 * of the identical site. Both use independent actor and public-byte checks. */
export async function executeBootstrapPages(
  expected: {
    artifact_id: number;
    control_commit: string;
    site: unknown;
    prior_effect?: PriorPagesEffect;
    preimage: "initial" | "prior" | "desired" | "recovery-visible";
  },
  options: {
    provider: Provider;
    beforeWrite: () => Promise<() => void>;
    beforeCancelNewEffect?: () => Promise<void>;
    assertPreimage: () => Promise<void>;
    publicReadback: () => Promise<{ generation: string; evidence_sha256: string }>;
    providerReadback: (resolution: string) => Promise<unknown>;
    markStage?: (
      stage:
        | "preimage"
        | "post-may-have-started"
        | "prior-effect-observation"
        | "provider-readback"
        | "public-readback",
    ) => void;
    wait: () => Promise<void>;
    deadline?: number;
  },
) {
  assert.ok(isRecord(expected.site) && typeof expected.site.generation === "string");
  const site = inspectSiteGeneration(expected.site, expected.site.generation);
  assert.ok(Number.isSafeInteger(expected.artifact_id) && expected.artifact_id > 0);
  assert.match(expected.control_commit, /^[a-f0-9]{40}$/u);
  assert.ok(["initial", "prior", "desired", "recovery-visible"].includes(expected.preimage));
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
  const prior = expected.prior_effect;
  if (prior) assert.equal(prior.identity.generation, site.generation);
  if (expected.preimage === "recovery-visible") assert.ok(prior?.continuation);
  let resolution = "already-public";
  let priorOutcome: Awaited<ReturnType<Provider["status"]>>["outcome"] | null = null;
  let nativeId: string | null = null;
  const poll = async (
    operation: PagesDeploymentIdentity,
    observation: Awaited<ReturnType<Provider["status"]>>,
    maximum: number,
    onObservation?: (result: Awaited<ReturnType<Provider["status"]>>) => void,
    stopAt = deadline,
  ) => {
    for (let index = 0; index < maximum; index++) {
      if (!["pending", "unknown"].includes(observation.outcome)) break;
      if (performance.now() >= stopAt) break;
      within();
      await options.wait();
      observation = await options.provider.status(operation);
      onObservation?.(observation);
    }
    return observation;
  };
  if (expected.preimage !== "desired") {
    within();
    let continueEffect = !prior;
    if (prior) {
      options.markStage?.("prior-effect-observation");
      let observation = await options.provider.status(prior.identity);
      if (
        prior.continuation &&
        prior.qualified_native_id &&
        ["pending", "unknown"].includes(observation.outcome)
      ) {
        await options.provider.cancel(prior.identity, prior.continuation.beforeCancel);
      }
      let pendingObserved = observation.outcome === "pending";
      let onlyProviderOpacity = observation.provider_opaque;
      observation = await poll(
        prior.identity,
        observation,
        prior.continuation ? 2 : 12,
        (result) => {
          pendingObserved ||= result.outcome === "pending";
          onlyProviderOpacity &&= result.provider_opaque;
        },
      );
      priorOutcome = observation.outcome;
      if (priorOutcome === "succeeded") {
        resolution = "recovered-original-effect";
        nativeId = prior.qualified_native_id ? prior.identity.id : null;
      } else {
        assert.ok(
          expected.preimage !== "recovery-visible" &&
            prior.continuation &&
            (priorOutcome === "terminal" ||
              priorOutcome === "cancelled" ||
              (priorOutcome === "unknown" && !pendingObserved && onlyProviderOpacity)),
          "Earlier Pages effect could not be reconciled within the lifecycle budget",
        );
        assert.notEqual(prior.continuation.build_version, prior.identity.id);
        assert.notEqual(prior.continuation.build_version, site.generation);
        continueEffect = true;
      }
    }
    if (continueEffect) {
      let entered = false;
      let acknowledged: PagesDeploymentIdentity | undefined;
      try {
        acknowledged = await options.provider.create(
          identity,
          async () => {
            const assertFresh = await options.beforeWrite();
            options.markStage?.("preimage");
            await options.assertPreimage();
            within();
            assertFresh();
            options.markStage?.("post-may-have-started");
            entered = true;
          },
          prior?.continuation?.build_version,
        );
      } catch (error) {
        if (!entered) throw error;
        if (prior?.continuation) throw error;
      }
      const operation = { ...identity, id: acknowledged?.id ?? identity.generation };
      if (prior?.continuation) {
        assert.notEqual(operation.id, prior.identity.id, "Pages reused the original deployment ID");
        assert.notEqual(operation.id, site.generation, "Pages returned the original build version");
      }
      let native = await poll(
        operation,
        await options.provider.status(operation),
        prior?.continuation ? 150 : 12,
        undefined,
        options.beforeCancelNewEffect ? deadline - 90_000 : deadline,
      );
      if (
        acknowledged &&
        options.beforeCancelNewEffect &&
        ["pending", "unknown"].includes(native.outcome)
      ) {
        await options.provider.cancel(operation, options.beforeCancelNewEffect);
        native = await poll(operation, await options.provider.status(operation), 2);
      }
      assert.ok(
        native.outcome === "succeeded",
        "Pages did not settle successfully; no repost or feed replacement",
      );
      nativeId = acknowledged?.id ?? null;
      resolution = prior?.continuation
        ? "continued-identical-effect"
        : acknowledged
          ? "new-effect"
          : "recovered-ambiguous-effect";
    }
  }
  within();
  options.markStage?.("provider-readback");
  const provider = await options.providerReadback(resolution);
  options.markStage?.("public-readback");
  const readback = await options.publicReadback();
  assert.equal(readback.generation, site.generation);
  assert.match(readback.evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    await options.providerReadback(resolution),
    provider,
    "Pages actor changed during public byte readback",
  );
  within();
  return {
    schema_version: 1,
    authority: "none",
    generation: site.generation,
    resolution,
    prior_outcome: priorOutcome,
    native_deployment_id: nativeId,
    provider,
    public_readback: readback,
    evidence_sha256: digest({ generation: site.generation, provider, readback }),
    scope:
      "Pages status, actor and complete public bytes; installed Windows acceptance remains separate",
  };
}
