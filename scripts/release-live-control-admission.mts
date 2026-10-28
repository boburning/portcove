import { capacityDigest, slice4CapacityResources } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import {
  admitProductionInputReader,
  admitProductionCatalogInputReader,
  productionControllerWorkflow,
  readProductionControllerWorkflowBytes,
  admittedProductionObserverProfile,
} from "./production-controller-admission.mts";
import {
  requestAssemblerToken,
  controllerOidcSubject,
  verifyReleaseControlReaderJobIdentity,
  verifyReleaseInputReaderJobIdentity,
} from "./assembler-job-identity.mts";
import {
  requireReleaseInputWriterPolicy,
  requireFixedClassificationStoragePolicy,
  requireCatalogMaintenancePolicy,
  requireReleaseImmutabilityPolicy,
} from "./release-input-protections.mts";
import {
  inspectReviewProducerConfiguration,
  inspectCatalogReviewProducerConfiguration,
  readPublicationPause,
  readRatifiedCapacityConfiguration,
  readReviewedClassification,
  readReviewedClassificationForRequest,
} from "./release-control-inputs.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import {
  requireObservedControlArtifact,
  prepareControlReadiness,
  waitForControlArtifact,
} from "./release-control-handshake.mts";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { inspectControlRound } from "./release-control-handshake.mts";
import type { ObservedControlArtifact } from "./release-control-handshake.mts";
import {
  inspectReleaseControlPhase,
  releaseControlPhaseProfile,
  isMaintenanceReleaseControlPhase,
} from "./release-control-phases.mts";
import type { ReleaseControlPhase } from "./release-control-phases.mts";
import {
  inspectBoundCatalogControllerAuthorities,
  inspectBoundSelectedPublicationAuthorities,
  inspectBoundControllerAuthorities,
} from "./release-authority-configuration.mts";
import {
  discoverIndependentSemanticDisposition,
  readIndependentSemanticCheckInventory,
  inspectSemanticRequestCheckMatches,
} from "./release-semantic-disposition-reader.mts";
import { semanticReviewCheckName } from "./release-semantic-review.mts";
import { establishFixedClassificationPrincipal } from "./release-classification-principal.mts";
const establishedSources = new WeakSet<object>();
const catalogSources = new WeakSet<object>();
export function requireAuthenticatedCatalogControlSource(value: unknown, rawPhase: unknown) {
  const phase = inspectReleaseControlPhase(rawPhase);
  if (!isRecord(value) || !catalogSources.has(value) || value.phase !== phase)
    throw new Error("catalog control source must be established by fixed runtime verifier");
}
export function requireAuthenticatedReleaseControlSource(
  value: unknown,
  rawPhase: unknown = "admission",
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  if (!isRecord(value) || !establishedSources.has(value) || value.phase !== phase)
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

type ReaderIdentityOptions = Parameters<typeof verifyReleaseControlReaderJobIdentity>[3];
type ReaderOptions = {
  phase?: ReleaseControlPhase;
  identity?: ReaderIdentityOptions;
  requestToken?: typeof requestAssemblerToken;
  deadline?: number;
};
export async function authenticateControlReaderJob(
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  options: ReaderOptions = {},
) {
  return authenticateControlReaderJobForPurpose("application", environment, workflowBytes, options);
}
export async function authenticateCatalogControlReaderJob(
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  options: ReaderOptions = {},
) {
  return authenticateControlReaderJobForPurpose(
    "catalog-publication",
    environment,
    workflowBytes,
    options,
  );
}
async function authenticateControlReaderJobForPurpose(
  purpose: "application" | "catalog-publication",
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  options: ReaderOptions,
) {
  const env = { ...environment };
  const phase = inspectReleaseControlPhase(options.phase);
  const profile = releaseControlPhaseProfile(phase);
  const admitted = (
    purpose === "application" ? admitProductionInputReader : admitProductionCatalogInputReader
  )(
    purpose === "application"
      ? env.PORTCOVE_CONTROLLER_ADMISSION
      : env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION,
    env,
    workflowBytes,
    phase,
  );
  const readOnlyAdmission = phase === "admission" && admitted.mode === "admission-only";
  const expected = {
    audience: profile.reader_audience,
    subject: controllerOidcSubject(
      admitted.execution_ref,
      readOnlyAdmission ? undefined : profile.reader_environment,
    ),
    controller_revision: admitted.revision,
    controller_ref: admitted.execution_ref,
    actor_id: admitted.actor_id,
    run_id: admitted.run_id,
    run_attempt: admitted.run_attempt,
  };
  const token = await (options.requestToken ?? requestAssemblerToken)(
    expected.audience,
    env,
    fetch,
    options.deadline,
  );
  const identityOptions = {
    ...options.identity,
    transport: {
      ...(options.identity?.transport ?? { cwd: process.cwd() }),
      ...(options.deadline === undefined
        ? {}
        : {
            deadline: Math.min(options.deadline, options.identity?.transport?.deadline ?? Infinity),
          }),
    },
  };
  const identity = readOnlyAdmission
    ? await verifyReleaseInputReaderJobIdentity(token, expected, identityOptions)
    : await verifyReleaseControlReaderJobIdentity(phase, token, expected, identityOptions);
  return { admitted, identity };
}

/** No caller acceptance Boolean exists. Runtime establishment verifies the fixed
 * controller source, current consumer job, and the isolated observer producer.
 * A live observer is permitted only after runtime immutable artifact collection.
 * The observer's Administration-write credential never enters this process.
 */
async function authenticateControlSource(
  purpose: "application" | "catalog-publication",
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  options: {
    phase?: ReleaseControlPhase;
    identity?: ReaderIdentityOptions;
    requestToken?: typeof requestAssemblerToken;
    observerApi?: GitHubRestReader;
    observerTransport?: Pick<NonNullable<Parameters<typeof createGitHubRunner>[0]>, "spawn">;
    now?: () => number;
    observedArtifact?: ObservedControlArtifact;
    round?: { index: number; nonce: string };
    deadline?: number;
  } = {},
) {
  const phaseDeadline = options.deadline;
  const remaining = () => {
    const left =
      phaseDeadline === undefined ? 15000 : Math.floor(phaseDeadline - performance.now());
    if (!Number.isFinite(left) || left < 1 || (phaseDeadline !== undefined && left > 600000))
      throw new Error("release controls phase deadline exhausted");
    return Math.min(15000, left);
  };
  remaining();
  const env = { ...environment };
  const phase = inspectReleaseControlPhase(options.phase);
  const { admitted, identity } = await authenticateControlReaderJobForPurpose(
    purpose,
    env,
    workflowBytes,
    options,
  );
  const applicationAuthorities = (() => {
    if (purpose !== "application" || admitted.mode === "admission-only") return null;
    const raw = json(env.PORTCOVE_RELEASE_AUTHORITIES, 32768);
    if (isRecord(raw) && (raw.schema_version === 4 || raw.kind === "two-app-fixed-jobs-v1"))
      return {
        kind: "selected" as const,
        principal: establishFixedClassificationPrincipal(
          raw,
          admitted,
          identity,
          phase,
          (options.now ?? Date.now)(),
        ),
      };
    return {
      kind: "legacy" as const,
      authorities: inspectBoundControllerAuthorities(JSON.stringify(raw), admitted),
    };
  })();
  const selectedApplication =
    applicationAuthorities?.kind === "selected" ? applicationAuthorities.principal : null;
  const legacyApplication =
    applicationAuthorities?.kind === "legacy" ? applicationAuthorities.authorities : null;
  const applicationConfig =
    purpose === "application"
      ? (selectedApplication?.producer ??
        inspectReviewProducerConfiguration(json(env.PORTCOVE_REVIEW_PRODUCER, 4096)))
      : null;
  if (
    legacyApplication !== null &&
    applicationConfig !== null &&
    (applicationConfig.review_app_id !== legacyApplication.apps.semantic.app_id ||
      !("writer_app_id" in applicationConfig) ||
      applicationConfig.writer_app_id !== legacyApplication.apps.classification.app_id)
  )
    throw new Error("application producer roles differ from complete bound authority");
  const catalogAppId = () => {
    const raw = json(env.PORTCOVE_CATALOG_AUTHORITIES, 32 * 1024);
    if (isRecord(raw) && raw.schema_version === 4) {
      const selected = inspectBoundSelectedPublicationAuthorities(
        raw,
        admitted,
        "catalog-publication",
      ).configuration;
      if (selected.purpose !== "catalog-publication")
        throw new Error("catalog control source purpose differs");
      return selected.journal.apps.semantic.app_id;
    }
    return inspectBoundCatalogControllerAuthorities(raw, admitted).apps.semantic.app_id;
  };
  const config =
    applicationConfig ??
    inspectCatalogReviewProducerConfiguration({
      schema_version: 2,
      purpose: "catalog-publication",
      review_app_id: catalogAppId(),
      review_check_name: semanticReviewCheckName,
    });
  if (options.round && !options.observedArtifact)
    throw new Error("control rounds require actual collected observer artifact");
  if (options.observedArtifact)
    requireObservedControlArtifact(options.observedArtifact, "observation", phase);
  const handoff =
    options.observedArtifact?.body ?? json(env.PORTCOVE_TRUSTED_PROTECTION_OBSERVATION, 128 * 1024);
  exact(
    handoff,
    options.round
      ? "observation,phase,producer,round,schema_version"
      : "observation,phase,producer,schema_version",
  );
  if (
    options.round &&
    JSON.stringify(inspectControlRound(handoff.round)) !==
      JSON.stringify(inspectControlRound(options.round))
  )
    throw new Error("observed protection round differs from the private continuation");
  exact(
    handoff.producer,
    "check_run_id,controller_ref,controller_revision,job_id,run_attempt,run_id,workflow",
  );
  const producer = handoff.producer;
  if (
    handoff.schema_version !== 1 ||
    handoff.phase !== phase ||
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
    new GitHubApiClient((args, input) =>
      createGitHubRunner({
        ...options.observerTransport,
        cwd: process.cwd(),
        maxBuffer: 128 * 1024,
        timeoutMs: remaining(),
      })([...args, "--hostname", "github.com"], input),
    );
  const producerJobId = producer.job_id;
  const producerCheckRunId = producer.check_run_id;
  const producerReadback = () => {
    remaining();
    const response = observerApi.request(
      "GET",
      `repos/boburning/portcove/actions/jobs/${producerJobId}`,
    );
    remaining();
    const job = response.body;
    if (
      response.status !== 200 ||
      Buffer.byteLength(JSON.stringify(job)) > 128 * 1024 ||
      !isRecord(job) ||
      job.id !== producer.job_id ||
      String(job.run_id) !== admitted.run_id ||
      job.run_attempt !== admitted.run_attempt ||
      job.head_sha !== admitted.revision ||
      job.name !== admittedProductionObserverProfile(admitted, phase).name ||
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
    remaining();
    if (now() >= Date.parse(identity.expires_at))
      throw new Error("control reader identity expired");
    const policy = (() => {
      if (purpose === "catalog-publication")
        return requireCatalogMaintenancePolicy(handoff.observation, admitted.execution_ref, now());
      if (applicationConfig === null)
        throw new Error("application classification writer identity unavailable");
      if (selectedApplication !== null)
        return requireFixedClassificationStoragePolicy(
          handoff.observation,
          selectedApplication,
          now(),
        );
      if (!("writer_app_id" in applicationConfig))
        throw new Error("legacy application writer identity unavailable");
      return requireReleaseInputWriterPolicy(
        handoff.observation,
        applicationConfig.writer_app_id,
        now(),
      );
    })();
    return {
      ...policy,
      ...(phase === "release-publication"
        ? { release_immutability: requireReleaseImmutabilityPolicy(handoff.observation, now()) }
        : {}),
    };
  };
  guard();
  const requireObservedRefs = (refs: readonly (readonly [string, string])[]) => {
    if (
      !isRecord(handoff.observation) ||
      !isRecord(handoff.observation.inventory) ||
      !Array.isArray(handoff.observation.inventory.branches)
    )
      throw new Error("protection source ref inventory unavailable");
    for (const [branch, commit] of refs) {
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
  };
  const readerFacts = Object.freeze({
    job_id: identity.job_id,
    check_run_id: identity.check_run_id,
    run_id: admitted.run_id,
    run_attempt: admitted.run_attempt,
    controller_revision: admitted.revision,
    controller_ref: admitted.execution_ref,
    expires_at: identity.expires_at,
    scope: "oidc-job-identity-only",
    ...(options.round ? { round: inspectControlRound(options.round) } : {}),
  });
  const source = Object.freeze({
    phase,
    evidence_scope:
      options.identity ||
      options.requestToken ||
      options.observerApi ||
      options.observerTransport ||
      options.now ||
      identity.evidence_scope !== "github.com" ||
      options.observedArtifact?.evidence_scope === "injected-provider"
        ? "injected-provider"
        : "github.com",
    readMaintenance(api: CoordinatorRemoteApi) {
      if (!(purpose === "catalog-publication" || isMaintenanceReleaseControlPhase(phase)))
        throw new Error("metadata controls require a fixed maintenance signing/publication phase");
      const protection = guard();
      const pause = readPublicationPause(api);
      const capacity = readRatifiedCapacityConfiguration(api, guard);
      guard();
      if (producerReadback() !== producerIdentity)
        throw new Error("observer job changed during maintenance acquisition");
      requireObservedRefs([["portcove-release-pause", pause.commit]]);
      if (capacity.commit !== pause.commit)
        throw new Error("pause and capacity configuration ref changed");
      guard();
      const facts = {
        phase,
        purpose:
          purpose === "catalog-publication"
            ? phase === "coordinator"
              ? "catalog-coordinator-controls"
              : phase === "site-publication"
                ? "catalog-site-publication-controls"
                : "catalog-signing-controls"
            : phase === "site-publication"
              ? "metadata-renewal"
              : phase === "coordinator"
                ? "metadata-coordinator-controls"
                : "metadata-signing-controls",
        reader: readerFacts,
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
    readDisposition(api: CoordinatorRemoteApi, request: unknown) {
      if (purpose !== "application")
        throw new Error("catalog controls cannot persist application disposition");
      if (phase !== "coordinator")
        throw new Error("semantic retirement requires the fixed coordinator controls");
      const maintenance = source.readMaintenance(api);
      const disposition = discoverIndependentSemanticDisposition(api, config, request);
      guard();
      if (producerReadback() !== producerIdentity)
        throw new Error("observer job changed during semantic disposition readback");
      return {
        ...maintenance,
        disposition,
        facts_sha256: capacityDigest({
          control_facts_sha256: maintenance.facts_sha256,
          disposition,
        }),
      };
    },
    readRequest(api: CoordinatorRemoteApi, request: unknown) {
      if (purpose !== "application")
        throw new Error("catalog controls cannot classify application request");
      if (phase !== "coordinator")
        throw new Error("request classification requires fixed coordinator controls");
      const maintenance = source.readMaintenance(api);
      const classification = readReviewedClassificationForRequest(api, config, request);
      requireObservedRefs([["portcove-release-inputs", classification.commit]]);
      if (classification.status === "reviewed") {
        const checks = readIndependentSemanticCheckInventory(
          api,
          config,
          classification.opportunity.source_commit,
        );
        const matches = inspectSemanticRequestCheckMatches(checks.records, request);
        if (
          matches.accepted.length !== 1 ||
          matches.negative.length !== 0 ||
          matches.accepted[0]!.check_run_id !== classification.review_check_id
        )
          throw new Error(
            "persisted request classification conflicts with complete independent Check inventory",
          );
        checks.assertUnchanged();
      }
      guard();
      if (producerReadback() !== producerIdentity)
        throw new Error("observer changed during request classification read");
      return {
        ...maintenance,
        classification,
        facts_sha256: capacityDigest({
          control_facts_sha256: maintenance.facts_sha256,
          classification:
            classification.status === "reviewed"
              ? {
                  status: classification.status,
                  commit: classification.commit,
                  opportunity: classification.opportunity,
                  review_check_id: classification.review_check_id,
                }
              : classification,
        }),
      };
    },
    read(api: CoordinatorRemoteApi, opportunity: unknown) {
      if (purpose !== "application")
        throw new Error("catalog controls cannot read application classification");
      const protection = guard();
      const classification = readReviewedClassification(api, config, opportunity);
      const pause = readPublicationPause(api);
      const capacity = readRatifiedCapacityConfiguration(api, guard);
      guard();
      if (producerReadback() !== producerIdentity)
        throw new Error("observer job changed during source acquisition");
      requireObservedRefs([
        ["portcove-release-inputs", classification.commit],
        ["portcove-release-pause", pause.commit],
      ]);
      if (capacity.commit !== pause.commit)
        throw new Error("pause and capacity configuration ref changed");
      // The final observer GET can itself cross the observation/identity window.
      // Reusing this authenticated round never refreshes its original clock.
      guard();
      const facts = {
        phase,
        reader: readerFacts,
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
  (purpose === "application" ? establishedSources : catalogSources).add(source);
  return source;
}
export function authenticateReleaseControlSource(
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  options: Parameters<typeof authenticateControlSource>[3] = {},
) {
  return authenticateControlSource("application", environment, workflowBytes, options);
}
export function authenticateCatalogReleaseControlSource(
  environment: NodeJS.ProcessEnv,
  workflowBytes: Uint8Array,
  options: Parameters<typeof authenticateControlSource>[3] = {},
) {
  return authenticateControlSource("catalog-publication", environment, workflowBytes, options);
}
export type AuthenticatedReleaseControlSource = Awaited<
  ReturnType<typeof authenticateReleaseControlSource>
>;

/** One fixed-job continuation round. The caller prepares immutable bytes first;
 * its reviewed workflow uploads only this ready file while this process waits.
 * Every later protected operation needs a new ordinal/nonce, never an overwrite
 * or a relaxed protection freshness window. No credential enters this helper. */
async function authenticateControlRoundForPurpose(
  purpose: "application" | "catalog-publication",
  directory: string,
  factsSha256: string,
  rawPhase: unknown,
  index: number,
  options: { deadline?: number } = {},
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  const round = { index, nonce: randomBytes(32).toString("hex") };
  inspectControlRound(round);
  if (!path.isAbsolute(directory) || !/^[a-f0-9]{64}$/u.test(factsSha256))
    throw new Error("private round directory and exact prepared facts required");
  const env = { ...process.env };
  const deadlineOption = options.deadline === undefined ? {} : { deadline: options.deadline };
  const workflow = await readProductionControllerWorkflowBytes();
  const reader = await authenticateControlReaderJobForPurpose(purpose, env, workflow, {
    phase,
    ...deadlineOption,
  });
  if (reader.identity.evidence_scope !== "github.com") throw new Error("actual reader required");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(
    path.join(directory, `ready-${phase}.json`),
    JSON.stringify(prepareControlReadiness(reader.identity, factsSha256, phase, round)),
    { flag: "wx", mode: 0o600 },
  );
  await (
    await import("./release-control-step-bridge.mts")
  ).retainControlStepLocator(path.join(directory, `ready-${phase}.json`), phase, index);
  const observedArtifact = await waitForControlArtifact(
    directory,
    "observation",
    {
      phase,
      round,
      controller_revision: reader.admitted.revision,
      controller_ref: reader.admitted.execution_ref,
      run_id: String(reader.admitted.run_id),
      run_attempt: reader.admitted.run_attempt,
    },
    options.deadline === undefined ? {} : { phaseDeadline: options.deadline },
  );
  return authenticateControlSource(purpose, env, workflow, {
    phase,
    round,
    observedArtifact,
    ...deadlineOption,
  });
}
export function authenticateReleaseControlRound(
  directory: string,
  factsSha256: string,
  rawPhase: unknown,
  index: number,
  options: { deadline?: number } = {},
) {
  return authenticateControlRoundForPurpose(
    "application",
    directory,
    factsSha256,
    rawPhase,
    index,
    options,
  );
}
export function authenticateCatalogReleaseControlRound(
  directory: string,
  factsSha256: string,
  rawPhase: unknown,
  index: number,
  options: { deadline?: number } = {},
) {
  return authenticateControlRoundForPurpose(
    "catalog-publication",
    directory,
    factsSha256,
    rawPhase,
    index,
    options,
  );
}
