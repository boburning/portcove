import { capacityDigest, slice4CapacityResources } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import {
  admitProductionInputReader,
  productionControllerWorkflow,
} from "./production-controller-admission.mts";
import {
  requestAssemblerToken,
  verifyReleaseInputReaderJobIdentity,
} from "./assembler-job-identity.mts";
import { requireReleaseInputWriterPolicy } from "./release-input-protections.mts";
import {
  inspectReviewProducerConfiguration,
  readPublicationPause,
  readRatifiedCapacityConfiguration,
  readReviewedClassification,
} from "./release-control-inputs.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { requireObservedControlArtifact } from "./release-control-handshake.mts";
import type { ObservedControlArtifact } from "./release-control-handshake.mts";
const establishedSources = new WeakSet<object>();
export function requireAuthenticatedReleaseControlSource(value: unknown) {
  if (typeof value !== "object" || value === null || !establishedSources.has(value))
    throw new Error("release control source must be established by the fixed runtime verifier");
}

function exact(raw: unknown, fields: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== fields)
    throw new Error("same-workflow control handoff fields differ");
}
function json(raw: string | undefined, maximum: number) {
  if (!raw || Buffer.byteLength(raw) > maximum)
    throw new Error("ratified control identity or direct needs handoff unavailable");
  return JSON.parse(raw) as unknown;
}

type ReaderIdentityOptions = Parameters<typeof verifyReleaseInputReaderJobIdentity>[2];
type ReaderOptions = {
  identity?: ReaderIdentityOptions;
  requestToken?: typeof requestAssemblerToken;
};
export async function authenticateControlReaderJob(
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  options: ReaderOptions = {},
) {
  const env = { ...environment };
  const admitted = admitProductionInputReader(
    env.PORTCOVE_CONTROLLER_ADMISSION,
    env,
    workflowBytes,
  );
  const expected = {
    audience: "portcove-release-input-reader-v1",
    subject: `repo:boburning/portcove:ref:${admitted.execution_ref}`,
    controller_revision: admitted.revision,
    controller_ref: admitted.execution_ref,
    actor_id: admitted.actor_id,
    run_id: admitted.run_id,
    run_attempt: admitted.run_attempt,
  };
  const token = await (options.requestToken ?? requestAssemblerToken)(expected.audience, env);
  const identity = await verifyReleaseInputReaderJobIdentity(
    token,
    expected,
    options.identity ?? { transport: { cwd: process.cwd() } },
  );
  return { admitted, identity };
}

/** No caller acceptance Boolean exists. Runtime establishment verifies the fixed
 * controller source, current consumer job, and the isolated observer producer.
 * A live observer is permitted only after runtime immutable artifact collection.
 * The observer's Administration-write credential never enters this process.
 */
export async function authenticateReleaseControlSource(
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  options: {
    identity?: ReaderIdentityOptions;
    requestToken?: typeof requestAssemblerToken;
    observerApi?: GitHubRestReader;
    now?: () => number;
    observedArtifact?: ObservedControlArtifact;
  } = {},
) {
  const env = { ...environment };
  const { admitted, identity } = await authenticateControlReaderJob(env, workflowBytes, options);
  const config = inspectReviewProducerConfiguration(json(env.PORTCOVE_REVIEW_PRODUCER, 4096));
  if (options.observedArtifact)
    requireObservedControlArtifact(options.observedArtifact, "observation");
  const handoff =
    options.observedArtifact?.body ?? json(env.PORTCOVE_TRUSTED_PROTECTION_OBSERVATION, 128 * 1024);
  exact(handoff, "observation,producer,schema_version");
  exact(
    handoff.producer,
    "check_run_id,controller_ref,controller_revision,job_id,run_attempt,run_id,workflow",
  );
  const producer = handoff.producer;
  if (
    handoff.schema_version !== 1 ||
    producer.workflow !== productionControllerWorkflow ||
    producer.controller_revision !== admitted.revision ||
    producer.controller_ref !== admitted.execution_ref ||
    producer.run_id !== admitted.run_id ||
    producer.run_attempt !== admitted.run_attempt ||
    typeof producer.job_id !== "number" ||
    !Number.isSafeInteger(producer.job_id) ||
    producer.job_id < 1 ||
    typeof producer.check_run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(producer.check_run_id)
  )
    throw new Error("protection handoff is not from this exact admitted controller attempt");
  if (identity.job_id === producer.job_id || identity.check_run_id === producer.check_run_id)
    throw new Error("protection observer and control reader must be separate jobs");
  const observerApi =
    options.observerApi ??
    new GitHubApiClient(
      createGitHubRunner({ cwd: process.cwd(), maxBuffer: 128 * 1024, timeoutMs: 15000 }),
    );
  const producerJobId = producer.job_id;
  const producerCheckRunId = producer.check_run_id;
  const producerReadback = () => {
    const response = observerApi.request(
      "GET",
      `repos/boburning/portcove/actions/jobs/${producerJobId}`,
    );
    const job = response.body;
    if (
      response.status !== 200 ||
      Buffer.byteLength(JSON.stringify(job)) > 128 * 1024 ||
      !isRecord(job) ||
      job.id !== producer.job_id ||
      String(job.run_id) !== admitted.run_id ||
      job.run_attempt !== admitted.run_attempt ||
      job.head_sha !== admitted.revision ||
      job.name !== "Observe production release input protections" ||
      !(
        (job.status === "completed" && job.conclusion === "success") ||
        (options.observedArtifact && job.status === "in_progress" && job.conclusion === null)
      ) ||
      job.check_run_url !==
        `https://api.github.com/repos/boburning/portcove/check-runs/${producerCheckRunId}`
    )
      throw new Error("completed isolated observer job is unavailable or differs");
    // An observer may finish after its immutable report upload. Bind stable
    // provider identity; a normal in-progress→success transition is permitted.
    return capacityDigest({
      id: job.id,
      run_id: job.run_id,
      run_attempt: job.run_attempt,
      head_sha: job.head_sha,
      name: job.name,
      check_run_url: job.check_run_url,
    });
  };
  const producerIdentity = producerReadback();
  const now = options.now ?? Date.now;
  const guard = () => {
    if (now() >= Date.parse(identity.expires_at))
      throw new Error("control reader identity expired");
    return requireReleaseInputWriterPolicy(handoff.observation, config.writer_app_id, now());
  };
  guard();
  const source = Object.freeze({
    evidence_scope:
      options.identity ||
      options.requestToken ||
      options.observerApi ||
      options.now ||
      identity.evidence_scope !== "github.com" ||
      options.observedArtifact?.evidence_scope === "injected-provider"
        ? "injected-provider"
        : "github.com",
    read(api: CoordinatorRemoteApi, opportunity: unknown) {
      const protection = guard();
      const classification = readReviewedClassification(api, config, opportunity);
      const pause = readPublicationPause(api);
      const capacity = readRatifiedCapacityConfiguration(api, guard);
      guard();
      if (producerReadback() !== producerIdentity)
        throw new Error("observer job changed during source acquisition");
      if (
        !isRecord(handoff.observation) ||
        !isRecord(handoff.observation.inventory) ||
        !Array.isArray(handoff.observation.inventory.branches)
      )
        throw new Error("protection source ref inventory unavailable");
      for (const [branch, commit] of [
        ["portcove-release-inputs", classification.commit],
        ["portcove-release-pause", pause.commit],
      ]) {
        const row: unknown = handoff.observation.inventory.branches.find(
          (item: unknown) => isRecord(item) && item.branch === branch,
        );
        if (
          !isRecord(row) ||
          !isRecord(row.ref) ||
          !isRecord(row.ref.object) ||
          row.ref.object.sha !== commit
        )
          throw new Error("authenticated protection observation and current control ref differ");
      }
      if (capacity.commit !== pause.commit)
        throw new Error("pause and capacity configuration ref changed");
      const facts = {
        classification: {
          commit: classification.commit,
          opportunity: classification.opportunity,
          review_check_id: classification.review_check_id,
        },
        pause: { commit: pause.commit, publication_paused: pause.publication_paused },
        capacity: { commit: capacity.commit, document_sha256: capacity.document_sha256 },
        protection,
      };
      return {
        ...facts,
        capacity_source: capacity,
        resource_policy_matches_controller:
          admitted.workflow_sha256 === slice4CapacityResources.aggregate_workflow_sha256,
        facts_sha256: capacityDigest(facts),
        authority: "none",
      };
    },
  });
  establishedSources.add(source);
  return source;
}
export type AuthenticatedReleaseControlSource = Awaited<
  ReturnType<typeof authenticateReleaseControlSource>
>;
