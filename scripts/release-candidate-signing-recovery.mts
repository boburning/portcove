/** GET-only continuation for original signing custody. Existing attested receivers
 * authenticate every returned locator; current publication eligibility is never
 * established by this module, a journal summary, or copied result JSON. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { readGitHubReleaseAsset, readGitHubArtifactArchive } from "./github-binary.mts";
import {
  capacityDigest as digest,
  inspectCapacityOperation,
  inspectCompactCapacityOperations,
} from "./release-capacity.mts";
import {
  recoverReleaseOpportunity,
  readRetainedCapacityOperation,
  checkpointReleaseOpportunity,
} from "./release-coordinator-state.mts";
import { publishCoordinatorCheckpoint } from "./release-coordinator-remote.mts";
import { createCoordinatorJournalApi } from "./release-coordinator-journal-api.mts";
import { candidateProgressIdentity } from "./release-candidate-progress-contract.mts";
import {
  inspectPublicationReportRepair,
  inspectConsumedPublicationReportRepair,
} from "./release-report-repair-contract.mts";
import {
  hydrateRetainedCoordinatorOperation,
  readRemoteCoordinatorSnapshot,
} from "./release-coordinator-recovery.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import {
  capacityExecutorIdentity,
  refreshCapacityExecutor,
  recoverOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  inspectSigningContextArchive,
  receiveSigningContextArtifact,
  requireReceivedSigningContext,
  requireRetainedSigningContext,
  signingContextRemaining,
} from "./release-signing-context-artifact.mts";
import type { SigningContextArtifactExpected } from "./release-signing-context-artifact.mts";
import {
  receiveTufRoleArtifact,
  requireRetainedTufRoleArtifact,
} from "./release-tuf-role-artifact.mts";
import type { TufRoleArtifactExpected } from "./release-tuf-role-artifact.mts";
import {
  prepareActualTufPublication,
  requireActualTufPublication,
  requireRetainedActualTufPublication,
} from "./release-tuf-publication.mts";
import {
  readCompleteRunArtifactInventory,
  inspectCompleteRunArtifactInventory,
} from "./release-run-artifact-inventory.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { isRecord } from "./runtime-values.mts";
import {
  readImmutableReleaseState,
  proposeImmutableReleaseTransition,
} from "./release-immutable-publication.mts";
import { receivePublicationResultArtifact } from "./release-publication-result-artifact.mts";
import type { PublicationResultArtifactExpected } from "./release-publication-result-artifact.mts";
import {
  inspectPendingResultOperation,
  inspectRetainedResultOperation,
  publicationResultReadbackDestination,
  inspectPendingResultProvider,
  readPendingResultArchive,
} from "./release-pending-result-recovery.mts";
import { inspectCandidateStageEvidence } from "./release-candidate-progress-contract.mts";

import {
  inspectPendingCandidateReleaseOperation,
  inspectPendingReleaseProducer,
  derivePendingReleaseAssets,
  observePendingCandidateRelease,
} from "./release-pending-release-recovery.mts";

const base = "repos/boburning/portcove";
const roles = ["releases", "preview", "stable", "snapshot", "timestamp"] as const;
type Output = "payload" | "context" | (typeof roles)[number];
type Operation = NonNullable<ReturnType<typeof inspectCapacityOperation>>;
type Executor = Parameters<typeof capacityExecutorIdentity>[0];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const settled = (operation: Operation) =>
  ["succeeded", "recovered"].includes(operation.outcome) &&
  operation.completed_effects.length === 1 &&
  (operation.outcome === "succeeded" || operation.recovery?.resolution === "effect-completed");
function destination(version: string, output: Output) {
  return `github-actions:boburning/portcove:${version}:${output === "payload" ? "payload-signatures" : output === "context" ? "payload-signing-context" : `tuf-${output}-envelope`}`;
}
function roleFor(output: Output) {
  return output === "payload" || output === "context" ? "payload-signing" : `tuf-${output}`;
}
function candidate(raw: unknown) {
  assert.ok(isRecord(raw), "signing readback candidate missing");
  if (!["publishing", "promoting"].includes(String(raw.phase)))
    inspectConsumedPublicationReportRepair(raw);
  for (const key of ["source_commit", "source_tree", "prepared_commit", "prepared_tree"])
    assert.ok(
      typeof raw[key] === "string" && /^[a-f0-9]{40}$/u.test(raw[key]),
      "exact frozen candidate required",
    );
  assert.ok(typeof raw.version === "string" && /^[A-Za-z0-9.+-]{1,128}$/u.test(raw.version));
  for (const [key, maximum] of [
    ["transient_retries", 2],
    ["substantive_repairs", 3],
  ] as const)
    assert.ok(
      typeof raw[key] === "number" &&
        Number.isInteger(raw[key]) &&
        raw[key] >= 0 &&
        raw[key] <= maximum,
    );
  return structuredClone(raw);
}
/** Data-only original-operation association; no executor or producer authority. */
export function inspectCandidateSigningOperation(
  raw: unknown,
  rawCandidate: unknown,
  output: Output,
) {
  const selected = candidate(rawCandidate),
    operation = inspectCapacityOperation(raw);
  assert.ok(
    operation &&
      operation.candidate &&
      operation.executor_identity &&
      operation.receipt_limit === 1,
  );
  assert.equal(operation.kind, "upload");
  assert.equal(operation.destination, destination(String(selected.version), output));
  assert.equal(operation.executor_identity.role, roleFor(output));
  assert.equal(operation.executor_identity.workflow, productionControllerWorkflow);
  assert.equal(operation.executor_identity.run_attempt, 1);
  for (const key of ["source_commit", "prepared_commit", "version"] as const)
    assert.equal(operation.candidate[key], selected[key], "original signing candidate differs");
  for (const key of ["transient_retries", "substantive_repairs"] as const)
    assert.ok(
      operation.candidate[key] <= Number(selected[key]),
      "original signing counters exceed current candidate",
    );
  assert.ok(
    settled(operation) || ["pending", "ambiguous", "capacity-refused"].includes(operation.outcome),
    "original signing effect was not positively completed",
  );
  return operation;
}
/** Distinct prepared-build and original-opportunity identities. This restricts
 * an existing attested context; copied facts never establish eligibility. */
export function inspectCandidateSigningContextBinding(
  raw: unknown,
  rawCandidate: unknown,
  rawPayload: unknown,
) {
  const active = candidate(rawCandidate);
  const payload = inspectCandidateSigningOperation(rawPayload, active, "payload");
  assert.ok(settled(payload), "original payload signature effect is not settled");
  assert.ok(
    isRecord(raw) &&
      raw.kind === "release-signing-context" &&
      isRecord(raw.binding) &&
      isRecord(raw.facts),
  );
  const binding = raw.binding,
    facts = raw.facts;
  assert.equal(
    binding.source_commit,
    active.prepared_commit,
    "context build must bind prepared commit",
  );
  assert.equal(binding.source_tree, active.prepared_tree, "context build must bind prepared tree");
  assert.equal(binding.version, active.version);
  assert.equal(
    facts.checkpoint,
    payload.before_checkpoint,
    "context does not bind original payload admission preimage",
  );
  assert.ok(
    isRecord(active.frozen_opportunity) && isRecord(facts.opportunity),
    "exact frozen opportunity missing",
  );
  assert.equal(active.frozen_opportunity.source_commit, active.source_commit);
  assert.equal(active.frozen_opportunity.source_tree, active.source_tree);
  assert.equal(
    digest(facts.opportunity),
    digest(active.frozen_opportunity),
    "context original opportunity differs",
  );
  assert.ok(
    typeof binding.run_id === "string" &&
      /^[1-9][0-9]{0,15}$/u.test(binding.run_id) &&
      typeof binding.run_attempt === "number" &&
      Number.isSafeInteger(binding.run_attempt) &&
      binding.run_attempt > 0,
    "original compiler run identity missing",
  );
  const matchesRun = (value: unknown) =>
    isRecord(value) &&
    String(value.run_id) === binding.run_id &&
    value.attempt === binding.run_attempt &&
    value.revision === active.prepared_commit;
  if (!matchesRun(active.release_run)) {
    const history = inspectCandidateStageEvidence(active.stage_evidence, active);
    assert.ok(
      history.some(
        (slot) =>
          slot.phase === "building" &&
          slot.attempts.some(
            (attempt) =>
              attempt.transient_retries === payload.candidate!.transient_retries &&
              attempt.substantive_repairs === payload.candidate!.substantive_repairs &&
              matchesRun(attempt.release_run),
          ),
      ),
      "context original compiler run lacks exact current/applicable building history",
    );
  }
  return { authority: "none" as const };
}

/** Complete original provider observations. Missing/expired/duplicates remain HOLD. */
export function inspectCandidateSigningProvider(
  rawRun: unknown,
  rawAttempt: unknown,
  rawJob: unknown,
  rawArtifacts: unknown,
  rawOperation: unknown,
  rawCandidate: unknown,
  output: Exclude<Output, "payload">,
) {
  const operation = inspectCandidateSigningOperation(rawOperation, rawCandidate, output),
    producer = operation.executor_identity!;
  for (const run of [rawRun, rawAttempt]) {
    assert.ok(
      isRecord(run) &&
        String(run.id) === producer.run_id &&
        run.run_attempt === 1 &&
        run.head_sha === producer.controller_revision &&
        run.path === productionControllerWorkflow &&
        run.event === "workflow_dispatch" &&
        isRecord(run.actor) &&
        String(run.actor.id) === String(producer.actor_id) &&
        run.status === "completed" &&
        [
          "success",
          "failure",
          "cancelled",
          "timed_out",
          "action_required",
          "neutral",
          "skipped",
          "stale",
          "startup_failure",
        ].includes(String(run.conclusion)) &&
        isRecord(run.repository) &&
        run.repository.id === 1354613114 &&
        run.repository.full_name === "boburning/portcove" &&
        isRecord(run.head_repository) &&
        run.head_repository.id === 1354613114,
      "original signing run not terminal/exact",
    );
  }
  const phase = output === "context" ? "payload" : (`tuf-${output}` as const);
  assert.ok(
    isRecord(rawJob) &&
      rawJob.id === producer.job_id &&
      String(rawJob.run_id) === producer.run_id &&
      rawJob.run_attempt === 1 &&
      rawJob.head_sha === producer.controller_revision &&
      rawJob.check_run_url ===
        `https://api.github.com/repos/boburning/portcove/check-runs/${String(producer.check_run_id)}` &&
      rawJob.status === "completed" &&
      rawJob.conclusion === "success" &&
      rawJob.name === releaseControlPhaseProfile(phase).reader_name,
    "original exact signing job did not succeed",
  );
  const rows = inspectCompleteRunArtifactInventory(rawArtifacts).artifacts;
  const prefix = output === "context" ? "trusted-payload-signing-context" : `trusted-tuf-${output}`;
  const [artifact, bundle] = [false, true].map((attestation) => {
    const name =
      output === "context"
        ? `${prefix}${attestation ? "-attestation" : ""}-${String(producer.run_id)}-1`
        : `${prefix}-${attestation ? "attestation" : "output"}-${String(producer.run_id)}-1`;
    const matches = rows.filter((row: unknown) => isRecord(row) && row.name === name);
    assert.equal(matches.length, 1, "original signing artifact/bundle missing or ambiguous");
    const row = matches[0];
    assert.ok(
      isRecord(row) &&
        typeof row.id === "number" &&
        Number.isSafeInteger(row.id) &&
        row.id > 0 &&
        typeof row.digest === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(row.digest) &&
        row.expired === false &&
        typeof row.size_in_bytes === "number" &&
        Number.isSafeInteger(row.size_in_bytes) &&
        row.size_in_bytes >= 22 &&
        row.size_in_bytes <=
          (attestation ? 4 * 1024 ** 2 : output === "context" ? 128 * 1024 ** 2 : 2 * 1024 ** 2) &&
        isRecord(row.workflow_run) &&
        String(row.workflow_run.id) === producer.run_id &&
        row.workflow_run.repository_id === 1354613114 &&
        row.workflow_run.head_repository_id === 1354613114 &&
        row.workflow_run.head_sha === producer.controller_revision,
      "original signing immutable artifact differs",
    );
    return { id: row.id, sha256: row.digest.slice(7), bytes: row.size_in_bytes };
  });
  assert.ok(artifact && bundle && artifact.id !== bundle.id);
  if (operation.completed_effects.length)
    assert.equal(
      operation.completed_effects[0]!.remote_identity,
      `github-actions:boburning/portcove:artifact:${artifact.id}`,
      "original signing artifact is not journal-settled upload",
    );
  return { artifact, bundle, producer: structuredClone(producer), authority: "none" as const };
}

export async function readCandidateSigningOperations(
  repository: string,
  input: unknown,
  active: Record<string, unknown>,
  api?: GitHubRestReader,
) {
  return readOriginalSigningOperations(repository, input, active, api);
}
/** Data-only original receipt discovery through one narrowly inspected pending
 * Release intent. Every signing output must already be positively settled;
 * this cannot settle that intent or authorize a new signing/Release effect. */
export async function readSigningOperationsForPendingRelease(
  repository: string,
  input: unknown,
  active: Record<string, unknown>,
  api?: GitHubRestReader,
) {
  assert.ok(
    isRecord(input) && isRecord(input.controller) && isRecord(input.controller.capacity_attempt),
  );
  const pending = inspectPendingCandidateReleaseOperation(
    input.controller.capacity_attempt.operation,
    active,
  );
  return readOriginalSigningOperations(repository, input, active, api, pending);
}
/** Named GET-only allowance for the exact retained result upload. All original
 * signing outputs must already be settled; it cannot authorize another upload. */
export async function readSigningOperationsForPendingResult(
  repository: string,
  input: unknown,
  active: Record<string, unknown>,
  api?: GitHubRestReader,
) {
  assert.ok(
    isRecord(input) && isRecord(input.controller) && isRecord(input.controller.capacity_attempt),
  );
  const current = inspectCapacityOperation(input.controller.capacity_attempt.operation);
  const pending =
    current && settled(current)
      ? inspectRetainedResultOperation(current, active)
      : inspectPendingResultOperation(current, active);
  return readOriginalSigningOperations(repository, input, active, api, pending);
}

async function readOriginalPublishedOperation(
  repository: string,
  input: Record<string, unknown>,
  active: Record<string, unknown>,
  api: GitHubRestReader,
) {
  assert.ok(isRecord(input.controller) && isRecord(input.controller.capacity_attempt));
  const capacity = input.controller.capacity_attempt;
  const wanted = `github-release:boburning/portcove:v${String(active.version)}:publish`;
  const candidates: Operation[] = [];
  if (capacity.schema_version === 2) {
    for (const group of inspectCompactCapacityOperations(capacity.prior_operations)) {
      if (
        group.subject.kind !== "candidate" ||
        group.subject.identity !== active.prepared_commit ||
        group.kind !== "upload" ||
        group.destination_sha256 !== digest(wanted) ||
        !group.completed
      )
        continue;
      for (const proof of group.attempts) {
        let raw: unknown;
        try {
          raw = readRetainedCapacityOperation(repository, proof);
        } catch {
          raw = await hydrateRetainedCoordinatorOperation(repository, proof, { api });
        }
        const retained = inspectCapacityOperation(raw);
        if (retained && settled(retained)) candidates.push(retained);
      }
    }
  } else {
    assert.ok(Array.isArray(capacity.prior_operations) && capacity.prior_operations.length <= 32);
    for (const raw of capacity.prior_operations) {
      const retained = inspectCapacityOperation(raw);
      if (retained?.destination === wanted && settled(retained)) candidates.push(retained);
    }
  }
  assert.equal(candidates.length, 1, "original immutable publish settlement missing or ambiguous");
  const published = candidates[0]!;
  assert.equal(published.destination, wanted);
  return published;
}

/** Metadata may advance the current operation after the upload was settled.
 * Retain exact original result custody through its existing immutable proof. */
async function readOriginalResultOperation(
  repository: string,
  input: Record<string, unknown>,
  active: Record<string, unknown>,
  api: GitHubRestReader,
) {
  assert.ok(isRecord(input.controller) && isRecord(input.controller.capacity_attempt));
  const capacity = input.controller.capacity_attempt;
  const wanted = publicationResultReadbackDestination(active);
  const current = inspectCapacityOperation(capacity.operation);
  if (current?.destination === wanted)
    return settled(current)
      ? inspectRetainedResultOperation(current, active)
      : inspectPendingResultOperation(current, active);
  if (current && !["succeeded", "recovered"].includes(current.outcome)) return undefined;
  if (capacity.schema_version === 2) {
    const groups = inspectCompactCapacityOperations(capacity.prior_operations).filter(
      (group) =>
        group.subject.kind === "candidate" &&
        group.subject.identity === active.prepared_commit &&
        group.kind === "upload" &&
        group.destination_sha256 === digest(wanted),
    );
    assert.ok(groups.length <= 1, "original result summary is ambiguous");
    if (!groups.length) return undefined;
    const proof = groups[0]!.attempts.at(-1)!;
    let raw: unknown;
    try {
      raw = readRetainedCapacityOperation(repository, proof);
    } catch {
      raw = await hydrateRetainedCoordinatorOperation(repository, proof, { api });
    }
    return inspectRetainedResultOperation(raw, active);
  }
  assert.ok(Array.isArray(capacity.prior_operations) && capacity.prior_operations.length <= 32);
  const matches = capacity.prior_operations
    .map(inspectCapacityOperation)
    .filter((op) => op?.destination === wanted);
  assert.ok(matches.length <= 1, "original result history is ambiguous");
  return matches.length ? inspectRetainedResultOperation(matches[0], active) : undefined;
}
async function readOriginalSigningOperations(
  repository: string,
  input: unknown,
  active: Record<string, unknown>,
  api?: GitHubRestReader,
  pendingRelease?: Operation,
) {
  assert.ok(
    isRecord(input) && isRecord(input.controller) && isRecord(input.controller.capacity_attempt),
  );
  const capacity = input.controller.capacity_attempt;
  const current = inspectCapacityOperation(capacity.operation);
  if (current && !["succeeded", "recovered"].includes(current.outcome)) {
    const allowed = ["payload", "context", ...roles].some(
      (output) => current.destination === destination(String(active.version), output as Output),
    );
    assert.ok(
      allowed || pendingRelease?.id === current.id,
      "unrelated unresolved effect must settle before signing custody readback",
    );
  }
  const operations = new Map<Output, Operation>();
  for (const output of ["payload", "context", ...roles] as const) {
    const candidates: Operation[] = [];
    if (current?.destination === destination(String(active.version), output))
      candidates.push(current);
    if (capacity.schema_version === 2) {
      for (const group of inspectCompactCapacityOperations(capacity.prior_operations)) {
        if (
          group.subject.kind !== "candidate" ||
          group.subject.identity !== active.prepared_commit ||
          group.kind !== "upload" ||
          group.destination_sha256 !== digest(destination(String(active.version), output))
        )
          continue;
        // The immutable summary appends attempts in journal order. Read only
        // its latest exact receipt, not an unbounded historical audit/fallback.
        const proof = group.attempts.at(-1)!;
        let retained: unknown;
        try {
          retained = readRetainedCapacityOperation(repository, proof);
        } catch {
          retained = await hydrateRetainedCoordinatorOperation(
            repository,
            proof,
            api ? { api } : {},
          );
        }
        const parsed = inspectCapacityOperation(retained);
        assert.ok(parsed);
        candidates.push(parsed);
      }
    } else {
      assert.ok(Array.isArray(capacity.prior_operations) && capacity.prior_operations.length <= 32);
      for (const retained of capacity.prior_operations) {
        const parsed = inspectCapacityOperation(retained);
        if (parsed?.destination === destination(String(active.version), output))
          candidates.push(parsed);
      }
    }
    const latest = candidates.sort((a, b) => b.sequence - a.sequence)[0];
    assert.ok(latest, "original signing effect missing; do not sign/upload again from readback");
    const retained = inspectCandidateSigningOperation(latest, active, output);
    if (pendingRelease)
      assert.ok(
        settled(retained),
        "all seven signing effects must already be settled before Release readback",
      );
    operations.set(output, retained);
  }
  return operations;
}

export interface CandidateSigningRecoveryRequest {
  repository: string;
  checkpoint: string;
  remote_configuration: unknown;
}
/** Called only by the fixed coordinator under its original170s deadline and
 * actual control boundary. The callback refreshes that existing boundary;
 * neither it nor any returned locator can mint publication eligibility. */
export async function recoverCandidateSigningCustody(
  raw: CandidateSigningRecoveryRequest,
  toolsReceipt: object,
  executor: Executor,
  parent: string,
  deadline: number,
  freshBoundary: () => Promise<unknown>,
) {
  const input = structuredClone(raw);
  signingContextRemaining(deadline, 15000);
  assert.ok(
    path.isAbsolute(parent) &&
      path.isAbsolute(input.repository) &&
      /^[a-f0-9]{40}$/u.test(input.checkpoint),
  );
  return withCoordinatorDeadline(deadline, async () => {
    const directory = await mkdtemp(path.join(parent, "candidate-signing-recovery-"));
    const home = path.join(directory, "reader-home");
    await mkdir(home, { mode: 0o700 });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        ["PATH", "Path", "SystemRoot", "WINDIR", "GH_TOKEN"].includes(key),
      ),
    );
    Object.assign(environment, {
      HOME: home,
      USERPROFILE: home,
      TMP: home,
      TEMP: home,
      GH_CONFIG_DIR: home,
      XDG_CONFIG_HOME: home,
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
    });
    const spawn: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"] = (
      command,
      args,
      settings,
    ) => spawnSync(command, args, { ...settings, env: environment });
    let checkpoint = input.checkpoint,
      phase = "current-coordinator";
    let requests = 0;
    const api: GitHubRestReader = new GitHubApiClient((args, body) => {
      if (++requests > 128) throw new Error("candidate signing discovery read bound exhausted");
      const response = createGitHubRunner({
        cwd: directory,
        maxBuffer: 2 * 1024 ** 2,
        timeoutMs: signingContextRemaining(deadline, 15000),
        spawn,
      })([...args, "--hostname", "github.com"], body);
      signingContextRemaining(deadline, 15000);
      return response;
    });
    const get = (suffix: string) => {
      const response = api.request("GET", `${base}/${suffix}`);
      assert.equal(response.status, 200, "original signing provider read unavailable");
      return response.body;
    };
    try {
      await verifiedControllerToolPaths(toolsReceipt);
      assert.equal((await refreshCapacityExecutor(executor)).role, "coordinator");
      const state = await recoverReleaseOpportunity(input.repository, checkpoint);
      const active = candidate(state.input.active_candidate);
      let originalCandidate = digest(active);
      const guard = async () => {
        signingContextRemaining(deadline, 15000);
        await verifiedControllerToolPaths(toolsReceipt);
        await freshBoundary();
        const snapshot = await readRemoteCoordinatorSnapshot(
          directory,
          input.remote_configuration,
          { transport: { cwd: directory, deadline, spawn } },
        );
        assert.equal(snapshot.checkpoint, checkpoint, "signing custody journal changed");
        assert.equal(
          digest(snapshot.input.active_candidate),
          originalCandidate,
          "signing recovery changed candidate/phase/counters",
        );
        signingContextRemaining(deadline, 15000);
      };
      await guard();
      assert.ok(
        isRecord(state.input.controller) && isRecord(state.input.controller.capacity_attempt),
      );
      const currentOperation = inspectCapacityOperation(
        state.input.controller.capacity_attempt.operation,
      );
      const pendingRelease =
        currentOperation &&
        ["pending", "ambiguous", "capacity-refused"].includes(currentOperation.outcome) &&
        currentOperation.destination.startsWith("github-release:boburning/portcove:")
          ? inspectPendingCandidateReleaseOperation(currentOperation, active)
          : undefined;
      const pendingResult = pendingRelease
        ? undefined
        : await readOriginalResultOperation(input.repository, state.input, active, api);
      const operations = pendingResult
        ? await readOriginalSigningOperations(
            input.repository,
            state.input,
            active,
            api,
            pendingResult,
          )
        : await (
            pendingRelease ? readSigningOperationsForPendingRelease : readCandidateSigningOperations
          )(input.repository, state.input, active, api);
      const observe = (operation: Operation, output: Exclude<Output, "payload">) => {
        const producer = operation.executor_identity!;
        return inspectCandidateSigningProvider(
          get(`actions/runs/${String(producer.run_id)}`),
          get(`actions/runs/${String(producer.run_id)}/attempts/1`),
          get(`actions/jobs/${String(producer.job_id)}`),
          readCompleteRunArtifactInventory((page) =>
            get(`actions/runs/${String(producer.run_id)}/artifacts?per_page=100&page=${page}`),
          ),
          operation,
          active,
          output,
        );
      };
      const settle = async (operation: Operation, observation: ReturnType<typeof observe>) => {
        await guard();
        if (settled(operation)) return;
        const result = await recoverOwnedCapacityEffect(
          executor,
          { ...input, checkpoint },
          async (pending) => {
            assert.equal(digest(pending), digest(operation), "different pending signing effect");
            const again = observe(
              operation,
              operation.destination.endsWith(":payload-signing-context")
                ? "context"
                : roles.find((role) => operation.destination.endsWith(`:tuf-${role}-envelope`))!,
            );
            assert.equal(
              digest(again),
              digest(observation),
              "original signing provider drifted before settlement",
            );
            await guard();
            return {
              resolution: "effect-completed",
              evidence_sha256: digest(observation),
              completed_effect: {
                remote_identity: `github-actions:boburning/portcove:artifact:${observation.artifact.id}`,
                evidence_sha256: digest(observation),
              },
            };
          },
        );
        checkpoint = result.checkpoint;
        await guard();
      };
      phase = "original-context";
      const contextOperation = operations.get("context")!;
      const contextBefore = observe(contextOperation, "context");
      const bytes = readGitHubArtifactArchive(
        `${base}/actions/artifacts/${contextBefore.artifact.id}/zip`,
        {
          cwd: directory,
          maxBytes: contextBefore.artifact.bytes,
          timeoutMs: signingContextRemaining(deadline, 30000),
          spawn: (command, args, settings) =>
            spawnSync(command, args, { ...settings, env: environment }),
        },
      );
      assert.equal(
        hash(bytes),
        contextBefore.artifact.sha256,
        "original opaque context digest differs",
      );
      const inspected = inspectSigningContextArchive(bytes),
        manifest = inspected.manifest;
      assert.ok(
        isRecord(manifest.binding) && isRecord(manifest.controller) && isRecord(manifest.facts),
      );
      const payloadOperation = operations.get("payload")!;
      inspectCandidateSigningContextBinding(manifest, active, payloadOperation);
      assert.equal(
        digest(payloadOperation.executor_identity),
        digest(contextOperation.executor_identity),
        "context and original payload signature producer differ",
      );
      const producer = contextOperation.executor_identity!;
      assert.equal(manifest.controller.controller_revision, producer.controller_revision);
      assert.equal(manifest.controller.controller_ref, producer.execution_ref);
      assert.equal(manifest.controller.run_id, producer.run_id);
      assert.equal(manifest.controller.run_attempt, 1);
      const contextLocator: SigningContextArtifactExpected = {
        controller_revision: producer.controller_revision,
        controller_ref: producer.execution_ref,
        source_tree: String(manifest.controller.source_tree),
        run_id: String(producer.run_id),
        run_attempt: 1,
        artifact: { id: contextBefore.artifact.id, sha256: contextBefore.artifact.sha256 },
        bundle: { id: contextBefore.bundle.id, sha256: contextBefore.bundle.sha256 },
        manifest_sha256: inspected.manifest_sha256,
        binding_sha256: digest(manifest.binding),
        facts_sha256: String(manifest.facts_sha256),
      };
      const context = await receiveSigningContextArtifact(directory, contextLocator, deadline);
      await requireReceivedSigningContext(context, deadline);
      assert.equal(
        digest(observe(contextOperation, "context")),
        digest(contextBefore),
        "context provider drifted",
      );
      await settle(contextOperation, contextBefore);
      const roleLocators: TufRoleArtifactExpected[] = [],
        roleReceipts: object[] = [];
      for (const role of roles) {
        phase = `original-${role}`;
        await guard();
        const operation = operations.get(role)!,
          before = observe(operation, role),
          original = operation.executor_identity!;
        const locator: TufRoleArtifactExpected = {
          role,
          controller: {
            controller_revision: original.controller_revision,
            source_tree: contextLocator.source_tree,
            controller_ref: original.execution_ref,
            run_id: String(original.run_id),
            run_attempt: 1,
          },
          artifact: { id: before.artifact.id, sha256: before.artifact.sha256 },
          bundle: { id: before.bundle.id, sha256: before.bundle.sha256 },
          context_manifest_sha256: contextLocator.manifest_sha256,
          context_binding_sha256: contextLocator.binding_sha256,
          context_facts_sha256: contextLocator.facts_sha256,
        };
        const receipt = await receiveTufRoleArtifact(context, directory, locator, deadline);
        const retained = await requireRetainedTufRoleArtifact(receipt, deadline);
        const outputManifest: unknown = JSON.parse(
          (
            await readControllerToolFile(
              path.join(path.dirname(retained.envelope.path), "signing-output-manifest.json"),
              65536,
            )
          ).toString("utf8"),
        );
        assert.ok(isRecord(outputManifest) && isRecord(outputManifest.pending));
        assert.equal(
          outputManifest.pending.operation_id,
          operation.id,
          "role output belongs to another intent",
        );
        assert.ok(typeof outputManifest.pending.checkpoint === "string");
        assert.equal(digest(observe(operation, role)), digest(before), "role provider drifted");
        await settle(operation, before);
        roleLocators.push(locator);
        roleReceipts.push(receipt);
      }
      phase = "keyless-Tough-verification";
      const publication = await prepareActualTufPublication(
        context,
        toolsReceipt,
        roleReceipts,
        directory,
        deadline,
      );
      await requireActualTufPublication(publication, deadline);
      await requireRetainedSigningContext(context, deadline);
      let publicationResultLocator: PublicationResultArtifactExpected | undefined;
      let resultRepair: Record<string, unknown> | undefined;
      if (pendingResult) {
        phase = "original-pending-result-readback";
        const published = await readOriginalPublishedOperation(
          input.repository,
          state.input,
          active,
          api,
        );
        const expected = await derivePendingReleaseAssets(
          context,
          publication,
          toolsReceipt,
          active,
          deadline,
        );
        const producer = pendingResult.executor_identity!;
        const observeProvider = () =>
          inspectPendingResultProvider(
            get(`actions/runs/${String(producer.run_id)}`),
            get(`actions/runs/${String(producer.run_id)}/attempts/1`),
            get(`actions/jobs/${String(producer.job_id)}`),
            readCompleteRunArtifactInventory((page) =>
              get(`actions/runs/${String(producer.run_id)}/artifacts?per_page=100&page=${page}`),
            ),
            pendingResult,
          );
        const commit = get(`git/commits/${producer.controller_revision}`);
        assert.ok(
          isRecord(commit) &&
            commit.sha === producer.controller_revision &&
            isRecord(commit.tree) &&
            typeof commit.tree.sha === "string" &&
            /^[a-f0-9]{40}$/u.test(commit.tree.sha),
        );
        const controllerTree = commit.tree.sha;
        const providerBefore = observeProvider();
        const archive = readGitHubArtifactArchive(
          `${base}/actions/artifacts/${providerBefore.artifact.id}/zip`,
          {
            cwd: directory,
            maxBytes: providerBefore.artifact.bytes,
            timeoutMs: signingContextRemaining(deadline, 30000),
            spawn: (command, args, settings) =>
              spawnSync(command, args, { ...settings, env: environment }),
          },
        );
        signingContextRemaining(deadline, 15000);
        const observeRelease = async (record: Record<string, unknown>) => {
          assert.ok(isRecord(record.release) && Array.isArray(record.release.assets));
          const assets = record.release.assets.map((raw: unknown) => {
            assert.ok(
              isRecord(raw) &&
                typeof raw.filename === "string" &&
                typeof raw.bytes === "number" &&
                typeof raw.sha256 === "string",
            );
            return { filename: raw.filename, bytes: raw.bytes, sha256: raw.sha256 };
          });
          assert.equal(assets.length, expected.assets.length + 1);
          for (const wanted of expected.assets)
            assert.ok(
              assets.some((a) => digest(a) === digest(wanted)),
              "report public asset differs from original context",
            );
          const sbom = assets.find((a) => a.filename === "Portcove-SBOM.spdx.json");
          assert.ok(
            sbom &&
              sbom.sha256 === expected.sbom_sha256 &&
              Number.isSafeInteger(sbom.bytes) &&
              sbom.bytes > 0 &&
              sbom.bytes <= 16 * 1024 ** 2,
          );
          const identity = {
            version: expected.version,
            source_commit: expected.source_commit,
            assets,
          };
          const raw = readImmutableReleaseState(api, identity);
          const transition = proposeImmutableReleaseTransition(identity, raw.release, raw.assets);
          assert.equal(
            transition.decision,
            "complete",
            "original immutable Release is no longer complete",
          );
          if (transition.decision !== "complete") throw new Error("complete Release required");
          const sbomAsset = transition.assets.find((a) => a.filename === sbom.filename)!;
          const sbomBytes = readGitHubReleaseAsset(`${base}/releases/assets/${sbomAsset.id}`, {
            cwd: directory,
            maxBytes: sbom.bytes,
            timeoutMs: signingContextRemaining(deadline, 30000),
            spawn: (command, args, settings) =>
              spawnSync(command, args, { ...settings, env: environment }),
          });
          assert.equal(sbomBytes.length, sbom.bytes);
          assert.equal(hash(sbomBytes), sbom.sha256);
          return {
            ...transition,
            version: expected.version,
            source_commit: expected.source_commit,
          };
        };
        const observe = () =>
          readPendingResultArchive(
            archive,
            providerBefore,
            controllerTree,
            context,
            pendingResult,
            active,
            published,
            observeRelease,
            deadline,
          );
        await guard();
        const before = await observe();
        if (!settled(pendingResult)) {
          const recovered = await recoverOwnedCapacityEffect(
            executor,
            { ...input, checkpoint },
            async (pending) => {
              assert.equal(digest(pending), digest(pendingResult));
              await guard();
              const again = await observe();
              assert.equal(digest(again.projection), digest(before.projection));
              assert.equal(
                digest(observeProvider()),
                digest(providerBefore),
                "original result provider drifted",
              );
              await requireRetainedActualTufPublication(publication, deadline);
              await guard();
              return {
                resolution: "effect-completed",
                evidence_sha256: again.evidence_sha256,
                ...(pendingResult.completed_effects.length
                  ? {}
                  : {
                      completed_effect: {
                        remote_identity: again.remote_identity,
                        evidence_sha256: again.evidence_sha256,
                      },
                    }),
              };
            },
          );
          checkpoint = recovered.checkpoint;
        }
        await guard();
        if (
          providerBefore.bundle &&
          isRecord(providerBefore.original.job) &&
          providerBefore.original.job.conclusion === "success"
        ) {
          const resultLocator: PublicationResultArtifactExpected = {
            controller_revision: producer.controller_revision,
            controller_ref: producer.execution_ref,
            source_tree: controllerTree,
            run_id: String(producer.run_id),
            run_attempt: 1,
            artifact: { id: providerBefore.artifact.id, sha256: providerBefore.artifact.sha256 },
            bundle: { id: providerBefore.bundle.id, sha256: providerBefore.bundle.sha256 },
            report_sha256: before.report_sha256,
          };
          await receivePublicationResultArtifact(directory, resultLocator, context, deadline);
          publicationResultLocator = resultLocator;
          await guard();
        } else {
          resultRepair = {
            operation_id: pendingResult.id,
            artifact: providerBefore.artifact,
            report_sha256: before.report_sha256,
            original_executor: producer,
            scope: "upload custody only; original successful attestation absent",
            authority: "none",
          };
          if (Number(active.transient_retries) < 2) {
            await guard();
            const current = await recoverReleaseOpportunity(input.repository, checkpoint);
            assert.equal(digest(current.input.active_candidate), originalCandidate);
            assert.ok(
              isRecord(current.input.controller) &&
                isRecord(current.input.controller.capacity_attempt),
            );
            const currentOperation = inspectCapacityOperation(
              current.input.controller.capacity_attempt.operation,
            );
            assert.ok(
              !currentOperation || settled(currentOperation),
              "unrelated unresolved effect blocks report failure",
            );
            const reportOperation =
              currentOperation?.id === pendingResult.id ? currentOperation : pendingResult;
            assert.ok(
              reportOperation &&
                settled(reportOperation) &&
                reportOperation.id === pendingResult.id,
            );
            const failed = { ...active, phase: "failed", failure_kind: "transient" };
            const proof = inspectPublicationReportRepair(
              {
                schema_version: 1,
                candidate_sha256: candidateProgressIdentity(active),
                expected_transient_retry: Number(active.transient_retries) + 1,
                substantive_repairs: active.substantive_repairs,
                failure:
                  providerBefore.original.job.conclusion === "success"
                    ? "attestation-missing"
                    : "producer-failed",
                artifact_id: providerBefore.artifact.id,
                artifact_sha256: providerBefore.artifact.sha256,
                report_sha256: before.report_sha256,
                context_manifest_sha256: before.record.context.manifest_sha256,
                result_checkpoint: checkpoint,
                result_operation_id: reportOperation.id,
                result_operation_sha256: digest(reportOperation),
                result_operation: reportOperation,
                publish_operation_id: published.id,
                publish_operation_sha256: digest(published),
                release_id: before.record.release.release_id,
                immutable_identity_sha256: before.record.immutable_identity_sha256,
              },
              failed,
            );
            const failedCandidate = { ...failed, report_repair: proof };
            const next = structuredClone(current.input);
            next.active_candidate = failedCandidate;
            const saved = await checkpointReleaseOpportunity(input.repository, checkpoint, next);
            await guard();
            await refreshCapacityExecutor(executor);
            await publishCoordinatorCheckpoint(
              input.repository,
              saved.checkpoint,
              input.remote_configuration,
              { api: createCoordinatorJournalApi(directory, deadline) },
            );
            checkpoint = saved.checkpoint;
            originalCandidate = digest(failedCandidate);
            await guard();
            resultRepair = {
              ...resultRepair,
              failure_checkpoint: checkpoint,
              expected_transient_retry: proof.expected_transient_retry,
              scope:
                "same-journal technical failure; next actual coordinator must consume its bounded retry plan",
            };
          } else
            resultRepair = {
              ...resultRepair,
              scope: "existing transient repair limit exhausted; no new report attempt",
            };
        }
      }
      if (pendingRelease) {
        phase = "original-pending-Release-readback";
        const expected = await derivePendingReleaseAssets(
          context,
          publication,
          toolsReceipt,
          active,
          deadline,
        );
        const producer = pendingRelease.executor_identity!;
        const originalProducer = () =>
          inspectPendingReleaseProducer(
            get(`actions/runs/${String(producer.run_id)}`),
            get(`actions/runs/${String(producer.run_id)}/attempts/1`),
            get(`actions/jobs/${String(producer.job_id)}`),
            pendingRelease,
          );
        const observeRelease = () =>
          observePendingCandidateRelease(api, pendingRelease, expected, (id, maximum) =>
            readGitHubReleaseAsset(`${base}/releases/assets/${id}`, {
              cwd: directory,
              maxBytes: maximum,
              timeoutMs: signingContextRemaining(deadline, 30000),
              spawn: (command, args, settings) =>
                spawnSync(command, args, { ...settings, env: environment }),
            }),
          );
        await guard();
        const producerBefore = originalProducer();
        const before = await observeRelease();
        await guard();
        const recovered = await recoverOwnedCapacityEffect(
          executor,
          { ...input, checkpoint },
          async (pending) => {
            assert.equal(
              digest(pending),
              digest(pendingRelease),
              "original Release intent changed",
            );
            await guard();
            const again = await observeRelease();
            await requireRetainedActualTufPublication(publication, deadline);
            assert.equal(
              digest(again.projection),
              digest(before.projection),
              "original Release readback drifted",
            );
            assert.equal(
              digest(originalProducer()),
              digest(producerBefore),
              "original publisher changed around readback",
            );
            await guard();
            return {
              resolution: "effect-completed",
              evidence_sha256: again.evidence_sha256,
              ...(pendingRelease.completed_effects.length
                ? {}
                : {
                    completed_effect: {
                      remote_identity: again.remote_identity,
                      evidence_sha256: again.evidence_sha256,
                    },
                  }),
            };
          },
        );
        checkpoint = recovered.checkpoint;
        await guard();
      }
      await guard();
      await refreshCapacityExecutor(executor);
      signingContextRemaining(deadline, 15000);
      const result = Object.freeze({
        decision: resultRepair
          ? ("candidate-publication-result-repair-required" as const)
          : ("candidate-signing-custody-reused" as const),
        checkpoint,
        candidate_phase:
          resultRepair && "failure_checkpoint" in resultRepair
            ? ("failed" as const)
            : (active.phase as "qualifying" | "building" | "publishing" | "promoting"),
        context_locator: contextLocator,
        ...(active.report_repair === undefined
          ? {}
          : {
              report_only_repair: true,
              report_repair_sha256: digest(inspectConsumedPublicationReportRepair(active)),
            }),
        role_locators: roleLocators,
        ...(publicationResultLocator
          ? { publication_result_locator: publicationResultLocator }
          : {}),
        ...(resultRepair ? { publication_result_repair: resultRepair } : {}),
        authority: "none" as const,
        scope: "original-attested-custody-only" as const,
      });
      await writeFile(path.join(directory, "recovery.json"), JSON.stringify(result), {
        flag: "wx",
        mode: 0o600,
      });
      return result;
    } catch (error) {
      await writeFile(
        path.join(directory, "refusal.json"),
        JSON.stringify({ phase, checkpoint, authority: "none" }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => {});
      throw new Error(`candidate signing readback refused; retain ${directory}`, { cause: error });
    }
  });
}
