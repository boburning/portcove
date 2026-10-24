/** Fixed same-process payload→published-prior→new-record context continuation.
 * This creates pre-sign custody only; TUF roles and publication remain gated. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  runPayloadSigningController,
  requirePreparedPayloadSignatures,
  payloadSigningPhaseDeadline,
  nextPreparedPayloadControlRound,
  tightenPayloadSigningPhaseDeadline,
} from "./release-payload-preparation.mts";
import {
  prepareControllerReleaseSigningContext,
  requireReleaseSigningContext,
} from "./release-signing-context.mts";
import {
  prepareSigningContextArtifact,
  handoffSigningContextArtifact,
  signingContextRemaining,
} from "./release-signing-context-artifact.mts";
import {
  authenticateCapacityExecutor,
  executeOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import { requireControllerApplicationJobPublicationAuthorities } from "./release-authority-configuration.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { receiveControllerTools } from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { inspectPayloadPreparationConfiguration } from "./release-payload-preparation.mts";
import { authenticateReleaseControlRound } from "./release-live-control-admission.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { releaseControlRefQuery } from "./release-control-inputs.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import { requireReservedAggregate } from "./production-aggregate-steps.mts";
import { isRecord } from "./runtime-values.mts";
import { currentPayloadJobDeadline } from "./release-signing-job-budget.mts";

export async function runPayloadSigningAndContextController(
  configuration: unknown,
  rawIdentity: unknown,
  toolsReceipt: object,
  nativeLocators: unknown,
) {
  const identity = inspectAssemblerIdentityExpectation(structuredClone(rawIdentity));
  // This is the existing actual admitted signer, not a raw signing utility.
  // Nonpositive results stop here and never manufacture context or pending.
  const payload = await runPayloadSigningController(
    configuration,
    identity,
    toolsReceipt,
    nativeLocators,
  );
  if (payload.decision !== "signed") return payload;
  const deadline = payloadSigningPhaseDeadline();
  signingContextRemaining(deadline, 15000);
  const signed = await requirePreparedPayloadSignatures(payload);
  const authorities = await requireControllerApplicationJobPublicationAuthorities("payload");
  const directory = path.dirname(signed.public_key.path);
  const contextReceipt = await prepareControllerReleaseSigningContext(payload, directory, deadline);
  const context = await requireReleaseSigningContext(contextReceipt);
  const upload = await prepareSigningContextArtifact(contextReceipt, directory);
  const coordinator = { schema_version: 1, namespace: authorities.namespace };
  const executor = await authenticateCapacityExecutor(
    "payload-signing",
    { ...identity, audience: "portcove-capacity-executor" },
    directory,
    deadline,
  );
  let currentCheckpoint = context.settled_checkpoint;
  const admitted = context.control_facts;
  if (!isRecord(admitted))
    throw new Error("actual admitted context control projection unavailable");
  const fresh = async () => {
    signingContextRemaining(deadline, 15000);
    await verifiedControllerToolPaths(toolsReceipt);
    await requireReleaseSigningContext(contextReceipt);
    const round = await nextPreparedPayloadControlRound(payload);
    const source = await authenticateReleaseControlRound(
      path.join(directory, `payload-controls-r${round}`),
      digest(context.facts),
      "payload",
      round,
      { deadline },
    );
    if (source.evidence_scope !== "github.com")
      throw new Error("actual payload context controls required");
    let requests = 0;
    const api = new GitHubApiClient((args, input) => {
      if (++requests > 32) throw new Error("context control read bound exhausted");
      const response = createGitHubRunner({
        cwd: directory,
        maxBuffer: 2 * 1024 ** 2,
        timeoutMs: signingContextRemaining(deadline, 15000),
      })([...args, "--hostname", "github.com"], input);
      signingContextRemaining(deadline, 15000);
      return response;
    });
    const current = source.read(
      {
        request(method, endpoint, body) {
          if (
            method !== "GET" ||
            body !== undefined ||
            !endpoint.startsWith("repos/boburning/portcove/")
          )
            throw new Error("context controls permit only fixed repository reads");
          return api.request(method, endpoint);
        },
        graphql(query, variables) {
          if (query !== releaseControlRefQuery) throw new Error("context control query differs");
          return api.graphql(query, variables);
        },
      },
      context.opportunity,
    );
    if (
      current.pause.publication_paused ||
      !current.resource_policy_matches_controller ||
      !isDeepStrictEqual(current.classification, admitted.classification) ||
      !isDeepStrictEqual(current.pause, admitted.pause) ||
      !isDeepStrictEqual(current.capacity, admitted.capacity)
    )
      throw new Error("current context controls differ from actual admission");
    return current;
  };
  const guard = async () => {
    await fresh();
    const snapshot = await readRemoteCoordinatorSnapshot(directory, coordinator, {
      transport: { cwd: directory, deadline },
    });
    await requireReservedAggregate(
      JSON.stringify({
        schema_version: 1,
        checkpoint: currentCheckpoint,
        coordinator,
        assembly: context.facts.assembly,
        archives: context.facts.archives,
        evidence: {},
      }),
      snapshot,
    );
    signingContextRemaining(deadline, 15000);
  };
  await guard();
  let handoff: Awaited<ReturnType<typeof handoffSigningContextArtifact>> | undefined;
  // A second fixed output has its own existing durable pending operation.
  // The signature operation is already settled before record construction.
  const settlement = await executeOwnedCapacityEffect(
    executor,
    {
      repository: context.coordinator_repository,
      checkpoint: currentCheckpoint,
      remote_configuration: coordinator,
      request: {
        kind: "upload",
        destination: `github-actions:boburning/portcove:${context.binding.version}:payload-signing-context`,
      },
    },
    async () => (await fresh()).capacity_source.capacity.boundary,
    async (pending) => {
      currentCheckpoint = pending.checkpoint;
      await guard();
      handoff = await handoffSigningContextArtifact(upload, identity, pending, deadline);
      await guard();
      return {
        remote_identity: `github-actions:boburning/portcove:artifact:${handoff.artifact_id}`,
        evidence_sha256: digest(handoff),
      };
    },
  );
  if (!handoff) throw new Error("actual context artifact custody missing");
  signingContextRemaining(deadline, 15000);
  return Object.freeze({
    decision: "payload-and-context-prepared",
    payload,
    context_receipt: contextReceipt,
    context_upload: handoff,
    settlement,
    pending_obligations: [
      "context-attestation",
      "five-isolated-TUF-roles",
      "actual-post-sign-qualification",
      "publication-admission",
    ],
    authority: "none",
  });
}

export async function runFixedPayloadContextConfiguration(
  raw: unknown,
  parent: string,
  deadline: number,
) {
  tightenPayloadSigningPhaseDeadline(deadline);
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "configuration,native_locators,signer_identity,tools" ||
    !isRecord(raw.configuration) ||
    !isRecord(raw.tools) ||
    Object.keys(raw.tools).sort().join(",") !== "artifact,bundle" ||
    !isRecord(raw.tools.artifact) ||
    !isRecord(raw.tools.bundle)
  )
    throw new Error("fixed payload/context caller fields differ");
  tightenPayloadSigningPhaseDeadline(
    currentPayloadJobDeadline(
      inspectAssemblerIdentityExpectation(raw.signer_identity),
      parent,
      payloadSigningPhaseDeadline(),
    ),
  );
  const toolsReceipt = await receiveControllerTools(
    parent,
    raw.tools.artifact as unknown as ControllerToolArtifactExpected,
    raw.tools.bundle as unknown as { artifact_id: number; sha256: string },
    { deadline: payloadSigningPhaseDeadline() },
  );
  const tools = await verifiedControllerToolPaths(toolsReceipt);
  await mkdir(path.join(tools.root, "work"), { mode: 0o700 });
  const configuration = inspectPayloadPreparationConfiguration({
    ...raw.configuration,
    projectRoot: tools.root,
    output: path.join(tools.root, "work", "payload-preparation"),
    publicKey: path.join(tools.root, "work", "admitted-public.key"),
  });
  return runPayloadSigningAndContextController(
    configuration,
    raw.signer_identity,
    toolsReceipt,
    raw.native_locators,
  );
}

if (
  process.argv[1] &&
  /^release-signing-controller(?:\.mts|(?:\.bundle)?\.mjs)$/u.test(
    path.basename(process.argv[1]),
  ) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3) throw new Error("fixed payload/context configuration required");
    const raw: unknown = JSON.parse(
      (await readControllerToolFile(process.argv[2]!, 65536)).toString("utf8"),
    );
    const result = await runFixedPayloadContextConfiguration(
      raw,
      fileURLToPath(new URL("..", import.meta.url)),
      payloadSigningPhaseDeadline(),
    );
    process.exitCode = result.decision === "payload-and-context-prepared" ? 0 : 2;
  } catch {
    console.error(
      "fixed payload/context controller refused; retain bounded public preparation evidence",
    );
    process.exitCode = 2;
  } finally {
    if (process.env.RUNNER_TEMP)
      await writeFile(
        path.join(process.env.RUNNER_TEMP, "payload-context-process-ended.json"),
        JSON.stringify({ exit_code: process.exitCode ?? 0, authority: "none" }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {
        process.exitCode = 2;
      });
  }
}
