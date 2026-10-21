/** Fixed actual immutable Release continuation. Protected effects remain behind
 * current admission, native/compiler/SPDX, own-job identity and durable intent. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  acquirePublicationControllerAdmission,
  requireActualPublicationControllerContext,
} from "./acquire-release-admission.mts";
import {
  verifiedControllerToolPaths,
  receiveControllerTools,
} from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  requireReceivedSigningContext,
  receiveSigningContextArtifact,
} from "./release-signing-context-artifact.mts";
import type { SigningContextArtifactExpected } from "./release-signing-context-artifact.mts";
import { receiveTufRoleArtifact } from "./release-tuf-role-artifact.mts";
import { prepareActualTufPublication } from "./release-tuf-publication.mts";
import { inspectReleaseCompilerSourceClosure } from "./release-compiler-source-closure.mts";
import { requireControllerReleaseAuthorities } from "./release-authority-configuration.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import { collectConfiguredNativePublicationQualificationPair } from "./release-native-publication-admission.mts";
import { inspectControllerAggregateLocator } from "./release-payload-preparation.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { readVerifiedReleasePublicBuildInputFiles } from "./release-public-build-provenance.mts";
import { requireVerifiedReleaseSbomDocument } from "./release-acceptance-evidence.mts";
import {
  prepareImmutableReleasePublication,
  rebindPreparedImmutableReleaseAfterPhase,
  advanceOwnedImmutableReleasePublication,
  observeOwnedImmutableReleaseCompletion,
} from "./release-immutable-publication.mts";
import { materializePublicationSourceRepository } from "./release-publication-source.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import { recoverReleaseOpportunity } from "./release-coordinator-state.mts";
import {
  advanceActualCandidateToPublishing,
  advanceActualCandidateToPromoting,
  requireActualCandidatePhaseAdvance,
} from "./release-candidate-progress.mts";
import {
  authenticateCapacityExecutor,
  executeOwnedCapacityEffect,
  refreshCapacityExecutor,
} from "./release-capacity-executor.mts";
import { authenticateReleaseControlRound } from "./release-live-control-admission.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import {
  prepareOwnedPublicationResult,
  requireOwnedPublicationResult,
} from "./release-publication-result.mts";
import { handoffPublicationResultArtifact } from "./release-publication-result-artifact.mts";
import { finalizeReleaseAssets } from "./finalize-release-assets.mts";
import {
  withCoordinatorDeadline,
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { publicationUploadCommand } from "./release-publication-handoff.mts";
import { inspectCapacityOperation } from "./release-capacity.mts";
import type { ParsedCapacityOperation } from "./release-capacity.mts";

const started = performance.now();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function publicationResultDestination(candidate: Record<string, unknown>) {
  const transient = candidate.transient_retries,
    substantive = candidate.substantive_repairs;
  if (
    typeof candidate.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(candidate.version) ||
    !Number.isSafeInteger(transient) ||
    Number(transient) < 0 ||
    Number(transient) > 2 ||
    !Number.isSafeInteger(substantive) ||
    Number(substantive) < 0 ||
    Number(substantive) > 3
  )
    throw new Error("publication result bounded attempt unavailable");
  return (
    `github-actions:boburning/portcove:${candidate.version}:immutable-release-result` +
    (Number(transient) + Number(substantive) > 0
      ? `:recovery-${String(transient)}-${String(substantive)}`
      : "")
  );
}
/** Public journal locator only; the actual path must still perform provider GET
 * and this never authenticates a completed-success attestation. */
export function inspectRetainedResultUpload(
  operation: ParsedCapacityOperation | null,
  candidate: Record<string, unknown>,
) {
  if (operation?.destination !== publicationResultDestination(candidate)) return null;
  if (
    operation.kind !== "upload" ||
    operation.outcome !== "recovered" ||
    !isRecord(operation.recovery) ||
    operation.recovery.resolution !== "effect-completed" ||
    operation.receipt_limit !== 1 ||
    operation.completed_effects.length !== 1 ||
    !operation.executor_identity ||
    operation.executor_identity.role !== "release-publication" ||
    digest(operation.candidate) !==
      digest(
        Object.fromEntries(
          [
            "source_commit",
            "prepared_commit",
            "version",
            "transient_retries",
            "substantive_repairs",
          ].map((key) => [key, candidate[key]]),
        ),
      )
  )
    throw new Error("result upload unresolved or differs; recover exact original effect");
  const identity = operation.completed_effects[0]!.remote_identity.match(
    /^github-actions:boburning\/portcove:artifact:([1-9][0-9]{0,15})$/u,
  );
  if (!identity || !Number.isSafeInteger(Number(identity[1])))
    throw new Error("retained result artifact identity unavailable");
  return { artifact_id: Number(identity[1]), executor: operation.executor_identity };
}
/** Budget derivation only. Actual fixed-job authentication follows separately. */
export function publicationOriginalJobDeadline(
  raw: unknown,
  identity: { run_id: string; controller_revision: string },
  now = Date.now(),
  monotonic = performance.now(),
) {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.jobs) ||
    !Number.isSafeInteger(raw.total_count) ||
    Number(raw.total_count) < 1 ||
    Number(raw.total_count) > 100 ||
    raw.jobs.length !== raw.total_count
  )
    throw new Error("complete publication job inventory required");
  const ids = new Set<number>();
  for (const job of raw.jobs as unknown[]) {
    if (
      !isRecord(job) ||
      typeof job.id !== "number" ||
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      ids.has(job.id)
    )
      throw new Error("publication job inventory duplicated or incomplete");
    ids.add(job.id);
  }
  const matches = raw.jobs.filter(
    (job: unknown) => isRecord(job) && job.name === "Publish immutable application release",
  );
  const job: unknown = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(job) ||
    String(job.run_id) !== identity.run_id ||
    job.run_attempt !== 1 ||
    job.head_sha !== identity.controller_revision ||
    job.status !== "in_progress" ||
    typeof job.started_at !== "string"
  )
    throw new Error("actual publication job start unavailable");
  const remaining = Date.parse(job.started_at) + 350000 - now;
  if (
    !Number.isFinite(remaining) ||
    remaining <= 0 ||
    remaining > 350000 ||
    !Number.isFinite(monotonic)
  )
    throw new Error("original publication job budget exhausted or future dated");
  return monotonic + remaining;
}
function currentPublicationJobDeadline(
  root: string,
  identity: { run_id: string; controller_revision: string },
) {
  if (
    !/^[1-9][0-9]{0,15}$/u.test(identity.run_id) ||
    !/^[a-f0-9]{40}$/u.test(identity.controller_revision)
  )
    throw new Error("fixed publication run identity missing");
  const api = new GitHubApiClient((args, input) =>
    createGitHubRunner({ cwd: root, timeoutMs: 15000, maxBuffer: 2 * 1024 ** 2 })(
      [...args, "--hostname", "github.com"],
      input,
    ),
  );
  const response = api.request(
    "GET",
    `repos/boburning/portcove/actions/runs/${identity.run_id}/attempts/1/jobs?per_page=100`,
  );
  if (response.status !== 200) throw new Error("publication original job budget unavailable");
  return Math.min(started + 350000, publicationOriginalJobDeadline(response.body, identity));
}

async function runFixedPublicationEntry(filename: string) {
  const raw: unknown = JSON.parse((await readControllerToolFile(filename, 65536)).toString("utf8"));
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "configuration,context,identity,roles,tools" ||
    !isRecord(raw.tools) ||
    Object.keys(raw.tools).sort().join(",") !== "artifact,bundle" ||
    !isRecord(raw.tools.artifact) ||
    !isRecord(raw.tools.bundle) ||
    !Array.isArray(raw.roles) ||
    raw.roles.length !== 5
  )
    throw new Error("fixed actual publication input configuration required");
  const identity = inspectAssemblerIdentityExpectation(raw.identity);
  if (
    identity.run_id !== process.env.GITHUB_RUN_ID ||
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    identity.controller_revision !== process.env.GITHUB_SHA ||
    identity.controller_ref !== process.env.GITHUB_REF
  )
    throw new Error("publication invocation is not the original fixed job");
  const root = process.env.RUNNER_TEMP;
  if (!root || !path.isAbsolute(root)) throw new Error("fixed private runner root required");
  const deadline = currentPublicationJobDeadline(root, identity);
  const toolsInput = raw.tools;
  return withCoordinatorDeadline(deadline, async () => {
    const directory = await mkdtemp(path.join(root, "publication-controller-bootstrap-"));
    const toolsReceipt = await receiveControllerTools(
      directory,
      toolsInput.artifact as ControllerToolArtifactExpected,
      toolsInput.bundle as { artifact_id: number; sha256: string },
      { deadline },
    );
    const context = await receiveSigningContextArtifact(
      directory,
      raw.context as SigningContextArtifactExpected,
      deadline,
    );
    const roles = [];
    const expectedRoles = ["releases", "preview", "stable", "snapshot", "timestamp"];
    for (const [index, expected] of (raw.roles as unknown[]).entries()) {
      if (!isRecord(expected) || expected.role !== expectedRoles[index])
        throw new Error("fixed five role order differs");
      roles.push(await receiveTufRoleArtifact(context, directory, expected, deadline));
    }
    const publication = await prepareActualTufPublication(
      context,
      toolsReceipt,
      roles,
      directory,
      deadline,
    );
    const result = await runReleasePublicationController(
      raw.configuration,
      identity,
      toolsReceipt,
      context,
      publication,
      directory,
      deadline,
    );
    console.log(JSON.stringify(result));
    if (!isRecord(result) || result.decision !== "immutable-release-and-result-prepared")
      process.exitCode = 2;
  });
}
/** Exact successful logical effects are different operations, never retries.
 * A refused/ambiguous step throws out of this finite sequence immediately. */
export async function runDistinctPublicationEffects(
  step: (ordinal: number) => Promise<{ decision: string; effect?: { destination: string } }>,
) {
  const seen = new Set<string>();
  for (let ordinal = 1; ordinal <= 12; ordinal++) {
    const result = await step(ordinal);
    if (result.decision === "complete") return { effects: seen.size };
    if (
      result.decision !== "effect-observed" ||
      !result.effect ||
      seen.has(result.effect.destination)
    )
      throw new Error("publication sequence refused, repeated or ambiguous; no further effect");
    seen.add(result.effect.destination);
  }
  return { effects: seen.size };
}

export async function runReleasePublicationController(
  raw: unknown,
  rawIdentity: unknown,
  toolsReceipt: object,
  contextReceipt: object,
  tufPublication: object,
  outputParent: string,
  phaseDeadline?: number,
) {
  const deadline = Math.min(started + 350000, phaseDeadline ?? Infinity);
  return withCoordinatorDeadline(deadline, async () => {
    const configuration: unknown = structuredClone(raw);
    if (
      !isRecord(configuration) ||
      Object.keys(configuration).sort().join(",") !==
        "admission_configuration,aggregate,native_locators" ||
      !isRecord(configuration.admission_configuration) ||
      !isRecord(configuration.aggregate) ||
      !path.isAbsolute(outputParent)
    )
      throw new Error("fixed publication configuration required");
    const identity = inspectAssemblerIdentityExpectation(structuredClone(rawIdentity));
    const tools = await verifiedControllerToolPaths(toolsReceipt);
    const context = await requireReceivedSigningContext(contextReceipt, deadline);
    const aggregate = inspectControllerAggregateLocator(configuration.aggregate);
    const nativeLocators = configuration.native_locators;
    const contextFacts = context.manifest.facts;
    const producer = context.manifest.controller;
    const binding = context.manifest.binding;
    if (!isRecord(contextFacts) || !isRecord(producer) || !isRecord(binding))
      throw new Error("complete authenticated payload context facts unavailable");
    const authorities = await requireControllerReleaseAuthorities("release-publication");
    if (
      configuration.admission_configuration.namespace !== authorities.namespace ||
      identity.controller_revision !== tools.identity.controller_revision ||
      identity.controller_ref !== tools.identity.controller_ref ||
      identity.run_id !== tools.identity.run_id ||
      identity.run_attempt !== tools.identity.run_attempt ||
      aggregate.controller_revision !== producer.controller_revision ||
      aggregate.controller_ref !== producer.controller_ref ||
      aggregate.run_id !== producer.run_id ||
      aggregate.run_attempt !== producer.run_attempt ||
      aggregate.sha256 !== binding.aggregate_sha256
    )
      throw new Error("publication tools, own executor or selected namespace differ");
    const closure = inspectReleaseCompilerSourceClosure(
      JSON.parse(
        (await readControllerToolFile(tools.compiler_source_closure, 65536)).toString("utf8"),
      ),
    );
    if (closure.source_commit !== tools.identity.controller_revision)
      throw new Error("publication compiler closure differs");
    const directory = await mkdtemp(path.join(outputParent, "release-publication-controller-"));
    let stage = "actual-admission";
    try {
      let result: unknown;
      const admission = await acquirePublicationControllerAdmission(
        directory,
        configuration.admission_configuration,
        async (actual) => {
          const { context: admitted, mode } = requireActualPublicationControllerContext(actual);
          const initialState = await recoverReleaseOpportunity(
            admitted.coordinator_repository,
            admitted.checkpoint,
          );
          if (digest(context.manifest.facts) !== digest(admitted.facts)) {
            // Checkpoints and control observations legitimately advance after the
            // payload stage; only the exact frozen source/package/config inputs
            // are invariant across the two independent acquisitions.
            for (const key of ["assembly", "archives", "configuration", "opportunity"] as const)
              if (digest(contextFacts[key]) !== digest(admitted.facts[key]))
                throw new Error("publication differs from original payload context");
          }
          const { accepted } = await inspectTrustedAssemblyInput(admitted.facts.assembly);
          stage = "raw-source-custody";
          const source = await materializePublicationSourceRepository(directory, {
            controller_commit: tools.identity.controller_revision,
            candidate_commit: accepted.source_commit,
            candidate_tree: accepted.source_tree,
          });
          const publicRoot = path.join(directory, "public-inputs");
          await mkdir(publicRoot, { mode: 0o700 });
          for (const [name, bytes] of await readVerifiedReleasePublicBuildInputFiles(
            admitted.public_build_inputs_receipt,
          ))
            await writeFile(path.join(publicRoot, name), bytes, { flag: "wx", mode: 0o600 });
          const sbom = await requireVerifiedReleaseSbomDocument(admitted.sbom_receipt);
          const sbomPath = path.join(directory, "Portcove-SBOM.spdx.json");
          await writeFile(sbomPath, await readControllerToolFile(sbom.path, 16 * 1024 ** 2), {
            flag: "wx",
            mode: 0o600,
          });
          const coordinator = { schema_version: 1, namespace: authorities.namespace };
          const descriptor = JSON.stringify({
            schema_version: 1,
            checkpoint: admitted.checkpoint,
            coordinator,
            assembly: admitted.facts.assembly,
            archives: admitted.facts.archives,
            evidence: {},
          });
          const snapshot = () =>
            readRemoteCoordinatorSnapshot(directory, coordinator, {
              transport: { cwd: directory, deadline },
            });
          stage = "keyless-release-preparation";
          const prepared = await prepareImmutableReleasePublication(
            {
              private_root: directory,
              qualification_parent: directory,
              descriptor,
              aggregate: {
                ...aggregate,
                candidate: admitted.facts.assembly,
                candidate_artifact_ids: admitted.facts.archives.map((archive) => {
                  if (!isRecord(archive))
                    throw new Error("actual platform artifact identity unavailable");
                  if (
                    typeof archive.artifact_id !== "number" ||
                    !Number.isSafeInteger(archive.artifact_id) ||
                    archive.artifact_id < 1
                  )
                    throw new Error("actual platform artifact ID differs");
                  return archive.artifact_id;
                }),
              },
              public_configuration_root: publicRoot,
              updater_roots: [],
              sbom: sbomPath,
              verifier: tools.rust,
              verifier_sha256: hash(await readControllerToolFile(tools.rust)),
            },
            snapshot,
            process.env.GH_TOKEN ?? "",
            {
              tools: toolsReceipt,
              context: contextReceipt,
              facts: admitted.facts,
              source_repository: source.repository,
              deadline,
              admission: actual,
            },
          );
          stage = "durable-publishing-phase";
          if (
            mode === "publication" &&
            isRecord(initialState.input.active_candidate) &&
            initialState.input.active_candidate.phase === "building"
          ) {
            const phase = await advanceActualCandidateToPublishing(actual, { deadline });
            await rebindPreparedImmutableReleaseAfterPhase(prepared, phase, deadline);
          }
          const executor = await authenticateCapacityExecutor(
            "release-publication",
            { ...identity, audience: "portcove-capacity-executor" },
            directory,
            deadline,
          );
          let controls = admitted.controls;
          let usedRound = 0;
          const fresh = async (ordinal: number) => {
            if (ordinal <= usedRound || ordinal > 14)
              throw new Error("publication control round repeated or exhausted");
            usedRound = ordinal;
            controls = await authenticateReleaseControlRound(
              path.join(directory, `publication-controls-r${ordinal}`),
              digest(admitted.facts),
              "release-publication",
              ordinal,
              { deadline },
            );
            return controls;
          };
          stage = "distinct-release-effects";
          const effects =
            mode === "completion-only"
              ? { effects: 0 }
              : await runDistinctPublicationEffects(async (ordinal) =>
                  advanceOwnedImmutableReleasePublication(
                    prepared,
                    executor,
                    actual,
                    await fresh(ordinal),
                    {
                      repository: admitted.coordinator_repository,
                      remote_configuration: coordinator,
                    },
                    deadline,
                  ),
                );
          stage = "actual-immutable-completion";
          await fresh(usedRound + 1);
          const completion = await observeOwnedImmutableReleaseCompletion(
            prepared,
            executor,
            actual,
            controls,
            deadline,
          );
          let checkpoint = admitted.checkpoint;
          if (mode !== "completion-only") {
            const promoting = await advanceActualCandidateToPromoting(completion, { deadline });
            checkpoint = (await requireActualCandidatePhaseAdvance(promoting, "promoting"))
              .checkpoint;
          }
          const api = new GitHubApiClient((args, input) =>
            createGitHubRunner({
              cwd: directory,
              maxBuffer: 2 * 1024 ** 2,
              timeoutMs: coordinatorCommandTimeout(15000),
            })([...args, "--hostname", "github.com"], input),
          );
          const currentState = await recoverReleaseOpportunity(
            admitted.coordinator_repository,
            checkpoint,
          );
          if (
            !isRecord(currentState.input.active_candidate) ||
            !isRecord(currentState.input.controller) ||
            !isRecord(currentState.input.controller.capacity_attempt)
          )
            throw new Error("result attempt journal unavailable");
          const currentCandidate = currentState.input.active_candidate;
          const retained = inspectRetainedResultUpload(
            inspectCapacityOperation(currentState.input.controller.capacity_attempt.operation),
            currentCandidate,
          );
          if (retained) {
            const read = () => {
              const response = api.request(
                  "GET",
                  `repos/boburning/portcove/actions/artifacts/${retained.artifact_id}`,
                ),
                item = response.body;
              if (
                response.status !== 200 ||
                !isRecord(item) ||
                item.id !== retained.artifact_id ||
                item.expired !== false ||
                item.name !==
                  `trusted-immutable-release-result-${String(retained.executor.run_id)}-${String(retained.executor.run_attempt)}` ||
                typeof item.digest !== "string" ||
                !/^sha256:[a-f0-9]{64}$/u.test(item.digest) ||
                typeof item.size_in_bytes !== "number" ||
                !Number.isSafeInteger(item.size_in_bytes) ||
                item.size_in_bytes < 22 ||
                item.size_in_bytes > 1024 ** 2 ||
                !isRecord(item.workflow_run) ||
                String(item.workflow_run.id) !== retained.executor.run_id ||
                item.workflow_run.repository_id !== 1354613114 ||
                item.workflow_run.head_repository_id !== 1354613114 ||
                item.workflow_run.head_sha !== retained.executor.controller_revision
              )
                throw new Error(
                  "retained result upload provider identity unavailable; preserve original effect",
                );
              return { id: item.id, bytes: item.size_in_bytes, sha256: item.digest.slice(7) };
            };
            const before = read();
            if (digest(before) !== digest(read()) || (await snapshot()).checkpoint !== checkpoint)
              throw new Error("retained result upload changed during GET-only readback");
            result = Object.freeze({
              decision: "retained-result-requires-attestation-readback",
              artifact: before,
              directory,
              authority: "none",
              scope:
                "existing provider locator only; no repeated upload or completed-success attestation claim",
            });
            return;
          }
          stage = "actual-result-report";
          const report = await prepareOwnedPublicationResult(
            completion,
            contextReceipt,
            toolsReceipt,
            directory,
            deadline,
          );
          const boundary = async () => {
            checkCoordinatorDeadline();
            const currentExecutor = await refreshCapacityExecutor(executor);
            const original = admitted.admission.controls;
            const current = controls.read(api, admitted.facts.opportunity);
            if (
              !original ||
              current.reader.job_id !== currentExecutor.job_id ||
              current.reader.controller_revision !== currentExecutor.controller_revision ||
              current.reader.controller_ref !== currentExecutor.execution_ref ||
              String(current.reader.run_id) !== currentExecutor.run_id ||
              current.reader.run_attempt !== currentExecutor.run_attempt ||
              current.pause.publication_paused ||
              !current.resource_policy_matches_controller ||
              current.protection.release_immutability?.enabled !== true ||
              digest(current.classification) !== digest(original.classification) ||
              digest(current.pause) !== digest(original.pause) ||
              digest(current.capacity) !== digest(original.capacity) ||
              !isRecord(current.capacity_source.capacity)
            )
              throw new Error("publication result controls held");
            return current.capacity_source.capacity.boundary;
          };
          stage = "owned-result-upload";
          await fresh(usedRound + 1);
          let handoff: Awaited<ReturnType<typeof handoffPublicationResultArtifact>> | undefined;
          const settlement = await executeOwnedCapacityEffect(
            executor,
            {
              repository: admitted.coordinator_repository,
              checkpoint,
              remote_configuration: coordinator,
              request: {
                kind: "upload",
                destination: publicationResultDestination(currentCandidate),
              },
            },
            boundary,
            async (pending) => {
              const ownedReport = await requireOwnedPublicationResult(report);
              if (process.env.RUNNER_TEMP)
                await writeFile(
                  path.join(process.env.RUNNER_TEMP, "publication-controller-output.json"),
                  JSON.stringify({
                    directory: ownedReport.directory,
                    report_sha256: ownedReport.report_sha256,
                  }),
                  { flag: "wx", mode: 0o600 },
                );
              handoff = await handoffPublicationResultArtifact(report, pending, deadline);
              return {
                remote_identity: `github-actions:boburning/portcove:artifact:${handoff.artifact_id}`,
                evidence_sha256: digest(handoff),
              };
            },
          );
          if (!handoff) throw new Error("actual publication result artifact missing");
          result = Object.freeze({
            decision: "immutable-release-and-result-prepared",
            directory,
            effects: effects.effects,
            settlement,
            artifact: handoff,
            pending_obligations: [
              "result-attestation",
              "authenticated-feed-deployment",
              "independent-public-byte-readback",
              "ordinary-public-updater-journey",
              "durable-candidate-completion",
            ],
            authority: "none",
          });
        },
        {
          controller_tools: toolsReceipt,
          controller_source: {
            source_commit: closure.source_commit,
            source_tree: closure.source_tree,
          },
        },
        (facts) =>
          collectConfiguredNativePublicationQualificationPair(
            directory,
            nativeLocators,
            facts.assembly,
            facts.archives,
            contextReceipt,
            tufPublication,
            deadline,
          ),
        deadline,
      );
      checkCoordinatorDeadline();
      return result ?? { decision: "held", holds: admission.holds, directory, authority: "none" };
    } catch {
      await writeFile(
        path.join(directory, "publication-controller-refusal.json"),
        JSON.stringify({ stage, automatic_retry: false, authority: "none" }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {});
      throw new Error(`actual immutable publication stopped; retain ${directory}`);
    }
  });
}

// This fixed child mode has no publisher, journal, OIDC, signer or observer
// credential. The actual parent pins this entry and caps the complete process.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 4 && process.argv[2] === "--run") {
      await runFixedPublicationEntry(process.argv[3]!);
    } else if (["--ready", "--uploaded", "--predicate"].includes(process.argv[2] ?? "")) {
      const mode = process.argv[2]!;
      if (
        (mode === "--uploaded" && process.argv.length !== 5) ||
        (mode !== "--uploaded" && process.argv.length !== 3) ||
        !process.env.RUNNER_TEMP
      )
        throw new Error("fixed publication upload arguments differ");
      if (process.env.GITHUB_RUN_ATTEMPT !== "1")
        throw new Error("publication attempt cannot restart");
      const deadline = currentPublicationJobDeadline(process.env.RUNNER_TEMP, {
        run_id: process.env.GITHUB_RUN_ID ?? "",
        controller_revision: process.env.GITHUB_SHA ?? "",
      });
      await publicationUploadCommand(
        mode,
        process.env.RUNNER_TEMP,
        deadline,
        mode === "--uploaded"
          ? { id: Number(process.argv[3]), sha256: process.argv[4]! }
          : undefined,
      );
    } else {
      if (process.argv.length !== 4 || process.argv[2] !== "--finalize")
        throw new Error(
          "usage: release-publication-controller --run FIXED_CONFIG | --finalize FIXED_REQUEST; actual controller configuration required",
        );
      const request: unknown = JSON.parse(process.argv[3]!);
      if (
        !isRecord(request) ||
        Object.keys(request).sort().join(",") !==
          "assets,budget_ms,inventory,prepared_commit,qualification_root,sbom_subjects,version" ||
        typeof request.budget_ms !== "number" ||
        !Number.isSafeInteger(request.budget_ms) ||
        request.budget_ms < 1 ||
        request.budget_ms > 350000 ||
        ![
          request.assets,
          request.inventory,
          request.qualification_root,
          request.sbom_subjects,
        ].every((value) => typeof value === "string" && path.isAbsolute(value))
      )
        throw new Error("fixed qualification request differs");
      const result = await withCoordinatorDeadline(performance.now() + request.budget_ms, () =>
        finalizeReleaseAssets(String(request.assets), String(request.inventory), {
          projectRoot: fileURLToPath(new URL("..", import.meta.url)),
          sbomSubjectChecksums: String(request.sbom_subjects),
          linuxQualificationRoot: String(request.qualification_root),
        }),
      );
      console.log(
        JSON.stringify({ scope: "fixed-finalizer-exact-candidate", assets: result.assets }),
      );
    }
  } catch {
    console.error("fixed publication controller refused; retain public evidence");
    process.exitCode = 1;
  } finally {
    if (process.argv[2] === "--run" && process.env.RUNNER_TEMP)
      await writeFile(
        path.join(process.env.RUNNER_TEMP, "publication-controller-process-ended.json"),
        JSON.stringify({ exit_code: process.exitCode ?? 0, authority: "none" }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {
        process.exitCode = 1;
      });
  }
}
